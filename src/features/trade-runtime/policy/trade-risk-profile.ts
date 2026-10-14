import type { TradeAsset } from '../domain/trade-asset.js';
import { tradeAssetsEqual } from '../domain/trade-asset.js';
import { isTradeInstant } from '../domain/trade-delegation.js';
import { parseTradeDelegationPolicy, type TradeDelegationPolicy } from '../domain/trade-delegation-assessment.js';
import { checkTradeAccountAddress, isTradeIdentifier, isTradeNetwork, type TradeNetwork } from '../domain/trade-grammar.js';
import type { TradePrice } from '../domain/trade-price.js';
import { TRADE_OFFER_FLAGS, canonicalTradePair, type TradeOfferFlag, type TradeSide } from '../domain/trade-proposal.js';
import {
  assetRecord,
  closedRecord,
  compareRationals,
  isSafeIntegerIn,
  millisecondsBetween,
  parsePositiveRiskDecimal,
  parseRiskAsset,
  parseRiskPrice,
  plainList,
  priceRecord,
  rationalOfDecimal,
  sealRiskRecord,
  tradeAssetToken,
  unsealRiskRecord,
} from './trade-risk-exact.js';

/**
 * The trading-risk profile (TRADE-03): an owner's granular risk constraints
 * for delegated OfferCreate, as **trusted, versioned, immutable configuration**.
 *
 * It is a domain contract, not a Governance Profile and not a policy: it does
 * not decide and cannot grant. It states what the risk assessment checks; the
 * Governance Core decides, on facts the Trusted Context Boundary admits.
 *
 * ## Strict, closed, never repaired
 *
 * Every record is closed and read once. Limits are canonical positive decimal
 * text, prices positive integer rationals (quote per base), ages and counts
 * safe integers in a stated range. Anything else is refused with a code and a
 * field — never clamped, defaulted or re-spelled.
 *
 * ## No permissive defaults
 *
 * Every safety-critical control is a required key. A control that may be
 * switched off is switched off only by stating `{ mode: 'disabled', reason }`
 * in the trusted configuration, and the assessment then records it as
 * `DISABLED` — never as satisfied. Pairs and issuers, owner and delegate
 * scope, sides, flags, the owner-given amount, the base quantity and the
 * XLS-75 delegation check can **not** be disabled.
 *
 * ## Applicant cannot choose it
 *
 * The profile is passed to the assessment by the trusted composition; nothing
 * in a proposal names or selects it. The sealed `digest` binds the exact
 * content, so a reliance check can tell an assessment made under another
 * version — or another organization's profile — from one made under this one.
 */

export const TRADING_RISK_PROFILE_SCHEMA = 'frontera.trading-risk-profile.v1';
export const TRADING_RISK_PROFILE_DIGEST_DOMAIN = 'frontera.trading-risk-profile-digest.v1';

/** Longest validity horizon of one profile version. */
export const TRADING_RISK_PROFILE_MAXIMUM_HORIZON_SECONDS = 400 * 24 * 3600;
/** Upper bound for a market, exposure or order-inventory reading's age. */
export const TRADING_RISK_MAXIMUM_FACT_AGE_SECONDS = 3600;
/** Upper bound for how long one assessment may be relied on after it is made. */
export const TRADING_RISK_MAXIMUM_ASSESSMENT_AGE_SECONDS = 300;
const MAXIMUM_ACCOUNTS = 64;
const MAXIMUM_PAIRS = 32;
const MAXIMUM_SOURCES = 8;
const MAXIMUM_ACTIVE_ORDERS = 10_000;

export type TradeRiskProfileStatus = 'active' | 'suspended' | 'retired';
export type TradeReferenceConvention = 'mid' | 'bid' | 'ask' | 'consolidated';
export const TRADE_REFERENCE_CONVENTIONS: readonly TradeReferenceConvention[] = Object.freeze(['ask', 'bid', 'consolidated', 'mid']);
export type TradeFactProvenancePolicy = 'operational-only' | 'simulated-permitted';
export type TradeDeviationRule = 'symmetric' | 'adverse';
export type TradeActiveOrderScope = 'organization' | 'owner' | 'owner-pair' | 'delegate';

