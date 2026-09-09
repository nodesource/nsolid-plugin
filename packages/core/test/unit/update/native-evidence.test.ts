import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { nativeExecutionGuard, nativeSourceHonorsArtifact } from '../../../src/update/native-evidence.js'
import type { ResolvedArtifactIdentity, UpdateInstallationMetadata, UpdateSource } from '../../../src/update/types.js'

function marketplaceSource (): UpdateSource {
  return {
    kind: 'claude-marketplace',
    pluginId: 'nsolid-plugin@nodesource',
    marketplace: 'nodesource',
    scope: 'user',
    versionSource: {
      kind: 'git',
      repository: 'https://github.com/NodeSource/nsolid-plugin.git',
      revision: 'bc9c87e6ce6ca73756dc20fdd41a3219bcd5b60c',
      commit: 'bc9c87e6ce6ca73756dc20fdd41a3219bcd5b60c',
      manifestPath: 'bundle.json',
    },
  }
}

function gitArtifact (): ResolvedArtifactIdentity {
  return {
    kind: 'git',
    repository: 'https://github.com/NodeSource/nsolid-plugin.git',
    commit: 'bc9c87e6ce6ca73756dc20fdd41a3219bcd5b60c',
    contentDigest: 'planned-content',
  }
}

function localSnapshotArtifact (root: string, digest: string): ResolvedArtifactIdentity {
  return { kind: 'local-snapshot', root, contentDigest: digest }
}

function metadataWithEvidence (): UpdateInstallationMetadata {
  const evidencePath = path.join(mkdtempSync(path.join(os.tmpdir(), 'nsolid-native-evidence-')), 'evidence.json')
  const evidence = '{"target":"claude"}'
  writeFileSync(evidencePath, evidence)
  return {
    nativeEvidence: [{ path: evidencePath, digest: createHash('sha256').update(evidence).digest('hex') }],
  } as UpdateInstallationMetadata
}

describe('native marketplace sources must prove the planned immutable identity', () => {
  it('honors a matching git artifact', () => {
    assert.equal(nativeSourceHonorsArtifact(marketplaceSource(), gitArtifact()), true)
  })

  it('honors a matching local-snapshot artifact', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'nsolid-native-snapshot-'))
    const source = {
      ...marketplaceSource(),
      versionSource: { kind: 'local-snapshot', freshness: 'verified', root, contentDigest: 'snapshot-digest' },
    } as UpdateSource
    assert.equal(nativeSourceHonorsArtifact(source, localSnapshotArtifact(root, 'snapshot-digest')), true)
  })

  it('refuses a marketplace source with no artifact at all', () => {
    assert.equal(nativeSourceHonorsArtifact(marketplaceSource(), undefined), false)
  })

  it('refuses an artifact of an unsupported class', () => {
    const unsupported = { kind: 'tarball', url: 'https://example.com/x.tgz' } as unknown as ResolvedArtifactIdentity
    assert.equal(nativeSourceHonorsArtifact(marketplaceSource(), unsupported), false)
  })

  it('refuses non-marketplace sources', () => {
    const source = { kind: 'npm', packageName: 'nsolid-plugin' } as unknown as UpdateSource
    assert.equal(nativeSourceHonorsArtifact(source, gitArtifact()), false)
  })

  it('nativeExecutionGuard rejects the mutation when the artifact is missing', () => {
    const error = nativeExecutionGuard({ metadata: metadataWithEvidence(), source: marketplaceSource(), artifact: undefined }, 'Claude')
    assert.equal(error?.code, 'NATIVE_SOURCE_NOT_PINNED')
  })

  it('nativeExecutionGuard rejects the mutation for an unsupported artifact class', () => {
    const unsupported = { kind: 'tarball', url: 'https://example.com/x.tgz' } as unknown as ResolvedArtifactIdentity
    const error = nativeExecutionGuard({ metadata: metadataWithEvidence(), source: marketplaceSource(), artifact: unsupported }, 'Claude')
    assert.equal(error?.code, 'NATIVE_SOURCE_NOT_PINNED')
  })

  it('nativeExecutionGuard allows a properly pinned git source', () => {
    const error = nativeExecutionGuard({ metadata: metadataWithEvidence(), source: marketplaceSource(), artifact: gitArtifact() }, 'Claude')
    assert.equal(error, undefined)
  })

  it('nativeExecutionGuard allows a verified local-snapshot source', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'nsolid-native-snapshot-guard-'))
    const source = {
      ...marketplaceSource(),
      versionSource: { kind: 'local-snapshot', freshness: 'verified', root, contentDigest: 'snapshot-digest' },
    } as UpdateSource
    const error = nativeExecutionGuard({ metadata: metadataWithEvidence(), source, artifact: localSnapshotArtifact(root, 'snapshot-digest') }, 'Claude')
    assert.equal(error, undefined)
  })
})
