# Design

## Architecture

The update feature is additive to the existing CLI and installer architecture. It does not move installation ownership into the shared CLI: each native harness remains responsible for its own staged plugin, Pi remains package-owned, and initial OpenCode/fallback installs continue through the existing public installer while update-only reconciliation uses the package-internal refresh entrypoint.

The CLI adds an update coordinator that separates four concerns:

1. inventory: determine what is installed and how it is owned;
2. discovery: resolve local and latest versions without mutation;
3. planning: produce deterministic, reviewable update actions; and
4. execution: run approved actions through typed strategies and summarize results.

```text
packages/core/src/cli.ts
          |
          v
packages/core/src/update/coordinator.ts
    |            |             |
    v            v             v
 inventory   version sources   target strategies
    |            |             |
    +------------+-------------+
                 |
                 v
       sanitized UpdateSummary
```

The coordinator never performs OAuth. Existing setup/auth modules are outside the update dependency graph.

Release preparation is a separate maintainer-side script. Runtime update code reads version metadata but never edits repository release files.

## Module Boundaries

### Runtime update modules

`packages/core/src/update/types.ts`

- Defines target, plan, result, summary, version, and error contracts.
- Contains no filesystem, network, or process behavior.

`packages/core/src/update/coordinator.ts`

- Resolves requested scope (`cli`, one harness, or all detected targets).
- Produces one synthetic `ownership: 'none'` item only when an explicitly requested harness has no detected installation.
- Produces the plan before mutation.
- Applies confirmation rules.
- Executes targets sequentially and isolates per-target failures.
- Owns overall exit/result semantics, not target-specific commands.

`packages/core/src/update/inventory.ts`

- Reuses harness adapters and tracking readers to return one installation record per detected native, fallback, or package-owned installation; native and fallback records for the same harness are not collapsed.
- Reads the running CLI/package metadata.
- Carries validated source identity (Claude plugin ID/marketplace/scope/version source, Codex plugin ID/marketplace/version source, Antigravity layout, effective Pi source/scopes, or fallback provenance/executor) into each plan item without changing existing installation detection contracts.
- Treats local, pinned, ambiguous, or otherwise unsupported update sources as `unsupported` instead of substituting a different source.

`packages/core/src/update/version-source.ts`

- Reads and validates `latest` metadata from the detected npm registry for `nsolid-plugin` and `nsolid-pi-plugin`, retaining the normalized registry origin, exact tarball URL, version, and registry-provided integrity digest as one immutable artifact identity.
- Resolves every supported Git marketplace ref to a full commit object ID before planning, reads the manifest and content digest from that commit, and carries the repository, commit, relative manifest path, and digest together. A missing revision, mutable ref that cannot be resolved, or source that cannot bind lookup and execution to that commit is `unsupported`.
- Resolves the canonical GitHub-root Antigravity source to a full commit and reads `bundle.json` from that commit; a moving default branch is never the executable identity.
- Applies bounded request timeouts and semantic-version validation.
- Returns `unknown` rather than treating missing, local-stale, ambiguous, or unsupported marketplace version evidence as current; native execution may still use the preserved harness-owned ID when its identity is unambiguous.

`packages/core/src/update/package-manager.ts`

- Detects npm or pnpm only when the real CLI package/entrypoint is contained by that manager's reported global root and the corresponding executable is available; a shim or package-manager environment variable alone is not sufficient evidence.
- Resolves the manager executable into exactly one supported `ExecutableIdentity` (below): on a non-Windows host a shell-free native/JS entrypoint; on Windows a validated native `.exe`/`.com` or a derived immutable JS entrypoint executed with `process.execPath` and `shell: false`. A bare `npm`/`pnpm` launcher name is never passed to `spawn` with `shell: false`.
- Produces a fixed executable plus argument array.
- Downloads only the planned tarball from the planned registry, verifies its integrity before execution, and gives npm/pnpm the verified local tarball rather than re-resolving `name@version` through ambient registry configuration.
- Verifies post-update package identity against the planned name, version, registry provenance, and integrity/content digest rather than accepting version equality alone.
- Returns unsupported for workspaces, `npx`, local checkouts, Volta/Yarn/Bun ownership, mismatched global roots, and ambiguous launchers.

`packages/core/src/update/command-runner.ts`

