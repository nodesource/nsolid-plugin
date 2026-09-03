import { tmpdir } from 'node:os'
import path from 'node:path'
import type { PublicPlanStep, UpdatePlanStep } from './types.js'

const REDACTED_TEMP = '<temp>'

function osTempDirectory (): string {
  return path.resolve(tmpdir())
}

/**
 * Replace any OS-temporary-rooted path inside a value with '<temp>/<basename>'.
 * Planning embeds per-run staging paths (transaction manifests, downloaded
 * tarballs, fresh result locations) that are transient internal state, with
 * mkdtemp-random directory names: only the file name survives redaction.
 * Handles both standalone paths and arguments embedding one (--package=<path>).
 */
function redactTempPath (value: string): string {
  const temp = osTempDirectory()
  const index = value.indexOf(temp)
  if (index < 0) return value
  const remainder = value.slice(index + temp.length)
  const segments = remainder.replace(/\\/g, '/').split('/')
  const basename = segments[segments.length - 1]
  return `${value.slice(0, index)}${REDACTED_TEMP}/${basename}`
}

/**
 * Project plan steps into their public, structured-output shape. Everything
 * execution-internal is intentionally dropped: the command environment (may
 * carry credential-bearing variables), the working directory and spawn
 * identity (provenance evidence, not user-facing state), and the timeout.
 * A secret such as the fallback transaction nonce never appears in step
 * data, and tarball identities are not part of step output.
 */
export function publicPlanSteps (steps: readonly UpdatePlanStep[]): PublicPlanStep[] {
  return steps.map((step) => {
    if (step.kind === 'command') {
      return {
        kind: 'command' as const,
        description: step.description,
        executable: step.command.executable,
        args: step.command.args.map(redactTempPath),
      }
    }
    if (step.kind === 'filesystem') {
      return {
        kind: 'filesystem' as const,
        description: step.description,
        operation: step.operation,
        paths: step.paths.map(redactTempPath),
      }
    }
    return { kind: 'validation' as const, description: step.description, checks: [...step.checks] }
  })
}
