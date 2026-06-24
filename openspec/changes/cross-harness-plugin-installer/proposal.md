# Proposal

## Problem Statement

NodeSource has developed 15 production-ready AI skills and 3 MCP servers (nsolid-console, ns-benchmark, ncm) that power N|Solid performance and security investigations. These capabilities need a clean distribution mechanism across multiple AI coding harnesses.

Users of AI coding harnesses (Claude Code, Codex CLI, OpenCode, Antigravity CLI 2.0, Pi Agent) cannot easily discover, install, or use these NodeSource capabilities. Each harness has its own plugin format and marketplace, requiring separate packaging and distribution strategies.

Without marketplace presence, adoption is limited to manual installation by users who already know about these tools. This severely limits the reach and impact of the investment in skills and MCP servers.

## Proposed Solution

Create a **shared core + GitHub-root plugin + Pi package** architecture. The repository root is itself the installable plugin for Claude, Codex, and Antigravity (mirroring `addyosmani/agent-skills`), so a single GitHub URL works across all three harnesses without committing duplicate plugin package trees or generating `.tgz` archives.

### Shared Core (`packages/core`)
- **Bundle descriptor**: validated descriptor defining skills, MCP servers, and metadata.
- **Canonical skills**: `skills/` at the repository root is the only committed N|Solid skill source.
- **Auth module**: Adapt nsentinel OAuth flow for CLI context (browser redirect + local callback server), invoked only by explicit `setup`/`login`.
- **Fallback installer**: `install --harness <harness>` directly installs assets when native plugin install is unavailable; it does not open a browser.
- **MCP config writer**: Generate harness-specific MCP configurations for setup/fallback paths.
- **Tracking file**: `~/.agents/.nodesource-installed.json` for clean CLI/fallback uninstall.

### GitHub-Root Plugin (Claude / Codex / Antigravity)
The repository root is simultaneously a Claude, Codex, and Antigravity plugin root. The committed root manifests point each harness at the same shared `skills/` tree and `scripts/mcp-wrapper.js`:

1. **Claude Code** — root `.claude-plugin/marketplace.json` + `.claude-plugin/plugin.json` declare a marketplace whose single plugin sources the root (`source: "./"`); the plugin lists `./skills/<name>` and `mcpServers: "./.claude-mcp.json"`. Install: `claude plugin marketplace add NodeSource/nsolid-plugin && claude plugin install nsolid-plugin@nodesource`.

2. **Codex CLI** — root `.agents/plugins/marketplace.json` + `.codex-plugin/plugin.json` declare a marketplace whose plugin sources the root (`source: { source: "local", path: "./" }`); the plugin lists `skills: "./skills/"` and `mcpServers: "./.mcp.json"`. Install: `codex plugin marketplace add NodeSource/nsolid-plugin && codex plugin add nsolid-plugin@nodesource`.

3. **Antigravity CLI** — root `plugin.json` is the Antigravity plugin root; `mcp_config.json` references `scripts/mcp-wrapper.js`. Install: `agy plugin install https://github.com/NodeSource/nsolid-plugin.git` (or a `/tree/<branch>` URL for pre-merge QA).

Root manifests are generated from `bundle.json` by `scripts/materialize-github-marketplace.mjs` (`pnpm plugin:root`) and committed. There are no generated `dist/plugins/` directories or `.tgz` archives.

4. **Pi Agent package** (`packages/pi-plugin`)
   - Remains a real, publishable package because Pi installs packages directly.
   - Receives materialized `skills/` during package `prepack`; source mode stays clean (`postpack`/`plugin:clean` removes them).
   - Package activation is side-effect free; explicit setup writes `~/.pi/agent/mcp.json` with `"auth": false` for `pi-mcp-adapter`.

5. **OpenCode fallback**
   - Remains CLI/fallback install only until its plugin distribution model is clearer. `setup --harness opencode` authenticates and copies skills directly; `install` is no-browser fallback/repair.

### Auth Flow Integration
Adapt the nsentinel-vscode-extension OAuth flow:
- Browser redirect to `accounts.nodesource.com/sign-in`.
- Local HTTP callback server (port 8765 with fallbacks) to receive tokens.
- Store service token, org ID, console URL, SaaS token, MCP URL, and expiry in `~/.agents/.nodesource-auth.json`.
- MCP wrappers read credentials from this file at runtime.
- Runtime unauthenticated failures tell the user to run `nsolid-plugin setup`.
- Token validation via `/accounts/org/access-token` endpoint where available.

