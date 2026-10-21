import type { ActionDescriptor, ActorReference, KernelDecisionStatus, KernelEvaluationOptions, KernelEvaluationRequest, KernelEvaluationResult, KernelIdGenerator, KernelClock } from '../../kernel/index.js';
import { SERVER_DERIVED_IDENTIFIER_PREFIX, isServerDerivedIdentifierNamespace } from '../governed-action/identifiers.js';
import { EnterpriseHttpErrors } from './enterprise-http-errors.js';

/** Wire shape for `POST /api/governance/evaluate`. A structural subset of `KernelEvaluationRequest` -- the Enterprise Host never adds fields the Kernel doesn't already define, per "No Enterprise module may manipulate governance semantics." */
export interface GovernanceEvaluateRequestBody {
  readonly requestId?: string;
  readonly correlationId?: string;
  readonly requestedAt?: string;
  readonly actor: ActorReference;
  readonly action: ActionDescriptor;
  readonly target?: KernelEvaluationRequest['target'];
  readonly organization?: KernelEvaluationRequest['organization'];
  readonly context?: Readonly<Record<string, unknown>>;
  readonly idempotencyKey?: string;
  readonly expiresAt?: string;
  readonly approvalProofId?: string;
  readonly approvalRequestId?: string;
  readonly approvalDecisionId?: string;
  readonly visaId?: string;
  readonly ingressGrantId?: string;
  readonly handshakeProofId?: string;
  readonly traceLevel?: 'basic' | 'full';
  readonly dryRun?: boolean;
}

