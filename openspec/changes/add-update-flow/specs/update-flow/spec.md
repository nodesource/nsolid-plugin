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
**And** the overall invocation exits with code `1`
**And** preserves every installation whose lookup failed

### Requirement: Safe CLI self-update

The default `nsolid-plugin update` scope SHALL update only a positively identified global CLI installation, SHALL require approval before mutation, and SHALL bind registry discovery, package execution, and post-update validation to one integrity-verified artifact.

#### Scenario: CLI update with a supported global package manager

**Given** the CLI was installed globally by npm or pnpm
**And** the registry reports a newer stable version
**When** the user runs `nsolid-plugin update`
**Then** the command displays the current version, target version, package manager, and exact planned operation
**And** asks for confirmation in an interactive terminal
**And** freezes the effective registry origin, exact tarball URL, stable version, and registry-provided integrity digest in the plan rather than passing the mutable `latest` tag during execution
**And** downloads only that tarball and verifies its integrity before confirmation can authorize installation
**And** after confirmation invokes npm or pnpm with the verified local tarball and a fixed argument array, without ambient registry resolution
**And** verifies both that the child process succeeded and that the positively identified global package root contains `nsolid-plugin` with the planned version and content identity
**And** reports that a new shell or command invocation may be required
**And** prints the same package manager's exact command for restoring `nsolid-plugin@<previous-version>`

#### Scenario: Package manager exits successfully without installing the planned CLI

**Given** an exact CLI update was approved
**When** the package-manager process exits successfully but the identified global package root is missing, belongs to a different package, reports a version other than the planned version, or cannot prove the planned content identity
**Then** the update result is `failed`
**And** the command does not report the CLI as updated
**And** prints the exact previous-version restore command
**And** exits with code `1`

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
**And** exits with code `2` and guidance to pass `--yes`
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
**And** a mutating update exits with code `2` while a read-only check exits with code `0`

### Requirement: Harness-owned update strategies

The updater SHALL preserve native/package ownership, bind discovery and execution to the same immutable source identity, and delegate each supported harness update to a deterministic strategy without starting OAuth.

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
**And** inventory carries that marketplace's exact repository/ref and relative manifest path, or its exact local snapshot path, freshness evidence, and content digest, for version resolution
**And** planning resolves every supported Git ref to a full commit object ID and content digest used by both lookup and execution
**And** latest-version lookup reads only that carried source
**And** a local snapshot must retain the planned digest through execution and post-update validation
**And** a missing revision, mutable ref that cannot be resolved and honored by the harness, stale snapshot, ambiguous source, traversal-capable path, or unsupported version-source evidence reports `unknown` or `unsupported` without querying the NodeSource marketplace
**And** the strategy never substitutes `nodesource`
**And** an unqualified, malformed, or ambiguous ID, or a Claude installation with unknown scope, returns `unsupported` without mutation

#### Scenario: Update Claude native plugin

**Given** `nsolid-plugin@<marketplace>` is installed natively in Claude at a detected `user`, `project`, `local`, or `managed` scope
**And** the `claude` executable is available
**When** the Claude update strategy runs
**Then** the carried marketplace source resolves to an immutable commit and content digest that Claude can honor for this update
**And** it invokes `claude plugin update nsolid-plugin@<marketplace> --scope <detected-scope>` with a fixed executable and argument array
**And** verifies the native update command succeeded
**And** verifies the installed payload matches the planned commit/content identity rather than version alone
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
**And** verifies the refreshed marketplace snapshot and resulting local payload match the planned commit and content digest
**And** reapplies the prior enabled state and preserves unrelated Codex configuration
**And** reports that a new Codex session is required
**And** does not run the fallback installer

#### Scenario: Codex reinstall fails

**Given** the prior Codex plugin registration and cached payload were backed up
**When** removal succeeds but add or installed-version validation fails
**Then** the updater restores the prior plugin registration, enabled state, user-owned fields, and cached payload
**And** preserves unrelated `~/.codex/config.toml` entries
**And** reports whether rollback succeeded
**And** exits with code `1`
**And** provides the exact detected plugin remove/add commands for manual recovery

#### Scenario: Update Pi package-owned skills

**Given** the exact unpinned `npm:nsolid-pi-plugin` source is installed in Pi user settings, current-project settings, or both
**And** the `pi` executable is available
**When** the Pi update strategy runs
**Then** inventory coalesces every canonical matching scope into one Pi update target
**And** the plan displays whether user and/or project package caches will be updated and displays the project root when applicable
**And** a user-only target invokes `pi update npm:nsolid-pi-plugin --no-approve`
**And** a target containing the detected project scope invokes `pi update npm:nsolid-pi-plugin --approve` only after the plan is approved
**And** that command's `cwd` is the canonical project root captured by inventory
**And** immediately before execution the strategy revalidates the project directory identity, effective settings entries, scopes, canonical package source, and affected cache roots against the approved plan
**And** any drift fails without invoking `pi update`
**And** verifies every affected package cache contains `nsolid-pi-plugin` at a valid version no older than the registry version observed during planning
**And** verifies the resulting caches retain the planned registry provenance and integrity/content evidence
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
**Then** it resolves and freezes the exact `nsolid-plugin` registry, tarball, stable version, and integrity in the plan
**And** requires an available supported package executor
**And** the parent creates and durably records a complete snapshot of the selected installation's owned skill/link paths, owned MCP fields, and tracking state before launching a package executor
**And** invokes `nsolid-plugin-refresh-owned --transaction <parent-manifest>` from the integrity-verified local tarball with a fixed argument array
**And** runs the package executor from a restrictive temporary working directory where a workspace-local `nsolid-plugin` binary cannot shadow the resolved payload
**And** the parent manifest binds the exact `installationId`, harness, canonical paths, tracking path and digest, and field-level MCP ownership approved in the plan
**And** the internal refresh binary revalidates that identity and refuses absent, stale, sibling, broadened, ambiguous, or untracked ownership
**And** does not invoke `opencode plugin`
**And** completely replaces tracked skill directories, removes previously tracked skills absent from the new bundle, and merges only the new bundle's NodeSource MCP entries
**And** preserves untracked/user-owned skill paths, unrelated MCP entries, other configuration, and valid credentials
**And** validates installed skills, MCP entries, tracking paths, and `bundleVersion` before deleting the backup