### Installation and Setup Flow
1. Root manifests are kept in sync with `bundle.json` via `pnpm plugin:root` (committed, not a release-time generation step). `pnpm plugin:root:check` (also run by `pnpm plugin:check`) fails CI if the committed manifests drift.
2. User installs the plugin through the harness from the GitHub root (`claude`/`codex` marketplace add, or `agy plugin install <git-url>`), or installs Pi through `pi install npm:nsolid-pi-plugin`.
3. Native install places plugin assets only; it must not open a browser or start OAuth.
4. User runs `nsolid-plugin setup --harness <harness>` to authenticate and write any setup-time config.
5. If native install is unavailable, user may run `nsolid-plugin install --harness <harness>` as fallback direct asset installation; this path also must not open a browser.

Research backing this model is documented in `docs/plugin-marketplace-research.md` (with an amendment note recording the move from generated artifacts to the GitHub-root model).

## Rollback Plan

If marketplace plugins cause issues:

> **Note**: Rollback is an **emergency full cleanup** that removes all NodeSource artifacts including shared credentials. Normal per-harness uninstall (see installation-and-auth.md) **preserves** `~/.agents/.nodesource-auth.json` for re-use across harnesses.

1. **Native plugin uninstall**: Users uninstall the GitHub-root plugin through the harness UI/CLI where supported (e.g., `/plugins` in Claude Code, `codex plugin remove`, `agy plugin uninstall`). The harness removes the staged plugin directory and its skills/config.

2. **Fallback/CLI uninstall**: `nsolid-plugin uninstall --harness <harness>` reads `~/.agents/.nodesource-installed.json`, removes tracked MCP entries from harness configs, removes tracked fallback skill links/copies, and preserves shared credentials.

3. **Emergency rollback auth cleanup**: Delete `~/.agents/.nodesource-auth.json` only in full rollback, not normal uninstall.

4. **Marketplace removal**: Users can remove marketplace-installed plugins via harness UI (e.g., `/plugins` in Claude Code) or harness CLI (`codex plugin remove`, `agy plugin uninstall`).

5. **Fallback**: Shared core can also be invoked directly via `nsolid-plugin uninstall --harness <harness>` for manual cleanup.

## Affected Components

### Packages and Root Plugin Assets
- `packages/core` - Shared CLI/setup/fallback installer logic, auth module, bundle descriptor validation, bundled skills (shipped in the npm package).
- `packages/pi-plugin` - Real, publishable Pi Agent package; skills materialized only during pack/release.
- `.claude-plugin/` - Root Claude marketplace + plugin manifests (committed).
- `.codex-plugin/`, `.agents/plugins/` - Root Codex plugin + marketplace manifests (committed).
- `plugin.json`, `mcp_config.json` - Root Antigravity plugin manifest + MCP config (committed).
- `.claude-mcp.json`, `.mcp.json` - Root plugin-local MCP configs pointing at `scripts/mcp-wrapper.js` (committed).
- `scripts/plugin-generators.mjs` - Shared manifest/config/wrapper generation helpers (source of truth for root manifests).
- `scripts/materialize-github-marketplace.mjs` - Materializes the root marketplace/plugin layout from `bundle.json`.
- `scripts/sync-plugin-assets.mjs` - Source hygiene checks and Pi materialization/cleanup.

### Shared Resources
- `bundle.json` - Canonical bundle descriptor (skills + MCP servers).
- `skills/` - Canonical committed skill source at the repository root (shared by the GitHub-root plugin and materialized into the Pi package).
- `packages/core/src/validate.ts` - Bundle descriptor validation.

### External Dependencies
- **Auth**: NodeSource Accounts API (`accounts.nodesource.com`)
- **MCP Servers**: 
  - ns-benchmark (Node.js benchmarking)
  - nsolid-console (N|Solid console integration)
  - ncm (package vulnerability/quality metrics)
- **Skills**: N|Solid skills from the canonical root `skills/` bundle

### Harness Config Locations
Supported platforms: **macOS**, **Linux**, and **Windows**.

All paths use `~` as shorthand for the user's home directory (`$HOME` on macOS/Linux, `%USERPROFILE%` on Windows). At runtime, paths are resolved via `os.homedir()` + `path.join()`.

