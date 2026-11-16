import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "@dotenvx/dotenvx";
import { Effect, Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { previewOrigin } from "../src/preview-profile";
import {
  fixtureEnv,
  makeFixture,
  readConvexLog,
  readFixtureFile,
  runCli,
} from "./cli-test-helpers";
import type { Fixture } from "./cli-test-helpers";

const active: Fixture[] = [];
const deployKey = "preview:synthetic-team:synthetic-project|synthetic-project-key";
const serverSecret = "synthetic-preview-server-secret";
const actualOrigin = "https://actual-preview.example.com";

const fixture = async (options?: Parameters<typeof makeFixture>[0]) => {
  const value = await makeFixture({
    convexMode: "run-build",
    environment: "preview",
    rootBuild: "bun run capture-profile.cjs && bun run --filter @affect/web build",
    values: {
      CONVEX_DEPLOY_KEY: deployKey,
      PROFILE_ONLY_SECRET: "synthetic-not-runtime",
      SERVER_SECRET: serverSecret,
      SITE_URL: "https://stale-production.example.com",
      TRUSTED_ORIGINS: "https://stale-production.example.com",
      VITE_CONVEX_SITE_URL: "https://stale.convex.site",
      VITE_CONVEX_URL: "https://stale.convex.cloud",
      VITE_SITE_URL: "https://stale-production.example.com",
      VITE_UNREVIEWED: "synthetic-not-reviewed",
    },
    ...options,
  });

  active.push(value);

  if (value.privateKey === undefined) {
    throw new Error("Synthetic preview profile is missing its generated encryption key.");
  }

  await writeFile(
    path.join(value.root, "capture-profile.cjs"),
    'require("node:fs").copyFileSync("env/preview/.env", "runtime-profile.env");',
  );

  return { ...value, privateKey: value.privateKey };
};

const deployEnv = (f: Fixture) => ({
  ...fixtureEnv(f),
  VERCEL_ENV: "preview",
  VERCEL_GIT_COMMIT_REF: "feature/fixture",
  VERCEL_URL: "actual-preview.example.com",
});

const Changes = Schema.Struct({
  changes: Schema.Array(Schema.Struct({ name: Schema.String, value: Schema.String })),
});

describe("preview runtime materialization", () => {
  afterEach(async () => {
    await Promise.all(
      active.splice(0).map(async (f) => {
        await f.cleanup();
      }),
    );
  });

  it.each([0, 27])(
    "packages verified preview URLs with consistent origins and restores the profile after build status %s",
    async (buildExitStatus) => {
      const f = await fixture({ buildExitStatus });
      const original = await readFile(f.envFile, "utf-8");
      const result = runCli(f, ["deploy"], deployEnv(f));

      const source = await readFixtureFile(f, "runtime-profile.env");
      const restored = await readFile(f.envFile, "utf-8");

      expect({
        restored,
        statusMatches: (result.status === 0) === (buildExitStatus === 0),
      }).toStrictEqual({
        restored: original,
        statusMatches: true,
      });

      const runtime = parse(source, {
        overload: true,
        privateKey: f.privateKey,
        processEnv: {},
      });

      expect(runtime).toMatchObject({
        SERVER_SECRET: serverSecret,
        SITE_URL: actualOrigin,
        TRUSTED_ORIGINS: actualOrigin,
        VITE_CONVEX_SITE_URL: "https://callback.convex.site",
        VITE_CONVEX_URL: "https://callback.convex.cloud",
        VITE_SITE_URL: actualOrigin,
      });
      expect({
        deployKey: runtime["CONVEX_DEPLOY_KEY"],
        privateKey: runtime["DOTENV_PRIVATE_KEY"],
        profileOnly: runtime["PROFILE_ONLY_SECRET"],
        unreviewed: runtime["VITE_UNREVIEWED"],
      }).toStrictEqual({
        deployKey: undefined,
        privateKey: undefined,
        profileOnly: undefined,
        unreviewed: undefined,
      });

      const { changes } = Effect.runSync(
        Schema.decodeEffect(Schema.fromJsonString(Changes))(
          await readFixtureFile(f, "convex-http.body"),
        ),
      );

      const build = await readFixtureFile(f, "build.marker").catch(() => "");
      const output = source + result.stdout + result.stderr + build;

      expect({
        buildHasActualOrigin: build.includes(actualOrigin),
        origins: changes.filter(({ name }) => name === "SITE_URL" || name === "TRUSTED_ORIGINS"),
        secretFree: ![serverSecret, deployKey, f.privateKey].some((secret) =>
          output.includes(secret),
        ),
      }).toStrictEqual({
        buildHasActualOrigin: buildExitStatus === 0,
        origins: [
          { name: "SITE_URL", value: actualOrigin },
          { name: "TRUSTED_ORIGINS", value: actualOrigin },
        ],
        secretFree: true,
      });
      await expect(readFixtureFile(f, "env/preview/.affect-deploy/original.env")).rejects.toThrow(
        "ENOENT",
      );
    },
    15_000,
  );

  it("uses an explicit origin before host metadata, including required-setting preflight", async () => {
    const f = await fixture({
      values: { CONVEX_DEPLOY_KEY: deployKey, SERVER_SECRET: serverSecret },
    });

    await writeFile(
      path.join(f.root, "convex", "env.config.ts"),
      'const required = { isConvexValidator: true, isOptional: "required" }; export default { SERVER_SECRET: required, SITE_URL: required, TRUSTED_ORIGINS: required };',
    );

    const result = runCli(f, ["deploy"], {
      ...deployEnv(f),
      AFFECT_PREVIEW_ORIGIN: "http://localhost:4321/",
    });

    expect(result.status).toBe(0);
    const source = await readFixtureFile(f, "runtime-profile.env");
    const runtime = parse(source, { overload: true, privateKey: f.privateKey, processEnv: {} });

    expect(runtime["SITE_URL"]).toBe("http://localhost:4321");
    expect(runtime["TRUSTED_ORIGINS"]).toBe("http://localhost:4321");
    expect(runtime["VITE_SITE_URL"]).toBe("http://localhost:4321");
  }, 15_000);

  it("rejects absent host metadata before invoking native Convex despite stale profile origins", async () => {
    const f = await fixture();
    const result = runCli(f, ["deploy"], { ...deployEnv(f), VERCEL_URL: "" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("requires AFFECT_PREVIEW_ORIGIN or VERCEL_URL");
    await expect(readConvexLog(f)).resolves.toBe("");
  }, 15_000);

  it("does not materialize or synchronize when canonical preview verification fails", async () => {
    const f = await fixture({
      provider: {
        responses: {
          "/api/v1/get_canonical_urls": {
            convexCloudUrl: "https://other.convex.cloud",
            convexSiteUrl: "https://other.convex.site",
          },
        },
      },
    });

    const original = await readFile(f.envFile, "utf-8");
    const result = runCli(f, ["deploy"], deployEnv(f));

    expect(result.status).not.toBe(0);
    await expect(readFile(f.envFile, "utf-8")).resolves.toBe(original);
    await expect(readFixtureFile(f, "runtime-profile.env")).rejects.toThrow("ENOENT");
    await expect(readFixtureFile(f, "convex-http.body")).rejects.toThrow("ENOENT");
  }, 15_000);

  it("fails closed on an existing profile lock before synchronization or build", async () => {
    const f = await fixture();
    const original = await readFile(f.envFile, "utf-8");
    await mkdir(path.join(f.root, "env", "preview", ".affect-deploy"));
    const result = runCli(f, ["deploy"], deployEnv(f));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Cannot lock the preview profile");
    await expect(readFile(f.envFile, "utf-8")).resolves.toBe(original);
    await expect(readFixtureFile(f, "runtime-profile.env")).rejects.toThrow("ENOENT");
    await expect(readFixtureFile(f, "convex-http.body")).rejects.toThrow("ENOENT");
  }, 15_000);
});

describe("preview failure restoration", () => {
  afterEach(async () => {
    await Promise.all(
      active.splice(0).map(async (f) => {
        await f.cleanup();
      }),
    );
  });

  it("restores the original ciphertext when backend environment synchronization fails", async () => {
    const f = await fixture({ provider: { failPath: "/api/v1/update_environment_variables" } });
    const original = await readFile(f.envFile, "utf-8");
    const result = runCli(f, ["deploy"], deployEnv(f));

    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(
      "Could not synchronize Convex environment variables",
    );
    await expect(readFile(f.envFile, "utf-8")).resolves.toBe(original);
    await expect(readFixtureFile(f, "env/preview/.affect-deploy/original.env")).rejects.toThrow(
      "ENOENT",
    );
  }, 15_000);

  it("preserves concurrent profile changes and retains the original ciphertext for recovery", async () => {
    const f = await fixture({ rootBuild: "bun run alter-profile.cjs" });
    const original = await readFile(f.envFile, "utf-8");
    const changed = "SYNTHETIC_USER_CHANGE=preserve-this\n";
    await writeFile(
      path.join(f.root, "alter-profile.cjs"),
      `require("node:fs").writeFileSync("env/preview/.env", ${JSON.stringify(changed)});`,
    );

    const result = runCli(f, ["deploy"], deployEnv(f));

    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("Cannot restore the preview profile");
    await expect(readFile(f.envFile, "utf-8")).resolves.toBe(changed);
    await expect(readFixtureFile(f, "env/preview/.affect-deploy/original.env")).resolves.toBe(
      original,
    );
  }, 15_000);
});

describe("preview origin validation", () => {
  it.each([
    "https://user:secret@example.com",
    "https://preview.example.com/path",
    "https://preview.example.com?token=synthetic",
    "https://preview.example.com#fragment",
    "file:///tmp/preview",
    "not an origin",
  ])("rejects an invalid explicit origin without echoing it", async (origin) => {
    await expect(
      Effect.runPromise(previewOrigin({ AFFECT_PREVIEW_ORIGIN: origin })),
    ).rejects.toThrow("Preview frontend URL must be an HTTP(S) origin.");
  });
});
