import type { HarnessType } from '../types.js'
import { rm } from 'node:fs/promises'
import { createCommandRunner } from './command-runner.js'
import { detectCliInstallation, detectInstallations } from './inventory.js'
import { cleanupNpmArtifact, downloadNpmArtifact, resolveFixedGitBundleVersion, resolveMarketplaceVersion, resolveRegistryVersion } from './version-source.js'
import { classifyVersionSet, classifyVersions } from './version.js'
import type {
  ResolvedArtifactIdentity,
  UpdateContext,
  UpdateInstallation,
  UpdateOptions,
  UpdatePlan,
  UpdatePlanItem,
  UpdateResult,
  UpdateSource,
  UpdateStatus,
  UpdateStrategy,
  UpdateSummary,
  VersionLookupResult,
} from './types.js'
import { planItem, resultFromPlan } from './strategies/common.js'
import { summarizeFallbackChanges } from './strategies/fallback.js'
import { cliPackageStrategy } from './strategies/cli-package.js'
import { claudeStrategy } from './strategies/claude.js'
import { codexStrategy } from './strategies/codex.js'
import { antigravityStrategy } from './strategies/antigravity.js'
import { piStrategy } from './strategies/pi.js'
import { fallbackStrategy } from './strategies/fallback.js'
import { recoverFallbackJournal } from './fallback-journal.js'
import { getTrackingFilePath } from '../utils/path.js'
import { cliExactVersionManualCommands } from './cli-guidance.js'

const STATUSES: readonly UpdateStatus[] = [
  'current',
  'update-available',
  'newer-than-registry',
  'updated',
  'skipped',
  'not-installed',
  'unsupported',
  'unknown',
  'failed',
]

