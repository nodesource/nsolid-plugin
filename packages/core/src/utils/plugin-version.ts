import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readJsonFile } from './config.js'

let cached: string | undefined

/**
 * This package's own version, from its package.json.
 *
 * Install commands the CLI prints name this exact version. Without one, npm
 * resolves the `latest` dist-tag, and a build published under another tag
 * (such as `console7`) is not `latest`: the user would get a different release.
 *
 * This file runs from `src/utils/` in development and from `dist/src/utils/`
 * once installed, so it takes the nearest package.json above it rather than a
 * fixed number of levels up.
 */
export function pluginVersion (): string {
  if (cached !== undefined) return cached
  let dir = path.dirname(fileURLToPath(import.meta.url))
  for (;;) {
    const file = path.join(dir, 'package.json')
    const pkg = readJsonFile<{ name?: unknown; version?: unknown }>(file)
    if (pkg) {
      if (pkg.name !== 'nsolid-plugin' || typeof pkg.version !== 'string') {
        throw new Error(`Expected the nsolid-plugin package manifest with a version at ${file}`)
      }
      cached = pkg.version
      return cached
    }
    const parent = path.dirname(dir)
    if (parent === dir) throw new Error('Could not find the nsolid-plugin package manifest')
    dir = parent
  }
}
