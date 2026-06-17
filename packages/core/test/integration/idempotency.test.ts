import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { getAdapter } from '../../src/harnesses/index.js'
import type { BundleDescriptor } from '../../src/types.js'
import type { TrackingData } from '../../src/skills/skill-tracker.js'

let tmpDir: string
let originalHome: string | undefined
let originalUserProfile: string | undefined

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'nsolid-idem-'))
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

function createBundle (overrides?: Partial<BundleDescriptor>): BundleDescriptor {
  return {
    name: 'test-bundle',
    version: '1.0.0',
    skills: [
      { name: 'ns-idem-skill', path: 'skills/ns-idem-skill', description: 'Idempotency test skill' },
    ],
    mcpServers: [
      { name: 'ns-test-mcp', url: 'https://mcp.example.com', headers: { Authorization: 'Bearer test' } },
    ],
    ...overrides,
  }
}

function writeBundle (bundle: BundleDescriptor): string {
  const bundleDir = join(tmpDir, 'bundle')
  mkdirSync(bundleDir, { recursive: true })
  const bundlePath = join(bundleDir, 'bundle.json')
  writeFileSync(bundlePath, JSON.stringify(bundle, null, 2))
  return bundlePath
}

function createSkillSource (skillName: string): string {
  const sourceDir = join(tmpDir, 'source')
  const skillDir = join(sourceDir, 'skills', skillName)
  mkdirSync(skillDir, { recursive: true })
  writeFileSync(join(skillDir, 'SKILL.md'), `# ${skillName}`)
  return sourceDir
}

describe('idempotency', () => {
  it('idempotent install — calling install twice produces no duplicates', async () => {
    const { install } = await import('../../src/index.js')
    const bundle = createBundle()
    const bundlePath = writeBundle(bundle)
    const skillsSource = createSkillSource('ns-idem-skill')

    const res1 = await install({ harness: 'claude', bundlePath, skillsSource })
    assert.strictEqual(res1.success, true)

    const res2 = await install({ harness: 'claude', bundlePath, skillsSource })
    assert.strictEqual(res2.success, true)
    assert.deepStrictEqual(res2.errors, [])

    const harnessSkills = getAdapter('claude').getSkillsPath()
    assert.ok(existsSync(join(harnessSkills, 'ns-idem-skill')), 'skill still exists')

    const cfg = await getAdapter('claude').readMcpConfig()
    const nsMcpCount = Object.keys(cfg.mcpServers).filter((k) => k === 'ns-test-mcp').length
    assert.strictEqual(nsMcpCount, 1, 'MCP server appears exactly once')

    const { readJsonFile } = await import('../../src/utils/config.js')
    const tracking = readJsonFile<TrackingData>(join(tmpDir, '.agents', '.nodesource-installed.json'))
    assert.ok(tracking, 'tracking file exists')
    const skillEntries = tracking.skills.filter((s) => s.name === 'ns-idem-skill')
    assert.strictEqual(skillEntries.length, 1, 'skill tracked exactly once')
  })

  it('reinstall overwrites skills, merges MCP', async () => {
    const { install } = await import('../../src/index.js')
    const bundle = createBundle()
    const bundlePath = writeBundle(bundle)
    const skillsSource = createSkillSource('ns-idem-skill')

    await install({ harness: 'claude', bundlePath, skillsSource })

    const sharedSkillDir = join(tmpDir, '.agents', 'skills', 'ns-idem-skill')
    const skillMd = join(sharedSkillDir, 'SKILL.md')
    const originalContent = readFileSync(skillMd, 'utf8')
    writeFileSync(skillMd, '# mutated content')

    await install({ harness: 'claude', bundlePath, skillsSource })

    const restoredContent = readFileSync(skillMd, 'utf8')
    assert.strictEqual(restoredContent, originalContent, 'skill file was overwritten back to source')
  })

  it('preserves user existing MCP config', async () => {
    const { install } = await import('../../src/index.js')
    const bundle = createBundle()
    const bundlePath = writeBundle(bundle)
    const skillsSource = createSkillSource('ns-idem-skill')

    mkdirSync(join(tmpDir, '.claude'), { recursive: true })
    writeFileSync(
      join(tmpDir, '.claude.json'),
      JSON.stringify({ mcpServers: { 'my-personal-server': { url: 'https://x', headers: {} } } })
    )

    await install({ harness: 'claude', bundlePath, skillsSource })

    const cfg = await getAdapter('claude').readMcpConfig()
    assert.ok(cfg.mcpServers['my-personal-server'], 'user MCP server preserved')
    assert.ok(cfg.mcpServers['ns-test-mcp'], 'NodeSource MCP server added')
  })

  it('preserves user existing skill dir in shared agents skills', async () => {
    const { install } = await import('../../src/index.js')
    const bundle = createBundle()
    const bundlePath = writeBundle(bundle)
    const skillsSource = createSkillSource('ns-idem-skill')

    const userSkillDir = join(tmpDir, '.agents', 'skills', 'my-custom-skill')
    mkdirSync(userSkillDir, { recursive: true })
    writeFileSync(join(userSkillDir, 'SKILL.md'), '# custom')

    await install({ harness: 'claude', bundlePath, skillsSource })

    assert.ok(existsSync(userSkillDir), 'user skill dir still exists')
    assert.ok(existsSync(join(tmpDir, '.agents', 'skills', 'ns-idem-skill')), 'our skill installed')

    const { uninstall } = await import('../../src/index.js')
    await uninstall('claude')

    assert.ok(existsSync(userSkillDir), 'user skill dir survives uninstall')
    assert.ok(!existsSync(join(tmpDir, '.agents', 'skills', 'ns-idem-skill')), 'our skill removed')
  })

  it('uninstall removes only ns-* servers, leaving user servers intact', async () => {
    const { install, uninstall } = await import('../../src/index.js')
    const bundle = createBundle()
    const bundlePath = writeBundle(bundle)
    const skillsSource = createSkillSource('ns-idem-skill')

    mkdirSync(join(tmpDir, '.claude'), { recursive: true })
    writeFileSync(
      join(tmpDir, '.claude.json'),
      JSON.stringify({ mcpServers: { 'my-personal-server': { url: 'https://x', headers: {} } } })
    )

    await install({ harness: 'claude', bundlePath, skillsSource })
    await uninstall('claude')

    const cfg = await getAdapter('claude').readMcpConfig()
    assert.ok(cfg.mcpServers['my-personal-server'], 'user MCP server preserved after uninstall')
    assert.ok(!cfg.mcpServers['ns-test-mcp'], 'NodeSource MCP server removed')
  })

  it('partial-failure recovery: skills land even when MCP write fails', async () => {
    const { install } = await import('../../src/index.js')
    const bundle = createBundle()
    const bundlePath = writeBundle(bundle)
    const skillsSource = createSkillSource('ns-idem-skill')

    // Block MCP config write by creating a directory where the file should be
    mkdirSync(join(tmpDir, '.claude.json'), { recursive: true })

    const res = await install({ harness: 'claude', bundlePath, skillsSource })

    assert.strictEqual(res.success, false, 'install reports failure')
    assert.ok(res.errors.length > 0, 'has errors')
    assert.strictEqual(res.skillsInstalled, 1, 'skills still landed')

    // Fix the path and re-run
    rmSync(join(tmpDir, '.claude.json'), { recursive: true, force: true })
    const res2 = await install({ harness: 'claude', bundlePath, skillsSource })

    assert.strictEqual(res2.success, true, 're-run succeeds')
    assert.ok(res2.mcpServersConfigured.includes('ns-test-mcp'), 'MCP servers now present')
  })
})
