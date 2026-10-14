import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { TRADING_RISK_ASSESSMENT_REFUSALS, TRADING_RISK_PROFILE_VIOLATIONS as V, assessTradingRisk, parseTradingRiskProfile, tradingRiskProfileData } from '../index.js';
import { OTHER_ORG, STRANGER_OWNER, XRP_ASSET, pairData, profileData, riskInput } from './trade-risk-fixture.js';

/**
 * TRADE-03 matrix 1 (policy-profile validation) and 17 (policy versioning):
 * the trading-risk profile is strict, closed, immutable trusted configuration
 * — refused, never repaired, and never silently permissive.
 */

const parse = (raw: unknown) => parseTradingRiskProfile(raw);

function refusal(raw: unknown): { readonly violation: string; readonly field: string } {
  const result = parse(raw);
  assert.equal(result.valid, false, 'expected a refusal');
  return result.valid ? { violation: '', field: '' } : { violation: result.violation, field: result.field };
}

const withoutKey = (record: Record<string, unknown>, key: string): Record<string, unknown> => {
  const copy = { ...record };
  delete copy[key];
  return copy;
};

describe('TRADE-03 profile — a valid profile is one frozen, sealed contract', () => {
  it('accepts the fixture, canonicalizes list order, freezes and seals it', () => {
    const result = parse(profileData({ ownerAccounts: [STRANGER_OWNER, 'rf1BiGeXwwQoi8Z2ueFYTEXSwuJYfV2Jpn'] }));
    assert.ok(result.valid, result.valid ? '' : result.violation);
    if (!result.valid) return;
    assert.deepEqual(result.profile.ownerAccounts, [...result.profile.ownerAccounts].sort());
    assert.ok(Object.isFrozen(result.profile));
    assert.ok(Object.isFrozen(result.profile.pairs[0]));
    assert.match(result.profile.digest, /^sha256:[0-9a-f]{64}$/);
    assert.equal(result.profile.pairs[0]?.minSellPrice !== undefined && 'numerator' in result.profile.pairs[0].minSellPrice ? result.profile.pairs[0].minSellPrice.numerator : 0n, 19n);
  });

  it('is deterministic: the same content has the same digest however it is spelled; any change of content or version changes it', () => {
    const a = parse(profileData());
    const b = parse(profileData({ ownerAccounts: ['rf1BiGeXwwQoi8Z2ueFYTEXSwuJYfV2Jpn'] }, { minSellPrice: { numerator: '38', denominator: '20' } }));
    const c = parse(profileData({ profileVersion: 4 }));
    const d = parse(profileData({}, { maxBaseQuantity: '1001' }));
    assert.ok(a.valid && b.valid && c.valid && d.valid);
    if (!a.valid || !b.valid || !c.valid || !d.valid) return;
    assert.equal(a.profile.digest, b.profile.digest, '38/20 is 19/10');
    assert.notEqual(a.profile.digest, c.profile.digest);
    assert.notEqual(a.profile.digest, d.profile.digest);
  });

  it('round-trips through its data form, and a stored snapshot whose digest does not match its content is refused (SEC-TRADE03-19)', () => {
    const result = parse(profileData());
    assert.ok(result.valid);
    if (!result.valid) return;
    const stored = { ...tradingRiskProfileData(result.profile), digest: result.profile.digest };
    const again = parse(stored);
    assert.ok(again.valid);
    if (again.valid) assert.equal(again.profile.digest, result.profile.digest);
    assert.deepEqual(refusal({ ...stored, profileVersion: 4 }), { violation: V.DIGEST_MISMATCH, field: 'digest' });
  });
});

