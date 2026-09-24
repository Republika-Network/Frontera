/**
 * P13 — the MPP business-operation store: the record shapes.
 *
 * ## What this store holds
 *
 * ```
 * MppBusinessOperationRecord     ONE per (organization, principal, businessOperationId):
 *                                the stable business meaning of a logical
 *                                purchase, its semantic digest, and the
 *                                governed idempotency key and request id it
 *                                deterministically maps to
 *
 * MppChallengeInstanceRecord     ZERO OR MORE per operation, append-only, in
 *                                store-assigned sequence: each accepted MPP
 *                                challenge exactly as the merchant sent it
 * ```
 *
 * Neither is ever updated or deleted. A refreshed challenge is a new instance
 * row under the same operation — never an edit of the old one.
 *
 * ## What it is not
 *
 * - **Not an outcome.** No `pending`, `paid`, `failed` or `settled`: what an
 *   execution did is P11's and P12's, read through the governed request id.
 * - **Not authority.** A business operation names a purchase; it grants
 *   nothing. The Kernel, P10 and P7 decide exactly as for any governed action.
 * - **Not a credential store.** A challenge is public server state. No
 *   `Authorization` value, customer key, payment credential, signature, wallet
 *   material or provider secret has a column here.
 * - **Not authenticity.** Unkeyed SHA-256 over `aoc.canonical-json.v1`; P20
 *   owns signatures, KMS/HSM and non-repudiation.
 */

/** Frozen identifier for this record format. A file written under any other version is refused unopened. */
export const MPP_BUSINESS_OPERATION_STORE_SCHEMA_VERSION = 'aoc.mpp-business-operation-store.schema.v1';

/** At most this many distinct challenge instances per operation; a further one is refused, never evicts an older one. */
export const MPP_CHALLENGE_INSTANCES_PER_OPERATION_MAX = 64;

/** Tenant scope. No `system` escape: every call is confined to one organization. */
export interface MppBusinessOperationAccessContext {
  readonly organizationId: string;
}

export interface MppBusinessOperationAmount {
  readonly value: string;
  readonly unit: string;
}

/** The immutable business meaning of one logical operation. Every field but `createdAt` is committed to by `businessSemanticDigest` or derived from the scope. */
export interface MppBusinessOperationInput {
  readonly organizationId: string;
  readonly principalId: string;
  readonly businessOperationId: string;
  readonly businessSemanticDigest: string;
  readonly action: string;
  readonly resource: string;
  readonly counterparty: string;
  readonly amount: MppBusinessOperationAmount;
  readonly intent: 'charge';
  readonly httpMethod: string;
  /** Canonical RFC 9530 digest of the protected request body, when it has one. */
  readonly contentDigest?: string;
  readonly externalId?: string;
  /** Derived from the scope; recomputed and compared on every read. */
  readonly governedIdempotencyKey: string;
  /** Derived from the scope through the orchestrator's own derivation; recomputed and compared on every read. */
  readonly governedRequestId: string;
  /** The host clock when the operation was first presented. */
  readonly createdAt: string;
}

export interface MppBusinessOperationRecord extends MppBusinessOperationInput {
  readonly schemaVersion: string;
  /** The store's clock inside the write's critical section. */
  readonly recordedAt: string;
  readonly recordDigest: string;
}

/** One accepted challenge, exact. Bound to its operation by scope and semantic digest. */
export interface MppChallengeInstanceInput {
  readonly organizationId: string;
  readonly principalId: string;
  readonly businessOperationId: string;
  readonly businessSemanticDigest: string;
  /** Over the security-significant fields; `description` excluded. Recomputed on every read. */
  readonly challengeDigest: string;
  readonly id: string;
  readonly realm: string;
  readonly method: string;
  readonly intent: string;
  readonly request: string;
  readonly expires?: string;
  readonly digest?: string;
  readonly opaque?: string;
  readonly header?: 'Payment-Authorization';
  /** Untrusted display text, bounded. Never security, never equivalence. */
  readonly description?: string;
  /** The host clock when this challenge was accepted. */
  readonly observedAt: string;
}

export interface MppChallengeInstanceRecord extends MppChallengeInstanceInput {
  readonly schemaVersion: string;
  /** Store-assigned inside the write transaction: 1, 2, 3 … per operation. Never caller-chosen, never derived from `expires`. */
  readonly challengeSequence: number;
  readonly recordedAt: string;
  readonly recordDigest: string;
}

/** One write: resolve (or create) the operation and append (or find) the challenge, atomically. */
export interface RecordMppChallengeInput {
  readonly operation: MppBusinessOperationInput;
  readonly challenge: MppChallengeInstanceInput;
}

export interface RecordMppChallengeResult {
  /** `existing`: the operation was already on record with the same business semantics — never re-dated. */
  readonly operationOutcome: 'created' | 'existing';
  /** `existing`: this exact challenge (by challenge digest) was already recorded for the operation. */
  readonly challengeOutcome: 'appended' | 'existing';
  readonly operation: MppBusinessOperationRecord;
  readonly challenge: MppChallengeInstanceRecord;
}

/** Everything durably known about one operation, verified: the operation and every challenge, in sequence. */
export interface MppBusinessOperationState {
  readonly operation: MppBusinessOperationRecord;
  readonly challenges: readonly MppChallengeInstanceRecord[];
}

/** The operation a governed request maps to, and its latest accepted challenge. */
export interface MppGovernedRequestState {
  readonly operation: MppBusinessOperationRecord;
  readonly latestChallenge: MppChallengeInstanceRecord;
}

export interface MppBusinessOperationStoreHealth {
  readonly status: 'healthy' | 'unhealthy';
  readonly readable: boolean;
  readonly writable: boolean;
  readonly schemaVersion: string;
  readonly checkedAt: string;
}