export async function planUpdates (options: UpdateOptions = {}): Promise<UpdatePlan> {
  validateScope(options)
  const pendingRecovery = await recoverFallbackJournal(getTrackingFilePath(), options.check !== true)
  if (pendingRecovery.pending && !pendingRecovery.recovered) {
    return {
      checkOnly: options.check === true,
      items: [recoveryPlanItem(options.check === true)],
    }
  }
  const commandRunner = options.commandRunner ?? createCommandRunner()
  const context: UpdateContext = { options, commandRunner }
  const detected = await detectInstallations({
    commandRunner,
    cwd: options.cwd,
    packageRoot: options.packageRoot,
    executablePath: options.executablePath,
    includeCli: options.harness === undefined,
    readOnly: options.check === true,
    deferCliOwnership: options.check !== true,
  })
  const selected = selectInstallations(detected, options)
  const withSynthetic = options.harness && selected.length === 0
    ? [syntheticInstallation(options.harness)]
    : selected
  const items: UpdatePlanItem[] = []

  for (let installation of withSynthetic) {
    if (installation.inventoryError) {
      items.push(planItem(installation, [], [], undefined, installation.inventoryError))
      continue
    }
    if (installation.source.kind === 'none') {
      items.push({ ...planItem(installation), manualCommands: installationGuidance(installation.target) })
      continue
    }

    const lookup = await resolveLatestVersion(installation, options)
    const plannedStatus = lookup.version
      ? classifyVersions(installation.version.current, lookup.version).status
      : installation.version.status
    if (
      installation.target === 'cli' &&
      options.check !== true &&
      installation.source.kind === 'global-package' &&
      (plannedStatus === 'update-available' || plannedStatus === 'unknown')
    ) {
      // Deferred structural evidence is sufficient to classify a no-op, but an
      // actual global mutation requires the positive package-manager realpath
      // proof immediately before its command can be planned. Structurally
      // unsupported workspace, npx, and wrapper launches never enter this path.
      installation = await detectCliInstallation({
        commandRunner,
        cwd: options.cwd,
        packageRoot: options.packageRoot,
        executablePath: options.executablePath,
        includeCli: true,
        readOnly: false,
      })
    }
    if (
      options.check !== true &&
      installation.source.kind !== 'unsupported' &&
      lookup.artifact?.kind === 'npm' &&
      (plannedStatus === 'update-available' || plannedStatus === 'unknown') &&
      !lookup.artifact.tarballPath
    ) {
      try {
        lookup.artifact = await downloadNpmArtifact(lookup.artifact, { fetchImpl: options.fetchImpl })
      } catch {
        items.push(planItem(installation, [], [], undefined, { code: 'ARTIFACT_INTEGRITY_FAILED', message: 'Planned registry artifact could not be downloaded or verified' }))
        continue
      }
    }
    const resolved = lookup.version
      ? {
          ...installation,
          version: classifyInstallationVersion(installation, lookup.version),
          artifact: lookup.artifact ?? installation.artifact,
          // The immutable identity the lookup proved (a resolved commit or a
          // verified snapshot) becomes part of the planned source so the
          // execution guard validates the pinned identity, not a mutable ref.
          source: withPinnedMarketplaceCommit(installation.source, lookup.artifact),
        }
      : installation
    if (lookup.error) {
      if (options.check !== true && isMutationUnavailableLookup(lookup.error.code)) {
        const unsupported = {
          ...resolved,
          source: {
            kind: 'unsupported' as const,
            source: `${installation.target}:immutable-source`,
            reason: 'git' as const,
          },
        }
        items.push({ ...planItem(unsupported), manualCommands: installationGuidance(installation.target, resolved.version.latest) })
        continue
      }
      items.push(planItem(resolved, [], [], undefined, lookup.error))
      continue
    }
    // Checks are inventory/version reports. They must not ask a mutation
    // strategy to discover an executor, construct commands, or inspect
    // writable transaction state.
    if (options.check === true) {
      let item = planItem(resolved)
      // A read-only check still answers "what will change": for fallback
      // installations it downloads the verified artifact to a temporary
      // location, summarizes the skill/MCP diff, and removes the artifact
      // again. Best-effort — a failed summary never blocks the check.
      if (
        resolved.source.kind === 'fallback' &&
        (resolved.version.status === 'update-available' || resolved.version.status === 'unknown') &&
        resolved.artifact?.kind === 'npm'
      ) {
        try {
          const artifact = resolved.artifact.tarballPath
            ? resolved.artifact
            : await downloadNpmArtifact(resolved.artifact, { fetchImpl: options.fetchImpl })
          // downloadNpmArtifact materializes the tarball path; the already-
          // downloaded branch carries it by construction.
          const changes = await summarizeFallbackChanges(resolved, artifact.tarballPath!)
          if (changes) item = { ...item, changes }
          if (!resolved.artifact.tarballPath) await cleanupNpmArtifact(artifact)
        } catch { /* summary stays absent; the version report is unaffected */ }
      }
      // An unproven CLI launch still carries the exact-version recovery
      // commands so the read-only report stays actionable.
      items.push(
        resolved.target === 'cli' && resolved.source.kind === 'unsupported'
          ? { ...item, manualCommands: cliExactVersionManualCommands(resolved.version.latest, resolved.source.source) }
          : item
      )
      continue
    }
    const strategy = strategyFor(resolved)
    try {
      items.push(await strategy.plan(resolved, context))
    } catch {
      items.push(planItem(resolved, [], [], undefined, { code: 'UPDATE_PLAN_FAILED', message: 'Target update plan could not be created' }))
    }
  }

  return { checkOnly: options.check === true, items }
}

export async function checkUpdates (options: UpdateOptions = {}): Promise<UpdateSummary> {
  const plan = await planUpdates({ ...options, check: true })
  return summarizePlan(plan)
}

export async function update (options: UpdateOptions = {}): Promise<UpdateSummary> {
  const plan = await planUpdates({ ...options, check: false })
  return executeUpdatePlan(plan, options)
}

