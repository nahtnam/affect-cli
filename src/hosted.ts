import { filter as filterRecord } from "effect/Record";
import { filter, map, some, findFirst } from "effect/Array";
import {
  Array,
  Config,
  Console,
  Effect,
  FileSystem,
  Option,
  Path,
  Record,
  Schema,
  String,
} from "effect";
import { CliError, Prompt, TerminalCapabilities } from "effect/cli";
import { readDeclaration } from "./deploy";
import { loadBootstrapCredential, saveBootstrapCredential } from "./hosted-auth";
import type { BootstrapCredential } from "./hosted-auth";
import * as Api from "./management";
import { decryptProfile, encryptProfile, PrivateKey, profilePublicKey } from "./profile-crypto";
import * as State from "./hosted-state";
import {
  configureHostBuild,
  distributeHostKeys,
  verifyHostBuildProject,
  verifyHostProject,
} from "./host-provider";
import type { HostCredentials } from "./host-provider";

export interface HostedOptions {
  team: string;
  project: string;
  createProject: string;
  profiles: string;
  siteUrl: string;
  devOrigin: string;
  devDeployment: string;
  prodDeployment: string;
  values: string;
  nonInteractive: boolean;
  vercelProject: string;
  vercelAccount: string;
  vercelTeam: string;
  configureHostBuild: boolean;
  recoverOnly: boolean;
}

export const hostedDefaults: HostedOptions = {
  configureHostBuild: false,
  createProject: "",
  devDeployment: "",
  devOrigin: "",
  nonInteractive: false,
  prodDeployment: "",
  profiles: "",
  project: "",
  recoverOnly: false,
  siteUrl: "",
  team: "",
  values: "",
  vercelAccount: "",
  vercelProject: "",
  vercelTeam: "",
};

const failure = (cause: string) => new CliError.UserError({ cause });
const PositiveId = Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThan(0));
const Settings = Schema.Record(Schema.String, Schema.String);
const profiles = ["development", "preview", "production"] as const;

const parseId = (value: string) =>
  Schema.decodeEffect(PositiveId)(value).pipe(
    Effect.mapError(() => failure("Select a valid explicit Convex team and project.")),
  );

const origin = (value: string) =>
  Schema.decodeEffect(State.Origin)(value).pipe(
    Effect.map((url) => new URL(url).origin),
    Effect.mapError(() => failure("Provide the exact HTTP(S) application origin.")),
  );

const mayPrompt = Effect.fnUntraced(function* mayPrompt(options: HostedOptions) {
  const capabilities = yield* TerminalCapabilities.TerminalCapabilities;
  const ci = yield* Config.String("CI").pipe(Config.withDefault(""));
  const actions = yield* Config.String("GITHUB_ACTIONS").pipe(Config.withDefault(""));

  return capabilities.canPrompt && !options.nonInteractive && ci !== "true" && actions !== "true";
});

const selectedProfiles = Effect.fnUntraced(function* selectedProfiles(
  options: HostedOptions,
  binding?: State.Binding,
) {
  if (options.profiles !== "") {
    const requested = String.split(",")(options.profiles);

    const decoded = yield* Schema.decodeUnknownEffect(Schema.Array(State.ProfileNameSchema))(
      requested,
    ).pipe(
      Effect.mapError(() => failure("Select profiles development,preview,production explicitly.")),
    );

    if (decoded.length === 0 || Array.dedupe(decoded).length !== decoded.length) {
      return yield* failure("Select each environment profile once.");
    }

    return filter(profiles, (profile) => decoded.includes(profile));
  }

  if (binding !== undefined) {
    return binding.profiles;
  }

  if (!(yield* mayPrompt(options))) {
    return yield* failure("First noninteractive onboarding requires --profiles.");
  }

  return yield* Prompt.MultiSelect({
    choices: map(profiles, (profile) => ({
      selected: profile !== "production",
      title: profile,
      value: profile,
    })),
    message: "Environments to configure",
    min: 1,
  });
});

const selectTeam = Effect.fnUntraced(function* selectTeam(
  options: HostedOptions,
  credential: BootstrapCredential,
  binding?: State.Binding,
) {
  let teamId =
    options.team === "" ? (binding?.teamId ?? credential.teamId) : yield* parseId(options.team);

  if (teamId === undefined) {
    if (!(yield* mayPrompt(options))) {
      return yield* failure("First noninteractive onboarding requires --team.");
    }

    if (credential.kind === "pat") {
      const teams = yield* Api.listTeams(credential.token);

      if (teams.length === 0) {
        return yield* failure("The saved Convex account has no available team.");
      }

      teamId = yield* Prompt.Select({
        choices: map(teams, (team) => ({
          title: `${team.name} (${team.id})`,
          value: team.id,
        })),
        message: "Convex team",
      });
    } else {
      teamId = yield* parseId(yield* Prompt.String({ message: "Convex team ID" }));
    }
  }

  return teamId;
});

