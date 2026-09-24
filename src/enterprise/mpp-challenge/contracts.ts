import type { BoundCustomerIdentity } from '../customer-identity/index.js';
import type { GovernedActionResult } from '../governed-action/contracts.js';
import type { MppChallengeFields, ParsedMppPaymentChallenge } from './protocol.js';

/**
 * P13 — MPP challenge adaptation and business-level idempotency: the trusted
 * in-process contracts.
 *
 * ```
 * external merchant: 402 + WWW-Authenticate: Payment …
 *   → parse / validate (protocol.ts)            structure, encodings, bounds
 *   → realm, expiry, body-digest binding        against the trusted protected request
 *   → trusted method normalizer                 exact P9 amount
 *   → trusted counterparty resolution           a Frontera counterparty, never a raw recipient
 *   → trusted selection                         no first-wins
 *   → business operation + challenge, durable   BEFORE governance
 *   → GovernedActionOrchestrator.govern()       the existing authority spine, unchanged
 * ```
 *
 * A machine payment is a governed action, not a new authority model. Nothing
 * here decides, grants, reserves, claims, executes or retries.
 */

/**
 * The trusted description of the external request that received the 402 —
 * supplied by the host's own network integration, never by the merchant.
 * Canonical and sanitized: no URL, query string, cookie, header or body.
 */
export interface ProtectedMppRequest {
  /** The Frontera resource this purchase is for — the governed `resource`. A trusted mapping; never the realm, never the URL. */
  readonly resource: string;
  /** The external request's HTTP method, upper case. */
  readonly httpMethod: string;
  /** When the network layer knows it: the realm the merchant must challenge with. A mismatch refuses the challenge. */
  readonly expectedRealm?: string;
  /** RFC 9530 Content-Digest of the exact body the protected request carries, computed by the trusted network layer. Required for a body-bearing request. */
  readonly contentDigest?: string;
}

/**
 * What a trusted method normalizer reports about one `charge` challenge:
 * payment terms, provider-neutral, and nothing else. Read from own data
 * properties only, into fresh plain data, and refused whole on any other key —
 * there is no field for authorization, a ceiling, a budget, a grant, an
 * outcome, a credential or a signature.
 */
export interface MppNormalizedCharge {
  /** Exact P9 money: canonical decimal text and a registry asset. The normalizer's trusted mapping from the method's base units and currency — never a guess. */
  readonly amount: { readonly value: string; readonly unit: string };
  /** The method's merchant/payment target (for example an account or address), normalized. Input to trusted counterparty resolution only — never itself a counterparty. */
  readonly merchantReference?: string;
  /** A stable merchant order/business correlation the method defines. Contributes to the business semantic digest; never replaces `businessOperationId`. */
  readonly externalId?: string;
}

/**
 * A trusted, host-composed interpreter of one payment method's `charge`
 * request. Composed once; its `methodId` and `intent` are snapshotted and never
 * re-read. **Synchronous**: a promise is not an answer. Returning `undefined`
 * (or throwing) means this challenge cannot be interpreted and is unusable.
 *
 * It sees the decoded request; it never sees a credential, and it cannot
 * choose the business operation, the governed key, the resource or the
 * counterparty.
 */
export interface MppChallengeMethodNormalizer {
  readonly methodId: string;
  readonly intent: 'charge';
  normalize(challenge: ParsedMppPaymentChallenge, protectedRequest: ProtectedMppRequest): MppNormalizedCharge | undefined;
}

/** What trusted counterparty resolution is told. The realm is the merchant's protection space: context, never authority. */
export interface MppCounterpartyResolutionContext {
  readonly organizationId: string;
  readonly methodId: string;
  readonly intent: 'charge';
  readonly realm: string;
  readonly merchantReference?: string;
  readonly resource: string;
  readonly httpMethod: string;
}

/**
 * Trusted, host-side, **synchronous** mapping to the Frontera counterparty the
 * governed action names — the identity P10 and P7 know. `undefined` (or a
 * throw, a promise, a non-identifier) refuses the challenge: a merchant string
 * never becomes a counterparty by copying.
 */
export type MppCounterpartyResolver = (context: MppCounterpartyResolutionContext) => string | undefined;

/** One usable challenge, as the selector sees it: fresh, frozen, normalized. */
export interface SupportedMppChallenge {
  readonly id: string;
  readonly realm: string;
  readonly method: string;
  readonly intent: 'charge';
  readonly expires?: string;
  readonly header?: 'Payment-Authorization';
  readonly amount: { readonly value: string; readonly unit: string };
  readonly counterparty: string;
}

export interface MppChallengeSelectionContext {
  readonly organizationId: string;
  readonly businessOperationId: string;
  readonly resource: string;
  readonly httpMethod: string;
}

/**
 * Trusted, host-side, **synchronous** choice among usable challenges. It is
 * asked even when only one remains, and must return the `id` of exactly one
 * candidate. A throw, a promise, an unknown or ambiguous id refuses: there is
 * no "first challenge wins".
 */
export type MppChallengeSelector = (candidates: readonly SupportedMppChallenge[], context: MppChallengeSelectionContext) => string | undefined;

