import type { KernelEvaluationRequest } from '../../kernel/index.js';
import type { BoundCustomerIdentity } from '../customer-identity/index.js';
import { isCanonicalCustomerIdentifier } from '../customer-identity/index.js';
import type { ClassifiedGovernedActionIntent } from './contracts.js';

/**
 * The identity → Kernel-request trust boundary.
 *
 * Actor and organization cross it from a `BoundCustomerIdentity` and from
 * nowhere else; the intent contributes only the axes it declares. Nothing in
 * this file reads any other property of either object.
 */
export interface BoundActorScope {
  readonly organizationId: string;
  readonly principalId: string;
  readonly actorId: string;
}

/**
 * Reads only the fields the orchestrator needs, and only if they are what a
 * bound customer identity must be. Nothing else on the object is read — a
 * `system: true` or `actorId` attached anywhere else is invisible here.
 */
export function boundScopeOf(identity: BoundCustomerIdentity, servedOrganizationId: string): BoundActorScope | undefined {
  const principal = (identity as { readonly principal?: unknown } | null | undefined)?.principal as Record<string, unknown> | undefined;
  const actor = (identity as { readonly actor?: unknown } | null | undefined)?.actor as Record<string, unknown> | undefined;
  if (principal === undefined || principal === null || typeof principal !== 'object') return undefined;
  if (actor === undefined || actor === null || typeof actor !== 'object') return undefined;
  const { plane, principalId, organizationId } = principal;
  const { actorId } = actor;
  if (plane !== 'customer') return undefined;
  if (!isCanonicalCustomerIdentifier(principalId) || !isCanonicalCustomerIdentifier(organizationId) || !isCanonicalCustomerIdentifier(actorId)) return undefined;
  if (organizationId !== servedOrganizationId) return undefined;
  return { organizationId, principalId, actorId };
}

/** The Kernel request, built on the server from the bound scope, the host's trust domain and the validated intent. */
export function buildGovernedActionKernelRequest(input: {
  readonly scope: BoundActorScope;
  readonly intent: ClassifiedGovernedActionIntent;
  readonly trustDomainId: string;
  readonly requestId: string;
  readonly requestedAt: string;
}): KernelEvaluationRequest {
  const { scope, intent } = input;
  return {
    requestId: input.requestId,
    actor: { id: scope.actorId, trustDomainId: input.trustDomainId },
    organization: { id: scope.organizationId },
    action: {
      type: intent.action,
      resourceScope: intent.resource,
      ...(intent.counterparty !== undefined ? { counterpartyId: intent.counterparty } : {}),
      // Canonical decimal text and asset, exactly as the monetary boundary produced them.
      ...(intent.amount !== undefined ? { amount: intent.amount.value, currency: intent.amount.unit } : {}),
    },
    ...(intent.assertedContext !== undefined ? { context: intent.assertedContext } : {}),
    requestedAt: input.requestedAt,
    ...(intent.correlationId !== undefined ? { correlationId: intent.correlationId } : {}),
  };
}
