import { createHmac, timingSafeEqual } from 'node:crypto';

import { isStripeAccountId, isStripeEventId, isStripePaymentIntentId } from '../../features/payment-runtime/rails/stripe/index.js';

/**
 * PAY-09 — the Stripe webhook **signal** boundary: authenticated, asynchronous
 * hints that a bound PaymentIntent may have changed — never authority, never
 * a resolution, never a money effect.
 *
 * ## What a signal can do
 *
 * Name an execution whose bound PaymentIntent Stripe says changed, so the
 * embedder may run the **existing** P12 reconciliation (which retrieves the
 * PaymentIntent by its exact id, re-binds every term and the platform
 * account, and decides) — or PAY-05 verification, which does the same. That is
 * all. This module holds no Stripe client at all — no create, no confirm, no
 * capture, no refund, no transfer — and writes nothing: a webhook can never
 * cause, repeat or undo a payment, and a webhook alone can never mark one
 * completed, failed or settled.
 *
 * ## Verification before belief (Stripe: "Verify webhook signatures manually")
 *
 * In this order, on the **exact raw request bytes** — nothing is parsed,
 * decoded or re-serialized before the signature holds:
 *
 * 1. the raw body is bounded (64 KiB default) — larger is refused unread;
 * 2. `Stripe-Signature` is split into `t` and every `v1` (other schemes,
 *    `v0` included, are ignored: "ignore all schemes that aren't v1");
 * 3. `t` is within the tolerance of this host's clock (300 s, Stripe's
 *    library default; never 0) — a replayed old delivery is refused;
 * 4. HMAC-SHA256 with the endpoint secret over `"<t>." ‖ raw body`, compared
 *    in constant time with each `v1`; one match is required;
 * 5. only then is the body decoded (fatal UTF-8) and parsed (bounded JSON):
 *    a snapshot `event`, test mode (`livemode: false`), not from a connected
 *    account (destination charges' PaymentIntents live on the platform), a
 *    handled `payment_intent.*` type, a PaymentIntent id.
 *
 * ## Delivery is at least once, and unordered
 *
 * Event ids are deduplicated in a bounded memory window (a duplicate is
 * answered `duplicate`), but that is delivery hygiene, not payment
 * idempotency: the interlock and P12's write-once resolution are what make a
 * payment's outcome happen once. Stripe "doesn't guarantee the delivery of
 * events in the order that they're generated": a signal carries no status,
 * and the order of arrival is never read as the order of events — P12
 * retrieves the current PaymentIntent every time.
 *
 * ## The signing secret
 *
 * `whsec_…`, held in this closure only — never persisted, logged, returned or
 * placed in an error. Refusals are closed reasons that never echo the header,
 * the body or a computed digest.
 */

export const STRIPE_WEBHOOK_HANDLED_TYPES = ['payment_intent.succeeded', 'payment_intent.payment_failed', 'payment_intent.canceled', 'payment_intent.processing', 'payment_intent.requires_action'] as const;

export const STRIPE_WEBHOOK_DEFAULTS = Object.freeze({ toleranceSeconds: 300, maximumBodyBytes: 64 * 1024, deduplicationWindow: 10_000 });

export type StripeWebhookRefusal =
  | 'body-missing'
  | 'body-too-large'
  | 'signature-missing'
  | 'signature-malformed'
  | 'signature-invalid'
  | 'timestamp-outside-tolerance'
  | 'payload-malformed'
  | 'live-mode-event'
  | 'connected-account-event';

export type StripeWebhookSignal =
  /** Not from Stripe, not this endpoint's, too old, or not readable. Nothing believed. */
  | { readonly outcome: 'refused'; readonly reason: StripeWebhookRefusal }
  /** This event id was already signalled inside the window. */
  | { readonly outcome: 'duplicate'; readonly eventId: string }
  /** Authentic, but nothing Frontera binds: another event type, or a PaymentIntent no execution holds. */
  | { readonly outcome: 'ignored'; readonly eventId: string; readonly reason: 'event-type-unhandled' | 'payment-intent-unbound' }
  /** Authentic, but the interlock could not be read: nothing concluded, and the event id is forgotten so a redelivery is examined again. */
  | { readonly outcome: 'deferred'; readonly eventId: string }
  /** Authentic, about a bound PaymentIntent: the embedder MAY reconcile this execution through P12. A hint — never a resolution. */
  | { readonly outcome: 'reconcile-hint'; readonly eventId: string; readonly executionId: string; readonly paymentIntentId: string };