/** Wire shape returned from `POST /api/governance/evaluate` -- exactly the mission's Response Contract, plus `requestId`/`correlationId` for client-side correlation (neither is internal Enterprise state). */
export interface GovernanceEvaluateResponseBody {
  readonly requestId: string;
  readonly decisionId: string;
  readonly status: KernelDecisionStatus;
  readonly summary: string;
  readonly reasonCodes: readonly string[];
  readonly trace: KernelEvaluationResult['trace'];
  readonly evaluatedAt: string;
  readonly kernelVersion: string;
  readonly correlationId?: string;
  /** Backward-compatible addition (PR-004 section 97): the durable Governance Record this response was committed as. Absent only if the Host was composed without record identification. */
  readonly governanceRecord?: {
    readonly evaluationId: string;
    readonly aggregateDigest: string;
  };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The Enterprise Host's own request validation -- HTTP/JSON shape only. It
 * deliberately does not duplicate the Kernel's own `validateKernelEvaluationRequest`
 * (e.g. it does not know which fields the wrapped engine treats as
 * significant); `AocKernel.evaluate()` still runs its full validation and a
 * `KernelValidationError` from there is mapped to the same 400 by the
 * orchestrator. This function exists so a malformed HTTP body never reaches
 * dependency resolution or the Kernel at all.
 */
export function validateGovernanceEvaluateRequestBody(body: unknown): GovernanceEvaluateRequestBody {
  const violations: string[] = [];

  if (!isPlainObject(body)) {
    throw EnterpriseHttpErrors.invalidRequest('Request body must be a JSON object.');
  }

  const actor = body.actor;
  if (!isPlainObject(actor) || !isNonEmptyString(actor.id) || !isNonEmptyString(actor.trustDomainId)) {
    violations.push('actor.id and actor.trustDomainId are required non-empty strings.');
  }

  const action = body.action;
  if (!isPlainObject(action) || !isNonEmptyString(action.type) || !isNonEmptyString(action.resourceScope)) {
    violations.push('action.type and action.resourceScope are required non-empty strings.');
  }

  if (body.organization !== undefined && (!isPlainObject(body.organization) || !isNonEmptyString(body.organization.id))) {
    violations.push('organization, when present, must be an object with a non-empty id.');
  }

  // G-01B0: a caller's request id is a non-empty string outside the namespace
  // the server derives governed identities in.
  if (body.requestId !== undefined) {
    if (!isNonEmptyString(body.requestId)) {
      violations.push('requestId, when present, must be a non-empty string.');
    } else if (isServerDerivedIdentifierNamespace(body.requestId)) {
      violations.push(`requestId may not begin with the reserved '${SERVER_DERIVED_IDENTIFIER_PREFIX}' prefix; that namespace is server-derived.`);
    }
  }

  if (body.correlationId !== undefined && !isNonEmptyString(body.correlationId)) {
    violations.push('correlationId, when present, must be a non-empty string.');
  }

  if (violations.length > 0) {
    throw EnterpriseHttpErrors.invalidRequest('The governance evaluation request failed validation.', violations);
  }

  return body as unknown as GovernanceEvaluateRequestBody;
}

/** Fills in `requestId`/`requestedAt` from the composed clock/id generator when the caller omits them, then adapts 1:1 onto `KernelEvaluationRequest`. */
export function toKernelEvaluationRequest(body: GovernanceEvaluateRequestBody, clock: KernelClock, idGenerator: KernelIdGenerator): KernelEvaluationRequest {
  return {
    requestId: body.requestId ?? idGenerator.nextId('enterprise-request'),
    actor: body.actor,
    action: body.action,
    requestedAt: body.requestedAt ?? clock.now(),
    ...(body.target !== undefined ? { target: body.target } : {}),
    ...(body.organization !== undefined ? { organization: body.organization } : {}),
    ...(body.context !== undefined ? { context: body.context } : {}),
    ...(body.correlationId !== undefined ? { correlationId: body.correlationId } : {}),
    ...(body.idempotencyKey !== undefined ? { idempotencyKey: body.idempotencyKey } : {}),
    ...(body.expiresAt !== undefined ? { expiresAt: body.expiresAt } : {}),
    ...(body.approvalProofId !== undefined ? { approvalProofId: body.approvalProofId } : {}),
    ...(body.approvalRequestId !== undefined ? { approvalRequestId: body.approvalRequestId } : {}),
    ...(body.approvalDecisionId !== undefined ? { approvalDecisionId: body.approvalDecisionId } : {}),
    ...(body.visaId !== undefined ? { visaId: body.visaId } : {}),
    ...(body.ingressGrantId !== undefined ? { ingressGrantId: body.ingressGrantId } : {}),
    ...(body.handshakeProofId !== undefined ? { handshakeProofId: body.handshakeProofId } : {}),
  };
}

export function toKernelEvaluationOptions(body: GovernanceEvaluateRequestBody, defaultTraceLevel: 'basic' | 'full'): KernelEvaluationOptions {
  return {
    traceLevel: body.traceLevel ?? defaultTraceLevel,
    ...(body.dryRun !== undefined ? { dryRun: body.dryRun } : {}),
  };
}

export function toGovernanceEvaluateResponseBody(
  result: KernelEvaluationResult,
  governanceRecord?: { readonly evaluationId: string; readonly aggregateDigest: string },
): GovernanceEvaluateResponseBody {
  return {
    requestId: result.requestId,
    decisionId: result.decisionId,
    status: result.status,
    summary: result.summary,
    reasonCodes: result.reasonCodes,
    trace: result.trace,
    evaluatedAt: result.evaluatedAt,
    kernelVersion: result.kernelVersion,
    ...(result.correlationId !== undefined ? { correlationId: result.correlationId } : {}),
    ...(governanceRecord !== undefined ? { governanceRecord } : {}),
  };
}

/**
 * `allowed`/`approval_required` are both successful evaluations (200) -- the
 * caller asked "what happens if I do this," and got a definitive answer.
 * `denied` is a deliberate, documented governance denial: real per the
 * mission's Enterprise Error Model ("422 Governance denial ... is NOT an
 * infrastructure error"), distinguishable from success without treating it
 * as a 5xx. `indeterminate` means the Kernel's own recognitionProvider
 * dependency failed during evaluation (`KERNEL_INDETERMINATE`) -- a real
 * provider fault, mapped to 503.
 */
export function mapDecisionStatusToHttpStatus(status: KernelDecisionStatus): number {
  switch (status) {
    case 'allowed':
    case 'approval_required':
      return 200;
    case 'denied':
      return 422;
    case 'indeterminate':
      return 503;
  }
}
