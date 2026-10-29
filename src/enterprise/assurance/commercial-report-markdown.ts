import type { CommercialReportContent } from './commercial-report.js';
import { readinessBanner } from './commercial-report-format.js';

/**
 * Markdown rendering of the commercial report (ASSURE-REP-01). Pure and
 * deterministic: the same content gives the same bytes -- LF line endings, one
 * trailing newline -- which is what `markdownDigest` covers.
 *
 * Every dynamic value goes through `text()`: control and bidirectional
 * characters are removed, whitespace collapses to single spaces (no value can
 * start a new line, heading, list or table row), and every Markdown and HTML
 * metacharacter is backslash-escaped. No raw HTML is emitted, and no value is
 * rendered as a link or an image.
 */

const MARKDOWN_METACHARACTERS = /[\\`*_{}[\]()#+\-.!|<>~&]/g;

export function escapeMarkdownText(value: string | number | boolean): string {
  return String(value)
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(MARKDOWN_METACHARACTERS, (character) => `\\${character}`);
}

const text = escapeMarkdownText;

function list(items: readonly string[], empty = 'None.'): string {
  return items.length === 0 ? `- ${text(empty)}` : items.map((item) => `- ${text(item)}`).join('\n');
}

function table(headers: readonly string[], rows: readonly (readonly (string | number)[])[]): string {
  const head = `| ${headers.map((header) => text(header)).join(' | ')} |`;
  const rule = `| ${headers.map(() => '---').join(' | ')} |`;
  const body = rows.map((row) => `| ${row.map((cell) => text(cell)).join(' | ')} |`);
  return [head, rule, ...body].join('\n');
}

export function renderCommercialReportMarkdown(report: CommercialReportContent): string {
  const { cover, executiveSummary: summary, scope, methodology, results, integrity } = report;
  // ASSURE-REL-01C: the wording follows the generator version the content was drafted with, so a v1 report re-renders to its original bytes.
  const banner = readinessBanner(report.readiness.status, integrity.generatorVersion);

  const sections: string[] = [
    `# ${text(cover.title)}`,
    banner,
    table(
      ['Field', 'Value'],
      [
        ['Service', cover.service],
        ['Assessment', cover.assessmentId],
        ['Organization', cover.organization],
        ['System or process', cover.system],
        ['Framework', `${cover.framework.name} (${cover.framework.id}@${cover.framework.version})`],
        ['Evidence cutoff', cover.evidenceCutoffAt],
        ['Issued on', cover.issuedOn],
        ['Classification', cover.confidentiality],
        ['Report version', cover.reportVersion],
        ['Report identifier', report.reportId],
      ],
    ),
    '_This report is not a certification, legal opinion or guarantee. Its conclusions are limited to the declared scope and the evidence cutoff._',

    '## Release readiness',
    `Status: **${text(report.readiness.status)}**`,
    table(
      ['Check', 'Result', 'Detail'],
      report.readiness.checks.map((entry) => [entry.check, entry.passed ? 'passed' : 'FAILED', entry.detail]),
    ),

    '## 1. Executive summary',
    text(summary.assessed),
    `**Purpose.** ${text(summary.purpose)}`,
    '**Demonstrated (PASS)**',
    list(summary.demonstrated),
    '**Partially demonstrated (PARTIAL)**',
    list(summary.partiallyDemonstrated),
    '**Observed not satisfied (FAIL)**',
    list(summary.observedFailures),
    '**Not determined — insufficient evidence (UNKNOWN; not a failure)**',
    list(summary.insufficientEvidence),
    ...(summary.pendingReview.length > 0 ? ['**Pending review**', list(summary.pendingReview)] : []),
    '**Principal risks**',
    list(summary.principalRisks, 'No risk is sustained by an observed failure or partial result.'),
    '**Priority findings**',
    list(summary.priorityFindings, 'No critical or high-severity finding.'),
    '**Recommended next actions**',
    list(summary.nextActions),

    '## 2. Scope and boundaries',
    table(
      ['Field', 'Value'],
      [
        ['Organization', scope.organization],
        ['System or process', scope.system],
        ['Description', scope.systemDescription],
        ['Subject type', scope.subjectType],
        ['Period from', scope.periodFrom],
        ['Period to', scope.periodTo],
        ['Evidence cutoff', scope.evidenceCutoffAt],
      ],
    ),
    '**In scope**',
    list(scope.inScope),
    '**Exclusions**',
    list(scope.exclusions),
    '**Dependencies**',
    list(scope.dependencies),
    '**Access limitations**',
    list(scope.accessLimitations),
    '**Evidence sources**',
    list(scope.evidenceSources),
    '**Activities not performed**',
    list(scope.activitiesNotPerformed),

    '## 3. Methodology',
    list(methodology.steps.map((step, index) => `Step ${index + 1}: ${step}`)),
    `Required reviewer role: ${text(methodology.reviewerRole)}.`,
    `Scoring: ${text(methodology.scoring)}`,

    '## 4. Control coverage',
    table(
      ['ID', 'Control', 'Domain', 'Result', 'Evidence', 'Findings'],
      report.controls.map((control) => [control.controlId, control.title, control.domain, control.statusLabel, control.evidence.join(', ') || '—', control.findings.join(', ') || '—']),
    ),
    ...report.controls.flatMap((control) => [
      `### ${text(control.controlId)} — ${text(control.title)}`,
      `**Result: ${text(control.statusLabel)}.** ${text(control.conclusion)}`,
      `Objective: ${text(control.objective)}`,
      `Review: ${control.review.authenticated ? `authenticated reviewer(s) ${text(control.review.reviewers.join(', '))}${control.review.reviewedOn !== undefined ? `, ${text(control.review.reviewedOn)}` : ''}` : 'no authenticated review on record'}. Reviewer rationale is kept in the assessment record and is not reproduced here.`,
      `Evidence: ${text(control.evidence.join(', ') || 'none accepted')}. Findings: ${text(control.findings.join(', ') || 'none')}.`,
      '**Limitations**',
      list(control.limitations),
      ...(control.revalidation !== undefined ? [`Revalidation: ${text(control.revalidation)}`] : []),
    ]),

    '## 5. Results and interpretation',
    table(
      ['Measure', 'Value'],
      [
        ['Score (0–100)', results.normalizedScore],
        ['Methodology', results.methodology],
        ['Controls evaluated', results.controlsEvaluated],
        ['PASS', results.counts.pass],
        ['PARTIAL', results.counts.partial],
        ['FAIL', results.counts.fail],
        ['UNKNOWN', results.counts.unknown],
        ['MANUAL REVIEW REQUIRED', results.counts.manual_review_required],
        ['Open findings', results.openFindings],
        ['Findings recorded after completion (not part of this report)', results.findingsRecordedAfterCompletion],
      ],
    ),
    text(results.interpretation),
    table(
      ['Domain', 'Status', 'Score'],
      results.domains.map((domain) => [domain.domain, domain.status, domain.normalizedScore]),
    ),
    '**Blocking risks**',
    list(results.blockingRisks),

    '## 6. Findings',
    ...(report.findings.length === 0
      ? ['No findings.']
      : report.findings.flatMap((finding) => [
          `### ${text(finding.label)} — ${text(finding.controlId)} ${text(finding.controlTitle)}`,
          table(
            ['Field', 'Value'],
            [
              ['Finding', finding.findingId],
              ['Severity', finding.severity],
              ['Engine classification', finding.findingType],
              ['Remediation type', finding.remediationType],
              ['Status', finding.status],
              ['Priority', finding.priority],
              ['Evidence', finding.evidence.join(', ') || '—'],
            ],
          ),
          text(finding.description),
          ...(finding.risk !== undefined ? [`Risk: ${text(finding.risk)}`] : []),
          `Recommendation: ${text(finding.recommendation)}`,
          `Closure criterion: ${text(finding.closureCriterion)}`,
        ])),

    '## 7. Remediation roadmap',
    report.remediationRoadmap.items.length === 0
      ? 'No remediation items.'
      : table(
          ['#', 'Finding', 'Control', 'Severity', 'Type', 'Priority', 'Owner', 'Target date'],
          report.remediationRoadmap.items.map((item) => [item.order, item.finding, item.controlId, item.severity, item.remediationType, item.priority, item.owner, item.targetDate]),
        ),
    text(report.remediationRoadmap.humanProposals),

    '## 8. Evidence register',
    'Evidence is listed under report-local labels. Supplier identifiers, locations and contents are not reproduced; the digest identifies the referenced bytes.',
    report.evidenceRegister.length === 0
      ? 'No evidence references.'
      : table(
          ['Ref', 'Controls', 'Type', 'Acceptance', 'Verification', 'Date', 'Digest'],
          report.evidenceRegister.map((entry) => [
            entry.label,
            entry.controls.join(', ') || '—',
            entry.evidenceType,
            entry.acceptance === 'accepted' ? 'accepted' : `rejected (${entry.rejectionCodes.join(', ')})`,
            entry.verification,
            entry.relevantDate,
            entry.digest ?? '—',
          ]),
        ),
    'Authenticity: unless marked as verified by a Host mechanism, a reference’s author and truthfulness are not established.',

    '## 9. Limitations and disclaimers',
    list(report.limitations),

    '## 10. Revalidation',
    '**Findings to revalidate**',
    list(report.revalidation.findingsToRevalidate),
    '**Controls to re-evaluate**',
    list(report.revalidation.controlsToReevaluate),
    '**Evidence required**',
    list(report.revalidation.evidenceRequired),
    '**Changes that would invalidate these conclusions**',
    list(report.revalidation.invalidatingChanges),
    text(report.revalidation.linkage),
    text(report.revalidation.monitoring),

    '## 11. Integrity and provenance',
    table(
      ['Field', 'Value'],
      [
        ['Assessment', integrity.assessmentId],
        ['Assessment digest', integrity.assessmentDigest],
        ['Framework', `${integrity.frameworkId}@${integrity.frameworkVersion}`],
        ['Framework digest', integrity.frameworkDigest],
        ['Generator', integrity.generatorVersion],
        ['Issued on', integrity.issuedOn],
        ['Evidence cutoff', integrity.evidenceCutoffAt],
        ['Authenticated reviewers', integrity.reviewers.join(', ') || 'none'],
        ['Framework commercial use', integrity.commercialUse.frameworkStatus],
      ],
    ),
    text(integrity.commercialUse.statement),
    text(integrity.release),
    text(integrity.limitation),
    'The content digest, Markdown digest and manifest digest of this document are recorded in its manifest, not in this text.',
  ];
  return `${sections.filter((section) => section.length > 0).join('\n\n')}\n`;
}
