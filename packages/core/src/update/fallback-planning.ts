import path from 'node:path'
import type { HarnessType } from '../types.js'
import { getSkillsDir, resolveHome } from '../utils/path.js'
import { getHarnessSkillsPath } from '../skills/skill-linker.js'
import { pathDigest, pathKind } from './fallback-journal.js'
import type { FallbackPathEvidence } from './types.js'

/** Shared read-only planning inputs; callers retain their ownership checks. */
export function resolveFallbackDestinations (harness: HarnessType): { destination: string; linkDir?: string } {
  const destination = harness === 'opencode'
    ? path.resolve(process.env.NSOLID_OPENCODE_SKILLS_DIR ?? resolveHome('~/.config/opencode/skills'))
    : getSkillsDir()
  const linkDir = harness !== 'opencode' ? path.resolve(getHarnessSkillsPath(harness)) : undefined
  return { destination, linkDir }
}

export function fallbackBundlePaths (destination: string, linkDir: string | undefined, names: readonly string[]): string[] {
  return [...new Set([destination, ...(linkDir === undefined ? [] : [linkDir])].flatMap((root) => names.map((name) => path.resolve(path.join(root, name)))))]
}

export async function captureFallbackPathEvidence (paths: readonly string[]): Promise<FallbackPathEvidence[]> {
  return await Promise.all(paths.map(async (value) => {
    const resolved = path.resolve(value)
    const kind = await pathKind(resolved)
    const digest = kind === 'missing' ? undefined : await pathDigest(resolved)
    if (kind !== 'missing' && digest === undefined) throw new Error(`Cannot capture fallback path evidence for ${resolved}`)
    return { path: resolved, kind, digest }
  }))
}
