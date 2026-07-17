'use strict'

const path = require('path')

const SEVERITIES = ['critical', 'high', 'medium', 'low', 'unknown']
const SEVERITY_RANK = { unknown: 0, low: 1, medium: 2, high: 3, critical: 4 }
const REMEDIATION_KEYS = {
  'ncm-verified': 'verified',
  unresolved: 'unresolved',
  'verification-failed': 'verificationFailed',
  'not-required': 'notRequired'
}

const COVERAGE_GUIDANCE = {
  authentication: 'NCM authentication failed. Refresh the configured NodeSource credentials before rerunning the audit.',
  'rate-limit': 'NCM rate limiting remained after recovery. Rerun later; these package versions were not checked.',
  server: 'NCM server failures remained after recovery. Rerun later; these package versions were not checked.',
  timeout: 'NCM requests timed out after recovery. Check connectivity and rerun; these package versions were not checked.',
  network: 'Network failures remained after recovery. Restore NCM connectivity and rerun; these package versions were not checked.',
  'invalid-response': 'NCM returned an invalid package response. These package versions were not checked and the response contract should be investigated.',
  'missing-response': 'NCM returned no matching package-version response after omitted-response recovery. Confirm the exact version and NCM coverage; use the organization\'s internal security-review process for private or internal packages without NCM metadata.',
  unpublished: 'NCM marked these package versions unpublished. Confirm the resolved versions and review their provenance before use.',
  unknown: 'The audit ended without a classified response. Investigate the audit stderr and rerun after resolving the underlying failure.'
}

function integrityError (message) {
  const error = new Error(`Audit report integrity check failed: ${message}`)
  error.code = 'AUDIT_REPORT_INTEGRITY_ERROR'
  return error
}

function emptySeverityCounts () {
  return Object.fromEntries(SEVERITIES.map(severity => [severity, 0]))
}

function severityKey (value) {
  const key = String(value || '').toLowerCase()
  return SEVERITIES.includes(key) ? key : 'unknown'
}

