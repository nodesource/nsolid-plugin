# Tasks

Ordered breakdown; each group is independently testable. References:
proposal (scope/rollback), design (module contract, sequences), specs
(scenarios).

## 1. OpenSpec change

- [ ] Create `openspec/changes/stage-mcp-runtime-during-setup/`
      (proposal, design, specs delta, tasks) per `ns-workflow`.
- [ ] Register the `submit_plan` (Plannotator) tool limitation in the
      proposal; proceed under the user's explicit approval for this scope.
- [ ] Amend proposal, design, specs delta and tasks per the PR #62 review:
      recoverable publication, canonical npm resolution, wrapper import
      failures, dispatcher precondition, managed-tree timeout cancellation,
      dependency identity/version ranges, version-pinned repair command,
      execution-scoped "no npx" wording and editorial fixes.
- [ ] `openspec validate stage-mcp-runtime-during-setup --strict` passes.

## 2. Runtime manager (`packages/core/src/mcp/mcp-remote-runtime.ts`)

- [ ] `MCP_REMOTE_VERSION = '0.1.38'`; paths via `getAgentsDir()` only.
- [ ] `inspectMcpRemoteRuntime()`: read-only readiness probe (name, exact
      version, `dist/proxy.js`, transitive dependency closure with
      per-dependency name identity, semver range satisfaction and
      resolution confined to the runtime root).
- [ ] Add `semver` to `packages/core` dependencies for range evaluation;
      unparseable ranges fail closed (documented supported syntax in
      `design.md`).
- [ ] `resolveNpmCommand()`: canonical Node.js-anchored candidates only — node-dir
      `node_modules/npm/bin/npm-cli.js`, then `../lib/node_modules/npm/bin/
      npm-cli.js`, then node-dir `npm` sibling shim; otherwise actionable
      error. Canonicalize `process.execPath` and each candidate; require a
      regular-file target inside the canonical installation prefix. Never
      consults `PATH`, `cwd`/project `.bin`, or
      `npm_execpath` (fake, renamed, symlinked and pnpm/yarn values are
      ignored by construction).
- [ ] `ensureMcpRemoteRuntime()`: idempotent check, staging + private
      package.json, npm without shell (separated argv, `--save-exact` flag
      set per design), bounded stderr tail, 5-minute timeout, staging
      validation, publication under the per-version lock, race
      convergence, invalid-runtime replacement via rename-aside, actionable
      error.
- [ ] Publication protocol: `O_EXCL` lock file under the runtime parent
      keyed by version with unique owner token; bounded-backoff waiting;
      break a lock older than 10 minutes only when its holder is proven dead,
      then reacquire with a fresh `O_EXCL` create (moving a stale lock does not
      grant ownership); never evict a live holder based on age; re-inspect
      `root` under the lock and accept a valid winner; validate staging
      before touching `root`; root-absent publish = single rename; invalid
      root replaced by rename-aside + rename-in + stale removal; recovery
      of an absent root is the normal root-absent branch; cleanup strictly
      limited to operation-created staging/stale/lock paths.
- [ ] Timeout handling: terminate and confirm the managed npm process tree
      stopped (Unix: detached process group, SIGTERM → SIGKILL escalation,
      root close and group-disappearance polling; Windows: await
      `taskkill /T /F` and root close) before staging cleanup; leave staging
      inert and return `terminationError` when confirmation times out; spawn
      errors
      (`ENOENT`/`EACCES`/`EPERM`) surfaced as an explicit `spawnError`
      result, never as exit status.
- [ ] Internal re-export from `packages/core/src/mcp/index.ts`.

## 3. Setup integration & dispatcher precondition

- [ ] `setup()` in `packages/core/src/index.ts`: after credentials are valid
      (or immediately when no auth), call `ensureMcpRemoteRuntime()` before
      any per-harness install branch; progress lines `Preparing MCP bridge
      runtime — installed mcp-remote 0.1.38` / `already ready`; failure ⇒
      `MCP runtime setup failed: …`, `success: false`, no "setup complete".
