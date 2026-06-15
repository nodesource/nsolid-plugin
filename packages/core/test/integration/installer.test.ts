import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { BundleDescriptor } from '../../src/types.js'
import type { TrackingData } from '../../src/skills/skill-tracker.js'

let tmpDir: string
let originalHome: string | undefined

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'nsolid-installer-'))
  originalHome = process.env.HOME
  process.env.HOME = tmpDir
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
  if (originalHome !== undefined) {
    process.env.HOME = originalHome
  }
})

function createBundle (overrides?: Partial<BundleDescriptor>): BundleDescriptor {
  return {
    name: 'test-bundle',
    version: '1.0.0',
    skills: [
      { name: 'ns-test-skill', path: 'skills/ns-test-skill', description: 'Test skill' },
    ],
    mcpServers: [
      { name: 'ns-test-mcp', command: 'node', args: ['test.js'] },
    ],
    ...overrides,
  }
}

function writeBundle (bundle: BundleDescriptor, dir?: string): string {
  const bundleDir = dir ?? join(tmpDir, 'bundle')
  mkdirSync(bundleDir, { recursive: true })
  const bundlePath = join(bundleDir, 'bundle.json')
  writeFileSync(bundlePath, JSON.stringify(bundle, null, 2))
  return bundlePath
}

function createSkillSource (skillName: string, dir?: string): string {
  const sourceDir = dir ?? join(tmpDir, 'source')
  const skillDir = join(sourceDir, 'skills', skillName)
  mkdirSync(skillDir, { recursive: true })
  writeFileSync(join(skillDir, 'SKILL.md'), `# ${skillName}`)
  return sourceDir
}

describe('install()', () => {
  it('copies skills, links, and tracks on happy path', async () => {
    const { install } = await import('../../src/index.js')
    const bundle = createBundle()
    const bundlePath = writeBundle(bundle)
    const skillsSource = createSkillSource('ns-test-skill')

    const result = await install({
      harness: 'claude',
      bundlePath,
      skillsSource,
    })

    assert.strictEqual(result.success, true)
    assert.strictEqual(result.skillsInstalled, 1)
    assert.deepStrictEqual(result.mcpServersConfigured, ['ns-test-mcp'])
    assert.strictEqual(result.hadToAuthenticate, false)
    assert.deepStrictEqual(result.errors, [])

    const skillsDir = join(tmpDir, '.agents', 'skills', 'ns-test-skill')
    assert.ok(existsSync(skillsDir), 'skill was copied')

    const harnessSkillsLink = join(tmpDir, '.claude', 'skills', 'ns-test-skill')
    assert.ok(existsSync(harnessSkillsLink), 'skill was linked to harness')
  })

  it('warns when harness does not support MCP', async () => {
    const { install } = await import('../../src/index.js')
    const bundle = createBundle()
    const bundlePath = writeBundle(bundle)
    const skillsSource = createSkillSource('ns-test-skill')

    const result = await install({
      harness: 'pi',
      bundlePath,
      skillsSource,
    })

    assert.strictEqual(result.success, false)
    assert.deepStrictEqual(result.mcpServersConfigured, [])
    assert.ok(result.errors.some((e) => e.includes('does not support MCP')))
  })

  it('returns error when bundle not found', async () => {
    const { install } = await import('../../src/index.js')

    const result = await install({
      harness: 'claude',
      bundlePath: join(tmpDir, 'nonexistent', 'bundle.json'),
      skillsSource: tmpDir,
    })

    assert.strictEqual(result.success, false)
    assert.ok(result.errors[0].includes('Bundle not found'))
  })

  it('returns error on invalid bundle', async () => {
    const { install } = await import('../../src/index.js')
    const bundlePath = writeBundle({ name: 'bad', version: '1.0.0', skills: [], mcpServers: [] })

    const result = await install({
      harness: 'claude',
      bundlePath,
      skillsSource: tmpDir,
    })

    assert.strictEqual(result.success, false)
    assert.ok(result.errors[0].includes('validation failed'))
  })

  it('returns error on skill copy failure', async () => {
    const { install } = await import('../../src/index.js')
    const bundle = createBundle()
    const bundlePath = writeBundle(bundle)
    const skillsSource = createSkillSource('ns-other-skill')

    const result = await install({
      harness: 'claude',
      bundlePath,
      skillsSource,
    })

    assert.strictEqual(result.success, false)
    assert.ok(result.errors[0].includes('Failed to copy skill'))
  })

  it('tracks MCP entries with valid config path', async () => {
    const { install } = await import('../../src/index.js')
    const bundle = createBundle()
    const bundlePath = writeBundle(bundle)
    const skillsSource = createSkillSource('ns-test-skill')

    await install({ harness: 'claude', bundlePath, skillsSource })

    const { readJsonFile } = await import('../../src/utils/config.js')
    const { getTrackingFilePath } = await import('../../src/utils/path.js')
    const tracking = readJsonFile<TrackingData>(await getTrackingFilePath())

    assert.ok(tracking, 'tracking file exists')
    assert.ok(tracking.mcpServers.length > 0, 'MCP entries tracked')
    assert.strictEqual(tracking.mcpServers[0].name, 'ns-test-mcp')
    assert.ok(tracking.mcpServers[0].configPath.includes('.claude'))
  })

  it('does not track MCP when harness has no config path', async () => {
    const { install } = await import('../../src/index.js')
    const bundle = createBundle()
    const bundlePath = writeBundle(bundle)
    const skillsSource = createSkillSource('ns-test-skill')

    await install({ harness: 'pi', bundlePath, skillsSource })

    const { readJsonFile } = await import('../../src/utils/config.js')
    const { getTrackingFilePath } = await import('../../src/utils/path.js')
    const tracking = readJsonFile<TrackingData>(await getTrackingFilePath())

    assert.ok(tracking, 'tracking file exists')
    assert.strictEqual(tracking.mcpServers.length, 0, 'no MCP entries tracked for Pi')
  })
})

