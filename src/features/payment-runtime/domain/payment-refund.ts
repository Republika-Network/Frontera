import { addCanonicalDecimals, compareCanonicalDecimals, isCanonicalDecimal, isWellFormedMonetaryAmount, subtractCanonicalDecimals, type MonetaryAmount } from '../../monetary-runtime/index.js';

/**
 * Refund money rules (PAY-05) — pure, exact, conservative.
 *
 * A refund is a **new governed payment**: its own intent (purpose `refund`),
 * its own authority, grant, P7 capacity, P11 / P12, settlement and receipt.
 * It never deletes, reverses or rewrites the original settlement, receipt or
 * P11 record, never releases the original's P7 capacity, and is never
 * negative money. These rules only decide how much of a settled original may
 * still be refunded; whether the requester may refund at all is the governed
 * path's question, answered like any other payment.
 *
 * ```
 * original 100 settled
 *   R1  30  reserved → refundable 70
 *   R2  70  reserved → refundable 0
 *   R3   1  refused (exceeds-refundable)
 * original still: 100 settled
 * ```
 *
 * - Same asset only. There is no FX architecture; a refund in another asset is
 *   incomparable and refused, never converted.
 * - Strictly positive, canonical P9 decimals; exact `BigInt` arithmetic over
 *   text — never a number, never rounded.
 * - Partial refunds are supported, so the cumulative total is accounted
 *   durably: every reservation counts until it is **proven** that its refund
 *   payment moved nothing. An uncertain refund stays counted.
 */

export const PAYMENT_REFUND_REFUSALS = {
  /** The refund is denominated in another asset than the original settlement. */
  PAYMENT_REFUND_ASSET_MISMATCH: 'PAYMENT_REFUND_ASSET_MISMATCH',
  /** The refund amount is not a well-formed, strictly positive P9 amount. */
  PAYMENT_REFUND_AMOUNT_INVALID: 'PAYMENT_REFUND_AMOUNT_INVALID',
  /** The refund would take the cumulative refunded total beyond the original settled amount. */
  PAYMENT_REFUND_EXCEEDS_REFUNDABLE: 'PAYMENT_REFUND_EXCEEDS_REFUNDABLE',
} as const;

export type PaymentRefundRefusal = (typeof PAYMENT_REFUND_REFUSALS)[keyof typeof PAYMENT_REFUND_REFUSALS];

/**
 * Whether `requested` may be reserved against `original` when `counted` (the
 * sum of every reservation still counted) is already reserved. `undefined`
 * means it fits exactly; otherwise the one refusal. Total: a malformed input
 * is a refusal, never a throw.
 */
export function paymentRefundRefusal(original: MonetaryAmount, counted: string, requested: unknown): PaymentRefundRefusal | undefined {
  if (!isWellFormedMonetaryAmount(requested) || requested.value === '0') return PAYMENT_REFUND_REFUSALS.PAYMENT_REFUND_AMOUNT_INVALID;
  if (requested.unit !== original.unit) return PAYMENT_REFUND_REFUSALS.PAYMENT_REFUND_ASSET_MISMATCH;
  if (!isCanonicalDecimal(counted) || !isWellFormedMonetaryAmount(original)) return PAYMENT_REFUND_REFUSALS.PAYMENT_REFUND_EXCEEDS_REFUNDABLE;
  return compareCanonicalDecimals(addCanonicalDecimals(counted, requested.value), original.value) > 0 ? PAYMENT_REFUND_REFUSALS.PAYMENT_REFUND_EXCEEDS_REFUNDABLE : undefined;
}

/** The exact sum of counted reservation amounts. */
export function paymentRefundCounted(amounts: readonly string[]): string {
  return amounts.reduce((total, value) => addCanonicalDecimals(total, value), '0');
}

/** What is still refundable: `original − counted`, exactly. Throws when `counted` exceeds the original — an accounting that should never exist. */
export function paymentRefundRemaining(original: MonetaryAmount, counted: string): MonetaryAmount {
  return Object.freeze({ value: subtractCanonicalDecimals(original.value, counted), unit: original.unit });
}
