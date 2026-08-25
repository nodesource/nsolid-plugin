export { checkUpdates, executeUpdatePlan, planUpdates, summarizePlan, summarizeResults, update } from './coordinator.js'
export { createCommandRunner, findExecutable, isCommandSuccessful, runCommand, sanitizeOutput } from './command-runner.js'
export { detectAntigravityLayout, detectInstallations, detectCliInstallation } from './inventory.js'
export { commitFallbackJournal, fallbackJournalPath, recoverFallbackJournal, trackingDigest, valueDigest } from './fallback-journal.js'
export { refreshOwnedInstallation } from './fallback-transaction.js'
export type { FallbackJournal, FallbackJournalPhase } from './fallback-journal.js'
export type { FallbackRefreshOptions, FallbackRefreshResult } from './fallback-transaction.js'
export { compareVersions, classifyVersionSet, classifyVersions, isStableVersion, parseStableVersion, readPackageVersion, readRunningVersionInfo, resolvePackageRoot } from './version.js'
export { cleanupNpmArtifact, downloadNpmArtifact, resolveFixedGitBundleVersion, resolveMarketplaceVersion, resolveRegistryArtifactVersion, resolveRegistryVersion, sanitizeRepository } from './version-source.js'
export type {
  AntigravityLayout,
  ClaudePluginScope,
  CommandResult,
  CommandRunner,
  CommandSpec,
  FallbackPackageExecutor,
  MarketplaceVersionSource,
  NpmArtifactIdentity,
  GitArtifactIdentity,
  LocalArtifactIdentity,
  ResolvedArtifactIdentity,
  FallbackTransactionIdentity,
  PiPackageLocation,
  RunningVersionInfo,
  UpdateConfirmation,
  UpdateConfirmationContext,
  UpdateContext,
  UpdateError,
  UpdateInstallation,
  UpdateInstallationMetadata,
  UpdateOptions,
  UpdateOwnership,
  UpdatePlan,
  UpdatePlanItem,
  UpdatePlanStep,
  UpdateResult,
  UpdateSource,
  UpdateStatus,
  UpdateStrategy,
  UpdateSummary,
  UpdateTarget,
  VersionInfo,
  VersionLookupResult,
  VersionStatus,
} from './types.js'
