import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import { gitArchivePayloadDigest, nativePayloadTreeDigest } from '../../../src/update/native-payload.js'

describe('native payload identity', () => {
  it('uses the same complete-tree digest for an immutable Git archive and its installed payload', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'nsolid-native-tree-'))
    try {
      const files = new Map([
        ['bundle.json', Buffer.from('{"version":"1.0.1"}\n')],
        ['skills/example/SKILL.md', Buffer.from('# example\n')],
      ])
      for (const [relative, content] of files) {
        const target = path.join(root, relative)
        mkdirSync(path.dirname(target), { recursive: true })
        writeFileSync(target, content)
      }

      const archive = gzipSync(makeTar(files))
      assert.equal(gitArchivePayloadDigest(archive), nativePayloadTreeDigest(root))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('digests only the payload subtree of a multi-plugin marketplace repository', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'nsolid-native-subtree-'))
    try {
      const payloadFiles = new Map([
        ['plugins/nsolid-plugin/bundle.json', Buffer.from('{"version":"1.0.1"}\n')],
        ['plugins/nsolid-plugin/skills/example/SKILL.md', Buffer.from('# example\n')],
      ])
      const siblingFiles = new Map([
        ['plugins/other-plugin/bundle.json', Buffer.from('{"version":"9.9.9"}\n')],
        ['plugins/other-plugin/skills/other/SKILL.md', Buffer.from('# other\n')],
      ])
      const archiveFiles = new Map([...payloadFiles, ...siblingFiles])
      for (const [relative, content] of archiveFiles) {
        const target = path.join(root, relative)
        mkdirSync(path.dirname(target), { recursive: true })
        writeFileSync(target, content)
      }

      const payloadRoot = path.join(root, 'plugins', 'nsolid-plugin')
      const scope = { payloadPath: 'plugins/nsolid-plugin', manifestPath: 'bundle.json' }
      assert.equal(gitArchivePayloadDigest(gzipSync(makeTar(archiveFiles)), scope), nativePayloadTreeDigest(payloadRoot))
      // Sibling bytes are excluded: changing them does not change the digest.
      writeFileSync(path.join(root, 'plugins/other-plugin/bundle.json'), '{"version":"9.9.10"}\n')
      assert.equal(gitArchivePayloadDigest(gzipSync(makeTar(archiveFiles)), scope), nativePayloadTreeDigest(payloadRoot))
      // A nested payload change does change the digest.
      writeFileSync(path.join(root, 'plugins/nsolid-plugin/skills/example/SKILL.md'), '# substituted\n')
      assert.notEqual(gitArchivePayloadDigest(gzipSync(makeTar(archiveFiles)), scope), nativePayloadTreeDigest(payloadRoot))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects subtree scopes with unsafe paths and archives missing the manifest', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'nsolid-native-scope-'))
    try {
      const files = new Map([
        ['plugins/nsolid-plugin/skills/example/SKILL.md', Buffer.from('# example\n')],
      ])
      for (const [relative, content] of files) {
        const target = path.join(root, relative)
        mkdirSync(path.dirname(target), { recursive: true })
        writeFileSync(target, content)
      }
      const archive = gzipSync(makeTar(files))

      // The manifest is absent from the subtree: reject.
      assert.equal(gitArchivePayloadDigest(archive, { payloadPath: 'plugins/nsolid-plugin', manifestPath: 'bundle.json' }), undefined)
      // Traversal in the payload scope: reject.
      assert.equal(gitArchivePayloadDigest(archive, { payloadPath: 'plugins/../..', manifestPath: 'SKILL.md' }), undefined)
      // A valid manifest elsewhere in the archive does not satisfy a scoped manifest.
      const withManifest = new Map([...files, ['plugins/other/bundle.json', Buffer.from('{}')]])
      assert.equal(gitArchivePayloadDigest(gzipSync(makeTar(withManifest)), { payloadPath: 'plugins/nsolid-plugin', manifestPath: 'bundle.json' }), undefined)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

function makeTar (files: Map<string, Buffer>): Buffer {
  const output: Buffer[] = []
  for (const [relative, content] of files) {
    const header = Buffer.alloc(512)
    header.write(`repository-commit/${relative}`, 0, 100, 'utf8')
    writeOctal(header, 100, 8, 0o644)
    writeOctal(header, 108, 8, 0)
    writeOctal(header, 116, 8, 0)
    writeOctal(header, 124, 12, content.length)
    writeOctal(header, 136, 12, 0)
    header.fill(0x20, 148, 156)
    header[156] = '0'.charCodeAt(0)
    header.write('ustar\0', 257, 6, 'ascii')
    header.write('00', 263, 2, 'ascii')
    const checksum = header.reduce((sum, byte) => sum + byte, 0)
    const checksumText = checksum.toString(8).padStart(6, '0')
    header.write(checksumText, 148, 6, 'ascii')
    header[154] = 0
    header[155] = 0x20
    output.push(header, content, Buffer.alloc((512 - (content.length % 512)) % 512))
  }
  output.push(Buffer.alloc(1024))
  return Buffer.concat(output)
}

function writeOctal (target: Buffer, offset: number, length: number, value: number): void {
  const encoded = value.toString(8).padStart(length - 1, '0') + '\0'
  target.write(encoded, offset, length, 'ascii')
}