- Wraps `spawn`/`spawnSync` with `shell: false` and an immutable `ExecutableIdentity`. `shell: true` and launching through `cmd.exe` are never used.
- `ExecutableIdentity` is one of: a validated absolute native executable (`.exe`/`.com` on Windows), `process.execPath` plus an absolute, existence/content-verified JS entrypoint, or a Windows shim that is validated to be npm-generated and from which an immutable absolute JS entrypoint is derived and then executed with `process.execPath` under `shell: false`. A `.cmd`/`.bat` shim whose format or target cannot be verified, and any `.ps1`-only launcher, resolve to `unsupported` with manual guidance.
- Resolves executable/entrypoint paths over `PATH`/`Path` case-insensitively (respecting the Windows `Path` casing), honours `PATHEXT`, ignores empty and cwd-relative path segments, returns an absolute path plus identity evidence, and revalidates that identity immediately before `spawn`.
- Accepts executable and argument arrays, controlled environment additions, timeout, and output mode.
- Confirms the termination of the whole descendant process tree before any rollback runs. On Windows it uses controlled tree termination; when termination cannot be confirmed it leaves the journal recoverable (or defers rollback) rather than restoring concurrently.
- Redacts tokens, authorization headers, and credential paths from captured diagnostics.
- Is injected in unit tests so no real package manager or harness command runs there; targeted platform integration tests exercise the real resolver/spawn boundary with controlled fixture executables and shims.

`packages/core/src/update/path-normalize.ts`

- Provides the single shared path normalization used consistently by planning, tracking digests, plan display, manifests, execution, and rollback: `path.resolve`, platform separators, and Windows drive/root and case-insensitive semantics.
- Never applies a universal `toLowerCase` to paths that may live on case-sensitive directories; equivalence for Windows compares drive/root and raw segments case-insensitively only where case-insensitive semantics are proven.
- Rejects UNC or remote paths up front when their equivalence to local owned paths cannot be guaranteed.

`packages/core/src/update/fs-transaction.ts`

- Records each owned path kind via `lstat` as `junction`, `copy`, or `directory` before acting and, on Windows, never dereferences a junction to determine ownership or to delete it.
- Creates staging and backup targets as siblings on the same volume as each target so `rename`-into-place stays on one volume.
- Requires the destination to be absent (or already owned-and-backed-up) before `rename`-into-place.
- Applies bounded retries for `EPERM`, `EBUSY`, and `ENOTEMPTY` with revalidation between attempts and a non-mutating `unsupported`/failure path if the path identity drifts.
- Edits config and manifest files byte-preserving: CRLF line endings, comments, and unrelated entries are retained; mutation is verified by reloading and comparing only the owned slice.

`packages/core/src/update/strategies/*.ts`

- One strategy per ownership model: CLI package, Claude, Codex, Antigravity, Pi, and fallback.
- Strategies receive an immutable plan item and execution context.
- Strategies cannot broaden scope or switch from native to fallback ownership after failure.

`packages/core/src/update/codex-transaction.ts`

- Refreshes only the detected Git marketplace snapshot before touching the installed plugin; marketplace refresh is not treated as an installed-plugin update.
- Snapshots the exact `nsolid-plugin@<marketplace>` registration, prior enabled state, user-owned plugin fields, and cached installed payload before removal.
- Runs `codex plugin remove <detected-plugin-id>` followed by `codex plugin add <detected-plugin-id>` with fixed argument arrays.
- Validates that the reinstalled local version/content matches the refreshed marketplace entry, then reapplies the prior enabled state and preserves unrelated Codex configuration.
- Restores the saved registration and cached payload if removal succeeds but add or validation fails.

`packages/core/src/update/antigravity-transaction.ts`

- Resolves only the two documented global NodeSource layout pairs: shared Antigravity under `~/.gemini/config/` and AGY CLI under `~/.gemini/antigravity-cli/`.
- Creates a temporary backup before replacement at a sibling path selected by the shared `fs-transaction` rules on the same volume as the target, containing the detected staged root and the N|Solid entry in that root's matching `import_manifest.json`.
- Validates the newly staged root by checking `plugin.json`, `bundle.json`, canonical skill presence, and source registration in the import manifest.
- Restores both the staged root and the saved manifest entry if reinstall or validation fails, preserving unrelated manifest imports and retrying bounded `EPERM`/`EBUSY`/`ENOTEMPTY` with revalidation before any restore is declared failed.
- Edits `import_manifest.json` byte-preserving (CRLF, comments, unrelated imports retained) and verifies the owned slice after mutation.

`packages/core/src/update/fallback-transaction.ts`

