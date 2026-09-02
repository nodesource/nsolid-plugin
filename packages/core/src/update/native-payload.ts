import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readlinkSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { gunzipSync } from 'node:zlib'

type PayloadEntry =
  | { kind: 'file'; content: Buffer }
  | { kind: 'symlink'; target: string }
  | { kind: 'directory' }

const MAX_PAYLOAD_FILES = 4096
const MAX_PAYLOAD_BYTES = 128 * 1024 * 1024
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024
const MAX_UNPACKED_ARCHIVE_BYTES = 160 * 1024 * 1024

export interface ArchivePayloadScope {
  /** Repo-relative POSIX directory the installable payload lives in ('' or undefined = repository root). */
  payloadPath?: string
  /** Payload-relative POSIX manifest path that must exist inside the subtree. */
  manifestPath?: string
}

/**
 * Named payload normalization profiles for installed-comparison digests.
 * Each profile lists the exact payload-root entries proven to be created or
 * rewritten by a harness; those entries are normalized ONLY in the
 * installed-comparison digest, never in the strict evidence digest.
 *
 * Role semantics (enforced by the digest helpers below):
 * - Installed side (`nativePayloadTreeDigest`): only a ROOT REGULAR FILE with
 *   a reserved name is excluded; a symlink or directory at a reserved name
 *   stays significant so a crafted entry cannot hide behind the profile.
 * - Planning side (`gitArchivePayloadDigest`, planned identity helpers): the
 *   planned source must be free of reserved paths. Any reserved-path entry in
 *   the planned payload yields NO comparison identity, so execution fails
 *   closed instead of masking payload-authored content.
 * Nested paths and unapproved files always stay significant under both roles.
 */
export type PayloadNormalizationProfile = 'codex-installed-v1'

/** Root entries proven to be written by the Codex marketplace installer. */
export const PAYLOAD_NORMALIZATION_PROFILES: Readonly<Record<PayloadNormalizationProfile, readonly string[]>> = {
  'codex-installed-v1': ['.codex-marketplace-install.json'],
}

// Only reserved root directories need identity markers. Ordinary and nested
// directories remain implicit so existing strict payload digests do not change.
const RESERVED_NORMALIZATION_ROOT_NAMES: ReadonlySet<string> = new Set(
  Object.values(PAYLOAD_NORMALIZATION_PROFILES).flat()
)

/** Profile used for Codex installed-payload equivalence comparisons. */
export const CODEX_INSTALLED_COMPARISON_PROFILE: PayloadNormalizationProfile = 'codex-installed-v1'

/** Runtime validation: unrecognized profile values must never digest silently. */
export function isPayloadNormalizationProfile (value: unknown): value is PayloadNormalizationProfile {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(PAYLOAD_NORMALIZATION_PROFILES, value)
}

export interface PayloadDigestOptions {
  /** Named normalization profile; undefined keeps strict evidence behavior. */
  profile?: PayloadNormalizationProfile
}

/** Strict evidence digest plus the installed-comparison identity of one planned payload capture. */
export interface PlannedPayloadIdentity {
  contentDigest?: string
  comparisonDigest?: string
  comparisonProfile?: PayloadNormalizationProfile
}

