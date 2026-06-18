import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { BundleDescriptor } from '../../../src/types.js'

let tmpDir: string
let originalHome: string | undefined
let originalUserProfile: string | undefined

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'nsolid-logout-'))
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
      { name: 'ns-test-skill', path: 'skills/ns-test-skill', description: 'Test skill' },
    ],
    mcpServers: [
      { name: 'ns-test-mcp', url: 'https://mcp.example.com', headers: { Authorization: 'Bearer test' } },
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

function seedCredentials (): void {
  const agentsDir = join(tmpDir, '.agents')
  mkdirSync(agentsDir, { recursive: true })
  writeFileSync(join(agentsDir, '.nodesource-auth.json'), JSON.stringify({
    serviceToken: 'test-token',
    organizationId: 'test-org',
    saasToken: 'test-saas',
    consoleUrl: 'https://console.nodesource.com',
    mcpUrl: 'https://mcp.nodesource.com',
    expiresAt: '2099-01-01T00:00:00.000Z',
    permissions: [],
  }))
}

describe('logout()', () => {
  it('removes credentials when present', async () => {
    const { logout } = await import('../../../src/index.js')
    const { getAuthFilePath } = await import('../../../src/utils/path.js')

    seedCredentials()
    assert.ok(existsSync(getAuthFilePath()), 'credentials exist before logout')

    const result = await logout()

    assert.strictEqual(result.removed, true)
    assert.strictEqual(result.path, getAuthFilePath())
    assert.ok(!existsSync(getAuthFilePath()), 'credentials removed after logout')
  })

  it('is idempotent when credentials are absent', async () => {
    const { logout } = await import('../../../src/index.js')
    const { getAuthFilePath } = await import('../../../src/utils/path.js')

    const result = await logout()

    assert.strictEqual(result.removed, false)
    assert.strictEqual(result.path, getAuthFilePath())
  })

  it('does not touch harness MCP config', async () => {
    const { logout } = await import('../../../src/index.js')
    const { getAuthFilePath } = await import('../../../src/utils/path.js')

    seedCredentials()
    const claudeConfig = join(tmpDir, '.claude.json')
    writeFileSync(claudeConfig, JSON.stringify({ mcpServers: { 'ns-test-mcp': {} } }))

    await logout()

    assert.ok(existsSync(claudeConfig), 'harness MCP config survives logout')
    assert.ok(!existsSync(getAuthFilePath()), 'credentials removed after logout')
  })
})

describe('uninstall() credential purge', () => {
  it('purges credentials when uninstalling the last tracked harness', async () => {
    const { install, uninstall } = await import('../../../src/index.js')
    const { getAuthFilePath } = await import('../../../src/utils/path.js')

    const bundle = createBundle()
    const bundlePath = writeBundle(bundle)
    const skillsSource = createSkillSource('ns-test-skill')

    seedCredentials()
    await install({ harness: 'claude', bundlePath, skillsSource })
    assert.ok(existsSync(getAuthFilePath()), 'credentials present after install')

    const result = await uninstall('claude')

    assert.strictEqual(result.credentialsPurged, true)
    assert.ok(!existsSync(getAuthFilePath()), 'credentials removed after last-harness uninstall')
  })

  it('keeps credentials when other harnesses remain tracked', async () => {
    const { install, uninstall } = await import('../../../src/index.js')
    const { getAuthFilePath } = await import('../../../src/utils/path.js')

    const bundle = createBundle()
    const bundlePath = writeBundle(bundle)
    const skillsSource = createSkillSource('ns-test-skill')

    seedCredentials()
    await install({ harness: 'claude', bundlePath, skillsSource })
    await install({ harness: 'codex', bundlePath, skillsSource })
    assert.ok(existsSync(getAuthFilePath()), 'credentials present after installs')

    const first = await uninstall('claude')
    assert.strictEqual(first.credentialsPurged, false)
    assert.ok(existsSync(getAuthFilePath()), 'credentials still present after first uninstall')

    const second = await uninstall('codex')
    assert.strictEqual(second.credentialsPurged, true)
    assert.ok(!existsSync(getAuthFilePath()), 'credentials removed after final uninstall')
  })

  it('honors keepCredentials to skip auto-purge', async () => {
    const { install, uninstall } = await import('../../../src/index.js')
    const { getAuthFilePath } = await import('../../../src/utils/path.js')

    const bundle = createBundle()
    const bundlePath = writeBundle(bundle)
    const skillsSource = createSkillSource('ns-test-skill')

    seedCredentials()
    await install({ harness: 'claude', bundlePath, skillsSource })

    const result = await uninstall('claude', { keepCredentials: true })

    assert.strictEqual(result.credentialsPurged, false)
    assert.ok(existsSync(getAuthFilePath()), 'credentials preserved with keepCredentials')
  })

  it('does not purge credentials in best-effort cleanup', async () => {
    const { install, uninstall } = await import('../../../src/index.js')
    const { getAuthFilePath, getTrackingFilePath } = await import('../../../src/utils/path.js')

    const bundle = createBundle()
    const bundlePath = writeBundle(bundle)
    const skillsSource = createSkillSource('ns-test-skill')

    seedCredentials()
    await install({ harness: 'claude', bundlePath, skillsSource })
    unlinkSync(getTrackingFilePath())

    const result = await uninstall('claude')

    assert.ok(!result.credentialsPurged, 'credentialsPurged is falsy in best-effort path')
    assert.ok(existsSync(getAuthFilePath()), 'credentials preserved in best-effort cleanup')
  })
})
