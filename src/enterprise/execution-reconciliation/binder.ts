import type { ExecutionAttemptRecord } from '../execution-outcome-store/contracts.js';
import type { ExecutionResolutionPort } from '../execution-resolution-store/resolution-store.js';
import { selectResolutionAuthority, type ExecutionResolutionSelectionContext, type ResolutionAuthorityComposition } from './authority.js';

/**
 * P12 — the binding step of a new governed execution, between P11's
 * preparation and the write-ahead claim:
 *
 * ```
 * P11 prepare attempt  →  P12 bind resolution authority  →  claim  →  provider
 * ```
 *
 * When reconciliation is enabled, no provider effect runs unless Frontera
 * already durably knows which trusted authority may resolve it later. That is
 * what makes even "claim exists, no initial observation" reconcilable after a
 * crash **without guessing**: the authority is read from the binding, never
 * reconstructed from whatever routing or selection the configuration would
 * choose today.
 *
 * ## Fail closed, before the claim
 *
 * `bindBeforeClaim` resolves `true` only once a binding for **this** attempt
 * digest, naming a **composed** authority, is durable. Every other case —
 * the selector throws, answers something that is not a composed id, the
 * store cannot be read or written, a different binding already stands, or the
 * bound authority is no longer composed — resolves `false`, and the governed
 * action stops before the claim and before any provider. Nothing was claimed,
 * so the request stays safe to retry.
 *
 * ## A retry reuses its binding
 *
 * A request that crashed after binding and before claiming finds its own
 * binding on retry and uses it, whatever the selector would answer now; the
 * selector is consulted only when no binding exists. A binding is never
 * replaced.
 */
export interface ExecutionResolutionBinder {
  bindBeforeClaim(attempt: ExecutionAttemptRecord): Promise<boolean>;
}

export interface ExecutionResolutionBinderOptions {
  readonly store: Pick<ExecutionResolutionPort, 'read' | 'bind'>;
  readonly composition: ResolutionAuthorityComposition;
  readonly now: () => string;
}

/** The selector's context: the prepared attempt's trusted fields, copied field by field and frozen. */
export function selectionContextOf(attempt: ExecutionAttemptRecord): ExecutionResolutionSelectionContext {
  return Object.freeze({
    organizationId: attempt.organizationId,
    executionId: attempt.executionId,
    evaluationId: attempt.evaluationId,
    requestId: attempt.requestId,
    decisionId: attempt.decisionId,
    boundedGrantId: attempt.boundedGrantId,
    action: attempt.action,
    ...(attempt.amount !== undefined ? { amount: Object.freeze({ value: attempt.amount.value, unit: attempt.amount.unit }) } : {}),
  });
}

export function createExecutionResolutionBinder(options: ExecutionResolutionBinderOptions): ExecutionResolutionBinder {
  const { store, composition, now } = options;
  return Object.freeze({
    async bindBeforeClaim(attempt: ExecutionAttemptRecord): Promise<boolean> {
      const scope = { organizationId: attempt.organizationId };
      try {
        const existing = (await store.read(scope, attempt.executionId))?.binding;
        if (existing !== undefined) return existing.attemptDigest === attempt.attemptDigest && composition.authorities.has(existing.authorityId);
        const authorityId = selectResolutionAuthority(composition, selectionContextOf(attempt));
        if (authorityId === undefined) return false;
        const bound = await store.bind(scope, {
          organizationId: attempt.organizationId,
          executionId: attempt.executionId,
          attemptDigest: attempt.attemptDigest,
          authorityId,
          origin: 'pre-claim',
          boundAt: now(),
        });
        return bound.binding.attemptDigest === attempt.attemptDigest && bound.binding.authorityId === authorityId;
      } catch {
        return false;
      }
    },
  });
}
