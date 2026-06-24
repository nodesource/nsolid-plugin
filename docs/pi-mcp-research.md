# Pi Agent MCP Support Research

> **Amendment (2026-06-24):** Packages were renamed — `@nodesource/plugin-core` → `nsolid-plugin` and `@nodesource/pi-plugin` → `nsolid-pi-plugin`. References below use the old names; the analysis itself is unchanged.

## Problem

The NodeSource cross-harness plugin installer supports five AI harnesses. Four of them (Claude Code, Codex CLI, OpenCode, Antigravity) have native or file-based MCP configuration mechanisms. Pi Agent does not natively support the Model Context Protocol (MCP). This means MCP-backed NodeSource skills have no tools available when the user installs `@nodesource/pi-plugin`.

## Pi's Extension Model

Pi loads capabilities through:

- **Skills**: markdown prompt files placed in `~/.pi/agent/skills/` or project-local `.pi/skills/`.
- **Extensions**: TypeScript/JavaScript modules placed in `~/.pi/agent/extensions/` or declared via a package's `pi.extensions` field.
- **Pi packages**: npm/git packages installed with `pi install npm:<name>` that can declare `pi.extensions`.

There is no `mcpServers` key or native MCP client in Pi. The only way to make MCP servers usable inside Pi is to ship or install a Pi extension that acts as an MCP client and bridges MCP tools into Pi's native `registerTool()` API.

## Existing Community Adapters

Two community extensions bridge MCP servers into Pi:

### 1. `@0xkobold/pi-mcp`

A full MCP client extension that auto-registers every MCP tool as a native Pi tool.

- Supports `stdio`, `SSE`, `streamable-http`, and `websocket` transports.
- Reads `~/.0xkobold/mcp.json`.
- Auto-reconnects and supports tool filtering.
- Each server exposes tools named `mcp_<server>_<tool>`.
- Token cost grows with every registered tool.

Example server config:

```json
{
  "servers": [
    {
      "name": "nsolid-console",
      "transport": {
        "type": "streamable-http",
        "url": "https://<id>.mcp.saas.nodesource.io",
        "headers": { "X-Nsolid-Service-Token": "${AUTH_TOKEN}" }
      },
      "enabled": true
    }
  ]
}
```

Install:

```bash
pi install npm:@0xkobold/pi-mcp
```

### 2. `pi-mcp-adapter` (nicobailon)

A token-efficient proxy adapter. Instead of registering every MCP tool, it exposes a single `mcp` proxy tool (~200 tokens) and connects to servers lazily.

- Reads standard MCP files: `~/.config/mcp/mcp.json`, `.mcp.json`, `~/.pi/agent/mcp.json`, `.pi/mcp.json`.
- Supports `directTools` for promoting specific tools to native Pi tools.
- Supports OAuth, bearer tokens, env interpolation, and metadata caching.
- Recommended when context-window efficiency matters.

Example shared config:

```json
{
  "mcpServers": {
    "nsolid-console": {
      "url": "https://<id>.mcp.saas.nodesource.io",
      "headers": { "X-Nsolid-Service-Token": "${AUTH_TOKEN}" }
    }
  }
}
```

Install:

```bash
pi install npm:pi-mcp-adapter
```

## Recommended Strategy: Option A + C

Because Pi has no native MCP configuration target, the NodeSource plugin should:

1. **Write a Pi-owned MCP config file** at `~/.pi/agent/mcp.json` during installation. This file uses the standard `mcpServers` format with `url` and `headers` that `pi-mcp-adapter` consumes directly. Note that `@0xkobold/pi-mcp` reads a separate file (`~/.0xkobold/mcp.json`) using a different `servers[]` format, so it does **not** auto-consume this config; only `pi-mcp-adapter` is directly compatible with this setup.
2. **Document the adapter requirement** so users know they must also install an MCP adapter extension for Pi to actually use the NodeSource MCP servers.

This is the smallest code change and reuses the existing cross-harness MCP config pipeline.

### Why not a custom NodeSource Pi extension?

Building a custom bridge inside `@nodesource/pi-plugin` would remove the external dependency but would require:

- Bundling and maintaining an MCP client SDK inside the plugin.
- Mapping NodeSource MCP tools to Pi tool schemas.
- Handling transport lifecycle, reconnects, and OAuth inside Pi's extension runtime.

That approach is significantly more code and ongoing maintenance. Using an established adapter and only supplying the config file is simpler and more robust.

### File ownership and precedence

`pi-mcp-adapter` reads config from multiple locations in this precedence:

1. `~/.config/mcp/mcp.json` (user-global shared)
2. `~/.pi/agent/mcp.json` (Pi global override)
3. `.mcp.json` (project-local shared)
4. `.pi/mcp.json` (project-local override)

NodeSource should write to `~/.pi/agent/mcp.json` because it is a Pi-specific, harness-owned location. It does not collide with user-global shared configs and is automatically picked up by the adapter.

## PiAdapter Change

The current `PiAdapter` explicitly disables MCP:

```ts
getMcpConfigPath (): string | null {
  return null
}

supportsMcp (): boolean {
  return false
}
```

The change is to enable it and return the Pi-owned MCP config path:

```ts
getMcpConfigPath (): string {
  return resolveHome('~/.pi/agent/mcp.json')
}

supportsMcp (): boolean {
  return true
}
```

The shared `mcp-config-writer.ts` already emits the correct JSON format (`url` + `headers`), so no writer changes are required. The existing credential expansion (`AUTH_TOKEN`, `AUTH_ORG_ID`, `MCP_URL`) already produces the right values.

## Uninstall Implications

With MCP enabled for Pi, uninstall must remove the NodeSource MCP entries from `~/.pi/agent/mcp.json`. The shared `removeMcpConfig()` path already handles this once `PiAdapter` returns a config path. The best-effort cleanup list in the spec already names the three MCP server entries (`nsolid-console`, `ns-benchmark`, `ncm`), so no new names are introduced.

## Security Considerations

- `~/.pi/agent/mcp.json` will contain the service token in plain text, just like `~/.claude.json` and other harness configs.
- The file is written by the same shared writer that preserves existing non-NodeSource entries.
- Credentials remain stored only in `~/.agents/.nodesource-auth.json` with 0600 permissions.

## User-Facing Documentation

Pi users should install in this order:

```bash
# 1. Install the NodeSource plugin (writes ~/.pi/agent/mcp.json and skills)
pi install npm:nsolid-pi-plugin

# 2. Install pi-mcp-adapter so Pi can use the configured servers.
#    It reads ~/.pi/agent/mcp.json automatically.
pi install npm:pi-mcp-adapter
```

> `@0xkobold/pi-mcp` is an alternative adapter, but it reads `~/.0xkobold/mcp.json` in a different (`servers[]`) format and does not pick up the NodeSource config automatically. Use `pi-mcp-adapter` unless you are willing to maintain a separate `~/.0xkobold/mcp.json`.

Without step 2, the MCP config file exists but Pi has no MCP client, so the skills will still show `requiresMcp` warnings and their tools will be unavailable.

## Open Questions

- Should the NodeSource plugin detect whether an MCP adapter is installed and warn the user if one is missing? This would improve UX but requires inspecting Pi's extension directories.
- Should the plugin prefer `pi-mcp-adapter` or `@0xkobold/pi-mcp` in documentation? `pi-mcp-adapter` is more token-efficient; `@0xkobold/pi-mcp` is more automatic. The research doc presents both so the team can decide.
