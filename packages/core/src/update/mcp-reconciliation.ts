import type { McpServerRef } from '../types.js'

export interface TrackedMcpServer {
  name: string
  configPath: string
  fields?: Record<string, string>
}

export interface McpServerValue {
  name: string
  /** Harness-formatted record ready to be stored. */
  value: Record<string, unknown>
}

export interface McpConfigPlanEntry {
  configPath: string
  /** Whole-record removals (proven exclusively owned before planning). */
  removeServers: string[]
  /** Full records to create (servers with no previous tracking entry). */
  upsertServers: McpServerValue[]
  /** Owned-field updates inside existing records (set or add). */
  updateFields: { server: string; field: string; value: unknown }[]
  /** Owned-field removals inside existing records. */
  removeFields: { server: string; field: string }[]
  /** Owned-field digests validated immediately before generating the patch. */
  ownedFieldDigests: { server: string; field: string; expectedDigest: string }[]
}

export type McpReconciliationPlan =
  | { kind: 'planned'; entries: readonly McpConfigPlanEntry[]; destinations: Readonly<Record<string, string>> }
  | { kind: 'reconciliation-required'; code: 'MCP_RECONCILIATION_REQUIRED'; message: string }

export interface McpReconciliationInput {
  previousServers: readonly TrackedMcpServer[]
  desiredServers: readonly McpServerRef[]
  /** Harness-formatted record for every desired server, keyed by server name. */
  desiredValues: Readonly<Record<string, Record<string, unknown>>>
  canonicalConfigPath?: string
}

/**
 * Compute the per-config-file MCP reconciliation plan for one harness.
 *
 * Existing servers stay in their registered configuration file; stale servers
 * are removed from the file that owns them; new servers go to the single
 * pre-existing path, or to the adapter's canonical path. Any ambiguous
 * selection (one name spread across several files, or no resolvable
 * destination) returns MCP_RECONCILIATION_REQUIRED instead of guessing.
 */
export function planMcpReconciliation (input: McpReconciliationInput): McpReconciliationPlan {
  const { previousServers, desiredServers, desiredValues, canonicalConfigPath } = input
  const previousByName = new Map<string, TrackedMcpServer[]>()
  for (const entry of previousServers) {
    const list = previousByName.get(entry.name) ?? []
    list.push(entry)
    previousByName.set(entry.name, list)
  }

  const ambiguous = desiredServers.find((server) => (previousByName.get(server.name)?.length ?? 0) > 1)
  if (ambiguous) {
    return {
      kind: 'reconciliation-required',
      code: 'MCP_RECONCILIATION_REQUIRED',
      message: `MCP server ${ambiguous.name} is registered in multiple configuration files and its owner cannot be chosen safely`,
    }
  }

  const previousPaths = [...new Set(previousServers.map((entry) => entry.configPath))]
  const desiredNames = new Set(desiredServers.map((server) => server.name))
  const staleServers = previousServers.filter((entry) => !desiredNames.has(entry.name))

  let destinationForNew: string | undefined
  if (desiredServers.some((server) => (previousByName.get(server.name)?.length ?? 0) === 0)) {
    destinationForNew = previousPaths.length === 1 ? previousPaths[0] : canonicalConfigPath
    if (!destinationForNew) {
      return {
        kind: 'reconciliation-required',
        code: 'MCP_RECONCILIATION_REQUIRED',
        message: 'The destination configuration file for new MCP servers is ambiguous and no canonical path is available',
      }
    }
  }

  const byPath = new Map<string, McpConfigPlanEntry>()
  const entryFor = (configPath: string): McpConfigPlanEntry => {
    const key = configPath
    const existing = byPath.get(key)
    if (existing) return existing
    const created: McpConfigPlanEntry = {
      configPath: key,
      removeServers: [],
      upsertServers: [],
      updateFields: [],
      removeFields: [],
      ownedFieldDigests: [],
    }
    byPath.set(key, created)
    return created
  }

  const destinations: Record<string, string> = {}
  for (const server of desiredServers) {
    const owner = previousByName.get(server.name)?.[0]
    const desiredValue = desiredValues[server.name]
    if (!desiredValue) {
      return {
        kind: 'reconciliation-required',
        code: 'MCP_RECONCILIATION_REQUIRED',
        message: `No harness-formatted value was prepared for MCP server ${server.name}`,
      }
    }
    if (!owner) {
      const target = entryFor(destinationForNew!)
      target.upsertServers.push({ name: server.name, value: desiredValue })
      destinations[server.name] = destinationForNew!
      continue
    }
    const target = entryFor(owner.configPath)
    destinations[server.name] = owner.configPath
    const trackedFields = owner.fields ?? {}
    for (const [field, expectedDigest] of Object.entries(trackedFields)) {
      target.ownedFieldDigests.push({ server: server.name, field, expectedDigest })
      if (Object.hasOwn(desiredValue, field)) {
        target.updateFields.push({ server: server.name, field, value: desiredValue[field] })
      } else {
        target.removeFields.push({ server: server.name, field })
      }
    }
    for (const [field, value] of Object.entries(desiredValue)) {
      if (!Object.hasOwn(trackedFields, field)) {
        target.updateFields.push({ server: server.name, field, value })
      }
    }
  }

  for (const entry of staleServers) {
    entryFor(entry.configPath).removeServers.push(entry.name)
  }

  const entries = [...byPath.values()].sort((left, right) => left.configPath.localeCompare(right.configPath))
  return { kind: 'planned', entries, destinations }
}
