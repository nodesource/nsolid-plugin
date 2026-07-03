import { spawn } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import path from 'node:path'
import type { Logger } from '../types.js'
import type { HarnessAdapter, NativePluginStatus } from './harness-adapter.js'
import { resolveHome } from '../utils/path.js'
import { readJsonFile, readTomlFile, writeTomlFileSync } from '../utils/config.js'
import { writeJsonFileSync } from '../utils/fs.js'
import { createConfigBackup } from '../utils/backup.js'
import { PLUGIN_BASE_NAME } from './plugin-name.js'

/**
 * Spawns a harness CLI command, resolving with the exit code. Rejects on failure
 * to spawn (e.g. binary not installed) or on timeout (the `timeout` option sends
 * SIGTERM, after which `close` fires with `code === null` and a `signal`).
 * Never rejects on a non-zero exit, so callers can decide whether to fall back.
 */
export function runHarnessCli (cmd: string, args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'ignore', timeout: 15000 })
    child.on('error', reject)
    child.on('close', (code, signal) => {
      // A non-null signal (e.g. SIGTERM from timeout) means the process did not
      // exit cleanly — treat it as a failure so the config-file fallback runs.
      if (signal !== null && signal !== undefined) {
        reject(new Error(`"${cmd}" terminated by ${signal}`))
        return
      }
      resolve(code ?? 0)
    })
  })
}

interface RemovalResult {
  removed: boolean
  warnings: string[]
}

/** Injectable runner so tests can force the fallback path without spawning. */
type CliRunner = (cmd: string, args: string[]) => Promise<number>

/**
 * Remove the nsolid native plugin for a harness. Strategy: prefer the harness's
 * own CLI (correct bookkeeping for caches/indexes), then fall back to directly
 * editing the harness's config files when the CLI is absent or didn't clear it.
 * Returns whether the plugin is gone afterwards and any non-fatal warnings.
 */
export async function removeNativePlugin (
  harness: string,
  adapter: HarnessAdapter,
  options?: { logger?: Logger; runCli?: CliRunner }
): Promise<RemovalResult> {
  const logger = options?.logger
  const runCli = options?.runCli ?? runHarnessCli
  const warnings: string[] = []
  if (!adapter.detectNativePlugin) {
    return { removed: true, warnings }
  }

  const detected = adapter.detectNativePlugin()
  if (!detected.installed) {
    return { removed: true, warnings }
  }

  const ids = concreteIds(detected)
  logger?.info('uninstall.nativePlugin.start', { harness, ids })

  // 1. Delegate to the harness CLI when available.
  const delegated = await delegateToHarnessCli(harness, ids, runCli, logger).catch(() => false)

  // 2. If the CLI didn't fully clear the install (absent, failed, or exited 0
  //    but left stale state such as a manifest entry), hand-edit the config
  //    files directly to reconcile. Verification below still has the final say.
  if (!delegated || adapter.detectNativePlugin().installed) {
    await fallbackEdit(harness, adapter, ids, logger).catch((err) => {
      warnings.push(`Could not fully remove native plugin for ${harness}: ${(err as Error).message}`)
    })
  }

  // 3. Verify.
  const rechecked = adapter.detectNativePlugin()
  if (rechecked.installed) {
    warnings.push(
      `Native plugin still present for ${harness}; remove it manually via the harness CLI (e.g. ${manualHint(harness, ids)}).`
    )
    return { removed: false, warnings }
  }

  logger?.info('uninstall.nativePlugin.done', { harness })
  return { removed: true, warnings }
}

function concreteIds (detected: NativePluginStatus): string[] {
  if (detected.installedIds && detected.installedIds.length > 0) {
    return detected.installedIds
  }
  // Adapter didn't surface concrete ids — best-effort the base name.
  return [detected.label ?? PLUGIN_BASE_NAME]
}

async function delegateToHarnessCli (
  harness: string,
  ids: string[],
  runCli: CliRunner,
  logger?: Logger
): Promise<boolean> {
  // Antigravity keys plugins by base name, not `<name>@<marketplace>`.
  const targets = harness === 'antigravity' ? [PLUGIN_BASE_NAME] : ids
  let anySucceeded = false
  for (const target of targets) {
    const [cmd, ...args] = cliCommand(harness, target)
    if (!cmd) continue
    try {
      const code = await runCli(cmd, args)
      if (code === 0) {
        anySucceeded = true
        logger?.info('uninstall.nativePlugin.cli', { harness, cmd })
      }
    } catch {
      // Binary not installed or spawn failed — fall back below.
      return false
    }
  }
  return anySucceeded
}

