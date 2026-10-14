import assert from 'node:assert/strict';

import {
  TRADE_DELEGATION_OBSERVATION_SCHEMA,
  TRADE_PROPOSAL_SCHEMA,
  TRADING_RISK_PROFILE_SCHEMA,
  assessTradeDelegation,
  assessTradingRisk,
  parseTradeDelegationPolicy,
  sealTradeActiveOrderSnapshot,
  sealTradeExposureSnapshot,
  sealTrustedMarketPriceSnapshot,
  tradeDelegateEntryIndex,
  tradeDelegationRequestFor,
  validateTradeProposal,
} from '../index.js';
import type {
  AcceptedTradeProposal,
  TradeActiveOrderReading,
  TradeAsset,
  TradeDelegationAssessment,
  TradeDelegationPolicy,
  TradeExposureReading,
  TradingRiskAssessmentEvidence,
  TradingRiskAssessmentInput,
  TrustedMarketPriceReading,
  TrustedMarketPriceSnapshot,
} from '../index.js';

/**
 * TRADE-03 deterministic world: one organization's market-making desk on XRP
 * Ledger Testnet, an RLUSD-style issued token (fixture issuer) against XRP,
 * a trusted risk profile, and **fake trusted sources** — every market,
 * exposure and order reading below is a fixture marked `simulated`. Nothing
 * here reads a ledger or a market, signs, submits or executes.
 *
 * Canonical orientation (TRADE-01): XRP is always the quote, so the pair is
 * RLUSD/XRP and every price is **XRP per RLUSD**. The fixture reference is
 * 2 XRP per RLUSD (= 0.50 RLUSD per XRP).
 */

export const ORG = 'org-acme';
export const OTHER_ORG = 'org-rival';
export const ACTION = 'trade.offer-create';
export const OWNER = 'rf1BiGeXwwQoi8Z2ueFYTEXSwuJYfV2Jpn';
export const DELEGATE = 'ra5nK24KXen9AHvsdFTKHSANinZseWnPcX';
export const ISSUER = 'rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B';
export const ISSUER_B = 'rhub8VRN55s94qWKDv6jmDy1pUykJzF3wq';
export const STRANGER_OWNER = 'rG8uoRH9uA6AJ6NRj8P4cJG1HNfYcnMPrt';
export const STRANGER_DELEGATE = 'r9GAKojMTyexqvy8DXFWYq63Mod5k5wnkT';
/** `RLUSD` as a 160-bit currency code. */
export const RLUSD = '524C555344000000000000000000000000000000';

export const RLUSD_ASSET = Object.freeze({ currency: RLUSD, issuer: ISSUER });
export const XRP_ASSET = Object.freeze({ currency: 'XRP' });
export const RLUSD_TRADE_ASSET: TradeAsset = Object.freeze({ kind: 'issued', currency: RLUSD, issuer: ISSUER });
export const XRP_TRADE_ASSET: TradeAsset = Object.freeze({ kind: 'xrp' });

export const OBSERVED = '2026-10-13T12:00:05.000Z';
export const AT = '2026-10-13T12:00:08.000Z';
export const DELEGATION_POLICY = { sourceId: 'xrpl-testnet-reader', maxAgeSeconds: 10 } as const;

/** Sell 100 RLUSD for 200 XRP: side sell, quantity 100, limit price 2 XRP/RLUSD. */
export function proposal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: TRADE_PROPOSAL_SCHEMA,
    organizationId: ORG,
    principalId: 'agent-mm-01',
    requestId: 'req-0001',
    idempotencyKey: 'offer-0001',
    network: 'xrp-ledger-testnet',
    ownerAccount: OWNER,
    delegateAccount: DELEGATE,
    permission: 'OfferCreate',
    takerGets: { currency: RLUSD, issuer: ISSUER, value: '100' },
    takerPays: { currency: 'XRP', drops: '200000000' },
    flags: ['passive'],
    requestedValiditySeconds: 60,
    ...overrides,
  };
}

/** Buy 100 RLUSD paying `xrp` XRP. */
export function buy(xrpDrops = '200000000', rlusd = '100', overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return proposal({ takerGets: { currency: 'XRP', drops: xrpDrops }, takerPays: { currency: RLUSD, issuer: ISSUER, value: rlusd }, ...overrides });
}

