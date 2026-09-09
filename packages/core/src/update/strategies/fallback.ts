import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { CommandResult, UpdateContext, UpdateError, UpdateInstallation, UpdatePlanItem, UpdatePlanStep, UpdateResult, UpdateStrategy } from '../types.js'
import type { FallbackPathEvidence, FallbackTransactionIdentity } from '../types.js'
import { FALLBACK_PROTOCOL_VERSION } from '../types.js'
import { deriveFallbackFrontierLeafTargets, deriveFallbackFrontierPlan, evaluateFallbackFrontierPlatformSupport, fallbackLinkMaterialization, FallbackFrontierError, type FallbackFrontierPlan } from '../fallback-frontier.js'
import type { HarnessType, BundleDescriptor } from '../../types.js'
import { isTreeTerminationUnconfirmed, DEFAULT_COMMAND_TIMEOUT_MS, resolveExecutableIdentity, isCommandSuccessful } from '../command-runner.js'
import { failedResult, isMutableVersion, noMutationStatus, planItem, resultFromPlan } from './common.js'
import { getTrackingFilePath } from '../../utils/path.js'
import { captureFallbackPathEvidence, fallbackBundlePaths, resolveFallbackDestinations } from '../fallback-planning.js'
import { getAdapter } from '../../harnesses/index.js'
import { getHarnessSkillsPath } from '../../skills/skill-linker.js'
import { finalizeFallbackJournal, beginFallbackJournal, manifestDigestOf, markFallbackJournalMutating, isFallbackJournalLockBusyError, pathDigest, pathKind, reclaimFallbackJournalMutation, recoverFallbackJournalMutation, recoverFallbackJournal, trackingDigest, type FallbackJournalHandle } from '../fallback-journal.js'
import { managerArgsForIdentity, verifyLocalArtifact } from '../package-manager.js'
import { readTrackingFile } from '../../skills/skill-tracker.js'
import { harnessMcpKey, readMcpFieldDigests } from '../mcp-lookup.js'
import { readTarEntryText, readTarEntryTextFromBytes } from '../tarball.js'
import { validateBundle } from '../../validate.js'
import { assertSafeSkillName } from '../../utils/skill-name.js'
import { childResultArgs, containmentDirectoryMatches, fallbackChildResultMessage, readValidatedFallbackChildResult, recordContainmentDirectoryIdentity, FALLBACK_CHILD_RESULT_FILENAME, type ContainmentDirectoryIdentity, type FallbackChildResultEnvelope } from '../fallback-result-protocol.js'
import type { InternalUpdateExecutionOutcome, InternalUpdateExecutor, PlanResourceDisposition } from './execution.js'

function executionOutcome (result: UpdateResult, planResources: PlanResourceDisposition): InternalUpdateExecutionOutcome {
  return { result, planResources }
}

/**
 * The public strategy interface remains result-only. The coordinator uses
 * this internal executor so cleanup authorization travels with the execution
 * outcome instead of hidden result-object identity.
 */
