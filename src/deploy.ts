import { Array, Config, Console, Effect, FileSystem, Path, Record, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import type { HttpClientResponse } from "effect/http";
import { ChildProcess } from "effect/process";

import { CliError } from "effect/cli";
import { load } from "./environment";

const controlPlane = "https://api.convex.dev";
const callbackMarker = "AFFECT_CONVEX_DEPLOY_CALLBACK";
const callbackCommand = "bunx --no-install affect deploy --build";

const deploymentNames = [
  "CONVEX_DEPLOY_KEY",
  "CONVEX_DEPLOYMENT_TOKEN",
  "CONVEX_DEPLOYMENT",
  "CONVEX_OVERRIDE_ACCESS_TOKEN",
  "CONVEX_SELF_HOSTED_URL",
  "CONVEX_SELF_HOSTED_ADMIN_KEY",
  "CONVEX_AGENT_MODE",
  "CONVEX_PROVISION_HOST",
] as const;

const canonicalNames = ["VITE_CONVEX_URL", "VITE_CONVEX_SITE_URL"] as const;
const publicBuildNames = ["VITE_SITE_URL", "VITE_POSTHOG_HOST", "VITE_POSTHOG_KEY"] as const;

const hostNames = [
  "CI",
  "GITHUB_ACTIONS",
  "VERCEL",
  "VERCEL_TARGET_ENV",
  "NOW_BUILDER",
  "VERCEL_GIT_COMMIT_SHA",
  "VERCEL_URL",
  "VERCEL_BRANCH_URL",
  "VERCEL_PROJECT_PRODUCTION_URL",
] as const;

const optionalSystemNames = ["TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL"] as const;

const proxyNames = [
  "NODE_USE_ENV_PROXY",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
] as const;

const reservedSetting =
  /^(?:CONVEX_|DOTENV_|(?:[A-Z0-9]+_)*PUBLIC_|VITE_|REACT_APP_|EXPO_PUBLIC_|VERCEL_|GITHUB_|NODE_|BUN_|AFFECT_|CI$|PATH$|HOME$|USERPROFILE$|PWD$|SHELL$|ENV$|TMPDIR$|(?:HTTPS?|ALL|NO)_PROXY$)/u;

const failure = (cause: string) => new CliError.UserError({ cause });
const empty = "";

const Origin = Schema.URLFromString.check(
  Schema.makeFilter(
    (url) =>
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === "",
  ),
);

const Id = Schema.Int.check(Schema.isGreaterThan(0));
const Slug = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9_-]*$/u));

const Identity = Schema.Struct({
  project: Slug,
  projectId: Id,
  team: Slug,
  teamId: Id,
});

const Deployment = Schema.Struct({
  deploymentType: Schema.Literals(["dev", "preview", "prod"]),
  id: Id,
  kind: Schema.Literal("cloud"),
  projectId: Id,
  teamId: Id,
});

const CanonicalUrls = Schema.Struct({
  convexCloudUrl: Origin,
  convexSiteUrl: Origin,
});

const PreviewAuthorization = Schema.Struct({
  adminKey: Schema.NonEmptyString,
  deploymentName: Schema.NonEmptyString,
  deploymentType: Schema.Literal("preview"),
  isDefault: Schema.Boolean,
  reference: Schema.NullOr(Schema.String),
  url: Origin,
});

const Declaration = Schema.Record(
  Schema.String,
  Schema.Struct({
    isConvexValidator: Schema.Literal(true),
    isOptional: Schema.Literals(["required", "optional"]),
  }),
);

const RootManifest = Schema.Struct({
  dependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  devDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  scripts: Schema.Record(Schema.String, Schema.String),
  workspaces: Schema.Array(Schema.String),
});

const WebManifest = Schema.Struct({
  dependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  devDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  name: Schema.Literal("@affect/web"),
  scripts: Schema.Record(Schema.String, Schema.String),
});

type Payload =
  | { deployKey: string }
  | {
      previewName: string;
      projectSelection: { kind: "teamAndProjectSlugs"; teamSlug: string; projectSlug: string };
    };

type Target = "preview" | "production";

interface Profile {
  target: Target;
  branch: string;
  deployKey: string;
  inherited: Record<string, string>;
  values: Record<string, string>;
  teamSlug?: string;
  projectSlug?: string;
}

