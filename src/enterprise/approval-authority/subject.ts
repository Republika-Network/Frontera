import { createHash } from 'node:crypto';

import { stableStringify } from '../../features/approval-runtime/domain/approval-proof.js';
import type { KernelEvaluationRequest, KernelEvaluationResult } from '../../kernel/index.js';
import type { GovernanceProfileApproval } from '../governance-profile/index.js';

/**
 * CORE-05 — the approval subject: exactly what is being approved, and under
 * exactly which requirement.
 *
 * An approval is bound to a governed request **and its committed decision**,
 * and to the content of both: who asked (and on whose behalf), for what action
 * on what resource, with which amount, counterparty and typed parameters,
 * under which **trusted** effective Governance Profile and admitted context,
 * and what the Kernel decided and why. It also carries the Governance Store's
 * own canonical digests of the committed record (`decisionDigest`) — not a
 * second canonicalization of the decision — and a **snapshot** of the
 * approval requirement with its digest, so a later configuration change can
 * never reinterpret a request already open.
 *
 * The subject is computed by trusted code from the committed, re-read and
 * verified decision and from trusted configuration — never from anything a
 * requester or an approver supplies, and never from the request's own
 * `semantics` claim — and its digest is what every verdict names. So an
 * approval of one request can never be used for another (another
 * `requestId`, another `decisionId`), never for the same request with any
 * different content, profile, context or requirement (another digest), and an
 * approver can only approve the exact bytes they were shown.
 *
 * Canonical JSON (recursively key-sorted — approval-runtime's
 * `stableStringify`, reused) under an explicit format tag.
 */
export const APPROVAL_SUBJECT_FORMAT = 'frontera.approval-subject.v1';
export const APPROVAL_REQUIREMENT_FORMAT = 'frontera.approval-requirement.v1';

export interface ApprovalSubject {
  readonly format: typeof APPROVAL_SUBJECT_FORMAT;
  readonly organizationId: string;
  readonly requestId: string;
  readonly decisionId: string;
  readonly evaluationId: string;
  /** The Governance Store's canonical digests of the committed record: its request payload and its evaluation. */
  readonly decisionDigest: { readonly requestDigest: string; readonly evaluationDigest: string };
  /** The actor that requested the action. */
  readonly actorId: string;
  /** The principal the actor acts for, when it acts for one. */
  readonly principalActorId?: string;
  readonly action: string;
  readonly resourceScope: string;
  readonly counterpartyId?: string;
  readonly amount?: { readonly value: string; readonly unit: string };
  /** `<id>@<version>#<digest>` — the effective Governance Profile, as the trusted registry resolves the action and resource. */
  readonly governanceProfile: string;
  readonly actionClass: string;
  readonly resourceClass: string;
  readonly parameters?: readonly { readonly dimension: string; readonly type: string; readonly value: string | number }[];
  /** CORE-04 — the admitted-context digest and validity the decision relied on. */
  readonly contextDigest?: string;
  readonly contextValidUntil?: string;
  readonly decision: { readonly status: string; readonly reasonCodes: readonly string[]; readonly evaluatedAt: string };
  /** The approval requirement as it stood when the request was opened. Never re-read from configuration. */
  readonly requirement: GovernanceProfileApproval;
  /** `sha256:<hex>` over the requirement snapshot. */
  readonly requirementDigest: string;
}

/** The digest of an approval requirement snapshot. */
export function approvalRequirementDigest(requirement: GovernanceProfileApproval): string {
  return `sha256:${createHash('sha256').update(`${APPROVAL_REQUIREMENT_FORMAT}\n${stableStringify(requirement)}`, 'utf8').digest('hex')}`;
}

/** The subject of a committed decision. Every field is read from the verified request and decision, the committed record's digests, and trusted configuration. */
export function approvalSubjectOf(input: {
  readonly organizationId: string;
  readonly evaluationId: string;
  readonly request: KernelEvaluationRequest;
  readonly decision: Pick<KernelEvaluationResult, 'decisionId' | 'status' | 'reasonCodes' | 'evaluatedAt' | 'context'>;
  readonly decisionDigest: { readonly requestDigest: string; readonly evaluationDigest: string };
  /** The trusted effective profile: its key and its declared classes. */
  readonly profile: { readonly key: string; readonly actionClass: string; readonly resourceClass: string };
  readonly requirement: GovernanceProfileApproval;
}): ApprovalSubject {
  const { request, decision } = input;
  const { action } = request;
  const contextDigest = decision.context?.digest;
  const contextValidUntil = decision.context?.validUntil;
  return {
    format: APPROVAL_SUBJECT_FORMAT,
    organizationId: input.organizationId,
    requestId: request.requestId,
    decisionId: decision.decisionId,
    evaluationId: input.evaluationId,
    decisionDigest: { requestDigest: input.decisionDigest.requestDigest, evaluationDigest: input.decisionDigest.evaluationDigest },
    actorId: request.actor.id,
    ...(request.actor.principalId !== undefined ? { principalActorId: request.actor.principalId } : {}),
    action: action.capability ?? action.type,
    resourceScope: action.resourceScope,
    ...(action.counterpartyId !== undefined ? { counterpartyId: action.counterpartyId } : {}),
    ...(action.amount !== undefined && action.currency !== undefined ? { amount: { value: action.amount, unit: action.currency } } : {}),
    governanceProfile: input.profile.key,
    actionClass: input.profile.actionClass,
    resourceClass: input.profile.resourceClass,
    ...(action.governedParameters !== undefined
      ? { parameters: action.governedParameters.map(({ dimension, type, value }) => ({ dimension, type, value: value as string | number })) }
      : {}),
    ...(typeof contextDigest === 'string' ? { contextDigest } : {}),
    ...(typeof contextValidUntil === 'string' ? { contextValidUntil } : {}),
    decision: { status: decision.status, reasonCodes: [...decision.reasonCodes], evaluatedAt: decision.evaluatedAt },
    requirement: input.requirement,
    requirementDigest: approvalRequirementDigest(input.requirement),
  };
}

/** The canonical bytes an approver is shown and every verdict is bound to. */
export function canonicalApprovalSubject(subject: ApprovalSubject): string {
  return stableStringify(subject);
}

export function approvalSubjectDigest(canonical: string): string {
  return `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
}
