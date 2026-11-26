import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// bundle.json is the canonical descriptor of every skill. Its `requiresMcp`
// must name the MCP servers a skill's workflow calls, and the README must
// count the skills it ships. Nothing reads `requiresMcp` at runtime, so only
// this test notices when a skill changes and the metadata does not.

const repoRoot = join(import.meta.dirname, '..', '..', '..', '..')

interface Bundle {
  skills: Array<{ name: string, path: string, requiresMcp?: string[] }>
  mcpServers: Array<{ name: string }>
}

const bundle = JSON.parse(readFileSync(join(repoRoot, 'bundle.json'), 'utf8')) as Bundle

// The tools each MCP server exposes. Skills name a tool in backticks when they
// tell the agent to call it.
const toolsByServer: Record<string, string[]> = {
  'nsolid-console': [
    'application-packages', 'asset-summary', 'assets', 'assets-in-progress',
    'events-historic', 'global-filter', 'health', 'heap-sampling', 'host-uptime',
    'information-dashboard', 'metrics-dashboard', 'metrics-historic', 'packages',
    'profile', 'runtime-code', 'sbom', 'server-info', 'serverless-functions',
    'snapshot', 'tracing', 'tracing-detail', 'track-heap-objects', 'vulnerabilities'
  ],
  ncm: ['getPackageQuality', 'getPackageVersions'],
  'ns-benchmark': ['compare_benchmarks', 'get_benchmark_result', 'run_benchmark']
}

const serverByTool = new Map<string, string>()
for (const [server, tools] of Object.entries(toolsByServer)) {
  for (const tool of tools) serverByTool.set(tool, server)
}

const requiresBySkill = new Map(bundle.skills.map((skill) => [skill.name, skill.requiresMcp ?? []]))

// The servers whose tools a skill names, and the other skills it names.
function scanSkill (skillPath: string): { servers: Set<string>, skills: Set<string> } {
  const servers = new Set<string>()
  const skills = new Set<string>()
  for (const entry of readdirSync(join(repoRoot, skillPath), { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue
    const text = readFileSync(join(entry.parentPath, entry.name), 'utf8')
    for (const match of text.matchAll(/`([\w-]+)`/g)) {
      const server = serverByTool.get(match[1])
      if (server) servers.add(server)
      if (requiresBySkill.has(match[1])) skills.add(match[1])
    }
  }
  return { servers, skills }
}

describe('skill metadata', () => {
  it('knows the tools of every MCP server in the bundle', () => {
    assert.deepEqual(
      bundle.mcpServers.map((server) => server.name).sort(),
      Object.keys(toolsByServer).sort()
    )
  })

  it('requires only MCP servers the bundle declares', () => {
    const declared = new Set(bundle.mcpServers.map((server) => server.name))
    const unknown: string[] = []
    for (const skill of bundle.skills) {
      for (const server of skill.requiresMcp ?? []) {
        if (!declared.has(server)) unknown.push(`${skill.name}: ${server}`)
      }
    }
    assert.deepEqual(unknown, [])
  })

  it('requires every MCP server whose tools a skill calls', () => {
    const missing: string[] = []
    for (const skill of bundle.skills) {
      const required = new Set(skill.requiresMcp ?? [])
      for (const server of scanSkill(skill.path).servers) {
        if (!required.has(server)) missing.push(`${skill.name}: ${server}`)
      }
    }
    assert.deepEqual(missing, [])
  })

  it('requires no MCP server that a skill neither calls nor gets through a skill it delegates to', () => {
    const extra: string[] = []
    for (const skill of bundle.skills) {
      const { servers, skills } = scanSkill(skill.path)
      const reachable = new Set(servers)
      for (const other of skills) {
        for (const server of requiresBySkill.get(other) ?? []) reachable.add(server)
      }
      for (const server of skill.requiresMcp ?? []) {
        if (!reachable.has(server)) extra.push(`${skill.name}: ${server}`)
      }
    }
    assert.deepEqual(extra, [])
  })

  it('is counted correctly in the README', () => {
    const readme = readFileSync(join(repoRoot, 'README.md'), 'utf8')
    const count = readme.match(/^- (\d+) Node\.js operations skills/m)
    assert.ok(count, 'README.md should say how many skills the plugin ships')
    assert.equal(Number(count[1]), bundle.skills.length)
  })
})
