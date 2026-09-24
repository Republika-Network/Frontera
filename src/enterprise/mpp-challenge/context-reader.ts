import type { MppGovernedRequestReader } from '../mpp-business-operation-store/operation-store.js';
import type { MppChallengeContextReader, VerifiedMppChallengeContext } from './contracts.js';
import { mppChallengeFieldsOf, mppCredentialHeaderField } from './protocol.js';

/**
 * P13 → P14: the narrow, read-only challenge-context port.
 *
 * ```
 * ValidatedExecutionAction.correlation.requestId    (trusted, from the grant path)
 *   → readByGovernedRequestId(organizationId, requestId)
 *   → the verified operation and its latest accepted challenge, exact
 * ```
 *
 * `ValidatedExecutionAction` is not widened: no challenge, payload or metadata
 * crosses the adapter boundary. A future payment adapter composed with this
 * reader looks the context up by the correlation it was already handed.
 *
 * The store verifies the operation, **every** challenge row, the semantic
 * digest, the derived governed key and request id, and each challenge digest
 * before any row's sequence can select it; corrupt state throws. Expiry is
 * deliberately not decided here: the challenge was usable when it was
 * accepted, and P14 re-checks `expires` against its own injected clock at the
 * moment it would build a credential.
 *
 * Returning a context is not authority: the only time a payment adapter runs
 * is after the Kernel, the bounded grant and P7 allowed and exercised the
 * action.
 */
export function createMppChallengeContextReader(store: MppGovernedRequestReader): MppChallengeContextReader {
  return Object.freeze({
    async readByGovernedRequestId(organizationId: string, requestId: string): Promise<VerifiedMppChallengeContext | undefined> {
      const state = await store.readByGovernedRequestId({ organizationId }, requestId);
      if (state === undefined) return undefined;
      const { operation, latestChallenge } = state;
      const challenge = mppChallengeFieldsOf(latestChallenge);
      return Object.freeze({
        organizationId: operation.organizationId,
        principalId: operation.principalId,
        businessOperationId: operation.businessOperationId,
        requestId: operation.governedRequestId,
        businessSemanticDigest: operation.businessSemanticDigest,
        terms: Object.freeze({
          action: operation.action,
          resource: operation.resource,
          counterparty: operation.counterparty,
          amount: Object.freeze({ value: operation.amount.value, unit: operation.amount.unit }),
          intent: operation.intent,
          httpMethod: operation.httpMethod,
          ...(operation.contentDigest !== undefined ? { contentDigest: operation.contentDigest } : {}),
          ...(operation.externalId !== undefined ? { externalId: operation.externalId } : {}),
        }),
        challenge,
        challengeSequence: latestChallenge.challengeSequence,
        challengeDigest: latestChallenge.challengeDigest,
        credentialHeaderField: mppCredentialHeaderField(challenge),
      });
    },
  });
}