- Resolves one available package executor (`npm exec` preferred, otherwise `pnpm dlx`), verifies the planned `nsolid-plugin` tarball integrity, and runs that verified local artifact from a restrictive temporary working directory so workspace binaries/configuration cannot shadow the payload.
- Before launching the child, the parent creates and fsyncs a durable journal plus complete snapshot of the selected installation's tracked skill directories, affected MCP fields, links, and tracking state. The journal records `prepared`, `mutating`, and `committed` phases and remains recoverable if the package executor or child times out, crashes, or is killed. Durability (fsync) is stated separately from confidentiality: the journal lives under a private user-owned root and staging sits beside the target; no `chmod 0600` ACL guarantee is promised where Windows ACLs are not controlled.
- Invokes the exact package's dedicated internal `nsolid-plugin-refresh-owned` binary with a parent-created transaction manifest. The manifest binds `installationId`, harness, canonical owned paths, tracking-file path and digest, and field-level MCP ownership; the regular `nsolid-plugin install` command and programmatic `install()` contract are not changed.
- The child validates that the live tracking digest, installation identity, canonical paths, and MCP fields still equal the approved manifest before mutation. It refuses stale, sibling, broadened, or ambiguous identity rather than rediscovering a target from `--harness` alone.
- Reconciles the installed asset set against the new bundle: complete skill directories are replaced, previously tracked skills absent from the new bundle are removed, and untracked/user-owned paths and unrelated MCP entries are preserved. Junctions are recorded via `lstat` and never dereferenced for ownership or deletion.
- On failure the parent first confirms the descendant process tree is terminated, then restores its snapshot; it never restores concurrently with a possibly-live child. When tree termination cannot be confirmed, the parent leaves the journal recoverable/deferred rather than restoring partially.
- Updates `bundleVersion` only after the new skills, MCP entries, and tracking data validate. The parent marks the journal committed and removes it only after post-update validation; otherwise it restores its snapshot independently of child-process availability.
- On every later update invocation, the parent recovers or reports any non-committed journal before planning new mutation.
- Treats direct artifacts without sufficient tracking ownership as `unsupported` rather than deleting paths by name or prefix.

### Existing modules extended

`packages/core/src/cli.ts`

- Adds `version` and `update` cases, with bare `--version` as an alias for human-readable version reporting.
- Adds `--check` and `--all`.
- Rejects `--all` with `--harness` before calling the coordinator.
- Keeps JSON on stdout and progress/diagnostics on stderr.

`packages/core/src/update/refresh-owned-cli.ts`

- Implements the package-internal `nsolid-plugin-refresh-owned` binary used by an older updater to execute the exact published bundle's fallback transaction.
- Is not listed as a public user workflow and refuses absent, ambiguous, or untracked ownership; it never authenticates or broadens the requested harness.
- Leaves the existing `nsolid-plugin install` command and public `install()` behavior unchanged.

`packages/core/src/index.ts`

- Exports synchronous, read-only `getVersionInfo(): RunningVersionInfo` plus asynchronous `checkUpdates()` and `update()` functions and their public types.
- Existing setup/install/uninstall APIs remain unchanged.

`packages/core/src/harnesses/`

- Native detection may expose optional installed version and staged root.
- Existing adapter methods keep their signatures; additive optional methods or helper functions are preferred.

`packages/core/src/skills/skill-tracker.ts`

- Fallback tracking adds an optional `bundleVersion`, canonical per-installation skill/link paths, and MCP ownership evidence per JSON field/value so shared paths and user-modified fields cannot be claimed by name alone.
- Readers accept legacy tracking for reporting, but automatic mutation is `unsupported` until the selected installation has complete per-path and field-level ownership evidence; compatibility never authorizes a name-only write or deletion.
- Tracking paths and digests use the shared `path-normalize` so plan, manifest, execution, and rollback compare identical normalized identities.

### Release modules

`scripts/prepare-release.mjs`

- Accepts `patch`, `minor`, `major`, or an explicit greater semantic version.
- Treats root `bundle.json.version` as the canonical current release version.
- Snapshots every controlled file before mutation.
- Updates source version files, runs existing bundle/root generators, validates results, and restores snapshots on failure.
- Never invokes Git mutation, pack, publish, or registry authentication.

`scripts/check-release-version.mjs`

- Compares package and generated versions with the root bundle.
- Calls/reuses existing bundle and root-manifest checks.
- Activates release mode only when invoked through `pnpm release:check --release`.
- In release mode, compares the explicit published-payload allowlist from the Release Versioning specification with the highest eligible local semantic-version tag whose peeled commit is an ancestor of `HEAD`, and rejects an unchanged version.
- Accepts exactly `X.Y.Z` and `vX.Y.Z` tag names, handles lightweight and annotated tags by peeling to commits, ignores non-semantic and non-ancestor tags, and fails explicitly for missing/malformed-only tags, ambiguous duplicate versions, or shallow history that prevents proving ancestry.

Root package scripts:

```json
{
  "release:prepare": "node scripts/prepare-release.mjs",
  "release:check": "node scripts/check-release-version.mjs"
}
```

The private root package version remains `0.0.0`.

## Interfaces and Contracts