export const fallbackStrategy: UpdateStrategy & InternalUpdateExecutor = {
  target: 'opencode',
  ownership: 'fallback',

  async plan (installation: UpdateInstallation): Promise<UpdatePlanItem> {
    if (installation.source.kind !== 'fallback') {
      return {
        ...planItem(installation),
        manualCommands: [`nsolid-plugin install --harness ${installation.target}`],
      }
    }
    if (!isMutableVersion(installation)) return planItem(installation)
    const identity = await createFallbackIdentity(installation)
    if (!identity) {
      const unsupportedInstallation = {
        ...installation,
        source: {
          kind: 'unsupported' as const,
          source: `${installation.target}:tracking`,
          reason: 'untracked' as const,
        },
      }
      return {
        ...planItem(unsupportedInstallation),
        manualCommands: [
          `nsolid-plugin install --harness ${installation.target}`,
          `nsolid-plugin update --harness ${installation.target} --check`,
        ],
      }
    }
    const executor = installation.source.executor ?? detectExecutor()
    if (!executor) {
      const unsupportedInstallation = {
        ...installation,
        source: {
          kind: 'unsupported' as const,
          source: `${installation.target}:fallback executor`,
          reason: 'unsupported-manager' as const,
        },
      }
      return {
        ...planItem(unsupportedInstallation),
        manualCommands: [
          `npm exec --yes --package=nsolid-plugin@${installation.version.latest ?? '<resolved-version>'} -- nsolid-plugin update --harness ${installation.target} --yes`,
          `pnpm --package=nsolid-plugin@${installation.version.latest ?? '<resolved-version>'} dlx nsolid-plugin update --harness ${installation.target} --yes`,
        ],
      }
    }
    if (installation.artifact?.kind !== 'npm' || !installation.artifact.tarballPath) {
      return planItem(installation, [], [], undefined, { code: 'ARTIFACT_IDENTITY_REQUIRED', message: 'Fallback update requires a verified registry tarball identity' })
    }
    // Parse the verified bundle BEFORE the manifest is written: every planned
    // destination must be derived from the verified tarball itself. A bundle
    // that cannot be parsed fails the mutable plan closed.
    const verifiedBundle = await parseVerifiedBundle(installation.artifact.tarballPath)
    if (!verifiedBundle) {
      return planItem(installation, [], [], undefined, { code: 'BUNDLE_INVALID', message: 'Fallback update could not read the verified bundle descriptor' })
    }
    try {
      for (const skill of verifiedBundle.skills) assertSafeSkillName(skill.name)
    } catch {
      return planItem(installation, [], [], undefined, { code: 'BUNDLE_INVALID', message: 'Update bundle contains an unsafe skill destination' })
    }
    // Derive the complete frontier/leaf graph from the verified bundle plus
    // the trusted identity BEFORE the manifest is written: planning evidence
    // must fail closed before any manifest, journal, or live state exists.
    const { destination, linkDir } = resolveFallbackDestinations(installation.target as HarnessType)
    let frontierPlan: FallbackFrontierPlan
    try {
      // Derive the leaf graph once; the child consumes this exact evidence.
      frontierPlan = await deriveFallbackFrontierPlan(deriveFallbackFrontierLeafTargets({
        ownedSkills: identity.ownedSkills,
        ownedLinks: identity.ownedLinks,
        ownedMcpConfigPaths: identity.ownedMcpConfigPaths,
        trackingPath: identity.trackingPath,
        destination,
        linkDir,
        bundleSkillNames: verifiedBundle.skills.map((skill) => skill.name),
      }), fallbackLinkMaterialization(installation.target as HarnessType))
    } catch (error) {
      const code = error instanceof FallbackFrontierError ? error.code : 'FALLBACK_FRONTIER_INVALID_INPUT'
      return planItem(installation, [], [], undefined, { code, message: `Fallback update could not derive its destination evidence: ${(error as Error).message}` })
    }
    // Publishing a planned-missing frontier is supported on Linux only for
    // now; unsupported platforms fail the plan closed BEFORE the manifest
    // workspace exists. Every derived frontier counts as active: conditional
    // (MCP-only) inactivity cannot be proven from mutable planning state.
    const frontierSupport = evaluateFallbackFrontierPlatformSupport(frontierPlan.frontiers)
    if (!frontierSupport.supported) {
      return {
        ...planItem(installation, [], [], undefined, {
          code: frontierSupport.code,
          message: `This platform cannot yet create the missing parent directories (${frontierSupport.frontierPaths.join(', ')}) inside a fallback transaction. Create them manually or reinstall, then retry; no files were changed.`,
        }),
        manualCommands: [`nsolid-plugin install --harness ${installation.target}`],
      }
    }
    const executableIdentity = resolveExecutableIdentity(executor === 'npm-exec' ? 'npm' : 'pnpm')
    if (executableIdentity.kind === 'unsupported') {
      return planItem(installation, [], [], undefined, { code: 'UNSAFE_FALLBACK_EXECUTOR', message: 'Fallback update requires a verified absolute npm or pnpm executable identity' })
    }
    const plannedIdentity: FallbackTransactionIdentity = {
      ...identity,
      bundleDestinations: await captureDestinationEvidence(installation.target as HarnessType, verifiedBundle),
      // Exact deterministic frontier evidence derived above; the child never
      // adds leaves. Explicitly present (empty when no frontier applies).
      plannedMissingFrontiers: frontierPlan.frontiers,
    }
    const { manifestPath, manifestDigest, resultPath, resultContainment } = await createManifest(plannedIdentity)
    const version = installation.version.latest!
    const changes = await summarizeFallbackChanges(installation, installation.artifact.tarballPath)
    const childCommand = ['nsolid-plugin-refresh-owned', '--transaction', manifestPath, '--manifest-digest', manifestDigest, ...childResultArgs(resultPath)]
    const managerArgs = executor === 'npm-exec'
      ? ['exec', '--yes', `--package=${installation.artifact.tarballPath}`, '--', ...childCommand]
      : [`--package=${installation.artifact.tarballPath}`, 'dlx', ...childCommand]
    const spawn = managerArgsForIdentity(executableIdentity, managerArgs)
    const command = { executable: spawn.executable, executableIdentity, args: spawn.args, timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS }
    const paths = installation.metadata?.trackedSkills?.map((skill) => skill.path) ?? []
    if (installation.metadata?.trackedMcpConfigPath) paths.push(installation.metadata.trackedMcpConfigPath)
    const planned = planItem(
      { ...installation, source: { ...installation.source, executor }, fallbackTransaction: plannedIdentity },
      [
        { kind: 'filesystem', description: 'Back up tracked NodeSource-owned fallback assets', operation: 'backup', paths },
        { kind: 'command', description: `Refresh the owned ${installation.target} bundle at exact version ${version}`, command },
        { kind: 'validation', description: 'Validate skills, MCP ownership, tracking paths, and per-harness bundle version evidence', checks: ['tracked skills match new bundle', 'unrelated MCP entries are preserved', `${installation.target} bundleVersions entry is ${version}`] },
        { kind: 'filesystem', description: 'Remove the successful fallback backup', operation: 'cleanup', paths },
      ],
      [{ kind: 'filesystem', description: 'Restore tracked fallback assets and tracking state', operation: 'restore', paths }],
      installation.target === 'opencode' ? 'Restart OpenCode to load refreshed skills' : undefined
    )
    // The manifest staging directory is owned by this process from creation:
    // record it on the plan item so cleanup (whether execute() runs or not)
    // removes exactly the directory this process created.
    return {
      ...planned,
      changes,
      temporaryDirectories: [path.dirname(manifestPath)],
      resultContainment: [resultContainment],
    }
  },

  async execute (item: UpdatePlanItem, context: UpdateContext): Promise<UpdateResult> {
    return (await fallbackStrategy.executeWithOutcome(item, context)).result
  },

  async executeWithOutcome (item: UpdatePlanItem, context: UpdateContext): Promise<InternalUpdateExecutionOutcome> {
    if (item.planningError) return executionOutcome(failedResult(item, item.planningError), 'release')
    if (!item.requiresConfirmation && item.steps.length === 0) {
      return executionOutcome(resultFromPlan(item, item.source.kind === 'unsupported' ? 'unsupported' : noMutationStatus(item.version)), 'release')
    }
    const mutablePlan = mutableFallbackPlan(item)
    if (mutablePlan === undefined) {
      // The coordinator performs the same gate before invoking this strategy.
      // Preserve any planning-owned state for direct callers as well: an
      // invalid plan has no authority to release resources it did not execute.
      return executionOutcome(failedResult(item, { code: 'INVALID_PLAN', message: 'Mutable fallback update plan must include a transaction and command' }), 'preserve')
    }
    const { transaction, command } = mutablePlan
    let workspace: string | undefined
    let freshResultDir: string | undefined
    let freshResultIdentity: ContainmentDirectoryIdentity | undefined
    let journal: FallbackJournalHandle | undefined
    // Snapshot directory created by this invocation; kept in memory so a
    // pre-mutation rejection can report exactly this transaction's preserved
    // residue without trusting the journal file for paths.
    let begunSnapshotDirectory: string | undefined
    type ExecutionPhase = 'before-resources' | 'execution-resources' | 'journal-open' | 'command-running' | 'command-finished'
    let phase: ExecutionPhase = 'before-resources'
    let planResourceDisposition: PlanResourceDisposition | undefined
    const complete = (result: UpdateResult, disposition: PlanResourceDisposition = planResourceDisposition ?? 'release'): InternalUpdateExecutionOutcome => {
      planResourceDisposition = disposition
      return executionOutcome(result, disposition)
    }
    try {
      workspace = await mkdtemp(path.join(tmpdir(), 'nsolid-plugin-update-'))
      // Fresh per-execution result location: a same-plan retry can never replay
      // a stale envelope, and the parent never deletes anything by pathname, so
      // there is no check/delete race against a swapped directory.
      freshResultDir = await mkdtemp(path.join(tmpdir(), 'nsolid-plugin-result-'))
      phase = 'execution-resources'
      await chmod(workspace, 0o700)
      await chmod(freshResultDir, 0o700)
      freshResultIdentity = await recordContainmentDirectoryIdentity(freshResultDir)
      const freshResultPath = path.join(freshResultDir, FALLBACK_CHILD_RESULT_FILENAME)
      // Anchor npm/pnpm's project discovery inside the private directory so
      // parent-level /tmp/package.json, .npmrc, or node_modules/.bin entries
      // cannot influence exact-package execution.
      await writeFile(path.join(workspace, 'package.json'), '{"private":true}\n', { mode: 0o600 })
      await writeFile(path.join(workspace, '.npmrc'), '', { mode: 0o600 })
      // Refuse to run when a recorded containment directory was swapped: the
      // transaction manifest the child will read lives there, and the fresh
      // result directory must still be the one this process created. Failing
      // here precedes journal creation, so a refused execution leaves no
      // journal state behind.
      if ((item.resultContainment ?? []).some((identity) => !containmentDirectoryMatches(identity, identity.directory)) ||
          (freshResultIdentity !== undefined && !containmentDirectoryMatches(freshResultIdentity, freshResultIdentity.directory))) {
        return complete(failedResult(item, { code: 'FALLBACK_COMMAND_FAILED', message: 'Fallback transaction workspace changed after planning' }, { attempted: false }), 'release')
      }
      if (item.artifact?.kind === 'npm' && !verifyLocalArtifact(item.artifact)) {
        return complete(failedResult(item, { code: 'ARTIFACT_INTEGRITY_FAILED', message: 'The planned fallback tarball no longer matches its registry integrity' }), 'release')
      }
      // A journal left by an earlier run is never restored or cleaned here:
      // next-run recovery is a strictly pending state that blocks the
      // update until a human resolves it.
      const recovery = await recoverFallbackJournal(transaction.trackingPath)
      if (recovery.pending) {
        return complete(failedResult(item, { code: 'FALLBACK_RECOVERY_PENDING', message: 'A previous fallback transaction is still pending. Restore or remove it manually before updating; its journal and snapshot are preserved next to the tracking file.' }, { attempted: false }), 'release')
      }
      try {
        const begun = await beginFallbackJournal(transaction)
        begunSnapshotDirectory = begun.journal.snapshotDirectory
        journal = await markFallbackJournalMutating(begun.handle)
        phase = 'journal-open'
      } catch (error) {
        if (error instanceof Error && error.message === 'FALLBACK_TRACKING_DRIFT') {
          return complete(failedResult(item, { code: 'FALLBACK_TRACKING_DRIFT', message: 'Fallback tracking file changed after planning' }, { attempted: false }), 'release')
        }
        if (error instanceof Error && error.message === 'FALLBACK_JOURNAL_BUSY') {
          return complete(failedResult(item, { code: 'FALLBACK_RECOVERY_PENDING', message: 'A previous fallback transaction is still pending. Restore or remove it manually before updating.' }, { attempted: false }), 'release')
        }
        return complete(failedResult(item, { code: 'FALLBACK_BACKUP_FAILED', message: 'Fallback parent snapshot could not be completed' }, { attempted: false }), 'release')
      }
      // Refuse to run when a recorded containment directory was swapped: the
      // transaction manifest the child will read lives there, so a replaced
      // directory means the child would consume a transaction this parent
      // never planned.
      if ((item.resultContainment ?? []).some((identity) => !containmentDirectoryMatches(identity, identity.directory))) {
        return complete(failedResult(item, { code: 'FALLBACK_COMMAND_FAILED', message: 'Fallback transaction workspace changed after planning' }, { attempted: false }), 'release')
      }
      phase = 'command-running'
      const result = await context.commandRunner.run({
        ...command,
        args: resultArgsWithPath(command.args, freshResultPath),
        cwd: workspace,
        env: {
          ...command.env,
          NPM_CONFIG_USERCONFIG: path.join(workspace, '.npmrc'),
          npm_config_userconfig: path.join(workspace, '.npmrc'),
        },
      })
      phase = 'command-finished'
      if (!isCommandSuccessful(result)) {
        if (isTreeTerminationUnconfirmed(result)) {
          const outcome: FallbackRecoveryOutcome = {
            kind: 'tree-termination-unconfirmed',
            preservation: { preservedArtifacts: [], preservedPaths: [] },
          }
          return complete(projectFallbackFailure(item, command, result, undefined, undefined, outcome), preservesExecutionArtifacts(outcome) ? 'preserve' : 'release')
        }
        // Structured child result: read and fully validate the nonce-bound
        // envelope before projecting the child-owned failure code. Raw child
        // stdout/stderr is never promoted to public state or rollback state.
        const structured = transaction.nonce !== undefined
          ? await readValidatedFallbackChildResult(freshResultPath, transaction.nonce, { containmentDirectories: freshResultIdentity ? [freshResultIdentity] : [] })
          : undefined
        const structuredMessage = structured === undefined ? undefined : fallbackChildResultMessage(structured.code, item.target)
        // Validated child reporting arrays seed the preservation evidence;
        // parent-side outcomes are merged in below. Child paths stay strictly
        // reporting-only: no delete or overwrite is ever justified by them.
        const preservation = childPreservationEvidence(structured)
        // A validated FALLBACK_PROTOCOL_UNSUPPORTED is a PRE-MUTATION
        // rejection: the child refused before claiming the journal or touching
        // any live path. The parent must not report a rollback or restore. A
        // journal-owned disposal-only operation is not available yet, so even
        // an in-memory proof of the planned original state only determines the
        // reporting outcome; it does not authorize releasing the journal,
        // snapshot, or corresponding execution resources. This also avoids
        // restoring over a concurrent change made after the asynchronous
        // verification point.
        if (journal !== undefined && !result.timedOut && result.spawnErrorCode !== 'ENOENT' && structured?.code === 'FALLBACK_PROTOCOL_UNSUPPORTED') {
          const journalPath = journal.journalPath
          const snapshotDirectory = begunSnapshotDirectory
          const provablyUntouched = await liveStateMatchesPlannedEvidence(journal.manifest)
          preserveRecoveryLocations(preservation, journalPath, snapshotDirectory)
          if (provablyUntouched) {
            const outcome: FallbackRecoveryOutcome = { kind: 'original-state-verified', preservation }
            return complete(projectFallbackFailure(item, command, result, structured, structuredMessage, outcome), 'preserve')
          }
          const outcome: FallbackRecoveryOutcome = { kind: 'authority-unreclaimable', preservation }
          return complete(projectFallbackFailure(item, command, result, structured, structuredMessage, outcome), 'preserve')
        }
        // Hybrid rollback: the parent reclaims owner authority (only after a
        // confirmed command completion) and restores using its IN-MEMORY
        // manifest as the sole authority. Owned paths are rewritten from
        // backups authenticated against that manifest; planned-missing
        // destinations are only ever moved to a parent-randomized quarantine,
        // never rm'd. If the journal no longer matches the in-memory manifest
        // or a backup fails authentication, nothing is mutated and the state
        // is reported unproven.
        const outcome = await recoverFallbackFailure(journal, begunSnapshotDirectory, preservation)
        return complete(projectFallbackFailure(item, command, result, structured, structuredMessage, outcome), preservesExecutionArtifacts(outcome) ? 'preserve' : 'release')
      }
      if (journal) {
        let ownerHandle: FallbackJournalHandle
        try {
          ownerHandle = await reclaimFallbackJournalMutation(journal)
          journal = ownerHandle
        } catch (error) {
          // The journal API fails closed on an abandoned or contended
          // transition lock; surface its message (lock path + manual recovery)
          // instead of swallowing it. Reporting only: nothing is deleted.
          const lockDiagnostic = isFallbackJournalLockBusyError(error) ? ` ${(error as Error).message}` : ''
          return complete(failedResult(item, { code: 'FALLBACK_STATE_UNPROVEN', message: `Fallback child completed but the parent journal could not be reclaimed safely; its state was left untouched for manual recovery.${lockDiagnostic}` }, { attempted: false }), 'preserve')
        }
        const completion = await finalizeFallbackJournal(ownerHandle, async () => {
          const tracking = await readTrackingFile()
          const bundleEvidence = tracking?.bundleVersions?.[item.target as keyof typeof tracking.bundleVersions] ?? tracking?.bundleVersion
          return !!tracking && bundleEvidence === item.version.latest && validateFallbackPostconditions(tracking, item.target)
        })
        if (completion.failure !== undefined) {
          const restored = completion.result
          const validationMessage = completion.failure === 'journal' ? 'Fallback child completed without proving the planned owned-state mutation' : 'Fallback child completed without the planned bundle evidence'
          return complete(failedResult(item, { code: restored.succeeded ? 'FALLBACK_VALIDATION_FAILED' : 'FALLBACK_ROLLBACK_FAILED', message: restored.succeeded ? validationMessage : 'Fallback validation failed and parent recovery was incomplete' }, { attempted: true, succeeded: restored.succeeded }, { preservedArtifacts: restored.preservedArtifacts, preservedPaths: restored.preservedPaths }), 'release')
        }
        const commitResult = completion.result
        return complete(resultFromPlan(item, 'updated', {
          resultingVersion: item.version.latest,
          rollback: { attempted: false },
          preservedArtifacts: commitResult.preservedArtifacts.length > 0 ? commitResult.preservedArtifacts : undefined,
          preservedPaths: commitResult.preservedPaths.length > 0 ? commitResult.preservedPaths : undefined,
        }), 'release')
      }
      return complete(failedResult(item, { code: 'FALLBACK_STATE_UNPROVEN', message: 'Fallback child completed without a parent transaction journal; its state was left untouched for manual recovery' }, { attempted: false }), 'preserve')
    } catch {
      const preserve = ['journal-open', 'command-running', 'command-finished'].includes(phase as string)
      return complete(failedResult(item, { code: 'UPDATE_EXECUTION_FAILED', message: 'Update strategy failed' }), preserve ? 'preserve' : 'release')
    } finally {
      if (planResourceDisposition !== 'preserve') {
        // Execution temporaries belong exclusively to this strategy. The
        // coordinator owns planning temporaries and releases them only after
        // reading this internal disposition; journal backups and quarantines
        // remain exclusively under journal authority.
        if (workspace !== undefined) await rm(workspace, { recursive: true, force: true }).catch(() => {})
        // Pathname cleanup of a parent-created mkdtemp directory is safe by
        // rm semantics: recursive removal never follows symlinks, so a
        // swapped path can only delete what the swapper placed there.
        if (freshResultDir !== undefined) await rm(freshResultDir, { recursive: true, force: true }).catch(() => {})
      }
    }
  },
}

