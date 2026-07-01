import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { getAdapter } from '../../src/harnesses/index.js'
import type { BundleDescriptor } from '../../src/types.js'

const MATRIX = [
  { harness: 'claude', configRel: '.claude.json', urlKey: 'url' },
  { harness: 'codex', configRel: '.codex/config.toml', urlKey: 'url' },
  { harness: 'opencode', configRel: '.config/opencode/opencode.jsonc', urlKey: 'url' },
  { harness: 'antigravity', configRel: '.gemini/config/mcp_config.json', urlKey: 'serverUrl' },
  { harness: 'pi', configRel: '.pi/agent/mcp.json', urlKey: 'url' },
] as const

let tmpDir: string
let originalHome: string | undefined
let originalUserProfile: string | undefined

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'nsolid-matrix-'))
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
      { name: 'ns-matrix-skill', path: 'skills/ns-matrix-skill', description: 'Matrix test skill' },
    ],
    mcpServers: [
      { name: 'nsolid-console', url: 'https://mcp.nodesource.com/console', headers: {} },
      { name: 'ns-benchmark', url: 'https://mcp.nodesource.com/benchmark', headers: {} },
      { name: 'ncm', url: 'https://mcp.nodesource.com/ncm', headers: {} },
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

for (const { harness, configRel, urlKey } of MATRIX) {
  describe(`harness matrix: ${harness}`, () => {
    it('installs skills to shared dir + links to harness dir', async () => {
      const { install } = await import('../../src/index.js')
      const bundle = createBundle()
      const bundlePath = writeBundle(bundle)
      const skillsSource = createSkillSource('ns-matrix-skill')

      const res = await install({ harness, bundlePath, skillsSource })

      assert.strictEqual(res.success, true)
      assert.ok(existsSync(join(tmpDir, '.agents', 'skills', 'ns-matrix-skill')), 'shared skill copied')
      const harnessSkills = getAdapter(harness).getSkillsPath()
      assert.ok(existsSync(join(harnessSkills, 'ns-matrix-skill')), 'skill linked into harness dir')
    })

    it('writes all 3 MCP servers in the harness config with the correct URL key', async () => {
      const { install } = await import('../../src/index.js')
      const bundle = createBundle()
      const bundlePath = writeBundle(bundle)
      const skillsSource = createSkillSource('ns-matrix-skill')

      await install({ harness, bundlePath, skillsSource })

      const cfg = await getAdapter(harness).readMcpConfig()
      for (const name of ['nsolid-console', 'ns-benchmark', 'ncm']) {
        assert.ok(cfg.mcpServers[name], `${name} present for ${harness}`)
      }

      const first = cfg.mcpServers['nsolid-console']
      assert.ok(first?.url, `${harness}: normalized 'url' field present`)

      if (urlKey === 'serverUrl') {
        const raw = readFileSync(join(tmpDir, configRel), 'utf8')
        assert.ok(raw.includes('"serverUrl"'), 'antigravity writes serverUrl')
      }
    })

    it('uninstalls cleanly: removes links + MCP entries for this harness only', async () => {
      const { install, uninstall } = await import('../../src/index.js')
      const bundle = createBundle()
      const bundlePath = writeBundle(bundle)
      const skillsSource = createSkillSource('ns-matrix-skill')
      await install({ harness, bundlePath, skillsSource })

      await uninstall(harness)

      const harnessSkills = getAdapter(harness).getSkillsPath()
      assert.ok(!existsSync(join(harnessSkills, 'ns-matrix-skill')), 'link removed from harness')
      const cfg = await getAdapter(harness).readMcpConfig()
      assert.ok(!cfg.mcpServers['nsolid-console'], 'MCP entry removed')
    })
  })
}