interface VerifiedDeployment {
  cloud: string;
  site: string;
  url: string;
  adminKey: string;
  identity: typeof Identity.Type;
  deploymentName: string;
  deploymentType: "preview" | "prod";
}

const inheritedNames = [
  "PATH",
  "CI",
  "GITHUB_ACTIONS",
  "VERCEL_ENV",
  "VERCEL_GIT_COMMIT_REF",
  "NODE_OPTIONS",
  "BUN_OPTIONS",
  ...deploymentNames,
  ...canonicalNames,
  ...publicBuildNames,
  ...hostNames,
  ...optionalSystemNames,
  ...proxyNames,
] as const;

const readInheritedEnvironment = Effect.fnUntraced(function* readInheritedEnvironment() {
  const inherited: Record<string, string> = {};

  for (const name of inheritedNames) {
    inherited[name] = yield* Config.String(name).pipe(Config.withDefault(empty));
  }

  return inherited;
});

const httpRequest = Effect.fnUntraced(
  function* httpRequest(url: string, authorization: string, body?: Payload) {
    const client = yield* HttpClient.HttpClient;

    const request = HttpClientRequest.setHeader(
      body === undefined ? HttpClientRequest.get(url) : HttpClientRequest.post(url),
      "Authorization",
      authorization,
    );

    const outgoing =
      body === undefined ? request : yield* HttpClientRequest.bodyJson(request, body);

    const response = yield* client.execute(outgoing);

    if (response.status !== 200) {
      return yield* failure("Convex deployment verification failed.");
    }

    return response;
  },
  Effect.mapError(() => failure("Convex deployment verification failed.")),
);

const json = <A>(
  schema: Schema.Codec<A, unknown>,
  response: HttpClientResponse.HttpClientResponse,
) =>
  response.json.pipe(
    Effect.flatMap(Schema.decodeEffect(schema)),
    Effect.mapError(() => failure("Convex deployment returned invalid metadata.")),
  );

const validateDeploymentControls = Effect.fnUntraced(function* validateDeploymentControls(
  values: Record<string, string>,
  inherited: Record<string, string>,
) {
  for (const name of deploymentNames) {
    const configured = values[name] ?? empty;
    const ambient = inherited[name] ?? empty;

    if (name === "CONVEX_DEPLOY_KEY") {
      continue;
    }

    if (name === "CONVEX_PROVISION_HOST") {
      if (
        (configured !== empty && configured !== controlPlane) ||
        (ambient !== empty && ambient !== controlPlane)
      ) {
        return yield* failure("Convex provider host must be the standard Convex control plane.");
      }

      continue;
    }

    if (configured !== empty || ambient !== empty) {
      return yield* failure(
        "Conflicting Convex deployment authentication or target settings are not allowed.",
      );
    }
  }

  return yield* Effect.void;
});

const validateProfileKey = Effect.fnUntraced(function* validateProfileKey(
  target: Target,
  branch: string,
  deployKey: string,
  values: Record<string, string>,
  inherited: Record<string, string>,
) {
  const matchingPrefix = target === "preview" ? "preview:" : "prod:";

  if (!deployKey.startsWith(matchingPrefix)) {
    return yield* failure(
      "Encrypted project file must contain a Convex deploy key matching VERCEL_ENV.",
    );
  }

  if (target === "preview") {
    if (!/^[A-Za-z0-9][A-Za-z0-9_./-]*$/u.test(branch)) {
      return yield* failure("Preview deployment requires a valid branch name.");
    }

    const parts =
      /^preview:(?<team>[a-z0-9][a-z0-9_-]*):(?<project>[a-z0-9][a-z0-9_-]*)\|(?<secret>.+)$/u.exec(
        deployKey,
      );

    const groups = parts?.groups;

    if (
      groups?.["team"] === undefined ||
      groups["project"] === undefined ||
      groups["secret"] === undefined
    ) {
      return yield* failure(
        "Encrypted project file must contain a valid preview-scoped Convex deploy key.",
      );
    }

    return {
      branch,
      deployKey,
      inherited,
      projectSlug: groups["project"],
      target,
      teamSlug: groups["team"],
      values,
    } satisfies Profile;
  }

  if (!/^prod:[a-z0-9][a-z0-9-]*\|.+$/u.test(deployKey)) {
    return yield* failure(
      "Encrypted project file must contain a valid production-scoped Convex deploy key.",
    );
  }

  return { branch, deployKey, inherited, target, values } satisfies Profile;
});

