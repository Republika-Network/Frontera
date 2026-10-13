import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  compareRationals,
  deviationBasisPoints,
  formatTradeRational,
  multiplyRationals,
  parseRiskPrice,
  rationalOfDecimal,
  rationalOfQuantity,
  summarizeTradeOrderInventory,
  tradeExactQuantity,
} from '../index.js';
import { RLUSD, ISSUER, ISSUER_B, buy, controlOf, evidenceOf, market, profileData, sell } from './trade-risk-fixture.js';

/**
 * TRADE-03 matrices 4–7: owner-given and base-quantity maximums, exact
 * rational limit prices, reference deviation and notional — all BigInt
 * rationals, decided exactly at every boundary (SEC-TRADE03-01/02/10).
 *
 * Fixture pair RLUSD/XRP, prices in XRP per RLUSD: sell floor 19/10, buy
 * ceiling 21/10, band 1…3, reference 2, deviation ≤ 300 bps symmetric,
 * notional ≤ 2000 XRP, base ≤ 1000 RLUSD, owner gives ≤ 1000 RLUSD (sell)
 * or ≤ 2500 XRP (buy).
 */

const r = (numerator: bigint, denominator: bigint) => ({ numerator, denominator });

describe('Exact rational primitives', () => {
  it('compares by cross-multiplication: unequal denominators, equivalent spellings, tiny and huge values', () => {
    assert.equal(compareRationals(r(1n, 3n), r(333_333n, 1_000_000n)), 1);
    assert.equal(compareRationals(r(2n, 4n), r(1n, 2n)), 0);
    assert.equal(compareRationals(rationalOfDecimal('0.30000000000000001'), rationalOfDecimal('0.3')), 1, 'a float would call them equal');
    assert.equal(compareRationals(rationalOfDecimal('0.1'), r(1n, 10n)), 0);
    const huge = r(10n ** 96n, 1n);
    const tiny = r(1n, 10n ** 96n);
    assert.equal(compareRationals(multiplyRationals(huge, tiny), r(1n, 1n)), 0, 'no overflow, no underflow');
    assert.equal(formatTradeRational(multiplyRationals(r(10n ** 200n + 1n, 3n), r(3n, 1n))), `${(10n ** 200n + 1n).toString()}/1`);
  });

  it('a price spelled two ways is one price; a zero denominator, zero or negative value, or a number is refused', () => {
    assert.deepEqual(parseRiskPrice({ numerator: '38', denominator: '20' }), r(19n, 10n));
    for (const raw of [{ numerator: '1', denominator: '0' }, { numerator: '0', denominator: '1' }, { numerator: '-2', denominator: '1' }, { numerator: 2, denominator: 1 }, { numerator: '2', denominator: '1.0' }]) {
      assert.equal(parseRiskPrice(raw), undefined, JSON.stringify(raw));
    }
  });

  it('deviation is |limit − reference| / reference in basis points, exactly: 0.51 vs 0.50 is exactly 200 bps', () => {
    assert.deepEqual(deviationBasisPoints(r(51n, 100n), r(50n, 100n)), r(200n, 1n));
    assert.deepEqual(deviationBasisPoints(r(49n, 100n), r(1n, 2n)), r(200n, 1n));
    assert.deepEqual(deviationBasisPoints(r(1n, 3n), r(1n, 3n)), r(0n, 1n));
    assert.deepEqual(deviationBasisPoints(r(2n, 3n), r(1n, 2n)), r(10_000n, 3n), '33.33… % is kept as 10000/3 bps, never rounded');
    assert.throws(() => deviationBasisPoints(r(1n, 1n), r(0n, 1n)), RangeError);
  });

  it('a quantity is coefficient / 10^scale, exactly — drops at scale 6', () => {
    assert.deepEqual(rationalOfQuantity(tradeExactQuantity({ currency: 'XRP', drops: '1' })), r(1n, 1_000_000n));
    assert.deepEqual(rationalOfQuantity(tradeExactQuantity({ currency: RLUSD, issuer: ISSUER, value: '0.000000000000001' })), r(1n, 10n ** 15n));
  });
});

