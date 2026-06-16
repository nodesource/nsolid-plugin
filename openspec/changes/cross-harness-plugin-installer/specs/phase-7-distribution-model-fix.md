# Phase 7 Distribution Model Fix

## Status

Delta spec for `cross-harness-plugin-installer`. Applies changes to the main `installation-and-auth` capability spec.

Supersedes the Phase 7 marketplace-package design in `design.md` and the trigger descriptions in `specs/installation-and-auth.md` for the Antigravity CLI and Pi Agent harnesses. Claude Code, Codex CLI, and OpenCode remain unchanged from the hybrid model described in `tasks.md` and `.opencode/plans/phase-7-marketplace-packages.md`.

---

## MODIFIED Requirements

### Requirement: Installation Flow

The installer SHALL support first-time installation, reinstallation, idempotent runs, and graceful handling of partial failures across all supported harnesses. The trigger that invokes the shared core installer is harness-specific; it is NOT an npm `postinstall` hook.

#### Scenario: First-time installation with no existing credentials

**Given** the user has not previously installed NodeSource AI Skills  
**And** no credentials exist at `~/.agents/.nodesource-auth.json`  
**When** the user installs the plugin via the harness-specific trigger  
**Then** the shared core installer runs  
**And** the auth flow initiates (browser opens to `accounts.nodesource.com/sign-in`)  
**And** after successful OAuth, credentials are stored at `~/.agents/.nodesource-auth.json` with permissions `0600` (best-effort on Windows)  
**And** all 14 skills are copied to `~/.agents/skills/`  
**And** MCP configurations are written to the harness-specific config location  
**And** a tracking file is created at `~/.agents/.nodesource-installed.json`

#### Scenario: Harness-specific installation triggers

**Claude Code**  
- **WHEN** the plugin is loaded by Claude Code  
- **THEN** the `SessionStart` hook runs `scripts/setup.js`  
- **AND** `scripts/setup.js` invokes `packages/core/scripts/setup.mjs` with `NSOLID_HARNESS=claude`  
- **AND** `core.install()` runs

**Codex CLI**  
- **WHEN** the plugin is loaded by Codex CLI  
- **THEN** the `SessionStart` hook runs `scripts/setup.js`  
- **AND** `scripts/setup.js` invokes the shared core setup script with `NSOLID_HARNESS=codex`  
- **AND** `core.install()` runs

**OpenCode**  
- **WHEN** the plugin module is loaded by OpenCode  
- **THEN** `index.js` invokes the shared core setup script with `NSOLID_HARNESS=opencode`  
- **AND** `core.install()` runs  
- **AND** OpenCode does NOT rely on npm `postinstall` because OpenCode installs plugins with Bun, which is default-secure and skips lifecycle scripts unless the package is in `trustedDependencies`

**Antigravity CLI**  
- **WHEN** the user manually runs `node packages/antigravity-plugin/scripts/install.js`  
- **THEN** the script copies the plugin directory to `~/.gemini/config/plugins/nodesource-nsolid/`  
- **AND** the script invokes `core.install()` with `NSOLID_HARNESS=antigravity`  
- **AND** auth, skill copy, and MCP config write run  
- **AND** there is no install-time hook because Antigravity's `hooks.json` only supports `PreToolUse`, `PostToolUse`, `PreInvocation`, `PostInvocation`, and `Stop`

**Pi Agent**  
- **WHEN** the package is loaded by Pi Agent (via `pi.extensions`)  
- **THEN** the `index.js` extension entrypoint invokes `core.install()` with `NSOLID_HARNESS=pi`  
- **AND** auth and skill copy run  
- **AND** no MCP config is written because Pi does not support MCP today

---

### Requirement: Per-Harness Configuration Mapping

Installation SHALL produce harness-specific configurations for Claude Code, Codex CLI, OpenCode, Antigravity, and Pi Agent.

#### Scenario: Antigravity CLI configuration

**Given** the user runs the Antigravity install script  
**When** `core.install()` writes the MCP configuration  
**Then** the MCP config is written to `~/.gemini/config/mcp_config.json`  
**And** skills are linked/copied to `~/.gemini/config/skills/`  
**And** the plugin directory is located at `~/.gemini/config/plugins/nodesource-nsolid/`  
**And** the core Antigravity adapter uses the cross-product shared paths, not the Agy-CLI-only paths `~/.gemini/antigravity-cli/mcp_config.json` and `~/.gemini/antigravity-cli/skills/`

#### Scenario: Pi Agent configuration

**Given** the user installs the Pi package via `pi install npm:@nodesource/pi-plugin`  
**When** the package loads  
**Then** the `pi.extensions` entrypoint (`index.js`) runs `core.install()` with `NSOLID_HARNESS=pi`  
**And** the OAuth flow runs if no valid credentials exist  
**And** skills are copied to `~/.agents/skills/` and linked to `~/.pi/agent/skills/`  
**And** a tracking file entry is created for Pi  
**And** no MCP configuration is written because Pi does not support MCP in the current version

---

## ADDED Requirements

### Requirement: Core Installer Reuse for Static-Bundle Harnesses

Harnesses that do not provide an install-time lifecycle hook SHALL still use the shared core installer so that authentication, MCP configuration, and tracking remain consistent across all harnesses.

#### Scenario: Antigravity uses the core installer

**Given** Antigravity has no `SessionStart` or install-time hook  
**When** the plugin is distributed as a static directory  
**Then** a one-time `scripts/install.js` is provided that the user runs manually  
**And** that script copies the plugin directory for native discovery  
**And** that script calls `core.install()` with `NSOLID_HARNESS=antigravity`  
**And** skills and MCP config are NOT bundled inside the plugin directory

#### Scenario: Pi uses the core installer via extension

**Given** Pi has no install-time hook but supports package extensions  
**When** the package declares `pi.extensions` in `package.json`  
**Then** the extension entrypoint calls `core.install()` with `NSOLID_HARNESS=pi` on package load  
**And** auth and skill installation run automatically  
**And** skills are NOT bundled inside the plugin directory

---

## REMOVED Requirements

_None. The existing requirements are modified in place; no requirement is removed._

---

## RENAMED Requirements

_None._
