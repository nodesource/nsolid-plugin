'use strict'

const SEVERITIES = ['critical', 'high', 'medium', 'low', 'unknown']
const REMEDIATION_KEYS = {
  'ncm-verified': 'verified',
  unresolved: 'unresolved',
  'verification-failed': 'verificationFailed',
  'not-required': 'notRequired'
}

function integrityError (message) {
  const error = new Error(`Audit report integrity check failed: ${message}`)
  error.code = 'AUDIT_REPORT_INTEGRITY_ERROR'
  return error
}

function stableCounts (values) {
  return Object.fromEntries(Object.entries(values).sort(([a], [b]) => a.localeCompare(b)))
}

function assertEqual (actual, expected, label) {
  if (actual !== expected) throw integrityError(`${label}: expected ${expected}, received ${actual}`)
}

function assertCounts (actual, expected, label) {
  const keys = new Set([...Object.keys(actual || {}), ...Object.keys(expected || {})])
  for (const key of keys) assertEqual(actual[key] || 0, expected[key] || 0, `${label}.${key}`)
}

function validateAuditSummary (summary) {
  if (!summary || !Array.isArray(summary.findings) || !Array.isArray(summary.uncheckedPackages)) {
    throw integrityError('missing findings or uncheckedPackages collection')
  }

  const vulnerabilityCounts = Object.fromEntries(SEVERITIES.map(severity => [severity, 0]))
  const remediationCounts = { verified: 0, unresolved: 0, verificationFailed: 0, notRequired: 0 }
  let vulnerabilityTotal = 0

  for (const finding of summary.findings) {
    if (!Array.isArray(finding.vulnerabilities)) throw integrityError('finding has no vulnerability collection')
    const key = REMEDIATION_KEYS[finding.remediation && finding.remediation.status]
    if (!key) throw integrityError(`unknown remediation status for ${finding.name || 'unknown package'}`)
    remediationCounts[key]++
    for (const vulnerability of finding.vulnerabilities) {
      const severity = String(vulnerability.severity || '').toLowerCase()
      vulnerabilityCounts[SEVERITIES.includes(severity) ? severity : 'unknown']++
      vulnerabilityTotal++
    }
  }

  assertEqual(summary.findings.length, summary.vulnerabilities.affectedPackages, 'affected package versions')
  assertEqual(vulnerabilityTotal, summary.vulnerabilities.total, 'vulnerability records')
  assertCounts(vulnerabilityCounts, summary.vulnerabilities.bySeverity, 'severity')
  assertCounts(remediationCounts, {
    verified: summary.remediation.verified,
    unresolved: summary.remediation.unresolved,
    verificationFailed: summary.remediation.verificationFailed,
    notRequired: summary.remediation.notRequired
  }, 'remediation')

  const uncheckedCounts = {}
  for (const pkg of summary.uncheckedPackages) {
    uncheckedCounts[pkg.reason] = (uncheckedCounts[pkg.reason] || 0) + 1
  }
  assertEqual(summary.packages.checked + summary.packages.unchecked, summary.packages.total, 'package coverage')
  assertEqual(summary.uncheckedPackages.length, summary.packages.unchecked, 'unchecked package versions')
  assertCounts(stableCounts(uncheckedCounts), summary.packages.uncheckedByReason, 'unchecked reason')

  return {
    findings: summary.findings.length,
    vulnerabilities: vulnerabilityTotal,
    unchecked: summary.uncheckedPackages.length
  }
}