/**
 * Human-oriented diff of what the update will change, computed from the
 * tracked state and the verified tarball's bundle descriptor. Best-effort by
 * design: an unreadable tarball must never block the plan itself — the full
 * technical detail remains in the steps and the structured output. The
 * bundle is read in-process so the summary never executes a PATH-resolved
 * binary and never blocks on an unmanaged child process.
 */
export async function summarizeFallbackChanges (installation: UpdateInstallation, tarballPath: string): Promise<UpdatePlanItem['changes'] | undefined> {
  try {
    return await summarizeFallbackChangesFromBytes(installation, await readFile(tarballPath))
  } catch {
    return undefined
  }
}

/**
 * Same summary from in-memory artifact bytes: the read-only `--check` path
 * must never materialize the verified tarball on disk.
 */
export async function summarizeFallbackChangesFromBytes (installation: UpdateInstallation, bytes: Buffer): Promise<UpdatePlanItem['changes'] | undefined> {
  try {
    const raw = readTarEntryTextFromBytes(bytes, 'package/bundle.json')
    if (raw === undefined) return undefined
    const bundle = validateBundle(JSON.parse(raw))
    const trackedSkills = installation.metadata?.trackedSkills ?? []
    const trackedNames = new Set(trackedSkills.map((skill) => skill.name))
    const newNames = bundle.skills.map((skill) => skill.name)
    const trackedMcp = installation.metadata?.trackedMcpNames ?? []
    const trackedMcpSet = new Set(trackedMcp)
    const newMcp = bundle.mcpServers.map((server) => server.name)
    const skillsAdded = newNames.filter((name) => !trackedNames.has(name))
    const skillsRemoved = [...trackedNames].filter((name) => !newNames.includes(name))
    const skillsUpdated = newNames.filter((name) => trackedNames.has(name)).length
    const mcpAdded = newMcp.filter((name) => !trackedMcpSet.has(name))
    const mcpRemoved = trackedMcp.filter((name) => !newMcp.includes(name))
    const mcpUpdated = newMcp.filter((name) => trackedMcpSet.has(name)).length
    return { skillsAdded, skillsRemoved, skillsUpdated, mcpAdded, mcpRemoved, mcpUpdated }
  } catch {
    return undefined
  }
}

