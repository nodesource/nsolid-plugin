import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync, lstatSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { BundleDescriptor, Credentials, HarnessType } from '../types.js'
import { validateBundle } from '../validate.js'
import { readJsonFile, readJsoncFile, readTomlFile } from '../utils/config.js'
import { resolveHome, getSkillsDir, getAuthFilePath } from '../utils/path.js'
import { deriveMcpUrlFromConsoleUrl } from '../auth/mcp-url.js'
import { removeMcpConfig, writeMcpConfig } from '../mcp/mcp-config-writer.js'
import { readTrackingFile, writeTrackingFile, type SkillTrackingEntry, type TrackingData } from '../skills/skill-tracker.js'
import { installSkillsToDirectory } from '../skills/skill-copier.js'
import { getHarnessSkillsPath, linkSkillsToHarness, unlinkSkillsFromHarness } from '../skills/skill-linker.js'
import { assertSafeSkillName } from '../utils/skill-name.js'
import { getAdapter } from '../harnesses/index.js'
import type { FallbackTransactionIdentity, UpdateError } from './types.js'
import { trackingDigest, valueDigest } from './fallback-journal.js'
import { readPackageVersion } from './package-manager.js'
import { isStableVersion } from './version.js'
import { isCanonicalPath, matchesTrackedOwnership } from './fallback-ownership.js'

export interface FallbackRefreshOptions {
  harness: HarnessType
  bundlePath: string
  skillsSource: string
  transaction?: FallbackTransactionIdentity
}

export interface FallbackRefreshResult {
  success: boolean
  rollbackAttempted?: boolean
  rollbackSucceeded?: boolean
  error?: UpdateError
}

