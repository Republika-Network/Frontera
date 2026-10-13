import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { PaymentConfigurationError, readPaymentProtocolInterpretation, type PaymentProtocolInterpretation } from '../../../domain/index.js';
import { X402_RESERVED_CONTEXT_KEYS, createX402PaymentProtocolAdapter, x402DecimalOfAtomic, type X402ExecutionMapping } from '../index.js';
import { ASSETS, MAPPING_A, MAPPING_B, NET_A, NET_B, RESOURCE_URL, TARGET, UNIT_A, adapterWith, carrierOf, contextFor, paymentRequired, requirement, testBinding, type BindingLog } from './x402-test-support.js';

const CONTEXT = contextFor();

/** The adapter's answer, read exactly as the PAY-04 ingress reads it. */
function interpret(accepts: readonly unknown[], options: Parameters<typeof adapterWith>[0] & { readonly context?: ReturnType<typeof contextFor>; readonly overrides?: Record<string, unknown> } = {}): PaymentProtocolInterpretation {
  const adapter = adapterWith(options);
  const answer = readPaymentProtocolInterpretation(adapter.interpret(carrierOf(paymentRequired(accepts, options.overrides)), options.context ?? CONTEXT), { assets: ASSETS });
  assert.ok(answer !== undefined, 'the ingress can always read the adapter’s answer');
  return answer;
}

const refusalOf = (answer: PaymentProtocolInterpretation): string => (answer.interpreted ? 'interpreted' : answer.refusal);
const chosen = (answer: PaymentProtocolInterpretation): string => {
  assert.ok(answer.interpreted, refusalOf(answer));
  return answer.challenge.key;
};

describe('PAY-08 — composition', () => {
  it('reserves x402’s own context words', () => {
    assert.deepEqual([...X402_RESERVED_CONTEXT_KEYS].sort(), ['paymentPayload', 'paymentRequired', 'paymentRequirements', 'paymentResponse', 'paymentSignature', 'x402', 'x402Payment']);
  });

  it('refuses a mapping that is not exactly configuration it can honour', () => {
    const compose = (mapping: Partial<X402ExecutionMapping>, flows?: readonly ('authorization' | 'upfront')[]) => () =>
      createX402PaymentProtocolAdapter({ mappings: [{ ...MAPPING_A, ...mapping } as X402ExecutionMapping], bindings: [testBinding(undefined, flows)], resolveRequest: () => undefined, assets: ASSETS });
    assert.doesNotThrow(compose({}));
    assert.throws(compose({ scheme: 'upto' }), PaymentConfigurationError, 'only `exact` is interpreted');
    assert.throws(compose({ network: 'not caip' }), PaymentConfigurationError);
    assert.throws(compose({ unit: 'test:UNKNOWN' }), PaymentConfigurationError, 'the unit must be a P9 asset');
    assert.throws(compose({ atomicScale: 7 }), PaymentConfigurationError, 'the atomic scale never exceeds the asset scale');
    assert.throws(compose({ atomicScale: 1.5 }), PaymentConfigurationError);
    assert.throws(compose({ bindingId: 'other' }), PaymentConfigurationError);
    assert.throws(compose({ network: 'test:net-z' }), PaymentConfigurationError, 'the binding must support the offer');
    assert.throws(compose({ paymentFlows: ['escrow' as never] }), PaymentConfigurationError, 'escrow is never executable');
    assert.throws(compose({ paymentFlows: ['upfront'] }, ['authorization']), PaymentConfigurationError, 'a flow the binding cannot interpret');
    assert.throws(compose({ maximumTimeoutSeconds: 0 }), PaymentConfigurationError);
    assert.throws(compose({ rail: 'Not A Rail' }), PaymentConfigurationError);
    assert.throws(() => createX402PaymentProtocolAdapter({ mappings: [MAPPING_A, MAPPING_A], bindings: [testBinding()], resolveRequest: () => undefined, assets: ASSETS }), PaymentConfigurationError, 'one offer, one mapping');
    assert.throws(() => createX402PaymentProtocolAdapter({ mappings: [MAPPING_A], bindings: [{ ...testBinding(), paymentFlows: ['escrow' as never] }], resolveRequest: () => undefined, assets: ASSETS }), PaymentConfigurationError);
  });
});

