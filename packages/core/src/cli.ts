#!/usr/bin/env node

import { parseArgs } from 'node:util'
import { createInterface } from 'node:readline/promises'
import path from 'node:path'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { install, setup, uninstall, logout, doctor, restore } from './index.js'
import type { AuthConfirmation, HarnessType } from './types.js'
import { HARNESS_VALUES } from './types.js'
import { formatPluginError } from './errors.js'
import { listConfigBackups } from './utils/backup.js'
import { C, supportsColor } from './utils/format.js'
import { createConsoleProgress, silentProgress } from './utils/progress.js'
const PLUGIN_OWNED_HARNESSES = new Set<HarnessType>(['claude', 'codex', 'antigravity'])
const PACKAGE_OWNED_SKILL_HARNESSES = new Set<HarnessType>(['pi'])
const HARNESS_SPECIFIC_SKILL_HARNESSES = new Set<HarnessType>(['opencode'])

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// At runtime the bin is dist/src/cli.js, so __dirname is <pkgroot>/dist/src.
// bundle.json and skills/ ship at the package root (per package.json "files"),
// not under dist/ — resolve up two levels to reach the package root.
const CORE_PKG_ROOT = path.resolve(__dirname, '..', '..')
const REPO_ROOT = path.resolve(CORE_PKG_ROOT, '..', '..')
const DEFAULT_SOURCE_ROOT = existsSync(path.join(REPO_ROOT, 'bundle.json')) && existsSync(path.join(REPO_ROOT, 'skills'))
  ? REPO_ROOT
  : CORE_PKG_ROOT
const BUNDLE_PATH = path.join(DEFAULT_SOURCE_ROOT, 'bundle.json')

const HARNESS_LABELS: Record<HarnessType, string> = {
  claude: 'Claude Code',
  codex: 'Codex CLI',
  opencode: 'OpenCode',
  antigravity: 'Antigravity',
  pi: 'Pi Agent',
}

function promptActionLabel (command: string): string {
  return command === 'install' ? 'fallback-install/configure' : command
}

function harnessPromptLabel (harness: HarnessType, command: string): string {
  const base = `${HARNESS_LABELS[harness]} (${harness})`
  if (command === 'install' && harness === 'pi') {
    return `${base} — MCP config only; install Pi package for skills`
  }
  return base
}

function promptHarnessChoices (): HarnessType[] {
  return [...HARNESS_VALUES]
}

function printUsage (): void {
  console.log(`Usage: nsolid-plugin <command> [options]

Commands:
  setup      Authenticate with NodeSource (may open a browser)
  install    Install N|Solid Plugin skills/MCP for a harness (fallback direct installer; does not open a browser)
  uninstall  Remove N|Solid Plugin skills for a harness
  logout     Forget your stored NodeSource login (removes credentials only)
  doctor     Check installation health for a harness
  restore    Restore a harness MCP config from the latest backup

Options:
  --harness <harness>    Target harness (required in non-interactive mode): ${HARNESS_VALUES.join(', ')}
  --keep-credentials     Do not remove credentials even if this was the last harness (uninstall only)
  --bundle <path>        Path to bundle.json (default: core package bundle.json)
  --skills-source <path> Path to skills source directory (default: core package root)
  --backup <path>       Restore a specific backup file (restore command only)
  --list                List available backups (restore command only)
  --verbose             Enable detailed logging to stderr
  --json                Output doctor report as JSON (machine-readable)
  --no-color            Disable colored output
  --quiet               Suppress step-by-step progress output (install only)
  --yes                 Skip interactive confirmation prompts
  --staging             Use staging accounts URL for setup (dev/QA only)
  --accounts-url <url>  Explicit origin-only accounts URL override for setup (wins over --staging)
  --help                Show this help message

Distribution notes:
  Claude/Codex/Antigravity: install from the GitHub plugin root; setup is auth-only.
  Pi: use pi install for package-owned skills; CLI install/setup only writes MCP config.
  OpenCode: use setup --harness opencode for auth + direct install; install is fallback/repair.
  Auth: only setup/login may open a browser.`)
}

function isInteractive (): boolean {
  return process.stdin.isTTY === true && process.stderr.isTTY === true
}

function createPrompt () {
  return createInterface({ input: process.stdin, output: process.stderr })
}

