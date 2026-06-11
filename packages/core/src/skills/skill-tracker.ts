import path from 'node:path'
import { existsSync, unlinkSync } from 'node:fs'
import type { HarnessType, SkillRef } from '../types.js'
import { getSkillsDir, getTrackingFilePath } from '../utils/path.js'
import { readJsonFile } from '../utils/config.js'
import { writeJsonFile, ensureDir } from '../utils/fs.js'

export interface SkillTrackingEntry {
  name: string;
  path: string;
  installedAt: string;
  harnesses: string[];
}

export interface McpTrackingEntry {
  name: string;
  configPath: string;
  harness: string;
  configuredAt: string;
}

export interface TrackingData {
  version: string;
  installedAt: string;
  harness: string;
  skills: SkillTrackingEntry[];
  mcpServers: McpTrackingEntry[];
}

export async function readTrackingFile (): Promise<TrackingData | null> {
  try {
    return readJsonFile<TrackingData>(getTrackingFilePath())
  } catch {
    return null
  }
}

export async function writeTrackingFile (data: TrackingData): Promise<void> {
  const filePath = getTrackingFilePath()
  ensureDir(path.dirname(filePath))
  await writeJsonFile(filePath, data)
}

export async function addTrackedSkills (
  skills: SkillRef[],
  harness: HarnessType
): Promise<void> {
  const tracking = (await readTrackingFile()) ?? createEmptyTracking(harness)
  const now = new Date().toISOString()

  for (const skill of skills) {
    const normalizedPath = path.resolve(path.join(getSkillsDir(), skill.name))
    const existing = tracking.skills.find((s) => s.name === skill.name)

    if (existing) {
      const harnessSet = new Set(existing.harnesses)
      harnessSet.add(harness)
      existing.harnesses = [...harnessSet]
    } else {
      tracking.skills.push({
        name: skill.name,
        path: normalizedPath,
        installedAt: now,
        harnesses: [harness],
      })
    }
  }

  await writeTrackingFile(tracking)
}

export async function removeTrackedSkills (
  skills: SkillRef[],
  harness?: HarnessType
): Promise<void> {
  const tracking = await readTrackingFile()
  if (!tracking) return

  for (const skill of skills) {
    const entry = tracking.skills.find((s) => s.name === skill.name)
    if (!entry) continue

    if (harness) {
      entry.harnesses = entry.harnesses.filter((h) => h !== harness)
      if (entry.harnesses.length === 0) {
        tracking.skills = tracking.skills.filter((s) => s.name !== skill.name)
      }
    } else {
      tracking.skills = tracking.skills.filter((s) => s.name !== skill.name)
    }
  }

  if (tracking.skills.length === 0 && tracking.mcpServers.length === 0) {
    const filePath = getTrackingFilePath()
    if (existsSync(filePath)) {
      unlinkSync(filePath)
    }
  } else {
    await writeTrackingFile(tracking)
  }
}

export async function listTrackedSkills (): Promise<SkillTrackingEntry[]> {
  const tracking = await readTrackingFile()
  return tracking?.skills ?? []
}

function createEmptyTracking (harness: HarnessType): TrackingData {
  return {
    version: '1.0.0',
    installedAt: new Date().toISOString(),
    harness,
    skills: [],
    mcpServers: [],
  }
}