```typescript
import type { HarnessType } from '../types.js'

export type UpdateTarget =
  | 'cli'
  | 'claude'
  | 'codex'
  | 'opencode'
  | 'antigravity'
  | 'pi'

export type UpdateOwnership =
  | 'global-package'
  | 'native-plugin'
  | 'package-owned'
  | 'fallback'
  | 'none'

export type VersionStatus =
  | 'current'
  | 'update-available'
  | 'newer-than-registry'
  | 'unknown'

export type UpdateStatus =
  | 'current'
  | 'update-available'
  | 'newer-than-registry'
  | 'updated'
  | 'skipped'
  | 'not-installed'
  | 'unsupported'
  | 'unknown'
  | 'failed'

export interface VersionInfo {
  current?: string
  latest?: string
  status: VersionStatus
}

export interface RunningVersionInfo {
  cliVersion: string
  bundleVersion: string
}

export type ClaudePluginScope = 'user' | 'project' | 'local' | 'managed'

export type MarketplaceVersionSource =
  | {
      kind: 'git'
      repository: string
      revision: string
      commit: string
      manifestPath: string
      contentDigest: string
    }
  | {
      kind: 'local-snapshot'
      root: string
      manifestPath: string
      freshness: 'verified' | 'stale' | 'unknown'
      contentDigest: string
    }
  | {
      kind: 'unknown'
      reason: 'missing-metadata' | 'ambiguous' | 'unsupported'
    }

export type PiPackageLocation =
  | { scopes: readonly ['user'] }
  | { scopes: readonly ['project']; projectRoot: string }
  | { scopes: readonly ['user', 'project']; projectRoot: string }

export type FallbackPackageExecutor = 'npm-exec' | 'pnpm-dlx'

export interface NpmArtifactIdentity {
  kind: 'npm'
  packageName: 'nsolid-plugin' | 'nsolid-pi-plugin'
  version: string
  registry: string
  tarball: string
  integrity: string
}

export interface GitArtifactIdentity {
  kind: 'git'
  repository: string
  commit: string
  contentDigest: string
}

export interface LocalArtifactIdentity {
  kind: 'local-snapshot'
  root: string
  contentDigest: string
}

export type ResolvedArtifactIdentity = NpmArtifactIdentity | GitArtifactIdentity | LocalArtifactIdentity

export interface FallbackTransactionIdentity {
  installationId: string
  harness: HarnessType
  trackingPath: string
  trackingDigest: string
  ownedSkillPaths: readonly string[]
  ownedLinkPaths: readonly string[]
  ownedMcpFields: readonly {
    configPath: string
    server: string
    field: string
    expectedDigest: string
  }[]
}

export type AntigravityLayout =
  | {
      kind: 'shared'
      pluginRoot: '~/.gemini/config/plugins/nsolid-plugin'
      manifestPath: '~/.gemini/config/import_manifest.json'
    }
  | {
      kind: 'agy-cli'
      pluginRoot: '~/.gemini/antigravity-cli/plugins/nsolid-plugin'
      manifestPath: '~/.gemini/antigravity-cli/import_manifest.json'
    }

export type UpdateSource =
  | { kind: 'none' }
  | { kind: 'global-package'; packageManager: 'npm' | 'pnpm'; packageName: 'nsolid-plugin' }
  | {
      kind: 'claude-marketplace'
      pluginId: string
      marketplace: string
      scope: ClaudePluginScope
      versionSource: MarketplaceVersionSource
    }
  | {
      kind: 'codex-marketplace'
      pluginId: string
      marketplace: string
      versionSource: MarketplaceVersionSource
    }
  | ({
      kind: 'pi-package'
      spec: 'npm:nsolid-pi-plugin'
    } & PiPackageLocation)
  | {
      kind: 'unsupported'
      source: string
      reason: 'local' | 'git' | 'pinned' | 'ambiguous' | 'conflicting' | 'untracked' | 'unsupported-manager'
    }
  | { kind: 'antigravity-git'; url: 'https://github.com/NodeSource/nsolid-plugin.git'; layout: AntigravityLayout }
  | { kind: 'fallback'; bundleVersion?: string; executor?: FallbackPackageExecutor }

export interface UpdateInstallation {
  installationId: string
  target: UpdateTarget
  ownership: UpdateOwnership
  installed: boolean
  source: UpdateSource
  version: VersionInfo
}

export interface UpdateOptions {
  harness?: HarnessType
  all?: boolean
  check?: boolean
  yes?: boolean
  json?: boolean
  verbose?: boolean
  noColor?: boolean
  commandRunner?: CommandRunner
  confirm?: UpdateConfirmation
}

export type UpdatePlanStep =
  | {
      kind: 'command'
      description: string
      command: CommandSpec
    }
  | {
      kind: 'filesystem'
      description: string
      operation: 'backup' | 'replace' | 'reconcile' | 'restore' | 'cleanup'
      paths: readonly string[]
    }
  | {
      kind: 'validation'
      description: string
      checks: readonly string[]
    }

export interface UpdateError {
  code: string
  message: string
}

export interface UpdatePlanItem {
  installationId: string
  target: UpdateTarget
  ownership: UpdateOwnership
  installed: boolean
  source: UpdateSource
  version: VersionInfo
  artifact?: ResolvedArtifactIdentity
  fallbackTransaction?: FallbackTransactionIdentity
  steps: readonly UpdatePlanStep[]
  rollbackSteps: readonly UpdatePlanStep[]
  planningError?: UpdateError
  requiresConfirmation: boolean
  restartHint?: string
}

export interface UpdateConfirmationContext {
  items: readonly UpdatePlanItem[]
}

export type UpdateConfirmation = (
  context: UpdateConfirmationContext
) => boolean | Promise<boolean>

export interface UpdateResult {
  installationId: string
  target: UpdateTarget
  ownership: UpdateOwnership
  status: UpdateStatus
  currentVersion?: string
  latestVersion?: string
  resultingVersion?: string
  changed: boolean
  restartHint?: string
  rollbackCommand?: string
  rollback?: {
    attempted: boolean
    succeeded?: boolean
  }
  error?: UpdateError
}

export interface UpdateSummary {
  checkOnly: boolean
  results: UpdateResult[]
  counts: Record<UpdateStatus, number>
  success: boolean
  exitCode: 0 | 1 | 2
}

export interface CommandSpec {
  executable: string
  args: readonly string[]
  cwd?: string
  env?: Readonly<Record<string, string>>
  timeoutMs: number
}

export interface CommandResult {
  exitCode: number | null
  signal?: NodeJS.Signals
  stdout: string
  stderr: string
  timedOut: boolean
}

export interface CommandRunner {
  run(spec: CommandSpec): Promise<CommandResult>
}

export interface UpdateContext {
  options: Readonly<UpdateOptions>
  commandRunner: CommandRunner
}

export interface UpdateStrategy {
  readonly target: UpdateTarget
  readonly ownership: UpdateOwnership
  plan(installation: UpdateInstallation, context: UpdateContext): Promise<UpdatePlanItem>
  execute(item: UpdatePlanItem, context: UpdateContext): Promise<UpdateResult>
}
```

