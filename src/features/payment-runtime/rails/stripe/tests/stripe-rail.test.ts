import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { PaymentExecutionRequest, PaymentRailResult } from '../../../domain/index.js';
import {
  STRIPE_API_VERSION,
  STRIPE_RAIL_DETAILS,
  StripeRailConfigurationError,
  createStripeRail,
  createStripeRailConfiguration,
  stripeDestinationOf,
  stripeIdempotencyKey,
  type StripePaymentPort,
  type StripeRailConfigurationInput,
} from '../index.js';
import {
  CONNECTED_ACCOUNT,
  GOVERNED_ACCOUNT,
  OTHER_CONNECTED_ACCOUNT,
  OTHER_PLATFORM_ACCOUNT,
  PLATFORM_ACCOUNT,
  TEST_CUSTOMER,
  TEST_PAYMENT_METHOD,
  UNCONFIGURED_CONNECTED_ACCOUNT,
  USD_ASSET,
  createMemoryStripeInterlock,
  createSimulatedStripe,
  testRailConfiguration,
  type SimulatedStripe,
} from './stripe-test-fixtures.js';

/**
 * PAY-09 — the Stripe rail against the deterministic Stripe simulator (below
 * the external port only) and an in-memory interlock. The durable,
 * CORE-07-anchored interlock and the governed spine are exercised in
 * `src/enterprise/__tests__/pay09-*.test.ts`.
 */

const D = STRIPE_RAIL_DETAILS;
let sequence = 0;

function request(overrides: Partial<PaymentExecutionRequest> = {}): PaymentExecutionRequest {
  sequence += 1;
  return Object.freeze({
    executionId: `exec-stripe-${sequence}`,
    requestId: `req-${sequence}`,
    decisionId: `dec-${sequence}`,
    grantId: `grant-${sequence}`,
    notAfter: '2026-10-13T13:00:00.000Z',
    source: { accountId: GOVERNED_ACCOUNT },
    destination: stripeDestinationOf(CONNECTED_ACCOUNT),
    amount: { value: '75', unit: USD_ASSET },
    purpose: 'purchase',
    ...overrides,
  });
}

function world(options: { readonly configuration?: ReturnType<typeof testRailConfiguration>; readonly stripe?: SimulatedStripe } = {}) {
  const stripe = options.stripe ?? createSimulatedStripe();
  const interlock = createMemoryStripeInterlock();
  const logs: { readonly event: string; readonly fields: unknown }[] = [];
  const logger = { info: (event: string, fields?: unknown) => logs.push({ event, fields }), warn: (event: string, fields?: unknown) => logs.push({ event, fields }) };
  const rail = createStripeRail({ configuration: options.configuration ?? testRailConfiguration(), stripe, interlock, logger });
  return { stripe, interlock, rail, logs };
}

const nothingContacted = (stripe: SimulatedStripe): void => assert.deepEqual(stripe.calls, { create: 0, confirmAttempted: 0, confirmReceived: 0, retrieve: 0, account: 0 });

function input(overrides: Partial<StripeRailConfigurationInput>): StripeRailConfigurationInput {
  return {
    mode: 'test',
    apiVersion: STRIPE_API_VERSION,
    platformAccountId: PLATFORM_ACCOUNT,
    currency: 'usd',
    asset: { paymentAsset: USD_ASSET, scale: 2 },
    captureMethod: 'automatic',
    fundingSources: [{ accountId: GOVERNED_ACCOUNT, customerId: TEST_CUSTOMER, paymentMethodId: TEST_PAYMENT_METHOD }],
    connectedAccounts: [CONNECTED_ACCOUNT],
    ...overrides,
  };
}

const refusedField = (overrides: Partial<StripeRailConfigurationInput> | Record<string, unknown>): string => {
  try {
    createStripeRailConfiguration(input(overrides as Partial<StripeRailConfigurationInput>));
  } catch (error) {
    assert.ok(error instanceof StripeRailConfigurationError);
    return error.field;
  }
  assert.fail('configuration was accepted');
};

