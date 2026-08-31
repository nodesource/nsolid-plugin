import { afterEach, beforeEach, describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, rmSync, writeFileSync } from 'node:fs'
import { cp as realFsCp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { refreshOwnedInstallation } from '../../../src/update/fallback-transaction.js'
import { appendFallbackJournalEntries, applyFallbackEntry, beginFallbackJournal, captureFallbackJournalState, commitFallbackJournal, fallbackJournalPath, markFallbackJournalMutating, reloadFallbackJournal, registerFallbackStage, restoreFallbackJournal, trackingDigest, valueDigest } from '../../../src/update/fallback-journal.js'
import { randomUUID } from 'node:crypto'
import type { FallbackTransactionIdentity } from '../../../src/update/types.js'
import { getHarnessSkillsPath } from '../../../src/skills/skill-linker.js'
import { getSkillsDir, getTrackingFilePath } from '../../../src/utils/path.js'
import { readTrackingFile } from '../../../src/skills/skill-tracker.js'
import { parseJsonc } from '../../../src/utils/config.js'

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

  it('preserves user-owned MCP fields and JSONC bytes during stale cleanup', async () => {
    const skillPath = path.join(home, '.config', 'opencode', 'skills', 'tracked')
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
    writeJson(path.join(home, '.agents', '.nodesource-auth.json'), {
      serviceToken: 'token',
      organizationId: 'org',
      saasToken: 'saas',
      consoleUrl: 'https://console.example.com',
      mcpUrl: 'https://example.com/mcp',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })
    const configPath = path.join(home, '.config', 'opencode', 'opencode.jsonc')
    mkdirSync(path.dirname(configPath), { recursive: true })
    const originalConfig = '{\n  // keep this comment\n  "mcp": {\n    "old-server": { "url": "https://old.example/mcp", "userSetting": true }\n  }\n}\n'
    writeFileSync(configPath, originalConfig)
    writeJson(path.join(home, '.agents', '.nodesource-installed.json'), {
      version: '1.0.0',
      installedAt: new Date().toISOString(),
      harness: 'opencode',
      bundleVersions: { opencode: '1.0.0' },
      skills: [{ name: 'tracked', path: skillPath, paths: { opencode: skillPath }, installedAt: new Date().toISOString(), harnesses: ['opencode'] }],
      mcpServers: [{
        name: 'old-server',
        configPath,
        harness: 'opencode',
        configuredAt: new Date().toISOString(),
        fields: { url: valueDigest('https://old.example/mcp') },
      }],
    })

    const result = await refreshOwnedInstallation({ harness: 'opencode', bundlePath, skillsSource: sourceRoot })

    assert.equal(result.success, false)
    assert.equal(result.error?.code, 'MCP_RECONCILIATION_REQUIRED')
    assert.equal(readFileSync(configPath, 'utf8'), originalConfig)
    assert.equal(readFileSync(path.join(skillPath, 'SKILL.md'), 'utf8'), 'old')
    rmSync(sourceRoot, { recursive: true, force: true })
  })

  it('applies owned field updates and removals to an existing codex TOML server', async () => {
    const skillPath = path.join(home, '.agents', 'skills', 'tracked')
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
      mcpServers: [{ name: 'alpha-console', url: 'https://new.example.com/mcp', headers: {} }],
    })
    writeJson(path.join(home, '.agents', '.nodesource-auth.json'), {
      serviceToken: 'token',
      organizationId: 'org',
      saasToken: 'saas',
      consoleUrl: 'https://console.example.com',
      mcpUrl: 'https://new.example.com/mcp',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })
    const configPath = path.join(home, '.codex', 'config.toml')
    mkdirSync(path.dirname(configPath), { recursive: true })
    // CRLF document with a comment, an unrelated table, and user credentials:
    // the localized editor must preserve every byte outside the owned ranges.
    const originalConfig = [
      '# user comment',
      '[model]',
      'name = "gpt-5"  # keep pick',
      '',
      '[mcp_servers.alpha-console]',
      'url = "https://old.example/mcp"',
      'note = "keep-note"',
      'user_token = "user-secret"',
    ].join('\r\n') + '\r\n'
    writeFileSync(configPath, originalConfig)
    writeJson(path.join(home, '.agents', '.nodesource-installed.json'), {
      version: '1.0.0',
      installedAt: new Date().toISOString(),
      harness: 'codex',
      bundleVersions: { codex: '1.0.0' },
      skills: [{ name: 'tracked', path: skillPath, paths: { codex: skillPath }, installedAt: new Date().toISOString(), harnesses: ['codex'] }],
      mcpServers: [{
        name: 'alpha-console',
        configPath,
        harness: 'codex',
        configuredAt: new Date().toISOString(),
        fields: { url: valueDigest('https://old.example/mcp'), note: valueDigest('keep-note') },
      }],
    })

    const result = await refreshOwnedInstallation({ harness: 'codex', bundlePath, skillsSource: sourceRoot })

    assert.equal(result.success, true, JSON.stringify(result))
    const final = readFileSync(configPath, 'utf8')
    // Byte-localized edit: the comment, CRLF endings, the unrelated [model]
    // table, and user credentials are preserved exactly; only the owned url
    // value, the removed note line, and the inserted headers line changed.
    const expectedConfig = [
      '# user comment',
      '[model]',
      'name = "gpt-5"  # keep pick',
      '',
      '[mcp_servers.alpha-console]',
      'url = "https://new.example.com/mcp"',
      'user_token = "user-secret"',
      'headers = {}',
      'name = "alpha-console"',
    ].join('\r\n') + '\r\n'
    assert.equal(final, expectedConfig)
    const tracking = await readTrackingFile()
    const tracked = tracking?.mcpServers.find((entry) => entry.name === 'alpha-console')
    // Tracking digests must describe the final bytes, never the stale ones.
    assert.equal(tracked?.fields?.url, valueDigest('https://new.example.com/mcp'))
    assert.equal(tracked?.fields?.note, undefined)
    assert.equal(tracked?.fields?.user_token, valueDigest('user-secret'))
    assert.equal(tracked?.fields?.headers, valueDigest({}))
    assert.equal(tracked?.fields?.name, valueDigest('alpha-console'))
    rmSync(sourceRoot, { recursive: true, force: true })
  })

  it('fails closed without mutating anything when the codex TOML configuration is malformed', async () => {
    const skillPath = path.join(home, '.agents', 'skills', 'tracked')
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
      mcpServers: [{ name: 'fresh-server', url: 'https://example.com/mcp', headers: {} }],
    })
    writeJson(path.join(home, '.agents', '.nodesource-auth.json'), {
      serviceToken: 'token',
      organizationId: 'org',
      saasToken: 'saas',
      consoleUrl: 'https://console.example.com',
      mcpUrl: 'https://example.com/mcp',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })
    const configPath = path.join(home, '.codex', 'config.toml')
    mkdirSync(path.dirname(configPath), { recursive: true })
    const malformedConfig = '# user comment\n[mcp_servers.alpha\nurl = "broken"\n'
    writeFileSync(configPath, malformedConfig)
    writeJson(path.join(home, '.agents', '.nodesource-installed.json'), {
      version: '1.0.0',
      installedAt: new Date().toISOString(),
      harness: 'codex',
      bundleVersions: { codex: '1.0.0' },
      skills: [{ name: 'tracked', path: skillPath, paths: { codex: skillPath }, installedAt: new Date().toISOString(), harnesses: ['codex'] }],
      mcpServers: [],
    })

    const result = await refreshOwnedInstallation({ harness: 'codex', bundlePath, skillsSource: sourceRoot })

    assert.equal(result.success, false, JSON.stringify(result))
    assert.equal(result.error?.code, 'MCP_PARSE_FAILED')
    // Preflight rejection: the render failure happens before any mutation, so
    // no rollback may be attempted.
    assert.notEqual(result.rollbackAttempted, true)
    // Nothing was mutated: the malformed config, the skill bytes, and the
    // tracking record are exactly as they were before the attempt.
    assert.equal(readFileSync(configPath, 'utf8'), malformedConfig)
    assert.equal(readFileSync(path.join(skillPath, 'SKILL.md'), 'utf8'), 'old')
    const tracking = await readTrackingFile()
    assert.equal(tracking?.bundleVersions?.codex, '1.0.0')
    assert.equal(tracking?.mcpServers.length, 0)
    // Zero staging artifacts survive the aborted transaction.
    for (const dir of [path.join(home, '.agents'), path.join(home, '.codex')]) {
      const leftovers = existsSync(dir)
        ? readdirSync(dir).filter((name) => name.includes('.nsolid-stage-'))
        : []
      assert.equal(leftovers.length, 0, `${dir}: ${leftovers.join(', ')}`)
    }
    rmSync(sourceRoot, { recursive: true, force: true })
  })

  it('edits the legacy mcpServers container when the opencode config has no preferred key', async () => {
    const skillPath = path.join(home, '.config', 'opencode', 'skills', 'tracked')
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
      mcpServers: [{ name: 'alpha-console', url: 'https://new.example.com/mcp', headers: {} }],
    })
    writeJson(path.join(home, '.agents', '.nodesource-auth.json'), {
      serviceToken: 'token',
      organizationId: 'org',
      saasToken: 'saas',
      consoleUrl: 'https://console.example.com',
      mcpUrl: 'https://new.example.com/mcp',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })
    const configPath = path.join(home, '.config', 'opencode', 'opencode.jsonc')
    mkdirSync(path.dirname(configPath), { recursive: true })
    writeFileSync(configPath, '{\n  "mcpServers": {\n    "alpha-console": { "url": "https://old.example/mcp", "note": "keep-note" },\n    "user-own": { "url": "https://user.example/mcp" }\n  }\n}\n')
    writeJson(path.join(home, '.agents', '.nodesource-installed.json'), {
      version: '1.0.0',
      installedAt: new Date().toISOString(),
      harness: 'opencode',
      bundleVersions: { opencode: '1.0.0' },
      skills: [{ name: 'tracked', path: skillPath, paths: { opencode: skillPath }, installedAt: new Date().toISOString(), harnesses: ['opencode'] }],
      mcpServers: [{
        name: 'alpha-console',
        configPath,
        harness: 'opencode',
        configuredAt: new Date().toISOString(),
        fields: { url: valueDigest('https://old.example/mcp'), note: valueDigest('keep-note') },
      }],
    })

    const result = await refreshOwnedInstallation({ harness: 'opencode', bundlePath, skillsSource: sourceRoot })

    assert.equal(result.success, true, JSON.stringify(result))
    const final = JSON.parse(readFileSync(configPath, 'utf8')) as { mcp?: Record<string, unknown>, mcpServers?: Record<string, { url?: string, note?: string }> }
    // No duplicate container: the legacy key is the only container and it was
    // edited in place.
    assert.equal(final.mcp, undefined)
    assert.equal(final.mcpServers?.['alpha-console']?.url, 'https://new.example.com/mcp')
    assert.equal(final.mcpServers?.['alpha-console']?.note, undefined)
    assert.deepEqual(final.mcpServers?.['user-own'], { url: 'https://user.example/mcp' })
    const tracking = await readTrackingFile()
    const tracked = tracking?.mcpServers.find((entry) => entry.name === 'alpha-console')
    assert.equal(tracked?.fields?.url, valueDigest('https://new.example.com/mcp'))
    assert.equal(tracked?.fields?.note, undefined)
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

