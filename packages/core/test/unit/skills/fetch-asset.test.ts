import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { promises as dns } from 'node:dns'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import https from 'node:https'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { gzipSync } from 'node:zlib'
import type { TestContext } from 'node:test'
import type { ClientRequest, IncomingMessage, RequestOptions } from 'node:http'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fetchAssetPath = join(__dirname, '../../../../../skill-assets/fetch-asset.cjs')

let originalAllowInsecure: string | undefined

beforeEach(() => {
  originalAllowInsecure = process.env.NSOLID_ALLOW_INSECURE_CONSOLE
  delete process.env.NSOLID_ALLOW_INSECURE_CONSOLE
})

afterEach(() => {
  if (originalAllowInsecure === undefined) {
    delete process.env.NSOLID_ALLOW_INSECURE_CONSOLE
  } else {
    process.env.NSOLID_ALLOW_INSECURE_CONSOLE = originalAllowInsecure
  }
})

async function loadFetchAsset () {
  // On Windows, dynamic import() requires a file:// URL, not a bare path —
  // a D:\... path is parsed as protocol 'd:' and throws ERR_UNSUPPORTED_ESM_URL_SCHEME.
  const mod = await import(pathToFileURL(fetchAssetPath).href)
  return mod as {
    isPrivateOrLocalIp: (ip: string) => boolean
    resolveHostnameIps: (hostname: string) => Promise<string[]>
    validateConsoleUrl: (consoleUrl: string) => Promise<string[] | null>
    downloadAsset: (consoleUrl: string, token: string, assetId: string, destPath: string, validatedIps?: string[] | null) => Promise<number>
  }
}

function mockDnsLookup (t: TestContext, addresses: string[]) {
  t.mock.method(dns, 'lookup', async () => {
    return addresses.map((address) => ({
      address,
      family: address.includes(':') ? 6 : 4,
    }))
  })
}

describe('isPrivateOrLocalIp', () => {
  it('detects IPv4 loopback addresses', async () => {
    const { isPrivateOrLocalIp } = await loadFetchAsset()
    assert.equal(isPrivateOrLocalIp('127.0.0.1'), true)
    assert.equal(isPrivateOrLocalIp('127.1.2.3'), true)
    assert.equal(isPrivateOrLocalIp('127.255.255.255'), true)
  })

  it('detects IPv4 private addresses', async () => {
    const { isPrivateOrLocalIp } = await loadFetchAsset()
    assert.equal(isPrivateOrLocalIp('10.0.0.5'), true)
    assert.equal(isPrivateOrLocalIp('10.255.255.255'), true)
    assert.equal(isPrivateOrLocalIp('172.16.0.1'), true)
    assert.equal(isPrivateOrLocalIp('172.31.255.255'), true)
    assert.equal(isPrivateOrLocalIp('192.168.0.1'), true)
    assert.equal(isPrivateOrLocalIp('192.168.255.255'), true)
  })

  it('detects IPv4 link-local addresses', async () => {
    const { isPrivateOrLocalIp } = await loadFetchAsset()
    assert.equal(isPrivateOrLocalIp('169.254.0.1'), true)
    assert.equal(isPrivateOrLocalIp('169.254.255.255'), true)
  })

  it('rejects public IPv4 addresses', async () => {
    const { isPrivateOrLocalIp } = await loadFetchAsset()
    assert.equal(isPrivateOrLocalIp('8.8.8.8'), false)
    assert.equal(isPrivateOrLocalIp('1.1.1.1'), false)
    assert.equal(isPrivateOrLocalIp('172.15.0.1'), false)
    assert.equal(isPrivateOrLocalIp('172.32.0.1'), false)
    assert.equal(isPrivateOrLocalIp('192.167.0.1'), false)
    assert.equal(isPrivateOrLocalIp('192.169.0.1'), false)
  })

  it('detects IPv6 loopback addresses', async () => {
    const { isPrivateOrLocalIp } = await loadFetchAsset()
    assert.equal(isPrivateOrLocalIp('::1'), true)
    assert.equal(isPrivateOrLocalIp('0:0:0:0:0:0:0:1'), true)
  })

  it('detects IPv6 link-local addresses', async () => {
    const { isPrivateOrLocalIp } = await loadFetchAsset()
    assert.equal(isPrivateOrLocalIp('fe80::1'), true)
    assert.equal(isPrivateOrLocalIp('febf::1'), true)
  })

  it('detects IPv6 unique local addresses', async () => {
    const { isPrivateOrLocalIp } = await loadFetchAsset()
    assert.equal(isPrivateOrLocalIp('fc00::1'), true)
    assert.equal(isPrivateOrLocalIp('fd00::1'), true)
    assert.equal(isPrivateOrLocalIp('fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff'), true)
  })

  it('rejects public IPv6 addresses', async () => {
    const { isPrivateOrLocalIp } = await loadFetchAsset()
    assert.equal(isPrivateOrLocalIp('2001:db8::1'), false)
    assert.equal(isPrivateOrLocalIp('2606:4700:4700::1111'), false)
  })

  it('detects IPv4-mapped and IPv4-compatible loopback addresses', async () => {
    const { isPrivateOrLocalIp } = await loadFetchAsset()
    assert.equal(isPrivateOrLocalIp('::ffff:127.0.0.1'), true)
    assert.equal(isPrivateOrLocalIp('::ffff:10.0.0.5'), true)
    assert.equal(isPrivateOrLocalIp('::ffff:192.168.1.1'), true)
    assert.equal(isPrivateOrLocalIp('::127.0.0.1'), true)
    assert.equal(isPrivateOrLocalIp('::8.8.8.8'), false)
  })
})

