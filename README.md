# nsolid-plugin

N|Solid Plugin installs NodeSource AI skills and MCP servers into Claude Code, Codex CLI, OpenCode, Antigravity CLI, and Pi Agent. The repo keeps one canonical skill source, a shared core CLI/setup package, a real Pi package, and generated native plugin artifacts for Claude, Codex, and Antigravity. OpenCode remains CLI-only until its plugin distribution model is clearer.

## Supported harnesses

| Harness | Plugin model | Trigger |
|---|---|---|
| **Claude Code** | Root GitHub marketplace/plugin + `.claude-plugin/plugin.json` | Native plugin install, then explicit setup |
| **Codex CLI** | Root GitHub marketplace/plugin + `.codex-plugin/plugin.json` | Native plugin install, then explicit setup |
| **OpenCode** | CLI direct install (user-level skills + MCP config) | `nsolid-plugin setup --harness opencode` (auth + writes config); `nsolid-plugin install --harness opencode` refreshes it |
| **Antigravity CLI** | Root GitHub plugin + `plugin.json` | `agy plugin install <repo-url>`, then explicit setup |
| **Pi Agent** | npm package + `pi.skills` | `pi install npm:nsolid-pi-plugin`, `nsolid-plugin setup --harness pi`, then `pi install npm:pi-mcp-adapter` |

No harness relies on npm `postinstall` hooks. See `openspec/changes/cross-harness-plugin-installer/design.md` and `openspec/changes/cross-harness-plugin-installer/specs/installation-and-auth.md` for the full design rationale.

## What it includes

- 17 Node.js operations skills for memory leaks/spikes, CPU spikes, event loop delays, traces, saved N|Solid assets, vulnerability analysis, dependency audits, package and Node.js upgrades, benchmarks, SBOM generation, optimization validation, and switching NodeSource organizations.
- Three MCP servers: `nsolid-console`, `ns-benchmark`, and `ncm`.
- Explicit OAuth setup against NodeSource accounts. You need a NodeSource account with access to the target N|Solid organization.

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
| **Claude** | Root plugin | Native marketplace/plugin install; `setup` for auth + bridge |
| **Codex** | Root plugin | Native marketplace/plugin install; `setup` for auth + bridge |
| **Antigravity** | Root plugin | `agy plugin install <repo-url>`; `setup` for auth + bridge |
| **Pi** | Pi npm package (`pi.skills`) | Pi package owns skills; `setup` writes auth/MCP config |
| **OpenCode** | CLI direct install | `setup` authenticates, prepares the bridge, and writes MCP config/skills; `install` refreshes the direct config as a fallback |


## Authentication

The plugin uses OAuth to authenticate with NodeSource's accounts service. Authentication is explicit: plugin install paths do not open a browser. Run:

```bash
nsolid-plugin setup --harness <harness>
```

On setup:

1. Your browser opens `accounts.nodesource.com/sign-in` for login (only if credentials are missing or expired).
2. A local HTTP server starts on port **8765** (fallback: 8766–8770) to receive the callback.
3. The OAuth callback provides a `serviceToken`, `consoleId`, `saasToken`, and `consoleUrl`.
4. An `mcpUrl` is derived by combining the callback's `consoleId` (the org UUID) with the trusted environment suffix of `consoleUrl` (e.g. `saas.nodesource.io`, `staging.saas.nodesource.io`), giving `https://<organizationId>.mcp.<suffix>/`.
5. Credentials are stored at `~/.agents/.nodesource-auth.json` with mode `0600`.
6. The shared **MCP bridge runtime** (`mcp-remote`, exact pinned version) is provisioned at `~/.agents/nsolid-plugin/runtime/mcp-remote/<version>/` so MCP servers start without touching npm. The first `setup` needs network access for this one-time npm install; subsequent runs detect the valid runtime and skip npm entirely.

If a browser does not open automatically (headless CI, devcontainer, agent host, etc.), the CLI prints the sign-in URL to stderr — open it manually in any browser to complete the flow. Nothing sensitive (no tokens) is printed there.

**What is stored:** `serviceToken`, `organizationId`, `saasToken`, `consoleUrl`, `mcpUrl`, `expiresAt`, `permissions`, and the `accountsUrl` auth origin used to mint/validate the token.

