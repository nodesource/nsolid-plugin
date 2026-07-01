# nsolid-plugin

Cross-harness plugin distribution for NodeSource AI skills and MCP servers. The repo keeps one canonical skill source, a shared core CLI/setup package, a real Pi package, and generated native plugin artifacts for Claude, Codex, and Antigravity. OpenCode remains CLI-only until its plugin distribution model is clearer.

## Supported harnesses

| Harness | Plugin model | Trigger |
|---|---|---|
| **Claude Code** | Root GitHub marketplace/plugin + `.claude-plugin/plugin.json` | Native plugin install, then explicit setup |
| **Codex CLI** | Root GitHub marketplace/plugin + `.codex-plugin/plugin.json` | Native plugin install, then explicit setup |
| **OpenCode** | CLI-only (user-level skills + MCP config) | `nsolid-plugin setup --harness opencode` (auth + direct install) |
| **Antigravity CLI** | Root GitHub plugin + `plugin.json` | `agy plugin install <repo-url>`, then explicit setup |
| **Pi Agent** | npm package + `pi.skills` | `pi install npm:nsolid-pi-plugin`, `nsolid-plugin setup --harness pi`, then `pi install npm:pi-mcp-adapter` |

No harness relies on npm `postinstall` hooks. See `openspec/changes/cross-harness-plugin-installer/design.md` and `openspec/changes/cross-harness-plugin-installer/specs/installation-and-auth.md` for the full design rationale.

## Structure

```text
nsolid-plugin/
├── packages/
│   ├── core/                 # Shared CLI/setup/fallback logic + npm CLI package
│   └── pi-plugin/            # Pi Agent package
├── .claude-plugin/           # Claude marketplace + plugin manifest
├── .agents/plugins/          # Codex marketplace manifest
├── .codex-plugin/            # Codex plugin manifest
├── skills/                   # Canonical N|Solid skills and root plugin payload
├── skill-assets/             # Shared helper sources copied into skills/package artifacts
├── bundle.json               # Canonical skill + MCP server descriptor
├── plugin.json               # Antigravity root plugin manifest
└── pnpm-workspace.yaml
```

## Skill distribution model

Skills are canonical in the repository-root `skills/` directory. The repo root is also the GitHub-installable plugin payload for Claude, Codex, and Antigravity. Pi and the npm CLI package receive materialized skills during package `prepack`.

| Harness | Skill owner | Installer responsibility |
|---|---|---|
| **Claude** | Root plugin | Native marketplace/plugin install; `setup` for auth |
| **Codex** | Root plugin | Native marketplace/plugin install; `setup` for auth |
| **Antigravity** | Root plugin | `agy plugin install <repo-url>`; `setup` for auth |
| **Pi** | Pi npm package (`pi.skills`) | Pi package owns skills; `setup` writes auth/MCP config |
| **OpenCode** | CLI-only harness copy | `setup` authenticates and copies skills/MCP config locally; `install` is no-browser fallback |


## Quick start

```bash
pnpm install
pnpm build
pnpm test
pnpm lint
```

If `nsolid-plugin` is not installed on your `PATH` from a release package, use the source CLI after building:

```bash
node packages/core/dist/src/cli.js --help
```

Replace `nsolid-plugin` with `node packages/core/dist/src/cli.js` in the examples below when running directly from this checkout.

## Authentication

The plugin uses OAuth to authenticate with NodeSource's accounts service. Authentication is explicit: plugin install paths do not open a browser. Run:

```bash
nsolid-plugin setup --harness <harness>
```

On setup:

1. Your browser opens `accounts.nodesource.com/sign-in` for login.
2. A local HTTP server starts on port **8765** (fallback: 8766–8770) to receive the callback.
3. The OAuth callback provides a `serviceToken`, `consoleId`, `saasToken`, and `consoleUrl`.
4. An `mcpUrl` is derived from the callback's `consoleId` (or via string transform from `consoleUrl`).
5. Credentials are stored at `~/.agents/.nodesource-auth.json` with mode `0600`.

**What is stored:** `serviceToken`, `organizationId`, `saasToken`, `consoleUrl`, `mcpUrl`, `expiresAt`, `permissions`, and the `accountsUrl` auth origin used to mint/validate the token (useful for staging QA).

**Token lifecycle:** Expired credentials trigger re-authentication during explicit setup/login. Runtime MCP wrappers fail with an actionable `Run: nsolid-plugin setup --harness <harness>` message if credentials are missing or expired. Credentials are shared across harnesses.

**`mcpUrl` derivation:** Two paths exist:
1. **Primary (at OAuth time):** Built from the callback's `consoleId` as `https://<consoleId>.mcp.saas.nodesource.io` and stored on the credentials.
2. **Fallback (at install time):** If `credentials.mcpUrl` is absent, the installer derives it via `consoleUrl.replaceAll('.saas.', '.mcp.saas.')`. If that transform doesn't change the URL, installation fails with an actionable error.

## Per-harness install

The GitHub marketplace flow installs from the repository root.

The setup step requires the `nsolid-plugin` CLI on your PATH:

```bash
npm i -g nsolid-plugin          # stable release
# during pre-release:
npm i -g nsolid-plugin@next
```

