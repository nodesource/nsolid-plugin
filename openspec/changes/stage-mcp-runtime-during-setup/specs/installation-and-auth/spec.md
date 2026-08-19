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
- **AND** the temporary staging directory used by the failed attempt is cleaned up
- **AND** a previously valid runtime, if any, is left intact

#### Scenario: A failed reinstall keeps an invalid runtime untouched

- **GIVEN** the versioned root exists but fails validation (wrong version, missing `dist/proxy.js`, or incomplete dependency closure)
- **WHEN** setup re-provisions the runtime and the npm install or the staging validation fails
- **THEN** the pre-existing invalid runtime remains in place
- **AND** nothing is deleted before a replacement staging tree has validated

#### Scenario: An invalid runtime is replaced only by a validated staging

- **GIVEN** the versioned root exists but fails validation
- **WHEN** setup re-provisions the runtime and the staging tree validates
- **THEN** the invalid runtime is swapped for the validated staging atomically
- **AND** readiness reports the runtime as ready afterwards

#### Scenario: Interrupted installation never publishes a partial runtime

- **GIVEN** runtime provisioning is interrupted (process killed, npm crash)
- **WHEN** the runtime root is inspected afterwards
- **THEN** no partially installed runtime is published at the versioned root
- **AND** leftover staging directories are ignored by readiness checks

#### Scenario: Concurrent setups converge on a valid runtime

- **GIVEN** two `setup` processes provision the runtime concurrently
- **WHEN** both attempts finish
- **THEN** exactly one valid runtime exists at the versioned root
- **AND** the loser of the publish race accepts the valid winner and removes only its own staging

#### Scenario: Tokens and URLs keep argv boundaries during provisioning and startup

- **GIVEN** credentials containing spaces, quotes, `&`, `%PATH%` or other hostile characters
- **WHEN** setup provisions the runtime or the wrapper starts the bridge
- **THEN** URLs and header values are passed as separated argv elements (or in-process arguments) and never through a shell
- **AND** no secret appears in logs or error output

### Requirement: Runtime provisioning resolves a trusted npm

Runtime provisioning SHALL resolve the npm entry point without consulting
`PATH` or the current working directory, and SHALL ignore `npm_execpath`
values that do not belong to npm itself, so neither a hostile project nor a
non-npm package manager can substitute the installer.

#### Scenario: npm is never resolved from PATH or the project

- **GIVEN** the current project's `node_modules/.bin` or the `PATH` contains an executable named `npm`
- **WHEN** setup provisions the runtime from that project
- **THEN** that executable is never consulted
- **AND** npm is resolved from `npm_execpath` (only when it is npm's own entry point) or from the Node.js installation directory

#### Scenario: A non-npm npm_execpath is ignored

- **GIVEN** `npm_execpath` points at an existing absolute entry point of another package manager (pnpm, yarn), or is non-absolute or missing
- **WHEN** setup provisions the runtime
- **THEN** that entry point is not used
- **AND** npm is resolved next to the running Node.js executable instead

### Requirement: The MCP wrapper uses only the stable runtime

The generated MCP wrapper SHALL resolve `mcp-remote` from the stable shared
runtime (or a version-matched development checkout) and SHALL NOT execute
`npx`/`cmd.exe`/npm during startup.

#### Scenario: Wrapper starts from the stable runtime without npm

- **GIVEN** a valid runtime provisioned by setup
- **WHEN** the harness starts an MCP server through the wrapper
- **THEN** the wrapper validates the runtime's package name, exact version and `dist/proxy.js`, imports it locally, and passes URL/headers as separate arguments
- **AND** an `npx` sentinel on PATH is never executed

#### Scenario: Missing or corrupt runtime fails fast with the repair command

- **GIVEN** the runtime is missing, has the wrong version, or lacks `dist/proxy.js`
- **WHEN** the wrapper starts
- **THEN** it exits non-zero within seconds with a message equivalent to `MCP bridge runtime is not ready. Run: npx -y nsolid-plugin setup --harness <harness>`
- **AND** the message names the harness that launched the wrapper (claude, codex or antigravity)

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

#### Scenario: Doctor reflects bridge health per harness

- **GIVEN** doctor runs for a wrapper-owned harness configuration (native plugin installed for claude, codex or antigravity)
- **WHEN** the runtime is missing or invalid
- **THEN** doctor reports `healthy: false` and recommends `nsolid-plugin setup --harness <harness>`
- **AND** for opencode/pi (and native-HTTP direct installs) the bridge status is informational only and does not affect health
- **AND** a ready proxy is never reported as proof that the remote MCP endpoint is reachable

### Requirement: Native MCP OAuth is out of scope

The plugin SHALL keep the Accounts OAuth flow and the service-token headers
unchanged by this change.

#### Scenario: No confusion between Accounts OAuth and native MCP OAuth

- **GIVEN** the current wrapper authenticates MCP traffic with `X-Nsolid-*` headers minted from the NodeSource Accounts OAuth flow
- **WHEN** this change ships
- **THEN** that mechanism is preserved unchanged
- **AND** migrating to native MCP-transport OAuth remains documented as deferred technical debt (`docs/technical-debt/native-mcp-oauth.md`), not implemented here
