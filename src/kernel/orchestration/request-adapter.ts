import {
  GOVERNED_CONSTRAINT_POLICY_METADATA_KEY,
  type GovernedConstraintPolicyContext,
} from '@aoc-enterprise/governed-authority';

import {
  CONTEXT_RESOLUTION_POLICY_METADATA_KEY,
  isReservedContextKey,
  type ContextResolution,
} from '../../features/context-resolution-runtime/index.js';
import { isReservedObligationKey } from '../../features/obligation-runtime/index.js';
import type { GuardActionRequestInput } from '../../features/action-enforcement/sdk/aoc-guard.js';
import type { EnforcementPolicyEvaluationInput } from '../../features/action-enforcement/domain/enforcement-request.js';
import type { EnforcementTargetType } from '../../features/action-enforcement/domain/enforcement-target.js';
import type { KernelEvaluationOptions } from '../contracts/kernel-options.js';
import type { KernelEvaluationRequest } from '../contracts/kernel-request.js';
import { KernelValidationError } from '../errors/kernel-errors.js';

const ENFORCEMENT_TARGET_TYPES: ReadonlySet<string> = new Set<EnforcementTargetType>([
  'tool_call',
  'api_handler',
  'workflow_step',
  'webhook',
  'scheduled_job',
  'manual_operation',
  'generic',
]);

function toEnforcementTargetType(type: string | undefined): EnforcementTargetType | undefined {
  return type !== undefined && ENFORCEMENT_TARGET_TYPES.has(type) ? (type as EnforcementTargetType) : undefined;
}

/** Structural validation only -- checks required-field shape, not governance content. A request that fails these checks never reaches the wrapped engine at all. */
export function validateKernelEvaluationRequest(request: KernelEvaluationRequest): void {
  if (!request.requestId || request.requestId.trim().length === 0) {
    throw new KernelValidationError('KernelEvaluationRequest.requestId is required and must be non-empty.');
  }
  if (!request.actor || !request.actor.id || request.actor.id.trim().length === 0) {
    throw new KernelValidationError('KernelEvaluationRequest.actor.id is required and must be non-empty.');
  }
  if (!request.actor.trustDomainId || request.actor.trustDomainId.trim().length === 0) {
    throw new KernelValidationError('KernelEvaluationRequest.actor.trustDomainId is required and must be non-empty.');
  }
  if (!request.action || !request.action.type || request.action.type.trim().length === 0) {
    throw new KernelValidationError('KernelEvaluationRequest.action.type is required and must be non-empty.');
  }
  if (!request.action.resourceScope || request.action.resourceScope.trim().length === 0) {
    throw new KernelValidationError('KernelEvaluationRequest.action.resourceScope is required and must be non-empty.');
  }
  if (!request.requestedAt || Number.isNaN(Date.parse(request.requestedAt))) {
    throw new KernelValidationError('KernelEvaluationRequest.requestedAt must be a valid ISO-8601 timestamp.');
  }
}

/**
 * Assembles the optional Domain Policy Pack preflight input.
 *
 * The governed constraint context, when one was resolved, travels in the
 * deployment metadata bag under a namespaced key rather than as a new top-level
 * field. Two reasons, both deliberate: the bag is already the documented place
 * for facts a deployment's own rules turn on, and keeping it out of the typed
 * policy-input surface means a deployment that has never heard of persistent
 * constraints compiles, runs and decides exactly as it did before.
 *
 * A resolved context is enough on its own to build an input. A request that
 * engages governed rights but sets none of the policy-pack fields still needs
 * its constraint facts to reach a policy that asked for them, and returning
 * `undefined` because no *other* field was set would drop them silently.
 */
