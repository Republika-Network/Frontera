import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  PAYMENT_REFUND_REFUSALS,
  PAYMENT_SETTLEMENT_STATES,
  isLegalPaymentSettlementTransition,
  isPaymentFinalityInstant,
  isTerminalPaymentSettlementState,
  normalizePaymentFinalityAnswer,
  paymentFinalityMismatch,
  paymentRefundCounted,
  paymentRefundRefusal,
  paymentRefundRemaining,
  type PaymentFinalityQuery,
  type PaymentSettlementState,
} from '../index.js';

/**
 * PAY-05 — the rail-neutral settlement contract: the closed state machine, the
 * closed and bounded finality answer, exact matching, and the refund money
 * rules. Pure; no store, no clock, no rail.
 */

const QUERY: PaymentFinalityQuery = Object.freeze({
  organizationId: 'org-a',
  executionId: 'exec-1',
  requestId: 'req-1',
  decisionId: 'dec-1',
  basis: 'provider-confirmed-completed',
  providerRef: 'handle-1',
  payment: Object.freeze({
    source: { accountId: 'treasury' },
    destination: { kind: 'account', reference: 'vendor-1' },
    amount: { value: '10.5', unit: 'USD' },
    purpose: 'vendor-payment',
  }),
});

function evidence(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    executionId: 'exec-1',
    method: 'acme.final-proof.v1',
    providerRef: 'handle-1',
    amount: { value: '10.5', unit: 'USD' },
    source: { accountId: 'treasury' },
    destination: { kind: 'account', reference: 'vendor-1' },
    finalizedAt: '2026-10-12T09:30:00Z',
    facts: [{ name: 'acme.depth', value: '6' }],
    ...overrides,
  };
}

describe('PAY-05 settlement state machine — closed, conservative, settled is terminal', () => {
  it('the vocabulary is exactly four states', () => {
    assert.deepEqual([...PAYMENT_SETTLEMENT_STATES], ['execution-uncertain', 'awaiting-finality', 'settled', 'not-settleable']);
  });

  it('only the documented transitions are legal; settled and not-settleable are terminal', () => {
    const legal: [PaymentSettlementState, PaymentSettlementState][] = [];
    for (const from of PAYMENT_SETTLEMENT_STATES) for (const to of PAYMENT_SETTLEMENT_STATES) if (isLegalPaymentSettlementTransition(from, to)) legal.push([from, to]);
    assert.deepEqual(legal, [
      ['execution-uncertain', 'awaiting-finality'],
      ['execution-uncertain', 'not-settleable'],
      ['awaiting-finality', 'settled'],
    ]);
    for (const to of PAYMENT_SETTLEMENT_STATES) {
      assert.equal(isLegalPaymentSettlementTransition('settled', to), false, `settled → ${to}`);
      assert.equal(isLegalPaymentSettlementTransition('not-settleable', to), false, `not-settleable → ${to}`);
    }
    assert.equal(isTerminalPaymentSettlementState('settled'), true);
    assert.equal(isTerminalPaymentSettlementState('awaiting-finality'), false);
    assert.equal(isLegalPaymentSettlementTransition('awaiting-finality', 'not-settleable'), false, 'a missing finality is never a negative');
  });
});

