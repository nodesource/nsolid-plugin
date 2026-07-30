# Tasks

## Task 1: Define update contracts and semantic-version behavior

- [ ] **Description**: Add the pure update target, ownership, status, plan, result, summary, command, and strategy types defined in the design. Implement strict stable semantic-version parsing/comparison without adding a runtime dependency.
- **Depends on**: None
- **Files**: `packages/core/src/update/types.ts`, `packages/core/src/update/version.ts`, `packages/core/test/unit/update/version.test.ts`
- **Testing**: Cover valid versions, invalid registry values, equal/newer/older comparisons, and deterministic result/count shapes. References: Update Flow “Report running versions” and “Check whether the CLI is current.”

## Task 2: Add safe command execution and version sources

- [ ] **Description**: Implement the injected shell-free command runner, bounded/sanitized output, executable lookup, npm registry client, and GitHub-root bundle version source with explicit timeouts and validation.
- **Depends on**: Task 1
- **Files**: `packages/core/src/update/command-runner.ts`, `packages/core/src/update/version-source.ts`, `packages/core/test/unit/update/command-runner.test.ts`, `packages/core/test/unit/update/version-source.test.ts`
- **Testing**: Mock success, timeout, missing executable, invalid JSON/version, non-zero exit, oversized output, and secret-bearing diagnostics. Verify all subprocess calls use `shell: false` and argument arrays. References: Update Flow “Registry lookup fails,” “Required harness executable is missing,” and “Preserve credentials and user-owned configuration.”

## Task 3: Detect CLI installation ownership

- [ ] **Description**: Read the running package/bundle versions and detect npm or pnpm global ownership only from positive evidence. Return unsupported for workspace, local, `npx`, or ambiguous execution.
- **Depends on**: Tasks 1–2
- **Files**: `packages/core/src/update/package-manager.ts`, `packages/core/src/update/inventory.ts`, `packages/core/test/unit/update/package-manager.test.ts`, `packages/core/test/unit/update/inventory.test.ts`
- **Testing**: Use fixture paths/environments for npm, pnpm, `npx`, workspace, broken symlink, and ambiguous launchers. Verify unsupported sources produce guidance without mutation. References: Update Flow “Unsupported CLI installation source.”

## Task 4: Implement CLI package update strategy

- [ ] **Description**: Implement CLI check/update planning, confirmation metadata, npm/pnpm command generation, post-command reporting, and exact previous-version rollback guidance.
- **Depends on**: Tasks 1–3
- **Files**: `packages/core/src/update/strategies/cli-package.ts`, `packages/core/test/unit/update/cli-package.test.ts`
- **Testing**: Cover current, update available, newer-than-registry, declined, `--yes`, unsupported source, failed package manager, and rollback command. References: all CLI-specific scenarios in Update Flow.

## Task 5: Extend harness inventory and version evidence

- [ ] **Description**: Reuse native detection and fallback tracking to classify Claude, Codex, OpenCode, Antigravity, and Pi ownership. Add optional installed version/staged root evidence and backward-compatible `bundleVersion` tracking for fallback installs.
- **Depends on**: Tasks 1–3
- **Files**: `packages/core/src/update/inventory.ts`, `packages/core/src/harnesses/*.ts`, `packages/core/src/skills/skill-tracker.ts`, related harness/tracker tests
- **Testing**: Cover native, fallback, package-owned, missing, corrupt metadata, legacy tracking without `bundleVersion`, and version-unknown states for every harness. References: Update Flow “Requested harness is not installed,” “Check every detected target,” “Update one installed native harness,” and “Preserve credentials and user-owned configuration.”

## Task 6: Implement Claude and Codex native strategies

- [ ] **Blocking verification**: Before implementing `codex.ts`, use a disposable real Codex installation to verify whether `codex plugin marketplace upgrade nodesource` refreshes the version and content of an already-installed plugin rather than only marketplace metadata. Record the tested versions and command/output evidence. If it does not refresh the installed copy, stop and amend the design, Update Flow specification, and this task to use the documented plugin remove/add lifecycle with configuration-preservation coverage.
- [ ] **Description**: Add strategies that generate and execute the fixed Claude plugin update and Codex marketplace upgrade commands, retain native ownership, and return restart/reload guidance.
- **Depends on**: Tasks 2 and 5
- **Files**: `packages/core/src/update/strategies/claude.ts`, `packages/core/src/update/strategies/codex.ts`, corresponding unit tests
- **Testing**: Mock successful refresh, already-current output, command failure, missing executable, alternate detected plugin IDs/marketplace names where supported, and verify no fallback/auth call. References: Update Flow “Update Claude native plugin” and “Update Codex native plugin.”

## Task 7: Implement Pi and fallback/OpenCode strategies

- [ ] **Description**: Add the package-owned Pi update strategy and latest-published-CLI fallback refresh strategy. Reuse existing idempotent installation, backup, merge, and tracking code rather than duplicating it.
- **Depends on**: Tasks 2 and 5
- **Files**: `packages/core/src/update/strategies/pi.ts`, `packages/core/src/update/strategies/fallback.ts`, corresponding unit/integration tests
- **Testing**: Verify the exact Pi source, package-owned skill boundaries, OpenCode skill refresh, fallback MCP merge, configuration backup, preserved credentials, and no implicit install for an absent target. References: Update Flow “Update Pi package-owned skills,” “Update OpenCode or a fallback installation,” and “Requested harness is not installed.”

## Task 8: Implement transactional Antigravity update