function buildPolicyEvaluationInput(
  request: KernelEvaluationRequest,
  constraintContext: GovernedConstraintPolicyContext | undefined,
  contextResolution: ContextResolution | undefined,
): EnforcementPolicyEvaluationInput | undefined {
  const { action } = request;
  const hasPolicyPackFields =
    constraintContext !== undefined ||
    contextResolution !== undefined ||
    action.domain !== undefined ||
    action.jurisdiction !== undefined ||
    action.country !== undefined ||
    action.industry !== undefined ||
    action.customerId !== undefined ||
    action.amount !== undefined ||
    action.currency !== undefined ||
    action.counterpartyId !== undefined ||
    action.dataDomains !== undefined ||
    action.evidenceIds !== undefined;

  if (!hasPolicyPackFields) {
    return undefined;
  }

  const metadata = buildPolicyMetadata(constraintContext, contextResolution);

  return {
    ...(action.domain !== undefined ? { domain: action.domain } : {}),
    ...(action.jurisdiction !== undefined ? { jurisdiction: action.jurisdiction } : {}),
    ...(action.country !== undefined ? { country: action.country } : {}),
    ...(action.industry !== undefined ? { industry: action.industry } : {}),
    ...(action.customerId !== undefined ? { customerId: action.customerId } : {}),
    ...(action.amount !== undefined ? { amount: action.amount } : {}),
    ...(action.currency !== undefined ? { currency: action.currency } : {}),
    ...(action.counterpartyId !== undefined ? { counterpartyId: action.counterpartyId } : {}),
    ...(action.dataDomains !== undefined ? { dataDomains: action.dataDomains } : {}),
    ...(action.evidenceIds !== undefined ? { evidenceIds: action.evidenceIds } : {}),
    ...(metadata !== undefined ? { metadata } : {}),
  };
}

/**
 * The reserved metadata bag policy reads facts out of.
 *
 * Assembled here, from resolved values only, and never from anything the caller
 * sent. `EnforcementPolicyEvaluationInput.metadata` has no other producer:
 * every other field of the policy input is copied from a typed
 * `ActionDescriptor` field, so there is no route by which a request body
 * contributes a key to this object. That is what makes the namespace
 * unforgeable rather than merely reserved.
 */
function buildPolicyMetadata(
  constraintContext: GovernedConstraintPolicyContext | undefined,
  contextResolution: ContextResolution | undefined,
): Readonly<Record<string, unknown>> | undefined {
  if (constraintContext === undefined && contextResolution === undefined) return undefined;
  return {
    ...(constraintContext !== undefined ? { [GOVERNED_CONSTRAINT_POLICY_METADATA_KEY]: constraintContext } : {}),
    ...(contextResolution !== undefined ? { [CONTEXT_RESOLUTION_POLICY_METADATA_KEY]: contextResolution } : {}),
  };
}

/**
 * Maps a `KernelEvaluationRequest` onto the wrapped engine's own
 * `GuardActionRequestInput`. Never mutates the input request. `mode` is
 * `'dry_run'` when `options.dryRun` is set, otherwise left to the caller
 * (`preflight` for `evaluate()`, `execute` for `enforce()` -- set by the
 * caller of this function, not here).
 */