describe('Matrix 4 — owner-given amount and base quantity maximums', () => {
  it('below, equal to and above the base-quantity maximum (1000 RLUSD)', () => {
    assert.equal(controlOf(evidenceOf({ proposal: sell('999.999999999999', '2000000000') }), 'BASE_QUANTITY_MAXIMUM').outcome, 'SATISFIED');
    assert.equal(controlOf(evidenceOf({ proposal: sell('1000', '2000000000') }), 'BASE_QUANTITY_MAXIMUM').outcome, 'SATISFIED', 'equal is within');
    assert.equal(controlOf(evidenceOf({ proposal: sell('1000.000000000001', '2000000000') }), 'BASE_QUANTITY_MAXIMUM').outcome, 'VIOLATED', 'a 10⁻¹² over is over');
  });

  it('the owner-given ceiling is per side, in the given asset: a buy is held to 2500 XRP, at the drop boundary', () => {
    assert.equal(controlOf(evidenceOf({ proposal: buy('2500000000', '1200') }), 'OWNER_GIVEN_AMOUNT_MAXIMUM').outcome, 'SATISFIED');
    assert.equal(controlOf(evidenceOf({ proposal: buy('2500000001', '1200') }), 'OWNER_GIVEN_AMOUNT_MAXIMUM').outcome, 'VIOLATED', 'one drop over');
  });

  it('owner-given, base quantity, notional and exposure are four different limits, each checked in its own unit', () => {
    // Buy 600 RLUSD for 1200 XRP: owner gives 1200 XRP (≤ 2500), base 600 (≤ 1000), notional 1200 XRP (≤ 2000).
    const ok = evidenceOf({ proposal: buy('1200000000', '600') });
    for (const control of ['OWNER_GIVEN_AMOUNT_MAXIMUM', 'BASE_QUANTITY_MAXIMUM', 'NOTIONAL_MAXIMUM']) assert.equal(controlOf(ok, control).outcome, 'SATISFIED', control);
    // Buy 1100 RLUSD for 2200 XRP: owner gives 2200 XRP (≤ 2500) but base 1100 > 1000 and notional 2200 > 2000.
    const over = evidenceOf({ proposal: buy('2200000000', '1100') });
    assert.equal(controlOf(over, 'OWNER_GIVEN_AMOUNT_MAXIMUM').outcome, 'SATISFIED');
    assert.equal(controlOf(over, 'BASE_QUANTITY_MAXIMUM').outcome, 'VIOLATED');
    assert.equal(controlOf(over, 'NOTIONAL_MAXIMUM').outcome, 'VIOLATED');
  });

  it('the same quantity of a different asset, or the same code from another issuer, is not this pair at all', () => {
    const otherIssuer = evidenceOf({ proposal: sell('100', '200000000', { takerGets: { currency: RLUSD, issuer: ISSUER_B, value: '100' } }) });
    assert.deepEqual(controlOf(otherIssuer, 'PAIR_APPROVED'), { outcome: 'VIOLATED', reason: 'ISSUER_NOT_APPROVED' });
    assert.equal(controlOf(otherIssuer, 'OWNER_GIVEN_AMOUNT_MAXIMUM').outcome, 'UNAVAILABLE', 'no limit of another asset is ever applied');
    assert.equal(otherIssuer.outcome, 'VIOLATED');
  });
});