- [ ] **Description**: Add known-path staging detection, restrictive temporary backup, confirmed uninstall/install, new-root validation, successful cleanup, and rollback restoration.
- **Depends on**: Tasks 2 and 5
- **Files**: `packages/core/src/update/antigravity-transaction.ts`, `packages/core/src/update/strategies/antigravity.ts`, related unit/integration tests
- **Testing**: Cover both supported staged roots, successful replacement, declined confirmation, uninstall failure, install failure, validation failure, rollback success/failure, cleanup, and credential preservation. References: Update Flow “Update Antigravity native plugin” and “Antigravity reinstall fails.”

## Task 9: Build the coordinator and programmatic API

- [ ] **Description**: Implement scope validation, deterministic target ordering, check-only short circuit, plan confirmation, sequential execution, per-target failure isolation, aggregation, and public `getVersionInfo()`, `checkUpdates()`, and `update()` exports.
- **Depends on**: Tasks 4 and 6–8
- **Files**: `packages/core/src/update/coordinator.ts`, `packages/core/src/update/index.ts`, `packages/core/src/index.ts`, coordinator/API tests
- **Testing**: Cover CLI-only default, one harness, `--all`, `--all` plus harness rejection, check-only no-execute guarantee, one failure with later success, empty inventory, status counts, and overall success/exit semantics. References: Update Flow “Update every detected target,” “One target fails during update-all,” “Check every detected target,” and “Conflicting update scopes.”

## Task 10: Add CLI commands and output formatting

- [ ] **Description**: Add `version` and `update` command parsing, bare `--version`, `--check`/`--all`, confirmation integration, human-readable summaries, JSON-only stdout, stderr progress, help text, and exit-code mapping.
- **Depends on**: Task 9
- **Files**: `packages/core/src/cli.ts`, `packages/core/src/utils/format.ts` or a new update formatter, CLI help/unit/integration tests
- **Testing**: Spawn the CLI with every supported scope/output combination. Assert exact JSON parseability, no ANSI in JSON, no mutation in check mode, prompts only when appropriate, sanitized errors, bare `--version` parity, and exit zero when a successful check reports `update-available`. References: Update Flow “Structured update output,” “Report versions with the conventional flag,” and “Non-interactive CLI update.”

## Task 11: Add atomic release preparation

- [ ] **Description**: Implement `release:prepare` for `patch`, `minor`, `major`, and explicit increasing versions. Snapshot the controlled allowlist, update the three source versions, invoke existing bundle/root generators, validate, restore on failure, and leave the private root version untouched.
- **Depends on**: Task 1
- **Files**: `scripts/prepare-release.mjs`, `package.json`, generator exports/refactors if needed, `packages/core/test/unit/scripts/prepare-release.test.ts`
- **Testing**: Use isolated fixture roots to verify patch/minor/major/explicit propagation, generated files, invalid/equal/lower rejection with zero writes, mid-stage rollback, unrelated-file preservation, no package skill materialization, and absence of publish/Git/network side effects. References: Release Versioning “Prepare a patch release” through “Atomic release preparation failure.”

## Task 12: Add release drift and payload checks

- [ ] **Description**: Implement `release:check`, including source/package equality, generated artifact checks, exact mismatch reporting, and cleanup-state validation. When and only when `--release` is present, compare the specification's explicit payload allowlist with the latest semantic-version tag and validate that payload changes have an update-visible version.
- **Depends on**: Task 11
- **Files**: `scripts/check-release-version.mjs`, `package.json`, script fixture tests
- **Testing**: Introduce drift independently in every controlled file, stale generated output, unchanged version with changes in each payload allowlist category, malformed/missing tag state, and materialized package skills. Verify normal and `--release` check modes never repair. References: Release Versioning “Check synchronized release versions,” “Release version drift is detected,” and “Skill changes require an update-visible version.”

## Task 13: Add end-to-end update regression coverage

- [ ] **Description**: Exercise the public CLI against isolated homes and fake harness executables/registries, including mixed native/fallback ownership and partial failure.
- **Depends on**: Tasks 9–12
- **Files**: `packages/core/test/integration/update-flow.test.ts`, test fixtures/helpers, `scripts/test-marketplace-install.js` where update assertions fit
- **Testing**: Cover all acceptance tests from the proposal on Linux-compatible fixtures and keep paths/commands portable for macOS and Windows CI. Assert credentials and non-NodeSource configurations are byte-for-byte preserved.

## Task 14: Document user and maintainer workflows

- [ ] **Description**: Document CLI self-update, per-harness update ownership, check/JSON/automation modes, AGY replacement behavior, rollback guidance, version propagation, manual publication order, and the first-release bootstrap limitation.
- **Depends on**: Tasks 10–12
- **Files**: `README.md`, `packages/core/README.md`, `packages/pi-plugin/README.md`
- **Testing**: Validate every documented command against CLI help/tests and ensure no documentation implies that a Git push alone updates version-keyed caches. References: both specifications and Design “Migration Strategy.”

## Task 15: Run release-quality gates

- [ ] **Description**: Run version drift checks, source/plugin checks, lint, type checking/build, all unit/integration tests, marketplace install tests, and package dry-run inspection for both publishable packages.
- **Depends on**: Tasks 13–14
- **Files**: No production files unless a gate exposes a defect
- **Testing**: `pnpm release:check --release`, `pnpm plugin:check`, `pnpm lint`, `pnpm build`, `pnpm test`, `pnpm test:marketplace`, plus dry-run package contents confirming updated skills and same-version Pi/core dependency resolution.