export function toGuardActionRequestInput(
  request: KernelEvaluationRequest,
  options: KernelEvaluationOptions | undefined,
  constraintContext?: GovernedConstraintPolicyContext,
  contextResolution?: ContextResolution,
): GuardActionRequestInput {
  const { actor, action, target } = request;
  const policyEvaluationInput = buildPolicyEvaluationInput(request, constraintContext, contextResolution);
  const targetType = toEnforcementTargetType(target?.type);
  const context: Record<string, unknown> = { ...(request.context ?? {}) };

  // `organizationId`/`organizationName` are reserved: they are derived from
  // the typed `organization` field and from nowhere else. A caller-supplied
  // value of either name is dropped rather than passed through.
  //
  // This matters because `context` is a free-form bag that travels into the
  // metadata a `RecognitionProvider` reads. A provider that scopes decisions by
  // organization -- the durable Kernel Authority one does -- would otherwise be
  // reading a claim the requester wrote about itself, which is exactly the
  // self-assertion the governance boundary exists to prevent. Leaving the
  // typed field absent must mean "no organization stated", never "whatever the
  // request put in the bag".
  delete context.organizationId;
  delete context.organizationName;

  // The same defence, generalized from two names to a namespace, per
  // `ADR-CONTEXT-PROVENANCE-AND-TRUST.md` sec. 6: "requester-supplied context is
  // stripped of any key in that namespace before it travels, the same `delete`
  // `request-adapter.ts` already performs for `organizationId`."
  //
  // The reserved namespace is where *resolved* facts live -- values a
  // configured source produced and a trust class was assigned to. A caller that
  // submits one is submitting a forgery of exactly the thing the boundary
  // exists to protect, so it is dropped here, unconditionally and whether or
  // not a context capability is configured. Dropping rather than rejecting is
  // deliberate: the two existing reserved names behave the same way, and a
  // request that merely carries a stray key is not malformed.
  //
  // This can break no existing deployment: the namespace did not exist before
  // the context capability did, so nothing can have been passing one through.
  //
  // `aoc.obligations` is reserved by the same rule and in the same pass. Note
  // what that reservation is *not* doing: obligation state is never read out of
  // this bag under any name — its sole producer is the configured discharge
  // provider, and `ObligationDischargeQuery` carries no requester bag at all —
  // so a forged `aoc.obligations` would have had nowhere to be read from even
  // if it survived. It is dropped anyway, for the reason `organizationId` is: a
  // key that means something internally must not be writable from outside,
  // whether or not a reader exists today.
  for (const key of Object.keys(context)) {
    if (isReservedContextKey(key) || isReservedObligationKey(key)) delete context[key];
  }
  if (request.organization !== undefined) {
    context.organizationId = request.organization.id;
    if (request.organization.name !== undefined) {
      context.organizationName = request.organization.name;
    }
  }
  if (request.correlationId !== undefined) {
    context.correlationId = request.correlationId;
  }
  if (action.parameters !== undefined) {
    context.parameters = action.parameters;
  }

  return {
    actorId: actor.id,
    trustDomainId: actor.trustDomainId,
    action: action.type,
    resourceScope: action.resourceScope,
    actionRequestId: request.requestId,
    metadata: context,
    ...(actor.principalId !== undefined ? { principalActorId: actor.principalId } : {}),
    ...(action.capability !== undefined ? { capability: action.capability } : {}),
    ...(action.riskLevel !== undefined ? { riskLevel: action.riskLevel } : {}),
    ...(action.sideEffectType !== undefined ? { sideEffectType: action.sideEffectType } : {}),
    ...(target?.id !== undefined ? { targetId: target.id } : {}),
    ...(targetType !== undefined ? { targetType } : {}),
    ...(target?.name !== undefined ? { targetName: target.name } : {}),
    ...(target?.adapterId !== undefined ? { adapterId: target.adapterId } : {}),
    ...(request.idempotencyKey !== undefined ? { idempotencyKey: request.idempotencyKey } : {}),
    ...(request.expiresAt !== undefined ? { expiresAt: request.expiresAt } : {}),
    ...(request.approvalProofId !== undefined ? { approvalProofId: request.approvalProofId } : {}),
    ...(request.approvalRequestId !== undefined ? { approvalRequestId: request.approvalRequestId } : {}),
    ...(request.approvalDecisionId !== undefined ? { approvalDecisionId: request.approvalDecisionId } : {}),
    ...(request.visaId !== undefined ? { visaId: request.visaId } : {}),
    ...(request.ingressGrantId !== undefined ? { ingressGrantId: request.ingressGrantId } : {}),
    ...(request.handshakeProofId !== undefined ? { handshakeProofId: request.handshakeProofId } : {}),
    ...(policyEvaluationInput !== undefined ? { policyEvaluationInput } : {}),
    ...(options?.dryRun === true ? { mode: 'dry_run' as const } : {}),
  };
}