describe('PAY-08 hardening — a binding’s default flow is one of its own flows (FLOW-CFG)', () => {
  const compose = (binding: { readonly paymentFlows: readonly string[]; readonly defaultPaymentFlow: string }, mappingFlows: readonly string[] = ['upfront']) => () =>
    createX402PaymentProtocolAdapter({
      mappings: [{ ...MAPPING_A, paymentFlows: mappingFlows as never }],
      bindings: [{ ...testBinding(), paymentFlows: binding.paymentFlows as never, defaultPaymentFlow: binding.defaultPaymentFlow as never }],
      resolveRequest: () => undefined,
      assets: ASSETS,
    });

  it('FLOW-CFG-1 flows [upfront], default upfront: valid', () => {
    assert.doesNotThrow(compose({ paymentFlows: ['upfront'], defaultPaymentFlow: 'upfront' }));
  });

  it('FLOW-CFG-2 flows [upfront], default authorization: a configuration error, not a silently skipped offer', () => {
    assert.throws(compose({ paymentFlows: ['upfront'], defaultPaymentFlow: 'authorization' }), PaymentConfigurationError);
  });

  it('FLOW-CFG-3 flows [authorization, upfront], default authorization: valid', () => {
    assert.doesNotThrow(compose({ paymentFlows: ['authorization', 'upfront'], defaultPaymentFlow: 'authorization' }, ['authorization', 'upfront']));
  });

  it('FLOW-CFG-4 a flow declared twice — by a binding or a mapping — is refused', () => {
    assert.throws(compose({ paymentFlows: ['upfront', 'upfront'], defaultPaymentFlow: 'upfront' }), PaymentConfigurationError);
    assert.throws(compose({ paymentFlows: ['authorization', 'upfront'], defaultPaymentFlow: 'upfront' }, ['upfront', 'upfront']), PaymentConfigurationError);
  });

  it('FLOW-CFG-5 a default that is an x402 flow but not one the binding declares is refused (escrow included)', () => {
    assert.throws(compose({ paymentFlows: ['authorization'], defaultPaymentFlow: 'upfront' }, ['authorization']), PaymentConfigurationError);
    assert.throws(compose({ paymentFlows: ['upfront'], defaultPaymentFlow: 'escrow' }), PaymentConfigurationError);
    assert.throws(compose({ paymentFlows: ['upfront'], defaultPaymentFlow: 'unknown' }), PaymentConfigurationError);
  });

  it('FLOW-CFG-6 a mapping’s flows are still a subset of its binding’s', () => {
    assert.throws(compose({ paymentFlows: ['upfront'], defaultPaymentFlow: 'upfront' }, ['authorization']), PaymentConfigurationError);
    assert.doesNotThrow(compose({ paymentFlows: ['authorization', 'upfront'], defaultPaymentFlow: 'upfront' }, ['upfront']));
  });

  it('a requirement omitting extra.paymentFlow resolves to the binding’s (declared) default', () => {
    const adapter = createX402PaymentProtocolAdapter({
      mappings: [{ ...MAPPING_A, paymentFlows: ['upfront'] }],
      bindings: [{ ...testBinding(), paymentFlows: ['upfront'], defaultPaymentFlow: 'upfront' }],
      resolveRequest: ({ target }) => (target === TARGET ? { url: RESOURCE_URL, fields: {} } : undefined),
      assets: ASSETS,
    });
    const answer = readPaymentProtocolInterpretation(adapter.interpret(carrierOf(paymentRequired([requirement()])), CONTEXT), { assets: ASSETS });
    assert.ok(answer?.interpreted, answer?.interpreted ? '' : answer?.refusal);
    assert.equal(answer.challenge.fields['payment-flow'], 'upfront');
  });
});

