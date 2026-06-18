# Proposal

## Problem Statement

NodeSource has developed 15 production-ready AI skills and 3 MCP servers (nsolid-console, ns-benchmark, ncm) that power N|Solid performance and security investigations. These capabilities need a clean distribution mechanism across multiple AI coding harnesses.

Users of AI coding harnesses (Claude Code, Codex CLI, OpenCode, Antigravity CLI 2.0, Pi Agent) cannot easily discover, install, or use these NodeSource capabilities. Each harness has its own plugin format and marketplace, requiring separate packaging and distribution strategies.

Without marketplace presence, adoption is limited to manual installation by users who already know about these tools. This severely limits the reach and impact of the investment in skills and MCP servers.

## Proposed Solution

Create a **generated native artifact + shared core** architecture that supports marketplace submission where available without committing duplicate plugin package trees.

### Shared Core (`packages/core`)
- **Bundle descriptor**: validated descriptor defining skills, MCP servers, and metadata.
- **Canonical skills**: `packages/core/skills/` is the only committed N|Solid skill source.
- **Auth module**: Adapt nsentinel OAuth flow for CLI context (browser redirect + local callback server), invoked only by explicit `setup`/`login`.
- **Fallback installer**: `install --harness <harness>` directly installs assets when native plugin install is unavailable; it does not open a browser.
- **MCP config writer**: Generate harness-specific MCP configurations for setup/fallback paths.
- **Tracking file**: `~/.agents/.nodesource-installed.json` for clean CLI/fallback uninstall.

### Generated Native Artifacts
Claude, Codex, and Antigravity use generated, self-contained artifacts instead of workspace packages:

1. **Claude Code artifact** (`dist/plugins/claude/nsolid-plugin/`)
   - Generated from `plugins/templates/claude/`.
   - Contains `.claude-plugin/plugin.json`, MCP wrapper/config, and materialized `skills/`.
   - Suitable for local install or marketplace submission when accepted.

2. **Codex artifact** (`dist/plugins/codex/nsolid-plugin/`)
   - Generated from `plugins/templates/codex/`.
   - Contains `.codex-plugin/plugin.json`, local marketplace metadata, MCP wrapper/config, and materialized `skills/`.
   - Supports `codex plugin marketplace add` local/repo marketplace flows.

3. **Antigravity artifact** (`dist/plugins/antigravity/nsolid-plugin/`)
   - Generated from `plugins/templates/antigravity/`.
   - Contains `plugin.json`, `mcp_config.json`, `scripts/install.js`, MCP wrapper, and materialized `skills/`.
   - Supports `agy plugin install /path/to/plugin` local/remote install.

4. **Pi Agent package** (`packages/pi-plugin`)
   - Remains a real package because Pi installs packages directly.
   - Receives materialized `skills/` during package `prepack`; source mode stays clean.
   - Package activation is side-effect free; explicit setup writes `~/.pi/agent/mcp.json` with `"auth": false` for `pi-mcp-adapter`.

5. **OpenCode fallback**
   - Remains CLI/fallback install only until its plugin distribution model is clearer.

### Auth Flow Integration
Adapt the nsentinel-vscode-extension OAuth flow:
- Browser redirect to `accounts.nodesource.com/sign-in`.
- Local HTTP callback server (port 8765 with fallbacks) to receive tokens.
- Store service token, org ID, console URL, SaaS token, MCP URL, and expiry in `~/.agents/.nodesource-auth.json`.
- MCP wrappers read credentials from this file at runtime.
- Runtime unauthenticated failures tell the user to run `nsolid-plugin setup`.
- Token validation via `/accounts/org/access-token` endpoint where available.

### Installation and Setup Flow
1. Release/build runs `pnpm plugin:artifacts` to generate self-contained Claude/Codex/Antigravity plugin dirs and `.tgz` artifacts.
2. User installs the native plugin artifact through the harness (`claude`, `codex`, or `agy`) or installs Pi through `pi install npm:@nodesource/pi-plugin`.
3. Native install places plugin assets only; it must not open a browser or start OAuth.
4. User runs `nsolid-plugin setup --harness <harness>` to authenticate and write any setup-time config.
5. If native install is unavailable, user may run `nsolid-plugin install --harness <harness>` as fallback direct asset installation; this path also must not open a browser.

Research backing this model is documented in `docs/plugin-marketplace-research.md`.

## Rollback Plan

If marketplace plugins cause issues:

> **Note**: Rollback is an **emergency full cleanup** that removes all NodeSource artifacts including shared credentials. Normal per-harness uninstall (see installation-and-auth.md) **preserves** `~/.agents/.nodesource-auth.json` for re-use across harnesses.

1. **Native artifact uninstall**: Users uninstall generated plugin artifacts through the harness UI/CLI where supported. The harness removes the native plugin directory and its artifact-local skills/config.

2. **Fallback/CLI uninstall**: `nsolid-plugin uninstall --harness <harness>` reads `~/.agents/.nodesource-installed.json`, removes tracked MCP entries from harness configs, removes tracked fallback skill links/copies, and preserves shared credentials.

3. **Emergency rollback auth cleanup**: Delete `~/.agents/.nodesource-auth.json` only in full rollback, not normal uninstall.

4. **Marketplace removal**: Users can remove marketplace-installed plugins via harness UI (e.g., `/plugins` in Claude Code) or harness CLI (`codex plugin ...`, `agy plugin uninstall ...`).

5. **Fallback**: Shared core can also be invoked directly via `nsolid-plugin uninstall --harness <harness>` for manual cleanup.

## Affected Components

