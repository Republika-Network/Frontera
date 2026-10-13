import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createMonetaryAssetRegistry, parseMonetaryAmount } from '../../../../monetary-runtime/index.js';
import { validatePaymentIntent } from '../../../domain/index.js';
import { STRIPE_MAXIMUM_AMOUNT_CENTS, centsOfDecimalText, centsOfUsdDecimal, stripeDestinationOf, usdDecimalOfCents } from '../index.js';
import { CONNECTED_ACCOUNT, GOVERNED_ACCOUNT, USD_ASSET } from './stripe-test-fixtures.js';

/**
 * PAY-09 — exact fiat money: P9 canonical USD decimal ↔ integer cents.
 * Text and BigInt only; nothing rounded, nothing a float, no exponent read.
 */

const ASSETS = createMonetaryAssetRegistry([{ assetId: USD_ASSET, scale: 2 }]);

/** The governed path's own ingress: the P9 parse every PaymentIntent amount goes through, then the rail's conversion. */
function governedCents(value: unknown): bigint | undefined {
  const parsed = parseMonetaryAmount({ value, unit: USD_ASSET }, ASSETS);
  return parsed.valid ? centsOfUsdDecimal(parsed.amount.value) : undefined;
}

describe('PAY-09 money — FIAT matrix', () => {
  it('FIAT-1 USD 0.01 → 1 cent', () => {
    assert.equal(governedCents('0.01'), 1n);
    assert.equal(centsOfUsdDecimal('0.01'), 1n);
  });

  it('FIAT-2 USD 1.00 → 100 cents (P9 canonicalizes "1.00" to "1" first; the rail never sees the trailing zeros)', () => {
    assert.equal(governedCents('1.00'), 100n);
    assert.equal(centsOfUsdDecimal('1'), 100n);
    assert.equal(centsOfUsdDecimal('1.00'), undefined, 'the rail accepts only the canonical form; P9 is the one place that canonicalizes');
  });

  it('FIAT-3 USD 75.00 → 7500 cents', () => {
    assert.equal(governedCents('75.00'), 7500n);
    assert.equal(centsOfUsdDecimal('75'), 7500n);
  });

  it('FIAT-4 USD 75000.00 → 7500000 cents', () => {
    assert.equal(governedCents('75000.00'), 7_500_000n);
  });

  it('FIAT-5 too many decimal places → refused, never rounded (by P9 at the asset scale, and by the rail on its own)', () => {
    assert.equal(parseMonetaryAmount({ value: '75.001', unit: USD_ASSET }, ASSETS).valid, false);
    assert.equal(centsOfUsdDecimal('75.001'), undefined);
    assert.equal(centsOfUsdDecimal('0.005'), undefined);
  });

  it('FIAT-6 negative → refused', () => {
    assert.equal(governedCents('-1'), undefined);
    assert.equal(centsOfUsdDecimal('-1'), undefined);
    assert.equal(centsOfUsdDecimal('-0.01'), undefined);
  });

  it('FIAT-7 zero → refused, by PAY-01 (a payment is positive) and by the rail', () => {
    assert.equal(centsOfUsdDecimal('0'), undefined);
    const intent = validatePaymentIntent(
      { source: { accountId: GOVERNED_ACCOUNT }, destination: stripeDestinationOf(CONNECTED_ACCOUNT), amount: { value: '0', unit: USD_ASSET }, purpose: 'purchase', idempotencyKey: 'k-zero' },
      { assets: ASSETS },
    );
    assert.equal(intent.valid, false);
    assert.deepEqual(intent.valid ? [] : intent.violations.map((violation) => violation.code), ['PAYMENT_AMOUNT_NOT_POSITIVE']);
  });

  it('FIAT-8 exponent notation, a number, whitespace, separators, leading zeros → refused', () => {
    for (const value of ['7.5e1', '1e2', '1E2', ' 1', '1 ', '1,00', '01', '1.', '.5', '+1', 'NaN', 'Infinity', '0x10', '1_000']) assert.equal(centsOfUsdDecimal(value), undefined, value);
    for (const value of [75, 75.5, 1e2, 7500n, null, undefined, {}]) assert.equal(centsOfUsdDecimal(value), undefined, String(value));
    assert.equal(parseMonetaryAmount({ value: '7.5e1', unit: USD_ASSET }, ASSETS).valid, false);
    assert.equal(parseMonetaryAmount({ value: 75 as unknown as string, unit: USD_ASSET }, ASSETS).valid, false, 'a JSON number is never money');
  });

  it('FIAT-9 an amount Stripe cannot carry (more than eight digits of cents) → refused before anything is contacted', () => {
    assert.equal(centsOfUsdDecimal('999999.99'), STRIPE_MAXIMUM_AMOUNT_CENTS);
    assert.equal(centsOfUsdDecimal('1000000'), undefined);
    assert.equal(centsOfUsdDecimal('99999999999999999'), undefined);
    assert.equal(usdDecimalOfCents(STRIPE_MAXIMUM_AMOUNT_CENTS + 1n), undefined);
  });

  it('FIAT-10 integer round trip is exact, byte for byte, over every scale boundary', () => {
    for (const [decimal, value] of [
      ['0.01', 1n],
      ['0.1', 10n],
      ['0.99', 99n],
      ['1', 100n],
      ['1.01', 101n],
      ['1.1', 110n],
      ['75', 7500n],
      ['123456.78', 12_345_678n],
      ['999999.99', 99_999_999n],
    ] as const) {
      assert.equal(centsOfUsdDecimal(decimal), value, decimal);
      assert.equal(usdDecimalOfCents(value), decimal, String(value));
    }
    for (let cents = 1n; cents <= 2_000n; cents += 1n) assert.equal(centsOfUsdDecimal(usdDecimalOfCents(cents)), cents);
  });

  it('Stripe-reported integers cross the adapter boundary as decimal text only', () => {
    assert.equal(centsOfDecimalText('7500'), 7500n);
    assert.equal(centsOfDecimalText('0'), 0n);
    for (const value of [7500, '07500', '-1', '75.00', '7e3', '', ' 7500']) assert.equal(centsOfDecimalText(value), undefined, String(value));
  });
});
