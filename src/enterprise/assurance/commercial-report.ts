import { createHash } from 'node:crypto';

import { computeDigest, isWellFormedDigest } from '../governance-store/digest.js';
import { AOC_CANONICALIZATION_VERSION } from '../governance-store/canonical-json.js';
import { AssuranceError } from './errors.js';
import { findingHistoryViolations } from './finding-history.js';
import { isHostVerified } from './manual-evidence-trust.js';
import { renderCommercialReportMarkdown } from './commercial-report-markdown.js';
import { RN_SV_FRAMEWORK_ID, RN_SV_FRAMEWORK_V0_1, RN_SV_FRAMEWORK_VERSION } from './frameworks/rn-sv-framework.js';
import type {
  AssuranceAssessment,
  AssuranceAssessmentVerificationResult,
  AssuranceControlStatus,
  AssuranceEvidenceReference,
  AssuranceFinding,
  AssuranceFindingEvent,
  AssuranceFindingSeverity,
  AssuranceFindingType,
  AssuranceFramework,
  AssuranceManualReviewRecord,
} from './contracts.js';
import { ASSURANCE_FINDING_SEVERITIES } from './contracts.js';

/**
 * The commercial Republika Sovereignty Assessment report (ASSURE-REP-01): a
 * `rn.sv@0.1.0`-only projection of a completed assessment, separate from the
 * `INTERNAL`/`AUDITOR`/`CUSTOMER`/`PUBLIC` views of `report.ts`, which it
 * neither reads nor changes.
 *
 * - **Source of truth.** Statuses, score, findings, severities, evidence and
 *   reviewers come only from the stored assessment, its verification, its
 *   finding histories and its manual reviews. The engagement declaration
 *   supplies what the assessment does not hold -- organization and system
 *   names, scope boundaries -- and nothing it says can change a result.
 * - **Disclosure: deny by default.** Every field is built from an allowlist.
 *   Narrative text comes from the framework definition (Host-authored), never
 *   from a reviewer rationale, an evaluation summary, a finding description,
 *   evidence metadata or any supplier-controlled identifier. Evidence is
 *   listed under report-local labels with its digest. Engagement text that
 *   cannot be classified as safe is withheld and blocks release.
 * - **Determinism.** The content is a function of its inputs: no clock and no
 *   generated id are read. The issue date and report version are inputs.
 * - **Integrity, not signature.** `contentDigest` covers the canonical JSON,
 *   `markdownDigest` the exact Markdown bytes, `manifestDigest` the manifest.
 *   A release record binds a human approval to those digests. None of these
 *   is a digital signature, and none proves the underlying evidence true.
 */

export const COMMERCIAL_REPORT_SCHEMA_VERSION = 'rn.sv.commercial-report.v1';
export const COMMERCIAL_REPORT_GENERATOR_VERSION = 'aoc.assurance.commercial-report.v1';
export const COMMERCIAL_REPORT_TITLE = 'Republika Sovereignty Assessment — Founding Assessment';
/** The configured reviewer-credential role that may approve a commercial release. Never implied by `assure.reviewer`. */
export const COMMERCIAL_REPORT_RELEASE_ROLE = 'assure.report-release';

const RN_SV_FRAMEWORK_DIGEST = computeDigest(RN_SV_FRAMEWORK_V0_1);
const RN_SV_CONTROL_IDS = ['SV-01', 'SV-02', 'SV-03', 'SV-04', 'SV-05', 'SV-06', 'SV-07', 'SV-08', 'SV-09', 'SV-10'] as const;
const NOT_SPECIFIED = 'Not specified';
const TO_BE_AGREED = 'To be agreed with customer';

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export type CommercialReportConfidentiality = 'CONFIDENTIAL' | 'RESTRICTED';

/**
 * What the issuing engagement declares and the assessment does not hold.
 * Every string is untrusted until validated; an invalid one is withheld.
 */
export interface CommercialEngagementDeclaration {
  readonly organizationName: string;
  readonly systemName: string;
  readonly systemDescription: string;
  readonly purpose: string;
  readonly inScope: readonly string[];
  readonly exclusions: readonly string[];
  readonly dependencies: readonly string[];
  readonly accessLimitations: readonly string[];
  readonly confidentiality?: CommercialReportConfidentiality;
}

/** The variable data of one issue, kept out of the assessment-derived content so the same inputs give the same bytes. */
export interface CommercialReportIssue {
  /** Calendar date of issue, `YYYY-MM-DD`. */
  readonly issuedOn: string;
  /** Delivery version, e.g. `1.0`. */
  readonly reportVersion: string;
}

export interface CommercialReportSources {
  readonly assessment: AssuranceAssessment;
  readonly framework: AssuranceFramework;
  readonly verification: AssuranceAssessmentVerificationResult;
  /** Findings with their status folded from their event histories (`listFindings`). */
  readonly findings: readonly AssuranceFinding[];
  readonly findingEvents: ReadonlyMap<string, readonly AssuranceFindingEvent[]>;
  readonly manualReviews: readonly AssuranceManualReviewRecord[];
  readonly engagement: unknown;
  readonly issue: unknown;
}

// ---------------------------------------------------------------------------
// Output schema
// ---------------------------------------------------------------------------

export type CommercialReportReadiness = 'DRAFT' | 'READY_FOR_RELEASE';

export interface CommercialReleaseCheck {
  readonly check: string;
  readonly passed: boolean;
  readonly detail: string;
}

export interface CommercialControlResult {
  readonly controlId: string;
  readonly title: string;
  readonly domain: string;
  readonly objective: string;
  readonly status: AssuranceControlStatus;
  readonly statusLabel: string;
  readonly conclusion: string;
  readonly evidence: readonly string[];
  readonly findings: readonly string[];
  readonly limitations: readonly string[];
  readonly revalidation?: string;
  readonly review: { readonly authenticated: boolean; readonly reviewers: readonly string[]; readonly reviewedOn?: string };
}