/** An explicitly disabled control. The reason is an identifier recorded in evidence. */
export interface TradeRiskControlDisabled {
  readonly mode: 'disabled';
  readonly reason: string;
}

export interface TradeMarketReferencePolicy {
  readonly mode: 'enforce';
  /** Trusted market sources whose snapshots are accepted, sorted. */
  readonly sourceIds: readonly string[];
  /** Reference conventions accepted, sorted. A mid-market price is a reference, never an executable price. */
  readonly conventions: readonly TradeReferenceConvention[];
  readonly maxAgeSeconds: number;
}

/**
 * Aggregate exposure, **snapshot-advisory only**. `concurrency` admits exactly
 * one value so the configuration itself states the limitation: no atomic
 * reservation of exposure capacity exists in TRADE-03 (see the TRADE-03 doc,
 * aggregate exposure). Two concurrent orders can each pass a snapshot check.
 */
export interface TradeExposurePolicy {
  readonly mode: 'enforce';
  readonly riskBucket: string;
  readonly denomination: TradeAsset;
  readonly ceiling: string;
  readonly sourceIds: readonly string[];
  readonly maxAgeSeconds: number;
  readonly concurrency: 'snapshot-advisory';
}

export interface TradeActiveOrderPolicy {
  readonly mode: 'enforce';
  readonly scope: TradeActiveOrderScope;
  readonly maximum: number;
  readonly sourceIds: readonly string[];
  readonly maxAgeSeconds: number;
  readonly concurrency: 'snapshot-advisory';
}

export interface TradePriceBand {
  readonly mode: 'enforce';
  readonly floor: TradePrice;
  readonly ceiling: TradePrice;
}

export interface TradeDeviationPolicy {
  readonly mode: 'enforce';
  /** Maximum deviation from the trusted reference, in whole basis points (1 … 10 000). */
  readonly maxBasisPoints: number;
  readonly rule: TradeDeviationRule;
}

export interface TradeNotionalPolicy {
  readonly mode: 'enforce';
  /** The asset notional is measured in. Never assumed from a currency code. */
  readonly valuationAsset: TradeAsset;
  readonly maximum: string;
}

/** Thresholds above which an otherwise eligible order needs CORE-05 approval. Never a way past a prohibition. */
export interface TradePairApprovalTriggers {
  readonly restricted: boolean;
  /** Notional strictly above this (in the pair's valuation asset) requires approval. */
  readonly notionalAbove?: string;
  /** Deviation strictly above this many basis points requires approval. */
  readonly deviationAboveBasisPoints?: number;
}

export interface TradingPairRiskPolicy {
  readonly pairId: string;
  /** Canonical orientation (TRADE-01): XRP is always the quote; otherwise the lower token is the base. */
  readonly base: TradeAsset;
  readonly quote: TradeAsset;
  readonly sides: readonly TradeSide[];
  /** Base-asset quantity ceiling, in base units. */
  readonly maxBaseQuantity: string;
  /** Ceiling on what the owner gives up (`TakerGets`), per side, in that asset's unit: base for a sell, quote for a buy. */
  readonly maxOwnerGiven: { readonly buy?: string; readonly sell?: string };
  /** Present exactly when `sell` is allowed. The lowest price a sell may state. */
  readonly minSellPrice?: TradePrice | TradeRiskControlDisabled;
  /** Present exactly when `buy` is allowed. The highest price a buy may state. */
  readonly maxBuyPrice?: TradePrice | TradeRiskControlDisabled;
  readonly priceBand: TradePriceBand | TradeRiskControlDisabled;
  readonly referenceDeviation: TradeDeviationPolicy | TradeRiskControlDisabled;
  readonly notional: TradeNotionalPolicy | TradeRiskControlDisabled;
  readonly approval: TradePairApprovalTriggers;
}

