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
  /** SHA-256 evidence for each NodeSource-owned field in the server object. */
  fields?: Record<string, string>;
}

export interface TrackingData {
  version: string;
  installedAt: string;
  harness: string;
  /** Version of the bundle used by the last owned refresh, when known. */
  bundleVersion?: string;
  /** Version evidence keyed by the fallback harness that was refreshed. */
  bundleVersions?: Partial<Record<HarnessType, string>>;
  skills: SkillTrackingEntry[];
  mcpServers: McpTrackingEntry[];
}

export async function readTrackingFile (logger?: Logger): Promise<TrackingData | null> {
  try {
    const value = readJsonFile<unknown>(getTrackingFilePath())
    if (!isValidTrackingData(value)) {
      logger?.warn('tracking.read.invalid', { path: getTrackingFilePath() })
      return null
    }
    return value
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

export async function setTrackingBundleVersion (bundleVersion: string, logger?: Logger, harness?: HarnessType): Promise<void> {
  const tracking = await readTrackingFile(logger)
  if (!tracking) return
  tracking.bundleVersion = bundleVersion
  if (harness) tracking.bundleVersions = { ...(tracking.bundleVersions ?? {}), [harness]: bundleVersion }
  await writeTrackingFile(tracking, logger)
}

export function isValidTrackingData (value: unknown): value is TrackingData {
  if (!isRecord(value) || typeof value.version !== 'string' || typeof value.installedAt !== 'string' || typeof value.harness !== 'string') return false
  if (!Array.isArray(value.skills) || !Array.isArray(value.mcpServers)) return false
  if (value.bundleVersion !== undefined && typeof value.bundleVersion !== 'string') return false
  if (value.bundleVersions !== undefined) {
    if (!isRecord(value.bundleVersions) || Object.values(value.bundleVersions).some((version) => typeof version !== 'string')) return false
  }
  if (value.skills.some((entry) => !isValidSkillTrackingEntry(entry))) return false
  return !value.mcpServers.some((entry) => !isValidMcpTrackingEntry(entry))
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
      const previousHarnesses = existing.harnesses
      const previousPaths = { ...(existing.paths ?? {}) }
      for (const trackedHarness of previousHarnesses) {
        previousPaths[trackedHarness] ??= existing.path
      }
      const harnessSet = new Set(previousHarnesses)
      harnessSet.add(harness)
      existing.harnesses = [...harnessSet]
      existing.paths = { ...previousPaths, [harness]: normalizedPath }
      if (previousHarnesses.length === 1 && previousHarnesses[0] === harness) {
        existing.path = normalizedPath
      }
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
      if (entry.paths) delete entry.paths[harness]
      if (entry.harnesses.length === 0) {
        tracking.skills = tracking.skills.filter((s) => s.name !== skill.name)
      } else {
        entry.path = entry.paths?.[entry.harnesses[0]] ?? entry.path
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

function isValidSkillTrackingEntry (value: unknown): value is SkillTrackingEntry {
  if (!isRecord(value) || typeof value.name !== 'string' || typeof value.path !== 'string' || typeof value.installedAt !== 'string' || !Array.isArray(value.harnesses)) return false
  if (value.harnesses.some((harness) => typeof harness !== 'string')) return false
  if (value.paths !== undefined && (!isRecord(value.paths) || Object.values(value.paths).some((entry) => typeof entry !== 'string'))) return false
  return true
}

function isValidMcpTrackingEntry (value: unknown): value is McpTrackingEntry {
  return isRecord(value) && typeof value.name === 'string' && typeof value.configPath === 'string' && typeof value.harness === 'string' && typeof value.configuredAt === 'string' && (value.fields === undefined || (isRecord(value.fields) && Object.values(value.fields).every((field) => typeof field === 'string')))
}

function isRecord (value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