export interface CommercialFinding {
  readonly label: string;
  readonly findingId: string;
  readonly controlId: string;
  readonly controlTitle: string;
  readonly severity: AssuranceFindingSeverity;
  readonly findingType: AssuranceFindingType;
  readonly status: string;
  readonly description: string;
  readonly evidence: readonly string[];
  readonly risk?: string;
  readonly remediationType: string;
  readonly recommendation: string;
  readonly closureCriterion: string;
  readonly priority: string;
}

export interface CommercialRoadmapItem {
  readonly order: number;
  readonly finding: string;
  readonly controlId: string;
  readonly severity: AssuranceFindingSeverity;
  readonly remediationType: string;
  readonly priority: string;
  readonly dependencies: string;
  readonly revalidation: string;
  readonly owner: string;
  readonly targetDate: string;
  readonly source: 'engine-generated';
}

export interface CommercialEvidenceEntry {
  readonly label: string;
  readonly controls: readonly string[];
  readonly evidenceType: string;
  readonly acceptance: 'accepted' | 'rejected';
  readonly rejectionCodes: readonly string[];
  readonly verification: string;
  readonly relevantDate: string;
  readonly digest?: string;
  readonly authenticityLimitation: string;
}

export interface CommercialReportContent {
  readonly schemaVersion: string;
  readonly reportId: string;
  readonly cover: {
    readonly title: string;
    readonly service: string;
    readonly assessmentId: string;
    readonly organization: string;
    readonly system: string;
    readonly framework: { readonly id: string; readonly version: string; readonly name: string };
    readonly evidenceCutoffAt: string;
    readonly issuedOn: string;
    readonly confidentiality: CommercialReportConfidentiality;
    readonly reportVersion: string;
  };
  readonly readiness: { readonly status: CommercialReportReadiness; readonly checks: readonly CommercialReleaseCheck[] };
  readonly executiveSummary: {
    readonly assessed: string;
    readonly purpose: string;
    readonly demonstrated: readonly string[];
    readonly partiallyDemonstrated: readonly string[];
    readonly observedFailures: readonly string[];
    readonly insufficientEvidence: readonly string[];
    readonly pendingReview: readonly string[];
    readonly principalRisks: readonly string[];
    readonly priorityFindings: readonly string[];
    readonly nextActions: readonly string[];
  };
  readonly scope: {
    readonly organization: string;
    readonly system: string;
    readonly systemDescription: string;
    readonly subjectType: string;
    readonly inScope: readonly string[];
    readonly exclusions: readonly string[];
    readonly dependencies: readonly string[];
    readonly accessLimitations: readonly string[];
    readonly periodFrom: string;
    readonly periodTo: string;
    readonly evidenceCutoffAt: string;
    readonly evidenceSources: readonly string[];
    readonly activitiesNotPerformed: readonly string[];
  };
  readonly methodology: { readonly steps: readonly string[]; readonly reviewerRole: string; readonly scoring: string };
  readonly controls: readonly CommercialControlResult[];
  readonly results: {
    readonly normalizedScore: number;
    readonly methodology: string;
    readonly interpretation: string;
    readonly domains: readonly { readonly domain: string; readonly status: string; readonly normalizedScore: number }[];
    readonly controlsEvaluated: number;
    readonly counts: Readonly<Record<'pass' | 'partial' | 'fail' | 'unknown' | 'manual_review_required' | 'not_applicable', number>>;
    readonly blockingRisks: readonly string[];
    readonly openFindings: number;
    readonly findingsRecordedAfterCompletion: number;
  };
  readonly findings: readonly CommercialFinding[];
  readonly remediationRoadmap: { readonly items: readonly CommercialRoadmapItem[]; readonly humanProposals: string };
  readonly evidenceRegister: readonly CommercialEvidenceEntry[];
  readonly limitations: readonly string[];
  readonly revalidation: {
    readonly findingsToRevalidate: readonly string[];
    readonly controlsToReevaluate: readonly string[];
    readonly evidenceRequired: readonly string[];
    readonly invalidatingChanges: readonly string[];
    readonly linkage: string;
    readonly monitoring: string;
  };
  readonly integrity: {
    readonly assessmentId: string;
    readonly assessmentDigest: string;
    readonly frameworkId: string;
    readonly frameworkVersion: string;
    readonly frameworkDigest: string;
    readonly generatorVersion: string;
    readonly issuedOn: string;
    readonly evidenceCutoffAt: string;
    readonly reviewers: readonly string[];
    readonly commercialUse: { readonly frameworkStatus: string; readonly statement: string };
    readonly release: string;
    readonly limitation: string;
  };
}

export interface CommercialReportManifest {
  readonly manifestVersion: string;
  readonly reportId: string;
  readonly assessmentId: string;
  readonly assessmentDigest: string;
  readonly frameworkId: string;
  readonly frameworkVersion: string;
  readonly frameworkDigest: string;
  readonly generatorVersion: string;
  readonly readiness: CommercialReportReadiness;
  readonly canonicalizationVersion: string;
  /** sha256 over the canonical JSON (`aoc.canonical-json.v1`) of `content`. */
  readonly contentDigest: string;
  /** sha256 over the exact UTF-8 bytes of `markdown` (LF line endings, one trailing newline). */
  readonly markdownDigest: string;
  readonly manifestDigest: string;
}

export interface CommercialReportDraft {
  readonly content: CommercialReportContent;
  readonly markdown: string;
  readonly manifest: CommercialReportManifest;
}

export interface CommercialReleaseAcknowledgements {
  /** The approver read the limitations, exclusions and scope as rendered. */
  readonly limitationsReviewed: true;
  /** The approver acknowledges `rn.sv@0.1.0`'s recorded commercial-use restriction and acts as its controlled review. */
  readonly commercialUseRestrictionAcknowledged: true;
}