describe('Matrix 5 — exact limit price: a sell states a floor, a buy a ceiling (SEC-TRADE03-02)', () => {
  const sellPrice = (xrpDrops: string) => controlOf(evidenceOf({ proposal: sell('100', xrpDrops) }), 'LIMIT_PRICE_BOUND');
  const buyPrice = (xrpDrops: string) => controlOf(evidenceOf({ proposal: buy(xrpDrops, '100') }), 'LIMIT_PRICE_BOUND');

  it('(1–3) sell above, exactly at, and below the minimum 19/10', () => {
    assert.equal(sellPrice('195000000').outcome, 'SATISFIED');
    assert.equal(sellPrice('190000000').outcome, 'SATISFIED', 'exactly 1.9 is acceptable');
    assert.deepEqual(sellPrice('189999999'), { outcome: 'VIOLATED', reason: 'SELL_BELOW_MINIMUM' }, 'one drop under 1.9 is under');
  });

  it('(4–6) buy below, exactly at, and above the maximum 21/10', () => {
    assert.equal(buyPrice('205000000').outcome, 'SATISFIED');
    assert.equal(buyPrice('210000000').outcome, 'SATISFIED', 'exactly 2.1 is acceptable');
    assert.deepEqual(buyPrice('210000001'), { outcome: 'VIOLATED', reason: 'BUY_ABOVE_MAXIMUM' });
  });

  it('(14) the side decides the meaning: the same 2.2 is a fine sell and a violating buy', () => {
    assert.equal(sellPrice('220000000').outcome, 'SATISFIED');
    assert.equal(buyPrice('220000000').outcome, 'VIOLATED');
  });

  it('(7, 8, 9, 15) very small and very large rational prices, unequal denominators, no overflow', () => {
    const profile = profileData({}, { minSellPrice: { numerator: '1', denominator: '1' + '0'.repeat(80) }, priceBand: { mode: 'disabled', reason: 'test' }, referenceDeviation: { mode: 'disabled', reason: 'test' }, approval: { restricted: false, notionalAbove: '1500' } });
    // Selling 1000 RLUSD for one drop is 10⁻⁹ XRP per RLUSD — tiny, exact, and still above a 10⁻⁸⁰ floor.
    const verySmall = evidenceOf({ profile, proposal: sell('1000', '1') });
    assert.equal(controlOf(verySmall, 'LIMIT_PRICE_BOUND').outcome, 'SATISFIED');
    const large = profileData({}, { maxBuyPrice: { numerator: '9'.repeat(200), denominator: '7' } });
    assert.equal(controlOf(evidenceOf({ profile: large, proposal: buy('200000000', '100') }), 'LIMIT_PRICE_BOUND').outcome, 'SATISFIED');
  });

  it('(16, 17) canonically equivalent bounds behave identically; no rounding can carry a price across its bound', () => {
    const spelled = profileData({}, { minSellPrice: { numerator: '190000000000', denominator: '100000000000' } });
    assert.equal(controlOf(evidenceOf({ profile: spelled, proposal: sell('100', '190000000') }), 'LIMIT_PRICE_BOUND').outcome, 'SATISFIED');
    assert.equal(controlOf(evidenceOf({ profile: spelled, proposal: sell('100', '189999999') }), 'LIMIT_PRICE_BOUND').outcome, 'VIOLATED');
    // 1/3-style prices: 3 RLUSD for 5.7 XRP is exactly 1.9; 3 RLUSD for 5.699999 XRP is 1.899999666…, never "1.9".
    assert.equal(controlOf(evidenceOf({ proposal: sell('3', '5700000') }), 'LIMIT_PRICE_BOUND').outcome, 'SATISFIED');
    assert.equal(controlOf(evidenceOf({ proposal: sell('3', '5699999') }), 'LIMIT_PRICE_BOUND').outcome, 'VIOLATED');
  });

  it('(10, 11) an invalid or non-positive bound never configures; the absolute band applies to both sides', () => {
    assert.equal(controlOf(evidenceOf({ proposal: sell('100', '310000000') }), 'PRICE_BAND').reason, 'PRICE_ABOVE_CEILING');
    assert.equal(controlOf(evidenceOf({ proposal: buy('99000000', '100') }), 'PRICE_BAND').reason, 'PRICE_BELOW_FLOOR');
    assert.equal(controlOf(evidenceOf({ proposal: sell('100', '300000000') }), 'PRICE_BAND').outcome, 'SATISFIED', 'exactly at the ceiling');
  });
});

