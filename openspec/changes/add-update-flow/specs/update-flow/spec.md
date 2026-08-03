# Update Flow Specification

## ADDED Requirements

### Requirement: Running version reporting

The CLI SHALL expose the running npm package version and bundled plugin version without network access or mutation.

#### Scenario: Report running versions

**Given** the `nsolid-plugin` CLI is runnable
**When** the user runs `nsolid-plugin version`
**Then** the command reports the running `nsolid-plugin` package version
**And** reports the bundled plugin version from `bundle.json`
**And** `--json` returns a stable object containing `cliVersion` and `bundleVersion`
**And** the command performs no network requests or writes

#### Scenario: Report versions with the conventional flag

**Given** the `nsolid-plugin` CLI is runnable
**When** the user runs bare `nsolid-plugin --version`
**Then** the command is an alias for the human-readable `nsolid-plugin version` output
**And** reports both the running CLI package version and bundled plugin version
**And** performs no network requests or writes

### Requirement: Read-only update checks

The updater SHALL compare installed and latest versions without invoking any mutating strategy when `--check` is supplied.

#### Scenario: Check whether the CLI is current

**Given** the npm registry reports a stable `latest` version for `nsolid-plugin`
**When** the user runs `nsolid-plugin update --check`
**Then** the command compares the running CLI semantic version with the registry version
**And** reports `current`, `update-available`, or `newer-than-registry`
**And** does not invoke a package manager or modify any file
**And** `--json` returns the current version, latest version, status, and target identifier
**And** exits successfully, including when the status is `update-available`

#### Scenario: Do not downgrade a CLI newer than the registry

**Given** the running CLI semantic version is greater than the registry `latest`
**When** the user runs `nsolid-plugin update`
**Then** the command reports `newer-than-registry`
**And** displays the current and registry versions
**And** does not invoke a package manager or modify the installation
**And** exits successfully
**And** does not provide an implicit downgrade path

#### Scenario: Check every detected target

**Given** multiple N|Solid installations are detectable
**When** the user runs `nsolid-plugin update --all --check`
**Then** every detected installation is inspected without invoking install, update, uninstall, package-manager, tracking, or configuration mutations
**And** targets whose installed version cannot be determined report `unknown`
**And** the command distinguishes `unknown` from `current`

#### Scenario: Registry lookup fails

**Given** the required npm, fixed native-Git, or exact carried marketplace version source for one target is unreachable, times out, returns invalid data, or returns a non-semantic version
**When** the user checks or performs an update
**Then** the command reports a sanitized lookup failure for the affected target without exposing response bodies, repository credentials, or credential paths
**And** represents the affected installation in the ordered plan with a sanitized planning error and no mutation steps
**And** performs no mutation for the affected target
**And** an `--all` invocation continues planning or executing remaining independent targets and records their results
**And** the overall invocation exits non-zero
**And** preserves every installation whose lookup failed

### Requirement: Safe CLI self-update

The default `nsolid-plugin update` scope SHALL update only a positively identified global CLI installation and SHALL require approval before mutation.

#### Scenario: CLI update with a supported global package manager

**Given** the CLI was installed globally by npm or pnpm
**And** the registry reports a newer stable version
**When** the user runs `nsolid-plugin update`
**Then** the command displays the current version, target version, package manager, and exact planned operation
**And** asks for confirmation in an interactive terminal
**And** freezes the resolved semantic version in the plan rather than passing the mutable `latest` tag during execution
**And** after confirmation invokes `npm install --global nsolid-plugin@<resolved-version>` or `pnpm add --global nsolid-plugin@<resolved-version>` with a fixed argument array
**And** verifies both that the child process succeeded and that the positively identified global package root contains `nsolid-plugin` at the resolved version
**And** reports that a new shell or command invocation may be required
**And** prints the same package manager's exact command for restoring `nsolid-plugin@<previous-version>`

#### Scenario: Package manager exits successfully without installing the planned CLI

