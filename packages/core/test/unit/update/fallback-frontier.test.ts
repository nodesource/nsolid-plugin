import { afterEach, beforeEach, describe, it } from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, lstatSync, mkdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  assertFallbackFrontierEvidenceList,
  compareUtf8,
  deriveFallbackFrontierLeafTargets,
  deriveFallbackFrontierPlan,
  deriveFallbackJournalPhysicalTargets,
  deriveFrontierTreeExpectation,
  evaluateFallbackFrontierPlatformSupport,
  FALLBACK_FRONTIER_BOUNDS,
  FALLBACK_FRONTIER_ERROR_CODES,
  FallbackFrontierError,
  fallbackLinkMaterialization,
  revalidateFallbackFrontierEvidence,
  selectActiveFallbackFrontierLeaves,
  type FallbackFrontierLeafInputs,
} from '../../../src/update/fallback-frontier.js'
import type { FallbackAnchorIdentity, FallbackFrontierEvidence, FallbackLeafActivation, FallbackLeafRole, FallbackLeafTarget, FallbackPathEvidence, FallbackTransactionIdentity } from '../../../src/update/types.js'
import type { HarnessType } from '../../../src/types.js'
import { FALLBACK_PROTOCOL_VERSION } from '../../../src/update/types.js'
import { createCanonicalTempRoot } from '../../helpers/canonical-temp-root.js'

let root: string