describe('fallback refresh journal-backed canonical MCP path', () => {
  interface JournalFixture {
    identity: FallbackTransactionIdentity
    home: string
    skillPath: string
    linkPath: string
    canonicalPath: string
    trackedConfigPath?: string
    sourceRoot: string
    bundlePath: string
  }

  async function setupJournalFixture (options: { harness: 'claude' | 'pi' | 'codex'; trackedMcp?: boolean }): Promise<JournalFixture> {
    const harness = options.harness
    const trackedConfigPath = path.join(home, 'custom', `${harness}-tracked.json`)
    const canonicalPath = harness === 'claude'
      ? path.join(home, '.claude.json')
      : harness === 'codex'
        ? path.join(home, '.codex', 'config.toml')
        : path.join(home, '.pi', 'agent', 'mcp.json')
    const skillPath = path.join(home, '.agents', 'skills', 'tracked')
    const linkPath = path.join(getHarnessSkillsPath(harness), 'tracked')
    mkdirSync(skillPath, { recursive: true })
    writeFileSync(path.join(skillPath, 'SKILL.md'), 'old tracked')
    mkdirSync(path.dirname(linkPath), { recursive: true })
    if (harness === 'pi') mkdirSync(linkPath, { recursive: true })
    else symlinkSync(skillPath, linkPath, 'dir')

    const alphaRecord = { url: 'https://old.example.com/mcp', headers: { AUTH: 'x' } }
    const mcpServers: unknown[] = []
    const ownedMcpFields: Array<FallbackTransactionIdentity['ownedMcpFields'][number]> = []
    const ownedMcpConfigPaths = [canonicalPath]
    if (options.trackedMcp) {
      mkdirSync(path.dirname(trackedConfigPath), { recursive: true })
      writeFileSync(trackedConfigPath, JSON.stringify({ mcpServers: { 'alpha-console': alphaRecord } }, null, 2))
      mcpServers.push({ name: 'alpha-console', harness, configPath: trackedConfigPath, configuredAt: new Date().toISOString(), fields: { url: valueDigest(alphaRecord.url), headers: valueDigest(alphaRecord.headers) } })
      ownedMcpFields.push({ configPath: trackedConfigPath, server: 'alpha-console', field: 'url', expectedDigest: valueDigest(alphaRecord.url) })
      ownedMcpFields.push({ configPath: trackedConfigPath, server: 'alpha-console', field: 'headers', expectedDigest: valueDigest(alphaRecord.headers) })
      ownedMcpConfigPaths.push(trackedConfigPath)
    }
    writeJson(path.join(home, '.agents', '.nodesource-installed.json'), {
      version: '1.0.0',
      installedAt: new Date().toISOString(),
      harness,
      ...(harness === 'codex' ? { bundleVersions: { codex: '1.0.0' } } : {}),
      skills: [{ name: 'tracked', path: skillPath, paths: { [harness]: skillPath }, installedAt: new Date().toISOString(), harnesses: [harness] }],
      mcpServers,
    })
    writeJson(path.join(home, '.agents', '.nodesource-auth.json'), {
      serviceToken: 'token',
      organizationId: 'org',
      consoleUrl: 'https://console.example.com',
      mcpUrl: 'https://example.com/mcp',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })

    const sourceRoot = mkdtempSync(path.join(os.tmpdir(), 'nsolid-plugin-fallback-source-'))
    const skillSource = path.join(sourceRoot, 'skills', 'tracked')
    mkdirSync(skillSource, { recursive: true })
    writeFileSync(path.join(skillSource, 'SKILL.md'), 'new tracked')
    const bundlePath = path.join(sourceRoot, 'bundle.json')
    writeJson(bundlePath, {
      name: 'nsolid-plugin',
      version: '1.0.1',
      skills: [{ name: 'tracked', path: 'skills/tracked', description: 'tracked' }],
      mcpServers: [{ name: 'nsolid-console', url: 'https://new.example.com/mcp', headers: {} }],
    })

    const trackingPath = getTrackingFilePath()
    const identity: FallbackTransactionIdentity = {
      installationId: `${harness}:fallback`,
      harness,
      trackingPath,
      trackingDigest: trackingDigest(trackingPath)!,
      nonce: randomUUID(),
      ownedSkillPaths: [skillPath],
      ownedLinkPaths: [linkPath],
      ownedMcpFields,
      ownedMcpConfigPaths: ownedMcpConfigPaths.map((value) => path.resolve(value)),
      approvedDestinationRoots: [getSkillsDir(), getHarnessSkillsPath(harness)].map((value) => path.resolve(value)),
    }
    return { identity, home, skillPath, linkPath, canonicalPath, trackedConfigPath: options.trackedMcp ? trackedConfigPath : undefined, sourceRoot, bundlePath }
  }

  it('journals the missing canonical MCP path and installs the first server into it', async () => {
    const fixture = await setupJournalFixture({ harness: 'claude' })
    try {
      let { journal } = await beginFallbackJournal(fixture.identity)
      journal = await markFallbackJournalMutating(journal)
      // The canonical path does not exist yet but is journaled as missing state.
      const canonicalEntry = journal.entries.find((entry) => path.resolve(entry.path) === path.resolve(fixture.canonicalPath))
      assert.ok(canonicalEntry, 'the canonical MCP path must have a journal entry')
      assert.equal(canonicalEntry!.existed, false)

      const result = await refreshOwnedInstallation({ harness: 'claude', bundlePath: fixture.bundlePath, skillsSource: fixture.sourceRoot, transaction: fixture.identity })
      assert.equal(result.success, true)
      assert.equal(result.error, undefined)
      // The first server landed in the previously nonexistent canonical config.
      const written = JSON.parse(readFileSync(fixture.canonicalPath, 'utf8')) as { mcpServers: Record<string, { url: string }> }
      assert.equal(written.mcpServers['nsolid-console'].url, 'https://new.example.com/mcp')

      journal = await captureFallbackJournalState(journal)
      await commitFallbackJournal(journal)
      const tracking = await readTrackingFile()
      const entry = tracking?.mcpServers.find((server) => server.name === 'nsolid-console')
      assert.equal(entry?.configPath, path.resolve(fixture.canonicalPath))
      assert.equal(entry?.fields?.url, valueDigest('https://new.example.com/mcp'))

      const trackingDir = path.dirname(getTrackingFilePath())
      const leftovers = readdirSync(trackingDir).filter((name) => name.includes('.nsolid-'))
      assert.deepEqual(leftovers, [])
      rmSync(fixture.sourceRoot, { recursive: true, force: true })
    } finally {
      rmSync(fixture.sourceRoot, { recursive: true, force: true })
    }
  })

  it('blocks with drift when the canonical MCP path changes after planning', async () => {
    const fixture = await setupJournalFixture({ harness: 'claude' })
    try {
      const { journal } = await beginFallbackJournal(fixture.identity)
      await markFallbackJournalMutating(journal)
      // The environment resolves a different canonical path after planning.
      const movedHome = mkdtempSync(path.join(os.tmpdir(), 'nsolid-plugin-fallback-moved-'))
      const previousHome = process.env.HOME
      const previousUserProfile = process.env.USERPROFILE
      process.env.HOME = movedHome
      // os.homedir() follows USERPROFILE on Windows; redirect both so the
      // canonical path resolution actually moves on every platform.
      process.env.USERPROFILE = movedHome
      let movedCanonicalExists = true
      try {
        const result = await refreshOwnedInstallation({ harness: 'claude', bundlePath: fixture.bundlePath, skillsSource: fixture.sourceRoot, transaction: fixture.identity })
        assert.equal(result.success, false)
        assert.equal(result.error?.code, 'FALLBACK_MCP_DRIFT')
      } finally {
        // Capture the moved-location existence before the cleanup deletes it,
        // otherwise the assertion below would be vacuous.
        movedCanonicalExists = existsSync(path.join(movedHome, '.claude.json'))
        if (previousHome === undefined) delete process.env.HOME
        else process.env.HOME = previousHome
        if (previousUserProfile === undefined) delete process.env.USERPROFILE
        else process.env.USERPROFILE = previousUserProfile
        rmSync(movedHome, { recursive: true, force: true })
      }
      // Neither the planned nor the moved canonical path was created.
      assert.equal(existsSync(fixture.canonicalPath), false)
      assert.equal(movedCanonicalExists, false)
    } finally {
      rmSync(fixture.sourceRoot, { recursive: true, force: true })
    }
  })

  it('removes the links staging temp after failed child runs while journal stages survive', async () => {
    const realLinker = await import('../../../src/skills/skill-linker.js')
    mock.module('../../../src/skills/skill-linker.js', {
      namedExports: {
        ...(realLinker as unknown as Record<string, unknown>),
        materializeSkillLink: async () => {
          // The render preflight already passed and the journal was claimed:
          // this failure happens after the skill staging so the transaction-
          // owned links temp must be cleaned by the finally block while the
          // journal-owned stages survive for parent recovery.
          throw new Error('simulated link materialization failure')
        },
      },
    })
    // @ts-expect-error query-suffixed specifier re-evaluates the module under test
    const { refreshOwnedInstallation: refreshWithFailingLinks } = await import('../../../src/update/fallback-transaction.js?failing-links-staging')

    const fixture = await setupJournalFixture({ harness: 'claude' })
    try {
      const { journal } = await beginFallbackJournal(fixture.identity)
      await markFallbackJournalMutating(journal)

      const result = await refreshWithFailingLinks({ harness: 'claude', bundlePath: fixture.bundlePath, skillsSource: fixture.sourceRoot, transaction: fixture.identity })
      assert.equal(result.success, false)
      assert.equal(result.error?.code, 'FALLBACK_REFRESH_FAILED')
      assert.equal(result.rollbackAttempted, true)
      assert.equal(result.rollbackSucceeded, true)
      assert.equal(readFileSync(path.join(fixture.skillPath, 'SKILL.md'), 'utf8'), 'old tracked')

      // The transaction-owned links staging temp container is gone.
      const harnessDir = path.dirname(fixture.linkPath)
      const harnessDirParent = path.dirname(harnessDir)
      assert.equal(readdirSync(harnessDirParent).some((name) => name.startsWith(`.${path.basename(harnessDir)}.nsolid-stage-`)), false, 'the links staging temp must be removed')
      // The journal-owned stage for the skill survives for parent recovery.
      assert.ok(readdirSync(path.dirname(fixture.skillPath)).some((name) => name.startsWith('.tracked.nsolid-stage-')), 'the journal-owned skill stage must survive')
    } finally {
      mock.reset()
      rmSync(fixture.sourceRoot, { recursive: true, force: true })
    }
  })

  it('rejects foreign server-name collisions in the render preflight without claiming the journal', async () => {
    for (const harness of ['claude', 'pi'] as const) {
      const fixture = await setupJournalFixture({ harness, trackedMcp: true })
      try {
        let { journal } = await beginFallbackJournal(fixture.identity)
        journal = await markFallbackJournalMutating(journal)
        // A foreign server already occupies the new name inside the tracked
        // config: the render preflight must reject the run before the journal
        // is claimed, so nothing is staged and nothing rolls back.
        const tracked = JSON.parse(readFileSync(fixture.trackedConfigPath!, 'utf8')) as { mcpServers: Record<string, Record<string, unknown>> }
        tracked.mcpServers['nsolid-console'] = { url: 'https://foreign.example.com/mcp' }
        writeFileSync(fixture.trackedConfigPath!, JSON.stringify(tracked, null, 2))
        const journalPath = fallbackJournalPath(fixture.identity.trackingPath)
        const journalBefore = readFileSync(journalPath)

        const result = await refreshOwnedInstallation({ harness, bundlePath: fixture.bundlePath, skillsSource: fixture.sourceRoot, transaction: fixture.identity })
        assert.equal(result.success, false)
        assert.equal(result.error?.code, 'MCP_RECONCILIATION_REQUIRED')
        assert.notEqual(result.rollbackAttempted, true)
        // The journal was never claimed or rewritten.
        assert.deepEqual(readFileSync(journalPath), journalBefore)
        // No live byte moved and no staging artifact was created.
        assert.equal(readFileSync(path.join(fixture.skillPath, 'SKILL.md'), 'utf8'), 'old tracked')
        const harnessDir = path.dirname(fixture.linkPath)
        const harnessDirParent = path.dirname(harnessDir)
        assert.equal(readdirSync(harnessDirParent).some((name) => name.startsWith(`.${path.basename(harnessDir)}.nsolid-stage-`)), false)
        assert.equal(readdirSync(path.dirname(fixture.skillPath)).some((name) => name.includes('.nsolid-stage-')), false)
      } finally {
        rmSync(fixture.sourceRoot, { recursive: true, force: true })
      }
    }
  })

  it('stages linked skills through the Windows junction/copy policy when junction creation fails', async () => {
    const realLinker = await import('../../../src/skills/skill-linker.js')
    const materializations: Array<{ linkSource: string, target: string, copySource: string }> = []
    mock.module('../../../src/skills/skill-linker.js', {
      namedExports: {
        ...(realLinker as unknown as Record<string, unknown>),
        materializeSkillLink: async (options: { linkSource: string, target: string, copySource?: string }) => {
          materializations.push({ linkSource: options.linkSource, target: options.target, copySource: options.copySource ?? options.linkSource })
          return realLinker.materializeSkillLink({
            ...options,
            // Simulate Windows without mutating process.platform: junction
            // creation fails with EPERM, so the staged copy must come from the
            // newly prepared staged bytes instead of the live path.
            platform: 'win32',
            fs: {
              symlink: async () => { throw Object.assign(new Error('EPERM: operation not permitted, symlink'), { code: 'EPERM' }) },
              cp: (source: string, destination: string, opts?: { recursive?: boolean, force?: boolean }) => realFsCp(source, destination, opts),
            },
          })
        },
      },
    })
    // Re-import the transaction so its static binding to skill-linker picks
    // up the mocked materializeSkillLink. The query string forces a fresh
    // module evaluation under the active module mock.
    // @ts-expect-error query-suffixed specifier re-evaluates the module under test
    const { refreshOwnedInstallation: refreshWithSimulatedWindows } = await import('../../../src/update/fallback-transaction.js?win32-junction-fallback')

    const fixture = await setupJournalFixture({ harness: 'claude' })
    try {
      const { journal } = await beginFallbackJournal(fixture.identity)
      await markFallbackJournalMutating(journal)

      const result = await refreshWithSimulatedWindows({ harness: 'claude', bundlePath: fixture.bundlePath, skillsSource: fixture.sourceRoot, transaction: fixture.identity })
      assert.equal(result.success, true)

      // The staging policy ran with the final live shared skill path as the
      // junction source and the newly prepared staged bytes as copy source.
      assert.equal(materializations.length, 1, 'fallback staging must materialize staged links through the Windows-safe policy instead of a direct symlink')
      assert.equal(materializations[0].linkSource, path.join(getSkillsDir(), 'tracked'))
      assert.equal(path.basename(materializations[0].copySource), 'tracked')
      assert.match(path.dirname(materializations[0].copySource), /\.nsolid-stage-/)

      // The staged directory (not a symlink) was applied to the live harness
      // path and contains the new bytes.
      assert.equal(lstatSync(fixture.linkPath).isSymbolicLink(), false)
      assert.equal(readFileSync(path.join(fixture.linkPath, 'SKILL.md'), 'utf8'), 'new tracked')

      // The temporary links-stage directory is cleaned after the run.
      const harnessDir = path.dirname(fixture.linkPath)
      const harnessDirParent = path.dirname(harnessDir)
      assert.equal(readdirSync(harnessDirParent).some((name) => name.startsWith(`.${path.basename(harnessDir)}.nsolid-stage-`)), false)
    } finally {
      rmSync(fixture.sourceRoot, { recursive: true, force: true })
    }
  })

  it('reconciles into the preferred container when both MCP containers exist with different values', async () => {
    const previousOpencodeDir = process.env.NSOLID_OPENCODE_SKILLS_DIR
    process.env.NSOLID_OPENCODE_SKILLS_DIR = path.join(home, 'opencode-skills')
    let sourceRoot = ''
    try {
      const destination = path.join(home, 'opencode-skills')
      const skillPath = path.join(destination, 'tracked')
      mkdirSync(skillPath, { recursive: true })
      writeFileSync(path.join(skillPath, 'SKILL.md'), 'old tracked')
      const canonicalPath = path.join(home, '.config', 'opencode', 'opencode.jsonc')
      const legacyUrl = 'https://legacy.example.com/mcp'
      const preferredUrl = 'https://preferred.example.com/mcp'
      const preferredRecord = { url: preferredUrl, headers: { AUTH: 'x' } }
      mkdirSync(path.dirname(canonicalPath), { recursive: true })
      writeFileSync(canonicalPath, JSON.stringify({ mcp: { 'alpha-console': preferredRecord }, mcpServers: { 'alpha-console': { url: legacyUrl } } }, null, 2))
      writeJson(path.join(home, '.agents', '.nodesource-installed.json'), {
        version: '1.0.0',
        installedAt: new Date().toISOString(),
        harness: 'opencode',
        skills: [{ name: 'tracked', path: skillPath, paths: { opencode: skillPath }, installedAt: new Date().toISOString(), harnesses: ['opencode'] }],
        mcpServers: [{ name: 'alpha-console', harness: 'opencode', configPath: canonicalPath, configuredAt: new Date().toISOString(), fields: { url: valueDigest(preferredUrl), headers: valueDigest(preferredRecord.headers) } }],
      })
      writeJson(path.join(home, '.agents', '.nodesource-auth.json'), {
        serviceToken: 'token',
        organizationId: 'org',
        consoleUrl: 'https://console.example.com',
        mcpUrl: 'https://example.com/mcp',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      })
      sourceRoot = mkdtempSync(path.join(os.tmpdir(), 'nsolid-plugin-fallback-source-'))
      mkdirSync(path.join(sourceRoot, 'skills', 'tracked'), { recursive: true })
      writeFileSync(path.join(sourceRoot, 'skills', 'tracked', 'SKILL.md'), 'new tracked')
      const bundlePath = path.join(sourceRoot, 'bundle.json')
      const newUrl = 'https://new.example.com/mcp'
      writeJson(bundlePath, {
        name: 'nsolid-plugin',
        version: '1.0.1',
        skills: [{ name: 'tracked', path: 'skills/tracked', description: 'tracked' }],
        mcpServers: [{ name: 'alpha-console', url: newUrl, headers: {} }],
      })
      const trackingPath = getTrackingFilePath()
      const identity: FallbackTransactionIdentity = {
        installationId: 'opencode:fallback',
        harness: 'opencode',
        trackingPath,
        trackingDigest: trackingDigest(trackingPath)!,
        nonce: randomUUID(),
        ownedSkillPaths: [skillPath],
        ownedLinkPaths: [path.join(getHarnessSkillsPath('opencode'), 'tracked')],
        ownedMcpFields: [
          { configPath: canonicalPath, server: 'alpha-console', field: 'url', expectedDigest: valueDigest(preferredUrl) },
          { configPath: canonicalPath, server: 'alpha-console', field: 'headers', expectedDigest: valueDigest(preferredRecord.headers) },
        ],
        ownedMcpConfigPaths: [path.resolve(canonicalPath)],
        approvedDestinationRoots: [path.resolve(destination)],
      }
      let { journal } = await beginFallbackJournal(identity)
      journal = await markFallbackJournalMutating(journal)
      const result = await refreshOwnedInstallation({ harness: 'opencode', bundlePath, skillsSource: sourceRoot, transaction: identity })
      assert.equal(result.success, true)
      assert.equal(result.error, undefined)
      journal = await captureFallbackJournalState(journal)
      await commitFallbackJournal(journal)
      // The preferred container was reconciled in place; the legacy container
      // is a foreign structure and must survive byte-for-byte.
      const written = parseJsonc(readFileSync(canonicalPath, 'utf8')) as { mcp: Record<string, { url: string }>, mcpServers: Record<string, { url: string }> }
      assert.equal(written.mcp['alpha-console'].url, newUrl)
      assert.equal(written.mcpServers['alpha-console'].url, legacyUrl)
      // Tracking evidence describes the preferred container's post-commit value.
      const tracking = await readTrackingFile()
      const entry = tracking?.mcpServers.find((server) => server.name === 'alpha-console')
      assert.equal(entry?.configPath, path.resolve(canonicalPath))
      assert.equal(entry?.fields?.url, valueDigest(newUrl))
    } finally {
      if (previousOpencodeDir === undefined) delete process.env.NSOLID_OPENCODE_SKILLS_DIR
      else process.env.NSOLID_OPENCODE_SKILLS_DIR = previousOpencodeDir
      if (sourceRoot) rmSync(sourceRoot, { recursive: true, force: true })
    }
  })

  it('blocks a transaction whose approved destination roots are not canonical', async () => {
    const fixture = await setupJournalFixture({ harness: 'claude' })
    try {
      const badIdentity: FallbackTransactionIdentity = {
        ...fixture.identity,
        approvedDestinationRoots: [path.join(home, 'escape', '..')],
      }
      const result = await refreshOwnedInstallation({ harness: 'claude', bundlePath: fixture.bundlePath, skillsSource: fixture.sourceRoot, transaction: badIdentity })
      assert.equal(result.success, false)
      assert.equal(result.error?.code, 'INVALID_TRANSACTION_MANIFEST')
      assert.notEqual(result.rollbackAttempted, true)
      assert.equal(readFileSync(path.join(fixture.skillPath, 'SKILL.md'), 'utf8'), 'old tracked')
    } finally {
      rmSync(fixture.sourceRoot, { recursive: true, force: true })
    }
  })

  it('blocks when the environment resolves a skill destination outside the approved roots', async () => {
    const fixture = await setupJournalFixture({ harness: 'claude' })
    try {
      // Canonical but foreign roots: the environment's destinations are no
      // longer covered by the approved manifest.
      const foreignIdentity: FallbackTransactionIdentity = {
        ...fixture.identity,
        approvedDestinationRoots: [path.join(home, 'other-root')],
      }
      const result = await refreshOwnedInstallation({ harness: 'claude', bundlePath: fixture.bundlePath, skillsSource: fixture.sourceRoot, transaction: foreignIdentity })
      assert.equal(result.success, false)
      assert.equal(result.error?.code, 'INVALID_TRANSACTION_MANIFEST')
      assert.notEqual(result.rollbackAttempted, true)
      // Nothing was created or touched.
      assert.equal(existsSync(path.join(getHarnessSkillsPath('claude'), 'nsolid-console')), false)
      assert.equal(readFileSync(path.join(fixture.skillPath, 'SKILL.md'), 'utf8'), 'old tracked')
    } finally {
      rmSync(fixture.sourceRoot, { recursive: true, force: true })
    }
  })

  it('aborts before claiming the journal when an MCP configuration cannot be parsed', async () => {
    const fixture = await setupJournalFixture({ harness: 'claude' })
    try {
      // The canonical config is where the new bundle server will be planned;
      // corrupt it so the render preflight must fail before any mutation.
      writeFileSync(path.join(home, '.claude.json'), '{ mcpServers: broken')
      const { journal } = await beginFallbackJournal(fixture.identity)
      await markFallbackJournalMutating(journal)
      const journalPath = fallbackJournalPath(fixture.identity.trackingPath)
      const journalBefore = readFileSync(journalPath)

      const result = await refreshOwnedInstallation({ harness: 'claude', bundlePath: fixture.bundlePath, skillsSource: fixture.sourceRoot, transaction: fixture.identity })

      assert.equal(result.success, false)
      assert.notEqual(result.rollbackAttempted, true)
      // The journal was never claimed or rewritten.
      assert.deepEqual(readFileSync(journalPath), journalBefore)
      // No live byte moved.
      assert.equal(readFileSync(path.join(fixture.skillPath, 'SKILL.md'), 'utf8'), 'old tracked')
      // Zero staging artifacts survive the aborted transaction.
      const leftovers = readdirSync(path.join(home, '.agents')).filter((name) => name.includes('.nsolid-stage-'))
      assert.equal(leftovers.length, 0, leftovers.join(', '))
    } finally {
      rmSync(fixture.sourceRoot, { recursive: true, force: true })
    }
  })

  it('aborts before claiming the journal when the codex TOML configuration is malformed', async () => {
    const fixture = await setupJournalFixture({ harness: 'codex' })
    const malformedConfig = '# user comment\n[mcp_servers.alpha\nurl = "broken"\n'
    try {
      // The canonical codex config is where the new bundle server will be
      // planned; corrupt it so the render preflight must fail before any
      // mutation.
      const configPath = path.join(home, '.codex', 'config.toml')
      writeFileSync(configPath, malformedConfig)
      const { journal } = await beginFallbackJournal(fixture.identity)
      await markFallbackJournalMutating(journal)
      const journalPath = fallbackJournalPath(fixture.identity.trackingPath)
      const journalBefore = readFileSync(journalPath)

      const result = await refreshOwnedInstallation({ harness: 'codex', bundlePath: fixture.bundlePath, skillsSource: fixture.sourceRoot, transaction: fixture.identity })

      assert.equal(result.success, false)
      assert.equal(result.error?.code, 'MCP_PARSE_FAILED')
      assert.notEqual(result.rollbackAttempted, true)
      // The journal was never claimed or rewritten.
      assert.deepEqual(readFileSync(journalPath), journalBefore)
      // No live byte moved.
      assert.equal(readFileSync(configPath, 'utf8'), malformedConfig)
      assert.equal(readFileSync(path.join(fixture.skillPath, 'SKILL.md'), 'utf8'), 'old tracked')
      // Zero staging artifacts survive the aborted transaction.
      for (const dir of [path.join(home, '.agents'), path.join(home, '.codex')]) {
        const dirLeftovers = existsSync(dir)
          ? readdirSync(dir).filter((name) => name.includes('.nsolid-stage-'))
          : []
        assert.equal(dirLeftovers.length, 0, `${dir}: ${dirLeftovers.join(', ')}`)
      }
    } finally {
      rmSync(fixture.sourceRoot, { recursive: true, force: true })
    }
  })

  it('removes journaled new destinations on recovery and the next update installs cleanly', async () => {
    const fixture = await setupJournalFixture({ harness: 'claude' })
    const sourceRoot = fixture.sourceRoot
    try {
      // Extend the planned bundle with a brand-new skill and link destination.
      const addedSource = path.join(sourceRoot, 'skills', 'added')
      mkdirSync(addedSource, { recursive: true })
      writeFileSync(path.join(addedSource, 'SKILL.md'), 'new skill')
      writeJson(fixture.bundlePath, {
        name: 'nsolid-plugin',
        version: '1.0.1',
        skills: [
          { name: 'tracked', path: 'skills/tracked', description: 'tracked' },
          { name: 'added', path: 'skills/added', description: 'added' },
        ],
        mcpServers: [{ name: 'nsolid-console', url: 'https://new.example.com/mcp', headers: {} }],
      })
      const addedSkill = path.join(getSkillsDir(), 'added')
      const addedLink = path.join(getHarnessSkillsPath('claude'), 'added')
      assert.equal(existsSync(addedSkill), false)

      let { journal } = await beginFallbackJournal(fixture.identity)
      journal = await markFallbackJournalMutating(journal)
      // The verified child durably appends the new destinations before staging.
      journal = await appendFallbackJournalEntries(journal, [addedSkill, addedLink])
      // Child staging + apply, exactly as the transaction performs it.
      const stagedSkillRoot = mkdtempSync(path.join(path.dirname(addedSkill), `.${path.basename(addedSkill)}.nsolid-stage-`))
      writeFileSync(path.join(stagedSkillRoot, 'SKILL.md'), 'new skill')
      journal = await registerFallbackStage(journal, addedSkill, { directory: stagedSkillRoot })
      journal = await applyFallbackEntry(journal, addedSkill)
      const stagedLinksRoot = mkdtempSync(path.join(path.dirname(addedLink), `.${path.basename(addedLink)}.nsolid-stage-`))
      symlinkSync(addedSkill, path.join(stagedLinksRoot, 'added'), 'dir')
      journal = await registerFallbackStage(journal, addedLink, { directory: path.join(stagedLinksRoot, 'added') })
      journal = await applyFallbackEntry(journal, addedLink)
      // CRASH: the tracking commit never happened but the destinations exist.
      assert.equal(existsSync(addedSkill), true)
      assert.equal(existsSync(addedLink), true)

      // Parent recovery removes the orphan destinations and restores state.
      journal = await reloadFallbackJournal(journal)
      assert.equal(await restoreFallbackJournal(journal), true)
      assert.equal(existsSync(addedSkill), false)
      assert.equal(existsSync(addedLink), false)
      assert.equal(readFileSync(path.join(fixture.skillPath, 'SKILL.md'), 'utf8'), 'old tracked')

      // The next update no longer sees an untracked destination.
      const result = await refreshOwnedInstallation({ harness: 'claude', bundlePath: fixture.bundlePath, skillsSource: sourceRoot })
      assert.equal(result.success, true)
      assert.equal(existsSync(addedSkill), true)
      assert.equal(readFileSync(path.join(addedSkill, 'SKILL.md'), 'utf8'), 'new skill')
    } finally {
      rmSync(sourceRoot, { recursive: true, force: true })
    }
  })
})