const selectTarget = Effect.fnUntraced(function* selectTarget(
  options: HostedOptions,
  binding?: State.Binding,
) {
  const credential = yield* loadBootstrapCredential();

  const teamId = yield* selectTeam(options, credential, binding);
  let { createProject } = options;

  if (binding !== undefined && binding.teamId !== teamId) {
    return yield* failure("Existing project binding belongs to a different team.");
  }

  const auth =
    credential.kind === "pat"
      ? yield* Api.classifySavedPat(credential.token, teamId)
      : yield* Api.classifyTeamToken(credential.token, teamId);

  if (options.createProject !== "" && (options.project !== "" || options.recoverOnly)) {
    return yield* failure(
      "Project creation cannot replace an existing or explicitly selected project.",
    );
  }

  let projectId = options.project === "" ? binding?.projectId : yield* parseId(options.project);

  if (projectId !== undefined && binding !== undefined && projectId !== binding.projectId) {
    return yield* failure("Existing project binding belongs to a different project.");
  }

  if (projectId === undefined && options.createProject === "") {
    if (!(yield* mayPrompt(options))) {
      return yield* failure(
        "First noninteractive onboarding requires --project or --create-project.",
      );
    }

    const projects = yield* Api.listProjects(auth);

    const choice = yield* Prompt.Select({
      choices: [
        ...map(projects, (project) => ({
          title: `${project.name} (${project.id})`,
          value: project.id,
        })),
        { title: "Create a new project", value: 0 },
      ],
      message: "Convex project",
    });

    if (choice === 0) {
      createProject = yield* Prompt.String({ message: "New project name" });
    } else {
      projectId = choice;
    }
  }

  return { auth, createProject, credential, projectId };
});

const selectDeployment = Effect.fnUntraced(function* selectDeployment(
  options: HostedOptions,
  auth: Api.BootstrapAuth,
  projectId: number,
  profile: "development" | "production",
  binding?: State.Binding,
) {
  const type = profile === "development" ? "dev" : "prod";
  const requested = profile === "development" ? options.devDeployment : options.prodDeployment;

  const configured =
    profile === "development" ? binding?.developmentDeployment : binding?.productionDeployment;

  if (requested !== "" && configured !== undefined && requested !== configured) {
    return yield* failure("Existing deployment binding differs; explicit recovery required.");
  }

  const selected = requested || configured;

  if (selected !== undefined && selected !== "") {
    const deployment = yield* Api.getDeployment(auth, projectId, selected);

    if (deployment.deploymentType !== type) {
      return yield* failure("Selected deployment has the wrong environment scope.");
    }

    return deployment;
  }

  const candidates = filter(
    yield* Api.listDeployments(auth, projectId),
    (deployment) => deployment.deploymentType === type,
  );

  if (candidates.length === 0) {
    return Option.getOrUndefined(Option.none<Api.Deployment>());
  }

  if (candidates.length === 1) {
    return candidates[0];
  }

  if (!(yield* mayPrompt(options))) {
    return yield* failure(
      "Multiple deployments exist; select --dev-deployment or --prod-deployment explicitly.",
    );
  }

  return yield* Prompt.Select({
    choices: map(candidates, (deployment) => ({ title: deployment.name, value: deployment })),
    message: `Convex ${profile} deployment`,
  });
});

const validateRecord = Effect.fnUntraced(function* validateRecord(
  source: string,
  binding: State.Binding,
  profile: State.ProfileName,
  deployment?: Api.Deployment,
) {
  const record = yield* State.decodeJson(State.CustodySchema, source);

  if (
    record.teamId !== binding.teamId ||
    record.projectId !== binding.projectId ||
    record.profile !== profile ||
    (profile !== "preview" && record.deploymentName !== deployment?.name)
  ) {
    return yield* failure("Recovery record does not match the selected environment.");
  }

  const values = yield* decryptProfile(record.source, record.privateKey);

  if (record.publicKey !== (yield* profilePublicKey(record.privateKey))) {
    return yield* failure("Recovery public key does not match its encrypted profile.");
  }

  const expected =
    profile === "preview"
      ? `preview:${binding.teamSlug}:${binding.projectSlug}|`
      : `${profile === "production" ? "prod" : "dev"}:${deployment?.name}|`;

  if (!record.deployKey.startsWith(expected) || values["CONVEX_DEPLOY_KEY"] !== record.deployKey) {
    return yield* failure("Recovery credential does not match the selected environment.");
  }

  return { record, values };
});

