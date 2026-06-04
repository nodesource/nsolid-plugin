# Installation Flow Specification

## Scenario: First-time installation with no existing credentials

**Given** the user has not previously installed NodeSource AI Skills
**And** no credentials exist at `~/.agents/.nodesource-auth.json`
**When** the user installs the plugin from a marketplace (e.g., Claude Code `/plugins`)
**Then** the plugin post-install hook triggers the shared core installer
**And** the auth flow initiates (browser opens to `accounts.nodesource.com/sign-in`)
**And** after successful OAuth, credentials are stored at `~/.agents/.nodesource-auth.json` with permissions 0600
**And** all 14 skills are copied to `~/.agents/skills/`
**And** MCP configurations are written to the harness-specific config location
**And** a tracking file is created at `~/.agents/.nodesource-installed.json`

## Scenario: Reinstallation with valid existing credentials

**Given** the user has previously installed NodeSource AI Skills
**And** valid credentials exist at `~/.agents/.nodesource-auth.json`
**And** the token has not expired
**When** the user reinstalls the plugin
**Then** the auth flow is skipped
**And** skills are updated (overwritten) in `~/.agents/skills/`
**And** MCP configurations are merged (not replaced) with existing config
**And** the tracking file is updated with any new artifacts

## Scenario: Installation with existing user configurations

**Given** the user has existing MCP server configurations in their harness config
**And** the user has existing skills in `~/.agents/skills/` (non-NodeSource)
**When** the user installs the NodeSource plugin
**Then** existing MCP configurations are preserved (merged, not overwritten)
**And** existing skills are preserved (only NodeSource skills added/updated)
**And** the tracking file records only NodeSource artifacts for clean uninstall

## Scenario: Installation failure during skill copy

**Given** the installation process has started
**When** skill copying fails (e.g., disk full, permission denied)
**Then** the installation rolls back partially copied skills
**And** an error message is displayed with actionable guidance
**And** no tracking file is created (installation incomplete)

## Scenario: Installation failure during MCP config write

**Given** skills have been successfully copied
**When** MCP configuration writing fails
**Then** skills remain installed (partial success)
**And** an error message indicates which step failed
**And** the user can re-run installation to complete MCP setup

## Scenario: Idempotent installation

**Given** the plugin is already fully installed
**When** the user runs the installer again
**Then** no errors occur
**And** no duplicate entries are created in configs
**And** the installation state remains consistent

---

# Authentication Flow Specification

## Scenario: Successful OAuth authentication

**Given** no valid credentials exist
**When** the auth flow initiates
**Then** a browser opens to `https://accounts.nodesource.com/sign-in?extension=nsolid-plugin&state=<uuid>`
**And** a local HTTP callback server starts on port 8765
**And** after user completes OAuth in browser, the callback receives the service token
**And** the token is validated via `/accounts/org/access-token?tokenId=<token>&orgId=<orgId>`
**And** credentials are stored at `~/.agents/.nodesource-auth.json` with structure:
```json
{
  "serviceToken": "<token>",
  "organizationId": "<orgId>",
  "expiresAt": "<ISO8601 timestamp>"
}
```

## Scenario: OAuth timeout

**Given** the auth flow has initiated
**When** 5 minutes pass without successful callback
**Then** the local callback server is shut down
**And** an error message indicates authentication timeout
**And** the user is prompted to retry

## Scenario: OAuth user cancellation

**Given** the browser has opened for OAuth
**When** the user closes the browser without completing auth
**Then** the local callback server times out
**And** an error message indicates authentication was cancelled
**And** the installation can be retried

## Scenario: Token validation failure

**Given** OAuth completed and a token was received
**When** token validation fails (401/403 from Accounts API)
**Then** an error message indicates invalid credentials
**And** no credentials are stored
**And** the user is prompted to retry with correct account

## Scenario: Accounts API unavailable

**Given** OAuth completed and a token was received
**When** the Accounts API is unreachable (network error, 5xx)
**Then** credentials are stored anyway (optimistic)
**And** a warning indicates validation failed but installation continues
**And** MCP servers will validate on first use

## Scenario: Callback port already in use

**Given** port 8765 is already in use
**When** the auth flow attempts to start the callback server
**Then** the server tries alternative ports (8766, 8767, up to 8770)
**And** if all ports fail, an error message suggests closing conflicting applications

## Scenario: Expired token on subsequent install

**Given** credentials exist at `~/.agents/.nodesource-auth.json`
**And** the token has expired (`expiresAt` < current time)
**When** the installer runs
**Then** the auth flow re-initiates
**And** new credentials replace the expired ones

---

# Uninstall Flow Specification

## Scenario: Clean uninstall via marketplace UI

**Given** the plugin is fully installed
**And** a tracking file exists at `~/.agents/.nodesource-installed.json`
**When** the user uninstalls via marketplace UI (e.g., Claude Code `/plugins` → uninstall)
**Then** the plugin uninstall hook reads the tracking file
**And** all NodeSource MCP entries are removed from harness configs
**And** all NodeSource skill directories are deleted from `~/.agents/skills/`
**And** the tracking file is deleted
**And** credentials at `~/.agents/.nodesource-auth.json` are preserved (shared across installs)

## Scenario: Uninstall with missing tracking file

