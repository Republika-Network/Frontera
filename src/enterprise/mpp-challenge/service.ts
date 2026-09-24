import { isCanonicalCustomerIdentifier } from '../customer-identity/identifiers.js';
import type { BoundCustomerIdentity } from '../customer-identity/index.js';
import type { GovernedActionMonetaryTrust } from '../governed-action/contracts.js';
import { validateGovernedActionIntent } from '../governed-action/intent.js';
import { boundScopeOf } from '../governed-action/kernel-request.js';
import type { GovernedActionOrchestrator } from '../governed-action/orchestrator.js';
import type { MppBusinessOperationInput, MppChallengeInstanceInput } from '../mpp-business-operation-store/contracts.js';
import { isMppBusinessOperationStoreError } from '../mpp-business-operation-store/errors.js';
import type { MppBusinessOperationWriter } from '../mpp-business-operation-store/operation-store.js';
import { computeMppBusinessSemanticDigest, computeMppChallengeDigest, deriveMppGovernedIdempotencyKey, deriveMppGovernedRequestId } from './business-identity.js';
import { normalizerKey, resolveMppCounterparty, runMethodNormalizer, selectMppChallenge, type MppChallengeComposition } from './composition.js';
import type { MppChallengePaymentResult, MppChallengePaymentService, MppChallengeRefusal, MppNormalizedCharge, ProtectedMppRequest, SupportedMppChallenge } from './contracts.js';
import {
  canonicalContentDigest,
  contentDigestsMatch,
  isMppChallengeUsableAt,
  mppChallengeFieldsOf,
  parseContentDigest,
  parsePaymentChallenge,
  parseWwwAuthenticate,
  type ParsedMppPaymentChallenge,
} from './protocol.js';

/**
 * P13 — the MPP challenge-payment service: the ingress transformation from a
 * merchant's 402 into one ordinary governed action.
 *
 * ## Order, and why
 *
 * ```
 * identity (trusted) + request (validated closed)
 *   → parse every WWW-Authenticate value              standards-correct, bounded
 *   → per Payment challenge: supported? realm? body digest? expiry?
 *       trusted normalizer → exact P9 amount
 *       trusted resolver   → Frontera counterparty
 *   → trusted selector                                exactly one, never first-wins
 *   → adapted GovernedActionIntent, validated by the SAME validator
 *   → business semantic digest; derived governed key and request id
 *   → store.record(operation + challenge)             ONE durable write, BEFORE governance
 *   → orchestrator.govern(identity, intent)           the existing spine, unchanged
 *   → requestId agreement check
 * ```
 *
 * Every refusal happens before `govern()`: no Kernel evaluation, no grant, no
 * P7 reservation, no claim, no adapter. A business operation that cannot be
 * made durable never reaches governance; a store that cannot prove its state
 * is refused, never read as "no previous operation".
 *
 * ## What is not here
 *
 * No network I/O, no credential, no signature, no provider call, no retry, no
 * outcome. A refreshed challenge is recorded as a new instance of the same
 * operation and resolves to the same governed request: whatever that request
 * already did — executed, failed, unconfirmed, resolved by P12 — is what it
 * replays. A payment that P12 proved did not complete is **not** retried: a
 * new purchase needs a new `businessOperationId`.
 */
export interface MppChallengePaymentServiceOptions {
  readonly orchestrator: Pick<GovernedActionOrchestrator, 'organizationId' | 'govern'>;
  readonly store: MppBusinessOperationWriter;
  readonly composition: MppChallengeComposition;
  /** The same P9 registry and classifier the orchestrator validates against. */
  readonly monetary: GovernedActionMonetaryTrust;
  readonly now: () => string;
}

const REQUEST_KEYS: ReadonlySet<string> = new Set(['businessOperationId', 'action', 'challenges', 'protectedRequest']);
const PROTECTED_KEYS: ReadonlySet<string> = new Set(['resource', 'httpMethod', 'expectedRealm', 'contentDigest']);
const HTTP_METHOD = /^[A-Z]{1,16}$/;
const BODY_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH']);