**Given** an exact CLI update was approved
**When** the package-manager process exits successfully but the identified global package root is missing, belongs to a different package, or reports a version other than the planned version
**Then** the update result is `failed`
**And** the command does not report the CLI as updated
**And** prints the exact previous-version restore command
**And** exits non-zero

#### Scenario: User declines a CLI update

**Given** an update is available
**When** the user declines the confirmation
**Then** no package-manager process runs
**And** the result is `skipped`
**And** the command exits successfully

#### Scenario: Non-interactive CLI update

**Given** an update is available
**And** standard input is not interactive
**When** the user runs `nsolid-plugin update` without `--yes`
**Then** the command performs no mutation
**And** exits non-zero with guidance to pass `--yes`
**When** the user reruns with `--yes`
**Then** the command performs the displayed fixed update plan without prompting

#### Scenario: CLI is already current

**Given** the running CLI version equals the registry `latest` version
**When** the user runs `nsolid-plugin update`
**Then** no package-manager process runs
**And** the command reports `already current`
**And** exits successfully

#### Scenario: Unsupported CLI installation source

**Given** the running CLI was launched from a workspace, local path, `npx`, Volta, Yarn, Bun, or an installation source/global root that cannot be safely identified as npm or pnpm owned
**When** the user runs `nsolid-plugin update`
**Then** the command does not guess a package manager or modify the installation
**And** reports the latest version when it can be resolved
**And** prints safe exact-version manual commands for npm, pnpm, ephemeral execution, and the detected wrapper/source when known
**And** the result status is `unsupported`
**And** a mutating update exits non-zero while a read-only check exits successfully

### Requirement: Harness-owned update strategies

The updater SHALL preserve native/package ownership and delegate each supported harness update to a deterministic strategy without starting OAuth.

#### Scenario: Update one installed native harness

**Given** the requested harness has a detected native N|Solid plugin installation
**When** the user runs `nsolid-plugin update --harness <harness>`
**Then** only that harness target is planned
**And** the command delegates to the harness-owned update strategy
**And** shared NodeSource credentials remain unchanged
**And** no OAuth browser or callback server starts
**And** the result includes versions when discoverable, status, and restart guidance

#### Scenario: Preserve each detected native source identity

**Given** Claude or Codex records `nsolid-plugin@<marketplace>` under a marketplace other than `nodesource`
**When** the corresponding native update strategy runs
**Then** Claude uses the detected complete plugin ID and installation scope
**And** Codex refreshes the detected marketplace and reinstalls the detected complete plugin ID
**And** inventory carries that marketplace's exact repository/ref and relative manifest path, or its exact local snapshot path and freshness evidence, for version resolution
**And** latest-version lookup reads only that carried source
**And** missing, stale, ambiguous, traversal-capable, or unsupported version-source evidence reports `unknown` or `unsupported` without querying the NodeSource marketplace
**And** the strategy never substitutes `nodesource`
**And** an unqualified, malformed, or ambiguous ID, or a Claude installation with unknown scope, returns `unsupported` without mutation

#### Scenario: Update Claude native plugin

**Given** `nsolid-plugin@<marketplace>` is installed natively in Claude at a detected `user`, `project`, `local`, or `managed` scope
**And** the `claude` executable is available
**When** the Claude update strategy runs
**Then** it invokes `claude plugin update nsolid-plugin@<marketplace> --scope <detected-scope>` with a fixed executable and argument array
**And** verifies the native update command succeeded
**And** reports `/reload-plugins` or restart guidance
**And** does not run the fallback installer

#### Scenario: Update Codex native plugin

