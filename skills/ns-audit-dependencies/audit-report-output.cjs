'use strict'

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { renderAuditReport, renderAuditSummary, validateAuditSummary } = require('./render-audit-report.cjs')

const RETRYABLE_TRANSPORT_REASONS = new Set(['network', 'rate-limit', 'server', 'timeout'])

function reportTimestamp (now) {
  const date = now instanceof Date ? now : new Date(now)
  if (Number.isNaN(date.getTime())) throw new Error('Invalid audit report timestamp')
  return date.toISOString().replace(/[:.]/g, '-')
}

function auditOutputError (code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function allPackagesUncheckedFor (summary, allowedReasons) {
  return summary.packages.total > 0 &&
    summary.packages.checked === 0 &&
    summary.packages.unchecked === summary.packages.total &&
    summary.uncheckedPackages.every(pkg => allowedReasons.has(pkg.reason))
}

function assertPublishableAuditSummary (summary) {
  validateAuditSummary(summary)
  if (allPackagesUncheckedFor(summary, RETRYABLE_TRANSPORT_REASONS)) {
    const reasons = Array.from(new Set(summary.uncheckedPackages.map(pkg => pkg.reason))).sort()
    throw auditOutputError(
      'AUDIT_REPORT_RETRY_REQUIRED',
      `All ${summary.packages.total} package versions were unchecked due to retryable transport failures (${reasons.join(', ')}); no report was saved.`
    )
  }
  if (allPackagesUncheckedFor(summary, new Set(['authentication']))) {
    throw auditOutputError(
      'AUDIT_REPORT_AUTHENTICATION_REQUIRED',
      `All ${summary.packages.total} package versions were unchecked because NCM authentication failed; no report was saved.`
    )
  }
}

async function saveAuditReport (projectDir, markdown, options = {}) {
  const now = options.now || new Date()
  const assetsDir = path.resolve(projectDir, '.nsolid', 'assets')
  const baseName = `dependency-audit-${reportTimestamp(now)}`
  const contents = markdown.endsWith('\n') ? markdown : `${markdown}\n`
  const tempPath = path.join(assetsDir, `.${baseName}-${process.pid}-${crypto.randomUUID()}.tmp`)

  await fs.promises.mkdir(assetsDir, { recursive: true, mode: 0o700 })
  try {
    await fs.promises.writeFile(tempPath, contents, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    for (let collision = 0; ; collision++) {
      const suffix = collision === 0 ? '' : `-${collision + 1}`
      const reportPath = path.join(assetsDir, `${baseName}${suffix}.md`)
      try {
        await fs.promises.link(tempPath, reportPath)
        return reportPath
      } catch (error) {
        if (!error || error.code !== 'EEXIST') throw error
      }
    }
  } finally {
    await fs.promises.unlink(tempPath).catch(error => {
      if (!error || error.code !== 'ENOENT') throw error
    })
  }
}

async function createSavedAuditOutput (summary, projectDir, options = {}) {
  assertPublishableAuditSummary(summary)
  const report = `${renderAuditReport(summary)}\n`
  const reportPath = await saveAuditReport(projectDir, report, options)
  const executiveSummary = `${renderAuditSummary(summary, reportPath)}\n`
  return { executiveSummary, report, reportPath }
}

module.exports = { assertPublishableAuditSummary, createSavedAuditOutput, reportTimestamp, saveAuditReport }
