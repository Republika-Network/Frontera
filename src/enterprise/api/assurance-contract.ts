import { EnterpriseHttpErrors } from './enterprise-http-errors.js';
import type { AssuranceManualReviewOutcome, AssuranceFindingEventType, AssuranceSubjectType, AssuranceEvidenceType } from '../assurance/contracts.js';
import { ASSURANCE_SUBJECT_TYPES, ASSURANCE_EVIDENCE_TYPES } from '../assurance/contracts.js';
import { isAssuranceSignalType, type BuildAssuranceSignalInput } from '../assurance/signals.js';
import type {
  AppendFindingEventInput,
  CommercialReportReleaseRequest,
  CommercialReportRequest,
  CreateAssuranceAssessmentInput,
  RecordManualReviewInput,
  RequestReassessmentInput,
  TerminateAssessmentInput,
} from '../assurance/service.js';
import type { AssuranceEvidenceReference, AssuranceReviewerPrincipal } from '../assurance/contracts.js';
import type { CommercialReleasePackage } from '../assurance/commercial-release-custody.js';
import { ASSURANCE_OPERATOR_RELEASE_ROLE, bindDeclaredActor } from './assurance-operator-access.js';

/** HTTP/JSON shape validation only (mirrors `passport-contract.ts`) -- `AssuranceService` still validates the resolved input itself. No control logic, evidence selection, scoring, or eligibility logic lives here (mission section 54). */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isSubjectType(value: unknown): value is AssuranceSubjectType {
  return typeof value === 'string' && (ASSURANCE_SUBJECT_TYPES as readonly string[]).includes(value);
}

/**
 * ASSURE-REL-01D: with an authenticated `reviewer`, `requestedBy` is optional and,
 * when present, must name that reviewer; the recorded requester is the reviewer.
 * Without one (the v1 organization-key path) it is required, as before.
 */
export function validateCreateAssessmentRequestBody(body: unknown, reviewer?: AssuranceReviewerPrincipal): CreateAssuranceAssessmentInput {
  if (!isPlainObject(body)) throw EnterpriseHttpErrors.invalidRequest('Request body must be a JSON object.');
  const violations: string[] = [];

  const subjectRaw = body.subject;
  if (!isPlainObject(subjectRaw)) violations.push('subject is a required object.');
  const subject = isPlainObject(subjectRaw) ? subjectRaw : {};
  if (!isNonEmptyString(subject.subjectId)) violations.push('subject.subjectId is a required non-empty string.');
  if (!isSubjectType(subject.subjectType)) violations.push(`subject.subjectType must be one of: ${ASSURANCE_SUBJECT_TYPES.join(', ')}.`);
  if (!isNonEmptyString(subject.organizationId)) violations.push('subject.organizationId is a required non-empty string.');

  if (!isNonEmptyString(body.frameworkId)) violations.push('frameworkId is a required non-empty string.');
  if (!isNonEmptyString(body.frameworkVersion)) violations.push('frameworkVersion is a required non-empty string.');
  if (reviewer === undefined ? !isNonEmptyString(body.requestedBy) : body.requestedBy !== undefined && !isNonEmptyString(body.requestedBy)) {
    violations.push(reviewer === undefined ? 'requestedBy is a required non-empty string.' : 'requestedBy, when present, must be a non-empty string.');
  }

  if (violations.length > 0) throw EnterpriseHttpErrors.invalidRequest('The Assurance assessment request failed validation.', violations);

  return {
    subject: subject as unknown as CreateAssuranceAssessmentInput['subject'],
    frameworkId: body.frameworkId as string,
    frameworkVersion: body.frameworkVersion as string,
    requestedBy: reviewer === undefined ? (body.requestedBy as string) : bindDeclaredActor(body.requestedBy, reviewer, 'requestedBy'),
    ...(isStringArray(body.domainIds) ? { domainIds: body.domainIds } : {}),
    ...(isStringArray(body.controlIds) ? { controlIds: body.controlIds } : {}),
    ...(typeof body.from === 'string' ? { from: body.from } : {}),
    ...(typeof body.to === 'string' ? { to: body.to } : {}),
    ...(typeof body.evidenceCutoffAt === 'string' ? { evidenceCutoffAt: body.evidenceCutoffAt } : {}),
    ...(typeof body.includeHistoricalEvidence === 'boolean' ? { includeHistoricalEvidence: body.includeHistoricalEvidence } : {}),
    ...(typeof body.purpose === 'string' ? { purpose: body.purpose } : {}),
  };
}

