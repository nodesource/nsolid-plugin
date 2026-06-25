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

  try {
    if (fs.existsSync(indexPath)) {
      return JSON.parse(fs.readFileSync(indexPath, 'utf-8'))
    }
  } catch {
    return []
  }

  return []
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

  const indexRecord = readAssetIndex(workspaceRoot).find(record => record.assetId === assetId)
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
    return
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

  await validateConsoleUrl(consoleUrl)

  return { consoleUrl: consoleUrl.replace(/\/$/, ''), token }
}

async function fetchAsset (consoleUrl, token, assetId) {
  const url = `${consoleUrl}/api/v3/asset/${encodeURIComponent(assetId)}`
  console.log(`Fetching asset from: ${url}`)

  const res = await fetch(url, {
    headers: {
      'x-nsolid-service-token': token,
      Accept: 'application/json'
    },
    signal: AbortSignal.timeout(120_000)
  })

  if (!res.ok) {
    throw new Error(`Console returned ${res.status} ${res.statusText} for asset ${assetId}`)
  }

  return await res.text()
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
  const { consoleUrl, token } = await readCredentials()

  const assetsDir = getAssetsDir(workspaceRoot)
  fs.mkdirSync(assetsDir, { recursive: true })

  const existingAsset = ensureFlatAsset(workspaceRoot, assetId, assetType, appName)

  let fileSize
  if (existingAsset.exists) {
    fileSize = fs.statSync(existingAsset.filePath).size
  } else {
    const data = await fetchAsset(consoleUrl, token, assetId)
    fs.writeFileSync(existingAsset.filePath, data, 'utf-8')
    fileSize = Buffer.byteLength(data)
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

module.exports = { isPrivateOrLocalIp, resolveHostnameIps, validateConsoleUrl, readCredentials, fetchAsset }
