# Affect CLI instructions

- This package is Bun-only. Build the executable with Bun; bundle Effect so it
  stays independent of application versions, and keep dotenvx external.
- Use native Bun and Effect APIs. Before changing domain logic or validation,
  read `node_modules/effect/AGENTS.md` and the version-matched Effect docs.
- Keep real credentials and raw request/response data out of logs, errors,
  spans, tests, and fixtures. Use synthetic values in tests.
- Preserve strict TypeScript and the configured Ultracite/Effect lint presets.
  Use focused tests for behavior changes; do not weaken rules or suppress
  diagnostics to make a check pass.
- When porting a patch from an older checkout, reconcile every deletion against current release-branch fixes, including test options; matching generated artifacts and passing CI do not establish preservation.
- Treat package edits, versioning, publishing, and other release transitions as
  separate actions. Do not publish, push, or deploy without explicit approval.
- Default all CLI changesets and releases to patch versions. Minor or major
  versions require explicit human instruction.
