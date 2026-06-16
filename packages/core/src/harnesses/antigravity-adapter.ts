import type { HarnessAdapter, McpConfig } from './harness-adapter.js'
import type { HarnessType } from '../types.js'
import { resolveHome } from '../utils/path.js'
import { writeAdapterMcpConfig, readExistingConfig } from '../mcp/mcp-config-writer.js'

export class AntigravityAdapter implements HarnessAdapter {
  readonly name: HarnessType = 'antigravity'

  getMcpConfigPath (): string {
    return resolveHome('~/.gemini/config/mcp_config.json')
  }

  getSkillsPath (): string {
    // Antigravity loads global skills from ~/.gemini/config/skills/ (per
    // https://antigravity.google/docs/skills), the same root as the MCP config
    // at ~/.gemini/config/mcp_config.json.
    return resolveHome('~/.gemini/config/skills/')
  }

  supportsMcp (): boolean {
    return true
  }

  async readMcpConfig (): Promise<McpConfig> {
    // readExistingConfig already normalizes both `serverUrl` and `url` into the
    // canonical `url` field (see normalizeFromJson), so no per-harness work is
    // needed here.
    return readExistingConfig(this.getMcpConfigPath(), 'json')
  }

  async writeMcpConfig (config: McpConfig): Promise<void> {
    // The Antigravity-specific `url -> serverUrl` schema is applied inside
    // writeAdapterMcpConfig via applyHarnessWriteFormat, so this adapter stays
    // symmetric with the Claude/Codex/OpenCode adapters.
    writeAdapterMcpConfig(this.name, config)
  }
}
