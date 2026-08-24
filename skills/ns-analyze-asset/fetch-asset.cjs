#!/usr/bin/env node

// fetch-asset.cjs — Downloads a full N|Solid asset (CPU profile, heap snapshot,
// heap sampling) from the console API and saves it to .nsolid/assets/.
//
// Usage:
//   node fetch-asset.cjs <assetId> <assetType> [appName]
//
// Arguments:
//   assetId   — The asset ID returned by the profile/snapshot/heap-sampling MCP tool
//   assetType — One of: cpuprofile, heapprofile, heapsnapshot
//   appName   — (Optional) Application name for the filename, defaults to "unknown"
//
// The script reads the console URL and service token from ~/.agents/.nodesource-auth.json.
// Assets are saved to <cwd>/.nsolid/assets/.
//
// Output files:
//   .nsolid/assets/<assetType>-<appName>-<assetIdPrefix>.<ext>
//
// Note: This script is designed for single-process/single-user workflows.
// Concurrent executions may race on file operations and index updates.

'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const dns = require('dns').promises
const net = require('net')
const { randomUUID } = require('crypto')
const { pipeline } = require('stream/promises')
const http = require('http')
const https = require('https')
const zlib = require('zlib')

const EXTENSIONS = {
  cpuprofile: '.cpuprofile',
  heapprofile: '.heapprofile',
  heapsnapshot: '.heapsnapshot'
}

// Maps fetch-asset type args to the AssetType values used by the extension's AssetService
const ASSET_TYPES = {
  cpuprofile: 'cpu-profile',
  heapprofile: 'heap-profile',
  heapsnapshot: 'heap-snapshot'
}

function getAssetsDir (workspaceRoot) {
  return path.join(workspaceRoot, '.nsolid', 'assets')
}

function sanitizeAppName (appName) {
  return appName.replace(/[^a-zA-Z0-9_-]/g, '_')
}

function buildAssetFilename (assetType, appName, assetId) {
  return `${assetType}-${sanitizeAppName(appName)}-${assetId.slice(0, 8)}${EXTENSIONS[assetType]}`
}

function readAssetIndex (workspaceRoot) {
  const indexPath = path.join(getAssetsDir(workspaceRoot), 'index.json')

  // Only treat a genuinely missing index as empty. A file that exists but is
  // unreadable or malformed must NOT be swallowed into [] — otherwise the next
  // saveToAssetIndex() upsert would overwrite it and silently drop every
  // existing entry. Surface that error so the caller can fail loudly.
  if (!fs.existsSync(indexPath)) {
    return []
  }

  const raw = fs.readFileSync(indexPath, 'utf-8')
  const parsed = JSON.parse(raw)
  if (!Array.isArray(parsed)) {
    throw new Error(`index.json is not an array; refusing to overwrite a malformed index at ${indexPath}`)
  }
  return parsed
}

