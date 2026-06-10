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
// The script reads the console URL and service token from .vscode/settings.json
// in the workspace root (walks up from its own location to find it).
//
// Output files:
//   .nsolid/assets/<assetType>-<appName>-<assetIdPrefix>.<ext>

'use strict'

const fs = require('fs')
const path = require('path')

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
    const indexedPath = path.join(assetsDir, indexRecord.localPath)
    if (fs.existsSync(indexedPath)) {
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

function findWorkspaceRoot (startDir) {
  let dir = startDir
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '.vscode', 'settings.json'))) {
      return dir
    }
    if (fs.existsSync(path.join(dir, 'package.json'))) {
      return dir
    }
    dir = path.dirname(dir)
  }
  return startDir
}

function stripJsonComments (input) {
  let output = ''
  let inString = false
  let escaped = false
  let inLineComment = false
  let inBlockComment = false

  for (let index = 0; index < input.length; index++) {
    const current = input[index]
    const next = input[index + 1]

    if (inLineComment) {
      if (current === '\n') {
        inLineComment = false
        output += current
      }
      continue
    }

    if (inBlockComment) {
      if (current === '*' && next === '/') {
        inBlockComment = false
        index++
      }
      continue
    }

    if (inString) {
      output += current
      if (escaped) {
        escaped = false
      } else if (current === '\\') {
        escaped = true
      } else if (current === '"') {
        inString = false
      }
      continue
    }

    if (current === '"') {
      inString = true
      output += current
      continue
    }

    if (current === '/' && next === '/') {
      inLineComment = true
      index++
      continue
    }

    if (current === '/' && next === '*') {
      inBlockComment = true
      index++
      continue
    }

    output += current
  }

  return output
}

function stripTrailingCommas (input) {
  return input.replace(/,\s*([}\]])/g, '$1')
}

function readSettings (workspaceRoot) {
  const settingsPath = path.join(workspaceRoot, '.vscode', 'settings.json')
  if (!fs.existsSync(settingsPath)) {
    throw new Error(`Cannot find .vscode/settings.json at ${settingsPath}`)
  }

  const raw = fs.readFileSync(settingsPath, 'utf-8')
  const cleaned = stripTrailingCommas(stripJsonComments(raw))
  const settings = JSON.parse(cleaned)

  const consoleUrl = settings['nsolid.consoleUrl'] || settings['nsolid.apiBaseUrl']
  const token = settings['nsolid.serviceToken'] || settings['nsolid.authToken']

  if (!consoleUrl) {
    throw new Error('Missing "nsolid.consoleUrl" or legacy "nsolid.apiBaseUrl" in .vscode/settings.json')
  }
  if (!token) {
    throw new Error('Missing "nsolid.serviceToken" or legacy "nsolid.authToken" in .vscode/settings.json')
  }

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

  const workspaceRoot = findWorkspaceRoot(path.resolve(__dirname))
  const { consoleUrl, token } = readSettings(workspaceRoot)

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

main().catch((err) => {
  console.error(`Error: ${err.message}`)
  process.exit(1)
})
