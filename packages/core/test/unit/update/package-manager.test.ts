import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import { detectGlobalPackageOwnership, verifyGlobalPackage } from '../../../src/update/package-manager.js'

function fixture (managers: readonly string[] = ['npm']) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'nsolid-plugin-manager-'))
  const packagePath = path.join(root, 'lib', 'node_modules', 'nsolid-plugin')
  const executablePath = path.join(packagePath, 'dist', 'src', 'cli.js')
  const binPath = path.join(root, 'bin')
  mkdirSync(path.dirname(executablePath), { recursive: true })
  mkdirSync(binPath, { recursive: true })
  writeFileSync(path.join(packagePath, 'package.json'), JSON.stringify({ name: 'nsolid-plugin', version: '1.0.1' }))
  writeFileSync(executablePath, '#!/usr/bin/env node\n')
  for (const manager of managers) {
    const managerPath = path.join(binPath, process.platform === 'win32' ? `${manager}.CMD` : manager)
    if (process.platform === 'win32') {
      // On Windows a bare launcher name must resolve through a validated
      // npm-generated shim to a JS entrypoint. Emit a real npm-style shim plus
      // its node_modules entrypoint so `resolveExecutableIdentity` accepts it.
      const entrypoint = path.join(binPath, 'node_modules', manager, 'bin', `${manager}-cli.js`)
      const entryDir = path.dirname(entrypoint)
      mkdirSync(entryDir, { recursive: true })
      writeFileSync(entrypoint, '#!/usr/bin/env node\n')
      writeFileSync(path.join(binPath, 'node_modules', manager, 'package.json'), JSON.stringify({
        name: manager,
        bin: { [manager]: `bin/${manager}-cli.js` },
      }))
      writeFileSync(managerPath,
        '@ECHO off\r\nSETLOCAL\r\nCALL :find_dp0\r\nIF EXIST "%dp0%\\node.exe" (SET "_prog=%dp0%\\node.exe") ELSE (SET "_prog=node")\r\n' +
        `"%_prog%" "%dp0%\\node_modules\\${manager}\\bin\\${manager}-cli.js" %*\r\n` +
        'exit /b %errorlevel%\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n')
    } else {
      writeFileSync(managerPath, '#!/bin/sh\n')
      chmodSync(managerPath, 0o755)
    }
  }
  return {
    root,
    packagePath,
    executablePath,
    env: {
      PATH: binPath,
      ...(process.platform === 'win32' ? { PATHEXT: '.CMD' } : {}),
    },
  }
}

