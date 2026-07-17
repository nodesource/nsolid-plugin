import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(import.meta.url)
const { renderAuditReport, validateAuditSummary } = require('../../../../../skills/ns-audit-dependencies/render-audit-report.cjs') as {
  renderAuditReport: (summary: Record<string, any>) => string
  validateAuditSummary: (summary: Record<string, any>) => Record<string, number>
}

function finding (index: number, vulnerabilityCount = 1): Record<string, any> {
  return {
    name: index % 2 === 0 ? 'shared-package' : `package-${index}`,
    version: `1.0.${index}`,
    direct: index === 0,
    severity: 'HIGH',
    vulnerabilities: Array.from({ length: vulnerabilityCount }, (_, record) => ({
      severity: 'HIGH',
      id: record < 2 ? 'GHSA-duplicate' : `GHSA-${index}-${record}`,
      title: record < 2 ? 'Duplicate title' : `Issue ${record}`,
      vulnerable: ['< 2.0.0'],
      patched: ['>= 2.0.0']
    })),
    license: { pass: true, spdx: 'MIT' },
    moduleRisks: [],
    codeQuality: [],
    remediation: index % 3 === 0
      ? { status: 'ncm-verified', version: '2.0.0', source: 'latest-fallback', changeType: 'major' }
      : { status: 'unresolved' }
  }
}

function summaryFor (findings: Array<Record<string, any>>, uncheckedPackages: Array<Record<string, string>> = []): Record<string, any> {
  const vulnerabilityTotal = findings.reduce((total, item) => total + item.vulnerabilities.length, 0)
  const verified = findings.filter(item => item.remediation.status === 'ncm-verified').length
  const unresolved = findings.filter(item => item.remediation.status === 'unresolved').length
  const uncheckedByReason: Record<string, number> = {}
  for (const item of uncheckedPackages) uncheckedByReason[item.reason] = (uncheckedByReason[item.reason] || 0) + 1
  return {
    packageManager: 'pnpm',
    packages: {
      total: findings.length + uncheckedPackages.length,
      direct: 1,
      transitive: Math.max(0, findings.length - 1),
      checked: findings.length,
      unchecked: uncheckedPackages.length,
      uncheckedByReason
    },
    vulnerabilities: {
      total: vulnerabilityTotal,
      affectedPackages: findings.length,
      bySeverity: { critical: 0, high: vulnerabilityTotal, medium: 0, low: 0, unknown: 0 }
    },
    batchFailures: { total: 0, byReason: {} },
    batchRecovery: { transportRetries: 0, splitBatches: 0, missingPackageRetries: 0, recoveredPackages: 0 },
    ncmContentTruncation: { truncatedFields: 0, truncatedCharacters: 0 },
    remediation: {
      candidateRequests: 0,
      candidatesChecked: 0,
      verified,
      unresolved,
      verificationFailed: 0,
      notRequired: 0,
      failures: { total: 0, byReason: {} },
      recovery: { transportRetries: 0, splitBatches: 0, missingCandidateRetries: 0 }
    },
    uncheckedPackages,
    findings
  }
}

test('renderer emits every finding beyond fifty and preserves package versions', () => {
  const summary = summaryFor(Array.from({ length: 55 }, (_, index) => finding(index)))
  const report = renderAuditReport(summary)
  assert.equal((report.match(/^### Finding /gm) || []).length, 55)
  assert.match(report, /Finding 55\/55/)
  assert.match(report, /Rendered 55\/55 package-version findings, 55\/55 vulnerability records/)
  assert.match(report, /shared-package@1\.0\.54/)
})

test('renderer reconciles a 36-finding and 57-record report including duplicate records', () => {
  const findings = Array.from({ length: 36 }, (_, index) => finding(index, index < 21 ? 2 : 1))
  const report = renderAuditReport(summaryFor(findings))
  assert.equal((report.match(/^### Finding /gm) || []).length, 36)
  assert.equal((report.match(/^ {2}- Record /gm) || []).length, 57)
  assert.match(report, /Record 57\/57/)
  assert.match(report, /Rendered 36\/36 package-version findings, 57\/57 vulnerability records/)
  assert.equal((report.match(/GHSA-duplicate/g) || []).length, 57)
})

test('renderer lists every unchecked package and escapes untrusted Markdown', () => {
  const unsafe = finding(0)
  unsafe.vulnerabilities[0].title = '# injected\nheading | cell'
  const summary = summaryFor([unsafe], [
    { name: 'z-package', version: '1.0.0', reason: 'server' },
    { name: 'a-package', version: '2.0.0', reason: 'missing-response' }
  ])
  const report = renderAuditReport(summary)
  assert.match(report, /a-package@2\.0\.0 — missing-response/)
  assert.match(report, /z-package@1\.0\.0 — server/)
  assert.doesNotMatch(report, /^# injected/m)
  assert.match(report, /\\# injected heading \\| cell/)
  assert.match(report, /2\/2 unchecked package versions/)
})

test('renderer withholds ambiguous upgrade commands and qualifies rollback behavior', () => {
  const report = renderAuditReport(summaryFor([finding(0)]))
  assert.match(report, /Command withheld because the owning manifest/)
  assert.doesNotMatch(report, /pnpm add|npm install|yarn add|@latest/)
  assert.match(report, /For manually executed package-manager commands, rely on version control/)
})

test('integrity validation rejects mismatched totals with a stable error code', () => {
  const summary = summaryFor([finding(0)])
  summary.vulnerabilities.total = 2
  assert.throws(() => validateAuditSummary(summary), (error: any) => {
    assert.equal(error.code, 'AUDIT_REPORT_INTEGRITY_ERROR')
    assert.match(error.message, /vulnerability records/)
    return true
  })
})
