import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { text } from "node:stream/consumers";
import { Effect, Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";

const cliRoot = path.resolve(import.meta.dirname, "..");
const active: string[] = [];
const source = "SYNTHETIC_EXTERNAL_PROFILE=preserve-this\n";
const privateKey = "a".repeat(64);
const keySource = `DOTENV_PRIVATE_KEY=${privateKey}\n`;

const Result = Schema.Struct({
  error: Schema.optionalKey(Schema.String),
  ok: Schema.Boolean,
  value: Schema.optionalKey(
    Schema.Struct({
      privateKey: Schema.optionalKey(Schema.String),
      source: Schema.optionalKey(Schema.String),
    }),
  ),
});

const fixture = async () => {
  const parent = await realpath(await mkdtemp(path.join(tmpdir(), "affect-hosted-state-")));
  active.push(parent);
  const root = path.join(parent, "workspace");
  const external = path.join(parent, "external");
  await mkdir(root);
  await mkdir(external);
  await symlink(path.join(cliRoot, "node_modules"), path.join(parent, "node_modules"));

  return { external, parent, root };
};

const writeProfile = async (directory: string) => {
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, ".env"), source, { mode: 0o600 });
  await writeFile(path.join(directory, ".env.keys"), keySource, { mode: 0o600 });
};

const readProfile = async (f: Awaited<ReturnType<typeof fixture>>) => {
  const script = path.join(f.parent, "read-profile.ts");
  await writeFile(
    script,
    `import { BunServices } from "@effect/platform-bun";
import { Effect } from "effect";
import { readProfile } from ${JSON.stringify(path.join(cliRoot, "src/hosted-state.ts"))};
const program = readProfile(${JSON.stringify(f.root)}, "preview").pipe(Effect.provide(BunServices.layer));
try { const value = await Effect.runPromise(program); console.log(JSON.stringify({ ok:true, value })); }
catch(error) { console.log(JSON.stringify({ ok:false, error:String(error) })); }
`,
    { mode: 0o600 },
  );
  const child = spawn("bun", [script], { stdio: ["ignore", "pipe", "pipe"] });

  const [stdout, stderr, status] = await Promise.all([
    text(child.stdout),
    text(child.stderr),
    once(child, "exit"),
  ]);

  expect(status).toStrictEqual([0, null]);

  const result = await Effect.runPromise(
    Schema.decodeEffect(Schema.fromJsonString(Result))(stdout.trim()),
  );

  return { ...result, output: stdout + stderr };
};

const expectPrivateRejection = (result: Awaited<ReturnType<typeof readProfile>>) => {
  expect(result.ok).toBeFalsy();
  expect(result.value).toBeUndefined();
  expect(result.error).toMatch(/regular|safely/u);
  expect(result.output).not.toContain(privateKey);
  expect(result.output).not.toContain(source.trim());
};

describe("hosted profile local-path preflight", () => {
  afterEach(async () => {
    const cleanups: Promise<void>[] = [];

    for (const directory of active.splice(0)) {
      cleanups.push(rm(directory, { force: true, recursive: true }));
    }

    await Promise.all(cleanups);
  });

  it.each(["env", "preview"])(
    "rejects a symlinked %s parent before returning external profile or key data",
    async (parent) => {
      const f = await fixture();
      const externalProfile = parent === "env" ? path.join(f.external, "preview") : f.external;
      await writeProfile(externalProfile);

      if (parent === "env") {
        await symlink(f.external, path.join(f.root, "env"));
      } else {
        await mkdir(path.join(f.root, "env"));
        await symlink(f.external, path.join(f.root, "env", "preview"));
      }

      expectPrivateRejection(await readProfile(f));
      await expect(readFile(path.join(externalProfile, ".env"), "utf-8")).resolves.toBe(source);
      await expect(readFile(path.join(externalProfile, ".env.keys"), "utf-8")).resolves.toBe(
        keySource,
      );

      const parentInfo = await lstat(
        path.join(f.root, "env", ...(parent === "preview" ? ["preview"] : [])),
      );

      expect(parentInfo.isSymbolicLink()).toBeTruthy();
    },
  );

  it.each(["env", "preview"])("rejects a regular file used as the %s parent", async (parent) => {
    const f = await fixture();
    const file = parent === "env" ? path.join(f.root, "env") : path.join(f.root, "env", "preview");

    if (parent === "preview") {
      await mkdir(path.join(f.root, "env"));
    }

    await writeFile(file, source, { mode: 0o600 });
    expectPrivateRejection(await readProfile(f));
    await expect(readFile(file, "utf-8")).resolves.toBe(source);
  });

  it.each([".env", ".env.keys"])(
    "rejects a final %s symlink and preserves its target",
    async (file) => {
      const f = await fixture();
      const directory = path.join(f.root, "env", "preview");
      await mkdir(directory, { recursive: true });
      const target = path.join(f.external, file);
      const contents = file === ".env" ? source : keySource;
      await writeFile(target, contents, { mode: 0o600 });
      await symlink(target, path.join(directory, file));
      expectPrivateRejection(await readProfile(f));
      await expect(readFile(target, "utf-8")).resolves.toBe(contents);
    },
  );

  it.each(["env", "preview", "files"])(
    "accepts missing %s without creating profile state",
    async (missing) => {
      const f = await fixture();

      if (missing !== "env") {
        await mkdir(path.join(f.root, "env"));
      }

      if (missing === "files") {
        await mkdir(path.join(f.root, "env", "preview"));
      }

      const result = await readProfile(f);
      expect(result).toMatchObject({ ok: true, value: {} });
      expect(result.error).toBeUndefined();
      let absent = path.join(f.root, "env", "preview", ".env");

      if (missing === "env") {
        absent = path.join(f.root, "env");
      } else if (missing === "preview") {
        absent = path.join(f.root, "env", "preview");
      }

      await expect(lstat(absent)).rejects.toThrow("ENOENT");
    },
  );

  it("reads an ordinary local profile and owner-only key without changing either file", async () => {
    const f = await fixture();
    const directory = path.join(f.root, "env", "preview");
    await writeProfile(directory);
    await expect(readProfile(f)).resolves.toMatchObject({
      ok: true,
      value: { privateKey, source },
    });
    await expect(readFile(path.join(directory, ".env"), "utf-8")).resolves.toBe(source);
    await expect(readFile(path.join(directory, ".env.keys"), "utf-8")).resolves.toBe(keySource);
  });
});
