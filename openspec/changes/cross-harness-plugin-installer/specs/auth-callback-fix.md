# Authentication Callback Fix — Delta Spec

> Discovered during implementation: the accounts service sends different callback parameters
> than originally specified. Parameters were corrected by inspecting the working
> `nsentinel-vscode-extension` OAuth flow.

## MODIFIED Requirements

### Requirement: Successful OAuth authentication (Auth Flow)

Update the OAuth callback to match real accounts service behavior.

#### Scenario: Accounts service callback parameters

- **MODIFIED** callback now receives these parameters:
  - `success=true` (new — must be `"true"`, not `"1"` or missing)
  - `token=<serviceToken>` (unchanged)
  - `consoleId=<organizationId>` (was `orgId`)
  - `url=<consoleUrl>` (new)
  - `NSOLID_SAAS=<saasToken>` (new — URL-encoded SaaS token containing ZMQ curve key + proxy URL + port)
  - `code=<authCode>` (new — OAuth authorization code)
  - `state=<csrfState>` (was present but not validated)

- **MODIFIED** callback server validates state against expected value for CSRF protection

- **MODIFIED** callback server falls back to ports 8766-8770 if 8765 is busy

#### Scenario: Credential storage

- **MODIFIED** stored credential structure now includes:
  - `saasToken` (from `NSOLID_SAAS` callback param)
  - `consoleUrl` (from `url` callback param)
  - `mcpUrl` (derived: `https://{consoleId}.mcp.saas.nodesource.io`)
  - `permissions` (from token validation API response)

```json
{
  "serviceToken": "<token>",
  "organizationId": "<consoleId>",
  "saasToken": "<NSOLID_SAAS>",
  "consoleUrl": "<url>",
  "mcpUrl": "https://<consoleId>.mcp.saas.nodesource.io",
  "expiresAt": "<ISO8601 timestamp>",
  "permissions": ["<permission>"]
}
```

## ADDED Requirements

### Requirement: Accounts service extension registration

The accounts service must support `nsolid-plugin` as a valid extension type with HTTP callback redirect.

#### Scenario: Extension registration

- **GIVEN** the plugin is a CLI tool without custom URI scheme support
- **WHEN** the auth flow initiates
- **THEN** the accounts service must redirect to `http://127.0.0.1:{port}/callback` (not `vscode://`)
- **AND** this requires registering `nsolid-plugin` as an extension type in the accounts service

> **BLOCKING**: This is an external dependency on the accounts-api team.
> See: https://github.com/nodesource/accounts-api/issues/749

### Requirement: CSRF protection via state parameter
The OAuth state parameter must be validated to prevent CSRF attacks.

#### Scenario: State validation on callback

- **GIVEN** the auth flow generated a random UUID state
- **WHEN** the callback is received
- **THEN** the state parameter must match the expected value
- **AND** mismatched state returns 400 and does not store credentials

### Requirement: MCP URL derivation
The MCP server URL must be derived from the organization ID (consoleId).

#### Scenario: MCP URL construction

- **GIVEN** a consoleId value from the OAuth callback
- **WHEN** credentials are stored
- **THEN** `mcpUrl` is set to `https://{consoleId}.mcp.saas.nodesource.io`
- **AND** this URL is used by MCP servers for connectivity

### Requirement: Auth failure detection
The callback server must detect failed authentication (success=false) and report it.

#### Scenario: success=false from accounts service

- **GIVEN** the OAuth callback is received
- **WHEN** `success` parameter is `"false"`
- **THEN** the server resolves with `{ success: false, reason: 'auth-failed' }`
- **AND** the auth manager throws an appropriate error
