#!/usr/bin/env node

import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { existsSync } from 'node:fs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const corePkgRoot = path.resolve(__dirname, '..')
const repoRoot = path.resolve(corePkgRoot, '..', '..')
const defaultSourceRoot = existsSync(path.join(repoRoot, 'bundle.json')) && existsSync(path.join(repoRoot, 'skills'))
  ? repoRoot
  : corePkgRoot
const bundlePath = path.join(defaultSourceRoot, 'bundle.json')
const skillsSource = defaultSourceRoot

const harness = process.env.NSOLID_HARNESS
const action = process.argv[2] ?? 'install'

const VALID_ACTIONS = ['install', 'uninstall']
if (!VALID_ACTIONS.includes(action)) {
  console.error(`Invalid action: ${action}. Must be: ${VALID_ACTIONS.join(', ')}`)
  process.exit(1)
}

if (!harness) {
  console.error('NSOLID_HARNESS env var is required')
  process.exit(1)
}

// Keep in sync with src/types.ts HARNESS_VALUES
const VALID_HARNESS = ['claude', 'codex', 'opencode', 'antigravity', 'pi']
if (!VALID_HARNESS.includes(harness)) {
  console.error(`Invalid harness: ${harness}. Must be one of: ${VALID_HARNESS.join(', ')}`)
  process.exit(1)
}

const { install, setup, uninstall } = await import('nsolid-plugin')

const PLUGIN_OWNED_HARNESSES = new Set(['claude', 'codex', 'antigravity'])
const PACKAGE_OWNED_SKILL_HARNESSES = new Set(['pi'])
const HARNESS_SPECIFIC_SKILL_HARNESSES = new Set(['opencode'])

try {
  if (action === 'uninstall') {
    const res = await uninstall(harness)
    if (res.errors.length) {
      console.error(res.errors.join('\n'))
      process.exit(1)
    }
    console.log(`N|Solid Plugin skills uninstalled for ${harness}`)
  } else {
    const installer = PLUGIN_OWNED_HARNESSES.has(harness) ? setup : install
    const res = await installer({
      harness,
      bundlePath,
      skillsSource,
      packageOwnedSkills: PACKAGE_OWNED_SKILL_HARNESSES.has(harness),
      harnessSpecificSkills: HARNESS_SPECIFIC_SKILL_HARNESSES.has(harness),
    })
    if (!res.success) {
      console.error(res.errors.join('\n'))
      process.exit(1)
    }
    if (PLUGIN_OWNED_HARNESSES.has(harness)) {
      console.log(`N|Solid Plugin credentials ready for ${harness}`)
    } else if (PACKAGE_OWNED_SKILL_HARNESSES.has(harness)) {
      console.log(`N|Solid Plugin MCP/auth configured for ${harness}; skills are package-owned`)
    } else {
      console.log(`N|Solid Plugin skills installed for ${harness}: ${res.skillsInstalled} skills`)
    }
  }
} catch (err) {
  console.error(err.message)
  process.exit(1)
}
