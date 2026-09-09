import { lstatSync, readFileSync, readlinkSync, readdirSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { gunzipSync } from 'node:zlib'
import { readTarEntries } from './tar-format.js'

/** Caps both the compressed tarball and its decompressed output; copied from tarball.ts. */
const MAX_TARBALL_BYTES = 64 * 1024 * 1024

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
  const compressed = readFileSync(tarballPath)
  if (compressed.length > MAX_TARBALL_BYTES) throw new Error('tarball exceeds size bound')
  const archive = gunzipSync(compressed, { maxOutputLength: MAX_TARBALL_BYTES })
  const entries = new Map<string, TarEntry>()
  for (const { path: entryPath, type, body, linkTarget } of readTarEntries(archive)) {
    const relative = packageRelativePath(entryPath)
    if (relative) {
      if (entries.has(relative)) throw new Error('duplicate tar entry')
      if (type === '0') entries.set(relative, { kind: 'file', content: Buffer.from(body) })
      else if (type === '2') entries.set(relative, { kind: 'symlink', target: linkTarget })
      else if (type !== '5') throw new Error('unsupported tar entry')
    }
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
