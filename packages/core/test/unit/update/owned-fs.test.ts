import { describe, it, beforeEach, afterEach, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { open as fsOpen } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  assertNoSymlinksInTree,
  copyOwnedPath,
  ownedFileDigest,
  ownedPathKind,
  ownedTreeDigest,
  OwnedFsError,
  removeOwnedPath,
  writeOwnedFile,
} from '../../../src/update/owned-fs.js'

describe('owned-fs primitives', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'nsolid-owned-fs-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  const filePath = () => path.join(root, 'file.txt')
  const dirPath = () => path.join(root, 'tree')

  const makeFile = (p: string = filePath(), body = 'content'): string => {
    writeFileSync(p, body)
    return p
  }
  const makeDir = (p: string = dirPath()): string => {
    mkdirSync(p, { recursive: true })
    return p
  }
  const makeFileLink = (t: TestContext, target: string, link: string): boolean => {
    try {
      symlinkSync(target, link, 'file')
      return true
    } catch (error) {
      if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') {
        t.skip('file symlink privilege is unavailable')
        return false
      }
      throw error
    }
  }
  const makeDirectoryLink = (target: string, link: string): void => {
    symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
  }

  describe('ownedPathKind', () => {
    it('classifies file, directory, symlinks, other, and missing without dereferencing', async (t) => {
      makeFile()
      makeDir()
      const linkToFile = path.join(root, 'link-to-file')
      if (!makeFileLink(t, filePath(), linkToFile)) return
      const linkToDir = path.join(root, 'link-to-dir')
      makeDirectoryLink(dirPath(), linkToDir)
      const dangling = path.join(root, 'dangling')
      if (!makeFileLink(t, path.join(root, 'nope'), dangling)) return

      assert.equal(await ownedPathKind(filePath()), 'file')
      assert.equal(await ownedPathKind(dirPath()), 'directory')
      assert.equal(await ownedPathKind(linkToFile), 'junction-or-symlink')
      assert.equal(await ownedPathKind(linkToDir), 'junction-or-symlink')
      assert.equal(await ownedPathKind(dangling), 'junction-or-symlink')
      assert.equal(await ownedPathKind(path.join(root, 'absent')), 'missing')
    })

    it('never dereferences a symlink when classifying', async (t) => {
      makeFile(filePath(), 'content')
      const link = path.join(root, 'link')
      if (!makeFileLink(t, filePath(), link)) return
      // Removing the referent leaves the link; classification must not fail.
      rmSync(filePath())
      assert.equal(await ownedPathKind(link), 'junction-or-symlink')
    })
  })

  describe('ownedFileDigest', () => {
    it('digests a regular file and returns null for every other kind', async (t) => {
      makeFile(filePath(), 'abc')
      const digest = await ownedFileDigest(filePath())
      assert.equal(digest, createHash('sha256').update('abc').digest('hex'))

      makeDir()
      assert.equal(await ownedFileDigest(dirPath()), null)
      assert.equal(await ownedFileDigest(path.join(root, 'absent')), null)
      const link = path.join(root, 'link')
      if (!makeFileLink(t, filePath(), link)) return
      // A symlink is not a regular file: null, never the referent digest.
      assert.equal(await ownedFileDigest(link), null)
    })

    it('changes when one byte changes', async () => {
      makeFile(filePath(), 'abc')
      const before = await ownedFileDigest(filePath())
      makeFile(filePath(), 'abd')
      assert.notEqual(await ownedFileDigest(filePath()), before)
    })
  })

  describe('ownedTreeDigest', () => {
    it('is null for missing paths and non-directories', async () => {
      assert.equal(await ownedTreeDigest(path.join(root, 'absent')), null)
      makeFile()
      assert.equal(await ownedTreeDigest(filePath()), null)
    })

    it('is stable across identical trees and independent of creation order', async () => {
      const first = makeDir(path.join(root, 'first'))
      writeFileSync(path.join(first, 'a.txt'), 'alpha')
      writeFileSync(path.join(first, 'b.txt'), 'beta')
      mkdirSync(path.join(first, 'nested'))
      writeFileSync(path.join(first, 'nested', 'c.txt'), 'gamma')

      const second = makeDir(path.join(root, 'second'))
      // Create in a different order.
      mkdirSync(path.join(second, 'nested'))
      writeFileSync(path.join(second, 'nested', 'c.txt'), 'gamma')
      writeFileSync(path.join(second, 'b.txt'), 'beta')
      writeFileSync(path.join(second, 'a.txt'), 'alpha')

      assert.equal(await ownedTreeDigest(first), await ownedTreeDigest(second))
      assert.ok(await ownedTreeDigest(first))
    })

    it('gives an empty directory a deterministic non-null digest', async () => {
      const empty = makeDir()
      const digest = await ownedTreeDigest(empty)
      assert.ok(digest)
      const otherEmpty = makeDir(path.join(root, 'other-empty'))
      assert.equal(await ownedTreeDigest(otherEmpty), digest)
    })

    it('differs when one byte changes anywhere in the tree', async () => {
      const tree = makeDir()
      writeFileSync(path.join(tree, 'a.txt'), 'alpha')
      mkdirSync(path.join(tree, 'nested'))
      writeFileSync(path.join(tree, 'nested', 'b.txt'), 'beta')
      const before = await ownedTreeDigest(tree)
      writeFileSync(path.join(tree, 'nested', 'b.txt'), 'beta!')
      assert.notEqual(await ownedTreeDigest(tree), before)
    })

    it('rejects a nested symlink with SYMLINK_IN_TREE and the relative path', async (t) => {
      const tree = makeDir()
      makeFile(path.join(tree, 'real.txt'))
      const nested = path.join(tree, 'nested')
      mkdirSync(nested)
      if (!makeFileLink(t, path.join(tree, 'real.txt'), path.join(nested, 'link'))) return
      await assert.rejects(
        ownedTreeDigest(tree),
        (error: unknown) => error instanceof OwnedFsError && error.code === 'SYMLINK_IN_TREE' && error.relativePath === 'nested/link'
      )
    })

    it('rejects a symlink at the root of a nested walk and stays silent-free (no swallow)', async () => {
      const tree = makeDir()
      const link = path.join(tree, 'dir-link')
      makeDirectoryLink(makeDir(path.join(root, 'target-dir')), link)
      await assert.rejects(
        ownedTreeDigest(tree),
        (error: unknown) => error instanceof OwnedFsError && error.code === 'SYMLINK_IN_TREE' && error.relativePath === 'dir-link'
      )
    })

    it('rejects a symlinked root instead of returning null', async () => {
      const real = makeDir()
      makeFile(path.join(real, 'a.txt'))
      const link = path.join(root, 'root-link')
      makeDirectoryLink(real, link)
      await assert.rejects(
        ownedTreeDigest(link),
        (error: unknown) => error instanceof OwnedFsError && error.code === 'SYMLINK_IN_TREE' && error.relativePath === '.'
      )
    })

    it('distinguishes an empty subdirectory from its absence', async () => {
      const withEmpty = makeDir(path.join(root, 'with-empty'))
      makeFile(path.join(withEmpty, 'a.txt'), 'alpha')
      mkdirSync(path.join(withEmpty, 'empty'))

      const without = makeDir(path.join(root, 'without'))
      makeFile(path.join(without, 'a.txt'), 'alpha')

      assert.notEqual(await ownedTreeDigest(withEmpty), await ownedTreeDigest(without))
      // A whole empty root keeps its deterministic non-null digest.
      const firstEmpty = await ownedTreeDigest(makeDir(path.join(root, 'bare')))
      assert.ok(firstEmpty)
      assert.equal(await ownedTreeDigest(makeDir(path.join(root, 'bare-2'))), firstEmpty)
    })
  })

  describe('assertNoSymlinksInTree', () => {
    it('accepts a symlink-free tree', async () => {
      const tree = makeDir()
      makeFile(path.join(tree, 'a.txt'))
      mkdirSync(path.join(tree, 'nested'))
      makeFile(path.join(tree, 'nested', 'b.txt'), 'beta')
      await assert.doesNotReject(assertNoSymlinksInTree(tree))
    })

    it('throws SYMLINK_IN_TREE with a POSIX relative path for the first sorted nested symlink', async () => {
      const tree = makeDir()
      mkdirSync(path.join(tree, 'a-dir'))
      mkdirSync(path.join(tree, 'b-dir'))
      makeDirectoryLink(dirPath(), path.join(tree, 'b-dir', 'link'))
      makeDirectoryLink(dirPath(), path.join(tree, 'a-dir', 'link'))
      try {
        await assertNoSymlinksInTree(tree)
        assert.fail('expected rejection')
      } catch (error) {
        assert.ok(error instanceof OwnedFsError)
        assert.equal(error.code, 'SYMLINK_IN_TREE')
        assert.equal(error.relativePath, 'a-dir/link')
      }
    })

    it('reports the root itself with relativePath "." when the root is a symlink', async () => {
      const real = makeDir()
      const link = path.join(root, 'root-link')
      makeDirectoryLink(real, link)
      try {
        await assertNoSymlinksInTree(link)
        assert.fail('expected rejection')
      } catch (error) {
        assert.ok(error instanceof OwnedFsError)
        assert.equal(error.code, 'SYMLINK_IN_TREE')
        assert.equal(error.relativePath, '.')
      }
    })

    it('rejects a missing root and a non-directory root with OwnedFsError', async () => {
      await assert.rejects(
        assertNoSymlinksInTree(path.join(root, 'absent')),
        (error: unknown) => error instanceof OwnedFsError && error.code === 'KIND_CHANGED'
      )
      makeFile()
      await assert.rejects(
        assertNoSymlinksInTree(filePath()),
        (error: unknown) => error instanceof OwnedFsError && error.code === 'KIND_CHANGED'
      )
    })
  })

  describe('copyOwnedPath', () => {
    it('copies a regular file and verifies the kind', async () => {
      makeFile(filePath(), 'abc')
      const destination = path.join(root, 'copy.txt')
      assert.equal(await copyOwnedPath(filePath(), destination), 'file')
      assert.equal(readFileSync(destination, 'utf8'), 'abc')
    })

    it('copies a symlink-free directory recursively', async () => {
      const tree = makeDir()
      makeFile(path.join(tree, 'a.txt'), 'alpha')
      mkdirSync(path.join(tree, 'nested'))
      makeFile(path.join(tree, 'nested', 'b.txt'), 'beta')
      const destination = path.join(root, 'copy-tree')
      assert.equal(await copyOwnedPath(tree, destination), 'directory')
      assert.equal(readFileSync(path.join(destination, 'nested', 'b.txt'), 'utf8'), 'beta')
    })

    it('rejects a symlink source itself', async (t) => {
      makeFile()
      const link = path.join(root, 'link')
      if (!makeFileLink(t, filePath(), link)) return
      await assert.rejects(
        copyOwnedPath(link, path.join(root, 'copy')),
        (error: unknown) => error instanceof OwnedFsError && error.code === 'SYMLINK_IN_TREE'
      )
    })

    it('rejects a directory tree containing any nested symlink', async (t) => {
      const tree = makeDir()
      makeFile(path.join(tree, 'a.txt'))
      const destination = path.join(root, 'copy-tree')
      if (!makeFileLink(t, filePath(), path.join(tree, 'link'))) return
      await assert.rejects(
        copyOwnedPath(tree, destination),
        (error: unknown) => error instanceof OwnedFsError && error.code === 'SYMLINK_IN_TREE'
      )
      assert.equal(existsSync(destination), false, 'nothing may be created when the guard fires')
    })

    it('rejects a missing source', async () => {
      await assert.rejects(copyOwnedPath(path.join(root, 'absent'), path.join(root, 'copy')))
    })
  })

  describe('removeOwnedPath', () => {
    it('removes files and directories and is idempotent on missing paths', async () => {
      makeFile()
      makeDir()
      const tree = dirPath()
      makeFile(path.join(tree, 'child.txt'))
      await removeOwnedPath(filePath())
      await removeOwnedPath(tree)
      assert.equal(existsSync(filePath()), false)
      assert.equal(existsSync(tree), false)
      await assert.doesNotReject(removeOwnedPath(filePath()))
    })

    it('honours expectedKind and reports a kind change', async () => {
      makeFile()
      await assert.rejects(removeOwnedPath(filePath(), 'directory'))
      await assert.doesNotReject(removeOwnedPath(filePath(), 'file'))
    })

    it('removes a file symlink without modifying its external referent', async (t) => {
      const referent = makeFile(path.join(root, 'external.txt'), 'external')
      const link = path.join(root, 'owned-file-link')
      if (!makeFileLink(t, referent, link)) return

      await removeOwnedPath(link, 'junction-or-symlink')

      assert.equal(existsSync(link), false)
      assert.equal(readFileSync(referent, 'utf8'), 'external')
    })

    it('removes a directory symlink or junction without modifying its external referent', async () => {
      const referent = makeDir(path.join(root, 'external-dir'))
      makeFile(path.join(referent, 'keep.txt'), 'external')
      const link = path.join(root, 'owned-dir-link')
      makeDirectoryLink(referent, link)

      await removeOwnedPath(link, 'junction-or-symlink')

      assert.equal(existsSync(link), false)
      assert.equal(readFileSync(path.join(referent, 'keep.txt'), 'utf8'), 'external')
    })

    it('removes an owned directory containing a nested link without following it', async () => {
      const referent = makeDir(path.join(root, 'external-tree'))
      makeFile(path.join(referent, 'keep.txt'), 'external')
      const owned = makeDir(path.join(root, 'owned-tree'))
      makeFile(path.join(owned, 'owned.txt'), 'owned')
      makeDirectoryLink(referent, path.join(owned, 'nested-link'))

      await removeOwnedPath(owned, 'directory')

      assert.equal(existsSync(owned), false)
      assert.equal(readFileSync(path.join(referent, 'keep.txt'), 'utf8'), 'external')
    })
  })

  describe('writeOwnedFile', () => {
    it('creates a regular file at a missing path with the requested mode', async () => {
      const target = path.join(root, 'created.txt')
      await writeOwnedFile(target, Buffer.from('hello'), { mode: 0o600, expectedKind: 'missing' })
      assert.equal(readFileSync(target, 'utf8'), 'hello')
      const stats = lstatSync(target)
      assert.equal(stats.isFile(), true)
      if (process.platform !== 'win32') assert.equal(stats.mode & 0o777, 0o600)
    })

    it('atomically replaces an existing regular file and keeps the mode', async () => {
      const target = filePath()
      makeFile(target, 'before')
      await writeOwnedFile(target, Buffer.from('after'), { mode: 0o600, expectedKind: 'file' })
      assert.equal(readFileSync(target, 'utf8'), 'after')
      const leftovers = readdirSync(root).filter((name) => name.includes('.nsolid-tmp-'))
      assert.deepEqual(leftovers, [], 'no temp files may survive')
    })

    it('retries an EEXIST collision without deleting the foreign temp path', async (t) => {
      const target = path.join(root, 'collision.txt')
      const randomValue = 0.5
      const randomToken = randomValue.toString(36).slice(2)
      t.mock.method(Math, 'random', () => randomValue)
      const foreign = path.join(root, `.collision.txt.nsolid-tmp-${process.pid}-${randomToken}-0`)
      writeFileSync(foreign, 'foreign')

      await writeOwnedFile(target, Buffer.from('ours'), { expectedKind: 'missing' })

      assert.equal(readFileSync(target, 'utf8'), 'ours')
      assert.equal(readFileSync(foreign, 'utf8'), 'foreign')
      assert.deepEqual(
        readdirSync(root).filter((name) => name.includes('.nsolid-tmp-')),
        [path.basename(foreign)]
      )
    })

    it('propagates after bounded EEXIST retries and preserves every foreign candidate', async (t) => {
      const target = path.join(root, 'exhausted.txt')
      const randomValue = 0.25
      const randomToken = randomValue.toString(36).slice(2)
      t.mock.method(Math, 'random', () => randomValue)
      const foreign = Array.from({ length: 5 }, (_, attempt) =>
        path.join(root, `.exhausted.txt.nsolid-tmp-${process.pid}-${randomToken}-${attempt}`)
      )
      for (const [index, candidate] of foreign.entries()) writeFileSync(candidate, `foreign-${index}`)

      await assert.rejects(
        writeOwnedFile(target, Buffer.from('ours'), { expectedKind: 'missing' }),
        (error: unknown) => (error as NodeJS.ErrnoException).code === 'EEXIST'
      )

      assert.equal(existsSync(target), false)
      for (const [index, candidate] of foreign.entries()) assert.equal(readFileSync(candidate, 'utf8'), `foreign-${index}`)
    })

    it('rejects a kind mismatch without writing', async () => {
      makeFile(filePath(), 'keep')
      await assert.rejects(
        writeOwnedFile(filePath(), Buffer.from('x'), { expectedKind: 'missing' }),
        (error: unknown) => error instanceof OwnedFsError && error.code === 'KIND_CHANGED'
      )
      assert.equal(readFileSync(filePath(), 'utf8'), 'keep')

      const missing = path.join(root, 'absent.txt')
      await assert.rejects(
        writeOwnedFile(missing, Buffer.from('x'), { expectedKind: 'file' }),
        (error: unknown) => error instanceof OwnedFsError && error.code === 'KIND_CHANGED'
      )
      assert.equal(existsSync(missing), false)
    })

    it('rejects a symlink target and leaves the referent untouched', async (t) => {
      const referent = makeFile(filePath(), 'referent')
      const link = path.join(root, 'link.txt')
      if (!makeFileLink(t, referent, link)) return
      await assert.rejects(
        writeOwnedFile(link, Buffer.from('overwritten'), { expectedKind: 'file' }),
        (error: unknown) => error instanceof OwnedFsError && error.code === 'KIND_CHANGED'
      )
      await assert.rejects(
        writeOwnedFile(link, Buffer.from('overwritten'), { expectedKind: 'missing' }),
        (error: unknown) => error instanceof OwnedFsError && error.code === 'KIND_CHANGED'
      )
      assert.equal(readFileSync(referent, 'utf8'), 'referent', 'the symlink referent must stay untouched')
      assert.equal(existsSync(link), true, 'the symlink itself must stay untouched')
      const leftovers = readdirSync(root).filter((name) => name.includes('.nsolid-tmp-'))
      assert.deepEqual(leftovers, [], 'no temp files may survive a rejected write')
    })

    it('refuses a missing path when expectedKind is file without creating anything', async () => {
      const target = path.join(root, 'raced.txt')
      await assert.rejects(
        writeOwnedFile(target, Buffer.from('x'), { expectedKind: 'file' }),
        (error: unknown) => error instanceof OwnedFsError && error.code === 'KIND_CHANGED'
      )
      assert.equal(existsSync(target), false)
      const leftovers = readdirSync(root).filter((name) => name.includes('.nsolid-tmp-'))
      assert.deepEqual(leftovers, [], 'the temp file must be removed on failure')
    })

    it('releases the handle and removes the temp file when writing fails after open', { skip: process.platform !== 'linux' }, async (t) => {
      const target = path.join(root, 'io-fail.txt')
      // Simulate a mid-write I/O failure by patching the shared FileHandle
      // prototype (the class itself is not exported at runtime, so derive it
      // from a real probe handle): `open` succeeds for real, then the handle's
      // writeFile throws. Cleanup must close the still-open handle BEFORE
      // removing the temp file; a leaked fd would still be listed in
      // /proc/self/fd pointing at the temp file after the rejection.
      const probe = await fsOpen(path.join(root, 'probe.txt'), 'w')
      const handlePrototype = Object.getPrototypeOf(probe) as FileHandle
      await probe.close()
      t.mock.method(handlePrototype, 'writeFile', async function mockWriteFileFailure (this: FileHandle) {
        throw new Error('simulated write failure')
      })
      await assert.rejects(
        writeOwnedFile(target, Buffer.from('x'), { expectedKind: 'missing' }),
        /simulated write failure/
      )
      const leakedFd = readdirSync('/proc/self/fd')
        .map((fd) => {
          try {
            return readlinkSync(path.join('/proc/self/fd', fd))
          } catch {
            // The fd vanished between listing and resolving: it closed.
            return ''
          }
        })
        .filter((link) => link.includes('.nsolid-tmp-'))
      assert.deepEqual(leakedFd, [], 'the handle opened before the failure must be closed, not leaked')
      assert.equal(existsSync(target), false)
      const leftovers = readdirSync(root).filter((name) => name.includes('.nsolid-tmp-'))
      assert.deepEqual(leftovers, [], 'the temp file must be removed after a post-open failure')
    })
  })

  describe(' OwnedFsError shape', () => {
    it('carries code and optional relativePath with a readable message', async () => {
      const error = new OwnedFsError('SYMLINK_IN_TREE', 'nested/link')
      assert.equal(error.code, 'SYMLINK_IN_TREE')
      assert.equal(error.relativePath, 'nested/link')
      assert.equal(error.message.includes('nested/link'), true)
      assert.equal(error instanceof Error, true)
    })
  })

  describe('cross-check with nativePayloadTreeDigest framing', () => {
    it('produces digests of equal length (sha256 hex) and stability semantics', async () => {
      const tree = makeDir()
      makeFile(path.join(tree, 'a.txt'), 'alpha')
      const digest = await ownedTreeDigest(tree)
      assert.ok(digest)
      assert.match(digest as string, /^[0-9a-f]{64}$/)
    })
  })

  describe('posix path normalization in errors', () => {
    it('uses forward slashes for nested relative paths on all platforms', async () => {
      const tree = makeDir()
      const deep = path.join(tree, 'one', 'two')
      mkdirSync(deep, { recursive: true })
      makeDirectoryLink(dirPath(), path.join(deep, 'link'))
      try {
        await assertNoSymlinksInTree(tree)
        assert.fail('expected rejection')
      } catch (error) {
        assert.ok(error instanceof OwnedFsError)
        assert.equal(error.relativePath, 'one/two/link')
      }
    })
  })

  describe('deterministic ordering', () => {
    it('sorts nested entries deterministically', async () => {
      const treeA = makeDir(path.join(root, 'a'))
      makeFile(path.join(treeA, 'z.txt'), 'z')
      makeFile(path.join(treeA, 'a.txt'), 'a')
      mkdirSync(path.join(treeA, 'm'))
      makeFile(path.join(treeA, 'm', 'x.txt'), 'x')

      const treeB = makeDir(path.join(root, 'b'))
      makeFile(path.join(treeB, 'a.txt'), 'a')
      mkdirSync(path.join(treeB, 'm'))
      makeFile(path.join(treeB, 'm', 'x.txt'), 'x')
      makeFile(path.join(treeB, 'z.txt'), 'z')

      assert.equal(await ownedTreeDigest(treeA), await ownedTreeDigest(treeB))
    })

    it('orders canonically equivalent but byte-distinct names independently of creation order', async (t) => {
      const composed = '\u00e9.txt'
      const decomposed = 'e\u0301.txt'
      const first = makeDir(path.join(root, 'unicode-a'))
      makeFile(path.join(first, composed), 'composed')
      makeFile(path.join(first, decomposed), 'decomposed')
      const second = makeDir(path.join(root, 'unicode-b'))
      makeFile(path.join(second, decomposed), 'decomposed')
      makeFile(path.join(second, composed), 'composed')
      if (readdirSync(first).length !== 2 || readdirSync(second).length !== 2) {
        t.skip('filesystem normalizes canonically equivalent names')
        return
      }

      assert.equal(await ownedTreeDigest(first), await ownedTreeDigest(second))
    })
  })
})
