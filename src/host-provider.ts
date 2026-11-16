import { Array, Effect, Schema } from "effect";
import { CliError } from "effect/cli";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import type { HttpClientResponse } from "effect/http";

const { filter, map } = Array;

const failure = (cause: string) => new CliError.UserError({ cause });

const Identifier = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]+$/u));

const PrivateKey = Schema.String.check(Schema.isPattern(/^[a-fA-F0-9]{64}$/u));

export const HostProfileSchema = Schema.Literals(["development", "preview", "production"]);

export type HostProfile = typeof HostProfileSchema.Type;

export const HostCredentialsSchema = Schema.Struct({
  accountId: Identifier,
  projectId: Schema.String.check(Schema.isPattern(/^prj_[A-Za-z0-9]+$/u)),
  teamId: Schema.optional(Schema.String.check(Schema.isPattern(/^team_[A-Za-z0-9]+$/u))),
  token: Schema.NonEmptyString,
});

export type HostCredentials = typeof HostCredentialsSchema.Type;

export const HostKeyDistributionSchema = Schema.Struct({
  ...HostCredentialsSchema.fields,
  keys: Schema.Struct({
    development: Schema.optional(PrivateKey),
    preview: Schema.optional(PrivateKey),
    production: Schema.optional(PrivateKey),
  }),
});

export type HostKeyDistribution = typeof HostKeyDistributionSchema.Type;

export const HostBuildConfigurationSchema = Schema.Struct({
  ...HostCredentialsSchema.fields,
  adoptBuildCommand: Schema.Literal(true),
});

export type HostBuildConfiguration = typeof HostBuildConfigurationSchema.Type;

export const hostBuildCommand = "cd ../.. && bunx --no-install affect deploy";

const Project = Schema.Struct({
  accountId: Identifier,
  buildCommand: Schema.optional(Schema.NullOr(Schema.String)),
  id: Identifier,
  rootDirectory: Schema.optional(Schema.NullOr(Schema.String)),
  sourceFilesOutsideRootDirectory: Schema.optional(Schema.Boolean),
});

const EnvironmentVariableSchema = Schema.Struct({
  customEnvironmentIds: Schema.optional(Schema.Array(Identifier)),
  decrypted: Schema.optional(Schema.Boolean),
  gitBranch: Schema.optional(Schema.NullOr(Schema.String)),
  id: Schema.optional(Identifier),
  key: Schema.String,
  target: Schema.optional(Schema.ArrayEnsure(HostProfileSchema)),
  type: Schema.Literals(["encrypted", "plain", "secret", "sensitive", "system"]),
  value: Schema.optional(Schema.String),
  visibility: Schema.optional(Schema.Literals(["config", "secret"])),
});

type EnvironmentVariable = typeof EnvironmentVariableSchema.Type;

const EnvironmentList = Schema.Struct({
  envs: Schema.Array(EnvironmentVariableSchema),
  hiddenProductionEnvCount: Schema.optional(Schema.Finite),
  pagination: Schema.optional(Schema.Struct({ next: Schema.NullOr(Schema.Finite) })),
}).check(
  Schema.makeFilter(
    (inventory) =>
      inventory.hiddenProductionEnvCount !== undefined || inventory.pagination !== undefined,
  ),
);

const CreatedEnvironment = Schema.Struct({
  created: Schema.ArrayEnsure(EnvironmentVariableSchema),
  failed: Schema.Array(Schema.Unknown),
});

const endpoint = (credentials: HostCredentials, path: string) =>
  `https://api.vercel.com${path}${credentials.teamId === undefined ? "" : `?teamId=${encodeURIComponent(credentials.teamId)}`}`;

const request = Effect.fnUntraced(
  function* request(
    credentials: HostCredentials,
    method: "GET" | "POST" | "PATCH",
    path: string,
    body?:
      | { buildCommand: string }
      | { key: string; target: readonly HostProfile[]; type: "encrypted"; value: string },
  ) {
    const client = yield* HttpClient.HttpClient;

    const base = HttpClientRequest.setHeader(
      HttpClientRequest.make(method)(endpoint(credentials, path)),
      "Authorization",
      `Bearer ${credentials.token}`,
    );

    const outgoing = body === undefined ? base : yield* HttpClientRequest.bodyJson(base, body);

    const response = yield* client.execute(outgoing).pipe(
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
      Effect.timeout("15 seconds"),
      Effect.mapError(() => failure("Vercel request failed; host settings were not confirmed.")),
    );

    if (response.status < 200 || response.status >= 300) {
      return yield* failure("Vercel request failed; host settings were not confirmed.");
    }

    return response;
  },
  Effect.mapError(() => failure("Vercel request failed; host settings were not confirmed.")),
);

