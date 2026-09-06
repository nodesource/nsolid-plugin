import { isDeepStrictEqual } from 'node:util'
import { createHash, randomUUID } from 'node:crypto'
import { constants as fsPromisesConstants, copyFile, cp, lstat, mkdir, mkdtemp, open, readFile, readlink, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync, lstatSync, readFileSync, realpathSync, type BigIntStats, type Dirent, type Stats } from 'node:fs'
import path from 'node:path'
import { FALLBACK_PROTOCOL_VERSION, type FallbackAnchorIdentity, type FallbackFrontierEvidence, type FallbackLeafTarget, type FallbackPathEvidence, type FallbackTransactionIdentity } from './types.js'
import { assertFallbackFrontierEvidenceList, compareUtf8, deriveFallbackJournalPhysicalTargets, deriveFrontierTreeExpectation, fallbackLinkMaterialization, revalidateFallbackFrontierAnchor, revalidateFallbackFrontierEvidence, selectActiveFallbackFrontierLeaves, type FallbackFrontierTreeExpectation } from './fallback-frontier.js'
import { isValidTrackingData, type TrackingData } from '../skills/skill-tracker.js'
import { isCanonicalPath, isSameOrContained, matchesTrackedOwnership } from './fallback-ownership.js'

export type FallbackJournalPhase = 'initializing' | 'prepared' | 'mutating'
export type FallbackPathKind = 'missing' | 'file' | 'directory' | 'symlink' | 'other'

export interface FallbackJournalEntry {
  path: string
  existed: boolean
  kind: FallbackPathKind
  /** Digest of the original live state at journal time (fallback-path-v2 framing). */
  digest?: string
  /** Backup of the original state inside the journal snapshot directory. */
  backup?: string
  /** Sibling staged payload (same volume) waiting to be swapped into place. */
  stage?: string
  stageDigest?: string
  /** Set once the staged payload (or deletion) has been swapped in. Validation evidence only: it never authorizes a deletion or an overwrite. */
  applied?: boolean
  /** Sibling quarantine path receiving the replaced live bytes until cleanup. */
  quarantine?: string
  /**
   * Durable, STRICTLY VALIDATED reporting/blocking field: a frontier rollback
   * prepared or attempted but not durably completed. It NEVER grants
   * destructive authority — it makes every restore/recovery/commit path
   * treat the transaction as incomplete (preserve and report) while the
   * ambiguous physical state is deliberately resolved.
   */
  frontierRollbackPending?: boolean
}

/**
 * Identity of one process. `startIdentity` carries the Linux process start
 * tick from /proc when available so a recycled PID can never inherit the
 * ownership recorded for the original process.
 */
export interface ProcessIdentity {
  pid: number
  startIdentity?: string
}

export interface FallbackJournal {
  version: 3
  phase: FallbackJournalPhase
  /** Monotonic revision; every durable write compares and increments it. */
  revision: number
  /** Unique per begin; binds handles to exactly one journal instance. */
  transactionId: string
  /** Canonical manifest digest; self-consistency only, never restore authority. */
  manifestDigest: string
  manifest: FallbackTransactionIdentity
  journalPath: string
  snapshotDirectory?: string
  owner: ProcessIdentity
  mutator?: ProcessIdentity & { claimedAt: string }
  entries: readonly FallbackJournalEntry[]
  /** Reporting-only residue recorded during the transaction; never an authorization. */
  preservedArtifacts?: readonly string[]
  preservedPaths?: readonly string[]
}

/**
 * In-process authority for journal operations. Handles are never serialized:
 * the trusted manifest copy and the artifact capabilities live only in the
 * memory of the process that created or claimed them. A value read from the
 * journal file can never authorize a destructive operation on its own.
 */
export interface FallbackJournalHandle {
  readonly kind: 'fallback-journal-handle'
  readonly journalPath: string
  readonly transactionId: string
  readonly manifestDigest: string
  /** Trusted in-memory manifest: the owner's planning capability. */
  readonly manifest: FallbackTransactionIdentity
  role: 'owner' | 'mutator'
  readonly actor: ProcessIdentity
  revision: number
}

export interface FallbackJournalResult {
  journal: FallbackJournal
  handle: FallbackJournalHandle
}

/** Structured result replacing bare booleans; preservation arrays are reporting only. */
export interface FallbackJournalOperationResult {
  succeeded: boolean
  /**
   * True when a planned-missing frontier was physically rolled back (its
   * proven live tree moved into a preserved quarantine, restoring the
   * original missing state) but the durable journal bookkeeping for that
   * rollback did not complete. Reporting-only: the physical restore IS done
   * and the preserved quarantine is listed in preservedArtifacts.
   */
  frontierJournalPending?: boolean
  /**
   * True when the operation could not even start because the journal does not
   * match the trusted manifest or a backup failed authentication: nothing was
   * mutated and everything is preserved (surfaces as FALLBACK_STATE_UNPROVEN).
   */
  unproven?: boolean
  preservedArtifacts: string[]
  preservedPaths: string[]
}

interface ArtifactCapability {
  container: string
  payload?: string
  token: string
  role: 'stage' | 'quarantine' | 'restore' | 'snapshot'
  dev?: number
  ino?: number
  /** Immutable complete-stage digest recorded at frontier registration; apply requires payload AND journal to match it. */
  stageDigest?: string
  /**
   * Exact expected direct-child structure (child name → fallback path kind)
   * recorded when this process created the container. Authenticated cleanup
   * refuses to delete unless reality still matches it exactly.
   */
  children?: ReadonlyMap<string, FallbackPathKind>
  /**
   * Frozen private copied-link binding proven at stage registration for an
   * independent harness link destination. Apply re-proves the staged payload
   * and the published path against this record alone; it is never serialized
   * and never derived from journal fields or the mutable live skill bytes.
   */
  copiedLinkBinding?: Readonly<FrozenCopiedLinkBinding>
  /**
   * Frozen private copied-link bindings for one frontier stage, keyed by
   * frontier-relative leaf path. Publication proves staged and published
   * leaves against these records; they are copied into the completion record
   * so authorized rollback proves against the same frozen records.
   */
  copiedLinkBindings?: Readonly<Record<string, Readonly<FrozenCopiedLinkBinding>>>
}

/**
 * Artifact capabilities are in-memory authority, never serialized state: only
 * a container this process created (and still holds the token for) may be
 * removed, and only after its exact structural identity is reverified. They
 * are keyed by the unique transaction id (never by handle object identity):
 * journal APIs return revision-bumped handle copies, and the capability
 * domain must survive those spreads within this one process.
 */
const handleCapabilities = new Map<string, Map<string, ArtifactCapability>>()

/**
 * Object-identity authority registry: every handle object issued by a
 * legitimate transition (begin/claim/reclaim/register/apply) is bound here to
 * an IMMUTABLE snapshot of the metadata it was issued with. A destructive
 * frontier rollback requires the CURRENT object's fields to still equal the
 * bound metadata exactly, so in-place field mutation and spread copies both
 * fail closed. Weak so genuine handles can be garbage-collected normally.
 */
interface GenuineHandleMetadata {
  readonly transactionId: string
  readonly journalPath: string
  readonly manifestDigest: string
  readonly role: FallbackJournalHandle['role']
  readonly actor: ProcessIdentity
  readonly revision: number
}

const genuineJournalHandles = new WeakMap<FallbackJournalHandle, GenuineHandleMetadata>()

/** Snapshot one handle's immutable issued metadata. */
function genuineHandleMetadataOf (handle: FallbackJournalHandle): GenuineHandleMetadata {
  return Object.freeze({
    transactionId: handle.transactionId,
    journalPath: handle.journalPath,
    manifestDigest: handle.manifestDigest,
    role: handle.role,
    actor: { ...handle.actor },
    revision: handle.revision,
  })
}

/**
 * The ONLY way a handle object becomes destructive-frontier authority in this
 * process: bind the exact issued metadata to this object. Never exposed
 * outside this module.
 */
function issueGenuineHandle (handle: FallbackJournalHandle): FallbackJournalHandle {
  genuineJournalHandles.set(handle, genuineHandleMetadataOf(handle))
  return handle
}

/** A genuine current handle whose object fields still equal its bound metadata exactly. */
function handleMatchesIssuedMetadata (handle: FallbackJournalHandle): boolean {
  const bound = genuineJournalHandles.get(handle)
  if (bound === undefined) return false
  return handle.transactionId === bound.transactionId &&
    handle.journalPath === bound.journalPath &&
    handle.manifestDigest === bound.manifestDigest &&
    handle.role === bound.role &&
    processMatches(handle.actor) &&
    handle.actor.pid === bound.actor.pid &&
    handle.actor.startIdentity === bound.actor.startIdentity &&
    handle.revision === bound.revision
}

function capabilitiesFor (handle: FallbackJournalHandle): Map<string, ArtifactCapability> {
  let map = handleCapabilities.get(handle.transactionId)
  if (map === undefined) {
    map = new Map()
    handleCapabilities.set(handle.transactionId, map)
  }
  return map
}

/**
 * Process-local authoritative record of one completed frontier publication:
 * the exact reserved directory identity this process created by exclusive
 * mkdir plus the registered complete-stage digest the published tree was
 * proven against. Never serialized, never derived from journal fields: a
 * forged `applied`/`stageDigest` on disk can never produce one.
 */
export interface FallbackFrontierPublication {
  frontierPath: string
  /** dev/ino of the reserved directory this process created and populated. */
  dev: number
  ino: number
  /** Registered complete-stage digest the live tree was proven against. */
  stageDigest: string
  /** True when stage-cleanup or post-apply bookkeeping did not finish: publication IS complete, only residue reporting is pending. */
  cleanupPending: boolean
  /** Frozen copy of the conditional leaf IDs this process authorized as active at registration. Reporting only: never disk-derived authority. */
  activeConditionalLeafIds: readonly string[]
}

/**
 * Process-local publication record including the frozen copied-link
 * bindings. Internal authority state only: `publishedFallbackFrontiers`
 * strips the bindings from every exported report object.
 */
interface InternalFrontierPublication extends FallbackFrontierPublication {
  copiedLinkBindings?: Readonly<Record<string, Readonly<FrozenCopiedLinkBinding>>>
}

/** Registered stage plan for one frontier: exact leaf kinds, staged leaf digests, link texts, and the immutable active conditional leaf selection. */
interface FallbackFrontierStagePlan {
  leafKinds: Map<string, 'file' | 'directory' | 'symlink'>
  leafDigests: Map<string, string>
  linkTexts: Map<string, string>
  /** Sorted frozen selected conditional leaf IDs; the immutable apply/rollback proof selection. */
  activeConditionalLeafIds: readonly string[]
}

const frontierStagePlans = new Map<string, Map<string, FallbackFrontierStagePlan>>()
const completedFrontierPublications = new Map<string, Map<string, InternalFrontierPublication>>()

function frontierPlanFor (transactionId: string): Map<string, FallbackFrontierStagePlan> {
  let map = frontierStagePlans.get(transactionId)
  if (map === undefined) {
    map = new Map()
    frontierStagePlans.set(transactionId, map)
  }
  return map
}

/** Process-local publication records for a transaction; empty unless this very process published frontiers through its own capabilities. Internal binding authority is stripped from every report: callers receive reporting metadata only and can never mutate internal state. */
export function publishedFallbackFrontiers (handle: FallbackJournalHandle): readonly FallbackFrontierPublication[] {
  return [...(completedFrontierPublications.get(handle.transactionId)?.values() ?? [])].map((record) => Object.freeze({
    frontierPath: record.frontierPath,
    dev: record.dev,
    ino: record.ino,
    stageDigest: record.stageDigest,
    cleanupPending: record.cleanupPending,
    activeConditionalLeafIds: record.activeConditionalLeafIds,
  }))
}

/**
 * Awaited test-only seam between the final container identity recheck and the
 * tombstone rename inside authenticated cleanup. Production never installs
 * one; tests use it to deterministically run code inside that window and
 * prove a swapped-in replacement or smuggled content can never be deleted.
 */
type FallbackArtifactSwapSeam = (artifact: { container: string; role: ArtifactCapability['role'] }) => Promise<void> | void
let fallbackArtifactSwapSeam: FallbackArtifactSwapSeam | undefined

export function setFallbackArtifactSwapSeamForTests (seam?: FallbackArtifactSwapSeam): void {
  fallbackArtifactSwapSeam = seam
}

/** Deterministic awaited test windows inside frontier publication; production never installs one. */
export interface FallbackFrontierPublicationSeamEvent {
  phase: 'before-reserve' | 'reserved-identity' | 'before-leaf' | 'post-population' | 'stage-ready' | 'after-applied'
  frontierPath: string
  leaf?: string
}

type FallbackFrontierPublicationSeam = (event: FallbackFrontierPublicationSeamEvent) => Promise<void> | void

let fallbackFrontierPublicationSeam: FallbackFrontierPublicationSeam | undefined

export function setFallbackFrontierPublicationSeamForTests (seam?: FallbackFrontierPublicationSeam): void {
  fallbackFrontierPublicationSeam = seam
}

/** Deterministic awaited test windows inside frontier rollback; production never installs one. */
export interface FallbackFrontierRollbackSeamEvent {
  phase: 'proof-complete' | 'quarantine-ready' | 'moved' | 'proven'
  frontierPath: string
  quarantinePath?: string
}

type FallbackFrontierRollbackSeam = (event: FallbackFrontierRollbackSeamEvent) => Promise<void> | void

let fallbackFrontierRollbackSeam: FallbackFrontierRollbackSeam | undefined

export function setFallbackFrontierRollbackSeamForTests (seam?: FallbackFrontierRollbackSeam): void {
  fallbackFrontierRollbackSeam = seam
}

/**
 * Remove-only test reset: clears every process-local frontier stage plan and
 * completion record, simulating a process restart. It can never create
 * authority; a cleared registry only ever yields fail-closed preservation.
 */
export function clearFallbackFrontierPublicationStateForTests (): void {
  completedFrontierPublications.clear()
  frontierStagePlans.clear()
}

export function trackingDigest (trackingPath: string): string | undefined {
  try { return createHash('sha256').update(readFileSync(trackingPath)).digest('hex') } catch { return undefined }
}

export function fallbackJournalPath (trackingPath: string): string {
  return `${path.resolve(trackingPath)}.update-journal.json`
}

/**
 * Fallback digest framing: framed, recursive, locale-independent. All fallback
 * evidence (manifests, journals, tracking) uses this single digest domain;
 * digests from other domains (for example the owned-fs framing) are never
 * reinterpreted as fallback evidence.
 */
export async function pathKind (target: string): Promise<FallbackPathKind> {
  try {
    const stat = await lstat(target)
    if (stat.isSymbolicLink()) return 'symlink'
    if (stat.isDirectory()) return 'directory'
    if (stat.isFile()) return 'file'
    return 'other'
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'
    return 'other'
  }
}

export async function pathDigest (target: string): Promise<string | undefined> {
  try {
    const stat = await lstat(target)
    const hash = createHash('sha256')
    if (stat.isSymbolicLink()) {
      hash.update('symlink\0').update(await readlink(target))
      return hash.digest('hex')
    }
    if (stat.isFile()) {
      hash.update('file\0').update(await readFile(target))
      return hash.digest('hex')
    }
    if (stat.isDirectory()) {
      hash.update('directory\0')
      const entries = await readdir(target, { withFileTypes: true })
      const ordered = [...entries].sort((left, right) => Buffer.compare(Buffer.from(left.name, 'utf8'), Buffer.from(right.name, 'utf8')))
      for (const entry of ordered) {
        const child = path.join(target, entry.name)
        hash.update(entry.name).update('\0')
        const childDigest = await pathDigest(child)
        if (!childDigest) return undefined
        hash.update(childDigest)
      }
      return hash.digest('hex')
    }
    return undefined
  } catch {
    return undefined
  }
}

/** Deterministic recursively key-sorted JSON: arrays keep order, undefined object fields are omitted, and undefined/sparse array elements plus non-finite numbers are rejected. */
export function canonicalJsonString (value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

function canonicalize (value: unknown): unknown {
  if (value === null) return null
  const type = typeof value
  if (type === 'string' || type === 'boolean') return value
  if (type === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Non-finite numbers have no canonical JSON form')
    return value
  }
  if (type === 'object') {
    if (Array.isArray(value)) {
      const output: unknown[] = []
      for (const [index, element] of value.entries()) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) throw new TypeError('Sparse arrays have no canonical JSON form')
        if (element === undefined) throw new TypeError('Undefined array elements have no canonical JSON form')
        output.push(canonicalize(element))
      }
      return output
    }
    const source = value as Record<string, unknown>
    const output: Record<string, unknown> = {}
    for (const key of Object.keys(source).sort((left, right) => Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8')))) {
      const element = source[key]
      if (element === undefined) continue
      output[key] = canonicalize(element)
    }
    return output
  }
  throw new TypeError(`Values of type ${type} have no canonical JSON form`)
}

/** sha256(canonicalJsonString(manifest)); transported explicitly to the child via --manifest-digest. */
export function manifestDigestOf (manifest: FallbackTransactionIdentity): string {
  return createHash('sha256').update(canonicalJsonString(manifest)).digest('hex')
}

function currentProcessIdentity (): ProcessIdentity {
  return { pid: process.pid, startIdentity: processStartIdentity(process.pid) }
}

/** Linux process start ticks; undefined where /proc is unavailable. */
function processStartIdentity (pid: number): string | undefined {
  if (process.platform !== 'linux') return undefined
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const close = stat.indexOf(') ')
    if (close < 0) return undefined
    const fields = stat.slice(close + 2).split(' ')
    // starttime is overall field 22; the slice above starts at field 3.
    const start = fields[19]
    return typeof start === 'string' && start.length > 0 ? start : undefined
  } catch {
    return undefined
  }
}

function processMatches (identity: ProcessIdentity): boolean {
  if (identity.pid !== process.pid) return false
  const mine = processStartIdentity(process.pid)
  if (identity.startIdentity === undefined || mine === undefined) return true
  return identity.startIdentity === mine
}

