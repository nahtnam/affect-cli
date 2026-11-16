import { some, filter, map, join } from "effect/Array";
import { Effect, FileSystem, Option, Path, Schema } from "effect";
import { CliError } from "effect/cli";
import { PrivateKey, PublicKey } from "./profile-crypto";

export const ProfileNameSchema = Schema.Literals(["development", "preview", "production"]);

export type ProfileName = typeof ProfileNameSchema.Type;

const Id = Schema.Int.check(Schema.isGreaterThan(0));
const DeploymentName = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9_-]*$/u));

export const Origin = Schema.String.check(
  Schema.makeFilter((value) => {
    if (!URL.canParse(value)) {
      return false;
    }

    const url = new URL(value);

    return (
      /^https?:$/u.test(url.protocol) &&
      url.username === "" &&
      url.password === "" &&
      (value === url.origin || value === `${url.origin}/`)
    );
  }),
);

export const BindingSchema = Schema.Struct({
  developmentDeployment: Schema.optionalKey(DeploymentName),
  developmentOrigin: Origin,
  productionDeployment: Schema.optionalKey(DeploymentName),
  profiles: Schema.Array(ProfileNameSchema),
  projectId: Id,
  projectSlug: Schema.NonEmptyString,
  siteUrl: Origin,
  teamId: Id,
  teamSlug: Schema.NonEmptyString,
  vercel: Schema.optionalKey(
    Schema.Struct({
      accountId: Schema.NonEmptyString,
      projectId: Schema.NonEmptyString,
      teamId: Schema.optionalKey(Schema.NonEmptyString),
    }),
  ),
  version: Schema.Literal(1),
});

export type Binding = typeof BindingSchema.Type;

export const CustodySchema = Schema.Struct({
  deployKey: Schema.NonEmptyString,
  deploymentName: Schema.optionalKey(DeploymentName),
  privateKey: PrivateKey,
  profile: ProfileNameSchema,
  projectId: Id,
  publicKey: PublicKey,
  source: Schema.NonEmptyString,
  teamId: Id,
  version: Schema.Literal(1),
});

export type Custody = typeof CustodySchema.Type;

export const recordName = "AFFECT_ONBOARDING_V1";
const failure = (cause: string) => new CliError.UserError({ cause });

export const safeDirectory = Effect.fnUntraced(function* safeDirectory(directory: string) {
  const fs = yield* FileSystem.FileSystem;

  if (!(yield* fs.exists(directory))) {
    yield* fs.makeDirectory(directory, { mode: 0o700 });
  }

  const info = yield* fs.lstat(directory);

  if (info.type !== "Directory") {
    return yield* failure("Onboarding requires regular local directories.");
  }

  return yield* Effect.void;
});

export const readOptional = Effect.fnUntraced(
  function* readOptional(file: string, secret?: boolean) {
    const fs = yield* FileSystem.FileSystem;

    const info = yield* fs.lstat(file).pipe(
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound",
        () => Effect.succeed(null),
      ),
    );

    if (info === null) {
      return Option.getOrUndefined(Option.none<string>());
    }

    if (
      info.type !== "File" ||
      (Option.isSome(info.nlink) && info.nlink.value !== 1n) ||
      (secret === true && info.mode % 0o100 !== 0)
    ) {
      return yield* failure("Onboarding requires regular owner-only credential files.");
    }

    const handle = yield* fs.open(file, { flag: "r", noFollow: true });
    const opened = yield* handle.stat;

    if (
      opened.type !== "File" ||
      (Option.isSome(opened.nlink) && opened.nlink.value !== 1n) ||
      (secret === true &&
        (opened.mode % 0o100 !== 0 ||
          Option.isNone(opened.uid) ||
          opened.uid.value !== process.getuid?.())) ||
      opened.size > BigInt(Number.MAX_SAFE_INTEGER)
    ) {
      return yield* failure("Onboarding requires regular owner-only credential files.");
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
  },
  Effect.scoped,
  Effect.mapError((cause) =>
    cause._tag === "UserError" ? cause : failure("Cannot read onboarding configuration safely."),
  ),
);

export const decodeJson = <A>(schema: Schema.Codec<A, unknown>, source: string) =>
  Schema.decodeEffect(Schema.fromJsonString(schema), { onExcessProperty: "error" })(source).pipe(
    Effect.mapError(() =>
      failure("Stored onboarding configuration is invalid; explicit recovery required."),
    ),
  );

export const readBinding = Effect.fnUntraced(function* readBinding(root: string) {
  const path = yield* Path.Path;
  const source = yield* readOptional(path.join(root, "affect.json"));

  return source === undefined ? undefined : yield* decodeJson(BindingSchema, source);
});

export const stateDirectory = Effect.fnUntraced(function* stateDirectory(root: string) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const state = path.join(root, ".setup.local");
  yield* safeDirectory(state);
  const info = yield* fs.lstat(state);

  if (info.mode % 0o100 !== 0) {
    return yield* failure("Onboarding state requires owner-only directory permissions.");
  }

  const directory = path.join(state, "onboarding");
  yield* safeDirectory(directory);

  return directory;
});