/** Sell `rlusd` RLUSD for `xrpDrops`. */
export function sell(rlusd = '100', xrpDrops = '200000000', overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return proposal({ takerGets: { currency: RLUSD, issuer: ISSUER, value: rlusd }, takerPays: { currency: 'XRP', drops: xrpDrops }, ...overrides });
}

export function accepted(raw: unknown = proposal()): AcceptedTradeProposal {
  const result = validateTradeProposal(raw);
  if (!result.valid) assert.fail(JSON.stringify(result.violations));
  return result.accepted;
}

export function pairData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pairId: 'rlusd-xrp',
    base: RLUSD_ASSET,
    quote: XRP_ASSET,
    sides: ['buy', 'sell'],
    maxBaseQuantity: '1000',
    maxOwnerGiven: { buy: '2500', sell: '1000' },
    minSellPrice: { numerator: '19', denominator: '10' },
    maxBuyPrice: { numerator: '21', denominator: '10' },
    priceBand: { mode: 'enforce', floor: { numerator: '1', denominator: '1' }, ceiling: { numerator: '3', denominator: '1' } },
    referenceDeviation: { mode: 'enforce', maxBasisPoints: 300, rule: 'symmetric' },
    notional: { mode: 'enforce', valuationAsset: XRP_ASSET, maximum: '2000' },
    approval: { restricted: false, notionalAbove: '1500', deviationAboveBasisPoints: 200 },
    ...overrides,
  };
}

export function profileData(overrides: Record<string, unknown> = {}, pair: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: TRADING_RISK_PROFILE_SCHEMA,
    organizationId: ORG,
    profileId: 'mm-desk',
    profileVersion: 3,
    status: 'active',
    effectiveFrom: '2026-10-01T00:00:00.000Z',
    expiresAt: '2026-12-31T00:00:00.000Z',
    action: ACTION,
    network: 'xrp-ledger-testnet',
    ownerAccounts: [OWNER],
    delegateAccounts: [DELEGATE],
    allowedFlags: ['passive'],
    factProvenance: 'simulated-permitted',
    assessmentMaxAgeSeconds: 30,
    delegation: DELEGATION_POLICY,
    marketReference: { mode: 'enforce', sourceIds: ['fixture-market'], conventions: ['mid'], maxAgeSeconds: 30 },
    exposure: { mode: 'enforce', riskBucket: 'mm-inventory', denomination: XRP_ASSET, ceiling: '100000', sourceIds: ['fixture-exposure'], maxAgeSeconds: 30, concurrency: 'snapshot-advisory' },
    activeOrders: { mode: 'enforce', scope: 'owner', maximum: 5, sourceIds: ['fixture-orders'], maxAgeSeconds: 30, concurrency: 'snapshot-advisory' },
    approval: { sensitiveOwners: [], sensitiveDelegates: [] },
    pairs: [pairData(pair)],
    ...overrides,
  };
}

export function marketReading(overrides: Partial<TrustedMarketPriceReading> = {}): TrustedMarketPriceReading {
  return {
    sourceId: 'fixture-market',
    organizationId: ORG,
    network: 'xrp-ledger-testnet',
    base: RLUSD_TRADE_ASSET,
    quote: XRP_TRADE_ASSET,
    price: { numerator: 2n, denominator: 1n },
    convention: 'mid',
    observedAt: OBSERVED,
    maxAgeSeconds: 30,
    sourceReference: 'fixture-book-100',
    provenance: { kind: 'simulated', method: 'fixture' },
    ...overrides,
  };
}

export const market = (overrides: Partial<TrustedMarketPriceReading> = {}): TrustedMarketPriceSnapshot => sealTrustedMarketPriceSnapshot(marketReading(overrides));