describe('PAY-09 configuration — CFG matrix', () => {
  it('CFG-1 test mode accepted; the rail id is the narrow "stripe-usd"', () => {
    const configuration = createStripeRailConfiguration(input({}));
    assert.equal(configuration.mode, 'test');
    assert.equal(configuration.railId, 'stripe-usd');
    assert.equal(configuration.minimumChargeCents, 50n);
    assert.ok(Object.isFrozen(configuration) && Object.isFrozen(configuration.fundingSources));
  });

  it('CFG-2 live-looking configuration refused: mode "live" (there is no live flag), a live account at runtime, a live object', async () => {
    assert.equal(refusedField({ mode: 'live' as never }), 'mode');
    assert.equal(refusedField({ mode: undefined as never }), 'mode');
    const { rail, stripe } = world();
    stripe.readMode = 'live';
    const result = await rail.execute(request());
    assert.deepEqual(result, { status: 'not-completed', reason: 'ADAPTER_ERROR', detail: D.LIVE_MODE_REFUSED });
    assert.equal(stripe.calls.create + stripe.calls.confirmAttempted, 0, 'nothing created, nothing confirmed');
    assert.deepEqual(await rail.readiness(), { status: 'unavailable', detail: D.LIVE_MODE_REFUSED });
  });

  it('CFG-3 a rail without a Stripe capability (or without the interlock) is refused at composition', () => {
    const configuration = testRailConfiguration();
    assert.throws(() => createStripeRail({ configuration, stripe: undefined as unknown as StripePaymentPort, interlock: createMemoryStripeInterlock() }), StripeRailConfigurationError);
    const half = { retrieveAccount: async () => undefined, retrievePaymentIntent: async () => undefined } as unknown as StripePaymentPort;
    assert.throws(() => createStripeRail({ configuration, stripe: half, interlock: createMemoryStripeInterlock() }), /confirmPaymentIntent|createPaymentIntent/);
    assert.throws(() => createStripeRail({ configuration, stripe: createSimulatedStripe(), interlock: { recorded: async () => undefined } as never }), /interlock/);
    assert.throws(() => createStripeRail({ configuration: { ...configuration }, stripe: createSimulatedStripe(), interlock: createMemoryStripeInterlock() }), /createStripeRailConfiguration/);
  });

  it('CFG-4 unknown currency or another scale refused — scale is trusted configuration, never read from Stripe', () => {
    assert.equal(refusedField({ currency: 'eur' as never }), 'currency');
    assert.equal(refusedField({ currency: 'jpy' as never }), 'currency');
    assert.equal(refusedField({ asset: { paymentAsset: USD_ASSET, scale: 0 } }), 'asset.scale');
    assert.equal(refusedField({ asset: { paymentAsset: USD_ASSET, scale: 3 } }), 'asset.scale');
    assert.equal(refusedField({ asset: { paymentAsset: 'not an asset', scale: 2 } }), 'asset.paymentAsset');
  });

  it('CFG-5 unsupported capture mode refused (manual, automatic_async)', () => {
    assert.equal(refusedField({ captureMethod: 'manual' as never }), 'captureMethod');
    assert.equal(refusedField({ captureMethod: 'automatic_async' as never }), 'captureMethod');
  });

  it('CFG-6 duplicate source profile refused: the same governed account twice, or one PaymentMethod for two accounts', () => {
    const one = { accountId: GOVERNED_ACCOUNT, customerId: TEST_CUSTOMER, paymentMethodId: TEST_PAYMENT_METHOD };
    assert.equal(refusedField({ fundingSources: [one, { ...one, paymentMethodId: 'pm_card_mastercard' }] }), 'fundingSources[1].accountId');
    assert.equal(refusedField({ fundingSources: [one, { ...one, accountId: 'treasury-reserve' }] }), 'fundingSources[1].paymentMethodId');
    assert.equal(refusedField({ fundingSources: [] }), 'fundingSources');
  });

  it('CFG-6b a funding source holds opaque Stripe ids only — card data is refused by shape, its value never read', () => {
    const card = { accountId: GOVERNED_ACCOUNT, customerId: TEST_CUSTOMER, paymentMethodId: TEST_PAYMENT_METHOD, number: 'PLACEHOLDER-NOT-A-CARD' };
    assert.equal(refusedField({ fundingSources: [card as never] }), 'fundingSources[0]');
    assert.equal(refusedField({ fundingSources: [{ accountId: GOVERNED_ACCOUNT, customerId: 'not-a-customer', paymentMethodId: TEST_PAYMENT_METHOD }] }), 'fundingSources[0].customerId');
    assert.equal(refusedField({ fundingSources: [{ accountId: GOVERNED_ACCOUNT, customerId: TEST_CUSTOMER, paymentMethodId: 'tok_visa' }] }), 'fundingSources[0].paymentMethodId');
  });

  it('CFG-7 duplicate destination mapping refused; the platform itself is not a destination', () => {
    assert.equal(refusedField({ connectedAccounts: [CONNECTED_ACCOUNT, CONNECTED_ACCOUNT] }), 'connectedAccounts[1]');
    assert.equal(refusedField({ connectedAccounts: [PLATFORM_ACCOUNT] }), 'connectedAccounts[0]');
    assert.equal(refusedField({ connectedAccounts: ['cus_NotAnAccount'] }), 'connectedAccounts[0]');
    assert.equal(refusedField({ connectedAccounts: [] }), 'connectedAccounts');
  });

  it('CFG-8 the platform account context is explicit and verified: required, an account id, and checked against the credential before any reservation', async () => {
    assert.equal(refusedField({ platformAccountId: undefined as never }), 'platformAccountId');
    assert.equal(refusedField({ platformAccountId: 'cus_Wrong' }), 'platformAccountId');
    const { rail, stripe, interlock } = world({ stripe: createSimulatedStripe({ platformAccountId: OTHER_PLATFORM_ACCOUNT }) });
    assert.deepEqual(await rail.execute(request()), { status: 'not-completed', reason: 'ADAPTER_ERROR', detail: D.ACCOUNT_MISMATCH });
    assert.equal(interlock.records.size, 0, 'nothing reserved for a credential of another account');
    assert.equal(stripe.calls.create, 0);
  });

  it('CFG-9 the Stripe API version is explicit and pinned; the SDK is not used', () => {
    assert.equal(STRIPE_API_VERSION, '2026-09-30.endive');
    assert.equal(refusedField({ apiVersion: undefined as never }), 'apiVersion');
    assert.equal(refusedField({ apiVersion: '2025-03-31.basil' }), 'apiVersion');
  });

  it('CFG-10 the configuration holds no secret: no key-shaped field exists, and nothing enumerable carries one', () => {
    const configuration = testRailConfiguration();
    const text = JSON.stringify(configuration, (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value));
    assert.equal(/sk_|rk_|whsec_|secret|password|api.?key/i.test(text), false, text);
  });

  it('timeouts and charge bounds are bounded integers / cents', () => {
    assert.equal(refusedField({ requestTimeoutMs: 0 }), 'requestTimeoutMs');
    assert.equal(refusedField({ confirmTimeoutMs: 10_000_000 }), 'confirmTimeoutMs');
    assert.equal(refusedField({ minimumChargeCents: '0' }), 'minimumChargeCents');
    assert.equal(refusedField({ maximumChargeCents: '100000000' }), 'maximumChargeCents');
    assert.equal(refusedField({ minimumChargeCents: '500', maximumChargeCents: '100' }), 'minimumChargeCents');
  });
});

