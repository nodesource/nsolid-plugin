# Installation & Authentication Specification

## Purpose

Defines the installation, authentication, uninstall, and health check behaviors for the N|Solid plugin installer across multiple AI harnesses (Claude Code, Codex CLI, OpenCode, Antigravity, Pi Agent).

---

## Requirements

### Requirement: Installation Flow

The installer SHALL support first-time installation, reinstallation, idempotent runs, and graceful handling of partial failures.

#### Scenario: First-time installation with no existing credentials

**Given** the user has not previously installed NodeSource AI Skills
**And** no credentials exist at `~/.agents/.nodesource-auth.json`
**When** the user installs the plugin from a marketplace (e.g., Claude Code `/plugins`)
**Then** the plugin post-install hook triggers the shared core installer
**And** the auth flow initiates (browser opens to `accounts.nodesource.com/sign-in`)
**And** after successful OAuth, credentials are stored at `~/.agents/.nodesource-auth.json` with permissions 0600 (best-effort on Windows)
**And** all 14 skills are copied to `~/.agents/skills/`
**And** MCP configurations are written to the harness-specific config location
**And** a tracking file is created at `~/.agents/.nodesource-installed.json`

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

#### Scenario: Clean uninstall via marketplace UI (see original spec)
#### Scenario: Uninstall with missing tracking file (see original spec)
#### Scenario: Uninstall preserves user modifications (see original spec)
#### Scenario: Uninstall preserves non-NodeSource artifacts (see original spec)

---

### Requirement: Doctor/Health Check

The doctor command SHALL verify credentials, skills, MCP configurations, and MCP server connectivity, providing actionable fixes for each issue found.

#### Scenario: Healthy installation (see original spec)
#### Scenario: Missing credentials (see original spec)
#### Scenario: Missing skills (see original spec)
#### Scenario: MCP server unreachable (see original spec)
#### Scenario: Harness cannot discover skills (see original spec)

---

### Requirement: Per-Harness Configuration Mapping

Installation SHALL produce harness-specific configurations for Claude Code, Codex CLI, OpenCode, Antigravity, and Pi Agent as defined in the original spec.

#### Scenario: Claude Code configuration (see original spec)
#### Scenario: Codex CLI configuration (see original spec)
#### Scenario: OpenCode configuration (see original spec)
#### Scenario: Antigravity CLI configuration (see original spec)
#### Scenario: Pi Agent configuration (skills only) (see original spec)

---

### Requirement: Regression Guardrails

The installer SHALL preserve existing behavior and handle edge cases as defined in the original spec.

#### Existing behavior that must be preserved (see original spec)
#### Edge cases to handle (see original spec)

---

### Requirement: MCP URL Derivation

The plugin SHALL derive the MCP server URL from the organization ID received during authentication.

#### Scenario: MCP URL construction

**Given** a consoleId value from the OAuth callback
**When** credentials are stored
**Then** `mcpUrl` is set to `https://{consoleId}.mcp.saas.nodesource.io`
**And** this URL is used by MCP servers for connectivity
