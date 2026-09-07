import { afterEach, beforeEach, describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, rmSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { cp as realFsCp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { refreshOwnedInstallation } from '../../../src/update/fallback-transaction.js'
import { applyFallbackEntry, beginFallbackJournal, claimFallbackJournalMutation, commitFallbackJournal, fallbackJournalPath, manifestDigestOf, markFallbackJournalMutating, pathDigest, pathKind, reclaimFallbackJournalMutation, registerFallbackStage, reloadFallbackJournal, restoreFallbackJournal, setFallbackFrontierPublicationSeamForTests, trackingDigest } from '../../../src/update/fallback-journal.js'
import { valueDigest, readMcpFieldDigests, harnessMcpKey } from '../../../src/update/mcp-lookup.js'
import { randomUUID } from 'node:crypto'
import { FALLBACK_PROTOCOL_VERSION } from '../../../src/update/types.js'
import { FALLBACK_CHILD_RESULT_SCHEMA } from '../../../src/update/fallback-result-protocol.js'
import type { FallbackTransactionIdentity } from '../../../src/update/types.js'
import { getHarnessSkillsPath } from '../../../src/skills/skill-linker.js'
import { getAuthFilePath, getSkillsDir, getTrackingFilePath } from '../../../src/utils/path.js'
import { readTrackingFile } from '../../../src/skills/skill-tracker.js'
import { parseJsonc } from '../../../src/utils/config.js'
import { resolvePackageRoot } from '../../../src/update/version.js'
import { deriveFallbackFrontierLeafTargets, deriveFallbackFrontierPlan, type FallbackFrontierPlan } from '../../../src/update/fallback-frontier.js'
import { getAdapter } from '../../../src/harnesses/index.js'
import type { BundleDescriptor } from '../../../src/types.js'

import { createParentIdentity, refreshWithParent } from '../../helpers/fallback-refresh.js'

let home: string
let previousHome: string | undefined
let previousUserProfile: string | undefined

async function pathEvidence (target: string) {
  const kind = await pathKind(target)
  const digest = kind === 'missing' ? undefined : await pathDigest(target)
  return { path: path.resolve(target), kind, digest }
}

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

function setupSkillSource (skills: Record<string, string>): { sourceRoot: string; bundlePath: string } {
  const sourceRoot = mkdtempSync(path.join(os.tmpdir(), 'nsolid-plugin-fallback-source-'))
  for (const [name, content] of Object.entries(skills)) {
    const directory = path.join(sourceRoot, 'skills', name)
    mkdirSync(directory, { recursive: true })
    writeFileSync(path.join(directory, 'SKILL.md'), content)
  }
  return { sourceRoot, bundlePath: path.join(sourceRoot, 'bundle.json') }
}

/** Keep scenario-specific skills and MCP values visible at each call site. */
function writeBundle (bundlePath: string, skillNames: string[], mcpServers: BundleDescriptor['mcpServers']): void {
  writeJson(bundlePath, {
    name: 'nsolid-plugin',
    version: '1.0.1',
    skills: skillNames.map((name) => ({ name, path: `skills/${name}`, description: name })),
    mcpServers,
  })
}

function writeCredentials (filePath: string, mcpUrl: string, lifetimeMs: number): void {
  writeJson(filePath, {
    serviceToken: 'token',
    organizationId: 'org',
    saasToken: 'saas',
    consoleUrl: 'https://console.example.com',
    mcpUrl,
    expiresAt: new Date(Date.now() + lifetimeMs).toISOString(),
  })
}

describe('fallback refresh transaction', () => {
  it('rejects a missing parent manifest before reading or mutating owned state', async () => {
    const before = readdirSync(home)
    const result = await refreshOwnedInstallation({ harness: 'claude', bundlePath: '/missing/bundle.json', skillsSource: '/missing/package' } as Parameters<typeof refreshOwnedInstallation>[0])
    assert.equal(result.success, false)
    assert.equal(result.error?.code, 'INVALID_TRANSACTION_MANIFEST')
    assert.equal(result.rollbackAttempted, undefined)
    assert.deepEqual(readdirSync(home), before)
  })

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
    writeBundle(bundlePath, ['retained', 'added'], [{ name: 'nsolid-console', url: 'https://example.com/mcp', headers: {} }])
    writeCredentials(path.join(home, '.agents', '.nodesource-auth.json'), 'https://example.com/mcp', 60_000)
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
      const result = await refreshWithParent({ harness: 'claude', bundlePath, skillsSource: sourceRoot })
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

  it('rejects an untracked directory at a new harness link during parent planning', async () => {
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
    writeBundle(bundlePath, ['tracked', 'added'], [{ name: 'nsolid-console', url: 'https://example.com/mcp', headers: {} }])
    writeJson(path.join(home, '.agents', '.nodesource-installed.json'), {
      version: '1.0.0',
      installedAt: new Date().toISOString(),
      harness: 'claude',
      bundleVersions: { claude: '1.0.0' },
      skills: [{ name: 'tracked', path: path.join(sharedDir, 'tracked'), paths: { claude: path.join(sharedDir, 'tracked') }, installedAt: new Date().toISOString(), harnesses: ['claude'] }],
      mcpServers: [],
    })

    const result = await refreshWithParent({ harness: 'claude', bundlePath, skillsSource: sourceRoot })

    assert.equal(result.success, false)
    assert.equal(result.error?.code, 'FALLBACK_FRONTIER_LEAF_KIND_MISMATCH')
    assert.equal(existsSync(path.join(harnessDir, 'added', 'user-owned.txt')), true)
    // Even if a caller bypasses the parent's leaf planner, the child keeps
    // its independent collision guard and rejects before claiming a journal.
    const transaction = await createParentIdentity({ harness: 'claude' })
    const child = await refreshOwnedInstallation({ harness: 'claude', bundlePath, skillsSource: sourceRoot, transaction })
    assert.equal(child.error?.code, 'UNTRACKED_DESTINATION')
    assert.equal(existsSync(path.join(harnessDir, 'added', 'user-owned.txt')), true)
    assert.equal(existsSync(fallbackJournalPath(getTrackingFilePath())), false)
    rmSync(sourceRoot, { recursive: true, force: true })
  })

  it('does not roll back or delete owned state when planning rejects a kind-conflicted destination', async () => {
    // A tracked skill destination that is a plain file contradicts the role
    // its leaf requires. Per the frontier binding decision this is rejected
    // during local planning — BEFORE journal reservation or any snapshot —
    // with the precise FALLBACK_FRONTIER_LEAF_KIND_MISMATCH code, and the
    // owned state must remain exactly as it was.
    const sourceRoot = mkdtempSync(path.join(os.tmpdir(), 'nsolid-plugin-fallback-source-'))
    const skillSource = path.join(sourceRoot, 'skills', 'tracked')
    mkdirSync(skillSource, { recursive: true })
    writeFileSync(path.join(skillSource, 'SKILL.md'), 'new')
    const longPath = path.join(home, ...Array.from({ length: 4 }, () => 'a'.repeat(70)), 'tracked')
    mkdirSync(path.dirname(longPath), { recursive: true })
    writeFileSync(longPath, 'original')
    const bundlePath = path.join(sourceRoot, 'bundle.json')
    writeBundle(bundlePath, ['tracked'], [{ name: 'nsolid-console', url: 'https://example.com/mcp', headers: {} }])
    writeJson(path.join(home, '.agents', '.nodesource-installed.json'), {
      version: '1.0.0',
      installedAt: new Date().toISOString(),
      harness: 'opencode',
      bundleVersion: '1.0.0',
      skills: [{ name: 'tracked', path: longPath, paths: { opencode: longPath }, installedAt: new Date().toISOString(), harnesses: ['opencode'] }],
      mcpServers: [],
    })
    // Valid credentials let the MCP reconciliation gate pass so the run
    // reaches local planning, which must reject the kind conflict before any
    // journal or snapshot state exists.
    writeCredentials(path.join(home, '.agents', '.nodesource-auth.json'), 'https://example.com/mcp', 60_000)

    const result = await refreshWithParent({ harness: 'opencode', bundlePath, skillsSource: sourceRoot })

    assert.equal(result.success, false)
    assert.equal(result.error?.code, 'FALLBACK_FRONTIER_LEAF_KIND_MISMATCH')
    assert.notEqual(result.rollbackAttempted, true)
    assert.equal(existsSync(fallbackJournalPath(getTrackingFilePath())), false)
    assert.equal(readFileSync(longPath, 'utf8'), 'original')
    rmSync(sourceRoot, { recursive: true, force: true })
  })

  it('does not advance fallback evidence when MCP reconciliation is skipped', async () => {
    const sharedDir = path.join(home, '.agents', 'skills')
    const skillPath = path.join(sharedDir, 'tracked')
    mkdirSync(skillPath, { recursive: true })
    writeFileSync(path.join(skillPath, 'SKILL.md'), 'old')
    const { sourceRoot, bundlePath } = setupSkillSource({ tracked: 'new' })
    writeBundle(bundlePath, ['tracked'], [{ name: 'new-server', url: 'https://example.com/mcp', headers: {} }])
    const configPath = path.join(home, '.claude.json')
    writeJson(configPath, { mcpServers: { 'old-server': { type: 'http', url: 'https://old.example/mcp' } } })
    writeJson(path.join(home, '.agents', '.nodesource-installed.json'), {
      version: '1.0.0',
      installedAt: new Date().toISOString(),
      harness: 'claude',
      bundleVersion: '1.0.0',
      bundleVersions: { claude: '1.0.0' },
      skills: [{ name: 'tracked', path: skillPath, paths: { claude: skillPath }, installedAt: new Date().toISOString(), harnesses: ['claude'] }],
      mcpServers: [{ name: 'old-server', configPath, harness: 'claude', configuredAt: new Date().toISOString(), fields: { type: valueDigest('http'), url: valueDigest('https://old.example/mcp') } }],
    })

    const result = await refreshWithParent({ harness: 'claude', bundlePath, skillsSource: sourceRoot })

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
    const { sourceRoot, bundlePath } = setupSkillSource({ tracked: 'new' })
    writeBundle(bundlePath, ['tracked'], [{ name: 'new-server', url: 'https://example.com/mcp', headers: {} }])
    writeCredentials(path.join(home, '.agents', '.nodesource-auth.json'), 'https://example.com/mcp', 60_000)
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

    const result = await refreshWithParent({ harness: 'opencode', bundlePath, skillsSource: sourceRoot })

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
    const { sourceRoot, bundlePath } = setupSkillSource({ tracked: 'new' })
    writeBundle(bundlePath, ['tracked'], [{ name: 'alpha-console', url: 'https://new.example.com/mcp', headers: {} }])
    writeCredentials(path.join(home, '.agents', '.nodesource-auth.json'), 'https://new.example.com/mcp', 60_000)
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

    const result = await refreshWithParent({ harness: 'codex', bundlePath, skillsSource: sourceRoot })

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
    ].join('\r\n') + '\r\n'
    assert.equal(final, expectedConfig)
    const tracking = await readTrackingFile()
    const tracked = tracking?.mcpServers.find((entry) => entry.name === 'alpha-console')
    // Tracking digests must describe the final bytes, never the stale ones.
    assert.equal(tracked?.fields?.url, valueDigest('https://new.example.com/mcp'))
    assert.equal(tracked?.fields?.note, undefined)
    // user_token survived refresh #1 in the config bytes; tracking must not
    // record it as owned, or refresh #2 would delete it.
    assert.equal(tracked?.fields?.user_token, undefined)
    assert.equal(tracked?.fields?.headers, valueDigest({}))
    // The server's name is entry metadata, not a rendered field: it must never
    // be written into the entry or claimed as ownership evidence.
    assert.equal(tracked?.fields?.name, undefined)
    rmSync(sourceRoot, { recursive: true, force: true })
  })

  it('never tracks foreign MCP fields and preserves them across two refreshes of the same bundle', async () => {
    // Reviewer scenario: refresh #1 records digests of every field present in
    // the staged bytes (including a user-added user_token); refresh #2 then
    // deletes it because reconciliation removes tracked fields absent from
    // the desired render. Tracking must only ever describe desired-render
    // fields so a foreign field survives both refreshes.
    const skillPath = path.join(home, '.agents', 'skills', 'tracked')
    mkdirSync(skillPath, { recursive: true })
    writeFileSync(path.join(skillPath, 'SKILL.md'), 'old')
    const { sourceRoot, bundlePath } = setupSkillSource({ tracked: 'new' })
    writeBundle(bundlePath, ['tracked'], [{ name: 'alpha-console', url: 'https://new.example.com/mcp', headers: {} }])
    writeCredentials(path.join(home, '.agents', '.nodesource-auth.json'), 'https://new.example.com/mcp', 120_000)
    const configPath = path.join(home, '.codex', 'config.toml')
    mkdirSync(path.dirname(configPath), { recursive: true })
    const originalConfig = [
      '[mcp_servers.alpha-console]',
      'url = "https://old.example.com/mcp"',
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
        fields: { url: valueDigest('https://old.example.com/mcp') },
      }],
    })

    const first = await refreshWithParent({ harness: 'codex', bundlePath, skillsSource: sourceRoot })
    assert.equal(first.success, true, JSON.stringify(first))

    const configAfterFirst = readFileSync(configPath, 'utf8')
    assert.equal(configAfterFirst.includes('user_token = "user-secret"'), true, 'refresh #1 must leave the foreign field in the config bytes')
    const trackingAfterFirst = await readTrackingFile()
    const trackedAfterFirst = trackingAfterFirst?.mcpServers.find((entry) => entry.name === 'alpha-console')
    // Only the desired-render fields enter tracking; user_token is foreign.
    assert.deepEqual(Object.keys(trackedAfterFirst?.fields ?? {}).sort(), ['headers', 'url'])
    assert.equal(trackedAfterFirst?.fields?.url, valueDigest('https://new.example.com/mcp'))

    const second = await refreshWithParent({ harness: 'codex', bundlePath, skillsSource: sourceRoot })
    assert.equal(second.success, true, JSON.stringify(second))

    // Reviewer's exact regression: refresh #2 of the same bundle must not
    // delete the user-owned field.
    const configAfterSecond = readFileSync(configPath, 'utf8')
    assert.equal(configAfterSecond.includes('user_token = "user-secret"'), true, 'refresh #2 must not delete the foreign field it never owned')
    const trackingAfterSecond = await readTrackingFile()
    const trackedAfterSecond = trackingAfterSecond?.mcpServers.find((entry) => entry.name === 'alpha-console')
    assert.deepEqual(Object.keys(trackedAfterSecond?.fields ?? {}).sort(), ['headers', 'url'])
    assert.equal(trackedAfterSecond?.fields?.url, valueDigest('https://new.example.com/mcp'))
    rmSync(sourceRoot, { recursive: true, force: true })
  })

  it('keeps tracking desired-field digests updated when a desired value changes between refreshes', async () => {
    const skillPath = path.join(home, '.agents', 'skills', 'tracked')
    mkdirSync(skillPath, { recursive: true })
    writeFileSync(path.join(skillPath, 'SKILL.md'), 'old')
    const sourceRoot = mkdtempSync(path.join(os.tmpdir(), 'nsolid-plugin-fallback-source-'))
    const bundleVersion = (url: string): unknown => ({
      name: 'nsolid-plugin',
      version: '1.0.1',
      skills: [{ name: 'tracked', path: 'skills/tracked', description: 'tracked' }],
      mcpServers: [{ name: 'alpha-console', url, headers: {} }],
    })
    mkdirSync(path.join(sourceRoot, 'skills', 'tracked'), { recursive: true })
    writeFileSync(path.join(sourceRoot, 'skills', 'tracked', 'SKILL.md'), 'new')
    const bundlePath = path.join(sourceRoot, 'bundle.json')
    writeJson(bundlePath, bundleVersion('https://one.example.com/mcp'))
    writeCredentials(path.join(home, '.agents', '.nodesource-auth.json'), 'https://one.example.com/mcp', 120_000)
    const configPath = path.join(home, '.codex', 'config.toml')
    mkdirSync(path.dirname(configPath), { recursive: true })
    const originalConfig = [
      '[mcp_servers.alpha-console]',
      'url = "https://old.example.com/mcp"',
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
        fields: { url: valueDigest('https://old.example.com/mcp') },
      }],
    })

    const first = await refreshWithParent({ harness: 'codex', bundlePath, skillsSource: sourceRoot })
    assert.equal(first.success, true, JSON.stringify(first))
    const trackingAfterFirst = await readTrackingFile()
    const trackedAfterFirst = trackingAfterFirst?.mcpServers.find((entry) => entry.name === 'alpha-console')
    assert.equal(trackedAfterFirst?.fields?.url, valueDigest('https://one.example.com/mcp'))

    // Second refresh with a changed desired value: owned fields keep their
    // digests updated while the foreign field survives untouched.
    writeJson(bundlePath, bundleVersion('https://two.example.com/mcp'))
    writeCredentials(path.join(home, '.agents', '.nodesource-auth.json'), 'https://two.example.com/mcp', 120_000)
    const second = await refreshWithParent({ harness: 'codex', bundlePath, skillsSource: sourceRoot })
    assert.equal(second.success, true, JSON.stringify(second))

    const configAfterSecond = readFileSync(configPath, 'utf8')
    assert.equal(configAfterSecond.includes('url = "https://two.example.com/mcp"'), true)
    assert.equal(configAfterSecond.includes('user_token = "user-secret"'), true, 'the foreign field survives a desired-value change it does not own')
    const trackingAfterSecond = await readTrackingFile()
    const trackedAfterSecond = trackingAfterSecond?.mcpServers.find((entry) => entry.name === 'alpha-console')
    assert.equal(trackedAfterSecond?.fields?.url, valueDigest('https://two.example.com/mcp'))
    assert.deepEqual(Object.keys(trackedAfterSecond?.fields ?? {}).sort(), ['headers', 'url'])
    rmSync(sourceRoot, { recursive: true, force: true })
  })

  it('fails closed without mutating anything when the codex TOML configuration is malformed', async () => {
    const skillPath = path.join(home, '.agents', 'skills', 'tracked')
    mkdirSync(skillPath, { recursive: true })
    writeFileSync(path.join(skillPath, 'SKILL.md'), 'old')
    const { sourceRoot, bundlePath } = setupSkillSource({ tracked: 'new' })
    writeBundle(bundlePath, ['tracked'], [{ name: 'fresh-server', url: 'https://example.com/mcp', headers: {} }])
    writeCredentials(path.join(home, '.agents', '.nodesource-auth.json'), 'https://example.com/mcp', 60_000)
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

    const result = await refreshWithParent({ harness: 'codex', bundlePath, skillsSource: sourceRoot })

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
    const { sourceRoot, bundlePath } = setupSkillSource({ tracked: 'new' })
    writeBundle(bundlePath, ['tracked'], [{ name: 'alpha-console', url: 'https://new.example.com/mcp', headers: {} }])
    writeCredentials(path.join(home, '.agents', '.nodesource-auth.json'), 'https://new.example.com/mcp', 60_000)
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

    const result = await refreshWithParent({ harness: 'opencode', bundlePath, skillsSource: sourceRoot })

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
    const { sourceRoot, bundlePath } = setupSkillSource({ retained: 'new' })
    writeBundle(bundlePath, ['retained'], [{ name: 'nsolid-console', url: 'https://example.com/mcp', headers: {} }])
    writeCredentials(path.join(home, '.agents', '.nodesource-auth.json'), 'https://example.com/mcp', 60_000)
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

    const result = await refreshWithParent({ harness: 'claude', bundlePath, skillsSource: sourceRoot })

    assert.equal(result.success, true, JSON.stringify(result))
    const tracking = await readTrackingFile()
    const dropped = tracking?.skills.find((entry) => entry.name === 'dropped')
    assert.equal(dropped?.path, codexRemainingPath)
    assert.deepEqual(dropped?.harnesses, ['codex'])
    rmSync(sourceRoot, { recursive: true, force: true })
  })

  it('rejects a bundle whose version does not match its package manifest', async () => {
    const sharedDir = path.join(home, '.config', 'opencode', 'skills')
    const skillPath = path.join(sharedDir, 'tracked')
    mkdirSync(skillPath, { recursive: true })
    writeFileSync(path.join(skillPath, 'SKILL.md'), 'old')
    const sourceRoot = mkdtempSync(path.join(os.tmpdir(), 'nsolid-plugin-fallback-source-'))
    mkdirSync(path.join(sourceRoot, 'skills', 'tracked'), { recursive: true })
    writeFileSync(path.join(sourceRoot, 'skills', 'tracked', 'SKILL.md'), 'new')
    writeJson(path.join(sourceRoot, 'package.json'), { name: 'nsolid-plugin', version: '1.0.2' })
    const bundlePath = path.join(sourceRoot, 'bundle.json')
    writeBundle(bundlePath, ['tracked'], [{ name: 'nsolid-console', url: 'https://example.com/mcp', headers: {} }])
    writeJson(path.join(home, '.agents', '.nodesource-installed.json'), {
      version: '1.0.0',
      installedAt: new Date().toISOString(),
      harness: 'opencode',
      bundleVersions: { opencode: '1.0.0' },
      skills: [{ name: 'tracked', path: skillPath, paths: { opencode: skillPath }, installedAt: new Date().toISOString(), harnesses: ['opencode'] }],
      mcpServers: [],
    })

    const result = await refreshWithParent({ harness: 'opencode', bundlePath, skillsSource: sourceRoot })

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
    writeBundle(bundlePath, ['tracked'], [{ name: 'nsolid-console', url: 'https://new.example.com/mcp', headers: {} }])

    const trackingPath = getTrackingFilePath()
    const identity: FallbackTransactionIdentity = {
      installationId: `${harness}:fallback`,
      harness,
      trackingPath,
      trackingDigest: trackingDigest(trackingPath)!,
      protocolVersion: FALLBACK_PROTOCOL_VERSION,
      nonce: randomUUID(),
      plannedMissingFrontiers: [],
      ownedSkills: [await pathEvidence(skillPath)],
      ownedLinks: [await pathEvidence(linkPath)],
      ownedMcpFields,
      ownedMcpConfigPaths: await Promise.all(ownedMcpConfigPaths.map((value) => pathEvidence(value))),
      bundleDestinations: [
        await pathEvidence(path.join(getSkillsDir(), 'tracked')),
        await pathEvidence(path.join(getHarnessSkillsPath(harness), 'tracked')),
      ],
      approvedDestinationRoots: [getSkillsDir(), getHarnessSkillsPath(harness)].map((value) => path.resolve(value)),
    }
    return { identity, home, skillPath, linkPath, canonicalPath, trackedConfigPath: options.trackedMcp ? trackedConfigPath : undefined, sourceRoot, bundlePath }
  }

  it('rejects a transaction manifest whose frontier evidence is absent or malformed before any journal state exists', async () => {
    const fixture = await setupJournalFixture({ harness: 'claude' })
    try {
      const absent: Record<string, unknown> = { ...fixture.identity }
      delete absent.plannedMissingFrontiers
      const malformed = {
        ...fixture.identity,
        plannedMissingFrontiers: [{
          frontierPath: path.join(fixture.home, 'missing-parent'),
          activation: 'required',
          anchor: { path: fixture.home },
          leaves: [],
        }],
      }
      for (const broken of [absent, malformed]) {
        const result = await refreshOwnedInstallation({
          harness: fixture.identity.harness,
          bundlePath: fixture.bundlePath,
          skillsSource: fixture.sourceRoot,
          transaction: broken as unknown as FallbackTransactionIdentity,
        })
        assert.equal(result.success, false)
        assert.equal(result.error?.code, 'FALLBACK_FRONTIER_EVIDENCE_INVALID')
        // The preflight gate fires before the journal reservation: no journal
        // state may exist for frontier evidence that fails strict parsing.
        assert.equal(existsSync(fallbackJournalPath(getTrackingFilePath())), false)
      }
    } finally {
      rmSync(fixture.sourceRoot, { recursive: true, force: true })
    }
  })

  it('journals the missing canonical MCP path and installs the first server into it', async () => {
    const fixture = await setupJournalFixture({ harness: 'claude' })
    try {
      // The parent began the journal and advanced it to mutating before the
      // child claimed it; the destructured handle is the live journal state.
      let { handle: journal } = await beginFallbackJournal(fixture.identity)
      journal = await markFallbackJournalMutating(journal)
      // The canonical path does not exist yet but is journaled as missing state.
      const disk = await reloadFallbackJournal(journal)
      const canonicalEntry = disk.entries.find((entry) => path.resolve(entry.path) === path.resolve(fixture.canonicalPath))
      assert.ok(canonicalEntry, 'the canonical MCP path must have a journal entry')
      assert.equal(canonicalEntry!.existed, false)

      const result = await refreshOwnedInstallation({ harness: 'claude', bundlePath: fixture.bundlePath, skillsSource: fixture.sourceRoot, transaction: fixture.identity })
      assert.equal(result.success, true)
      assert.equal(result.error, undefined)
      // The first server landed in the previously nonexistent canonical config.
      const written = JSON.parse(readFileSync(fixture.canonicalPath, 'utf8')) as { mcpServers: Record<string, { url: string }> }
      assert.equal(written.mcpServers['nsolid-console'].url, 'https://new.example.com/mcp')

      // External child success: the applied journal remains mutating for the
      // waiting parent — a mutator must never reclaim or commit a journal
      // owned by another process.
      assert.equal(existsSync(fallbackJournalPath(getTrackingFilePath())), true, 'an external child must leave the applied journal for its parent')
      // Parent completion: reclaim owner authority, prove the applied state
      // from the strictly reloaded journal plus the live filesystem, and
      // commit with the journal as the single snapshot: the journal file is
      // removed last, so its absence is the observable commit proof.
      const ownerHandle = await reclaimFallbackJournalMutation(journal)
      const proven = await reloadFallbackJournal(ownerHandle)
      for (const entry of proven.entries) {
        if (entry.stageDigest !== undefined) {
          assert.equal(entry.applied, true, `entry ${entry.path} must be applied`)
          assert.equal(await pathDigest(entry.path), entry.stageDigest, `entry ${entry.path} must hold its staged digest`)
        }
      }
      await commitFallbackJournal(ownerHandle)
      assert.equal(existsSync(fallbackJournalPath(getTrackingFilePath())), false, 'the parent commit must remove the journal')
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
      const { handle: journal } = await beginFallbackJournal(fixture.identity)
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
      const { handle: journal } = await beginFallbackJournal(fixture.identity)
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
      // Child-owned rollback: with the mutator capabilities still in this
      // process, a successful restore authenticated-cleans the journal-owned
      // stage containers too; nothing survives a proven rollback.
      assert.equal(readdirSync(path.dirname(fixture.skillPath)).some((name) => name.startsWith('.tracked.nsolid-stage-')), false, 'a proven rollback must clean authenticated stage containers')
      assert.equal(readFileSync(path.join(fixture.skillPath, 'SKILL.md'), 'utf8'), 'old tracked')
    } finally {
      mock.reset()
      rmSync(fixture.sourceRoot, { recursive: true, force: true })
    }
  })

  it('rejects foreign server-name collisions in the render preflight without claiming the journal', async () => {
    for (const harness of ['claude', 'pi'] as const) {
      const fixture = await setupJournalFixture({ harness, trackedMcp: true })
      try {
        // A foreign server already occupies the new name inside the tracked
        // config at planning time: the manifest's whole-file evidence captures
        // those bytes, and the render preflight must reject the run before the
        // journal is claimed, so nothing is staged and nothing rolls back.
        const tracked = JSON.parse(readFileSync(fixture.trackedConfigPath!, 'utf8')) as { mcpServers: Record<string, Record<string, unknown>> }
        tracked.mcpServers['nsolid-console'] = { url: 'https://foreign.example.com/mcp' }
        writeFileSync(fixture.trackedConfigPath!, JSON.stringify(tracked, null, 2))
        const identity: FallbackTransactionIdentity = {
          ...fixture.identity,
          ownedMcpConfigPaths: await Promise.all(fixture.identity.ownedMcpConfigPaths.map(async (entry) =>
            path.resolve(entry.path) === path.resolve(fixture.trackedConfigPath!) ? await pathEvidence(fixture.trackedConfigPath!) : entry)),
        }
        const { handle: journal } = await beginFallbackJournal(identity)
        await markFallbackJournalMutating(journal)
        const journalPath = fallbackJournalPath(identity.trackingPath)
        const journalBefore = readFileSync(journalPath)

        const result = await refreshOwnedInstallation({ harness, bundlePath: fixture.bundlePath, skillsSource: fixture.sourceRoot, transaction: identity })
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
        // The unclaimed prepared journal belongs to this test's own begin;
        // remove it so the next loop iteration's begin is not busy.
        rmSync(fallbackJournalPath(identity.trackingPath), { force: true })
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
      const { handle: journal } = await beginFallbackJournal(fixture.identity)
      await markFallbackJournalMutating(journal)

      const originalPlatform = process.platform
      let result
      try {
        Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
        result = await refreshWithSimulatedWindows({ harness: 'claude', bundlePath: fixture.bundlePath, skillsSource: fixture.sourceRoot, transaction: fixture.identity })
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
      }
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

      // External child success leaves the applied journal for the parent;
      // the parent reclaims, proves, and commits before the run is complete
      // and the applied live update survives the commit.
      const ownerHandle = await reclaimFallbackJournalMutation(journal)
      const proven = await reloadFallbackJournal(ownerHandle)
      for (const entry of proven.entries) {
        if (entry.stageDigest !== undefined) assert.equal(entry.applied, true, `entry ${entry.path} must be applied`)
      }
      await commitFallbackJournal(ownerHandle)
      assert.equal(existsSync(fallbackJournalPath(getTrackingFilePath())), false, 'the parent commit must remove the journal')
      assert.equal(readFileSync(path.join(fixture.linkPath, 'SKILL.md'), 'utf8'), 'new tracked')

      // SECOND refresh under the same simulated Windows policy: the committed
      // state refreshes again through a fresh parent journal flow, the junction
      // still fails, and the copied directory again binds to the registered
      // newly staged bytes instead of the live directory.
      const secondOriginalPlatform = process.platform
      let second
      try {
        Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
        second = await refreshWithParent({ harness: 'claude', bundlePath: fixture.bundlePath, skillsSource: fixture.sourceRoot }, refreshWithSimulatedWindows)
      } finally {
        Object.defineProperty(process, 'platform', { value: secondOriginalPlatform, configurable: true })
      }
      assert.equal(second.success, true, JSON.stringify(second))
      assert.equal(materializations.length, 2, 'the second refresh must materialize the staged link through the same Windows-safe policy')
      assert.equal(lstatSync(fixture.linkPath).isSymbolicLink(), false)
      assert.equal(readFileSync(path.join(fixture.linkPath, 'SKILL.md'), 'utf8'), 'new tracked')
      assert.equal(existsSync(fallbackJournalPath(getTrackingFilePath())), false, 'the second parent run must commit and remove its journal')
      assert.equal(readdirSync(harnessDirParent).some((name) => name.startsWith(`.${path.basename(harnessDir)}.nsolid-stage-`)), false)
    } finally {
      rmSync(fixture.sourceRoot, { recursive: true, force: true })
    }
  })

  it('refreshes a Pi owned copied link twice, binding each copy to the newly staged skill bytes', async () => {
    const fixture = await setupJournalFixture({ harness: 'pi' })
    try {
      // The existing Pi link is a real copied directory holding the OLD live
      // bytes; the staged bundle carries different NEW bytes.
      writeFileSync(path.join(fixture.linkPath, 'SKILL.md'), 'old tracked')
      const linkParent = path.dirname(fixture.linkPath)
      for (const round of [1, 2]) {
        const result = await refreshWithParent({ harness: 'pi', bundlePath: fixture.bundlePath, skillsSource: fixture.sourceRoot })
        assert.equal(result.success, true, `refresh #${round} failed: ${JSON.stringify(result)}`)
        // The shared skill and the Pi copied link both hold the NEW staged
        // bytes; the copy is a real directory, not a symlink.
        assert.equal(readFileSync(path.join(fixture.skillPath, 'SKILL.md'), 'utf8'), 'new tracked')
        assert.equal(lstatSync(fixture.linkPath).isSymbolicLink(), false, 'the Pi link must remain a real copied directory')
        assert.equal(readFileSync(path.join(fixture.linkPath, 'SKILL.md'), 'utf8'), 'new tracked')
        // No stage containers and no journal survive a completed local run.
        assert.equal(readdirSync(linkParent).some((name) => name.startsWith(`.${path.basename(fixture.linkPath)}.nsolid-stage-`)), false)
        assert.equal(existsSync(fallbackJournalPath(getTrackingFilePath())), false)
      }
    } finally {
      rmSync(fallbackJournalPath(getTrackingFilePath()), { force: true })
      rmSync(fixture.sourceRoot, { recursive: true, force: true })
    }
  })

  it('publishes a missing Pi link root as copied directories bound to the registered skill bytes', async () => {
    const fixture = await setupJournalFixture({ harness: 'pi' })
    try {
      // The entire Pi link root is missing: local planning derives a
      // link-root frontier whose link leaves materialize as directory copies
      // bound to the registered staged skill payloads.
      rmSync(path.dirname(fixture.linkPath), { recursive: true, force: true })
      assert.equal(existsSync(fixture.linkPath), false)
      const result = await refreshWithParent({ harness: 'pi', bundlePath: fixture.bundlePath, skillsSource: fixture.sourceRoot })
      assert.equal(result.success, true, JSON.stringify(result))
      assert.equal(readFileSync(path.join(fixture.skillPath, 'SKILL.md'), 'utf8'), 'new tracked')
      assert.equal(existsSync(fixture.linkPath), true)
      assert.equal(lstatSync(fixture.linkPath).isSymbolicLink(), false, 'the published Pi link must be a real copied directory')
      assert.equal(readFileSync(path.join(fixture.linkPath, 'SKILL.md'), 'utf8'), 'new tracked')
      assert.equal(existsSync(fallbackJournalPath(getTrackingFilePath())), false)
      // The frontier stage container lives next to the link root under
      // ~/.pi/agent and must be cleaned after the run.
      assert.equal(readdirSync(path.dirname(path.dirname(fixture.linkPath))).some((name) => name.includes('.nsolid-stage-')), false)
    } finally {
      rmSync(fallbackJournalPath(getTrackingFilePath()), { force: true })
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
      writeBundle(bundlePath, ['tracked'], [{ name: 'alpha-console', url: newUrl, headers: {} }])
      const trackingPath = getTrackingFilePath()
      const identity: FallbackTransactionIdentity = {
        installationId: 'opencode:fallback',
        harness: 'opencode',
        trackingPath,
        trackingDigest: trackingDigest(trackingPath)!,
        protocolVersion: FALLBACK_PROTOCOL_VERSION,
        nonce: randomUUID(),
        plannedMissingFrontiers: [],
        ownedSkills: [await pathEvidence(skillPath)],
        ownedLinks: [],
        ownedMcpFields: [
          { configPath: canonicalPath, server: 'alpha-console', field: 'url', expectedDigest: valueDigest(preferredUrl) },
          { configPath: canonicalPath, server: 'alpha-console', field: 'headers', expectedDigest: valueDigest(preferredRecord.headers) },
        ],
        ownedMcpConfigPaths: [await pathEvidence(canonicalPath)],
        bundleDestinations: [await pathEvidence(path.join(destination, 'tracked'))],
        approvedDestinationRoots: [path.resolve(destination)],
      }
      let { handle: journal } = await beginFallbackJournal(identity)
      journal = await markFallbackJournalMutating(journal)
      // Pre-mutation seam: the preferred MCP container is journaled with its
      // planning-time evidence before any live byte moves.
      const journaled = await reloadFallbackJournal(journal)
      const canonicalEntry = journaled.entries.find((entry) => path.resolve(entry.path) === path.resolve(canonicalPath))
      assert.ok(canonicalEntry, 'the preferred MCP container must have a journal entry')
      assert.equal(canonicalEntry!.existed, true)
      assert.equal(canonicalEntry!.digest, identity.ownedMcpConfigPaths[0]!.digest)
      const result = await refreshOwnedInstallation({ harness: 'opencode', bundlePath, skillsSource: sourceRoot, transaction: identity })
      assert.equal(result.success, true)
      assert.equal(result.error, undefined)
      // External child success: the applied journal remains mutating for the
      // waiting parent — a mutator must never reclaim or commit a journal
      // owned by another process.
      assert.equal(existsSync(fallbackJournalPath(getTrackingFilePath())), true, 'an external child must leave the applied journal for its parent')
      // Parent completion: reclaim, prove, commit. The journal file is
      // removed last, so its absence is the observable commit proof.
      const ownerHandle = await reclaimFallbackJournalMutation(journal)
      const proven = await reloadFallbackJournal(ownerHandle)
      for (const entry of proven.entries) {
        if (entry.stageDigest !== undefined) assert.equal(entry.applied, true, `entry ${entry.path} must be applied`)
      }
      await commitFallbackJournal(ownerHandle)
      assert.equal(existsSync(fallbackJournalPath(getTrackingFilePath())), false, 'the parent commit must remove the journal')
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

  for (const harness of ['claude', 'codex'] as const) {
    it(`aborts before claiming the journal when the ${harness} configuration cannot be parsed`, async () => {
      // Capture invalid bytes before planning; render must reject without claiming.
      const configPath = harness === 'codex' ? path.join(home, '.codex', 'config.toml') : path.join(home, '.claude.json')
      const malformedConfig = harness === 'codex' ? '# user comment\n[mcp_servers.alpha\nurl = "broken"\n' : '{ mcpServers: broken'
      mkdirSync(path.dirname(configPath), { recursive: true })
      writeFileSync(configPath, malformedConfig)
      const fixture = await setupJournalFixture({ harness })
      try {
        const { handle: journal } = await beginFallbackJournal(fixture.identity)
        await markFallbackJournalMutating(journal)
        const journalPath = fallbackJournalPath(fixture.identity.trackingPath)
        const journalBefore = readFileSync(journalPath)

        const result = await refreshOwnedInstallation({ harness, bundlePath: fixture.bundlePath, skillsSource: fixture.sourceRoot, transaction: fixture.identity })

        assert.equal(result.success, false)
        if (harness === 'codex') assert.equal(result.error?.code, 'MCP_PARSE_FAILED')
        assert.notEqual(result.rollbackAttempted, true)
        assert.deepEqual(readFileSync(journalPath), journalBefore, 'the journal was never claimed or rewritten')
        assert.equal(readFileSync(configPath, 'utf8'), malformedConfig)
        assert.equal(readFileSync(path.join(fixture.skillPath, 'SKILL.md'), 'utf8'), 'old tracked')
        for (const dir of new Set([path.join(home, '.agents'), path.dirname(configPath)])) {
          const leftovers = readdirSync(dir).filter((name) => name.includes('.nsolid-stage-'))
          assert.equal(leftovers.length, 0, `${dir}: ${leftovers.join(', ')}`)
        }
      } finally {
        rmSync(fixture.sourceRoot, { recursive: true, force: true })
      }
    })
  }

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

      // The new destinations are parent-planned bundleDestinations evidence in
      // the manifest, so the journal records their missing state at begin; the
      // child never appends unplanned paths.
      const extendedIdentity: FallbackTransactionIdentity = {
        ...fixture.identity,
        bundleDestinations: [
          ...fixture.identity.bundleDestinations,
          await pathEvidence(addedSkill),
          await pathEvidence(addedLink),
        ],
      }
      let { handle: journal } = await beginFallbackJournal(extendedIdentity)
      journal = await markFallbackJournalMutating(journal)
      // The child claims the mutating journal before staging, exactly as the
      // transaction performs it (same-process claim mirrors the external CLI).
      const claimed = await claimFallbackJournalMutation(extendedIdentity, manifestDigestOf(extendedIdentity))
      assert.ok(claimed, 'the child must be able to claim the mutating journal')
      journal = claimed
      // Child staging + apply.
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

      // Parent recovery: reclaim owner authority from the crashed child's
      // journal, then restore. The orphan destinations move into an
      // authenticated restore quarantine that is cleaned on success.
      const ownerHandle = await reclaimFallbackJournalMutation(journal)
      const restored = await restoreFallbackJournal(ownerHandle)
      assert.equal(restored.succeeded, true)
      assert.equal(existsSync(addedSkill), false)
      assert.equal(existsSync(addedLink), false)
      assert.equal(readFileSync(path.join(fixture.skillPath, 'SKILL.md'), 'utf8'), 'old tracked')

      // The next update no longer sees an untracked destination.
      const result = await refreshWithParent({ harness: 'claude', bundlePath: fixture.bundlePath, skillsSource: sourceRoot })
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
    writeBundle(bundlePath, ['tracked'], [{ name: 'alpha-console', url: 'https://new.example.com/mcp', headers: {} }])
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

      const result = await refreshWithParent({ harness: 'claude', bundlePath, skillsSource: sourceRoot })
      assert.equal(result.success, false)
      assert.equal(result.error?.code, 'FALLBACK_MCP_DRIFT')
      // The drifted bytes are preserved; no owned update was applied.
      assert.equal(readFileSync(configA, 'utf8'), driftedText)
      assert.equal(readFileSync(path.join(skillPath, 'SKILL.md'), 'utf8'), 'old tracked')

      // Sanity: with the pristine bytes the same refresh succeeds.
      writeFileSync(configA, before)
      const retry = await refreshWithParent({ harness: 'claude', bundlePath, skillsSource: sourceRoot })
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
    writeBundle(bundlePath, ['tracked'], [{ name: 'alpha-console', url: 'https://new.example.com/mcp', headers: {} }])
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
      const result = await refreshWithParent({ harness: 'claude', bundlePath, skillsSource: sourceRoot })
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

describe('credentialless fallback reconciliation', () => {
  interface CredentiallessFixture {
    skillPath: string
    sourceRoot: string
    bundlePath: string
    configPath: string
    bundle: { version: string }
  }

  /** Fixture matching a real credentialless install: skills tracked, zero tracked MCP servers, a new bundle that wants MCP servers. */
  async function setupCredentiallessFixture (): Promise<CredentiallessFixture> {
    const sharedDir = path.join(home, '.agents', 'skills')
    const skillPath = path.join(sharedDir, 'tracked')
    mkdirSync(skillPath, { recursive: true })
    writeFileSync(path.join(skillPath, 'SKILL.md'), 'old')
    const sourceRoot = mkdtempSync(path.join(os.tmpdir(), 'nsolid-plugin-fallback-credentialless-'))
    mkdirSync(path.join(sourceRoot, 'skills', 'tracked'), { recursive: true })
    writeFileSync(path.join(sourceRoot, 'skills', 'tracked', 'SKILL.md'), 'new')
    const bundlePath = path.join(sourceRoot, 'bundle.json')
    writeBundle(bundlePath, ['tracked'], [{ name: 'new-server', url: 'https://mcp.example.com/mcp', headers: { AUTH: 'auth-token-value' } }])
    const configPath = path.join(home, '.claude.json')
    writeJson(configPath, {})
    writeJson(path.join(home, '.agents', '.nodesource-installed.json'), {
      version: '1.0.0',
      installedAt: new Date().toISOString(),
      harness: 'claude',
      bundleVersion: '1.0.0',
      bundleVersions: { claude: '1.0.0' },
      skills: [{ name: 'tracked', path: skillPath, paths: { claude: skillPath }, installedAt: new Date().toISOString(), harnesses: ['claude'] }],
      mcpServers: [],
    })
    return { skillPath, sourceRoot, bundlePath, configPath, bundle: { version: '1.0.1' } }
  }

  function validCredentialsJson (): Record<string, unknown> {
    return {
      serviceToken: 'service-token',
      organizationId: 'org-1',
      saasToken: 'saas-token',
      consoleUrl: 'https://console.example.com',
      mcpUrl: 'https://mcp.example.com/mcp',
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
    }
  }

  it('fails closed without mutation when zero MCP servers are tracked and credentials are missing, then reconciles after credentials become available', async () => {
    const fixture = await setupCredentiallessFixture()
    const configBefore = readFileSync(fixture.configPath, 'utf8')

    const blocked = await refreshWithParent({ harness: 'claude', bundlePath: fixture.bundlePath, skillsSource: fixture.sourceRoot })
    assert.equal(blocked.success, false)
    assert.equal(blocked.error?.code, 'MCP_RECONCILIATION_REQUIRED')
    assert.equal(blocked.rollbackAttempted, undefined, 'the reconciliation gate must abort before any mutation')

    // Nothing moved: tracking, owned skills, MCP config, and bundle evidence are unchanged.
    const blockedTracking = await readTrackingFile()
    assert.equal(blockedTracking?.bundleVersions?.claude, '1.0.0')
    assert.equal(blockedTracking?.mcpServers.length, 0)
    assert.equal(readFileSync(path.join(fixture.skillPath, 'SKILL.md'), 'utf8'), 'old')
    assert.equal(readFileSync(fixture.configPath, 'utf8'), configBefore)

    // The same fixture reconciles successfully once valid credentials exist.
    writeJson(getAuthFilePath(), validCredentialsJson())
    const retried = await refreshWithParent({ harness: 'claude', bundlePath: fixture.bundlePath, skillsSource: fixture.sourceRoot })
    assert.equal(retried.success, true, String(retried.error?.code ?? ''))
    const tracking = await readTrackingFile()
    assert.equal(tracking?.bundleVersions?.claude, '1.0.1')
    const trackedServer = tracking?.mcpServers.find((entry) => entry.name === 'new-server')
    assert.ok(trackedServer, 'the desired MCP server must be tracked after reconciliation')
    assert.equal(readFileSync(path.join(fixture.skillPath, 'SKILL.md'), 'utf8'), 'new')
    const config = parseJsonc(readFileSync(fixture.configPath, 'utf8')) as { mcpServers: Record<string, { url: string }> }
    assert.equal(config.mcpServers['new-server'].url, 'https://mcp.example.com/mcp')
    rmSync(fixture.sourceRoot, { recursive: true, force: true })
  })

  it('publishes a schema-bounded structured result envelope from the child CLI with --result', async () => {
    const fixture = await setupCredentiallessFixture()
    const trackingPath = getTrackingFilePath()
    const identity: FallbackTransactionIdentity = {
      installationId: 'claude:fallback',
      harness: 'claude',
      trackingPath,
      trackingDigest: trackingDigest(trackingPath)!,
      protocolVersion: FALLBACK_PROTOCOL_VERSION,
      nonce: randomUUID(),
      plannedMissingFrontiers: [],
      ownedSkills: [await pathEvidence(fixture.skillPath)],
      ownedLinks: [await pathEvidence(path.join(getHarnessSkillsPath('claude'), 'tracked'))],
      ownedMcpFields: [],
      ownedMcpConfigPaths: [await pathEvidence(fixture.configPath)],
      bundleDestinations: [
        await pathEvidence(path.join(getSkillsDir(), 'tracked')),
        await pathEvidence(path.join(getHarnessSkillsPath('claude'), 'tracked')),
      ],
      approvedDestinationRoots: [getSkillsDir(), getHarnessSkillsPath('claude')].map((value) => path.resolve(value)),
    }
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'nsolid-plugin-child-result-'))
    if (process.platform !== 'win32') chmodSync(workspace, 0o700)
    const manifestPath = path.join(workspace, 'transaction.json')
    writeJson(manifestPath, identity)
    const resultPath = path.join(workspace, 'result.json')

    const { pathToFileURL } = await import('node:url')
    const require = createRequire(import.meta.url)
    const cliPath = fileURLToPath(new URL('../../../src/update/refresh-owned-cli.ts', import.meta.url))
    const child = spawn(process.execPath, ['--import', pathToFileURL(require.resolve('tsx/esm')).href, cliPath, '--transaction', manifestPath, '--manifest-digest', manifestDigestOf(identity), '--result', resultPath], {
      env: { ...process.env, HOME: home, USERPROFILE: home },
      cwd: path.resolve(fileURLToPath(import.meta.url), '../../../../..'),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const [exitCode, stdout, stderr] = await new Promise<[number | null, string, string]>((resolve, reject) => {
      let out = ''
      let err = ''
      child.stdout?.on('data', (chunk) => { out += String(chunk) })
      child.stderr?.on('data', (chunk) => { err += String(chunk) })
      child.on('error', reject)
      child.on('close', (code) => resolve([code, out, err]))
    })

    assert.equal(exitCode, 1, `child should fail closed without credentials (stderr: ${stderr} stdout: ${stdout})`)
    const stat = statSync(resultPath)
    if (process.platform !== 'win32') assert.equal(stat.mode & 0o777, 0o600)
    assert.equal(stat.size <= 4096, true, 'the envelope must stay bounded')
    const envelope = JSON.parse(readFileSync(resultPath, 'utf8')) as Record<string, unknown>
    assert.deepEqual(Object.keys(envelope).sort(), ['code', 'nonce', 'rollback', 'schema'], 'the envelope must not transport arbitrary child text')
    assert.equal(envelope.schema, FALLBACK_CHILD_RESULT_SCHEMA, 'the child must publish the schema the parent validates against')
    assert.equal(envelope.nonce, identity.nonce)
    assert.equal(envelope.code, 'MCP_RECONCILIATION_REQUIRED')
    assert.deepEqual(envelope.rollback, { attempted: false })
    assert.equal(readFileSync(path.join(fixture.skillPath, 'SKILL.md'), 'utf8'), 'old', 'the child must not mutate owned state')
    rmSync(fixture.sourceRoot, { recursive: true, force: true })
    rmSync(workspace, { recursive: true, force: true })
  })

  it('external child exits 0 leaving the applied journal for the parent to reclaim, prove, and commit', { timeout: 120_000 }, async () => {
    // Run the real CLI from a private package root with its own skill sources.
    // Shared checkout assets must stay untouched while other suites inspect
    // source hygiene. Keep the real bundle and dependencies, and use the repo
    // as cwd to verify that the CLI resolves assets from its own package.
    const repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url))
    const sourcePackageRoot = resolvePackageRoot(path.dirname(fileURLToPath(new URL('../../../src/update/refresh-owned-cli.ts', import.meta.url))))
    const sharedSkillsPath = path.join(sourcePackageRoot, 'skills')
    const sharedSkillsBefore = await pathDigest(sharedSkillsPath)
    const childPackageRoot = path.join(home, 'child-package')
    mkdirSync(childPackageRoot)
    cpSync(path.join(sourcePackageRoot, 'src'), path.join(childPackageRoot, 'src'), { recursive: true })
    for (const file of ['package.json', 'bundle.json']) cpSync(path.join(sourcePackageRoot, file), path.join(childPackageRoot, file))
    symlinkSync(path.join(sourcePackageRoot, 'node_modules'), path.join(childPackageRoot, 'node_modules'), 'junction')
    const cliPath = path.join(childPackageRoot, 'src', 'update', 'refresh-owned-cli.ts')
    const realBundle = JSON.parse(readFileSync(path.join(childPackageRoot, 'bundle.json'), 'utf8')) as { version: string; skills: Array<{ name: string }> }
    assert.ok(realBundle.skills.length > 1, 'the real bundle must contain skills for this fixture')
    const refreshedName = realBundle.skills[0]!.name
    const fixtureSkillsRoot = path.join(childPackageRoot, 'skills')
    for (const skill of realBundle.skills) {
      const sourceDir = path.join(fixtureSkillsRoot, skill.name)
      mkdirSync(sourceDir, { recursive: true })
      writeFileSync(path.join(sourceDir, 'SKILL.md'), `fixture source bytes for ${skill.name}\n`)
    }
    writeJson(getAuthFilePath(), validCredentialsJson())
    const trackingPath = getTrackingFilePath()
    const skillPath = path.join(getSkillsDir(), refreshedName)
    mkdirSync(skillPath, { recursive: true })
    writeFileSync(path.join(skillPath, 'SKILL.md'), 'old installed bytes')
    // The canonical claude config does not exist yet: the child journals its
    // missing state and the reconciliation creates it with the first server.
    const configPath = path.join(home, '.claude.json')
    writeJson(trackingPath, {
      version: '1.0.0',
      installedAt: new Date().toISOString(),
      harness: 'claude',
      bundleVersion: realBundle.version,
      bundleVersions: { claude: realBundle.version },
      skills: [{ name: refreshedName, path: skillPath, paths: { claude: skillPath }, installedAt: new Date().toISOString(), harnesses: ['claude'] }],
      mcpServers: [],
    })
    const identity: FallbackTransactionIdentity = {
      installationId: 'claude:fallback',
      harness: 'claude',
      trackingPath,
      trackingDigest: trackingDigest(trackingPath)!,
      protocolVersion: FALLBACK_PROTOCOL_VERSION,
      nonce: randomUUID(),
      plannedMissingFrontiers: [],
      ownedSkills: [await pathEvidence(skillPath)],
      ownedLinks: [await pathEvidence(path.join(getHarnessSkillsPath('claude'), refreshedName))],
      ownedMcpFields: [],
      ownedMcpConfigPaths: [await pathEvidence(configPath)],
      bundleDestinations: await Promise.all(realBundle.skills.flatMap((skill) => [
        pathEvidence(path.join(getSkillsDir(), skill.name)),
        pathEvidence(path.join(getHarnessSkillsPath('claude'), skill.name)),
      ])),
      approvedDestinationRoots: [getSkillsDir(), getHarnessSkillsPath('claude')].map((value) => path.resolve(value)),
    }
    // The parent began the journal and advanced it to mutating before the
    // child was spawned; the owner handle stays in this process.
    let ownerHandle = (await beginFallbackJournal(identity)).handle
    ownerHandle = await markFallbackJournalMutating(ownerHandle)

    const workspace = mkdtempSync(path.join(os.tmpdir(), 'nsolid-plugin-child-success-'))
    if (process.platform !== 'win32') chmodSync(workspace, 0o700)
    const manifestPath = path.join(workspace, 'transaction.json')
    writeJson(manifestPath, identity)
    const resultPath = path.join(workspace, 'result.json')

    const { pathToFileURL } = await import('node:url')
    const require = createRequire(import.meta.url)
    try {
      assert.equal(await pathDigest(sharedSkillsPath), sharedSkillsBefore, 'the child fixture must not mutate shared package skills')
      const child = spawn(process.execPath, ['--import', pathToFileURL(require.resolve('tsx/esm')).href, cliPath, '--transaction', manifestPath, '--manifest-digest', manifestDigestOf(identity), '--result', resultPath], {
        env: { ...process.env, HOME: home, USERPROFILE: home },
        cwd: repoRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const [exitCode, stdout, stderr] = await new Promise<[number | null, string, string]>((resolve, reject) => {
        let out = ''
        let err = ''
        child.stdout?.on('data', (chunk) => { out += String(chunk) })
        child.stderr?.on('data', (chunk) => { err += String(chunk) })
        child.on('error', reject)
        child.on('close', (code) => resolve([code, out, err]))
      })

      assert.equal(exitCode, 0, `child should succeed (stderr: ${stderr} stdout: ${stdout})`)
      assert.equal(existsSync(resultPath), false, 'a successful child publishes no failure envelope')
      // The applied journal remains mutating for the parent: the child is a
      // different process and must never reclaim or commit a journal owned by
      // another PID, even on success.
      const journalPath = fallbackJournalPath(trackingPath)
      assert.equal(existsSync(journalPath), true, 'the applied journal must remain for the parent')
      // Parent completion after the confirmed child exit: reclaim owner
      // authority (requires the recorded mutator to be gone), prove the applied
      // state from the strictly reloaded journal plus the live filesystem, then
      // commit with the journal as the single snapshot.
      const reclaimed = await reclaimFallbackJournalMutation(ownerHandle)
      const proven = await reloadFallbackJournal(reclaimed)
      for (const entry of proven.entries) {
        if (entry.stageDigest !== undefined) {
          assert.equal(entry.applied, true, `entry ${entry.path} must be applied`)
          assert.equal(await pathDigest(entry.path), entry.stageDigest, `entry ${entry.path} must hold its staged digest`)
        }
      }
      await commitFallbackJournal(reclaimed)
      assert.equal(existsSync(journalPath), false, 'the parent commit must remove the journal')
      // The live update survived the child exit and the parent commit.
      assert.notEqual(readFileSync(path.join(skillPath, 'SKILL.md'), 'utf8'), 'old installed bytes')
      assert.equal(existsSync(path.join(getSkillsDir(), realBundle.skills[1]!.name)), true, 'a new bundle skill must be installed')
      assert.equal(existsSync(path.join(getHarnessSkillsPath('claude'), refreshedName)), true, 'the refreshed harness link must exist')
      const config = parseJsonc(readFileSync(configPath, 'utf8')) as { mcpServers: Record<string, { url: string }> }
      assert.ok(config.mcpServers['nsolid-console'], 'the canonical config must gain the bundle MCP server')
      const tracking = await readTrackingFile()
      assert.equal(tracking?.bundleVersions?.claude, realBundle.version)
      assert.equal(await pathDigest(sharedSkillsPath), sharedSkillsBefore, 'the child must leave shared package skills unchanged')
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })
  it('refreshes an owned MCP config whose tracked fields already match the desired render without touching the config bytes', async () => {
    const fixture = await setupCredentiallessFixture()
    const serverRecord = { type: 'http', url: 'https://mcp.example.com/mcp', headers: { AUTH: 'auth-token-value' } }
    writeJson(fixture.configPath, { mcpServers: { 'new-server': serverRecord } })
    const configBefore = readFileSync(fixture.configPath, 'utf8')
    const fields = readMcpFieldDigests(fixture.configPath, 'new-server', { preferredKey: harnessMcpKey('claude') })
    assert.ok(fields)
    const trackingPath = getTrackingFilePath()
    const current = JSON.parse(readFileSync(trackingPath, 'utf8')) as Record<string, unknown>
    writeJson(trackingPath, {
      ...current,
      mcpServers: [{ name: 'new-server', configPath: path.resolve(fixture.configPath), harness: 'claude', configuredAt: new Date().toISOString(), fields }],
    })
    writeJson(getAuthFilePath(), validCredentialsJson())

    const result = await refreshWithParent({ harness: 'claude', bundlePath: fixture.bundlePath, skillsSource: fixture.sourceRoot })
    assert.equal(result.success, true, JSON.stringify(result))
    // Regression: a planned no-op field update must never move the live
    // configuration into quarantine with no staged replacement.
    assert.equal(readFileSync(fixture.configPath, 'utf8'), configBefore)
    const tracking = await readTrackingFile()
    assert.equal(tracking?.bundleVersions?.claude, '1.0.1')
    const tracked = tracking?.mcpServers.find((entry) => entry.name === 'new-server')
    assert.deepEqual(tracked?.fields, fields)
    rmSync(fixture.sourceRoot, { recursive: true, force: true })
  })
})

describe('fallback parent frontier planning', () => {
  interface LocalManifestObservation {
    manifest: FallbackTransactionIdentity | undefined
    plan: FallbackFrontierPlan | undefined
    leaves: ReturnType<typeof deriveFallbackFrontierLeafTargets> | undefined
    observeManifest: (manifest: FallbackTransactionIdentity) => Promise<void>
  }

  /**
   * Derive the shared-API expectation at the same live-state instant: the
   * observer fires after local planning and before any mutation, so both
   * derivations see identical filesystem state.
   */
  function observeLocalManifest (deriveExpectation: () => Promise<{ plan: FallbackFrontierPlan, leaves: ReturnType<typeof deriveFallbackFrontierLeafTargets> }>): LocalManifestObservation {
    const observation: LocalManifestObservation = {
      manifest: undefined,
      plan: undefined,
      leaves: undefined,
      observeManifest: async (manifest) => {
        observation.manifest = manifest
        const expectation = await deriveExpectation()
        observation.plan = expectation.plan
        observation.leaves = expectation.leaves
      },
    }
    return observation
  }

  it('derives the parent manifest frontier graph through the shared planner API', async () => {
    const sharedDir = path.join(home, '.agents', 'skills')
    const retainedDir = path.join(sharedDir, 'retained')
    const removedDir = path.join(sharedDir, 'removed')
    mkdirSync(retainedDir, { recursive: true })
    mkdirSync(removedDir, { recursive: true })
    writeFileSync(path.join(retainedDir, 'SKILL.md'), 'old retained')
    writeFileSync(path.join(removedDir, 'SKILL.md'), 'shared with Codex')
    const claudeSkills = path.join(home, '.claude', 'skills')
    mkdirSync(claudeSkills, { recursive: true })
    symlinkSync(retainedDir, path.join(claudeSkills, 'retained'), 'dir')
    symlinkSync(removedDir, path.join(claudeSkills, 'removed'), 'dir')
    const { sourceRoot, bundlePath } = setupSkillSource({ retained: 'new retained', added: 'new skill' })
    writeBundle(bundlePath, ['retained', 'added'], [{ name: 'nsolid-console', url: 'https://example.com/mcp', headers: {} }])
    writeCredentials(getAuthFilePath(), 'https://example.com/mcp', 60_000)
    writeJson(getTrackingFilePath(), {
      version: '1.0.0',
      installedAt: new Date().toISOString(),
      harness: 'claude',
      skills: [
        { name: 'retained', path: retainedDir, paths: { claude: retainedDir }, installedAt: new Date().toISOString(), harnesses: ['claude'] },
        { name: 'removed', path: removedDir, paths: { claude: removedDir, codex: removedDir }, installedAt: new Date().toISOString(), harnesses: ['claude', 'codex'] },
      ],
      mcpServers: [],
    })

    const canonicalConfigPath = getAdapter('claude').getMcpConfigPath()
    assert.ok(canonicalConfigPath)
    const observation = observeLocalManifest(async () => {
      const leaves = deriveFallbackFrontierLeafTargets({
        ownedSkills: [await pathEvidence(retainedDir), await pathEvidence(removedDir)],
        ownedLinks: [await pathEvidence(path.join(claudeSkills, 'retained')), await pathEvidence(path.join(claudeSkills, 'removed'))],
        ownedMcpConfigPaths: [await pathEvidence(canonicalConfigPath)],
        trackingPath: getTrackingFilePath(),
        destination: path.resolve(getSkillsDir()),
        linkDir: path.resolve(getHarnessSkillsPath('claude')),
        bundleSkillNames: ['retained', 'added'],
      })
      return { plan: await deriveFallbackFrontierPlan(leaves), leaves }
    })
    try {
      const result = await refreshWithParent({ harness: 'claude', bundlePath, skillsSource: sourceRoot, observeManifest: observation.observeManifest })
      assert.equal(result.success, true, JSON.stringify(result))
      assert.ok(observation.manifest && observation.plan && observation.leaves)
      // Exact parity with the shared planner for the same planned state: the
      // parent manifest carries byte-identical frontier evidence.
      assert.deepEqual(observation.manifest.plannedMissingFrontiers, observation.plan.frontiers)
      // Graph coverage: bundle destinations, tracked removals, canonical MCP,
      // and tracking leaves are all authorized by one derivation.
      const ids = observation.leaves.map((leaf) => leaf.id)
      for (const expectedId of ['skill:retained', 'skill:added', 'link:retained', 'link:added', 'owned-skill:removed', 'owned-link:removed', 'tracking']) {
        assert.ok(ids.includes(expectedId), `leaf graph is missing ${expectedId}`)
      }
      assert.ok(ids.some((id) => id.startsWith('mcp-config:')), 'leaf graph is missing the canonical MCP config leaf')
      // The new 'added' skill directory is missing under an existing root:
      // exactly one required frontier anchored at the destination root.
      const frontier = observation.manifest.plannedMissingFrontiers?.[0]
      assert.ok(frontier)
      assert.equal(observation.manifest.plannedMissingFrontiers?.length, 1)
      assert.equal(frontier.frontierPath, path.join(path.resolve(getSkillsDir()), 'added'))
      assert.equal(frontier.activation, 'required')
      assert.deepEqual(frontier.leaves.map((leaf) => leaf.id), ['skill:added'])
      // The canonical MCP config is a missing file under an existing parent:
      // an independent leaf destination, never a directory frontier.
      const mcpLeaf = observation.leaves.find((leaf) => leaf.role === 'mcp-config')
      assert.ok(mcpLeaf)
      assert.ok(observation.plan.missingLeaves.some((leaf) => leaf.id === mcpLeaf.id))
      for (const entry of observation.plan.frontiers) {
        assert.ok(entry.leaves.every((leaf) => leaf.id !== mcpLeaf.id))
      }
    } finally {
      rmSync(sourceRoot, { recursive: true, force: true })
    }
  })

  it('rejects an active missing frontier on non-linux before any journal, snapshot, or live mutation, then proceeds on linux', async () => {
    const destination = path.resolve(getSkillsDir())
    const claudeSkills = path.join(home, '.claude', 'skills')
    const keptPath = path.join(destination, 'kept')
    const { sourceRoot, bundlePath } = setupSkillSource({ kept: 'new kept' })
    writeBundle(bundlePath, ['kept'], [{ name: 'nsolid-console', url: 'https://example.com/mcp', headers: {} }])
    writeCredentials(getAuthFilePath(), 'https://example.com/mcp', 60_000)
    writeJson(getTrackingFilePath(), {
      version: '1.0.0',
      installedAt: new Date().toISOString(),
      harness: 'claude',
      skills: [{ name: 'kept', path: keptPath, paths: { claude: keptPath }, installedAt: new Date().toISOString(), harnesses: ['claude'] }],
      mcpServers: [],
    })
    const trackingDir = path.dirname(getTrackingFilePath())
    const trackingDirBefore = readdirSync(trackingDir).sort()

    let observedFrontierCount: number | undefined
    const observeManifest = (manifest: FallbackTransactionIdentity): void => {
      observedFrontierCount = manifest.plannedMissingFrontiers?.length
    }
    try {
      const originalPlatform = process.platform
      try {
        Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
        const rejected = await refreshWithParent({ harness: 'claude', bundlePath, skillsSource: sourceRoot, observeManifest })
        assert.equal(rejected.success, false)
        assert.equal(rejected.error?.code, 'FALLBACK_PARENT_CREATION_UNSUPPORTED')
        assert.equal(rejected.rollbackAttempted, false)
        assert.match(rejected.error?.message ?? '', /no files were changed/)
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
      }
      // The gate fired on real derived frontier evidence (destination root and
      // link root missing), strictly before journal reservation.
      assert.equal(observedFrontierCount, 2)
      assert.equal(existsSync(fallbackJournalPath(getTrackingFilePath())), false)
      assert.deepEqual(readdirSync(trackingDir).sort(), trackingDirBefore)
      assert.equal(existsSync(destination), false)
      assert.equal(existsSync(claudeSkills), false)
      // On linux the same run passes the preflight and completes end-to-end.
      const result = await refreshWithParent({ harness: 'claude', bundlePath, skillsSource: sourceRoot, observeManifest })
      assert.equal(result.success, true, JSON.stringify(result))
      assert.equal(readFileSync(path.join(destination, 'kept', 'SKILL.md'), 'utf8'), 'new kept')
    } finally {
      rmSync(sourceRoot, { recursive: true, force: true })
    }
  })

  it('keeps existing-parent parent-managed updates supported on non-linux platforms', async () => {
    // Replace-only bundle over fully existing parents: zero frontiers.
    const sharedDir = path.join(home, '.agents', 'skills')
    const retainedDir = path.join(sharedDir, 'retained')
    const removedDir = path.join(sharedDir, 'removed')
    mkdirSync(retainedDir, { recursive: true })
    mkdirSync(removedDir, { recursive: true })
    writeFileSync(path.join(retainedDir, 'SKILL.md'), 'old retained')
    writeFileSync(path.join(removedDir, 'SKILL.md'), 'shared with Codex')
    const claudeSkills = path.join(home, '.claude', 'skills')
    mkdirSync(claudeSkills, { recursive: true })
    symlinkSync(retainedDir, path.join(claudeSkills, 'retained'), 'dir')
    symlinkSync(removedDir, path.join(claudeSkills, 'removed'), 'dir')
    const { sourceRoot, bundlePath } = setupSkillSource({ retained: 'new retained' })
    writeBundle(bundlePath, ['retained'], [{ name: 'nsolid-console', url: 'https://example.com/mcp', headers: {} }])
    writeCredentials(getAuthFilePath(), 'https://example.com/mcp', 60_000)
    writeJson(getTrackingFilePath(), {
      version: '1.0.0',
      installedAt: new Date().toISOString(),
      harness: 'claude',
      skills: [
        { name: 'retained', path: retainedDir, paths: { claude: retainedDir }, installedAt: new Date().toISOString(), harnesses: ['claude'] },
        { name: 'removed', path: removedDir, paths: { claude: removedDir, codex: removedDir }, installedAt: new Date().toISOString(), harnesses: ['claude', 'codex'] },
      ],
      mcpServers: [],
    })

    let observedFrontiers: readonly unknown[] | undefined
    const observeManifest = (manifest: FallbackTransactionIdentity): void => {
      observedFrontiers = manifest.plannedMissingFrontiers
    }
    try {
      const originalPlatform = process.platform
      let result
      try {
        Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
        result = await refreshWithParent({ harness: 'claude', bundlePath, skillsSource: sourceRoot, observeManifest })
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
      }
      assert.equal(result.success, true, JSON.stringify(result))
      // No missing parents means no platform restriction anywhere.
      assert.deepEqual(observedFrontiers, [])
      assert.equal(readFileSync(path.join(retainedDir, 'SKILL.md'), 'utf8'), 'new retained')
    } finally {
      rmSync(sourceRoot, { recursive: true, force: true })
    }
  })

  it('publishes an active all-MCP missing-parent frontier without creating the config parent early', async () => {
    // Fresh opencode ownership whose entire config root (~/.config/opencode)
    // is missing: the derived graph must contain exactly one planned-missing
    // frontier equal to the config parent, covering only the mcp-config leaf.
    // The shared skills destination and harness link directory point at an
    // existing directory via NSOLID_OPENCODE_SKILLS_DIR, so no skill/link
    // frontier is derived and the MCP parent frontier is the sole one.
    const sharedSkillsDir = path.join(home, 'shared-skills')
    mkdirSync(path.join(sharedSkillsDir, 'tracked'), { recursive: true })
    writeFileSync(path.join(sharedSkillsDir, 'tracked', 'SKILL.md'), 'old')
    const previousSkillsDir = process.env.NSOLID_OPENCODE_SKILLS_DIR
    process.env.NSOLID_OPENCODE_SKILLS_DIR = sharedSkillsDir
    const sourceRoot = mkdtempSync(path.join(os.tmpdir(), 'nsolid-plugin-fallback-source-'))
    try {
      mkdirSync(path.join(sourceRoot, 'skills', 'tracked'), { recursive: true })
      writeFileSync(path.join(sourceRoot, 'skills', 'tracked', 'SKILL.md'), 'new')
      const bundlePath = path.join(sourceRoot, 'bundle.json')
      writeBundle(bundlePath, ['tracked'], [{ name: 'new-server', url: 'https://example.com/mcp', headers: {} }])
      writeCredentials(getAuthFilePath(), 'https://example.com/mcp', 60_000)
      writeJson(getTrackingFilePath(), {
        version: '1.0.0',
        installedAt: new Date().toISOString(),
        harness: 'opencode',
        bundleVersions: { opencode: '1.0.0' },
        skills: [{ name: 'tracked', path: path.join(sharedSkillsDir, 'tracked'), paths: { opencode: path.join(sharedSkillsDir, 'tracked') }, installedAt: new Date().toISOString(), harnesses: ['opencode'] }],
        mcpServers: [],
      })

      const configPath = path.join(home, '.config', 'opencode', 'opencode.jsonc')
      // The whole ~/.config chain is missing, so the derived planned-missing
      // frontier root is the FIRST missing ancestor (~/.config), covering the
      // single mcp-config leaf.
      const frontierRoot = path.join(home, '.config')
      // The harness adapter confirms this fixture targets the real config file.
      assert.equal(getAdapter('opencode').getMcpConfigPath(), configPath)
      assert.equal(await pathKind(configPath), 'missing')
      assert.equal(await pathKind(frontierRoot), 'missing')

      const seamEvents: Array<{ phase: string; frontierPath: string }> = []
      let beforeReserveObserved = false
      setFallbackFrontierPublicationSeamForTests(async (event) => {
        seamEvents.push({ phase: event.phase, frontierPath: event.frontierPath })
        if (event.phase === 'before-reserve' && event.frontierPath === path.resolve(frontierRoot)) {
          // The recursive mkdir gate must have skipped this parent: it is
          // still missing at the exclusive-reservation window.
          assert.equal(await pathKind(frontierRoot), 'missing')
          beforeReserveObserved = true
        }
      })

      let observedFrontierCount: number | undefined
      const observeManifest = (manifest: FallbackTransactionIdentity): void => {
        observedFrontierCount = manifest.plannedMissingFrontiers.length
        assert.deepEqual(manifest.plannedMissingFrontiers.map((frontier) => path.resolve(frontier.frontierPath)), [path.resolve(frontierRoot)])
        assert.deepEqual(manifest.plannedMissingFrontiers[0].leaves.map((leaf) => leaf.role), ['mcp-config'])
      }

      try {
        if (process.platform !== 'linux') {
          // Platform preflight rejects the active frontier before any mutation.
          const rejected = await refreshWithParent({ harness: 'opencode', bundlePath, skillsSource: sourceRoot, observeManifest })
          assert.equal(rejected.success, false)
          assert.equal(rejected.error?.code, 'FALLBACK_PARENT_CREATION_UNSUPPORTED')
          return
        }
        const result = await refreshWithParent({ harness: 'opencode', bundlePath, skillsSource: sourceRoot, observeManifest })
        assert.equal(result.success, true, JSON.stringify(result))
        assert.equal(observedFrontierCount, 1)
        // The seam observed the reservation window exactly once and never an
        // early live-parent creation for the config frontier.
        assert.equal(beforeReserveObserved, true)
        assert.equal(seamEvents.filter((event) => event.phase === 'before-reserve' && event.frontierPath === path.resolve(frontierRoot)).length, 1)
        // The config parent exists only through the frontier publication and
        // carries exactly the planned MCP bytes.
        assert.equal(await pathKind(configPath), 'file')
        const written = parseJsonc(readFileSync(configPath, 'utf8')) as { mcp: Record<string, { url: string }> }
        assert.equal(written.mcp['new-server'].url, 'https://example.com/mcp')
        const tracking = await readTrackingFile()
        assert.equal(tracking?.bundleVersions?.opencode, '1.0.1')
        assert.ok(tracking?.mcpServers.some((entry) => entry.name === 'new-server'))
        // A successful parent-managed refresh leaves no pending journal behind.
        assert.equal(existsSync(fallbackJournalPath(getTrackingFilePath())), false)
      } finally {
        setFallbackFrontierPublicationSeamForTests(undefined)
        rmSync(sourceRoot, { recursive: true, force: true })
      }
    } finally {
      if (previousSkillsDir === undefined) delete process.env.NSOLID_OPENCODE_SKILLS_DIR
      else process.env.NSOLID_OPENCODE_SKILLS_DIR = previousSkillsDir
    }
  })

  it('publishes an active mixed skill+MCP ancestor frontier without creating the ancestor early', async () => {
    // Fresh opencode ownership whose ENTIRE config root (~/.config) is
    // missing: the derived graph must contain exactly one planned-missing
    // frontier equal to ~/.config covering BOTH the required shared-skill
    // destination leaf (~/.config/opencode/skills/<name>) and the canonical
    // mcp-config leaf. The bundle declares one MCP server while previous
    // tracking owns none, and valid credentials enable reconciliation, so the
    // mcp-config leaf is an ACTIVE conditional: both payloads must be staged
    // into the single private frontier tree and published together, without
    // any early recursive mkdir of the live ancestor.
    const sourceRoot = mkdtempSync(path.join(os.tmpdir(), 'nsolid-plugin-fallback-source-'))
    try {
      mkdirSync(path.join(sourceRoot, 'skills', 'tracked'), { recursive: true })
      writeFileSync(path.join(sourceRoot, 'skills', 'tracked', 'SKILL.md'), 'new')
      const bundlePath = path.join(sourceRoot, 'bundle.json')
      writeBundle(bundlePath, ['tracked'], [{ name: 'new-server', url: 'https://example.com/mcp', headers: {} }])
      writeCredentials(getAuthFilePath(), 'https://example.com/mcp', 60_000)
      const destination = path.join(home, '.config', 'opencode', 'skills')
      const configPath = path.join(home, '.config', 'opencode', 'opencode.jsonc')
      writeJson(getTrackingFilePath(), {
        version: '1.0.0',
        installedAt: new Date().toISOString(),
        harness: 'opencode',
        bundleVersions: { opencode: '1.0.0' },
        skills: [{ name: 'tracked', path: path.join(destination, 'tracked'), paths: { opencode: path.join(destination, 'tracked') }, installedAt: new Date().toISOString(), harnesses: ['opencode'] }],
        mcpServers: [],
      })

      const frontierRoot = path.join(home, '.config')
      const skillLeafPath = path.join(destination, 'tracked')
      // The harness adapter confirms this fixture targets the real config file.
      assert.equal(getAdapter('opencode').getMcpConfigPath(), configPath)
      assert.equal(await pathKind(frontierRoot), 'missing')
      assert.equal(await pathKind(skillLeafPath), 'missing')
      assert.equal(await pathKind(configPath), 'missing')

      let observedFrontierCount: number | undefined
      const observeManifest = (manifest: FallbackTransactionIdentity): void => {
        observedFrontierCount = manifest.plannedMissingFrontiers.length
        assert.deepEqual(manifest.plannedMissingFrontiers.map((frontier) => path.resolve(frontier.frontierPath)), [path.resolve(frontierRoot)])
        const frontier = manifest.plannedMissingFrontiers[0]
        assert.deepEqual(frontier.leaves.map((leaf) => leaf.role).sort(), ['mcp-config', 'skill'])
        assert.deepEqual(frontier.leaves.map((leaf) => leaf.activation).sort(), ['conditional', 'required'])
      }

      const seamEvents: Array<{ phase: string; frontierPath: string }> = []
      let beforeReserveObserved = false
      setFallbackFrontierPublicationSeamForTests(async (event) => {
        seamEvents.push({ phase: event.phase, frontierPath: event.frontierPath })
        if (event.phase === 'before-reserve' && event.frontierPath === path.resolve(frontierRoot)) {
          // The recursive mkdir gate must have skipped the shared ancestor: it
          // is still missing inside the exclusive-reservation window.
          assert.equal(await pathKind(frontierRoot), 'missing')
          beforeReserveObserved = true
        }
      })

      try {
        if (process.platform !== 'linux') {
          // Platform preflight rejects the active frontier before any mutation.
          const rejected = await refreshWithParent({ harness: 'opencode', bundlePath, skillsSource: sourceRoot, observeManifest })
          assert.equal(rejected.success, false)
          assert.equal(rejected.error?.code, 'FALLBACK_PARENT_CREATION_UNSUPPORTED')
          return
        }
        const result = await refreshWithParent({ harness: 'opencode', bundlePath, skillsSource: sourceRoot, observeManifest })
        assert.equal(result.success, true, JSON.stringify(result))
        assert.equal(observedFrontierCount, 1)
        // The seam observed the reservation window exactly once and never an
        // early live-parent creation for the shared ancestor frontier.
        assert.equal(beforeReserveObserved, true)
        assert.equal(seamEvents.filter((event) => event.phase === 'before-reserve' && event.frontierPath === path.resolve(frontierRoot)).length, 1)
        // The required skill leaf exists only through the frontier publication.
        assert.equal(readFileSync(path.join(skillLeafPath, 'SKILL.md'), 'utf8'), 'new')
        // The active conditional mcp-config leaf carries the desired server.
        assert.equal(await pathKind(configPath), 'file')
        const written = parseJsonc(readFileSync(configPath, 'utf8')) as { mcp: Record<string, { url: string }> }
        assert.equal(written.mcp['new-server'].url, 'https://example.com/mcp')
        const tracking = await readTrackingFile()
        assert.equal(tracking?.bundleVersions?.opencode, '1.0.1')
        assert.ok(tracking?.mcpServers.some((entry) => entry.name === 'new-server'))
        // A successful parent-managed refresh leaves no pending journal behind.
        assert.equal(existsSync(fallbackJournalPath(getTrackingFilePath())), false)
      } finally {
        setFallbackFrontierPublicationSeamForTests(undefined)
      }
    } finally {
      rmSync(sourceRoot, { recursive: true, force: true })
    }
  })

  it('rejects an unsupported active link+MCP frontier without creating the shared root or a journal', async () => {
    // Antigravity parent-managed refresh whose ENTIRE ~/.gemini root is missing: the
    // derived planned-missing frontier there carries BOTH a required link
    // leaf (~/.gemini/config/skills/<name>) and an ACTIVE conditional
    // mcp-config leaf (~/.gemini/config/mcp_config.json, rendered because
    // valid credentials let the bundle server reconcile into the empty
    // previous set). A link+MCP frontier is not a supported publication
    // shape, so the refresh must fail closed BEFORE any live recursive mkdir
    // of ~/.gemini (the historical bug created the whole shared root here),
    // leave the root and config missing, run no frontier publication, and
    // dispose the journal reserved before the classification gate.
    const sharedSkillPath = path.join(home, '.agents', 'skills', 'tracked')
    mkdirSync(sharedSkillPath, { recursive: true })
    writeFileSync(path.join(sharedSkillPath, 'SKILL.md'), 'old')
    const sourceRoot = mkdtempSync(path.join(os.tmpdir(), 'nsolid-plugin-fallback-source-'))
    try {
      mkdirSync(path.join(sourceRoot, 'skills', 'tracked'), { recursive: true })
      writeFileSync(path.join(sourceRoot, 'skills', 'tracked', 'SKILL.md'), 'new')
      const bundlePath = path.join(sourceRoot, 'bundle.json')
      writeBundle(bundlePath, ['tracked'], [{ name: 'new-server', url: 'https://example.com/mcp', headers: {} }])
      writeCredentials(getAuthFilePath(), 'https://example.com/mcp', 60_000)
      writeJson(getTrackingFilePath(), {
        version: '1.0.0',
        installedAt: new Date().toISOString(),
        harness: 'antigravity',
        bundleVersions: { antigravity: '1.0.0' },
        skills: [{ name: 'tracked', path: sharedSkillPath, paths: { antigravity: sharedSkillPath }, installedAt: new Date().toISOString(), harnesses: ['antigravity'] }],
        mcpServers: [],
      })

      const linkDir = path.resolve(getHarnessSkillsPath('antigravity'))
      const configPath = getAdapter('antigravity').getMcpConfigPath()
      const frontierRoot = path.join(home, '.gemini')
      // The adapter fixtures confirm the real Antigravity layout: the harness
      // link directory and the canonical MCP config both live below ~/.gemini.
      assert.equal(linkDir, path.join(frontierRoot, 'config', 'skills'))
      assert.equal(configPath, path.join(frontierRoot, 'config', 'mcp_config.json'))
      assert.equal(await pathKind(frontierRoot), 'missing')
      assert.equal(await pathKind(linkDir), 'missing')
      assert.equal(await pathKind(configPath), 'missing')

      let observedFrontierCount: number | undefined
      const observeManifest = (manifest: FallbackTransactionIdentity): void => {
        observedFrontierCount = manifest.plannedMissingFrontiers.length
        assert.deepEqual(manifest.plannedMissingFrontiers.map((frontier) => path.resolve(frontier.frontierPath)), [path.resolve(frontierRoot)])
        const frontier = manifest.plannedMissingFrontiers[0]
        // Exactly the unsupported active mix: required link + active
        // conditional mcp-config under one missing root.
        assert.deepEqual(frontier.leaves.map((leaf) => leaf.role).sort(), ['link', 'mcp-config'])
        assert.deepEqual(frontier.leaves.map((leaf) => leaf.activation).sort(), ['conditional', 'required'])
      }

      const seamEvents: Array<{ phase: string; frontierPath: string }> = []
      setFallbackFrontierPublicationSeamForTests(async (event) => {
        seamEvents.push({ phase: event.phase, frontierPath: event.frontierPath })
      })

      try {
        if (process.platform !== 'linux') {
          // Platform preflight rejects the active frontier before any mutation.
          const rejected = await refreshWithParent({ harness: 'antigravity', bundlePath, skillsSource: sourceRoot, observeManifest })
          assert.equal(rejected.success, false)
          assert.equal(rejected.error?.code, 'FALLBACK_PARENT_CREATION_UNSUPPORTED')
          return
        }
        const result = await refreshWithParent({ harness: 'antigravity', bundlePath, skillsSource: sourceRoot, observeManifest })
        assert.equal(result.success, false, JSON.stringify(result))
        assert.equal(result.error?.code, 'INVALID_TRANSACTION_MANIFEST')
        assert.equal(observedFrontierCount, 1)
        // No frontier publication ever ran: the rejection happened at the
        // pure classification gate, before staging or reservation windows.
        assert.equal(seamEvents.length, 0)
        // The unsupported frontier must not have created the shared root:
        // every path below it stays missing after the failed refresh.
        assert.equal(await pathKind(frontierRoot), 'missing')
        assert.equal(await pathKind(linkDir), 'missing')
        assert.equal(await pathKind(configPath), 'missing')
        // The owned shared skill was never touched.
        assert.equal(readFileSync(path.join(sharedSkillPath, 'SKILL.md'), 'utf8'), 'old')
        // The child cannot dispose the parent's journal. If the owner cannot
        // re-authenticate the already-restored snapshot, it preserves residue.
        assert.equal(existsSync(fallbackJournalPath(getTrackingFilePath())), true)
      } finally {
        setFallbackFrontierPublicationSeamForTests(undefined)
        rmSync(sourceRoot, { recursive: true, force: true })
      }
    } finally {
      rmSync(sharedSkillPath, { recursive: true, force: true })
    }
  })
})
