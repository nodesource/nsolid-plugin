import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import type { HarnessType, McpServerRef } from '../types.js'
import { resolveHome } from '../utils/path.js'
import { readJsonFile, readTomlFile, readJsoncFile, writeTomlFileSync } from '../utils/config.js'
import { writeJsonFileSync, atomicWriteSync, ensureDir } from '../utils/fs.js'
import { mergeMcpConfig, removeMcpServers, expandVariables } from './mcp-config-merger.js'
import type { NormalizedMcpConfig } from './mcp-config-merger.js'
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
    case 'json': {
      const existingFull = readJsonObjectAllowEmpty(configPath) ?? {}
      existingFull[jsonMcpKey] = config.mcpServers
      if (jsonMcpKey === 'mcp') delete existingFull.mcpServers
      writeJsonFileSync(configPath, existingFull)
      break
    }
    case 'toml':
      writeTomlConfig(configPath, config)
      break
    case 'jsonc':
      writeJsoncConfig(configPath, config, jsonMcpKey)
      break
  }
}

function writeTomlConfig (configPath: string, config: NormalizedMcpConfig): void {
  const tomlData: Record<string, unknown> = readTomlFile<Record<string, unknown>>(configPath) ?? {}

  if (Object.keys(config.mcpServers).length > 0) {
    const servers: Record<string, unknown> = {}
    for (const [name, srv] of Object.entries(config.mcpServers)) {
      servers[name] = {
        url: srv.url,
        headers: srv.headers,
      }
    }
    tomlData.mcp_servers = servers
  } else {
    delete tomlData.mcp_servers
  }
  writeTomlFileSync(configPath, tomlData)
}

// --- JSONC comment-preserving write ---

function writeJsoncConfig (
  configPath: string,
  config: NormalizedMcpConfig,
  jsonMcpKey: 'mcpServers' | 'mcp'
): void {
  if (!existsSync(configPath)) {
    atomicWriteSync(configPath, JSON.stringify({ [jsonMcpKey]: config.mcpServers }, null, 2) + '\n')
    return
  }

  let raw = readFileSync(configPath, 'utf-8')
  if (jsonMcpKey === 'mcp') {
    raw = removeMcpServersBlockFromRaw(raw, 'mcpServers')
  }
  const serverNames = Object.keys(config.mcpServers)
  const mcpBlock = findMcpServersBlock(raw, jsonMcpKey)

  if (serverNames.length === 0) {
    atomicWriteSync(configPath, removeMcpServersBlockFromRaw(raw, jsonMcpKey))
    return
  }

  if (mcpBlock) {
    const indent = detectIndent(raw, mcpBlock.openBrace)
    const innerIndent = indent.repeat(2)

    const innerContent = serverNames
      .map((name) => innerIndent + JSON.stringify(name) + ': ' + JSON.stringify(config.mcpServers[name]))
      .join(',\n')

    const before = raw.slice(0, mcpBlock.openBrace + 1)
    const after = raw.slice(mcpBlock.closeBrace)
    const updated = before + '\n' + innerContent + '\n' + indent + after
    atomicWriteSync(configPath, updated)
    return
  }

  // No MCP key in existing file — insert before outer closing brace
  atomicWriteSync(configPath, insertMcpBlockBeforeClosing(raw, config.mcpServers, jsonMcpKey))
}

function findMcpServersBlock (
  raw: string,
  jsonMcpKey: 'mcpServers' | 'mcp'
): { start: number; openBrace: number; closeBrace: number } | null {
  const escapedKey = jsonMcpKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const keyMatch = raw.match(new RegExp(`"${escapedKey}"\\s*:\\s*\\{`))
  if (!keyMatch || keyMatch.index === undefined) return null

  const start = keyMatch.index
  const openBrace = keyMatch.index + keyMatch[0].length - 1
  const closeBrace = findMatchingBrace(raw, openBrace)
  if (closeBrace === -1) return null

  return { start, openBrace, closeBrace }
}

function findMatchingBrace (str: string, openIndex: number): number {
  let depth = 0
  let inString = false
  let escaped = false

  for (let i = openIndex; i < str.length; i++) {
    const ch = str[i]

    if (ch === '"' && !escaped) inString = !inString

    if (!inString) {
      if (ch === '{') depth++
      if (ch === '}') {
        depth--
        if (depth === 0) return i
      }
    }

    escaped = ch === '\\' && !escaped
    if (ch !== '\\') escaped = false
  }

  return -1
}

function detectIndent (raw: string, bracePos: number): string {
  const lineStart = raw.lastIndexOf('\n', bracePos)
  if (lineStart === -1) return '  '

  const line = raw.slice(lineStart + 1, bracePos)
  const match = line.match(/^(\s+)/)
  return match ? match[1] : '  '
}

function insertMcpBlockBeforeClosing (
  raw: string,
  mcpServers: NormalizedMcpConfig['mcpServers'],
  jsonMcpKey: 'mcpServers' | 'mcp'
): string {
  const outerCloseBrace = findOuterClosingBrace(raw)
  if (outerCloseBrace === -1) {
    return JSON.stringify({ [jsonMcpKey]: mcpServers }, null, 2) + '\n'
  }

  const indent = detectIndent(raw, outerCloseBrace)
  const innerIndent = indent.repeat(2)
  const serverNames = Object.keys(mcpServers)

  const innerContent = serverNames
    .map((name) => innerIndent + JSON.stringify(name) + ': ' + JSON.stringify(mcpServers[name]))
    .join(',\n')

  const mcpServersBlock = JSON.stringify(jsonMcpKey) + ': {\n' + innerContent + '\n' + indent + '}'

  const before = raw.slice(0, outerCloseBrace)
  const after = raw.slice(outerCloseBrace)
  const beforeTrimmed = before.trimEnd()
  const hasContentAfterOpen = raw.slice(raw.indexOf('{') + 1, outerCloseBrace).trim().length > 0
  const separator = (hasContentAfterOpen && !beforeTrimmed.endsWith(',')) ? ',\n' : '\n'

  return before + separator + indent + mcpServersBlock + '\n' + after
}

function findOuterClosingBrace (raw: string): number {
  let depth = 0
  let lastCloseBrace = -1
  let inString = false
  let escaped = false

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]

    if (ch === '"' && !escaped) inString = !inString

    if (!inString) {
      if (ch === '{') depth++
      if (ch === '}') {
        depth--
        if (depth === 0) lastCloseBrace = i
      }
    }

    escaped = ch === '\\' && !escaped
    if (ch !== '\\') escaped = false
  }

  return lastCloseBrace
}

function removeMcpServersBlockFromRaw (raw: string, jsonMcpKey: 'mcpServers' | 'mcp'): string {
  const block = findMcpServersBlock(raw, jsonMcpKey)
  if (!block) return raw

  const before = raw.slice(0, block.start).trimEnd()
  const after = raw.slice(block.closeBrace + 1)

  // Remove trailing comma before the block if present
  if (before.endsWith(',')) {
    return before.slice(0, -1) + '\n' + after.trimStart()
  }

  // Otherwise, remove leading comma from after if present
  const trimmedAfter = after.trimStart()
  if (trimmedAfter.startsWith(',')) {
    return before + '\n' + trimmedAfter.slice(1).trimStart()
  }

  return before + after
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

function applyHarnessWriteFormat (
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
