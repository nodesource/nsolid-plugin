import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { piStrategy } from '../../../src/update/strategies/pi.js'
import type { UpdatePlanItem } from '../../../src/update/types.js'

const REGISTRY = 'https://registry.example/npm'
let root: string
let previousPath: string | undefined
let previousPathExt: string | undefined

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'nsolid-plugin-pi-provenance-'))
  previousPath = process.env.PATH
  previousPathExt = process.env.PATHEXT
})

afterEach(() => {
  if (previousPath === undefined) delete process.env.PATH
  else process.env.PATH = previousPath
  if (previousPathExt === undefined) delete process.env.PATHEXT
  else process.env.PATHEXT = previousPathExt
  rmSync(root, { recursive: true, force: true })
})

function digest (filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex')
}

function integrity (value: string): string {
  return `sha512-${createHash('sha512').update(value).digest('base64')}`
}

function writeJson (filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true })
  writeFileSync(filePath, JSON.stringify(value, null, 2))
}

function createFixture (): {
  item: UpdatePlanItem
  packageRoot: string
  lockPath: string
  artifactTarball: string
  artifactIntegrity: string
} {
  const bin = path.join(root, 'bin')
  const npmRoot = path.join(root, 'npm')
  const packageRoot = path.join(npmRoot, 'node_modules', 'nsolid-pi-plugin')
  const lockPath = path.join(npmRoot, 'package-lock.json')
  const settingsPath = path.join(root, 'settings.json')
  const artifactTarball = `${REGISTRY}/nsolid-pi-plugin/-/nsolid-pi-plugin-1.0.1.tgz`
  const artifactIntegrity = integrity('planned artifact')
  mkdirSync(packageRoot, { recursive: true })
  mkdirSync(bin, { recursive: true })
  writeLauncher(bin, 'pi')
  writeJson(path.join(packageRoot, 'package.json'), { name: 'nsolid-pi-plugin', version: '1.0.0' })
  writeFileSync(path.join(root, 'planned.tgz'), 'planned artifact')
  writeJson(settingsPath, { packages: ['npm:nsolid-pi-plugin'] })
  writeJson(lockPath, {
    lockfileVersion: 3,
    packages: {
      'node_modules/nsolid-pi-plugin': {
        name: 'nsolid-pi-plugin',
        version: '1.0.0',
        resolved: `${REGISTRY}/nsolid-pi-plugin/-/nsolid-pi-plugin-1.0.0.tgz`,
        integrity: integrity('old artifact'),
      },
    },
  })
  process.env.PATH = bin

  return {
    packageRoot,
    lockPath,
    artifactTarball,
    artifactIntegrity,
    item: {
      installationId: 'pi:package:user',
      target: 'pi',
      ownership: 'package-owned',
      installed: true,
      source: { kind: 'pi-package', spec: 'npm:nsolid-pi-plugin', scopes: ['user'] },
      version: { current: '1.0.0', latest: '1.0.1', status: 'update-available' },
      artifact: {
        kind: 'npm',
        packageName: 'nsolid-pi-plugin',
        version: '1.0.1',
        registry: REGISTRY,
        tarball: artifactTarball,
        integrity: artifactIntegrity,
        tarballPath: path.join(root, 'planned.tgz'),
      },
      metadata: {
        packageRoots: [packageRoot],
        packageRootIdentities: [realpathSync(packageRoot)],
        settingsPaths: [settingsPath],
        settingsDigests: [digest(settingsPath)],
        sourceEntries: ['npm:nsolid-pi-plugin'],
        cacheDigests: [digest(path.join(packageRoot, 'package.json'))],
        packageEvidencePaths: [lockPath],
        packageEvidenceDigests: [digest(lockPath)],
      },
      steps: [],
      rollbackSteps: [],
      requiresConfirmation: true,
    },
  }
}

function writeLauncher (bin: string, name: string): void {
  if (process.platform !== 'win32') {
    writeFileSync(path.join(bin, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    return
  }
  const entrypoint = path.join(bin, 'node_modules', name, 'bin', `${name}.js`)
  mkdirSync(path.dirname(entrypoint), { recursive: true })
  writeFileSync(entrypoint, '#!/usr/bin/env node\n')
  writeJson(path.join(bin, 'node_modules', name, 'package.json'), { name, bin: { [name]: `bin/${name}.js` } })
  writeFileSync(path.join(bin, `${name}.cmd`), `@ECHO off\r\n"node" "%~dp0\\node_modules\\${name}\\bin\\${name}.js" %*\r\n`)
  process.env.PATHEXT = '.CMD'
}

function updateEvidence (lockPath: string, version: string, resolved: string, packageIntegrity: string): void {
  writeJson(lockPath, {
    lockfileVersion: 3,
    packages: {
      'node_modules/nsolid-pi-plugin': {
        name: 'nsolid-pi-plugin',
        version,
        resolved,
        integrity: packageIntegrity,
      },
    },
  })
}

async function executeFixture (configure: (fixture: ReturnType<typeof createFixture>) => void | Promise<void>, fetchImpl?: typeof fetch) {
  const current = createFixture()
  const item = await piStrategy.plan(current.item, { options: { fetchImpl }, commandRunner: { run: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }) } })
  return piStrategy.execute(item, {
    options: { fetchImpl },
    commandRunner: {
      run: async (command) => {
        assert.equal(command.env?.npm_config_registry, REGISTRY)
        assert.equal(command.env?.NPM_CONFIG_REGISTRY, REGISTRY)
        await configure(current)
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false }
      },
    },
  })
}