Rules enforced by these contracts:

- `check` stops after planning/version resolution and never calls `execute`.
- Every command, filesystem mutation, validation, and rollback action is represented as an ordered plan step before confirmation; strategies cannot introduce an undisclosed external command during execution.
- A lookup or validation failure produces a plan item with sanitized `planningError`, empty execute/rollback steps, and `requiresConfirmation: false`. The coordinator converts it to a `failed` result without calling `execute`, while independent items remain executable.
- Command arguments are arrays; a shell command string is not part of the contract. The formatter redacts sensitive environment values and source credentials when displaying a plan.
- `error.message` is sanitized and suitable for JSON output.
- An absent version is represented as `unknown`, never coerced to `current`.
- A detected installation source that cannot be updated safely is represented as `unsupported`, never replaced with a different source.
- `ownership: 'none'` with `source.kind: 'none'` is reserved for the synthetic, non-mutating plan/result produced when an explicitly requested harness has no detected installation. It has empty execute/rollback steps, requires no confirmation, and is never emitted as a detected target under `--all`.
- Marketplace version resolution uses only the `versionSource` carried by the detected Claude or Codex registration. An unknown or stale local source yields `unknown`; it never falls back to the NodeSource marketplace.
- A mutating plan that depends on Git carries a full immutable commit and content digest; a plan that depends on npm carries registry, tarball, version, and integrity; and a verified local snapshot carries its canonical root and content digest. Execution and post-update validation use that same `artifact` identity and never re-resolve a mutable ref, dist-tag, package name/version, ambient registry, or changed snapshot.
- A project-scoped Pi command has `cwd` equal to the canonical captured `projectRoot`. Immediately before execution the strategy revalidates that directory identity, effective `.pi/settings.json` entry, scopes, source, and cache roots still match the approved plan; drift produces a non-mutating failure.
- A fallback child receives and validates the exact `fallbackTransaction` manifest approved by the parent. Harness-only rediscovery is not an executable identity.
- Strategies return data; the CLI formatter owns human-readable output.
- A completed check whose result is `current`, `update-available`, `newer-than-registry`, `unsupported`, or evidence-only `unknown` is informational and exits `0`. A timeout, invalid response, or other operational lookup/validation failure is `failed` and exits `1`.
- A mutating update with `newer-than-registry` performs no downgrade and exits `0`; a mutating `unsupported` result exits `2` with manual guidance.
- A declined plan produces `skipped` results and exits zero.
- Exit code `0` means a completed update/check or an intentional informational no-op. Exit code `1` means an operational lookup, planning, execution, validation, rollback, or recovery failure. Exit code `2` means the requested mutation was unavailable without operational failure because approval was missing or the result was `not-installed`, `unsupported`, or mutation-blocking `unknown`. In aggregate results, code `1` takes precedence over code `2`.
- A read-only check with `not-installed`, `unsupported`, or evidence-only `unknown` exits `0`. A mutating invocation with any such unavailable result exits `2` unless another item failed and requires exit `1`.
- An empty `--all` inventory is an explicit successful no-op: it exits `0`, emits `results: []` and zero counts in JSON, and reports that no targets were detected in human output.

