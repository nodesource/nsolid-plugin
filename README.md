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

## Authentication

The plugin uses OAuth to authenticate with NodeSource's accounts service. On first install:

1. Your browser opens `accounts.nodesource.com/sign-in` for login.
2. A local HTTP server starts on port **8765** (fallback: 8766–8770) to receive the callback.
3. The OAuth callback provides a `serviceToken`, `consoleId`, `saasToken`, and `consoleUrl`.
4. An `mcpUrl` is derived from the callback's `consoleId` (or via string transform from `consoleUrl`).
5. Credentials are stored at `~/.agents/.nodesource-auth.json` with mode `0600`.

**What is stored:** `serviceToken`, `organizationId`, `saasToken`, `consoleUrl`, `mcpUrl`, `expiresAt`, `permissions`.

**Token lifecycle:** Expired credentials trigger re-authentication automatically. Credentials are shared across all harness installs — authenticating once covers every harness.

**`mcpUrl` derivation:** Two paths exist:
1. **Primary (at OAuth time):** Built from the callback's `consoleId` as `https://<consoleId>.mcp.saas.nodesource.io` and stored on the credentials.
2. **Fallback (at install time):** If `credentials.mcpUrl` is absent, the installer derives it via `consoleUrl.replaceAll('.saas.', '.mcp.saas.')`. If that transform doesn't change the URL, installation fails with an actionable error.

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

# 2. Install pi-mcp-adapter so Pi can use the configured servers
#    (it reads ~/.pi/agent/mcp.json directly, so no extra config is needed)
pi install npm:pi-mcp-adapter
```

The `pi.extensions` entrypoint runs auth + skill installation on package load, including the MCP configuration at `~/.pi/agent/mcp.json`. Pi does not natively support MCP, so an adapter extension is required for the MCP-backed skills to have working tools.

> **Using `@0xkobold/pi-mcp` instead?** It is an alternative adapter, but it reads `~/.0xkobold/mcp.json` in a different (`servers[]`) format and does **not** pick up the config this plugin writes (`~/.pi/agent/mcp.json`). You would need to create and maintain a separate `~/.0xkobold/mcp.json` manually. Prefer `pi-mcp-adapter` for automatic setup.

## Development

### Build

```bash
pnpm build          # Build all packages
pnpm -r build       # Same thing
```

### Test

```bash
pnpm test           # All tests (unit + integration)
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

## Troubleshooting

### Run the doctor command

```bash
nsolid-plugin doctor --harness <harness>
nsolid-plugin doctor --harness <harness> --json    # machine-readable
```

The output shows green/yellow/red status for credentials, skills, and MCP servers.

### Permission denied writing config

- **macOS/Linux:** `sudo chown -R $USER ~/.claude.json` (replace with the relevant harness config path).
- **Windows:** Run as Administrator, or `icacls C:\Users\<you>\.claude.json /grant %USERNAME%:F`.

### Port conflict during auth (8765)

Close the application using the port, or let the fallback (8766–8770) try automatically. If all fail, free a port in the 8765–8770 range.

### OAuth timed out / cancelled

Re-run the install command. No cleanup is needed — the local callback server cleans up automatically.

### Stale or broken symlinks

Re-run install. It is idempotent and replaces broken symlinks with correct ones.

### Config backup and restore

Every harness MCP config is backed up automatically before the installer changes it:

```text
~/.agents/.config-backup/<harness>/<timestamp>.<ext>
```

Restore the latest backup:

```bash
nsolid-plugin restore --harness <harness>
```

List available backups:

```bash
nsolid-plugin restore --harness <harness> --list
```

Restore a specific backup:

```bash
nsolid-plugin restore --harness <harness> --backup ~/.agents/.config-backup/<harness>/<file>
```

### Verbose logging

For detailed, timestamped logs written to stderr:

```bash
nsolid-plugin install --harness <harness> --verbose
NSOLID_PLUGIN_VERBOSE=1 nsolid-plugin doctor --harness <harness>
```

Tokens and auth headers are redacted automatically.

### Manual uninstall / cleanup

```bash
NSOLID_HARNESS=<harness> node packages/core/scripts/setup.mjs uninstall
```

```powershell
$env:NSOLID_HARNESS="<harness>"; node packages/core/scripts/setup.mjs uninstall
```

Credentials are preserved.

### Pi MCP not working

Pi does not natively support MCP. Install an adapter:

```bash
pi install npm:pi-mcp-adapter
```

`pi-mcp-adapter` auto-reads `~/.pi/agent/mcp.json`. The alternative `@0xkobold/pi-mcp` reads a separate `~/.0xkobold/mcp.json` in a different format — it does not pick up the NodeSource config automatically.

## License

MIT
