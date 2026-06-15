export type HarnessType = 'claude' | 'codex' | 'opencode' | 'antigravity' | 'pi'

export interface SkillRef {
  name: string;
  path: string;
  description: string;
  requiresMcp?: string[];
}

export interface McpServerRef {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface Credentials {
  serviceToken: string;
  organizationId: string;
  saasToken: string;
  consoleUrl: string;
  mcpUrl: string;
  expiresAt: string;
  permissions?: string[];
}

export interface AuthConfig {
  type: 'oauth';
  provider: string;
  accountsUrl: string;
  callbackPort?: number;
  requiredPermissions?: string[];
}

export interface BundleDescriptor {
  name: string;
  version: string;
  description?: string;
  skills: SkillRef[];
  mcpServers: McpServerRef[];
  auth?: AuthConfig;
}

export interface InstallOptions {
  harness: HarnessType;
  bundlePath: string;
  skillsSource: string;
}

/**
 * Result of a plugin installation attempt.
 *
 * `success` is true only when `errors` is empty — i.e. every step
 * (skill copy, linking, MCP config, tracking) completed without
 * failure. A skill-copy failure is fatal and short-circuits the
 * rest of the install (see `errors`). Linking, MCP config, and
 * tracking failures are non-fatal: their messages appear in
 * `errors` and `success` becomes false, but partial work from
 * earlier steps is preserved. Use `skillsInstalled` and
 * `mcpServersConfigured` to see what actually landed.
 */
export interface InstallResult {
  success: boolean;
  /** Number of skills successfully copied to the shared skills directory. */
  skillsInstalled: number;
  /** Names of MCP servers whose config was successfully written. */
  mcpServersConfigured: string[];
  /** True if credentials were needed and re-authentication was performed (whether it succeeded or failed). */
  hadToAuthenticate: boolean;
  /** Non-empty when any step failed; fatal failures short-circuit, non-fatal ones leave partial state. */
  errors: string[];
}

export interface DoctorReport {
  healthy: boolean;
  credentials: { status: 'ok' | 'missing' | 'expired'; message?: string };
  /** `unknown` when the bundle could not be loaded — the listed `installed`/`missing` arrays are not meaningful. */
  skills: { status: 'ok' | 'partial' | 'missing' | 'unknown'; installed: string[]; missing: string[] };
  /** `unknown` when the bundle could not be loaded — the listed `reachable`/`unreachable` arrays are not meaningful. */
  mcpServers: { status: 'ok' | 'partial' | 'unreachable' | 'unknown'; reachable: string[]; unreachable: string[] };
  errors: string[];
}