export async function createFallbackIdentity (installation: UpdateInstallation): Promise<FallbackTransactionIdentity | undefined> {
  const trackingPath = getTrackingFilePath()
  const digest = trackingDigest(trackingPath)
  if (!digest) return undefined
  const skills = installation.metadata?.trackedSkills ?? []
  const configPath = installation.metadata?.trackedMcpConfigPath
  const names = installation.metadata?.trackedMcpNames ?? []
  const trackedFields = installation.metadata?.trackedMcpFields ?? []
  if (names.length > 0 && installation.metadata?.trackedMcpOwnershipComplete === false) return undefined
  const harness = installation.target as HarnessType
  const trackedConfigPaths = [...new Set(trackedFields.map((field) => path.resolve(field.configPath)))]
  if (configPath) trackedConfigPaths.push(path.resolve(configPath))
  const canonical = getAdapter(harness).getMcpConfigPath()
  const mcpConfigPaths = [...new Set([...trackedConfigPaths, ...(canonical ? [path.resolve(canonical)] : [])])]
  const { destination, linkDir } = resolveFallbackDestinations(harness)
  const skillPaths = skills.map((skill) => path.resolve(skill.path))
  const linkPaths = harness === 'opencode' ? [] : skills.map((skill) => path.resolve(getHarnessSkillsPath(harness), skill.name))
  let ownedSkills
  let ownedLinks
  let ownedMcpConfigPaths: FallbackPathEvidence[]
  try {
    ownedSkills = await captureFallbackPathEvidence(skillPaths)
    ownedLinks = await captureFallbackPathEvidence(linkPaths)
    // Whole-file kind/digest evidence for every MCP config path: this is what
    // authenticates MCP backups during rollback.
    ownedMcpConfigPaths = await captureFallbackPathEvidence(mcpConfigPaths)
  } catch {
    return undefined
  }
  return {
    installationId: installation.installationId,
    harness,
    trackingPath,
    trackingDigest: digest,
    protocolVersion: FALLBACK_PROTOCOL_VERSION,
    digestAlgorithm: 'fallback-path-v2',
    nonce: randomUUID(),
    ownedSkills,
    ownedLinks,
    ownedMcpFields: trackedFields.length > 0
      ? trackedFields.map((field) => ({ ...field, configPath: path.resolve(field.configPath) }))
      : configPath
        ? names.flatMap((name) => Object.entries(readMcpFieldDigests(configPath, name, { preferredKey: harnessMcpKey(harness) }) ?? {}).map(([field, expectedDigest]) => ({ configPath: path.resolve(configPath), server: name, field, expectedDigest })))
        : [],
    ownedMcpConfigPaths,
    // Filled in by the planner from the verified tarball's bundle descriptor
    // before the manifest is written; empty here so direct callers still get
    // a shape-valid identity.
    bundleDestinations: [],
    // Required protocol-v3 field: the planner overwrites this with the exact
    // derived graph (plannedMissingFrontiers: frontierPlan.frontiers) before
    // the manifest is written; empty here only for the transient base shape.
    plannedMissingFrontiers: [],
    approvedDestinationRoots: [destination, ...(linkDir === undefined ? [] : [linkDir])],
  }
}

