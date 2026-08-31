import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import type { HarnessType, McpServerRef } from '../types.js'
import { resolveHome } from '../utils/path.js'
import { readJsonFile, readTomlFile, readJsoncFile, writeTomlFileSync } from '../utils/config.js'
import { atomicWriteSync, ensureDir } from '../utils/fs.js'
import { mergeMcpConfig, removeMcpServers, expandVariables } from './mcp-config-merger.js'
import type { NormalizedMcpConfig } from './mcp-config-merger.js'
import { editMcpJsonBytes } from '../update/mcp-edit.js'
import { createConfigBackup } from '../utils/backup.js'
import type { Logger } from '../types.js'

export type ConfigFormat = 'json' | 'toml' | 'jsonc'

interface ConfigInfo {
  configPath: string
  format: ConfigFormat
  jsonMcpKey?: 'mcpServers' | 'mcp'
}

function formatFromPath (configPath: string): ConfigFormat {
  if (configPath.endsWith('.toml')) return 'toml'
  if (configPath.endsWith('.jsonc')) return 'jsonc'
  return 'json'
}

function getMcpConfigInfo (harness: HarnessType): ConfigInfo | null {
  switch (harness) {
    case 'claude':
      return { configPath: resolveHome('~/.claude.json'), format: 'json' }
    case 'codex':
      return { configPath: resolveHome('~/.codex/config.toml'), format: 'toml' }
    case 'opencode':
      return { configPath: resolveHome('~/.config/opencode/opencode.jsonc'), format: 'jsonc', jsonMcpKey: 'mcp' }
    case 'antigravity':
      return { configPath: resolveHome('~/.gemini/config/mcp_config.json'), format: 'json' }
    case 'pi':
      return { configPath: resolveHome('~/.pi/agent/mcp.json'), format: 'json' }
  }
}

function readJsonObjectAllowEmpty (configPath: string): Record<string, unknown> | null {
  if (!existsSync(configPath)) return null
  const raw = readFileSync(configPath, 'utf-8')
  if (raw.trim().length === 0) return {}
  return readJsonFile<Record<string, unknown>>(configPath)
}

function readJsoncObjectAllowEmpty (configPath: string): Record<string, unknown> | null {
  if (!existsSync(configPath)) return null
  const raw = readFileSync(configPath, 'utf-8')
  if (raw.trim().length === 0) return {}
  return readJsoncFile<Record<string, unknown>>(configPath)
}

export function readExistingConfig (
  configPath: string,
  format: ConfigFormat,
  jsonMcpKey: 'mcpServers' | 'mcp' = 'mcpServers'
): NormalizedMcpConfig {
  switch (format) {
    case 'json': {
      const data = readJsonObjectAllowEmpty(configPath)
      if (!data) return { mcpServers: {} }
      return normalizeFromJson(data, jsonMcpKey)
    }
    case 'toml': {
      const data = readTomlFile<Record<string, unknown>>(configPath)
      if (!data) return { mcpServers: {} }
      return normalizeFromToml(data)
    }
    case 'jsonc': {
      const data = readJsoncObjectAllowEmpty(configPath)
      if (!data) return { mcpServers: {} }
      return normalizeFromJson(data, jsonMcpKey)
    }
  }
}

function normalizeFromJson (data: Record<string, unknown>, jsonMcpKey: 'mcpServers' | 'mcp'): NormalizedMcpConfig {
  const mcpRaw = data[jsonMcpKey]
  if (mcpRaw && typeof mcpRaw === 'object' && !Array.isArray(mcpRaw)) {
    const raw = mcpRaw as Record<string, Record<string, unknown>>
    const servers: NormalizedMcpConfig['mcpServers'] = {}
    for (const [name, srv] of Object.entries(raw)) {
      const url = srv.url ?? srv.serverUrl
      if (typeof url === 'string') {
        servers[name] = {
          ...srv,
          url,
          headers: (srv.headers || {}) as Record<string, string>,
        }
      } else {
        // Preserve non-URL MCP entries (for example Claude stdio servers with
        // command/args) instead of normalizing them into broken `{ url: '' }`
        // configs when we merge NodeSource's remote servers.
        servers[name] = { ...srv } as unknown as NormalizedMcpConfig['mcpServers'][string]
      }
    }
    return { mcpServers: servers }
  }
  return { mcpServers: {} }
}