describe('PAY-05 finality answers — closed, bounded, never repaired', () => {
  it('reads the three closed answers into fresh frozen values', () => {
    const final = normalizePaymentFinalityAnswer({ outcome: 'final', evidence: evidence() });
    assert.equal(final?.outcome, 'final');
    assert.equal(Object.isFrozen(final), true);
    assert.deepEqual(normalizePaymentFinalityAnswer({ outcome: 'not-final' }), { outcome: 'not-final' });
    assert.deepEqual(normalizePaymentFinalityAnswer({ outcome: 'contradicted', reason: 'acme.reverted' }), { outcome: 'contradicted', reason: 'acme.reverted' });
  });

  it('sorts facts by name; a duplicate fact is refused', () => {
    const final = normalizePaymentFinalityAnswer({ outcome: 'final', evidence: evidence({ facts: [{ name: 'b.x', value: '2' }, { name: 'a.x', value: '1' }] }) });
    assert.deepEqual(final?.outcome === 'final' && final.evidence.facts.map((fact) => fact.name), ['a.x', 'b.x']);
    assert.equal(normalizePaymentFinalityAnswer({ outcome: 'final', evidence: evidence({ facts: [{ name: 'a.x', value: '1' }, { name: 'a.x', value: '1' }] }) }), undefined);
  });

  const refused: readonly [string, unknown][] = [
    ['an unknown outcome', { outcome: 'settled' }],
    ['a final answer without evidence', { outcome: 'final' }],
    ['not-final with extra keys', { outcome: 'not-final', reason: 'x' }],
    ['a contradicted answer with a free-text reason', { outcome: 'contradicted', reason: 'The provider said no.' }],
    ['an undeclared evidence key (a raw body)', { outcome: 'final', evidence: evidence({ body: '{"status":"ok"}' }) }],
    ['a numeric amount', { outcome: 'final', evidence: evidence({ amount: { value: 10.5, unit: 'USD' } }) }],
    ['a non-canonical amount', { outcome: 'final', evidence: evidence({ amount: { value: '10.50', unit: 'USD' } }) }],
    ['a credential-shaped provider handle', { outcome: 'final', evidence: evidence({ providerRef: 'Bearer abcdefghijklmnop' }) }],
    ['a URL provider handle', { outcome: 'final', evidence: evidence({ providerRef: 'https://provider/tx/1' }) }],
    ['a local-time instant', { outcome: 'final', evidence: evidence({ finalizedAt: '2026-10-12T09:30:00+02:00' }) }],
    ['a secret-named fact', { outcome: 'final', evidence: evidence({ facts: [{ name: 'acme.private-key', value: 'abc' }] }) }],
    ['a seed-named fact', { outcome: 'final', evidence: evidence({ facts: [{ name: 'acme.seed', value: 'abc' }] }) }],
    ['a JWT fact', { outcome: 'final', evidence: evidence({ facts: [{ name: 'acme.id', value: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig' }] }) }],
    ['a PEM fact', { outcome: 'final', evidence: evidence({ facts: [{ name: 'acme.cert', value: '-----BEGIN PRIVATE KEY-----' }] }) }],
    ['a whitespace fact (a phrase)', { outcome: 'final', evidence: evidence({ facts: [{ name: 'acme.words', value: 'abandon ability able about' }] }) }],
    ['an oversized fact', { outcome: 'final', evidence: evidence({ facts: [{ name: 'acme.blob', value: 'a'.repeat(257) }] }) }],
    ['too many facts', { outcome: 'final', evidence: evidence({ facts: Array.from({ length: 17 }, (_, index) => ({ name: `acme.f${String(index).padStart(2, '0')}`, value: '1' })) }) }],
    ['a sparse fact list', { outcome: 'final', evidence: evidence({ facts: [, { name: 'a.x', value: '1' }] }) }],
    ['a getter', { outcome: 'final', get evidence() { return evidence(); } }],
    ['a class instance', new (class { outcome = 'not-final'; })()],
    ['a string', 'final'],
  ];
  for (const [label, raw] of refused) {
    it(`refuses ${label}`, () => {
      assert.equal(normalizePaymentFinalityAnswer(raw), undefined);
    });
  }

  it('refuses a Proxy without consulting its traps', () => {
    let trapped = false;
    const proxy = new Proxy({ outcome: 'not-final' }, { get: () => ((trapped = true), 'final') });
    const answer = normalizePaymentFinalityAnswer(proxy);
    assert.equal(trapped, false);
    assert.deepEqual(answer, { outcome: 'not-final' });
  });
});

describe('PAY-05 exact matching — no fuzzy matching, no "same amount, same payment"', () => {
  const read = (overrides: Record<string, unknown> = {}) => {
    const answer = normalizePaymentFinalityAnswer({ outcome: 'final', evidence: evidence(overrides) });
    assert.equal(answer?.outcome, 'final');
    return answer!.outcome === 'final' ? answer!.evidence : (undefined as never);
  };

  it('identical evidence matches', () => assert.equal(paymentFinalityMismatch(read(), QUERY), undefined));
  for (const [label, overrides, field] of [
    ['another execution', { executionId: 'exec-2' }, 'execution'],
    ['another handle', { providerRef: 'handle-2' }, 'provider-reference'],
    ['another amount', { amount: { value: '10.51', unit: 'USD' } }, 'amount'],
    ['another asset, same amount', { amount: { value: '10.5', unit: 'EUR' } }, 'asset'],
    ['another source', { source: { accountId: 'other' } }, 'source'],
    ['another destination', { destination: { kind: 'account', reference: 'vendor-2' } }, 'destination'],
    ['another destination kind', { destination: { kind: 'beneficiary', reference: 'vendor-1' } }, 'destination'],
  ] as const) {
    it(`${label} is a ${field} mismatch`, () => assert.equal(paymentFinalityMismatch(read(overrides), QUERY), field));
  }

  it('when P11 / P12 recorded no handle, the evidence names its own', () => {
    const { providerRef: _none, ...withoutHandle } = QUERY;
    assert.equal(paymentFinalityMismatch(read({ providerRef: 'any' }), withoutHandle as PaymentFinalityQuery), undefined);
  });
});

describe('PAY-05 refund money rules — exact P9, same asset, never negative, never over the original', () => {
  const original = { value: '100', unit: 'USD' } as const;

  it('partial refunds within the balance fit; the third over the limit is refused', () => {
    assert.equal(paymentRefundRefusal(original, '0', { value: '30', unit: 'USD' }), undefined);
    assert.equal(paymentRefundRefusal(original, '30', { value: '70', unit: 'USD' }), undefined);
    assert.equal(paymentRefundRefusal(original, '100', { value: '0.01', unit: 'USD' }), PAYMENT_REFUND_REFUSALS.PAYMENT_REFUND_EXCEEDS_REFUNDABLE);
    assert.equal(paymentRefundRefusal(original, '30', { value: '70.01', unit: 'USD' }), PAYMENT_REFUND_REFUSALS.PAYMENT_REFUND_EXCEEDS_REFUNDABLE);
  });

  it('exactness: 0.1 + 0.2 refunds of 0.3 fit exactly; no float drift', () => {
    const exact = { value: '0.3', unit: 'USD' };
    assert.equal(paymentRefundRefusal(exact, '0.1', { value: '0.2', unit: 'USD' }), undefined);
    assert.equal(paymentRefundRemaining(exact, paymentRefundCounted(['0.1', '0.2'])).value, '0');
  });

  it('another asset is refused, never converted', () => {
    assert.equal(paymentRefundRefusal(original, '0', { value: '1', unit: 'EUR' }), PAYMENT_REFUND_REFUSALS.PAYMENT_REFUND_ASSET_MISMATCH);
  });

  it('zero, negative, numeric and non-canonical amounts are refused', () => {
    for (const amount of [{ value: '0', unit: 'USD' }, { value: '-1', unit: 'USD' }, { value: 1, unit: 'USD' }, { value: '1.0', unit: 'USD' }, { value: '1e2', unit: 'USD' }, undefined]) {
      assert.equal(paymentRefundRefusal(original, '0', amount), PAYMENT_REFUND_REFUSALS.PAYMENT_REFUND_AMOUNT_INVALID, JSON.stringify(amount));
    }
  });

  it('remaining is exact and an accounting above the original throws', () => {
    assert.deepEqual(paymentRefundRemaining(original, '30'), { value: '70', unit: 'USD' });
    assert.throws(() => paymentRefundRemaining(original, '100.01'), RangeError);
  });
});

describe('PAY-05 hardening TIME-1 – TIME-9 — a finality instant is a real UTC instant, not just its shape', () => {
  for (const [label, value, valid] of [
    ['TIME-1: an ordinary date', '2026-02-28T09:30:00Z', true],
    ['TIME-2: a leap day in a leap year', '2028-02-29T09:30:00Z', true],
    ['TIME-3: a leap day in a common year', '2026-02-29T09:30:00Z', false],
    ['TIME-4: February 31', '2026-02-31T09:30:00Z', false],
    ['TIME-5: April 31', '2026-04-31T09:30:00Z', false],
    ['TIME-6: the last second of the year', '2026-12-31T23:59:59Z', true],
    ['TIME-7: the canonical millisecond form', '2026-10-12T09:30:00.123Z', true],
    ['TIME-7: the canonical millisecond form, zero milliseconds', '2026-10-12T09:30:00.000Z', true],
    ['TIME-8: one fractional digit', '2026-10-12T09:30:00.1Z', false],
    ['TIME-8: two fractional digits', '2026-10-12T09:30:00.12Z', false],
    ['TIME-8: four fractional digits', '2026-10-12T09:30:00.1234Z', false],
    ['TIME-9: an explicit +00:00 offset instead of Z', '2026-10-12T09:30:00+00:00', false],
    ['a century year that is not a leap year', '2100-02-29T00:00:00Z', false],
    ['a 400-year leap year', '2000-02-29T00:00:00Z', true],
    ['November 31', '2026-11-31T00:00:00Z', false],
    ['hour 24 (a rollover spelling of midnight)', '2026-10-12T24:00:00Z', false],
    ['a leap second (never printed by a UTC clock)', '2026-12-31T23:59:60Z', false],
    ['lowercase z', '2026-10-12T09:30:00z', false],
    ['a date only', '2026-10-12', false],
  ] as const) {
    it(`${label}: ${value} → ${valid ? 'valid' : 'invalid'}`, () => {
      assert.equal(isPaymentFinalityInstant(value), valid);
      // And as evidence: an impossible instant never becomes a final answer.
      assert.equal(normalizePaymentFinalityAnswer({ outcome: 'final', evidence: evidence({ finalizedAt: value }) }) !== undefined, valid);
    });
  }
});
