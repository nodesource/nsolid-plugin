import { lstat, realpath } from 'node:fs/promises'
import type { BigIntStats, Stats } from 'node:fs'
import path from 'node:path'
import { isCanonicalPath, isSameOrContained } from './fallback-ownership.js'
import { assertSafeSkillName } from '../utils/skill-name.js'
import type { FallbackAnchorIdentity, FallbackFrontierEvidence, FallbackLeafActivation, FallbackLeafRole, FallbackLeafTarget, FallbackPathEvidence, FallbackTransactionIdentity } from './types.js'
import type { HarnessType } from '../types.js'

/**
 * Shared read-only evidence model for planned missing parent directories
 * (frontiers). Derivation inspects the live filesystem with `lstat` only —
 * it never follows links and never mutates anything. Publication, rollback,
 * and recovery consume this evidence but live in later stages; this module
 * defines the exact contract both planners share.
 *
 * Every authorized leaf is classified exactly once: an existing leaf (whose
 * live kind must match its role), a missing file/link leaf under an existing
 * parent (an independent leaf destination — never a directory frontier), or a
 * leaf created by publishing a topmost missing directory frontier.
 *
 * Binding decision (Step 3, option A): conservative Pure Node. No HMAC, no
 * native dependencies, no atomic-replace promises. A frontier is published
 * by exclusive `mkdir` plus exclusive population, so partial visibility is
 * explicitly accepted; authority over a planned-missing frontier stays with
 * the process that reserved it and the parent never destroys frontiers.
 */

/** Stable rejection codes for frontier derivation, parsing, and revalidation. */
export const FALLBACK_FRONTIER_ERROR_CODES = {
  INVALID_INPUT: 'FALLBACK_FRONTIER_INVALID_INPUT',
  COLLISION: 'FALLBACK_FRONTIER_COLLISION',
  COMPONENT_NOT_DIRECTORY: 'FALLBACK_FRONTIER_COMPONENT_NOT_DIRECTORY',
  ANCHOR_IDENTITY_MISMATCH: 'FALLBACK_FRONTIER_ANCHOR_IDENTITY_MISMATCH',
  DRIFT: 'FALLBACK_FRONTIER_DRIFT',
  /** An existing destination's live kind contradicts the kind its role requires. */
  LEAF_KIND_MISMATCH: 'FALLBACK_FRONTIER_LEAF_KIND_MISMATCH',
} as const

export class FallbackFrontierError extends Error {
  public readonly code: string

  constructor (code: string, message: string) {
    super(message)
    this.name = 'FallbackFrontierError'
    this.code = code
  }
}

/** Hard bounds keeping frontier evidence small, deterministic, and reviewable. */
export const FALLBACK_FRONTIER_BOUNDS = {
  maxLeaves: 64,
  maxFrontiers: 16,
  maxPathBytes: 512,
  maxLeafIdBytes: 128,
  maxMissingSegmentsPerLeaf: 16,
} as const

const LEAF_ROLES: readonly FallbackLeafRole[] = ['skill', 'link', 'mcp-config', 'tracking']
const LEAF_ACTIVATIONS: readonly FallbackLeafActivation[] = ['required', 'conditional']

/**
 * Expected live terminal kind per leaf role. Links are legitimate only for
 * `link` leaves (managed harness links); skill destinations must be real
 * directories and config/tracking destinations regular files. `lstat` never
 * follows links, so a managed link never traverses to its target.
 */
const LEAF_EXPECTED_KINDS: Record<FallbackLeafRole, FallbackLeafKind> = {
  skill: 'directory',
  link: 'symlink',
  'mcp-config': 'file',
  tracking: 'file',
}

/** Concrete live terminal kind of one leaf or staged/live tree entry. */
export type FallbackLeafKind = 'file' | 'directory' | 'symlink'

/** Kinds a harness may legitimately materialize a managed `link` leaf as. */
export type FallbackLinkKind = 'symlink' | 'directory'

export interface FallbackLinkMaterializationPolicy {
  readonly allowedKinds: readonly FallbackLinkKind[]
}

/** Strictest policy: only real symlinks count as managed links. Safe default for every non-harness-aware consumer. */
const STRICT_SYMLINK_POLICY: FallbackLinkMaterializationPolicy = Object.freeze({ allowedKinds: Object.freeze<FallbackLinkKind[]>(['symlink']) })

/**
 * Trusted internal policy for how a harness materializes managed skill links,
 * derived ONLY from the trusted harness identity plus the runtime platform:
 * Pi always copies skill directories (any platform); every other harness uses
 * real symlinks on POSIX and may fall back to copied directories on Windows.
 * Unknown harnesses fail closed. The policy is NEVER serialized: protocol v3
 * evidence stays kind-agnostic, and every consumer derives the identical
 * policy from the trusted manifest harness instead of accepting caller-provided
 * kinds.
 */
export function fallbackLinkMaterialization (harness: HarnessType): FallbackLinkMaterializationPolicy {
  switch (harness) {
    case 'pi':
      return Object.freeze({ allowedKinds: Object.freeze<FallbackLinkKind[]>(['directory']) })
    case 'claude':
    case 'codex':
    case 'antigravity':
    case 'opencode':
      return process.platform === 'win32'
        ? Object.freeze({ allowedKinds: Object.freeze<FallbackLinkKind[]>(['symlink', 'directory']) })
        : STRICT_SYMLINK_POLICY
    default:
      throw invalid(`unknown harness ${String(harness)} has no trusted link materialization policy`)
  }
}

/** Live kinds a leaf's role accepts under the trusted policy (singletons except `link`). */
function permittedLeafKinds (role: FallbackLeafRole, policy: FallbackLinkMaterializationPolicy): readonly FallbackLeafKind[] {
  if (role !== 'link') return Object.freeze([LEAF_EXPECTED_KINDS[role]])
  return policy.allowedKinds
}

/** Compare two strings by their UTF-8 byte sequences (canonical evidence order). */
export function compareUtf8 (a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))
}

/**
 * Normalized trusted inputs for the parent's leaf derivation. The child
 * consumes the resulting graph and can never widen its approved destinations.
 */
export interface FallbackFrontierLeafInputs {
  /** Tracked owned-skill evidence. A path already covered by the bundle is deduplicated (bundle wins). */
  ownedSkills: readonly FallbackPathEvidence[]
  /** Tracked owned-link evidence. A path already covered by the bundle is deduplicated (bundle wins). */
  ownedLinks: readonly FallbackPathEvidence[]
  /** Whole-file MCP config evidence; paths are deduplicated and UTF-8-sorted into stable `mcp-config:<index>` ids. */
  ownedMcpConfigPaths: readonly FallbackPathEvidence[]
  /** Absolute tracking-file path; always yields the required `tracking` leaf. */
  trackingPath: string
  /** Resolved absolute skills destination root for the harness. */
  destination: string
  /** Resolved absolute harness link root; omit for harnesses without managed links (opencode). */
  linkDir?: string
  /** Skill names from the verified bundle; each contributes a required skill leaf (plus a required link leaf when a link root exists). */
  bundleSkillNames: readonly string[]
}