describe('Matrix 6 — deviation from the trusted reference (reference 2 XRP/RLUSD, max 300 bps)', () => {
  const at = (side: 'buy' | 'sell', xrpDrops: string, rule: 'symmetric' | 'adverse' = 'symmetric', maxBasisPoints = 300) => {
    const profile = profileData({}, { referenceDeviation: { mode: 'enforce', maxBasisPoints, rule }, priceBand: { mode: 'disabled', reason: 'test' }, approval: { restricted: false } });
    const proposal = side === 'sell' ? sell('100', xrpDrops) : buy(xrpDrops, '100');
    return controlOf(evidenceOf({ profile, proposal }), 'REFERENCE_DEVIATION');
  };

  it('2.06 is exactly 300 bps (within), 2.06000001 is over; equality at the threshold is deterministic', () => {
    assert.equal(at('sell', '206000000').outcome, 'SATISFIED');
    assert.equal(at('sell', '206000001').outcome, 'VIOLATED');
  });

  it('the spec example in canonical orientation: reference 2, limit 2.04 (2%), maximum 1% → violated', () => {
    assert.equal(at('buy', '204000000', 'symmetric', 100).outcome, 'VIOLATED');
  });

  it('symmetric checks both directions; adverse only a sell below or a buy above the reference', () => {
    assert.equal(at('sell', '190000000', 'symmetric', 100).outcome, 'VIOLATED', 'sell 5% below');
    assert.equal(at('sell', '190000000', 'adverse', 100).outcome, 'VIOLATED', 'sell below is adverse');
    assert.equal(at('sell', '210000000', 'adverse', 100).outcome, 'SATISFIED', 'sell above is favourable to the owner');
    assert.equal(at('buy', '210000000', 'adverse', 100).outcome, 'VIOLATED', 'buy above is adverse');
    assert.equal(at('buy', '190000000', 'adverse', 100).outcome, 'SATISFIED');
  });

  it('a reference for the inverted pair is never inverted silently, and one for another issuer is not a reference', () => {
    const inverted = market({ base: { kind: 'xrp' }, quote: { kind: 'issued', currency: RLUSD, issuer: ISSUER }, price: { numerator: 1n, denominator: 2n } });
    const evidence = evidenceOf({ facts: { marketPrices: [inverted] } });
    assert.deepEqual(controlOf(evidence, 'REFERENCE_PRICE'), { outcome: 'UNAVAILABLE', reason: 'REFERENCE_ORIENTATION_INVERTED' });
    assert.equal(controlOf(evidence, 'REFERENCE_DEVIATION').outcome, 'UNAVAILABLE');
    const otherIssuer = market({ base: { kind: 'issued', currency: RLUSD, issuer: ISSUER_B } });
    assert.deepEqual(controlOf(evidenceOf({ facts: { marketPrices: [otherIssuer] } }), 'REFERENCE_PRICE'), { outcome: 'UNAVAILABLE', reason: 'REFERENCE_MISSING' });
  });
});

