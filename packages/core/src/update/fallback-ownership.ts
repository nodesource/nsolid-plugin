import path from 'node:path'
import { getHarnessSkillsPath } from '../skills/skill-linker.js'
import type { TrackingData } from '../skills/skill-tracker.js'
import type { FallbackTransactionIdentity } from './types.js'

export function matchesTrackedOwnership (tracking: TrackingData, identity: FallbackTransactionIdentity): boolean {
  const linkRoot = path.resolve(getHarnessSkillsPath(identity.harness))
  if (identity.ownedLinkPaths.some((value) => !isSameOrContained(path.resolve(value), linkRoot))) return false
  const scopedSkills = tracking.skills.filter((entry) => entry.harnesses.includes(identity.harness))
  const trackedPaths = new Set(scopedSkills
    .map((entry) => entry.paths?.[identity.harness] ?? entry.path)
    .filter((value): value is string => typeof value === 'string')
    .map((value) => path.resolve(value)))
  const ownedSkillPaths = new Set(identity.ownedSkillPaths.map((value) => path.resolve(value)))
  if (ownedSkillPaths.size !== trackedPaths.size || ![...ownedSkillPaths].every((value) => trackedPaths.has(value))) return false
  const expectedLinkPaths = new Set(scopedSkills.map((entry) => path.resolve(linkRoot, entry.name)))
  const ownedLinkPaths = new Set(identity.ownedLinkPaths.map((value) => path.resolve(value)))
  if (ownedLinkPaths.size !== expectedLinkPaths.size || ![...ownedLinkPaths].every((value) => expectedLinkPaths.has(value))) return false
  const expectedMcpFields = tracking.mcpServers
    .filter((entry) => entry.harness === identity.harness && entry.fields)
    .flatMap((entry) => Object.entries(entry.fields ?? {}).map(([field, expectedDigest]) => `${path.resolve(entry.configPath)}\0${entry.name}\0${field}\0${expectedDigest}`))
  const ownedMcpFields = new Set(identity.ownedMcpFields.map((field) => `${path.resolve(field.configPath)}\0${field.server}\0${field.field}\0${field.expectedDigest}`))
  if (expectedMcpFields.length > 0 && (ownedMcpFields.size !== expectedMcpFields.length || !expectedMcpFields.every((value) => ownedMcpFields.has(value)))) return false
  return identity.ownedMcpFields.every((field) => tracking.mcpServers.some((entry) => {
    if (entry.harness !== identity.harness || entry.name !== field.server || path.resolve(entry.configPath) !== path.resolve(field.configPath)) return false
    return entry.fields?.[field.field] === field.expectedDigest
  }))
}

export function isCanonicalPath (value: string): boolean {
  return path.isAbsolute(value) && !value.split(path.sep).includes('..') && path.resolve(value) === value
}

export function isSameOrContained (candidate: string, parent: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate))
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}