/**
 * Derive the complete authorized leaf set from trusted normalized planner
 * inputs: every skill and link destination the verified bundle will create
 * (new or replaced), every tracked destination the bundle no longer contains
 * (planned removals), the union of canonical and tracked MCP config files,
 * and the tracking file. Ids use disjoint `skill:`/`owned-`/`mcp-` prefixes
 * and depend only on the inputs, so the same planned state always yields the
 * same leaf graph. Pure and deterministic: no filesystem access, no clock,
 * no randomness. Distinct destinations must never collapse into one derived
 * id: basename collisions among tracked evidence and duplicate bundle names
 * are rejected instead of being silently merged.
 */
export function deriveFallbackFrontierLeafTargets (inputs: FallbackFrontierLeafInputs): FallbackLeafTarget[] {
  if (typeof inputs !== 'object' || inputs === null) throw invalid('leaf inputs must be an object')
  const requiredKeys = ['ownedSkills', 'ownedLinks', 'ownedMcpConfigPaths', 'trackingPath', 'destination', 'bundleSkillNames']
  for (const key of Object.keys(inputs)) {
    if (key !== 'linkDir' && !requiredKeys.includes(key)) throw invalid(`leaf inputs have an unknown field ${key}`)
  }
  for (const key of requiredKeys) {
    if (!(key in inputs)) throw invalid(`leaf inputs are missing the field ${key}`)
  }
  if (typeof inputs.destination !== 'string' || !path.isAbsolute(inputs.destination)) throw invalid('leaf inputs destination must be an absolute path')
  if (inputs.linkDir !== undefined && (typeof inputs.linkDir !== 'string' || !path.isAbsolute(inputs.linkDir))) throw invalid('leaf inputs linkDir must be an absolute path')
  if (typeof inputs.trackingPath !== 'string' || !path.isAbsolute(inputs.trackingPath)) throw invalid('leaf inputs trackingPath must be an absolute path')
  if (!Array.isArray(inputs.ownedSkills) || !Array.isArray(inputs.ownedLinks) || !Array.isArray(inputs.ownedMcpConfigPaths)) {
    throw invalid('leaf inputs owned evidence must be arrays')
  }
  if (!Array.isArray(inputs.bundleSkillNames)) throw invalid('leaf inputs bundleSkillNames must be an array of strings')
  if (inputs.bundleSkillNames.some((name) => typeof name !== 'string')) throw invalid('leaf inputs bundleSkillNames must be an array of strings')
  if (new Set(inputs.bundleSkillNames).size !== inputs.bundleSkillNames.length) throw invalid('leaf inputs bundleSkillNames contain duplicate names')
  if (inputs.bundleSkillNames.length > FALLBACK_FRONTIER_BOUNDS.maxLeaves) {
    throw invalid(`leaf inputs bundleSkillNames exceed the ${FALLBACK_FRONTIER_BOUNDS.maxLeaves}-leaf bound`)
  }
  for (const name of inputs.bundleSkillNames) {
    try {
      assertSafeSkillName(name)
    } catch {
      throw invalid(`bundle skill name ${name} is not a safe single path segment`)
    }
  }
  for (const evidenceList of [inputs.ownedSkills, inputs.ownedLinks, inputs.ownedMcpConfigPaths]) {
    if (evidenceList.length > FALLBACK_FRONTIER_BOUNDS.maxLeaves) {
      throw invalid(`leaf inputs owned evidence exceeds the ${FALLBACK_FRONTIER_BOUNDS.maxLeaves}-leaf bound`)
    }
    for (const entry of evidenceList) {
      if (typeof entry !== 'object' || entry === null || typeof entry.path !== 'string') {
        throw invalid('leaf inputs owned evidence entries must carry string paths')
      }
    }
  }

  const leaves = new Map<string, FallbackLeafTarget>()
  // Same-destination claims must be resolved explicitly: silent drops would
  // erase semantic postconditions from the leaf graph.
  const add = (leaf: FallbackLeafTarget): void => {
    const previous = leaves.get(leaf.path)
    if (previous === undefined) {
      leaves.set(leaf.path, leaf)
      return
    }
    if (previous.role !== leaf.role) {
      throw new FallbackFrontierError(
        FALLBACK_FRONTIER_ERROR_CODES.COLLISION,
        `Leaves ${previous.id} (${previous.role}) and ${leaf.id} (${leaf.role}) claim the same destination ${leaf.path} with incompatible roles`
      )
    }
    // Same role: identical duplicates collapse, and the verified bundle wins
    // over tracked evidence (required supersedes conditional). Any other
    // same-role disagreement has no precedence rule and is a collision.
    if (previous.id === leaf.id && previous.activation === leaf.activation) return
    if (previous.activation === 'required' && leaf.activation === 'conditional') return
    if (previous.activation === 'conditional' && leaf.activation === 'required') {
      leaves.set(leaf.path, leaf)
      return
    }
    throw new FallbackFrontierError(
      FALLBACK_FRONTIER_ERROR_CODES.COLLISION,
      `Leaves ${previous.id} and ${leaf.id} claim the same destination ${leaf.path} without a precedence rule`
    )
  }
  for (const name of inputs.bundleSkillNames) {
    add({ id: `skill:${name}`, role: 'skill', activation: 'required', path: path.resolve(inputs.destination, name) })
    if (inputs.linkDir !== undefined) add({ id: `link:${name}`, role: 'link', activation: 'required', path: path.resolve(inputs.linkDir, name) })
  }
  for (const entry of inputs.ownedSkills) {
    const ownedPath = path.resolve(entry.path)
    add({ id: `owned-skill:${path.basename(ownedPath)}`, role: 'skill', activation: 'conditional', path: ownedPath })
  }
  for (const entry of inputs.ownedLinks) {
    const ownedPath = path.resolve(entry.path)
    add({ id: `owned-link:${path.basename(ownedPath)}`, role: 'link', activation: 'conditional', path: ownedPath })
  }
  const mcpPaths = [...new Set(inputs.ownedMcpConfigPaths.map((entry) => path.resolve(entry.path)))].sort(compareUtf8)
  mcpPaths.forEach((configPath, index) => {
    // Conditional: the render plan may skip a no-op config, and the parent
    // cannot prove frontier inactivity from mutable state — the platform
    // preflight therefore treats every derived frontier as active.
    add({ id: `mcp-config:${index}`, role: 'mcp-config', activation: 'conditional', path: configPath })
  })
  add({ id: 'tracking', role: 'tracking', activation: 'required', path: path.resolve(inputs.trackingPath) })
  // Distinct destinations must never share a derived id: a collision here
  // would silently collapse semantic postconditions in later stages.
  const idOwners = new Map<string, string>()
  for (const leaf of leaves.values()) {
    const previousPath = idOwners.get(leaf.id)
    if (previousPath !== undefined) {
      throw new FallbackFrontierError(FALLBACK_FRONTIER_ERROR_CODES.COLLISION, `Leaves ${previousPath} and ${leaf.path} share the derived id ${leaf.id}; refusing to collapse distinct destinations`)
    }
    idOwners.set(leaf.id, leaf.path)
  }
  return [...leaves.values()]
}

