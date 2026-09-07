import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { gzipSync } from 'node:zlib'
import { installedPackageMatchesTarball } from '../../../src/update/package-content.js'
import { gitArchivePayloadDigest } from '../../../src/update/native-payload.js'
import { tarEntry } from '../../helpers/tar.js'

const manifest = Buffer.from('{}')
const file = () => tarEntry('package/package.json', manifest, '0')
const metadata = (type: string, body: string) => tarEntry('metadata', Buffer.from(body), type)
const pax = (value: string): Buffer => {
  const record = `path=${value}\n`
  let length = Buffer.byteLength(record) + 2
  while (length !== Buffer.byteLength(record) + String(length).length + 1) length = Buffer.byteLength(record) + String(length).length + 1
  return metadata('x', `${length} ${record}`)
}
const headerField = (offset: number, length: number, value: string): Buffer => {
  const entry = file()
  entry.fill(0, offset, offset + length)
  entry.write(value, offset, length)
  return entry
}

// Exercise the public consumers together: the same package/ archive is also
// a single-root Git archive, so both must retain their payload decisions.
describe('TAR consumer compatibility', () => {
  const cases: Array<[string, Buffer[], boolean]> = [
    ['regular file', [file()], true],
    ['NUL regular type', [headerField(156, 1, '\0')], true],
    ['ustar prefix', [(() => { const entry = headerField(0, 100, 'package.json'); entry.write('package', 345); return entry })()], true],
    ['GNU long path', [metadata('L', 'package/package.json\0'), headerField(0, 100, 'ignored')], true],
    ['PAX overrides GNU', [metadata('L', 'wrong/name\0'), pax('package/package.json'), headerField(0, 100, 'ignored')], true],
    ['global PAX preserves pending path', [pax('package/package.json'), metadata('g', 'ignored'), headerField(0, 100, 'ignored')], true],
    ['extension paths reset after entry', [pax('package/package.json'), headerField(0, 100, 'ignored'), tarEntry('package/empty', undefined, '5')], true],
    ['base-256 size', [(() => { const entry = headerField(124, 12, ''); entry[124] = 0x80; entry[135] = 2; return entry })()], true],
    ['missing final padding', [file().subarray(0, 514)], true],
    ['trailing partial header', [file(), Buffer.alloc(20, 1)], true],
    ['zero header terminates traversal', [file(), Buffer.alloc(512), file()], true],
    ['duplicate file', [file(), file()], false],
    ['path traversal', [file(), tarEntry('package/../escape', manifest, '0')], false],
    ['hard link', [file(), tarEntry('package/link', undefined, '1')], false],
    ['truncated body', [file().subarray(0, 513)], false],
    ['negative size', [headerField(124, 12, '-1')], false],
    ['invalid size', [headerField(124, 12, 'invalid')], false],
    ['size overflow', [(() => { const entry = file(); entry.fill(0xff, 124, 136); return entry })()], false],
    ['invalid PAX record', [metadata('x', 'invalid'), file()], false],
    ['PAX length exceeds body', [metadata('x', '999 path=package/package.json\n'), file()], false],
  ]

  for (const [name, parts, accepted] of cases) {
    it(name, () => {
      const directory = mkdtempSync(path.join(tmpdir(), 'nsolid-tar-consumers-'))
      try {
        const root = path.join(directory, 'installed')
        mkdirSync(root)
        writeFileSync(path.join(root, 'package.json'), manifest)
        const archive = gzipSync(Buffer.concat(parts))
        const tarball = path.join(directory, 'archive.tgz')
        writeFileSync(tarball, archive)
        assert.equal(installedPackageMatchesTarball(root, tarball), accepted)
        assert.equal(gitArchivePayloadDigest(archive), accepted ? gitArchivePayloadDigest(gzipSync(file())) : undefined)
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    })
  }
})
