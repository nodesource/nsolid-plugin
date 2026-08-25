import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import type { ResolvedArtifactIdentity, UpdateSource } from './types.js'

const FULL_COMMIT = /^[0-9a-f]{40}$/i

export function nativeSourceHonorsArtifact (
  source: UpdateSource,
  artifact: ResolvedArtifactIdentity | undefined
): boolean {
  if (!artifact || (artifact.kind !== 'git' && artifact.kind !== 'local-snapshot')) return true
  if (source.kind !== 'claude-marketplace' && source.kind !== 'codex-marketplace') return false
  const versionSource = source.versionSource

  if (artifact.kind === 'git') {
    if (versionSource.kind !== 'git') return false
    const pinnedRevision = FULL_COMMIT.test(versionSource.revision ?? '') ? versionSource.revision : undefined
    const observedCommitMatches = versionSource.commit === undefined || versionSource.commit.toLowerCase() === artifact.commit.toLowerCase()
    return pinnedRevision?.toLowerCase() === artifact.commit.toLowerCase() && observedCommitMatches &&
      normalizeRepository(versionSource.repository) === normalizeRepository(artifact.repository)
  }

  return versionSource.kind === 'local-snapshot' &&
    versionSource.freshness === 'verified' &&
    path.resolve(versionSource.root) === path.resolve(artifact.root) &&
    versionSource.contentDigest === artifact.contentDigest
}

export function nativePayloadDigest (root: string, manifestPath?: string): string | undefined {
  try {
    if (manifestPath) {
      const base = path.resolve(root)
      const manifest = path.resolve(base, manifestPath)
      if (manifest.startsWith(`${base}${path.sep}`) && existsSync(manifest)) {
        return createHash('sha256').update(readFileSync(manifest)).digest('hex')
      }
    }
    const directBundle = path.join(root, 'bundle.json')
    if (existsSync(directBundle)) return createHash('sha256').update(readFileSync(directBundle)).digest('hex')
    const files: string[] = []
    collectDigestFiles(root, 0, files)
    if (files.length === 0) return undefined
    const hash = createHash('sha256')
    for (const file of files.sort()) hash.update(file).update(readFileSync(file))
    return hash.digest('hex')
  } catch { return undefined }
}

function collectDigestFiles (root: string, depth: number, output: string[]): void {
  if (depth > 4 || output.length > 256) return
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      const file = path.join(root, entry.name)
      if (entry.isDirectory()) collectDigestFiles(file, depth + 1, output)
      else if (entry.isFile() && ['bundle.json', 'plugin.json', 'package.json', 'manifest.json'].includes(entry.name)) output.push(file)
    }
  } catch {
    if (existsSync(root)) output.push(root)
  }
}

function normalizeRepository (repository: string): string {
  return repository.trim().replace(/\.git\/?$/i, '').replace(/\/$/, '').toLowerCase()
}
