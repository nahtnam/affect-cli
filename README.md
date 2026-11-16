# affect-cli

Shared environment and deployment commands for Affect projects. Requires Bun 1.4.2 or later and a project-local Convex CLI.

```sh
bun add --dev --exact affect-cli
bunx --no-install affect --help
```

Run commands from the application repository root:

- `affect env init` provisions or adopts explicitly selected hosted Convex environments and creates encrypted, recoverable profiles. `affect env restore` retrieves existing profiles and matching keys without provisioning or changing provider settings. See [Hosted onboarding](#hosted-onboarding).
- `affect env` prints shell exports from `env/{development,preview,production,ci}/.env`. It requires the matching `DOTENV_PRIVATE_KEY` when that file exists. Treat its output as secrets.
- `affect env sync-dev [--force]` reads only `env/development/.env` with its matching `DOTENV_PRIVATE_KEY` and synchronizes declared server settings to its verified hosted development backend. The profile must provide the canonical `VITE_CONVEX_URL` and `VITE_CONVEX_SITE_URL` pair and a development-scoped deploy key. It never deploys code or builds the frontend. It ignores inherited CI, production, account-token and provider-host selection. Missing required settings fail; absent optional settings preserve remote values; explicit empty strings remain values. Existing differing values refuse the entire batch unless `--force` is supplied. Omission never deletes a remote setting. Output contains only the verified target and setting counts.
- `affect run -- <command> [args...]` loads that environment and runs a command. Existing environment values take precedence; arguments, standard I/O, and exit codes are preserved.
- `affect dotenvx -- …` forwards arguments to the bundled native dotenvx CLI, for example `affect dotenvx -- encrypt -f env/development/.env --no-armor --no-native`.
- `affect setup` initializes an anonymous local Convex backend only for a fresh project, or retries its environment import. It preserves existing linked deployments and credentials.
- `affect deploy` invokes Convex's native deploy sequence for the selected Vercel-scoped profile. Native `convex deploy` pushes Convex backend code and runs the root build callback; Vercel supplies `VERCEL_ENV=preview|production` and the preview branch name automatically, and the matching deploy key remains encrypted in the profile. The callback requires the verified `VITE_CONVEX_URL` and `VITE_CONVEX_SITE_URL` pair and runs the root TanStack build. Frontend build output is not published by `affect deploy`; publication belongs to the configured frontend host. `--build` is its internal Convex callback.

Except for the explicitly development-only `env sync-dev`, selection uses `VERCEL_ENV`, then `ci` for GitHub Actions/CI, otherwise `development`. Files stay in the application; cryptography stays in dotenvx. Deployment follows Affect's `apps/web` layout.

`env sync-dev` requires a declaration-only `convex/env.config.ts` with a default Convex `EnvDefinition` export. Share that same object with `defineApp({ env })`; keep it independent of generated files, app/component initialization and runtime environment reads. The Bun-only CLI loads this trusted module directly. It does not execute `convex.config.ts` or generate an allowlist from source text. For example:

```ts
import type { EnvDefinition } from "convex/server";
import { v } from "convex/values";

export default {
  API_TOKEN: v.string(),
  OPTIONAL_SETTING: v.optional(v.string()),
} satisfies EnvDefinition;

export const publicEnv = [
  "VITE_SITE_URL",
  "VITE_POSTHOG_HOST",
  "VITE_POSTHOG_KEY",
  "VITE_TURNSTILE_SITE_KEY",
] as const;
```

`affect deploy` reads `publicEnv` from this same module as the complete list of public build settings. Only values present in the selected encrypted profile are forwarded, including empty strings; ambient public settings are not forwarded. Names must be uppercase `VITE_` variables, unique, and outside the reserved `VITE_CONVEX_`, `VITE_DOTENV_`, and `VITE_AFFECT_` namespaces. The CLI always supplies verified `VITE_CONVEX_URL` and `VITE_CONVEX_SITE_URL` independently. Modules without `publicEnv` retain the default names `VITE_SITE_URL`, `VITE_POSTHOG_HOST`, and `VITE_POSTHOG_KEY`; an empty array selects no additional public settings.

The root and `apps/web` build scripts may include project-specific preparation and Vite options. Both must be nonempty and retain the Affect TanStack workspace structure. The callback runs `bun run build` at the root; calling `affect deploy` from that build is rejected to prevent recursion.

Use the profile's development-scoped deploy key and canonical public Convex cloud/site origins (`VITE_CONVEX_URL` and `VITE_CONVEX_SITE_URL`). Before any update the command verifies the provider's cloud/development identity, owning team/project and both canonical URLs. Reserved credential/control/client-public names are rejected even if declared. Only present declared server settings are sent, using the native Convex JSON environment API without temporary plaintext files; native Convex remains responsible for provider limits and application value validation. The command needs metadata and environment read/write permissions; it does not create credentials or fall back to a broader login. Profile values use the same dotenvx decryption and interpolation as `affect env`. The profile remains encrypted with dotenvx; only settings declared by `convex/env.config.ts` cross into the backend.

From the application root, run the TanStack development script with the selected profile:

```sh
bunx --no-install affect run -- bun run dev
```

`affect run` supplies the selected profile to the application process; it does not start a Convex watcher. The canonical Convex URLs are Vite build-time values. Vercel supplies `VERCEL_ENV` and, for previews, `VERCEL_GIT_COMMIT_REF`; the CLI uses those host values to select the target and branch, then reads the matching deploy key from the encrypted profile. Preview deployment uses the exact `AFFECT_PREVIEW_ORIGIN` override or Vercel's `VERCEL_URL` for the frontend origin, and native Convex deploy supplies the branch backend's canonical cloud/site URLs. The callback uses those origins for backend auth settings and the browser build, then temporarily encrypts a runtime profile with the existing preview key for the application's build packaging. It restores the original profile after the build and excludes deploy/provider credentials from that runtime payload. Branch backends are created or reused by native Convex without `--preview-create`.

## Hosted onboarding

In an Affect application, the first hosted setup can install its toolchain and dependencies before initializing profiles:

```sh
bash scripts/setup.sh --hosted \
  --team 123 --create-project my-app \
  --profiles development,preview,production \
  --site-url https://my-app.example --non-interactive
```

Use your actual numeric team ID and hosted origin. To adopt a project, replace `--create-project` with `--project <numeric-id>`. Multiple candidate development or production deployments require an explicit `--dev-deployment` or `--prod-deployment`. The repository wrapper requires development among the selected profiles because its final step validates local development. Direct `affect env init` also supports preview-only or production-only selections. Interactive terminals can prompt for selections; automation must supply unambiguous choices. Run `affect env init --help` for the current flags.

Authorization comes from an existing native Convex login, `CONVEX_ACCESS_TOKEN` containing a personal access token, or `AFFECT_CONVEX_TOKEN` containing a team token. Set credential values through your secret manager or environment rather than command arguments. The CLI verifies ownership before provisioning, saves the bootstrap credential in owner-only local state for future onboarding, and records only nonsecret target IDs, origins and profile choices in `affect.json`. A broad bootstrap credential never enters runtime profiles, builds or logs. Convex's [Management API](https://docs.convex.dev/platform-apis/overview) supplies scoped development, production and project-preview keys; frontend-host authorization remains separate.

Each profile has its own dotenvx key. Development and production recovery records are stored as `AFFECT_ONBOARDING_V1` in the exact verified deployment's environment storage. The preview recovery record is a project default restricted to preview deployments and does not apply retroactively to existing deployments. It contains preview-family credentials only. Anyone authorized to read that provider environment can recover its key and encrypted profile; preview branches therefore share the preview family's trust boundary. Commit `affect.json` and the encrypted profile files that onboarding makes trackable. Keep `.env.keys` and `.setup.local` ignored. A fresh clone can use saved Convex authorization and `affect env restore --non-interactive` to recover matching local files. Ciphertext without a recoverable matching key fails; the CLI cannot reconstruct a lost dotenvx key.

Reruns adopt existing records and credentials, fill missing declared settings, and refuse differing existing settings. They never rotate, revoke, delete or overwrite credentials or populated settings. New auth secrets are generated independently; optional email and telemetry credentials remain unconfigured until supplied. An owner-only JSON `--values <file>` can provide declared application settings and reviewed public settings. Development defaults to `http://localhost:3000`; use the app's `dev:localhost` command, or supply the exact known `--dev-origin` before first initialization. Existing origins are preserved.

Initial setup is serialized within one checkout. Convex environment storage has no compare-and-swap operation, so simultaneous first initialization from different machines or checkouts is unsupported. Run the initial command once, then restore other clones. On partial failure, preserve the ignored local onboarding journal and rerun the same selection; it retains minted credentials for recovery.

Optional Vercel key delivery requires a separate `VERCEL_TOKEN`, `--vercel-account <id>` and `--vercel-project <id>` (plus `--vercel-team <id>` for a team project). It verifies the exact account/project and delivers each decrypt key only to its matching development, preview or production scope. Existing conflicting or unreadable values fail without replacement. `--configure-host-build` requires Vercel Root Directory `apps/web` with source files outside that directory included, then adopts an empty build command as `cd ../.. && bunx --no-install affect deploy`. This runs the CLI from the workspace root while Nitro emits the host artifact under the web app. Unknown or incompatible settings and differing build commands fail before provisioning; the CLI does not change the root or source-inclusion settings. This does not link Git, change domains, publish a frontend, or deploy application code. Those remain separate authorized steps.

## Development and releases

```sh
bun install --frozen-lockfile
bun run check
bun run changeset
bun run changeset version
bun run release
```

For automated releases, commit a changeset with each releasable change. The release workflow opens a version PR; merging it publishes to npm. Configure npm's GitHub trusted publisher for `nahtnam/affect-cli`, workflow `release.yml`, with direct publishing enabled. No npm token is needed. `bun run release` remains available for an intentional manual release.
