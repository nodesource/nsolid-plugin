import path from 'node:path'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import type { CommandRunner, CommandSpec, ExecutableIdentity, NpmArtifactIdentity, UpdateError } from './types.js'
import { DEFAULT_COMMAND_TIMEOUT_MS, isCommandSuccessful, resolveExecutableIdentity } from './command-runner.js'
import { isStableVersion } from './version.js'
import { bytesMatchIntegrity } from './integrity.js'
import { installedPackageMatchesTarball } from './package-content.js'

export interface GlobalPackageOwnership {
  manager: 'npm' | 'pnpm'
  packageRoot: string
  packagePath: string
  /** Resolved safe spawn identity for the manager launcher. */
  executable: ExecutableIdentity
  rollbackCommand: string
}

export interface PackageManagerDetectionOptions {
  commandRunner: CommandRunner
  packageRoot: string
  executablePath?: string
  env?: NodeJS.ProcessEnv
  /** Do not invoke npm/pnpm when collecting a read-only update report. */
  readOnly?: boolean
}

export interface PackageManagerDetection {
  ownership?: GlobalPackageOwnership
  unsupported?: UpdateError
}

export async function detectGlobalPackageOwnership (
  options: PackageManagerDetectionOptions
): Promise<PackageManagerDetection> {
  const env = options.env ?? process.env
  const executablePath = options.executablePath ?? process.argv[1] ?? ''
  const source = `${executablePath} ${env.npm_execpath ?? ''} ${env.npm_config_user_agent ?? ''}`.toLowerCase()

  // Installation roots and the resolved executable are stronger evidence than
  // ambient variables. Volta/Bun/Yarn commonly export their home variables in
  // ordinary npm/pnpm shells, so those variables alone must not reject a
  // positively identified global package.
  const wrapperEnvironment = env.npm_command === 'exec'
  const npxCache = /[\\/]\.npm[\\/]_npx[\\/]/.test(executablePath)
  if (wrapperEnvironment || npxCache || /(^|[\\/])(?:npx|volta|yarn|bun)(?:\.exe)?(?:\s|$)/.test(source) || source.includes('node_modules/.bin')) {
    return { unsupported: unsupported('unsupported-manager', 'CLI was launched through an unsupported wrapper') }
  }

  // A check must not even query a package manager. It can still report the
  // running version; ownership is intentionally left unsupported until a
  // mutating plan is requested and the manager can be positively verified.
  if (options.readOnly) {
    return { unsupported: unsupported('unsupported-manager', 'CLI ownership was not probed during a read-only check') }
  }

  const candidates: Array<'npm' | 'pnpm'> = []
  if (source.includes('pnpm')) candidates.push('pnpm')
  if (source.includes('npm')) candidates.push('npm')
  for (const manager of ['npm', 'pnpm'] as const) {
    if (!candidates.includes(manager)) candidates.push(manager)
  }

  const matches: GlobalPackageOwnership[] = []
  for (const manager of candidates) {
    // Resolve the manager to a safe spawn identity (native `.exe`/`.com`, or a
    // validated npm `.cmd`/`.bat` shim derived to `process.execPath`+JS). On
    // Windows a bare npm/pnpm name never reaches `spawn` with `shell: false`,
    // and an unverifiable shim/`.ps1`-only launcher is rejected as unsupported.
    const identity = resolveExecutableIdentity(manager, env)
    if (identity.kind === 'unsupported') continue
    let rootResult
    try {
      // Materialize the CommandSpec from the resolved identity so the
      // commandRunner receives a spawn-safe executable (native path, or
      // process.execPath + derived entrypoint) rather than a bare manager name.
      const spawn = managerArgsForIdentity(identity, ['root', '--global'])
      rootResult = await options.commandRunner.run({
        executable: spawn.executable,
        executableIdentity: identity,
        args: spawn.args,
        timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
      })
    } catch {
      continue
    }
    if (!isCommandSuccessful(rootResult)) continue
    const globalRoot = rootResult.stdout.trim().split(/\r?\n/).find((line) => path.isAbsolute(line) && existsSync(line))
    if (!globalRoot) continue

    // Keep the manager-reported link as the package identity used for reads
    // after an update. pnpm repoints this link to a new store directory; a
    // realpath captured before `pnpm add --global` would keep verification
    // pinned to the old versioned store entry.
    const packagePath = path.resolve(globalRoot, 'nsolid-plugin')
    const resolvedPackagePath = realpathOrAbsolute(packagePath)
    const resolvedPackageRoot = realpathOrAbsolute(options.packageRoot)
    if (!isSameOrContained(resolvedPackageRoot, resolvedPackagePath)) continue
    const packageVersion = readPackageVersion(packagePath)
    if (!packageVersion) continue
    if (!isSameOrContained(executablePath, resolvedPackagePath) && executablePath) {
      // The entrypoint may be a symlink. Resolve it when possible, but reject a
      // launcher that is unrelated to the positively identified package root.
      const resolvedEntry = safeRealpath(executablePath)
      if (!resolvedEntry || !isSameOrContained(resolvedEntry, resolvedPackagePath)) continue
    }

    matches.push({
      manager,
      packageRoot: path.resolve(globalRoot),
      packagePath,
      executable: identity,
      rollbackCommand: formatRollbackCommand(manager, packageVersion),
    })
  }

  if (matches.length === 1) return { ownership: matches[0] }
  if (matches.length > 1) return { unsupported: unsupported('unsupported-manager', 'CLI ownership is ambiguous between multiple package managers') }

  return { unsupported: unsupported('unsupported-manager', 'CLI installation is not proven npm or pnpm global-owned') }
}

