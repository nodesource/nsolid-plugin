import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { UpdateContext, UpdateInstallation, UpdatePlanItem, UpdateResult, UpdateStrategy } from '../types.js'
import type { HarnessType } from '../../types.js'
import { DEFAULT_COMMAND_TIMEOUT_MS, resolveExecutableIdentity, isCommandSuccessful } from '../command-runner.js'
import { failedResult, isMutableVersion, noMutationStatus, planItem, resultFromPlan } from './common.js'
import { getTrackingFilePath, getSkillsDir, resolveHome } from '../../utils/path.js'
import { getAdapter } from '../../harnesses/index.js'
import { getHarnessSkillsPath } from '../../skills/skill-linker.js'
import { beginFallbackJournal, captureFallbackJournalState, commitFallbackJournal, markFallbackJournalMutating, recoverFallbackJournal, reloadFallbackJournal, restoreFallbackJournal, trackingDigest, type FallbackJournal } from '../fallback-journal.js'
import { cleanupNpmArtifact } from '../version-source.js'
import { managerArgsForIdentity, verifyLocalArtifact } from '../package-manager.js'
import { readTrackingFile } from '../../skills/skill-tracker.js'
import { harnessMcpKey, readMcpFieldDigests } from '../mcp-lookup.js'

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
    const identity = createFallbackIdentity(installation)
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
    const executableIdentity = resolveExecutableIdentity(executor === 'npm-exec' ? 'npm' : 'pnpm')
    if (executableIdentity.kind === 'unsupported') {
      return planItem(installation, [], [], undefined, { code: 'UNSAFE_FALLBACK_EXECUTOR', message: 'Fallback update requires a verified absolute npm or pnpm executable identity' })
    }
    const manifestPath = await createManifest(identity)
    const version = installation.version.latest!
    const managerArgs = executor === 'npm-exec'
      ? ['exec', '--yes', `--package=${installation.artifact.tarballPath}`, '--', 'nsolid-plugin-refresh-owned', '--transaction', manifestPath]
      : [`--package=${installation.artifact.tarballPath}`, 'dlx', 'nsolid-plugin-refresh-owned', '--transaction', manifestPath]
    const spawn = managerArgsForIdentity(executableIdentity, managerArgs)
    const command = { executable: spawn.executable, executableIdentity, args: spawn.args, timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS }
    const paths = installation.metadata?.trackedSkills?.map((skill) => skill.path) ?? []
    if (installation.metadata?.trackedMcpConfigPath) paths.push(installation.metadata.trackedMcpConfigPath)
    const planned = planItem(
      { ...installation, source: { ...installation.source, executor }, fallbackTransaction: identity },
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
      temporaryDirectories: [path.dirname(manifestPath)],
    }
  },

  async execute (item: UpdatePlanItem, context: UpdateContext): Promise<UpdateResult> {
    if (item.planningError) return failedResult(item, item.planningError)
    if (item.steps.length === 0) return resultFromPlan(item, item.source.kind === 'unsupported' ? 'unsupported' : noMutationStatus(item.version))
    const step = item.steps.find((entry) => entry.kind === 'command')
    if (!step || step.kind !== 'command') return failedResult(item, { code: 'INVALID_PLAN', message: 'Fallback update plan has no command' })
    const workspace = await mkdtemp(path.join(tmpdir(), 'nsolid-plugin-update-'))
    let journal: FallbackJournal | undefined
    let preserveRecoveryArtifacts = false
    try {
      await chmod(workspace, 0o700)
      // Anchor npm/pnpm's project discovery inside the private directory so
      // parent-level /tmp/package.json, .npmrc, or node_modules/.bin entries
      // cannot influence exact-package execution.
      await writeFile(path.join(workspace, 'package.json'), '{"private":true}\n', { mode: 0o600 })
      await writeFile(path.join(workspace, '.npmrc'), '', { mode: 0o600 })
      if (item.artifact?.kind === 'npm' && !verifyLocalArtifact(item.artifact)) {
        return failedResult(item, { code: 'ARTIFACT_INTEGRITY_FAILED', message: 'The planned fallback tarball no longer matches its registry integrity' })
      }
      if (item.fallbackTransaction) {
        const recovery = await recoverFallbackJournal(item.fallbackTransaction.trackingPath, true)
        if (!recovery.recovered) return failedResult(item, { code: 'FALLBACK_RECOVERY_FAILED', message: 'A previous fallback transaction could not be recovered' }, { attempted: true, succeeded: false })
        try {
          journal = (await beginFallbackJournal(item.fallbackTransaction)).journal
          journal = await markFallbackJournalMutating(journal)
        } catch (error) {
          if (error instanceof Error && error.message === 'FALLBACK_TRACKING_DRIFT') {
            return failedResult(item, { code: 'FALLBACK_TRACKING_DRIFT', message: 'Fallback tracking file changed after planning' }, { attempted: false })
          }
          return failedResult(item, { code: 'FALLBACK_BACKUP_FAILED', message: 'Fallback parent snapshot could not be completed' }, { attempted: false })
        }
      }
      const result = await context.commandRunner.run({
        ...step.command,
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
        const rollback = parseRollbackState(`${result.stdout}\n${result.stderr}`)
        if (journal) journal = await reloadFallbackJournal(journal)
        const parentRecovered = journal ? await restoreFallbackJournal(journal) : undefined
        return failedResult(
          item,
          {
            code: result.spawnErrorCode === 'ENOENT'
              ? 'MISSING_EXECUTABLE'
              : result.timedOut
                ? 'FALLBACK_COMMAND_TIMEOUT'
                : rollback?.attempted && rollback.succeeded === false ? 'FALLBACK_ROLLBACK_FAILED' : 'FALLBACK_COMMAND_FAILED',
            message: result.spawnErrorCode === 'ENOENT'
              ? `${step.command.executable} executable was not found on PATH`
              : rollback?.attempted && rollback.succeeded === false
                ? 'Fallback refresh command failed and its rollback was incomplete'
                : 'Fallback refresh command failed',
          },
          parentRecovered === false ? { attempted: true, succeeded: false } : rollback ?? (journal ? { attempted: true, succeeded: parentRecovered === true } : { attempted: false })
        )
      }
      if (journal) {
        try {
          journal = await captureFallbackJournalState(journal)
        } catch {
          preserveRecoveryArtifacts = true
          return failedResult(item, { code: 'FALLBACK_STATE_UNPROVEN', message: 'Fallback child completed but the resulting owned state could not be captured safely' }, { attempted: false })
        }
        const tracking = await readTrackingFile()
        const bundleEvidence = tracking?.bundleVersions?.[item.target as keyof typeof tracking.bundleVersions] ?? tracking?.bundleVersion
        if (!tracking || bundleEvidence !== item.version.latest || !validateFallbackPostconditions(tracking, item.target)) {
          const recovered = await restoreFallbackJournal(journal)
          return failedResult(item, { code: recovered ? 'FALLBACK_VALIDATION_FAILED' : 'FALLBACK_ROLLBACK_FAILED', message: recovered ? 'Fallback child completed without the planned bundle evidence' : 'Fallback validation failed and parent recovery was incomplete' }, { attempted: true, succeeded: recovered })
        }
      }
      if (journal) await commitFallbackJournal(journal)
      await cleanupNpmArtifact(item.artifact?.kind === 'npm' ? item.artifact : undefined)
      return resultFromPlan(item, 'updated', { resultingVersion: item.version.latest, rollback: { attempted: false } })
    } finally {
      if (!preserveRecoveryArtifacts) await rm(workspace, { recursive: true, force: true }).catch(() => {})
      if (!preserveRecoveryArtifacts) {
        for (const directory of item.temporaryDirectories ?? []) {
          await rm(directory, { recursive: true, force: true }).catch(() => {})
        }
      }
    }
  },
}

