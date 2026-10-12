import type { PaymentFinalityFact, PaymentSettlementBasisKind, PaymentSettlementTerms } from '../../features/payment-runtime/index.js';

/**
 * PAY-05 — settlement and receipt record shapes.
 *
 * ## One immutable fact per execution
 *
 * ```
 * PaymentSettlementRecord   "the governed payment of execution X reached funds
 *                           finality": the canonical basis it was attempted
 *                           from (P11 / P12, by digest), the canonical payment
 *                           (committed decision + P11), and the bounded,
 *                           normalized finality evidence a trusted authority
 *                           returned — never a provider body
 * ```
 *
 * Written once, never updated or deleted. There is no "unsettled" row: not
 * settled is the absence of a record, and every other state is derived from P11
 * and P12 on read. A refund never rewrites it.
 *
 * ## What it is not
 *
 * - **Not P11 or P12.** It names their records by digest; it never restates or
 *   changes them, and neither reads it.
 * - **Not P7.** P7's "settled" reservation is capacity accounting. Nothing here
 *   reads or writes P7.
 * - **Not authority.** Nothing that decides, issues, reserves, routes or
 *   executes reads it. A settlement is never permission for anything.
 * - **Not authenticity.** Unkeyed SHA-256 over `aoc.canonical-json.v1`, like P11
 *   and P12: tamper detection under the store's digest model, not a signature.
 */

export const PAYMENT_SETTLEMENT_STORE_SCHEMA_VERSION = 'aoc.payment-settlement-store.schema.v1';

/** Tenant scope. No `system` escape: every call is confined to one organization. */
export interface PaymentSettlementAccessContext {
  readonly organizationId: string;
}

/** The canonical basis, by digest: which P11 / P12 records the settlement was attempted from. */
export interface PaymentSettlementBasis {
  readonly kind: PaymentSettlementBasisKind;
  readonly attemptDigest: string;
  /** P11's initial observation: `confirmed-completed` (provider basis) or `unconfirmed` (resolution basis). Absent when P11 recorded none. */
  readonly observationDigest?: string;
  /** P12's definitive `confirmed-completed` resolution — present exactly for the resolution basis. */
  readonly resolutionDigest?: string;
}

/** The normalized finality evidence, as recorded. `proofDigest` commits to the method, the handle, the instant and every fact. */
export interface PaymentSettlementFinality {
  readonly authorityId: string;
  readonly method: string;
  readonly providerRef: string;
  readonly finalizedAt?: string;
  readonly facts: readonly PaymentFinalityFact[];
  readonly proofDigest: string;
}

export interface RecordPaymentSettlementInput {
  readonly organizationId: string;
  readonly executionId: string;
  readonly requestId: string;
  readonly decisionId: string;
  readonly evaluationId: string;
  readonly boundedGrantId: string;
  readonly action: string;
  /** The rail P11 recorded as having performed the effect, when one did. */
  readonly railId?: string;
  readonly basis: PaymentSettlementBasis;
  readonly payment: PaymentSettlementTerms;
  readonly finality: PaymentSettlementFinality;
  /** The service clock when the finality answer was accepted. Local — never part of the content or the receipt. */
  readonly verifiedAt: string;
}

export interface PaymentSettlementRecord extends RecordPaymentSettlementInput {
  readonly schemaVersion: string;
  /** Derived from `(organizationId, executionId)`. Never chosen by a caller. */
  readonly settlementId: string;
  /**
   * Digest of the settlement's **content** — everything except the two local
   * instants (`verifiedAt`, `recordedAt`). Two verifications of the same final
   * transfer have the same content digest; the receipt binds it, so a receipt
   * re-derived after a restore or a second verification is byte-identical.
   */
  readonly contentDigest: string;
  /** The store's own clock, sampled inside the write's critical section. */
  readonly recordedAt: string;
  readonly settlementDigest: string;
}

/** `existing`: the same content was already recorded; the first record is returned unchanged, never re-dated. */
export interface RecordPaymentSettlementResult {
  readonly outcome: 'recorded' | 'existing';
  readonly settlement: PaymentSettlementRecord;
}

export interface PaymentSettlementStoreHealth {
  readonly status: 'healthy' | 'unhealthy';
  readonly readable: boolean;
  readonly writable: boolean;
  readonly schemaVersion: string;
  readonly checkedAt: string;
}

export const PAYMENT_RECEIPT_FORMAT = 'frontera.payment-receipt.v1';

/**
 * A canonical, immutable payment receipt — evidence that one canonical
 * settlement exists, and nothing more.
 *
 * Not an authorization, a grant, an invoice, a merchant challenge, an
 * execution or protocol credential, a new payment, or a P11 outcome. It is
 * derived — deterministically and purely — from a verified settlement record,
 * and from nothing else (never from a rail result): the same settlement always
 * derives the same receipt, byte for byte, so a receipt needs no store of its
 * own and cannot be emitted twice with different content.
 *
 * **Integrity and correlation, not authenticity.** `receiptDigest` is unkeyed
 * SHA-256 over the canonical receipt; verification recomputes it and, given the
 * settlement record, re-derives the receipt and compares. It is not a signature
 * and does not prove who issued it.
 */
export interface PaymentReceipt {
  readonly format: typeof PAYMENT_RECEIPT_FORMAT;
  /** Derived from the settlement identity. */
  readonly receiptId: string;
  readonly status: 'settled';
  readonly settlementId: string;
  readonly settlementContentDigest: string;
  readonly organizationId: string;
  readonly executionId: string;
  readonly requestId: string;
  readonly decisionId: string;
  readonly railId?: string;
  readonly payment: PaymentSettlementTerms;
  readonly finality: {
    readonly authorityId: string;
    readonly method: string;
    readonly providerRef: string;
    readonly finalizedAt?: string;
    readonly proofDigest: string;
  };
  readonly receiptDigest: string;
}

/** Disclosure tiers, ASSURE-01's names. */
export type PaymentReceiptDisclosureLevel = 'auditor' | 'partner' | 'customer' | 'public';
