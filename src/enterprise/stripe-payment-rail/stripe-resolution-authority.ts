import { EXECUTION_FAILURE_REASONS } from '../../features/execution-runtime/index.js';
import {
  concludeStripePayment,
  isStripeRailConfiguration,
  readStripeAccountView,
  readStripePaymentIntentView,
  type StripeExpectedPayment,
  type StripePaymentReader,
  type StripePaymentReservationRecord,
  type StripeRailConfiguration,
} from '../../features/payment-runtime/rails/stripe/index.js';
import type { ExecutionResolutionAuthority, ExecutionResolutionAuthorityResult, ExecutionResolutionQuery } from '../execution-reconciliation/authority.js';

/** The P12 authority id under which Stripe executions are bound before their claim. */
export const STRIPE_RESOLUTION_AUTHORITY_ID = 'frontera.stripe-usd-payment-intents';

/** What the authorities read from the local interlock: one record, by execution. They never write it. */
export interface StripeInterlockReadAccess {
  read(executionId: string): Promise<StripePaymentReservationRecord | undefined>;
}

export interface StripeResolutionAuthorityOptions {
  readonly configuration: StripeRailConfiguration;
  /** Reads only — build it with `readOnlyStripe` (or `createStripeApiReader` with a restricted read-only key). */
  readonly stripe: StripePaymentReader;
  readonly interlock: StripeInterlockReadAccess;
}

const UNRESOLVED: ExecutionResolutionAuthorityResult = Object.freeze({ outcome: 'unresolved' });

/** The payment the reservation and its binding committed to, before the confirmation. */
export function stripeExpectedPaymentOf(record: StripePaymentReservationRecord): StripeExpectedPayment | undefined {
  if (record.paymentIntentId === undefined) return undefined;
  return {
    paymentIntentId: record.paymentIntentId,
    executionId: record.executionId,
    railId: record.railId,
    amountCents: record.amountCents,
    currency: record.currency,
    customerId: record.customerId,
    paymentMethodId: record.paymentMethodId,
    destinationAccountId: record.destinationAccountId,
  };
}

/** The record belongs to this rail, mode and platform account. */
export function stripeRecordInScope(record: StripePaymentReservationRecord, configuration: StripeRailConfiguration, executionId: string): boolean {
  return record.executionId === executionId && record.railId === configuration.railId && record.mode === configuration.mode && record.platformAccountId === configuration.platformAccountId;
}

/** The reader proves it acts as the platform account the reservation bound, in test mode — or it proves nothing. */
export async function stripeReaderIsBoundAccount(stripe: StripePaymentReader, record: StripePaymentReservationRecord, timeoutMs: number): Promise<boolean> {
  const account = readStripeAccountView(await stripe.retrieveAccount(timeoutMs));
  return account !== undefined && !account.livemode && account.accountId === record.platformAccountId;
}

/**
 * PAY-09 — the Stripe rail's P12 `ExecutionResolutionAuthority`: read-only,
 * conservative, composed into the **existing** P12 flow unchanged (no second
 * reconciliation model, no timer, no Stripe word in P12's contract).
 *
 * Given an uncertain execution, it reads the interlock record (reservation
 * and binding, both written before the confirmation), proves the reader acts
 * as **the platform account the reservation bound**, and retrieves **the bound
 * PaymentIntent by its exact id** — never a search, never metadata:
 *
 * | Stripe answer for the bound PaymentIntent | P12 answer |
 * | --- | --- |
 * | `succeeded`, every bound term exact, `amount_received` = `amount` | `resolved / confirmed-completed`, ref = PaymentIntent id |
 * | `requires_payment_method` with a payment error; `canceled` | `resolved / confirmed-not-completed PROVIDER_REJECTED` |
 * | `processing`, `requires_action`, `requires_confirmation`, `requires_capture`; not found; unreachable; unreadable; any term different | `unresolved` |
 * | a reader for **another account** (or a live-mode reader) — whatever it answers | `unresolved` |
 * | no record, a record of another rail / mode / platform, no PaymentIntent bound, or one that disagrees with the P11 attempt (handle, asset, amount) | `unresolved` |
 *
 * **Another account proves nothing.** PaymentIntent ids live in one account;
 * a reader composed with another account's key — or another deployment's
 * configuration — can neither complete nor fail this execution.
 *
 * **Absence is never evidence.** A PaymentIntent Stripe does not find, and an
 * execution reserved but never bound, are `unresolved` — never "not
 * completed". (A reservation without a binding can only follow a crash before
 * the confirmation was sent: the binding precedes it. An operator may resolve
 * it through PROD-03-02 once satisfied; P12 does not infer it.)
 *
 * It **never** creates, confirms, captures, cancels, refunds or retries — it
 * holds a `StripePaymentReader`, which has no such operation — and is asked
 * only from an explicit reconciliation.
 */
export function createStripeResolutionAuthority(options: StripeResolutionAuthorityOptions): ExecutionResolutionAuthority {
  const configuration = options?.configuration;
  if (!isStripeRailConfiguration(configuration)) throw new TypeError('The Stripe resolution authority needs a validated rail configuration.');
  const stripe = options.stripe;
  for (const method of ['retrieveAccount', 'retrievePaymentIntent'] as const) {
    if (typeof stripe?.[method] !== 'function') throw new TypeError(`The Stripe resolution authority's reader must implement ${method}.`);
  }
  const interlock = options.interlock;
  if (typeof interlock?.read !== 'function') throw new TypeError('The Stripe resolution authority needs read access to the interlock.');
  const timeout = configuration.requestTimeoutMs;

  async function resolve(query: ExecutionResolutionQuery): Promise<ExecutionResolutionAuthorityResult> {
    let record: StripePaymentReservationRecord | undefined;
    try {
      record = await interlock.read(query.executionId);
    } catch {
      return UNRESOLVED;
    }
    if (record === undefined || !stripeRecordInScope(record, configuration, query.executionId)) return UNRESOLVED;
    const expected = stripeExpectedPaymentOf(record);
    if (expected === undefined) return UNRESOLVED;
    // The P11 attempt and the record must describe the same payment.
    if (query.providerRef !== undefined && query.providerRef !== expected.paymentIntentId) return UNRESOLVED;
    if (query.amount !== undefined && (query.amount.unit !== record.amountUnit || query.amount.value !== record.amountValue)) return UNRESOLVED;

    try {
      if (!(await stripeReaderIsBoundAccount(stripe, record, timeout))) return UNRESOLVED;
      const view = readStripePaymentIntentView(await stripe.retrievePaymentIntent(expected.paymentIntentId, timeout));
      const conclusion = concludeStripePayment(view, expected);
      const reference = { providerRef: expected.paymentIntentId };
      if (conclusion.kind === 'completed') return Object.freeze({ outcome: 'resolved', certainty: 'confirmed-completed', ...reference });
      if (conclusion.kind === 'failed') return Object.freeze({ outcome: 'resolved', certainty: 'confirmed-not-completed', failure: EXECUTION_FAILURE_REASONS.PROVIDER_REJECTED, ...reference });
      return UNRESOLVED;
    } catch {
      return UNRESOLVED;
    }
  }

  return Object.freeze({ authorityId: STRIPE_RESOLUTION_AUTHORITY_ID, resolve });
}
