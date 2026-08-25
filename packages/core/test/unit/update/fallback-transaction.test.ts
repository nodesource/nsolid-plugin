import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { refreshOwnedInstallation } from '../../../src/update/fallback-transaction.js'
import { readTrackingFile } from '../../../src/skills/skill-tracker.js'

let home: string
let previousHome: string | undefined
let previousUserProfile: string | undefined

beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), 'nsolid-plugin-fallback-transaction-'))
  previousHome = process.env.HOME
  previousUserProfile = process.env.USERPROFILE
  process.env.HOME = home
  process.env.USERPROFILE = home
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  if (previousHome === undefined) delete process.env.HOME
  else process.env.HOME = previousHome
  if (previousUserProfile === undefined) delete process.env.USERPROFILE
  else process.env.USERPROFILE = previousUserProfile
})

function writeJson (filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true })
  writeFileSync(filePath, JSON.stringify(value, null, 2))
}

describe('fallback refresh transaction', () => {
  it('replaces owned directories, reconciles shared ownership, and recreates harness links', async () => {
    const sharedDir = path.join(home, '.agents', 'skills')
    const retainedDir = path.join(sharedDir, 'retained')
    const removedDir = path.join(sharedDir, 'removed')
    mkdirSync(retainedDir, { recursive: true })
    mkdirSync(removedDir, { recursive: true })
    writeFileSync(path.join(retainedDir, 'SKILL.md'), 'old retained')
    writeFileSync(path.join(retainedDir, 'obsolete.txt'), 'must disappear')
    writeFileSync(path.join(removedDir, 'SKILL.md'), 'shared with Codex')

    const claudeSkills = path.join(home, '.claude', 'skills')
    mkdirSync(claudeSkills, { recursive: true })
    symlinkSync(removedDir, path.join(claudeSkills, 'removed'), 'dir')
    symlinkSync(retainedDir, path.join(claudeSkills, 'retained'), 'dir')

    const sourceRoot = mkdtempSync(path.join(os.tmpdir(), 'nsolid-plugin-fallback-source-'))
    const retainedSource = path.join(sourceRoot, 'skills', 'retained')
    const addedSource = path.join(sourceRoot, 'skills', 'added')
    mkdirSync(retainedSource, { recursive: true })
    mkdirSync(addedSource, { recursive: true })
    writeFileSync(path.join(retainedSource, 'SKILL.md'), 'new retained')
    writeFileSync(path.join(addedSource, 'SKILL.md'), 'new skill')
    const bundlePath = path.join(sourceRoot, 'bundle.json')
    writeJson(bundlePath, {
      name: 'nsolid-plugin',
      version: '1.0.1',
      skills: [
        { name: 'retained', path: 'skills/retained', description: 'retained' },
        { name: 'added', path: 'skills/added', description: 'added' },
      ],
      mcpServers: [{ name: 'nsolid-console', url: 'https://example.com/mcp', headers: {} }],
    })
    writeJson(path.join(home, '.agents', '.nodesource-auth.json'), {
      serviceToken: 'token',
      organizationId: 'org',
      saasToken: 'saas',
      consoleUrl: 'https://console.example.com',
      mcpUrl: 'https://example.com/mcp',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })
    writeJson(path.join(home, '.agents', '.nodesource-installed.json'), {
      version: '1.0.0',
      installedAt: new Date().toISOString(),
      harness: 'claude',
      skills: [
        { name: 'retained', path: retainedDir, paths: { claude: retainedDir }, installedAt: new Date().toISOString(), harnesses: ['claude'] },
        { name: 'removed', path: removedDir, paths: { claude: removedDir, codex: removedDir }, installedAt: new Date().toISOString(), harnesses: ['claude', 'codex'] },
      ],
      mcpServers: [],
    })

    try {
      const result = await refreshOwnedInstallation({ harness: 'claude', bundlePath, skillsSource: sourceRoot })
      assert.equal(result.success, true)
      assert.equal(readFileSync(path.join(retainedDir, 'SKILL.md'), 'utf8'), 'new retained')
      assert.equal(existsSync(path.join(retainedDir, 'obsolete.txt')), false)
      assert.equal(existsSync(removedDir), true)
      assert.equal(existsSync(path.join(claudeSkills, 'removed')), false)
      assert.equal(existsSync(path.join(claudeSkills, 'retained')), true)
      assert.equal(existsSync(path.join(claudeSkills, 'added')), true)

      const tracking = await readTrackingFile()
      const removed = tracking?.skills.find((entry) => entry.name === 'removed')
      assert.deepEqual(removed?.harnesses, ['codex'])
      assert.equal(tracking?.bundleVersions?.claude, '1.0.1')
    } finally {
      rmSync(sourceRoot, { recursive: true, force: true })
    }
  })

  it('rejects a new harness link when its destination is untracked', async () => {
    const sharedDir = path.join(home, '.agents', 'skills')
    const sourceRoot = mkdtempSync(path.join(os.tmpdir(), 'nsolid-plugin-fallback-source-'))
    const trackedSource = path.join(sourceRoot, 'skills', 'tracked')
    const addedSource = path.join(sourceRoot, 'skills', 'added')
    mkdirSync(trackedSource, { recursive: true })
    mkdirSync(addedSource, { recursive: true })
    writeFileSync(path.join(trackedSource, 'SKILL.md'), 'tracked')
    writeFileSync(path.join(addedSource, 'SKILL.md'), 'added')
    mkdirSync(path.join(sharedDir, 'tracked'), { recursive: true })
    writeFileSync(path.join(sharedDir, 'tracked', 'SKILL.md'), 'old tracked')
    const harnessDir = path.join(home, '.claude', 'skills')
    mkdirSync(path.join(harnessDir, 'added'), { recursive: true })
    writeFileSync(path.join(harnessDir, 'added', 'user-owned.txt'), 'keep me')
    const bundlePath = path.join(sourceRoot, 'bundle.json')
    writeJson(bundlePath, {
      name: 'nsolid-plugin',
      version: '1.0.1',
      skills: [
        { name: 'tracked', path: 'skills/tracked', description: 'tracked' },
        { name: 'added', path: 'skills/added', description: 'added' },
      ],
      mcpServers: [{ name: 'nsolid-console', url: 'https://example.com/mcp', headers: {} }],
    })
    writeJson(path.join(home, '.agents', '.nodesource-installed.json'), {
      version: '1.0.0',
      installedAt: new Date().toISOString(),
      harness: 'claude',
      bundleVersions: { claude: '1.0.0' },
      skills: [{ name: 'tracked', path: path.join(sharedDir, 'tracked'), paths: { claude: path.join(sharedDir, 'tracked') }, installedAt: new Date().toISOString(), harnesses: ['claude'] }],
      mcpServers: [],
    })

    const result = await refreshOwnedInstallation({ harness: 'claude', bundlePath, skillsSource: sourceRoot })

    assert.equal(result.success, false)
    assert.equal(result.error?.code, 'UNTRACKED_DESTINATION')
    assert.equal(existsSync(path.join(harnessDir, 'added', 'user-owned.txt')), true)
    rmSync(sourceRoot, { recursive: true, force: true })
  })

  it('does not roll back or delete owned state when backup creation fails', async () => {
    const sourceRoot = mkdtempSync(path.join(os.tmpdir(), 'nsolid-plugin-fallback-source-'))
    const skillSource = path.join(sourceRoot, 'skills', 'tracked')
    mkdirSync(skillSource, { recursive: true })
    writeFileSync(path.join(skillSource, 'SKILL.md'), 'new')
    const longPath = path.join(home, ...Array.from({ length: 4 }, () => 'a'.repeat(70)), 'tracked')
    mkdirSync(path.dirname(longPath), { recursive: true })
    writeFileSync(longPath, 'original')
    const bundlePath = path.join(sourceRoot, 'bundle.json')
    writeJson(bundlePath, {
      name: 'nsolid-plugin',
      version: '1.0.1',
      skills: [{ name: 'tracked', path: 'skills/tracked', description: 'tracked' }],
      mcpServers: [{ name: 'nsolid-console', url: 'https://example.com/mcp', headers: {} }],
    })
    writeJson(path.join(home, '.agents', '.nodesource-installed.json'), {
      version: '1.0.0',
      installedAt: new Date().toISOString(),
      harness: 'opencode',
      bundleVersion: '1.0.0',
      skills: [{ name: 'tracked', path: longPath, paths: { opencode: longPath }, installedAt: new Date().toISOString(), harnesses: ['opencode'] }],
      mcpServers: [],
    })

    const result = await refreshOwnedInstallation({ harness: 'opencode', bundlePath, skillsSource: sourceRoot })

    assert.equal(result.success, false)
    assert.equal(result.error?.code, 'FALLBACK_BACKUP_FAILED')
    assert.equal(result.rollbackAttempted, false)
    assert.equal(readFileSync(longPath, 'utf8'), 'original')
    rmSync(sourceRoot, { recursive: true, force: true })
  })

  it('does not advance fallback evidence when MCP reconciliation is skipped', async () => {
    const sharedDir = path.join(home, '.agents', 'skills')
    const skillPath = path.join(sharedDir, 'tracked')
    mkdirSync(skillPath, { recursive: true })
    writeFileSync(path.join(skillPath, 'SKILL.md'), 'old')
    const sourceRoot = mkdtempSync(path.join(os.tmpdir(), 'nsolid-plugin-fallback-source-'))
    mkdirSync(path.join(sourceRoot, 'skills', 'tracked'), { recursive: true })
    writeFileSync(path.join(sourceRoot, 'skills', 'tracked', 'SKILL.md'), 'new')
    const bundlePath = path.join(sourceRoot, 'bundle.json')
    writeJson(bundlePath, {
      name: 'nsolid-plugin',
      version: '1.0.1',
      skills: [{ name: 'tracked', path: 'skills/tracked', description: 'tracked' }],
      mcpServers: [{ name: 'new-server', url: 'https://example.com/mcp', headers: {} }],
    })
    const configPath = path.join(home, '.claude.json')
    writeJson(configPath, { mcpServers: { 'old-server': { type: 'http', url: 'https://old.example/mcp' } } })
    writeJson(path.join(home, '.agents', '.nodesource-installed.json'), {
      version: '1.0.0',
      installedAt: new Date().toISOString(),
      harness: 'claude',
      bundleVersion: '1.0.0',
      bundleVersions: { claude: '1.0.0' },
      skills: [{ name: 'tracked', path: skillPath, paths: { claude: skillPath }, installedAt: new Date().toISOString(), harnesses: ['claude'] }],
      mcpServers: [{ name: 'old-server', configPath, harness: 'claude', configuredAt: new Date().toISOString() }],
    })

    const result = await refreshOwnedInstallation({ harness: 'claude', bundlePath, skillsSource: sourceRoot })

    assert.equal(result.success, false)
    assert.equal(result.error?.code, 'MCP_RECONCILIATION_REQUIRED')
    const tracking = await readTrackingFile()
    assert.equal(tracking?.bundleVersions?.claude, '1.0.0')
    assert.equal(readFileSync(path.join(skillPath, 'SKILL.md'), 'utf8'), 'old')
    rmSync(sourceRoot, { recursive: true, force: true })
  })

  it('repoints the legacy path when the referenced harness drops a shared skill', async () => {
    const sharedDir = path.join(home, '.agents', 'skills')
    const claudeDroppedPath = path.join(sharedDir, 'dropped')
    const codexRemainingPath = path.join(home, 'codex-owned', 'dropped')
    const retainedPath = path.join(sharedDir, 'retained')
    for (const skillPath of [claudeDroppedPath, codexRemainingPath, retainedPath]) {
      mkdirSync(skillPath, { recursive: true })
      writeFileSync(path.join(skillPath, 'SKILL.md'), 'old')
    }
    const sourceRoot = mkdtempSync(path.join(os.tmpdir(), 'nsolid-plugin-fallback-source-'))
    mkdirSync(path.join(sourceRoot, 'skills', 'retained'), { recursive: true })
    writeFileSync(path.join(sourceRoot, 'skills', 'retained', 'SKILL.md'), 'new')
    const bundlePath = path.join(sourceRoot, 'bundle.json')
    writeJson(bundlePath, {
      name: 'nsolid-plugin',
      version: '1.0.1',
      skills: [{ name: 'retained', path: 'skills/retained', description: 'retained' }],
      mcpServers: [{ name: 'nsolid-console', url: 'https://example.com/mcp', headers: {} }],
    })
    writeJson(path.join(home, '.agents', '.nodesource-auth.json'), {
      serviceToken: 'token',
      organizationId: 'org',
      saasToken: 'saas',
      consoleUrl: 'https://console.example.com',
      mcpUrl: 'https://example.com/mcp',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })
    writeJson(path.join(home, '.agents', '.nodesource-installed.json'), {
      version: '1.0.0',
      installedAt: new Date().toISOString(),
      harness: 'claude',
      bundleVersions: { claude: '1.0.0', codex: '1.0.0' },
      skills: [
        { name: 'dropped', path: claudeDroppedPath, paths: { claude: claudeDroppedPath, codex: codexRemainingPath }, installedAt: new Date().toISOString(), harnesses: ['claude', 'codex'] },
        { name: 'retained', path: retainedPath, paths: { claude: retainedPath }, installedAt: new Date().toISOString(), harnesses: ['claude'] },
      ],
      mcpServers: [],
    })

    const result = await refreshOwnedInstallation({ harness: 'claude', bundlePath, skillsSource: sourceRoot })

    assert.equal(result.success, true, JSON.stringify(result))
    const tracking = await readTrackingFile()
    const dropped = tracking?.skills.find((entry) => entry.name === 'dropped')
    assert.equal(dropped?.path, codexRemainingPath)
    assert.deepEqual(dropped?.harnesses, ['codex'])
    rmSync(sourceRoot, { recursive: true, force: true })
  })

  it('rejects a bundle whose version does not match its package manifest', async () => {
    const sharedDir = path.join(home, '.agents', 'skills')
    const skillPath = path.join(sharedDir, 'tracked')
    mkdirSync(skillPath, { recursive: true })
    writeFileSync(path.join(skillPath, 'SKILL.md'), 'old')
    const sourceRoot = mkdtempSync(path.join(os.tmpdir(), 'nsolid-plugin-fallback-source-'))
    mkdirSync(path.join(sourceRoot, 'skills', 'tracked'), { recursive: true })
    writeFileSync(path.join(sourceRoot, 'skills', 'tracked', 'SKILL.md'), 'new')
    writeJson(path.join(sourceRoot, 'package.json'), { name: 'nsolid-plugin', version: '1.0.2' })
    const bundlePath = path.join(sourceRoot, 'bundle.json')
    writeJson(bundlePath, {
      name: 'nsolid-plugin',
      version: '1.0.1',
      skills: [{ name: 'tracked', path: 'skills/tracked', description: 'tracked' }],
      mcpServers: [{ name: 'nsolid-console', url: 'https://example.com/mcp', headers: {} }],
    })
    writeJson(path.join(home, '.agents', '.nodesource-installed.json'), {
      version: '1.0.0',
      installedAt: new Date().toISOString(),
      harness: 'opencode',
      bundleVersions: { opencode: '1.0.0' },
      skills: [{ name: 'tracked', path: skillPath, paths: { opencode: skillPath }, installedAt: new Date().toISOString(), harnesses: ['opencode'] }],
      mcpServers: [],
    })

    const result = await refreshOwnedInstallation({ harness: 'opencode', bundlePath, skillsSource: sourceRoot })

    assert.equal(result.success, false)
    assert.equal(result.error?.code, 'FALLBACK_BUNDLE_VERSION_MISMATCH')
    assert.equal(readFileSync(path.join(skillPath, 'SKILL.md'), 'utf8'), 'old')
    rmSync(sourceRoot, { recursive: true, force: true })
  })
})