export interface EvaluateAssessmentRequestBody {
  /** When `true` (default), completion is attempted after evaluation; pending manual reviews leave the assessment in `manual_review` instead. */
  readonly complete?: boolean;
}

export function validateEvaluateAssessmentRequestBody(body: unknown): EvaluateAssessmentRequestBody {
  if (body === undefined || body === null) return {};
  if (!isPlainObject(body)) throw EnterpriseHttpErrors.invalidRequest('Request body, when present, must be a JSON object.');
  if (body.complete !== undefined && typeof body.complete !== 'boolean') {
    throw EnterpriseHttpErrors.invalidRequest('complete, when present, must be a boolean.');
  }
  return typeof body.complete === 'boolean' ? { complete: body.complete } : {};
}

const FINDING_EVENT_TYPES: readonly AssuranceFindingEventType[] = [
  'AssuranceFindingCreated',
  'AssuranceFindingAccepted',
  'AssuranceRemediationPlanned',
  'AssuranceFindingRemediated',
  'AssuranceFindingClosed',
  'AssuranceFindingSuperseded',
  'AssuranceFindingReopened',
];

/** ASSURE-REL-01D: with an authenticated `reviewer`, `actorId` is optional and must name that reviewer. */
export function validateFindingEventRequestBody(body: unknown, findingId: string, reviewer?: AssuranceReviewerPrincipal): AppendFindingEventInput {
  if (!isPlainObject(body)) throw EnterpriseHttpErrors.invalidRequest('Request body must be a JSON object.');
  const violations: string[] = [];
  if (typeof body.eventType !== 'string' || !(FINDING_EVENT_TYPES as readonly string[]).includes(body.eventType)) {
    violations.push(`eventType must be one of: ${FINDING_EVENT_TYPES.join(', ')}.`);
  }
  if (reviewer === undefined ? !isNonEmptyString(body.actorId) : body.actorId !== undefined && !isNonEmptyString(body.actorId)) {
    violations.push(reviewer === undefined ? 'actorId is a required non-empty string.' : 'actorId, when present, must be a non-empty string.');
  }
  if (violations.length > 0) throw EnterpriseHttpErrors.invalidRequest('The finding event request failed validation.', violations);
  return {
    findingId,
    eventType: body.eventType as AssuranceFindingEventType,
    actorId: reviewer === undefined ? (body.actorId as string) : bindDeclaredActor(body.actorId, reviewer, 'actorId'),
    ...(typeof body.rationale === 'string' ? { rationale: body.rationale } : {}),
    ...(isPlainObject(body.payload) ? { payload: body.payload } : {}),
  };
}

const MANUAL_REVIEW_OUTCOMES: readonly AssuranceManualReviewOutcome[] = ['pass', 'partial', 'fail', 'insufficient_evidence'];

/**
 * ASSURE-SEC-01B: `reviewerId` and `reviewerRole` are optional and carry no
 * authority. The reviewer is the authenticated Assurance reviewer credential;
 * when either field is present the service refuses a value that does not match
 * that credential instead of replacing it.
 */
export function validateManualReviewRequestBody(body: unknown): RecordManualReviewInput {
  if (!isPlainObject(body)) throw EnterpriseHttpErrors.invalidRequest('Request body must be a JSON object.');
  const violations: string[] = [];
  if (!isNonEmptyString(body.assessmentId)) violations.push('assessmentId is a required non-empty string.');
  if (!isNonEmptyString(body.controlId)) violations.push('controlId is a required non-empty string.');
  if (body.reviewerId !== undefined && !isNonEmptyString(body.reviewerId)) violations.push('reviewerId, when present, must be a non-empty string.');
  if (body.reviewerRole !== undefined && !isNonEmptyString(body.reviewerRole)) violations.push('reviewerRole, when present, must be a non-empty string.');
  if (!isNonEmptyString(body.rationale)) violations.push('rationale is a required non-empty string.');
  if (typeof body.outcome !== 'string' || !(MANUAL_REVIEW_OUTCOMES as readonly string[]).includes(body.outcome)) {
    violations.push(`outcome must be one of: ${MANUAL_REVIEW_OUTCOMES.join(', ')}.`);
  }
  if (violations.length > 0) throw EnterpriseHttpErrors.invalidRequest('The manual review request failed validation.', violations);
  return {
    assessmentId: body.assessmentId as string,
    controlId: body.controlId as string,
    outcome: body.outcome as AssuranceManualReviewOutcome,
    rationale: body.rationale as string,
    ...(typeof body.reviewerId === 'string' ? { reviewerId: body.reviewerId } : {}),
    ...(typeof body.reviewerRole === 'string' ? { reviewerRole: body.reviewerRole } : {}),
    ...(isStringArray(body.evidenceReferenceIds) ? { evidenceReferenceIds: body.evidenceReferenceIds } : {}),
  };
}

