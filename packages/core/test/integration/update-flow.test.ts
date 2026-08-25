import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkUpdates, executeUpdatePlan, planUpdates } from '../../src/update/index.js'

let home: string
let project: string
let previousHome: string | undefined
let previousUserProfile: string | undefined
let previousCodexConfigPath: string | undefined
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), 'nsolid-plugin-update-home-'))
  project = mkdtempSync(path.join(os.tmpdir(), 'nsolid-plugin-update-project-'))
  previousHome = process.env.HOME
  previousUserProfile = process.env.USERPROFILE
  previousCodexConfigPath = process.env.CODEX_CONFIG_PATH
  process.env.HOME = home
  process.env.USERPROFILE = home
  delete process.env.CODEX_CONFIG_PATH
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  rmSync(project, { recursive: true, force: true })
  if (previousHome === undefined) delete process.env.HOME
  else process.env.HOME = previousHome
  if (previousUserProfile === undefined) delete process.env.USERPROFILE
  else process.env.USERPROFILE = previousUserProfile
  if (previousCodexConfigPath === undefined) delete process.env.CODEX_CONFIG_PATH
  else process.env.CODEX_CONFIG_PATH = previousCodexConfigPath
})

function registryFetch (version: string): typeof fetch {
  return async () => new Response(JSON.stringify({ 'dist-tags': { latest: version } }), { status: 200 })
}

describe('update flow coordinator', () => {
  it('checks the CLI without probing a package manager', async () => {
    let calls = 0
    const commandRunner = {
      run: async () => {
        calls++
        throw new Error('read-only check must not probe npm or pnpm')
      },
    }
    const summary = await checkUpdates({
      packageRoot,
      cwd: project,
      fetchImpl: registryFetch('999.0.0'),
      commandRunner,
    })

    const cli = summary.results.find((result) => result.installationId === 'cli:global')
    assert.equal(cli?.status, 'update-available')
    assert.equal(calls, 0)
  })

  it('does not probe a package manager for a CLI newer than the registry', async () => {
    let calls = 0
    const commandRunner = {
      run: async () => {
        calls++
        throw new Error('newer-than-registry must not probe npm or pnpm')
      },
    }
    const plan = await planUpdates({
      packageRoot,
      cwd: project,
      fetchImpl: registryFetch('0.0.1'),
      commandRunner,
    })

    const cli = plan.items.find((item) => item.installationId === 'cli:global')
    assert.equal(cli?.version.status, 'newer-than-registry')
    assert.equal(cli?.requiresConfirmation, false)
    assert.equal(calls, 0)
  })

  it('emits a non-mutating not-installed item for an absent requested harness', async () => {
    const calls: string[] = []
    const commandRunner = {
      run: async (spec: { executable: string }) => {
        calls.push(spec.executable)
        return { exitCode: 1, stdout: '', stderr: '', timedOut: false }
      },
    }
    const summary = await checkUpdates({
      harness: 'pi',
      cwd: project,
      fetchImpl: registryFetch('1.0.2'),
      commandRunner,
    })

    assert.equal(summary.checkOnly, true)
    assert.equal(summary.results[0]?.status, 'not-installed')
    assert.equal(summary.success, true)
    assert.ok(!calls.includes('pi'))
  })

  it('keeps update plans immutable and does not execute check plans', async () => {
    const commandRunner = {
      run: async () => {
        throw new Error('check mode must not execute')
      },
    }
    const plan = await planUpdates({
      harness: 'pi',
      cwd: project,
      check: true,
      fetchImpl: registryFetch('1.0.2'),
      commandRunner,
    })
    const summary = await executeUpdatePlan(plan, { check: true, commandRunner })
    assert.equal(summary.checkOnly, true)
    assert.equal(plan.items[0]?.steps.length, 0)
  })
})