const localKey = Effect.fnUntraced(function* localKey(local: {
  source: string | undefined;
  privateKey: string | undefined;
}) {
  if (local.source === undefined) {
    return local.privateKey;
  }

  const supplied = yield* Config.String("DOTENV_PRIVATE_KEY").pipe(Config.withDefault(""));
  const key = local.privateKey ?? (Schema.is(PrivateKey)(supplied) ? supplied : undefined);

  if (key === undefined) {
    return Option.getOrUndefined(Option.none<string>());
  }

  const decoded = yield* Effect.result(decryptProfile(local.source, key));

  if (decoded._tag === "Failure") {
    return Option.getOrUndefined(Option.none<string>());
  }

  return key;
});

const readRecoveryRecord = Effect.fnUntraced(function* readRecoveryRecord(
  profile: State.ProfileName,
  auth: Api.BootstrapAuth,
  projectId: number,
  verified?: Api.VerifiedDeployment,
) {
  if (profile === "preview") {
    return yield* Api.readPreviewRecord(auth, projectId, State.recordName);
  }

  if (verified === undefined) {
    return Option.getOrUndefined(Option.none<string>());
  }

  return yield* Api.readDeploymentRecord(auth, verified, State.recordName);
});

const profilePlan = Effect.fnUntraced(function* profilePlan(
  root: string,
  binding: State.Binding,
  profile: State.ProfileName,
  auth: Api.BootstrapAuth,
  deployment?: Api.Deployment,
) {
  const path = yield* Path.Path;
  const directory = yield* State.stateDirectory(root);
  const journal = path.join(directory, `${profile}.json`);
  const local = yield* State.readProfile(root, profile);
  const pending = yield* State.readOptional(journal, true);

  const verified =
    deployment === undefined ? undefined : yield* Api.verifyDeployment(auth, deployment);

  const remote = yield* readRecoveryRecord(profile, auth, binding.projectId, verified);

  if (pending !== undefined && remote !== undefined && pending.trim() !== remote.trim()) {
    return yield* failure("Local and remote recovery records conflict; preserved both.");
  }

  const stored = remote ?? pending;

  const recovered =
    stored === undefined ? undefined : yield* validateRecord(stored, binding, profile, deployment);

  if (
    local.privateKey !== undefined &&
    recovered !== undefined &&
    local.privateKey.toLowerCase() !== recovered.record.privateKey.toLowerCase()
  ) {
    return yield* failure("Local and remote profile keys conflict; preserved both.");
  }

  if (
    local.source !== undefined &&
    recovered !== undefined &&
    local.source !== recovered.record.source
  ) {
    return yield* failure("Local profile differs from its recovery record; preserved both.");
  }

  const existingKey = recovered?.record.privateKey ?? (yield* localKey(local));

  if (local.source !== undefined && existingKey === undefined) {
    return yield* failure(
      "Existing ciphertext has no recoverable matching key; no credentials were generated.",
    );
  }

  const key = existingKey ?? (yield* encryptProfile({})).privateKey;

  const existingValues =
    local.source === undefined ? undefined : yield* decryptProfile(local.source, key);

  return { deployment, existingValues, journal, key, local, profile, recovered, remote, verified };
});

const inputSettings = Effect.fnUntraced(function* inputSettings(
  root: string,
  options: HostedOptions,
  token: string,
) {
  const path = yield* Path.Path;

  if (options.values === "") {
    return {};
  }

  const source = yield* State.readOptional(path.resolve(root, options.values), true);

  if (source === undefined) {
    return yield* failure("The private settings JSON file is unavailable.");
  }

  const values = yield* State.decodeJson(Settings, source);

  const unsafe = some(
    Record.toEntries(values),
    ([name, value]) =>
      /^(?:DOTENV_|CONVEX_|AFFECT_|VERCEL_|CI$|PATH$)/u.test(name) || value.includes(token),
  );

  if (unsafe) {
    return yield* failure(
      "Provider controls and bootstrap credentials cannot be profile settings.",
    );
  }

  return values;
});

type ProfilePlan = Effect.Success<ReturnType<typeof profilePlan>>;

