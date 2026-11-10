# affect-cli

Shared environment and deployment commands for Affect projects. Requires Bun 1.4.2 or later and a project-local Convex CLI.

```sh
bun add --dev --exact affect-cli
bunx --no-install affect --help
```

Run commands from the application repository root:

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
```

Use the profile's development-scoped deploy key and canonical public Convex cloud/site origins (`VITE_CONVEX_URL` and `VITE_CONVEX_SITE_URL`). Before any update the command verifies the provider's cloud/development identity, owning team/project and both canonical URLs. Reserved credential/control/client-public names are rejected even if declared. Only present declared server settings are sent, using the native Convex JSON environment API without temporary plaintext files; native Convex remains responsible for provider limits and application value validation. The command needs metadata and environment read/write permissions; it does not create credentials or fall back to a broader login. Profile values use the same dotenvx decryption and interpolation as `affect env`. The profile remains encrypted with dotenvx; only settings declared by `convex/env.config.ts` cross into the backend.

From the application root, run the TanStack development script with the selected profile:

```sh
bunx --no-install affect run -- bun run dev
```

`affect run` supplies the selected profile to the application process; it does not start a Convex watcher. The canonical Convex URLs are Vite build-time values. A host may separately provide runtime-only listener settings for its server, but `affect deploy` does not create a runtime env file or copy the deploy key into the frontend. Vercel supplies `VERCEL_ENV` and, for previews, `VERCEL_GIT_COMMIT_REF`; the CLI uses those host values to select the target and branch, then reads the matching deploy key from the encrypted profile.

## Development and releases

```sh
bun install --frozen-lockfile
bun run check
bun run changeset
bun run changeset version
bun run release
```

For automated releases, commit a changeset with each releasable change. The release workflow opens a version PR; merging it publishes to npm. Configure npm's GitHub trusted publisher for `nahtnam/affect-cli`, workflow `release.yml`, with direct publishing enabled. No npm token is needed. `bun run release` remains available for an intentional manual release.