const json = <A>(
  schema: Schema.Codec<A, unknown>,
  response: HttpClientResponse.HttpClientResponse,
) =>
  response.json.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(schema)),
    Effect.mapError(() => failure("Invalid Vercel metadata; host settings were not confirmed.")),
  );

export const verifyHostProject = Effect.fnUntraced(function* verifyHostProject(
  credentials: HostCredentials,
) {
  if (credentials.teamId !== undefined && credentials.teamId !== credentials.accountId) {
    return yield* failure("Vercel team and account identifiers must match.");
  }

  const project = yield* request(credentials, "GET", `/v9/projects/${credentials.projectId}`).pipe(
    Effect.flatMap((response) => json(Project, response)),
  );

  if (project.id !== credentials.projectId || project.accountId !== credentials.accountId) {
    return yield* failure("Vercel project does not match the selected account and project.");
  }

  if (credentials.teamId === undefined) {
    const account = yield* request(credentials, "GET", "/v2/user").pipe(
      Effect.flatMap((response) =>
        json(Schema.Struct({ user: Schema.Struct({ id: Identifier }) }), response),
      ),
    );

    if (account.user.id !== credentials.accountId) {
      return yield* failure("Vercel personal account does not match the selected account.");
    }
  }

  return project;
});

const targets = (variable: EnvironmentVariable) => variable.target ?? [];

const hasProfileScope = (variable: EnvironmentVariable, profile: HostProfile) =>
  targets(variable).length === 1 &&
  targets(variable)[0] === profile &&
  (variable.gitBranch ?? "") === "" &&
  (variable.customEnvironmentIds?.length ?? 0) === 0;

const isRecoverable = (variable: EnvironmentVariable) =>
  variable.visibility !== "secret" && (variable.type === "plain" || variable.type === "encrypted");

const verifyExistingKey = Effect.fnUntraced(function* verifyExistingKey(
  credentials: HostCredentials,
  variable: EnvironmentVariable,
  profile: HostProfile,
  privateKey: string,
) {
  if (
    !hasProfileScope(variable, profile) ||
    variable.id === undefined ||
    !isRecoverable(variable)
  ) {
    return yield* failure(
      "Existing Vercel key has an unverifiable value or conflicting scope; preserved all values.",
    );
  }

  const recovered = yield* request(
    credentials,
    "GET",
    `/v1/projects/${credentials.projectId}/env/${variable.id}`,
  ).pipe(Effect.flatMap((response) => json(EnvironmentVariableSchema, response)));

  if (
    recovered.id !== variable.id ||
    recovered.key !== "DOTENV_PRIVATE_KEY" ||
    !isRecoverable(recovered) ||
    !hasProfileScope(recovered, profile) ||
    (recovered.type === "encrypted" && recovered.decrypted !== true) ||
    recovered.value !== privateKey
  ) {
    return yield* failure("Existing Vercel key could not be matched; preserved all values.");
  }

  return profile;
});

const createKey = Effect.fnUntraced(function* createKey(
  options: HostCredentials,
  profile: HostProfile,
  privateKey: string,
) {
  const result = yield* request(options, "POST", `/v10/projects/${options.projectId}/env`, {
    key: "DOTENV_PRIVATE_KEY",
    target: [profile],
    type: "encrypted",
    value: privateKey,
  }).pipe(Effect.flatMap((response) => json(CreatedEnvironment, response)));

  const [entry] = result.created;

  if (
    result.failed.length !== 0 ||
    result.created.length !== 1 ||
    entry === undefined ||
    entry.key !== "DOTENV_PRIVATE_KEY" ||
    entry.type !== "encrypted" ||
    entry.visibility === "secret" ||
    !hasProfileScope(entry, profile)
  ) {
    return yield* failure(
      "Vercel key creation was not confirmed; preserve local keys and inspect host state before retrying.",
    );
  }

  yield* verifyExistingKey(options, entry, profile, privateKey);

  return profile;
});

