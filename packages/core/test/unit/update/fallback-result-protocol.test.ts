import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  FALLBACK_CHILD_RESULT_MAX_BYTES,
  FALLBACK_CHILD_RESULT_MAX_PRESERVED,
  FALLBACK_CHILD_RESULT_SCHEMA,
  childResultArgs,
  fallbackChildResultMessage,
  isValidChildResultCode,
  plannedChildResultPath,
  readValidatedFallbackChildResult,
  writeFallbackChildResult,
  type ContainmentDirectoryIdentity,
} from '../../../src/update/fallback-result-protocol.js'

describe('fallback child result protocol', () => {
  let directory: string
  let previousDirectory: string | undefined

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'nsolid-plugin-result-protocol-'))
    chmodSync(directory, 0o700)
    previousDirectory = process.env.NSOLID_RESULT_PROTOCOL_TEST_DIR
    process.env.NSOLID_RESULT_PROTOCOL_TEST_DIR = directory
  })

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true })
    if (previousDirectory === undefined) delete process.env.NSOLID_RESULT_PROTOCOL_TEST_DIR
    else process.env.NSOLID_RESULT_PROTOCOL_TEST_DIR = previousDirectory
  })

  function resultPath (): string {
    return path.join(directory, 'result.json')
  }

  /** Identity of the beforeEach-created directory, mirroring production recording. */
  function containment (): ContainmentDirectoryIdentity {
    const stat = lstatSync(path.resolve(directory))
    return { directory: path.resolve(directory), dev: stat.dev, ino: stat.ino }
  }

  it('builds explicit child args for the planned result path', () => {
    assert.deepEqual(childResultArgs(resultPath()), ['--result', resultPath()])
  })

  it('extracts the planned result path from parent command args', () => {
    const args = ['exec', '--yes', '--package=x.tgz', '--', 'nsolid-plugin-refresh-owned', '--transaction', '/tmp/t.json', ...childResultArgs(resultPath())]
    assert.equal(plannedChildResultPath(args), resultPath())
    assert.equal(plannedChildResultPath(['exec']), undefined)
    assert.equal(plannedChildResultPath(['--result']), undefined)
  })

  it('accepts only safe structured error code shapes', () => {
    assert.equal(isValidChildResultCode('MCP_RECONCILIATION_REQUIRED'), true)
    assert.equal(isValidChildResultCode('FALLBACK_MCP_DRIFT'), true)
    assert.equal(isValidChildResultCode(''), false)
    assert.equal(isValidChildResultCode('bad-code'), false)
    assert.equal(isValidChildResultCode('lower_case'), false)
    assert.equal(isValidChildResultCode('WITH SPACE'), false)
    assert.equal(isValidChildResultCode(undefined), false)
    assert.equal(isValidChildResultCode(42), false)
  })

  it('writes the envelope atomically with mode 0600 and no leftovers', async () => {
    const target = resultPath()
    await writeFallbackChildResult(target, 'nonce-1', 'MCP_RECONCILIATION_REQUIRED', { attempted: false })
    const stat = statSync(target)
    if (process.platform !== 'win32') assert.equal(stat.mode & 0o777, 0o600)
    const envelope = JSON.parse(readFileSync(target, 'utf8'))
    assert.equal(envelope.schema, FALLBACK_CHILD_RESULT_SCHEMA)
    assert.equal(envelope.nonce, 'nonce-1')
    assert.equal(envelope.code, 'MCP_RECONCILIATION_REQUIRED')
    assert.deepEqual(envelope.rollback, { attempted: false })
    const leftovers = readdirSync(directory).filter((name) => name !== 'result.json')
    assert.deepEqual(leftovers, [], 'a temporary sibling must never survive the atomic write')
  })

  it('refuses to publish a code that is not a safe structured identifier', async () => {
    const target = resultPath()
    await writeFallbackChildResult(target, 'nonce-1', 'arbitrary text with secrets', { attempted: false })
    assert.throws(() => statSync(target), 'no envelope may be written for an unsafe code')
  })

  it('round-trips a valid envelope through the parent-side validator', async () => {
    const target = resultPath()
    await writeFallbackChildResult(target, 'nonce-1', 'MCP_RECONCILIATION_REQUIRED', { attempted: false })
    const envelope = await readValidatedFallbackChildResult(target, 'nonce-1', { containmentDirectories: [containment()] })
    assert.ok(envelope)
    assert.equal(envelope.code, 'MCP_RECONCILIATION_REQUIRED')
    assert.deepEqual(envelope.rollback, { attempted: false })
  })

  it('publishes an envelope exactly at the byte limit and refuses one byte more', async () => {
    const code = 'MCP_RECONCILIATION_REQUIRED'
    const probe = JSON.stringify({ schema: FALLBACK_CHILD_RESULT_SCHEMA, nonce: '', code })
    const exactNonce = 'x'.repeat(FALLBACK_CHILD_RESULT_MAX_BYTES - Buffer.byteLength(probe))
    const exactPayload = JSON.stringify({ schema: FALLBACK_CHILD_RESULT_SCHEMA, nonce: exactNonce, code })
    assert.equal(Buffer.byteLength(exactPayload), FALLBACK_CHILD_RESULT_MAX_BYTES)

    const exactTarget = resultPath()
    await writeFallbackChildResult(exactTarget, exactNonce, code, undefined)
    assert.equal(statSync(exactTarget).size, FALLBACK_CHILD_RESULT_MAX_BYTES)
    const accepted = await readValidatedFallbackChildResult(exactTarget, exactNonce, { containmentDirectories: [containment()] })
    assert.ok(accepted)
    assert.equal(accepted.code, code)

    const oversizedTarget = path.join(directory, 'oversized-result.json')
    const oversizedNonce = `${exactNonce}x`
    const oversizedPayload = JSON.stringify({ schema: FALLBACK_CHILD_RESULT_SCHEMA, nonce: oversizedNonce, code })
    assert.equal(Buffer.byteLength(oversizedPayload), FALLBACK_CHILD_RESULT_MAX_BYTES + 1)
    await writeFallbackChildResult(oversizedTarget, oversizedNonce, code, undefined)
    assert.equal(existsSync(oversizedTarget), false, 'an over-limit envelope must not be published')
    assert.equal(
      await readValidatedFallbackChildResult(oversizedTarget, oversizedNonce, { containmentDirectories: [containment()] }),
      undefined,
      'an absent over-limit result must preserve the parent generic-fallback path'
    )
  })

  it('rejects a result path outside the parent-owned containment directories', async () => {
    const outside = mkdtempSync(path.join(tmpdir(), 'nsolid-plugin-result-outside-'))
    const target = path.join(outside, 'result.json')
    await writeFallbackChildResult(target, 'nonce-1', 'MCP_RECONCILIATION_REQUIRED', { attempted: false })
    const envelope = await readValidatedFallbackChildResult(target, 'nonce-1', { containmentDirectories: [containment()] })
    assert.equal(envelope, undefined)
    const noContainment = await readValidatedFallbackChildResult(target, 'nonce-1', {})
    assert.equal(noContainment, undefined, 'validation must fail closed without containment evidence')
    rmSync(outside, { recursive: true, force: true })
  })

  it('rejects missing, malformed, oversized, wrong-nonce, schema-skewed, and unsafe-code envelopes', async () => {
    const target = resultPath()
    assert.equal(await readValidatedFallbackChildResult(target, 'nonce-1', { containmentDirectories: [containment()] }), undefined)

    writeFileSync(target, 'not json at all', { mode: 0o600 })
    assert.equal(await readValidatedFallbackChildResult(target, 'nonce-1', { containmentDirectories: [containment()] }), undefined)

    const oversized = { schema: FALLBACK_CHILD_RESULT_SCHEMA, nonce: 'nonce-1', code: 'MCP_RECONCILIATION_REQUIRED', pad: 'x'.repeat(FALLBACK_CHILD_RESULT_MAX_BYTES) }
    writeFileSync(target, JSON.stringify(oversized), { mode: 0o600 })
    assert.equal(await readValidatedFallbackChildResult(target, 'nonce-1', { containmentDirectories: [containment()] }), undefined)

    await writeFallbackChildResult(target, 'nonce-1', 'MCP_RECONCILIATION_REQUIRED', { attempted: false })
    assert.equal(await readValidatedFallbackChildResult(target, 'other-nonce', { containmentDirectories: [containment()] }), undefined)

    writeFileSync(target, JSON.stringify({ schema: FALLBACK_CHILD_RESULT_SCHEMA + 1, nonce: 'nonce-1', code: 'MCP_RECONCILIATION_REQUIRED' }), { mode: 0o600 })
    assert.equal(await readValidatedFallbackChildResult(target, 'nonce-1', { containmentDirectories: [containment()] }), undefined)

    writeFileSync(target, JSON.stringify({ schema: FALLBACK_CHILD_RESULT_SCHEMA, nonce: 'nonce-1', code: 'bad code shape' }), { mode: 0o600 })
    assert.equal(await readValidatedFallbackChildResult(target, 'nonce-1', { containmentDirectories: [containment()] }), undefined)

    writeFileSync(target, JSON.stringify({ schema: FALLBACK_CHILD_RESULT_SCHEMA, nonce: 'nonce-1', code: 'MCP_RECONCILIATION_REQUIRED', rollback: { attempted: 'yes' } }), { mode: 0o600 })
    assert.equal(await readValidatedFallbackChildResult(target, 'nonce-1', { containmentDirectories: [containment()] }), undefined)
  })

  it('refuses to follow a symlinked result path', async () => {
    const realDir = mkdtempSync(path.join(tmpdir(), 'nsolid-plugin-result-real-'))
    const realTarget = path.join(realDir, 'real-result.json')
    await writeFallbackChildResult(realTarget, 'nonce-1', 'MCP_RECONCILIATION_REQUIRED', { attempted: false })
    const target = resultPath()
    symlinkSync(realTarget, target)
    const envelope = await readValidatedFallbackChildResult(target, 'nonce-1', { containmentDirectories: [containment()] })
    assert.equal(envelope, undefined)
    rmSync(realDir, { recursive: true, force: true })
  })

  it('rejects a result whose containment directory was swapped for a symlink', async () => {
    const recorded = containment()
    const other = mkdtempSync(path.join(tmpdir(), 'nsolid-plugin-result-swapped-'))
    try {
      const target = resultPath()
      await writeFallbackChildResult(target, 'nonce-1', 'MCP_RECONCILIATION_REQUIRED', { attempted: false })
      // A nonce-valid envelope now also exists behind the symlink target, so a
      // lexical-only check would accept it. The recorded directory identity
      // must reject the swap.
      await writeFallbackChildResult(path.join(other, 'result.json'), 'nonce-1', 'MCP_RECONCILIATION_REQUIRED', { attempted: false })
      rmSync(directory, { recursive: true, force: true })
      symlinkSync(other, directory)
      const envelope = await readValidatedFallbackChildResult(target, 'nonce-1', { containmentDirectories: [recorded] })
      assert.equal(envelope, undefined, 'a swapped containment directory must fail closed')
    } finally {
      rmSync(directory, { recursive: true, force: true })
      mkdirSync(directory)
      rmSync(other, { recursive: true, force: true })
    }
  })

  it('rejects a well-formed envelope whose code is not in the parent allowlist', async () => {
    const target = resultPath()
    await writeFallbackChildResult(target, 'nonce-1', 'UNKNOWN_SAFE_SHAPE', { attempted: true, succeeded: true })
    assert.equal(existsSync(target), true, 'the child may still publish a shape-valid code')
    const envelope = await readValidatedFallbackChildResult(target, 'nonce-1', { containmentDirectories: [containment()] })
    assert.equal(envelope, undefined, 'an unrecognized code must never surface an envelope')
  })

  it('maps accepted child codes to parent-owned safe messages and rejects unknown codes', () => {
    const reconciliation = fallbackChildResultMessage('MCP_RECONCILIATION_REQUIRED', 'opencode')
    assert.ok(reconciliation)
    assert.ok(reconciliation.includes('nsolid-plugin setup --harness opencode'))
    assert.ok(fallbackChildResultMessage('FALLBACK_MCP_DRIFT', 'opencode'))
    assert.ok(fallbackChildResultMessage('FALLBACK_OWNERSHIP_DRIFT', 'opencode'))
    assert.ok(fallbackChildResultMessage('UNTRACKED_INSTALLATION', 'opencode'))
    assert.equal(fallbackChildResultMessage('TOTALLY_UNKNOWN_CODE', 'opencode'), undefined)
    assert.equal(fallbackChildResultMessage('', 'opencode'), undefined)
  })

  it('names the planned harness in the reconciliation guidance for every supported target', () => {
    for (const target of ['claude', 'codex', 'pi', 'antigravity', 'opencode'] as const) {
      const message = fallbackChildResultMessage('MCP_RECONCILIATION_REQUIRED', target)
      assert.ok(message, `a message is expected for ${target}`)
      assert.ok(message.includes(`nsolid-plugin setup --harness ${target}`), `${message} must name ${target}`)
      if (target !== 'opencode') assert.ok(!message.includes('opencode'), `${message} must not hardcode opencode for ${target}`)
    }
  })

  it('never interpolates a target that fails the validated shape', () => {
    const hostile = '../evil && rm -rf ~'
    const message = fallbackChildResultMessage('MCP_RECONCILIATION_REQUIRED', hostile)
    assert.ok(message)
    assert.ok(!message.includes(hostile), 'an unvalidated target must never reach the message')
    assert.ok(message.includes('setup --harness harness'), 'an invalid target falls back to the generic word')
  })

  describe('schema-2 preservation reporting boundaries', () => {
    // FALLBACK_STATE_UNPROVEN / FALLBACK_RECOVERY_PENDING are the allowlisted
    // codes under which preservation reporting is produced; preservation data
    // is child-supplied reporting output and must never widen acceptance or
    // drive a mutation decision at this boundary.
    const code = 'FALLBACK_STATE_UNPROVEN'
    const rollback = { attempted: true, succeeded: false }

    const preservedEntry = (name: string): string => path.join(directory, name)
    const artifacts = (count: number): string[] =>
      Array.from({ length: count }, (_, index) => preservedEntry(`preserved-artifact-${index}`))
    const paths = (count: number): string[] =>
      Array.from({ length: count }, (_, index) => preservedEntry(`preserved-path-${index}`))

    function writeRawEnvelope (fields: Record<string, unknown>): void {
      writeFileSync(
        resultPath(),
        JSON.stringify({ schema: FALLBACK_CHILD_RESULT_SCHEMA, nonce: 'nonce-1', code, ...fields }),
        { mode: 0o600 }
      )
    }

    const readValidated = (): Promise<unknown> =>
      readValidatedFallbackChildResult(resultPath(), 'nonce-1', { containmentDirectories: [containment()] })

    it('round-trips valid preservation arrays verbatim and deterministically', async () => {
      const target = resultPath()
      const reportedArtifacts = artifacts(2)
      const reportedPaths = paths(1)
      await writeFallbackChildResult(target, 'nonce-1', code, rollback, {
        preservedArtifacts: reportedArtifacts,
        preservedPaths: reportedPaths,
      })
      const first = await readValidatedFallbackChildResult(target, 'nonce-1', { containmentDirectories: [containment()] })
      assert.ok(first)
      assert.equal(first.code, code)
      assert.deepEqual(first.rollback, rollback)
      assert.deepEqual(first.preservedArtifacts, reportedArtifacts, 'artifact reporting must survive the round trip unchanged')
      assert.deepEqual(first.preservedPaths, reportedPaths, 'path reporting must survive the round trip unchanged')
      const second = await readValidatedFallbackChildResult(target, 'nonce-1', { containmentDirectories: [containment()] })
      assert.deepEqual(second, first, 'the same envelope must validate identically on every read')
    })

    it('accepts exactly the preservation count limit and rejects one entry more', async () => {
      writeRawEnvelope({ rollback, preservedArtifacts: artifacts(FALLBACK_CHILD_RESULT_MAX_PRESERVED) })
      const accepted = await readValidated()
      assert.ok(accepted)
      assert.equal((accepted as { preservedArtifacts?: string[] }).preservedArtifacts?.length, FALLBACK_CHILD_RESULT_MAX_PRESERVED)

      writeRawEnvelope({ rollback, preservedArtifacts: artifacts(FALLBACK_CHILD_RESULT_MAX_PRESERVED + 1) })
      assert.equal(await readValidated(), undefined, 'an over-count array must reject the whole envelope')

      writeRawEnvelope({ rollback, preservedPaths: paths(FALLBACK_CHILD_RESULT_MAX_PRESERVED + 1) })
      assert.equal(await readValidated(), undefined, 'the same count limit must bound preservedPaths')
    })

    it('never publishes an over-count array but keeps the rest of the envelope', async () => {
      const target = resultPath()
      await writeFallbackChildResult(target, 'nonce-1', code, rollback, {
        preservedArtifacts: artifacts(FALLBACK_CHILD_RESULT_MAX_PRESERVED + 1),
      })
      assert.equal(existsSync(target), true, 'the envelope itself remains publishable reporting data')
      const raw = JSON.parse(readFileSync(target, 'utf8')) as { preservedArtifacts?: string[] }
      assert.equal(raw.preservedArtifacts, undefined, 'an invalid array must never be published')
      const envelope = await readValidatedFallbackChildResult(target, 'nonce-1', { containmentDirectories: [containment()] })
      assert.ok(envelope)
      assert.equal(envelope.code, code)
      assert.equal(envelope.preservedArtifacts, undefined)
    })

    it('requires absolute paths and rejects traversal spellings in preservation entries', async () => {
      writeRawEnvelope({ rollback, preservedArtifacts: ['relative/preserved-skill'] })
      assert.equal(await readValidated(), undefined, 'a relative path is not a reportable location')

      writeRawEnvelope({ rollback, preservedArtifacts: [`${directory}/../escaped-preservative`] })
      assert.equal(await readValidated(), undefined, 'a `..` spelling must be rejected even when absolute')

      writeRawEnvelope({ rollback, preservedPaths: [preservedEntry('ok-path'), 'also/relative'] })
      assert.equal(await readValidated(), undefined, 'one invalid entry rejects the whole preservedPaths array')
    })

    it('rejects non-array fields and non-string entries', async () => {
      for (const field of ['preservedArtifacts', 'preservedPaths']) {
        for (const value of ['just-a-string', 42, null, true, { 0: preservedEntry('object-key') }]) {
          writeRawEnvelope({ rollback, [field]: value })
          assert.equal(await readValidated(), undefined, `${field} must be an array`)
        }
      }
      for (const entry of [42, null, {}, [], '']) {
        writeRawEnvelope({ rollback, preservedArtifacts: [entry] })
        assert.equal(await readValidated(), undefined, `a non-string or empty entry (${JSON.stringify(entry)}) must reject the envelope`)
      }
    })

    it('bounds every entry length at exactly 512 characters', async () => {
      const entry512 = `/${'a'.repeat(511)}`
      const entry513 = `/${'a'.repeat(512)}`
      assert.equal(Buffer.byteLength(entry512), 512)
      assert.equal(Buffer.byteLength(entry513), 513)

      writeRawEnvelope({ rollback, preservedArtifacts: [entry512] })
      const accepted = await readValidated()
      assert.ok(accepted)
      assert.deepEqual((accepted as { preservedArtifacts?: string[] }).preservedArtifacts, [entry512])

      writeRawEnvelope({ rollback, preservedArtifacts: [entry513] })
      assert.equal(await readValidated(), undefined, 'an entry beyond the per-item limit must reject the envelope')
    })

    it('bounds the combined envelope at 4096 bytes, not each array alone', async () => {
      const target = resultPath()
      // Each array alone stays under the limit; the combination must not publish.
      const longArtifacts = Array.from({ length: FALLBACK_CHILD_RESULT_MAX_PRESERVED }, (_, index) => `/${'a'.repeat(100)}-${index}`)
      const manyPaths = paths(FALLBACK_CHILD_RESULT_MAX_PRESERVED)
      const artifactsAlone = JSON.stringify({ schema: FALLBACK_CHILD_RESULT_SCHEMA, nonce: 'nonce-1', code, rollback, preservedArtifacts: longArtifacts })
      const combined = JSON.stringify({ schema: FALLBACK_CHILD_RESULT_SCHEMA, nonce: 'nonce-1', code, rollback, preservedArtifacts: longArtifacts, preservedPaths: manyPaths })
      assert.equal(Buffer.byteLength(artifactsAlone) <= FALLBACK_CHILD_RESULT_MAX_BYTES, true, 'test setup: one array alone must fit')
      assert.equal(Buffer.byteLength(combined) > FALLBACK_CHILD_RESULT_MAX_BYTES, true, 'test setup: the combination must exceed the bound')

      await writeFallbackChildResult(target, 'nonce-1', code, rollback, { preservedArtifacts: longArtifacts, preservedPaths: manyPaths })
      assert.equal(existsSync(target), false, 'an over-limit combined envelope must never be published')
      assert.equal(await readValidatedFallbackChildResult(target, 'nonce-1', { containmentDirectories: [containment()] }), undefined)

      writeRawEnvelope({ rollback, preservedArtifacts: longArtifacts, preservedPaths: manyPaths })
      assert.equal(statSync(resultPath()).size > FALLBACK_CHILD_RESULT_MAX_BYTES, true)
      assert.equal(await readValidated(), undefined, 'the reader must refuse an oversized result before parsing')
    })

    it('reports duplicates verbatim: the protocol never dedups or reorders reporting data', async () => {
      const target = resultPath()
      const duplicated = [preservedEntry('same-artifact'), preservedEntry('same-artifact'), preservedEntry('other-artifact')]
      await writeFallbackChildResult(target, 'nonce-1', code, rollback, { preservedArtifacts: duplicated })
      const envelope = await readValidatedFallbackChildResult(target, 'nonce-1', { containmentDirectories: [containment()] })
      assert.ok(envelope)
      assert.deepEqual(envelope.preservedArtifacts, duplicated, 'reporting arrays round-trip verbatim; dedup is an upstream responsibility')
    })

    it('proves preservation is reporting-only: it never rescues an invalid envelope or reaches parent messages', async () => {
      const reported = artifacts(2)
      // Wrong nonce with perfectly valid preservation arrays: still rejected.
      writeRawEnvelope({ nonce: 'forged-nonce', rollback, preservedArtifacts: reported })
      assert.equal(
        await readValidatedFallbackChildResult(resultPath(), 'nonce-1', { containmentDirectories: [containment()] }),
        undefined,
        'preservation data must not bypass nonce binding'
      )
      // A code outside the parent allowlist with valid preservation: still rejected.
      writeFileSync(
        resultPath(),
        JSON.stringify({ schema: FALLBACK_CHILD_RESULT_SCHEMA, nonce: 'nonce-1', code: 'UNKNOWN_SAFE_SHAPE', rollback, preservedArtifacts: reported }),
        { mode: 0o600 }
      )
      assert.equal(await readValidated(), undefined, 'preservation data must not bypass the code allowlist')
      // Parent-owned messages are constant: child-supplied paths never appear in them.
      const message = fallbackChildResultMessage(code, 'opencode')
      assert.ok(message)
      for (const artifact of reported) assert.ok(!message.includes(artifact), 'no reported path may leak into the safe message')
    })
  })
})
