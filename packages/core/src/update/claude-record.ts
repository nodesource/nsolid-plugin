import type { ClaudePluginScope } from './types.js'

const CLAUDE_SCOPES = new Set<ClaudePluginScope>(['user', 'project', 'local', 'managed'])

export function readClaudePluginScope (record: Record<string, unknown>): ClaudePluginScope | undefined {
  const metadata = record.metadata
  const metadataScope = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>).scope
    : undefined
  const values = [record.scope, record.installationScope, metadataScope]
    .filter((candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0)
  if (new Set(values).size > 1) return undefined
  const value = values[0]
  return value && CLAUDE_SCOPES.has(value as ClaudePluginScope) ? value as ClaudePluginScope : undefined
}
