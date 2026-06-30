import path from 'node:path'
import type { HarnessAdapter, McpConfig, NativePluginStatus } from './harness-adapter.js'
import type { HarnessType } from '../types.js'
import { resolveHome } from '../utils/path.js'
import { writeAdapterMcpConfig, readExistingConfig } from '../mcp/mcp-config-writer.js'
import { readJsonFile } from '../utils/config.js'

const PLUGIN_ID = 'nsolid-plugin@nodesource'

export class ClaudeAdapter implements HarnessAdapter {
  readonly name: HarnessType = 'claude'

  getMcpConfigPath (): string {
    return resolveHome('~/.claude.json')
  }

  getPluginsDir (): string {
    return resolveHome('~/.claude/plugins')
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
    writeAdapterMcpConfig(this.name, config)
  }

  /**
   * Claude Code records native plugins in
   * `~/.claude/plugins/installed_plugins.json` and an enable map in
   * `~/.claude.json` (`enabledPlugins`). The installed_plugins schema has
   * varied across versions (a map or a `{plugins:[...]}` array), so each is
   * tolerated; an explicit entry counts as installed, and `enabled` is set
   * only when an enabled map explicitly lists the id.
   */
  detectNativePlugin (): NativePluginStatus {
    const status: NativePluginStatus = { installed: false, label: PLUGIN_ID }
    const installedPath = path.join(this.getPluginsDir(), 'installed_plugins.json')

    try {
      const data = readJsonFile<unknown>(installedPath)
      const ids = extractPluginIds(data)
      if (ids.includes(PLUGIN_ID)) {
        status.installed = true
      }
    } catch {
      // Unreadable installed_plugins.json — fall through.
    }

    try {
      const settings = readJsonFile<Record<string, unknown>>(this.getMcpConfigPath())
      const enabledPlugins = settings?.enabledPlugins
      if (enabledPlugins && typeof enabledPlugins === 'object' && !Array.isArray(enabledPlugins)) {
        const map = enabledPlugins as Record<string, unknown>
        if (map[PLUGIN_ID] === true) {
          status.enabled = true
        } else if (map[PLUGIN_ID] === false) {
          status.enabled = false
        }
      }
    } catch {
      // settings.json unreadable — enabled stays undefined.
    }

    return status
  }
}

function extractPluginIds (data: unknown): string[] {
  if (!data || typeof data !== 'object') return []
  if (Array.isArray(data)) {
    return data.flatMap((v) => {
      if (typeof v === 'string') return [v]
      if (v && typeof v === 'object' && typeof (v as { id?: unknown }).id === 'string') {
        return [(v as { id: string }).id]
      }
      return []
    })
  }

  const obj = data as Record<string, unknown>
  const arr = obj.plugins
  if (Array.isArray(arr)) {
    return arr.flatMap((v) => {
      if (typeof v === 'string') return [v]
      if (v && typeof v === 'object' && typeof (v as { id?: unknown }).id === 'string') {
        return [(v as { id: string }).id]
      }
      return []
    })
  }
  return Object.keys(obj)
}
