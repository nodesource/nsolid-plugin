import type { HarnessAdapter, McpConfig } from './harness-adapter.js'
import type { HarnessType } from '../types.js'
import { resolveHome } from '../utils/path.js'
import { writeAdapterMcpConfig, readExistingConfig } from '../mcp/mcp-config-writer.js'

export class OpenCodeAdapter implements HarnessAdapter {
  readonly name: HarnessType = 'opencode'

  getMcpConfigPath (): string {
    return resolveHome('~/.config/opencode/opencode.jsonc')
  }

  getSkillsPath (): string {
    return resolveHome('~/.config/opencode/skills/')
  }

  supportsMcp (): boolean {
    return true
  }

  async readMcpConfig (): Promise<McpConfig> {
    return readExistingConfig(this.getMcpConfigPath(), 'jsonc', 'mcp')
  }

  async writeMcpConfig (config: McpConfig): Promise<void> {
    writeAdapterMcpConfig(this.name, config)
  }
}
