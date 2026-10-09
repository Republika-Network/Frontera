import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createMonetaryAssetRegistry } from '../../monetary-runtime/index.js';
import {
  PAYMENT_INTENT_VIOLATIONS as V,
  PAYMENT_PARAMETER_DIMENSIONS,
  PAYMENT_PROFILE_PARAMETERS,
  PAYMENT_PURPOSES,
  PaymentConfigurationError,
  compilePaymentIntent,
  createPaymentGovernanceBinding,
  describePaymentAsset,
  isWellFormedPaymentIntent,
  paymentCounterpartyOf,
  paymentDestinationOf,
  validatePaymentIntent,
  type PaymentIntent,
} from '../index.js';

/**
 * PAY-01 qualification, unit level: the canonical payment intent (P1–P4), its
 * fail-closed validation, and its deterministic compilation onto the generic
 * governed-action envelope.
 *
 * The amounts and identifiers here are arbitrary test values, not product
 * semantics.
 */

const TRUST = Object.freeze({
  assets: createMonetaryAssetRegistry([
    { assetId: 'USD', scale: 2 },
    { assetId: 'stable:USDX', scale: 6 },
    { assetId: 'net:COIN', scale: 8 },
    { assetId: 'net:USDX/acme-bank', scale: 6 },
  ]),
});

const BINDING = createPaymentGovernanceBinding({ action: 'payment.send' });

function rawPayment(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    source: { accountId: 'acct-operating-001' },
    destination: { kind: 'account', reference: 'vendor-4471' },
    amount: { value: '1250.50', unit: 'USD' },
    purpose: 'vendor-payment',
    idempotencyKey: 'pay-0001',
    ...overrides,
  };
}

function valid(raw: unknown): PaymentIntent {
  const result = validatePaymentIntent(raw, TRUST);
  assert.equal(result.valid, true, JSON.stringify(result));
  return (result as { readonly intent: PaymentIntent }).intent;
}

function codes(raw: unknown): readonly string[] {
  const result = validatePaymentIntent(raw, TRUST);
  assert.equal(result.valid, false, 'expected a refusal');
  return result.valid ? [] : result.violations.map((violation) => violation.code);
}

describe('PAY-01 P1 — a valid payment intent is accepted as one canonical contract', () => {
  it('accepts a complete payment and returns a fresh, frozen, canonical copy', () => {
    const raw = rawPayment({ reference: 'INV-2026-0042', rail: 'reference-rail', correlationId: 'corr-1' });
    const intent = valid(raw);
    assert.deepEqual(intent, {
      source: { accountId: 'acct-operating-001' },
      destination: { kind: 'account', reference: 'vendor-4471' },
      amount: { value: '1250.5', unit: 'USD' },
      purpose: 'vendor-payment',
      reference: 'INV-2026-0042',
      rail: 'reference-rail',
      idempotencyKey: 'pay-0001',
      correlationId: 'corr-1',
    });
    assert.ok(Object.isFrozen(intent) && Object.isFrozen(intent.source) && Object.isFrozen(intent.destination) && Object.isFrozen(intent.amount));
    assert.notEqual(intent.source, raw['source'], 'no reference into the caller object is retained');
    assert.equal(isWellFormedPaymentIntent(intent), true);
  });

  it('canonicalizes the amount through P9 without rounding: "10.50" and "10.5" are one payment', () => {
    assert.deepEqual(valid(rawPayment({ amount: { value: '10.50', unit: 'USD' } })).amount, valid(rawPayment({ amount: { value: '10.5', unit: 'USD' } })).amount);
  });

  it('accepts every purpose in the closed vocabulary', () => {
    for (const purpose of PAYMENT_PURPOSES) assert.equal(valid(rawPayment({ purpose })).purpose, purpose);
  });
});

