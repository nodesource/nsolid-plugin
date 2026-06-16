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

Pi does not natively support MCP. After installing this plugin, install one of these MCP adapter extensions so Pi can use the configured NodeSource MCP servers:

```bash
pi install npm:pi-mcp-adapter
# or
pi install npm:@0xkobold/pi-mcp
```

Without an adapter, the MCP-backed skills will be installed but their tools will be unavailable.
