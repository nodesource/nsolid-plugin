# Tasks

Ordered breakdown; each group is independently testable. References:
proposal (scope/rollback), design (module contract, sequences), specs
(scenarios).

## 1. OpenSpec change

- [x] Create `openspec/changes/stage-mcp-runtime-during-setup/`
      (proposal, design, specs delta, tasks) per `ns-workflow`.
- [x] Register the `submit_plan` (Plannotator) tool limitation in the
      proposal; proceed under the user's explicit approval for this scope.
- [x] `openspec validate stage-mcp-runtime-during-setup --strict` passes.

## 2. Runtime manager (`packages/core/src/mcp/mcp-remote-runtime.ts`)

- [x] `MCP_REMOTE_VERSION = '0.1.38'`; paths via `getAgentsDir()` only.
- [x] `inspectMcpRemoteRuntime()`: read-only readiness probe (name, exact
      version, `dist/proxy.js`, transitive dependency closure).
- [x] `resolveNpmCommand()`: `npm_execpath` (validated) → node-dir
      `npm-cli.js` → node-dir `npm` shim; never `PATH`/`cwd`.
- [x] `resolveNpmCommand()` accepts `npm_execpath` only when it is npm's own
      CLI entry point; pnpm/yarn lifecycle values (`pnpm.cjs`, `yarn-*.cjs`)
      fall through to the node-dir npm resolution.
- [x] `ensureMcpRemoteRuntime()`: idempotent check, staging + private
      package.json, npm without shell (separated argv, `--ignore-exact` flag
      set per design), bounded stderr tail, 5-minute timeout, staging
      validation, atomic rename publish, race convergence, stale-aside
      replacement, actionable error.
- [x] Destructive ops confined to operation-created staging/stale paths inside
      the validated runtime parent.
- [x] Internal re-export from `packages/core/src/mcp/index.ts`.

## 3. Setup integration

- [x] `setup()` in `packages/core/src/index.ts`: after credentials are valid
      (or immediately when no auth), call `ensureMcpRemoteRuntime()` for every
      harness; progress lines `Preparing MCP bridge runtime — installed
      mcp-remote 0.1.38` / `already ready`; failure ⇒ `MCP runtime setup
      failed: …`, `success: false`, no "setup complete".
- [x] OpenCode/Pi direct `install()` only proceeds when the runtime is ready.
- [x] `install()` still never downloads/authenticates on its own.
- [x] Update `packages/core/scripts/setup.mjs` and `packages/core/src/cli.ts`
      wording (setup = credentials **and** bridge).

## 4. Wrapper / generators

- [x] `scripts/plugin-generators.mjs`: export `MCP_REMOTE_VERSION`; wrapper
      takes `<serverName> <harness>`, validates both, resolves the stable
      runtime first, version-matched `createRequire` dev fallback second, no
      npx/cmd.exe/shell anywhere; Claude config passes `claude`; Codex and
      Antigravity bootstraps pass `codex`/`antigravity`.
- [x] Regenerate root artifacts via `pnpm plugin:root`
      (`.mcp.json`, `.claude-mcp.json`, `mcp_config.json`,
      `scripts/mcp-wrapper.js`); keep `startup_timeout_sec: 60`.
- [x] `pnpm plugin:check` reports no drift.

## 5. Doctor

- [x] `DoctorReport.bridge` (optional) in `packages/core/src/types.ts`.
- [x] `doctor()` in `packages/core/src/index.ts`: required ⇔ wrapper-owned
      (claude/codex/antigravity with native plugin detected); error + unhealthy
      when required and not ready; informational otherwise; never implies the
      remote MCP is reachable.
- [x] `formatDoctorReport` human output + `--json` compatibility; update
      `packages/core/test/unit/utils/format.test.ts`.

## 6. Tests

- [x] New `packages/core/test/unit/mcp/mcp-remote-runtime.test.ts`: paths with
      spaces; initial install via fake runner; idempotence; invalid version;
      missing proxy; incomplete transitives; npm error/timeout cleanup; prior
      valid runtime survives failed reinstall; publish race; `shell: false`
      argv separation; `node_modules/.bin` cannot substitute npm; no secrets
      in output.
- [x] Rewrite `packages/core/test/unit/mcp/mcp-wrapper.test.ts`: stable-runtime
      fixture for `source` and `generated` wrappers; hostile URL/token argv
      boundaries; `npx` sentinel (exit 97) never executed; fast fail when
      runtime missing / version mismatched; harness-correct repair message;
      no `cmd.exe`/shell code paths; version sync across core module,
      generator and root `package.json`.
- [x] Update `packages/core/test/integration/installer.test.ts` (seed runtime
      / fake `npm_execpath` harness): setup installs runtime without browser;
      runtime failure keeps credentials with `success: false`; five-harness
      convergence; opencode/pi config regression guards; uninstall/logout
      preserve runtime; doctor unhealthy for wrapper-owned runtime-missing
      cases.

## 7. Documentation & lifecycle

- [x] `README.md` and `packages/core/README.md`: setup authenticates **and**
      prepares the bridge; first run needs network, later runs idempotent;
      troubleshooting entry for "runtime missing/corrupt" (vs expired token);
      dev note "the wrapper never downloads dependencies during startup".
- [x] `docs/technical-debt/native-mcp-oauth.md`: current vs target state,
      backend/plugin work, migration, risks, closure criteria — marked
      `Deferred`, no untracked TODO/FIXME.

## 8. Validation & commit

- [x] `pnpm --filter nsolid-plugin lint`, `pnpm --filter nsolid-plugin test`,
      `pnpm plugin:check`, `pnpm test:marketplace`, `pnpm test`.
- [x] `git diff --check`, `git status --short` clean of drift.
- [x] Atomic conventional commit: `fix(mcp): provision bridge runtime during
      setup`. No push/PR.

## 9. Post-review hardening (trusted npm resolution)

- [x] Spec delta amended per review findings: trusted-npm requirement +
      scenarios (non-npm `npm_execpath` ignored, no PATH/project `.bin`
      substitution), invalid-runtime replacement scenarios, doctor scenario
      moved to its own requirement, GIVEN added to the five-harnesses
      scenario; `design.md` npm-resolution order updated accordingly.
- [ ] `resolveNpmCommand()` ignores non-npm `npm_execpath` (pnpm/yarn) and
      falls back to node-dir npm, with unit tests covering the new spec
      scenarios. Handoff: `/tmp/nsolid-plugin-npm-execpath-fix-handoff.md`.
- [ ] Re-run `openspec validate stage-mcp-runtime-during-setup --strict`
      after the code fix lands; amend commit atomically.