describe('PAY-09 destination — DEST matrix', () => {
  it('DEST-1 a configured connected account is accepted and becomes transfer_data.destination', async () => {
    const { rail, stripe } = world();
    const result = await rail.execute(request({ destination: stripeDestinationOf(OTHER_CONNECTED_ACCOUNT) }));
    assert.equal(result.status, 'completed');
    assert.equal(stripe.instructions.create[0]?.destinationAccountId, OTHER_CONNECTED_ACCOUNT);
    assert.equal(stripe.intents()[0]?.destinationAccountId, OTHER_CONNECTED_ACCOUNT);
  });

  it('DEST-2 an unknown (unconfigured) destination is refused before any Stripe call', async () => {
    const { rail, stripe, interlock } = world();
    assert.deepEqual(await rail.execute(request({ destination: stripeDestinationOf(UNCONFIGURED_CONNECTED_ACCOUNT) })), { status: 'not-completed', reason: 'ADAPTER_ERROR', detail: D.DESTINATION_NOT_CONFIGURED });
    nothingContacted(stripe);
    assert.equal(interlock.records.size, 0);
  });

  it('DEST-3 a destination mismatch in a Stripe answer is refused: at creation → never confirmed; at confirmation → never completed', async () => {
    const created = world();
    const port: StripePaymentPort = {
      ...created.stripe,
      retrieveAccount: (t) => created.stripe.retrieveAccount(t),
      retrievePaymentIntent: (id, t) => created.stripe.retrievePaymentIntent(id, t),
      createPaymentIntent: async (instruction) => ({ ...(await created.stripe.createPaymentIntent(instruction) as object), destinationAccountId: OTHER_CONNECTED_ACCOUNT }),
      confirmPaymentIntent: (instruction) => created.stripe.confirmPaymentIntent(instruction),
    };
    const atCreation = createStripeRail({ configuration: testRailConfiguration(), stripe: port, interlock: created.interlock });
    const first = await atCreation.execute(request());
    assert.equal(first.status, 'not-completed');
    assert.equal((first as { detail?: string }).detail, D.CREATED_OBJECT_MISMATCH);
    assert.equal(created.stripe.calls.confirmAttempted, 0, 'never confirmed');

    const confirmed = world();
    const tampering: StripePaymentPort = {
      retrieveAccount: (t) => confirmed.stripe.retrieveAccount(t),
      retrievePaymentIntent: (id, t) => confirmed.stripe.retrievePaymentIntent(id, t),
      createPaymentIntent: (instruction) => confirmed.stripe.createPaymentIntent(instruction),
      confirmPaymentIntent: async (instruction) => ({ ...(await confirmed.stripe.confirmPaymentIntent(instruction) as object), destinationAccountId: OTHER_CONNECTED_ACCOUNT }),
    };
    const atConfirmation = createStripeRail({ configuration: testRailConfiguration(), stripe: tampering, interlock: confirmed.interlock });
    const second = await atConfirmation.execute(request());
    assert.equal(second.status, 'unconfirmed', 'an answer about another destination is never a completion');
    assert.equal((second as { detail?: string }).detail, D.DESTINATION_MISMATCH);
  });

  it('DEST-4 another platform account cannot satisfy the execution: a credential of another account is refused before anything exists', async () => {
    const other = createSimulatedStripe({ platformAccountId: OTHER_PLATFORM_ACCOUNT });
    const { rail } = world({ stripe: other });
    assert.equal(((await rail.execute(request())) as { detail?: string }).detail, D.ACCOUNT_MISMATCH);
    assert.equal(other.calls.create + other.calls.confirmAttempted, 0);
  });

  it('DEST-5 a malformed destination is refused before any Stripe call', async () => {
    for (const destination of [
      { kind: 'stripe-connected-account', reference: 'cus_TestAgentFunding' },
      { kind: 'stripe-connected-account', reference: 'acct_' },
      { kind: 'stripe-connected-account', reference: 'acct_1Bad_secret_x' },
      { kind: 'account', reference: CONNECTED_ACCOUNT },
      { kind: 'lightning-invoice', reference: CONNECTED_ACCOUNT },
    ]) {
      const { rail, stripe } = world();
      assert.deepEqual(await rail.execute(request({ destination })), { status: 'not-completed', reason: 'ADAPTER_ERROR', detail: D.DESTINATION_INVALID }, JSON.stringify(destination));
      nothingContacted(stripe);
    }
    assert.throws(() => stripeDestinationOf('pm_card_visa'), TypeError);
  });

  it('DEST-6 destination configuration cannot alter the governed amount: the cents sent are the governed amount, whatever the destination', async () => {
    for (const destination of [CONNECTED_ACCOUNT, OTHER_CONNECTED_ACCOUNT]) {
      const { rail, stripe } = world();
      await rail.execute(request({ destination: stripeDestinationOf(destination), amount: { value: '12.34', unit: USD_ASSET } }));
      assert.equal(stripe.instructions.create[0]?.amountCents, 1234n);
      assert.equal(stripe.intents()[0]?.transferAmountCents, null, 'no transfer_data.amount: the full governed amount goes to the destination');
      assert.equal(stripe.intents()[0]?.applicationFeeCents, null, 'no application fee');
    }
    assert.equal(Object.keys(testRailConfiguration()).some((key) => /amount|fee/i.test(key) && !/ChargeCents$/.test(key)), false);
  });
});

