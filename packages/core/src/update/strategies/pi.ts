import type { NpmArtifactIdentity, UpdateContext, UpdateError, UpdateInstallation, UpdatePlanItem, UpdateResult, UpdateStrategy } from '../types.js'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { DEFAULT_COMMAND_TIMEOUT_MS, isCommandSuccessful, resolveExecutableIdentity } from '../command-runner.js'
import { managerArgsForIdentity } from '../package-manager.js'
import { compareVersions, isStableVersion } from '../version.js'
import { commandFailure, failedResult, isMutableVersion, noMutationStatus, planItem, resultFromPlan } from './common.js'
import { readPackageVersion, verifyLocalArtifact } from '../package-manager.js'
import { resolveRegistryArtifactVersion } from '../version-source.js'
import { parseIntegrity } from '../integrity.js'

export const piStrategy: UpdateStrategy = {
  target: 'pi',
  ownership: 'package-owned',

  async plan (installation: UpdateInstallation): Promise<UpdatePlanItem> {
    const source = installation.source
    if (source.kind !== 'pi-package' || !isMutableVersion(installation)) return planItem(installation)
    const approve = (source.scopes as readonly string[]).includes('project')
    const projectRoot = 'projectRoot' in source ? source.projectRoot : undefined
    const evidenceError = piEvidencePlanningError(installation)
    if (evidenceError) {
      return {
        ...planItem(installation, [], [], undefined, evidenceError),
        manualCommands: [`pi update npm:nsolid-pi-plugin ${approve ? '--approve' : '--no-approve'}`],
      }
    }
    const identity = resolveExecutableIdentity('pi')
    if (identity.kind === 'unsupported') {
      return {
        ...planItem(installation, [], [], undefined, { code: 'UNSAFE_HARNESS_LAUNCHER', message: 'Pi launcher cannot be verified as a safe executable identity' }),
        manualCommands: [`pi update npm:nsolid-pi-plugin ${approve ? '--approve' : '--no-approve'}`],
      }
    }
    const spawn = managerArgsForIdentity(identity, ['update', 'npm:nsolid-pi-plugin', approve ? '--approve' : '--no-approve'])
    const registry = installation.artifact?.kind === 'npm' ? installation.artifact.registry : undefined
    return planItem(
      installation,
      [{
        kind: 'command',
        description: `Update Pi package caches (${source.scopes.join(' and ')})${projectRoot ? ` at ${projectRoot}` : ''}`,
        command: {
          executable: spawn.executable,
          executableIdentity: identity,
          args: spawn.args,
          cwd: projectRoot,
          env: registry
            ? { npm_config_registry: registry, NPM_CONFIG_REGISTRY: registry }
            : undefined,
          timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
        },
      },
      { kind: 'validation', description: 'Verify every affected Pi package cache is at least the planned version', checks: ['nsolid-pi-plugin package name', `version >= ${installation.version.latest}`] }],
      [],
      '/reload or restart Pi'
    )
  },

  async execute (item: UpdatePlanItem, context: UpdateContext): Promise<UpdateResult> {
    if (item.planningError) return failedResult(item, item.planningError)
    if (item.steps.length === 0) return resultFromPlan(item, item.source.kind === 'unsupported' ? 'unsupported' : noMutationStatus(item.version))
    const step = item.steps.find((entry) => entry.kind === 'command')
    if (!step || step.kind !== 'command') return failedResult(item, { code: 'INVALID_PLAN', message: 'Pi update plan has no command' })
    if (item.version.latest && (item.artifact?.kind !== 'npm' || !item.artifact.integrity)) {
      return failedResult(item, { code: 'ARTIFACT_IDENTITY_REQUIRED', message: 'Pi update could not prove the planned registry artifact identity' })
    }
    if (item.artifact?.kind === 'npm' && !verifyLocalArtifact(item.artifact)) return failedResult(item, { code: 'ARTIFACT_INTEGRITY_FAILED', message: 'The planned Pi package artifact no longer matches its registry integrity' })
    const drift = revalidatePiPlan(item)
    if (drift) return failedResult(item, drift)
    const result = await context.commandRunner.run(step.command)
    if (!isCommandSuccessful(result)) {
      const error = commandFailure(step.command.executable, result.timedOut, result.spawnErrorCode)
      return failedResult(item, error.code === 'COMMAND_FAILED' ? { code: 'PI_COMMAND_FAILED', message: 'Pi package update failed' } : error)
    }

    const roots = item.metadata?.packageRoots ?? []
    const versions = roots.map((root) => readPackageVersion(root, 'nsolid-pi-plugin')).filter((version): version is string => isStableVersion(version))
    if (roots.length > 0 && versions.length !== roots.length) {
      return failedResult(item, { code: 'PI_PACKAGE_MISSING', message: 'An affected Pi package cache is missing after update' })
    }
    if (item.version.latest && versions.length > 0 && versions.some((version) => compareVersions(version, item.version.latest!) < 0)) {
      return failedResult(item, { code: 'PI_VERSION_MISMATCH', message: 'One affected Pi package cache is older than the planned version' })
    }
    const evidenceError = await validatePiEvidence(item, versions, context.options.fetchImpl)
    if (evidenceError) return failedResult(item, evidenceError)
    return resultFromPlan(item, 'updated', { resultingVersion: versions.sort((a, b) => compareVersions(b, a))[0] ?? item.version.latest })
  },
}

