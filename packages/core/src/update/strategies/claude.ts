import type { UpdateContext, UpdateInstallation, UpdatePlanItem, UpdateResult, UpdateStrategy } from '../types.js'
import { DEFAULT_COMMAND_TIMEOUT_MS, isCommandSuccessful, resolveExecutableIdentity } from '../command-runner.js'
import { managerArgsForIdentity } from '../package-manager.js'
import { nativePayloadDigest, nativeSourceHonorsArtifact } from '../native-evidence.js'
import { readClaudePluginScope } from '../claude-record.js'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { commandFailure, failedResult, isMutableVersion, noMutationStatus, planItem, resultFromPlan } from './common.js'

export const claudeStrategy: UpdateStrategy = {
  target: 'claude',
  ownership: 'native-plugin',

  async plan (installation: UpdateInstallation): Promise<UpdatePlanItem> {
    const source = installation.source
    if (source.kind !== 'claude-marketplace' || !isMutableVersion(installation)) return planItem(installation)
    if (!nativeSourceHonorsArtifact(source, installation.artifact)) {
      return planItem(installation, [], [], undefined, { code: 'NATIVE_SOURCE_NOT_PINNED', message: 'Claude marketplace source cannot honor the resolved immutable commit during execution' })
    }
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
    const refresh = managerArgsForIdentity(identity, ['plugin', 'marketplace', 'update', source.marketplace])
    const update = managerArgsForIdentity(identity, ['plugin', 'update', source.pluginId, '--scope', source.scope])
    return planItem(
      installation,
      [
        {
          kind: 'command',
          description: `Refresh the detected ${source.marketplace} Claude marketplace`,
          command: {
            executable: refresh.executable,
            executableIdentity: identity,
            args: refresh.args,
            timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
          },
        },
        {
          kind: 'command',
          description: `Update ${source.pluginId} in its detected ${source.scope} scope`,
          command: {
            executable: update.executable,
            executableIdentity: identity,
            args: update.args,
            timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
          },
        },
      ],
      [],
      '/reload-plugins or restart Claude Code'
    )
  },

  async execute (item: UpdatePlanItem, context: UpdateContext): Promise<UpdateResult> {
    if (item.planningError) return failedResult(item, item.planningError)
    if (!nativeSourceHonorsArtifact(item.source, item.artifact)) {
      return failedResult(item, { code: 'NATIVE_SOURCE_NOT_PINNED', message: 'Claude marketplace source no longer proves the planned immutable identity' })
    }
    if (item.steps.length === 0) return resultFromPlan(item, item.source.kind === 'unsupported' ? 'unsupported' : noMutationStatus(item.version))
    const commands = item.steps.filter((step) => step.kind === 'command')
    if (commands.length === 0) return failedResult(item, { code: 'INVALID_PLAN', message: 'Claude update plan has no command' })
    for (const step of commands) {
      const result = await context.commandRunner.run(step.command)
      if (!isCommandSuccessful(result)) return failedResult(item, commandFailure(step.command.executable, result.timedOut, result.spawnErrorCode))
    }
    if (item.artifact && (item.artifact.kind === 'git' || item.artifact.kind === 'local-snapshot')) {
      const versionSource = item.source.kind === 'claude-marketplace' ? item.source.versionSource : undefined
      const manifestPath = versionSource && versionSource.kind !== 'unknown' ? versionSource.manifestPath : undefined
      const packageRoot = item.source.kind === 'claude-marketplace'
        ? updatedClaudePackageRoot(item.metadata?.configPath, item.source.pluginId, item.source.scope, item.version.latest)
        : undefined
      const digest = packageRoot ? nativePayloadDigest(packageRoot, manifestPath) : undefined
      if (!digest || digest !== item.artifact.contentDigest) return failedResult(item, { code: 'CLAUDE_CONTENT_MISMATCH', message: 'Claude installed payload did not match the planned source identity' })
    }
    return resultFromPlan(item, 'updated', { resultingVersion: item.version.latest })
  },
}

function updatedClaudePackageRoot (
  configPath: string | undefined,
  pluginId: string,
  scope: string,
  expectedVersion: string | undefined
): string | undefined {
  if (!configPath || !path.isAbsolute(configPath)) return undefined
  try {
    const data = JSON.parse(readFileSync(configPath, 'utf8')) as unknown
    if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined
    const plugins = (data as Record<string, unknown>).plugins
    if (!plugins || typeof plugins !== 'object' || Array.isArray(plugins)) return undefined
    const value = (plugins as Record<string, unknown>)[pluginId]
    const records = Array.isArray(value) ? value : [value]
    const roots = records.flatMap((record) => {
      if (!record || typeof record !== 'object' || Array.isArray(record)) return []
      const entry = record as Record<string, unknown>
      if (readClaudePluginScope(entry) !== scope) return []
      if (expectedVersion && typeof entry.version === 'string' && entry.version !== expectedVersion) return []
      if (typeof entry.installPath !== 'string' || !path.isAbsolute(entry.installPath)) return []
      const root = path.resolve(entry.installPath)
      return existsSync(root) ? [root] : []
    })
    return roots.length === 1 ? roots[0] : undefined
  } catch {
    return undefined
  }
}