export async function executeUpdatePlan (plan: UpdatePlan, options: UpdateOptions = {}): Promise<UpdateSummary> {
  if (plan.checkOnly || options.check === true) return summarizePlan(plan)
  const commandRunner = options.commandRunner ?? createCommandRunner()

  const recoveryItem = plan.items.find((item) => item.planningError?.code === 'FALLBACK_RECOVERY_PENDING' || item.planningError?.code === 'FALLBACK_RECOVERY_FAILED')
  if (recoveryItem?.planningError) {
    const results = plan.items.map((item) => item.planningError
      ? resultFromPlan(item, 'failed', { error: item.planningError })
      : item.requiresConfirmation
        ? resultFromPlan(item, 'failed', { error: recoveryItem.planningError })
        : resultFromPlan(item, statusForPlan(item, false)))
    await Promise.all(plan.items.map(async (item, index) => {
      if (!mustPreservePlanState(results[index]!)) await cleanupPlanState(item)
    }))
    return summarizeResults(false, results)
  }

  const planningResults = plan.items.map((item) => item.planningError ? resultFromPlan(item, 'failed', { error: item.planningError }) : undefined)
  const mutableItems = plan.items.filter((item) => item.requiresConfirmation)
  let approved = options.yes === true

  if (mutableItems.length > 0 && !approved) {
    if (!options.confirm) {
      const results = plan.items.map((item, index) => planningResults[index] ?? (
        item.requiresConfirmation
          ? resultFromPlan(item, 'skipped', { error: { code: 'CONFIRMATION_REQUIRED', message: 'Pass --yes in non-interactive mode to approve this update' } })
          : resultFromPlan(item, statusForPlan(item, false))
      ))
      await Promise.all(plan.items.map(async (item, index) => {
        if (!mustPreservePlanState(results[index]!)) await cleanupPlanState(item)
      }))
      return summarizeResults(false, results)
    }
    approved = await options.confirm({ items: mutableItems })
  }

  const results: UpdateResult[] = []
  for (const item of plan.items) {
    let result: UpdateResult
    if (item.planningError) {
      result = resultFromPlan(item, 'failed', { error: item.planningError })
    } else if (item.requiresConfirmation && !approved) {
      result = resultFromPlan(item, 'skipped', { error: { code: 'CONFIRMATION_REQUIRED', message: 'Update was not approved' } })
    } else if (!item.requiresConfirmation) {
      result = resultFromPlan(item, statusForPlan(item, false))
    } else {
      try {
        result = await strategyForPlan(item).execute(item, { options, commandRunner })
      } catch {
        await cleanupNpmArtifact(item.artifact?.kind === 'npm' ? item.artifact : undefined)
        result = resultFromPlan(item, 'failed', { error: { code: 'UPDATE_EXECUTION_FAILED', message: 'Update strategy failed' } })
      }
    }
    if (!mustPreservePlanState(result)) await cleanupPlanState(item)
    results.push(result)
  }
  return summarizeResults(false, results)
}

function recoveryPlanItem (checkOnly: boolean): UpdatePlanItem {
  const installation = {
    installationId: 'fallback:recovery' as const,
    target: 'opencode' as const,
    ownership: 'fallback' as const,
    installed: true,
    source: { kind: 'fallback' as const },
    version: { status: 'unknown' as const },
  }
  return {
    ...planItem(installation),
    planningError: {
      code: checkOnly ? 'FALLBACK_RECOVERY_PENDING' : 'FALLBACK_RECOVERY_FAILED',
      message: checkOnly
        ? 'A pending fallback transaction requires recovery before the next mutable update'
        : 'A pending fallback transaction could not be recovered',
    },
  }
}

async function cleanupPlanState (item: UpdatePlanItem): Promise<void> {
  await cleanupNpmArtifact(item.artifact?.kind === 'npm' ? item.artifact : undefined)
  // Only directories recorded at planning time (created by this process) are
  // removed; never derive a delete target from command arguments.
  for (const directory of item.temporaryDirectories ?? []) {
    await rm(directory, { recursive: true, force: true }).catch(() => {})
  }
}