/** The deterministic frontier plan: frontiers and existing leaves in UTF-8 byte order. */
export interface FallbackFrontierPlan {
  frontiers: readonly FallbackFrontierEvidence[]
  /** Authorized leaves that already exist on disk; no parent creation is needed for them. */
  existingLeaves: readonly FallbackLeafTarget[]
  /**
   * Missing file/link leaves whose parent already exists. They are independent
   * leaf destinations (exclusive leaf writes in later stages) and are never
   * directory frontiers, so they never trigger the platform preflight.
   */
  missingLeaves: readonly FallbackLeafTarget[]
}

export type FallbackFrontierPlatformSupport =
  | { supported: true }
  | { supported: false; code: 'FALLBACK_PARENT_CREATION_UNSUPPORTED'; frontierPaths: readonly string[] }

function invalid (message: string): FallbackFrontierError {
  return new FallbackFrontierError(FALLBACK_FRONTIER_ERROR_CODES.INVALID_INPUT, message)
}

function isProperSegmentAncestor (ancestor: string, candidate: string): boolean {
  const relative = path.relative(ancestor, candidate)
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function assertValidLeafInput (leaf: unknown, index: number): asserts leaf is FallbackLeafTarget {
  if (typeof leaf !== 'object' || leaf === null) throw invalid(`leaf ${index} must be an object`)
  const record = leaf as Record<string, unknown>
  assertExactKeys(record, ['id', 'role', 'activation', 'path'], `leaf ${index}`)
  const candidate = leaf as Partial<FallbackLeafTarget>
  if (typeof candidate.id !== 'string' || candidate.id.length === 0 || Buffer.byteLength(candidate.id, 'utf8') > FALLBACK_FRONTIER_BOUNDS.maxLeafIdBytes) {
    throw invalid(`leaf ${index} id must be a non-empty string of at most ${FALLBACK_FRONTIER_BOUNDS.maxLeafIdBytes} bytes`)
  }
  if (!LEAF_ROLES.includes(candidate.role as FallbackLeafRole)) throw invalid(`leaf ${candidate.id} has unknown role`)
  if (!LEAF_ACTIVATIONS.includes(candidate.activation as FallbackLeafActivation)) throw invalid(`leaf ${candidate.id} has unknown activation`)
  if (typeof candidate.path !== 'string' || !isCanonicalPath(candidate.path)) {
    throw invalid(`leaf ${candidate.id} path must be an absolute canonical path without traversal or remote spelling`)
  }
  if (Buffer.byteLength(candidate.path, 'utf8') > FALLBACK_FRONTIER_BOUNDS.maxPathBytes) {
    throw invalid(`leaf ${candidate.id} path exceeds ${FALLBACK_FRONTIER_BOUNDS.maxPathBytes} bytes`)
  }
}

function segmentComponentsOf (resolved: string): { root: string; segments: readonly string[] } {
  const root = path.parse(resolved).root
  const segments = resolved.slice(root.length).split(path.sep).filter((segment) => segment.length > 0)
  return { root, segments }
}

interface LeafInspection {
  leaf: FallbackLeafTarget
  existing: boolean
  /** Missing non-directory leaf whose parent exists; an independent destination, never a frontier. */
  missingUnderExistingParent?: boolean
  anchorPath?: string
  frontierPath?: string
  missingComponentCount?: number
}

function leafKindMatches (stats: Stats, expected: FallbackLeafKind): boolean {
  if (expected === 'symlink') return stats.isSymbolicLink()
  if (stats.isSymbolicLink()) return false
  return expected === 'directory' ? stats.isDirectory() : stats.isFile()
}

/**
 * Walk every path component from the filesystem root down to the leaf with
 * `lstat` (never following links). Intermediate components must be existing
 * real directories. The first missing intermediate directory is the frontier;
 * its parent — verified as a real directory — is the anchor. A missing
 * terminal file/link leaf under an existing parent is an independent leaf
 * destination; only a missing terminal directory leaf is itself a frontier.
 */
async function inspectLeaf (leaf: FallbackLeafTarget, policy: FallbackLinkMaterializationPolicy): Promise<LeafInspection> {
  const resolved = path.resolve(leaf.path)
  const { root, segments } = segmentComponentsOf(resolved)
  if (segments.length === 0) throw invalid(`leaf ${leaf.id} path must name a destination below its filesystem root`)
  const permittedKinds = permittedLeafKinds(leaf.role, policy)
  let current = root
  let depth = 0
  for (const segment of segments) {
    const candidate = path.join(current, segment)
    const isTerminal = depth === segments.length - 1
    let stats
    try {
      stats = await lstat(candidate)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOTDIR') {
        // A live ancestor stopped being a directory between syscalls; fail
        // closed instead of planning through a file or link.
        throw new FallbackFrontierError(
          FALLBACK_FRONTIER_ERROR_CODES.COMPONENT_NOT_DIRECTORY,
          `An ancestor of ${candidate} of leaf ${leaf.id} is not a directory; refusing to plan through it`
        )
      }
      if (code === 'ENOENT') {
        const missingComponentCount = segments.length - depth
        if (missingComponentCount > FALLBACK_FRONTIER_BOUNDS.maxMissingSegmentsPerLeaf) {
          throw invalid(`leaf ${leaf.id} is ${missingComponentCount} missing components below its anchor; the bound is ${FALLBACK_FRONTIER_BOUNDS.maxMissingSegmentsPerLeaf}`)
        }
        // A missing non-skill leaf whose parent exists is an independent leaf
        // destination (exclusive leaf write later), never a directory frontier
        // — including a missing Pi copied-directory link, which must never be
        // reclassified as a directory-skill frontier. Only missing parent
        // directories create frontiers.
        if (isTerminal && leaf.role !== 'skill') {
          return { leaf, existing: false, missingUnderExistingParent: true }
        }
        return { leaf, existing: false, anchorPath: current, frontierPath: candidate, missingComponentCount }
      }
      throw error
    }
    if (isTerminal) {
      // The terminal leaf exists: its live kind must be policy-permitted for
      // the role without following links — skill directories, managed links in
      // a trusted materialization kind (symlink, or a real copied directory
      // where the harness/platform policy allows it), and config/tracking
      // regular files.
      const kindPermitted = permittedKinds.some((permitted) => leafKindMatches(stats, permitted))
      if (!kindPermitted) {
        throw new FallbackFrontierError(
          FALLBACK_FRONTIER_ERROR_CODES.LEAF_KIND_MISMATCH,
          `The existing destination ${candidate} of leaf ${leaf.id} is not a permitted kind (${permittedKinds.join(' or ')}) for its role ${leaf.role}; refusing to plan over a kind-conflicting destination`
        )
      }
      return { leaf, existing: true }
    }
    if (!stats.isDirectory()) {
      throw new FallbackFrontierError(
        FALLBACK_FRONTIER_ERROR_CODES.COMPONENT_NOT_DIRECTORY,
        `The path component ${candidate} of leaf ${leaf.id} exists but is not a real directory; refusing to plan through links or files`
      )
    }
    current = candidate
    depth += 1
  }
  throw invalid(`leaf ${leaf.id} path must name a destination below its filesystem root`)
}

