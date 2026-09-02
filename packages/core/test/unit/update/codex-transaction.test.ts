import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { writeTomlFileSync } from '../../../src/utils/config.js'
import { restoreCodexUserOwnedFields } from '../../../src/update/codex-config.js'
import { executeCodexTransaction, readCodexPayloadVersion } from '../../../src/update/codex-transaction.js'
import { nativePayloadDigest } from '../../../src/update/native-evidence.js'
import { nativePayloadTreeDigest, type PayloadNormalizationProfile } from '../../../src/update/native-payload.js'
import type { UpdatePlanItem } from '../../../src/update/types.js'

let home: string
let previousHome: string | undefined
let previousUserProfile: string | undefined

beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), 'nsolid-plugin-codex-transaction-'))
  previousHome = process.env.HOME
  previousUserProfile = process.env.USERPROFILE
  process.env.HOME = home
  process.env.USERPROFILE = home
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  if (previousHome === undefined) delete process.env.HOME
  else process.env.HOME = previousHome
  if (previousUserProfile === undefined) delete process.env.USERPROFILE
  else process.env.USERPROFILE = previousUserProfile
})

function item (cachePath?: string): UpdatePlanItem {
  return {
    installationId: 'codex:native:nsolid-plugin@nodesource',
    target: 'codex',
    ownership: 'native-plugin',
    installed: true,
    source: {
      kind: 'codex-marketplace',
      pluginId: 'nsolid-plugin@nodesource',
      marketplace: 'NodeSource/nsolid-plugin',
      versionSource: { kind: 'git', repository: 'https://github.com/NodeSource/nsolid-plugin.git', manifestPath: 'bundle.json' },
    },
    version: { current: undefined, latest: '1.0.1', status: 'update-available' },
    metadata: { ...(cachePath ? { packageRoot: cachePath } : {}), trackedMcpConfigPath: path.join(home, '.codex', 'config.toml') },
    steps: [
      { kind: 'command', description: 'upgrade', command: { executable: 'codex', args: ['plugin', 'marketplace', 'upgrade', 'NodeSource/nsolid-plugin'], timeoutMs: 1000 } },
      { kind: 'command', description: 'remove', command: { executable: 'codex', args: ['plugin', 'remove', 'nsolid-plugin@nodesource'], timeoutMs: 1000 } },
      { kind: 'command', description: 'add', command: { executable: 'codex', args: ['plugin', 'add', 'nsolid-plugin@nodesource'], timeoutMs: 1000 } },
      { kind: 'validation', description: 'payload', checks: [] },
    ],
    rollbackSteps: [],
    requiresConfirmation: true,
  }
}

// Shared planned payload (v1.0.2) written both as the immutable plan source
// and as the faithful installed payload by the fake Codex commands.
const PLANNED_PAYLOAD_FILES: ReadonlyArray<readonly [string, string]> = [
  ['bundle.json', JSON.stringify({ name: 'nsolid-plugin', version: '1.0.2', skills: [] }) + '\n'],
  ['skills/example/SKILL.md', '# example\n'],
]

function writePlannedPayload (root: string): void {
  for (const [relative, content] of PLANNED_PAYLOAD_FILES) {
    mkdirSync(path.join(root, path.dirname(relative)), { recursive: true })
    writeFileSync(path.join(root, relative), content)
  }
}

function writeInstalledPayload (root: string): void {
  writePlannedPayload(root)
}

function comparisonArtifact (plannedRoot: string, overrides: { comparisonDigest?: string; comparisonProfile?: string } = {}): NonNullable<UpdatePlanItem['artifact']> {
  return {
    kind: 'git',
    repository: 'https://github.com/NodeSource/nsolid-plugin.git',
    commit: 'bc9c87e6ce6ca73756dc20fdd41a3219bcd5b60c',
    contentDigest: nativePayloadTreeDigest(plannedRoot)!,
    comparisonDigest: overrides.comparisonDigest ?? nativePayloadTreeDigest(plannedRoot, { profile: 'codex-installed-v1' })!,
    comparisonProfile: (overrides.comparisonProfile ?? 'codex-installed-v1') as PayloadNormalizationProfile,
  }
}