export const writePreserving = Effect.fnUntraced(
  function* writePreserving(file: string, source: string, secret?: boolean) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const existing = yield* readOptional(file, secret);

    if (existing !== undefined) {
      if (existing !== source) {
        return yield* failure(
          "Existing profile or credential differs; explicit recovery required.",
        );
      }

      return yield* Effect.void;
    }

    const staging = yield* fs.makeTempDirectoryScoped({
      directory: path.dirname(file),
      prefix: ".affect-write-",
    });

    const stagedFile = path.join(staging, "value");
    const handle = yield* fs.open(stagedFile, { flag: "wx", mode: 0o600, noFollow: true });
    yield* handle.writeAll(new TextEncoder().encode(source));
    yield* handle.sync;
    yield* fs.link(stagedFile, file).pipe(
      Effect.catchIf(
        (error) => error.reason._tag === "AlreadyExists",
        () =>
          readOptional(file, secret).pipe(
            Effect.flatMap((current) =>
              current === source
                ? Effect.void
                : failure("Existing profile or credential differs; explicit recovery required."),
            ),
          ),
      ),
    );

    return yield* Effect.void;
  },
  Effect.scoped,
  Effect.mapError((cause) =>
    cause._tag === "UserError"
      ? cause
      : failure("Cannot safely publish onboarding files; recovery state was preserved."),
  ),
);

const bindingDiffers = (existing: Binding, binding: Binding) =>
  existing.teamSlug !== binding.teamSlug ||
  existing.projectSlug !== binding.projectSlug ||
  (existing.vercel !== undefined &&
    (binding.vercel === undefined ||
      existing.vercel.accountId !== binding.vercel.accountId ||
      existing.vercel.projectId !== binding.vercel.projectId ||
      existing.vercel.teamId !== binding.vercel.teamId)) ||
  existing.teamId !== binding.teamId ||
  existing.projectId !== binding.projectId ||
  existing.siteUrl !== binding.siteUrl ||
  existing.developmentOrigin !== binding.developmentOrigin ||
  (existing.developmentDeployment !== undefined &&
    existing.developmentDeployment !== binding.developmentDeployment) ||
  (existing.productionDeployment !== undefined &&
    existing.productionDeployment !== binding.productionDeployment) ||
  some(existing.profiles, (profile) => !binding.profiles.includes(profile));

export const publishBinding = Effect.fnUntraced(function* publishBinding(
  root: string,
  binding: Binding,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const source = yield* Schema.encodeEffect(Schema.fromJsonString(BindingSchema))(binding);
  const file = path.join(root, "affect.json");
  const previous = yield* readOptional(file);
  const existing = previous === undefined ? undefined : yield* decodeJson(BindingSchema, previous);

  if (existing !== undefined) {
    const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(BindingSchema))(existing);

    if (encoded !== source) {
      if (bindingDiffers(existing, binding)) {
        return yield* failure("Existing project binding differs; explicit recovery required.");
      }

      const staging = yield* fs.makeTempDirectoryScoped({
        directory: root,
        prefix: ".affect-binding-",
      });

      const stagedFile = path.join(staging, "affect.json");
      yield* fs.writeFileString(stagedFile, `${source}\n`, { mode: 0o600 });

      if ((yield* readOptional(file)) !== previous) {
        return yield* failure("Project binding changed during setup; preserved current file.");
      }

      yield* fs.rename(stagedFile, file);
    }

    return yield* Effect.void;
  }

  yield* writePreserving(path.join(root, "affect.json"), `${source}\n`);

  return yield* Effect.void;
}, Effect.scoped);

const regularProfileDirectory = Effect.fnUntraced(function* regularProfileDirectory(
  directory: string,
) {
  const fs = yield* FileSystem.FileSystem;

  const info = yield* fs.lstat(directory).pipe(
    Effect.catchIf(
      (cause) => cause.reason._tag === "NotFound",
      () => Effect.succeed(null),
    ),
  );

  if (info !== null && info.type !== "Directory") {
    return yield* failure("Existing profile directories must be regular non-symlink directories.");
  }

  return yield* Effect.void;
});

export const readProfile = Effect.fnUntraced(function* readProfile(
  root: string,
  profile: ProfileName,
) {
  const path = yield* Path.Path;
  const directory = path.join(root, "env", profile);
  yield* regularProfileDirectory(path.join(root, "env"));
  yield* regularProfileDirectory(directory);
  const source = yield* readOptional(path.join(directory, ".env"));
  const keySource = yield* readOptional(path.join(directory, ".env.keys"), true);

  if (keySource === undefined) {
    return { privateKey: undefined, source };
  }

  const match = /^DOTENV_PRIVATE_KEY=(?<key>[a-fA-F0-9]{64})\n?$/u.exec(keySource);
  const privateKey = match?.groups?.["key"];

  if (privateKey === undefined) {
    return yield* failure("Stored local profile key is invalid; explicit recovery required.");
  }

  return { privateKey, source };
});

