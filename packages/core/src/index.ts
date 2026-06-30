export { getAdapter } from './harnesses/index.js'
export type { HarnessAdapter, McpConfig, McpServerConfig } from './harnesses/index.js'
export { loadCredentials, isExpired } from './auth/index.js'

import path from 'node:path'
import { readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'

import type {
  HarnessType,
  InstallOptions,
  InstallResult,
  SetupOptions,
  SetupResult,
  DoctorReport,
  BundleDescriptor,
  Credentials,
  Logger,
} from './types.js'
import { validateBundle } from './validate.js'
import { ensureAuthenticated, loadCredentials, isExpired, removeCredentials } from './auth/index.js'
import { deriveMcpUrlFromConsoleUrl } from './auth/mcp-url.js'
import { installSkills, installSkillsToDirectory, uninstallSkills, SkillCopyError } from './skills/skill-copier.js'
import { linkSkillsToHarness, unlinkSkillsFromHarness } from './skills/skill-linker.js'
import {
  readTrackingFile,
  addTrackedSkills,
  removeTrackedSkills,
} from './skills/skill-tracker.js'
import {
  writeMcpConfig,
  removeMcpConfig,
  addTrackedMcps,
  removeTrackedMcps,
  listTrackedMcps,
} from './mcp/index.js'
import { getAdapter } from './harnesses/index.js'
import type { HarnessAdapter } from './harnesses/index.js'
import { findPiPluginSkillRoots } from './harnesses/pi-plugin-detector.js'
import { readJsonFile } from './utils/config.js'
import { getSkillsDir, getAuthFilePath } from './utils/path.js'
import { createLogger, isVerboseEnabled } from './utils/logger.js'
import { createConsoleProgress, silentProgress, type ProgressReporter } from './utils/progress.js'
import { restoreConfigBackup, type BackupEntry } from './utils/backup.js'
import { toPluginError } from './errors.js'

const KNOWN_MCP_SERVERS = ['ns-benchmark', 'nsolid-console', 'ncm']
const STAGING_ACCOUNTS_URL = 'https://staging.accounts.nodesource.com'
const PLUGIN_OWNED_HARNESSES = new Set<HarnessType>(['claude', 'codex', 'antigravity'])
/**
 * Harnesses that install the nsolid plugin/package natively (owning skills and
 * MCP config themselves) rather than via the shared CLI tracking file. The
 * doctor probes each via `adapter.detectNativePlugin()`. Superset of
 * {@link PLUGIN_OWNED_HARNESSES} plus the package-owned Pi harness.
 */
const NATIVE_PLUGIN_HARNESSES = new Set<HarnessType>(['claude', 'codex', 'antigravity', 'pi'])

function formatBundleSummary (bundle: BundleDescriptor, options: { packageOwnedSkills?: boolean }): string {
  if (options.packageOwnedSkills === true) {
    return `${bundle.mcpServers.length} MCP servers; skills owned by harness package`
  }

  return `${bundle.skills.length} skills, ${bundle.mcpServers.length} MCP servers`
}

function piPackageSkillExists (skillName: string): boolean {
  return findPiPluginSkillRoots().some((skillRoot) => existsSync(path.join(skillRoot, skillName, 'SKILL.md')))
}

async function shouldShowInitialInstallProgress (
  bundle: BundleDescriptor,
  harness: HarnessType,
  logger?: Logger
): Promise<boolean> {
  const tracking = await readTrackingFile(logger)
  if (!tracking) return true

  const trackedSkills = new Set(
    tracking.skills
      .filter((skill) => skill.harnesses.includes(harness))
      .map((skill) => skill.name)
  )
  const trackedMcps = new Set(
    tracking.mcpServers
      .filter((server) => server.harness === harness)
      .map((server) => server.name)
  )

  const hasAllSkills = bundle.skills.every((skill) => trackedSkills.has(skill.name))
  const hasAllMcps = bundle.mcpServers.every((server) => trackedMcps.has(server.name))
  return !(hasAllSkills && hasAllMcps)
}

async function resolveInstallProgress (
  options: InstallOptions,
  bundle: BundleDescriptor,
  logger?: Logger
): Promise<ProgressReporter> {
  if (options.progress) return options.progress
  if (process.env.NSOLID_PLUGIN_PROGRESS === '1') return createConsoleProgress()
  return (await shouldShowInitialInstallProgress(bundle, options.harness, logger))
    ? createConsoleProgress()
    : silentProgress
}

export function resolveAccountsUrl (defaultUrl: string, logger?: Logger): string {
  const explicit = process.env.NSOLID_ACCOUNTS_URL
  const staging = process.env.NSOLID_STAGING
  let url = defaultUrl
  if (staging === '1' || staging === 'true') url = STAGING_ACCOUNTS_URL
  if (explicit) url = explicit // explicit wins over the staging shortcut

  if (url === defaultUrl) return url

  // Mirror the origin-only refine() in validate.ts so a bad override fails loudly,
  // not silently (an origin with a path would drop /api/v1 via new URL('/sign-in', base)).
  let u: URL
  try { u = new URL(url) } catch { throw new Error(`Invalid NSOLID_ACCOUNTS_URL override: ${url}`) }
  if ((u.pathname !== '/' && u.pathname !== '') || u.search !== '' || u.hash !== '') {
    throw new Error(`Accounts URL override must be origin-only (no path/query/hash): ${url}`)
  }
  logger?.warn('auth.accountsUrl.overridden', { from: defaultUrl, to: url })
  return url
}

export async function setup (options: SetupOptions): Promise<SetupResult> {
  const logger = options.logger ?? createLogger({ verbose: isVerboseEnabled(options.verbose) })
  const progress = options.progress ?? createConsoleProgress()
  const result: SetupResult = {
    success: false,
    skillsInstalled: 0,
    mcpServersConfigured: [],
    hadToAuthenticate: false,
    errors: [],
  }

  logger.info('setup.start', { harness: options.harness, bundlePath: options.bundlePath })

  let bundle: BundleDescriptor
  try {
    const bundleData = readJsonFile<BundleDescriptor>(options.bundlePath)
    if (!bundleData) {
      result.errors.push(`Bundle not found: ${options.bundlePath}`)
      return result
    }
    bundle = validateBundle(bundleData)
    progress.header(`NodeSource setup — ${options.harness}`)
    progress.step('Reading bundle config', formatBundleSummary(bundle, options))
  } catch (err) {
    const pluginErr = toPluginError(err, 'BUNDLE_INVALID', { path: options.bundlePath, harness: options.harness })
    result.errors.push(`Bundle validation failed: ${pluginErr.message}`)
    return result
  }

  if (bundle.auth) {
    const authConfig = { ...bundle.auth, accountsUrl: resolveAccountsUrl(bundle.auth.accountsUrl, logger) }

    let existingCredentials: Credentials | null = null
    try {
      existingCredentials = loadCredentials()
    } catch {
      // Corrupt credentials file — will re-authenticate via ensureAuthenticated
    }

    if (existingCredentials) {
      progress.step('Checking NodeSource login', isExpired(existingCredentials) ? 'sign-in required' : 'already signed in')
      result.hadToAuthenticate = isExpired(existingCredentials)
    } else {
      progress.step('Checking NodeSource login', 'sign-in required')
      result.hadToAuthenticate = true
    }

    try {
      await ensureAuthenticated(authConfig, logger, { harness: options.harness, confirmAuth: options.confirmAuth })
    } catch (err) {
      const pluginErr = toPluginError(err, 'AUTH_FAILED', { harness: options.harness })
      result.errors.push(`Authentication failed: ${pluginErr.message}`)
      return result
    }
  }

  // For CLI-only/package-owned harnesses, setup also performs the direct
  // fallback install/MCP config so that `nsolid-plugin setup` is a one-step
  // onboarding path. Package-owned harnesses can opt out of user-level skill
  // copies via packageOwnedSkills while still receiving MCP config.
  if (!PLUGIN_OWNED_HARNESSES.has(options.harness)) {
    const installResult = await install({
      ...options,
      progress,
    })
    result.skillsInstalled = installResult.skillsInstalled
    result.mcpServersConfigured = installResult.mcpServersConfigured
    result.errors.push(...installResult.errors)
    result.success = installResult.success
    if (result.success) {
      progress.done(`Setup complete — credentials ready for ${options.harness}`)
    }
    return result
  }

  result.success = true
  progress.done(`Setup complete — credentials ready for ${options.harness} plugin MCPs`)
  return result
}

export async function install (options: InstallOptions): Promise<InstallResult> {
  const logger = options.logger ?? createLogger({ verbose: isVerboseEnabled(options.verbose) })
  let progress: ProgressReporter = silentProgress
  const result: InstallResult = {
    success: false,
    skillsInstalled: 0,
    mcpServersConfigured: [],
    hadToAuthenticate: false,
    errors: [],
  }

  logger.info('install.start', { harness: options.harness, bundlePath: options.bundlePath, skillsSource: options.skillsSource })

  let bundle: BundleDescriptor
  try {
    const bundleData = readJsonFile<BundleDescriptor>(options.bundlePath)
    if (!bundleData) {
      result.errors.push(`Bundle not found: ${options.bundlePath}`)
      return result
    }
    bundle = validateBundle(bundleData)
    logger.debug('install.bundle.loaded', { name: bundle.name, skills: bundle.skills.length, mcpServers: bundle.mcpServers.length })
    progress = await resolveInstallProgress(options, bundle, logger)
    progress.header(`NodeSource installer — ${options.harness}`)
    progress.step('Reading bundle config', formatBundleSummary(bundle, options))
  } catch (err) {
    const pluginErr = toPluginError(err, 'BUNDLE_INVALID', { path: options.bundlePath, harness: options.harness })
    result.errors.push(`Bundle validation failed: ${pluginErr.message}`)
    return result
  }

  const adapter = getAdapter(options.harness)

  let credentials: Credentials | null = null
  if (bundle.auth) {
    try {
      credentials = loadCredentials()
    } catch {
      logger.warn('install.credentials.corrupt')
    }

    if (!credentials || isExpired(credentials)) {
      result.hadToAuthenticate = true
      progress.step('Checking NodeSource login', 'not signed in')
      progress.warn('Authentication required for MCP servers', `Run: nsolid-plugin setup --harness ${options.harness}`)
      // Install never opens a browser. Skills are still installed; MCP servers
      // are configured only after the user runs `nsolid-plugin setup`.
    } else {
      progress.step('Checking NodeSource login', 'already signed in')
    }
  }

  const canConfigureMcp = !bundle.auth || (!!credentials && !isExpired(credentials))

  let linkedSkills: typeof bundle.skills = []
  let trackedSkillsDir: string | undefined
  if (options.packageOwnedSkills === true) {
    logger.info('install.skills.packageOwned', { harness: options.harness, count: bundle.skills.length })
  } else if (options.harnessSpecificSkills === true) {
    const harnessSkillsPath = adapter.getSkillsPath()
    try {
      await installSkillsToDirectory(bundle.skills, options.skillsSource, harnessSkillsPath, logger)
      result.skillsInstalled = bundle.skills.length
      linkedSkills = bundle.skills
      trackedSkillsDir = harnessSkillsPath
      progress.step('Copying skills', `${result.skillsInstalled} → ${harnessSkillsPath}`)
      logger.info('install.skills.harnessSpecific.done', { harness: options.harness, count: result.skillsInstalled, path: harnessSkillsPath })
    } catch (err) {
      if (err instanceof SkillCopyError) {
        result.errors.push(err.message)
      } else {
        result.errors.push(`Skill installation failed: ${(err as Error).message}`)
      }
      return result
    }
  } else {
    try {
      await installSkills(bundle.skills, options.skillsSource, logger)
      result.skillsInstalled = bundle.skills.length
      progress.step('Copying skills', `${result.skillsInstalled} → ~/.agents/skills/`)
      logger.info('install.skills.done', { count: result.skillsInstalled })
    } catch (err) {
      if (err instanceof SkillCopyError) {
        result.errors.push(err.message)
      } else {
        result.errors.push(`Skill installation failed: ${(err as Error).message}`)
      }
      return result
    }

    try {
      const linkResults = await linkSkillsToHarness(options.harness, bundle.skills, logger)
      const linkedNames = new Set(linkResults.map((r) => r.skill))
      linkedSkills = bundle.skills.filter((s) => s.name && linkedNames.has(s.name))
      progress.step('Linking skills', `into ${adapter.getSkillsPath()}`)
      logger.info('install.skills.linked', { harness: options.harness, linked: linkedSkills.length })
    } catch (err) {
      const pluginErr = toPluginError(err, 'SKILL_LINK_FAILED', { harness: options.harness })
      result.errors.push(`Skill linking failed: ${pluginErr.message}`)
    }
  }

  const variables: Record<string, string> = {}
  if (credentials && canConfigureMcp) {
    variables.AUTH_TOKEN = credentials.serviceToken
    variables.AUTH_ORG_ID = credentials.organizationId
    const derivedMcpUrl = deriveMcpUrlFromConsoleUrl(credentials.consoleUrl)
    const explicitMcpUrl = credentials.mcpUrl || undefined
    const mcpUrl = explicitMcpUrl ?? derivedMcpUrl
    if (!mcpUrl) {
      result.errors.push('Could not derive MCP URL from console URL pattern')
      return result
    }
    variables.MCP_URL = mcpUrl
    logger.debug('install.variables.derived', { orgId: credentials.organizationId })
  }

  const mcpConfigPath = adapter.getMcpConfigPath()

  if (adapter.supportsMcp() && bundle.mcpServers.length > 0 && canConfigureMcp) {
    try {
      await writeMcpConfig(options.harness, bundle.mcpServers, variables, {
        configPath: mcpConfigPath ?? undefined,
        logger,
      })
      result.mcpServersConfigured = bundle.mcpServers.map((s) => s.name)
      const targetConfigPath = mcpConfigPath ?? adapter.getMcpConfigPath() ?? 'MCP config'
      progress.step('Merging MCP servers', `${result.mcpServersConfigured.join(', ')} into ${targetConfigPath}\n(backup saved)`)
      logger.info('install.mcp.done', { harness: options.harness, servers: result.mcpServersConfigured })
    } catch (err) {
      const pluginErr = toPluginError(err, 'MCP_CONFIG_WRITE_FAILED', { harness: options.harness, path: mcpConfigPath ?? undefined })
      result.errors.push(`MCP configuration failed: ${pluginErr.message}`)
    }
  } else if (adapter.supportsMcp() && bundle.mcpServers.length > 0 && !canConfigureMcp) {
    progress.step('MCP servers', `skipped — run nsolid-plugin setup --harness ${options.harness} first`)
  } else if (bundle.mcpServers.length > 0) {
    result.errors.push(
      `Bundle defines ${bundle.mcpServers.length} MCP server(s) but harness "${options.harness}" does not support MCP — they were not installed`
    )
  }

  try {
    if (linkedSkills.length > 0) {
      await addTrackedSkills(linkedSkills, options.harness, logger, trackedSkillsDir)
    }

    if (mcpConfigPath && result.mcpServersConfigured.length > 0) {
      const mcpEntries = bundle.mcpServers.map((s) => ({ name: s.name, configPath: mcpConfigPath }))
      await addTrackedMcps(mcpEntries, options.harness, logger)
    }
  } catch (err) {
    const pluginErr = toPluginError(err, 'TRACKING_UPDATE_FAILED', { harness: options.harness })
    result.errors.push(`Tracking update failed: ${pluginErr.message}`)
  }

  result.success = result.errors.length === 0
  if (result.success) {
    if (options.packageOwnedSkills === true) {
      const mcpCount = result.mcpServersConfigured.length
      progress.done(`Done — package-owned skills skipped; ${mcpCount} MCP server${mcpCount === 1 ? '' : 's'} configured for ${options.harness}`)
    } else {
      progress.done(`Done — ${result.skillsInstalled} skills installed for ${options.harness}`)
    }
  } else {
    progress.warn('Completed with errors', `${result.errors.length} issue(s)`)
  }
  logger.info('install.finish', { success: result.success, errors: result.errors.length })
  return result
}

export interface LogoutResult {
  removed: boolean
  path: string
}

/**
 * Forget the stored NodeSource login. Idempotent: returns removed=false if no
 * credentials were present. Does NOT uninstall skills or MCP config — that is
 * `uninstall()`'s job. Use `logout` when you want to clear auth only.
 */
export async function logout (): Promise<LogoutResult> {
  const path = getAuthFilePath()
  const removed = removeCredentials()
  return { removed, path }
}

export interface UninstallOptions {
  bundlePath?: string
  verbose?: boolean
  logger?: Logger
  keepCredentials?: boolean
}

export interface UninstallResult {
  errors: string[]
  credentialsPurged?: boolean
}

export async function uninstall (
  harness: HarnessType,
  options?: UninstallOptions
): Promise<UninstallResult> {
  const logger = options?.logger ?? createLogger({ verbose: isVerboseEnabled(options?.verbose) })
  const errors: string[] = []
  const adapter = getAdapter(harness)
  const tracking = await readTrackingFile(logger)

  logger.info('uninstall.start', { harness })

  if (tracking) {
    const harnessSkills = tracking.skills.filter((s) => s.harnesses.includes(harness))
    const harnessMcps = tracking.mcpServers.filter((m) => m.harness === harness)

    if (harnessMcps.length > 0) {
      const mcpConfigPath = adapter.getMcpConfigPath()
      try {
        await removeMcpConfig(harness, harnessMcps.map((m) => m.name), {
          configPath: mcpConfigPath ?? undefined,
          logger,
        })
        await removeTrackedMcps(harnessMcps.map((m) => m.name), harness, logger)
        logger.info('uninstall.mcp.done', { harness, count: harnessMcps.length })
      } catch (err) {
        const pluginErr = toPluginError(err, 'MCP_CONFIG_WRITE_FAILED', { harness, path: mcpConfigPath ?? undefined })
        errors.push(`MCP removal failed: ${pluginErr.message}`)
      }
    }

    if (harnessSkills.length > 0) {
      const skillRefs = harnessSkills.map((s) => ({
        name: s.name,
        path: s.path,
        description: '',
      }))
      const orphaned = harnessSkills
        .filter((s) => s.harnesses.length === 1)
        .map((s) => ({ name: s.name, path: s.path, description: '' }))
      try {
        await unlinkSkillsFromHarness(harness, skillRefs, logger)
        await removeTrackedSkills(skillRefs, harness, logger)
        if (orphaned.length > 0) {
          await uninstallSkills(orphaned, logger)
        }
        logger.info('uninstall.skills.done', { harness, count: harnessSkills.length })
      } catch (err) {
        const pluginErr = toPluginError(err, 'SKILL_LINK_FAILED', { harness })
        errors.push(`Skill removal failed: ${pluginErr.message}`)
      }
    }

    // After all per-harness removal, see whether ANY install remains across any harness.
    // removeTrackedSkills/removeTrackedMcps already unlink the tracking file when it empties,
    // so a null read == "nothing NodeSource-installed is left anywhere".
    let credentialsPurged = false
    if (!options?.keepCredentials) {
      const remaining = await readTrackingFile(logger)
      const isEmpty = !remaining || (remaining.skills.length === 0 && remaining.mcpServers.length === 0)
      if (isEmpty) {
        try {
          if (removeCredentials()) {
            credentialsPurged = true
            logger.info('uninstall.credentials.purged', { reason: 'last-harness' })
          }
        } catch (err) {
          // Non-fatal: uninstall still "succeeded" for this harness; surface as a warning.
          errors.push(`Could not remove credentials: ${(err as Error).message}`)
        }
      }
    }

    logger.info('uninstall.finish', { harness, errors: errors.length, credentialsPurged })
    return { errors, credentialsPurged }
  } else {
    const warnings = await bestEffortCleanup(harness, adapter, options, logger)
    errors.push(...warnings)

    // Best-effort cleanup intentionally never purges credentials: without a
    // tracking file we cannot reliably tell whether another harness is still
    // installed. Users can run `nsolid-plugin logout` to remove credentials.
    logger.info('uninstall.finish', { harness, errors: errors.length, bestEffort: true })
    return { errors }
  }
}

async function bestEffortCleanup (
  harness: HarnessType,
  adapter: HarnessAdapter,
  options?: { bundlePath?: string },
  logger?: Logger
): Promise<string[]> {
  const warnings: string[] = []
  const skillsDir = harness === 'opencode' ? adapter.getSkillsPath() : getSkillsDir()
  try {
    const entries = await readdir(skillsDir, { withFileTypes: true })
    const nsSkills = entries
      .filter((e) => e.isDirectory() && e.name.startsWith('ns-'))
      .map((e) => ({
        name: e.name,
        path: path.join(skillsDir, e.name),
        description: '',
      }))

    if (nsSkills.length > 0) {
      logger?.info('uninstall.bestEffort.skills', { harness, count: nsSkills.length })
      await unlinkSkillsFromHarness(harness, nsSkills, logger)
      if (harness !== 'opencode') {
        await uninstallSkills(nsSkills, logger)
      }
    }
  } catch {
    // Skills directory doesn't exist or is unreadable — nothing to clean
  }

  if (adapter.supportsMcp()) {
    let mcpNames = KNOWN_MCP_SERVERS
    let usedBundle = false
    if (options?.bundlePath) {
      try {
        const bundleData = readJsonFile<BundleDescriptor>(options.bundlePath)
        if (bundleData?.mcpServers) {
          mcpNames = bundleData.mcpServers.map((s) => s.name)
          usedBundle = true
        }
      } catch {
        // Fall back to hardcoded list
      }
    }
    if (!usedBundle) {
      warnings.push(
        'No tracking file and no bundle provided — using hardcoded MCP server list; user-added MCP servers may be left in the config'
      )
    }
    try {
      const mcpConfigPath = adapter.getMcpConfigPath()
      await removeMcpConfig(harness, mcpNames, {
        configPath: mcpConfigPath ?? undefined,
        logger,
      })
      logger?.info('uninstall.bestEffort.mcp', { harness, servers: mcpNames })
    } catch {
      // Best-effort
    }
  }

  return warnings
}

export async function restore (
  harness: HarnessType,
  options?: { backupPath?: string; verbose?: boolean; logger?: Logger }
): Promise<BackupEntry> {
  const logger = options?.logger ?? createLogger({ verbose: isVerboseEnabled(options?.verbose) })
  logger.info('restore.start', { harness, backupPath: options?.backupPath })
  const entry = restoreConfigBackup(harness, options?.backupPath)
  logger.info('restore.done', { harness, originalPath: (await entry).originalPath })
  return entry
}

export async function doctor (
  harness: HarnessType,
  bundlePath: string,
  options?: { verbose?: boolean; logger?: Logger }
): Promise<DoctorReport> {
  const logger = options?.logger ?? createLogger({ verbose: isVerboseEnabled(options?.verbose) })
  const report: DoctorReport = {
    healthy: true,
    credentials: { status: 'missing' },
    plugin: { status: 'n/a', installed: false },
    skills: { status: 'ok', installed: [], missing: [] },
    mcpServers: { status: 'ok', reachable: [], unreachable: [] },
    errors: [],
  }

  logger.info('doctor.start', { harness, bundlePath })

  let bundle: BundleDescriptor | null = null
  try {
    const bundleData = readJsonFile<BundleDescriptor>(bundlePath)
    if (bundleData) {
      bundle = validateBundle(bundleData)
    } else {
      report.errors.push(`Bundle not found: ${bundlePath}`)
    }
  } catch {
    report.errors.push(`Failed to load bundle: ${bundlePath}`)
  }

  try {
    const creds = loadCredentials()
    if (creds) {
      if (isExpired(creds)) {
        report.credentials = { status: 'expired', message: 'Credentials have expired' }
      } else {
        report.credentials = { status: 'ok' }
      }
    }
  } catch {
    report.credentials = { status: 'missing' }
  }

  const adapter = getAdapter(harness)

  // For plugin/package-owned harnesses the recommended install path is the
  // harness's native mechanism, not the CLI tracking file. Probe it here; when
  // present, skills and MCP servers are owned by the plugin and reported as ok.
  const isNativeHarness = NATIVE_PLUGIN_HARNESSES.has(harness)
  let nativeOwned = false
  if (isNativeHarness && adapter.detectNativePlugin) {
    const detected = adapter.detectNativePlugin()
    if (detected.installed) {
      nativeOwned = detected.enabled !== false
      report.plugin = {
        status: 'ok',
        installed: true,
        enabled: detected.enabled,
        label: detected.label,
      }
    } else {
      report.plugin = { status: 'missing', installed: false }
    }
  }

  if (!bundle) {
    report.skills.status = 'unknown'
    report.mcpServers.status = 'unknown'
  } else if (nativeOwned) {
    // The native plugin owns skills and MCP config; report them as satisfied
    // rather than cross-referencing the (irrelevant) CLI tracking file.
    report.skills.installed = bundle.skills.map((s) => s.name)
    report.skills.missing = []
    report.skills.status = 'ok'
    if (adapter.supportsMcp()) {
      report.mcpServers.reachable = bundle.mcpServers.map((s) => s.name)
      report.mcpServers.unreachable = []
      report.mcpServers.status = 'ok'
    }
  } else {
    const expectedMcps = bundle.mcpServers.map((s) => s.name)

    const trackedSkills = await readTrackingFile(logger)
    const trackedSkillEntries = trackedSkills?.skills.filter((s) => s.harnesses.includes(harness)) ?? []
    const trackedByName = new Map(trackedSkillEntries.map((s) => [s.name, s]))
    const skillsDirForHarness = harness === 'opencode' ? adapter.getSkillsPath() : getSkillsDir()

    for (const skill of bundle.skills) {
      const tracked = trackedByName.get(skill.name)
      const inTracking = tracked !== undefined
      const diskPath = tracked?.paths?.[harness] ?? tracked?.path ?? path.join(skillsDirForHarness, skill.name)
      const onDisk = existsSync(diskPath)
      const inPiPackage = harness === 'pi' && piPackageSkillExists(skill.name)
      if (inTracking || onDisk || inPiPackage) {
        report.skills.installed.push(skill.name)
        if (!inPiPackage && inTracking && !onDisk) {
          report.errors.push(`Skill "${skill.name}" tracked but not on disk — tracking may be stale`)
        } else if (!inPiPackage && onDisk && !inTracking) {
          report.errors.push(`Skill "${skill.name}" on disk but not tracked — tracking may be stale`)
        }
      } else {
        report.skills.missing.push(skill.name)
      }
    }

    if (report.skills.missing.length > 0) {
      report.skills.status = report.skills.installed.length > 0 ? 'partial' : 'missing'
    }

    if (adapter.supportsMcp()) {
      const trackedMcps = await listTrackedMcps(harness, logger)
      const trackedMcpNames = new Set(trackedMcps.map((m) => m.name))
      let onDiskMcpNames: Set<string> = new Set()
      try {
        const onDiskConfig = await adapter.readMcpConfig()
        onDiskMcpNames = new Set(Object.keys(onDiskConfig.mcpServers))
      } catch {
        // Config file doesn't exist or is unreadable
      }

      for (const name of expectedMcps) {
        const inTracking = trackedMcpNames.has(name)
        const onDisk = onDiskMcpNames.has(name)
        if (inTracking || onDisk) {
          report.mcpServers.reachable.push(name)
          if (inTracking && !onDisk) {
            report.errors.push(`MCP "${name}" tracked but not in config — tracking may be stale`)
          } else if (onDisk && !inTracking) {
            report.errors.push(`MCP "${name}" in config but not tracked — tracking may be stale`)
          }
        } else {
          report.mcpServers.unreachable.push(name)
        }
      }

      if (report.mcpServers.unreachable.length > 0) {
        report.mcpServers.status =
          report.mcpServers.reachable.length > 0 ? 'partial' : 'unreachable'
      }
    } else {
      report.mcpServers.status = 'ok'
    }
  }

  // The Plugin line is informational — it reflects whether the *native*
  // plugin/package is installed. Health is driven by whether skills, MCP
  // servers, and credentials are actually satisfied, regardless of which path
  // (native plugin or direct CLI install) provided them. So a direct (fallback)
  // install on a plugin-owned harness can still be healthy without the native
  // plugin present.
  report.healthy =
    report.credentials.status === 'ok' &&
    report.skills.status === 'ok' &&
    report.mcpServers.status === 'ok' &&
    report.errors.length === 0

  logger.info('doctor.finish', { healthy: report.healthy })
  return report
}

export type { HarnessType, InstallOptions, InstallResult, DoctorReport, BundleDescriptor, Credentials } from './types.js'
export type { LinkResult, LinkStatus } from './skills/skill-linker.js'
export type { SkillTrackingEntry, McpTrackingEntry, TrackingData } from './skills/skill-tracker.js'
export type { BackupEntry } from './utils/backup.js'