describe('fallback refresh multi-config MCP reconciliation', () => {
  it('fails and rolls back when an owned MCP field drifts between planning and apply', async () => {
    const configA = path.join(home, 'custom', 'claude-a.json')
    const alphaRecord = { url: 'https://old.example.com/mcp', headers: { AUTH: 'x' } }
    mkdirSync(path.dirname(configA), { recursive: true })
    writeFileSync(configA, [
      '{',
      '  "mcpServers": {',
      '    "alpha-console": ' + JSON.stringify(alphaRecord),
      '  }',
      '}',
      '',
    ].join('\n'))

    writeJson(path.join(home, '.agents', '.nodesource-auth.json'), {
      serviceToken: 'token',
      organizationId: 'org',
      consoleUrl: 'https://console.example.com',
      mcpUrl: 'https://example.com/mcp',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })
    const sourceRoot = mkdtempSync(path.join(os.tmpdir(), 'nsolid-plugin-fallback-source-'))
    const skillSource = path.join(sourceRoot, 'skills', 'tracked')
    mkdirSync(skillSource, { recursive: true })
    writeFileSync(path.join(skillSource, 'SKILL.md'), 'tracked')
    const bundlePath = path.join(sourceRoot, 'bundle.json')
    writeJson(bundlePath, {
      name: 'nsolid-plugin',
      version: '1.0.1',
      skills: [{ name: 'tracked', path: 'skills/tracked', description: 'tracked' }],
      mcpServers: [{ name: 'alpha-console', url: 'https://new.example.com/mcp', headers: {} }],
    })
    const skillPath = path.join(home, '.agents', 'skills', 'tracked')
    mkdirSync(skillPath, { recursive: true })
    writeFileSync(path.join(skillPath, 'SKILL.md'), 'old tracked')
    writeJson(path.join(home, '.agents', '.nodesource-installed.json'), {
      version: '1.0.0',
      installedAt: new Date().toISOString(),
      harness: 'claude',
      skills: [{ name: 'tracked', path: skillPath, paths: { claude: skillPath }, installedAt: new Date().toISOString(), harnesses: ['claude'] }],
      mcpServers: [
        { name: 'alpha-console', harness: 'claude', configPath: configA, configuredAt: new Date().toISOString(), fields: { url: valueDigest(alphaRecord.url), headers: valueDigest(alphaRecord.headers) } },
      ],
    })

    try {
      // Concurrent drift between planning and the transaction: the owned url
      // was rewritten under our feet.
      const drifted = { url: 'https://evil.example.com/mcp', headers: { AUTH: 'x' } }
      const before = readFileSync(configA, 'utf8')
      const driftedText = before.replace(JSON.stringify(alphaRecord), JSON.stringify(drifted))
      writeFileSync(configA, driftedText)

      const result = await refreshOwnedInstallation({ harness: 'claude', bundlePath, skillsSource: sourceRoot })
      assert.equal(result.success, false)
      assert.equal(result.error?.code, 'FALLBACK_MCP_DRIFT')
      // The drifted bytes are preserved; no owned update was applied.
      assert.equal(readFileSync(configA, 'utf8'), driftedText)
      assert.equal(readFileSync(path.join(skillPath, 'SKILL.md'), 'utf8'), 'old tracked')

      // Sanity: with the pristine bytes the same refresh succeeds.
      writeFileSync(configA, before)
      const retry = await refreshOwnedInstallation({ harness: 'claude', bundlePath, skillsSource: sourceRoot })
      assert.equal(retry.success, true)
      rmSync(sourceRoot, { recursive: true, force: true })
    } finally {
      rmSync(sourceRoot, { recursive: true, force: true })
    }
  })

  it('updates and removes each server in its owning file and routes new servers to the canonical path', async () => {
    const configA = path.join(home, 'custom', 'claude-a.json')
    const configB = path.join(home, 'custom', 'claude-b.json')
    const alphaRecord = { url: 'https://old.example.com/mcp', headers: { AUTH: 'x' } }
    const legacyRecord = { url: 'https://legacy.example.com/mcp', headers: {} }
    // Config A: foreign server with comments plus the owned alpha-console.
    mkdirSync(path.dirname(configA), { recursive: true })
    writeFileSync(configA, [
      '{',
      '  // Foreign configuration comments must survive.',
      '  "mcpServers": {',
      '    "user-server": {"command": "/usr/bin/user-thing"},',
      '    "alpha-console": ' + JSON.stringify(alphaRecord),
      '  }',
      '}',
      '',
    ].join('\n'))
    // Config B: owns the stale legacy-console plus unrelated keys.
    writeJson(configB, { version: 2, mcpServers: { 'legacy-console': legacyRecord } })

    const writeJsonc = (filePath: string, value: unknown): void => {
      mkdirSync(path.dirname(filePath), { recursive: true })
      writeFileSync(filePath, JSON.stringify(value, null, 2))
    }
    writeJsonc(path.join(home, '.agents', '.nodesource-auth.json'), {
      serviceToken: 'token',
      organizationId: 'org',
      consoleUrl: 'https://console.example.com',
      mcpUrl: 'https://example.com/mcp',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })
    const sourceRoot = mkdtempSync(path.join(os.tmpdir(), 'nsolid-plugin-fallback-source-'))
    const skillSource = path.join(sourceRoot, 'skills', 'tracked')
    mkdirSync(skillSource, { recursive: true })
    writeFileSync(path.join(skillSource, 'SKILL.md'), 'tracked')
    const bundlePath = path.join(sourceRoot, 'bundle.json')
    writeJson(bundlePath, {
      name: 'nsolid-plugin',
      version: '1.0.1',
      skills: [{ name: 'tracked', path: 'skills/tracked', description: 'tracked' }],
      mcpServers: [{ name: 'alpha-console', url: 'https://new.example.com/mcp', headers: {} }],
    })
    writeJson(path.join(home, '.agents', '.nodesource-installed.json'), {
      version: '1.0.0',
      installedAt: new Date().toISOString(),
      harness: 'claude',
      skills: [{ name: 'tracked', path: path.join(home, '.agents', 'skills', 'tracked'), paths: { claude: path.join(home, '.agents', 'skills', 'tracked') }, installedAt: new Date().toISOString(), harnesses: ['claude'] }],
      mcpServers: [
        { name: 'alpha-console', harness: 'claude', configPath: configA, configuredAt: new Date().toISOString(), fields: { url: valueDigest(alphaRecord.url), headers: valueDigest(alphaRecord.headers) } },
        { name: 'legacy-console', harness: 'claude', configPath: configB, configuredAt: new Date().toISOString(), fields: { url: valueDigest(legacyRecord.url), headers: valueDigest(legacyRecord.headers) } },
      ],
    })
    mkdirSync(path.join(home, '.agents', 'skills', 'tracked'), { recursive: true })
    writeFileSync(path.join(home, '.agents', 'skills', 'tracked', 'SKILL.md'), 'old tracked')

    try {
      const result = await refreshOwnedInstallation({ harness: 'claude', bundlePath, skillsSource: sourceRoot })
      assert.equal(result.success, true)

      // Config A: alpha-console updated in place; foreign bytes untouched.
      const afterA = readFileSync(configA, 'utf8')
      assert.ok(afterA.includes('// Foreign configuration comments must survive.'))
      assert.ok(afterA.includes('"user-server": {"command": "/usr/bin/user-thing"}'))
      const parsedA = parseJsonc(afterA) as { mcpServers: Record<string, Record<string, unknown>> }
      assert.equal(parsedA.mcpServers['alpha-console'].url, 'https://new.example.com/mcp')

      // Config B: only the stale server was removed there.
      const parsedB = JSON.parse(readFileSync(configB, 'utf8')) as { version: number; mcpServers: Record<string, unknown> }
      assert.equal(parsedB.version, 2)
      assert.deepEqual(parsedB.mcpServers, {})

      // New nsolid-console is absent from the bundle: alpha kept in A, no new server.
      const tracking = await readTrackingFile()
      const alpha = tracking?.mcpServers.find((entry) => entry.name === 'alpha-console')
      assert.equal(alpha?.configPath, path.resolve(configA))
      // Field evidence describes the post-swap bytes, not the pre-update file.
      assert.equal(alpha?.fields?.url, valueDigest('https://new.example.com/mcp'))
      assert.ok(Object.keys(alpha?.fields ?? {}).length > 0)

      rmSync(sourceRoot, { recursive: true, force: true })
    } finally {
      rmSync(sourceRoot, { recursive: true, force: true })
    }
  })
})
