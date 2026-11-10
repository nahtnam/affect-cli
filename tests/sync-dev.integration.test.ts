import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Effect, Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import {
  evaluateExports,
  fixtureEnv,
  makeFixture,
  readConvexLog,
  runCli,
} from "./cli-test-helpers";
import type { Fixture } from "./cli-test-helpers";

const secret = "synthetic server 'secret' \"quoted\" `literal` dollar$ \\n\nnext line";
const deployKey = "dev:synthetic-dev-123|synthetic-deployment-token";
const cloud = "https://synthetic-dev-123.convex.cloud";
const site = "https://synthetic-dev-123.convex.site";

const baseValues = {
  CONVEX_DEPLOYMENT: "dev:synthetic-dev-123",
  CONVEX_DEPLOY_KEY: deployKey,
  DISABLED_TOKEN: "",
  SERVER_SECRET: secret,
  VITE_CONVEX_SITE_URL: site,
  VITE_CONVEX_URL: cloud,
  VITE_UNRELATED: "synthetic-client-value",
};

const declaration = `const string = (isOptional: "required" | "optional") => ({
  isConvexValidator: true, isOptional, kind: "string", extraNativeMetadata: true,
});
export default {
  DISABLED_TOKEN: string("required"), SERVER_SECRET: string("required"), OPTIONAL: string("optional"),
};`;

const active: Fixture[] = [];

type ProviderResponse =
  | string
  | {
      convexCloudUrl?: string;
      convexSiteUrl?: string;
      deploymentType?: string;
      id?: number;
      kind?: string;
      projectId?: number;
      teamId?: number;
    };

interface Options {
  declaration?: string;
  existing?: Record<string, string>;
  failure?: string;
  redirect?: string;
  responses?: Record<string, ProviderResponse>;
  values?: Record<string, string>;
}

const fixture = async (options: Options = {}) => {
  const f = await makeFixture({ values: options.values ?? baseValues });
  active.push(f);
  await mkdir(path.join(f.root, "convex"), { recursive: true });
  await writeFile(path.join(f.root, "convex", "env.config.ts"), options.declaration ?? declaration);
  await writeFile(
    path.join(f.root, "convex", "convex.config.ts"),
    'throw new Error("Full app config must not execute");',
  );
  await writeFile(path.join(f.root, "sync-options.json"), JSON.stringify(options));
  await writeFile(
    path.join(f.root, "convex-http-preload.mjs"),
    `
const root = process.cwd();
const options = await Bun.file(root + "/sync-options.json").json();
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  const body = await request.text();
  const entry = { authorization: request.headers.get("authorization"), body: body ? JSON.parse(body) : null,
    method: request.method, path: url.pathname, redirect: request.redirect, url: request.url };
  await Bun.write(root + "/sync-requests.jsonl", (await Bun.file(root + "/sync-requests.jsonl").text().catch(() => "")) + JSON.stringify(entry) + "\\n");
  if (url.pathname === options.failure) {
    throw new Error("synthetic-provider-secret " + request.headers.get("authorization"));
  }
  if (url.pathname === options.redirect) return new Response("synthetic-provider-secret", { status: 307, headers: { location: "https://unexpected.invalid" } });
  const defaults = {
    "/api/deployment/url_for_key": "${cloud}",
    "/api/deployment/team_and_project_for_key": { team: "synthetic-team", teamId: 11, project: "synthetic-project", projectId: 22 },
    "/api/v1/deployment_info": { kind: "cloud", deploymentType: "dev", teamId: 11, projectId: 22, id: 33 },
    "/api/v1/get_canonical_urls": { convexCloudUrl: "${cloud}", convexSiteUrl: "${site}" },
    "/api/v1/list_environment_variables": { environmentVariables: options.existing ?? {} },
  };
  if (url.pathname === "/api/v1/update_environment_variables") return new Response(null, { status: 200 });
  if (!Object.hasOwn(defaults, url.pathname)) throw new Error("Unexpected fake provider request");
  return Response.json(Object.hasOwn(options.responses ?? {}, url.pathname) ? options.responses[url.pathname] : defaults[url.pathname]);
};
`,
  );

  return f;
};