async function anchorIdentityOf (anchorPath: string): Promise<FallbackAnchorIdentity> {
  const [stats, resolvedReal] = await Promise.all([
    lstat(anchorPath, { bigint: true }) as Promise<BigIntStats>,
    realpath(anchorPath),
  ])
  if (!stats.isDirectory()) {
    throw new FallbackFrontierError(
      FALLBACK_FRONTIER_ERROR_CODES.ANCHOR_IDENTITY_MISMATCH,
      `The anchor ${anchorPath} is not a directory at identity capture; refusing to attach a frontier to it`
    )
  }
  if (resolvedReal !== anchorPath) {
    throw new FallbackFrontierError(
      FALLBACK_FRONTIER_ERROR_CODES.ANCHOR_IDENTITY_MISMATCH,
      `The anchor ${anchorPath} resolved to ${resolvedReal}; refusing to attach a frontier to an aliased directory`
    )
  }
  return {
    path: anchorPath,
    realpath: resolvedReal,
    type: 'directory',
    device: stats.dev.toString(10),
    inode: stats.ino.toString(10),
  }
}

/**
 * Derive the frontier plan for exactly the authorized leaves supplied by the
 * caller. Read-only: inspects the filesystem, never mutates, never widens the
 * leaf set. Deterministic: equal inputs produce byte-identical plans.
 */
export async function deriveFallbackFrontierPlan (
  leaves: readonly FallbackLeafTarget[],
  linkPolicy: FallbackLinkMaterializationPolicy = STRICT_SYMLINK_POLICY
): Promise<FallbackFrontierPlan> {
  if (!Array.isArray(leaves)) throw invalid('leaves must be an array')
  if (leaves.length > FALLBACK_FRONTIER_BOUNDS.maxLeaves) throw invalid(`at most ${FALLBACK_FRONTIER_BOUNDS.maxLeaves} leaves are supported`)
  leaves.forEach((leaf, index) => assertValidLeafInput(leaf, index))

  const byPath = new Map<string, FallbackLeafTarget>()
  for (const leaf of leaves) {
    const previous = byPath.get(leaf.path)
    if (previous !== undefined) {
      throw new FallbackFrontierError(FALLBACK_FRONTIER_ERROR_CODES.COLLISION, `Leaves ${previous.id} and ${leaf.id} claim the same destination ${leaf.path}`)
    }
    byPath.set(leaf.path, leaf)
  }
  for (const ancestor of leaves) {
    for (const other of leaves) {
      if (ancestor.path !== other.path && isProperSegmentAncestor(ancestor.path, other.path)) {
        throw new FallbackFrontierError(FALLBACK_FRONTIER_ERROR_CODES.COLLISION, `Leaf ${ancestor.path} is an ancestor of leaf ${other.path}; nested authorized destinations are not supported`)
      }
    }
  }

  const inspections = await Promise.all(leaves.map((leaf) => inspectLeaf(leaf, linkPolicy)))
  const existingLeaves = inspections
    .filter((inspection): inspection is LeafInspection & { existing: true } => inspection.existing)
    .map((inspection) => inspection.leaf)
    .sort((a, b) => compareUtf8(a.path, b.path))
  const missingLeaves = inspections
    .filter((inspection): inspection is LeafInspection & { missingUnderExistingParent: true } => inspection.missingUnderExistingParent === true)
    .map((inspection) => inspection.leaf)
    .sort((a, b) => compareUtf8(a.path, b.path))

  const frontierLeaves = new Map<string, { anchorPath: string; leaves: FallbackLeafTarget[] }>()
  for (const inspection of inspections) {
    if (inspection.existing || inspection.missingUnderExistingParent === true || inspection.frontierPath === undefined || inspection.anchorPath === undefined) continue
    const group = frontierLeaves.get(inspection.frontierPath)
    if (group === undefined) frontierLeaves.set(inspection.frontierPath, { anchorPath: inspection.anchorPath, leaves: [inspection.leaf] })
    else group.leaves.push(inspection.leaf)
  }
  // The strict parser accepts at most maxFrontiers entries, so derivation
  // must enforce the same bound; otherwise derived evidence could not
  // round-trip through the manifest.
  if (frontierLeaves.size > FALLBACK_FRONTIER_BOUNDS.maxFrontiers) {
    throw invalid(`derivation produced ${frontierLeaves.size} frontiers; the bound is ${FALLBACK_FRONTIER_BOUNDS.maxFrontiers}`)
  }

  // Defensive: frontiers are keyed by path so distinct keys cannot collide,
  // but a forged or future-divergent graph must still never nest frontiers.
  const frontierPaths = [...frontierLeaves.keys()]
  for (const outer of frontierPaths) {
    for (const inner of frontierPaths) {
      if (outer !== inner && isProperSegmentAncestor(outer, inner)) {
        throw new FallbackFrontierError(FALLBACK_FRONTIER_ERROR_CODES.COLLISION, `Frontier ${outer} contains frontier ${inner}; overlapping frontiers are not supported`)
      }
    }
  }

  const frontiers: FallbackFrontierEvidence[] = []
  for (const frontierPath of frontierPaths) {
    const group = frontierLeaves.get(frontierPath)!
    const anchor = await anchorIdentityOf(group.anchorPath)
    const sortedLeaves = [...group.leaves].sort((a, b) => compareUtf8(a.path, b.path))
    frontiers.push({
      frontierPath,
      activation: sortedLeaves.some((leaf) => leaf.activation === 'required') ? 'required' : 'conditional',
      anchor,
      leaves: sortedLeaves,
    })
  }
  frontiers.sort((a, b) => compareUtf8(a.frontierPath, b.frontierPath))

  return { frontiers, existingLeaves, missingLeaves }
}

