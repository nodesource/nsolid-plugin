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
  skillsSource: '/path/to/skills/dir',
  verbose: true,              // optional: detailed logging to stderr
})

// Uninstall
await uninstall('claude')

// Health check
const report = await doctor('claude', '/path/to/bundle.json')

// Restore the latest MCP config backup
const restored = await restore('claude')

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
| Pi | `~/.pi/agent/mcp.json` | `~/.pi/agent/skills/` | Yes |

## CLI

A thin CLI is provided as `nsolid-plugin`:

```bash
nsolid-plugin install --harness claude
nsolid-plugin install --harness claude --verbose
nsolid-plugin uninstall --harness claude
nsolid-plugin doctor --harness claude
nsolid-plugin doctor --harness claude --json
nsolid-plugin restore --harness claude
nsolid-plugin restore --harness claude --list
nsolid-plugin restore --harness claude --backup ~/.agents/.config-backup/claude/1234567890.json
```

Use `--verbose` (or `NSOLID_PLUGIN_VERBOSE=1`) for detailed, timestamped logs written to stderr. Verbose mode redacts tokens and auth headers.

## Config backups

Before mutating any harness MCP config, the installer copies the existing file to:

```text
~/.agents/.config-backup/<harness>/<timestamp>.<ext>
```

A `.meta.json` sidecar records the original path and harness. If something goes wrong, recover with `nsolid-plugin restore --harness <harness>`. No backup is created when the config file does not yet exist.

## Idempotency and recovery

Re-running `install` is safe and intended for repair:

- Existing valid credentials are reused.
- Skills are overwritten from the source bundle.
- MCP configs are merged, never replacing non-NodeSource servers.
- Tracking entries are de-duplicated by skill/MCP name and harness.

If a prior install failed partway through (for example, MCP config could not be written), fix the underlying issue and re-run `install`. The second run will complete the remaining steps.

## Troubleshooting

Run `nsolid-plugin doctor --harness <harness>` for a health check. Use `--json` for machine-readable output. See the [root README](../../README.md#troubleshooting) for common issues (permissions, port conflicts, stale symlinks, Pi MCP adapter).

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
