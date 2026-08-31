import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { executeAntigravityTransaction, preservesUnrelatedManifestBytes, validateStagedPlugin } from '../../../src/update/antigravity-transaction.js'
import { nativePayloadDigest } from '../../../src/update/native-evidence.js'
import { readdirSync } from 'node:fs'
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
      const digest = nativePayloadDigest(root)

      assert.equal(validateStagedPlugin(root, manifest, '1.0.0'), false)
      assert.equal(validateStagedPlugin(root, manifest, '1.0.1', digest), true)
      writeFileSync(path.join(root, 'skills', 'example', 'SKILL.md'), '# substituted')
      assert.equal(validateStagedPlugin(root, manifest, '1.0.1', digest), false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('requires unrelated manifest imports to survive plugin replacement byte-for-byte', () => {
    // Array form: an in-place splice of only the owned entry keeps every
    // outside byte; dropping the sibling import removes foreign bytes.
    const before = JSON.stringify({ imports: [{ name: 'unrelated-plugin', path: '/keep' }, { name: 'nsolid-plugin' }] })
    const spliced = before.replace('{"name":"nsolid-plugin"}', '{"name":"nsolid-plugin","path":"/v2"}')
    const reordered = JSON.stringify({ imports: [{ name: 'nsolid-plugin' }, { name: 'unrelated-plugin', path: '/keep' }] })
    const dropped = JSON.stringify({ imports: [{ name: 'nsolid-plugin' }] })

    assert.equal(preservesUnrelatedManifestBytes(before, spliced), true)
    // Reordering moves foreign bytes around the owned node: rejected.
    assert.equal(preservesUnrelatedManifestBytes(before, reordered), false)
    assert.equal(preservesUnrelatedManifestBytes(before, dropped), false)
  })

  it('preserves the my-nsolid-plugin-helper sibling import by exact identity', () => {
    const before = JSON.stringify({
      imports: {
        'my-nsolid-plugin-helper': { path: '/keep-helper' },
        'nsolid-plugin': { name: 'nsolid-plugin', path: '/plugin' },
      },
    })
    const after = JSON.stringify({
      imports: {
        'my-nsolid-plugin-helper': { path: '/keep-helper' },
        'nsolid-plugin': { name: 'nsolid-plugin', path: '/plugin-v2' },
      },
    })
    assert.equal(preservesUnrelatedManifestBytes(before, after), true)

    const helperRewritten = JSON.stringify({
      imports: {
        'my-nsolid-plugin-helper': { path: '/helper-rewritten' },
        'nsolid-plugin': { name: 'nsolid-plugin', path: '/plugin-v2' },
      },
    })
    assert.equal(preservesUnrelatedManifestBytes(before, helperRewritten), false)
  })

  it('fails when formatting, CRLF endings, or comments change outside the owned node', () => {
    const before = '{\n  // user comment\n  "imports": {\n    "other": {"path": "/keep"},\n    "nsolid-plugin": {"name": "nsolid-plugin"}\n  }\n}\n'
    // Only the owned node's bytes change: comments and formatting survive.
    const spliced = '{\n  // user comment\n  "imports": {\n    "other": {"path": "/keep"},\n    "nsolid-plugin": {"name": "nsolid-plugin", "path": "/v2"}\n  }\n}\n'
    assert.equal(preservesUnrelatedManifestBytes(before, spliced), true)

    // agy rewrote the whole file with different formatting: foreign bytes changed.
    const reformatted = '{"imports": {"other": {"path": "/keep"}, "nsolid-plugin": {"name": "nsolid-plugin", "path": "/v2"}}}\n'
    assert.equal(preservesUnrelatedManifestBytes(before, reformatted), false)

    const crlfBefore = before.replace(/\n/g, '\r\n')
    const crlfAfter = spliced.replace(/\n/g, '\r\n')
    assert.equal(preservesUnrelatedManifestBytes(crlfBefore, crlfAfter), true)
    assert.equal(preservesUnrelatedManifestBytes(crlfBefore, spliced), false)
  })

  it('rejects any mutation when the original manifest has no owned import node', () => {
    const before = '{"imports": {"other": {"path": "/keep"}}}\n'
    const after = '{"imports": {"other": {"path": "/keep"}, "nsolid-plugin": {"name": "nsolid-plugin"}}}\n'
    assert.equal(preservesUnrelatedManifestBytes(before, after), false)
    assert.equal(preservesUnrelatedManifestBytes(before, before), true)
  })

  describe('transaction backup preservation', () => {
    function setupInstalledFixture (): { home: string; pluginRoot: string; manifestPath: string; previousHome: string | undefined; previousUserProfile: string | undefined } {
      const home = mkdtempSync(path.join(os.tmpdir(), 'nsolid-plugin-agy-installed-'))
      const previousHome = process.env.HOME
      const previousUserProfile = process.env.USERPROFILE
      process.env.HOME = home
      process.env.USERPROFILE = home
      const pluginRoot = path.join(home, '.gemini', 'config', 'plugins', 'nsolid-plugin')
      const manifestPath = path.join(home, '.gemini', 'config', 'import_manifest.json')
      mkdirSync(path.join(pluginRoot, 'skills', 'example'), { recursive: true })
      writeFileSync(path.join(pluginRoot, 'plugin.json'), JSON.stringify({ name: 'nsolid-plugin' }))
      writeFileSync(path.join(pluginRoot, 'bundle.json'), JSON.stringify({ version: '1.0.1', skills: [{ name: 'example', path: 'skills/example' }] }))
      writeFileSync(path.join(pluginRoot, 'skills', 'example', 'SKILL.md'), '# v1.0.0\n')
      writeFileSync(manifestPath, JSON.stringify({ imports: { 'nsolid-plugin': { name: 'nsolid-plugin' } } }))
      return { home, pluginRoot, manifestPath, previousHome, previousUserProfile }
    }

    function restoreHome (fixture: { home: string; previousHome: string | undefined; previousUserProfile: string | undefined }): void {
      if (fixture.previousHome === undefined) delete process.env.HOME
      else process.env.HOME = fixture.previousHome
      if (fixture.previousUserProfile === undefined) delete process.env.USERPROFILE
      else process.env.USERPROFILE = fixture.previousUserProfile
      rmSync(fixture.home, { recursive: true, force: true })
    }

    function backupContainers (configDir: string): { root: string[]; manifest: string[] } {
      const pluginsDir = path.join(configDir, 'plugins')
      const root = readdirSync(pluginsDir).filter((name) => name.includes('.nsolid-plugin-backup-'))
      const manifest = readdirSync(configDir).filter((name) => name.includes('.nsolid-manifest-backup-'))
      return { root, manifest }
    }

    it('preserves both sibling backups when the guarded restore fails', async () => {
      const fixture = setupInstalledFixture()
      try {
        const item = agyItem()
        const digest = nativePayloadDigest(fixture.pluginRoot)
        assert.ok(digest, 'the staged payload must be digestible')
        const itemWithArtifact = {
          ...item,
          artifact: { kind: 'git' as const, repository: 'https://github.com/NodeSource/nsolid-plugin.git', commit: 'a'.repeat(40), contentDigest: digest },
          steps: [{ kind: 'command' as const, description: 'agy sync', command: { executable: 'agy', args: ['sync'], timeoutMs: 1_000 } }],
        }
        let commands = 0
        const result = await executeAntigravityTransaction(itemWithArtifact, {
          run: async () => {
            commands++
            // The agy replacement corrupts the staged plugin: validation will fail.
            rmSync(path.join(fixture.pluginRoot, 'plugin.json'))
            return { exitCode: 0, stdout: '', stderr: '', timedOut: false }
          },
        }, { restoreState: async () => false })

        assert.equal(result.success, false)
        assert.equal(result.error?.code, 'ANTIGRAVITY_VALIDATION_FAILED')
        assert.equal(result.rollbackAttempted, true)
        assert.equal(result.rollbackSucceeded, false)
        assert.equal(commands, 1)
        // Both backup containers survive for manual recovery.
        const containers = backupContainers(path.join(fixture.home, '.gemini', 'config'))
        assert.equal(containers.root.length, 1)
        assert.equal(containers.manifest.length, 1)
      } finally {
        restoreHome(fixture)
      }
    })

    it('cleans both backups after a successful guarded restore', async () => {
      const fixture = setupInstalledFixture()
      try {
        const item = {
          ...agyItem(),
          steps: [{ kind: 'command' as const, description: 'agy sync', command: { executable: 'agy', args: ['sync'], timeoutMs: 1_000 } }],
        }
        const result = await executeAntigravityTransaction(item, {
          run: async () => {
            rmSync(path.join(fixture.pluginRoot, 'plugin.json'))
            return { exitCode: 0, stdout: '', stderr: '', timedOut: false }
          },
        })

        assert.equal(result.success, false)
        assert.equal(result.error?.code, 'ANTIGRAVITY_VALIDATION_FAILED')
        assert.equal(result.rollbackAttempted, true)
        assert.equal(result.rollbackSucceeded, true)
        const containers = backupContainers(path.join(fixture.home, '.gemini', 'config'))
        assert.deepEqual([...containers.root, ...containers.manifest], [])
        assert.equal(readFileSync(path.join(fixture.pluginRoot, 'skills/example/SKILL.md'), 'utf8'), '# v1.0.0\n')
        assert.equal(existsSync(path.join(fixture.pluginRoot, 'plugin.json')), true)
      } finally {
        restoreHome(fixture)
      }
    })
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
