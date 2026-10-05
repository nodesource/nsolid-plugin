import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

function repoRoot (): string {
  let dir = dirname(fileURLToPath(import.meta.url))
  while (!existsSync(join(dir, 'skill-assets'))) {
    const parent = dirname(dir)
    if (parent === dir) throw new Error('repository root not found')
    dir = parent
  }
  return dir
}

const require = createRequire(import.meta.url)
const api = require(join(repoRoot(), 'skill-assets', 'nsolid-api.cjs')) as {
  createClient: (config: { apiUrl: string, token: string, tenant: string }) => {
    get: (pathname: string) => Promise<unknown>
  }
}

const realFetch = globalThis.fetch

describe('nsolid-api.cjs', () => {
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  it('labels every request as the plugin, for N|Solid usage reports', async () => {
    const seen: Record<string, string>[] = []
    globalThis.fetch = (async (_url: string, init: { headers: Record<string, string> }) => {
      seen.push(init.headers)
      return new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch
    const client = api.createClient({ apiUrl: 'https://nsolid.example', token: 't0k', tenant: 'acme' })
    assert.deepEqual(await client.get('/v1/me'), { ok: true })
    assert.equal(seen[0]?.['x-nsolid-client'], 'api')
    assert.equal(seen[0]?.['x-nsolid-client-name'], 'nsolid-plugin')
    assert.equal(seen[0]?.authorization, 'Bearer t0k')
  })
})