describe('PAY-01 P2 — an invalid amount is refused, never repaired', () => {
  const cases: readonly [string, unknown, string][] = [
    ['zero', '0', V.PAYMENT_AMOUNT_NOT_POSITIVE],
    ['zero with a fraction', '0.00', V.PAYMENT_AMOUNT_NOT_POSITIVE],
    ['negative', '-5', V.PAYMENT_AMOUNT_MALFORMED],
    ['a leading plus', '+5', V.PAYMENT_AMOUNT_MALFORMED],
    ['an exponent', '1e3', V.PAYMENT_AMOUNT_MALFORMED],
    ['a separator', '1,000.00', V.PAYMENT_AMOUNT_MALFORMED],
    ['whitespace', ' 10', V.PAYMENT_AMOUNT_MALFORMED],
    ['a leading zero', '010', V.PAYMENT_AMOUNT_MALFORMED],
    ['a bare point', '10.', V.PAYMENT_AMOUNT_MALFORMED],
    ['NaN', 'NaN', V.PAYMENT_AMOUNT_MALFORMED],
    ['Infinity', 'Infinity', V.PAYMENT_AMOUNT_MALFORMED],
    ['empty', '', V.PAYMENT_AMOUNT_MALFORMED],
    ['excessive precision', '10.001', V.PAYMENT_AMOUNT_SCALE_EXCEEDED],
    ['a JavaScript number', 10.5, V.PAYMENT_AMOUNT_NOT_TEXT],
    ['a NaN number', Number.NaN, V.PAYMENT_AMOUNT_NOT_TEXT],
    ['an Infinity number', Number.POSITIVE_INFINITY, V.PAYMENT_AMOUNT_NOT_TEXT],
    ['a bigint', 10n, V.PAYMENT_AMOUNT_NOT_TEXT],
  ];
  for (const [label, value, code] of cases) {
    it(`refuses ${label}`, () => {
      assert.deepEqual(codes(rawPayment({ amount: { value, unit: 'USD' } })), [code]);
    });
  }

  it('refuses an amount that is not exactly { value, unit }', () => {
    assert.deepEqual(codes(rawPayment({ amount: '10' })), [V.PAYMENT_AMOUNT_INVALID]);
    assert.deepEqual(codes(rawPayment({ amount: { value: '10', unit: 'USD', scale: 0 } })), [V.PAYMENT_PROPERTY_UNDECLARED]);
    assert.deepEqual(codes(rawPayment({ amount: { value: '10', currency: 'USD' } })), [V.PAYMENT_PROPERTY_UNDECLARED, V.PAYMENT_ASSET_UNKNOWN]);
  });

  it('keeps precision the asset allows: 8 fractional digits on a scale-8 asset, exactly', () => {
    assert.equal(valid(rawPayment({ amount: { value: '0.00000001', unit: 'net:COIN' } })).amount.value, '0.00000001');
    assert.deepEqual(codes(rawPayment({ amount: { value: '0.000000001', unit: 'net:COIN' } })), [V.PAYMENT_AMOUNT_SCALE_EXCEEDED]);
  });

  it('holds integers beyond 2^53 exactly', () => {
    assert.equal(valid(rawPayment({ amount: { value: '9007199254740993.01', unit: 'USD' } })).amount.value, '9007199254740993.01');
  });
});

describe('PAY-01 P3 — asset references', () => {
  it('accepts any asset the trusted registry recognizes, whatever its namespace', () => {
    for (const unit of ['USD', 'stable:USDX', 'net:COIN', 'net:USDX/acme-bank']) assert.equal(valid(rawPayment({ amount: { value: '1', unit } })).amount.unit, unit);
  });

  it('refuses an asset the registry does not recognize — including a differently-cased spelling', () => {
    for (const unit of ['GBP', 'usd', 'net:coin', '', 7, undefined]) assert.deepEqual(codes(rawPayment({ amount: { value: '1', unit } })), [V.PAYMENT_ASSET_UNKNOWN], String(unit));
  });

  it('describes an identifier without giving any namespace a meaning', () => {
    assert.deepEqual(describePaymentAsset('USD'), { code: 'USD' });
    assert.deepEqual(describePaymentAsset('stable:USDX'), { namespace: 'stable', code: 'USDX' });
    assert.deepEqual(describePaymentAsset('net:USDX/acme-bank'), { namespace: 'net', code: 'USDX', qualifier: 'acme-bank' });
    for (const malformed of ['', ':USD', 'net:', 'net:USDX/', 'a:b:c', 'net:A/b/c', 'has space', 12]) assert.equal(describePaymentAsset(malformed), undefined, String(malformed));
  });
});