export interface CommercialReportRelease {
  readonly releaseVersion: string;
  readonly reportId: string;
  readonly assessmentId: string;
  readonly contentDigest: string;
  readonly markdownDigest: string;
  readonly manifestDigest: string;
  readonly approvedBy: string;
  readonly approverRole: string;
  readonly approvalAuthentication: 'assurance_reviewer_credential';
  readonly approvedAt: string;
  readonly acknowledgements: CommercialReleaseAcknowledgements;
  readonly statement: string;
  readonly releaseDigest: string;
}

// ---------------------------------------------------------------------------
// Disclosure: text classification (a second layer -- the allowlist is the first)
// ---------------------------------------------------------------------------

const UNSAFE_TEXT_PATTERNS: readonly RegExp[] = [
  /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/u,
  /[<>`]/,
  /\b[a-z][a-z0-9+.-]*:\/\//i,
  /\bwww\./i,
  /[\w.+-]+@[\w-]+\.[\w.]+/,
  /\b(bearer|basic)\s+[a-z0-9._~+/=-]{8,}/i,
  /\b(api[_-]?key|secret|password|passwd|token|cookie|credential|private[_ -]?key|authorization)\b/i,
  /\b(sk|pk|rk|ghp|gho|xox[abp])[-_][a-z0-9]{8,}/i,
  /\b[A-Za-z0-9+/]{32,}={0,2}/,
  /\b(?:\d{1,3}\.){3}\d{1,3}\b/,
  /\bignore (all|any|previous)\b|\bsystem prompt\b/i,
];

interface TextOutcome {
  readonly value: string;
  readonly ok: boolean;
}

function classifyText(value: unknown, maximumLength: number): TextOutcome {
  if (typeof value !== 'string') return { value: NOT_SPECIFIED, ok: false };
  const trimmed = value.trim();
  if (trimmed.length === 0) return { value: NOT_SPECIFIED, ok: false };
  if (trimmed.length > maximumLength || UNSAFE_TEXT_PATTERNS.some((pattern) => pattern.test(trimmed))) {
    return { value: '[Withheld: text could not be cleared for disclosure]', ok: false };
  }
  return { value: trimmed, ok: true };
}

function classifyList(value: unknown, maximumItems: number, maximumLength: number, requireOne: boolean): { readonly values: readonly string[]; readonly ok: boolean } {
  if (!Array.isArray(value) || value.length > maximumItems) return { values: [NOT_SPECIFIED], ok: false };
  if (value.length === 0) return requireOne ? { values: [NOT_SPECIFIED], ok: false } : { values: ['None declared'], ok: true };
  const outcomes = value.map((item) => classifyText(item, maximumLength));
  return { values: outcomes.map((outcome) => outcome.value), ok: outcomes.every((outcome) => outcome.ok) };
}

// ---------------------------------------------------------------------------
// Framework-authored text
// ---------------------------------------------------------------------------

interface ControlProfile {
  readonly risk: string;
  readonly satisfiedWhen: string;
  readonly notSatisfiedWhen: string;
  readonly inconclusiveWhen: string;
  readonly limitations: readonly string[];
  readonly revalidation: string;
}

function controlProfile(framework: AssuranceFramework, controlId: string): ControlProfile | undefined {
  const profiles = (framework.metadata?.['controlProfiles'] ?? {}) as Readonly<Record<string, ControlProfile>>;
  return profiles[controlId];
}

const STATUS_LABEL: Readonly<Record<AssuranceControlStatus, string>> = {
  pass: 'PASS',
  partial: 'PARTIAL',
  fail: 'FAIL',
  unknown: 'UNKNOWN',
  not_applicable: 'NOT APPLICABLE',
  manual_review_required: 'MANUAL REVIEW REQUIRED',
};

function conclusionFor(status: AssuranceControlStatus, profile: ControlProfile | undefined): string {
  switch (status) {
    case 'pass':
      return `The reviewer concluded the control's criteria were met over the reviewed sample: ${profile?.satisfiedWhen ?? 'criteria met.'}`;
    case 'partial':
      return 'The reviewer concluded the criteria were met only in part over the reviewed sample.';
    case 'fail':
      return `The reviewer observed the control not satisfied: ${profile?.notSatisfiedWhen ?? 'criteria not met.'}`;
    case 'unknown':
      return `Not determined: the evidence available did not allow a defensible conclusion. This is an evidence gap, not an observed failure. Typical cause: ${profile?.inconclusiveWhen ?? 'evidence not provided.'}`;
    case 'manual_review_required':
      return 'Not concluded: the required human review has not been recorded.';
    case 'not_applicable':
      return 'Not applicable to the declared scope.';
  }
}

const SEVERITY_RANK = new Map<AssuranceFindingSeverity, number>(ASSURANCE_FINDING_SEVERITIES.map((severity, index) => [severity, index]));

/** What the customer is asked to do, from the control's actual result (an engine `evidence_gap` finding also covers PARTIAL results). */
function remediationTypeFor(status: AssuranceControlStatus | undefined, findingType: AssuranceFindingType): string {
  if (findingType === 'integrity_issue') return 'Integrity correction';
  if (status === 'fail' || status === 'partial') return 'Corrective action';
  if (status === 'unknown') return 'Provide evidence';
  if (status === 'manual_review_required') return 'Complete review';
  return 'Review';
}

const PRIORITY_LABEL: Readonly<Record<string, string>> = { immediate: 'Immediate', high: 'High', normal: 'Normal', low: 'Low' };

const LIMITATIONS: readonly string[] = [
  'This is a limited-scope assessment of the declared scope only; conditions outside it were not examined.',
  'Results are point-in-time, as of the evidence cutoff, and do not describe the system before or after it.',
  'Conclusions depend on the evidence made available; most evidence was supplied by the assessed organization and was not independently authenticated.',
  'Every rn.sv control is concluded by an authenticated human reviewer; the conclusions involve professional judgement.',
  'This report is not a certification, accreditation, attestation of compliance, or seal of any kind.',
  'This report is not a legal opinion and does not state compliance with any law or regulation.',
  'This report does not establish the absence of vulnerabilities, and no security testing was performed against the assessed systems.',
  'The score is specific to the rn.sv@0.1.0 framework, its methodology and the declared scope; it is not a general trust or security score.',
  'Document digests show that this report has not changed since it was generated; they do not show that the underlying evidence is true, and they are not a digital signature.',
];

