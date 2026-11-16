import { Effect, flow, Option, Record, Schema } from "effect";
import { findFirst, map, some } from "effect/Array";
import { CliError } from "effect/cli";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import type { HttpClientResponse } from "effect/http";

const management = "https://api.convex.dev/v1";
const failure = (cause: string) => new CliError.UserError({ cause });
const invalid = () => failure("Invalid Convex onboarding metadata.");
const Id = Schema.Int.check(Schema.isGreaterThan(0));
const Name = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9_-]*$/u));
const Token = Schema.String.check(Schema.isMinLength(1), Schema.isPattern(/^[^\s]+$/u));

export const HttpsOrigin = Schema.URLFromString.check(
  Schema.makeFilter(
    (url) =>
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === "" &&
      url.port === "" &&
      url.hostname !== "localhost" &&
      !url.hostname.endsWith(".localhost") &&
      !/^(?:\d+\.){3}\d+$/u.test(url.hostname) &&
      !url.hostname.includes(":"),
  ),
);

const CloudOrigin = HttpsOrigin.check(
  Schema.makeFilter((url) => url.hostname.endsWith(".convex.cloud")),
);

const SiteOrigin = HttpsOrigin.check(
  Schema.makeFilter((url) => url.hostname.endsWith(".convex.site")),
);

const RecordName = Schema.String.check(
  Schema.isPattern(/^AFFECT_[A-Z0-9_]+$/u),
  Schema.isMaxLength(256),
);

const RecordValue = Schema.String.check(
  Schema.isMinLength(1),
  Schema.makeFilter((value) => new TextEncoder().encode(value).length <= 8192),
);

const reservedSetting =
  /^(?:CONVEX_|DOTENV_|AFFECT_|(?:[A-Z0-9]+_)*PUBLIC_|VITE_|REACT_APP_|EXPO_PUBLIC_|VERCEL_|GITHUB_|NODE_|BUN_|CI$|PATH$|HOME$|PWD$|SHELL$|ENV$|TMPDIR$|(?:HTTPS?|ALL|NO)_PROXY$)/u;

const SettingName = Schema.String.check(
  Schema.isPattern(/^[A-Z][A-Z0-9_]{0,255}$/u),
  Schema.makeFilter((name) => !reservedSetting.test(name)),
);

const Settings = Schema.Record(
  SettingName,
  Schema.String.check(Schema.makeFilter((value) => new TextEncoder().encode(value).length <= 8192)),
);

export type DeploymentSettings = typeof Settings.Type;

export const TeamSchema = Schema.Struct({ id: Id, name: Schema.String, slug: Name });

export type Team = typeof TeamSchema.Type;

export const ProjectSchema = Schema.Struct({
  id: Id,
  name: Schema.String,
  slug: Name,
  teamId: Id,
  teamSlug: Name,
});

export type Project = typeof ProjectSchema.Type;

export const DeploymentTypeSchema = Schema.Literals(["dev", "prod", "preview", "custom"]);

export type DeploymentType = typeof DeploymentTypeSchema.Type;

export const DeploymentSchema = Schema.Struct({
  deploymentType: DeploymentTypeSchema,
  deploymentUrl: CloudOrigin,
  id: Id,
  isDefault: Schema.Boolean,
  kind: Schema.Literal("cloud"),
  name: Name,
  projectId: Id,
  reference: Schema.String,
});

export type Deployment = typeof DeploymentSchema.Type;

export interface VerifiedDeployment extends Deployment {
  readonly teamId: number;
  readonly convexCloudUrl: URL;
  readonly convexSiteUrl: URL;
}

export interface BootstrapAuth {
  readonly kind: "team" | "pat";
  readonly token: string;
  readonly teamId: number;
}

const Pagination = Schema.Struct({
  hasMore: Schema.Boolean,
  nextCursor: Schema.optional(Schema.NullOr(Schema.String)),
});

const ProjectsPage = Schema.Struct({ items: Schema.Array(ProjectSchema), pagination: Pagination });
const TokenDetails = Schema.Struct({ teamId: Id, type: Schema.Literal("teamToken") });

const PatPage = Schema.Struct({
  items: Schema.Array(Schema.Struct({ id: Id, name: Schema.String })),
  pagination: Pagination,
});

const Environment = Schema.Struct({
  environmentVariables: Schema.Record(Schema.String, Schema.String),
});

