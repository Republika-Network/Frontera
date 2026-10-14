import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { STRIPE_API_VERSION, StripeRequestNotSentError, createStripeRail, readStripeAccountView, readStripePaymentIntentView, stripeDestinationOf } from '../../features/payment-runtime/rails/stripe/index.js';
import { CONNECTED_ACCOUNT, GOVERNED_ACCOUNT, PLATFORM_ACCOUNT, TEST_CUSTOMER, TEST_PAYMENT_METHOD, USD_ASSET, createMemoryStripeInterlock, testRailConfiguration } from '../../features/payment-runtime/rails/stripe/tests/stripe-test-fixtures.js';
import { STRIPE_API_ORIGIN, StripeApiConfigurationError, StripeApiError, createStripeApiClient, createStripeApiReader } from '../stripe-payment-rail/stripe-https-client.js';

/**
 * PAY-09 — the Stripe HTTPS adapter, exercised over the wire against a
 * loopback server playing Stripe's API v1 (the adapter's `testOrigin`, which
 * accepts nothing but a literal loopback IP). Checks the exact requests the
 * rail's money depends on, the closed copy of Stripe's JSON (never the
 * `client_secret`), the not-sent vs unknown boundary, redirects, bounds and
 * the API-key boundary.
 */

/** A canary in the shape of a Stripe test secret key. It must never appear anywhere but the Authorization header. */
const KEY = 'sk_test_FRONTERACANARY4c1e9a07b2d85f36PAY09';
const READ_KEY = 'rk_test_FRONTERAREADCANARY0b2d85f36';

interface Seen {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingMessage['headers'];
  readonly body: string;
}

type Handler = (seen: Seen, res: ServerResponse) => void;

const servers: Server[] = [];
after(async () => {
  for (const server of servers) await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function stripeServer(handler: Handler): Promise<{ readonly origin: string; readonly seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const entry = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString('utf8') };
      seen.push(entry);
      handler(entry, res);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

const json = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

/** A Stripe PaymentIntent JSON object as the API returns it — including fields the adapter must never copy. */
function stripeIntent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'pi_3Wire',
    object: 'payment_intent',
    amount: 7500,
    amount_capturable: 0,
    amount_received: 0,
    application_fee_amount: null,
    capture_method: 'automatic',
    client_secret: 'pi_3Wire_secret_CANARYCLIENTSECRET',
    confirmation_method: 'manual',
    currency: 'usd',
    customer: TEST_CUSTOMER,
    description: null,
    last_payment_error: null,
    latest_charge: null,
    livemode: false,
    metadata: { frontera_execution_id: 'exec-wire', frontera_rail_id: 'stripe-usd' },
    next_action: null,
    on_behalf_of: null,
    payment_method: TEST_PAYMENT_METHOD,
    payment_method_types: ['card'],
    receipt_email: 'payer@example.com',
    status: 'requires_confirmation',
    transfer_data: { destination: CONNECTED_ACCOUNT },
    ...overrides,
  };
}

const createInstruction = { amountCents: 7500n, currency: 'usd', customerId: TEST_CUSTOMER, paymentMethodId: TEST_PAYMENT_METHOD, destinationAccountId: CONNECTED_ACCOUNT, executionId: 'exec-wire', railId: 'stripe-usd', idempotencyKey: 'frontera:stripe-usd:exec-wire:create', timeoutMs: 2_000 } as const;
const confirmInstruction = { paymentIntentId: 'pi_3Wire', idempotencyKey: 'frontera:stripe-usd:exec-wire:confirm', timeoutMs: 2_000 } as const;