const ACTIVITIES_NOT_PERFORMED: readonly string[] = [
  'Active or penetration testing of the assessed systems (rn.sv@0.1.0 performs no active testing).',
  'Source code review.',
  'On-site visits.',
  'Interviews: none are recorded in the assessment, and none are represented in this report.',
  'Independent collection of evidence from the assessed systems: evidence was supplied by the assessed organization.',
];

const METHODOLOGY_STEPS: readonly string[] = [
  'Scope declared and fixed in the assessment record before evaluation (immutable scope).',
  'The ten rn.sv@0.1.0 controls identified for the scope.',
  'Evidence references collected; each manually supplied reference is bound to the requirement it was offered for.',
  'Structural and provenance checks available to the Host applied: binding, tenant attribution, digests where present. Supplier claims of verification are recorded as claims only.',
  'Each control reviewed by an authenticated reviewer holding the required role; a definitive conclusion must cite evidence accepted for that control.',
  'Controls evaluated and scored under the framework methodology.',
  'Findings derived and classified by rule-based severity.',
  'Assessment integrity and finding histories verified.',
  'This report generated deterministically from the verified assessment.',
  'Release reviewed and approved by an authenticated human approver before delivery.',
];

const INVALIDATING_CHANGES: readonly string[] = [
  'Changes to the in-scope systems, their architecture or their tenancy model.',
  'Changes to the authority, consent or revocation mechanisms.',
  'A new policy version or a change in how decisions record the policy applied.',
  'Changes to logging, record integrity or disclosure profiles.',
  'Material incidents affecting the in-scope systems after the evidence cutoff.',
];

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

