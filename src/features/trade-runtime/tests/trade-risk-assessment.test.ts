import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  TRADE_INTENT_BINDING_FACTS,
  TRADE_RISK_FACT_CLASSES,
  compileTradeProposal,
  createTradeGovernanceBinding,
  TRADING_RISK_ASSESSMENT_REFUSALS as AR,
  TRADING_RISK_CONTROLS,
  TRADING_RISK_RELIANCE_REFUSALS as RR,
  assessTradingRisk,
  checkTradingRiskReliance,
  sealTradeActiveOrderSnapshot,
  sealTradeExposureSnapshot,
  tradeActiveOrderSnapshotData,
  tradeDelegationContextReading,
  tradeExposureSnapshotData,
  trustedMarketPriceSnapshotData,
  tradingRiskContextReadings,
} from '../index.js';
import type { TradingRiskAssessmentEvidence } from '../index.js';
import {
  AT,
  DELEGATE,
  DELEGATION_POLICY,
  ISSUER,
  ISSUER_B,
  ORG,
  OTHER_ORG,
  OWNER,
  RLUSD,
  STRANGER_DELEGATE,
  STRANGER_OWNER,
  accepted,
  buy,
  controlOf,
  delegationFor,
  evidenceOf,
  exposureReading,
  grantedObservation,
  market,
  ordersReading,
  pairData,
  profileData,
  proposal,
  riskInput,
  sell,
} from './trade-risk-fixture.js';

/**
 * TRADE-03 — the composite risk assessment, its evidence and its reliance:
 * matrices 2, 3, 8–11, 16–19 and the domain level of qualification
 * scenarios A–R. Every fact here comes from a fake trusted source marked
 * `simulated`; no ledger, market or execution is involved.
 */

const later = (seconds: number): string => new Date(Date.parse(AT) + seconds * 1000).toISOString();
const exposure = (overrides: Parameters<typeof exposureReading>[0] = {}) => sealTradeExposureSnapshot(exposureReading(overrides));
const orders = (overrides: Parameters<typeof ordersReading>[0] = {}) => sealTradeActiveOrderSnapshot(ordersReading(overrides));

describe('Scenario A — an approved trade: every mandatory control affirmatively established', () => {
  it('is SATISFIED / ELIGIBLE, records all sixteen controls once, and is sealed and frozen', () => {
    const evidence = evidenceOf();
    assert.equal(evidence.outcome, 'SATISFIED', JSON.stringify(evidence.controls.filter((control) => control.outcome !== 'SATISFIED')));
    assert.equal(evidence.disposition, 'ELIGIBLE');
    assert.deepEqual(evidence.controls.map((control) => control.control), [...TRADING_RISK_CONTROLS]);
    assert.ok(evidence.controls.every((control) => control.outcome === 'SATISFIED'));
    assert.match(evidence.digest, /^sha256:[0-9a-f]{64}$/);
    assert.ok(Object.isFrozen(evidence) && Object.isFrozen(evidence.controls) && Object.isFrozen(evidence.controls[0]));
    assert.equal(evidence.proposalDigest, accepted().digest);
    assert.deepEqual(evidence.riskProfile.profileId, 'mm-desk');
    assert.equal(evidence.pair.base, `${RLUSD}.${ISSUER}`);
    assert.equal(evidence.limitPrice, '2/1');
    assert.equal(evidence.simulatedFacts, true, 'SEC-TRADE03-20: simulated facts are named as such');
    assert.ok(evidence.limitations.includes('SIMULATED_FACTS'));
    assert.ok(evidence.limitations.includes('AGGREGATE_EXPOSURE_NOT_RESERVED'), 'SEC-TRADE03-18');
    assert.ok(evidence.limitations.includes('LIMIT_PRICE_IS_NOT_EXECUTION_PRICE'));
  });

  it('is a prerequisite only: the evidence carries no decision, grant, approval or execution field', () => {
    const keys = JSON.stringify(Object.keys(evidenceOf()));
    for (const word of ['decision', 'grant', 'allow', 'authorized', 'execut', 'signature']) assert.equal(keys.toLowerCase().includes(word), false, word);
  });

  it('is deterministic: the same inputs give the same digest', () => {
    assert.equal(evidenceOf().digest, evidenceOf().digest);
  });
});

