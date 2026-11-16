import { Array, Config, Effect, FileSystem, Option, Path, Schema } from "effect";
import { CliError } from "effect/cli";

export interface BootstrapCredential {
  kind: "team" | "pat";
  token: string;
  teamId?: number;
}

const Token = Schema.NonEmptyString.check(Schema.isPattern(/^\S+$/u));

const Credential = Schema.Struct({
  kind: Schema.Literals(["team", "pat"]),
  teamId: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
  token: Token,
});

const NativeCredential = Schema.Struct({ accessToken: Token });
const failure = (cause: string) => new CliError.UserError({ cause });
const accessFailure = () => failure("Cannot access the Convex bootstrap credential safely.");
const conflict = () => failure("Saved bootstrap credential differs; explicit recovery required.");

const ownerOnly = (info: FileSystem.File.Info) =>
  info.mode % 0o100 === 0 && Option.isSome(info.uid) && info.uid.value === process.getuid?.();

const inspect = Effect.fnUntraced(function* inspect(file: string) {
  const fs = yield* FileSystem.FileSystem;

  return yield* fs.lstat(file).pipe(
    Effect.catchIf(
      (error) => error.reason._tag === "NotFound",
      () => Effect.succeed(null),
    ),
  );
});

const directory = Effect.fnUntraced(function* directory(
  target: string,
  create: boolean,
  privateLeaf: boolean,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  let current = target;
  let parents: string[] = [];

  while (true) {
    parents = Array.prepend(parents, current);
    const parent = path.dirname(current);

    if (parent === current) {
      break;
    }

    current = parent;
  }

  for (const parent of parents) {
    let info = yield* inspect(parent);

    if (info === null) {
      if (!create) {
        return false;
      }

      yield* fs.makeDirectory(parent, { mode: 0o700 }).pipe(
        Effect.catchIf(
          (cause) => cause.reason._tag === "AlreadyExists",
          () => Effect.void,
        ),
      );
      info = yield* fs.lstat(parent);
    }

    if (info.type !== "Directory" || (privateLeaf && parent === target && !ownerOnly(info))) {
      return yield* accessFailure();
    }
  }

  return true;
});

const paths = Effect.fnUntraced(function* paths() {
  const path = yield* Path.Path;
  const home = yield* Config.String("HOME").pipe(Config.withDefault(""));
  const state = yield* Config.String("XDG_STATE_HOME").pipe(Config.withDefault(""));
  const Absolute = Schema.NonEmptyString.check(Schema.makeFilter(path.isAbsolute));

  if (home !== "") {
    yield* Schema.decodeEffect(Absolute)(home).pipe(Effect.mapError(accessFailure));
  }

  const base = yield* Schema.decodeEffect(Absolute)(
    state || (home === "" ? "" : path.join(home, ".local", "state")),
  ).pipe(Effect.mapError(accessFailure));

  const cacheDirectory = path.join(base, "affect");

  return {
    cacheDirectory,
    cacheFile: path.join(cacheDirectory, "bootstrap.json"),
    nativeDirectory: home === "" ? null : path.join(home, ".convex"),
  };
});

const readFile = Effect.fnUntraced(function* readFile(file: string, privateFile: boolean) {
  const fs = yield* FileSystem.FileSystem;
  const info = yield* inspect(file);

  if (info === null) {
    return null;
  }

  if (info.type !== "File" || (privateFile && !ownerOnly(info))) {
    return yield* accessFailure();
  }

  const handle = yield* fs.open(file, { flag: "r", noFollow: true });
  const opened = yield* handle.stat;

  if (opened.type !== "File" || (privateFile && !ownerOnly(opened)) || opened.size > 65_536n) {
    return yield* accessFailure();
  }

  const buffer = new Uint8Array(Number(opened.size));
  let offset = 0;

  while (offset < buffer.length) {
    const count = yield* handle.read(buffer.subarray(offset));

    if (count === 0) {
      break;
    }

    offset += count;
  }

  return new TextDecoder().decode(buffer.subarray(0, offset));
}, Effect.scoped);

