# MCP bridge runtime provisioning (delta)

## ADDED Requirements

### Requirement: Setup provisions the shared MCP bridge runtime

`nsolid-plugin setup` SHALL prepare a shared, versioned, local `mcp-remote`
runtime (exact pinned version) under `~/.agents/nsolid-plugin/runtime/` for
every supported harness, so MCP startup never needs npm.

#### Scenario: First setup installs the runtime

- **GIVEN** no runtime exists at `~/.agents/nsolid-plugin/runtime/mcp-remote/<version>/`
- **WHEN** the user runs `nsolid-plugin setup --harness <harness>`
- **THEN** setup installs `mcp-remote` with its dependencies into that versioned root via npm (no shell, exact version)
- **AND** the installed tree contains `node_modules/mcp-remote/package.json` with the exact pinned version and `node_modules/mcp-remote/dist/proxy.js`
- **AND** setup completes successfully

#### Scenario: Setup with a valid runtime is idempotent and offline-safe

- **GIVEN** a valid runtime already exists at the versioned root
- **WHEN** the user reruns `nsolid-plugin setup --harness <harness>`
- **THEN** the runtime is reused without invoking npm
- **AND** setup still completes successfully

#### Scenario: Multiple harnesses reuse one installation

- **GIVEN** a valid runtime was provisioned by setup for one harness
- **WHEN** the user runs setup for any other harness (or selects multiple harnesses in one run)
- **THEN** all harnesses converge on the same shared runtime path
- **AND** no additional npm installation is performed

#### Scenario: Setup prepares the runtime for all five harnesses

- **GIVEN** any supported harness (claude, codex, opencode, antigravity or pi)
- **WHEN** the user runs `nsolid-plugin setup --harness claude|codex|opencode|antigravity|pi`
- **THEN** the shared runtime ends up ready, regardless of whether that harness consumes the wrapper (claude/codex/antigravity) or native HTTP config (opencode/pi)
- **AND** for opencode/pi setup still writes their own MCP config and skills exactly as before

#### Scenario: npm failure fails setup but preserves credentials

- **GIVEN** npm fails, times out, or is unavailable during runtime provisioning
- **WHEN** the user runs `nsolid-plugin setup --harness <harness>`
- **THEN** setup finishes with `success: false` and an actionable `MCP runtime setup failed` error asking the user to rerun the same command
- **AND** any credentials already stored remain valid and untouched
- **AND** the temporary staging directory is cleaned up only after installer termination is confirmed; otherwise it is marked retained-live and excluded from publication and cleanup
- **AND** a previously valid runtime, if any, is left intact

#### Scenario: A timed-out managed npm process tree is terminated safely

- **GIVEN** npm spawns child or grandchild processes within its managed process group/tree during runtime provisioning
- **WHEN** the setup-time npm timeout elapses
- **THEN** Unix setup signals the detached process group, awaits the root process and confirms the group no longer exists; Windows setup awaits `taskkill /T /F` and the root process
- **AND** staging is cleaned only after termination is confirmed
- **AND** if confirmation reaches its bounded deadline, setup returns an actionable `terminationError`, records retained-live ownership metadata, and excludes staging from publication and cleanup while a survivor may still mutate it

#### Scenario: An npm spawn error fails setup cleanly

- **GIVEN** the resolved npm entry point cannot be spawned at all (missing or broken)
- **WHEN** the user runs setup for any harness
- **THEN** setup finishes with `success: false` and an actionable error distinguishing the spawn failure from an npm exit failure
- **AND** the staging directory is cleaned up and no partial runtime is published
- **AND** stored credentials are preserved and the command can be retried

#### Scenario: A failed reinstall keeps an invalid runtime untouched

- **GIVEN** the versioned root exists but fails validation (wrong version, missing `dist/proxy.js`, or incomplete dependency closure)
- **WHEN** setup re-provisions the runtime and the npm install or the staging validation fails
- **THEN** the pre-existing invalid runtime remains in place
- **AND** nothing is deleted before a replacement staging tree has validated

#### Scenario: Tokens and URLs keep argv boundaries during provisioning and startup

