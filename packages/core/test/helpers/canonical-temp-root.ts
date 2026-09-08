import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

/**
 * Create a fixture temp root through its canonical (realpath-resolved) path.
 *
 * `mkdtempSync` seeds the directory under `os.tmpdir()`, which is a
 * non-canonical alias on some CI platforms (macOS exposes `/var/...` where
 * `/var` is a symlink to `/private/var`; Windows runner homes expand
 * `RUNNER~1` short names). The fallback planner intentionally rejects
 * non-canonical path components, so suites that derive HOME and ordinary
 * destination paths from a temp root must create that root canonically.
 * Hostile-path tests that build their own aliases or symlinks are unaffected.
 *
 * `realpathSync.native` is required: the JavaScript implementation resolves
 * symlinks but leaves Windows 8.3 short-name components (`RUNNER~1`) intact,
 * while the native call expands them to the final filesystem path.
 */
export function createCanonicalTempRoot (prefix: string): string {
  return realpathSync.native(mkdtempSync(path.join(tmpdir(), prefix)))
}
