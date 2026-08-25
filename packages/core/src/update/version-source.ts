import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import type { MarketplaceVersionSource, NpmArtifactIdentity, UpdateError, VersionLookupResult } from './types.js'
import { isStableVersion } from './version.js'
import { bytesMatchIntegrity } from './integrity.js'
import { redactSecrets } from './redaction.js'

export interface VersionSourceOptions {
  fetchImpl?: typeof fetch
  /** Effective npm registry captured for this lookup (defaults to npmjs). */
  registry?: string
  timeoutMs?: number
  /** Download and verify the immutable npm artifact for a mutating plan. */
  downloadArtifact?: boolean
  /** Reject mutable Git refs that could not be resolved to a commit. */
  requireImmutable?: boolean
}

const DEFAULT_TIMEOUT_MS = 15_000
const SAFE_RELATIVE_PATH = /^(?![\\/])(?!(?:.*[\\/])?\.\.(?:[\\/]|$))[A-Za-z0-9._/-]+$/

export async function resolveRegistryVersion (
  packageName: string,
  options: VersionSourceOptions = {}
): Promise<VersionLookupResult> {
  if (!/^(@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+$/.test(packageName)) {
    return { error: lookupError('INVALID_PACKAGE', 'Package name is invalid') }
  }
  let registry: string
  try {
    registry = normalizeRegistryUrl(options.registry)
  } catch {
    return { error: lookupError('INVALID_REGISTRY_URL', 'Configured npm registry URL is invalid') }
  }

  try {
    const data = await fetchJson(`${registry}${encodeURIComponent(packageName)}`, options)
    const metadata = data as {
      'dist-tags'?: { latest?: unknown }
      versions?: Record<string, { version?: unknown; dist?: { tarball?: unknown; integrity?: unknown }; registry?: unknown }>
      dist?: { tarball?: unknown; integrity?: unknown }
      registry?: unknown
    }
    const latest = metadata['dist-tags']?.latest
    if (!isStableVersion(latest)) {
      return { error: lookupError('INVALID_REGISTRY_VERSION', 'Registry latest version is invalid') }
    }
    const selectedVersion = metadata.versions?.[latest]
    if (selectedVersion?.version !== undefined && selectedVersion.version !== latest) {
      return { error: lookupError('INVALID_REGISTRY_ARTIFACT', 'Registry artifact version does not match latest') }
    }
    // A normal npm packument stores artifact identity under versions[latest].
    // Keep accepting top-level dist for version-specific registry responses.
    const dist = selectedVersion?.dist ?? metadata.dist
    const tarball = typeof dist?.tarball === 'string' ? dist.tarball : undefined
    const integrity = typeof dist?.integrity === 'string' ? dist.integrity : undefined
    const declaredRegistry = selectedVersion && Object.prototype.hasOwnProperty.call(selectedVersion, 'registry')
      ? selectedVersion.registry
      : Object.prototype.hasOwnProperty.call(metadata, 'registry')
        ? metadata.registry
        : undefined
    let artifactRegistry = registry.replace(/\/$/, '')
    if (declaredRegistry !== undefined || (selectedVersion && Object.prototype.hasOwnProperty.call(selectedVersion, 'registry')) || Object.prototype.hasOwnProperty.call(metadata, 'registry')) {
      if (typeof declaredRegistry !== 'string') return { error: lookupError('INVALID_REGISTRY_ARTIFACT', 'Registry artifact declares an invalid registry URL') }
      try {
        artifactRegistry = normalizeRegistryUrl(declaredRegistry).replace(/\/$/, '')
      } catch {
        return { error: lookupError('INVALID_REGISTRY_ARTIFACT', 'Registry artifact declares an invalid registry URL') }
      }
    }
    // Keep version-only lookup compatibility for registries/proxies that omit
    // dist metadata. Mutation strategies that require byte identity reject the
    // resulting lookup before constructing an executable plan.
    if (!tarball || !integrity) return { version: latest }
    let parsedTarball: URL
    try {
      parsedTarball = new URL(tarball, registry)
      if (!['https:', 'http:'].includes(parsedTarball.protocol)) throw new Error('unsupported tarball protocol')
    } catch {
      return { error: lookupError('INVALID_REGISTRY_ARTIFACT', 'Registry tarball URL is invalid') }
    }
    const artifact: NpmArtifactIdentity = {
      kind: 'npm',
      packageName: packageName as NpmArtifactIdentity['packageName'],
      version: latest,
      registry: artifactRegistry,
      tarball: parsedTarball.toString(),
      integrity,
    }
    if (options.downloadArtifact) {
      try {
        const downloaded = await downloadAndVerifyTarball(parsedTarball.toString(), integrity, options)
        artifact.tarballPath = downloaded.path
        artifact.tempDirectory = downloaded.directory
        artifact.contentDigest = downloaded.contentDigest
      } catch (error) {
        return { error: lookupError('ARTIFACT_INTEGRITY_FAILED', sanitizeLookupMessage(error)) }
      }
    }
    return { version: latest, artifact }
  } catch (error) {
    return { error: lookupError('REGISTRY_LOOKUP_FAILED', sanitizeLookupMessage(error)) }
  }
}

export async function resolveRegistryArtifactVersion (
  packageName: string,
  version: string,
  options: VersionSourceOptions = {}
): Promise<VersionLookupResult> {
  if (!/^(@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+$/.test(packageName)) {
    return { error: lookupError('INVALID_PACKAGE', 'Package name is invalid') }
  }
  if (!isStableVersion(version)) return { error: lookupError('INVALID_REGISTRY_VERSION', 'Registry version is invalid') }

  let registry: string
  try {
    registry = normalizeRegistryUrl(options.registry)
  } catch {
    return { error: lookupError('INVALID_REGISTRY_URL', 'Configured npm registry URL is invalid') }
  }

  try {
    const data = await fetchJson(`${registry}${encodeURIComponent(packageName)}`, options) as {
      versions?: Record<string, { version?: unknown; dist?: { tarball?: unknown; integrity?: unknown }; registry?: unknown }>
      registry?: unknown
    }
    const selected = data.versions?.[version]
    if (!selected || (selected.version !== undefined && selected.version !== version)) {
      return { error: lookupError('INVALID_REGISTRY_ARTIFACT', 'Registry did not return the requested package version') }
    }
    const tarball = typeof selected.dist?.tarball === 'string' ? selected.dist.tarball : undefined
    const integrity = typeof selected.dist?.integrity === 'string' ? selected.dist.integrity : undefined
    if (!tarball || !integrity) return { error: lookupError('INVALID_REGISTRY_ARTIFACT', 'Registry package version has no immutable artifact identity') }
    const declaredRegistry = Object.prototype.hasOwnProperty.call(selected, 'registry')
      ? selected.registry
      : Object.prototype.hasOwnProperty.call(data, 'registry') ? data.registry : undefined
    let artifactRegistry = registry.replace(/\/$/, '')
    if (declaredRegistry !== undefined || Object.prototype.hasOwnProperty.call(selected, 'registry') || Object.prototype.hasOwnProperty.call(data, 'registry')) {
      if (typeof declaredRegistry !== 'string') return { error: lookupError('INVALID_REGISTRY_ARTIFACT', 'Registry artifact declares an invalid registry URL') }
      try { artifactRegistry = normalizeRegistryUrl(declaredRegistry).replace(/\/$/, '') } catch { return { error: lookupError('INVALID_REGISTRY_ARTIFACT', 'Registry artifact declares an invalid registry URL') } }
    }
    let parsedTarball: URL
    try {
      parsedTarball = new URL(tarball, registry)
      if (!['https:', 'http:'].includes(parsedTarball.protocol)) throw new Error('unsupported tarball protocol')
    } catch {
      return { error: lookupError('INVALID_REGISTRY_ARTIFACT', 'Registry tarball URL is invalid') }
    }
    return {
      version,
      artifact: {
        kind: 'npm',
        packageName: packageName as NpmArtifactIdentity['packageName'],
        version,
        registry: artifactRegistry,
        tarball: parsedTarball.toString(),
        integrity,
      },
    }
  } catch (error) {
    return { error: lookupError('REGISTRY_LOOKUP_FAILED', sanitizeLookupMessage(error)) }
  }
}

export async function resolveMarketplaceVersion (
  source: MarketplaceVersionSource,
  options: VersionSourceOptions = {}
): Promise<VersionLookupResult> {
  if (source.kind === 'unknown') {
    return {}
  }

  if (!isSafeManifestPath(source.manifestPath)) {
    return {}
  }

  if (source.kind === 'local-snapshot') {
    if (source.freshness !== 'verified') {
      return {}
    }
    const manifestPath = path.resolve(source.root, source.manifestPath)
    const result = await readManifestVersion(manifestPath)
    if (result.version) {
      const contentDigest = await digestFile(manifestPath)
      if (source.contentDigest && contentDigest && source.contentDigest !== contentDigest) return { error: lookupError('SOURCE_CONTENT_MISMATCH', 'Marketplace snapshot content changed after discovery') }
      if (contentDigest) result.artifact = { kind: 'local-snapshot', root: path.resolve(source.root), contentDigest }
    }
    return result
  }

  const repository = sanitizeRepository(source.repository)
  if (!repository) return { error: lookupError('INVALID_MARKETPLACE_SOURCE', 'Marketplace repository is invalid') }
  let revision = isFullCommit(source.commit) ? source.commit : source.commit ?? source.revision ?? 'HEAD'
  if (options.requireImmutable && !isFullCommit(revision)) {
    const resolvedCommit = await resolveGitCommit(repository, revision, options)
    if (!resolvedCommit) return { error: lookupError('IMMUTABLE_SOURCE_UNAVAILABLE', 'Marketplace ref could not be resolved to an immutable commit') }
    revision = resolvedCommit
  }
  if (!isSafeRevision(revision)) return {}
  const rawUrl = toRawManifestUrl(repository, revision, source.manifestPath)
  try {
    const response = await fetchWithTimeout(rawUrl, options)
    if (!response.ok) throw new Error(`marketplace returned ${response.status}`)
    const body = await response.text()
    const parsed = parseJsonResponse(body, 'marketplace response was not valid JSON')
    const version = extractVersion(parsed)
    if (!isStableVersion(version)) throw new Error('marketplace manifest version is invalid')
    const responseCommit = response.headers.get('x-commit-sha') ?? response.headers.get('x-git-commit') ?? undefined
    const commit = isFullCommit(responseCommit) ? responseCommit : isFullCommit(source.commit) ? source.commit : isFullCommit(revision) ? revision : undefined
    if (options.requireImmutable && !commit) return { error: lookupError('IMMUTABLE_SOURCE_UNAVAILABLE', 'Marketplace response did not identify an immutable commit') }
    const contentDigest = sha256(body)
    if (source.contentDigest && source.contentDigest !== contentDigest) return { error: lookupError('SOURCE_CONTENT_MISMATCH', 'Marketplace content changed after discovery') }
    return commit
      ? { version, artifact: { kind: 'git', repository, commit, contentDigest } }
      : { version }
  } catch (error) {
    return { error: lookupError('MARKETPLACE_LOOKUP_FAILED', sanitizeLookupMessage(error)) }
  }
}

export async function resolveFixedGitBundleVersion (
  options: VersionSourceOptions = {}
): Promise<VersionLookupResult> {
  try {
    const repository = 'https://github.com/NodeSource/nsolid-plugin.git'
    const revision = options.requireImmutable
      ? await resolveGitCommit(repository, 'main', options)
      : 'main'
    if (options.requireImmutable && !revision) return { error: lookupError('IMMUTABLE_SOURCE_UNAVAILABLE', 'Fixed source could not be resolved to an immutable commit') }
    const effectiveRevision = revision ?? 'main'
    const response = await fetchWithTimeout(
      `https://raw.githubusercontent.com/NodeSource/nsolid-plugin/${effectiveRevision}/bundle.json`,
      options
    )
    if (!response.ok) throw new Error(`fixed source returned ${response.status}`)
    const body = await response.text()
    const data = parseJsonResponse(body, 'fixed source response was not valid JSON')
    const version = extractVersion(data)
    if (!isStableVersion(version)) throw new Error('fixed source version is invalid')
    const commit = response.headers.get('x-commit-sha') ?? response.headers.get('x-git-commit') ?? effectiveRevision
    if (options.requireImmutable && !isFullCommit(commit)) return { error: lookupError('IMMUTABLE_SOURCE_UNAVAILABLE', 'Fixed source response did not identify an immutable commit') }
    return isFullCommit(commit)
      ? { version, artifact: { kind: 'git', repository, commit, contentDigest: sha256(body) } }
      : { version }
  } catch (error) {
    return { error: lookupError('FIXED_SOURCE_LOOKUP_FAILED', sanitizeLookupMessage(error)) }
  }
}

export function sanitizeRepository (repository: string): string | undefined {
  const githubShorthand = repository.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:\.git)?$/)
  if (githubShorthand) return `https://github.com/${githubShorthand[1]}/${githubShorthand[2]}.git`
  try {
    const parsed = new URL(repository)
    if (!['https:', 'http:', 'ssh:'].includes(parsed.protocol)) return undefined
    parsed.username = ''
    parsed.password = ''
    parsed.hash = ''
    parsed.search = ''
    return parsed.toString().replace(/\/$/, '')
  } catch {
    return undefined
  }
}

