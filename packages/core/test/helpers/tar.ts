/** Minimal ustar fixture: a header plus a body padded to 512 bytes. */
export function tarEntry (name: string, body: Buffer | undefined, type: string): Buffer {
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

/** Checksummed repository archive fixture, including the two end blocks. */
export function makeTar (files: Map<string, Buffer>): Buffer {
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

export function writeOctal (target: Buffer, offset: number, length: number, value: number): void {
  const encoded = value.toString(8).padStart(length - 1, '0') + '\0'
  target.write(encoded, offset, length, 'ascii')
}