const profile = Effect.fn("Deploy.profile")(function* profile() {
  const { target, values } = yield* load();

  if (target !== "preview" && target !== "production") {
    return yield* failure("Deploy requires VERCEL_ENV=preview or production.");
  }

  const inherited = yield* readInheritedEnvironment();
  const inheritedKey = inherited["CONVEX_DEPLOY_KEY"] ?? empty;
  const deployKey = values["CONVEX_DEPLOY_KEY"] ?? empty;

  if (inheritedKey !== empty && inheritedKey !== deployKey) {
    return yield* failure("CONVEX_DEPLOY_KEY conflicts with the selected encrypted project file.");
  }

  yield* validateDeploymentControls(values, inherited);

  return yield* validateProfileKey(
    target,
    inherited["VERCEL_GIT_COMMIT_REF"] ?? empty,
    deployKey,
    values,
    inherited,
  );
});

const readDeclaration = Effect.fn("Deploy.readDeclaration")(function* readDeclaration(
  root: string,
) {
  const path = yield* Path.Path;
  const declarationPath = path.join(root, "convex", "env.config.ts");

  const imported: unknown = yield* Effect.try({
    catch: () => failure("Cannot load the declaration-only convex/env.config.ts."),
    try: () => {
      const module: unknown = import.meta.require(declarationPath);

      return module;
    },
  });

  const decoded = yield* Schema.decodeUnknownEffect(Schema.Struct({ default: Declaration }))(
    imported,
  ).pipe(
    Effect.mapError(() =>
      failure("Cannot load a valid declaration-only Convex environment definition."),
    ),
  );

  const keys = Record.keys(decoded.default);
  yield* Schema.decodeEffect(
    Schema.Array(Schema.String.check(Schema.makeFilter((name) => !reservedSetting.test(name)))),
  )(keys).pipe(
    Effect.mapError(() =>
      failure("Server declaration contains a credential, control or client-public name."),
    ),
  );

  return decoded.default;
});

const readManifest = Effect.fn("Deploy.readManifest")(function* readManifest<A>(
  root: string,
  relativePath: string,
  schema: Schema.Codec<A, unknown>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const filePath = path.join(root, relativePath);

  const content = yield* fs
    .readFileString(filePath)
    .pipe(
      Effect.mapError(() =>
        failure("The Affect TanStack workspace build contract is unavailable."),
      ),
    );

  const value = yield* Schema.decodeEffect(Schema.fromJsonString(schema))(content).pipe(
    Effect.mapError(() => failure("The Affect TanStack workspace build contract is invalid.")),
  );

  return value;
});

const preflight = Effect.fn("Deploy.preflight")(function* preflight() {
  const path = yield* Path.Path;
  const root = path.resolve(".");

  const [rootManifest, webManifest] = yield* Effect.all([
    readManifest(root, "package.json", RootManifest),
    readManifest(root, "apps/web/package.json", WebManifest),
  ]);

  const dependencies = { ...rootManifest.dependencies, ...rootManifest.devDependencies };
  const webDependencies = { ...webManifest.dependencies, ...webManifest.devDependencies };

  if (
    !Array.contains("apps/*")(rootManifest.workspaces) ||
    rootManifest.scripts["build"] !== "bun run --filter @affect/web build" ||
    dependencies["vite"] === undefined ||
    dependencies["convex"] === undefined ||
    webManifest.scripts["build"] !== "vite build" ||
    webDependencies["@tanstack/react-start"] === undefined ||
    webDependencies["vite"] === undefined
  ) {
    return yield* failure("This CLI requires the Affect TanStack workspace build contract.");
  }

  const declaration = yield* readDeclaration(root);

  return { declaration, root };
});

const selectedBackendSettings = (
  values: Record<string, string>,
  declaration: typeof Declaration.Type,
) =>
  Array.map(
    Array.filter(Record.toEntries(declaration), ([name]) => Record.has(values, name)),
    ([name]) => ({ name, value: values[name] ?? empty }),
  );

const validateRequiredSettings = (
  values: Record<string, string>,
  declaration: typeof Declaration.Type,
) => {
  const required = Array.filter(
    Record.toEntries(declaration),
    ([name, validator]) => validator.isOptional === "required" && !Record.has(values, name),
  );

  if (required.length === 0) {
    return Effect.void;
  }

  const missing: string[] = [];

  for (const [name] of required) {
    missing.push(name);
  }

  return failure(`Missing required server settings: ${Array.join(missing, ", ")}.`);
};

