import path from 'node:path'
import { existsSync, unlinkSync } from 'node:fs'
import type { HarnessType, Logger } from '../types.js'
import type { McpTrackingEntry, TrackingData } from '../skills/skill-tracker.js'
import { readTrackingFile, writeTrackingFile } from '../skills/skill-tracker.js'
import { getTrackingFilePath, resolveHome } from '../utils/path.js'

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
    } else {
      tracking.mcpServers.push({
        name: entry.name,
        configPath: path.resolve(resolveHome(entry.configPath)),
        harness,
        configuredAt: now,
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
