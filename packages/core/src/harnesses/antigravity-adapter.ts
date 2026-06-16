import type { HarnessAdapter, McpConfig } from './harness-adapter.js'
import type { McpServerConfig, NormalizedMcpConfig } from '../mcp/mcp-config-merger.js'
import type { HarnessType } from '../types.js'
import { resolveHome } from '../utils/path.js'
import { writeAdapterMcpConfig, readExistingConfig } from '../mcp/mcp-config-writer.js'

interface AntigravityMcpServerConfig {
  serverUrl: string
  headers: Record<string, string>
}

function toAntigravityFormat (config: McpConfig): { mcpServers: Record<string, AntigravityMcpServerConfig> } {
  const servers: Record<string, AntigravityMcpServerConfig> = {}
  for (const [name, srv] of Object.entries(config.mcpServers)) {
    servers[name] = {
      serverUrl: srv.url,
      headers: srv.headers,
    }
  }
  return { mcpServers: servers }
}

export class AntigravityAdapter implements HarnessAdapter {
  readonly name: HarnessType = 'antigravity'

  getMcpConfigPath (): string {
    return resolveHome('~/.gemini/config/mcp_config.json')
  }

  getSkillsPath (): string {
    return resolveHome('~/.gemini/skills')
  }

  supportsMcp (): boolean {
    return true
  }

  async readMcpConfig (): Promise<McpConfig> {
    const config = readExistingConfig(this.getMcpConfigPath(), 'json')
    const mcpServers: Record<string, McpServerConfig> = {}
    for (const [name, srv] of Object.entries(config.mcpServers)) {
      const raw = srv as unknown as { serverUrl?: string; url?: string; headers?: Record<string, string> }
      mcpServers[name] = {
        url: raw.serverUrl || raw.url || '',
        headers: raw.headers || {},
      }
    }
    return { mcpServers }
  }

  async writeMcpConfig (config: McpConfig): Promise<void> {
    writeAdapterMcpConfig(this.name, toAntigravityFormat(config) as unknown as NormalizedMcpConfig)
  }
}
