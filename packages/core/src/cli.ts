#!/usr/bin/env node

import { parseArgs } from 'node:util'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { install, uninstall, doctor, restore } from './index.js'
import type { HarnessType } from './types.js'
import { HARNESS_VALUES } from './types.js'
import { formatPluginError } from './errors.js'
import { listConfigBackups } from './utils/backup.js'

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
  restore    Restore a harness MCP config from the latest backup

Options:
  --harness <harness>   Target harness (required): ${HARNESS_VALUES.join(', ')}
  --bundle <path>       Path to bundle.json (default: core package bundle.json)
  --skills-source <path> Path to skills source directory (default: core package root)
  --backup <path>       Restore a specific backup file (restore command only)
  --list                List available backups (restore command only)
  --verbose             Enable detailed logging to stderr
  --json                Output doctor report as JSON (machine-readable)
  --no-color            Disable colored output
  --help                Show this help message`)
}

async function main (): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      harness: { type: 'string', short: 'h' },
      bundle: { type: 'string', short: 'b' },
      'skills-source': { type: 'string', short: 's' },
      backup: { type: 'string' },
      list: { type: 'boolean' },
      verbose: { type: 'boolean' },
      json: { type: 'boolean' },
      'no-color': { type: 'boolean' },
      help: { type: 'boolean', short: 'H' },
    },
  })

  if (values.help || positionals.length === 0) {
    printUsage()
    process.exit(values.help ? 0 : 1)
  }

  const command = positionals[0]
  const harness = values.harness as HarnessType | undefined

  const requireHarness = () => {
    if (!harness || !HARNESS_VALUES.includes(harness)) {
      console.error(`Error: --harness is required and must be one of: ${HARNESS_VALUES.join(', ')}`)
      process.exit(1)
    }
    return harness
  }

  const bundlePath = values.bundle ? path.resolve(values.bundle) : BUNDLE_PATH
  const skillsSource = values['skills-source']
    ? path.resolve(values['skills-source'])
    : CORE_PKG_ROOT

  const commonOptions = { verbose: values.verbose === true }

  switch (command) {
    case 'install': {
      const result = await install({ harness: requireHarness(), bundlePath, skillsSource, ...commonOptions })
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
      if (harness === 'pi' && result.mcpServersConfigured.length > 0) {
        const { supportsColor } = await import('./utils/format.js')
        const { getAdapter } = await import('./harnesses/index.js')
        const color = values['no-color'] !== true && supportsColor()
        const fmt = (s: string) => color ? `\x1b[33m${s}\x1b[0m` : s
        console.log(fmt('⚠ Pi does not support MCP natively. To use these servers, install an MCP adapter:'))
        console.log(fmt('    pi install npm:pi-mcp-adapter'))
        console.log(fmt('    (alt: @0xkobold/pi-mcp — needs separate ~/.0xkobold/mcp.json setup)'))
        console.log(fmt(`  MCP config written to ${getAdapter('pi').getMcpConfigPath()}`))
      }
      break
    }
    case 'uninstall': {
      const result = await uninstall(requireHarness(), { bundlePath: values.bundle, ...commonOptions })
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
    case 'restore': {
      const h = requireHarness()
      if (values.list) {
        const backups = listConfigBackups(h)
        if (backups.length === 0) {
          console.log(`No backups found for ${h}`)
        } else {
          console.log(`Backups for ${h}:`)
          for (const b of backups) {
            console.log(`  ${b.createdAt}  ${b.backupPath}  -> ${b.originalPath}`)
          }
        }
        break
      }
      const entry = await restore(h, { backupPath: values.backup, ...commonOptions })
      console.log(`Restored ${h} config from ${entry.backupPath}`)
      console.log(`  -> ${entry.originalPath}`)
      break
    }
    case 'doctor': {
      const doctorHarness = requireHarness()
      const report = await doctor(doctorHarness, bundlePath, commonOptions)
      if (values.json === true) {
        console.log(JSON.stringify(report, null, 2))
      } else {
        const { formatDoctorReport, supportsColor } = await import('./utils/format.js')
        const color = values['no-color'] !== true && supportsColor()
        console.log(formatDoctorReport(report, doctorHarness, color))
      }
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
  console.error(formatPluginError(err))
  process.exit(1)
})