describe('Matrix 7 — notional is base quantity × trusted reference, in a named valuation asset', () => {
  it('below, at and above the maximum 2000 XRP (reference 2)', () => {
    assert.equal(controlOf(evidenceOf({ proposal: sell('999', '1998000000') }), 'NOTIONAL_MAXIMUM').outcome, 'SATISFIED');
    assert.equal(controlOf(evidenceOf({ proposal: sell('1000', '2000000000') }), 'NOTIONAL_MAXIMUM').outcome, 'SATISFIED', '1000 × 2 = 2000 exactly');
    const over = profileData({}, { maxBaseQuantity: '2000', maxOwnerGiven: { buy: '2500', sell: '2000' } });
    assert.equal(controlOf(evidenceOf({ profile: over, proposal: sell('1000.000001', '2000000002') }), 'NOTIONAL_MAXIMUM').outcome, 'VIOLATED', 'never rounded down to pass');
  });

  it('notional uses the trusted reference, not the applicant’s limit price', () => {
    // Selling 1000 at a limit of 1.9 states 1900 XRP; at the trusted reference of 2.1 the notional is 2100.
    const reference = market({ price: { numerator: 21n, denominator: 10n } });
    const evidence = evidenceOf({ proposal: sell('1000', '1900000000'), facts: { marketPrices: [reference] } });
    assert.equal(controlOf(evidence, 'NOTIONAL_MAXIMUM').outcome, 'VIOLATED', '1000 × 2.1 = 2100 > 2000');
  });

  it('missing, stale, wrong-asset, wrong-issuer and incomplete valuation data are UNAVAILABLE, never a pass', () => {
    assert.equal(controlOf(evidenceOf({ facts: { marketPrices: [] } }), 'NOTIONAL_MAXIMUM').outcome, 'UNAVAILABLE');
    assert.equal(controlOf(evidenceOf({ facts: { marketPrices: [market({ observedAt: '2026-10-13T11:59:00.000Z' })] } }), 'NOTIONAL_MAXIMUM').outcome, 'UNAVAILABLE');
    assert.equal(controlOf(evidenceOf({ facts: { marketPrices: [market({ quote: { kind: 'issued', currency: 'USD', issuer: ISSUER } })] } }), 'NOTIONAL_MAXIMUM').outcome, 'UNAVAILABLE');
    assert.equal(controlOf(evidenceOf({ facts: { marketPrices: [{ ...market(), price: { numerator: '0', denominator: '1' } }] } }), 'NOTIONAL_MAXIMUM').outcome, 'UNAVAILABLE');
  });

  it('a valuation asset equal to the base needs no price at all; one in a third asset needs that exact cross reference', () => {
    const inBase = profileData({ marketReference: { mode: 'enforce', sourceIds: ['fixture-market'], conventions: ['mid'], maxAgeSeconds: 30 } }, { notional: { mode: 'enforce', valuationAsset: { currency: RLUSD, issuer: ISSUER }, maximum: '100' } , approval: { restricted: false } });
    assert.equal(controlOf(evidenceOf({ profile: inBase }), 'NOTIONAL_MAXIMUM').outcome, 'SATISFIED', '100 RLUSD ≤ 100 RLUSD');
    const usd = { currency: 'USD', issuer: ISSUER_B };
    const inUsd = profileData({}, { notional: { mode: 'enforce', valuationAsset: usd, maximum: '150' }, approval: { restricted: false } });
    assert.equal(controlOf(evidenceOf({ profile: inUsd }), 'NOTIONAL_MAXIMUM').reason, 'VALUATION_PRICE_MISSING');
    const crossRate = market({ quote: { kind: 'issued', currency: 'USD', issuer: ISSUER_B }, price: { numerator: 1n, denominator: 1n } });
    assert.equal(controlOf(evidenceOf({ profile: inUsd, facts: { marketPrices: [market(), crossRate] } }), 'NOTIONAL_MAXIMUM').outcome, 'SATISFIED', '100 × 1 USD = 100 ≤ 150');
  });
});

describe('Order inventory arithmetic (exposure prerequisites)', () => {
  it('cancelled releases, partial fill splits, uncertain counts as pending — exactly', () => {
    const result = summarizeTradeOrderInventory([
      { state: 'open', orderedExposure: '100', filledExposure: '0' },
      { state: 'partially-filled', orderedExposure: '100', filledExposure: '40.5' },
      { state: 'filled', orderedExposure: '10', filledExposure: '10' },
      { state: 'cancelled', orderedExposure: '1000', filledExposure: '0' },
      { state: 'expired', orderedExposure: '50', filledExposure: '0.25' },
      { state: 'pending-submission', orderedExposure: '7', filledExposure: '0' },
      { state: 'submitted-uncertain', orderedExposure: '0.1', filledExposure: '0' },
    ]);
    assert.deepEqual(result, {
      valid: true,
      summary: { currentExposure: '50.75', pendingExposure: '7.1', activeOrderExposure: '159.5', ledgerOpenOffers: 2, pendingSubmissions: 1, uncertainSubmissions: 1 },
    });
  });

  it('a malformed entry refuses the whole inventory — a partial sum is never a total', () => {
    assert.deepEqual(summarizeTradeOrderInventory([{ state: 'open', orderedExposure: '1', filledExposure: '0' }, { state: 'open', orderedExposure: '1', filledExposure: '2' }]), { valid: false, index: 1 });
    assert.deepEqual(summarizeTradeOrderInventory([{ state: 'unknown', orderedExposure: '1', filledExposure: '0' }]), { valid: false, index: 0 });
    assert.deepEqual(summarizeTradeOrderInventory([{ state: 'open', orderedExposure: 1, filledExposure: '0' }]), { valid: false, index: 0 });
    assert.deepEqual(summarizeTradeOrderInventory({ length: 0 }), { valid: false, index: -1 });
  });
});
