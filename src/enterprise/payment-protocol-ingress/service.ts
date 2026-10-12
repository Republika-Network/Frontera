import {
  PAYMENT_PROTOCOL_RESERVED_CONTEXT_KEYS,
  PaymentConfigurationError,
  compilePaymentIntent,
  isPaymentEnvelopeIdentifier,
  isPaymentProtocolId,
  isPaymentProtocolReservedContextKey,
  isPaymentPurpose,
  isPaymentReference,
  paymentIntentOfProtocolTerms,
  readPaymentProtectedRequest,
  readPaymentProtocolInterpretation,
  type PaymentEnvelopeOptions,
  type PaymentGovernanceBinding,
  type PaymentGovernedActionIntent,
  type PaymentIntent,
  type PaymentProtectedRequestBinding,
  type PaymentProtocolAdapter,
  type PaymentProtocolInterpretation,
  type PaymentPurpose,
} from '../../features/payment-runtime/index.js';
import { isAuthorityStateFreshnessError } from '../authority-state-freshness/errors.js';
import { freshnessBoundaryOf } from '../authority-state-freshness/session.js';
import type { BoundCustomerIdentity } from '../customer-identity/index.js';
import type { GovernanceProfileRegistry } from '../governance-profile/index.js';
import type { GovernedActionMonetaryTrust } from '../governed-action/contracts.js';
import { validateGovernedActionIntent } from '../governed-action/intent.js';
import { boundScopeOf } from '../governed-action/kernel-request.js';
import type { GovernedActionOrchestrator } from '../governed-action/orchestrator.js';
import {
  computePaymentBusinessSemanticDigest,
  computePaymentChallengeDigest,
  computePaymentChallengeIdentity,
  derivePaymentBusinessOperationKey,
  derivePaymentBusinessOperationRequestId,
  type PaymentBusinessTerms,
} from './business-operation.js';
import type { PaymentProtocolIngress, PaymentProtocolIngressRefusal, PaymentProtocolIngressResult } from './contracts.js';
import { isVolatilePaymentBusinessOperationStore } from './in-memory-payment-business-operation-store.js';
import type { PaymentBusinessOperationWriter, RecordPaymentChallengeResult } from './store-contracts.js';
import { isPaymentBusinessOperationStoreError } from './store-errors.js';
import { isCanonicalPaymentInstant } from './store-integrity.js';

/**
 * PAY-04 — the payment protocol ingress: the protocol-neutral transformation
 * from a merchant's payment challenge into one ordinary governed payment.
 *
 * ## Order, and why
 *
 * ```
 * identity (trusted) + request (validated closed)
 *   → protected request, validated and canonicalized      trusted network layer's description
 *   → adapter.interpret (fenced, re-read closed)          normalize + bind; never authority
 *   → derived governed key = H(org, principal, businessOperationId)
 *   → canonical PaymentIntent (PAY-01 validator)          no second payment model
 *   → compilePaymentIntent (PAY-01 compiler)              the envelope, unchanged
 *   → validated by the orchestrator's own validator       P9 financial + CORE-03 profile
 *   → business operation + challenge, ONE durable write   BEFORE governance — and, for the durable
 *                                                          store, compared with and anchored at the
 *                                                          CORE-07 witness before it resolves
 *   → orchestrator.govern(identity, compiled)             the existing spine
 *   → requestId agreement
 * ```
 *
 * Every refusal happens before `govern()`: no Kernel evaluation, no grant, no
 * P7 reservation, no claim, no adapter, no rail. A business operation that
 * cannot be made durable never reaches governance, and neither does one whose
 * store cannot prove its history current (`store-freshness-unverified`).
 *
 * ## Challenge ownership survives rollback (PAY-04 post-merge hardening)
 *
 * The derived governed key protects one business operation across any loss
 * of the store. It cannot protect a challenge already paid for from being
 * presented under a **new** `businessOperationId` — a different key, a
 * different governed request. Only the store's one-operation-per-challenge
 * record can, so the ingress composes only a store whose history is anchored
 * at the CORE-07 witness (or the volatile test store, which says it is one):
 * a durable store without a witness is a composition error.
 *
 * ## Refresh is not retry
 *
 * A refreshed challenge for the same operation and the same terms derives the
 * same governed key and compiles to the same governed intent, so the
 * Governance Store **replays** whatever the original request already did —
 * executed, failed, withheld, unconfirmed, resolved by P12. Nothing here asks
 * for a second execution, and nothing can: the write-ahead claim and P11 own
 * at-most-once. A payment P12 proved did not complete is **not** retried; a
 * new purchase needs a new `businessOperationId`.
 */