type Target = Effect.Success<ReturnType<typeof selectTarget>>;

type Declaration = Effect.Success<ReturnType<typeof readDeclaration>>;

interface Workflow {
  root: string;
  options: HostedOptions;
  existing: State.Binding | undefined;
  selected: readonly State.ProfileName[];
  target: Target;
  settings: Record<string, string>;
  declaration: Declaration;
  allowed: ReadonlySet<string>;
  site: string;
  developmentOrigin: string;
  host: HostCredentials | undefined;
}

interface Prepared {
  workflow: Workflow;
  project: Api.Project;
  binding: State.Binding;
  plans: ProfilePlan[];
}

interface ProfileKeys {
  development?: string;
  preview?: string;
  production?: string;
}

const assertDistinctKeys = (keys: readonly string[]) => {
  const normalized = map(keys, (key) => key.toLowerCase());

  return Array.dedupe(normalized).length === normalized.length
    ? Effect.void
    : failure(
        "Environment profiles must use distinct private keys; preserved existing credentials.",
      );
};

const validateLocalKeys = Effect.fnUntraced(function* validateLocalKeys(
  root: string,
  selected: readonly State.ProfileName[],
) {
  const keys: string[] = [];

  for (const profile of selected) {
    const local = yield* State.readProfile(root, profile);
    const key = yield* localKey(local);

    if (key !== undefined) {
      keys.push(key);
    }
  }

  yield* assertDistinctKeys(keys);

  return keys;
});

const selectedHost = Effect.fnUntraced(function* selectedHost(
  options: HostedOptions,
  existing?: State.Binding,
) {
  const requested =
    options.vercelProject !== "" ||
    options.vercelAccount !== "" ||
    options.vercelTeam !== "" ||
    options.configureHostBuild;

  if (!requested) {
    return Option.getOrUndefined(Option.none<HostCredentials>());
  }

  const token = yield* Config.String("VERCEL_TOKEN").pipe(Config.withDefault(""));

  if (token === "" || options.vercelProject === "" || options.vercelAccount === "") {
    return yield* failure(
      "Vercel delivery requires its separate credential and explicit account/project identifiers.",
    );
  }

  let host: HostCredentials = {
    accountId: options.vercelAccount,
    projectId: options.vercelProject,
    token,
  };

  if (options.vercelTeam !== "") {
    host = { ...host, teamId: options.vercelTeam };
  }

  if (
    existing?.vercel !== undefined &&
    (existing.vercel.accountId !== host.accountId ||
      existing.vercel.projectId !== host.projectId ||
      existing.vercel.teamId !== host.teamId)
  ) {
    return yield* failure("Existing host project binding differs; explicit recovery required.");
  }

  yield* options.configureHostBuild ? verifyHostBuildProject(host) : verifyHostProject(host);

  return host;
});

const workflow = Effect.fnUntraced(function* workflow(root: string, options: HostedOptions) {
  const existing = yield* State.readBinding(root);
  const selected = yield* selectedProfiles(options, existing);

  const requireDevelopment = yield* Config.String("AFFECT_REQUIRE_DEVELOPMENT").pipe(
    Config.withDefault(""),
  );

  if (requireDevelopment === "1" && !selected.includes("development")) {
    return yield* failure(
      "Hosted clone setup requires development in --profiles; use affect env init directly for other selections.",
    );
  }

  const target = yield* selectTarget(options, existing);
  const settings = yield* inputSettings(root, options, target.auth.token);
  const declaration = yield* readDeclaration(root);
  const allowed = new Set([...Record.keys(declaration.declaration), ...declaration.publicEnv]);

  if (some(Record.keys(settings), (name) => !allowed.has(name))) {
    return yield* failure(
      "Settings JSON contains a name outside the native Convex/public declarations.",
    );
  }

  let siteInput = options.siteUrl || (existing?.siteUrl ?? "");

  if (siteInput === "" && (yield* mayPrompt(options))) {
    siteInput = yield* Prompt.String({ message: "Application HTTP(S) origin" });
  }

  const site = yield* origin(siteInput);

  const developmentOrigin = yield* origin(
    options.devOrigin || (existing?.developmentOrigin ?? "http://localhost:3000"),
  );

  if (
    existing !== undefined &&
    (site !== existing.siteUrl ||
      developmentOrigin !== existing.developmentOrigin ||
      some(existing.profiles, (profile) => !selected.includes(profile)))
  ) {
    return yield* failure(
      "Existing origin or profile selection differs; explicit configuration change required.",
    );
  }

  const host = yield* selectedHost(options, existing);
  yield* validateLocalKeys(root, profiles);

  return {
    allowed,
    declaration,
    developmentOrigin,
    existing,
    host,
    options,
    root,
    selected,
    settings,
    site,
    target,
  } satisfies Workflow;
});

