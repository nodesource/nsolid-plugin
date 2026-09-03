import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { installedPackageMatchesTarball } from '../../../src/update/package-content.js'

/** Minimal ustar builder: one header (512 bytes) plus body padded to 512. */
function tarEntry (name: string, body: Buffer | undefined, type: string): Buffer {
  const header = Buffer.alloc(512)
  header.write(name, 0, 'utf8')
  const size = body ? body.length : 0
  header.write(size.toString(8).padStart(11, '0') + ' ', 124, 'ascii')
  header[156] = type.charCodeAt(0)
  header.write('ustar', 257, 'ascii')
  header.write('00', 263, 'ascii')
  const blocks = Math.ceil(size / 512)
  const padded = Buffer.concat([body ?? Buffer.alloc(0), Buffer.alloc(blocks * 512 - size)])
  return Buffer.concat([header, padded])
}

describe('installedPackageMatchesTarball', () => {
  let directory: string

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'nsolid-plugin-package-content-'))
  })

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  it('matches an installed package whose files equal the tarball payload', () => {
    const manifest = Buffer.from('{"name":"nsolid-plugin","version":"1.0.0"}\n')
    const tar = Buffer.concat([tarEntry('package/package.json', manifest, '0'), Buffer.alloc(1024)])
    const tarball = path.join(directory, 'artifact.tgz')
    writeFileSync(tarball, gzipSync(tar))
    const root = path.join(directory, 'installed')
    mkdirSync(root)
    writeFileSync(path.join(root, 'package.json'), manifest)
    assert.equal(installedPackageMatchesTarball(root, tarball), true)
  })

  it('returns false for a gzip that expands beyond the archive bound', () => {
    const oversized = gzipSync(Buffer.alloc(65 * 1024 * 1024))
    assert.ok(oversized.length < 1024 * 1024, 'fixture must be small on disk')
    const tarball = path.join(directory, 'bomb.tgz')
    writeFileSync(tarball, oversized)
    const root = path.join(directory, 'installed')
    mkdirSync(root)
    writeFileSync(path.join(root, 'package.json'), '{}')
    assert.equal(installedPackageMatchesTarball(root, tarball), false)
  })

  it('returns false for a decompression bomb even when the payload would match', () => {
    // Distinguishes the bounded reader from the former unbounded one: a
    // small package.json plus enough zero padding to push the decompressed
    // archive past MAX_TARBALL_BYTES. The old reader (unbounded gunzip, no
    // compressed-size check) returned true here; the bounded reader throws
    // in gunzipSync and the outer catch yields false. Verified against the
    // pre-fix code (git 09972c4): old result was true, new result is false.
    const manifest = Buffer.from('{"name":"nsolid-plugin","version":"1.0.0"}\n')
    const tar = Buffer.concat([tarEntry('package/package.json', manifest, '0'), Buffer.alloc(70 * 1024 * 1024)])
    const tarball = path.join(directory, 'matching-bomb.tgz')
    writeFileSync(tarball, gzipSync(tar))
    const root = path.join(directory, 'installed-matching')
    mkdirSync(root)
    writeFileSync(path.join(root, 'package.json'), manifest)
    assert.equal(installedPackageMatchesTarball(root, tarball), false)
  })
})