export interface StripeWebhookInterlockAccess {
  executionOfPaymentIntent(paymentIntentId: string): Promise<string | undefined>;
}

export interface StripeWebhookSignalOptions {
  /** The endpoint's signing secret (`whsec_…`). Kept in this module's closure only. */
  readonly signingSecret: string;
  /** Read only: which execution a PaymentIntent is bound to. */
  readonly interlock: StripeWebhookInterlockAccess;
  /** This host's clock, in Unix seconds. Injected for deterministic qualification. */
  readonly nowSeconds?: () => number;
  readonly toleranceSeconds?: number;
  readonly maximumBodyBytes?: number;
  readonly deduplicationWindow?: number;
}

export interface StripeWebhookDelivery {
  /** The exact bytes Stripe sent. Never a parsed or re-serialized body. */
  readonly rawBody: Uint8Array;
  /** The `Stripe-Signature` header value. */
  readonly signatureHeader: string | undefined;
}

export interface StripeWebhookSignals {
  receive(delivery: StripeWebhookDelivery): Promise<StripeWebhookSignal>;
}

export class StripeWebhookConfigurationError extends Error {
  readonly code = 'STRIPE_WEBHOOK_CONFIGURATION_INVALID';

  constructor(message: string) {
    super(message);
    this.name = 'StripeWebhookConfigurationError';
  }
}

const SECRET = /^whsec_[A-Za-z0-9+/=]{16,240}$/;
const MAXIMUM_HEADER_LENGTH = 4096;
const HEX_SIGNATURE = /^[0-9a-f]{64}$/;
const TIMESTAMP = /^[1-9][0-9]{0,11}$/;

const refused = (reason: StripeWebhookRefusal): StripeWebhookSignal => Object.freeze({ outcome: 'refused', reason });

function own(record: unknown, key: string): unknown {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined;
}

function integerIn(name: string, value: unknown, minimum: number, maximum: number, fallback: number): number {
  const chosen = value ?? fallback;
  if (typeof chosen !== 'number' || !Number.isSafeInteger(chosen) || chosen < minimum || chosen > maximum) throw new StripeWebhookConfigurationError(`The Stripe webhook ${name} must be an integer from ${minimum} to ${maximum}.`);
  return chosen;
}

/** `t=…,v1=…[,v1=…][,v0=…]` → the timestamp and every well-formed v1 signature, or `undefined`. */
function parseSignatureHeader(header: string): { readonly timestamp: string; readonly signatures: readonly Buffer[] } | undefined {
  let timestamp: string | undefined;
  const signatures: Buffer[] = [];
  for (const element of header.split(',')) {
    const separator = element.indexOf('=');
    if (separator <= 0) continue;
    const prefix = element.slice(0, separator).trim();
    const value = element.slice(separator + 1).trim();
    if (prefix === 't') {
      if (timestamp !== undefined || !TIMESTAMP.test(value)) return undefined;
      timestamp = value;
    } else if (prefix === 'v1' && HEX_SIGNATURE.test(value)) {
      signatures.push(Buffer.from(value, 'hex'));
    }
  }
  return timestamp === undefined || signatures.length === 0 ? undefined : { timestamp, signatures };
}

