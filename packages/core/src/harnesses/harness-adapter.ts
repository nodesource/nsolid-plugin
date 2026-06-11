import type { HarnessType } from '../types.js'
import type { McpServerConfig, NormalizedMcpConfig } from '../mcp/mcp-config-merger.js'

export type { McpServerConfig }
export type McpConfig = NormalizedMcpConfig

export interface HarnessAdapter {
  readonly name: HarnessType
  getMcpConfigPath(): string | null
  getSkillsPath(): string
  supportsMcp(): boolean
  readMcpConfig(): Promise<McpConfig>
  writeMcpConfig(config: McpConfig): Promise<void>
}
