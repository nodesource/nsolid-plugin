# Installation & Authentication Specification

## Purpose

Defines the installation, authentication, uninstall, and health check behaviors for the N|Solid plugin installer across multiple AI harnesses (Claude Code, Codex CLI, OpenCode, Antigravity, Pi Agent).

---

## Requirements

### Requirement: Installation Flow

The installer SHALL support first-time installation, reinstallation, idempotent runs, and graceful handling of partial failures. The trigger that invokes the shared core installer is harness-specific; it is NOT an npm `postinstall` hook.

#### Scenario: First-time installation with no existing credentials

**Given** the user has not previously installed NodeSource AI Skills
**And** no credentials exist at `~/.agents/.nodesource-auth.json`
**When** the user installs the plugin via the harness-specific trigger
**Then** the shared core installer runs
**And** the auth flow initiates (browser opens to `accounts.nodesource.com/sign-in`)
**And** after successful OAuth, credentials are stored at `~/.agents/.nodesource-auth.json` with permissions 0600 (best-effort on Windows)
**And** all 15 skills are copied to `~/.agents/skills/`
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

#### Scenario: Reinstallation with valid existing credentials

**Given** the user has previously installed NodeSource AI Skills
**And** valid credentials exist at `~/.agents/.nodesource-auth.json`
**And** the token has not expired
**When** the user reinstalls the plugin
**Then** the auth flow is skipped
**And** skills are updated (overwritten) in `~/.agents/skills/`
**And** MCP configurations are merged (not replaced) with existing config
**And** the tracking file is updated with any new artifacts

#### Scenario: Installation with existing user configurations

**Given** the user has existing MCP server configurations in their harness config
**And** the user has existing skills in `~/.agents/skills/` (non-NodeSource)
**When** the user installs the NodeSource plugin
**Then** existing MCP configurations are preserved (merged, not overwritten)
**And** existing skills are preserved (only NodeSource skills added/updated)
**And** the tracking file records only NodeSource artifacts for clean uninstall

#### Scenario: Installation failure during skill copy

**Given** the installation process has started
**When** skill copying fails (e.g., disk full, permission denied)
**Then** the installation rolls back partially copied skills
**And** an error message is displayed with actionable guidance
**And** no tracking file is created (installation incomplete)

#### Scenario: Installation failure during MCP config write

**Given** skills have been successfully copied
**When** MCP configuration writing fails
**Then** skills remain installed (partial success)
**And** an error message indicates which step failed
**And** the user can re-run installation to complete MCP setup

#### Scenario: Idempotent installation

**Given** the plugin is already fully installed
**When** the user runs the installer again
**Then** no errors occur
**And** no duplicate entries are created in configs
**And** the installation state remains consistent

---

### Requirement: Authentication Flow

The plugin SHALL authenticate users via OAuth with the NodeSource accounts service, including CSRF protection, callback handling, token validation, and credential storage.

#### Scenario: Successful OAuth authentication

**Given** no valid credentials exist
**When** the auth flow initiates
**Then** a browser opens to `https://accounts.nodesource.com/sign-in?extension=nsolid-plugin&state=<uuid>`
**And** a local HTTP callback server starts on port 8765 (with fallback to 8766-8770)
**And** after user completes OAuth in browser, the accounts service redirects to `http://127.0.0.1:{port}/callback` with parameters:
  - `success=true`
  - `token=<serviceToken>`
  - `consoleId=<organizationId>`
  - `url=<consoleUrl>`
  - `NSOLID_SAAS=<saasToken>`
  - `code=<authCode>`
  - `state=<csrfState>`
**And** the callback server validates state matches expected value (CSRF protection)
**And** MCP URL is derived: `https://{consoleId}.mcp.saas.nodesource.io`
**And** the token is validated via `/accounts/org/access-token?tokenId=<token>&orgId=<consoleId>`
**And** credentials are stored at `~/.agents/.nodesource-auth.json` with structure:
```json
{
  "serviceToken": "<token>",
  "organizationId": "<consoleId>",
  "saasToken": "<NSOLID_SAAS>",
  "consoleUrl": "<url>",
  "mcpUrl": "https://<consoleId>.mcp.saas.nodesource.io",
  "expiresAt": "<ISO8601 timestamp>",
  "permissions": ["<permission>"]
}
```

> **Note**: The accounts service currently only supports `vscode://` URI redirects for VS Code extensions. HTTP callback support for `nsolid-plugin` requires registration with the accounts team. See: https://github.com/nodesource/accounts-api/issues/749

#### Scenario: CSRF protection via state parameter

