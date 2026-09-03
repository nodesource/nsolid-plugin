import path from 'node:path'
import type { UpdateContext, UpdateInstallation, UpdatePlanItem, UpdateResult, UpdateStrategy } from '../types.js'
import { DEFAULT_COMMAND_TIMEOUT_MS, resolveExecutableIdentity } from '../command-runner.js'
import { managerArgsForIdentity } from '../package-manager.js'
import { executeAntigravityTransaction } from '../antigravity-transaction.js'
import { failedResult, isMutableVersion, noMutationStatus, planItem, resultFromPlan } from './common.js'

export const antigravityStrategy: UpdateStrategy = {
  target: 'antigravity',
  ownership: 'native-plugin',

  async plan (installation: UpdateInstallation): Promise<UpdatePlanItem> {
    const source = installation.source
    if (source.kind !== 'antigravity-git' || !isMutableVersion(installation)) return planItem(installation)
    const paths = [path.resolve(installation.metadata?.pluginRoot ?? source.layout.pluginRoot), path.resolve(installation.metadata?.manifestPath ?? source.layout.manifestPath)]
    const pinnedSource = installation.artifact?.kind === 'git' && installation.artifact.commit
      ? `${source.url}#${installation.artifact.commit}`
      : source.url
    const identity = resolveExecutableIdentity('agy')
    if (identity.kind === 'unsupported') {
      return {
        ...planItem(installation, [], [], undefined, { code: 'UNSAFE_HARNESS_LAUNCHER', message: 'Antigravity launcher cannot be verified as a safe executable identity' }),
        manualCommands: ['agy plugin uninstall nsolid-plugin', `agy plugin install ${pinnedSource}`],
      }
    }
    const uninstall = managerArgsForIdentity(identity, ['plugin', 'uninstall', 'nsolid-plugin'])
    const install = managerArgsForIdentity(identity, ['plugin', 'install', pinnedSource])
    return {
      ...planItem(
        installation,
        [
          { kind: 'filesystem', description: 'Back up the staged plugin and matching import manifest', operation: 'backup', paths },
          { kind: 'command', description: 'Uninstall the existing Antigravity N|Solid plugin', command: { executable: uninstall.executable, executableIdentity: identity, args: uninstall.args, timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS } },
          { kind: 'command', description: 'Install the fixed NodeSource GitHub plugin root at the planned commit', command: { executable: install.executable, executableIdentity: identity, args: install.args, timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS } },
          { kind: 'validation', description: 'Validate the staged plugin and matching import manifest', checks: ['plugin.json', 'bundle.json', 'canonical skills', 'nsolid-plugin import entry'] },
          { kind: 'filesystem', description: 'Remove the successful Antigravity backup', operation: 'cleanup', paths },
        ],
        [{ kind: 'filesystem', description: 'Restore the staged plugin and matching import manifest', operation: 'restore', paths }],
        'Restart Antigravity to load the updated plugin'
      ),
      manualCommands: ['agy plugin uninstall nsolid-plugin', `agy plugin install ${pinnedSource}`],
    }
  },

  async execute (item: UpdatePlanItem, context: UpdateContext): Promise<UpdateResult> {
    if (item.planningError) return failedResult(item, item.planningError)
    if (item.steps.length === 0) return resultFromPlan(item, item.source.kind === 'unsupported' ? 'unsupported' : noMutationStatus(item.version))
    const transaction = await executeAntigravityTransaction(item, context.commandRunner)
    if (!transaction.success) return failedResult(item, transaction.error ?? { code: 'ANTIGRAVITY_TRANSACTION_FAILED', message: 'Antigravity replacement failed' }, { attempted: transaction.rollbackAttempted, succeeded: transaction.rollbackSucceeded })
    return resultFromPlan(item, 'updated', { resultingVersion: item.version.latest })
  },
}