**Given** `nsolid-plugin@<marketplace>` is installed natively in Codex
**And** the `codex` executable is available
**When** the Codex update strategy runs
**Then** it invokes `codex plugin marketplace upgrade <marketplace>`
**And** verifies the marketplace refresh succeeded
**And** treats that command only as a marketplace snapshot refresh, not as an installed-plugin update
**And** creates a restrictive temporary backup of the exact plugin registration, enabled state, user-owned plugin fields, and cached installed payload
**And** confirms replacement unless `--yes` was supplied
**And** invokes `codex plugin remove nsolid-plugin@<marketplace>` followed by `codex plugin add nsolid-plugin@<marketplace>` with fixed argument arrays
**And** verifies the resulting local version/content matches the refreshed marketplace entry
**And** reapplies the prior enabled state and preserves unrelated Codex configuration
**And** reports that a new Codex session is required
**And** does not run the fallback installer

#### Scenario: Codex reinstall fails

**Given** the prior Codex plugin registration and cached payload were backed up
**When** removal succeeds but add or installed-version validation fails
**Then** the updater restores the prior plugin registration, enabled state, user-owned fields, and cached payload
**And** preserves unrelated `~/.codex/config.toml` entries
**And** reports whether rollback succeeded
**And** exits non-zero
**And** provides the exact detected plugin remove/add commands for manual recovery

#### Scenario: Update Pi package-owned skills

**Given** the exact unpinned `npm:nsolid-pi-plugin` source is installed in Pi user settings, current-project settings, or both
**And** the `pi` executable is available
**When** the Pi update strategy runs
**Then** inventory coalesces every canonical matching scope into one Pi update target
**And** the plan displays whether user and/or project package caches will be updated and displays the project root when applicable
**And** a user-only target invokes `pi update npm:nsolid-pi-plugin --no-approve`
**And** a target containing the detected project scope invokes `pi update npm:nsolid-pi-plugin --approve` only after the plan is approved
**And** verifies every affected package cache contains `nsolid-pi-plugin` at a valid version no older than the registry version observed during planning
**And** reports the actual installed version, accepting a newer version published while Pi's native unpinned update was running
**And** does not copy Pi skills into user-level skill directories
**And** reports `/reload` or restart guidance
**And** leaves Pi source entries, object-form package filters, trust settings, MCP configuration, and NodeSource credentials intact

#### Scenario: Same canonical Pi identity exists in both scopes

**Given** exact unpinned `npm:nsolid-pi-plugin` entries exist in both user and current-project settings
**When** the Pi update strategy plans and executes the update
**Then** the plan contains one package-owned Pi target with both scopes
**And** invokes the Pi update command exactly once
**And** does not report one duplicate result per scope

#### Scenario: Reject a non-canonical Pi source

**Given** Pi detects a local, Git, version-pinned, conflicting, or ambiguous source/entry for `nsolid-pi-plugin` in any matching user or current-project scope
**When** the user runs a Pi update
**Then** the result status is `unsupported`
**And** no package source is substituted
**And** a canonical entry in another scope is not partially updated while the conflicting entry remains effective
**And** no Pi package or configuration is mutated
**And** the output provides manual guidance

#### Scenario: Update OpenCode or another fallback installation

**Given** N|Solid is tracked as a direct OpenCode installation, rather than as an OpenCode npm/local plugin, or another target uses the tracked N|Solid fallback installer
**When** its update strategy runs
**Then** it resolves and freezes the exact stable `nsolid-plugin` registry version in the plan
**And** requires an available supported package executor
**And** snapshots the target's tracked NodeSource-owned skill directories, affected MCP configuration, and complete tracking state before replacement
**And** invokes either `npm exec --yes --package=nsolid-plugin@<resolved-version> -- nsolid-plugin-refresh-owned --harness <target>` or `pnpm --package=nsolid-plugin@<resolved-version> dlx nsolid-plugin-refresh-owned --harness <target>` with fixed argument arrays
**And** runs the package executor from a restrictive temporary working directory where a workspace-local `nsolid-plugin` binary cannot shadow the resolved payload
**And** the internal refresh binary refuses absent, ambiguous, or untracked ownership and does not broaden the planned harness
**And** does not invoke `opencode plugin`
**And** completely replaces tracked skill directories, removes previously tracked skills absent from the new bundle, and merges only the new bundle's NodeSource MCP entries
**And** preserves untracked/user-owned skill paths, unrelated MCP entries, other configuration, and valid credentials
**And** validates installed skills, MCP entries, tracking paths, and `bundleVersion` before deleting the backup

