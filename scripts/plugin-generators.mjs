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

/**
 * Exact mcp-remote version pinned for the shared bridge runtime.
 * Keep in sync with packages/core/src/mcp/mcp-remote-runtime.ts and the root
 * package.json dependency (guarded by a unit test).
 */
export const MCP_REMOTE_VERSION = '0.1.38'

// Keep in sync with packages/core/src/types.ts (guarded by a unit test).
export const HARNESS_VALUES = ['claude', 'codex', 'opencode', 'antigravity', 'pi']

const CODEX_MCP_STARTUP_TIMEOUT_SEC = 60

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
  return generateMcpConfig('$' + '{CLAUDE_PLUGIN_ROOT}/scripts/mcp-wrapper.js', bundle, 'claude')
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
      startup_timeout_sec: CODEX_MCP_STARTUP_TIMEOUT_SEC,
    }
  }
  return stableJson({ mcpServers })
}

export function generateCodexBootstrap () {
  // Fail closed: only trust wrappers positively identified as this plugin's
  // install root (a path segment matching `nsolid-plugin`). Never fall back to
  // an unrelated discovered scripts/mcp-wrapper.js.
  // eslint-disable-next-line no-template-curly-in-string -- codegen: ${path.sep} must stay literal in the generated bootstrap string, it is evaluated at runtime in the host process
  return "const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const {pathToFileURL}=require('node:url');const serverName=process.argv[1];const rel=['scripts','mcp-wrapper.js'];const roots=[path.join(os.homedir(),'.codex','plugins','cache'),process.cwd()];const candidates=[];for(const root of roots){try{const stack=[root];while(stack.length){const dir=stack.pop();if(!fs.existsSync(dir))continue;const direct=path.join(dir,...rel);if(fs.existsSync(direct))candidates.push(direct);for(const entry of fs.readdirSync(dir,{withFileTypes:true})){if(entry.isDirectory())stack.push(path.join(dir,entry.name))}}}catch{}}const wrapper=candidates.find((p)=>p.includes(`${path.sep}nsolid-plugin${path.sep}`));if(!wrapper){console.error('[nsolid-plugin] Could not locate Codex MCP wrapper. Reinstall with: codex plugin marketplace add NodeSource/nsolid-plugin && codex plugin add nsolid-plugin@nodesource');process.exit(1)}process.argv=[process.execPath,wrapper,serverName,'codex'];import(pathToFileURL(wrapper).href)"
}

export function generateAntigravityBootstrap () {
  return "const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const {pathToFileURL}=require('node:url');const serverName=process.argv[1];const rel=['scripts','mcp-wrapper.js'];const candidates=[path.join(os.homedir(),'.gemini','config','plugins','nsolid-plugin',...rel),path.join(os.homedir(),'.gemini','antigravity-cli','plugins','nsolid-plugin',...rel),path.join(process.cwd(),'packages','antigravity-plugin',...rel),path.join(process.cwd(),...rel)];const wrapper=candidates.find((p)=>fs.existsSync(p));if(!wrapper){console.error('[nsolid-plugin] Could not locate Antigravity MCP wrapper. Reinstall with: agy plugin install https://github.com/NodeSource/nsolid-plugin.git');process.exit(1)}process.argv=[process.execPath,wrapper,serverName,'antigravity'];import(pathToFileURL(wrapper).href)"
}

export function generateMcpConfig (wrapperPath, bundle, harness) {
  const b = getBundle(bundle)
  const mcpServers = {}
  for (const server of b.mcpServers) {
    mcpServers[server.name] = {
      command: 'node',
      args: [wrapperPath, server.name, harness],
    }
  }
  return stableJson({ mcpServers })
}