describe('Matrices 2–3 — pairs, issuers, sides, owner and delegate scope, network, flags (scenarios B, C)', () => {
  const outcomeOf = (raw: Record<string, unknown>, control: string, profile?: unknown) => controlOf(evidenceOf({ proposal: raw, ...(profile !== undefined ? { profile } : {}) }), control);

  it('B: the right currency code from the wrong issuer is VIOLATED as an issuer refusal', () => {
    const evidence = evidenceOf({ proposal: sell('100', '200000000', { takerGets: { currency: RLUSD, issuer: ISSUER_B, value: '100' } }) });
    assert.deepEqual(controlOf(evidence, 'PAIR_APPROVED'), { outcome: 'VIOLATED', reason: 'ISSUER_NOT_APPROVED' });
    assert.equal(evidence.outcome, 'VIOLATED');
    assert.equal(evidence.disposition, 'PROHIBITED');
  });

  it('C: a valid OfferCreate on a pair that is not approved, or with the wrong currency, is VIOLATED', () => {
    assert.deepEqual(outcomeOf(sell('100', '200000000', { takerGets: { currency: 'EUR', issuer: ISSUER, value: '100' } }), 'PAIR_APPROVED'), { outcome: 'VIOLATED', reason: 'PAIR_NOT_APPROVED' });
    const issuedPair = sell('100', '200000000', { takerPays: { currency: 'USD', issuer: ISSUER, value: '200' } });
    assert.equal(outcomeOf(issuedPair, 'PAIR_APPROVED').outcome, 'VIOLATED');
  });

  it('a prohibited direction on an approved pair: sell-only refuses a buy, buy-only refuses a sell', () => {
    const { maxBuyPrice: _b, ...sellOnlyPair } = pairData({ sides: ['sell'], maxOwnerGiven: { sell: '1000' } });
    const { minSellPrice: _s, ...buyOnlyPair } = pairData({ sides: ['buy'], maxOwnerGiven: { buy: '2500' } });
    const sellOnly = profileData({ pairs: [sellOnlyPair] });
    const buyOnly = profileData({ pairs: [buyOnlyPair] });
    assert.deepEqual(outcomeOf(buy(), 'SIDE_APPROVED', sellOnly), { outcome: 'VIOLATED', reason: 'SIDE_NOT_APPROVED' });
    assert.deepEqual(outcomeOf(sell(), 'SIDE_APPROVED', buyOnly), { outcome: 'VIOLATED', reason: 'SIDE_NOT_APPROVED' });
    assert.equal(outcomeOf(sell(), 'SIDE_APPROVED', sellOnly).outcome, 'SATISFIED');
  });

  it('wrong owner, wrong delegate, wrong network and unexpected flags are each VIOLATED', () => {
    assert.deepEqual(outcomeOf(proposal({ ownerAccount: STRANGER_OWNER }), 'OWNER_IN_SCOPE'), { outcome: 'VIOLATED', reason: 'OWNER_NOT_IN_SCOPE' });
    assert.deepEqual(outcomeOf(proposal({ delegateAccount: STRANGER_DELEGATE }), 'DELEGATE_IN_SCOPE'), { outcome: 'VIOLATED', reason: 'DELEGATE_NOT_IN_SCOPE' });
    assert.deepEqual(outcomeOf(proposal({ network: 'xrp-ledger-devnet' }), 'PROFILE_IN_FORCE'), { outcome: 'VIOLATED', reason: 'NETWORK_NOT_APPROVED' });
    assert.deepEqual(outcomeOf(proposal({ flags: ['passive', 'immediate-or-cancel'] }), 'FLAGS_PERMITTED'), { outcome: 'VIOLATED', reason: 'FLAG_NOT_PERMITTED' });
    assert.equal(outcomeOf(proposal({ flags: [] }), 'FLAGS_PERMITTED').outcome, 'SATISFIED');
  });

  it('a profile that is suspended, retired, not yet effective, expired, or for another action is never in force', () => {
    for (const overrides of [{ status: 'suspended' }, { status: 'retired' }, { effectiveFrom: '2026-10-14T00:00:00.000Z', expiresAt: '2026-12-31T00:00:00.000Z' }, { effectiveFrom: '2026-01-01T00:00:00.000Z', expiresAt: '2026-10-13T12:00:08.000Z' }, { action: 'trade.offer-cancel' }]) {
      const evidence = evidenceOf({ profile: profileData(overrides) });
      assert.equal(controlOf(evidence, 'PROFILE_IN_FORCE').outcome, 'VIOLATED', JSON.stringify(overrides));
      assert.equal(evidence.outcome, 'VIOLATED');
    }
  });

  it('Q: cross-organization — an identity of another organization, or a proposal naming one, yields no evidence', () => {
    assert.deepEqual(assessTradingRisk(riskInput({ identity: { organizationId: OTHER_ORG, principalId: 'agent-mm-01' } })), { assessed: false, refusal: AR.ORGANIZATION_MISMATCH });
    assert.deepEqual(assessTradingRisk(riskInput({ identity: { organizationId: ORG, principalId: 'agent-other' } })), { assessed: false, refusal: AR.PRINCIPAL_MISMATCH });
  });
});

