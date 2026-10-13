import type { StripeCurrency, StripeMode } from './stripe-config.js';

/**
 * The durable Stripe payment interlock port (PAY-09) — what the rail writes
 * before Stripe can move money, so that no restart, crash, second process or
 * replay can confirm a second payment for one governed execution.
 *
 * ```
 * governed execution → RESERVE (durable) → create PaymentIntent (confirm=false, moves nothing)
 *                    → BIND its id (durable) → confirm ONCE → P11
 * ```
 *
 * Two durable writes, both strictly before the one money-moving request:
 *
 * - **reserve** — the execution and every term the payment will carry
 *   (platform account, governed source and its Stripe Customer and
 *   PaymentMethod, connected account, cents, currency, the canonical amount,
 *   the idempotency correlation, the mode). A second reservation for the same
 *   execution is refused: whatever happens next, this execution has started.
 * - **bind** — the id of the one PaymentIntent created for it. Written after
 *   the creation (which cannot charge) and before the confirmation (which
 *   can): a crash between creation and confirmation leaves the binding, and a
 *   crash before the binding leaves a PaymentIntent no Frontera code will
 *   ever confirm. One PaymentIntent per execution and one execution per
 *   PaymentIntent, ever.
 *
 * Never `confirm → remember`. Every later attempt for a recorded execution
 * finds the record and sends nothing; P12 and PAY-05 retrieve **the bound
 * PaymentIntent by its exact id** — never a search by metadata.
 *
 * ## No second truth
 *
 * The records hold no payment status. P11 holds the initial observation, P12
 * the definitive resolution, and Stripe can always be asked again.
 *
 * ## Bound to the platform account
 *
 * The reservation names the Stripe account the credential was verified to
 * belong to just before it was written; P12 and PAY-05 trust only a reader
 * that proves the same account. A reader for another account — even one that
 * happens to know an object with the same id — proves nothing.
 */

/** Everything bound before the creation. Opaque ids and exact amounts only — no secret, no client secret, no card data, no personal data. */
export interface StripePaymentReservationInput {
  readonly executionId: string;
  readonly railId: string;
  readonly mode: StripeMode;
  /** The platform account the credential proved to be, read before this reservation. */
  readonly platformAccountId: string;
  /** The governed source (PAY-01 `source.accountId`) and the saved instrument trusted configuration maps it to. */
  readonly sourceAccountId: string;
  readonly customerId: string;
  readonly paymentMethodId: string;
  /** The connected account (the governed destination). */
  readonly destinationAccountId: string;
  /** The governed amount, exactly as P9 states it, and in Stripe's minor units. */
  readonly amountValue: string;
  readonly amountUnit: string;
  readonly amountCents: bigint;
  readonly currency: StripeCurrency;
  /** The idempotency correlation both requests carry (`stripe-idempotency.ts`). */
  readonly createIdempotencyKey: string;
  readonly confirmIdempotencyKey: string;
}

/** A reservation, with the PaymentIntent bound to it once there is one. */
export interface StripePaymentReservationRecord extends StripePaymentReservationInput {
  readonly paymentIntentId?: string;
}

export type StripePaymentReservation =
  /** Durable on return: the creation may begin. */
  | { readonly outcome: 'reserved' }
  /** This execution already holds a reservation — a payment was, or may have been, initiated for it. Nothing written. */
  | { readonly outcome: 'execution-recorded'; readonly record: StripePaymentReservationRecord };

export type StripePaymentBinding =
  /** Durable on return: the one confirmation may begin. */
  | { readonly outcome: 'bound' }
  /** The execution is already bound (to this PaymentIntent or another). Nothing written; never confirmed again. */
  | { readonly outcome: 'execution-bound'; readonly paymentIntentId: string }
  /** Another execution holds this PaymentIntent. Nothing written; never confirmed. */
  | { readonly outcome: 'payment-intent-bound-elsewhere' }
  /** The execution holds no reservation. Nothing written; never confirmed. */
  | { readonly outcome: 'not-reserved' };

export interface StripePaymentInterlock {
  /** The record of an execution, if any. Throws when the state cannot be read or proven fresh: the caller refuses. */
  recorded(executionId: string): Promise<StripePaymentReservationRecord | undefined>;
  /** One atomic check-and-record: one reservation per execution, ever. Throws when it cannot: the caller refuses and creates nothing. */
  reserve(record: StripePaymentReservationInput): Promise<StripePaymentReservation>;
  /** One atomic check-and-record: one PaymentIntent per execution and one execution per PaymentIntent, ever. Throws when it cannot: the caller never confirms. */
  bind(executionId: string, paymentIntentId: string): Promise<StripePaymentBinding>;
}
