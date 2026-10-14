import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { STRIPE_WEBHOOK_DEFAULTS, StripeWebhookConfigurationError, createStripeWebhookSignals, type StripeWebhookSignal } from '../stripe-payment-rail/stripe-webhook-signals.js';

/**
 * PAY-09 — the Stripe webhook signal boundary (WH-1 … WH-10): verified on the
 * exact raw bytes before anything is parsed, deduplicated, never ordered,
 * never a resolution and never a money effect.
 *
 * The signature scheme is Stripe's documented one ("Verify webhook signatures
 * manually"). It was additionally cross-checked, outside this repository,
 * against `stripe-node` 23.0.0's own `webhooks.generateTestHeaderString`
 * (docs/payments/PAY-09-STRIPE-FIAT-RAIL.md §14).
 */

/** A canary in the shape of an endpoint signing secret. */
const SECRET = 'whsec_FRONTERAWEBHOOKCANARY9f36a07b2d85';
const NOW = 1_791_900_000;
const BOUND: Readonly<Record<string, string>> = Object.freeze({ pi_3Bound: 'exec-bound' });

function signals(overrides: Partial<Parameters<typeof createStripeWebhookSignals>[0]> = {}) {
  const lookups: string[] = [];
  const receiver = createStripeWebhookSignals({
    signingSecret: SECRET,
    interlock: {
      async executionOfPaymentIntent(paymentIntentId: string) {
        lookups.push(paymentIntentId);
        return BOUND[paymentIntentId];
      },
    },
    nowSeconds: () => NOW,
    ...overrides,
  });
  return { receiver, lookups };
}

function event(overrides: Record<string, unknown> = {}, object: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: 'evt_1Wh',
    object: 'event',
    api_version: '2026-09-30.endive',
    created: NOW,
    livemode: false,
    type: 'payment_intent.succeeded',
    data: { object: { id: 'pi_3Bound', object: 'payment_intent', status: 'succeeded', client_secret: 'pi_3Bound_secret_x', ...object } },
    ...overrides,
  });
}

/** Stripe's scheme: t=<seconds>,v1=HMAC-SHA256(secret, "<t>." ‖ raw body). */
function sign(body: string, options: { readonly secret?: string; readonly at?: number; readonly extra?: string } = {}): string {
  const at = options.at ?? NOW;
  const v1 = createHmac('sha256', options.secret ?? SECRET).update(`${at}.${body}`, 'utf8').digest('hex');
  return `t=${at},v1=${v1}${options.extra ?? ''}`;
}

const bytes = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, 'utf8'));

describe('PAY-09 webhooks — signature verification on the raw body (WH-1 … WH-3)', () => {
  it('WH-1 a valid signature over the exact bytes → a reconcile hint for the bound execution — a hint, never a resolution', async () => {
    const { receiver } = signals();
    const body = event();
    const signal = await receiver.receive({ rawBody: bytes(body), signatureHeader: sign(body) });
    assert.deepEqual(signal, { outcome: 'reconcile-hint', eventId: 'evt_1Wh', executionId: 'exec-bound', paymentIntentId: 'pi_3Bound' });
    assert.deepEqual(Object.keys(signal).sort(), ['eventId', 'executionId', 'outcome', 'paymentIntentId'], 'no status, no amount, no certainty: the signal carries nothing P12 could take as an answer');
  });

  it('WH-2 an invalid signature (another secret, a truncated or non-hex v1, no v1, no t) → refused; nothing is parsed', async () => {
    const { receiver, lookups } = signals();
    const body = event();
    const refusals: [string, string][] = [
      [sign(body, { secret: 'whsec_SomeOtherEndpointSecret000' }), 'signature-invalid'],
      [sign(body).slice(0, -2), 'signature-malformed'],
      [`t=${NOW},v1=${'z'.repeat(64)}`, 'signature-malformed'],
      [`t=${NOW}`, 'signature-malformed'],
      [sign(body).replace(/^t=\d+,/, ''), 'signature-malformed'],
      [`t=abc,v1=${'0'.repeat(64)}`, 'signature-malformed'],
    ];
    for (const [header, reason] of refusals) assert.deepEqual(await receiver.receive({ rawBody: bytes(body), signatureHeader: header }), { outcome: 'refused', reason }, header);
    assert.deepEqual(await receiver.receive({ rawBody: bytes(body), signatureHeader: undefined }), { outcome: 'refused', reason: 'signature-missing' });
    assert.deepEqual(lookups, [], 'an unauthenticated body is never read');
  });

  it('WH-3 a modified raw body → refused: one byte changed, or the same JSON re-serialized (verification is over bytes, not meaning)', async () => {
    const { receiver } = signals();
    const body = event();
    const header = sign(body);
    for (const modified of [body.replace('"livemode":false', '"livemode":true '), JSON.stringify(JSON.parse(body), null, 2), `${body}\n`, body.replace('pi_3Bound', 'pi_3Other')]) {
      assert.deepEqual(await receiver.receive({ rawBody: bytes(modified), signatureHeader: header }), { outcome: 'refused', reason: 'signature-invalid' });
    }
  });

  it('only v1 is trusted: a v0 signature alone is refused; during secret rotation any one matching v1 among several is accepted', async () => {
    const { receiver } = signals();
    const body = event({ id: 'evt_1Rotation' });
    const v0 = createHmac('sha256', SECRET).update(`${NOW}.${body}`, 'utf8').digest('hex');
    assert.equal((await receiver.receive({ rawBody: bytes(body), signatureHeader: `t=${NOW},v0=${v0}` })).outcome, 'refused');
    const rotated = `t=${NOW},v1=${createHmac('sha256', 'whsec_PreviousSecretStillActive0').update(`${NOW}.${body}`, 'utf8').digest('hex')},v1=${v0},v0=${v0}`;
    assert.equal((await receiver.receive({ rawBody: bytes(body), signatureHeader: rotated })).outcome, 'reconcile-hint');
  });
});

