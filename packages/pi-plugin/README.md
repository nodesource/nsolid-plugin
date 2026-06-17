# NodeSource AI Skills for Pi Agent

N|Solid performance & security skills for Node.js.

## Install

```bash
pi install npm:@nodesource/pi-plugin
```

Or for local development:

```bash
pi install ./packages/pi-plugin
```

Then verify:

```bash
pi list
```

## What's Included

- 15 AI skills for Node.js performance and security analysis
- Automatic authentication on first load
- MCP configuration written to `~/.pi/agent/mcp.json`

## MCP Adapter Requirement

Pi does not natively support MCP. After installing this plugin, install the `pi-mcp-adapter` extension so Pi can use the configured NodeSource MCP servers. It reads `~/.pi/agent/mcp.json` directly, so no extra configuration is needed:

```bash
pi install npm:pi-mcp-adapter
```

Without an adapter, the MCP-backed skills will be installed but their tools will be unavailable.

> **Using `@0xkobold/pi-mcp` instead?** It is an alternative adapter, but it reads `~/.0xkobold/mcp.json` in a different (`servers[]`) format and does **not** pick up the config this plugin writes (`~/.pi/agent/mcp.json`). You would need to create and maintain a separate `~/.0xkobold/mcp.json` manually. Prefer `pi-mcp-adapter` for automatic setup.
