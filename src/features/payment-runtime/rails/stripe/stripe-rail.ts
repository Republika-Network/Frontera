import { EXECUTION_FAILURE_REASONS, type ExecutionFailureReason } from '../../../execution-runtime/index.js';
import type { PaymentExecutionRequest, PaymentRail, PaymentRailResult } from '../../domain/index.js';
import { centsOfUsdDecimal } from './stripe-amount.js';
import { concludeStripePayment, stripePaymentMismatch, type StripeExpectedPayment } from './stripe-classification.js';
import { StripeRailConfigurationError, isStripeRailConfiguration, stripeFundingSourceOf, type StripeRailConfiguration } from './stripe-config.js';
import { parseStripeDestination } from './stripe-destination.js';
import { stripeIdempotencyKey } from './stripe-idempotency.js';
import type { StripePaymentInterlock, StripePaymentReservationInput, StripePaymentReservationRecord } from './stripe-payment-interlock.js';
import { StripeRequestNotSentError, readStripeAccountView, readStripePaymentIntentView, type StripePaymentPort } from './stripe-port.js';
import { STRIPE_RAIL_DETAILS, type StripeRailDetail } from './stripe-rail-details.js';

/**
 * A logger the host bridges to its own. Only bounded, non-secret fields are
 * logged: the rail id, the execution id, the PaymentIntent id and a detail
 * token — never an API key, a client secret, an amount, a Customer or
 * PaymentMethod id, or anything Stripe returned beyond those.
 */
export interface StripeRailLogger {
  info(message: string, fields?: Readonly<Record<string, unknown>>): void;
  warn(message: string, fields?: Readonly<Record<string, unknown>>): void;
}

export interface StripeRailOptions {
  readonly configuration: StripeRailConfiguration;
  /** The Stripe capability, including the one money-moving operation. The API key lives inside it (trusted composition), never here. */
  readonly stripe: StripePaymentPort;
  /** The durable interlock, written before the creation and again before the confirmation. Required: there is no Stripe rail without it. */
  readonly interlock: StripePaymentInterlock;
  readonly logger?: StripeRailLogger;
}

export type StripeRailReadiness = { readonly status: 'ready'; readonly mode: string } | { readonly status: 'unavailable'; readonly detail: StripeRailDetail };

/** A `PaymentRail`, plus readiness (the credential is the configured platform's, in test mode). Readiness never creates or confirms anything. */
export interface StripeRail extends PaymentRail {
  readiness(): Promise<StripeRailReadiness>;
}

const F = EXECUTION_FAILURE_REASONS;
const D = STRIPE_RAIL_DETAILS;

/** Thrown before the confirmation to leave with a definitive refusal. Never escapes the rail. */
class Refusal {
  constructor(
    readonly reason: ExecutionFailureReason,
    readonly detail: StripeRailDetail,
    readonly paymentIntentId?: string,
  ) {}
}

interface Prepared {
  readonly amountCents: bigint;
  readonly customerId: string;
  readonly paymentMethodId: string;
  readonly destinationAccountId: string;
}

/**
 * The Stripe fiat rail (PAY-09) — Frontera's first fiat rail, implementing
 * PAY-01's `PaymentRail` unchanged.
 *
 * One governed payment becomes at most one Stripe **destination charge**: a
 * PaymentIntent on the trusted platform account, in USD, `capture_method=
 * automatic`, card only, `confirmation_method=manual`, charging the governed
 * source's saved PaymentMethod off-session and transferring the full governed
 * amount to the governed connected account. Composed by the embedder through
 * `createPaymentRailExecutionAdapter` and reachable no other way: it receives a
 * `PaymentExecutionRequest` only after the governed path decided, granted,
 * reserved P7 capacity and claimed the execution. It decides nothing.
 *
 * ## Per execution
 *
 * ```
 * prepare    asset = USD; amount → exact cents within the configured bounds; source → trusted Customer + PaymentMethod;
 *            destination → a configured connected account                                                      refusal → not-completed
 * interlock  an execution already recorded is NEVER created or confirmed again                                   → unconfirmed
 * account    the credential's account is the configured platform, in test mode (read only)                      refusal → not-completed
 * RESERVE    durable, CORE-07-anchored: every term, the platform account, the idempotency correlation           refusal → not-completed
 * create     POST PaymentIntent, confirm=false — cannot move money; the answer must restate every term          refusal → not-completed
 * BIND       durable: this execution ↔ this PaymentIntent id, before anything can charge                         refusal → not-completed
 * confirm    ONCE: off_session, error_on_requires_action — the only money-moving request                         see below
 * ```
 *
 * ## Outcome (P11)
 *
 * | what Stripe proved | `PaymentRailResult` |
 * | --- | --- |
 * | `succeeded`, every term exact, `amount_received` = `amount` | `completed`, ref = PaymentIntent id |
 * | `requires_payment_method` with a payment error, or `canceled` | `not-completed` `PROVIDER_REJECTED` |
 * | the confirmation provably never left the process | `not-completed` `PROVIDER_UNAVAILABLE` |
 * | `processing`, `requires_action`, `requires_confirmation`; a timeout, a reset, a 5xx; an unreadable or inconsistent answer | `unconfirmed`, ref = PaymentIntent id |
 *
 * ## No retry
 *
 * `stripe.confirmPaymentIntent` is called from exactly one place, at most once
 * per `execute`, never for an execution the interlock already holds, and
 * never after an ambiguous answer. P12 resolves ambiguity by reading the bound
 * PaymentIntent; nothing re-confirms it.
 */
