import type { PaymentProtocolContextReader, VerifiedPaymentProtocolContext } from './contracts.js';
import type { PaymentGovernedRequestReader } from './store-contracts.js';

/**
 * PAY-04 — the read-only handoff: given the trusted governed request id an
 * execution carries (`ValidatedExecutionAction.correlation.requestId`), the
 * verified business operation and its latest accepted challenge.
 *
 * `ValidatedExecutionAction` is **not** widened, and nothing in PAY-04 reads
 * this to execute: it exists so that later protocol work (constructing the
 * protocol's proof of payment for the merchant) reads the exact challenge
 * through the trusted correlation it is already handed. Lookup by a caller- or
 * adapter-supplied challenge id does not exist. Reading a context is not
 * authority.
 */
export function createPaymentProtocolContextReader(store: PaymentGovernedRequestReader): PaymentProtocolContextReader {
  if (store === null || typeof store !== 'object' || typeof store.readByGovernedRequestId !== 'function') throw new TypeError('A business-operation store reader is required.');
  return Object.freeze({
    async readByGovernedRequestId(organizationId: string, requestId: string): Promise<VerifiedPaymentProtocolContext | undefined> {
      const state = await store.readByGovernedRequestId({ organizationId }, requestId);
      if (state === undefined) return undefined;
      const { operation, latestChallenge } = state;
      return Object.freeze({
        organizationId: operation.organizationId,
        principalId: operation.principalId,
        businessOperationId: operation.businessOperationId,
        requestId: operation.governedRequestId,
        businessSemanticDigest: operation.businessSemanticDigest,
        terms: operation.terms,
        challenge: Object.freeze({
          protocolId: latestChallenge.protocolId,
          key: latestChallenge.challengeKey,
          fields: latestChallenge.fields,
          sequence: latestChallenge.challengeSequence,
          digest: latestChallenge.challengeDigest,
        }),
      });
    },
  });
}