### Fixed harness command plans

| Target | Native/package action | Success guidance |
|---|---|---|
| CLI npm/pnpm | verify the planned tarball integrity, then run the manager through its resolved `ExecutableIdentity` (native `.exe`/`.com`, or `process.execPath` + verified JS entrypoint; a bare `npm`/`pnpm` name or unverified `.cmd`/`.bat`/`.ps1` shim is never spawned) with `--global` on the verified local tarball | invoke CLI again |
| Claude | `claude plugin update <detected-plugin-id> --scope <detected-scope>` | `/reload-plugins` or restart |
| Codex | `codex plugin marketplace upgrade <detected-marketplace>`, then `codex plugin remove <detected-plugin-id>` and `codex plugin add <detected-plugin-id>` | start a new session |
| Antigravity | `agy plugin uninstall nsolid-plugin`, then install the canonical repository pinned to the planned full commit | restart AGY |
| Pi user-only | `pi update npm:nsolid-pi-plugin --no-approve` | `/reload` or restart |
| Pi with detected project scope | `pi update npm:nsolid-pi-plugin --approve` after the project root is disclosed and approved | `/reload` or restart |
| Fallback/OpenCode through npm | execute `nsolid-plugin-refresh-owned --transaction <parent-manifest>` from the integrity-verified local npm tarball | restart harness if needed |
| Fallback/OpenCode through pnpm | execute `nsolid-plugin-refresh-owned --transaction <parent-manifest>` from the integrity-verified local pnpm tarball | restart harness if needed |

Marketplace IDs, Claude scopes, package versions, Pi scopes, and package sources are passed as separate arguments only after strict validation. A native ID is accepted only when it matches `nsolid-plugin@[A-Za-z0-9][A-Za-z0-9._-]*`; the base name alone, malformed IDs, control characters, whitespace, ambiguous matches, and a Claude installation whose scope cannot be determined return `unsupported`. Marketplace inventory also carries the exact repository/ref and relative manifest path, or the exact local snapshot path and freshness evidence, used for version resolution. Repository credentials are stripped before data reaches plan or result output; traversal-capable manifest paths and ambiguous source metadata return `unknown` or `unsupported` without canonical-source substitution. The only supported Pi identity is the exact unpinned `npm:nsolid-pi-plugin`. Inventory coalesces canonical user/project entries into one Pi target because one `pi update <source>` invocation updates every matching identity; the discriminated location requires `projectRoot` whenever project scope is present. Any local, Git, pinned, conflicting, or ambiguous matching entry returns `unsupported` for the whole target rather than producing a misleading partial success. No user-derived string is interpolated into an executable shell command.

The planner emits one item per `UpdateInstallation`. If a harness has both native and fallback artifacts, both items remain visible and are updated independently; a native failure never switches to fallback ownership.

The CLI registry lookup resolves the `latest` dist-tag once from the effective registry, validates it as a stable semantic version, and stores registry origin, exact tarball URL, version, and integrity in the immutable plan. Execution never sends `@latest` or `name@version` back to a package manager: it downloads the planned tarball, verifies integrity, and installs that verified local artifact. Success requires both a zero child exit and on-disk package evidence whose name, version, and content digest match the planned artifact. A failed or mismatched result returns the exact previous-artifact guidance for the same manager.

Pi source detection reads both user and current-project settings, including object-form entries and filters. User and project entries for the same unpinned npm package become one command target. A user-only target passes `--no-approve` so an unrelated current directory cannot broaden the operation. A detected project target records the canonical project root and directory identity, displays it, and sets the command `cwd` to that exact root. Immediately before invoking `pi update`, the strategy re-reads the effective user/project entries, scopes, source, and cache roots and refuses mutation if they differ from the approved plan. It passes `--approve` only after this revalidation and plan approval. Because `pi update <source>` does not accept a target version, the planned registry artifact is a minimum postcondition; every affected cache must retain provenance for that registry and integrity/content evidence for the resulting package, including a newer valid publication observed during execution.

OpenCode supports native skills and a separate npm/local plugin system, but the current N|Solid distribution is not registered as an OpenCode plugin. Its owner is therefore the tracked direct installer at `~/.config/opencode/skills/` plus the merged `mcp` entries in `opencode.json(c)`. The updater must not invoke `opencode plugin`. It invokes the exact published N|Solid CLI package's internal `nsolid-plugin-refresh-owned` binary as the payload provider and transaction executor. The existing public `install` flow keeps its idempotent copy/merge semantics and does not acquire stale-asset removal behavior.