**Given** the auth flow generated a random UUID state
**When** the callback is received
**Then** the state parameter must match the expected value
**And** mismatched state returns 400 and does not store credentials

#### Scenario: Auth failure detection (success=false)

**Given** the OAuth callback is received
**When** `success` parameter is `"false"`
**Then** the server resolves with `{ success: false, reason: 'auth-failed' }`
**And** the auth manager throws an appropriate error

#### Scenario: OAuth timeout

**Given** the auth flow has initiated
**When** 5 minutes pass without successful callback
**Then** the local callback server is shut down
**And** an error message indicates authentication timeout
**And** the user is prompted to retry

#### Scenario: OAuth user cancellation

**Given** the browser has opened for OAuth
**When** the user closes the browser without completing auth
**Then** the local callback server times out
**And** an error message indicates authentication was cancelled
**And** the installation can be retried

#### Scenario: Token validation failure

**Given** OAuth completed and a token was received
**When** token validation fails (401/403 from Accounts API)
**Then** an error message indicates invalid credentials
**And** no credentials are stored
**And** the user is prompted to retry with correct account

#### Scenario: Accounts API unavailable

**Given** OAuth completed and a token was received
**When** the Accounts API is unreachable (network error, 5xx)
**Then** credentials are stored anyway (optimistic)
**And** a warning indicates validation failed but installation continues
**And** MCP servers will validate on first use

#### Scenario: Callback port already in use

**Given** port 8765 is already in use
**When** the auth flow attempts to start the callback server
**Then** the server tries alternative ports (8766, 8767, up to 8770)
**And** if all ports fail, an error message suggests closing conflicting applications

#### Scenario: Expired token on subsequent install

**Given** credentials exist at `~/.agents/.nodesource-auth.json`
**And** the token has expired (`expiresAt` < current time)
**When** the installer runs
**Then** the auth flow re-initiates
**And** new credentials replace the expired ones

---

### Requirement: Uninstall Flow

The uninstaller SHALL remove only NodeSource artifacts, preserve user modifications and non-NodeSource artifacts, and support both tracked and best-effort cleanup.

#### Scenario: Clean uninstall via marketplace UI

**Given** the plugin is fully installed
**And** a tracking file exists at `~/.agents/.nodesource-installed.json`
**When** the user uninstalls via the harness-specific uninstall trigger (e.g., Claude Code `/plugins` → uninstall, or running the uninstall action of the shared setup script)
**Then** the uninstaller reads the tracking file
**And** all NodeSource MCP entries are removed from harness configs
**And** all NodeSource skill directories, symlinks, and copies are deleted from harness-specific paths (`~/.agents/skills/`, `~/.claude/skills/`, `~/.codex/skills/`, `~/.config/opencode/skills/`, `~/.gemini/skills/`, `~/.pi/agent/skills/`)
**And** the tracking file is deleted
**And** credentials at `~/.agents/.nodesource-auth.json` are preserved (shared across installs)

#### Scenario: Uninstall with missing tracking file

**Given** the plugin appears installed
**And** no tracking file exists
**When** uninstall is triggered
**Then** a warning indicates tracking file is missing
**And** uninstall attempts best-effort cleanup of known NodeSource artifacts (see below)
**And** a message lists what was removed and what was skipped
**And** a message suggests manual verification

##### Best-Effort Cleanup Algorithm

When no tracking file is present, the uninstaller scans only these predefined patterns:

**Known NodeSource artifacts** (exact match only):
- `~/.agents/skills/ns-*` (skill directories prefixed with `ns-`)
- `~/.claude/skills/ns-*` (Claude harness skill directories)
- `~/.codex/skills/ns-*` (Codex harness skill directories)
- `~/.config/opencode/skills/ns-*` (OpenCode harness skill directories)
- `~/.gemini/skills/ns-*` (Antigravity harness skill directories)
- `~/.pi/agent/skills/ns-*` (Pi harness skill directories)
- `~/.agents/.nodesource-installed.json` (tracking file, if partially present)
- MCP entries named `nsolid-console`, `ns-benchmark`, or `ncm` in harness config files:
  - `~/.claude.json`
  - `~/.codex/config.toml`
  - `~/.config/opencode/opencode.jsonc`
  - `~/.gemini/config/mcp_config.json`

**Algorithm**:
1. Scan only the predefined patterns above (no recursive or broad searches)
2. Verify each match is a NodeSource artifact (check for NodeSource markers in file content where possible)
3. Skip any file modified within the last 24 hours (to avoid removing freshly-created user files that happen to match)
4. Log each deletion before performing it
5. **Conservative by default**: Remove only exact-match artifacts; leave ambiguous files untouched
6. With `--force` flag: also remove credentials (`~/.agents/.nodesource-auth.json`) and skip the 24-hour recency check

