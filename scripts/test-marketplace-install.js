#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const SETUP_TIMEOUT_MS = 120000

// fileURLToPath correctly handles the platform-specific file:// URL, including
// Windows drive letters (new URL(...).pathname yields an invalid "/D:/..." path
// on Windows, which would make every existsSync check fail).
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const HARNESS_LIST = [
  { name: 'claude', configRel: '.claude.json', urlKey: 'url' },
  { name: 'codex', configRel: '.codex/config.toml', urlKey: 'url' },
  { name: 'opencode', configRel: '.config/opencode/opencode.jsonc', urlKey: 'url' },
  { name: 'antigravity', configRel: '.gemini/config/mcp_config.json', urlKey: 'serverUrl' },
  { name: 'pi', configRel: '.pi/agent/mcp.json', urlKey: 'url' },
]

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

let failed = 0

for (const h of HARNESS_LIST) {
  const home = mkdtempSync(join(tmpdir(), `nsolid-manual-${h.name}-`))
  const env = { ...process.env, HOME: home, USERPROFILE: home, NSOLID_HARNESS: h.name }

  mkdirSync(join(home, '.agents'), { recursive: true })
  writeFileSync(join(home, '.agents', '.nodesource-auth.json'), JSON.stringify(FAKE_CREDS))

  const tag = `[${h.name}]`
  try {
    const install = run(REPO_ROOT, env, ['packages/core/scripts/setup.mjs'])
    assertOk(install, `${tag} install exit code`)

    assert(existsSync(join(home, '.agents', 'skills')), `${tag} shared skills dir`)
    assert(harnessHasServers(home, h), `${tag} harness MCP config has nsolid-console/ns-benchmark/ncm`)

    const harnessSkillsPath = getHarnessSkillsPath(home, h.name)
    // Use a real skill name from bundle.json. `ns-benchmark` is an MCP server,
    // not a skill — asserting on it never proved anything.
    const probeSkill = 'ns-advanced-memory-leak-hunter'
    assert(existsSync(join(harnessSkillsPath, probeSkill)), `${tag} skill linked to harness`)

    const uninstall = run(REPO_ROOT, env, ['packages/core/scripts/setup.mjs', 'uninstall'])
    assertOk(uninstall, `${tag} uninstall exit code`)

    assert(existsSync(join(home, '.agents', '.nodesource-auth.json')), `${tag} credentials preserved`)

    assert(!existsSync(join(harnessSkillsPath, probeSkill)), `${tag} harness skill link removed`)

    console.log(`\x1b[32m✓ ${h.name} install→verify→uninstall OK\x1b[0m`)
  } catch (err) {
    failed++
    console.error(`\x1b[31m✗ ${h.name} FAILED: ${err.message}\x1b[0m`)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

process.exit(failed ? 1 : 0)

function run (cwd, env, args) {
  const r = spawnSync(process.execPath, args, {
    cwd,
    env,
    encoding: 'utf8',
    timeout: SETUP_TIMEOUT_MS
  })
  return r
}

function assertOk (r, label) {
  if (r.error) throw new Error(`${label} (${r.error.message})`)
  if (r.status !== 0) throw new Error(`${label} (exit ${r.status}, stderr: ${(r.stderr || '').trim()})`)
}

function assert (cond, msg) {
  if (!cond) throw new Error(msg)
}

function getHarnessSkillsPath (home, harness) {
  const paths = {
    claude: join(home, '.claude', 'skills'),
    codex: join(home, '.codex', 'skills'),
    opencode: join(home, '.config', 'opencode', 'skills'),
    antigravity: join(home, '.gemini', 'config', 'skills'),
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