export async function refreshOwnedInstallation (options: FallbackRefreshOptions): Promise<FallbackRefreshResult> {
  if (options.transaction) {
    const validation = validateTransactionIdentity(options.transaction)
    if (validation) return failure(validation.code, validation.message)
  }
  const tracking = await readTrackingFile()
  if (!tracking) return failure('UNTRACKED_INSTALLATION', 'No NodeSource tracking record exists')
  if (options.transaction && !matchesTrackedOwnership(tracking, options.transaction)) {
    return failure('FALLBACK_OWNERSHIP_DRIFT', 'Fallback ownership no longer matches the approved transaction manifest')
  }
  const previousSkills = tracking.skills.filter((entry) => entry.harnesses.includes(options.harness))
  const previousMcps = tracking.mcpServers.filter((entry) => entry.harness === options.harness)
  if (previousSkills.length === 0 && previousMcps.length === 0) return failure('UNTRACKED_INSTALLATION', 'The requested harness has no tracked NodeSource ownership')

  let bundle: BundleDescriptor
  try {
    const raw = readJsonFile<BundleDescriptor>(options.bundlePath)
    if (!raw) return failure('BUNDLE_NOT_FOUND', 'Update bundle is not available')
    bundle = validateBundle(raw)
  } catch {
    return failure('BUNDLE_INVALID', 'Update bundle is invalid')
  }
  const packageVersion = readPackageVersion(options.skillsSource)
  const hasPackageManifest = existsSync(path.join(options.skillsSource, 'package.json'))
  if (!isStableVersion(bundle.version) || (hasPackageManifest && packageVersion !== bundle.version)) {
    return failure('FALLBACK_BUNDLE_VERSION_MISMATCH', 'Update bundle version does not match the executing package version')
  }

  const destination = options.harness === 'opencode'
    ? path.resolve(process.env.NSOLID_OPENCODE_SKILLS_DIR ?? resolveHome('~/.config/opencode/skills'))
    : getSkillsDir()
  const linkSkills = options.harness !== 'opencode'
  const linkDir = linkSkills ? getHarnessSkillsPath(options.harness) : undefined
  const oldPaths = previousSkills.map((entry) => entry.paths?.[options.harness] ?? entry.path)
  if (oldPaths.some((value) => typeof value !== 'string' || !path.isAbsolute(value))) {
    return failure('UNTRACKED_INSTALLATION', 'Tracked skill ownership does not contain safe absolute paths')
  }
  try {
    for (const skill of bundle.skills) assertSafeSkillName(skill.name)
  } catch {
    return failure('BUNDLE_INVALID', 'Update bundle contains an unsafe skill destination')
  }
  const oldPathSet = new Set(oldPaths.map((value) => path.resolve(value)))
  const newPaths = bundle.skills.map((skill) => path.join(destination, skill.name))
  const trackedPathSet = new Set(
    tracking.skills.flatMap((entry) => [entry.path, ...Object.values(entry.paths ?? {})]
      .filter((value): value is string => typeof value === 'string'))
      .map((value) => path.resolve(value))
  )

  for (const target of newPaths) {
    if (pathExists(target) && !oldPathSet.has(path.resolve(target)) && !trackedPathSet.has(path.resolve(target))) {
      return failure('UNTRACKED_DESTINATION', `Owned refresh would overwrite an untracked destination: ${path.basename(target)}`)
    }
  }

  const backupDir = await mkdtemp(path.join(os.tmpdir(), 'nsolid-plugin-fallback-'))
  const trackingBackup = path.join(backupDir, 'tracking.json')
  const configPath = previousMcps[0]?.configPath ?? getAdapter(options.harness).getMcpConfigPath()
  const configExisted = configPath ? existsSync(configPath) : false
  const configBackup = configPath ? path.join(backupDir, 'mcp-config') : undefined
  const skillsBackup = path.join(backupDir, 'skills')
  const linkPaths = linkDir ? [...new Set([...previousSkills, ...bundle.skills].map((skill) => path.join(linkDir, skill.name)))] : []
  const linksBackup = path.join(backupDir, 'links')
  const sharedNewPaths = newPaths.filter((value) => existsSync(value) && trackedPathSet.has(path.resolve(value)))
  const backupPaths = [...new Set([...oldPaths, ...sharedNewPaths])]
  const previousSkillNames = new Set(previousSkills.map((entry) => entry.name))

  // linkSkillsToHarness historically renamed any regular destination to a
  // timestamped .bak before linking. A new bundle skill has no such ownership
  // evidence, so reject that collision before the transaction can rename a
  // user's directory or file.
  if (linkDir) {
    for (const skill of bundle.skills) {
      const linkPath = path.join(linkDir, skill.name)
      if (!previousSkillNames.has(skill.name) && pathExists(linkPath) && !trackedPathSet.has(path.resolve(linkPath))) {
        await rm(backupDir, { recursive: true, force: true }).catch(() => {})
        return failure('UNTRACKED_DESTINATION', `Owned refresh would overwrite an untracked harness link destination: ${skill.name}`)
      }
    }
  }

  let backupsComplete = false
  let mutationStarted = false
  try {
    // Keep backup creation outside the mutation catch. A partial backup is
    // never safe input to rollback: deleting the live paths and restoring the
    // partial tree can destroy the only intact copy of a user's installation.
    try {
      await writeFile(trackingBackup, JSON.stringify(tracking, null, 2) + '\n', { mode: 0o600 })
      await mkdir(skillsBackup, { recursive: true, mode: 0o700 })
      for (const oldPath of backupPaths) {
        if (pathExists(oldPath)) {
          const target = path.join(skillsBackup, encodeURIComponent(oldPath))
          await cp(oldPath, target, { recursive: true, force: true })
        }
      }
      if (linkPaths.length > 0) {
        await mkdir(linksBackup, { recursive: true, mode: 0o700 })
        for (const linkPath of linkPaths) {
          if (pathExists(linkPath)) await cp(linkPath, path.join(linksBackup, encodeURIComponent(linkPath)), { recursive: true, force: true })
        }
      }
      if (configPath && configBackup && existsSync(configPath)) await writeFile(configBackup, await readFile(configPath), { mode: 0o600 })
      backupsComplete = true
    } catch {
      return {
        success: false,
        rollbackAttempted: false,
        error: { code: 'FALLBACK_BACKUP_FAILED', message: 'Owned fallback backup could not be completed' },
      }
    }

    try {
      mutationStarted = true
      const newNames = new Set(bundle.skills.map((skill) => skill.name))
      const pathsToReplace = previousSkills
        .filter((entry) => newNames.has(entry.name))
        .map((entry) => entry.paths?.[options.harness] ?? entry.path)
      const pathsToRemove = previousSkills
        .filter((entry) => !newNames.has(entry.name) && canRemoveOwnedPath(entry, options.harness))
        .map((entry) => entry.paths?.[options.harness] ?? entry.path)
      for (const ownedPath of [...pathsToReplace, ...pathsToRemove, ...sharedNewPaths]) {
        await rm(ownedPath, { recursive: true, force: true })
      }

      await installSkillsToDirectory(bundle.skills, options.skillsSource, destination)
      for (const oldEntry of previousSkills) {
        if (!newNames.has(oldEntry.name)) {
          if (linkSkills) await unlinkSkillsFromHarness(options.harness, [{ name: oldEntry.name, path: oldEntry.name, description: '' }])
        }
      }
      if (linkSkills) await linkSkillsToHarness(options.harness, bundle.skills)

      const credentials = readValidCredentials()
      const canReconcileMcp = credentials !== null
      const previousMcpNames = previousMcps.map((entry) => entry.name)
      const desiredMcpNames = bundle.mcpServers.map((server) => server.name)
      if (!canReconcileMcp && !sameNameSet(previousMcpNames, desiredMcpNames)) {
        throw new FallbackTransactionError('MCP_RECONCILIATION_REQUIRED', 'Fallback MCP state changed but valid credentials are unavailable')
      }
      const newMcpNames = canReconcileMcp
        ? new Set(desiredMcpNames)
        : new Set(previousMcpNames)
      const staleMcpNames = previousMcps
        .filter((entry) => !newMcpNames.has(entry.name))
        .filter((entry) => !tracking.mcpServers.some((other) => other !== entry && other.name === entry.name && path.resolve(other.configPath) === path.resolve(configPath)))
        .map((entry) => entry.name)
      if (configPath && staleMcpNames.length > 0) {
        await removeMcpConfig(options.harness, [...new Set(staleMcpNames)], { configPath })
      }
      const configuredMcpServers = canReconcileMcp ? bundle.mcpServers : []
      if (credentials && bundle.mcpServers.length > 0) {
        const variables = await mcpVariables(credentials)
        await writeMcpConfig(options.harness, bundle.mcpServers, variables, { configPath })
      }

      const updated = reconcileTracking(tracking, options.harness, destination, bundle.skills, configPath, configuredMcpServers, staleMcpNames)
      updated.bundleVersion = bundle.version
      updated.bundleVersions = { ...(updated.bundleVersions ?? {}), [options.harness]: bundle.version }
      await writeTrackingFile(updated)
      return { success: true }
    } catch (error) {
      const rollback = backupsComplete && mutationStarted
        ? await rollbackFallback({ trackingBackup, configBackup, configPath, configExisted, skillsBackup, backupPaths, newPaths, linksBackup, linkPaths })
        : false
      if (error instanceof FallbackTransactionError && rollback) {
        return failure(error.code, error.message, { attempted: true, succeeded: true })
      }
      return rollback
        ? failure('FALLBACK_REFRESH_FAILED', 'Owned fallback refresh failed and was rolled back', { attempted: true, succeeded: true })
        : failure('FALLBACK_ROLLBACK_FAILED', 'Owned fallback refresh failed and rollback was incomplete', { attempted: true, succeeded: false })
    }
  } finally {
    await rm(backupDir, { recursive: true, force: true }).catch(() => {})
  }
}