function mustPreservePlanState (result: UpdateResult): boolean {
  return result.error?.code === 'FALLBACK_TREE_TERMINATION_UNCONFIRMED' || result.error?.code === 'CLI_TREE_TERMINATION_UNCONFIRMED'
}

export function summarizePlan (plan: UpdatePlan): UpdateSummary {
  return summarizeResults(plan.checkOnly, plan.items.map((item) => item.planningError
    ? resultFromPlan(item, 'failed', { error: item.planningError })
    : resultFromPlan(item, statusForPlan(item, plan.checkOnly))))
}

export function summarizeResults (checkOnly: boolean, results: UpdateResult[]): UpdateSummary {
  const counts = Object.fromEntries(STATUSES.map((status) => [status, 0])) as Record<UpdateStatus, number>
  for (const result of results) counts[result.status]++
  return {
    checkOnly,
    results,
    counts,
    exitCode: checkOnly
      ? counts.failed > 0 ? 1 : 0
      : counts.failed > 0 ? 1 : (counts.unsupported > 0 || counts['not-installed'] > 0 || counts.unknown > 0 || results.some((result) => result.error?.code === 'CONFIRMATION_REQUIRED')) ? 2 : 0,
    success: (checkOnly ? counts.failed === 0 : counts.failed === 0 && counts.unsupported === 0 && counts['not-installed'] === 0 && counts.unknown === 0 && !results.some((result) => result.error?.code === 'CONFIRMATION_REQUIRED')),
  }
}

function statusForPlan (item: UpdatePlanItem, checkOnly: boolean): UpdateStatus {
  if (checkOnly) {
    if (!item.installed || item.source.kind === 'none') return 'not-installed'
    // An unsupported source has no proven installation identity, so it must
    // not inherit a version-derived status such as update-available.
    if (item.source.kind === 'unsupported') return 'unsupported'
    switch (item.version.status) {
      case 'current': return 'current'
      case 'update-available': return 'update-available'
      case 'newer-than-registry': return 'newer-than-registry'
      default: return 'unknown'
    }
  }
  if (item.source.kind === 'unsupported') {
    // A CLI that is already current, or newer than the registry, has no
    // mutation to authorize and therefore does not need ownership probing.
    if (item.target === 'cli' && item.version.status === 'current') return 'current'
    if (item.target === 'cli' && item.version.status === 'newer-than-registry') return 'newer-than-registry'
    return 'unsupported'
  }
  if (!item.installed || item.ownership === 'none' || item.source.kind === 'none') return 'not-installed'
  switch (item.version.status) {
    case 'current': return 'current'
    case 'newer-than-registry': return 'newer-than-registry'
    case 'update-available': return 'update-available'
    default: return 'unknown'
  }
}

function classifyInstallationVersion (installation: UpdateInstallation, latest: string) {
  const currents = installation.version.currentVersions
  return currents
    ? classifyVersionSet(currents, latest)
    : classifyVersions(installation.version.current, latest)
}

function strategyForPlan (item: UpdatePlanItem): UpdateStrategy {
  return strategyFor({ target: item.target, ownership: item.ownership, source: item.source })
}

function strategyFor (installation: Pick<UpdateInstallation, 'target' | 'ownership' | 'source'>): UpdateStrategy {
  if (installation.target === 'cli') return cliPackageStrategy
  if (installation.ownership === 'fallback') return fallbackStrategy
  switch (installation.target) {
    case 'claude': return claudeStrategy
    case 'codex': return codexStrategy
    case 'antigravity': return antigravityStrategy
    case 'pi': return piStrategy
    default: return fallbackStrategy
  }
}