describe('uninstall()', () => {
  it('removes MCP configs, unlinks skills, deletes tracking', async () => {
    const { install, uninstall } = await import('../../src/index.js')
    const bundle = createBundle()
    const bundlePath = writeBundle(bundle)
    const skillsSource = createSkillSource('ns-test-skill')

    await install({ harness: 'claude', bundlePath, skillsSource })

    const harnessSkillsPath = join(tmpDir, '.claude', 'skills', 'ns-test-skill')
    assert.ok(existsSync(harnessSkillsPath), 'skill linked before uninstall')

    await uninstall('claude')

    assert.ok(!existsSync(harnessSkillsPath), 'skill unlinked after uninstall')

    const { readJsonFile } = await import('../../src/utils/config.js')
    const { getTrackingFilePath } = await import('../../src/utils/path.js')
    const tracking = readJsonFile<TrackingData>(await getTrackingFilePath())

    if (tracking) {
      assert.strictEqual(tracking.skills.length, 0, 'skills removed from tracking')
      assert.strictEqual(
        tracking.mcpServers.filter((m) => m.harness === 'claude').length,
        0,
        'MCP entries removed from tracking'
      )
    }
  })

  it('preserves artifacts from other harnesses', async () => {
    const { install, uninstall } = await import('../../src/index.js')
    const bundle = createBundle()
    const bundlePath = writeBundle(bundle)
    const skillsSource = createSkillSource('ns-test-skill')

    await install({ harness: 'claude', bundlePath, skillsSource })
    await install({ harness: 'codex', bundlePath, skillsSource })

    await uninstall('claude')

    const { readJsonFile } = await import('../../src/utils/config.js')
    const { getTrackingFilePath } = await import('../../src/utils/path.js')
    const tracking = readJsonFile<TrackingData>(await getTrackingFilePath())

    assert.ok(tracking, 'tracking file still exists')
    const codexSkills = tracking.skills.filter((s) => s.harnesses.includes('codex'))
    assert.ok(codexSkills.length > 0, 'codex skills preserved')
  })

  it('handles missing tracking file with best-effort cleanup', async () => {
    const { uninstall } = await import('../../src/index.js')

    const skillsDir = join(tmpDir, '.agents', 'skills', 'ns-orphan-skill')
    mkdirSync(skillsDir, { recursive: true })
    writeFileSync(join(skillsDir, 'SKILL.md'), '# orphan')

    await uninstall('claude')

    assert.ok(existsSync(skillsDir), 'orphan skill preserved in shared directory')
  })

  it('does nothing when no tracking and no orphan skills', async () => {
    const { uninstall } = await import('../../src/index.js')

    await assert.doesNotReject(() => uninstall('claude'))
  })
})

