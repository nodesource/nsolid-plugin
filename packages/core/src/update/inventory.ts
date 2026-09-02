import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { readJsonFile, readTomlFile } from '../utils/config.js'
import { getTrackingFilePath, resolveHome } from '../utils/path.js'
import { isValidTrackingData } from '../skills/skill-tracker.js'
import { packageNameFromNpmSource, PI_PLUGIN_PACKAGE_NAME } from '../harnesses/pi-plugin-detector.js'
import { isNsolidPluginId } from '../harnesses/plugin-name.js'
import type { HarnessType } from '../types.js'
import type {
  AntigravityLayout,
  MarketplaceVersionSource,
  UpdateInstallation,
  UpdateInstallationMetadata,
  UpdateSource,
} from './types.js'
import type { CommandRunner } from './types.js'
import { readClaudePluginScope } from './claude-record.js'
import { detectGlobalPackageOwnership, readPackageVersion as readNamedPackageVersion } from './package-manager.js'
import { readCodexPayloadVersion, resolveCodexPluginCachePath } from './codex-transaction.js'
import { classifyVersionSet, classifyVersions, isStableVersion, readRunningVersionInfo, resolvePackageRoot } from './version.js'
import { nativePayloadTreeDigest } from './native-payload.js'

export interface InventoryOptions {
  commandRunner: CommandRunner
  cwd?: string
  packageRoot?: string
  /**
   * Launcher path used to prove CLI installation ownership. Production
   * defaults to `process.argv[1]`; tests inject a fixture launcher instead of
   * mutating global process state.
   */
  executablePath?: string
  includeCli?: boolean
  readOnly?: boolean
  deferCliOwnership?: boolean
}

const HARNESS_ORDER: HarnessType[] = ['claude', 'codex', 'antigravity', 'opencode', 'pi']
const PLUGIN_ID = /^nsolid-plugin@([A-Za-z0-9][A-Za-z0-9._-]*)$/

export async function detectInstallations (options: InventoryOptions): Promise<UpdateInstallation[]> {
  const cwd = path.resolve(options.cwd ?? process.cwd())
  const installations: UpdateInstallation[] = []
  const includeCli = options.includeCli !== false

  if (includeCli) installations.push(await detectCliInstallation(options, options.deferCliOwnership !== true))

  const fallback = await detectFallbackInstallations()
  for (const harness of HARNESS_ORDER) {
    const native = harness === 'claude'
      ? detectClaudeInstallations()
      : harness === 'codex'
        ? detectCodexInstallations()
        : harness === 'antigravity'
          ? detectAntigravityInstallations()
          : harness === 'pi'
            ? detectPiInstallations(cwd)
            : []
    installations.push(...native)
    const fallbackInstallation = fallback.find((item) => item.target === harness)
    if (fallbackInstallation) installations.push(fallbackInstallation)
  }

  return installations.sort(compareInstallations)
}

export async function detectCliInstallation (options: InventoryOptions, probeOwnership = true): Promise<UpdateInstallation> {
  const packageRoot = path.resolve(options.packageRoot ?? defaultPackageRoot())
  const executablePath = options.executablePath ?? process.argv[1]
  const running = safeRunningVersion(packageRoot)
  // Launcher shapes that are intrinsically ephemeral or wrapper-owned must
  // fail closed on EVERY seam, including the positive ownership probe: a
  // Volta image or npx cache must never turn into a global-package identity
  // just because a package manager answers a root query.
  const definitelyUnsupported = isDefinitelyUnsupportedCliLauncher(executablePath)
  const ownership = probeOwnership && !definitelyUnsupported
    ? await detectGlobalPackageOwnership({
      commandRunner: options.commandRunner,
      packageRoot,
      executablePath,
      readOnly: options.readOnly,
    })
    : undefined
  // Read-only checks and deferred mutation inventory must not spawn package
  // managers. Structural evidence supplies the running version for status
  // classification only; a mutating update still re-probes ownership before
  // any global command is planned.
  const structural = ownership?.ownership === undefined && (options.readOnly === true || probeOwnership === false)
    ? structuralGlobalManager(packageRoot, executablePath)
    : undefined
  const manager = ownership?.ownership?.manager ?? structural

  const source: UpdateSource = manager
    ? {
        kind: 'global-package',
        packageManager: manager,
        packageName: 'nsolid-plugin',
      }
    : {
        kind: 'unsupported',
        source: executablePath || 'unknown',
        reason: 'unsupported-manager',
      }

  const metadata: UpdateInstallationMetadata = ownership?.ownership
    ? {
        packageRoot: ownership.ownership.packageRoot,
        packagePath: ownership.ownership.packagePath,
        previousVersion: running?.cliVersion,
        rollbackCommand: ownership.ownership.rollbackCommand,
        packageManagerExecutable: ownership.ownership.executable,
      }
    : { packageRoot }

  return {
    installationId: 'cli:global',
    target: 'cli',
    ownership: manager ? 'global-package' : 'none',
    installed: true,
    source,
    // Without positive ownership evidence the running bundle's version is not
    // the global installation's version and must not be reported as one.
    version: manager ? classifyVersions(running?.cliVersion, undefined) : classifyVersions(undefined, undefined),
    metadata,
  }
}