async function resolveLatestVersion (installation: UpdateInstallation, options: UpdateOptions): Promise<VersionLookupResult> {
  const sourceOptions = {
    fetchImpl: options.fetchImpl,
    registry: options.registry,
    downloadArtifact: false,
    requireImmutable: options.check !== true,
  }
  switch (installation.source.kind) {
    case 'global-package':
      return resolveRegistryVersion('nsolid-plugin', sourceOptions)
    case 'pi-package':
      return resolveRegistryVersion('nsolid-pi-plugin', sourceOptions)
    case 'fallback':
      return resolveRegistryVersion('nsolid-plugin', sourceOptions)
    case 'claude-marketplace':
    case 'codex-marketplace':
      return resolveMarketplaceVersion(installation.source.versionSource, sourceOptions)
    case 'antigravity-git':
      return resolveFixedGitBundleVersion(sourceOptions)
    case 'unsupported':
      if (installation.target === 'cli') return resolveRegistryVersion('nsolid-plugin', sourceOptions)
      return {}
    case 'none':
      return {}
  }
}

function selectInstallations (detected: UpdateInstallation[], options: UpdateOptions): UpdateInstallation[] {
  if (options.harness) return detected.filter((installation) => installation.target === options.harness)
  if (options.all) return detected
  return detected.filter((installation) => installation.target === 'cli')
}

function syntheticInstallation (harness: HarnessType): UpdateInstallation {
  return {
    installationId: `${harness}:none`,
    target: harness,
    ownership: 'none',
    installed: false,
    source: { kind: 'none' },
    version: { status: 'unknown' },
  }
}

function installationGuidance (target: UpdateInstallation['target'], latestVersion?: string): readonly string[] {
  switch (target) {
    case 'claude': return ['claude plugin marketplace add NodeSource/nsolid-plugin', 'claude plugin install nsolid-plugin@nodesource']
    case 'codex': return ['codex plugin marketplace add NodeSource/nsolid-plugin', 'codex plugin add nsolid-plugin@nodesource']
    case 'antigravity': return ['agy plugin install https://github.com/NodeSource/nsolid-plugin.git']
    case 'opencode': return ['nsolid-plugin setup --harness opencode', 'nsolid-plugin install --harness opencode']
    case 'pi': return ['pi install npm:nsolid-pi-plugin', 'nsolid-plugin setup --harness pi']
    case 'cli': return cliExactVersionManualCommands(latestVersion, undefined)
  }
}

function validateScope (options: UpdateOptions): void {
  if (options.all && options.harness) throw new Error('Cannot combine --all with --harness')
}

function isMutationUnavailableLookup (code: string): boolean {
  return code === 'IMMUTABLE_SOURCE_UNAVAILABLE' || code === 'SOURCE_CONTENT_MISMATCH' || code === 'INVALID_MARKETPLACE_SOURCE'
}

/**
 * Carry the immutable identity resolved during planning into the planned
 * source. A marketplace source planned with a mutable ref (for example
 * `revision: 'main'`) is only ever authorized against the exact commit the
 * immutable lookup resolved, so the execution guard sees a pinned revision
 * instead of the original mutable ref.
 */
export function withPinnedMarketplaceCommit (source: UpdateSource, artifact: ResolvedArtifactIdentity | undefined): UpdateSource {
  if (artifact?.kind !== 'git') return source
  if (source.kind !== 'claude-marketplace' && source.kind !== 'codex-marketplace') return source
  const versionSource = source.versionSource
  if (versionSource.kind !== 'git') return source
  // Both the revision and the commit must already be the resolved artifact
  // commit: a source pinned only by `commit` but still carrying a mutable
  // `revision` (for example `revision: 'main'`) would fail the execution
  // guard, which reads the revision as the authoritative pinned identity.
  const alreadyPinned = versionSource.revision === artifact.commit && versionSource.commit === artifact.commit
  if (alreadyPinned) return source
  return {
    ...source,
    versionSource: {
      ...versionSource,
      revision: artifact.commit,
      commit: artifact.commit,
    },
  }
}
