#!/usr/bin/env node

import { readFileSync, copyFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

const SHARED_DIR = resolve(__dirname, '..', 'skills', '_shared')
const SKILLS_DIR = resolve(__dirname, '..', 'skills')

const manifestPath = join(__dirname, 'skill-assets.manifest.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'))

function hashFile (filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex')
}

const checking = process.argv.includes('--check')

let synced = 0
let drift = false

for (const [file, skillNames] of Object.entries(manifest)) {
  const source = join(SHARED_DIR, file)
  const expectedHash = hashFile(source)
  for (const skillName of skillNames) {
    const dest = join(SKILLS_DIR, skillName, file)
    if (!existsSync(dest) || hashFile(dest) !== expectedHash) {
      console.error(`DRIFT: skills/${skillName}/${file} differs from _shared/${file}`)
      drift = true
    }
    if (!checking) {
      copyFileSync(source, dest)
      synced++
    }
  }
}

if (drift) {
  if (checking) {
    console.error('check: FAILED — some per-skill copies have drifted from _shared/. Run "pnpm run skills:sync" to fix.')
    process.exit(1)
  }
  console.error('Auto-fixed by running sync.')
}

if (!checking) {
  console.log(`${synced} files synced from _shared/ to ${Object.keys(manifest).length} shared asset(s)`)
} else {
  console.log('check: OK — all per-skill copies match _shared/')
}
