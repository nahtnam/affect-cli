import { Config, Console, Effect, FileSystem, Path, Record, Result, Schema } from "effect";
import { filter, filterMap, join, map } from "effect/Array";
import { CliError } from "effect/cli";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import type { HttpClientResponse } from "effect/http";

import { read } from "./environment";

const failure = (cause: string) => new CliError.UserError({ cause });

const reserved =
  /^(?:CONVEX_|DOTENV_|(?:[A-Z0-9]+_)*PUBLIC_|VITE_|REACT_APP_|EXPO_PUBLIC_|VERCEL_|GITHUB_|NODE_|BUN_|AFFECT_|CI$|PATH$|HOME$|PWD$|SHELL$|ENV$|TMPDIR$|(?:HTTPS?|ALL|NO)_PROXY$)/u;

const SettingName = Schema.String.check(Schema.makeFilter((name) => !reserved.test(name)));

const Declaration = Schema.Record(
  Schema.String,
  Schema.Struct({
    isConvexValidator: Schema.Literal(true),
    isOptional: Schema.Literals(["required", "optional"]),
  }),
);

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

const Profile = Schema.Struct({
  CONVEX_DEPLOY_KEY: Schema.String.check(Schema.isPattern(/^dev:[a-z0-9-]+\|.+$/u)),
  VITE_CONVEX_SITE_URL: Origin,
  VITE_CONVEX_URL: Origin,
});

const Slug = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9_-]*$/u));
const Id = Schema.Int.check(Schema.isGreaterThan(0));
const Identity = Schema.Struct({ project: Slug, projectId: Id, team: Slug, teamId: Id });

const Deployment = Schema.Struct({
  deploymentType: Schema.Literal("dev"),
  id: Id,
  kind: Schema.Literal("cloud"),
  projectId: Id,
  teamId: Id,
});

const CanonicalUrls = Schema.Struct({ convexCloudUrl: Origin, convexSiteUrl: Origin });

const Existing = Schema.Struct({
  environmentVariables: Schema.Record(Schema.String, Schema.String),
});

type Payload = { deployKey: string } | { changes: readonly { name: string; value: string }[] };

const request = Effect.fn("DevelopmentEnv.request")(
  function* request(url: string, authorization: string, body?: Payload) {
    const client = yield* HttpClient.HttpClient;

    const base = HttpClientRequest.setHeader(
      body === undefined ? HttpClientRequest.get(url) : HttpClientRequest.post(url),
      "Authorization",
      authorization,
    );

    const outgoing = body === undefined ? base : yield* HttpClientRequest.bodyJson(base, body);
    const response = yield* client.execute(outgoing);

    if (response.status !== 200) {
      return yield* failure("Development environment request failed.");
    }

    return response;
  },
  Effect.mapError(() => failure("Development environment request failed.")),
);

const json = <A>(
  schema: Schema.Codec<A, unknown>,
  response: HttpClientResponse.HttpClientResponse,
) =>
  response.json.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(schema)),
    Effect.mapError(() => failure("Invalid development deployment metadata.")),
  );