function piEvidencePlanningError (installation: UpdateInstallation): UpdateError | undefined {
  const roots = installation.metadata?.packageRoots ?? []
  if (roots.length === 0) return { code: 'PI_PROVENANCE_UNVERIFIED', message: 'Pi did not provide an affected package cache to verify' }
  const paths = installation.metadata?.packageEvidencePaths ?? []
  if (paths.length !== roots.length) return { code: 'PI_PROVENANCE_UNVERIFIED', message: 'Pi did not provide provenance evidence for every affected cache' }
  for (let index = 0; index < roots.length; index++) {
    const evidence = readPiEvidence(paths[index]!, roots[index]!)
    if (!evidence || evidence.packageName !== 'nsolid-pi-plugin' || typeof evidence.version !== 'string' || !isStableVersion(evidence.version) || typeof evidence.resolved !== 'string' || typeof evidence.integrity !== 'string' || !isValidIntegrity(evidence.integrity)) {
      return { code: 'PI_PROVENANCE_UNVERIFIED', message: 'Pi package provenance evidence is missing or invalid' }
    }
  }
  return undefined
}

function revalidatePiPlan (item: UpdatePlanItem) {
  const metadata = item.metadata
  if (!metadata) return undefined
  if (metadata.projectRoot && metadata.projectRootIdentity && safeRealpath(metadata.projectRoot) !== metadata.projectRootIdentity) {
    return { code: 'PI_SCOPE_DRIFT', message: 'Pi project root changed after planning' }
  }
  const paths = metadata.settingsPaths ?? []
  const expected = metadata.settingsDigests ?? []
  if (paths.length !== expected.length || paths.some((filePath, index) => digest(filePath) !== expected[index])) {
    return { code: 'PI_SETTINGS_DRIFT', message: 'Pi settings changed after planning' }
  }
  const roots = metadata.packageRoots ?? []
  const rootIdentities = metadata.packageRootIdentities ?? []
  const cacheDigests = metadata.cacheDigests ?? []
  if (roots.length !== rootIdentities.length || roots.some((root, index) => safeRealpath(root) !== rootIdentities[index])) {
    return { code: 'PI_CACHE_DRIFT', message: 'Pi package cache roots changed after planning' }
  }
  if (roots.length !== cacheDigests.length || roots.some((root, index) => digest(path.join(root, 'package.json')) !== cacheDigests[index])) {
    return { code: 'PI_CACHE_DRIFT', message: 'Pi package cache contents changed after planning' }
  }
  const evidencePaths = metadata.packageEvidencePaths ?? []
  const evidenceDigests = metadata.packageEvidenceDigests ?? []
  if (roots.length !== evidencePaths.length || evidencePaths.length !== evidenceDigests.length || evidencePaths.some((filePath, index) => digest(filePath) !== evidenceDigests[index])) {
    return { code: 'PI_EVIDENCE_DRIFT', message: 'Pi package provenance evidence changed after planning' }
  }
  const sources = metadata.sourceEntries ?? []
  if (sources.some((source) => source !== 'npm:nsolid-pi-plugin')) {
    return { code: 'PI_SOURCE_DRIFT', message: 'Pi package source changed after planning' }
  }
  return undefined
}

function digest (filePath: string): string {
  try { return createHash('sha256').update(readFileSync(filePath)).digest('hex') } catch { return '' }
}

function safeRealpath (filePath: string): string {
  try { return realpathSync(filePath) } catch { return path.resolve(filePath) }
}