describe('PAY-09 webhooks — replay, duplicates, scope (WH-4 … WH-6)', () => {
  it('WH-4 a replayed delivery outside the tolerance (300 s, never 0) → refused, however valid its signature', async () => {
    const { receiver } = signals();
    const body = event({ id: 'evt_1Old' });
    assert.equal(STRIPE_WEBHOOK_DEFAULTS.toleranceSeconds, 300);
    assert.deepEqual(await receiver.receive({ rawBody: bytes(body), signatureHeader: sign(body, { at: NOW - 301 }) }), { outcome: 'refused', reason: 'timestamp-outside-tolerance' });
    assert.deepEqual(await receiver.receive({ rawBody: bytes(body), signatureHeader: sign(body, { at: NOW + 301 }) }), { outcome: 'refused', reason: 'timestamp-outside-tolerance' });
    assert.equal((await receiver.receive({ rawBody: bytes(body), signatureHeader: sign(body, { at: NOW - 299 }) })).outcome, 'reconcile-hint');
    assert.throws(() => signals({ toleranceSeconds: 0 }), StripeWebhookConfigurationError);
  });

  it('WH-5 a duplicate event id → duplicate (at-least-once delivery); a new signature on a redelivery does not make it new', async () => {
    const { receiver, lookups } = signals();
    const body = event({ id: 'evt_1Dup' });
    assert.equal((await receiver.receive({ rawBody: bytes(body), signatureHeader: sign(body) })).outcome, 'reconcile-hint');
    assert.deepEqual(await receiver.receive({ rawBody: bytes(body), signatureHeader: sign(body, { at: NOW + 5 }) }), { outcome: 'duplicate', eventId: 'evt_1Dup' });
    assert.equal(lookups.length, 1);
  });

  it('WH-6 unrelated objects or accounts → nothing: an unbound PaymentIntent, another event type, a connected account’s event, a live event', async () => {
    const { receiver } = signals();
    const cases: [string, StripeWebhookSignal['outcome'], string][] = [
      [event({ id: 'evt_1Unbound' }, { id: 'pi_3Unrelated' }), 'ignored', 'payment-intent-unbound'],
      [event({ id: 'evt_1Charge', type: 'charge.refunded', data: { object: { id: 'ch_1', object: 'charge' } } }), 'ignored', 'event-type-unhandled'],
      [event({ id: 'evt_1Connected', account: 'acct_1ConnectedMerchant' }), 'refused', 'connected-account-event'],
      [event({ id: 'evt_1Live', livemode: true }), 'refused', 'live-mode-event'],
      [event({ id: 'evt_1Thin', object: 'v2.core.event' }), 'refused', 'payload-malformed'],
    ];
    for (const [body, outcome, reason] of cases) {
      const signal = await receiver.receive({ rawBody: bytes(body), signatureHeader: sign(body) });
      assert.equal(signal.outcome, outcome, body);
      assert.equal((signal as { reason?: string }).reason, reason, body);
    }
  });

  it('the interlock unreadable → deferred, and the event id is forgotten so the redelivery is examined again', async () => {
    let fail = true;
    const receiver = createStripeWebhookSignals({
      signingSecret: SECRET,
      nowSeconds: () => NOW,
      interlock: {
        async executionOfPaymentIntent(paymentIntentId: string) {
          if (fail) throw new Error('interlock unavailable');
          return BOUND[paymentIntentId];
        },
      },
    });
    const body = event({ id: 'evt_1Deferred' });
    assert.deepEqual(await receiver.receive({ rawBody: bytes(body), signatureHeader: sign(body) }), { outcome: 'deferred', eventId: 'evt_1Deferred' });
    fail = false;
    assert.equal((await receiver.receive({ rawBody: bytes(body), signatureHeader: sign(body) })).outcome, 'reconcile-hint');
  });
});

