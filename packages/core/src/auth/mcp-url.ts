export function deriveMcpUrlFromConsoleUrl (consoleUrl: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(consoleUrl)
  } catch {
    return null
  }

  const host = parsed.hostname
  let mcpHost: string | null = null

  if (host.endsWith('.saas.nodesource.io')) {
    mcpHost = host.replace(/\.saas\.nodesource\.io$/, '.mcp.saas.nodesource.io')
  }

  if (!mcpHost) return null

  return `https://${mcpHost}/`
}