export const syncDev = Effect.fn("DevelopmentEnv.sync")(
  function* syncDev(force: boolean) {
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const file = path.resolve("env", "development", ".env");

    if (!(yield* fs.exists(file))) {
      return yield* failure("Missing env/development/.env.");
    }

    yield* Config.NonEmptyString("DOTENV_PRIVATE_KEY").pipe(
      Effect.mapError(() => failure("Set the matching development DOTENV_PRIVATE_KEY.")),
    );
    const values = yield* read(file);

    const profile = yield* Schema.decodeUnknownEffect(Profile)(values).pipe(
      Effect.mapError(() =>
        failure("Development profile requires a dev-scoped key and HTTPS Convex origins."),
      ),
    );

    const name = profile.CONVEX_DEPLOY_KEY.split("|")[0]?.slice(4);

    if (
      (values["CONVEX_DEPLOYMENT"] ?? "") !== "" &&
      values["CONVEX_DEPLOYMENT"] !== `dev:${name}`
    ) {
      return yield* failure("CONVEX_DEPLOYMENT does not match the development key.");
    }

    const declarationModule = yield* Effect.try({
      catch: () => failure("Cannot load the declaration-only convex/env.config.ts."),
      try: () =>
        Schema.decodeUnknownEffect(Schema.Struct({ default: Declaration }))(
          import.meta.require(path.resolve("convex", "env.config.ts")),
        ),
    }).pipe(
      Effect.flatten,
      Effect.mapError(() =>
        failure(
          "Cannot load a valid declaration-only convex/env.config.ts with Convex validators.",
        ),
      ),
    );

    const declaration = declarationModule.default;

    yield* Schema.decodeEffect(Schema.Array(SettingName))(Record.keys(declaration)).pipe(
      Effect.mapError(() =>
        failure("Server declaration contains a credential, control or client-public name."),
      ),
    );

    const entries = Record.toEntries(declaration);

    const missing = filter(
      entries,
      ([key, validator]) => validator.isOptional === "required" && !Record.has(values, key),
    );

    if (missing.length > 0) {
      return yield* failure(
        `Missing required server settings: ${join(
          map(missing, ([key]) => key),
          ", ",
        )}.`,
      );
    }

    const selected = filterMap(entries, ([key]) => {
      const value = Record.has(values, key) ? values[key] : undefined;

      return value === undefined ? Result.failVoid : Result.succeed({ name: key, value });
    });

    const key = profile.CONVEX_DEPLOY_KEY;
    const bearer = `Bearer ${key}`;
    const lookup = { deployKey: key };

    const cloud = yield* json(
      Origin,
      yield* request("https://api.convex.dev/api/deployment/url_for_key", bearer, lookup),
    );

    if (cloud.origin !== profile.VITE_CONVEX_URL.origin) {
      return yield* failure("Development key and public Convex URL do not match.");
    }

    const identity = yield* json(
      Identity,
      yield* request(
        "https://api.convex.dev/api/deployment/team_and_project_for_key",
        bearer,
        lookup,
      ),
    );

    const authorization = `Convex ${key}`;

    const deployment = yield* json(
      Deployment,
      yield* request(`${cloud.origin}/api/v1/deployment_info`, authorization),
    );

    if (deployment.teamId !== identity.teamId || deployment.projectId !== identity.projectId) {
      return yield* failure("Development deployment identity does not match the key.");
    }

    const urls = yield* json(
      CanonicalUrls,
      yield* request(`${cloud.origin}/api/v1/get_canonical_urls`, authorization),
    );

    if (
      urls.convexCloudUrl.origin !== cloud.origin ||
      urls.convexSiteUrl.origin !== profile.VITE_CONVEX_SITE_URL.origin
    ) {
      return yield* failure("Development canonical Convex URLs do not match the profile.");
    }

    yield* Console.error(
      `Convex target: ${identity.team}/${identity.project}; development ${name} (ID ${deployment.id}).`,
    );

    const existing = yield* json(
      Existing,
      yield* request(`${cloud.origin}/api/v1/list_environment_variables`, authorization),
    );

    const changed = filter(
      selected,
      (entry) =>
        !Record.has(existing.environmentVariables, entry.name) ||
        existing.environmentVariables[entry.name] !== entry.value,
    );

    const conflicts = filter(changed, (entry) =>
      Record.has(existing.environmentVariables, entry.name),
    );

    if (!force && conflicts.length > 0) {
      return yield* failure(
        `Existing settings differ: ${join(
          map(conflicts, (entry) => entry.name),
          ", ",
        )}. Use --force to overwrite them.`,
      );
    }

    if (changed.length > 0) {
      yield* request(`${cloud.origin}/api/v1/update_environment_variables`, authorization, {
        changes: changed,
      });
    }

    return yield* Console.log(
      `Development settings: ${changed.length - conflicts.length} added, ${conflicts.length} updated, ${selected.length - changed.length} unchanged.`,
    );
  },
  Effect.provide(FetchHttpClient.layer),
  Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
);