export interface TradingRiskProfile {
  readonly schema: typeof TRADING_RISK_PROFILE_SCHEMA;
  readonly organizationId: string;
  readonly profileId: string;
  readonly profileVersion: number;
  readonly status: TradeRiskProfileStatus;
  readonly effectiveFrom: string;
  readonly expiresAt: string;
  /** The governed action identifier this profile is for (the TRADE-01 binding). */
  readonly action: string;
  readonly network: TradeNetwork;
  readonly ownerAccounts: readonly string[];
  readonly delegateAccounts: readonly string[];
  /** OfferCreate flags an order may request, in ledger-bit order. Empty: none. */
  readonly allowedFlags: readonly TradeOfferFlag[];
  readonly factProvenance: TradeFactProvenancePolicy;
  /** How long one assessment may be relied on after it is made, 1 … 300 s. */
  readonly assessmentMaxAgeSeconds: number;
  readonly delegation: TradeDelegationPolicy;
  readonly marketReference: TradeMarketReferencePolicy | TradeRiskControlDisabled;
  readonly exposure: TradeExposurePolicy | TradeRiskControlDisabled;
  readonly activeOrders: TradeActiveOrderPolicy | TradeRiskControlDisabled;
  readonly approval: { readonly sensitiveOwners: readonly string[]; readonly sensitiveDelegates: readonly string[] };
  readonly pairs: readonly TradingPairRiskPolicy[];
  /** `sha256:` over everything above, canonically. */
  readonly digest: string;
}

export const TRADING_RISK_PROFILE_VIOLATIONS = Object.freeze({
  NOT_A_RECORD: 'RISK_PROFILE_NOT_A_RECORD',
  SCHEMA_UNSUPPORTED: 'RISK_PROFILE_SCHEMA_UNSUPPORTED',
  FIELD_INVALID: 'RISK_PROFILE_FIELD_INVALID',
  WINDOW_INVALID: 'RISK_PROFILE_WINDOW_INVALID',
  ACCOUNT_INVALID: 'RISK_PROFILE_ACCOUNT_INVALID',
  LIST_INVALID: 'RISK_PROFILE_LIST_INVALID',
  LIMIT_INVALID: 'RISK_PROFILE_LIMIT_INVALID',
  PRICE_INVALID: 'RISK_PROFILE_PRICE_INVALID',
  ASSET_INVALID: 'RISK_PROFILE_ASSET_INVALID',
  PAIR_NOT_CANONICAL: 'RISK_PROFILE_PAIR_NOT_CANONICAL',
  PAIR_DUPLICATED: 'RISK_PROFILE_PAIR_DUPLICATED',
  CONTROL_INVALID: 'RISK_PROFILE_CONTROL_INVALID',
  CONTROL_NOT_DISABLEABLE: 'RISK_PROFILE_CONTROL_NOT_DISABLEABLE',
  DEPENDENCY_MISSING: 'RISK_PROFILE_DEPENDENCY_MISSING',
  CONCURRENCY_UNSUPPORTED: 'RISK_PROFILE_CONCURRENCY_UNSUPPORTED',
  DIGEST_MISMATCH: 'RISK_PROFILE_DIGEST_MISMATCH',
} as const);

export type TradingRiskProfileViolationCode = (typeof TRADING_RISK_PROFILE_VIOLATIONS)[keyof typeof TRADING_RISK_PROFILE_VIOLATIONS];

export type TradingRiskProfileParse =
  | { readonly valid: true; readonly profile: TradingRiskProfile }
  | { readonly valid: false; readonly violation: TradingRiskProfileViolationCode; readonly field: string };

const P = TRADING_RISK_PROFILE_VIOLATIONS;

class Refusal {
  constructor(
    readonly violation: TradingRiskProfileViolationCode,
    readonly field: string,
  ) {}
}

function refuse(violation: TradingRiskProfileViolationCode, field: string): never {
  throw new Refusal(violation, field);
}

function record(raw: unknown, field: string, required: readonly string[], optional: readonly string[] = []): ReadonlyMap<string, unknown> {
  return closedRecord(raw, required, optional) ?? refuse(P.FIELD_INVALID, field);
}

function identifier(value: unknown, field: string): string {
  return isTradeIdentifier(value) ? value : refuse(P.FIELD_INVALID, field);
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : refuse(P.FIELD_INVALID, field);
}

function integerIn(value: unknown, minimum: number, maximum: number, field: string): number {
  return isSafeIntegerIn(value, minimum, maximum) ? value : refuse(P.FIELD_INVALID, field);
}

function limit(value: unknown, field: string): string {
  return parsePositiveRiskDecimal(value) ?? refuse(P.LIMIT_INVALID, field);
}