- Claude Code fallback: `~/.claude.json`, `~/.claude/skills/`; the GitHub-root plugin also carries plugin-local `.claude-mcp.json` and `skills/`.
- Codex CLI fallback: `~/.codex/config.toml`, `~/.codex/skills/`; the GitHub-root plugin also carries plugin-local `.mcp.json`, `.codex-plugin/plugin.json`, and `skills/`.
- OpenCode fallback: `~/.config/opencode/opencode.jsonc`, `~/.config/opencode/skills/`.
- Antigravity fallback: `~/.gemini/antigravity-cli/mcp_config.json`, `~/.gemini/antigravity-cli/skills/`; native install stages plugin-local assets under `~/.gemini/antigravity-cli/plugins/nsolid-plugin/`.
- Pi Agent setup: `~/.pi/agent/mcp.json`; Pi package owns `skills/`; NodeSource MCP entries include `"auth": false`.

> **Windows note**: Current adapters resolve these paths from `os.homedir()` (`%USERPROFILE%`). Claude, Codex, and Pi still honor their documented environment overrides where implemented. See design.md Platform Path Resolution for full details.

## Success Criteria

### Functional Requirements
- [ ] `pnpm plugin:root` regenerates the committed root marketplace/plugin manifests from `bundle.json` and they validate; `pnpm plugin:root:check` detects drift.
- [ ] `skills/` at the repository root is the only committed N|Solid skill source.
- [ ] Claude, Codex, and Antigravity install successfully from the GitHub root (`marketplace add NodeSource/nsolid-plugin` / `agy plugin install <git-url>`).
- [ ] Pi remains installable as a real, publishable package with materialized skills in packed artifacts.
- [ ] Auth flow completes successfully only through explicit setup/login (browser OAuth + token storage).
- [ ] Native install, Pi package activation, and fallback `install --harness` do not open a browser.
- [ ] All skills are discoverable by each supported harness path (GitHub-root native or fallback).
- [ ] MCP servers are configured/reachable where supported.
- [ ] Uninstall/fallback cleanup removes only tracked NodeSource artifacts.
- [ ] Doctor command verifies installation health.

### Quality Requirements
- [ ] Zero overwrites of existing user configurations (merge, don't replace).
- [ ] Idempotent setup and fallback installation.
- [ ] Auth tokens stored securely (file permissions 0600; best-effort on Windows where `chmod` has limited effect).
- [ ] Generated root manifests/configs pass schema/shape validation.
- [ ] `pnpm plugin:check` catches stale generated files and accidental package-local skill copies.

### Verification
- [ ] Manual test: refresh root manifests, install from the GitHub root for each native harness, run setup, verify skills and MCPs work.
- [ ] Automated test: Bundle descriptor validates against the core schema validator.
- [ ] Automated test: Auth flow mocked in CI, real flow tested manually.
- [ ] Automated test: Root plugin assets contain all bundle skills and no auth/browser behavior in install paths.
- [ ] Automated test: Fallback install/uninstall cycle leaves no unexpected artifacts.
- [ ] Integration test: Each harness discovers installed skills.
- [ ] Integration test: MCP servers respond to health checks.

### Acceptance Tests
1. **Claude Code**: Root `.claude-plugin/{marketplace,plugin}.json` list all skills and `.claude-mcp.json`; user runs `claude plugin marketplace add NodeSource/nsolid-plugin && claude plugin install nsolid-plugin@nodesource`, runs setup, and can invoke `ns-analyze-vulnerabilities`.
2. **Codex CLI**: Root `.codex-plugin/plugin.json` declares `skills: "./skills/"` and `.mcp.json`, with root `.agents/plugins/marketplace.json`; user runs `codex plugin marketplace add NodeSource/nsolid-plugin && codex plugin add nsolid-plugin@nodesource`, runs setup, and MCP tools are available.
3. **OpenCode**: User uses fallback direct install; skills appear in OpenCode skill discovery and MCP config is merged.
4. **Antigravity**: Root `plugin.json` + `mcp_config.json` + `scripts/mcp-wrapper.js` + root `skills/`; `agy plugin install https://github.com/NodeSource/nsolid-plugin.git` stages the plugin and setup handles auth.
5. **Pi Agent**: User installs `nsolid-pi-plugin`, runs setup, and Pi has package-owned skills plus MCP config with `"auth": false`.
6. **Auth**: First-time setup triggers browser OAuth; install paths never do.
7. **Uninstall**: User uninstalls the native plugin or runs CLI uninstall; only NodeSource artifacts are removed.
