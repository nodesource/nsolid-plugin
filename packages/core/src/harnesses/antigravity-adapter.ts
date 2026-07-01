import { existsSync } from 'node:fs'
import path from 'node:path'
import type { HarnessAdapter, McpConfig, NativePluginStatus } from './harness-adapter.js'
import type { HarnessType } from '../types.js'
import { resolveHome } from '../utils/path.js'
import { writeAdapterMcpConfig, readExistingConfig } from '../mcp/mcp-config-writer.js'
import { readJsonFile } from '../utils/config.js'

const PLUGIN_NAME = 'nsolid-plugin'
const IMPORT_MANIFEST_REL = '~/.gemini/config/import_manifest.json'

export class AntigravityAdapter implements HarnessAdapter {
  readonly name: HarnessType = 'antigravity'

  getMcpConfigPath (): string {
    // Antigravity's shared, cross-product MCP config. Per
    // https://antigravity.google/docs/skills this lives under the same
    // `~/.gemini/config/` root as skills. The legacy
    // `~/.gemini/antigravity-cli/mcp_config.json` is agy-CLI-only and is NOT
    // read at runtime.
    return resolveHome('~/.gemini/config/mcp_config.json')
  }

  getPluginsPath (): string {
    // `agy plugin install` clones native plugins under the shared
    // `~/.gemini/config/plugins/` root and records them in
    // `~/.gemini/config/import_manifest.json`.
    return resolveHome('~/.gemini/config/plugins')
  }

  getSkillsPath (): string {
    // Antigravity loads global skills from ~/.gemini/config/skills/ (per
    // https://antigravity.google/docs/skills), the same root as the shared MCP
    // config at ~/.gemini/config/mcp_config.json.
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

  /**
   * Antigravity stages a native plugin at
   * `~/.gemini/config/plugins/nsolid-plugin/` (the directory `agy plugin
   * install` clones into) and records the import in
   * `~/.gemini/config/import_manifest.json`. Either signal counts as
   * installed; there is no separate enable flag, so `enabled` follows from the
   * plugin being present.
   */
  detectNativePlugin (): NativePluginStatus {
    const status: NativePluginStatus = { installed: false, label: PLUGIN_NAME }
    const staged = path.join(this.getPluginsPath(), PLUGIN_NAME)
    if (existsSync(staged)) {
      status.installed = true
      status.enabled = true
      status.installedIds = [PLUGIN_NAME]
      return status
    }

    // Fall back to the import manifest: the staged directory may have been
    // removed out of band while the manifest entry remains (or vice versa).
    try {
      const manifest = readJsonFile<{ imports?: Array<{ name?: string }> }>(resolveHome(IMPORT_MANIFEST_REL))
      const recorded = manifest?.imports?.some((entry) => entry?.name === PLUGIN_NAME) ?? false
      if (recorded) {
        status.installed = true
        status.enabled = true
        status.installedIds = [PLUGIN_NAME]
      }
    } catch {
      // Corrupt or unreadable manifest — fall through (detection is best-effort).
    }
    return status
  }
}