Fallback mutation SHALL be authorized by an exact parent-owned installation manifest and SHALL remain recoverable without cooperation from the package-executor child.

#### Scenario: Fallback tracking or ownership changes after planning

**Given** a fallback plan and parent transaction manifest were approved
**And** the tracking file, an owned path, a shared-path membership, or an owned MCP field changes before the child starts mutation
**When** the internal refresh validates the manifest
**Then** it fails without mutating any installation
**And** it does not rediscover another installation from the harness name
**And** a user-modified MCP field or sibling installation remains unchanged

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
**And** exits with code `1`

#### Scenario: Fallback child terminates after mutation

**Given** the parent durably recorded a complete snapshot and marked the fallback journal `mutating`
**When** npm, pnpm, or the internal refresh process times out, crashes, receives a signal, or exits without a structured rollback result after mutation began
**Then** the parent restores the selected installation from its own snapshot
**And** records whether parent-owned recovery succeeded
**And** retains an incomplete journal when automatic restoration cannot be proven complete
**And** exits with code `1`

#### Scenario: Recover an interrupted fallback transaction on the next run

**Given** a prior invocation left a non-committed durable fallback journal
**When** any later update invocation starts
**Then** recovery runs before new inventory or mutation
**And** restores and validates the exact recorded installation or reports a recovery failure
**And** no new update plan executes while unresolved recovery state remains

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
**And** a mutating invocation exits with code `2`, while a read-only check exits with code `0`

#### Scenario: Required harness executable is missing

**Given** a native N|Solid installation is detected
**But** its owning executable is unavailable on `PATH`
**When** its update strategy runs
**Then** no fallback replacement is attempted automatically
**And** the target fails with a missing-executable error
**And** output identifies the missing executable and manual command

### Requirement: Transactional Antigravity replacement

The Antigravity strategy SHALL install a commit-pinned source and back up and validate the staged NodeSource plugin because AGY has no native plugin-update command.

#### Scenario: Update Antigravity native plugin

**Given** the GitHub-root N|Solid plugin is staged in exactly one supported layout
**And** the `agy` executable is available
**When** the Antigravity update strategy runs
**Then** the layout is either `~/.gemini/config/plugins/nsolid-plugin` with `~/.gemini/config/import_manifest.json` or `~/.gemini/antigravity-cli/plugins/nsolid-plugin` with `~/.gemini/antigravity-cli/import_manifest.json`
**And** it creates a temporary backup of the detected staged NodeSource plugin and matching N|Solid import-manifest entry
**And** confirms replacement unless `--yes` was supplied
**And** resolves the canonical repository to a full commit and invokes `agy plugin uninstall nsolid-plugin` followed by installation of that commit-pinned Git source
**And** validates `plugin.json`, `bundle.json`, canonical skill presence, and the N|Solid entry in the detected matching import manifest
**And** verifies the staged payload matches the planned commit/content digest
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
**And** exits with code `1`
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
**And** the overall process exits with code `1`
**And** no credential value appears in logs or JSON

#### Scenario: Update-all detects no targets

**Given** no CLI or harness installation is detected
**When** the user runs `nsolid-plugin update --all` or `nsolid-plugin update --all --check`
**Then** no confirmation, child process, or filesystem mutation occurs
**And** the result is an explicit successful no-op with `results: []` and zero counts for every status
**And** human output reports that no targets were detected
**And** the process exits with code `0`

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
**And** the summary contains `exitCode` with the exact process code selected from `0`, `1`, or `2`
**And** each result contains `installationId`, `target`, `ownership`, `status`, optional `currentVersion` and `latestVersion`, `changed`, optional restart guidance and rollback status, and sanitized errors

#### Scenario: Exit codes distinguish unavailable mutation from failure

**Given** an update or check has completed
**When** the CLI maps its summary to a process exit code
**Then** code `0` represents completed work or an intentional informational no-op, including checks, `current`, `newer-than-registry`, `skipped`, and an empty `--all`
**And** code `1` represents an operational lookup, planning, execution, validation, rollback, or recovery failure
**And** code `2` represents a requested mutation that was unavailable without operational failure because approval was missing or its result was `not-installed`, `unsupported`, or mutation-blocking `unknown`
**And** code `1` takes precedence over code `2` for aggregate results
**And** JSON status data remains present so automation can distinguish individual results sharing an exit category

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
