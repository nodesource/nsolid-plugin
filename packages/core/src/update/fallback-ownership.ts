import path from 'node:path'
import { getAdapter } from '../harnesses/index.js'
import { readMcpFieldDigests, type PreferredMcpKey } from './mcp-lookup.js'
import { getHarnessSkillsPath } from '../skills/skill-linker.js'
import type { TrackingData } from '../skills/skill-tracker.js'
import type { FallbackTransactionIdentity } from './types.js'
import { assertSafeSkillName } from '../utils/skill-name.js'

export function matchesTrackedOwnership (tracking: TrackingData, identity: FallbackTransactionIdentity): boolean {
  const linkRoot = path.resolve(getHarnessSkillsPath(identity.harness))
  if (identity.ownedLinks.some((entry) => !isSafeDirectChild(entry.path, [linkRoot]))) return false
  if (identity.ownedSkills.some((entry) => !isSafeDirectChild(entry.path, identity.approvedDestinationRoots))) return false
  const scopedSkills = tracking.skills.filter((entry) => entry.harnesses.includes(identity.harness))
  const trackedPaths = new Set(scopedSkills
    .map((entry) => entry.paths?.[identity.harness] ?? entry.path)
    .filter((value): value is string => typeof value === 'string')
    .map((value) => path.resolve(value)))
  const ownedSkillPaths = new Set(identity.ownedSkills.map((entry) => path.resolve(entry.path)))
  if (ownedSkillPaths.size !== trackedPaths.size || ![...ownedSkillPaths].every((value) => trackedPaths.has(value))) return false
  const expectedLinkPaths = new Set(identity.harness === 'opencode' ? [] : scopedSkills.map((entry) => path.resolve(linkRoot, entry.name)))
  const ownedLinkPaths = new Set(identity.ownedLinks.map((entry) => path.resolve(entry.path)))
  if (ownedLinkPaths.size !== expectedLinkPaths.size || ![...ownedLinkPaths].every((value) => expectedLinkPaths.has(value))) return false
  const expectedMcpFields = tracking.mcpServers
    .filter((entry) => entry.harness === identity.harness && entry.fields)
    .flatMap((entry) => Object.entries(entry.fields ?? {}).map(([field, expectedDigest]) => `${path.resolve(entry.configPath)}\0${entry.name}\0${field}\0${expectedDigest}`))
  const ownedMcpFields = new Set(identity.ownedMcpFields.map((field) => `${path.resolve(field.configPath)}\0${field.server}\0${field.field}\0${field.expectedDigest}`))
  if (expectedMcpFields.length > 0 && (ownedMcpFields.size !== expectedMcpFields.length || !expectedMcpFields.every((value) => ownedMcpFields.has(value)))) return false
  // The MCP config-path set is the union of tracked paths and the adapter's
  // canonical path for this harness, recomputed from the same environment the
  // transaction will run in.
  const canonical = getAdapter(identity.harness).getMcpConfigPath()
  const expectedConfigPaths = new Set<string>([
    ...tracking.mcpServers.filter((entry) => entry.harness === identity.harness).map((entry) => path.resolve(entry.configPath)),
    ...(canonical ? [path.resolve(canonical)] : []),
  ])
  const ownedConfigPaths = new Set(identity.ownedMcpConfigPaths.map((value) => path.resolve(value)))
  if (ownedConfigPaths.size !== expectedConfigPaths.size || ![...expectedConfigPaths].every((value) => ownedConfigPaths.has(value))) return false
  return identity.ownedMcpFields.every((field) => tracking.mcpServers.some((entry) => {
    if (entry.harness !== identity.harness || entry.name !== field.server || path.resolve(entry.configPath) !== path.resolve(field.configPath)) return false
    return entry.fields?.[field.field] === field.expectedDigest
  }))
}

export function isSafeDirectChild (candidate: string, roots: readonly string[]): boolean {
  const resolved = path.resolve(candidate)
  if (!isCanonicalPath(resolved) || !roots.some((root) => path.dirname(resolved) === path.resolve(root))) return false
  try {
    assertSafeSkillName(path.basename(resolved))
    return true
  } catch {
    return false
  }
}

export function isCanonicalPath (value: string): boolean {
  return !isRemotePath(value) && path.isAbsolute(value) && !value.split(path.sep).includes('..') && path.resolve(value) === value
}

export function isRemotePath (value: string): boolean {
  const normalized = value.replace(/\\/g, '/')
  return normalized.startsWith('//') || path.win32.parse(value).root.startsWith('\\\\')
}

export function isSameOrContained (candidate: string, parent: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate))
  // A leading '..' segment means traversal; a filename that merely starts
  // with dots (for example '..claude.json.nsolid-stage-x') does not.
  if (relative === '') return true
  if (path.isAbsolute(relative)) return false
  return relative !== '..' && !relative.startsWith(`..${path.sep}`)
}

/**
 * Exclusive-ownership gate for MCP server records (one of two MCP ownership
 * invariants; the postcondition check in strategies/fallback.ts is the other,
 * and is a subset match by design). A record may be REMOVED only when the
 * live per-field digests match the owned evidence exactly — same field set,
 * same digests — because a foreign field inside the record means the user
 * co-owns it. Routes through the field-digests module so the ownership rule
 * and the tracking evidence can never drift apart.
 */
export function mcpRecordIsExclusivelyOwned (configPath: string, name: string, ownedFields: Record<string, string> | undefined, preferredKey: PreferredMcpKey): boolean {
  if (!ownedFields || Object.keys(ownedFields).length === 0) return false
  const current = readMcpFieldDigests(configPath, name, { preferredKey })
  if (!current) return false
  const ownedNames = Object.keys(ownedFields).sort()
  const currentNames = Object.keys(current).sort()
  return ownedNames.length === currentNames.length && ownedNames.every((field, index) =>
    field === currentNames[index] && ownedFields[field] === current[field])
}
