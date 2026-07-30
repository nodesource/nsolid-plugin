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
- make plain `update` target the npm CLI, `--harness <harness>` target one harness installation, and `--all` target the CLI plus every detected N|Solid installation;
- add `--check` for a read-only status check and retain `--json`, `--yes`, `--verbose`, and `--no-color` behavior where applicable;
- delegate native updates to the owning harness:
  - Claude: refresh/update `nsolid-plugin@nodesource`;
  - Codex: upgrade the `nodesource` Git marketplace and refresh the installed version;
  - Antigravity: safely reinstall the GitHub-root plugin with backup/rollback;
  - Pi: update `npm:nsolid-pi-plugin`;
  - OpenCode, which has no native package owner, and other fallback installations: reinstall from the latest published CLI bundle;
- preserve credentials and non-NodeSource configuration throughout updates;
- isolate failures during `--all` so one harness failure does not prevent remaining updates, while returning a failing exit status and a per-target summary.

For maintainers:

- establish one release version across `bundle.json`, the core npm package, the Pi npm package, and generated version-bearing manifests;
- add release preparation/check tooling that performs or validates version propagation without publishing, tagging, or pushing;
- require update-visible releases to increment the version before generated root manifests are committed.

## Rollback Plan

- The CLI update path records the previously installed CLI version and prints the exact package-manager command needed to restore it.
- Native harness updates rely on the harness owner’s cache where available. Antigravity creates a temporary backup of the staged NodeSource plugin and restores it if reinstall fails.
- Fallback installers continue using their existing config backups and idempotent merge behavior.
- Update operations never delete shared NodeSource credentials.
- The feature can be reverted by removing the new command/service modules and scripts; existing `setup`, `install`, `doctor`, `restore`, and `uninstall` contracts remain unchanged.
- A bad release can be rolled back by republishing or reinstalling the prior known-good package/plugin version and restoring generated manifests from the corresponding Git tag.

## Affected Components

- `packages/core/src/cli.ts` — new commands and update flags.
- `packages/core/src/index.ts` — public update/version API surface.
- `packages/core/src/update/` — update planning, version comparison, command execution, result contracts, and package-manager detection.
- `packages/core/src/harnesses/` — harness-owned update strategies and native/fallback installation detection.
- `packages/core/src/index.ts` (the `doctor` function) and formatting utilities — optional update availability in health/status output.
- `packages/core/test/unit/update/` — version, planning, detection, safety, and output tests.
- `packages/core/test/integration/` — mocked CLI/harness update flows, partial failures, rollback, and exit codes.
- `bundle.json`, `packages/core/package.json`, `packages/pi-plugin/package.json` — coordinated release version.
- `scripts/` and root `package.json` — release preparation and drift checks.
- `.claude-plugin/marketplace.json`, `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`, and `packages/core/bundle.json` — generated version-bearing outputs.
- `README.md` and package READMEs — user and maintainer update instructions.
- `openspec/specs/installation-and-auth/spec.md` — referenced compatibility contract that update must preserve; unchanged by this proposal.

## Success Criteria

- `nsolid-plugin version` and its bare `--version` alias report the running CLI and bundled plugin versions without network access; the command form also supports JSON output.
- `nsolid-plugin update --check` performs no writes or subprocess mutations and clearly reports whether the CLI is current.
- Each supported harness has a deterministic update strategy with actionable output when its CLI is unavailable or its installation type is unsupported.
- `nsolid-plugin update --all` updates all detected targets, preserves credentials and user-owned configuration, summarizes every target, and exits non-zero on any failure.
- Interactive destructive/replacement steps require confirmation; `--yes` enables non-interactive automation.
- Network, registry, missing-binary, permission, corrupt-state, and partial-update failures are covered by tests and never expose credentials.
- Release preparation propagates one requested semantic version to every version-bearing source/generated file and never publishes, tags, commits, or pushes.
- Release checking fails when package, bundle, or generated manifest versions drift.
- Existing installation, authentication, uninstall, restore, doctor, lint, build, and test behavior remains green.

Acceptance tests:

1. Mock npm reporting a newer CLI version and verify check-only, confirmed update, declined update, and rollback guidance.
2. Mock current and newer Claude/Codex plugin versions and verify the owning marketplace/update commands and restart guidance.
3. Simulate an Antigravity reinstall failure and verify restoration of the prior staged plugin.
4. Mock a Pi package update and an OpenCode fallback refresh from the latest CLI bundle.
5. Run `--all` with one failed target and verify later targets still run, credentials remain untouched, and the final exit code is non-zero.
6. Prepare a patch version in a fixture repository and verify all version-bearing files become equal while no publish/tag/push command executes.
7. Introduce version drift in each controlled file and verify the release check identifies the exact mismatch.
