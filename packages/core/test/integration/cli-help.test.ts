import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CLI_PATH = join(__dirname, '..', '..', 'src', 'cli.ts')

describe('CLI help', () => {
  it('describes native plugin harnesses and the OpenCode setup/install split', () => {
    const result = spawnSync(process.execPath, ['--import', 'tsx/esm', CLI_PATH, '--help'], {
      encoding: 'utf-8',
    })

    assert.strictEqual(result.status, 0, `CLI --help failed: ${result.stderr}`)
    const output = result.stdout
    assert.match(output, /Claude\/Codex\/Antigravity: install from the GitHub plugin root/, 'help must group Codex with root native plugin harnesses')
    assert.match(output, /setup is auth-only/, 'help must identify setup as auth-only for native plugin harnesses')
    assert.match(output, /OpenCode: setup --harness opencode authenticates AND writes its skills\/MCP config/, 'help must describe OpenCode setup as one-step direct config')
    assert.doesNotMatch(output, /OpenCode\/Codex/, 'help must not list Codex as a user-level skill harness')
  })

  it('lists the switch-org command', () => {
    const result = spawnSync(process.execPath, ['--import', 'tsx/esm', CLI_PATH, '--help'], {
      encoding: 'utf-8',
    })

    assert.strictEqual(result.status, 0, `CLI --help failed: ${result.stderr}`)
    assert.match(result.stdout, /switch-org\s+Force re-authentication to switch NodeSource organizations/, 'help must list switch-org command')
  })

  it('documents that switch-org refreshes the selected direct-config harness and notes other direct configs need setup/install', () => {
    const result = spawnSync(process.execPath, ['--import', 'tsx/esm', CLI_PATH, '--help'], {
      encoding: 'utf-8',
    })

    assert.strictEqual(result.status, 0, `CLI --help failed: ${result.stderr}`)
    assert.match(
      result.stdout,
      /After switch-org, a direct-config harness passed to --harness \(OpenCode, Pi, fallback CLI installs\) has its MCP config refreshed on the spot/,
      'help must state the selected direct-config harness is refreshed immediately'
    )
    assert.match(
      result.stdout,
      /and other direct-config harnesses need a later setup\/install/,
      'help must state other direct configs need a later setup/install'
    )
    assert.match(result.stdout, /--accounts-url <url>\s+Explicit origin-only accounts URL override for setup\/switch-org/, 'help must scope --accounts-url to setup/switch-org')
    assert.match(result.stdout, /--quiet\s+Suppress step-by-step progress output \(setup\/install\/switch-org\)/, 'help must scope --quiet to setup/install/switch-org')
  })
})