describe('global CLI package ownership', () => {
  it('accepts a package contained by the npm-reported global root', async () => {
    const paths = fixture()
    const calls: Array<{ executable: string; args: readonly string[] }> = []
    const result = await detectGlobalPackageOwnership({
      commandRunner: {
        run: async (spec) => {
          calls.push({ executable: spec.executable, args: spec.args })
          return { exitCode: 0, stdout: `${path.join(paths.root, 'lib', 'node_modules')}\n`, stderr: '', timedOut: false }
        },
      },
      packageRoot: paths.packagePath,
      executablePath: paths.executablePath,
      env: paths.env,
    })

    assert.equal(result.ownership?.manager, 'npm')
    const managerPath = path.join(paths.env.PATH, process.platform === 'win32' ? 'npm.CMD' : 'npm')
    const entrypoint = path.join(paths.env.PATH, 'node_modules', 'npm', 'bin', 'npm-cli.js')
    assert.deepEqual(calls, [{
      executable: process.platform === 'win32' ? process.execPath : managerPath,
      args: process.platform === 'win32' ? [entrypoint, 'root', '--global'] : ['root', '--global'],
    }])
    assert.equal(result.ownership?.rollbackCommand, 'npm install --global nsolid-plugin@1.0.1')
  })

  it('normalizes pnpm symlinked package roots before proving ownership', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'nsolid-plugin-pnpm-'))
    const globalRoot = path.join(root, 'global', 'node_modules')
    const storePackage = path.join(root, 'store', 'nsolid-plugin')
    const executablePath = path.join(storePackage, 'dist', 'src', 'cli.js')
    const binPath = path.join(root, 'bin')
    mkdirSync(path.dirname(executablePath), { recursive: true })
    mkdirSync(globalRoot, { recursive: true })
    mkdirSync(binPath, { recursive: true })
    writeFileSync(path.join(storePackage, 'package.json'), JSON.stringify({ name: 'nsolid-plugin', version: '1.0.1' }))
    writeFileSync(executablePath, '#!/usr/bin/env node\n')
    chmodSync(executablePath, 0o755)
    const pnpmExecutable = path.join(binPath, process.platform === 'win32' ? 'pnpm.CMD' : 'pnpm')
    if (process.platform === 'win32') {
      const pnpmEntrypoint = path.join(binPath, 'node_modules', 'pnpm', 'bin', 'pnpm-cli.js')
      mkdirSync(path.dirname(pnpmEntrypoint), { recursive: true })
      writeFileSync(pnpmEntrypoint, '#!/usr/bin/env node\n')
      writeFileSync(path.join(binPath, 'node_modules', 'pnpm', 'package.json'), JSON.stringify({
        name: 'pnpm',
        bin: { pnpm: 'bin/pnpm-cli.js' },
      }))
      writeFileSync(pnpmExecutable, '@ECHO off\r\n"node" "%~dp0\\node_modules\\pnpm\\bin\\pnpm-cli.js" %*\r\n')
    } else {
      writeFileSync(pnpmExecutable, '#!/bin/sh\n')
      chmodSync(pnpmExecutable, 0o755)
    }
    const symlinkedPackage = path.join(globalRoot, 'nsolid-plugin')
    symlinkSync(storePackage, symlinkedPackage, 'dir')

    const result = await detectGlobalPackageOwnership({
      commandRunner: {
        run: async () => ({ exitCode: 0, stdout: `${globalRoot}\n`, stderr: '', timedOut: false }),
      },
      packageRoot: storePackage,
      executablePath,
      env: { PATH: binPath },
    })

    assert.equal(result.ownership?.manager, 'pnpm')
    assert.equal(result.ownership?.packagePath, symlinkedPackage)

    const nextStorePackage = path.join(root, 'store', 'nsolid-plugin-next')
    mkdirSync(nextStorePackage, { recursive: true })
    writeFileSync(path.join(nextStorePackage, 'package.json'), JSON.stringify({ name: 'nsolid-plugin', version: '1.0.2' }))
    rmSync(symlinkedPackage, { force: true })
    symlinkSync(nextStorePackage, symlinkedPackage, 'dir')
    assert.equal(verifyGlobalPackage(result.ownership!, '1.0.2'), true)
  })

  it('rejects an exact artifact when the installed package cannot prove its content identity', () => {
    const paths = fixture()
    writeFileSync(path.join(paths.packagePath, 'package.json'), JSON.stringify({ name: 'nsolid-plugin', version: '1.0.2' }))

    assert.equal(verifyGlobalPackage({
      manager: 'npm',
      packageRoot: path.dirname(paths.packagePath),
      packagePath: paths.packagePath,
      executable: { kind: 'native', executable: path.join(paths.env.PATH, 'npm') },
      rollbackCommand: 'npm install --global nsolid-plugin@1.0.1',
    }, '1.0.2', {
      kind: 'npm',
      packageName: 'nsolid-plugin',
      version: '1.0.2',
      registry: 'https://registry.npmjs.org',
      tarball: 'https://registry.npmjs.org/nsolid-plugin/-/nsolid-plugin-1.0.2.tgz',
      integrity: 'sha512-dGVzdA==',
      contentDigest: 'planned-content',
    }), false)
  })

  it('compares installed bytes with the integrity-verified npm tarball when manager metadata is absent', () => {
    const paths = fixture()
    const packageJson = JSON.stringify({ name: 'nsolid-plugin', version: '1.0.2' })
    const cli = '#!/usr/bin/env node\n'
    writeFileSync(path.join(paths.packagePath, 'package.json'), packageJson)
    writeFileSync(paths.executablePath, cli)
    const tarballPath = path.join(paths.root, 'nsolid-plugin-1.0.2.tgz')
    const tarball = npmTarball({
      'package/package.json': packageJson,
      'package/dist/src/cli.js': cli,
    })
    writeFileSync(tarballPath, tarball)
    const artifact = {
      kind: 'npm' as const,
      packageName: 'nsolid-plugin' as const,
      version: '1.0.2',
      registry: 'https://registry.npmjs.org',
      tarball: 'https://registry.npmjs.org/nsolid-plugin/-/nsolid-plugin-1.0.2.tgz',
      integrity: `sha512-${createHash('sha512').update(tarball).digest('base64')}`,
      tarballPath,
      contentDigest: createHash('sha256').update(tarball).digest('hex'),
    }
    const ownership = {
      manager: 'npm' as const,
      packageRoot: path.dirname(paths.packagePath),
      packagePath: paths.packagePath,
      executable: { kind: 'native' as const, executable: path.join(paths.env.PATH, 'npm') },
      rollbackCommand: 'npm install --global nsolid-plugin@1.0.1',
    }

    assert.equal(verifyGlobalPackage(ownership, '1.0.2', artifact), true)
    writeFileSync(paths.executablePath, '#!/usr/bin/env node\nconsole.log("tampered")\n')
    assert.equal(verifyGlobalPackage(ownership, '1.0.2', artifact), false)
  })

  it('does not reject a normal package because wrapper home variables are ambient', async () => {
    const paths = fixture()
    const result = await detectGlobalPackageOwnership({
      commandRunner: {
        run: async () => ({ exitCode: 0, stdout: `${path.join(paths.root, 'lib', 'node_modules')}\n`, stderr: '', timedOut: false }),
      },
      packageRoot: paths.packagePath,
      executablePath: paths.executablePath,
      env: { ...paths.env, VOLTA_HOME: '/tmp/volta', BUN_INSTALL: '/tmp/bun', YARN_VERSION: '1' },
    })

    assert.equal(result.ownership?.manager, 'npm')
  })

  it('rejects a broken entrypoint and a manager root mismatch', async () => {
    const paths = fixture()
    const broken = path.join(paths.root, 'missing', 'nsolid-plugin')
    const mismatch = await detectGlobalPackageOwnership({
      commandRunner: {
        run: async () => ({ exitCode: 0, stdout: `${path.join(paths.root, 'other', 'node_modules')}\n`, stderr: '', timedOut: false }),
      },
      packageRoot: paths.packagePath,
      executablePath: paths.executablePath,
      env: paths.env,
    })
    const brokenResult = await detectGlobalPackageOwnership({
      commandRunner: {
        run: async () => ({ exitCode: 0, stdout: `${path.join(paths.root, 'lib', 'node_modules')}\n`, stderr: '', timedOut: false }),
      },
      packageRoot: paths.packagePath,
      executablePath: broken,
      env: paths.env,
    })

    assert.equal(mismatch.ownership, undefined)
    assert.equal(brokenResult.ownership, undefined)
    assert.equal(mismatch.unsupported?.code, 'UNSUPPORTED_CLI_SOURCE')
  })

  it('does not invoke a package manager in read-only mode', async () => {
    const paths = fixture()
    let calls = 0
    const result = await detectGlobalPackageOwnership({
      commandRunner: {
        run: async () => {
          calls++
          throw new Error('must not run')
        },
      },
      packageRoot: paths.packagePath,
      executablePath: paths.executablePath,
      env: paths.env,
      readOnly: true,
    })

    assert.equal(calls, 0)
    assert.equal(result.ownership, undefined)
    assert.equal(result.unsupported?.code, 'UNSUPPORTED_CLI_SOURCE')
  })

  it('rejects ambiguous ownership when npm and pnpm both claim the package', async () => {
    const paths = fixture(['npm', 'pnpm'])
    const result = await detectGlobalPackageOwnership({
      commandRunner: {
        run: async () => ({ exitCode: 0, stdout: `${path.join(paths.root, 'lib', 'node_modules')}\n`, stderr: '', timedOut: false }),
      },
      packageRoot: paths.packagePath,
      executablePath: paths.executablePath,
      env: paths.env,
    })

    assert.equal(result.ownership, undefined)
    assert.match(result.unsupported?.message ?? '', /ambiguous/i)
  })
})

function npmTarball (files: Readonly<Record<string, string>>): Buffer {
  const blocks: Buffer[] = []
  for (const [name, contents] of Object.entries(files)) {
    const body = Buffer.from(contents)
    const header = Buffer.alloc(512)
    header.write(name, 0, 100, 'utf8')
    writeTarOctal(header, 100, 8, 0o644)
    writeTarOctal(header, 108, 8, 0)
    writeTarOctal(header, 116, 8, 0)
    writeTarOctal(header, 124, 12, body.length)
    writeTarOctal(header, 136, 12, 0)
    header.fill(0x20, 148, 156)
    header[156] = '0'.charCodeAt(0)
    header.write('ustar\0', 257, 6, 'ascii')
    header.write('00', 263, 2, 'ascii')
    writeTarOctal(header, 148, 8, [...header].reduce((sum, byte) => sum + byte, 0))
    blocks.push(header, body, Buffer.alloc((512 - body.length % 512) % 512))
  }
  blocks.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(blocks))
}

function writeTarOctal (buffer: Buffer, offset: number, length: number, value: number): void {
  const encoded = value.toString(8).padStart(length - 1, '0') + '\0'
  buffer.write(encoded, offset, length, 'ascii')
}