const childProfileCollision = (values: Record<string, string>, required: readonly string[]) => {
  for (const name of required) {
    if (Record.has(values, name)) {
      return true;
    }
  }

  return false;
};

const copyDefined = (
  source: Record<string, string>,
  names: readonly string[],
  values: Record<string, string>,
  into: Record<string, string>,
) => {
  for (const name of names) {
    if (!Record.has(values, name) && source[name] !== empty) {
      into[name] = source[name] ?? empty;
    }
  }
};

const temporaryHome = Effect.fnUntraced(function* temporaryHome(
  prepareMessage: string,
  cleanupMessage: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;

  return yield* Effect.acquireRelease(
    fileSystem
      .makeTempDirectory({ prefix: "affect-cli-home-" })
      .pipe(Effect.mapError(() => failure(prepareMessage))),
    (directory) =>
      fileSystem.remove(directory, { force: true, recursive: true }).pipe(
        Effect.mapError(() => failure(cleanupMessage)),
        Effect.ignore,
      ),
  );
});

const verifiedDeployment = Effect.fn("Deploy.verifyDeployment")(function* verifiedDeployment(
  selected: Profile,
  callbackCloud: URL,
  callbackSite: URL,
) {
  const key = selected.deployKey;

  if (selected.target === "production") {
    const endpoint = yield* json(
      Origin,
      yield* httpRequest(`${controlPlane}/api/deployment/url_for_key`, `Bearer ${key}`, {
        deployKey: key,
      }),
    );

    const deploymentAuthorization = `Convex ${key}`;
    const deploymentName = key.slice("prod:".length).split("|", 1)[0] ?? empty;

    const identity = yield* json(
      Identity,
      yield* httpRequest(
        `${controlPlane}/api/deployment/team_and_project_for_key`,
        `Bearer ${key}`,
        { deployKey: key },
      ),
    );

    const info = yield* json(
      Deployment,
      yield* httpRequest(`${endpoint.origin}/api/v1/deployment_info`, deploymentAuthorization),
    );

    if (
      info.deploymentType !== "prod" ||
      info.teamId !== identity.teamId ||
      info.projectId !== identity.projectId
    ) {
      return yield* failure("Production deploy key and Convex deployment metadata do not match.");
    }

    const canonical = yield* json(
      CanonicalUrls,
      yield* httpRequest(`${endpoint.origin}/api/v1/get_canonical_urls`, deploymentAuthorization),
    );

    if (
      canonical.convexCloudUrl.origin !== endpoint.origin ||
      canonical.convexCloudUrl.origin !== callbackCloud.origin ||
      canonical.convexSiteUrl.origin !== callbackSite.origin
    ) {
      return yield* failure("Native Convex URLs do not match the selected production deployment.");
    }

    return {
      adminKey: key,
      cloud: canonical.convexCloudUrl.origin,
      deploymentName,
      deploymentType: "prod",
      identity,
      site: canonical.convexSiteUrl.origin,
      url: endpoint.origin,
    } satisfies VerifiedDeployment;
  }

  const teamSlugFromKey = selected.teamSlug ?? empty;
  const projectSlugFromKey = selected.projectSlug ?? empty;

  const authorization = yield* json(
    PreviewAuthorization,
    yield* httpRequest(`${controlPlane}/api/deployment/authorize_preview`, `Bearer ${key}`, {
      previewName: selected.branch,
      projectSelection: {
        kind: "teamAndProjectSlugs",
        projectSlug: projectSlugFromKey,
        teamSlug: teamSlugFromKey,
      },
    }),
  );

  const endpoint = authorization.url;
  const deploymentAuthorization = `Convex ${authorization.adminKey}`;
  const { deploymentName } = authorization;

  const info = yield* json(
    Deployment,
    yield* httpRequest(`${endpoint.origin}/api/v1/deployment_info`, deploymentAuthorization),
  );

  if (authorization.deploymentType !== "preview" || info.deploymentType !== "preview") {
    return yield* failure("Preview authorization and Convex deployment metadata do not match.");
  }

  const canonical = yield* json(
    CanonicalUrls,
    yield* httpRequest(`${endpoint.origin}/api/v1/get_canonical_urls`, deploymentAuthorization),
  );

  if (
    canonical.convexCloudUrl.origin !== endpoint.origin ||
    canonical.convexCloudUrl.origin !== callbackCloud.origin ||
    canonical.convexSiteUrl.origin !== callbackSite.origin
  ) {
    return yield* failure("Native Convex URLs do not match the selected preview deployment.");
  }

  return {
    adminKey: authorization.adminKey,
    cloud: canonical.convexCloudUrl.origin,
    deploymentName,
    deploymentType: "preview",
    identity: {
      project: projectSlugFromKey,
      projectId: info.projectId,
      team: teamSlugFromKey,
      teamId: info.teamId,
    },
    site: canonical.convexSiteUrl.origin,
    url: endpoint.origin,
  } satisfies VerifiedDeployment;
});