function isPathWithin (parent, candidate) {
  const rel = path.relative(parent, candidate)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

function writeAssetIndex (workspaceRoot, records) {
  const indexPath = path.join(getAssetsDir(workspaceRoot), 'index.json')
  fs.writeFileSync(indexPath, JSON.stringify(records, null, 2), 'utf-8')
}

function saveToAssetIndex (workspaceRoot, record) {
  const records = readAssetIndex(workspaceRoot)

  // Upsert by assetId (mirrors AssetService.saveToIndex)
  const idx = records.findIndex(r => r.assetId === record.assetId)
  if (idx >= 0) {
    records[idx] = record
  } else {
    records.push(record)
  }

  writeAssetIndex(workspaceRoot, records)
}

function removeDirectoryIfEmpty (dirPath) {
  if (!fs.existsSync(dirPath)) {
    return
  }

  if (fs.readdirSync(dirPath).length === 0) {
    fs.rmdirSync(dirPath)
  }
}

function resolveExistingAsset (workspaceRoot, assetId, assetType, appName) {
  const assetsDir = getAssetsDir(workspaceRoot)
  const expectedFilename = buildAssetFilename(assetType, appName, assetId)
  const expectedPath = path.join(assetsDir, expectedFilename)

  if (fs.existsSync(expectedPath)) {
    return {
      filePath: expectedPath,
      localPath: expectedFilename,
      source: 'flat'
    }
  }

  // Lookups are lenient: a malformed/unreadable index.json must not block the
  // legacy fallback probe below. readAssetIndex() stays strict for the write
  // path (saveToAssetIndex) so a bad index is never silently clobbered; here
  // we only need a best-effort match and treat any read failure as "no match".
  let indexRecord
  try {
    indexRecord = readAssetIndex(workspaceRoot).find(record => record.assetId === assetId)
  } catch {
    indexRecord = undefined
  }
  if (indexRecord?.localPath) {
    const indexedPath = path.resolve(assetsDir, indexRecord.localPath)
    if (isPathWithin(assetsDir, indexedPath) && fs.existsSync(indexedPath)) {
      return {
        filePath: indexedPath,
        localPath: indexRecord.localPath,
        source: 'index'
      }
    }
  }

  const legacyPath = path.join(assetsDir, sanitizeAppName(appName), `${assetId}${EXTENSIONS[assetType]}`)
  if (fs.existsSync(legacyPath)) {
    return {
      filePath: legacyPath,
      localPath: path.join(sanitizeAppName(appName), `${assetId}${EXTENSIONS[assetType]}`),
      source: 'legacy'
    }
  }

  return null
}

function ensureFlatAsset (workspaceRoot, assetId, assetType, appName) {
  const assetsDir = getAssetsDir(workspaceRoot)
  const filename = buildAssetFilename(assetType, appName, assetId)
  const filePath = path.join(assetsDir, filename)
  const existing = resolveExistingAsset(workspaceRoot, assetId, assetType, appName)

  if (!existing) {
    return {
      exists: false,
      filePath,
      localPath: filename
    }
  }

  if (existing.filePath !== filePath) {
    fs.renameSync(existing.filePath, filePath)
    if (existing.source === 'legacy') {
      removeDirectoryIfEmpty(path.dirname(existing.filePath))
    }

    return {
      exists: true,
      migrated: true,
      filePath,
      localPath: filename
    }
  }

  return {
    exists: true,
    migrated: false,
    filePath,
    localPath: filename
  }
}

function expandIPv6 (ip) {
  // IPv4-mapped/compatible addresses embed a dotted IPv4 at the end and must
  // not be expanded with the generic :: handler below.
  const embeddedIpv4 = extractIpv4FromIpv6(ip)
  if (embeddedIpv4) {
    return null
  }

  let expanded = ip.toLowerCase()
  if (expanded.includes('::')) {
    const [left, right] = expanded.split('::')
    const leftParts = left ? left.split(':') : []
    const rightParts = right ? right.split(':') : []
    const missing = 8 - leftParts.length - rightParts.length
    const middle = Array(Math.max(missing, 0)).fill('0000')
    expanded = [...leftParts, ...middle, ...rightParts].join(':')
  }
  return expanded.split(':').map(p => p.padStart(4, '0')).join(':')
}

function extractIpv4FromIpv6 (ip) {
  // IPv4-mapped:  ::ffff:a.b.c.d  or  0:0:0:0:0:ffff:a.b.c.d
  const mapped = ip.match(/^(?:::|(?:0:){5})ffff:(\d+\.\d+\.\d+\.\d+)$/i)
  if (mapped) return mapped[1]
  // IPv4-compatible:  ::a.b.c.d  or  0:0:0:0:0:0:a.b.c.d
  const compatible = ip.match(/^(?:::|(?:0:){6})(\d+\.\d+\.\d+\.\d+)$/i)
  if (compatible) return compatible[1]
  return null
}

function isPrivateOrLocalIp (ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number)
    if (a === 127) return true // loopback 127.0.0.0/8
    if (a === 10) return true // private 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true // private 172.16.0.0/12
    if (a === 192 && b === 168) return true // private 192.168.0.0/16
    if (a === 169 && b === 254) return true // link-local 169.254.0.0/16
    if (a === 0) return true // current network 0.0.0.0/8
    return false
  }

  if (net.isIPv6(ip)) {
    const embeddedIpv4 = extractIpv4FromIpv6(ip)
    if (embeddedIpv4) {
      return isPrivateOrLocalIp(embeddedIpv4)
    }

    const normalized = expandIPv6(ip)
    if (normalized === null) {
      // Defensive: extractIpv4FromIpv6 should have matched any mapped/compatible
      // address that net.isIPv6 accepted, but treat unexpected forms as unsafe.
      return true
    }

    // URL parsers normalize IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible
    // (::a.b.c.d) addresses to pure hex. Detect those forms by prefix.
    if (normalized.startsWith('0000:0000:0000:0000:0000:ffff:') ||
        normalized.startsWith('0000:0000:0000:0000:0000:0000:')) {
      const high = parseInt(normalized.slice(30, 34), 16)
      const low = parseInt(normalized.slice(35, 39), 16)
      const ipv4 = `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`
      return isPrivateOrLocalIp(ipv4)
    }

    const first16 = parseInt(normalized.slice(0, 4), 16)
    if (normalized === '0000:0000:0000:0000:0000:0000:0000:0001') return true // ::1
    if ((first16 & 0xffc0) === 0xfe80) return true // link-local fe80::/10
    if ((first16 & 0xfe00) === 0xfc00) return true // unique local fc00::/7
    return false
  }

  return false
}

