# Proposal

## Problem Statement

N|Solid Plugin is distributed through several independent owners:

- the `nsolid-plugin` CLI is published to npm;
- Claude and Codex clone a Git-backed marketplace and cache installed plugin versions;
- Antigravity stages a copy of the GitHub plugin without exposing a plugin update command;
- Pi owns its skills through the `nsolid-pi-plugin` npm package; and
- OpenCode receives skills and MCP configuration through the fallback CLI installer.

Publishing new skills or runtime fixes therefore does not produce one consistent update experience. The current CLI has no `version`, `update`, or update-check command, users must know harness-specific commands, and a push to `main` can remain invisible to version-keyed caches when release metadata is not bumped. Maintainers must also update several version fields and generated manifests manually, which makes a partially versioned release possible.

## Proposed Solution

Add an explicit, version-aware update workflow for both maintainers and users.

For users:

- add `nsolid-plugin version` (with bare `nsolid-plugin --version` as an alias) and `nsolid-plugin update`;
- make plain `update` target the npm CLI, `--harness <harness>` target every detected installation for one harness, and `--all` target the CLI plus every detected N|Solid installation;
- add `--check` for a read-only status check and retain `--json`, `--yes`, `--verbose`, and `--no-color` behavior where applicable;
- update a positively identified npm- or pnpm-owned global CLI from the exact registry tarball and integrity identity resolved during planning, then verify the installed content on disk instead of trusting only the package-manager exit code or semantic version;
- delegate native updates to the owning harness:
  - Claude: update the detected `nsolid-plugin@<marketplace>` identity at its detected installation scope and resolve version evidence only from that marketplace's carried source metadata;
  - Codex: refresh the detected Git marketplace snapshot, then transactionally remove and add the same detected plugin identity because marketplace refresh does not update the installed copy; version checks never substitute a canonical marketplace for the detected source;
  - Antigravity: safely reinstall the GitHub-root plugin from a planned immutable commit with backup/rollback of the detected AGY or shared Antigravity staged-root/import-manifest pair;
  - Pi: update the canonical unpinned `npm:nsolid-pi-plugin` identity once across its detected user/project scopes from the captured/revalidated project root, while rejecting changed, local, pinned, Git, conflicting, or ambiguous sources;
  - OpenCode, whose N|Solid installation is direct rather than an OpenCode plugin, and other tracked fallback installations: invoke an internal integrity-verified refresh binary using an exact parent-owned installation manifest and durable recovery journal, including removal of obsolete NodeSource-owned assets without changing public `install` semantics;
- preserve credentials and non-NodeSource configuration throughout updates;
- isolate failures during `--all` so one harness failure does not prevent remaining updates, while returning a failing exit status and a per-target summary.

For maintainers:

- establish one release version across `bundle.json`, the core npm package, the Pi npm package, and generated version-bearing manifests;
- add release preparation/check tooling that performs or validates version propagation without publishing, tagging, or pushing;
- require update-visible releases to increment the version before generated root manifests are committed.

## Rollback Plan

- The CLI update path records the previously installed CLI artifact, binds update and rollback to registry/tarball/integrity identities, verifies the resulting global package content, and prints exact recovery guidance.
- A CLI newer than the registry is reported and left unchanged; this proposal has no implicit downgrade path.
- Claude delegates to its native in-place update command while preserving the detected plugin ID and installation scope.
- Codex snapshots the exact plugin registration, enablement, and cached payload before the documented marketplace-refresh plus remove/add sequence, and restores that snapshot if reinstall or validation fails.
- Antigravity creates a temporary backup of the detected staged NodeSource plugin and its matching import-manifest registration and restores both if reinstall fails.
- Pi delegates package replacement to `pi update` without rewriting its settings entries, package filters, MCP configuration, or credentials.
- The fallback parent durably snapshots the exact installation's owned skill/link paths, field-level MCP state, and tracking before launching the child; it restores or recovers them after child failure, timeout, signal, interrupted execution, reconciliation failure, or validation failure.
- Update operations never delete shared NodeSource credentials.
- The feature can be reverted by removing the new command/service modules and scripts; existing `setup`, `install`, `doctor`, `restore`, and `uninstall` contracts remain unchanged.
- A bad release can be rolled back by republishing or reinstalling the prior known-good package/plugin version and restoring generated manifests from the corresponding Git tag.

## Affected Components

