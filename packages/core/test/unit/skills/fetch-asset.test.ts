import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

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
    validateConsoleUrl: (consoleUrl: string) => Promise<void>
  }
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

  it('rejects hostnames that resolve to loopback', async () => {
    const { validateConsoleUrl } = await loadFetchAsset()
    await assert.rejects(
      () => validateConsoleUrl('https://localhost'),
      /consoleUrl cannot be localhost/
    )
  })

  it('allows public IPv4 addresses', async () => {
    const { validateConsoleUrl } = await loadFetchAsset()
    await assert.doesNotReject(() => validateConsoleUrl('https://1.1.1.1'))
    await assert.doesNotReject(() => validateConsoleUrl('https://8.8.8.8'))
  })

  it('allows public hostnames', async () => {
    const { validateConsoleUrl } = await loadFetchAsset()
    await assert.doesNotReject(() => validateConsoleUrl('https://example.com'))
  })

  it('rejects invalid URLs', async () => {
    const { validateConsoleUrl } = await loadFetchAsset()
    await assert.rejects(
      () => validateConsoleUrl('not-a-url'),
      /Invalid consoleUrl/
    )
  })
})