describe('PAY-08 — interpretation into PAY-01 terms', () => {
  it('produces exact terms, a binding-made destination, the trusted rail and closed evidence', () => {
    const answer = interpret([requirement()]);
    assert.ok(answer.interpreted);
    assert.deepEqual(answer.terms, { destination: { kind: 'test-account', reference: 'acct-merchant-a' }, amount: { value: '0.00125', unit: UNIT_A }, rail: 'test-rail-a' });
    assert.equal(answer.challenge.key, `x402:2:${NET_A}:inv-1`);
    assert.deepEqual(Object.keys(answer.challenge.fields).sort(), ['amount', 'asset', 'binding', 'instrument', 'max-timeout', 'network', 'pay-to', 'payment-flow', 'requirement', 'scheme', 'version']);
    assert.equal(answer.challenge.fields['payment-flow'], 'authorization', 'the mechanism default when the server omits it');
    for (const value of Object.values(answer.challenge.fields)) assert.equal(/Quarterly|PAYMENT-SIGNATURE header is required|Merchant Reports|finance/.test(value), false, 'display metadata and the merchant error never reach evidence');
  });

  it('the destination is the binding’s trusted translation — an unknown payTo is never copied into one', () => {
    assert.equal(refusalOf(interpret([requirement({ payTo: 'attacker' })])), 'counterparty-unresolved');
  });

  it('a binding answer that is not exactly an answer is normalization-failed (an `authorized` key is not authority)', () => {
    assert.equal(refusalOf(interpret([requirement({ extra: { garbage: true } })])), 'normalization-failed');
  });

  it('the resource is the trusted request, exactly: another URL, a reordered query, a dropped query, a trailing slash or a case change is a mismatch', () => {
    for (const url of ['https://api.merchant.example/reports/43?format=json&lang=en', 'https://api.merchant.example/reports/42?lang=en&format=json', 'https://api.merchant.example/reports/42', 'https://api.merchant.example/reports/42/?format=json&lang=en', 'https://API.merchant.example/reports/42?format=json&lang=en', 'http://api.merchant.example/reports/42?format=json&lang=en']) {
      assert.equal(refusalOf(interpret([requirement()], { overrides: { resource: { url } } })), 'request-binding-mismatch', url);
    }
    assert.equal(refusalOf(interpret([requirement()], { context: contextFor({ target: 'merchant:other' }) })), 'request-binding-mismatch', 'a target the trusted resolver does not know');
  });

  it('a throwing or lying request resolver binds nothing', () => {
    const throwing = createX402PaymentProtocolAdapter({ mappings: [MAPPING_A], bindings: [testBinding()], resolveRequest: () => { throw new Error('down'); }, assets: ASSETS });
    assert.deepEqual(throwing.interpret(carrierOf(paymentRequired([requirement()])), CONTEXT), { interpreted: false, refusal: 'request-binding-mismatch' });
    let ran = false;
    const lying = createX402PaymentProtocolAdapter({ mappings: [MAPPING_A], bindings: [testBinding()], resolveRequest: () => ({ get url() { ran = true; return RESOURCE_URL; }, fields: {} }) as never, assets: ASSETS });
    assert.deepEqual(lying.interpret(carrierOf(paymentRequired([requirement()])), CONTEXT), { interpreted: false, refusal: 'request-binding-mismatch' });
    assert.equal(ran, false);
  });

  it('hands the binding the trusted request — method, body digest, bound fields — never merchant data for them', () => {
    const log: BindingLog = { interpreted: [], prepared: [] };
    const digest = 'sha-256=:X48E9qOokqqrvdts8nOJRJN3OWDUoyWxBf7kbu9DBPE=:';
    interpret([requirement()], { log, fields: { accept: 'application/json', authorization: null }, context: contextFor({ method: 'POST', contentDigest: digest }) });
    const [request] = log.interpreted;
    assert.equal(request?.request.method, 'POST');
    assert.equal(request?.request.bodyBearing, true);
    assert.equal(request?.request.contentDigest?.canonical, digest);
    assert.deepEqual({ ...request?.request.fields }, { accept: 'application/json', authorization: null });
    assert.equal(request?.request.url, RESOURCE_URL);
    assert.ok(Object.isFrozen(request) && Object.isFrozen(request?.request));
  });

  it('the adapter is total: whatever arrives, the ingress gets a closed answer', () => {
    const adapter = adapterWith();
    for (const carrier of [undefined, null, 1, 'x', [], {}, { status: 402 }, { status: 402, headers: [['PAYMENT-REQUIRED', '']] }]) {
      assert.deepEqual(adapter.interpret(carrier, CONTEXT), { interpreted: false, refusal: 'challenge-invalid' });
    }
  });
});