describe('Codex update transaction', () => {
  it('matches equivalent TOML plugin table headers without splitting quoted keys', () => {
    const variants = [
      { pluginId: 'nsolid-plugin', header: '[plugins.nsolid-plugin]' },
      { pluginId: 'nsolid-plugin@nodesource', header: '[ plugins . "nsolid-plugin@nodesource" ]' },
      { pluginId: 'nsolid-plugin@nodesource', header: "[plugins.'nsolid-plugin@nodesource']" },
      { pluginId: 'plugin.with.dot', header: '[plugins."plugin.with.dot"]' },
      { pluginId: 'plugin#with#hash', header: "[plugins.'plugin#with#hash'] # table comment" },
    ]

    for (const [index, variant] of variants.entries()) {
      const configPath = path.join(home, '.codex', `config-${index}.toml`)
      mkdirSync(path.dirname(configPath), { recursive: true })
      const originalText = [
        variant.header,
        'enabled = true',
        'installPath = "old-path"',
        '',
      ].join('\n')
      writeFileSync(configPath, [
        `[plugins.${JSON.stringify(variant.pluginId)}]`,
        'enabled = false',
        'installPath = "new-path"',
        '',
      ].join('\n'))

      const restored = restoreCodexUserOwnedFields(
        configPath,
        variant.pluginId,
        { enabled: true, installPath: 'old-path' },
        originalText
      )

      assert.equal(restored, true, variant.header)
      const updated = readFileSync(configPath, 'utf8')
      assert.match(updated, /enabled = true/)
      assert.match(updated, /installPath = "new-path"/)
      assert.ok(updated.includes(variant.header))
    }
  })

  it('validates the refreshed cached payload rather than a versionless registration', async () => {
    const cachePath = path.join(home, '.codex', 'plugins', 'cache', 'nsolid-plugin')
    mkdirSync(cachePath, { recursive: true })
    mkdirSync(path.dirname(path.join(home, '.codex', 'config.toml')), { recursive: true })
    writeTomlFileSync(path.join(home, '.codex', 'config.toml'), { plugins: { 'nsolid-plugin@nodesource': { enabled: true } } })
    writeFileSync(path.join(cachePath, 'bundle.json'), JSON.stringify({ name: 'nsolid-plugin', version: '1.0.0', skills: [] }))

    const result = await executeCodexTransaction(item(cachePath), {
      run: async (command) => {
        if (command.args.includes('add')) writeFileSync(path.join(cachePath, 'bundle.json'), JSON.stringify({ name: 'nsolid-plugin', version: '1.0.1', skills: [] }))
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false }
      },
    })

    assert.equal(result.success, true)
    assert.equal(readCodexPayloadVersion(cachePath, 'nsolid-plugin@nodesource'), '1.0.1')
    assert.match(readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8'), /enabled = true/)
  })

  it('validates content in the exact version directory when real config has no payload path', async () => {
    const cachePath = path.join(home, '.codex', 'plugins', 'cache', 'nodesource', 'nsolid-plugin')
    const oldPayload = path.join(cachePath, '1.0.0')
    const newPayload = path.join(cachePath, '1.0.1')
    const newBundle = JSON.stringify({ name: 'nsolid-plugin', version: '1.0.1', skills: [] })
    mkdirSync(oldPayload, { recursive: true })
    mkdirSync(path.dirname(path.join(home, '.codex', 'config.toml')), { recursive: true })
    writeTomlFileSync(path.join(home, '.codex', 'config.toml'), { plugins: { 'nsolid-plugin@nodesource': { enabled: true } } })
    writeFileSync(path.join(oldPayload, 'bundle.json'), JSON.stringify({ name: 'nsolid-plugin', version: '1.0.0', skills: [] }))
    mkdirSync(newPayload, { recursive: true })
    writeFileSync(path.join(newPayload, 'bundle.json'), newBundle)
    const plannedDigest = nativePayloadDigest(newPayload)!
    const plannedComparisonDigest = nativePayloadDigest(newPayload, { profile: 'codex-installed-v1' })!
    rmSync(newPayload, { recursive: true, force: true })
    const candidate = item(cachePath)
    candidate.artifact = {
      kind: 'git',
      repository: 'https://github.com/NodeSource/nsolid-plugin.git',
      commit: 'bc9c87e6ce6ca73756dc20fdd41a3219bcd5b60c',
      contentDigest: plannedDigest,
      comparisonDigest: plannedComparisonDigest,
      comparisonProfile: 'codex-installed-v1',
    }

    const result = await executeCodexTransaction(candidate, {
      run: async (command) => {
        if (command.args.includes('add')) {
          mkdirSync(newPayload, { recursive: true })
          writeFileSync(path.join(newPayload, 'bundle.json'), newBundle)
        }
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false }
      },
    })

    assert.equal(result.success, true)
  })

  it('accepts reinstall with Codex harness metadata when the planned comparison identity matches', async () => {
    const cachePath = path.join(home, '.codex', 'plugins', 'cache', 'nsolid-plugin')
    mkdirSync(cachePath, { recursive: true })
    mkdirSync(path.dirname(path.join(home, '.codex', 'config.toml')), { recursive: true })
    writeTomlFileSync(path.join(home, '.codex', 'config.toml'), { plugins: { 'nsolid-plugin@nodesource': { enabled: true } } })
    writeFileSync(path.join(cachePath, 'bundle.json'), JSON.stringify({ name: 'nsolid-plugin', version: '1.0.0', skills: [] }))

    // Planned bytes come from the immutable commit (clean payload); Codex adds
    // its own provenance file at the payload root during the real install.
    const plannedRoot = mkdtempSync(path.join(os.tmpdir(), 'nsolid-codex-f4-planned-'))
    try {
      const plannedFiles = new Map([
        ['bundle.json', Buffer.from(JSON.stringify({ name: 'nsolid-plugin', version: '1.0.2', skills: [] }))],
        ['skills/example/SKILL.md', Buffer.from('# example\n')],
      ])
      for (const [relative, content] of plannedFiles) {
        mkdirSync(path.join(plannedRoot, path.dirname(relative)), { recursive: true })
        writeFileSync(path.join(plannedRoot, relative), content)
      }
      const candidate = item(cachePath)
      candidate.version = { ...candidate.version, latest: '1.0.2' }
      candidate.artifact = {
        kind: 'git',
        repository: 'https://github.com/NodeSource/nsolid-plugin.git',
        commit: 'bc9c87e6ce6ca73756dc20fdd41a3219bcd5b60c',
        contentDigest: nativePayloadTreeDigest(plannedRoot)!,
        comparisonDigest: nativePayloadTreeDigest(plannedRoot, { profile: 'codex-installed-v1' })!,
        comparisonProfile: 'codex-installed-v1',
      }

      const result = await executeCodexTransaction(candidate, {
        run: async (command) => {
          if (command.args.includes('add')) {
            for (const [relative, content] of plannedFiles) {
              mkdirSync(path.join(cachePath, path.dirname(relative)), { recursive: true })
              writeFileSync(path.join(cachePath, relative), content)
            }
            writeFileSync(path.join(cachePath, '.codex-marketplace-install.json'), '{"source":"marketplace"}\n')
          }
          return { exitCode: 0, stdout: '', stderr: '', timedOut: false }
        },
      })

      assert.equal(result.success, true)
      assert.equal(result.rollbackAttempted, false)
      assert.equal(readCodexPayloadVersion(cachePath, 'nsolid-plugin@nodesource'), '1.0.2')
      assert.match(readFileSync(path.join(cachePath, '.codex-marketplace-install.json'), 'utf8'), /marketplace/)
    } finally {
      rmSync(plannedRoot, { recursive: true, force: true })
    }
  })

  it('fails closed when a plan carries no named comparison identity', async () => {
    const cachePath = path.join(home, '.codex', 'plugins', 'cache', 'nsolid-plugin')
    mkdirSync(cachePath, { recursive: true })
    mkdirSync(path.dirname(path.join(home, '.codex', 'config.toml')), { recursive: true })
    writeTomlFileSync(path.join(home, '.codex', 'config.toml'), { plugins: { 'nsolid-plugin@nodesource': { enabled: true } } })
    writeFileSync(path.join(cachePath, 'bundle.json'), JSON.stringify({ name: 'nsolid-plugin', version: '1.0.0', skills: [] }))

    const plannedRoot = mkdtempSync(path.join(os.tmpdir(), 'nsolid-codex-f4-noprofile-'))
    try {
      const plannedBundle = JSON.stringify({ name: 'nsolid-plugin', version: '1.0.2', skills: [] })
      writeFileSync(path.join(plannedRoot, 'bundle.json'), plannedBundle)
      const candidate = item(cachePath)
      candidate.version = { ...candidate.version, latest: '1.0.2' }
      // Legacy-style artifact: strict evidence only, no comparison identity.
      candidate.artifact = {
        kind: 'git',
        repository: 'https://github.com/NodeSource/nsolid-plugin.git',
        commit: 'bc9c87e6ce6ca73756dc20fdd41a3219bcd5b60c',
        contentDigest: nativePayloadTreeDigest(plannedRoot)!,
      }

      const result = await executeCodexTransaction(candidate, {
        run: async (command) => {
          if (command.args.includes('add')) writeFileSync(path.join(cachePath, 'bundle.json'), plannedBundle)
          return { exitCode: 0, stdout: '', stderr: '', timedOut: false }
        },
      })

      assert.equal(result.success, false)
      assert.equal(result.error?.code, 'CODEX_CONTENT_MISMATCH')
      assert.equal(result.rollbackAttempted, true)
      assert.equal(result.rollbackSucceeded, true)
      assert.match(readFileSync(path.join(cachePath, 'bundle.json'), 'utf8'), /1\.0\.0/)
    } finally {
      rmSync(plannedRoot, { recursive: true, force: true })
    }
  })

  it('rejects real payload tampering under the comparison profile and rolls back', async () => {
    const cachePath = path.join(home, '.codex', 'plugins', 'cache', 'nsolid-plugin')
    mkdirSync(cachePath, { recursive: true })
    mkdirSync(path.dirname(path.join(home, '.codex', 'config.toml')), { recursive: true })
    writeTomlFileSync(path.join(home, '.codex', 'config.toml'), { plugins: { 'nsolid-plugin@nodesource': { enabled: true } } })
    writeFileSync(path.join(cachePath, 'bundle.json'), JSON.stringify({ name: 'nsolid-plugin', version: '1.0.0', skills: [] }))

    const plannedRoot = mkdtempSync(path.join(os.tmpdir(), 'nsolid-codex-f4-tamper-'))
    try {
      const plannedFiles = new Map([
        ['bundle.json', Buffer.from(JSON.stringify({ name: 'nsolid-plugin', version: '1.0.2', skills: [] }))],
        ['skills/example/SKILL.md', Buffer.from('# example\n')],
      ])
      for (const [relative, content] of plannedFiles) {
        mkdirSync(path.join(plannedRoot, path.dirname(relative)), { recursive: true })
        writeFileSync(path.join(plannedRoot, relative), content)
      }
      const candidate = item(cachePath)
      candidate.version = { ...candidate.version, latest: '1.0.2' }
      candidate.artifact = {
        kind: 'git',
        repository: 'https://github.com/NodeSource/nsolid-plugin.git',
        commit: 'bc9c87e6ce6ca73756dc20fdd41a3219bcd5b60c',
        contentDigest: nativePayloadTreeDigest(plannedRoot)!,
        comparisonDigest: nativePayloadTreeDigest(plannedRoot, { profile: 'codex-installed-v1' })!,
        comparisonProfile: 'codex-installed-v1',
      }

      // The version matches, the harness metadata matches, but a real payload
      // byte was substituted: the normalized comparison must still reject it.
      const result = await executeCodexTransaction(candidate, {
        run: async (command) => {
          if (command.args.includes('add')) {
            for (const [relative, content] of plannedFiles) {
              mkdirSync(path.join(cachePath, path.dirname(relative)), { recursive: true })
              writeFileSync(path.join(cachePath, relative), content)
            }
            writeFileSync(path.join(cachePath, '.codex-marketplace-install.json'), '{"source":"marketplace"}\n')
            writeFileSync(path.join(cachePath, 'skills/example/SKILL.md'), '# substituted\n')
          }
          return { exitCode: 0, stdout: '', stderr: '', timedOut: false }
        },
      })

      assert.equal(result.success, false)
      assert.equal(result.error?.code, 'CODEX_CONTENT_MISMATCH')
      assert.equal(result.rollbackAttempted, true)
      assert.equal(result.rollbackSucceeded, true)
      assert.match(readFileSync(path.join(cachePath, 'bundle.json'), 'utf8'), /1\.0\.0/)
      assert.equal(existsSync(path.join(cachePath, 'skills/example/SKILL.md')), false)
    } finally {
      rmSync(plannedRoot, { recursive: true, force: true })
    }
  })

  it('rejects a symlink installed at the reserved harness metadata path and rolls back', async () => {
    const cachePath = path.join(home, '.codex', 'plugins', 'cache', 'nsolid-plugin')
    mkdirSync(cachePath, { recursive: true })
    mkdirSync(path.dirname(path.join(home, '.codex', 'config.toml')), { recursive: true })
    writeTomlFileSync(path.join(home, '.codex', 'config.toml'), { plugins: { 'nsolid-plugin@nodesource': { enabled: true } } })
    writeFileSync(path.join(cachePath, 'bundle.json'), JSON.stringify({ name: 'nsolid-plugin', version: '1.0.0', skills: [] }))

    const plannedRoot = mkdtempSync(path.join(os.tmpdir(), 'nsolid-codex-f4-symlink-'))
    try {
      writePlannedPayload(plannedRoot)
      const candidate = item(cachePath)
      candidate.version = { ...candidate.version, latest: '1.0.2' }
      candidate.artifact = comparisonArtifact(plannedRoot)

      const result = await executeCodexTransaction(candidate, {
        run: async (command) => {
          if (command.args.includes('add')) {
            writeInstalledPayload(cachePath)
            // A crafted symlink must not hide behind the normalization profile.
            symlinkSync('../../shared/meta.json', path.join(cachePath, '.codex-marketplace-install.json'))
          }
          return { exitCode: 0, stdout: '', stderr: '', timedOut: false }
        },
      })

      assert.equal(result.success, false)
      assert.equal(result.error?.code, 'CODEX_CONTENT_MISMATCH')
      assert.equal(result.rollbackAttempted, true)
      assert.equal(result.rollbackSucceeded, true)
      assert.match(readFileSync(path.join(cachePath, 'bundle.json'), 'utf8'), /1\.0\.0/)
      // A dangling symlink would make existsSync report false even without
      // rollback; verify the crafted entry is truly gone from the tree.
      assert.equal(readdirSync(cachePath).includes('.codex-marketplace-install.json'), false)
    } finally {
      rmSync(plannedRoot, { recursive: true, force: true })
    }
  })

  it('rejects a directory installed at the reserved harness metadata path and rolls back', async () => {
    const cachePath = path.join(home, '.codex', 'plugins', 'cache', 'nsolid-plugin')
    mkdirSync(cachePath, { recursive: true })
    mkdirSync(path.dirname(path.join(home, '.codex', 'config.toml')), { recursive: true })
    writeTomlFileSync(path.join(home, '.codex', 'config.toml'), { plugins: { 'nsolid-plugin@nodesource': { enabled: true } } })
    writeFileSync(path.join(cachePath, 'bundle.json'), JSON.stringify({ name: 'nsolid-plugin', version: '1.0.0', skills: [] }))

    const plannedRoot = mkdtempSync(path.join(os.tmpdir(), 'nsolid-codex-f4-dir-'))
    try {
      writePlannedPayload(plannedRoot)
      const candidate = item(cachePath)
      candidate.version = { ...candidate.version, latest: '1.0.2' }
      candidate.artifact = comparisonArtifact(plannedRoot)

      const result = await executeCodexTransaction(candidate, {
        run: async (command) => {
          if (command.args.includes('add')) {
            writeInstalledPayload(cachePath)
            mkdirSync(path.join(cachePath, '.codex-marketplace-install.json'))
            writeFileSync(path.join(cachePath, '.codex-marketplace-install.json', 'nested.txt'), 'payload-ish\n')
          }
          return { exitCode: 0, stdout: '', stderr: '', timedOut: false }
        },
      })

      assert.equal(result.success, false)
      assert.equal(result.error?.code, 'CODEX_CONTENT_MISMATCH')
      assert.equal(result.rollbackAttempted, true)
      assert.equal(result.rollbackSucceeded, true)
      assert.match(readFileSync(path.join(cachePath, 'bundle.json'), 'utf8'), /1\.0\.0/)
      assert.equal(existsSync(path.join(cachePath, '.codex-marketplace-install.json')), false)
    } finally {
      rmSync(plannedRoot, { recursive: true, force: true })
    }
  })

  it('rejects unrecognized comparison profiles even when strict bytes would match', async () => {
    const cachePath = path.join(home, '.codex', 'plugins', 'cache', 'nsolid-plugin')
    mkdirSync(cachePath, { recursive: true })
    mkdirSync(path.dirname(path.join(home, '.codex', 'config.toml')), { recursive: true })
    writeTomlFileSync(path.join(home, '.codex', 'config.toml'), { plugins: { 'nsolid-plugin@nodesource': { enabled: true } } })
    writeFileSync(path.join(cachePath, 'bundle.json'), JSON.stringify({ name: 'nsolid-plugin', version: '1.0.0', skills: [] }))

    const plannedRoot = mkdtempSync(path.join(os.tmpdir(), 'nsolid-codex-f4-unknown-profile-'))
    try {
      writePlannedPayload(plannedRoot)
      const candidate = item(cachePath)
      candidate.version = { ...candidate.version, latest: '1.0.2' }
      // A silently-strict implementation would accept this plan: the installed
      // bytes below match the strict digest exactly. The unknown profile must
      // be rejected instead of digested as strict evidence.
      candidate.artifact = comparisonArtifact(plannedRoot, {
        comparisonDigest: nativePayloadTreeDigest(plannedRoot)!,
        comparisonProfile: 'codex-installed-v2-future',
      })

      const result = await executeCodexTransaction(candidate, {
        run: async (command) => {
          if (command.args.includes('add')) writeInstalledPayload(cachePath)
          return { exitCode: 0, stdout: '', stderr: '', timedOut: false }
        },
      })

      assert.equal(result.success, false)
      assert.equal(result.error?.code, 'CODEX_CONTENT_MISMATCH')
      assert.equal(result.rollbackAttempted, true)
      assert.equal(result.rollbackSucceeded, true)
      assert.match(readFileSync(path.join(cachePath, 'bundle.json'), 'utf8'), /1\.0\.0/)
    } finally {
      rmSync(plannedRoot, { recursive: true, force: true })
    }
  })

  it('rejects a comparison digest that does not match its named profile and rolls back', async () => {
    const cachePath = path.join(home, '.codex', 'plugins', 'cache', 'nsolid-plugin')
    mkdirSync(cachePath, { recursive: true })
    mkdirSync(path.dirname(path.join(home, '.codex', 'config.toml')), { recursive: true })
    writeTomlFileSync(path.join(home, '.codex', 'config.toml'), { plugins: { 'nsolid-plugin@nodesource': { enabled: true } } })
    writeFileSync(path.join(cachePath, 'bundle.json'), JSON.stringify({ name: 'nsolid-plugin', version: '1.0.0', skills: [] }))

    const plannedRoot = mkdtempSync(path.join(os.tmpdir(), 'nsolid-codex-f4-wrong-identity-'))
    try {
      writePlannedPayload(plannedRoot)
      const candidate = item(cachePath)
      candidate.version = { ...candidate.version, latest: '1.0.2' }
      // The digest was computed over different bytes than the plan carries, so
      // no faithful install can produce it under the named profile.
      writeFileSync(path.join(plannedRoot, 'skills', 'extra.txt'), 'stray\n')
      const forgedDigest = nativePayloadTreeDigest(plannedRoot, { profile: 'codex-installed-v1' })!
      rmSync(path.join(plannedRoot, 'skills', 'extra.txt'))
      candidate.artifact = comparisonArtifact(plannedRoot, { comparisonDigest: forgedDigest })

      const result = await executeCodexTransaction(candidate, {
        run: async (command) => {
          if (command.args.includes('add')) {
            writeInstalledPayload(cachePath)
            writeFileSync(path.join(cachePath, '.codex-marketplace-install.json'), '{"source":"marketplace"}\n')
          }
          return { exitCode: 0, stdout: '', stderr: '', timedOut: false }
        },
      })

      assert.equal(result.success, false)
      assert.equal(result.error?.code, 'CODEX_CONTENT_MISMATCH')
      assert.equal(result.rollbackAttempted, true)
      assert.equal(result.rollbackSucceeded, true)
      assert.match(readFileSync(path.join(cachePath, 'bundle.json'), 'utf8'), /1\.0\.0/)
    } finally {
      rmSync(plannedRoot, { recursive: true, force: true })
    }
  })

  it('restores prior harness metadata byte-exact through strict backup digests', async () => {
    const cachePath = path.join(home, '.codex', 'plugins', 'cache', 'nsolid-plugin')
    mkdirSync(cachePath, { recursive: true })
    mkdirSync(path.dirname(path.join(home, '.codex', 'config.toml')), { recursive: true })
    writeTomlFileSync(path.join(home, '.codex', 'config.toml'), { plugins: { 'nsolid-plugin@nodesource': { enabled: true } } })
    const priorMetadata = '{"source":"marketplace","prior":true}\n'
    writeFileSync(path.join(cachePath, 'bundle.json'), JSON.stringify({ name: 'nsolid-plugin', version: '1.0.0', skills: [] }))
    writeFileSync(path.join(cachePath, '.codex-marketplace-install.json'), priorMetadata)

    const plannedRoot = mkdtempSync(path.join(os.tmpdir(), 'nsolid-codex-f4-rollback-'))
    try {
      const candidate = item(cachePath)
      candidate.version = { ...candidate.version, latest: '1.0.2' }
      candidate.artifact = {
        kind: 'git',
        repository: 'https://github.com/NodeSource/nsolid-plugin.git',
        commit: 'bc9c87e6ce6ca73756dc20fdd41a3219bcd5b60c',
        contentDigest: nativePayloadTreeDigest(plannedRoot)!,
        comparisonDigest: nativePayloadTreeDigest(plannedRoot, { profile: 'codex-installed-v1' })!,
        comparisonProfile: 'codex-installed-v1',
      }

      // A wrong payload version forces a post-mutation rollback; the prior
      // cache (including its harness metadata) must be restored byte-exact.
      const result = await executeCodexTransaction(candidate, {
        run: async (command) => {
          if (command.args.includes('add')) {
            writeFileSync(path.join(cachePath, 'bundle.json'), JSON.stringify({ name: 'nsolid-plugin', version: '0.9.0', skills: [] }))
            writeFileSync(path.join(cachePath, '.codex-marketplace-install.json'), '{"source":"marketplace","rewritten":true}\n')
          }
          return { exitCode: 0, stdout: '', stderr: '', timedOut: false }
        },
      })

      assert.equal(result.error?.code, 'CODEX_VERSION_MISMATCH')
      assert.equal(result.rollbackAttempted, true)
      assert.equal(result.rollbackSucceeded, true)
      assert.match(readFileSync(path.join(cachePath, 'bundle.json'), 'utf8'), /1\.0\.0/)
      assert.equal(readFileSync(path.join(cachePath, '.codex-marketplace-install.json'), 'utf8'), priorMetadata)
    } finally {
      rmSync(plannedRoot, { recursive: true, force: true })
    }
  })

  it('snapshots only the selected plugin cache when metadata has no package root', async () => {
    const cacheBase = path.join(home, '.codex', 'plugins', 'cache')
    const selectedCache = path.join(cacheBase, 'NodeSource', 'nsolid-plugin')
    const unrelatedCache = path.join(cacheBase, 'other-marketplace', 'other-plugin')
    mkdirSync(selectedCache, { recursive: true })
    mkdirSync(unrelatedCache, { recursive: true })
    mkdirSync(path.dirname(path.join(home, '.codex', 'config.toml')), { recursive: true })
    writeTomlFileSync(path.join(home, '.codex', 'config.toml'), { plugins: { 'nsolid-plugin@nodesource': { enabled: true } } })
    writeFileSync(path.join(selectedCache, 'bundle.json'), JSON.stringify({ name: 'nsolid-plugin', version: '1.0.0', skills: [] }))
    writeFileSync(path.join(unrelatedCache, 'bundle.json'), JSON.stringify({ name: 'other-plugin', version: '2.0.0', skills: [] }))

    const result = await executeCodexTransaction(item(), {
      run: async (command) => {
        if (command.args.includes('add')) {
          writeFileSync(path.join(selectedCache, 'bundle.json'), JSON.stringify({ name: 'nsolid-plugin', version: '0.9.0', skills: [] }))
          writeFileSync(path.join(unrelatedCache, 'bundle.json'), JSON.stringify({ name: 'other-plugin', version: '9.9.9', skills: [] }))
        }
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false }
      },
    })

    assert.equal(result.success, false)
    assert.equal(result.error?.code, 'CODEX_VERSION_MISMATCH')
    assert.equal(readFileSync(path.join(unrelatedCache, 'bundle.json'), 'utf8').includes('9.9.9'), true)
    assert.equal(readFileSync(path.join(selectedCache, 'bundle.json'), 'utf8').includes('1.0.0'), true)
  })

  it('fails when Codex add does not recreate the exact registration', async () => {
    const cachePath = path.join(home, '.codex', 'plugins', 'cache', 'nsolid-plugin')
    mkdirSync(cachePath, { recursive: true })
    mkdirSync(path.dirname(path.join(home, '.codex', 'config.toml')), { recursive: true })
    writeTomlFileSync(path.join(home, '.codex', 'config.toml'), { plugins: { 'nsolid-plugin@nodesource': { enabled: true } } })
    writeFileSync(path.join(cachePath, 'bundle.json'), JSON.stringify({ name: 'nsolid-plugin', version: '1.0.0', skills: [] }))

    const result = await executeCodexTransaction(item(cachePath), {
      run: async (command) => {
        if (command.args.includes('add')) {
          writeFileSync(path.join(cachePath, 'bundle.json'), JSON.stringify({ name: 'nsolid-plugin', version: '1.0.1', skills: [] }))
          writeTomlFileSync(path.join(home, '.codex', 'config.toml'), { plugins: {} })
        }
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false }
      },
    })

    assert.equal(result.success, false)
    assert.equal(result.error?.code, 'CODEX_REGISTRATION_MISSING')
    assert.match(readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8'), /nsolid-plugin@nodesource/)
    assert.match(readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8'), /enabled = true/)
  })

  it('validates the payload selected by the recreated registration', async () => {
    const cachePath = path.join(home, '.codex', 'plugins', 'cache', 'nsolid-plugin')
    const oldPayload = path.join(cachePath, '1.0.0')
    const latestPayload = path.join(cachePath, '1.0.1')
    mkdirSync(oldPayload, { recursive: true })
    mkdirSync(latestPayload, { recursive: true })
    const configPath = path.join(home, '.codex', 'config.toml')
    mkdirSync(path.dirname(configPath), { recursive: true })
    writeTomlFileSync(configPath, { plugins: { 'nsolid-plugin@nodesource': { enabled: true, cachePath: oldPayload } } })
    writeFileSync(path.join(oldPayload, 'bundle.json'), JSON.stringify({ name: 'nsolid-plugin', version: '1.0.0', skills: [] }))
    writeFileSync(path.join(latestPayload, 'bundle.json'), JSON.stringify({ name: 'nsolid-plugin', version: '1.0.1', skills: [] }))

    const result = await executeCodexTransaction(item(cachePath), {
      run: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }),
    })

    assert.equal(result.success, false)
    assert.equal(result.error?.code, 'CODEX_VERSION_MISMATCH')
  })

  it('does not rewrite config TOML when preserved fields already match', async () => {
    const cachePath = path.join(home, '.codex', 'plugins', 'cache', 'nsolid-plugin')
    mkdirSync(cachePath, { recursive: true })
    const configPath = path.join(home, '.codex', 'config.toml')
    mkdirSync(path.dirname(configPath), { recursive: true })
    writeFileSync(configPath, [
      '# user comment must survive',
      '[plugins."nsolid-plugin@nodesource"]',
      'enabled = true',
      '',
    ].join('\n'))
    writeFileSync(path.join(cachePath, 'bundle.json'), JSON.stringify({ name: 'nsolid-plugin', version: '1.0.0', skills: [] }))

    const result = await executeCodexTransaction(item(cachePath), {
      run: async (command) => {
        if (command.args.includes('add')) writeFileSync(path.join(cachePath, 'bundle.json'), JSON.stringify({ name: 'nsolid-plugin', version: '1.0.1', skills: [] }))
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false }
      },
    })

    assert.equal(result.success, true)
    assert.match(readFileSync(configPath, 'utf8'), /# user comment must survive/)
  })

  it('preserves unrelated Codex TOML bytes while patching only engine-owned fields', async () => {
    const cachePath = path.join(home, '.codex', 'plugins', 'cache', 'nodesource', 'nsolid-plugin')
    const oldPayload = path.join(cachePath, '1.0.0')
    const newPayload = path.join(cachePath, '1.0.1')
    const configPath = path.join(home, '.codex', 'config.toml')
    mkdirSync(oldPayload, { recursive: true })
    mkdirSync(path.dirname(configPath), { recursive: true })
    writeFileSync(path.join(oldPayload, 'bundle.json'), JSON.stringify({ name: 'nsolid-plugin', version: '1.0.0', skills: [] }))
    const original = [
      '# top-level comment',
      '[unrelated]',
      'keep = "yes" # inline comment',
      '',
      '[plugins."nsolid-plugin@nodesource"]',
      'enabled = true # user-owned setting',
      'userField = "original"',
      `installPath = ${JSON.stringify(oldPayload)} # engine-owned path`,
      '',
      '[plugins."other"]',
      'enabled = false',
      '',
    ].join('\r\n')
    writeFileSync(configPath, original)
    const expected = original.replace(JSON.stringify(oldPayload), JSON.stringify(newPayload))

    const result = await executeCodexTransaction(item(cachePath), {
      run: async (command) => {
        if (command.args.includes('add')) {
          mkdirSync(newPayload, { recursive: true })
          writeFileSync(path.join(newPayload, 'bundle.json'), JSON.stringify({ name: 'nsolid-plugin', version: '1.0.1', skills: [] }))
          writeFileSync(configPath, [
            '[plugins."nsolid-plugin@nodesource"]',
            'enabled = false',
            'userField = "changed-by-codex"',
            `installPath = ${JSON.stringify(newPayload)}`,
            'codexAdded = "must not survive"',
            '',
            '[unrelated]',
            'keep = "changed-by-codex"',
            '',
          ].join('\n'))
        }
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false }
      },
    })

    assert.equal(result.success, true)
    assert.equal(readFileSync(configPath, 'utf8'), expected)
    assert.equal(readFileSync(configPath, 'utf8').includes('codexAdded'), false)
    assert.equal(readFileSync(configPath, 'utf8').includes('\r\n'), true)
  })

  it('rolls back exactly when an engine-owned TOML value is ambiguous', async () => {
    const cachePath = path.join(home, '.codex', 'plugins', 'cache', 'nsolid-plugin')
    const configPath = path.join(home, '.codex', 'config.toml')
    mkdirSync(cachePath, { recursive: true })
    mkdirSync(path.dirname(configPath), { recursive: true })
    writeFileSync(path.join(cachePath, 'bundle.json'), JSON.stringify({ name: 'nsolid-plugin', version: '1.0.0', skills: [] }))
    const original = [
      '[plugins."nsolid-plugin@nodesource"]',
      'installPath = { root = "ambiguous" }',
      'enabled = true',
      '',
    ].join('\r\n')
    writeFileSync(configPath, original)

    const result = await executeCodexTransaction(item(cachePath), {
      run: async (command) => {
        if (command.args.includes('add')) {
          writeFileSync(configPath, [
            '[plugins."nsolid-plugin@nodesource"]',
            'installPath = "changed"',
            'enabled = false',
            '',
          ].join('\n'))
        }
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false }
      },
    })

    assert.equal(result.success, false)
    assert.equal(readFileSync(configPath, 'utf8'), original)
  })

  it('returns a structured backup failure when the config parent directory is missing', async () => {
    // `~/.codex` is deliberately not created: the sibling backup parent is
    // absent, which used to escape as a rejected ENOENT promise.
    const cachePath = path.join(home, '.codex', 'plugins', 'cache', 'nsolid-plugin')
    const result = await executeCodexTransaction(item(cachePath), {
      run: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }),
    })

    assert.equal(result.success, false)
    assert.equal(result.rollbackAttempted, false)
    assert.equal(result.error?.code, 'CODEX_BACKUP_FAILED')
    assert.equal(existsSync(path.join(home, '.codex')), false)
  })

  it('fails closed before mutation when the existing cache has no digestible tree', async () => {
    // An empty existing cache directory cannot produce an authenticated
    // backup digest, so rollback could never be proven: the transaction must
    // abort in the backup phase, before any command runs.
    const cachePath = path.join(home, '.codex', 'plugins', 'cache', 'nsolid-plugin')
    mkdirSync(cachePath, { recursive: true })
    const configPath = path.join(home, '.codex', 'config.toml')
    mkdirSync(path.dirname(configPath), { recursive: true })
    writeTomlFileSync(configPath, { plugins: { 'nsolid-plugin@nodesource': { enabled: true } } })
    const originalConfig = readFileSync(configPath, 'utf8')

    let commands = 0
    const result = await executeCodexTransaction(item(cachePath), {
      run: async () => {
        commands++
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false }
      },
    })

    assert.equal(result.success, false)
    assert.equal(result.error?.code, 'CODEX_BACKUP_FAILED')
    assert.equal(result.rollbackAttempted, false)
    assert.equal(commands, 0, 'no mutation may run without a provable backup digest')
    assert.equal(readFileSync(configPath, 'utf8'), originalConfig)
    // The incomplete backup containers were cleaned up.
    assert.equal(readdirSync(path.dirname(configPath)).filter((name) => name.includes('.nsolid-config-backup-')).length, 0)
    assert.equal(readdirSync(path.dirname(cachePath)).filter((name) => name.includes('.nsolid-cache-backup-')).length, 0)
  })

  it('reports the preserved backup locations in the tree-termination timeout error', async () => {
    const cachePath = path.join(home, '.codex', 'plugins', 'cache', 'nsolid-plugin')
    mkdirSync(cachePath, { recursive: true })
    mkdirSync(path.dirname(path.join(home, '.codex', 'config.toml')), { recursive: true })
    writeTomlFileSync(path.join(home, '.codex', 'config.toml'), { plugins: { 'nsolid-plugin@nodesource': { enabled: true } } })
    writeFileSync(path.join(cachePath, 'bundle.json'), JSON.stringify({ name: 'nsolid-plugin', version: '1.0.0', skills: [] }))

    const result = await executeCodexTransaction(item(cachePath), {
      run: async () => ({ exitCode: null, stdout: '', stderr: '', timedOut: true, treeTerminated: false }),
    })

    assert.equal(result.success, false)
    assert.equal(result.rollbackAttempted, false)
    assert.equal(result.error?.code, 'CODEX_TREE_TERMINATION_UNCONFIRMED')
    // The randomly named sibling backup directories must be discoverable from
    // the error so the user can locate or remove the preserved evidence.
    assert.match(result.error?.message ?? '', /config-backup/)
    assert.match(result.error?.message ?? '', /cache-backup/)
    assert.equal(result.error?.message?.includes(path.dirname(cachePath)), true)
  })

  describe('rollback gating and verified restore', () => {
    function backupContainers (baseDir: string, marker: string): string[] {
      return existsSync(baseDir) ? readdirSync(baseDir).filter((name) => name.includes(marker)) : []
    }

    function failedUpgradeItem (cachePath: string): UpdatePlanItem {
      // The reviewer's exact scenario: a failed install/upgrade command whose
      // args contain no `remove` at all.
      return {
        ...item(cachePath),
        steps: [
          { kind: 'command', description: 'upgrade', command: { executable: 'codex', args: ['plugin', 'marketplace', 'upgrade', 'NodeSource/nsolid-plugin'], timeoutMs: 1000 } },
        ],
      }
    }

    function setupFixture (): { cachePath: string; configPath: string; originalConfig: string; configMarker: string } {
      const cachePath = path.join(home, '.codex', 'plugins', 'cache', 'nsolid-plugin')
      mkdirSync(cachePath, { recursive: true })
      const configPath = path.join(home, '.codex', 'config.toml')
      mkdirSync(path.dirname(configPath), { recursive: true })
      writeFileSync(configPath, [
        '# user comment must survive',
        '[plugins."nsolid-plugin@nodesource"]',
        'enabled = true',
        '',
      ].join('\n'))
      writeFileSync(path.join(cachePath, 'bundle.json'), JSON.stringify({ name: 'nsolid-plugin', version: '1.0.0', skills: [] }))
      return { cachePath, configPath, originalConfig: readFileSync(configPath, 'utf8'), configMarker: '.nsolid-config-backup-' }
    }

    function tamperConfigBackup (configPath: string, marker: string, tampered: string): void {
      const container = backupContainers(path.dirname(configPath), marker)[0]
      assert.ok(container, 'expected the config backup container to exist')
      writeFileSync(path.join(path.dirname(configPath), container, path.basename(configPath)), tampered)
    }

    it('rolls back a failed upgrade command whose args contain no remove', async () => {
      const fixture = setupFixture()
      const result = await executeCodexTransaction(failedUpgradeItem(fixture.cachePath), {
        run: async (command) => {
          // Simulate the partially mutated state the failed command leaves.
          writeFileSync(path.join(fixture.cachePath, 'bundle.json'), JSON.stringify({ name: 'nsolid-plugin', version: '9.9.9', skills: [] }))
          assert.equal(command.args.includes('remove'), false)
          return { exitCode: 1, stdout: '', stderr: '', timedOut: false }
        },
      })

      assert.equal(result.success, false)
      assert.equal(result.error?.code, 'CODEX_COMMAND_FAILED')
      assert.equal(result.rollbackAttempted, true)
      assert.equal(result.rollbackSucceeded, true)
      assert.equal(readFileSync(fixture.configPath, 'utf8'), fixture.originalConfig)
      assert.match(readFileSync(path.join(fixture.cachePath, 'bundle.json'), 'utf8'), /1\.0\.0/)
      assert.equal(backupContainers(path.dirname(fixture.configPath), fixture.configMarker).length, 0)
    })

    it('refuses to restore a tampered config backup', async () => {
      const fixture = setupFixture()
      const result = await executeCodexTransaction(failedUpgradeItem(fixture.cachePath), {
        run: async () => {
          const mutatedConfig = fixture.originalConfig.replace('enabled = true', 'enabled = false')
          writeFileSync(fixture.configPath, mutatedConfig)
          tamperConfigBackup(fixture.configPath, fixture.configMarker, '# tampered bytes')
          return { exitCode: 1, stdout: '', stderr: '', timedOut: false }
        },
      })

      assert.equal(result.success, false)
      assert.equal(result.rollbackAttempted, true)
      assert.equal(result.rollbackSucceeded, false)
      // The live config must not be overwritten with the tampered backup
      // bytes, and it must not have been restored to the original either.
      assert.equal(readFileSync(fixture.configPath, 'utf8'), fixture.originalConfig.replace('enabled = true', 'enabled = false'))
      // Backups are preserved for manual recovery.
      assert.equal(backupContainers(path.dirname(fixture.configPath), fixture.configMarker).length, 1)
    })

    it('refuses to overwrite a concurrently edited live config after command failure', async () => {
      const fixture = setupFixture()
      const drifted = `${fixture.originalConfig}# concurrent user edit\n`
      const result = await executeCodexTransaction(failedUpgradeItem(fixture.cachePath), {
        // The concurrent edit must land after the transaction captures the
        // post-command state but before the restore reads the live bytes, so
        // it is queued two microtask ticks behind the failure resolution.
        run: () => new Promise((resolve) => {
          queueMicrotask(() => {
            resolve({ exitCode: 1, stdout: '', stderr: '', timedOut: false })
            queueMicrotask(() => queueMicrotask(() => writeFileSync(fixture.configPath, drifted)))
          })
        }),
      })

      assert.equal(result.success, false)
      assert.equal(result.rollbackAttempted, true)
      assert.equal(result.rollbackSucceeded, false)
      assert.equal(readFileSync(fixture.configPath, 'utf8'), drifted)
      assert.equal(backupContainers(path.dirname(fixture.configPath), fixture.configMarker).length, 1)
    })

    it('restores exact original digests, not mere existence', async () => {
      const fixture = setupFixture()
      const digestBefore = nativePayloadDigest(fixture.cachePath)
      assert.ok(digestBefore, 'the cache must be digestible')
      const result = await executeCodexTransaction(failedUpgradeItem(fixture.cachePath), {
        run: async () => {
          writeFileSync(path.join(fixture.cachePath, 'bundle.json'), JSON.stringify({ name: 'nsolid-plugin', version: '9.9.9', skills: [] }))
          writeFileSync(path.join(fixture.cachePath, 'stray.json'), '{}')
          return { exitCode: 1, stdout: '', stderr: '', timedOut: false }
        },
      })

      assert.equal(result.rollbackAttempted, true)
      assert.equal(result.rollbackSucceeded, true)
      assert.equal(readFileSync(fixture.configPath, 'utf8'), fixture.originalConfig)
      assert.equal(existsSync(path.join(fixture.cachePath, 'stray.json')), false)
      assert.equal(nativePayloadDigest(fixture.cachePath), digestBefore)
    })

    it('restores an originally empty config file after a failed command', async () => {
      const fixture = setupFixture()
      writeFileSync(fixture.configPath, '')
      const result = await executeCodexTransaction(failedUpgradeItem(fixture.cachePath), {
        run: async () => {
          writeFileSync(fixture.configPath, 'codex rewrote the empty config\n')
          return { exitCode: 1, stdout: '', stderr: '', timedOut: false }
        },
      })

      assert.equal(result.success, false)
      assert.equal(result.rollbackAttempted, true)
      assert.equal(result.rollbackSucceeded, true)
      assert.equal(readFileSync(fixture.configPath, 'utf8'), '')
      assert.equal(backupContainers(path.dirname(fixture.configPath), fixture.configMarker).length, 0)
    })
  })
})
