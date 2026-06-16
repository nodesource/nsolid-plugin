# @nodesource/plugin-core

Shared installation logic for the N|Solid cross-harness plugin installer.

## What it does

`@nodesource/plugin-core` provides the core `install()`, `uninstall()`, and `doctor()` functions used by every per-harness plugin package (Claude, Codex, OpenCode, Antigravity, Pi). When called, it:

1. Loads and validates `bundle.json` (the canonical skill + MCP server descriptor).
2. Runs OAuth authentication if credentials are missing or expired.
3. Copies 15 skills to `~/.agents/skills/` (canonical path).
4. Creates harness-specific symlinks (Unix) or junctions/copies (Windows).
5. Writes MCP server configurations into the harness config file (merge, never overwrite).
6. Records all installed artifacts in `~/.agents/.nodesource-installed.json`.

## Public API

```ts
import { install, uninstall, doctor, getAdapter } from '@nodesource/plugin-core'

// Install for a specific harness
const result = await install({
  harness: 'claude',          // 'claude' | 'codex' | 'opencode' | 'antigravity' | 'pi'
  bundlePath: '/path/to/bundle.json',
  skillsSource: '/path/to/skills/dir'
})

// Uninstall
await uninstall('claude')

// Health check
const report = await doctor('claude', '/path/to/bundle.json')

// Get adapter
const adapter = getAdapter('claude')
```

## Harness adapters

Each harness has an adapter that provides its config and skills paths:

| Harness | MCP config path | Skills path | MCP support |
|---|---|---|---|
| Claude | `~/.claude.json` | `~/.claude/skills/` | Yes |
| Codex | `~/.codex/config.toml` | `~/.codex/skills/` | Yes |
| OpenCode | `~/.config/opencode/opencode.jsonc` | `~/.config/opencode/skills/` | Yes |
| Antigravity | `~/.gemini/config/mcp_config.json` | `~/.gemini/config/skills/` | Yes |
| Pi | `null` | `~/.pi/agent/skills/` | No |

## CLI

A thin CLI is provided as `nsolid-plugin`:

```bash
nsolid-plugin install --harness claude
nsolid-plugin uninstall --harness claude
nsolid-plugin doctor --harness claude
```

## Development

```bash
# Build
pnpm build

# Test
pnpm test

# Lint
pnpm lint

# Sync check (bundle.json in sync with workspace root)
pnpm bundle:check
```