describe('doctor()', () => {
  it('returns healthy report when everything is in order', async () => {
    const { install, doctor } = await import('../../src/index.js')
    const { getAuthFilePath, getAgentsDir } = await import('../../src/utils/path.js')
    const { ensureDir } = await import('../../src/utils/fs.js')

    ensureDir(getAgentsDir())
    const futureDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
    writeFileSync(getAuthFilePath(), JSON.stringify({
      serviceToken: 'valid-token',
      organizationId: 'valid-org',
      saasToken: 'valid-saas',
      consoleUrl: 'https://console.nodesource.com',
      mcpUrl: 'https://mcp.nodesource.com',
      expiresAt: futureDate,
    }))

    const bundle = createBundle()
    const bundlePath = writeBundle(bundle)
    const skillsSource = createSkillSource('ns-test-skill')

    await install({ harness: 'claude', bundlePath, skillsSource })

    const report = await doctor('claude', bundlePath)

    assert.strictEqual(report.healthy, true)
    assert.strictEqual(report.credentials.status, 'ok')
    assert.strictEqual(report.skills.status, 'ok')
    assert.ok(report.skills.installed.includes('ns-test-skill'))
    assert.deepStrictEqual(report.skills.missing, [])
    assert.strictEqual(report.mcpServers.status, 'ok')
    assert.ok(report.mcpServers.reachable.includes('ns-test-mcp'))
    assert.deepStrictEqual(report.errors, [])
  })

  it('reports missing credentials', async () => {
    const { doctor } = await import('../../src/index.js')
    const bundle = createBundle()
    const bundlePath = writeBundle(bundle)

    const report = await doctor('claude', bundlePath)

    assert.strictEqual(report.credentials.status, 'missing')
    assert.strictEqual(report.healthy, false)
  })

  it('reports expired credentials', async () => {
    const { doctor } = await import('../../src/index.js')
    const { getAuthFilePath, getAgentsDir } = await import('../../src/utils/path.js')
    const { ensureDir } = await import('../../src/utils/fs.js')

    ensureDir(getAgentsDir())
    writeFileSync(getAuthFilePath(), JSON.stringify({
      serviceToken: 'token',
      organizationId: 'org',
      saasToken: 'saas',
      consoleUrl: 'https://console.nodesource.com',
      mcpUrl: 'https://mcp.nodesource.com',
      expiresAt: '2020-01-01T00:00:00.000Z',
    }))

    const bundle = createBundle()
    const bundlePath = writeBundle(bundle)

    const report = await doctor('claude', bundlePath)

    assert.strictEqual(report.credentials.status, 'expired')
    assert.strictEqual(report.healthy, false)
  })

  it('reports missing skills', async () => {
    const { doctor } = await import('../../src/index.js')
    const bundle = createBundle()
    const bundlePath = writeBundle(bundle)

    const report = await doctor('claude', bundlePath)

    assert.strictEqual(report.skills.status, 'missing')
    assert.deepStrictEqual(report.skills.installed, [])
    assert.ok(report.skills.missing.includes('ns-test-skill'))
  })

  it('reports partial skills when some installed', async () => {
    const { install, doctor } = await import('../../src/index.js')
    const bundle = createBundle({
      skills: [
        { name: 'ns-test-skill', path: 'skills/ns-test-skill', description: 'Test' },
        { name: 'ns-another-skill', path: 'skills/ns-another-skill', description: 'Another' },
      ],
    })
    const bundlePath = writeBundle(bundle)
    const skillsSource = join(tmpDir, 'source')
    mkdirSync(join(skillsSource, 'skills', 'ns-test-skill'), { recursive: true })
    writeFileSync(join(skillsSource, 'skills', 'ns-test-skill', 'SKILL.md'), '# test')
    mkdirSync(join(skillsSource, 'skills', 'ns-another-skill'), { recursive: true })
    writeFileSync(join(skillsSource, 'skills', 'ns-another-skill', 'SKILL.md'), '# another')

    await install({ harness: 'claude', bundlePath, skillsSource })

    const { readJsonFile } = await import('../../src/utils/config.js')
    const { getTrackingFilePath } = await import('../../src/utils/path.js')
    const { writeJsonFile } = await import('../../src/utils/fs.js')
    const { rmSync } = await import('node:fs')
    const trackingPath = getTrackingFilePath()
    const tracking = readJsonFile<TrackingData>(trackingPath)
    assert.ok(tracking, 'tracking file exists after install')
    tracking.skills = tracking.skills.filter((s) => s.name === 'ns-test-skill')
    await writeJsonFile(trackingPath, tracking)

    rmSync(join(tmpDir, '.claude', 'skills', 'ns-another-skill'), { recursive: true, force: true })

    const report = await doctor('claude', bundlePath)

    assert.strictEqual(report.skills.status, 'partial')
    assert.ok(report.skills.installed.includes('ns-test-skill'))
    assert.ok(report.skills.missing.includes('ns-another-skill'))
  })

  it('reports unreachable MCPs when not tracked', async () => {
    const { doctor } = await import('../../src/index.js')
    const bundle = createBundle()
    const bundlePath = writeBundle(bundle)

    const report = await doctor('claude', bundlePath)

    assert.strictEqual(report.mcpServers.status, 'unreachable')
    assert.deepStrictEqual(report.mcpServers.reachable, [])
    assert.ok(report.mcpServers.unreachable.includes('ns-test-mcp'))
  })

  it('returns mcpStatus ok for Pi (no MCP support)', async () => {
    const { install, doctor } = await import('../../src/index.js')
    const bundle = createBundle()
    const bundlePath = writeBundle(bundle)
    const skillsSource = createSkillSource('ns-test-skill')

    await install({ harness: 'pi', bundlePath, skillsSource })

    const report = await doctor('pi', bundlePath)

    assert.strictEqual(report.mcpServers.status, 'ok')
    assert.deepStrictEqual(report.mcpServers.reachable, [])
    assert.deepStrictEqual(report.mcpServers.unreachable, [])
  })

  it('reports errors when bundle path is invalid', async () => {
    const { doctor } = await import('../../src/index.js')

    const report = await doctor('claude', join(tmpDir, 'nonexistent', 'bundle.json'))

    assert.ok(report.errors.length > 0)
    assert.strictEqual(report.skills.status, 'unknown')
    assert.strictEqual(report.mcpServers.status, 'unknown')
  })
})