const PreviewPage = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({
      deploymentTypes: Schema.Array(DeploymentTypeSchema),
      name: Schema.String,
      value: Schema.String,
    }),
  ),
  pagination: Pagination,
});

const DeploymentInfo = Schema.Struct({
  deploymentType: DeploymentTypeSchema,
  id: Id,
  kind: Schema.Literal("cloud"),
  projectId: Id,
  teamId: Id,
});

const CanonicalUrls = Schema.Struct({ convexCloudUrl: CloudOrigin, convexSiteUrl: SiteOrigin });

const decode = <A>(schema: Schema.Codec<A, unknown>) =>
  flow(Schema.decodeUnknownEffect(schema), Effect.mapError(invalid));

interface DeploymentCreation {
  type: "dev" | "prod";
  reference?: string;
  isDefault?: boolean;
}

type RequestPayload =
  | { readonly name: string }
  | { readonly projectName: string }
  | { readonly type: "dev" | "prod"; readonly reference?: string; readonly isDefault?: boolean }
  | {
      readonly changes: readonly {
        readonly name: string;
        readonly value: string;
        readonly deploymentType?: "preview";
        readonly applyToExistingDeployments?: false;
      }[];
    };

const request = Effect.fnUntraced(function* request(
  url: string,
  authorization: string,
  body?: RequestPayload,
) {
  const client = yield* HttpClient.HttpClient;

  const base = HttpClientRequest.setHeader(
    body === undefined ? HttpClientRequest.get(url) : HttpClientRequest.post(url),
    "Authorization",
    authorization,
  );

  const outgoing =
    body === undefined
      ? base
      : yield* HttpClientRequest.bodyJson(base, body).pipe(
          Effect.mapError(() => failure("Convex onboarding request failed.")),
        );

  const response = yield* client.execute(outgoing).pipe(
    Effect.timeout("20 seconds"),
    Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
    Effect.mapError(() => failure("Convex onboarding request failed.")),
  );

  if (response.status !== 200) {
    return yield* failure("Convex onboarding request failed.");
  }

  return response;
});

const json = <A>(
  schema: Schema.Codec<A, unknown>,
  response: HttpClientResponse.HttpClientResponse,
) =>
  response.json.pipe(
    Effect.flatMap((input) => decode(schema)(input)),
    Effect.mapError(invalid),
  );

const authHeader = Effect.fnUntraced(function* authHeader(auth: BootstrapAuth) {
  yield* decode(Id)(auth.teamId);
  yield* decode(Token)(auth.token);
  yield* decode(Schema.Literals(["team", "pat"]))(auth.kind);

  return `Bearer ${auth.token}`;
});

export const classifyTeamToken = Effect.fnUntraced(function* classifyTeamToken(
  token: string,
  teamId: number,
): Effect.fn.Return<BootstrapAuth, CliError.UserError, HttpClient.HttpClient> {
  yield* decode(Token)(token);
  yield* decode(Id)(teamId);

  const details = yield* json(
    TokenDetails,
    yield* request(`${management}/token_details`, `Bearer ${token}`),
  );

  if (details.teamId !== teamId) {
    return yield* failure("Convex bootstrap token does not belong to the selected team.");
  }

  return { kind: "team", teamId, token };
});

export const classifySavedPat = Effect.fnUntraced(function* classifySavedPat(
  token: string,
  teamId: number,
): Effect.fn.Return<BootstrapAuth, CliError.UserError, HttpClient.HttpClient> {
  yield* decode(Token)(token);
  yield* decode(Id)(teamId);
  yield* json(
    PatPage,
    yield* request(`${management}/list_personal_access_tokens?limit=1`, `Bearer ${token}`),
  );

  return { kind: "pat", teamId, token };
});

export const listTeams = Effect.fnUntraced(function* listTeams(token: string) {
  yield* classifySavedPat(token, 1);

  // The pinned native Convex CLI uses this account metadata endpoint.
  return yield* json(
    Schema.Array(TeamSchema),
    yield* request("https://api.convex.dev/api/teams", `Bearer ${token}`),
  );
});

