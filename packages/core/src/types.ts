export type HarnessType = 'claude' | 'codex' | 'opencode' | 'antigravity' | 'pi';

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
  dryRun?: boolean;
}

export interface InstallResult {
  success: boolean;
  skillsInstalled: number;
  mcpServersConfigured: string[];
  authRequired: boolean;
  errors: string[];
}

export interface DoctorReport {
  healthy: boolean;
  credentials: { status: 'ok' | 'missing' | 'expired'; message?: string };
  skills: { status: 'ok' | 'partial' | 'missing'; installed: string[]; missing: string[] };
  mcpServers: { status: 'ok' | 'partial' | 'unreachable'; reachable: string[]; unreachable: string[] };
  errors: string[];
}