const buildEnvironment = (
  selected: Profile,
  values: Record<string, string>,
  verified: VerifiedDeployment,
  scratchHome: string,
) => {
  const child: Record<string, string> = {};
  copyDefined(selected.inherited, ["PATH", ...optionalSystemNames], values, child);
  child[process.platform === "win32" ? "USERPROFILE" : "HOME"] = scratchHome;
  child["VERCEL_ENV"] = selected.target;

  if (selected.target === "preview") {
    child["VERCEL_GIT_COMMIT_REF"] = selected.branch;
  }

  copyDefined(selected.inherited, hostNames, values, child);

  for (const name of canonicalNames) {
    child[name] = name === "VITE_CONVEX_URL" ? verified.cloud : verified.site;
  }

  for (const name of publicBuildNames) {
    const profileValue = values[name];
    const inheritedValue = selected.inherited[name] ?? empty;

    if (profileValue !== undefined) {
      child[name] = profileValue;
    } else if (inheritedValue !== empty) {
      child[name] = inheritedValue;
    }
  }

  return child;
};

const syncSettings = Effect.fn("Deploy.syncSettings")(
  function* syncSettings(
    verified: VerifiedDeployment,
    settings: readonly { name: string; value: string }[],
  ) {
    if (settings.length === 0) {
      return yield* Effect.void;
    }

    const client = yield* HttpClient.HttpClient;

    const request = yield* HttpClientRequest.bodyJson(
      HttpClientRequest.setHeader(
        HttpClientRequest.post(`${verified.url}/api/v1/update_environment_variables`),
        "Authorization",
        `Convex ${verified.adminKey}`,
      ),
      { changes: settings },
    );

    const response = yield* client.execute(request);

    if (response.status !== 200) {
      return yield* failure("Could not synchronize Convex environment variables.");
    }

    return yield* Effect.void;
  },
  Effect.mapError(() => failure("Could not synchronize Convex environment variables.")),
);

const runBuildCallback = Effect.fn("Deploy.runBuildCallback")(function* runBuildCallback() {
  const callbackMode = yield* Config.String(callbackMarker).pipe(Config.withDefault(empty));

  if (callbackMode !== "1") {
    return yield* failure("The Convex build callback can only run through affect deploy.");
  }

  const selected = yield* profile();
  const { declaration, root } = yield* preflight();
  yield* validateRequiredSettings(selected.values, declaration);

  const cloudText = yield* Config.NonEmptyString("VITE_CONVEX_URL").pipe(
    Effect.mapError(() => failure("Native Convex did not inject the canonical cloud URL.")),
  );

  const siteText = yield* Config.NonEmptyString("VITE_CONVEX_SITE_URL").pipe(
    Effect.mapError(() => failure("Native Convex did not inject the canonical site URL.")),
  );

  const cloud = yield* Schema.decodeEffect(Origin)(cloudText).pipe(
    Effect.mapError(() => failure("Native Convex injected an invalid cloud URL.")),
  );

  const site = yield* Schema.decodeEffect(Origin)(siteText).pipe(
    Effect.mapError(() => failure("Native Convex injected an invalid site URL.")),
  );

  const verified = yield* verifiedDeployment(selected, cloud, site).pipe(
    Effect.provide(FetchHttpClient.layer),
    Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
  );

  const settings = selectedBackendSettings(selected.values, declaration);
  yield* syncSettings(verified, settings).pipe(
    Effect.provide(FetchHttpClient.layer),
    Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
  );
  yield* Console.error(
    `Convex target: ${verified.identity.team}/${verified.identity.project}; ${verified.deploymentType} ${verified.deploymentName}.`,
  );

  const home = yield* temporaryHome(
    "Could not prepare an isolated build environment.",
    "Could not clean the isolated build environment.",
  );

  const env = buildEnvironment(selected, selected.values, verified, home);

  const child = yield* ChildProcess.make("bun", ["run", "build"], {
    cwd: root,
    env,
    extendEnv: false,
    stderr: "inherit",
    stdin: "inherit",
    stdout: "inherit",
  });

  const status = yield* child.exitCode;

  if (status !== 0) {
    return yield* failure(`bun run build exited with status ${status}.`);
  }

  return yield* Effect.void;
});

