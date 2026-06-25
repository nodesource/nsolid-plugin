import type { HarnessType } from '../types.js'
import type { HarnessAdapter } from './harness-adapter.js'
import { ClaudeAdapter } from './claude-adapter.js'
import { CodexAdapter } from './codex-adapter.js'
import { OpenCodeAdapter } from './opencode-adapter.js'
import { PiAdapter } from './pi-adapter.js'
import { AntigravityAdapter } from './antigravity-adapter.js'

export function getAdapter (harness: HarnessType): HarnessAdapter {
  switch (harness) {
    case 'claude':
      return new ClaudeAdapter()
    case 'codex':
      return new CodexAdapter()
    case 'opencode':
      return new OpenCodeAdapter()
    case 'pi':
      return new PiAdapter()
    case 'antigravity':
      return new AntigravityAdapter()
  }
}

export type { HarnessAdapter, McpConfig, McpServerConfig, NativePluginStatus } from './harness-adapter.js'