**Token lifecycle:** Expired credentials trigger re-authentication during explicit setup/login. Runtime MCP wrappers fail with an actionable, version-pinned `Run: npx -y nsolid-plugin@<plugin-version> setup --harness <harness>` message if credentials are missing/expired **or the MCP bridge runtime is missing/corrupt**. Credentials are shared across harnesses — which also means there is only ever one authenticated NodeSource org at a time. If you belong to more than one org, use `nsolid-plugin switch-org --harness <harness>` to force a fresh sign-in and pick a different one; see [Switching organizations](#switching-organizations) below.

**`mcpUrl` derivation:** Always built from the org's UUID (`consoleId`/`organizationId`), never from `consoleUrl`'s hostname label — a console may be reachable at a friendly display alias (e.g. `homedepot-nucleus-stage-1.saas.nodesource.io`), but the underlying MCP ingress route is only ever provisioned under the org's UUID, so using the alias verbatim produces a dead endpoint. `consoleUrl` is only consulted for its environment suffix (`saas.nodesource.io`, `staging.saas.nodesource.io`, etc.), which must be the exact suffix or a dot-delimited deeper suffix — a hostname where `saas` is merely a substring of a larger label (e.g. `foo-saas.nodesource.io`) is rejected. This gives `https://<organizationId>.mcp.<suffix>/`, always over `https`. Computed and stored on every fresh OAuth completion (`setup`, `switch-org`); a stored/explicit `credentials.mcpUrl` — including a legitimate custom operator override — still always takes priority over re-deriving. If `consoleUrl` doesn't match a recognized NodeSource pattern, fresh OAuth fails with an actionable error and never silently persists a guessed production URL, and any previously stored credentials are left unchanged.

## Per-harness install

Requirements: Node.js `>=22.3.0`, the target harness CLI, and a NodeSource account with access to your N|Solid organization.

Install the stable CLI once:

```bash
npm i -g nsolid-plugin
```

Or invoke commands without a global install:

```bash
npx -y nsolid-plugin setup --harness <harness>
npx -y nsolid-plugin install --harness <harness>
```

The setup step requires a NodeSource account and writes shared credentials to `~/.agents/.nodesource-auth.json`; it also prepares the shared MCP bridge runtime used by the Claude/Codex/Antigravity wrappers (first run downloads it via npm, later runs are offline and idempotent). For OpenCode and Pi, `setup` alone completes onboarding — auth, bridge runtime, skills, and MCP config in one step. The install step is needed only for fallback/repair installs and satisfies the same runtime precondition before copying assets.

### Direct CLI install

`nsolid-plugin install --harness <harness>` is not a native harness plugin install. It directly adds N|Solid skills and MCP server config to the selected harness, and satisfies the MCP bridge runtime precondition first (same as `setup`). Run `setup` first so MCP server credentials are available:

```bash
nsolid-plugin setup --harness <harness>
nsolid-plugin install --harness <harness>
```

### Check and update

The updater plans changes before executing them and never starts OAuth. Version reporting is read-only:

```bash
nsolid-plugin version
nsolid-plugin --version
nsolid-plugin update --check
nsolid-plugin update --all --check --json
```

The default `update` scope is the globally installed CLI. Use `--harness claude|codex|opencode|antigravity|pi` for one harness or `--all` for the CLI plus every detected installation. Mutating updates require an interactive confirmation or `--yes`; non-interactive automation should use `--yes --json`.

Ownership remains with each tool. Claude uses its detected plugin ID and scope, Codex refreshes the detected marketplace and transactionally removes/adds that same ID, and Antigravity backs up its staged root and matching import manifest before reinstalling the fixed GitHub source. Pi runs its native unpinned package update once for the detected user/project scopes. OpenCode and tracked fallback installs use the exact published package's internal refresh entrypoint; they do not invoke `opencode plugin`.

The updater preserves credentials, user-owned configuration, unrelated MCP entries, and native marketplace identities. It refuses ambiguous or unsupported sources, never silently downgrades a CLI newer than the registry, and rolls back owned fallback/Antigravity/Codex state when validation fails. The public `nsolid-plugin install` command and programmatic `install()` behavior remain unchanged.

Without a global install, use `npx -y nsolid-plugin setup --harness <harness>` and `npx -y nsolid-plugin install --harness <harness>`.

Use direct CLI install as the primary install path for OpenCode. For Claude Code, Codex CLI, and Antigravity CLI, prefer the native plugin commands below and keep `nsolid-plugin install` for fallback or repair. For Pi Agent, skills come from `nsolid-pi-plugin`; the CLI writes Pi MCP config only.

### Claude Code

```bash
claude plugin marketplace add NodeSource/nsolid-plugin
claude plugin install nsolid-plugin@nodesource
nsolid-plugin setup --harness claude
```

Claude installs plugins through marketplaces. The repository root includes `.claude-plugin/marketplace.json`, so GitHub install works directly. If marketplace/local plugin install is unavailable, `nsolid-plugin install --harness claude` is the fallback direct installer and does not open a browser.

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
nsolid-plugin install --harness opencode
```

OpenCode does not use this repository as a native plugin. `nsolid-plugin setup --harness opencode` authenticates AND writes the direct config in one step: it copies skills to `~/.config/opencode/skills/` and writes MCP servers to `~/.config/opencode/opencode.jsonc` under the top-level `mcp` key. It does not use shared `~/.agents/skills/`, avoiding cross-harness skill leakage and Pi package-owned skill collisions. `nsolid-plugin install --harness opencode` re-runs that same direct config — including after a `switch-org`, where the harness you pass to `--harness` is refreshed on the spot.

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

## Verify install

```bash
nsolid-plugin doctor --harness <harness>
```

In Claude Code, Codex CLI, OpenCode, and Antigravity CLI, check the harness UI for N|Solid entries with `/skills` and `/mcp`. In Pi Agent, run `pi list` and confirm `nsolid-pi-plugin` and `pi-mcp-adapter` are installed.

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
pnpm release:prepare -- patch                         # Prepare the next release version atomically
pnpm release:check                                    # Check synchronized versions and generated payload
pnpm release:check --release                          # Also require payload changes to bump the release version
```

Run `pnpm plugin:check` in CI and before release. The source tree keeps one canonical skill copy under root `skills/`; package-local `skills/` directories are materialized only for npm package release and cleaned afterward by package sync scripts.

### Release order

`release:prepare` only updates and validates local files; it never publishes or creates Git state. After review, run `pnpm release:check --release`, publish `nsolid-plugin@<version>` first, publish the same-version `nsolid-pi-plugin` second, then commit and push the generated root manifests and the matching semantic Git tag. Run `pnpm plugin:clean` after any interrupted package materialization. The first release that introduces this updater must be bootstrapped manually because an older CLI cannot update itself before the new package and native marketplace payload are published.

## Troubleshooting

### Run the doctor command

```bash
nsolid-plugin doctor --harness <harness>
nsolid-plugin doctor --harness <harness> --json    # machine-readable
```

The output shows green/yellow/red status for credentials, skills, MCP servers, and the MCP bridge runtime. For harnesses whose MCP servers run through the plugin wrapper (native plugin installed for Claude/Codex/Antigravity), a missing or corrupt bridge makes the report unhealthy; for OpenCode/Pi the bridge line is informational.

### MCP bridge runtime missing or corrupt

Wrapper message:

```text
[nsolid-plugin] MCP bridge runtime is not ready. Run: npx -y nsolid-plugin@<plugin-version> setup --harness <harness>
```

Fix: run the suggested `setup` command once. The repair command is pinned to the plugin version that generated the wrapper, so rerunning it repairs exactly the wrapper that printed it. This is different from an expired token (`credentials are expired`): the bridge runtime lives at `~/.agents/nsolid-plugin/runtime/mcp-remote/<version>/` and survives `uninstall`/`logout`. If `setup` itself reports `MCP runtime setup failed`, npm could not install the runtime (network/registry) — stored credentials remain valid, fix network access and rerun the same command. npm is resolved from the Node.js installation that serves the harness (never from PATH, `npm_execpath`, or the project). MCP wrappers never download dependencies during harness startup; there is intentionally no `npx` fallback.

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

`nsolid-plugin setup --harness <harness>` authenticates with NodeSource and may open a browser; for direct-config harnesses (OpenCode, Pi) it also writes that harness's MCP config in the same step. `nsolid-plugin install --harness <harness>` never opens a browser; it directly writes N|Solid skills and MCP config for a harness and is used to (re)run a direct config — for example after `switch-org`. Claude, Codex, and Antigravity should normally use native GitHub plugin install from the repository root. OpenCode uses the single-step `setup`, and `install` to refresh its config. Pi is package-owned: `pi install npm:nsolid-pi-plugin` installs skills, while `nsolid-plugin install/setup --harness pi` writes Pi MCP config.

### Switching organizations

```bash
nsolid-plugin switch-org --harness <harness>
```

Credentials are one shared file (`~/.agents/.nodesource-auth.json`), not per-harness, so only one NodeSource org is authenticated at a time. `switch-org` forces a fresh OAuth round-trip even when current credentials are still valid, so NodeSource's sign-in flow can show its org picker again (it only appears when your account belongs to more than one org). The new org applies globally — to every installed harness, not just the one passed to `--harness`. The harness you run it for is refreshed immediately: its direct MCP config (OpenCode/Pi) or its reconnect-ready native plugin picks up the new org. Other direct-config harnesses (OpenCode, Pi, and fallback-installed Claude/Codex/Antigravity) pick up the new org on their own next `setup`/`install` run; native-plugin harnesses get it on their next MCP reconnect. If the org switch itself succeeds but the selected harness's config refresh fails, the CLI reports a partial success (org already changed, credentials kept) with a nonzero exit and the retry command, rather than claiming the switch failed. The command's own output tells you which follow-up applies to the harness you ran it for. An `ns-switch-org` skill is also installed alongside the others, so this can be triggered from inside a harness instead of a separate terminal.

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

Credentials are preserved.

### Pi MCP not working

Pi does not natively support MCP. Install an adapter:

```bash
pi install npm:pi-mcp-adapter
```

`pi-mcp-adapter` auto-reads `~/.pi/agent/mcp.json`. The alternative `@0xkobold/pi-mcp` reads a separate `~/.0xkobold/mcp.json` in a different format — it does not pick up the NodeSource config automatically.

## License

MIT
