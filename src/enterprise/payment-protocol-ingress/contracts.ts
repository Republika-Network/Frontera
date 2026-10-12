import type { PaymentEnvelopeOptions, PaymentProtectedRequest, PaymentProtocolRefusal, PaymentPurpose } from '../../features/payment-runtime/index.js';
import type { BoundCustomerIdentity } from '../customer-identity/index.js';
import type { GovernedActionResult } from '../governed-action/contracts.js';
import type { PaymentBusinessTerms } from './business-operation.js';

/**
 * PAY-04 — payment protocol ingress: the trusted in-process contracts.
 *
 * ```
 * external payment protocol challenge(s)            untrusted
 *   + trusted protected request, source, purpose    the embedder's trusted application layer
 *   → PaymentProtocolAdapter.interpret               normalize + bind, never authorize
 *   → paymentIntentOfProtocolTerms                   the canonical PaymentIntent (PAY-01)
 *   → business operation + challenge, durable        BEFORE governance
 *   → compilePaymentIntent                           the PAY-01 compiler
 *   → GovernedActionOrchestrator.govern()            the existing spine, unchanged
 * ```
 *
 * A protocol-derived payment is a governed payment, not a new authority
 * model. Nothing here decides, grants, reserves, claims, executes, calls a
 * rail or retries. No HTTP route, SDK method or governed-action field reaches
 * this surface.
 */

/**
 * What trusted in-process code hands `prepareAndGovern`. Closed — any other key
 * refuses the request.
 */
export interface PaymentProtocolIngressRequest {
  /**
   * The logical purchase: stable across challenge refreshes, HTTP retries,
   * restarts and protocol alternatives; new for a deliberately new purchase.
   * Scoped to (organization, principal). Never a challenge id, a request id, a
   * timestamp or a per-attempt random value. Names an operation; grants nothing.
   */
  readonly businessOperationId: string;
  /** Which composed protocol adapter interprets `challenges`. */
  readonly protocol: string;
  /** The protocol's challenge carrier exactly as received (for an HTTP authentication protocol: the challenge header field values). Untrusted. */
  readonly challenges: unknown;
  /** The trusted description of the protected request the challenge asks to be paid for. */
  readonly protectedRequest: PaymentProtectedRequest;
  /** The trusted half of the payment: never the protocol's to say. */
  readonly payment: {
    readonly source: { readonly accountId: string };
    readonly purpose: PaymentPurpose;
    readonly correlationId?: string;
  };
  /** Envelope-owned evidence (a passport, a capability token) and a profile pin, passed to `compilePaymentIntent` unchanged. */
  readonly envelope?: PaymentEnvelopeOptions;
}

/** Closed internal refusals of the ingress itself, all **before** governance. */
export const PAYMENT_PROTOCOL_INGRESS_REFUSALS = [
  /** The identity is not a bound customer identity of the served organization. */
  'identity-invalid',
  /** The request is outside the closed contract (including the protected request and envelope data). */
  'request-invalid',
  /** No adapter is composed for the named protocol. */
  'protocol-unsupported',
  /** The trusted clock did not answer a canonical instant. */
  'clock-unavailable',
  /** The normalized payment is not a valid canonical PaymentIntent, or not a valid governed payment under the deployment's P9 / CORE-03 configuration. */
  'payment-intent-invalid',
  /** The business operation is already on record with different business semantics. The first stands. */
  'business-operation-conflict',
  /** The challenge is already on record for another business operation, or as a different challenge. One challenge pays for one operation. */
  'challenge-conflict',
  /** The operation already holds the maximum number of distinct challenges. */
  'challenge-history-full',
  /** The business-operation store could not durably establish the operation, or its state did not verify. Never read as "no previous operation". */
  'store-unavailable',
  /**
   * The business-operation store could not prove its history current at the CORE-07 freshness witness: the witness is
   * unreachable, or the local history is older than (rolled back), divergent from (forked) or missing a transition (pending
   * recovery) what the witness holds. No payment is attempted until it is recovered.
   */
  'store-freshness-unverified',
] as const;

export type PaymentProtocolIngressRefusal = (typeof PAYMENT_PROTOCOL_INGRESS_REFUSALS)[number] | PaymentProtocolRefusal;

export type PaymentProtocolIngressResult =
  | {
      /** The operation and this challenge are durable, and the existing governed-action path ran. `result` is exactly what it returned. */
      readonly outcome: 'governed';
      readonly businessOperationId: string;
      readonly requestId: string;
      readonly operation: 'created' | 'existing';
      readonly challenge: 'appended' | 'existing';
      readonly challengeSequence: number;
      readonly result: GovernedActionResult;
    }
  | { readonly outcome: 'refused'; readonly refusal: PaymentProtocolIngressRefusal; readonly businessOperationId?: string }
  | {
      /** A composition failure: the orchestrator answered for a request id other than the one derived and recorded. Reported with what it returned; never masked. */
      readonly outcome: 'inconsistent';
      readonly businessOperationId: string;
      readonly requestId: string;
      readonly result: GovernedActionResult;
    };

/**
 * The trusted in-process payment protocol ingress. An embedder composes it
 * beside the governed-action orchestrator (`createPaymentProtocolIngress`).
 */
export interface PaymentProtocolIngress {
  readonly protocols: readonly string[];
  prepareAndGovern(identity: BoundCustomerIdentity, request: unknown): Promise<PaymentProtocolIngressResult>;
}

/**
 * A later handoff, read-only: the verified operation a governed request maps
 * to and its latest accepted challenge, found by the trusted
 * `ValidatedExecutionAction.correlation.requestId` — never by a challenge id.
 * Reading it is not authority, and nothing in PAY-04 reads it to execute.
 */
export interface PaymentProtocolContextReader {
  readByGovernedRequestId(organizationId: string, requestId: string): Promise<VerifiedPaymentProtocolContext | undefined>;
}

export interface VerifiedPaymentProtocolContext {
  readonly organizationId: string;
  readonly principalId: string;
  readonly businessOperationId: string;
  readonly requestId: string;
  readonly businessSemanticDigest: string;
  /** The operation's exact terms, proven against its semantic digest on this read. */
  readonly terms: PaymentBusinessTerms;
  /** The latest accepted challenge, exact. Its expiry is **not** re-checked here: a consumer re-checks it with its own clock. */
  readonly challenge: {
    readonly protocolId: string;
    readonly key: string;
    readonly fields: Readonly<Record<string, string>>;
    readonly sequence: number;
    readonly digest: string;
  };
}