const verifyPendingProject = Effect.fnUntraced(function* verifyPendingProject(
  context: Workflow,
  pending: State.PendingProject,
) {
  const { target } = context;

  if (
    pending.teamId !== target.auth.teamId ||
    (target.projectId !== undefined && target.projectId !== pending.projectId) ||
    (target.createProject !== "" && target.createProject !== pending.createProject)
  ) {
    return yield* failure(
      "Pending project creation belongs to a different explicit target or creation intent.",
    );
  }

  if (pending.projectId === undefined || pending.projectSlug === undefined) {
    return yield* failure(
      "Project creation may have completed; explicit recovery is required before retrying.",
    );
  }

  const project = yield* Api.getProject(target.auth, pending.projectId);

  if (
    project.id !== pending.projectId ||
    project.slug !== pending.projectSlug ||
    project.teamId !== pending.teamId
  ) {
    return yield* failure("Pending project creation does not match verified Convex metadata.");
  }

  return project;
});

const selectedProject = Effect.fnUntraced(function* selectedProject(context: Workflow) {
  const { options, root, selected, target } = context;
  const pending = yield* State.readPendingProject(root);

  if (pending !== undefined) {
    const project = yield* verifyPendingProject(context, pending.record);

    return { pendingSource: pending.source, project };
  }

  if (target.projectId !== undefined) {
    const project = yield* Api.getProject(target.auth, target.projectId);

    if (
      options.createProject !== "" &&
      project.name !== options.createProject &&
      project.slug !== options.createProject
    ) {
      return yield* failure("Existing bound project does not match the requested creation intent.");
    }

    return { pendingSource: undefined, project };
  }

  if (options.recoverOnly) {
    return yield* failure("Recovery requires an existing project binding.");
  }

  for (const profile of selected) {
    if ((yield* State.readProfile(root, profile)).source !== undefined) {
      return yield* failure("Existing ciphertext cannot be rebound to a new project.");
    }
  }

  if (
    some(
      yield* Api.listProjects(target.auth),
      (project) => project.name === target.createProject || project.slug === target.createProject,
    )
  ) {
    return yield* failure(
      "A project with that name already exists; select its explicit project ID instead of creating another.",
    );
  }

  const intent: State.PendingProject = {
    createProject: target.createProject,
    teamId: target.auth.teamId,
    version: 1,
  };

  const intentSource = yield* State.writePendingProject(root, intent);
  const created = yield* Api.createProjectTarget(target.auth, target.createProject);

  const createdPending: State.PendingProject = {
    ...intent,
    projectId: created.id,
    projectSlug: created.slug,
  };

  const pendingSource = yield* State.writePendingProject(root, createdPending, intentSource);
  const project = yield* verifyPendingProject(context, createdPending);

  return { pendingSource, project };
});

const validateScopedValues = Effect.fnUntraced(function* validateScopedValues(
  values: Record<string, string>,
  binding: State.Binding,
  profile: State.ProfileName,
  verified?: Api.VerifiedDeployment,
) {
  const key = values["CONVEX_DEPLOY_KEY"];

  if (key !== undefined) {
    const prefix =
      profile === "preview"
        ? `preview:${binding.teamSlug}:${binding.projectSlug}|`
        : `${profile === "production" ? "prod" : "dev"}:${verified?.name}|`;

    const ScopedKey = Schema.NonEmptyString.check(
      Schema.makeFilter(
        (value) => value.startsWith(prefix) && value.length > prefix.length && !/\s/u.test(value),
      ),
    );

    yield* Schema.decodeEffect(ScopedKey)(key).pipe(
      Effect.mapError(() => failure("Profile credential does not match the selected environment.")),
    );
  }

  if (
    verified !== undefined &&
    ((values["VITE_CONVEX_URL"] !== undefined &&
      values["VITE_CONVEX_URL"] !== verified.convexCloudUrl.origin) ||
      (values["VITE_CONVEX_SITE_URL"] !== undefined &&
        values["VITE_CONVEX_SITE_URL"] !== verified.convexSiteUrl.origin))
  ) {
    return yield* failure(
      "Existing profile URLs do not match the selected deployment; preserved configuration.",
    );
  }

  return yield* Effect.void;
});

