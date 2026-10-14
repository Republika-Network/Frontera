import { createHash } from 'node:crypto';

import {
  STRIPE_RAIL_DETAILS,
  concludeStripePayment,
  isStripeRailConfiguration,
  parseStripeDestination,
  readStripePaymentIntentView,
  stripeFundingSourceOf,
  type StripePaymentReader,
  type StripePaymentReservationRecord,
  type StripeRailConfiguration,
} from '../../features/payment-runtime/rails/stripe/index.js';
import type { PaymentFinalityAnswer, PaymentFinalityAuthority, PaymentFinalityFact, PaymentFinalityQuery } from '../../features/payment-runtime/index.js';
import { stripeExpectedPaymentOf, stripeReaderIsBoundAccount, stripeRecordInScope, type StripeInterlockReadAccess } from './stripe-resolution-authority.js';

/** The PAY-05 finality authority id for Stripe payments. */
export const STRIPE_FINALITY_AUTHORITY_ID = 'frontera.stripe-usd-finality';

/**
 * How finality is established: Stripe reports the bound PaymentIntent
 * `succeeded` with every governed term exact. Versioned. The name says what it
 * is — a processor confirmation — and nothing more.
 */
export const STRIPE_FINALITY_METHOD = 'stripe.payment-intent-succeeded.v1';

export interface StripeFinalityAuthorityOptions {
  readonly configuration: StripeRailConfiguration;
  /** Reads only — build it with `readOnlyStripe` (or `createStripeApiReader`). */
  readonly stripe: StripePaymentReader;
  readonly interlock: StripeInterlockReadAccess;
}

const NOT_FINAL: PaymentFinalityAnswer = Object.freeze({ outcome: 'not-final' });
const D = STRIPE_RAIL_DETAILS;

/**
 * The governed-term checks that contradict a completed execution when the bound PaymentIntent itself says otherwise.
 * A mismatch of identity (another object, another execution's metadata, a live object) is absence of evidence, never a contradiction.
 */
const CONTRADICTIONS: Readonly<Record<string, string>> = Object.freeze({
  [D.AMOUNT_MISMATCH]: 'stripe.amount-mismatch',
  [D.AMOUNT_RECEIVED_MISMATCH]: 'stripe.amount-received-mismatch',
  [D.CURRENCY_MISMATCH]: 'stripe.currency-mismatch',
  [D.DESTINATION_MISMATCH]: 'stripe.destination-mismatch',
  [D.FUNDING_MISMATCH]: 'stripe.funding-mismatch',
  [D.CHARGE_MODEL_MISMATCH]: 'stripe.charge-model-mismatch',
  [D.CAPTURE_PENDING]: 'stripe.capture-pending',
});

/** A domain-separated commitment to the saved instrument — the evidence names it without disclosing the Customer or PaymentMethod ids. */
export function stripeFundingCommitment(customerId: string, paymentMethodId: string): string {
  return createHash('sha256').update(`frontera.stripe-funding-commitment.v1\u0000${customerId}\u0000${paymentMethodId}`, 'utf8').digest('hex');
}

/**
 * PAY-09 — the Stripe rail's PAY-05 `PaymentFinalityAuthority`, implementing
 * the rail-neutral port **unchanged**: no PaymentIntent, Charge or Connect
 * field was added to the generic contract; Stripe's proof travels as
 * normalized facts under the `stripe.` prefix.
 *
 * ## What "final" means here — and does not
 *
 * **Processor-confirmed successful payment under Stripe's PaymentIntent
 * state**: the bound PaymentIntent is `succeeded` and `amount_received` equals
 * the governed amount, on the platform account the reservation bound, to the
 * governed connected account, from the governed source's saved instrument.
 * That is the strongest fact Stripe's PaymentIntent API states about a card
 * payment, and PAY-05 records it as `settled`.
 *
 * It is **not** blockchain irreversibility, legal finality, funds available
 * for payout, or chargeback-proof settlement. A card payment can later be
 * refunded, disputed (the platform is debited for destination charges) or
 * reversed. PAY-09 does not pretend otherwise: those are post-settlement
 * reversals, outside this authority, documented as residuals
 * (`docs/payments/PAY-09-STRIPE-FIAT-RAIL.md` §15). A later milestone may
 * consume authenticated Stripe dispute events into payment obligations.
 *
 * ## Asked about one completed governed payment
 *
 * 1. the interlock record of that execution (written before the
 *    confirmation) must equal the canonical payment — source, connected
 *    account (the governed destination), amount, rail, mode, platform
 *    account — and be bound to a PaymentIntent equal to the P11 / P12 handle;
 * 2. the reader must prove it acts as **that** platform account, in test mode;
 * 3. the bound PaymentIntent, retrieved by its exact id, must be `succeeded`
 *    with every bound term exact.
 *
 * | Stripe fact | answer |
 * | --- | --- |
 * | all of the above | `final`, with deterministic evidence |
 * | the bound PaymentIntent, but another amount, amount received, currency, destination, funding or charge model; `requires_capture` | `contradicted` (nothing recorded; P11 / P12 never rewritten) |
 * | failed or canceled although P11 / P12 say completed | `contradicted` |
 * | processing, requires action / confirmation, not found, unreachable, unreadable; another object or execution; a live object; no record, or one that disagrees | `not-final` |
 * | a reader for **another account** — whatever it answers | `not-final` |
 *
 * ## Deterministic, bounded evidence
 *
 * Facts come only from the record and the immutable terms of the succeeded
 * PaymentIntent: mode, platform account, PaymentIntent id, connected account,
 * cents, currency, status, the latest Charge id (provider metadata, never
 * parsed) and a **commitment** to the funding instrument — never the
 * `client_secret`, a card's details, a Customer's name, email or address, the
 * raw response, or a Stripe timestamp. No `finalizedAt`: Stripe's PaymentIntent
 * states no finality instant. The same payment yields the same evidence on
 * every read.
 *
 * Read-only: it holds a `StripePaymentReader` (no create, no confirm) and the
 * interlock's `read`; it never creates, confirms, captures, cancels, refunds
 * or writes anything, and is asked only from an explicit settlement
 * verification.
 */