function highestSeverity (vulnerabilities) {
  return vulnerabilities.reduce((highest, vulnerability) => {
    const severity = severityKey(vulnerability.severity)
    return SEVERITY_RANK[severity] > SEVERITY_RANK[highest] ? severity : highest
  }, 'unknown')
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

function compareFindings (left, right) {
  return SEVERITY_RANK[right.renderedSeverity] - SEVERITY_RANK[left.renderedSeverity] ||
    String(left.finding.name).localeCompare(String(right.finding.name)) ||
    String(left.finding.version).localeCompare(String(right.finding.version))
}

function analyzeFindings (findings) {
  const rawBySeverity = emptySeverityCounts()
  const activeBySeverity = emptySeverityCounts()
  const withdrawnBySeverity = emptySeverityCounts()
  const remediationCounts = { verified: 0, unresolved: 0, verificationFailed: 0, notRequired: 0 }
  const activeFindings = []
  const withdrawnOnlyFindings = []
  let rawRecords = 0
  let activeRecords = 0
  let withdrawnRecords = 0

  for (const finding of findings) {
    if (!Array.isArray(finding.vulnerabilities) || finding.vulnerabilities.length === 0) {
      throw integrityError(`finding has no vulnerability records for ${finding.name || 'unknown package'}`)
    }
    const remediationKey = REMEDIATION_KEYS[finding.remediation && finding.remediation.status]
    if (!remediationKey) throw integrityError(`unknown remediation status for ${finding.name || 'unknown package'}`)
    remediationCounts[remediationKey]++

    const active = []
    for (const vulnerability of finding.vulnerabilities) {
      const severity = severityKey(vulnerability.severity)
      rawBySeverity[severity]++
      rawRecords++
      if (vulnerability.withdrawn === true) {
        withdrawnBySeverity[severity]++
        withdrawnRecords++
      } else {
        active.push(vulnerability)
        activeBySeverity[severity]++
        activeRecords++
      }
    }

    if (active.length > 0) {
      if (finding.remediation.status === 'not-required') {
        throw integrityError(`active finding is marked not-required for ${finding.name}`)
      }
      activeFindings.push({ finding, renderedSeverity: highestSeverity(active) })
    } else {
      if (finding.remediation.status !== 'not-required') {
        throw integrityError(`withdrawn-only finding requires not-required remediation for ${finding.name}`)
      }
      withdrawnOnlyFindings.push({ finding, renderedSeverity: highestSeverity(finding.vulnerabilities) })
    }
  }

  activeFindings.sort(compareFindings)
  withdrawnOnlyFindings.sort(compareFindings)
  return {
    rawBySeverity,
    activeBySeverity,
    withdrawnBySeverity,
    remediationCounts,
    activeFindings,
    withdrawnOnlyFindings,
    rawRecords,
    activeRecords,
    withdrawnRecords
  }
}

function validateAuditSummary (summary) {
  if (!summary || !Array.isArray(summary.findings) || !Array.isArray(summary.uncheckedPackages)) {
    throw integrityError('missing findings or uncheckedPackages collection')
  }

  const analysis = analyzeFindings(summary.findings)
  assertEqual(summary.findings.length, summary.vulnerabilities.affectedPackages, 'affected package versions')
  assertEqual(analysis.rawRecords, summary.vulnerabilities.total, 'vulnerability records')
  assertEqual(analysis.activeRecords + analysis.withdrawnRecords, analysis.rawRecords, 'record partition')
  assertEqual(analysis.activeFindings.length + analysis.withdrawnOnlyFindings.length, summary.findings.length, 'finding partition')
  assertCounts(analysis.rawBySeverity, summary.vulnerabilities.bySeverity, 'severity')
  assertEqual(Object.values(analysis.activeBySeverity).reduce((total, count) => total + count, 0), analysis.activeRecords, 'active severity total')
  assertEqual(Object.values(analysis.withdrawnBySeverity).reduce((total, count) => total + count, 0), analysis.withdrawnRecords, 'withdrawn severity total')
  assertCounts(analysis.remediationCounts, {
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
    ...analysis,
    findings: summary.findings.length,
    vulnerabilities: analysis.rawRecords,
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

function severityText (counts) {
  return `${counts.critical} critical, ${counts.high} high, ${counts.medium} medium, ${counts.low} low, ${counts.unknown} unknown`
}

function noun (count, singular, plural = `${singular}s`) {
  return count === 1 ? singular : plural
}

function dependencyScope (finding, short = false) {
  if (finding.direct) {
    return short
      ? 'root-name match; ownership unresolved'
      : 'root declaration name match; resolved ownership unproven'
  }
  return short
    ? 'no root-name match; workspace/transitive unresolved'
    : 'no root declaration name match; may be transitive or workspace-owned'
}

function remediationText (finding) {
  const remediation = finding.remediation
  if (remediation.status === 'ncm-verified') {
    return `ncm-verified → ${escapeMarkdown(remediation.version)} (${escapeMarkdown(remediation.changeType)})`
  }
  if (remediation.status === 'not-required') {
    return `not-required (${escapeMarkdown(remediation.reason || 'withdrawn-only')})`
  }
  return escapeMarkdown(remediation.status)
}

function groupVerifiedActions (analysis) {
  const groups = new Map()
  for (const { finding, renderedSeverity } of analysis.activeFindings) {
    if (finding.remediation.status !== 'ncm-verified') continue
    const key = [
      finding.name,
      finding.remediation.version,
      finding.remediation.changeType,
      finding.remediation.source
    ].join('\u0000')
    if (!groups.has(key)) {
      groups.set(key, {
        name: finding.name,
        target: finding.remediation.version,
        changeType: finding.remediation.changeType,
        source: finding.remediation.source,
        installed: new Set(),
        severity: renderedSeverity
      })
    }
    const group = groups.get(key)
    group.installed.add(finding.version)
    if (SEVERITY_RANK[renderedSeverity] > SEVERITY_RANK[group.severity]) group.severity = renderedSeverity
  }
  return Array.from(groups.values()).sort((left, right) => {
    return SEVERITY_RANK[right.severity] - SEVERITY_RANK[left.severity] ||
      left.name.localeCompare(right.name) ||
      left.target.localeCompare(right.target) ||
      left.changeType.localeCompare(right.changeType) ||
      left.source.localeCompare(right.source)
  })
}

function reportLink (reportPath, pathApi = path) {
  const absolutePath = pathApi.resolve(reportPath)
  const target = absolutePath
    .split(pathApi.sep).join('/')
    .replace(/%/g, '%25')
    .replace(/</g, '%3C')
    .replace(/>/g, '%3E')
    .replace(/#/g, '%23')
    .replace(/\?/g, '%3F')
  return `[Open the complete dependency audit report](<${target}>)`
}

function renderAuditSummary (summary, reportPath) {
  const analysis = validateAuditSummary(summary)
  if (typeof reportPath !== 'string' || reportPath.length === 0 || !path.isAbsolute(reportPath)) {
    throw integrityError('summary requires an absolute saved report path')
  }

  const critical = analysis.activeFindings.filter(item => item.renderedSeverity === 'critical')
  const verified = analysis.activeFindings.filter(item => item.finding.remediation.status === 'ncm-verified')
  const verifiedActions = groupVerifiedActions(analysis)
  const unresolved = analysis.activeFindings.filter(item => item.finding.remediation.status === 'unresolved')
  const verificationFailed = analysis.activeFindings.filter(item => item.finding.remediation.status === 'verification-failed')
  const lines = [
    '## Executive Summary',
    '',
    `- ${summary.packages.checked} of ${summary.packages.total} package versions checked; ${summary.packages.unchecked} unchecked.`,
    `- ${analysis.activeRecords} active vulnerability ${noun(analysis.activeRecords, 'record')} across ${analysis.activeFindings.length} actively affected package ${noun(analysis.activeFindings.length, 'version')}: ${severityText(analysis.activeBySeverity)}.`,
    `- ${analysis.withdrawnRecords} withdrawn ${noun(analysis.withdrawnRecords, 'record')} were retained in the complete report; ${analysis.withdrawnOnlyFindings.length} package ${noun(analysis.withdrawnOnlyFindings.length, 'version')} were withdrawn-only.`,
    `- Remediation: ${summary.remediation.verified} NCM-verified, ${summary.remediation.unresolved} unresolved, ${summary.remediation.verificationFailed} verification failures, ${summary.remediation.notRequired} not required.`,
    `- Terminal batch failures: ${summary.batchFailures.total} (${countsText(summary.batchFailures.byReason)}). Recovery restored ${summary.batchRecovery.recoveredPackages} package versions.`
  ]

  if (summary.ncmContentTruncation.truncatedFields > 0) {
    lines.push(`- NCM content truncation: ${summary.ncmContentTruncation.truncatedFields} fields and ${summary.ncmContentTruncation.truncatedCharacters} characters truncated.`)
  } else {
    lines.push('- No NCM field truncation occurred.')
  }

  lines.push('', '## Critical Findings', '')
  if (critical.length === 0) {
    lines.push('No active critical package-version findings were returned.')
  } else {
    for (const { finding } of critical) {
      const ids = Array.from(new Set(finding.vulnerabilities
        .filter(vulnerability => vulnerability.withdrawn !== true)
        .map(vulnerability => vulnerability.id || 'ID not returned')))
      lines.push(`- ${escapeMarkdown(finding.name)}@${escapeMarkdown(finding.version)} — ${ids.map(escapeMarkdown).join(', ')}; ${remediationText(finding)}.`)
    }
  }

  lines.push('', '## Verified Upgrade Actions', '')
  if (verifiedActions.length === 0) {
    lines.push('No NCM-verified upgrade targets were found.')
  } else {
    lines.push(`${verified.length} verified package-version ${noun(verified.length, 'finding')} ${verified.length === 1 ? 'is' : 'are'} represented by ${verifiedActions.length} grouped upgrade ${noun(verifiedActions.length, 'action')}.`)
    lines.push('', '| Installed | Target | Change | Verification |')
    lines.push('| --- | --- | --- | --- |')
    for (const action of verifiedActions) {
      const installed = Array.from(action.installed)
        .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }))
        .map(version => `${action.name}@${version}`)
        .join(', ')
      lines.push(`| ${escapeMarkdown(installed)} | ${escapeMarkdown(action.target)} | ${escapeMarkdown(action.changeType)} | ${escapeMarkdown(action.source)} |`)
    }
    lines.push('', 'Run the package manager’s `why` command before changing a manifest; exact manifest ownership remains unproven.')
  }

  lines.push('', '## Findings Requiring Follow-up', '')
  if (unresolved.length === 0 && verificationFailed.length === 0) {
    lines.push('No active findings remain unresolved or verification-failed.')
  } else {
    if (unresolved.length > 0) {
      const packages = unresolved.map(({ finding }) => `${finding.name}@${finding.version}`).map(escapeMarkdown)
      lines.push(`- Unresolved (${unresolved.length}): ${packages.join(', ')}.`)
    }
    if (verificationFailed.length > 0) {
      const packages = verificationFailed.map(({ finding }) => `${finding.name}@${finding.version}`).map(escapeMarkdown)
      lines.push(`- Verification failed (${verificationFailed.length}): ${packages.join(', ')}.`)
    }
  }

  lines.push('', '## Withdrawn-Only Findings', '')
  if (analysis.withdrawnOnlyFindings.length === 0) {
    lines.push('No withdrawn-only package-version findings were returned.')
  } else {
    const packages = analysis.withdrawnOnlyFindings
      .map(({ finding }) => `${finding.name}@${finding.version}`)
      .map(escapeMarkdown)
    lines.push(`${analysis.withdrawnOnlyFindings.length} withdrawn-only package ${noun(analysis.withdrawnOnlyFindings.length, 'version')} require no remediation: ${packages.join(', ')}.`)
  }

  lines.push('', '## Coverage Gaps', '')
  if (summary.packages.unchecked === 0) {
    lines.push('No package versions were left unchecked.')
  } else {
    lines.push(`${summary.packages.unchecked} unchecked package ${noun(summary.packages.unchecked, 'version')} were not proven safe: ${countsText(summary.packages.uncheckedByReason)}.`)
    lines.push('The complete report contains every unchecked package-version identifier and reason.')
  }

  lines.push('', '## Complete Report', '')
  lines.push(reportLink(reportPath))
  lines.push('')
  lines.push(`The underlying complete report reconciles ${analysis.findings}/${summary.vulnerabilities.affectedPackages} package-version findings, ${analysis.vulnerabilities}/${summary.vulnerabilities.total} vulnerability records, and ${analysis.unchecked}/${summary.packages.unchecked} unchecked package versions.`)
  lines.push('This executive summary intentionally omits per-record evidence, ranges, URLs, module risks, code-quality details, and the full unchecked-package list; use the linked report for those details.')
  lines.push('“NCM-verified” means free of active NCM advisories at audit time—not absolutely safe.')
  return lines.join('\n')
}

function renderFinding (item, index, findingTotal, renderState, recordTotal) {
  const { finding, renderedSeverity } = item
  const lines = [
    `### Finding ${index + 1}/${findingTotal}: ${escapeMarkdown(finding.name)}@${escapeMarkdown(finding.version)}`,
    '',
    `- Severity: ${escapeMarkdown(renderedSeverity.toUpperCase())}`,
    `- Dependency scope: ${dependencyScope(finding)}`,
    `- License: ${finding.license && finding.license.spdx ? escapeMarkdown(finding.license.spdx) : 'not returned'}`,
    '- Vulnerability records:'
  ]

  for (const vulnerability of finding.vulnerabilities) {
    renderState.records++
    if (vulnerability.withdrawn) renderState.withdrawnRecords++
    else renderState.activeRecords++
    const withdrawn = vulnerability.withdrawn ? ' — withdrawn' : ''
    lines.push(`  - Record ${renderState.records}/${recordTotal} — ${escapeMarkdown(vulnerability.severity)} — ${valueOrNotReturned(vulnerability.id)} — ${escapeMarkdown(vulnerability.title)}${withdrawn}`)
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

function whyCommand (packageManager, name) {
  return `${packageManager} why ${name}`
}

function renderRemediationPlan (summary, analysis) {
  const lines = ['## Remediation Plan', '']
  const verified = analysis.activeFindings.filter(item => item.finding.remediation.status === 'ncm-verified')
  if (verified.length === 0) {
    lines.push('No NCM-verified upgrade targets were found.')
  } else {
    lines.push('| Severity | Installed | Verified target | Scope | Change | Verification | Next step |')
    lines.push('| --- | --- | --- | --- | --- | --- | --- |')
    for (const { finding, renderedSeverity } of verified) {
      lines.push(`| ${escapeMarkdown(renderedSeverity.toUpperCase())} | ${escapeMarkdown(`${finding.name}@${finding.version}`)} | ${escapeMarkdown(finding.remediation.version)} | ${escapeMarkdown(dependencyScope(finding, true))} | ${escapeMarkdown(finding.remediation.changeType)} | ${escapeMarkdown(finding.remediation.source)} | ${escapeMarkdown(whyCommand(summary.packageManager, finding.name))} |`)
    }
    lines.push('', 'Command withheld because exact manifest ownership is not proven. These versions are NCM-verified targets, not instructions to edit an arbitrary root manifest.')
  }
  const unresolved = analysis.activeFindings.filter(item => item.finding.remediation.status === 'unresolved').length
  const failed = analysis.activeFindings.filter(item => item.finding.remediation.status === 'verification-failed').length
  if (unresolved > 0) lines.push(`- ${unresolved} finding(s) remain unresolved; use reported ranges as evidence, but verify a candidate with NCM before pinning.`)
  if (failed > 0) lines.push(`- ${failed} finding(s) could not complete remediation verification; this does not weaken the vulnerability finding.`)
  return { markdown: lines.join('\n'), rows: verified.length }
}

function renderBreakingChangeNotes (analysis) {
  const lines = ['## Breaking Change Notes', '']
  const majors = analysis.activeFindings.filter(item => {
    return item.finding.remediation.status === 'ncm-verified' && item.finding.remediation.changeType === 'major'
  })
  if (majors.length === 0) {
    lines.push('No NCM-verified major-version remediation targets were found.')
    return { markdown: lines.join('\n'), sourceFindings: 0, renderedInstalledVersions: 0 }
  }

  const groups = new Map()
  for (const { finding } of majors) {
    const key = `${finding.name}\u0000${finding.remediation.version}`
    if (!groups.has(key)) groups.set(key, { name: finding.name, target: finding.remediation.version, installed: new Set() })
    groups.get(key).installed.add(finding.version)
  }
  const ordered = Array.from(groups.values()).sort((a, b) => {
    return a.name.localeCompare(b.name) || a.target.localeCompare(b.target)
  })
  let renderedInstalledVersions = 0
  for (const group of ordered) {
    const installed = Array.from(group.installed).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    renderedInstalledVersions += installed.length
    const sources = installed.map(version => `${escapeMarkdown(group.name)}@${escapeMarkdown(version)}`).join(' and ')
    lines.push(`- ${sources} → ${escapeMarkdown(group.target)}`)
  }
  lines.push('', 'Review official changelogs and test build, development tooling, and runtime behavior before merging major upgrades.')
  return { markdown: lines.join('\n'), sourceFindings: majors.length, renderedInstalledVersions }
}

function renderCoverageGaps (summary) {
  if (summary.uncheckedPackages.length === 0) return ''
  const lines = ['## Coverage Gaps', '']
  const packages = [...summary.uncheckedPackages].sort((a, b) => {
    return a.reason.localeCompare(b.reason) || a.name.localeCompare(b.name) || a.version.localeCompare(b.version)
  })
  for (const pkg of packages) {
    lines.push(`- ${escapeMarkdown(pkg.name)}@${escapeMarkdown(pkg.version)} — ${escapeMarkdown(pkg.reason)}`)
  }
  lines.push('', 'Unchecked package versions were not proven safe.')
  const reasons = Array.from(new Set(packages.map(pkg => pkg.reason))).sort()
  for (const reason of reasons) {
    const guidance = COVERAGE_GUIDANCE[reason] || COVERAGE_GUIDANCE.unknown
    lines.push(`- ${escapeMarkdown(reason)}: ${guidance}`)
  }
  return lines.join('\n')
}

function renderFindingSection (title, items, startIndex, totalFindings, renderState, recordTotal, partition) {
  const lines = [`## ${title}`, '']
  if (items.length === 0) {
    lines.push(title === 'Active Findings'
      ? 'No active vulnerable package versions were returned.'
      : 'No withdrawn-only package versions were returned.')
    return lines.join('\n')
  }
  items.forEach((item, itemIndex) => {
    if (itemIndex > 0) lines.push('')
    renderState[partition]++
    lines.push(renderFinding(item, startIndex + itemIndex, totalFindings, renderState, recordTotal))
  })
  return lines.join('\n')
}

function renderAuditReport (summary) {
  const analysis = validateAuditSummary(summary)
  const lines = [
    '## Summary',
    '',
    `- ${summary.packages.checked} of ${summary.packages.total} package versions checked; ${summary.packages.unchecked} unchecked.`,
    `- ${analysis.activeRecords} active vulnerability ${noun(analysis.activeRecords, 'record')} across ${analysis.activeFindings.length} actively affected package ${noun(analysis.activeFindings.length, 'version')}: ${severityText(analysis.activeBySeverity)}.`,
    `- The complete NCM response contained ${analysis.rawRecords} vulnerability ${noun(analysis.rawRecords, 'record')} across ${summary.vulnerabilities.affectedPackages} affected package ${noun(summary.vulnerabilities.affectedPackages, 'version')}, including ${analysis.withdrawnRecords} withdrawn ${noun(analysis.withdrawnRecords, 'record')} and ${analysis.withdrawnOnlyFindings.length} withdrawn-only package ${noun(analysis.withdrawnOnlyFindings.length, 'version')}.`,
    `- Terminal batch failures: ${summary.batchFailures.total} (${countsText(summary.batchFailures.byReason)}). Recovery: ${summary.batchRecovery.transportRetries} transport retries, ${summary.batchRecovery.splitBatches} batch splits, ${summary.batchRecovery.missingPackageRetries} omitted-response retries, ${summary.batchRecovery.recoveredPackages} recovered package versions.`,
    `- Remediation: ${summary.remediation.verified} NCM-verified, ${summary.remediation.unresolved} unresolved, ${summary.remediation.verificationFailed} verification failures, ${summary.remediation.notRequired} not required. Candidate failures: ${summary.remediation.failures.total} (${countsText(summary.remediation.failures.byReason)}).`,
    `- Remediation recovery: ${summary.remediation.recovery.transportRetries} transport retries, ${summary.remediation.recovery.splitBatches} batch splits, ${summary.remediation.recovery.missingCandidateRetries} omitted-candidate retries.`
  ]
  if (summary.ncmContentTruncation.truncatedFields > 0) {
    lines.push(`- NCM content truncation: ${summary.ncmContentTruncation.truncatedFields} fields and ${summary.ncmContentTruncation.truncatedCharacters} characters truncated.`)
  } else {
    lines.push('- No NCM field truncation occurred.')
  }
  lines.push('', 'Vulnerability records are package-version occurrences; the same advisory may appear for multiple installed versions or more than once in the NCM response.')
  lines.push('', 'Root declaration matches are based on package names. The audit does not yet prove which manifest or workspace owns each resolved version.')
  lines.push('', '“NCM-verified” means free of active NCM advisories at audit time—not absolutely safe.')
  lines.push('', 'This is a static dependency audit; it does not establish runtime loading, reachability, or exploitability.')

  const coverage = renderCoverageGaps(summary)
  if (coverage) lines.push('', coverage)

  const renderState = {
    records: 0,
    activeRecords: 0,
    withdrawnRecords: 0,
    activeFindings: 0,
    withdrawnOnlyFindings: 0
  }
  lines.push('', renderFindingSection('Active Findings', analysis.activeFindings, 0, analysis.findings, renderState, analysis.vulnerabilities, 'activeFindings'))
  lines.push('', renderFindingSection('Withdrawn-Only Findings', analysis.withdrawnOnlyFindings, analysis.activeFindings.length, analysis.findings, renderState, analysis.vulnerabilities, 'withdrawnOnlyFindings'))
  assertEqual(renderState.activeFindings, analysis.activeFindings.length, 'rendered active findings')
  assertEqual(renderState.withdrawnOnlyFindings, analysis.withdrawnOnlyFindings.length, 'rendered withdrawn-only findings')
  assertEqual(renderState.records, analysis.vulnerabilities, 'rendered vulnerability records')
  assertEqual(renderState.activeRecords, analysis.activeRecords, 'rendered active records')
  assertEqual(renderState.withdrawnRecords, analysis.withdrawnRecords, 'rendered withdrawn records')

  const remediation = renderRemediationPlan(summary, analysis)
  assertEqual(remediation.rows, analysis.remediationCounts.verified, 'remediation table rows')
  const breaking = renderBreakingChangeNotes(analysis)
  assertEqual(breaking.sourceFindings, breaking.renderedInstalledVersions, 'breaking-change installed versions')
  lines.push('', remediation.markdown, '', breaking.markdown)

  lines.push('', '## Rollback Guidance', '')
  lines.push('The N|Solid upgrade workflow backs up `package.json` and the lockfile under `.nsolid/backup/`. For manually executed package-manager commands, rely on version control or create a separate backup first.')
  lines.push('', '## Report Integrity', '')
  lines.push(`Rendered ${renderState.activeFindings + renderState.withdrawnOnlyFindings}/${summary.vulnerabilities.affectedPackages} package-version findings, ${renderState.records}/${summary.vulnerabilities.total} vulnerability records, and ${analysis.unchecked}/${summary.packages.unchecked} unchecked package versions.`)
  lines.push(`Finding partition: ${renderState.activeFindings}/${analysis.activeFindings.length} active and ${renderState.withdrawnOnlyFindings}/${analysis.withdrawnOnlyFindings.length} withdrawn-only. Record partition: ${renderState.activeRecords}/${analysis.activeRecords} active and ${renderState.withdrawnRecords}/${analysis.withdrawnRecords} withdrawn.`)
  return lines.join('\n')
}

module.exports = { analyzeFindings, escapeMarkdown, renderAuditReport, renderAuditSummary, reportLink, validateAuditSummary }