async function resolveHostnameIps (hostname) {
  const raw = hostname.replace(/^\[/, '').replace(/\]$/, '')
  const ipVersion = net.isIP(raw)

  if (ipVersion === 4) {
    return [raw]
  }
  if (ipVersion === 6) {
    return [raw]
  }

  const ips = []
  // Use dns.lookup (libuv/getaddrinfo), which honors /etc/hosts and the
  // system resolver — not dns.resolve (c-ares), which bypasses /etc/hosts and
  // therefore fails to resolve hostnames like `localhost` on platforms where
  // they only exist in the hosts file (e.g. macOS). This also matches the real
  // resolution an outbound fetch would use, which is what SSRF validation needs.
  try {
    const records = await dns.lookup(raw, { all: true, verbatim: true })
    ips.push(...records.map((r) => r.address))
  } catch {
    // hostname could not be resolved; caller treats empty as an error
  }
  return ips
}

async function validateConsoleUrl (consoleUrl) {
  let url
  try {
    url = new URL(consoleUrl)
  } catch {
    throw new Error(`Invalid consoleUrl: ${consoleUrl}`)
  }

  if (process.env.NSOLID_ALLOW_INSECURE_CONSOLE) {
    return null
  }

  if (url.protocol !== 'https:') {
    throw new Error(`consoleUrl must use HTTPS: ${consoleUrl}`)
  }

  const hostname = url.hostname.toLowerCase().replace(/\.$/, '')
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1') {
    throw new Error(`consoleUrl cannot be localhost: ${consoleUrl}`)
  }

  const ips = await resolveHostnameIps(url.hostname)
  if (ips.length === 0) {
    throw new Error(`consoleUrl hostname could not be resolved: ${consoleUrl}`)
  }

  for (const ip of ips) {
    if (isPrivateOrLocalIp(ip)) {
      throw new Error(`consoleUrl resolves to a private or local address: ${consoleUrl} (${ip})`)
    }
  }

  return ips
}

