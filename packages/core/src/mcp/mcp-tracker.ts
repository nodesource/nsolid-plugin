import path from 'node:path'
import { existsSync, unlinkSync } from 'node:fs'
import { createHash } from 'node:crypto'
import type { HarnessType, Logger } from '../types.js'
import type { McpTrackingEntry, TrackingData } from '../skills/skill-tracker.js'
import { readTrackingFile, writeTrackingFile } from '../skills/skill-tracker.js'
import { getTrackingFilePath, resolveHome } from '../utils/path.js'
import { readJsonFile, readJsoncFile, readTomlFile } from '../utils/config.js'

export type { McpTrackingEntry } from '../skills/skill-tracker.js'

function createEmptyTracking (harness: HarnessType): TrackingData {
  return {
    version: '1.0.0',
    installedAt: new Date().toISOString(),
    harness,
    skills: [],
    mcpServers: [],
  }
}

export async function addTrackedMcps (
  entries: { name: string; configPath: string }[],
  harness: HarnessType,
  logger?: Logger
): Promise<void> {
  const tracking = (await readTrackingFile(logger)) ?? createEmptyTracking(harness)
  const now = new Date().toISOString()

  for (const entry of entries) {
    const existing = tracking.mcpServers.find(
      (m) => m.name === entry.name && m.harness === harness
    )

    if (existing) {
      existing.configPath = path.resolve(resolveHome(entry.configPath))
      existing.configuredAt = now
      existing.fields = readOwnedFieldDigests(existing.configPath, existing.name)
    } else {
      tracking.mcpServers.push({
        name: entry.name,
        configPath: path.resolve(resolveHome(entry.configPath)),
        harness,
        configuredAt: now,
        fields: readOwnedFieldDigests(path.resolve(resolveHome(entry.configPath)), entry.name),
      })
    }
  }

  await writeTrackingFile(tracking, logger)
}

function readOwnedFieldDigests (configPath: string, name: string): Record<string, string> | undefined {
  try {
    const raw = configPath.endsWith('.toml')
      ? readTomlFile<Record<string, unknown>>(configPath)
      : configPath.endsWith('.jsonc')
        ? readJsoncFile<Record<string, unknown>>(configPath)
        : readJsonFile<Record<string, unknown>>(configPath)
    if (!raw) return undefined
    const servers = (raw.mcpServers ?? raw.mcp_servers ?? raw.mcp) as unknown
    if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return undefined
    const server = (servers as Record<string, unknown>)[name]
    if (!server || typeof server !== 'object' || Array.isArray(server)) return undefined
    return Object.fromEntries(Object.entries(server as Record<string, unknown>).map(([field, value]) => [field, digest(value)]))
  } catch { return undefined }
}

function digest (value: unknown): string {
  return createHash('sha256').update(JSON.stringify(stableValue(value)) ?? 'undefined').digest('hex')
}

function stableValue (value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, stableValue(child)]))
  }
  return value
}

export async function removeTrackedMcps (
  serverNames: string[],
  harness?: HarnessType,
  logger?: Logger
): Promise<void> {
  const tracking = await readTrackingFile(logger)
  if (!tracking) return

  tracking.mcpServers = tracking.mcpServers.filter((entry) => {
    if (harness !== undefined) {
      return !(serverNames.includes(entry.name) && entry.harness === harness)
    }
    return !serverNames.includes(entry.name)
  })

  if (tracking.skills.length === 0 && tracking.mcpServers.length === 0) {
    const filePath = getTrackingFilePath()
    if (existsSync(filePath)) {
      unlinkSync(filePath)
    }
  } else {
    await writeTrackingFile(tracking, logger)
  }
}

export async function listTrackedMcps (
  harness?: HarnessType,
  logger?: Logger
): Promise<McpTrackingEntry[]> {
  const tracking = await readTrackingFile(logger)
  if (!tracking) return []

  if (harness !== undefined) {
    return tracking.mcpServers.filter((entry) => entry.harness === harness)
  }

  return tracking.mcpServers
}