The Codex marketplace command refreshes only the configured Git marketplace snapshot. It is therefore a discovery prerequisite, not an installed-plugin update. The strategy must use the detected complete plugin ID for both `remove` and `add`, preserve the prior registration/enablement and cached payload transactionally, and validate the resulting local version against the refreshed marketplace entry.

Command semantics were verified on 2026-08-03 against the official harness documentation:

- Claude documents `claude plugin update <plugin> --scope <scope>` and version-keyed installed caches: <https://code.claude.com/docs/en/plugins-reference#plugin-update>.
- Codex documents marketplace upgrade as refreshing Git marketplace snapshots and exposes plugin install/remove as separate operations: <https://learn.chatgpt.com/docs/developer-commands#codex-plugin-marketplace> and <https://learn.chatgpt.com/docs/app-server#api-overview>.
- Google documents AGY plugin management plus the update sequence as uninstalling the old plugin and installing the new source: <https://antigravity.google/docs/cli/plugins> and <https://docs.cloud.google.com/gemini/data-agents/querydata/sql-mysql/build-context-gemini-cli>.
- npm and pnpm document exact-version global installation through `npm install --global <pkg>@<version>` and `pnpm add --global <pkg>@<version>`: <https://docs.npmjs.com/cli/v11/commands/npm-install> and <https://pnpm.io/cli/add>.
- Pi documents `pi update <source>`, unpinned npm updates, separate user/project caches, project trust flags, and identity-based user/project deduplication: <https://pi.dev/docs/latest/packages> and <https://pi.dev/docs/latest/usage>.
- OpenCode documents global skills under `~/.config/opencode/skills/`; its npm/local plugin system is separate from those direct skill directories: <https://opencode.ai/docs/skills/> and <https://dev.opencode.ai/docs/plugins/>.
- npm and pnpm document exact package execution through `npm exec --package=<pkg>@<version>` and `pnpm dlx <pkg>@<version>`: <https://docs.npmjs.com/cli/v11/commands/npm-exec/> and <https://pnpm.io/cli/dlx>.

## Data Flow

### Check-only flow

```mermaid
sequenceDiagram
    participant User
    participant CLI
    participant Coordinator
    participant Inventory
    participant Registry

    User->>CLI: update [scope] --check
    CLI->>Coordinator: checkUpdates(options)
    Coordinator->>Inventory: detect installations, sources, and local versions
    Inventory-->>Coordinator: installation records
    Coordinator->>Registry: resolve latest versions
    Registry-->>Coordinator: validated versions or unknown/error
    Coordinator-->>CLI: UpdateSummary(checkOnly=true)
    CLI-->>User: human output or one JSON document
    Note over Coordinator: No strategy execute method is called
```

### Mutating update flow

```mermaid
sequenceDiagram
    participant User
    participant CLI
    participant Coordinator
    participant Strategy
    participant FS
    participant ExternalCLI

    User->>CLI: update [scope]
    CLI->>Coordinator: build plan
    Coordinator-->>CLI: ordered plan
    CLI-->>User: display plan and request confirmation
    User-->>CLI: confirm or --yes
    loop each installation, sequentially
        Coordinator->>Strategy: execute(planItem)
        loop each approved plan step, in order
            alt filesystem or validation step
                Strategy->>FS: declared operation and paths/checks
            else command step
                Strategy->>ExternalCLI: declared executable + fixed args
                ExternalCLI-->>Strategy: exit/status/output
            end
        end
        Strategy-->>Coordinator: sanitized UpdateResult
    end
    Coordinator-->>CLI: aggregate summary
    CLI-->>User: per-target result and restart guidance
```

CLI self-update is planned first, but the running process does not dynamically import the newly installed package. Remaining already-planned harness strategies execute from the current process. The user must invoke the CLI again to use new CLI code.

### Codex replacement transaction

```mermaid
sequenceDiagram
    participant Updater
    participant FS
    participant Codex

    Updater->>Codex: marketplace upgrade detected marketplace
    Codex-->>Updater: refreshed snapshot or failure
    Updater->>FS: snapshot plugin registration, enablement, and cached payload
    Updater->>Codex: plugin remove detected plugin ID
    Updater->>Codex: plugin add detected plugin ID
    alt add and local-version validation succeed
        Updater->>FS: restore prior enablement/user-owned fields and remove backup
    else remove, add, or validation fails
        Updater->>FS: restore prior registration and cached payload
        Updater-->>Updater: return failed + rollback status
    end
```

### Antigravity replacement transaction

