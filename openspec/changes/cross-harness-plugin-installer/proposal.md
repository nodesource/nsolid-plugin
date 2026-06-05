# Proposal

## Problem Statement

NodeSource has developed 14 production-ready AI skills and 3 MCP servers (ns-benchmark, nsolid-mcp, ncm-mcp) that power N|Solid performance and security investigations. Currently, these capabilities exist only in a proof-of-concept repository (skills-poc) with no distribution mechanism.

Users of AI coding harnesses (Claude Code, Codex CLI, OpenCode, Antigravity CLI 2.0, Pi Agent) cannot easily discover, install, or use these NodeSource capabilities. Each harness has its own plugin format and marketplace, requiring separate packaging and distribution strategies.

Without marketplace presence, adoption is limited to manual installation by users who already know about these tools. This severely limits the reach and impact of the investment in skills and MCP servers.

## Proposed Solution

Create a **marketplace-native plugin architecture** that publishes NodeSource capabilities to each harness's official marketplace while sharing a common core:

### Shared Core (packages/core)
- **Bundle descriptor**: JSON schema defining skills, MCP servers, and metadata
- **Auth module**: Adapt nsentinel OAuth flow for CLI context (browser redirect + local callback server)
- **Skill copier**: Install skills to `~/.agents/skills/` (universal path)
- **MCP config writer**: Generate harness-specific MCP configurations
- **Tracking file**: `~/.agents/.nodesource-installed.json` for clean uninstall

### Per-Marketplace Packages
Each marketplace gets its own package with native manifest:

1. **Claude Code Plugin** (packages/claude-plugin)
   - `.claude-plugin/plugin.json` manifest
   - Bundles skills and MCP configs
   - Published to Claude marketplace

2. **Codex Plugin** (packages/codex-plugin)
   - `.codex-plugin/plugin.json` manifest
   - Optional `agents/openai.yaml` for UI metadata
   - Published to Codex marketplace (`codex plugin marketplace add`)

3. **OpenCode Plugin** (packages/opencode-plugin)
   - npm package with `opencode.jsonc` config
   - Published to npm, installed via OpenCode plugin registry

4. **Antigravity Plugin** (packages/antigravity-plugin)
   - Antigravity-specific manifest format
   - Published to Antigravity marketplace

5. **Pi Agent Plugin** (packages/pi-plugin)
   - npm/git package (skills only, no MCP - Pi rejects MCP on context-budget grounds)
   - Published to Pi marketplace

### Auth Flow Integration
Adapt the nsentinel-vscode-extension OAuth flow:
- Browser redirect to `accounts.nodesource.com/sign-in`
- Local HTTP callback server (port 8765) to receive tokens
- Store service token and org ID in `~/.agents/.nodesource-auth.json`
- MCP servers read credentials from this file
- Token validation via `/accounts/org/access-token` endpoint
- Permissions checked (e.g., `nsolid:benchmark:run`)

### Installation Flow
1. User installs plugin from marketplace (e.g., `/plugins` in Claude Code)
2. Plugin post-install hook runs shared core installer
3. Auth flow triggers if no valid credentials exist
4. Skills copied to `~/.agents/skills/`
5. MCP configs written to harness-specific locations
6. Tracking file created for uninstall

## Rollback Plan

If marketplace plugins cause issues:

> **Note**: Rollback is an **emergency full cleanup** that removes all NodeSource artifacts including shared credentials. Normal per-harness uninstall (see installation-and-auth.md) **preserves** `~/.agents/.nodesource-auth.json` for re-use across harnesses.

1. **Per-harness uninstall**: Each plugin includes uninstall hook that:
   - Reads `~/.agents/.nodesource-installed.json`
   - Removes MCP entries from harness configs
   - Deletes skill directories from `~/.agents/skills/`
   - Removes tracking file
   - **Does NOT** delete `~/.agents/.nodesource-auth.json` (credentials preserved for other harnesses)

2. **Emergency rollback auth cleanup**: Delete `~/.agents/.nodesource-auth.json` (only in full rollback, not normal uninstall)

