#!/usr/bin/env node

import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const corePkgRoot = path.resolve(__dirname, '..')
const bundlePath = path.join(corePkgRoot, 'bundle.json')
const skillsSource = corePkgRoot

const harness = process.env.NSOLID_HARNESS
const action = process.argv[2] ?? 'install'

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

const { install, uninstall } = await import('@nodesource/plugin-core')

try {
  if (action === 'uninstall') {
    const res = await uninstall(harness)
    if (res.errors.length) {
      console.error(res.errors.join('\n'))
      process.exit(1)
    }
    console.log(`NodeSource skills uninstalled for ${harness}`)
  } else {
    const res = await install({ harness, bundlePath, skillsSource })
    if (!res.success) {
      console.error(res.errors.join('\n'))
      process.exit(1)
    }
    console.log(`NodeSource skills installed for ${harness}: ${res.skillsInstalled} skills`)
  }
} catch (err) {
  console.error(err.message)
  process.exit(1)
}