// Returns a dns.lookup-compatible function that resolves the console hostname
// exclusively to the addresses validated by validateConsoleUrl(). Passing it as
// the `lookup` option of http/https.request pins the connection to those
// addresses and closes the DNS-rebinding gap between validation and connect.
// Built-in modules only — this script must stay standalone (no node_modules).
function createPinnedLookup (consoleUrl, resolvedIps) {
  const expectedHostname = new URL(consoleUrl).hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '').replace(/\.$/, '')
  const allowedIps = [...new Set(resolvedIps)]

  if (allowedIps.length === 0) {
    throw new Error(`No validated addresses available for consoleUrl: ${consoleUrl}`)
  }

  return (hostname, options, callback) => {
    const requestedHostname = hostname.toLowerCase().replace(/\.$/, '')
    if (requestedHostname !== expectedHostname) {
      const error = new Error(`Refusing to resolve unvalidated hostname: ${hostname}`)
      error.code = 'ENOTFOUND'
      callback(error)
      return
    }

    const family = typeof options === 'number' ? options : options?.family
    const matches = allowedIps
      .map(address => ({ address, family: net.isIP(address) }))
      .filter(record => record.family !== 0 && (!family || record.family === family))

    if (matches.length === 0) {
      const error = new Error(`No validated address matches the requested family for: ${hostname}`)
      error.code = 'ENOTFOUND'
      callback(error)
      return
    }

    if (typeof options === 'object' && options?.all) {
      callback(null, matches)
      return
    }

    callback(null, matches[0].address, matches[0].family)
  }
}

async function readCredentials () {
  const authPath = path.join(os.homedir(), '.agents', '.nodesource-auth.json')

  if (!fs.existsSync(authPath)) {
    throw new Error(
      'Credentials not found. Run "npx @nodesource/plugin-<harness> login" to authenticate.'
    )
  }

  let auth
  try {
    auth = JSON.parse(fs.readFileSync(authPath, 'utf-8'))
  } catch (e) {
    throw new Error(`Failed to parse ${authPath}: ${e.message}`)
  }
  const consoleUrl = auth.consoleUrl
  const token = auth.serviceToken

  if (!consoleUrl) {
    throw new Error('Missing "consoleUrl" in ~/.agents/.nodesource-auth.json')
  }
  if (!token) {
    throw new Error('Missing "serviceToken" in ~/.agents/.nodesource-auth.json')
  }

  const resolvedIps = await validateConsoleUrl(consoleUrl)

  return { consoleUrl: consoleUrl.replace(/\/$/, ''), token, resolvedIps }
}