function normalizeFromToml (data: Record<string, unknown>): NormalizedMcpConfig {
  const mcpServersRaw = data.mcp_servers
  if (mcpServersRaw && typeof mcpServersRaw === 'object' && !Array.isArray(mcpServersRaw)) {
    return { mcpServers: mcpServersRaw as NormalizedMcpConfig['mcpServers'] }
  }
  return { mcpServers: {} }
}

function writeConfigFile (
  configPath: string,
  format: ConfigFormat,
  config: NormalizedMcpConfig,
  jsonMcpKey: 'mcpServers' | 'mcp' = 'mcpServers'
): void {
  ensureDir(path.dirname(configPath))

  switch (format) {
    case 'json':
    case 'jsonc': {
      // Localized AST edits: only servers whose value actually changes are
      // rewritten, so comments, CRLF endings, indentation, and foreign
      // servers survive byte-for-byte.
      const raw = existsSync(configPath) ? readFileSync(configPath, 'utf-8') : ''
      const existingRaw = raw
      const existingParsed = format === 'jsonc' ? readJsoncObjectAllowEmpty(configPath) : readJsonObjectAllowEmpty(configPath)
      const existingServers = (existingParsed?.[jsonMcpKey] && typeof existingParsed[jsonMcpKey] === 'object' && !Array.isArray(existingParsed[jsonMcpKey])
        ? existingParsed[jsonMcpKey]
        : {}) as Record<string, unknown>
      const upsertServers: Record<string, unknown> = {}
      for (const [name, value] of Object.entries(config.mcpServers)) {
        if (JSON.stringify(existingServers[name]) !== JSON.stringify(value)) upsertServers[name] = value
      }
      const removeServers = Object.keys(existingServers).filter((name) => !(name in config.mcpServers))
      // The OpenCode harness stores servers under "mcp"; a legacy
      // "mcpServers" container from older versions is migrated away
      // wholesale, exactly as the previous block-rewriting writer did.
      const legacyKey = jsonMcpKey === 'mcp' && existingParsed && existingParsed.mcpServers !== undefined
        ? 'mcpServers'
        : undefined
      const next = editMcpJsonBytes(existingRaw, {
        upsertServers,
        removeServers,
        removeBlock: format === 'jsonc' && Object.keys(config.mcpServers).length === 0,
        removeKeys: legacyKey ? [legacyKey] : undefined,
      }, { mcpKey: jsonMcpKey })
      atomicWriteSync(configPath, next.endsWith('\n') ? next : next + '\n')
      break
    }
    case 'toml':
      writeTomlConfig(configPath, config)
      break
  }
}

function writeTomlConfig (configPath: string, config: NormalizedMcpConfig): void {
  const tomlData: Record<string, unknown> = readTomlFile<Record<string, unknown>>(configPath) ?? {}

  if (Object.keys(config.mcpServers).length > 0) {
    const servers: Record<string, unknown> = {}
    for (const [name, srv] of Object.entries(config.mcpServers)) {
      // Preserve the full server object. Rebuilding entries from a url/headers
      // whitelist hollowed out third-party stdio servers (command, args, env,
      // nested tools.* tables) on every write — the TOML counterpart of the
      // JSON fix in normalizeFromJson. smol-toml omits undefined-valued keys,
      // so servers without headers never emit an empty headers table.
      servers[name] = { ...srv }
    }
    tomlData.mcp_servers = servers
  } else {
    delete tomlData.mcp_servers
  }
  writeTomlFileSync(configPath, tomlData)
}

/**
 * Apply harness-specific MCP server schema before writing to disk.
 *
 * Antigravity stores the endpoint as `serverUrl`; every other harness uses
 * `url`. This is the SINGLE source of truth for that conversion: the install
 * path (`writeMcpConfig`), the adapter-backed `writeAdapterMcpConfig`, and
 * the uninstall path (`removeMcpConfig`) all route through here, so they can
 * never drift (previously the conversion was duplicated inline here and again
 * in the Antigravity adapter, and removeMcpConfig skipped it entirely).
 */
function backupMcpConfig (
  harness: HarnessType,
  configPath: string,
  logger?: Logger
): void {
  try {
    createConfigBackup(harness, configPath, { reason: 'pre-write' })
  } catch (err) {
    // Backup failure is a warning, not fatal. The user can still retry from
    // version control or manual backups.
    logger?.warn('mcp.config.backup.failed', { harness, configPath, error: (err as Error).message })
  }
}