/**
 * What trusted in-process code hands `prepareAndGovern`. Closed — any other key
 * refuses the request.
 */
export interface MppChallengePaymentRequest {
  /**
   * The logical purchase: stable across challenge refreshes, HTTP retries,
   * restarts and method alternatives; new for a deliberately new purchase.
   * Scoped to (organization, principal). Never a challenge id, a timestamp or a
   * per-attempt random value. Names an operation; grants nothing.
   */
  readonly businessOperationId: string;
  /** The governed action — classified financial by the host's P9 classifier. */
  readonly action: string;
  /** The `WWW-Authenticate` field value(s) of the merchant's 402, exactly as received. */
  readonly challenges: string | readonly string[];
  readonly protectedRequest: ProtectedMppRequest;
}

/** Closed internal refusals, all **before** governance: no Kernel call, no grant, no P7, no claim, no adapter. Not Kernel denials, and not on any public wire. */
export const MPP_CHALLENGE_REFUSALS = [
  /** The identity is not a bound customer identity of the served organization. */
  'identity-invalid',
  /** The request is outside the closed contract. */
  'request-invalid',
  /** No well-formed Payment challenge was received, or the header is malformed. */
  'challenge-invalid',
  /** Every otherwise usable challenge has expired. */
  'challenge-expired',
  /** Well-formed challenges exist, but none has a composed method normalizer for its method and intent. */
  'challenge-unsupported',
  /** The trusted selector did not choose exactly one usable challenge. */
  'challenge-ambiguous',
  /** The realm, or the body-digest binding, does not match the trusted protected request. */
  'request-binding-mismatch',
  /** The trusted method normalizer could not produce exact terms. */
  'normalization-failed',
  /** Trusted counterparty resolution did not produce a Frontera counterparty. */
  'counterparty-unresolved',
  /** The adapted governed intent is not valid under the deployment's P9 configuration (for example a non-financial action). */
  'governed-intent-invalid',
  /** The business operation is already on record with different business semantics. The first stands. */
  'business-operation-conflict',
  /** The operation already holds the maximum number of distinct challenges. */
  'challenge-history-full',
  /** The business-operation store could not durably establish the operation, or its state did not verify. Never read as "no previous operation". */
  'store-unavailable',
] as const;

export type MppChallengeRefusal = (typeof MPP_CHALLENGE_REFUSALS)[number];

export type MppChallengePaymentResult =
  | {
      /** The operation and this challenge are durable, and the existing governed-action path ran. `result` is exactly what it returned. */
      readonly outcome: 'governed';
      readonly businessOperationId: string;
      readonly requestId: string;
      readonly operation: 'created' | 'existing';
      readonly challengeSequence: number;
      readonly result: GovernedActionResult;
    }
  | { readonly outcome: 'refused'; readonly refusal: MppChallengeRefusal; readonly businessOperationId?: string }
  | {
      /** A programming or composition failure: the orchestrator answered for a request id other than the one P13 derived and persisted against. Reported with what the orchestrator returned; never masked. */
      readonly outcome: 'inconsistent';
      readonly businessOperationId: string;
      readonly requestId: string;
      readonly result: GovernedActionResult;
    };

/**
 * The trusted in-process MPP challenge-payment surface
 * (`AocEnterprise.mppChallengePayments`). No HTTP route, SDK method or
 * governed-action field reaches it.
 */
export interface MppChallengePaymentService {
  prepareAndGovern(identity: BoundCustomerIdentity, request: unknown): Promise<MppChallengePaymentResult>;
}

/**
 * P14's handoff, read-only: the verified operation a governed request maps to
 * and its latest accepted challenge, found by the trusted
 * `ValidatedExecutionAction.correlation.requestId` — never by a challenge id.
 *
 * Reading it is not authority. A payment adapter only ever runs after the
 * Kernel, the bounded grant and P7 allowed and exercised the action.
 */
export interface MppChallengeContextReader {
  readByGovernedRequestId(organizationId: string, requestId: string): Promise<VerifiedMppChallengeContext | undefined>;
}

export interface VerifiedMppChallengeContext {
  readonly organizationId: string;
  readonly principalId: string;
  readonly businessOperationId: string;
  readonly requestId: string;
  readonly businessSemanticDigest: string;
  /** The operation's exact normalized terms, proven against its semantic digest on this read. */
  readonly terms: {
    readonly action: string;
    readonly resource: string;
    readonly counterparty: string;
    readonly amount: { readonly value: string; readonly unit: string };
    readonly intent: 'charge';
    readonly httpMethod: string;
    readonly contentDigest?: string;
    readonly externalId?: string;
  };
  /** The latest accepted challenge, exact — every field a credential must echo. Re-validated on this read; **expiry is not**: P14 re-checks `expires` against its own injected clock (`isMppChallengeUsableAt`). */
  readonly challenge: MppChallengeFields;
  readonly challengeSequence: number;
  readonly challengeDigest: string;
  /** Where P14 must place the merchant credential on the **external** request — never Frontera's customer `Authorization`. */
  readonly credentialHeaderField: 'Authorization' | 'Payment-Authorization';
}
