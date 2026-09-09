import { createHash } from 'node:crypto'
import { parseJsonc, readJsoncFile, readTomlFile } from '../utils/config.js'
import { parse as parseToml } from 'smol-toml'
import type { HarnessType } from '../types.js'

export type PreferredMcpKey = 'mcp' | 'mcpServers'

/** The JSON container key each harness reads and writes. */
export function harnessMcpKey (harness: HarnessType): PreferredMcpKey {
  return harness === 'opencode' ? 'mcp' : 'mcpServers'
}

/**
 * Single source of truth for choosing the MCP container inside a parsed JSON
 * document: the harness-preferred key wins; the legacy key is only a fallback
 * when the preferred key is absent.
 */
export function selectMcpContainer (
  parsed: Record<string, unknown> | null | undefined,
  preferredKey: PreferredMcpKey
): Record<string, unknown> | undefined {
  if (!parsed) return undefined
  const isContainer = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === 'object' && !Array.isArray(value)
  const preferred = parsed[preferredKey]
  if (Object.hasOwn(parsed, preferredKey) && !isContainer(preferred)) return undefined
  if (isContainer(preferred)) return preferred
  const legacyKey: PreferredMcpKey = preferredKey === 'mcp' ? 'mcpServers' : 'mcp'
  const legacy = parsed[legacyKey]
  if (isContainer(legacy)) return legacy
  return undefined
}

function serversOf (
  parsed: Record<string, unknown> | null,
  configPath: string,
  preferredKey: PreferredMcpKey
): Record<string, unknown> | undefined {
  if (!parsed) return undefined
  if (configPath.endsWith('.toml')) {
    const servers = parsed.mcp_servers
    return servers && typeof servers === 'object' && !Array.isArray(servers) ? servers as Record<string, unknown> : undefined
  }
  return selectMcpContainer(parsed, preferredKey)
}

function parseConfigByPath (configPath: string, raw?: string): Record<string, unknown> | null {
  if (raw !== undefined) {
    return configPath.endsWith('.toml')
      ? parseToml(raw) as Record<string, unknown>
      : parseJsonc(raw) as Record<string, unknown>
  }
  if (configPath.endsWith('.toml')) return readTomlFile<Record<string, unknown>>(configPath)
  // JSONC parsing is a superset of JSON parsing, so both .json and .jsonc
  // configuration files tolerate comments here.
  return readJsoncFile<Record<string, unknown>>(configPath)
}

/**
 * Single source of truth for reading MCP server records from a harness
 * configuration file. The planner, the journal, and the child transaction all
 * route through here so ownership rules cannot drift between them.
 */
export function readMcpConfigFile (configPath: string): Record<string, unknown> | null {
  return parseConfigByPath(configPath)
}

/** The raw record of one MCP server, or undefined when absent. */
export function readMcpServerRecord (configPath: string, name: string, options?: { preferredKey?: PreferredMcpKey }): Record<string, unknown> | undefined {
  try {
    const servers = serversOf(readMcpConfigFile(configPath), configPath, options?.preferredKey ?? 'mcpServers')
    const record = servers?.[name]
    return record && typeof record === 'object' && !Array.isArray(record) ? record as Record<string, unknown> : undefined
  } catch { return undefined }
}

/** One field of an MCP server record, or undefined when absent. */
export function readMcpServerField (configPath: string, server: string, field: string, options?: { preferredKey?: PreferredMcpKey }): unknown {
  const record = readMcpServerRecord(configPath, server, options)
  return record?.[field]
}

/** Per-field digests of one MCP server record (the tracking evidence shape). */
export function readMcpFieldDigests (configPath: string, name: string, options?: { preferredKey?: PreferredMcpKey }): Record<string, string> | undefined {
  const record = readMcpServerRecord(configPath, name, options)
  if (!record) return undefined
  return Object.fromEntries(Object.entries(record).map(([field, value]) => [field, valueDigest(value)]))
}

/**
 * Per-field digests computed from candidate configuration bytes rather than
 * the live file, so tracking evidence can describe the post-swap state. Uses
 * the same container selection as live reads.
 */
export function mcpFieldDigestsFromBytes (configPath: string, bytes: Buffer | string, name: string, options?: { preferredKey?: PreferredMcpKey }): Record<string, string> | undefined {
  try {
    const text = typeof bytes === 'string' ? bytes : bytes.toString('utf8')
    const parsed = parseConfigByPath(configPath, text)
    const servers = serversOf(parsed, configPath, options?.preferredKey ?? 'mcpServers')
    const record = servers?.[name]
    if (!record || typeof record !== 'object' || Array.isArray(record)) return undefined
    return Object.fromEntries(Object.entries(record as Record<string, unknown>).map(([field, value]) => [field, valueDigest(value)]))
  } catch { return undefined }
}

/**
 * Single source of truth for the per-field digest evidence stored in tracking
 * entries and verified by the ownership gate. Field digests are computed from
 * a stable serialization so nested objects compare equal regardless of key
 * order, exactly as `JSON.stringify` produced them when planning.
 */
export function valueDigest (value: unknown): string {
  return createHash('sha256').update(JSON.stringify(stableValue(value)) ?? 'undefined').digest('hex')
}

function stableValue (value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, stableValue(child)]))
  }
  return value
}