describe('TRADE-03 profile — closed records and hostile shapes', () => {
  it('refuses every missing required field', () => {
    for (const key of Object.keys(profileData())) assert.equal(parse(withoutKey(profileData(), key)).valid, false, key);
    for (const key of Object.keys(pairData())) {
      if (key === 'minSellPrice' || key === 'maxBuyPrice') continue;
      assert.equal(parse(profileData({ pairs: [withoutKey(pairData(), key)] })).valid, false, `pair.${key}`);
    }
  });

  it('refuses unexpected fields, accessors, symbols, prototype keys, class instances and unknown schemas', () => {
    assert.equal(parse({ ...profileData(), defaultLimit: 'unlimited' }).valid, false);
    const getter = profileData();
    Object.defineProperty(getter, 'profileVersion', { get: () => 3, enumerable: true });
    assert.equal(parse(getter).valid, false);
    assert.equal(parse({ ...profileData(), [Symbol('x')]: 1 }).valid, false);
    assert.equal(parse(JSON.parse(`{"__proto__":{"polluted":true},${JSON.stringify(profileData()).slice(1)}`)).valid, false);
    assert.equal(({} as Record<string, unknown>)['polluted'], undefined, 'no prototype pollution');
    assert.equal(parse(Object.assign(Object.create({ inherited: true }), profileData())).valid, false);
    assert.equal(refusal(profileData({ schema: 'frontera.trading-risk-profile.v2' })).violation, V.SCHEMA_UNSUPPORTED);
    assert.equal(parse(null).valid, false);
    assert.equal(parse([profileData()]).valid, false);
  });

  it('refuses invalid timestamps and windows: unparsable, inverted, empty, or a horizon above 400 days', () => {
    for (const overrides of [
      { effectiveFrom: '2026-10-01' },
      { effectiveFrom: '2026-13-01T00:00:00.000Z' },
      { expiresAt: '2026-09-30T00:00:00.000Z' },
      { expiresAt: '2026-10-01T00:00:00.000Z' },
      { expiresAt: '2028-01-01T00:00:00.000Z' },
      { expiresAt: 1_800_000_000_000 },
    ]) {
      assert.equal(refusal(profileData(overrides)).violation, V.WINDOW_INVALID, JSON.stringify(overrides));
    }
  });

  it('refuses malformed accounts, unsupported networks, unknown flags and empty scopes', () => {
    assert.equal(refusal(profileData({ ownerAccounts: ['rrrrrrrrrrrrrrrrrrrrrhoLvTp'] })).violation, V.ACCOUNT_INVALID, 'reserved account');
    assert.equal(refusal(profileData({ delegateAccounts: ['not-an-account'] })).violation, V.ACCOUNT_INVALID);
    assert.equal(refusal(profileData({ ownerAccounts: [] })).violation, V.LIST_INVALID);
    assert.equal(refusal(profileData({ ownerAccounts: ['rf1BiGeXwwQoi8Z2ueFYTEXSwuJYfV2Jpn', 'rf1BiGeXwwQoi8Z2ueFYTEXSwuJYfV2Jpn'] })).violation, V.LIST_INVALID);
    assert.equal(parse(profileData({ network: 'xrp-ledger-mainnet' })).valid, false);
    assert.equal(parse(profileData({ allowedFlags: ['hybrid'] })).valid, false);
    assert.ok(parse(profileData({ allowedFlags: [] })).valid, 'no flags at all is an explicit, valid choice');
  });
});

