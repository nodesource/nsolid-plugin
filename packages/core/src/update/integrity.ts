import { createHash } from 'node:crypto'

export interface ParsedIntegrity {
  algorithm: 'sha256' | 'sha384' | 'sha512'
  digest: string
}

/** Parse npm SRI, including unpadded base64url digests, into canonical base64. */
export function parseIntegrity (value: string): ParsedIntegrity | undefined {
  const match = value.match(/^sha(256|384|512)-([A-Za-z0-9+/_-]+={0,2})$/i)
  if (!match) return undefined
  const unpadded = match[2].replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '')
  if (unpadded.length % 4 === 1) return undefined
  const padding = '='.repeat((4 - (unpadded.length % 4)) % 4)
  return { algorithm: `sha${match[1]}` as ParsedIntegrity['algorithm'], digest: unpadded + padding }
}

export function bytesMatchIntegrity (bytes: Uint8Array, integrity: string): boolean {
  const parsed = parseIntegrity(integrity)
  return parsed !== undefined && createHash(parsed.algorithm).update(bytes).digest('base64') === parsed.digest
}
