import type { HarnessAdapter, McpConfig } from './harness-adapter.js'
import type { HarnessType } from '../types.js'
import { resolveHome } from '../utils/path.js'
import { writeMcpConfig as writeMcpConfigInternal } from '../mcp/mcp-config-writer.js'
import { readExistingConfig } from '../mcp/mcp-config-writer.js'

export class CodexAdapter implements HarnessAdapter {
  readonly name: HarnessType = 'codex'

  getMcpConfigPath (): string {
    return resolveHome('~/.codex/config.toml')
  }

  getSkillsPath (): string {
    return resolveHome('~/.codex/skills/')
  }

  supportsMcp (): boolean {
    return true
  }

  async readMcpConfig (): Promise<McpConfig> {
    return readExistingConfig(this.getMcpConfigPath(), 'toml')
  }

  async writeMcpConfig (config: McpConfig): Promise<void> {
    const servers = Object.entries(config.mcpServers).map(([name, cfg]) => ({
      name,
      command: cfg.command,
      args: cfg.args,
      env: cfg.env,
    }))
    await writeMcpConfigInternal('codex', servers)
  }
}
