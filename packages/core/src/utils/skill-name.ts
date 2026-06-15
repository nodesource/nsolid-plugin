import path from 'node:path'

export function assertSafeSkillName (name: string): string {
  if (name.length === 0 || name === '.' || name !== path.basename(name) || name.includes('..') || name.includes(path.sep)) {
    throw new Error(`Invalid skill name: ${name}`)
  }
  return name
}