export function createStripeFinalityAuthority(options: StripeFinalityAuthorityOptions): PaymentFinalityAuthority {
  const configuration = options?.configuration;
  if (!isStripeRailConfiguration(configuration)) throw new TypeError('The Stripe finality authority needs a validated rail configuration.');
  const stripe = options.stripe;
  for (const method of ['retrieveAccount', 'retrievePaymentIntent'] as const) {
    if (typeof stripe?.[method] !== 'function') throw new TypeError(`The Stripe finality authority's reader must implement ${method}.`);
  }
  const interlock = options.interlock;
  if (typeof interlock?.read !== 'function') throw new TypeError('The Stripe finality authority needs read access to the interlock.');
  const timeout = configuration.requestTimeoutMs;

  async function verifyFinality(query: PaymentFinalityQuery): Promise<PaymentFinalityAnswer> {
    const payment = query.payment;
    // Only this rail's payments, in its configured asset, from a mapped account, to a Stripe destination.
    if (query.railId !== undefined && query.railId !== configuration.railId) return NOT_FINAL;
    if (payment.amount.unit !== configuration.asset.paymentAsset) return NOT_FINAL;
    if (stripeFundingSourceOf(configuration, payment.source.accountId) === undefined) return NOT_FINAL;
    const destinationAccountId = parseStripeDestination(payment.destination);
    if (destinationAccountId === undefined) return NOT_FINAL;

    let record: StripePaymentReservationRecord | undefined;
    try {
      record = await interlock.read(query.executionId);
    } catch {
      return NOT_FINAL;
    }
    // The record, the P11 / P12 handle and the canonical payment must describe the same payment.
    if (record === undefined || !stripeRecordInScope(record, configuration, query.executionId)) return NOT_FINAL;
    if (record.sourceAccountId !== payment.source.accountId || record.destinationAccountId !== destinationAccountId) return NOT_FINAL;
    if (record.amountUnit !== payment.amount.unit || record.amountValue !== payment.amount.value) return NOT_FINAL;
    const expected = stripeExpectedPaymentOf(record);
    if (expected === undefined) return NOT_FINAL;
    if (query.providerRef !== undefined && query.providerRef !== expected.paymentIntentId) return NOT_FINAL;

    try {
      // Only a reader acting as the platform account the reservation bound can make — or contradict — this payment's finality.
      if (!(await stripeReaderIsBoundAccount(stripe, record, timeout))) return NOT_FINAL;
      const view = readStripePaymentIntentView(await stripe.retrievePaymentIntent(expected.paymentIntentId, timeout));
      const conclusion = concludeStripePayment(view, expected);
      switch (conclusion.kind) {
        case 'failed':
          return Object.freeze({ outcome: 'contradicted', reason: conclusion.detail === D.PAYMENT_CANCELED ? 'stripe.payment-canceled' : 'stripe.payment-failed' });
        case 'inconsistent': {
          const reason = CONTRADICTIONS[conclusion.detail];
          return reason === undefined ? NOT_FINAL : Object.freeze({ outcome: 'contradicted', reason });
        }
        case 'pending':
        case 'unknown':
          return NOT_FINAL;
        case 'completed':
          break;
      }
      const facts: PaymentFinalityFact[] = [
        { name: 'stripe.amount-cents', value: record.amountCents.toString() },
        { name: 'stripe.currency', value: record.currency },
        { name: 'stripe.destination-account', value: record.destinationAccountId },
        { name: 'stripe.finality-basis', value: 'processor-confirmed' },
        { name: 'stripe.funding-commitment', value: stripeFundingCommitment(record.customerId, record.paymentMethodId) },
        { name: 'stripe.mode', value: record.mode },
        { name: 'stripe.payment-intent', value: expected.paymentIntentId },
        { name: 'stripe.platform-account', value: record.platformAccountId },
        { name: 'stripe.status', value: 'succeeded' },
        ...(conclusion.latestChargeId !== null ? [{ name: 'stripe.latest-charge', value: conclusion.latestChargeId }] : []),
      ];
      return Object.freeze({
        outcome: 'final',
        evidence: {
          executionId: query.executionId,
          method: STRIPE_FINALITY_METHOD,
          providerRef: expected.paymentIntentId,
          // Restated from the record, exactly as governed (it equals the payment's by the checks above).
          amount: { value: record.amountValue, unit: record.amountUnit },
          source: { accountId: payment.source.accountId },
          destination: { kind: payment.destination.kind, reference: payment.destination.reference },
          facts,
        },
      });
    } catch {
      return NOT_FINAL;
    }
  }

  return Object.freeze({ authorityId: STRIPE_FINALITY_AUTHORITY_ID, verifyFinality });
}
