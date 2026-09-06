import { existsSync, lstatSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { BundleDescriptor, Credentials, HarnessType, McpServerRef } from '../types.js'
import { validateBundle } from '../validate.js'
import { readJsonFile } from '../utils/config.js'
import { resolveHome, getSkillsDir, getAuthFilePath, getTrackingFilePath } from '../utils/path.js'
import { deriveMcpUrlFromConsoleUrl } from '../auth/mcp-url.js'
import { expandVariables } from '../mcp/mcp-config-merger.js'
import { applyHarnessWriteFormat } from '../mcp/mcp-config-writer.js'
import { readTrackingFile, type SkillTrackingEntry, type TrackingData } from '../skills/skill-tracker.js'
import { installSkillsToDirectory } from '../skills/skill-copier.js'
import { getHarnessSkillsPath, materializeSkillLink } from '../skills/skill-linker.js'
import { assertSafeSkillName } from '../utils/skill-name.js'
import { getAdapter } from '../harnesses/index.js'
import type { FallbackPathEvidence, FallbackTransactionIdentity, UpdateError } from './types.js'
import { FALLBACK_PROTOCOL_VERSION } from './types.js'
import { applyFallbackEntry, beginFallbackJournal, claimFallbackJournalMutation, commitFallbackJournal, manifestDigestOf, markFallbackJournalMutating, reclaimFallbackJournalMutation, registerFallbackFrontierStage, registerFallbackStage, reloadFallbackJournal, restoreFallbackJournal, trackingDigest, pathDigest, pathKind, type FallbackJournalHandle } from './fallback-journal.js'
import { planMcpReconciliation, type McpConfigPlanEntry } from './mcp-reconciliation.js'
import { detectJsonMcpKey, editMcpJsonBytes, McpEditError } from './mcp-edit.js'
import { editMcpTomlBytes, McpTomlEditError } from './mcp-toml-edit.js'
import { harnessMcpKey, mcpFieldDigestsFromBytes, readMcpFieldDigests, readMcpServerField, readMcpServerRecord, valueDigest } from './mcp-lookup.js'
import { readPackageVersion } from './package-manager.js'
import { isStableVersion } from './version.js'
import { isCanonicalPath, isSafeDirectChild, matchesTrackedOwnership, mcpRecordIsExclusivelyOwned } from './fallback-ownership.js'
import { assertFallbackFrontierEvidenceList, deriveFallbackFrontierLeafTargets, deriveFallbackFrontierPlan, evaluateFallbackFrontierPlatformSupport, fallbackLinkMaterialization, FallbackFrontierError } from './fallback-frontier.js'

export interface FallbackRefreshOptions {
  harness: HarnessType
  bundlePath: string
  skillsSource: string
  transaction?: FallbackTransactionIdentity
  /** Explicit canonical manifest digest transported to an external child; same-process callers may omit it and derive it from the trusted transaction argument. */
  manifestDigest?: string
}

export interface FallbackRefreshResult {
  success: boolean
  rollbackAttempted?: boolean
  rollbackSucceeded?: boolean
  /** Artifact containers preserved because cleanup could not be authenticated. Reporting only. */
  preservedArtifacts?: readonly string[]
  /** Live paths left untouched because their state could not be authorized. Reporting only. */
  preservedPaths?: readonly string[]
  error?: UpdateError
}

type LocalFallbackManifestObserver = (manifest: FallbackTransactionIdentity) => void | Promise<void>

let localFallbackManifestObserverForTests: LocalFallbackManifestObserver | undefined

/**
 * Test-only awaited observer for the transaction-less local manifest. It fires
 * exactly once after local planning completes and before the platform
 * preflight and the journal lifecycle start. Production code never installs
 * one; tests must reset it in `finally`. The private manifest builder itself
 * is never exported.
 */
export function setLocalFallbackManifestObserverForTests (observer?: LocalFallbackManifestObserver): void {
  localFallbackManifestObserverForTests = observer
}

export async function refreshOwnedInstallation (options: FallbackRefreshOptions): Promise<FallbackRefreshResult> {
  if (options.transaction) {
    const validation = await validateTransactionIdentity(options.transaction)
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

  const previousConfigPaths = [...new Set(previousMcps.map((entry) => path.resolve(entry.configPath)))]
  // The child uses the canonical path transported by the transaction; the
  // environment is only consulted to validate it has not moved.
  const adapterCanonical = getAdapter(options.harness).getMcpConfigPath()
  const canonicalConfigPath: string | undefined = options.transaction && adapterCanonical
    ? options.transaction.ownedMcpConfigPaths.map((value) => (typeof value === 'string' ? value : value.path)).find((value) => path.resolve(value) === path.resolve(adapterCanonical))
    : adapterCanonical ?? undefined
  const allConfigPaths = [...new Set([...previousConfigPaths, canonicalConfigPath].filter((value): value is string => typeof value === 'string'))]
  const previousSkillNames = new Set(previousSkills.map((entry) => entry.name))

  // linkSkillsToHarness historically renamed any regular destination to a
  // timestamped .bak before linking. A new bundle skill has no such ownership
  // evidence, so reject that collision before the transaction can rename a
  // user's directory or file.
  if (linkDir) {
    for (const skill of bundle.skills) {
      const linkPath = path.join(linkDir, skill.name)
      if (!previousSkillNames.has(skill.name) && pathExists(linkPath) && !trackedPathSet.has(path.resolve(linkPath))) {
        return failure('UNTRACKED_DESTINATION', `Owned refresh would overwrite an untracked harness link destination: ${skill.name}`)
      }
    }
  }

  let stagedSkillsRoot: string | undefined
  let linksStageRoot: string | undefined
  const mcpStageRoots: string[] = []
  let journal: FallbackJournalHandle | undefined
  let preserveRecoveryArtifacts = false
  let preservedArtifacts: string[] = []
  let preservedPaths: string[] = []
  try {
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

      // Claim the parent's journal (transaction path) or begin a local one
      // (transaction-less path). Both happen AFTER every preflight so a
      // rejection here leaves zero mutation and zero journal state.
      if (options.transaction) {
        const expectedDigest = options.manifestDigest ?? manifestDigestOf(options.transaction)
        const claimed = await claimFallbackJournalMutation(options.transaction, expectedDigest)
        if (claimed === undefined || claimed === null) {
          return failure('FALLBACK_JOURNAL_CLAIM_FAILED', 'Fallback mutation journal could not be claimed safely')
        }
        journal = claimed
      } else {
        // Local (transaction-less) lifecycle: this one process is planner,
        // owner, and mutator. It still walks the same role ladder as the
        // external flow — begin → markMutating → self-claim → stage/apply as
        // mutator → reclaim → prove → commit — so no code path ever mutates
        // through an owner-role handle.
        let localManifest: FallbackTransactionIdentity
        try {
          localManifest = await buildLocalTransactionManifest(options.harness, tracking, bundle, destination, linkDir, previousSkills, previousMcps, allConfigPaths)
        } catch (error) {
          // Frontier planning failures are preflight rejections with their own
          // stable codes; nothing has been reserved or mutated at this point.
          if (error instanceof FallbackFrontierError) {
            return failure(error.code, `Fallback update could not derive its destination evidence: ${error.message}`)
          }
          return failure('FALLBACK_BACKUP_FAILED', 'Owned fallback snapshot could not be completed')
        }
        if (localFallbackManifestObserverForTests !== undefined) await localFallbackManifestObserverForTests(localManifest)
        // Platform preflight BEFORE journal reservation, snapshot creation, or
        // any live mkdir. Every derived frontier counts as active: conditional
        // (MCP-only) inactivity cannot be proven from mutable planning state.
        const frontierSupport = evaluateFallbackFrontierPlatformSupport(localManifest.plannedMissingFrontiers)
        if (!frontierSupport.supported) {
          return failure(frontierSupport.code, `This platform cannot yet create the missing parent directories (${frontierSupport.frontierPaths.join(', ')}) inside a fallback transaction. Create them manually or reinstall, then retry; no files were changed.`, { attempted: false })
        }
        let ownerHandle: FallbackJournalHandle
        try {
          const begun = await beginFallbackJournal(localManifest)
          ownerHandle = begun.handle
        } catch (error) {
          if (error instanceof Error && error.message === 'FALLBACK_JOURNAL_BUSY') {
            return failure('FALLBACK_RECOVERY_PENDING', 'A previous fallback transaction is still pending. Restore or remove it manually before updating; its journal and snapshot are preserved next to the tracking file.')
          }
          return failure('FALLBACK_BACKUP_FAILED', 'Owned fallback snapshot could not be completed')
        }
        try {
          await markFallbackJournalMutating(ownerHandle)
        } catch {
          return failure('FALLBACK_JOURNAL_CLAIM_FAILED', 'The fallback mutation journal could not be advanced safely')
        }
        // Self-claim the mutator role from the manifest this process just
        // planned. A null claim fails closed BEFORE any live mutation; the
        // journal and snapshot stay in place for manual recovery.
        const claimed = await claimFallbackJournalMutation(localManifest, manifestDigestOf(localManifest))
        if (claimed === undefined || claimed === null) {
          return failure('FALLBACK_JOURNAL_CLAIM_FAILED', 'The fallback mutation journal could not be claimed safely')
        }
        journal = claimed
      }

      // Stage containers live as direct siblings of their targets (the
      // authenticated-container invariant), so every planned target's parent
      // must exist before staging. Creating a plan-approved root or config
      // directory here is journaled-transaction work: each target itself
      // stays untouched until its apply, and every path below is either an
      // approved destination root or a manifest-planned config location.
      // A missing shared destination root that the planner derived as a
      // planned-missing frontier is NOT created here: its publication is the
      // journaled frontier transaction below. The matching frontier is the
      // unique one equal to the destination root OR a proper segment ancestor
      // of it (e.g. ~/.config covering ~/.config/opencode/skills) carrying at
      // least one required skill leaf where every other leaf is either a
      // skill leaf or a CONDITIONAL mcp-config leaf (active or not: active
      // config bytes join the same staged subtree before the single
      // registration). Link, tracking, and other roles are never claimable
      // here. Ambiguous roots (zero or several matching candidates) are NOT
      // claimed: their covered leaves then fail the ordinary per-entry
      // journal gate instead of ever being double-registered.
      // ---- PURE FRONTIER CLASSIFICATION (before any live mutation) ----
      // Every planned-missing frontier carrying at least one ACTIVE leaf must
      // be claimed by exactly one supported publication route before the
      // first live directory is created. Active leaves: required leaves are
      // always active; conditional mcp-config leaves are active exactly when
      // their exact path has rendered transaction bytes; conditional skill
      // leaves are active only when the unique destination-root frontier
      // covers a staged bundle skill at that exact path (the demonstrable
      // deferred selection); every other conditional leaf is inactive.
      const plannedFrontiers = journal.manifest.plannedMissingFrontiers ?? []
      const activeMcpLeafPaths = new Set([...plannedMcpBytes.keys()].map((value) => path.resolve(value)))
      const bundleSkillLivePaths = new Set(bundle.skills.map((skill) => path.resolve(path.join(destination, skill.name))))
      const destinationFrontierCandidates = plannedFrontiers.filter((candidate) => {
        const frontierRoot = path.resolve(candidate.frontierPath)
        const resolvedDestination = path.resolve(destination)
        if (frontierRoot !== resolvedDestination && !resolvedDestination.startsWith(frontierRoot + path.sep)) return false
        if (candidate.leaves.length === 0) return false
        if (!candidate.leaves.some((leaf) => leaf.role === 'skill' && leaf.activation === 'required')) return false
        return candidate.leaves.every((leaf) =>
          leaf.role === 'skill' ||
          (leaf.role === 'mcp-config' && leaf.activation === 'conditional'))
      })
      const destinationRootFrontier = destinationFrontierCandidates.length === 1 ? destinationFrontierCandidates[0] : undefined
      const destinationFrontierRoot = destinationRootFrontier !== undefined ? path.resolve(destinationRootFrontier.frontierPath) : undefined
      // A missing link root that the planner derived as a planned-missing
      // frontier is NOT created here: its publication is the journaled
      // frontier transaction below. The matching frontier is the unique one
      // equal to linkDir or a proper segment ancestor of it whose leaves are
      // all link leaves (e.g. ~/.claude covering ~/.claude/skills/<name>).
      // Any other linkDir keeps the generic recursive creation.
      const linkFrontierCandidates = linkDir === undefined
        ? []
        : plannedFrontiers.filter((candidate) => {
          const frontierRoot = path.resolve(candidate.frontierPath)
          const resolvedLinkDir = path.resolve(linkDir)
          if (frontierRoot !== resolvedLinkDir && !resolvedLinkDir.startsWith(frontierRoot + path.sep)) return false
          return candidate.leaves.length > 0 && candidate.leaves.every((leaf) => leaf.role === 'link')
        })
      const linkRootFrontier = linkFrontierCandidates.length === 1 ? linkFrontierCandidates[0] : undefined
      const linkFrontierRoot = linkRootFrontier !== undefined ? path.resolve(linkRootFrontier.frontierPath) : undefined
      // Unsupported/ambiguous frontier audit gate: fail closed BEFORE any
      // live destination/link/config directory creation. A frontier with
      // active leaves that no supported route uniquely claims (skill+link or
      // link+MCP mixes, ambiguous destination/link candidates, overlapping
      // or broader-than-exact single-skill shapes) must never reach the
      // mkdir fallthroughs below: those would create live parents the
      // journaled frontier transaction is supposed to own.
      for (const frontier of plannedFrontiers) {
        const activeLeaves = frontier.leaves.filter((leaf) =>
          leaf.activation === 'required' ||
          (leaf.role === 'mcp-config' && leaf.activation === 'conditional' && activeMcpLeafPaths.has(path.resolve(leaf.path))) ||
          (leaf.role === 'skill' && leaf.activation === 'conditional' && frontier === destinationRootFrontier && bundleSkillLivePaths.has(path.resolve(leaf.path))))
        if (activeLeaves.length === 0) continue
        const isDestinationClaim = frontier === destinationRootFrontier
        const isLinkClaim = frontier === linkRootFrontier
        const isMcpClaim = frontier.leaves.length > 0 && frontier.leaves.every((leaf) => leaf.role === 'mcp-config')
        const isSingleSkillClaim = activeLeaves.length === 1 &&
          activeLeaves[0].role === 'skill' &&
          activeLeaves[0].activation === 'required' &&
          path.resolve(frontier.frontierPath) === path.resolve(activeLeaves[0].path)
        if (!isDestinationClaim && !isLinkClaim && !isMcpClaim && !isSingleSkillClaim) {
          throw new FallbackTransactionError('INVALID_TRANSACTION_MANIFEST', `Fallback frontier ${frontier.frontierPath} carries active leaves that no supported publication route claims; refusing to mutate live paths before the frontier is claimed`)
        }
      }
      if (destinationRootFrontier === undefined) await mkdir(destination, { recursive: true })
      if (linkDir !== undefined && linkRootFrontier === undefined) await mkdir(linkDir, { recursive: true })
      // Active MCP configuration leaves whose parent chain is missing are
      // grouped by their all-MCP frontier. The private staged subtree mirrors
      // paths relative to that frontier; no live parent is created here.
      const mcpFrontierPlans = journal.manifest.plannedMissingFrontiers
        .filter((frontier) => frontier.leaves.length > 0 && frontier.leaves.every((leaf) => leaf.role === 'mcp-config'))
        .map((frontier) => ({
          frontier,
          root: path.resolve(frontier.frontierPath),
          activeLeaves: frontier.leaves.filter((leaf) => plannedMcpBytes.has(path.resolve(leaf.path))),
        }))
        .filter((frontierPlan) => frontierPlan.activeLeaves.length > 0)
        .sort((left, right) => Buffer.compare(Buffer.from(left.root, 'utf8'), Buffer.from(right.root, 'utf8')))
      const mcpFrontierByPath = new Map<string, typeof mcpFrontierPlans[number]>()
      for (const frontierPlan of mcpFrontierPlans) {
        for (const leaf of frontierPlan.activeLeaves) {
          const leafPath = path.resolve(leaf.path)
          if (mcpFrontierByPath.has(leafPath)) {
            throw new FallbackTransactionError('INVALID_TRANSACTION_MANIFEST', `Multiple fallback frontiers cover the MCP configuration ${leafPath}`)
          }
          mcpFrontierByPath.set(leafPath, frontierPlan)
        }
      }
      // Every leaf path covered by the link-root frontier is published as one
      // journaled unit; per-leaf staging/apply must skip them entirely.
      const frontierCoveredLinkPaths = new Set((linkRootFrontier?.leaves ?? []).map((leaf) => path.resolve(leaf.path)))
      // Every leaf path covered by the destination-root frontier is published
      // as one journaled unit; per-skill staging/apply must skip them too.
      const frontierCoveredSkillPaths = new Set((destinationRootFrontier?.leaves ?? []).map((leaf) => path.resolve(leaf.path)))
      // Active conditional mcp-config leaves claimed by the destination-root
      // frontier: their bytes join the SAME deferred staged subtree and their
      // publication is the single frontier apply (no live parent mkdir and no
      // ordinary per-config stage/apply, so no double publication).
      const destinationFrontierMcpPaths = new Set((destinationRootFrontier?.leaves ?? [])
        .filter((leaf) => leaf.role === 'mcp-config' && leaf.activation === 'conditional' && plannedMcpBytes.has(path.resolve(leaf.path)))
        .map((leaf) => path.resolve(leaf.path)))
      for (const plannedConfigPath of plannedMcpBytes.keys()) {
        if (mcpFrontierByPath.has(path.resolve(plannedConfigPath))) continue
        if (destinationFrontierMcpPaths.has(path.resolve(plannedConfigPath))) continue
        await mkdir(path.dirname(plannedConfigPath), { recursive: true })
      }

      // ---- STAGE: skills, links, MCP bytes, and tracking bytes are prepared
      // completely before any live path is touched. Every staged path is a
      // parent-planned journal entry: the child never adds unplanned paths.
      {
        // The stage container must be a direct sibling of the frontier root
        // (the authenticated-container invariant). For an ancestor frontier
        // the staged skills live under the exact sub-path the frontier covers
        // (path.relative(frontierRoot, destination)), so the registered
        // payload mirrors the frontier tree; link copySource keeps pointing
        // at the staged skills directory either way. The mirror directories
        // are created inside the scratch container only, never live.
        const skillsStageContainer = destinationFrontierRoot !== undefined
          ? await mkdtemp(path.join(path.dirname(destinationFrontierRoot), `.${path.basename(destinationFrontierRoot)}.nsolid-stage-`))
          : await mkdtemp(path.join(path.dirname(destination), `.${path.basename(destination)}.nsolid-stage-`))
        stagedSkillsRoot = skillsStageContainer
        const relativeSkillsStage = destinationFrontierRoot !== undefined ? path.relative(destinationFrontierRoot, path.resolve(destination)) : ''
        const skillsStage = relativeSkillsStage === '' ? skillsStageContainer : path.join(skillsStageContainer, relativeSkillsStage)
        if (skillsStage !== skillsStageContainer) await mkdir(skillsStage, { recursive: true })
        if (destinationRootFrontier !== undefined) {
          // The destination-root frontier payload is the whole staged subtree:
          // materialize only the required bundle skill leaves it covers; the
          // frontier publication replaces the missing root as one unit.
          await installSkillsToDirectory(bundle.skills.filter((skill) => frontierCoveredSkillPaths.has(path.resolve(path.join(destination, skill.name)))), options.skillsSource, skillsStage)
        } else {
          await installSkillsToDirectory(bundle.skills, options.skillsSource, skillsStage)
        }
        for (const skill of bundle.skills) {
          const livePath = path.join(destination, skill.name)
          const resolvedLive = path.resolve(livePath)
          if (destinationRootFrontier !== undefined && frontierCoveredSkillPaths.has(resolvedLive)) continue
          const manifest: FallbackTransactionIdentity = journal.manifest
          // An exact single-skill frontier (frontierPath equals the live skill
          // path and carries a required directory skill leaf at the frontier
          // root) is one journaled frontier publication unit, not a plain
          // staged leaf; the apply loop already targets livePath exactly once.
          const skillFrontier = manifest.plannedMissingFrontiers.find((candidate) => {
            if (path.resolve(candidate.frontierPath) !== resolvedLive) return false
            return candidate.leaves.some((leaf) => leaf.role === 'skill' && leaf.activation === 'required' && path.resolve(leaf.path) === resolvedLive)
          })
          journal = skillFrontier !== undefined
            ? await registerFallbackFrontierStage(journal, livePath, path.join(skillsStage, skill.name), { activeConditionalLeafIds: [] })
            : await registerFallbackStage(requireJournalEntry(journal, livePath), livePath, { directory: path.join(skillsStage, skill.name) })
        }
        // The destination-root frontier publication keeps its private stage
        // container and is registered LATER, after the MCP staging loop, so
        // later work can add payload to the exact same staged subtree before
        // the one journaled registration. Only conditional leaves whose bytes
        // were actually staged may be selected as active: conditional skill
        // leaves covered by the staged bundle (normally none: required bundle
        // leaves supersede conditional evidence at the same destination) and
        // conditional mcp-config leaves whose render planned real bytes.
        let deferredDestinationFrontier: { activeConditionalLeafIds: readonly string[] } | undefined
        if (destinationRootFrontier !== undefined && destinationFrontierRoot !== undefined) {
          const stagedCoveredSkillPaths = new Set(bundle.skills
            .filter((skill) => frontierCoveredSkillPaths.has(path.resolve(path.join(destination, skill.name))))
            .map((skill) => path.resolve(path.join(destination, skill.name))))
          deferredDestinationFrontier = {
            activeConditionalLeafIds: (destinationRootFrontier.leaves ?? [])
              .filter((leaf) => leaf.activation === 'conditional' && (
                (leaf.role === 'skill' && stagedCoveredSkillPaths.has(path.resolve(leaf.path))) ||
                (leaf.role === 'mcp-config' && destinationFrontierMcpPaths.has(path.resolve(leaf.path)))))
              .map((leaf) => leaf.id),
          }
        }
        // Link staging/registration runs AFTER the deferred destination-root
        // skill frontier registration below, so every bundle-skill payload
        // digest binding is available in the private registry before any
        // copied link is registered. Apply order still runs skills before
        // links; only the registration order changed.
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
          stagedMcpBytes.set(planEntry.configPath, planned.bytes)
          const resolvedConfig = path.resolve(planEntry.configPath)
          if (mcpFrontierByPath.has(resolvedConfig)) continue
          if (destinationFrontierMcpPaths.has(resolvedConfig)) {
            // Active config shared with the destination-root frontier: the
            // bytes join the SAME deferred staged subtree at the exact
            // frontier-relative path. Directories are created inside the
            // scratch container only; the live parent chain stays missing
            // until the single journaled frontier publication installs both
            // roles. No ordinary per-config journal entry is registered, so
            // the config can never be double-published.
            if (destinationFrontierRoot === undefined) {
              throw new FallbackTransactionError('INVALID_TRANSACTION_MANIFEST', `The MCP configuration ${planEntry.configPath} has no deferred destination frontier root`)
            }
            const relativeConfig = path.relative(destinationFrontierRoot, resolvedConfig)
            if (relativeConfig === '' || relativeConfig.startsWith('..') || path.isAbsolute(relativeConfig)) {
              throw new FallbackTransactionError('INVALID_TRANSACTION_MANIFEST', `The MCP configuration ${planEntry.configPath} is not a strict child of its destination frontier ${destinationFrontierRoot}`)
            }
            const stagedConfigPath = path.join(skillsStageContainer, relativeConfig)
            await mkdir(path.dirname(stagedConfigPath), { recursive: true })
            await writeFile(stagedConfigPath, planned.bytes, { mode: 0o600 })
            continue
          }
          journal = await registerFallbackStage(requireJournalEntry(journal, planEntry.configPath), planEntry.configPath, { bytes: planned.bytes })
        }
        for (const frontierPlan of mcpFrontierPlans) {
          const stageRoot = await mkdtemp(path.join(path.dirname(frontierPlan.root), `.${path.basename(frontierPlan.root)}.nsolid-stage-`))
          mcpStageRoots.push(stageRoot)
          for (const leaf of frontierPlan.activeLeaves) {
            const planned = plannedMcpBytes.get(path.resolve(leaf.path))
            if (planned === undefined) throw new FallbackTransactionError('INVALID_TRANSACTION_MANIFEST', `The active MCP frontier leaf ${leaf.path} has no planned bytes`)
            const stagedPath = path.join(stageRoot, path.relative(frontierPlan.root, path.resolve(leaf.path)))
            await mkdir(path.dirname(stagedPath), { recursive: true })
            await writeFile(stagedPath, planned.bytes, { mode: 0o600 })
          }
          journal = await registerFallbackFrontierStage(journal, frontierPlan.root, stageRoot, {
            activeConditionalLeafIds: frontierPlan.activeLeaves.filter((leaf) => leaf.activation === 'conditional').map((leaf) => leaf.id),
          })
        }
        // The deferred destination-root frontier registration: the exact same
        // single journaled publication unit as before, performed after the
        // MCP per-entry staging loop and before the link staging block below
        // (so copied links can bind to its registered skill payloads) and
        // before the tracking bytes are built.
        if (deferredDestinationFrontier !== undefined && destinationFrontierRoot !== undefined) {
          journal = await registerFallbackFrontierStage(journal, destinationFrontierRoot, skillsStageContainer, { activeConditionalLeafIds: deferredDestinationFrontier.activeConditionalLeafIds })
        }
        if (linkDir) {
          // The stage container is a direct sibling of the frontier root (the
          // authenticated-container invariant); the frontier root's parent is
          // the anchor that already exists.
          const linksStage = await mkdtemp(path.join(path.dirname(linkFrontierRoot ?? linkDir), `.${path.basename(linkFrontierRoot ?? linkDir)}.nsolid-stage-`))
          linksStageRoot = linksStage
          if (linkRootFrontier !== undefined && linkFrontierRoot !== undefined) {
            // Missing link-root frontier (equal to linkDir or a proper
            // ancestor): stage the active required bundle links as one
            // complete frontier subtree at their exact paths relative to the
            // frontier root (e.g. staged/skills/<name> for frontier ~/.claude
            // with linkDir ~/.claude/skills), then register it as a single
            // frontier publication unit. Stale conditional link leaves are
            // intentionally absent from the staged tree.
            for (const skill of bundle.skills) {
              const linkPath = path.resolve(path.join(linkDir, skill.name))
              if (!frontierCoveredLinkPaths.has(linkPath)) continue
              const stagedLink = path.join(linksStage, path.relative(linkFrontierRoot, linkPath))
              await mkdir(path.dirname(stagedLink), { recursive: true })
              await materializeSkillLink({
                linkSource: path.join(destination, skill.name),
                copySource: path.join(skillsStage, skill.name),
                target: stagedLink,
                alwaysCopy: options.harness === 'pi',
              })
            }
            journal = await registerFallbackFrontierStage(journal, linkFrontierRoot, linksStage, { activeConditionalLeafIds: [] })
          } else {
            for (const skill of bundle.skills) {
              const linkPath = path.join(linkDir, skill.name)
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
              journal = await registerFallbackStage(requireJournalEntry(journal, linkPath), linkPath, { directory: stagedLink })
            }
          }
        }
        // Field evidence must describe the bytes that will exist after the
        // swap, not the pre-update files.
        const trackingPath = path.resolve(journal.manifest.trackingPath)
        const preferredKey = harnessMcpKey(options.harness)
        const resolveFieldDigests = (configPath: string, name: string): Record<string, string> | undefined => {
          const staged = stagedMcpBytes.get(configPath)
          if (staged !== undefined) return mcpFieldDigestsFromBytes(configPath, staged, name, { preferredKey })
          return readMcpFieldDigests(configPath, name, { preferredKey })
        }
        const updatedTracking = buildTrackingUpdate(tracking, options.harness, destination, bundle, plan, configuredMcpServers, staleByName, desiredMcpValues, resolveFieldDigests)
        journal = await registerFallbackStage(requireJournalEntry(journal, trackingPath), trackingPath, { bytes: Buffer.from(JSON.stringify(updatedTracking, null, 2) + '\n', 'utf8') })
      }

      // ---- APPLY: same-volume swaps, one entry at a time; deletions are
      // quarantine moves that preserve bytes until an authenticated cleanup.
      const newNames = new Set(bundle.skills.map((skill) => skill.name))
      const pathsToReplace = previousSkills
        .filter((entry) => newNames.has(entry.name))
        .map((entry) => entry.paths?.[options.harness] ?? entry.path)
      const pathsToRemove = previousSkills
        .filter((entry) => !newNames.has(entry.name) && canRemoveOwnedPath(entry, options.harness))
        .map((entry) => entry.paths?.[options.harness] ?? entry.path)
      for (const ownedPath of [...pathsToReplace, ...pathsToRemove]) {
        if (frontierCoveredLinkPaths.has(path.resolve(ownedPath))) continue
        if (frontierCoveredSkillPaths.has(path.resolve(ownedPath))) continue
        journal = await applyFallbackEntry(journal, ownedPath)
      }
      // Fresh installs (new skills and shared destinations) come from the
      // staged tree; already-swapped entries are left untouched.
      for (const skill of bundle.skills) {
        const livePath = path.join(destination, skill.name)
        if (destinationRootFrontier !== undefined && frontierCoveredSkillPaths.has(path.resolve(livePath))) continue
        const disk = await reloadFallbackJournal(journal)
        if (!disk.entries.some((entry) => path.resolve(entry.path) === path.resolve(livePath) && entry.applied)) {
          journal = await applyFallbackEntry(journal, livePath)
        }
      }

      // One journaled frontier publication replaces every covered shared
      // skill leaf: applied exactly once, after the staged shared skills are
      // ready and before any link frontier publication.
      if (destinationRootFrontier !== undefined && destinationFrontierRoot !== undefined) {
        const disk = await reloadFallbackJournal(journal)
        if (!disk.entries.some((entry) => path.resolve(entry.path) === destinationFrontierRoot && entry.applied)) {
          journal = await applyFallbackEntry(journal, destinationFrontierRoot)
        }
      }

      if (linkDir) {
        for (const oldEntry of previousSkills) {
          if (newNames.has(oldEntry.name)) continue
          const oldLinkPath = path.resolve(path.join(linkDir, oldEntry.name))
          if (frontierCoveredLinkPaths.has(oldLinkPath)) continue
          journal = await applyFallbackEntry(journal, oldLinkPath)
        }
        for (const skill of bundle.skills) {
          const linkPath = path.join(linkDir, skill.name)
          if (frontierCoveredLinkPaths.has(path.resolve(linkPath))) continue
          const disk = await reloadFallbackJournal(journal)
          if (!disk.entries.some((entry) => path.resolve(entry.path) === path.resolve(linkPath) && entry.applied)) {
            journal = await applyFallbackEntry(journal, linkPath)
          }
        }
        // One journaled frontier publication replaces every covered link
        // leaf: applied exactly once, after the shared skill destinations.
        if (linkRootFrontier !== undefined && linkFrontierRoot !== undefined) {
          const disk = await reloadFallbackJournal(journal)
          if (!disk.entries.some((entry) => path.resolve(entry.path) === linkFrontierRoot && entry.applied)) {
            journal = await applyFallbackEntry(journal, linkFrontierRoot)
          }
        }
      }

      for (const planEntry of plan.entries) {
        if (!planHasByteChanges(planEntry)) continue
        // The apply gate mirrors the staging gate: an entry whose render
        // produced no byte change has no staged payload, and applying it
        // would move the live configuration into quarantine with nothing
        // to replace it. Skip it — the live bytes already match the plan.
        if (plannedMcpBytes.get(path.resolve(planEntry.configPath)) === undefined) continue
        if (mcpFrontierByPath.has(path.resolve(planEntry.configPath))) continue
        if (destinationFrontierMcpPaths.has(path.resolve(planEntry.configPath))) continue
        journal = await applyFallbackEntry(journal, planEntry.configPath)
      }
      for (const frontierPlan of mcpFrontierPlans) {
        journal = await applyFallbackEntry(journal, frontierPlan.root)
      }

      // The staged tracking bytes were built from the staged MCP bytes; the
      // swap installs exactly those.
      journal = await applyFallbackEntry(journal, path.resolve(journal.manifest.trackingPath))

      // External child success: the journal belongs to the waiting parent.
      // This process holds only the mutator role — the recorded owner PID is
      // the parent that began the journal — so reclaim, prove, and commit are
      // parent-only operations and must never run here. The applied journal
      // and its mutator record stay in place: after the confirmed child exit
      // the parent reclaims owner authority, proves the applied state from
      // the strictly reloaded journal plus the live filesystem, and commits
      // with the journal as the single snapshot.
      if (options.transaction !== undefined) {
        return { success: true }
      }
      // Local completion: reclaim the same-process mutator back to owner (the
      // sanctioned transaction-less transition), prove the resulting applied
      // state from the strictly reloaded journal plus the live filesystem, and
      // only then commit. Commit disposes the journal and snapshot, so a
      // successful local refresh leaves no live transaction state behind.
      let ownerHandle: FallbackJournalHandle
      try {
        ownerHandle = await reclaimFallbackJournalMutation(journal)
        journal = ownerHandle
      } catch {
        preserveRecoveryArtifacts = true
        return failure('FALLBACK_STATE_UNPROVEN', 'The fallback refresh completed but its journal could not be reclaimed safely; its state was left untouched for manual recovery', { attempted: false })
      }
      if (!await journalProvesAppliedState(await reloadFallbackJournal(ownerHandle))) {
        const restored = await restoreFallbackJournal(ownerHandle)
        preserveRecoveryArtifacts = !restored.succeeded
        preservedArtifacts = restored.preservedArtifacts
        preservedPaths = restored.preservedPaths
        return failure(restored.succeeded ? 'FALLBACK_VALIDATION_FAILED' : 'FALLBACK_ROLLBACK_FAILED', restored.succeeded ? 'The fallback refresh completed without proving the planned owned-state mutation' : 'Fallback validation failed and local recovery was incomplete', { attempted: true, succeeded: restored.succeeded }, { preservedArtifacts, preservedPaths })
      }
      const commitResult = await commitFallbackJournal(ownerHandle)
      return {
        success: true,
        preservedArtifacts: commitResult.preservedArtifacts.length > 0 ? commitResult.preservedArtifacts : undefined,
        preservedPaths: commitResult.preservedPaths.length > 0 ? commitResult.preservedPaths : undefined,
      }
    } catch (error) {
      // Child-owned rollback: this process still holds the mutator handle and
      // its in-memory manifest, so it restores the journaled snapshot itself.
      // Every backup is authenticated against manifest evidence before any
      // byte moves; mutable journal fields never authorize a deletion.
      if (journal !== undefined) {
        const restored = await restoreFallbackJournal(journal)
        preserveRecoveryArtifacts = !restored.succeeded
        preservedArtifacts = restored.preservedArtifacts
        preservedPaths = restored.preservedPaths
        if (restored.succeeded && options.transaction === undefined) {
          // Local flow: this process is also the journal owner, and a
          // mutator-role restore deliberately leaves the journal file for its
          // owner. Reclaim (the sanctioned same-process transition) and
          // dispose it so a rolled-back local refresh leaves no live
          // transaction behind for the next run to trip over.
          try {
            const rollbackOwner = await reclaimFallbackJournalMutation(journal)
            await rm(rollbackOwner.journalPath, { force: true }).catch(() => {})
          } catch { /* best-effort disposal; next-run recovery reports residue */ }
        }
        const preservation = { preservedArtifacts, preservedPaths }
        if (restored.succeeded) {
          if (error instanceof FallbackTransactionError) {
            return failure(error.code, error.message, { attempted: true, succeeded: true }, preservation)
          }
          return failure('FALLBACK_REFRESH_FAILED', 'Owned fallback refresh failed and was rolled back', { attempted: true, succeeded: true }, preservation)
        }
        if (restored.unproven) {
          return failure('FALLBACK_STATE_UNPROVEN', 'The fallback transaction could not prove the state of its owned files, so nothing was changed automatically. Its journal, snapshot, and preserved artifacts were left untouched for manual recovery.', { attempted: false }, preservation)
        }
        return failure('FALLBACK_ROLLBACK_FAILED', 'Owned fallback refresh failed and rollback was incomplete', { attempted: true, succeeded: false }, preservation)
      }
      if (error instanceof FallbackTransactionError) {
        return failure(error.code, error.message)
      }
      return failure('FALLBACK_REFRESH_FAILED', 'Owned fallback refresh failed before its journal was claimed')
    }
  } finally {
    // Staging containers are transaction-owned scratch. The journal-owned
    // stage copies live beside each target and survive for recovery.
    if (!preserveRecoveryArtifacts) {
      if (stagedSkillsRoot) await rm(stagedSkillsRoot, { recursive: true, force: true }).catch(() => {})
      if (linksStageRoot) await rm(linksStageRoot, { recursive: true, force: true }).catch(() => {})
      for (const stageRoot of mcpStageRoots) await rm(stageRoot, { recursive: true, force: true }).catch(() => {})
    }
  }
}