const nativeEnvironment = (
  selected: Profile,
  values: Record<string, string>,
  privateKey: string,
  home: string,
) => {
  const env: Record<string, string> = {};

  for (const name of [
    ...hostNames,
    ...optionalSystemNames,
    ...proxyNames,
    "NODE_OPTIONS",
    "BUN_OPTIONS",
  ]) {
    env[name] = empty;
  }

  copyDefined(
    selected.inherited,
    ["PATH", ...optionalSystemNames, ...hostNames, ...proxyNames],
    values,
    env,
  );
  env["VERCEL_ENV"] = selected.target;

  if (selected.target === "preview") {
    env["VERCEL_GIT_COMMIT_REF"] = selected.branch;
  }

  env[process.platform === "win32" ? "USERPROFILE" : "HOME"] = home;
  env["CONVEX_PROVISION_HOST"] = controlPlane;
  env["CONVEX_DEPLOY_KEY"] = selected.deployKey;
  env["DOTENV_PRIVATE_KEY"] = privateKey;
  env[callbackMarker] = "1";

  for (const name of deploymentNames) {
    if (name !== "CONVEX_DEPLOY_KEY" && name !== "CONVEX_PROVISION_HOST") {
      env[name] = empty;
    }
  }

  for (const name of canonicalNames) {
    env[name] = empty;
  }

  for (const name of publicBuildNames) {
    env[name] = values[name] ?? selected.inherited[name] ?? empty;
  }

  return env;
};

const deployNative = Effect.fn("Deploy.native")(function* deployNative(
  selected: Profile,
  values: Record<string, string>,
  root: string,
) {
  const privateKey = yield* Config.NonEmptyString("DOTENV_PRIVATE_KEY").pipe(
    Effect.mapError(() => failure("Set the matching DOTENV_PRIVATE_KEY for the selected profile.")),
  );

  const home = yield* temporaryHome(
    "Could not prepare an isolated Convex configuration home.",
    "Could not clean the isolated Convex configuration home.",
  );

  const env = nativeEnvironment(selected, values, privateKey, home);

  const args = [
    "--no-install",
    "convex",
    "deploy",
    "--cmd-url-env-var-name",
    "VITE_CONVEX_URL",
    ...(selected.target === "preview" ? ["--preview-name", selected.branch] : []),
    "--cmd",
    callbackCommand,
  ];

  const child = yield* ChildProcess.make("bunx", args, {
    cwd: root,
    env,
    extendEnv: false,
    stderr: "inherit",
    stdin: "inherit",
    stdout: "inherit",
  });

  const status = yield* child.exitCode;

  if (status !== 0) {
    return yield* failure(`Convex deploy exited with status ${status}.`);
  }

  return yield* Effect.void;
});

export const deploy = Effect.fn("Deploy.run")(function* deploy(build: boolean) {
  if (build) {
    return yield* runBuildCallback();
  }

  const selected = yield* profile();
  const { declaration } = yield* preflight();
  yield* validateRequiredSettings(selected.values, declaration);

  const requiredCollisions = [
    "PATH",
    "VERCEL_ENV",
    ...(selected.target === "preview" ? ["VERCEL_GIT_COMMIT_REF"] : []),
  ];

  if (childProfileCollision(selected.values, requiredCollisions)) {
    return yield* failure(
      "Encrypted profile conflicts with required deployment environment settings.",
    );
  }

  const path = yield* Path.Path;
  const root = path.resolve(".");
  yield* Console.error(
    `Convex target: ${selected.target}${selected.target === "preview" ? ` (${selected.branch})` : ""}; selected by env/${selected.target}/.env.`,
  );

  return yield* deployNative(selected, selected.values, root);
}, Effect.scoped);
