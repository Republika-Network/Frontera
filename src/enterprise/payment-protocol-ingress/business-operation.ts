import { createHash } from 'node:crypto';

import { computeDigest } from '../governance-store/digest.js';
import { deriveGovernedActionRequestId } from '../governed-action/identifiers.js';

/**
 * PAY-04 — business-operation identity.
 *
 * ```
 * (organization, principal, businessOperationId)                   the logical purchase
 *   → aoc.payment.business-operation.v1 derivation                 domain-separated, deterministic
 *   → PaymentIntent.idempotencyKey                                 PAY-01's own field
 *   → compilePaymentIntent → GovernedActionIntent.idempotencyKey   the envelope's technical key
 *   → deriveGovernedActionRequestId (the orchestrator's own)       the governed request identity
 * ```
 *
 * Nothing here reads a clock, draws randomness, reads a store or reads a
 * challenge: the same three inputs derive the same key and the same request id
 * in every process, after every restart, **and after any loss or rollback of
 * the business-operation store**. A challenge id, expiry or opaque state
 * cannot reach either derivation, so a refreshed challenge can never mint a
 * second governed request; the Governance Store's existing idempotency is the
 * barrier that turns a second presentation into a replay (same payment) or a
 * conflict (different payment) before the Kernel.
 *
 * Challenge identity is not business identity; request idempotency is not
 * business-operation idempotency — the first is derived from the second here,
 * once, and never the other way round.
 */

const BUSINESS_OPERATION_KEY_DOMAIN = 'aoc.payment.business-operation.v1';
const BUSINESS_SEMANTICS_DOMAIN = 'aoc.payment.business-semantics.v1';
const CHALLENGE_DOMAIN = 'aoc.payment.protocol-challenge.v1';
const CHALLENGE_IDENTITY_DOMAIN = 'aoc.payment.protocol-challenge-identity.v1';

/** Every derived governed key starts with this. An ordinary caller's key collides with one only by presenting that exact 64-hex digest — and then under its own principal only. */
export const PAYMENT_BUSINESS_OPERATION_KEY_PREFIX = 'aoc.pay.bop:';

export interface PaymentBusinessOperationScope {
  readonly organizationId: string;
  readonly principalId: string;
  readonly businessOperationId: string;
}

/**
 * The governed idempotency key for one business operation: a JSON array under
 * a versioned domain tag, hashed, so no pair of inputs can collide by moving a
 * separator, and no raw business identifier ever becomes a governed key an
 * ordinary caller would plausibly choose.
 */
export function derivePaymentBusinessOperationKey(scope: PaymentBusinessOperationScope): string {
  const hex = createHash('sha256').update(JSON.stringify([BUSINESS_OPERATION_KEY_DOMAIN, scope.organizationId, scope.principalId, scope.businessOperationId]), 'utf8').digest('hex');
  return `${PAYMENT_BUSINESS_OPERATION_KEY_PREFIX}${hex}`;
}

/** The governed request id the orchestrator will derive for this operation — by **its own** function, imported, so the two cannot disagree. */
export function derivePaymentBusinessOperationRequestId(scope: PaymentBusinessOperationScope): string {
  return deriveGovernedActionRequestId({ organizationId: scope.organizationId, principalId: scope.principalId, idempotencyKey: derivePaymentBusinessOperationKey(scope) });
}

/**
 * The stable business meaning of one operation — what "the same purchase"
 * means: the governed action, and every field of the canonical
 * `PaymentIntent` except its derived idempotency key and its correlation id,
 * plus the protected request the payment is bound to.
 *
 * Deliberately **excluded**: the protocol, the challenge's identity, expiry,
 * opaque state, protection space and method — a refreshed challenge, another
 * protocol or method with identical terms, or a server moving its credential
 * header changes none of them.
 */
export interface PaymentBusinessTerms {
  readonly action: string;
  readonly source: { readonly accountId: string };
  readonly destination: { readonly kind: string; readonly reference: string };
  readonly amount: { readonly value: string; readonly unit: string };
  readonly purpose: string;
  readonly reference?: string;
  readonly rail?: string;
  readonly binding: {
    readonly target: string;
    readonly method: string;
    /** Canonical RFC 9530 digest of the protected request body, when it has one. */
    readonly contentDigest?: string;
  };
}

export function computePaymentBusinessSemanticDigest(scope: PaymentBusinessOperationScope, terms: PaymentBusinessTerms): string {
  return computeDigest({
    domain: BUSINESS_SEMANTICS_DOMAIN,
    organizationId: scope.organizationId,
    principalId: scope.principalId,
    businessOperationId: scope.businessOperationId,
    action: terms.action,
    source: { accountId: terms.source.accountId },
    destination: { kind: terms.destination.kind, reference: terms.destination.reference },
    amount: { value: terms.amount.value, unit: terms.amount.unit },
    purpose: terms.purpose,
    reference: terms.reference ?? null,
    rail: terms.rail ?? null,
    binding: { target: terms.binding.target, method: terms.binding.method, contentDigest: terms.binding.contentDigest ?? null },
  });
}

/** One challenge instance's evidence: the protocol, its identity within the protocol, and its exact accepted fields. */
export interface PaymentChallengeEvidence {
  readonly protocolId: string;
  readonly key: string;
  readonly fields: Readonly<Record<string, string>>;
}

/** The digest of one challenge instance over everything recorded of it. Two presentations with the same digest are the same challenge. */
export function computePaymentChallengeDigest(evidence: PaymentChallengeEvidence): string {
  const fields: Record<string, string> = {};
  for (const name of Object.keys(evidence.fields).sort()) fields[name] = evidence.fields[name] as string;
  return computeDigest({ domain: CHALLENGE_DOMAIN, protocolId: evidence.protocolId, key: evidence.key, fields });
}

/**
 * A challenge's identity across the organization: its protocol and its
 * protocol-level key (for an HTTP authentication protocol, its protection
 * space and server-bound id). One identity may belong to **one** business
 * operation and denote **one** challenge — so a challenge captured for one
 * purchase can never be presented for another.
 */
export function computePaymentChallengeIdentity(evidence: { readonly protocolId: string; readonly key: string }): string {
  return computeDigest({ domain: CHALLENGE_IDENTITY_DOMAIN, protocolId: evidence.protocolId, key: evidence.key });
}
