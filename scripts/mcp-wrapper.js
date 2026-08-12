#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const AUTH_FILE = path.join(os.homedir(), '.agents', '.nodesource-auth.json')
const SETUP_COMMAND = 'npx -y nsolid-plugin setup --harness <claude|codex|opencode|antigravity|pi>'
const MCP_REMOTE_NPX_BOOTSTRAP = "import{existsSync}from'node:fs';import path from'node:path';import{pathToFileURL}from'node:url';const payload=JSON.parse(Buffer.from(process.env.NSOLID_MCP_REMOTE_PAYLOAD,'base64url'));const binName=process.platform==='win32'?'mcp-remote.cmd':'mcp-remote';const binDir=process.env.PATH.split(path.delimiter).find(dir=>existsSync(path.join(dir,binName)));if(!binDir)throw new Error('mcp-remote executable was not installed by npx');const proxyPath=path.resolve(binDir,'..','mcp-remote','dist','proxy.js');const args=Object.entries(payload.headers).flatMap(([key,value])=>['--header',key+':'+value]);process.argv=[process.execPath,proxyPath,payload.url,...args,'--transport','http-first','--silent'];await import(pathToFileURL(proxyPath).href)"

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
      const derivedUrl = credentials.mcpUrl ? null : deriveMcpUrlFromConsoleUrl(credentials.consoleUrl, credentials.organizationId)
      const url = credentials.mcpUrl || derivedUrl
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

function deriveMcpUrlFromConsoleUrl (consoleUrl, organizationId) {
  let parsed
  try {
    parsed = new URL(consoleUrl)
  } catch {
    return null
  }

  const labels = parsed.hostname.split('.')
  if (labels.length < 2) return null

  const suffix = labels.slice(1).join('.')
  if (suffix !== 'saas.nodesource.io' && !suffix.endsWith('.saas.nodesource.io')) return null

  return `https://${organizationId}.mcp.${suffix}/`
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

  const fallback = getMcpRemoteFallback(url, headers)
  const options = {
    stdio: 'inherit',
    ...fallback.options,
    windowsHide: true,
  }
  const child = fallback.args.length === 0
    ? spawn(fallback.command, options)
    : spawn(fallback.command, fallback.args, options)
  await new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error('mcp-remote exited with code ' + (code ?? 1))))
  })
}

function getMcpRemoteFallback (url, headers) {
  if (process.platform !== 'win32') {
    const headerArgs = Object.entries(headers).flatMap(([key, value]) => ['--header', `${key}:${value}`])
    return {
      command: 'npx',
      args: ['-y', 'mcp-remote@0.1.38', url, ...headerArgs, '--transport', 'http-first', '--silent'],
      options: { shell: false, env: process.env },
    }
  }

  // A .cmd file needs cmd.exe. Keep its command line constant and move all
  // untrusted values into an encoded environment payload for Node to decode.
  const npxCmd = resolveWindowsNpxCmd()
  const payload = Buffer.from(JSON.stringify({ url, headers })).toString('base64url')
  const bootstrap = `data:text/javascript;base64,${Buffer.from(MCP_REMOTE_NPX_BOOTSTRAP).toString('base64')}`
  return {
    command: '.\\npx.cmd -y --package=mcp-remote@0.1.38 node --input-type=module --eval "await import(process.env.NSOLID_MCP_REMOTE_BOOTSTRAP)"',
    args: [],
    options: {
      shell: getWindowsCmdShell(),
      cwd: path.dirname(npxCmd),
      env: { ...process.env, NSOLID_MCP_REMOTE_PAYLOAD: payload, NSOLID_MCP_REMOTE_BOOTSTRAP: bootstrap },
    },
  }
}

function resolveWindowsNpxCmd () {
  // Node's own directory is already inside the trust boundary: this process
  // was launched from it. Do not search PATH, which may contain project-owned
  // .bin directories or other attacker-controlled entries.
  const npxCmd = path.join(path.dirname(process.execPath), 'npx.cmd')
  if (existsSync(npxCmd)) return npxCmd
  throw new Error(`Could not locate npx.cmd next to Node.js at ${npxCmd}. Install Node.js with npm.`)
}

function getWindowsCmdShell () {
  const windowsRoot = process.env.SystemRoot ?? process.env.WINDIR
  const root = windowsRoot ? path.win32.parse(windowsRoot).root : ''
  if (!windowsRoot || !path.win32.isAbsolute(windowsRoot) || root.length === 1) {
    throw new Error('Could not locate the Windows system directory.')
  }
  const shell = path.join(windowsRoot, 'System32', 'cmd.exe')
  if (!existsSync(shell)) throw new Error(`Could not locate Windows command shell at ${shell}.`)
  return shell
}

function fail (message) {
  console.error(`[nsolid-plugin] ${message}`)
  process.exit(1)
}