describe('resolveHostnameIps', () => {
  it('returns IPv4 literals unchanged', async () => {
    const { resolveHostnameIps } = await loadFetchAsset()
    assert.deepEqual(await resolveHostnameIps('8.8.8.8'), ['8.8.8.8'])
  })

  it('returns IPv6 literals unchanged', async () => {
    const { resolveHostnameIps } = await loadFetchAsset()
    assert.deepEqual(await resolveHostnameIps('[::1]'), ['::1'])
    assert.deepEqual(await resolveHostnameIps('::1'), ['::1'])
    assert.deepEqual(await resolveHostnameIps('[2001:db8::1]'), ['2001:db8::1'])
  })

  it('resolves localhost to loopback addresses', async () => {
    const { resolveHostnameIps } = await loadFetchAsset()
    const ips = await resolveHostnameIps('localhost')
    assert.ok(ips.length > 0)
    for (const ip of ips) {
      assert.ok(ip === '127.0.0.1' || ip === '::1', `unexpected localhost IP: ${ip}`)
    }
  })
})

describe('validateConsoleUrl', () => {
  it('rejects non-HTTPS URLs when insecure mode is disabled', async () => {
    const { validateConsoleUrl } = await loadFetchAsset()
    await assert.rejects(
      () => validateConsoleUrl('http://example.com'),
      /consoleUrl must use HTTPS/
    )
  })

  it('allows non-HTTPS URLs when insecure mode is enabled', async () => {
    process.env.NSOLID_ALLOW_INSECURE_CONSOLE = '1'
    const { validateConsoleUrl } = await loadFetchAsset()
    await assert.doesNotReject(() => validateConsoleUrl('http://example.com'))
  })

  it('rejects literal localhost hostnames', async () => {
    const { validateConsoleUrl } = await loadFetchAsset()
    await assert.rejects(
      () => validateConsoleUrl('https://localhost'),
      /consoleUrl cannot be localhost/
    )
    await assert.rejects(
      () => validateConsoleUrl('https://localhost.'),
      /consoleUrl cannot be localhost/
    )
  })

  it('rejects literal loopback IPs', async () => {
    const { validateConsoleUrl } = await loadFetchAsset()
    await assert.rejects(
      () => validateConsoleUrl('https://127.0.0.1'),
      /consoleUrl cannot be localhost/
    )
    await assert.rejects(
      () => validateConsoleUrl('https://127.0.0.2'),
      /private or local address/
    )
    await assert.rejects(
      () => validateConsoleUrl('https://[::1]'),
      /consoleUrl cannot be localhost/
    )
  })

  it('rejects literal private IPv4 addresses', async () => {
    const { validateConsoleUrl } = await loadFetchAsset()
    await assert.rejects(
      () => validateConsoleUrl('https://10.0.0.5'),
      /private or local address/
    )
    await assert.rejects(
      () => validateConsoleUrl('https://192.168.1.1'),
      /private or local address/
    )
    await assert.rejects(
      () => validateConsoleUrl('https://172.16.0.1'),
      /private or local address/
    )
  })

  it('rejects literal IPv6 link-local and unique local addresses', async () => {
    const { validateConsoleUrl } = await loadFetchAsset()
    await assert.rejects(
      () => validateConsoleUrl('https://[fe80::1]'),
      /private or local address/
    )
    await assert.rejects(
      () => validateConsoleUrl('https://[fd00::1]'),
      /private or local address/
    )
  })

  it('rejects IPv4-mapped loopback addresses', async () => {
    const { validateConsoleUrl } = await loadFetchAsset()
    await assert.rejects(
      () => validateConsoleUrl('https://[::ffff:127.0.0.1]'),
      /private or local address/
    )
    await assert.rejects(
      () => validateConsoleUrl('https://[::ffff:10.0.0.5]'),
      /private or local address/
    )
  })

  it('rejects hostnames that resolve to loopback', async (t) => {
    mockDnsLookup(t, ['127.0.0.2'])
    const { validateConsoleUrl } = await loadFetchAsset()
    await assert.rejects(
      () => validateConsoleUrl('https://loopback.example.test'),
      /private or local address/
    )
  })

  it('allows public IPv4 addresses', async () => {
    const { validateConsoleUrl } = await loadFetchAsset()
    await assert.doesNotReject(() => validateConsoleUrl('https://1.1.1.1'))
    await assert.doesNotReject(() => validateConsoleUrl('https://8.8.8.8'))
  })

  it('allows public hostnames', async (t) => {
    mockDnsLookup(t, ['93.184.216.34'])
    const { validateConsoleUrl } = await loadFetchAsset()
    assert.deepEqual(await validateConsoleUrl('https://example.com'), ['93.184.216.34'])
  })

  it('rejects invalid URLs', async () => {
    const { validateConsoleUrl } = await loadFetchAsset()
    await assert.rejects(
      () => validateConsoleUrl('not-a-url'),
      /Invalid consoleUrl/
    )
  })
})

