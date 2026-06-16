# Antigravity CLI — Plugin Research (Task 38)

**Status:** Complete (June 2026).  
**Verdict:** Antigravity has no install-time/session-start hook, so the plugin must ship a one-time `scripts/install.js` that the user runs manually. That script copies the plugin directory for discovery and invokes the shared core installer so auth, MCP config, and skills work consistently with the other harnesses.

---

## Sources

- https://antigravity.google/docs/plugins
- https://antigravity.google/docs/hooks
- https://antigravity.google/docs/skills
- https://antigravity.google/docs/cli-features
- https://medium.com/google-cloud/configuring-mcp-servers-and-skills-for-antigravity-cli-and-ide-a938c7eebb78 (real-world corroboration)

---

## 1. Plugin model

A plugin is a directory containing a root `plugin.json`:

```json
{ "name": "nodesource-nsolid" }
```

- `name` is optional, defaults to directory name.
- Auto-discovered components: `skills/`, `rules/`, `mcp_config.json`, `hooks.json`.
- Discovery paths: workspace `<workspace>/.agents/plugins/<name>/` and global `~/.gemini/config/plugins/<name>/`.
- No third-party marketplace exists. Distribution is manual folder placement or a local installer script.

---

## 2. Hooks (no install-time event)

Supported events (complete list):

- `PreToolUse`
- `PostToolUse`
- `PreInvocation`
- `PostInvocation`
- `Stop`

**There is no `SessionStart`, `Startup`, or install-time event.** The closest, `PreInvocation`, fires before every model call, making it unsuitable for one-time setup.

---

## 3. Skills and MCP paths

| Purpose | Path |
|---|---|
| Shared MCP config (preferred) | `~/.gemini/config/mcp_config.json` |
| Shared skills (real-world) | `~/.gemini/skills/` |
| Agy-CLI-only paths (legacy) | `~/.gemini/antigravity-cli/mcp_config.json`, `~/.gemini/antigravity-cli/skills/` |

The current core adapter (`packages/core/src/harnesses/antigravity-adapter.ts`) targets the Agy-CLI-only paths and must be updated to the shared cross-product paths.

---

## 4. Env vars in `mcp_config.json`

Antigravity does **not** interpolate environment variables in `mcp_config.json` (confirmed June 2026). Therefore the core installer must expand variables such as `${MCP_ROOT}` and `${AUTH_TOKEN}` before writing the file.

---

## 5. Chosen design for Task 26

- Ship a native `plugin.json`.
- Ship `scripts/install.js` that the user runs once.
- The script copies the plugin directory to `~/.gemini/config/plugins/nodesource-nsolid/` and then calls `@nodesource/plugin-core`'s `install({ harness: 'antigravity', bundlePath, skillsSource })`.
- Skills and MCP config are **not** bundled in the plugin; they are produced by the core installer.
- The core Antigravity adapter is updated to write to `~/.gemini/config/mcp_config.json` and `~/.gemini/skills/`.
