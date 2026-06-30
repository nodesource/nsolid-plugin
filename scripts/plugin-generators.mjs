#!/usr/bin/env node
/**
 * Shared plugin manifest/wrapper generators.
 *
 * Source of truth:
 *   - bundle.json
 *
 * Generators are pure functions: they receive a plugin descriptor and return
 * the expected file contents as strings.  Callers decide where to write them.
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

export function loadBundle (root = ROOT) {
  return JSON.parse(readFileSync(path.join(root, 'bundle.json'), 'utf8'))
}

const defaultBundle = loadBundle()

export const skillNames = defaultBundle.skills.map((skill) => skill.name)
export const skillNamesSet = new Set(skillNames)

function getBundle (bundle) {
  return bundle ?? defaultBundle
}

export function stableJson (value) {
  return `${JSON.stringify(value, null, 2)}\n`
}

export function generateClaudePluginJson (pluginPkgVersion, bundle) {
  const b = getBundle(bundle)
  const manifest = {
    $schema: 'https://anthropic.com/claude-code/plugin.schema.json',
    name: b.name,
    displayName: 'N|Solid Plugin',
    version: pluginPkgVersion ?? b.version,
    description: 'N|Solid performance & security skills + MCP servers',
    author: { name: 'NodeSource' },
    homepage: 'https://nodesource.com',
    repository: 'https://github.com/NodeSource/nsolid-plugin',
    license: 'MIT',
    skills: b.skills.map((skill) => `./skills/${skill.name}`),
    mcpServers: './.mcp.json',
  }

  return stableJson(manifest)
}

export function generateClaudeMcpJson (bundle) {
  return generateMcpConfig('$' + '{CLAUDE_PLUGIN_ROOT}/scripts/mcp-wrapper.js', bundle)
}

export function generateClaudeWrapper () {
  return generateMcpWrapper('claude')
}

export function generateAntigravityPluginJson (bundle) {
  const b = getBundle(bundle)
  return stableJson({
    name: b.name,
    description: 'N|Solid performance & security skills + MCP servers',
  })
}

export function generateAntigravityMcpJson (bundle) {
  const b = getBundle(bundle)
  const bootstrap = generateAntigravityBootstrap()
  const mcpServers = {}
  for (const server of b.mcpServers) {
    mcpServers[server.name] = {
      command: 'node',
      args: ['-e', bootstrap, server.name],
    }
  }
  return stableJson({ mcpServers })
}

export function generateCodexPluginJson (pluginPkgVersion, bundle) {
  const b = getBundle(bundle)
  return stableJson({
    name: b.name,
    version: pluginPkgVersion ?? b.version,
    description: 'N|Solid Plugin — AI skills and MCP servers for Codex',
    author: { name: 'NodeSource', url: 'https://nodesource.com' },
    homepage: 'https://nodesource.com',
    repository: 'https://github.com/NodeSource/nsolid-plugin',
    license: 'MIT',
    keywords: ['nodesource', 'nsolid', 'nodejs', 'performance', 'security'],
    skills: './skills/',
    mcpServers: './.mcp.json',
    interface: {
      displayName: 'N|Solid Plugin',
      shortDescription: 'N|Solid performance & security',
      category: 'Productivity',
      developerName: 'NodeSource',
    },
  })
}

export function generateCodexMcpJson (bundle) {
  const b = getBundle(bundle)
  const bootstrap = generateCodexBootstrap()
  const mcpServers = {}
  for (const server of b.mcpServers) {
    mcpServers[server.name] = {
      command: 'node',
      args: ['-e', bootstrap, server.name],
    }
  }
  return stableJson({ mcpServers })
}

export function generateCodexBootstrap () {
  // Fail closed: only trust wrappers positively identified as this plugin's
  // install root (a path segment matching `nsolid-plugin`). Never fall back to
  // an unrelated discovered scripts/mcp-wrapper.js.
  // eslint-disable-next-line no-template-curly-in-string -- codegen: ${path.sep} must stay literal in the generated bootstrap string, it is evaluated at runtime in the host process
  return "const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const {pathToFileURL}=require('node:url');const serverName=process.argv[1];const rel=['scripts','mcp-wrapper.js'];const roots=[path.join(os.homedir(),'.codex','plugins','cache'),process.cwd()];const candidates=[];for(const root of roots){try{const stack=[root];while(stack.length){const dir=stack.pop();if(!fs.existsSync(dir))continue;const direct=path.join(dir,...rel);if(fs.existsSync(direct))candidates.push(direct);for(const entry of fs.readdirSync(dir,{withFileTypes:true})){if(entry.isDirectory())stack.push(path.join(dir,entry.name))}}}catch{}}const wrapper=candidates.find((p)=>p.includes(`${path.sep}nsolid-plugin${path.sep}`));if(!wrapper){console.error('[nsolid-plugin] Could not locate Codex MCP wrapper. Reinstall with: codex plugin marketplace add NodeSource/nsolid-plugin && codex plugin add nsolid-plugin@nodesource');process.exit(1)}process.argv=[process.execPath,wrapper,serverName];import(pathToFileURL(wrapper).href)"
}

export function generateAntigravityBootstrap () {
  return "const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const {pathToFileURL}=require('node:url');const serverName=process.argv[1];const rel=['scripts','mcp-wrapper.js'];const candidates=[path.join(os.homedir(),'.gemini','config','plugins','nsolid-plugin',...rel),path.join(os.homedir(),'.gemini','antigravity-cli','plugins','nsolid-plugin',...rel),path.join(process.cwd(),'packages','antigravity-plugin',...rel),path.join(process.cwd(),...rel)];const wrapper=candidates.find((p)=>fs.existsSync(p));if(!wrapper){console.error('[nsolid-plugin] Could not locate Antigravity MCP wrapper. Reinstall with: agy plugin install https://github.com/NodeSource/nsolid-plugin.git');process.exit(1)}process.argv=[process.execPath,wrapper,serverName];import(pathToFileURL(wrapper).href)"
}

export function generateMcpConfig (wrapperPath, bundle) {
  const b = getBundle(bundle)
  const mcpServers = {}
  for (const server of b.mcpServers) {
    mcpServers[server.name] = {
      command: 'node',
      args: [wrapperPath, server.name],
    }
  }
  return stableJson({ mcpServers })
}

export function generateMcpWrapper (harness) {
  const serverNames = [...defaultBundle.mcpServers.map((s) => s.name)]
  return `#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const AUTH_FILE = path.join(os.homedir(), '.agents', '.nodesource-auth.json')
const SETUP_COMMAND = 'npx -y @nodesource/nsolid-plugin setup --harness ${harness}'

const SERVER_NAMES = new Set(${JSON.stringify(serverNames)})
const serverName = process.argv[2]

if (!SERVER_NAMES.has(serverName)) {
  fail(\`Unknown NodeSource MCP server: \${serverName ?? '(missing)'}\`)
}

const credentials = readCredentials()
const server = resolveServer(serverName, credentials)
await runMcpRemote(server.url, server.headers)

function readCredentials () {
  if (!existsSync(AUTH_FILE)) {
    fail(\`NodeSource credentials not found. Run: \${SETUP_COMMAND}\`)
  }

  let parsed
  try {
    parsed = JSON.parse(readFileSync(AUTH_FILE, 'utf8'))
  } catch (err) {
    fail(\`NodeSource credentials are unreadable. Run: npx -y nsolid-plugin logout && \${SETUP_COMMAND}. \${err.message}\`)
  }

  const required = ['serviceToken', 'organizationId', 'consoleUrl', 'expiresAt']
  const missing = required.filter((key) => typeof parsed?.[key] !== 'string' || parsed[key].length === 0)
  if (missing.length > 0) {
    fail(\`NodeSource credentials are incomplete (\${missing.join(', ')} missing). Run: \${SETUP_COMMAND}\`)
  }

  const expiresAt = Date.parse(parsed.expiresAt)
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    fail(\`NodeSource credentials are expired. Run: \${SETUP_COMMAND}\`)
  }

  return parsed
}

function resolveServer (name, credentials) {
  switch (name) {
    case 'nsolid-console': {
      const derivedUrl = credentials.mcpUrl ? null : deriveMcpUrlFromConsoleUrl(credentials.consoleUrl)
      const url = credentials.mcpUrl ?? derivedUrl
      if (!url) {
        fail(\`Could not derive NodeSource console MCP URL from stored credentials. Run: \${SETUP_COMMAND}\`)
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
      fail(\`Unknown NodeSource MCP server: \${name}\`)
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
    mcpHost = host.replace(/\\.staging\\.saas\\.nodesource\\.io$/, '.mcp.staging.saas.nodesource.io')
  } else if (host.endsWith('.saas.nodesource.io')) {
    mcpHost = host.replace(/\\.saas\\.nodesource\\.io$/, '.mcp.saas.nodesource.io')
  }

  return mcpHost ? \`\${parsed.protocol}//\${mcpHost}/\` : null
}

async function runMcpRemote (url, headers) {
  const headerArgs = Object.entries(headers).flatMap(([key, value]) => ['--header', \`\${key}:\${value}\`])

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
  console.error(\`[nsolid-plugin] \${message}\`)
  process.exit(1)
}
`
}
