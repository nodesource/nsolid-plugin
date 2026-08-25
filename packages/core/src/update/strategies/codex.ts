import path from 'node:path'
import type { UpdateContext, UpdateInstallation, UpdatePlanItem, UpdateResult, UpdateStrategy } from '../types.js'
import { DEFAULT_COMMAND_TIMEOUT_MS, resolveExecutableIdentity } from '../command-runner.js'
import { managerArgsForIdentity } from '../package-manager.js'
import { nativeSourceHonorsArtifact } from '../native-evidence.js'
import { executeCodexTransaction, resolveCodexPluginCachePath } from '../codex-transaction.js'
import { failedResult, isMutableVersion, noMutationStatus, planItem, resultFromPlan } from './common.js'
import { resolveHome } from '../../utils/path.js'

export const codexStrategy: UpdateStrategy = {
  target: 'codex',
  ownership: 'native-plugin',

  async plan (installation: UpdateInstallation): Promise<UpdatePlanItem> {
    const source = installation.source
    if (source.kind !== 'codex-marketplace' || !isMutableVersion(installation)) return planItem(installation)
    if (!nativeSourceHonorsArtifact(source, installation.artifact)) {
      return planItem(installation, [], [], undefined, { code: 'NATIVE_SOURCE_NOT_PINNED', message: 'Codex marketplace source cannot honor the resolved immutable commit during execution' })
    }
    if (!/^nsolid-plugin@[A-Za-z0-9][A-Za-z0-9._-]*$/.test(source.pluginId)) {
      return planItem(installation, [], [], undefined, { code: 'INVALID_PLUGIN_ID', message: 'Detected Codex plugin identity is ambiguous' })
    }
    if (!/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)?$/.test(source.marketplace)) {
      return planItem(installation, [], [], undefined, { code: 'INVALID_MARKETPLACE_ID', message: 'Detected Codex marketplace identity is ambiguous' })
    }
    // Resolve the launcher once; all three commands share the same verified
    // identity. An unverifiable launcher degrades to an unsupported plan with
    // manual commands instead of failing at execution time.
    const identity = resolveExecutableIdentity('codex')
    if (identity.kind === 'unsupported') {
      return {
        ...planItem(installation, [], [], undefined, { code: 'UNSAFE_HARNESS_LAUNCHER', message: 'Codex launcher cannot be verified as a safe executable identity' }),
        manualCommands: [
          `codex plugin marketplace upgrade ${source.marketplace}`,
          `codex plugin remove ${source.pluginId}`,
          `codex plugin add ${source.pluginId}`,
        ],
      }
    }
    const upgrade = managerArgsForIdentity(identity, ['plugin', 'marketplace', 'upgrade', source.marketplace])
    const remove = managerArgsForIdentity(identity, ['plugin', 'remove', source.pluginId])
    const add = managerArgsForIdentity(identity, ['plugin', 'add', source.pluginId])
    const configPath = path.resolve(installation.metadata?.configPath ?? process.env.CODEX_CONFIG_PATH ?? resolveHome('~/.codex/config.toml'))
    const plannedInstallation = {
      ...installation,
      metadata: { ...(installation.metadata ?? {}), configPath },
    }
    const cachePath = resolveCodexPluginCachePath(configPath, source.pluginId, source.marketplace, installation.metadata?.packageRoot)
    if (!cachePath) {
      return {
        ...planItem(plannedInstallation, [], [], undefined, { code: 'CODEX_CACHE_UNRESOLVED', message: 'The exact Codex plugin cache could not be identified safely' }),
        manualCommands: [
          `codex plugin marketplace upgrade ${source.marketplace}`,
          `codex plugin remove ${source.pluginId}`,
          `codex plugin add ${source.pluginId}`,
        ],
      }
    }
    return {
      ...planItem(
        plannedInstallation,
        [
          {
            kind: 'command',
            description: `Refresh the detected Codex marketplace ${source.marketplace}`,
            command: { executable: upgrade.executable, executableIdentity: identity, args: upgrade.args, timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS },
          },
          { kind: 'filesystem', description: 'Back up the exact Codex plugin registration and cached payload', operation: 'backup', paths: [configPath, cachePath] },
          {
            kind: 'command',
            description: `Remove the detected plugin ${source.pluginId} before reinstalling the refreshed snapshot`,
            command: { executable: remove.executable, executableIdentity: identity, args: remove.args, timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS },
          },
          {
            kind: 'command',
            description: `Reinstall the detected plugin ${source.pluginId} from the refreshed marketplace`,
            command: { executable: add.executable, executableIdentity: identity, args: add.args, timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS },
          },
          { kind: 'validation', description: 'Validate the reinstalled local Codex plugin version and preserved configuration', checks: [`${source.pluginId} matches refreshed version ${installation.version.latest}`, 'unrelated Codex configuration remains unchanged'] },
          { kind: 'filesystem', description: 'Remove the successful Codex transaction backup', operation: 'cleanup', paths: [configPath] },
        ],
        [
          { kind: 'filesystem', description: 'Restore the prior Codex plugin registration and cached payload', operation: 'restore', paths: [configPath, cachePath] },
        ],
        'Start a new Codex session to load the updated plugin'
      ),
      manualCommands: [
        `codex plugin remove ${source.pluginId}`,
        `codex plugin add ${source.pluginId}`,
      ],
    }
  },

  async execute (item: UpdatePlanItem, context: UpdateContext): Promise<UpdateResult> {
    if (item.planningError) return failedResult(item, item.planningError)
    if (!nativeSourceHonorsArtifact(item.source, item.artifact)) {
      return failedResult(item, { code: 'NATIVE_SOURCE_NOT_PINNED', message: 'Codex marketplace source no longer proves the planned immutable identity' })
    }
    if (item.steps.length === 0) return resultFromPlan(item, item.source.kind === 'unsupported' ? 'unsupported' : noMutationStatus(item.version))
    const transaction = await executeCodexTransaction(item, context.commandRunner)
    if (!transaction.success) {
      return failedResult(item, transaction.error ?? { code: 'CODEX_TRANSACTION_FAILED', message: 'Codex replacement failed' }, {
        attempted: transaction.rollbackAttempted,
        succeeded: transaction.rollbackSucceeded,
      })
    }
    return resultFromPlan(item, 'updated', { resultingVersion: item.version.latest, rollback: { attempted: false } })
  },
}
