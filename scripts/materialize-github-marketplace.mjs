#!/usr/bin/env node
/**
 * Materialize (or check) the GitHub-installable root marketplace/plugin layout.
 *
 * The repository root is intentionally both:
 *   - a Claude marketplace root (.claude-plugin/marketplace.json)
 *   - a Codex marketplace root (.agents/plugins/marketplace.json)
 *   - an Antigravity plugin root (plugin.json)
 *
 * This mirrors repos like addyosmani/agent-skills and lets the same GitHub URL
 * work across all three harnesses.
 *
 * Generated output at repo root:
 *   .claude-plugin/marketplace.json
 *   .claude-plugin/plugin.json
 *   .agents/plugins/marketplace.json
 *   .codex-plugin/plugin.json
 *   .claude-mcp.json
 *   .mcp.json
 *   plugin.json
 *   mcp_config.json
 *   scripts/mcp-wrapper.js
 *
 * Canonical skill source (not generated here):
 *   skills/
 *
 * Usage:
 *   node scripts/materialize-github-marketplace.mjs           # write root manifests
 *   node scripts/materialize-github-marketplace.mjs --check    # fail if committed manifests drift from bundle.json
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  generateAntigravityMcpJson,
  generateAntigravityPluginJson,
  generateClaudeMcpJson,
  generateClaudePluginJson,
  generateClaudeWrapper,
  generateCodexMcpJson,
  generateCodexPluginJson,
  loadBundle,
  stableJson,
} from './plugin-generators.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = process.env.NSOLID_PLUGIN_MARKETPLACE_ROOT
  ? path.resolve(process.env.NSOLID_PLUGIN_MARKETPLACE_ROOT)
  : path.resolve(__dirname, '..')

const MARKETPLACE_NAME = process.env.NSOLID_PLUGIN_MARKETPLACE_NAME ?? 'nodesource'
const SKILLS_DIR = path.join(ROOT, 'skills')
const CHECK_MODE = process.argv.includes('--check')

const bundle = loadBundle(ROOT)

validateCanonicalSkills()

const expectedFiles = buildExpectedFiles()
const drifted = CHECK_MODE ? checkFiles(expectedFiles) : writeFiles(expectedFiles)

if (CHECK_MODE) {
  if (drifted.length > 0) {
    console.error('plugin:root:check FAILED — root manifests are out of sync with bundle.json.')
    for (const rel of drifted) console.error(`  DRIFT: ${rel}`)
    console.error('Run "pnpm plugin:root" to regenerate, then commit the result.')
    process.exit(1)
  }
  console.log('plugin:root:check OK — root manifests match bundle.json.')
} else {
  console.log(`Materialized GitHub marketplace/plugin layout at repository root (${expectedFiles.size} files).`)
}

function buildExpectedFiles () {
  const files = new Map()

  files.set('.claude-plugin/marketplace.json', stableJson({
    name: MARKETPLACE_NAME,
    owner: { name: 'NodeSource' },
    description: 'NodeSource agent plugins',
    plugins: [
      {
        name: bundle.name,
        source: './',
        displayName: 'N|Solid Plugin',
        version: bundle.version,
        description: 'N|Solid performance & security skills + MCP servers',
        author: { name: 'NodeSource' },
        homepage: 'https://nodesource.com',
        repository: 'https://github.com/NodeSource/nsolid-plugin',
        license: 'MIT',
        category: 'developer-tools',
        tags: ['nodesource', 'nsolid', 'nodejs', 'performance', 'security'],
      },
    ],
  }))

  files.set('.agents/plugins/marketplace.json', stableJson({
    name: MARKETPLACE_NAME,
    interface: {
      displayName: 'NodeSource',
    },
    plugins: [
      {
        name: bundle.name,
        source: {
          source: 'local',
          path: './',
        },
        policy: {
          installation: 'AVAILABLE',
          authentication: 'ON_USE',
          products: ['CODEX'],
        },
        category: 'Developer Tools',
      },
    ],
  }))

  const claudeManifest = JSON.parse(generateClaudePluginJson(bundle.version, bundle))
  claudeManifest.mcpServers = './.claude-mcp.json'
  files.set('.claude-plugin/plugin.json', stableJson(claudeManifest))

  const codexManifest = JSON.parse(generateCodexPluginJson(bundle.version, bundle))
  codexManifest.mcpServers = './.mcp.json'
  files.set('.codex-plugin/plugin.json', stableJson(codexManifest))

  files.set('.claude-mcp.json', generateClaudeMcpJson(bundle))
  files.set('.mcp.json', generateCodexMcpJson(bundle))
  files.set('plugin.json', generateAntigravityPluginJson(bundle))
  files.set('mcp_config.json', generateAntigravityMcpJson(bundle))
  files.set('scripts/mcp-wrapper.js', generateSharedWrapper())

  return files
}

function validateCanonicalSkills () {
  for (const skill of bundle.skills) {
    const skillPath = path.join(SKILLS_DIR, skill.name, 'SKILL.md')
    if (!existsSync(skillPath)) {
      throw new Error(`Missing canonical skill: ${path.relative(ROOT, skillPath)}`)
    }
  }
}

function generateSharedWrapper () {
  return generateClaudeWrapper()
    .replace(
      "const SETUP_COMMAND = 'npx -y @nodesource/nsolid-plugin setup --harness claude'",
      "const SETUP_COMMAND = 'npx -y nsolid-plugin setup --harness <claude|codex|antigravity|agents>'"
    )
}

function writeFiles (files) {
  for (const [relPath, content] of files) writeFile(relPath, content)
  return []
}

function checkFiles (files) {
  const drifted = []
  for (const [relPath, expected] of files) {
    const targetPath = path.join(ROOT, relPath)
    let actual = ''
    if (existsSync(targetPath)) {
      actual = readFileSync(targetPath, 'utf8')
    }
    if (actual !== expected) drifted.push(relPath)
  }
  return drifted
}

function writeFile (relPath, content) {
  const targetPath = path.join(ROOT, relPath)
  const parent = path.dirname(targetPath)
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true })
  writeFileSync(targetPath, content, 'utf8')
}
