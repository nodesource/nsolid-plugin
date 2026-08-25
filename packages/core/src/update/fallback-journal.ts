import { createHash } from 'node:crypto'
import { cp, lstat, mkdtemp, open, readFile, readlink, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type { FallbackTransactionIdentity } from './types.js'
import { isValidTrackingData, type TrackingData } from '../skills/skill-tracker.js'
import { isCanonicalPath, isSameOrContained, matchesTrackedOwnership } from './fallback-ownership.js'

export type FallbackJournalPhase = 'prepared' | 'mutating' | 'committed'

export interface FallbackJournal {
  version: 1
  phase: FallbackJournalPhase
  manifest: FallbackTransactionIdentity
  journalPath: string
  snapshotDirectory: string
  entries: readonly FallbackJournalEntry[]
}

interface FallbackJournalEntry {
  path: string
  backup: string
  existed: boolean
  digest?: string
  /** Exact live state the parent is authorized to replace during rollback. */
  expectedCurrentDigest?: string | null
}

export interface FallbackJournalResult {
  journal: FallbackJournal
  rollbackSucceeded?: boolean
}

export function trackingDigest (trackingPath: string): string | undefined {
  try { return createHash('sha256').update(readFileSync(trackingPath)).digest('hex') } catch { return undefined }
}

export function valueDigest (value: unknown): string {
  return createHash('sha256').update(JSON.stringify(stableValue(value)) ?? 'undefined').digest('hex')
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
  const journalPath = fallbackJournalPath(trackingPath)
  const snapshotDirectory = await mkdtemp(path.join(path.dirname(trackingPath), '.nsolid-plugin-update-'))
  const paths = [...new Set([
    trackingPath,
    ...manifest.ownedSkillPaths,
    ...manifest.ownedLinkPaths,
    ...manifest.ownedMcpFields.map((field) => field.configPath),
  ].map((value) => path.resolve(value)))]
  const entries: FallbackJournalEntry[] = []
  try {
    for (const [index, target] of paths.entries()) {
      const existed = existsSync(target)
      const backup = path.join(snapshotDirectory, String(index))
      const digest = existed ? await pathDigest(target) : undefined
      if (existed && !digest) throw new Error(`cannot digest ${target}`)
      if (existed) await cp(target, backup, { recursive: true, force: true })
      entries.push({ path: target, backup, existed, digest, expectedCurrentDigest: digest ?? null })
    }
    const journal: FallbackJournal = { version: 1, phase: 'prepared', manifest, journalPath, snapshotDirectory, entries }
    await writeDurable(journalPath, journal)
    return { journal }
  } catch (error) {
    await rm(snapshotDirectory, { recursive: true, force: true }).catch(() => {})
    throw new Error('FALLBACK_BACKUP_FAILED', { cause: error })
  }
}

export async function markFallbackJournalMutating (journal: FallbackJournal): Promise<FallbackJournal> {
  const updated = { ...journal, phase: 'mutating' as const }
  await writeDurable(journal.journalPath, updated)
  return updated
}

export async function captureFallbackJournalState (journal: FallbackJournal): Promise<FallbackJournal> {
  if (!isSafeJournal(journal) || !await journalOwnershipIsValid(journal)) throw new Error('Invalid fallback journal')
  const entries: FallbackJournalEntry[] = []
  for (const entry of journal.entries) {
    const expectedCurrentDigest = existsSync(entry.path) ? await pathDigest(entry.path) : null
    if (expectedCurrentDigest === undefined) throw new Error('Fallback state cannot be identified')
    entries.push({ ...entry, expectedCurrentDigest })
  }
  const updated = { ...journal, entries }
  await writeDurable(journal.journalPath, updated)
  return updated
}

export async function commitFallbackJournal (journal: FallbackJournal): Promise<void> {
  if (!isSafeJournal(journal) || !await journalOwnershipIsValid(journal)) throw new Error('Invalid fallback journal')
  await writeDurable(journal.journalPath, { ...journal, phase: 'committed' })
  await rm(journal.journalPath, { force: true })
  await rm(journal.snapshotDirectory, { recursive: true, force: true })
}

export async function restoreFallbackJournal (journal: FallbackJournal): Promise<boolean> {
  if (!isSafeJournal(journal) || !await journalOwnershipIsValid(journal)) return false
  try {
    if (!await journalStateMatchesExpected(journal)) return false
    for (const entry of journal.entries) {
      if (!await entryStateMatchesExpected(entry)) return false
      if (entry.existed) {
        await rm(entry.path, { recursive: true, force: true })
        await cp(entry.backup, entry.path, { recursive: true, force: true })
      } else {
        await rm(entry.path, { recursive: true, force: true })
      }
    }
    const valid = await Promise.all(journal.entries.map(async (entry) => {
      if (!entry.existed) return !existsSync(entry.path)
      if (!existsSync(entry.path) || !entry.digest) return false
      return await pathDigest(entry.path) === entry.digest
    })).then((values) => values.every(Boolean))
    if (valid) {
      await rm(journal.journalPath, { force: true })
      await rm(journal.snapshotDirectory, { recursive: true, force: true })
    }
    return valid
  } catch {
    return false
  }
}

export async function recoverFallbackJournal (trackingPath: string, mutate: boolean): Promise<{ pending: boolean; recovered: boolean }> {
  const journalPath = fallbackJournalPath(trackingPath)
  if (!existsSync(journalPath)) return { pending: false, recovered: true }
  let journal: FallbackJournal
  try { journal = JSON.parse(await readFile(journalPath, 'utf8')) as FallbackJournal } catch { return { pending: true, recovered: false } }
  if (!isSafeJournal(journal) || journal.journalPath !== journalPath || !await journalOwnershipIsValid(journal)) return { pending: true, recovered: false }
  if (!mutate) return { pending: true, recovered: false }
  if (journal.phase === 'committed') {
    await rm(journal.journalPath, { force: true }).catch(() => {})
    await rm(journal.snapshotDirectory, { recursive: true, force: true }).catch(() => {})
    return { pending: false, recovered: true }
  }
  const recovered = await restoreFallbackJournal(journal)
  return { pending: true, recovered }
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

async function pathDigest (target: string): Promise<string | undefined> {
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
  if (!journal || journal.version !== 1 || !['prepared', 'mutating', 'committed'].includes(journal.phase) || !journal.manifest || !Array.isArray(journal.entries)) return false
  if (!Array.isArray(journal.manifest.ownedSkillPaths) || !Array.isArray(journal.manifest.ownedLinkPaths) || !Array.isArray(journal.manifest.ownedMcpFields)) return false
  if (journal.manifest.ownedMcpFields.some((field) => !field || typeof field.configPath !== 'string' || typeof field.server !== 'string' || typeof field.field !== 'string' || typeof field.expectedDigest !== 'string')) return false
  if (journal.manifest.ownedSkillPaths.some((value) => typeof value !== 'string') || journal.manifest.ownedLinkPaths.some((value) => typeof value !== 'string')) return false
  if (typeof journal.manifest.trackingPath !== 'string' || typeof journal.manifest.trackingDigest !== 'string' || typeof journal.manifest.harness !== 'string' || typeof journal.manifest.installationId !== 'string') return false
  if (typeof journal.journalPath !== 'string' || typeof journal.snapshotDirectory !== 'string') return false
  const trackingPath = path.resolve(journal.manifest.trackingPath)
  if (journal.journalPath !== fallbackJournalPath(trackingPath)) return false
  if (!isSameOrContained(path.resolve(journal.snapshotDirectory), path.dirname(trackingPath))) return false
  if (!journal.manifest.installationId || journal.manifest.installationId !== `${journal.manifest.harness}:fallback`) return false
  const expectedPaths = new Set([
    trackingPath,
    ...journal.manifest.ownedSkillPaths,
    ...journal.manifest.ownedLinkPaths,
    ...journal.manifest.ownedMcpFields.map((field) => field.configPath),
  ].map((value) => path.resolve(value)))
  if ([...expectedPaths].some((value) => !isCanonicalPath(value))) return false
  const entries = new Set<string>()
  for (const entry of journal.entries) {
    if (!entry || typeof entry.path !== 'string' || typeof entry.backup !== 'string' || typeof entry.existed !== 'boolean') return false
    const target = path.resolve(entry.path)
    if (!isCanonicalPath(target) || !expectedPaths.has(target) || entries.has(target)) return false
    if (!isSameOrContained(path.resolve(entry.backup), path.resolve(journal.snapshotDirectory))) return false
    if (entry.expectedCurrentDigest !== undefined && entry.expectedCurrentDigest !== null && typeof entry.expectedCurrentDigest !== 'string') return false
    entries.add(target)
  }
  return entries.size === expectedPaths.size && [...expectedPaths].every((target) => entries.has(target))
}

async function journalStateMatchesExpected (journal: FallbackJournal): Promise<boolean> {
  const matches = await Promise.all(journal.entries.map(entryStateMatchesExpected))
  return matches.every(Boolean)
}

async function entryStateMatchesExpected (entry: FallbackJournalEntry): Promise<boolean> {
  const expected = entry.expectedCurrentDigest !== undefined ? entry.expectedCurrentDigest : entry.digest ?? null
  const current = existsSync(entry.path) ? await pathDigest(entry.path) : null
  return current !== undefined && current === expected
}

async function journalOwnershipIsValid (journal: FallbackJournal): Promise<boolean> {
  const trackingPath = path.resolve(journal.manifest.trackingPath)
  const trackingEntry = journal.entries.find((entry) => path.resolve(entry.path) === trackingPath)
  if (!trackingEntry?.existed || !trackingEntry.digest) return false
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

function stableValue (value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, stableValue(child)]))
  }
  return value
}