export interface PaymentProtocolIngressOptions {
  readonly orchestrator: Pick<GovernedActionOrchestrator, 'organizationId' | 'govern'>;
  /** The durable store composed under its CORE-07 freshness boundary (`createSqlitePaymentBusinessOperationStore(path, { freshness })`), or the volatile test store. Anything else is refused. */
  readonly store: PaymentBusinessOperationWriter;
  /** The trusted protocol adapters, snapshotted once by `protocolId`. */
  readonly adapters: readonly PaymentProtocolAdapter[];
  /** Which governed action is a payment in this deployment (PAY-01). */
  readonly binding: PaymentGovernanceBinding;
  /** The same P9 registry and classifier the orchestrator validates against. */
  readonly monetary: GovernedActionMonetaryTrust;
  /** The same CORE-03 registry the orchestrator validates against. It must reserve every protocol word (L-7). */
  readonly governance: GovernanceProfileRegistry;
  readonly now: () => string;
}

export class PaymentProtocolIngressConfigurationError extends Error {
  readonly code = 'PAYMENT_PROTOCOL_INGRESS_CONFIGURATION_INVALID' as const;

  constructor(message: string) {
    super(message);
    this.name = 'PaymentProtocolIngressConfigurationError';
  }
}

const REQUEST_KEYS: readonly string[] = ['businessOperationId', 'protocol', 'challenges', 'protectedRequest', 'payment', 'envelope'];
const PAYMENT_KEYS: readonly string[] = ['source', 'purpose', 'correlationId'];
const SOURCE_KEYS: readonly string[] = ['accountId'];

/** Own data properties of a plain object, each read once; `undefined` for anything else. Total. */
function plainData(raw: unknown, allowed: readonly string[]): Map<string, unknown> | undefined {
  try {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
    const prototype = Object.getPrototypeOf(raw) as unknown;
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const values = new Map<string, unknown>();
    for (const key of Reflect.ownKeys(raw)) {
      if (typeof key !== 'string' || !allowed.includes(key)) return undefined;
      const descriptor = Object.getOwnPropertyDescriptor(raw, key);
      if (descriptor === undefined || !('value' in descriptor)) return undefined;
      values.set(key, descriptor.value as unknown);
    }
    return values;
  } catch {
    return undefined;
  }
}

interface ValidatedRequest {
  readonly businessOperationId: string;
  readonly protocol: string;
  readonly challenges: unknown;
  readonly protectedRequest: PaymentProtectedRequestBinding;
  readonly source: { readonly accountId: string };
  readonly purpose: PaymentPurpose;
  readonly correlationId?: string;
  readonly envelope?: unknown;
}

/** The request, validated closed and copied once; the caller's objects are never re-read. */
function validateRequest(raw: unknown): ValidatedRequest | undefined {
  const values = plainData(raw, REQUEST_KEYS);
  if (values === undefined) return undefined;
  const businessOperationId = values.get('businessOperationId');
  const protocol = values.get('protocol');
  if (!isPaymentEnvelopeIdentifier(businessOperationId) || !isPaymentProtocolId(protocol) || !values.has('challenges')) return undefined;
  const protectedRequest = readPaymentProtectedRequest(values.get('protectedRequest'));
  if (protectedRequest === undefined) return undefined;
  const payment = plainData(values.get('payment'), PAYMENT_KEYS);
  if (payment === undefined) return undefined;
  const source = plainData(payment.get('source'), SOURCE_KEYS);
  const accountId = source?.get('accountId');
  const purpose = payment.get('purpose');
  const correlationId = payment.get('correlationId');
  if (!isPaymentReference(accountId) || !isPaymentPurpose(purpose)) return undefined;
  if (correlationId !== undefined && !isPaymentEnvelopeIdentifier(correlationId)) return undefined;
  return {
    businessOperationId,
    protocol,
    challenges: values.get('challenges'),
    protectedRequest,
    source: Object.freeze({ accountId }),
    purpose,
    ...(correlationId !== undefined ? { correlationId: correlationId as string } : {}),
    ...(values.get('envelope') !== undefined ? { envelope: values.get('envelope') } : {}),
  };
}

