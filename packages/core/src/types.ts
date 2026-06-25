export const HARNESS_VALUES = ['claude', 'codex', 'opencode', 'antigravity', 'pi'] as const

export type HarnessType = (typeof HARNESS_VALUES)[number]

export interface SkillRef {
  name: string;
  path: string;
  description: string;
  requiresMcp?: string[];
}

export interface McpServerRef {
  name: string;
  url: string;
  headers: Record<string, string>;
}

export interface Credentials {
  serviceToken: string;
  organizationId: string;
  saasToken: string;
  consoleUrl: string;
  mcpUrl: string;
  expiresAt: string;
  permissions?: string[];
  /** Auth origin used to mint/validate the token (persisted for staging QA). */
  accountsUrl?: string;
}

export interface AuthConfig {
  type: 'oauth';
  provider: string;
  /**
   * Origin-only URL of the accounts/auth service (e.g.
   * `https://accounts.nodesource.com`). Must NOT include a path, query, or
   * hash: the auth manager builds endpoints with
   * `new URL('/sign-in', accountsUrl)`, and the URL constructor REPLACES the
   * entire base path when given a leading-slash path — so a base like
   * `https://host/api/v1` would silently lose `/api/v1` and OAuth would hit
   * the wrong endpoint. Validated as origin-only by the bundle schema.
   */
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

export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void
  info(message: string, meta?: Record<string, unknown>): void
  warn(message: string, meta?: Record<string, unknown>): void
  error(message: string, meta?: Record<string, unknown>): void
}

import type { ProgressReporter } from './utils/progress.js'

export interface AuthConfirmationContext {
  harness: HarnessType;
  accountsUrl: string;
}

export type AuthConfirmation = (context: AuthConfirmationContext) => void | Promise<void>

export interface InstallOptions {
  harness: HarnessType;
  bundlePath: string;
  skillsSource: string;
  verbose?: boolean;
  logger?: Logger;
  progress?: ProgressReporter;
  confirmAuth?: AuthConfirmation;
  /**
   * Harness package owns/discovers skills natively. Install only shared auth + MCP config,
   * and do not copy/link skills into user-level harness skill directories.
   */
  packageOwnedSkills?: boolean;
  /**
   * Copy skills directly into the harness-specific skills directory instead of
   * the shared ~/.agents/skills source dir. Used for CLI-only harnesses that
   * must not leak skills into global/shared discovery paths.
   */
  harnessSpecificSkills?: boolean;
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

export type SetupOptions = InstallOptions
export type SetupResult = InstallResult

export interface DoctorReport {
  healthy: boolean;
  credentials: { status: 'ok' | 'missing' | 'expired'; message?: string };
  /**
   * Native plugin/package install status. Only meaningful for plugin/package-
   * owned harnesses (claude, codex, antigravity, pi); for others the status is
   * `'n/a'`. When `installed`, skills and MCP servers are satisfied from the
   * plugin itself rather than the CLI tracking file.
   */
  plugin: { status: 'ok' | 'missing' | 'n/a'; installed: boolean; enabled?: boolean; label?: string };
  /** `unknown` when the bundle could not be loaded — the listed `installed`/`missing` arrays are not meaningful. */
  skills: { status: 'ok' | 'partial' | 'missing' | 'unknown'; installed: string[]; missing: string[] };
  /** `unknown` when the bundle could not be loaded — the listed `reachable`/`unreachable` arrays are not meaningful. */
  mcpServers: { status: 'ok' | 'partial' | 'unreachable' | 'unknown'; reachable: string[]; unreachable: string[] };
  errors: string[];
}
