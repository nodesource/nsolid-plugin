import os from 'node:os'
import path from 'node:path'
import { readJsonFile } from '../utils/config.js'

/**
 * Native package detection for the Pi Agent harness.
 *
 * Pi is package-owned: `pi install npm:nsolid-pi-plugin` installs skills via a
 * real npm package rather than the shared CLI tracking file. These helpers
 * discover that package on disk (from `~/.pi/agent/settings.json` `packages`
 * entries or the canonical npm install location) so both `doctor` and the
 * Pi adapter can report it without the CLI tracking file.
 *
 * Extracted from `index.ts` so the Pi adapter and `doctor()` share one source
 * of truth.
 */

export const PI_PLUGIN_PACKAGE_NAME = 'nsolid-pi-plugin'

function readPiPackageSourceEntries (settingsPath: string): string[] {
  let settings: { packages?: Array<string | { source?: string }> } | null = null
  try {
    settings = readJsonFile<{ packages?: Array<string | { source?: string }> }>(settingsPath)
  } catch {
    return []
  }
  if (!settings || !Array.isArray(settings.packages)) return []

  return settings.packages
    .map((entry) => typeof entry === 'string' ? entry : entry.source)
    .filter((source): source is string => typeof source === 'string' && source.length > 0)
}

function packageNameFromNpmSource (source: string): string | null {
  if (!source.startsWith('npm:')) return null
  const spec = source.slice('npm:'.length)
  if (spec.startsWith('@')) {
    const [scope, name] = spec.split('/')
    if (!scope || !name) return null
    return `${scope}/${name.split('@')[0]}`
  }
  return spec.split('@')[0] || null
}

function resolvePiPackageRootFromSource (source: string, settingsDir: string): string | null {
  const npmPackageName = packageNameFromNpmSource(source)
  if (npmPackageName) {
    if (npmPackageName !== PI_PLUGIN_PACKAGE_NAME) return null
    return path.join(settingsDir, 'npm', 'node_modules', PI_PLUGIN_PACKAGE_NAME)
  }

  if (source.startsWith('git:') || source.startsWith('http://') || source.startsWith('https://') || source.startsWith('ssh://')) {
    return null
  }

  return path.resolve(settingsDir, source)
}

export function findPiPluginPackageRoots (): string[] {
  const settingsPaths = [
    path.join(os.homedir(), '.pi', 'agent', 'settings.json'),
    path.resolve('.pi', 'settings.json'),
  ]
  const roots = new Set<string>()

  for (const settingsPath of settingsPaths) {
    const settingsDir = path.dirname(settingsPath)
    for (const source of readPiPackageSourceEntries(settingsPath)) {
      const root = resolvePiPackageRootFromSource(source, settingsDir)
      if (root) roots.add(root)
    }
  }

  roots.add(path.join(os.homedir(), '.pi', 'agent', 'npm', 'node_modules', PI_PLUGIN_PACKAGE_NAME))
  return [...roots]
}

/**
 * Skill roots declared by each installed Pi package. A package without an
 * explicit `pi.skills` array defaults to `./skills` (matching the package
 * generator and the install test).
 */
export function findPiPluginSkillRoots (): string[] {
  const skillRoots: string[] = []
  for (const packageRoot of findPiPluginPackageRoots()) {
    const pkgPath = path.join(packageRoot, 'package.json')
    let pkg: { name?: string; pi?: { skills?: string[] } } | null = null
    try {
      pkg = readJsonFile<{ name?: string; pi?: { skills?: string[] } }>(pkgPath)
    } catch {
      continue
    }
    if (pkg?.name !== PI_PLUGIN_PACKAGE_NAME) continue

    const configuredSkillRoots = Array.isArray(pkg.pi?.skills) && pkg.pi!.skills.length > 0
      ? pkg.pi!.skills
      : ['./skills']
    for (const skillRoot of configuredSkillRoots) {
      skillRoots.push(path.resolve(packageRoot, skillRoot))
    }
  }
  return skillRoots
}

/** True when a nsolid-pi-plugin package root exists on disk. */
export function piPluginInstalled (): boolean {
  return findPiPluginPackageRoots().some((root) => {
    try {
      const pkg = readJsonFile<{ name?: string }>(path.join(root, 'package.json'))
      return pkg?.name === PI_PLUGIN_PACKAGE_NAME
    } catch {
      return false
    }
  })
}
