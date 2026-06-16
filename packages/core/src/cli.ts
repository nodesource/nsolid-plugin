#!/usr/bin/env node

import { parseArgs } from 'node:util'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { install, uninstall, doctor } from './index.js'
import type { HarnessType } from './types.js'
import { HARNESS_VALUES } from './types.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// At runtime the bin is dist/src/cli.js, so __dirname is <pkgroot>/dist/src.
// bundle.json and skills/ ship at the package root (per package.json "files"),
// not under dist/ — resolve up two levels to reach the package root.
const CORE_PKG_ROOT = path.resolve(__dirname, '..', '..')
const BUNDLE_PATH = path.join(CORE_PKG_ROOT, 'bundle.json')

function printUsage (): void {
  console.log(`Usage: nsolid-plugin <command> [options]

Commands:
  install    Install NodeSource skills for a harness
  uninstall  Remove NodeSource skills for a harness
  doctor     Check installation health for a harness

Options:
  --harness <harness>   Target harness (required): ${HARNESS_VALUES.join(', ')}
  --bundle <path>       Path to bundle.json (default: core package bundle.json)
  --skills-source <path> Path to skills source directory (default: core package root)
  --help                Show this help message`)
}

async function main (): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      harness: { type: 'string', short: 'h' },
      bundle: { type: 'string', short: 'b' },
      'skills-source': { type: 'string', short: 's' },
      help: { type: 'boolean', short: 'H' },
    },
  })

  if (values.help || positionals.length === 0) {
    printUsage()
    process.exit(values.help ? 0 : 1)
  }

  const command = positionals[0]
  const harness = values.harness as HarnessType | undefined

  if (!harness || !HARNESS_VALUES.includes(harness)) {
    console.error(`Error: --harness is required and must be one of: ${HARNESS_VALUES.join(', ')}`)
    process.exit(1)
  }

  const bundlePath = values.bundle ? path.resolve(values.bundle) : BUNDLE_PATH
  const skillsSource = values['skills-source']
    ? path.resolve(values['skills-source'])
    : CORE_PKG_ROOT

  switch (command) {
    case 'install': {
      const result = await install({ harness, bundlePath, skillsSource })
      if (!result.success) {
        console.error('Install failed:')
        for (const err of result.errors) {
          console.error(`  - ${err}`)
        }
        process.exit(1)
      }
      console.log(`Installed ${result.skillsInstalled} skill(s) for ${harness}`)
      if (result.mcpServersConfigured.length > 0) {
        console.log(`Configured MCP servers: ${result.mcpServersConfigured.join(', ')}`)
      }
      break
    }
    case 'uninstall': {
      const result = await uninstall(harness)
      if (result.errors.length > 0) {
        console.error('Uninstall completed with errors:')
        for (const err of result.errors) {
          console.error(`  - ${err}`)
        }
        process.exit(1)
      }
      console.log(`Uninstalled NodeSource skills for ${harness}`)
      break
    }
    case 'doctor': {
      const report = await doctor(harness, bundlePath)
      console.log(JSON.stringify(report, null, 2))
      if (!report.healthy) {
        process.exit(1)
      }
      break
    }
    default:
      console.error(`Unknown command: ${command}`)
      printUsage()
      process.exit(1)
  }
}

main().catch((err) => {
  console.error(err.message)
  process.exit(1)
})
