import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { PaymentConfigurationError, readPaymentProtectedRequest, readPaymentProtocolInterpretation, type PaymentProtectedRequestBinding, type PaymentProtocolInterpretation } from '../../../domain/index.js';
import { MPP_PROTOCOL_ID, MPP_RESERVED_CONTEXT_KEYS, createMppPaymentProtocolAdapter, type MppChallengeCandidate } from '../index.js';
import { DEFAULT_CHARGE, GET_REQUEST, OBSERVED_AT, TEST_ASSETS, context, contentDigestOf, directoryResolver, onlyCandidate, paymentChallenge, testAdapter, testpayNormalizer } from './mpp-test-support.js';

/**
 * PAY-04 layers B and C — MPP protocol interpretation and normalization into
 * `PaymentProtocolTerms`: binding, expiry, trusted method normalizers, trusted
 * counterparty resolution and trusted selection. The adapter is pure; every
 * answer below is re-read by the port's own closed reader, exactly as the
 * ingress reads it.
 */

function interpret(challenges: unknown, overrides: Parameters<typeof context>[0] = {}, adapter = testAdapter()): PaymentProtocolInterpretation {
  const raw = adapter.interpret(challenges, context(overrides));
  const read = readPaymentProtocolInterpretation(raw, { assets: TEST_ASSETS });
  assert.ok(read !== undefined, 'the adapter answers a closed interpretation');
  return read;
}

function refusal(challenges: unknown, overrides: Parameters<typeof context>[0] = {}, adapter = testAdapter()): string {
  const result = interpret(challenges, overrides, adapter);
  assert.equal(result.interpreted, false, JSON.stringify(result));
  return result.interpreted ? '' : result.refusal;
}

function postRequest(body: string): PaymentProtectedRequestBinding {
  const binding = readPaymentProtectedRequest({ target: 'merchant:orders', method: 'POST', contentDigest: contentDigestOf(body) });
  assert.ok(binding !== undefined);
  return binding;
}

describe('PAY-04 B/C — a valid challenge becomes exact protocol terms', () => {
  it('normalizes through the trusted method and resolver into a PAY-01 destination and exact P9 money', () => {
    const result = interpret(paymentChallenge());
    assert.equal(result.interpreted, true, JSON.stringify(result));
    if (!result.interpreted) return;
    assert.deepEqual(result.terms, { destination: { kind: 'account', reference: 'vendor-4471' }, amount: { value: '10', unit: 'USD' }, reference: 'ORD-1' });
    assert.equal(result.challenge.key, JSON.stringify(['api.merchant.example', 'ch-1']));
    assert.deepEqual(Object.keys(result.challenge.fields).sort(), ['expires', 'id', 'intent', 'method', 'realm', 'request']);
    assert.equal(Object.isFrozen(result.terms) && Object.isFrozen(result.challenge.fields), true);
  });

  it('a rail preference comes from trusted method composition only — never from the challenge', () => {
    const adapter = testAdapter({ methods: [testpayNormalizer({ rail: 'example-rail' })] });
    const result = interpret(paymentChallenge({ request: { ...DEFAULT_CHARGE, rail: 'attacker-rail' } }), {}, adapter);
    assert.equal(result.interpreted && result.terms.rail, 'example-rail');
  });

  it('is the protocol "mpp" and reserves its own words for the CORE-03 registry', () => {
    const adapter = testAdapter();
    assert.equal(adapter.protocolId, MPP_PROTOCOL_ID);
    assert.deepEqual([...adapter.reservedContextKeys], [...MPP_RESERVED_CONTEXT_KEYS]);
  });
});

describe('PAY-04 B — challenge validity and support (M1, M19)', () => {
  it('M1: a malformed carrier or no well-formed Payment challenge is challenge-invalid', () => {
    for (const carrier of ['Payment id=', 'Bearer realm="x"', 42, undefined, { header: paymentChallenge() }, paymentChallenge({ method: 'Bad' })]) assert.equal(refusal(carrier), 'challenge-invalid', String(carrier));
  });

  it('a malformed Payment challenge beside a valid one does not hide the valid one', () => {
    const result = interpret(`${paymentChallenge({ id: 'bad', method: 'BAD' })}, ${paymentChallenge({ id: 'good' })}`);
    assert.equal(result.interpreted && result.challenge.key, JSON.stringify(['api.merchant.example', 'good']));
  });

  it('M19: an unsupported method or intent is challenge-unsupported', () => {
    assert.equal(refusal(paymentChallenge({ method: 'otherpay' })), 'challenge-unsupported');
    assert.equal(refusal(paymentChallenge({ intent: 'subscription' })), 'challenge-unsupported');
  });
});

