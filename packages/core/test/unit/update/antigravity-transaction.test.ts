import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { executeAntigravityTransaction, validateStagedPlugin } from '../../../src/update/antigravity-transaction.js'
import type { UpdatePlanItem } from '../../../src/update/types.js'

function agyItem (): UpdatePlanItem {
  return {
    installationId: 'antigravity:native:nsolid-plugin@github',
    target: 'antigravity',
    ownership: 'native-plugin',
    installed: true,
    source: {
      kind: 'antigravity-git',
      url: 'https://github.com/NodeSource/nsolid-plugin.git',
      layout: { kind: 'shared', pluginRoot: '~/.gemini/config/plugins/nsolid-plugin', manifestPath: '~/.gemini/config/import_manifest.json' },
    },
    version: { current: undefined, latest: '1.0.1', status: 'update-available' },
    steps: [],
    rollbackSteps: [],
    requiresConfirmation: true,
  }
}

describe('Antigravity staged plugin validation', () => {
  it('requires the staged bundle version to match the planned version', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'nsolid-plugin-agy-validation-'))
    try {
      mkdirSync(path.join(root, 'skills', 'example'), { recursive: true })
      writeFileSync(path.join(root, 'plugin.json'), JSON.stringify({ name: 'nsolid-plugin' }))
      writeFileSync(path.join(root, 'bundle.json'), JSON.stringify({ version: '1.0.1', skills: [{ name: 'example', path: 'skills/example' }] }))
      writeFileSync(path.join(root, 'skills', 'example', 'SKILL.md'), '# example')
      const manifest = path.join(root, 'import_manifest.json')
      writeFileSync(manifest, JSON.stringify({ imports: [{ name: 'nsolid-plugin' }] }))

      assert.equal(validateStagedPlugin(root, manifest, '1.0.0'), false)
      assert.equal(validateStagedPlugin(root, manifest, '1.0.1'), true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('returns a structured backup failure when the plugin root parent directory is missing', async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'nsolid-plugin-agy-transaction-'))
    const previousHome = process.env.HOME
    const previousUserProfile = process.env.USERPROFILE
    process.env.HOME = home
    process.env.USERPROFILE = home
    try {
      // `~/.gemini/config/plugins` is deliberately absent: the sibling backup
      // parent is missing, which used to escape as a rejected ENOENT promise.
      const result = await executeAntigravityTransaction(agyItem(), {
        run: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }),
      })

      assert.equal(result.success, false)
      assert.equal(result.rollbackAttempted, false)
      assert.equal(result.error?.code, 'ANTIGRAVITY_BACKUP_FAILED')
      assert.equal(existsSync(path.join(home, '.gemini')), false)
    } finally {
      if (previousHome === undefined) delete process.env.HOME
      else process.env.HOME = previousHome
      if (previousUserProfile === undefined) delete process.env.USERPROFILE
      else process.env.USERPROFILE = previousUserProfile
      rmSync(home, { recursive: true, force: true })
    }
  })
})
