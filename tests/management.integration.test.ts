import { once } from "node:events";
import { createServer } from "node:http";
import type { IncomingMessage, Server } from "node:http";
import { Effect, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { afterEach, describe, expect, it } from "vitest";

import {
  applyMissingDeploymentSettings,
  classifySavedPat,
  classifyTeamToken,
  createDeployment,
  createProject,
  createProjectPreviewKey,
  createScopedDeployKey,
  getProject,
  listDeployments,
  listProjects,
  listTeams,
  readPreviewRecord,
  readDeploymentEnvironment,
  verifyDeployment,
  writeDeploymentRecordIfAbsent,
  writePreviewRecordIfAbsent,
} from "../src/management";
import type { BootstrapAuth } from "../src/management";

const token = "synthetic-bootstrap-secret";
const auth: BootstrapAuth = { kind: "pat", teamId: 11, token };
const cloud = "https://synthetic-dev-123.convex.cloud";
const site = "https://synthetic-dev-123.convex.site";
const name = "AFFECT_ONBOARDING_V1";

const record = JSON.stringify({
  deployKey: "synthetic-scoped-secret",
  privateKey: "synthetic-private-secret",
});

const project = {
  id: 22,
  name: "Synthetic project",
  slug: "synthetic-project",
  teamId: 11,
  teamSlug: "synthetic-team",
};

const deployment = {
  deploymentType: "dev",
  deploymentUrl: cloud,
  id: 33,
  isDefault: true,
  kind: "cloud",
  name: "synthetic-dev-123",
  projectId: 22,
  reference: "dev/member",
};

interface Entry {
  authorization: string | undefined;
  body: unknown;
  method: string | undefined;
  path: string;
  query: URLSearchParams;
  target: string | undefined;
}

interface Reply {
  body?: unknown;
  headers?: Record<string, string>;
  raw?: string;
  status?: number;
}

type Handler = (entry: Entry) => Reply | undefined;

const servers: Server[] = [];

interface EnvironmentValues {
  [name: string]: string;
}

const Changes = Schema.Struct({
  changes: Schema.Array(Schema.Struct({ name: Schema.String, value: Schema.String })),
});

const readEntry = async (request: IncomingMessage): Promise<Entry> => {
  request.setEncoding("utf-8");
  const chunks: string[] = [];

  for await (const chunk of request) {
    chunks.push(await Effect.runPromise(Schema.decodeUnknownEffect(Schema.String)(chunk)));
  }

  const source = chunks.join("");
  const url = new URL(request.url ?? "/", "http://127.0.0.1");

  return {
    authorization: request.headers.authorization,
    body: source === "" ? undefined : JSON.parse(source),
    method: request.method,
    path: url.pathname,
    query: url.searchParams,
    target: await Effect.runPromise(
      Schema.decodeUnknownEffect(Schema.optional(Schema.String))(request.headers["x-test-target"]),
    ),
  };
};

const fallback: Handler = () => {};

const responseBody = (reply: Reply) =>
  reply.raw ?? (reply.body === undefined ? "" : JSON.stringify(reply.body));

const fixture = async (handler: Handler = fallback) => {
  const entries: Entry[] = [];
  const values: EnvironmentValues = { UNRELATED_SECRET: "preserve-this-setting" };
  let preview: string | undefined;

  const server = createServer((request, response) => {
    const respond = async () => {
      const entry = await readEntry(request);

      entries.push(entry);
      let reply = handler(entry);

      if (reply === undefined) {
        switch (entry.path) {
          case "/v1/token_details": {
            reply = { body: { id: 44, teamId: 11, type: "teamToken" } };
            break;
          }

          case "/v1/list_personal_access_tokens": {
            reply = {
              body: {
                items: [{ creationTime: 1, id: 44, name: "synthetic" }],
                pagination: { hasMore: false },
              },
            };
            break;
          }

          case "/api/teams": {
            reply = { body: [{ id: 11, name: "Synthetic team", slug: "synthetic-team" }] };
            break;
          }

          case "/v1/teams/11/projects": {
            reply = { body: { items: [project], pagination: { hasMore: false } } };
            break;
          }

          case "/v1/projects/22/list_deployments": {
            reply = { body: [deployment] };
            break;
          }

          case "/api/v1/deployment_info": {
            reply = {
              body: { deploymentType: "dev", id: 33, kind: "cloud", projectId: 22, teamId: 11 },
            };
            break;
          }

          case "/api/v1/get_canonical_urls": {
            reply = { body: { convexCloudUrl: cloud, convexSiteUrl: site } };
            break;
          }

          case "/api/v1/list_environment_variables": {
            reply = { body: { environmentVariables: values } };
            break;
          }

          case "/api/v1/update_environment_variables": {
            const body = await Effect.runPromise(Schema.decodeUnknownEffect(Changes)(entry.body));

            for (const change of body.changes) {
              values[change.name] = change.value;
            }

            reply = {};
            break;
          }

          case "/v1/projects/22/list_default_environment_variables": {
            reply = {
              body: {
                items:
                  preview === undefined
                    ? []
                    : [{ deploymentTypes: ["preview"], name, value: preview }],
                pagination: { hasMore: false },
              },
            };
            break;
          }

          case "/v1/projects/22/update_default_environment_variables": {
            const body = await Effect.runPromise(Schema.decodeUnknownEffect(Changes)(entry.body));
            preview = body.changes[0]?.value;
            reply = {};
            break;
          }

          case "/v1/deployments/synthetic-dev-123/create_deploy_key": {
            reply = { body: { deployKey: "dev:synthetic-dev-123|synthetic-scoped-secret" } };
            break;
          }

          case "/v1/projects/22/create_preview_deploy_key": {
            reply = {
              body: {
                previewDeployKey:
                  "preview:synthetic-team:synthetic-project|synthetic-preview-secret",
              },
            };
            break;
          }

          default: {
            reply = { raw: "Unexpected synthetic route", status: 404 };
          }
        }
      }

      response.writeHead(reply.status ?? 200, {
        "content-type": "application/json",
        ...reply.headers,
      });
      response.end(responseBody(reply));
    };

    respond().catch(() => {
      response.writeHead(500);
      response.end("Synthetic fixture failed");
    });
  });

  const listening = once(server, "listening");
  server.listen(0, "127.0.0.1");
  await listening;
  servers.push(server);

  const address = await Effect.runPromise(
    Schema.decodeUnknownEffect(Schema.Struct({ port: Schema.Int }))(server.address()),
  );

  const origin = `http://127.0.0.1:${address.port}`;

  const run = async <A, E>(program: Effect.Effect<A, E, HttpClient.HttpClient>) =>
    await Effect.runPromise(
      Effect.gen(function* runFixture() {
        const native = yield* HttpClient.HttpClient;

        const client = native.pipe(
          HttpClient.mapRequest((request) => {
            const url = new URL(request.url);

            return request.pipe(
              HttpClientRequest.setHeader("x-test-target", url.origin),
              HttpClientRequest.setUrl(`${origin}${url.pathname}${url.search}`),
            );
          }),
        );

        return yield* program.pipe(Effect.provideService(HttpClient.HttpClient, client));
      }).pipe(Effect.provide(FetchHttpClient.layer)),
    );

  const selected = Effect.gen(function* selectDeployment() {
    const rows = yield* listDeployments(auth, 22);
    const [row] = rows;

    if (row === undefined) {
      throw new Error("Missing synthetic deployment");
    }

    return yield* verifyDeployment(auth, row);
  });

  return { entries, run, selected, values };
};

const writes = (entries: Entry[]) => entries.filter((entry) => entry.method === "POST");

const expectSanitized = async (promise: Promise<unknown>) => {
  let caught: unknown;

  try {
    await promise;
  } catch (error) {
    caught = error;
  }

  expect(caught).toBeDefined();
  const text = String(caught) + JSON.stringify(caught);

  for (const secret of [
    token,
    "synthetic-provider-secret",
    "synthetic-private-secret",
    "synthetic-scoped-secret",
  ]) {
    expect(text).not.toContain(secret);
  }
};

describe("native Convex onboarding Management and Deployment APIs", () => {
  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(async (server) => {
        const closed = once(server, "close");
        server.close();
        server.closeAllConnections();
        await closed;
      }),
    );
  });

  it("validates native credential kinds and uses the saved PAT team metadata endpoint", async () => {
    const f = await fixture();
    await expect(f.run(classifyTeamToken(token, 11))).resolves.toStrictEqual({
      kind: "team",
      teamId: 11,
      token,
    });
    await expect(f.run(classifySavedPat(token, 11))).resolves.toStrictEqual(auth);
    await expect(f.run(listTeams(token))).resolves.toStrictEqual([
      { id: 11, name: "Synthetic team", slug: "synthetic-team" },
    ]);
    await expectSanitized(f.run(classifyTeamToken(token, 99)));
    expect(f.entries.every((entry) => entry.authorization === `Bearer ${token}`)).toBeTruthy();
    expect(writes(f.entries)).toHaveLength(0);
  });

  it("follows project pagination and refuses repeated cursors instead of accepting partial discovery", async () => {
    const f = await fixture((entry) =>
      entry.path === "/v1/teams/11/projects"
        ? {
            body: entry.query.has("cursor")
              ? { items: [{ ...project, id: 23 }], pagination: { hasMore: false } }
              : {
                  items: [project],
                  pagination: { hasMore: true, nextCursor: "page two & safely encoded" },
                },
          }
        : undefined,
    );

    const projects = await f.run(listProjects(auth));
    expect(projects.map((item) => item.id)).toStrictEqual([22, 23]);
    expect(f.entries[1]?.query.get("cursor")).toBe("page two & safely encoded");

    const loop = await fixture((entry) =>
      entry.path === "/v1/teams/11/projects"
        ? { body: { items: [], pagination: { hasMore: true, nextCursor: "same" } } }
        : undefined,
    );

    await expectSanitized(loop.run(listProjects(auth)));
    expect(loop.entries).toHaveLength(2);
  });

  it("refuses a project from another team before deployment discovery or writes", async () => {
    const f = await fixture((entry) =>
      entry.path === "/v1/teams/11/projects"
        ? { body: { items: [{ ...project, teamId: 99 }], pagination: { hasMore: false } } }
        : undefined,
    );

    await expectSanitized(f.run(getProject(auth, 22)));
    expect(f.entries).toHaveLength(1);
    expect(writes(f.entries)).toHaveLength(0);
  });

  it("uses explicit native project and referenced deployment creation bodies", async () => {
    const f = await fixture((entry) => {
      if (entry.path.endsWith("/create_project")) {
        return { body: { id: 22, projectId: 22, slug: "synthetic-project" } };
      }

      if (entry.path.endsWith("/create_deployment")) {
        return {
          body: {
            ...deployment,
            deploymentType: "prod",
            isDefault: false,
            reference: "affect-production",
          },
        };
      }

      return fallback(entry);
    });

    await f.run(createProject(auth, "Synthetic project"));
    await f.run(createDeployment(auth, 22, "prod", "affect-production"));
    expect(writes(f.entries).map((entry) => entry.body)).toStrictEqual([
      { projectName: "Synthetic project" },
      { isDefault: false, reference: "affect-production", type: "prod" },
    ]);
  });

  it("checks backend identity before minting keys or modifying recovery settings", async () => {
    const f = await fixture((entry) =>
      entry.path === "/api/v1/deployment_info"
        ? { body: { deploymentType: "dev", id: 33, kind: "cloud", projectId: 99, teamId: 11 } }
        : undefined,
    );

    await expectSanitized(f.run(f.selected));
    expect(writes(f.entries)).toHaveLength(0);
    expect(
      f.entries
        .filter((entry) => entry.path.startsWith("/api/v1/"))
        .every((entry) => entry.authorization === `Convex ${token}` && entry.target === cloud),
    ).toBeTruthy();
  });

  it.each([
    "http://127.0.0.1:1",
    "https://attacker.invalid",
    "https://secret@synthetic-dev-123.convex.cloud",
    `${cloud}/private`,
  ])("rejects untrusted deployment origin %s without contacting it", async (origin) => {
    const f = await fixture((entry) =>
      entry.path === "/v1/projects/22/list_deployments"
        ? { body: [{ ...deployment, deploymentUrl: origin }] }
        : undefined,
    );

    await expectSanitized(f.run(f.selected));
    expect(f.entries.every((entry) => entry.target === "https://api.convex.dev")).toBeTruthy();
    expect(writes(f.entries)).toHaveLength(0);
  });

  it("mints only the selected deployment and preview-family key prefixes", async () => {
    const f = await fixture();
    const selected = await f.run(f.selected);
    await expect(f.run(createScopedDeployKey(auth, selected, "affect:development"))).resolves.toBe(
      "dev:synthetic-dev-123|synthetic-scoped-secret",
    );
    await expect(f.run(createProjectPreviewKey(auth, 22, "affect:preview"))).resolves.toBe(
      "preview:synthetic-team:synthetic-project|synthetic-preview-secret",
    );
    expect(writes(f.entries).map((entry) => entry.body)).toStrictEqual([
      { name: "affect:development" },
      { name: "affect:preview" },
    ]);

    const bad = await fixture((entry) =>
      entry.path.endsWith("/create_preview_deploy_key")
        ? { body: { previewDeployKey: "prod:synthetic-dev-123|synthetic-provider-secret" } }
        : undefined,
    );

    await expectSanitized(bad.run(createProjectPreviewKey(auth, 22, "affect:preview")));
  });

  it.each([token, `preview:synthetic-team:synthetic-project|${token}`])(
    "rejects a preview key that reuses bootstrap authority",
    async (reused) => {
      const f = await fixture((entry) =>
        entry.path.endsWith("/create_preview_deploy_key")
          ? { body: { previewDeployKey: reused } }
          : undefined,
      );

      await expectSanitized(f.run(createProjectPreviewKey(auth, 22, "affect:preview")));
      expect(writes(f.entries).map((entry) => entry.path)).toStrictEqual([
        "/v1/projects/22/create_preview_deploy_key",
      ]);
    },
  );

  it("rejects a deployment key payload that reuses bootstrap authority", async () => {
    const f = await fixture((entry) =>
      entry.path.endsWith("/create_deploy_key")
        ? { body: { deployKey: `dev:synthetic-dev-123|${token}` } }
        : undefined,
    );

    const selected = await f.run(f.selected);
    await expectSanitized(f.run(createScopedDeployKey(auth, selected, "affect:development")));
    expect(writes(f.entries)).toHaveLength(1);
  });

  it("stores one exact deployment record, verifies it, and preserves existing secrets and records", async () => {
    const f = await fixture();
    const selected = await f.run(f.selected);
    await expect(f.run(writeDeploymentRecordIfAbsent(auth, selected, name, record))).resolves.toBe(
      "created",
    );
    await expect(f.run(writeDeploymentRecordIfAbsent(auth, selected, name, record))).resolves.toBe(
      "existing",
    );
    await expectSanitized(f.run(writeDeploymentRecordIfAbsent(auth, selected, name, "different")));
    expect(f.values).toStrictEqual({ [name]: record, UNRELATED_SECRET: "preserve-this-setting" });
    expect(writes(f.entries)).toHaveLength(1);
    expect(writes(f.entries)[0]?.body).toStrictEqual({ changes: [{ name, value: record }] });
  });

  it("keeps preview defaults within the preview family without propagating to existing deployments", async () => {
    const f = await fixture();
    await expect(f.run(writePreviewRecordIfAbsent(auth, 22, name, record))).resolves.toBe(
      "created",
    );
    await expect(f.run(writePreviewRecordIfAbsent(auth, 22, name, record))).resolves.toBe(
      "existing",
    );
    await expectSanitized(f.run(writePreviewRecordIfAbsent(auth, 22, name, "different")));

    const reads = f.entries.filter((entry) =>
      entry.path.endsWith("/list_default_environment_variables"),
    );

    expect(
      reads.every(
        (entry) =>
          entry.query.get("name") === name && entry.query.get("deploymentType") === "preview",
      ),
    ).toBeTruthy();
    expect(writes(f.entries).map((entry) => entry.body)).toStrictEqual([
      {
        changes: [
          { applyToExistingDeployments: false, deploymentType: "preview", name, value: record },
        ],
      },
    ]);
  });

  it("preserves an existing production recovery record without minting or overwriting", async () => {
    const f = await fixture((entry) => {
      if (entry.path.endsWith("/list_deployments")) {
        return { body: [{ ...deployment, deploymentType: "prod" }] };
      }

      if (entry.path.endsWith("/deployment_info")) {
        return {
          body: { deploymentType: "prod", id: 33, kind: "cloud", projectId: 22, teamId: 11 },
        };
      }

      return fallback(entry);
    });

    f.values[name] = record;
    const selected = await f.run(f.selected);

    await expect(f.run(writeDeploymentRecordIfAbsent(auth, selected, name, record))).resolves.toBe(
      "existing",
    );
    await expectSanitized(f.run(writeDeploymentRecordIfAbsent(auth, selected, name, "changed")));
    expect(writes(f.entries)).toHaveLength(0);
    expect(f.values[name]).toBe(record);
  });

  it("fails closed on a changed recovery record after a write", async () => {
    let reads = 0;

    const f = await fixture((entry) => {
      if (!entry.path.endsWith("/list_default_environment_variables")) {
        return fallback(entry);
      }

      reads += 1;

      return reads === 1
        ? undefined
        : {
            body: {
              items: [{ deploymentTypes: ["preview"], name, value: "synthetic-private-secret" }],
              pagination: { hasMore: false },
            },
          };
    });

    await expectSanitized(f.run(writePreviewRecordIfAbsent(auth, 22, name, record)));
    expect(writes(f.entries)).toHaveLength(1);
  });

  it.each([
    { items: [{ deploymentTypes: ["prod"], name, value: record }], pagination: { hasMore: false } },
    { items: [], pagination: { hasMore: true, nextCursor: "hidden" } },
  ])("refuses malformed scope or incomplete preview discovery", async (body) => {
    const f = await fixture((entry) =>
      entry.path.endsWith("/list_default_environment_variables") ? { body } : undefined,
    );

    await expectSanitized(f.run(readPreviewRecord(auth, 22, name)));
    expect(writes(f.entries)).toHaveLength(0);
  });

  it.each([
    { raw: "synthetic-provider-secret", status: 502 },
    { raw: "synthetic-provider-secret", status: 200 },
    { body: { synthetic: "synthetic-provider-secret" } },
    { headers: { location: "https://attacker.invalid/synthetic-provider-secret" }, status: 307 },
  ])("sanitizes provider errors, malformed metadata, and redirects", async (reply) => {
    const f = await fixture(() => reply);
    await expectSanitized(f.run(listProjects(auth)));
    expect(f.entries).toHaveLength(1);
  });

  it("rejects oversized recovery values and unrelated names before provider calls", async () => {
    const f = await fixture();
    await expectSanitized(f.run(writePreviewRecordIfAbsent(auth, 22, name, "é".repeat(4097))));
    await expectSanitized(f.run(writePreviewRecordIfAbsent(auth, 22, "UNRELATED_SECRET", record)));
    expect(f.entries).toHaveLength(0);
  });

  it("adopts existing server settings and adds only absent names, including disabled optional settings", async () => {
    const f = await fixture();
    const selected = await f.run(f.selected);

    f.values["BETTER_AUTH_SECRET"] = "synthetic-existing-auth-secret";
    const existing = await f.run(readDeploymentEnvironment(auth, selected));

    expect(existing["BETTER_AUTH_SECRET"]).toBe("synthetic-existing-auth-secret");
    await f.run(
      applyMissingDeploymentSettings(auth, selected, {
        BETTER_AUTH_SECRET: existing["BETTER_AUTH_SECRET"] ?? "must-not-rotate",
        DISABLED_TOKEN: "",
        SITE_URL: "https://app.example.com",
      }),
    );
    await f.run(
      applyMissingDeploymentSettings(auth, selected, {
        BETTER_AUTH_SECRET: "synthetic-existing-auth-secret",
        DISABLED_TOKEN: "",
        SITE_URL: "https://app.example.com",
      }),
    );
    expect(writes(f.entries).map((entry) => entry.body)).toStrictEqual([
      {
        changes: [
          { name: "DISABLED_TOKEN", value: "" },
          { name: "SITE_URL", value: "https://app.example.com" },
        ],
      },
    ]);
    expect(f.values["BETTER_AUTH_SECRET"]).toBe("synthetic-existing-auth-secret");
    expect(f.values["UNRELATED_SECRET"]).toBe("preserve-this-setting");
  });

  it.each(["existing-provider-setting", ""])(
    "preserves a conflicting existing server value before adding any missing names",
    async (value) => {
      const f = await fixture();
      const selected = await f.run(f.selected);

      f.values["BETTER_AUTH_SECRET"] = value;
      await expectSanitized(
        f.run(
          applyMissingDeploymentSettings(auth, selected, {
            BETTER_AUTH_SECRET: "synthetic-provider-secret",
            MISSING_SETTING: "new-value",
          }),
        ),
      );
      expect(writes(f.entries)).toHaveLength(0);
      expect(f.values["BETTER_AUTH_SECRET"]).toBe(value);
      expect(f.values["MISSING_SETTING"]).toBeUndefined();
    },
  );

  it.each([
    "CONVEX_DEPLOY_KEY",
    "DOTENV_PRIVATE_KEY",
    "AFFECT_ESCROW",
    "VITE_SECRET",
    "CI",
    "PATH",
    "VERCEL_TOKEN",
    "HTTPS_PROXY",
  ])("rejects control setting %s before provider calls", async (setting) => {
    const f = await fixture();
    const selected = await f.run(f.selected);
    const before = f.entries.length;

    await expectSanitized(
      f.run(
        applyMissingDeploymentSettings(auth, selected, { [setting]: "synthetic-provider-secret" }),
      ),
    );
    expect(f.entries).toHaveLength(before);
    expect(writes(f.entries)).toHaveLength(0);
  });

  it("reports an ambiguous server setting write without exposing submitted values", async () => {
    const f = await fixture((entry) =>
      entry.path.endsWith("/update_environment_variables")
        ? { raw: "synthetic-provider-secret", status: 502 }
        : undefined,
    );

    const selected = await f.run(f.selected);

    await expect(
      f.run(
        applyMissingDeploymentSettings(auth, selected, {
          BETTER_AUTH_SECRET: "synthetic-provider-secret",
        }),
      ),
    ).rejects.toThrow("write may be incomplete");
    expect(writes(f.entries)).toHaveLength(1);
  });
});
