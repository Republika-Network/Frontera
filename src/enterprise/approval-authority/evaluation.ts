import { createHash } from 'node:crypto';

import type { ApprovalDecision } from '../../features/approval-runtime/domain/approval-decision.js';
import type { ApprovalEvidenceArtifact, ApprovalEvidenceType } from '../../features/approval-runtime/domain/approval-evidence.js';
import type { ApprovalApproverRecognitionResult, ApprovalAuthorityCheckResult, ApprovalPolicyContext } from '../../features/approval-runtime/domain/approval-policy.js';
import type { ApprovalRequest } from '../../features/approval-runtime/domain/approval-request.js';
import type { ApprovalRequirement } from '../../features/approval-runtime/domain/approval-requirement.js';
import { createAdmissionApprovalPolicyChain, QuorumPolicy } from '../../features/approval-runtime/policies/index.js';
import { ApprovalPolicyEvaluator } from '../../features/approval-runtime/services/approval-policy-evaluator.js';
import type { StoredApprovalRecord } from './contracts.js';
import type { ApprovalSubject } from './subject.js';

/**
 * CORE-05 — the approval state of one committed decision, derived.
 *
 * Nothing here is stored and nothing here is new approval semantics. The
 * authenticated log holds *facts* — who gave which verdict on which subject,
 * with which evidence, when — and the state is recomputed from them on every
 * read by **replaying them through approval-runtime's own policies**: the
 * admission chain `ApprovalDecisionService` runs before accepting a decision
 * (`createAdmissionApprovalPolicyChain()`: valid request, recognized approver,
 * approver authority, scope, evidence, segregation of duties, expiration,
 * revocation, duplicate) and `QuorumPolicy` for completion. The runtime's
 * request/requirement/decision shapes are built from the request's
 * **snapshotted** requirement — never from current configuration.
 *
 * Two things are the governed path's own, and both only ever restrict:
 *
 * - **Authority is re-resolved now.** An approving verdict counts only while
 *   its approver is still a recognized Kernel-Authority actor holding live
 *   authority for the requirement's approver action over the resource *at the
 *   instant the state is read* — so revoking or expiring an approver's
 *   authority withdraws their approval, and a completed approval stops being
 *   usable to mint a new grant (CORE-05 decision: approval authority is live
 *   lineage, not history). Expiry of the *request* is judged at the instant
 *   the verdict was recorded (approval-runtime's `ExpirationPolicy`).
 * - **Restrictive verdicts are final.** A `rejected` or `revoked` row is in
 *   the authenticated log only because the command service admitted it; it
 *   counts regardless of what happens to its author's authority later, since
 *   un-counting it would widen authority.
 *
 * `requested_changes` and `escalated` are recorded (approval-runtime records
 * them too) and change nothing: the request stays pending, no quorum, no
 * proof. A request that needs changes is superseded only by a new governed
 * request — a new idempotency key, a new decision.
 */

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'revoked' | 'request-expired' | 'approval-expired';

/** One verdict as the replay judged it. */
export interface ApprovalVerdictView {
  readonly kind: StoredApprovalRecord['kind'];
  readonly actorId: string;
  readonly recordedAt: string;
  readonly rowDigest: string;
  /** Whether it counts toward the state now. */
  readonly counted: boolean;
  /** approval-runtime's reason code for the verdict, as judged now. */
  readonly reasonCode: string;
}

export interface ApprovalEvaluation {
  readonly status: ApprovalStatus;
  /** Distinct eligible approvers counted toward quorum, in the order they approved. */
  readonly approvers: readonly string[];
  readonly minimumApprovals: number;
  /** When the request stops accepting verdicts. */
  readonly requestExpiresAt: string;
  readonly verdicts: readonly ApprovalVerdictView[];
  /** `approved` / `approval-expired`: when quorum was reached, and when the approval lapses. */
  readonly approvedAt?: string;
  readonly notAfter?: string;
  /**
   * `approved` only: the approval proof digest — over the exact target (the
   * subject, which binds the decision and the requirement snapshot) and every
   * verdict that completed it, evidence hashes included. What a resumed
   * grant's signed source binds.
   */
  readonly approvalDigest?: string;
  /** `rejected` / `revoked`: who closed it. */
  readonly closedBy?: string;
}

export const APPROVAL_PROOF_FORMAT = 'frontera.approval-proof.v1';

