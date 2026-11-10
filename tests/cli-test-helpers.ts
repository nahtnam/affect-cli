import { mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const cliRoot = path.resolve(import.meta.dirname, "..");
export const cliEntry = path.join(cliRoot, "dist/index.js");

interface FixtureOptions {
  environment?: string;
  values?: Record<string, string>;
  convexMode?: string;
  buildExitStatus?: number;
  provider?: {
    callbackCloud?: string;
    callbackSite?: string;
    deploymentType?: "preview" | "prod";
    failPath?: string;
    missingCallback?: "cloud" | "site";
    redirectPath?: string;
    responses?: ProviderResponses;
  };
}

interface DeploymentInfoResponse {
  deploymentType?: string;
  id?: number;
  kind?: "cloud" | "selfHosted";
  projectId?: number;
  teamId?: number;
}

interface ProviderResponses {
  "/api/deployment/url_for_key"?: string | { unexpected: string };
  "/api/v1/deployment_info"?: DeploymentInfoResponse;
  "/api/v1/get_canonical_urls"?: {
    convexCloudUrl: string;
    convexSiteUrl: string;
  };
}

export interface Fixture {
  root: string;
  envFile: string;
  privateKey: string | undefined;
  convexLog: string;
  convexInputDir: string;
  convexHttpLog: string;
  convexHttpBody: string;
  convexCount: string;
  convexMode: string;
  providerOptions: string;
  cleanup: () => Promise<void>;
}

const pathForTest = (fixture: string) =>
  [path.join(fixture, "node_modules", ".bin"), process.env["PATH"] ?? ""].filter(Boolean).join(":");

type TestEnvironment = Record<string, string>;

const cleanEnv = (root: string, extra: TestEnvironment = {}) => ({
  HOME: path.join(root, ".home"),
  PATH: pathForTest(root),
  TMPDIR: path.join(root, ".tmp"),
  XDG_CACHE_HOME: path.join(root, ".cache"),
  XDG_CONFIG_HOME: path.join(root, ".config"),
  ...extra,
});

const runDotenvx = (root: string, args: string[]) => {
  const result = spawnSync(
    "bun",
    [path.join(cliRoot, "node_modules/@dotenvx/dotenvx/src/cli/dotenvx.js"), ...args],
    {
      cwd: root,
      encoding: "utf-8",
      env: cleanEnv(root),
    },
  );

  if (result.status !== 0) {
    throw new Error(`dotenvx failed (${result.status}): ${result.stderr || result.stdout}`);
  }
};

const readPrivateKey = async (keysFile: string) => {
  const source = await readFile(keysFile, "utf-8");

  return /^DOTENV_PRIVATE_KEY=(?<privateKey>.+)$/mu.exec(source)?.groups?.["privateKey"];
};

export const makeFixture = async ({
  environment = "development",
  values,
  convexMode = "",
  buildExitStatus = 0,
  provider = {},
}: FixtureOptions = {}): Promise<Fixture> => {
  const root = await mkdtemp(path.join(tmpdir(), "affect-cli-"));
  const convexBin = path.join(root, "node_modules", ".bin", "convex");
  const affectBin = path.join(root, "node_modules", ".bin", "affect");
  const convexInputDir = path.join(root, "convex-input");
  const convexHttpLog = path.join(root, "convex-http.log");
  const convexHttpBody = path.join(root, "convex-http.body");
  const convexPreload = path.join(root, "convex-http-preload.mjs");
  const convexLog = path.join(root, "convex.log");
  const convexCount = path.join(root, "convex.count");
  const providerOptions = path.join(root, "fake-provider.json");
  await mkdir(path.dirname(convexBin), { recursive: true });
  await symlink(cliEntry, affectBin);
  await mkdir(convexInputDir, { recursive: true });
  await mkdir(path.join(root, "apps", "web"), { recursive: true });
  await mkdir(path.join(root, ".home"), { recursive: true });
  await mkdir(path.join(root, ".tmp"), { recursive: true });
  await writeFile(
    providerOptions,
    JSON.stringify({
      callbackCloud: provider.callbackCloud ?? "https://callback.convex.cloud",
      callbackSite: provider.callbackSite ?? "https://callback.convex.site",
      convexHttpBody,
      convexHttpLog,
      deploymentType: provider.deploymentType ?? (environment === "preview" ? "preview" : "prod"),
      failPath: provider.failPath ?? "",
      missingCallback: provider.missingCallback ?? "",
      redirectPath: provider.redirectPath ?? "",
      responses: provider.responses ?? {},
    }),
  );
  await writeFile(
    convexPreload,
    `const root = process.cwd();
const options = await Bun.file(root + "/fake-provider.json").json();
if (process.env.AFFECT_FAKE_DOTENV_PASS === "1") {
  const source = await Bun.file(root + "/.env").text().catch(() => "");
  for (const line of source.split(String.fromCharCode(10))) {
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const name = line.slice(0, separator);
    if (process.env[name] === undefined) process.env[name] = line.slice(separator + 1);
  }
}
{
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const body = await request.text();
    const url = new URL(request.url);
    const entry = {
      authorization: request.headers.get("authorization") ?? "",
      body: body ? JSON.parse(body) : null,
      method: request.method,
      path: url.pathname,
      redirect: request.redirect,
      url: request.url,
    };
    await Bun.write(options.convexHttpLog, (await Bun.file(options.convexHttpLog).text().catch(() => "")) + JSON.stringify(entry) + "\\n");
    if (url.pathname === options.failPath) throw new Error("synthetic provider failure");
    if (url.pathname === options.redirectPath) return new Response(null, { status: 307, headers: { location: "https://redirect.invalid" } });
    const defaults = {
      "/api/deployment/url_for_key": options.callbackCloud,
      "/api/deployment/team_and_project_for_key": { team: "synthetic-team", teamId: 11, project: "synthetic-project", projectId: 22 },
      "/api/deployment/authorize_preview": { deploymentName: "synthetic-preview", adminKey: "preview:synthetic-team:synthetic-project|synthetic-admin-key", deploymentType: "preview", isDefault: false, reference: "feature/fixture", url: options.callbackCloud },
      "/api/v1/deployment_info": { kind: "cloud", deploymentType: options.deploymentType, id: 33, teamId: 11, projectId: 22 },
      "/api/v1/get_canonical_urls": { convexCloudUrl: options.callbackCloud, convexSiteUrl: options.callbackSite },
      "/api/v1/update_environment_variables": null,
    };
    if (url.pathname === "/api/v1/update_environment_variables") {
      await Bun.write(options.convexHttpBody, body);
      return new Response(null, { status: options.failPath === url.pathname ? 503 : 200 });
    }
    if (!Object.hasOwn(defaults, url.pathname)) return new Response(null, { status: 404 });
    const value = Object.hasOwn(options.responses, url.pathname) ? options.responses[url.pathname] : defaults[url.pathname];
    return Response.json(value);
  };
}
`,
  );

  await writeFile(
    convexBin,
    `#!/bin/sh
set -eu
LOG=${JSON.stringify(convexLog)}
COUNT=${JSON.stringify(convexCount)}
INPUT_DIR=${JSON.stringify(convexInputDir)}
ENV_LOG=${JSON.stringify(path.join(root, "native-env.log"))}
CWD_LOG=${JSON.stringify(path.join(root, "native-cwd.log"))}
MODE=${JSON.stringify(convexMode)}
PRELOAD=${JSON.stringify(convexPreload)}
CALLBACK_CLOUD=${JSON.stringify(provider.callbackCloud ?? "https://callback.convex.cloud")}
CALLBACK_SITE=${JSON.stringify(provider.callbackSite ?? "https://callback.convex.site")}
MISSING_CALLBACK=${JSON.stringify(provider.missingCallback ?? "")}
count=0
if [ -f "$COUNT" ]; then count=$(cat "$COUNT"); fi
printf '%s\\n' "$((count + 1))" > "$COUNT"
printf '%s\\n' "$*" >> "$LOG"
printf 'CONVEX_DEPLOY_KEY=%s\\n' "\${CONVEX_DEPLOY_KEY-}" >> "$LOG"
printf 'CONVEX_AGENT_MODE=%s\\n' "\${CONVEX_AGENT_MODE-}" >> "$LOG"
case "\${1-}" in
  init)
    if [ "$MODE" = bad-init ]; then
      printf '%s\\n' 'CONVEX_DEPLOYMENT=named:fixture' > .env.local
    else
      printf '%s\\n' 'CONVEX_DEPLOYMENT=anonymous:fixture' > .env.local
    fi
    ;;
  env)
    cat > "$INPUT_DIR/$count"
    if [ "$MODE" = fail-env-set ]; then exit 23; fi
    ;;
  deploy)
    printf '%s\\n' "$PWD" > "$CWD_LOG"
    env | sort > "$ENV_LOG"
    if [ "$MODE" = fail-deploy ]; then exit 24; fi
    if [ "$MODE" = run-build ]; then
      command=""
      previous=""
      for argument in "$@"; do
        if [ "$previous" = --cmd ]; then command="$argument"; break; fi
        previous="$argument"
      done
      if [ "$MISSING_CALLBACK" = cloud ]; then CALLBACK_CLOUD=""; fi
      if [ "$MISSING_CALLBACK" = site ]; then CALLBACK_SITE=""; fi
      AFFECT_FAKE_DOTENV_PASS=1 BUN_OPTIONS="--preload=$PRELOAD" VITE_CONVEX_URL="$CALLBACK_CLOUD" VITE_CONVEX_SITE_URL="$CALLBACK_SITE" sh -c "$command"
    fi
    ;;
esac
`,
    { mode: 0o755 },
  );

  const buildKeys = [
    "PATH",
    "HOME",
    "TMPDIR",
    "CI",
    "VERCEL",
    "VERCEL_ENV",
    "VERCEL_GIT_COMMIT_REF",
    "VERCEL_URL",
    "VERCEL_PROJECT_PRODUCTION_URL",
    "TOOL_SENTINEL",
    "VITE_CONVEX_URL",
    "VITE_CONVEX_SITE_URL",
    "VITE_SITE_URL",
    "VITE_POSTHOG_HOST",
    "VITE_POSTHOG_KEY",
    "SITE_URL",
    "SERVER_SECRET",
    "PROFILE_ONLY_SECRET",
    "INHERITED_SECRET",
    "VITE_UNREVIEWED",
    "CONVEX_DEPLOY_KEY",
    "DOTENV_PRIVATE_KEY",
    "NODE_USE_ENV_PROXY",
    "NODE_OPTIONS",
    "BUN_OPTIONS",
  ];

  const buildSource = `const fs=require("node:fs");const names=${JSON.stringify(buildKeys)};const mode=process.env.VERCEL_ENV==="production"?"production":"development";const modePath=${JSON.stringify(path.join(root, "apps", "web"))}+"/.env."+mode;if(fs.existsSync(modePath)){for(const line of fs.readFileSync(modePath,"utf8").split("\\n")){const separator=line.indexOf("=");if(separator>0){const name=line.slice(0,separator);if(process.env[name]===undefined)process.env[name]=line.slice(separator+1)}}}fs.writeFileSync(${JSON.stringify(path.join(root, "build.marker"))},JSON.stringify({env:Object.fromEntries(names.map((name)=>[name,process.env[name]??null])),argv:process.argv.slice(1)}))`;
  const buildMarker = path.join(root, "build-marker.cjs");
  await writeFile(buildMarker, buildSource);
  await writeFile(
    path.join(root, "node_modules", ".bin", "vite"),
    `#!/bin/sh\nset -eu\nif [ ${buildExitStatus} -ne 0 ]; then exit ${buildExitStatus}; fi\nnode ${JSON.stringify(buildMarker)}\n`,
    { mode: 0o755 },
  );
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({
      dependencies: { convex: "1.49.0" },
      devDependencies: { vite: "8.3.6" },
      name: "fixture",
      private: true,
      scripts: {
        build: "bun run --filter @affect/web build",
        preinstall: "node -e \"require('fs').writeFileSync('install.marker', 'installed')\"",
      },
      workspaces: ["apps/*"],
    }),
  );
  await writeFile(
    path.join(root, "apps", "web", "package.json"),
    JSON.stringify({
      dependencies: { "@tanstack/react-start": "1.0.0" },
      devDependencies: { vite: "8.3.6" },
      name: "@affect/web",
      scripts: { build: "vite build" },
    }),
  );
  await mkdir(path.join(root, "convex"), { recursive: true });
  await writeFile(
    path.join(root, "convex", "env.config.ts"),
    `const string = (isOptional: "required" | "optional") => ({ isConvexValidator: true, isOptional, kind: "string" }); export default { SERVER_SECRET: string("required"), SITE_URL: string("optional"), TRUSTED_ORIGINS: string("optional"), SPECIAL_VALUE: string("optional"), INTERPOLATED_VALUE: string("optional"), FAIL_VALUE: string("optional"), BUILD_VALUE: string("optional"), OPTIONAL_SETTING: string("optional") };`,
  );

  const envDir = path.join(root, "env", environment);
  const envFile = path.join(envDir, ".env");
  const keysFile = path.join(root, ".env.keys");
  let privateKey: string | undefined;

  if (values !== undefined) {
    await mkdir(envDir, { recursive: true });

    for (const [key, value] of Object.entries(values)) {
      runDotenvx(root, [
        "set",
        key,
        value,
        "--encrypt",
        "--no-native",
        "--no-armor",
        "--no-1password",
        "--no-bitwarden",
        "-f",
        envFile,
        "-fk",
        keysFile,
      ]);
    }

    privateKey = await readPrivateKey(keysFile);
    await unlink(keysFile);
  }

  return {
    cleanup: async () => {
      await rm(root, { force: true, recursive: true });
    },
    convexCount,
    convexHttpBody,
    convexHttpLog,
    convexInputDir,
    convexLog,
    convexMode,
    envFile,
    privateKey,
    providerOptions,
    root,
  };
};

export interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export const evaluateExports = (fixture: Fixture, exportsText: string, variable: string) => {
  const result = spawnSync(
    "bash",
    ["-c", `eval "$1"; printf '%s' "$${variable}"`, "bash", exportsText],
    { cwd: fixture.root, encoding: "utf-8", env: cleanEnv(fixture.root) },
  );

  return { status: result.status, stderr: result.stderr ?? "", stdout: result.stdout ?? "" };
};

export const runCli = (
  fixture: Fixture,
  args: string[],
  extraEnv: Record<string, string | undefined> = {},
): CliResult => {
  const env: NodeJS.ProcessEnv = cleanEnv(fixture.root, {
    AFFECT_FAKE_CONVEX_COUNT: fixture.convexCount,
    AFFECT_FAKE_CONVEX_HTTP_BODY: fixture.convexHttpBody,
    AFFECT_FAKE_CONVEX_HTTP_LOG: fixture.convexHttpLog,
    AFFECT_FAKE_CONVEX_INPUT_DIR: fixture.convexInputDir,
    AFFECT_FAKE_CONVEX_LOG: fixture.convexLog,
    AFFECT_FAKE_CONVEX_MODE: fixture.convexMode,
    AFFECT_FAKE_CONVEX_PRELOAD: path.join(fixture.root, "convex-http-preload.mjs"),
  });

  for (const [key, value] of Object.entries(extraEnv)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }

  const result = spawnSync(
    "bun",
    ["--preload", path.join(fixture.root, "convex-http-preload.mjs"), cliEntry, ...args],
    {
      cwd: fixture.root,
      encoding: "utf-8",
      env,
    },
  );

  return { status: result.status, stderr: result.stderr ?? "", stdout: result.stdout ?? "" };
};

export const readConvexLog = async (fixture: Fixture) => {
  try {
    return await readFile(fixture.convexLog, "utf-8");
  } catch {
    return "";
  }
};

export const readConvexInput = async (fixture: Fixture, index: number) =>
  await readFile(path.join(fixture.convexInputDir, String(index)), "utf-8");

export const readFixtureFile = async (fixture: Fixture, relativePath: string) =>
  await readFile(path.join(fixture.root, relativePath), "utf-8");

export const fixtureEnv = (fixture: Fixture) => ({
  DOTENV_PRIVATE_KEY: fixture.privateKey,
});
