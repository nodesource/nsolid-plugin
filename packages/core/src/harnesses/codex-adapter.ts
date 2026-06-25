import { existsSync } from 'node:fs'
import type { HarnessAdapter, McpConfig, NativePluginStatus } from './harness-adapter.js'
import type { HarnessType } from '../types.js'
import { resolveHome } from '../utils/path.js'
import { writeAdapterMcpConfig, readExistingConfig } from '../mcp/mcp-config-writer.js'
import { readTomlFile } from '../utils/config.js'

const PLUGIN_KEY = 'nsolid-plugin@nodesource'
const MARKETPLACE_NAME = 'nodesource'

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
    writeAdapterMcpConfig(this.name, config)
  }

  /**
   * Codex records a native plugin install in `~/.codex/config.toml`:
   *   [plugins."nsolid-plugin@nodesource"]
   *   enabled = true
   * and the marketplace under `[marketplaces.nodesource]`, with the cloned
   * repo at `~/.codex/.tmp/marketplaces/nodesource/`. Any of those signals
   * counts as installed; only the `enabled = true` flag sets `enabled`.
   */
  detectNativePlugin (): NativePluginStatus {
    const status: NativePluginStatus = { installed: false, label: PLUGIN_KEY }
    try {
      const data = readTomlFile<Record<string, unknown>>(this.getMcpConfigPath())
      if (data) {
        const plugins = data.plugins
        const entry = plugins && typeof plugins === 'object' && !Array.isArray(plugins)
          ? (plugins as Record<string, unknown>)[PLUGIN_KEY]
          : undefined
        const enabled = entry && typeof entry === 'object'
          ? (entry as { enabled?: unknown }).enabled === true
          : false
        const marketplaces = data.marketplaces
        const hasMarketplace = marketplaces && typeof marketplaces === 'object' && !Array.isArray(marketplaces)
          ? Object.prototype.hasOwnProperty.call(marketplaces, MARKETPLACE_NAME)
          : false

        if (enabled) {
          status.installed = true
          status.enabled = true
        } else if (hasMarketplace) {
          status.installed = true
        }
      }
    } catch {
      // Corrupt or unreadable config — fall through to the on-disk clone check.
    }

    if (!status.installed) {
      const clone = resolveHome(`~/.codex/.tmp/marketplaces/${MARKETPLACE_NAME}/bundle.json`)
      if (existsSync(clone)) status.installed = true
    }

    return status
  }
}