async function promptForHarnesses (command: string, multiple: boolean): Promise<HarnessType[]> {
  const stdin = process.stdin
  const wasRaw = stdin.isRaw
  const choices = promptHarnessChoices()
  const selected = new Set<HarnessType>()
  const action = promptActionLabel(command)
  let cursor = 0
  let renderedLines = 0
  let message = ''

  const render = () => {
    if (renderedLines > 0) {
      process.stderr.write(`\x1b[${renderedLines}A\x1b[0J`)
    } else {
      process.stderr.write('\x1b[?25l')
    }

    const lines = [
      multiple
        ? `Which harnesses do you want to ${action}?`
        : `Which harness do you want to ${action}?`,
      '',
      ...choices.map((value, index) => {
        const pointer = index === cursor ? '❯' : ' '
        const marker = selected.has(value) ? '●' : '○'
        return `  ${pointer} ${marker} ${harnessPromptLabel(value, command)}`
      }),
      ...(command === 'install'
        ? ['', 'Pi is package-owned: use `pi install ...` for skills; this installer only writes MCP config.']
        : []),
      ...(message ? ['', message] : []),
      '',
      multiple
        ? '↑/↓ move   Space toggle   a select all   Enter continue   q cancel'
        : '↑/↓ move   Space select   Enter continue   q cancel',
    ]
    renderedLines = lines.length
    process.stderr.write(`${lines.join('\n')}\n`)
  }

  const finish = () => {
    if (stdin.isTTY) stdin.setRawMode(wasRaw)
    stdin.pause()
    stdin.removeAllListeners('data')
    process.stderr.write('\x1b[?25h')
  }

  return await new Promise((resolve, reject) => {
    if (stdin.isTTY) stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding('utf8')
    render()

    stdin.on('data', (key: string) => {
      try {
        if (key === '\u0003' || key === 'q' || key === 'Q' || key === '\x1B') {
          finish()
          reject(new Error('Cancelled by user.'))
          return
        }
        if (key === '\x1B[A' || key === 'k') {
          cursor = (cursor - 1 + choices.length) % choices.length
          message = ''
          render()
          return
        }
        if (key === '\x1B[B' || key === 'j') {
          cursor = (cursor + 1) % choices.length
          message = ''
          render()
          return
        }
        if (key === ' ') {
          const value = choices[cursor]
          if (multiple) {
            if (selected.has(value)) selected.delete(value)
            else selected.add(value)
          } else {
            selected.clear()
            selected.add(value)
          }
          message = ''
          render()
          return
        }
        if (multiple && (key === 'a' || key === 'A')) {
          if (selected.size === choices.length) selected.clear()
          else choices.forEach((value) => selected.add(value))
          render()
          return
        }
        if (key === '\r' || key === '\n') {
          if (selected.size === 0) {
            message = multiple
              ? 'Select at least one harness with Space before continuing.'
              : 'Select a harness with Space before continuing.'
            render()
            return
          }
          finish()
          const result = choices.filter((value) => selected.has(value))
          process.stderr.write(`\nSelected: ${result.map((value) => HARNESS_LABELS[value]).join(', ')}\n\n`)
          resolve(result)
        }
      } catch (err) {
        finish()
        reject(err)
      }
    })
  })
}

