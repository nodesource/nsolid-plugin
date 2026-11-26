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

// A pin's version is the whole semver token, pre-release and build metadata
// included. Stopping at `x.y.z` would read `nsolid-plugin@1.2.0-rc.1` as
// `1.2.0`, so a pin naming a different build would pass as the release.
const PIN = /nsolid-plugin@(\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)/g

function pinsOtherThan (text: string, expected: string): string[] {
  return [...text.matchAll(PIN)].map((match) => match[1]).filter((pinned) => pinned !== expected)
}

const version = readJson('bundle.json').version as string

describe('plugin version', () => {
  // This branch builds the plugin for N|Solid Console 7. Its versions carry a
  // `-console7.N` suffix, so they never collide with a release from `main`.
  it('is a Console 7 version', () => {
    assert.match(version, /^\d+\.\d+\.\d+-console7\.\d+$/)
  })

  // Console 7 builds publish under the `console7` dist-tag only, and the release
  // steps always pass `--tag console7`. The field is a second guard for npm and
  // pnpm 10 and older; pnpm 11 and later ignore it.
  it('publishes every package under the console7 dist-tag', () => {
    const tags = Object.fromEntries(['packages/core/package.json', 'packages/pi-plugin/package.json']
      .map((path) => [path, (readJson(path).publishConfig as { tag?: string } | undefined)?.tag]))
    assert.deepEqual(tags, {
      'packages/core/package.json': 'console7',
      'packages/pi-plugin/package.json': 'console7'
    })
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
      for (const other of pinsOtherThan(readFileSync(join(repoRoot, file), 'utf8'), version)) {
        pinned.push(`${file}: nsolid-plugin@${other}`)
      }
    }
    assert.deepEqual(pinned, [])
  })
})

describe('skill pin scan', () => {
  it('reports a pin that names another release', () => {
    assert.deepEqual(pinsOtherThan('npx -y nsolid-plugin@1.0.3 setup', '1.2.0'), ['1.0.3'])
  })

  it('reports a pin that adds a pre-release or build suffix to the release', () => {
    const text = [
      'npx -y nsolid-plugin@1.2.0-rc.1 setup',
      'npx -y nsolid-plugin@1.2.0+build.5 setup',
      'npx -y nsolid-plugin@1.2.0-rc.1+build.5 setup'
    ].join('\n')
    assert.deepEqual(pinsOtherThan(text, '1.2.0'), ['1.2.0-rc.1', '1.2.0+build.5', '1.2.0-rc.1+build.5'])
  })

  it('reports a plain pin when the release has a pre-release suffix', () => {
    assert.deepEqual(pinsOtherThan('npx -y nsolid-plugin@2.0.0 setup', '2.0.0-beta.0'), ['2.0.0'])
  })

  it('accepts a pin that matches the release exactly, suffix included', () => {
    assert.deepEqual(pinsOtherThan('Run: npx -y nsolid-plugin@1.2.0 setup', '1.2.0'), [])
    assert.deepEqual(pinsOtherThan('Run `npx -y nsolid-plugin@2.0.0-beta.0 setup`.', '2.0.0-beta.0'), [])
  })

  it('does not read trailing sentence punctuation as part of the version', () => {
    assert.deepEqual(pinsOtherThan('Pin it to nsolid-plugin@2.0.0-beta.0.', '2.0.0-beta.0'), [])
  })
})