/**
 * Launcher shapes that are intrinsically ephemeral or wrapper-owned. This
 * check must run before any generic global-layout matching: an npx cache or a
 * Volta shim can itself sit below directories named `node_modules` or `lib`
 * without proving ownership of the running package.
 */
export function isDefinitelyUnsupportedCliLauncher (executablePath: string | undefined): boolean {
  if (!executablePath) return true
  const normalized = path.resolve(executablePath).replace(/\\/g, '/').toLowerCase()
  return normalized.includes('/.npm/_npx/') ||
    normalized.includes('/node_modules/.bin/') ||
    normalized.includes('/.volta/bin/') ||
    normalized.includes('/.volta/tools/image/')
}

/**
 * Structural check-time evidence that the running bundle is a global npm or
 * pnpm installation. The pre-realpath package root must match a documented
 * manager layout, while the launcher's realpath must resolve into the same
 * package payload:
 * - npm: `<prefix>/lib/node_modules/nsolid-plugin`, invoked through the
 *   corresponding `<prefix>/bin/nsolid-plugin` link (Windows: the generated
 *   .cmd/.ps1 shim in the prefix root whose body references the payload).
 * - pnpm: `<pnpm home>/global[/N]/node_modules/nsolid-plugin` (the stable
 *   link) or the RESOLVED versioned-store layout Node surfaces when the
 *   payload module is loaded through that link
 *   (`<pnpm home>/global/<N>/.pnpm/<name>@<version>/node_modules/<name>`).
 *   The launcher must resolve into the payload or be the pnpm-home shim
 *   whose body references it.
 * Everything else stays unproven so unowned launches fail closed.
 *
 * Accepted residual (D2 constrains check-time to structural evidence only):
 * a prefix fabricated by hand WITH a bin link resolving into its own payload
 * is structurally indistinguishable from a real npm-global install without
 * spawning the manager; the same holds for a fabricated `<pnpm>/global/`
 * tree with an in-tree launcher. Mutating flows re-probe with real manager
 * evidence before any change; a fabrication only affects what `--check`
 * reports.
 */
function structuralGlobalManager (packageRoot: string, executablePath: string | undefined): 'npm' | 'pnpm' | undefined {
  if (!executablePath || !existsSync(executablePath) || isDefinitelyUnsupportedCliLauncher(executablePath)) return undefined
  const rawRoot = path.resolve(packageRoot)
  const rawLauncher = path.resolve(executablePath)
  const resolvedRoot = safeRealpath(rawRoot)
  const resolvedLauncher = safeRealpath(rawLauncher)
  if (path.basename(rawRoot) !== 'nsolid-plugin' || path.basename(resolvedRoot) !== 'nsolid-plugin') return undefined

  // pnpm before the generic containment gate: ownership is proven from
  // either the stable pre-realpath link or the RESOLVED versioned-store
  // layout, bound to a launcher that resolves into this payload or is the
  // pnpm-home shim whose body references it. A pnpm-shaped root with an
  // unproven launcher fails closed instead of falling through to npm.
  const pnpm = pnpmOwnershipProven(rawRoot, resolvedRoot, rawLauncher, resolvedLauncher)
  if (pnpm === true) return 'pnpm'
  if (pnpm === false) return undefined

  // Windows-style npm/pnpm launchers are generated .cmd/.ps1 shim files that
  // live NEXT TO the global layout (outside the package payload) and carry
  // the payload path in their body. Symlink launchers (POSIX prefix/bin,
  // pnpm home, Volta images) must resolve into the payload instead. A shim
  // file whose body does not reference the package payload is not treated as
  // a generated launcher, so it still fails the containment requirement.
  const launcherIsShim = isGeneratedLauncherShim(rawLauncher)
  if (!launcherIsShim && !isSameOrContained(resolvedLauncher, resolvedRoot)) return undefined

  // npm requires linkage from the matching prefix bin directory. A workspace
  // whose path merely ends in lib/node_modules/nsolid-plugin therefore cannot
  // claim global ownership by pointing at its own in-tree launcher, and a
  // Volta tool image never proves npm-global ownership.
  const rawNodeModules = path.dirname(rawRoot)
  if (path.basename(rawNodeModules) === 'node_modules') {
    const lib = path.dirname(rawNodeModules)
    if (path.basename(lib) === 'lib') {
      const prefix = path.dirname(lib)
      const launcherFromPrefixBin = path.dirname(rawLauncher) === path.join(prefix, 'bin') && path.basename(rawLauncher).replace(/\.(?:cmd|ps1|exe)$/i, '') === 'nsolid-plugin'
      if (launcherFromPrefixBin) return 'npm'
    }
  }

  // npm on Windows installs the .cmd/.ps1 shim in the prefix root itself,
  // next to node_modules (no separate bin directory). The shim shape check
  // keeps this branch exercisable on every platform through crafted fixtures.
  if ((process.platform === 'win32' || launcherIsShim) && path.basename(rawNodeModules) === 'node_modules') {
    const npmPrefix = path.dirname(rawNodeModules)
    const launcherFromPrefix = path.dirname(rawLauncher) === npmPrefix && path.basename(rawLauncher).replace(/\.(?:cmd|ps1|exe)$/i, '') === 'nsolid-plugin'
    if (launcherFromPrefix) return 'npm'
  }
  return undefined
}

