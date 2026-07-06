# nsolid-plugin (core)

Shared CLI/setup/fallback installation logic for the N|Solid cross-harness plugin distribution.

## What it does

`nsolid-plugin` provides `setup()`, fallback `install()`, `uninstall()`, and `doctor()` functions. Claude, Codex, and Antigravity install from the GitHub plugin root; Pi remains a real package; OpenCode is CLI-only.

Install/setup semantics are intentionally split:

1. `setup()` authenticates with NodeSource and may open a browser.
2. `install()` is a fallback direct asset installer and never starts auth/browser login.
3. Runtime MCP wrappers fail with `Run: nsolid-plugin setup --harness <harness>` if credentials are missing or expired.
4. OpenCode uses the direct CLI path: run `setup --harness opencode` for auth, then `install --harness opencode` to copy skills and write MCP config.
5. Pi package owns skills, while setup writes Pi MCP config for adapter/runtime compatibility.

## Public API

```ts
import { install, uninstall, doctor, getAdapter } from 'nsolid-plugin'

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
| Claude | Plugin-owned `.mcp.json` | Plugin-owned `skills/` | Yes |
| Codex | Plugin-owned `.mcp.json` | Plugin-owned `skills/` | Yes |
| OpenCode | `~/.config/opencode/opencode.jsonc` | `~/.config/opencode/skills/` | Yes |
| Antigravity | Plugin-owned `~/.gemini/config/plugins/nsolid-plugin/mcp_config.json` | Plugin-owned `~/.gemini/config/plugins/nsolid-plugin/skills/` | Yes |
| Pi | `~/.pi/agent/mcp.json` | Package-owned `nsolid-pi-plugin/skills/` | Yes |

## CLI

A thin CLI is provided as `nsolid-plugin`:

```bash
nsolid-plugin setup --harness claude        # explicit auth/setup; may open browser
nsolid-plugin setup --harness opencode      # explicit auth/setup
nsolid-plugin setup --harness pi            # explicit auth/setup + Pi MCP config
nsolid-plugin install --harness claude      # fallback direct install; no browser
nsolid-plugin install --harness antigravity # fallback direct install; no browser
nsolid-plugin install --harness codex       # fallback direct install; no browser
nsolid-plugin install --harness pi          # MCP config only; skills come from pi package
nsolid-plugin install --harness opencode    # OpenCode: copy skills + write MCP config
nsolid-plugin uninstall --harness claude
nsolid-plugin doctor --harness claude
nsolid-plugin doctor --harness claude --json
nsolid-plugin restore --harness claude
nsolid-plugin restore --harness claude --list
nsolid-plugin restore --harness claude --backup ~/.agents/.config-backup/claude/1234567890.json
```

Use `--verbose` (or `NSOLID_PLUGIN_VERBOSE=1`) for detailed, timestamped logs written to stderr. Verbose mode redacts tokens and auth headers. For Claude Code, Codex, and Antigravity, prefer native GitHub plugin install from the repository root; `install --harness` is a fallback direct installer only. For Pi, install `nsolid-pi-plugin` for package-owned skills; CLI install/setup only writes MCP config. OpenCode is CLI-only and uses `setup --harness opencode` for auth followed by `install --harness opencode` to copy user-level skills and write MCP config.

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

# Sync checks
pnpm plugin:check           # source hygiene; no committed package skill copies
pnpm plugin:sync            # clean materialized Pi package skills
pnpm plugin:materialize     # copy root skills into Pi package for pack
pnpm plugin:root          # refresh root GitHub marketplace/plugin manifests
pnpm plugin:root:check    # fail if root manifests drift from bundle.json
```