export function generateMcpWrapper () {
  const serverNames = [...defaultBundle.mcpServers.map((s) => s.name)]
  const serverNamesLiteral = serverNames.map((name) => `'${name}'`).join(', ')
  const harnessLiteral = HARNESS_VALUES.map((name) => `'${name}'`).join(', ')
  return `#!/usr/bin/env node

// STDIO→HTTP bridge for the NodeSource MCP servers. Resolves mcp-remote
// exclusively from local copies: the shared runtime provisioned by
// \`nsolid-plugin setup\` (~/.agents/nsolid-plugin/runtime/mcp-remote/<version>),
// or a version-matched development checkout. It NEVER invokes npx, npm, a
// shell, or cmd.exe during startup — a missing runtime fails fast with the
// repair command instead of downloading anything.

import { createRequire } from 'node:module'
import { existsSync, readFileSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const MCP_REMOTE_VERSION = '${MCP_REMOTE_VERSION}'
const AUTH_FILE = path.join(os.homedir(), '.agents', '.nodesource-auth.json')
const SERVER_NAMES = new Set([${serverNamesLiteral}])
const HARNESS_NAMES = new Set([${harnessLiteral}])
const serverName = process.argv[2]
const harness = process.argv[3]

if (!SERVER_NAMES.has(serverName)) {
  fail(\`Unknown NodeSource MCP server: \${serverName ?? '(missing)'}\`)
}
if (!HARNESS_NAMES.has(harness)) {
  fail(\`Invalid harness argument: \${harness ?? '(missing)'}\`)
}

const credentials = readCredentials()
const server = resolveServer(serverName, credentials)
await runMcpRemote(server.url, server.headers)

function readCredentials () {
  if (!existsSync(AUTH_FILE)) {
    fail(\`NodeSource credentials not found. Run: \${SETUP_COMMAND()}\`)
  }

  let parsed
  try {
    parsed = JSON.parse(readFileSync(AUTH_FILE, 'utf8'))
  } catch (err) {
    fail(\`NodeSource credentials are unreadable. Run: npx -y nsolid-plugin logout && \${SETUP_COMMAND()}. \${err.message}\`)
  }

  const required = ['serviceToken', 'organizationId', 'consoleUrl', 'expiresAt']
  const missing = required.filter((key) => typeof parsed?.[key] !== 'string' || parsed[key].length === 0)
  if (missing.length > 0) {
    fail(\`NodeSource credentials are incomplete (\${missing.join(', ')} missing). Run: \${SETUP_COMMAND()}\`)
  }

  const expiresAt = Date.parse(parsed.expiresAt)
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    fail(\`NodeSource credentials are expired. Run: \${SETUP_COMMAND()}\`)
  }

  return parsed
}

function resolveServer (name, credentials) {
  switch (name) {
    case 'nsolid-console': {
      const derivedUrl = credentials.mcpUrl ? null : deriveMcpUrlFromConsoleUrl(credentials.consoleUrl)
      const url = credentials.mcpUrl ?? derivedUrl
      if (!url) {
        fail(\`Could not derive NodeSource console MCP URL from stored credentials. Run: \${SETUP_COMMAND()}\`)
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

  if (host.endsWith('.saas.nodesource.io')) {
    mcpHost = host.replace(/\\.saas\\.nodesource\\.io$/, '.mcp.saas.nodesource.io')
  }

  return mcpHost ? \`\${parsed.protocol}//\${mcpHost}/\` : null
}

function SETUP_COMMAND () {
  return \`npx -y nsolid-plugin setup --harness \${harness}\`
}

function resolveProxyPath () {
  // 1. Stable shared runtime provisioned by \`nsolid-plugin setup\`.
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
    fail(\`MCP bridge runtime is not ready. Run: \${SETUP_COMMAND()}\`)
  }

  // URL and headers are handed to the imported proxy as separate argv
  // elements; no shell is ever involved.
  const headerArgs = Object.entries(headers).flatMap(([key, value]) => ['--header', \`\${key}:\${value}\`])
  process.argv = [process.execPath, proxyPath, url, ...headerArgs, '--transport', 'http-first', '--silent']
  await import(pathToFileURL(proxyPath).href)
}

function fail (message) {
  console.error(\`[nsolid-plugin] \${message}\`)
  process.exit(1)
}
`
}