describe('PAY-08 — atomic amounts (AMT)', () => {
  it('AMT-1 exact conversion under the trusted scale; AMT-10 exact round trip', () => {
    assert.equal(x402DecimalOfAtomic('1250', 6), '0.00125');
    assert.equal(x402DecimalOfAtomic('1000000', 6), '1');
    assert.equal(x402DecimalOfAtomic('1', 6), '0.000001');
    assert.equal(x402DecimalOfAtomic('123456789', 2), '1234567.89');
    assert.equal(x402DecimalOfAtomic('25000', 11), '0.00000025');
    assert.equal(x402DecimalOfAtomic('100000000000', 11), '1');
    assert.equal(x402DecimalOfAtomic('7', 0), '7');
    for (const [atomic, scale] of [['1250', 6], ['1', 11], ['99999999999999999999', 6], ['100', 2], ['25000', 11]] as const) {
      const decimal = x402DecimalOfAtomic(atomic, scale);
      const [whole, fraction = ''] = decimal.split('.');
      assert.equal(BigInt(`${whole ?? ''}${fraction.padEnd(scale, '0')}`).toString(), atomic, `${atomic} @ ${String(scale)}`);
    }
    const answer = interpret([requirement({ amount: '1250' })]);
    assert.ok(answer.interpreted);
    assert.equal(answer.terms.amount.value, '0.00125');
  });

  it('AMT-2 … AMT-7 zero, sign, leading zeros, exponent, decimal point, overflow: refused before interpretation', () => {
    for (const amount of ['0', '-5', '+5', '007', '1e3', '1.5', '12,50', ' 1', '1'.padEnd(41, '0'), '', '١٢']) {
      assert.equal(refusalOf(interpret([requirement({ amount })])), 'challenge-invalid', JSON.stringify(amount));
    }
  });

  it('AMT-7 a value P9 cannot hold under the unit is refused, never rounded', () => {
    // 40 digits at scale 6 is far beyond any P9 magnitude bound for the asset — the ingress reader refuses it.
    const adapter = adapterWith();
    const raw = adapter.interpret(carrierOf(paymentRequired([requirement({ amount: '9'.repeat(40) })])), CONTEXT);
    const read = readPaymentProtocolInterpretation(raw, { assets: ASSETS });
    assert.ok(read === undefined || !read.interpreted || read.terms.amount.value === `${'9'.repeat(34)}.${'9'.repeat(6)}`, 'exact or refused — never rounded');
  });

  it('AMT-8 / AMT-9 an unmapped asset is unsupported: no scale is guessed from `extra.name`, `extra.decimals` or the asset text', () => {
    assert.equal(refusalOf(interpret([requirement({ asset: 'USDC', extra: { instrument: 'i', name: 'USDC', decimals: 6, version: '2' } })])), 'challenge-unsupported');
    assert.equal(refusalOf(interpret([requirement({ asset: 'TOKB' })])), 'challenge-unsupported', 'a mapping exists for TOK on this network, not TOKB');
  });

  it('the scale is the mapping’s, never `extra`’s: the same atomic amount under another network’s mapping is another value', () => {
    const a = interpret([requirement({ network: NET_A })]);
    const b = interpret([requirement({ network: NET_B })]);
    assert.ok(a.interpreted && b.interpreted);
    assert.deepEqual(a.terms.amount, { value: '0.00125', unit: UNIT_A });
    assert.deepEqual(b.terms.amount, { value: '12.5', unit: 'test:TOKB' });
  });
});