- **GIVEN** credentials containing spaces, quotes, `&`, `%PATH%` or other hostile characters
- **WHEN** setup provisions the runtime or the wrapper starts the bridge
- **THEN** URLs and header values are passed as separated argv elements (or in-process arguments) and never through a shell
- **AND** no secret appears in logs or error output

### Requirement: Runtime readiness validates dependency identity and versions

Runtime readiness SHALL verify, for every dependency in the runtime's
transitive closure, that the resolved package has the requested name, that its
installed version satisfies the dependent's declared range, and that
the canonical package, manifest and proxy targets never escape the canonical
runtime root — so every state called `ready` is loadable by the wrapper.

#### Scenario: A wrong-named transitive dependency is rejected

- **GIVEN** a dependency slot of `mcp-remote` (or of one of its transitives) resolves to a package whose `package.json` `name` differs from the requested dependency name
- **WHEN** readiness is evaluated
- **THEN** the runtime is reported invalid with a reason naming the mismatched dependency
- **AND** the invalid runtime is not reused without replacement

#### Scenario: An incompatible transitive version is rejected

- **GIVEN** a resolved dependency's installed `version` does not satisfy the range declared by its dependent (using the documented semver range syntax)
- **WHEN** readiness is evaluated
- **THEN** the runtime is reported invalid with a reason naming the unsatisfied range
- **AND** a range that cannot be parsed fails closed as invalid

#### Scenario: A missing transitive dependency is rejected at setup time

- **GIVEN** a non-optional dependency of `mcp-remote` or of one of its transitives resolves to no `package.json` inside the runtime
- **WHEN** readiness is evaluated
- **THEN** the runtime is reported invalid with a reason naming the missing dependency
- **AND** the missing package is never silently satisfied from outside the runtime

#### Scenario: Dependency resolution is confined to the runtime root

