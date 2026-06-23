#!/usr/bin/env node
/**
 * Build generated plugin artifacts for marketplace/local install flows.
 *
 * Source of truth:
 *   - bundle.json
 *   - packages/core/skills/
 *   - plugins/templates/
 *
 * Output:
 *   dist/plugins/<harness>/nsolid-plugin/
 *   dist/artifacts/nsolid-<harness>-plugin.tgz
 *
 * Usage:
 *   node scripts/build-plugin-artifacts.mjs
 *   node scripts/build-plugin-artifacts.mjs --check
 *   node scripts/build-plugin-artifacts.mjs --harness antigravity
 *   node scripts/build-plugin-artifacts.mjs --no-archive
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  readFileSync,
  writeFileSync,
  renameSync,
} from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import {
  loadBundle,
  generateClaudePluginJson,
  generateClaudeMarketplaceJson,
  generateClaudeMcpJson,
  generateClaudeWrapper,
  generateAntigravityPluginJson,
  generateAntigravityMcpJson,
  generateAntigravityWrapper,
  generateCodexPluginJson,
  generateCodexMarketplaceJson,
  generateCodexMcpJson,
  generateCodexWrapper,
  readPluginPkgVersion,
} from './plugin-generators.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = process.env.NSOLID_PLUGIN_ARTIFACTS_ROOT
  ? path.resolve(process.env.NSOLID_PLUGIN_ARTIFACTS_ROOT)
  : path.resolve(__dirname, '..')

const CHECK_MODE = process.argv.includes('--check')
const NO_ARCHIVE = process.argv.includes('--no-archive')
const HARNESS_ARG = process.argv.find((arg, i) => i > 0 && process.argv[i - 1] === '--harness')

const CORE_SKILLS_DIR = path.join(ROOT, 'packages', 'core', 'skills')
const TEMPLATES_DIR = path.join(ROOT, 'plugins', 'templates')
const DIST_DIR = path.join(ROOT, 'dist')
const PLUGINS_DIST_DIR = path.join(DIST_DIR, 'plugins')
const ARTIFACTS_DIR = path.join(DIST_DIR, 'artifacts')

const bundle = loadBundle(ROOT)
const skillNames = bundle.skills.map((skill) => skill.name)
const skillNamesSet = new Set(skillNames)

const HARNESSES = [
  {
    id: 'claude',
    artifactName: 'nsolid-claude-plugin',
    templateDir: path.join(TEMPLATES_DIR, 'claude'),
    generatedFiles: {
      '.claude-plugin/plugin.json': () => generateClaudePluginJson(readPluginPkgVersion(path.join(TEMPLATES_DIR, 'claude')), bundle),
      '.claude-plugin/marketplace.json': () => generateClaudeMarketplaceJson(bundle),
      '.mcp.json': () => generateClaudeMcpJson(bundle),
      'scripts/mcp-wrapper.js': generateClaudeWrapper,
    },
  },
  {
    id: 'antigravity',
    artifactName: 'nsolid-antigravity-plugin',
    templateDir: path.join(TEMPLATES_DIR, 'antigravity'),
    generatedFiles: {
      'plugin.json': () => generateAntigravityPluginJson(bundle),
      'mcp_config.json': () => generateAntigravityMcpJson(bundle),
      'scripts/mcp-wrapper.js': generateAntigravityWrapper,
    },
  },
  {
    id: 'codex',
    artifactName: 'nsolid-codex-plugin',
    templateDir: path.join(TEMPLATES_DIR, 'codex'),
    generatedFiles: {
      '.agents/plugins/marketplace.json': () => generateCodexMarketplaceJson(bundle),
      '.codex-plugin/plugin.json': () => generateCodexPluginJson(readPluginPkgVersion(path.join(TEMPLATES_DIR, 'codex')), bundle),
      '.mcp.json': () => generateCodexMcpJson(bundle),
      'scripts/mcp-wrapper.js': generateCodexWrapper,
    },
    nestedPlugin: {
      dir: path.join('plugins', 'nsolid-plugin'),
      generatedFiles: {
        '.codex-plugin/plugin.json': () => generateCodexPluginJson(readPluginPkgVersion(path.join(TEMPLATES_DIR, 'codex')), bundle),
        '.mcp.json': () => generateCodexMcpJson(bundle),
        'scripts/mcp-wrapper.js': generateCodexWrapper,
      },
    },
  },
]

if (HARNESS_ARG && !HARNESSES.some((h) => h.id === HARNESS_ARG)) {
  console.error(`Invalid harness: ${HARNESS_ARG}. Valid options: ${HARNESSES.map((h) => h.id).join(', ')}`)
  process.exit(1)
}

const harnessesToBuild = HARNESS_ARG
  ? HARNESSES.filter((h) => h.id === HARNESS_ARG)
  : HARNESSES

let driftDetected = false

for (const harness of harnessesToBuild) {
  const artifactDir = path.join(PLUGINS_DIST_DIR, harness.id, 'nsolid-plugin')

  if (!CHECK_MODE) {
    if (existsSync(artifactDir)) {
      rmSync(artifactDir, { recursive: true, force: true })
    }
    mkdirSync(artifactDir, { recursive: true })
  }

  // Copy template tree.
  const templateDrift = copyTemplate(harness.templateDir, artifactDir, CHECK_MODE)
  if (templateDrift) driftDetected = true

  // Generate harness-specific files.
  const fileDrift = syncGeneratedFiles(harness.generatedFiles, artifactDir, CHECK_MODE)
  if (fileDrift) driftDetected = true

  // Materialize skills.
  const skillsDrift = materializeSkills(artifactDir, CHECK_MODE)
  if (skillsDrift) driftDetected = true

  // Generate nested Codex marketplace plugin if configured.
  if (harness.nestedPlugin) {
    const nestedDir = path.join(artifactDir, harness.nestedPlugin.dir)
    const nestedFileDrift = syncGeneratedFiles(harness.nestedPlugin.generatedFiles, nestedDir, CHECK_MODE)
    if (nestedFileDrift) driftDetected = true

    const nestedSkillsDrift = materializeSkills(nestedDir, CHECK_MODE)
    if (nestedSkillsDrift) driftDetected = true
  }

  // Build archive.
  if (!CHECK_MODE && !NO_ARCHIVE) {
    buildArchive(artifactDir, harness.artifactName)
  }
}

if (driftDetected) {
  if (CHECK_MODE) {
    console.error('plugin:artifacts:check failed: generated plugin artifacts are out of sync.')
    process.exit(1)
  }
  console.log('plugin:artifacts completed.')
} else {
  console.log('plugin:artifacts up to date.')
}

function copyTemplate (src, dst, checkMode) {
  if (!existsSync(src)) {
    if (checkMode) {
      console.error(`Missing template dir: ${path.relative(ROOT, src)}`)
      return true
    }
    throw new Error(`Missing template dir: ${src}`)
  }

  if (checkMode) {
    // In check mode verify every template file is present and byte-identical in
    // the artifact. The artifact also contains generated files and skills, so
    // the full directory will intentionally have extra entries.
    if (!existsSync(dst)) {
      console.error(`Missing artifact dir: ${path.relative(ROOT, dst)}`)
      return true
    }
    const drift = !templateSubsetEquals(src, dst)
    if (drift) console.error(`Template drift detected: ${path.relative(ROOT, dst)}`)
    return drift
  }

  cpSync(src, dst, { recursive: true, dereference: true })
  return false
}

function syncGeneratedFiles (generatedFiles, targetDir, checkMode) {
  let drift = false
  for (const [relPath, generator] of Object.entries(generatedFiles)) {
    const targetPath = path.join(targetDir, relPath)
    const expected = generator()
    const actual = existsSync(targetPath) ? readFileSync(targetPath, 'utf8') : null
    if (actual !== expected) {
      drift = true
      if (checkMode) {
        console.error(`Drift detected: ${path.relative(ROOT, targetPath)}`)
      } else {
        mkdirSync(path.dirname(targetPath), { recursive: true })
        writeFileSync(targetPath, expected, 'utf8')
      }
    }
  }
  return drift
}

function materializeSkills (targetDir, checkMode) {
  const destSkillsDir = path.join(targetDir, 'skills')
  let drift = false

  if (existsSync(destSkillsDir)) {
    for (const entry of readdirSync(destSkillsDir)) {
      const entryPath = path.join(destSkillsDir, entry)
      const stat = statSync(entryPath)
      if (stat.isDirectory() && !skillNamesSet.has(entry)) {
        drift = true
        if (checkMode) {
          console.error(`Stale skill dir: ${path.relative(ROOT, entryPath)}`)
        } else {
          rmSync(entryPath, { recursive: true, force: true })
        }
      }
    }
  }

  for (const skillName of skillNames) {
    const srcDir = path.join(CORE_SKILLS_DIR, skillName)
    const dstDir = path.join(destSkillsDir, skillName)

    if (!directoryEquals(srcDir, dstDir)) {
      drift = true
      if (checkMode) {
        console.error(`Drift detected: ${path.relative(ROOT, dstDir)}`)
      } else {
        mkdirSync(destSkillsDir, { recursive: true })
        rmSync(dstDir, { recursive: true, force: true })
        cpSync(srcDir, dstDir, { recursive: true, dereference: true })
      }
    }
  }

  return drift
}

function templateSubsetEquals (src, dst) {
  if (!existsSync(dst)) return false

  for (const entry of readdirSync(src)) {
    const srcPath = path.join(src, entry)
    const dstPath = path.join(dst, entry)
    if (!existsSync(dstPath)) return false

    const srcStat = statSync(srcPath)
    const dstStat = statSync(dstPath)
    if (srcStat.isDirectory() !== dstStat.isDirectory()) return false

    if (srcStat.isDirectory()) {
      if (!templateSubsetEquals(srcPath, dstPath)) return false
    } else {
      const srcBuf = readFileSync(srcPath)
      const dstBuf = readFileSync(dstPath)
      if (Buffer.compare(srcBuf, dstBuf) !== 0) return false
    }
  }

  return true
}

function directoryEquals (src, dst) {
  if (!existsSync(dst)) return false

  const srcEntries = readdirSync(src).sort()
  const dstEntries = readdirSync(dst).sort()

  if (srcEntries.length !== dstEntries.length) return false

  for (let i = 0; i < srcEntries.length; i++) {
    if (srcEntries[i] !== dstEntries[i]) return false

    const srcPath = path.join(src, srcEntries[i])
    const dstPath = path.join(dst, dstEntries[i])
    const srcStat = statSync(srcPath)
    const dstStat = statSync(dstPath)

    if (srcStat.isDirectory() !== dstStat.isDirectory()) return false

    if (srcStat.isDirectory()) {
      if (!directoryEquals(srcPath, dstPath)) return false
    } else {
      const srcBuf = readFileSync(srcPath)
      const dstBuf = readFileSync(dstPath)
      if (Buffer.compare(srcBuf, dstBuf) !== 0) return false
    }
  }

  return true
}

function buildArchive (artifactDir, artifactName) {
  mkdirSync(ARTIFACTS_DIR, { recursive: true })
  const result = spawnSync(
    'npm',
    ['pack', artifactDir, '--pack-destination', ARTIFACTS_DIR],
    { encoding: 'utf-8', stdio: 'pipe' }
  )

  if (result.status !== 0) {
    throw new Error(`npm pack failed for ${artifactName}: ${result.stderr}`)
  }

  // npm pack produces a file named like @nodesource-claude-plugin-0.1.0.tgz.
  // Rename it to the canonical artifact name.
  const pkg = JSON.parse(readFileSync(path.join(artifactDir, 'package.json'), 'utf8'))
  const producedName = pkg.name.replace('@', '').replace('/', '-') + `-${pkg.version}.tgz`
  const producedPath = path.join(ARTIFACTS_DIR, producedName)
  const targetPath = path.join(ARTIFACTS_DIR, `${artifactName}.tgz`)

  if (!existsSync(producedPath)) {
    throw new Error(`npm pack produced no tarball at expected path: ${producedPath}`)
  }
  if (existsSync(targetPath)) rmSync(targetPath)
  renameSync(producedPath, targetPath)
  console.log(`Wrote ${path.relative(ROOT, targetPath)}`)
}