describe('Matrix 8 — trusted market reference: trust, freshness, conflict (scenario H)', () => {
  const reason = (marketPrices: readonly unknown[], profile?: unknown) => controlOf(evidenceOf({ facts: { marketPrices }, ...(profile !== undefined ? { profile } : {}) }), 'REFERENCE_PRICE');

  it('H: a stale reference is UNAVAILABLE — at the bound it is fresh, one millisecond past it is stale', () => {
    assert.deepEqual(reason([market({ observedAt: '2026-10-13T11:59:00.000Z' })]), { outcome: 'UNAVAILABLE', reason: 'REFERENCE_STALE' });
    assert.equal(reason([market({ observedAt: '2026-10-13T11:59:38.000Z' })]).outcome, 'SATISFIED', 'exactly 30 s old');
    assert.equal(reason([market({ observedAt: '2026-10-13T11:59:37.999Z' })]).reason, 'REFERENCE_STALE');
    assert.equal(reason([market({ maxAgeSeconds: 2 })]).reason, 'REFERENCE_STALE', "the source's own shorter bound applies");
    assert.equal(reason([market({ observedAt: '2026-10-13T12:00:09.000Z' })]).reason, 'REFERENCE_FROM_FUTURE');
  });

  it('missing, malformed or tampered snapshots are UNAVAILABLE, and the whole assessment is withheld', () => {
    const evidence = evidenceOf({ facts: { marketPrices: [] } });
    assert.deepEqual(controlOf(evidence, 'REFERENCE_PRICE'), { outcome: 'UNAVAILABLE', reason: 'REFERENCE_MISSING' });
    assert.equal(evidence.outcome, 'UNAVAILABLE');
    assert.equal(evidence.disposition, 'WITHHELD');
    const data = trustedMarketPriceSnapshotData(market());
    assert.equal(reason([{ ...data, price: { numerator: '3', denominator: '1' } }]).reason, 'REFERENCE_MALFORMED', 'altered after sealing');
    assert.equal(reason([{ ...data, extra: 1 }]).reason, 'REFERENCE_MALFORMED');
    assert.equal(reason(['2.0']).reason, 'REFERENCE_MALFORMED');
    assert.equal(controlOf(evidenceOf({ facts: { marketPrices: 'not-a-list' as never } }), 'REFERENCE_PRICE').outcome, 'UNAVAILABLE');
  });

  it('SEC-TRADE03-21: an unconfigured source, another organization’s source, a wrong convention or another network is refused', () => {
    assert.equal(reason([market({ sourceId: 'agent-supplied-feed' })]).reason, 'REFERENCE_SOURCE_NOT_ACCEPTED');
    assert.equal(reason([market({ organizationId: OTHER_ORG })]).reason, 'REFERENCE_ORGANIZATION_MISMATCH');
    assert.equal(reason([market({ convention: 'ask' })]).reason, 'REFERENCE_CONVENTION_NOT_ACCEPTED');
    assert.equal(reason([market({ network: 'xrp-ledger-devnet' })]).reason, 'REFERENCE_NETWORK_MISMATCH');
  });

  it('SEC-TRADE03-20: a simulated reading is refused where the profile admits operational sources only', () => {
    const operationalOnly = profileData({ factProvenance: 'operational-only' });
    assert.equal(reason([market()], operationalOnly).reason, 'REFERENCE_SIMULATED_NOT_ACCEPTED');
    const real = market({ provenance: { kind: 'operational', method: 'validated-ledger-book' } });
    assert.equal(reason([real], operationalOnly).outcome, 'SATISFIED');
  });

  it('two acceptable references that disagree are a conflict — no winner is picked; agreeing ones are fine', () => {
    const second = market({ sourceReference: 'fixture-book-101', price: { numerator: 201n, denominator: 100n } });
    assert.equal(reason([market(), second]).reason, 'REFERENCE_CONFLICT');
    assert.equal(reason([market(), market({ sourceReference: 'fixture-book-102' })]).outcome, 'SATISFIED');
  });

  it("the applicant's referenceContextId is a reference, never a price: it changes nothing about which snapshot is trusted", () => {
    const evidence = evidenceOf({ proposal: proposal({ referenceContextId: 'fixture-book-100' }), facts: { marketPrices: [] } });
    assert.equal(controlOf(evidence, 'REFERENCE_PRICE').outcome, 'UNAVAILABLE');
  });
});

describe('Matrix 9 — XLS-75 delegation reliance (scenarios I, J)', () => {
  it('I: a missing delegation assessment gives no positive delegation fact', () => {
    const input = riskInput();
    const evidence = assessTradingRisk({ ...input, facts: { ...input.facts, delegation: undefined } });
    assert.ok(evidence.assessed);
    if (!evidence.assessed) return;
    assert.deepEqual(controlOf(evidence.evidence, 'DELEGATION_VERIFIED'), { outcome: 'UNAVAILABLE', reason: 'DELEGATION_EVIDENCE_MISSING' });
    assert.equal(evidence.evidence.outcome, 'UNAVAILABLE');
  });

  it('a ledger observation proving no delegation (absent entry) is VIOLATED', () => {
    const { permissions: _p, previousTxnId: _t, previousTxnLedgerIndex: _l, ...absent } = grantedObservation({ state: 'absent' });
    const evidence = evidenceOf({ facts: { delegation: delegationFor(proposal(), { outcome: 'observed', observation: absent }) } });
    assert.equal(controlOf(evidence, 'DELEGATION_VERIFIED').outcome, 'VIOLATED');
  });

  it('J: an unavailable reader is UNAVAILABLE — never AUTHORIZED, never VIOLATED', () => {
    const evidence = evidenceOf({ facts: { delegation: delegationFor(proposal(), { outcome: 'unavailable', failure: 'TRANSPORT_UNAVAILABLE' }) } });
    assert.equal(controlOf(evidence, 'DELEGATION_VERIFIED').outcome, 'UNAVAILABLE');
  });

  it('a stale, forged, other-proposal or other-organization delegation assessment is refused', () => {
    assert.equal(controlOf(evidenceOf({ at: later(8) }), 'DELEGATION_VERIFIED').reason, 'DELEGATION_RELIANCE_STALE');
    const forged = { ...delegationFor(), status: 'AUTHORIZED', reason: 'DELEGATION_VERIFIED', source: { sourceId: 'agent' } };
    assert.equal(controlOf(evidenceOf({ facts: { delegation: forged } }), 'DELEGATION_VERIFIED').reason, 'DELEGATION_RELIANCE_DIGEST_MISMATCH');
    assert.equal(controlOf(evidenceOf({ facts: { delegation: { delegationVerified: true } } }), 'DELEGATION_VERIFIED').outcome, 'UNAVAILABLE', 'SEC-TRADE03-06: a bare claim is nothing');
    const otherProposal = delegationFor(proposal({ idempotencyKey: 'offer-0002' }));
    assert.equal(controlOf(evidenceOf({ facts: { delegation: otherProposal } }), 'DELEGATION_VERIFIED').reason, 'DELEGATION_RELIANCE_PROPOSAL_MISMATCH');
    const otherOrg = delegationFor(proposal({ organizationId: OTHER_ORG }));
    assert.equal(controlOf(evidenceOf({ facts: { delegation: otherOrg } }), 'DELEGATION_VERIFIED').reason, 'DELEGATION_RELIANCE_ORGANIZATION_MISMATCH');
    const otherSource = delegationFor(proposal(), undefined, AT, { sourceId: 'another-reader', maxAgeSeconds: 10 });
    assert.equal(controlOf(evidenceOf({ facts: { delegation: otherSource } }), 'DELEGATION_VERIFIED').reason, 'DELEGATION_RELIANCE_SOURCE_MISMATCH');
  });
});

