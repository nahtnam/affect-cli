import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  copyFile,
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
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { text } from "node:stream/consumers";
import { Effect, Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { hostedDefaults } from "../src/hosted";
import type { HostedOptions } from "../src/hosted";
import {
  BindingSchema,
  CustodySchema,
  PendingProjectSchema,
  recordName,
} from "../src/hosted-state";
import { decryptProfile, encryptProfile } from "../src/profile-crypto";

const execute = async (file: string, args: string[], cwd: string, parent: string, home: string) => {
  const child = spawn(file, args, {
    cwd,
    env: { HOME: home, PATH: process.env["PATH"] ?? "", TMPDIR: parent },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const [stdout, stderr, status] = await Promise.all([
    text(child.stdout),
    text(child.stderr),
    once(child, "exit"),
  ]);

  if (!Schema.is(Schema.Tuple([Schema.Literal(0), Schema.Null]))(status)) {
    throw new Error("Synthetic Bun runner failed");
  }

  return { stderr, stdout };
};

const cliRoot = path.resolve(import.meta.dirname, "..");
const bootstrap = "synthetic-team-bootstrap-do-not-export";
const profiles = ["development", "preview", "production"] as const;

const project = {
  id: 22,
  name: "Synthetic project",
  slug: "synthetic-project",
  teamId: 11,
  teamSlug: "synthetic-team",
};

const defaults: HostedOptions = {
  ...hostedDefaults,
  devOrigin: "https://local.example.test",
  nonInteractive: true,
  profiles: profiles.join(","),
  project: "22",
  siteUrl: "https://app.example.test",
  team: "11",
};

const ChangeBody = Schema.Struct({
  changes: Schema.Array(Schema.Struct({ name: Schema.String, value: Schema.String })),
});

const CreationBody = Schema.Struct({
  reference: Schema.String,
  type: Schema.Literals(["dev", "prod"]),
});

const ProfileRecord = Schema.fromJsonString(CustodySchema);
const runnerResult = Schema.Struct({ error: Schema.optional(Schema.String), ok: Schema.Boolean });

interface Deployment {
  deploymentType: "dev" | "prod";
  deploymentUrl: string;
  id: number;
  isDefault: boolean;
  kind: "cloud";
  name: string;
  projectId: number;
  reference: string;
}

interface RequestEntry {
  body: string;
  method: string;
  origin: string;
  path: string;
}

interface ProviderOptions {
  failCustodyWrite?: boolean;
  failDeploymentList?: boolean;
  failProjectCreationResponse?: boolean;
  failProjectVerification?: boolean;
  identityProject?: number;
  projectMissing?: boolean;
}

interface ProviderEnvironment {
  [name: string]: string;
}

type FixtureResponse =
  | Deployment
  | string
  | number
  | boolean
  | null
  | FixtureResponse[]
  | { [name: string]: FixtureResponse };

const cleanup: (() => Promise<void>)[] = [];

const provider = async () => {
  const options: ProviderOptions = {};
  const requests: RequestEntry[] = [];
  const deployments: Deployment[] = [];
  const environments = new Map<string, ProviderEnvironment>();
  let preview: string | undefined;
  let minted = 0;

  const addDeployment = (type: "dev" | "prod") => {
    const name = type === "dev" ? "synthetic-dev-123" : "synthetic-prod-456";

    const row: Deployment = {
      deploymentType: type,
      deploymentUrl: `https://${name}.convex.cloud`,
      id: type === "dev" ? 33 : 44,
      isDefault: false,
      kind: "cloud",
      name,
      projectId: 22,
      reference: type === "dev" ? "affect-development" : "affect-production",
    };

    deployments.push(row);
    environments.set(name, {});

    return row;
  };

  const handleManagement = async (
    entry: RequestEntry,
    url: URL,
    respond: (value: FixtureResponse) => void,
  ) => {
    const { body } = entry;

    if (entry.path === "/v1/token_details") {
      respond({ id: 55, teamId: 11, type: "teamToken" });

      return true;
    }

    if (entry.path === "/v1/teams/11/projects") {
      if (options.failProjectVerification === true && options.projectMissing !== true) {
        throw new Error("Synthetic post-creation project verification failed");
      }

      respond({
        items: options.projectMissing === true ? [] : [project],
        pagination: { hasMore: false },
      });

      return true;
    }

    if (entry.path === "/v1/teams/11/create_project") {
      options.projectMissing = false;

      if (options.failProjectCreationResponse === true) {
        throw new Error("Synthetic ambiguous project creation failure");
      }

      respond({ id: project.id, slug: project.slug });

      return true;
    }

    if (entry.path === "/v1/projects/22/list_deployments") {
      if (options.failDeploymentList === true) {
        throw new Error("Synthetic deployment listing failed");
      }

      respond(deployments);

      return true;
    }

    if (entry.path === "/v1/projects/22/create_deployment") {
      const creation = await Effect.runPromise(
        Schema.decodeEffect(Schema.fromJsonString(CreationBody))(body),
      );

      const row = addDeployment(creation.type);
      row.reference = creation.reference;
      respond(row);

      return true;
    }

    if (entry.path === "/v1/projects/22/create_preview_deploy_key") {
      minted += 1;
      respond({
        previewDeployKey: `preview:synthetic-team:synthetic-project|synthetic-preview-secret-${minted}`,
      });

      return true;
    }

    if (entry.path.endsWith("/create_deploy_key")) {
      const row = deployments.find((item) => entry.path.includes(`/deployments/${item.name}/`));

      if (row === undefined) {
        throw new Error("Unknown synthetic deployment");
      }

      minted += 1;
      respond({ deployKey: `${row.deploymentType}:${row.name}|synthetic-scoped-secret-${minted}` });

      return true;
    }

    if (entry.path.endsWith("/list_default_environment_variables")) {
      expect(url.searchParams.get("deploymentType")).toBe("preview");
      expect(url.searchParams.get("name")).toBe(recordName);
      respond({
        items:
          preview === undefined
            ? []
            : [{ deploymentTypes: ["preview"], name: recordName, value: preview }],
        pagination: { hasMore: false },
      });

      return true;
    }

    if (entry.path.endsWith("/update_default_environment_variables")) {
      const changes = await Effect.runPromise(
        Schema.decodeEffect(Schema.fromJsonString(ChangeBody))(body),
      );

      preview = changes.changes[0]?.value;
      respond({});

      return true;
    }

    return false;
  };

  const handle = async (incoming: IncomingMessage, outgoing: ServerResponse) => {
    const body = await text(incoming);
    const url = new URL(incoming.url ?? "/", "http://127.0.0.1");

    const origin = await Effect.runPromise(
      Schema.decodeUnknownEffect(Schema.String)(incoming.headers["x-fixture-origin"]),
    );

    const entry = { body, method: incoming.method ?? "GET", origin, path: url.pathname };
    requests.push(entry);
    outgoing.setHeader("content-type", "application/json");

    const respond = (value: FixtureResponse) => {
      outgoing.end(JSON.stringify(value));
    };

    if (await handleManagement(entry, url, respond)) {
      return;
    }

    const row = deployments.find((item) => item.deploymentUrl === origin);

    if (row === undefined) {
      throw new Error("Unknown synthetic origin");
    }

    const values = environments.get(row.name);

    if (values === undefined) {
      throw new Error("Missing synthetic environment");
    }

    if (entry.path === "/api/v1/deployment_info") {
      respond({
        deploymentType: row.deploymentType,
        id: row.id,
        kind: "cloud",
        projectId: options.identityProject ?? 22,
        teamId: 11,
      });

      return;
    }

    if (entry.path === "/api/v1/get_canonical_urls") {
      respond({
        convexCloudUrl: row.deploymentUrl,
        convexSiteUrl: row.deploymentUrl.replace(".cloud", ".site"),
      });

      return;
    }

    if (entry.path === "/api/v1/list_environment_variables") {
      respond({ environmentVariables: values });

      return;
    }

    if (entry.path === "/api/v1/update_environment_variables") {
      const changes = await Effect.runPromise(
        Schema.decodeEffect(Schema.fromJsonString(ChangeBody))(body),
      );

      if (
        options.failCustodyWrite === true &&
        changes.changes.some((item) => item.name === recordName)
      ) {
        outgoing.writeHead(502);
        respond({ error: bootstrap });

        return;
      }

      for (const item of changes.changes) {
        values[item.name] = item.value;
      }

      respond({});

      return;
    }

    throw new Error("Unexpected synthetic route");
  };

  const server = createServer((incoming, outgoing) => {
    handle(incoming, outgoing).catch(() => {
      outgoing.writeHead(500);
      outgoing.end("Synthetic provider failed");
    });
  });

  const listening = once(server, "listening");
  server.listen(0, "127.0.0.1");
  await listening;

  const address = await Effect.runPromise(
    Schema.decodeUnknownEffect(Schema.Struct({ port: Schema.Int }))(server.address()),
  );

  cleanup.push(async () => {
    const closed = once(server, "close");
    server.close();
    server.closeAllConnections();
    await closed;
  });

  return {
    addDeployment,
    deployments,
    environments,
    minted: () => minted,
    options,
    origin: `http://127.0.0.1:${address.port}`,
    preview: () => preview,
    requests,
    setPreview: (source: string) => {
      preview = source;
    },
  };
};

const workspace = async () => {
  const parent = await realpath(await mkdtemp(path.join(tmpdir(), "affect-hosted-")));
  const root = path.join(parent, "project");
  const home = path.join(parent, "home");
  await mkdir(path.join(root, "convex"), { mode: 0o700, recursive: true });
  await mkdir(home, { mode: 0o700 });
  await symlink(path.join(cliRoot, "node_modules"), path.join(parent, "node_modules"));
  await writeFile(path.join(root, ".gitignore"), ".env*\n.setup.local/\nnode_modules/\n", {
    mode: 0o600,
  });
  await writeFile(
    path.join(root, "convex/env.config.ts"),
    `const required = { isConvexValidator: true, isOptional: "required" };
export default { BETTER_AUTH_SECRET: required, SITE_URL: required, TRUSTED_ORIGINS: required,
CLOUDFLARE_ACCOUNT_ID: required, CLOUDFLARE_API_TOKEN: required, EMAIL_FROM: required, POSTHOG_PROJECT_TOKEN: required };
export const publicEnv = ["VITE_SITE_URL", "VITE_POSTHOG_HOST", "VITE_POSTHOG_KEY"];`,
  );
  cleanup.push(async () => {
    await rm(parent, { force: true, recursive: true });
  });

  return { home, parent, root };
};

type Workspace = Awaited<ReturnType<typeof workspace>>;

type Provider = Awaited<ReturnType<typeof provider>>;

const run = async (
  f: Workspace,
  api: Provider,
  options: Partial<HostedOptions> = {},
  config: Record<string, string> = {},
) => {
  const script = path.join(f.parent, "run.ts");
  const input = { ...defaults, ...options };

  const variables = {
    AFFECT_CONVEX_TOKEN: bootstrap,
    HOME: f.home,
    XDG_STATE_HOME: path.join(f.parent, "state"),
    ...config,
  };

  await writeFile(
    script,
    `import { BunServices } from "@effect/platform-bun";
import { ConfigProvider, Effect, Layer } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { TerminalCapabilities } from "effect/cli";
import { onboardHosted } from ${JSON.stringify(path.join(cliRoot, "src/hosted.ts"))};
const program = Effect.gen(function* () {
 const native = yield* HttpClient.HttpClient;
 const client = native.pipe(HttpClient.mapRequest(request => {
   const url = new URL(request.url);
   return request.pipe(HttpClientRequest.setHeader("x-fixture-origin", url.origin), HttpClientRequest.setUrl(${JSON.stringify(api.origin)} + url.pathname + url.search));
 }));
 return yield* onboardHosted(${JSON.stringify(input)}, ${JSON.stringify(f.root)}).pipe(Effect.provideService(HttpClient.HttpClient, client));
}).pipe(Effect.provideService(TerminalCapabilities.TerminalCapabilities, { canPrompt:false, canColor:false, canAnimate:false }),
 Effect.provide(Layer.mergeAll(BunServices.layer, FetchHttpClient.layer, ConfigProvider.layer(ConfigProvider.fromUnknown(${JSON.stringify(variables)}, { preserveEmptyStrings:true })))));
try { await Effect.runPromise(program); console.log("RESULT:" + JSON.stringify({ok:true})); }
catch(error) { console.log("RESULT:" + JSON.stringify({ok:false,error:String(error)})); }
`,
    { mode: 0o600 },
  );
  const result = await execute("bun", [script], f.root, f.parent, f.home);
  const output = result.stdout + result.stderr;
  const match = /^RESULT:(?<result>.+)$/mu.exec(result.stdout)?.groups?.["result"];

  if (match === undefined) {
    throw new Error("Synthetic runner omitted its result");
  }

  const parsed = await Effect.runPromise(
    Schema.decodeEffect(Schema.fromJsonString(runnerResult))(match),
  );

  expect(output).not.toContain(bootstrap);

  return { ...parsed, output };
};

const localProfile = async (f: Workspace, profile: string) => {
  const [source, keys, mode] = await Promise.all([
    readFile(path.join(f.root, "env", profile, ".env"), "utf-8"),
    readFile(path.join(f.root, "env", profile, ".env.keys"), "utf-8"),
    stat(path.join(f.root, "env", profile, ".env.keys")),
  ]);

  const key = /^DOTENV_PRIVATE_KEY=(?<key>[a-fA-F0-9]{64})\n$/u.exec(keys)?.groups?.["key"];

  if (key === undefined) {
    throw new Error("Invalid synthetic local key");
  }

  const values = await Effect.runPromise(decryptProfile(source, key));

  return { key, mode: mode.mode % 0o1000, profile, source, values };
};

const localProfiles = async (f: Workspace) =>
  await Promise.all(profiles.map(async (profile) => await localProfile(f, profile)));

const remoteRecord = async (source: string | undefined) => {
  if (source === undefined) {
    throw new Error("Missing synthetic recovery record");
  }

  return await Effect.runPromise(Schema.decodeEffect(ProfileRecord)(source));
};

const posts = (api: Provider) => api.requests.filter((entry) => entry.method === "POST");

const writeLocalProfile = async (
  f: Workspace,
  profile: string,
  source: string | undefined,
  key?: string,
) => {
  const directory = path.join(f.root, "env", profile);
  await mkdir(directory, { mode: 0o700, recursive: true });

  if (source !== undefined) {
    await writeFile(path.join(directory, ".env"), source, { mode: 0o600 });
  }

  if (key !== undefined) {
    await writeFile(path.join(directory, ".env.keys"), `DOTENV_PRIVATE_KEY=${key}\n`, {
      mode: 0o600,
    });
  }
};

const sharedPairs = [
  ["development", "preview"],
  ["development", "production"],
  ["preview", "production"],
] as const;

const sharedRecords = async (shared: readonly string[]) =>
  await Promise.all(
    profiles.map(async (profile, index) => {
      const key = shared.includes(profile) ? "a".repeat(64) : `${index + 1}`.repeat(64);

      const deployKeys = {
        development: "dev:synthetic-dev-123|synthetic-dev-secret",
        preview: "preview:synthetic-team:synthetic-project|synthetic-preview-secret",
        production: "prod:synthetic-prod-456|synthetic-prod-secret",
      };

      const deployKey = deployKeys[profile];

      const encrypted = await Effect.runPromise(
        encryptProfile({ CONVEX_DEPLOY_KEY: deployKey }, key),
      );

      const record: typeof CustodySchema.Type = {
        ...encrypted,
        deployKey,
        profile,
        projectId: 22,
        teamId: 11,
        version: 1 as const,
      };

      if (profile !== "preview") {
        return {
          ...record,
          deploymentName: profile === "development" ? "synthetic-dev-123" : "synthetic-prod-456",
        };
      }

      return record;
    }),
  );

describe("hosted onboarding through the native Effect and Bun filesystem path", () => {
  afterEach(async () => {
    await Promise.all(
      cleanup
        .splice(0)
        .toReversed()
        .map(async (finish) => {
          await finish();
        }),
    );
  });

  it("persists a new project binding before deployment reads and resumes without recreating it", async () => {
    const f = await workspace();
    const api = await provider();
    api.options.projectMissing = true;
    api.options.failDeploymentList = true;

    const options = { createProject: project.name, profiles: "development", project: "" };
    const failed = await run(f, api, options);

    const binding = await Effect.runPromise(
      Schema.decodeEffect(Schema.fromJsonString(BindingSchema))(
        await readFile(path.join(f.root, "affect.json"), "utf-8"),
      ),
    );

    expect({
      created: posts(api).filter((entry) => entry.path.endsWith("/create_project")).length,
      ok: failed.ok,
      profiles: binding.profiles,
      projectId: binding.projectId,
      teamId: binding.teamId,
    }).toStrictEqual({
      created: 1,
      ok: false,
      profiles: ["development"],
      projectId: 22,
      teamId: 11,
    });
    api.options.failDeploymentList = false;
    const resumed = await run(f, api, options);

    expect({
      created: posts(api).filter((entry) => entry.path.endsWith("/create_project")).length,
      minted: api.minted(),
      ok: resumed.ok,
    }).toStrictEqual({ created: 1, minted: 1, ok: true });
  });

  it("journals the exact created project before verification reads and resumes without a second creation", async () => {
    const f = await workspace();
    const api = await provider();
    api.options.projectMissing = true;
    api.options.failProjectVerification = true;

    const options = { createProject: project.name, profiles: "development", project: "" };
    const failed = await run(f, api, options);
    const journal = path.join(f.root, ".setup.local", "onboarding", "project.json");

    const pending = await Effect.runPromise(
      Schema.decodeEffect(Schema.fromJsonString(PendingProjectSchema))(
        await readFile(journal, "utf-8"),
      ),
    );

    const mode = await stat(journal);

    expect({ mode: mode.mode % 0o1000, ok: failed.ok, pending }).toStrictEqual({
      mode: 0o600,
      ok: false,
      pending: {
        createProject: project.name,
        projectId: 22,
        projectSlug: project.slug,
        teamId: 11,
        version: 1,
      },
    });
    api.options.failProjectVerification = false;
    const resumed = await run(f, api, options);

    expect({
      created: posts(api).filter((entry) => entry.path.endsWith("/create_project")).length,
      minted: api.minted(),
      ok: resumed.ok,
    }).toStrictEqual({ created: 1, minted: 1, ok: true });
    await expect(stat(journal)).rejects.toThrow("ENOENT");
  });

  it("does not replay an uncertain project creation request when its response was lost", async () => {
    const f = await workspace();
    const api = await provider();
    api.options.projectMissing = true;
    api.options.failProjectCreationResponse = true;

    const options = { createProject: project.name, profiles: "development", project: "" };
    const failed = await run(f, api, options);
    api.options.failProjectCreationResponse = false;
    const retried = await run(f, api, options);

    expect({
      created: posts(api).filter((entry) => entry.path.endsWith("/create_project")).length,
      initial: failed.ok,
      minted: api.minted(),
      retried: retried.ok,
    }).toStrictEqual({ created: 1, initial: false, minted: 0, retried: false });
    expect(retried.error).toContain(
      "Project creation may have completed; explicit recovery is required before retrying.",
    );
    await expect(stat(path.join(f.root, "affect.json"))).rejects.toThrow("ENOENT");
  });

  it.each([
    ["CONVEX_ACCESS_TOKEN", "local"],
    ["VERCEL_TOKEN", "local"],
    ["CONVEX_ACCESS_TOKEN", "recovered"],
    ["VERCEL_TOKEN", "recovered"],
  ])("rejects an old %s in a %s profile before custody writes", async (name, location) => {
    const f = await workspace();
    const api = await provider();
    const oldToken = "synthetic-different-old-provisioning-token";
    const deployKey = "preview:synthetic-team:synthetic-project|synthetic-existing-preview";

    const encrypted = await Effect.runPromise(
      encryptProfile({ CONVEX_DEPLOY_KEY: deployKey, [name]: oldToken }),
    );

    const record: typeof CustodySchema.Type = {
      ...encrypted,
      deployKey,
      profile: "preview",
      projectId: 22,
      teamId: 11,
      version: 1,
    };

    const recoveredSource = JSON.stringify(record);

    if (location === "local") {
      await writeLocalProfile(f, "preview", encrypted.source, encrypted.privateKey);
    } else {
      api.setPreview(recoveredSource);
    }

    const result = await run(f, api, { profiles: "preview" });

    const retained = await readFile(path.join(f.root, "env", "preview", ".env"), "utf-8").catch(
      () => null,
    );

    expect({ minted: api.minted(), ok: result.ok, posts: posts(api).length }).toStrictEqual({
      minted: 0,
      ok: false,
      posts: 0,
    });
    expect(result.output).not.toContain(oldToken);
    expect({ local: retained, remote: api.preview() }).toStrictEqual({
      local: location === "local" ? encrypted.source : null,
      remote: location === "recovered" ? recoveredSource : undefined,
    });
    await expect(stat(path.join(f.root, "affect.json"))).rejects.toThrow("ENOENT");
  });

  it("creates independent encrypted profiles and scoped recovery records, then reruns without remote mutations", async () => {
    const f = await workspace();
    const api = await provider();
    const initial = await run(f, api);
    const saved = await localProfiles(f);

    const records = await Promise.all([
      remoteRecord(api.environments.get("synthetic-dev-123")?.[recordName]),
      remoteRecord(api.preview()),
      remoteRecord(api.environments.get("synthetic-prod-456")?.[recordName]),
    ]);

    expect({
      keys: new Set(saved.map((item) => item.key)).size,
      minted: api.minted(),
      ok: initial.ok,
    }).toStrictEqual({ keys: 3, minted: 3, ok: true });
    expect(
      saved.map((item) => ({
        encrypted: /^DOTENV_PUBLIC_KEY="[a-f0-9]{66}"\n/u.test(item.source),
        leaks: [item.key, bootstrap, "synthetic-scoped-secret"].some((secret) =>
          item.source.includes(secret),
        ),
        mode: item.mode,
        scope: item.values["CONVEX_DEPLOY_KEY"]?.split(":")[0],
        valuesLeakBootstrap: Object.values(item.values).some((value) => value.includes(bootstrap)),
      })),
    ).toStrictEqual(
      ["dev", "preview", "prod"].map((scope) => ({
        encrypted: true,
        leaks: false,
        mode: 0o600,
        scope,
        valuesLeakBootstrap: false,
      })),
    );
    expect({
      previewLeaks:
        records[1]?.deployKey.includes("synthetic-prod-456") || api.preview()?.includes(bootstrap),
      profiles: records.map((record) => record.profile),
    }).toStrictEqual({ previewLeaks: false, profiles: ["development", "preview", "production"] });
    const before = posts(api).length;
    const rerun = await run(f, api);
    const retained = await localProfiles(f);
    const journals = await readdir(path.join(f.root, ".setup.local/onboarding"));
    expect({
      journals,
      minted: api.minted(),
      ok: rerun.ok,
      posts: posts(api).length,
      retained,
    }).toStrictEqual({ journals: [], minted: 3, ok: true, posts: before, retained: saved });
  });

  it("restores the same keys from native custody in a fresh clone without minting", async () => {
    const first = await workspace();
    const api = await provider();
    const initial = await run(first, api);
    expect(initial.ok).toBeTruthy();
    const saved = await localProfiles(first);
    const clone = await workspace();
    await copyFile(path.join(first.root, "affect.json"), path.join(clone.root, "affect.json"));
    await Promise.all(
      saved.map(async (item) => {
        await writeLocalProfile(clone, item.profile, item.source);
      }),
    );
    const before = posts(api).length;
    const recovered = await run(clone, api, { recoverOnly: true });
    const restored = await localProfiles(clone);
    expect({
      minted: api.minted(),
      ok: recovered.ok,
      posts: posts(api).length,
      restored,
    }).toStrictEqual({ minted: 3, ok: true, posts: before, restored: saved });
  });

  it("adopts existing production identity settings without replacing or rotating them", async () => {
    const f = await workspace();
    const api = await provider();
    api.addDeployment("prod");
    const values = api.environments.get("synthetic-prod-456");

    if (values === undefined) {
      throw new Error("Missing fixture");
    }

    values["BETTER_AUTH_SECRET"] = "existing-synthetic-production-auth";
    values["SITE_URL"] = "https://app.example.test";
    values["TRUSTED_ORIGINS"] = "https://app.example.test";
    values["UNRELATED"] = "retain-me";
    const result = await run(f, api, { profiles: "production" });
    const record = await remoteRecord(values[recordName]);
    const decrypted = await Effect.runPromise(decryptProfile(record.source, record.privateKey));
    expect({
      adopted: decrypted["BETTER_AUTH_SECRET"],
      ok: result.ok,
      retained: values["BETTER_AUTH_SECRET"],
      unrelated: values["UNRELATED"],
    }).toStrictEqual({
      adopted: "existing-synthetic-production-auth",
      ok: true,
      retained: "existing-synthetic-production-auth",
      unrelated: "retain-me",
    });
  });

  it("fails unrecoverable existing ciphertext before minting or changing remote resources", async () => {
    const f = await workspace();
    const api = await provider();

    const encrypted = await Effect.runPromise(
      encryptProfile({ BETTER_AUTH_SECRET: "synthetic-old-secret" }),
    );

    await writeLocalProfile(f, "production", encrypted.source);
    const result = await run(f, api, { profiles: "production" });
    expect(result.ok).toBeFalsy();
    expect(result.error).toContain("no recoverable matching key");
    expect({ minted: api.minted(), posts: posts(api).length }).toStrictEqual({
      minted: 0,
      posts: 0,
    });
    await expect(readFile(path.join(f.root, "env/production/.env"), "utf-8")).resolves.toBe(
      encrypted.source,
    );
  });

  it("preserves the local journal on an ambiguous custody write and reuses its minted key on retry", async () => {
    const f = await workspace();
    const api = await provider();
    api.options.failCustodyWrite = true;
    const failed = await run(f, api, { profiles: "development" });
    expect({ minted: api.minted(), ok: failed.ok }).toStrictEqual({ minted: 1, ok: false });

    const journal = await readFile(
      path.join(f.root, ".setup.local/onboarding/development.json"),
      "utf-8",
    );

    const record = await remoteRecord(journal);
    expect(record.profile).toBe("development");
    api.options.failCustodyWrite = false;
    const retry = await run(f, api, { profiles: "development" });
    const recovered = await remoteRecord(api.environments.get("synthetic-dev-123")?.[recordName]);
    expect({ minted: api.minted(), ok: retry.ok, recovered }).toStrictEqual({
      minted: 1,
      ok: true,
      recovered: record,
    });
    await expect(readFile(path.join(f.root, "env/development/.env.keys"), "utf-8")).resolves.toBe(
      `DOTENV_PRIVATE_KEY=${record.privateKey}\n`,
    );
  });

  it("fails an explicit team mismatch or backend identity mismatch without writes", async () => {
    const f = await workspace();
    const api = await provider();
    const teamMismatch = await run(f, api, { team: "99" });
    expect({ ok: teamMismatch.ok, posts: posts(api).length }).toStrictEqual({
      ok: false,
      posts: 0,
    });
    api.addDeployment("dev");
    api.options.identityProject = 999;
    const identityMismatch = await run(f, api, { profiles: "development" });
    expect({
      minted: api.minted(),
      ok: identityMismatch.ok,
      posts: posts(api).length,
    }).toStrictEqual({ minted: 0, ok: false, posts: 0 });
  });

  it("preserves conflicting local profile and key files without remote changes", async () => {
    const f = await workspace();
    const api = await provider();
    const initial = await run(f, api);
    expect(initial.ok).toBeTruthy();
    const saved = await localProfiles(f);
    const before = posts(api).length;
    const file = path.join(f.root, "env/production/.env.keys");
    await writeFile(file, `DOTENV_PRIVATE_KEY=${"a".repeat(64)}\n`, { mode: 0o600 });
    const keyConflict = await run(f, api);
    expect({ ok: keyConflict.ok, posts: posts(api).length }).toStrictEqual({
      ok: false,
      posts: before,
    });
    await expect(readFile(path.join(f.root, "env/production/.env"), "utf-8")).resolves.toBe(
      saved[2]?.source,
    );
    await writeFile(file, `DOTENV_PRIVATE_KEY=${saved[2]?.key}\n`, { mode: 0o600 });
    const source = `${saved[2]?.source}# concurrent edit\n`;
    await writeFile(path.join(f.root, "env/production/.env"), source);
    const sourceConflict = await run(f, api);
    expect({ ok: sourceConflict.ok, posts: posts(api).length }).toStrictEqual({
      ok: false,
      posts: before,
    });
    await expect(readFile(path.join(f.root, "env/production/.env"), "utf-8")).resolves.toBe(source);
  });

  it("writes only exact selected ciphertext Git exceptions and keeps all profile keyfiles ignored", async () => {
    const f = await workspace();
    const api = await provider();
    const result = await run(f, api, { profiles: "preview,production" });
    const source = await readFile(path.join(f.root, ".gitignore"), "utf-8");
    expect({
      exceptions: source.split("\n").filter((line) => line.startsWith("!")),
      ignoresKeys: source.includes("**/.env.keys"),
      ok: result.ok,
    }).toStrictEqual({
      exceptions: ["!env/preview/.env", "!env/production/.env"],
      ignoresKeys: true,
      ok: true,
    });
    expect(source).not.toContain("!env/development/.env");
  });

  it("requires explicit CI binding and performs recovery-only runs without remote mutation", async () => {
    const f = await workspace();
    const api = await provider();
    const result = await run(f, api, { profiles: "", project: "", team: "" }, { CI: "true" });
    expect({ ok: result.ok, requests: api.requests.length }).toStrictEqual({
      ok: false,
      requests: 0,
    });
    const recovery = await run(f, api, { profiles: "development", recoverOnly: true });
    expect({ minted: api.minted(), ok: recovery.ok, posts: posts(api).length }).toStrictEqual({
      minted: 0,
      ok: false,
      posts: 0,
    });
  });

  it("reuses an orphan local key for initialization and then recovery without minting a replacement", async () => {
    const f = await workspace();
    const api = await provider();
    const key = "a".repeat(64);
    await writeLocalProfile(f, "production", undefined, key);
    const initial = await run(f, api, { profiles: "production" });
    const local = await localProfile(f, "production");
    const record = await remoteRecord(api.environments.get("synthetic-prod-456")?.[recordName]);
    expect({
      localKey: local.key,
      minted: api.minted(),
      ok: initial.ok,
      remoteKey: record.privateKey,
      source: record.source,
    }).toStrictEqual({ localKey: key, minted: 1, ok: true, remoteKey: key, source: local.source });
    await rm(path.join(f.root, "env/production/.env"));
    const before = posts(api).length;
    const recovery = await run(f, api, { profiles: "production", recoverOnly: true });
    const restored = await localProfile(f, "production");
    expect({
      minted: api.minted(),
      ok: recovery.ok,
      posts: posts(api).length,
      restored,
    }).toStrictEqual({ minted: 1, ok: true, posts: before, restored: local });
  });

  it("preserves an orphan local key that conflicts with remote recovery before publishing ciphertext", async () => {
    const f = await workspace();
    const api = await provider();
    const initial = await run(f, api, { profiles: "production" });
    expect(initial.ok).toBeTruthy();
    const source = api.environments.get("synthetic-prod-456")?.[recordName];
    const key = "b".repeat(64);
    await rm(path.join(f.root, "env/production/.env"));
    await writeLocalProfile(f, "production", undefined, key);
    const before = posts(api).length;
    const recovery = await run(f, api, { profiles: "production", recoverOnly: true });
    expect({
      minted: api.minted(),
      ok: recovery.ok,
      posts: posts(api).length,
      remote: api.environments.get("synthetic-prod-456")?.[recordName],
    }).toStrictEqual({ minted: 1, ok: false, posts: before, remote: source });
    await expect(readFile(path.join(f.root, "env/production/.env.keys"), "utf-8")).resolves.toBe(
      `DOTENV_PRIVATE_KEY=${key}\n`,
    );
    await expect(readdir(path.join(f.root, "env/production"))).resolves.toStrictEqual([
      ".env.keys",
    ]);
  });

  it("rejects shared preview and production pending journals before remote writes", async () => {
    const f = await workspace();
    const api = await provider();
    api.addDeployment("dev");
    api.addDeployment("prod");
    const records = await sharedRecords(["preview", "production"]);
    const directory = path.join(f.root, ".setup.local/onboarding");
    await mkdir(directory, { mode: 0o700, recursive: true });
    await Promise.all(
      records.map(async (record) => {
        await writeFile(path.join(directory, `${record.profile}.json`), JSON.stringify(record), {
          mode: 0o600,
        });
      }),
    );
    const result = await run(f, api);
    expect({ minted: api.minted(), ok: result.ok, posts: posts(api).length }).toStrictEqual({
      minted: 0,
      ok: false,
      posts: 0,
    });
    expect(result.error).toContain("key");
    await expect(readdir(directory)).resolves.toStrictEqual([
      "development.json",
      "preview.json",
      "production.json",
    ]);
    await expect(readdir(f.root)).resolves.not.toContain("env");
  });

  it.each([false, true])(
    "rejects preview recovery key reuse from an unselected local production profile (recoverOnly=%s)",
    async (recoverOnly) => {
      const f = await workspace();
      const api = await provider();
      const records = await sharedRecords(["preview", "production"]);
      const preview = records.find((record) => record.profile === "preview");
      const production = records.find((record) => record.profile === "production");

      if (preview === undefined || production === undefined) {
        throw new Error("Missing synthetic isolation records");
      }

      api.setPreview(JSON.stringify(preview));
      await writeLocalProfile(
        f,
        "production",
        production.source,
        production.privateKey.toUpperCase(),
      );
      const result = await run(f, api, { profiles: "preview", recoverOnly });
      expect({ minted: api.minted(), ok: result.ok, posts: posts(api).length }).toStrictEqual({
        minted: 0,
        ok: false,
        posts: 0,
      });
      expect(result.error).toContain("key");
      const retained = await localProfile(f, "production");
      expect({ key: retained.key, source: retained.source }).toStrictEqual({
        key: production.privateKey.toUpperCase(),
        source: production.source,
      });
      await expect(readdir(path.join(f.root, "env"))).resolves.toStrictEqual(["production"]);
    },
  );

  it.each(sharedPairs)(
    "rejects shared local %s and %s keys before remote writes",
    async (first, second) => {
      const f = await workspace();
      const api = await provider();
      const records = await sharedRecords([first, second]);
      await Promise.all(
        records.map(async (record) => {
          await writeLocalProfile(
            f,
            record.profile,
            record.source,
            record.profile === second ? record.privateKey.toUpperCase() : record.privateKey,
          );
        }),
      );
      const result = await run(f, api);
      expect({ minted: api.minted(), ok: result.ok, posts: posts(api).length }).toStrictEqual({
        minted: 0,
        ok: false,
        posts: 0,
      });
      expect(result.error).toContain("key");
      const retained = await localProfiles(f);
      expect(retained.map(({ key, source }) => ({ key, source }))).toStrictEqual(
        records.map(({ privateKey, profile, source }) => ({
          key: profile === second ? privateKey.toUpperCase() : privateKey,
          source,
        })),
      );
    },
  );

  it.each(sharedPairs)(
    "rejects shared remote %s and %s keys during recovery without host delivery",
    async (first, second) => {
      const f = await workspace();
      const api = await provider();
      api.addDeployment("dev");
      api.addDeployment("prod");
      const records = await sharedRecords([first, second]);

      for (const record of records) {
        const source = JSON.stringify({
          ...record,
          privateKey:
            record.profile === second ? record.privateKey.toUpperCase() : record.privateKey,
        });

        if (record.profile === "preview") {
          api.setPreview(source);
        } else {
          const environment = api.environments.get(record.deploymentName ?? "");

          if (environment === undefined) {
            throw new Error("Missing synthetic recovery environment");
          }

          environment[recordName] = source;
        }
      }

      const result = await run(f, api, { recoverOnly: true });
      expect({ minted: api.minted(), ok: result.ok, posts: posts(api).length }).toStrictEqual({
        minted: 0,
        ok: false,
        posts: 0,
      });
      expect(result.error).toContain("key");
      await expect(readdir(f.root)).resolves.not.toContain("env");
    },
  );
});
