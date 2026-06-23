#!/usr/bin/env node

import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const pluginDir = resolve(__dirname, '..')
const targetDir = join(homedir(), '.gemini', 'antigravity-cli', 'plugins', 'nsolid-plugin')

const PLUGIN_OWNED_ASSETS = ['plugin.json', 'mcp_config.json', 'scripts', 'skills']

console.log(`Installing NodeSource plugin to ${targetDir}...`)

// Clean and recreate the target plugin directory so stale assets are removed.
if (existsSync(targetDir)) {
  for (const entry of readdirSync(targetDir)) {
    rmSync(join(targetDir, entry), { recursive: true, force: true })
  }
}
mkdirSync(targetDir, { recursive: true })

// Copy plugin-owned assets from this package.
for (const asset of PLUGIN_OWNED_ASSETS) {
  const src = join(pluginDir, asset)
  const dst = join(targetDir, asset)
  if (!existsSync(src)) {
    console.error(`  missing required asset: ${asset}`)
    process.exit(1)
  }
  cpSync(src, dst, { recursive: true, dereference: true })
  console.log(`  copied ${asset}`)
}

// Skills are copied from this self-contained generated artifact. Do not resolve
// or copy from @nodesource/plugin-core here; native install must be offline and
// non-interactive apart from dependency installation.

// Install runtime dependencies so the MCP wrapper can resolve mcp-remote after
// the plugin is installed in Antigravity's plugin directory. mcp-remote 0.1.38
// imports a few packages from its dist bundle that are not declared as runtime
// dependencies, so install the package plus explicit runtime companions into a
// regular node_modules tree instead of relying on pnpm workspace symlinks.
installMcpRuntimeDependencies(pluginDir, targetDir)

console.log('')
console.log(`Installed NodeSource plugin to ${targetDir}`)
console.log('Restart Antigravity to load the plugin-owned skills and MCPs.')
console.log('')
console.log('To authenticate with NodeSource, run:')
console.log('  nsolid-plugin setup')

function installMcpRuntimeDependencies (pluginDir, targetDir) {
  const pkg = JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8'))
  const runtimePackages = [
    'mcp-remote',
    'express',
    'open',
    'strict-url-sanitise',
    'undici',
    '@modelcontextprotocol/sdk',
    'ajv',
    'ajv-formats',
  ]

  const installSpecs = []
  for (const name of runtimePackages) {
    const version = pkg.dependencies?.[name]
    if (!version) {
      console.warn(`  ${name} not declared in package.json; wrapper may not resolve dependencies`)
      continue
    }
    installSpecs.push(`${name}@${version}`)
  }

  const result = spawnSync(
    'npm',
    ['install', '--no-package-lock', '--no-audit', '--no-fund', ...installSpecs],
    { cwd: targetDir, encoding: 'utf-8' }
  )

  if (result.status !== 0) {
    console.error('  npm install MCP runtime dependencies failed')
    if (result.stderr) console.error(result.stderr.trim())
    process.exit(1)
  }

  console.log('  installed MCP runtime dependencies')
}

