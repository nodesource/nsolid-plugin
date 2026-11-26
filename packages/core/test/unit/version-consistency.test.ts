import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

// Every place that names the plugin's version must name the same one. The MCP
// wrapper prints `npx -y nsolid-plugin@<version> setup` as its repair command,
// so a version that drifts from the published CLI sends users to a release
// that can't repair it.

const repoRoot = join(import.meta.dirname, '..', '..', '..', '..')

function readJson (path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(repoRoot, path), 'utf8')) as Record<string, unknown>
}

// Vendored copies come from other packages, so they are not ours to pin.
function filesUnder (dir: string, name: RegExp): string[] {
  const out: string[] = []
  for (const entry of readdirSync(join(repoRoot, dir), { withFileTypes: true, recursive: true })) {
    const path = relative(repoRoot, join(entry.parentPath, entry.name))
    if (entry.isFile() && name.test(entry.name) && !path.split(sep).includes('vendor')) out.push(path)
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

// A command that fetches one of the plugin's packages from npm: npx, bunx,
// `pnpm dlx`, `npm`/`pnpm`/`yarn` install, add or exec, and `pi install npm:`.
// Group 1 is the package, group 2 what follows its `@`, if anything.
// `nsolid-plugin setup` alone runs a CLI already installed, and
// `claude plugin install nsolid-plugin@nodesource` names a marketplace, so
// neither is a fetch.
const FETCH = /(?:\b(?:npx|bunx|pnpm\s+dlx|(?:npm|pnpm|yarn)\s+(?:i|install|add|exec|x))(?:\s+-\S+)*\s+|\bpi\s+install(?:\s+-\S+)*\s+npm:)(nsolid-(?:pi-)?plugin)(?![\w-])(?:@([^\s`'"()[\]]+))?/g
// Prose like `nsolid-plugin@console7.` ends a sentence; the period isn't part of the spec.
const TRAILING_PUNCTUATION = /[.,;:!?]+$/

// Fetches whose spec `accepts` refuses, as `<package>@<spec>`, or the bare
// package name when the command names no version or tag. Without one, npm
// resolves `latest`, which is not this build when it publishes under another tag.
function fetchesRefused (text: string, accepts: (spec: string) => boolean): string[] {
  const refused: string[] = []
  for (const match of text.matchAll(FETCH)) {
    const spec = match[2]?.replace(TRAILING_PUNCTUATION, '')
    if (!spec) refused.push(match[1])
    else if (!accepts(spec)) refused.push(`${match[1]}@${spec}`)
  }
  return refused
}

const version = readJson('bundle.json').version as string

// Skills run the CLI pinned to this exact build.
const exactVersion = (spec: string) => spec === version

// The README may also name the `console7` tag, or a placeholder such as
// `<version>`; source code may also build the version into a template
// (`@${version}`), as the Pi hint does.
const versionOrTag = (spec: string) =>
  spec === version || spec === 'console7' || /^<[\w-]+>$/.test(spec) || /^\$\{[^}]+\}$/.test(spec)

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
    for (const file of filesUnder('skills', /\.(md|cjs|mjs|js)$/)) {
      const text = readFileSync(join(repoRoot, file), 'utf8')
      for (const other of pinsOtherThan(text, version)) pinned.push(`${file}: nsolid-plugin@${other}`)
      for (const fetch of fetchesRefused(text, exactVersion)) pinned.push(`${file}: ${fetch}`)
    }
    assert.deepEqual(pinned, [])
  })

  // An install command with no version or tag resolves `latest`, which is the
  // release from `main`, not this build.
  it('is named, or the console7 tag is, by every install command in the READMEs and the CLI source', () => {
    const files = [
      ...['README.md', 'packages/core/README.md', 'packages/pi-plugin/README.md'].filter((file) => existsSync(join(repoRoot, file))),
      ...filesUnder(join('packages', 'core', 'src'), /\.[cm]?[jt]s$/)
    ]
    const unversioned: string[] = []
    for (const file of files) {
      for (const fetch of fetchesRefused(readFileSync(join(repoRoot, file), 'utf8'), versionOrTag)) {
        unversioned.push(`${file}: ${fetch}`)
      }
    }
    assert.deepEqual(unversioned, [])
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

describe('install command scan', () => {
  it('reports npx, npm, pnpm and pi commands that name no version', () => {
    const text = [
      'npx -y nsolid-plugin setup --harness <harness>',
      "throw new Error('Run: npx nsolid-plugin install')",
      'npm i -g nsolid-plugin',
      'npm install --global nsolid-pi-plugin',
      'pnpm dlx nsolid-plugin doctor',
      'pi install npm:nsolid-pi-plugin',
      'Run `pi install npm:nsolid-pi-plugin`.'
    ].join('\n')
    assert.deepEqual(fetchesRefused(text, versionOrTag), [
      'nsolid-plugin', 'nsolid-plugin', 'nsolid-plugin', 'nsolid-pi-plugin', 'nsolid-plugin', 'nsolid-pi-plugin', 'nsolid-pi-plugin'
    ])
  })

  it('reports a tag other than console7, and another version', () => {
    const text = 'npx -y nsolid-plugin@latest setup\npi install npm:nsolid-pi-plugin@1.2.0'
    assert.deepEqual(fetchesRefused(text, versionOrTag), ['nsolid-plugin@latest', 'nsolid-pi-plugin@1.2.0'])
  })

  it('accepts the exact version, the console7 tag, a placeholder and a template', () => {
    const text = [
      `npx -y nsolid-plugin@${version} setup`,
      'npm i -g nsolid-plugin@console7',
      'pi install npm:nsolid-pi-plugin@console7.',
      'npx -y nsolid-plugin@<plugin-version> setup',
      'return `pi install npm:nsolid-pi-plugin@${version}`' // eslint-disable-line no-template-curly-in-string
    ].join('\n')
    assert.deepEqual(fetchesRefused(text, versionOrTag), [])
  })

  it('accepts only the exact version in skills', () => {
    const text = `npx -y nsolid-plugin@${version} setup\nnpx -y nsolid-plugin@console7 setup`
    assert.deepEqual(fetchesRefused(text, exactVersion), ['nsolid-plugin@console7'])
  })

  it('ignores a CLI already installed, a marketplace plugin and other packages', () => {
    const text = [
      'nsolid-plugin setup --harness pi',
      'claude plugin install nsolid-plugin@nodesource',
      'claude plugin marketplace add NodeSource/nsolid-plugin',
      'pi install npm:pi-mcp-adapter',
      'npx -y nsolid-plugin-extras setup'
    ].join('\n')
    assert.deepEqual(fetchesRefused(text, versionOrTag), [])
  })
})