#### Scenario: No supported exact-package executor is available

**Given** a tracked direct/fallback installation is updateable but neither `npm exec` nor `pnpm dlx` is available
**When** its update strategy is planned
**Then** the target is `unsupported`
**And** no backup, child process, or filesystem mutation runs
**And** the output provides the exact planned package version and manual commands

#### Scenario: Direct/fallback refresh cannot prove ownership

**Given** N|Solid-like skills or MCP entries exist but sufficient per-harness tracking ownership is absent or ambiguous
**When** a direct/fallback update is planned
**Then** the target is `unsupported`
**And** no path is selected from an `ns-` prefix or name-only guess
**And** no package executor or filesystem mutation runs
**And** the output provides repair/reinstall guidance

#### Scenario: New fallback bundle collides with an untracked destination

**Given** the exact new bundle contains a skill whose target path already exists but is not owned by the target's fallback tracking
**When** the child installer performs its preflight
**Then** the refresh fails before overwriting that path
**And** the untracked path remains byte-for-byte unchanged
**And** the surrounding transaction restores any earlier mutation from the same refresh
**And** the output identifies the conflicting destination without exposing its contents

#### Scenario: OpenCode or fallback refresh fails

**Given** a tracked direct/fallback installation was backed up
**When** exact-package execution, skill reconciliation, MCP merge, tracking update, or post-install validation fails
**Then** the updater restores the prior tracked skill directories, affected configuration, and tracking state
**And** restores stale tracked assets removed during reconciliation
**And** preserves unrelated OpenCode/fallback artifacts
**And** reports whether rollback succeeded
**And** exits non-zero

#### Scenario: Update coexisting native and fallback installations

**Given** the same harness has both a detected native plugin and tracked fallback artifacts
**When** the user runs `nsolid-plugin update --harness <harness>` or `nsolid-plugin update --all`
**Then** the plan contains one installation item for each ownership
**And** each item has a distinct installation identifier and source evidence
**And** native and fallback updates execute independently
**And** a native failure does not switch ownership or hide the fallback result

#### Scenario: Requested harness is not installed

**Given** neither a native nor fallback N|Solid installation is detected for the requested harness
**When** the user runs `nsolid-plugin update --harness <harness>`
**Then** no install is performed implicitly
**And** the coordinator emits one non-mutating item with `ownership: none` and `source.kind: none` for the requested harness
**And** the target result is `not-installed`
**And** the command prints appropriate installation guidance

#### Scenario: Required harness executable is missing

**Given** a native N|Solid installation is detected
**But** its owning executable is unavailable on `PATH`
**When** its update strategy runs
**Then** no fallback replacement is attempted automatically
**And** the target fails with a missing-executable error
**And** output identifies the missing executable and manual command

### Requirement: Transactional Antigravity replacement

The Antigravity strategy SHALL back up and validate the staged NodeSource plugin because AGY has no native plugin-update command.

#### Scenario: Update Antigravity native plugin

**Given** the GitHub-root N|Solid plugin is staged in exactly one supported layout
**And** the `agy` executable is available
**When** the Antigravity update strategy runs
**Then** the layout is either `~/.gemini/config/plugins/nsolid-plugin` with `~/.gemini/config/import_manifest.json` or `~/.gemini/antigravity-cli/plugins/nsolid-plugin` with `~/.gemini/antigravity-cli/import_manifest.json`
**And** it creates a temporary backup of the detected staged NodeSource plugin and matching N|Solid import-manifest entry
**And** confirms replacement unless `--yes` was supplied
**And** invokes `agy plugin uninstall nsolid-plugin` followed by `agy plugin install https://github.com/NodeSource/nsolid-plugin.git`
**And** validates `plugin.json`, `bundle.json`, canonical skill presence, and the N|Solid entry in the detected matching import manifest
**And** removes the backup only after the new staged plugin and registration validate
**And** preserves `~/.agents/.nodesource-auth.json`

