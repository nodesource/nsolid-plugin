import type { HarnessAdapter, McpConfig } from './harness-adapter.js'
import type { HarnessType } from '../types.js'
import { resolveHome } from '../utils/path.js'

export class PiAdapter implements HarnessAdapter {
  readonly name: HarnessType = 'pi'

  getMcpConfigPath (): string | null {
    return null
  }

  getSkillsPath (): string {
    return resolveHome('~/.pi/agent/skills/')
  }

  supportsMcp (): boolean {
    return false
  }

  async readMcpConfig (): Promise<McpConfig> {
    return { mcpServers: {} }
  }

  async writeMcpConfig (_config: McpConfig): Promise<void> {
    // No-op: Pi does not support MCP
  }
}
