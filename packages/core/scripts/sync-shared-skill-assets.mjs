#!/usr/bin/env node

import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  copyFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..', '..', '..')
const SOURCE_SKILLS_DIR = resolve(REPO_ROOT, 'skills')
const SOURCE_SHARED_DIR = resolve(REPO_ROOT, 'skill-assets')
const PACKAGE_SKILLS_DIR = resolve(__dirname, '..', 'skills')

const manifestPath = join(__dirname, 'skill-assets.manifest.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'))

function hashFile (filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex')
}

const checking = process.argv.includes('--check')

let synced = 0
let drift = false

for (const [file, skillNames] of Object.entries(manifest)) {
  const source = join(SOURCE_SHARED_DIR, file)
  const expectedHash = hashFile(source)
  for (const skillName of skillNames) {
    const dest = join(SOURCE_SKILLS_DIR, skillName, file)
    if (!existsSync(dest) || hashFile(dest) !== expectedHash) {
      console.error(`DRIFT: skills/${skillName}/${file} differs from skill-assets/${file}`)
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
    console.error('check: FAILED — some per-skill copies have drifted from skill-assets/. Run "pnpm run skills:sync" to fix.')
    process.exit(1)
  }
  console.error('Auto-fixed by running sync.')
}

if (!checking) {
  rmSync(PACKAGE_SKILLS_DIR, { recursive: true, force: true })
  mkdirSync(dirname(PACKAGE_SKILLS_DIR), { recursive: true })
  cpSync(SOURCE_SKILLS_DIR, PACKAGE_SKILLS_DIR, { recursive: true, dereference: true })
  console.log(`${synced} files synced from skill-assets/; materialized package skills/`)
} else {
  console.log('check: OK — all per-skill copies match skill-assets/')
}
