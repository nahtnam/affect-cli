import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { text } from "node:stream/consumers";
import { once } from "node:events";
import { Effect, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { afterEach, describe, expect, it } from "vitest";

import {
  configureHostBuild,
  distributeHostKeys,
  hostBuildCommand,
  HostBuildConfigurationSchema,
} from "../src/host-provider";

const credentials = {
  accountId: "team_fixture",
  projectId: "prj_fixture",
  teamId: "team_fixture",
  token: "synthetic-vercel-token",
};

const keys = { development: "1".repeat(64), preview: "2".repeat(64), production: "3".repeat(64) };

const CreateBody = Schema.Struct({
  key: Schema.String,
  target: Schema.Array(Schema.String),
  type: Schema.String,
  value: Schema.String,
});

interface Variable {
  decrypted?: boolean;
  gitBranch?: string;
  id: string;
  key: string;
  target: readonly string[];
  type: string;
  value: string;
  visibility?: string;
}

interface Options {
  accountId?: string;
  buildCommand?: string | null;
  failWrite?: boolean;
  hidden?: number;
  invalidList?: boolean;
  next?: number;
  projectId?: string;
  redirect?: boolean;
  rootDirectory?: string | null;
  sourceFilesOutsideRootDirectory?: boolean;
  userId?: string;
  variables?: Variable[];
}

const cleanups: (() => Promise<void>)[] = [];

const fixture = async (options: Options = {}) => {
  const requests: { body: string; method: string; path: string; teamId: string | null }[] = [];
  const variables = options.variables ?? [];

  const project = {
    accountId: options.accountId ?? credentials.accountId,
    buildCommand: options.buildCommand ?? null,
    id: options.projectId ?? credentials.projectId,
    rootDirectory: options.rootDirectory === undefined ? "apps/web" : options.rootDirectory,
    sourceFilesOutsideRootDirectory: options.sourceFilesOutsideRootDirectory ?? true,
  };

  const user = { user: { id: options.userId ?? "user_fixture" } };

  const handle = async (incoming: IncomingMessage, outgoing: ServerResponse) => {
    const body = await text(incoming);
    const url = new URL(incoming.url ?? "/", "http://localhost");

    expect(url.searchParams.has("upsert")).toBeFalsy();
    const method = incoming.method ?? "GET";
    requests.push({ body, method, path: url.pathname, teamId: url.searchParams.get("teamId") });
    outgoing.setHeader("Content-Type", "application/json");

    if (options.redirect === true) {
      outgoing.writeHead(307, { location: "https://must-not-follow.invalid" });
      outgoing.end();

      return;
    }

    if (method === "GET" && url.pathname === "/v9/projects/prj_fixture") {
      outgoing.end(JSON.stringify(project));

      return;
    }

    if (method === "GET" && url.pathname === "/v2/user") {
      outgoing.end(JSON.stringify(user));

      return;
    }

    if (method === "GET" && url.pathname === "/v10/projects/prj_fixture/env") {
      outgoing.end(
        JSON.stringify(
          options.invalidList === true
            ? { envs: "synthetic-private-provider-error" }
            : {
                envs: variables,
                hiddenProductionEnvCount: options.hidden ?? 0,
                pagination: { next: options.next ?? null },
              },
        ),
      );

      return;
    }

    if (method === "GET" && url.pathname.startsWith("/v1/projects/prj_fixture/env/")) {
      const variable = variables.find((entry) => url.pathname.endsWith(`/${entry.id}`));
      outgoing.end(JSON.stringify({ ...variable, decrypted: true }));

      return;
    }

    if (method === "POST" && url.pathname === "/v10/projects/prj_fixture/env") {
      if (options.failWrite === true) {
        outgoing.writeHead(403);
        outgoing.end(JSON.stringify({ error: { message: keys.production } }));

        return;
      }

      const parsed: unknown = JSON.parse(body);
      const decoded = await Effect.runPromise(Schema.decodeUnknownEffect(CreateBody)(parsed));
      const created = { ...decoded, id: `env_${variables.length}`, visibility: "config" };
      variables.push(created);
      outgoing.writeHead(201);
      outgoing.end(JSON.stringify({ created, failed: [] }));

      return;
    }

    if (method === "PATCH" && url.pathname === "/v9/projects/prj_fixture") {
      project.buildCommand = hostBuildCommand;
      outgoing.end(JSON.stringify(project));

      return;
    }

    outgoing.writeHead(404);
    outgoing.end("{}");
  };

  const server = createServer((incoming, outgoing) => {
    handle(incoming, outgoing).catch(() => {
      outgoing.writeHead(500);
      outgoing.end("{}");
    });
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const address = await Effect.runPromise(
    Schema.decodeUnknownEffect(Schema.Struct({ port: Schema.Int }))(server.address()),
  );

  const origin = `http://127.0.0.1:${address.port}`;

  cleanups.push(async () => {
    const closed = once(server, "close");

    server.closeAllConnections();
    server.close();
    await closed;
  });

  const run = async <A, E>(program: Effect.Effect<A, E, HttpClient.HttpClient>) =>
    await Effect.runPromise(
      Effect.gen(function* withLoopback() {
        const client = yield* HttpClient.HttpClient;

        const loopback = HttpClient.mapRequest(client, (request) => {
          const url = new URL(request.url);
          expect(url.origin).toBe("https://api.vercel.com");

          return HttpClientRequest.setUrl(request, `${origin}${url.pathname}${url.search}`);
        });

        return yield* program.pipe(Effect.provideService(HttpClient.HttpClient, loopback));
      }).pipe(Effect.provide(FetchHttpClient.layer)),
    );

  return { requests, run, variables };
};

describe("Vercel host integration", () => {
  afterEach(async () => {
    await Promise.all(
      cleanups.splice(0).map(async (cleanup) => {
        await cleanup();
      }),
    );
  });

  it("creates three encrypted keys with separate native target scopes and supports reruns", async () => {
    const f = await fixture();
    await expect(f.run(distributeHostKeys({ ...credentials, keys }))).resolves.toStrictEqual({
      created: ["development", "preview", "production"],
      preserved: [],
    });
    expect(f.variables.map(({ target, type, value }) => ({ target, type, value }))).toStrictEqual([
      { target: ["development"], type: "encrypted", value: keys.development },
      { target: ["preview"], type: "encrypted", value: keys.preview },
      { target: ["production"], type: "encrypted", value: keys.production },
    ]);
    expect(f.requests.every(({ teamId }) => teamId === credentials.teamId)).toBeTruthy();
    await expect(f.run(distributeHostKeys({ ...credentials, keys }))).resolves.toStrictEqual({
      created: [],
      preserved: ["development", "preview", "production"],
    });
    expect(f.requests.filter(({ method }) => method === "POST")).toHaveLength(3);
  });

  it("preflights every existing value before creating any missing key", async () => {
    const f = await fixture({
      variables: [
        {
          id: "env_conflict",
          key: "DOTENV_PRIVATE_KEY",
          target: ["production"],
          type: "encrypted",
          value: "4".repeat(64),
        },
      ],
    });

    await expect(f.run(distributeHostKeys({ ...credentials, keys }))).rejects.toThrow(
      "could not be matched",
    );
    expect(f.requests.every(({ method }) => method === "GET")).toBeTruthy();
  });

  it.each([
    { target: ["preview", "production"], type: "encrypted" },
    { target: ["preview"], type: "sensitive" },
    { target: ["preview"], type: "encrypted", visibility: "secret" },
    { gitBranch: "feature/override", target: ["preview"], type: "encrypted" },
  ])("preserves unverifiable and conflicting scopes %#", async (overrides) => {
    const f = await fixture({
      variables: [
        { id: "env_unverifiable", key: "DOTENV_PRIVATE_KEY", value: keys.preview, ...overrides },
      ],
    });

    await expect(f.run(distributeHostKeys({ ...credentials, keys }))).rejects.toThrow(
      "preserved all values",
    );
    expect(f.requests.every(({ method }) => method === "GET")).toBeTruthy();
  });

  it.each([{ hidden: 1 }, { next: 123 }, { invalidList: true }])(
    "fails closed for incomplete or malformed inventories %#",
    async (options) => {
      const f = await fixture(options);
      await expect(f.run(distributeHostKeys({ ...credentials, keys }))).rejects.toThrow(/./u);
      expect(f.requests.every(({ method }) => method === "GET")).toBeTruthy();
    },
  );

  it.each([{ accountId: "team_other" }, { projectId: "prj_other" }])(
    "verifies the project and account before inventory or writes %#",
    async (options) => {
      const f = await fixture(options);
      await expect(f.run(distributeHostKeys({ ...credentials, keys }))).rejects.toThrow(
        "does not match",
      );
      expect(f.requests).toHaveLength(1);
    },
  );

  it("binds personal projects to the token's current user", async () => {
    const f = await fixture({ accountId: "user_fixture" });
    await expect(
      f.run(
        distributeHostKeys({
          accountId: "user_fixture",
          keys: { preview: keys.preview },
          projectId: credentials.projectId,
          token: credentials.token,
        }),
      ),
    ).resolves.toStrictEqual({ created: ["preview"], preserved: [] });
    expect(f.requests.map(({ path }) => path)).toContain("/v2/user");
    expect(f.requests.every(({ teamId }) => teamId === null)).toBeTruthy();
  });

  it("rejects reused profile keys before network access", async () => {
    const f = await fixture();
    await expect(
      f.run(
        distributeHostKeys({
          ...credentials,
          keys: { preview: keys.preview, production: keys.preview },
        }),
      ),
    ).rejects.toThrow("distinct private keys");
    expect(f.requests).toHaveLength(0);
  });

  it("keeps provider bodies, private keys, and tokens out of request failures", async () => {
    const f = await fixture({ failWrite: true });
    const result = await f.run(distributeHostKeys({ ...credentials, keys })).catch(String);
    expect(result).toContain("host settings were not confirmed");
    expect(result).not.toContain(keys.production);
    expect(result).not.toContain(credentials.token);
  });

  it("rejects redirects without reaching another host", async () => {
    const f = await fixture({ redirect: true });
    await expect(f.run(distributeHostKeys({ ...credentials, keys }))).rejects.toThrow(
      "host settings were not confirmed",
    );
    expect(f.requests).toHaveLength(1);
  });

  it("adopts only an empty build command and preserves an existing matching command", async () => {
    const f = await fixture();
    await expect(
      f.run(configureHostBuild({ ...credentials, adoptBuildCommand: true })),
    ).resolves.toStrictEqual({
      changed: true,
    });
    expect(f.requests.find(({ method }) => method === "PATCH")?.body).toBe(
      JSON.stringify({ buildCommand: hostBuildCommand }),
    );
    await expect(
      f.run(configureHostBuild({ ...credentials, adoptBuildCommand: true })),
    ).resolves.toStrictEqual({
      changed: false,
    });
    expect(f.requests.filter(({ method }) => method === "PATCH")).toHaveLength(1);
  });

  it("requires explicit adoption and preserves custom commands", async () => {
    await expect(
      Effect.runPromise(
        Schema.decodeUnknownEffect(HostBuildConfigurationSchema)({
          ...credentials,
          adoptBuildCommand: false,
        }),
      ),
    ).rejects.toThrow(/./u);
    const f = await fixture({ buildCommand: "bun run custom-build" });
    await expect(
      f.run(configureHostBuild({ ...credentials, adoptBuildCommand: true })),
    ).rejects.toThrow("preserved the project settings");
    expect(f.requests.every(({ method }) => method === "GET")).toBeTruthy();
  });

  it.each([null, "apps/other"])("preserves incompatible host root %s", async (rootDirectory) => {
    const f = await fixture({ rootDirectory });
    await expect(
      f.run(configureHostBuild({ ...credentials, adoptBuildCommand: true })),
    ).rejects.toThrow("Root Directory apps/web");
    expect(f.requests.every(({ method }) => method === "GET")).toBeTruthy();
  });

  it("preserves a host project that excludes repository-root sources", async () => {
    const f = await fixture({ sourceFilesOutsideRootDirectory: false });
    await expect(
      f.run(configureHostBuild({ ...credentials, adoptBuildCommand: true })),
    ).rejects.toThrow("requires source files outside apps/web");
    expect(f.requests.every(({ method }) => method === "GET")).toBeTruthy();
  });
});