function cliCommand (harness: string, id: string): string[] {
  switch (harness) {
    case 'claude':
      return ['claude', 'plugin', 'uninstall', id]
    case 'codex':
      return ['codex', 'plugin', 'remove', id]
    case 'antigravity':
      return ['agy', 'plugin', 'uninstall', PLUGIN_BASE_NAME]
    default:
      return []
  }
}

function manualHint (harness: string, ids: string[]): string {
  const id = ids[0] ?? PLUGIN_BASE_NAME
  switch (harness) {
    case 'claude':
      return `claude plugin uninstall ${id}`
    case 'codex':
      return `codex plugin remove ${id}`
    case 'antigravity':
      return `agy plugin uninstall ${PLUGIN_BASE_NAME}`
    default:
      return ''
  }
}

/**
 * Direct config-file edits as a fallback when the harness CLI is unavailable.
 * Each path backs up the file before mutating and preserves unrelated entries.
 */
async function fallbackEdit (harness: string, adapter: HarnessAdapter, ids: string[], logger?: Logger): Promise<void> {
  switch (harness) {
    case 'claude':
      await editClaude(adapter, ids, logger)
      break
    case 'codex':
      await editCodex(adapter, ids, logger)
      break
    case 'antigravity':
      await editAntigravity(logger)
      break
  }
}

async function editClaude (adapter: HarnessAdapter, ids: string[], logger?: Logger): Promise<void> {
  const installedPath = resolveHome('~/.claude/plugins/installed_plugins.json')
  if (existsSync(installedPath)) {
    createConfigBackup('claude', installedPath, { reason: 'uninstall-native-plugin' })
    const data = readJsonFile<{ version?: number; plugins?: Record<string, unknown> }>(installedPath)
    if (data?.plugins) {
      let changed = false
      for (const id of ids) {
        if (id in data.plugins) { delete data.plugins[id]; changed = true }
      }
      if (changed) writeJsonFileSync(installedPath, data)
    }
  }

  // Clear the enable map entries in ~/.claude.json.
  const claudeJsonPath = adapter.getMcpConfigPath()
  if (claudeJsonPath && existsSync(claudeJsonPath)) {
    createConfigBackup('claude', claudeJsonPath, { reason: 'uninstall-native-plugin' })
    const data = readJsonFile<Record<string, unknown>>(claudeJsonPath)
    if (data?.enabledPlugins && typeof data.enabledPlugins === 'object') {
      const map = data.enabledPlugins as Record<string, unknown>
      let changed = false
      for (const id of ids) {
        if (id in map) { delete map[id]; changed = true }
      }
      if (changed) writeJsonFileSync(claudeJsonPath, data)
    }
  }

  // Best-effort cache cleanup. The cache may be keyed by marketplace name.
  const cacheBase = resolveHome('~/.claude/plugins/cache')
  if (existsSync(cacheBase)) {
    for (const id of ids) {
      const marketplace = id.includes('@') ? id.split('@')[1] : undefined
      if (marketplace) {
        const dir = path.join(cacheBase, marketplace, PLUGIN_BASE_NAME)
        if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
      }
    }
  }
  logger?.info('uninstall.nativePlugin.fallback', { harness: 'claude', ids })
}

async function editCodex (adapter: HarnessAdapter, ids: string[], logger?: Logger): Promise<void> {
  const configPath = adapter.getMcpConfigPath()
  if (!configPath || !existsSync(configPath)) return
  createConfigBackup('codex', configPath, { reason: 'uninstall-native-plugin' })
  const data = readTomlFile<Record<string, unknown>>(configPath)
  if (!data?.plugins || typeof data.plugins !== 'object') return
  const plugins = data.plugins as Record<string, unknown>
  let changed = false
  for (const id of ids) {
    if (id in plugins) { delete plugins[id]; changed = true }
  }
  if (changed) writeTomlFileSync(configPath, data)
  logger?.info('uninstall.nativePlugin.fallback', { harness: 'codex', ids })
}

async function editAntigravity (logger?: Logger): Promise<void> {
  const pluginDir = resolveHome('~/.gemini/config/plugins/nsolid-plugin')
  if (existsSync(pluginDir)) {
    rmSync(pluginDir, { recursive: true, force: true })
  }

  const manifestPath = resolveHome('~/.gemini/config/import_manifest.json')
  if (existsSync(manifestPath)) {
    createConfigBackup('antigravity', manifestPath, { reason: 'uninstall-native-plugin' })
    const data = readJsonFile<{ imports?: Array<{ name?: string }> }>(manifestPath)
    if (data?.imports) {
      const before = data.imports.length
      data.imports = data.imports.filter((entry) => entry?.name !== PLUGIN_BASE_NAME)
      if (data.imports.length !== before) writeJsonFileSync(manifestPath, data)
    }
  }
  logger?.info('uninstall.nativePlugin.fallback', { harness: 'antigravity' })
}