function makeFakeRequest (respond: () => void) {
  const req = new EventEmitter() as ClientRequest
  req.end = (() => {
    respond()
    return req
  }) as ClientRequest['end']
  req.destroy = ((error?: Error) => {
    if (error) queueMicrotask(() => req.emit('error', error))
    return req
  }) as ClientRequest['destroy']
  return req
}

function makeFakeResponse (body: Buffer | ((this: Readable) => void), statusCode = 200, statusMessage = 'OK', headers: Record<string, string> = {}) {
  let readCount = 0
  const res = new Readable({
    read () {
      if (readCount++ === 0) {
        if (Buffer.isBuffer(body)) {
          this.push(body)
        } else {
          // Function bodies own the stream lifecycle (EOF and/or error).
          body.call(this)
        }
        return
      }
      if (Buffer.isBuffer(body)) {
        this.push(null)
      }
    }
  }) as IncomingMessage
  res.statusCode = statusCode
  res.statusMessage = statusMessage
  res.headers = headers
  return res
}

describe('downloadAsset', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'fetch-asset-download-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('streams the asset body to disk and returns the file size', async (t) => {
    const payload = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    const calls: Array<{
      url: string
      headers: Record<string, string | string[] | undefined>
      lookup: unknown
    }> = []
    t.mock.method(https, 'request', ((input: string | URL, options: RequestOptions, callback?: (res: IncomingMessage) => void) => {
      calls.push({
        url: String(input),
        headers: (options.headers ?? {}) as Record<string, string>,
        lookup: options.lookup
      })
      return makeFakeRequest(() => { callback?.(makeFakeResponse(payload)) })
    }) as typeof https.request)

    const { downloadAsset } = await loadFetchAsset()
    const destPath = join(tempDir, 'heapsnapshot-test.heapsnapshot')

    const size = await downloadAsset(
      'https://console.example.test',
      'secret-token',
      'asset-id-1',
      destPath,
      ['93.184.216.34']
    )

    const stats = await stat(destPath)
    assert.equal(size, stats.size, 'returns the on-disk file size')
    assert.equal(size, payload.byteLength)
    assert.deepEqual(await readFile(destPath), payload, 'file bytes match the response body')
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, 'https://console.example.test/api/v3/asset/asset-id-1')
    assert.equal(calls[0].headers['x-nsolid-service-token'], 'secret-token')
    assert.equal(calls[0].headers.Accept, 'application/json')
    assert.equal(typeof calls[0].lookup, 'function', 'uses a lookup pinned to validated addresses')
    assert.deepEqual(await readdir(tempDir), ['heapsnapshot-test.heapsnapshot'])
  })

  it('URL-encodes the asset ID in the request path', async (t) => {
    const urls: string[] = []
    t.mock.method(https, 'request', ((input: string | URL, _options: RequestOptions, callback?: (res: IncomingMessage) => void) => {
      urls.push(String(input))
      return makeFakeRequest(() => { callback?.(makeFakeResponse(Buffer.from([1, 2, 3]))) })
    }) as typeof https.request)

    const { downloadAsset } = await loadFetchAsset()
    await downloadAsset(
      'https://console.example.test',
      'token',
      'id/with space',
      join(tempDir, 'a.heapsnapshot'),
      ['93.184.216.34']
    )

    assert.equal(urls[0], 'https://console.example.test/api/v3/asset/id%2Fwith%20space')
  })

  it('throws on non-ok responses without creating a file', async (t) => {
    t.mock.method(https, 'request', ((_input: string | URL, _options: RequestOptions, callback?: (res: IncomingMessage) => void) => {
      return makeFakeRequest(() => { callback?.(makeFakeResponse(Buffer.from('not found'), 404, 'Not Found')) })
    }) as typeof https.request)

    const { downloadAsset } = await loadFetchAsset()
    const destPath = join(tempDir, 'missing.heapsnapshot')
    await assert.rejects(
      () => downloadAsset('https://console.example.test', 'token', 'missing-id', destPath, ['93.184.216.34']),
      /404 Not Found for asset missing-id/
    )
    await assert.rejects(() => stat(destPath), /ENOENT/)
  })

  it('removes temporary bytes when the response stream fails', async (t) => {
    t.mock.method(https, 'request', ((_input: string | URL, _options: RequestOptions, callback?: (res: IncomingMessage) => void) => {
      return makeFakeRequest(() => {
        callback?.(makeFakeResponse(function (this: Readable) {
          this.push(Buffer.from([1, 2, 3]))
          queueMicrotask(() => this.destroy(new Error('stream interrupted')))
        }))
      })
    }) as typeof https.request)

    const { downloadAsset } = await loadFetchAsset()
    const destPath = join(tempDir, 'partial.heapsnapshot')

    await assert.rejects(
      () => downloadAsset('https://console.example.test', 'token', 'partial-id', destPath, ['93.184.216.34']),
      /stream interrupted/
    )
    await assert.rejects(() => stat(destPath), /ENOENT/)
    assert.deepEqual(await readdir(tempDir), [], 'does not leave a temporary file behind')
  })

  it('decompresses gzip-encoded responses before writing to disk', async (t) => {
    const payload = Buffer.from('heap snapshot payload '.repeat(64))
    t.mock.method(https, 'request', ((_input: string | URL, _options: RequestOptions, callback?: (res: IncomingMessage) => void) => {
      return makeFakeRequest(() => {
        callback?.(makeFakeResponse(gzipSync(payload), 200, 'OK', { 'content-encoding': 'gzip' }))
      })
    }) as typeof https.request)

    const { downloadAsset } = await loadFetchAsset()
    const destPath = join(tempDir, 'gzipped.heapsnapshot')

    const size = await downloadAsset(
      'https://console.example.test',
      'token',
      'gzip-id',
      destPath,
      ['93.184.216.34']
    )

    assert.equal(size, payload.byteLength, 'reports the decompressed size')
    assert.deepEqual(await readFile(destPath), payload, 'file holds decompressed bytes')
    assert.deepEqual(await readdir(tempDir), ['gzipped.heapsnapshot'])
  })

  it('aborts when the whole exchange exceeds the 10-minute deadline', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    // The request never responds: covers connect/headers stalling past the
    // absolute deadline (req.setTimeout would not catch this — it only
    // measures socket inactivity, and the body timer only starts after
    // headers arrive).
    t.mock.method(https, 'request', (() => makeFakeRequest(() => {})) as typeof https.request)

    const { downloadAsset } = await loadFetchAsset()
    const destPath = join(tempDir, 'stalled.heapsnapshot')
    const pending = downloadAsset('https://console.example.test', 'token', 'stalled-id', destPath, ['93.184.216.34'])
    const assertion = assert.rejects(pending, /exceeded 10 minutes/)
    t.mock.timers.tick(600_000)
    await assertion
    await assert.rejects(() => stat(destPath), /ENOENT/)
    assert.deepEqual(await readdir(tempDir), [], 'does not leave a temporary file behind')
  })
})
