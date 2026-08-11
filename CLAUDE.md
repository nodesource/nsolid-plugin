# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

`nsolid-plugin` distributes NodeSource N|Solid AI skills and MCP server configs into five agent harnesses: Claude Code, Codex CLI, OpenCode, Antigravity CLI, and Pi Agent. It ships 17 skills (memory leak/spike analysis, CPU spikes, tracing, vulnerability/dependency audits, Node/package upgrades, benchmarking, SBOM, org switching) backed by three MCP servers (`nsolid-console`, `ns-benchmark`, `ncm`).

## Commands

```bash
pnpm build                    # Build all packages (pnpm -r build)
pnpm test                     # All tests (unit + integration), cross-platform runner
pnpm test:unit                # Unit tests only
pnpm test:integration         # Integration tests only
pnpm lint                     # Lint all packages (neostandard, eslint.config.js)
pnpm test:marketplace         # Validates marketplace/plugin install artifacts (also run in CI)
```

Run a single test file directly (the package-level `pnpm test` wraps this same runner):

```bash
node --experimental-test-module-mocks --import tsx/esm --test packages/core/test/unit/skills/skill-copier.test.ts
```

Scope `pnpm test` to one package: `node scripts/run-tests.mjs core`.

**Do not use `node --test 'packages/*/test/**/*.test.ts'` with a shell glob** — `scripts/run-tests.mjs` exists specifically because Node's internal glob matcher silently matches zero files on Windows (exits 0 with "0 tests"). It discovers `*.test.ts` files with `node:fs` and passes explicit paths to `node --test` instead. Always go through `pnpm test` / `run-tests.mjs`, never a raw glob.

### Asset/manifest sync checks (run before committing generated-file changes)

```bash
pnpm --filter nsolid-plugin bundle:check   # core's bundle.json copy is in sync with root
pnpm --filter nsolid-plugin bundle:sync    # sync it
pnpm plugin:check                          # generated manifests/configs in sync + no committed package skill copies
pnpm plugin:sync                           # regenerate manifests/configs, remove materialized package skill copies
pnpm plugin:materialize                    # copy root skills into packages/pi-plugin for pack/release
pnpm plugin:root                           # refresh root marketplace/plugin manifests from bundle.json
pnpm plugin:root:check                     # fail if committed root manifests drift from bundle.json
```

CI (`.github/workflows/test.yml`, matrix: ubuntu/macos/windows) runs `pnpm lint`, `pnpm build`, `pnpm test`, `node scripts/test-marketplace-install.js`. The pre-commit hook (`.husky/pre-commit`) runs `pnpm lint && pnpm test`. Run `pnpm plugin:check` yourself before release — it is not in the git hook.

## Architecture

### Single source of truth, five distribution paths

Skills are canonical **only** under root `skills/<skill-name>/` (SKILL.md + helper scripts). `bundle.json` at the repo root is the canonical descriptor: it lists every skill (name, path, description, `requiresMcp`) and the three `mcpServers` (with `${MCP_URL}`, `${AUTH_TOKEN}`, `${AUTH_ORG_ID}` placeholders) plus the OAuth `auth` block. Everything else — `.claude-plugin/`, `.codex-plugin/`, `plugin.json`, `packages/pi-plugin`, and `packages/core`'s own bundled copy — is generated or materialized *from* `bundle.json` and root `skills/`. Never hand-edit generated manifests; edit `bundle.json` and/or `skills/` and regenerate with the `plugin:*` scripts above.

Per-harness install model (see `README.md` "Supported harnesses" table and `openspec/changes/archive/2026-07-21-cross-harness-plugin-installer/` for the original design rationale):

