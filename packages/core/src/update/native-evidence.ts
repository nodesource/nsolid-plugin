import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { ResolvedArtifactIdentity, UpdateError, UpdateInstallationMetadata, UpdateSource } from './types.js'
import { nativePayloadTreeDigest } from './native-payload.js'
import type { PayloadDigestOptions } from './native-payload.js'

const FULL_COMMIT = /^[0-9a-f]{40}$/i

export function nativeSourceHonorsArtifact (
  source: UpdateSource,
  artifact: ResolvedArtifactIdentity | undefined
): boolean {
  if (source.kind !== 'claude-marketplace' && source.kind !== 'codex-marketplace') return false
  // A marketplace mutation without a proven immutable artifact can never be
  // authorized: refuse instead of assuming the plan is still pinned.
  if (!artifact || (artifact.kind !== 'git' && artifact.kind !== 'local-snapshot')) return false
  const versionSource = source.versionSource

  if (artifact.kind === 'git') {
    if (versionSource.kind !== 'git') return false
    const pinnedRevision = FULL_COMMIT.test(versionSource.revision ?? '') ? versionSource.revision : undefined
    const observedCommitMatches = versionSource.commit === undefined || versionSource.commit.toLowerCase() === artifact.commit.toLowerCase()
    const payloadMatches = artifact.payloadPath === undefined ||
      (versionSource.manifestPath !== undefined && payloadDirectory(versionSource.manifestPath) === artifact.payloadPath)
    return pinnedRevision?.toLowerCase() === artifact.commit.toLowerCase() && observedCommitMatches &&
      normalizeRepository(versionSource.repository) === normalizeRepository(artifact.repository) && payloadMatches
  }

  return versionSource.kind === 'local-snapshot' &&
    versionSource.freshness === 'verified' &&
    path.resolve(versionSource.root) === path.resolve(artifact.root) &&
    versionSource.contentDigest === artifact.contentDigest
}

/**
 * Canonical digest of an installed native payload directory. Resolution and
 * execution must compare this exact function's output: the marketplace
 * resolution digests the payload subtree of the immutable commit and the
 * installed plugin directory is digested the same way here.
 *
 * Without options this is strict source evidence. A named normalization
 * profile may be requested only for installed-payload equivalence comparison
 * against a plan that carries the same named profile; it never replaces the
 * strict digest for drift, authorization, backup, or rollback checks.
 */
export function nativePayloadDigest (root: string, options: PayloadDigestOptions = {}): string | undefined {
  return nativePayloadTreeDigest(root, options)
}

export function nativeEvidenceMatches (metadata: UpdateInstallationMetadata | undefined): boolean {
  const evidence = metadata?.nativeEvidence
  if (!evidence || evidence.length === 0) return false
  return evidence.every((entry) => {
    if (!entry || typeof entry.path !== 'string' || typeof entry.digest !== 'string') return false
    try {
      return entry.digest.length > 0 && createHash('sha256').update(readFileSync(entry.path)).digest('hex') === entry.digest
    } catch {
      return false
    }
  })
}

/**
 * Shared execution guard for native-plugin strategies (Claude and Codex).
 * Returns the structured planning error when the planned bytes can no longer
 * be proven, or undefined when the guarded mutation may proceed.
 */
export function nativeExecutionGuard (item: {
  metadata?: UpdateInstallationMetadata
  source: UpdateSource
  artifact?: ResolvedArtifactIdentity
}, label: string): UpdateError | undefined {
  if (!nativeEvidenceMatches(item.metadata)) {
    return { code: 'NATIVE_SOURCE_DRIFT', message: `${label} marketplace records changed after planning` }
  }
  if (!nativeSourceHonorsArtifact(item.source, item.artifact)) {
    return { code: 'NATIVE_SOURCE_NOT_PINNED', message: `${label} marketplace source no longer proves the planned immutable identity` }
  }
  return undefined
}

function payloadDirectory (manifestPath: string): string {
  const normalized = manifestPath.replace(/\\/g, '/')
  const index = normalized.lastIndexOf('/')
  return index > 0 ? normalized.slice(0, index) : ''
}

function normalizeRepository (repository: string): string {
  return repository.trim().replace(/\.git\/?$/i, '').replace(/\/$/, '').toLowerCase()
}
