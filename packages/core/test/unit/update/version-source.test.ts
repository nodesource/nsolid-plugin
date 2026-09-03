import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import { gitArchivePayloadDigest, nativePayloadTreeDigest } from '../../../src/update/native-payload.js'
import { isSafeManifestPath, readArchiveWithLimit, resolveMarketplaceVersion, resolveRegistryVersion, sanitizeRepository } from '../../../src/update/version-source.js'

describe('update version sources', () => {
  it('redacts repository credentials and rejects traversal paths', () => {
    assert.equal(sanitizeRepository('https://user:secret@example.com/org/repo.git'), 'https://example.com/org/repo.git')
    assert.equal(sanitizeRepository('NodeSource/nsolid-plugin'), 'https://github.com/NodeSource/nsolid-plugin.git')
    assert.equal(isSafeManifestPath('bundle.json'), true)
    assert.equal(isSafeManifestPath('../bundle.json'), false)
    assert.equal(isSafeManifestPath('/tmp/bundle.json'), false)
  })

  it('does not substitute a canonical source for stale local snapshots', async () => {
    const result = await resolveMarketplaceVersion({
      kind: 'local-snapshot',
      root: '/does-not-exist',
      manifestPath: 'bundle.json',
      freshness: 'stale',
    })
    assert.deepEqual(result, {})
  })

  it('resolves GitHub shorthand repositories using the carried revision', async () => {
    let requested = ''
    const result = await resolveMarketplaceVersion({
      kind: 'git',
      repository: 'NodeSource/nsolid-plugin',
      revision: 'feature/update-flow',
      manifestPath: 'bundle.json',
    }, {
      fetchImpl: async (url) => {
        requested = String(url)
        return new Response(JSON.stringify({ version: '1.0.2' }), { status: 200 })
      },
    })

    assert.deepEqual(result, { version: '1.0.2' })
    assert.equal(requested, 'https://raw.githubusercontent.com/NodeSource/nsolid-plugin/feature/update-flow/bundle.json')
  })

  it('resolves immutable artifact metadata from the latest packument version', async () => {
    const result = await resolveRegistryVersion('nsolid-plugin', {
      registry: 'http://127.0.0.1:4873',
      fetchImpl: async () => new Response(JSON.stringify({
        'dist-tags': { latest: '90.0.1' },
        versions: {
          '90.0.0': {
            name: 'nsolid-plugin',
            version: '90.0.0',
            dist: { tarball: 'http://127.0.0.1:4873/nsolid-plugin/-/nsolid-plugin-90.0.0.tgz', integrity: 'sha512-old' },
          },
          '90.0.1': {
            name: 'nsolid-plugin',
            version: '90.0.1',
            dist: { tarball: '/nsolid-plugin/-/nsolid-plugin-90.0.1.tgz', integrity: 'sha512-latest' },
          },
        },
      }), { status: 200 }),
    })

    assert.equal(result.version, '90.0.1')
    assert.deepEqual(result.artifact, {
      kind: 'npm',
      packageName: 'nsolid-plugin',
      version: '90.0.1',
      registry: 'http://127.0.0.1:4873',
      tarball: 'http://127.0.0.1:4873/nsolid-plugin/-/nsolid-plugin-90.0.1.tgz',
      integrity: 'sha512-latest',
    })
  })

  it('fails closed for invalid configured registries without fetching', async () => {
    const candidates = ['file:///private', 'ssh://registry.example/npm', 'not a url', '']

    for (const registry of candidates) {
      let calls = 0
      const result = await resolveRegistryVersion('nsolid-plugin', {
        registry,
        fetchImpl: async () => {
          calls++
          return new Response('{}', { status: 200 })
        },
      })

      assert.equal(result.error?.code, 'INVALID_REGISTRY_URL')
      assert.equal(calls, 0, `fetch was called for registry ${JSON.stringify(registry)}`)
    }
  })

  it('uses npmjs only when no registry is configured', async () => {
    const previousNpm = process.env.npm_config_registry
    const previousUpper = process.env.NPM_CONFIG_REGISTRY
    delete process.env.npm_config_registry
    delete process.env.NPM_CONFIG_REGISTRY
    try {
      let requested = ''
      const result = await resolveRegistryVersion('nsolid-plugin', {
        fetchImpl: async (url) => {
          requested = String(url)
          return new Response(JSON.stringify({ 'dist-tags': { latest: '1.0.0' } }), { status: 200 })
        },
      })

      assert.equal(result.version, '1.0.0')
      assert.equal(requested, 'https://registry.npmjs.org/nsolid-plugin')
    } finally {
      if (previousNpm === undefined) delete process.env.npm_config_registry
      else process.env.npm_config_registry = previousNpm
      if (previousUpper === undefined) delete process.env.NPM_CONFIG_REGISTRY
      else process.env.NPM_CONFIG_REGISTRY = previousUpper
    }
  })

  it('rejects invalid npm registry environment values without fetching', async () => {
    const previousNpm = process.env.npm_config_registry
    const previousUpper = process.env.NPM_CONFIG_REGISTRY
    try {
      for (const [name, value] of [['npm_config_registry', 'file:///private'], ['NPM_CONFIG_REGISTRY', 'ssh://registry.example/npm']] as const) {
        delete process.env.npm_config_registry
        delete process.env.NPM_CONFIG_REGISTRY
        process.env[name] = value
        let calls = 0
        const result = await resolveRegistryVersion('nsolid-plugin', {
          fetchImpl: async () => {
            calls++
            return new Response('{}', { status: 200 })
          },
        })

        assert.equal(result.error?.code, 'INVALID_REGISTRY_URL')
        assert.equal(calls, 0)
      }
    } finally {
      if (previousNpm === undefined) delete process.env.npm_config_registry
      else process.env.npm_config_registry = previousNpm
      if (previousUpper === undefined) delete process.env.NPM_CONFIG_REGISTRY
      else process.env.NPM_CONFIG_REGISTRY = previousUpper
    }
  })

  it('preserves a valid private registry base path', async () => {
    let requested = ''
    const result = await resolveRegistryVersion('nsolid-plugin', {
      registry: 'https://user:secret@artifactory.example/api/npm/private/?token=hidden#fragment',
      fetchImpl: async (url) => {
        requested = String(url)
        return new Response(JSON.stringify({
          'dist-tags': { latest: '1.0.0' },
          versions: {
            '1.0.0': {
              version: '1.0.0',
              dist: {
                tarball: '/nsolid-plugin/-/nsolid-plugin-1.0.0.tgz',
                integrity: 'sha512-dGVzdA==',
              },
            },
          },
        }), { status: 200 })
      },
    })

    assert.equal(requested, 'https://artifactory.example/api/npm/private/nsolid-plugin')
    assert.equal(result.artifact?.kind === 'npm' ? result.artifact.registry : undefined, 'https://artifactory.example/api/npm/private')
    assert.doesNotMatch(JSON.stringify(result), /secret|hidden|fragment/)
  })

  it('rejects an invalid registry declared by the selected artifact', async () => {
    const result = await resolveRegistryVersion('nsolid-plugin', {
      registry: 'https://registry.example/npm',
      fetchImpl: async () => new Response(JSON.stringify({
        'dist-tags': { latest: '1.0.0' },
        versions: {
          '1.0.0': {
            version: '1.0.0',
            registry: 'file:///private',
            dist: { tarball: '/nsolid-plugin.tgz', integrity: 'sha512-dGVzdA==' },
          },
        },
      }), { status: 200 }),
    })

    assert.equal(result.error?.code, 'INVALID_REGISTRY_ARTIFACT')
    assert.doesNotMatch(result.error?.message ?? '', /private|registry\.npmjs\.org/)
  })

  it('does not expose malformed response bodies in lookup errors', async () => {
    const secretBody = 'PRIVATE_RESPONSE_BODY_DO_NOT_PRINT'
    const registry = await resolveRegistryVersion('nsolid-plugin', {
      fetchImpl: async () => new Response(secretBody, { status: 200 }),
    })
    const marketplace = await resolveMarketplaceVersion({
      kind: 'git',
      repository: 'NodeSource/nsolid-plugin',
      manifestPath: 'bundle.json',
    }, {
      fetchImpl: async () => new Response(secretBody, { status: 200 }),
    })

    assert.ok(!(registry.error?.message ?? '').includes(secretBody))
    assert.ok(!(marketplace.error?.message ?? '').includes(secretBody))
  })
})