- `packages/core/src/cli.ts` — new commands and update flags.
- `packages/core/src/index.ts` — public update/version API surface.
- `packages/core/src/update/` — update planning, version comparison, command execution, result contracts, package-manager detection, and the package-internal owned-asset refresh entrypoint.
- `packages/core/src/harnesses/` — harness-owned update strategies and native/fallback installation detection.
- `~/.pi/agent/settings.json`, a detected current-project `.pi/settings.json`, and their corresponding Pi package caches — source/scope evidence for package-owned updates; project access is disclosed/approved and settings remain unchanged.
- `~/.config/opencode/skills/`, `~/.config/opencode/opencode.jsonc`, and fallback tracking/backups — transactional direct-install reconciliation for OpenCode.
- `~/.codex/config.toml` and the detected Codex plugin cache — exact plugin registration/enablement and prior payload included in transactional reinstall rollback.
- `~/.gemini/config/{plugins,import_manifest.json}` and `~/.gemini/antigravity-cli/{plugins,import_manifest.json}` — supported Antigravity staged-root/registration pairs included in transactional backup/rollback.
- Update formatting utilities — plan, progress, summary, and sanitized machine-readable output for the new commands; existing `doctor` behavior remains unchanged.
- `packages/core/test/unit/update/` — version, planning, detection, safety, and output tests.
- `packages/core/test/integration/` — mocked CLI/harness update flows, partial failures, rollback, and exit codes.
- `bundle.json`, `packages/core/package.json`, `packages/pi-plugin/package.json` — coordinated release version and registration of the internal fallback-refresh binary.
- `scripts/` and root `package.json` — release preparation and drift checks.
- `.claude-plugin/marketplace.json`, `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`, and `packages/core/bundle.json` — generated version-bearing outputs.
- `README.md` and package READMEs — user and maintainer update instructions.
- `openspec/specs/installation-and-auth/spec.md` — referenced compatibility contract that update must preserve; unchanged by this proposal.

## Success Criteria

- `nsolid-plugin version` and its bare `--version` alias report the running CLI and bundled plugin versions without network access; the command form also supports JSON output.
- `nsolid-plugin update --check` performs no writes or subprocess mutations and clearly reports whether the CLI is current.
- Each supported harness has a deterministic update strategy with actionable output when its CLI is unavailable, its installation type is unsupported, or its source identity cannot be safely reused.
- Claude and Codex version checks use only the source metadata carried by their detected marketplace; missing, stale, or unsupported evidence reports `unknown` instead of reading the NodeSource marketplace.
- `nsolid-plugin update --all` updates all detected targets, preserves credentials and user-owned configuration, summarizes every target, and uses deterministic exit codes for success/no-op, operational failure, and unavailable mutation, including an explicit successful empty inventory.
- Native and fallback installations detected for the same harness are represented and updated as separate targets; one ownership never silently replaces the other.
- Interactive destructive/replacement steps require confirmation; `--yes` enables non-interactive automation.
- Network, registry, missing-binary, permission, corrupt-state, and partial-update failures are covered by tests and never expose credentials.
- Release preparation propagates one requested semantic version to every version-bearing source/generated file and never publishes, tags, commits, or pushes.
- Release checking fails when package, bundle, or generated manifest versions drift.
- Existing installation, authentication, uninstall, restore, doctor, lint, build, and test behavior remains green.

Acceptance tests:

1. Mock npm reporting a newer, equal, and older-than-registry CLI artifact and verify registry/tarball/integrity binding, on-disk content validation, no-downgrade behavior, declined update, unsupported wrappers, and exact rollback guidance.
2. Mock current and newer Claude/Codex plugin versions, including alternate marketplace IDs, source repositories, stale local snapshots, and Claude installation scopes; verify exact-source version resolution, no canonical-source substitution, Claude’s scoped native update, and Codex’s marketplace-refresh plus transactional remove/add flow.
3. Simulate Codex and Antigravity reinstall failures and verify restoration of the prior plugin registration, enablement, cached/staged payload, and matching manifest state.
4. Mock user-only, project-only, and combined canonical Pi scopes plus pinned/conflicting sources; verify one scope-aware native update command and unchanged settings.
5. Refresh a tracked OpenCode installation through the internal integrity-verified binary and parent transaction manifest; verify identity revalidation, atomic skill replacement, field-level MCP ownership, parent rollback, next-run recovery, and unchanged public `install` behavior without modifying sibling or user-owned artifacts.
6. Run `--all` with coexisting native/fallback installations and one failed target or version lookup; verify every installation is represented, later independent targets still run, credentials remain untouched, and the final exit code is non-zero.
7. Prepare a patch version in a fixture repository and verify all version-bearing files become equal while no publish/tag/push command executes.
8. Introduce version drift in each controlled file and verify the release check identifies the exact mismatch.
