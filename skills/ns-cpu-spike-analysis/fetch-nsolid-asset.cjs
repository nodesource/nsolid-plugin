#!/usr/bin/env node

// fetch-nsolid-asset.cjs — Downloads a profile or snapshot from N|Solid to
// .nsolid/assets/, and registers it in .nsolid/assets/index.json the way
// fetch-asset.cjs does for the N|Solid console.
//
// Usage:
//   node fetch-nsolid-asset.cjs <assetId> [appName]
//
// Needs the N|Solid API URL and a token (see nsolid-api.cjs). Idempotent: a file
// already downloaded is reused.

'use strict'

const fs = require('fs')
const path = require('path')
const { createClient, slug } = require('./nsolid-api.cjs')

// N|Solid's asset kinds, as the console's asset types and file extensions.
const KINDS = {
  cpu_profile: { type: 'cpuprofile', indexType: 'cpu-profile', ext: '.cpuprofile' },
  heap_sampling: { type: 'heapprofile', indexType: 'heap-profile', ext: '.heapprofile' },
  heap_snapshot: { type: 'heapsnapshot', indexType: 'heap-snapshot', ext: '.heapsnapshot' },
  heap_profile: { type: 'heaptimeline', indexType: 'heap-profile', ext: '.heaptimeline' }
}

function readIndex (indexPath) {
  if (!fs.existsSync(indexPath)) return []
  const parsed = JSON.parse(fs.readFileSync(indexPath, 'utf8'))
  if (!Array.isArray(parsed)) {
    throw new Error(`index.json is not an array; refusing to overwrite a malformed index at ${indexPath}`)
  }
  return parsed
}

async function main () {
  const [assetId, appArg] = process.argv.slice(2)
  if (!assetId || !/^[0-9a-f-]{36}$/i.test(assetId)) {
    throw new Error('usage: node fetch-nsolid-asset.cjs <assetId> [appName]')
  }
  const api = createClient()
  const tenant = encodeURIComponent(await api.tenant())
  const asset = await api.get(`/v1/tenants/${tenant}/assets/${assetId}`)
  const kind = KINDS[asset.kind]
  if (!kind) throw new Error(`a ${asset.kind} asset is not a profile or snapshot`)
  if (asset.status !== 'completed') throw new Error(`the asset's file is ${asset.status}`)
  let app = appArg
  if (!app) {
    const agent = await api.get(`/v1/tenants/${tenant}/agents/${asset.agentId}`).catch(() => null)
    app = agent?.app ?? 'unknown'
  }

  const dir = path.join(process.cwd(), '.nsolid', 'assets')
  fs.mkdirSync(dir, { recursive: true })
  const name = `${kind.type}-${slug(app)}-${assetId.slice(0, 8)}`
  const file = path.join(dir, `${name}${kind.ext}`)
  const reused = fs.existsSync(file)
  const size = reused ? fs.statSync(file).size : await api.download(`/v1/tenants/${tenant}/assets/${assetId}/download`, file)

  const indexPath = path.join(dir, 'index.json')
  const records = readIndex(indexPath)
  const record = {
    assetId,
    name,
    type: kind.indexType,
    app,
    localPath: path.basename(file),
    downloadedAt: new Date().toISOString(),
    fileSize: size,
    source: 'nsolid'
  }
  const i = records.findIndex((r) => r.assetId === assetId)
  if (i >= 0) records[i] = record
  else records.push(record)
  fs.writeFileSync(indexPath, JSON.stringify(records, null, 2), 'utf8')

  console.log(`${reused ? 'Asset already downloaded at' : 'Asset saved to'}: ${file}`)
  console.log(`File size: ${(size / 1024).toFixed(1)} KB`)
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`Error: ${err.message}`)
    process.exit(1)
  })
}
