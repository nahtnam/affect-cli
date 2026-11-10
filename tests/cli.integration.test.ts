import { mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { Effect, Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { version } from "../package.json";

import {
  evaluateExports,
  fixtureEnv,
  makeFixture,
  readConvexInput,
  readConvexLog,
  readFixtureFile,
  runCli,
} from "./cli-test-helpers";
import type { Fixture } from "./cli-test-helpers";

const active: Fixture[] = [];
const dollar = "$";
const siteTemplate = `${dollar}{VERCEL_URL:+https://}${dollar}{VERCEL_URL:-http://localhost:3000}`;
const originsTemplate = `${dollar}{SITE_URL}${dollar}{VERCEL_URL:+,https://}${dollar}{VERCEL_URL}${dollar}{VERCEL_BRANCH_URL:+,https://}${dollar}{VERCEL_BRANCH_URL}`;

const fixture = async (options?: Parameters<typeof makeFixture>[0]) => {
  const value = await makeFixture(options);
  active.push(value);

  return value;
};

const expectFailure = (result: ReturnType<typeof runCli>, message: RegExp) => {
  expect(result.status).not.toBe(0);
  expect(result.stderr).toMatch(message);
};

const fixtureExists = async (result: Promise<string>): Promise<boolean> => {
  try {
    await result;

    return true;
  } catch (error) {
    if (error instanceof Error && error.message.includes("ENOENT")) {
      return false;
    }

    throw error;
  }
};

interface BuildMarker {
  readonly env: Readonly<Record<string, string | null>>;
  readonly argv: readonly string[];
}

interface ConvexHttpCall {
  authorization: string;
  body: unknown;
  path: string;
  url: string;
}

const BuildMarkerSchema = Schema.Struct({
  argv: Schema.Array(Schema.String),
  env: Schema.Record(Schema.String, Schema.NullOr(Schema.String)),
});

type ProviderOptions = NonNullable<NonNullable<Parameters<typeof makeFixture>[0]>["provider"]>;

const ConvexHttpCallSchema = Schema.Struct({
  authorization: Schema.String,
  body: Schema.Unknown,
  path: Schema.String,
  url: Schema.String,
});

const EnvironmentChangeSchema = Schema.Struct({ name: Schema.String, value: Schema.String });
const EnvironmentChangesSchema = Schema.Struct({ changes: Schema.Array(EnvironmentChangeSchema) });

const parseBuildMarker = (source: string): BuildMarker =>
  Effect.runSync(Schema.decodeEffect(Schema.fromJsonString(BuildMarkerSchema))(source));

const parseHttpCall = (source: string): ConvexHttpCall =>
  Effect.runSync(Schema.decodeEffect(Schema.fromJsonString(ConvexHttpCallSchema))(source));

const expectNativeEnvironment = (
  env: Record<string, string>,
  key: string,
  target: string,
  privateKey: string | undefined,
) => {
  expect(env).toMatchObject({
    CONVEX_AGENT_MODE: "",
    CONVEX_DEPLOYMENT: "",
    CONVEX_DEPLOYMENT_TOKEN: "",
    CONVEX_DEPLOY_KEY: key,
    CONVEX_OVERRIDE_ACCESS_TOKEN: "",
    CONVEX_PROVISION_HOST: "https://api.convex.dev",
    CONVEX_SELF_HOSTED_ADMIN_KEY: "",
    CONVEX_SELF_HOSTED_URL: "",
    DOTENV_PRIVATE_KEY: privateKey,
    NODE_USE_ENV_PROXY: "1",
    VERCEL_ENV: target,
    VITE_CONVEX_SITE_URL: "",
    VITE_CONVEX_URL: "",
  });
  expect({
    branch: env["VERCEL_GIT_COMMIT_REF"],
    inherited: env["INHERITED_SECRET"],
    mode: {
      bun: env["BUN_OPTIONS"],
      node: env["NODE_OPTIONS"],
      productionUrl: env["VERCEL_PROJECT_PRODUCTION_URL"],
    },
    unreviewed: env["VITE_UNREVIEWED"],
  }).toMatchObject({
    branch: target === "preview" ? "feature/fixture" : undefined,
    inherited: undefined,
    mode: { bun: "", node: "", productionUrl: "" },
    unreviewed: undefined,
  });
  expect(env["HOME"]).toContain("affect-cli-home-");
};

const expectBuildArtifact = (build: BuildMarker, target: string, root: string) => {
  expect(build.env).toMatchObject({
    BUN_OPTIONS: null,
    CONVEX_DEPLOY_KEY: null,
    DOTENV_PRIVATE_KEY: null,
    INHERITED_SECRET: null,
    NODE_OPTIONS: null,
    NODE_USE_ENV_PROXY: null,
    PROFILE_ONLY_SECRET: null,
    SERVER_SECRET: null,
    SITE_URL: null,
    TOOL_SENTINEL: null,
    VERCEL_ENV: target,
    VERCEL_GIT_COMMIT_REF: target === "preview" ? "feature/fixture" : null,
    VERCEL_URL: "preview.example.com",
    VITE_CONVEX_SITE_URL: "https://callback.convex.site",
    VITE_CONVEX_URL: "https://callback.convex.cloud",
    VITE_POSTHOG_HOST: "https://us.i.posthog.com",
    VITE_POSTHOG_KEY: "",
    VITE_SITE_URL: "https://preview.example.com",
    VITE_UNREVIEWED: null,
  });
  expect({
    argv: build.argv,
  }).toStrictEqual({ argv: [path.join(root, "build-marker.cjs")] });
  expect(build.env["HOME"]).toContain("affect-cli-home-");
  expect(build.env["PATH"]).toBeTruthy();
  expect(build.env["TMPDIR"]).toBeTruthy();
};

const expectNativeBuildEnvironment = (
  nativeEnv: string,
  profileSecret: string,
  unreviewed: string,
  inheritedSecret: string,
) => {
  expect({
    bun: nativeEnv.includes("BUN_OPTIONS=\n"),
    cloud: nativeEnv.includes("VITE_CONVEX_URL=\n"),
    inherited: nativeEnv.includes(inheritedSecret),
    node: nativeEnv.includes("NODE_OPTIONS=\n"),
    profile: nativeEnv.includes(profileSecret),
    proxy: nativeEnv.includes("NODE_USE_ENV_PROXY=1"),
    site: nativeEnv.includes("VITE_CONVEX_SITE_URL=\n"),
    unreviewed: nativeEnv.includes(unreviewed),
  }).toStrictEqual({
    bun: true,
    cloud: true,
    inherited: false,
    node: true,
    profile: false,
    proxy: true,
    site: true,
    unreviewed: false,
  });
};

const expectSecretFree = (output: string, values: string[]) => {
  expect(values.every((value) => !output.includes(value))).toBeTruthy();
};

describe("published CLI", () => {
  afterEach(async () => {
    await Promise.all(
      active.splice(0).map(async (value) => {
        await value.cleanup();
      }),
    );
  });

  it.each([
    ["--help", /Environment and native deployment commands/u],
    ["--version", `affect v${version}`],
  ])("supports %s without project credentials", async (flag, output) => {
    const f = await fixture();
    const result = runCli(f, [flag]);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(output);
  });

  it("forwards arguments to the bundled dotenvx", async () => {
    const f = await fixture();
    const result = runCli(f, ["dotenvx", "--", "--version"]);
    expect(result).toMatchObject({ status: 0, stdout: "2.38.0\n" });
  });

  it.each([
    ["development", {}],
    ["ci", { CI: "true" }],
    ["ci", { GITHUB_ACTIONS: "true" }],
    ["preview", { CI: "true", VERCEL_ENV: "preview" }],
    ["ci", { CI: "true", VERCEL_ENV: "" }],
  ])("selects %s from environment precedence", async (environment, overrides) => {
    const f = await fixture({ environment, values: { AFFECT_SELECTED: environment } });
    const result = runCli(f, ["env"], { ...fixtureEnv(f), ...overrides });
    expect(result.status).toBe(0);
    expect(evaluateExports(f, result.stdout, "AFFECT_SELECTED")).toMatchObject({
      status: 0,
      stdout: environment,
    });
  });

  it("round-trips quotes, backticks, dollar signs, and newlines through the shell", async () => {
    const value = "single' double\" `touch escaped-marker` dollar$\nnext";
    const f = await fixture({ values: { AFFECT_VALUE: value } });
    const result = runCli(f, ["env"], fixtureEnv(f));
    expect(result.status).toBe(0);
    expect(evaluateExports(f, result.stdout, "AFFECT_VALUE")).toMatchObject({
      status: 0,
      stdout: value,
    });
    await expect(readFixtureFile(f, "escaped-marker")).rejects.toThrow("ENOENT");
  });

  it("resolves dotenvx command substitutions exactly once before exporting", async () => {
    const f = await fixture();
    await mkdir(path.dirname(f.envFile), { recursive: true });
    await writeFile(f.envFile, 'AFFECT_COUNTER="$(echo invocation >> counter; printf resolved)"\n');
    const result = runCli(f, ["env"], { DOTENV_PRIVATE_KEY: "synthetic-unused-key" });
    expect(result.status).toBe(0);
    expect(evaluateExports(f, result.stdout, "AFFECT_COUNTER")).toMatchObject({
      status: 0,
      stdout: "resolved",
    });
    await expect(readFixtureFile(f, "counter")).resolves.toBe("invocation\n");
  });

  it("expands the Vercel URL template to the local fallback without Vercel variables", async () => {
    const f = await fixture({
      values: {
        SITE_URL: siteTemplate,
        TRUSTED_ORIGINS: originsTemplate,
      },
    });

    const result = runCli(f, ["env"], fixtureEnv(f));
    expect(result.status).toBe(0);
    expect(evaluateExports(f, result.stdout, "SITE_URL")).toMatchObject({
      status: 0,
      stdout: "http://localhost:3000",
    });
    expect(evaluateExports(f, result.stdout, "TRUSTED_ORIGINS")).toMatchObject({
      status: 0,
      stdout: "http://localhost:3000",
    });
  });

  it("rejects invalid shell variable names without exposing their values", async () => {
    const f = await fixture();
    await mkdir(path.dirname(f.envFile), { recursive: true });
    await writeFile(f.envFile, "BAD-NAME=private-test-value\n");
    const result = runCli(f, ["env"], { DOTENV_PRIVATE_KEY: "synthetic-unused-key" });
    expectFailure(result, /invalid shell variable name/u);
    expect(result.stdout).toBe("");
    expect(result.stderr).not.toContain("private-test-value");
  });

  it("allows a fresh project without an encrypted file or key", async () => {
    const f = await fixture();
    expect(runCli(f, ["env"])).toMatchObject({ status: 0, stderr: "", stdout: "\n" });
  });

  it("rejects an unsupported environment", async () => {
    const f = await fixture();
    const result = runCli(f, ["env"], { VERCEL_ENV: "staging" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/Unsupported/u);
  });

  it("rejects a missing encrypted file without exposing the key", async () => {
    const f = await fixture();
    const result = runCli(f, ["env"], { DOTENV_PRIVATE_KEY: "never-print-this" });
    expectFailure(result, /Missing encrypted project file/u);
    expect(result.stderr).not.toContain("never-print-this");
  });

  it("requires the key for an existing encrypted file", async () => {
    const f = await fixture({ values: { PRIVATE_VALUE: "secret-fixture" } });
    const result = runCli(f, ["env"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/Set DOTENV_PRIVATE_KEY/u);
  });

  it("fails with a wrong key and does not expose plaintext", async () => {
    const f = await fixture({ values: { PRIVATE_VALUE: "secret-fixture" } });
    const result = runCli(f, ["env"], { DOTENV_PRIVATE_KEY: "0".repeat(64) });
    expectFailure(result, /Cannot load/u);
    expect(`${result.stdout}${result.stderr}`).not.toContain("secret-fixture");
  });

  it("rejects conflicting inherited deployment credentials", async () => {
    const f = await fixture({ values: { CONVEX_DEPLOY_KEY: "preview:expected" } });
    expectFailure(
      runCli(f, ["env"], { ...fixtureEnv(f), CONVEX_DEPLOY_KEY: "prod:other" }),
      /CONVEX_DEPLOY_KEY conflicts/u,
    );
    await expect(readConvexLog(f)).resolves.toBe("");
  });

  it("initializes a fresh anonymous backend and imports config without installing", async () => {
    const f = await fixture({ values: { AFFECT_SETUP_VALUE: "synthetic setup value" } });
    expect(runCli(f, ["setup"], fixtureEnv(f)).status).toBe(0);
    await expect(readConvexLog(f)).resolves.toMatch(
      /^init\nCONVEX_DEPLOY_KEY=\nCONVEX_AGENT_MODE=anonymous\nenv set/mu,
    );
    await expect(readConvexInput(f, 1)).resolves.toContain(
      'AFFECT_SETUP_VALUE="synthetic setup value"',
    );
    await expect(readFixtureFile(f, "install.marker")).rejects.toThrow("ENOENT");
    await expect(readFixtureFile(f, "bun.lock")).rejects.toThrow("ENOENT");
  });

  it("retries an existing anonymous backend without another initialization", async () => {
    const f = await fixture({ values: { AFFECT_SETUP_VALUE: "retry value" } });
    await writeFile(path.join(f.root, ".env.local"), "CONVEX_DEPLOYMENT=anonymous:existing\n");
    expect(runCli(f, ["setup"], fixtureEnv(f)).status).toBe(0);
    await expect(readConvexLog(f)).resolves.toMatch(/^env set\n/u);
  });

  it.each([
    "CONVEX_DEPLOYMENT=named:fixture\n",
    "CONVEX_DEPLOYMENT_TOKEN=token-fixture\n",
    "CONVEX_SELF_HOSTED_URL=http://self-hosted\n",
    "CONVEX_SELF_HOSTED_ADMIN_KEY=admin-fixture\n",
  ])("preserves existing %s", async (configuration) => {
    const f = await fixture();
    await writeFile(path.join(f.root, ".env.local"), configuration);
    const result = runCli(f, ["setup"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/preserved/u);
    await expect(readConvexLog(f)).resolves.toBe("");
  });

  it("stops setup if initialization does not return an anonymous backend", async () => {
    const f = await fixture({ convexMode: "bad-init", values: { AFFECT_VALUE: "test" } });
    expectFailure(runCli(f, ["setup"], fixtureEnv(f)), /expected an anonymous backend/u);
    await expect(readConvexLog(f)).resolves.toMatch(/^init\n/u);
    await expect(readConvexInput(f, 1)).rejects.toThrow("ENOENT");
  });

  it.each([
    ["production", "prod:synthetic-prod-123|synthetic-prod-key"],
    ["preview", "preview:synthetic-team:synthetic-project|synthetic-project-key"],
  ])("starts the native %s deploy with an isolated environment", async (target, key) => {
    const f = await fixture({
      environment: target,
      values: { CONVEX_DEPLOY_KEY: key, SERVER_SECRET: "synthetic-server-secret" },
    });

    const existingModeFile =
      "VITE_CONVEX_URL=https://user-owned.invalid\nKEEP_THIS=byte-for-byte\n";

    await mkdir(path.join(f.root, "apps", "web"), { recursive: true });
    await writeFile(path.join(f.root, "apps", "web", ".env.production"), existingModeFile);

    const result = runCli(f, ["deploy"], {
      ...fixtureEnv(f),
      BUN_OPTIONS: "--no-progress",
      CI: "true",
      INHERITED_SECRET: "synthetic-inherited-secret",
      NODE_OPTIONS: "--no-warnings",
      NODE_USE_ENV_PROXY: "1",
      VERCEL: "1",
      VERCEL_ENV: target,
      VERCEL_GIT_COMMIT_REF: "feature/fixture",
      VERCEL_URL: "preview.example.com",
      VITE_UNREVIEWED: "synthetic-unreviewed-public-value",
    });

    const log = await readConvexLog(f);
    const nativeCwd = await readFixtureFile(f, "native-cwd.log");
    expect({
      commandMatches: log.includes(
        target === "preview"
          ? "deploy --cmd-url-env-var-name VITE_CONVEX_URL --preview-name feature/fixture --cmd bunx --no-install affect deploy --build"
          : "deploy --cmd-url-env-var-name VITE_CONVEX_URL --cmd bunx --no-install affect deploy --build",
      ),
      firstLineContainsKey: log.split("\n")[0]?.includes(key),
      status: result.status,
    }).toStrictEqual({ commandMatches: true, firstLineContainsKey: false, status: 0 });
    const fixtureRoot = await realpath(f.root);
    expect(nativeCwd).toBe(`${fixtureRoot}\n`);

    const nativeEnvLog = await readFixtureFile(f, "native-env.log");

    const envEntries = nativeEnvLog
      .trim()
      .split("\n")
      .map((line): [string, string] => {
        const index = line.indexOf("=");

        return [line.slice(0, index), line.slice(index + 1)];
      });

    const env = Effect.runSync(
      Schema.decodeEffect(Schema.Record(Schema.String, Schema.String))(
        Object.fromEntries(envEntries),
      ),
    );

    expectNativeEnvironment(env, key, target, f.privateKey);

    await expect(fixtureExists(readFixtureFile(f, "build.marker"))).resolves.toBeFalsy();
    await expect(readFixtureFile(f, "apps/web/.env.production")).resolves.toBe(existingModeFile);
    expect(result.stdout + result.stderr).not.toContain(key);
  });

  it.each([
    ["production", "prod:synthetic-prod-123|synthetic-prod-key", "prod"],
    ["preview", "preview:synthetic-team:synthetic-project|synthetic-project-key", "preview"],
  ])(
    "verifies the %s credential and keeps the build on an explicit allowlist",
    async (target, key, deploymentType) => {
      const serverSecret = "synthetic-backend-only-secret";
      const profileSecret = "synthetic-profile-only-secret";
      const inheritedSecret = "synthetic-inherited-only-secret";
      const unreviewed = "synthetic-unreviewed-vite-value";
      const special = "quote\" single' backslash\\n CRLF\r\n trailing\n";

      const f = await fixture({
        convexMode: "run-build",
        environment: target,
        values: {
          CONVEX_DEPLOY_KEY: key,
          INTERPOLATED_VALUE: `${dollar}{VERCEL_URL}`,
          POSTHOG_HOST: "https://us.i.posthog.com",
          POSTHOG_KEY: "",
          PROFILE_ONLY_SECRET: profileSecret,
          SERVER_SECRET: serverSecret,
          SITE_URL: siteTemplate,
          SPECIAL_VALUE: special,
          TRUSTED_ORIGINS: originsTemplate,
          VITE_CONVEX_SITE_URL: "https://stale-profile.convex.site",
          VITE_CONVEX_URL: "https://stale-profile.convex.cloud",
          VITE_POSTHOG_HOST: `${dollar}{POSTHOG_HOST}`,
          VITE_POSTHOG_KEY: `${dollar}{POSTHOG_KEY}`,
          VITE_SITE_URL: siteTemplate,
          VITE_UNREVIEWED: unreviewed,
        },
      });

      const modeFile = [
        "VITE_CONVEX_URL=https://stale-root.invalid",
        "VITE_CONVEX_SITE_URL=https://stale-root.invalid",
        "VERCEL_PROJECT_PRODUCTION_URL=stale-root.example.com",
        "VITE_SITE_URL=https://stale-root.invalid",
        "VITE_POSTHOG_KEY=stale-root-public-key",
        "NODE_OPTIONS=--import=stale-root-loader",
        "BUN_OPTIONS=--preload=stale-root-loader",
        "TOOL_SENTINEL=stale-root-tool-value",
        "",
      ].join("\n");

      await writeFile(path.join(f.root, ".env"), modeFile);
      await writeFile(
        path.join(f.root, "apps", "web", ".env.production"),
        "VITE_POSTHOG_KEY=mode-file-public-key\n",
      );

      const result = runCli(f, ["deploy"], {
        ...fixtureEnv(f),
        BUN_OPTIONS: "--no-progress",
        CI: "true",
        INHERITED_SECRET: inheritedSecret,
        NODE_OPTIONS: "--no-warnings",
        NODE_USE_ENV_PROXY: "1",
        PROFILE_ONLY_SECRET: profileSecret,
        VERCEL: "1",
        VERCEL_BRANCH_URL: "feature-fixture.example.com",
        VERCEL_ENV: target,
        VERCEL_GIT_COMMIT_REF: "feature/fixture",
        VERCEL_URL: "preview.example.com",
        VITE_POSTHOG_HOST: "https://inherited-posthog.invalid",
        VITE_SITE_URL: "https://inherited-public.invalid",
        VITE_UNREVIEWED: unreviewed,
      });

      const build = parseBuildMarker(await readFixtureFile(f, "build.marker"));
      expectBuildArtifact(build, target, f.root);
      expect(build.env["VITE_POSTHOG_KEY"]).toBe("");
      const persistedModeFile = await readFixtureFile(f, ".env");
      expect({ modeFile: persistedModeFile, status: result.status }).toStrictEqual({
        modeFile,
        status: 0,
      });

      const httpLog = await readFixtureFile(f, "convex-http.log");

      const calls = httpLog
        .trim()
        .split("\n")
        .map((line) => parseHttpCall(line));

      const updateKey =
        deploymentType === "preview"
          ? "Convex preview:synthetic-team:synthetic-project|synthetic-admin-key"
          : "Convex prod:synthetic-prod-123|synthetic-prod-key";

      const previewAuth = calls.find((call) => call.path === "/api/deployment/authorize_preview");

      const directAuthorization = calls.find(
        (call) => call.path === "/api/deployment/url_for_key",
      )?.authorization;

      expect({
        directAuthorization,
        legacyLookup: calls.some(
          (call) => call.path === "/api/deployment/team_and_project_for_key",
        ),
        previewAuth,
      }).toMatchObject(
        deploymentType === "preview"
          ? {
              legacyLookup: false,
              previewAuth: {
                authorization: `Bearer ${key}`,
                body: {
                  previewName: "feature/fixture",
                  projectSelection: {
                    kind: "teamAndProjectSlugs",
                    projectSlug: "synthetic-project",
                    teamSlug: "synthetic-team",
                  },
                },
              },
            }
          : {
              directAuthorization: `Bearer ${key}`,
              previewAuth: undefined,
            },
      );

      const update = calls.find((call) => call.path === "/api/v1/update_environment_variables");
      expect({
        canonicalUrls: calls.find((call) => call.path === "/api/v1/get_canonical_urls")
          ?.authorization,
        deploymentInfo: calls.find((call) => call.path === "/api/v1/deployment_info")
          ?.authorization,
        updateAuthorization: update?.authorization,
        updateUrl: update?.url,
      }).toMatchObject({
        canonicalUrls: updateKey,
        deploymentInfo: updateKey,
        updateAuthorization: updateKey,
        updateUrl: "https://callback.convex.cloud/api/v1/update_environment_variables",
      });

      const expectedChanges = [
        { name: "SERVER_SECRET", value: serverSecret },
        { name: "SITE_URL", value: "https://preview.example.com" },
        {
          name: "TRUSTED_ORIGINS",
          value:
            "https://preview.example.com,https://preview.example.com,https://feature-fixture.example.com",
        },
        { name: "INTERPOLATED_VALUE", value: "preview.example.com" },
        { name: "SPECIAL_VALUE", value: special },
      ];

      if (update === undefined) {
        throw new Error("Malformed environment update fixture");
      }

      const actualChanges = Effect.runSync(
        Schema.decodeUnknownEffect(EnvironmentChangesSchema)(update.body),
      ).changes;

      expect(actualChanges.toSorted((a, b) => a.name.localeCompare(b.name))).toStrictEqual(
        expectedChanges.toSorted((a, b) => a.name.localeCompare(b.name)),
      );
      const nativeEnv = await readFixtureFile(f, "native-env.log");
      expectNativeBuildEnvironment(nativeEnv, profileSecret, unreviewed, inheritedSecret);
      const output = result.stdout + result.stderr;
      expectSecretFree(output, [
        key,
        serverSecret,
        profileSecret,
        inheritedSecret,
        unreviewed,
        "synthetic-admin-key",
      ]);
    },
    15_000,
  );

  it.each([
    ["cloud", "VITE_CONVEX_URL", "https://callback.convex.cloud"],
    ["site", "VITE_CONVEX_SITE_URL", "https://callback.convex.site"],
  ])(
    "rejects a missing native %s URL despite a matching stale value",
    async (missing, name, stale) => {
      const key = "prod:synthetic-prod-123|synthetic-prod-key";

      if (missing !== "cloud" && missing !== "site") {
        throw new Error(`Unexpected callback fixture: ${missing}`);
      }

      const f = await fixture({
        convexMode: "run-build",
        environment: "production",
        provider: { missingCallback: missing },
        values: { CONVEX_DEPLOY_KEY: key, SERVER_SECRET: "synthetic-secret" },
      });

      const modeFile = `${name}=${stale}\n`;
      await writeFile(path.join(f.root, ".env"), modeFile);

      const result = runCli(f, ["deploy"], {
        ...fixtureEnv(f),
        VERCEL_ENV: "production",
        [name]: stale,
      });

      expectFailure(result, /Native Convex did not inject the canonical/u);
      await expect(readFixtureFile(f, ".env")).resolves.toBe(modeFile);
      expect({
        buildMarker: await fixtureExists(readFixtureFile(f, "build.marker")),
        convexHttpBody: await fixtureExists(readFixtureFile(f, "convex-http.body")),
        convexHttpLog: await fixtureExists(readFixtureFile(f, "convex-http.log")),
      }).toStrictEqual({ buildMarker: false, convexHttpBody: false, convexHttpLog: false });
      const nativeEnv = await readFixtureFile(f, "native-env.log");
      expect(nativeEnv).toContain("VITE_CONVEX_URL=\n");
      expect(nativeEnv).toContain("VITE_CONVEX_SITE_URL=\n");
    },
  );

  it("lets the production mode file supply an unspecified optional public value", async () => {
    const f = await fixture({
      convexMode: "run-build",
      environment: "production",
      values: {
        CONVEX_DEPLOY_KEY: "prod:synthetic-prod-123|synthetic-prod-key",
        SERVER_SECRET: "synthetic-secret",
      },
    });

    await writeFile(
      path.join(f.root, "apps", "web", ".env.production"),
      "VITE_POSTHOG_HOST=https://mode-file-posthog.invalid\n",
    );

    const result = runCli(f, ["deploy"], {
      ...fixtureEnv(f),
      VERCEL_ENV: "production",
    });

    expect(result.status).toBe(0);
    const build = parseBuildMarker(await readFixtureFile(f, "build.marker"));
    expect(build.env["VITE_POSTHOG_HOST"]).toBe("https://mode-file-posthog.invalid");
    expect(build.env["VITE_CONVEX_URL"]).toBe("https://callback.convex.cloud");
    expect(build.env["VITE_CONVEX_SITE_URL"]).toBe("https://callback.convex.site");
  });

  it.each([
    ["CONVEX_OVERRIDE_ACCESS_TOKEN", "synthetic-override-token"],
    ["CONVEX_DEPLOYMENT_TOKEN", "synthetic-deployment-token"],
    ["CONVEX_SELF_HOSTED_URL", "https://self-hosted.invalid"],
  ])("rejects inherited managed auth control %s before native deploy", async (name, value) => {
    const f = await fixture({
      environment: "production",
      values: {
        CONVEX_DEPLOY_KEY: "prod:synthetic-prod-123|synthetic-prod-key",
        SERVER_SECRET: "synthetic",
      },
    });

    const result = runCli(f, ["deploy"], {
      ...fixtureEnv(f),
      VERCEL_ENV: "production",
      [name]: value,
    });

    expectFailure(result, /Conflicting Convex deployment authentication/u);
    await expect(readConvexLog(f)).resolves.toBe("");
    expect(result.stdout + result.stderr).not.toContain(value);
  });

  const providerFailureCases: readonly (readonly [string, ProviderOptions])[] = [
    ["provider exception", { failPath: "/api/deployment/url_for_key" }],
    ["redirect", { redirectPath: "/api/deployment/url_for_key" }],
    [
      "malformed response",
      { responses: { "/api/deployment/url_for_key": { unexpected: "synthetic" } } },
    ],
    [
      "wrong deployment type",
      {
        responses: {
          "/api/v1/deployment_info": {
            deploymentType: "dev",
            id: 33,
            kind: "cloud",
            projectId: 22,
            teamId: 11,
          },
        },
      },
    ],
  ];

  it.each(providerFailureCases)(
    "fails closed on %s before update or build",
    async (_name, provider) => {
      const f = await fixture({
        convexMode: "run-build",
        environment: "production",
        provider,
        values: {
          CONVEX_DEPLOY_KEY: "prod:synthetic-prod-123|synthetic-prod-key",
          SERVER_SECRET: "synthetic-backend-secret",
        },
      });

      const result = runCli(f, ["deploy"], { ...fixtureEnv(f), VERCEL_ENV: "production" });
      expect({
        hasProviderFailure: result.stderr.includes("synthetic provider failure"),
        statusIsFailure: result.status !== 0,
      }).toStrictEqual({ hasProviderFailure: false, statusIsFailure: true });
      await expect(fixtureExists(readFixtureFile(f, "build.marker"))).resolves.toBeFalsy();
      const calls = await readFixtureFile(f, "convex-http.log").catch(() => "");
      expectSecretFree(calls, ["update_environment_variables", "https://redirect.invalid"]);
      expectSecretFree(result.stdout + result.stderr, ["synthetic-backend-secret"]);
    },
  );

  it("propagates a native deployment failure without running the callback", async () => {
    const f = await fixture({
      convexMode: "fail-deploy",
      environment: "production",
      values: {
        CONVEX_DEPLOY_KEY: "prod:synthetic-prod-123|synthetic-prod-key",
        SERVER_SECRET: "synthetic",
      },
    });

    expectFailure(
      runCli(f, ["deploy"], { ...fixtureEnv(f), VERCEL_ENV: "production" }),
      /Convex deploy exited with status 24/u,
    );
    await expect(readFixtureFile(f, "build.marker")).rejects.toThrow("ENOENT");
  });
});