```mermaid
sequenceDiagram
    participant Updater
    participant FS
    participant AGY

    Updater->>FS: locate one supported staged-root/manifest pair
    Updater->>FS: snapshot detected staged root and matching import entry
    Updater->>AGY: uninstall nsolid-plugin
    Updater->>AGY: install GitHub root
    alt install and validation succeed
        Updater->>FS: remove temporary backup after root + registration validation
    else install or validation fails
        Updater->>FS: restore staged root and import registration
        Updater-->>Updater: return failed + rollback status
    end
```

### Release preparation

```mermaid
sequenceDiagram
    participant Maintainer
    participant Prepare
    participant Files
    participant Generators
    participant Check

    Maintainer->>Prepare: release:prepare -- patch|minor|major|<semver>
    Prepare->>Files: read and snapshot controlled files
    Prepare->>Prepare: validate increasing semver
    Prepare->>Files: update three source versions
    Prepare->>Generators: bundle sync + root manifest generation
    Prepare->>Check: validate complete synchronization
    alt validation succeeds
        Prepare-->>Maintainer: version + changed-file summary
    else any stage fails
        Prepare->>Files: restore all snapshots
        Prepare-->>Maintainer: failing stage, non-zero exit
    end
```

## Error Handling and Safety

- Network lookups have explicit timeouts and schema validation.
- Missing executables use a distinct error code from command failure. Executables are resolved to an absolute, identity-verified target (see `command-runner`); resolution never trusts a bare name, cwd-relative, or unvalidated `.cmd`/`.bat`/`.ps1` shim.
- Timeouts confirm descendant-tree termination before rollback; on Windows, controlled tree termination is used and, when termination cannot be confirmed, rollback is deferred/left recoverable rather than restoring concurrently.
- Process output is bounded before being retained in results.
- Existing logger redaction is applied to verbose diagnostics.
- `--all` catches version-lookup, planning, and execution errors at the installation boundary and continues with independent installation records, including native and fallback records for the same harness.
- Confirmation is mandatory for mutable non-interactive operations unless `--yes` is present.
- Marketplace IDs and Claude scopes are validated before becoming arguments; local, pinned, conflicting, and ambiguous Pi sources are never silently replaced.
- CLI and fallback package execution uses the registry, tarball, and integrity identity from the plan; mutable dist-tags and ambient registry resolution are not used during mutation, and package-manager success without matching on-disk content evidence is a failure.
- Pi user-only updates pass `--no-approve`; `--approve` is used only when the immutable plan identifies, displays, executes within, and immediately revalidates a project-scoped canonical package root. Canonical entries across both scopes are updated once, while changed/conflicting/pinned entries block automatic mutation.
- Codex removes the installed plugin only after marketplace refresh and backup succeed. Rollback validates the restored registration and cached payload while preserving unrelated `config.toml` entries.
- Antigravity accepts only one unambiguous documented layout pair. Backups are staged beside the target on the same volume; `chmod`-based confidentiality is not promised on Windows (ACLs govern there). Rollback validates both the staged root and its matching saved import-manifest registration and retries bounded `EPERM`/`EBUSY`/`ENOTEMPTY` with revalidation.
- OpenCode/fallback replacement mutates only paths and MCP fields bound to the approved installation manifest. The parent-owned durable journal restores overwritten and stale-removed skill directories, config, and tracking after child failure, timeout, signal, or interrupted prior execution, but only after confirming the child's process tree has terminated.
- Update does not invoke setup, login, or auth modules.
- Release scripts snapshot only explicit controlled files; rollback never performs broad Git or recursive workspace resets. Release payload checking includes runtime source inputs that are compiled or copied into both published packages.
- A read-only `--check` performs no subprocess mutation: only read-only inventory, version resolution, planning, and formatting run.

## Migration Strategy

This is an additive migration.

1. Add pure types, semantic-version comparison, command runner, and version sources with unit tests.
2. Add inventory and target strategies behind programmatic APIs.
3. Add CLI parsing/formatting and integration tests.
4. Add release preparation/check scripts and fixture tests.
5. Extend fallback tracking with optional bundle version and path-level ownership, preserving reads of legacy tracking files, then add transactional direct-install reconciliation behind the package-internal update entrypoint without changing public install semantics.
6. Update README/package documentation.
7. Ship the feature in a new minor CLI release because it adds public commands; existing `1.0.x` install/setup behavior remains compatible.

Deployment order:

1. Merge version-bearing root manifests and update implementation.
2. Publish the new `nsolid-plugin` package.
3. Publish the same-version `nsolid-pi-plugin` package.
4. Push the matching semantic Git tag.
5. Verify update checks and actual updates from clean fixture homes for every harness.

The update command is useful immediately for future releases; the first release containing it is still installed through the existing manual npm/native update instructions.