/** Normalize a repo-relative POSIX directory (payload scope). Rejects traversal. */
export function normalizedPayloadPath (value: string | undefined): string {
  const normalized = (value ?? '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
  if (!normalized) return ''
  if (normalized.startsWith('/') || normalized.split('/').some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error('unsafe payload path')
  }
  return normalized
}

/** Hex sha256 of a byte buffer, shared by the native transactions. */
export function sha256Hex (value: Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

/** Raw single capture of a payload tree; limits enforced, no normalization. */
function captureTreePayload (root: string): Map<string, PayloadEntry> | undefined {
  try {
    const resolvedRoot = path.resolve(root)
    const entries = new Map<string, PayloadEntry>()
    let totalBytes = 0
    const walk = (directory: string, relativeRoot: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        // Root .git is always excluded from every identity; profile
        // normalization happens at digest time so one raw capture can feed
        // both the strict and the comparison digest.
        if (!relativeRoot && entry.name === '.git') continue
        const relative = relativeRoot ? `${relativeRoot}/${entry.name}` : entry.name
        assertSafeRelativePath(relative)
        const absolute = path.join(directory, entry.name)
        const stat = lstatSync(absolute)
        if (stat.isDirectory() && !stat.isSymbolicLink()) {
          if (!relativeRoot && RESERVED_NORMALIZATION_ROOT_NAMES.has(entry.name)) {
            entries.set(`${entry.name}/`, { kind: 'directory' })
          }
          walk(absolute, relative)
        } else if (stat.isFile()) {
          const content = readFileSync(absolute)
          totalBytes += content.length
          entries.set(relative, { kind: 'file', content })
        } else if (stat.isSymbolicLink()) {
          entries.set(relative, { kind: 'symlink', target: readlinkSync(absolute) })
        } else {
          throw new Error('unsupported payload entry')
        }
        if (entries.size > MAX_PAYLOAD_FILES || totalBytes > MAX_PAYLOAD_BYTES) throw new Error('payload exceeds limits')
      }
    }
    walk(resolvedRoot, '')
    return entries
  } catch {
    return undefined
  }
}

/**
 * Digest an installed payload tree. Strict by default; under a profile only
 * proven harness-written root regular files are normalized, so symlinks,
 * directories, and nested paths at reserved names stay significant.
 */
export function nativePayloadTreeDigest (root: string, options: PayloadDigestOptions = {}): string | undefined {
  const entries = captureTreePayload(root)
  if (!entries) return undefined
  if (options.profile === undefined) return digestEntries(entries)
  // An unrecognized profile must never silently fall back to strict behavior.
  if (!isPayloadNormalizationProfile(options.profile)) return undefined
  return digestEntries(installedComparisonEntries(entries, options.profile))
}

/**
 * Digest the planned payload of a `git archive` tarball. Entries outside
 * `scope.payloadPath` (for example sibling plugins in a multi-plugin
 * marketplace repository) are excluded instead of compared, and the manifest
 * must exist inside the subtree when `scope.manifestPath` is set. Strict by
 * default; under a profile the planned source must be free of reserved
 * harness paths, so a reserved-path entry yields no digest and the plan
 * fails closed.
 */
export function gitArchivePayloadDigest (compressedArchive: Buffer, scope: ArchivePayloadScope = {}, options: PayloadDigestOptions = {}): string | undefined {
  const entries = captureArchivePayload(compressedArchive, scope)
  if (!entries) return undefined
  if (options.profile === undefined) return digestEntries(entries)
  // An unrecognized profile must never silently fall back to strict behavior.
  if (!isPayloadNormalizationProfile(options.profile)) return undefined
  return plannedComparisonDigest(entries, options.profile)
}

/** Plan-side identity from a local snapshot: ONE raw capture feeds both digests. */
export function plannedPayloadIdentityFromTree (root: string, profile: PayloadNormalizationProfile): PlannedPayloadIdentity {
  if (!isPayloadNormalizationProfile(profile)) return {}
  return plannedIdentityFromCapture(captureTreePayload(root), profile)
}

/** Plan-side identity from a Git archive: ONE parse feeds both digests. */
export function plannedPayloadIdentityFromArchive (compressedArchive: Buffer, scope: ArchivePayloadScope, profile: PayloadNormalizationProfile): PlannedPayloadIdentity {
  if (!isPayloadNormalizationProfile(profile)) return {}
  return plannedIdentityFromCapture(captureArchivePayload(compressedArchive, scope), profile)
}

function plannedIdentityFromCapture (entries: Map<string, PayloadEntry> | undefined, profile: PayloadNormalizationProfile): PlannedPayloadIdentity {
  if (!entries) return {}
  const contentDigest = digestEntries(entries)
  if (!contentDigest) return {}
  const comparisonDigest = plannedComparisonDigest(entries, profile)
  if (!comparisonDigest) return { contentDigest }
  return { contentDigest, comparisonDigest, comparisonProfile: profile }
}

/** Drop only proven harness-written root regular files from a captured tree. */
function installedComparisonEntries (entries: Map<string, PayloadEntry>, profile: PayloadNormalizationProfile): Map<string, PayloadEntry> {
  const filtered = new Map(entries)
  for (const name of PAYLOAD_NORMALIZATION_PROFILES[profile]) {
    if (filtered.get(name)?.kind === 'file') filtered.delete(name)
  }
  return filtered
}

/**
 * Planned-side comparison digest: reserved harness paths must not exist in
 * the planned source; any collision yields no comparison identity so that
 * execution fails closed instead of masking payload content.
 */
function plannedComparisonDigest (entries: Map<string, PayloadEntry>, profile: PayloadNormalizationProfile): string | undefined {
  for (const name of PAYLOAD_NORMALIZATION_PROFILES[profile]) {
    if (entries.has(name)) return undefined
    const prefix = `${name}/`
    for (const relative of entries.keys()) {
      if (relative.startsWith(prefix)) return undefined
    }
  }
  return digestEntries(entries)
}

/** Raw single parse of the installable payload subtree of a `git archive`. */
function captureArchivePayload (compressedArchive: Buffer, scope: ArchivePayloadScope): Map<string, PayloadEntry> | undefined {
  try {
    if (compressedArchive.length > MAX_ARCHIVE_BYTES) return undefined
    const payloadPath = normalizedPayloadPath(scope.payloadPath)
    const manifestPath = normalizedPayloadPath(scope.manifestPath)
    const payloadPrefix = payloadPath ? `${payloadPath}/` : ''
    const archive = gunzipSync(compressedArchive, { maxOutputLength: MAX_UNPACKED_ARCHIVE_BYTES })
    const entries = new Map<string, PayloadEntry>()
    let offset = 0
    let longPath: string | undefined
    let paxPath: string | undefined
    let archiveRoot: string | undefined
    let totalBytes = 0
    while (offset + 512 <= archive.length) {
      const header = archive.subarray(offset, offset + 512)
      if (header.every((value) => value === 0)) break
      const size = tarNumber(header.subarray(124, 136))
      const bodyStart = offset + 512
      const bodyEnd = bodyStart + size
      if (!Number.isSafeInteger(size) || size < 0 || bodyEnd > archive.length) throw new Error('invalid tar size')
      const body = archive.subarray(bodyStart, bodyEnd)
      const type = String.fromCharCode(header[156] || 48)
      const headerPath = [tarString(header.subarray(345, 500)), tarString(header.subarray(0, 100))].filter(Boolean).join('/')

      if (type === 'L') longPath = tarString(body)
      else if (type === 'x') paxPath = parsePaxPath(body)
      else if (type !== 'g') {
        const entryPath = normalizeArchivePath(paxPath ?? longPath ?? headerPath)
        paxPath = undefined
        longPath = undefined
        if (entryPath) {
          const segments = entryPath.split('/')
          archiveRoot ??= segments[0]
          if (segments[0] !== archiveRoot) throw new Error('multiple archive roots')
          const repositoryRelative = segments.slice(1).join('/').replace(/\/$/, '')
          if (repositoryRelative && !repositoryRelative.startsWith('.git/') && (!payloadPrefix || repositoryRelative.startsWith(payloadPrefix))) {
            const relative = payloadPrefix ? repositoryRelative.slice(payloadPrefix.length) : repositoryRelative
            if (relative) {
              assertSafeRelativePath(relative)
              if (type === '0' || type === '\0') {
                if (entries.has(relative)) throw new Error('duplicate tar entry')
                totalBytes += body.length
                entries.set(relative, { kind: 'file', content: Buffer.from(body) })
              } else if (type === '2') {
                if (entries.has(relative)) throw new Error('duplicate tar entry')
                entries.set(relative, { kind: 'symlink', target: tarString(header.subarray(157, 257)) })
              } else if (type === '5') {
                if (!relative.includes('/') && RESERVED_NORMALIZATION_ROOT_NAMES.has(relative)) {
                  const marker = `${relative}/`
                  if (entries.has(marker)) throw new Error('duplicate tar entry')
                  entries.set(marker, { kind: 'directory' })
                }
              } else throw new Error('unsupported tar entry')
            }
          }
        }
      }
      if (entries.size > MAX_PAYLOAD_FILES || totalBytes > MAX_PAYLOAD_BYTES) throw new Error('payload exceeds limits')
      offset = bodyStart + Math.ceil(size / 512) * 512
    }
    if (manifestPath && entries.get(manifestPath)?.kind !== 'file') return undefined
    return entries
  } catch {
    return undefined
  }
}

function digestEntries (entries: Map<string, PayloadEntry>): string | undefined {
  if (entries.size === 0) return undefined
  const hash = createHash('sha256')
  for (const [relative, entry] of [...entries].sort(([left], [right]) => left.localeCompare(right))) {
    hash.update(entry.kind).update('\0').update(relative).update('\0')
    if (entry.kind === 'file') hash.update(String(entry.content.length)).update('\0').update(entry.content)
    else if (entry.kind === 'symlink') hash.update(entry.target)
    hash.update('\0')
  }
  return hash.digest('hex')
}

function normalizeArchivePath (value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '')
}

