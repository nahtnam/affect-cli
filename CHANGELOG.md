# affect-cli

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
