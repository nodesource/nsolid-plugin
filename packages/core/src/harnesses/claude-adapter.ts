import type { HarnessAdapter, McpConfig } from './harness-adapter.js'
import type { HarnessType } from '../types.js'
import { resolveHome } from '../utils/path.js'
import { writeMcpConfig as writeMcpConfigInternal } from '../mcp/mcp-config-writer.js'
import { readExistingConfig } from '../mcp/mcp-config-writer.js'

export class ClaudeAdapter implements HarnessAdapter {
  readonly name: HarnessType = 'claude'

  getMcpConfigPath (): string {
    return resolveHome('~/.claude.json')
  }

  getSkillsPath (): string {
    return resolveHome('~/.claude/skills/')
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
    await writeMcpConfigInternal('claude', servers)
  }
}
