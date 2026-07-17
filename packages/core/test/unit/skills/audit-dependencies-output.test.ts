import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const require = createRequire(import.meta.url)
const { createSavedAuditOutput } = require('../../../../../skills/ns-audit-dependencies/audit-report-output.cjs') as {
  createSavedAuditOutput: (
    summary: Record<string, any>,
    projectDir: string,
    options?: { now?: Date }
  ) => Promise<{ executiveSummary: string, report: string, reportPath: string }>
}

function auditSummary (): Record<string, any> {
  return {
    packageManager: 'pnpm',
    packages: {
      total: 2,
      direct: 1,
      transitive: 1,
      checked: 1,
      unchecked: 1,
      uncheckedByReason: { 'missing-response': 1 }
    },
    vulnerabilities: {
      total: 1,
      affectedPackages: 1,
      bySeverity: { critical: 0, high: 1, medium: 0, low: 0, unknown: 0 }
    },
    batchFailures: { total: 0, byReason: {} },
    batchRecovery: { transportRetries: 0, splitBatches: 0, missingPackageRetries: 1, recoveredPackages: 0 },
    ncmContentTruncation: { truncatedFields: 0, truncatedCharacters: 0 },
    remediation: {
      candidateRequests: 1,
      candidatesChecked: 1,
      verified: 1,
      unresolved: 0,
      verificationFailed: 0,
      notRequired: 0,
      failures: { total: 0, byReason: {} },
      recovery: { transportRetries: 0, splitBatches: 0, missingCandidateRetries: 0 }
    },
    uncheckedPackages: [
      { name: '@internal/package', version: '1.0.0', reason: 'missing-response' }
    ],
    findings: [
      {
        name: 'vulnerable-package',
        version: '1.0.0',
        direct: true,
        severity: 'HIGH',
        vulnerabilities: [
          {
            severity: 'HIGH',
            id: 'GHSA-test',
            title: 'Test vulnerability',
            vulnerable: ['< 1.0.1'],
            patched: ['>= 1.0.1']
          }
        ],
        license: { pass: true, spdx: 'MIT' },
        moduleRisks: [],
        codeQuality: [],
        remediation: {
          status: 'ncm-verified',
          version: '1.0.1',
          source: 'boundary',
          changeType: 'patch'
        }
      }
    ]
  }
}

function uncheckedAuditSummary (reasons: string[]): Record<string, any> {
  const uncheckedByReason: Record<string, number> = {}
  const uncheckedPackages = reasons.map((reason, index) => {
    uncheckedByReason[reason] = (uncheckedByReason[reason] || 0) + 1
    return { name: `package-${index}`, version: `1.0.${index}`, reason }
  })
  return {
    packageManager: 'pnpm',
    packages: {
      total: reasons.length,
      direct: 0,
      transitive: reasons.length,
      checked: 0,
      unchecked: reasons.length,
      uncheckedByReason
    },
    vulnerabilities: {
      total: 0,
      affectedPackages: 0,
      bySeverity: { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 }
    },
    batchFailures: { total: reasons.length, byReason: uncheckedByReason },
    batchRecovery: { transportRetries: 2, splitBatches: 1, missingPackageRetries: 0, recoveredPackages: 0 },
    ncmContentTruncation: { truncatedFields: 0, truncatedCharacters: 0 },
    remediation: {
      candidateRequests: 0,
      candidatesChecked: 0,
      verified: 0,
      unresolved: 0,
      verificationFailed: 0,
      notRequired: 0,
      failures: { total: 0, byReason: {} },
      recovery: { transportRetries: 0, splitBatches: 0, missingCandidateRetries: 0 }
    },
    uncheckedPackages,
    findings: []
  }
}

