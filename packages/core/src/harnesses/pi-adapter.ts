import type { HarnessAdapter, McpConfig, NativePluginStatus } from './harness-adapter.js'
import type { HarnessType } from '../types.js'
import { resolveHome } from '../utils/path.js'
import { writeAdapterMcpConfig, readExistingConfig } from '../mcp/mcp-config-writer.js'
import { piPluginInstalled, PI_PLUGIN_PACKAGE_NAME } from './pi-plugin-detector.js'

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

  /**
   * Pi is package-owned: detection follows from an installed
   * `nsolid-pi-plugin` npm package (see pi-plugin-detector). There is no
   * separate enable flag, so `installed` implies `enabled`.
   */
  detectNativePlugin (): NativePluginStatus {
    const installed = piPluginInstalled()
    return { installed, enabled: installed ? true : undefined, label: PI_PLUGIN_PACKAGE_NAME }
  }
}
