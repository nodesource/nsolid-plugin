# Implementation record

This branch implements the approved `add-update-flow` change from
`cesar/update-flow-spec@5812b0f`. The proposal, design, tasks, and both
normative specs are unchanged. The implementation is recorded here against
the complete branch diff, not only the last corrective pass.

## Scope and invariants

- The updater remains a minor, additive feature. Existing installation APIs
  and the public `nsolid-plugin install` workflow are preserved.
- Every mutating plan carries an immutable artifact identity: npm registry,
  exact version, tarball and integrity, or Git repository, full commit and
  content digest. A mutable ref, an ambient registry re-resolution, or an
  unsupported harness source produces a non-mutating result.
- Native and fallback installations remain separate plan items. Ownership is
  tracked per installation, skill/link path, tracking field, and MCP field;
  unrelated user-owned state is never included in a mutation or rollback.
- Fallback recovery is parent-owned and durable. A child process cannot be
  the only source of rollback truth.
- `--check` is read-only, JSON stdout contains one valid document, and the
  summary exposes the approved exit-code contract (`0`, `1`, `2`).

## Implemented areas

### Update domain, sources, and command execution

- Added `packages/core/src/update/types.ts` with the approved contracts for
  versions, targets, ownership, installations, artifact identities, plans,
  execute/rollback steps, sanitized errors, results, summaries, commands,
  confirmations, context, and strategies.
- Added strict stable-semver parsing/comparison in
  `packages/core/src/update/version.ts`.
- Added shell-free, argument-array command execution with bounded output,
  executable lookup, timeouts, and sanitized diagnostics in
  `packages/core/src/update/command-runner.ts`.
- Added registry, npm tarball/integrity, Git commit/content, and local-source
  resolution in `packages/core/src/update/version-source.ts`. Resolution,
  execution, and post-update verification use the same frozen identity.
- Added package-manager detection and positive realpath ownership checks in
  `packages/core/src/update/package-manager.ts`; unsupported workspace,
  `npx`, Volta, Yarn, Bun, mismatched-root, and ambiguous launches do not
  mutate.

### Inventory and existing ownership state

- Added complete installation discovery, source evidence, deterministic
  ordering, target/scope filters, and empty-inventory handling in
  `packages/core/src/update/inventory.ts`.
- Extended `packages/core/src/skills/skill-tracker.ts` and
  `packages/core/src/skills/skill-linker.ts` with per-installation paths,
  ownership, bundle-version compatibility evidence, and safe reconciliation.
- Extended `packages/core/src/mcp/mcp-tracker.ts` with field-level ownership
  and digest evidence.
- Updated `packages/core/src/harnesses/pi-plugin-detector.ts` so Pi project
  roots, effective settings, source identity, scope, and cache roots can be
  captured and revalidated.
- Kept native and fallback records distinct and preserved legacy tracking
  without requiring a new public installer contract.

### Strategies and transactional mutations

- CLI package updates: `strategies/cli-package.ts` plans exact-version npm or
  pnpm operations, uses the positively identified package-manager executable,
  verifies the installed package/version, and reports exact rollback guidance.
- Claude native updates: `strategies/claude.ts` uses the detected plugin ID
  and installation scope only.
- Codex native updates: `strategies/codex.ts` and
  `codex-transaction.ts` refresh the exact detected marketplace/plugin,
  snapshot registration, enablement, user fields, and cache, then validate or
  restore the transaction without touching neighboring plugins.
- Pi package-owned updates: `strategies/pi.ts` coalesces only matching user
  and project scopes, chooses the approved approval mode, sets the captured
  project root, and revalidates settings, source, directory identity, and
  caches immediately before mutation.
- Antigravity native updates: `strategies/antigravity.ts` and
  `antigravity-transaction.ts` operate on one supported staged-root/manifest
  pair, use the pinned Git identity, validate both content and registration,
  and restore unrelated imports on failure.
- OpenCode/fallback updates: `strategies/fallback.ts`,
  `fallback-transaction.ts`, `fallback-journal.ts`, and
  `refresh-owned-cli.ts` implement exact-package execution from a verified
  tarball, a restrictive transaction manifest, atomic durable `prepared`,
  `mutating`, and `committed` journal phases, field-level MCP checks, parent
  rollback/recovery, timeout/crash handling, and stale-journal recovery on the
  next mutable invocation.