describe('PAY-04 B — protected-request binding (M16, M17, M18)', () => {
  it('M16: a realm that differs from the expected protection space is a binding mismatch', () => {
    const expecting = { ...GET_REQUEST, expectedRealm: 'api.merchant.example' };
    assert.equal(interpret(paymentChallenge(), { protectedRequest: expecting }).interpreted, true);
    assert.equal(refusal(paymentChallenge({ realm: 'api.other.example' }), { protectedRequest: expecting }), 'request-binding-mismatch');
  });

  it('M17: a body-bearing request needs a challenge digest', () => {
    assert.equal(refusal(paymentChallenge(), { protectedRequest: postRequest('{"order":42}') }), 'request-binding-mismatch');
  });

  it('M18: a digest over another body is a binding mismatch; the matching body binds', () => {
    assert.equal(refusal(paymentChallenge({ digest: contentDigestOf('{"order":43}') }), { protectedRequest: postRequest('{"order":42}') }), 'request-binding-mismatch');
    assert.equal(interpret(paymentChallenge({ digest: contentDigestOf('{"order":42}') }), { protectedRequest: postRequest('{"order":42}') }).interpreted, true);
  });

  it('a digest on a request without a body binds nothing and is refused', () => {
    assert.equal(refusal(paymentChallenge({ digest: contentDigestOf('x') })), 'request-binding-mismatch');
  });

  it('the trusted protected request is itself closed: no URL, no undigested body, no extra field', () => {
    assert.equal(readPaymentProtectedRequest({ target: 'https://merchant.example/report', method: 'GET' }), undefined);
    assert.equal(readPaymentProtectedRequest({ target: 'merchant:orders', method: 'POST' }), undefined);
    assert.equal(readPaymentProtectedRequest({ target: 'merchant:orders', method: 'get' }), undefined);
    assert.equal(readPaymentProtectedRequest({ target: 'merchant:orders', method: 'GET', cookie: 'a=b' }), undefined);
    const getter = { target: 'merchant:orders' } as Record<string, unknown>;
    Object.defineProperty(getter, 'method', { get: () => 'GET', enumerable: true });
    assert.equal(readPaymentProtectedRequest(getter), undefined);
  });
});

describe('PAY-04 B — expiry (M15)', () => {
  it('M15: an expired challenge is refused at the trusted instant — the adapter reads no clock', () => {
    assert.equal(refusal(paymentChallenge({ expires: '2026-09-24T12:00:00Z' })), 'challenge-expired');
    assert.equal(interpret(paymentChallenge({ expires: '2026-09-24T12:00:00Z' }), { observedAtEpochMilliseconds: OBSERVED_AT - 1 }).interpreted, true);
  });

  it('a binding mismatch outranks expiry whatever the merchant’s order — precedence is fixed', () => {
    const header = [paymentChallenge({ id: 'a', expires: '2026-09-24T11:00:00Z' }), paymentChallenge({ id: 'b', realm: 'other' })];
    const expecting = { protectedRequest: { ...GET_REQUEST, expectedRealm: 'api.merchant.example' } };
    assert.equal(refusal(header, expecting), 'request-binding-mismatch');
    assert.equal(refusal([...header].reverse(), expecting), 'request-binding-mismatch');
  });
});