export function isSafeManifestPath (manifestPath: string): boolean {
  return SAFE_RELATIVE_PATH.test(manifestPath) && !manifestPath.includes('\\')
}

function isSafeRevision (revision: string): boolean {
  return revision.length > 0 && !revision.startsWith('/') && !revision.includes('\\') && !revision.split('/').includes('..') && !/[\s?#]/.test(revision)
}

function toRawManifestUrl (repository: string, revision: string, manifestPath: string): string {
  const parsed = new URL(repository)
  const segments = parsed.pathname.replace(/\.git$/, '').split('/').filter(Boolean)
  if (segments.length < 2) throw new Error('marketplace repository has no owner/name')
  const host = parsed.hostname.toLowerCase()
  if (host === 'github.com') {
    const encodedRevision = revision.split('/').map((segment) => encodeURIComponent(segment)).join('/')
    return `https://raw.githubusercontent.com/${segments.join('/')}/${encodedRevision}/${manifestPath}`
  }
  const encodedRevision = revision.split('/').map((segment) => encodeURIComponent(segment)).join('/')
  return `${repository}/raw/${encodedRevision}/${manifestPath}`
}

async function readManifestVersion (filePath: string): Promise<VersionLookupResult> {
  try {
    const parsed = JSON.parse(await readFile(filePath, 'utf8')) as unknown
    const version = extractVersion(parsed)
    return isStableVersion(version)
      ? { version }
      : { error: lookupError('INVALID_MARKETPLACE_VERSION', 'Marketplace manifest version is invalid') }
  } catch {
    return { error: lookupError('MARKETPLACE_LOOKUP_FAILED', 'Marketplace snapshot could not be read') }
  }
}

async function fetchJson (url: string, options: VersionSourceOptions): Promise<unknown> {
  const response = await fetchWithTimeout(url, options)
  if (!response.ok) throw new Error(`registry returned ${response.status}`)
  return parseJsonResponse(await response.text(), 'registry response was not valid JSON')
}

function parseJsonResponse (body: string, failureMessage: string): unknown {
  try {
    return JSON.parse(body) as unknown
  } catch {
    throw new Error(failureMessage)
  }
}

async function fetchWithTimeout (url: string, options: VersionSourceOptions): Promise<Response> {
  const fetchImpl = options.fetchImpl ?? fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  try {
    return await fetchImpl(url, { signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

function extractVersion (value: unknown): unknown {
  if (!value || typeof value !== 'object') return undefined
  const object = value as Record<string, unknown>
  if (typeof object.version === 'string') return object.version
  const plugin = object.plugin
  if (plugin && typeof plugin === 'object' && typeof (plugin as { version?: unknown }).version === 'string') {
    return (plugin as { version: string }).version
  }
  return undefined
}

function lookupError (code: string, message: string): UpdateError {
  return { code, message: message.replace(/[\r\n]/g, ' ').slice(0, 240) }
}

function sanitizeLookupMessage (error: unknown): string {
  const message = error instanceof Error ? error.message : 'version lookup failed'
  return redactSecrets(message)
    .replace(/[\r\n]/g, ' ')
    .slice(0, 240)
}

function normalizeRegistryUrl (value?: string): string {
  const candidate = value ?? process.env.npm_config_registry ?? process.env.NPM_CONFIG_REGISTRY ?? 'https://registry.npmjs.org/'
  const url = new URL(candidate)
  if (!['https:', 'http:'].includes(url.protocol)) throw new Error('unsupported registry protocol')
  url.username = ''
  url.password = ''
  url.search = ''
  url.hash = ''
  url.pathname = url.pathname.replace(/\/+$/, '') + '/'
  return url.toString()
}

function isFullCommit (value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40}$/i.test(value)
}

async function resolveGitCommit (repository: string, revision: string, options: VersionSourceOptions): Promise<string | undefined> {
  try {
    const parsed = new URL(repository)
    if (parsed.hostname.toLowerCase() !== 'github.com') return undefined
    const segments = parsed.pathname.replace(/\.git$/, '').split('/').filter(Boolean)
    if (segments.length !== 2) return undefined
    const url = `https://api.github.com/repos/${segments[0]}/${segments[1]}/commits/${revision.split('/').map(encodeURIComponent).join('/')}`
    const response = await fetchWithTimeout(url, options)
    if (!response.ok) return undefined
    const body = JSON.parse(await response.text()) as { sha?: unknown; object?: { sha?: unknown }; commit?: { sha?: unknown } }
    const commit = body.sha ?? body.object?.sha ?? body.commit?.sha
    return isFullCommit(commit) ? commit : undefined
  } catch { return undefined }
}

function sha256 (value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

async function digestFile (filePath: string): Promise<string | undefined> {
  try { return sha256(await readFile(filePath)) } catch { return undefined }
}

async function downloadAndVerifyTarball (
  url: string,
  integrity: string,
  options: VersionSourceOptions
): Promise<{ path: string; directory: string; contentDigest: string }> {
  const response = await fetchWithTimeout(url, options)
  if (!response.ok) throw new Error(`registry tarball returned ${response.status}`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (!bytesMatchIntegrity(bytes, integrity)) throw new Error('registry tarball integrity mismatch')
  const directory = await mkdtemp(path.join(os.tmpdir(), 'nsolid-plugin-artifact-'))
  const tarballPath = path.join(directory, 'package.tgz')
  await writeFile(tarballPath, bytes, { mode: 0o600 })
  return { path: tarballPath, directory, contentDigest: sha256(bytes) }
}

export async function cleanupNpmArtifact (artifact: NpmArtifactIdentity | undefined): Promise<void> {
  if (!artifact?.tempDirectory) return
  await rm(artifact.tempDirectory, { recursive: true, force: true }).catch(() => {})
}

export async function downloadNpmArtifact (
  artifact: NpmArtifactIdentity,
  options: VersionSourceOptions = {}
): Promise<NpmArtifactIdentity> {
  if (artifact.tarballPath) return artifact
  const downloaded = await downloadAndVerifyTarball(artifact.tarball, artifact.integrity, options)
  return { ...artifact, tarballPath: downloaded.path, tempDirectory: downloaded.directory, contentDigest: downloaded.contentDigest }
}
