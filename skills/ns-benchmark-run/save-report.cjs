#!/usr/bin/env node
// save-report.cjs — persists a markdown report to .nsolid/assets/ and updates reports-index.json.
// Usage: node save-report.cjs <type> <title> <markdown-file> [appName]
// Note: This script is designed for single-process/single-agent use.
// Concurrent executions may race on reports-index.json updates.

'use strict'

const fs = require('fs')
const path = require('path')

const VALID_TYPES = new Set([
  'security-audit',
  'lockfile-analysis',
  'package-check',
  'profile-analysis',
  'asset-analysis',
  'event-analysis',
  'cpu-analysis',
  'memory-analysis',
  'benchmark',
  'general-analysis'
])

function writeStdout (message) {
  fs.writeSync(process.stdout.fd, message)
}

function writeStderr (message) {
  fs.writeSync(process.stderr.fd, message)
}

let saveSeq = 0

function isWorkspaceRoot (dir) {
  return fs.existsSync(path.join(dir, 'package.json')) ||
    fs.existsSync(path.join(dir, '.git')) ||
    fs.existsSync(path.join(dir, '.vscode', 'settings.json'))
}

function findWorkspaceRoot () {
  const seen = new Set()
  const candidates = [
    process.env.INIT_CWD,
    process.cwd(),
    path.resolve(__dirname)
  ].filter(Boolean)

  for (const candidate of candidates) {
    let dir = path.resolve(candidate)

    while (!seen.has(dir)) {
      seen.add(dir)

      if (isWorkspaceRoot(dir)) {
        return dir
      }

      const parent = path.dirname(dir)
      if (parent === dir) {
        break
      }
      dir = parent
    }
  }

  return path.resolve(process.cwd())
}

function ensureReportsDir (workspaceRoot) {
  const nsolidDir = path.join(workspaceRoot, '.nsolid')
  const reportsDir = path.join(nsolidDir, 'assets')

  fs.mkdirSync(reportsDir, { recursive: true })

  const gitignorePath = path.join(nsolidDir, '.gitignore')
  if (!fs.existsSync(gitignorePath)) {
    fs.writeFileSync(gitignorePath, '*\n', 'utf-8')
  }

  return reportsDir
}

function extractSummary (content) {
  const summaryMatch = content.match(/## Summary\s*\n([\s\S]*?)(?=\n---|\n##|$)/)
  if (summaryMatch?.[1]) {
    return summaryMatch[1].trim().slice(0, 200)
  }

  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (
      trimmed &&
      !trimmed.startsWith('#') &&
      !trimmed.startsWith('---') &&
      !trimmed.startsWith('**Date')
    ) {
      return trimmed.slice(0, 200)
    }
  }

  return ''
}

function cleanAppName (value) {
  if (typeof value !== 'string') {
    return undefined
  }

  const cleaned = value
    .replace(/[`*]/g, '')
    .trim()

  if (cleaned.length === 0 || cleaned.toLowerCase() === 'unknown') {
    return undefined
  }

  return cleaned
}

function inferAppName (title, content) {
  const titlePatterns = [
    /^Event Analysis\s+[—-]\s+(.+?)\s+[—-]\s+(?:performance|security|lifecycle|error)$/i,
    /^CPU Analysis\s+[—-]\s+(.+?)\s+[—-]\s+\d{4}-\d{2}-\d{2}(?:\s+\+\s+Optimization)?$/i,
    /^CPU Analysis\s+[—-]\s+(.+?)\s+\+\s+Optimization$/i,
    /^Memory Analysis\s+[—-]\s+(.+?)\s+[—-]\s+.+$/i
  ]

  for (const pattern of titlePatterns) {
    const value = cleanAppName(title.match(pattern)?.[1])
    if (value) {
      return value
    }
  }

  const contentPatterns = [
    /^\*\*Application\*\*:\s*(.+)$/mi,
    /^Application:\s*(.+)$/mi
  ]

  for (const pattern of contentPatterns) {
    const value = cleanAppName(content.match(pattern)?.[1])
    if (value) {
      return value
    }
  }

  return undefined
}

function readReportsIndex (reportsDir) {
  const indexPath = path.join(reportsDir, 'reports-index.json')

  try {
    if (fs.existsSync(indexPath)) {
      return JSON.parse(fs.readFileSync(indexPath, 'utf-8'))
    }
  } catch (error) {
    writeStderr(`Warning: Could not read reports index (${error.message}). Starting fresh.\n`)
    return []
  }

  return []
}

function writeReportsIndex (reportsDir, entries) {
  const indexPath = path.join(reportsDir, 'reports-index.json')
  try {
    fs.writeFileSync(indexPath, JSON.stringify(entries, null, 2), 'utf-8')
  } catch (error) {
    writeStderr(`Error writing reports index: ${error.message}\n`)
    throw error
  }
}

function saveMetadata (reportsDir, metadata) {
  const entries = readReportsIndex(reportsDir)
  entries.push(metadata)
  writeReportsIndex(reportsDir, entries)
}

function main () {
  const [,, type, title, markdownPath, explicitAppName] = process.argv

  if (!type || !title || !markdownPath) {
    writeStderr('Usage: node save-report.cjs <type> <title> <markdown-file> [appName]\n')
    process.exit(1)
  }

  if (!VALID_TYPES.has(type)) {
    writeStderr(`Unsupported report type: ${type}. Use one of: ${Array.from(VALID_TYPES).join(', ')}\n`)
    process.exit(1)
  }

  const resolvedMarkdownPath = path.resolve(markdownPath)
  if (!fs.existsSync(resolvedMarkdownPath)) {
    writeStderr(`Markdown file not found: ${resolvedMarkdownPath}\n`)
    process.exit(1)
  }

  const content = fs.readFileSync(resolvedMarkdownPath, 'utf-8')
  const workspaceRoot = findWorkspaceRoot()
  const reportsDir = ensureReportsDir(workspaceRoot)
  const now = new Date()
  const timestamp = now.toISOString()
  const dateStr = timestamp.replace(/[:.]/g, '-').slice(0, 23)
  const seq = String(++saveSeq).padStart(3, '0')
  const fileName = `${type}-${dateStr}-${seq}.md`
  const outputPath = path.join(reportsDir, fileName)

  fs.writeFileSync(outputPath, content, 'utf-8')

  const appName = cleanAppName(explicitAppName) || inferAppName(title, content)
  saveMetadata(reportsDir, {
    id: `${type}-${dateStr}-${seq}`,
    title,
    type,
    timestamp,
    fileName,
    summary: extractSummary(content),
    ...(appName ? { appName } : {})
  })

  writeStdout(`${outputPath}\n`)
}

main()