beforeEach(() => {
  root = createCanonicalTempRoot('nsolid-plugin-frontier-')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function leaf (leafPath: string, role: FallbackLeafRole = 'skill', activation: FallbackLeafActivation = 'required', id = path.basename(leafPath)): FallbackLeafTarget {
  return { id, role, activation, path: leafPath }
}

function structuredCloneFrontiers (frontiers: readonly FallbackFrontierEvidence[]): FallbackFrontierEvidence[] {
  return JSON.parse(JSON.stringify(frontiers)) as FallbackFrontierEvidence[]
}

function withPlatform<T> (platform: NodeJS.Platform, run: () => T): T {
  const original = process.platform
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  try {
    return run()
  } finally {
    Object.defineProperty(process, 'platform', { value: original, configurable: true })
  }
}

function assertErrorCode (operation: () => unknown, code: string): void {
  try {
    operation()
  } catch (error) {
    assert.ok(error instanceof FallbackFrontierError, `expected FallbackFrontierError, got ${String(error)}`)
    assert.equal(error.code, code)
    return
  }
  assert.fail(`expected a ${code} rejection`)
}

/**
 * Create a symlink for a test. Only the Windows-specific EPERM denial (no
 * symlink privilege) may skip the case; every other failure is rethrown.
 */
function createSymlinkForTest (context: TestContext, target: string, linkPath: string): boolean {
  try {
    symlinkSync(target, linkPath)
    return true
  } catch (error) {
    if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') {
      context.skip(`symlink creation denied on this host: ${linkPath}`)
      return false
    }
    throw error
  }
}

describe('fallback frontier derivation', () => {
  it('derives one frontier per topmost missing directory below a shared existing anchor with anchor identity', async () => {
    const anchor = path.join(root, 'skills')
    mkdirSync(anchor)
    const added = leaf(path.join(anchor, 'added'))
    const deep = leaf(path.join(anchor, 'zoo', 'deep'), 'link', 'conditional')
    const plan = await deriveFallbackFrontierPlan([deep, added])
    assert.equal(plan.frontiers.length, 2)
    assert.deepEqual(plan.frontiers.map((entry) => entry.frontierPath), [added.path, path.join(anchor, 'zoo')].sort(compareUtf8))
    const [addedFrontier, zooFrontier] = plan.frontiers
    assert.equal(addedFrontier.activation, 'required')
    assert.deepEqual(addedFrontier.leaves, [added])
    assert.equal(zooFrontier.activation, 'conditional')
    assert.deepEqual(zooFrontier.leaves, [deep])
    const expectedIdentity = (entry: FallbackAnchorIdentity): void => {
      assert.equal(entry.path, anchor)
      assert.equal(entry.realpath, anchor)
      assert.equal(entry.type, 'directory')
      const stats = lstatSync(anchor, { bigint: true })
      assert.equal(entry.device, stats.dev.toString(10))
      assert.equal(entry.inode, stats.ino.toString(10))
    }
    expectedIdentity(addedFrontier.anchor)
    expectedIdentity(zooFrontier.anchor)
    assert.deepEqual(plan.existingLeaves, [])
    assert.deepEqual(plan.missingLeaves, [])
  })

  it('groups leaves sharing a frontier and keeps disjoint missing components separate', async () => {
    const anchor = path.join(root, 'skills')
    mkdirSync(anchor)
    const packA = leaf(path.join(anchor, 'pack-a'))
    const packB = leaf(path.join(anchor, 'pack-b'))
    const nested = leaf(path.join(anchor, 'nested', 'x', 'y'))
    const plan = await deriveFallbackFrontierPlan([packB, nested, packA])
    assert.deepEqual(plan.frontiers.map((entry) => entry.frontierPath), [packA.path, packB.path, path.join(anchor, 'nested')].sort(compareUtf8))
    const nestedFrontier = plan.frontiers.find((entry) => entry.frontierPath === path.join(anchor, 'nested'))
    assert.ok(nestedFrontier)
    assert.deepEqual(nestedFrontier.leaves, [nested])
  })

  it('classifies existing leaves without frontiers and covers every authorized leaf exactly once', async () => {
    const anchor = path.join(root, 'skills')
    mkdirSync(path.join(anchor, 'tracked'), { recursive: true })
    writeFileSync(path.join(anchor, 'tracked', 'SKILL.md'), 'tracked\n')
    const tracked = leaf(path.join(anchor, 'tracked'))
    const added = leaf(path.join(anchor, 'added'))
    const plan = await deriveFallbackFrontierPlan([tracked, added])
    const covered = [
      ...plan.frontiers.flatMap((entry) => entry.leaves.map((entryLeaf) => entryLeaf.path)),
      ...plan.existingLeaves.map((entryLeaf) => entryLeaf.path),
      ...plan.missingLeaves.map((entryLeaf) => entryLeaf.path),
    ]
    assert.deepEqual(plan.existingLeaves, [tracked])
    assert.equal(plan.frontiers.length, 1)
    assert.deepEqual(plan.frontiers[0].leaves, [added])
    assert.deepEqual(plan.missingLeaves, [])
    assert.deepEqual(covered.sort(compareUtf8), [tracked.path, added.path].sort(compareUtf8))
  })

  it('keeps file and link leaves independent: existing files are existing leaves and missing files under existing parents never become frontiers', async () => {
    const anchor = path.join(root, 'agents')
    mkdirSync(anchor)
    const trackingLeaf = leaf(path.join(root, 'installed.json'), 'tracking', 'required', 'tracking')
    writeFileSync(trackingLeaf.path, '{}\n')
    const mcpLeaf = leaf(path.join(anchor, 'opencode.json'), 'mcp-config', 'required', 'config')
    writeFileSync(mcpLeaf.path, '{}\n')
    const missingMcpLeaf = leaf(path.join(anchor, 'missing.json'), 'mcp-config', 'conditional', 'missing-config')
    const missingLinkLeaf = leaf(path.join(anchor, 'skill-link'), 'link', 'conditional', 'missing-link')
    const plan = await deriveFallbackFrontierPlan([trackingLeaf, missingLinkLeaf, missingMcpLeaf, mcpLeaf])
    const covered = [
      ...plan.frontiers.flatMap((entry) => entry.leaves.map((entryLeaf) => entryLeaf.path)),
      ...plan.existingLeaves.map((entryLeaf) => entryLeaf.path),
      ...plan.missingLeaves.map((entryLeaf) => entryLeaf.path),
    ]
    assert.deepEqual(plan.existingLeaves, [mcpLeaf, trackingLeaf])
    assert.deepEqual(plan.missingLeaves, [missingMcpLeaf, missingLinkLeaf])
    assert.deepEqual(plan.frontiers, [])
    assert.deepEqual(covered.sort(compareUtf8), [trackingLeaf.path, missingLinkLeaf.path, missingMcpLeaf.path, mcpLeaf.path].sort(compareUtf8))
    // No frontier means no platform restriction anywhere: an existing-parent
    // update must not be blocked on non-Linux hosts.
    assert.deepEqual(withPlatform('win32', () => evaluateFallbackFrontierPlatformSupport(plan.frontiers)), { supported: true })
  })

  it('treats an existing managed symlink as a legitimate link leaf but rejects it for directory roles', async (t) => {
    const anchor = path.join(root, 'skills')
    mkdirSync(path.join(anchor, 'real-skill'), { recursive: true })
    const linkPath = path.join(anchor, 'managed-link')
    if (!createSymlinkForTest(t, path.join(anchor, 'real-skill'), linkPath)) return
    const linkLeaf = leaf(linkPath, 'link')
    const plan = await deriveFallbackFrontierPlan([linkLeaf])
    assert.deepEqual(plan.existingLeaves, [linkLeaf])
    assert.deepEqual(plan.frontiers, [])
    assert.deepEqual(plan.missingLeaves, [])
    await assert.rejects(
      deriveFallbackFrontierPlan([leaf(linkPath)]),
      (error: unknown) => error instanceof FallbackFrontierError && error.code === FALLBACK_FRONTIER_ERROR_CODES.LEAF_KIND_MISMATCH
    )
  })

  it('is deterministic: derivation order never changes the resulting graph', async () => {
    const anchor = path.join(root, 'skills')
    mkdirSync(path.join(anchor, 'kept'), { recursive: true })
    const inputs = [
      leaf(path.join(anchor, 'kept')),
      leaf(path.join(anchor, 'b-second'), 'skill', 'conditional'),
      leaf(path.join(anchor, 'a-first')),
      leaf(path.join(anchor, 'c-nested', 'inner'), 'mcp-config', 'required', 'config'),
    ]
    const forward = await deriveFallbackFrontierPlan(inputs)
    const backward = await deriveFallbackFrontierPlan([...inputs].reverse())
    assert.equal(JSON.stringify(backward), JSON.stringify(forward))
    assert.equal(JSON.stringify(await deriveFallbackFrontierPlan(inputs)), JSON.stringify(forward))
  })

  it('aggregates activation: any required leaf makes the frontier required', async () => {
    const anchor = path.join(root, 'skills')
    mkdirSync(anchor)
    const mixed = await deriveFallbackFrontierPlan([
      leaf(path.join(anchor, 'mixed', 'a'), 'skill', 'conditional'),
      leaf(path.join(anchor, 'mixed', 'b'), 'skill', 'required'),
    ])
    assert.equal(mixed.frontiers[0].activation, 'required')
    const conditional = await deriveFallbackFrontierPlan([
      leaf(path.join(anchor, 'cond', 'a'), 'mcp-config', 'conditional', 'config'),
      leaf(path.join(anchor, 'cond', 'b'), 'link', 'conditional'),
    ])
    assert.equal(conditional.frontiers[0].activation, 'conditional')
  })
})

describe('fallback frontier rejection', () => {
  it('rejects duplicate leaf paths and conflicting identities for the same path', async () => {
    const anchor = path.join(root, 'skills')
    mkdirSync(anchor)
    const target = path.join(anchor, 'added')
    await assert.rejects(
      deriveFallbackFrontierPlan([leaf(target), leaf(target)]),
      (error: unknown) => error instanceof FallbackFrontierError && error.code === FALLBACK_FRONTIER_ERROR_CODES.COLLISION
    )
    await assert.rejects(
      deriveFallbackFrontierPlan([leaf(target, 'skill', 'required', 'one'), leaf(target, 'link', 'required', 'two')]),
      (error: unknown) => error instanceof FallbackFrontierError && error.code === FALLBACK_FRONTIER_ERROR_CODES.COLLISION
    )
  })

  it('rejects a leaf that is an ancestor of another leaf (file-as-ancestor collision)', async () => {
    const anchor = path.join(root, 'skills')
    mkdirSync(path.join(anchor, 'parent'), { recursive: true })
    const parentLeaf = leaf(path.join(anchor, 'parent'))
    const childLeaf = leaf(path.join(anchor, 'parent', 'child'))
    await assert.rejects(
      deriveFallbackFrontierPlan([parentLeaf, childLeaf]),
      (error: unknown) => error instanceof FallbackFrontierError && error.code === FALLBACK_FRONTIER_ERROR_CODES.COLLISION
    )
  })

  it('rejects symlink components without following them, even when the link dangles', async (t) => {
    const anchor = path.join(root, 'skills')
    mkdirSync(anchor)
    const linkDir = path.join(anchor, 'link-dir')
    if (!createSymlinkForTest(t, path.join(root, 'does-not-exist-anywhere'), linkDir)) return
    const plan = leaf(path.join(linkDir, 'child'))
    await assert.rejects(
      deriveFallbackFrontierPlan([plan]),
      (error: unknown) => error instanceof FallbackFrontierError && error.code === FALLBACK_FRONTIER_ERROR_CODES.COMPONENT_NOT_DIRECTORY
    )
    assert.ok(lstatSync(linkDir).isSymbolicLink())
    assert.equal(existsSync(path.join(root, 'does-not-exist-anywhere')), false)
  })

  it('rejects file components in the chain and kind-conflicting existing symlink leaves', async (t) => {
    const anchor = path.join(root, 'skills')
    mkdirSync(anchor)
    writeFileSync(path.join(anchor, 'blocker'), 'file\n')
    await assert.rejects(
      deriveFallbackFrontierPlan([leaf(path.join(anchor, 'blocker', 'child'))]),
      (error: unknown) => error instanceof FallbackFrontierError && error.code === FALLBACK_FRONTIER_ERROR_CODES.COMPONENT_NOT_DIRECTORY
    )
    const linkedLeaf = path.join(anchor, 'linked-leaf')
    if (!createSymlinkForTest(t, path.join(root, 'nowhere'), linkedLeaf)) return
    // A skill destination that exists as a symlink is a kind conflict, not a
    // traversable component: lstat inspects the link itself without following.
    await assert.rejects(
      deriveFallbackFrontierPlan([leaf(linkedLeaf)]),
      (error: unknown) => error instanceof FallbackFrontierError && error.code === FALLBACK_FRONTIER_ERROR_CODES.LEAF_KIND_MISMATCH
    )
    assert.ok(lstatSync(linkedLeaf).isSymbolicLink())
  })

  it('rejects existing destinations whose live kind contradicts the kind their role requires', async () => {
    const anchor = path.join(root, 'mixed')
    mkdirSync(path.join(anchor, 'dir-leaf'), { recursive: true })
    const fileLeaf = path.join(anchor, 'file-leaf')
    writeFileSync(fileLeaf, '{}\n')
    await assert.rejects(
      deriveFallbackFrontierPlan([leaf(path.join(anchor, 'dir-leaf'), 'tracking')]),
      (error: unknown) => error instanceof FallbackFrontierError && error.code === FALLBACK_FRONTIER_ERROR_CODES.LEAF_KIND_MISMATCH
    )
    await assert.rejects(
      deriveFallbackFrontierPlan([leaf(path.join(anchor, 'dir-leaf'), 'mcp-config')]),
      (error: unknown) => error instanceof FallbackFrontierError && error.code === FALLBACK_FRONTIER_ERROR_CODES.LEAF_KIND_MISMATCH
    )
    await assert.rejects(
      deriveFallbackFrontierPlan([leaf(fileLeaf)]),
      (error: unknown) => error instanceof FallbackFrontierError && error.code === FALLBACK_FRONTIER_ERROR_CODES.LEAF_KIND_MISMATCH
    )
  })

  it('enforces the missing-segment bound and canonical path shapes', async () => {
    const anchor = path.join(root, 'skills')
    mkdirSync(anchor)
    const deepName = Array.from({ length: FALLBACK_FRONTIER_BOUNDS.maxMissingSegmentsPerLeaf + 1 }, (_, index) => `level-${index}`).join('/')
    const deepLeaf = leaf(path.join(anchor, deepName))
    const traversal = leaf(`${root}/escape/../target`)
    await assert.rejects(
      deriveFallbackFrontierPlan([deepLeaf]),
      (error: unknown) => error instanceof FallbackFrontierError && error.code === FALLBACK_FRONTIER_ERROR_CODES.INVALID_INPUT
    )
    await assert.rejects(deriveFallbackFrontierPlan([leaf('relative/path')]), (error: unknown) => error instanceof FallbackFrontierError && error.code === FALLBACK_FRONTIER_ERROR_CODES.INVALID_INPUT)
    await assert.rejects(deriveFallbackFrontierPlan([traversal]), (error: unknown) => error instanceof FallbackFrontierError && error.code === FALLBACK_FRONTIER_ERROR_CODES.INVALID_INPUT)
  })

  it('enforces the frontier bound during derivation: exactly 16 accepted, 17 rejected', async () => {
    const anchor = path.join(root, 'skills')
    mkdirSync(anchor)
    const frontierLeaves = (count: number): FallbackLeafTarget[] =>
      Array.from({ length: count }, (_, index) => leaf(path.join(anchor, `frontier-${String(index).padStart(2, '0')}`)))
    const accepted = await deriveFallbackFrontierPlan(frontierLeaves(FALLBACK_FRONTIER_BOUNDS.maxFrontiers))
    assert.equal(accepted.frontiers.length, FALLBACK_FRONTIER_BOUNDS.maxFrontiers)
    assertFallbackFrontierEvidenceList(structuredCloneFrontiers(accepted.frontiers))
    await assert.rejects(
      deriveFallbackFrontierPlan(frontierLeaves(FALLBACK_FRONTIER_BOUNDS.maxFrontiers + 1)),
      (error: unknown) => error instanceof FallbackFrontierError && error.code === FALLBACK_FRONTIER_ERROR_CODES.INVALID_INPUT
    )
  })
})

describe('fallback frontier platform preflight', () => {
  it('rejects active frontiers on non-linux platforms with the stable code', () => {
    const anchor = path.join(root, 'skills')
    mkdirSync(anchor)
    return (async () => {
      const plan = await deriveFallbackFrontierPlan([leaf(path.join(anchor, 'added'))])
      for (const platform of ['win32', 'darwin'] as const) {
        const support = withPlatform(platform, () => evaluateFallbackFrontierPlatformSupport(plan.frontiers))
        assert.equal(support.supported, false)
        if (!support.supported) {
          assert.equal(support.code, 'FALLBACK_PARENT_CREATION_UNSUPPORTED')
          assert.deepEqual(support.frontierPaths, [path.join(anchor, 'added')])
        }
      }
    })()
  })

  it('keeps existing-parent plans and inactive conditional frontiers supported everywhere', async () => {
    const anchor = path.join(root, 'skills')
    mkdirSync(path.join(anchor, 'tracked'), { recursive: true })
    const existingPlan = await deriveFallbackFrontierPlan([leaf(path.join(anchor, 'tracked'))])
    assert.deepEqual(withPlatform('win32', () => evaluateFallbackFrontierPlatformSupport(existingPlan.frontiers)), { supported: true })

    const conditionalPlan = await deriveFallbackFrontierPlan([leaf(path.join(anchor, 'cond'), 'skill', 'conditional')])
    assert.deepEqual(
      withPlatform('win32', () => evaluateFallbackFrontierPlatformSupport(conditionalPlan.frontiers, { inactiveFrontierPaths: [path.join(anchor, 'cond')] })),
      { supported: true }
    )
    assert.deepEqual(withPlatform('linux', () => evaluateFallbackFrontierPlatformSupport(conditionalPlan.frontiers)), { supported: true })
  })

  it('fails closed when inactive marks reference required or unknown frontiers', () => {
    const anchor = path.join(root, 'skills')
    mkdirSync(anchor)
    return (async () => {
      const plan = await deriveFallbackFrontierPlan([leaf(path.join(anchor, 'added'))])
      assertErrorCode(() => withPlatform('win32', () => evaluateFallbackFrontierPlatformSupport(plan.frontiers, { inactiveFrontierPaths: [path.join(anchor, 'added')] })), FALLBACK_FRONTIER_ERROR_CODES.INVALID_INPUT)
      assertErrorCode(() => withPlatform('win32', () => evaluateFallbackFrontierPlatformSupport(plan.frontiers, { inactiveFrontierPaths: [path.join(anchor, 'unknown')] })), FALLBACK_FRONTIER_ERROR_CODES.INVALID_INPUT)
    })()
  })
})

describe('fallback frontier strict parsing and revalidation', () => {
  it('round-trips derived evidence through the strict parser unchanged', async () => {
    const anchor = path.join(root, 'skills')
    mkdirSync(anchor)
    const plan = await deriveFallbackFrontierPlan([
      leaf(path.join(anchor, 'a')),
      leaf(path.join(anchor, 'n', 'x'), 'link', 'conditional'),
    ])
    const parsed = structuredCloneFrontiers(plan.frontiers)
    assertFallbackFrontierEvidenceList(parsed)
    assert.deepEqual(parsed, plan.frontiers)
  })

  it('rejects tampered evidence: reordering, identity changes, extra fields, forged anchors, stray leaves', async () => {
    const anchor = path.join(root, 'skills')
    mkdirSync(anchor)
    const grouped = await deriveFallbackFrontierPlan([
      leaf(path.join(anchor, 'group', 'a')),
      leaf(path.join(anchor, 'group', 'b')),
    ])
    assert.equal(grouped.frontiers[0].leaves.length, 2)
    const reordered = structuredCloneFrontiers(grouped.frontiers)
    reordered[0] = { ...reordered[0], leaves: [...reordered[0].leaves].reverse() }
    assertErrorCode(() => assertFallbackFrontierEvidenceList(reordered), FALLBACK_FRONTIER_ERROR_CODES.INVALID_INPUT)

    const plan = await deriveFallbackFrontierPlan([
      leaf(path.join(anchor, 'two-a')),
      leaf(path.join(anchor, 'two-b')),
    ])
    const extraField = structuredCloneFrontiers(plan.frontiers)
    const extraRecord = extraField[0] as unknown as Record<string, unknown>
    extraRecord.applied = true
    assertErrorCode(() => assertFallbackFrontierEvidenceList(extraField), FALLBACK_FRONTIER_ERROR_CODES.INVALID_INPUT)

    // Nested leaves must reject unknown fields through the production parser.
    const nestedExtraField = structuredCloneFrontiers(plan.frontiers)
    ;(nestedExtraField[0].leaves[0] as unknown as Record<string, unknown>).tampered = true
    assertErrorCode(() => assertFallbackFrontierEvidenceList(nestedExtraField), FALLBACK_FRONTIER_ERROR_CODES.INVALID_INPUT)

    // Anchors must carry exactly the recorded directory identity fields.
    const anchorMissingType = structuredCloneFrontiers(plan.frontiers)
    delete (anchorMissingType[0].anchor as unknown as Record<string, unknown>).type
    assertErrorCode(() => assertFallbackFrontierEvidenceList(anchorMissingType), FALLBACK_FRONTIER_ERROR_CODES.INVALID_INPUT)
    const anchorWrongType = structuredCloneFrontiers(plan.frontiers)
    anchorWrongType[0].anchor = { ...anchorWrongType[0].anchor, type: 'file' } as unknown as FallbackAnchorIdentity
    assertErrorCode(() => assertFallbackFrontierEvidenceList(anchorWrongType), FALLBACK_FRONTIER_ERROR_CODES.INVALID_INPUT)

    const forgedAnchor = structuredCloneFrontiers(plan.frontiers)
    forgedAnchor[0].anchor = { ...forgedAnchor[0].anchor, path: path.dirname(anchor) }
    assertErrorCode(() => assertFallbackFrontierEvidenceList(forgedAnchor), FALLBACK_FRONTIER_ERROR_CODES.INVALID_INPUT)

    const strayLeaf = structuredCloneFrontiers(plan.frontiers)
    strayLeaf[0].leaves = [leaf(path.join(root, 'elsewhere', 'leaf'))]
    assertErrorCode(() => assertFallbackFrontierEvidenceList(strayLeaf), FALLBACK_FRONTIER_ERROR_CODES.INVALID_INPUT)

    const unsortedFrontiers = structuredCloneFrontiers(plan.frontiers)
    const second = await deriveFallbackFrontierPlan([leaf(path.join(anchor, 'aaa-second'))])
    const combined = [...structuredCloneFrontiers(second.frontiers), ...unsortedFrontiers]
    combined.sort((a, b) => compareUtf8(b.frontierPath, a.frontierPath))
    assertErrorCode(() => assertFallbackFrontierEvidenceList(combined), FALLBACK_FRONTIER_ERROR_CODES.INVALID_INPUT)
  })

  it('rejects globally impossible graphs no derivation could ever produce', async () => {
    const anchor = path.join(root, 'skills')
    mkdirSync(anchor)
    const frontierPath = path.join(anchor, 'impossible-frontier')
    const synthetic = (leaves: FallbackLeafTarget[], activation: FallbackLeafActivation = 'required', frontierOverride = frontierPath): FallbackFrontierEvidence => ({
      frontierPath: frontierOverride,
      activation,
      anchor: { path: path.dirname(frontierOverride), realpath: path.dirname(frontierOverride), device: '1', inode: '1', type: 'directory' },
      leaves,
    })

    // Leaf–leaf nesting inside a single well-formed frontier.
    const nestedLeaves = synthetic([
      leaf(path.join(frontierPath, 'a')),
      leaf(path.join(frontierPath, 'a', 'b')),
    ])
    assertErrorCode(() => assertFallbackFrontierEvidenceList([nestedLeaves]), FALLBACK_FRONTIER_ERROR_CODES.INVALID_INPUT)

    // Nested frontiers (the inner anchor is the outer frontier path).
    const nestedFrontiers = [
      synthetic([leaf(path.join(anchor, 'nest'))], 'required', path.join(anchor, 'nest')),
      synthetic([leaf(path.join(anchor, 'nest', 'inner'))], 'required', path.join(anchor, 'nest', 'inner')),
    ]
    assertErrorCode(() => assertFallbackFrontierEvidenceList(nestedFrontiers), FALLBACK_FRONTIER_ERROR_CODES.INVALID_INPUT)

    // Duplicate leaf ids across frontiers.
    const duplicateIds = [
      synthetic([leaf(path.join(anchor, 'za-frontier', 'x'), 'skill', 'required', 'dup')], 'required', path.join(anchor, 'za-frontier')),
      synthetic([leaf(path.join(anchor, 'zb-frontier', 'y'), 'skill', 'required', 'dup')], 'required', path.join(anchor, 'zb-frontier')),
    ]
    assertErrorCode(() => assertFallbackFrontierEvidenceList(duplicateIds), FALLBACK_FRONTIER_ERROR_CODES.INVALID_INPUT)

    // Activation must aggregate: all-conditional leaves cannot claim required
    // and any required leaf cannot hide behind a conditional frontier.
    const activationLie = synthetic([leaf(path.join(frontierPath, 'cfg'), 'mcp-config', 'conditional', 'cfg')], 'required')
    assertErrorCode(() => assertFallbackFrontierEvidenceList([activationLie]), FALLBACK_FRONTIER_ERROR_CODES.INVALID_INPUT)
    const activationLieReverse = synthetic([leaf(path.join(frontierPath, 'a'), 'skill', 'required', 'req')], 'conditional')
    assertErrorCode(() => assertFallbackFrontierEvidenceList([activationLieReverse]), FALLBACK_FRONTIER_ERROR_CODES.INVALID_INPUT)

    // A file/link leaf can never equal a directory frontier path.
    const linkSelfLeaf = synthetic([leaf(frontierPath, 'link', 'required', 'link-self')])
    assertErrorCode(() => assertFallbackFrontierEvidenceList([linkSelfLeaf]), FALLBACK_FRONTIER_ERROR_CODES.INVALID_INPUT)

    // The leaf sum is globally bounded even when each frontier is within the
    // per-frontier bound: every leaf lives directly beneath its own declared
    // frontier, so per-frontier containment and shape both pass and only the
    // whole-graph aggregate (2 * (maxLeaves / 2 + 1) = maxLeaves + 2 leaves)
    // can reject.
    const overflowLeaves = (prefix: string, frontierDirectory: string): FallbackLeafTarget[] => Array.from(
      { length: Math.floor(FALLBACK_FRONTIER_BOUNDS.maxLeaves / 2) + 1 },
      (_, index) => leaf(path.join(frontierDirectory, `${prefix}-${String(index).padStart(2, '0')}`), 'skill', 'required', `${prefix}-${index}`)
    )
    const aaOverflow = synthetic(overflowLeaves('aa', path.join(anchor, 'aa-frontier')), 'required', path.join(anchor, 'aa-frontier'))
    const bbOverflow = synthetic(overflowLeaves('bb', path.join(anchor, 'bb-frontier')), 'required', path.join(anchor, 'bb-frontier'))
    // Each frontier alone is within every per-frontier bound...
    assertFallbackFrontierEvidenceList([aaOverflow])
    assertFallbackFrontierEvidenceList([bbOverflow])
    // ...so the combined rejection must come from the global leaf-sum rule,
    // not from containment, shape, ids, order, or activation.
    assert.throws(
      () => assertFallbackFrontierEvidenceList([aaOverflow, bbOverflow]),
      (error: unknown) => error instanceof FallbackFrontierError &&
        error.code === FALLBACK_FRONTIER_ERROR_CODES.INVALID_INPUT &&
        error.message.includes(`carries ${FALLBACK_FRONTIER_BOUNDS.maxLeaves + 2} leaves across frontiers; the bound is ${FALLBACK_FRONTIER_BOUNDS.maxLeaves}`),
      'expected the global leaf-sum bound rejection'
    )
  })

  it('accepts the legitimate self-referencing directory skill leaf its own frontier publishes', () => {
    const anchor = path.join(root, 'skills')
    mkdirSync(anchor)
    const frontierPath = path.join(anchor, 'published-frontier')
    const legitimate = {
      frontierPath,
      activation: 'required',
      anchor: { path: anchor, realpath: anchor, device: '1', inode: '1', type: 'directory' },
      leaves: [leaf(frontierPath)],
    }
    assertFallbackFrontierEvidenceList([legitimate])
  })
})

describe('fallback frontier shared leaf derivation', () => {
  const destination = '/planned/dest'
  const linkDir = '/planned/links'
  const trackingPath = '/planned/home/.agents/nodesource-installed.json'

  function baseInputs (overrides: Partial<FallbackFrontierLeafInputs> = {}): FallbackFrontierLeafInputs {
    return {
      ownedSkills: [],
      ownedLinks: [],
      ownedMcpConfigPaths: [],
      trackingPath,
      destination,
      linkDir,
      bundleSkillNames: [],
      ...overrides,
    }
  }

  function evidence (evidencePath: string): FallbackPathEvidence {
    return { path: evidencePath, kind: 'directory' }
  }

  it('derives the complete one-to-one leaf set from bundle, tracked, MCP, and tracking inputs', () => {
    const leaves = deriveFallbackFrontierLeafTargets(baseInputs({
      bundleSkillNames: ['alpha', 'beta'],
      ownedSkills: [evidence(`${destination}/removed-skill`), evidence(`${destination}/alpha`)],
      ownedLinks: [evidence(`${linkDir}/removed-link`)],
      ownedMcpConfigPaths: [evidence('/planned/cfg/b.json'), evidence('/planned/cfg/a.json'), evidence('/planned/cfg/b.json')],
    }))
    assert.deepEqual(leaves, [
      { id: 'skill:alpha', role: 'skill', activation: 'required', path: path.resolve(destination, 'alpha') },
      { id: 'link:alpha', role: 'link', activation: 'required', path: path.resolve(linkDir, 'alpha') },
      { id: 'skill:beta', role: 'skill', activation: 'required', path: path.resolve(destination, 'beta') },
      { id: 'link:beta', role: 'link', activation: 'required', path: path.resolve(linkDir, 'beta') },
      { id: 'owned-skill:removed-skill', role: 'skill', activation: 'conditional', path: path.resolve(`${destination}/removed-skill`) },
      { id: 'owned-link:removed-link', role: 'link', activation: 'conditional', path: path.resolve(`${linkDir}/removed-link`) },
      { id: 'mcp-config:0', role: 'mcp-config', activation: 'conditional', path: path.resolve('/planned/cfg/a.json') },
      { id: 'mcp-config:1', role: 'mcp-config', activation: 'conditional', path: path.resolve('/planned/cfg/b.json') },
      { id: 'tracking', role: 'tracking', activation: 'required', path: path.resolve(trackingPath) },
    ])
  })

  it('is deterministic: equal inputs produce deep-equal leaf graphs', () => {
    const inputs = baseInputs({ bundleSkillNames: ['one'], ownedSkills: [evidence(`${destination}/kept`)] })
    assert.deepEqual(deriveFallbackFrontierLeafTargets(inputs), deriveFallbackFrontierLeafTargets(baseInputs({ bundleSkillNames: ['one'], ownedSkills: [evidence(`${destination}/kept`)] })))
  })

  it('bundle evidence wins over tracked evidence for the same destination path', () => {
    const leaves = deriveFallbackFrontierLeafTargets(baseInputs({
      bundleSkillNames: ['alpha'],
      ownedSkills: [evidence(`${destination}/alpha`)],
      ownedLinks: [evidence(`${linkDir}/alpha`)],
    }))
    assert.deepEqual(leaves, [
      { id: 'skill:alpha', role: 'skill', activation: 'required', path: path.resolve(destination, 'alpha') },
      { id: 'link:alpha', role: 'link', activation: 'required', path: path.resolve(linkDir, 'alpha') },
      { id: 'tracking', role: 'tracking', activation: 'required', path: path.resolve(trackingPath) },
    ])
  })

  it('keeps conditional leaves for tracked destinations the bundle no longer contains', () => {
    const leaves = deriveFallbackFrontierLeafTargets(baseInputs({
      ownedSkills: [evidence(`${destination}/stale-skill`)],
      ownedLinks: [evidence(`${linkDir}/stale-link`)],
    }))
    assert.deepEqual(leaves, [
      { id: 'owned-skill:stale-skill', role: 'skill', activation: 'conditional', path: path.resolve(`${destination}/stale-skill`) },
      { id: 'owned-link:stale-link', role: 'link', activation: 'conditional', path: path.resolve(`${linkDir}/stale-link`) },
      { id: 'tracking', role: 'tracking', activation: 'required', path: path.resolve(trackingPath) },
    ])
  })

  it('assigns stable mcp-config ids after deduplication and UTF-8 sorting regardless of input order', () => {
    const leaves = deriveFallbackFrontierLeafTargets(baseInputs({
      ownedMcpConfigPaths: [evidence('/planned/cfg/zeta.json'), evidence('/planned/cfg/alpha.json'), evidence('/planned/cfg/mid.json'), evidence('/planned/cfg/zeta.json')],
    }))
    const mcpLeaves = leaves.filter((entry) => entry.role === 'mcp-config')
    assert.deepEqual(mcpLeaves, [
      { id: 'mcp-config:0', role: 'mcp-config', activation: 'conditional', path: path.resolve('/planned/cfg/alpha.json') },
      { id: 'mcp-config:1', role: 'mcp-config', activation: 'conditional', path: path.resolve('/planned/cfg/mid.json') },
      { id: 'mcp-config:2', role: 'mcp-config', activation: 'conditional', path: path.resolve('/planned/cfg/zeta.json') },
    ])
  })

  it('rejects basename collisions among distinct tracked destinations instead of collapsing them', () => {
    assertErrorCode(() => deriveFallbackFrontierLeafTargets(baseInputs({
      ownedSkills: [evidence('/planned/one/dup-name'), evidence('/planned/two/dup-name')],
    })), FALLBACK_FRONTIER_ERROR_CODES.COLLISION)
    assertErrorCode(() => deriveFallbackFrontierLeafTargets(baseInputs({
      ownedLinks: [evidence('/planned/one/dup-link'), evidence('/planned/two/dup-link')],
    })), FALLBACK_FRONTIER_ERROR_CODES.COLLISION)
  })

  it('rejects cross-role claims on the same destination instead of silently dropping one', () => {
    // A tracked MCP config equal to the tracking file: the tracking leaf is
    // added later and the roles differ.
    assertErrorCode(() => deriveFallbackFrontierLeafTargets(baseInputs({
      ownedMcpConfigPaths: [evidence(trackingPath)],
    })), FALLBACK_FRONTIER_ERROR_CODES.COLLISION)
    // Destination root equal to the link root: skill and link leaves collide.
    assertErrorCode(() => deriveFallbackFrontierLeafTargets(baseInputs({
      destination,
      linkDir: destination,
      bundleSkillNames: ['alpha'],
    })), FALLBACK_FRONTIER_ERROR_CODES.COLLISION)
    // A bundle skill destination claimed simultaneously as a tracked link.
    assertErrorCode(() => deriveFallbackFrontierLeafTargets(baseInputs({
      bundleSkillNames: ['alpha'],
      ownedLinks: [evidence(path.resolve(destination, 'alpha'))],
    })), FALLBACK_FRONTIER_ERROR_CODES.COLLISION)
    // A tracked link claimed simultaneously as a tracked MCP config.
    assertErrorCode(() => deriveFallbackFrontierLeafTargets(baseInputs({
      ownedLinks: [evidence('/planned/cfg/shared.json')],
      ownedMcpConfigPaths: [evidence('/planned/cfg/shared.json')],
    })), FALLBACK_FRONTIER_ERROR_CODES.COLLISION)
  })

  it('collapses only compatible same-role evidence: identical duplicates merge and bundle evidence wins', () => {
    const leaves = deriveFallbackFrontierLeafTargets(baseInputs({
      bundleSkillNames: ['alpha'],
      ownedSkills: [evidence(`${destination}/alpha`), evidence(`${destination}/alpha`)],
      ownedLinks: [evidence(`${linkDir}/alpha`)],
    }))
    assert.deepEqual(leaves.filter((entry) => entry.path === path.resolve(destination, 'alpha')), [
      { id: 'skill:alpha', role: 'skill', activation: 'required', path: path.resolve(destination, 'alpha') },
    ])
    assert.deepEqual(leaves.filter((entry) => entry.path === path.resolve(linkDir, 'alpha')), [
      { id: 'link:alpha', role: 'link', activation: 'required', path: path.resolve(linkDir, 'alpha') },
    ])
  })

  it('rejects duplicate bundle skill names and unsafe bundle skill names', () => {
    assertErrorCode(() => deriveFallbackFrontierLeafTargets(baseInputs({ bundleSkillNames: ['dup', 'dup'] })), FALLBACK_FRONTIER_ERROR_CODES.INVALID_INPUT)
    assertErrorCode(() => deriveFallbackFrontierLeafTargets(baseInputs({ bundleSkillNames: ['../escape'] })), FALLBACK_FRONTIER_ERROR_CODES.INVALID_INPUT)
  })

  it('omits link leaves entirely when the harness has no link root', () => {
    const leaves = deriveFallbackFrontierLeafTargets(baseInputs({ linkDir: undefined, bundleSkillNames: ['solo'] }))
    assert.deepEqual(leaves, [
      { id: 'skill:solo', role: 'skill', activation: 'required', path: path.resolve(destination, 'solo') },
      { id: 'tracking', role: 'tracking', activation: 'required', path: path.resolve(trackingPath) },
    ])
    assert.ok(leaves.every((entry) => entry.role !== 'link'))
  })

  it('rejects relative roots and malformed evidence inputs', () => {
    assertErrorCode(() => deriveFallbackFrontierLeafTargets(baseInputs({ destination: 'relative/dest' })), FALLBACK_FRONTIER_ERROR_CODES.INVALID_INPUT)
    assertErrorCode(() => deriveFallbackFrontierLeafTargets(baseInputs({ linkDir: 'relative/links' })), FALLBACK_FRONTIER_ERROR_CODES.INVALID_INPUT)
    assertErrorCode(() => deriveFallbackFrontierLeafTargets(baseInputs({ trackingPath: 'relative/tracking.json' })), FALLBACK_FRONTIER_ERROR_CODES.INVALID_INPUT)
    assertErrorCode(() => deriveFallbackFrontierLeafTargets(baseInputs({ ownedSkills: [{ kind: 'directory' } as unknown as FallbackPathEvidence] })), FALLBACK_FRONTIER_ERROR_CODES.INVALID_INPUT)
    assertErrorCode(() => deriveFallbackFrontierLeafTargets(baseInputs({ ownedSkills: 'not-an-array' as unknown as FallbackPathEvidence[] })), FALLBACK_FRONTIER_ERROR_CODES.INVALID_INPUT)
    assertErrorCode(() => deriveFallbackFrontierLeafTargets({ ...baseInputs(), unexpected: true } as unknown as FallbackFrontierLeafInputs), FALLBACK_FRONTIER_ERROR_CODES.INVALID_INPUT)
    assertErrorCode(() => deriveFallbackFrontierLeafTargets({ ...baseInputs(), trackingPath: undefined } as unknown as FallbackFrontierLeafInputs), FALLBACK_FRONTIER_ERROR_CODES.INVALID_INPUT)
  })
})

describe('fallback journal physical target derivation', () => {
  const fakeAnchorIdentity = (anchorPath: string): FallbackAnchorIdentity => ({
    path: anchorPath,
    realpath: anchorPath,
    type: 'directory',
    device: '1',
    inode: '1',
  })
  const frontierEvidence = (frontierPath: string, leafPaths: readonly string[]): FallbackFrontierEvidence => ({
    frontierPath,
    activation: 'required',
    anchor: fakeAnchorIdentity(path.dirname(frontierPath)),
    leaves: leafPaths
      .map((leafPath, index) => ({ id: `skill:${path.basename(leafPath)}-${index}`, role: 'skill' as const, activation: 'required' as const, path: leafPath }))
      .sort((left, right) => compareUtf8(left.path, right.path)),
  })
  const missingEvidence = (target: string): FallbackPathEvidence => ({ path: target, kind: 'missing' })
  const manifestWith = (frontiers: readonly FallbackFrontierEvidence[], extra: Partial<FallbackTransactionIdentity> = {}): FallbackTransactionIdentity => ({
    installationId: 'opencode:fallback',
    harness: 'opencode',
    trackingPath: '/home/u/.agents/.nodesource-installed.json',
    trackingDigest: 'a'.repeat(64),
    protocolVersion: FALLBACK_PROTOCOL_VERSION,
    nonce: 'nonce',
    plannedMissingFrontiers: frontiers,
    ownedSkills: [],
    ownedLinks: [],
    ownedMcpFields: [],
    ownedMcpConfigPaths: [],
    bundleDestinations: [],
    approvedDestinationRoots: ['/home/u/.config/opencode/skills'],
    ...extra,
  })

  it('replaces every covered leaf with exactly one planned-missing frontier entry and retains uncovered targets', () => {
    const frontierPath = '/home/u/.config/opencode/skills'
    const manifest = manifestWith([frontierEvidence(frontierPath, [path.join(frontierPath, 'alpha'), path.join(frontierPath, 'beta')])], {
      ownedSkills: [missingEvidence(path.join(frontierPath, 'alpha'))],
      bundleDestinations: [missingEvidence(path.join(frontierPath, 'alpha')), missingEvidence(path.join(frontierPath, 'beta'))],
      ownedMcpConfigPaths: [missingEvidence('/home/u/opencode.json')],
    })
    assert.deepEqual(deriveFallbackJournalPhysicalTargets(manifest), [
      { path: manifest.trackingPath, frontier: false },
      { path: '/home/u/opencode.json', frontier: false },
      { path: frontierPath, frontier: true },
    ])
  })

  it('keeps separate frontiers as separate non-overlapping entries in UTF-8 byte order', () => {
    const frontierA = '/home/u/one/skills'
    const frontierB = '/home/u/two/skills'
    // Manifest evidence must already be strictly sorted; the helper keeps
    // that order instead of reordering it.
    const manifest = manifestWith(
      [frontierEvidence(frontierA, [path.join(frontierA, 'a')]), frontierEvidence(frontierB, [path.join(frontierB, 'b')])],
      { bundleDestinations: [missingEvidence(path.join(frontierA, 'a')), missingEvidence(path.join(frontierB, 'b'))] }
    )
    assert.deepEqual(deriveFallbackJournalPhysicalTargets(manifest), [
      { path: manifest.trackingPath, frontier: false },
      { path: frontierA, frontier: true },
      { path: frontierB, frontier: true },
    ])
  })

  it('represents a self-referencing frontier leaf by the frontier entry alone and dedupes retained evidence', () => {
    const frontierPath = '/home/u/.config/opencode/skills/added'
    const manifest = manifestWith([frontierEvidence(frontierPath, [frontierPath])], {
      ownedSkills: [missingEvidence(frontierPath)],
      bundleDestinations: [missingEvidence(frontierPath)],
    })
    assert.deepEqual(deriveFallbackJournalPhysicalTargets(manifest), [
      { path: manifest.trackingPath, frontier: false },
      { path: frontierPath, frontier: true },
    ])
  })

  it('rejects a manifest candidate hidden under a frontier without being one of its authorized leaves', () => {
    const frontierPath = '/home/u/.config/opencode/skills'
    const hidden = manifestWith([frontierEvidence(frontierPath, [path.join(frontierPath, 'alpha')])], {
      bundleDestinations: [missingEvidence(path.join(frontierPath, 'alpha')), missingEvidence(path.join(frontierPath, 'hidden'))],
    })
    assertErrorCode(() => deriveFallbackJournalPhysicalTargets(hidden), FALLBACK_FRONTIER_ERROR_CODES.INVALID_INPUT)
  })

  it('rejects a graph whose leaf is covered by two different frontiers at the strict parse layer', () => {
    // A candidate covered by two frontiers requires the same leaf path in
    // both frontiers, which the strict parser already refuses; the helper
    // therefore never even sees such a graph.
    const shared = '/home/u/shared'
    const graph = [
      frontierEvidence('/home/u/one', [path.join('/home/u/one', 'a'), shared]),
      frontierEvidence('/home/u/two', [shared, path.join('/home/u/two', 'b')]),
    ]
    assert.throws(() => assertFallbackFrontierEvidenceList(graph), (error: unknown) => error instanceof FallbackFrontierError)
  })
})

describe('fallback frontier journal revalidation', () => {
  function realAnchorIdentity (anchorPath: string): FallbackAnchorIdentity {
    const stats = lstatSync(anchorPath, { bigint: true })
    const real = realpathSync(anchorPath)
    if (real !== anchorPath || !stats.isDirectory()) throw new Error(`fixture anchor ${anchorPath} must be a real directory`)
    return { path: anchorPath, realpath: real, type: 'directory', device: stats.dev.toString(10), inode: stats.ino.toString(10) }
  }

  function evidenceFor (anchor: string, frontierPath: string): FallbackFrontierEvidence {
    return {
      frontierPath,
      activation: 'required',
      anchor: realAnchorIdentity(anchor),
      leaves: [{ id: 'skill:alpha', role: 'skill', activation: 'required', path: path.join(frontierPath, 'alpha') }],
    }
  }

  const driftRejection = (error: unknown): boolean => error instanceof FallbackFrontierError && error.code === FALLBACK_FRONTIER_ERROR_CODES.DRIFT

  it('accepts evidence whose anchor identity, component chain, missing frontier, and leaf graph all still hold', async () => {
    const anchor = path.join(root, 'anchor')
    mkdirSync(anchor)
    const frontierPath = path.join(anchor, 'new-root')
    const evidence = evidenceFor(anchor, frontierPath)
    await revalidateFallbackFrontierEvidence([evidence])
    assert.ok(true)
  })

  it('rejects drift when the frontier path appears before begin or claim', async () => {
    const anchor = path.join(root, 'anchor')
    mkdirSync(anchor)
    const frontierPath = path.join(anchor, 'new-root')
    const evidence = evidenceFor(anchor, frontierPath)
    mkdirSync(frontierPath)
    // The frontier-exists guard fires before leaf-graph rederivation, so
    // this case covers the guard's exact reason — not graph disagreement.
    await assert.rejects(revalidateFallbackFrontierEvidence([evidence]), (error: unknown) => {
      return error instanceof FallbackFrontierError && error.code === FALLBACK_FRONTIER_ERROR_CODES.DRIFT &&
        /the frontier path exists/.test(error.message)
    })
  })

  it('rejects drift when the anchor inode is replaced', async () => {
    const anchor = path.join(root, 'anchor')
    mkdirSync(anchor)
    const frontierPath = path.join(anchor, 'new-root')
    const evidence = evidenceFor(anchor, frontierPath)
    // Replace the anchor's directory entry with a freshly created directory:
    // both existed at the same time, so the replacement is guaranteed to
    // carry a new inode. Rename the original aside first (preserving its
    // inode and avoiding deletion/inode reuse): rename-over-existing is not
    // permitted on every platform.
    const replacement = path.join(root, 'anchor-replacement')
    mkdirSync(replacement)
    renameSync(anchor, `${anchor}-replaced`)
    renameSync(replacement, anchor)
    await assert.rejects(revalidateFallbackFrontierEvidence([evidence]), driftRejection)
  })

  it('rejects drift when an anchor component becomes a symlink instead of a real directory', async (t) => {
    const realDir = path.join(root, 'real-anchor-parent')
    mkdirSync(realDir)
    const anchor = path.join(realDir, 'anchor')
    mkdirSync(anchor)
    const evidence = evidenceFor(anchor, path.join(anchor, 'new-root'))
    // Replace the real parent directory with a symlink to an existing
    // directory: every component of the anchor chain must be a real
    // directory, never a link.
    rmSync(realDir, { recursive: true, force: true })
    if (!createSymlinkForTest(t, root, realDir)) return
    await assert.rejects(revalidateFallbackFrontierEvidence([evidence]), driftRejection)
  })
})

describe('deriveFrontierTreeExpectation', () => {
  const frontierFor = (leaves: FallbackLeafTarget[]): FallbackFrontierEvidence => ({
    frontierPath: path.join(root, 'anchor', 'new-root'),
    activation: 'required',
    anchor: { path: path.join(root, 'anchor'), realpath: path.join(root, 'anchor'), type: 'directory', device: '1', inode: '2' },
    leaves,
  })

  it('derives exact directories, leaf kinds, and link targets from trusted evidence', () => {
    const frontierPath = path.join(root, 'anchor', 'new-root')
    const skillPath = path.join(root, 'dest-root', 'gamma')
    const frontier = frontierFor([
      leaf(path.join(frontierPath, 'alpha'), 'skill', 'required', 'skill:alpha'),
      leaf(path.join(frontierPath, 'nested', 'config.json'), 'mcp-config', 'required', 'mcp-config:0'),
      leaf(path.join(frontierPath, 'nested', 'deep', 'tracking.json'), 'tracking', 'conditional', 'tracking'),
      leaf(path.join(frontierPath, 'gamma'), 'link', 'required', 'link:gamma'),
    ])
    const allLeaves = [leaf(skillPath, 'skill', 'required', 'skill:gamma'), ...frontier.leaves]
    const expectation = deriveFrontierTreeExpectation(frontier, allLeaves)
    assert.deepEqual(expectation.directories, ['nested', path.join('nested', 'deep')])
    assert.deepEqual([...expectation.leafKinds.entries()].sort(([a], [b]) => compareUtf8(a, b)), [
      ['alpha', 'directory'],
      ['gamma', 'symlink'],
      [path.join('nested', 'config.json'), 'file'],
      [path.join('nested', 'deep', 'tracking.json'), 'file'],
    ])
    assert.deepEqual(expectation.linkTargets, new Map([['gamma', skillPath]]))
  })

  it('rejects a link leaf without a corresponding skill:<name> leaf', () => {
    const frontier = frontierFor([leaf(path.join(frontierFor([]).frontierPath, 'gamma'), 'link', 'required', 'link:gamma')])
    assert.throws(() => deriveFrontierTreeExpectation(frontier, [...frontier.leaves]), (error: unknown) => {
      return error instanceof FallbackFrontierError && error.code === FALLBACK_FRONTIER_ERROR_CODES.INVALID_INPUT &&
        /skill:<name>/.test(error.message)
    })
  })

  it('rejects a leaf outside the frontier', () => {
    const frontier = frontierFor([leaf(path.join(root, 'elsewhere', 'alpha'), 'skill', 'required', 'skill:alpha')])
    assert.throws(() => deriveFrontierTreeExpectation(frontier, [...frontier.leaves]), FallbackFrontierError)
  })

  it('rejects two leaves collapsing into one relative path', () => {
    const frontierPath = path.join(root, 'anchor', 'new-root')
    const frontier = frontierFor([
      leaf(path.join(frontierPath, 'alpha'), 'skill', 'required', 'skill:alpha'),
      leaf(path.join(frontierPath, 'alpha'), 'skill', 'required', 'owned-skill:alpha'),
    ])
    assert.throws(() => deriveFrontierTreeExpectation(frontier, [...frontier.leaves]), FallbackFrontierError)
  })

  it('rejects a non-canonical frontier path', () => {
    const frontier = { ...frontierFor([]), frontierPath: `${frontierFor([]).frontierPath}${path.sep}..${path.sep}other` }
    assert.throws(() => deriveFrontierTreeExpectation(frontier, [...frontier.leaves]), FallbackFrontierError)
  })

  it('supports a directory skill leaf that exactly equals the frontier root', () => {
    const frontierPath = path.join(root, 'anchor', 'new-root')
    const frontier = frontierFor([leaf(frontierPath, 'skill', 'required', 'skill:whole')])
    const expectation = deriveFrontierTreeExpectation(frontier, [...frontier.leaves])
    assert.deepEqual([...expectation.leafKinds.entries()], [['', 'directory']])
    assert.deepEqual(expectation.directories, [])
    assert.deepEqual(expectation.linkTargets, new Map())
  })

  it('rejects a non-directory leaf that equals the frontier root', () => {
    const frontierPath = path.join(root, 'anchor', 'new-root')
    const frontier = frontierFor([leaf(frontierPath, 'link', 'required', 'link:whole')])
    assert.throws(() => deriveFrontierTreeExpectation(frontier, [...frontier.leaves]), (error: unknown) => {
      return error instanceof FallbackFrontierError && /only a directory skill leaf may equal the frontier root/.test(error.message)
    })
  })

  it('binds a link leaf to an existing skill destination through the resolver option', () => {
    const frontierPath = path.join(root, 'anchor', 'new-root')
    const existingSkillPath = path.join(root, 'dest-root', 'gamma')
    const frontier = frontierFor([leaf(path.join(frontierPath, 'gamma'), 'link', 'required', 'link:gamma')])
    // No skill:gamma leaf anywhere in allLeaves; the resolver (built from
    // trusted manifest evidence by the journal) supplies the binding.
    const expectation = deriveFrontierTreeExpectation(frontier, [...frontier.leaves], {
      skillDestinationResolver: (bound) => bound.id === 'link:gamma' ? existingSkillPath : undefined,
    })
    assert.deepEqual(expectation.linkTargets, new Map([['gamma', existingSkillPath]]))
    // Without the resolver the same evidence fails closed.
    assert.throws(() => deriveFrontierTreeExpectation(frontier, [...frontier.leaves]), /skill:<name>/)
  })
})

describe('selectActiveFallbackFrontierLeaves', () => {
  const frontierWithConditional = (): FallbackFrontierEvidence => ({
    frontierPath: path.join(root, 'anchor', 'new-root'),
    activation: 'required',
    anchor: { path: path.join(root, 'anchor'), realpath: path.join(root, 'anchor'), type: 'directory', device: '1', inode: '2' },
    leaves: [
      leaf(path.join(root, 'anchor', 'new-root', 'alpha'), 'skill', 'required', 'skill:alpha'),
      leaf(path.join(root, 'anchor', 'new-root', 'beta'), 'skill', 'conditional', 'skill:beta'),
      leaf(path.join(root, 'anchor', 'new-root', 'gamma'), 'skill', 'conditional', 'skill:gamma'),
    ],
  })

  it('always includes required leaves and omits conditionals by default', () => {
    const frontier = frontierWithConditional()
    const selected = selectActiveFallbackFrontierLeaves(frontier)
    assert.deepEqual([...selected], [frontier.leaves[0]])
  })

  it('adds exactly the selected conditional leaves and keeps UTF-8 path order', () => {
    const frontier = frontierWithConditional()
    const selected = selectActiveFallbackFrontierLeaves(frontier, ['skill:gamma'])
    assert.deepEqual([...selected], [frontier.leaves[0], frontier.leaves[2]])
  })

  it('is deterministic and never mutates the frontier evidence', () => {
    const frontier = frontierWithConditional()
    const snapshot = JSON.stringify(frontier)
    const first = selectActiveFallbackFrontierLeaves(frontier, ['skill:beta', 'skill:gamma'])
    const second = selectActiveFallbackFrontierLeaves(frontier, ['skill:gamma', 'skill:beta'])
    assert.deepEqual([...first], [...second])
    assert.equal(JSON.stringify(frontier), snapshot)
    assert.ok(Object.isFrozen(first))
  })

  it('rejects unknown, duplicate, required-id, malformed, and overflow selectors', () => {
    const frontier = frontierWithConditional()
    const invalidSelector = (selector: unknown): void => {
      assert.throws(() => selectActiveFallbackFrontierLeaves(frontier, selector as readonly string[]), (error: unknown) => error instanceof FallbackFrontierError && error.code === FALLBACK_FRONTIER_ERROR_CODES.INVALID_INPUT)
    }
    invalidSelector(['skill:nope'])
    invalidSelector(['skill:beta', 'skill:beta'])
    invalidSelector(['skill:alpha'])
    invalidSelector([''])
    invalidSelector([42])
    invalidSelector([null])
    invalidSelector(Array.from({ length: FALLBACK_FRONTIER_BOUNDS.maxLeaves + 1 }, (_, index) => `skill:x${index}`))
  })

  it('rejects malformed frontier evidence before selection', () => {
    const malformed = frontierWithConditional() as unknown as Record<string, unknown>
    malformed.leaves = []
    assert.throws(() => selectActiveFallbackFrontierLeaves(malformed as unknown as FallbackFrontierEvidence), (error: unknown) => error instanceof FallbackFrontierError && error.code === FALLBACK_FRONTIER_ERROR_CODES.INVALID_INPUT)
  })

  it('accepts an empty selector for an all-conditional frontier and yields an empty selection', () => {
    const frontier = frontierWithConditional()
    const allConditional: FallbackFrontierEvidence = {
      ...frontier,
      activation: 'conditional',
      leaves: frontier.leaves.map((entry) => ({ ...entry, activation: 'conditional' as const })),
    }
    const selected = selectActiveFallbackFrontierLeaves(allConditional)
    assert.deepEqual([...selected], [])
  })
})

describe('trusted link materialization policy', () => {
  it('derives the policy only from the trusted harness plus the runtime platform', () => {
    // Pi always copies skill directories, on every platform.
    assert.deepEqual([...fallbackLinkMaterialization('pi').allowedKinds], ['directory'])
    if (process.platform === 'win32') {
      assert.deepEqual([...fallbackLinkMaterialization('claude').allowedKinds], ['symlink', 'directory'])
    } else {
      // Every other harness on POSIX requires real symlinks.
      assert.deepEqual([...fallbackLinkMaterialization('claude').allowedKinds], ['symlink'])
      assert.deepEqual([...fallbackLinkMaterialization('codex').allowedKinds], ['symlink'])
      assert.deepEqual([...fallbackLinkMaterialization('opencode').allowedKinds], ['symlink'])
      // On Windows the same harnesses may fall back to copied directories.
      assert.deepEqual(withPlatform('win32', () => [...fallbackLinkMaterialization('claude').allowedKinds]), ['symlink', 'directory'])
      assert.deepEqual(withPlatform('win32', () => [...fallbackLinkMaterialization('antigravity').allowedKinds]), ['symlink', 'directory'])
      assert.deepEqual(withPlatform('win32', () => [...fallbackLinkMaterialization('pi').allowedKinds]), ['directory'])
    }
    assert.throws(
      () => fallbackLinkMaterialization('unknown' as HarnessType),
      (error: unknown) => error instanceof FallbackFrontierError
    )
  })

  it('accepts an existing Pi copied-directory link under the Pi policy and rejects the same shape under the strict POSIX policy', async () => {
    const anchor = path.join(root, 'pi-skills')
    mkdirSync(path.join(anchor, 'real-skill'), { recursive: true })
    writeFileSync(path.join(anchor, 'real-skill', 'SKILL.md'), '# real\n')
    // Pi materializes managed links as copied directories: the "link" leaf is
    // a real directory on disk.
    mkdirSync(path.join(anchor, 'copied-link'), { recursive: true })
    writeFileSync(path.join(anchor, 'copied-link', 'SKILL.md'), '# copied\n')
    const linkLeaf = leaf(path.join(anchor, 'copied-link'), 'link', 'conditional', 'link:tracked')
    const piPlan = await deriveFallbackFrontierPlan([linkLeaf], fallbackLinkMaterialization('pi'))
    assert.deepEqual(piPlan.existingLeaves, [linkLeaf])
    assert.deepEqual(piPlan.frontiers, [])
    assert.deepEqual(piPlan.missingLeaves, [])
    // The default (strict symlink) policy — what every non-Pi harness derives
    // on POSIX — must reject the very same live directory shape.
    await assert.rejects(
      deriveFallbackFrontierPlan([linkLeaf]),
      (error: unknown) => error instanceof FallbackFrontierError && error.code === FALLBACK_FRONTIER_ERROR_CODES.LEAF_KIND_MISMATCH
    )
  })

  it('accepts both directory and symlink link leaves under the Windows permissive policy regardless of host platform', async (t) => {
    const anchor = path.join(root, 'win-skills')
    mkdirSync(path.join(anchor, 'real-skill'), { recursive: true })
    const winPolicy = withPlatform('win32', () => fallbackLinkMaterialization('claude'))
    assert.deepEqual([...winPolicy.allowedKinds], ['symlink', 'directory'])
    // Copied-directory form.
    const copied = leaf(path.join(anchor, 'copied'), 'link', 'conditional', 'link:copied')
    mkdirSync(copied.path, { recursive: true })
    const copiedPlan = await deriveFallbackFrontierPlan([copied], winPolicy)
    assert.deepEqual(copiedPlan.existingLeaves, [copied])
    assert.deepEqual(copiedPlan.frontiers, [])
    // Real-symlink form stays equally legitimate under the permissive policy.
    const linked = leaf(path.join(anchor, 'linked'), 'link', 'conditional', 'link:linked')
    if (!createSymlinkForTest(t, path.join(anchor, 'real-skill'), linked.path)) return
    const linkedPlan = await deriveFallbackFrontierPlan([linked], winPolicy)
    assert.deepEqual(linkedPlan.existingLeaves, [linked])
  })

  it('keeps a missing Pi terminal link an independent missing leaf, never a frontier', async () => {
    const anchor = path.join(root, 'pi-links')
    mkdirSync(anchor)
    const missingLink = leaf(path.join(anchor, 'skill-link'), 'link', 'conditional', 'link:missing')
    const plan = await deriveFallbackFrontierPlan([missingLink], fallbackLinkMaterialization('pi'))
    assert.deepEqual(plan.missingLeaves, [missingLink])
    assert.deepEqual(plan.existingLeaves, [])
    assert.deepEqual(plan.frontiers, [])
  })

  it('still rejects kind-drifting link leaves under permissive policies', async (t) => {
    const anchor = path.join(root, 'pi-negatives')
    mkdirSync(anchor)
    // A regular file is never a legitimate managed link, even for Pi.
    const fileLink = leaf(path.join(anchor, 'file-link'), 'link', 'conditional', 'link:file')
    writeFileSync(fileLink.path, 'not a link\n')
    await assert.rejects(
      deriveFallbackFrontierPlan([fileLink], fallbackLinkMaterialization('pi')),
      (error: unknown) => error instanceof FallbackFrontierError && error.code === FALLBACK_FRONTIER_ERROR_CODES.LEAF_KIND_MISMATCH
    )
    // And a symlink is never a legitimate Pi copied-directory link.
    mkdirSync(path.join(root, 'pi-target'), { recursive: true })
    const symlinkLink = leaf(path.join(root, 'symlink-link'), 'link', 'conditional', 'link:symlink')
    if (!createSymlinkForTest(t, path.join(root, 'pi-target'), symlinkLink.path)) return
    await assert.rejects(
      deriveFallbackFrontierPlan([symlinkLink], fallbackLinkMaterialization('pi')),
      (error: unknown) => error instanceof FallbackFrontierError && error.code === FALLBACK_FRONTIER_ERROR_CODES.LEAF_KIND_MISMATCH
    )
  })

  it('revalidates a Pi link-leaf frontier under the Pi policy with unchanged protocol v3 evidence', async () => {
    const anchor = path.join(root, 'pi-anchor')
    mkdirSync(anchor)
    const frontierPath = path.join(anchor, 'new-root')
    const skillLeaf = leaf(path.join(frontierPath, 'alpha'), 'skill', 'required', 'skill:alpha')
    const linkLeaf = leaf(path.join(frontierPath, 'tracked'), 'link', 'conditional', 'link:tracked')
    const plan = await deriveFallbackFrontierPlan([skillLeaf, linkLeaf], fallbackLinkMaterialization('pi'))
    assert.equal(plan.frontiers.length, 1)
    // The strict parser must accept the derived evidence unchanged, and
    // revalidation under the same trusted harness policy must hold.
    assertFallbackFrontierEvidenceList(plan.frontiers)
    await assert.doesNotReject(revalidateFallbackFrontierEvidence(plan.frontiers, fallbackLinkMaterialization('pi')))
  })
})
