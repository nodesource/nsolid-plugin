#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const SETUP_TIMEOUT_MS = 120000

// fileURLToPath correctly handles the platform-specific file:// URL, including
// Windows drive letters (new URL(...).pathname yields an invalid "/D:/..." path
// on Windows, which would make every existsSync check fail).
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CLI_PATH = join(REPO_ROOT, 'packages/core/dist/src/cli.js')
const HARNESS_LIST = [
  { name: 'claude', configRel: '.claude.json', urlKey: 'url' },
  { name: 'codex', configRel: '.codex/config.toml', urlKey: 'url' },
  { name: 'opencode', configRel: '.config/opencode/opencode.jsonc', urlKey: 'url' },
  { name: 'antigravity', configRel: '.gemini/antigravity-cli/mcp_config.json', urlKey: 'serverUrl' },
  { name: 'pi', configRel: '.pi/agent/mcp.json', urlKey: 'url' },
]
const PLUGIN_OWNED_HARNESSES = new Set(['claude', 'codex', 'antigravity'])
const PACKAGE_OWNED_SKILL_HARNESSES = new Set(['pi'])
const HARNESS_SPECIFIC_SKILL_HARNESSES = new Set(['opencode'])
const LEGACY_HARNESSES = HARNESS_LIST.filter((h) => !PLUGIN_OWNED_HARNESSES.has(h.name))

if (!existsSync(join(REPO_ROOT, 'packages/core/dist/src/index.js'))) {
  console.error('Core is not built. Run: pnpm build')
  process.exit(1)
}

const FAKE_CREDS = {
  serviceToken: 'fake-token',
  organizationId: 'fake-org',
  saasToken: 'fake-saas',
  consoleUrl: 'https://console.nodesource.com',
  mcpUrl: 'https://mcp.nodesource.com',
  expiresAt: '2099-01-01T00:00:00.000Z',
  permissions: [],
}

const authStub = await startAuthStub()
let failed = 0