const validateProvisioningTokens = (values: Record<string, string>, context: Workflow) => {
  const unsafe = some(
    Record.toEntries(values),
    ([name, value]) =>
      /^(?:CONVEX_(?!DEPLOY_KEY$)|AFFECT_|VERCEL_|DOTENV_)/u.test(name) ||
      value.includes(context.target.auth.token) ||
      (context.host !== undefined && value.includes(context.host.token)),
  );

  return unsafe
    ? failure("A provisioning credential cannot be stored in an application profile.")
    : Effect.void;
};

const prepare = Effect.fnUntraced(function* prepare(context: Workflow) {
  const { existing, options, root, selected, target } = context;
  const { project, pendingSource } = yield* selectedProject(context);

  let binding: State.Binding = {
    developmentOrigin: context.developmentOrigin,
    profiles: selected,
    projectId: project.id,
    projectSlug: project.slug,
    siteUrl: context.site,
    teamId: target.auth.teamId,
    teamSlug: project.teamSlug,
    version: 1,
  };

  if (target.projectId === undefined) {
    yield* State.publishBinding(root, binding);
    yield* State.clearPendingProject(root, pendingSource);
  }

  const deployments: Partial<Record<State.ProfileName, Api.Deployment>> = {};

  if (selected.includes("development")) {
    const deployment = yield* selectDeployment(
      options,
      target.auth,
      project.id,
      "development",
      existing,
    );

    if (deployment !== undefined) {
      deployments.development = deployment;
    }
  }

  if (selected.includes("production")) {
    const deployment = yield* selectDeployment(
      options,
      target.auth,
      project.id,
      "production",
      existing,
    );

    if (deployment !== undefined) {
      deployments.production = deployment;
    }
  }

  if (deployments.development !== undefined) {
    binding = { ...binding, developmentDeployment: deployments.development.name };
  }

  if (deployments.production !== undefined) {
    binding = { ...binding, productionDeployment: deployments.production.name };
  }

  if (existing?.vercel !== undefined) {
    binding = { ...binding, vercel: existing.vercel };
  }

  if (context.host !== undefined) {
    let vercel: NonNullable<State.Binding["vercel"]> = {
      accountId: context.host.accountId,
      projectId: context.host.projectId,
    };

    if (context.host.teamId !== undefined) {
      vercel = { ...vercel, teamId: context.host.teamId };
    }

    binding = { ...binding, vercel };
  }

  const plans: ProfilePlan[] = [];

  for (const profile of selected) {
    plans.push(yield* profilePlan(root, binding, profile, target.auth, deployments[profile]));
  }

  if (options.recoverOnly && some(plans, (plan) => plan.recovered === undefined)) {
    return yield* failure(
      "No complete remote recovery record exists; no credentials were generated.",
    );
  }

  const unselectedKeys = yield* validateLocalKeys(
    root,
    filter(profiles, (profile) => !selected.includes(profile)),
  );

  yield* assertDistinctKeys([...map(plans, (plan) => plan.key), ...unselectedKeys]);

  for (const plan of plans) {
    const values = plan.recovered?.values ?? plan.existingValues ?? {};
    yield* validateProvisioningTokens(values, context);
    yield* validateScopedValues(values, binding, plan.profile, plan.verified);
  }

  yield* State.publishBinding(root, binding);
  yield* State.clearPendingProject(root, pendingSource);
  yield* saveBootstrapCredential(
    target.credential.kind === "team"
      ? { ...target.credential, teamId: target.auth.teamId }
      : target.credential,
  );

  return { binding, plans, project, workflow: context } satisfies Prepared;
});

const ensureDeployment = Effect.fnUntraced(function* ensureDeployment(
  plan: ProfilePlan,
  prepared: Prepared,
) {
  if (plan.verified !== undefined || plan.profile === "preview") {
    return plan.verified;
  }

  const { options, root, target } = prepared.workflow;

  if (options.recoverOnly) {
    return yield* failure("Recovery requires an existing deployment and recovery record.");
  }

  const created = yield* Api.createDeployment(
    target.auth,
    prepared.project.id,
    plan.profile === "production" ? "prod" : "dev",
    `affect-${plan.profile}`,
  );

  const verified = yield* Api.verifyDeployment(target.auth, created);
  prepared.binding =
    plan.profile === "development"
      ? { ...prepared.binding, developmentDeployment: created.name }
      : { ...prepared.binding, productionDeployment: created.name };
  yield* State.publishBinding(root, prepared.binding);

  return verified;
});