describe('PAY-09 HTTPS adapter — the credential boundary and the fixed origin', () => {
  it('only test-mode keys are accepted; live keys are refused at composition; the rail needs a secret key, a reader may hold a restricted one', () => {
    for (const apiKey of ['sk_live_abcdefghijkl', 'rk_live_abcdefghijkl', 'pk_test_abcdefghijkl', 'sk_test_', 'not-a-key', '', undefined]) {
      assert.throws(() => createStripeApiClient({ apiKey: apiKey as string }), StripeApiConfigurationError, String(apiKey));
      assert.throws(() => createStripeApiReader({ apiKey: apiKey as string }), StripeApiConfigurationError, String(apiKey));
    }
    assert.throws(() => createStripeApiClient({ apiKey: READ_KEY }), /restricted keys are for readers/);
    assert.doesNotThrow(() => createStripeApiReader({ apiKey: READ_KEY }));
    assert.doesNotThrow(() => createStripeApiClient({ apiKey: KEY }));
  });

  it('the origin is fixed at api.stripe.com; a test origin is only plain http to a literal loopback IP — never a host name, never https elsewhere', () => {
    assert.equal(STRIPE_API_ORIGIN, 'https://api.stripe.com');
    for (const testOrigin of ['http://localhost:1', 'https://api.stripe.com.evil.example', 'http://10.0.0.5:80', 'http://[::ffff:127.0.0.1]:1', 'http://127.0.0.1:1/v1', 'http://user:pass@127.0.0.1:1', 'file:///etc/passwd']) {
      assert.throws(() => createStripeApiClient({ apiKey: KEY, testOrigin }), StripeApiConfigurationError, testOrigin);
    }
    assert.doesNotThrow(() => createStripeApiClient({ apiKey: KEY, testOrigin: 'http://127.0.0.1:1' }));
  });

  it('the key is in no enumerable field, no error and no returned value (secret canary)', async () => {
    const client = createStripeApiClient({ apiKey: KEY, testOrigin: 'http://127.0.0.1:1' });
    assert.deepEqual(Object.keys(client).sort(), ['confirmPaymentIntent', 'createPaymentIntent', 'retrieveAccount', 'retrievePaymentIntent']);
    assert.equal(JSON.stringify(client).includes('sk_test'), false);
    const { origin } = await stripeServer((_seen, res) => json(res, 401, { error: { type: 'invalid_request_error', message: `Invalid API Key provided: ${KEY}` } }));
    const failing = createStripeApiClient({ apiKey: KEY, testOrigin: origin });
    const error = await failing.retrieveAccount(2_000).then(() => undefined, (caught: unknown) => caught);
    assert.ok(error instanceof StripeApiError);
    assert.equal(error.reason, 'STRIPE_AUTHENTICATION_FAILED');
    const text = `${error.message} ${error.stack ?? ''} ${JSON.stringify(error)}`;
    assert.equal(text.includes('sk_test'), false, 'Stripe’s own message (which can echo the key) is never propagated');
    assert.equal(text.includes('Invalid API Key'), false);
  });
});

describe('PAY-09 HTTPS adapter — the exact requests', () => {
  it('every request names the pinned Stripe-Version and authenticates with the key in the Authorization header only', async () => {
    const { origin, seen } = await stripeServer((_seen, res) => json(res, 200, { id: PLATFORM_ACCOUNT, object: 'account', email: 'owner@example.com' }));
    const account = readStripeAccountView(await createStripeApiReader({ apiKey: READ_KEY, testOrigin: origin }).retrieveAccount(2_000));
    assert.deepEqual(account, { accountId: PLATFORM_ACCOUNT, livemode: false });
    assert.equal(seen[0]?.method, 'GET');
    assert.equal(seen[0]?.url, '/v1/account');
    assert.equal(seen[0]?.headers['stripe-version'], STRIPE_API_VERSION);
    assert.equal(seen[0]?.headers['authorization'], `Bearer ${READ_KEY}`);
    assert.equal(seen[0]?.headers['idempotency-key'], undefined, 'no idempotency key on a GET');
  });

  it('create: POST /v1/payment_intents with confirm=false, automatic capture, manual confirmation, card only, a destination charge without fee or transfer amount, bounded metadata, and the create idempotency key', async () => {
    const { origin, seen } = await stripeServer((_seen, res) => json(res, 200, stripeIntent()));
    const view = readStripePaymentIntentView(await createStripeApiClient({ apiKey: KEY, testOrigin: origin }).createPaymentIntent(createInstruction));
    assert.equal(view?.status, 'requires_confirmation');
    const request = seen[0]!;
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/v1/payment_intents');
    assert.equal(request.headers['content-type'], 'application/x-www-form-urlencoded');
    assert.equal(request.headers['idempotency-key'], 'frontera:stripe-usd:exec-wire:create');
    assert.deepEqual([...new URLSearchParams(request.body).entries()], [
      ['amount', '7500'],
      ['currency', 'usd'],
      ['customer', TEST_CUSTOMER],
      ['payment_method', TEST_PAYMENT_METHOD],
      ['confirm', 'false'],
      ['capture_method', 'automatic'],
      ['confirmation_method', 'manual'],
      ['allowed_payment_method_types[0]', 'card'],
      ['transfer_data[destination]', CONNECTED_ACCOUNT],
      ['metadata[frontera_execution_id]', 'exec-wire'],
      ['metadata[frontera_rail_id]', 'stripe-usd'],
    ]);
    const keys = [...new URLSearchParams(request.body).keys()];
    for (const forbidden of ['application_fee_amount', 'on_behalf_of', 'transfer_data[amount]', 'off_session', 'payment_method_types[0]', 'return_url', 'receipt_email', 'description', 'setup_future_usage']) assert.equal(keys.includes(forbidden), false, forbidden);
  });

  it('confirm: POST /v1/payment_intents/{id}/confirm with off_session=true and error_on_requires_action=true only, and the confirm idempotency key', async () => {
    const { origin, seen } = await stripeServer((_seen, res) => json(res, 200, stripeIntent({ status: 'succeeded', amount_received: 7500, latest_charge: 'ch_3Wire' })));
    const view = readStripePaymentIntentView(await createStripeApiClient({ apiKey: KEY, testOrigin: origin }).confirmPaymentIntent(confirmInstruction));
    assert.equal(view?.status, 'succeeded');
    assert.equal(view?.latestChargeId, 'ch_3Wire');
    assert.equal(seen[0]?.url, '/v1/payment_intents/pi_3Wire/confirm');
    assert.equal(seen[0]?.headers['idempotency-key'], 'frontera:stripe-usd:exec-wire:confirm');
    assert.deepEqual([...new URLSearchParams(seen[0]!.body).entries()], [
      ['off_session', 'true'],
      ['error_on_requires_action', 'true'],
    ]);
  });
});

