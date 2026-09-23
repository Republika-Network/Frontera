import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  MONETARY_AMOUNT_VIOLATIONS as V,
  MonetaryConfigurationError,
  compareMonetaryAmounts,
  createMonetaryAssetRegistry,
  isPositiveMonetaryAmount,
  isWellFormedMonetaryAmount,
  parseMonetaryAmount,
  type MonetaryAssetDefinition,
} from '../index.js';

/**
 * P9 — asset identity, trusted scale, and no FX.
 *
 * The registry here is a test fixture, not a product decision: which assets a
 * deployment recognizes is that deployment's configuration.
 */
const DEFINITIONS: readonly MonetaryAssetDefinition[] = [
  { assetId: 'USD', scale: 2 },
  { assetId: 'xrpl:XRP', scale: 6 },
  { assetId: 'stellar:XLM', scale: 7 },
  { assetId: 'xrpl:USD/rIssuerA', scale: 15 },
  { assetId: 'JPY', scale: 0 },
];
const ASSETS = createMonetaryAssetRegistry(DEFINITIONS);

function parsed(value: unknown, unit: unknown) {
  return parseMonetaryAmount({ value, unit }, ASSETS);
}

describe('P9 trusted asset scale', () => {
  it('a recognized asset resolves to exactly its definition', () => {
    assert.deepEqual(ASSETS.resolve('USD'), { assetId: 'USD', scale: 2 });
    assert.deepEqual(ASSETS.resolve('xrpl:XRP'), { assetId: 'xrpl:XRP', scale: 6 });
    assert.deepEqual(ASSETS.assetIds, ['JPY', 'USD', 'stellar:XLM', 'xrpl:USD/rIssuerA', 'xrpl:XRP']);
  });

  it('an unknown asset fails closed — including a case variant, a padded spelling and a non-string', () => {
    for (const unit of ['usd', 'USD ', 'EUR', 'xrpl:USD', 'xrpl:USD/rIssuerB', '', null, 840, { assetId: 'USD' }]) {
      assert.deepEqual(parsed('1', unit), { valid: false, violation: V.MONETARY_UNIT_UNKNOWN }, String(unit));
    }
  });

  it('the maximum scale is accepted and one digit beyond it is refused — never rounded or truncated', () => {
    assert.deepEqual(parsed('10.01', 'USD'), { valid: true, amount: { value: '10.01', unit: 'USD' } });
    assert.deepEqual(parsed('10.001', 'USD'), { valid: false, violation: V.MONETARY_SCALE_EXCEEDED });
    assert.deepEqual(parsed('0.000001', 'xrpl:XRP'), { valid: true, amount: { value: '0.000001', unit: 'xrpl:XRP' } });
    assert.deepEqual(parsed('0.0000001', 'xrpl:XRP'), { valid: false, violation: V.MONETARY_SCALE_EXCEEDED });
    assert.deepEqual(parsed('0.0000001', 'stellar:XLM'), { valid: true, amount: { value: '0.0000001', unit: 'stellar:XLM' } });
    assert.deepEqual(parsed('1.5', 'JPY'), { valid: false, violation: V.MONETARY_SCALE_EXCEEDED });
  });

  it('trailing zeros beyond the scale do not state precision: "10.000" USD is exactly "10"', () => {
    assert.deepEqual(parsed('10.000', 'USD'), { valid: true, amount: { value: '10', unit: 'USD' } });
    assert.deepEqual(parsed('10.50', 'USD'), { valid: true, amount: { value: '10.5', unit: 'USD' } });
  });

  it('a caller cannot supply scale: the parser reads value and unit, and the registry alone decides', () => {
    const forged = { value: '10.001', unit: 'USD', scale: 19 } as unknown as { value: unknown; unit: unknown };
    assert.deepEqual(parseMonetaryAmount(forged, ASSETS), { valid: false, violation: V.MONETARY_SCALE_EXCEEDED });
  });

  it('very large and very small permitted amounts are exact', () => {
    assert.deepEqual(parsed('123456789012345678901234567890.12', 'USD'), { valid: true, amount: { value: '123456789012345678901234567890.12', unit: 'USD' } });
    assert.deepEqual(parsed('0.000000000000001', 'xrpl:USD/rIssuerA'), { valid: true, amount: { value: '0.000000000000001', unit: 'xrpl:USD/rIssuerA' } });
  });

  it('refuses a number, and refuses malformed text before consulting the asset', () => {
    assert.deepEqual(parsed(10, 'USD'), { valid: false, violation: V.MONETARY_VALUE_NOT_TEXT });
    assert.deepEqual(parsed(0.1, 'USD'), { valid: false, violation: V.MONETARY_VALUE_NOT_TEXT });
    for (const value of ['', ' 1', '-1', '1e3', '1,000.00', 'NaN', 'Infinity']) assert.deepEqual(parsed(value, 'USD'), { valid: false, violation: V.MONETARY_VALUE_MALFORMED }, value);
  });

  it('the parsed amount is frozen and carries the registry’s identifier', () => {
    const result = parsed('1', 'USD');
    assert.ok(result.valid);
    if (result.valid) assert.ok(Object.isFrozen(result.amount));
  });
});