const writeRemoteRecord = Effect.fnUntraced(function* writeRemoteRecord(
  record: State.Custody,
  prepared: Prepared,
  verified?: Api.VerifiedDeployment,
) {
  const { target } = prepared.workflow;
  const source = yield* Schema.encodeEffect(Schema.fromJsonString(State.CustodySchema))(record);

  if (record.profile === "preview") {
    yield* Api.writePreviewRecordIfAbsent(
      target.auth,
      prepared.project.id,
      State.recordName,
      source,
    );
  } else if (verified !== undefined) {
    yield* Api.writeDeploymentRecordIfAbsent(target.auth, verified, State.recordName, source);
  }
});

const profileValues = Effect.fnUntraced(function* profileValues(
  plan: ProfilePlan,
  context: Workflow,
  verified?: Api.VerifiedDeployment,
) {
  const backend =
    verified === undefined
      ? {}
      : yield* Api.readDeploymentEnvironment(context.target.auth, verified);

  const selectedOrigin = plan.profile === "development" ? context.developmentOrigin : context.site;
  const { privateKey: generatedSecret } = yield* encryptProfile({});

  const values: Record<string, string> = {
    BETTER_AUTH_SECRET: backend["BETTER_AUTH_SECRET"] ?? generatedSecret,
    CLOUDFLARE_ACCOUNT_ID: backend["CLOUDFLARE_ACCOUNT_ID"] ?? "",
    CLOUDFLARE_API_TOKEN: backend["CLOUDFLARE_API_TOKEN"] ?? "",
    EMAIL_FROM: backend["EMAIL_FROM"] ?? "",
    POSTHOG_PROJECT_TOKEN: backend["POSTHOG_PROJECT_TOKEN"] ?? "",
    SITE_URL: backend["SITE_URL"] ?? selectedOrigin,
    TRUSTED_ORIGINS: backend["TRUSTED_ORIGINS"] ?? selectedOrigin,
    ...filterRecord(backend, (_value, name) => context.allowed.has(name)),
    ...context.settings,
    ...plan.existingValues,
  };

  yield* validateProvisioningTokens(values, context);

  for (const [name, definition] of Record.toEntries(context.declaration.declaration)) {
    if (definition.isOptional === "required" && values[name] === undefined) {
      return yield* failure(`Required provider setting is missing: ${name}.`);
    }
  }

  for (const [name, value] of Record.toEntries(context.settings)) {
    if (plan.existingValues?.[name] !== undefined && plan.existingValues[name] !== value) {
      return yield* failure("Existing profile settings differ; preserved all configuration.");
    }
  }

  values["VITE_SITE_URL"] ??= values["SITE_URL"] ?? selectedOrigin;

  return values;
});

const deployKey = Effect.fnUntraced(function* deployKey(
  plan: ProfilePlan,
  prepared: Prepared,
  values: Record<string, string>,
  verified?: Api.VerifiedDeployment,
) {
  const existing = values["CONVEX_DEPLOY_KEY"];

  if (existing !== undefined) {
    return existing;
  }

  if (plan.profile === "preview") {
    return yield* Api.createProjectPreviewKey(
      prepared.workflow.target.auth,
      prepared.project.id,
      "affect:preview",
    );
  }

  if (verified === undefined) {
    return yield* failure("A scoped deploy key requires its verified deployment.");
  }

  return yield* Api.createScopedDeployKey(
    prepared.workflow.target.auth,
    verified,
    `affect:${plan.profile}`,
  );
});

const completePlan = Effect.fnUntraced(function* completePlan(
  plan: ProfilePlan,
  prepared: Prepared,
) {
  const context = prepared.workflow;
  const verified = yield* ensureDeployment(plan, prepared);

  if (plan.recovered !== undefined) {
    if (!context.options.recoverOnly) {
      if (plan.remote === undefined) {
        yield* writeRemoteRecord(plan.recovered.record, prepared, verified);
      }

      if (verified !== undefined) {
        yield* Api.applyMissingDeploymentSettings(
          context.target.auth,
          verified,
          filterRecord(plan.recovered.values, (_value, name) =>
            Record.has(context.declaration.declaration, name),
          ),
        );
      }
    }

    return plan.recovered.record;
  }

  const values = yield* profileValues(plan, context, verified);
  const key = yield* deployKey(plan, prepared, values, verified);
  values["CONVEX_DEPLOY_KEY"] = key;
  yield* validateScopedValues(values, prepared.binding, plan.profile, verified);
  yield* validateProvisioningTokens(values, context);

  if (verified !== undefined) {
    values["VITE_CONVEX_URL"] ??= verified.convexCloudUrl.origin;
    values["VITE_CONVEX_SITE_URL"] ??= verified.convexSiteUrl.origin;
  }

  const encrypted = yield* encryptProfile(values, plan.key);

  let record: State.Custody = {
    ...encrypted,
    deployKey: key,
    profile: plan.profile,
    projectId: prepared.project.id,
    teamId: context.target.auth.teamId,
    version: 1,
  };

  if (verified !== undefined) {
    record = { ...record, deploymentName: verified.name };
  }

  const source = yield* Schema.encodeEffect(Schema.fromJsonString(State.CustodySchema))(record);
  yield* State.writePreserving(plan.journal, `${source}\n`, true);
  yield* writeRemoteRecord(record, prepared, verified);

  if (verified !== undefined) {
    yield* Api.applyMissingDeploymentSettings(
      context.target.auth,
      verified,
      filterRecord(values, (_value, name) => Record.has(context.declaration.declaration, name)),
    );
  }

  return record;
});