/** Read and validate package/bundle.json from the verified tarball, in-process. */
async function parseVerifiedBundle (tarballPath: string): Promise<BundleDescriptor | undefined> {
  try {
    const raw = await readTarEntryText(tarballPath, 'package/bundle.json')
    if (raw === undefined) return undefined
    return validateBundle(JSON.parse(raw))
  } catch {
    return undefined
  }
}

/** Capture planning-time evidence for every skill and harness-link destination the verified bundle will create. */
async function captureDestinationEvidence (harness: HarnessType, bundle: BundleDescriptor): Promise<FallbackPathEvidence[]> {
  const { destination, linkDir } = resolveFallbackDestinations(harness)
  const paths = fallbackBundlePaths(destination, linkDir, bundle.skills.map((skill) => skill.name))
  return await captureFallbackPathEvidence(paths)
}

async function createManifest (identity: FallbackTransactionIdentity): Promise<{ manifestPath: string; manifestDigest: string; resultPath: string; resultContainment: ContainmentDirectoryIdentity }> {
  // The private 0700 staging directory is created and owned by this process;
  // the structured result path lives inside it so parent validation can bind
  // the envelope to workspace ownership and cleanup removes it with the
  // workspace.
  const directory = await mkdtemp(path.join(tmpdir(), 'nsolid-plugin-manifest-'))
  // mkdtemp already applies 0700; the explicit chmod keeps the private-mode
  // guarantee independent of platform defaults that could widen it.
  await chmod(directory, 0o700)
  const manifestPath = path.join(directory, 'transaction.json')
  await writeFile(manifestPath, JSON.stringify(identity, null, 2) + '\n', { mode: 0o600 })
  const resultContainment = await recordContainmentDirectoryIdentity(directory)
  // The canonical digest is computed from the trusted in-memory manifest and
  // transported explicitly to the child; the child recomputes it from the
  // parsed transaction file and rejects any disagreement before claiming.
  return { manifestPath, manifestDigest: manifestDigestOf(identity), resultPath: path.join(directory, FALLBACK_CHILD_RESULT_FILENAME), resultContainment }
}