try {
  verifyPluginOwnedPackages()

  for (const h of LEGACY_HARNESSES) {
    const home = mkdtempSync(join(tmpdir(), `nsolid-manual-${h.name}-`))
    const env = testEnv(home, h.name)

    mkdirSync(join(home, '.agents'), { recursive: true })
    writeFileSync(join(home, '.agents', '.nodesource-auth.json'), JSON.stringify(FAKE_CREDS))

    const tag = `[${h.name}]`
    try {
      const install = run(REPO_ROOT, env, ['packages/core/scripts/setup.mjs'])
      assertOk(install, `${tag} install exit code`)

      assert(harnessHasServers(home, h), `${tag} harness MCP config has nsolid-console/ns-benchmark/ncm`)

      const harnessSkillsPath = getHarnessSkillsPath(home, h.name)
      // Use a real skill name from bundle.json. `ns-benchmark` is an MCP server,
      // not a skill — asserting on it never proved anything.
      const probeSkill = 'ns-advanced-memory-leak-hunter'
      if (PACKAGE_OWNED_SKILL_HARNESSES.has(h.name)) {
        assert(!existsSync(join(home, '.agents', 'skills', probeSkill)), `${tag} shared skill not copied for package-owned harness`)
        assert(!existsSync(join(harnessSkillsPath, probeSkill)), `${tag} skill not linked for package-owned harness`)
      } else if (HARNESS_SPECIFIC_SKILL_HARNESSES.has(h.name)) {
        assert(!existsSync(join(home, '.agents', 'skills', probeSkill)), `${tag} shared skill not copied for harness-specific install`)
        assert(existsSync(join(harnessSkillsPath, probeSkill)), `${tag} skill copied to harness`)
      } else {
        assert(existsSync(join(home, '.agents', 'skills')), `${tag} shared skills dir`)
        assert(existsSync(join(harnessSkillsPath, probeSkill)), `${tag} skill linked to harness`)
      }

      const uninstall = run(REPO_ROOT, env, ['packages/core/scripts/setup.mjs', 'uninstall'])
      assertOk(uninstall, `${tag} uninstall exit code`)

      assert(!existsSync(join(home, '.agents', '.nodesource-auth.json')), `${tag} credentials purged on last-harness uninstall`)
      assert(!existsSync(join(harnessSkillsPath, probeSkill)), `${tag} harness skill link removed`)

      console.log(`\x1b[32m✓ ${h.name} install→verify→uninstall OK\x1b[0m`)
    } catch (err) {
      failed++
      console.error(`\x1b[31m✗ ${h.name} FAILED: ${err.message}\x1b[0m`)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }

  // Second pass: --keep-credentials must preserve the auth file on the last legacy harness.
  for (const h of LEGACY_HARNESSES) {
    const home = mkdtempSync(join(tmpdir(), `nsolid-keep-${h.name}-`))
    const env = testEnv(home, h.name)

    mkdirSync(join(home, '.agents'), { recursive: true })
    writeFileSync(join(home, '.agents', '.nodesource-auth.json'), JSON.stringify(FAKE_CREDS))

    const tag = `[${h.name} --keep-credentials]`
    try {
      const install = run(REPO_ROOT, env, ['packages/core/scripts/setup.mjs'])
      assertOk(install, `${tag} install exit code`)

      const uninstall = run(REPO_ROOT, env, [CLI_PATH, 'uninstall', '--harness', h.name, '--keep-credentials'])
      assertOk(uninstall, `${tag} uninstall exit code`)

      assert(existsSync(join(home, '.agents', '.nodesource-auth.json')), `${tag} credentials preserved with --keep-credentials`)

      console.log(`\x1b[32m✓ ${h.name} --keep-credentials preserves credentials\x1b[0m`)
    } catch (err) {
      failed++
      console.error(`\x1b[31m✗ ${h.name} --keep-credentials FAILED: ${err.message}\x1b[0m`)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }
} finally {
  await closeServer(authStub.server)
}

process.exit(failed ? 1 : 0)

function testEnv (home, harness) {
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    NSOLID_HARNESS: harness,
    NSOLID_ACCOUNTS_URL: authStub.url,
  }
}

function verifyPluginOwnedPackages () {
  const artifacts = spawnSync(process.execPath, ['scripts/build-plugin-artifacts.mjs'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: SETUP_TIMEOUT_MS,
  })
  if (artifacts.status !== 0) {
    failed++
    console.error(`\x1b[31m✗ generated plugin artifacts FAILED: ${(artifacts.stderr || artifacts.stdout || '').trim()}\x1b[0m`)
    return
  }

  try {
    const claudeRoot = join(REPO_ROOT, 'dist/plugins/claude/nsolid-plugin')
    const claudeManifest = readJson(join(claudeRoot, '.claude-plugin/plugin.json'))
    assert(claudeManifest.name === 'nsolid-plugin', '[claude artifact] manifest name')
    const claudeMarketplace = readJson(join(claudeRoot, '.claude-plugin/marketplace.json'))
    assert(claudeMarketplace.name === 'nodesource-local', '[claude artifact] local marketplace name')
    assert(claudeMarketplace.plugins?.[0]?.source === './', '[claude artifact] local marketplace source')
    assert(existsSync(join(claudeRoot, '.mcp.json')), '[claude artifact] plugin-owned MCP config')
    assert(claudeManifest.hooks === undefined, '[claude artifact] no startup hooks')
    assert(!existsSync(join(claudeRoot, 'hooks/hooks.json')), '[claude artifact] no setup hook config')
    assert(!existsSync(join(claudeRoot, 'scripts/setup.js')), '[claude artifact] no setup hook script')
    assert(existsSync(join(claudeRoot, 'skills/ns-advanced-memory-leak-hunter/SKILL.md')), '[claude artifact] materialized skill')
    console.log('\x1b[32m✓ claude generated artifact assets OK\x1b[0m')
  } catch (err) {
    failed++
    console.error(`\x1b[31m✗ claude generated artifact FAILED: ${err.message}\x1b[0m`)
  }

  try {
    const codexRoot = join(REPO_ROOT, 'dist/plugins/codex/nsolid-plugin')
    const codexManifest = readJson(join(codexRoot, '.codex-plugin/plugin.json'))
    assert(codexManifest.name === 'nsolid-plugin', '[codex artifact] manifest name')
    assert(existsSync(join(codexRoot, '.mcp.json')), '[codex artifact] plugin-owned MCP config')
    assert(existsSync(join(codexRoot, '.agents/plugins/marketplace.json')), '[codex artifact] local marketplace manifest')
    assert(codexManifest.skills === './skills/', '[codex artifact] manifest declares skills')
    assert(codexManifest.mcpServers === './.mcp.json', '[codex artifact] manifest declares MCP config')
    assert(codexManifest.hooks === undefined, '[codex artifact] no startup hooks')
    assert(!existsSync(join(codexRoot, 'hooks/hooks.json')), '[codex artifact] no setup hook config')
    assert(!existsSync(join(codexRoot, 'scripts/setup.js')), '[codex artifact] no setup hook script')
    const codexMcp = readJson(join(codexRoot, '.mcp.json'))
    assert(JSON.stringify(codexMcp).includes('.codex'), '[codex artifact] MCP wrapper resolves via Codex cache')
    assert(!JSON.stringify(codexMcp).includes('PLUGIN_ROOT'), '[codex artifact] MCP wrapper avoids unsupported PLUGIN_ROOT interpolation')
    assert(existsSync(join(codexRoot, 'skills/ns-advanced-memory-leak-hunter/SKILL.md')), '[codex artifact] materialized root skill')
    assert(existsSync(join(codexRoot, 'plugins/nsolid-plugin/skills/ns-advanced-memory-leak-hunter/SKILL.md')), '[codex artifact] materialized nested skill')
    console.log('\x1b[32m✓ codex generated artifact assets OK\x1b[0m')
  } catch (err) {
    failed++
    console.error(`\x1b[31m✗ codex generated artifact FAILED: ${err.message}\x1b[0m`)
  }

  try {
    const piManifest = readJson(join(REPO_ROOT, 'packages/pi-plugin/package.json'))
    assert(piManifest.name === '@nodesource/pi-plugin', '[pi-plugin] package name')
    assert(piManifest.pi?.skills?.includes('./skills'), '[pi-plugin] package-owned skills manifest')
    assert(!existsSync(join(REPO_ROOT, 'packages/pi-plugin/skills')), '[pi-plugin] generated skills should not be committed')
    assert(existsSync(join(REPO_ROOT, 'packages/core/skills/ns-advanced-memory-leak-hunter/SKILL.md')), '[pi-plugin] canonical skill source')
    console.log('\x1b[32m✓ pi package-owned skill assets OK\x1b[0m')
  } catch (err) {
    failed++
    console.error(`\x1b[31m✗ pi package-owned skill package FAILED: ${err.message}\x1b[0m`)
  }

  try {
    const antigravityRoot = join(REPO_ROOT, 'dist/plugins/antigravity/nsolid-plugin')
    const antigravityManifest = readJson(join(antigravityRoot, 'plugin.json'))
    assert(antigravityManifest.name === 'nsolid-plugin', '[antigravity artifact] manifest name')
    assert(existsSync(join(antigravityRoot, 'mcp_config.json')), '[antigravity artifact] plugin-owned MCP config')
    assert(!existsSync(join(antigravityRoot, 'hooks.json')), '[antigravity artifact] no setup hook config')
    assert(!existsSync(join(antigravityRoot, 'scripts/setup.js')), '[antigravity artifact] no setup hook script')
    assert(existsSync(join(antigravityRoot, 'skills/ns-advanced-memory-leak-hunter/SKILL.md')), '[antigravity artifact] materialized skill')
    console.log('\x1b[32m✓ antigravity generated artifact assets OK\x1b[0m')
  } catch (err) {
    failed++
    console.error(`\x1b[31m✗ antigravity generated artifact FAILED: ${err.message}\x1b[0m`)
  }
}

function run (cwd, env, args) {
  return spawnSync(process.execPath, args, {
    cwd,
    env,
    encoding: 'utf8',
    timeout: SETUP_TIMEOUT_MS,
  })
}

function assertOk (r, label) {
  if (r.error) throw new Error(`${label} (${r.error.message})`)
  if (r.status !== 0) throw new Error(`${label} (exit ${r.status}, stderr: ${(r.stderr || '').trim()})`)
}

function assert (cond, msg) {
  if (!cond) throw new Error(msg)
}

function readJson (path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function getHarnessSkillsPath (home, harness) {
  const paths = {
    codex: join(home, '.codex', 'skills'),
    opencode: join(home, '.config', 'opencode', 'skills'),
    pi: join(home, '.pi', 'agent', 'skills'),
  }
  return paths[harness]
}

function harnessHasServers (home, h) {
  const configPath = join(home, h.configRel)
  if (!existsSync(configPath)) return false
  const raw = readFileSync(configPath, 'utf8')
  return ['nsolid-console', 'ns-benchmark', 'ncm'].every((n) => raw.includes(n))
}

async function startAuthStub () {
  const server = createServer((req, res) => {
    if (req.url?.startsWith('/accounts/org/access-token')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ permissions: [] }))
      return
    }

    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'not found' }))
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })

  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Auth stub failed to bind to a TCP port')
  }

  return { server, url: `http://127.0.0.1:${address.port}` }
}

async function closeServer (server) {
  await new Promise((resolve, reject) => {
    server.close((err) => err ? reject(err) : resolve())
  })
}