function createFallbackIdentity (installation: UpdateInstallation) {
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
  const ownedMcpConfigPaths = [...new Set([...trackedConfigPaths, ...(canonical ? [path.resolve(canonical)] : [])])]
  return {
    installationId: installation.installationId,
    harness,
    trackingPath,
    trackingDigest: digest,
    nonce: randomUUID(),
    ownedSkillPaths: skills.map((skill) => path.resolve(skill.path)),
    ownedLinkPaths: skills.map((skill) => path.join(getHarnessSkillsPath(harness), skill.name)),
    ownedMcpFields: trackedFields.length > 0
      ? trackedFields.map((field) => ({ ...field, configPath: path.resolve(field.configPath) }))
      : configPath
        ? names.flatMap((name) => Object.entries(readMcpFieldDigests(configPath, name, { preferredKey: harnessMcpKey(harness) }) ?? {}).map(([field, expectedDigest]) => ({ configPath: path.resolve(configPath), server: name, field, expectedDigest })))
        : [],
    ownedMcpConfigPaths,
    approvedDestinationRoots: [
      harness === 'opencode'
        ? path.resolve(process.env.NSOLID_OPENCODE_SKILLS_DIR ?? resolveHome('~/.config/opencode/skills'))
        : getSkillsDir(),
      ...(harness !== 'opencode' ? [path.resolve(getHarnessSkillsPath(harness))] : []),
    ],
  } as const
}

async function createManifest (identity: NonNullable<ReturnType<typeof createFallbackIdentity>>): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'nsolid-plugin-manifest-'))
  const manifestPath = path.join(directory, 'transaction.json')
  await writeFile(manifestPath, JSON.stringify(identity, null, 2) + '\n', { mode: 0o600 })
  return manifestPath
}

function parseRollbackState (output: string): UpdateResult['rollback'] | undefined {
  const match = output.match(/(?:^|\n)rollback:\s*(succeeded|failed|not-attempted)\s*(?:\n|$)/i)
  if (!match) return undefined
  if (match[1].toLowerCase() === 'not-attempted') return { attempted: false }
  return { attempted: true, succeeded: match[1].toLowerCase() === 'succeeded' }
}

function detectExecutor (): 'npm-exec' | 'pnpm-dlx' | undefined {
  if (resolveExecutableIdentity('npm').kind !== 'unsupported') return 'npm-exec'
  if (resolveExecutableIdentity('pnpm').kind !== 'unsupported') return 'pnpm-dlx'
  return undefined
}

function validateFallbackPostconditions (tracking: Awaited<ReturnType<typeof readTrackingFile>>, harness: UpdatePlanItem['target']): boolean {
  if (!tracking || harness === 'cli') return false
  const scopedSkills = tracking.skills.filter((entry) => entry.harnesses.includes(harness))
  if (scopedSkills.some((entry) => {
    const skillPath = entry.paths?.[harness] ?? entry.path
    return !path.isAbsolute(skillPath) || !existsSync(skillPath)
  })) return false
  const scopedMcp = tracking.mcpServers.filter((entry) => entry.harness === harness)
  return scopedMcp.every((entry) => path.isAbsolute(entry.configPath) && existsSync(entry.configPath))
}