/**
 * Platform preflight for the binding decision: only Linux with coherent local
 * filesystem identity supports publishing planned-missing frontiers initially.
 * Plans whose parents all exist remain supported everywhere; conditional
 * frontiers explicitly marked inactive for this run do not block. Everything
 * else fails closed with FALLBACK_PARENT_CREATION_UNSUPPORTED BEFORE any
 * journal reservation or live mutation.
 */
export function evaluateFallbackFrontierPlatformSupport (
  frontiers: readonly FallbackFrontierEvidence[],
  options?: { inactiveFrontierPaths?: readonly string[] }
): FallbackFrontierPlatformSupport {
  const inactive = new Set(options?.inactiveFrontierPaths ?? [])
  for (const inactivePath of inactive) {
    const frontier = frontiers.find((entry) => entry.frontierPath === inactivePath)
    if (frontier === undefined) throw invalid(`inactive frontier ${inactivePath} is not part of the plan`)
    if (frontier.activation !== 'conditional') {
      throw invalid(`frontier ${inactivePath} is required for this run and cannot be marked inactive`)
    }
  }
  if (process.platform === 'linux') return { supported: true }
  const blocking = frontiers
    .filter((frontier) => !inactive.has(frontier.frontierPath))
    .map((frontier) => frontier.frontierPath)
    .sort(compareUtf8)
  if (blocking.length === 0) return { supported: true }
  return { supported: false, code: 'FALLBACK_PARENT_CREATION_UNSUPPORTED', frontierPaths: blocking }
}

function assertExactKeys (value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw invalid(`${label} must have exactly the fields ${wanted.join(', ')}`)
  }
}

function assertDecimalIdentity (value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw invalid(`${label} must be a decimal string`)
}

/** Strictly parse one frontier evidence value; rejects unknown fields and every shape violation. */
export function assertFallbackFrontierEvidence (value: unknown): asserts value is FallbackFrontierEvidence {
  if (typeof value !== 'object' || value === null) throw invalid('frontier evidence must be an object')
  const frontier = value as Record<string, unknown>
  assertExactKeys(frontier, ['frontierPath', 'activation', 'anchor', 'leaves'], 'frontier evidence')
  if (typeof frontier.frontierPath !== 'string' || !isCanonicalPath(frontier.frontierPath)) throw invalid('frontierPath must be an absolute canonical path')
  if (Buffer.byteLength(frontier.frontierPath, 'utf8') > FALLBACK_FRONTIER_BOUNDS.maxPathBytes) throw invalid('frontierPath exceeds the path bound')
  if (!LEAF_ACTIVATIONS.includes(frontier.activation as FallbackLeafActivation)) throw invalid('frontier activation is unknown')

  const anchor = frontier.anchor
  if (typeof anchor !== 'object' || anchor === null) throw invalid('frontier anchor must be an object')
  const anchorRecord = anchor as Record<string, unknown>
  assertExactKeys(anchorRecord, ['path', 'realpath', 'device', 'inode', 'type'], 'frontier anchor')
  if (typeof anchorRecord.path !== 'string' || !isCanonicalPath(anchorRecord.path)) throw invalid('anchor path must be an absolute canonical path')
  if (anchorRecord.realpath !== anchorRecord.path) throw invalid('anchor realpath must equal the anchor path by construction')
  if (anchorRecord.type !== 'directory') throw invalid("anchor type must be 'directory'")
  assertDecimalIdentity(anchorRecord.device, 'anchor device')
  assertDecimalIdentity(anchorRecord.inode, 'anchor inode')
  if (path.dirname(frontier.frontierPath as string) !== anchorRecord.path) {
    throw invalid('frontierPath must be a direct child of the anchor path')
  }

  const leaves = frontier.leaves
  if (!Array.isArray(leaves) || leaves.length === 0 || leaves.length > FALLBACK_FRONTIER_BOUNDS.maxLeaves) {
    throw invalid('frontier leaves must be a non-empty array within bounds')
  }
  let previousPath: string | undefined
  for (const entry of leaves) {
    assertValidLeafInput(entry, 0)
    if (previousPath !== undefined && compareUtf8(previousPath, entry.path) >= 0) {
      throw invalid('frontier leaves must be strictly sorted in UTF-8 byte order without duplicates')
    }
    previousPath = entry.path
    if (!isSameOrContained(entry.path, frontier.frontierPath as string)) {
      throw invalid(`leaf ${entry.id} is not at or below the frontier ${frontier.frontierPath as string}`)
    }
    const { segments } = segmentComponentsOf(entry.path)
    const { segments: frontierSegments } = segmentComponentsOf(frontier.frontierPath as string)
    const missingComponentCount = segments.length - frontierSegments.length
    if (missingComponentCount < 0 || missingComponentCount + 1 > FALLBACK_FRONTIER_BOUNDS.maxMissingSegmentsPerLeaf) {
      throw invalid(`leaf ${entry.id} exceeds the missing-segment bound below its frontier`)
    }
  }
}

/**
 * Reject globally impossible evidence: graphs where every frontier is
 * individually well-formed but which no derivation could ever produce. The
 * parser must never accept a language wider than the derivable graph
 * language, so tampered manifests fail closed before any filesystem access.
 */