describe('archive download limit', () => {
  const encode = (text: string): Uint8Array => new TextEncoder().encode(text)

  function syntheticBody (chunks: Uint8Array[]): { body: unknown, state: () => { pulls: number, cancelled: boolean } } {
    let pulls = 0
    let cancelled = false
    const body = {
      getReader: () => ({
        read: async (): Promise<{ done: boolean, value: Uint8Array | undefined }> => {
          pulls++
          if (pulls <= chunks.length) return { done: false, value: chunks[pulls - 1] }
          return { done: true, value: undefined }
        },
        cancel: async (): Promise<void> => { cancelled = true },
      }),
    }
    return { body, state: () => ({ pulls, cancelled }) }
  }

  it('rejects an oversized declared length before reading the body', async () => {
    const { body, state } = syntheticBody([encode('never')])
    await assert.rejects(
      readArchiveWithLimit({ headers: new Headers({ 'content-length': '65' }), body } as unknown as Parameters<typeof readArchiveWithLimit>[0], 64),
      /exceeds the maximum allowed size/
    )
    assert.equal(state().pulls, 0, 'the body must not be consumed when the header already exceeds the limit')
  })

  it('cancels the stream as soon as the accumulated bytes cross the limit', async () => {
    const { body, state } = syntheticBody([encode('a'.repeat(6)), encode('b'.repeat(6))])
    await assert.rejects(
      readArchiveWithLimit({ headers: new Headers(), body } as unknown as Parameters<typeof readArchiveWithLimit>[0], 10),
      /exceeds the maximum allowed size/
    )
    assert.equal(state().cancelled, true, 'the reader must be cancelled when the limit is exceeded')
  })

  it('accepts a stream that exactly reaches the limit', async () => {
    const { body } = syntheticBody([encode('a'.repeat(5)), encode('b'.repeat(5))])
    const bytes = await readArchiveWithLimit({ headers: new Headers(), body } as unknown as Parameters<typeof readArchiveWithLimit>[0], 10)
    assert.equal(bytes.length, 10)
    assert.equal(bytes.toString('utf8'), 'a'.repeat(5) + 'b'.repeat(5))
  })

  it('accepts a small valid archive with an unparseable content-length header', async () => {
    const { body } = syntheticBody([encode('tiny')])
    const bytes = await readArchiveWithLimit({ headers: new Headers({ 'content-length': 'not-a-number' }), body } as unknown as Parameters<typeof readArchiveWithLimit>[0], 64)
    assert.equal(bytes.toString('utf8'), 'tiny')
  })
})