#### Scenario: Uninstall preserves user modifications

**Given** the user has modified a NodeSource skill (e.g., edited SKILL.md)
**When** uninstall runs
**Then** the modified skill is deleted (tracking file identifies it as NodeSource)
**And** no warning is shown (user chose to uninstall)

#### Scenario: Uninstall preserves non-NodeSource artifacts

**Given** the user has other skills and MCP servers installed
**When** NodeSource plugin is uninstalled
**Then** only NodeSource artifacts are removed
**And** all other skills and MCP configurations remain intact

---

### Requirement: Doctor/Health Check

The doctor command SHALL verify credentials, skills, MCP configurations, and MCP server connectivity, providing actionable fixes for each issue found.

#### Scenario: Healthy installation

**Given** the plugin is installed
**When** the user runs the doctor command
**Then** the check verifies:
- Credentials exist and are valid
- All 15 skills exist in `~/.agents/skills/`
- MCP configurations are present in harness config
- MCP servers are reachable (health endpoint responds)
**And** a green status is reported with summary

#### Scenario: Missing credentials

**Given** no credentials exist
**When** doctor runs
**Then** a red status indicates missing credentials
**And** actionable fix: "Run installation to authenticate"

#### Scenario: Missing skills

**Given** some skills are missing from `~/.agents/skills/`
**When** doctor runs
**Then** a yellow status lists missing skills
**And** actionable fix: "Re-run installation to restore skills"

#### Scenario: MCP server unreachable

**Given** MCP configurations exist
**When** MCP health checks fail
**Then** a yellow status indicates which servers are unreachable
**And** actionable fix: "Check network connectivity or MCP server status"

#### Scenario: Harness cannot discover skills

**Given** skills exist in `~/.agents/skills/`
**When** harness skill discovery check fails
**Then** a yellow status indicates discovery issue
**And** actionable fix: "Restart harness or check skill path configuration"

---

### Requirement: Per-Harness Configuration Mapping

Installation SHALL produce harness-specific MCP configurations using URL-based (Streamable HTTP) transport with auth tokens in HTTP headers. The three MCP servers are cloud endpoints:

| Server | URL | Auth headers |
|---|---|---|
| `nsolid-console` | `${MCP_URL}` (derived from `consoleUrl`) | `X-Nsolid-Service-Token` |
| `ns-benchmark` | `https://benchmark.mcp.saas.nodesource.io/mcp` | `X-Nsolid-Org-Id`, `X-Nsolid-Service-Token` |
| `ncm` | `https://mcp.ncm.nodesource.com` | `X-Nsolid-Service-Token` |

Server names are `nsolid-console` (not `nsolid-mcp`) and `ncm` (not `ncm-mcp`).

#### Scenario: Claude Code configuration

**Given** the user installs the Claude Code plugin
**When** MCP configurations are written
**Then** entries are added to `~/.claude.json`:
```json
{
  "mcpServers": {
    "nsolid-console": {
      "url": "https://<id>.mcp.saas.nodesource.io",
      "headers": { "X-Nsolid-Service-Token": "<token>" }
    },
    "ns-benchmark": {
      "url": "https://benchmark.mcp.saas.nodesource.io/mcp",
      "headers": { "X-Nsolid-Org-Id": "<orgId>", "X-Nsolid-Service-Token": "<token>" }
    },
    "ncm": {
      "url": "https://mcp.ncm.nodesource.com",
      "headers": { "X-Nsolid-Service-Token": "<token>" }
    }
  }
}
```
**And** skills are symlinked (Unix) or junction-linked/copied (Windows) to `~/.claude/skills/`

#### Scenario: Codex CLI configuration

**Given** the user installs the Codex plugin
**When** MCP configurations are written
**Then** entries are added to `~/.codex/config.toml`:
```toml
[mcp_servers.nsolid-console]
url = "https://<id>.mcp.saas.nodesource.io"

[mcp_servers.nsolid-console.headers]
X-Nsolid-Service-Token = "<token>"

[mcp_servers.ns-benchmark]
url = "https://benchmark.mcp.saas.nodesource.io/mcp"

[mcp_servers.ns-benchmark.headers]
X-Nsolid-Org-Id = "<orgId>"
X-Nsolid-Service-Token = "<token>"

[mcp_servers.ncm]
url = "https://mcp.ncm.nodesource.com"

[mcp_servers.ncm.headers]
X-Nsolid-Service-Token = "<token>"
```
**And** skills are symlinked (Unix) or junction-linked/copied (Windows) to `~/.codex/skills/`