function validateTransactionIdentity (identity: FallbackTransactionIdentity): UpdateError | undefined {
  if (!identity.installationId || identity.installationId !== `${identity.harness}:fallback`) return { code: 'INVALID_TRANSACTION_MANIFEST', message: 'Fallback transaction manifest has an invalid installation identity' }
  if (!path.isAbsolute(identity.trackingPath) || !trackingDigest(identity.trackingPath)) return { code: 'FALLBACK_TRACKING_DRIFT', message: 'Fallback tracking file is absent or cannot be hashed' }
  if (trackingDigest(identity.trackingPath) !== identity.trackingDigest) return { code: 'FALLBACK_TRACKING_DRIFT', message: 'Fallback tracking file changed after planning' }
  if (identity.ownedSkillPaths.some((value) => !isCanonicalPath(value))) return { code: 'INVALID_TRANSACTION_MANIFEST', message: 'Fallback transaction contains an unsafe skill path' }
  if (identity.ownedLinkPaths.some((value) => !isCanonicalPath(value))) return { code: 'INVALID_TRANSACTION_MANIFEST', message: 'Fallback transaction contains an unsafe link path' }
  for (const field of identity.ownedMcpFields) {
    if (!isCanonicalPath(field.configPath) || !existsSync(field.configPath)) return { code: 'FALLBACK_MCP_DRIFT', message: 'Owned MCP configuration changed after planning' }
    const current = readMcpField(field.configPath, field.server, field.field)
    if (field.expectedDigest && valueDigest(current) !== field.expectedDigest) return { code: 'FALLBACK_MCP_DRIFT', message: 'Owned MCP field changed after planning' }
  }
  return undefined
}