export interface ApprovalAuthorityQuery {
  readonly actorId: string;
  /** The requirement's approver action (approval-runtime's `requiredAuthorityCapability`). */
  readonly capability: string;
  readonly resourceScope: string;
  readonly at: string;
}

/** The Kernel-Authority questions the replay asks. Composition answers them from the durable Kernel-Authority world. */
export interface ApprovalAuthorityPort {
  recognition(actorId: string): ApprovalApproverRecognitionResult;
  authority(query: ApprovalAuthorityQuery): ApprovalAuthorityCheckResult;
}

export interface EvaluateApprovalInput {
  readonly subject: ApprovalSubject;
  readonly subjectDigest: string;
  readonly approvalRequestId: string;
  /** The verified rows of this request, in append order. */
  readonly rows: readonly StoredApprovalRecord[];
  readonly now: string;
  readonly authority: ApprovalAuthorityPort;
}

function plusSeconds(instant: string, seconds: number): string {
  return new Date(Date.parse(instant) + seconds * 1000).toISOString();
}

function sha256(text: string): string {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

const quote = (value: string): string => JSON.stringify(value);

/** The deterministic identity of the one approval request a committed decision has: derived from its immutable identity, never from a counter. */
export function approvalRequestIdFor(organizationId: string, requestId: string, decisionId: string, subjectDigest: string): string {
  return `approval-request:${sha256(`frontera.approval-request.v1\n{"decisionId":${quote(decisionId)},"organizationId":${quote(organizationId)},"requestId":${quote(requestId)},"subjectDigest":${quote(subjectDigest)}}`).slice('sha256:'.length)}`;
}

/** The digest a completed approval is known by. */
export function approvalProofDigest(input: {
  readonly organizationId: string;
  readonly approvalRequestId: string;
  readonly requestId: string;
  readonly decisionId: string;
  readonly subjectDigest: string;
  readonly requirementDigest: string;
  readonly minimumApprovals: number;
  readonly approvers: readonly string[];
  readonly rowDigests: readonly string[];
  readonly approvedAt: string;
  readonly notAfter: string;
}): string {
  return sha256(
    `${APPROVAL_PROOF_FORMAT}\n{` +
      [
        `"approvalRequestId":${quote(input.approvalRequestId)}`,
        `"approvedAt":${quote(input.approvedAt)}`,
        `"approvers":[${input.approvers.map(quote).join(',')}]`,
        `"decisionId":${quote(input.decisionId)}`,
        `"minimumApprovals":${String(input.minimumApprovals)}`,
        `"notAfter":${quote(input.notAfter)}`,
        `"organizationId":${quote(input.organizationId)}`,
        `"requestId":${quote(input.requestId)}`,
        `"requirementDigest":${quote(input.requirementDigest)}`,
        `"rows":[${input.rowDigests.map(quote).join(',')}]`,
        `"subjectDigest":${quote(input.subjectDigest)}`,
      ].join(',') +
      '}',
  );
}

/** The canonical evidence text a verdict row carries: `[{hash, type, uri?}]`, sorted, closed. */
export interface ApprovalEvidenceReference {
  readonly type: string;
  readonly hash: string;
  readonly uri?: string;
}

export function canonicalEvidence(evidence: readonly ApprovalEvidenceReference[]): string {
  const entries = evidence
    .map((entry) => `{"hash":${quote(entry.hash)},"type":${quote(entry.type)}${entry.uri !== undefined ? `,"uri":${quote(entry.uri)}` : ''}}`)
    .sort();
  return `[${entries.join(',')}]`;
}

function evidenceArtifacts(row: StoredApprovalRecord, actorId: string): readonly ApprovalEvidenceArtifact[] {
  if (row.evidence === undefined) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.evidence);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((entry: unknown): ApprovalEvidenceArtifact[] => {
    if (entry === null || typeof entry !== 'object') return [];
    const { type, hash, uri } = entry as Record<string, unknown>;
    if (typeof type !== 'string' || typeof hash !== 'string') return [];
    return [{ id: hash, type: type as ApprovalEvidenceType, providedByActorId: actorId, hash, ...(typeof uri === 'string' ? { uri } : {}), createdAt: row.recordedAt }];
  });
}