export function buildGlobalUpdateCommand (ownership: GlobalPackageOwnership, version: string, artifact?: NpmArtifactIdentity): CommandSpec {
  const packageSpec = artifact?.tarballPath ?? `nsolid-plugin@${version}`
  const managerArgs = ownership.manager === 'npm'
    ? ['install', '--global', packageSpec]
    : ['add', '--global', packageSpec]
  const args = managerArgsForIdentity(ownership.executable, managerArgs)
  return {
    executable: args.executable,
    executableIdentity: ownership.executable,
    args: args.args,
    timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
  }
}

/**
 * Translate a resolved `ExecutableIdentity` into a spawn-safe `CommandSpec`
 * executable/args. For a `node` identity the manager name is replaced by
 * `process.execPath` with the derived entrypoint prepended, so the npm/pnpm
 * `.cmd` shim never runs through a reconstructed cmd.exe command line.
 */
export function managerArgsForIdentity (
  identity: ExecutableIdentity,
  args: readonly string[]
): { executable: string; args: string[] } {
  if (identity.kind === 'node') return { executable: identity.executable, args: [identity.entrypoint, ...args] }
  if (identity.kind === 'native') return { executable: identity.executable, args: [...args] }
  // Unsupported identity should not normally reach this point; fall back to a
  // safe empty command so callers fail closed rather than spawning a name.
  return { executable: 'nsolid-plugin-unreachable', args: [...args] }
}

export function formatRollbackCommand (manager: 'npm' | 'pnpm', version?: string): string {
  if (!version) return `${manager} ${manager === 'npm' ? 'install' : 'add'} --global nsolid-plugin@<previous-version>`
  return manager === 'npm'
    ? `npm install --global nsolid-plugin@${version}`
    : `pnpm add --global nsolid-plugin@${version}`
}

export function readPackageVersion (packagePath: string, expectedName = 'nsolid-plugin'): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path.join(packagePath, 'package.json'), 'utf8')) as { name?: unknown; version?: unknown }
    return parsed.name === expectedName && isStableVersion(parsed.version) ? parsed.version : undefined
  } catch {
    return undefined
  }
}

export function verifyGlobalPackage (ownership: GlobalPackageOwnership, expectedVersion: string, artifact?: NpmArtifactIdentity): boolean {
  if (readPackageVersion(ownership.packagePath) !== expectedVersion) return false
  if (!artifact) return true
  try {
    const packageJson = JSON.parse(readFileSync(path.join(ownership.packagePath, 'package.json'), 'utf8')) as Record<string, unknown>
    const resolved = packageJson._resolved ?? packageJson.resolved ?? packageJson.tarball
    const integrity = packageJson._integrity ?? packageJson.integrity
    if (typeof resolved === 'string' && resolved !== artifact.tarball) return false
    if (typeof integrity === 'string' && integrity !== artifact.integrity) return false
    const contentDigest = packageJson.contentDigest ?? packageJson._contentDigest
    if (typeof contentDigest === 'string' && artifact.contentDigest && contentDigest !== artifact.contentDigest) return false
    if (packageJson.name !== artifact.packageName || packageJson.version !== artifact.version) return false
    if (typeof integrity === 'string' && integrity === artifact.integrity) return true
    if (typeof contentDigest === 'string' && artifact.contentDigest && contentDigest === artifact.contentDigest) return true
    return Boolean(
      artifact.tarballPath &&
      bytesMatchIntegrity(readFileSync(artifact.tarballPath), artifact.integrity) &&
      installedPackageMatchesTarball(ownership.packagePath, artifact.tarballPath)
    )
  } catch {
    return false
  }
}

export function verifyLocalArtifact (artifact: NpmArtifactIdentity): boolean {
  if (!artifact.tarballPath) return false
  try {
    return bytesMatchIntegrity(readFileSync(artifact.tarballPath), artifact.integrity)
  } catch { return false }
}

function unsupported (reason: 'unsupported-manager', message: string): UpdateError {
  return { code: 'UNSUPPORTED_CLI_SOURCE', message: `${message}. Use an exact-version npm or pnpm command manually.` }
}

function isSameOrContained (candidate: string, parent: string): boolean {
  if (!candidate || !parent) return false
  const relative = path.relative(path.resolve(parent), path.resolve(candidate))
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function safeRealpath (filePath: string): string | undefined {
  try {
    const resolved = path.resolve(filePath)
    return existsSync(resolved) ? realpathSync(resolved) : undefined
  } catch {
    return undefined
  }
}

function realpathOrAbsolute (filePath: string): string {
  return safeRealpath(filePath) ?? path.resolve(filePath)
}