type MutableFallbackPlan = {
  transaction: FallbackTransactionIdentity
  command: Extract<UpdatePlanStep, { kind: 'command' }>['command']
}

/** Shared pre-execution contract check for the public coordinator and strategy. */
export function isValidMutableFallbackPlan (item: UpdatePlanItem): boolean {
  return mutableFallbackPlan(item) !== undefined
}

/** Validate the execution contract before creating any process workspace. */
function mutableFallbackPlan (item: UpdatePlanItem): MutableFallbackPlan | undefined {
  if (!item.requiresConfirmation || item.ownership !== 'fallback' || item.source.kind !== 'fallback') return undefined
  if (item.fallbackTransaction === undefined) return undefined
  const commandStep = item.steps.find((entry): entry is Extract<UpdatePlanStep, { kind: 'command' }> => entry.kind === 'command')
  if (commandStep === undefined) return undefined
  return { transaction: item.fallbackTransaction, command: commandStep.command }
}

/** Point the planned child command at a fresh per-execution result path; older plans without --result gain it safely. */
function resultArgsWithPath (args: readonly string[] | undefined, resultPath: string): string[] {
  const list = args === undefined ? [] : [...args]
  const index = list.indexOf('--result')
  if (index >= 0 && index + 1 < list.length) {
    list[index + 1] = resultPath
    return list
  }
  return [...list, '--result', resultPath]
}