describe('PAY-01 P4 — source and destination', () => {
  it('refuses a missing or malformed destination', () => {
    assert.deepEqual(codes(rawPayment({ destination: undefined })), [V.PAYMENT_DESTINATION_INVALID]);
    assert.deepEqual(codes(rawPayment({ destination: 'vendor-4471' })), [V.PAYMENT_DESTINATION_INVALID]);
    assert.deepEqual(codes(rawPayment({ destination: { kind: 'account' } })), [V.PAYMENT_DESTINATION_REFERENCE_INVALID]);
    assert.deepEqual(codes(rawPayment({ destination: { reference: 'vendor-4471' } })), [V.PAYMENT_DESTINATION_KIND_INVALID]);
    assert.deepEqual(codes(rawPayment({ destination: { kind: 'Account', reference: 'vendor-4471' } })), [V.PAYMENT_DESTINATION_KIND_INVALID]);
    assert.deepEqual(codes(rawPayment({ destination: { kind: 'account', reference: 'vendor-4471', note: 'x' } })), [V.PAYMENT_PROPERTY_UNDECLARED]);
  });

  it('refuses a destination reference that is a path, a URL, whitespace or a credential shape', () => {
    for (const reference of ['', ' vendor', 'vendor 1', 'a/b', 'https://pay.example/acct', '../etc', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig', 'x'.repeat(201), '-leading']) {
      assert.deepEqual(codes(rawPayment({ destination: { kind: 'account', reference } })), [V.PAYMENT_DESTINATION_REFERENCE_INVALID], reference);
    }
  });

  it('refuses a missing or malformed source, and a source carrying anything but an account id', () => {
    assert.deepEqual(codes(rawPayment({ source: undefined })), [V.PAYMENT_SOURCE_INVALID]);
    assert.deepEqual(codes(rawPayment({ source: { accountId: 'a/b' } })), [V.PAYMENT_SOURCE_INVALID]);
    assert.deepEqual(codes(rawPayment({ source: { accountId: 'acct-1', privateKey: 'k' } })), [V.PAYMENT_SECRET_MATERIAL_REFUSED]);
  });

  it('encodes a destination as exactly one governed counterparty, and back', () => {
    const destination = { kind: 'payment-address', reference: 'net:abc:def' };
    const counterparty = paymentCounterpartyOf(destination);
    assert.equal(counterparty, 'payment-address:net:abc:def');
    assert.deepEqual(paymentDestinationOf(counterparty), destination);
    for (const malformed of ['vendor-4471', ':x', 'Account:x', 'account:', 'account:a/b', 7, undefined]) assert.equal(paymentDestinationOf(malformed), undefined, String(malformed));
  });

  it('encodes exactly the destination values it validated, reading each once (review P2)', () => {
    let kindReads = 0;
    let referenceReads = 0;
    const tricky = {
      get kind() {
        kindReads += 1;
        return kindReads === 1 ? 'account' : 'Account';
      },
      get reference() {
        referenceReads += 1;
        return referenceReads === 1 ? 'vendor-4471' : 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig';
      },
    };
    assert.equal(paymentCounterpartyOf(tricky), 'account:vendor-4471');
    assert.deepEqual([kindReads, referenceReads], [1, 1]);
  });
});

describe('PAY-01 validation — closed, bounded, secret-free, fail closed', () => {
  it('refuses envelope-owned and authority-shaped fields rather than ignoring them', () => {
    for (const key of ['organizationId', 'requestedBy', 'actorId', 'requestedAt', 'paymentId', 'grantId', 'executionId', 'adapter', 'limit', 'metadata', 'memo', 'currency']) {
      assert.deepEqual(codes(rawPayment({ [key]: 'x' })), [V.PAYMENT_PROPERTY_UNDECLARED], key);
    }
  });

  it('refuses secret-shaped properties by name, without echoing their values', () => {
    for (const key of ['privateKey', 'private_key', 'seed', 'seedPhrase', 'mnemonic', 'password', 'secret', 'apiKey', 'bearer', 'authorization', 'credential', 'signingKey', 'accessToken']) {
      const result = validatePaymentIntent(rawPayment({ [key]: 'SENTINEL-SECRET-VALUE' }), TRUST);
      assert.equal(result.valid, false, key);
      if (!result.valid) {
        assert.deepEqual(result.violations.map((violation) => violation.code), [V.PAYMENT_SECRET_MATERIAL_REFUSED], key);
        assert.equal(JSON.stringify(result).includes('SENTINEL-SECRET-VALUE'), false);
      }
    }
  });

  it('refuses an accessor without running it', () => {
    let ran = false;
    const raw = rawPayment();
    Object.defineProperty(raw, 'purpose', {
      enumerable: true,
      get() {
        ran = true;
        return 'payroll';
      },
    });
    assert.deepEqual(codes(raw), [V.PAYMENT_PROPERTY_NOT_DATA]);
    assert.equal(ran, false);
  });

  it('bounds purpose, reference, rail and identifiers', () => {
    assert.deepEqual(codes(rawPayment({ purpose: 'gift' })), [V.PAYMENT_PURPOSE_INVALID]);
    assert.deepEqual(codes(rawPayment({ purpose: undefined })), [V.PAYMENT_PURPOSE_INVALID]);
    assert.deepEqual(codes(rawPayment({ reference: 'has space' })), [V.PAYMENT_REFERENCE_INVALID]);
    assert.deepEqual(codes(rawPayment({ reference: 'r'.repeat(129) })), [V.PAYMENT_REFERENCE_INVALID]);
    assert.deepEqual(codes(rawPayment({ rail: 'Rail One' })), [V.PAYMENT_RAIL_INVALID]);
    assert.deepEqual(codes(rawPayment({ idempotencyKey: undefined })), [V.PAYMENT_IDEMPOTENCY_KEY_INVALID]);
    assert.deepEqual(codes(rawPayment({ idempotencyKey: ' padded ' })), [V.PAYMENT_IDEMPOTENCY_KEY_INVALID]);
    assert.deepEqual(codes(rawPayment({ idempotencyKey: 'k'.repeat(257) })), [V.PAYMENT_IDEMPOTENCY_KEY_INVALID]);
    assert.deepEqual(codes(rawPayment({ correlationId: 'line\nbreak' })), [V.PAYMENT_CORRELATION_ID_INVALID]);
  });

  it('refuses a credential-shaped business reference or rail, though the token grammars admit its characters (review P2)', () => {
    assert.deepEqual(codes(rawPayment({ reference: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig' })), [V.PAYMENT_REFERENCE_INVALID]);
    assert.deepEqual(codes(rawPayment({ rail: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig' })), [V.PAYMENT_RAIL_INVALID]);
  });

  it('refuses credential-shaped idempotency keys and correlation ids, which are stored durably (review P2)', () => {
    assert.deepEqual(codes(rawPayment({ idempotencyKey: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig' })), [V.PAYMENT_IDEMPOTENCY_KEY_INVALID]);
    assert.deepEqual(codes(rawPayment({ correlationId: 'Bearer abcdefgh12345678' })), [V.PAYMENT_CORRELATION_ID_INVALID]);
    assert.deepEqual(codes(rawPayment({ correlationId: 'authorization: x' })), [V.PAYMENT_CORRELATION_ID_INVALID]);
  });

  it('refuses a non-object, an array and a class instance', () => {
    for (const raw of [null, undefined, 'payment', 7, [rawPayment()], new (class Payment {})()]) assert.deepEqual(codes(raw), [V.PAYMENT_INTENT_NOT_OBJECT]);
  });

  it('reports every violation, deterministically, as codes and field paths only', () => {
    const raw = rawPayment({ source: {}, destination: {}, amount: { value: 'x', unit: 'USD' }, purpose: 'gift', idempotencyKey: '' });
    const first = validatePaymentIntent(raw, TRUST);
    const second = validatePaymentIntent(raw, TRUST);
    assert.deepEqual(first, second);
    assert.equal(first.valid, false);
    if (!first.valid) {
      assert.deepEqual(first.violations, [
        { code: V.PAYMENT_SOURCE_INVALID, field: 'source.accountId' },
        { code: V.PAYMENT_DESTINATION_KIND_INVALID, field: 'destination.kind' },
        { code: V.PAYMENT_DESTINATION_REFERENCE_INVALID, field: 'destination.reference' },
        { code: V.PAYMENT_AMOUNT_MALFORMED, field: 'amount.value' },
        { code: V.PAYMENT_PURPOSE_INVALID, field: 'purpose' },
        { code: V.PAYMENT_IDEMPOTENCY_KEY_INVALID, field: 'idempotencyKey' },
      ]);
    }
  });
});

describe('PAY-01 compilation onto the governed-action envelope', () => {
  it('maps every payment field onto an existing governed axis', () => {
    const intent = valid(rawPayment({ reference: 'INV-2026-0042', rail: 'reference-rail', correlationId: 'corr-1' }));
    const compiled = compilePaymentIntent(intent, BINDING, { assertedContext: { passportId: 'passport-1' } });
    assert.deepEqual(compiled, {
      action: 'payment.send',
      resource: 'acct-operating-001',
      counterparty: 'account:vendor-4471',
      amount: { value: '1250.5', currency: 'USD' },
      parameters: { paymentPurpose: 'vendor-payment', paymentReference: 'INV-2026-0042', paymentRail: 'reference-rail' },
      idempotencyKey: 'pay-0001',
      correlationId: 'corr-1',
      assertedContext: { passportId: 'passport-1' },
    });
    assert.ok(Object.isFrozen(compiled) && Object.isFrozen(compiled.amount) && Object.isFrozen(compiled.parameters));
  });

  it('is deterministic: equal payments compile to byte-identical serializations', () => {
    const one = JSON.stringify(compilePaymentIntent(valid(rawPayment({ amount: { value: '10.50', unit: 'USD' } })), BINDING));
    const two = JSON.stringify(compilePaymentIntent(valid({ ...rawPayment(), amount: { unit: 'USD', value: '10.5' } }), BINDING));
    assert.equal(one, two);
  });

  it('snapshots envelope-owned values: a caller mutating them after compilation changes nothing (review P2)', () => {
    const context: Record<string, unknown> = { passportId: 'passport-1', evidence: { ids: ['e-1'] } };
    const profile = { id: 'governed-payment', version: 1 };
    const compiled = compilePaymentIntent(valid(rawPayment()), BINDING, { assertedContext: context, expectedGovernanceProfile: profile });
    const before = JSON.stringify(compiled);
    context['passportId'] = 'passport-2';
    (context['evidence'] as { ids: string[] }).ids.push('e-2');
    profile.version = 2;
    assert.equal(JSON.stringify(compiled), before);
    assert.notEqual(compiled.assertedContext, context);
    assert.ok(Object.isFrozen(compiled.assertedContext) && Object.isFrozen(compiled.expectedGovernanceProfile));
    const withProto = JSON.parse('{"__proto__": {"x": 1}}') as Record<string, unknown>;
    assert.deepEqual(Object.keys(compilePaymentIntent(valid(rawPayment()), BINDING, { assertedContext: withProto }).assertedContext ?? {}), ['__proto__']);
  });

  it('compiles from a single read: a getter-backed intent is refused without running it (review P2)', () => {
    let reads = 0;
    const tricky = { ...valid(rawPayment()) } as Record<string, unknown>;
    Object.defineProperty(tricky, 'reference', {
      enumerable: true,
      get() {
        reads += 1;
        return reads === 1 ? 'INV-1' : 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig';
      },
    });
    assert.throws(() => compilePaymentIntent(tricky as unknown as PaymentIntent, BINDING), RangeError);
    assert.equal(reads, 0);
  });

  it('reads the binding action once and emits exactly the value it checked (review P2)', () => {
    let reads = 0;
    const binding = {
      get action() {
        reads += 1;
        return reads === 1 ? 'payment.send' : 'payment.other';
      },
    };
    assert.equal(compilePaymentIntent(valid(rawPayment()), binding).action, 'payment.send');
    assert.equal(reads, 1);
  });

  it('refuses a profile expectation that is not exactly two data properties, never repairing it (review P2)', () => {
    for (const pin of [{ id: 'p', version: 1, extra: true }, { id: 'p' }, Object.defineProperty({ version: 1 }, 'id', { enumerable: true, get: () => 'p' })]) {
      assert.throws(() => compilePaymentIntent(valid(rawPayment()), BINDING, { expectedGovernanceProfile: pin as never }), RangeError, JSON.stringify(pin));
    }
  });

  it('refuses envelope data that is not plain JSON, rather than carrying a live reference', () => {
    for (const assertedContext of [new Map(), { at: new Date(0) }, { run: () => 1 }, [] as unknown as Record<string, unknown>]) {
      assert.throws(() => compilePaymentIntent(valid(rawPayment()), BINDING, { assertedContext: assertedContext as Record<string, unknown> }), RangeError);
    }
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    assert.throws(() => compilePaymentIntent(valid(rawPayment()), BINDING, { assertedContext: cyclic }), RangeError);
    assert.throws(() => compilePaymentIntent(valid(rawPayment()), BINDING, { expectedGovernanceProfile: { id: 'p' } as never }), RangeError);
  });

  it('refuses envelope data whose JSON form would differ from the value: holes, non-finite numbers, hidden properties (review P2)', () => {
    const refused: readonly [string, unknown][] = [
      ['a sparse array', { evidence: new Array(1) }],
      ['a hole among values', { evidence: (() => { const a: unknown[] = ['a', 'b']; delete a[0]; return a; })() }],
      ['an array with an extra property', { evidence: Object.assign(['a'], { extra: 1 }) }],
      ['NaN', { score: Number.NaN }],
      ['Infinity', { score: Number.POSITIVE_INFINITY }],
      ['a nested -Infinity', { nested: [Number.NEGATIVE_INFINITY] }],
      ['negative zero, which serializes as 0', { score: -0 }],
      ['a nested negative zero', { nested: { values: [1, -0] } }],
      ['a non-enumerable property', Object.defineProperty({ visible: 1 }, 'hidden', { value: 2, enumerable: false })],
      ['a symbol property', { visible: 1, [Symbol('fact')]: 2 }],
    ];
    for (const [label, assertedContext] of refused) {
      assert.throws(() => compilePaymentIntent(valid(rawPayment()), BINDING, { assertedContext: assertedContext as Record<string, unknown> }), RangeError, label);
    }
    for (const version of [Number.NaN, Number.POSITIVE_INFINITY, -0]) {
      assert.throws(() => compilePaymentIntent(valid(rawPayment()), BINDING, { expectedGovernanceProfile: { id: 'p', version } }), RangeError, String(version));
    }
    // Plain, dense, finite JSON — including an empty array and nulls — still compiles unchanged.
    const context = { evidence: [], ids: ['a', null], score: 0.5, flags: { ok: true } };
    assert.deepEqual(compilePaymentIntent(valid(rawPayment()), BINDING, { assertedContext: context }).assertedContext, context);
  });

  it('reads the envelope options once: accessor and undeclared options are refused without being run (review P2)', () => {
    let reads = 0;
    const getterContext = {
      get assertedContext() {
        reads += 1;
        return reads === 1 ? undefined : { fact: 'second' };
      },
    };
    assert.throws(() => compilePaymentIntent(valid(rawPayment()), BINDING, getterContext as never), RangeError);
    const getterProfile = Object.defineProperty({}, 'expectedGovernanceProfile', { enumerable: true, get: () => ({ id: 'p', version: 1 }) });
    assert.throws(() => compilePaymentIntent(valid(rawPayment()), BINDING, getterProfile as never), RangeError);
    assert.equal(reads, 0);
    assert.throws(() => compilePaymentIntent(valid(rawPayment()), BINDING, { assertedContext: {}, extra: 1 } as never), RangeError);
    assert.throws(() => compilePaymentIntent(valid(rawPayment()), BINDING, 'envelope' as never), RangeError);
    // An explicitly undefined option is simply absent, exactly as before.
    assert.equal('assertedContext' in compilePaymentIntent(valid(rawPayment()), BINDING, { assertedContext: undefined } as never), false);
  });

  it('enforces the envelope width bound before traversing anything (review P2)', () => {
    let touched = 0;
    const wide = Array.from({ length: 65 }, (_, index) => index);
    const watched = new Proxy(wide, {
      get(target, property, receiver) {
        if (typeof property === 'string' && /^[0-9]+$/.test(property)) touched += 1;
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
    assert.throws(() => compilePaymentIntent(valid(rawPayment()), BINDING, { assertedContext: { wide: watched } }), RangeError);
    assert.equal(touched, 0, 'no element is read once the width is known to exceed the bound');
    const wideObject = Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`k${index}`, index]));
    assert.throws(() => compilePaymentIntent(valid(rawPayment()), BINDING, { assertedContext: wideObject }), RangeError);
    const atBound = Object.fromEntries(Array.from({ length: 64 }, (_, index) => [`k${index}`, index]));
    assert.equal(Object.keys(compilePaymentIntent(valid(rawPayment()), BINDING, { assertedContext: atBound }).assertedContext ?? {}).length, 64);
  });

  it('omits optional parameters rather than inventing them', () => {
    assert.deepEqual(compilePaymentIntent(valid(rawPayment()), BINDING).parameters, { paymentPurpose: 'vendor-payment' });
  });

  it('never repairs: refuses a value that is not a canonical payment intent, and a malformed binding', () => {
    assert.throws(() => compilePaymentIntent({ ...valid(rawPayment()), amount: { value: '0', unit: 'USD' } }, BINDING), RangeError);
    assert.throws(() => compilePaymentIntent({ ...valid(rawPayment()), extra: 1 } as unknown as PaymentIntent, BINDING), RangeError);
    // Review P2: an amount carrying a contradictory extra field is not canonical, and is refused rather than silently narrowed.
    assert.throws(() => compilePaymentIntent({ ...valid(rawPayment()), amount: { value: '10', unit: 'USD', currency: 'EUR' } } as unknown as PaymentIntent, BINDING), RangeError);
    assert.throws(() => compilePaymentIntent({ ...valid(rawPayment()), reference: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig' }, BINDING), RangeError);
    assert.throws(() => compilePaymentIntent(valid(rawPayment()), { action: ' ' }), PaymentConfigurationError);
    assert.throws(() => createPaymentGovernanceBinding({ action: '' }), PaymentConfigurationError);
  });

  it('declares its parameter dimensions as exact-bound tokens, purpose required', () => {
    assert.deepEqual(PAYMENT_PARAMETER_DIMENSIONS, [
      { id: 'paymentPurpose', type: 'token', bound: 'exact' },
      { id: 'paymentReference', type: 'token', bound: 'exact' },
      { id: 'paymentRail', type: 'token', bound: 'exact' },
    ]);
    assert.deepEqual(PAYMENT_PROFILE_PARAMETERS, [
      { dimension: 'paymentPurpose', required: true },
      { dimension: 'paymentReference', required: false },
      { dimension: 'paymentRail', required: false },
    ]);
  });
});
