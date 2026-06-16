# nsolid-plugin

Cross-harness plugin installer for NodeSource AI skills and MCP servers. A single monorepo provides a shared core installer and five per-harness plugin packages, each using the harness's native plugin model.

## Supported harnesses

| Harness | Plugin model | Trigger |
|---|---|---|
| **Claude Code** | Plugin directory + `.claude-plugin/plugin.json` | `SessionStart` hook |
| **Codex CLI** | Plugin directory + `.codex-plugin/plugin.json` | `SessionStart` hook |
| **OpenCode** | JS module plugin | Module load |
| **Antigravity CLI** | Plugin directory + `plugin.json` | Manual `scripts/install.js` |
| **Pi Agent** | npm package + `pi.extensions` | Extension load |

No harness relies on npm `postinstall` hooks. See `openspec/changes/cross-harness-plugin-installer/specs/phase-7-distribution-model-fix.md` for the full design rationale.

## Structure

```text
nsolid-plugin/
├── packages/
│   ├── core/                 # Shared installation logic (@nodesource/plugin-core)
│   ├── claude-plugin/        # Claude Code plugin
│   ├── codex-plugin/         # Codex CLI plugin
│   ├── opencode-plugin/      # OpenCode plugin
│   ├── antigravity-plugin/   # Antigravity CLI plugin
│   └── pi-plugin/            # Pi Agent plugin
├── bundle.json               # Canonical skill + MCP server descriptor
└── pnpm-workspace.yaml
```

## Quick start

```bash
pnpm install
pnpm build
pnpm test
pnpm lint
```

## Per-harness install

### Claude Code

```bash
claude --plugin-dir ./packages/claude-plugin
```

The `SessionStart` hook runs auth + skill installation automatically.

### Codex CLI

Create `~/.agents/plugins/marketplace.json` pointing at `./packages/codex-plugin`, restart Codex, install, and trust the hook.

### OpenCode

Add to `~/.config/opencode/opencode.jsonc`:

```jsonc
{ "plugin": ["@nodesource/opencode-plugin"] }
```

Restart OpenCode. The plugin module runs setup automatically.

### Antigravity CLI

```bash
node packages/antigravity-plugin/scripts/install.js
```

Copies the plugin directory and runs auth + MCP config.

### Pi Agent

```bash
# 1. Install the NodeSource plugin (writes ~/.pi/agent/mcp.json and skills)
pi install npm:@nodesource/pi-plugin

# 2. Install an MCP adapter so Pi can use the configured servers
pi install npm:pi-mcp-adapter
# or
pi install npm:@0xkobold/pi-mcp
```

The `pi.extensions` entrypoint runs auth + skill installation on package load, including the MCP configuration at `~/.pi/agent/mcp.json`. Pi does not natively support MCP, so an adapter extension is required for the MCP-backed skills to have working tools.

## Development

### Build

```bash
pnpm build          # Build all packages
pnpm -r build       # Same thing
```

### Test

```bash
pnpm test           # All tests (282 tests)
pnpm test:unit      # Unit tests only
pnpm test:integration  # Integration tests only
```

### Lint

```bash
pnpm lint           # Lint all packages
```

### Bundle sync check

```bash
pnpm --filter @nodesource/plugin-core bundle:check   # Check if bundle.json is in sync
pnpm --filter @nodesource/plugin-core bundle:sync    # Copy root bundle.json into core
```

## License

MIT