function price(value: unknown, field: string): TradePrice {
  return parseRiskPrice(value) ?? refuse(P.PRICE_INVALID, field);
}

function asset(value: unknown, field: string): TradeAsset {
  return parseRiskAsset(value) ?? refuse(P.ASSET_INVALID, field);
}

/** A sorted, duplicate-free list of 1 … `maximum` items each accepted by `item`. */
function sortedSet<T extends string>(raw: unknown, maximum: number, field: string, item: (value: unknown, field: string) => T, allowEmpty = false): readonly T[] {
  const list = plainList(raw, maximum) ?? refuse(P.LIST_INVALID, field);
  if (list.length === 0 && !allowEmpty) refuse(P.LIST_INVALID, field);
  const values = list.map((value, index) => item(value, `${field}[${index}]`));
  if (new Set(values).size !== values.length) refuse(P.LIST_INVALID, field);
  return Object.freeze([...values].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)));
}

function account(value: unknown, field: string): string {
  return checkTradeAccountAddress(value) === 'valid' ? (value as string) : refuse(P.ACCOUNT_INVALID, field);
}

function isDisabledShape(raw: unknown): boolean {
  const entries = closedRecord(raw, ['mode', 'reason']);
  return entries !== undefined && entries.get('mode') === 'disabled';
}

function disabled(raw: unknown, field: string): TradeRiskControlDisabled {
  const entries = record(raw, field, ['mode', 'reason']);
  if (entries.get('mode') !== 'disabled') refuse(P.CONTROL_INVALID, field);
  return Object.freeze({ mode: 'disabled', reason: identifier(entries.get('reason'), `${field}.reason`) });
}

/** A disableable control: `{ mode: 'disabled', reason }` or `{ mode: 'enforce', … }` read by `enforce`. */
function control<T>(raw: unknown, field: string, enforce: (raw: unknown, field: string) => T): T | TradeRiskControlDisabled {
  if (isDisabledShape(raw)) return disabled(raw, field);
  return enforce(raw, field);
}

function enforced(raw: unknown, field: string, required: readonly string[], optional: readonly string[] = []): ReadonlyMap<string, unknown> {
  const entries = record(raw, field, ['mode', ...required], optional);
  if (entries.get('mode') !== 'enforce') refuse(P.CONTROL_INVALID, `${field}.mode`);
  return entries;
}

function snapshotConcurrency(value: unknown, field: string): 'snapshot-advisory' {
  // Only the snapshot-advisory form exists: an atomic reservation of trading exposure is not implemented, so it cannot be configured.
  return value === 'snapshot-advisory' ? value : refuse(P.CONCURRENCY_UNSUPPORTED, field);
}