Or invoke it once-off with `npx -y nsolid-plugin setup --harness <harness>` (`npx -y nsolid-plugin@next ...` during pre-release).

### Claude Code

```bash
claude plugin marketplace add NodeSource/nsolid-plugin
claude plugin install nsolid-plugin@nodesource
nsolid-plugin setup --harness claude
```

Claude installs plugins through marketplaces. The repository root includes `.claude-plugin/marketplace.json`, so GitHub install works directly. If marketplace/local plugin install is unavailable, `nsolid-plugin install --harness claude` is the fallback direct installer and does not open a browser.

> `nsolid-plugin` must be available on your PATH. Once published, install it globally (`npm i -g nsolid-plugin`) or invoke it via npx (`npx -y nsolid-plugin setup --harness claude`). During the pre-release window, use the prerelease tag (`npx -y nsolid-plugin@next ...` or `npm i -g nsolid-plugin@next`).

### Codex CLI

```bash
codex plugin marketplace add NodeSource/nsolid-plugin
codex plugin add nsolid-plugin@nodesource
nsolid-plugin setup --harness codex
```

Codex is marketplace-owned. A NodeSource-owned Git/local marketplace can be used as fallback if OpenAI curation is unavailable. Authentication remains explicit through `nsolid-plugin setup --harness codex` (or `npx -y nsolid-plugin setup --harness codex`).

### OpenCode

```bash
nsolid-plugin setup --harness opencode
```

OpenCode is CLI-only. `setup` authenticates with NodeSource, copies skills directly to `~/.config/opencode/skills/`, and writes MCP servers to `~/.config/opencode/opencode.jsonc` under the top-level `mcp` key. It does not use shared `~/.agents/skills/`, avoiding cross-harness skill leakage and Pi package-owned skill collisions.

Use `nsolid-plugin install --harness opencode` only as a no-browser fallback/repair command; MCP config is written only when valid credentials already exist.

### Antigravity CLI

```bash
agy plugin install https://github.com/NodeSource/nsolid-plugin.git
nsolid-plugin setup --harness antigravity
```

Antigravity installs the repository root as a native plugin and stages skills/MCP wrappers under `~/.gemini/config/plugins/nsolid-plugin/`. Install does not start auth.

### Pi Agent

```bash
# 1. Install the Pi package (skills are package-owned)
pi install npm:nsolid-pi-plugin

# 2. Authenticate and write Pi MCP config
nsolid-plugin setup --harness pi

# 3. Install pi-mcp-adapter so Pi can use the configured servers
#    (it reads ~/.pi/agent/mcp.json directly, so no extra config is needed)
pi install npm:pi-mcp-adapter
```

For local development before using a published Pi package:

```bash
pnpm plugin:materialize
pi install ./packages/pi-plugin --no-approve
nsolid-plugin setup --harness pi
pi install npm:pi-mcp-adapter
/reload
pnpm plugin:clean
```

The package declares its skills via `pi.skills`, so Pi owns/lists them from the package. Package activation is side-effect free: it does not authenticate, copy user-level skills, or write MCP config. `nsolid-plugin setup --harness pi` is the explicit step that writes `~/.pi/agent/mcp.json`. Pi does not natively support MCP, so an adapter extension is required for the MCP-backed skills to have working tools.

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

### Bundle and plugin asset sync checks

```bash
pnpm --filter nsolid-plugin bundle:check   # Check if core bundle.json is in sync
pnpm --filter nsolid-plugin bundle:sync    # Copy root bundle.json into core
pnpm plugin:check                                    # Check generated manifests/configs and verify no package skill copies are committed
pnpm plugin:sync                                     # Regenerate manifests/configs and remove materialized package skill copies
pnpm plugin:materialize                              # Copy root skills into the Pi package for pack/release
pnpm plugin:root                                     # Refresh root marketplace/plugin manifests from bundle.json
pnpm plugin:root:check                               # Fail if committed root manifests drift from bundle.json
```

Run `pnpm plugin:check` in CI and before release. The source tree keeps one canonical skill copy under root `skills/`; package-local `skills/` directories are materialized only for npm package release and cleaned afterward by package sync scripts.

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

Re-run the setup command. No cleanup is needed — the local callback server cleans up automatically.

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

### Install vs setup

`nsolid-plugin install --harness <harness>` is a no-browser fallback/direct installer. Claude, Codex, and Antigravity should normally use native GitHub plugin install from the repository root. OpenCode uses `nsolid-plugin setup --harness opencode` as its primary onboarding command because it authenticates and then performs the direct install; `install --harness opencode` is for repair/offline staging. Pi is package-owned: `pi install npm:nsolid-pi-plugin` installs skills, while `nsolid-plugin install/setup --harness pi` only writes Pi MCP config.

### Verbose logging

For detailed, timestamped logs written to stderr:

```bash
nsolid-plugin install --harness <harness> --verbose
NSOLID_PLUGIN_VERBOSE=1 nsolid-plugin doctor --harness <harness>
```

Tokens and auth headers are redacted automatically.

### Manual uninstall / cleanup

```bash
nsolid-plugin uninstall --harness <harness>
```

```powershell
nsolid-plugin uninstall --harness <harness>
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
