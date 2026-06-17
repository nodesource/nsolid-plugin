import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { install, uninstall, restore } from '../../src/index.js'
import { getAdapter } from '../../src/harnesses/index.js'
import type { BundleDescriptor } from '../../src/types.js'
import { getConfigBackupDir } from '../../src/utils/path.js'
import { createConfigBackup } from '../../src/utils/backup.js'

let tmpDir: string
let originalHome: string | undefined
let originalUserProfile: string | undefined

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'nsolid-backup-int-'))
  originalHome = process.env.HOME
  originalUserProfile = process.env.USERPROFILE
  process.env.HOME = tmpDir
  process.env.USERPROFILE = tmpDir
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
  if (originalHome !== undefined) {
    process.env.HOME = originalHome
  } else {
    delete process.env.HOME
  }
  if (originalUserProfile !== undefined) {
    process.env.USERPROFILE = originalUserProfile
  } else {
    delete process.env.USERPROFILE
  }
})

function createBundle (): BundleDescriptor {
  return {
    name: 'test-bundle',
    version: '1.0.0',
    skills: [
      { name: 'ns-backup-skill', path: 'skills/ns-backup-skill', description: 'Backup test skill' },
    ],
    mcpServers: [
      { name: 'ns-test-mcp', url: 'https://mcp.example.com', headers: { Authorization: 'Bearer test' } },
    ],
  }
}

function writeBundle (bundle: BundleDescriptor): string {
  const bundleDir = join(tmpDir, 'bundle')
  mkdirSync(bundleDir, { recursive: true })
  const bundlePath = join(bundleDir, 'bundle.json')
  writeFileSync(bundlePath, JSON.stringify(bundle, null, 2))
  return bundlePath
}

function createSkillSource (): string {
  const sourceDir = join(tmpDir, 'source')
  const skillDir = join(sourceDir, 'skills', 'ns-backup-skill')
  mkdirSync(skillDir, { recursive: true })
  writeFileSync(join(skillDir, 'SKILL.md'), '# ns-backup-skill')
  return sourceDir
}

const MATRIX = ['claude', 'codex', 'opencode', 'antigravity', 'pi'] as const

for (const harness of MATRIX) {
  describe(`backup/restore: ${harness}`, () => {
    it('creates a backup before mutating existing config', async () => {
      const adapter = getAdapter(harness)
      const configPath = adapter.getMcpConfigPath()!
      mkdirSync(join(configPath, '..'), { recursive: true })
      const originalContent = harness === 'codex'
        ? '[mcp_servers]\n\n[mcp_servers.userServer]\nurl = "https://x"\n'
        : JSON.stringify({ userServer: { url: 'https://x' } })
      writeFileSync(configPath, originalContent, 'utf8')

      const bundle = createBundle()
      await install({ harness, bundlePath: writeBundle(bundle), skillsSource: createSkillSource() })

      assert.ok(existsSync(getConfigBackupDir(harness)), `backup dir exists for ${harness}`)

      const restored = await restore(harness)
      assert.strictEqual(readFileSync(configPath, 'utf8'), originalContent)
      assert.strictEqual(restored.harness, harness)
    })

    it('does not create a backup when config did not exist', async () => {
      const bundle = createBundle()
      await install({ harness, bundlePath: writeBundle(bundle), skillsSource: createSkillSource() })

      // No backup should have been created when the config did not exist.
      const backups = getConfigBackupDir(harness)
      assert.strictEqual(
        existsSync(backups) ? readdirSync(backups).length : 0,
        0,
        `no backup files for ${harness} when config was new`
      )
    })

    it('restore recovers config after uninstall', async () => {
      const adapter = getAdapter(harness)
      const configPath = adapter.getMcpConfigPath()!
      mkdirSync(join(configPath, '..'), { recursive: true })
      const originalContent = harness === 'codex'
        ? '[mcp_servers]\n\n[mcp_servers.userServer]\nurl = "https://x"\n'
        : JSON.stringify({ userServer: { url: 'https://x' } })
      writeFileSync(configPath, originalContent, 'utf8')
      const originalBackup = createConfigBackup(harness, configPath)!

      const bundle = createBundle()
      await install({ harness, bundlePath: writeBundle(bundle), skillsSource: createSkillSource() })
      await uninstall(harness)

      const entry = await restore(harness, { backupPath: originalBackup.backupPath })
      assert.strictEqual(entry.backupPath, originalBackup.backupPath)
      assert.strictEqual(readFileSync(configPath, 'utf8'), readFileSync(originalBackup.backupPath, 'utf8'))
    })
  })
}