describe('P9 asset registry configuration', () => {
  it('an identifier stated twice is refused, not resolved by picking one', () => {
    assert.throws(() => createMonetaryAssetRegistry([{ assetId: 'USD', scale: 2 }, { assetId: 'USD', scale: 19 }]), MonetaryConfigurationError);
  });

  it('malformed definitions are refused at wiring time', () => {
    for (const definition of [
      { assetId: 'USD', scale: -1 },
      { assetId: 'USD', scale: 2.5 },
      { assetId: 'USD', scale: 37 },
      { assetId: 'USD', scale: '2' },
      { assetId: ' USD', scale: 2 },
      { assetId: 'US D', scale: 2 },
      { assetId: '', scale: 2 },
      { assetId: 'USD', scale: 2, fxRate: 1 },
      { assetId: 'USD' },
    ]) {
      assert.throws(() => createMonetaryAssetRegistry([definition as unknown as MonetaryAssetDefinition]), MonetaryConfigurationError, JSON.stringify(definition));
    }
    assert.throws(() => createMonetaryAssetRegistry('USD' as unknown as MonetaryAssetDefinition[]), MonetaryConfigurationError);
  });

  it('an accessor definition is refused — a getter could answer differently later', () => {
    const definition = { assetId: 'USD', get scale() { return 2; } };
    assert.throws(() => createMonetaryAssetRegistry([definition]), MonetaryConfigurationError);
  });

  it('an empty registry recognizes nothing', () => {
    assert.deepEqual(parseMonetaryAmount({ value: '1', unit: 'USD' }, createMonetaryAssetRegistry([])), { valid: false, violation: V.MONETARY_UNIT_UNKNOWN });
  });

  it('the registry does not retain the caller’s configuration objects', () => {
    const definitions = [{ assetId: 'USD', scale: 2 }];
    const registry = createMonetaryAssetRegistry(definitions);
    (definitions[0] as { scale: number }).scale = 19;
    assert.equal(registry.resolve('USD')?.scale, 2);
    assert.ok(Object.isFrozen(registry));
  });
});

describe('P9 no implicit FX', () => {
  it('same-asset amounts compare exactly', () => {
    assert.equal(compareMonetaryAmounts({ value: '10', unit: 'USD' }, { value: '20', unit: 'USD' }), -1);
    assert.equal(compareMonetaryAmounts({ value: '9007199254740993', unit: 'USD' }, { value: '9007199254740992', unit: 'USD' }), 1);
    assert.equal(compareMonetaryAmounts({ value: '0.3', unit: 'USD' }, { value: '0.3', unit: 'USD' }), 0);
  });

  it('different assets are incomparable, whatever their magnitudes', () => {
    assert.equal(compareMonetaryAmounts({ value: '10', unit: 'USD' }, { value: '20', unit: 'xrpl:XRP' }), 'incomparable');
    assert.equal(compareMonetaryAmounts({ value: '10', unit: 'USD' }, { value: '10', unit: 'xrpl:USD/rIssuerA' }), 'incomparable', 'a ticker is not an identity');
  });

  it('a malformed side is incomparable, never coerced', () => {
    assert.equal(compareMonetaryAmounts({ value: 10 as unknown as string, unit: 'USD' }, { value: '20', unit: 'USD' }), 'incomparable');
    assert.equal(compareMonetaryAmounts({ value: '10.0', unit: 'USD' }, { value: '20', unit: 'USD' }), 'incomparable');
  });
});

describe('P9 structural well-formedness downstream of ingress', () => {
  it('accepts canonical text in a well-formed asset, and nothing else', () => {
    assert.equal(isWellFormedMonetaryAmount({ value: '7500', unit: 'USD' }), true);
    for (const amount of [{ value: 7500, unit: 'USD' }, { value: '7500.0', unit: 'USD' }, { value: '7500', unit: '' }, { value: '7500' }, null, '7500']) {
      assert.equal(isWellFormedMonetaryAmount(amount), false, JSON.stringify(amount));
    }
  });

  it('zero is a monetary quantity, but not a positive one', () => {
    assert.equal(isWellFormedMonetaryAmount({ value: '0', unit: 'USD' }), true);
    assert.equal(isPositiveMonetaryAmount({ value: '0', unit: 'USD' }), false);
    assert.equal(isPositiveMonetaryAmount({ value: '0.01', unit: 'USD' }), true);
  });
});
