import path from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { RunningVersionInfo, VersionInfo, VersionStatus } from './types.js'

export interface ParsedVersion {
  major: number
  minor: number
  patch: number
}

const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

export function parseStableVersion (value: unknown): ParsedVersion | null {
  if (typeof value !== 'string') return null
  const match = value.match(STABLE_VERSION)
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  }
}

export function isStableVersion (value: unknown): value is string {
  return parseStableVersion(value) !== null
}

export function compareVersions (left: string, right: string): number {
  const a = parseStableVersion(left)
  const b = parseStableVersion(right)
  if (!a || !b) throw new Error('Only stable semantic versions can be compared')
  if (a.major !== b.major) return a.major - b.major
  if (a.minor !== b.minor) return a.minor - b.minor
  return a.patch - b.patch
}

export function classifyVersions (current: unknown, latest: unknown): VersionInfo {
  const currentVersion = isStableVersion(current) ? current : undefined
  const latestVersion = isStableVersion(latest) ? latest : undefined
  let status: VersionStatus = 'unknown'

  if (currentVersion && latestVersion) {
    const comparison = compareVersions(currentVersion, latestVersion)
    status = comparison === 0
      ? 'current'
      : comparison < 0
        ? 'update-available'
        : 'newer-than-registry'
  }

  return { current: currentVersion, latest: latestVersion, status }
}

/**
 * Classify every physical copy behind one logical installation. A missing or
 * malformed copy is actionable when a newer package is known: the update can
 * repair that cache even though no version can be read from it.
 */
export function classifyVersionSet (currents: readonly unknown[], latest: unknown): VersionInfo {
  const latestVersion = isStableVersion(latest) ? latest : undefined
  const currentVersions = currents.map((value) => isStableVersion(value) ? value : undefined)
  const stableVersions = currentVersions.filter((value): value is string => value !== undefined)
  let status: VersionStatus = 'unknown'

  if (latestVersion && currentVersions.length > 0) {
    const hasMissing = stableVersions.length !== currentVersions.length
    const hasOlder = stableVersions.some((value) => compareVersions(value, latestVersion) < 0)
    const allPresent = stableVersions.length === currentVersions.length && stableVersions.length > 0
    const hasNewer = stableVersions.some((value) => compareVersions(value, latestVersion) > 0)
    if (hasMissing || hasOlder) status = 'update-available'
    else if (allPresent && hasNewer) status = 'newer-than-registry'
    else if (allPresent) status = 'current'
  } else if (stableVersions.length === currentVersions.length && stableVersions.length > 0) {
    status = 'unknown'
  }

  const current = stableVersions.length > 0
    ? [...stableVersions].sort(compareVersions)[0]
    : undefined
  return { current, latest: latestVersion, status, currentVersions }
}

export function readRunningVersionInfo (packageRoot = defaultPackageRoot()): RunningVersionInfo {
  const packageJson = readJson(path.join(packageRoot, 'package.json')) as { version?: unknown }
  const bundle = readJson(path.join(packageRoot, 'bundle.json')) as { version?: unknown }
  if (!isStableVersion(packageJson.version)) throw new Error('Package version is missing or invalid')
  if (!isStableVersion(bundle.version)) throw new Error('Bundle version is missing or invalid')
  return { cliVersion: packageJson.version, bundleVersion: bundle.version }
}

/** Find the nearest package root containing both runtime manifests. */
export function resolvePackageRoot (startDir = path.dirname(fileURLToPath(import.meta.url))): string {
  let candidate = path.resolve(startDir)
  while (true) {
    if (existsSync(path.join(candidate, 'package.json')) && existsSync(path.join(candidate, 'bundle.json'))) return candidate
    const parent = path.dirname(candidate)
    if (parent === candidate) break
    candidate = parent
  }
  throw new Error(`Package root could not be resolved from ${path.resolve(startDir)}`)
}

export function readPackageVersion (packageRoot: string): string | undefined {
  try {
    const value = (readJson(path.join(packageRoot, 'package.json')) as { version?: unknown }).version
    return isStableVersion(value) ? value : undefined
  } catch {
    return undefined
  }
}

function readJson (filePath: string): unknown {
  return JSON.parse(readFileSync(filePath, 'utf8')) as unknown
}

function defaultPackageRoot (): string {
  return resolvePackageRoot()
}
