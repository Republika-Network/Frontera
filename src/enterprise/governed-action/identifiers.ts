import { createHash } from 'node:crypto';

/**
 * Every identity the governed-action path mints is derived here, on the
 * server, from values the caller cannot choose. None is accepted from intent.
 *
 * Each derivation hashes a JSON array rather than a delimited string, so no
 * pair of inputs can collide by moving a separator between them, and each is
 * domain-separated by a versioned tag so a request id can never equal an
 * execution id computed from the same inputs.
 */
function digest(parts: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify(parts), 'utf8').digest('hex').slice(0, 32);
}

/**
 * One logical governed-action request → one stable request id.
 *
 * Scoped by organization **and** principal: the same `idempotencyKey` used by
 * another principal, or by the same principal id in another organization, is a
 * different request. The actor is deliberately not an input — a principal is
 * bound to exactly one actor, and the persisted request's actor is compared on
 * every replay anyway.
 */
export function deriveGovernedActionRequestId(input: { readonly organizationId: string; readonly principalId: string; readonly idempotencyKey: string }): string {
  return `aoc.gar:${digest(['aoc.governed-action.request.v1', input.organizationId, input.principalId, input.idempotencyKey])}`;
}

/** The Governance Store idempotency scope for one principal. Distinct from the `org:` / `global` scopes the evaluate route uses, so the two paths can never share a claim. */
export function governedActionIdempotencyScope(input: { readonly organizationId: string; readonly principalId: string }): string {
  return `governed-action:${JSON.stringify([input.organizationId, input.principalId])}`;
}

/**
 * One committed decision → one execution identity.
 *
 * Derived from the request and the committed decision only — never from the
 * grant, whose id includes its expiry — so a retry that re-derives the same
 * decision re-derives the same execution id, and the write-ahead record below
 * refuses to run it twice.
 */
export function deriveGovernedActionExecutionId(input: { readonly requestId: string; readonly decisionId: string }): string {
  return `aoc.exec:${digest(['aoc.governed-action.execution.v1', input.requestId, input.decisionId])}`;
}

/** Deterministic reference ids. The Governance Store refuses a second append of one id, which is what turns these evidence rows into durable, at-most-once markers. */
export function authorizationReferenceId(input: { readonly evaluationId: string; readonly grantId: string }): string {
  return `aoc.gar.ref:${digest(['aoc.governed-action.authorization-ref.v1', input.evaluationId, input.grantId])}`;
}

export function executionAttemptReferenceId(executionId: string): string {
  return `aoc.gar.ref:${digest(['aoc.governed-action.execution-attempt-ref.v1', executionId])}`;
}

export function executionOutcomeReferenceId(executionId: string): string {
  return `aoc.gar.ref:${digest(['aoc.governed-action.execution-outcome-ref.v1', executionId])}`;
}