const planDistribution = Effect.fnUntraced(function* planDistribution(
  options: HostKeyDistribution,
  profiles: readonly HostProfile[],
  existing: readonly EnvironmentVariable[],
) {
  const pending: { profile: HostProfile; privateKey: string }[] = [];
  const preserved: HostProfile[] = [];

  for (const profile of profiles) {
    const privateKey = options.keys[profile];

    if (privateKey === undefined) {
      return yield* failure("Invalid Vercel key distribution options.");
    }

    const matches = filter(
      existing,
      (variable) => targets(variable).length === 0 || Array.contains(targets(variable), profile),
    );

    if (matches.length > 1) {
      return yield* failure("Existing Vercel keys have conflicting scopes; preserved all values.");
    }

    const [match] = matches;

    if (match === undefined) {
      pending.push({ privateKey, profile });
    } else {
      yield* verifyExistingKey(options, match, profile, privateKey);
      preserved.push(profile);
    }
  }

  return { pending, preserved };
});

export const distributeHostKeys = Effect.fn("Host.distributeKeys")(function* distributeHostKeys(
  input: HostKeyDistribution,
) {
  const options = yield* Schema.decodeEffect(HostKeyDistributionSchema, {
    onExcessProperty: "error",
  })(input).pipe(Effect.mapError(() => failure("Invalid Vercel key distribution options.")));

  const profiles = filter(
    ["development", "preview", "production"] as const,
    (profile) => options.keys[profile] !== undefined,
  );

  const values = map(profiles, (profile) => options.keys[profile]?.toLowerCase());

  if (profiles.length === 0 || Array.dedupe(values).length !== values.length) {
    return yield* failure(
      "Vercel distribution requires distinct private keys for the selected profiles.",
    );
  }

  yield* verifyHostProject(options);

  const listed = yield* request(options, "GET", `/v10/projects/${options.projectId}/env`).pipe(
    Effect.flatMap((response) => json(EnvironmentList, response)),
  );

  if ((listed.hiddenProductionEnvCount ?? 0) !== 0 || (listed.pagination?.next ?? null) !== null) {
    return yield* failure("Vercel environment inventory is incomplete; preserved all values.");
  }

  const existing = filter(listed.envs, (variable) => variable.key === "DOTENV_PRIVATE_KEY");
  const { pending, preserved } = yield* planDistribution(options, profiles, existing);

  const created = yield* Effect.all(
    map(pending, ({ profile, privateKey }) => createKey(options, profile, privateKey)),
    { concurrency: 1 },
  );

  return { created, preserved };
});

export const verifyHostBuildProject = Effect.fnUntraced(function* verifyHostBuildProject(
  credentials: HostCredentials,
) {
  const project = yield* verifyHostProject(credentials);

  if (project.rootDirectory !== "apps/web") {
    return yield* failure(
      "Vercel build adoption requires Root Directory apps/web; preserved the project settings.",
    );
  }

  if (project.sourceFilesOutsideRootDirectory !== true) {
    return yield* failure(
      "Vercel build adoption requires source files outside apps/web; preserved the project settings.",
    );
  }

  if (
    project.buildCommand === undefined ||
    (project.buildCommand !== null &&
      project.buildCommand !== "" &&
      project.buildCommand !== hostBuildCommand)
  ) {
    return yield* failure(
      "Existing Vercel build command is unknown or custom; preserved the project settings.",
    );
  }

  return project;
});

export const configureHostBuild = Effect.fn("Host.configureBuild")(function* configureHostBuild(
  input: HostBuildConfiguration,
) {
  const options = yield* Schema.decodeEffect(HostBuildConfigurationSchema, {
    onExcessProperty: "error",
  })(input).pipe(
    Effect.mapError(() => failure("Explicit Vercel build-command adoption is required.")),
  );

  const project = yield* verifyHostBuildProject(options);

  if (project.buildCommand === hostBuildCommand) {
    return { changed: false };
  }

  const updated = yield* request(options, "PATCH", `/v9/projects/${options.projectId}`, {
    buildCommand: hostBuildCommand,
  }).pipe(Effect.flatMap((response) => json(Project, response)));

  if (
    updated.id !== options.projectId ||
    updated.accountId !== options.accountId ||
    updated.rootDirectory !== "apps/web" ||
    updated.sourceFilesOutsideRootDirectory !== true ||
    updated.buildCommand !== hostBuildCommand
  ) {
    return yield* failure(
      "Vercel build command was not confirmed; inspect host state before retrying.",
    );
  }

  return { changed: true };
});
