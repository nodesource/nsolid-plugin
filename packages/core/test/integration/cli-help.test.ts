import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CLI_PATH = join(__dirname, '..', '..', 'src', 'cli.ts')

describe('CLI help', () => {
  it('describes native plugin harnesses and the one-step OpenCode onboarding', () => {
    const result = spawnSync(process.execPath, ['--import', 'tsx/esm', CLI_PATH, '--help'], {
      encoding: 'utf-8',
    })

    assert.strictEqual(result.status, 0, `CLI --help failed: ${result.stderr}`)
    const output = result.stdout
    assert.match(output, /Claude\/Codex\/Antigravity: install from the GitHub plugin root, then run setup\./, 'help must group Codex with root native plugin harnesses')
    assert.match(output, /setup\s+Authenticate with NodeSource and prepare the MCP bridge/, 'help must describe setup as auth + bridge runtime for native plugin harnesses')
    assert.doesNotMatch(output, /setup is auth-only/, 'help must not describe setup as auth-only')
    assert.match(output, /OpenCode: setup --harness opencode installs everything in one step\./, 'help must describe one-step OpenCode setup')
    assert.match(output, /install\s+Install skills\/MCP for a harness without opening a browser/, 'help must describe install as a non-browser installer')
    assert.doesNotMatch(output, /OpenCode\/Codex/, 'help must not list Codex as a user-level skill harness')
  })

  it('lists the switch-org command', () => {
    const result = spawnSync(process.execPath, ['--import', 'tsx/esm', CLI_PATH, '--help'], {
      encoding: 'utf-8',
    })

    assert.strictEqual(result.status, 0, `CLI --help failed: ${result.stderr}`)
    assert.match(result.stdout, /switch-org\s+Re-authenticate to switch NodeSource organizations/, 'help must list switch-org command')
  })

  it('documents the switch-org re-bake requirement and scopes its options', () => {
    const result = spawnSync(process.execPath, ['--import', 'tsx/esm', CLI_PATH, '--help'], {
      encoding: 'utf-8',
    })

    assert.strictEqual(result.status, 0, `CLI --help failed: ${result.stderr}`)
    assert.match(
      result.stdout,
      /After switch-org, re-run setup\/install per harness to re-bake the new org token\./,
      'help must state direct configs need a later setup/install after switch-org'
    )
    assert.match(result.stdout, /--accounts-url <url>\s+Accounts URL override for setup\/switch-org/, 'help must scope --accounts-url to setup/switch-org')
    assert.match(result.stdout, /--quiet\s+Suppress step-by-step progress \(setup\/install\/switch-org\)/, 'help must scope --quiet to setup/install/switch-org')
    assert.match(result.stdout, /--verbose\s+Detailed logging to stderr; shows the full technical update plan/, 'help must offer the full technical plan via --verbose')
  })
})