const readSaved = Effect.fnUntraced(function* readSaved(cacheDirectory: string, cacheFile: string) {
  if (!(yield* directory(cacheDirectory, false, true))) {
    return null;
  }

  const source = yield* readFile(cacheFile, true);

  if (source === null) {
    return null;
  }

  return yield* Schema.decodeEffect(Schema.fromJsonString(Credential), {
    onExcessProperty: "error",
  })(source).pipe(Effect.mapError(accessFailure));
});

export const loadBootstrapCredential = Effect.fnUntraced(
  function* loadBootstrapCredential() {
    for (const [name, kind] of [
      ["AFFECT_CONVEX_TOKEN", "team"],
      ["CONVEX_ACCESS_TOKEN", "pat"],
    ] as const) {
      const token = yield* Config.option(Config.String(name));

      if (Option.isSome(token)) {
        return yield* Schema.decodeEffect(Credential)({ kind, token: token.value }).pipe(
          Effect.mapError(() =>
            failure("Convex bootstrap token must be nonempty and contain no whitespace."),
          ),
        );
      }
    }

    const selected = yield* paths();
    const saved = yield* readSaved(selected.cacheDirectory, selected.cacheFile);

    if (saved !== null) {
      return saved;
    }

    if (
      selected.nativeDirectory === null ||
      !(yield* directory(selected.nativeDirectory, false, false))
    ) {
      return yield* failure("No Convex bootstrap credential is configured.");
    }

    const path = yield* Path.Path;
    const source = yield* readFile(path.join(selected.nativeDirectory, "config.json"), false);

    if (source === null) {
      return yield* failure("No Convex bootstrap credential is configured.");
    }

    const native = yield* Schema.decodeEffect(Schema.fromJsonString(NativeCredential))(source).pipe(
      Effect.mapError(accessFailure),
    );

    return { kind: "pat", token: native.accessToken } satisfies BootstrapCredential;
  },
  Effect.mapError((cause) => (cause._tag === "UserError" ? cause : accessFailure())),
);

const matches = (left: BootstrapCredential, right: BootstrapCredential) =>
  left.kind === right.kind && left.token === right.token && left.teamId === right.teamId;

export const saveBootstrapCredential = Effect.fnUntraced(
  function* saveBootstrapCredential(credential: BootstrapCredential) {
    const decoded = yield* Schema.decodeEffect(Credential, { onExcessProperty: "error" })(
      credential,
    ).pipe(Effect.mapError(accessFailure));

    const selected = yield* paths();
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* directory(selected.cacheDirectory, true, true);
    const existing = yield* readSaved(selected.cacheDirectory, selected.cacheFile);

    if (existing !== null) {
      if (!matches(existing, decoded)) {
        return yield* conflict();
      }

      return yield* Effect.void;
    }

    const staging = yield* fs.makeTempDirectoryScoped({
      directory: selected.cacheDirectory,
      prefix: ".bootstrap-",
    });

    const stagedFile = path.join(staging, "credential.json");
    const handle = yield* fs.open(stagedFile, { flag: "wx", mode: 0o600, noFollow: true });

    const source = yield* Schema.encodeEffect(Schema.fromJsonString(Credential))(decoded).pipe(
      Effect.mapError(accessFailure),
    );

    yield* handle.writeAll(new TextEncoder().encode(`${source}\n`));
    yield* handle.sync;
    yield* fs.link(stagedFile, selected.cacheFile).pipe(
      Effect.catchIf(
        (error) => error.reason._tag === "AlreadyExists",
        () =>
          readSaved(selected.cacheDirectory, selected.cacheFile).pipe(
            Effect.flatMap((current) =>
              current !== null && matches(current, decoded) ? Effect.void : conflict(),
            ),
          ),
      ),
    );

    return yield* Effect.void;
  },
  Effect.scoped,
  Effect.mapError((cause) => (cause._tag === "UserError" ? cause : accessFailure())),
);
