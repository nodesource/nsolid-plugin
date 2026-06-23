import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..', '..', '..', '..')
const SYNC_SCRIPT = join(REPO_ROOT, 'scripts', 'sync-plugin-assets.mjs')
const ARTIFACT_SCRIPT = join(REPO_ROOT, 'scripts', 'build-plugin-artifacts.mjs')

function makeWorkspaceRoot (): string {
  return mkdtempSync(join(tmpdir(), 'plugin-assets-test-'))
}

function writeBundle (root: string, skills: string[], mcpServers: string[]): void {
  const bundle = {
    name: 'nsolid-plugin',
    version: '9.9.9',
    description: 'test bundle',
    skills: skills.map((name) => ({
      name,
      path: `skills/${name}`,
      description: `Skill ${name}`,
      requiresMcp: mcpServers.slice(0, 1),
    })),
    mcpServers: mcpServers.map((name) => ({
      name,
      url: 'https://mcp.example.com',
      headers: { Authorization: 'Bearer test' },
    })),
    auth: {
      type: 'oauth',
      provider: 'nodesource',
      accountsUrl: 'https://accounts.nodesource.com',
      callbackPort: 8765,
      requiredPermissions: [],
    },
  }
  writeFileSync(join(root, 'bundle.json'), `${JSON.stringify(bundle, null, 2)}\n`)
}

function writeSkill (root: string, name: string, content: string): void {
  const skillDir = join(root, 'packages', 'core', 'skills', name)
  mkdirSync(skillDir, { recursive: true })
  writeFileSync(join(skillDir, 'SKILL.md'), content)
}

function copyTemplates (root: string): void {
  cpSync(join(REPO_ROOT, 'plugins'), join(root, 'plugins'), { recursive: true })
}

function runSync (root: string, args: string[] = []): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [SYNC_SCRIPT, ...args], {
    cwd: root,
    env: { ...process.env, NSOLID_PLUGIN_SYNC_ROOT: root },
    encoding: 'utf-8',
  })
}

function runArtifacts (root: string, args: string[] = []): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [ARTIFACT_SCRIPT, ...args], {
    cwd: root,
    env: { ...process.env, NSOLID_PLUGIN_ARTIFACTS_ROOT: root },
    encoding: 'utf-8',
  })
}

function readJson (path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
}

function outputText (output: string | Buffer | null | undefined): string {
  return typeof output === 'string' ? output : output?.toString('utf8') ?? ''
}

