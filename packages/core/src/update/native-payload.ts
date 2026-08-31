import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readlinkSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { gunzipSync } from 'node:zlib'

type PayloadEntry =
  | { kind: 'file'; content: Buffer }
  | { kind: 'symlink'; target: string }

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

/** Normalize a repo-relative POSIX directory (payload scope). Rejects traversal. */
export function normalizedPayloadPath (value: string | undefined): string {
  const normalized = (value ?? '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
  if (!normalized) return ''
  if (normalized.startsWith('/') || normalized.split('/').some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error('unsafe payload path')
  }
  return normalized
}

export function nativePayloadTreeDigest (root: string): string | undefined {
  try {
    const resolvedRoot = path.resolve(root)
    const entries = new Map<string, PayloadEntry>()
    let totalBytes = 0
    const walk = (directory: string, relativeRoot: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (!relativeRoot && entry.name === '.git') continue
        const relative = relativeRoot ? `${relativeRoot}/${entry.name}` : entry.name
        assertSafeRelativePath(relative)
        const absolute = path.join(directory, entry.name)
        const stat = lstatSync(absolute)
        if (stat.isDirectory() && !stat.isSymbolicLink()) {
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
    return digestEntries(entries)
  } catch {
    return undefined
  }
}

/**
 * Digest only the installable payload subtree of a `git archive` tarball.
 * Entries outside `scope.payloadPath` (for example sibling plugins in a
 * multi-plugin marketplace repository) are excluded instead of compared.
 * The manifest must exist inside the subtree when `scope.manifestPath` is set.
 */
export function gitArchivePayloadDigest (compressedArchive: Buffer, scope: ArchivePayloadScope = {}): string | undefined {
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
              if (entries.has(relative)) throw new Error('duplicate tar entry')
              if (type === '0' || type === '\0') {
                totalBytes += body.length
                entries.set(relative, { kind: 'file', content: Buffer.from(body) })
              } else if (type === '2') {
                entries.set(relative, { kind: 'symlink', target: tarString(header.subarray(157, 257)) })
              } else if (type !== '5') throw new Error('unsupported tar entry')
            }
          }
        }
      }
      if (entries.size > MAX_PAYLOAD_FILES || totalBytes > MAX_PAYLOAD_BYTES) throw new Error('payload exceeds limits')
      offset = bodyStart + Math.ceil(size / 512) * 512
    }
    if (manifestPath && entries.get(manifestPath)?.kind !== 'file') return undefined
    return digestEntries(entries)
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
    else hash.update(entry.target)
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