export function validateSignalRequestBody(body: unknown): Omit<BuildAssuranceSignalInput, 'signalId'> {
  if (!isPlainObject(body)) throw EnterpriseHttpErrors.invalidRequest('Request body must be a JSON object.');
  const violations: string[] = [];
  if (!isNonEmptyString(body.organizationId)) violations.push('organizationId is a required non-empty string.');
  if (!isNonEmptyString(body.subjectId)) violations.push('subjectId is a required non-empty string.');
  if (!isNonEmptyString(body.subjectType)) violations.push('subjectType is a required non-empty string.');
  if (typeof body.signalType !== 'string' || !isAssuranceSignalType(body.signalType)) violations.push('signalType is not a supported Assurance signal type.');
  if (typeof body.sourceType !== 'string' || !(ASSURANCE_EVIDENCE_TYPES as readonly string[]).includes(body.sourceType)) {
    violations.push(`sourceType must be one of: ${ASSURANCE_EVIDENCE_TYPES.join(', ')}.`);
  }
  if (!isNonEmptyString(body.sourceId)) violations.push('sourceId is a required non-empty string.');
  if (!isNonEmptyString(body.occurredAt)) violations.push('occurredAt is a required ISO-8601 string.');
  if (violations.length > 0) throw EnterpriseHttpErrors.invalidRequest('The Assurance signal request failed validation.', violations);
  return {
    organizationId: body.organizationId as string,
    subjectId: body.subjectId as string,
    subjectType: body.subjectType as string,
    signalType: body.signalType as BuildAssuranceSignalInput['signalType'],
    sourceType: body.sourceType as AssuranceEvidenceType,
    sourceId: body.sourceId as string,
    occurredAt: body.occurredAt as string,
    observedAt: typeof body.observedAt === 'string' ? body.observedAt : (body.occurredAt as string),
    ...(typeof body.sourceDigest === 'string' ? { sourceDigest: body.sourceDigest } : {}),
    ...(isStringArray(body.affectedControlIds) ? { affectedControlIds: body.affectedControlIds } : {}),
    ...(isStringArray(body.affectedDomainIds) ? { affectedDomainIds: body.affectedDomainIds } : {}),
    ...(isPlainObject(body.payload) ? { payload: body.payload } : {}),
  };
}

/** ASSURE-REL-01D: with an authenticated `reviewer`, `requestedBy` is optional and must name that reviewer. */
export function validateReassessRequestBody(body: unknown, subjectId: string, reviewer?: AssuranceReviewerPrincipal): RequestReassessmentInput {
  if (!isPlainObject(body)) throw EnterpriseHttpErrors.invalidRequest('Request body must be a JSON object.');
  const violations: string[] = [];
  if (!isNonEmptyString(body.reason)) violations.push('reason is a required non-empty string.');
  if (reviewer === undefined ? !isNonEmptyString(body.requestedBy) : body.requestedBy !== undefined && !isNonEmptyString(body.requestedBy)) {
    violations.push(reviewer === undefined ? 'requestedBy is a required non-empty string.' : 'requestedBy, when present, must be a non-empty string.');
  }
  if (violations.length > 0) throw EnterpriseHttpErrors.invalidRequest('The reassessment request failed validation.', violations);
  return {
    subjectId,
    reason: body.reason as string,
    requestedBy: reviewer === undefined ? (body.requestedBy as string) : bindDeclaredActor(body.requestedBy, reviewer, 'requestedBy'),
    ...(typeof body.assessmentId === 'string' ? { assessmentId: body.assessmentId } : {}),
    ...(typeof body.evidenceCutoffAt === 'string' ? { evidenceCutoffAt: body.evidenceCutoffAt } : {}),
  };
}

// ---------------------------------------------------------------------------
// ASSURE-REL-01D operator routes. Shape validation only; the service validates
// meaning (bindings, tenant, lifecycle, readiness, digests) itself.
// ---------------------------------------------------------------------------

/** At most this many references in one evidence submission. */
export const ASSURANCE_EVIDENCE_SUBMISSION_MAX_REFERENCES = 500;