/** Every mutation target must be a parent-planned journal entry; a missing entry is a manifest/plan divergence and fails closed. */
function requireJournalEntry (journal: FallbackJournalHandle, target: string): FallbackJournalHandle {
  const resolved = path.resolve(target)
  if (!journal.manifest.ownedSkills.concat(journal.manifest.ownedLinks, journal.manifest.bundleDestinations, journal.manifest.ownedMcpConfigPaths.filter((value): value is Exclude<typeof value, string> => typeof value !== 'string')).some((entry) => path.resolve(entry.path) === resolved) && path.resolve(journal.manifest.trackingPath) !== resolved) {
    throw new FallbackTransactionError('INVALID_TRANSACTION_MANIFEST', `The fallback journal has no planned entry for ${resolved}`)
  }
  return journal
}

/**
 * Build the local transaction manifest for a transaction-less refresh. The
 * exact observed tracking, MCP files, existing ownership, and bundle
 * destinations become the planning authority, then the same journal flow
 * (begin → mutate → stage → apply → restore/commit) runs in this process.
 */
async function buildLocalTransactionManifest (
  harness: HarnessType,
  tracking: TrackingData,
  bundle: BundleDescriptor,
  destination: string,
  linkDir: string | undefined,
  previousSkills: readonly SkillTrackingEntry[],
  previousMcps: readonly TrackingData['mcpServers'][number][],
  configPaths: readonly string[]
): Promise<FallbackTransactionIdentity> {
  const trackingPath = path.resolve(getTrackingFilePath())
  const digest = trackingDigest(trackingPath)
  if (!digest) throw new FallbackTransactionError('FALLBACK_TRACKING_DRIFT', 'The fallback tracking file is absent or cannot be hashed')
  const skillPaths = previousSkills.map((entry) => path.resolve(entry.paths?.[harness] ?? entry.path))
  const linkPaths = linkDir !== undefined ? previousSkills.map((entry) => path.join(linkDir, entry.name)) : []
  const destinationPaths = [...new Set([
    ...bundle.skills.map((skill) => path.join(destination, skill.name)),
    ...(linkDir !== undefined ? bundle.skills.map((skill) => path.join(linkDir, skill.name)) : []),
  ].map((value) => path.resolve(value)))]
  const capture = async (paths: readonly string[]): Promise<FallbackPathEvidence[]> => await Promise.all(paths.map(async (value) => {
    const kind = await pathKind(value)
    const pathDigestValue = kind === 'missing' ? undefined : await pathDigest(value)
    if (kind !== 'missing' && pathDigestValue === undefined) throw new FallbackTransactionError('FALLBACK_BACKUP_FAILED', `Owned fallback path ${value} could not be hashed`)
    return { path: value, kind, digest: pathDigestValue }
  }))
  const approvedDestinationRoots = [...new Set([
    path.resolve(destination),
    ...(linkDir !== undefined ? [path.resolve(linkDir)] : []),
  ])]
  const ownedSkills = await capture(skillPaths)
  const ownedLinks = await capture(linkPaths)
  const ownedMcpConfigPaths = await capture([...new Set(configPaths.map((value) => path.resolve(value)))])
  // Shared derivation (binding decision, option A): the local planner feeds
  // the exact same leaf-builder and plan API as the external strategy
  // planner, so an identical planned state can never produce a divergent
  // graph and the child cannot widen it. Derivation is read-only.
  const frontierPlan = await deriveFallbackFrontierPlan(deriveFallbackFrontierLeafTargets({
    ownedSkills,
    ownedLinks,
    ownedMcpConfigPaths,
    trackingPath,
    destination: path.resolve(destination),
    linkDir: linkDir === undefined ? undefined : path.resolve(linkDir),
    bundleSkillNames: bundle.skills.map((skill) => skill.name),
  }), fallbackLinkMaterialization(harness))
  return {
    installationId: `${harness}:fallback`,
    harness,
    trackingPath,
    trackingDigest: digest,
    protocolVersion: FALLBACK_PROTOCOL_VERSION,
    digestAlgorithm: 'fallback-path-v2',
    nonce: randomUUID(),
    ownedSkills,
    ownedLinks,
    ownedMcpFields: previousMcps.flatMap((entry) => Object.entries(entry.fields ?? {}).map(([field, expectedDigest]) => ({ configPath: path.resolve(entry.configPath), server: entry.name, field, expectedDigest }))),
    ownedMcpConfigPaths,
    bundleDestinations: await capture(destinationPaths),
    approvedDestinationRoots,
    // Exact deterministic frontier evidence from the shared planner; present
    // even when empty so the planned state stays canonical for the manifest
    // digest. Publication/rollback consume this in later stages.
    plannedMissingFrontiers: frontierPlan.frontiers,
  }
}

