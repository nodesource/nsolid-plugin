#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const AUTH_FILE = path.join(os.homedir(), '.agents', '.nodesource-auth.json')
const SETUP_COMMAND = 'npx -y nsolid-plugin setup --harness <claude|codex|antigravity>'

const SERVER_NAMES = new Set(["nsolid-console","ns-benchmark","ncm"])
const serverName = process.argv[2]

if (!SERVER_NAMES.has(serverName)) {
  fail(`Unknown NodeSource MCP server: ${serverName ?? '(missing)'}`)
}

const credentials = readCredentials()
const server = resolveServer(serverName, credentials)
await runMcpRemote(server.url, server.headers)

function readCredentials () {
  if (!existsSync(AUTH_FILE)) {
    fail(`NodeSource credentials not found. Run: ${SETUP_COMMAND}`)
  }

  let parsed
  try {
    parsed = JSON.parse(readFileSync(AUTH_FILE, 'utf8'))
  } catch (err) {
    fail(`NodeSource credentials are unreadable. Run: npx -y nsolid-plugin logout && ${SETUP_COMMAND}. ${err.message}`)
  }

  const required = ['serviceToken', 'organizationId', 'consoleUrl', 'expiresAt']
  const missing = required.filter((key) => typeof parsed?.[key] !== 'string' || parsed[key].length === 0)
  if (missing.length > 0) {
    fail(`NodeSource credentials are incomplete (${missing.join(', ')} missing). Run: ${SETUP_COMMAND}`)
  }

  const expiresAt = Date.parse(parsed.expiresAt)
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    fail(`NodeSource credentials are expired. Run: ${SETUP_COMMAND}`)
  }

  return parsed
}

function resolveServer (name, credentials) {
  switch (name) {
    case 'nsolid-console': {
      const derivedUrl = deriveMcpUrlFromConsoleUrl(credentials.consoleUrl)
      const url = derivedUrl ?? credentials.mcpUrl
      if (!url) {
        fail(`Could not derive NodeSource console MCP URL from stored credentials. Run: ${SETUP_COMMAND}`)
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

  if (host.endsWith('.staging.saas.nodesource.io')) {
    mcpHost = host.replace(/\.staging\.saas\.nodesource\.io$/, '.mcp.staging.saas.nodesource.io')
  } else if (host.endsWith('.saas.nodesource.io')) {
    mcpHost = host.replace(/\.saas\.nodesource\.io$/, '.mcp.saas.nodesource.io')
  }

  return mcpHost ? `${parsed.protocol}//${mcpHost}/` : null
}

async function runMcpRemote (url, headers) {
  const headerArgs = Object.entries(headers).flatMap(([key, value]) => ['--header', `${key}:${value}`])

  const require = createRequire(import.meta.url)
  try {
    const proxyPath = require.resolve('mcp-remote/dist/proxy.js')
    process.argv = [process.execPath, proxyPath, url, ...headerArgs, '--transport', 'http-first', '--silent']
    await import(pathToFileURL(proxyPath).href)
    return
  } catch (err) {
    if (err?.code !== 'MODULE_NOT_FOUND' && !String(err?.message ?? '').includes('Cannot find module')) {
      throw err
    }
  }

  const child = spawn('npx', ['-y', 'mcp-remote@0.1.38', url, ...headerArgs, '--transport', 'http-first', '--silent'], {
    stdio: 'inherit',
    env: process.env,
  })
  await new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error('mcp-remote exited with code ' + (code ?? 1))))
  })
}

function fail (message) {
  console.error(`[nsolid-plugin] ${message}`)
  process.exit(1)
}