interface PreservationEvidence {
  preservedArtifacts: string[]
  preservedPaths: string[]
}

type FallbackRecoveryOutcome =
  | { kind: 'tree-termination-unconfirmed'; preservation: PreservationEvidence }
  | { kind: 'original-state-verified'; preservation: PreservationEvidence }
  | { kind: 'authority-unreclaimable'; preservation: PreservationEvidence }
  | { kind: 'restore-verified'; preservation: PreservationEvidence }
  | { kind: 'restore-incomplete'; reason: 'unproven' | 'incomplete' | 'journal-finalization-pending'; preservation: PreservationEvidence; diagnostic?: string }

/** The outcome, not a child claim, determines the public rollback projection. */
function publicRollback (outcome: FallbackRecoveryOutcome): UpdateResult['rollback'] {
  switch (outcome.kind) {
    case 'tree-termination-unconfirmed':
    case 'original-state-verified':
      return { attempted: false }
    case 'authority-unreclaimable':
      return { attempted: false }
    case 'restore-verified':
      return { attempted: true, succeeded: true }
    case 'restore-incomplete':
      return { attempted: true, succeeded: false }
  }
}

/** Only an unconfirmed process tree keeps the parent execution workspace for manual recovery. */
function preservesExecutionArtifacts (outcome: FallbackRecoveryOutcome): boolean {
  return outcome.kind === 'tree-termination-unconfirmed'
}

/** Project every public failure field once from the authoritative recovery outcome and reporting-only child data. */
function projectFallbackFailure (
  item: UpdatePlanItem,
  command: Extract<UpdatePlanStep, { kind: 'command' }>['command'],
  result: CommandResult,
  structured: FallbackChildResultEnvelope | undefined,
  structuredMessage: string | undefined,
  outcome: FallbackRecoveryOutcome
): UpdateResult {
  return failedResult(item, fallbackFailureError(command, result, structured, structuredMessage, outcome), publicRollback(outcome), reportedPreservation(outcome.preservation))
}

function fallbackFailureError (
  command: Extract<UpdatePlanStep, { kind: 'command' }>['command'],
  result: CommandResult,
  structured: FallbackChildResultEnvelope | undefined,
  structuredMessage: string | undefined,
  outcome: FallbackRecoveryOutcome
): UpdateError {
  if (outcome.kind === 'tree-termination-unconfirmed') {
    return {
      code: 'FALLBACK_TREE_TERMINATION_UNCONFIRMED',
      message: 'Fallback refresh command ended and descendant termination could not be confirmed; recovery artifacts were preserved',
    }
  }
  if (result.spawnErrorCode === 'ENOENT') return { code: 'MISSING_EXECUTABLE', message: `${command.executable} executable was not found on PATH` }
  if (result.timedOut) return { code: 'FALLBACK_COMMAND_TIMEOUT', message: 'Fallback refresh command timed out' }
  if (outcome.kind === 'restore-incomplete' && outcome.reason === 'unproven') {
    const message = 'The fallback transaction could not prove the state of its owned files, so the automatic rollback was refused. Its journal, snapshot, and preserved artifacts were left untouched for manual recovery.'
    return {
      code: 'FALLBACK_STATE_UNPROVEN',
      message: outcome.diagnostic === undefined ? message : `${message} ${outcome.diagnostic}`,
    }
  }
  if (outcome.kind === 'restore-incomplete') {
    return { code: 'FALLBACK_ROLLBACK_FAILED', message: 'Fallback refresh command failed and its rollback was incomplete' }
  }
  if (structured !== undefined && structuredMessage !== undefined) return { code: structured.code, message: structuredMessage }
  return { code: 'FALLBACK_COMMAND_FAILED', message: 'Fallback refresh command failed' }
}