/** Own data properties of a plain object, or `undefined`. */
function plainData(raw: unknown, allowed: ReadonlySet<string>): Map<string, unknown> | undefined {
  try {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
    const prototype = Object.getPrototypeOf(raw) as unknown;
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const values = new Map<string, unknown>();
    for (const key of Reflect.ownKeys(raw)) {
      if (typeof key !== 'string' || !allowed.has(key)) return undefined;
      const descriptor = Object.getOwnPropertyDescriptor(raw, key);
      if (descriptor === undefined || !('value' in descriptor)) return undefined;
      values.set(key, descriptor.value);
    }
    return values;
  } catch {
    return undefined;
  }
}

interface ValidatedRequest {
  readonly businessOperationId: string;
  readonly action: string;
  readonly challenges: readonly string[];
  readonly protectedRequest: ProtectedMppRequest;
  /** The canonical spelling of `protectedRequest.contentDigest`, when present. */
  readonly canonicalContentDigest?: string;
  readonly bodyDigest?: ReadonlyMap<string, string>;
  readonly bodyBearing: boolean;
}

/** The request, validated closed and copied into fresh plain data; the caller's objects are never retained. */
function validateRequest(raw: unknown): ValidatedRequest | undefined {
  const values = plainData(raw, REQUEST_KEYS);
  if (values === undefined) return undefined;
  const businessOperationId = values.get('businessOperationId');
  const action = values.get('action');
  const rawChallenges = values.get('challenges');
  if (!isCanonicalCustomerIdentifier(businessOperationId) || !isCanonicalCustomerIdentifier(action)) return undefined;
  let challenges: string[];
  if (typeof rawChallenges === 'string') {
    challenges = [rawChallenges];
  } else if (Array.isArray(rawChallenges) && rawChallenges.length <= 16) {
    challenges = [];
    for (let index = 0; index < rawChallenges.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(rawChallenges, index);
      if (descriptor === undefined || !('value' in descriptor) || typeof descriptor.value !== 'string') return undefined;
      challenges.push(descriptor.value);
    }
  } else {
    return undefined;
  }
  const protectedValues = plainData(values.get('protectedRequest'), PROTECTED_KEYS);
  if (protectedValues === undefined) return undefined;
  const resource = protectedValues.get('resource');
  const httpMethod = protectedValues.get('httpMethod');
  const expectedRealm = protectedValues.get('expectedRealm');
  const contentDigest = protectedValues.get('contentDigest');
  if (!isCanonicalCustomerIdentifier(resource) || typeof httpMethod !== 'string' || !HTTP_METHOD.test(httpMethod)) return undefined;
  if (expectedRealm !== undefined && !isCanonicalCustomerIdentifier(expectedRealm)) return undefined;
  let bodyDigest: ReadonlyMap<string, string> | undefined;
  if (contentDigest !== undefined) {
    bodyDigest = parseContentDigest(contentDigest);
    if (bodyDigest === undefined) return undefined;
  }
  const bodyBearing = BODY_METHODS.has(httpMethod) || bodyDigest !== undefined;
  // A body-bearing request whose body the trusted layer did not digest cannot be bound. Refused.
  if (bodyBearing && bodyDigest === undefined) return undefined;
  const protectedRequest: ProtectedMppRequest = Object.freeze({
    resource,
    httpMethod,
    ...(expectedRealm !== undefined ? { expectedRealm } : {}),
    ...(contentDigest !== undefined ? { contentDigest: contentDigest as string } : {}),
  });
  return {
    businessOperationId,
    action,
    challenges: Object.freeze(challenges),
    protectedRequest,
    ...(bodyDigest !== undefined ? { canonicalContentDigest: canonicalContentDigest(bodyDigest), bodyDigest } : {}),
    bodyBearing,
  };
}