describe('Matrix 10 — aggregate exposure prerequisites (scenarios L, M)', () => {
  const exposureControl = (snapshot: unknown, extra: Partial<Parameters<typeof riskInput>[0]> = {}) => controlOf(evidenceOf({ facts: { exposure: snapshot }, ...extra }), 'EXPOSURE_CEILING');

  it('no exposure, below, exactly at and above the ceiling (100 000 XRP; this order adds 200)', () => {
    assert.equal(exposureControl(exposure({ currentExposure: '0' })).outcome, 'SATISFIED');
    assert.equal(exposureControl(exposure({ currentExposure: '99799.999999' })).outcome, 'SATISFIED');
    assert.equal(exposureControl(exposure({ currentExposure: '99000', pendingExposure: '500', activeOrderExposure: '300' })).outcome, 'SATISFIED', 'exactly 100 000');
    assert.deepEqual(exposureControl(exposure({ currentExposure: '99000', pendingExposure: '500', activeOrderExposure: '300.000001' })), { outcome: 'VIOLATED', reason: 'EXPOSURE_CEILING_EXCEEDED' });
    assert.deepEqual(exposureControl(exposure({ capacityRemaining: '199.999999' })), { outcome: 'VIOLATED', reason: 'EXPOSURE_CAPACITY_EXCEEDED' });
  });

  it('L: a missing exposure snapshot is UNAVAILABLE', () => {
    const input = riskInput();
    const result = assessTradingRisk({ ...input, facts: { ...input.facts, exposure: undefined } });
    assert.ok(result.assessed);
    if (result.assessed) assert.deepEqual(controlOf(result.evidence, 'EXPOSURE_CEILING'), { outcome: 'UNAVAILABLE', reason: 'EXPOSURE_SNAPSHOT_MISSING' });
  });

  it('incomplete, stale, behind-the-pin, wrong-organization, wrong-owner, wrong-bucket, wrong-denomination and unaccepted-source snapshots are UNAVAILABLE', () => {
    assert.equal(exposureControl(exposure({ complete: false })).reason, 'EXPOSURE_SNAPSHOT_INCOMPLETE');
    assert.equal(exposureControl(exposure({ observedAt: '2026-10-13T11:59:00.000Z' })).reason, 'EXPOSURE_STALE');
    assert.equal(controlOf(assessOk({ ...riskInput(), pins: { minimumValidatedLedgerIndex: 101 } }), 'EXPOSURE_CEILING').reason, 'EXPOSURE_LEDGER_BEHIND');
    assert.equal(exposureControl(exposure({ organizationId: OTHER_ORG })).reason, 'EXPOSURE_ORGANIZATION_MISMATCH');
    assert.equal(exposureControl(exposure({ ownerAccount: STRANGER_OWNER })).reason, 'EXPOSURE_SCOPE_MISMATCH');
    assert.equal(exposureControl(exposure({ riskBucket: 'other-bucket' })).reason, 'EXPOSURE_RISK_BUCKET_MISMATCH');
    assert.equal(exposureControl(exposure({ denomination: { kind: 'issued', currency: RLUSD, issuer: ISSUER } })).reason, 'EXPOSURE_DENOMINATION_MISMATCH');
    assert.equal(exposureControl(exposure({ sourceId: 'agent-ledger' })).reason, 'EXPOSURE_SOURCE_NOT_ACCEPTED');
    assert.equal(exposureControl({ ...tradeExposureSnapshotData(exposure()), currentExposure: '0' }).reason, 'EXPOSURE_SNAPSHOT_MALFORMED', 'altered after sealing');
  });

  it('M: two concurrent orders that each fit the remaining capacity both pass a snapshot check — so no aggregate safety is claimed (SEC-TRADE03-18)', () => {
    // 100 000 ceiling, 99 700 committed: 300 remains. Two agents each place an order adding 200 against the same snapshot.
    const shared = exposure({ currentExposure: '99700', capacityRemaining: '300' });
    const agentA = evidenceOf({ proposal: sell('100', '200000000', { idempotencyKey: 'offer-a', requestId: 'req-a' }), facts: { exposure: shared } });
    const agentB = evidenceOf({ proposal: sell('100', '200000000', { idempotencyKey: 'offer-b', requestId: 'req-b' }), facts: { exposure: shared } });
    assert.equal(controlOf(agentA, 'EXPOSURE_CEILING').outcome, 'SATISFIED');
    assert.equal(controlOf(agentB, 'EXPOSURE_CEILING').outcome, 'SATISFIED');
    // Jointly 99 700 + 400 = 100 100 > 100 000. The evidence never says otherwise:
    for (const evidence of [agentA, agentB]) {
      assert.equal(controlOf(evidence, 'EXPOSURE_CEILING').reason, 'EXPOSURE_WITHIN_CEILING_SNAPSHOT');
      assert.ok(evidence.limitations.includes('AGGREGATE_EXPOSURE_NOT_RESERVED'));
    }
  });
});