export function createStripeRail(options: StripeRailOptions): StripeRail {
  const configuration = options?.configuration;
  if (!isStripeRailConfiguration(configuration)) throw new StripeRailConfigurationError('configuration', 'must come from createStripeRailConfiguration');
  const stripe = options.stripe;
  for (const method of ['retrieveAccount', 'retrievePaymentIntent', 'createPaymentIntent', 'confirmPaymentIntent'] as const) {
    if (typeof stripe?.[method] !== 'function') throw new StripeRailConfigurationError('stripe', `must implement ${method}`);
  }
  const interlock = options.interlock;
  if (typeof interlock?.recorded !== 'function' || typeof interlock.reserve !== 'function' || typeof interlock.bind !== 'function') {
    throw new StripeRailConfigurationError('interlock', 'must implement recorded, reserve and bind — the rail never moves money without durable reservations');
  }
  const logger = options.logger;
  const railId = configuration.railId;
  const timeout = configuration.requestTimeoutMs;

  const log = (level: 'info' | 'warn', event: string, fields: Readonly<Record<string, unknown>>): void => {
    try {
      logger?.[level](event, { railId, ...fields });
    } catch {
      // A logger defect never changes a payment outcome.
    }
  };

  /** Pure: what the governed request and trusted configuration alone determine. */
  function prepare(request: PaymentExecutionRequest): Prepared {
    if (request.amount.unit !== configuration.asset.paymentAsset) throw new Refusal(F.ADAPTER_ERROR, D.ASSET_UNSUPPORTED);
    const amountCents = centsOfUsdDecimal(request.amount.value);
    if (amountCents === undefined) throw new Refusal(F.ADAPTER_ERROR, D.AMOUNT_UNREPRESENTABLE);
    if (amountCents < configuration.minimumChargeCents) throw new Refusal(F.ADAPTER_ERROR, D.AMOUNT_BELOW_MINIMUM);
    if (amountCents > configuration.maximumChargeCents) throw new Refusal(F.ADAPTER_ERROR, D.AMOUNT_ABOVE_MAXIMUM);
    const funding = stripeFundingSourceOf(configuration, request.source.accountId);
    if (funding === undefined) throw new Refusal(F.ADAPTER_ERROR, D.SOURCE_UNMAPPED);
    const destinationAccountId = parseStripeDestination(request.destination);
    if (destinationAccountId === undefined) throw new Refusal(F.ADAPTER_ERROR, D.DESTINATION_INVALID);
    if (!configuration.connectedAccounts.includes(destinationAccountId)) throw new Refusal(F.ADAPTER_ERROR, D.DESTINATION_NOT_CONFIGURED);
    return { amountCents, customerId: funding.customerId, paymentMethodId: funding.paymentMethodId, destinationAccountId };
  }

  /** The credential belongs to the configured platform account, in test mode. Reads only. */
  async function checkAccount(): Promise<string> {
    let account: ReturnType<typeof readStripeAccountView>;
    try {
      account = readStripeAccountView(await stripe.retrieveAccount(timeout));
    } catch {
      throw new Refusal(F.PROVIDER_UNAVAILABLE, D.ACCOUNT_UNAVAILABLE);
    }
    if (account === undefined) throw new Refusal(F.PROVIDER_RESPONSE_INVALID, D.ACCOUNT_UNAVAILABLE);
    if (account.livemode) throw new Refusal(F.ADAPTER_ERROR, D.LIVE_MODE_REFUSED);
    if (account.accountId !== configuration.platformAccountId) throw new Refusal(F.ADAPTER_ERROR, D.ACCOUNT_MISMATCH);
    return account.accountId;
  }

  function expectedOf(record: StripePaymentReservationInput, paymentIntentId: string): StripeExpectedPayment {
    return {
      paymentIntentId,
      executionId: record.executionId,
      railId: record.railId,
      amountCents: record.amountCents,
      currency: record.currency,
      customerId: record.customerId,
      paymentMethodId: record.paymentMethodId,
      destinationAccountId: record.destinationAccountId,
    };
  }

  function unconfirmed(request: PaymentExecutionRequest, paymentIntentId: string | undefined, detail: StripeRailDetail): PaymentRailResult {
    log('warn', 'stripe.payment.unconfirmed', { executionId: request.executionId, ...(paymentIntentId !== undefined ? { paymentIntentId } : {}), detail });
    return { status: 'unconfirmed', ...(paymentIntentId !== undefined ? { externalReference: paymentIntentId } : {}), detail };
  }

  /** An execution the interlock already holds: never created or confirmed again; `unconfirmed`, with the PaymentIntent it is bound to when there is one. */
  function previously(request: PaymentExecutionRequest, record: StripePaymentReservationRecord, prepared: Prepared): PaymentRailResult {
    const same = record.amountCents === prepared.amountCents && record.destinationAccountId === prepared.destinationAccountId && record.sourceAccountId === request.source.accountId;
    return unconfirmed(request, record.paymentIntentId, same ? D.EXECUTION_PREVIOUSLY_INITIATED : D.EXECUTION_TERMS_CONFLICT);
  }

  /** The one confirmation, and what Stripe's answer proves. Never throws. */
  async function confirmOnce(request: PaymentExecutionRequest, record: StripePaymentReservationInput, paymentIntentId: string): Promise<PaymentRailResult> {
    let answer: unknown;
    try {
      answer = await withDeadline(
        stripe.confirmPaymentIntent(Object.freeze({ paymentIntentId, idempotencyKey: record.confirmIdempotencyKey, timeoutMs: configuration.confirmTimeoutMs })),
        configuration.confirmTimeoutMs + configuration.requestTimeoutMs,
      );
    } catch (error) {
      if (error instanceof StripeRequestNotSentError) {
        log('warn', 'stripe.payment.failed', { executionId: request.executionId, paymentIntentId, detail: D.CONFIRM_NOT_SENT });
        return { status: 'not-completed', reason: F.PROVIDER_UNAVAILABLE, externalReference: paymentIntentId, detail: D.CONFIRM_NOT_SENT };
      }
      return unconfirmed(request, paymentIntentId, D.CONFIRM_OUTCOME_UNKNOWN);
    }
    const view = readStripePaymentIntentView(answer);
    if (view === undefined) return unconfirmed(request, paymentIntentId, D.ANSWER_UNREADABLE);
    const conclusion = concludeStripePayment(view, expectedOf(record, paymentIntentId));
    switch (conclusion.kind) {
      case 'completed':
        log('info', 'stripe.payment.completed', { executionId: request.executionId, paymentIntentId });
        return { status: 'completed', externalReference: paymentIntentId };
      case 'failed':
        log('warn', 'stripe.payment.failed', { executionId: request.executionId, paymentIntentId, detail: conclusion.detail });
        return { status: 'not-completed', reason: F.PROVIDER_REJECTED, externalReference: paymentIntentId, detail: conclusion.detail };
      case 'pending':
      case 'inconsistent':
        return unconfirmed(request, paymentIntentId, conclusion.detail);
      case 'unknown':
        return unconfirmed(request, paymentIntentId, D.ANSWER_INCONSISTENT);
    }
  }

  async function execute(request: PaymentExecutionRequest): Promise<PaymentRailResult> {
    let record: StripePaymentReservationInput;
    let paymentIntentId: string;
    try {
      const prepared = prepare(request);
      // ─── an execution the interlock already holds is never created or confirmed again ───
      let earlier: StripePaymentReservationRecord | undefined;
      try {
        earlier = await interlock.recorded(request.executionId);
      } catch {
        throw new Refusal(F.ADAPTER_ERROR, D.INTERLOCK_UNAVAILABLE);
      }
      if (earlier !== undefined) return previously(request, earlier, prepared);
      const platformAccountId = await checkAccount();
      record = Object.freeze({
        executionId: request.executionId,
        railId,
        mode: configuration.mode,
        // Bound for good: only a reader proving this account may later establish what happened (P12, PAY-05).
        platformAccountId,
        sourceAccountId: request.source.accountId,
        customerId: prepared.customerId,
        paymentMethodId: prepared.paymentMethodId,
        destinationAccountId: prepared.destinationAccountId,
        amountValue: request.amount.value,
        amountUnit: request.amount.unit,
        amountCents: prepared.amountCents,
        currency: configuration.currency,
        createIdempotencyKey: stripeIdempotencyKey(railId, request.executionId, 'create'),
        confirmIdempotencyKey: stripeIdempotencyKey(railId, request.executionId, 'confirm'),
      });
      // ─── durable before anything exists at Stripe, or nothing ───
      let reservation: Awaited<ReturnType<StripePaymentInterlock['reserve']>>;
      try {
        reservation = await interlock.reserve(record);
      } catch {
        throw new Refusal(F.ADAPTER_ERROR, D.INTERLOCK_UNAVAILABLE);
      }
      if (reservation?.outcome === 'execution-recorded') return previously(request, reservation.record, prepared);
      if (reservation?.outcome !== 'reserved') throw new Refusal(F.ADAPTER_ERROR, D.INTERLOCK_UNAVAILABLE);
      log('info', 'stripe.payment.reserved', { executionId: request.executionId });
      // ─── create: confirm=false, so nothing here can charge ───
      let created: unknown;
      try {
        created = await stripe.createPaymentIntent(
          Object.freeze({
            amountCents: record.amountCents,
            currency: record.currency,
            customerId: record.customerId,
            paymentMethodId: record.paymentMethodId,
            destinationAccountId: record.destinationAccountId,
            executionId: record.executionId,
            railId,
            idempotencyKey: record.createIdempotencyKey,
            timeoutMs: timeout,
          }),
        );
      } catch {
        throw new Refusal(F.PROVIDER_UNAVAILABLE, D.CREATE_FAILED);
      }
      const view = readStripePaymentIntentView(created);
      if (view === undefined) throw new Refusal(F.PROVIDER_RESPONSE_INVALID, D.CREATE_FAILED);
      // Stripe must restate exactly what was asked, and the object must not have been confirmed by anyone.
      if (stripePaymentMismatch(view, expectedOf(record, view.id)) !== undefined || view.status !== 'requires_confirmation') throw new Refusal(F.ADAPTER_ERROR, D.CREATED_OBJECT_MISMATCH, view.id);
      paymentIntentId = view.id;
      // ─── durable binding before the one request that can move money ───
      let binding: Awaited<ReturnType<StripePaymentInterlock['bind']>>;
      try {
        binding = await interlock.bind(request.executionId, paymentIntentId);
      } catch {
        throw new Refusal(F.ADAPTER_ERROR, D.BINDING_UNAVAILABLE, paymentIntentId);
      }
      if (binding?.outcome === 'execution-bound') return unconfirmed(request, binding.paymentIntentId, D.EXECUTION_PREVIOUSLY_INITIATED);
      if (binding?.outcome === 'payment-intent-bound-elsewhere') throw new Refusal(F.ADAPTER_ERROR, D.PAYMENT_INTENT_BOUND_ELSEWHERE, paymentIntentId);
      if (binding?.outcome !== 'bound') throw new Refusal(F.ADAPTER_ERROR, D.BINDING_UNAVAILABLE, paymentIntentId);
      log('info', 'stripe.payment.bound', { executionId: request.executionId, paymentIntentId });
    } catch (error) {
      // Reached only before the confirmation: no request that can move money has left this process.
      const refusal = error instanceof Refusal ? error : new Refusal(F.ADAPTER_ERROR, D.RAIL_ERROR_BEFORE_CONFIRM);
      log('warn', 'stripe.payment.failed', { executionId: request.executionId, detail: refusal.detail });
      return { status: 'not-completed', reason: refusal.reason, ...(refusal.paymentIntentId !== undefined ? { externalReference: refusal.paymentIntentId } : {}), detail: refusal.detail };
    }
    // ─── the one confirmation ───
    return confirmOnce(request, record, paymentIntentId);
  }

  async function readiness(): Promise<StripeRailReadiness> {
    try {
      const account = readStripeAccountView(await stripe.retrieveAccount(timeout));
      if (account === undefined) return { status: 'unavailable', detail: D.ACCOUNT_UNAVAILABLE };
      if (account.livemode) return { status: 'unavailable', detail: D.LIVE_MODE_REFUSED };
      if (account.accountId !== configuration.platformAccountId) return { status: 'unavailable', detail: D.ACCOUNT_MISMATCH };
      return { status: 'ready', mode: configuration.mode };
    } catch {
      return { status: 'unavailable', detail: D.ACCOUNT_UNAVAILABLE };
    }
  }

  return Object.freeze({ railId, execute, readiness });
}

/** Stops waiting — never stops Stripe. An adapter that does not honour its own deadline still cannot hold the execution forever. */
function withDeadline<T>(work: Promise<T>, milliseconds: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    // Not unref'd: this deadline decides a payment's recorded outcome, so it holds the process until it fires.
    const timer = setTimeout(() => reject(new Error('deadline')), milliseconds);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