describe('TRADE-03 profile — limits are exact, positive and explicit (SEC-TRADE03-07)', () => {
  it('refuses zero, negative, non-canonical, exponent, number and over-precise limits — never repairs them', () => {
    for (const value of ['0', '-1', '10.50', '010', '1e3', ' 1', 1000, '1'.repeat(129), 'Infinity', '']) {
      assert.equal(refusal(profileData({}, { maxBaseQuantity: value })).violation, V.LIMIT_INVALID, String(value));
    }
    assert.ok(parse(profileData({}, { maxBaseQuantity: '0.000000000000000001' })).valid, 'tiny positive is exact');
    assert.ok(parse(profileData({}, { maxBaseQuantity: '9'.repeat(100) })).valid, 'very large is exact');
  });

  it('refuses invalid prices: zero or empty denominator, zero numerator, negative, fractional, number', () => {
    for (const price of [
      { numerator: '1', denominator: '0' },
      { numerator: '0', denominator: '1' },
      { numerator: '-1', denominator: '1' },
      { numerator: '1.5', denominator: '1' },
      { numerator: 1, denominator: 1 },
      { numerator: '1', denominator: '' },
      { numerator: '1', denominator: '1', extra: '1' },
    ]) {
      assert.equal(refusal(profileData({}, { minSellPrice: price })).violation, V.PRICE_INVALID, JSON.stringify(price));
    }
    assert.equal(refusal(profileData({}, { priceBand: { mode: 'enforce', floor: { numerator: '3', denominator: '1' }, ceiling: { numerator: '1', denominator: '1' } } })).violation, V.PRICE_INVALID, 'floor above ceiling');
  });

  it('a side bound is present exactly for an allowed side; the other side carries none', () => {
    assert.equal(parse(profileData({}, { sides: ['sell'], maxOwnerGiven: { sell: '1000' }, maxBuyPrice: undefined })).valid, false, 'undefined is not absence');
    const sellOnly = { ...withoutKey(pairData(), 'maxBuyPrice'), sides: ['sell'], maxOwnerGiven: { sell: '1000' } };
    assert.ok(parse(profileData({ pairs: [sellOnly] })).valid);
    assert.equal(parse(profileData({ pairs: [{ ...sellOnly, maxBuyPrice: { numerator: '2', denominator: '1' } }] })).valid, false, 'bound for a side that is not allowed');
    assert.equal(parse(profileData({ pairs: [withoutKey(pairData(), 'minSellPrice')] })).valid, false, 'sell allowed without a stated floor (or explicit disable)');
    assert.equal(parse(profileData({}, { maxOwnerGiven: { sell: '1000' } })).valid, false, 'buy allowed without an owner-given ceiling');
  });

  it('only some controls may be disabled, and only explicitly with a reason', () => {
    assert.ok(parse(profileData({ activeOrders: { mode: 'disabled', reason: 'desk-runs-one-order' } })).valid);
    assert.equal(refusal(profileData({ delegation: { mode: 'disabled', reason: 'trust-me' } })).violation, V.CONTROL_NOT_DISABLEABLE);
    assert.equal(parse(profileData({}, { maxBaseQuantity: { mode: 'disabled', reason: 'none' } })).valid, false);
    assert.equal(parse(profileData({}, { maxOwnerGiven: { mode: 'disabled', reason: 'none' } })).valid, false);
    assert.equal(parse(profileData({ exposure: { mode: 'disabled' } })).valid, false, 'a disable needs a reason');
    assert.equal(parse(profileData({ exposure: { mode: 'off', reason: 'x' } })).valid, false);
    assert.equal(parse(profileData({ exposure: {} })).valid, false, 'an empty control is not a disabled control');
  });

  it('SEC-TRADE03-18: aggregate exposure and active-order limits can only be configured as snapshot-advisory — an atomic claim is refused', () => {
    const exposure = { mode: 'enforce', riskBucket: 'b', denomination: XRP_ASSET, ceiling: '1', sourceIds: ['s'], maxAgeSeconds: 30, concurrency: 'atomic-reservation' };
    assert.equal(refusal(profileData({ exposure })).violation, V.CONCURRENCY_UNSUPPORTED);
    assert.equal(refusal(profileData({ activeOrders: { mode: 'enforce', scope: 'owner', maximum: 5, sourceIds: ['s'], maxAgeSeconds: 30, concurrency: 'atomic' } })).violation, V.CONCURRENCY_UNSUPPORTED);
  });

  it('a control that values an order needs a trusted market reference; an approval threshold must sit below its ceiling', () => {
    const noMarket = { marketReference: { mode: 'disabled', reason: 'no-feed' } };
    assert.equal(refusal(profileData(noMarket)).violation, V.DEPENDENCY_MISSING, 'deviation without reference');
    assert.equal(refusal(profileData(noMarket, { referenceDeviation: { mode: 'disabled', reason: 'x' }, approval: { restricted: false } })).violation, V.DEPENDENCY_MISSING, 'XRP notional without reference');
    assert.equal(refusal(profileData({}, { approval: { restricted: false, notionalAbove: '2000' } })).violation, V.DEPENDENCY_MISSING);
    assert.equal(refusal(profileData({}, { approval: { restricted: false, deviationAboveBasisPoints: 300 } })).violation, V.DEPENDENCY_MISSING);
  });

  it('pairs are canonical, distinct and exact: a reversed pair, a duplicate, or one asset twice is refused', () => {
    assert.equal(refusal(profileData({}, { base: XRP_ASSET, quote: { currency: '524C555344000000000000000000000000000000', issuer: 'rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B' } })).violation, V.PAIR_NOT_CANONICAL);
    assert.equal(refusal(profileData({}, { quote: { currency: '524C555344000000000000000000000000000000', issuer: 'rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B' } })).violation, V.PAIR_NOT_CANONICAL);
    assert.equal(refusal(profileData({ pairs: [pairData(), pairData({ pairId: 'again' })] })).violation, V.PAIR_DUPLICATED);
    assert.equal(refusal(profileData({}, { base: { currency: 'USD' } })).violation, V.ASSET_INVALID, 'an issued currency without an issuer is not an asset');
    assert.equal(refusal(profileData({}, { base: { currency: 'xrp', issuer: 'rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B' } })).violation, V.ASSET_INVALID, 'a look-alike XRP');
  });

  it('review lists are subsets of the authorized scope', () => {
    assert.equal(refusal(profileData({ approval: { sensitiveOwners: [STRANGER_OWNER], sensitiveDelegates: [] } })).violation, V.ACCOUNT_INVALID);
  });
});

describe('TRADE-03 profile — the applicant never supplies or selects it', () => {
  it('SEC-TRADE03-08: a profile of another organization is never applied — no evidence is produced at all', () => {
    const result = assessTradingRisk(riskInput({ profile: profileData({ organizationId: OTHER_ORG }) }));
    assert.deepEqual(result, { assessed: false, refusal: TRADING_RISK_ASSESSMENT_REFUSALS.PROFILE_ORGANIZATION_MISMATCH });
  });

  it('an invalid profile yields no evidence (nothing that could be read as compliance)', () => {
    const result = assessTradingRisk(riskInput({ profile: profileData({ status: 'enabled' }) }));
    assert.deepEqual(result, { assessed: false, refusal: TRADING_RISK_ASSESSMENT_REFUSALS.PROFILE_INVALID });
  });

  it('a proposal cannot carry its own limits or policy: such fields are refused by the TRADE-01 contract before any assessment', () => {
    for (const field of ['riskProfile', 'maxNotional', 'priceLimit', 'exposureCeiling', 'approvedPairs']) {
      const result = assessTradingRisk({ ...riskInput(), proposal: { ...(riskInput().proposal as Record<string, unknown>), [field]: 'x' } });
      assert.deepEqual(result, { assessed: false, refusal: TRADING_RISK_ASSESSMENT_REFUSALS.PROPOSAL_INVALID }, field);
    }
  });
});
