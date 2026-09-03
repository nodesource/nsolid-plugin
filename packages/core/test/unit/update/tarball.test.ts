import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readTarEntryText } from '../../../src/update/tarball.js'

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

describe('in-process tar entry reader', () => {
  let directory: string

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'nsolid-plugin-tarball-'))
  })

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  function writeTarball (name: string, bytes: Buffer, gzip = true): string {
    const tarball = path.join(directory, name)
    writeFileSync(tarball, gzip ? gzipSync(bytes) : bytes)
    return tarball
  }

  it('extracts a file entry from a gzip-compressed npm-style tarball', async () => {
    const bundle = Buffer.from('{"name":"nsolid-plugin"}\n')
    const tar = Buffer.concat([
      tarEntry('package/', undefined, '5'),
      tarEntry('package/bundle.json', bundle, '0'),
      tarEntry('package/other.txt', Buffer.from('unrelated'), '0'),
      Buffer.alloc(1024),
    ])
    assert.equal(await readTarEntryText(writeTarball('artifact.tgz', tar), 'package/bundle.json'), bundle.toString('utf8'))
  })

  it('extracts a file entry from a plain uncompressed tar', async () => {
    const tar = Buffer.concat([tarEntry('package/bundle.json', Buffer.from('plain'), '0'), Buffer.alloc(1024)])
    assert.equal(await readTarEntryText(writeTarball('plain.tar', tar, false), 'package/bundle.json'), 'plain')
  })

  it('returns undefined for a missing entry', async () => {
    const tar = Buffer.concat([tarEntry('package/other.json', Buffer.from('{}'), '0'), Buffer.alloc(1024)])
    assert.equal(await readTarEntryText(writeTarball('missing.tgz', tar), 'package/bundle.json'), undefined)
  })

  it('returns undefined for a truncated archive', async () => {
    const tar = Buffer.concat([tarEntry('package/bundle.json', Buffer.from('{"a":1}'), '0'), Buffer.alloc(1024)])
    const tarball = path.join(directory, 'truncated.tgz')
    writeFileSync(tarball, gzipSync(tar).subarray(0, 40))
    assert.equal(await readTarEntryText(tarball, 'package/bundle.json'), undefined)
  })

  it('returns undefined for a file that is not a tar archive', async () => {
    const tarball = path.join(directory, 'garbage.tgz')
    writeFileSync(tarball, Buffer.from('this is definitely not a tar archive, not even close'))
    assert.equal(await readTarEntryText(tarball, 'package/bundle.json'), undefined)
  })

  it('returns undefined for a nonexistent path', async () => {
    assert.equal(await readTarEntryText(path.join(directory, 'absent.tgz'), 'package/bundle.json'), undefined)
  })

  it('returns undefined for a gzip that expands beyond the archive bound', async () => {
    // 65 MiB of zeros gzips to well under 100 KiB but must never be
    // materialized: the decompressed size is capped, not only the file size.
    const oversized = gzipSync(Buffer.alloc(65 * 1024 * 1024))
    assert.ok(oversized.length < 1024 * 1024, 'fixture must be small on disk')
    const tarball = path.join(directory, 'bomb.tgz')
    writeFileSync(tarball, oversized)
    assert.equal(await readTarEntryText(tarball, 'package/bundle.json'), undefined)
  })

  it('rejects a decompression bomb even when a matching entry would be readable', async () => {
    // Distinguishes the bounded reader from the former unbounded one: the
    // archive decompresses past MAX_TARBALL_BYTES, but the entry itself is
    // small, so the old reader (no maxOutputLength) successfully returned
    // its content while the bounded reader throws during gunzipSync and
    // yields the best-effort undefined. Verified against the pre-fix code
    // (git 09972c4): old result was '{}', new result is undefined.
    const tar = Buffer.concat([
      tarEntry('package/bundle.json', Buffer.from('{}'), '0'),
      Buffer.alloc(70 * 1024 * 1024),
    ])
    const gzipped = gzipSync(tar)
    assert.ok(gzipped.length < 1024 * 1024, 'fixture must be small on disk')
    const tarball = path.join(directory, 'readable-bomb.tgz')
    writeFileSync(tarball, gzipped)
    assert.equal(await readTarEntryText(tarball, 'package/bundle.json'), undefined)
  })

  it('refuses an entry beyond the size bound instead of buffering it', async () => {
    const oversized = Buffer.alloc(2 << 20, 0x61)
    const tar = Buffer.concat([tarEntry('package/bundle.json', oversized, '0'), Buffer.alloc(1024)])
    assert.equal(await readTarEntryText(writeTarball('oversized.tgz', tar), 'package/bundle.json'), undefined)
  })

  it('reads the archive in-process: correct content even when PATH offers a hostile tar', async () => {
    const hostileBin = path.join(directory, 'hostile-bin')
    mkdirSync(hostileBin)
    const fakeTar = path.join(hostileBin, 'tar')
    writeFileSync(fakeTar, '#!/bin/sh\nprintf "TAMPERED"\n')
    chmodSync(fakeTar, 0o755)
    const bundle = Buffer.from('{"real":"bytes"}')
    const tar = Buffer.concat([tarEntry('package/bundle.json', bundle, '0'), Buffer.alloc(1024)])
    const tarball = writeTarball('hostile.tgz', tar)
    const previousPath = process.env.PATH
    try {
      process.env.PATH = hostileBin
      assert.equal(await readTarEntryText(tarball, 'package/bundle.json'), bundle.toString('utf8'))
      assert.equal(await readTarEntryText(tarball, 'package/bundle.json'), bundle.toString('utf8'), 'a hostile PATH must not change the outcome')
    } finally {
      if (previousPath === undefined) delete process.env.PATH
      else process.env.PATH = previousPath
    }
  })

  it('works when no tar exists on PATH at all', async () => {
    const bundle = Buffer.from('{"offline":true}')
    const tar = Buffer.concat([tarEntry('package/bundle.json', bundle, '0'), Buffer.alloc(1024)])
    const tarball = writeTarball('offline.tgz', tar)
    const previousPath = process.env.PATH
    try {
      process.env.PATH = ''
      assert.equal(await readTarEntryText(tarball, 'package/bundle.json'), bundle.toString('utf8'))
    } finally {
      if (previousPath === undefined) delete process.env.PATH
      else process.env.PATH = previousPath
    }
  })
})
