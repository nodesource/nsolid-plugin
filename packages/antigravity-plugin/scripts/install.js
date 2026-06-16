#!/usr/bin/env node

import { cpSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { install } from '@nodesource/plugin-core'

const __dirname = dirname(fileURLToPath(import.meta.url))
const pluginDir = resolve(__dirname, '..')

const targetDir = join(homedir(), '.gemini', 'config', 'plugins', 'nodesource-nsolid')

console.log(`Installing NodeSource plugin to ${targetDir}...`)
mkdirSync(targetDir, { recursive: true })
cpSync(pluginDir, targetDir, { recursive: true, force: true, dereference: true })

process.env.NSOLID_HARNESS = 'antigravity'

const corePkgRoot = resolve(__dirname, '..', 'node_modules', '@nodesource/plugin-core')
const bundlePath = join(corePkgRoot, 'bundle.json')
const skillsSource = corePkgRoot

const result = await install({ harness: 'antigravity', bundlePath, skillsSource })

if (!result.success) {
  console.error('Install failed:')
  for (const err of result.errors) {
    console.error(`  - ${err}`)
  }
  process.exit(1)
}

console.log(`Installed ${result.skillsInstalled} skill(s) for Antigravity`)
if (result.mcpServersConfigured.length > 0) {
  console.log(`Configured MCP servers: ${result.mcpServersConfigured.join(', ')}`)
}
console.log('Restart Antigravity to load the plugin')
