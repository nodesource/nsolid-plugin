export const HARNESS_VALUES = ['claude', 'codex', 'opencode', 'antigravity', 'pi'] as const

export type HarnessType = (typeof HARNESS_VALUES)[number]

/**
 * Harnesses whose installs are owned by the harness's native plugin
 * mechanism — the plugin ships skills and MCP config itself, so the CLI
 * skips its tracking-file install for them.
 */
export const PLUGIN_OWNED_HARNESSES: ReadonlySet<HarnessType> = new Set<HarnessType>(['claude', 'codex', 'antigravity'])

/**
 * Harnesses that install the nsolid plugin/package natively (owning skills and
 * MCP config themselves) rather than via the shared CLI tracking file. The
 * doctor probes each via `adapter.detectNativePlugin()`. Superset of
 * {@link PLUGIN_OWNED_HARNESSES} plus the package-owned Pi harness.
 */
export const NATIVE_PLUGIN_HARNESSES: ReadonlySet<HarnessType> = new Set<HarnessType>(['claude', 'codex', 'antigravity', 'pi'])

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
  /** Auth origin used to mint/validate the token. */
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
  /**
   * True when the shared NodeSource credentials are authenticated and the
   * active org is set (freshly stored, or already valid). For `switch-org`
   * this is the "org switch succeeded" signal: it is independently true of
   * `success`, because a later harness install/config refresh can still fail
   * after the org has already been switched. Never set by `install()` (which
   * does not authenticate). Do NOT roll back switched credentials when this
   * is true but `success` is false — the org change is real and global.
   */
  authSucceeded: boolean;
  /** Non-empty when any step failed; fatal failures short-circuit, non-fatal ones leave partial state. */
  errors: string[];
}

export interface SetupOptions extends InstallOptions {
  /** Force a fresh OAuth round-trip even if valid credentials exist (used to switch NodeSource organizations). */
  force?: boolean;
  /**
   * Injectable stdout/stderr sink for headless sign-in instructions.
   * Defaults to `process.stderr.write`. Library consumers can use this to
   * capture or suppress OAuth sign-in URL messages without touching stderr.
   */
  notify?: (text: string) => void;
}
export type SetupResult = InstallResult

export interface DoctorReport {
  healthy: boolean;
  credentials: { status: 'ok' | 'missing' | 'expired'; message?: string; organizationId?: string };
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
  /**
   * Shared MCP bridge (`mcp-remote`) runtime status. Optional for backward
   * compatibility with older JSON consumers. `required` is true only when
   * this harness's MCP servers are actually served through the generated
   * wrapper (native plugin installed for claude/codex/antigravity); for
   * opencode/pi and direct (native-HTTP) installs the entry is
   * informational and never affects `healthy`.
   */
  bridge?: {
    status: 'ready' | 'missing' | 'invalid';
    /** Pinned mcp-remote version this plugin expects. */
    version: string;
    root: string;
    proxyPath?: string;
    reason?: string;
    required: boolean;
  };
  errors: string[];
}