test('saved audit output publishes exact complete report bytes before linking it from the summary', async () => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), 'nsolid audit output '))
  try {
    const output = await createSavedAuditOutput(auditSummary(), projectDir, {
      now: new Date('2026-07-17T14:35:22.123Z')
    })

    assert.equal(output.reportPath, path.join(
      projectDir,
      '.nsolid',
      'assets',
      'dependency-audit-2026-07-17T14-35-22-123Z.md'
    ))
    assert.equal(await readFile(output.reportPath, 'utf8'), output.report)
    assert.ok(output.report.endsWith('\n'))
    const linkedPath = output.reportPath.split(path.sep).join('/').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    assert.match(output.executiveSummary, new RegExp(linkedPath))
    if (process.platform !== 'win32') assert.equal((await stat(output.reportPath)).mode & 0o777, 0o600)
    assert.deepEqual(
      (await readdir(path.dirname(output.reportPath))).filter(name => name.endsWith('.tmp')),
      []
    )
  } finally {
    await rm(projectDir, { recursive: true, force: true })
  }
})

test('saved audit output never overwrites a colliding report name', async () => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), 'nsolid-audit-output-'))
  const now = new Date('2026-07-17T14:35:22.123Z')
  try {
    const first = await createSavedAuditOutput(auditSummary(), projectDir, { now })
    const second = await createSavedAuditOutput(auditSummary(), projectDir, { now })

    assert.notEqual(first.reportPath, second.reportPath)
    assert.match(second.reportPath, /-2\.md$/)
    assert.equal(await readFile(first.reportPath, 'utf8'), first.report)
    assert.equal(await readFile(second.reportPath, 'utf8'), second.report)
  } finally {
    await rm(projectDir, { recursive: true, force: true })
  }
})

test('integrity failures create no report artifact', async () => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), 'nsolid-audit-output-'))
  const invalid = auditSummary()
  invalid.vulnerabilities.total = 2
  try {
    await assert.rejects(
      createSavedAuditOutput(invalid, projectDir),
      (error: any) => error.code === 'AUDIT_REPORT_INTEGRITY_ERROR'
    )
    await assert.rejects(readdir(path.join(projectDir, '.nsolid', 'assets')), { code: 'ENOENT' })
  } finally {
    await rm(projectDir, { recursive: true, force: true })
  }
})

test('fully unchecked retryable transport failures create no report artifact', async () => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), 'nsolid-audit-output-'))
  try {
    await assert.rejects(
      createSavedAuditOutput(uncheckedAuditSummary(['network', 'timeout', 'rate-limit', 'server']), projectDir),
      (error: any) => {
        assert.equal(error.code, 'AUDIT_REPORT_RETRY_REQUIRED')
        assert.match(error.message, /all 4 package versions were unchecked/i)
        return true
      }
    )
    await assert.rejects(readdir(path.join(projectDir, '.nsolid', 'assets')), { code: 'ENOENT' })
  } finally {
    await rm(projectDir, { recursive: true, force: true })
  }
})

test('a successful second attempt leaves exactly one saved report', async () => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), 'nsolid-audit-output-'))
  try {
    await assert.rejects(
      createSavedAuditOutput(uncheckedAuditSummary(['network']), projectDir),
      (error: any) => error.code === 'AUDIT_REPORT_RETRY_REQUIRED'
    )
    const successful = await createSavedAuditOutput(auditSummary(), projectDir)
    assert.deepEqual(await readdir(path.dirname(successful.reportPath)), [path.basename(successful.reportPath)])
  } finally {
    await rm(projectDir, { recursive: true, force: true })
  }
})

test('fully unchecked authentication failures create no report artifact', async () => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), 'nsolid-audit-output-'))
  try {
    await assert.rejects(
      createSavedAuditOutput(uncheckedAuditSummary(['authentication']), projectDir),
      (error: any) => error.code === 'AUDIT_REPORT_AUTHENTICATION_REQUIRED'
    )
    await assert.rejects(readdir(path.join(projectDir, '.nsolid', 'assets')), { code: 'ENOENT' })
  } finally {
    await rm(projectDir, { recursive: true, force: true })
  }
})

test('partial network coverage still saves the incomplete report', async () => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), 'nsolid-audit-output-'))
  const summary = auditSummary()
  summary.packages.uncheckedByReason = { network: 1 }
  summary.uncheckedPackages[0].reason = 'network'
  try {
    const output = await createSavedAuditOutput(summary, projectDir)
    assert.equal(await readFile(output.reportPath, 'utf8'), output.report)
  } finally {
    await rm(projectDir, { recursive: true, force: true })
  }
})