function readMcpField (configPath: string, server: string, field: string): unknown {
  try {
    const parsed = readMcpConfig(configPath)
    const servers = parsed?.mcpServers ?? parsed?.mcp_servers ?? parsed?.mcp
    const record = servers && typeof servers === 'object' ? (servers as Record<string, unknown>)[server] : undefined
    return record && typeof record === 'object' && !Array.isArray(record) ? (record as Record<string, unknown>)[field] : undefined
  } catch { return undefined }
}

function readMcpConfig (configPath: string): Record<string, unknown> | null {
  if (configPath.endsWith('.toml')) return readTomlFile<Record<string, unknown>>(configPath)
  if (configPath.endsWith('.jsonc')) return readJsoncFile<Record<string, unknown>>(configPath)
  return readJsonFile<Record<string, unknown>>(configPath)
}

function readValidCredentials (): Credentials | null {
  try {
    const credentials = readJsonFile<Credentials>(getAuthFilePath())
    if (!credentials || typeof credentials.expiresAt !== 'string') return null
    return Date.parse(credentials.expiresAt) > Date.now() ? credentials : null
  } catch { return null }
}

async function mcpVariables (credentials: Credentials): Promise<Record<string, string>> {
  const mcpUrl = credentials.mcpUrl || deriveMcpUrlFromConsoleUrl(credentials.consoleUrl, credentials.organizationId)
  if (!mcpUrl) throw new Error('MCP URL could not be derived')
  return { AUTH_TOKEN: credentials.serviceToken, AUTH_ORG_ID: credentials.organizationId, MCP_URL: mcpUrl }
}

async function rollbackFallback (options: {
  trackingBackup: string
  configBackup?: string
  configPath?: string
  configExisted: boolean
  skillsBackup: string
  backupPaths: string[]
  newPaths: string[]
  linksBackup: string
  linkPaths: string[]
}): Promise<boolean> {
  try {
    for (const newPath of options.newPaths) await rm(newPath, { recursive: true, force: true })
    for (const oldPath of options.backupPaths) {
      const backup = path.join(options.skillsBackup, encodeURIComponent(oldPath))
      if (existsSync(backup)) await cp(backup, oldPath, { recursive: true, force: true })
    }
    for (const linkPath of options.linkPaths) await rm(linkPath, { recursive: true, force: true })
    for (const linkPath of options.linkPaths) {
      const backup = path.join(options.linksBackup, encodeURIComponent(linkPath))
      if (existsSync(backup)) await cp(backup, linkPath, { recursive: true, force: true })
    }
    if (options.configPath && options.configBackup && existsSync(options.configBackup)) {
      await writeFile(options.configPath, await readFile(options.configBackup), { mode: 0o600 })
    } else if (options.configPath && !options.configExisted) {
      await rm(options.configPath, { force: true })
    }
    const tracking = JSON.parse(await readFile(options.trackingBackup, 'utf8')) as TrackingData
    await writeTrackingFile(tracking)
    return true
  } catch {
    return false
  }
}

