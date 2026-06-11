import type { HarnessAdapter, McpConfig } from './harness-adapter.js'
import type { HarnessType } from '../types.js'
import { resolveHome } from '../utils/path.js'
import { writeMcpConfig as writeMcpConfigInternal } from '../mcp/mcp-config-writer.js'
import { readExistingConfig } from '../mcp/mcp-config-writer.js'

export class AntigravityAdapter implements HarnessAdapter {
  readonly name: HarnessType = 'antigravity'

  getMcpConfigPath (): string {
    return resolveHome('~/.gemini/antigravity-cli/mcp_config.json')
  }

  getSkillsPath (): string {
    return resolveHome('~/.gemini/antigravity-cli/skills/')
  }

  supportsMcp (): boolean {
    return true
  }

  async readMcpConfig (): Promise<McpConfig> {
    return readExistingConfig(this.getMcpConfigPath(), 'json')
  }

  async writeMcpConfig (config: McpConfig): Promise<void> {
    const servers = Object.entries(config.mcpServers).map(([name, cfg]) => ({
      name,
      command: cfg.command,
      args: cfg.args,
      env: cfg.env,
    }))
    await writeMcpConfigInternal('antigravity', servers)
  }
}