const RequestLog = Schema.Array(
  Schema.Struct({
    authorization: Schema.String,
    body: Schema.Unknown,
    method: Schema.String,
    path: Schema.String,
    redirect: Schema.String,
    url: Schema.String,
  }),
);

const requests = async (f: Fixture) => {
  const source = await readFile(path.join(f.root, "sync-requests.jsonl"), "utf-8").catch(() => "");

  return await Effect.runPromise(
    Schema.decodeEffect(Schema.fromJsonString(RequestLog))(
      `[${source.trim().split("\n").filter(Boolean).join(",")}]`,
    ),
  );
};

const run = (f: Fixture, force = false, env: Record<string, string | undefined> = {}) =>
  runCli(f, ["env", "sync-dev", ...(force ? ["--force"] : [])], { ...fixtureEnv(f), ...env });

const expectSecretFree = (f: Fixture, result: ReturnType<typeof run>) => {
  const output = result.stdout + result.stderr;

  for (const value of [
    secret,
    deployKey,
    f.privateKey ?? "",
    "synthetic-provider-secret",
    "synthetic-client-value",
  ]) {
    if (value !== "") {
      expect(output).not.toContain(value);
    }
  }
};

describe("development environment sync through the built CLI", () => {
  afterEach(async () => {
    await Promise.all(
      active.splice(0).map(async (f) => {
        await f.cleanup();
      }),
    );
  });

  it.each([
    ["VITE_CONVEX_URL", cloud],
    ["VITE_CONVEX_SITE_URL", site],
  ])("does not fill missing %s from the inherited environment", async (name, inherited) => {
    const values =
      name === "VITE_CONVEX_URL"
        ? (({ VITE_CONVEX_URL: _omitted, ...rest }) => rest)(baseValues)
        : (({ VITE_CONVEX_SITE_URL: _omitted, ...rest }) => rest)(baseValues);

    const f = await fixture({ values });

    const result = run(f, false, { [name]: inherited });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Development profile requires");
    await expect(requests(f)).resolves.toHaveLength(0);
    expectSecretFree(f, result);
  });

  it("loads a schema-only TypeScript module without generated files or app config", async () => {
    const f = await fixture();
    const result = run(f);
    expect({
      status: result.status,
      summary: result.stdout.trim(),
      target: result.stderr.trim(),
    }).toStrictEqual({
      status: 0,
      summary: "Development settings: 2 added, 0 updated, 0 unchanged.",
      target:
        "Convex target: synthetic-team/synthetic-project; development synthetic-dev-123 (ID 33).",
    });
    const log = await requests(f);
    const writes = log.filter((entry) => entry.path === "/api/v1/update_environment_variables");
    expect(writes.map((entry) => entry.body)).toStrictEqual([
      {
        changes: [
          { name: "DISABLED_TOKEN", value: "" },
          { name: "SERVER_SECRET", value: secret },
        ],
      },
    ]);

    const markers = await Promise.all(
      ["build.marker", "install.marker", "convex/_generated/server.js"].map(
        async (relative) =>
          await readFile(path.join(f.root, relative))
            .then(() => true)
            .catch(() => false),
      ),
    );

    expect({
      authorization: log.every(
        (entry) =>
          entry.authorization ===
          `${entry.url.startsWith("https://api.convex.dev/") ? "Bearer" : "Convex"} ${deployKey}`,
      ),
      commandLog: await readConvexLog(f),
      markers,
      redirects: log.every((entry) => entry.redirect === "error"),
    }).toStrictEqual({
      authorization: true,
      commandLog: "",
      markers: [false, false, false],
      redirects: true,
    });
    expectSecretFree(f, result);
  });

  it("uses explicit development values despite hostile inherited production and provider settings", async () => {
    const f = await fixture();

    const result = run(f, false, {
      CI: "true",
      CONVEX_DEPLOYMENT: "prod:wrong",
      CONVEX_DEPLOYMENT_TOKEN: "project:wrong|synthetic-project-token",
      CONVEX_DEPLOY_KEY: "prod:wrong|synthetic-ambient-token",
      CONVEX_OVERRIDE_ACCESS_TOKEN: "synthetic-override-token",
      CONVEX_PROVISION_HOST: "https://unexpected.invalid",
      CONVEX_SELF_HOSTED_ADMIN_KEY: "synthetic-self-hosted-token",
      CONVEX_SELF_HOSTED_URL: "https://unexpected.invalid",
      GITHUB_ACTIONS: "true",
      VERCEL_ENV: "production",
    });

    expect(result.status).toBe(0);
    const log = await requests(f);
    expect(
      log.every(
        (entry) => entry.url.startsWith("https://api.convex.dev/") || entry.url.startsWith(cloud),
      ),
    ).toBeTruthy();
    expect(log.every((entry) => entry.authorization.endsWith(deployKey))).toBeTruthy();
    expectSecretFree(f, result);
  });

  it("refuses an entire conflicting batch by default and overwrites only supplied changes with --force", async () => {
    const f = await fixture({
      existing: {
        OPTIONAL: "preserve-synthetic",
        SERVER_SECRET: "different-synthetic",
        UNRELATED: "preserve-synthetic",
      },
    });

    const rejected = run(f);
    const beforeForce = await requests(f);
    expect({
      conflict: rejected.stderr.includes("Existing settings differ: SERVER_SECRET"),
      failed: rejected.status !== 0,
      writes: beforeForce.filter((entry) => entry.path.endsWith("update_environment_variables"))
        .length,
    }).toStrictEqual({ conflict: true, failed: true, writes: 0 });
    const accepted = run(f, true);
    expect(accepted.status).toBe(0);
    expect(accepted.stdout).toContain("1 added, 1 updated, 0 unchanged");

    const log = await requests(f);

    const writes = log.filter((entry) => entry.path.endsWith("update_environment_variables"));

    expect(writes.map((entry) => entry.body)).toStrictEqual([
      {
        changes: [
          { name: "DISABLED_TOKEN", value: "" },
          { name: "SERVER_SECRET", value: secret },
        ],
      },
    ]);
    expectSecretFree(f, rejected);
    expectSecretFree(f, accepted);
  });

  it("leaves identical and absent optional values unchanged without an update request", async () => {
    const f = await fixture({
      existing: { DISABLED_TOKEN: "", OPTIONAL: "preserve-synthetic", SERVER_SECRET: secret },
    });

    const result = run(f);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("0 added, 0 updated, 2 unchanged");
    const log = await requests(f);
    expect(log.filter((entry) => entry.path.endsWith("update_environment_variables"))).toHaveLength(
      0,
    );
  });

  it.each([
    "CONVEX_DEPLOY_KEY",
    "DOTENV_PRIVATE_KEY",
    "VITE_TOKEN",
    "VITE_apiToken",
    "NODE_OPTIONS",
  ])("rejects declared %s before provider access", async (name) => {
    const f = await fixture({
      declaration: `export default { ${JSON.stringify(name)}: { isConvexValidator: true, isOptional: "optional" } };`,
    });

    const result = run(f);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Server declaration contains");
    await expect(requests(f)).resolves.toHaveLength(0);
    expectSecretFree(f, result);
  });

  it.each(["apiToken"])("accepts provider-supported server name %s", async (name) => {
    const f = await fixture({
      declaration: `export default { ${name}: { isConvexValidator: true, isOptional: "required", kind: "string" } };`,
      values: { ...baseValues, [name]: secret },
    });

    const result = run(f);
    const log = await requests(f);
    expect(result.status).toBe(0);
    expect(
      log
        .filter((entry) => entry.path.endsWith("update_environment_variables"))
        .map((entry) => entry.body),
    ).toStrictEqual([{ changes: [{ name, value: secret }] }]);
    expectSecretFree(f, result);
  });

  it("does not treat inherited object properties as required profile values", async () => {
    const f = await fixture({
      declaration:
        'export default { constructor: { isConvexValidator: true, isOptional: "required" } };',
    });

    const result = run(f);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Missing required server settings: constructor");
    await expect(requests(f)).resolves.toHaveLength(0);
    expectSecretFree(f, result);
  });

  it.each([
    { CONVEX_DEPLOY_KEY: "prod:wrong|synthetic-token" },
    { CONVEX_DEPLOY_KEY: "project:wrong|synthetic-token" },
    { CONVEX_DEPLOYMENT: "dev:another-deployment" },
    { SERVER_SECRET: undefined },
  ])(
    "rejects a missing required value or invalid profile before provider access",
    async (overrides) => {
      const values = { ...baseValues };

      for (const [key, value] of Object.entries(overrides)) {
        if (value === undefined) {
          Reflect.deleteProperty(values, key);
        } else {
          Object.assign(values, { [key]: value });
        }
      }

      const f = await fixture({ values });
      const result = run(f);
      expect(result.status).not.toBe(0);
      await expect(requests(f)).resolves.toHaveLength(0);
      expectSecretFree(f, result);
    },
  );

  it.each([
    ["/api/deployment/url_for_key", "https://wrong.convex.cloud"],
    [
      "/api/v1/deployment_info",
      { deploymentType: "prod", id: 33, kind: "cloud", projectId: 22, teamId: 11 },
    ],
    ["/api/v1/deployment_info", { kind: "selfHosted" }],
    [
      "/api/v1/deployment_info",
      { deploymentType: "dev", id: 33, kind: "cloud", projectId: 44, teamId: 11 },
    ],
    [
      "/api/v1/get_canonical_urls",
      { convexCloudUrl: cloud, convexSiteUrl: "https://wrong.convex.site" },
    ],
    [
      "/api/v1/get_canonical_urls",
      { convexCloudUrl: "https://wrong.convex.cloud", convexSiteUrl: site },
    ],
  ])(
    "refuses mismatched metadata at %s before reading or writing settings",
    async (pathname, response) => {
      const f = await fixture({ responses: { [pathname]: response } });
      const result = run(f);
      expect(result.status).not.toBe(0);
      const log = await requests(f);
      expect(
        log.some(
          (entry) =>
            entry.path.endsWith("list_environment_variables") ||
            entry.path.endsWith("update_environment_variables"),
        ),
      ).toBeFalsy();
      expectSecretFree(f, result);
    },
  );

  it.each(["failure", "redirect"] as const)(
    "redacts provider %s and never follows a redirect",
    async (mode) => {
      const f = await fixture({ [mode]: "/api/v1/update_environment_variables" });
      const result = run(f);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Development environment request failed");
      const log = await requests(f);
      expect(log.some((entry) => entry.url.startsWith("https://unexpected.invalid"))).toBeFalsy();
      expectSecretFree(f, result);
    },
  );

  it("keeps bare env exports compatible and rejects typos without printing exports", async () => {
    const f = await fixture();
    const legacy = runCli(f, ["env"], fixtureEnv(f));
    expect(legacy.status).toBe(0);
    expect(evaluateExports(f, legacy.stdout, "SERVER_SECRET").stdout).toBe(secret);
    const typo = runCli(f, ["env", "sync-deev"], fixtureEnv(f));
    expect(typo.status).not.toBe(0);
    expect(typo.stdout).not.toMatch(/^export /mu);
    expectSecretFree(f, typo);
    await expect(requests(f)).resolves.toHaveLength(0);
  });

  it("fails missing profiles and unreadable manifests without leaking decryption errors", async () => {
    const f = await fixture();
    const missingKey = runCli(f, ["env", "sync-dev"]);
    expect(missingKey.status).not.toBe(0);
    await rm(path.join(f.root, "convex", "env.config.ts"));
    const missingManifest = run(f);
    expect(missingManifest.status).not.toBe(0);
    await rm(f.envFile);
    const missingProfile = run(f);
    expect(missingProfile.status).not.toBe(0);
    await expect(requests(f)).resolves.toHaveLength(0);
    expectSecretFree(f, missingKey);
    expectSecretFree(f, missingManifest);
    expectSecretFree(f, missingProfile);
  });
});
