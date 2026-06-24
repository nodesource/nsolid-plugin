import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CLI_PATH = join(__dirname, '..', '..', 'src', 'cli.ts')

describe('CLI help', () => {
  it('describes Codex as a root native-plugin harness with fallback install only', () => {
    const result = spawnSync(process.execPath, ['--import', 'tsx/esm', CLI_PATH, '--help'], {
      encoding: 'utf-8',
    })

    assert.strictEqual(result.status, 0, `CLI --help failed: ${result.stderr}`)
    const output = result.stdout
    assert.match(output, /Claude\/Codex\/Antigravity: install from the GitHub plugin root/, 'help must group Codex with root native plugin harnesses')
    assert.match(output, /setup is auth-only/, 'help must identify setup as auth-only for native plugin harnesses')
    assert.doesNotMatch(output, /OpenCode\/Codex/, 'help must not list Codex as a user-level skill harness')
  })
})
