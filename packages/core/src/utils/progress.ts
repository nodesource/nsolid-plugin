import { C, supportsColor as detectColor } from './format.js'

export interface ProgressReporter {
  header (title: string): void
  step (label: string, detail?: string): void
  done (label: string): void
  warn (label: string, detail?: string): void
}

export function createConsoleProgress (opts?: { color?: boolean }): ProgressReporter {
  const color = opts?.color ?? detectColor(process.stderr)

  const out = (s: string): void => {
    process.stderr.write(s + '\n')
  }

  const dim = (s: string): string => color ? C.dim(s) : s
  const green = (s: string): string => color ? C.green(s) : s
  const yellow = (s: string): string => color ? C.yellow(s) : s

  return {
    header (title: string): void {
      out(title)
    },
    step (label: string, detail?: string): void {
      let line = `${dim(' →')} ${label}`
      if (detail !== undefined) {
        const lines = detail.split('\n')
        if (lines.length > 0) {
          line += ` …  ${dim(lines[0])}`
          for (const extra of lines.slice(1)) {
            line += `\n    ${dim(extra)}`
          }
        }
      }
      out(line)
    },
    done (label: string): void {
      out(`${green(' ✓')} ${label}`)
    },
    warn (label: string, detail?: string): void {
      let line = `${yellow(' ⚠')} ${label}`
      if (detail !== undefined) {
        line += `  ${dim(detail)}`
      }
      out(line)
    },
  }
}

export const silentProgress: ProgressReporter = {
  header (): void {},
  step (): void {},
  done (): void {},
  warn (): void {},
}
