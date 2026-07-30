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

#### Scenario: Check every detected target

**Given** multiple N|Solid installations are detectable
**When** the user runs `nsolid-plugin update --all --check`
**Then** every target is inspected without invoking install, update, uninstall, package-manager, tracking, or configuration mutations
**And** targets whose installed version cannot be determined report `unknown`
**And** the command distinguishes `unknown` from `current`

#### Scenario: Registry lookup fails

**Given** npm is unreachable, times out, returns invalid data, or returns a non-semantic version
**When** the user checks or performs an update
**Then** the command reports the registry failure without exposing response bodies containing credentials
**And** performs no update
**And** exits non-zero
**And** preserves the current installation

### Requirement: Safe CLI self-update

The default `nsolid-plugin update` scope SHALL update only a positively identified global CLI installation and SHALL require approval before mutation.

#### Scenario: CLI update with a supported global package manager

**Given** the CLI was installed globally by npm or pnpm
**And** the registry reports a newer stable version
**When** the user runs `nsolid-plugin update`
**Then** the command displays the current version, target version, package manager, and exact planned operation
**And** asks for confirmation in an interactive terminal
**And** after confirmation invokes the detected package manager with a fixed argument array to install `nsolid-plugin@<latest>`
**And** verifies the child process succeeded
**And** reports that a new shell or command invocation may be required
**And** prints the exact command for restoring the previous version

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

**Given** the running CLI was launched from a workspace, local path, `npx`, or an installation source that cannot be safely identified
**When** the user runs `nsolid-plugin update`
**Then** the command does not guess a package manager or modify the installation
**And** reports the latest version when it can be resolved
**And** prints safe manual commands for npm, pnpm, and `npx -y nsolid-plugin@latest`

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

#### Scenario: Update Claude native plugin

**Given** `nsolid-plugin@nodesource` is installed natively in Claude
**And** the `claude` executable is available
**When** the Claude update strategy runs
**Then** it invokes `claude plugin update nsolid-plugin@nodesource` with a fixed executable and argument array
**And** reports `/reload-plugins` or restart guidance
**And** does not run the fallback installer

#### Scenario: Update Codex native plugin

**Given** `nsolid-plugin@nodesource` is installed natively in Codex
**And** the `codex` executable is available
**When** the Codex update strategy runs
**Then** it invokes `codex plugin marketplace upgrade nodesource`
**And** verifies the marketplace refresh succeeded
**And** reports that a new Codex session is required
**And** does not remove the installed plugin or configuration

#### Scenario: Update Pi package-owned skills

**Given** `npm:nsolid-pi-plugin` is installed in Pi
**And** the `pi` executable is available
**When** the Pi update strategy runs
**Then** it invokes `pi update npm:nsolid-pi-plugin`
**And** does not copy Pi skills into user-level skill directories
**And** reports `/reload` or restart guidance
**And** leaves Pi MCP configuration and NodeSource credentials intact

#### Scenario: Update OpenCode or another fallback installation

**Given** the target is OpenCode, which has no native plugin/package update owner, or another target uses the N|Solid fallback/direct installer
**When** its update strategy runs
**Then** it resolves the latest published `nsolid-plugin` CLI bundle
**And** reruns the latest fallback installer only for that harness
**And** reuses existing idempotent skill and MCP merge behavior
**And** preserves non-NodeSource artifacts and valid credentials
**And** creates the normal configuration backup before config mutation

#### Scenario: Requested harness is not installed

**Given** neither a native nor fallback N|Solid installation is detected for the requested harness
**When** the user runs `nsolid-plugin update --harness <harness>`
**Then** no install is performed implicitly
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

**Given** the GitHub-root N|Solid plugin is staged by Antigravity
**And** the `agy` executable is available
**When** the Antigravity update strategy runs
**Then** it creates a temporary backup of the existing staged NodeSource plugin
**And** confirms replacement unless `--yes` was supplied
**And** invokes the supported uninstall/install sequence for `https://github.com/NodeSource/nsolid-plugin.git`
**And** removes the backup only after the new staged plugin validates
**And** preserves `~/.agents/.nodesource-auth.json`

#### Scenario: Antigravity reinstall fails

**Given** the previous Antigravity plugin was backed up
**When** uninstall succeeds but reinstall or validation fails
**Then** the updater restores the previous staged plugin atomically where supported
**And** reports whether rollback succeeded
**And** exits non-zero
**And** provides a manual reinstall command

### Requirement: Deterministic multi-target orchestration

The updater SHALL plan targets before mutation, execute them sequentially in deterministic order, and isolate target failures.

#### Scenario: Update every detected target

**Given** one or more N|Solid CLI or harness installations are detected
**When** the user runs `nsolid-plugin update --all`
**Then** the updater displays one ordered plan
**And** updates the CLI target first when supported
**And** updates detected harness targets sequentially in deterministic harness order
**And** records a result for every planned target
**And** prints counts for updated, current, skipped, not-installed, and failed

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
**And** each result contains `target`, `ownership`, `status`, optional versions, `changed`, optional restart guidance, and sanitized errors

### Requirement: Preserve existing installation behavior

Update operations SHALL retain all existing setup, installation, authentication, backup, merge, tracking, and uninstall safety contracts.

#### Scenario: Preserve credentials and user-owned configuration

**Given** the user has valid NodeSource credentials and non-NodeSource skills or MCP servers
**When** any update strategy succeeds, fails, or rolls back
**Then** credentials remain present and unchanged
**And** non-NodeSource skills and MCP entries remain unchanged
**And** update never invokes setup, login, or OAuth
**And** native strategy failure never silently switches to fallback ownership
**And** all external commands run without a shell and with fixed argument arrays
