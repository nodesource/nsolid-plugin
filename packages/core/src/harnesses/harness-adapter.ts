import type { HarnessType } from '../types.js'
import type { McpServerConfig, NormalizedMcpConfig } from '../mcp/mcp-config-merger.js'

export type { McpServerConfig }
export type McpConfig = NormalizedMcpConfig

/**
 * Result of probing whether the nsolid plugin is installed as a *native*
 * plugin/package of a harness (e.g. `codex plugin install`,
 * `claude plugin install`, `agy plugin install`, `pi install npm:...`).
 *
 * Native installs are owned by the harness CLI, not the shared tracking file
 * at `~/.agents/.nodesource-installed.json`, so `doctor` detects them here
 * rather than via tracking. Detection is best-effort and read-only: any
 * adapter that can't determine the state returns `{ installed: false }`.
 */
export interface NativePluginStatus {
  installed: boolean
  /** True only when the harness records the plugin as explicitly enabled. */
  enabled?: boolean
  /** Human label like `nsolid-plugin@nodesource` shown on the Plugin line. */
  label?: string
}

export interface HarnessAdapter {
  readonly name: HarnessType
  getMcpConfigPath(): string | null
  getSkillsPath(): string
  supportsMcp(): boolean
  readMcpConfig(): Promise<McpConfig>
  writeMcpConfig(config: McpConfig): Promise<void>
  /**
   * Detect whether the nsolid plugin is installed as a native plugin/package.
   * Optional: harnesses that don't have a native plugin model (e.g. opencode)
   * omit it, and `doctor` then treats the plugin line as N/A for them.
   */
  detectNativePlugin?(): NativePluginStatus
}