async function confirmBrowserAuth ({ harness, accountsUrl }: Parameters<AuthConfirmation>[0], color = supportsColor(process.stderr)): Promise<void> {
  const rl = createPrompt()
  const title = color ? C.green('NodeSource authentication') : 'NodeSource authentication'
  const dim = (s: string) => color ? C.dim(s) : s
  try {
    console.error('')
    console.error(title)
    console.error(dim('─'.repeat(27)))
    console.error(`• A browser will open at ${new URL(accountsUrl).origin}.`)
    console.error(`• Local credentials will be stored for ${HARNESS_LABELS[harness]} MCP access.`)
    console.error('• The CLI never handles your password.')
    console.error('')
    const answer = (await rl.question('Continue and open browser? [Y/n]: ')).trim().toLowerCase()
    if (answer === 'n' || answer === 'no') {
      throw new Error('Authentication cancelled by user.')
    }
  } finally {
    rl.close()
  }
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
      staging: { type: 'boolean' },
      'accounts-url': { type: 'string' },
      'keep-credentials': { type: 'boolean' },
      quiet: { type: 'boolean' },
      yes: { type: 'boolean' },
      help: { type: 'boolean', short: 'H' },
    },
  })

  if (values.help || positionals.length === 0) {
    printUsage()
    process.exit(values.help ? 0 : 1)
  }

  const command = positionals[0]
  const harness = values.harness as HarnessType | undefined

  const resolveHarnesses = async (multiple: boolean): Promise<HarnessType[]> => {
    if (harness && HARNESS_VALUES.includes(harness)) return [harness]
    if (!harness && isInteractive() && values.yes !== true) return promptForHarnesses(command, multiple)
    console.error(`Error: --harness is required and must be one of: ${HARNESS_VALUES.join(', ')}`)
    process.exit(1)
  }

  const requireHarness = async (): Promise<HarnessType> => (await resolveHarnesses(false))[0]

  const authConfirmation: AuthConfirmation | undefined = isInteractive() && values.yes !== true
    ? (context) => confirmBrowserAuth(context, values['no-color'] !== true && supportsColor(process.stderr))
    : undefined

  const bundlePath = values.bundle ? path.resolve(values.bundle) : BUNDLE_PATH
  const skillsSource = values['skills-source']
    ? path.resolve(values['skills-source'])
    : DEFAULT_SOURCE_ROOT

  const commonOptions = { verbose: values.verbose === true }
  const color = values['no-color'] !== true && supportsColor()
  const paint = {
    dim: (s: string) => color ? C.dim(s) : s,
    green: (s: string) => color ? C.green(s) : s,
    yellow: (s: string) => color ? C.yellow(s) : s,
  }

  switch (command) {
    case 'setup': {
      if (values.staging === true) {
        process.env.NSOLID_STAGING = '1'
      }
      if (values['accounts-url']) {
        process.env.NSOLID_ACCOUNTS_URL = values['accounts-url']
      }
      const setupHarnesses = await resolveHarnesses(true)
      let failures = 0

      for (let i = 0; i < setupHarnesses.length; i++) {
        const setupHarness = setupHarnesses[i]
        if (i > 0) console.log('')

        const result = await setup({
          harness: setupHarness,
          bundlePath,
          skillsSource,
          ...commonOptions,
          progress: values.quiet === true ? silentProgress : createConsoleProgress({ color }),
          confirmAuth: authConfirmation,
          packageOwnedSkills: PACKAGE_OWNED_SKILL_HARNESSES.has(setupHarness),
          harnessSpecificSkills: HARNESS_SPECIFIC_SKILL_HARNESSES.has(setupHarness),
        })

        if (!result.success) {
          failures++
          console.error(`Setup failed for ${setupHarness}:`)
          for (const err of result.errors) {
            console.error(`  - ${err}`)
          }
          continue
        }

        const verb = result.hadToAuthenticate ? 'Authenticated' : 'Credentials ready'
        console.log(`${paint.green('✓')} ${HARNESS_LABELS[setupHarness]} — ${verb}.`)
      }

      if (failures > 0) process.exit(1)
      break
    }
    case 'install': {
      const installHarnesses = await resolveHarnesses(true)
      let failures = 0
      const pluginOwnedReady = new Set<HarnessType>()

      for (let i = 0; i < installHarnesses.length; i++) {
        const installHarness = installHarnesses[i]
        if (i > 0) console.log('') // visual separation between harnesses

        const result = await install({
          harness: installHarness,
          bundlePath,
          skillsSource,
          ...commonOptions,
          progress: values.quiet === true ? silentProgress : createConsoleProgress({ color }),
          packageOwnedSkills: PACKAGE_OWNED_SKILL_HARNESSES.has(installHarness),
          harnessSpecificSkills: HARNESS_SPECIFIC_SKILL_HARNESSES.has(installHarness),
        })
        if (!result.success) {
          failures++
          console.error(`Install failed for ${installHarness}:`)
          for (const err of result.errors) {
            console.error(`  - ${err}`)
          }
          continue
        }

        if (PLUGIN_OWNED_HARNESSES.has(installHarness)) {
          pluginOwnedReady.add(installHarness)
          const authNote = result.hadToAuthenticate
            ? `Authentication required — run: nsolid-plugin setup --harness ${installHarness}`
            : 'Credentials present'
          console.log(`${paint.green('✓')} ${HARNESS_LABELS[installHarness]} — fallback direct install. ${authNote}`)
          if (installHarness === 'claude') {
            console.log(`  ${paint.dim('Native plugin:')} ${paint.yellow('claude plugin marketplace add NodeSource/nsolid-plugin && claude plugin install nsolid-plugin@nodesource')}`)
          } else if (installHarness === 'codex') {
            console.log(`  ${paint.dim('Native plugin:')} ${paint.yellow('codex plugin marketplace add NodeSource/nsolid-plugin && codex plugin add nsolid-plugin@nodesource')}`)
          } else if (installHarness === 'antigravity') {
            console.log(`  ${paint.dim('Native plugin:')} ${paint.yellow('agy plugin install https://github.com/NodeSource/nsolid-plugin.git')}`)
          }
          continue
        }

        if (installHarness === 'pi') {
          const piStatus = result.hadToAuthenticate
            ? 'MCP config staged; run setup to authenticate'
            : 'MCP configured'
          console.log(`${paint.green('✓')} ${HARNESS_LABELS[installHarness]} — ${piStatus}; skills are installed by the Pi package, not this command.`)
          if (result.mcpServersConfigured.length > 0) {
            const { getAdapter } = await import('./harnesses/index.js')
            const fmt = (s: string) => color ? `\x1b[33m${s}\x1b[0m` : s
            console.log(`  ${paint.dim('MCP servers:')} ${result.mcpServersConfigured.join(', ')}`)
            console.log(fmt('  ⚠ Pi needs an MCP adapter to use these servers:'))
            console.log(fmt('      pi install npm:pi-mcp-adapter'))
            console.log(fmt(`    MCP config written to ${getAdapter('pi').getMcpConfigPath()}`))
            console.log(fmt('    Install/reload the Pi package to load package-owned skills:'))
            console.log(fmt('      pi install npm:nsolid-pi-plugin'))
            console.log(fmt('      (local QA: pi install ./packages/pi-plugin --no-approve, then /reload)'))
          }
          continue
        }

        // CLI-only harnesses: OpenCode
        const { getAdapter } = await import('./harnesses/index.js')
        const adapter = getAdapter(installHarness)
        console.log(`${paint.green('✓')} ${HARNESS_LABELS[installHarness]} — installed ${result.skillsInstalled} skill(s) + ${result.mcpServersConfigured.length} MCP server(s).`)
        console.log(`  ${paint.dim('Skills:')} ${adapter.getSkillsPath()}`)
        console.log(`  ${paint.dim('MCP config:')} ${adapter.getMcpConfigPath()}`)
        console.log(`  ${paint.dim('MCP servers:')} ${result.mcpServersConfigured.join(', ')}`)
        if (result.hadToAuthenticate) {
          console.log(`  ${paint.yellow(`⚠ Authentication required for MCP servers — run: nsolid-plugin setup --harness ${installHarness}`)}`)
        }
      }

      if (pluginOwnedReady.size > 0) {
        console.log('')
        console.log(paint.dim('Native plugin packages provide skills/MCPs; the fallback installer only configures the local harness.'))
      }
      if (failures > 0) process.exit(1)
      break
    }
    case 'uninstall': {
      const uninstallHarnesses = await resolveHarnesses(true)
      let failures = 0
      let credentialsPurged = false
      for (const uninstallHarness of uninstallHarnesses) {
        const result = await uninstall(uninstallHarness, {
          bundlePath: values.bundle,
          ...commonOptions,
          keepCredentials: values['keep-credentials'] === true,
        })
        if (result.errors.length > 0) {
          failures++
          console.error(`Uninstall completed with errors for ${uninstallHarness}:`)
          for (const err of result.errors) {
            console.error(`  - ${err}`)
          }
          continue
        }
        console.log(`Uninstalled N|Solid Plugin skills for ${uninstallHarness}`)
        credentialsPurged = credentialsPurged || result.credentialsPurged === true
      }
      if (credentialsPurged) {
        const fmt = (s: string) => color ? `\x1b[33m${s}\x1b[0m` : s
        console.log(fmt('No NodeSource installs remain — removed stored credentials.'))
        console.log(fmt('  Re-run any install to authenticate again.'))
      }
      if (failures > 0) process.exit(1)
      break
    }
    case 'logout': {
      const result = await logout()
      if (result.removed) {
        console.log(`Removed credentials at ${result.path}`)
      } else {
        console.log('No credentials found — nothing to log out.')
      }
      break
    }
    case 'restore': {
      const h = await requireHarness()
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
      const doctorHarness = await requireHarness()
      const report = await doctor(doctorHarness, bundlePath, commonOptions)
      if (values.json === true) {
        console.log(JSON.stringify(report, null, 2))
      } else {
        const { formatDoctorReport } = await import('./utils/format.js')
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
