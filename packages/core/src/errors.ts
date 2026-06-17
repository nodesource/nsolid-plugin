import path from 'node:path'

export type PluginErrorCode =
  | 'BUNDLE_NOT_FOUND'
  | 'BUNDLE_INVALID'
  | 'AUTH_FAILED'
  | 'AUTH_TIMEOUT'
  | 'AUTH_INVALID_CREDENTIALS'
  | 'AUTH_PERMISSION_DENIED'
  | 'SKILL_SOURCE_NOT_FOUND'
  | 'SKILL_COPY_FAILED'
  | 'SKILL_LINK_FAILED'
  | 'MCP_CONFIG_READ_FAILED'
  | 'MCP_CONFIG_WRITE_FAILED'
  | 'MCP_CONFIG_BACKUP_FAILED'
  | 'MCP_CONFIG_RESTORE_FAILED'
  | 'TRACKING_READ_FAILED'
  | 'TRACKING_UPDATE_FAILED'
  | 'BACKUP_NOT_FOUND'
  | 'BACKUP_RESTORE_FAILED'
  | 'PERMISSION_DENIED'
  | 'PATH_UNSAFE'
  | 'NETWORK_UNAVAILABLE'
  | 'UNKNOWN'

export interface PluginErrorOptions {
  action?: string
  path?: string
  harness?: string
  cause?: unknown
  platform?: NodeJS.Platform
}

export class PluginError extends Error {
  public readonly code: PluginErrorCode
  public readonly action?: string
  public readonly path?: string
  public readonly harness?: string
  public readonly platform: NodeJS.Platform
  public readonly cause?: unknown

  constructor (
    code: PluginErrorCode,
    message: string,
    options: PluginErrorOptions = {}
  ) {
    super(message)
    this.name = 'PluginError'
    this.code = code
    this.action = options.action
    this.path = options.path
    this.harness = options.harness
    this.platform = options.platform ?? process.platform
    this.cause = options.cause
  }
}

export class PermissionError extends PluginError {
  constructor (
    public readonly missingPermissions: string[],
    message: string,
    options: Omit<PluginErrorOptions, 'action'> = {}
  ) {
    super('AUTH_PERMISSION_DENIED', message, {
      action: 'Ensure your NodeSource account has the required permissions, then retry.',
      ...options,
    })
    this.name = 'PermissionError'
  }
}

export class InvalidCredentialsError extends PluginError {
  constructor (message: string, options: Omit<PluginErrorOptions, 'action'> = {}) {
    super('AUTH_INVALID_CREDENTIALS', message, {
      action: 'Re-run installation and authenticate with a valid NodeSource account.',
      ...options,
    })
    this.name = 'InvalidCredentialsError'
  }
}

export function isNodeErrno (err: unknown, code?: string): err is NodeJS.ErrnoException {
  if (typeof err !== 'object' || err === null) return false
  const e = err as NodeJS.ErrnoException
  if (code !== undefined && e.code !== code) return false
  return typeof e.code === 'string' && e.code.length > 0
}

export function toPluginError (
  err: unknown,
  code: PluginErrorCode,
  options: PluginErrorOptions = {}
): PluginError {
  if (err instanceof PluginError) return err

  const message = err instanceof Error ? err.message : String(err)
  const cause = err instanceof Error ? err : undefined

  if (isNodeErrno(err, 'EACCES') || isNodeErrno(err, 'EPERM')) {
    return new PluginError('PERMISSION_DENIED', message, {
      action: options.path
        ? permissionGuidance(options.path, options.platform)
        : 'Check file permissions and retry.',
      ...options,
      cause,
    })
  }

  if (isNodeErrno(err, 'ENOENT')) {
    return new PluginError('BUNDLE_NOT_FOUND', message, {
      action: 'Verify the file path exists and try again.',
      ...options,
      cause,
    })
  }

  if (isNodeErrno(err, 'EADDRINUSE')) {
    return new PluginError('AUTH_FAILED', message, {
      action: 'Close the application using the conflicting port, then retry.',
      ...options,
      cause,
    })
  }

  return new PluginError(code, message, { ...options, cause })
}

export function permissionGuidance (filePath: string, platform?: NodeJS.Platform): string {
  const resolved = path.resolve(filePath)
  const p = platform ?? process.platform

  if (p === 'win32') {
    return `Permission denied writing to ${resolved}. ` +
      'Try running the command as Administrator, or run:\n' +
      `  icacls "${resolved}" /grant %USERNAME%:F`
  }

  return `Permission denied writing to ${resolved}. ` +
    'Try:\n' +
    `  sudo chown -R $USER "${resolved}"`
}

export function formatPluginError (err: unknown): string {
  if (!(err instanceof PluginError)) {
    return err instanceof Error ? err.message : String(err)
  }

  const parts = [`${err.name}[${err.code}]: ${err.message}`]
  if (err.path) parts.push(`Path: ${err.path}`)
  if (err.harness) parts.push(`Harness: ${err.harness}`)
  if (err.action) parts.push(`Suggestion: ${err.action}`)
  return parts.join('\n')
}
