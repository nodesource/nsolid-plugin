import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import type { BundleDescriptor } from '../../src/types.js'
import { readTrackingFile } from '../../src/skills/skill-tracker.js'
import { createFallbackIdentity } from '../../src/update/strategies/fallback.js'
import { refreshOwnedInstallation, type FallbackRefreshOptions, type FallbackRefreshResult } from '../../src/update/fallback-transaction.js'
import { captureFallbackPathEvidence, fallbackBundlePaths, resolveFallbackDestinations } from '../../src/update/fallback-planning.js'
import { deriveFallbackFrontierLeafTargets, deriveFallbackFrontierPlan, evaluateFallbackFrontierPlatformSupport, fallbackLinkMaterialization, FallbackFrontierError } from '../../src/update/fallback-frontier.js'
import { beginFallbackJournal, finalizeFallbackJournal, markFallbackJournalMutating, reclaimFallbackJournalMutation, recoverFallbackJournalMutation } from '../../src/update/fallback-journal.js'
import type { FallbackTransactionIdentity, UpdateInstallation } from '../../src/update/types.js'

type ManifestObserver = (manifest: FallbackTransactionIdentity) => void | Promise<void>

export interface ParentRefreshTestOptions extends Omit<FallbackRefreshOptions, 'transaction'> {
  /** Observe fixture planning before the parent reserves its journal. */
  observeManifest?: ManifestObserver
}

/** Capture the same ownership evidence used by the production planner. */
export async function createParentIdentity (options: Pick<FallbackRefreshOptions, 'harness'>): Promise<FallbackTransactionIdentity> {
  const tracking = await readTrackingFile()
  assert.ok(tracking, 'fixture requires tracked ownership')
  const skills = tracking.skills.filter((entry) => entry.harnesses.includes(options.harness))
  const mcps = tracking.mcpServers.filter((entry) => entry.harness === options.harness)
  const installation: UpdateInstallation = {
    installationId: `${options.harness}:fallback`,
    target: options.harness,
    ownership: 'fallback',
    installed: true,
    source: { kind: 'fallback', bundleVersion: tracking.version },
    version: { current: tracking.version, latest: '1.0.1', status: 'update-available' },
    metadata: {
      trackedSkills: skills.map((entry) => ({ name: entry.name, path: entry.paths?.[options.harness] ?? entry.path })),
      trackedMcpConfigPath: mcps[0]?.configPath,
      trackedMcpNames: mcps.map((entry) => entry.name),
      trackedMcpFields: mcps.flatMap((entry) => Object.entries(entry.fields ?? {}).map(([field, expectedDigest]) => ({ configPath: entry.configPath, server: entry.name, field, expectedDigest }))),
    },
  }
  const manifest = await createFallbackIdentity(installation)
  assert.ok(manifest, 'fixture requires a plannable identity')
  return manifest
}

/** Same-process parent fixture: production planning and journal authority, no child process. */
export async function refreshWithParent (
  options: ParentRefreshTestOptions,
  refresh = refreshOwnedInstallation
): Promise<FallbackRefreshResult> {
  const manifest = await createParentIdentity(options)
  const bundle: BundleDescriptor = JSON.parse(await readFile(options.bundlePath, 'utf8'))
  const { destination, linkDir } = resolveFallbackDestinations(options.harness)
  try {
    const plan = await deriveFallbackFrontierPlan(deriveFallbackFrontierLeafTargets({
      ownedSkills: manifest.ownedSkills,
      ownedLinks: manifest.ownedLinks,
      ownedMcpConfigPaths: manifest.ownedMcpConfigPaths,
      trackingPath: manifest.trackingPath,
      destination,
      linkDir,
      bundleSkillNames: bundle.skills.map((skill) => skill.name),
    }), fallbackLinkMaterialization(options.harness))
    manifest.plannedMissingFrontiers = plan.frontiers
    manifest.bundleDestinations = await captureFallbackPathEvidence(fallbackBundlePaths(destination, linkDir, bundle.skills.map((skill) => skill.name)))
  } catch (error) {
    if (!(error instanceof FallbackFrontierError)) throw error
    return { success: false, error: { code: error.code, message: error.message }, rollbackAttempted: false }
  }
  await options.observeManifest?.(manifest)
  const support = evaluateFallbackFrontierPlatformSupport(manifest.plannedMissingFrontiers)
  if (!support.supported) return { success: false, error: { code: support.code, message: 'Unsupported missing parents; no files were changed' }, rollbackAttempted: false }
  const begun = await beginFallbackJournal(manifest)
  const { handle } = begun
  await markFallbackJournalMutating(handle)
  const result = await refresh({ ...options, transaction: manifest })
  if (result.success) {
    const owner = await reclaimFallbackJournalMutation(handle)
    const completion = await finalizeFallbackJournal(owner)
    assert.equal(completion.failure, undefined, JSON.stringify(completion))
    assert.equal(completion.result.succeeded, true, JSON.stringify(completion))
  } else {
    // The fixture is the waiting parent; the child never disposes its journal.
    await recoverFallbackJournalMutation(handle, begun.journal.snapshotDirectory)
  }
  return result
}
