import { readFile } from 'node:fs/promises'
import { gunzipSync } from 'node:zlib'

/** npm registry tarballs stay far below this bound; it caps both the compressed file and its decompressed output. */
const MAX_TARBALL_BYTES = 64 * 1024 * 1024
/** bundle.json is a small descriptor; a larger entry is treated as malformed input. */
const MAX_ENTRY_BYTES = 1 << 20
const HEADER_SIZE = 512

function isGzip (bytes: Buffer): boolean {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b
}

function headerEntryName (header: Buffer): string {
  const nameField = header.subarray(0, 100)
  const end = nameField.indexOf(0)
  return (end >= 0 ? nameField.subarray(0, end) : nameField).toString('utf8')
}

function entrySize (header: Buffer): number {
  const sizeField = header.subarray(124, 136).toString('ascii').replace(/[\0 ]+$/, '').trim()
  if (!/^[0-7]*$/.test(sizeField)) return NaN
  return parseInt(sizeField, 8)
}

/**
 * Extract one file entry from a POSIX tar archive (gzip-compressed or plain),
 * entirely in-process. Reading a planned tarball must never depend on a
 * PATH-resolved binary: this replaces the former `execFile('tar', ...)`
 * summary path, which executed whatever `tar` the environment offered, with
 * no timeout and no executable identity. Any unreadable, malformed,
 * truncated, or oversized input yields undefined — callers treat the
 * extraction as best-effort.
 */
export async function readTarEntryText (tarballPath: string, entryName: string): Promise<string | undefined> {
  try {
    const raw = await readFile(tarballPath)
    if (raw.length === 0 || raw.length > MAX_TARBALL_BYTES) return undefined
    // Bound the decompressed output too: the file-size check above only
    // limits the compressed bytes, and a hostile artifact can expand far
    // beyond it. zlib throws RangeError past the limit; the outer catch
    // turns that into the documented best-effort undefined.
    const bytes = isGzip(raw) ? gunzipSync(raw, { maxOutputLength: MAX_TARBALL_BYTES }) : raw
    let offset = 0
    while (offset + HEADER_SIZE <= bytes.length) {
      const header = bytes.subarray(offset, offset + HEADER_SIZE)
      if (header.every((byte) => byte === 0)) return undefined
      const size = entrySize(header)
      const type = String.fromCharCode(header[156])
      offset += HEADER_SIZE
      if (!Number.isInteger(size) || size < 0) return undefined
      const body = bytes.subarray(offset, offset + size)
      offset += Math.ceil(size / HEADER_SIZE) * HEADER_SIZE
      if (offset > bytes.length) return undefined
      if (type === '0' && headerEntryName(header) === entryName) {
        if (size > MAX_ENTRY_BYTES) return undefined
        return body.toString('utf8')
      }
    }
    return undefined
  } catch {
    return undefined
  }
}
