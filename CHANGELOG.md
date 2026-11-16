# affect-cli

## 0.0.7

### Patch Changes

- 946682c: Add hosted environment onboarding and recovery with scoped credentials, separate profile keys, preserved existing settings, and optional frontend-host key delivery. Prepare branch preview origins consistently across backend authentication, browser builds and encrypted runtime configuration.

## 0.0.6

### Patch Changes

- f7fef75: Allow project-specific root and web build scripts and explicit public build settings through the existing environment declaration. Preserve isolated build environments and reject recursive deploy callbacks.

## 0.0.5

### Patch Changes

- 21c0815: Require canonical Vite Convex URLs for development sync and build the TanStack workspace through the verified native Convex deploy callback.

## 0.0.4

### Patch Changes

- 42f61e4: Add `affect env sync-dev [--force]` to synchronize settings from an explicit encrypted development profile and shared Convex server declaration. Verify the hosted development identity and canonical URLs before any update, preserve bulk conflict semantics, and keep credentials and values out of output. This command does not deploy backend code or build the frontend.

## 0.0.3

### Patch Changes

- e7da663: Synchronize expanded deployment environment values through the Convex environment API before builds.

## 0.0.2

### Patch Changes

- 7f06bf7: Add `affect run` to load the selected encrypted environment before running a command, preserving inherited values, arguments, and process lifecycle behavior.