function processIsLive (identity: ProcessIdentity): boolean {
  if (identity.pid === process.pid) {
    // PID equality alone is not proof of life: the record may belong to a
    // dead predecessor whose PID this process recycled. When both start
    // identities are known, a mismatch proves the recorded process is gone
    // (a recycled PID must never block reclaim). Without a comparable start
    // identity, the process stays treated as live (fail closed for reclaim).
    const mine = processStartIdentity(process.pid)
    if (identity.startIdentity !== undefined && mine !== undefined) return identity.startIdentity === mine
    return true
  }
  if (identity.startIdentity !== undefined && process.platform === 'linux') {
    const start = processStartIdentity(identity.pid)
    // A start mismatch means the PID was recycled: the recorded process is dead.
    return start !== undefined && start === identity.startIdentity
  }
  try {
    process.kill(identity.pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function plannedEvidenceMap (manifest: FallbackTransactionIdentity): Map<string, FallbackPathEvidence> {
  const evidence = new Map<string, FallbackPathEvidence>()
  const add = (entry: FallbackPathEvidence): void => {
    if (entry !== undefined && !evidence.has(path.resolve(entry.path))) evidence.set(path.resolve(entry.path), entry)
  }
  for (const entry of manifest.ownedSkills ?? []) add(entry)
  for (const entry of manifest.ownedLinks ?? []) add(entry)
  for (const entry of manifest.ownedMcpConfigPaths ?? []) {
    if (typeof entry !== 'string') add(entry)
  }
  for (const entry of manifest.bundleDestinations ?? []) add(entry)
  return evidence
}

/**
 * Begin a journal transaction. The journal path is reserved with `wx` BEFORE
 * any snapshot work so concurrent begins (same process or cross-process) fail
 * closed with FALLBACK_JOURNAL_BUSY. The manifest is the planning authority:
 * every journaled path must already be described by it, and live drift fails
 * the begin before anything is created.
 */
export async function beginFallbackJournal (manifest: FallbackTransactionIdentity): Promise<FallbackJournalResult> {
  // Protocol gate BEFORE any reservation or snapshot work: a manifest from an
  // incompatible planner must never create journal or filesystem state.
  if (manifest.protocolVersion !== FALLBACK_PROTOCOL_VERSION) throw new Error('FALLBACK_PROTOCOL_UNSUPPORTED')
  // Frontier evidence gate, also before ANY filesystem access: protocol v3
  // requires exactly-parsed planned-missing frontier evidence. Absent,
  // malformed, extra-keyed, or tampered graphs are not v3 transactions.
  try {
    assertFallbackFrontierEvidenceList(manifest.plannedMissingFrontiers)
  } catch (error) {
    throw new Error('FALLBACK_FRONTIER_EVIDENCE_INVALID', { cause: error })
  }
  const trackingPath = path.resolve(manifest.trackingPath)
  const currentTrackingDigest = trackingDigest(trackingPath)
  if (!currentTrackingDigest || currentTrackingDigest !== manifest.trackingDigest || !await manifestMatchesTrackingFile(manifest)) {
    throw new Error('FALLBACK_TRACKING_DRIFT')
  }
  for (const entry of [...manifest.ownedSkills, ...manifest.ownedLinks]) {
    const kind = await pathKind(entry.path)
    const digest = kind === 'missing' ? undefined : await pathDigest(entry.path)
    if (kind !== entry.kind || digest !== entry.digest) throw new Error('FALLBACK_TRACKING_DRIFT')
  }
  // The journal's exact physical entry set is derived from the manifest
  // before anything is created: covered leaves are represented by their
  // frontier, hidden candidates are manifest inconsistencies, and every
  // derivation failure is rejected as invalid evidence, not as a backup
  // failure.
  let physicalTargets: ReturnType<typeof deriveFallbackJournalPhysicalTargets>
  try {
    physicalTargets = deriveFallbackJournalPhysicalTargets(manifest)
  } catch (error) {
    throw new Error('FALLBACK_FRONTIER_EVIDENCE_INVALID', { cause: error })
  }
  // Frontier live revalidation BEFORE the reservation and any snapshot work:
  // the recorded anchor identity, the non-link component chain, the still-
  // missing frontier path, and the exact recorded leaf graph must all hold
  // right now, or the transaction fails closed before any journal or
  // filesystem state exists.
  try {
    await revalidateFallbackFrontierEvidence(manifest.plannedMissingFrontiers, fallbackLinkMaterialization(manifest.harness))
  } catch (error) {
    throw new Error('FALLBACK_FRONTIER_DRIFT', { cause: error })
  }
  const journalPath = fallbackJournalPath(trackingPath)
  const manifestDigest = manifestDigestOf(manifest)
  const transactionId = randomUUID()
  const owner = currentProcessIdentity()
  // Reserve before any snapshot work: two begins in one process or in two
  // processes cannot both create snapshots.
  try {
    const reservation = await open(journalPath, 'wx', 0o600)
    await reservation.close()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('FALLBACK_JOURNAL_BUSY')
    throw error
  }
  const initial: FallbackJournal = {
    version: 3,
    phase: 'initializing',
    revision: 0,
    transactionId,
    manifestDigest,
    manifest,
    journalPath,
    owner,
    entries: [],
  }
  let snapshotDirectory: string | undefined
  try {
    await writeDurable(journalPath, initial)
    snapshotDirectory = await mkdtemp(path.join(path.dirname(trackingPath), '.nsolid-plugin-update-'))
    const snapshotIdentity = await lstat(snapshotDirectory)
    const planned = plannedEvidenceMap(manifest)
    // Exactly the shared derivation: retained ordinary targets plus one
    // planned-missing entry per topmost frontier. Covered leaves never get
    // overlapping entries, and existing directory anchors stay validation-
    // only (never entries or backups).
    const entries: FallbackJournalEntry[] = []
    for (const [index, target] of physicalTargets.map((entry) => entry.path).entries()) {
      const kind = await pathKind(target)
      const backup = path.join(snapshotDirectory, String(index))
      const digest = kind !== 'missing' ? await pathDigest(target) : undefined
      if (kind !== 'missing' && !digest) throw new Error(`cannot digest ${target}`)
      const evidence = planned.get(target)
      if (evidence && (evidence.kind !== kind || evidence.digest !== digest)) throw new Error(`planned fallback path changed: ${target}`)
      if (kind !== 'missing') await cp(target, backup, { recursive: true, force: true, verbatimSymlinks: true, dereference: false })
      if (evidence && kind !== 'missing' && (await pathDigest(backup) !== evidence.digest || await pathDigest(target) !== evidence.digest)) {
        throw new Error(`fallback path changed while it was being snapshotted: ${target}`)
      }
      if (target === trackingPath && kind !== 'missing' && trackingDigest(backup) !== manifest.trackingDigest) {
        throw new Error(`tracking backup does not match the planned tracking digest: ${target}`)
      }
      if (evidence && evidence.kind === 'missing' && kind !== 'missing') {
        throw new Error(`planned-missing fallback destination appeared before journaling: ${target}`)
      }
      entries.push({ path: target, kind, existed: kind !== 'missing', digest, backup: kind !== 'missing' ? backup : undefined })
    }
    const prepared: FallbackJournal = { ...initial, phase: 'prepared', revision: 1, snapshotDirectory, entries }
    await casWrite(journalPath, prepared, initial)
    const handle: FallbackJournalHandle = {
      kind: 'fallback-journal-handle',
      journalPath,
      transactionId,
      manifestDigest,
      manifest,
      role: 'owner',
      actor: owner,
      revision: 1,
    }
    issueGenuineHandle(handle)
    capabilitiesFor(handle).set('\0snapshot', {
      container: snapshotDirectory,
      token: transactionId,
      role: 'snapshot',
      dev: snapshotIdentity.dev,
      ino: snapshotIdentity.ino,
      children: new Map(entries
        .filter((entry) => entry.backup !== undefined)
        .map((entry) => [path.basename(entry.backup!), entry.kind] as const)),
    })
    return { journal: prepared, handle }
  } catch (error) {
    if (snapshotDirectory !== undefined) {
      await rm(snapshotDirectory, { recursive: true, force: true }).catch(() => {})
    }
    // Remove the reservation only when the file on disk is still the one this
    // invocation wrote; anything else is preserved untouched.
    try {
      const current = JSON.parse(await readFile(journalPath, 'utf8')) as FallbackJournal
      if (current?.transactionId === transactionId) await rm(journalPath, { force: true }).catch(() => {})
    } catch { /* preserve unparseable state */ }
    throw new Error('FALLBACK_BACKUP_FAILED', { cause: error })
  }
}

/**
 * Advance a prepared journal to mutating. Owner role only; the disk state is
 * strictly reloaded and the revision must match the handle.
 */
export async function markFallbackJournalMutating (handle: FallbackJournalHandle): Promise<FallbackJournalHandle> {
  const journal = await reloadFallbackJournal(handle)
  requireRole(journal, handle, 'owner')
  if (journal.phase !== 'prepared') throw new Error('Invalid fallback journal')
  const revision = await casWrite(handle.journalPath, { ...journal, phase: 'mutating' }, journal)
  return issueGenuineHandle({ ...handle, revision })
}

/**
 * Claim the right to mutate as the external child. The expected canonical
 * manifest digest must come from the trusted caller (the CLI recomputes it
 * from the transaction file it verified); it is never read back from the
 * journal. Returns a mutator handle, or null when the journal is missing,
 * mismatched, or held by another live process.
 */
export async function claimFallbackJournalMutation (manifest: FallbackTransactionIdentity, expectedManifestDigest?: string): Promise<FallbackJournalHandle | null> {
  // Protocol gate BEFORE any journal read or mutation: an incompatible child
  // fails with a stable code and leaves the on-disk transaction untouched.
  if (manifest.protocolVersion !== FALLBACK_PROTOCOL_VERSION) throw new Error('FALLBACK_PROTOCOL_UNSUPPORTED')
  // Frontier evidence gate BEFORE any journal read or CAS write: the claimed
  // manifest must carry exactly-parsed v3 frontier evidence or the claim is
  // refused with the on-disk journal byte-identical.
  try {
    assertFallbackFrontierEvidenceList(manifest.plannedMissingFrontiers)
  } catch (error) {
    throw new Error('FALLBACK_FRONTIER_EVIDENCE_INVALID', { cause: error })
  }
  // Frontier live revalidation BEFORE any journal read or CAS write: the
  // claimed transaction must still match the recorded anchor identity, the
  // non-link component chain, the still-missing frontier path, and the exact
  // recorded leaf graph. Any drift fails closed with the journal untouched.
  try {
    await revalidateFallbackFrontierEvidence(manifest.plannedMissingFrontiers, fallbackLinkMaterialization(manifest.harness))
  } catch (error) {
    throw new Error('FALLBACK_FRONTIER_DRIFT', { cause: error })
  }
  const journalPath = fallbackJournalPath(manifest.trackingPath)
  if (!existsSync(journalPath)) return null
  let journal: FallbackJournal
  try {
    journal = strictLoad(journalPath)
  } catch {
    return null
  }
  const expected = expectedManifestDigest ?? manifestDigestOf(manifest)
  if (journal.manifestDigest !== expected || manifestDigestOf(journal.manifest) !== expected) return null
  if (!sameManifest(journal.manifest, manifest)) return null
  if (journal.manifest.nonce === undefined || journal.manifest.nonce !== manifest.nonce) return null
  if (journal.phase !== 'mutating') return null
  if (!await journalOwnershipIsValid(journal)) return null
  if (journal.mutator !== undefined && !processMatches(journal.mutator) && processIsLive(journal.mutator)) return null
  const mutator = currentProcessIdentity()
  try {
    const revision = await casWrite(journalPath, { ...journal, mutator: { ...mutator, claimedAt: new Date().toISOString() } }, journal)
    const claimed: FallbackJournalHandle = {
      kind: 'fallback-journal-handle',
      journalPath,
      transactionId: journal.transactionId,
      manifestDigest: journal.manifestDigest,
      manifest,
      role: 'mutator',
      actor: mutator,
      revision,
    }
    issueGenuineHandle(claimed)
    return claimed
  } catch {
    return null
  }
}

/**
 * Parent reclaim after the child command has completed (and NEVER while tree
 * termination is unconfirmed — enforcing that is caller policy). Refuses while
 * the recorded mutator is a live different process; a same-process mutator is
 * the transaction-less local transition and is released here. The owner adopts
 * the latest disk revision without adopting any dynamic journal field as
 * authority: restore decisions come only from the trusted in-memory manifest.
 */
export async function reclaimFallbackJournalMutation (handle: FallbackJournalHandle): Promise<FallbackJournalHandle> {
  if (!handleMatchesIssuedMetadata(handle)) throw new Error('Invalid fallback journal')
  const journal = strictLoad(handle.journalPath)
  if (journal.transactionId !== handle.transactionId) throw new Error('Invalid fallback journal')
  if (journal.manifestDigest !== handle.manifestDigest || manifestDigestOf(journal.manifest) !== handle.manifestDigest) throw new Error('Invalid fallback journal')
  if (!sameManifest(journal.manifest, handle.manifest)) throw new Error('Invalid fallback journal')
  if (!processMatches(journal.owner)) throw new Error('Invalid fallback journal')
  if (journal.mutator !== undefined && !processMatches(journal.mutator) && processIsLive(journal.mutator)) {
    throw new Error('FALLBACK_MUTATOR_LIVE')
  }
  const revision = await casWrite(handle.journalPath, { ...journal, mutator: undefined }, journal)
  const reclaimed: FallbackJournalHandle = { ...handle, role: 'owner', revision }
  issueGenuineHandle(reclaimed)
  return reclaimed
}

/** Register a staged replacement payload for one entry. Mutator role; the capability stays in this process's memory. */
export async function registerFallbackStage (handle: FallbackJournalHandle, target: string, payload: { directory?: string; bytes?: Buffer }): Promise<FallbackJournalHandle> {
  const journal = await reloadFallbackJournal(handle)
  requireRole(journal, handle, 'mutator')
  const resolved = path.resolve(target)
  const entry = journal.entries.find((candidate) => path.resolve(candidate.path) === resolved)
  if (!entry) throw new Error(`No fallback journal entry for ${resolved}`)
  const stageDirectory = await mkdtemp(path.join(path.dirname(resolved), `.${path.basename(resolved).replace(/^\.+/, '')}.nsolid-stage-`))
  const stagePath = path.join(stageDirectory, 'payload')
  try {
    if (payload.directory) {
      await cp(payload.directory, stagePath, { recursive: true, force: true, verbatimSymlinks: true, dereference: false })
    } else if (payload.bytes) {
      await writeFile(stagePath, payload.bytes, { mode: 0o600 })
    } else {
      throw new Error('A staged payload requires a directory or bytes')
    }
    const stageDigest = await pathDigest(stagePath)
    if (!stageDigest) throw new Error(`Cannot digest staged payload for ${resolved}`)
    const payloadKind = await pathKind(stagePath)
    // Copied-link binding proof BEFORE the durable CAS: a failure here aborts
    // the registration cleanly and the catch path removes this stage container.
    // The proven binding is frozen into the stage capability so apply and any
    // authorized same-process rollback prove against the frozen record alone.
    const copiedLinkBinding = await assertIndependentLinkStageBinding(handle, resolved, stagePath, payloadKind)
    const token = randomUUID()
    await writeFile(path.join(stageDirectory, `.nsolid-stage-${token}`), token, { mode: 0o600 })
    const identity = await lstat(stageDirectory)
    capabilitiesFor(handle).set(resolved, {
      container: stageDirectory,
      payload: stagePath,
      token,
      role: 'stage',
      dev: identity.dev,
      ino: identity.ino,
      children: new Map([
        ['payload', payloadKind],
        [`.nsolid-stage-${token}`, 'file'],
      ]),
      copiedLinkBinding,
    })
    // Trusted bundle-skill digest binding, computed from the registered
    // staged payload BEFORE the CAS so binding failures abort cleanly. It is
    // stored only after the CAS succeeds.
    const skillDestination = bundleSkillDestinationOf(handle.manifest, resolved)
    const skillBinding = payload.directory !== undefined && skillDestination !== undefined
      ? { finalSkillPath: resolved, skillName: skillDestination.skillName, digest: await digestRegisteredSkillPayload(resolved, stagePath) }
      : undefined
    if (skillBinding !== undefined) assertRegisteredSkillBindingAvailable(handle, skillBinding.finalSkillPath, skillBinding)
    const revision = await casWrite(handle.journalPath, {
      ...journal,
      entries: journal.entries.map((candidate) => candidate === entry
        ? { ...candidate, stage: stagePath, stageDigest, applied: false }
        : candidate),
    }, journal)
    if (skillBinding !== undefined) storeRegisteredSkillBinding(handle, skillBinding.finalSkillPath, skillBinding)
    const staged = { ...handle, revision }
    issueGenuineHandle(staged)
    return staged
  } catch (error) {
    await rm(stageDirectory, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}

/** Hard bounds for any frontier-rooted tree (staged source or published target); enforced before any live mutation. */
const FRONTIER_TREE_BOUNDS = {
  maxDepth: 16,
  maxNodes: 512,
  maxRelativePathBytes: 512,
  maxTotalBytes: 32 * 1024 * 1024,
  maxFileBytes: 8 * 1024 * 1024,
} as const

/** One walked tree entry relative to the frontier root; `other` covers non-regular entries (fifo, socket, …) and always fails closed. Directories carry their observed dev/ino for chain authentication. */
interface FrontierWalkEntry {
  relative: string
  kind: 'file' | 'directory' | 'symlink' | 'other'
  linkText?: string
  dev?: number
  ino?: number
}

/**
 * Walk a frontier-rooted tree with `lstat` only (never dereferences), in
 * deterministic UTF-8 pre-order: parents always sort before their
 * descendants, so the returned order is directly usable as an exclusive
 * population sequence. Depth, node-count, path-length, and size bounds fail
 * closed before any caller mutates anything.
 */
async function walkFrontierTree (root: string): Promise<FrontierWalkEntry[]> {
  const walked: FrontierWalkEntry[] = []
  let nodes = 0
  let totalBytes = 0
  const visit = async (absolute: string, relative: string, depth: number): Promise<void> => {
    if (depth > FRONTIER_TREE_BOUNDS.maxDepth) throw new Error(`Frontier tree exceeds the maximum depth of ${FRONTIER_TREE_BOUNDS.maxDepth}`)
    if (++nodes > FRONTIER_TREE_BOUNDS.maxNodes) throw new Error(`Frontier tree exceeds the maximum of ${FRONTIER_TREE_BOUNDS.maxNodes} entries`)
    if (Buffer.byteLength(relative, 'utf8') > FRONTIER_TREE_BOUNDS.maxRelativePathBytes) throw new Error(`Frontier tree path ${relative} exceeds the maximum path length`)
    const stats = await lstat(absolute)
    if (stats.isSymbolicLink()) {
      totalBytes += stats.size
      walked.push({ relative, kind: 'symlink', linkText: await readlink(absolute), dev: stats.dev, ino: stats.ino })
      return
    }
    if (stats.isDirectory()) {
      walked.push({ relative, kind: 'directory', dev: stats.dev, ino: stats.ino })
      const children = await readdir(absolute, { withFileTypes: true })
      for (const child of [...children].sort((left, right) => compareUtf8(left.name, right.name))) {
        await visit(path.join(absolute, child.name), relative === '' ? child.name : `${relative}${path.sep}${child.name}`, depth + 1)
      }
      return
    }
    if (stats.isFile()) {
      if (stats.size > FRONTIER_TREE_BOUNDS.maxFileBytes) throw new Error(`Frontier tree file ${relative} exceeds the maximum file size`)
      totalBytes += stats.size
      walked.push({ relative, kind: 'file', dev: stats.dev, ino: stats.ino })
      return
    }
    walked.push({ relative, kind: 'other' })
  }
  await visit(root, '', 0)
  if (totalBytes > FRONTIER_TREE_BOUNDS.maxTotalBytes) throw new Error(`Frontier tree exceeds the maximum total size of ${FRONTIER_TREE_BOUNDS.maxTotalBytes} bytes`)
  return walked.slice(1)
}

/**
 * One bounded walk that validates the structural bounds AND computes the
 * canonical tree digest: never a second, unbounded traversal. The digest
 * framing is byte-identical to `pathDigest` (symlink text, full file bytes,
 * UTF-8-ordered directory names), so a bounded digest can be compared with
 * any digest `pathDigest` produced for the same tree.
 */
async function boundedFrontierTreeDigest (root: string): Promise<string> {
  const walked = await walkFrontierTree(root)
  const memo = new Map<string, string>()
  const compute = async (relative: string): Promise<string> => {
    const entry = relative === ''
      ? { relative: '', kind: 'directory' as const }
      : walked.find((candidate) => candidate.relative === relative)
    if (entry === undefined) throw new Error(`Frontier tree walk lost entry ${relative}`)
    const cached = memo.get(relative)
    if (cached !== undefined) return cached
    const single = createHash('sha256')
    if (entry.kind === 'directory') {
      // Children in canonical UTF-8 order: directories always precede their
      // descendants in the pre-order walk, so every child is already walked.
      const children = walked
        .filter((candidate) => (path.dirname(candidate.relative) === '.' ? '' : path.dirname(candidate.relative)) === relative)
        .map((candidate) => candidate.relative)
      const ordered = children.sort((left, right) => Buffer.compare(Buffer.from(path.basename(left), 'utf8'), Buffer.from(path.basename(right), 'utf8')))
      single.update('directory\0')
      for (const child of ordered) {
        single.update(path.basename(child)).update('\0').update(await compute(child))
      }
    } else if (entry.kind === 'symlink') {
      single.update('symlink\0').update(entry.linkText ?? await readlink(path.join(root, relative)))
    } else if (entry.kind === 'file') {
      single.update('file\0').update(await readFile(path.join(root, relative)))
    } else {
      throw new Error(`Frontier tree contains a non-regular entry at ${relative}`)
    }
    const digest = single.digest('hex')
    memo.set(relative, digest)
    return digest
  }
  return await compute('')
}

/**
 * Classify one relative tree path against the trusted expectation. The
 * frontier level is exactly the leaf set plus the directories their paths
 * imply; only the interior of a `skill` leaf (a managed directory) may carry
 * arbitrary file/directory content, and nothing may be unplanned.
 */
function frontierTreePathClass (expectation: FallbackFrontierTreeExpectation, relative: string): 'leaf' | 'directory' | 'skill-interior' | 'unplanned' {
  if (expectation.leafKinds.has(relative)) return 'leaf'
  // A directory skill leaf exactly at the frontier root makes the entire
  // published tree that skill's managed content.
  if (relative !== '' && expectation.leafKinds.get('') === 'directory') return 'skill-interior'
  if (expectation.directories.includes(relative)) return 'directory'
  for (const [leafRelative, leafKind] of expectation.leafKinds) {
    if ((leafKind === 'directory' || (Array.isArray(leafKind) && leafKind.includes('directory'))) && relative.startsWith(`${leafRelative}${path.sep}`)) return 'skill-interior'
  }
  return 'unplanned'
}

/**
 * Validate a frontier-rooted tree (the private staged subtree at registration
 * time, or the live published tree at proof time) against the trusted
 * expectation, and return the registered plan evidence from the staged side:
 * exact leaf kinds, per-leaf digests, and link texts. Any unplanned content,
 * kind mismatch, forbidden symlink, wrong link text, or missing leaf fails
 * closed without touching anything.
 */
async function assertStagedFrontierTree (root: string, expectation: FallbackFrontierTreeExpectation): Promise<Omit<FallbackFrontierStagePlan, 'activeConditionalLeafIds'>> {
  const leafKinds = new Map<string, 'file' | 'directory' | 'symlink'>()
  const leafDigests = new Map<string, string>()
  const linkTexts = new Map<string, string>()
  for (const entry of await walkFrontierTree(root)) {
    const pathClass = frontierTreePathClass(expectation, entry.relative)
    if (entry.kind === 'other') throw new Error(`Frontier tree contains a non-regular entry at ${entry.relative}`)
    if (pathClass === 'unplanned') throw new Error(`Frontier tree contains unplanned content at ${entry.relative}`)
    if (pathClass === 'leaf') {
      const expectedKind = expectation.leafKinds.get(entry.relative)
      const kindOk = Array.isArray(expectedKind) ? expectedKind.includes(entry.kind) : entry.kind === expectedKind
      if (!kindOk) throw new Error(`Frontier leaf ${entry.relative} is ${entry.kind}, expected ${Array.isArray(expectedKind) ? expectedKind.join(' or ') : expectedKind}`)
      leafKinds.set(entry.relative, entry.kind)
      if (entry.kind === 'symlink') {
        const expectedText = expectation.linkTargets.get(entry.relative)
        if (expectedText === undefined || entry.linkText !== expectedText) {
          throw new Error(`Frontier link ${entry.relative} does not reference the planned final skill path`)
        }
        linkTexts.set(entry.relative, entry.linkText!)
      }
      const digest = entry.kind === 'directory' ? undefined : await pathDigest(path.join(root, entry.relative))
      if (entry.kind !== 'directory' && !digest) throw new Error(`Cannot digest frontier leaf ${entry.relative}`)
      if (digest !== undefined) leafDigests.set(entry.relative, digest)
      continue
    }
    // Ancestor directory or skill-leaf interior: links are forbidden anywhere
    // outside an exact managed link leaf.
    if (entry.kind === 'symlink') throw new Error(`Frontier tree contains a symlink at ${entry.relative}; only managed link leaves may be symlinks`)
  }
  for (const relative of expectation.leafKinds.keys()) {
    // The root itself (a skill leaf equal to the frontier root) is verified
    // as a real non-link directory by the caller.
    if (relative === '') continue
    if (!leafKinds.has(relative)) throw new Error(`Frontier tree is missing planned leaf ${relative}`)
  }
  return { leafKinds, leafDigests, linkTexts }
}

/**
 * PRIVATE process-local registry of registered bundle-skill payload digests,
 * scoped by transaction id and keyed by the resolved FINAL skill destination
 * path. It is populated only after a genuine journal CAS succeeds, only for
 * bundle `skill:<name>` destinations resolved from trusted manifest evidence
 * (never caller input), and only for bounded real symlink-free staged
 * directories digested with the canonical tree framing. The registry is
 * never serialized, never exported, and survives stage cleanup so copied-link
 * validation can always prove against the exact registered skill bytes.
 */
interface RegisteredSkillBinding {
  readonly skillName: string
  readonly digest: string
}

const registeredSkillDigests = new Map<string, Map<string, RegisteredSkillBinding>>()

function skillRegistryFor (transactionId: string): Map<string, RegisteredSkillBinding> {
  let map = registeredSkillDigests.get(transactionId)
  if (map === undefined) {
    map = new Map()
    registeredSkillDigests.set(transactionId, map)
  }
  return map
}

/**
 * The bundle-skill destination matching `resolved`, derived ONLY from trusted
 * manifest evidence; undefined for every non-skill registration target.
 */
function bundleSkillDestinationOf (manifest: FallbackTransactionIdentity, resolved: string): { readonly skillName: string } | undefined {
  // `approvedDestinationRoots` is trusted protocol-v3 planning evidence. The
  // first root is always the shared bundle-skill destination; later roots are
  // harness link destinations. A bundle destination must be its direct child,
  // so a link payload can never be mistaken for a skill merely by basename.
  const skillRoot = manifest.approvedDestinationRoots[0]
  if (typeof skillRoot !== 'string' || !isCanonicalPath(skillRoot)) return undefined
  if (path.dirname(resolved) !== path.resolve(skillRoot)) return undefined
  const matched = (manifest.bundleDestinations ?? []).some((entry) => path.resolve(entry.path) === resolved)
  return matched ? { skillName: path.basename(resolved) } : undefined
}

/**
 * Digest one registered skill payload directory with the canonical tree
 * framing after proving it is a bounded real directory containing no symlinks
 * or special files anywhere inside. Digests are computed BEFORE the journal
 * CAS so a binding failure aborts the registration cleanly.
 */
async function digestRegisteredSkillPayload (finalSkillPath: string, payloadDirectory: string): Promise<string> {
  for (const entry of await walkFrontierTree(payloadDirectory)) {
    if (entry.kind === 'symlink') throw new Error(`Registered skill payload for ${finalSkillPath} contains a symlink at ${entry.relative}`)
    if (entry.kind === 'other') throw new Error(`Registered skill payload for ${finalSkillPath} contains a non-regular entry at ${entry.relative}`)
  }
  return await boundedFrontierTreeDigest(payloadDirectory)
}

/**
 * Store one computed skill binding after the journal CAS succeeded. A
 * conflicting re-registration (same final path, different name or bytes)
 * fails closed; an identical re-registration is idempotent.
 */
function assertRegisteredSkillBindingAvailable (handle: FallbackJournalHandle, finalSkillPath: string, binding: RegisteredSkillBinding): void {
  const previous = skillRegistryFor(handle.transactionId).get(finalSkillPath)
  if (previous !== undefined && (previous.skillName !== binding.skillName || previous.digest !== binding.digest)) {
    throw new Error(`Conflicting re-registration of skill payload ${finalSkillPath}`)
  }
}

function storeRegisteredSkillBinding (handle: FallbackJournalHandle, finalSkillPath: string, binding: RegisteredSkillBinding): void {
  assertRegisteredSkillBindingAvailable(handle, finalSkillPath, binding)
  skillRegistryFor(handle.transactionId).set(finalSkillPath, Object.freeze({ skillName: binding.skillName, digest: binding.digest }))
}

/**
 * Process-local retained proof of copied links THIS process published: the
 * frozen binding survives a physically verified apply so same-process
 * restore verifies the bytes it is about to quarantine-rename against what
 * this process actually published — never against disk journal fields alone.
 * Never serialized, never authority-granting: absence keeps the existing
 * quarantine-preserve restore behavior (e.g. an external child publisher).
 */
const appliedCopiedLinkBindings = new Map<string, Map<string, Readonly<FrozenCopiedLinkBinding>>>()

function retainAppliedCopiedLinkBinding (handle: FallbackJournalHandle, resolved: string, binding: Readonly<FrozenCopiedLinkBinding>): void {
  let map = appliedCopiedLinkBindings.get(handle.transactionId)
  if (map === undefined) {
    map = new Map()
    appliedCopiedLinkBindings.set(handle.transactionId, map)
  }
  map.set(resolved, binding)
}

function retainedAppliedCopiedLinkBinding (handle: FallbackJournalHandle, resolved: string): Readonly<FrozenCopiedLinkBinding> | undefined {
  return appliedCopiedLinkBindings.get(handle.transactionId)?.get(resolved)
}

/** Boolean proof wrappers for restore gates: any mismatch preserves everything. */
async function livePathMatchesRetainedCopiedLinkBinding (resolved: string, binding: Readonly<FrozenCopiedLinkBinding>): Promise<boolean> {
  try {
    await assertPathMatchesCopiedLinkBinding(`Published copied link ${resolved}`, resolved, binding)
    return true
  } catch {
    return false
  }
}

async function movedPathMatchesRetainedCopiedLinkBinding (movedPath: string, originalLivePath: string, binding: Readonly<FrozenCopiedLinkBinding>): Promise<boolean> {
  try {
    await assertPathMatchesCopiedLinkBinding(`Quarantined copied link ${movedPath}`, movedPath, binding, { resolveFrom: path.dirname(originalLivePath) })
    return true
  } catch {
    return false
  }
}

/**
 * The trusted harness link destination root: the second approved destination
 * root, or undefined when the harness has no separate link root. A root equal
 * to the skill destination is never treated as a link root.
 */
function trustedLinkRootOf (manifest: FallbackTransactionIdentity): string | undefined {
  const skillRoot = manifest.approvedDestinationRoots[0]
  const linkRoot = manifest.approvedDestinationRoots[1]
  if (typeof linkRoot !== 'string' || !isCanonicalPath(linkRoot)) return undefined
  const resolvedLink = path.resolve(linkRoot)
  if (typeof skillRoot === 'string' && resolvedLink === path.resolve(skillRoot)) return undefined
  return resolvedLink
}

/** The trusted final skill destination for one link-root child: skill root + exact basename. */
function trustedFinalSkillPathOf (manifest: FallbackTransactionIdentity, linkPath: string): string | undefined {
  const skillRoot = manifest.approvedDestinationRoots[0]
  if (typeof skillRoot !== 'string' || !isCanonicalPath(skillRoot)) return undefined
  return path.join(path.resolve(skillRoot), path.basename(linkPath))
}

/**
 * One frozen private copied-link binding proven at stage registration: the
 * concrete materialization kind, the trusted final skill destination it was
 * proven against, and — for a directory copy — the bounded symlink-free
 * digest accepted against the registered skill payload, or — for a symlink —
 * the exact link text. Later apply/rollback checks prove against this record
 * alone, never against the registry or mutable live skill bytes.
 */
interface FrozenCopiedLinkBinding {
  readonly kind: 'directory' | 'symlink'
  readonly finalSkillPath: string
  readonly digest?: string
  readonly linkText?: string
}

function freezeCopiedLinkBinding (binding: FrozenCopiedLinkBinding): Readonly<FrozenCopiedLinkBinding> {
  return Object.freeze({ ...binding })
}

/**
 * Prove one concrete staged, published, or quarantined path against its
 * frozen copied-link binding. A directory copy must remain a bounded real
 * symlink-free directory whose digest equals the frozen record; a symlink
 * must still carry the exact frozen link text resolving to the frozen final
 * skill destination from the checked location. Any other kind or mismatch
 * fails closed.
 */
async function assertPathMatchesCopiedLinkBinding (label: string, targetPath: string, binding: Readonly<FrozenCopiedLinkBinding>, options: { resolve?: boolean, resolveFrom?: string } = {}): Promise<void> {
  const kind = await pathKind(targetPath)
  if (binding.kind === 'directory') {
    if (kind !== 'directory') throw new Error(`${label} is ${kind}; its frozen copied-link binding requires a directory`)
    const digest = await digestRegisteredSkillPayload(binding.finalSkillPath, targetPath)
    if (digest !== binding.digest) throw new Error(`${label} does not match its frozen copied-link digest`)
    return
  }
  if (kind !== 'symlink') throw new Error(`${label} is ${kind}; its frozen copied-link binding requires a symlink`)
  const text = await readlink(targetPath)
  if (text !== binding.linkText) throw new Error(`${label} does not match its frozen copied-link target`)
  // Resolution is proven from the LIVE location; a staged copy (whose parent
  // directory differs) may legitimately hold the exact trusted text without
  // resolving from its temporary location, and a MOVED copy (e.g. inside a
  // quarantine container) must resolve the exact text against its ORIGINAL
  // live location instead of the quarantine parent.
  const resolveBase = options.resolveFrom !== undefined ? options.resolveFrom : path.dirname(targetPath)
  if ((options.resolve ?? true) && path.resolve(resolveBase, text) !== binding.finalSkillPath) {
    throw new Error(`${label} does not resolve to its frozen final skill destination`)
  }
}

/**
 * Independent copied-link binding for one link-root child stage. A staged
 * real directory must byte-match the PRIVATE registered skill payload for its
 * trusted final destination (policy must permit directory copies); a staged
 * symlink must reference exactly that destination; every other kind rejects.
 * Non-link targets return undefined. Fails closed when the binding is
 * unavailable — it can never fall back to live or staged-only evidence.
 */
async function assertIndependentLinkStageBinding (
  handle: FallbackJournalHandle,
  resolved: string,
  stagePath: string,
  payloadKind: FallbackPathKind
): Promise<Readonly<FrozenCopiedLinkBinding> | undefined> {
  const linkRoot = trustedLinkRootOf(handle.manifest)
  if (linkRoot === undefined || path.dirname(resolved) !== linkRoot) return undefined
  if (!(handle.manifest.bundleDestinations ?? []).some((entry) => path.resolve(entry.path) === resolved)) return undefined
  const finalSkillPath = trustedFinalSkillPathOf(handle.manifest, resolved)
  if (finalSkillPath === undefined) throw new Error(`Link destination ${resolved} has no trusted final skill destination`)
  if (payloadKind === 'symlink') {
    const text = await readlink(stagePath)
    if (path.resolve(path.dirname(stagePath), text) !== finalSkillPath) {
      throw new Error(`Staged link ${resolved} references ${text} instead of the final skill path ${finalSkillPath}`)
    }
    return freezeCopiedLinkBinding({ kind: 'symlink', finalSkillPath, linkText: text })
  }
  if (payloadKind === 'directory') {
    const policy = fallbackLinkMaterialization(handle.manifest.harness)
    if (!policy.allowedKinds.includes('directory')) {
      throw new Error(`Staged link ${resolved} is a directory but the ${handle.manifest.harness} link policy requires a symlink`)
    }
    const binding = skillRegistryFor(handle.transactionId).get(finalSkillPath)
    if (binding === undefined) throw new Error(`Copied link ${resolved} has no registered skill payload for ${finalSkillPath}`)
    const digest = await digestRegisteredSkillPayload(finalSkillPath, stagePath)
    if (digest !== binding.digest) {
      throw new Error(`Copied link ${resolved} does not match the registered skill payload for ${finalSkillPath}`)
    }
    return freezeCopiedLinkBinding({ kind: 'directory', finalSkillPath, digest })
  }
  throw new Error(`Staged link ${resolved} is ${payloadKind}; only a symlink or a policy-permitted directory copy is supported`)
}

/**
 * Trusted `link:<name>` → final skill destination resolver built ONLY from
 * manifest evidence: first a `skill:<name>` leaf of any planned frontier, then
 * (existing destination case) the unique same-basename bundle destination the
 * planner captured under the harness destination root — the link leaf itself
 * identifies the link-root child, so exactly one candidate must remain.
 * Unknown or ambiguous names return undefined and fail closed downstream.
 */
function trustedSkillDestinationResolver (manifest: FallbackTransactionIdentity): (leaf: FallbackLeafTarget) => string | undefined {
  return (leaf) => {
    if (!leaf.id.startsWith('link:')) return undefined
    const skillName = leaf.id.slice('link:'.length)
    for (const frontier of manifest.plannedMissingFrontiers) {
      for (const candidate of frontier.leaves) {
        if (candidate.id === `skill:${skillName}`) return path.resolve(candidate.path)
      }
    }
    const candidates = (manifest.bundleDestinations ?? [])
      .map((entry) => path.resolve(entry.path))
      .filter((candidate) => path.basename(candidate) === skillName && candidate !== path.resolve(leaf.path))
    return candidates.length === 1 ? candidates[0] : undefined
  }
}

/** Every authenticated destination/source directory that must still be the exact recorded inode for an operation at `relative` to proceed: the root plus all strict ancestors. */
function authenticatedAncestorsOf (relative: string): string[] {
  const segments = relative === '' ? [] : relative.split(path.sep)
  const chain: string[] = ['']
  for (let depth = 1; depth < segments.length; depth++) chain.push(segments.slice(0, depth).join(path.sep))
  return chain
}

interface DirectoryIdentity { dev: number; ino: number }

/**
 * Validate that every directory of the relevant ancestor chain is still a
 * real non-link directory with its exact recorded dev/ino, so a replacement
 * by a symlink can never redirect a write or a digest read outside the
 * authenticated reservation / staged source.
 */
async function assertAuthenticatedDirectoryChain (
  base: string,
  identities: ReadonlyMap<string, DirectoryIdentity>,
  chain: readonly string[],
  fail: (detail: string) => Error,
  label: string
): Promise<void> {
  for (const prefix of chain) {
    const identity = identities.get(prefix)
    const display = prefix === '' ? '<root>' : prefix
    if (identity === undefined) throw fail(`${label} directory ${display} has no recorded authenticated identity`)
    let stats: Stats | undefined
    try {
      stats = await lstat(path.join(base, prefix))
    } catch { /* treated as replacement below */ }
    if (stats === undefined || !stats.isDirectory() || stats.isSymbolicLink() || stats.dev !== identity.dev || stats.ino !== identity.ino) {
      throw fail(`${label} directory ${display} was replaced during publication`)
    }
  }
}

/** One captured real-directory component of a live ancestor chain. */
interface LiveAncestorIdentity { path: string; dev: number; ino: number }

/**
 * Capture the COMPLETE live ancestor chain of `resolved` (every component
 * from dirname(resolved) up to the filesystem root). Every component must be
 * a real non-link directory with an exact dev/ino identity; a missing, link,
 * or non-directory component makes the chain unprovable and the caller must
 * preserve the target untouched. Lexical or realpath containment alone is
 * never sufficient: only captured identities authorize traversal below.
 */
async function captureLiveAncestorChain (resolved: string): Promise<LiveAncestorIdentity[] | undefined> {
  const chain: LiveAncestorIdentity[] = []
  let current = path.dirname(path.resolve(resolved))
  const root = path.parse(current).root
  while (true) {
    let stats: Stats
    try {
      stats = await lstat(current)
    } catch {
      return undefined
    }
    if (!stats.isDirectory() || stats.isSymbolicLink()) return undefined
    chain.push({ path: current, dev: stats.dev, ino: stats.ino })
    if (current === root) return chain
    current = path.dirname(current)
  }
}

/**
 * Recheck every captured ancestor identity immediately before a mutation
 * through the chain: each component must still be the exact recorded real
 * non-link directory. A mid-operation replacement fails closed so no
 * mkdtemp/rename/copy/remove ever traverses a substituted ancestor.
 */
async function liveAncestorChainMatches (chain: readonly LiveAncestorIdentity[]): Promise<boolean> {
  for (const component of chain) {
    let stats: Stats
    try {
      stats = await lstat(component.path)
    } catch {
      return false
    }
    if (!stats.isDirectory() || stats.isSymbolicLink() || stats.dev !== component.dev || stats.ino !== component.ino) return false
  }
  return true
}

/**
 * Deterministic exclusive population sequence derived from the staged
 * subtree: pre-order UTF-8 (parents before descendants), each op created
 * exclusively at apply time. Every op is classified against the trusted
 * expectation again here, so stage tampering between registration and apply
 * can never add unplanned live paths. The staged ancestor-directory
 * identities observed now are the source-side chain authority for apply.
 */
async function buildFrontierPopulationOps (staged: string, expectation: FallbackFrontierTreeExpectation): Promise<{ ops: Array<{ relative: string; kind: 'mkdir' | 'file' | 'symlink'; source: string }>; sourceDirectories: Map<string, DirectoryIdentity> }> {
  const ops: Array<{ relative: string; kind: 'mkdir' | 'file' | 'symlink'; source: string }> = []
  const sourceDirectories = new Map<string, DirectoryIdentity>([['', await lstat(staged).then((stats) => ({ dev: stats.dev, ino: stats.ino }))]])
  for (const entry of await walkFrontierTree(staged)) {
    if (entry.kind === 'other') throw new Error(`Staged frontier tree contains a non-regular entry at ${entry.relative}`)
    if (frontierTreePathClass(expectation, entry.relative) === 'unplanned') throw new Error(`Staged frontier tree contains unplanned content at ${entry.relative}`)
    const source = path.join(staged, entry.relative)
    if (entry.kind === 'directory') {
      ops.push({ relative: entry.relative, kind: 'mkdir', source })
      sourceDirectories.set(entry.relative, { dev: entry.dev!, ino: entry.ino! })
    } else if (entry.kind === 'file') ops.push({ relative: entry.relative, kind: 'file', source })
    else ops.push({ relative: entry.relative, kind: 'symlink', source })
  }
  return { ops, sourceDirectories }
}

/** Cheap anchor identity recheck: real non-link directory with the recorded dev/ino (decimal-string framing). */
async function anchorIdentityMatches (anchor: FallbackAnchorIdentity): Promise<boolean> {
  try {
    const stats = await lstat(anchor.path, { bigint: true }) as BigIntStats
    return stats.isDirectory() && !stats.isSymbolicLink() &&
      stats.dev.toString(10) === anchor.device && stats.ino.toString(10) === anchor.inode
  } catch {
    return false
  }
}

/**
 * Register a complete staged frontier subtree as the publication payload for
 * one planned-missing journal frontier. The staged tree is validated exactly
 * against the trusted manifest frontier (leaf kinds, link texts, no unplanned
 * content, no symlinks outside managed link leaves), copied into an owned
 * stage container next to the frontier's anchor, digested, and durably bound
 * to the journal entry. Only an exact plannedMissingFrontiers path may be
 * registered: the child can never invent a frontier.
 *
 * The active conditional leaf selection is fixed at registration: every
 * required leaf is always active, and only explicitly named conditional leaf
 * IDs (validated by the pure frontier helper) may be materialized. The
 * selection is stored as a sorted frozen copy in the process-local stage plan
 * and publication authority; apply and rollback rederive their proofs from
 * that immutable selection, never from journal fields or caller-mutated
 * arrays. No disk field grants selection authority.
 */
export async function registerFallbackFrontierStage (
  handle: FallbackJournalHandle,
  frontierPath: string,
  stagedCompleteDirectory: string,
  options: { activeConditionalLeafIds?: readonly string[] } = {}
): Promise<FallbackJournalHandle> {
  const activeConditionalLeafIds = Object.freeze([...(options.activeConditionalLeafIds ?? [])].sort(compareUtf8))
  const journal = await reloadFallbackJournal(handle)
  requireRole(journal, handle, 'mutator')
  const resolved = path.resolve(frontierPath)
  const frontier = handle.manifest.plannedMissingFrontiers.find((candidate) => path.resolve(candidate.frontierPath) === resolved)
  if (frontier === undefined) throw new Error(`No planned fallback frontier for ${resolved}`)
  const entry = journal.entries.find((candidate) => path.resolve(candidate.path) === resolved)
  if (!entry) throw new Error(`No fallback journal entry for ${resolved}`)
  if (entry.existed || entry.kind !== 'missing') throw new Error(`Fallback frontier entry for ${resolved} is not a planned-missing publication unit`)
  if (entry.stage !== undefined || entry.stageDigest !== undefined || entry.applied === true) {
    throw new Error(`Fallback frontier ${resolved} already has a registered stage`)
  }
  const staged = path.resolve(stagedCompleteDirectory)
  if (!isCanonicalPath(staged)) throw new Error(`Staged frontier tree ${staged} must be an absolute canonical path`)
  if (await pathKind(staged) !== 'directory') throw new Error(`Staged frontier tree ${staged} must be a real directory`)
  const activeLeaves = selectActiveFallbackFrontierLeaves(frontier, activeConditionalLeafIds)
  const expectation = deriveFrontierTreeExpectation(
    { ...frontier, leaves: [...activeLeaves] },
    handle.manifest.plannedMissingFrontiers.flatMap((candidate) => candidate.leaves),
    { skillDestinationResolver: trustedSkillDestinationResolver(handle.manifest), linkPolicy: fallbackLinkMaterialization(handle.manifest.harness) }
  )
  const plan = await assertStagedFrontierTree(staged, expectation)
  const stageDirectory = await mkdtemp(path.join(path.dirname(resolved), `.${path.basename(resolved).replace(/^\.+/, '')}.nsolid-stage-`))
  // Authenticated cleanup authority is captured IMMEDIATELY after allocation:
  // the catch path never blind-rm's, it proves this exact inode (plus marker
  // and recorded children) before any destruction and preserves otherwise.
  const stageIdentity = await lstat(stageDirectory)
  const containerAllocated = true
  const stagePath = path.join(stageDirectory, 'payload')
  let stageDigest: string | undefined
  let payloadKind: FallbackPathKind | undefined
  let token: string | undefined
  let children = new Map<string, FallbackPathKind>()
  try {
    await cp(staged, stagePath, { recursive: true, force: true, verbatimSymlinks: true, dereference: false })
    stageDigest = await pathDigest(stagePath)
    if (!stageDigest) throw new Error(`Cannot digest staged frontier payload for ${resolved}`)
    if (stageDigest !== await pathDigest(staged)) throw new Error(`Staged frontier copy for ${resolved} does not match its source`)
    payloadKind = await pathKind(stagePath)
    token = randomUUID()
    await writeFile(path.join(stageDirectory, `.nsolid-stage-${token}`), token, { mode: 0o600 })
    children = new Map([['payload', payloadKind], [`.nsolid-stage-${token}`, 'file']])
    // Frontier copied-link bindings: an active link leaf staged as a real
    // directory must byte-match the PRIVATE registered skill payload for its
    // trusted final destination (policy must permit directory copies); a
    // symlink leaf freezes its exact proven link text. Every binding is
    // frozen into the stage capability so publication and any authorized
    // same-process rollback prove against these records alone — never against
    // the registry or the mutable live skill bytes. Validation happens BEFORE
    // the durable CAS so a failure aborts this registration and cleans its
    // container.
    const frontierLinkPolicy = fallbackLinkMaterialization(handle.manifest.harness)
    const copiedLinkBindings: Record<string, Readonly<FrozenCopiedLinkBinding>> = {}
    for (const leaf of activeLeaves) {
      if (leaf.role !== 'link') continue
      const relative = path.relative(resolved, path.resolve(leaf.path))
      const finalSkillPath = trustedSkillDestinationResolver(handle.manifest)(leaf)
      if (finalSkillPath === undefined) throw new Error(`Link leaf ${leaf.id} has no trusted final skill destination`)
      const leafKind = plan.leafKinds.get(relative)
      if (leafKind === 'symlink') {
        const linkText = plan.linkTexts.get(relative)
        if (linkText === undefined) throw new Error(`Link leaf ${leaf.id} has no proven link text`)
        copiedLinkBindings[relative] = freezeCopiedLinkBinding({ kind: 'symlink', finalSkillPath, linkText })
        continue
      }
      if (leafKind !== 'directory') {
        throw new Error(`Frontier link leaf ${leaf.path} is staged as ${leafKind ?? 'an unregistered kind'}; only a symlink or a policy-permitted directory copy is supported`)
      }
      if (!frontierLinkPolicy.allowedKinds.includes('directory')) {
        throw new Error(`Frontier link leaf ${leaf.path} is a directory but the ${handle.manifest.harness} link policy requires a symlink`)
      }
      const binding = skillRegistryFor(handle.transactionId).get(finalSkillPath)
      if (binding === undefined) throw new Error(`Copied frontier link ${leaf.path} has no registered skill payload for ${finalSkillPath}`)
      const linkPayload = relative === '' ? stagePath : path.join(stagePath, relative)
      const digest = await digestRegisteredSkillPayload(finalSkillPath, linkPayload)
      if (digest !== binding.digest) {
        throw new Error(`Copied frontier link ${leaf.path} does not match the registered skill payload for ${finalSkillPath}`)
      }
      copiedLinkBindings[relative] = freezeCopiedLinkBinding({ kind: 'directory', finalSkillPath, digest })
    }
    const frozenCopiedLinkBindings = Object.keys(copiedLinkBindings).length > 0
      ? (Object.freeze({ ...copiedLinkBindings }) as Readonly<Record<string, Readonly<FrozenCopiedLinkBinding>>>)
      : undefined
    capabilitiesFor(handle).set(resolved, {
      container: stageDirectory,
      payload: stagePath,
      token,
      role: 'stage',
      dev: stageIdentity.dev,
      ino: stageIdentity.ino,
      stageDigest,
      children,
      copiedLinkBindings: frozenCopiedLinkBindings,
    })
    frontierPlanFor(handle.transactionId).set(resolved, { ...plan, activeConditionalLeafIds })
    if (fallbackFrontierPublicationSeam !== undefined) {
      await fallbackFrontierPublicationSeam({ phase: 'stage-ready', frontierPath: resolved })
    }
    // Bind every active bundle skill within this registered frontier payload
    // to its own staged directory bytes. The final path is derived from the
    // trusted skill leaf; a link or MCP subtree cannot acquire this authority.
    const skillBindings = await Promise.all(activeLeaves
      .filter((leaf) => leaf.id.startsWith('skill:'))
      .map(async (leaf) => {
        const finalSkillPath = path.resolve(leaf.path)
        const destination = bundleSkillDestinationOf(handle.manifest, finalSkillPath)
        if (destination === undefined) return undefined
        const relative = path.relative(resolved, finalSkillPath)
        if (relative.startsWith('..') || path.isAbsolute(relative)) {
          throw new Error(`Registered skill ${finalSkillPath} is outside frontier ${resolved}`)
        }
        const payload = relative === '' ? stagePath : path.join(stagePath, relative)
        return {
          finalSkillPath,
          skillName: destination.skillName,
          digest: await digestRegisteredSkillPayload(finalSkillPath, payload),
        }
      }))
    for (const binding of skillBindings) {
      if (binding !== undefined) assertRegisteredSkillBindingAvailable(handle, binding.finalSkillPath, binding)
    }
    const revision = await casWrite(handle.journalPath, {
      ...journal,
      entries: journal.entries.map((candidate) => candidate === entry
        ? { ...candidate, stage: stagePath, stageDigest, applied: false }
        : candidate),
    }, journal)
    for (const binding of skillBindings) {
      if (binding !== undefined) storeRegisteredSkillBinding(handle, binding.finalSkillPath, binding)
    }
    const registered = { ...handle, revision }
    issueGenuineHandle(registered)
    return registered
  } catch (error) {
    // Authenticated cleanup of this invocation's own container ONLY: identity,
    // marker, and recorded children must prove out, otherwise the container is
    // preserved (it stays a registered capability) and reported in the error.
    const capability = capabilitiesFor(handle).get(resolved)
    frontierPlanFor(handle.transactionId).delete(resolved)
    let removed = false
    if (capability !== undefined && token !== undefined) {
      removed = await removeAuthenticatedContainer(capability).catch(() => false)
    }
    if (removed) capabilitiesFor(handle).delete(resolved)
    const preserved = containerAllocated && !removed ? ` The stage container was preserved at ${stageDirectory} for inspection.` : ''
    throw new Error(`${(error as Error).message}.${preserved}`, { cause: error })
  }
}

/**
 * Publish one planned-missing frontier through its process-local capability:
 * exclusive non-recursive `mkdir` reservation (an existing destination — even
 * a byte-identical one — is a collision and is never adopted or replaced),
 * immediate dev/ino identity capture, exclusive population of only that
 * reserved directory (non-recursive mkdir, COPYFILE_EXCL, non-replacing
 * symlink; `rename(stage, target)` is never used), and a final proof of
 * reserved identity, exact structure, and full digest equality with the
 * registered complete stage. Only then is the entry marked applied and the
 * process-local publication state completed.
 *
 * Any failure after reservation PRESERVES the live (possibly partial)
 * frontier and the authenticated stage artifacts: nothing is removed or
 * quarantined, the journal stays pending, and a stable
 * FALLBACK_FRONTIER_PUBLICATION_INCOMPLETE failure is raised. Partial
 * visibility during population is the accepted Pure-Node contract.
 */
async function applyFrontierPublication (
  handle: FallbackJournalHandle,
  journal: FallbackJournal,
  entry: FallbackJournalEntry,
  frontier: FallbackFrontierEvidence,
  resolved: string,
  stageCapability: ArtifactCapability
): Promise<FallbackJournalHandle> {
  const fail = (detail: string): Error => new Error(`FALLBACK_FRONTIER_PUBLICATION_INCOMPLETE: ${detail}`)
  // ---- Pre-reservation revalidation: failures leave zero live changes ----
  if (entry.stage !== stageCapability.payload || stageCapability.payload === undefined) {
    throw new Error(`Fallback journal stage for ${resolved} does not match the registered capability`)
  }
  if (entry.stageDigest === undefined) throw fail('the registered stage carries no digest')
  if (completedFrontierPublications.get(handle.transactionId)?.has(resolved)) throw fail('the frontier was already published by this transaction')
  // The capability retains the immutable registered complete digest: the disk
  // journal field AND the actual payload must both match it, so simultaneous
  // payload + disk-journal digest tampering still fails before any live
  // mutation.
  const registeredDigest = stageCapability.stageDigest
  if (registeredDigest === undefined || entry.stageDigest !== registeredDigest) {
    throw fail('the journal stage digest does not match the registered capability digest')
  }
  // The staged payload is attacker-mutable between registration and apply:
  // enforce the structural bounds FIRST with a single bounded walk that also
  // digests the tree (never a second, unbounded traversal) so oversized,
  // deep, too-many, or too-long tamper fails closed before any unbounded
  // read and before live reservation/mutation.
  const stageDigest = await boundedFrontierTreeDigest(stageCapability.payload)
  if (!stageDigest || stageDigest !== registeredDigest) {
    throw new Error(`Staged frontier payload for ${resolved} no longer matches its registered digest`)
  }
  // Copied-link staged sources must still satisfy the bindings frozen at
  // registration BEFORE the frontier is reserved: symlink texts compare
  // exactly (the temporary staged parent cannot resolve relative texts),
  // directory copies re-digest against the frozen records alone.
  if (stageCapability.copiedLinkBindings !== undefined) {
    for (const [relative, binding] of Object.entries(stageCapability.copiedLinkBindings)) {
      await assertPathMatchesCopiedLinkBinding(`Staged frontier copied link ${resolved}/${relative}`, path.join(stageCapability.payload, relative), binding, { resolve: false })
    }
  }
  if (await pathKind(resolved) !== 'missing') {
    // Any existing destination — pre-existing or raced into the window — is a
    // collision with the planned-missing state: never adopted, never replaced,
    // even byte-identical.
    throw new Error(`FALLBACK_FRONTIER_COLLISION: ${resolved} is not missing; the existing destination is preserved untouched`)
  }
  // The trusted evidence must hold right now: anchor identity and component
  // chain, still-missing frontier path, exact recorded leaf graph.
  await revalidateFallbackFrontierEvidence([frontier], fallbackLinkMaterialization(handle.manifest.harness))
  const plan = frontierPlanFor(handle.transactionId).get(resolved)
  if (plan === undefined) throw fail('no registered frontier stage plan exists in this process')
  // The expectation is rederived from the IMMUTABLE process-local selection
  // fixed at registration: required leaves plus the frozen authorized
  // conditional set. Journal fields and caller-mutated arrays can never
  // widen it.
  const expectation = deriveFrontierTreeExpectation(
    { ...frontier, leaves: [...frontier.leaves.filter((leaf) => leaf.activation === 'required' || plan.activeConditionalLeafIds.includes(leaf.id))] },
    handle.manifest.plannedMissingFrontiers.flatMap((candidate) => candidate.leaves),
    { skillDestinationResolver: trustedSkillDestinationResolver(handle.manifest), linkPolicy: fallbackLinkMaterialization(handle.manifest.harness) }
  )
  const { ops, sourceDirectories } = await buildFrontierPopulationOps(stageCapability.payload, expectation)
  const destinationIdentities = new Map<string, DirectoryIdentity>()

  // ---- Reservation: exclusive, non-recursive, never replacing ----
  if (fallbackFrontierPublicationSeam !== undefined) await fallbackFrontierPublicationSeam({ phase: 'before-reserve', frontierPath: resolved })
  try {
    await mkdir(resolved, { recursive: false })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`FALLBACK_FRONTIER_COLLISION: ${resolved} appeared before publication; the existing destination is preserved untouched`, { cause: error })
    }
    throw fail(`the frontier directory could not be reserved: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`)
  }

  try {
    // ---- Reserved identity observation with an immediate recheck window ----
    const observe = async (): Promise<{ dev: number; ino: number }> => {
      const stats = await lstat(resolved)
      if (!stats.isDirectory() || stats.isSymbolicLink()) throw fail('the reserved frontier path is not a real directory')
      return { dev: stats.dev, ino: stats.ino }
    }
    const reserved = await observe()
    destinationIdentities.set('', { dev: reserved.dev, ino: reserved.ino })
    if (fallbackFrontierPublicationSeam !== undefined) await fallbackFrontierPublicationSeam({ phase: 'reserved-identity', frontierPath: resolved })
    const reobserved = await observe()
    if (reobserved.dev !== reserved.dev || reobserved.ino !== reserved.ino) {
      throw fail('the reserved frontier directory was replaced between reservation and identity observation')
    }

    // ---- Exclusive population of the reserved directory only ----
    for (const op of ops) {
      if (fallbackFrontierPublicationSeam !== undefined) {
        await fallbackFrontierPublicationSeam({ phase: 'before-leaf', frontierPath: resolved, leaf: op.relative })
      }
      // Recheck anchor and reserved identities, then the complete relevant
      // destination AND staged source ancestor chains (exact recorded
      // dev/ino, real non-link directories), so a replacement by a symlink
      // can never redirect writes or digest reads outside the reservation.
      if (!await anchorIdentityMatches(frontier.anchor)) throw fail(`the anchor drifted during population at ${op.relative}`)
      const current = await observe()
      if (current.dev !== reserved.dev || current.ino !== reserved.ino) {
        throw fail(`the reserved frontier directory was replaced during population at ${op.relative}`)
      }
      await assertAuthenticatedDirectoryChain(resolved, destinationIdentities, authenticatedAncestorsOf(op.relative), fail, 'destination')
      await assertAuthenticatedDirectoryChain(stageCapability.payload!, sourceDirectories, authenticatedAncestorsOf(op.relative), fail, 'staged source')
      const livePath = path.join(resolved, op.relative)
      if (op.kind === 'mkdir') {
        await mkdir(livePath, { recursive: false }).catch((error: NodeJS.ErrnoException) => {
          throw fail(`exclusive directory creation failed at ${op.relative}: ${error.code ?? error.message}`)
        })
        const created = await lstat(livePath)
        destinationIdentities.set(op.relative, { dev: created.dev, ino: created.ino })
        continue
      }
      if (op.kind === 'file') {
        if (await pathKind(op.source) !== 'file') throw fail(`staged source for ${op.relative} is no longer a regular file`)
        if (plan.leafKinds.get(op.relative) === 'file' && plan.leafDigests.get(op.relative) !== await pathDigest(op.source)) {
          throw fail(`staged source for ${op.relative} no longer matches its registered digest`)
        }
        await copyFile(op.source, livePath, fsPromisesConstants.COPYFILE_EXCL).catch((error: NodeJS.ErrnoException) => {
          throw fail(`exclusive file creation failed at ${op.relative}: ${error.code ?? error.message}`)
        })
        continue
      }
      // Symlink: only a managed link leaf, re-verified against the registered
      // final skill path without dereferencing anything.
      const expectedText = plan.linkTexts.get(op.relative)
      const stagedText = await readlink(op.source).catch(() => undefined)
      if (expectedText === undefined || stagedText !== expectedText) {
        throw fail(`staged link source for ${op.relative} does not reference the planned final skill path`)
      }
      await symlink(expectedText, livePath).catch((error: NodeJS.ErrnoException) => {
        throw fail(`exclusive link creation failed at ${op.relative}: ${error.code ?? error.message}`)
      })
    }

    // ---- Post-population proof: every created destination directory still
    // holds its exact authenticated identity, then exact structure and full
    // digest equality with the registered complete stage. ----
    if (fallbackFrontierPublicationSeam !== undefined) await fallbackFrontierPublicationSeam({ phase: 'post-population', frontierPath: resolved })
    for (const prefix of destinationIdentities.keys()) {
      await assertAuthenticatedDirectoryChain(resolved, destinationIdentities, [prefix], fail, 'published')
    }
    const published = await observe()
    if (published.dev !== reserved.dev || published.ino !== reserved.ino) throw fail('the published frontier directory was replaced after population')
    await assertStagedFrontierTree(resolved, expectation)
    const publishedDigest = await pathDigest(resolved)
    if (!publishedDigest || publishedDigest !== stageDigest) throw fail('the published frontier digest does not match the registered complete stage digest')
    if (!await anchorIdentityMatches(frontier.anchor)) throw fail('the anchor drifted after population')
    // Published copied links must satisfy the frozen bindings from their LIVE
    // location: kind, digest/link text, and final-skill resolution.
    if (stageCapability.copiedLinkBindings !== undefined) {
      for (const [relative, binding] of Object.entries(stageCapability.copiedLinkBindings)) {
        await assertPathMatchesCopiedLinkBinding(`Published frontier copied link ${resolved}/${relative}`, path.join(resolved, relative), binding)
      }
    }

    // ---- Durable completion: once this CAS succeeds the publication IS
    // complete — later bookkeeping/cleanup failures never turn it into an
    // incomplete publication and never promise pending/stage preservation.
    // The proof of this physically verified publication is retained BEFORE
    // the CAS: even if the CAS fails, this process keeps what it published
    // (cleanupPending) for reporting and future authorized rollback. The
    // record never grants authority — rollback still requires the journal's
    // applied state — and a retry now reports 'already published' instead
    // of colliding with the live tree. ----
    let publications = completedFrontierPublications.get(handle.transactionId)
    if (publications === undefined) {
      publications = new Map()
      completedFrontierPublications.set(handle.transactionId, publications)
    }
    publications.set(resolved, Object.freeze({ frontierPath: resolved, dev: reserved.dev, ino: reserved.ino, stageDigest, cleanupPending: true, activeConditionalLeafIds: plan.activeConditionalLeafIds, copiedLinkBindings: stageCapability.copiedLinkBindings !== undefined ? Object.freeze({ ...stageCapability.copiedLinkBindings }) : undefined }))
    const applied = await withCasWrite(handle, {
      ...journal,
      entries: journal.entries.map((candidate) => path.resolve(candidate.path) === resolved
        ? { ...candidate, applied: true }
        : candidate),
    }, journal)
    const active = { ...handle, revision: applied.revision }
    // ---- Post-publication bookkeeping: fail-closed preservation reported as
    // cleanup-pending; never a publication failure. The cleanup outcome is
    // decided once and frozen into the record independently of whether the
    // bookkeeping CAS below succeeds. ----
    const stageRemoved = await removeAuthenticatedContainer(stageCapability).catch(() => false)
    const preservedArtifacts = [...(applied.preservedArtifacts ?? [])]
    publications.set(resolved, Object.freeze({ frontierPath: resolved, dev: reserved.dev, ino: reserved.ino, stageDigest, cleanupPending: !stageRemoved, activeConditionalLeafIds: plan.activeConditionalLeafIds, copiedLinkBindings: stageCapability.copiedLinkBindings !== undefined ? Object.freeze({ ...stageCapability.copiedLinkBindings }) : undefined }))
    if (stageRemoved) {
      capabilitiesFor(active).delete(resolved)
    } else {
      // Cleanup is fail-closed preservation; the capability stays registered
      // so later commit/restore cleanup can still authenticate against it.
      preservedArtifacts.push(stageCapability.container)
    }
    try {
      if (fallbackFrontierPublicationSeam !== undefined) await fallbackFrontierPublicationSeam({ phase: 'after-applied', frontierPath: resolved })
      const next = await withCasWrite(active, {
        ...applied,
        preservedArtifacts: dedupePaths(preservedArtifacts),
        entries: applied.entries.map((candidate) => path.resolve(candidate.path) === resolved
          ? (stageRemoved ? { ...candidate, stage: undefined } : candidate)
          : candidate),
      }, applied)
      const completed = { ...active, revision: next.revision }
      issueGenuineHandle(completed)
      return completed
    } catch {
      // The journal already durably records applied:true (with the stage still
      // recorded when cleanup failed): an accurate completed-but-cleanup-
      // pending state without granting any disk authority. The in-memory
      // record reports it and stays frozen to callers.
      frontierPlanFor(handle.transactionId).delete(resolved)
      const record = publications.get(resolved)
      if (record !== undefined) {
        publications.set(resolved, Object.freeze({ ...record, cleanupPending: true }))
      }
      issueGenuineHandle(active)
      return active
    }
  } catch (error) {
    // Preservation: the live (possibly partial) frontier, its populated
    // bytes, and the authenticated stage artifacts all stay exactly as they
    // are; the journal stays pending for deliberate resolution.
    if (error instanceof Error && error.message.startsWith('FALLBACK_FRONTIER_PUBLICATION_INCOMPLETE')) throw error
    throw fail(`frontier publication failed: ${(error as Error).message}`)
  }
}

/**
 * Process-local rollback authority for one completed planned-missing frontier
 * publication. Authority is EXCLUSIVELY the immutable in-memory completion
 * record created by a successful publication in THIS process (bound to the
 * exact transactionId, frontierPath, reserved dev/ino, and registered
 * complete-stage digest): disk journal fields and exported reporting copies
 * never authorize destructive action. The capability is one-shot: after a
 * successful quarantine the record is consumed so replay, cross-journal,
 * cross-frontier, or cross-handle attempts cannot move anything.
 */
async function rollbackFrontierPublication (
  handle: FallbackJournalHandle,
  journal: FallbackJournal,
  resolved: string
): Promise<{ outcome: 'rolled-back' | 'preserved' | 'absent'; journalPending: boolean; revision?: number; quarantineContainer?: string; ambiguous?: boolean; detail?: string; nextHandle?: FallbackJournalHandle }> {
  // ---- Object-identity authority gate (R2 blocker 1): only a handle object
  // issued by a legitimate transition in THIS process, whose CURRENT fields
  // still equal its immutable issued metadata exactly, may drive a
  // destructive frontier rollback. In-place field mutation and spread copies
  // both fail. Additionally: a genuine current mutator must still be the
  // journal mutator of THIS process, and a genuine owner must be the product
  // of a legitimate reclaim (journal mutator cleared, owner current). ----
  if (!handleMatchesIssuedMetadata(handle)) return { outcome: 'preserved', journalPending: false, quarantineContainer: undefined }
  let activeHandle = handle
  const journalMutatorMatches = journal.mutator !== undefined && processMatches(journal.mutator)
  const ownerIsCurrent = processMatches(journal.owner)
  if (handle.role === 'mutator') {
    if (!journalMutatorMatches) return { outcome: 'preserved', journalPending: false }
  } else if (handle.role === 'owner') {
    if (journal.mutator !== undefined || !ownerIsCurrent) return { outcome: 'preserved', journalPending: false }
  } else {
    return { outcome: 'preserved', journalPending: false }
  }
  const record = completedFrontierPublications.get(activeHandle.transactionId)?.get(resolved)
  // No process-local completion authority (never published here, already
  // consumed by an earlier rollback, or the process restarted): fail closed
  // with preservation — never derived from journal fields.
  if (record === undefined) return { outcome: 'preserved', journalPending: false }
  let allocatedContainer: string | undefined
  const fail = (detail: string): Error => new Error(`FALLBACK_FRONTIER_ROLLBACK_UNPROVEN: ${detail}`)
  try {
    // ---- Revalidation before any destructive byte moves ----
    // The journal entry must still be an applied planned-missing frontier
    // publication bound to the recorded complete-stage digest.
    const entry = journal.entries.find((candidate) => path.resolve(candidate.path) === resolved)
    if (entry === undefined || entry.existed || entry.kind !== 'missing') throw fail('the journal entry is not a planned-missing frontier')
    if (entry.applied !== true) throw fail('the journal entry is not applied')
    if (entry.stageDigest !== record.stageDigest) throw fail('the journal stage digest does not match the completion record')
    // The live frontier must still be the exact reserved directory identity
    // this process created and proved at publication time.
    const stats = await lstat(resolved).catch(() => undefined)
    if (stats === undefined || !stats.isDirectory() || stats.isSymbolicLink()) return { outcome: 'absent', journalPending: false }
    if (stats.dev !== record.dev || stats.ino !== record.ino) throw fail('the live frontier directory is not the reserved publication identity')
    // The anchor identity must hold right now: the frontier path is EXPECTED
    // to be live here (this process published it), so only the anchor chain
    // is revalidated — full structural/semantic/digest proof follows below.
    const frontier = handle.manifest.plannedMissingFrontiers.find((candidate) => path.resolve(candidate.frontierPath) === resolved)
    if (frontier === undefined) throw fail('the frontier is no longer planned evidence')
    await revalidateFallbackFrontierAnchor(frontier)
    // Rollback proof uses the IMMUTABLE selection frozen into the publication
    // record at registration: journal fields and caller arrays cannot widen it.
    const expectation = deriveFrontierTreeExpectation(
      { ...frontier, leaves: [...frontier.leaves.filter((leaf) => leaf.activation === 'required' || record.activeConditionalLeafIds.includes(leaf.id))] },
      handle.manifest.plannedMissingFrontiers.flatMap((candidate) => candidate.leaves),
      { skillDestinationResolver: trustedSkillDestinationResolver(handle.manifest), linkPolicy: fallbackLinkMaterialization(handle.manifest.harness) }
    )
    // Complete bounded structural/semantic proof and full digest equality with
    // the immutable registered digest: any drift, extra child, kind mismatch,
    // forbidden symlink, or partial publication preserves everything.
    await assertStagedFrontierTree(resolved, expectation)
    const digest = await boundedFrontierTreeDigest(resolved)
    if (!digest || digest !== record.stageDigest) throw fail('the live frontier digest does not match the registered complete-stage digest')
    // Frozen copied-link bindings proven against the LIVE tree BEFORE any
    // destructive move: kind, digest/link text, and final-skill resolution
    // from the live leaf location. Runs before the quarantine allocation so
    // the tightest rechecks stay closest to the move.
    if (record.copiedLinkBindings !== undefined) {
      for (const [relative, binding] of Object.entries(record.copiedLinkBindings)) {
        await assertPathMatchesCopiedLinkBinding(`Live frontier copied link ${resolved}/${relative}`, path.join(resolved, relative), binding).catch((error: unknown) => {
          throw fail(`the live frontier copied link ${relative} no longer matches its frozen binding: ${(error as Error).message}`)
        })
      }
    }
    if (fallbackFrontierRollbackSeam !== undefined) await fallbackFrontierRollbackSeam({ phase: 'proof-complete', frontierPath: resolved })

    // ---- Quarantine container: fresh authenticated same-filesystem sibling.
    // The container path lives OUTSIDE every inner try so EVERY failure after
    // allocation reports the exact allocated container (no rethrow can lose
    // the artifact). ----
    const quarantineStorage = await mkdtemp(path.join(path.dirname(resolved), `.${path.basename(resolved).replace(/^\.+/, '')}.nsolid-quarantine-`))
    allocatedContainer = quarantineStorage
    const quarantinePath = path.join(quarantineStorage, path.basename(resolved))
    const token = randomUUID()
    await writeFile(path.join(quarantineStorage, `.nsolid-quarantine-${token}`), token, { mode: 0o600 })
    const containerIdentity = await lstat(quarantineStorage)
    const capability: ArtifactCapability = {
      container: quarantineStorage,
      payload: quarantinePath,
      token,
      role: 'quarantine',
      dev: containerIdentity.dev,
      ino: containerIdentity.ino,
      // The payload child legitimately appears only with the rename: the
      // pre-move structure check must see the marker only, so any racing
      // extra child (an observable collision) fails closed before the move.
      children: new Map([[`.nsolid-quarantine-${token}`, 'file']]),
    }
    // Authenticated container proof immediately before the move: exact dev/
    // ino, marker carrying the exact token, and the expected children only.
    const containerStat = await lstat(quarantineStorage)
    if (containerStat.dev !== containerIdentity.dev || containerStat.ino !== containerIdentity.ino) throw fail('the quarantine container was replaced before the move')
    if (!await containerMatchesCapability(capability)) throw fail('the quarantine container structure does not match its recorded expectation')
    const markerPath = path.join(quarantineStorage, `.nsolid-quarantine-${token}`)
    if (await readFile(markerPath, 'utf8') !== token) throw fail('the quarantine marker does not carry the exact token')

    // ---- Durable rollback-pending state BEFORE any rename (R2 blockers 2+3):
    // the journal durably records frontierRollbackPending + the exact
    // quarantine container, and the updated handle is issued from the CAS. If
    // this preparation CAS fails, NOTHING moves. The pending fields are
    // strictly validated reporting/blocking state — they never grant
    // destructive authority by themselves. ----
    let pendingJournal: FallbackJournal
    try {
      pendingJournal = await withCasWrite(activeHandle, {
        ...journal,
        entries: journal.entries.map((candidate) => path.resolve(candidate.path) === resolved
          ? { ...candidate, frontierRollbackPending: true, quarantine: quarantinePath }
          : candidate),
      }, journal)
    } catch {
      throw fail('the durable rollback-pending state could not be recorded; nothing was moved')
    }
    journal = pendingJournal
    activeHandle = issueGenuineHandle({ ...activeHandle, revision: pendingJournal.revision })
    if (fallbackFrontierRollbackSeam !== undefined) {
      await fallbackFrontierRollbackSeam({ phase: 'quarantine-ready', frontierPath: resolved, quarantinePath })
    }

    // ---- TOCTOU re-authentication IMMEDIATELY before the rename: the
    // quarantine-ready seam (and any async work around it) is a window in
    // which the container could be replaced by a symlink, stripped, or given
    // a payload collision. Re-prove the exact container identity, marker
    // token, exact expected children (marker only — no payload), real non-link
    // container kind, and that the payload destination is truly ABSENT before
    // anything moves. ----
    {
      const preMove = await lstat(quarantineStorage)
      if (preMove.dev !== containerIdentity.dev || preMove.ino !== containerIdentity.ino || !preMove.isDirectory() || preMove.isSymbolicLink()) {
        throw fail('the quarantine container identity changed before the move')
      }
      if (!await containerMatchesCapability(capability)) throw fail('the quarantine container structure does not match its recorded expectation before the move')
      if (await readFile(markerPath, 'utf8') !== token) throw fail('the quarantine marker does not carry the exact token before the move')
      const payloadStat = await lstat(quarantinePath).catch(() => undefined)
      if (payloadStat !== undefined) throw fail('the quarantine payload destination is not absent before the move')
    }

    // ---- From here on, ANY ordinary exception (seam throws, extra child /
    // structure failure after the move, identity/digest mismatch, collision)
    // becomes ONE structured incomplete outcome: retain the durable pending
    // state, retire the destructive publication authority if a physical move
    // may have occurred, and report the exact container. ----
    let movedPhysically = false
    try {
      try {
        await rename(resolved, quarantinePath)
        movedPhysically = true
      } catch {
        // A racing child at the payload path (visible only through the seam
        // window) makes the rename fail on a non-empty directory: the
        // collision is preserved, never overwritten.
        throw fail('the frontier could not be moved into the quarantine container')
      }
      // The payload child is now real: record the post-move structure so any
      // later authenticated cleanup validates reality.
      capability.children = new Map([[path.basename(resolved), 'directory'], [`.nsolid-quarantine-${token}`, 'file']])
      // ---- TOCTOU re-authentication immediately after the rename: re-prove
      // the same container identity, marker token, and exact post-move
      // children (payload + marker) before any proof or pending-state
      // clearing. A swapped container or injected child keeps the live
      // frontier, pending journal, and quarantine evidence preserved. ----
      {
        const postMove = await lstat(quarantineStorage)
        if (postMove.dev !== containerIdentity.dev || postMove.ino !== containerIdentity.ino || !postMove.isDirectory() || postMove.isSymbolicLink()) {
          throw fail('the quarantine container identity changed after the move')
        }
        if (!await containerMatchesCapability(capability)) throw fail('the quarantine container structure does not match its recorded expectation after the move')
        if (await readFile(markerPath, 'utf8') !== token) throw fail('the quarantine marker does not carry the exact token after the move')
      }
      if (fallbackFrontierRollbackSeam !== undefined) {
        await fallbackFrontierRollbackSeam({ phase: 'moved', frontierPath: resolved, quarantinePath })
      }

      // ---- Post-rename proof: the moved root IS the exact original inode with
      // the exact proven structure/digest, and the original path is missing. ----
      const moved = await lstat(quarantinePath).catch(() => undefined)
      if (moved === undefined || !moved.isDirectory() || moved.isSymbolicLink() || moved.dev !== record.dev || moved.ino !== record.ino) {
        throw fail('the moved frontier root is not the exact original inode')
      }
      await assertStagedFrontierTree(quarantinePath, expectation)
      const movedDigest = await boundedFrontierTreeDigest(quarantinePath)
      if (!movedDigest || movedDigest !== record.stageDigest) throw fail('the moved frontier digest does not match the registered complete-stage digest')
      // The moved tree proves its frozen bindings with exact text equality
      // resolved against the ORIGINAL live leaf location — never against
      // the quarantine parent, where valid relative targets would mis-resolve.
      if (record.copiedLinkBindings !== undefined) {
        for (const [relative, binding] of Object.entries(record.copiedLinkBindings)) {
          await assertPathMatchesCopiedLinkBinding(`Quarantined frontier copied link ${quarantinePath}/${relative}`, path.join(quarantinePath, relative), binding, { resolveFrom: path.dirname(path.join(resolved, relative)) }).catch((error: unknown) => {
            throw fail(`the quarantined frontier copied link ${relative} no longer matches its frozen binding: ${(error as Error).message}`)
          })
        }
      }
      if (await pathKind(resolved) !== 'missing') {
        // A replacement appeared at the original path in the rename→prove
        // window: keep it, keep the quarantine, and preserve the ambiguity
        // instead of pretending the restore is exact.
        throw fail('a new path appeared at the frontier location after the move')
      }
      if (fallbackFrontierRollbackSeam !== undefined) {
        await fallbackFrontierRollbackSeam({ phase: 'proven', frontierPath: resolved, quarantinePath })
      }

      // ---- Successful proof: retire the one-shot publication authority,
      // clear the durable pending state and the entry's applied/stage fields
      // via the issued handle. ----
      completedFrontierPublications.get(activeHandle.transactionId)!.delete(resolved)
      const preservedArtifacts = [...(journal.preservedArtifacts ?? []), quarantineStorage]
      try {
        const finished = await withCasWrite(activeHandle, {
          ...journal,
          preservedArtifacts: dedupePaths(preservedArtifacts),
          entries: journal.entries.map((candidate) => path.resolve(candidate.path) === resolved
            ? { ...candidate, applied: false, stage: undefined, stageDigest: undefined, frontierRollbackPending: undefined, quarantine: undefined }
            : candidate),
        }, journal)
        journal = finished
        activeHandle = issueGenuineHandle({ ...handle, revision: finished.revision })
        return { outcome: 'rolled-back', journalPending: false, revision: finished.revision, quarantineContainer: quarantineStorage, nextHandle: activeHandle }
      } catch {
        // The final bookkeeping CAS failed after a FULLY PROVEN move: the
        // physical restore IS done, but the durable pending state remains and
        // the revision is untrustworthy. Report pending accurately.
        return { outcome: 'rolled-back', journalPending: true, revision: activeHandle.revision, quarantineContainer: quarantineStorage }
      }
    } catch (error) {
      // ONE structured incomplete outcome for every post-move ambiguity or
      // failure. If a physical move may have occurred, retire the destructive
      // publication authority so no replay can move anything; the durable
      // pending state is retained on disk (reporting/blocking only).
      if (movedPhysically) {
        completedFrontierPublications.get(activeHandle.transactionId)?.delete(resolved)
      }
      const detail = error instanceof Error ? error.message : String(error)
      return {
        outcome: 'preserved',
        journalPending: true,
        quarantineContainer: quarantineStorage,
        ambiguous: true,
        detail,
      }
    }
  } catch (error) {
    // Every failure after allocation is a structured preservation outcome so
    // the exact quarantine container cannot disappear from reporting. A
    // durable pending record blocks all automatic retries and retires the
    // publication authority even when the failure happened before rename.
    if (allocatedContainer !== undefined) {
      const journalPending = pendingContainerOf(activeHandle, journal, resolved) !== undefined
      if (journalPending) completedFrontierPublications.get(activeHandle.transactionId)?.delete(resolved)
      return {
        outcome: 'preserved',
        journalPending,
        quarantineContainer: allocatedContainer,
        ambiguous: journalPending,
        detail: error instanceof Error ? error.message : String(error),
      }
    }
    // Pre-allocation proof failures preserve the live root without creating an
    // artifact. They are unproven but not a durable rollback-pending state.
    if (error instanceof Error && error.message.startsWith('FALLBACK_FRONTIER_ROLLBACK_UNPROVEN')) {
      return { outcome: 'preserved', journalPending: false }
    }
    throw fail(`frontier rollback failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** The durable quarantine container recorded in a pending journal entry, if any (reporting only). */
function pendingContainerOf (handle: FallbackJournalHandle, journal: FallbackJournal, resolved: string): string | undefined {
  const entry = journal.entries.find((candidate) => path.resolve(candidate.path) === resolved)
  if (entry?.frontierRollbackPending !== true || entry.quarantine === undefined) return undefined
  return path.dirname(path.resolve(entry.quarantine))
}

/**
 * Swap one entry's staged payload into place on the same volume. The stage is
 * verified against the in-memory capability (never against the journal record
 * alone), the live state is re-checked immediately before the swap, and the
 * replaced bytes move to a sibling quarantine that is preserved (never rm'd)
 * until an authenticated cleanup.
 */
export async function applyFallbackEntry (handle: FallbackJournalHandle, target: string): Promise<FallbackJournalHandle> {
  let active = handle
  let journal = await reloadFallbackJournal(active)
  requireRole(journal, active, 'mutator')
  const resolved = path.resolve(target)
  const entry = journal.entries.find((candidate) => path.resolve(candidate.path) === resolved)
  if (!entry) throw new Error(`No fallback journal entry for ${resolved}`)
  const stageCapability = capabilitiesFor(active).get(resolved)
  const frontier = active.manifest.plannedMissingFrontiers.find((candidate) => path.resolve(candidate.frontierPath) === resolved)
  if (frontier !== undefined) {
    // A planned-missing frontier is applied only through its process-local
    // publication capability registered by registerFallbackFrontierStage.
    // Without that capability the mutator preserves the live state and
    // fails closed; a frontier is never a deletion candidate.
    if (!stageCapability || stageCapability.role !== 'stage' || stageCapability.payload === undefined) {
      throw new Error(`No registered stage capability for ${resolved}`)
    }
    return await applyFrontierPublication(active, journal, entry, frontier, resolved, stageCapability)
  }
  if (!stageCapability || stageCapability.role !== 'stage' || stageCapability.payload === undefined) {
    return await applyDeletionOnlyEntry(active, journal, entry, resolved)
  }
  if (entry.stage !== stageCapability.payload) throw new Error(`Fallback journal stage for ${resolved} does not match the registered capability`)
  const stageDigest = await pathDigest(stageCapability.payload)
  if (!stageDigest || stageDigest !== entry.stageDigest) throw new Error(`Staged payload for ${resolved} no longer matches its registered digest`)
  // A copied-link stage must still satisfy the binding frozen at
  // registration BEFORE any live mutation: the frozen record alone is the
  // authority, never the registry or the mutable live skill bytes.
  if (stageCapability.copiedLinkBinding !== undefined) {
    await assertPathMatchesCopiedLinkBinding(`Staged copied link ${resolved}`, stageCapability.payload, stageCapability.copiedLinkBinding)
  }

  // Immediate revalidation: a concurrent writer must never be clobbered by
  // the swap. A destination journaled as missing that now exists is drift too.
  const kind = await pathKind(resolved)
  const liveDigest = kind !== 'missing' ? await pathDigest(resolved) : null
  if (liveDigest === undefined || (entry.existed ? kind !== entry.kind || liveDigest !== entry.digest : kind !== 'missing')) {
    throw new Error(`Fallback target ${resolved} drifted after journaling; aborting without touching concurrent bytes`)
  }

  const quarantineStorage = await mkdtemp(path.join(path.dirname(resolved), `.${path.basename(resolved).replace(/^\.+/, '')}.nsolid-quarantine-`))
  const quarantinePath = path.join(quarantineStorage, path.basename(resolved))
  const quarantineToken = randomUUID()
  await writeFile(path.join(quarantineStorage, `.nsolid-quarantine-${quarantineToken}`), quarantineToken, { mode: 0o600 })
  const quarantineIdentity = await lstat(quarantineStorage)
  const quarantineCapability: ArtifactCapability = {
    container: quarantineStorage,
    payload: quarantinePath,
    token: quarantineToken,
    role: 'quarantine',
    dev: quarantineIdentity.dev,
    ino: quarantineIdentity.ino,
    children: new Map([[`.nsolid-quarantine-${quarantineToken}`, 'file']]),
  }
  // Durably record the quarantine BEFORE the live path moves: a termination in
  // any later window leaves a journal that explains the missing target.
  journal = await withCasWrite(active, {
    ...journal,
    entries: journal.entries.map((candidate) => candidate === entry
      ? { ...candidate, quarantine: quarantinePath }
      : candidate),
  }, journal)
  active = { ...active, revision: journal.revision }
  // The payload child only legitimately appears with the live rename: record
  // it immediately before the move so the cleanup structure matches reality.
  if (kind !== 'missing') {
    quarantineCapability.children = new Map([...quarantineCapability.children!, [path.basename(quarantinePath), kind]])
    await rename(resolved, quarantinePath)
  }
  await rename(stageCapability.payload, resolved)
  // The staged payload moved into place: the stage container's exact remaining
  // structure is now its marker only. Record that so authenticated cleanup
  // validates the post-swap reality instead of the pre-swap one.
  stageCapability.children = new Map([[`.nsolid-stage-${stageCapability.token}`, 'file']])
  const appliedDigest = await pathDigest(resolved)
  if (!appliedDigest || appliedDigest !== entry.stageDigest) throw new Error(`Swap for ${resolved} did not produce the staged digest`)
  // Post-swap proof for a copied link: the published path itself must still
  // satisfy the frozen binding (kind, digest/link text, final destination
  // resolution from the live location) before the swap is recorded applied.
  // The proof is retained BEFORE the durable CAS: even if the CAS below
  // fails, same-process restore can still verify against what this process
  // physically published.
  if (stageCapability.copiedLinkBinding !== undefined) {
    await assertPathMatchesCopiedLinkBinding(`Published copied link ${resolved}`, resolved, stageCapability.copiedLinkBinding)
    retainAppliedCopiedLinkBinding(active, resolved, stageCapability.copiedLinkBinding)
  }
  journal = await withCasWrite(active, {
    ...journal,
    entries: journal.entries.map((candidate) => path.resolve(candidate.path) === resolved
      ? { ...candidate, applied: true }
      : candidate),
  }, journal)
  active = { ...active, revision: journal.revision }
  // Both containers are cleaned by their creator while the capabilities are
  // still in memory. Failures are reporting-only residue and never fail an
  // applied swap; the authenticated snapshot remains the rollback source.
  const preservedArtifacts = [...(journal.preservedArtifacts ?? [])]
  const stageRemoved = await removeAuthenticatedContainer(stageCapability).catch(() => false)
  if (!stageRemoved) preservedArtifacts.push(stageCapability.container)
  capabilitiesFor(active).delete(resolved)
  const quarantineRemoved = await removeAuthenticatedContainer(quarantineCapability).catch(() => false)
  if (!quarantineRemoved) preservedArtifacts.push(quarantineCapability.container)
  journal = await withCasWrite(active, {
    ...journal,
    preservedArtifacts: dedupePaths(preservedArtifacts),
    entries: journal.entries.map((candidate) => path.resolve(candidate.path) === resolved
      ? { ...candidate, stage: undefined, quarantine: undefined }
      : candidate),
  }, journal)
  const swapped = { ...active, revision: journal.revision }
  issueGenuineHandle(swapped)
  return swapped
}

/**
 * Deletion-only apply for a planned removal (a bundle no longer ships this
 * owned skill/link). The mutator's trusted in-memory manifest must authorize
 * the exact resolved path as originally-existing ownership evidence —
 * ownedSkills/ownedLinks ONLY: planned-missing bundle destinations, MCP-only
 * evidence, and anything absent from the manifest are never deletion
 * candidates. The live state is re-checked against that evidence immediately
 * before the move, the live bytes go into an authenticated sibling quarantine
 * (preserved until commit/restore removes it through the in-memory
 * capability), and `applied` is recorded strictly as validation evidence.
 *
 * This branch never hides a lost replacement stage: a journal-recorded stage
 * or stage digest without its in-memory capability, or an incomplete prior
 * deletion (quarantine recorded but not applied), still fails closed.
 * A planned-missing owned path with nothing live to remove is an already-
 * satisfied deletion and succeeds as a no-op; a live path at a planned-
 * missing location is drift and still fails closed.
 */
async function applyDeletionOnlyEntry (
  handle: FallbackJournalHandle,
  journal: FallbackJournal,
  entry: FallbackJournalEntry,
  resolved: string
): Promise<FallbackJournalHandle> {
  // A journal-recorded stage is a replacement whose payload capability was
  // lost (or was never created in this process): never silently delete it.
  if (entry.stage !== undefined || entry.stageDigest !== undefined) {
    throw new Error(`No registered stage capability for ${resolved}`)
  }
  // A previously recorded, not-yet-applied quarantine means a prior deletion
  // attempt died mid-move; re-applying could pile containers, so fail closed.
  if (entry.quarantine !== undefined && entry.applied !== true) {
    throw new Error(`A pending quarantine for ${resolved} must be resolved before re-applying`)
  }
  const evidence = ownedRemovalEvidence(handle.manifest).get(resolved)
  // A planned-missing owned path (e.g. a harness link the layout never
  // created) with nothing live to remove is an already-satisfied deletion:
  // succeed as a no-op instead of failing the whole refresh. A path that is
  // absent from the removal evidence entirely (bundle destinations, MCP-only
  // evidence, unmanifested paths) never reaches this branch and is refused
  // below, and anything live at a planned-missing path is drift and also
  // fails closed below.
  if (evidence !== undefined && evidence.kind === 'missing' && !entry.existed && await pathKind(resolved) === 'missing') {
    return handle
  }
  if (!entry.existed || evidence === undefined || evidence.kind === 'missing' || evidence.digest === undefined) {
    throw new Error(`No registered stage capability for ${resolved}`)
  }
  // Immediate revalidation against the trusted planning evidence: only bytes
  // identical to the owned original may be removed.
  const kind = await pathKind(resolved)
  const liveDigest = kind !== 'missing' ? await pathDigest(resolved) : undefined
  if (kind !== evidence.kind || liveDigest !== evidence.digest) {
    throw new Error(`Fallback target ${resolved} drifted after journaling; aborting without touching concurrent bytes`)
  }
  const storage = await mkdtemp(path.join(path.dirname(resolved), `.${path.basename(resolved).replace(/^\.+/, '')}.nsolid-quarantine-`))
  const quarantinePath = path.join(storage, path.basename(resolved))
  const token = randomUUID()
  const capability: ArtifactCapability = {
    container: storage,
    payload: quarantinePath,
    token,
    role: 'quarantine',
    children: new Map([[`.nsolid-quarantine-${token}`, 'file']]),
  }
  let moved = false
  try {
    await writeFile(path.join(storage, `.nsolid-quarantine-${token}`), token, { mode: 0o600 })
    const identity = await lstat(storage)
    capability.dev = identity.dev
    capability.ino = identity.ino
    // Register the cleanup authority before anything moves: from here on the
    // container is only ever removed through this in-memory capability.
    capabilitiesFor(handle).set(resolved, capability)
    // Durably record the quarantine BEFORE the live path moves, mirroring the
    // swap path: a termination in any later window leaves a journal that
    // explains the missing target.
    const recorded = await withCasWrite(handle, {
      ...journal,
      entries: journal.entries.map((candidate) => candidate === entry
        ? { ...candidate, quarantine: quarantinePath }
        : candidate),
    }, journal)
    // The payload child only legitimately appears with the live rename: record
    // it immediately before the move so the cleanup structure matches reality.
    capability.children = new Map([...capability.children!, [path.basename(quarantinePath), kind]])
    await rename(resolved, quarantinePath)
    moved = true
    if (await pathKind(resolved) !== 'missing') throw new Error(`Deletion for ${resolved} did not clear the target`)
    const applied = await withCasWrite({ ...handle, revision: recorded.revision }, {
      ...recorded,
      entries: recorded.entries.map((candidate) => path.resolve(candidate.path) === resolved
        ? { ...candidate, applied: true }
        : candidate),
    }, recorded)
    // The quarantine is preservation, not garbage: it stays in place until
    // commit or restore removes it through the capability registered above.
    const appliedHandle = { ...handle, revision: applied.revision }
    issueGenuineHandle(appliedHandle)
    return appliedHandle
  } catch (error) {
    if (moved && await pathKind(resolved) === 'missing') {
      // A failed deletion must not destroy the original bytes: move them back.
      await rename(quarantinePath, resolved).catch(() => {})
    }
    // Remove the container only when it no longer holds the live bytes;
    // otherwise the capability stays as preserved-artifact authority. Even
    // this payload-less removal goes through the authenticated cleanup:
    // unexpected container content preserves it instead of deleting it.
    if (await pathKind(quarantinePath) === 'missing') {
      const removed = await removeAuthenticatedContainer(capability).catch(() => false)
      if (removed) capabilitiesFor(handle).delete(resolved)
    }
    throw error
  }
}

/**
 * Trusted deletion authority: only tracked skill/link ownership evidence may
 * authorize a deletion-only apply. MCP whole-file evidence, bundle
 * destinations, and the tracking file are deliberately excluded.
 */
function ownedRemovalEvidence (manifest: FallbackTransactionIdentity): Map<string, FallbackPathEvidence> {
  const evidence = new Map<string, FallbackPathEvidence>()
  for (const entry of [...(manifest.ownedSkills ?? []), ...(manifest.ownedLinks ?? [])]) {
    if (entry !== undefined && !evidence.has(path.resolve(entry.path))) evidence.set(path.resolve(entry.path), entry)
  }
  return evidence
}

/**
 * Restore every entry to its original state. Authority is EXCLUSIVELY the
 * trusted in-memory manifest carried by a FallbackJournalHandle: owned paths
 * are rewritten from backups authenticated against that manifest, and
 * planned-missing destinations are moved to a quarantine (never rm'd).
 * A plain journal object — even a perfectly self-consistent one read back
 * from disk — is never destructive authority and is refused without touching
 * anything; next-run recovery's restricted, tracking-scoped restore lives
 * only in recoverFallbackJournal.
 * Mutable journal fields (applied/stageDigest/quarantine) never authorize a
 * deletion or an overwrite: backups must authenticate against manifest
 * evidence, and each entry is re-checked immediately before it is replaced.
 * The owner role disposes the journal and snapshot on success; a mutator
 * handle leaves them for its owner.
 */
export async function restoreFallbackJournal (handle: FallbackJournalHandle): Promise<FallbackJournalOperationResult> {
  const preservedArtifacts: string[] = []
  const preservedPaths: string[] = []
  if (handle === undefined || (handle as unknown as { kind?: unknown }).kind !== 'fallback-journal-handle') {
    // Refuse plain journals fail-closed: disk self-consistency is not authority.
    return { succeeded: false, unproven: true, preservedArtifacts, preservedPaths }
  }
  try {
    const journalPath = handle.journalPath
    let journal: FallbackJournal
    try {
      journal = await reloadFallbackJournal(handle)
    } catch {
      // The journal cannot be proven to match the trusted manifest (or be
      // structurally sound): nothing is mutated and everything is preserved.
      return { succeeded: false, unproven: true, preservedArtifacts, preservedPaths }
    }
    const authority = handle.manifest
    if (!sameManifest(journal.manifest, authority)) {
      return { succeeded: false, unproven: true, preservedArtifacts, preservedPaths }
    }
    // Preflight before the first destructive byte moves: the snapshot must be
    // provably real, and every backup that will be restored must authenticate
    // against manifest evidence. A tampered or rotted backup aborts with the
    // live paths untouched and the artifacts preserved.
    if (!snapshotShapeIsValid(journal)) return { succeeded: false, unproven: true, preservedArtifacts, preservedPaths }
    const evidence = plannedEvidenceMap(authority)
    for (const entry of journal.entries) {
      if (!entry.existed) continue
      if (!entry.backup) return { succeeded: false, unproven: true, preservedArtifacts, preservedPaths }
      if (!await backupAuthenticates(entry, evidence, authority)) {
        return { succeeded: false, unproven: true, preservedArtifacts, preservedPaths }
      }
    }
    // Quarantine containers created by this restore are this invocation's
    // capabilities; they are cleaned after postvalidation succeeds.
    const restoreCapabilities = new Map<string, ArtifactCapability>()
    // Planned-missing frontiers are the publication units of the process
    // that reserved them: destructive restore authority is EXCLUSIVELY a
    // process-local completion capability created by a successful
    // publication in THIS process (mutator child or locally reclaimed
    // owner). An external parent or a next-run process without that
    // capability always preserves, even when every journal field matches.
    const frontierPaths = new Set(authority.plannedMissingFrontiers.map((frontier) => path.resolve(frontier.frontierPath)))
    let frontierIncomplete = false
    // ---- Durable pending preflight (R2 blockers 2+3): any journal entry
    // durably marked frontierRollbackPending makes the WHOLE restore
    // incomplete/unproven — the journal/quarantine/snapshot stay, the exact
    // container is reported, and NO generic postvalidation or cleanup runs.
    // The disk state is reporting/blocking only, never destructive authority:
    // the restore refuses regardless of any process-local capability. ----
    const pendingEntry = journal.entries.find((candidate) => candidate.frontierRollbackPending === true)
    if (pendingEntry !== undefined) {
      const pendingTarget = path.resolve(pendingEntry.path)
      preservedPaths.push(pendingTarget)
      if (pendingEntry.quarantine !== undefined) {
        preservedArtifacts.push(path.dirname(path.resolve(pendingEntry.quarantine)))
        preservedPaths.push(path.resolve(pendingEntry.quarantine))
      }
      for (const entry of journal.entries) {
        const target = path.resolve(entry.path)
        if (target === pendingTarget) continue
        if (frontierPaths.has(target) && await pathKind(target) === 'missing') continue
        preservedPaths.push(target)
      }
      return { succeeded: false, unproven: true, preservedArtifacts: dedupePaths(preservedArtifacts), preservedPaths: dedupePaths(preservedPaths) }
    }
    // First pass: roll back every frontier this process published through
    // its own capability. The publication record binds the exact reserved
    // identity and registered digest, so this cannot be forged by any disk
    // state; unproven or absent-capability frontiers are handled below.
    for (const resolved of frontierPaths) {
      if (await pathKind(resolved) === 'missing') continue
      if (completedFrontierPublications.get(handle.transactionId)?.has(resolved) !== true) continue
      const rollback = await rollbackFrontierPublication(handle, journal, resolved).catch((error: unknown) => {
        // Unproven rollback: the live frontier (or any ambiguity it left
        // behind) is preserved and reported; the restore continues with the
        // remaining independently authenticated entries.
        if (error instanceof Error && error.message.startsWith('FALLBACK_FRONTIER_ROLLBACK_UNPROVEN')) return undefined
        throw error
      })
      if (rollback === undefined) {
        preservedPaths.push(resolved)
        frontierIncomplete = true
        journal = await reloadFallbackJournal(handle).catch(() => journal)
        continue
      }
      if (rollback.outcome === 'absent') continue
      // Every rollback result carries the exact allocated quarantine
      // container whenever one was allocated.
      if (rollback.quarantineContainer !== undefined) preservedArtifacts.push(rollback.quarantineContainer)
      if (rollback.ambiguous === true) {
        // A physical move HAPPENED but could not be proven: the durable
        // pending state is on disk, the destructive publication authority was
        // retired, and the whole operation is incomplete. Stop and report
        // every remaining unrestored target; journal/snapshot stay.
        journal = await reloadFallbackJournal(handle).catch(() => journal)
        for (const entry of journal.entries) {
          const target = path.resolve(entry.path)
          if (target === resolved) continue
          if (frontierPaths.has(target) && await pathKind(target) === 'missing') continue
          preservedPaths.push(target)
        }
        return { succeeded: false, unproven: true, preservedArtifacts: dedupePaths(preservedArtifacts), preservedPaths: dedupePaths(preservedPaths) }
      }
      if (rollback.outcome === 'rolled-back') {
        if (rollback.journalPending) {
          // Final bookkeeping CAS failure after a fully proven move: the
          // handle revision is untrustworthy, so the restore MUST STOP.
          // Report succeeded:false with frontierJournalPending:true, the
          // quarantine artifact, and every remaining unrestored target.
          journal = await reloadFallbackJournal(handle).catch(() => journal)
          for (const entry of journal.entries) {
            const target = path.resolve(entry.path)
            if (frontierPaths.has(target) && await pathKind(target) === 'missing') continue
            preservedPaths.push(target)
          }
          return { succeeded: false, frontierJournalPending: true, preservedArtifacts: dedupePaths(preservedArtifacts), preservedPaths: dedupePaths(preservedPaths) }
        }
        // Adopt the handle re-issued by the rollback (fresh revision, still
        // bound to its issued metadata) so further frontiers can roll back.
        if (rollback.nextHandle !== undefined) handle = rollback.nextHandle
        journal = await reloadFallbackJournal(handle).catch(() => journal)
        continue
      }
      // Preserved (unproven, nothing moved): reload the journal and let the
      // per-entry pass report the live frontier as incomplete below.
      journal = await reloadFallbackJournal(handle).catch(() => journal)
    }
    for (const entry of journal.entries) {
      const resolved = path.resolve(entry.path)
      const kind = await pathKind(resolved)
      if (entry.existed) {
        const liveDigest = kind !== 'missing' ? await pathDigest(resolved) : null
        if (liveDigest === undefined) { preservedPaths.push(resolved); continue }
        // Already the authenticated original: nothing to replace.
        if (kind === entry.kind && liveDigest === entry.digest) continue
        if (!entry.backup) { preservedPaths.push(resolved); continue }
        // Same-process published copied link: the bytes about to be
        // quarantined must match the retained frozen publication binding —
        // what this process published, never disk journal fields alone.
        const retainedBinding = retainedAppliedCopiedLinkBinding(handle, resolved)
        if (retainedBinding !== undefined && kind !== 'missing' && !await livePathMatchesRetainedCopiedLinkBinding(resolved, retainedBinding)) {
          preservedPaths.push(resolved); continue
        }
        // Preserve the current bytes by quarantine-rename instead of rm, then
        // install a verified copy of the authenticated backup atomically.
        if (!await renameLiveToRestoreQuarantine(resolved, restoreCapabilities)) { preservedPaths.push(resolved); continue }
        if (retainedBinding !== undefined && kind !== 'missing') {
          // Post-quarantine verification: the moved bytes must still match
          // the retained binding; exact link texts resolve against the
          // original live location, never the quarantine parent.
          const movedCapability = restoreCapabilities.get(resolved)
          if (movedCapability?.payload === undefined || !await movedPathMatchesRetainedCopiedLinkBinding(movedCapability.payload, resolved, retainedBinding)) {
            preservedPaths.push(resolved); continue
          }
        }
        const temporary = path.join(path.dirname(resolved), `.${path.basename(resolved).replace(/^\.+/, '')}.nsolid-restore-${randomUUID().slice(0, 8)}`)
        try {
          await cp(entry.backup, temporary, { recursive: true, force: false, errorOnExist: true, verbatimSymlinks: true, dereference: false })
          if (await pathDigest(temporary) !== entry.digest || await pathKind(temporary) !== entry.kind) throw new Error('restored copy mismatch')
          if (await pathKind(resolved) !== 'missing') throw new Error('destination reoccupied during restore')
          await rename(temporary, resolved)
        } catch {
          await rm(temporary, { recursive: true, force: true }).catch(() => {})
          preservedPaths.push(resolved)
        }
      } else if (kind !== 'missing') {
        if (frontierPaths.has(resolved)) {
          // A live planned-missing frontier is never moved by the parent:
          // preserve the path and mark the rollback incomplete.
          preservedPaths.push(resolved)
          frontierIncomplete = true
          continue
        }
        // Planned-missing destination that exists: preserve the bytes by
        // quarantine-rename. A rollback never deletes what it did not prove
        // this transaction wrote. Same-process published copied links also
        // prove against their retained frozen binding before and after the
        // move.
        const retainedMissingBinding = retainedAppliedCopiedLinkBinding(handle, resolved)
        if (retainedMissingBinding !== undefined && !await livePathMatchesRetainedCopiedLinkBinding(resolved, retainedMissingBinding)) { preservedPaths.push(resolved); continue }
        if (!await renameLiveToRestoreQuarantine(resolved, restoreCapabilities)) { preservedPaths.push(resolved); continue }
        if (retainedMissingBinding !== undefined) {
          const movedCapability = restoreCapabilities.get(resolved)
          if (movedCapability?.payload === undefined || !await movedPathMatchesRetainedCopiedLinkBinding(movedCapability.payload, resolved, retainedMissingBinding)) { preservedPaths.push(resolved); continue }
        }
      }
    }
    // Postvalidate the live state before any cleanup or journal disposal.
    let valid = true
    for (const entry of journal.entries) {
      const resolved = path.resolve(entry.path)
      const kind = await pathKind(resolved)
      if (entry.existed) {
        const digest = kind !== 'missing' ? await pathDigest(resolved) : null
        if (digest === undefined || kind !== entry.kind || digest !== entry.digest) valid = false
        if (resolved === path.resolve(authority.trackingPath) && trackingDigest(resolved) !== authority.trackingDigest) valid = false
      } else if (kind !== 'missing') {
        valid = false
      }
    }
    if (!valid) {
      if (frontierIncomplete) {
        // The rollback cannot complete while a planned-missing frontier
        // lives: report every restore container this invocation created so
        // the incomplete rollback stays fully discoverable; nothing is
        // destroyed and the journal is preserved for manual resolution.
        for (const capability of restoreCapabilities.values()) preservedArtifacts.push(capability.container)
        return { succeeded: false, unproven: true, preservedArtifacts: dedupePaths(preservedArtifacts), preservedPaths: dedupePaths(preservedPaths) }
      }
      return { succeeded: false, preservedArtifacts, preservedPaths }
    }
    await cleanupRestoreArtifacts(journal, handle, restoreCapabilities, preservedArtifacts)
    if (handle.role === 'owner') {
      // Completing the restore disposes the transaction: only the owner holds
      // that authority. A mutator handle deliberately leaves the journal for
      // its owner.
      await rm(journalPath, { force: true }).catch(() => {})
    }
    return { succeeded: true, preservedArtifacts: dedupePaths(preservedArtifacts), preservedPaths: dedupePaths(preservedPaths) }
  } catch {
    return { succeeded: false, preservedArtifacts, preservedPaths }
  }
}

/**
 * Commit a successfully applied transaction. Cleanup failures are fail-closed:
 * the artifact survives and is reported, but the commit itself still succeeds.
 * Returns the preserved arrays for result propagation.
 */
export async function commitFallbackJournal (handle: FallbackJournalHandle): Promise<FallbackJournalOperationResult> {
  if (handle === undefined || (handle as unknown as { kind?: unknown }).kind !== 'fallback-journal-handle') {
    // Refuse plain journals fail-closed: disk self-consistency is not authority.
    throw new Error('Invalid fallback journal')
  }
  if (handle.role !== 'owner') throw new Error('Invalid fallback journal')
  const journalPath = handle.journalPath
  const residues = await readReportingResidues(journalPath)
  const preservedArtifacts: string[] = [...residues.preservedArtifacts]
  const preservedPaths: string[] = [...residues.preservedPaths]
  const journal = await reloadFallbackJournal(handle)
  if (!snapshotShapeIsValid(journal)) throw new Error('Invalid fallback journal')
  // A durable frontierRollbackPending entry means an ambiguous physical
  // rollback state is being deliberately resolved: the transaction is NOT
  // complete, so commit refuses and nothing is cleaned or removed (the disk
  // pending field is reporting/blocking only — never authority).
  if (journal.entries.some((candidate) => candidate.frontierRollbackPending === true)) {
    for (const entry of journal.entries) {
      if (entry.frontierRollbackPending === true && entry.quarantine !== undefined) {
        preservedArtifacts.push(path.dirname(path.resolve(entry.quarantine)))
      }
    }
    throw new Error('FALLBACK_FRONTIER_ROLLBACK_PENDING')
  }
  // Stage/quarantine containers: only in-memory capabilities authorize their
  // removal. Anything else (a forged or stale journal record) is preserved.
  for (const entry of journal.entries) {
    for (const artifact of [entry.stage !== undefined ? path.dirname(entry.stage) : undefined, entry.quarantine !== undefined ? path.dirname(entry.quarantine) : undefined]) {
      if (artifact === undefined) continue
      const removed = await tryRemoveByCapability(capabilitiesFor(handle), artifact)
      if (!removed) preservedArtifacts.push(artifact)
    }
  }
  // The snapshot is removed only via its recorded in-memory capability.
  if (journal.snapshotDirectory !== undefined) {
    const snapshot = path.resolve(journal.snapshotDirectory)
    let removed = false
    const snapshotCapability = capabilitiesFor(handle).get('\0snapshot')
    if (snapshotCapability !== undefined && snapshotCapability.container === snapshot) {
      removed = await removeAuthenticatedContainer(snapshotCapability).catch(() => false)
    }
    if (!removed) preservedArtifacts.push(snapshot)
  }
  // The journal is removed last: until it disappears the transaction stays
  // discoverable and pending.
  await rm(journalPath, { force: true }).catch(() => {})
  return { succeeded: true, preservedArtifacts: dedupePaths(preservedArtifacts), preservedPaths: dedupePaths(preservedPaths) }
}

/**
 * Next-run recovery. There is no in-memory manifest and no capability set, so
 * this path is strictly restore-only and NEVER commits, cleans a snapshot, or
 * deletes artifacts. Only paths the CURRENT tracking file declares owned are
 * restored, and only when the backup still matches the journaled entry digest
 * (documented asymmetry: without the trusted manifest this is the strongest
 * available evidence). The tracking backup is additionally preflighted
 * against the planned manifest tracking digest (raw bytes) before any live
 * path is changed, so a rewritten tracking backup with a recomputed entry
 * digest fails closed with nothing restored. Everything else is preserved
 * and reported pending.
 */
export async function recoverFallbackJournal (trackingPath: string): Promise<{ pending: boolean; recovered: boolean; restoredPaths: string[]; preservedArtifacts: string[]; preservedPaths: string[] }> {
  const preservedArtifacts: string[] = []
  const preservedPaths: string[] = []
  const restoredPaths: string[] = []
  const journalPath = fallbackJournalPath(trackingPath)
  if (!existsSync(journalPath)) return { pending: false, recovered: true, restoredPaths, preservedArtifacts, preservedPaths }
  let journal: FallbackJournal
  try {
    journal = strictLoad(journalPath)
  } catch {
    preservedArtifacts.push(journalPath)
    return { pending: true, recovered: false, restoredPaths, preservedArtifacts, preservedPaths }
  }
  // A live mutator still owns the transaction; never run concurrently with it.
  if (journal.mutator !== undefined && !processMatches(journal.mutator) && processIsLive(journal.mutator)) {
    return { pending: true, recovered: false, restoredPaths, preservedArtifacts, preservedPaths }
  }
  if (!snapshotShapeIsValid(journal)) {
    preservedArtifacts.push(journalPath)
    return { pending: true, recovered: false, restoredPaths, preservedArtifacts, preservedPaths }
  }
  // Tracking preflight BEFORE any live mutation: the tracking backup must
  // authenticate against the planned manifest tracking digest (raw backup
  // bytes), not merely against its own journaled entry digest. A rewritten
  // tracking backup with a recomputed entry digest leaves the manifest and
  // its hash untouched, so the entry self-check cannot see it — but the
  // forged bytes would then be installed as the live tracking file for
  // later consumers. Fail closed here with nothing restored.
  const trackingResolved = path.resolve(journal.manifest.trackingPath)
  const trackingEntry = journal.entries.find((entry) => path.resolve(entry.path) === trackingResolved)
  if (trackingEntry?.existed === true && trackingEntry.backup !== undefined) {
    if (trackingDigest(trackingEntry.backup) !== journal.manifest.trackingDigest) {
      preservedArtifacts.push(journalPath)
      if (journal.snapshotDirectory !== undefined) preservedArtifacts.push(path.resolve(journal.snapshotDirectory))
      preservedPaths.push(trackingResolved)
      return { pending: true, recovered: false, restoredPaths, preservedArtifacts, preservedPaths }
    }
  }
  // Narrow the restore scope to what the CURRENT tracking file declares owned.
  let currentTracking: TrackingData | undefined
  try {
    const parsed: unknown = JSON.parse(readFileSync(path.resolve(journal.manifest.trackingPath), 'utf8'))
    if (isValidTrackingData(parsed)) currentTracking = parsed as TrackingData
  } catch { currentTracking = undefined }
  const ownedPaths = new Set<string>([path.resolve(journal.manifest.trackingPath)])
  if (currentTracking !== undefined) {
    for (const skill of currentTracking.skills) {
      for (const owned of [skill.path, ...Object.values(skill.paths ?? {})]) {
        if (typeof owned === 'string') ownedPaths.add(path.resolve(owned))
      }
    }
    for (const server of currentTracking.mcpServers) ownedPaths.add(path.resolve(server.configPath))
  }
  let recovered = true
  // Planned-missing frontiers are never restored by next-run recovery: a
  // live frontier (including any descendants the tracking file now names) is
  // preserved and reported as incomplete, while an absent frontier satisfies
  // the original missing state. Live presence is checked directly on the
  // filesystem, never inferred from reporting fields.
  const frontierPaths = new Set(journal.manifest.plannedMissingFrontiers.map((frontier) => path.resolve(frontier.frontierPath)))
  for (const entry of journal.entries) {
    const resolved = path.resolve(entry.path)
    // A durable frontierRollbackPending entry blocks recovery entirely for
    // that target: the ambiguous physical state is preserved and reported,
    // never cleaned or restored-over (disk state is reporting/blocking only).
    if (entry.frontierRollbackPending === true) {
      preservedPaths.push(resolved)
      if (entry.quarantine !== undefined) {
        preservedArtifacts.push(path.dirname(path.resolve(entry.quarantine)))
        preservedPaths.push(path.resolve(entry.quarantine))
      }
      recovered = false
      continue
    }
    if (frontierPaths.has(resolved)) {
      if (await pathKind(resolved) !== 'missing') {
        preservedPaths.push(resolved)
        recovered = false
      }
      continue
    }
    if (!ownedPaths.has(resolved)) {
      if (entry.existed) preservedPaths.push(resolved)
      continue
    }
    if (!entry.existed) continue
    if (!entry.backup || await pathKind(entry.backup) !== entry.kind || await pathDigest(entry.backup) !== entry.digest) {
      recovered = false
      preservedPaths.push(resolved)
      continue
    }
    // Ancestor-chain authentication BEFORE any filesystem mutation on this
    // target: the complete live chain must be provable as real non-link
    // directories, otherwise a substituted ancestor could redirect the
    // rename/copy below to a foreign location. Fail closed and preserve.
    const ancestorChain = await captureLiveAncestorChain(resolved)
    if (ancestorChain === undefined) {
      recovered = false
      preservedPaths.push(resolved)
      continue
    }
    try {
      const kind = await pathKind(resolved)
      if (kind === entry.kind && kind !== 'missing' && await pathDigest(resolved) === entry.digest) continue
      if (!await liveAncestorChainMatches(ancestorChain)) throw new Error('recovery ancestor chain was replaced')
      const storage = await mkdtemp(path.join(path.dirname(resolved), `.${path.basename(resolved).replace(/^\.+/, '')}.nsolid-recovery-`))
      let storagePreserved = false
      try {
        const moved = path.join(storage, path.basename(resolved))
        if (kind !== 'missing') {
          if (!await liveAncestorChainMatches(ancestorChain)) throw new Error('recovery ancestor chain was replaced')
          await rename(resolved, moved)
        }
        const temporary = path.join(storage, 'payload')
        await cp(entry.backup, temporary, { recursive: true, verbatimSymlinks: true, dereference: false })
        if (await pathDigest(temporary) !== entry.digest || await pathKind(temporary) !== entry.kind) throw new Error('recovery copy mismatch')
        // The install into the live tree must still traverse only the exact
        // proven ancestor identities: a mid-operation replacement aborts
        // here with the live target already quarantined (reported pending).
        if (!await liveAncestorChainMatches(ancestorChain)) throw new Error('recovery ancestor chain was replaced')
        await rename(temporary, resolved)
        // The live bytes now hold the authenticated tracked state: record the
        // restoration even if the storage cleanup below is preserved.
        restoredPaths.push(resolved)
        // Cleanup may only run while the chain is still the exact proven
        // one; otherwise the storage container is preserved and reported
        // rather than removed through an unproven ancestor.
        if (!await liveAncestorChainMatches(ancestorChain)) {
          storagePreserved = true
          preservedArtifacts.push(storage)
          recovered = false
          preservedPaths.push(resolved)
          continue
        }
        await rm(storage, { recursive: true, force: true }).catch(() => {})
      } catch (error) {
        if (storagePreserved) throw error
        // Preserve the quarantine storage untouched on any failure: it may
        // hold the replaced live state and its chain can no longer be
        // proven, so recursive removal is never attempted.
        preservedArtifacts.push(storage)
        throw error
      }
    } catch {
      recovered = false
      preservedPaths.push(resolved)
    }
  }
  // The journal and its snapshot always survive next-run recovery.
  preservedArtifacts.push(journalPath)
  if (journal.snapshotDirectory !== undefined) preservedArtifacts.push(path.resolve(journal.snapshotDirectory))
  return { pending: true, recovered, restoredPaths: dedupePaths(restoredPaths), preservedArtifacts: dedupePaths(preservedArtifacts), preservedPaths: dedupePaths(preservedPaths) }
}

/**
 * Read-only pending-journal inspection for `--check` plans. It answers
 * whether a pending journal blocks the plan without creating recovery
 * storage, renaming, copying, removing, or rewriting any journal, tracking,
 * snapshot, or backup bytes. Live digests are only read and compared so the
 * guidance can name the paths left for manual inspection. The returned shape
 * matches next-run recovery, except `restoredPaths` is always empty: an
 * inspection never restores anything.
 */
export async function inspectFallbackJournal (trackingPath: string): Promise<{ pending: boolean; recovered: boolean; restoredPaths: string[]; preservedArtifacts: string[]; preservedPaths: string[] }> {
  const journalPath = fallbackJournalPath(trackingPath)
  if (!existsSync(journalPath)) return { pending: false, recovered: true, restoredPaths: [], preservedArtifacts: [], preservedPaths: [] }
  let journal: FallbackJournal
  try {
    journal = strictLoad(journalPath)
  } catch {
    return { pending: true, recovered: false, restoredPaths: [], preservedArtifacts: [journalPath], preservedPaths: [] }
  }
  // A live mutator still owns the transaction; report pending without
  // touching anything.
  if (journal.mutator !== undefined && !processMatches(journal.mutator) && processIsLive(journal.mutator)) {
    return { pending: true, recovered: false, restoredPaths: [], preservedArtifacts: [], preservedPaths: [] }
  }
  if (!snapshotShapeIsValid(journal)) {
    return { pending: true, recovered: false, restoredPaths: [], preservedArtifacts: [journalPath], preservedPaths: [] }
  }
  const preservedArtifacts = [journalPath]
  if (journal.snapshotDirectory !== undefined) preservedArtifacts.push(path.resolve(journal.snapshotDirectory))
  // Narrow the reported scope exactly like next-run recovery: what the
  // CURRENT tracking file declares owned. Read-only; the file is never
  // written.
  let currentTracking: TrackingData | undefined
  try {
    const parsed: unknown = JSON.parse(readFileSync(path.resolve(journal.manifest.trackingPath), 'utf8'))
    if (isValidTrackingData(parsed)) currentTracking = parsed as TrackingData
  } catch { currentTracking = undefined }
  const ownedPaths = new Set<string>([path.resolve(journal.manifest.trackingPath)])
  if (currentTracking !== undefined) {
    for (const skill of currentTracking.skills) {
      for (const owned of [skill.path, ...Object.values(skill.paths ?? {})]) {
        if (typeof owned === 'string') ownedPaths.add(path.resolve(owned))
      }
    }
    for (const server of currentTracking.mcpServers) ownedPaths.add(path.resolve(server.configPath))
  }
  const preservedPaths: string[] = []
  let recovered = true
  // The same tracking preflight as next-run recovery, read-only: a tracking
  // backup that disagrees with the planned manifest digest is reported
  // pending without restoring anything.
  const trackingResolved = path.resolve(journal.manifest.trackingPath)
  const trackingEntry = journal.entries.find((entry) => path.resolve(entry.path) === trackingResolved)
  if (trackingEntry?.existed === true && trackingEntry.backup !== undefined) {
    if (trackingDigest(trackingEntry.backup) !== journal.manifest.trackingDigest) {
      preservedPaths.push(trackingResolved)
      return { pending: true, recovered: false, restoredPaths: [], preservedArtifacts: dedupePaths(preservedArtifacts), preservedPaths: dedupePaths(preservedPaths) }
    }
  }
  const frontierPaths = new Set(journal.manifest.plannedMissingFrontiers.map((frontier) => path.resolve(frontier.frontierPath)))
  for (const entry of journal.entries) {
    const resolved = path.resolve(entry.path)
    if (entry.frontierRollbackPending === true) {
      preservedPaths.push(resolved)
      if (entry.quarantine !== undefined) {
        preservedArtifacts.push(path.dirname(path.resolve(entry.quarantine)))
        preservedPaths.push(path.resolve(entry.quarantine))
      }
      recovered = false
      continue
    }
    if (frontierPaths.has(resolved)) {
      if (await pathKind(resolved) !== 'missing') {
        preservedPaths.push(resolved)
        recovered = false
      }
      continue
    }
    if (!ownedPaths.has(resolved)) {
      if (entry.existed) preservedPaths.push(resolved)
      continue
    }
    if (!entry.existed) continue
    if (!entry.backup || await pathKind(entry.backup) !== entry.kind || await pathDigest(entry.backup) !== entry.digest) {
      preservedPaths.push(resolved)
      recovered = false
      continue
    }
    // Ancestor-chain authentication BEFORE trusting live bytes: the complete
    // live chain must be provable as real non-link directories, otherwise a
    // substituted ancestor could present byte-identical content that next-run
    // recovery would refuse to traverse. A byte-identical skill under a
    // symlink-substituted parent is reported preserved for manual inspection,
    // never as needing no restoration. Read-only; the chain is captured with
    // lstat and never followed, mutated, or used for ownership classification.
    const ancestorChain = await captureLiveAncestorChain(resolved)
    if (ancestorChain === undefined) {
      preservedPaths.push(resolved)
      recovered = false
      continue
    }
    const kind = await pathKind(resolved)
    if (kind === entry.kind && kind !== 'missing' && await pathDigest(resolved) === entry.digest) continue
    preservedPaths.push(resolved)
    recovered = false
  }
  return { pending: true, recovered, restoredPaths: [], preservedArtifacts: dedupePaths(preservedArtifacts), preservedPaths: dedupePaths(preservedPaths) }
}

/** Strict reload for a handle: any missing, malformed, replaced, stale-revision, or mismatched disk state throws; the stale in-memory object is never returned. */
export async function reloadFallbackJournal (handle: FallbackJournalHandle): Promise<FallbackJournal> {
  if (!handleMatchesIssuedMetadata(handle)) throw new Error('Invalid fallback journal')
  const journal = strictLoad(handle.journalPath)
  if (journal.transactionId !== handle.transactionId) throw new Error('Invalid fallback journal')
  if (journal.manifestDigest !== handle.manifestDigest || manifestDigestOf(journal.manifest) !== handle.manifestDigest) throw new Error('Invalid fallback journal')
  if (!sameManifest(journal.manifest, handle.manifest)) throw new Error('Invalid fallback journal')
  if (journal.revision !== handle.revision) throw new Error('Invalid fallback journal')
  return journal
}

function strictLoad (journalPath: string): FallbackJournal {
  const parsed = JSON.parse(readFileSync(journalPath, 'utf8')) as FallbackJournal
  if (!isSafeJournal(parsed) || parsed.journalPath !== path.resolve(journalPath)) throw new Error('Invalid fallback journal')
  if (manifestDigestOf(parsed.manifest) !== parsed.manifestDigest) throw new Error('Invalid fallback journal')
  return parsed
}

function requireRole (journal: FallbackJournal, handle: FallbackJournalHandle, role: 'owner' | 'mutator'): void {
  if (handle.role !== role) throw new Error('Invalid fallback journal')
  if (role === 'mutator') {
    if (journal.mutator === undefined || !processMatches(journal.mutator)) throw new Error('Invalid fallback journal')
  } else if (!processMatches(journal.owner)) {
    throw new Error('Invalid fallback journal')
  }
}

/**
 * Compare-and-set durable write: the disk revision must equal expectedRevision,
 * the written record itself carries the incremented revision (every later
 * strict reload compares against it), and the new revision is returned.
 */
/**
 * Compare-and-set durable write: the on-disk journal must be SEMANTICALLY
 * IDENTICAL to the exact expected prior state — full deep equality, never
 * revision equality alone — before it is replaced. Same-revision tampering of
 * any field (transaction identity, manifest, entries, pending/quarantine
 * markers) therefore fails closed instead of being overwritten. Property
 * order is irrelevant and undefined-valued keys dropped by JSON
 * serialization are canonicalized away, so only true semantic divergence
 * rejects. The written record itself carries the incremented revision (every
 * later strict reload compares against it) and the new revision is returned.
 */
async function casWrite (journalPath: string, next: FallbackJournal, expectedPrior: FallbackJournal): Promise<number> {
  const disk: unknown = JSON.parse(await readFile(journalPath, 'utf8'))
  if (!isDeepStrictEqual(disk, JSON.parse(JSON.stringify(expectedPrior)))) throw new Error('Invalid fallback journal')
  await writeDurable(journalPath, { ...next, revision: expectedPrior.revision + 1 })
  return expectedPrior.revision + 1
}

async function withCasWrite (handle: FallbackJournalHandle, next: FallbackJournal, expectedPrior: FallbackJournal): Promise<FallbackJournal> {
  const revision = await casWrite(handle.journalPath, next, expectedPrior)
  return { ...next, revision }
}

async function writeDurable (filePath: string, value: unknown): Promise<void> {
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
  const handle = await open(temporary, 'r+')
  try { await handle.sync() } finally { await handle.close() }
  await rename(temporary, filePath)
  try {
    const directory = await open(path.dirname(filePath), 'r')
    await directory.sync()
    await directory.close()
  } catch { /* directory fsync is unavailable on some platforms */ }
}

async function manifestMatchesTrackingFile (manifest: FallbackTransactionIdentity): Promise<boolean> {
  try {
    const tracking = JSON.parse(await readFile(manifest.trackingPath, 'utf8')) as unknown
    return isValidTrackingData(tracking) && matchesTrackedOwnership(tracking as TrackingData, manifest)
  } catch {
    return false
  }
}

async function journalOwnershipIsValid (journal: FallbackJournal): Promise<boolean> {
  const trackingPath = path.resolve(journal.manifest.trackingPath)
  const trackingEntry = journal.entries.find((entry) => path.resolve(entry.path) === trackingPath)
  if (!trackingEntry?.existed || !trackingEntry.digest || !trackingEntry.backup) return false
  if (await pathDigest(trackingEntry.backup) !== trackingEntry.digest) return false
  if (trackingDigest(trackingEntry.backup) !== journal.manifest.trackingDigest) return false
  try {
    const tracking = JSON.parse(await readFile(trackingEntry.backup, 'utf8')) as unknown
    return isValidTrackingData(tracking) && matchesTrackedOwnership(tracking as TrackingData, journal.manifest)
  } catch {
    return false
  }
}

/** Manifest-evidence authentication for one backup. Tracking authenticates by raw byte digest. */
async function backupAuthenticates (entry: FallbackJournalEntry, evidence: Map<string, FallbackPathEvidence>, manifest: FallbackTransactionIdentity): Promise<boolean> {
  if (entry.backup === undefined) return false
  const resolved = path.resolve(entry.path)
  if (resolved === path.resolve(manifest.trackingPath)) {
    return trackingDigest(entry.backup) === manifest.trackingDigest
  }
  const entryEvidence = evidence.get(resolved)
  if (entryEvidence === undefined || entryEvidence.kind === 'missing') return false
  return await pathKind(entry.backup) === entryEvidence.kind && await pathDigest(entry.backup) === entryEvidence.digest
}

function snapshotStructuralNameIsValid (journal: FallbackJournal): boolean {
  if (journal.snapshotDirectory === undefined) return false
  const snapshot = path.resolve(journal.snapshotDirectory)
  const trackingPath = path.resolve(journal.manifest.trackingPath)
  if (path.dirname(snapshot) !== path.dirname(trackingPath)) return false
  return /^\.nsolid-plugin-update-[A-Za-z0-9._-]{6}$/.test(path.basename(snapshot))
}

/**
 * Filesystem-aware gate run before any destructive use of the snapshot: the
 * journal threat model is a forged file in a user-writable location, and
 * lexical containment cannot see symlinked path components. Fail closed
 * whenever reality cannot be proven; artifacts then survive untouched.
 */
function snapshotShapeIsValid (journal: FallbackJournal): boolean {
  if (journal.phase === 'initializing') return false
  if (!snapshotStructuralNameIsValid(journal)) return false
  const snapshot = path.resolve(journal.snapshotDirectory!)
  try {
    const stat = lstatSync(snapshot)
    if (!stat.isDirectory()) return false
    const realParent = realpathSyncSafe(path.dirname(path.resolve(journal.manifest.trackingPath)))
    const realSnapshot = realpathSyncSafe(snapshot)
    if (realSnapshot === undefined || realParent === undefined) return false
    if (realSnapshot === realParent || !realSnapshot.startsWith(realParent + path.sep)) return false
    for (const entry of journal.entries) {
      if (entry.backup === undefined) continue
      // A verbatim-copied symlink backup legitimately resolves to a target
      // outside the snapshot, so only its containing directory is required
      // to be the real snapshot itself.
      if (realpathSyncSafe(path.dirname(entry.backup)) !== realSnapshot) return false
    }
    return true
  } catch {
    return false
  }
}

function realpathSyncSafe (target: string): string | undefined {
  try {
    return realpathSync(target)
  } catch {
    return undefined
  }
}

async function renameLiveToRestoreQuarantine (resolved: string, capabilities: Map<string, ArtifactCapability>): Promise<boolean> {
  try {
    const kind = await pathKind(resolved)
    if (kind === 'missing') return true
    const storage = await mkdtemp(path.join(path.dirname(resolved), `.${path.basename(resolved).replace(/^\.+/, '')}.nsolid-quarantine-`))
    const payload = path.join(storage, path.basename(resolved))
    const token = randomUUID()
    await writeFile(path.join(storage, `.nsolid-quarantine-${token}`), token, { mode: 0o600 })
    const identity = await lstat(storage)
    await rename(resolved, payload)
    capabilities.set(resolved, {
      container: storage,
      payload,
      token,
      role: 'restore',
      dev: identity.dev,
      ino: identity.ino,
      children: new Map([
        [path.basename(payload), kind],
        [`.nsolid-quarantine-${token}`, 'file'],
      ]),
    })
    return true
  } catch {
    return false
  }
}

/** Kind check for one readdir dirent against the recorded fallback path kind. */
function direntKindMatches (dirent: Dirent, expected: FallbackPathKind): boolean {
  if (dirent.isSymbolicLink()) return expected === 'symlink'
  if (dirent.isDirectory()) return expected === 'directory'
  if (dirent.isFile()) return expected === 'file'
  return expected === 'other'
}

/**
 * Exact direct-child structure check against the structure recorded when this
 * process created the container: every child known, no child missing, and
 * every kind as recorded. An extra sentinel child, a missing payload, or a
 * kind mismatch fails closed — the whole container is then preserved and
 * reported instead of recursively deleted. A capability without a recorded
 * structure is never removable (fail closed).
 */
async function containerMatchesCapability (capability: ArtifactCapability, container?: string): Promise<boolean> {
  if (capability.children === undefined) return false
  let dirents: Dirent[]
  try {
    dirents = await readdir(container ?? capability.container, { withFileTypes: true })
  } catch {
    return false
  }
  if (dirents.length !== capability.children.size) return false
  for (const dirent of dirents) {
    const expected = capability.children.get(dirent.name)
    if (expected === undefined) return false
    if (!direntKindMatches(dirent, expected)) return false
  }
  return true
}

/**
 * Trusted removal of one container this process created. Every layer must
 * prove out immediately before destruction, or the container is preserved:
 * 1. the container is still a real, non-link directory with the recorded
 *    dev/ino identity;
 * 2. its direct children exactly match the role-specific structure recorded
 *    at creation time (required marker/payload children only — no unexpected
 *    sentinel content, correct kinds, no links);
 * 3. the marker file is a regular non-link file carrying the exact token;
 * 4. the dev/ino identity is rechecked immediately before the tombstone
 *    rename, closing the validation→rename window as far as the platform
 *    allows (the awaited swap seam runs here for tests only);
 * 5. after the rename, the tombstone is proven to BE the authenticated inode
 *    AND to still carry the exact recorded structure — a replacement swapped
 *    into the path in that window (or content smuggled into it) is renamed
 *    back untouched, and nothing old or new is deleted.
 */
async function removeAuthenticatedContainer (capability: ArtifactCapability): Promise<boolean> {
  try {
    const stat = await lstat(capability.container)
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false
    if (capability.dev !== undefined && capability.ino !== undefined && (stat.dev !== capability.dev || stat.ino !== capability.ino)) return false
    if (!await containerMatchesCapability(capability)) return false
    if (capability.role !== 'snapshot') {
      const prefix = capability.role === 'stage' ? 'nsolid-stage' : 'nsolid-quarantine'
      const markerPath = path.join(capability.container, `.${prefix}-${capability.token}`)
      const marker = await lstat(markerPath).catch(() => undefined)
      if (marker === undefined || !marker.isFile() || marker.isSymbolicLink()) return false
      if (await readFile(markerPath, 'utf8') !== capability.token) return false
    }
    // Immediate pre-rename identity recheck: the removal decision and the
    // rename must be as close together as the platform allows.
    const identity = await lstat(capability.container)
    if (!identity.isDirectory() || identity.isSymbolicLink()) return false
    if (capability.dev !== undefined && capability.ino !== undefined && (identity.dev !== capability.dev || identity.ino !== capability.ino)) return false
    if (fallbackArtifactSwapSeam !== undefined) await fallbackArtifactSwapSeam({ container: capability.container, role: capability.role })
    const tombstone = `${capability.container}.tombstone-${randomUUID().slice(0, 8)}`
    try {
      await rename(capability.container, tombstone)
    } catch {
      return false
    }
    // Post-rename proof: only the authenticated inode with the recorded
    // structure may be destroyed. Anything else at the tombstone path is a
    // replacement: it goes back to the container path, fully preserved.
    const moved = await lstat(tombstone).catch(() => undefined)
    const replaced = moved === undefined || !moved.isDirectory() || moved.isSymbolicLink() ||
      (capability.dev !== undefined && capability.ino !== undefined && (moved.dev !== capability.dev || moved.ino !== capability.ino)) ||
      !await containerMatchesCapability(capability, tombstone)
    if (replaced) {
      await rename(tombstone, capability.container).catch(() => {})
      return false
    }
    await rm(tombstone, { recursive: true, force: true })
    return true
  } catch {
    return false
  }
}

async function tryRemoveByCapability (capabilities: Map<string, ArtifactCapability>, container: string): Promise<boolean> {
  for (const capability of capabilities.values()) {
    if (capability.container === path.resolve(container)) {
      return await removeAuthenticatedContainer(capability)
    }
  }
  return false
}

async function cleanupRestoreArtifacts (
  journal: FallbackJournal,
  handle: FallbackJournalHandle,
  restoreCapabilities: Map<string, ArtifactCapability>,
  preservedArtifacts: string[]
): Promise<void> {
  const plannedMissing = new Set(journal.entries.filter((entry) => !entry.existed).map((entry) => path.resolve(entry.path)))
  for (const entry of journal.entries) {
    for (const artifact of [entry.stage !== undefined ? path.dirname(entry.stage) : undefined, entry.quarantine !== undefined ? path.dirname(entry.quarantine) : undefined]) {
      if (artifact === undefined) continue
      const byRestore = await tryRemoveByCapability(restoreCapabilities, artifact)
      const removed = byRestore || await tryRemoveByCapability(capabilitiesFor(handle), artifact)
      if (!removed) preservedArtifacts.push(artifact)
    }
  }
  for (const [target, capability] of restoreCapabilities.entries()) {
    // Quarantined bytes of a PLANNED-MISSING destination are never destroyed
    // by a rollback: the worst case a forged journal can achieve is moving a
    // plan-derived destination into a quarantine, preserved and reported.
    if (plannedMissing.has(target)) {
      preservedArtifacts.push(capability.container)
      continue
    }
    const removed = await removeAuthenticatedContainer(capability).catch(() => false)
    if (!removed) preservedArtifacts.push(capability.container)
  }
  const snapshotCapability = capabilitiesFor(handle).get('\0snapshot')
  if (snapshotCapability !== undefined && journal.snapshotDirectory !== undefined && snapshotCapability.container === path.resolve(journal.snapshotDirectory)) {
    const removed = await removeAuthenticatedContainer(snapshotCapability).catch(() => false)
    if (!removed) preservedArtifacts.push(snapshotCapability.container)
  }
}

async function readReportingResidues (journalPath: string): Promise<{ preservedArtifacts: string[]; preservedPaths: string[] }> {
  try {
    const disk = JSON.parse(await readFile(journalPath, 'utf8')) as FallbackJournal
    return {
      preservedArtifacts: [...(disk.preservedArtifacts ?? [])],
      preservedPaths: [...(disk.preservedPaths ?? [])],
    }
  } catch {
    return { preservedArtifacts: [], preservedPaths: [] }
  }
}

function dedupePaths (values: readonly string[]): string[] {
  return [...new Set(values.map((value) => path.resolve(value)))].sort((left, right) => Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8')))
}

function isEvidenceShape (value: unknown): value is FallbackPathEvidence {
  if (!value || typeof value !== 'object') return false
  const entry = value as { path?: unknown; kind?: unknown; digest?: unknown }
  if (typeof entry.path !== 'string' || !['missing', 'file', 'directory', 'symlink', 'other'].includes(String(entry.kind))) return false
  return entry.kind === 'missing' ? entry.digest === undefined : typeof entry.digest === 'string'
}

function isSafeJournal (journal: FallbackJournal): boolean {
  if (!journal || journal.version !== 3 || !['initializing', 'prepared', 'mutating'].includes(journal.phase)) return false
  if (!Number.isSafeInteger(journal.revision) || journal.revision < 0) return false
  if (typeof journal.transactionId !== 'string' || journal.transactionId.length === 0) return false
  if (typeof journal.manifestDigest !== 'string' || !/^[0-9a-f]{64}$/.test(journal.manifestDigest)) return false
  if (!processIdentityShapeIsValid(journal.owner)) return false
  if (journal.mutator !== undefined && (!processIdentityShapeIsValid(journal.mutator) || typeof journal.mutator.claimedAt !== 'string' || !Number.isFinite(Date.parse(journal.mutator.claimedAt)))) return false
  const manifest = journal.manifest
  if (!manifest || !Array.isArray(manifest.ownedSkills) || !Array.isArray(manifest.ownedLinks) || !Array.isArray(manifest.ownedMcpFields) || !Array.isArray(manifest.ownedMcpConfigPaths)) return false
  if (!Array.isArray(manifest.approvedDestinationRoots)) return false
  if (manifest.ownedMcpConfigPaths.some((value) => typeof value !== 'string' && !isEvidenceShape(value))) return false
  if (manifest.bundleDestinations !== undefined && (!Array.isArray(manifest.bundleDestinations) || manifest.bundleDestinations.some((value) => !isEvidenceShape(value)))) return false
  // Only the exact deployed protocol is a valid journal manifest: anything
  // else (missing, older, newer) fails closed everywhere a journal is loaded.
  if (manifest.protocolVersion !== FALLBACK_PROTOCOL_VERSION) return false
  // protocol v3 also requires exactly-parsed frontier evidence: an on-disk
  // journal whose manifest lacks or corrupts plannedMissingFrontiers is not a
  // valid v3 journal and can never be loaded as transaction state.
  try {
    assertFallbackFrontierEvidenceList(manifest.plannedMissingFrontiers)
  } catch {
    return false
  }
  if (manifest.digestAlgorithm !== undefined && manifest.digestAlgorithm !== 'fallback-path-v2') return false
  if (manifest.ownedMcpFields.some((field) => !field || typeof field.configPath !== 'string' || typeof field.server !== 'string' || typeof field.field !== 'string' || typeof field.expectedDigest !== 'string')) return false
  if (manifest.ownedSkills.some((entry) => !isEvidenceShape(entry)) || manifest.ownedLinks.some((entry) => !isEvidenceShape(entry))) return false
  if (typeof manifest.trackingPath !== 'string' || typeof manifest.trackingDigest !== 'string' || typeof manifest.harness !== 'string' || typeof manifest.installationId !== 'string') return false
  if (manifest.nonce !== undefined && typeof manifest.nonce !== 'string') return false
  if (typeof journal.journalPath !== 'string') return false
  const trackingPath = path.resolve(manifest.trackingPath)
  if (journal.journalPath !== fallbackJournalPath(trackingPath)) return false
  if (journal.phase === 'initializing') {
    if (journal.snapshotDirectory !== undefined || journal.entries.length > 0) return false
  } else {
    // The snapshot must be exactly what beginFallbackJournal creates: a strict
    // direct child of the tracking directory carrying the mkdtemp suffix shape.
    if (!snapshotStructuralNameIsValid(journal)) return false
  }
  if (!manifest.installationId || manifest.installationId !== `${manifest.harness}:fallback`) return false
  // The journal's exact physical entry set is recomputed from the manifest
  // through the same shared derivation begin uses: retained ordinary targets
  // plus one planned-missing entry per topmost frontier. Entry insertion,
  // removal, path, kind, and digest tampering therefore cannot load.
  let physicalTargets: ReturnType<typeof deriveFallbackJournalPhysicalTargets>
  try {
    physicalTargets = deriveFallbackJournalPhysicalTargets(manifest)
  } catch {
    return false
  }
  const expectedPaths = new Set(physicalTargets.map((entry) => entry.path))
  const frontierPaths = new Set(physicalTargets.filter((entry) => entry.frontier).map((entry) => entry.path))
  const expectedEvidence = plannedEvidenceMap(manifest)
  if ([...expectedPaths].some((value) => !isCanonicalPath(value))) return false
  if ((manifest.approvedDestinationRoots as readonly string[]).map((value) => path.resolve(value)).some((value) => !isCanonicalPath(value))) return false
  const seen = new Set<string>()
  for (const entry of journal.entries) {
    if (!entry || typeof entry.path !== 'string' || typeof entry.existed !== 'boolean' || typeof entry.kind !== 'string') return false
    if (!['missing', 'file', 'directory', 'symlink', 'other'].includes(entry.kind)) return false
    if (entry.existed !== (entry.kind !== 'missing')) return false
    const target = path.resolve(entry.path)
    if (!isCanonicalPath(target) || !expectedPaths.has(target) || seen.has(target)) return false
    seen.add(target)
    if (entry.existed && typeof entry.digest !== 'string') return false
    if (!entry.existed && entry.digest !== undefined) return false
    if (frontierPaths.has(target)) {
      // A frontier entry is the planned-missing publication unit: it never
      // existed, carries no original-state digest, and never has a backup.
      // Documented mutable publication fields stay loadable so the
      // publication stage can extend this entry; they never grant restore
      // authority (the trusted manifest decides what a frontier is).
      if (entry.existed || entry.kind !== 'missing' || entry.digest !== undefined || entry.backup !== undefined) return false
    } else {
      const evidence = expectedEvidence.get(target)
      if (evidence !== undefined) {
        // Immutable original-state evidence must exactly match the manifest:
        // kind/digest tampering must never change what restore authenticates.
        if (entry.kind !== evidence.kind || entry.digest !== evidence.digest) return false
      } else if (target === trackingPath) {
        // The tracking file existed at journal time (begin hashed it).
        if (!entry.existed || entry.kind === 'missing') return false
      }
      if (!entry.existed && entry.backup !== undefined) return false
    }
    if (entry.backup !== undefined) {
      const backup = path.resolve(entry.backup)
      // A backup must live strictly inside the snapshot; equality would let a
      // forged entry alias the snapshot container itself.
      if (journal.snapshotDirectory === undefined) return false
      const snapshot = path.resolve(journal.snapshotDirectory)
      if (backup === snapshot || !isSameOrContained(backup, snapshot) || !isCanonicalPath(backup)) return false
    }
    // Stage payloads and quarantine payloads live inside an exact sibling
    // container of the target: the record points at <container>/payload (or
    // <container>/<target-basename>), so the CONTAINER's parent must equal the
    // target's parent.
    if (entry.stage !== undefined) {
      const stageContainer = path.resolve(path.dirname(entry.stage))
      if (path.dirname(stageContainer) !== path.dirname(target) || !isCanonicalPath(stageContainer)) return false
      if (!/^\.[^/\\]*\.nsolid-stage-[A-Za-z0-9._-]{6}$/.test(path.basename(stageContainer))) return false
      if (path.basename(entry.stage) !== 'payload') return false
    }
    if (entry.stageDigest !== undefined && typeof entry.stageDigest !== 'string') return false
    if (entry.quarantine !== undefined) {
      const quarantineContainer = path.resolve(path.dirname(entry.quarantine))
      if (path.dirname(quarantineContainer) !== path.dirname(target) || !isCanonicalPath(quarantineContainer)) return false
      if (!/^\.[^/\\]*\.nsolid-quarantine-[A-Za-z0-9._-]{6}$/.test(path.basename(quarantineContainer))) return false
      if (path.basename(entry.quarantine) !== path.basename(target)) return false
    }
    // The durable rollback-pending flag is a strictly validated reporting/
    // blocking field: it must be a real boolean and may only appear on a
    // planned-missing entry (never on a backup-bearing preexisting one).
    if (entry.frontierRollbackPending !== undefined) {
      if (typeof entry.frontierRollbackPending !== 'boolean') return false
      if (entry.frontierRollbackPending && entry.existed) return false
    }
  }
  if (journal.phase !== 'initializing' && [...expectedPaths].some((target) => !seen.has(target))) return false
  for (const field of ['preservedArtifacts', 'preservedPaths'] as const) {
    const values = journal[field]
    if (values === undefined) continue
    if (!Array.isArray(values) || values.length > 64 || values.some((value) => typeof value !== 'string' || !path.isAbsolute(value) || value.includes('..') || value.length > 512)) return false
  }
  return true
}

function processIdentityShapeIsValid (identity: ProcessIdentity | undefined): boolean {
  return identity !== undefined && Number.isSafeInteger(identity.pid) && identity.pid > 0 &&
    (identity.startIdentity === undefined || typeof identity.startIdentity === 'string')
}

function sameManifest (left: FallbackTransactionIdentity, right: FallbackTransactionIdentity): boolean {
  // Canonical comparison: object key order can never make two equal manifests
  // look different (JSON.stringify order dependence was a v2 hazard).
  try {
    return canonicalJsonString(left) === canonicalJsonString(right)
  } catch {
    return false
  }
}