export const listProjects = Effect.fnUntraced(function* listProjects(auth: BootstrapAuth) {
  const authorization = yield* authHeader(auth);
  const projects: Project[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;

  for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
    const query = new URLSearchParams({ limit: "100" });

    if (cursor !== undefined) {
      query.set("cursor", cursor);
    }

    const page = yield* json(
      ProjectsPage,
      yield* request(
        `${management}/teams/${auth.teamId}/projects?${query.toString()}`,
        authorization,
      ),
    );

    for (const project of page.items) {
      if (project.teamId !== auth.teamId || some(projects, (item) => item.id === project.id)) {
        return yield* invalid();
      }

      projects.push(project);
    }

    if (!page.pagination.hasMore) {
      return projects;
    }

    const next = page.pagination.nextCursor;

    if (next === undefined || next === null || next === "" || seen.has(next)) {
      return yield* failure("Convex project pagination did not complete safely.");
    }

    seen.add(next);
    cursor = next;
  }

  return yield* failure("Convex project pagination exceeded the supported limit.");
});

export const getProject = Effect.fnUntraced(function* getProject(
  auth: BootstrapAuth,
  projectId: number,
) {
  yield* decode(Id)(projectId);
  const project = findFirst(yield* listProjects(auth), (item) => item.id === projectId);

  if (Option.isNone(project)) {
    return yield* failure("Selected Convex project is not in the selected team.");
  }

  return project.value;
});

export const createProjectTarget = Effect.fnUntraced(function* createProjectTarget(
  auth: BootstrapAuth,
  projectName: string,
) {
  yield* decode(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)))(projectName);

  return yield* json(
    Schema.Struct({ id: Id, slug: Name }),
    yield* request(`${management}/teams/${auth.teamId}/create_project`, yield* authHeader(auth), {
      projectName,
    }),
  );
});

export const createProject = Effect.fnUntraced(function* createProject(
  auth: BootstrapAuth,
  projectName: string,
) {
  const response = yield* createProjectTarget(auth, projectName);

  return yield* getProject(auth, response.id);
});

export const listDeployments = Effect.fnUntraced(function* listDeployments(
  auth: BootstrapAuth,
  projectId: number,
) {
  yield* getProject(auth, projectId);

  const deployments = yield* json(
    Schema.Array(DeploymentSchema),
    yield* request(
      `${management}/projects/${projectId}/list_deployments?includeLocal=false`,
      yield* authHeader(auth),
    ),
  );

  const names = new Set(map(deployments, (item) => item.name));
  const ids = new Set(map(deployments, (item) => item.id));

  if (
    some(deployments, (item) => item.projectId !== projectId) ||
    names.size !== deployments.length ||
    ids.size !== deployments.length
  ) {
    return yield* invalid();
  }

  return deployments;
});

export const getDeployment = Effect.fnUntraced(function* getDeployment(
  auth: BootstrapAuth,
  projectId: number,
  name: string,
) {
  yield* decode(Name)(name);

  const deployment = findFirst(
    yield* listDeployments(auth, projectId),
    (item) => item.name === name,
  );

  if (Option.isNone(deployment)) {
    return yield* failure("Selected Convex deployment is not in the selected project.");
  }

  return deployment.value;
});

export const createDeployment = Effect.fnUntraced(function* createDeployment(
  auth: BootstrapAuth,
  projectId: number,
  type: "dev" | "prod",
  reference?: string,
) {
  yield* decode(Schema.Literals(["dev", "prod"]))(type);

  if (reference !== undefined) {
    yield* decode(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)))(reference);
  }

  yield* getProject(auth, projectId);

  const body: DeploymentCreation = { type };

  if (reference !== undefined) {
    body.reference = reference;
    body.isDefault = false;
  }

  const deployment = yield* json(
    DeploymentSchema,
    yield* request(
      `${management}/projects/${projectId}/create_deployment`,
      yield* authHeader(auth),
      body,
    ),
  );

  if (
    deployment.projectId !== projectId ||
    deployment.deploymentType !== type ||
    (reference !== undefined && deployment.reference !== reference)
  ) {
    return yield* invalid();
  }

  return deployment;
});

