import { EnterpriseHttpErrors } from './enterprise-http-errors.js';
import type { AssuranceManualReviewOutcome, AssuranceFindingEventType, AssuranceSubjectType, AssuranceEvidenceType } from '../assurance/contracts.js';
import { ASSURANCE_SUBJECT_TYPES, ASSURANCE_EVIDENCE_TYPES } from '../assurance/contracts.js';
import { isAssuranceSignalType, type BuildAssuranceSignalInput } from '../assurance/signals.js';
import type { AppendFindingEventInput, CreateAssuranceAssessmentInput, RecordManualReviewInput, RequestReassessmentInput } from '../assurance/service.js';

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

export function validateCreateAssessmentRequestBody(body: unknown): CreateAssuranceAssessmentInput {
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
  if (!isNonEmptyString(body.requestedBy)) violations.push('requestedBy is a required non-empty string.');

  if (violations.length > 0) throw EnterpriseHttpErrors.invalidRequest('The Assurance assessment request failed validation.', violations);

  return {
    subject: subject as unknown as CreateAssuranceAssessmentInput['subject'],
    frameworkId: body.frameworkId as string,
    frameworkVersion: body.frameworkVersion as string,
    requestedBy: body.requestedBy as string,
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

export function validateFindingEventRequestBody(body: unknown, findingId: string): AppendFindingEventInput {
  if (!isPlainObject(body)) throw EnterpriseHttpErrors.invalidRequest('Request body must be a JSON object.');
  const violations: string[] = [];
  if (typeof body.eventType !== 'string' || !(FINDING_EVENT_TYPES as readonly string[]).includes(body.eventType)) {
    violations.push(`eventType must be one of: ${FINDING_EVENT_TYPES.join(', ')}.`);
  }
  if (!isNonEmptyString(body.actorId)) violations.push('actorId is a required non-empty string.');
  if (violations.length > 0) throw EnterpriseHttpErrors.invalidRequest('The finding event request failed validation.', violations);
  return {
    findingId,
    eventType: body.eventType as AssuranceFindingEventType,
    actorId: body.actorId as string,
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

export function validateReassessRequestBody(body: unknown, subjectId: string): RequestReassessmentInput {
  if (!isPlainObject(body)) throw EnterpriseHttpErrors.invalidRequest('Request body must be a JSON object.');
  const violations: string[] = [];
  if (!isNonEmptyString(body.reason)) violations.push('reason is a required non-empty string.');
  if (!isNonEmptyString(body.requestedBy)) violations.push('requestedBy is a required non-empty string.');
  if (violations.length > 0) throw EnterpriseHttpErrors.invalidRequest('The reassessment request failed validation.', violations);
  return {
    subjectId,
    reason: body.reason as string,
    requestedBy: body.requestedBy as string,
    ...(typeof body.assessmentId === 'string' ? { assessmentId: body.assessmentId } : {}),
    ...(typeof body.evidenceCutoffAt === 'string' ? { evidenceCutoffAt: body.evidenceCutoffAt } : {}),
  };
}
