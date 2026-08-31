import { readFile, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import type { CommandRunner, UpdateError, UpdatePlanItem } from './types.js'
import { resolveHome } from '../utils/path.js'
import { compareVersions, isStableVersion } from './version.js'
import { copyOwnedPath, createSiblingBackupPath, ownedPathKind, removeOwnedPath } from './fs-transaction.js'
import type { SiblingBackupPath } from './fs-transaction.js'
import { nativePayloadDigest } from './native-evidence.js'
import { runTransactionCommands } from './transaction-commands.js'
import { codexUserOwnedFieldsMatch, readCodexPlugin, restoreCodexUserOwnedFields } from './codex-config.js'

export interface CodexTransactionResult {
  success: boolean
  rollbackAttempted: boolean
  rollbackSucceeded?: boolean
  error?: UpdateError
}

interface CodexBackupSnapshot {
  config: { target: string; backup: string; existed: boolean; complete: boolean }
  cache: { target: string; backup: string; existed: boolean; complete: boolean }
}

export async function executeCodexTransaction (
  item: UpdatePlanItem,
  commandRunner: CommandRunner
): Promise<CodexTransactionResult> {
  const configPath = path.resolve(item.metadata?.configPath ?? item.metadata?.trackedMcpConfigPath ?? resolveHome('~/.codex/config.toml'))
  const pluginId = item.source.kind === 'codex-marketplace' ? item.source.pluginId : undefined
  const cachePath = pluginId
    ? resolveCodexPluginCachePath(
      configPath,
      pluginId,
      item.source.kind === 'codex-marketplace' ? item.source.marketplace : undefined,
      item.metadata?.packageRoot
    )
    : item.metadata?.packageRoot
  if (!cachePath) {
    return {
      success: false,
      rollbackAttempted: false,
      error: { code: 'CODEX_CACHE_NOT_FOUND', message: 'The exact Codex plugin cache directory could not be identified safely' },
    }
  }

  const configKind = await ownedPathKind(configPath)
  const cacheKind = await ownedPathKind(cachePath)
  if (configKind !== 'missing' && configKind !== 'file') {
    return {
      success: false,
      rollbackAttempted: false,
      error: { code: 'CODEX_CONFIG_KIND_UNSUPPORTED', message: 'Codex configuration must be a regular file for transactional replacement' },
    }
  }

  // Allocate backup storage before any mutation. A missing parent directory
  // (e.g. `~/.codex` absent while the config is missing) makes mkdtemp reject
  // with ENOENT; that must surface as a structured failure, never as an escaped
  // rejected promise. Any partially allocated backup directory is removed.
  let configBackupStorage: SiblingBackupPath | undefined
  let cacheBackupStorage: SiblingBackupPath | undefined
  try {
    configBackupStorage = await createSiblingBackupPath(configPath, 'config-backup')
    cacheBackupStorage = await createSiblingBackupPath(cachePath, 'cache-backup')
  } catch {
    await Promise.all([
      configBackupStorage ? removeOwnedPath(configBackupStorage.directory).catch(() => {}) : Promise.resolve(),
      cacheBackupStorage ? removeOwnedPath(cacheBackupStorage.directory).catch(() => {}) : Promise.resolve(),
    ])
    return {
      success: false,
      rollbackAttempted: false,
      error: { code: 'CODEX_BACKUP_FAILED', message: 'Codex configuration or plugin cache backup could not be completed' },
    }
  }
  const backupPath = configBackupStorage.path
  const cacheBackup = cacheBackupStorage.path
  const originalPlugin = pluginId ? readCodexPlugin(configPath, pluginId) : undefined
  const configExisted = configKind !== 'missing'
  const cacheExisted = cacheKind !== 'missing'
  let configBackupComplete = !configExisted
  let cacheBackupComplete = !cacheExisted
  let backupsComplete = false
  let originalConfigText: string | undefined
  let mutationStarted = false
  let rollbackAttempted = false
  let preserveBackup = false
  const backupSnapshot = (): CodexBackupSnapshot => ({
    config: { target: configPath, backup: backupPath, existed: configExisted, complete: configBackupComplete },
    cache: { target: cachePath, backup: cacheBackup, existed: cacheExisted, complete: cacheBackupComplete },
  })

  try {
    // Backup is a separate phase. If a recursive copy fails after creating a
    // partial tree, that tree is not a valid rollback source and must never be
    // used to replace the untouched live cache.
    try {
      if (configExisted) {
        const original = await readFile(configPath)
        originalConfigText = original.toString('utf8')
        await writeFile(backupPath, original, { mode: 0o600 })
        configBackupComplete = true
      }
      if (cacheExisted) {
        await copyOwnedPath(cachePath, cacheBackup)
        cacheBackupComplete = true
      }
      backupsComplete = configBackupComplete && cacheBackupComplete
    } catch {
      return {
        success: false,
        rollbackAttempted: false,
        error: { code: 'CODEX_BACKUP_FAILED', message: 'Codex configuration or plugin cache backup could not be completed' },
      }
    }

    mutationStarted = true
    const commandResult = await runTransactionCommands(item.steps, commandRunner)
    if (!commandResult.success) {
      const { command, result } = commandResult
      if (result.timedOut && result.treeTerminated !== true) {
        preserveBackup = true
        return {
          success: false,
          rollbackAttempted: false,
          error: {
            code: 'CODEX_TREE_TERMINATION_UNCONFIRMED',
            message: `Codex timed out and descendant termination could not be confirmed; backups were preserved at ${configBackupStorage.directory} and ${cacheBackupStorage.directory}`,
          },
        }
      }
      rollbackAttempted = commandResult.completed.some((completed) => completed.args.includes('remove')) || command.args.includes('remove')
      const rollbackSucceeded = rollbackAttempted
        ? await restoreFiles(backupSnapshot())
        : undefined
      return {
        success: false,
        rollbackAttempted,
        rollbackSucceeded,
        error: {
          code: result.spawnErrorCode === 'ENOENT' ? 'MISSING_EXECUTABLE' : result.timedOut ? 'CODEX_COMMAND_TIMEOUT' : 'CODEX_COMMAND_FAILED',
          message: result.spawnErrorCode === 'ENOENT' ? 'codex executable was not found on PATH' : `Codex command ${command.args[0] ?? 'operation'} failed`,
        },
      }
    }

    const refreshedPlugin = pluginId ? readCodexPlugin(configPath, pluginId) : undefined
    if (pluginId && !refreshedPlugin) {
      rollbackAttempted = true
      const rollbackSucceeded = await restoreFiles(backupSnapshot())
      return {
        success: false,
        rollbackAttempted,
        rollbackSucceeded,
        error: { code: 'CODEX_REGISTRATION_MISSING', message: 'Codex did not recreate the selected plugin registration' },
      }
    }

    if (pluginId && item.version.latest && refreshedPlugin) {
      // Codex's normal registration contains enablement/source fields, not a
      // version. Validate the payload selected by the recreated registration,
      // rather than accepting the expected version elsewhere in the cache.
      const registeredPayload = resolveRegisteredPayloadPath(configPath, refreshedPlugin)
      const selectedPayload = registeredPayload ?? (
        hasRegisteredPayloadField(refreshedPlugin)
          ? undefined
          : resolveVersionedPayloadPath(cachePath, pluginId, item.version.latest)
      )
      const cachedVersion = selectedPayload
        ? readDirectCodexPayloadVersion(selectedPayload, pluginId)
        : readCodexPayloadVersion(cachePath, pluginId)
      if (cachedVersion !== item.version.latest) {
        rollbackAttempted = true
        const rollbackSucceeded = await restoreFiles(backupSnapshot())
        return {
          success: false,
          rollbackAttempted,
          rollbackSucceeded,
          error: { code: 'CODEX_VERSION_MISMATCH', message: 'Reinstalled Codex cached payload did not match the refreshed marketplace version' },
        }
      }
      if (item.artifact && (item.artifact.kind === 'git' || item.artifact.kind === 'local-snapshot')) {
        const digest = selectedPayload ? nativePayloadDigest(selectedPayload) : undefined
        if (!selectedPayload || !digest || digest !== item.artifact.contentDigest) {
          rollbackAttempted = true
          const rollbackSucceeded = await restoreFiles(backupSnapshot())
          return {
            success: false,
            rollbackAttempted,
            rollbackSucceeded,
            error: { code: 'CODEX_CONTENT_MISMATCH', message: 'Reinstalled Codex payload did not match the planned content identity' },
          }
        }
      }
    }

    if (pluginId) {
      const restoredUserFields = originalPlugin
        ? restoreCodexUserOwnedFields(configPath, pluginId, originalPlugin, originalConfigText)
        : true
      const restoredPlugin = readCodexPlugin(configPath, pluginId)
      if (!restoredPlugin || (originalPlugin !== undefined && !codexUserOwnedFieldsMatch(restoredPlugin, originalPlugin))) {
        rollbackAttempted = true
        const rollbackSucceeded = await restoreFiles(backupSnapshot())
        return {
          success: false,
          rollbackAttempted,
          rollbackSucceeded,
          error: { code: 'CODEX_REGISTRATION_MISSING', message: 'Codex did not recreate the selected plugin registration and its preserved fields' },
        }
      }
      if (!restoredUserFields) {
        rollbackAttempted = true
        const rollbackSucceeded = await restoreFiles(backupSnapshot())
        return {
          success: false,
          rollbackAttempted,
          rollbackSucceeded,
          error: { code: 'CODEX_REGISTRATION_MISSING', message: 'Codex plugin registration could not preserve its user-owned fields' },
        }
      }
    }

    const validation = item.steps.find((step) => step.kind === 'validation')
    if (validation && (!existsSync(configPath) || (pluginId !== undefined && !readCodexPlugin(configPath, pluginId)))) {
      rollbackAttempted = true
      const rollbackSucceeded = await restoreFiles(backupSnapshot())
      return {
        success: false,
        rollbackAttempted,
        rollbackSucceeded,
        error: { code: 'CODEX_VALIDATION_FAILED', message: 'Codex configuration was not present after reinstall' },
      }
    }
    return { success: true, rollbackAttempted: false }
  } catch {
    rollbackAttempted = mutationStarted && backupsComplete
    const rollbackSucceeded = rollbackAttempted
      ? await restoreFiles(backupSnapshot())
      : undefined
    return {
      success: false,
      rollbackAttempted,
      rollbackSucceeded,
      error: {
        code: rollbackAttempted ? 'CODEX_TRANSACTION_FAILED' : 'CODEX_BACKUP_FAILED',
        message: rollbackAttempted ? 'Codex replacement transaction failed' : 'Codex backup phase did not complete',
      },
    }
  } finally {
    if (!preserveBackup) {
      await Promise.all([
        removeOwnedPath(configBackupStorage.directory).catch(() => {}),
        removeOwnedPath(cacheBackupStorage.directory).catch(() => {}),
      ])
    }
  }
}

/** Read version evidence from the refreshed Codex cache, never from config.toml. */
export function readCodexPayloadVersion (cachePath: string, pluginId: string): string | undefined {
  return readCodexPayloadVersions(cachePath, pluginId).sort(compareVersions).at(-1)
}

export function readCodexPayloadVersions (cachePath: string, pluginId: string): string[] {
  const pluginName = pluginId.split('@', 1)[0]
  const candidates: string[] = []
  collectPayloadManifests(cachePath, 0, candidates)
  return versionsFromManifests(candidates, pluginName)
}

function readDirectCodexPayloadVersion (cachePath: string, pluginId: string): string | undefined {
  return versionsFromManifests(directPayloadManifests(cachePath), pluginId.split('@', 1)[0]).sort(compareVersions).at(-1)
}

function versionsFromManifests (candidates: string[], pluginName: string): string[] {
  const versions: string[] = []

  for (const filePath of candidates) {
    let value: unknown
    try { value = JSON.parse(readFileSync(filePath, 'utf8')) as unknown } catch { continue }
    if (!isPayloadForPlugin(value, pluginName)) continue
    const object = value as Record<string, unknown>
    const metadata = object.metadata
    const nestedPlugin = object.plugin
    const version = [
      object.version,
      object.pluginVersion,
      object.bundleVersion,
      isRecord(metadata) ? metadata.version : undefined,
      isRecord(nestedPlugin) ? nestedPlugin.version : undefined,
    ].find(isStableVersion)
    if (version && !versions.includes(version)) versions.push(version)
  }
  return versions
}

function collectPayloadManifests (root: string, depth: number, output: string[]): void {
  if (depth > 4 || output.length >= 256) return
  let entries
  try { entries = readdirSync(root, { withFileTypes: true }) } catch { return }
  for (const entry of entries) {
    if (output.length >= 256) return
    const filePath = path.join(root, entry.name)
    if (entry.isDirectory()) collectPayloadManifests(filePath, depth + 1, output)
    else if (entry.isFile() && ['bundle.json', 'plugin.json', 'package.json', 'manifest.json'].includes(entry.name)) output.push(filePath)
  }
}

function directPayloadManifests (root: string): string[] {
  if (existsSync(root) && !isDirectory(root)) return [root]
  return ['bundle.json', 'plugin.json', 'package.json', 'manifest.json']
    .map((name) => path.join(root, name))
    .filter(existsSync)
}

function isPayloadForPlugin (value: unknown, pluginName: string): boolean {
  if (!isRecord(value)) return false
  const identityValues = [value.name, value.id, value.pluginId, value.packageName]
  const nested = value.plugin
  if (isRecord(nested)) identityValues.push(nested.name, nested.id)
  return identityValues.some((identity) => typeof identity === 'string' && (identity === pluginName || identity.startsWith(`${pluginName}@`)))
}

function isRecord (value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function resolveRegisteredPayloadPath (
  configPath: string,
  plugin: Record<string, unknown>
): string | undefined {
  const cacheBase = path.resolve(path.dirname(configPath), 'plugins', 'cache')
  for (const key of ['path', 'installPath', 'cachePath']) {
    const configured = plugin[key]
    if (typeof configured !== 'string' || configured.length === 0) continue
    const candidates = path.isAbsolute(configured)
      ? [path.resolve(configured)]
      : [path.resolve(cacheBase, configured), path.resolve(path.dirname(configPath), configured)]
    const selected = candidates.find((candidate) => isSameOrContained(candidate, cacheBase) && existsSync(candidate))
    if (selected) return selected
  }
  return undefined
}

function hasRegisteredPayloadField (plugin: Record<string, unknown>): boolean {
  return ['path', 'installPath', 'cachePath'].some((key) => typeof plugin[key] === 'string' && plugin[key].length > 0)
}

function resolveVersionedPayloadPath (
  cachePath: string,
  pluginId: string,
  expectedVersion: string
): string | undefined {
  const exactVersionRoot = path.resolve(cachePath, expectedVersion)
  if (
    isSameOrContained(exactVersionRoot, cachePath) &&
    existsSync(exactVersionRoot) &&
    readDirectCodexPayloadVersion(exactVersionRoot, pluginId) === expectedVersion
  ) return exactVersionRoot
  return readDirectCodexPayloadVersion(cachePath, pluginId) === expectedVersion ? cachePath : undefined
}

function isDirectory (filePath: string): boolean {
  try { return readdirSync(filePath).length >= 0 } catch { return false }
}

async function restoreFiles (
  snapshot: CodexBackupSnapshot
): Promise<boolean> {
  try {
    if (snapshot.config.existed && !snapshot.config.complete) return false
    if (snapshot.cache.existed && !snapshot.cache.complete) return false
    if (snapshot.config.complete && snapshot.config.existed) await writeFile(snapshot.config.target, await readFile(snapshot.config.backup), { mode: 0o600 })
    else if (!snapshot.config.existed) await removeOwnedPath(snapshot.config.target)
    if (snapshot.cache.complete && snapshot.cache.existed) {
      await removeOwnedPath(snapshot.cache.target)
      await copyOwnedPath(snapshot.cache.backup, snapshot.cache.target)
    } else if (!snapshot.cache.existed) {
      await removeOwnedPath(snapshot.cache.target)
    }
    const configRestored = snapshot.config.existed ? snapshot.config.complete && existsSync(snapshot.config.backup) && existsSync(snapshot.config.target) : !existsSync(snapshot.config.target)
    const cacheRestored = snapshot.cache.existed ? snapshot.cache.complete && existsSync(snapshot.cache.backup) && existsSync(snapshot.cache.target) : !existsSync(snapshot.cache.target)
    return configRestored && cacheRestored
  } catch {
    return false
  }
}

export function resolveCodexPluginCachePath (
  configPath: string,
  pluginId: string,
  marketplace: string | undefined,
  hintedPath: string | undefined
): string | undefined {
  const cacheBase = path.resolve(path.dirname(configPath), 'plugins', 'cache')
  const pluginName = pluginId.split('@', 1)[0].toLowerCase()
  if (hintedPath) {
    const candidate = path.resolve(hintedPath)
    if (isSameOrContained(candidate, cacheBase) && candidate !== cacheBase && !isBroadCachePath(candidate, cacheBase) && isPluginCacheCandidate(candidate, pluginName)) {
      return candidate
    }
  }

  const directories: string[] = []
  collectDirectories(cacheBase, 0, directories)
  const marketplaceKeys = new Set([
    ...(marketplace ? marketplace.split('/').map((part) => part.replace(/\.git$/, '').toLowerCase()) : []),
    pluginId.split('@')[1]?.toLowerCase(),
  ].filter((value): value is string => typeof value === 'string' && value.length > 0))
  const candidates = directories
    .filter((candidate) => candidate !== cacheBase && !isBroadCachePath(candidate, cacheBase))
    .filter((candidate) => isPluginCacheCandidate(candidate, pluginName))
    .map((candidate) => ({ candidate, score: pluginCacheScore(candidate, pluginName, marketplaceKeys) }))
    .sort((left, right) => right.score - left.score || pathDepth(left.candidate) - pathDepth(right.candidate))
  const best = candidates[0]
  const tied = candidates[1] && candidates[1].score === best?.score && pathDepth(candidates[1].candidate) === pathDepth(best.candidate)
  return best && !tied ? best.candidate : undefined
}

function collectDirectories (root: string, depth: number, output: string[]): void {
  if (depth > 5) return
  let entries
  try { entries = readdirSync(root, { withFileTypes: true }) } catch { return }
  output.push(root)
  for (const entry of entries) {
    if (entry.isDirectory()) collectDirectories(path.join(root, entry.name), depth + 1, output)
  }
}

function isPluginCacheCandidate (candidate: string, pluginName: string): boolean {
  const segments = candidate.toLowerCase().split(path.sep)
  const basename = path.basename(candidate).toLowerCase()
  return basename === pluginName || basename.startsWith(`${pluginName}@`) || segments.includes(pluginName) || readCodexPayloadVersions(candidate, pluginName).length > 0
}

function pluginCacheScore (candidate: string, pluginName: string, marketplaceKeys: ReadonlySet<string>): number {
  const basename = path.basename(candidate).toLowerCase()
  const segments = candidate.toLowerCase().split(path.sep)
  const parent = path.basename(path.dirname(candidate)).toLowerCase()
  const marketplaceMatched = marketplaceKeys.has(parent)
  if (basename === pluginName) return marketplaceMatched ? 220 : 100
  if (basename.startsWith(`${pluginName}@`)) return marketplaceMatched ? 215 : 95
  if (segments.includes(pluginName)) return marketplaceMatched ? 180 : 90
  return 50
}

function isBroadCachePath (candidate: string, cacheBase: string): boolean {
  const basename = path.basename(candidate).toLowerCase()
  return candidate === cacheBase || basename === 'cache' || basename === 'plugins'
}

function pathDepth (filePath: string): number {
  return filePath.split(path.sep).length
}

function isSameOrContained (candidate: string, parent: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate))
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}