function assertGloballyPossibleFrontierGraph (frontiers: readonly FallbackFrontierEvidence[]): void {
  let totalLeaves = 0
  for (const frontier of frontiers) totalLeaves += frontier.leaves.length
  if (totalLeaves > FALLBACK_FRONTIER_BOUNDS.maxLeaves) {
    throw invalid(`the graph carries ${totalLeaves} leaves across frontiers; the bound is ${FALLBACK_FRONTIER_BOUNDS.maxLeaves}`)
  }
  for (const outer of frontiers) {
    for (const inner of frontiers) {
      if (outer.frontierPath !== inner.frontierPath && isProperSegmentAncestor(outer.frontierPath, inner.frontierPath)) {
        throw invalid(`frontier ${outer.frontierPath} contains frontier ${inner.frontierPath}; nested frontiers are impossible`)
      }
    }
  }
  const leafPaths = new Map<string, FallbackLeafTarget>()
  const leafIdOwners = new Map<string, string>()
  for (const frontier of frontiers) {
    // Activation must exactly aggregate the frontier's leaves: required iff
    // any leaf is required, conditional iff all leaves are conditional.
    const anyRequired = frontier.leaves.some((leaf) => leaf.activation === 'required')
    if (anyRequired !== (frontier.activation === 'required')) {
      throw invalid(`frontier ${frontier.frontierPath} activation must be required exactly when any leaf is required`)
    }
    for (const leaf of frontier.leaves) {
      // A file or link leaf can never equal a directory frontier path: the
      // only legitimate self-referencing leaf is the missing directory skill
      // leaf that its own frontier publishes.
      if (leaf.path === frontier.frontierPath && leaf.role !== 'skill') {
        throw invalid(`leaf ${leaf.id} (${leaf.role}) cannot equal the directory frontier ${frontier.frontierPath}`)
      }
      const previousPath = leafPaths.get(leaf.path)
      if (previousPath !== undefined) {
        throw invalid(`leaves ${previousPath.id} and ${leaf.id} claim the same destination ${leaf.path} across frontiers`)
      }
      const previousIdPath = leafIdOwners.get(leaf.id)
      if (previousIdPath !== undefined) {
        throw invalid(`leaf id ${leaf.id} is duplicated across frontiers (${previousIdPath} and ${leaf.path})`)
      }
      leafPaths.set(leaf.path, leaf)
      leafIdOwners.set(leaf.id, leaf.path)
    }
  }
  const leafPathList = [...leafPaths.keys()]
  for (const ancestor of leafPathList) {
    for (const other of leafPathList) {
      if (ancestor !== other && isProperSegmentAncestor(ancestor, other)) {
        throw invalid(`leaf ${ancestor} is an ancestor of leaf ${other}; nested authorized destinations are impossible`)
      }
    }
  }
}

/** Strictly parse a whole frontier list; enforces bounds, uniqueness, and canonical byte order. */
export function assertFallbackFrontierEvidenceList (value: unknown): asserts value is FallbackFrontierEvidence[] {
  if (!Array.isArray(value)) throw invalid('frontier evidence must be an array')
  if (value.length > FALLBACK_FRONTIER_BOUNDS.maxFrontiers) throw invalid(`at most ${FALLBACK_FRONTIER_BOUNDS.maxFrontiers} frontiers are supported`)
  value.forEach((entry) => assertFallbackFrontierEvidence(entry))
  for (let index = 1; index < value.length; index++) {
    if (compareUtf8(value[index - 1].frontierPath, value[index].frontierPath) >= 0) {
      throw invalid('frontier evidence must be strictly sorted by frontierPath in UTF-8 byte order without duplicates')
    }
  }
  assertGloballyPossibleFrontierGraph(value)
}

/**
 * Select the leaves of one frontier that a publication unit may materialize:
 * every `required` leaf is always included, and only `conditional` leaves
 * whose exact id appears in the authorized selector are added. The selector
 * is pure planning input — it widens nothing on disk by itself — but it must
 * still be strict: unknown ids, duplicates, non-string entries, and
 * overflow are rejected instead of silently dropped, so a tampered or buggy
 * caller fails closed before any staging happens.
 *
 * Pure and deterministic: no filesystem access, no mutation of the frontier
 * evidence or the selector, and the result is a new UTF-8 byte-ordered
 * frozen array of the evidence's own leaf objects (never copies that could
 * drift from the recorded graph).
 */
export function selectActiveFallbackFrontierLeaves (
  frontier: FallbackFrontierEvidence,
  activeConditionalLeafIds: readonly string[] = []
): readonly FallbackLeafTarget[] {
  assertFallbackFrontierEvidence(frontier)
  if (!Array.isArray(activeConditionalLeafIds)) throw invalid('the active conditional leaf selector must be an array')
  if (activeConditionalLeafIds.length > FALLBACK_FRONTIER_BOUNDS.maxLeaves) {
    throw invalid(`the active conditional leaf selector exceeds the ${FALLBACK_FRONTIER_BOUNDS.maxLeaves}-leaf bound`)
  }
  const selected = new Set<string>()
  for (const id of activeConditionalLeafIds) {
    if (typeof id !== 'string' || id.length === 0 || Buffer.byteLength(id, 'utf8') > FALLBACK_FRONTIER_BOUNDS.maxLeafIdBytes) {
      throw invalid('active conditional leaf selector entries must be non-empty strings within the id bound')
    }
    if (selected.has(id)) throw invalid(`the active conditional leaf selector duplicates id ${id}`)
    selected.add(id)
  }
  const conditionalById = new Map<string, FallbackLeafTarget>()
  for (const leaf of frontier.leaves) {
    if (leaf.activation === 'required' && selected.has(leaf.id)) {
      throw invalid(`leaf ${leaf.id} is required and must never appear in the conditional selector`)
    }
    if (leaf.activation === 'conditional') conditionalById.set(leaf.id, leaf)
  }
  for (const id of selected) {
    if (!conditionalById.has(id)) throw invalid(`selector id ${id} is not a conditional leaf of this frontier`)
  }
  const active = frontier.leaves
    .filter((leaf) => leaf.activation === 'required' || selected.has(leaf.id))
    .sort((left, right) => compareUtf8(left.path, right.path))
  return Object.freeze(active)
}

function frontierEquals (expected: FallbackFrontierEvidence, observed: FallbackFrontierEvidence): string | undefined {
  if (expected.frontierPath !== observed.frontierPath) return 'frontierPath'
  if (expected.activation !== observed.activation) return 'activation'
  for (const key of ['path', 'realpath', 'type', 'device', 'inode'] as const) {
    if (expected.anchor[key] !== observed.anchor[key]) return `anchor.${key}`
  }
  if (expected.leaves.length !== observed.leaves.length) return 'leaves.length'
  for (let index = 0; index < expected.leaves.length; index++) {
    const a = expected.leaves[index]
    const b = observed.leaves[index]
    if (a.id !== b.id || a.role !== b.role || a.activation !== b.activation || a.path !== b.path) return `leaves[${index}]`
  }
  return undefined
}

/** One physical filesystem target the fallback journal must carry as an entry. */
export interface FallbackJournalPhysicalTarget {
  path: string
  /** True when this target is a topmost planned-missing frontier journaled as one missing publication unit. */
  frontier: boolean
}

/**
 * Derive the journal's exact NON-OVERLAPPING physical entry set from a
 * trusted manifest. This is the one shared derivation used by journal begin
 * (to create entries and backups) and strict validation (to reject entry
 * insertion, removal, path, kind, and digest tampering). Pure and
 * deterministic: no filesystem access, no clock, no randomness.
 *
 * - Ordinary tracking/owned/bundle/MCP targets NOT covered by a
 *   plannedMissingFrontier are retained verbatim (deduplicated by resolved
 *   path, in manifest order).
 * - Every covered leaf is omitted: a frontier covers its authorized leaves,
 *   so they are represented by the single frontier entry. A candidate under
 *   a frontier that is NOT one of that frontier's authorized leaves is a
 *   manifest inconsistency and is rejected.
 * - Each topmost frontier is added exactly once as a planned-missing
 *   publication unit, in UTF-8 byte order after the retained targets.
 * - Existing directory anchors stay validation-only: frontier anchors never
 *   become entries or snapshots through frontier evidence.
 */