3. **Marketplace removal**: Users can uninstall via harness UI (e.g., `/plugins` in Claude Code)

4. **Fallback**: Shared core can also be invoked directly via `npx @nodesource/ai-skills uninstall` for manual cleanup

## Affected Components

### New Packages
- `packages/core` - Shared installer logic, auth module, bundle descriptor
- `packages/claude-plugin` - Claude Code marketplace plugin
- `packages/codex-plugin` - Codex CLI marketplace plugin
- `packages/opencode-plugin` - OpenCode marketplace plugin
- `packages/antigravity-plugin` - Antigravity CLI marketplace plugin
- `packages/pi-plugin` - Pi Agent marketplace plugin (skills only)

### Shared Resources
- `bundle.json` - Canonical bundle descriptor (skills + MCP servers)
- `skills/` - Symlinked from skills-poc or copied
- `schemas/` - JSON Schema for bundle.json validation

### External Dependencies
- **Auth**: NodeSource Accounts API (`accounts.nodesource.com`)
- **MCP Servers**: 
  - ns-benchmark (Node.js benchmarking)
  - nsolid-mcp (N|Solid console integration)
  - ncm-mcp (package vulnerability/quality metrics)
- **Skills**: 14 skills from skills-poc repository

### Harness Config Locations
Supported platforms: **macOS**, **Linux**, and **Windows**.

All paths use `~` as shorthand for the user's home directory (`$HOME` on macOS/Linux, `%USERPROFILE%` on Windows). At runtime, paths are resolved via `os.homedir()` + `path.join()`.

- Claude Code: `~/.claude.json`, `~/.claude/skills/`
- Codex CLI: `~/.codex/config.toml`, `~/.codex/skills/`
- OpenCode: `~/.config/opencode/opencode.jsonc`, `~/.config/opencode/skills/`
- Antigravity: `~/.gemini/antigravity-cli/mcp_config.json`, `~/.gemini/antigravity-cli/skills/`
- Pi Agent: `~/.pi/agent/skills/` (no MCP config)

> **Windows note**: Some harnesses may use `%APPDATA%` instead of `%USERPROFILE%` for config storage. Verify actual locations during adapter implementation. See design.md Platform Path Resolution for full details.

## Success Criteria

### Functional Requirements
- [ ] All 5 marketplace plugins can be installed from their respective marketplaces
- [ ] Auth flow completes successfully (browser OAuth + token storage)
- [ ] All 14 skills are discoverable by each harness
- [ ] All 3 MCP servers are configured and reachable (except Pi)
- [ ] Uninstall cleanly removes all artifacts
- [ ] Doctor command verifies installation health

### Quality Requirements
- [ ] Zero overwrites of existing user configurations (merge, don't replace)
- [ ] Idempotent installation (re-running install is safe)
- [ ] Auth tokens stored securely (file permissions 0600; best-effort on Windows where `chmod` has limited effect)
- [ ] All marketplace plugins pass validation (schema compliance)

### Verification
- [ ] Manual test: Install from each marketplace, verify skills and MCPs work
- [ ] Automated test: Bundle descriptor validates against JSON Schema
- [ ] Automated test: Auth flow mocked in CI, real flow tested manually
- [ ] Automated test: Install/uninstall cycle leaves no artifacts
- [ ] Integration test: Each harness discovers installed skills
- [ ] Integration test: MCP servers respond to health checks

### Acceptance Tests
1. **Claude Code**: User runs `/plugins`, finds "NodeSource AI Skills", installs, can invoke `ns-analyze-vulnerabilities` skill
2. **Codex CLI**: User runs `codex plugin marketplace add nodesource/ai-skills`, installs, MCP tools available
3. **OpenCode**: User installs via plugin registry, skills appear in skill list
4. **Antigravity**: User installs from marketplace, capabilities accessible
5. **Pi Agent**: User installs, skills available (no MCP)
6. **Auth**: First-time install triggers browser OAuth, subsequent installs use stored token
7. **Uninstall**: User uninstalls via marketplace UI, all NodeSource artifacts removed
