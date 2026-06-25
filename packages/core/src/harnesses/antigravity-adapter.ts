import { existsSync } from 'node:fs'
import path from 'node:path'
import type { HarnessAdapter, McpConfig, NativePluginStatus } from './harness-adapter.js'
import type { HarnessType } from '../types.js'
import { resolveHome } from '../utils/path.js'
import { writeAdapterMcpConfig, readExistingConfig } from '../mcp/mcp-config-writer.js'

const PLUGIN_NAME = 'nsolid-plugin'

export class AntigravityAdapter implements HarnessAdapter {
  readonly name: HarnessType = 'antigravity'

  getMcpConfigPath (): string {
    return resolveHome('~/.gemini/antigravity-cli/mcp_config.json')
  }

  getPluginsPath (): string {
    // `agy plugin install` stages native plugins under the antigravity-cli root.
    return resolveHome('~/.gemini/antigravity-cli/plugins')
  }

  getSkillsPath (): string {
    // Antigravity loads global skills from ~/.gemini/antigravity-cli/skills/ (per
    // https://antigravity.google/docs/cli-plugins), the same root as the MCP config
    // at ~/.gemini/antigravity-cli/mcp_config.json.
    return resolveHome('~/.gemini/antigravity-cli/skills/')
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

  /**
   * Antigravity stages a native plugin at
   * `~/.gemini/antigravity-cli/plugins/nsolid-plugin/`. There is no separate
   * enable flag, so `installed` follows from the staged directory existing.
   */
  detectNativePlugin (): NativePluginStatus {
    const status: NativePluginStatus = { installed: false, label: PLUGIN_NAME }
    const staged = path.join(this.getPluginsPath(), PLUGIN_NAME)
    if (existsSync(staged)) {
      status.installed = true
      status.enabled = true
    }
    return status
  }
}