/** Harness-specific server schema applied before bytes reach a config file. */
export function applyHarnessWriteFormat (
  harness: HarnessType,
  config: NormalizedMcpConfig
): NormalizedMcpConfig {
  if (harness === 'claude') {
    const servers = {} as NormalizedMcpConfig['mcpServers']
    for (const [name, srv] of Object.entries(config.mcpServers)) {
      if (typeof srv.url === 'string' && srv.url.length > 0 && srv.command === undefined) {
        servers[name] = {
          ...srv,
          type: srv.type ?? 'http',
        }
      } else {
        servers[name] = srv
      }
    }
    return { mcpServers: servers }
  }

  if (harness === 'opencode') {
    const servers = {} as NormalizedMcpConfig['mcpServers']
    for (const [name, srv] of Object.entries(config.mcpServers)) {
      if (typeof srv.url === 'string' && srv.url.length > 0 && srv.command === undefined) {
        servers[name] = {
          ...srv,
          type: srv.type ?? 'remote',
          enabled: srv.enabled ?? true,
          headers: srv.headers ?? {},
        }
      } else {
        servers[name] = srv
      }
    }
    return { mcpServers: servers }
  }

  if (harness === 'pi') {
    const servers = {} as NormalizedMcpConfig['mcpServers']
    for (const [name, srv] of Object.entries(config.mcpServers)) {
      if (typeof srv.url === 'string' && srv.url.length > 0 && srv.command === undefined) {
        servers[name] = {
          ...srv,
          auth: srv.auth ?? false,
          headers: srv.headers ?? {},
        }
      } else {
        servers[name] = srv
      }
    }
    return { mcpServers: servers }
  }

  if (harness !== 'antigravity') return config

  const servers = {} as NormalizedMcpConfig['mcpServers']
  for (const [name, srv] of Object.entries(config.mcpServers)) {
    if (typeof srv.url === 'string') {
      const { url: _url, ...rest } = srv
      servers[name] = {
        ...rest,
        serverUrl: srv.url,
        headers: srv.headers ?? {},
      } as unknown as NormalizedMcpConfig['mcpServers'][string]
    } else {
      servers[name] = srv
    }
  }
  return { mcpServers: servers }
}

// --- Public API ---

export async function writeMcpConfig (
  harness: HarnessType,
  servers: McpServerRef[],
  variables?: Record<string, string>,
  options?: { configPath?: string; logger?: Logger }
): Promise<void> {
  const info = getMcpConfigInfo(harness)
  const resolvedPath = options?.configPath ?? info?.configPath
  if (!resolvedPath) return
  const format = options?.configPath
    ? formatFromPath(resolvedPath)
    : (info?.format ?? formatFromPath(resolvedPath))
  const jsonMcpKey = info?.jsonMcpKey ?? 'mcpServers'

  let resolvedServers = servers
  if (variables) {
    resolvedServers = expandVariables(servers, variables)
  }

  const existing = readExistingConfig(resolvedPath, format, jsonMcpKey)
  const merged = mergeMcpConfig(existing, resolvedServers)

  backupMcpConfig(harness, resolvedPath, options?.logger)
  writeConfigFile(resolvedPath, format, applyHarnessWriteFormat(harness, merged), jsonMcpKey)
  options?.logger?.info('mcp.config.write', { harness, configPath: resolvedPath })
}

export function writeAdapterMcpConfig (
  harness: HarnessType,
  config: NormalizedMcpConfig,
  logger?: Logger
): void {
  const info = getMcpConfigInfo(harness)
  if (!info) return
  backupMcpConfig(harness, info.configPath, logger)
  writeConfigFile(info.configPath, info.format, applyHarnessWriteFormat(harness, config), info.jsonMcpKey ?? 'mcpServers')
  logger?.info('mcp.config.write', { harness, configPath: info.configPath })
}

export async function removeMcpConfig (
  harness: HarnessType,
  serverNames: string[],
  options?: { configPath?: string; logger?: Logger }
): Promise<void> {
  const info = getMcpConfigInfo(harness)
  const resolvedPath = options?.configPath ?? info?.configPath
  if (!resolvedPath) return
  if (!existsSync(resolvedPath)) return
  const format = options?.configPath
    ? formatFromPath(resolvedPath)
    : (info?.format ?? formatFromPath(resolvedPath))
  const jsonMcpKey = info?.jsonMcpKey ?? 'mcpServers'

  const existing = readExistingConfig(resolvedPath, format, jsonMcpKey)
  const result = removeMcpServers(existing, serverNames)

  backupMcpConfig(harness, resolvedPath, options?.logger)
  writeConfigFile(resolvedPath, format, applyHarnessWriteFormat(harness, result), jsonMcpKey)
  options?.logger?.info('mcp.config.remove', { harness, configPath: resolvedPath, serverNames })
}
