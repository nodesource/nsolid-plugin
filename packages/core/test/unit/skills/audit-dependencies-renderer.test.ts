import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'
import test from 'node:test'

const require = createRequire(import.meta.url)
const { renderAuditReport, renderAuditSummary, reportLink, validateAuditSummary } = require('../../../../../skills/ns-audit-dependencies/render-audit-report.cjs') as {
  renderAuditReport: (summary: Record<string, any>) => string
  renderAuditSummary: (summary: Record<string, any>, reportPath: string) => string
  reportLink: (reportPath: string, pathApi?: typeof path) => string
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
  const bySeverity = { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 }
  for (const item of findings) {
    for (const vulnerability of item.vulnerabilities) {
      const severity = String(vulnerability.severity || '').toLowerCase()
      bySeverity[severity in bySeverity ? severity as keyof typeof bySeverity : 'unknown']++
    }
  }
  const verified = findings.filter(item => item.remediation.status === 'ncm-verified').length
  const unresolved = findings.filter(item => item.remediation.status === 'unresolved').length
  const verificationFailed = findings.filter(item => item.remediation.status === 'verification-failed').length
  const notRequired = findings.filter(item => item.remediation.status === 'not-required').length
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
      bySeverity
    },
    batchFailures: { total: 0, byReason: {} },
    batchRecovery: { transportRetries: 0, splitBatches: 0, missingPackageRetries: 0, recoveredPackages: 0 },
    ncmContentTruncation: { truncatedFields: 0, truncatedCharacters: 0 },
    remediation: {
      candidateRequests: 0,
      candidatesChecked: 0,
      verified,
      unresolved,
      verificationFailed,
      notRequired,
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

test('executive summary links the complete 36-finding and 57-record report without claiming chat rendered it', () => {
  const findings = Array.from({ length: 36 }, (_, index) => finding(index, index < 21 ? 2 : 1))
  findings[1].vulnerabilities.forEach((vulnerability: Record<string, any>) => { vulnerability.severity = 'CRITICAL' })
  const summary = summaryFor(findings)
  const reportPath = path.resolve('project with spaces', '.nsolid', 'assets', 'dependency-audit.md')
  const executiveSummary = renderAuditSummary(summary, reportPath)
  const linkedPath = reportPath.split(path.sep).join('/').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

  assert.match(executiveSummary, /^## Executive Summary/m)
  assert.match(executiveSummary, new RegExp(`\\[Open the complete dependency audit report\\]\\(<${linkedPath}>\\)`))
  assert.match(executiveSummary, /The underlying complete report reconciles 36\/36 package-version findings, 57\/57 vulnerability records/)
  assert.match(executiveSummary, /package-1@1\.0\.1/)
  assert.doesNotMatch(executiveSummary, /^ {2}- Record /m)
  assert.doesNotMatch(executiveSummary, /Vulnerable ranges:/)
  assert.doesNotMatch(executiveSummary, /Rendered 36\/36/)
})

test('executive summary groups verified targets and lists every unresolved and withdrawn-only package version', () => {
  const first = finding(0)
  first.vulnerabilities[0].severity = 'CRITICAL'
  const second = finding(2)
  second.vulnerabilities[0].severity = 'CRITICAL'
  second.remediation = { ...first.remediation }
  const unresolved = finding(1)
  const withdrawn = finding(4)
  withdrawn.vulnerabilities[0].withdrawn = true
  withdrawn.remediation = { status: 'not-required', reason: 'withdrawn-only' }
  const summary = summaryFor([first, second, unresolved, withdrawn], [
    { name: 'internal-one', version: '1.0.0', reason: 'missing-response' },
    { name: 'internal-two', version: '2.0.0', reason: 'missing-response' }
  ])
  const reportPath = path.resolve('dependency-audit.md')
  const executiveSummary = renderAuditSummary(summary, reportPath)

  assert.match(executiveSummary, /2 verified package-version findings are represented by 1 grouped upgrade action/)
  assert.match(executiveSummary, /shared-package@1\.0\.0, shared-package@1\.0\.2/)
  assert.match(executiveSummary, /Unresolved \(1\): package-1@1\.0\.1/)
  assert.match(executiveSummary, /shared-package@1\.0\.4/)
  assert.match(executiveSummary, /2 unchecked package versions were not proven safe: 2 missing-response/)
  assert.equal(renderAuditSummary(summary, reportPath), executiveSummary)
})

test('executive summary always emits the fixed section contract in order', () => {
  const executiveSummary = renderAuditSummary(summaryFor([]), path.resolve('dependency-audit.md'))
  assert.deepEqual(executiveSummary.match(/^## .+$/gm), [
    '## Executive Summary',
    '## Critical Findings',
    '## Verified Upgrade Actions',
    '## Findings Requiring Follow-up',
    '## Withdrawn-Only Findings',
    '## Coverage Gaps',
    '## Complete Report'
  ])
})

test('report links normalize Windows paths and encode Markdown-significant filename characters', () => {
  assert.equal(
    reportLink('C:\\Users\\Example User\\project\\.nsolid\\assets\\audit#1?.md', path.win32),
    '[Open the complete dependency audit report](<C:/Users/Example User/project/.nsolid/assets/audit%231%3F.md>)'
  )
})

test('renderer leads with active risk and partitions a 36-finding, 57-record report', () => {
  const activeSeverities = [
    ...Array(5).fill('CRITICAL'),
    ...Array(15).fill('HIGH'),
    ...Array(22).fill('MEDIUM'),
    ...Array(9).fill('LOW')
  ]
  let activeRecord = 0
  const findings = Array.from({ length: 36 }, (_, index) => {
    const vulnerabilityCount = index < 19 || index === 32 || index === 33 ? 2 : 1
    const item = finding(index, vulnerabilityCount)
    if (index < 32) {
      for (const vulnerability of item.vulnerabilities) vulnerability.severity = activeSeverities[activeRecord++]
    } else {
      const withdrawnSeverities = index < 34 ? ['HIGH', 'HIGH'] : [index === 34 ? 'MEDIUM' : 'LOW']
      item.vulnerabilities.forEach((vulnerability: Record<string, any>, record: number) => {
        vulnerability.severity = withdrawnSeverities[record]
        vulnerability.withdrawn = true
      })
      item.remediation = { status: 'not-required', reason: 'withdrawn-only' }
    }
    return item
  })
  const report = renderAuditReport(summaryFor(findings))
  assert.match(report, /51 active vulnerability records across 32 actively affected package versions: 5 critical, 15 high, 22 medium, 9 low, 0 unknown/)
  assert.match(report, /57 vulnerability records across 36 affected package versions, including 6 withdrawn records and 4 withdrawn-only package versions/)
  assert.match(report, /Finding partition: 32\/32 active and 4\/4 withdrawn-only/)
  assert.match(report, /Record partition: 51\/51 active and 6\/6 withdrawn/)
  assert.ok(report.indexOf('## Active Findings') < report.indexOf('## Withdrawn-Only Findings'))
})

test('renderer prioritizes mixed findings by active severity and keeps withdrawn records', () => {
  const mixed = finding(0, 2)
  mixed.name = 'mixed-package'
  mixed.vulnerabilities = [
    { severity: 'CRITICAL', title: 'Withdrawn critical', withdrawn: true },
    { severity: 'LOW', title: 'Active low' }
  ]
  mixed.remediation = { status: 'unresolved' }
  const high = finding(1)
  high.name = 'active-high'
  high.remediation = { status: 'unresolved' }
  const report = renderAuditReport(summaryFor([mixed, high]))
  assert.ok(report.indexOf('Finding 1/2: active-high') < report.indexOf('Finding 2/2: mixed-package'))
  assert.match(report, /Withdrawn critical — withdrawn/)
  assert.match(report, /2 active vulnerability records/)
  assert.match(report, /1 withdrawn record/)
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
  assert.equal((report.match(/NCM returned no matching package-version response after omitted-response recovery/g) || []).length, 1)
  assert.match(report, /Unchecked package versions were not proven safe/)
})

test('renderer withholds ambiguous upgrade commands and qualifies rollback behavior', () => {
  const first = finding(0)
  const second = finding(3)
  second.direct = false
  const report = renderAuditReport(summaryFor([first, second]))
  assert.equal((report.match(/Command withheld because exact manifest ownership is not proven/g) || []).length, 1)
  assert.match(report, /root declaration name match; resolved ownership unproven/)
  assert.match(report, /no root declaration name match; may be transitive or workspace-owned/)
  assert.match(report, /pnpm why shared-package/)
  assert.match(report, /pnpm why package-3/)
  assert.equal((report.match(/^\| HIGH \|/gm) || []).length, 2)
  assert.doesNotMatch(report, /pnpm add|npm install|yarn add|@latest/)
  assert.match(report, /For manually executed package-manager commands, rely on version control/)
})

test('renderer groups major breaking changes without losing installed versions', () => {
  const viteSix = finding(0)
  viteSix.name = 'vite'
  viteSix.version = '6.4.2'
  viteSix.remediation = { status: 'ncm-verified', version: '8.1.5', source: 'latest-fallback', changeType: 'major' }
  const viteSeven = finding(1)
  viteSeven.name = 'vite'
  viteSeven.version = '7.3.2'
  viteSeven.remediation = { status: 'ncm-verified', version: '8.1.5', source: 'latest-fallback', changeType: 'major' }
  const report = renderAuditReport(summaryFor([viteSix, viteSeven]))
  assert.match(report, /vite@6\.4\.2 and vite@7\.3\.2 → 8\.1\.5/)
  assert.equal((report.match(/^- vite@/gm) || []).length, 1)
})

test('renderer output is stable for repeated renders', () => {
  const summary = summaryFor([finding(0), finding(1)])
  assert.equal(renderAuditReport(summary), renderAuditReport(summary))
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

test('integrity validation rejects contradictory failure totals and reason counts', () => {
  const batchMismatch = summaryFor([])
  batchMismatch.batchFailures = { total: 1, byReason: {} }
  assert.throws(
    () => validateAuditSummary(batchMismatch),
    /batch failures: expected 1, received 0/
  )

  const remediationMismatch = summaryFor([])
  remediationMismatch.remediation.failures = { total: 2, byReason: { server: 1 } }
  assert.throws(
    () => validateAuditSummary(remediationMismatch),
    /remediation failures: expected 2, received 1/
  )
})

test('integrity validation rejects invalid active and withdrawn remediation partitions', () => {
  const withdrawn = finding(0)
  withdrawn.vulnerabilities[0].withdrawn = true
  assert.throws(() => validateAuditSummary(summaryFor([withdrawn])), /withdrawn-only finding requires not-required remediation/)

  const active = finding(1)
  active.remediation = { status: 'not-required', reason: 'withdrawn-only' }
  assert.throws(() => validateAuditSummary(summaryFor([active])), /active finding is marked not-required/)
})