async function downloadAsset (consoleUrl, token, assetId, destPath, validatedIps) {
  const url = new URL(`${consoleUrl}/api/v3/asset/${encodeURIComponent(assetId)}`)
  console.log(`Fetching asset from: ${url}`)

  const resolvedIps = validatedIps === undefined
    ? await validateConsoleUrl(consoleUrl)
    : validatedIps
  const lookup = resolvedIps === null
    ? undefined
    : createPinnedLookup(consoleUrl, resolvedIps)

  // Keep incomplete bytes invisible to resolveExistingAsset(). The temporary
  // file lives beside the destination so renameSync publishes it atomically.
  const tempPath = `${destPath}.${process.pid}.${randomUUID()}.tmp`

  // One absolute deadline spanning connect, response headers, and body — the
  // same total budget AbortSignal.timeout(600_000) enforced before.
  // req.setTimeout() would only measure socket inactivity, so a stalled
  // connection could otherwise exceed the budget indefinitely.
  let abortInFlight = () => {}
  const deadline = setTimeout(() => {
    abortInFlight(new Error(`Download of asset ${assetId} exceeded 10 minutes`))
  }, 600_000)

  try {
    const res = await new Promise((resolve, reject) => {
      // http/https.request never follows redirects, so the service token can
      // never be forwarded to a different origin.
      const transport = url.protocol === 'http:' ? http : https
      const req = transport.request(url, {
        headers: {
          'x-nsolid-service-token': token,
          Accept: 'application/json',
          // We handle gzip manually below; ask the server for identity so the
          // common case streams straight to disk.
          'Accept-Encoding': 'identity'
        },
        lookup
      }, resolve)
      abortInFlight = (error) => req.destroy(error)
      req.on('error', reject)
      req.end()
    })

    if (res.statusCode < 200 || res.statusCode >= 300) {
      res.resume() // drain the socket before throwing
      const isRedirect = res.statusCode >= 300 && res.statusCode < 400
      throw new Error(
        `Console returned ${res.statusCode} ${res.statusMessage} for asset ${assetId}` +
        (isRedirect ? ' (redirects are not followed)' : '')
      )
    }

    // The console can serve assets gzip-compressed regardless of
    // Accept-Encoding negotiation (its `compressed` flag). Decompress before
    // writing so the on-disk asset and the recorded fileSize are always the
    // plain payload — fetch() used to do this transparently.
    const encoding = String(res.headers['content-encoding'] ?? 'identity').toLowerCase()
    if (encoding !== 'identity' && encoding !== 'gzip') {
      res.resume() // drain the socket before throwing
      throw new Error(`Unsupported Content-Encoding "${encoding}" for asset ${assetId}`)
    }

    abortInFlight = (error) => res.destroy(error)
    const writer = fs.createWriteStream(tempPath, { flags: 'wx' })
    if (encoding === 'gzip') {
      await pipeline(res, zlib.createGunzip(), writer)
    } else {
      await pipeline(res, writer)
    }
    fs.renameSync(tempPath, destPath)

    return fs.statSync(destPath).size
  } catch (error) {
    fs.rmSync(tempPath, { force: true })
    throw error
  } finally {
    clearTimeout(deadline)
  }
}

async function main () {
  const [,, assetId, assetType, appName = 'unknown'] = process.argv

  if (!assetId || !assetType) {
    console.error('Usage: node fetch-asset.cjs <assetId> <assetType> [appName]')
    console.error('  assetType: cpuprofile | heapprofile | heapsnapshot')
    process.exit(1)
  }

  const ext = EXTENSIONS[assetType]
  if (!ext) {
    console.error(`Unknown asset type: ${assetType}. Use one of: ${Object.keys(EXTENSIONS).join(', ')}`)
    process.exit(1)
  }

  const workspaceRoot = process.cwd()
  const { consoleUrl, token, resolvedIps } = await readCredentials()

  const assetsDir = getAssetsDir(workspaceRoot)
  fs.mkdirSync(assetsDir, { recursive: true })

  const existingAsset = ensureFlatAsset(workspaceRoot, assetId, assetType, appName)

  let fileSize
  if (existingAsset.exists) {
    fileSize = fs.statSync(existingAsset.filePath).size
  } else {
    fileSize = await downloadAsset(consoleUrl, token, assetId, existingAsset.filePath, resolvedIps)
  }

  // Register in .nsolid/assets/index.json so the extension's AssetService can discover it
  saveToAssetIndex(workspaceRoot, {
    assetId,
    name: `${assetType}-${sanitizeAppName(appName)}-${assetId.slice(0, 8)}`,
    type: ASSET_TYPES[assetType],
    app: appName,
    localPath: existingAsset.localPath,
    downloadedAt: new Date().toISOString(),
    fileSize
  })

  if (existingAsset.exists) {
    if (existingAsset.migrated) {
      console.log(`Asset already existed and was moved to: ${existingAsset.filePath}`)
    } else {
      console.log(`Asset already downloaded at: ${existingAsset.filePath}`)
    }
  } else {
    console.log(`Asset saved to: ${existingAsset.filePath}`)
  }
  console.log(`File size: ${(fileSize / 1024).toFixed(1)} KB`)
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`Error: ${err.message}`)
    process.exit(1)
  })
}

module.exports = { isPrivateOrLocalIp, resolveHostnameIps, validateConsoleUrl, readCredentials, downloadAsset }
