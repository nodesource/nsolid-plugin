# Tasks

Ordered breakdown; each group is independently testable. References:
proposal (scope/rollback), design (module contract, sequences), specs
(scenarios).

## 1. OpenSpec change

- [ ] Create `openspec/changes/stage-mcp-runtime-during-setup/`
      (proposal, design, specs delta, tasks) per `ns-workflow`.
- [ ] Register the `submit_plan` (Plannotator) tool limitation in the
      proposal; proceed under the user's explicit approval for this scope.
- [ ] `openspec validate stage-mcp-runtime-during-setup --strict` passes.

## 2. Runtime manager (`packages/core/src/mcp/mcp-remote-runtime.ts`)

- [ ] `MCP_REMOTE_VERSION = '0.1.38'`; paths via `getAgentsDir()` only.
- [ ] `inspectMcpRemoteRuntime()`: read-only readiness probe (name, exact
      version, `dist/proxy.js`, transitive dependency closure).
- [ ] `resolveNpmCommand()`: `npm_execpath` (validated) → node-dir
      `npm-cli.js` → node-dir `npm` shim; never `PATH`/`cwd`.
- [ ] `resolveNpmCommand()` accepts `npm_execpath` only when it is npm's own
      CLI entry point; pnpm/yarn lifecycle values (`pnpm.cjs`, `yarn-*.cjs`)
      fall through to the node-dir npm resolution.
- [ ] `ensureMcpRemoteRuntime()`: idempotent check, staging + private
      package.json, npm without shell (separated argv, `--ignore-exact` flag
      set per design), bounded stderr tail, 5-minute timeout, staging
      validation, atomic rename publish, race convergence, stale-aside
      replacement, actionable error.
- [ ] Destructive ops confined to operation-created staging/stale paths inside
      the validated runtime parent.
- [ ] Internal re-export from `packages/core/src/mcp/index.ts`.

## 3. Setup integration

- [ ] `setup()` in `packages/core/src/index.ts`: after credentials are valid
      (or immediately when no auth), call `ensureMcpRemoteRuntime()` for every
      harness; progress lines `Preparing MCP bridge runtime — installed
      mcp-remote 0.1.38` / `already ready`; failure ⇒ `MCP runtime setup
      failed: …`, `success: false`, no "setup complete".
- [ ] OpenCode/Pi direct `install()` only proceeds when the runtime is ready.
- [ ] `install()` still never downloads/authenticates on its own.
- [ ] Update `packages/core/scripts/setup.mjs` and `packages/core/src/cli.ts`
      wording (setup = credentials **and** bridge).

## 4. Wrapper / generators

- [ ] `scripts/plugin-generators.mjs`: export `MCP_REMOTE_VERSION`; wrapper
      takes `<serverName> <harness>`, validates both, resolves the stable
      runtime first, version-matched `createRequire` dev fallback second, no
      npx/cmd.exe/shell anywhere; Claude config passes `claude`; Codex and
      Antigravity bootstraps pass `codex`/`antigravity`.
- [ ] Regenerate root artifacts via `pnpm plugin:root`
      (`.mcp.json`, `.claude-mcp.json`, `mcp_config.json`,
      `scripts/mcp-wrapper.js`); keep `startup_timeout_sec: 60`.
- [ ] `pnpm plugin:check` reports no drift.

## 5. Doctor

- [ ] `DoctorReport.bridge` (optional) in `packages/core/src/types.ts`.
- [ ] `doctor()` in `packages/core/src/index.ts`: required ⇔ wrapper-owned
      (claude/codex/antigravity with native plugin detected); error + unhealthy
      when required and not ready; informational otherwise; never implies the
      remote MCP is reachable.
- [ ] `formatDoctorReport` human output + `--json` compatibility; update
      `packages/core/test/unit/utils/format.test.ts`.

## 6. Tests

- [ ] New `packages/core/test/unit/mcp/mcp-remote-runtime.test.ts`: paths with
      spaces; initial install via fake runner; idempotence; invalid version;
      missing proxy; incomplete transitives; npm error/timeout cleanup; prior
      valid runtime survives failed reinstall; publish race; `shell: false`
      argv separation; `node_modules/.bin` cannot substitute npm; no secrets
      in output.
- [ ] Rewrite `packages/core/test/unit/mcp/mcp-wrapper.test.ts`: stable-runtime
      fixture for `source` and `generated` wrappers; hostile URL/token argv
      boundaries; `npx` sentinel (exit 97) never executed; fast fail when
      runtime missing / version mismatched; harness-correct repair message;
      no `cmd.exe`/shell code paths; version sync across core module,
      generator and root `package.json`.
- [ ] Update `packages/core/test/integration/installer.test.ts` (seed runtime
      / fake `npm_execpath` harness): setup installs runtime without browser;
      runtime failure keeps credentials with `success: false`; five-harness
      convergence; opencode/pi config regression guards; uninstall/logout
      preserve runtime; doctor unhealthy for wrapper-owned runtime-missing
      cases.

## 7. Documentation & lifecycle

- [ ] `README.md` and `packages/core/README.md`: setup authenticates **and**
      prepares the bridge; first run needs network, later runs idempotent;
      troubleshooting entry for "runtime missing/corrupt" (vs expired token);
      dev note "the wrapper never downloads dependencies during startup".

## 8. Validation & commit

- [ ] `pnpm --filter nsolid-plugin lint`, `pnpm --filter nsolid-plugin test`,
      `pnpm plugin:check`, `pnpm test:marketplace`, `pnpm test`.
- [ ] `git diff --check`, `git status --short` clean of drift.
- [ ] Atomic conventional commit: `fix(mcp): provision bridge runtime during
      setup`. No push/PR.

## 9. Post-review hardening (trusted npm resolution)

- [ ] Spec delta amended per review findings: trusted-npm requirement +
      scenarios (non-npm `npm_execpath` ignored, no PATH/project `.bin`
      substitution), invalid-runtime replacement scenarios, doctor scenario
      moved to its own requirement, GIVEN added to the five-harnesses
      scenario; `design.md` npm-resolution order updated accordingly.
- [ ] `resolveNpmCommand()` ignores non-npm `npm_execpath` (pnpm/yarn) and
      falls back to node-dir npm, with unit tests covering the new spec
      scenarios. Handoff: `/tmp/nsolid-plugin-npm-execpath-fix-handoff.md`.
- [ ] Re-run `openspec validate stage-mcp-runtime-during-setup --strict`
      after the code fix lands; amend commit atomically.
