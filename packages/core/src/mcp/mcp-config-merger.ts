import type { McpServerRef } from '../types.js'

export interface McpServerConfig {
  url: string
  headers: Record<string, string>
  type?: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  [key: string]: unknown
}

export interface NormalizedMcpConfig {
  mcpServers: Record<string, McpServerConfig>
}

export function mergeMcpConfig (
  existing: NormalizedMcpConfig,
  newServers: McpServerRef[]
): NormalizedMcpConfig {
  const merged: Record<string, McpServerConfig> = { ...existing.mcpServers }

  for (const server of newServers) {
    const { command, args, env, type, ...preserved } = merged[server.name] ?? {}
    merged[server.name] = {
      ...preserved,
      url: server.url,
      headers: { ...server.headers },
    }
  }

  return { mcpServers: merged }
}

export function removeMcpServers (
  existing: NormalizedMcpConfig,
  serverNames: string[]
): NormalizedMcpConfig {
  const mcpServers: Record<string, McpServerConfig> = {}

  for (const [name, config] of Object.entries(existing.mcpServers)) {
    if (!serverNames.includes(name)) {
      mcpServers[name] = config
    }
  }

  return { mcpServers }
}

export function expandVariables (
  servers: McpServerRef[],
  variables: Record<string, string>
): McpServerRef[] {
  return servers.map((server) => ({
    ...server,
    url: expandString(server.url, variables),
    headers: Object.fromEntries(
      Object.entries(server.headers).map(([k, v]) => [k, expandString(v, variables)])
    ),
  }))
}

function expandString (value: string, variables: Record<string, string>): string {
  return value.replace(/\${(\w+)}/g, (_, name) => variables[name] ?? '${' + name + '}')
}
