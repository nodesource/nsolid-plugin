import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { UpdateContext, UpdateInstallation, UpdatePlanItem, UpdateResult, UpdateStrategy } from '../types.js'
import type { FallbackPathEvidence, FallbackTransactionIdentity } from '../types.js'
import { FALLBACK_PROTOCOL_VERSION } from '../types.js'
import { deriveFallbackFrontierLeafTargets, deriveFallbackFrontierPlan, evaluateFallbackFrontierPlatformSupport, fallbackLinkMaterialization, FallbackFrontierError, type FallbackFrontierPlan } from '../fallback-frontier.js'
import type { HarnessType, BundleDescriptor } from '../../types.js'
import { DEFAULT_COMMAND_TIMEOUT_MS, resolveExecutableIdentity, isCommandSuccessful } from '../command-runner.js'
import { failedResult, isMutableVersion, noMutationStatus, planItem, resultFromPlan } from './common.js'
import { getTrackingFilePath, getSkillsDir, resolveHome } from '../../utils/path.js'
import { getAdapter } from '../../harnesses/index.js'
import { getHarnessSkillsPath } from '../../skills/skill-linker.js'
import { beginFallbackJournal, commitFallbackJournal, manifestDigestOf, markFallbackJournalMutating, pathDigest, pathKind, reclaimFallbackJournalMutation, recoverFallbackJournal, reloadFallbackJournal, restoreFallbackJournal, trackingDigest, type FallbackJournalHandle } from '../fallback-journal.js'
import { cleanupNpmArtifact } from '../version-source.js'
import { managerArgsForIdentity, verifyLocalArtifact } from '../package-manager.js'
import { readTrackingFile } from '../../skills/skill-tracker.js'
import { harnessMcpKey, readMcpFieldDigests } from '../mcp-lookup.js'
import { readTarEntryText, readTarEntryTextFromBytes } from '../tarball.js'
import { validateBundle } from '../../validate.js'
import { assertSafeSkillName } from '../../utils/skill-name.js'
import { childResultArgs, containmentDirectoryMatches, fallbackChildResultMessage, readValidatedFallbackChildResult, recordContainmentDirectoryIdentity, FALLBACK_CHILD_RESULT_FILENAME, type ContainmentDirectoryIdentity, type FallbackChildResultEnvelope } from '../fallback-result-protocol.js'