/** Recover only after the caller has established confirmed tree termination. Child data is merged only as reporting evidence. */
async function recoverFallbackFailure (
  journal: FallbackJournalHandle | undefined,
  snapshotDirectory: string | undefined,
  preservation: PreservationEvidence
): Promise<FallbackRecoveryOutcome> {
  if (journal === undefined) return { kind: 'authority-unreclaimable', preservation }

  const restored = await recoverFallbackJournalMutation(journal, snapshotDirectory)
  mergePreservation(preservation, restored)
  return restored.succeeded
    ? { kind: 'restore-verified', preservation }
    : {
        // A physically restored frontier with pending journal bookkeeping
        // remains incomplete; durable finalization is a separate proof.
        kind: 'restore-incomplete',
        reason: restored.unproven === true ? 'unproven' : restored.frontierJournalPending === true ? 'journal-finalization-pending' : 'incomplete',
        diagnostic: restored.diagnostic,
        preservation,
      }
}

function preserveRecoveryLocations (preservation: PreservationEvidence, journalPath: string | undefined, snapshotDirectory: string | undefined): void {
  for (const location of [journalPath, snapshotDirectory]) {
    if (location !== undefined && !preservation.preservedArtifacts.includes(location)) preservation.preservedArtifacts.push(location)
  }
  preservation.preservedArtifacts.sort()
}

/** Seed preservation evidence from a validated child envelope. The arrays are reporting data only: nothing deletes or overwrites because of them. */
function childPreservationEvidence (structured: FallbackChildResultEnvelope | undefined): PreservationEvidence {
  return {
    preservedArtifacts: structured?.preservedArtifacts === undefined ? [] : [...structured.preservedArtifacts],
    preservedPaths: structured?.preservedPaths === undefined ? [] : [...structured.preservedPaths],
  }
}

/** Deterministically merge reporting arrays: order-stable, deduplicated union. */
function mergePreservation (target: PreservationEvidence, source: { preservedArtifacts?: readonly string[]; preservedPaths?: readonly string[] } | undefined): void {
  if (source === undefined) return
  target.preservedArtifacts = [...new Set([...target.preservedArtifacts, ...(source.preservedArtifacts ?? [])])].sort()
  target.preservedPaths = [...new Set([...target.preservedPaths, ...(source.preservedPaths ?? [])])].sort()
}

/** Emit preservation arrays only when non-empty so results keep one stable shape. */
function reportedPreservation (preservation: PreservationEvidence): Pick<UpdateResult, 'preservedArtifacts' | 'preservedPaths'> {
  return {
    preservedArtifacts: preservation.preservedArtifacts.length > 0 ? preservation.preservedArtifacts : undefined,
    preservedPaths: preservation.preservedPaths.length > 0 ? preservation.preservedPaths : undefined,
  }
}

/**
 * Prove, from the trusted IN-MEMORY manifest only, that every manifest-owned
 * path still carries exactly its planned kind/digest and the tracking file its
 * planned digest. Validation-only read (nothing is mutated); the journal file
 * is never consulted because it cannot authenticate the live state.
 */
async function liveStateMatchesPlannedEvidence (manifest: FallbackTransactionIdentity): Promise<boolean> {
  for (const planned of [...manifest.ownedSkills, ...manifest.ownedLinks, ...manifest.ownedMcpConfigPaths]) {
    const kind = await pathKind(planned.path)
    if (kind !== planned.kind) return false
    if (kind === 'missing') continue
    if (await pathDigest(planned.path) !== planned.digest) return false
  }
  return trackingDigest(manifest.trackingPath) === manifest.trackingDigest
}

function detectExecutor (): 'npm-exec' | 'pnpm-dlx' | undefined {
  if (resolveExecutableIdentity('npm').kind !== 'unsupported') return 'npm-exec'
  if (resolveExecutableIdentity('pnpm').kind !== 'unsupported') return 'pnpm-dlx'
  return undefined
}

type TrackingDataOrNull = Awaited<ReturnType<typeof readTrackingFile>>

function validateFallbackPostconditions (tracking: TrackingDataOrNull, harness: UpdatePlanItem['target']): boolean {
  if (!tracking || harness === 'cli') return false
  const scopedSkills = tracking.skills.filter((entry) => entry.harnesses.includes(harness))
  if (scopedSkills.some((entry) => {
    const skillPath = entry.paths?.[harness] ?? entry.path
    return !path.isAbsolute(skillPath) || !existsSync(skillPath)
  })) return false
  const scopedMcp = tracking.mcpServers.filter((entry) => entry.harness === harness)
  if (!scopedMcp.every((entry) => path.isAbsolute(entry.configPath) && existsSync(entry.configPath))) return false
  // Postcondition: tracked-ownership evidence consistency — a SUBSET check by
  // design. Every tracked field must still match the live configuration
  // re-read through the field-digests module (a lying tracking file, a drift
  // in an owned field, or a write into the wrong container fails the gate),
  // but preserved user fields in the live record are tolerated here. This is
  // deliberately NOT the exclusive-ownership gate in fallback-ownership.ts,
  // which requires an exact field set before removal decisions.
  const preferredKey = harnessMcpKey(harness as HarnessType)
  return scopedMcp.every((entry) => {
    if (!entry.fields || Object.keys(entry.fields).length === 0) return false
    const live = readMcpFieldDigests(entry.configPath, entry.name, { preferredKey })
    if (!live) return false
    return Object.entries(entry.fields).every(([name, expectedDigest]) => live[name] === expectedDigest)
  })
}
