import type { LightningNetwork } from './lightning-bolt11.js';

/**
 * The durable Lightning payment interlock port (PAY-06) — the one write the
 * rail makes before its one send, so that no restart, crash, second process
 * or second execution can initiate a second payment.
 *
 * ```
 * governed execution → verified invoice → reserve (durable, atomic) → send ONCE → P11
 * ```
 *
 * Never `send → remember`: a crash after the node accepted a payment and
 * before P11 recorded it leaves this record, and every later attempt for the
 * execution finds it and sends nothing; P12 then reads the **same** logical
 * payment from the node by its payment hash.
 *
 * ## Two uniqueness rules, both durable
 *
 * - **one record per execution, ever** — the same execution can never be
 *   bound to a second invoice (no "latest wins", no mutation);
 * - **one record per payment hash, ever** — the same invoice can never be
 *   paid under two governed executions, even for the same amount. The node's
 *   own duplicate-payment refusal is defence in depth, not this guarantee.
 *
 * ## No second truth
 *
 * A record is an append-only reservation: the binding between one governed
 * execution and one logical payment. It holds no payment status — P11 holds
 * the initial observation, P12 the definitive resolution, and the node can
 * always be asked again by payment hash.
 */

/** Everything bound before the send. Public payment facts only — no preimage, no route, no credential. */
export interface LightningPaymentReservationInput {
  readonly executionId: string;
  readonly paymentHash: string;
  readonly payee: string;
  readonly network: LightningNetwork;
  /** SHA-256 of the canonical (lowercase) invoice text: the invoice's identity, without storing route hints or descriptions. */
  readonly invoiceDigest: string;
  /** The exact governed amount the invoice states. */
  readonly amountMsat: bigint;
  /** The trusted routing-fee cap the send carried. */
  readonly feeLimitMsat: bigint;
  /** `timestamp + expiry` of the invoice, Unix seconds. */
  readonly expiresAt: number;
}

export type LightningPaymentReservation =
  /** Durable on return: the one send may begin. */
  | { readonly outcome: 'reserved' }
  /** This execution already holds a reservation — a payment was, or may have been, initiated for it. Nothing written. */
  | { readonly outcome: 'execution-recorded'; readonly record: LightningPaymentReservationInput }
  /** Another execution holds this payment hash. Nothing written; never sent. */
  | { readonly outcome: 'payment-hash-reserved' };

export interface LightningPaymentInterlock {
  /** The reservation of an execution, if any. Throws when the state cannot be read or proven fresh: the caller refuses. */
  recorded(executionId: string): Promise<LightningPaymentReservationInput | undefined>;
  /** One atomic check-and-record under both uniqueness rules. Throws when it cannot: the caller refuses and sends nothing. */
  reserve(record: LightningPaymentReservationInput): Promise<LightningPaymentReservation>;
}
