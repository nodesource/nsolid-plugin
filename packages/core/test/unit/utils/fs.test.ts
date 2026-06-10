import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { atomicWriteSync, ensureDir } from '../../../src/utils/fs.js'
import { writeJsonFileSync } from '../../../src/utils/fs.js'

let tmpDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'nsolid-test-'))
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('ensureDir', () => {
  it('creates a directory recursively', () => {
    const dir = join(tmpDir, 'a', 'b', 'c')
    ensureDir(dir)
    assert.ok(existsSync(dir))
  })

  it('does not throw if directory already exists', () => {
    ensureDir(tmpDir)
    ensureDir(tmpDir)
  })
})

describe('writeJsonFileSync', () => {
  it('writes JSON with pretty formatting', () => {
    const file = join(tmpDir, 'test.json')
    writeJsonFileSync(file, { hello: 'world', num: 42 })

    const content = readFileSync(file, 'utf-8')
    const parsed = JSON.parse(content)
    assert.deepStrictEqual(parsed, { hello: 'world', num: 42 })
    assert.ok(content.endsWith('\n'))
    assert.ok(content.includes('\n  '))
  })

  it('overwrites existing file', () => {
    const file = join(tmpDir, 'test.json')
    writeJsonFileSync(file, { v: 1 })
    writeJsonFileSync(file, { v: 2 })

    const content = readFileSync(file, 'utf-8')
    assert.deepStrictEqual(JSON.parse(content), { v: 2 })
  })
})

describe('atomicWriteSync', () => {
  it('writes content atomically', () => {
    const file = join(tmpDir, 'atomic.txt')
    atomicWriteSync(file, 'hello world')

    const content = readFileSync(file, 'utf-8')
    assert.strictEqual(content, 'hello world')
  })
})
