import type {
  UpdateError,
  UpdateInstallation,
  UpdatePlanItem,
  UpdatePlanStep,
  UpdateResult,
  UpdateStatus,
  VersionInfo,
} from '../types.js'
import { publicPlanSteps } from '../plan-projection.js'

export function planItem (
  installation: UpdateInstallation,
  steps: readonly UpdatePlanStep[] = [],
  rollbackSteps: readonly UpdatePlanStep[] = [],
  restartHint?: string,
  planningError?: UpdateError
): UpdatePlanItem {
  return {
    installationId: installation.installationId,
    target: installation.target,
    ownership: installation.ownership,
    installed: installation.installed,
    source: installation.source,
    version: installation.version,
    steps,
    rollbackSteps,
    planningError,
    requiresConfirmation: steps.length > 0 && !planningError,
    restartHint,
    metadata: installation.metadata,
    artifact: installation.artifact,
    fallbackTransaction: installation.fallbackTransaction,
  }
}

export function resultFromPlan (item: UpdatePlanItem, status: UpdateStatus, extra: Partial<UpdateResult> = {}): UpdateResult {
  return {
    installationId: item.installationId,
    target: item.target,
    ownership: item.ownership,
    status,
    currentVersion: item.version.current,
    latestVersion: item.version.latest,
    changed: status === 'updated',
    restartHint: item.restartHint,
    manualCommands: item.manualCommands,
    steps: publicPlanSteps(item.steps),
    // Always emitted with a stable shape so structured-output consumers see
    // one schema: a non-mutating result carries an explicitly empty change set.
    changes: item.changes ?? { skillsAdded: [], skillsRemoved: [], skillsUpdated: 0, mcpAdded: [], mcpRemoved: [], mcpUpdated: 0 },
    rollbackCommand: item.metadata?.rollbackCommand,
    ...extra,
  }
}

export function noMutationStatus (version: VersionInfo): UpdateStatus {
  switch (version.status) {
    case 'current': return 'current'
    case 'newer-than-registry': return 'newer-than-registry'
    default: return 'unknown'
  }
}

export function failedResult (item: UpdatePlanItem, error: UpdateError, rollback?: UpdateResult['rollback']): UpdateResult {
  return resultFromPlan(item, 'failed', { changed: false, error, rollback })
}

export function commandFailure (executable: string, timedOut = false, spawnErrorCode?: string): UpdateError {
  if (spawnErrorCode === 'ENOENT') {
    return { code: 'MISSING_EXECUTABLE', message: `${executable} executable was not found on PATH` }
  }
  return {
    code: timedOut ? 'COMMAND_TIMEOUT' : 'COMMAND_FAILED',
    message: timedOut ? `${executable} timed out` : `${executable} exited unsuccessfully`,
  }
}

export function isMutableVersion (item: UpdateInstallation): boolean {
  if (item.version.status === 'update-available') return true

  // Native registrations commonly omit the installed version entirely. Once
  // the source and ownership are positively identified, an exact refresh is
  // still safe and is preferable to silently treating the target as current.
  // The same rule repairs a tracked/package-owned cache whose manifest is
  // missing, but never enables mutation for unsupported or uninstalled data.
  return item.version.status === 'unknown' &&
    typeof item.version.latest === 'string' &&
    item.installed &&
    item.ownership !== 'none' &&
    item.source.kind !== 'none' &&
    item.source.kind !== 'unsupported'
}