- The private refresh binary is invoked only with `--transaction <manifest>`;
  executable harness-only ownership rediscovery was not introduced.

### Coordinator, API, and CLI

- Added `packages/core/src/update/coordinator.ts` for deterministic inventory,
  scope validation, one plan item per installation, explicit absent-harness
  `none` items, complete execute/rollback plans before confirmation,
  check-only short-circuiting, sequential execution, independent failure
  isolation, aggregation, and the approved exit-code precedence.
- Added `packages/core/src/update/index.ts` and exports in
  `packages/core/src/index.ts` for `getVersionInfo()`, `checkUpdates()`,
  `planUpdates()`, and `update()`.
- Extended `packages/core/src/cli.ts` with `version`, bare `--version`,
  `update`, `--check`, `--all`, target/ownership validation, confirmation and
  non-interactive approval, human-readable output, JSON-only stdout, sanitized
  errors, recovery reporting, and manual remove/add guidance.

### Release, packaging, and documentation

- Added atomic `scripts/prepare-release.mjs` and read-only
  `scripts/check-release-version.mjs`.
- Added the `release:prepare` and `release:check` package scripts in the root,
  and registered the private `nsolid-plugin-refresh-owned` binary in
  `packages/core/package.json`, while leaving the private root package version
  untouched.
- Release checks cover generated artifacts, source/package equality, the full
  published payload (including `packages/core/src/**` and
  `packages/pi-plugin/index.js`), committed/staged/unstaged/untracked
  changes, semantic `X.Y.Z`/`vX.Y.Z` tags, peeled annotated tags, ancestry,
  duplicate versions, missing tags, and shallow history.
- Updated `README.md`, `packages/core/README.md`, and
  `packages/pi-plugin/README.md` with user, maintainer, automation, rollback,
  unsupported-wrapper, scope/trust, publication, and first-release guidance.

### Branch file inventory

The branch changes are distributed across the following implementation
surfaces:

- Update runtime: `packages/core/src/update/{types,version,command-runner,
  version-source,package-manager,inventory,coordinator,index,
  refresh-owned-cli,fallback-journal,fallback-transaction,
  codex-transaction,antigravity-transaction}.ts` and
  `packages/core/src/update/strategies/{common,cli-package,claude,codex,pi,
  antigravity,fallback}.ts`.
- Existing integration points: `packages/core/src/cli.ts`,
  `packages/core/src/index.ts`, `packages/core/src/harnesses/pi-plugin-detector.ts`,
  `packages/core/src/mcp/mcp-tracker.ts`,
  `packages/core/src/skills/skill-linker.ts`, and
  `packages/core/src/skills/skill-tracker.ts`.
- Regression coverage: `packages/core/test/integration/update-flow.test.ts`
  and the update unit suites for the command runner, version/source logic,
  package-manager ownership, inventory, CLI strategy, Codex, Antigravity,
  fallback, and semver behavior.
- Release and package surfaces: `scripts/prepare-release.mjs`,
  `scripts/check-release-version.mjs`, root `package.json`, and
  `packages/core/package.json`.
- User/maintainer documentation: `README.md`, `packages/core/README.md`,
  and `packages/pi-plugin/README.md`.

## Tests and verification

The implementation branch was verified with the following successful gates:

- `openspec validate add-update-flow --strict`
- `pnpm lint`
- `pnpm build`
- `pnpm test:unit` (41/41)
- `pnpm test:integration` (125 tests, 26 suites)
- `pnpm test:marketplace` (all checks)
- `pnpm test` (539 tests, 104 suites)
- `pnpm plugin:check`
- `pnpm release:check`
- package dry-runs for both publishable packages
- `pnpm plugin:sync` cleanup and `git diff --check`

The resulting commit is `3f7efff` (`feat(update): implement approved update
flow`). The worktree is clean and the approved OpenSpec documents remain
unchanged.

`pnpm release:check --release` correctly reports that the current payload has
changed since `v1.0.1` without an update-visible version. This is the expected
release gate until `release:prepare` is run for a future release; it is not an
implementation failure. A live upgrade against a newly published candidate is
also intentionally not claimed here because no candidate is currently
available.