#### Scenario: OpenCode configuration

**Given** the user installs the OpenCode plugin
**When** MCP configurations are written
**Then** entries are added to `~/.config/opencode/opencode.jsonc`:
```jsonc
{
  "mcpServers": {
    "nsolid-console": {
      "url": "https://<id>.mcp.saas.nodesource.io",
      "headers": { "X-Nsolid-Service-Token": "<token>" }
    },
    "ns-benchmark": {
      "url": "https://benchmark.mcp.saas.nodesource.io/mcp",
      "headers": { "X-Nsolid-Org-Id": "<orgId>", "X-Nsolid-Service-Token": "<token>" }
    },
    "ncm": {
      "url": "https://mcp.ncm.nodesource.com",
      "headers": { "X-Nsolid-Service-Token": "<token>" }
    }
  }
}
```
**And** skills are symlinked (Unix) or junction-linked/copied (Windows) to `~/.config/opencode/skills/`

#### Scenario: Antigravity CLI configuration

**Given** the user runs the Antigravity install script
**When** `core.install()` writes the MCP configuration
**Then** entries are added to `~/.gemini/config/mcp_config.json`:
```json
{
  "mcpServers": {
    "nsolid-console": {
      "serverUrl": "https://<id>.mcp.saas.nodesource.io",
      "headers": { "X-Nsolid-Service-Token": "<token>" }
    },
    "ns-benchmark": {
      "serverUrl": "https://benchmark.mcp.saas.nodesource.io/mcp",
      "headers": { "X-Nsolid-Org-Id": "<orgId>", "X-Nsolid-Service-Token": "<token>" }
    },
    "ncm": {
      "serverUrl": "https://mcp.ncm.nodesource.com",
      "headers": { "X-Nsolid-Service-Token": "<token>" }
    }
  }
}
```
**And** Antigravity uses `serverUrl` (not `url`) as the URL field name per its config schema
**And** skills are linked/copied to `~/.gemini/skills/`
**And** the plugin directory is located at `~/.gemini/config/plugins/nodesource-nsolid/`

#### Scenario: Pi Agent configuration

**Given** the user installs the Pi package via `pi install npm:@nodesource/pi-plugin`
**When** the package loads
**Then** the `pi.extensions` entrypoint (`index.js`) runs `core.install()` with `NSOLID_HARNESS=pi`
**And** the OAuth flow runs if no valid credentials exist
**And** skills are copied to `~/.agents/skills/` and linked to `~/.pi/agent/skills/`
**And** a tracking file entry is created for Pi
**And** no MCP configuration is written because Pi does not support MCP in the current version

---

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

### Requirement: Regression Guardrails

The installer SHALL preserve existing behavior and handle edge cases as defined in the original spec.

#### Existing behavior that must be preserved

1. **User's existing MCP servers**: Installation must not remove or modify non-NodeSource MCP configurations
2. **User's existing skills**: Installation must not remove or modify non-NodeSource skills
3. **Harness configurations**: Installation must not break harness functionality (configs remain valid JSON/TOML)
4. **Credentials**: Reinstallation must not invalidate existing valid credentials
5. **Tracking**: Uninstall must only remove artifacts it created (no collateral damage)

#### Edge cases to handle

1. **Partial installation**: If installation fails midway, subsequent installs must complete successfully
2. **Config corruption**: If harness config becomes invalid JSON/TOML, installation should detect and warn (not crash)
3. **Permission issues**: If file permissions prevent writing, provide platform-aware error messages (Unix: `sudo`/`chmod` guidance; Windows: "Run as Administrator" or `icacls` guidance)
4. **Network failures**: Auth and MCP health checks must handle network errors gracefully
5. **Port conflicts**: Auth callback server must handle port conflicts with fallback strategy

---

### Requirement: MCP URL Derivation

The plugin SHALL derive the MCP server URL for the `nsolid-console` server from the stored `consoleUrl` credential.

#### Scenario: MCP URL construction

**Given** a `consoleUrl` value stored in `~/.agents/.nodesource-auth.json`
**When** MCP configurations are written
**Then** `mcpUrl` is derived as `consoleUrl.replace('.saas.', '.mcp.saas.')`
**And** the derived URL is used as the `url` (or `serverUrl` for Antigravity) of the `nsolid-console` MCP server entry
**And** this URL is stored in credentials as `mcpUrl` for reuse
