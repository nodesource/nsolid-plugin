import type { HarnessAdapter, McpConfig } from './harness-adapter.js'
import type { HarnessType } from '../types.js'
import { resolveHome } from '../utils/path.js'
import { writeAdapterMcpConfig, readExistingConfig } from '../mcp/mcp-config-writer.js'

export class PiAdapter implements HarnessAdapter {
  readonly name: HarnessType = 'pi'

  getMcpConfigPath (): string {
    return resolveHome('~/.pi/agent/mcp.json')
  }

  getSkillsPath (): string {
    return resolveHome('~/.pi/agent/skills/')
  }

  supportsMcp (): boolean {
    return true
  }

  async readMcpConfig (): Promise<McpConfig> {
    return readExistingConfig(this.getMcpConfigPath(), 'json')
  }

  async writeMcpConfig (config: McpConfig): Promise<void> {
    writeAdapterMcpConfig(this.name, config)
  }
}