const EVIDENCE_REFERENCE_FIELDS = new Set([
  'evidenceReferenceId', 'evidenceType', 'externalId', 'organizationId', 'subjectId', 'digest', 'version', 'occurredAt', 'collectedAt',
  'verified', 'verificationReference', 'provenance', 'metadata', 'requirementIds',
]);
const PROVENANCE_FIELDS = new Set(['sourceSystem', 'sourceType', 'sourceVersion', 'collectedBy', 'collectedAt', 'originalDigest', 'disclosurePolicy', 'chainOfCustodyReference']);

function referenceViolations(value: unknown, where: string): string[] {
  if (!isPlainObject(value)) return [`${where} must be a JSON object.`];
  const violations: string[] = [];
  for (const key of Object.keys(value)) if (!EVIDENCE_REFERENCE_FIELDS.has(key)) violations.push(`${where}.${key.slice(0, 64)} is not an evidence reference field.`);
  for (const key of ['evidenceReferenceId', 'externalId', 'organizationId', 'collectedAt'] as const) {
    if (!isNonEmptyString(value[key])) violations.push(`${where}.${key} is a required non-empty string.`);
  }
  if (typeof value.evidenceType !== 'string' || !(ASSURANCE_EVIDENCE_TYPES as readonly string[]).includes(value.evidenceType)) {
    violations.push(`${where}.evidenceType must be one of: ${ASSURANCE_EVIDENCE_TYPES.join(', ')}.`);
  }
  if (typeof value.verified !== 'boolean') violations.push(`${where}.verified is a required boolean (a supplied value is kept as a claim, never as verification).`);
  for (const key of ['subjectId', 'digest', 'version', 'occurredAt', 'verificationReference'] as const) {
    if (value[key] !== undefined && typeof value[key] !== 'string') violations.push(`${where}.${key}, when present, must be a string.`);
  }
  if (value.metadata !== undefined && !isPlainObject(value.metadata)) violations.push(`${where}.metadata, when present, must be a JSON object.`);
  if (value.requirementIds !== undefined && !isStringArray(value.requirementIds)) violations.push(`${where}.requirementIds, when present, must be an array of strings.`);
  const provenance = value.provenance;
  if (!isPlainObject(provenance)) {
    violations.push(`${where}.provenance is a required object.`);
  } else {
    for (const key of Object.keys(provenance)) if (!PROVENANCE_FIELDS.has(key)) violations.push(`${where}.provenance.${key.slice(0, 64)} is not a provenance field.`);
    for (const key of ['sourceSystem', 'sourceType', 'collectedBy', 'collectedAt'] as const) {
      if (!isNonEmptyString(provenance[key])) violations.push(`${where}.provenance.${key} is a required non-empty string.`);
    }
    for (const key of ['sourceVersion', 'originalDigest', 'disclosurePolicy', 'chainOfCustodyReference'] as const) {
      if (provenance[key] !== undefined && typeof provenance[key] !== 'string') violations.push(`${where}.provenance.${key}, when present, must be a string.`);
    }
  }
  return violations;
}

/**
 * `POST /api/assurance/assessments/{id}/evidence`: `{ manualEvidence: [...] }`.
 * Manually supplied evidence enters under the SEC-01C trust model -- recorded
 * `verified: false` with the supplier's claims kept as claims, offered only to
 * the requirements it names, foreign-tenant references rejected by the resolver.
 */
export function validateEvidenceSubmissionRequestBody(body: unknown): { readonly manualEvidence: readonly AssuranceEvidenceReference[] } {
  if (!isPlainObject(body)) throw EnterpriseHttpErrors.invalidRequest('Request body must be a JSON object.');
  const manualEvidence = body.manualEvidence;
  if (!Array.isArray(manualEvidence) || manualEvidence.length === 0) throw EnterpriseHttpErrors.invalidRequest('manualEvidence is a required, non-empty array.');
  if (manualEvidence.length > ASSURANCE_EVIDENCE_SUBMISSION_MAX_REFERENCES) {
    throw EnterpriseHttpErrors.invalidRequest(`manualEvidence holds at most ${ASSURANCE_EVIDENCE_SUBMISSION_MAX_REFERENCES} references.`);
  }
  const violations = manualEvidence.flatMap((reference, index) => referenceViolations(reference, `manualEvidence[${index}]`));
  if (violations.length > 0) throw EnterpriseHttpErrors.invalidRequest('The evidence submission failed validation.', violations.slice(0, 50));
  return { manualEvidence: manualEvidence as AssuranceEvidenceReference[] };
}

