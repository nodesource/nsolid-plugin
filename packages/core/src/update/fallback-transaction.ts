import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { existsSync, lstatSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { BundleDescriptor, Credentials, HarnessType, McpServerRef } from '../types.js'
import { validateBundle } from '../validate.js'
import { readJsonFile } from '../utils/config.js'
import { resolveHome, getSkillsDir, getAuthFilePath } from '../utils/path.js'
import { deriveMcpUrlFromConsoleUrl } from '../auth/mcp-url.js'
import { expandVariables } from '../mcp/mcp-config-merger.js'
import { applyHarnessWriteFormat } from '../mcp/mcp-config-writer.js'
import { readTrackingFile, writeTrackingFile, type SkillTrackingEntry, type TrackingData } from '../skills/skill-tracker.js'
import { installSkillsToDirectory } from '../skills/skill-copier.js'
import { getHarnessSkillsPath, linkSkillsToHarness, materializeSkillLink, unlinkSkillsFromHarness } from '../skills/skill-linker.js'
import { assertSafeSkillName } from '../utils/skill-name.js'
import { getAdapter } from '../harnesses/index.js'
import type { FallbackTransactionIdentity, UpdateError } from './types.js'
import { appendFallbackJournalEntries, applyFallbackEntry, claimFallbackJournalMutation, fallbackJournalPath, registerFallbackStage, trackingDigest, pathDigest, pathKind, type FallbackJournal } from './fallback-journal.js'
import { planMcpReconciliation, type McpConfigPlanEntry } from './mcp-reconciliation.js'
import { detectJsonMcpKey, editMcpJsonBytes, McpEditError } from './mcp-edit.js'
import { editMcpTomlBytes, McpTomlEditError } from './mcp-toml-edit.js'
import { harnessMcpKey, mcpFieldDigestsFromBytes, readMcpFieldDigests, readMcpServerField, readMcpServerRecord, valueDigest } from './mcp-lookup.js'
import { readPackageVersion } from './package-manager.js'
import { isStableVersion } from './version.js'
import { isCanonicalPath, matchesTrackedOwnership, mcpRecordIsExclusivelyOwned } from './fallback-ownership.js'

export interface FallbackRefreshOptions {
  harness: HarnessType
  bundlePath: string
  skillsSource: string
  transaction?: FallbackTransactionIdentity
}

export interface FallbackRefreshResult {
  success: boolean
  rollbackAttempted?: boolean
  rollbackSucceeded?: boolean
  error?: UpdateError
}

export async function refreshOwnedInstallation (options: FallbackRefreshOptions): Promise<FallbackRefreshResult> {
  if (options.transaction) {
    const validation = validateTransactionIdentity(options.transaction)
    if (validation) return failure(validation.code, validation.message)
  }
  const tracking = await readTrackingFile()
  if (!tracking) return failure('UNTRACKED_INSTALLATION', 'No NodeSource tracking record exists')
  if (options.transaction && !matchesTrackedOwnership(tracking, options.transaction)) {
    return failure('FALLBACK_OWNERSHIP_DRIFT', 'Fallback ownership no longer matches the approved transaction manifest')
  }
  const previousSkills = tracking.skills.filter((entry) => entry.harnesses.includes(options.harness))
  const previousMcps = tracking.mcpServers.filter((entry) => entry.harness === options.harness)
  if (previousSkills.length === 0 && previousMcps.length === 0) return failure('UNTRACKED_INSTALLATION', 'The requested harness has no tracked NodeSource ownership')

  let bundle: BundleDescriptor
  try {
    const raw = readJsonFile<BundleDescriptor>(options.bundlePath)
    if (!raw) return failure('BUNDLE_NOT_FOUND', 'Update bundle is not available')
    bundle = validateBundle(raw)
  } catch {
    return failure('BUNDLE_INVALID', 'Update bundle is invalid')
  }
  const packageVersion = readPackageVersion(options.skillsSource)
  const hasPackageManifest = existsSync(path.join(options.skillsSource, 'package.json'))
  if (!isStableVersion(bundle.version) || (hasPackageManifest && packageVersion !== bundle.version)) {
    return failure('FALLBACK_BUNDLE_VERSION_MISMATCH', 'Update bundle version does not match the executing package version')
  }

  const destination = options.harness === 'opencode'
    ? path.resolve(process.env.NSOLID_OPENCODE_SKILLS_DIR ?? resolveHome('~/.config/opencode/skills'))
    : getSkillsDir()
  const linkSkills = options.harness !== 'opencode'
  const linkDir = linkSkills ? getHarnessSkillsPath(options.harness) : undefined
  const oldPaths = previousSkills.map((entry) => entry.paths?.[options.harness] ?? entry.path)
  if (oldPaths.some((value) => typeof value !== 'string' || !path.isAbsolute(value))) {
    return failure('UNTRACKED_INSTALLATION', 'Tracked skill ownership does not contain safe absolute paths')
  }
  try {
    for (const skill of bundle.skills) assertSafeSkillName(skill.name)
  } catch {
    return failure('BUNDLE_INVALID', 'Update bundle contains an unsafe skill destination')
  }
  const oldPathSet = new Set(oldPaths.map((value) => path.resolve(value)))
  const newPaths = bundle.skills.map((skill) => path.join(destination, skill.name))
  const trackedPathSet = new Set(
    tracking.skills.flatMap((entry) => [entry.path, ...Object.values(entry.paths ?? {})]
      .filter((value): value is string => typeof value === 'string'))
      .map((value) => path.resolve(value))
  )

  for (const target of newPaths) {
    if (pathExists(target) && !oldPathSet.has(path.resolve(target)) && !trackedPathSet.has(path.resolve(target))) {
      return failure('UNTRACKED_DESTINATION', `Owned refresh would overwrite an untracked destination: ${path.basename(target)}`)
    }
  }

  const backupDir = await mkdtemp(path.join(os.tmpdir(), 'nsolid-plugin-fallback-'))
  const trackingBackup = path.join(backupDir, 'tracking.json')
  const previousConfigPaths = [...new Set(previousMcps.map((entry) => path.resolve(entry.configPath)))]
  // The child uses the canonical path transported by the transaction; the
  // environment is only consulted to validate it has not moved.
  const adapterCanonical = getAdapter(options.harness).getMcpConfigPath()
  const canonicalConfigPath = options.transaction && adapterCanonical
    ? options.transaction.ownedMcpConfigPaths.find((value) => path.resolve(value) === path.resolve(adapterCanonical))
    : adapterCanonical
  const allConfigPaths = [...new Set([...previousConfigPaths, canonicalConfigPath].filter((value): value is string => typeof value === 'string'))]
  const configBackups = new Map<string, { backup: string; existed: boolean }>()
  const skillsBackup = path.join(backupDir, 'skills')
  const linkPaths = linkDir ? [...new Set([...previousSkills, ...bundle.skills].map((skill) => path.join(linkDir, skill.name)))] : []
  const linksBackup = path.join(backupDir, 'links')
  const previousSkillNames = new Set(previousSkills.map((entry) => entry.name))

  // linkSkillsToHarness historically renamed any regular destination to a
  // timestamped .bak before linking. A new bundle skill has no such ownership
  // evidence, so reject that collision before the transaction can rename a
  // user's directory or file.
  if (linkDir) {
    for (const skill of bundle.skills) {
      const linkPath = path.join(linkDir, skill.name)
      if (!previousSkillNames.has(skill.name) && pathExists(linkPath) && !trackedPathSet.has(path.resolve(linkPath))) {
        await rm(backupDir, { recursive: true, force: true }).catch(() => {})
        return failure('UNTRACKED_DESTINATION', `Owned refresh would overwrite an untracked harness link destination: ${skill.name}`)
      }
    }
  }

  let backupSkillPaths: string[] = []
  let stagedSkillsRoot: string | undefined
  let linksStageRoot: string | undefined
  let backupsComplete = false
  let mutationStarted = false
  let journal: FallbackJournal | undefined
  let preserveRecoveryArtifacts = false
  try {
    // Keep backup creation outside the mutation catch. A partial backup is
    // never safe input to rollback: deleting the live paths and restoring the
    // partial tree can destroy the only intact copy of a user's installation.
    try {
      await writeFile(trackingBackup, JSON.stringify(tracking, null, 2) + '\n', { mode: 0o600 })
      await mkdir(skillsBackup, { recursive: true, mode: 0o700 })
      backupSkillPaths = [...new Set([
        ...oldPaths,
        ...newPaths.filter((value) => existsSync(value) && trackedPathSet.has(path.resolve(value))),
      ])]
      for (const oldPath of backupSkillPaths) {
        if (pathExists(oldPath)) {
          const target = path.join(skillsBackup, encodeURIComponent(oldPath))
          await cp(oldPath, target, { recursive: true, force: true })
        }
      }
      if (linkPaths.length > 0) {
        await mkdir(linksBackup, { recursive: true, mode: 0o700 })
        for (const linkPath of linkPaths) {
          if (pathExists(linkPath)) await cp(linkPath, path.join(linksBackup, encodeURIComponent(linkPath)), { recursive: true, force: true })
        }
      }
      for (const configPath of allConfigPaths) {
        if (!existsSync(configPath)) continue
        const backup = path.join(backupDir, `mcp-config-${encodeURIComponent(configPath)}`)
        await writeFile(backup, await readFile(configPath), { mode: 0o600 })
        configBackups.set(configPath, { backup, existed: true })
      }
      backupsComplete = true
    } catch {
      return {
        success: false,
        rollbackAttempted: false,
        error: { code: 'FALLBACK_BACKUP_FAILED', message: 'Owned fallback backup could not be completed' },
      }
    }

    try {
      const credentials = readValidCredentials()
      const canReconcileMcp = credentials !== null
      const previousMcpNames = previousMcps.map((entry) => entry.name)
      const desiredMcpNames = bundle.mcpServers.map((server) => server.name)
      if (!canReconcileMcp && !sameNameSet(previousMcpNames, desiredMcpNames)) {
        throw new FallbackTransactionError('MCP_RECONCILIATION_REQUIRED', 'Fallback MCP state changed but valid credentials are unavailable')
      }

      // Plan every MCP change grouped by owning file before anything is
      // staged or written. The desired harness-formatted values are shared
      // with the tracking update: their keys are exactly the fields
      // NodeSource renders, so tracking evidence can be filtered to owned
      // keys instead of every field that survived in the config bytes.
      const configuredMcpServers = canReconcileMcp ? bundle.mcpServers : []
      const desiredMcpValues = canReconcileMcp && credentials
        ? Object.fromEntries(bundle.mcpServers.map((server) => [server.name, harnessServerValue(options.harness, server, credentials)]))
        : {}
      const plan = canReconcileMcp && credentials
        ? planMcpReconciliation({
          previousServers: previousMcps.map((entry) => ({ name: entry.name, configPath: path.resolve(entry.configPath), fields: entry.fields })),
          desiredServers: bundle.mcpServers,
          desiredValues: desiredMcpValues,
          canonicalConfigPath: canonicalConfigPath ?? undefined,
        })
        : { kind: 'planned' as const, entries: [] as McpConfigPlanEntry[], destinations: {} }
      if (plan.kind === 'reconciliation-required') {
        throw new FallbackTransactionError(plan.code, plan.message)
      }
      const staleByName = new Map(previousMcps
        .filter((entry) => !desiredMcpNames.includes(entry.name))
        .map((entry) => [entry.name, entry]))
      for (const planEntry of plan.entries) {
        for (const name of planEntry.removeServers) {
          const entry = staleByName.get(name)
          if (!entry || !mcpRecordIsExclusivelyOwned(entry.configPath, entry.name, entry.fields, harnessMcpKey(options.harness))) {
            throw new FallbackTransactionError('MCP_RECONCILIATION_REQUIRED', 'Fallback MCP cleanup would remove fields that are not proven NodeSource-owned')
          }
        }
      }

      // Render preflight: compute every final MCP byte from the observed
      // source bytes BEFORE the journal is claimed or any live path changes.
      // Parse or editor failures here abort with zero mutation. Source
      // digests are retained and revalidated right before staging/applying so
      // the drift gates keep working at mutation time.
      const plannedMcpBytes = new Map<string, { bytes: Buffer; sourceDigest: string | null }>()
      for (const planEntry of plan.entries) {
        // A missing config file is a legitimate preflight state (fresh
        // installs): null revalidates as still-missing at mutation time.
        const sourceDigest = existsSync(planEntry.configPath) ? await pathDigest(planEntry.configPath) : null
        const finalBytes = await renderConfigBytes(planEntry, harnessMcpKey(options.harness))
        if (finalBytes === undefined) continue
        if (sourceDigest === undefined) {
          throw new FallbackTransactionError('FALLBACK_MCP_DRIFT', `The MCP configuration ${planEntry.configPath} could not be hashed for the transaction`)
        }
        plannedMcpBytes.set(path.resolve(planEntry.configPath), { bytes: finalBytes, sourceDigest })
      }

      if (options.transaction && !await claimFallbackJournalMutation(options.transaction)) {
        return failure('FALLBACK_JOURNAL_CLAIM_FAILED', 'Fallback mutation journal could not be claimed safely')
      }
      mutationStarted = true

      if (options.transaction) {
        journal = await loadJournalForChild(options.transaction)
        // The bundle's brand-new destinations were unknown to the parent at
        // journal time. Journal their original state durably BEFORE any live
        // path is touched, so recovery can undo a crash mid-install.
        const newTargets = [
          ...bundle.skills.map((skill) => path.join(destination, skill.name)),
          ...(linkDir ? bundle.skills.map((skill) => path.join(linkDir, skill.name)) : []),
        ]
        journal = await appendFallbackJournalEntries(journal, newTargets)
      }

      // ---- STAGE: skills, links, MCP bytes, and tracking bytes are prepared
      // completely before any live path is touched.
      {
        const skillsStage = await mkdtemp(path.join(path.dirname(destination), `.${path.basename(destination)}.nsolid-stage-`))
        stagedSkillsRoot = skillsStage
        await installSkillsToDirectory(bundle.skills, options.skillsSource, skillsStage)
        if (journal) {
          for (const skill of bundle.skills) {
            const livePath = path.join(destination, skill.name)
            if (isJournalEntry(journal, livePath)) {
              journal = await registerFallbackStage(journal, livePath, { directory: path.join(skillsStage, skill.name) })
            }
          }
          if (linkDir) {
            const linksStage = await mkdtemp(path.join(path.dirname(linkDir), `.${path.basename(linkDir)}.nsolid-stage-`))
            linksStageRoot = linksStage
            for (const skill of bundle.skills) {
              const linkPath = path.join(linkDir, skill.name)
              if (!isJournalEntry(journal, linkPath)) continue
              const stagedLink = path.join(linksStage, skill.name)
              // Staged links follow the same Windows-safe policy as normal
              // harness linking: the junction/symlink references the final
              // live shared skill path, and the copy fallback comes from the
              // newly prepared staged bytes, never the old live content.
              await materializeSkillLink({
                linkSource: path.join(destination, skill.name),
                copySource: path.join(skillsStage, skill.name),
                target: stagedLink,
                alwaysCopy: options.harness === 'pi',
              })
              journal = await registerFallbackStage(journal, linkPath, { directory: stagedLink })
            }
          }
          const stagedMcpBytes = new Map<string, Buffer>()
          for (const planEntry of plan.entries) {
            const planned = plannedMcpBytes.get(path.resolve(planEntry.configPath))
            if (planned === undefined) continue
            // The staged bytes were rendered from an earlier observation:
            // revalidate the source digest so drift between preflight and
            // staging is rejected before anything is registered.
            const currentDigest = existsSync(planEntry.configPath) ? await pathDigest(planEntry.configPath) : null
            if (currentDigest === undefined || currentDigest !== planned.sourceDigest) {
              throw new FallbackTransactionError('FALLBACK_MCP_DRIFT', `The MCP configuration ${planEntry.configPath} changed after the render preflight`)
            }
            if (!isJournalEntry(journal, planEntry.configPath)) {
              throw new FallbackTransactionError('FALLBACK_MCP_DRIFT', `The MCP configuration ${planEntry.configPath} is not part of the approved transaction`)
            }
            journal = await registerFallbackStage(journal, planEntry.configPath, { bytes: planned.bytes })
            stagedMcpBytes.set(planEntry.configPath, planned.bytes)
          }
          if (isJournalEntry(journal, options.transaction!.trackingPath)) {
            // Field evidence must describe the bytes that will exist after the
            // swap, not the pre-update files.
            const preferredKey = harnessMcpKey(options.harness)
            const resolveFieldDigests = (configPath: string, name: string): Record<string, string> | undefined => {
              const staged = stagedMcpBytes.get(configPath)
              if (staged !== undefined) return mcpFieldDigestsFromBytes(configPath, staged, name, { preferredKey })
              return readMcpFieldDigests(configPath, name, { preferredKey })
            }
            const updatedTracking = buildTrackingUpdate(tracking, options.harness, destination, bundle, plan, configuredMcpServers, staleByName, desiredMcpValues, resolveFieldDigests)
            journal = await registerFallbackStage(journal, options.transaction!.trackingPath, { bytes: Buffer.from(JSON.stringify(updatedTracking, null, 2) + '\n', 'utf8') })
          }
        }
      }

      // ---- APPLY: same-volume swaps, one entry at a time; deletions are
      // quarantined until the parent commits.
      const newNames = new Set(bundle.skills.map((skill) => skill.name))
      const pathsToReplace = previousSkills
        .filter((entry) => newNames.has(entry.name))
        .map((entry) => entry.paths?.[options.harness] ?? entry.path)
      const pathsToRemove = previousSkills
        .filter((entry) => !newNames.has(entry.name) && canRemoveOwnedPath(entry, options.harness))
        .map((entry) => entry.paths?.[options.harness] ?? entry.path)
      for (const ownedPath of [...pathsToReplace, ...pathsToRemove]) {
        if (journal && isJournalEntry(journal, ownedPath)) {
          journal = await applyFallbackEntry(journal, ownedPath)
        } else {
          await rm(ownedPath, { recursive: true, force: true })
        }
      }
      // Fresh installs (new skills and shared destinations) come from the
      // staged tree; already-swapped entries are left untouched.
      if (stagedSkillsRoot) {
        for (const skill of bundle.skills) {
          const livePath = path.join(destination, skill.name)
          if (journal && isJournalEntry(journal, livePath)) {
            if (!journal.entries.some((entry) => path.resolve(entry.path) === path.resolve(livePath) && entry.applied)) {
              journal = await applyFallbackEntry(journal, livePath)
            }
            continue
          }
          const staged = path.join(stagedSkillsRoot, skill.name)
          if (!existsSync(staged)) continue
          await rm(livePath, { recursive: true, force: true })
          await cp(staged, livePath, { recursive: true, force: true })
        }
      }

      if (linkDir) {
        for (const oldEntry of previousSkills) {
          if (newNames.has(oldEntry.name)) continue
          const staleLink = path.join(linkDir, oldEntry.name)
          if (journal && isJournalEntry(journal, staleLink)) {
            journal = await applyFallbackEntry(journal, staleLink)
          } else if (linkSkills) {
            await unlinkSkillsFromHarness(options.harness, [{ name: oldEntry.name, path: oldEntry.name, description: '' }])
          }
        }
        for (const skill of bundle.skills) {
          const linkPath = path.join(linkDir, skill.name)
          if (journal && isJournalEntry(journal, linkPath)) {
            if (!journal.entries.some((entry) => path.resolve(entry.path) === path.resolve(linkPath) && entry.applied)) {
              journal = await applyFallbackEntry(journal, linkPath)
            }
          } else {
            await linkSkillsToHarness(options.harness, [skill])
          }
        }
      }

      for (const planEntry of plan.entries) {
        if (!planHasByteChanges(planEntry)) continue
        if (journal && isJournalEntry(journal, planEntry.configPath)) {
          journal = await applyFallbackEntry(journal, planEntry.configPath)
        } else {
          const planned = plannedMcpBytes.get(path.resolve(planEntry.configPath))
          if (planned === undefined) continue
          // Revalidate the preflight source digest before writing: a file
          // changed between preflight and apply must abort, not overwrite.
          const currentDigest = existsSync(planEntry.configPath) ? await pathDigest(planEntry.configPath) : null
          if (currentDigest === undefined || currentDigest !== planned.sourceDigest) {
            throw new FallbackTransactionError('FALLBACK_MCP_DRIFT', `The MCP configuration ${planEntry.configPath} changed after the render preflight`)
          }
          await atomicWriteFile(planEntry.configPath, planned.bytes)
        }
      }

      if (journal && isJournalEntry(journal, options.transaction!.trackingPath)) {
        // The staged tracking bytes were built from the staged MCP bytes; the
        // swap installs exactly those.
        journal = await applyFallbackEntry(journal, options.transaction!.trackingPath)
      } else {
        const updatedTracking = buildTrackingUpdate(tracking, options.harness, destination, bundle, plan, configuredMcpServers, staleByName, desiredMcpValues)
        await writeTrackingFile(updatedTracking)
      }
      return { success: true }
    } catch (error) {
      // Preflight rejection: the failure happened before the journal was
      // claimed, so nothing was mutated and there is nothing to roll back.
      if (!mutationStarted && error instanceof FallbackTransactionError) {
        return failure(error.code, error.message)
      }
      const rollback = backupsComplete && mutationStarted
        ? await rollbackFallback({ backupDir, trackingBackup, configBackups, skillsBackup, backupPaths: backupSkillPaths, newPaths, linksBackup, linkPaths, journal })
        : false
      preserveRecoveryArtifacts = !rollback
      if (error instanceof FallbackTransactionError && rollback) {
        return failure(error.code, error.message, { attempted: true, succeeded: true })
      }
      return rollback
        ? failure('FALLBACK_REFRESH_FAILED', 'Owned fallback refresh failed and was rolled back', { attempted: true, succeeded: true })
        : failure('FALLBACK_ROLLBACK_FAILED', 'Owned fallback refresh failed and rollback was incomplete', { attempted: true, succeeded: false })
    }
  } finally {
    if (!preserveRecoveryArtifacts) {
      await rm(backupDir, { recursive: true, force: true }).catch(() => {})
    }
    // Staging containers are transaction-owned scratch. The journal-owned
    // stage copies live beside each target and survive for recovery.
    if (stagedSkillsRoot) await rm(stagedSkillsRoot, { recursive: true, force: true }).catch(() => {})
    if (linksStageRoot) await rm(linksStageRoot, { recursive: true, force: true }).catch(() => {})
  }
}

function isJournalEntry (journal: FallbackJournal, target: string): boolean {
  const resolved = path.resolve(target)
  return journal.entries.some((entry) => path.resolve(entry.path) === resolved)
}

async function loadJournalForChild (transaction: FallbackTransactionIdentity): Promise<FallbackJournal> {
  const journalPath = fallbackJournalPath(transaction.trackingPath)
  const parsed = JSON.parse(await readFile(journalPath, 'utf8')) as FallbackJournal
  if (parsed.version !== 2 || JSON.stringify(parsed.manifest) !== JSON.stringify(transaction)) {
    throw new FallbackTransactionError('FALLBACK_JOURNAL_CLAIM_FAILED', 'The fallback mutation journal does not match the approved transaction')
  }
  return parsed
}

function harnessServerValue (harness: HarnessType, server: BundleDescriptor['mcpServers'][number], credentials: Credentials): Record<string, unknown> {
  const mcpUrl = credentials.mcpUrl || deriveMcpUrlFromConsoleUrl(credentials.consoleUrl, credentials.organizationId)
  if (!mcpUrl) throw new FallbackTransactionError('MCP_RECONCILIATION_REQUIRED', 'MCP URL could not be derived')
  const expanded = expandVariables([server as unknown as McpServerRef], {
    AUTH_TOKEN: credentials.serviceToken,
    AUTH_ORG_ID: credentials.organizationId,
    MCP_URL: mcpUrl,
  })
  const formatted = applyHarnessWriteFormat(harness, { mcpServers: { [server.name]: expanded[0] } as unknown as Record<string, never> })
  return formatted.mcpServers[server.name] as unknown as Record<string, unknown>
}

/**
 * Render the final bytes of one configuration file from its plan entry.
 * Owned-field digests are validated against the live file before the patch is
 * generated; foreign records and unowned fields are never touched.
 */
async function renderConfigBytes (planEntry: McpConfigPlanEntry, preferredKey: 'mcp' | 'mcpServers'): Promise<Buffer | undefined> {
  if (!planHasByteChanges(planEntry)) return undefined
  const raw = existsSync(planEntry.configPath) ? await readFile(planEntry.configPath, 'utf8') : ''
  for (const owned of planEntry.ownedFieldDigests) {
    const current = readMcpServerField(planEntry.configPath, owned.server, owned.field, { preferredKey })
    if (valueDigest(current) !== owned.expectedDigest) {
      throw new FallbackTransactionError('FALLBACK_MCP_DRIFT', `Owned MCP field ${owned.server}.${owned.field} changed in ${planEntry.configPath} after planning`)
    }
  }
  for (const name of planEntry.removeServers) {
    if (!existsSync(planEntry.configPath)) continue
    if (!readMcpServerRecord(planEntry.configPath, name, { preferredKey })) {
      throw new FallbackTransactionError('FALLBACK_MCP_DRIFT', `Owned MCP server ${name} disappeared from ${planEntry.configPath} after planning`)
    }
  }
  for (const upsert of planEntry.upsertServers) {
    if (existsSync(planEntry.configPath) && readMcpServerRecord(planEntry.configPath, upsert.name, { preferredKey })) {
      throw new FallbackTransactionError('MCP_RECONCILIATION_REQUIRED', `A server named ${upsert.name} that is not NodeSource-owned already exists in ${planEntry.configPath}`)
    }
  }
  const ownedFields = new Set(planEntry.ownedFieldDigests.map((owned) => `${owned.server}\0${owned.field}`))
  for (const update of planEntry.updateFields) {
    if (ownedFields.has(`${update.server}\0${update.field}`)) continue
    const record = existsSync(planEntry.configPath) ? readMcpServerRecord(planEntry.configPath, update.server, { preferredKey }) : undefined
    if (record && Object.hasOwn(record, update.field) && valueDigest(record[update.field]) !== valueDigest(update.value)) {
      throw new FallbackTransactionError('MCP_RECONCILIATION_REQUIRED', `Field ${update.server}.${update.field} in ${planEntry.configPath} is not NodeSource-owned`)
    }
  }
  const upserts = Object.fromEntries(planEntry.upsertServers.map((upsert) => [upsert.name, upsert.value]))
  if (planEntry.configPath.endsWith('.toml')) {
    // Byte-localized TOML editing: only the owned server/field ranges are
    // rewritten, so user comments, CRLF endings, unrelated tables, and
    // credentials survive verbatim. Editor ambiguity or parse failure maps to
    // the existing non-mutating fallback error contract.
    let next: string
    try {
      next = editMcpTomlBytes(raw, {
        upsertServers: upserts,
        removeServers: planEntry.removeServers,
        setFields: planEntry.updateFields,
        removeFields: planEntry.removeFields,
      })
    } catch (error) {
      if (error instanceof McpTomlEditError) throw new FallbackTransactionError(error.code, error.message)
      throw error
    }
    if (next === raw) return undefined
    return Buffer.from(next, 'utf8')
  }
  // Edit the container that really exists in this file: the harness-preferred
  // key when present, the legacy key when it is the only one, and the preferred
  // key for brand-new destinations. This keeps foreign content byte-identical
  // and never creates a duplicate container.
  let next: string
  try {
    next = editMcpJsonBytes(raw, {
      upsertServers: upserts,
      removeServers: planEntry.removeServers,
      setFields: planEntry.updateFields,
      removeFields: planEntry.removeFields,
    }, { mcpKey: detectJsonMcpKey(raw, preferredKey) })
  } catch (error) {
    // JSON editor failures use the same non-mutating fallback error contract
    // as TOML failures: every render error is a FallbackTransactionError.
    if (error instanceof McpEditError) throw new FallbackTransactionError(error.code, error.message)
    throw error
  }
  if (next === raw) return undefined
  return Buffer.from(next, 'utf8')
}

function planHasByteChanges (planEntry: McpConfigPlanEntry): boolean {
  return planEntry.removeServers.length > 0 || planEntry.upsertServers.length > 0 || planEntry.updateFields.length > 0 || planEntry.removeFields.length > 0
}

async function atomicWriteFile (targetPath: string, bytes: Buffer): Promise<void> {
  const temporary = `${targetPath}.nsolid-${process.pid}.tmp`
  await writeFile(temporary, bytes, { mode: 0o600 })
  await rename(temporary, targetPath)
}

function validateTransactionIdentity (identity: FallbackTransactionIdentity): UpdateError | undefined {
  if (!identity.installationId || identity.installationId !== `${identity.harness}:fallback`) return { code: 'INVALID_TRANSACTION_MANIFEST', message: 'Fallback transaction manifest has an invalid installation identity' }
  if (!path.isAbsolute(identity.trackingPath) || !trackingDigest(identity.trackingPath)) return { code: 'FALLBACK_TRACKING_DRIFT', message: 'Fallback tracking file is absent or cannot be hashed' }
  if (trackingDigest(identity.trackingPath) !== identity.trackingDigest) return { code: 'FALLBACK_TRACKING_DRIFT', message: 'Fallback tracking file changed after planning' }
  if (identity.ownedSkillPaths.some((value) => !isCanonicalPath(value))) return { code: 'INVALID_TRANSACTION_MANIFEST', message: 'Fallback transaction contains an unsafe skill path' }
  if (identity.ownedLinkPaths.some((value) => !isCanonicalPath(value))) return { code: 'INVALID_TRANSACTION_MANIFEST', message: 'Fallback transaction contains an unsafe link path' }
  for (const field of identity.ownedMcpFields) {
    if (!isCanonicalPath(field.configPath) || !existsSync(field.configPath)) return { code: 'FALLBACK_MCP_DRIFT', message: 'Owned MCP configuration changed after planning' }
    const current = readMcpServerField(field.configPath, field.server, field.field, { preferredKey: harnessMcpKey(identity.harness) })
    if (field.expectedDigest && valueDigest(current) !== field.expectedDigest) return { code: 'FALLBACK_MCP_DRIFT', message: 'Owned MCP field changed after planning' }
  }
  // The canonical MCP path is part of the approved manifest. If the adapter or
  // environment resolves a different path between planning and execution,
  // that is drift: block before any mutation.
  const allowedConfigPaths = new Set(identity.ownedMcpConfigPaths.map((value) => path.resolve(value)))
  if (identity.ownedMcpConfigPaths.some((value) => !isCanonicalPath(value))) return { code: 'INVALID_TRANSACTION_MANIFEST', message: 'Fallback transaction contains an unsafe MCP config path' }
  if (identity.ownedMcpFields.some((field) => !allowedConfigPaths.has(path.resolve(field.configPath)))) return { code: 'INVALID_TRANSACTION_MANIFEST', message: 'Fallback transaction MCP fields are outside the approved config paths' }
  const canonical = getAdapter(identity.harness).getMcpConfigPath()
  if (canonical && !allowedConfigPaths.has(path.resolve(canonical))) {
    return { code: 'FALLBACK_MCP_DRIFT', message: 'Owned MCP canonical path changed after planning' }
  }
  // Destination roots are approved at planning time. If the environment now
  // resolves a skill or link destination outside those roots, the manifest no
  // longer describes this machine: block before any mutation.
  const approvedRoots = (identity.approvedDestinationRoots ?? []).map((value) => path.resolve(value))
  if (approvedRoots.length === 0 || approvedRoots.some((value) => !isCanonicalPath(value))) {
    return { code: 'INVALID_TRANSACTION_MANIFEST', message: 'Fallback transaction contains an unsafe destination root' }
  }
  const destination = identity.harness === 'opencode'
    ? path.resolve(process.env.NSOLID_OPENCODE_SKILLS_DIR ?? resolveHome('~/.config/opencode/skills'))
    : getSkillsDir()
  if (!approvedRoots.includes(path.resolve(destination))) {
    return { code: 'INVALID_TRANSACTION_MANIFEST', message: 'The harness skill destination is outside the approved destination roots' }
  }
  if (identity.harness !== 'opencode') {
    const linkRoot = path.resolve(getHarnessSkillsPath(identity.harness))
    if (!approvedRoots.includes(linkRoot)) {
      return { code: 'INVALID_TRANSACTION_MANIFEST', message: 'The harness link destination is outside the approved destination roots' }
    }
  }
  return undefined
}

function readValidCredentials (): Credentials | null {
  try {
    const credentials = readJsonFile<Credentials>(getAuthFilePath())
    if (!credentials || typeof credentials.expiresAt !== 'string') return null
    return Date.parse(credentials.expiresAt) > Date.now() ? credentials : null
  } catch { return null }
}

async function rollbackFallback (options: {
  backupDir: string
  trackingBackup: string
  configBackups: Map<string, { backup: string; existed: boolean }>
  skillsBackup: string
  backupPaths: string[]
  newPaths: string[]
  linksBackup: string
  linkPaths: string[]
  journal?: FallbackJournal
}): Promise<boolean> {
  try {
    // A journal-based transaction can only roll back while every live byte is
    // still exactly what this transaction last wrote (applied stage digests)
    // or what it found (registered originals). Concurrent drift blocks the
    // child rollback; the parent's strict recovery takes over and preserves
    // the artifacts.
    if (options.journal) {
      for (const entry of options.journal.entries) {
        const kind = await pathKind(entry.path)
        const current = kind !== 'missing' ? await pathDigest(entry.path) : null
        if (current === undefined) return false
        if (entry.applied && entry.stageDigest && current !== entry.stageDigest) return false
        if (!entry.applied) {
          const expected = entry.expectedCurrentDigest !== undefined ? entry.expectedCurrentDigest : entry.digest ?? null
          if (current !== expected) return false
        }
      }
    }
    for (const newPath of options.newPaths) await rm(newPath, { recursive: true, force: true })
    for (const linkPath of options.linkPaths) await rm(linkPath, { recursive: true, force: true })
    for (const oldPath of options.backupPaths) {
      const backup = path.join(options.skillsBackup, encodeURIComponent(oldPath))
      if (existsSync(backup)) await cp(backup, oldPath, { recursive: true, force: true })
    }
    for (const linkPath of options.linkPaths) {
      const backup = path.join(options.linksBackup, encodeURIComponent(linkPath))
      if (existsSync(backup)) await cp(backup, linkPath, { recursive: true, force: true })
    }
    for (const [configPath, backup] of options.configBackups) {
      if (existsSync(backup.backup)) await writeFile(configPath, await readFile(backup.backup), { mode: 0o600 })
    }
    const tracking = JSON.parse(await readFile(options.trackingBackup, 'utf8')) as TrackingData
    await writeTrackingFile(tracking)
    return true
  } catch {
    return false
  }
}

function canRemoveOwnedPath (entry: SkillTrackingEntry, harness: HarnessType): boolean {
  const ownedPath = entry.paths?.[harness] ?? entry.path
  const remainingHarnesses = entry.harnesses.filter((value) => value !== harness)
  if (remainingHarnesses.length === 0) return true
  const remainingPaths = remainingHarnesses.map((value) => entry.paths?.[value]).filter((value): value is string => typeof value === 'string')
  // Legacy entries may not have per-harness paths. Keep the physical path when
  // another owner remains and the old record cannot prove it is unshared.
  if (remainingPaths.length === 0) return false
  return !remainingPaths.some((value) => path.resolve(value) === path.resolve(ownedPath))
}

function buildTrackingUpdate (
  original: TrackingData,
  harness: HarnessType,
  destination: string,
  bundle: BundleDescriptor,
  plan: { destinations: Readonly<Record<string, string>> },
  mcpServers: BundleDescriptor['mcpServers'],
  staleByName: Map<string, TrackingData['mcpServers'][number]>,
  desiredValues: Readonly<Record<string, Record<string, unknown>>>,
  resolveFieldDigests: (configPath: string, name: string) => Record<string, string> | undefined = (configPath, name) => readMcpFieldDigests(configPath, name, { preferredKey: harnessMcpKey(harness) })
): TrackingData {
  const tracking = JSON.parse(JSON.stringify(original)) as TrackingData
  const skills = bundle.skills
  const newNames = new Set(skills.map((skill) => skill.name))
  const stale = new Set(staleByName.keys())

  for (const entry of tracking.skills) {
    if (!entry.harnesses.includes(harness)) continue
    if (newNames.has(entry.name)) {
      entry.paths = { ...(entry.paths ?? {}), [harness]: path.resolve(destination, entry.name) }
      continue
    }
    entry.harnesses = entry.harnesses.filter((value) => value !== harness)
    if (entry.paths) delete entry.paths[harness]
    if (entry.harnesses.length > 0) {
      const remainingPath = entry.paths?.[entry.harnesses[0]]
      if (remainingPath) entry.path = remainingPath
    }
  }

  tracking.skills = tracking.skills.filter((entry) => entry.harnesses.length > 0)
  for (const skill of skills) {
    const normalizedPath = path.resolve(destination, skill.name)
    const existing = tracking.skills.find((entry) => entry.name === skill.name)
    if (existing) {
      if (!existing.harnesses.includes(harness)) existing.harnesses.push(harness)
      existing.paths = { ...(existing.paths ?? {}), [harness]: normalizedPath }
      if (existing.harnesses.length === 1) existing.path = normalizedPath
    } else {
      tracking.skills.push({
        name: skill.name,
        path: normalizedPath,
        paths: { [harness]: normalizedPath },
        installedAt: new Date().toISOString(),
        harnesses: [harness],
      })
    }
  }

  tracking.mcpServers = tracking.mcpServers.filter((entry) => !(entry.harness === harness && stale.has(entry.name)))
  const now = new Date().toISOString()
  for (const server of mcpServers) {
    const configPath = plan.destinations[server.name]
    if (!configPath) continue
    // Tracking evidence describes ONLY the fields NodeSource renders: the
    // keys of the desired harness-formatted value. Foreign fields that merely
    // survived in the config bytes must never enter tracking, or the next
    // refresh would treat them as owned and delete them (reconciliation
    // removes tracked fields absent from the desired render).
    const digests = resolveFieldDigests(configPath, server.name)
    const ownedNames = Object.keys(desiredValues[server.name] ?? {})
    const fields = digests === undefined
      ? undefined
      : Object.fromEntries(ownedNames.filter((name) => Object.hasOwn(digests, name)).map((name) => [name, digests[name]]))
    const existing = tracking.mcpServers.find((entry) => entry.harness === harness && entry.name === server.name)
    if (existing) {
      existing.configPath = path.resolve(configPath)
      existing.configuredAt = now
      existing.fields = fields
    } else {
      tracking.mcpServers.push({ name: server.name, configPath: path.resolve(configPath), harness, configuredAt: now, fields })
    }
  }
  tracking.bundleVersion = bundle.version
  tracking.bundleVersions = { ...(tracking.bundleVersions ?? {}), [harness]: bundle.version }
  return tracking
}

function failure (code: string, message: string, rollback?: { attempted: boolean; succeeded: boolean }): FallbackRefreshResult {
  return { success: false, rollbackAttempted: rollback?.attempted, rollbackSucceeded: rollback?.succeeded, error: { code, message } }
}

class FallbackTransactionError extends Error {
  constructor (public readonly code: string, message: string) {
    super(message)
  }
}

function sameNameSet (left: readonly string[], right: readonly string[]): boolean {
  const leftSet = new Set(left)
  const rightSet = new Set(right)
  return leftSet.size === rightSet.size && [...leftSet].every((name) => rightSet.has(name))
}

function pathExists (filePath: string): boolean {
  try {
    lstatSync(filePath)
    return true
  } catch {
    return false
  }
}