function harnessServerValue (harness: HarnessType, server: BundleDescriptor['mcpServers'][number], credentials: Credentials): Record<string, unknown> {
  const mcpUrl = credentials.mcpUrl || deriveMcpUrlFromConsoleUrl(credentials.consoleUrl, credentials.organizationId)
  if (!mcpUrl) throw new FallbackTransactionError('MCP_RECONCILIATION_REQUIRED', 'MCP URL could not be derived')
  const expanded = expandVariables([server as unknown as McpServerRef], {
    AUTH_TOKEN: credentials.serviceToken,
    AUTH_ORG_ID: credentials.organizationId,
    MCP_URL: mcpUrl,
  })
  // The ref's `name` is only the map key metadata: reconciliation values,
  // inserted records, and tracking ownership must use only renderable entry
  // fields, never the key that holds the server's own name.
  const { name: _name, ...entry } = expanded[0]
  const formatted = applyHarnessWriteFormat(harness, { mcpServers: { [server.name]: entry } as unknown as Record<string, never> })
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

async function validateTransactionIdentity (identity: FallbackTransactionIdentity): Promise<UpdateError | undefined> {
  // Protocol gate FIRST: a manifest from an incompatible planner version is
  // rejected before any other evaluation and before any mutation, with a
  // stable code the parent can map to manual-update guidance.
  if (identity.protocolVersion !== FALLBACK_PROTOCOL_VERSION) {
    return { code: 'FALLBACK_PROTOCOL_UNSUPPORTED', message: `This fallback update was planned by an incompatible nsolid-plugin version (protocol ${String(identity.protocolVersion)}; this build speaks protocol ${String(FALLBACK_PROTOCOL_VERSION)}). Update nsolid-plugin manually (for example with your package manager) and retry the update.` }
  }
  // Frontier evidence gate immediately after the protocol gate, BEFORE any
  // journal or live-state work: protocol v3 requires exactly-parsed
  // planned-missing frontier evidence. Absent, malformed, extra-keyed, or
  // tampered graphs fail closed before any mutation.
  try {
    assertFallbackFrontierEvidenceList(identity.plannedMissingFrontiers)
  } catch (error) {
    return { code: 'FALLBACK_FRONTIER_EVIDENCE_INVALID', message: `Fallback transaction contains invalid planned-missing frontier evidence: ${(error as Error).message}` }
  }
  if (!identity.installationId || identity.installationId !== `${identity.harness}:fallback`) return { code: 'INVALID_TRANSACTION_MANIFEST', message: 'Fallback transaction manifest has an invalid installation identity' }
  if (!path.isAbsolute(identity.trackingPath) || !trackingDigest(identity.trackingPath)) return { code: 'FALLBACK_TRACKING_DRIFT', message: 'Fallback tracking file is absent or cannot be hashed' }
  if (trackingDigest(identity.trackingPath) !== identity.trackingDigest) return { code: 'FALLBACK_TRACKING_DRIFT', message: 'Fallback tracking file changed after planning' }
  if (identity.digestAlgorithm !== undefined && identity.digestAlgorithm !== 'fallback-path-v2') return { code: 'INVALID_TRANSACTION_MANIFEST', message: 'Fallback transaction uses an unknown digest domain' }
  if (!Array.isArray(identity.ownedSkills) || identity.ownedSkills.some((entry) => !isValidPathEvidence(entry))) return { code: 'INVALID_TRANSACTION_MANIFEST', message: 'Fallback transaction contains an unsafe skill path' }
  if (!Array.isArray(identity.ownedLinks) || identity.ownedLinks.some((entry) => !isValidPathEvidence(entry))) return { code: 'INVALID_TRANSACTION_MANIFEST', message: 'Fallback transaction contains an unsafe link path' }
  if (!Array.isArray(identity.ownedMcpConfigPaths) || identity.ownedMcpConfigPaths.some((value) => typeof value !== 'string' && !isValidPathEvidence(value))) return { code: 'INVALID_TRANSACTION_MANIFEST', message: 'Fallback transaction contains an unsafe MCP config path' }
  if (!Array.isArray(identity.bundleDestinations) || identity.bundleDestinations.some((entry) => !isValidPathEvidence(entry))) return { code: 'INVALID_TRANSACTION_MANIFEST', message: 'Fallback transaction contains an unsafe bundle destination' }
  for (const field of identity.ownedMcpFields) {
    if (!isCanonicalPath(field.configPath) || !existsSync(field.configPath)) return { code: 'FALLBACK_MCP_DRIFT', message: 'Owned MCP configuration changed after planning' }
    const current = readMcpServerField(field.configPath, field.server, field.field, { preferredKey: harnessMcpKey(identity.harness) })
    if (field.expectedDigest && valueDigest(current) !== field.expectedDigest) return { code: 'FALLBACK_MCP_DRIFT', message: 'Owned MCP field changed after planning' }
  }
  // The canonical MCP path is part of the approved manifest. If the adapter or
  // environment resolves a different path between planning and execution,
  // that is drift: block before any mutation.
  const allowedConfigPaths = new Set(identity.ownedMcpConfigPaths.map((value) => path.resolve(typeof value === 'string' ? value : value.path)))
  if (identity.ownedMcpConfigPaths.some((value) => !isCanonicalPath(typeof value === 'string' ? value : value.path))) return { code: 'INVALID_TRANSACTION_MANIFEST', message: 'Fallback transaction contains an unsafe MCP config path' }
  if (identity.ownedMcpFields.some((field) => !allowedConfigPaths.has(path.resolve(field.configPath)))) return { code: 'INVALID_TRANSACTION_MANIFEST', message: 'Fallback transaction MCP fields are outside the approved config paths' }
  const canonical = getAdapter(identity.harness).getMcpConfigPath()
  if (canonical && !allowedConfigPaths.has(path.resolve(canonical))) {
    return { code: 'FALLBACK_MCP_DRIFT', message: 'Owned MCP canonical path changed after planning' }
  }
  // Whole-file MCP evidence and planned bundle destinations are revalidated
  // against live state: drift between planning and execution blocks the
  // mutation exactly like owned-skill drift.
  for (const evidence of [...identity.ownedMcpConfigPaths, ...identity.bundleDestinations].filter((value): value is FallbackPathEvidence => typeof value !== 'string')) {
    if (!isCanonicalPath(evidence.path)) return { code: 'INVALID_TRANSACTION_MANIFEST', message: 'Fallback transaction contains an unsafe evidence path' }
    const kind = await pathKind(evidence.path)
    const digest = kind === 'missing' ? undefined : await pathDigest(evidence.path)
    if (kind !== evidence.kind || digest !== evidence.digest) {
      return { code: 'FALLBACK_TRACKING_DRIFT', message: `Fallback planned path changed after planning: ${evidence.path}` }
    }
  }
  // Destination roots are approved at planning time. If the environment now
  // resolves a skill or link destination outside those roots, the manifest no
  // longer describes this machine: block before any mutation.
  if (!Array.isArray(identity.approvedDestinationRoots)) return { code: 'INVALID_TRANSACTION_MANIFEST', message: 'Fallback transaction contains no destination roots' }
  const approvedRoots = identity.approvedDestinationRoots.map((value) => path.resolve(value))
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
  if (identity.ownedSkills.some((entry) => !isSafeDirectChild(entry.path, approvedRoots))) {
    return { code: 'INVALID_TRANSACTION_MANIFEST', message: 'Fallback transaction contains a skill outside the approved destination roots' }
  }
  const linkRoots = identity.harness === 'opencode' ? approvedRoots : [path.resolve(getHarnessSkillsPath(identity.harness))]
  if (identity.ownedLinks.some((entry) => !isSafeDirectChild(entry.path, linkRoots))) {
    return { code: 'INVALID_TRANSACTION_MANIFEST', message: 'Fallback transaction contains a link outside the approved destination roots' }
  }
  // Planned bundle destinations sit directly inside an approved root under a
  // safe skill name: they were derived by the parent from the verified
  // bundle, and the child never accepts unplanned destinations.
  if (identity.bundleDestinations.some((entry) => !isSafeDirectChild(entry.path, approvedRoots))) {
    return { code: 'INVALID_TRANSACTION_MANIFEST', message: 'Fallback transaction contains a bundle destination outside the approved destination roots' }
  }
  for (const entry of [...identity.ownedSkills, ...identity.ownedLinks]) {
    const kind = await pathKind(entry.path)
    const digest = kind === 'missing' ? undefined : await pathDigest(entry.path)
    if (kind !== entry.kind || digest !== entry.digest) {
      return { code: 'FALLBACK_TRACKING_DRIFT', message: 'Fallback owned path changed after planning' }
    }
  }
  return undefined
}

function isValidPathEvidence (entry: unknown): entry is FallbackTransactionIdentity['ownedSkills'][number] {
  if (!entry || typeof entry !== 'object') return false
  const value = entry as { path?: unknown; kind?: unknown; digest?: unknown }
  if (typeof value.path !== 'string' || !isCanonicalPath(value.path)) return false
  if (!['missing', 'file', 'directory', 'symlink', 'other'].includes(String(value.kind))) return false
  return value.kind === 'missing' ? value.digest === undefined : typeof value.digest === 'string'
}

function readValidCredentials (): Credentials | null {
  try {
    const credentials = readJsonFile<Credentials>(getAuthFilePath())
    if (!credentials || typeof credentials.expiresAt !== 'string') return null
    return Date.parse(credentials.expiresAt) > Date.now() ? credentials : null
  } catch { return null }
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

/**
 * Prove the applied state from the strictly reloaded journal and the live
 * filesystem — the same validation the external parent runs after reclaim
 * (strategies/fallback.ts): applied staged entries must carry exactly their
 * registered stage digest, applied deletions must be gone, and entries this
 * transaction never staged must still be byte-identical to the journaled
 * original. The mutable fields here are success-validation evidence only;
 * they never authorize a restore or commit.
 */
async function journalProvesAppliedState (journal: Awaited<ReturnType<typeof reloadFallbackJournal>>): Promise<boolean> {
  for (const entry of journal.entries) {
    const target = path.resolve(entry.path)
    if (entry.stageDigest !== undefined) {
      if (entry.applied !== true) return false
      if (await pathDigest(target) !== entry.stageDigest) return false
      continue
    }
    if (entry.applied === true) {
      if (await pathKind(target) !== 'missing') return false
      continue
    }
    const kind = await pathKind(target)
    if (entry.existed === true) {
      if (kind === 'missing' || entry.digest === undefined || await pathDigest(target) !== entry.digest) return false
    } else if (kind !== 'missing') {
      return false
    }
  }
  return true
}

function failure (code: string, message: string, rollback?: { attempted: boolean; succeeded?: boolean }, preservation?: { preservedArtifacts?: readonly string[]; preservedPaths?: readonly string[] }): FallbackRefreshResult {
  return {
    success: false,
    rollbackAttempted: rollback?.attempted,
    rollbackSucceeded: rollback?.succeeded,
    preservedArtifacts: preservation?.preservedArtifacts,
    preservedPaths: preservation?.preservedPaths,
    error: { code, message },
  }
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
