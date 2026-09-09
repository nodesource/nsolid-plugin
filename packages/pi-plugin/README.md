# N|Solid Plugin for Pi Agent

nsolid-plugin — N|Solid performance & security skills for Node.js.

## Install

```bash
pi install npm:nsolid-pi-plugin
nsolid-plugin setup --harness pi
pi install npm:pi-mcp-adapter
```

Or for local development from the repository root:

```bash
pnpm plugin:materialize
pi install ./packages/pi-plugin --no-approve
nsolid-plugin setup --harness pi
pi install npm:pi-mcp-adapter
/reload
```

To update the package-owned skills through Pi, use the N|Solid updater after the canonical unpinned package is installed:

```bash
nsolid-plugin update --harness pi
nsolid-plugin update --harness pi --check --json
```

The updater coalesces matching user and project entries into one `pi update npm:nsolid-pi-plugin` operation. User-only updates use `--no-approve`; a detected project scope is disclosed and uses `--approve` after confirmation. Source entries, filters, trust settings, MCP configuration, and credentials are left to Pi/the user and are not rewritten by the updater.

After local packaging tests, run `pnpm plugin:clean` to remove materialized skills from the source tree.

Then verify:

```bash
pi list
```

## What's Included

- 16 package-owned AI skills for Node.js performance and security analysis
- Side-effect-free package activation: no browser auth, no user-level skill copy, no MCP config mutation
- MCP configuration written to `~/.pi/agent/mcp.json` only by explicit `nsolid-plugin setup --harness pi`

## MCP Adapter Requirement

Pi does not natively support MCP. After installing this plugin, install the `pi-mcp-adapter` extension so Pi can use the configured NodeSource MCP servers. It reads `~/.pi/agent/mcp.json` directly, so no extra configuration is needed:

```bash
pi install npm:pi-mcp-adapter
```

Without an adapter, the MCP-backed package skills will be available but their tools will be unavailable.

> **Using `@0xkobold/pi-mcp` instead?** It is an alternative adapter, but it reads `~/.0xkobold/mcp.json` in a different (`servers[]`) format and does **not** pick up the config this plugin writes (`~/.pi/agent/mcp.json`). You would need to create and maintain a separate `~/.0xkobold/mcp.json` manually. Prefer `pi-mcp-adapter` for automatic setup.