- **GIVEN** a package matching a needed dependency name exists only above the runtime root (for example in a user's global or home-directory `node_modules`)
- **WHEN** readiness walks the dependency closure
- **THEN** resolution stops at the runtime root and the dependency counts as missing
- **AND** no `package.json` outside the runtime root is ever read to satisfy the closure

#### Scenario: Runtime package symlink escapes are rejected

- **GIVEN** `mcp-remote`, `dist/proxy.js`, or a transitive dependency appears lexically inside the runtime root but its canonical target is outside the canonical root
- **WHEN** readiness is evaluated
- **THEN** the runtime is reported invalid before package code is imported
- **AND** the same canonical boundary rule applies to package directories, manifests and the proxy file

#### Scenario: Dependency kinds follow runtime-install semantics

- **GIVEN** a package declares required `dependencies`, missing `optionalDependencies`, and `peerDependencies` or `devDependencies`
- **WHEN** readiness walks its closure
- **THEN** every missing required dependency makes the runtime invalid
- **AND** missing optional dependencies are tolerated
- **AND** peer and development dependencies are ignored

### Requirement: Runtime publication is serialized and recoverable

Publishing a runtime version SHALL be serialized by a per-version lock owned
under the runtime parent, SHALL only ever move fully validated staging trees
into the versioned root, SHALL never remove a valid runtime, and SHALL recover
deterministically from any interruption — including a kill between the two
renames of an invalid-runtime replacement.

#### Scenario: An invalid runtime is replaced only by a validated staging

- **GIVEN** the versioned root exists but fails validation
- **WHEN** setup re-provisions the runtime and the staging tree validates
- **THEN** the invalid runtime is replaced under the publication lock by the validated staging tree
- **AND** readiness reports the runtime as ready afterwards

#### Scenario: Interrupted installation never publishes a partial runtime

- **GIVEN** runtime provisioning is interrupted (process killed, npm crash)
- **WHEN** the runtime root is inspected afterwards
- **THEN** no partially installed runtime is published at the versioned root
- **AND** leftover staging and stale-aside directories are ignored by readiness checks

#### Scenario: Interruption between the replacement renames leaves a recoverable state

- **GIVEN** an invalid runtime exists and a replacement is in progress
- **WHEN** the replacing process dies after `root` has been renamed aside but before the validated staging has been renamed in
- **THEN** the versioned root is absent and the renamed-aside tree is an inert sibling ignored by probes
- **AND** the wrapper fails fast with the repair message instead of starting a broken bridge
- **AND** no valid runtime has been destroyed (replacement only ever targets an invalid root)

#### Scenario: Retry after an interrupted replacement recovers deterministically

- **GIVEN** the versioned root is absent after an interrupted replacement (with or without inert stale siblings)
- **WHEN** the user reruns the repair command printed by the wrapper
- **THEN** the next operation publishes its own validated staging through the root-absent branch and ends with exactly one valid runtime at the versioned root
- **AND** the orphaned stale siblings are neither promoted nor required for recovery

#### Scenario: Potentially live staging is retained until reclamation is safe

- **GIVEN** managed-tree termination was not confirmed and staging is marked retained-live with its operation and process identity
- **WHEN** a later setup scans temporary trees under the publication lock
- **THEN** that staging is excluded from publication and deletion while its creator or managed process tree may still be alive or liveness is unknown
- **AND** after the grace period it may be reclaimed only when the creator is proven dead, the managed process tree is confirmed absent, and no live lock carries its operation token

#### Scenario: Orphaned stale trees are reclaimed conservatively

- **GIVEN** a stale-aside tree has valid ownership metadata from an interrupted publisher
- **WHEN** a later setup holds the publication lock and a valid versioned root exists
- **THEN** the stale tree may be removed only after the creator is proven dead and no live lock carries its operation token
- **AND** missing or malformed metadata, unknown liveness, permission errors or token mismatch retain the tree instead of guessing ownership

#### Scenario: Concurrent setups converge on a valid runtime

- **GIVEN** two `setup` processes provision the runtime concurrently
- **WHEN** both attempts finish
- **THEN** exactly one valid runtime exists at the versioned root
- **AND** the loser of the publish race accepts the valid winner and removes only its own staging

#### Scenario: Concurrent setups replacing an invalid runtime converge under the lock

- **GIVEN** the versioned root holds an invalid runtime and two `setup` processes concurrently re-provision
- **WHEN** both attempts finish
- **THEN** the publication lock serializes the replacement so exactly one valid runtime exists at the versioned root
- **AND** the second operation re-inspects under the lock, accepts the first operation's valid runtime, and deletes only its own staging
- **AND** a lock older than the stale threshold is broken only when its holder is proven dead; breaking it does not grant ownership until a fresh `O_EXCL` acquisition succeeds
- **AND** a live holder is never evicted based on age alone

### Requirement: Runtime provisioning resolves a trusted npm

Runtime provisioning SHALL resolve the npm entry point exclusively from
canonical candidates anchored to the real running Node.js installation,
and SHALL never consult `PATH`, the current working directory/project, or
`npm_execpath` — so neither a hostile project nor a non-npm package manager
can substitute the installer by filename, directory segment, symlink escape or
environment value.

#### Scenario: npm is never resolved from PATH, the project, or the environment

- **GIVEN** the current project's `node_modules/.bin` or the `PATH` contains an executable named `npm`, and `npm_execpath` is set
- **WHEN** setup provisions the runtime from that project
- **THEN** none of those values is consulted or executed
- **AND** npm is resolved only from the candidates anchored to the running Node.js executable

#### Scenario: A fake npm-cli.js is never trusted

- **GIVEN** a hostile or unrelated directory contains `node_modules/npm/bin/npm-cli.js` and `npm_execpath` points at it
- **WHEN** setup provisions the runtime
- **THEN** that file is never consulted or executed, regardless of its basename or directory segments
- **AND** npm is resolved from the Node.js-anchored candidates instead

#### Scenario: A renamed npm entry point is ignored

- **GIVEN** `npm_execpath` points at a renamed copy of npm's CLI entry point outside the running Node.js installation
- **WHEN** setup provisions the runtime
- **THEN** the value is ignored entirely
- **AND** npm is resolved from the Node.js-anchored candidates instead

#### Scenario: Symlinked or path-escaped npm_execpath values are ignored

- **GIVEN** `npm_execpath` names a path that resolves through a symlink (or `..` segments) to a file outside the running Node.js installation
- **WHEN** setup provisions the runtime
- **THEN** the value is ignored entirely
- **AND** npm is resolved from the Node.js-anchored candidates instead

#### Scenario: A non-npm npm_execpath is ignored

- **GIVEN** `npm_execpath` points at an existing absolute entry point of another package manager (pnpm, yarn), or is non-absolute or missing
- **WHEN** setup provisions the runtime
- **THEN** that entry point is not used
- **AND** npm is resolved from the Node.js-anchored candidates instead

#### Scenario: Supported Node.js/npm layouts resolve without PATH

- **GIVEN** the running Node.js installation uses a supported layout — npm's `npm-cli.js` under `node_modules/npm` adjacent to the Node binary (Windows installer), under `../lib/node_modules/npm` relative to the Node binary's directory (Unix prefix layouts such as nvm/Volta/Homebrew/macOS), or an executable `npm` sibling shim of the Node binary (Unix distributions)
- **WHEN** setup provisions the runtime
- **THEN** `process.execPath` and the candidate are canonicalized, the target is a regular file inside the canonical Node installation prefix, and npm runs without a shell
- **AND** when no anchored candidate exists, setup fails with an actionable error telling the user to install Node.js with npm

#### Scenario: An anchored npm candidate cannot escape through a symlink

- **GIVEN** a candidate exists at one of the Node.js-anchored locations but its canonical target escapes the canonical installation prefix
- **WHEN** setup resolves npm
- **THEN** the candidate is rejected and never executed
- **AND** setup tries the next trusted candidate or fails with the actionable npm-not-found error

### Requirement: Onboarding dispatchers satisfy the runtime precondition

Every onboarding dispatcher SHALL satisfy runtime provisioning —
`ensureMcpRemoteRuntime()` to readiness — before invoking harness-specific
asset installation, so OpenCode and Pi cannot bypass the precondition, while
`install()` itself remains free of authentication and dependency bootstrap.

#### Scenario: OpenCode onboarding provisions the runtime before assets

- **GIVEN** the native plugin bootstrap dispatches the OpenCode harness through `install()` (no authentication flow)
- **WHEN** OpenCode onboarding runs
- **THEN** the dispatcher satisfies the runtime precondition before any OpenCode skills/MCP config are installed
- **AND** a runtime-precondition failure aborts onboarding with the actionable error instead of silently skipping provisioning

#### Scenario: Pi onboarding provisions the runtime before assets

- **GIVEN** the native plugin bootstrap dispatches the Pi harness through `install()` (package-owned skills, MCP config only)
- **WHEN** Pi onboarding runs
- **THEN** the dispatcher satisfies the runtime precondition before any Pi MCP config is written
- **AND** the precondition needs no credentials (the npm download is anonymous)

#### Scenario: install() itself never provisions or authenticates

- **GIVEN** the core `install()` function is invoked directly (fallback direct installer)
- **WHEN** it completes
- **THEN** it never invoked npm, never downloaded dependencies, and never opened an authentication flow
- **AND** the runtime precondition remains the dispatchers' responsibility

### Requirement: The MCP wrapper uses the stable runtime by default

The generated MCP wrapper SHALL resolve `mcp-remote` from the stable shared
runtime by default. A version-matched development checkout MAY be used only
when explicit internal development mode is enabled. The wrapper SHALL NOT
execute or spawn `npx`, npm, `cmd.exe`, or a shell during startup. The repair
message may contain an `npx` command as text.

#### Scenario: Wrapper starts from the stable runtime without npm

- **GIVEN** a valid runtime provisioned by setup
- **WHEN** the harness starts an MCP server through the wrapper
- **THEN** the wrapper validates the runtime's package name, exact version and `dist/proxy.js`, imports it locally, and passes URL/headers as separate arguments
- **AND** an `npx` sentinel on PATH is never executed

#### Scenario: Missing or corrupt runtime fails fast with the version-pinned repair command

- **GIVEN** the runtime is missing, has the wrong version, or lacks `dist/proxy.js`
- **WHEN** the wrapper starts
- **THEN** it exits non-zero within seconds with a message equivalent to `MCP bridge runtime is not ready. Run: npx -y nsolid-plugin@<plugin-version> setup --harness <harness>`
- **AND** the message names the harness that launched the wrapper (claude, codex or antigravity)
- **AND** the pinned plugin version is the release that generated the wrapper

#### Scenario: A project dependency cannot bypass the managed runtime

- **GIVEN** the stable runtime is missing or invalid, a matching `mcp-remote` exists in local/project `node_modules`, and development mode is not enabled
- **WHEN** the wrapper starts
- **THEN** it does not import the project dependency and fails with the version-pinned repair message

#### Scenario: Explicit development mode permits only the pinned fallback

- **GIVEN** `NSOLID_MCP_RUNTIME_DEV_FALLBACK=1` is explicitly set for development and a local `mcp-remote` checkout is available
- **WHEN** the wrapper starts without a ready stable runtime
- **THEN** it accepts the fallback only when its package name, exact pinned version and proxy file validate
- **AND** released harness configurations never enable this mode

#### Scenario: An import-time runtime failure becomes the repair message

- **GIVEN** the runtime passes the wrapper's light validation but importing or initializing `dist/proxy.js` throws, including a missing or incompatible transitive failure
- **WHEN** the wrapper starts
- **THEN** the import-time failure is translated into the same harness-specific, version-pinned repair message instead of a raw module error
- **AND** the wrapper exits non-zero within seconds

#### Scenario: The printed repair command recreates the wrapper's exact runtime

- **GIVEN** a wrapper generated by plugin release X (requiring `mcp-remote@V`) runs on a machine where a newer plugin release exists
- **WHEN** the wrapper prints its repair command and the user executes it
- **THEN** the command pins `nsolid-plugin@X`, and that CLI version provisions exactly runtime version V
- **AND** the wrapper that printed the message validates the freshly provisioned runtime as ready

### Requirement: Shared runtime lifecycle

The shared runtime SHALL survive per-harness uninstall and logout.

#### Scenario: Uninstall and logout preserve the shared runtime

- **GIVEN** the shared runtime exists
- **WHEN** the user runs `nsolid-plugin uninstall --harness <any>` or `nsolid-plugin logout`
- **THEN** the runtime directory remains (shared across harnesses, no secrets stored)
- **AND** other harnesses continue to work

### Requirement: Doctor reports bridge runtime health

`doctor` SHALL surface the shared bridge runtime state and SHALL mark a
wrapper-owned harness configuration unhealthy when the runtime is missing or
invalid, without ever treating bridge readiness as proof of remote endpoint
reachability.

#### Scenario: Required wrapper bridge missing is unhealthy

- **GIVEN** doctor runs for a wrapper-owned harness configuration (native plugin installed for claude, codex or antigravity)
- **WHEN** the runtime is missing or invalid
- **THEN** doctor reports `healthy: false` and recommends `nsolid-plugin setup --harness <harness>`

#### Scenario: Ready wrapper bridge reports local readiness only

- **GIVEN** doctor runs for a wrapper-owned harness configuration with a ready runtime
- **WHEN** human or JSON output is produced
- **THEN** bridge status is `ready` and does not make an otherwise unhealthy report healthy
- **AND** the output never claims that the remote MCP endpoint is reachable

#### Scenario: Non-wrapper bridge state is informational

- **GIVEN** doctor runs for opencode, pi, a native-HTTP direct install, or claude/codex/antigravity without the native plugin detected
- **WHEN** the runtime is ready, missing or invalid
- **THEN** `bridge.required` is false and bridge state does not affect health
- **AND** human and JSON output distinguish local bridge readiness from remote MCP reachability

### Requirement: Native MCP OAuth is out of scope

The plugin SHALL keep the Accounts OAuth flow and the service-token headers
unchanged by this change.

#### Scenario: No confusion between Accounts OAuth and native MCP OAuth

- **GIVEN** the current wrapper authenticates MCP traffic with `X-Nsolid-*` headers minted from the NodeSource Accounts OAuth flow
- **WHEN** this change ships
- **THEN** that mechanism is preserved unchanged
- **AND** migrating to native MCP-transport OAuth remains deferred technical debt, not implemented here
