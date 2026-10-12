import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createMonetaryAssetRegistry, parseMonetaryAmount } from '../../../../monetary-runtime/index.js';
import { LIGHTNING_MAXIMUM_MSAT, btcDecimalOfMsat, lightningFeeLimitMsat, msatOfBolt11Amount, msatOfBtcDecimal, msatOfDecimalText } from '../index.js';
import { BTC_ASSET, testRailConfiguration } from './lightning-test-fixtures.js';

/**
 * PAY-06 — exact Lightning money: P9 canonical BTC decimal ↔ integer msat.
 * Text and BigInt only; nothing rounded, nothing a float.
 */

const ASSETS = createMonetaryAssetRegistry([{ assetId: BTC_ASSET, scale: 11 }, { assetId: 'USD', scale: 2 }]);

describe('PAY-06 money — MONEY matrix', () => {
  it('MONEY-1 exact BTC → msat, and back, byte for byte', () => {
    for (const [btc, msat] of [
      ['1', 100_000_000_000n],
      ['0.5', 50_000_000_000n],
      ['0.0025', 250_000_000n],
      ['21000000', LIGHTNING_MAXIMUM_MSAT],
      ['0.12345678901', 12_345_678_901n],
    ] as const) {
      assert.equal(msatOfBtcDecimal(btc), msat, btc);
      assert.equal(btcDecimalOfMsat(msat), btc, String(msat));
    }
  });

  it('MONEY-2 the satoshi boundary: 0.00000001 BTC = 1000 msat', () => {
    assert.equal(msatOfBtcDecimal('0.00000001'), 1_000n);
    assert.equal(btcDecimalOfMsat(1_000n), '0.00000001');
  });

  it('MONEY-3 the millisatoshi boundary: 0.00000000001 BTC = 1 msat', () => {
    assert.equal(msatOfBtcDecimal('0.00000000001'), 1n);
    assert.equal(btcDecimalOfMsat(1n), '0.00000000001');
  });

  it('MONEY-4 a value needing sub-msat precision is refused, never rounded', () => {
    assert.equal(msatOfBtcDecimal('0.000000000001'), undefined);
    assert.equal(msatOfBtcDecimal('1.000000000015'), undefined);
    // P9 itself refuses it against an 11-digit BTC asset before the rail sees it.
    assert.equal(parseMonetaryAmount({ value: '0.000000000001', unit: BTC_ASSET }, ASSETS).valid, false);
  });

  it('MONEY-5 zero is refused; MONEY-6 a negative value is refused', () => {
    for (const value of ['0', '0.0', '-1', '-0.001']) assert.equal(msatOfBtcDecimal(value), undefined, value);
    assert.equal(btcDecimalOfMsat(0n), undefined);
    assert.equal(btcDecimalOfMsat(-1n), undefined);
  });

  it('MONEY-7 exponent, sign, separators, non-canonical spellings and numbers follow P9: refused', () => {
    for (const value of ['1e-3', '1E8', '+1', '1,5', '01', '1.50', '.5', '1.', ' 1', 1, 0.001, 1n, null]) assert.equal(msatOfBtcDecimal(value), undefined, String(value));
  });

  it('MONEY-8 overflow beyond Bitcoin’s supply (and LND’s int64 fields) is refused', () => {
    assert.equal(msatOfBtcDecimal('21000000.00000000001'), undefined);
    assert.equal(msatOfBtcDecimal('99999999999999999'), undefined);
    assert.equal(msatOfDecimalText('9223372036854775808'), undefined);
    assert.equal(msatOfDecimalText('2100000000000000001'), undefined);
    assert.equal(msatOfDecimalText(2_100_000_000_000_000), undefined, 'a node number is never money');
    assert.equal(msatOfBolt11Amount('21000001'), undefined);
  });

  it('BOLT11 hrp amounts: every multiplier exact; p must end in 0', () => {
    assert.equal(msatOfBolt11Amount('1'), 100_000_000_000n);
    assert.equal(msatOfBolt11Amount('20m'), 2_000_000_000n);
    assert.equal(msatOfBolt11Amount('2500u'), 250_000_000n);
    assert.equal(msatOfBolt11Amount('10n'), 1_000n);
    assert.equal(msatOfBolt11Amount('9678785340p'), 967_878_534n);
    assert.equal(msatOfBolt11Amount('9678785341p'), undefined);
  });

  it('the routing-fee cap is exact integer arithmetic from trusted configuration only', () => {
    const both = testRailConfiguration({ fees: { maximumFeeMsat: '50000', maximumFeePpm: 10_000 } });
    assert.equal(lightningFeeLimitMsat(both, 1_000_000n), 10_000n, '1% of 1 000 000 msat, below the absolute cap');
    assert.equal(lightningFeeLimitMsat(both, 100_000_000n), 50_000n, 'the absolute cap bounds a large payment');
    assert.equal(lightningFeeLimitMsat(both, 99n), 0n, 'floor: a tiny payment may only use zero-fee routes');
    assert.equal(lightningFeeLimitMsat(testRailConfiguration({ fees: { maximumFeeMsat: '7' } }), 10n ** 15n), 7n);
    assert.equal(lightningFeeLimitMsat(testRailConfiguration({ fees: { maximumFeePpm: 1 } }), 3_999_999n), 3n);
  });
});
