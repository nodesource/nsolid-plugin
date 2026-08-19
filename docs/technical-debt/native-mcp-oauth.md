# Technical Debt: Native MCP Transport OAuth

Status: **Deferred** — no target date. Tracked here as follow-up work; this
document records the gap deliberately so it is not mistaken for the OAuth flow
that ships today.

## Current State (what ships today)

The plugin authenticates users with **NodeSource Accounts OAuth** during
`nsolid-plugin setup`:

1. `setup` runs the browser-based OAuth flow against Accounts
   (`accounts.nodesource.com`) with a local callback server.
2. The flow produces a **service token** stored at
   `~/.agents/.nodesource-auth.json` (plus organization/console metadata).
3. For the wrapper-based harnesses (Claude, Codex, Antigravity), the generated
   `scripts/mcp-wrapper.js` bridges STDIO→HTTP using the shared local
   `mcp-remote` runtime provisioned by `setup`
   (`~/.agents/nsolid-plugin/runtime/mcp-remote/<version>/`).
4. The wrapper attaches the service token (and organization id) as custom
   headers (`X-Nsolid-Service-Token`, `X-Nsolid-Org-Id`) on every MCP HTTP
   request to the remote NodeSource MCP endpoints.

This is **application-level OAuth for token minting**, not OAuth of the MCP
transport itself: the harness never participates in authorization, tokens are
managed by the plugin, and the bridge exists precisely because the harnesses
cannot yet attach these credentials to a native Streamable HTTP MCP
connection.

## Target State

NodeSource MCP endpoints become first-class OAuth **protected resources**
consumed natively by each harness:

- MCP endpoints expose **authorization server / protected-resource metadata**
  per the MCP authorization specification (RFC 9728-style discovery).
- Each harness performs its own OAuth authorization (browser popup / device
  flow / IDE callback as supported by the host) against NodeSource Accounts.
- The plugin writes **native MCP server URLs** into each harness's config —
  no local STDIO bridge, no wrapper-managed headers, no shared
  `mcp-remote` runtime for harnesses with native HTTP support.
- Scopes are per organization / tool, with standard refresh and revocation.

## Required Backend Work

- Serve `/.well-known/oauth-protected-resource` (and authorization server
  metadata) from each MCP endpoint (`nsolid-console`, `ns-benchmark`, `ncm`).
- Define scopes (organization, tool-level) and map them to Accounts consent.
- Token refresh and revocation semantics compatible with generic MCP OAuth
  clients.
- Accept standard `Authorization: Bearer` access tokens in addition to (then
  instead of) the custom `X-Nsolid-*` headers.
- Compatibility testing across harness OAuth client implementations
  (authorization-code + PKCE flows, callback handling, token storage).

## Required Plugin Work

- Replace wrapper entries with native HTTP MCP config per harness (Claude,
  Codex, Antigravity already support this; OpenCode and Pi already use HTTP
  config today).
- Provide per-harness OAuth configuration/instructions instead of
  `setup`-minted service tokens where the harness manages tokens itself.
- Keep `setup` for harnesses lacking native OAuth until migration completes.
- Retire: `scripts/mcp-wrapper.js`, the generator's wrapper/bootstrap output,
  and the `~/.agents/nsolid-plugin/runtime/mcp-remote/` shared runtime
  (including lifecycle documentation in `packages/core/README.md` and the
  doctor bridge check).

## Migration Plan

1. Backend ships discovery + standard bearer support alongside custom headers
   (both accepted).
2. Plugin (per harness, gated on host capability): switch config from wrapper
   to native URL + OAuth metadata; document the user-facing re-consent step.
3. Coexistence period: older plugin versions keep working via the wrapper and
   custom headers.
4. Revoke/expire legacy service tokens used solely for wrapper bridges after
   telemetry shows negligible wrapper traffic.
5. Remove the wrapper and runtime in a subsequent major release.

## Risks / Open Questions

- OAuth client maturity differs across harnesses (scopes UI, refresh,
  multi-org selection, local callback restrictions in IDE contexts).
- Credential storage location and permissions differ per host; today the
  plugin controls storage centrally (`~/.agents/.nodesource-auth.json`).
- Multi-organization users: harness OAuth flows may only bind one token per
  server; organization switching needs a story.
- Rollback: keep the wrapper path installable per harness until the native
  path is proven, mirroring the coexistence period above.

## Closure Criteria

All five supported harnesses (Claude, Codex, OpenCode, Antigravity, Pi)
operate against NodeSource MCP endpoints **without** custom service-token
headers managed by the plugin and **without** the local `mcp-remote` bridge
wherever the harness supports native Streamable HTTP + OAuth.
