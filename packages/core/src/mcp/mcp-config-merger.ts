import type { McpServerRef } from '../types.js'

export interface McpServerConfig {
  command: string
  args: string[]
  env?: Record<string, string>
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
    merged[server.name] = {
      command: server.command,
      args: [...server.args],
      env: server.env ? { ...server.env } : undefined,
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
    args: server.args.map((arg) => expandString(arg, variables)),
    env: server.env
      ? Object.fromEntries(
        Object.entries(server.env).map(([k, v]) => [k, expandString(v, variables)])
      )
      : undefined,
  }))
}

function expandString (value: string, variables: Record<string, string>): string {
  return value.replace(/\${(\w+)}/g, (_, name) => variables[name] ?? '${' + name + '}')
}