describe('PAY-09 rail — one governed execution → at most one confirmation (P11)', () => {
  it('success: reserve → create (confirm=false) → bind → ONE confirm → completed, ref = the PaymentIntent id', async () => {
    const { rail, stripe, interlock } = world();
    const r = request();
    const result = await rail.execute(r);
    const intent = stripe.intents()[0]!;
    assert.deepEqual(result, { status: 'completed', externalReference: intent.id });
    assert.deepEqual({ create: stripe.calls.create, confirm: stripe.calls.confirmReceived, charges: stripe.charges() }, { create: 1, confirm: 1, charges: 1 });
    const record = interlock.records.get(r.executionId);
    assert.equal(record?.paymentIntentId, intent.id, 'bound before the confirmation');
    assert.equal(record?.amountCents, 7500n);
    assert.equal(record?.platformAccountId, PLATFORM_ACCOUNT);
    assert.equal(intent.executionId, r.executionId, 'bounded metadata correlation');
    assert.equal(intent.confirmationMethod, 'manual', 'only a secret key can confirm it — never a client secret');
    assert.equal(intent.captureMethod, 'automatic');
  });

  it('definitive failure: a decline leaves requires_payment_method with an error → not-completed PROVIDER_REJECTED, never confirmed again', async () => {
    const { rail, stripe } = world();
    stripe.confirmBehaviour = 'decline';
    const result = await rail.execute(request());
    assert.deepEqual(result, { status: 'not-completed', reason: 'PROVIDER_REJECTED', externalReference: stripe.intents()[0]!.id, detail: D.PAYMENT_FAILED });
    assert.equal(stripe.calls.confirmReceived, 1);
  });

  it('SCA: an off-session payment that needs customer authentication fails deterministically (authentication_required) — no interactive flow, no second confirmation', async () => {
    const { rail, stripe } = world();
    stripe.confirmBehaviour = 'authentication-required';
    const result = await rail.execute(request());
    assert.equal(result.status, 'not-completed');
    assert.equal((result as { detail?: string }).detail, D.AUTHENTICATION_REQUIRED);
    assert.equal(stripe.calls.confirmReceived, 1);
  });

  it('requires_action → unconfirmed (never completed, never re-confirmed)', async () => {
    const { rail, stripe } = world();
    stripe.confirmBehaviour = 'requires-action';
    const result = await rail.execute(request());
    assert.deepEqual(result, { status: 'unconfirmed', externalReference: stripe.intents()[0]!.id, detail: D.REQUIRES_ACTION });
    assert.equal(stripe.calls.confirmReceived, 1);
  });

  it('processing → unconfirmed; P12 resolves later', async () => {
    const { rail, stripe } = world();
    stripe.confirmBehaviour = 'processing';
    assert.deepEqual(await rail.execute(request()), { status: 'unconfirmed', externalReference: stripe.intents()[0]!.id, detail: D.PAYMENT_PROCESSING });
  });

  it('requires_capture → unconfirmed (automatic capture only; Frontera never captures)', async () => {
    const { rail, stripe } = world();
    stripe.confirmBehaviour = 'requires-capture';
    assert.equal(((await rail.execute(request())) as { detail?: string }).detail, D.CAPTURE_PENDING);
    assert.equal(stripe.charges(), 0);
  });

  it('post-submit ambiguity: Stripe charged, the response was lost → unconfirmed, ONE charge, no second confirmation', async () => {
    const { rail, stripe } = world();
    stripe.confirmBehaviour = 'succeed-response-lost';
    const result = await rail.execute(request());
    assert.deepEqual(result, { status: 'unconfirmed', externalReference: stripe.intents()[0]!.id, detail: D.CONFIRM_OUTCOME_UNKNOWN });
    assert.deepEqual({ confirm: stripe.calls.confirmReceived, charges: stripe.charges() }, { confirm: 1, charges: 1 });
  });

  it('timeout: the adapter never answers → the rail stops listening → unconfirmed (never not-completed)', async () => {
    const { rail, stripe } = world();
    stripe.confirmBehaviour = 'succeed-never-answers';
    const result = await rail.execute(request());
    assert.equal(result.status, 'unconfirmed');
    assert.equal((result as { detail?: string }).detail, D.CONFIRM_OUTCOME_UNKNOWN);
  });

  it('a confirmation that provably never left the process → not-completed PROVIDER_UNAVAILABLE; nothing charged', async () => {
    const { rail, stripe } = world();
    stripe.confirmBehaviour = 'not-sent';
    const result = await rail.execute(request());
    assert.equal(result.status, 'not-completed');
    assert.equal((result as { reason?: string }).reason, 'PROVIDER_UNAVAILABLE');
    assert.equal((result as { detail?: string }).detail, D.CONFIRM_NOT_SENT);
    assert.deepEqual({ received: stripe.calls.confirmReceived, charges: stripe.charges() }, { received: 0, charges: 0 });
  });

  it('an unreadable confirmation answer → unconfirmed', async () => {
    const { stripe, interlock } = world();
    const port: StripePaymentPort = { ...stripe, retrieveAccount: (t) => stripe.retrieveAccount(t), retrievePaymentIntent: (i, t) => stripe.retrievePaymentIntent(i, t), createPaymentIntent: (i) => stripe.createPaymentIntent(i), confirmPaymentIntent: async (i) => ({ ...(await stripe.confirmPaymentIntent(i) as object), client_secret: 'pi_x_secret_y' }) };
    const rail = createStripeRail({ configuration: testRailConfiguration(), stripe: port, interlock });
    assert.equal(((await rail.execute(request())) as { detail?: string }).detail, D.ANSWER_UNREADABLE, 'an extra field (a client secret) makes the answer unreadable — never believed');
  });

  it('creation failures never confirm: an error, a lost response (an orphan that can never charge), another amount', async () => {
    for (const behaviour of ['fail', 'response-lost', 'wrong-amount'] as const) {
      const { rail, stripe } = world();
      stripe.createBehaviour = behaviour;
      const result = await rail.execute(request());
      assert.equal(result.status, 'not-completed', behaviour);
      assert.equal(stripe.calls.confirmAttempted, 0, `${behaviour}: never confirmed`);
      assert.equal(stripe.charges(), 0);
      for (const intent of stripe.intents()) assert.equal(intent.status, 'requires_confirmation', 'an orphan stays unconfirmed: confirmation_method=manual, and Frontera never confirms an unbound object');
    }
  });

  it('crash windows before the confirmation: the interlock cannot record, reserve or bind → not-completed, nothing confirmed', async () => {
    for (const failure of ['recorded', 'reserve', 'bind'] as const) {
      const { rail, stripe, interlock } = world();
      interlock.failNext = failure;
      const result = await rail.execute(request());
      assert.equal(result.status, 'not-completed', failure);
      assert.equal((result as { detail?: string }).detail, failure === 'bind' ? D.BINDING_UNAVAILABLE : D.INTERLOCK_UNAVAILABLE);
      assert.equal(stripe.calls.confirmAttempted, 0, `${failure}: never confirmed`);
      assert.equal(stripe.calls.create, failure === 'bind' ? 1 : 0, 'a reservation precedes every creation');
    }
  });

  it('exact replay: the same execution again → unconfirmed from the record, zero creates, zero confirmations', async () => {
    const { rail, stripe } = world();
    const r = request();
    await rail.execute(r);
    const before = { ...stripe.calls };
    const again = await rail.execute(r);
    assert.deepEqual(again, { status: 'unconfirmed', externalReference: stripe.intents()[0]!.id, detail: D.EXECUTION_PREVIOUSLY_INITIATED });
    assert.deepEqual({ create: stripe.calls.create, confirm: stripe.calls.confirmAttempted }, { create: before.create, confirm: before.confirmAttempted });
    assert.equal(stripe.charges(), 1);
  });

  it('replay after Stripe pruned its idempotency keys (retention is defence in depth): still zero additional effects — the interlock decides', async () => {
    const { rail, stripe } = world();
    const r = request();
    await rail.execute(r);
    stripe.pruneIdempotency();
    await rail.execute(r);
    assert.deepEqual({ create: stripe.calls.create, confirm: stripe.calls.confirmAttempted, charges: stripe.charges() }, { create: 1, confirm: 1, charges: 1 });
  });

  it('concurrent duplicate: the same execution twice at once → exactly one creation, one confirmation, one charge', async () => {
    const { rail, stripe } = world();
    const r = request();
    const results: PaymentRailResult[] = await Promise.all([rail.execute(r), rail.execute(r), rail.execute(r)]);
    assert.deepEqual({ create: stripe.calls.create, confirm: stripe.calls.confirmAttempted, charges: stripe.charges() }, { create: 1, confirm: 1, charges: 1 });
    assert.deepEqual(results.map((result) => result.status).sort(), ['completed', 'unconfirmed', 'unconfirmed']);
  });

  it('a changed payment under an already-recorded execution is never sent: unconfirmed, terms conflict', async () => {
    const { rail, stripe } = world();
    const r = request();
    await rail.execute(r);
    const changed = await rail.execute({ ...r, amount: { value: '80', unit: USD_ASSET } });
    assert.equal((changed as { detail?: string }).detail, D.EXECUTION_TERMS_CONFLICT);
    assert.equal(stripe.calls.create, 1);
  });

  it('refusals before anything is contacted: another asset, sub-cent, below the minimum, above the maximum, an unmapped source', async () => {
    for (const [override, detail] of [
      [{ amount: { value: '75', unit: 'EUR' } }, D.ASSET_UNSUPPORTED],
      [{ amount: { value: '0.001', unit: USD_ASSET } }, D.AMOUNT_UNREPRESENTABLE],
      [{ amount: { value: '0.49', unit: USD_ASSET } }, D.AMOUNT_BELOW_MINIMUM],
      [{ amount: { value: '1000000', unit: USD_ASSET } }, D.AMOUNT_UNREPRESENTABLE],
      [{ source: { accountId: 'treasury-unmapped' } }, D.SOURCE_UNMAPPED],
    ] as const) {
      const { rail, stripe } = world();
      assert.deepEqual(await rail.execute(request(override)), { status: 'not-completed', reason: 'ADAPTER_ERROR', detail }, detail);
      nothingContacted(stripe);
    }
    const bounded = world({ configuration: testRailConfiguration({ maximumChargeCents: '10000' }) });
    assert.equal(((await bounded.rail.execute(request({ amount: { value: '100.01', unit: USD_ASSET } }))) as { detail?: string }).detail, D.AMOUNT_ABOVE_MAXIMUM);
  });

  it('the Stripe account cannot be read → not-completed PROVIDER_UNAVAILABLE; nothing reserved', async () => {
    const { rail, stripe, interlock } = world();
    stripe.readMode = 'unavailable';
    assert.deepEqual(await rail.execute(request()), { status: 'not-completed', reason: 'PROVIDER_UNAVAILABLE', detail: D.ACCOUNT_UNAVAILABLE });
    assert.equal(interlock.records.size, 0);
  });
});

