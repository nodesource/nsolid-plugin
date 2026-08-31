import { readFile, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { findNodeAtLocation, getNodeValue, parseTree, type Node } from 'jsonc-parser'
import { resolveHome } from '../utils/path.js'
import type { CommandRunner, UpdateError, UpdatePlanItem } from './types.js'
import { isStableVersion } from './version.js'
import { copyOwnedPath, createSiblingBackupPath, ownedPathKind, removeOwnedPath } from './fs-transaction.js'
import type { SiblingBackupPath } from './fs-transaction.js'
import { runTransactionCommands } from './transaction-commands.js'
import { nativePayloadTreeDigest } from './native-payload.js'

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

/** Injectable dependencies for deterministic tests. */
export interface AntigravityTransactionDependencies {
  restoreState?: () => Promise<boolean>
}

export async function executeAntigravityTransaction (
  item: UpdatePlanItem,
  commandRunner: CommandRunner,
  dependencies: AntigravityTransactionDependencies = {}
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
  let originalManifestText: string | undefined
  // Exact post-mutation state this transaction is authorized to replace
  // during rollback.
  let authorizedRootDigest: string | null | undefined
  let authorizedManifestDigest: string | null | undefined
  const backupSnapshot = (): AntigravityBackupSnapshot => ({
    root: { target: pluginRoot, backup: rootBackup, existed: rootExisted, complete: rootBackupComplete },
    manifest: { target: manifestPath, backup: manifestBackup, existed: manifestExisted, complete: manifestBackupComplete },
  })
  // Single guarded post-mutation rollback path: a failed restore always
  // preserves both sibling backup containers for manual recovery.
  let rollbackSucceeded: boolean | undefined
  const attemptRollback = async (): Promise<boolean> => {
    rollbackAttempted = true
    const succeeded = await (dependencies.restoreState
      ? dependencies.restoreState()
      : restore(backupSnapshot(), { rootDigest: authorizedRootDigest, manifestDigest: authorizedManifestDigest }))
    rollbackSucceeded = succeeded
    if (!succeeded) preserveBackup = true
    return succeeded
  }

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
        const originalManifest = await readFile(manifestPath)
        originalManifestText = originalManifest.toString('utf8')
        await writeFile(manifestBackup, originalManifest, { mode: 0o600 })
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
    // Capture the exact post-mutation state this transaction is authorized to
    // replace during rollback, whether the commands succeeded or not.
    authorizedRootDigest = existsSync(pluginRoot) ? treeDigest(pluginRoot) : null
    authorizedManifestDigest = existsSync(manifestPath) ? sha256Hex(readFileSync(manifestPath)) : null
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
      await attemptRollback()
      return {
        success: false,
        rollbackAttempted,
        rollbackSucceeded,
        error: result.spawnErrorCode === 'ENOENT'
          ? { code: 'MISSING_EXECUTABLE', message: 'agy executable was not found on PATH' }
          : { code: result.timedOut ? 'ANTIGRAVITY_COMMAND_TIMEOUT' : 'ANTIGRAVITY_COMMAND_FAILED', message: 'Antigravity plugin replacement command failed' },
      }
    }

    if (!validateStagedPlugin(pluginRoot, manifestPath, item.version.latest, item.artifact?.kind === 'git' ? item.artifact.contentDigest : undefined) ||
      (originalManifestText !== undefined && !preservesUnrelatedManifestBytes(originalManifestText, readFileSync(manifestPath, 'utf8')))) {
      await attemptRollback()
      return {
        success: false,
        rollbackAttempted,
        rollbackSucceeded,
        error: { code: 'ANTIGRAVITY_VALIDATION_FAILED', message: 'Antigravity staged plugin or import manifest did not validate' },
      }
    }
    return { success: true, rollbackAttempted: false }
  } catch {
    if (backupsComplete && mutationStarted) await attemptRollback()
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
    if (expectedDigest && nativePayloadTreeDigest(pluginRoot) !== expectedDigest) return false
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

/**
 * Byte-level preservation check for the Antigravity import manifest.
 *
 * An import belongs to this plugin only when its key is exactly
 * `nsolid-plugin` or its value declares exactly `name`/`plugin:
 * nsolid-plugin`. Everything outside the owned node(s) — comments, CRLF line
 * endings, indentation, sibling imports such as `my-nsolid-plugin-helper` —
 * must remain byte-for-byte identical.
 */
export function preservesUnrelatedManifestBytes (beforeText: string, afterText: string): boolean {
  try {
    const beforeRanges = locateOwnImportRanges(beforeText)
    if (beforeRanges.length === 0) return afterText === beforeText
    const afterRanges = locateOwnImportRanges(afterText)
    if (afterRanges.length === 0) return false
    const outsideBefore = removeRanges(beforeText, beforeRanges)
    const outsideAfter = removeRanges(afterText, afterRanges)
    if (outsideBefore !== outsideAfter) return false
    // Anchor the position of the owned node relative to the untouched bytes.
    const first = beforeRanges[0]
    const last = beforeRanges[beforeRanges.length - 1]
    return afterText.startsWith(beforeText.slice(0, first.start)) && afterText.endsWith(beforeText.slice(last.end))
  } catch {
    return false
  }
}

interface ByteRange { start: number; end: number }

function removeRanges (text: string, ranges: readonly ByteRange[]): string {
  let result = ''
  let cursor = 0
  for (const range of ranges) {
    result += text.slice(cursor, range.start)
    cursor = range.end
  }
  return result + text.slice(cursor)
}

function locateOwnImportRanges (text: string): ByteRange[] {
  const tree = parseTree(text)
  if (!tree || tree.type !== 'object') throw new Error('manifest is not a JSON object')
  const imports = findNodeAtLocation(tree, ['imports'])
  if (!imports) return []
  const ranges: ByteRange[] = []
  if (imports.type === 'array') {
    for (const item of imports.children ?? []) {
      if (isPluginImport(getNodeValue(item))) ranges.push({ start: item.offset, end: item.offset + item.length })
    }
  } else if (imports.type === 'object') {
    for (const property of imports.children ?? []) {
      const keyNode: Node | undefined = property.children?.[0]
      const valueNode: Node | undefined = property.children?.[1]
      if (!keyNode || !valueNode) continue
      const key = getNodeValue(keyNode)
      if (key === 'nsolid-plugin' || isPluginImport(getNodeValue(valueNode))) {
        ranges.push({ start: property.offset, end: property.offset + property.length })
      }
    }
  }
  return ranges.sort((left, right) => left.start - right.start)
}

function isPluginImport (entry: unknown): boolean {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false
  const value = entry as { name?: unknown; plugin?: unknown }
  return value.name === 'nsolid-plugin' || value.plugin === 'nsolid-plugin'
}

function treeDigest (target: string): string | undefined {
  return nativePayloadTreeDigest(target)
}

function sha256Hex (value: Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

async function restore (
  snapshot: AntigravityBackupSnapshot,
  authorized: { rootDigest?: string | null; manifestDigest?: string | null }
): Promise<boolean> {
  try {
    const rootOriginalDigest = snapshot.root.existed ? treeDigest(snapshot.root.backup) : null
    const manifestOriginalDigest = snapshot.manifest.existed ? sha256Hex(readFileSync(snapshot.manifest.backup)) : null
    if (!snapshot.root.complete || !snapshot.manifest.complete) return false
    // Only restore while the live bytes are still exactly the state this
    // transaction produced (or its original state). Concurrent drift is never
    // overwritten.
    const currentRootDigest = existsSync(snapshot.root.target) ? treeDigest(snapshot.root.target) : null
    const expectedRoot = authorized.rootDigest !== undefined ? authorized.rootDigest : rootOriginalDigest
    if (currentRootDigest !== expectedRoot) return false
    const currentManifestDigest = existsSync(snapshot.manifest.target) ? sha256Hex(readFileSync(snapshot.manifest.target)) : null
    const expectedManifest = authorized.manifestDigest !== undefined ? authorized.manifestDigest : manifestOriginalDigest
    if (currentManifestDigest !== expectedManifest) return false
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
    if (snapshot.root.existed && treeDigest(snapshot.root.target) !== rootOriginalDigest) return false
    if (snapshot.manifest.existed && sha256Hex(readFileSync(snapshot.manifest.target)) !== manifestOriginalDigest) return false
    return snapshot.root.existed && snapshot.manifest.existed ? validateStagedPlugin(snapshot.root.target, snapshot.manifest.target) : true
  } catch {
    return false
  }
}