export const verifyDeployment = Effect.fnUntraced(function* verifyDeployment(
  auth: BootstrapAuth,
  deployment: Deployment,
): Effect.fn.Return<VerifiedDeployment, CliError.UserError, HttpClient.HttpClient> {
  const selected = yield* getDeployment(auth, deployment.projectId, deployment.name);

  if (
    selected.id !== deployment.id ||
    selected.deploymentType !== deployment.deploymentType ||
    selected.deploymentUrl.origin !== deployment.deploymentUrl.origin
  ) {
    return yield* invalid();
  }

  const authorization = `Convex ${auth.token}`;
  const base = `${selected.deploymentUrl.origin}/api/v1`;

  const info = yield* json(
    DeploymentInfo,
    yield* request(`${base}/deployment_info`, authorization),
  );

  if (
    info.teamId !== auth.teamId ||
    info.projectId !== selected.projectId ||
    info.id !== selected.id ||
    info.deploymentType !== selected.deploymentType
  ) {
    return yield* failure("Convex deployment identity does not match the selected target.");
  }

  const urls = yield* json(
    CanonicalUrls,
    yield* request(`${base}/get_canonical_urls`, authorization),
  );

  if (urls.convexCloudUrl.origin !== selected.deploymentUrl.origin) {
    return yield* invalid();
  }

  return { ...selected, ...urls, teamId: auth.teamId };
});

export const createScopedDeployKey = Effect.fnUntraced(function* createScopedDeployKey(
  auth: BootstrapAuth,
  deployment: VerifiedDeployment,
  name: string,
) {
  yield* decode(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)))(name);
  const selected = yield* verifyDeployment(auth, deployment);

  if (selected.deploymentType !== "dev" && selected.deploymentType !== "prod") {
    return yield* failure("Only development and production scoped keys can be created here.");
  }

  const result = yield* json(
    Schema.Struct({ deployKey: Token }),
    yield* request(
      `${management}/deployments/${selected.name}/create_deploy_key`,
      yield* authHeader(auth),
      { name },
    ),
  );

  const prefix = `${selected.deploymentType}:${selected.name}|`;

  if (
    !result.deployKey.startsWith(prefix) ||
    result.deployKey.length === prefix.length ||
    result.deployKey === auth.token ||
    result.deployKey.slice(prefix.length) === auth.token
  ) {
    return yield* invalid();
  }

  return result.deployKey;
});

export const createProjectPreviewKey = Effect.fnUntraced(function* createProjectPreviewKey(
  auth: BootstrapAuth,
  projectId: number,
  name: string,
) {
  yield* decode(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)))(name);
  const project = yield* getProject(auth, projectId);

  const result = yield* json(
    Schema.Struct({ previewDeployKey: Token }),
    yield* request(
      `${management}/projects/${projectId}/create_preview_deploy_key`,
      yield* authHeader(auth),
      { name },
    ),
  );

  const prefix = `preview:${project.teamSlug}:${project.slug}|`;

  if (
    !result.previewDeployKey.startsWith(prefix) ||
    result.previewDeployKey.length === prefix.length ||
    result.previewDeployKey === auth.token ||
    result.previewDeployKey.slice(prefix.length) === auth.token
  ) {
    return yield* invalid();
  }

  return result.previewDeployKey;
});

export const readDeploymentEnvironment = Effect.fnUntraced(function* readDeploymentEnvironment(
  auth: BootstrapAuth,
  deployment: VerifiedDeployment,
) {
  const selected = yield* verifyDeployment(auth, deployment);

  if (selected.deploymentType !== "dev" && selected.deploymentType !== "prod") {
    return yield* failure("Deployment settings require a development or production target.");
  }

  const result = yield* json(
    Environment,
    yield* request(
      `${selected.deploymentUrl.origin}/api/v1/list_environment_variables`,
      `Convex ${auth.token}`,
    ),
  );

  return result.environmentVariables;
});

export const readDeploymentRecord = Effect.fnUntraced(function* readDeploymentRecord(
  auth: BootstrapAuth,
  deployment: VerifiedDeployment,
  name: string,
) {
  yield* decode(RecordName)(name);
  const values = yield* readDeploymentEnvironment(auth, deployment);
  const value = values[name];

  return value === undefined ? undefined : yield* decode(RecordValue)(value);
});