function sha256Text(text: string): string {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

function isoInstant(value: string | undefined): string | undefined {
  return value !== undefined && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(value) ? value : undefined;
}

function dateOf(value: string | undefined): string | undefined {
  return isoInstant(value)?.slice(0, 10);
}

function evidenceVerification(reference: AssuranceEvidenceReference): string {
  if (isHostVerified(reference)) return 'Verified by a Host mechanism';
  if (reference.supplierClaims?.verified === true) return 'Supplier-provided; the supplier claims verification (claim only, not verified by the Host)';
  return 'Supplier-provided; not verified by the Host';
}

/**
 * Builds the draft: content, Markdown and manifest. Throws only when no report
 * can be drafted at all (not an `rn.sv` assessment, not completed). Every other
 * shortfall is a failed release check, and the draft stays a `DRAFT`.
 */
export function buildCommercialReportDraft(sources: CommercialReportSources): CommercialReportDraft {
  const { assessment, framework, verification } = sources;
  if (assessment.frameworkId !== RN_SV_FRAMEWORK_ID || assessment.frameworkVersion !== RN_SV_FRAMEWORK_VERSION) {
    throw new AssuranceError(
      'ASSURANCE_FRAMEWORK_VERSION_UNSUPPORTED',
      `The commercial report is defined for ${RN_SV_FRAMEWORK_ID}@${RN_SV_FRAMEWORK_VERSION} only; assessment '${assessment.assessmentId}' uses ${assessment.frameworkId}@${assessment.frameworkVersion}.`,
    );
  }
  if (assessment.status !== 'completed' && assessment.status !== 'superseded') {
    throw new AssuranceError('ASSURANCE_ASSESSMENT_INCOMPLETE', `A commercial report derives only from a completed assessment; '${assessment.assessmentId}' is '${assessment.status}'.`);
  }

  const checks: CommercialReleaseCheck[] = [];
  const check = (name: string, passed: boolean, detail: string): void => {
    checks.push({ check: name, passed, detail });
  };

  // -- Engagement declaration and issue (untrusted input) --------------------
  const engagement = (typeof sources.engagement === 'object' && sources.engagement !== null ? sources.engagement : {}) as Partial<Record<keyof CommercialEngagementDeclaration, unknown>>;
  const organization = classifyText(engagement.organizationName, 120);
  const system = classifyText(engagement.systemName, 120);
  const systemDescription = classifyText(engagement.systemDescription, 600);
  const purpose = classifyText(engagement.purpose, 400);
  const inScope = classifyList(engagement.inScope, 20, 200, true);
  const exclusions = classifyList(engagement.exclusions, 20, 200, true);
  const dependencies = classifyList(engagement.dependencies, 20, 200, false);
  const accessLimitations = classifyList(engagement.accessLimitations, 20, 200, false);
  const confidentiality: CommercialReportConfidentiality = engagement.confidentiality === 'RESTRICTED' ? 'RESTRICTED' : 'CONFIDENTIAL';
  const confidentialityOk = engagement.confidentiality === undefined || engagement.confidentiality === 'CONFIDENTIAL' || engagement.confidentiality === 'RESTRICTED';
  const scopeComplete = [organization, system, systemDescription, purpose].every((outcome) => outcome.ok) && inScope.ok && exclusions.ok && dependencies.ok && accessLimitations.ok && confidentialityOk;
  check(
    'scope_declared',
    scopeComplete,
    scopeComplete
      ? 'Organization, system, purpose, in-scope items, exclusions, dependencies and access limitations are declared and cleared for disclosure.'
      : 'A required scope field is missing, malformed or could not be cleared for disclosure; it is shown as not specified or withheld.',
  );

  const issue = (typeof sources.issue === 'object' && sources.issue !== null ? sources.issue : {}) as Partial<Record<keyof CommercialReportIssue, unknown>>;
  const issuedOn = typeof issue.issuedOn === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(issue.issuedOn) ? issue.issuedOn : undefined;
  const reportVersion = typeof issue.reportVersion === 'string' && /^\d{1,3}\.\d{1,3}$/.test(issue.reportVersion) ? issue.reportVersion : undefined;
  if (issuedOn === undefined || reportVersion === undefined) {
    throw new AssuranceError('ASSURANCE_VALIDATION_ERROR', 'A commercial report needs issue.issuedOn (YYYY-MM-DD) and issue.reportVersion (e.g. 1.0).');
  }
  if (issuedOn < assessment.scope.evidenceCutoffAt.slice(0, 10)) {
    throw new AssuranceError('ASSURANCE_VALIDATION_ERROR', `issue.issuedOn (${issuedOn}) precedes the evidence cutoff (${assessment.scope.evidenceCutoffAt}).`);
  }

  // -- Release checks over the assessment --------------------------------------
  check('assessment_completed', assessment.status === 'completed', assessment.status === 'completed' ? 'The assessment is completed and current.' : `The assessment is '${assessment.status}'; a superseded assessment is no longer current.`);
  const frameworkExact = framework.frameworkId === RN_SV_FRAMEWORK_ID && framework.frameworkVersion === RN_SV_FRAMEWORK_VERSION && computeDigest(framework) === RN_SV_FRAMEWORK_DIGEST;
  check('framework_exact', frameworkExact, frameworkExact ? `${RN_SV_FRAMEWORK_ID}@${RN_SV_FRAMEWORK_VERSION}, definition digest matches.` : 'The framework definition is not the published rn.sv@0.1.0 definition.');
  check('assessment_verified', verification.valid && verification.assessmentId === assessment.assessmentId, verification.valid ? 'Assessment integrity and structure verify.' : `Assessment verification failed (${verification.failures.length} failure(s)).`);

  // The report is point-in-time: the assessment's own findings, each with the status its history shows now.
  const storedFindings = new Map(sources.findings.map((finding) => [finding.findingId, finding]));
  const reportFindings = assessment.findings.map((finding) => storedFindings.get(finding.findingId) ?? finding);
  const findingsRecordedAfterCompletion = sources.findings.filter((finding) => !assessment.findings.some((own) => own.findingId === finding.findingId)).length;
  const historyProblems = reportFindings.flatMap((finding) =>
    findingHistoryViolations(finding, assessment.subject.organizationId, sources.findingEvents.get(finding.findingId) ?? []).map((violation) => `${finding.findingId}: ${violation}`),
  );
  const findingSetMatches = assessment.findings.every((finding) => storedFindings.has(finding.findingId));
  check(
    'finding_histories_consistent',
    historyProblems.length === 0 && findingSetMatches,
    historyProblems.length === 0 && findingSetMatches ? 'Every finding has a complete, intact event history.' : `Finding history problems: ${findingSetMatches ? historyProblems.length : 'stored findings differ from the assessment'}.`,
  );

  const authenticatedReviews = sources.manualReviews.filter((review) => review.assessmentId === assessment.assessmentId && review.reviewerAuthentication === 'assurance_reviewer_credential');
  const unauthenticatedReviews = sources.manualReviews.filter((review) => review.assessmentId === assessment.assessmentId && review.reviewerAuthentication === undefined);
  const evaluationsById = new Map(assessment.controlEvaluations.map((evaluation) => [evaluation.controlId, evaluation]));
  const coverage = RN_SV_CONTROL_IDS.every((controlId) => evaluationsById.has(controlId)) && assessment.controlEvaluations.length === RN_SV_CONTROL_IDS.length;
  check('control_coverage', coverage, coverage ? 'All ten rn.sv@0.1.0 controls were evaluated.' : 'The assessment does not cover exactly the ten rn.sv@0.1.0 controls.');
  const unreviewed = RN_SV_CONTROL_IDS.filter((controlId) => {
    const status = evaluationsById.get(controlId)?.status;
    return status === undefined || status === 'manual_review_required' || !authenticatedReviews.some((review) => review.controlId === controlId);
  });
  check(
    'human_review_authenticated',
    unreviewed.length === 0,
    unreviewed.length === 0
      ? `Every control was concluded by an authenticated reviewer.${unauthenticatedReviews.length > 0 ? ` ${unauthenticatedReviews.length} unauthenticated historical review(s) are on record and resolve nothing.` : ''}`
      : `Controls without an authenticated review: ${unreviewed.join(', ')}.`,
  );

  // -- Evidence register (report-local labels; supplier identifiers never leave) --
  // Accepted references live on the assessment; rejected ones only in the resolutions.
  const referencesById = new Map<string, AssuranceEvidenceReference>();
  for (const reference of assessment.evidenceReferences) referencesById.set(reference.evidenceReferenceId, reference);
  for (const resolution of assessment.evidenceResolutions) {
    for (const rejected of resolution.rejectedEvidence) {
      if (!referencesById.has(rejected.evidenceReference.evidenceReferenceId)) referencesById.set(rejected.evidenceReference.evidenceReferenceId, rejected.evidenceReference);
    }
  }
  const references = [...referencesById.values()].sort((left, right) =>
    (left.digest ?? '') < (right.digest ?? '') ? -1 : (left.digest ?? '') > (right.digest ?? '') ? 1 : left.evidenceReferenceId < right.evidenceReferenceId ? -1 : left.evidenceReferenceId > right.evidenceReferenceId ? 1 : 0,
  );
  const requirementToControl = new Map<string, string>();
  for (const control of framework.controls) for (const requirementId of control.evidenceRequirementIds) requirementToControl.set(requirementId, control.controlId);
  const labelOf = new Map<string, string>();
  const register: CommercialEvidenceEntry[] = [];
  references.forEach((reference) => {
    const label = `E-${String(register.length + 1).padStart(2, '0')}`;
    labelOf.set(reference.evidenceReferenceId, label);
    const accepted = assessment.evidenceResolutions.filter((resolution) => resolution.acceptedEvidence.some((entry) => entry.evidenceReferenceId === reference.evidenceReferenceId));
    const rejected = assessment.evidenceResolutions.flatMap((resolution) => resolution.rejectedEvidence.filter((entry) => entry.evidenceReference.evidenceReferenceId === reference.evidenceReferenceId));
    const controls = [...new Set(accepted.map((resolution) => requirementToControl.get(resolution.requirementId)).filter((controlId): controlId is string => controlId !== undefined))].sort();
    const isAccepted = accepted.length > 0;
    // A rejected reference (possibly another organization's) is listed without its digest or date.
    const digest = isAccepted && reference.digest !== undefined && isWellFormedDigest(reference.digest) ? reference.digest : undefined;
    register.push({
      label,
      controls,
      evidenceType: reference.evidenceType,
      acceptance: isAccepted ? 'accepted' : 'rejected',
      rejectionCodes: isAccepted ? [] : [...new Set(rejected.flatMap((entry) => entry.reasonCodes))].sort(),
      verification: evidenceVerification(reference),
      relevantDate: isAccepted ? (dateOf(reference.occurredAt) ?? dateOf(reference.collectedAt) ?? NOT_SPECIFIED) : 'Withheld (rejected reference)',
      ...(digest !== undefined ? { digest } : {}),
      authenticityLimitation: !isAccepted
        ? 'Rejected: it supports no conclusion in this report.'
        : isHostVerified(reference)
        ? 'Integrity verified against the Host’s own records; truthfulness of the underlying facts is not established.'
        : 'Authenticity not established: the digest identifies the referenced bytes, not their author or their truth.',
    });
  });
  const verifiedRejected = register.some((entry) => entry.acceptance === 'rejected' && entry.verification.startsWith('Verified'));
  check('rejected_evidence_not_presented_as_verified', !verifiedRejected, verifiedRejected ? 'A rejected reference would be presented as verified.' : 'No rejected or supplier-provided reference is presented as Host-verified.');
  check('disclosure_policy', scopeComplete, scopeComplete ? 'Only allowlisted fields are disclosed; all declared text was cleared.' : 'Declared text was withheld; release requires corrected declarations.');

  // -- Controls --------------------------------------------------------------------
  const domainName = new Map(framework.domains.map((domain) => [domain.domainId, domain.name]));
  const sortedFindings = [...reportFindings].sort(
    (left, right) => (SEVERITY_RANK.get(left.severity) ?? 9) - (SEVERITY_RANK.get(right.severity) ?? 9) || (left.controlId < right.controlId ? -1 : left.controlId > right.controlId ? 1 : 0) || (left.findingId < right.findingId ? -1 : 1),
  );
  const findingLabel = new Map(sortedFindings.map((finding, index) => [finding.findingId, `F-${String(index + 1).padStart(2, '0')}`]));
  const controlDefinitions = new Map(framework.controls.map((control) => [control.controlId, control]));

  const controls: CommercialControlResult[] = RN_SV_CONTROL_IDS.map((controlId) => {
    const definition = controlDefinitions.get(controlId);
    const evaluation = evaluationsById.get(controlId);
    const profile = controlProfile(framework, controlId);
    const status: AssuranceControlStatus = evaluation?.status ?? 'manual_review_required';
    const reviews = authenticatedReviews.filter((review) => review.controlId === controlId);
    const reviewedOn = reviews.map((review) => dateOf(review.reviewedAt)).filter((date): date is string => date !== undefined).sort().at(-1);
    return {
      controlId,
      title: definition?.title ?? controlId,
      domain: domainName.get(definition?.domainId ?? '') ?? NOT_SPECIFIED,
      objective: definition?.objective ?? NOT_SPECIFIED,
      status,
      statusLabel: STATUS_LABEL[status],
      conclusion: conclusionFor(status, profile),
      evidence: (evaluation?.evidenceReferenceIds ?? []).map((id) => labelOf.get(id)).filter((label): label is string => label !== undefined).sort(),
      findings: sortedFindings.filter((finding) => finding.controlId === controlId).map((finding) => findingLabel.get(finding.findingId) ?? ''),
      limitations: profile?.limitations ?? [],
      ...(status !== 'pass' && status !== 'not_applicable' && profile !== undefined ? { revalidation: profile.revalidation } : {}),
      review: { authenticated: reviews.length > 0, reviewers: [...new Set(reviews.map((review) => review.reviewerId))].sort(), ...(reviewedOn !== undefined ? { reviewedOn } : {}) },
    };
  });

  // -- Findings and roadmap ------------------------------------------------------------
  const findings: CommercialFinding[] = sortedFindings.map((finding) => {
    const definition = controlDefinitions.get(finding.controlId);
    const profile = controlProfile(framework, finding.controlId);
    const status = evaluationsById.get(finding.controlId)?.status;
    const sustainedRisk = status === 'fail' || status === 'partial';
    return {
      label: findingLabel.get(finding.findingId) ?? '',
      findingId: finding.findingId,
      controlId: finding.controlId,
      controlTitle: definition?.title ?? finding.controlId,
      severity: finding.severity,
      findingType: finding.findingType,
      status: finding.status,
      description: status !== undefined ? conclusionFor(status, profile) : NOT_SPECIFIED,
      evidence: finding.evidenceReferenceIds.map((id) => labelOf.get(id)).filter((label): label is string => label !== undefined).sort(),
      ...(sustainedRisk && profile !== undefined ? { risk: profile.risk } : {}),
      remediationType: remediationTypeFor(status, finding.findingType),
      recommendation:
        status === 'unknown'
          ? `Provide the evidence the control requires so it can be concluded.${definition?.remediationGuidance !== undefined ? ` If a gap is then confirmed: ${definition.remediationGuidance}` : ''}`
          : (definition?.remediationGuidance ?? NOT_SPECIFIED),
      closureCriterion: profile?.revalidation ?? NOT_SPECIFIED,
      priority: PRIORITY_LABEL[finding.remediation.priority] ?? finding.remediation.priority,
    };
  });
  const roadmap: CommercialRoadmapItem[] = findings
    .filter((finding) => finding.status !== 'closed' && finding.status !== 'superseded')
    .map((finding, index) => ({
      order: index + 1,
      finding: finding.label,
      controlId: finding.controlId,
      severity: finding.severity,
      remediationType: finding.remediationType,
      priority: finding.priority,
      dependencies: 'None identified by the assessment',
      revalidation: finding.closureCriterion,
      owner: TO_BE_AGREED,
      targetDate: TO_BE_AGREED,
      source: 'engine-generated',
    }));

  // -- Results ----------------------------------------------------------------------------
  const countOf = (status: AssuranceControlStatus): number => controls.filter((control) => control.status === status).length;
  const blockingRisks = framework.domains.flatMap((domain) =>
    (domain.blockingControlIds ?? []).filter((controlId) => evaluationsById.get(controlId)?.status === 'fail').map((controlId) => `${controlId} failed: the ${domain.name} domain is marked unhealthy regardless of its numeric score.`),
  );
  const titled = (status: AssuranceControlStatus): readonly string[] => controls.filter((control) => control.status === status).map((control) => `${control.controlId} ${control.title}`);
  const openFindings = findings.filter((finding) => finding.status === 'open');

  const readinessStatus: CommercialReportReadiness = checks.every((entry) => entry.passed) ? 'READY_FOR_RELEASE' : 'DRAFT';
  const reviewers = [...new Set(authenticatedReviews.map((review) => review.reviewerId))].sort();
  const commercialUse = (framework.metadata?.['commercialUse'] ?? {}) as { readonly status?: unknown; readonly statement?: unknown };

  const content: CommercialReportContent = {
    schemaVersion: COMMERCIAL_REPORT_SCHEMA_VERSION,
    reportId: `rn-sv-report:${assessment.assessmentId}:v${reportVersion}`,
    cover: {
      title: COMMERCIAL_REPORT_TITLE,
      service: 'Republika Sovereignty Assessment',
      assessmentId: assessment.assessmentId,
      organization: organization.value,
      system: system.value,
      framework: { id: framework.frameworkId, version: framework.frameworkVersion, name: framework.name },
      evidenceCutoffAt: assessment.scope.evidenceCutoffAt,
      issuedOn,
      confidentiality,
      reportVersion,
    },
    readiness: { status: readinessStatus, checks },
    executiveSummary: {
      assessed: `${system.value}, operated by ${organization.value}, assessed against the ten controls of ${framework.name} (${framework.frameworkId}@${framework.frameworkVersion}) with evidence up to ${assessment.scope.evidenceCutoffAt}.`,
      purpose: purpose.value,
      demonstrated: titled('pass'),
      partiallyDemonstrated: titled('partial'),
      observedFailures: titled('fail'),
      insufficientEvidence: titled('unknown'),
      pendingReview: titled('manual_review_required'),
      principalRisks: controls.filter((control) => control.status === 'fail' || control.status === 'partial').map((control) => `${control.controlId}: ${controlProfile(framework, control.controlId)?.risk ?? NOT_SPECIFIED}`),
      priorityFindings: findings.filter((finding) => finding.severity === 'critical' || finding.severity === 'high').map((finding) => `${finding.label} (${finding.severity}) — ${finding.controlId} ${finding.controlTitle}`),
      nextActions: roadmap.slice(0, 5).map((item) => `${item.finding}: ${item.remediationType.toLowerCase()} for ${item.controlId} (${item.priority} priority).`),
    },
    scope: {
      organization: organization.value,
      system: system.value,
      systemDescription: systemDescription.value,
      subjectType: assessment.subject.subjectType,
      inScope: inScope.values,
      exclusions: exclusions.values,
      dependencies: dependencies.values,
      accessLimitations: accessLimitations.values,
      periodFrom: isoInstant(assessment.scope.from) ?? 'Not specified (evidence up to the cutoff was considered)',
      periodTo: isoInstant(assessment.scope.to) ?? assessment.scope.evidenceCutoffAt,
      evidenceCutoffAt: assessment.scope.evidenceCutoffAt,
      evidenceSources: [...new Set(register.map((entry) => entry.evidenceType))].sort().map((type) => `${type} (${register.filter((entry) => entry.evidenceType === type).length} reference(s))`),
      activitiesNotPerformed: ACTIVITIES_NOT_PERFORMED,
    },
    methodology: {
      steps: METHODOLOGY_STEPS,
      reviewerRole: String(framework.metadata?.['reviewerRole'] ?? NOT_SPECIFIED),
      scoring: `${assessment.score.methodologyId}@${assessment.score.methodologyVersion}: pass = 1, partial = 0.5, fail = 0; unknown and pending reviews score 0 and stay in the denominator; domain-weighted; a failed SV-06 or SV-08 marks its domain unhealthy.`,
    },
    controls,
    results: {
      normalizedScore: assessment.score.normalizedScore,
      methodology: `${assessment.score.methodologyId}@${assessment.score.methodologyVersion}`,
      interpretation:
        'The score summarizes this framework’s methodology over the declared scope. A high score is not demonstrated sovereignty, and an UNKNOWN control lowers the score without being a failure. Read every control result and its limitations.',
      domains: assessment.domainAssessments
        .map((domain) => ({ domain: domainName.get(domain.domainId) ?? domain.domainId, status: domain.status, normalizedScore: domain.normalizedScore }))
        .sort((left, right) => (left.domain < right.domain ? -1 : left.domain > right.domain ? 1 : 0)),
      controlsEvaluated: assessment.controlEvaluations.length,
      counts: {
        pass: countOf('pass'),
        partial: countOf('partial'),
        fail: countOf('fail'),
        unknown: countOf('unknown'),
        manual_review_required: countOf('manual_review_required'),
        not_applicable: countOf('not_applicable'),
      },
      blockingRisks,
      openFindings: openFindings.length,
      findingsRecordedAfterCompletion,
    },
    findings,
    remediationRoadmap: {
      items: roadmap,
      humanProposals: 'Human-proposed actions: none. Every item above is derived by the engine from a finding; any proposal beyond them requires separate human approval and is not part of this report.',
    },
    evidenceRegister: register,
    limitations: LIMITATIONS,
    revalidation: {
      findingsToRevalidate: roadmap.map((item) => item.finding),
      controlsToReevaluate: [...new Set(roadmap.map((item) => item.controlId))].sort(),
      evidenceRequired: [...new Set(roadmap.map((item) => item.controlId))]
        .sort()
        .map((controlId) => {
          const requirementId = controlDefinitions.get(controlId)?.evidenceRequirementIds[0];
          return `${controlId}: ${framework.evidenceRequirements.find((requirement) => requirement.requirementId === requirementId)?.description ?? NOT_SPECIFIED}`;
        }),
      invalidatingChanges: INVALIDATING_CHANGES,
      linkage: `A revalidation is a new assessment that references ${assessment.assessmentId}; this assessment and this report are never modified.`,
      monitoring: 'Not included. This report describes one point-in-time assessment; continuous monitoring is a separate service.',
    },
    integrity: {
      assessmentId: assessment.assessmentId,
      assessmentDigest: assessment.integrity.assessmentDigest,
      frameworkId: framework.frameworkId,
      frameworkVersion: framework.frameworkVersion,
      frameworkDigest: computeDigest(framework),
      generatorVersion: COMMERCIAL_REPORT_GENERATOR_VERSION,
      issuedOn,
      evidenceCutoffAt: assessment.scope.evidenceCutoffAt,
      reviewers,
      commercialUse: {
        frameworkStatus: typeof commercialUse.status === 'string' ? commercialUse.status : NOT_SPECIFIED,
        statement:
          'The framework definition records commercial use as restricted pending controlled review. Release of this report requires an authenticated human approver to acknowledge that restriction and act as that review; the release record states whether this happened.',
      },
      release: 'Not released by this document. Release is a separate record that binds an authenticated human approval to this report’s digests.',
      limitation: 'The digests in the manifest show integrity only. They are not a digital signature, do not provide non-repudiation, and do not authenticate the evidence.',
    },
  };

  const markdown = renderCommercialReportMarkdown(content);
  return { content, markdown, manifest: manifestFor(content, markdown) };
}

function manifestFor(content: CommercialReportContent, markdown: string): CommercialReportManifest {
  const body = {
    manifestVersion: 'rn.sv.commercial-report-manifest.v1',
    reportId: content.reportId,
    assessmentId: content.integrity.assessmentId,
    assessmentDigest: content.integrity.assessmentDigest,
    frameworkId: content.integrity.frameworkId,
    frameworkVersion: content.integrity.frameworkVersion,
    frameworkDigest: content.integrity.frameworkDigest,
    generatorVersion: content.integrity.generatorVersion,
    readiness: content.readiness.status,
    canonicalizationVersion: AOC_CANONICALIZATION_VERSION,
    contentDigest: computeDigest(content),
    markdownDigest: sha256Text(markdown),
  };
  return { ...body, manifestDigest: computeDigest(body) };
}

export interface CommercialReportVerification {
  readonly valid: boolean;
  readonly checks: { readonly content: boolean; readonly markdown: boolean; readonly manifest: boolean; readonly release?: boolean };
}

/** Recomputes every digest of a delivered report (and its release record, when given) and says which part, if any, changed. */
export function verifyCommercialReport(input: { readonly content: unknown; readonly markdown: string; readonly manifest: CommercialReportManifest; readonly release?: CommercialReportRelease }): CommercialReportVerification {
  const { manifestDigest, ...manifestBody } = input.manifest;
  const content = computeDigest(input.content) === input.manifest.contentDigest;
  const markdown = sha256Text(input.markdown) === input.manifest.markdownDigest;
  const manifest = computeDigest(manifestBody) === manifestDigest;
  let release: boolean | undefined;
  if (input.release !== undefined) {
    const { releaseDigest, ...releaseBody } = input.release;
    release =
      computeDigest(releaseBody) === releaseDigest &&
      input.release.contentDigest === input.manifest.contentDigest &&
      input.release.markdownDigest === input.manifest.markdownDigest &&
      input.release.manifestDigest === manifestDigest;
  }
  return { valid: content && markdown && manifest && release !== false, checks: { content, markdown, manifest, ...(release !== undefined ? { release } : {}) } };
}

/** The release record for an approved draft. The caller has already authenticated the approver and confirmed the draft is releasable. */
export function buildCommercialReportRelease(draft: CommercialReportDraft, approval: { readonly approvedBy: string; readonly approverRole: string; readonly approvedAt: string; readonly acknowledgements: CommercialReleaseAcknowledgements }): CommercialReportRelease {
  const body = {
    releaseVersion: 'rn.sv.commercial-release.v1',
    reportId: draft.content.reportId,
    assessmentId: draft.content.integrity.assessmentId,
    contentDigest: draft.manifest.contentDigest,
    markdownDigest: draft.manifest.markdownDigest,
    manifestDigest: draft.manifest.manifestDigest,
    approvedBy: approval.approvedBy,
    approverRole: approval.approverRole,
    approvalAuthentication: 'assurance_reviewer_credential' as const,
    approvedAt: approval.approvedAt,
    acknowledgements: approval.acknowledgements,
    statement:
      'An authenticated human approver released the report identified by the digests above, having reviewed its scope, limitations and the framework’s commercial-use restriction. This is a hash-bound approval record, not a digital signature.',
  };
  return { ...body, releaseDigest: computeDigest(body) };
}
