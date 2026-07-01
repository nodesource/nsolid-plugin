import path from 'node:path'
import type { HarnessAdapter, McpConfig, NativePluginStatus } from './harness-adapter.js'
import type { HarnessType } from '../types.js'
import { resolveHome } from '../utils/path.js'
import { writeAdapterMcpConfig, readExistingConfig } from '../mcp/mcp-config-writer.js'
import { readJsonFile } from '../utils/config.js'
import { isNsolidPluginId, PLUGIN_BASE_NAME } from './plugin-name.js'

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
   * varied across versions:
   *   - v2 map: `{ version: 2, plugins: { "<name>@<marketplace>": [ ...records ] } }`
   *   - legacy: `{ plugins: [ { id: "..." } | "<id>" ] }` or a bare map of ids.
   * Each shape is tolerated. An explicit entry counts as installed; `enabled`
   * is set only when `~/.claude.json`'s `enabledPlugins` map lists the id as
   * true. The nsolid plugin is matched by base name (`nsolid-plugin` or
   * `nsolid-plugin@<marketplace>`) so detection survives a marketplace rename
   * (e.g. acceptance into Anthropic's community marketplace).
   */
  detectNativePlugin (): NativePluginStatus {
    const status: NativePluginStatus = { installed: false, label: PLUGIN_BASE_NAME }
    const installedPath = path.join(this.getPluginsDir(), 'installed_plugins.json')

    let matchedIds: string[] = []
    try {
      const data = readJsonFile<unknown>(installedPath)
      matchedIds = extractPluginIds(data).filter(isNsolidPluginId)
    } catch {
      // Unreadable installed_plugins.json — fall through.
    }

    let enabledId: string | undefined
    if (matchedIds.length > 0) {
      try {
        const settings = readJsonFile<Record<string, unknown>>(this.getMcpConfigPath())
        const enabledPlugins = settings?.enabledPlugins
        if (enabledPlugins && typeof enabledPlugins === 'object' && !Array.isArray(enabledPlugins)) {
          const map = enabledPlugins as Record<string, unknown>
          enabledId = matchedIds.find((id) => map[id] === true)
          const disabled = matchedIds.find((id) => map[id] === false)
          status.enabled = enabledId !== undefined ? true : (disabled !== undefined ? false : undefined)
        }
      } catch {
        // settings.json unreadable — enabled stays undefined.
      }

      status.installed = true
      status.installedIds = matchedIds
      status.label = enabledId ?? matchedIds[0]
    }
    return status
  }
}

/**
 * Extract candidate plugin ids from any tolerated installed_plugins schema.
 * Does not filter by plugin — callers filter with `isNsolidPluginId`.
 */
export function extractPluginIds (data: unknown): string[] {
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

  // v2 (and current) schema: `{ version, plugins: { "<id>": [...] } }`.
  const pluginsField = obj.plugins
  if (Array.isArray(pluginsField)) {
    return pluginsField.flatMap((v) => {
      if (typeof v === 'string') return [v]
      if (v && typeof v === 'object' && typeof (v as { id?: unknown }).id === 'string') {
        return [(v as { id: string }).id]
      }
      return []
    })
  }
  if (pluginsField && typeof pluginsField === 'object') {
    return Object.keys(pluginsField as Record<string, unknown>)
  }

  return []
}
