#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootBundle = path.resolve(__dirname, '..', '..', '..', 'bundle.json')
const coreBundle = path.resolve(__dirname, '..', 'bundle.json')

function normalize (text) {
  return text.replace(/\r\n/g, '\n').trim()
}

const args = process.argv.slice(2)
const checkOnly = args.includes('--check') || args.includes('-c')

const rootText = normalize(readFileSync(rootBundle, 'utf8'))
const coreText = normalize(readFileSync(coreBundle, 'utf8'))

const rootHash = createHash('sha256').update(rootText).digest('hex')
const coreHash = createHash('sha256').update(coreText).digest('hex')

if (rootHash === coreHash) {
  console.log('bundle.json is in sync')
  process.exit(0)
}

if (checkOnly) {
  console.error('bundle.json is out of sync')
  console.error(`  root: ${rootBundle}`)
  console.error(`  core: ${coreBundle}`)
  process.exit(1)
}

// Default: sync from root to core (used by prepack / CI)
writeFileSync(coreBundle, rootText + '\n')
console.log('Synced bundle.json from workspace root into packages/core/')
process.exit(0)
