import path from 'node:path'
import { existsSync, unlinkSync } from 'node:fs'
import type { HarnessType, Logger } from '../types.js'
import type { McpTrackingEntry, TrackingData } from '../skills/skill-tracker.js'
import { readTrackingFile, writeTrackingFile } from '../skills/skill-tracker.js'
import { getTrackingFilePath, resolveHome } from '../utils/path.js'
import { harnessMcpKey, readMcpFieldDigests } from '../update/mcp-lookup.js'

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
  entries: { name: string; configPath: string; ownedFields?: readonly string[] }[],
  harness: HarnessType,
  logger?: Logger
): Promise<void> {
  const tracking = (await readTrackingFile(logger)) ?? createEmptyTracking(harness)
  const now = new Date().toISOString()

  for (const entry of entries) {
    const existing = tracking.mcpServers.find(
      (m) => m.name === entry.name && m.harness === harness
    )

    const configPath = path.resolve(resolveHome(entry.configPath))
    // Tracking evidence describes the same container the transaction reads and
    // writes for this harness: the field-digests module is the single source
    // of truth for both the container selection and the digest computation.
    // Ownership evidence must never describe fields the user added: tracked
    // fields absent from the desired render get removed on the next refresh.
    const digests = readMcpFieldDigests(configPath, entry.name, { preferredKey: harnessMcpKey(harness) })
    const fields = entry.ownedFields === undefined || digests === undefined
      ? digests
      : Object.fromEntries(Object.entries(digests).filter(([name]) => entry.ownedFields!.includes(name)))
    if (existing) {
      existing.configPath = configPath
      existing.configuredAt = now
      existing.fields = fields
    } else {
      tracking.mcpServers.push({
        name: entry.name,
        configPath,
        harness,
        configuredAt: now,
        fields,
      })
    }
  }

  await writeTrackingFile(tracking, logger)
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