export const applyMissingDeploymentSettings = Effect.fnUntraced(
  function* applyMissingDeploymentSettings(
    auth: BootstrapAuth,
    deployment: VerifiedDeployment,
    settings: DeploymentSettings,
  ) {
    yield* decode(Schema.Array(SettingName))(Record.keys(settings));
    const values = yield* decode(Settings)(settings);
    const existing = yield* readDeploymentEnvironment(auth, deployment);
    const changes: { name: string; value: string }[] = [];

    for (const [name, value] of Record.toEntries(values)) {
      const current = existing[name];

      // An empty stored value is still an explicit setting and is preserved.
      if (current !== undefined && current !== value) {
        return yield* failure(
          "Existing Convex server settings differ; onboarding will not overwrite them.",
        );
      }

      if (current === undefined) {
        changes.push({ name, value });
      }
    }

    if (changes.length === 0) {
      return yield* Effect.void;
    }

    yield* request(
      `${deployment.deploymentUrl.origin}/api/v1/update_environment_variables`,
      `Convex ${auth.token}`,
      { changes },
    ).pipe(
      Effect.mapError(() =>
        failure("Convex server settings write may be incomplete; recover before retrying."),
      ),
    );

    const recovered = yield* readDeploymentEnvironment(auth, deployment).pipe(
      Effect.mapError(() =>
        failure("Convex server settings write may be incomplete; recover before retrying."),
      ),
    );

    if (some(Record.toEntries(values), ([name, value]) => recovered[name] !== value)) {
      return yield* failure(
        "Convex server settings changed during setup; recover before retrying.",
      );
    }

    return yield* Effect.void;
  },
);

export const readPreviewRecord = Effect.fnUntraced(function* readPreviewRecord(
  auth: BootstrapAuth,
  projectId: number,
  name: string,
) {
  yield* decode(RecordName)(name);
  yield* getProject(auth, projectId);
  const query = new URLSearchParams({ deploymentType: "preview", name });

  const result = yield* json(
    PreviewPage,
    yield* request(
      `${management}/projects/${projectId}/list_default_environment_variables?${query.toString()}`,
      yield* authHeader(auth),
    ),
  );

  if (
    result.pagination.hasMore ||
    result.items.length > 1 ||
    some(
      result.items,
      (item) =>
        item.name !== name ||
        item.deploymentTypes.length !== 1 ||
        item.deploymentTypes[0] !== "preview",
    )
  ) {
    return yield* invalid();
  }

  const value = result.items[0]?.value;

  return value === undefined ? undefined : yield* decode(RecordValue)(value);
});

// These APIs have no compare-and-set operation. Callers must serialize setup;
// the comparisons detect conflicts but cannot guarantee cross-machine exclusion.
export const writeDeploymentRecordIfAbsent = Effect.fnUntraced(
  function* writeDeploymentRecordIfAbsent(
    auth: BootstrapAuth,
    deployment: VerifiedDeployment,
    name: string,
    value: string,
  ) {
    yield* decode(RecordValue)(value);
    const existing = yield* readDeploymentRecord(auth, deployment, name);

    if (existing === value) {
      return "existing";
    }

    if (existing !== undefined) {
      return yield* failure(
        "Convex onboarding recovery record already exists with different contents.",
      );
    }

    yield* request(
      `${deployment.deploymentUrl.origin}/api/v1/update_environment_variables`,
      `Convex ${auth.token}`,
      { changes: [{ name, value }] },
    ).pipe(
      Effect.mapError(() =>
        failure("Convex onboarding recovery write may be incomplete; recover before retrying."),
      ),
    );

    const recovered = yield* readDeploymentRecord(auth, deployment, name).pipe(
      Effect.mapError(() =>
        failure("Convex onboarding recovery write may be incomplete; recover before retrying."),
      ),
    );

    if (recovered !== value) {
      return yield* failure(
        "Convex onboarding recovery record changed during setup; recover before retrying.",
      );
    }

    return "created";
  },
);

export const writePreviewRecordIfAbsent = Effect.fnUntraced(function* writePreviewRecordIfAbsent(
  auth: BootstrapAuth,
  projectId: number,
  name: string,
  value: string,
) {
  yield* decode(RecordValue)(value);
  const existing = yield* readPreviewRecord(auth, projectId, name);

  if (existing === value) {
    return "existing";
  }

  if (existing !== undefined) {
    return yield* failure(
      "Convex onboarding recovery record already exists with different contents.",
    );
  }

  yield* request(
    `${management}/projects/${projectId}/update_default_environment_variables`,
    yield* authHeader(auth),
    { changes: [{ applyToExistingDeployments: false, deploymentType: "preview", name, value }] },
  ).pipe(
    Effect.mapError(() =>
      failure("Convex onboarding recovery write may be incomplete; recover before retrying."),
    ),
  );

  const recovered = yield* readPreviewRecord(auth, projectId, name).pipe(
    Effect.mapError(() =>
      failure("Convex onboarding recovery write may be incomplete; recover before retrying."),
    ),
  );

  if (recovered !== value) {
    return yield* failure(
      "Convex onboarding recovery record changed during setup; recover before retrying.",
    );
  }

  return "created";
});