/** approval-runtime's requirement, from the request's snapshot — the only source of what the request requires. */
export function runtimeRequirementOf(subject: ApprovalSubject): ApprovalRequirement {
  const { requirement } = subject;
  return {
    id: `approval-requirement:${subject.requirementDigest}`,
    type: 'quorum_approval',
    trustDomainId: subject.organizationId,
    action: subject.action,
    resourceScope: subject.resourceScope,
    riskLevel: 'high',
    requiredAuthorityCapability: requirement.approverAction,
    minimumApprovals: requirement.minimumApprovals,
    // Always, on the governed path: the requester and the target never approve their own action.
    requiresSegregationOfDuties: true,
    evidenceRequirements: (requirement.requiredEvidence ?? []).map((type) => ({ id: type, type: type as ApprovalEvidenceType, required: true, description: `Required by ${subject.governanceProfile}.` })),
  };
}

/** approval-runtime's request, in the lifecycle status the replay has reached. */
export function runtimeRequestOf(subject: ApprovalSubject, approvalRequestId: string, status: ApprovalRequest['status']): ApprovalRequest {
  return {
    id: approvalRequestId,
    trustDomainId: subject.organizationId,
    actionRequestId: subject.requestId,
    requestedByActorId: subject.actorId,
    // The governed actor is also the target of its own action. The principal
    // it acts for is deliberately *not* barred — approval-runtime's
    // `SegregationOfDutiesPolicy` preserves the human-owner review.
    targetActorId: subject.actorId,
    ...(subject.principalActorId !== undefined ? { principalActorId: subject.principalActorId } : {}),
    action: subject.action,
    resourceScope: subject.resourceScope,
    riskLevel: 'high',
    requirement: runtimeRequirementOf(subject),
    status,
    evidence: [],
    createdAt: subject.decision.evaluatedAt,
    expiresAt: plusSeconds(subject.decision.evaluatedAt, subject.requirement.requestTtlSeconds),
  };
}

const admission = new ApprovalPolicyEvaluator(createAdmissionApprovalPolicyChain());
const quorum = new QuorumPolicy();

/** The context approval-runtime's policies judge one attempt in — the approver's standing read from Kernel-Authority. */
export function policyContextFor(input: {
  readonly request: ApprovalRequest;
  readonly actorId: string;
  readonly type: 'approved' | 'rejected' | 'requested_changes' | 'escalated';
  readonly evidenceReviewed: readonly ApprovalEvidenceArtifact[];
  readonly decidedAt: string;
  readonly authorityAt: string;
  readonly priorDecisions: readonly ApprovalDecision[];
  readonly authority: ApprovalAuthorityPort;
}): ApprovalPolicyContext {
  const { request } = input;
  const capability = request.requirement.requiredAuthorityCapability as string;
  let approverRecognition: ApprovalApproverRecognitionResult;
  let authorityCheck: ApprovalAuthorityCheckResult;
  try {
    approverRecognition = input.authority.recognition(input.actorId);
    authorityCheck = input.authority.authority({ actorId: input.actorId, capability, resourceScope: request.resourceScope, at: input.authorityAt });
  } catch {
    // Unreadable authority is no authority.
    approverRecognition = { recognized: false, reasonCode: 'APPROVER_UNKNOWN', reason: 'Kernel-Authority could not be read.' };
    authorityCheck = { valid: false, type: 'authority_missing', reasonCode: 'APPROVER_AUTHORITY_MISSING', reason: 'Kernel-Authority could not be read.' };
  }
  return {
    now: input.decidedAt,
    request,
    attempt: { approverActorId: input.actorId, type: input.type, evidenceReviewed: input.evidenceReviewed },
    approverRecognition,
    authorityCheck,
    priorDecisions: input.priorDecisions,
  };
}

/** Runs approval-runtime's admission chain over one attempt. */
export function admit(context: ApprovalPolicyContext): { readonly passed: boolean; readonly reasonCode: string } {
  const outcome = admission.evaluate(context);
  return { passed: outcome.passed, reasonCode: outcome.reasonCode };
}

function belongs(row: StoredApprovalRecord, input: EvaluateApprovalInput): boolean {
  return row.requestId === input.subject.requestId && row.decisionId === input.subject.decisionId && row.subjectDigest === input.subjectDigest && row.organizationId === input.subject.organizationId;
}

