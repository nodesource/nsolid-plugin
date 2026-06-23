import path from 'node:path'
import { existsSync, unlinkSync } from 'node:fs'
import type { HarnessType, Logger, SkillRef } from '../types.js'
import { getSkillsDir, getTrackingFilePath } from '../utils/path.js'
import { readJsonFile } from '../utils/config.js'
import { writeJsonFile, ensureDir } from '../utils/fs.js'
import { formatPluginError, toPluginError } from '../errors.js'

export interface SkillTrackingEntry {
  name: string;
  path: string;
  paths?: Record<string, string>;
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

export async function readTrackingFile (logger?: Logger): Promise<TrackingData | null> {
  try {
    return readJsonFile<TrackingData>(getTrackingFilePath())
  } catch (err) {
    logger?.warn('tracking.read.failed', { error: (err as Error).message })
    return null
  }
}

export async function writeTrackingFile (data: TrackingData, logger?: Logger): Promise<void> {
  const filePath = getTrackingFilePath()
  ensureDir(path.dirname(filePath))
  try {
    await writeJsonFile(filePath, data)
    logger?.debug('tracking.write', { skills: data.skills.length, mcpServers: data.mcpServers.length })
  } catch (err) {
    const pluginErr = toPluginError(err, 'TRACKING_UPDATE_FAILED', { path: filePath })
    throw new Error(formatPluginError(pluginErr), { cause: pluginErr })
  }
}

export async function addTrackedSkills (
  skills: SkillRef[],
  harness: HarnessType,
  logger?: Logger,
  skillsDir = getSkillsDir()
): Promise<void> {
  const tracking = (await readTrackingFile(logger)) ?? createEmptyTracking(harness)
  const now = new Date().toISOString()

  for (const skill of skills) {
    const normalizedPath = path.resolve(path.join(skillsDir, skill.name))
    const existing = tracking.skills.find((s) => s.name === skill.name)

    if (existing) {
      const harnessSet = new Set(existing.harnesses)
      harnessSet.add(harness)
      existing.harnesses = [...harnessSet]
      existing.path = normalizedPath
      existing.paths = { ...(existing.paths ?? {}), [harness]: normalizedPath }
    } else {
      tracking.skills.push({
        name: skill.name,
        path: normalizedPath,
        paths: { [harness]: normalizedPath },
        installedAt: now,
        harnesses: [harness],
      })
    }
  }

  await writeTrackingFile(tracking, logger)
}

export async function removeTrackedSkills (
  skills: SkillRef[],
  harness?: HarnessType,
  logger?: Logger
): Promise<void> {
  const tracking = await readTrackingFile(logger)
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
      try {
        unlinkSync(filePath)
        logger?.debug('tracking.delete', { reason: 'empty' })
      } catch (err) {
        const pluginErr = toPluginError(err, 'TRACKING_UPDATE_FAILED', { path: filePath })
        throw new Error(formatPluginError(pluginErr), { cause: pluginErr })
      }
    }
  } else {
    await writeTrackingFile(tracking, logger)
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
