import type { HarnessType } from '../types.js'

export type UpdateTarget = 'cli' | HarnessType

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
  /** All detected copies when one logical target spans multiple caches/scopes. */
  currentVersions?: readonly (string | undefined)[]
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
    revision?: string
    commit?: string
    contentDigest?: string
    manifestPath: string
  }
  | {
    kind: 'local-snapshot'
    root: string
    manifestPath: string
    freshness: 'verified' | 'stale' | 'unknown'
    contentDigest?: string
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
  /** Planner-only local path; never render this in public output. */
  tarballPath?: string
  tempDirectory?: string
  contentDigest?: string
}

export interface GitArtifactIdentity {
  kind: 'git'
  repository: string
  commit: string
  contentDigest: string
  /** Repo-relative POSIX subdirectory holding the installable payload ('' = repository root). */
  payloadPath?: string
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
  /** Shared secret authenticating the child transaction (never authorizing restores). */
  nonce?: string
  ownedSkillPaths: readonly string[]
  ownedLinkPaths: readonly string[]
  ownedMcpFields: readonly {
    configPath: string
    server: string
    field: string
    expectedDigest: string
  }[]
  /** Union of tracked MCP config paths and the adapter canonical path, fixed at planning. */
  ownedMcpConfigPaths: readonly string[]
  /** Canonical roots under which the new bundle's skills/links may be created; the child may only journal new destinations directly inside one of these roots. */
  approvedDestinationRoots: readonly string[]
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
  | ({ kind: 'pi-package'; spec: 'npm:nsolid-pi-plugin' } & PiPackageLocation)
  | {
    kind: 'unsupported'
    source: string
    reason: 'local' | 'git' | 'pinned' | 'ambiguous' | 'conflicting' | 'untracked' | 'unsupported-manager'
  }
  | {
    kind: 'antigravity-git'
    url: 'https://github.com/NodeSource/nsolid-plugin.git'
    layout: AntigravityLayout
  }
  | { kind: 'fallback'; bundleVersion?: string; executor?: FallbackPackageExecutor }

/** Exact byte evidence binding a native record to its planned content. */
export interface NativeEvidence {
  path: string
  digest: string
}

/** Additional read-only evidence used by strategies. It never reaches CLI output verbatim. */
export interface UpdateInstallationMetadata {
  /** Exact native configuration path approved during planning. */
  configPath?: string
  packageRoot?: string
  packagePath?: string
  previousVersion?: string
  rollbackCommand?: string
  trackedSkills?: readonly { name: string; path: string }[]
  trackedMcpConfigPath?: string
  trackedMcpNames?: readonly string[]
  trackedMcpFields?: readonly {
    configPath: string
    server: string
    field: string
    expectedDigest: string
  }[]
  trackedMcpOwnershipComplete?: boolean
  projectRoot?: string
  packageRoots?: readonly string[]
  packageRootIdentities?: readonly string[]
  pluginRoot?: string
  manifestPath?: string
  packageManagerExecutable?: ExecutableIdentity
  projectRootIdentity?: string
  settingsPaths?: readonly string[]
  settingsDigests?: readonly string[]
  sourceEntries?: readonly string[]
  cacheDigests?: readonly string[]
  packageEvidencePaths?: readonly string[]
  packageEvidenceDigests?: readonly string[]
  /** Native marketplace records whose exact bytes must still match at execution. */
  nativeEvidence?: readonly NativeEvidence[]
}

export interface UpdateInstallation {
  installationId: string
  target: UpdateTarget
  ownership: UpdateOwnership
  installed: boolean
  source: UpdateSource
  version: VersionInfo
  inventoryError?: UpdateError
  metadata?: UpdateInstallationMetadata
  artifact?: ResolvedArtifactIdentity
  fallbackTransaction?: FallbackTransactionIdentity
}

export interface UpdateOptions {
  harness?: HarnessType
  all?: boolean
  check?: boolean
  yes?: boolean
  json?: boolean
  verbose?: boolean
  noColor?: boolean
  cwd?: string
  packageRoot?: string
  /** Explicit npm registry for the update lookup and execution plan. */
  registry?: string
  fetchImpl?: typeof fetch
  commandRunner?: CommandRunner
  confirm?: UpdateConfirmation
}

export interface CommandSpec {
  executable: string
  /** Frozen identity evidence revalidated immediately before spawn. */
  executableIdentity?: ExecutableIdentity
  args: readonly string[]
  cwd?: string
  env?: Readonly<Record<string, string>>
  timeoutMs: number
}

/**
 * How a command step is actually spawned on the host. `shell: true` and
 * launching through `cmd.exe` are never used; on Windows a validated npm
 * shim is derived to a JS entrypoint and run with `process.execPath`.
 */
export type ExecutableIdentity =
  | { kind: 'native'; executable: string }
  | {
    kind: 'node'
    executable: string
    entrypoint: string
  }
  | {
    kind: 'unsupported'
    reason: 'not-found' | 'powershell-only' | 'unverifiable-shim'
  }

export interface CommandResult {
  exitCode: number | null
  signal?: NodeJS.Signals
  /** OS error raised before the child process started, for example ENOENT. */
  spawnErrorCode?: string
  stdout: string
  stderr: string
  timedOut: boolean
  /**
   * When a timeout occurred, whether the whole descendant process tree was
   * terminated before the caller proceeds to rollback. `true` for a clean
   * non-timeout run. Callers must treat a timed-out run with
   * `treeTerminated === false` as requiring deferral/recovery, never restoring
   * concurrently with a possibly-live child.
   */
  treeTerminated?: boolean
}

export interface CommandRunner {
  run(spec: CommandSpec): Promise<CommandResult>
}

export type { ExecutableIdentity as ResolvedExecutable }

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
  steps: readonly UpdatePlanStep[]
  rollbackSteps: readonly UpdatePlanStep[]
  planningError?: UpdateError
  requiresConfirmation: boolean
  restartHint?: string
  manualCommands?: readonly string[]
  metadata?: UpdateInstallationMetadata
  artifact?: ResolvedArtifactIdentity
  fallbackTransaction?: FallbackTransactionIdentity
  /** Temporary directories this plan item's process created (for example a manifest staging dir); removal must only ever target these. */
  temporaryDirectories?: readonly string[]
}

export interface UpdatePlan {
  checkOnly: boolean
  items: readonly UpdatePlanItem[]
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
  manualCommands?: readonly string[]
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

export interface VersionLookupResult {
  version?: string
  error?: UpdateError
  artifact?: ResolvedArtifactIdentity
}