function escapeMarkdown (value) {
  return String(value == null ? '' : value)
    .split('')
    .map(character => {
      const code = character.charCodeAt(0)
      return (code <= 8 || code === 11 || code === 12 || (code >= 14 && code <= 31) || code === 127)
        ? '\uFFFD'
        : character
    })
    .join('')
    .replace(/\\/g, '\\\\')
    .replace(/([`*_{}[\]()<>#|])/g, '\\$1')
    .replace(/\r\n?|\n/g, ' ')
}

function valueOrNotReturned (value) {
  return value == null || value === '' ? 'not returned' : escapeMarkdown(value)
}

function listOrNotReturned (value) {
  return Array.isArray(value) && value.length > 0
    ? value.map(escapeMarkdown).join('; ')
    : 'not returned'
}

function countsText (counts) {
  const entries = Object.entries(counts || {}).filter(([, count]) => count > 0)
  return entries.length > 0 ? entries.map(([key, count]) => `${count} ${escapeMarkdown(key)}`).join(', ') : 'none'
}

function renderFinding (finding, index, findingTotal, recordState, recordTotal) {
  const lines = [
    `### Finding ${index + 1}/${findingTotal}: ${escapeMarkdown(finding.name)}@${escapeMarkdown(finding.version)}`,
    '',
    `- Severity: ${escapeMarkdown(finding.severity)}`,
    `- Dependency: ${finding.direct ? 'direct' : 'transitive'}`,
    `- License: ${finding.license && finding.license.spdx ? escapeMarkdown(finding.license.spdx) : 'not returned'}`,
    '- Vulnerability records:'
  ]

  for (const vulnerability of finding.vulnerabilities) {
    recordState.count++
    const withdrawn = vulnerability.withdrawn ? ' — withdrawn' : ''
    lines.push(`  - Record ${recordState.count}/${recordTotal} — ${escapeMarkdown(vulnerability.severity)} — ${valueOrNotReturned(vulnerability.id)} — ${escapeMarkdown(vulnerability.title)}${withdrawn}`)
    lines.push(`    - Withdrawn: ${vulnerability.withdrawn ? 'yes' : 'no'}`)
    lines.push(`    - URL: ${valueOrNotReturned(vulnerability.url)}`)
    lines.push(`    - Vulnerable ranges: ${listOrNotReturned(vulnerability.vulnerable)}`)
    lines.push(`    - Patched ranges: ${listOrNotReturned(vulnerability.patched)}`)
  }

  lines.push('- Module risks:')
  if (finding.moduleRisks.length === 0) lines.push('  - none returned')
  for (const risk of finding.moduleRisks) lines.push(`  - ${escapeMarkdown(risk.severity)} — ${escapeMarkdown(risk.title)}`)
  lines.push('- Code-quality issues:')
  if (finding.codeQuality.length === 0) lines.push('  - none returned')
  for (const issue of finding.codeQuality) lines.push(`  - ${escapeMarkdown(issue.severity)} — ${escapeMarkdown(issue.title)}`)

  const remediation = finding.remediation
  if (remediation.status === 'ncm-verified') {
    lines.push(`- Remediation: ncm-verified → ${escapeMarkdown(remediation.version)} (${escapeMarkdown(remediation.source)}, ${escapeMarkdown(remediation.changeType)})`)
  } else if (remediation.status === 'not-required') {
    lines.push(`- Remediation: not-required (${escapeMarkdown(remediation.reason || 'withdrawn-only')})`)
  } else {
    lines.push(`- Remediation: ${escapeMarkdown(remediation.status)}`)
  }
  return lines.join('\n')
}

function renderRemediationPlan (summary) {
  const lines = ['## Remediation Plan', '']
  const verified = summary.findings.filter(finding => finding.remediation.status === 'ncm-verified')
  if (verified.length === 0) {
    lines.push('No NCM-verified upgrade targets were found.')
  } else {
    for (const finding of verified) {
      lines.push(`- ${escapeMarkdown(finding.name)}@${escapeMarkdown(finding.version)} → verified target ${escapeMarkdown(finding.name)}@${escapeMarkdown(finding.remediation.version)}.`)
      lines.push('  Command withheld because the owning manifest and resolved direct version are not proven unambiguous; locate the declaration before upgrading.')
      if (!finding.direct) lines.push(`  Locate the introducing parent with \`${escapeMarkdown(summary.packageManager)} why ${escapeMarkdown(finding.name)}\`.`)
    }
  }
  const unresolved = summary.findings.filter(finding => finding.remediation.status === 'unresolved').length
  const failed = summary.findings.filter(finding => finding.remediation.status === 'verification-failed').length
  if (unresolved > 0) lines.push(`- ${unresolved} finding(s) remain unresolved; use reported ranges as evidence, but verify a candidate with NCM before pinning.`)
  if (failed > 0) lines.push(`- ${failed} finding(s) could not complete remediation verification; this does not weaken the vulnerability finding.`)
  return lines.join('\n')
}

function renderAuditReport (summary) {
  const counts = validateAuditSummary(summary)
  const severity = summary.vulnerabilities.bySeverity
  const lines = [
    '## Summary',
    '',
    `- ${summary.packages.checked} of ${summary.packages.total} package versions checked; ${summary.packages.unchecked} unchecked.`,
    `- ${summary.vulnerabilities.total} vulnerability records across ${summary.vulnerabilities.affectedPackages} affected package versions: ${severity.critical} critical, ${severity.high} high, ${severity.medium} medium, ${severity.low} low, ${severity.unknown} unknown.`,
    `- Terminal batch failures: ${summary.batchFailures.total} (${countsText(summary.batchFailures.byReason)}). Recovery: ${summary.batchRecovery.transportRetries} transport retries, ${summary.batchRecovery.splitBatches} batch splits, ${summary.batchRecovery.missingPackageRetries} omitted-response retries, ${summary.batchRecovery.recoveredPackages} recovered package versions.`,
    `- Remediation: ${summary.remediation.verified} NCM-verified, ${summary.remediation.unresolved} unresolved, ${summary.remediation.verificationFailed} verification failures, ${summary.remediation.notRequired} not required. Candidate failures: ${summary.remediation.failures.total} (${countsText(summary.remediation.failures.byReason)}).`,
    `- Remediation recovery: ${summary.remediation.recovery.transportRetries} transport retries, ${summary.remediation.recovery.splitBatches} batch splits, ${summary.remediation.recovery.missingCandidateRetries} omitted-candidate retries.`
  ]
  if (summary.ncmContentTruncation.truncatedFields > 0) {
    lines.push(`- NCM content truncation: ${summary.ncmContentTruncation.truncatedFields} fields and ${summary.ncmContentTruncation.truncatedCharacters} characters truncated.`)
  } else {
    lines.push('- No NCM field truncation occurred.')
  }
  lines.push('', '“NCM-verified” means free of active NCM advisories at audit time—not absolutely safe.')
  lines.push('', 'This is a static dependency audit; it does not establish runtime loading, reachability, or exploitability.')

  if (summary.uncheckedPackages.length > 0) {
    lines.push('', '## Coverage Gaps', '')
    for (const pkg of summary.uncheckedPackages) {
      lines.push(`- ${escapeMarkdown(pkg.name)}@${escapeMarkdown(pkg.version)} — ${escapeMarkdown(pkg.reason)}`)
    }
  }

  lines.push('', '## Prioritized Findings', '')
  if (summary.findings.length === 0) lines.push('No vulnerable package versions were returned.')
  const recordState = { count: 0 }
  summary.findings.forEach((finding, index) => {
    if (index > 0) lines.push('')
    lines.push(renderFinding(finding, index, counts.findings, recordState, counts.vulnerabilities))
  })

  lines.push('', renderRemediationPlan(summary), '', '## Breaking Change Notes', '')
  const majors = summary.findings.filter(finding => finding.remediation.status === 'ncm-verified' && finding.remediation.changeType === 'major')
  if (majors.length === 0) lines.push('No NCM-verified major-version remediation targets were found.')
  else lines.push(`Major upgrades require changelog and compatibility review: ${majors.map(finding => `${escapeMarkdown(finding.name)} → ${escapeMarkdown(finding.remediation.version)}`).join(', ')}.`)

  lines.push('', '## Rollback Guidance', '')
  lines.push('The N|Solid upgrade workflow backs up `package.json` and the lockfile under `.nsolid/backup/`. For manually executed package-manager commands, rely on version control or create a separate backup first.')
  lines.push('', '## Report Integrity', '')
  lines.push(`Rendered ${counts.findings}/${summary.vulnerabilities.affectedPackages} package-version findings, ${recordState.count}/${summary.vulnerabilities.total} vulnerability records, and ${counts.unchecked}/${summary.packages.unchecked} unchecked package versions.`)
  return lines.join('\n')
}

module.exports = { escapeMarkdown, renderAuditReport, validateAuditSummary }