export function evaluateApproval(input: EvaluateApprovalInput): ApprovalEvaluation {
  const { subject, now } = input;
  const minimumApprovals = subject.requirement.minimumApprovals;
  const requestExpiresAt = plusSeconds(subject.decision.evaluatedAt, subject.requirement.requestTtlSeconds);
  let status: ApprovalRequest['status'] = 'pending';
  let approvedAt: string | undefined;
  let closedBy: string | undefined;
  const accepted: { readonly decision: ApprovalDecision; readonly rowDigest: string }[] = [];
  const verdicts: ApprovalVerdictView[] = [];

  for (const row of input.rows) {
    if (row.kind === 'requested' || !belongs(row, input)) continue;
    const actorId = row.actorId;
    if (actorId === undefined) continue;
    const view = (counted: boolean, reasonCode: string): void => {
      verdicts.push({ kind: row.kind, actorId, recordedAt: row.recordedAt, rowDigest: row.digest, counted, reasonCode });
    };

    // Restrictive and final (see above): a revocation closes a pending or an
    // approved request; a rejection closes a pending one.
    if (row.kind === 'revoked') {
      if (status === 'pending' || status === 'approved') {
        status = 'revoked';
        closedBy = actorId;
        view(true, 'APPROVAL_REVOKED');
      } else {
        view(false, 'APPROVAL_REQUEST_INVALID');
      }
      continue;
    }
    if (row.kind === 'rejected') {
      if (status === 'pending') {
        status = 'rejected';
        closedBy = actorId;
        view(true, 'APPROVAL_REJECTED');
      } else {
        view(false, 'APPROVAL_REQUEST_INVALID');
      }
      continue;
    }
    if (row.kind === 'requested_changes' || row.kind === 'escalated') {
      view(false, row.kind === 'escalated' ? 'APPROVAL_ESCALATED' : 'APPROVAL_CHANGES_REQUESTED');
      continue;
    }

    // `approved`: approval-runtime's admission chain — request expiry at the
    // instant it was recorded, the approver's standing now.
    const request = runtimeRequestOf(subject, input.approvalRequestId, status);
    const context = policyContextFor({
      request,
      actorId,
      type: 'approved',
      evidenceReviewed: evidenceArtifacts(row, actorId),
      decidedAt: row.recordedAt,
      authorityAt: now,
      priorDecisions: accepted.map((entry) => entry.decision),
      authority: input.authority,
    });
    const admitted = admit(context);
    if (!admitted.passed) {
      view(false, admitted.reasonCode);
      continue;
    }
    const reached = quorum.evaluate(context).passed;
    accepted.push({
      rowDigest: row.digest,
      decision: {
        id: row.digest,
        approvalRequestId: input.approvalRequestId,
        trustDomainId: subject.organizationId,
        approverActorId: actorId,
        type: 'approved',
        approved: true,
        reasonCode: admitted.reasonCode,
        evidenceReviewed: context.attempt.evidenceReviewed,
        decidedAt: row.recordedAt,
      },
    });
    view(true, reached ? 'APPROVAL_QUORUM_MET' : 'APPROVAL_QUORUM_NOT_MET');
    if (reached) {
      status = 'approved';
      approvedAt = row.recordedAt;
    }
  }

  const approvers = accepted.map((entry) => entry.decision.approverActorId);
  const base = { approvers, minimumApprovals, requestExpiresAt, verdicts };
  if (status === 'rejected' || status === 'revoked') return { status, ...base, ...(closedBy !== undefined ? { closedBy } : {}) };
  if (status === 'approved' && approvedAt !== undefined) {
    const notAfter = plusSeconds(approvedAt, subject.requirement.approvalValiditySeconds);
    if (Date.parse(now) >= Date.parse(notAfter)) return { status: 'approval-expired', ...base, approvedAt, notAfter };
    const approvalDigest = approvalProofDigest({
      organizationId: subject.organizationId,
      approvalRequestId: input.approvalRequestId,
      requestId: subject.requestId,
      decisionId: subject.decisionId,
      subjectDigest: input.subjectDigest,
      requirementDigest: subject.requirementDigest,
      minimumApprovals,
      approvers,
      rowDigests: accepted.map((entry) => entry.rowDigest),
      approvedAt,
      notAfter,
    });
    return { status: 'approved', ...base, approvedAt, notAfter, approvalDigest };
  }
  if (Date.parse(now) >= Date.parse(requestExpiresAt)) return { status: 'request-expired', ...base };
  return { status: 'pending', ...base };
}
