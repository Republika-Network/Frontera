import { computePaymentBusinessSemanticDigest, computePaymentChallengeDigest, computePaymentChallengeIdentity, derivePaymentBusinessOperationKey, derivePaymentBusinessOperationRequestId, type PaymentBusinessTerms } from '../payment-protocol-ingress/business-operation.js';
import type { RecordPaymentChallengeInput } from '../payment-protocol-ingress/store-contracts.js';

/**
 * PAY-04 test support: well-formed business-operation store entries built
 * exactly as the ingress builds them — every digest and derivation computed by
 * the production functions, never hand-written.
 */

export const STORE_ORG = 'org-a';
export const STORE_PRINCIPAL = 'principal-a';

export interface StoreTerms {
  readonly businessOperationId?: string;
  readonly principalId?: string;
  readonly organizationId?: string;
  readonly value?: string;
  readonly unit?: string;
  readonly destination?: string;
  readonly target?: string;
  readonly contentDigest?: string;
}

export interface StoreChallenge {
  readonly id?: string;
  readonly realm?: string;
  readonly expires?: string;
  readonly protocolId?: string;
  readonly observedAt?: string;
}

export function storeTerms(terms: StoreTerms = {}): PaymentBusinessTerms {
  return {
    action: 'payment.execute',
    source: { accountId: 'treasury-ops' },
    destination: { kind: 'account', reference: terms.destination ?? 'vendor-4471' },
    amount: { value: terms.value ?? '10', unit: terms.unit ?? 'USD' },
    purpose: 'purchase',
    reference: 'ORD-1',
    binding: { target: terms.target ?? 'merchant:report-42', method: terms.contentDigest === undefined ? 'GET' : 'POST', ...(terms.contentDigest !== undefined ? { contentDigest: terms.contentDigest } : {}) },
  };
}

export function storeEntry(terms: StoreTerms = {}, challenge: StoreChallenge = {}): RecordPaymentChallengeInput {
  const scope = { organizationId: terms.organizationId ?? STORE_ORG, principalId: terms.principalId ?? STORE_PRINCIPAL, businessOperationId: terms.businessOperationId ?? 'bop-1' };
  const businessTerms = storeTerms(terms);
  const businessSemanticDigest = computePaymentBusinessSemanticDigest(scope, businessTerms);
  const fields: Record<string, string> = { id: challenge.id ?? 'ch-1', intent: 'charge', method: 'testpay', realm: challenge.realm ?? 'api.merchant.example', request: 'eyJhbW91bnQiOiIxMDAwIn0' };
  if (challenge.expires !== undefined) fields['expires'] = challenge.expires;
  const evidence = { protocolId: challenge.protocolId ?? 'mpp', key: JSON.stringify([fields['realm'], fields['id']]), fields };
  const at = challenge.observedAt ?? '2026-09-24T12:00:00.000Z';
  return {
    operation: {
      ...scope,
      businessSemanticDigest,
      terms: businessTerms,
      governedIdempotencyKey: derivePaymentBusinessOperationKey(scope),
      governedRequestId: derivePaymentBusinessOperationRequestId(scope),
      createdAt: at,
    },
    challenge: {
      ...scope,
      businessSemanticDigest,
      protocolId: evidence.protocolId,
      challengeKey: evidence.key,
      challengeIdentity: computePaymentChallengeIdentity(evidence),
      challengeDigest: computePaymentChallengeDigest(evidence),
      fields,
      observedAt: at,
    },
  };
}