- [ ] `packages/core/scripts/setup.mjs`: satisfy the runtime precondition
      (credentials-free `ensureMcpRemoteRuntime()`) before delegating to
      `install()` for opencode/pi, so neither harness bypasses
      provisioning.
- [ ] `packages/core/src/cli.ts`: satisfy the same precondition before the
      fallback `install` command.
- [ ] `install()` still never downloads/authenticates on its own
      (regression guard).
- [ ] Update `packages/core/scripts/setup.mjs` and `packages/core/src/cli.ts`
      wording (setup = credentials **and** bridge).

## 4. Wrapper / generators

- [ ] `scripts/plugin-generators.mjs`: export `MCP_REMOTE_VERSION`; embed
      `MCP_REMOTE_VERSION` **and** `PLUGIN_VERSION` (the generating
      release) in the wrapper; wrapper takes `<serverName> <harness>`,
      validates both, resolves the stable runtime first, version-matched
      `createRequire` dev fallback second, and never executes or spawns
      `npx`, npm, `cmd.exe`, or a shell (the repair message may contain an
      `npx` command as text); import-time dependency-resolution failures
      are translated into the repair message; repair message is
      version-pinned: `npx -y nsolid-plugin@<PLUGIN_VERSION> setup
      --harness <harness>`; Claude config passes `claude`; Codex and
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
      missing proxy; incomplete transitives; wrong-named transitive;
      incompatible transitive version; dependency resolution confined to the
      runtime root; npm error/timeout cleanup; managed process-group timeout
      termination confirmation (grandchild included) and unconfirmed-
      termination staging preservation; npm spawn error;
      prior valid runtime survives failed reinstall; publish race; race
      replacing an invalid runtime; interruption between the two replacement
      renames (root absent, stale inert); retry recovery determinism;
      stale dead-lock break followed by fresh acquisition, live-lock
      non-eviction and competing-breaker serialization; `shell: false` argv
      separation; trusted npm resolution (fake `npm-cli.js`, renamed entry
      point, anchored-candidate symlink/path escape, pnpm/yarn `npm_execpath`
      ignored, supported Node/npm layouts,
      `node_modules/.bin` and `PATH` never consulted); no secrets in output.
- [ ] Rewrite `packages/core/test/unit/mcp/mcp-wrapper.test.ts`: stable-runtime
      fixture for `source` and `generated` wrappers; hostile URL/token argv
      boundaries; `npx` sentinel (exit 97) never executed; fast fail when
      runtime missing / version mismatched; any import-time resolution or
      initialization failure translated into the repair message; harness-correct,
      version-pinned repair message; no `cmd.exe`/shell execution paths;
      version sync across core module, generator and root `package.json`
      plus wrapper-embedded `PLUGIN_VERSION`; old-wrapper/new-CLI repair
      (wrapper of release X prints `nsolid-plugin@X`, which provisions
      exactly X's pinned runtime version).
- [ ] Update `packages/core/test/integration/installer.test.ts` (seed runtime
      / fake `npm_execpath` harness): setup installs runtime without browser;
      runtime failure keeps credentials with `success: false`;
      five-harness convergence; opencode/pi dispatcher scenarios (runtime
      provisioned before assets); `install()` purity regression guards;
      uninstall/logout preserve runtime; doctor unhealthy for wrapper-owned
      runtime-missing cases.

## 7. Documentation & lifecycle

- [ ] `README.md` and `packages/core/README.md`: setup authenticates **and**
      prepares the bridge; first run needs network, later runs idempotent;
      troubleshooting entry for "runtime missing/corrupt" (vs expired
      token); the repair command is version-pinned; npm is resolved from
      the Node.js installation only; dev note "the wrapper never downloads
      dependencies during startup".

## 8. Validation & commit

- [ ] `pnpm --filter nsolid-plugin lint`, `pnpm --filter nsolid-plugin test`,
      `pnpm plugin:check`, `pnpm test:marketplace`, `pnpm test`.
- [ ] `git diff --check`, `git status --short` clean of drift.
- [ ] Atomic conventional commit: `fix(mcp): provision bridge runtime during
      setup`. No push/PR.
