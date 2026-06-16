export { getAdapter } from './harnesses/index.js'
export type { HarnessAdapter, McpConfig, McpServerConfig } from './harnesses/index.js'

import path from 'node:path'
import { readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'

import type {
  HarnessType,
  InstallOptions,
  InstallResult,
  DoctorReport,
  BundleDescriptor,
  Credentials,
} from './types.js'
import { validateBundle } from './validate.js'
import { ensureAuthenticated, loadCredentials, isExpired } from './auth/index.js'
import { installSkills, SkillCopyError } from './skills/skill-copier.js'
import { linkSkillsToHarness, unlinkSkillsFromHarness } from './skills/skill-linker.js'
import {
  readTrackingFile,
  addTrackedSkills,
  removeTrackedSkills,
} from './skills/skill-tracker.js'
import {
  writeMcpConfig,
  removeMcpConfig,
  addTrackedMcps,
  removeTrackedMcps,
  listTrackedMcps,
} from './mcp/index.js'
import { getAdapter } from './harnesses/index.js'
import type { HarnessAdapter } from './harnesses/index.js'
import { readJsonFile } from './utils/config.js'
import { getSkillsDir } from './utils/path.js'

const KNOWN_MCP_SERVERS = ['ns-benchmark', 'nsolid-mcp', 'ncm-mcp']

export async function install (options: InstallOptions): Promise<InstallResult> {
  const result: InstallResult = {
    success: false,
    skillsInstalled: 0,
    mcpServersConfigured: [],
    hadToAuthenticate: false,
    errors: [],
  }

  let bundle: BundleDescriptor
  try {
    const bundleData = readJsonFile<BundleDescriptor>(options.bundlePath)
    if (!bundleData) {
      result.errors.push(`Bundle not found: ${options.bundlePath}`)
      return result
    }
    bundle = validateBundle(bundleData)
  } catch (err) {
    result.errors.push(`Bundle validation failed: ${(err as Error).message}`)
    return result
  }

  const adapter = getAdapter(options.harness)

  let credentials: Credentials | null = null
  if (bundle.auth) {
    try {
      credentials = loadCredentials()
    } catch {
      // Corrupt credentials file — will re-authenticate
    }

    if (!credentials || isExpired(credentials)) {
      result.hadToAuthenticate = true
      try {
        credentials = await ensureAuthenticated(bundle.auth)
      } catch (err) {
        result.errors.push(`Authentication failed: ${(err as Error).message}`)
        return result
      }
    }
  }

  try {
    await installSkills(bundle.skills, options.skillsSource)
    result.skillsInstalled = bundle.skills.length
  } catch (err) {
    if (err instanceof SkillCopyError) {
      result.errors.push(err.message)
    } else {
      result.errors.push(`Skill installation failed: ${(err as Error).message}`)
    }
    return result
  }

  let linkedSkills: typeof bundle.skills = []
  try {
    const linkResults = await linkSkillsToHarness(options.harness, bundle.skills)
    const linkedNames = new Set(linkResults.map((r) => r.skill))
    linkedSkills = bundle.skills.filter((s) => linkedNames.has(s.name))
  } catch (err) {
    result.errors.push(`Skill linking failed: ${(err as Error).message}`)
  }

  const variables: Record<string, string> = {}
  if (credentials) {
    variables.AUTH_TOKEN = credentials.serviceToken
    variables.AUTH_ORG_ID = credentials.organizationId
  }

  const mcpConfigPath = adapter.getMcpConfigPath()

  if (adapter.supportsMcp() && bundle.mcpServers.length > 0) {
    try {
      await writeMcpConfig(options.harness, bundle.mcpServers, variables, {
        configPath: mcpConfigPath ?? undefined,
      })
      result.mcpServersConfigured = bundle.mcpServers.map((s) => s.name)
    } catch (err) {
      result.errors.push(`MCP configuration failed: ${(err as Error).message}`)
    }
  } else if (bundle.mcpServers.length > 0) {
    result.errors.push(
      `Bundle defines ${bundle.mcpServers.length} MCP server(s) but harness "${options.harness}" does not support MCP — they were not installed`
    )
  }

  try {
    if (linkedSkills.length > 0) {
      await addTrackedSkills(linkedSkills, options.harness)
    }

    if (mcpConfigPath && result.mcpServersConfigured.length > 0) {
      const mcpEntries = bundle.mcpServers.map((s) => ({ name: s.name, configPath: mcpConfigPath }))
      await addTrackedMcps(mcpEntries, options.harness)
    }
  } catch (err) {
    result.errors.push(`Tracking update failed: ${(err as Error).message}`)
  }

  result.success = result.errors.length === 0
  return result
}

export async function uninstall (
  harness: HarnessType,
  options?: { bundlePath?: string }
): Promise<{ errors: string[] }> {
  const errors: string[] = []
  const adapter = getAdapter(harness)
  const tracking = await readTrackingFile()

  if (tracking) {
    const harnessSkills = tracking.skills.filter((s) => s.harnesses.includes(harness))
    const harnessMcps = tracking.mcpServers.filter((m) => m.harness === harness)

    if (harnessMcps.length > 0) {
      const mcpConfigPath = adapter.getMcpConfigPath()
      try {
        await removeMcpConfig(harness, harnessMcps.map((m) => m.name), {
          configPath: mcpConfigPath ?? undefined,
        })
        await removeTrackedMcps(harnessMcps.map((m) => m.name), harness)
      } catch (err) {
        errors.push(`MCP removal failed: ${(err as Error).message}`)
      }
    }

    if (harnessSkills.length > 0) {
      const skillRefs = harnessSkills.map((s) => ({
        name: s.name,
        path: s.path,
        description: '',
      }))
      try {
        await unlinkSkillsFromHarness(harness, skillRefs)
        await removeTrackedSkills(skillRefs, harness)
      } catch (err) {
        errors.push(`Skill removal failed: ${(err as Error).message}`)
      }
    }
  } else {
    const warnings = await bestEffortCleanup(harness, adapter, options)
    errors.push(...warnings)
  }

  return { errors }
}

async function bestEffortCleanup (
  harness: HarnessType,
  adapter: HarnessAdapter,
  options?: { bundlePath?: string }
): Promise<string[]> {
  const warnings: string[] = []
  const skillsDir = getSkillsDir()
  try {
    const entries = await readdir(skillsDir, { withFileTypes: true })
    const nsSkills = entries
      .filter((e) => e.isDirectory() && e.name.startsWith('ns-'))
      .map((e) => ({
        name: e.name,
        path: path.join(skillsDir, e.name),
        description: '',
      }))

    if (nsSkills.length > 0) {
      await unlinkSkillsFromHarness(harness, nsSkills)
    }
  } catch {
    // Skills directory doesn't exist or is unreadable — nothing to clean
  }

  if (adapter.supportsMcp()) {
    let mcpNames = KNOWN_MCP_SERVERS
    let usedBundle = false
    if (options?.bundlePath) {
      try {
        const bundleData = readJsonFile<BundleDescriptor>(options.bundlePath)
        if (bundleData?.mcpServers) {
          mcpNames = bundleData.mcpServers.map((s) => s.name)
          usedBundle = true
        }
      } catch {
        // Fall back to hardcoded list
      }
    }
    if (!usedBundle) {
      warnings.push(
        'No tracking file and no bundle provided — using hardcoded MCP server list; user-added MCP servers may be left in the config'
      )
    }
    try {
      const mcpConfigPath = adapter.getMcpConfigPath()
      await removeMcpConfig(harness, mcpNames, {
        configPath: mcpConfigPath ?? undefined,
      })
    } catch {
      // Best-effort
    }
  }

  return warnings
}

export async function doctor (
  harness: HarnessType,
  bundlePath: string
): Promise<DoctorReport> {
  const report: DoctorReport = {
    healthy: true,
    credentials: { status: 'missing' },
    skills: { status: 'ok', installed: [], missing: [] },
    mcpServers: { status: 'ok', reachable: [], unreachable: [] },
    errors: [],
  }

  let bundle: BundleDescriptor | null = null
  try {
    const bundleData = readJsonFile<BundleDescriptor>(bundlePath)
    if (bundleData) {
      bundle = validateBundle(bundleData)
    } else {
      report.errors.push(`Bundle not found: ${bundlePath}`)
    }
  } catch {
    report.errors.push(`Failed to load bundle: ${bundlePath}`)
  }

  try {
    const creds = loadCredentials()
    if (creds) {
      if (isExpired(creds)) {
        report.credentials = { status: 'expired', message: 'Credentials have expired' }
      } else {
        report.credentials = { status: 'ok' }
      }
    }
  } catch {
    report.credentials = { status: 'missing' }
  }

  const adapter = getAdapter(harness)

  if (!bundle) {
    report.skills.status = 'unknown'
    report.mcpServers.status = 'unknown'
  } else {
    const expectedMcps = bundle.mcpServers.map((s) => s.name)

    const trackedSkills = await readTrackingFile()
    const trackedNames = new Set(
      trackedSkills?.skills.filter((s) => s.harnesses.includes(harness)).map((s) => s.name) ?? []
    )
    const harnessSkillsDir = adapter.getSkillsPath()

    for (const skill of bundle.skills) {
      const inTracking = trackedNames.has(skill.name)
      const onDisk = existsSync(path.join(harnessSkillsDir, skill.name))
      if (inTracking || onDisk) {
        report.skills.installed.push(skill.name)
        if (inTracking && !onDisk) {
          report.errors.push(`Skill "${skill.name}" tracked but not on disk — tracking may be stale`)
        } else if (onDisk && !inTracking) {
          report.errors.push(`Skill "${skill.name}" on disk but not tracked — tracking may be stale`)
        }
      } else {
        report.skills.missing.push(skill.name)
      }
    }

    if (report.skills.missing.length > 0) {
      report.skills.status = report.skills.installed.length > 0 ? 'partial' : 'missing'
    }

    if (adapter.supportsMcp()) {
      const trackedMcps = await listTrackedMcps(harness)
      const trackedMcpNames = new Set(trackedMcps.map((m) => m.name))
      let onDiskMcpNames: Set<string> = new Set()
      try {
        const onDiskConfig = await adapter.readMcpConfig()
        onDiskMcpNames = new Set(Object.keys(onDiskConfig.mcpServers))
      } catch {
        // Config file doesn't exist or is unreadable
      }

      for (const name of expectedMcps) {
        const inTracking = trackedMcpNames.has(name)
        const onDisk = onDiskMcpNames.has(name)
        if (inTracking || onDisk) {
          report.mcpServers.reachable.push(name)
          if (inTracking && !onDisk) {
            report.errors.push(`MCP "${name}" tracked but not in config — tracking may be stale`)
          } else if (onDisk && !inTracking) {
            report.errors.push(`MCP "${name}" in config but not tracked — tracking may be stale`)
          }
        } else {
          report.mcpServers.unreachable.push(name)
        }
      }

      if (report.mcpServers.unreachable.length > 0) {
        report.mcpServers.status =
          report.mcpServers.reachable.length > 0 ? 'partial' : 'unreachable'
      }
    } else {
      report.mcpServers.status = 'ok'
    }
  }

  report.healthy =
    report.credentials.status === 'ok' &&
    report.skills.status === 'ok' &&
    report.mcpServers.status === 'ok' &&
    report.errors.length === 0

  return report
}

export type { HarnessType, InstallOptions, InstallResult, DoctorReport, BundleDescriptor, Credentials } from './types.js'
export type { LinkResult, LinkStatus } from './skills/skill-linker.js'
export type { SkillTrackingEntry, McpTrackingEntry, TrackingData } from './skills/skill-tracker.js'