/**
 * Validates and snapshots the adapters once, at composition. A duplicate
 * protocol, a malformed reserved key, or a governance registry that does not
 * reserve every protocol word is a composition error — never a weaker mode.
 */
function snapshotAdapters(adapters: unknown, governance: GovernanceProfileRegistry): ReadonlyMap<string, PaymentProtocolAdapter> {
  if (!Array.isArray(adapters) || adapters.length === 0) throw new PaymentProtocolIngressConfigurationError('adapters must be a non-empty array of payment protocol adapters.');
  const composed = new Map<string, PaymentProtocolAdapter>();
  const required = new Set<string>(PAYMENT_PROTOCOL_RESERVED_CONTEXT_KEYS);
  for (const [index, candidate] of [...(adapters as unknown[])].entries()) {
    if (candidate === null || typeof candidate !== 'object') throw new PaymentProtocolIngressConfigurationError(`adapters[${String(index)}] is not an object.`);
    const protocolId: unknown = (candidate as { readonly protocolId?: unknown }).protocolId;
    const reserved: unknown = (candidate as { readonly reservedContextKeys?: unknown }).reservedContextKeys;
    const interpret: unknown = (candidate as { readonly interpret?: unknown }).interpret;
    if (!isPaymentProtocolId(protocolId)) throw new PaymentProtocolIngressConfigurationError(`adapters[${String(index)}].protocolId is not a protocol id.`);
    if (composed.has(protocolId)) throw new PaymentProtocolIngressConfigurationError(`adapters declares '${protocolId}' more than once.`);
    if (typeof interpret !== 'function') throw new PaymentProtocolIngressConfigurationError(`adapters[${String(index)}].interpret is not a function.`);
    if (!Array.isArray(reserved) || !(reserved as unknown[]).every((key) => isPaymentProtocolReservedContextKey(key))) throw new PaymentProtocolIngressConfigurationError(`adapters[${String(index)}].reservedContextKeys is malformed.`);
    for (const key of reserved as string[]) required.add(key);
    const keys = Object.freeze([...(reserved as string[])]);
    composed.set(
      protocolId,
      Object.freeze({
        protocolId,
        reservedContextKeys: keys,
        interpret: (challenges: unknown, context: Parameters<PaymentProtocolAdapter['interpret']>[1]): PaymentProtocolInterpretation => (interpret as PaymentProtocolAdapter['interpret']).call(candidate, challenges, context),
      }),
    );
  }
  const missing = [...required].filter((key) => governance.reservesContextKey(key) !== true);
  if (missing.length > 0) {
    throw new PaymentProtocolIngressConfigurationError(`The Governance Profile registry must reserve every payment protocol word in asserted context (reservedContextKeys, L-7); missing: ${missing.sort().join(', ')}.`);
  }
  return composed;
}

