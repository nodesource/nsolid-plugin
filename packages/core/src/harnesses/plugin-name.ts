/**
 * The stable base name of the nsolid plugin as it appears in its own manifest
 * (`plugin.json` `name` field). Harnesses key installs by a `<name>@<marketplace>`
 * id whose suffix varies by install source (e.g. `nsolid-plugin@nodesource` from
 * our marketplace, or `nsolid-plugin@claude-plugins-official` if accepted into
 * Anthropic's community marketplace). The base name is what stays constant, so
 * detection and uninstall match on it rather than a hardcoded full id.
 */
export const PLUGIN_BASE_NAME = 'nsolid-plugin'

/**
 * True when `id` is the nsolid plugin under any marketplace: it equals the base
 * name exactly, or is qualified as `<base>@<marketplace>`.
 */
export function isNsolidPluginId (id: string): boolean {
  return id === PLUGIN_BASE_NAME || id.startsWith(`${PLUGIN_BASE_NAME}@`)
}