export function createStripeWebhookSignals(options: StripeWebhookSignalOptions): StripeWebhookSignals {
  const secret: unknown = options?.signingSecret;
  if (typeof secret !== 'string' || !SECRET.test(secret)) throw new StripeWebhookConfigurationError('The Stripe webhook signing secret must be an endpoint secret (whsec_…).');
  const interlock = options.interlock;
  if (typeof interlock?.executionOfPaymentIntent !== 'function') throw new StripeWebhookConfigurationError('The Stripe webhook signals need read access to the interlock.');
  const toleranceSeconds = integerIn('tolerance', options.toleranceSeconds, 1, 3_600, STRIPE_WEBHOOK_DEFAULTS.toleranceSeconds);
  const maximumBodyBytes = integerIn('maximum body size', options.maximumBodyBytes, 1_024, 1024 * 1024, STRIPE_WEBHOOK_DEFAULTS.maximumBodyBytes);
  const window = integerIn('deduplication window', options.deduplicationWindow, 1, 1_000_000, STRIPE_WEBHOOK_DEFAULTS.deduplicationWindow);
  const nowSeconds = options.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
  // Held in this closure only.
  const key = Buffer.from(secret, 'utf8');
  const seen = new Set<string>();

  function remember(eventId: string): boolean {
    if (seen.has(eventId)) return false;
    seen.add(eventId);
    if (seen.size > window) {
      const oldest = seen.values().next().value;
      if (oldest !== undefined) seen.delete(oldest);
    }
    return true;
  }

  function authentic(rawBody: Uint8Array, header: string): StripeWebhookRefusal | undefined {
    const parsed = parseSignatureHeader(header);
    if (parsed === undefined) return 'signature-malformed';
    const sent = Number.parseInt(parsed.timestamp, 10);
    if (Math.abs(nowSeconds() - sent) > toleranceSeconds) return 'timestamp-outside-tolerance';
    const expected = createHmac('sha256', key).update(`${parsed.timestamp}.`, 'utf8').update(rawBody).digest();
    let matched = false;
    for (const signature of parsed.signatures) {
      // Every candidate is compared, in constant time, whatever an earlier one answered.
      if (timingSafeEqual(signature, expected)) matched = true;
    }
    return matched ? undefined : 'signature-invalid';
  }

  async function receive(delivery: StripeWebhookDelivery): Promise<StripeWebhookSignal> {
    const rawBody: unknown = delivery?.rawBody;
    if (!(rawBody instanceof Uint8Array) || rawBody.length === 0) return refused('body-missing');
    if (rawBody.length > maximumBodyBytes) return refused('body-too-large');
    const header: unknown = delivery.signatureHeader;
    if (typeof header !== 'string' || header.length === 0) return refused('signature-missing');
    if (header.length > MAXIMUM_HEADER_LENGTH) return refused('signature-malformed');
    const problem = authentic(rawBody, header);
    if (problem !== undefined) return refused(problem);

    // ─── authentic: only now is the body decoded and parsed ───
    let event: unknown;
    try {
      event = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(rawBody)) as unknown;
    } catch {
      return refused('payload-malformed');
    }
    const eventId = own(event, 'id');
    if (own(event, 'object') !== 'event' || !isStripeEventId(eventId) || typeof own(event, 'type') !== 'string') return refused('payload-malformed');
    if (own(event, 'livemode') !== false) return refused('live-mode-event');
    const account = own(event, 'account');
    if (account !== undefined && account !== null) return isStripeAccountId(account) ? refused('connected-account-event') : refused('payload-malformed');
    if (!remember(eventId)) return Object.freeze({ outcome: 'duplicate', eventId });
    const type = own(event, 'type') as string;
    if (!(STRIPE_WEBHOOK_HANDLED_TYPES as readonly string[]).includes(type)) return Object.freeze({ outcome: 'ignored', eventId, reason: 'event-type-unhandled' });
    const object = own(own(event, 'data'), 'object');
    const paymentIntentId = own(object, 'id');
    if (own(object, 'object') !== 'payment_intent' || !isStripePaymentIntentId(paymentIntentId)) return refused('payload-malformed');
    let executionId: string | undefined;
    try {
      executionId = await interlock.executionOfPaymentIntent(paymentIntentId);
    } catch {
      seen.delete(eventId);
      return Object.freeze({ outcome: 'deferred', eventId });
    }
    if (executionId === undefined) return Object.freeze({ outcome: 'ignored', eventId, reason: 'payment-intent-unbound' });
    return Object.freeze({ outcome: 'reconcile-hint', eventId, executionId, paymentIntentId });
  }

  return Object.freeze({ receive });
}