export function exposureReading(overrides: Partial<TradeExposureReading> = {}): TradeExposureReading {
  return {
    sourceId: 'fixture-exposure',
    organizationId: ORG,
    network: 'xrp-ledger-testnet',
    ownerAccount: OWNER,
    riskBucket: 'mm-inventory',
    denomination: XRP_TRADE_ASSET,
    currentExposure: '1000',
    pendingExposure: '0',
    activeOrderExposure: '0',
    capacityRemaining: '99000',
    validatedLedgerIndex: 100,
    complete: true,
    observedAt: OBSERVED,
    maxAgeSeconds: 30,
    sourceReference: 'fixture-inventory-100',
    provenance: { kind: 'simulated', method: 'fixture' },
    ...overrides,
  };
}

export function ordersReading(overrides: Partial<TradeActiveOrderReading> = {}): TradeActiveOrderReading {
  return {
    sourceId: 'fixture-orders',
    organizationId: ORG,
    network: 'xrp-ledger-testnet',
    scope: 'owner',
    scopeKey: `owner:${OWNER}`,
    ledgerOpenOffers: 2,
    pendingSubmissions: 1,
    uncertainSubmissions: 0,
    validatedLedgerIndex: 100,
    complete: true,
    observedAt: OBSERVED,
    maxAgeSeconds: 30,
    sourceReference: 'fixture-orders-100',
    provenance: { kind: 'simulated', method: 'fixture' },
    ...overrides,
  };
}

export function grantedObservation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: TRADE_DELEGATION_OBSERVATION_SCHEMA,
    network: 'xrp-ledger-testnet',
    networkId: 1,
    validatedLedgerIndex: 100,
    validatedLedgerHash: 'C'.repeat(64),
    owner: OWNER,
    delegate: DELEGATE,
    entryIndex: tradeDelegateEntryIndex(OWNER, DELEGATE),
    observedAt: OBSERVED,
    state: 'granted',
    permissions: ['OfferCreate'],
    previousTxnId: 'A'.repeat(64),
    previousTxnLedgerIndex: 90,
    ...overrides,
  };
}

/** A TRADE-02 assessment for `raw`, produced by TRADE-02's own assessor over a fake read. */
export function delegationFor(raw: unknown = proposal(), read: unknown = { outcome: 'observed', observation: grantedObservation() }, assessedAt = AT, policy: TradeDelegationPolicy = DELEGATION_POLICY): TradeDelegationAssessment {
  const proposalAccepted = accepted(raw);
  const request = tradeDelegationRequestFor(proposalAccepted.proposal, proposalAccepted.digest);
  assert.ok(request.valid);
  return assessTradeDelegation({ request: request.request, policy: parseTradeDelegationPolicy(policy) as TradeDelegationPolicy, read: read as never, assessedAt });
}

export interface WorldOptions {
  readonly proposal?: Record<string, unknown>;
  readonly profile?: unknown;
  readonly facts?: Partial<TradingRiskAssessmentInput['facts']>;
  readonly at?: string;
  readonly identity?: { readonly organizationId: string; readonly principalId: string };
}

/** The complete, trusted input for one assessment; any part can be replaced. */
export function riskInput(options: WorldOptions = {}): TradingRiskAssessmentInput {
  const raw = options.proposal ?? proposal();
  return {
    proposal: raw,
    identity: options.identity ?? { organizationId: ORG, principalId: 'agent-mm-01' },
    binding: { action: ACTION },
    profile: options.profile ?? profileData(),
    facts: {
      delegation: delegationFor(raw),
      marketPrices: [market()],
      exposure: sealTradeExposureSnapshot(exposureReading()),
      activeOrders: sealTradeActiveOrderSnapshot(ordersReading()),
      ...options.facts,
    },
    governanceProfile: { id: 'governed-trading', version: 1 },
    assessedAt: options.at ?? AT,
  };
}

export function evidenceOf(options: WorldOptions = {}): TradingRiskAssessmentEvidence {
  const result = assessTradingRisk(riskInput(options));
  if (!result.assessed) assert.fail(`not assessed: ${result.refusal}`);
  return result.evidence;
}

/** The outcome and reason of one control. */
export function controlOf(evidence: TradingRiskAssessmentEvidence, control: string): { readonly outcome: string; readonly reason: string } {
  const found = evidence.controls.find((entry) => entry.control === control);
  assert.ok(found !== undefined, control);
  return { outcome: found.outcome, reason: found.reason };
}
