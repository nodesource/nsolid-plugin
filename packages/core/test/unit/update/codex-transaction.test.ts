import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { writeTomlFileSync } from '../../../src/utils/config.js'
import { restoreCodexUserOwnedFields } from '../../../src/update/codex-config.js'
import { executeCodexTransaction, readCodexPayloadVersion } from '../../../src/update/codex-transaction.js'
import { nativePayloadDigest } from '../../../src/update/native-evidence.js'
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
    rmSync(newPayload, { recursive: true, force: true })
    const candidate = item(cachePath)
    candidate.artifact = {
      kind: 'git',
      repository: 'https://github.com/NodeSource/nsolid-plugin.git',
      commit: 'bc9c87e6ce6ca73756dc20fdd41a3219bcd5b60c',
      contentDigest: plannedDigest,
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
})
