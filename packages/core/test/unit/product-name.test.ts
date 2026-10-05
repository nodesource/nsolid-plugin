import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// The new N|Solid backend is built under an internal codename, which stays in
// its own repository. Everything this plugin ships names the product: the MCP
// server is `nsolid`, its settings are NSOLID_*, its scripts nsolid-*.cjs, and
// its prose says N|Solid. This test keeps the codename from creeping back in.
const CODENAME = /skunk/i

function repoRoot (): string {
  let dir = dirname(fileURLToPath(import.meta.url))
  while (!(existsSync(join(dir, 'bundle.json')) && existsSync(join(dir, 'skills')))) {
    const parent = dirname(dir)
    if (parent === dir) throw new Error('repository root not found')
    dir = parent
  }
  return dir
}

// What reaches users: the skills and their scripts, the plugin manifests and MCP
// configs, the wrapper, the installer's own source, and the README.
const SHIPPED = [
  'skills',
  'skill-assets',
  'scripts',
  'packages/core/src',
  'packages/core/scripts',
  'packages/core/bundle.json',
  'packages/pi-plugin/index.js',
  'packages/pi-plugin/package.json',
  '.claude-plugin',
  '.codex-plugin',
  '.agents',
  '.opencode',
  'bundle.json',
  'plugin.json',
  '.mcp.json',
  '.claude-mcp.json',
  'mcp_config.json',
  'opencode.jsonc',
  'README.md',
]

function files (path: string): string[] {
  if (!existsSync(path)) return []
  if (!statSync(path).isDirectory()) return [path]
  return readdirSync(path)
    .filter((name) => name !== 'node_modules' && name !== 'dist')
    .flatMap((name) => files(join(path, name)))
}

describe('product name', () => {
  it('ships no internal codename, in file names or contents', () => {
    const root = repoRoot()
    const found: string[] = []
    for (const entry of SHIPPED) {
      for (const file of files(resolve(root, entry))) {
        const rel = relative(root, file).replace(/\\/g, '/')
        if (CODENAME.test(rel)) found.push(`${rel} (name)`)
        const lines = readFileSync(file, 'utf8').split('\n')
        lines.forEach((line, i) => {
          if (CODENAME.test(line)) found.push(`${rel}:${i + 1}`)
        })
      }
    }
    assert.deepEqual(found, [], `name the product, N|Solid (or nsolid), instead:\n${found.join('\n')}`)
  })
})