async function validatePiEvidence (item: UpdatePlanItem, versions: readonly string[], fetchImpl?: typeof fetch): Promise<UpdateError | undefined> {
  const metadata = item.metadata
  const artifact = item.artifact?.kind === 'npm' ? item.artifact : undefined
  const roots = metadata?.packageRoots ?? []
  const paths = metadata?.packageEvidencePaths ?? []
  if (!artifact || roots.length === 0 || roots.length !== paths.length || versions.length !== roots.length) {
    return { code: 'PI_PROVENANCE_UNVERIFIED', message: 'Pi did not provide verifiable package provenance for every affected cache' }
  }

  for (let index = 0; index < roots.length; index++) {
    const evidence = readPiEvidence(paths[index]!, roots[index]!)
    if (!evidence || evidence.packageName !== 'nsolid-pi-plugin' || typeof evidence.version !== 'string' || !isStableVersion(evidence.version) || !isStableVersion(versions[index]) || evidence.version !== versions[index] || typeof evidence.resolved !== 'string' || typeof evidence.integrity !== 'string') {
      return { code: 'PI_PROVENANCE_UNVERIFIED', message: 'Pi package provenance evidence is missing or invalid' }
    }
    if (compareVersions(evidence.version, item.version.latest ?? evidence.version) < 0 || !isValidIntegrity(evidence.integrity) || !belongsToRegistry(evidence.resolved, artifact.registry)) {
      return { code: 'PI_PROVENANCE_MISMATCH', message: 'Pi package provenance does not match the frozen registry identity' }
    }

    let expectedArtifact: NpmArtifactIdentity | undefined = artifact
    let expectedError: UpdateError | undefined
    if (compareVersions(evidence.version, item.version.latest ?? evidence.version) !== 0) {
      const expected = await resolveRegistryArtifactVersion('nsolid-pi-plugin', evidence.version, {
        fetchImpl,
        registry: artifact.registry,
      })
      expectedArtifact = expected.artifact?.kind === 'npm' ? expected.artifact : undefined
      expectedError = expected.error
    }
    const evidenceUrl = normalizeUrl(evidence.resolved)
    const expectedUrl = expectedArtifact ? normalizeUrl(expectedArtifact.tarball) : undefined
    if (expectedError || !expectedArtifact || expectedArtifact.registry !== artifact.registry || !evidenceUrl || !expectedUrl || evidenceUrl !== expectedUrl || evidence.integrity !== expectedArtifact.integrity) {
      return { code: 'PI_PROVENANCE_MISMATCH', message: 'Pi package provenance does not match the verified package artifact' }
    }
  }
  return undefined
}

interface PiEvidence {
  packageName?: unknown
  version?: unknown
  resolved?: unknown
  integrity?: unknown
}

function readPiEvidence (filePath: string, packageRoot: string): PiEvidence | undefined {
  try {
    if (!existsSync(filePath)) return undefined
    const data = JSON.parse(readFileSync(filePath, 'utf8')) as unknown
    if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined
    if (path.basename(filePath) === 'package.json') {
      const packageJson = data as Record<string, unknown>
      return {
        packageName: packageJson.name,
        version: packageJson.version,
        resolved: packageJson._resolved ?? packageJson.resolved,
        integrity: packageJson._integrity ?? packageJson.integrity,
      }
    }
    const lock = data as Record<string, unknown>
    const packages = lock.packages
    if (packages && typeof packages === 'object' && !Array.isArray(packages)) {
      const relative = path.relative(path.dirname(filePath), packageRoot).split(path.sep).join('/')
      const candidates = [relative, `node_modules/${'nsolid-pi-plugin'}`]
      for (const key of candidates) {
        const record = (packages as Record<string, unknown>)[key]
        if (record && typeof record === 'object' && !Array.isArray(record)) {
          return { ...(record as PiEvidence), packageName: (record as Record<string, unknown>).name ?? 'nsolid-pi-plugin' }
        }
      }
      for (const [key, value] of Object.entries(packages as Record<string, unknown>)) {
        if (key.endsWith('/node_modules/nsolid-pi-plugin') || key === 'node_modules/nsolid-pi-plugin') {
          if (value && typeof value === 'object' && !Array.isArray(value)) return { ...(value as PiEvidence), packageName: (value as Record<string, unknown>).name ?? 'nsolid-pi-plugin' }
        }
      }
    }
    const dependencies = lock.dependencies
    const dependency = dependencies && typeof dependencies === 'object' && !Array.isArray(dependencies)
      ? (dependencies as Record<string, unknown>)['nsolid-pi-plugin']
      : undefined
    return dependency && typeof dependency === 'object' && !Array.isArray(dependency) ? dependency as PiEvidence : undefined
  } catch {
    return undefined
  }
}

function isValidIntegrity (value: string): boolean {
  return parseIntegrity(value) !== undefined
}

function belongsToRegistry (resolved: string, registry: string): boolean {
  try {
    const base = new URL(registry)
    const candidate = new URL(resolved, base)
    if (candidate.protocol !== base.protocol || candidate.hostname.toLowerCase() !== base.hostname.toLowerCase() || candidate.port !== base.port) return false
    const basePath = base.pathname.replace(/\/+$/, '')
    return candidate.pathname === basePath || candidate.pathname.startsWith(`${basePath}/`)
  } catch {
    return false
  }
}

function normalizeUrl (value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  try {
    const url = new URL(value)
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    return url.toString()
  } catch {
    return undefined
  }
}
