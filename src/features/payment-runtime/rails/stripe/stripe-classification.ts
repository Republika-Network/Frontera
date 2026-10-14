import type { StripePaymentIntentView } from './stripe-port.js';
import { STRIPE_RAIL_DETAILS, type StripeRailDetail } from './stripe-rail-details.js';

/**
 * The one mapping from Stripe's view of a PaymentIntent to what Frontera may
 * conclude (PAY-09) — shared, unchanged, by the rail (P11), the P12 resolution
 * authority and the PAY-05 finality authority, so the three can never disagree
 * about what a Stripe answer means.
 *
 * ## First: is it this execution's payment, under the qualified model?
 *
 * The exact PaymentIntent id bound before the confirmation; test mode; the
 * metadata correlation the rail wrote (execution and rail); USD; the exact
 * governed cents; the trusted connected account as `transfer_data.destination`;
 * the trusted Customer, and the trusted PaymentMethod whenever Stripe still
 * names one; no `transfer_data.amount`, no `on_behalf_of`, no application fee;
 * `capture_method=automatic`, `confirmation_method=manual`. Any difference is
 * `inconsistent` — never a success, never a failure: an object that is not
 * this payment proves nothing about this payment.
 *
 * ## Then: what does its status prove? (Stripe API reference and lifecycle)
 *
 * | status | conclusion | P11 / P12 | PAY-05 |
 * | --- | --- | --- | --- |
 * | `succeeded`, `amount_received` = `amount` | `completed` | `confirmed-completed` | `final` (processor-confirmed) |
 * | `succeeded`, another `amount_received` | `inconsistent` | `unconfirmed` / unresolved | `contradicted` |
 * | `requires_payment_method` **with** `last_payment_error` | `failed` — the one confirmation failed; the rail never confirms again | `confirmed-not-completed` | `contradicted` |
 * | `canceled` | `failed` — Stripe: cancellation "invalidates the PaymentIntent for future payment attempts, releases any held funds" | `confirmed-not-completed` | `contradicted` |
 * | `processing` | `pending` | `unconfirmed` / unresolved | `not-final` |
 * | `requires_action` | `pending` — never completed, never confirmed again by Frontera | `unconfirmed` / unresolved | `not-final` |
 * | `requires_confirmation`, or `requires_payment_method` **without** an error | `pending` — a confirmation may still be in flight | `unconfirmed` / unresolved | `not-final` |
 * | `requires_capture` | `inconsistent` — automatic capture only; Frontera never captures | `unconfirmed` / unresolved | `contradicted` |
 *
 * Never inferred: success from time passing, an event arriving, a Charge
 * existing or metadata; failure from a timeout, a 5xx, a reset connection, a
 * PaymentIntent Stripe does not find, or a status not listed above.
 */
export type StripePaymentConclusion =
  | { readonly kind: 'completed'; readonly latestChargeId: string | null }
  | { readonly kind: 'failed'; readonly detail: StripeRailDetail }
  | { readonly kind: 'pending'; readonly detail: StripeRailDetail }
  | { readonly kind: 'unknown' }
  | { readonly kind: 'inconsistent'; readonly detail: StripeRailDetail };

/** Everything bound before the confirmation, from the durable reservation. */
export interface StripeExpectedPayment {
  readonly paymentIntentId: string;
  readonly executionId: string;
  readonly railId: string;
  readonly amountCents: bigint;
  readonly currency: string;
  readonly customerId: string;
  readonly paymentMethodId: string;
  readonly destinationAccountId: string;
}

const D = STRIPE_RAIL_DETAILS;

/** Whether the view describes exactly the expected payment under the qualified charge model, or the first reason it does not. */
export function stripePaymentMismatch(view: StripePaymentIntentView, expected: StripeExpectedPayment): StripeRailDetail | undefined {
  if (view.id !== expected.paymentIntentId) return D.CORRELATION_MISMATCH;
  if (view.livemode) return D.LIVE_OBJECT;
  if (view.executionId !== expected.executionId || view.railId !== expected.railId) return D.CORRELATION_MISMATCH;
  if (view.currency !== expected.currency) return D.CURRENCY_MISMATCH;
  if (view.amountCents !== expected.amountCents) return D.AMOUNT_MISMATCH;
  if (view.destinationAccountId !== expected.destinationAccountId) return D.DESTINATION_MISMATCH;
  if (view.customerId !== expected.customerId) return D.FUNDING_MISMATCH;
  // Stripe may detach the PaymentMethod from a PaymentIntent whose attempt failed; while it names one, it must be ours.
  if (view.paymentMethodId !== null ? view.paymentMethodId !== expected.paymentMethodId : view.status !== 'requires_payment_method' && view.status !== 'canceled') return D.FUNDING_MISMATCH;
  if (view.transferAmountCents !== null || view.onBehalfOf !== null || view.applicationFeeCents !== null) return D.CHARGE_MODEL_MISMATCH;
  if (view.captureMethod !== 'automatic' || view.confirmationMethod !== 'manual') return D.CHARGE_MODEL_MISMATCH;
  return undefined;
}

export function concludeStripePayment(view: StripePaymentIntentView | undefined, expected: StripeExpectedPayment): StripePaymentConclusion {
  if (view === undefined) return { kind: 'unknown' };
  const mismatch = stripePaymentMismatch(view, expected);
  if (mismatch !== undefined) return { kind: 'inconsistent', detail: mismatch };
  switch (view.status) {
    case 'succeeded':
      return view.amountReceivedCents === view.amountCents ? { kind: 'completed', latestChargeId: view.latestChargeId } : { kind: 'inconsistent', detail: D.AMOUNT_RECEIVED_MISMATCH };
    case 'requires_payment_method':
      if (view.lastPaymentError === null) return { kind: 'pending', detail: D.CONFIRMATION_PENDING };
      return { kind: 'failed', detail: view.lastPaymentError === 'authentication_required' ? D.AUTHENTICATION_REQUIRED : D.PAYMENT_FAILED };
    case 'canceled':
      return { kind: 'failed', detail: D.PAYMENT_CANCELED };
    case 'processing':
      return { kind: 'pending', detail: D.PAYMENT_PROCESSING };
    case 'requires_action':
      return { kind: 'pending', detail: D.REQUIRES_ACTION };
    case 'requires_confirmation':
      return { kind: 'pending', detail: D.CONFIRMATION_PENDING };
    case 'requires_capture':
      return { kind: 'inconsistent', detail: D.CAPTURE_PENDING };
  }
}
