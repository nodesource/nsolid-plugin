import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  createConfigBackup,
  listConfigBackups,
  restoreConfigBackup,
} from '../../../src/utils/backup.js'
import { getConfigBackupDir } from '../../../src/utils/path.js'

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

  it('does not reuse a sequence reserved by a crashed creator', () => {
    const configPath = join(tmpDir, '.claude.json')
    writeFileSync(configPath, 'v1', 'utf8')
    const reservationsDir = join(getConfigBackupDir('claude'), '.seq-reservations')
    mkdirSync(join(reservationsDir, '41'), { recursive: true })

    const entry = createConfigBackup('claude', configPath)!
    const meta = JSON.parse(readFileSync(`${entry.backupPath}.meta.json`, 'utf8'))
    assert.strictEqual(meta.seq, 42)
  })

  it('ignores malformed sidecars when reserving a sequence', () => {
    const configPath = join(tmpDir, '.claude.json')
    writeFileSync(configPath, 'v1', 'utf8')
    const backupDir = getConfigBackupDir('claude')
    mkdirSync(backupDir, { recursive: true })
    writeFileSync(join(backupDir, 'truncated.meta.json'), '{', 'utf8')
    writeFileSync(join(backupDir, 'fractional.meta.json'), JSON.stringify({ seq: 1.5 }), 'utf8')
    writeFileSync(join(backupDir, 'negative.meta.json'), JSON.stringify({ seq: -1 }), 'utf8')
    writeFileSync(join(backupDir, 'exhausted.meta.json'), JSON.stringify({ seq: Number.MAX_SAFE_INTEGER }), 'utf8')

    const entry = createConfigBackup('claude', configPath)

    assert.ok(entry)
    assert.ok(existsSync(`${entry.backupPath}.meta.json`))
    const meta = JSON.parse(readFileSync(`${entry.backupPath}.meta.json`, 'utf8'))
    assert.strictEqual(meta.seq, 1)
  })
})

describe('listConfigBackups', () => {
  it('lists backups newest first', () => {
    const configPath = join(tmpDir, '.claude.json')
    writeFileSync(configPath, 'v1', 'utf8')
    const first = createConfigBackup('claude', configPath)!

    writeFileSync(configPath, 'v2', 'utf8')
    const second = createConfigBackup('claude', configPath)!
    const firstMetaPath = `${first.backupPath}.meta.json`
    const firstMeta = JSON.parse(readFileSync(firstMetaPath, 'utf8'))
    firstMeta.seq = 'invalid-but-non-fatal'
    firstMeta.createdAt = new Date(firstMeta.createdAt).toUTCString()
    writeFileSync(firstMetaPath, JSON.stringify(firstMeta), 'utf8')

    const list = listConfigBackups('claude')
    assert.strictEqual(list.length, 2)
    assert.strictEqual(list[0].backupPath, second.backupPath)
    assert.strictEqual(list[1].backupPath, first.backupPath)
  })

  it('returns an empty array when no backups exist', () => {
    assert.deepStrictEqual(listConfigBackups('codex'), [])
  })

  it('keeps valid backups while skipping malformed or structurally invalid sidecars', () => {
    const configPath = join(tmpDir, '.claude.json')
    writeFileSync(configPath, 'valid', 'utf8')
    const valid = createConfigBackup('claude', configPath)!
    const backupDir = getConfigBackupDir('claude')

    writeFileSync(join(backupDir, 'truncated.json'), '{}', 'utf8')
    writeFileSync(join(backupDir, 'truncated.json.meta.json'), '{', 'utf8')
    writeFileSync(join(backupDir, 'empty.json'), '{}', 'utf8')
    writeFileSync(join(backupDir, 'empty.json.meta.json'), '{}', 'utf8')
    writeFileSync(join(backupDir, 'bad-date.json'), '{}', 'utf8')
    writeFileSync(join(backupDir, 'bad-date.json.meta.json'), JSON.stringify({
      harness: 'claude', originalPath: configPath, createdAt: 42, seq: 'not-a-number',
    }), 'utf8')

    assert.deepStrictEqual(listConfigBackups('claude'), [valid])
  })
})

