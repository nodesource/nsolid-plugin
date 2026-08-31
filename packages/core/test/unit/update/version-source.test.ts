import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
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
