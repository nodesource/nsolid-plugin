/**
 * Derive the N|Solid console's MCP endpoint from its console URL and org id.
 *
 * The MCP ingress route is always provisioned under the org's UUID
 * (accounts-api's console creation builds it as `${orgId}.mcp.<suffix>`),
 * never under a display alias a console may also be reachable at
 * (e.g. `homedepot-nucleus-stage-1.saas.nodesource.io` for org
 * `602b4703-...`). Reusing consoleUrl's hostname label verbatim breaks for
 * aliased consoles — the alias's `.mcp.` subdomain was never registered as a
 * route and returns a generic 404, not the real MCP service. So only the
 * environment suffix (`saas.nodesource.io`, `staging.saas.nodesource.io`,
 * etc.) is trusted from consoleUrl; the label itself is always rebuilt from
 * the trusted organizationId.
 */
const SUFFIX = 'saas.nodesource.io'

export function deriveMcpUrlFromConsoleUrl (consoleUrl: string, organizationId: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(consoleUrl)
  } catch {
    return null
  }

  const labels = parsed.hostname.split('.')
  if (labels.length < 2) return null

  const suffix = labels.slice(1).join('.')
  // Trust only an exact `saas.nodesource.io` suffix or a deeper one reached
  // through a DNS label boundary (dot-delimited). A plain `endsWith` would
  // also accept a label like `foo-saas.nodesource.io` — where `saas` is a
  // substring of a larger label — and rebuild the endpoint onto a hostname
  // that accounts-api never provisions.
  if (suffix !== SUFFIX && !suffix.endsWith(`.${SUFFIX}`)) return null

  return `https://${organizationId}.mcp.${suffix}/`
}
