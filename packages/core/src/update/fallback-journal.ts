import { createHash, randomUUID } from 'node:crypto'
import { cp, lstat, mkdtemp, open, readFile, realpath, readlink, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type { FallbackTransactionIdentity } from './types.js'
import { isValidTrackingData, type TrackingData } from '../skills/skill-tracker.js'
import { isCanonicalPath, isSameOrContained, matchesTrackedOwnership } from './fallback-ownership.js'
import { assertSafeSkillName } from '../utils/skill-name.js'

export type FallbackJournalPhase = 'prepared' | 'mutating' | 'committed'
export type FallbackPathKind = 'missing' | 'file' | 'directory' | 'symlink' | 'other'

export interface FallbackJournalEntry {
  path: string
  existed: boolean
  kind: FallbackPathKind
  /** Digest of the original live state at journal time. */
  digest?: string
  /** Backup of the original state inside the journal snapshot directory. */
  backup?: string
  /** Sibling staged payload (same volume) waiting to be swapped into place. */
  stage?: string
  stageDigest?: string
  /** Exact live state the parent is authorized to replace during rollback. */
  expectedCurrentDigest?: string | null
  /** Set once the staged payload (or deletion) has been swapped in. */
  applied?: boolean
  /** Sibling quarantine path receiving the replaced live bytes until commit. */
  quarantine?: string
}

export interface FallbackJournal {
  version: 2
  phase: FallbackJournalPhase
  manifest: FallbackTransactionIdentity
  journalPath: string
  snapshotDirectory: string
  /** Secret shared with the authorized child transaction. Authenticates only. */
  nonce?: string
  mutator?: { pid: number; nonce: string; claimedAt: string }
  entries: readonly FallbackJournalEntry[]
}

export interface FallbackJournalResult {
  journal: FallbackJournal
  rollbackSucceeded?: boolean
}

export function trackingDigest (trackingPath: string): string | undefined {
  try { return createHash('sha256').update(readFileSync(trackingPath)).digest('hex') } catch { return undefined }
}

export function fallbackJournalPath (trackingPath: string): string {
  return `${path.resolve(trackingPath)}.update-journal.json`
}

export async function beginFallbackJournal (manifest: FallbackTransactionIdentity): Promise<FallbackJournalResult> {
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
  const journalPath = fallbackJournalPath(trackingPath)
  const snapshotDirectory = await mkdtemp(path.join(path.dirname(trackingPath), '.nsolid-plugin-update-'))
  const plannedEvidence = new Map([...manifest.ownedSkills, ...manifest.ownedLinks]
    .map((entry) => [path.resolve(entry.path), entry] as const))
  const paths = [...new Set([
    trackingPath,
    ...manifest.ownedSkills.map((entry) => entry.path),
    ...manifest.ownedLinks.map((entry) => entry.path),
    ...manifest.ownedMcpConfigPaths,
  ].map((value) => path.resolve(value)))]
  const entries: FallbackJournalEntry[] = []
  try {
    for (const [index, target] of paths.entries()) {
      const kind = await pathKind(target)
      const backup = path.join(snapshotDirectory, String(index))
      const digest = kind !== 'missing' ? await pathDigest(target) : undefined
      if (kind !== 'missing' && !digest) throw new Error(`cannot digest ${target}`)
      const planned = plannedEvidence.get(target)
      if (planned && (planned.kind !== kind || planned.digest !== digest)) throw new Error(`planned fallback path changed: ${target}`)
      if (kind !== 'missing') await cp(target, backup, { recursive: true, force: true, verbatimSymlinks: true, dereference: false })
      if (planned && kind !== 'missing' && (await pathDigest(backup) !== planned.digest || await pathDigest(target) !== planned.digest)) {
        throw new Error(`fallback path changed while it was being snapshotted: ${target}`)
      }
      entries.push({ path: target, kind, existed: kind !== 'missing', digest, backup: kind !== 'missing' ? backup : undefined, expectedCurrentDigest: digest ?? null })
    }
    const journal: FallbackJournal = {
      version: 2,
      phase: 'prepared',
      manifest,
      journalPath,
      snapshotDirectory,
      nonce: manifest.nonce ?? randomUUID(),
      entries,
    }
    await writeDurable(journalPath, journal)
    return { journal }
  } catch (error) {
    await rm(snapshotDirectory, { recursive: true, force: true }).catch(() => {})
    throw new Error('FALLBACK_BACKUP_FAILED', { cause: error })
  }
}

/**
 * Durable append of new bundle destinations (skills and harness links) that
 * were unknown when the parent created the journal. The verified child calls
 * this before staging anything: each destination that is not journaled yet
 * becomes an entry whose original state (usually `missing`) is snapshotted
 * first, so recovery can explain and undo the created path.
 */
export async function appendFallbackJournalEntries (journal: FallbackJournal, targets: readonly string[]): Promise<FallbackJournal> {
  journal = await reloadFallbackJournal(journal)
  if (!isSafeJournal(journal) || !await journalOwnershipIsValid(journal)) throw new Error('Invalid fallback journal')
  const approvedRoots = new Set((journal.manifest.approvedDestinationRoots ?? []).map((value) => path.resolve(value)))
  const entries = [...journal.entries]
  for (const target of targets) {
    const resolved = path.resolve(target)
    if (entries.some((entry) => path.resolve(entry.path) === resolved)) continue
    // Defense in depth: the child may only journal new destinations directly
    // inside a manifest-approved root, under a safe skill name.
    if (!approvedRoots.has(path.dirname(resolved))) throw new Error(`Fallback destination ${resolved} is outside the approved destination roots`)
    try {
      assertSafeSkillName(path.basename(resolved))
    } catch {
      throw new Error(`Fallback destination ${resolved} has an unsafe name`)
    }
    const kind = await pathKind(resolved)
    if (kind !== 'missing') throw new Error('UNTRACKED_DESTINATION')
    entries.push({ path: resolved, kind, existed: false, expectedCurrentDigest: null })
  }
  if (entries.length === journal.entries.length) return journal
  const updated = { ...journal, entries }
  await writeDurable(journal.journalPath, updated)
  return updated
}

export async function markFallbackJournalMutating (journal: FallbackJournal): Promise<FallbackJournal> {
  const updated = { ...journal, phase: 'mutating' as const }
  await writeDurable(journal.journalPath, updated)
  return updated
}

/**
 * Claim the right to mutate. The manifest nonce authenticates the child
 * process spawned by the journal owner; it never authorizes a destructive
 * restoration by itself.
 */
export async function claimFallbackJournalMutation (manifest: FallbackTransactionIdentity, pid = process.pid): Promise<boolean> {
  const journalPath = fallbackJournalPath(manifest.trackingPath)
  if (!existsSync(journalPath)) return true
  try {
    const journal = JSON.parse(await readFile(journalPath, 'utf8')) as FallbackJournal
    if (!isSafeJournal(journal) || journal.phase !== 'mutating' || !sameManifest(journal.manifest, manifest)) return false
    if (!journal.nonce || journal.nonce !== manifest.nonce) return false
    if (!await journalOwnershipIsValid(journal)) return false
    await writeDurable(journalPath, { ...journal, mutator: { pid, nonce: manifest.nonce ?? '', claimedAt: new Date().toISOString() } })
    return true
  } catch {
    return false
  }
}

/** Register a staged replacement payload for one entry. The stage is a sibling of the target. */
export async function registerFallbackStage (journal: FallbackJournal, target: string, payload: { directory?: string; bytes?: Buffer }): Promise<FallbackJournal> {
  journal = await reloadFallbackJournal(journal)
  if (!isSafeJournal(journal) || !await journalOwnershipIsValid(journal)) throw new Error('Invalid fallback journal')
  const resolved = path.resolve(target)
  const entry = journal.entries.find((candidate) => path.resolve(candidate.path) === resolved)
  if (!entry) throw new Error(`No fallback journal entry for ${resolved}`)
  const stageDirectory = await mkdtemp(path.join(path.dirname(resolved), `.${path.basename(resolved).replace(/^\.+/, '')}.nsolid-stage-`))
  const stagePath = path.join(stageDirectory, 'payload')
  if (payload.directory) {
    await cp(payload.directory, stagePath, { recursive: true, force: true, verbatimSymlinks: true, dereference: false })
  } else if (payload.bytes) {
    await writeFile(stagePath, payload.bytes, { mode: 0o600 })
  } else {
    throw new Error('A staged payload requires a directory or bytes')
  }
  const stageDigest = await pathDigest(stagePath)
  if (!stageDigest) {
    await rm(stageDirectory, { recursive: true, force: true }).catch(() => {})
    throw new Error(`Cannot digest staged payload for ${resolved}`)
  }
  const entries = journal.entries.map((candidate) => candidate === entry
    ? { ...candidate, stage: stagePath, stageDigest, applied: false }
    : candidate)
  const updated = { ...journal, entries }
  await writeDurable(journal.journalPath, updated)
  return updated
}

/**
 * Swap one entry's staged payload into place on the same volume. The replaced
 * live bytes move to a sibling quarantine and survive until commit; a deletion
 * is a quarantine move only.
 */
export async function applyFallbackEntry (journal: FallbackJournal, target: string): Promise<FallbackJournal> {
  journal = await reloadFallbackJournal(journal)
  if (!isSafeJournal(journal) || !await journalOwnershipIsValid(journal)) throw new Error('Invalid fallback journal')
  const resolved = path.resolve(target)
  const entry = journal.entries.find((candidate) => path.resolve(candidate.path) === resolved)
  if (!entry) throw new Error(`No fallback journal entry for ${resolved}`)
  if (entry.stage) {
    const stageDigest = await pathDigest(entry.stage)
    if (!stageDigest || stageDigest !== entry.stageDigest) throw new Error(`Staged payload for ${resolved} no longer matches its registered digest`)
  }
  const updatedEntries = [...journal.entries]
  const index = updatedEntries.indexOf(entry)

  // Pre-allocate the quarantine container and durably register it BEFORE the
  // live path moves. A termination in any later window leaves a journal that
  // explains the missing target and stays recoverable.
  const kind = await pathKind(resolved)
  // Re-validate the live path against the journaled snapshot immediately
  // before the first mutation: a concurrent writer must never be clobbered by
  // the swap. A destination journaled as missing that now exists is drift too.
  const liveDigest = kind !== 'missing' ? await pathDigest(resolved) : null
  if (liveDigest === undefined || liveDigest !== (entry.expectedCurrentDigest ?? null)) {
    // Abort without touching the concurrent bytes. Any pre-registered
    // quarantine and the staged payload stay journaled and recoverable.
    throw new Error(`Fallback target ${resolved} drifted after journaling; aborting without touching concurrent bytes`)
  }
  if (kind !== 'missing' && entry.quarantine === undefined) {
    const storage = await mkdtemp(path.join(path.dirname(resolved), `.${path.basename(resolved).replace(/^\.+/, '')}.nsolid-quarantine-`))
    const quarantinePath = path.join(storage, path.basename(resolved))
    updatedEntries[index] = { ...entry, quarantine: quarantinePath }
    await writeDurable(journal.journalPath, { ...journal, entries: updatedEntries })
  }

  if (kind !== 'missing') {
    await rename(resolved, updatedEntries[index].quarantine!)
  }
  if (entry.stage) {
    await rename(entry.stage, resolved)
    const appliedDigest = await pathDigest(resolved)
    if (!appliedDigest || appliedDigest !== entry.stageDigest) throw new Error(`Swap for ${resolved} did not produce the staged digest`)
  }
  updatedEntries[index] = { ...updatedEntries[index], applied: true }
  const updated = { ...journal, entries: updatedEntries }
  await writeDurable(journal.journalPath, updated)
  return updated
}

export async function captureFallbackJournalState (journal: FallbackJournal): Promise<FallbackJournal> {
  journal = await reloadFallbackJournal(journal)
  if (!isSafeJournal(journal) || !await journalOwnershipIsValid(journal)) throw new Error('Invalid fallback journal')
  const entries: FallbackJournalEntry[] = []
  for (const entry of journal.entries) {
    const expectedCurrentDigest = await pathKind(entry.path) !== 'missing' ? await pathDigest(entry.path) : null
    if (expectedCurrentDigest === undefined) throw new Error('Fallback state cannot be identified')
    entries.push({ ...entry, expectedCurrentDigest })
  }
  const updated = { ...journal, entries, mutator: undefined }
  await writeDurable(journal.journalPath, updated)
  return updated
}

export async function commitFallbackJournal (journal: FallbackJournal): Promise<void> {
  journal = await reloadFallbackJournal(journal)
  if (!isSafeJournal(journal) || !await journalOwnershipIsValid(journal)) throw new Error('Invalid fallback journal')
  if (!await snapshotArtifactsAreSafe(journal)) throw new Error('Invalid fallback journal')
  await writeDurable(journal.journalPath, { ...journal, phase: 'committed' })
  await rm(journal.journalPath, { force: true })
  await rm(journal.snapshotDirectory, { recursive: true, force: true }).catch(() => {})
  await removeEntryArtifacts(journal.entries)
}

/**
 * Restore every entry to its original registered state. Restoring is only
 * allowed while target, stage, and backup all still match the digests
 * registered in the journal; an unknown digest is drift, nothing is
 * overwritten, and the artifacts are preserved. Process liveness never
 * substitutes for that proof.
 */
export async function restoreFallbackJournal (journal: FallbackJournal): Promise<boolean> {
  if (!isSafeJournal(journal) || !await journalOwnershipIsValid(journal)) return false
  try {
    for (const entry of journal.entries) {
      if (!await entryStateIsAuthorized(entry)) return false
    }
    // Preflight before the first destructive byte moves: the snapshot must be
    // provably real, and every backup that will be restored must still hold
    // the journaled original. A tampered or rotted backup aborts with the
    // live paths untouched and the artifacts preserved.
    if (!await snapshotArtifactsAreSafe(journal)) return false
    for (const entry of journal.entries) {
      if (!entry.existed) continue
      if (!entry.backup) return false
      if (await pathKind(entry.backup) !== entry.kind) return false
      if (await pathDigest(entry.backup) !== entry.digest) return false
    }
    for (const entry of journal.entries) {
      const kind = await pathKind(entry.path)
      if (kind !== 'missing') await rm(entry.path, { recursive: true, force: true })
      if (entry.existed && entry.backup) {
        await cp(entry.backup, entry.path, { recursive: true, force: true, verbatimSymlinks: true, dereference: false })
      }
    }
    const valid = await Promise.all(journal.entries.map(async (entry) => {
      const kind = await pathKind(entry.path)
      if (entry.kind === 'missing') return kind === 'missing'
      if (kind === 'missing' || !entry.digest) return false
      return await pathDigest(entry.path) === entry.digest
    })).then((values) => values.every(Boolean))
    if (valid) {
      if (!await snapshotArtifactsAreSafe(journal)) return false
      await rm(journal.journalPath, { force: true })
      await rm(journal.snapshotDirectory, { recursive: true, force: true }).catch(() => {})
      await removeEntryArtifacts(journal.entries)
    }
    return valid
  } catch {
    return false
  }
}

/**
 * A state is authorized for replacement when the live digest equals one of the
 * digests registered by this transaction: the original state, the applied
 * staged payload, or the captured post-mutation state. Anything else is drift.
 */
async function entryStateIsAuthorized (entry: FallbackJournalEntry): Promise<boolean> {
  const kind = await pathKind(entry.path)
  const current = kind !== 'missing' ? await pathDigest(entry.path) : null
  if (current === undefined) return false
  const allowed = new Set<string | null>()
  allowed.add(entry.expectedCurrentDigest !== undefined ? entry.expectedCurrentDigest : entry.digest ?? null)
  if (entry.digest !== undefined) allowed.add(entry.digest)
  if (entry.stageDigest !== undefined) allowed.add(entry.stageDigest)
  if (kind === 'missing') {
    // A missing target is only explainable by this transaction when an applied
    // deletion removed it, a complete staged payload is still waiting to be
    // swapped (mid-swap crash), or the deletion-only apply was interrupted
    // with the original bytes sitting in the persisted quarantine. An applied
    // staged replacement that vanished was deleted concurrently: drift.
    if (entry.applied === true && entry.stage === undefined) return true
    if (entry.stage !== undefined && entry.stageDigest !== undefined && await pathDigest(entry.stage) === entry.stageDigest) return true
    if (entry.stage === undefined && entry.quarantine) {
      const quarantined = await pathDigest(entry.quarantine)
      const expected = entry.expectedCurrentDigest !== undefined ? entry.expectedCurrentDigest : entry.digest
      if (quarantined !== undefined && expected !== undefined && quarantined === expected) return true
    }
    return allowed.has(null)
  }
  return allowed.has(current)
}

export async function recoverFallbackJournal (trackingPath: string, mutate: boolean): Promise<{ pending: boolean; recovered: boolean }> {
  const journalPath = fallbackJournalPath(trackingPath)
  if (!existsSync(journalPath)) return { pending: false, recovered: true }
  let journal: FallbackJournal
  try { journal = JSON.parse(await readFile(journalPath, 'utf8')) as FallbackJournal } catch { return { pending: true, recovered: false } }
  // Version 1 journals predate staged swaps and digest-authorized recovery.
  // They fail closed: no recovery, no snapshot cleanup.
  if (!journal || journal.version !== 2) return { pending: true, recovered: false }
  if (!isSafeJournal(journal) || journal.journalPath !== journalPath || !await journalOwnershipIsValid(journal)) return { pending: true, recovered: false }
  if (!mutate) return { pending: true, recovered: false }
  if (journal.phase === 'committed') {
    // The cleanup rm is destructive: gate it on filesystem reality so a
    // forged snapshot location can never widen the deletion.
    if (!await snapshotArtifactsAreSafe(journal)) return { pending: true, recovered: false }
    await rm(journal.journalPath, { force: true }).catch(() => {})
    await rm(journal.snapshotDirectory, { recursive: true, force: true }).catch(() => {})
    await removeEntryArtifacts(journal.entries)
    return { pending: false, recovered: true }
  }
  // A live mutator still owns the transaction; never run concurrently with it.
  if (journal.mutator && processIsRunning(journal.mutator.pid)) return { pending: true, recovered: false }
  const recovered = await restoreFallbackJournal(journal)
  return { pending: true, recovered }
}

async function removeEntryArtifacts (entries: readonly FallbackJournalEntry[]): Promise<void> {
  for (const entry of entries) {
    if (entry.stage) await rm(path.dirname(entry.stage), { recursive: true, force: true }).catch(() => {})
    // The quarantine path lives inside its own sibling container directory;
    // remove the container, not only the moved payload.
    if (entry.quarantine) await rm(path.dirname(entry.quarantine), { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * Filesystem-aware gate run immediately before every destructive use of the
 * snapshot (the commit, restore, and committed-phase recovery cleanups): the
 * journal threat model is a forged file in a user-writable location, and
 * lexical containment cannot see symlinked path components. Fail closed
 * whenever reality cannot be proven; artifacts then survive untouched.
 */
async function snapshotArtifactsAreSafe (journal: FallbackJournal): Promise<boolean> {
  const snapshot = path.resolve(journal.snapshotDirectory)
  try {
    const stat = await lstat(snapshot)
    if (!stat.isDirectory()) return false
    const realParent = await realpath(path.dirname(path.resolve(journal.manifest.trackingPath)))
    const realSnapshot = await realpath(snapshot)
    if (realSnapshot === realParent || !realSnapshot.startsWith(realParent + path.sep)) return false
    for (const entry of journal.entries) {
      if (entry.backup === undefined) continue
      // A verbatim-copied symlink backup legitimately resolves to a target
      // outside the snapshot, so only its containing directory is required
      // to be the real snapshot itself.
      if (await realpath(path.dirname(entry.backup)) !== realSnapshot) return false
    }
    return true
  } catch {
    return false
  }
}

async function writeDurable (filePath: string, value: unknown): Promise<void> {
  const temporary = `${filePath}.${process.pid}.tmp`
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
      for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
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

function isSafeJournal (journal: FallbackJournal): boolean {
  if (!journal || journal.version !== 2 || !['prepared', 'mutating', 'committed'].includes(journal.phase) || !journal.manifest || !Array.isArray(journal.entries)) return false
  if (!Array.isArray(journal.manifest.ownedSkills) || !Array.isArray(journal.manifest.ownedLinks) || !Array.isArray(journal.manifest.ownedMcpFields) || !Array.isArray(journal.manifest.ownedMcpConfigPaths)) return false
  if (journal.manifest.ownedMcpConfigPaths.some((value) => typeof value !== 'string')) return false
  if (journal.manifest.ownedMcpFields.some((field) => !field || typeof field.configPath !== 'string' || typeof field.server !== 'string' || typeof field.field !== 'string' || typeof field.expectedDigest !== 'string')) return false
  const pathEvidenceIsInvalid = (entry: unknown): boolean => {
    if (!entry || typeof entry !== 'object') return true
    const value = entry as { path?: unknown; kind?: unknown; digest?: unknown }
    if (typeof value.path !== 'string' || !['missing', 'file', 'directory', 'symlink', 'other'].includes(String(value.kind))) return true
    return value.kind === 'missing' ? value.digest !== undefined : typeof value.digest !== 'string'
  }
  if (journal.manifest.ownedSkills.some(pathEvidenceIsInvalid) || journal.manifest.ownedLinks.some(pathEvidenceIsInvalid)) return false
  if (typeof journal.manifest.trackingPath !== 'string' || typeof journal.manifest.trackingDigest !== 'string' || typeof journal.manifest.harness !== 'string' || typeof journal.manifest.installationId !== 'string') return false
  if (journal.manifest.nonce !== undefined && typeof journal.manifest.nonce !== 'string') return false
  if (typeof journal.journalPath !== 'string' || typeof journal.snapshotDirectory !== 'string') return false
  if (journal.nonce !== undefined && typeof journal.nonce !== 'string') return false
  if (journal.mutator !== undefined && (!Number.isSafeInteger(journal.mutator.pid) || journal.mutator.pid <= 0 || typeof journal.mutator.nonce !== 'string' || typeof journal.mutator.claimedAt !== 'string' || !Number.isFinite(Date.parse(journal.mutator.claimedAt)))) return false
  const trackingPath = path.resolve(journal.manifest.trackingPath)
  if (journal.journalPath !== fallbackJournalPath(trackingPath)) return false
  // The snapshot must be exactly what beginFallbackJournal creates: a strict
  // direct child of the tracking directory carrying the mkdtemp suffix shape.
  // Lexical containment alone would let a forged journal point the snapshot
  // at the tracking directory itself (equality passes) and the cleanup rm
  // would delete user state.
  const snapshot = path.resolve(journal.snapshotDirectory)
  if (path.dirname(snapshot) !== path.dirname(trackingPath)) return false
  if (!/^\.nsolid-plugin-update-[A-Za-z0-9._-]{6}$/.test(path.basename(snapshot))) return false
  if (!journal.manifest.installationId || journal.manifest.installationId !== `${journal.manifest.harness}:fallback`) return false
  const expectedPaths = new Set([
    trackingPath,
    ...journal.manifest.ownedSkills.map((entry) => entry.path),
    ...journal.manifest.ownedLinks.map((entry) => entry.path),
    ...journal.manifest.ownedMcpConfigPaths,
  ].map((value) => path.resolve(value)))
  if ([...expectedPaths].some((value) => !isCanonicalPath(value))) return false
  // New bundle destinations are appended by the verified child after the
  // parent created the journal: they are only trusted when they sit directly
  // inside a manifest-approved destination root under a safe skill name.
  const approvedRoots = new Set((journal.manifest.approvedDestinationRoots ?? [])
    .map((value) => path.resolve(value)))
  if ([...approvedRoots].some((value) => !isCanonicalPath(value))) return false
  const flexibleEntries = new Set<string>()
  const entries = new Set<string>()
  for (const entry of journal.entries) {
    if (!entry || typeof entry.path !== 'string' || typeof entry.existed !== 'boolean' || typeof entry.kind !== 'string') return false
    if (!['missing', 'file', 'directory', 'symlink', 'other'].includes(entry.kind)) return false
    const target = path.resolve(entry.path)
    if (!isCanonicalPath(target)) return false
    if (expectedPaths.has(target)) {
      if (entries.has(target)) return false
    } else {
      if (flexibleEntries.has(target)) return false
      if (!approvedRoots.has(path.dirname(target))) return false
      try {
        assertSafeSkillName(path.basename(target))
      } catch {
        return false
      }
      flexibleEntries.add(target)
    }
    if (entry.backup !== undefined) {
      const backup = path.resolve(entry.backup)
      // A backup must live strictly inside the snapshot; equality would let a
      // forged entry alias the snapshot container itself.
      if (backup === snapshot || !isSameOrContained(backup, snapshot) || !isCanonicalPath(backup)) return false
    }
    if (entry.stage !== undefined) {
      const stageDir = path.resolve(path.dirname(entry.stage))
      if (!isSameOrContained(stageDir, path.dirname(target)) || stageDir === path.dirname(target) || !isCanonicalPath(stageDir)) return false
    }
    if (entry.quarantine !== undefined) {
      const quarantineDir = path.resolve(path.dirname(entry.quarantine))
      if (!isSameOrContained(quarantineDir, path.dirname(target)) || quarantineDir === path.dirname(target) || !isCanonicalPath(quarantineDir)) return false
    }
    if (entry.stageDigest !== undefined && typeof entry.stageDigest !== 'string') return false
    if (entry.expectedCurrentDigest !== undefined && entry.expectedCurrentDigest !== null && typeof entry.expectedCurrentDigest !== 'string') return false
    if (expectedPaths.has(target)) entries.add(target)
  }
  return [...expectedPaths].every((target) => entries.has(target))
}

export async function reloadFallbackJournal (journal: FallbackJournal): Promise<FallbackJournal> {
  try {
    const current = JSON.parse(await readFile(journal.journalPath, 'utf8')) as FallbackJournal
    return current.journalPath === journal.journalPath && sameManifest(current.manifest, journal.manifest) ? current : journal
  } catch {
    return journal
  }
}

function sameManifest (left: FallbackTransactionIdentity, right: FallbackTransactionIdentity): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function processIsRunning (pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
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

async function manifestMatchesTrackingFile (manifest: FallbackTransactionIdentity): Promise<boolean> {
  try {
    const tracking = JSON.parse(await readFile(manifest.trackingPath, 'utf8')) as unknown
    return isValidTrackingData(tracking) && matchesTrackedOwnership(tracking as TrackingData, manifest)
  } catch {
    return false
  }
}
