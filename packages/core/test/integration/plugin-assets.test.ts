import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
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
  const skillDir = join(root, 'skills', name)
  mkdirSync(skillDir, { recursive: true })
  writeFileSync(join(skillDir, 'SKILL.md'), content)
}

function runSync (root: string, args: string[] = []): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [SYNC_SCRIPT, ...args], {
    cwd: root,
    env: { ...process.env, NSOLID_PLUGIN_SYNC_ROOT: root },
    encoding: 'utf-8',
  })
}

function outputText (output: string | Buffer | null | undefined): string {
  return typeof output === 'string' ? output : output?.toString('utf8') ?? ''
}

describe('plugin source hygiene', () => {
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

    const expected = readFileSync(join(root, 'skills', 'ns-alpha', 'SKILL.md'))
    const actual = readFileSync(join(root, 'packages', 'pi-plugin', 'skills', 'ns-alpha', 'SKILL.md'))
    assert.deepStrictEqual(actual, expected)
    assert.strictEqual(existsSync(join(root, 'packages', 'core', 'skills')), false)
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

  it('fails check when a bundle skill is missing from root skills', () => {
    writeBundle(root, ['ns-missing'], ['ns-one'])

    const check = runSync(root, ['--check'])
    assert.notStrictEqual(check.status, 0, 'check should fail when root skill is missing')
    assert.match(outputText(check.stderr), /Missing core skill directory/)
  })
})
