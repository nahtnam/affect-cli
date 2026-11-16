import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { BunServices } from "@effect/platform-bun";
import { ConfigProvider, Effect, Layer } from "effect";
import type { FileSystem, Path } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { loadBootstrapCredential, saveBootstrapCredential } from "../src/hosted-auth";

const roots: string[] = [];
const team = { kind: "team", teamId: 11, token: "synthetic-team-token" } as const;
const pat = { kind: "pat", token: "synthetic-native-pat" } as const;
const safeFailure = "Cannot access the Convex bootstrap credential safely.";

const run = async <A, E>(
  program: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
  config: Record<string, string>,
) =>
  await Effect.runPromise(
    program.pipe(
      Effect.provide(
        Layer.mergeAll(
          BunServices.layer,
          ConfigProvider.layer(ConfigProvider.fromUnknown(config, { preserveEmptyStrings: true })),
        ),
      ),
    ),
  );

const fixture = async (xdg = false) => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "affect-auth-")));
  roots.push(root);
  const home = path.join(root, "home");
  const state = xdg ? path.join(root, "xdg-state") : path.join(home, ".local", "state");
  const cacheDirectory = path.join(state, "affect");
  await mkdir(home, { mode: 0o700 });

  return {
    cacheDirectory,
    cacheFile: path.join(cacheDirectory, "bootstrap.json"),
    config: xdg ? { HOME: home, XDG_STATE_HOME: state } : { HOME: home },
    home,
    nativeDirectory: path.join(home, ".convex"),
    nativeFile: path.join(home, ".convex", "config.json"),
    root,
    state,
  };
};

const writeNative = async (f: Awaited<ReturnType<typeof fixture>>) => {
  await mkdir(f.nativeDirectory, { mode: 0o755 });
  await writeFile(
    f.nativeFile,
    JSON.stringify({ accessToken: pat.token, unrelatedNativeField: true }),
    { mode: 0o644 },
  );
};