describe('PAY-08 — payment flows', () => {
  it('PR-18 / SEL-8 an unknown flow is never constructed; escrow and a flow the mapping does not enable are skipped', () => {
    assert.equal(refusalOf(interpret([requirement({ extra: { instrument: 'i', paymentFlow: 'stream' } })])), 'challenge-unsupported');
    assert.equal(refusalOf(interpret([requirement({ extra: { instrument: 'i', paymentFlow: 'escrow' } })])), 'challenge-unsupported');
    assert.equal(refusalOf(interpret([requirement({ network: NET_B, extra: { instrument: 'i', paymentFlow: 'upfront' } })])), 'challenge-unsupported', 'mapping B enables authorization only');
    const upfront = interpret([requirement({ extra: { instrument: 'i', paymentFlow: 'upfront' } })]);
    assert.ok(upfront.interpreted);
    assert.equal(upfront.challenge.fields['payment-flow'], 'upfront');
  });

  it('SEL-8 an unsupported-flow offer listed first is skipped for a supported one', () => {
    assert.equal(chosen(interpret([requirement({ extra: { instrument: 'esc', paymentFlow: 'escrow' } }), requirement({ extra: { instrument: 'ok' } })])), `x402:2:${NET_A}:ok`);
  });

  it('X17 a merchant timeout above the trusted maximum is not used', () => {
    assert.equal(refusalOf(interpret([requirement({ maxTimeoutSeconds: 301 })])), 'challenge-unsupported');
    assert.ok(interpret([requirement({ maxTimeoutSeconds: 300 })]).interpreted);
    assert.equal(refusalOf(interpret([requirement({ network: NET_B, maxTimeoutSeconds: 121 })])), 'challenge-unsupported');
  });

  it('PR-16 / SEL-7 an unknown scheme is skipped, or refused when nothing else is offered', () => {
    assert.equal(refusalOf(interpret([requirement({ scheme: 'upto' })])), 'challenge-unsupported');
    assert.equal(chosen(interpret([requirement({ scheme: 'upto', extra: { instrument: 'up' } }), requirement({ extra: { instrument: 'ex' } })])), `x402:2:${NET_A}:ex`);
  });

  it('PR-17 an unsupported network is not executable — parsing is not support', () => {
    assert.equal(refusalOf(interpret([requirement({ network: 'eip155:8453' })])), 'challenge-unsupported');
    assert.equal(refusalOf(interpret([requirement({ network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' })])), 'challenge-unsupported');
  });
});

describe('PAY-08 — requirement selection (SEL)', () => {
  it('SEL-1 one supported candidate', () => {
    assert.equal(chosen(interpret([requirement()])), `x402:2:${NET_A}:inv-1`);
  });

  it('SEL-2 / X3 the supported candidate need not be first: the attacker’s first offer is never taken by position', () => {
    const attacker = requirement({ network: 'eip155:8453', payTo: '0xattacker', asset: '0xUSDC', extra: { instrument: 'evil' } });
    assert.equal(chosen(interpret([attacker, requirement()])), `x402:2:${NET_A}:inv-1`);
    const unknownPayee = requirement({ payTo: 'attacker', extra: { instrument: 'evil' } });
    assert.equal(chosen(interpret([unknownPayee, requirement()])), `x402:2:${NET_A}:inv-1`, 'an unresolvable payee first is skipped');
  });

  it('SEL-3 no supported candidate: a fixed refusal precedence the merchant’s order cannot choose', () => {
    const expired = requirement({ extra: { instrument: 'e', expired: true } });
    const mismatch = requirement({ extra: { instrument: 'm', bind: 'mismatch' } });
    const unknown = requirement({ payTo: 'nobody', extra: { instrument: 'u' } });
    for (const order of [[expired, mismatch, unknown], [unknown, expired, mismatch], [mismatch, unknown, expired]]) assert.equal(refusalOf(interpret(order)), 'request-binding-mismatch');
    for (const order of [[expired, unknown], [unknown, expired]]) assert.equal(refusalOf(interpret(order)), 'challenge-expired');
    assert.equal(refusalOf(interpret([requirement({ scheme: 'upto' }), unknown])), 'counterparty-unresolved');
  });

  it('SEL-4 two candidates under different mappings: trusted priority decides, deterministically', () => {
    const a = requirement({ network: NET_A, extra: { instrument: 'a' } });
    const b = requirement({ network: NET_B, extra: { instrument: 'b' } });
    assert.equal(chosen(interpret([b, a])), `x402:2:${NET_A}:a`);
    assert.equal(chosen(interpret([a, b])), `x402:2:${NET_A}:a`);
  });

  it('SEL-4 two different candidates under the same mapping are ambiguous: refused, never first-wins', () => {
    assert.equal(refusalOf(interpret([requirement({ extra: { instrument: 'x' } }), requirement({ extra: { instrument: 'y' } })])), 'challenge-ambiguous');
    assert.equal(refusalOf(interpret([requirement({ amount: '1250' }), requirement({ amount: '1300' })])), 'challenge-ambiguous', 'X3: conflicting duplicates of one instrument');
  });

  it('SEL-5 / SEL-6 same network with an unsupported asset; same asset on an unsupported network', () => {
    assert.equal(chosen(interpret([requirement({ asset: 'TOKB', extra: { instrument: 'b' } }), requirement({ extra: { instrument: 'ok' } })])), `x402:2:${NET_A}:ok`);
    assert.equal(chosen(interpret([requirement({ network: 'test:net-c', extra: { instrument: 'c' } }), requirement({ extra: { instrument: 'ok' } })])), `x402:2:${NET_A}:ok`);
  });

  it('SEL-9 / CAN-2 every permutation of the merchant’s offers selects the same requirement with the same evidence', () => {
    const offers = [requirement({ network: NET_B, extra: { instrument: 'b' } }), requirement({ scheme: 'upto', extra: { instrument: 'u' } }), requirement({ extra: { instrument: 'a' } }), requirement({ network: 'eip155:1', extra: { instrument: 'e' } })];
    const permutations = (items: readonly unknown[]): unknown[][] => (items.length <= 1 ? [[...items]] : items.flatMap((item, index) => permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [item, ...rest])));
    const answers = new Set(permutations(offers).map((order) => JSON.stringify(interpret(order))));
    assert.equal(answers.size, 1);
  });

  it('SEL-10 changing the trusted mapping changes the choice — explicitly, by configuration', () => {
    const a = requirement({ network: NET_A, extra: { instrument: 'a' } });
    const b = requirement({ network: NET_B, extra: { instrument: 'b' } });
    assert.equal(chosen(interpret([a, b], { mappings: [MAPPING_A, MAPPING_B] })), `x402:2:${NET_A}:a`);
    assert.equal(chosen(interpret([a, b], { mappings: [MAPPING_B, MAPPING_A] })), `x402:2:${NET_B}:b`);
    assert.equal(chosen(interpret([a, b], { mappings: [MAPPING_B] })), `x402:2:${NET_B}:b`);
  });

  it('identical duplicates — however spelled — are one offer', () => {
    const one = requirement();
    const sameReordered = { extra: { instrument: 'inv-1' }, payTo: 'merchant-a', maxTimeoutSeconds: 60, asset: 'TOK', amount: '1250', network: NET_A, scheme: 'exact' };
    assert.equal(chosen(interpret([one, sameReordered, one])), `x402:2:${NET_A}:inv-1`);
  });
});

describe('PAY-08 — canonicalization (CAN)', () => {
  const evidence = (accepts: readonly unknown[], overrides?: Record<string, unknown>) => {
    const answer = interpret(accepts, overrides !== undefined ? { overrides } : {});
    assert.ok(answer.interpreted, refusalOf(answer));
    return JSON.stringify({ key: answer.challenge.key, fields: answer.challenge.fields, terms: answer.terms });
  };

  it('CAN-5 / CAN-6 display description, service name, tags and their order are not material', () => {
    const base = evidence([requirement()]);
    assert.equal(evidence([requirement()], { resource: { url: RESOURCE_URL, description: 'other words', tags: ['finance', 'reports'], serviceName: 'Other' } }), base);
    assert.equal(evidence([requirement()], { resource: { url: RESOURCE_URL } }), base);
    assert.equal(evidence([requirement()], { error: 'something else' }), base, 'the merchant error is not material');
  });

  it('CAN-7 / CAN-8 / CAN-9 amount, payTo and resource are material', () => {
    const base = evidence([requirement()]);
    assert.notEqual(evidence([requirement({ amount: '1251' })]), base);
    assert.notEqual(evidence([requirement({ payTo: 'merchant-b' })]), base);
    assert.equal(refusalOf(interpret([requirement()], { overrides: { resource: { url: `${RESOURCE_URL}&x=1` } } })), 'request-binding-mismatch', 'another resource does not even bind');
  });

  it('CAN-7 / CAN-8 the requirement identity itself carries amount and payTo: offers differing only there are two requirements — ambiguous, never collapsed into the first', () => {
    for (const order of [[requirement(), requirement({ payTo: 'merchant-b' })], [requirement({ payTo: 'merchant-b' }), requirement()]]) assert.equal(refusalOf(interpret(order)), 'challenge-ambiguous');
    for (const order of [[requirement(), requirement({ amount: '1251' })], [requirement({ amount: '1251' }), requirement()]]) assert.equal(refusalOf(interpret(order)), 'challenge-ambiguous');
  });

  it('CAN-10 an extension change changes the challenge evidence (never the business terms)', () => {
    const ext = (category: string) => ({ bazaar: { info: { category }, schema: { type: 'object' } } });
    const a = interpret([requirement()], { overrides: { extensions: ext('reports') } });
    const b = interpret([requirement()], { overrides: { extensions: ext('free') } });
    assert.ok(a.interpreted && b.interpreted);
    assert.notEqual(a.challenge.fields['extensions'], b.challenge.fields['extensions']);
    assert.deepEqual(a.terms, b.terms);
    assert.equal(a.challenge.key, b.challenge.key);
  });

  it('`extra` is opaque to the generic adapter but part of the requirement: a changed member changes the evidence', () => {
    assert.notEqual(evidence([requirement({ extra: { instrument: 'inv-1', memo: 'a' } })]), evidence([requirement({ extra: { instrument: 'inv-1', memo: 'b' } })]));
  });
});

describe('PAY-08 — preparation', () => {
  it('prepares mapped, flow-supported candidates only, and never throws', async () => {
    const log: BindingLog = { interpreted: [], prepared: [] };
    const adapter = adapterWith({ log });
    await adapter.prepare(carrierOf(paymentRequired([requirement({ payTo: 'merchant-a' }), requirement({ network: 'eip155:1', payTo: 'evm' }), requirement({ payTo: 'esc', extra: { instrument: 'e', paymentFlow: 'escrow' } })])));
    assert.deepEqual(log.prepared, ['merchant-a']);
    await adapter.prepare(undefined);
    await adapter.prepare({ status: 402, headers: [['PAYMENT-REQUIRED', '!!!']] });
    assert.equal(log.interpreted.length, 0, 'preparation interprets nothing');
  });

  it('a target resolved for a resource the adapter was not told about fails closed', () => {
    assert.equal(refusalOf(interpret([requirement()], { context: contextFor({ target: TARGET.replace('42', '43') }) })), 'request-binding-mismatch');
  });
});