function parsePair(raw: unknown, field: string): TradingPairRiskPolicy {
  const entries = record(raw, field, ['pairId', 'base', 'quote', 'sides', 'maxBaseQuantity', 'maxOwnerGiven', 'priceBand', 'referenceDeviation', 'notional', 'approval'], ['minSellPrice', 'maxBuyPrice']);
  const pairId = identifier(entries.get('pairId'), `${field}.pairId`);
  const base = asset(entries.get('base'), `${field}.base`);
  const quote = asset(entries.get('quote'), `${field}.quote`);
  if (tradeAssetsEqual(base, quote)) refuse(P.PAIR_NOT_CANONICAL, field);
  const canonical = canonicalTradePair(base, quote);
  if (!tradeAssetsEqual(canonical.base, base) || !tradeAssetsEqual(canonical.quote, quote)) refuse(P.PAIR_NOT_CANONICAL, field);
  const sides = sortedSet(entries.get('sides'), 2, `${field}.sides`, (value, at) => oneOf<TradeSide>(value, ['buy', 'sell'], at));
  const maxBaseQuantity = limit(entries.get('maxBaseQuantity'), `${field}.maxBaseQuantity`);

  const givenField = `${field}.maxOwnerGiven`;
  const given = record(entries.get('maxOwnerGiven'), givenField, sides);
  const maxOwnerGiven = Object.freeze({
    ...(given.has('buy') ? { buy: limit(given.get('buy'), `${givenField}.buy`) } : {}),
    ...(given.has('sell') ? { sell: limit(given.get('sell'), `${givenField}.sell`) } : {}),
  });

  const sideBound = (key: 'minSellPrice' | 'maxBuyPrice', side: TradeSide): TradePrice | TradeRiskControlDisabled | undefined => {
    const allowed = sides.includes(side);
    if (allowed !== entries.has(key)) refuse(P.CONTROL_INVALID, `${field}.${key}`);
    if (!allowed) return undefined;
    const value = entries.get(key);
    return isDisabledShape(value) ? disabled(value, `${field}.${key}`) : price(value, `${field}.${key}`);
  };
  const minSellPrice = sideBound('minSellPrice', 'sell');
  const maxBuyPrice = sideBound('maxBuyPrice', 'buy');

  const priceBand = control(entries.get('priceBand'), `${field}.priceBand`, (value, at): TradePriceBand => {
    const band = enforced(value, at, ['floor', 'ceiling']);
    const floor = price(band.get('floor'), `${at}.floor`);
    const ceiling = price(band.get('ceiling'), `${at}.ceiling`);
    if (compareRationals(floor, ceiling) > 0) refuse(P.PRICE_INVALID, at);
    return Object.freeze({ mode: 'enforce', floor, ceiling });
  });
  const referenceDeviation = control(entries.get('referenceDeviation'), `${field}.referenceDeviation`, (value, at): TradeDeviationPolicy => {
    const deviation = enforced(value, at, ['maxBasisPoints', 'rule']);
    return Object.freeze({ mode: 'enforce', maxBasisPoints: integerIn(deviation.get('maxBasisPoints'), 1, 10_000, `${at}.maxBasisPoints`), rule: oneOf<TradeDeviationRule>(deviation.get('rule'), ['adverse', 'symmetric'], `${at}.rule`) });
  });
  const notional = control(entries.get('notional'), `${field}.notional`, (value, at): TradeNotionalPolicy => {
    const policy = enforced(value, at, ['valuationAsset', 'maximum']);
    return Object.freeze({ mode: 'enforce', valuationAsset: asset(policy.get('valuationAsset'), `${at}.valuationAsset`), maximum: limit(policy.get('maximum'), `${at}.maximum`) });
  });

  const approvalField = `${field}.approval`;
  const approvalEntries = record(entries.get('approval'), approvalField, ['restricted'], ['notionalAbove', 'deviationAboveBasisPoints']);
  const restricted = approvalEntries.get('restricted');
  if (typeof restricted !== 'boolean') refuse(P.FIELD_INVALID, `${approvalField}.restricted`);
  let notionalAbove: string | undefined;
  if (approvalEntries.has('notionalAbove')) {
    notionalAbove = limit(approvalEntries.get('notionalAbove'), `${approvalField}.notionalAbove`);
    // An approval threshold only makes sense below an enforced ceiling it can never loosen.
    if (notional.mode !== 'enforce' || compareRationals(rationalOfDecimal(notionalAbove), rationalOfDecimal(notional.maximum)) >= 0) refuse(P.DEPENDENCY_MISSING, `${approvalField}.notionalAbove`);
  }
  let deviationAboveBasisPoints: number | undefined;
  if (approvalEntries.has('deviationAboveBasisPoints')) {
    deviationAboveBasisPoints = integerIn(approvalEntries.get('deviationAboveBasisPoints'), 0, 9_999, `${approvalField}.deviationAboveBasisPoints`);
    if (referenceDeviation.mode !== 'enforce' || deviationAboveBasisPoints >= referenceDeviation.maxBasisPoints) refuse(P.DEPENDENCY_MISSING, `${approvalField}.deviationAboveBasisPoints`);
  }

  return Object.freeze({
    pairId,
    base,
    quote,
    sides,
    maxBaseQuantity,
    maxOwnerGiven,
    ...(minSellPrice !== undefined ? { minSellPrice } : {}),
    ...(maxBuyPrice !== undefined ? { maxBuyPrice } : {}),
    priceBand,
    referenceDeviation,
    notional,
    approval: Object.freeze({
      restricted,
      ...(notionalAbove !== undefined ? { notionalAbove } : {}),
      ...(deviationAboveBasisPoints !== undefined ? { deviationAboveBasisPoints } : {}),
    }),
  });
}