export function deriveFallbackJournalPhysicalTargets (manifest: FallbackTransactionIdentity): FallbackJournalPhysicalTarget[] {
  assertFallbackFrontierEvidenceList(manifest.plannedMissingFrontiers)
  const frontiers = manifest.plannedMissingFrontiers
  const seen = new Set<string>()
  const retained: string[] = []
  const addCandidate = (rawPath: string): void => {
    const resolved = path.resolve(rawPath)
    if (seen.has(resolved)) return
    seen.add(resolved)
    const covering = frontiers.filter((frontier) => isSameOrContained(resolved, frontier.frontierPath))
    if (covering.length === 0) {
      retained.push(resolved)
      return
    }
    if (covering.length > 1) {
      throw new FallbackFrontierError(
        FALLBACK_FRONTIER_ERROR_CODES.COLLISION,
        `Manifest target ${resolved} is covered by multiple frontiers (${covering.map((entry) => entry.frontierPath).join(', ')}); frontiers must be disjoint`
      )
    }
    const leafPaths = new Set(covering[0].leaves.map((leaf) => path.resolve(leaf.path)))
    if (!leafPaths.has(resolved)) {
      throw new FallbackFrontierError(
        FALLBACK_FRONTIER_ERROR_CODES.INVALID_INPUT,
        `Manifest target ${resolved} falls under frontier ${covering[0].frontierPath} without being one of its authorized leaves`
      )
    }
    // Covered leaves are represented by the single frontier entry; they
    // never get their own overlapping physical entry or backup.
  }
  addCandidate(manifest.trackingPath)
  for (const entry of manifest.ownedSkills) addCandidate(entry.path)
  for (const entry of manifest.ownedLinks) addCandidate(entry.path)
  for (const entry of manifest.ownedMcpConfigPaths) addCandidate(typeof entry === 'string' ? entry : entry.path)
  for (const entry of manifest.bundleDestinations ?? []) addCandidate(entry.path)
  const frontierTargets = frontiers
    .map((frontier) => ({ path: path.resolve(frontier.frontierPath), frontier: true }))
    .sort((left, right) => compareUtf8(left.path, right.path))
  const retainedPaths = new Set(retained)
  if (frontierTargets.some((entry) => retainedPaths.has(entry.path))) {
    throw new FallbackFrontierError(FALLBACK_FRONTIER_ERROR_CODES.COLLISION, 'A frontier path cannot also be a retained journal target')
  }
  return [...retained.map((target) => ({ path: target, frontier: false })), ...frontierTargets]
}

/**
 * Revalidate recorded frontier evidence against the CURRENT filesystem for
 * journal begin and mutation claim. Every frontier must still hold its
 * exact anchor identity (path, type, realpath, device, inode) on a fully
 * non-link real-directory component chain, the frontier path must still be
 * missing, and rederiving the recorded leaves must reproduce exactly the
 * recorded graph. Any other outcome is FALLBACK_FRONTIER_DRIFT and must
 * fail the transaction closed BEFORE any journal reservation or CAS write.
 */
export async function revalidateFallbackFrontierEvidence (
  frontiers: readonly FallbackFrontierEvidence[],
  linkPolicy: FallbackLinkMaterializationPolicy = STRICT_SYMLINK_POLICY
): Promise<void> {
  assertFallbackFrontierEvidenceList(frontiers)
  for (const frontier of frontiers) {
    try {
      await revalidateOneFrontier(frontier, linkPolicy)
    } catch (error) {
      if (error instanceof FallbackFrontierError && error.code === FALLBACK_FRONTIER_ERROR_CODES.DRIFT) throw error
      throw new FallbackFrontierError(FALLBACK_FRONTIER_ERROR_CODES.DRIFT, `Frontier ${frontier.frontierPath} drifted before the transaction: ${(error as Error).message}`)
    }
  }
}

async function frontierPathState (frontierPath: string): Promise<'missing' | 'present' | 'unprovable'> {
  try {
    await lstat(frontierPath)
    return 'present'
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unprovable'
  }
}

/**
 * Revalidate ONLY the authenticated anchor chain of one frontier: real non-link
 * directory components down to the anchor, exact recorded device/inode
 * identity, and unchanged realpath. Unlike `revalidateFallbackFrontierEvidence`
 * it does NOT require the frontier path to still be missing — it is the
 * shared anchor proof for operations on a frontier that this process has
 * already published (e.g. process-local rollback), where the live path is
 * expected to exist. Throws `FallbackFrontierError` (DRIFT) on any mismatch.
 */
export async function revalidateFallbackFrontierAnchor (frontier: FallbackFrontierEvidence): Promise<void> {
  assertFallbackFrontierEvidenceList([frontier])
  try {
    await revalidateOneFrontierAnchor(frontier)
  } catch (error) {
    if (error instanceof FallbackFrontierError && error.code === FALLBACK_FRONTIER_ERROR_CODES.DRIFT) throw error
    throw new FallbackFrontierError(FALLBACK_FRONTIER_ERROR_CODES.DRIFT, `Frontier ${frontier.frontierPath} drifted before the transaction: ${(error as Error).message}`)
  }
}

async function revalidateOneFrontierAnchor (frontier: FallbackFrontierEvidence): Promise<void> {
  const drift = (detail: string): FallbackFrontierError => new FallbackFrontierError(FALLBACK_FRONTIER_ERROR_CODES.DRIFT, `Frontier ${frontier.frontierPath} drifted: ${detail}`)
  const anchorPath = path.resolve(frontier.anchor.path)
  const { root, segments } = segmentComponentsOf(anchorPath)
  let current = root
  for (const segment of segments) {
    const component = path.join(current, segment)
    let stats: Stats
    try {
      stats = await lstat(component)
    } catch {
      throw drift(`anchor component ${component} is missing`)
    }
    if (stats.isSymbolicLink() || !stats.isDirectory()) throw drift(`anchor component ${component} is not a real directory`)
    current = component
  }
  const [identity, real] = await Promise.all([
    lstat(frontier.anchor.path, { bigint: true }) as Promise<BigIntStats>,
    realpath(frontier.anchor.path),
  ])
  if (identity.isSymbolicLink() || !identity.isDirectory()) throw drift('the anchor is not a real directory')
  if (identity.dev.toString(10) !== frontier.anchor.device || identity.ino.toString(10) !== frontier.anchor.inode) throw drift('the anchor device/inode identity changed')
  if (real !== frontier.anchor.realpath || real !== anchorPath) throw drift('the anchor realpath changed')
}

