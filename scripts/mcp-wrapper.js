#!/usr/bin/env node

// STDIO→HTTP bridge for the NodeSource MCP servers. Resolves mcp-remote
// exclusively from local copies: the shared runtime provisioned by
// `nsolid-plugin setup` (~/.agents/nsolid-plugin/runtime/mcp-remote/<version>),
// or a version-matched development checkout. It NEVER invokes npx, npm, a
// shell, or cmd.exe during startup — a missing runtime fails fast with the
// repair command instead of downloading anything.

import { createRequire } from 'node:module'
import { existsSync, readFileSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const MCP_REMOTE_VERSION = '0.1.38'
const AUTH_FILE = path.join(os.homedir(), '.agents', '.nodesource-auth.json')
const SERVER_NAMES = new Set(['nsolid-console', 'ns-benchmark', 'ncm'])
const HARNESS_NAMES = new Set(['claude', 'codex', 'opencode', 'antigravity', 'pi'])
const serverName = process.argv[2]
const harness = process.argv[3]

if (!SERVER_NAMES.has(serverName)) {
  fail(`Unknown NodeSource MCP server: ${serverName ?? '(missing)'}`)
}
if (!HARNESS_NAMES.has(harness)) {
  fail(`Invalid harness argument: ${harness ?? '(missing)'}`)
}

const credentials = readCredentials()
const server = resolveServer(serverName, credentials)
await runMcpRemote(server.url, server.headers)

function readCredentials () {
  if (!existsSync(AUTH_FILE)) {
    fail(`NodeSource credentials not found. Run: ${SETUP_COMMAND()}`)
  }

  let parsed
  try {
    parsed = JSON.parse(readFileSync(AUTH_FILE, 'utf8'))
  } catch (err) {
    fail(`NodeSource credentials are unreadable. Run: npx -y nsolid-plugin logout && ${SETUP_COMMAND()}. ${err.message}`)
  }

  const required = ['serviceToken', 'organizationId', 'consoleUrl', 'expiresAt']
  const missing = required.filter((key) => typeof parsed?.[key] !== 'string' || parsed[key].length === 0)
  if (missing.length > 0) {
    fail(`NodeSource credentials are incomplete (${missing.join(', ')} missing). Run: ${SETUP_COMMAND()}`)
  }

  const expiresAt = Date.parse(parsed.expiresAt)
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    fail(`NodeSource credentials are expired. Run: ${SETUP_COMMAND()}`)
  }

  return parsed
}

function resolveServer (name, credentials) {
  switch (name) {
    case 'nsolid-console': {
      const derivedUrl = credentials.mcpUrl ? null : deriveMcpUrlFromConsoleUrl(credentials.consoleUrl)
      const url = credentials.mcpUrl ?? derivedUrl
      if (!url) {
        fail(`Could not derive NodeSource console MCP URL from stored credentials. Run: ${SETUP_COMMAND()}`)
      }
      return {
        url,
        headers: {
          'X-Nsolid-Service-Token': credentials.serviceToken,
        },
      }
    }
    case 'ns-benchmark':
      return {
        url: 'https://benchmark.mcp.saas.nodesource.io/mcp',
        headers: {
          'X-Nsolid-Org-Id': credentials.organizationId,
          'X-Nsolid-Service-Token': credentials.serviceToken,
        },
      }
    case 'ncm':
      return {
        url: 'https://mcp.ncm.nodesource.com',
        headers: {
          'X-Nsolid-Service-Token': credentials.serviceToken,
        },
      }
    default:
      fail(`Unknown NodeSource MCP server: ${name}`)
  }
}

function deriveMcpUrlFromConsoleUrl (consoleUrl) {
  let parsed
  try {
    parsed = new URL(consoleUrl)
  } catch {
    return null
  }

  const host = parsed.hostname
  let mcpHost = null

  if (host.endsWith('.saas.nodesource.io')) {
    mcpHost = host.replace(/\.saas\.nodesource\.io$/, '.mcp.saas.nodesource.io')
  }

  return mcpHost ? `${parsed.protocol}//${mcpHost}/` : null
}

function SETUP_COMMAND () {
  return `npx -y nsolid-plugin setup --harness ${harness}`
}

function resolveProxyPath () {
  // 1. Stable shared runtime provisioned by `nsolid-plugin setup`.
  const runtimeRoot = path.join(os.homedir(), '.agents', 'nsolid-plugin', 'runtime', 'mcp-remote', MCP_REMOTE_VERSION)
  const stable = validateMcpRemote(path.join(runtimeRoot, 'node_modules', 'mcp-remote'))
  if (stable) return stable

  // 2. Development fallback: a checkout whose own node_modules carries the
  // exact pinned version. Also purely local — never a download.
  try {
    const require = createRequire(import.meta.url)
    const checkoutDir = path.dirname(require.resolve('mcp-remote/package.json'))
    return validateMcpRemote(checkoutDir)
  } catch {
    return null
  }
}

function validateMcpRemote (dir) {
  try {
    const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'))
    if (pkg.name !== 'mcp-remote' || pkg.version !== MCP_REMOTE_VERSION) return null
    const proxyPath = path.join(dir, 'dist', 'proxy.js')
    if (!statSync(proxyPath).isFile()) return null
    return proxyPath
  } catch {
    return null
  }
}

async function runMcpRemote (url, headers) {
  const proxyPath = resolveProxyPath()
  if (!proxyPath) {
    fail(`MCP bridge runtime is not ready. Run: ${SETUP_COMMAND()}`)
  }

  // URL and headers are handed to the imported proxy as separate argv
  // elements; no shell is ever involved.
  const headerArgs = Object.entries(headers).flatMap(([key, value]) => ['--header', `${key}:${value}`])
  process.argv = [process.execPath, proxyPath, url, ...headerArgs, '--transport', 'http-first', '--silent']
  await import(pathToFileURL(proxyPath).href)
}

function fail (message) {
  console.error(`[nsolid-plugin] ${message}`)
  process.exit(1)
}