describe('Pi package provenance validation', () => {
  it('rejects a matching version with different integrity', async () => {
    const result = await executeFixture(({ packageRoot, lockPath, artifactTarball }) => {
      writeJson(path.join(packageRoot, 'package.json'), { name: 'nsolid-pi-plugin', version: '1.0.1' })
      updateEvidence(lockPath, '1.0.1', artifactTarball, integrity('wrong artifact'))
    })

    assert.equal(result.status, 'failed')
    assert.equal(result.error?.code, 'PI_PROVENANCE_MISMATCH')
  })

  it('rejects a matching version resolved from a different registry', async () => {
    const result = await executeFixture(({ packageRoot, lockPath, artifactIntegrity }) => {
      writeJson(path.join(packageRoot, 'package.json'), { name: 'nsolid-pi-plugin', version: '1.0.1' })
      updateEvidence(lockPath, '1.0.1', 'https://other.example/nsolid-pi-plugin.tgz', artifactIntegrity)
    })

    assert.equal(result.status, 'failed')
    assert.equal(result.error?.code, 'PI_PROVENANCE_MISMATCH')
  })

  it('rejects an update with missing package evidence', async () => {
    const result = await executeFixture(({ packageRoot, lockPath }) => {
      writeJson(path.join(packageRoot, 'package.json'), { name: 'nsolid-pi-plugin', version: '1.0.1' })
      unlinkSync(lockPath)
    })

    assert.equal(result.status, 'failed')
    assert.equal(result.error?.code, 'PI_PROVENANCE_UNVERIFIED')
  })

  it('accepts matching evidence for the planned artifact', async () => {
    const result = await executeFixture(({ packageRoot, lockPath, artifactTarball, artifactIntegrity }) => {
      writeJson(path.join(packageRoot, 'package.json'), { name: 'nsolid-pi-plugin', version: '1.0.1' })
      updateEvidence(lockPath, '1.0.1', artifactTarball, artifactIntegrity)
    })

    assert.equal(result.status, 'updated', JSON.stringify(result))
    assert.equal(result.resultingVersion, '1.0.1')
  })

  it('resolves and validates exact metadata for a newer installed version', async () => {
    const newerTarball = `${REGISTRY}/nsolid-pi-plugin/-/nsolid-pi-plugin-1.0.2.tgz`
    const newerIntegrity = integrity('newer artifact')
    const result = await executeFixture(({ packageRoot, lockPath }) => {
      writeJson(path.join(packageRoot, 'package.json'), { name: 'nsolid-pi-plugin', version: '1.0.2' })
      updateEvidence(lockPath, '1.0.2', newerTarball, newerIntegrity)
    }, async () => new Response(JSON.stringify({
      versions: {
        '1.0.2': { version: '1.0.2', dist: { tarball: newerTarball, integrity: newerIntegrity } },
      },
    }), { status: 200 }))

    assert.equal(result.status, 'updated')
    assert.equal(result.resultingVersion, '1.0.2')
  })

  it('rejects a newer version whose exact registry metadata cannot be proven', async () => {
    const newerTarball = `${REGISTRY}/nsolid-pi-plugin/-/nsolid-pi-plugin-1.0.2.tgz`
    const result = await executeFixture(({ packageRoot, lockPath }) => {
      writeJson(path.join(packageRoot, 'package.json'), { name: 'nsolid-pi-plugin', version: '1.0.2' })
      updateEvidence(lockPath, '1.0.2', newerTarball, integrity('local newer artifact'))
    }, async () => new Response(JSON.stringify({
      versions: {
        '1.0.2': { version: '1.0.2', dist: { tarball: newerTarball, integrity: integrity('different registry artifact') } },
      },
    }), { status: 200 }))

    assert.equal(result.status, 'failed')
    assert.equal(result.error?.code, 'PI_PROVENANCE_MISMATCH')
  })
})