describe('planned payload identities', () => {
  const COMMIT = 'bc9c87e6ce6ca73756dc20fdd41a3219bcd5b60c'

  function writeOctal (target: Buffer, offset: number, length: number, value: number): void {
    target.write(value.toString(8).padStart(length - 1, '0') + '\0', offset, length, 'ascii')
  }

  function makeTar (files: Map<string, Buffer>): Buffer {
    const output: Buffer[] = []
    for (const [relative, content] of files) {
      const header = Buffer.alloc(512)
      header.write(`repository-commit/${relative}`, 0, 100, 'utf8')
      writeOctal(header, 100, 8, 0o644)
      writeOctal(header, 108, 8, 0)
      writeOctal(header, 116, 8, 0)
      writeOctal(header, 124, 12, content.length)
      writeOctal(header, 136, 12, 0)
      header.fill(0x20, 148, 156)
      header[156] = '0'.charCodeAt(0)
      header.write('ustar\0', 257, 6, 'ascii')
      header.write('00', 263, 2, 'ascii')
      const checksum = header.reduce((sum, byte) => sum + byte, 0)
      header.write(checksum.toString(8).padStart(6, '0'), 148, 6, 'ascii')
      header[154] = 0
      header[155] = 0x20
      output.push(header, content, Buffer.alloc((512 - (content.length % 512)) % 512))
    }
    output.push(Buffer.alloc(1024))
    return Buffer.concat(output)
  }

  function cleanPayloadFiles (): Map<string, Buffer> {
    return new Map([
      ['bundle.json', Buffer.from('{"name":"nsolid-plugin","version":"1.0.2","skills":[]}')],
      ['skills/example/SKILL.md', Buffer.from('# example\n')],
    ])
  }

  function makeSnapshot (withReservedMetadata: boolean): string {
    const root = mkdtempSync(path.join(os.tmpdir(), 'nsolid-version-source-snapshot-'))
    for (const [relative, content] of cleanPayloadFiles()) {
      const target = path.join(root, relative)
      mkdirSync(path.dirname(target), { recursive: true })
      writeFileSync(target, content)
    }
    if (withReservedMetadata) writeFileSync(path.join(root, '.codex-marketplace-install.json'), '{"source":"marketplace"}\n')
    return root
  }

  function gitFetch (archive: Buffer, requested: string[]): typeof fetch {
    return (async (url: string | URL) => {
      const target = String(url)
      requested.push(target)
      if (target.includes('codeload.github.com')) return new Response(new Uint8Array(archive), { status: 200 })
      return new Response(JSON.stringify({ version: '1.0.2' }), { status: 200 })
    }) as typeof fetch
  }

  it('carries strict and comparison identities from one verified local snapshot capture', async () => {
    const root = makeSnapshot(false)
    try {
      const result = await resolveMarketplaceVersion({ kind: 'local-snapshot', root, manifestPath: 'bundle.json', freshness: 'verified' })
      const strict = nativePayloadTreeDigest(root)!
      assert.equal(result.version, '1.0.2')
      const artifact = result.artifact
      if (!artifact || artifact.kind !== 'local-snapshot') assert.fail('expected a local-snapshot artifact')
      assert.equal(artifact.contentDigest, strict)
      // A clean payload has no normalizable entries: both identities describe
      // the same captured bytes, so the digests coincide.
      assert.equal(artifact.comparisonDigest, strict)
      assert.equal(artifact.comparisonProfile, 'codex-installed-v1')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('fails closed when a verified local snapshot drifts after discovery', async () => {
    const root = makeSnapshot(false)
    try {
      const result = await resolveMarketplaceVersion({ kind: 'local-snapshot', root, manifestPath: 'bundle.json', freshness: 'verified', contentDigest: 'f'.repeat(64) })
      assert.equal(result.error?.code, 'SOURCE_CONTENT_MISMATCH')
      assert.equal(result.artifact, undefined)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('omits the comparison identity when a local snapshot ships reserved harness metadata', async () => {
    const root = makeSnapshot(true)
    try {
      const result = await resolveMarketplaceVersion({ kind: 'local-snapshot', root, manifestPath: 'bundle.json', freshness: 'verified' })
      assert.equal(result.error, undefined)
      const artifact = result.artifact
      if (!artifact || artifact.kind !== 'local-snapshot') assert.fail('expected a local-snapshot artifact')
      assert.equal(artifact.contentDigest, nativePayloadTreeDigest(root)!)
      assert.equal(artifact.comparisonDigest, undefined)
      assert.equal(artifact.comparisonProfile, undefined)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('carries strict and comparison identities from one immutable Git archive parse', async () => {
    const archive = gzipSync(makeTar(cleanPayloadFiles()))
    const requested: string[] = []
    const result = await resolveMarketplaceVersion({
      kind: 'git',
      repository: 'NodeSource/nsolid-plugin',
      commit: COMMIT,
      manifestPath: 'bundle.json',
    }, { requireImmutable: true, fetchImpl: gitFetch(archive, requested) })

    assert.equal(result.error, undefined)
    const artifact = result.artifact
    if (!artifact || artifact.kind !== 'git') assert.fail('expected a git artifact')
    assert.equal(artifact.commit, COMMIT)
    assert.equal(artifact.contentDigest, gitArchivePayloadDigest(archive)!)
    assert.equal(artifact.comparisonDigest, gitArchivePayloadDigest(archive, {}, { profile: 'codex-installed-v1' })!)
    assert.equal(artifact.comparisonProfile, 'codex-installed-v1')
    assert.ok(requested.some((url) => url === `https://codeload.github.com/NodeSource/nsolid-plugin/tar.gz/${COMMIT}`))
  })

  it('omits the comparison identity when the immutable Git payload ships reserved harness metadata', async () => {
    const files = cleanPayloadFiles()
    files.set('.codex-marketplace-install.json', Buffer.from('{"source":"marketplace"}\n'))
    const archive = gzipSync(makeTar(files))
    const result = await resolveMarketplaceVersion({
      kind: 'git',
      repository: 'NodeSource/nsolid-plugin',
      commit: COMMIT,
      manifestPath: 'bundle.json',
    }, { requireImmutable: true, fetchImpl: gitFetch(archive, []) })

    assert.equal(result.error, undefined)
    const artifact = result.artifact
    if (!artifact || artifact.kind !== 'git') assert.fail('expected a git artifact')
    assert.equal(artifact.contentDigest, gitArchivePayloadDigest(archive)!)
    assert.equal(artifact.comparisonDigest, undefined)
    assert.equal(artifact.comparisonProfile, undefined)
  })
})
