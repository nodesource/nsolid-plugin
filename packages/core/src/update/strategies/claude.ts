import type { UpdateContext, UpdateInstallation, UpdatePlanItem, UpdateResult, UpdateStrategy } from '../types.js'
import { resolveExecutableIdentity } from '../command-runner.js'
import { transactionCommand } from '../transaction-commands.js'
import { nativeExecutionGuard } from '../native-evidence.js'
import { executeClaudeTransaction } from '../claude-transaction.js'
import { failedResult, isMutableVersion, noMutationStatus, planItem, resultFromPlan } from './common.js'
import { resolveHome } from '../../utils/path.js'

export const claudeStrategy: UpdateStrategy = {
  target: 'claude',
  ownership: 'native-plugin',

  async plan (installation: UpdateInstallation): Promise<UpdatePlanItem> {
    const source = installation.source
    if (source.kind !== 'claude-marketplace' || !isMutableVersion(installation)) return planItem(installation)
    const guard = nativeExecutionGuard(installation, 'Claude')
    if (guard) return planItem(installation, [], [], undefined, guard)
    if (!/^nsolid-plugin@[A-Za-z0-9][A-Za-z0-9._-]*$/.test(source.pluginId)) {
      return planItem(installation, [], [], undefined, { code: 'INVALID_PLUGIN_ID', message: 'Detected Claude plugin identity is ambiguous' })
    }
    const identity = resolveExecutableIdentity('claude')
    if (identity.kind === 'unsupported') {
      return {
        ...planItem(installation, [], [], undefined, { code: 'UNSAFE_HARNESS_LAUNCHER', message: 'Claude launcher cannot be verified as a safe executable identity' }),
        manualCommands: [
          `claude plugin marketplace update ${source.marketplace}`,
          `claude plugin update ${source.pluginId} --scope ${source.scope}`,
        ],
      }
    }
    return planItem(
      installation,
      [
        transactionCommand(identity, ['plugin', 'marketplace', 'update', source.marketplace], `Refresh the detected ${source.marketplace} Claude marketplace`),
        transactionCommand(identity, ['plugin', 'update', source.pluginId, '--scope', source.scope], `Update ${source.pluginId} in its detected ${source.scope} scope`),
      ],
      [],
      '/reload-plugins or restart Claude Code'
    )
  },

  async execute (item: UpdatePlanItem, context: UpdateContext): Promise<UpdateResult> {
    if (item.planningError) return failedResult(item, item.planningError)
    const guard = nativeExecutionGuard(item, 'Claude')
    if (guard) return failedResult(item, guard)
    if (item.steps.length === 0) return resultFromPlan(item, item.source.kind === 'unsupported' ? 'unsupported' : noMutationStatus(item.version))
    const commands = item.steps.flatMap((step) => step.kind === 'command' ? [step.command] : [])
    if (commands.length === 0 || item.source.kind !== 'claude-marketplace') return failedResult(item, { code: 'INVALID_PLAN', message: 'Claude update plan has no command' })
    const transaction = await executeClaudeTransaction({
      commands,
      registrationPaths: [...new Set([
        ...(item.metadata?.nativeEvidence ?? []).map((entry) => entry.path),
        resolveHome('~/.claude.json'),
      ])],
      configPath: item.metadata?.configPath,
      pluginId: item.source.pluginId,
      scope: item.source.scope,
      expectedVersion: item.version.latest,
      artifact: item.artifact,
    }, context.commandRunner)
    if (!transaction.success) {
      return failedResult(item, transaction.error ?? { code: 'CLAUDE_TRANSACTION_FAILED', message: 'Claude replacement failed' }, {
        attempted: transaction.rollbackAttempted,
        succeeded: transaction.rollbackSucceeded,
      })
    }
    return resultFromPlan(item, 'updated', { resultingVersion: item.version.latest, rollback: { attempted: false } })
  },
}
