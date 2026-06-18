# Installation Flow Specification

## Scenario: Generated native artifacts are built

**Given** the repository is in source mode
**When** the release process runs `pnpm plugin:artifacts`
**Then** plugin directories are generated under `dist/plugins/{claude,codex,antigravity}/nsolid-plugin/`
**And** archives are generated under `dist/artifacts/nsolid-{claude,codex,antigravity}-plugin.tgz`
**And** each generated plugin contains all skills from `packages/core/skills/`
**And** each generated plugin contains the harness manifest/config/wrapper files required by its native format
**And** no generated artifact is committed to source control

## Scenario: Native plugin installation with no existing credentials

**Given** the user has not previously authenticated with NodeSource
**And** no credentials exist at `~/.agents/.nodesource-auth.json`
**When** the user installs a generated Claude, Codex, or Antigravity plugin artifact through the harness
**Then** the harness stages plugin assets from the generated artifact
**And** no browser opens
**And** no OAuth callback server starts
**And** no credentials file is written
**And** docs, CLI output, or runtime MCP wrapper errors provide the actionable next step: `nsolid-plugin setup --harness <harness>`

## Scenario: Explicit setup with no existing credentials

**Given** the user has installed a native plugin artifact or wants to configure fallback/direct install
**And** no credentials exist at `~/.agents/.nodesource-auth.json`
**When** the user runs `nsolid-plugin setup --harness <harness>`
**Then** the auth flow initiates (browser opens to `accounts.nodesource.com/sign-in`)
**And** after successful OAuth, credentials are stored at `~/.agents/.nodesource-auth.json` with permissions 0600 (best-effort; on Windows, `chmod 0600` has minimal effect — see design.md Platform Filesystem Abstractions)
**And** setup writes any harness configuration that belongs to explicit setup for that harness

## Scenario: Fallback direct install with no existing credentials

**Given** native plugin installation is unavailable or unsuitable
**And** no credentials exist at `~/.agents/.nodesource-auth.json`
**When** the user runs `nsolid-plugin install --harness <harness>`
**Then** the fallback installer does not open a browser
**And** the fallback installer copies or links skills as appropriate for the harness, except Pi where skills are package-owned and user-level skill copy/link is skipped
**And** MCP configuration is skipped or written without secrets when credentials are unavailable
**And** the output tells the user to run `nsolid-plugin setup --harness <harness>` before using authenticated MCP tools

## Scenario: Setup or fallback install with valid existing credentials

**Given** valid credentials exist at `~/.agents/.nodesource-auth.json`
**And** the token has not expired
**When** the user reruns `nsolid-plugin setup --harness <harness>` or fallback `install --harness <harness>`
**Then** the auth flow is skipped
**And** setup/fallback configuration is refreshed idempotently
**And** MCP configurations are merged (not replaced) with existing config
**And** Pi setup refreshes MCP config only while leaving package-owned skills untouched
**And** the tracking file is updated with any fallback-installed artifacts

## Scenario: Installation with existing user configurations

**Given** the user has existing MCP server configurations in their harness config
**And** the user has existing skills in native plugin directories or fallback skill directories
**When** the user installs the NodeSource plugin artifact or runs fallback install
**Then** existing MCP configurations are preserved (merged, not overwritten)
**And** existing skills are preserved (only NodeSource skills added/updated)
**And** tracking records only NodeSource fallback artifacts for clean uninstall

## Scenario: Installation failure during skill copy

**Given** fallback installation or artifact generation has started
**When** skill copying fails (e.g., disk full, permission denied)
**Then** the operation rolls back partially copied skills where possible
**And** an error message is displayed with actionable guidance
**And** no tracking file entry is created for incomplete fallback artifacts

## Scenario: Installation failure during MCP config write

**Given** skills have been successfully copied
**When** MCP configuration writing fails
**Then** skills remain installed (partial success)
**And** an error message indicates which step failed
**And** the user can re-run setup or fallback install to complete MCP setup

## Scenario: Idempotent installation

**Given** the plugin is already fully installed or fallback-installed
**When** the user reruns native install, setup, or fallback install
**Then** no errors occur
**And** no duplicate entries are created in configs
**And** the installation state remains consistent

---

# Authentication Flow Specification

## Scenario: Successful OAuth authentication