function assessOk(input: ReturnType<typeof riskInput>): TradingRiskAssessmentEvidence {
  const result = assessTradingRisk(input);
  if (!result.assessed) assert.fail(result.refusal);
  return result.evidence;
}

describe('Matrix 11 — active-order prerequisites', () => {
  const orderControl = (snapshot: unknown) => controlOf(evidenceOf({ facts: { activeOrders: snapshot } }), 'ACTIVE_ORDER_LIMIT');

  it('counts open offers plus pending and uncertain submissions, and this order: 4 of 5 passes, 5 of 5 passes, 6 of 5 fails', () => {
    assert.equal(orderControl(orders()).outcome, 'SATISFIED');
    assert.equal(orderControl(orders({ ledgerOpenOffers: 2, pendingSubmissions: 1, uncertainSubmissions: 1 })).outcome, 'SATISFIED');
    assert.deepEqual(orderControl(orders({ ledgerOpenOffers: 2, pendingSubmissions: 1, uncertainSubmissions: 2 })), { outcome: 'VIOLATED', reason: 'ACTIVE_ORDER_LIMIT_REACHED' }, 'an uncertain submission still occupies a slot');
  });

  it('a count for another scope key, an incomplete count, or a stale or unaccepted one is UNAVAILABLE — counts are never invented', () => {
    assert.equal(orderControl(orders({ scopeKey: `owner:${STRANGER_OWNER}` })).reason, 'ACTIVE_ORDER_SCOPE_MISMATCH');
    assert.equal(orderControl(orders({ scope: 'delegate', scopeKey: `delegate:${DELEGATE}` })).reason, 'ACTIVE_ORDER_SCOPE_MISMATCH');
    assert.equal(orderControl(orders({ complete: false })).reason, 'ACTIVE_ORDER_SNAPSHOT_INCOMPLETE');
    assert.equal(orderControl(orders({ observedAt: '2026-10-13T11:00:00.000Z' })).reason, 'ACTIVE_ORDER_STALE');
    assert.equal(orderControl(orders({ sourceId: 'agent' })).reason, 'ACTIVE_ORDER_SOURCE_NOT_ACCEPTED');
    assert.equal(orderControl({ ...tradeActiveOrderSnapshotData(orders()), ledgerOpenOffers: 0 }).reason, 'ACTIVE_ORDER_SNAPSHOT_MALFORMED');
  });
});

describe('Scenarios D–G, K — economic violations are prohibitions', () => {
  it('D amount, E sell floor, F buy ceiling, G deviation, K notional — each VIOLATED and PROHIBITED', () => {
    const cases: readonly [string, Record<string, unknown>, string][] = [
      ['D', sell('1000.5', '2001000000'), 'OWNER_GIVEN_AMOUNT_MAXIMUM'],
      ['E', sell('100', '180000000'), 'LIMIT_PRICE_BOUND'],
      ['F', buy('220000000', '100'), 'LIMIT_PRICE_BOUND'],
      ['G', sell('100', '207000000'), 'REFERENCE_DEVIATION'],
    ];
    for (const [label, raw, control] of cases) {
      const evidence = evidenceOf({ proposal: raw });
      assert.equal(controlOf(evidence, control).outcome, 'VIOLATED', label);
      assert.equal(evidence.outcome, 'VIOLATED', label);
      assert.equal(evidence.disposition, 'PROHIBITED', label);
      assert.deepEqual(evidence.approvalTriggers, [], `${label}: a prohibited order is never offered for approval`);
    }
    const highNotional = evidenceOf({ facts: { marketPrices: [market({ price: { numerator: 2001n, denominator: 100n } })] }, profile: profileData({}, { referenceDeviation: { mode: 'disabled', reason: 'test' }, approval: { restricted: false } }) });
    assert.equal(controlOf(highNotional, 'NOTIONAL_MAXIMUM').outcome, 'VIOLATED', 'K');
  });
});