**Given** the plugin appears installed
**And** no tracking file exists
**When** uninstall is triggered
**Then** a warning indicates tracking file is missing
**And** uninstall attempts best-effort cleanup (remove known NodeSource artifacts)
**And** a message suggests manual verification

## Scenario: Uninstall preserves user modifications

**Given** the user has modified a NodeSource skill (e.g., edited SKILL.md)
**When** uninstall runs
**Then** the modified skill is deleted (tracking file identifies it as NodeSource)
**And** no warning is shown (user chose to uninstall)

## Scenario: Uninstall preserves non-NodeSource artifacts

**Given** the user has other skills and MCP servers installed
**When** NodeSource plugin is uninstalled
**Then** only NodeSource artifacts are removed
**And** all other skills and MCP configurations remain intact

---

# Doctor/Health Check Specification

## Scenario: Healthy installation

**Given** the plugin is installed
**When** the user runs the doctor command
**Then** the check verifies:
- Credentials exist and are valid
- All 14 skills exist in `~/.agents/skills/`
- MCP configurations are present in harness config
- MCP servers are reachable (health endpoint responds)
**And** a green status is reported with summary

## Scenario: Missing credentials

**Given** no credentials exist
**When** doctor runs
**Then** a red status indicates missing credentials
**And** actionable fix: "Run installation to authenticate"

## Scenario: Missing skills

**Given** some skills are missing from `~/.agents/skills/`
**When** doctor runs
**Then** a yellow status lists missing skills
**And** actionable fix: "Re-run installation to restore skills"

## Scenario: MCP server unreachable

**Given** MCP configurations exist
**When** MCP health checks fail
**Then** a yellow status indicates which servers are unreachable
**And** actionable fix: "Check network connectivity or MCP server status"

## Scenario: Harness cannot discover skills

**Given** skills exist in `~/.agents/skills/`
**When** harness skill discovery check fails
**Then** a yellow status indicates discovery issue
**And** actionable fix: "Restart harness or check skill path configuration"

---

# Per-Harness Configuration Mapping Specification

## Scenario: Claude Code configuration

**Given** the user installs the Claude Code plugin
**When** MCP configurations are written
**Then** entries are added to `~/.claude/.mcp.json`:
```json
{
  "mcpServers": {
    "ns-benchmark": {
      "command": "node",
      "args": ["/path/to/ns-benchmark/src/mcp-entrypoint.js"],
      "env": {
        "NSOLID_SERVICE_TOKEN": "<from auth>",
        "NSOLID_ORG_ID": "<from auth>"
      }
    },
    "nsolid-mcp": { ... },
    "ncm-mcp": { ... }
  }
}
```
**And** skills are symlinked or copied to `~/.claude/skills/`

## Scenario: Codex CLI configuration

**Given** the user installs the Codex plugin
**When** MCP configurations are written
**Then** entries are added to `~/.codex/config.toml`:
```toml
[mcp_servers.ns-benchmark]
command = "node"
args = ["/path/to/ns-benchmark/src/mcp-entrypoint.js"]
env = { NSOLID_SERVICE_TOKEN = "<from auth>", NSOLID_ORG_ID = "<from auth>" }

[mcp_servers.nsolid-mcp]
...

[mcp_servers.ncm-mcp]
...
```
**And** skills are copied to `~/.codex/skills/`

## Scenario: OpenCode configuration

**Given** the user installs the OpenCode plugin
**When** MCP configurations are written
**Then** entries are added to `~/.config/opencode/opencode.jsonc`:
```jsonc
{
  "mcpServers": {
    "ns-benchmark": { ... },
    "nsolid-mcp": { ... },
    "ncm-mcp": { ... }
  }
}
```
**And** skills are copied to `~/.config/opencode/skills/`

## Scenario: Antigravity CLI configuration

**Given** the user installs the Antigravity plugin
**When** MCP configurations are written
**Then** entries are added to Antigravity-specific config location (TBD based on Antigravity docs)
**And** skills are copied to Antigravity skill directory

## Scenario: Pi Agent configuration (skills only)

**Given** the user installs the Pi Agent plugin
**When** installation runs
**Then** NO MCP configurations are written (Pi rejects MCP)
**And** skills are copied to `~/.pi/skills/`
**And** a message indicates MCP servers are not supported in Pi

---

# Regression Guardrails

## Existing behavior that must be preserved

1. **User's existing MCP servers**: Installation must not remove or modify non-NodeSource MCP configurations
2. **User's existing skills**: Installation must not remove or modify non-NodeSource skills
3. **Harness configurations**: Installation must not break harness functionality (configs remain valid JSON/TOML)
4. **Credentials**: Reinstallation must not invalidate existing valid credentials
5. **Tracking**: Uninstall must only remove artifacts it created (no collateral damage)

## Edge cases to handle

1. **Partial installation**: If installation fails midway, subsequent installs must complete successfully
2. **Config corruption**: If harness config becomes invalid JSON/TOML, installation should detect and warn (not crash)
3. **Permission issues**: If file permissions prevent writing, provide actionable error messages
4. **Network failures**: Auth and MCP health checks must handle network errors gracefully
5. **Port conflicts**: Auth callback server must handle port conflicts with fallback strategy