interface UsableChallenge {
  readonly challenge: ParsedMppPaymentChallenge;
  readonly charge: MppNormalizedCharge;
  readonly counterparty: string;
}

export function createMppChallengePaymentService(options: MppChallengePaymentServiceOptions): MppChallengePaymentService {
  const { orchestrator, store, composition, monetary, now } = options;

  const refused = (refusal: MppChallengeRefusal, businessOperationId?: string): MppChallengePaymentResult =>
    Object.freeze({ outcome: 'refused', refusal, ...(businessOperationId !== undefined ? { businessOperationId } : {}) });

  return Object.freeze({
    async prepareAndGovern(identity: BoundCustomerIdentity, rawRequest: unknown): Promise<MppChallengePaymentResult> {
      // Identity: trusted, read through the orchestrator's own reader, never widened.
      const scope = boundScopeOf(identity, orchestrator.organizationId);
      if (scope === undefined) return refused('identity-invalid');
      const request = validateRequest(rawRequest);
      if (request === undefined) return refused('request-invalid');
      const { businessOperationId, protectedRequest } = request;
      const observedAt = now();

      // Parse every challenge. A malformed field value refuses the whole set.
      const parsed = parseWwwAuthenticate(request.challenges);
      if (!parsed.valid) return refused('challenge-invalid', businessOperationId);
      const payment = parsed.challenges.filter((challenge) => challenge.scheme.toLowerCase() === 'payment');
      const wellFormed: ParsedMppPaymentChallenge[] = [];
      for (const raw of payment) {
        const challenge = parsePaymentChallenge(raw);
        if (challenge.valid) wellFormed.push(challenge.challenge);
      }
      if (wellFormed.length === 0) return refused('challenge-invalid', businessOperationId);

      // Only challenges a trusted normalizer composed for their exact method and intent.
      const supported = wellFormed.filter((challenge) => composition.normalizers.has(normalizerKey(challenge.method, challenge.intent)));
      if (supported.length === 0) return refused('challenge-unsupported', businessOperationId);

      const usable: UsableChallenge[] = [];
      const failures: MppChallengeRefusal[] = [];
      for (const challenge of supported) {
        if (protectedRequest.expectedRealm !== undefined && challenge.realm !== protectedRequest.expectedRealm) {
          failures.push('request-binding-mismatch');
          continue;
        }
        if (request.bodyBearing) {
          const challengeDigest = challenge.digest === undefined ? undefined : parseContentDigest(challenge.digest);
          if (challengeDigest === undefined || request.bodyDigest === undefined || !contentDigestsMatch(challengeDigest, request.bodyDigest)) {
            failures.push('request-binding-mismatch');
            continue;
          }
        } else if (challenge.digest !== undefined) {
          // A digest over a body this request does not carry binds nothing. Refused.
          failures.push('request-binding-mismatch');
          continue;
        }
        if (!isMppChallengeUsableAt(challenge, observedAt)) {
          failures.push('challenge-expired');
          continue;
        }
        const normalizer = composition.normalizers.get(normalizerKey(challenge.method, challenge.intent));
        const charge = normalizer === undefined ? undefined : runMethodNormalizer(normalizer, challenge, protectedRequest, monetary.assets);
        if (charge === undefined) {
          failures.push('normalization-failed');
          continue;
        }
        const counterparty = resolveMppCounterparty(composition, {
          organizationId: scope.organizationId,
          methodId: challenge.method,
          intent: 'charge',
          realm: challenge.realm,
          ...(charge.merchantReference !== undefined ? { merchantReference: charge.merchantReference } : {}),
          resource: protectedRequest.resource,
          httpMethod: protectedRequest.httpMethod,
        });
        if (counterparty === undefined) {
          failures.push('counterparty-unresolved');
          continue;
        }
        usable.push({ challenge, charge, counterparty });
      }
      if (usable.length === 0) {
        // Deterministic: the first supported challenge's reason, in received order.
        return refused(failures[0] ?? 'challenge-invalid', businessOperationId);
      }

      // Trusted selection — asked even for one candidate; no first-wins.
      const candidates: SupportedMppChallenge[] = usable.map(({ challenge, charge, counterparty }) =>
        Object.freeze({
          id: challenge.id,
          realm: challenge.realm,
          method: challenge.method,
          intent: 'charge' as const,
          ...(challenge.expires !== undefined ? { expires: challenge.expires } : {}),
          ...(challenge.header !== undefined ? { header: challenge.header } : {}),
          amount: charge.amount,
          counterparty,
        }),
      );
      const index = selectMppChallenge(composition, candidates, { organizationId: scope.organizationId, businessOperationId, resource: protectedRequest.resource, httpMethod: protectedRequest.httpMethod });
      const selected = index === undefined ? undefined : usable[index];
      if (selected === undefined) return refused('challenge-ambiguous', businessOperationId);

      // The adapted governed intent: ordinary fields only, no MPP vocabulary,
      // validated by the orchestrator's own validator before anything is stored.
      const operationScope = { organizationId: scope.organizationId, principalId: scope.principalId, businessOperationId };
      const idempotencyKey = deriveMppGovernedIdempotencyKey(operationScope);
      const requestId = deriveMppGovernedRequestId(operationScope);
      const intent = Object.freeze({
        action: request.action,
        resource: protectedRequest.resource,
        counterparty: selected.counterparty,
        amount: Object.freeze({ value: selected.charge.amount.value, currency: selected.charge.amount.unit }),
        idempotencyKey,
      });
      const validation = validateGovernedActionIntent(intent, monetary);
      if (!validation.valid || validation.intent.actionClass !== 'financial') return refused('governed-intent-invalid', businessOperationId);

      const semantics = {
        ...operationScope,
        action: request.action,
        resource: protectedRequest.resource,
        counterparty: selected.counterparty,
        amount: { value: selected.charge.amount.value, unit: selected.charge.amount.unit },
        intent: 'charge' as const,
        httpMethod: protectedRequest.httpMethod,
        ...(request.canonicalContentDigest !== undefined ? { contentDigest: request.canonicalContentDigest } : {}),
        ...(selected.charge.externalId !== undefined ? { externalId: selected.charge.externalId } : {}),
      };
      const businessSemanticDigest = computeMppBusinessSemanticDigest(semantics);
      const operation: MppBusinessOperationInput = { ...semantics, businessSemanticDigest, governedIdempotencyKey: idempotencyKey, governedRequestId: requestId, createdAt: observedAt };
      const fields = mppChallengeFieldsOf(selected.challenge);
      const challenge: MppChallengeInstanceInput = { ...operationScope, businessSemanticDigest, challengeDigest: computeMppChallengeDigest(fields), ...fields, observedAt };

      // Durable BEFORE governance. Nothing below runs unless this write is proven.
      let recorded;
      try {
        recorded = await store.record({ organizationId: scope.organizationId }, { operation, challenge });
      } catch (error) {
        if (isMppBusinessOperationStoreError(error) && error.code === 'MPP_BUSINESS_OPERATION_CONFLICT') return refused('business-operation-conflict', businessOperationId);
        if (isMppBusinessOperationStoreError(error) && error.code === 'MPP_BUSINESS_OPERATION_CHALLENGE_HISTORY_FULL') return refused('challenge-history-full', businessOperationId);
        return refused('store-unavailable', businessOperationId);
      }
      if (recorded.operation.governedRequestId !== requestId) return refused('store-unavailable', businessOperationId);

      // The existing authority spine: Kernel → committed decision → grant → P7 → claim → adapter.
      const result = await orchestrator.govern(identity, intent);
      if (result.requestId !== requestId) return Object.freeze({ outcome: 'inconsistent', businessOperationId, requestId, result });
      return Object.freeze({ outcome: 'governed', businessOperationId, requestId, operation: recorded.operationOutcome, challengeSequence: recorded.challenge.challengeSequence, result });
    },
  });
}