### Packages and Generated Assets
- `packages/core` - Shared CLI/setup/fallback installer logic, auth module, bundle descriptor validation, canonical skills.
- `packages/pi-plugin` - Real Pi Agent package; skills materialized only during pack/release.
- `plugins/templates/claude` - Source template for generated Claude artifact.
- `plugins/templates/codex` - Source template for generated Codex artifact.
- `plugins/templates/antigravity` - Source template for generated Antigravity artifact.
- `scripts/plugin-generators.mjs` - Shared manifest/config/wrapper generation helpers.
- `scripts/build-plugin-artifacts.mjs` - Generates `dist/plugins/` and `dist/artifacts/`.
- `scripts/sync-plugin-assets.mjs` - Source hygiene checks and Pi materialization/cleanup.

### Shared Resources
- `bundle.json` - Canonical bundle descriptor (skills + MCP servers).
- `packages/core/skills/` - Canonical committed skill source.
- `packages/core/src/validate.ts` - Bundle descriptor validation.

### External Dependencies
- **Auth**: NodeSource Accounts API (`accounts.nodesource.com`)
- **MCP Servers**: 
  - ns-benchmark (Node.js benchmarking)
  - nsolid-console (N|Solid console integration)
  - ncm (package vulnerability/quality metrics)
- **Skills**: N|Solid skills from the canonical `packages/core/skills/` bundle

### Harness Config Locations
Supported platforms: **macOS**, **Linux**, and **Windows**.

All paths use `~` as shorthand for the user's home directory (`$HOME` on macOS/Linux, `%USERPROFILE%` on Windows). At runtime, paths are resolved via `os.homedir()` + `path.join()`.

- Claude Code fallback: `~/.claude.json`, `~/.claude/skills/`; native artifact also contains plugin-local `.mcp.json` and `skills/`.
- Codex CLI fallback: `~/.codex/config.toml`, `~/.codex/skills/`; native artifact also contains plugin-local `.mcp.json`, `.codex-plugin/plugin.json`, and `skills/`.
- OpenCode fallback: `~/.config/opencode/opencode.jsonc`, `~/.config/opencode/skills/`.
- Antigravity fallback: `~/.gemini/antigravity-cli/mcp_config.json`, `~/.gemini/antigravity-cli/skills/`; native install stages plugin-local assets under `~/.gemini/antigravity-cli/plugins/nsolid-plugin/`.
- Pi Agent setup: `~/.pi/agent/mcp.json`; Pi package owns `skills/`; NodeSource MCP entries include `"auth": false`.

> **Windows note**: Current adapters resolve these paths from `os.homedir()` (`%USERPROFILE%`). Claude, Codex, and Pi still honor their documented environment overrides where implemented. See design.md Platform Path Resolution for full details.

## Success Criteria

### Functional Requirements
- [ ] `pnpm plugin:artifacts` creates self-contained Claude, Codex, and Antigravity plugin directories plus archives under `dist/`.
- [ ] `packages/core/skills/` is the only committed N|Solid skill source.
- [ ] Pi remains installable as a real package with materialized skills in packed artifacts.
- [ ] Auth flow completes successfully only through explicit setup/login (browser OAuth + token storage).
- [ ] Native install, generated install scripts, Pi package activation, and fallback `install --harness` do not open a browser.
- [ ] All skills are discoverable by each supported harness path (native artifact or fallback).
- [ ] MCP servers are configured/reachable where supported.
- [ ] Uninstall/fallback cleanup removes only tracked NodeSource artifacts.
- [ ] Doctor command verifies installation health.

### Quality Requirements
- [ ] Zero overwrites of existing user configurations (merge, don't replace).
- [ ] Idempotent setup and fallback installation.
- [ ] Auth tokens stored securely (file permissions 0600; best-effort on Windows where `chmod` has limited effect).
- [ ] Generated manifests/configs pass schema/shape validation.
- [ ] `pnpm plugin:check` catches stale generated files and accidental package-local skill copies.

### Verification
- [ ] Manual test: Build artifacts, install generated artifact for each native harness, run setup, verify skills and MCPs work.
- [ ] Automated test: Bundle descriptor validates against the core schema validator.
- [ ] Automated test: Auth flow mocked in CI, real flow tested manually.
- [ ] Automated test: Generated artifacts contain all bundle skills and no auth/browser behavior in install paths.
- [ ] Automated test: Fallback install/uninstall cycle leaves no unexpected artifacts.
- [ ] Integration test: Each harness discovers installed skills.
- [ ] Integration test: MCP servers respond to health checks.

### Acceptance Tests
1. **Claude Code**: Generated Claude artifact contains `.claude-plugin/plugin.json`, MCP wrapper/config, and all skills; user installs artifact/marketplace entry, runs setup, and can invoke `ns-analyze-vulnerabilities`.
2. **Codex CLI**: Generated Codex artifact contains `.codex-plugin/plugin.json` with `skills: "./skills/"`, local marketplace metadata, MCP wrapper/config, and all skills; user adds marketplace/artifact, runs setup, and MCP tools are available.
3. **OpenCode**: User uses fallback direct install; skills appear in OpenCode skill discovery and MCP config is merged.
4. **Antigravity**: Generated Antigravity artifact contains `plugin.json`, `mcp_config.json`, `scripts/install.js`, MCP wrapper, and all skills; `agy plugin install` stages the plugin and setup handles auth.
5. **Pi Agent**: User installs `@nodesource/pi-plugin`, runs setup, and Pi has package-owned skills plus MCP config with `"auth": false`.
6. **Auth**: First-time setup triggers browser OAuth; install paths never do.
7. **Uninstall**: User uninstalls native artifact or runs CLI uninstall; only NodeSource artifacts are removed.