/**
 * pnpm ownership proof: undefined = not pnpm-shaped; true = proven; false =
 * pnpm-shaped but the launcher could not be bound to this payload (fail
 * closed instead of falling through to the npm classifier). Node resolves
 * the payload module through the global link, so the resolved store layout
 * is the shape production actually observes; the pre-realpath link shape
 * remains valid for callers that can supply it.
 */
function pnpmOwnershipProven (rawRoot: string, resolvedRoot: string, rawLauncher: string, resolvedLauncher: string | undefined): boolean | undefined {
  const homes = new Set<string>()
  const linkHome = pnpmLayoutHome(rawRoot)
  if (linkHome !== undefined) homes.add(linkHome)
  const storeHome = pnpmLayoutHome(resolvedRoot)
  if (storeHome !== undefined) homes.add(storeHome)
  const pnpmHome = [...homes][0]
  if (pnpmHome === undefined) return undefined
  if (resolvedLauncher !== undefined && isSameOrContained(resolvedLauncher, resolvedRoot)) return true
  const shimName = path.basename(rawLauncher).replace(/\.(?:cmd|ps1|exe)$/i, '')
  if (shimName === 'nsolid-plugin' && path.dirname(rawLauncher) === pnpmHome) {
    // Windows-generated .cmd/.ps1 shims are bound by their generated body
    // shape (node_modules\<pkg> entrypoint); POSIX pnpm sh scripts embed an
    // absolute payload path in their body.
    if (isGeneratedLauncherShim(rawLauncher) || pnpmHomeShimReferencesPayload(rawLauncher, rawRoot, resolvedRoot)) return true
  }
  // A pnpm-shaped root with an unproven launcher must not fall through.
  return false
}

/** pnpm global layout home: <home>/global[/N]/<node_modules|.pnpm store>/.../nsolid-plugin */
function pnpmLayoutHome (candidate: string): string | undefined {
  const normalized = candidate.replace(/\\/g, '/')
  const match = /^(.*)\/global\/(?:\d+\/)?(?:node_modules\/nsolid-plugin|\.pnpm\/[^/]+\/node_modules\/nsolid-plugin)$/.exec(normalized)
  if (!match) return undefined
  const home = match[1]
  if (!home) return undefined
  return home.split('/').join(path.sep)
}

/** The POSIX pnpm-home sh script must embed an absolute payload path in its body. */
function pnpmHomeShimReferencesPayload (launcher: string, rawRoot: string, resolvedRoot: string): boolean {
  try {
    const body = readFileSync(launcher, 'utf8')
    return [rawRoot, resolvedRoot].some((root) => body.includes(root) || body.includes(root.replace(/\\/g, '/')))
  } catch {
    return false
  }
}

/**
 * True when the launcher is a generated npm/pnpm Windows shim whose body
 * references this package's payload directory. npm generates cmd/ps1 shims
 * that embed the installed entrypoint (`node_modules\nsolid-plugin\...`);
 * pnpm generates equivalent shims. The body reference is what binds the
 * otherwise-standalone shim file to the exact package payload.
 */
function isGeneratedLauncherShim (launcher: string): boolean {
  if (!/\.(?:cmd|ps1)$/i.test(path.basename(launcher))) return false
  try {
    return /node_modules[\\/]+nsolid-plugin/i.test(readFileSync(launcher, 'utf8'))
  } catch {
    return false
  }
}

