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
    assert.match(output, /Claude\/Codex\/Antigravity: install from the GitHub plugin root/, 'help must group Codex with root native plugin harnesses')
    assert.match(output, /setup authenticates and prepares the MCP bridge runtime/, 'help must describe setup as auth + bridge runtime for native plugin harnesses')
    assert.doesNotMatch(output, /setup is auth-only/, 'help must not describe setup as auth-only')
    assert.match(output, /OpenCode: run setup --harness opencode — it authenticates, prepares the MCP bridge runtime, and installs skills \+ MCP config in one step\./, 'help must describe one-step OpenCode setup')
    assert.match(output, /provisions the MCP bridge runtime first, then installs assets/, 'help must describe the install runtime precondition')
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