export function createPaymentProtocolIngress(options: PaymentProtocolIngressOptions): PaymentProtocolIngress {
  const { orchestrator, store, monetary, governance, now } = options;
  if (orchestrator === null || typeof orchestrator !== 'object' || typeof orchestrator.govern !== 'function') throw new PaymentProtocolIngressConfigurationError('A governed-action orchestrator is required.');
  if (store === null || typeof store !== 'object' || typeof store.record !== 'function') throw new PaymentProtocolIngressConfigurationError('A business-operation store is required.');
  const freshnessBoundary = freshnessBoundaryOf(store);
  if (freshnessBoundary === undefined && !isVolatilePaymentBusinessOperationStore(store)) {
    throw new PaymentProtocolIngressConfigurationError(
      'The business-operation store must be anchored at the CORE-07 freshness witness (createSqlitePaymentBusinessOperationStore with `freshness`): without it, a stale restore or a lost store makes a challenge already paid for payable again under a new businessOperationId.',
    );
  }
  if (freshnessBoundary !== undefined && freshnessBoundary.organizationId !== orchestrator.organizationId) {
    throw new PaymentProtocolIngressConfigurationError('The business-operation store is anchored for another organization than the orchestrator serves.');
  }
  if (typeof now !== 'function') throw new PaymentProtocolIngressConfigurationError('A clock is required.');
  if (monetary === null || typeof monetary !== 'object' || typeof monetary.actionClassifier?.classify !== 'function') throw new PaymentProtocolIngressConfigurationError('The P9 monetary trust is required.');
  if (governance === null || typeof governance !== 'object' || typeof governance.reservesContextKey !== 'function') throw new PaymentProtocolIngressConfigurationError('The CORE-03 Governance Profile registry is required.');
  const action: unknown = options.binding?.action;
  if (!isPaymentEnvelopeIdentifier(action)) throw new PaymentConfigurationError('The payment governance binding is not canonical.');
  if (monetary.actionClassifier.classify(action) !== 'financial') throw new PaymentProtocolIngressConfigurationError('The payment action must be classified financial by the P9 classifier.');
  const binding: PaymentGovernanceBinding = Object.freeze({ action });
  const adapters = snapshotAdapters(options.adapters, governance);
  const servedOrganizationId = orchestrator.organizationId;

  const refused = (refusal: PaymentProtocolIngressRefusal, businessOperationId?: string): PaymentProtocolIngressResult =>
    Object.freeze({ outcome: 'refused', refusal, ...(businessOperationId !== undefined ? { businessOperationId } : {}) });

  return Object.freeze({
    protocols: Object.freeze([...adapters.keys()].sort()),

    async prepareAndGovern(identity: BoundCustomerIdentity, rawRequest: unknown): Promise<PaymentProtocolIngressResult> {
      // Identity: trusted, read through the orchestrator's own reader, never widened.
      const scope = boundScopeOf(identity, servedOrganizationId);
      if (scope === undefined) return refused('identity-invalid');
      const request = validateRequest(rawRequest);
      if (request === undefined) return refused('request-invalid');
      const { businessOperationId, protectedRequest } = request;
      const adapter = adapters.get(request.protocol);
      if (adapter === undefined) return refused('protocol-unsupported', businessOperationId);

      const observedAt = now();
      const instant = isCanonicalPaymentInstant(observedAt) ? Date.parse(observedAt) : Number.NaN;
      if (!Number.isSafeInteger(instant)) return refused('clock-unavailable', businessOperationId);

      // The adapter: normalize and bind. Its answer is untrusted executable output.
      let raw: unknown;
      try {
        raw = adapter.interpret(request.challenges, Object.freeze({ organizationId: scope.organizationId, businessOperationId, protectedRequest, observedAtEpochMilliseconds: instant }));
      } catch {
        raw = undefined;
      }
      const interpretation = readPaymentProtocolInterpretation(raw, monetary);
      if (interpretation === undefined) return refused('challenge-invalid', businessOperationId);
      if (!interpretation.interpreted) return refused(interpretation.refusal, businessOperationId);
      const { terms, challenge: evidence } = interpretation;

      // Business identity → the governed key, derived; never a challenge id, never read from a store.
      const operationScope = { organizationId: scope.organizationId, principalId: scope.principalId, businessOperationId };
      const idempotencyKey = derivePaymentBusinessOperationKey(operationScope);
      const requestId = derivePaymentBusinessOperationRequestId(operationScope);

      // The canonical PaymentIntent, by PAY-01's own validator.
      const validation = paymentIntentOfProtocolTerms(
        terms,
        { source: request.source, purpose: request.purpose, idempotencyKey, ...(request.correlationId !== undefined ? { correlationId: request.correlationId } : {}) },
        monetary,
      );
      if (!validation.valid) return refused('payment-intent-invalid', businessOperationId);
      const intent: PaymentIntent = validation.intent;

      // The governed intent, by PAY-01's own compiler — and validated by the orchestrator's own validator before anything is stored.
      let compiled: PaymentGovernedActionIntent;
      try {
        compiled = compilePaymentIntent(intent, binding, (request.envelope ?? {}) as PaymentEnvelopeOptions);
      } catch {
        return refused('request-invalid', businessOperationId);
      }
      const governed = validateGovernedActionIntent(compiled, monetary, governance);
      if (!governed.valid || governed.intent.actionClass !== 'financial') return refused('payment-intent-invalid', businessOperationId);

      const businessTerms: PaymentBusinessTerms = {
        action: binding.action,
        source: { accountId: intent.source.accountId },
        destination: { kind: intent.destination.kind, reference: intent.destination.reference },
        amount: { value: intent.amount.value, unit: intent.amount.unit },
        purpose: intent.purpose,
        ...(intent.reference !== undefined ? { reference: intent.reference } : {}),
        ...(intent.rail !== undefined ? { rail: intent.rail } : {}),
        binding: { target: protectedRequest.target, method: protectedRequest.method, ...(protectedRequest.contentDigest !== undefined ? { contentDigest: protectedRequest.contentDigest.canonical } : {}) },
      };
      const businessSemanticDigest = computePaymentBusinessSemanticDigest(operationScope, businessTerms);
      const challengeEvidence = { protocolId: adapter.protocolId, key: evidence.key, fields: evidence.fields };

      // Durable BEFORE governance. Nothing below runs unless this write is proven.
      let recorded: RecordPaymentChallengeResult;
      try {
        recorded = await store.record(
          { organizationId: scope.organizationId },
          {
            operation: { ...operationScope, businessSemanticDigest, terms: businessTerms, governedIdempotencyKey: idempotencyKey, governedRequestId: requestId, createdAt: observedAt },
            challenge: {
              ...operationScope,
              businessSemanticDigest,
              protocolId: adapter.protocolId,
              challengeKey: evidence.key,
              challengeIdentity: computePaymentChallengeIdentity(challengeEvidence),
              challengeDigest: computePaymentChallengeDigest(challengeEvidence),
              fields: evidence.fields,
              observedAt,
            },
          },
        );
      } catch (error) {
        if (isPaymentBusinessOperationStoreError(error)) {
          if (error.code === 'PAYMENT_BUSINESS_OPERATION_CONFLICT') return refused('business-operation-conflict', businessOperationId);
          if (error.code === 'PAYMENT_BUSINESS_OPERATION_CHALLENGE_CONFLICT') return refused('challenge-conflict', businessOperationId);
          if (error.code === 'PAYMENT_BUSINESS_OPERATION_CHALLENGE_HISTORY_FULL') return refused('challenge-history-full', businessOperationId);
        }
        // Unreachable, rolled back, forked, pending recovery: never "the local store looks valid", never "proceed for now".
        if (isAuthorityStateFreshnessError(error)) return refused('store-freshness-unverified', businessOperationId);
        return refused('store-unavailable', businessOperationId);
      }
      if (
        recorded.operation.governedRequestId !== requestId ||
        recorded.operation.governedIdempotencyKey !== idempotencyKey ||
        recorded.operation.businessSemanticDigest !== businessSemanticDigest ||
        recorded.challenge.challengeIdentity !== computePaymentChallengeIdentity(challengeEvidence)
      ) {
        return refused('store-unavailable', businessOperationId);
      }

      // The existing authority spine: Kernel → committed decision → grant → P7 → claim → PAY-01 adapter → rail.
      const result = await orchestrator.govern(identity, compiled);
      if (result.requestId !== requestId) return Object.freeze({ outcome: 'inconsistent', businessOperationId, requestId, result });
      return Object.freeze({
        outcome: 'governed',
        businessOperationId,
        requestId,
        operation: recorded.operationOutcome,
        challenge: recorded.challengeOutcome,
        challengeSequence: recorded.challenge.challengeSequence,
        result,
      });
    },
  });
}
