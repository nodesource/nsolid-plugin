import { readFile, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { resolveHome } from '../utils/path.js'
import type { CommandRunner, UpdateError, UpdatePlanItem } from './types.js'
import { isStableVersion } from './version.js'
import { createHash } from 'node:crypto'
import { copyOwnedPath, createSiblingBackupPath, ownedPathKind, removeOwnedPath } from './fs-transaction.js'
import type { SiblingBackupPath } from './fs-transaction.js'
import { runTransactionCommands } from './transaction-commands.js'

export interface AntigravityTransactionResult {
  success: boolean
  rollbackAttempted: boolean
  rollbackSucceeded?: boolean
  error?: UpdateError
}

interface AntigravityBackupSnapshot {
  root: { target: string; backup: string; existed: boolean; complete: boolean }
  manifest: { target: string; backup: string; existed: boolean; complete: boolean }
}

export async function executeAntigravityTransaction (
  item: UpdatePlanItem,
  commandRunner: CommandRunner
): Promise<AntigravityTransactionResult> {
  if (item.source.kind !== 'antigravity-git') {
    return { success: false, rollbackAttempted: false, error: { code: 'INVALID_ANTIGRAVITY_SOURCE', message: 'Antigravity source is not the fixed GitHub root' } }
  }
  const pluginRoot = resolveHome(item.source.layout.pluginRoot)
  const manifestPath = resolveHome(item.source.layout.manifestPath)
  const rootKind = await ownedPathKind(pluginRoot)
  const manifestKind = await ownedPathKind(manifestPath)
  if (manifestKind !== 'missing' && manifestKind !== 'file') {
    return { success: false, rollbackAttempted: false, error: { code: 'ANTIGRAVITY_MANIFEST_KIND_UNSUPPORTED', message: 'Antigravity import manifest must be a regular file for transactional replacement' } }
  }
  // Allocate backup storage before any mutation. A missing parent directory
  // (e.g. `~/.gemini/config/plugins` absent while a manifest is present) makes
  // mkdtemp reject with ENOENT; that must surface as a structured failure,
  // never as an escaped rejected promise. Any partially allocated backup
  // directory is removed.
  let rootBackupStorage: SiblingBackupPath | undefined
  let manifestBackupStorage: SiblingBackupPath | undefined
  try {
    rootBackupStorage = await createSiblingBackupPath(pluginRoot, 'plugin-backup')
    manifestBackupStorage = await createSiblingBackupPath(manifestPath, 'manifest-backup')
  } catch {
    await Promise.all([
      rootBackupStorage ? removeOwnedPath(rootBackupStorage.directory).catch(() => {}) : Promise.resolve(),
      manifestBackupStorage ? removeOwnedPath(manifestBackupStorage.directory).catch(() => {}) : Promise.resolve(),
    ])
    return {
      success: false,
      rollbackAttempted: false,
      error: { code: 'ANTIGRAVITY_BACKUP_FAILED', message: 'Antigravity plugin or import manifest backup could not be completed' },
    }
  }
  const rootBackup = rootBackupStorage.path
  const manifestBackup = manifestBackupStorage.path
  const rootExisted = rootKind !== 'missing'
  const manifestExisted = manifestKind !== 'missing'
  let rootBackupComplete = !rootExisted
  let manifestBackupComplete = !manifestExisted
  let backupsComplete = false
  let mutationStarted = false
  let rollbackAttempted = false
  let preserveBackup = false
  const backupSnapshot = (): AntigravityBackupSnapshot => ({
    root: { target: pluginRoot, backup: rootBackup, existed: rootExisted, complete: rootBackupComplete },
    manifest: { target: manifestPath, backup: manifestBackup, existed: manifestExisted, complete: manifestBackupComplete },
  })

  try {
    // Do not enter rollback handling until every original asset has a complete
    // backup. A failed recursive copy may leave rootBackup present but
    // incomplete; treating mere existence as proof would destroy the live AGY
    // plugin while restoring a partial tree.
    try {
      if (rootExisted) {
        await copyOwnedPath(pluginRoot, rootBackup)
        rootBackupComplete = true
      }
      if (manifestExisted) {
        await writeFile(manifestBackup, await readFile(manifestPath), { mode: 0o600 })
        manifestBackupComplete = true
      }
      backupsComplete = rootBackupComplete && manifestBackupComplete
    } catch {
      return {
        success: false,
        rollbackAttempted: false,
        error: { code: 'ANTIGRAVITY_BACKUP_FAILED', message: 'Antigravity plugin or import manifest backup could not be completed' },
      }
    }

    mutationStarted = true
    const commandResult = await runTransactionCommands(item.steps, commandRunner)
    if (!commandResult.success) {
      const { result } = commandResult
      if (result.timedOut && result.treeTerminated !== true) {
        preserveBackup = true
        return {
          success: false,
          rollbackAttempted: false,
          error: {
            code: 'ANTIGRAVITY_TREE_TERMINATION_UNCONFIRMED',
            message: `Antigravity timed out and descendant termination could not be confirmed; backups were preserved at ${rootBackupStorage.directory} and ${manifestBackupStorage.directory}`,
          },
        }
      }
      rollbackAttempted = true
      const rollbackSucceeded = await restore(backupSnapshot())
      return {
        success: false,
        rollbackAttempted,
        rollbackSucceeded,
        error: result.spawnErrorCode === 'ENOENT'
          ? { code: 'MISSING_EXECUTABLE', message: 'agy executable was not found on PATH' }
          : { code: result.timedOut ? 'ANTIGRAVITY_COMMAND_TIMEOUT' : 'ANTIGRAVITY_COMMAND_FAILED', message: 'Antigravity plugin replacement command failed' },
      }
    }

    if (!validateStagedPlugin(pluginRoot, manifestPath, item.version.latest, item.artifact?.kind === 'git' ? item.artifact.contentDigest : undefined)) {
      rollbackAttempted = true
      const rollbackSucceeded = await restore(backupSnapshot())
      return {
        success: false,
        rollbackAttempted,
        rollbackSucceeded,
        error: { code: 'ANTIGRAVITY_VALIDATION_FAILED', message: 'Antigravity staged plugin or import manifest did not validate' },
      }
    }
    return { success: true, rollbackAttempted: false }
  } catch {
    rollbackAttempted = backupsComplete && mutationStarted
    const rollbackSucceeded = rollbackAttempted
      ? await restore(backupSnapshot())
      : undefined
    return {
      success: false,
      rollbackAttempted,
      rollbackSucceeded,
      error: {
        code: rollbackAttempted ? 'ANTIGRAVITY_TRANSACTION_FAILED' : 'ANTIGRAVITY_BACKUP_FAILED',
        message: rollbackAttempted ? 'Antigravity replacement transaction failed' : 'Antigravity backup phase did not complete',
      },
    }
  } finally {
    if (!preserveBackup) {
      await Promise.all([
        removeOwnedPath(rootBackupStorage.directory).catch(() => {}),
        removeOwnedPath(manifestBackupStorage.directory).catch(() => {}),
      ])
    }
  }
}

export function validateStagedPlugin (pluginRoot: string, manifestPath: string, expectedVersion?: string, expectedDigest?: string): boolean {
  if (!existsSync(path.join(pluginRoot, 'plugin.json'))) return false
  if (!existsSync(path.join(pluginRoot, 'bundle.json'))) return false
  if (!existsSync(path.join(pluginRoot, 'skills'))) return false
  try {
    const plugin = JSON.parse(readFileSync(path.join(pluginRoot, 'plugin.json'), 'utf8')) as unknown
    if (!plugin || typeof plugin !== 'object') return false
    const bundle = JSON.parse(readFileSync(path.join(pluginRoot, 'bundle.json'), 'utf8')) as { version?: unknown; skills?: Array<{ name?: unknown; path?: unknown }> }
    if (expectedVersion !== undefined && (!isStableVersion(bundle.version) || bundle.version !== expectedVersion)) return false
    if (expectedDigest && createHash('sha256').update(readFileSync(path.join(pluginRoot, 'bundle.json'))).digest('hex') !== expectedDigest) return false
    if (!Array.isArray(bundle.skills) || bundle.skills.length === 0) return false
    for (const skill of bundle.skills) {
      if (typeof skill.name !== 'string' || typeof skill.path !== 'string') return false
      if (path.isAbsolute(skill.path) || skill.path.split(/[\\/]+/).includes('..')) return false
      if (!existsSync(path.join(pluginRoot, skill.path, 'SKILL.md'))) return false
    }
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { imports?: unknown }
    if (Array.isArray(manifest.imports)) return manifest.imports.some((entry) => isPluginImport(entry))
    if (manifest.imports && typeof manifest.imports === 'object') {
      return Object.entries(manifest.imports as Record<string, unknown>).some(([key, value]) =>
        key.includes('nsolid-plugin') || isPluginImport(value))
    }
    return false
  } catch {
    return false
  }
}

function isPluginImport (entry: unknown): boolean {
  if (!entry || typeof entry !== 'object') return false
  const value = entry as { name?: unknown; plugin?: unknown }
  return value.name === 'nsolid-plugin' || value.plugin === 'nsolid-plugin'
}

async function restore (
  snapshot: AntigravityBackupSnapshot
): Promise<boolean> {
  try {
    if (!snapshot.root.complete || !snapshot.manifest.complete) return false
    if (snapshot.root.existed) {
      await removeOwnedPath(snapshot.root.target)
      await copyOwnedPath(snapshot.root.backup, snapshot.root.target)
    } else {
      await removeOwnedPath(snapshot.root.target)
    }
    if (snapshot.manifest.existed) await writeFile(snapshot.manifest.target, await readFile(snapshot.manifest.backup), { mode: 0o600 })
    else await removeOwnedPath(snapshot.manifest.target)
    const rootRestored = snapshot.root.existed ? existsSync(snapshot.root.target) : !existsSync(snapshot.root.target)
    const manifestRestored = snapshot.manifest.existed ? existsSync(snapshot.manifest.target) : !existsSync(snapshot.manifest.target)
    if (!rootRestored || !manifestRestored) return false
    return snapshot.root.existed && snapshot.manifest.existed ? validateStagedPlugin(snapshot.root.target, snapshot.manifest.target) : true
  } catch {
    return false
  }
}