describe('PAY-09 HTTPS adapter — Stripe’s JSON is untrusted', () => {
  it('only the bound fields are copied: never the client_secret, next_action, receipt email or any other field', async () => {
    const { origin } = await stripeServer((_seen, res) => json(res, 200, stripeIntent({ next_action: { type: 'use_stripe_sdk' } })));
    const raw = await createStripeApiReader({ apiKey: READ_KEY, testOrigin: origin }).retrievePaymentIntent('pi_3Wire', 2_000);
    const text = JSON.stringify(raw);
    for (const forbidden of ['client_secret', '_secret_', 'CANARYCLIENTSECRET', 'payer@example.com', 'next_action', 'use_stripe_sdk']) assert.equal(text.includes(forbidden), false, forbidden);
    assert.ok(readStripePaymentIntentView(raw) !== undefined, 'and the copy is exactly what the rail reads closed');
  });

  it('integer amounts are decimal text, only from non-negative safe integers; a float, a string or a huge number is unreadable', async () => {
    for (const amount of [75.5, '7500', 2 ** 60, -1]) {
      const { origin } = await stripeServer((_seen, res) => json(res, 200, stripeIntent({ amount })));
      assert.equal(await createStripeApiReader({ apiKey: READ_KEY, testOrigin: origin }).retrievePaymentIntent('pi_3Wire', 2_000), undefined, String(amount));
    }
  });

  it('a card error on confirmation (402) carries the PaymentIntent it left: that object is the answer', async () => {
    const { origin } = await stripeServer((_seen, res) =>
      json(res, 402, { error: { type: 'card_error', code: 'authentication_required', message: 'Your card was declined. This transaction requires authentication.', payment_intent: stripeIntent({ status: 'requires_payment_method', payment_method: null, last_payment_error: { code: 'authentication_required', message: 'raw decline text' } }) } }),
    );
    const view = readStripePaymentIntentView(await createStripeApiClient({ apiKey: KEY, testOrigin: origin }).confirmPaymentIntent(confirmInstruction));
    assert.equal(view?.status, 'requires_payment_method');
    assert.equal(view?.lastPaymentError, 'authentication_required', 'a bounded code token — never the decline message');
  });

  it('404 resource_missing on retrieval → notFound; 401 / 429 / 5xx / other 4xx → closed reasons, never bodies', async () => {
    const answers: readonly [number, unknown, string][] = [
      [401, { error: { type: 'invalid_request_error' } }, 'STRIPE_AUTHENTICATION_FAILED'],
      [429, { error: { type: 'rate_limit_error' } }, 'STRIPE_RATE_LIMITED'],
      [500, { error: { type: 'api_error' } }, 'STRIPE_UNAVAILABLE'],
      [400, { error: { type: 'invalid_request_error', message: 'leaky detail' } }, 'STRIPE_REFUSED'],
    ];
    const { origin: missing } = await stripeServer((_seen, res) => json(res, 404, { error: { code: 'resource_missing', type: 'invalid_request_error' } }));
    assert.deepEqual(await createStripeApiReader({ apiKey: READ_KEY, testOrigin: missing }).retrievePaymentIntent('pi_3Wire', 2_000), { notFound: true });
    for (const [status, body, reason] of answers) {
      const { origin } = await stripeServer((_seen, res) => json(res, status, body));
      await assert.rejects(createStripeApiReader({ apiKey: READ_KEY, testOrigin: origin }).retrievePaymentIntent('pi_3Wire', 2_000), (error: unknown) => error instanceof StripeApiError && error.reason === reason && !error.message.includes('leaky'), String(status));
    }
  });

  it('a redirect is refused and never followed; an oversized answer is refused', async () => {
    const { origin, seen } = await stripeServer((_seen, res) => {
      res.writeHead(302, { location: 'http://127.0.0.1:9/steal' });
      res.end();
    });
    await assert.rejects(createStripeApiClient({ apiKey: KEY, testOrigin: origin }).confirmPaymentIntent(confirmInstruction), (error: unknown) => error instanceof StripeApiError && error.reason === 'STRIPE_REDIRECT_REFUSED');
    assert.equal(seen.length, 1, 'one request: nothing followed the redirect');
    const { origin: huge } = await stripeServer((_seen, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(`{"padding":"${'x'.repeat(2 * 1024 * 1024)}"}`);
    });
    await assert.rejects(createStripeApiReader({ apiKey: READ_KEY, testOrigin: huge }).retrievePaymentIntent('pi_3Wire', 5_000), (error: unknown) => error instanceof StripeApiError && error.reason === 'STRIPE_MALFORMED_RESPONSE');
  });
});

