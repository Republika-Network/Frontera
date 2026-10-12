import type { PaymentBusinessTerms } from './business-operation.js';

/**
 * PAY-04 — the payment business-operation store: the record shapes.
 *
 * Protocol-neutral: one business operation per (organization, principal,
 * businessOperationId), whatever protocol presented it, with each accepted
 * protocol challenge attached underneath as evidence.
 *
 * ```
 * PaymentBusinessOperationRecord   ONE per (organization, principal, businessOperationId):
 *                                  the stable business meaning of a logical purchase, its
 *                                  semantic digest, and the governed idempotency key and
 *                                  request id it deterministically maps to
 *
 * PaymentChallengeRecord           ONE OR MORE per operation, append-only, in store-assigned
 *                                  order: each accepted challenge, exactly as the protocol
 *                                  adapter read it; each challenge identity belongs to one
 *                                  operation only
 * ```
 *
 * Neither is ever updated or deleted. A refreshed challenge is a new
 * challenge row under the same operation — never an edit of the old one.
 *
 * ## What it is not
 *
 * - **Not an outcome.** No `pending`, `paid`, `failed`, `settled` or "retry
 *   requested": what an execution did is P11's and P12's, read through the
 *   governed request id.
 * - **Not authority.** A business operation names a purchase; it grants
 *   nothing. The Kernel, P10 and P7 decide exactly as for any governed payment.
 * - **Not the duplicate-payment barrier.** The governed key is *derived* from
 *   the scope, never read from here; the Governance Store's idempotency and
 *   the write-ahead claim are the barrier. This store adds conflict detection
 *   for the terms the governed intent does not carry (the protected-request
 *   binding), the challenge history and its one-operation-per-challenge rule.
 * - **Not a credential store.** A challenge is public server state. No
 *   `Authorization` value, customer key, payment credential, signature or
 *   provider secret has a column here.
 * - **Not authenticity.** Unkeyed SHA-256 over `aoc.canonical-json.v1`.
 */

/** Frozen identifier for this record format. A file written under any other version is refused unopened. */
export const PAYMENT_BUSINESS_OPERATION_STORE_SCHEMA_VERSION = 'aoc.payment-business-operation-store.schema.v1';

/** At most this many distinct challenges per operation; a further one is refused, never evicts an older one. */
export const PAYMENT_CHALLENGES_PER_OPERATION_MAX = 64;

/** Tenant scope. No `system` escape: every call is confined to one organization. */
export interface PaymentBusinessOperationAccessContext {
  readonly organizationId: string;
}

/** The immutable business meaning of one logical operation. Every field but `createdAt` is committed to by `businessSemanticDigest` or derived from the scope. */
export interface PaymentBusinessOperationInput {
  readonly organizationId: string;
  readonly principalId: string;
  readonly businessOperationId: string;
  readonly businessSemanticDigest: string;
  readonly terms: PaymentBusinessTerms;
  /** Derived from the scope; recomputed and compared on every read. */
  readonly governedIdempotencyKey: string;
  /** Derived from the scope through the orchestrator's own derivation; recomputed and compared on every read. */
  readonly governedRequestId: string;
  /** The host clock when the operation was first presented. */
  readonly createdAt: string;
}

export interface PaymentBusinessOperationRecord extends PaymentBusinessOperationInput {
  readonly schemaVersion: string;
  /** The store's clock inside the write's critical section. */
  readonly recordedAt: string;
  readonly recordDigest: string;
}

/** One accepted challenge, exact. Bound to its operation by scope and semantic digest. */
export interface PaymentChallengeInput {
  readonly organizationId: string;
  readonly principalId: string;
  readonly businessOperationId: string;
  readonly businessSemanticDigest: string;
  readonly protocolId: string;
  /** The challenge's identity within its protocol. */
  readonly challengeKey: string;
  /** Over the protocol and the key. Unique per organization: one challenge, one operation. Recomputed on every read. */
  readonly challengeIdentity: string;
  /** Over the protocol, the key and every field. Recomputed on every read. */
  readonly challengeDigest: string;
  /** The exact accepted protocol strings. Public challenge data only. */
  readonly fields: Readonly<Record<string, string>>;
  /** The host clock when this challenge was accepted. */
  readonly observedAt: string;
}

