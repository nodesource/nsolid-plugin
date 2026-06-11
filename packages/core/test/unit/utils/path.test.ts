import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import {
  resolveHome,
  normalizePath,
  getAgentsDir,
  getSkillsDir,
  getAuthFilePath,
  getTrackingFilePath
} from '../../../src/utils/path.js'

describe('resolveHome', () => {
  it('expands ~ with os.homedir()', () => {
    const result = resolveHome('~/test/path')
    assert.strictEqual(result, path.join(os.homedir(), 'test/path'))
  })

  it('expands ~/ with home dir', () => {
    const result = resolveHome('~/')
    assert.strictEqual(result, os.homedir() + path.sep)
  })

  it('returns non-tilde path unchanged', () => {
    assert.strictEqual(resolveHome('/absolute/path'), '/absolute/path')
    assert.strictEqual(resolveHome('relative/path'), 'relative/path')
  })

  it('uses path.join not string concatenation', () => {
    const result = resolveHome('~/.agents/skills')
    assert.strictEqual(result, path.join(os.homedir(), '.agents', 'skills'))
  })

  it('does not expand ~user paths', () => {
    assert.strictEqual(resolveHome('~other/path'), '~other/path')
  })

  it('expands ~\\ on Windows-style inputs', () => {
    assert.strictEqual(resolveHome('~\\test\\path'), path.join(os.homedir(), 'test', 'path'))
  })

  it('expands ~\\ to home dir', () => {
    assert.strictEqual(resolveHome('~\\'), os.homedir() + path.sep)
  })
})

describe('normalizePath', () => {
  it('resolves relative paths to absolute', () => {
    const result = normalizePath('./foo/../bar')
    assert.ok(path.isAbsolute(result))
    assert.ok(result.endsWith('bar'))
  })

  it('normalizes already absolute paths', () => {
    const result = normalizePath('/foo/bar/../baz')
    assert.strictEqual(result, path.resolve('/foo/baz'))
  })
})

describe('path getters', () => {
  it('getAgentsDir returns ~/.agents', () => {
    assert.strictEqual(getAgentsDir(), path.join(os.homedir(), '.agents'))
  })

  it('getSkillsDir returns ~/.agents/skills', () => {
    assert.strictEqual(getSkillsDir(), path.join(os.homedir(), '.agents', 'skills'))
  })

  it('getAuthFilePath returns ~/.agents/.nodesource-auth.json', () => {
    assert.strictEqual(getAuthFilePath(), path.join(os.homedir(), '.agents', '.nodesource-auth.json'))
  })

  it('getTrackingFilePath returns ~/.agents/.nodesource-installed.json', () => {
    assert.strictEqual(getTrackingFilePath(), path.join(os.homedir(), '.agents', '.nodesource-installed.json'))
  })

  it('all paths use path.join not string concatenation', () => {
    assert.ok(getAgentsDir().includes(path.sep))
    assert.ok(getSkillsDir().endsWith(path.join('.agents', 'skills')))
  })
})