describe('Scenario N — approval is a disposition of a satisfied order, never a way past a prohibition (SEC-TRADE03-16)', () => {
  it('notional above the review threshold, a restricted pair, a sensitive owner or delegate → APPROVAL_REQUIRED', () => {
    assert.deepEqual(evidenceOf({ proposal: sell('800', '1600000000') }).approvalTriggers, ['NOTIONAL_ABOVE_REVIEW_THRESHOLD']);
    assert.deepEqual(evidenceOf({ proposal: sell('100', '205000000') }).approvalTriggers, ['DEVIATION_ABOVE_REVIEW_THRESHOLD'], '250 bps > 200 bps review threshold, ≤ 300 maximum');
    assert.equal(evidenceOf({ profile: profileData({}, { approval: { restricted: true } }) }).disposition, 'APPROVAL_REQUIRED');
    const sensitive = evidenceOf({ profile: profileData({ approval: { sensitiveOwners: [OWNER], sensitiveDelegates: [DELEGATE] } }) });
    assert.deepEqual(sensitive.approvalTriggers, ['SENSITIVE_DELEGATE', 'SENSITIVE_OWNER']);
    assert.equal(sensitive.outcome, 'SATISFIED');
  });

  it('a restricted pair with an unavailable fact is WITHHELD, and with a violation PROHIBITED — never APPROVAL_REQUIRED', () => {
    const restricted = profileData({}, { approval: { restricted: true } });
    assert.equal(evidenceOf({ profile: restricted, facts: { marketPrices: [] } }).disposition, 'WITHHELD');
    assert.equal(evidenceOf({ profile: restricted, proposal: sell('100', '100000000') }).disposition, 'PROHIBITED');
  });
});

describe('SEC-TRADE03-04/05/22 — incomplete or untrusted evaluation never produces SATISFIED', () => {
  it('each missing fact alone withholds the whole assessment', () => {
    for (const key of ['delegation', 'marketPrices', 'exposure', 'activeOrders'] as const) {
      const input = riskInput();
      const result = assessTradingRisk({ ...input, facts: { ...input.facts, [key]: undefined } });
      assert.ok(result.assessed, key);
      if (result.assessed) assert.notEqual(result.evidence.outcome, 'SATISFIED', key);
    }
  });

  it('no facts at all, or facts that are not a record, is never SATISFIED', () => {
    for (const facts of [{}, null, 'trusted', []]) {
      const result = assessTradingRisk({ ...riskInput(), facts: facts as never });
      assert.ok(result.assessed);
      if (result.assessed) assert.equal(result.evidence.outcome, 'UNAVAILABLE', JSON.stringify(facts));
    }
  });

  it('an explicitly disabled control is recorded DISABLED with its reason, and a profile without it still checks the rest', () => {
    const evidence = evidenceOf({ profile: profileData({ activeOrders: { mode: 'disabled', reason: 'single-order-desk' } }) });
    assert.deepEqual(controlOf(evidence, 'ACTIVE_ORDER_LIMIT'), { outcome: 'DISABLED', reason: 'DISABLED:single-order-desk' });
    assert.equal(evidence.outcome, 'SATISFIED');
    assert.equal(evidence.limitations.includes('ACTIVE_ORDERS_NOT_RESERVED'), false);
  });

  it('invalid inputs that do not identify an assessment yield no evidence', () => {
    assert.deepEqual(assessTradingRisk({ ...riskInput(), assessedAt: 'now' }), { assessed: false, refusal: AR.CLOCK_INVALID });
    assert.deepEqual(assessTradingRisk({ ...riskInput(), binding: { action: '' } }), { assessed: false, refusal: AR.BINDING_INVALID });
    assert.deepEqual(assessTradingRisk({ ...riskInput(), proposal: { ...proposal(), schema: 'frontera.trade-proposal.v2' } }), { assessed: false, refusal: AR.PROPOSAL_INVALID });
    assert.deepEqual(assessTradingRisk({ ...riskInput(), pins: { minimumValidatedLedgerIndex: -1 } }), { assessed: false, refusal: AR.INPUT_INVALID });
    assert.deepEqual(assessTradingRisk(null as never), { assessed: false, refusal: AR.INPUT_INVALID });
  });
});

describe('Matrix 18 — evidence integrity: the digest moves with everything material', () => {
  it('changes with proposal economics, policy version, trusted facts, delegation evidence and source evidence', () => {
    const base = evidenceOf().digest;
    const variants = [
      evidenceOf({ proposal: sell('100', '200000001') }),
      evidenceOf({ profile: profileData({ profileVersion: 4 }) }),
      evidenceOf({ facts: { marketPrices: [market({ price: { numerator: 201n, denominator: 100n } })] } }),
      evidenceOf({ facts: { delegation: delegationFor(proposal(), { outcome: 'observed', observation: grantedObservation({ validatedLedgerIndex: 101 }) }) } }),
      evidenceOf({ facts: { exposure: exposure({ sourceReference: 'fixture-inventory-101' }) } }),
      evidenceOf({ at: later(1) }),
    ];
    for (const [index, variant] of variants.entries()) assert.notEqual(variant.digest, base, `variant ${index}`);
  });
});