export const fallbackStrategy: UpdateStrategy = {
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
      // One shared derivation feeds both the external and the local planner:
      // identical planned state must produce an identical leaf graph.
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
    if (item.planningError) return failedResult(item, item.planningError)
    if (item.steps.length === 0) return resultFromPlan(item, item.source.kind === 'unsupported' ? 'unsupported' : noMutationStatus(item.version))
    const step = item.steps.find((entry) => entry.kind === 'command')
    if (!step || step.kind !== 'command') return failedResult(item, { code: 'INVALID_PLAN', message: 'Fallback update plan has no command' })
    const workspace = await mkdtemp(path.join(tmpdir(), 'nsolid-plugin-update-'))
    // Fresh per-execution result location: a same-plan retry can never replay
    // a stale envelope, and the parent never deletes anything by pathname, so
    // there is no check/delete race against a swapped directory.
    const freshResultDir = await mkdtemp(path.join(tmpdir(), 'nsolid-plugin-result-'))
    let freshResultIdentity: ContainmentDirectoryIdentity | undefined
    let journal: FallbackJournalHandle | undefined
    // Snapshot directory created by this invocation; kept in memory so a
    // proven pre-mutation abort can dispose exactly this transaction's
    // residue without ever trusting the journal file for paths.
    let begunSnapshotDirectory: string | undefined
    let preserveRecoveryArtifacts = false
    try {
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
        return failedResult(item, { code: 'FALLBACK_COMMAND_FAILED', message: 'Fallback transaction workspace changed after planning' }, { attempted: false })
      }
      if (item.artifact?.kind === 'npm' && !verifyLocalArtifact(item.artifact)) {
        return failedResult(item, { code: 'ARTIFACT_INTEGRITY_FAILED', message: 'The planned fallback tarball no longer matches its registry integrity' })
      }
      if (item.fallbackTransaction) {
        // A journal left by an earlier run is never restored or cleaned here:
        // next-run recovery is a strictly pending state that blocks the
        // update until a human resolves it.
        const recovery = await recoverFallbackJournal(item.fallbackTransaction.trackingPath)
        if (recovery.pending) {
          return failedResult(item, { code: 'FALLBACK_RECOVERY_PENDING', message: 'A previous fallback transaction is still pending. Restore or remove it manually before updating; its journal and snapshot are preserved next to the tracking file.' }, { attempted: false })
        }
        try {
          const begun = await beginFallbackJournal(item.fallbackTransaction)
          begunSnapshotDirectory = begun.journal.snapshotDirectory
          journal = await markFallbackJournalMutating(begun.handle)
        } catch (error) {
          if (error instanceof Error && error.message === 'FALLBACK_TRACKING_DRIFT') {
            return failedResult(item, { code: 'FALLBACK_TRACKING_DRIFT', message: 'Fallback tracking file changed after planning' }, { attempted: false })
          }
          if (error instanceof Error && error.message === 'FALLBACK_JOURNAL_BUSY') {
            return failedResult(item, { code: 'FALLBACK_RECOVERY_PENDING', message: 'A previous fallback transaction is still pending. Restore or remove it manually before updating.' }, { attempted: false })
          }
          return failedResult(item, { code: 'FALLBACK_BACKUP_FAILED', message: 'Fallback parent snapshot could not be completed' }, { attempted: false })
        }
      }
      // Refuse to run when a recorded containment directory was swapped: the
      // transaction manifest the child will read lives there, so a replaced
      // directory means the child would consume a transaction this parent
      // never planned.
      if ((item.resultContainment ?? []).some((identity) => !containmentDirectoryMatches(identity, identity.directory))) {
        return failedResult(item, { code: 'FALLBACK_COMMAND_FAILED', message: 'Fallback transaction workspace changed after planning' }, { attempted: false })
      }
      const result = await context.commandRunner.run({
        ...step.command,
        args: resultArgsWithPath(step.command.args, freshResultPath),
        cwd: workspace,
        env: {
          ...step.command.env,
          NPM_CONFIG_USERCONFIG: path.join(workspace, '.npmrc'),
          npm_config_userconfig: path.join(workspace, '.npmrc'),
        },
      })
      if (!isCommandSuccessful(result)) {
        if (result.timedOut && result.treeTerminated !== true) {
          preserveRecoveryArtifacts = true
          return failedResult(item, {
            code: 'FALLBACK_TREE_TERMINATION_UNCONFIRMED',
            message: 'Fallback refresh timed out and descendant termination could not be confirmed; recovery artifacts were preserved',
          }, { attempted: false })
        }
        // Structured child result: read and fully validate the nonce-bound
        // envelope before any output-based inference. Raw child stdout/stderr
        // is never promoted to public state; it only feeds the legacy
        // rollback hint for older children that publish no envelope.
        const structured = item.fallbackTransaction?.nonce !== undefined
          ? await readValidatedFallbackChildResult(freshResultPath, item.fallbackTransaction.nonce, { containmentDirectories: freshResultIdentity ? [freshResultIdentity] : [] })
          : undefined
        const structuredMessage = structured === undefined ? undefined : fallbackChildResultMessage(structured.code, item.target)
        const childRollbackClaim = structured?.rollback ?? parseRollbackState(`${result.stdout}\n${result.stderr}`)
        // Validated child reporting arrays seed the preservation evidence;
        // parent-side outcomes are merged in below. Child paths stay strictly
        // reporting-only: no delete or overwrite is ever justified by them.
        const preservation = childPreservationEvidence(structured)
        // A validated FALLBACK_PROTOCOL_UNSUPPORTED is a PRE-MUTATION
        // rejection: the child refused before claiming the journal or touching
        // any live path. The parent must not report a rollback and must not
        // restore. It disposes its own pre-mutation journal + snapshot (paths
        // recorded in memory at begin time) only when its IN-MEMORY manifest
        // proves the live state is still exactly the planned original;
        // otherwise everything stays preserved for manual recovery (fail
        // closed) and the next run blocks as pending.
        let preMutationRejection = false
        if (journal !== undefined && !result.timedOut && result.spawnErrorCode !== 'ENOENT' && structured?.code === 'FALLBACK_PROTOCOL_UNSUPPORTED') {
          preMutationRejection = true
          const journalPath = journal.journalPath
          const snapshotDirectory = begunSnapshotDirectory
          const provablyUntouched = await liveStateMatchesPlannedEvidence(journal.manifest)
          journal = undefined
          if (provablyUntouched) {
            await rm(journalPath, { force: true }).catch(() => { preservation.preservedArtifacts.push(journalPath) })
            if (snapshotDirectory !== undefined) await rm(snapshotDirectory, { recursive: true, force: true }).catch(() => { preservation.preservedArtifacts.push(snapshotDirectory) })
          } else {
            if (journalPath !== undefined) preservation.preservedArtifacts.push(journalPath)
            if (snapshotDirectory !== undefined) preservation.preservedArtifacts.push(snapshotDirectory)
          }
        }
        // Hybrid rollback: the parent reclaims owner authority (only after a
        // confirmed command completion) and restores using its IN-MEMORY
        // manifest as the sole authority. Owned paths are rewritten from
        // backups authenticated against that manifest; planned-missing
        // destinations are only ever moved to a parent-randomized quarantine,
        // never rm'd. If the journal no longer matches the in-memory manifest
        // or a backup fails authentication, nothing is mutated and the state
        // is reported unproven.
        let parentRecovered: boolean | undefined
        let stateUnproven = false
        // A failed reclaim leaves the final live state UNPROVEN: the journal
        // no longer matches the trusted in-memory manifest (or is gone), so
        // no verified restore ran. Losing journal authority is never proof of
        // a successful child rollback, so the child claim — stdout hint or
        // validated envelope — is never promoted to a success here. Known
        // recovery locations are retained for manual guidance instead.
        let reclaimFailed = false
        if (journal) {
          try {
            const ownerHandle = await reclaimFallbackJournalMutation(journal)
            journal = ownerHandle
            const restored = await restoreFallbackJournal(ownerHandle)
            parentRecovered = restored.succeeded
            stateUnproven = restored.unproven === true
            mergePreservation(preservation, restored)
          } catch {
            reclaimFailed = true
            stateUnproven = true
            for (const location of [journal?.journalPath, begunSnapshotDirectory]) {
              if (location !== undefined && !preservation.preservedArtifacts.includes(location)) {
                preservation.preservedArtifacts.push(location)
              }
            }
            preservation.preservedArtifacts.sort()
            journal = undefined
          }
        }
        // Parent-owned journal recovery remains authoritative over any child
        // rollback claim: while a parent journal exists, its verified restore
        // outcome is the public rollback state. A failed reclaim is an
        // unproven failure, never a child-claimed success; the child claim
        // only applies when the parent never held a journal. A proven
        // pre-mutation protocol rejection needs no rollback at all, from
        // either side.
        const rollback = preMutationRejection
          ? { attempted: false }
          : reclaimFailed
            ? { attempted: true, succeeded: false }
            : journal
              ? { attempted: true, succeeded: parentRecovered === true }
              : childRollbackClaim ?? { attempted: false }
        const rollbackFailed = rollback.attempted && rollback.succeeded === false
        return failedResult(
          item,
          {
            code: result.spawnErrorCode === 'ENOENT'
              ? 'MISSING_EXECUTABLE'
              : result.timedOut
                ? 'FALLBACK_COMMAND_TIMEOUT'
                : stateUnproven
                  ? 'FALLBACK_STATE_UNPROVEN'
                  : rollbackFailed
                    ? 'FALLBACK_ROLLBACK_FAILED'
                    : structured !== undefined && structuredMessage !== undefined
                      ? structured.code
                      : 'FALLBACK_COMMAND_FAILED',
            message: result.spawnErrorCode === 'ENOENT'
              ? `${step.command.executable} executable was not found on PATH`
              : result.timedOut
                ? 'Fallback refresh command timed out'
                : stateUnproven
                  ? 'The fallback transaction could not prove the state of its owned files, so the automatic rollback was refused. Its journal, snapshot, and preserved artifacts were left untouched for manual recovery.'
                  : rollbackFailed
                    ? 'Fallback refresh command failed and its rollback was incomplete'
                    : structuredMessage ?? 'Fallback refresh command failed',
          },
          rollback,
          reportedPreservation(preservation)
        )
      }
      if (journal) {
        let ownerHandle: FallbackJournalHandle
        try {
          ownerHandle = await reclaimFallbackJournalMutation(journal)
          journal = ownerHandle
        } catch {
          preserveRecoveryArtifacts = true
          return failedResult(item, { code: 'FALLBACK_STATE_UNPROVEN', message: 'Fallback child completed but the parent journal could not be reclaimed safely; its state was left untouched for manual recovery' }, { attempted: false })
        }
        // The child's claims are validated from the strictly reloaded journal
        // and the live filesystem: applied stages must carry exactly their
        // registered stage digest, deletions must be gone, and untouched
        // entries must be byte-identical to the journaled original. These
        // mutable fields are success-validation evidence only — they never
        // authorize the restore or commit below.
        if (!await journalProvesAppliedState(await reloadFallbackJournal(ownerHandle))) {
          const restored = await restoreFallbackJournal(ownerHandle)
          return failedResult(item, { code: restored.succeeded ? 'FALLBACK_VALIDATION_FAILED' : 'FALLBACK_ROLLBACK_FAILED', message: restored.succeeded ? 'Fallback child completed without proving the planned owned-state mutation' : 'Fallback validation failed and parent recovery was incomplete' }, { attempted: true, succeeded: restored.succeeded }, { preservedArtifacts: restored.preservedArtifacts, preservedPaths: restored.preservedPaths })
        }
        const tracking = await readTrackingFile()
        const bundleEvidence = tracking?.bundleVersions?.[item.target as keyof typeof tracking.bundleVersions] ?? tracking?.bundleVersion
        if (!tracking || bundleEvidence !== item.version.latest || !validateFallbackPostconditions(tracking, item.target)) {
          const restored = await restoreFallbackJournal(ownerHandle)
          return failedResult(item, { code: restored.succeeded ? 'FALLBACK_VALIDATION_FAILED' : 'FALLBACK_ROLLBACK_FAILED', message: restored.succeeded ? 'Fallback child completed without the planned bundle evidence' : 'Fallback validation failed and parent recovery was incomplete' }, { attempted: true, succeeded: restored.succeeded }, { preservedArtifacts: restored.preservedArtifacts, preservedPaths: restored.preservedPaths })
        }
        const commitResult = await commitFallbackJournal(ownerHandle)
        await cleanupNpmArtifact(item.artifact?.kind === 'npm' ? item.artifact : undefined)
        return resultFromPlan(item, 'updated', {
          resultingVersion: item.version.latest,
          rollback: { attempted: false },
          preservedArtifacts: commitResult.preservedArtifacts.length > 0 ? commitResult.preservedArtifacts : undefined,
          preservedPaths: commitResult.preservedPaths.length > 0 ? commitResult.preservedPaths : undefined,
        })
      }
      await cleanupNpmArtifact(item.artifact?.kind === 'npm' ? item.artifact : undefined)
      return resultFromPlan(item, 'updated', { resultingVersion: item.version.latest, rollback: { attempted: false } })
    } finally {
      if (!preserveRecoveryArtifacts) {
        await rm(workspace, { recursive: true, force: true }).catch(() => {})
        // Pathname cleanup of a parent-created mkdtemp directory is safe by
        // rm semantics: recursive removal never follows symlinks, so a
        // swapped path can only delete what the swapper placed there.
        await rm(freshResultDir, { recursive: true, force: true }).catch(() => {})
      }
      if (!preserveRecoveryArtifacts) {
        for (const directory of item.temporaryDirectories ?? []) {
          await rm(directory, { recursive: true, force: true }).catch(() => {})
        }
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

async function createFallbackIdentity (installation: UpdateInstallation): Promise<FallbackTransactionIdentity | undefined> {
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
  const skillPaths = skills.map((skill) => path.resolve(skill.path))
  const linkPaths = harness === 'opencode' ? [] : skills.map((skill) => path.resolve(getHarnessSkillsPath(harness), skill.name))
  let ownedSkills
  let ownedLinks
  let ownedMcpConfigPaths: FallbackPathEvidence[]
  try {
    ownedSkills = await capturePathEvidence(skillPaths)
    ownedLinks = await capturePathEvidence(linkPaths)
    // Whole-file kind/digest evidence for every MCP config path: this is what
    // authenticates MCP backups during rollback.
    ownedMcpConfigPaths = await capturePathEvidence(mcpConfigPaths)
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
    approvedDestinationRoots: [
      harness === 'opencode'
        ? path.resolve(process.env.NSOLID_OPENCODE_SKILLS_DIR ?? resolveHome('~/.config/opencode/skills'))
        : getSkillsDir(),
      ...(harness !== 'opencode' ? [path.resolve(getHarnessSkillsPath(harness))] : []),
    ],
  }
}

async function capturePathEvidence (paths: readonly string[]) {
  return await Promise.all(paths.map(async (value) => {
    const resolved = path.resolve(value)
    const kind = await pathKind(resolved)
    const digest = kind === 'missing' ? undefined : await pathDigest(resolved)
    if (kind !== 'missing' && !digest) throw new Error(`Cannot capture fallback path evidence for ${resolved}`)
    return { path: resolved, kind, digest }
  }))
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

/** The live destination roots this harness's fallback flow reads and writes. */
function resolveFallbackDestinations (harness: HarnessType): { destination: string; linkDir?: string } {
  const destination = harness === 'opencode'
    ? path.resolve(process.env.NSOLID_OPENCODE_SKILLS_DIR ?? resolveHome('~/.config/opencode/skills'))
    : getSkillsDir()
  const linkDir = harness !== 'opencode' ? path.resolve(getHarnessSkillsPath(harness)) : undefined
  return { destination, linkDir }
}

/** Capture planning-time evidence for every skill and harness-link destination the verified bundle will create. */
async function captureDestinationEvidence (harness: HarnessType, bundle: BundleDescriptor): Promise<FallbackPathEvidence[]> {
  const { destination, linkDir } = resolveFallbackDestinations(harness)
  const paths = [...new Set([
    ...bundle.skills.map((skill) => path.join(destination, skill.name)),
    ...(linkDir !== undefined ? bundle.skills.map((skill) => path.join(linkDir, skill.name)) : []),
  ].map((value) => path.resolve(value)))]
  return await capturePathEvidence(paths)
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

function parseRollbackState (output: string): UpdateResult['rollback'] | undefined {
  const match = output.match(/(?:^|\n)rollback:\s*(succeeded|failed|not-attempted)\s*(?:\n|$)/i)
  if (!match) return undefined
  if (match[1].toLowerCase() === 'not-attempted') return { attempted: false }
  return { attempted: true, succeeded: match[1].toLowerCase() === 'succeeded' }
}

interface PreservationEvidence {
  preservedArtifacts: string[]
  preservedPaths: string[]
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

/**
 * Independently prove the child's claimed mutation from the journal and the
 * live filesystem: applied staged entries must carry exactly the registered
 * stage digest, applied deletions must be gone, and entries the child never
 * staged must still be byte-identical to the journaled original.
 */
async function journalProvesAppliedState (journal: Awaited<ReturnType<typeof reloadFallbackJournal>>): Promise<boolean> {
  for (const entry of journal.entries) {
    const target = path.resolve(entry.path)
    if (entry.stageDigest !== undefined) {
      if (entry.applied !== true) return false
      if (await pathDigest(target) !== entry.stageDigest) return false
      continue
    }
    if (entry.applied === true) {
      if (await pathKind(target) !== 'missing') return false
      continue
    }
    const kind = await pathKind(target)
    if (entry.existed === true) {
      if (kind === 'missing' || entry.digest === undefined || await pathDigest(target) !== entry.digest) return false
    } else if (kind !== 'missing') {
      return false
    }
  }
  return true
}