const PROFILE_FIELDS = [
  'schema',
  'organizationId',
  'profileId',
  'profileVersion',
  'status',
  'effectiveFrom',
  'expiresAt',
  'action',
  'network',
  'ownerAccounts',
  'delegateAccounts',
  'allowedFlags',
  'factProvenance',
  'assessmentMaxAgeSeconds',
  'delegation',
  'marketReference',
  'exposure',
  'activeOrders',
  'approval',
  'pairs',
] as const;

const NOT_DISABLEABLE = ['delegation'] as const;

function parseBody(raw: unknown): Omit<TradingRiskProfile, 'digest'> {
  const entries = closedRecord(raw, PROFILE_FIELDS, ['digest']) ?? refuse(P.NOT_A_RECORD, '<profile>');
  if (entries.get('schema') !== TRADING_RISK_PROFILE_SCHEMA) refuse(P.SCHEMA_UNSUPPORTED, 'schema');
  const organizationId = identifier(entries.get('organizationId'), 'organizationId');
  const profileId = identifier(entries.get('profileId'), 'profileId');
  const profileVersion = integerIn(entries.get('profileVersion'), 1, 1_000_000, 'profileVersion');
  const status = oneOf<TradeRiskProfileStatus>(entries.get('status'), ['active', 'retired', 'suspended'], 'status');
  const effectiveFrom = entries.get('effectiveFrom');
  const expiresAt = entries.get('expiresAt');
  if (!isTradeInstant(effectiveFrom)) refuse(P.WINDOW_INVALID, 'effectiveFrom');
  if (!isTradeInstant(expiresAt)) refuse(P.WINDOW_INVALID, 'expiresAt');
  const horizon = millisecondsBetween(effectiveFrom, expiresAt);
  if (horizon <= 0 || horizon > TRADING_RISK_PROFILE_MAXIMUM_HORIZON_SECONDS * 1000) refuse(P.WINDOW_INVALID, 'expiresAt');
  const action = identifier(entries.get('action'), 'action');
  const network = entries.get('network');
  if (!isTradeNetwork(network)) refuse(P.FIELD_INVALID, 'network');
  const ownerAccounts = sortedSet(entries.get('ownerAccounts'), MAXIMUM_ACCOUNTS, 'ownerAccounts', account);
  const delegateAccounts = sortedSet(entries.get('delegateAccounts'), MAXIMUM_ACCOUNTS, 'delegateAccounts', account);
  const flagNames = Object.keys(TRADE_OFFER_FLAGS) as TradeOfferFlag[];
  const flags = sortedSet(entries.get('allowedFlags'), flagNames.length, 'allowedFlags', (value, at) => oneOf<TradeOfferFlag>(value, flagNames, at), true);
  const allowedFlags = Object.freeze([...flags].sort((left, right) => TRADE_OFFER_FLAGS[left] - TRADE_OFFER_FLAGS[right]));
  const factProvenance = oneOf<TradeFactProvenancePolicy>(entries.get('factProvenance'), ['operational-only', 'simulated-permitted'], 'factProvenance');
  const assessmentMaxAgeSeconds = integerIn(entries.get('assessmentMaxAgeSeconds'), 1, TRADING_RISK_MAXIMUM_ASSESSMENT_AGE_SECONDS, 'assessmentMaxAgeSeconds');

  for (const key of NOT_DISABLEABLE) if (isDisabledShape(entries.get(key))) refuse(P.CONTROL_NOT_DISABLEABLE, key);
  const delegation = parseTradeDelegationPolicy(entries.get('delegation')) ?? refuse(P.CONTROL_INVALID, 'delegation');

  const sourceIds = (value: unknown, at: string): readonly string[] => sortedSet(value, MAXIMUM_SOURCES, at, identifier);
  const age = (value: unknown, at: string): number => integerIn(value, 1, TRADING_RISK_MAXIMUM_FACT_AGE_SECONDS, at);

  const marketReference = control(entries.get('marketReference'), 'marketReference', (value, at): TradeMarketReferencePolicy => {
    const policy = enforced(value, at, ['sourceIds', 'conventions', 'maxAgeSeconds']);
    return Object.freeze({
      mode: 'enforce',
      sourceIds: sourceIds(policy.get('sourceIds'), `${at}.sourceIds`),
      conventions: sortedSet(policy.get('conventions'), 4, `${at}.conventions`, (item, where) => oneOf(item, TRADE_REFERENCE_CONVENTIONS, where)),
      maxAgeSeconds: age(policy.get('maxAgeSeconds'), `${at}.maxAgeSeconds`),
    });
  });
  const exposure = control(entries.get('exposure'), 'exposure', (value, at): TradeExposurePolicy => {
    const policy = enforced(value, at, ['riskBucket', 'denomination', 'ceiling', 'sourceIds', 'maxAgeSeconds', 'concurrency']);
    return Object.freeze({
      mode: 'enforce',
      riskBucket: identifier(policy.get('riskBucket'), `${at}.riskBucket`),
      denomination: asset(policy.get('denomination'), `${at}.denomination`),
      ceiling: limit(policy.get('ceiling'), `${at}.ceiling`),
      sourceIds: sourceIds(policy.get('sourceIds'), `${at}.sourceIds`),
      maxAgeSeconds: age(policy.get('maxAgeSeconds'), `${at}.maxAgeSeconds`),
      concurrency: snapshotConcurrency(policy.get('concurrency'), `${at}.concurrency`),
    });
  });
  const activeOrders = control(entries.get('activeOrders'), 'activeOrders', (value, at): TradeActiveOrderPolicy => {
    const policy = enforced(value, at, ['scope', 'maximum', 'sourceIds', 'maxAgeSeconds', 'concurrency']);
    return Object.freeze({
      mode: 'enforce',
      scope: oneOf<TradeActiveOrderScope>(policy.get('scope'), ['delegate', 'organization', 'owner', 'owner-pair'], `${at}.scope`),
      maximum: integerIn(policy.get('maximum'), 1, MAXIMUM_ACTIVE_ORDERS, `${at}.maximum`),
      sourceIds: sourceIds(policy.get('sourceIds'), `${at}.sourceIds`),
      maxAgeSeconds: age(policy.get('maxAgeSeconds'), `${at}.maxAgeSeconds`),
      concurrency: snapshotConcurrency(policy.get('concurrency'), `${at}.concurrency`),
    });
  });

  const approvalEntries = record(entries.get('approval'), 'approval', ['sensitiveOwners', 'sensitiveDelegates']);
  const sensitiveOwners = sortedSet(approvalEntries.get('sensitiveOwners'), MAXIMUM_ACCOUNTS, 'approval.sensitiveOwners', account, true);
  const sensitiveDelegates = sortedSet(approvalEntries.get('sensitiveDelegates'), MAXIMUM_ACCOUNTS, 'approval.sensitiveDelegates', account, true);
  if (!sensitiveOwners.every((owner) => ownerAccounts.includes(owner))) refuse(P.ACCOUNT_INVALID, 'approval.sensitiveOwners');
  if (!sensitiveDelegates.every((delegate) => delegateAccounts.includes(delegate))) refuse(P.ACCOUNT_INVALID, 'approval.sensitiveDelegates');

  const pairList = plainList(entries.get('pairs'), MAXIMUM_PAIRS) ?? refuse(P.LIST_INVALID, 'pairs');
  if (pairList.length === 0) refuse(P.LIST_INVALID, 'pairs');
  const pairs = pairList.map((pair, index) => parsePair(pair, `pairs[${index}]`));
  const pairIds = new Set(pairs.map((pair) => pair.pairId));
  const pairKeys = new Set(pairs.map((pair) => `${tradeAssetToken(pair.base)}|${tradeAssetToken(pair.quote)}`));
  if (pairIds.size !== pairs.length || pairKeys.size !== pairs.length) refuse(P.PAIR_DUPLICATED, 'pairs');

  // Dependencies: a control that values an order needs a trusted market reference unless no conversion is needed.
  pairs.forEach((pair, index) => {
    if (pair.referenceDeviation.mode === 'enforce' && marketReference.mode !== 'enforce') refuse(P.DEPENDENCY_MISSING, `pairs[${index}].referenceDeviation`);
    if (pair.notional.mode === 'enforce' && !tradeAssetsEqual(pair.notional.valuationAsset, pair.base) && marketReference.mode !== 'enforce') refuse(P.DEPENDENCY_MISSING, `pairs[${index}].notional`);
    if (exposure.mode === 'enforce' && !tradeAssetsEqual(exposure.denomination, pair.base) && marketReference.mode !== 'enforce') refuse(P.DEPENDENCY_MISSING, 'exposure');
  });

  return Object.freeze({
    schema: TRADING_RISK_PROFILE_SCHEMA,
    organizationId,
    profileId,
    profileVersion,
    status,
    effectiveFrom,
    expiresAt,
    action,
    network,
    ownerAccounts,
    delegateAccounts,
    allowedFlags,
    factProvenance,
    assessmentMaxAgeSeconds,
    delegation,
    marketReference,
    exposure,
    activeOrders,
    approval: Object.freeze({ sensitiveOwners, sensitiveDelegates }),
    pairs: Object.freeze(pairs),
  });
}

