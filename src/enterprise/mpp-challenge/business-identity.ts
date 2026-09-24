import { createHash } from 'node:crypto';

import { computeDigest } from '../governance-store/digest.js';
import { deriveGovernedActionRequestId } from '../governed-action/identifiers.js';
import type { MppChallengeFields } from './protocol.js';

/**
 * P13 — business-operation identity.
 *
 * ```
 * (organization, principal, businessOperationId)            the logical purchase
 *   → aoc.mpp.business-operation.v1 derivation              domain-separated, deterministic
 *   → GovernedActionIntent.idempotencyKey                   the existing technical key
 *   → deriveGovernedActionRequestId (the orchestrator's own) the existing request identity
 * ```
 *
 * Nothing here reads a clock, draws randomness or reads a challenge: the same
 * three inputs derive the same key and the same request id in every process,
 * after every restart. A challenge `id`, `expires` or `opaque` cannot reach
 * either derivation, so a refreshed challenge can never mint a second request.
 *
 * The request id is derived by **the same function** the Governed Action
 * Orchestrator calls — imported, not re-implemented — so P13's prediction and
 * the orchestrator's answer cannot differ for one operation.
 */

const BUSINESS_OPERATION_KEY_DOMAIN = 'aoc.mpp.business-operation.v1';
const BUSINESS_SEMANTICS_DOMAIN = 'aoc.mpp.business-semantics.v1';
const CHALLENGE_DOMAIN = 'aoc.mpp.challenge.v1';

/** Every P13-derived governed key starts with this. An ordinary caller's key collides with one only by presenting that exact 64-hex digest. */
export const MPP_GOVERNED_IDEMPOTENCY_KEY_PREFIX = 'aoc.mpp.bop:';

export interface MppBusinessOperationScope {
  readonly organizationId: string;
  readonly principalId: string;
  readonly businessOperationId: string;
}

/**
 * The governed-action idempotency key for one business operation. A JSON
 * array under a versioned domain tag, hashed, so no pair of inputs can collide
 * by moving a separator, and no raw business identifier ever becomes a
 * governed key an ordinary caller would plausibly choose.
 */
export function deriveMppGovernedIdempotencyKey(scope: MppBusinessOperationScope): string {
  const hex = createHash('sha256').update(JSON.stringify([BUSINESS_OPERATION_KEY_DOMAIN, scope.organizationId, scope.principalId, scope.businessOperationId]), 'utf8').digest('hex');
  return `${MPP_GOVERNED_IDEMPOTENCY_KEY_PREFIX}${hex}`;
}

/** The governed request id the orchestrator will derive for this operation. */
export function deriveMppGovernedRequestId(scope: MppBusinessOperationScope): string {
  return deriveGovernedActionRequestId({ organizationId: scope.organizationId, principalId: scope.principalId, idempotencyKey: deriveMppGovernedIdempotencyKey(scope) });
}

/**
 * The stable business meaning of one operation — what "the same purchase"
 * means. Included:
 *
 * - the scope (organization, principal, businessOperationId);
 * - the governed `action`, the Frontera `resource` (a trusted mapping) and the
 *   `counterparty` (a trusted mapping — never a raw recipient or realm);
 * - the exact P9 amount: canonical decimal text and asset identifier;
 * - the MPP intent (`charge`);
 * - the protected request's HTTP method and, for a request with a body, the
 *   canonical RFC 9530 digest of that body;
 * - `externalId`, when the trusted method normalizer states one.
 *
 * Deliberately **excluded**: the challenge `id`, `expires`, `opaque`,
 * `description`, `header`, `realm`, the payment `method` and the method's raw
 * recipient. A refreshed challenge, another rail with identical terms, or a
 * server moving its credential header changes none of them.
 */
export interface MppBusinessSemantics extends MppBusinessOperationScope {
  readonly action: string;
  readonly resource: string;
  readonly counterparty: string;
  readonly amount: { readonly value: string; readonly unit: string };
  readonly intent: 'charge';
  readonly httpMethod: string;
  readonly contentDigest?: string;
  readonly externalId?: string;
}

export function computeMppBusinessSemanticDigest(semantics: MppBusinessSemantics): string {
  return computeDigest({
    domain: BUSINESS_SEMANTICS_DOMAIN,
    organizationId: semantics.organizationId,
    principalId: semantics.principalId,
    businessOperationId: semantics.businessOperationId,
    action: semantics.action,
    resource: semantics.resource,
    counterparty: semantics.counterparty,
    amount: { value: semantics.amount.value, unit: semantics.amount.unit },
    intent: semantics.intent,
    httpMethod: semantics.httpMethod,
    contentDigest: semantics.contentDigest ?? null,
    externalId: semantics.externalId ?? null,
  });
}

/**
 * The digest of one challenge instance over its security-significant fields —
 * the ones a server binds and a credential echoes. `description` is not one of
 * them: it is display-only by the draft.
 */
export function computeMppChallengeDigest(challenge: MppChallengeFields): string {
  return computeDigest({
    domain: CHALLENGE_DOMAIN,
    id: challenge.id,
    realm: challenge.realm,
    method: challenge.method,
    intent: challenge.intent,
    request: challenge.request,
    expires: challenge.expires ?? null,
    digest: challenge.digest ?? null,
    opaque: challenge.opaque ?? null,
    header: challenge.header ?? null,
  });
}
