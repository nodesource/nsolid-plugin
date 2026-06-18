import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  createConfigBackup,
  listConfigBackups,
  restoreConfigBackup,
} from '../../../src/utils/backup.js'

let tmpDir: string
let originalHome: string | undefined
let originalUserProfile: string | undefined

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'nsolid-backup-'))
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

describe('createConfigBackup', () => {
  it('creates a backup and sidecar meta file', () => {
    const configPath = join(tmpDir, '.claude.json')
    writeFileSync(configPath, '{"mcpServers":{}}', 'utf8')

    const entry = createConfigBackup('claude', configPath, { reason: 'test' })

    assert.ok(entry)
    assert.strictEqual(entry!.harness, 'claude')
    assert.strictEqual(entry!.originalPath, configPath)
    assert.ok(existsSync(entry!.backupPath))
    assert.strictEqual(readFileSync(entry!.backupPath, 'utf8'), '{"mcpServers":{}}')
    assert.ok(existsSync(`${entry!.backupPath}.meta.json`))
  })

  it('returns null when the config file does not exist', () => {
    const entry = createConfigBackup('claude', join(tmpDir, 'missing.json'))
    assert.strictEqual(entry, null)
  })

  it('creates distinct backup paths for back-to-back calls', () => {
    const configPath = join(tmpDir, '.claude.json')
    writeFileSync(configPath, 'v1', 'utf8')
    const first = createConfigBackup('claude', configPath)!
    const second = createConfigBackup('claude', configPath)!
    assert.notStrictEqual(first.backupPath, second.backupPath)
    assert.strictEqual(listConfigBackups('claude').length, 2)
  })
})

describe('listConfigBackups', () => {
  it('lists backups newest first', () => {
    const configPath = join(tmpDir, '.claude.json')
    writeFileSync(configPath, 'v1', 'utf8')
    const first = createConfigBackup('claude', configPath)!

    writeFileSync(configPath, 'v2', 'utf8')
    const second = createConfigBackup('claude', configPath)!

    const list = listConfigBackups('claude')
    assert.strictEqual(list.length, 2)
    assert.strictEqual(list[0].backupPath, second.backupPath)
    assert.strictEqual(list[1].backupPath, first.backupPath)
  })

  it('returns an empty array when no backups exist', () => {
    assert.deepStrictEqual(listConfigBackups('codex'), [])
  })
})

describe('restoreConfigBackup', () => {
  it('restores the latest backup by default', () => {
    const configPath = join(tmpDir, '.claude.json')
    writeFileSync(configPath, 'v1', 'utf8')
    createConfigBackup('claude', configPath)

    writeFileSync(configPath, 'v2', 'utf8')
    createConfigBackup('claude', configPath)

    writeFileSync(configPath, 'corrupt', 'utf8')

    const entry = restoreConfigBackup('claude')
    assert.strictEqual(readFileSync(configPath, 'utf8'), 'v2')
    assert.strictEqual(entry.originalPath, configPath)
  })

  it('restores a specific backup when given a path', () => {
    const configPath = join(tmpDir, '.codex', 'config.toml')
    mkdirSync(join(tmpDir, '.codex'), { recursive: true })
    writeFileSync(configPath, 'v1', 'utf8')
    const first = createConfigBackup('codex', configPath)!

    writeFileSync(configPath, 'v2', 'utf8')
    createConfigBackup('codex', configPath)

    const entry = restoreConfigBackup('codex', first.backupPath)
    assert.strictEqual(readFileSync(configPath, 'utf8'), 'v1')
    assert.strictEqual(entry.backupPath, first.backupPath)
  })

  it('throws when no backups exist', () => {
    assert.throws(() => restoreConfigBackup('opencode'), /No backups found/)
  })
})
