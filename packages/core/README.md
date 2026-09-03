# nsolid-plugin (core)

Shared CLI/setup/fallback installation logic for the N|Solid cross-harness plugin distribution.

## What it does

`nsolid-plugin` provides `setup()`, fallback `install()`, `uninstall()`, and `doctor()` functions. Claude, Codex, and Antigravity install from the GitHub plugin root; Pi remains a real package; OpenCode is CLI-only.

Install/setup semantics are intentionally split:

1. `setup()` authenticates with NodeSource (may open a browser) **and**
   provisions the shared MCP bridge runtime (see below). The first run needs
   network access for npm; later runs are idempotent and offline with respect
   to the npm registry while the runtime stays valid.
2. `install()` is a fallback direct asset installer and never starts
   auth/browser login, never downloads dependencies, and never provisions the
   bridge runtime.
3. Runtime MCP wrappers fail fast with a version-pinned `Run: npx -y
   nsolid-plugin@<plugin-version> setup --harness <harness>` if credentials
   are missing/expired or the bridge runtime is missing/corrupt.
4. OpenCode uses the direct CLI path: `setup --harness opencode` completes
   auth + bridge + skills + MCP config in one step; `install --harness
   opencode` is the fallback asset installer and satisfies the runtime
   precondition first.
5. Pi package owns skills, while setup writes Pi MCP config for
   adapter/runtime compatibility.

## MCP bridge runtime (mcp-remote)

`setup()` for **any** harness provisions a shared, versioned, local
`mcp-remote` runtime used by the STDIO→HTTP wrapper (Claude, Codex,
Antigravity):

```text
~/.agents/nsolid-plugin/runtime/mcp-remote/<version>/
  package.json                     # private manifest anchoring the install
  node_modules/mcp-remote/         # exact pinned version
    dist/proxy.js
  node_modules/<transitives>/...
```

Lifecycle and guarantees:

- **Exact pin**: the version matches `MCP_REMOTE_VERSION` in
  `src/mcp/mcp-remote-runtime.ts` and the wrapper generator; a sync test
  guards it. Pinning the top-level package does not freeze transitives
  declared with ranges — a lockfile/shrinkwrap would be required for
  byte-exact reproducibility (known limitation).
- **Atomic**: npm installs into a staging sibling and the result is validated
  (name, exact version, `dist/proxy.js`, transitive dependency closure) and
  published with a single rename. Partial runtimes are never published, and
  concurrent setups converge on one valid runtime.
- **Idempotent**: with a valid runtime present, `setup` never invokes npm.
- **Safe**: npm runs with `shell: false`, separated argv,
  `--ignore-scripts`, and no audit/fund. It is resolved only from canonical
  candidates next to the running Node.js installation — never from `PATH`,
  `npm_execpath`, the current directory, or project `node_modules/.bin`. No
  credentials are read, stored, or logged by the runtime module; the runtime
  directory contains no secrets.
- **Shared and durable**: `uninstall --harness <harness>` and `logout` never
  delete it (other harnesses — including other pinned versions — may still
  need it). Old versions are never pruned automatically.
- **Fail-fast consumers**: the generated wrapper resolves only this runtime
  (or a version-matched dev checkout copy) and never falls back to
  `npx`/npm/cmd.exe during harness startup. A missing/corrupt runtime exits
  immediately with the harness-correct, version-pinned repair command (the
  wrapper reports the plugin version that generated it). During runtime
  provisioning, npm is resolved only from the Node.js installation that
  serves the harness — never from PATH, `npm_execpath`, or the project.

`doctor()` reports the bridge as `report.bridge` (optional JSON field):
`status` (`ready|missing|invalid`), `version`, `root`, `proxyPath`, `reason`,
and `required`. `required` is true only when that harness's MCP servers are
actually served through the wrapper (native plugin installed for
claude/codex/antigravity); for OpenCode/Pi and direct (native-HTTP) installs
the entry is informational and does not affect `healthy`. A ready bridge is
never treated as proof that the remote MCP endpoint is reachable.

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
nsolid-plugin setup --harness claude        # explicit auth + bridge runtime; may open browser
nsolid-plugin setup --harness opencode      # explicit auth + bridge + direct install
nsolid-plugin setup --harness pi            # explicit auth + bridge + Pi MCP config
nsolid-plugin install --harness claude      # fallback direct install; runtime precondition first; no browser
nsolid-plugin install --harness antigravity # fallback direct install; runtime precondition first; no browser
nsolid-plugin install --harness codex       # fallback direct install; runtime precondition first; no browser
nsolid-plugin install --harness pi          # MCP config only; runtime precondition first; skills from pi package
nsolid-plugin install --harness opencode    # OpenCode: runtime precondition first, then skills + MCP config
nsolid-plugin uninstall --harness claude
nsolid-plugin switch-org --harness claude   # force re-auth to pick a different NodeSource org
nsolid-plugin doctor --harness claude
nsolid-plugin doctor --harness claude --json
nsolid-plugin restore --harness claude
nsolid-plugin restore --harness claude --list
nsolid-plugin restore --harness claude --backup ~/.agents/.config-backup/claude/1234567890.json
```

Update and version commands are additive to the installer API:

```bash
nsolid-plugin version
nsolid-plugin update --check
nsolid-plugin update --harness opencode --yes
nsolid-plugin update --all --check --json
```

`getVersionInfo()` is synchronous and read-only. `checkUpdates()` performs discovery only; `update()` plans first, asks for confirmation unless `yes: true`, and executes each owned target sequentially. Native harnesses keep their own ownership and source identity. Direct fallback updates use the package-internal refresh binary and path-level tracking; the public `install()` function keeps its existing idempotent behavior.

Use `--verbose` (or `NSOLID_PLUGIN_VERBOSE=1`) for detailed, timestamped logs written to stderr. Verbose mode redacts tokens and auth headers. For Claude Code, Codex, and Antigravity, prefer native GitHub plugin install from the repository root; `install --harness` is a fallback direct installer only. For Pi, install `nsolid-pi-plugin` for package-owned skills; CLI install/setup only writes MCP config. OpenCode is CLI-only and uses `setup --harness opencode` for auth + bridge + skills + MCP config in one step; `install --harness opencode` is the fallback asset path.

Credentials are a single shared file (`~/.agents/.nodesource-auth.json`), not per-harness, so a member of more than one NodeSource org can only be authenticated against one org at a time. `switch-org` forces a fresh OAuth round-trip — even if current credentials are still valid — so NodeSource's sign-in flow can show its org picker again; the new org then applies to every installed harness, not just the one named. Native-plugin-installed harnesses (claude/codex/antigravity) pick it up on their next MCP reconnect; fallback-installed harnesses and CLI-direct harnesses (opencode/pi) need `install --harness <harness>` re-run afterward (see `switch-org`'s own output for harness-specific guidance).

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

`MCP bridge runtime is not ready` (from the wrapper) or `MCP bridge runtime is
missing/invalid` (from doctor) means the shared `mcp-remote` runtime is
absent or corrupt — different from an expired token, which reports
`credentials are expired`. Fix: rerun `npx -y nsolid-plugin@<plugin-version> setup --harness
<harness>`. The runtime survives `uninstall`/`logout`, so this only happens
after the directory is removed manually or `setup` never ran for this
machine. A `MCP runtime setup failed` error from setup means npm could not
install the runtime (network/registry); stored credentials stay valid — fix
network access and rerun the same command.

Development note: the generated wrapper must never download dependencies
during startup. It resolves `mcp-remote` exclusively from the shared runtime
or a version-matched checkout; there is deliberately no `npx` fallback.

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