**Given** no valid credentials exist
**When** the user explicitly runs `nsolid-plugin setup` or `nsolid-plugin login`
**Then** a browser opens to `https://accounts.nodesource.com/sign-in?extension=nsolid-plugin&port=<callback-port>&state=<uuid>`
**And** a local HTTP callback server starts on port 8765
**And** after user completes OAuth in browser, the callback receives the service token
**And** the token is validated via `/accounts/org/access-token?tokenId=<token>&orgId=<orgId>`
**And** credentials are stored at `~/.agents/.nodesource-auth.json` with structure:
```json
{
  "serviceToken": "<token>",
  "organizationId": "<orgId>",
  "saasToken": "<token>",
  "consoleUrl": "https://<console-id>.saas.nodesource.io",
  "mcpUrl": "https://<console-id>.mcp.saas.nodesource.io/",
  "expiresAt": "<ISO8601 timestamp>",
  "accountsUrl": "https://accounts.nodesource.com"
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

## Scenario: Expired token on subsequent setup

**Given** credentials exist at `~/.agents/.nodesource-auth.json`
**And** the token has expired (`expiresAt` < current time)
**When** the user runs `nsolid-plugin setup` or `nsolid-plugin login`
**Then** the auth flow re-initiates
**And** new credentials replace the expired ones

## Scenario: Expired token during native install or fallback install

**Given** credentials are missing or expired
**When** a generated native install script, native artifact activation, Pi package activation, or fallback `install --harness` path runs
**Then** the path does not open a browser
**And** the output or runtime error tells the user to run `nsolid-plugin setup --harness <harness>`

---

# Uninstall Flow Specification

## Scenario: Clean uninstall via native harness or fallback CLI

**Given** the plugin is installed natively or through fallback direct install
**When** the user uninstalls through the harness UI/CLI or runs `nsolid-plugin uninstall --harness <harness>`
**Then** native uninstall removes the generated plugin directory where the harness owns it
**And** fallback uninstall reads `~/.agents/.nodesource-installed.json` when tracking exists
**And** tracked NodeSource MCP entries are removed from harness configs
**And** tracked NodeSource skill directories, symlinks, and copies are deleted from fallback harness-specific paths (`~/.agents/skills/`, `~/.claude/skills/`, `~/.codex/skills/`, `~/.config/opencode/skills/`, `~/.gemini/antigravity-cli/skills/`, `~/.pi/agent/skills/`)
**And** credentials at `~/.agents/.nodesource-auth.json` are preserved (shared across installs)

## Scenario: Uninstall with missing tracking file

**Given** the plugin appears installed
**And** no tracking file exists
**When** uninstall is triggered
**Then** a warning indicates tracking file is missing
**And** uninstall attempts best-effort cleanup of known NodeSource artifacts (see below)
**And** a message lists what was removed and what was skipped
**And** a message suggests manual verification

### Best-Effort Cleanup Algorithm

When no tracking file is present, the uninstaller scans only these predefined patterns:

**Known NodeSource artifacts** (exact match only):
- `~/.agents/skills/ns-*` (skill directories prefixed with `ns-`)
- `~/.claude/skills/ns-*` (Claude harness skill directories)
- `~/.codex/skills/ns-*` (Codex harness skill directories)
- `~/.config/opencode/skills/ns-*` (OpenCode harness skill directories)
- `~/.gemini/antigravity-cli/skills/ns-*` (Antigravity harness skill directories)
- `~/.pi/agent/skills/ns-*` (Pi harness skill directories)
- `~/.gemini/antigravity-cli/plugins/nsolid-plugin/` (Antigravity native plugin directory)
- `~/.agents/.nodesource-installed.json` (tracking file, if partially present)
- MCP entries named `nsolid-console`, `ns-benchmark`, or `ncm` in harness config files:
  - `~/.claude.json`
  - `~/.codex/config.toml`
  - `~/.config/opencode/opencode.jsonc`
  - `~/.gemini/antigravity-cli/mcp_config.json`
  - `~/.pi/agent/mcp.json`

**Algorithm**:
1. Scan only the predefined patterns above (no recursive or broad searches)
2. Verify each match is a NodeSource artifact (check for NodeSource markers in file content where possible)
3. Skip any file modified within the last 24 hours (to avoid removing freshly-created user files that happen to match)
4. Log each deletion before performing it
5. **Conservative by default**: Remove only exact-match artifacts; leave ambiguous files untouched
6. With `--force` flag: also remove credentials (`~/.agents/.nodesource-auth.json`) and skip the 24-hour recency check

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
- Credentials exist and are valid when authenticated MCP servers are expected
- All bundle skills exist in the relevant native artifact, Pi package, or fallback skill path
- MCP configurations are present in the relevant native artifact or harness config
- MCP servers are reachable (health endpoint responds)
**And** a green status is reported with summary

## Scenario: Missing credentials

**Given** no credentials exist
**When** doctor runs
**Then** a red status indicates missing credentials
**And** actionable fix: "Run `nsolid-plugin setup --harness <harness>`"

## Scenario: Missing skills

**Given** some skills are missing from the native artifact, Pi package, or fallback skill path
**When** doctor runs
**Then** a yellow status lists missing skills
**And** actionable fix: "Rebuild artifacts or re-run fallback installation to restore skills"

## Scenario: MCP server unreachable

**Given** MCP configurations exist
**When** MCP health checks fail
**Then** a yellow status indicates which servers are unreachable
**And** actionable fix: "Check network connectivity or MCP server status"

## Scenario: Harness cannot discover skills

**Given** skills exist in the native artifact, Pi package, or fallback skill path
**When** harness skill discovery check fails
**Then** a yellow status indicates discovery issue
**And** actionable fix: "Restart harness, rebuild/reinstall the artifact, or check skill path configuration"

---

# Per-Harness Configuration Mapping Specification

## Scenario: Claude Code native artifact

**Given** the generated Claude artifact exists
**Then** it contains:
- `.claude-plugin/plugin.json`
- `.mcp.json` or equivalent plugin-local MCP config
- `scripts/mcp-wrapper.js`
- `skills/<skill>/SKILL.md` for every bundle skill
**And** the generated artifact does not contain startup/setup hooks or `scripts/setup.js`.
**And** the artifact install does not write user-level `~/.claude/skills/` unless the user chooses fallback direct install.

## Scenario: Claude Code fallback configuration

**Given** the user runs fallback direct install for Claude
**When** MCP configurations are written
**Then** entries are merged into `~/.claude.json`
**And** skills are symlinked (Unix) or junction-linked/copied (Windows) to `~/.claude/skills/`.

## Scenario: Codex CLI native artifact

**Given** the generated Codex artifact exists
**Then** it contains:
- `.codex-plugin/plugin.json` with `skills: "./skills/"`
- local marketplace metadata for `codex plugin marketplace add` flows
- `.mcp.json` or equivalent plugin-local MCP config
- `scripts/mcp-wrapper.js`
- `skills/<skill>/SKILL.md` for every bundle skill
**And** the generated artifact does not contain `hooks/hooks.json` or `scripts/setup.js`.
**And** native install never launches auth/browser.

## Scenario: Codex CLI fallback configuration

**Given** the user runs fallback direct install for Codex
**When** MCP configurations are written
**Then** entries are merged into `~/.codex/config.toml`
**And** skills are symlinked (Unix) or junction-linked/copied (Windows) to `~/.codex/skills/`.

## Scenario: OpenCode fallback configuration

**Given** the user runs fallback direct install for OpenCode
**When** MCP configurations are written
**Then** entries are merged under the `mcp` key in `~/.config/opencode/opencode.jsonc`
**And** skills are symlinked (Unix) or junction-linked/copied (Windows) to `~/.config/opencode/skills/`.

## Scenario: Antigravity native artifact

**Given** the generated Antigravity artifact exists
**Then** it contains:
- `plugin.json`
- `mcp_config.json`
- `scripts/install.js`
- `scripts/mcp-wrapper.js`
- `skills/<skill>/SKILL.md` for every bundle skill
**And** the generated artifact does not contain `hooks.json` or `scripts/setup.js`.
**And** `agy plugin install <artifact-or-dir>` stages the plugin under `~/.gemini/antigravity-cli/plugins/nsolid-plugin/`
**And** native install does not launch auth/browser.

## Scenario: Antigravity fallback configuration

**Given** the user runs fallback direct install for Antigravity
**When** MCP configurations are written
**Then** entries are merged into `~/.gemini/antigravity-cli/mcp_config.json`
**And** skills are symlinked (Unix) or junction-linked/copied (Windows) to `~/.gemini/antigravity-cli/skills/`.

## Scenario: Pi Agent configuration

**Given** the user installs the Pi package
**When** the package is packed or released
**Then** `packages/pi-plugin/skills/` is materialized from `packages/core/skills/` for the package artifact
**And** source-mode cleanup removes materialized Pi skills after pack
**And** Pi package activation is side-effect free: no browser auth, no user-level skill copy/link, and no MCP config write
**When** the user runs `nsolid-plugin setup --harness pi`
**Then** Pi MCP entries are written to `~/.pi/agent/mcp.json`
**And** each NodeSource Pi MCP entry includes `"auth": false`
**And** setup does not copy or link skills into `~/.agents/skills/` or `~/.pi/agent/skills/`
**And** Pi loads skills from the installed Pi package.

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
3. **Permission issues**: If file permissions prevent writing, provide platform-aware error messages (Unix: `sudo`/`chmod` guidance; Windows: "Run as Administrator" or `icacls` guidance)
4. **Network failures**: Auth and MCP health checks must handle network errors gracefully
5. **Port conflicts**: Auth callback server must handle port conflicts with fallback strategy