/** The canonical data form of a parsed profile (prices and assets as records), which the digest covers. */
export function tradingRiskProfileData(profile: Omit<TradingRiskProfile, 'digest'>): Record<string, unknown> {
  const priceOrDisabled = (value: TradePrice | TradeRiskControlDisabled): unknown => ('mode' in value ? value : priceRecord(value));
  const data: Record<string, unknown> = {
    ...profile,
    exposure: profile.exposure.mode === 'enforce' ? { ...profile.exposure, denomination: assetRecord(profile.exposure.denomination) } : profile.exposure,
    pairs: profile.pairs.map((pair) => ({
      ...pair,
      base: assetRecord(pair.base),
      quote: assetRecord(pair.quote),
      ...(pair.minSellPrice !== undefined ? { minSellPrice: priceOrDisabled(pair.minSellPrice) } : {}),
      ...(pair.maxBuyPrice !== undefined ? { maxBuyPrice: priceOrDisabled(pair.maxBuyPrice) } : {}),
      priceBand: pair.priceBand.mode === 'enforce' ? { mode: 'enforce', floor: priceRecord(pair.priceBand.floor), ceiling: priceRecord(pair.priceBand.ceiling) } : pair.priceBand,
      notional: pair.notional.mode === 'enforce' ? { ...pair.notional, valuationAsset: assetRecord(pair.notional.valuationAsset) } : pair.notional,
    })),
  };
  delete data['digest'];
  return data;
}