/** `POST /api/assurance/assessments/{id}/terminate`: `{ reasonCode, rationale }`. The terminating reviewer is the credential, never a field. */
export function validateTerminationRequestBody(body: unknown): TerminateAssessmentInput {
  if (!isPlainObject(body)) throw EnterpriseHttpErrors.invalidRequest('Request body must be a JSON object.');
  const violations: string[] = [];
  if (!isNonEmptyString(body.reasonCode)) violations.push('reasonCode is a required non-empty string.');
  if (!isNonEmptyString(body.rationale)) violations.push('rationale is a required non-empty string.');
  if (body.terminatedBy !== undefined) violations.push('terminatedBy is not accepted; the terminating reviewer is the authenticated credential.');
  if (violations.length > 0) throw EnterpriseHttpErrors.invalidRequest('The termination request failed validation.', violations);
  return { reasonCode: body.reasonCode as TerminateAssessmentInput['reasonCode'], rationale: body.rationale as string };
}

/** `POST /api/assurance/assessments/{id}/commercial-report/draft`: `{ engagement, issue }`, validated in full by the report builder. */
export function validateCommercialReportRequestBody(body: unknown): CommercialReportRequest {
  if (!isPlainObject(body)) throw EnterpriseHttpErrors.invalidRequest('Request body must be a JSON object.');
  const violations: string[] = [];
  if (!isPlainObject(body.engagement)) violations.push('engagement is a required object.');
  if (!isPlainObject(body.issue)) violations.push('issue is a required object.');
  if (violations.length > 0) throw EnterpriseHttpErrors.invalidRequest('The commercial report request failed validation.', violations);
  return { engagement: body.engagement, issue: body.issue };
}

/**
 * `POST /api/assurance/assessments/{id}/commercial-report/release`:
 * `{ engagement, issue, approvedContentDigest, acknowledgements }`. The approver
 * is the authenticated credential. `approvedBy` / `approverRole`, when sent, may
 * only restate it; any other value is refused, never used.
 */
export function validateCommercialReleaseRequestBody(body: unknown, approver: AssuranceReviewerPrincipal): CommercialReportReleaseRequest {
  const base = validateCommercialReportRequestBody(body);
  const raw = body as Record<string, unknown>;
  const violations: string[] = [];
  if (!isNonEmptyString(raw.approvedContentDigest)) violations.push('approvedContentDigest is a required non-empty string.');
  const acknowledgements = raw.acknowledgements;
  if (!isPlainObject(acknowledgements) || typeof acknowledgements.limitationsReviewed !== 'boolean' || typeof acknowledgements.commercialUseRestrictionAcknowledged !== 'boolean') {
    violations.push('acknowledgements must be an object with boolean limitationsReviewed and commercialUseRestrictionAcknowledged.');
  }
  if (raw.approverRole !== undefined && raw.approverRole !== ASSURANCE_OPERATOR_RELEASE_ROLE) violations.push(`approverRole, when present, must be '${ASSURANCE_OPERATOR_RELEASE_ROLE}'.`);
  if (violations.length > 0) throw EnterpriseHttpErrors.invalidRequest('The commercial release request failed validation.', violations);
  bindDeclaredActor(raw.approvedBy, approver, 'approvedBy');
  return { ...base, approvedContentDigest: raw.approvedContentDigest as string, acknowledgements: acknowledgements as unknown as CommercialReportReleaseRequest['acknowledgements'] };
}

/**
 * `POST /api/assurance/commercial-releases/verify`: a delivered package
 * `{ content, markdown, manifest, release? }` -- the files `report.json`,
 * `report.md`, `integrity-manifest.json`, `release-record.json`. All of it is
 * untrusted: the verdict comes from this Host's custody, never the package.
 */
export function validateCommercialReleasePackageBody(body: unknown): CommercialReleasePackage {
  if (!isPlainObject(body)) throw EnterpriseHttpErrors.invalidRequest('Request body must be a JSON object.');
  const violations: string[] = [];
  if (!('content' in body)) violations.push('content (report.json) is required.');
  if (typeof body.markdown !== 'string') violations.push('markdown (report.md) is a required string.');
  if (!isPlainObject(body.manifest)) violations.push('manifest (integrity-manifest.json) is a required object.');
  if (body.release !== undefined && !isPlainObject(body.release)) violations.push('release (release-record.json), when present, must be an object.');
  if (violations.length > 0) throw EnterpriseHttpErrors.invalidRequest('The delivered package failed validation.', violations);
  return body as unknown as CommercialReleasePackage;
}