describe('restoreConfigBackup', () => {
  it('restores the latest backup by default', () => {
    const configPath = join(tmpDir, '.claude.json')
    writeFileSync(configPath, 'v1', 'utf8')
    createConfigBackup('claude', configPath)

    writeFileSync(configPath, 'v2', 'utf8')
    createConfigBackup('claude', configPath)

    const backupDir = getConfigBackupDir('claude')
    writeFileSync(join(backupDir, 'foreign.json'), 'foreign', 'utf8')
    writeFileSync(join(backupDir, 'foreign.json.meta.json'), JSON.stringify({
      harness: 'claude', originalPath: configPath, createdAt: {}, seq: Number.MAX_SAFE_INTEGER,
    }), 'utf8')
    writeFileSync(configPath, 'corrupt', 'utf8')

    const entry = restoreConfigBackup('claude')
    assert.strictEqual(readFileSync(configPath, 'utf8'), 'v2')
    assert.strictEqual(entry.originalPath, configPath)
  })

  it('orders same-millisecond backups by persisted sequence, never by mtime', () => {
    // Regression: back-to-back backups can share a createdAt millisecond,
    // and on coarse-timestamp filesystems (FAT, network mounts) the meta
    // mtimes can tie too. The persisted seq cannot tie, so "latest" must be
    // the backup created last even when its meta looks older on disk.
    const configPath = join(tmpDir, '.claude.json')
    writeFileSync(configPath, 'v1', 'utf8')
    const first = createConfigBackup('claude', configPath)!
    writeFileSync(configPath, 'v2', 'utf8')
    const second = createConfigBackup('claude', configPath)!

    // Sequences are monotonic within the harness backup directory.
    const firstMeta = JSON.parse(readFileSync(`${first.backupPath}.meta.json`, 'utf8'))
    const secondMeta = JSON.parse(readFileSync(`${second.backupPath}.meta.json`, 'utf8'))
    assert.strictEqual(secondMeta.seq, firstMeta.seq + 1)

    // Force identical createdAt values and give the OLDER backup's meta the
    // NEWER mtime: any timestamp-based ordering would pick the wrong one.
    const sameInstant = firstMeta.createdAt
    secondMeta.createdAt = sameInstant
    writeFileSync(`${second.backupPath}.meta.json`, JSON.stringify(secondMeta, null, 2) + '\n')
    const future = new Date(Date.now() + 60_000)
    utimesSync(`${first.backupPath}.meta.json`, future, future)

    writeFileSync(configPath, 'corrupt', 'utf8')
    const entry = restoreConfigBackup('claude')
    assert.strictEqual(readFileSync(configPath, 'utf8'), 'v2')
    assert.strictEqual(entry.backupPath, second.backupPath)
  })

  it('orders by persisted sequence when the clock steps backwards between backups', () => {
    // Regression: createdAt is wall-clock time and can move backwards (NTP
    // step corrections, manual clock changes, VM snapshot restores). The
    // persisted seq is monotonic, so it — not createdAt — decides which
    // sequenced backup is newest.
    const configPath = join(tmpDir, '.claude.json')
    writeFileSync(configPath, 'v1', 'utf8')
    const first = createConfigBackup('claude', configPath)!
    writeFileSync(configPath, 'v2', 'utf8')
    const second = createConfigBackup('claude', configPath)!

    // Simulate a backwards clock step: the backup created LAST now claims an
    // older createdAt. Any timestamp-based ordering would pick `first`.
    const secondMetaPath = `${second.backupPath}.meta.json`
    const secondMeta = JSON.parse(readFileSync(secondMetaPath, 'utf8'))
    secondMeta.createdAt = new Date(new Date(secondMeta.createdAt).getTime() - 3_600_000).toISOString()
    writeFileSync(secondMetaPath, JSON.stringify(secondMeta, null, 2) + '\n')

    const list = listConfigBackups('claude')
    assert.strictEqual(list[0].backupPath, second.backupPath)
    assert.strictEqual(list[1].backupPath, first.backupPath)

    writeFileSync(configPath, 'corrupt', 'utf8')
    const restored = restoreConfigBackup('claude')
    assert.strictEqual(restored.backupPath, second.backupPath)
    assert.strictEqual(readFileSync(configPath, 'utf8'), 'v2')
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

  it('assigns tie-free sequences under concurrent processes', async () => {
    // Regression: seq reservation must be atomic across processes — two
    // installers running at once must never receive the same seq, otherwise
    // (with same-ms createdAt and coarse mtimes) "latest" is undefined again.
    const configPath = join(tmpDir, '.claude.json')
    writeFileSync(configPath, 'shared', 'utf8')
    const workers = 6
    const backupDir = getConfigBackupDir('claude')
    const readyDir = join(tmpDir, 'worker-ready')
    const startPath = join(tmpDir, 'worker-start')
    mkdirSync(readyDir)
    // Resolve against this file so the test works from any cwd.
    const backupModule = pathToFileURL(fileURLToPath(new URL('../../../src/utils/backup.ts', import.meta.url))).href
    const repoRoot = fileURLToPath(new URL('../../../../..', import.meta.url))
    const childProcesses: ReturnType<typeof spawn>[] = []
    const children = Array.from({ length: workers }, (_, worker) => new Promise<void>((resolve, reject) => {
      const script = [
        `process.env.HOME = ${JSON.stringify(tmpDir)}`,
        `process.env.USERPROFILE = ${JSON.stringify(tmpDir)}`,
        'const { createRequire, syncBuiltinESMExports } = await import(\'node:module\')',
        'const { writeFileSync, existsSync } = await import(\'node:fs\')',
        'const require = createRequire(import.meta.url)',
        'const fs = require(\'node:fs\')',
        'const originalReaddirSync = fs.readdirSync',
        'let delayed = false',
        'fs.readdirSync = function (target, options) {',
        `  if (!delayed && String(target) === ${JSON.stringify(backupDir)}) {`,
        '    delayed = true',
        '    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2500)',
        '  }',
        '  return originalReaddirSync.call(this, target, options)',
        '}',
        'syncBuiltinESMExports()',
        `writeFileSync(${JSON.stringify(join(readyDir, String(worker)))}, '')`,
        `while (!existsSync(${JSON.stringify(startPath)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)`,
        `const { createConfigBackup } = await import(${JSON.stringify(backupModule)})`,
        `if (createConfigBackup('claude', ${JSON.stringify(configPath)}) === null) throw new Error('backup returned null')`,
      ].join('\n')
      const child = spawn(
        process.execPath,
        ['--import', 'tsx/esm', '--input-type=module', '--eval', script],
        { cwd: repoRoot, stdio: ['ignore', 'ignore', 'pipe'] }
      )
      childProcesses.push(child)
      let stderr = ''
      child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
      child.on('close', (code) => {
        if (code === 0) resolve()
        else reject(new Error(`backup worker exited with ${code}: ${stderr.trim().slice(-500)}`))
      })
      child.on('error', reject)
    }))

    let barrierReleased = false
    try {
      const readyDeadline = Date.now() + 10_000
      while (readdirSync(readyDir).length < workers) {
        if (Date.now() >= readyDeadline) throw new Error('backup workers did not reach the start barrier')
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      writeFileSync(startPath, 'go')
      barrierReleased = true
      await Promise.all(children)
    } finally {
      if (!barrierReleased) writeFileSync(startPath, 'abort')
      for (const child of childProcesses) {
        if (child.exitCode === null && child.signalCode === null) child.kill()
      }
      await Promise.allSettled(children)
    }

    const backups = listConfigBackups('claude')
    assert.strictEqual(backups.length, workers, 'every concurrent backup was recorded')
    const seqs = backups.map((b) => JSON.parse(readFileSync(`${b.backupPath}.meta.json`, 'utf8')).seq as number)
    assert.strictEqual(new Set(seqs).size, seqs.length, `sequences must be unique across processes: ${seqs}`)
    // Ordering invariant: sequenced backups are newest-first strictly by seq
    // (createdAt can interleave across processes; the persisted seq cannot).
    for (let i = 1; i < seqs.length; i++) {
      assert.ok(
        seqs[i - 1] > seqs[i],
        `sequences must strictly decrease in newest-first order: ${seqs.join(' > ')}`
      )
    }
  })
})