describe('PAY-09 HTTPS adapter — not sent vs unknown', () => {
  it('a connection that never opens → StripeRequestNotSentError (the confirmation provably never left the process)', async () => {
    const { origin } = await stripeServer(() => undefined);
    const closed = servers.pop()!;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    await assert.rejects(createStripeApiClient({ apiKey: KEY, testOrigin: origin }).confirmPaymentIntent(confirmInstruction), StripeRequestNotSentError);
  });

  it('a connection Stripe accepted, then reset or left unanswered → unknown (never "not sent")', async () => {
    const { origin: reset } = await stripeServer((_seen, res) => res.socket?.destroy());
    await assert.rejects(createStripeApiClient({ apiKey: KEY, testOrigin: reset }).confirmPaymentIntent(confirmInstruction), (error: unknown) => error instanceof StripeApiError && !(error instanceof StripeRequestNotSentError));
    const { origin: silent } = await stripeServer(() => undefined);
    await assert.rejects(createStripeApiClient({ apiKey: KEY, testOrigin: silent }).confirmPaymentIntent({ ...confirmInstruction, timeoutMs: 300 }), (error: unknown) => error instanceof StripeApiError && error.reason === 'STRIPE_TIMEOUT');
  });
});

describe('PAY-09 HTTPS adapter — the rail end to end over the wire', () => {
  it('account → create → confirm → completed against a loopback Stripe; the client secret Stripe returns never reaches the rail’s result', async () => {
    const { origin, seen } = await stripeServer((request, res) => {
      if (request.url === '/v1/account') return json(res, 200, { id: PLATFORM_ACCOUNT, object: 'account' });
      const metadata = { frontera_execution_id: 'exec-over-wire', frontera_rail_id: 'stripe-usd' };
      if (request.url === '/v1/payment_intents') return json(res, 200, stripeIntent({ metadata }));
      if (request.url === '/v1/payment_intents/pi_3Wire/confirm') return json(res, 200, stripeIntent({ metadata, status: 'succeeded', amount_received: 7500, latest_charge: 'ch_3Wire' }));
      return json(res, 404, { error: { code: 'resource_missing' } });
    });
    const rail = createStripeRail({ configuration: testRailConfiguration(), stripe: createStripeApiClient({ apiKey: KEY, testOrigin: origin }), interlock: createMemoryStripeInterlock() });
    const result = await rail.execute({
      executionId: 'exec-over-wire',
      requestId: 'req-wire',
      decisionId: 'dec-wire',
      grantId: 'grant-wire',
      notAfter: '2026-10-13T13:00:00.000Z',
      source: { accountId: GOVERNED_ACCOUNT },
      destination: stripeDestinationOf(CONNECTED_ACCOUNT),
      amount: { value: '75', unit: USD_ASSET },
      purpose: 'purchase',
    });
    assert.deepEqual(result, { status: 'completed', externalReference: 'pi_3Wire' });
    assert.deepEqual(seen.map((request) => `${request.method} ${request.url}`), ['GET /v1/account', 'POST /v1/payment_intents', 'POST /v1/payment_intents/pi_3Wire/confirm']);
    assert.equal(JSON.stringify(result).includes('secret'), false);
  });
});