describe('Reliance — scenarios P, Q, R and replay (SEC-TRADE03-09/19/23)', () => {
  const expectation = (overrides: Record<string, unknown> = {}) => ({ proposal: proposal(), profile: profileData(), at: later(2), governanceProfile: { id: 'governed-trading', version: 1 }, ...overrides });

  it('a satisfied, intact, fresh, bound record is reliable for the profile’s window and no longer', () => {
    const evidence = evidenceOf();
    const reliance = checkTradingRiskReliance(evidence, expectation());
    assert.equal(reliance.reliable, true, JSON.stringify(reliance));
    if (reliance.reliable) assert.equal(reliance.disposition, 'ELIGIBLE');
    // The delegation observation (12:00:05, 10 s) expires first, at 12:00:15 — before the 30 s assessment window.
    assert.deepEqual(checkTradingRiskReliance(evidence, expectation({ at: later(8) })), { reliable: false, code: RR.FACT_STALE });
    const longLived = evidenceOf({ facts: { delegation: delegationFor(proposal(), { outcome: 'observed', observation: grantedObservation({ observedAt: AT }) }) } });
    assert.equal(checkTradingRiskReliance(longLived, expectation({ at: later(9) })).reliable, true);
    assert.deepEqual(checkTradingRiskReliance(longLived, expectation({ at: later(-1) })), { reliable: false, code: RR.FROM_FUTURE });
  });

  it('P: evidence for one proposal is refused for a proposal with changed economics, delegate or idempotency key', () => {
    const evidence = evidenceOf();
    for (const changed of [sell('100', '200000001'), proposal({ delegateAccount: STRANGER_DELEGATE }), proposal({ idempotencyKey: 'offer-9999' })]) {
      assert.deepEqual(checkTradingRiskReliance(evidence, expectation({ proposal: changed })), { reliable: false, code: RR.PROPOSAL_MISMATCH });
    }
  });

  it('Q: evidence of organization A is refused for organization B, whatever profile B presents', () => {
    const evidence = evidenceOf();
    const orgB = expectation({ proposal: proposal({ organizationId: OTHER_ORG }), profile: profileData({ organizationId: OTHER_ORG }) });
    assert.deepEqual(checkTradingRiskReliance(evidence, orgB), { reliable: false, code: RR.ORGANIZATION_MISMATCH });
  });

  it('R: evidence assessed under an older profile version — or a same-version profile with changed content — is not current compliance', () => {
    const evidence = evidenceOf();
    assert.deepEqual(checkTradingRiskReliance(evidence, expectation({ profile: profileData({ profileVersion: 4 }) })), { reliable: false, code: RR.PROFILE_MISMATCH });
    assert.deepEqual(checkTradingRiskReliance(evidence, expectation({ profile: profileData({}, { maxBaseQuantity: '999' }) })), { reliable: false, code: RR.PROFILE_MISMATCH });
    assert.deepEqual(checkTradingRiskReliance(evidence, expectation({ profile: profileData({ status: 'suspended' }) })), { reliable: false, code: RR.PROFILE_MISMATCH }, 'a status change is a content change');
    assert.deepEqual(checkTradingRiskReliance(evidence, expectation({ governanceProfile: { id: 'governed-trading', version: 2 } })), { reliable: false, code: RR.GOVERNANCE_PROFILE_MISMATCH });
  });

  it('tampered, forged or non-satisfied evidence is refused', () => {
    const evidence = evidenceOf();
    assert.deepEqual(checkTradingRiskReliance({ ...evidence, outcome: 'SATISFIED', quantity: '1' }, expectation()), { reliable: false, code: RR.DIGEST_MISMATCH });
    const violated = evidenceOf({ proposal: sell('100', '100000000') });
    assert.deepEqual(checkTradingRiskReliance(violated, expectation({ proposal: sell('100', '100000000') })), { reliable: false, code: RR.NOT_SATISFIED });
    const withheld = evidenceOf({ facts: { marketPrices: [] } });
    assert.deepEqual(checkTradingRiskReliance(withheld, expectation()), { reliable: false, code: RR.NOT_SATISFIED });
    const getter = { ...evidence };
    Object.defineProperty(getter, 'outcome', { get: () => 'SATISFIED', enumerable: true });
    assert.deepEqual(checkTradingRiskReliance(getter, expectation()), { reliable: false, code: RR.MALFORMED });
    assert.deepEqual(checkTradingRiskReliance('SATISFIED', expectation()), { reliable: false, code: RR.MALFORMED });
  });

  it('a record whose controls were satisfied under a profile that disabled one is not reliable once the current profile enforces it', () => {
    const disabledProfile = profileData({ activeOrders: { mode: 'disabled', reason: 'single-order-desk' } });
    const evidence = evidenceOf({ profile: disabledProfile });
    assert.equal(checkTradingRiskReliance(evidence, expectation({ profile: disabledProfile })).reliable, true);
    assert.equal(checkTradingRiskReliance(evidence, expectation()).reliable, false);
  });

  it('a simulated-fact record is not reliable where the current profile admits operational facts only', () => {
    const evidence = evidenceOf();
    const result = checkTradingRiskReliance(evidence, expectation({ profile: profileData({ factProvenance: 'operational-only' }) }));
    assert.equal(result.reliable, false);
  });
});

