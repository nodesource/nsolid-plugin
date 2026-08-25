import { lstatSync, readFileSync, readlinkSync, readdirSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { gunzipSync } from 'node:zlib'

type TarEntry =
  | { kind: 'file'; content: Buffer }
  | { kind: 'symlink'; target: string }

export function installedPackageMatchesTarball (packageRoot: string, tarballPath: string): boolean {
  try {
    const expected = readNpmTarball(tarballPath)
    const resolvedRoot = realpathSync(packageRoot)
    if (!expected.has('package.json')) return false
    for (const [relative, entry] of expected) {
      const target = path.resolve(resolvedRoot, relative)
      if (!isContained(target, resolvedRoot) || !hasDirectoryParents(resolvedRoot, relative)) return false
      const stat = lstatSync(target)
      if (entry.kind === 'file') {
        if (!stat.isFile() || !readFileSync(target).equals(entry.content)) return false
      } else if (!stat.isSymbolicLink() || readlinkSync(target) !== entry.target) return false
    }
    return installedPayloadFiles(resolvedRoot).every((relative) => expected.has(relative))
  } catch {
    return false
  }
}

function readNpmTarball (tarballPath: string): Map<string, TarEntry> {
  const archive = gunzipSync(readFileSync(tarballPath))
  const entries = new Map<string, TarEntry>()
  let offset = 0
  let longPath: string | undefined
  let paxPath: string | undefined
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
      const relative = packageRelativePath(paxPath ?? longPath ?? headerPath)
      paxPath = undefined
      longPath = undefined
      if (relative) {
        if (entries.has(relative)) throw new Error('duplicate tar entry')
        if (type === '0') entries.set(relative, { kind: 'file', content: Buffer.from(body) })
        else if (type === '2') entries.set(relative, { kind: 'symlink', target: tarString(header.subarray(157, 257)) })
        else if (type !== '5') throw new Error('unsupported tar entry')
      }
    }
    offset = bodyStart + Math.ceil(size / 512) * 512
  }
  return entries
}

function installedPayloadFiles (root: string): string[] {
  const output: string[] = []
  const walk = (directory: string, relativeRoot: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!relativeRoot && (entry.name === 'node_modules' || entry.name === '.package-lock.json')) continue
      const relative = relativeRoot ? `${relativeRoot}/${entry.name}` : entry.name
      const absolute = path.join(directory, entry.name)
      if (entry.isDirectory()) walk(absolute, relative)
      else if (entry.isFile() || entry.isSymbolicLink()) output.push(relative)
      else throw new Error('unsupported installed entry')
    }
  }
  walk(path.resolve(root), '')
  return output
}

function packageRelativePath (entryPath: string): string | undefined {
  const normalized = entryPath.replace(/\\/g, '/').replace(/^\.\//, '')
  if (!normalized.startsWith('package/')) return undefined
  const relative = normalized.slice('package/'.length).replace(/\/$/, '')
  if (!relative || path.posix.isAbsolute(relative) || relative.split('/').some((segment) => !segment || segment === '.' || segment === '..')) {
    if (!relative) return undefined
    throw new Error('unsafe tar path')
  }
  return relative
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

function isContained (candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate))
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

function hasDirectoryParents (root: string, relative: string): boolean {
  const segments = relative.split('/').slice(0, -1)
  let current = root
  for (const segment of segments) {
    current = path.join(current, segment)
    const stat = lstatSync(current)
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false
  }
  return true
}
