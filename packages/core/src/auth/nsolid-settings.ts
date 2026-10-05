import { existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * The N|Solid server (the backend that replaces the console) has settings of
 * its own rather than NodeSource credentials: its MCP URL and an API token. The
 * environment wins over the file, which skills' scripts read too.
 */
export interface NsolidSettings {
  mcpUrl: string;
  token: string;
}

export function nsolidSettingsPath (): string {
  return path.join(os.homedir(), '.agents', '.nsolid-auth.json')
}

/** The settings, or null when N|Solid is not configured (or the file is unreadable). */
export function readNsolidSettings (env: NodeJS.ProcessEnv = process.env): NsolidSettings | null {
  let file: Record<string, unknown> = {}
  const settingsPath = nsolidSettingsPath()
  if (existsSync(settingsPath)) {
    try {
      file = JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>
    } catch {
      return null
    }
  }
  const mcpUrl = env.NSOLID_MCP_URL || file.mcpUrl
  const token = env.NSOLID_API_TOKEN || file.token
  if (typeof mcpUrl !== 'string' || !mcpUrl || typeof token !== 'string' || !token) return null
  return { mcpUrl, token }
}