describe('PAY-09 webhooks — no money effect, no secret, bounded (WH-7 … WH-10)', () => {
  it('WH-7 / WH-8 a succeeded or failed signal causes no payment effect: the module holds no Stripe client and writes nothing', async () => {
    const { receiver, lookups } = signals();
    for (const [id, type] of [['evt_1Ok', 'payment_intent.succeeded'], ['evt_1Failed', 'payment_intent.payment_failed'], ['evt_1Canceled', 'payment_intent.canceled']] as const) {
      const body = event({ id, type });
      const signal = await receiver.receive({ rawBody: bytes(body), signatureHeader: sign(body) });
      assert.equal(signal.outcome, 'reconcile-hint', type);
    }
    assert.deepEqual(lookups, ['pi_3Bound', 'pi_3Bound', 'pi_3Bound'], 'reads only: one interlock lookup per event');
    const source = readFileSync('src/enterprise/stripe-payment-rail/stripe-webhook-signals.ts', 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
    assert.equal(/confirmPaymentIntent|createPaymentIntent|capture|refund|transfer|reserve\(|bind\(|reconcile\(|recordResolution|https|fetch\(/i.test(source), false, 'no effect, no resolution, no network');
    assert.deepEqual([...source.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1]).sort(), ['../../features/payment-runtime/rails/stripe/index.js', 'node:crypto']);
  });

  it('WH-9 the signing secret never appears in a signal, a refusal or a configuration error (canary)', async () => {
    const { receiver } = signals();
    const outputs: unknown[] = [];
    const body = event({ id: 'evt_1Canary' });
    outputs.push(await receiver.receive({ rawBody: bytes(body), signatureHeader: sign(body) }));
    outputs.push(await receiver.receive({ rawBody: bytes(body), signatureHeader: sign(body, { secret: 'whsec_wrongwrongwrongwrong00' }) }));
    for (const signingSecret of ['sk_test_notAWebhookSecret', 'whsec_short', '']) {
      try {
        signals({ signingSecret });
      } catch (error) {
        outputs.push(String((error as Error).message));
      }
    }
    const text = JSON.stringify(outputs);
    assert.equal(text.includes('FRONTERAWEBHOOKCANARY'), false);
    assert.equal(text.includes('whsec_'), true, 'the error names the expected shape only');
    assert.equal(text.includes('whsec_short'), false);
    assert.deepEqual(Object.keys(receiver), ['receive']);
  });

  it('WH-10 the raw body is bounded (64 KiB default) and refused unread above it; malformed UTF-8 or JSON after a valid signature is refused', async () => {
    const { receiver } = signals();
    const large = 'x'.repeat(STRIPE_WEBHOOK_DEFAULTS.maximumBodyBytes + 1);
    assert.deepEqual(await receiver.receive({ rawBody: bytes(large), signatureHeader: sign(large) }), { outcome: 'refused', reason: 'body-too-large' });
    assert.deepEqual(await receiver.receive({ rawBody: new Uint8Array(0), signatureHeader: sign('') }), { outcome: 'refused', reason: 'body-missing' });
    const invalidUtf8 = new Uint8Array([0x7b, 0xff, 0x7d]);
    const header = `t=${NOW},v1=${createHmac('sha256', SECRET).update(`${NOW}.`, 'utf8').update(invalidUtf8).digest('hex')}`;
    assert.deepEqual(await receiver.receive({ rawBody: invalidUtf8, signatureHeader: header }), { outcome: 'refused', reason: 'payload-malformed' });
    assert.deepEqual(await receiver.receive({ rawBody: bytes('{"id":'), signatureHeader: sign('{"id":') }), { outcome: 'refused', reason: 'payload-malformed' });
    assert.deepEqual(await receiver.receive({ rawBody: bytes('x'), signatureHeader: 'x'.repeat(5000) }), { outcome: 'refused', reason: 'signature-malformed' });
  });
});