function isSameOrContained (candidate: string, parent: string): boolean {
  if (!candidate || !parent) return false
  const relative = path.relative(path.resolve(parent), path.resolve(candidate))
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function detectClaudeInstallations (): UpdateInstallation[] {
  const installedPath = resolveHome('~/.claude/plugins/installed_plugins.json')
  const knownMarketplacesPath = resolveHome('~/.claude/plugins/known_marketplaces.json')
  const data = safeReadJson(installedPath)
  const knownMarketplaces = safeReadJson(knownMarketplacesPath) ?? {}
  const records = extractPluginRecords(data)
  const output: UpdateInstallation[] = []

  for (const { id, record } of records) {
    if (!isNsolidPluginId(id)) continue
    const parsed = PLUGIN_ID.exec(id)
    const scope = readClaudePluginScope(record)
    const metadata = {
      ...(recordMetadata(record) ?? {}),
      configPath: installedPath,
      nativeEvidence: [
        { path: installedPath, digest: fileDigest(installedPath) },
        { path: knownMarketplacesPath, digest: fileDigest(knownMarketplacesPath) },
      ].filter((entry) => entry.digest.length > 0),
    }
    const marketplaceRecord = parsed && isRecord(knownMarketplaces[parsed[1]]) ? knownMarketplaces[parsed[1]] as Record<string, unknown> : {}
    const enrichedRecord = { ...marketplaceRecord, ...record }
    const source = parsed && scope
      ? makeClaudeSource(id, parsed[1], enrichedRecord, metadata)
      : makeUnsupportedSource(id, !parsed ? 'ambiguous' : 'ambiguous')
    const version = readRecordVersion(enrichedRecord, metadata?.packageRoot)
    output.push({
      installationId: `claude:native:${id}:${scope ?? 'unknown'}`,
      target: 'claude',
      ownership: 'native-plugin',
      installed: true,
      source,
      version: classifyVersions(version, undefined),
      metadata,
    })
  }
  return output
}

function detectCodexInstallations (): UpdateInstallation[] {
  const configPath = path.resolve(process.env.CODEX_CONFIG_PATH ?? resolveHome('~/.codex/config.toml'))
  const config = readTomlResult(configPath)
  if (config.kind === 'missing') return []
  if (config.kind === 'parse-error') {
    return [{
      installationId: 'codex:native:config',
      target: 'codex',
      ownership: 'native-plugin',
      installed: true,
      source: makeUnsupportedSource('codex:config', 'untracked'),
      version: { status: 'unknown' },
      inventoryError: { code: 'CODEX_CONFIG_PARSE_FAILED', message: 'Codex configuration could not be parsed' },
      metadata: { configPath },
    }]
  }
  const data = config.value
  const plugins = data?.plugins
  if (!plugins || typeof plugins !== 'object' || Array.isArray(plugins)) return []
  const output: UpdateInstallation[] = []

  for (const [id, value] of Object.entries(plugins as Record<string, unknown>)) {
    if (!isNsolidPluginId(id)) continue
    const parsed = PLUGIN_ID.exec(id)
    const marketplaceRecord = isRecord(data.marketplaces) && isRecord((data.marketplaces as Record<string, unknown>)[parsed?.[1] ?? ''])
      ? (data.marketplaces as Record<string, unknown>)[parsed![1]] as Record<string, unknown>
      : {}
    const record = { ...marketplaceRecord, ...(isRecord(value) ? value : {}) }
    const source = parsed
      ? makeCodexSource(id, parsed[1], record)
      : makeUnsupportedSource(id, 'ambiguous')
    const recordedMetadata = recordMetadata(record)
    const cacheRoot = parsed
      ? resolveCodexPluginCachePath(configPath, id, parsed[1], recordedMetadata?.packageRoot)
      : recordedMetadata?.packageRoot
    const metadata = {
      ...(recordedMetadata ?? {}),
      ...(cacheRoot ? { packageRoot: cacheRoot } : {}),
      configPath,
      nativeEvidence: [{ path: configPath, digest: fileDigest(configPath) }].filter((entry) => entry.digest.length > 0),
    }
    const version = readRecordVersion(record, cacheRoot) ?? (cacheRoot ? readCodexPayloadVersion(cacheRoot, id) : undefined)
    output.push({
      installationId: `codex:native:${id}`,
      target: 'codex',
      ownership: 'native-plugin',
      installed: true,
      source,
      version: classifyVersions(version, undefined),
      metadata,
    })
  }
  return output
}

function detectAntigravityInstallations (): UpdateInstallation[] {
  const detected = detectAntigravityLayout()
  if (!detected.layout) {
    if (!detected.reason) return []
    return [{
      installationId: 'antigravity:native:unsupported-layout',
      target: 'antigravity',
      ownership: 'native-plugin',
      installed: true,
      source: makeUnsupportedSource(detected.reason, 'ambiguous'),
      version: { status: 'unknown' },
      metadata: { pluginRoot: detected.pluginRoot, manifestPath: detected.manifestPath },
    }]
  }

  const pluginRoot = resolveHome(detected.layout.pluginRoot)
  const bundleVersion = safeReadVersion(path.join(pluginRoot, 'bundle.json'))
  return [{
    installationId: `antigravity:native:${detected.layout.kind}`,
    target: 'antigravity',
    ownership: 'native-plugin',
    installed: true,
    source: {
      kind: 'antigravity-git',
      url: 'https://github.com/NodeSource/nsolid-plugin.git',
      layout: detected.layout,
    },
    version: classifyVersions(bundleVersion, undefined),
    metadata: { pluginRoot, manifestPath: resolveHome(detected.layout.manifestPath) },
  }]
}

function detectPiInstallations (cwd: string): UpdateInstallation[] {
  const userSettings = resolveHome('~/.pi/agent/settings.json')
  const projectSettings = path.join(cwd, '.pi', 'settings.json')
  const userEntries = readPiEntries(userSettings, 'user')
  const projectEntries = existsSync(projectSettings) ? readPiEntries(projectSettings, 'project') : []
  const allEntries = [...userEntries, ...projectEntries]
  const matching = allEntries.filter((entry) => isPiPluginName(entry.source))
  const packageRoots: string[] = []
  const invalidScopes = new Set(matching.filter((entry) => !entry.canonical).map((entry) => entry.scope))
  const unsupportedInstallations: UpdateInstallation[] = []
  for (const scope of ['user', 'project'] as const) {
    const invalid = matching.find((entry) => entry.scope === scope && !entry.canonical)
    if (!invalid) continue
    const settingsPath = scope === 'user' ? userSettings : projectSettings
    unsupportedInstallations.push({
      installationId: `pi:package:unsupported:${scope}`,
      target: 'pi',
      ownership: 'package-owned',
      installed: true,
      source: makeUnsupportedSource(invalid.source, invalid.reason),
      version: { status: 'unknown' },
      metadata: {
        settingsPaths: [settingsPath],
        settingsDigests: [fileDigest(settingsPath)],
        projectRoot: scope === 'project' ? cwd : undefined,
        projectRootIdentity: scope === 'project' ? safeRealpath(cwd) : undefined,
      },
    })
  }
  const hasUserCanonical = !invalidScopes.has('user') && matching.some((entry) => entry.scope === 'user' && entry.canonical)
  const hasProjectCanonical = !invalidScopes.has('project') && matching.some((entry) => entry.scope === 'project' && entry.canonical)
  // A cache directory is not source evidence. Only an explicit canonical
  // settings entry makes a Pi package installation updateable.
  if (!hasUserCanonical && !hasProjectCanonical) return unsupportedInstallations

  const scopes: Array<'user' | 'project'> = []
  if (hasUserCanonical) scopes.push('user')
  if (hasProjectCanonical) scopes.push('project')
  if (scopes.includes('user')) packageRoots.push(resolveHome(`~/.pi/agent/npm/node_modules/${PI_PLUGIN_PACKAGE_NAME}`))
  if (scopes.includes('project')) {
    packageRoots.push(path.join(cwd, '.pi', 'npm', 'node_modules', PI_PLUGIN_PACKAGE_NAME))
  }
  const uniqueRoots = [...new Set(packageRoots)]
  const packageEvidencePaths = uniqueRoots.map(findPiPackageEvidencePath)
  const version = classifyVersionSet(uniqueRoots.map(safePackageVersion), undefined)
  const settingsPaths = [
    ...(scopes.includes('user') ? [userSettings] : []),
    ...(scopes.includes('project') ? [projectSettings] : []),
  ]
  const location = scopes.length === 2
    ? { scopes: ['user', 'project'] as const, projectRoot: cwd }
    : scopes[0] === 'project'
      ? { scopes: ['project'] as const, projectRoot: cwd }
      : { scopes: ['user'] as const }

  return [{
    installationId: `pi:package:${scopes.join('+')}`,
    target: 'pi',
    ownership: 'package-owned',
    installed: true,
    source: { kind: 'pi-package', spec: 'npm:nsolid-pi-plugin', ...location },
    version,
    metadata: {
      packageRoots: uniqueRoots,
      packageRootIdentities: uniqueRoots.map(safeRealpath),
      projectRoot: scopes.includes('project') ? cwd : undefined,
      projectRootIdentity: scopes.includes('project') ? safeRealpath(cwd) : undefined,
      settingsPaths,
      settingsDigests: settingsPaths.map(fileDigest),
      sourceEntries: matching.filter((entry) => scopes.includes(entry.scope)).map((entry) => entry.source),
      cacheDigests: uniqueRoots.map((root) => fileDigest(path.join(root, 'package.json'))),
      packageEvidencePaths,
      packageEvidenceDigests: packageEvidencePaths.map(fileDigest),
    },
  }, ...unsupportedInstallations]
}

async function detectFallbackInstallations (): Promise<UpdateInstallation[]> {
  const trackingPath = getTrackingFilePath()
  if (!existsSync(trackingPath)) return []
  let rawTracking: unknown
  try {
    rawTracking = readJsonFile<unknown>(trackingPath)
  } catch {
    return [unsupportedFallbackInstallation('tracking file could not be read')]
  }
  if (!isValidTrackingData(rawTracking)) return [unsupportedFallbackInstallation('tracking file has an invalid shape', trackingHarness(rawTracking))]
  const tracking = rawTracking
  const output: UpdateInstallation[] = []
  for (const harness of HARNESS_ORDER) {
    const rawTrackedSkills = tracking.skills
      .filter((entry) => entry.harnesses.includes(harness))
      .map((entry) => ({
        name: entry.name,
        path: entry.paths?.[harness] ?? entry.path,
      }))
    const trackedSkills = rawTrackedSkills.filter((entry): entry is { name: string; path: string } => typeof entry.path === 'string')
    const trackedMcps = tracking.mcpServers.filter((entry) => entry.harness === harness)
    // Pi owns its skills through nsolid-pi-plugin. Its normal setup may still
    // leave MCP entries in the shared tracking file, but those entries do not
    // constitute a fallback installation and must not create a duplicate
    // unsupported target beside the package-owned Pi target.
    if (harness === 'pi' && trackedSkills.length === 0) continue
    if (trackedSkills.length === 0 && trackedMcps.length === 0) continue
    const scopedVersion = tracking.bundleVersions?.[harness]
    const legacyVersion = tracking.bundleVersions === undefined && tracking.harness === harness ? tracking.bundleVersion : undefined
    const bundleVersion = isStableVersion(scopedVersion)
      ? scopedVersion
      : isStableVersion(legacyVersion) ? legacyVersion : undefined
    const ownershipProven = rawTrackedSkills.length === trackedSkills.length && trackedSkills.every((entry) => path.isAbsolute(entry.path))
    const source: UpdateSource = ownershipProven && trackedSkills.length > 0
      ? { kind: 'fallback', bundleVersion }
      : { kind: 'unsupported', source: `${harness}:tracking`, reason: 'untracked' }
    output.push({
      installationId: `${harness}:fallback`,
      target: harness,
      ownership: 'fallback',
      installed: true,
      source,
      version: classifyVersions(bundleVersion, undefined),
      metadata: {
        trackedSkills,
        trackedMcpConfigPath: trackedMcps[0]?.configPath,
        trackedMcpNames: trackedMcps.map((entry) => entry.name),
        trackedMcpFields: trackedMcps.flatMap((entry) => Object.entries(entry.fields ?? {}).map(([field, expectedDigest]) => ({
          configPath: path.resolve(entry.configPath),
          server: entry.name,
          field,
          expectedDigest,
        }))),
        trackedMcpOwnershipComplete: trackedMcps.every((entry) => entry.fields !== undefined),
      },
    })
  }
  return output
}

function unsupportedFallbackInstallation (reason: string, target: HarnessType = 'opencode'): UpdateInstallation {
  return {
    installationId: `${target}:fallback`,
    target,
    ownership: 'fallback',
    installed: true,
    source: makeUnsupportedSource(`${target}:tracking (${reason})`, 'untracked'),
    version: { status: 'unknown' },
    metadata: { trackedSkills: [] },
  }
}

function trackingHarness (value: unknown): HarnessType {
  if (isRecord(value) && typeof value.harness === 'string' && HARNESS_ORDER.includes(value.harness as HarnessType)) return value.harness as HarnessType
  return 'opencode'
}

function makeClaudeSource (
  id: string,
  marketplace: string,
  record: Record<string, unknown>,
  metadata?: UpdateInstallationMetadata
): UpdateSource {
  const scope = readClaudePluginScope(record)
  if (!scope) return makeUnsupportedSource(id, 'ambiguous')
  const versionSource = sourceFromRecord(record, metadata)
  if (versionSource.kind === 'unknown') {
    return makeUnsupportedSource(id, versionSource.reason === 'ambiguous' ? 'ambiguous' : 'untracked')
  }
  return {
    kind: 'claude-marketplace',
    pluginId: id,
    marketplace,
    scope,
    versionSource,
  }
}

function makeCodexSource (id: string, marketplace: string, record: Record<string, unknown>): UpdateSource {
  const versionSource = sourceFromRecord(record, recordMetadata(record))
  if (versionSource.kind === 'unknown') {
    return makeUnsupportedSource(id, versionSource.reason === 'ambiguous' ? 'ambiguous' : 'untracked')
  }
  return {
    kind: 'codex-marketplace',
    pluginId: id,
    marketplace,
    versionSource,
  }
}

function sourceFromRecord (record: Record<string, unknown>, metadata?: UpdateInstallationMetadata): MarketplaceVersionSource {
  const source = isRecord(record.source) ? record.source : record
  const repositoryCandidate = firstString(source.repository, source.repo, source.url, record.repository, record.repo)
  const sourceValue = typeof source.source === 'string' ? source.source : undefined
  const repository = repositoryCandidate ?? (sourceValue && (sourceValue.includes('/') || /^https?:\/\//.test(sourceValue)) ? sourceValue : undefined)
  const manifestPath = firstString(
    source.manifestPath,
    source.relativeManifestPath,
    source.relativePath,
    source.manifest,
    source.manifestFile,
    record.manifestPath,
    record.relativeManifestPath,
    record.relativePath,
    record.manifest
  )
  const revision = firstString(source.revision, source.ref, source.commit, record.revision, record.ref)
  const effectiveManifestPath = manifestPath ?? (repository ? 'bundle.json' : undefined)
  if (repository && effectiveManifestPath && isSafeManifestPath(effectiveManifestPath)) {
    const safeRepository = sanitizeRepository(repository)
    if (!safeRepository) return { kind: 'unknown', reason: 'unsupported' }
    const commit = firstString(source.commit, record.commit)
    const contentDigest = firstString(source.contentDigest, record.contentDigest)
    return { kind: 'git', repository: safeRepository, revision, commit, contentDigest, manifestPath: effectiveManifestPath }
  }

  const root = metadata?.packageRoot ?? firstString(
    record.installPath,
    record.installLocation,
    record.pluginRoot,
    record.path,
    source.path
  )
  if (root && isSafeSnapshotRoot(root)) {
    const inferredManifest = effectiveManifestPath ?? (
      existsSync(path.join(root, 'plugin.json'))
        ? 'plugin.json'
        : existsSync(path.join(root, 'bundle.json')) ? 'bundle.json' : undefined
    )
    if (inferredManifest && isSafeManifestPath(inferredManifest)) {
      const freshnessValue = firstString(record.freshness, source.freshness)
      const freshness = freshnessValue === 'verified' || freshnessValue === 'stale' || freshnessValue === 'unknown'
        ? freshnessValue
        : 'unknown'
      // The artifact root is the resolved payload subdirectory that contains
      // the manifest; the manifest path narrows to its payload-relative
      // basename so planning resolves the same bytes.
      const segments = inferredManifest.replace(/\\/g, '/').split('/')
      const payloadRoot = path.resolve(root, ...segments.slice(0, -1).filter((segment) => segment && segment !== '.'))
      return {
        kind: 'local-snapshot',
        root: payloadRoot,
        manifestPath: segments[segments.length - 1],
        freshness,
        contentDigest: contentDigestForSnapshot(payloadRoot),
      }
    }
  }
  return { kind: 'unknown', reason: repository || root ? 'unsupported' : 'missing-metadata' }
}

function recordMetadata (record: Record<string, unknown>): UpdateInstallationMetadata | undefined {
  const packageRoot = firstString(record.installPath, record.installLocation, record.pluginRoot, record.path)
  return packageRoot ? { packageRoot } : undefined
}

function extractPluginRecords (data: unknown): Array<{ id: string; record: Record<string, unknown> }> {
  if (!data || typeof data !== 'object') return []
  const output: Array<{ id: string; record: Record<string, unknown> }> = []
  const object = data as Record<string, unknown>
  const plugins = object.plugins
  if (plugins && typeof plugins === 'object' && !Array.isArray(plugins)) {
    for (const [id, value] of Object.entries(plugins as Record<string, unknown>)) {
      if (Array.isArray(value)) {
        for (const record of value) output.push({ id, record: isRecord(record) ? record : {} })
      } else output.push({ id, record: isRecord(value) ? value : {} })
    }
  } else if (Array.isArray(plugins)) {
    for (const value of plugins) {
      if (typeof value === 'string') output.push({ id: value, record: {} })
      else if (isRecord(value) && typeof value.id === 'string') output.push({ id: value.id, record: value })
    }
  }
  return output
}

function readPiEntries (settingsPath: string, scope: 'user' | 'project'): Array<{ source: string; scope: 'user' | 'project'; canonical: boolean; reason: 'local' | 'git' | 'pinned' | 'conflicting' | 'ambiguous' }> {
  const settings = safeReadJson(settingsPath)
  const packages = settings?.packages
  if (!Array.isArray(packages)) return []
  return packages
    .map((entry) => typeof entry === 'string' ? entry : isRecord(entry) ? entry.source : undefined)
    .filter((source): source is string => typeof source === 'string')
    .filter((source) => source.includes('nsolid-pi-plugin'))
    .map((source) => {
      if (source === 'npm:nsolid-pi-plugin') return { source, scope, canonical: true, reason: 'ambiguous' as const }
      if (source.startsWith('npm:')) return { source, scope, canonical: false, reason: 'pinned' as const }
      if (/^(git:|https?:|ssh:)/.test(source)) return { source, scope, canonical: false, reason: 'git' as const }
      return { source, scope, canonical: false, reason: 'local' as const }
    })
}

function readRecordVersion (record: Record<string, unknown>, root?: string): string | undefined {
  const candidate = firstString(record.version, record.pluginVersion, record.bundleVersion)
  if (isStableVersion(candidate)) return candidate
  return root ? safeReadVersion(path.join(root, 'bundle.json')) ?? safeReadVersion(path.join(root, 'plugin.json')) : undefined
}

function safeRunningVersion (packageRoot: string) {
  try { return readRunningVersionInfo(packageRoot) } catch { return undefined }
}

function safeReadJson (filePath: string): Record<string, unknown> | null {
  try {
    const value = readJsonFile<unknown>(filePath)
    return isRecord(value) ? value : null
  } catch { return null }
}

function readTomlResult (filePath: string):
  | { kind: 'missing' }
  | { kind: 'parsed'; value: Record<string, unknown> }
  | { kind: 'parse-error' } {
  if (!existsSync(filePath)) return { kind: 'missing' }
  try {
    const value = readTomlFile<unknown>(filePath)
    return isRecord(value) ? { kind: 'parsed', value } : { kind: 'parse-error' }
  } catch {
    return { kind: 'parse-error' }
  }
}

function safeReadVersion (filePath: string): string | undefined {
  const data = safeReadJson(filePath)
  const version = data?.version
  return isStableVersion(version) ? version : undefined
}

function safePackageVersion (root: string): string | undefined {
  return readNamedPackageVersion(root, PI_PLUGIN_PACKAGE_NAME)
}

function fileDigest (filePath: string): string {
  try { return createHash('sha256').update(readFileSync(filePath)).digest('hex') } catch { return '' }
}

function findPiPackageEvidencePath (packageRoot: string): string {
  const candidates = [
    path.resolve(packageRoot, '..', '..', 'package-lock.json'),
    path.resolve(packageRoot, '..', '..', 'npm-shrinkwrap.json'),
    path.resolve(packageRoot, '..', '.package-lock.json'),
    path.join(packageRoot, 'package.json'),
  ]
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!
}

function safeRealpath (filePath: string): string {
  try { return realpathSync(filePath) } catch { return path.resolve(filePath) }
}

function contentDigestForSnapshot (root: string): string | undefined {
  return nativePayloadTreeDigest(root)
}

function compareInstallations (a: UpdateInstallation, b: UpdateInstallation): number {
  const targetOrder = (target: string) => target === 'cli' ? -1 : HARNESS_ORDER.indexOf(target as HarnessType)
  const targetDifference = targetOrder(a.target) - targetOrder(b.target)
  if (targetDifference !== 0) return targetDifference
  const ownershipOrder: Record<string, number> = { 'global-package': 0, 'native-plugin': 1, 'package-owned': 1, fallback: 2, none: 3 }
  return (ownershipOrder[a.ownership] ?? 9) - (ownershipOrder[b.ownership] ?? 9) || a.installationId.localeCompare(b.installationId)
}

function makeUnsupportedSource (source: string, reason: 'local' | 'git' | 'pinned' | 'ambiguous' | 'conflicting' | 'untracked' | 'unsupported-manager'): UpdateSource {
  return { kind: 'unsupported', source: sanitizeUnsupportedSource(source), reason }
}

function sanitizeUnsupportedSource (source: string): string {
  const safeControls = [...source.trim()].map((character) => {
    const code = character.charCodeAt(0)
    return code < 0x20 || code === 0x7f ? '?' : character
  }).join('')
  const redacted = safeControls.replace(/((?:https?|ssh):\/\/)[^/\s@]+@/gi, '$1[REDACTED]@')
  try {
    const url = new URL(redacted)
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    return url.toString().replace(/\/$/, '').slice(0, 120)
  } catch {
    return redacted.slice(0, 120)
  }
}

function firstString (...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value.length > 0)
}

function isPiPluginName (source: string): boolean {
  if (source.startsWith('npm:')) return packageNameFromNpmSource(source) === PI_PLUGIN_PACKAGE_NAME

  const withoutFragment = source.trim().split(/[\s?#]/, 1)[0].replace(/[\\/]+$/, '').replace(/\.git$/, '')
  const basename = withoutFragment.split(/[\\/:]/).at(-1)
  return basename === PI_PLUGIN_PACKAGE_NAME
}

function isRecord (value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isSafeManifestPath (value: string): boolean {
  return value.length > 0 && !path.isAbsolute(value) && !value.split(/[\\/]+/).includes('..') && !value.includes('\\')
}

function isSafeSnapshotRoot (value: string): boolean {
  return path.isAbsolute(value) && !value.split(path.sep).includes('..')
}

function sanitizeRepository (value: string): string | undefined {
  const githubShorthand = value.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:\.git)?$/)
  if (githubShorthand) return `https://github.com/${githubShorthand[1]}/${githubShorthand[2]}.git`
  try {
    const url = new URL(value)
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    return url.toString().replace(/\/$/, '')
  } catch { return undefined }
}

export function detectAntigravityLayout (): {
  layout?: AntigravityLayout
  reason?: string
  pluginRoot?: string
  manifestPath?: string
} {
  const candidates: Array<{ layout: AntigravityLayout; pluginRoot: string; manifestPath: string }> = [
    {
      layout: { kind: 'shared', pluginRoot: '~/.gemini/config/plugins/nsolid-plugin', manifestPath: '~/.gemini/config/import_manifest.json' },
      pluginRoot: resolveHome('~/.gemini/config/plugins/nsolid-plugin'),
      manifestPath: resolveHome('~/.gemini/config/import_manifest.json'),
    },
    {
      layout: { kind: 'agy-cli', pluginRoot: '~/.gemini/antigravity-cli/plugins/nsolid-plugin', manifestPath: '~/.gemini/antigravity-cli/import_manifest.json' },
      pluginRoot: resolveHome('~/.gemini/antigravity-cli/plugins/nsolid-plugin'),
      manifestPath: resolveHome('~/.gemini/antigravity-cli/import_manifest.json'),
    },
  ]
  const valid = candidates.filter((candidate) =>
    existsSync(candidate.pluginRoot) && existsSync(candidate.manifestPath) && manifestContainsPlugin(candidate.manifestPath))
  // A generic import manifest belongs to the layout only when it contains
  // NodeSource evidence. Merely having both product manifests on disk is
  // common and must not be reported as an ambiguous N|Solid installation.
  const present = candidates.filter((candidate) =>
    existsSync(candidate.pluginRoot) || (existsSync(candidate.manifestPath) && manifestContainsPlugin(candidate.manifestPath)))
  if (present.length > 1) return { reason: 'multiple Antigravity plugin layouts are present' }
  if (valid.length === 1) return valid[0]
  const touched = present[0]
  if (touched) return { reason: 'Antigravity plugin root and matching import manifest are incomplete', pluginRoot: touched.pluginRoot, manifestPath: touched.manifestPath }
  return {}
}

function manifestContainsPlugin (manifestPath: string): boolean {
  const data = safeReadJson(manifestPath)
  const imports = data?.imports
  if (Array.isArray(imports)) return imports.some((entry) => isRecord(entry) && (entry.name === 'nsolid-plugin' || entry.plugin === 'nsolid-plugin'))
  if (isRecord(imports)) {
    return Object.entries(imports).some(([key, value]) => key === 'nsolid-plugin' || key.includes('nsolid-plugin') || (isRecord(value) && (value.name === 'nsolid-plugin' || value.plugin === 'nsolid-plugin')))
  }
  return false
}

function defaultPackageRoot (): string {
  return resolvePackageRoot(path.dirname(fileURLToPath(new URL('.', import.meta.url))))
}