describe('PAY-09 idempotency key — deterministic, non-sensitive, bounded', () => {
  it('derived from the rail and execution only; the same execution always yields the same keys; create ≠ confirm', async () => {
    assert.equal(stripeIdempotencyKey('stripe-usd', 'exec-1', 'create'), 'frontera:stripe-usd:exec-1:create');
    assert.equal(stripeIdempotencyKey('stripe-usd', 'exec-1', 'confirm'), 'frontera:stripe-usd:exec-1:confirm');
    const { rail, stripe } = world();
    const r = request();
    await rail.execute(r);
    assert.equal(stripe.instructions.create[0]?.idempotencyKey, `frontera:stripe-usd:${r.executionId}:create`);
    assert.equal(stripe.instructions.confirm[0]?.idempotencyKey, `frontera:stripe-usd:${r.executionId}:confirm`);
    // A second process for the same execution derives the same keys — no randomness, no clock.
    const second = world();
    second.stripe.createBehaviour = 'fail';
    await second.rail.execute(r);
    assert.equal(second.stripe.instructions.create[0]?.idempotencyKey, stripe.instructions.create[0]?.idempotencyKey);
  });

  it('an execution id that would exceed Stripe’s 255 characters is replaced by its digest — still deterministic, still bounded', () => {
    const long = 'x'.repeat(400);
    const key = stripeIdempotencyKey('stripe-usd', long, 'confirm');
    assert.ok(key.length <= 255);
    assert.equal(key, stripeIdempotencyKey('stripe-usd', long, 'confirm'));
    assert.match(key, /^frontera:stripe-usd:sha256-[0-9a-f]{64}:confirm$/);
  });
});

describe('PAY-09 rail — logs and readiness', () => {
  it('logs carry bounded correlation only: no amount, no Customer or PaymentMethod id, no secret', async () => {
    const { rail, logs } = world();
    await rail.execute(request());
    const text = JSON.stringify(logs);
    assert.ok(logs.length > 0);
    assert.equal(/cus_|pm_card|7500|"75"|secret|sk_test|whsec/.test(text), false, text);
  });

  it('readiness reads the account and creates nothing', async () => {
    const { rail, stripe } = world();
    assert.deepEqual(await rail.readiness(), { status: 'ready', mode: 'test' });
    assert.equal(stripe.calls.create + stripe.calls.confirmAttempted, 0);
    stripe.readMode = 'unavailable';
    assert.deepEqual(await rail.readiness(), { status: 'unavailable', detail: D.ACCOUNT_UNAVAILABLE });
  });
});
