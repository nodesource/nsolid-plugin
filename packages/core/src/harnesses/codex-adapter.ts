import type { HarnessAdapter, McpConfig, NativePluginStatus } from './harness-adapter.js'
import type { HarnessType } from '../types.js'
import { resolveHome } from '../utils/path.js'
import { writeAdapterMcpConfig, readExistingConfig } from '../mcp/mcp-config-writer.js'
import { readTomlFile } from '../utils/config.js'
import { isNsolidPluginId, PLUGIN_BASE_NAME } from './plugin-name.js'

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
   * Codex records a native plugin install in `~/.codex/config.toml` as a table
   * keyed by `<name>@<marketplace>`:
   *   [plugins."nsolid-plugin@nodesource"]
   *   enabled = true
   * The marketplace suffix varies by install source (e.g. our `@nodesource`
   * marketplace, or `@claude-plugins-official` if accepted into Anthropic's
   * community marketplace), so we match by base name. Any matching table drives
   * `installed`; `enabled` is true only when one has `enabled = true`.
   */
  detectNativePlugin (): NativePluginStatus {
    const status: NativePluginStatus = { installed: false, label: PLUGIN_BASE_NAME }
    try {
      const data = readTomlFile<Record<string, unknown>>(this.getMcpConfigPath())
      if (data) {
        const plugins = data.plugins
        if (plugins && typeof plugins === 'object' && !Array.isArray(plugins)) {
          const table = plugins as Record<string, unknown>
          const matchedKeys = Object.keys(table).filter(isNsolidPluginId)
          if (matchedKeys.length > 0) {
            status.installed = true
            status.installedIds = matchedKeys
            const enabledKey = matchedKeys.find((key) => {
              const entry = table[key]
              return entry && typeof entry === 'object' &&
                (entry as { enabled?: unknown }).enabled === true
            })
            status.enabled = enabledKey !== undefined
            status.label = enabledKey ?? matchedKeys[0]
          }
        }
      }
    } catch {
      // Corrupt or unreadable config — fall through.
    }

    return status
  }
}