describe('plugin source hygiene and artifact generation', () => {
  let root: string

  beforeEach(() => {
    root = makeWorkspaceRoot()
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('keeps Pi as the only source package that materializes skills for pack', () => {
    writeSkill(root, 'ns-alpha', '# alpha\nextra line\n')
    writeBundle(root, ['ns-alpha'], ['ns-one'])

    const materialize = runSync(root, ['--materialize-skills'])
    assert.strictEqual(materialize.status, 0, outputText(materialize.stderr))

    const expected = readFileSync(join(root, 'packages', 'core', 'skills', 'ns-alpha', 'SKILL.md'))
    const actual = readFileSync(join(root, 'packages', 'pi-plugin', 'skills', 'ns-alpha', 'SKILL.md'))
    assert.deepStrictEqual(actual, expected)
    assert.strictEqual(existsSync(join(root, 'packages', 'claude-plugin', 'skills')), false)
    assert.strictEqual(existsSync(join(root, 'packages', 'codex-plugin', 'skills')), false)
    assert.strictEqual(existsSync(join(root, 'packages', 'antigravity-plugin', 'skills')), false)

    const checkWithMaterializedPi = runSync(root, ['--check'])
    assert.notStrictEqual(checkWithMaterializedPi.status, 0)
    assert.match(outputText(checkWithMaterializedPi.stderr), /Materialized skill dir present/)

    const clean = runSync(root)
    assert.strictEqual(clean.status, 0, outputText(clean.stderr))
    assert.strictEqual(existsSync(join(root, 'packages', 'pi-plugin', 'skills')), false)

    const check = runSync(root, ['--check'])
    assert.strictEqual(check.status, 0, outputText(check.stderr))
  })

  it('fails check when a bundle skill is missing from core skills', () => {
    writeBundle(root, ['ns-missing'], ['ns-one'])

    const check = runSync(root, ['--check'])
    assert.notStrictEqual(check.status, 0, 'check should fail when core skill is missing')
    assert.match(outputText(check.stderr), /Missing core skill directory/)
  })

  it('builds self-contained Claude, Codex, and Antigravity artifacts', () => {
    writeSkill(root, 'ns-alpha', '# alpha')
    writeSkill(root, 'ns-beta', '# beta')
    writeBundle(root, ['ns-alpha', 'ns-beta'], ['ns-one', 'ns-two'])
    copyTemplates(root)

    const result = runArtifacts(root)
    assert.strictEqual(result.status, 0, outputText(result.stderr))

    for (const harness of ['claude', 'codex', 'antigravity']) {
      const artifactRoot = join(root, 'dist', 'plugins', harness, 'nsolid-plugin')
      assert.ok(existsSync(artifactRoot), `${harness} artifact root exists`)
      assert.ok(existsSync(join(artifactRoot, 'skills', 'ns-alpha', 'SKILL.md')), `${harness} skill alpha exists`)
      assert.ok(existsSync(join(artifactRoot, 'skills', 'ns-beta', 'SKILL.md')), `${harness} skill beta exists`)
    }

    const claudeManifest = readJson(join(root, 'dist', 'plugins', 'claude', 'nsolid-plugin', '.claude-plugin', 'plugin.json'))
    assert.deepStrictEqual(claudeManifest.skills, ['./skills/ns-alpha', './skills/ns-beta'])
    assert.strictEqual(claudeManifest.hooks, undefined)
    assert.strictEqual(existsSync(join(root, 'dist', 'plugins', 'claude', 'nsolid-plugin', 'hooks')), false)
    const claudeMarketplace = readJson(join(root, 'dist', 'plugins', 'claude', 'nsolid-plugin', '.claude-plugin', 'marketplace.json'))
    assert.strictEqual(claudeMarketplace.name, 'nodesource-local')
    assert.deepStrictEqual(claudeMarketplace.plugins, [{
      name: 'nsolid-plugin',
      source: './',
      description: 'N|Solid performance & security skills + MCP servers',
    }])

    const codexManifest = readJson(join(root, 'dist', 'plugins', 'codex', 'nsolid-plugin', '.codex-plugin', 'plugin.json'))
    assert.strictEqual(codexManifest.skills, './skills/')
    assert.strictEqual(codexManifest.mcpServers, './.mcp.json')
    const codexMcp = readJson(join(root, 'dist', 'plugins', 'codex', 'nsolid-plugin', '.mcp.json'))
    assert.match(JSON.stringify(codexMcp), /\.codex.*plugins.*cache/)
    assert.doesNotMatch(JSON.stringify(codexMcp), /PLUGIN_ROOT/)
    assert.ok(existsSync(join(root, 'dist', 'plugins', 'codex', 'nsolid-plugin', 'plugins', 'nsolid-plugin', 'skills', 'ns-alpha', 'SKILL.md')))

    assert.strictEqual(codexManifest.hooks, undefined)
    assert.strictEqual(existsSync(join(root, 'dist', 'plugins', 'codex', 'nsolid-plugin', 'hooks')), false)

    const antigravityInstall = readFileSync(join(root, 'dist', 'plugins', 'antigravity', 'nsolid-plugin', 'scripts', 'install.js'), 'utf8')
    assert.doesNotMatch(antigravityInstall, /login|openBrowser|ensureAuthenticated|open\(/i)
    assert.match(antigravityInstall, /nsolid-plugin setup/)
    assert.doesNotMatch(antigravityInstall, /'hooks\.json'/)
    assert.match(antigravityInstall, /'skills'/)
    assert.strictEqual(existsSync(join(root, 'dist', 'plugins', 'antigravity', 'nsolid-plugin', 'hooks.json')), false)
    assert.strictEqual(existsSync(join(root, 'dist', 'plugins', 'antigravity', 'nsolid-plugin', 'scripts', 'setup.js')), false)

    assert.ok(existsSync(join(root, 'dist', 'artifacts', 'nsolid-claude-plugin.tgz')))
    assert.ok(existsSync(join(root, 'dist', 'artifacts', 'nsolid-codex-plugin.tgz')))
    assert.ok(existsSync(join(root, 'dist', 'artifacts', 'nsolid-antigravity-plugin.tgz')))

    const check = runArtifacts(root, ['--check'])
    assert.strictEqual(check.status, 0, outputText(check.stderr))
  })
})
