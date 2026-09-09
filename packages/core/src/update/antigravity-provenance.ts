/**
 * Shared registration provenance for the Antigravity nsolid-plugin import.
 *
 * Both the inventory detection (`inventory.ts` `manifestContainsPlugin`) and
 * the staged-plugin / restored-state validation (`antigravity-transaction.ts`
 * `validateStagedPlugin`) must agree on what proves an `imports` entry belongs
 * to this plugin: the entry must declare the canonical plugin identity AND
 * carry an accepted registration source. A correct name with a missing,
 * foreign, or spoofed source proves nothing, and object-form entries are only
 * recognized under the canonical key — otherwise a lookalike manifest could
 * pass one module while the other rejects it.
 */

export const NSOLID_PLUGIN_ID = 'nsolid-plugin'

/** Object-form imports are only recognized under the canonical key. */
export function isNsolidPluginImportKey (key: string): boolean {
  return key === NSOLID_PLUGIN_ID
}

/**
 * An import belongs to this plugin only when it declares the canonical
 * identity (`name` or `plugin` exactly `nsolid-plugin`) and its registration
 * source is either the `antigravity` marker or the exact NodeSource GitHub
 * root with an optional `.git` suffix (case-insensitive). Any other or
 * missing source is rejected.
 */
export function isNsolidPluginImport (entry: unknown): boolean {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false
  const value = entry as { name?: unknown; plugin?: unknown; source?: unknown }
  if (value.name !== NSOLID_PLUGIN_ID && value.plugin !== NSOLID_PLUGIN_ID) return false
  if (value.source === 'antigravity') return true
  return typeof value.source === 'string' && /^https:\/\/github\.com\/NodeSource\/nsolid-plugin(?:\.git)?$/i.test(value.source)
}