async function revalidateOneFrontier (frontier: FallbackFrontierEvidence, linkPolicy: FallbackLinkMaterializationPolicy): Promise<void> {
  const drift = (detail: string): FallbackFrontierError => new FallbackFrontierError(FALLBACK_FRONTIER_ERROR_CODES.DRIFT, `Frontier ${frontier.frontierPath} drifted: ${detail}`)
  // Shared anchor proof: the anchor chain must still be real, non-link
  // directories down to the recorded anchor, with unchanged device/inode
  // identity and realpath. realpath alone cannot prove per-component kinds.
  await revalidateOneFrontierAnchor(frontier)
  const state = await frontierPathState(frontier.frontierPath)
  if (state === 'present') throw drift('the frontier path exists')
  if (state === 'unprovable') throw drift('the frontier path state cannot be proven')
  // Rederiving the recorded leaves must reproduce exactly this frontier:
  // every recorded leaf still missing below the still-missing frontier, with
  // the same anchor identity, activation, order, and leaf graph.
  const plan = await deriveFallbackFrontierPlan(frontier.leaves, linkPolicy)
  if (plan.existingLeaves.length > 0 || plan.missingLeaves.length > 0 || plan.frontiers.length !== 1) {
    throw drift('rederiving the recorded leaves does not reproduce exactly one missing frontier')
  }
  const field = frontierEquals(frontier, plan.frontiers[0])
  if (field !== undefined) throw drift(`rederived evidence differs at ${field}`)
}

/**
 * Exact structural expectation for a published frontier subtree, derived pure
 * and deterministically from trusted evidence. One spelling shared by journal
 * registration/validation/publication so the child can never widen the tree
 * and no consumer can fork the semantics.
 *
 * The frontier-level structure (everything from the frontier root down to
 * each leaf) is exactly the leaf set plus the intermediate directories that
 * leaf paths imply: nothing else may exist at that level. Below a `skill`
 * leaf (a managed directory) arbitrary file/directory content is allowed,
 * but no symlinks anywhere; `link` leaves are the only legitimate symlinks
 * and their readlink text must be exactly the final live path of the
 * corresponding `skill:<name>` leaf.
 */
export interface FallbackFrontierTreeExpectation {
  /** Frontier-level relative directory paths strictly required (leaf ancestors); UTF-8 byte order. */
  directories: readonly string[]
  /** Frontier-level relative leaf path → required terminal kind(s). Permissive link policies list every permitted kind; concrete plans still record actual kinds. */
  leafKinds: ReadonlyMap<string, FallbackLeafKind | readonly FallbackLeafKind[]>
  /** Relative link-leaf path → required readlink text (absolute final skill destination). */
  linkTargets: ReadonlyMap<string, string>
}

/**
 * Derive the tree expectation for one frontier. `allLeaves` must carry the
 * complete authorized leaf set of the manifest (every frontier's leaves), so
 * a `link:<name>` leaf can be bound to its `skill:<name>` final destination.
 * Pure: no filesystem access, no clock, no randomness.
 */
export function deriveFrontierTreeExpectation (
  frontier: FallbackFrontierEvidence,
  allLeaves: readonly FallbackLeafTarget[],
  options?: {
    /** Trusted resolver for `link:<name>` bindings beyond frontier leaves (existing skill destinations); must derive only from trusted evidence and return undefined when unknown. */
    skillDestinationResolver?: (leaf: FallbackLeafTarget) => string | undefined
    /** Trusted harness-derived link materialization policy; defaults to real symlinks only. */
    linkPolicy?: FallbackLinkMaterializationPolicy
  }
): FallbackFrontierTreeExpectation {
  if (!isCanonicalPath(frontier.frontierPath)) throw invalid('frontier path must be absolute and canonical')
  const directories = new Set<string>()
  const leafKinds = new Map<string, FallbackLeafKind | readonly FallbackLeafKind[]>()
  const linkTargets = new Map<string, string>()
  const skillPathsById = new Map(allLeaves.map((leaf) => [leaf.id, path.resolve(leaf.path)]))
  const linkPolicy = options?.linkPolicy ?? STRICT_SYMLINK_POLICY
  for (const leaf of frontier.leaves) {
    if (typeof leaf?.path !== 'string' || !isCanonicalPath(leaf.path)) throw invalid('frontier leaf paths must be absolute and canonical')
    const relative = path.relative(frontier.frontierPath, path.resolve(leaf.path))
    if (relative === '') {
      // A directory skill leaf may exactly equal the frontier root: the whole
      // published tree is that skill's managed content. Link/file leaves can
      // never equal a missing directory frontier.
      if (LEAF_EXPECTED_KINDS[leaf.role] !== 'directory') throw invalid('only a directory skill leaf may equal the frontier root')
      leafKinds.set('', 'directory')
      continue
    }
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw invalid(`frontier leaf ${leaf.path} is not below the frontier ${frontier.frontierPath}`)
    }
    if (leafKinds.has(relative)) throw invalid(`frontier leaves collapse into one relative path: ${relative}`)
    // A staged/live link leaf is one concrete kind; under a permissive policy
    // the same leaf could legitimately be either a real symlink or a copied
    // directory, so the expectation records every permitted kind. Concrete
    // stage/publication plans still observe and record ACTUAL kinds.
    const permittedKinds = permittedLeafKinds(leaf.role, linkPolicy)
    if (leaf.role === 'link' && permittedKinds.length > 1) {
      leafKinds.set(relative, [...permittedKinds])
    } else {
      leafKinds.set(relative, permittedKinds[0])
    }
    if (leaf.role === 'link') {
      const skillName = leaf.id.startsWith('link:') ? leaf.id.slice('link:'.length) : undefined
      let finalSkillPath = skillName === undefined ? undefined : skillPathsById.get(`skill:${skillName}`)
      if (finalSkillPath === undefined && options?.skillDestinationResolver !== undefined) {
        const resolved = options.skillDestinationResolver(leaf)
        if (resolved !== undefined) {
          if (typeof resolved !== 'string' || !isCanonicalPath(resolved)) throw invalid('skill destination resolver must return an absolute canonical path or undefined')
          finalSkillPath = resolved
        }
      }
      if (finalSkillPath === undefined) {
        throw invalid(`link leaf ${leaf.id} has no corresponding skill:<name> leaf for its final destination`)
      }
      linkTargets.set(relative, finalSkillPath)
    }
    // Every strict ancestor of the leaf inside the frontier must be created.
    const segments = relative.split(path.sep)
    for (let depth = 1; depth < segments.length; depth++) directories.add(segments.slice(0, depth).join(path.sep))
  }
  return { directories: [...directories].sort(compareUtf8), leafKinds, linkTargets }
}
