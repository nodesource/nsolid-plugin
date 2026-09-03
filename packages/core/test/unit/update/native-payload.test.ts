import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import { gitArchivePayloadDigest, isWindowsDeviceNamespaceTarget, nativePayloadTreeDigest, plannedPayloadIdentityFromArchive, plannedPayloadIdentityFromTree } from '../../../src/update/native-payload.js'

const CODEX_PROFILE = 'codex-installed-v1' as const

function materializePayload (root: string, files: Map<string, Buffer>): void {
  for (const [relative, content] of files) {
    const target = path.join(root, relative)
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, content)
  }
}

function cleanPayloadFiles (): Map<string, Buffer> {
  return new Map([
    ['bundle.json', Buffer.from('{"name":"nsolid-plugin","version":"1.0.2","skills":[]}')],
    ['skills/example/SKILL.md', Buffer.from('# example\n')],
  ])
}

describe('native payload identity', () => {
  // Golden digests for the FIXED fixture below, computed INDEPENDENTLY from
  // the code under test by reimplementing the documented canonical byte
  // layout (entries sorted by relative name; per entry: kind NUL name NUL
  // [file: byteLength NUL content | symlink: target] NUL) with a one-off
  // script using node:crypto only. Any shared canonicalization or mapping
  // bug in the digest APIs cannot keep these assertions green.
  //   bundle.json = '{"name":"nsolid-plugin","version":"1.0.2","skills":[]}'
  //   skills/example/SKILL.md = '# example\n'
  //   .codex-marketplace-install.json = '{"source":"marketplace"}\n' (variant)
  const GOLDEN_STRICT_CLEAN = '08b5781a7f8756f79abb4aed0aad420bdef38e76f15ccd6bb0fab0b37fef4c46'
  const GOLDEN_STRICT_WITH_METADATA = '7e70208218edf8277c2f2f039f22f0082aac8af8f7925e52f63f556779b4aaaa'

  it('matches independently computed golden digests for the strict and codex-installed-v1 identities', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'nsolid-native-golden-'))
    try {
      const files = cleanPayloadFiles()
      materializePayload(root, files)
      assert.equal(nativePayloadTreeDigest(root), GOLDEN_STRICT_CLEAN, 'strict tree digest must match the golden bytes')
      assert.equal(nativePayloadTreeDigest(root, { profile: CODEX_PROFILE }), GOLDEN_STRICT_CLEAN, 'a clean payload has no normalizable entries')
      assert.equal(gitArchivePayloadDigest(gzipSync(makeTar(files))), GOLDEN_STRICT_CLEAN, 'strict archive digest must match the same golden bytes')
      assert.equal(gitArchivePayloadDigest(gzipSync(makeTar(files)), {}, { profile: CODEX_PROFILE }), GOLDEN_STRICT_CLEAN)

      // Same payload plus the harness metadata file: strict differs, the
      // comparison identity still equals the clean golden (only the proven
      // harness entry is normalized).
      const withMetadata = new Map(files)
      withMetadata.set('.codex-marketplace-install.json', Buffer.from('{"source":"marketplace"}\n'))
      materializePayload(root, withMetadata)
      assert.equal(nativePayloadTreeDigest(root), GOLDEN_STRICT_WITH_METADATA, 'strict evidence must remain sensitive to every extra entry')
      assert.equal(nativePayloadTreeDigest(root, { profile: CODEX_PROFILE }), GOLDEN_STRICT_CLEAN, 'only the proven harness entry is normalized')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

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

  it('compares a clean Git-archive payload equal to the installed payload plus Codex harness metadata under the codex profile', () => {
    const clean = mkdtempSync(path.join(os.tmpdir(), 'nsolid-native-f4-clean-'))
    const installed = mkdtempSync(path.join(os.tmpdir(), 'nsolid-native-f4-installed-'))
    try {
      materializePayload(clean, cleanPayloadFiles())
      materializePayload(installed, cleanPayloadFiles())
      // Exact proven harness metadata written by a real Codex marketplace install.
      writeFileSync(path.join(installed, '.codex-marketplace-install.json'), '{"source":"marketplace"}\n')
      const archive = gzipSync(makeTar(cleanPayloadFiles()))

      assert.equal(
        gitArchivePayloadDigest(archive, {}, { profile: CODEX_PROFILE }),
        nativePayloadTreeDigest(installed, { profile: CODEX_PROFILE })
      )
    } finally {
      rmSync(clean, { recursive: true, force: true })
      rmSync(installed, { recursive: true, force: true })
    }
  })

  it('keeps strict source evidence distinct from the normalized comparison digest', () => {
    const clean = mkdtempSync(path.join(os.tmpdir(), 'nsolid-native-f4-strict-clean-'))
    const installed = mkdtempSync(path.join(os.tmpdir(), 'nsolid-native-f4-strict-installed-'))
    try {
      materializePayload(clean, cleanPayloadFiles())
      materializePayload(installed, cleanPayloadFiles())
      writeFileSync(path.join(installed, '.codex-marketplace-install.json'), '{"source":"marketplace"}\n')

      // Strict evidence: harness metadata is significant.
      const strictClean = nativePayloadTreeDigest(clean)
      const strictInstalled = nativePayloadTreeDigest(installed)
      assert.ok(strictClean && strictInstalled)
      assert.notEqual(strictInstalled, strictClean)

      // Normalized comparison: harness metadata is ignored.
      const profileClean = nativePayloadTreeDigest(clean, { profile: CODEX_PROFILE })
      const profileInstalled = nativePayloadTreeDigest(installed, { profile: CODEX_PROFILE })
      assert.ok(profileClean && profileInstalled)
      assert.equal(profileInstalled, profileClean)

      // The two identities remain distinct values on the same bytes.
      assert.notEqual(profileInstalled, strictInstalled)
    } finally {
      rmSync(clean, { recursive: true, force: true })
      rmSync(installed, { recursive: true, force: true })
    }
  })

  it('keeps nested .git and unapproved dotfiles significant under the codex profile', () => {
    const clean = mkdtempSync(path.join(os.tmpdir(), 'nsolid-native-f4-nested-'))
    try {
      materializePayload(clean, cleanPayloadFiles())
      const baseline = nativePayloadTreeDigest(clean, { profile: CODEX_PROFILE })
      assert.ok(baseline)

      const significant: [string, string][] = [
        ['.DS_Store', 'junk'],
        ['.gitignore', 'node_modules\n'],
        ['.gitattributes', '* text=auto\n'],
        ['.gitmodules', '[submodule "x"]\n'],
        ['nested/.git/HEAD', 'ref: refs/heads/main\n'],
        ['skills/.git/config', '[core]\n'],
        ['skills/example/extra.js', 'module.exports = 1\n'],
      ]
      for (const [relative, content] of significant) {
        const mutated = mkdtempSync(path.join(os.tmpdir(), 'nsolid-native-f4-mutated-'))
        try {
          materializePayload(mutated, cleanPayloadFiles())
          materializePayload(mutated, new Map([[relative, Buffer.from(content)]]))
          assert.notEqual(
            nativePayloadTreeDigest(mutated, { profile: CODEX_PROFILE }), baseline,
            `expected ${relative} to stay significant under the codex profile`
          )
        } finally {
          rmSync(mutated, { recursive: true, force: true })
        }
      }
    } finally {
      rmSync(clean, { recursive: true, force: true })
    }
  })

  it('rejects tampered payload bytes under the codex comparison profile', () => {
    const clean = mkdtempSync(path.join(os.tmpdir(), 'nsolid-native-f4-tamper-'))
    try {
      materializePayload(clean, cleanPayloadFiles())
      const baseline = nativePayloadTreeDigest(clean, { profile: CODEX_PROFILE })
      assert.ok(baseline)

      // A modified installable file changes the normalized digest.
      writeFileSync(path.join(clean, 'bundle.json'), '{"name":"nsolid-plugin","version":"9.9.9","skills":[]}')
      const tamperedManifest = nativePayloadTreeDigest(clean, { profile: CODEX_PROFILE })
      assert.ok(tamperedManifest)
      assert.notEqual(tamperedManifest, baseline)

      // Restoring the manifest but tampering the skill bytes also changes it.
      writeFileSync(path.join(clean, 'bundle.json'), '{"name":"nsolid-plugin","version":"1.0.2","skills":[]}')
      writeFileSync(path.join(clean, 'skills/example/SKILL.md'), '# substituted\n')
      const tamperedSkill = nativePayloadTreeDigest(clean, { profile: CODEX_PROFILE })
      assert.ok(tamperedSkill)
      assert.notEqual(tamperedSkill, baseline)
    } finally {
      rmSync(clean, { recursive: true, force: true })
    }
  })

  it('keeps root .git excluded and retains symlink identity under the codex profile', () => {
    const clean = mkdtempSync(path.join(os.tmpdir(), 'nsolid-native-f4-symlink-'))
    try {
      materializePayload(clean, cleanPayloadFiles())
      const baseline = nativePayloadTreeDigest(clean, { profile: CODEX_PROFILE })
      assert.ok(baseline)

      // Root .git stays excluded on the installed side, as today.
      mkdirSync(path.join(clean, '.git'))
      writeFileSync(path.join(clean, '.git', 'HEAD'), 'ref: refs/heads/main\n')
      assert.equal(nativePayloadTreeDigest(clean, { profile: CODEX_PROFILE }), baseline)

      // Symlink identity is retained: a new symlink changes the digest, and the
      // archive-side digest with the same symlink matches the installed side.
      rmSync(path.join(clean, '.git'), { recursive: true, force: true })
      symlinkSync('../shared/asset.bin', path.join(clean, 'skills/example/asset.bin'))
      const withSymlink = nativePayloadTreeDigest(clean, { profile: CODEX_PROFILE })
      assert.ok(withSymlink)
      assert.notEqual(withSymlink, baseline)

      const files = cleanPayloadFiles()
      files.set('skills/example/asset.bin', Buffer.from('../shared/asset.bin'))
      const archive = gzipSync(makeTarWithSymlink(cleanPayloadFiles(), 'skills/example/asset.bin', '../shared/asset.bin'))
      assert.equal(gitArchivePayloadDigest(archive, {}, { profile: CODEX_PROFILE }), withSymlink)
    } finally {
      rmSync(clean, { recursive: true, force: true })
    }
  })

  it('normalizes Windows symlink target separators without collapsing device-prefixed forms', { skip: process.platform !== 'win32' }, () => {
    const digestWithTarget = (target: string): string | undefined => {
      const root = mkdtempSync(path.join(os.tmpdir(), 'nsolid-native-win-target-'))
      try {
        materializePayload(root, cleanPayloadFiles())
        // Explicit 'file' type: an omitted type makes symlinkSync stat the
        // target to guess file-vs-dir, and a UNC target stat surfaces as
        // UNKNOWN instead of the tolerated ENOENT on Windows.
        symlinkSync(target, path.join(root, 'skills', 'example', 'asset.bin'), 'file')
        return nativePayloadTreeDigest(root)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }
    // Forward- and backslash-separated forms resolve identically on Windows.
    assert.equal(digestWithTarget('../shared/asset.bin'), digestWithTarget('..\\shared\\asset.bin'))
    // Same for absolute UNC paths outside the device namespace.
    assert.equal(digestWithTarget('\\\\server\\share\\asset.bin'), digestWithTarget('//server/share/asset.bin'))
    // Genuinely different destinations stay distinct. (Absolute device-namespace
    // spellings are intentionally not compared here: Windows readlink
    // canonicalizes absolute targets to NT form on read, so distinct spellings
    // of the same destination digest identically — which is correct. The
    // device-namespace classification itself is pinned by the cross-platform
    // unit test below.)
    assert.notEqual(digestWithTarget('C:\\payload\\asset.bin'), digestWithTarget('C:\\payload\\other.bin'))
  })

  it('classifies Windows device-namespace symlink targets for verbatim digesting (cross-platform)', () => {
    for (const device of ['\\\\?\\C:\\x', '//?/C:/x', '\\\\.\\COM1', '\\??\\C:\\x', '\\\\?\\UNC\\s\\s']) {
      assert.equal(isWindowsDeviceNamespaceTarget(device), true, device)
    }
    for (const ordinary of ['..\\a\\b', '../a/b', 'C:\\a\\b', '\\\\server\\share\\x', 'asset.bin']) {
      assert.equal(isWindowsDeviceNamespaceTarget(ordinary), false, ordinary)
    }
  })

  it('keeps reserved-name symlinks and directories significant on the installed side', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'nsolid-native-f4-reserved-kind-'))
    try {
      materializePayload(root, cleanPayloadFiles())
      const baseline = nativePayloadTreeDigest(root, { profile: CODEX_PROFILE })
      assert.ok(baseline)

      // A root regular file at the reserved name is the only normalized entry.
      writeFileSync(path.join(root, '.codex-marketplace-install.json'), '{"source":"marketplace"}\n')
      assert.equal(nativePayloadTreeDigest(root, { profile: CODEX_PROFILE }), baseline)

      // A symlink at the reserved name stays significant.
      rmSync(path.join(root, '.codex-marketplace-install.json'))
      symlinkSync('../../shared/meta.json', path.join(root, '.codex-marketplace-install.json'))
      const withSymlink = nativePayloadTreeDigest(root, { profile: CODEX_PROFILE })
      assert.ok(withSymlink)
      assert.notEqual(withSymlink, baseline)

      // A directory at the reserved name stays significant.
      rmSync(path.join(root, '.codex-marketplace-install.json'))
      mkdirSync(path.join(root, '.codex-marketplace-install.json'))
      writeFileSync(path.join(root, '.codex-marketplace-install.json', 'nested.txt'), 'payload-ish\n')
      const withDirectory = nativePayloadTreeDigest(root, { profile: CODEX_PROFILE })
      assert.ok(withDirectory)
      assert.notEqual(withDirectory, baseline)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps an empty reserved-name directory significant on the installed side', () => {
    const clean = mkdtempSync(path.join(os.tmpdir(), 'nsolid-native-f4-empty-dir-clean-'))
    const installed = mkdtempSync(path.join(os.tmpdir(), 'nsolid-native-f4-empty-dir-installed-'))
    try {
      materializePayload(clean, cleanPayloadFiles())
      materializePayload(installed, cleanPayloadFiles())
      mkdirSync(path.join(installed, '.codex-marketplace-install.json'))

      const cleanDigest = nativePayloadTreeDigest(clean, { profile: CODEX_PROFILE })
      const installedDigest = nativePayloadTreeDigest(installed, { profile: CODEX_PROFILE })
      assert.ok(cleanDigest && installedDigest)
      assert.notEqual(installedDigest, cleanDigest)
    } finally {
      rmSync(clean, { recursive: true, force: true })
      rmSync(installed, { recursive: true, force: true })
    }
  })

  it('fails closed when a planned tree contains only an empty reserved-name directory', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'nsolid-native-f4-empty-dir-plan-'))
    try {
      mkdirSync(path.join(root, '.codex-marketplace-install.json'))
      const identity = plannedPayloadIdentityFromTree(root, CODEX_PROFILE)
      assert.ok(identity.contentDigest)
      assert.equal(identity.comparisonDigest, undefined)
      assert.equal(identity.comparisonProfile, undefined)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('captures an empty reserved-name directory in Git archive identities', () => {
    const files = cleanPayloadFiles()
    const cleanArchive = gzipSync(makeTar(files))
    const reservedArchive = gzipSync(makeTarWithDirectory(files, '.codex-marketplace-install.json'))

    // Strict evidence records the reserved directory marker.
    assert.notEqual(gitArchivePayloadDigest(reservedArchive), gitArchivePayloadDigest(cleanArchive))
    // Plan-side normalization rejects the collision rather than hiding it.
    assert.equal(gitArchivePayloadDigest(reservedArchive, {}, { profile: CODEX_PROFILE }), undefined)
    const identity = plannedPayloadIdentityFromArchive(reservedArchive, {}, CODEX_PROFILE)
    assert.ok(identity.contentDigest)
    assert.equal(identity.comparisonDigest, undefined)
    assert.equal(identity.comparisonProfile, undefined)
  })

  it('does not record empty non-reserved root directories in strict identities', () => {
    const clean = mkdtempSync(path.join(os.tmpdir(), 'nsolid-native-non-reserved-clean-'))
    const withDirectory = mkdtempSync(path.join(os.tmpdir(), 'nsolid-native-non-reserved-dir-'))
    try {
      materializePayload(clean, cleanPayloadFiles())
      materializePayload(withDirectory, cleanPayloadFiles())
      mkdirSync(path.join(withDirectory, 'empty-directory'))
      assert.equal(nativePayloadTreeDigest(withDirectory), nativePayloadTreeDigest(clean))

      const cleanArchive = gzipSync(makeTar(cleanPayloadFiles()))
      const directoryArchive = gzipSync(makeTarWithDirectory(cleanPayloadFiles(), 'empty-directory'))
      assert.equal(gitArchivePayloadDigest(directoryArchive), gitArchivePayloadDigest(cleanArchive))
    } finally {
      rmSync(clean, { recursive: true, force: true })
      rmSync(withDirectory, { recursive: true, force: true })
    }
  })

  it('fails closed on the planning side when the planned source already contains reserved harness paths', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'nsolid-native-f4-reserved-plan-'))
    try {
      // Archive with a root regular file at the reserved name: no comparison digest.
      const withReserved = new Map([...cleanPayloadFiles(), ['.codex-marketplace-install.json', Buffer.from('{"source":"marketplace"}\n')]])
      const reservedArchive = gzipSync(makeTar(withReserved))
      assert.equal(gitArchivePayloadDigest(reservedArchive, {}, { profile: CODEX_PROFILE }), undefined)
      // The strict digest of the same planned archive stays defined and significant.
      assert.ok(gitArchivePayloadDigest(reservedArchive))

      // Content nested under a reserved directory name: also fail closed.
      const nestedReserved = new Map([...cleanPayloadFiles(), ['.codex-marketplace-install.json/extra.txt', Buffer.from('payload\n')]])
      assert.equal(gitArchivePayloadDigest(gzipSync(makeTar(nestedReserved)), {}, { profile: CODEX_PROFILE }), undefined)

      // A symlink at the reserved name in the planned archive: fail closed too.
      const symlinkArchive = gzipSync(makeTarWithSymlink(cleanPayloadFiles(), '.codex-marketplace-install.json', '../shared/meta'))
      assert.equal(gitArchivePayloadDigest(symlinkArchive, {}, { profile: CODEX_PROFILE }), undefined)

      // Same policy for planned local snapshots via the identity helpers.
      materializePayload(root, cleanPayloadFiles())
      writeFileSync(path.join(root, '.codex-marketplace-install.json'), '{"source":"marketplace"}\n')
      const identity = plannedPayloadIdentityFromTree(root, CODEX_PROFILE)
      assert.ok(identity.contentDigest)
      assert.equal(identity.comparisonDigest, undefined)
      assert.equal(identity.comparisonProfile, undefined)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects unknown normalization profiles instead of silently digesting strict', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'nsolid-native-f4-unknown-profile-'))
    try {
      materializePayload(root, cleanPayloadFiles())
      writeFileSync(path.join(root, '.codex-marketplace-install.json'), '{"source":"marketplace"}\n')
      const unknownProfile = 'codex-installed-v2-future' as never
      assert.equal(nativePayloadTreeDigest(root, { profile: unknownProfile }), undefined)
      assert.equal(gitArchivePayloadDigest(gzipSync(makeTar(cleanPayloadFiles())), {}, { profile: unknownProfile }), undefined)
      assert.deepEqual(plannedPayloadIdentityFromTree(root, unknownProfile), {})
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('derives planned strict and comparison identities from one payload capture', () => {
    const clean = mkdtempSync(path.join(os.tmpdir(), 'nsolid-native-f4-identity-clean-'))
    const installed = mkdtempSync(path.join(os.tmpdir(), 'nsolid-native-f4-identity-installed-'))
    try {
      materializePayload(clean, cleanPayloadFiles())
      materializePayload(installed, cleanPayloadFiles())
      writeFileSync(path.join(installed, '.codex-marketplace-install.json'), '{"source":"marketplace"}\n')
      const archive = gzipSync(makeTar(cleanPayloadFiles()))

      const treeIdentity = plannedPayloadIdentityFromTree(clean, CODEX_PROFILE)
      assert.equal(treeIdentity.comparisonProfile, CODEX_PROFILE)
      assert.equal(treeIdentity.contentDigest, nativePayloadTreeDigest(clean))
      // The comparison identity of the clean plan equals the installed-side
      // digest of a faithful install carrying only the harness metadata file.
      assert.equal(treeIdentity.comparisonDigest, nativePayloadTreeDigest(installed, { profile: CODEX_PROFILE }))

      const archiveIdentity = plannedPayloadIdentityFromArchive(archive, {}, CODEX_PROFILE)
      assert.equal(archiveIdentity.comparisonProfile, CODEX_PROFILE)
      assert.equal(archiveIdentity.contentDigest, gitArchivePayloadDigest(archive))
      // Both planning media produce the same identities for the same bytes.
      assert.equal(archiveIdentity.comparisonDigest, treeIdentity.comparisonDigest)
      assert.equal(archiveIdentity.contentDigest, treeIdentity.contentDigest)
    } finally {
      rmSync(clean, { recursive: true, force: true })
      rmSync(installed, { recursive: true, force: true })
    }
  })

  it('keeps default tree digest behavior strict when no profile is requested', () => {
    const clean = mkdtempSync(path.join(os.tmpdir(), 'nsolid-native-f4-default-'))
    const installed = mkdtempSync(path.join(os.tmpdir(), 'nsolid-native-f4-default-installed-'))
    try {
      materializePayload(clean, cleanPayloadFiles())
      materializePayload(installed, cleanPayloadFiles())
      writeFileSync(path.join(installed, '.codex-marketplace-install.json'), '{"source":"marketplace"}\n')

      // Without a profile the harness metadata stays significant.
      assert.notEqual(nativePayloadTreeDigest(installed), nativePayloadTreeDigest(clean))
      // And the archive-side digest remains strict by default too.
      const archiveWithMetadata = gzipSync(makeTar(new Map([
        ...cleanPayloadFiles(),
        ['.codex-marketplace-install.json', Buffer.from('{"source":"marketplace"}\n')],
      ])))
      assert.notEqual(gitArchivePayloadDigest(archiveWithMetadata), nativePayloadTreeDigest(clean))
    } finally {
      rmSync(clean, { recursive: true, force: true })
      rmSync(installed, { recursive: true, force: true })
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

/** Tar combining regular files with one empty directory entry (GNU type '5'). */
function makeTarWithDirectory (files: Map<string, Buffer>, directoryPath: string): Buffer {
  const regularTar = makeTar(files)
  const directoryHeader = Buffer.alloc(512)
  directoryHeader.write(`repository-commit/${directoryPath.replace(/\/$/, '')}/`, 0, 100, 'utf8')
  writeOctal(directoryHeader, 100, 8, 0o755)
  writeOctal(directoryHeader, 108, 8, 0)
  writeOctal(directoryHeader, 116, 8, 0)
  writeOctal(directoryHeader, 124, 12, 0)
  writeOctal(directoryHeader, 136, 12, 0)
  directoryHeader.fill(0x20, 148, 156)
  directoryHeader[156] = '5'.charCodeAt(0)
  directoryHeader.write('ustar\0', 257, 6, 'ascii')
  directoryHeader.write('00', 263, 2, 'ascii')
  const checksum = directoryHeader.reduce((sum, byte) => sum + byte, 0)
  directoryHeader.write(checksum.toString(8).padStart(6, '0'), 148, 6, 'ascii')
  directoryHeader[154] = 0
  directoryHeader[155] = 0x20
  // Replace the regular tar's two terminating zero blocks with the directory
  // header followed by a fresh terminator.
  return Buffer.concat([regularTar.subarray(0, regularTar.length - 1024), directoryHeader, Buffer.alloc(1024)])
}

/** Tar combining regular files with one symlink entry (GNU type '2'). */
function makeTarWithSymlink (files: Map<string, Buffer>, symlinkPath: string, symlinkTarget: string): Buffer {
  const entries: Buffer[] = []
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
    entries.push(header, content, Buffer.alloc((512 - (content.length % 512)) % 512))
  }
  const linkHeader = Buffer.alloc(512)
  linkHeader.write(`repository-commit/${symlinkPath}`, 0, 100, 'utf8')
  writeOctal(linkHeader, 100, 8, 0o777)
  writeOctal(linkHeader, 108, 8, 0)
  writeOctal(linkHeader, 116, 8, 0)
  writeOctal(linkHeader, 124, 12, symlinkTarget.length)
  writeOctal(linkHeader, 136, 12, 0)
  linkHeader.fill(0x20, 148, 156)
  linkHeader[156] = '2'.charCodeAt(0)
  linkHeader.write('ustar\0', 257, 6, 'ascii')
  linkHeader.write('00', 263, 2, 'ascii')
  linkHeader.write(symlinkTarget, 157, 100, 'utf8')
  const checksum = linkHeader.reduce((sum, byte) => sum + byte, 0)
  linkHeader.write(checksum.toString(8).padStart(6, '0'), 148, 6, 'ascii')
  linkHeader[154] = 0
  linkHeader[155] = 0x20
  entries.push(linkHeader, Buffer.alloc(1024))
  return Buffer.concat(entries)
}
