# NodeSource AI Skills for Antigravity CLI

N|Solid performance & security skills for Node.js.

## Install

```bash
node packages/antigravity-plugin/scripts/install.js
```

This copies the plugin to `~/.gemini/config/plugins/nodesource-nsolid/` and runs authentication + MCP configuration.

## What's Included

- 15 AI skills for Node.js performance and security analysis
- MCP server configuration

## Verify

Restart Antigravity, then:
- `/skills` — NodeSource skills should appear
- `/mcp` — MCP servers should be registered

## Limitations

- Antigravity does not support install-time hooks; setup is manual
- MCP server sources must be installed separately to `~/.agents/mcp-servers/`
