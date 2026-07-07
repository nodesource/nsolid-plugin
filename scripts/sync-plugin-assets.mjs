#!/usr/bin/env node
/**
 * Source-hygiene sync for committed plugin packages.
 *
 * Source of truth:
 *   - bundle.json
 *   - skills/
 *
 * Remaining committed workspace package:
 *   - packages/pi-plugin
 *
 * Claude/Codex/Antigravity install directly from the repository root.
 *
 * Usage:
 *   node scripts/sync-plugin-assets.mjs                       # clean materialized skill copies
 *   node scripts/sync-plugin-assets.mjs --check               # fail if materialized skill copies are present
 *   node scripts/sync-plugin-assets.mjs --materialize-skills  # copy skills into the Pi package for pack/release
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadBundle } from './plugin-generators.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = process.env.NSOLID_PLUGIN_SYNC_ROOT
  ? path.resolve(process.env.NSOLID_PLUGIN_SYNC_ROOT)
  : path.resolve(__dirname, '..')
const CHECK_MODE = process.argv.includes('--check')
const MATERIALIZE_SKILLS = process.argv.includes('--materialize-skills')

const CORE_SKILLS_DIR = path.join(ROOT, 'skills')
const CORE_PACKAGE_SKILLS_DIR = path.join(ROOT, 'packages', 'core', 'skills')
const PI_PLUGIN_DIR = path.join(ROOT, 'packages', 'pi-plugin')

const bundle = loadBundle(ROOT)
const skillNames = bundle.skills.map((skill) => skill.name)
const skillNamesSet = new Set(skillNames)

let driftDetected = false

const coreSkillDrift = validateCoreSkillSources()
if (coreSkillDrift) driftDetected = true

// Pi is the only committed plugin package that still materializes skills for its npm artifact.
const piSkillDrift = MATERIALIZE_SKILLS
  ? materializePiSkills()
  : cleanPiSkills()
if (piSkillDrift) driftDetected = true

const corePackageSkillDrift = cleanCorePackageSkills()
if (corePackageSkillDrift) driftDetected = true

const hygieneDrift = checkSourceHygiene()
if (hygieneDrift) driftDetected = true

if (driftDetected) {
  if (CHECK_MODE) {
    console.error('plugin:check failed: source tree is out of sync.')
    process.exit(1)
  }
  console.log('plugin:sync completed.')
} else {
  console.log('plugin:sync up to date.')
}

function validateCoreSkillSources () {
  let drift = false
  for (const skillName of skillNames) {
    const srcDir = path.join(CORE_SKILLS_DIR, skillName)
    if (!existsSync(srcDir)) {
      const message = `Missing core skill directory: ${path.relative(ROOT, srcDir)}`
      if (CHECK_MODE) {
        console.error(message)
      } else {
        throw new Error(message)
      }
      drift = true
    }
  }
  return drift
}

function cleanPiSkills () {
  const destSkillsDir = path.join(PI_PLUGIN_DIR, 'skills')
  if (!existsSync(destSkillsDir)) return false

  if (CHECK_MODE) {
    console.error(`Materialized skill dir present in source tree: ${path.relative(ROOT, destSkillsDir)}`)
    return true
  }

  rmSync(destSkillsDir, { recursive: true, force: true })
  console.log(`Removed materialized skill dir: ${path.relative(ROOT, destSkillsDir)}`)
  return true
}

function cleanCorePackageSkills () {
  if (!existsSync(CORE_PACKAGE_SKILLS_DIR)) return false

  if (CHECK_MODE) {
    console.error(`Materialized skill dir present in source tree: ${path.relative(ROOT, CORE_PACKAGE_SKILLS_DIR)}`)
    return true
  }

  rmSync(CORE_PACKAGE_SKILLS_DIR, { recursive: true, force: true })
  console.log(`Removed materialized skill dir: ${path.relative(ROOT, CORE_PACKAGE_SKILLS_DIR)}`)
  return true
}

function materializePiSkills () {
  const destSkillsDir = path.join(PI_PLUGIN_DIR, 'skills')
  let drift = false

  if (existsSync(destSkillsDir)) {
    for (const entry of readdirSync(destSkillsDir)) {
      const entryPath = path.join(destSkillsDir, entry)
      const stat = statSync(entryPath)
      if (stat.isDirectory() && !skillNamesSet.has(entry)) {
        drift = true
        if (CHECK_MODE) {
          console.error(`Stale skill dir: ${path.relative(ROOT, entryPath)}`)
        } else {
          rmSync(entryPath, { recursive: true, force: true })
          console.log(`Removed stale skill dir: ${path.relative(ROOT, entryPath)}`)
        }
      }
    }
  }

  for (const skillName of skillNames) {
    const srcDir = path.join(CORE_SKILLS_DIR, skillName)
    const dstDir = path.join(destSkillsDir, skillName)

    if (!directoryEquals(srcDir, dstDir)) {
      drift = true
      if (CHECK_MODE) {
        console.error(`Drift detected: ${path.relative(ROOT, dstDir)}`)
      } else {
        // Ensure parent exists before removing/recreating child.
        if (!existsSync(path.dirname(dstDir))) {
          mkdirSync(path.dirname(dstDir), { recursive: true })
        }
        rmSync(dstDir, { recursive: true, force: true })
        cpSync(srcDir, dstDir, { recursive: true, dereference: true })
        console.log(`Materialized skill: ${path.relative(ROOT, dstDir)}`)
      }
    }
  }

  return drift
}

function checkSourceHygiene () {
  let drift = false
  // Reject any package-local skills dirs in removed/legacy plugin packages.
  const packageRoots = [
    path.join(ROOT, 'packages', 'claude-plugin'),
    path.join(ROOT, 'packages', 'codex-plugin'),
    path.join(ROOT, 'packages', 'antigravity-plugin'),
  ]
  for (const pkgRoot of packageRoots) {
    const skillsDir = path.join(pkgRoot, 'skills')
    if (existsSync(skillsDir)) {
      if (CHECK_MODE) {
        console.error(`Unexpected materialized skill dir in removed package: ${path.relative(ROOT, skillsDir)}`)
      } else {
        rmSync(skillsDir, { recursive: true, force: true })
        console.log(`Removed unexpected materialized skill dir: ${path.relative(ROOT, skillsDir)}`)
      }
      drift = true
    }
  }
  return drift
}

function directoryEquals (src, dst) {
  if (!existsSync(dst)) return false

  const srcEntries = readdirSync(src).sort()
  const dstEntries = readdirSync(dst).sort()

  if (srcEntries.length !== dstEntries.length) return false

  for (let i = 0; i < srcEntries.length; i++) {
    if (srcEntries[i] !== dstEntries[i]) return false

    const srcPath = path.join(src, srcEntries[i])
    const dstPath = path.join(dst, dstEntries[i])
    const srcStat = statSync(srcPath)
    const dstStat = statSync(dstPath)

    if (srcStat.isDirectory() !== dstStat.isDirectory()) return false

    if (srcStat.isDirectory()) {
      if (!directoryEquals(srcPath, dstPath)) return false
    } else {
      const srcBuf = readFileSync(srcPath)
      const dstBuf = readFileSync(dstPath)
      if (Buffer.compare(srcBuf, dstBuf) !== 0) return false
    }
  }

  return true
}