const publishCompleted = Effect.fnUntraced(function* publishCompleted(
  prepared: Prepared,
  completed: readonly State.Custody[],
) {
  const { root, selected, host, options } = prepared.workflow;
  yield* assertDistinctKeys(map(completed, (record) => record.privateKey));
  const keys: ProfileKeys = {};

  for (const record of completed) {
    const plan = findFirst(prepared.plans, (item) => item.profile === record.profile);
    yield* State.publishProfile(
      root,
      record,
      plan._tag === "Some" ? plan.value.local.source : undefined,
    );
    keys[record.profile] = record.privateKey;
  }

  yield* State.publishBinding(root, prepared.binding);
  yield* State.ensureProfileDelivery(root, selected);

  if (host !== undefined && !options.recoverOnly) {
    yield* distributeHostKeys({ ...host, keys });

    if (options.configureHostBuild) {
      yield* configureHostBuild({ ...host, adoptBuildCommand: true });
    }
  }

  const fs = yield* FileSystem.FileSystem;

  for (const plan of prepared.plans) {
    if (yield* fs.exists(plan.journal)) {
      yield* fs.remove(plan.journal);
    }
  }
});

const reportCompleted = Effect.fnUntraced(function* reportCompleted(context: Workflow) {
  yield* Console.log(
    "Hosted profiles are ready; existing projects, credentials and settings were preserved. Commit affect.json and selected encrypted profiles before Git previews. Local keys remain ignored.",
  );

  if (
    context.selected.includes("development") &&
    context.developmentOrigin === "http://localhost:3000"
  ) {
    yield* Console.log(
      "Development: VERCEL_ENV=development bash scripts/mise.sh exec -- bun run dev:localhost",
    );
  }

  if (context.options.recoverOnly) {
    yield* Console.log(
      "Recovery completed locally; hosted credentials and build configuration were preserved.",
    );

    return yield* Effect.void;
  }

  {
    yield* Console.log(
      context.host === undefined
        ? "Host delivery was not requested; its separately authorized project must receive each matching profile key."
        : "Selected host keys were verified; Git linkage and frontend publication were not changed.",
    );
  }

  return yield* Effect.void;
});

export const onboardHosted = Effect.fnUntraced(
  function* onboardHosted(options: HostedOptions, directory?: string) {
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.realPath(directory ?? path.resolve("."));
    const state = yield* State.stateDirectory(root);
    const lock = path.join(state, "lock");
    yield* Effect.acquireRelease(
      fs
        .makeDirectory(lock, { mode: 0o700 })
        .pipe(
          Effect.mapError(() =>
            failure("Onboarding is already active; preserve recovery state before retrying."),
          ),
        ),
      () => fs.remove(lock, { recursive: true }).pipe(Effect.orDie),
    );
    const context = yield* workflow(root, options);
    const prepared = yield* prepare(context);
    const completed: State.Custody[] = [];

    for (const plan of prepared.plans) {
      completed.push(yield* completePlan(plan, prepared));
    }

    yield* publishCompleted(prepared, completed);
    yield* reportCompleted(context);

    return {
      binding: prepared.binding,
      hostConfigured: context.host !== undefined && !options.recoverOnly,
      profiles: context.selected,
    };
  },
  Effect.scoped,
  Effect.mapError((cause) =>
    cause._tag === "UserError" || cause._tag === "QuitError"
      ? cause
      : failure("Hosted onboarding did not complete; local recovery state was preserved."),
  ),
);