function assertSafeRelativePath (value: string): void {
  if (!value || path.posix.isAbsolute(value) || value.split('/').some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error('unsafe payload path')
  }
}

function parsePaxPath (body: Buffer): string | undefined {
  let offset = 0
  let result: string | undefined
  while (offset < body.length) {
    const space = body.indexOf(0x20, offset)
    if (space < 0) throw new Error('invalid pax record')
    const length = Number(body.subarray(offset, space).toString('ascii'))
    if (!Number.isSafeInteger(length) || length <= 0 || offset + length > body.length) throw new Error('invalid pax length')
    const record = body.subarray(space + 1, offset + length - 1).toString('utf8')
    const equals = record.indexOf('=')
    if (equals > 0 && record.slice(0, equals) === 'path') result = record.slice(equals + 1)
    offset += length
  }
  return result
}

function tarNumber (value: Buffer): number {
  if ((value[0] ?? 0) & 0x80) {
    let result = BigInt((value[0] ?? 0) & 0x7f)
    for (const byte of value.subarray(1)) result = (result << 8n) | BigInt(byte)
    const number = Number(result)
    if (!Number.isSafeInteger(number)) throw new Error('tar number overflow')
    return number
  }
  const parsed = Number.parseInt(tarString(value).trim() || '0', 8)
  if (!Number.isSafeInteger(parsed)) throw new Error('invalid tar number')
  return parsed
}

function tarString (value: Buffer): string {
  const end = value.indexOf(0)
  return value.subarray(0, end < 0 ? value.length : end).toString('utf8').replace(/\n$/, '')
}