describe("hosted bootstrap credentials", () => {
  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map(async (root) => {
        await rm(root, { force: true, recursive: true });
      }),
    );
  });

  it("prefers the explicit team token and then the explicit PAT without filesystem fallback", async () => {
    await expect(
      run(loadBootstrapCredential(), {
        AFFECT_CONVEX_TOKEN: team.token,
        CONVEX_ACCESS_TOKEN: pat.token,
      }),
    ).resolves.toStrictEqual({ kind: "team", token: team.token });
    await expect(
      run(loadBootstrapCredential(), { CONVEX_ACCESS_TOKEN: pat.token }),
    ).resolves.toStrictEqual(pat);
  });

  it.each(["", " synthetic", "synthetic token", "synthetic\n"])(
    "rejects malformed explicit credentials without fallback",
    async (token) => {
      await expect(
        run(loadBootstrapCredential(), {
          AFFECT_CONVEX_TOKEN: token,
          CONVEX_ACCESS_TOKEN: pat.token,
        }),
      ).rejects.toThrow("Convex bootstrap token must be nonempty and contain no whitespace.");
    },
  );

  it.each([false, true])(
    "saves and reloads an owner-only credential with XDG mode %s",
    async (xdg) => {
      const f = await fixture(xdg);
      await run(saveBootstrapCredential(team), f.config);
      const file = await stat(f.cacheFile);
      const directory = await stat(f.cacheDirectory);

      await expect(run(loadBootstrapCredential(), f.config)).resolves.toStrictEqual(team);
      expect({
        directoryMode: directory.mode % 0o1000,
        fileMode: file.mode % 0o1000,
        owner: file.uid,
      }).toStrictEqual({ directoryMode: 0o700, fileMode: 0o600, owner: process.getuid?.() });
      await expect(readdir(f.cacheDirectory)).resolves.toStrictEqual(["bootstrap.json"]);
    },
  );

  it("leaves an identical saved credential unchanged and prefers it over native auth", async () => {
    const f = await fixture();
    await run(saveBootstrapCredential(team), f.config);
    await writeNative(f);
    const before = await stat(f.cacheFile);
    const source = await readFile(f.cacheFile, "utf-8");
    await run(saveBootstrapCredential(team), f.config);
    const after = await stat(f.cacheFile);

    expect({ inode: after.ino, modified: after.mtimeMs }).toStrictEqual({
      inode: before.ino,
      modified: before.mtimeMs,
    });
    await expect(readFile(f.cacheFile, "utf-8")).resolves.toBe(source);
    await expect(run(loadBootstrapCredential(), f.config)).resolves.toStrictEqual(team);
  });

  it.each([
    { ...team, token: "synthetic-other-token" },
    { ...team, teamId: 22 },
    { kind: "pat", token: team.token },
  ] as const)(
    "preserves a different existing credential instead of overwriting it",
    async (replacement) => {
      const f = await fixture();
      await run(saveBootstrapCredential(team), f.config);
      const before = await readFile(f.cacheFile, "utf-8");

      await expect(run(saveBootstrapCredential(replacement), f.config)).rejects.toThrow(
        "Saved bootstrap credential differs; explicit recovery required.",
      );
      await expect(readFile(f.cacheFile, "utf-8")).resolves.toBe(before);
    },
  );

  it("loads native PAT metadata with its native permissions and never copies it automatically", async () => {
    const f = await fixture();
    await writeNative(f);
    const before = await readFile(f.nativeFile, "utf-8");

    await expect(run(loadBootstrapCredential(), f.config)).resolves.toStrictEqual(pat);
    await expect(readFile(f.nativeFile, "utf-8")).resolves.toBe(before);
    await expect(stat(f.cacheFile)).rejects.toThrow("ENOENT");
  });

  it("fails closed on an insecure saved file despite available native auth", async () => {
    const f = await fixture();
    await run(saveBootstrapCredential(team), f.config);
    await writeNative(f);
    await chmod(f.cacheFile, 0o644);

    await expect(run(loadBootstrapCredential(), f.config)).rejects.toThrow(safeFailure);
  });

  it("rejects an insecure Affect state directory instead of changing its permissions", async () => {
    const f = await fixture();
    await mkdir(f.cacheDirectory, { mode: 0o755, recursive: true });
    await chmod(f.cacheDirectory, 0o755);

    await expect(run(saveBootstrapCredential(team), f.config)).rejects.toThrow(safeFailure);
    await expect(stat(f.cacheFile)).rejects.toThrow("ENOENT");
    const directory = await stat(f.cacheDirectory);
    expect(directory.mode % 0o1000).toBe(0o755);
  });

  it.each(["cache-parent", "cache-directory", "cache-file", "native-directory", "native-file"])(
    "rejects an unsafe %s symlink",
    async (kind) => {
      const f = await fixture(true);
      const outside = path.join(f.root, "outside");
      await mkdir(outside, { mode: 0o700 });
      const sentinel = path.join(outside, "sentinel.json");
      const source = JSON.stringify({ ...team, accessToken: pat.token });
      await writeFile(sentinel, source, { mode: 0o600 });

      if (kind === "cache-parent") {
        await symlink(outside, f.state);
      } else if (kind === "cache-directory") {
        await mkdir(f.state, { mode: 0o700 });
        await symlink(outside, f.cacheDirectory);
      } else if (kind === "cache-file") {
        await mkdir(f.cacheDirectory, { mode: 0o700, recursive: true });
        await symlink(sentinel, f.cacheFile);
      } else if (kind === "native-directory") {
        await symlink(outside, f.nativeDirectory);
      } else {
        await mkdir(f.nativeDirectory, { mode: 0o755 });
        await symlink(sentinel, f.nativeFile);
      }

      const action = kind.startsWith("native")
        ? loadBootstrapCredential()
        : saveBootstrapCredential(team);

      await expect(run(action, f.config)).rejects.toThrow(safeFailure);
      await expect(readFile(sentinel, "utf-8")).resolves.toBe(source);
    },
  );

  it("fails safely on malformed saved content and on absent credentials", async () => {
    const f = await fixture();
    await expect(run(loadBootstrapCredential(), f.config)).rejects.toThrow(
      "No Convex bootstrap credential is configured.",
    );

    await mkdir(f.cacheDirectory, { mode: 0o700, recursive: true });
    await writeFile(f.cacheFile, "synthetic-private-malformed-content", { mode: 0o600 });

    await expect(run(loadBootstrapCredential(), f.config)).rejects.toThrow(safeFailure);
  });

  it("publishes only one complete credential when competing saves race", async () => {
    const f = await fixture();
    const other = { ...team, token: "synthetic-racing-token" };

    const results = await Promise.allSettled([
      run(saveBootstrapCredential(team), f.config),
      run(saveBootstrapCredential(other), f.config),
    ]);

    const loaded = await run(loadBootstrapCredential(), f.config);

    expect(results.map(({ status }) => status).toSorted()).toStrictEqual(["fulfilled", "rejected"]);
    expect([team.token, other.token]).toContain(loaded.token);
    await expect(readdir(f.cacheDirectory)).resolves.toStrictEqual(["bootstrap.json"]);
  });
});