- **Claude / Codex / Antigravity**: install the repo root as a native harness plugin (marketplace manifests under `.claude-plugin/`, `.codex-plugin/`, `plugin.json`). `nsolid-plugin install --harness <x>` (from `packages/core`) is only a fallback/repair path — never the primary install.
- **OpenCode**: no native plugin model. `packages/core`'s CLI is the *only* install path: `setup` then `install --harness opencode`, which copies skills to `~/.config/opencode/skills/` and writes MCP config to `~/.config/opencode/opencode.jsonc`.
- **Pi Agent**: `packages/pi-plugin` is a real npm package (`nsolid-pi-plugin`) that owns its skills via `pi.skills` in its manifest; skills are materialized into it only at `prepack` time (`pnpm plugin:materialize`) and cleaned afterward (`pnpm plugin:clean` / `plugin:sync`) — a materialized `packages/pi-plugin/skills/` should never be committed. `packages/core`'s CLI writes only `~/.pi/agent/mcp.json` for Pi; a separate `pi-mcp-adapter` package is required at runtime since Pi has no native MCP support.

No harness relies on npm `postinstall` hooks — install/setup is always an explicit command.

### `packages/core`

The shared TypeScript library + CLI (published as npm package `nsolid-plugin`), organized by concern:

- `src/auth/` — NodeSource OAuth flow (`auth-manager.ts` orchestrates; `oauth-server.ts` is the local callback listener on port 8765, fallback 8766–8770; `token-storage.ts`/`token-validator.ts` manage `~/.agents/.nodesource-auth.json`, mode `0600`, shared across all harnesses).
- `src/harnesses/` — one adapter per harness (`claude-adapter.ts`, `codex-adapter.ts`, `opencode-adapter.ts`, `antigravity-adapter.ts`, `pi-adapter.ts`) implementing the `HarnessAdapter` interface (`harness-adapter.ts`): `getMcpConfigPath`, `getSkillsPath`, `readMcpConfig`/`writeMcpConfig`, and optional `detectNativePlugin()` for harnesses with a native plugin model (doctor treats it as N/A where absent, e.g. OpenCode).
- `src/mcp/` — MCP config merging (`mcp-config-merger.ts`, never clobbers non-NodeSource servers already in a harness config) and dedup tracking (`mcp-tracker.ts`).
- `src/skills/` — `skill-copier.ts` / `skill-linker.ts` install skills into a harness's skills dir; both validate the destination name and resolved source path stay within their base directories (path-traversal guards — see `*-security.test.ts` siblings) before touching disk.
- `src/cli.ts` → the `nsolid-plugin` bin, dispatching `setup | install | uninstall | doctor | restore`.

Install/setup are intentionally split: `setup()` is the only thing that authenticates/opens a browser; `install()` is a pure asset installer that never touches auth. Runtime MCP wrapper scripts fail fast with an actionable `Run: nsolid-plugin setup --harness <harness>` message when credentials are missing/expired rather than trying to trigger auth themselves.

Config mutations are backed up first to `~/.agents/.config-backup/<harness>/<timestamp>.<ext>` (with a `.meta.json` sidecar) before any harness MCP config is overwritten, restorable via `restore()`.

### `scripts/`

- `run-tests.mjs` — the cross-platform test discovery/runner described above.
- `sync-plugin-assets.mjs` — implements `plugin:sync` / `plugin:check` / `plugin:materialize`.
- `materialize-github-marketplace.mjs` — implements `plugin:root` / `plugin:root:check`.
- `mcp-wrapper.js` — the runtime shim referenced by generated MCP configs; injects auth headers from stored credentials and produces the actionable re-auth error mentioned above.
- `test-marketplace-install.js` — end-to-end check that the generated marketplace/plugin artifacts actually install correctly.

### Skill anatomy

Each `skills/<name>/` has a `SKILL.md` (frontmatter + instructions the agent follows) plus optional helper scripts (e.g. `fetch-asset.cjs`, `workspace-delta.cjs`) that skills shell out to. Skills declare `requiresMcp` in `bundle.json` — skills without it (e.g. `ns-optimize-function`) work purely from local workspace source, no MCP call required.