describe('CORE-04 projection — readings bound to the proposal digest, governed leg and query, or no reading at all', () => {
  const expectation = (overrides: Record<string, unknown> = {}) => ({ proposal: proposal(), profile: profileData(), at: later(1), ...overrides });
  const QUERY = { action: 'trade.offer-create', resourceScope: `xrp-ledger-testnet:${OWNER}`, organizationId: ORG };
  const DELEGATION = { proposal: proposal(), at: later(1), policy: DELEGATION_POLICY, action: 'trade.offer-create' };

  it('a reliable record projects the full intent binding — seven parameters, governed amount and asset — plus profile and review flag, living no longer than its evidence', () => {
    const projection = tradingRiskContextReadings(evidenceOf(), expectation(), QUERY);
    assert.ok(projection.projected, JSON.stringify(projection));
    if (!projection.projected) return;
    const byKey = new Map(projection.readings.map((reading) => [reading.key, reading]));
    assert.deepEqual([...byKey.keys()].sort(), Object.values(TRADE_RISK_FACT_CLASSES).filter((key) => key !== TRADE_RISK_FACT_CLASSES.delegation).sort());
    // Each parameter reading equals the compiled intent's parameter exactly.
    const intent = compileTradeProposal(proposal(), createTradeGovernanceBinding({ action: 'trade.offer-create' }), { organizationId: ORG, principalId: 'agent-mm-01' }).intent;
    for (const [dimension, key] of Object.entries(TRADE_INTENT_BINDING_FACTS)) assert.equal(byKey.get(key)?.value, intent.parameters[dimension], dimension);
    assert.equal(byKey.get(TRADE_RISK_FACT_CLASSES.assessedSide)?.value, 'sell');
    assert.equal(byKey.get(TRADE_RISK_FACT_CLASSES.assessedQuantity)?.value, '100');
    assert.equal(byKey.get(TRADE_RISK_FACT_CLASSES.assessedDelegate)?.value, DELEGATE);
    assert.equal(byKey.get(TRADE_RISK_FACT_CLASSES.assessedProposal)?.value, accepted().digest);
    assert.equal(byKey.get(TRADE_RISK_FACT_CLASSES.assessedAmount)?.value, '100', 'what the owner gives up (TakerGets), as the compiled intent states it');
    assert.equal(byKey.get(TRADE_RISK_FACT_CLASSES.assessedAsset)?.value, `xrp-ledger-testnet:${RLUSD}/${ISSUER}`);
    assert.equal(byKey.get(TRADE_RISK_FACT_CLASSES.profile)?.value, 'mm-desk@3');
    assert.equal(byKey.get(TRADE_RISK_FACT_CLASSES.approvalRequired)?.value, false);
    // Observed now (12:00:09); the delegation fact inside expires at 12:00:15 → 6 s.
    for (const reading of projection.readings) assert.equal(reading.maxAgeSeconds, 6);
  });

  it('no reading is projected for a violated, withheld, stale, tampered or other-proposal record', () => {
    assert.equal(tradingRiskContextReadings(evidenceOf({ proposal: sell('100', '100000000') }), expectation({ proposal: sell('100', '100000000') }), QUERY).projected, false);
    assert.equal(tradingRiskContextReadings(evidenceOf({ facts: { marketPrices: [] } }), expectation(), QUERY).projected, false);
    assert.equal(tradingRiskContextReadings(evidenceOf(), expectation({ at: later(30) }), QUERY).projected, false);
    assert.equal(tradingRiskContextReadings(evidenceOf(), expectation({ proposal: proposal({ idempotencyKey: 'offer-9' }) }), QUERY).projected, false);
  });

  it('no reading answers a query for another owner resource, another action or another organization', () => {
    for (const query of [{ ...QUERY, resourceScope: `xrp-ledger-testnet:${STRANGER_OWNER}` }, { ...QUERY, resourceScope: `xrp-ledger-devnet:${OWNER}` }, { ...QUERY, action: 'trade.offer-cancel' }, { ...QUERY, organizationId: OTHER_ORG }]) {
      assert.deepEqual(tradingRiskContextReadings(evidenceOf(), expectation(), query), { projected: false, code: 'RISK_PROJECTION_QUERY_MISMATCH' }, JSON.stringify(query));
      assert.equal(tradeDelegationContextReading(delegationFor(), DELEGATION, query).projected, false);
    }
  });

  it('the delegation reading exists only for an AUTHORIZED, bound, fresh TRADE-02 assessment', () => {
    const reading = tradeDelegationContextReading(delegationFor(), DELEGATION, QUERY);
    assert.ok(reading.projected);
    if (reading.projected) {
      assert.equal(reading.reading.key, TRADE_RISK_FACT_CLASSES.delegation);
      assert.equal(reading.reading.value, accepted().digest);
      assert.equal(reading.reading.maxAgeSeconds, 6);
    }
    const unavailable = delegationFor(proposal(), { outcome: 'unavailable', failure: 'TIMEOUT' });
    assert.equal(tradeDelegationContextReading(unavailable, DELEGATION, QUERY).projected, false);
    assert.equal(tradeDelegationContextReading(delegationFor(), { ...DELEGATION, proposal: proposal({ idempotencyKey: 'offer-2' }) }, QUERY).projected, false);
    assert.equal(tradeDelegationContextReading(delegationFor(proposal({ organizationId: OTHER_ORG })), DELEGATION, QUERY).projected, false);
    assert.equal(tradeDelegationContextReading(delegationFor(), { ...DELEGATION, at: later(8) }, QUERY).projected, false);
  });
});