/**
 * Validates trusted configuration as a trading-risk profile and seals it.
 * When the input already carries a `digest` (a stored snapshot), the digest
 * must match the content exactly — a tampered snapshot is refused, not
 * re-sealed.
 */
export function parseTradingRiskProfile(raw: unknown): TradingRiskProfileParse {
  try {
    const body = parseBody(raw);
    const sealed = sealRiskRecord(TRADING_RISK_PROFILE_DIGEST_DOMAIN, tradingRiskProfileData(body));
    const stated = closedRecord(raw, PROFILE_FIELDS, ['digest'])?.get('digest');
    if (stated !== undefined && stated !== sealed.digest) return Object.freeze({ valid: false as const, violation: P.DIGEST_MISMATCH, field: 'digest' });
    return Object.freeze({ valid: true as const, profile: Object.freeze({ ...body, digest: sealed.digest }) });
  } catch (error) {
    if (error instanceof Refusal) return Object.freeze({ valid: false as const, violation: error.violation, field: error.field });
    return Object.freeze({ valid: false as const, violation: P.NOT_A_RECORD, field: '<profile>' });
  }
}

/** Whether a stored profile snapshot is intact (its digest recomputes). */
export function isIntactTradingRiskProfileData(raw: unknown): boolean {
  return unsealRiskRecord(TRADING_RISK_PROFILE_DIGEST_DOMAIN, raw) !== undefined;
}

/** The profile's reference: `<profileId>@<version>`. What a CORE-04 profile fact carries. */
export function tradingRiskProfileReference(profile: Pick<TradingRiskProfile, 'profileId' | 'profileVersion'>): string {
  return `${profile.profileId}@${profile.profileVersion}`;
}
