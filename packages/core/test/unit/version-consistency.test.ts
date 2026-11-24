import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

// Every place that names the plugin's version must name the same one. The MCP
// wrapper prints `npx -y nsolid-plugin@<version> setup` as its repair command,
// so a version that drifts from the published CLI sends users to a release
// that can't repair it.

const repoRoot = join(import.meta.dirname, '..', '..', '..', '..')

function readJson (path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(repoRoot, path), 'utf8')) as Record<string, unknown>
}

function filesUnder (dir: string, name: RegExp): string[] {
  const out: string[] = []
  for (const entry of readdirSync(join(repoRoot, dir), { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && name.test(entry.name)) out.push(relative(repoRoot, join(entry.parentPath, entry.name)))
  }
  return out
}

const version = readJson('bundle.json').version as string

describe('plugin version', () => {
  it('is a plain release version', () => {
    assert.match(version, /^\d+\.\d+\.\d+$/)
  })

  it('is the same in every manifest and package', () => {
    const marketplace = readJson('.claude-plugin/marketplace.json') as { plugins: Array<{ version?: string }> }
    const found: Record<string, unknown> = {
      'packages/core/bundle.json': readJson('packages/core/bundle.json').version,
      'packages/core/package.json': readJson('packages/core/package.json').version,
      'packages/pi-plugin/package.json': readJson('packages/pi-plugin/package.json').version,
      '.claude-plugin/plugin.json': readJson('.claude-plugin/plugin.json').version,
      '.codex-plugin/plugin.json': readJson('.codex-plugin/plugin.json').version,
      '.claude-plugin/marketplace.json': marketplace.plugins.map((plugin) => plugin.version)
    }
    assert.deepEqual(found, {
      'packages/core/bundle.json': version,
      'packages/core/package.json': version,
      'packages/pi-plugin/package.json': version,
      '.claude-plugin/plugin.json': version,
      '.codex-plugin/plugin.json': version,
      '.claude-plugin/marketplace.json': marketplace.plugins.map(() => version)
    })
  })

  it('is the one the MCP wrapper pins for its repair command', () => {
    const wrapper = readFileSync(join(repoRoot, 'scripts', 'mcp-wrapper.js'), 'utf8')
    assert.match(wrapper, new RegExp(`^const PLUGIN_VERSION = "${version.replace(/\./g, '\\.')}"$`, 'm'))
  })

  it('is the one every skill pins when it runs the CLI', () => {
    const pinned: string[] = []
    for (const file of filesUnder('skills', /\.md$/)) {
      for (const match of readFileSync(join(repoRoot, file), 'utf8').matchAll(/nsolid-plugin@(\d+\.\d+\.\d+)/g)) {
        if (match[1] !== version) pinned.push(`${file}: nsolid-plugin@${match[1]}`)
      }
    }
    assert.deepEqual(pinned, [])
  })
})