function canRemoveOwnedPath (entry: SkillTrackingEntry, harness: HarnessType): boolean {
  const ownedPath = entry.paths?.[harness] ?? entry.path
  const remainingHarnesses = entry.harnesses.filter((value) => value !== harness)
  if (remainingHarnesses.length === 0) return true
  const remainingPaths = remainingHarnesses.map((value) => entry.paths?.[value]).filter((value): value is string => typeof value === 'string')
  // Legacy entries may not have per-harness paths. Keep the physical path when
  // another owner remains and the old record cannot prove it is unshared.
  if (remainingPaths.length === 0) return false
  return !remainingPaths.some((value) => path.resolve(value) === path.resolve(ownedPath))
}

function reconcileTracking (
  original: TrackingData,
  harness: HarnessType,
  destination: string,
  skills: BundleDescriptor['skills'],
  configPath: string | undefined,
  mcpServers: BundleDescriptor['mcpServers'],
  staleMcpNames: string[]
): TrackingData {
  const tracking = JSON.parse(JSON.stringify(original)) as TrackingData
  const newNames = new Set(skills.map((skill) => skill.name))

  for (const entry of tracking.skills) {
    if (!entry.harnesses.includes(harness)) continue
    if (newNames.has(entry.name)) {
      entry.paths = { ...(entry.paths ?? {}), [harness]: path.resolve(destination, entry.name) }
      continue
    }
    entry.harnesses = entry.harnesses.filter((value) => value !== harness)
    if (entry.paths) delete entry.paths[harness]
    if (entry.harnesses.length > 0) {
      const remainingPath = entry.paths?.[entry.harnesses[0]]
      if (remainingPath) entry.path = remainingPath
    }
  }

  tracking.skills = tracking.skills.filter((entry) => entry.harnesses.length > 0)
  for (const skill of skills) {
    const normalizedPath = path.resolve(destination, skill.name)
    const existing = tracking.skills.find((entry) => entry.name === skill.name)
    if (existing) {
      if (!existing.harnesses.includes(harness)) existing.harnesses.push(harness)
      existing.paths = { ...(existing.paths ?? {}), [harness]: normalizedPath }
      if (existing.harnesses.length === 1) existing.path = normalizedPath
    } else {
      tracking.skills.push({
        name: skill.name,
        path: normalizedPath,
        paths: { [harness]: normalizedPath },
        installedAt: new Date().toISOString(),
        harnesses: [harness],
      })
    }
  }

  const stale = new Set(staleMcpNames)
  tracking.mcpServers = tracking.mcpServers.filter((entry) => !(entry.harness === harness && stale.has(entry.name)))
  if (configPath) {
    const now = new Date().toISOString()
    for (const server of mcpServers) {
      const existing = tracking.mcpServers.find((entry) => entry.harness === harness && entry.name === server.name)
      if (existing) {
        existing.configPath = path.resolve(configPath)
        existing.configuredAt = now
        existing.fields = readMcpRecord(configPath, server.name)
      } else {
        tracking.mcpServers.push({ name: server.name, configPath: path.resolve(configPath), harness, configuredAt: now, fields: readMcpRecord(configPath, server.name) })
      }
    }
  }
  return tracking
}

function readMcpRecord (configPath: string, name: string): Record<string, string> | undefined {
  try {
    const parsed = readMcpConfig(configPath)
    const servers = parsed?.mcpServers ?? parsed?.mcp_servers ?? parsed?.mcp
    const record = servers && typeof servers === 'object' ? (servers as Record<string, unknown>)[name] : undefined
    if (!record || typeof record !== 'object' || Array.isArray(record)) return undefined
    return Object.fromEntries(Object.entries(record as Record<string, unknown>).map(([field, value]) => [field, valueDigest(value)]))
  } catch { return undefined }
}

function failure (code: string, message: string, rollback?: { attempted: boolean; succeeded: boolean }): FallbackRefreshResult {
  return { success: false, rollbackAttempted: rollback?.attempted, rollbackSucceeded: rollback?.succeeded, error: { code, message } }
}

class FallbackTransactionError extends Error {
  constructor (public readonly code: string, message: string) {
    super(message)
  }
}

function sameNameSet (left: readonly string[], right: readonly string[]): boolean {
  const leftSet = new Set(left)
  const rightSet = new Set(right)
  return leftSet.size === rightSet.size && [...leftSet].every((name) => rightSet.has(name))
}

function pathExists (filePath: string): boolean {
  try {
    lstatSync(filePath)
    return true
  } catch {
    return false
  }
}