describe('PAY-04 C — trusted method normalization (M21 – M25)', () => {
  const amount = (value: string, currency = 'usd') => paymentChallenge({ request: { ...DEFAULT_CHARGE, amount: value, currency } });

  it('M21 – M24: malformed, scientific, negative, zero and excessive-precision amounts never become money', () => {
    for (const value of ['10.5', '1e3', '-100', '0', '00100', ' 100', '100 ', 'NaN', 'Infinity', '']) assert.equal(refusal(amount(value)), 'normalization-failed', value);
  });

  it('M21: a normalizer answering a number, a float, NaN, scientific notation or excess precision is not an answer', () => {
    for (const bad of [10, 10.5, Number.NaN, '1e1', '10.001', '-1', '0', '0.00']) {
      const adapter = testAdapter({ methods: [testpayNormalizer({ normalize: () => ({ amount: { value: bad as string, unit: 'USD' }, merchantReference: 'm-001' }) })] });
      assert.equal(refusal(paymentChallenge(), {}, adapter), 'normalization-failed', String(bad));
    }
  });

  it('M25: an asset outside the trusted registry is refused — the challenge cannot introduce one', () => {
    assert.equal(refusal(amount('100', 'gbp')), 'normalization-failed');
    const adapter = testAdapter({ methods: [testpayNormalizer({ normalize: () => ({ amount: { value: '1', unit: 'RLUSD' }, merchantReference: 'm-001' }) })] });
    assert.equal(refusal(paymentChallenge(), {}, adapter), 'normalization-failed');
  });

  it('a normalizer answer with an authority-shaped or undeclared key, a getter, a Proxy that throws, a promise or a throw is refused', () => {
    const answers: unknown[] = [
      { amount: { value: '10', unit: 'USD' }, merchantReference: 'm-001', authorized: true },
      { amount: { value: '10', unit: 'USD' }, ceiling: '1000000' },
      { amount: { value: '10', unit: 'USD' }, destination: { kind: 'account', reference: 'attacker' } },
      { amount: { value: '10', unit: 'USD' }, source: { accountId: 'treasury' } },
      { amount: { value: '10', unit: 'USD', extra: 1 } },
      Object.defineProperty({ merchantReference: 'm-001' }, 'amount', { get: () => ({ value: '10', unit: 'USD' }), enumerable: true }),
      new Proxy({}, { ownKeys: () => { throw new Error('trap'); } }),
      Promise.resolve({ amount: { value: '10', unit: 'USD' } }),
      { amount: { value: '10', unit: 'USD' }, reference: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig' },
    ];
    for (const answer of answers) {
      const adapter = testAdapter({ methods: [testpayNormalizer({ normalize: () => answer as never })] });
      assert.equal(refusal(paymentChallenge(), {}, adapter), 'normalization-failed');
    }
    const throwing = testAdapter({
      methods: [
        testpayNormalizer({
          normalize: () => {
            throw new Error('boom');
          },
        }),
      ],
    });
    assert.equal(refusal(paymentChallenge(), {}, throwing), 'normalization-failed');
  });
});

describe('PAY-04 C — trusted counterparty resolution (M26)', () => {
  it('M26: a merchant reference the trusted directory does not map is refused — never copied into a destination', () => {
    assert.equal(refusal(paymentChallenge({ request: { ...DEFAULT_CHARGE, recipient: 'attacker-account' } })), 'counterparty-unresolved');
    assert.equal(refusal(paymentChallenge({ request: { amount: '1000', currency: 'usd' } })), 'counterparty-unresolved');
  });

  it('a resolver answering something other than exactly a PAY-01 destination, or throwing, refuses', () => {
    for (const answer of [{ kind: 'account' }, { kind: 'Account', reference: 'x' }, { kind: 'account', reference: 'a/b' }, { kind: 'account', reference: 'x', signer: 'k' }, 'account:vendor-4471', Promise.resolve({ kind: 'account', reference: 'x' })]) {
      assert.equal(refusal(paymentChallenge(), {}, testAdapter({ resolveCounterparty: () => answer as never })), 'counterparty-unresolved');
    }
    const throwing = testAdapter({
      resolveCounterparty: () => {
        throw new Error('directory down');
      },
    });
    assert.equal(refusal(paymentChallenge(), {}, throwing), 'counterparty-unresolved');
  });

  it('the resolver is told the realm and merchant reference as context only — never an authority', () => {
    let seen: unknown;
    interpret(paymentChallenge(), {}, testAdapter({ resolveCounterparty: (resolution) => ((seen = resolution), directoryResolver(resolution)) }));
    assert.deepEqual(seen, { organizationId: 'org-a', methodId: 'testpay', intent: 'charge', realm: 'api.merchant.example', merchantReference: 'm-001', target: 'merchant:report-42', method: 'GET' });
    assert.ok(Object.isFrozen(seen));
  });
});

describe('PAY-04 C — trusted challenge selection (M20)', () => {
  const two = [paymentChallenge({ id: 'a' }), paymentChallenge({ id: 'b', request: { ...DEFAULT_CHARGE, amount: '900' } })];

  it('M20: several usable challenges and a selector that will not choose exactly one is challenge-ambiguous', () => {
    assert.equal(refusal(two), 'challenge-ambiguous');
    for (const answer of [undefined, 'c', 42, Promise.resolve('a'), new String('a')]) assert.equal(refusal(two, {}, testAdapter({ selectChallenge: () => answer as never })), 'challenge-ambiguous');
    assert.equal(
      refusal(two, {}, testAdapter({
        selectChallenge: () => {
          throw new Error('x');
        },
      })),
      'challenge-ambiguous',
    );
  });

  it('two candidates sharing the chosen id is ambiguous, never first-wins', () => {
    assert.equal(refusal([paymentChallenge({ id: 'a' }), paymentChallenge({ id: 'a', realm: 'r2' })], {}, testAdapter({ selectChallenge: () => 'a' })), 'challenge-ambiguous');
  });

  it('the selector is asked even for one candidate, and the merchant’s order never decides', () => {
    let calls = 0;
    const cheapest = testAdapter({
      selectChallenge: (candidates: readonly MppChallengeCandidate[]) => {
        calls += 1;
        return [...candidates].sort((left, right) => (left.amount.value.length - right.amount.value.length) || left.amount.value.localeCompare(right.amount.value))[0]?.id;
      },
    });
    const forward = interpret(two, {}, cheapest);
    const reversed = interpret([...two].reverse(), {}, cheapest);
    assert.equal(forward.interpreted && forward.challenge.key, JSON.stringify(['api.merchant.example', 'b']));
    assert.deepEqual(forward, reversed);
    interpret(paymentChallenge(), {}, cheapest);
    assert.equal(calls, 3);
  });

  it('the selector sees only usable, normalized, frozen candidates', () => {
    let seen: readonly MppChallengeCandidate[] = [];
    interpret([paymentChallenge({ id: 'a' }), paymentChallenge({ id: 'expired', expires: '2026-09-24T11:00:00Z' })], {}, testAdapter({ selectChallenge: (candidates, selection) => ((seen = candidates), onlyCandidate(candidates, selection)) }));
    assert.deepEqual(seen.map((candidate) => candidate.id), ['a']);
    assert.ok(Object.isFrozen(seen) && Object.isFrozen(seen[0]));
    assert.deepEqual(seen[0]?.destination, { kind: 'account', reference: 'vendor-4471' });
  });
});

describe('PAY-04 — adapter composition is trusted and fail-closed', () => {
  it('refuses missing, duplicate or malformed normalizers, and a missing resolver, selector or registry', () => {
    const bad: unknown[] = [
      { methods: [] },
      { methods: [testpayNormalizer(), testpayNormalizer()] },
      { methods: [testpayNormalizer({ methodId: 'Test-Pay' })] },
      { methods: [testpayNormalizer({ intent: 'subscription' as never })] },
      { methods: [testpayNormalizer({ rail: 'Not A Rail' })] },
      { methods: [testpayNormalizer()], resolveCounterparty: undefined },
      { methods: [testpayNormalizer()], selectChallenge: undefined },
      { methods: [testpayNormalizer()], assets: undefined },
    ];
    for (const options of bad) {
      assert.throws(() => createMppPaymentProtocolAdapter({ methods: [testpayNormalizer()], resolveCounterparty: directoryResolver, selectChallenge: onlyCandidate, assets: TEST_ASSETS, ...(options as object) }), PaymentConfigurationError);
    }
  });

  it('snapshots its composition: mutating the host’s methods array later changes nothing', () => {
    const methods = [testpayNormalizer()];
    const adapter = createMppPaymentProtocolAdapter({ methods, resolveCounterparty: directoryResolver, selectChallenge: onlyCandidate, assets: TEST_ASSETS });
    methods.length = 0;
    assert.equal(interpret(paymentChallenge(), {}, adapter).interpreted, true);
  });

  it('is total: a hostile carrier never throws out of the adapter', () => {
    const hostile = new Proxy([], {
      get: () => {
        throw new Error('trap');
      },
    });
    assert.equal(refusal(hostile), 'challenge-invalid');
  });
});