#### Scenario: Antigravity layout is ambiguous or unsupported

**Given** both supported staged layouts are present, or the detected plugin root has no matching supported manifest location
**When** the Antigravity update strategy plans an update
**Then** the result status is `unsupported`
**And** no AGY command or filesystem mutation runs
**And** the output identifies the conflicting or unsupported paths

#### Scenario: Antigravity reinstall fails

**Given** the previous Antigravity plugin was backed up
**When** uninstall succeeds but reinstall or validation fails
**Then** the updater restores the previous staged plugin atomically where supported
**And** restores the previous N|Solid entry in the matching detected import manifest while preserving unrelated imports
**And** reports whether rollback succeeded
**And** exits non-zero
**And** provides a manual reinstall command

### Requirement: Deterministic multi-target orchestration

The updater SHALL plan targets before mutation, execute them sequentially in deterministic order, and isolate target failures.

#### Scenario: Update every detected target

**Given** one or more N|Solid CLI or harness installations are detected
**When** the user runs `nsolid-plugin update --all`
**Then** the updater displays one ordered plan containing every detected installation
**And** each plan item lists every ordered external command, filesystem mutation, validation, and rollback step before confirmation
**And** updates the CLI target first when supported
**And** updates detected installation targets sequentially in deterministic harness and ownership order
**And** execution introduces no external command absent from the approved plan
**And** records a result for every planned installation
**And** prints counts for every `UpdateStatus`, including `newer-than-registry`, `unsupported`, and `unknown`

#### Scenario: One target fails during update-all

**Given** multiple update targets were planned
**When** one target fails
**Then** remaining independent targets are attempted
**And** the summary includes the failed target and actionable error
**And** the overall process exits non-zero
**And** no credential value appears in logs or JSON

#### Scenario: Conflicting update scopes

**Given** the user supplies both `--all` and `--harness`
**When** argument validation runs
**Then** the command rejects the invocation before network access or mutation
**And** explains that the scopes are mutually exclusive

### Requirement: Stable and sanitized update output

Update results SHALL support human-readable and machine-readable output without mixing progress into JSON or exposing secrets.

#### Scenario: Structured update output

**Given** the user passes `--json`
**When** an update or check completes
**Then** standard output contains exactly one valid JSON document
**And** progress and diagnostics are written to standard error
**And** each result contains `installationId`, `target`, `ownership`, `status`, optional `currentVersion` and `latestVersion`, `changed`, optional restart guidance and rollback status, and sanitized errors

### Requirement: Preserve existing installation behavior

Update operations SHALL retain all existing setup, installation, authentication, backup, merge, tracking, and uninstall safety contracts.

#### Scenario: Preserve credentials and user-owned configuration

**Given** the user has valid NodeSource credentials and non-NodeSource skills or MCP servers
**When** any update strategy succeeds, fails, or rolls back
**Then** credentials remain present and unchanged
**And** non-NodeSource skills and MCP entries remain unchanged
**And** update never invokes setup, login, or OAuth
**And** native strategy failure never silently switches to fallback ownership
**And** source identity is preserved for every supported native/package-owned update
**And** all external commands run without a shell and with fixed argument arrays

#### Scenario: Preserve the public install contract

**Given** a tracked fallback installation needs transactional stale-asset reconciliation during update
**When** the updater executes the exact published package
**Then** it uses the package-internal `nsolid-plugin-refresh-owned` entrypoint
**And** the public `nsolid-plugin install` command and programmatic `install()` API retain their existing copy, merge, tracking, collision, and repeat-install behavior
**And** invoking `install` outside an update does not remove stale tracked assets under the new update-only reconciliation rules
