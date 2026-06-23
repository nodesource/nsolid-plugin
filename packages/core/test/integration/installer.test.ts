import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join, sep } from 'node:path'
import { tmpdir } from 'node:os'
import type { BundleDescriptor } from '../../src/types.js'
import type { ProgressReporter } from '../../src/utils/progress.js'
import type { TrackingData } from '../../src/skills/skill-tracker.js'

let tmpDir: string
let originalHome: string | undefined
let originalUserProfile: string | undefined
let originalProgressEnv: string | undefined
let originalFetch: typeof globalThis.fetch

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'nsolid-installer-'))
  originalHome = process.env.HOME
  originalUserProfile = process.env.USERPROFILE
  originalProgressEnv = process.env.NSOLID_PLUGIN_PROGRESS
  originalFetch = globalThis.fetch
  process.env.HOME = tmpDir
  process.env.USERPROFILE = tmpDir
  delete process.env.NSOLID_PLUGIN_PROGRESS
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
  if (originalProgressEnv !== undefined) {
    process.env.NSOLID_PLUGIN_PROGRESS = originalProgressEnv
  } else {
    delete process.env.NSOLID_PLUGIN_PROGRESS
  }
  globalThis.fetch = originalFetch
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

function seedCredentials (overrides: Partial<{
  serviceToken: string
  organizationId: string
  saasToken: string
  consoleUrl: string
  mcpUrl: string
}> = {}): void {
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
    ...overrides,
  }))
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

  it('setup for Claude authenticates only and leaves skills/MCPs to the plugin', async () => {
    const { setup } = await import('../../src/index.js')
    const bundle = createBundle({
      auth: {
        type: 'oauth',
        provider: 'nodesource',
        accountsUrl: 'https://accounts.nodesource.com',
      },
    })
    const bundlePath = writeBundle(bundle)
    const skillsSource = createSkillSource('ns-test-skill')
    seedCredentials()
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ permissions: [] }),
    })) as unknown as typeof fetch
    const progress: ProgressReporter = {
      header: () => {},
      step: () => {},
      done: () => {},
      warn: () => {},
    }

    const result = await setup({ harness: 'claude', bundlePath, skillsSource, progress })

    assert.strictEqual(result.success, true)
    assert.strictEqual(result.skillsInstalled, 0)
    assert.deepStrictEqual(result.mcpServersConfigured, [])
    assert.strictEqual(existsSync(join(tmpDir, '.claude', 'skills', 'ns-test-skill')), false)
    assert.strictEqual(existsSync(join(tmpDir, '.claude.json')), false)
  })

  it('setup for Antigravity authenticates only and does not write global skills/MCP config', async () => {
    const { setup } = await import('../../src/index.js')
    const bundle = createBundle({
      auth: {
        type: 'oauth',
        provider: 'nodesource',
        accountsUrl: 'https://accounts.nodesource.com',
      },
    })
    const bundlePath = writeBundle(bundle)
    const skillsSource = createSkillSource('ns-test-skill')
    seedCredentials()
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ permissions: [] }),
    })) as unknown as typeof fetch
    const progress: ProgressReporter = {
      header: () => {},
      step: () => {},
      done: () => {},
      warn: () => {},
    }

    const result = await setup({ harness: 'antigravity', bundlePath, skillsSource, progress })

    assert.strictEqual(result.success, true)
    assert.strictEqual(result.skillsInstalled, 0)
    assert.deepStrictEqual(result.mcpServersConfigured, [])
    assert.strictEqual(existsSync(join(tmpDir, '.gemini', 'config', 'skills', 'ns-test-skill')), false)
    assert.strictEqual(existsSync(join(tmpDir, '.gemini', 'config', 'mcp_config.json')), false)
  })

  it('setup for Codex authenticates only and does not write user-level skills/MCP config', async () => {
    const { setup } = await import('../../src/index.js')
    const bundle = createBundle({
      auth: {
        type: 'oauth',
        provider: 'nodesource',
        accountsUrl: 'https://accounts.nodesource.com',
      },
    })
    const bundlePath = writeBundle(bundle)
    const skillsSource = createSkillSource('ns-test-skill')
    seedCredentials()
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ permissions: [] }),
    })) as unknown as typeof fetch
    const progress: ProgressReporter = {
      header: () => {},
      step: () => {},
      done: () => {},
      warn: () => {},
    }

    const result = await setup({ harness: 'codex', bundlePath, skillsSource, progress })

    assert.strictEqual(result.success, true)
    assert.strictEqual(result.skillsInstalled, 0)
    assert.deepStrictEqual(result.mcpServersConfigured, [])
    assert.strictEqual(existsSync(join(tmpDir, '.codex', 'skills', 'ns-test-skill')), false)
    assert.strictEqual(existsSync(join(tmpDir, '.codex', 'config.toml')), false)
  })

  it('setup for Pi writes MCP config but skips user-level skills when package owns skills', async () => {
    const { setup } = await import('../../src/index.js')
    const { readJsonFile } = await import('../../src/utils/config.js')
    const bundle = createBundle({
      auth: {
        type: 'oauth',
        provider: 'nodesource',
        accountsUrl: 'https://accounts.nodesource.com',
      },
    })
    const bundlePath = writeBundle(bundle)
    const skillsSource = createSkillSource('ns-test-skill')
    seedCredentials()
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ permissions: [] }),
    })) as unknown as typeof fetch
    const progress: ProgressReporter = {
      header: () => {},
      step: () => {},
      done: () => {},
      warn: () => {},
    }

    const result = await setup({ harness: 'pi', bundlePath, skillsSource, progress, packageOwnedSkills: true })

    assert.strictEqual(result.success, true)
    assert.strictEqual(result.skillsInstalled, 0)
    assert.deepStrictEqual(result.mcpServersConfigured, ['ns-test-mcp'])
    assert.strictEqual(existsSync(join(tmpDir, '.agents', 'skills', 'ns-test-skill')), false)
    assert.strictEqual(existsSync(join(tmpDir, '.pi', 'agent', 'skills', 'ns-test-skill')), false)
    const piConfig = readJsonFile<Record<string, unknown>>(join(tmpDir, '.pi', 'agent', 'mcp.json'))
    const piServer = (piConfig?.mcpServers as Record<string, { auth?: boolean }> | undefined)?.['ns-test-mcp']
    assert.ok(piServer)
    assert.strictEqual(piServer.auth, false)
  })

  it('prefers stored explicit MCP URL over derived console URL', async () => {
    const { install } = await import('../../src/index.js')
    const { readJsonFile } = await import('../../src/utils/config.js')
    const bundle = createBundle({
      mcpServers: [
        { name: 'nsolid-console', url: '$' + '{MCP_URL}', headers: { 'X-Nsolid-Service-Token': '$' + '{AUTH_TOKEN}' } },
      ],
      auth: {
        type: 'oauth',
        provider: 'nodesource',
        accountsUrl: 'https://accounts.nodesource.com',
      },
    })
    const bundlePath = writeBundle(bundle)
    const skillsSource = createSkillSource('ns-test-skill')
    seedCredentials({
      consoleUrl: 'https://test-org.staging.saas.nodesource.io',
      mcpUrl: 'https://custom-mcp.example.com/entry',
    })

    const result = await install({ harness: 'claude', bundlePath, skillsSource })

    assert.strictEqual(result.success, true)
    const claudeConfig = readJsonFile<Record<string, unknown>>(join(tmpDir, '.claude.json'))
    assert.ok(claudeConfig?.mcpServers && typeof claudeConfig.mcpServers === 'object')
    const servers = claudeConfig.mcpServers as Record<string, { type?: string; url?: string }>
    assert.strictEqual(servers['nsolid-console'].type, 'http')
    assert.strictEqual(servers['nsolid-console'].url, 'https://custom-mcp.example.com/entry')
  })

  it('derives staging console MCP URL without appending /mcp when no explicit MCP URL is stored', async () => {
    const { install } = await import('../../src/index.js')
    const { readJsonFile } = await import('../../src/utils/config.js')
    const bundle = createBundle({
      mcpServers: [
        { name: 'nsolid-console', url: '$' + '{MCP_URL}', headers: { 'X-Nsolid-Service-Token': '$' + '{AUTH_TOKEN}' } },
      ],
      auth: {
        type: 'oauth',
        provider: 'nodesource',
        accountsUrl: 'https://accounts.nodesource.com',
      },
    })
    const bundlePath = writeBundle(bundle)
    const skillsSource = createSkillSource('ns-test-skill')
    seedCredentials({
      consoleUrl: 'https://test-org.staging.saas.nodesource.io',
      mcpUrl: '',
    })

    const result = await install({ harness: 'claude', bundlePath, skillsSource })

    assert.strictEqual(result.success, true)
    const claudeConfig = readJsonFile<Record<string, unknown>>(join(tmpDir, '.claude.json'))
    assert.ok(claudeConfig?.mcpServers && typeof claudeConfig.mcpServers === 'object')
    const servers = claudeConfig.mcpServers as Record<string, { type?: string; url?: string }>
    assert.strictEqual(servers['nsolid-console'].type, 'http')
    assert.strictEqual(servers['nsolid-console'].url, 'https://test-org.mcp.staging.saas.nodesource.io/')
  })

  it('writes MCP config for Pi', async () => {
    const { install } = await import('../../src/index.js')
    const bundle = createBundle()
    const bundlePath = writeBundle(bundle)
    const skillsSource = createSkillSource('ns-test-skill')

    const result = await install({
      harness: 'pi',
      bundlePath,
      skillsSource,
    })

    assert.strictEqual(result.success, true)
    assert.deepStrictEqual(result.mcpServersConfigured, ['ns-test-mcp'])

    const { readJsonFile } = await import('../../src/utils/config.js')
    const piConfig = readJsonFile<Record<string, unknown>>(join(tmpDir, '.pi', 'agent', 'mcp.json'))
    assert.ok(piConfig, 'Pi MCP config file exists')
    assert.ok(piConfig.mcpServers && typeof piConfig.mcpServers === 'object')
    const piServer = (piConfig.mcpServers as Record<string, { auth?: boolean }>)['ns-test-mcp']
    assert.ok(piServer)
    assert.strictEqual(piServer.auth, false)
  })

  it('skips MCP config when credentials are missing and bundle has auth', async () => {
    const { install } = await import('../../src/index.js')
    const bundle = createBundle({
      mcpServers: [
        { name: 'nsolid-console', url: '$' + '{MCP_URL}', headers: { 'X-Nsolid-Service-Token': '$' + '{AUTH_TOKEN}' } },
      ],
      auth: {
        type: 'oauth',
        provider: 'nodesource',
        accountsUrl: 'https://accounts.nodesource.com',
      },
    })
    const bundlePath = writeBundle(bundle)
    const skillsSource = createSkillSource('ns-test-skill')

    const result = await install({ harness: 'claude', bundlePath, skillsSource })

    assert.strictEqual(result.hadToAuthenticate, true)
    assert.deepStrictEqual(result.mcpServersConfigured, [])
    const configPath = join(tmpDir, '.claude.json')
    if (existsSync(configPath)) {
      const { readJsonFile } = await import('../../src/utils/config.js')
      const config = readJsonFile<Record<string, unknown>>(configPath)
      const servers = config?.mcpServers as Record<string, { url?: string }> | undefined
      assert.ok(!servers || !servers['nsolid-console'],
        'MCP server with placeholders must not be written')
    }
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

  it('tracks MCP entries for Pi', async () => {
    const { install } = await import('../../src/index.js')
    const bundle = createBundle()
    const bundlePath = writeBundle(bundle)
    const skillsSource = createSkillSource('ns-test-skill')

    await install({ harness: 'pi', bundlePath, skillsSource })

    const { readJsonFile } = await import('../../src/utils/config.js')
    const { getTrackingFilePath } = await import('../../src/utils/path.js')
    const tracking = readJsonFile<TrackingData>(await getTrackingFilePath())

    assert.ok(tracking, 'tracking file exists')
    assert.strictEqual(tracking.mcpServers.length, 1, 'MCP entry tracked for Pi')
    assert.strictEqual(tracking.mcpServers[0].name, 'ns-test-mcp')
    assert.ok(tracking.mcpServers[0].configPath.includes(['.pi', 'agent', 'mcp.json'].join(sep)))
  })

  it('emits ordered progress events with valid credentials', async () => {
    const { install } = await import('../../src/index.js')
    const bundle = createBundle({
      auth: {
        type: 'oauth',
        provider: 'nodesource',
        accountsUrl: 'https://accounts.nodesource.com',
      },
    })
    const bundlePath = writeBundle(bundle)
    const skillsSource = createSkillSource('ns-test-skill')

    seedCredentials()

    const calls: Array<{ method: keyof ProgressReporter; label: string; detail?: string }> = []
    const fakeProgress: ProgressReporter = {
      header (title: string): void { calls.push({ method: 'header', label: title }) },
      step (label: string, detail?: string): void { calls.push({ method: 'step', label, detail }) },
      done (label: string): void { calls.push({ method: 'done', label }) },
      warn (label: string, detail?: string): void { calls.push({ method: 'warn', label, detail }) },
    }

    const result = await install({ harness: 'claude', bundlePath, skillsSource, progress: fakeProgress })

    assert.strictEqual(result.success, true)

    const methods = calls.map((c) => c.method)
    assert.deepStrictEqual(methods, [
      'header',
      'step',
      'step',
      'step',
      'step',
      'step',
      'done',
    ])

    assert.strictEqual(calls[0].label, 'NodeSource installer — claude')
    assert.strictEqual(calls[1].label, 'Reading bundle config')
    assert.strictEqual(calls[2].label, 'Checking NodeSource login')
    assert.ok(calls[2].detail?.includes('already signed in'))
    assert.strictEqual(calls[3].label, 'Copying skills')
    assert.strictEqual(calls[4].label, 'Linking skills')
    assert.strictEqual(calls[5].label, 'Merging MCP servers')
    assert.ok(calls[5].detail?.includes('ns-test-mcp'))
    assert.strictEqual(calls[6].label, 'Done — 1 skills installed for claude')
  })

  it('shows default progress on initial harness install and stays quiet on tracked re-run', async () => {
    const { install } = await import('../../src/index.js')
    const bundle = createBundle({
      auth: {
        type: 'oauth',
        provider: 'nodesource',
        accountsUrl: 'https://accounts.nodesource.com',
      },
    })
    const bundlePath = writeBundle(bundle)
    const skillsSource = createSkillSource('ns-test-skill')
    seedCredentials()

    const originalWrite = process.stderr.write
    let stderrOutput = ''
    process.stderr.write = ((chunk: unknown) => {
      stderrOutput += String(chunk)
      return true
    }) as typeof process.stderr.write

    try {
      const first = await install({ harness: 'claude', bundlePath, skillsSource })
      assert.strictEqual(first.success, true)
      assert.ok(stderrOutput.includes('NodeSource installer — claude'))
      assert.ok(stderrOutput.includes('Reading bundle config'))
      assert.ok(stderrOutput.includes('Done — 1 skills installed for claude'))

      stderrOutput = ''
      const second = await install({ harness: 'claude', bundlePath, skillsSource })
      assert.strictEqual(second.success, true)
      assert.strictEqual(stderrOutput, '')
    } finally {
      process.stderr.write = originalWrite
    }
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

    const sharedSkillsPath = join(tmpDir, '.agents', 'skills', 'ns-test-skill')
    assert.ok(!existsSync(sharedSkillsPath), 'shared skill source removed after uninstall')

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

  it('copies OpenCode harness-specific skills without writing shared skills', async () => {
    const { install } = await import('../../src/index.js')
    const bundle = createBundle()
    const bundlePath = writeBundle(bundle)
    const skillsSource = createSkillSource('ns-test-skill')

    const result = await install({
      harness: 'opencode',
      bundlePath,
      skillsSource,
      harnessSpecificSkills: true,
    })

    assert.strictEqual(result.success, true)
    assert.ok(existsSync(join(tmpDir, '.config', 'opencode', 'skills', 'ns-test-skill')), 'skill copied to OpenCode')
    assert.ok(!existsSync(join(tmpDir, '.agents', 'skills', 'ns-test-skill')), 'shared skill source not created')
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

    assert.ok(!existsSync(skillsDir), 'orphan skill removed from shared directory')
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

    rmSync(join(tmpDir, '.agents', 'skills', 'ns-another-skill'), { recursive: true, force: true })

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

  it('reports unreachable MCPs for Pi when not tracked', async () => {
    const { doctor } = await import('../../src/index.js')
    const bundle = createBundle()
    const bundlePath = writeBundle(bundle)

    const report = await doctor('pi', bundlePath)

    assert.strictEqual(report.mcpServers.status, 'unreachable')
    assert.deepStrictEqual(report.mcpServers.reachable, [])
    assert.ok(report.mcpServers.unreachable.includes('ns-test-mcp'))
  })

  it('detects Pi package-owned skills from installed package settings', async () => {
    const { doctor } = await import('../../src/index.js')
    const bundle = createBundle()
    const bundlePath = writeBundle(bundle)
    const packageRoot = join(tmpDir, 'pi-package')
    mkdirSync(join(packageRoot, 'skills', 'ns-test-skill'), { recursive: true })
    writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({
      name: '@nodesource/pi-plugin',
      pi: { skills: ['./skills'] },
    }))
    writeFileSync(join(packageRoot, 'skills', 'ns-test-skill', 'SKILL.md'), '# ns-test-skill')
    mkdirSync(join(tmpDir, '.pi', 'agent'), { recursive: true })
    writeFileSync(join(tmpDir, '.pi', 'agent', 'settings.json'), JSON.stringify({
      packages: [packageRoot],
    }))

    const report = await doctor('pi', bundlePath)

    assert.strictEqual(report.skills.status, 'ok')
    assert.deepStrictEqual(report.skills.installed, ['ns-test-skill'])
    assert.deepStrictEqual(report.skills.missing, [])
  })

  it('reports errors when bundle path is invalid', async () => {
    const { doctor } = await import('../../src/index.js')

    const report = await doctor('claude', join(tmpDir, 'nonexistent', 'bundle.json'))

    assert.ok(report.errors.length > 0)
    assert.strictEqual(report.skills.status, 'unknown')
    assert.strictEqual(report.mcpServers.status, 'unknown')
  })
})
