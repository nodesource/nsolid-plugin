interface TarEntry {
  path: string
  type: string
  body: Buffer
  linkTarget: string
}

/**
 * Iterate uncompressed TAR entries, resolving per-entry PAX/GNU paths.
 * Bodies are views into the archive. Callers own decompression limits and
 * payload policy. As before, a zero header ends traversal and final padding
 * or a trailing partial header is not required.
 */
export function * readTarEntries (archive: Buffer): Generator<TarEntry> {
  let offset = 0
  let longPath: string | undefined
  let paxPath: string | undefined
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512)
    if (header.every((value) => value === 0)) break
    const size = tarNumber(header.subarray(124, 136))
    const bodyStart = offset + 512
    const bodyEnd = bodyStart + size
    if (!Number.isSafeInteger(size) || size < 0 || bodyEnd > archive.length) throw new Error('invalid tar size')
    const body = archive.subarray(bodyStart, bodyEnd)
    const type = String.fromCharCode(header[156] || 48)
    const headerPath = [tarString(header.subarray(345, 500)), tarString(header.subarray(0, 100))].filter(Boolean).join('/')

    if (type === 'L') longPath = tarString(body)
    else if (type === 'x') paxPath = parsePaxPath(body)
    else if (type !== 'g') {
      yield { path: paxPath ?? longPath ?? headerPath, type, body, linkTarget: tarString(header.subarray(157, 257)) }
      paxPath = undefined
      longPath = undefined
    }
    offset = bodyStart + Math.ceil(size / 512) * 512
  }
}

function parsePaxPath (body: Buffer): string | undefined {
  let offset = 0
  let result: string | undefined
  while (offset < body.length) {
    const space = body.indexOf(0x20, offset)
    if (space < 0) throw new Error('invalid pax record')
    const length = Number(body.subarray(offset, space).toString('ascii'))
    if (!Number.isSafeInteger(length) || length <= 0 || offset + length > body.length) throw new Error('invalid pax length')
    const record = body.subarray(space + 1, offset + length - 1).toString('utf8')
    const equals = record.indexOf('=')
    if (equals > 0 && record.slice(0, equals) === 'path') result = record.slice(equals + 1)
    offset += length
  }
  return result
}

function tarNumber (value: Buffer): number {
  if ((value[0] ?? 0) & 0x80) {
    let result = BigInt((value[0] ?? 0) & 0x7f)
    for (const byte of value.subarray(1)) result = (result << 8n) | BigInt(byte)
    const number = Number(result)
    if (!Number.isSafeInteger(number)) throw new Error('tar number overflow')
    return number
  }
  const parsed = Number.parseInt(tarString(value).trim() || '0', 8)
  if (!Number.isSafeInteger(parsed)) throw new Error('invalid tar number')
  return parsed
}

function tarString (value: Buffer): string {
  const end = value.indexOf(0)
  return value.subarray(0, end < 0 ? value.length : end).toString('utf8').replace(/\n$/, '')
}