export interface PaymentChallengeRecord extends PaymentChallengeInput {
  readonly schemaVersion: string;
  /** Store-assigned inside the write transaction: 1, 2, 3 … per operation. Never caller-chosen, never derived from an expiry. */
  readonly challengeSequence: number;
  readonly recordedAt: string;
  readonly recordDigest: string;
}

/** One write: resolve (or create) the operation and append (or find) the challenge, atomically. */
export interface RecordPaymentChallengeInput {
  readonly operation: PaymentBusinessOperationInput;
  readonly challenge: PaymentChallengeInput;
}

export interface RecordPaymentChallengeResult {
  /** `existing`: the operation was already on record with the same business semantics — never re-dated. */
  readonly operationOutcome: 'created' | 'existing';
  /** `existing`: this exact challenge was already recorded for the operation. */
  readonly challengeOutcome: 'appended' | 'existing';
  readonly operation: PaymentBusinessOperationRecord;
  readonly challenge: PaymentChallengeRecord;
}

/** Everything durably known about one operation, verified: the operation and every challenge, in order. */
export interface PaymentBusinessOperationState {
  readonly operation: PaymentBusinessOperationRecord;
  readonly challenges: readonly PaymentChallengeRecord[];
}

/** The operation a governed request maps to, and its latest accepted challenge. */
export interface PaymentGovernedRequestState {
  readonly operation: PaymentBusinessOperationRecord;
  readonly latestChallenge: PaymentChallengeRecord;
}

export interface PaymentBusinessOperationStoreHealth {
  readonly status: 'healthy' | 'unhealthy';
  readonly readable: boolean;
  readonly writable: boolean;
  readonly schemaVersion: string;
  readonly checkedAt: string;
}

/** The read half a later handoff needs: the verified operation a governed request maps to. Keyed by the trusted governed request id, never by a challenge id. */
export interface PaymentGovernedRequestReader {
  readByGovernedRequestId(context: PaymentBusinessOperationAccessContext, requestId: string): Promise<PaymentGovernedRequestState | undefined>;
}

export interface PaymentBusinessOperationReader extends PaymentGovernedRequestReader {
  readOperation(context: PaymentBusinessOperationAccessContext, principalId: string, businessOperationId: string): Promise<PaymentBusinessOperationState | undefined>;
}

/**
 * The write half — append only. One call resolves the operation and appends
 * the challenge in one critical section:
 *
 * - operation absent → created; present with the same semantic digest →
 *   `existing`, returned unchanged; present with a different one →
 *   `PAYMENT_BUSINESS_OPERATION_CONFLICT`, and nothing is written;
 * - challenge identity absent → appended at the next store-assigned position;
 *   present on this operation with the same digest → `existing`; present on
 *   another operation, or with a different digest →
 *   `PAYMENT_BUSINESS_OPERATION_CHALLENGE_CONFLICT`, and nothing is written.
 *
 * No update, no delete, no overwrite, no "latest wins" for the operation.
 */
export interface PaymentBusinessOperationWriter {
  record(context: PaymentBusinessOperationAccessContext, input: RecordPaymentChallengeInput): Promise<RecordPaymentChallengeResult>;
}

/**
 * The payment business-operation store.
 *
 * 1. **Atomic write decisions** — one critical section per `record` (SQLite:
 *    `BEGIN IMMEDIATE`; memory: synchronous). No network call inside it.
 * 2. **Uniqueness** — at most one operation per scope, and one operation per
 *    challenge identity, enforced by the store (SQLite: a primary key and a
 *    unique index), never by process memory.
 * 3. **Immutability** — never updated or deleted (SQLite: triggers).
 * 4. **Tenant confinement** — another organization reads and writes nothing.
 * 5. **Verify before trusting** — every candidate row is re-validated and
 *    its digests and derivations recomputed before it can select anything.
 * 6. **Fail closed, never repair** — corrupt state is an error, never "absent".
 */
export interface PaymentBusinessOperationStore extends PaymentBusinessOperationReader, PaymentBusinessOperationWriter {
  readonly providerKind: 'memory' | 'sqlite';
  health(): Promise<PaymentBusinessOperationStoreHealth>;
  close(): Promise<void>;
}
