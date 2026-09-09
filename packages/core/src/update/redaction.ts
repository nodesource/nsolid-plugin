const SECRET_PATTERNS = [
  /Bearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /(["']?(?:authorization|token|password|secret|api[-_]?key)["']?\s*[:=]\s*)[^\s,;"']+/gi,
  /https?:\/\/[^\s/@]+:[^\s/@]+@/gi,
  /((?:access[_-]?token|refresh[_-]?token|client[_-]?secret|api[_-]?key)\s*[=:]\s*)["']?[^\s,"']+/gi,
  /(?:[A-Za-z]:[\\/]|\/)[^\s"']*(?:\.nodesource-auth|credentials?|\.npmrc|token)[^\s"']*/gi,
]

/** Redact credentials and credential-bearing paths from untrusted text. */
export function redactSecrets (value: string): string {
  let result = value.replace(/((["']?(?:authorization|token|password|secret|api[-_]?key)["']?)\s*[:=]\s*)(["'])[^"']*\3/gi, '$1$3[REDACTED]$3')
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, (_match, prefix?: unknown) => typeof prefix === 'string' ? `${prefix}[REDACTED]` : '[REDACTED]')
  }
  return result
}