export const publishProfile = Effect.fnUntraced(function* publishProfile(
  root: string,
  record: Custody,
  expectedSource?: string,
) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const envRoot = path.join(root, "env");
  yield* safeDirectory(envRoot);
  const directory = path.join(envRoot, record.profile);
  yield* safeDirectory(directory);
  const keyFile = path.join(directory, ".env.keys");
  const expectedKeySource = `DOTENV_PRIVATE_KEY=${record.privateKey}\n`;
  const keySource = yield* readOptional(keyFile, true);

  if (keySource !== undefined && keySource !== expectedKeySource) {
    return yield* failure("Existing profile key differs; preserved all configuration.");
  }

  const file = path.join(directory, ".env");
  const existing = yield* readOptional(file);

  if (existing !== undefined && existing !== record.source) {
    if (existing !== expectedSource) {
      return yield* failure(
        "Profile changed during setup; preserved current file and recovery record.",
      );
    }

    const state = yield* stateDirectory(root);
    const backup = path.join(state, `${record.profile}.original`);

    if (yield* fs.exists(backup)) {
      return yield* failure(
        "A profile recovery backup already exists; explicit recovery required.",
      );
    }

    yield* fs.rename(file, backup);
    const moved = yield* readOptional(backup);

    if (moved !== expectedSource) {
      return yield* failure("Profile changed during setup; preserved encrypted recovery backup.");
    }

    yield* writePreserving(file, record.source);
    yield* fs.remove(backup);
  } else {
    yield* writePreserving(file, record.source);
  }

  yield* writePreserving(
    path.join(directory, ".env.keys"),
    `DOTENV_PRIVATE_KEY=${record.privateKey}\n`,
    true,
  );

  return yield* Effect.void;
});

export const ensureProfileDelivery = Effect.fnUntraced(function* ensureProfileDelivery(
  root: string,
  profiles: readonly ProfileName[],
) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const ignore = path.join(root, ".gitignore");
  const source = (yield* readOptional(ignore)) ?? "";

  const additions = filter(
    profiles,
    (profile) => !source.split(/\r?\n/u).includes(`!env/${profile}/.env`),
  );

  if (additions.length > 0) {
    yield* fs.writeFileString(
      ignore,
      `${source.endsWith("\n") || source === "" ? "" : "\n"}${join(
        map(additions, (profile) => `!env/${profile}/.env`),
        "\n",
      )}\n`,
      { flag: "a" },
    );
  }

  // Keys remain ignored even in projects that previously tracked only production ciphertext.
  if (!source.split(/\r?\n/u).includes("**/.env.keys")) {
    yield* fs.writeFileString(ignore, "**/.env.keys\n", { flag: "a" });
  }
});

export const PendingProjectSchema = Schema.Struct({
  createProject: Schema.NonEmptyString,
  projectId: Schema.optionalKey(Id),
  projectSlug: Schema.optionalKey(DeploymentName),
  teamId: Id,
  version: Schema.Literal(1),
}).check(
  Schema.makeFilter(
    (record) => (record.projectId === undefined) === (record.projectSlug === undefined),
  ),
);

export type PendingProject = typeof PendingProjectSchema.Type;

interface PendingProjectFile {
  file: string;
  record: PendingProject;
  source: string;
}

export const readPendingProject = Effect.fnUntraced(function* readPendingProject(root: string) {
  const path = yield* Path.Path;
  const directory = yield* stateDirectory(root);
  const file = path.join(directory, "project.json");
  const source = yield* readOptional(file, true);

  if (source === undefined) {
    return Option.getOrUndefined(Option.none<PendingProjectFile>());
  }

  const record = yield* decodeJson(PendingProjectSchema, source);

  return { file, record, source } satisfies PendingProjectFile;
});

export const writePendingProject = Effect.fnUntraced(function* writePendingProject(
  root: string,
  record: PendingProject,
  expectedSource?: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* stateDirectory(root);
  const file = path.join(directory, "project.json");
  const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(PendingProjectSchema))(record);
  const source = `${encoded}\n`;

  if (expectedSource === undefined) {
    yield* writePreserving(file, source, true);

    return source;
  }

  const previous = yield* readOptional(file, true);

  if (previous !== expectedSource) {
    return yield* failure("Pending project creation changed; explicit recovery required.");
  }

  const staging = yield* fs.makeTempDirectoryScoped({ directory, prefix: ".affect-project-" });
  const stagedFile = path.join(staging, "project.json");
  yield* fs.writeFileString(stagedFile, source, { flag: "wx", mode: 0o600 });

  if ((yield* readOptional(file, true)) !== expectedSource) {
    return yield* failure("Pending project creation changed; explicit recovery required.");
  }

  yield* fs.rename(stagedFile, file);

  return source;
}, Effect.scoped);

export const clearPendingProject = Effect.fnUntraced(function* clearPendingProject(
  root: string,
  expectedSource?: string,
) {
  if (expectedSource === undefined) {
    return yield* Effect.void;
  }

  const pending = yield* readPendingProject(root);

  if (pending === undefined) {
    return yield* Effect.void;
  }

  if (pending.source !== expectedSource) {
    return yield* failure("Pending project creation changed; preserved recovery state.");
  }

  const fs = yield* FileSystem.FileSystem;
  yield* fs.remove(pending.file);

  return yield* Effect.void;
});
