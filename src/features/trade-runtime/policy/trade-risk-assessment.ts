import { tradeAssetsEqual, tradeAssetToken, tradeDecimalQuantity, tradeExactQuantity, type TradeAsset } from '../domain/trade-asset.js';
import { checkTradeDelegationReliance, TRADE_DELEGATION_RELIANCE_REFUSALS } from '../domain/trade-delegation-assessment.js';
import { isTradeInstant } from '../domain/trade-delegation.js';
import { isPlainRecord, isTradeIdentifier, snapshotTradeRecord } from '../domain/trade-grammar.js';
import { compareTradePrices, formatTradePrice } from '../domain/trade-price.js';
import { validateTradeProposal } from '../domain/trade-proposal.js';
import {
  parseTradeActiveOrderSnapshot,
  parseTradeExposureSnapshot,
  tradeActiveOrderCount,
  tradeActiveOrderScopeKey,
  tradeExposureCommitted,
  type TradeActiveOrderSnapshot,
  type TradeExposureSnapshot,
} from './trade-exposure.js';
import { provenanceAdmitted, selectTradeReference, type TradeReferenceReason, type TrustedMarketPriceSnapshot } from './trade-market-reference.js';
import {
  addRationals,
  compareRationals,
  deviationBasisPoints,
  formatTradeRational,
  freshnessAt,
  isSafeIntegerIn,
  millisecondsBetween,
  multiplyRationals,
  plainList,
  plainRiskData,
  rationalOfDecimal,
  rationalOfQuantity,
  sealRiskRecord,
  type TradeRational,
} from './trade-risk-exact.js';
import { parseTradingRiskProfile, type TradingPairRiskPolicy, type TradingRiskProfile } from './trade-risk-profile.js';

/**
 * The trading-risk assessment (TRADE-03): one proposal, one trusted profile,
 * the trusted facts the composition obtained, one instant → one sealed
 * evidence record.
 *
 * > **An assessment is a prerequisite, never a decision.** `SATISFIED` means
 * > every mandatory control was affirmatively established from trusted inputs.
 * > It is not an ALLOW, not an approval and not a grant: the Governance Core
 * > decides, on facts the Trusted Context Boundary admits, and the protected
 * > execution path alone can act.
 *
 * ## Outcomes, per control and overall
 *
 * Each of the sixteen controls in `TRADING_RISK_CONTROLS` is recorded exactly
 * once as `SATISFIED`, `VIOLATED`, `UNAVAILABLE` or — only for a control the
 * profile explicitly disables — `DISABLED`. The overall outcome is:
 *
 * - `VIOLATED` if any control is violated (the order is **prohibited**; no
 *   approval can lift it);
 * - otherwise `UNAVAILABLE` if any control could not be established (missing,
 *   stale, conflicting, malformed or untrusted input — **withheld**);
 * - otherwise `SATISFIED`, and only if all sixteen are present and each is
 *   `SATISFIED` or a profile-sanctioned `DISABLED`. A control that was not
 *   evaluated can never contribute a positive outcome.
 *
 * A satisfied order whose profile marks it for review (a restricted pair, a
 * sensitive owner or delegate, notional or deviation above a review
 * threshold) has disposition `APPROVAL_REQUIRED` — a signal for the existing
 * CORE-05 approval path, which never overrides a prohibition.
 *
 * Pure: the instant is passed in; nothing here reads a clock, a ledger or a
 * market. Inputs are untrusted data, re-validated here; facts reach this
 * function only from the trusted composition, never from the applicant.
 */

export const TRADING_RISK_ASSESSMENT_SCHEMA = 'frontera.trading-risk-assessment.v1';
export const TRADING_RISK_ASSESSMENT_DIGEST_DOMAIN = 'frontera.trading-risk-assessment-digest.v1';

export const TRADING_RISK_CONTROLS = Object.freeze([
  'PROFILE_IN_FORCE',
  'OWNER_IN_SCOPE',
  'DELEGATE_IN_SCOPE',
  'PAIR_APPROVED',
  'SIDE_APPROVED',
  'FLAGS_PERMITTED',
  'OWNER_GIVEN_AMOUNT_MAXIMUM',
  'BASE_QUANTITY_MAXIMUM',
  'LIMIT_PRICE_BOUND',
  'PRICE_BAND',
  'REFERENCE_PRICE',
  'REFERENCE_DEVIATION',
  'NOTIONAL_MAXIMUM',
  'EXPOSURE_CEILING',
  'ACTIVE_ORDER_LIMIT',
  'DELEGATION_VERIFIED',
] as const);

export type TradingRiskControlId = (typeof TRADING_RISK_CONTROLS)[number];
export type TradingRiskControlOutcome = 'SATISFIED' | 'VIOLATED' | 'UNAVAILABLE' | 'DISABLED';
export type TradingRiskOutcome = 'SATISFIED' | 'VIOLATED' | 'UNAVAILABLE';
export type TradingRiskDisposition = 'ELIGIBLE' | 'APPROVAL_REQUIRED' | 'PROHIBITED' | 'WITHHELD';

/** Controls a profile may switch off. Every other control is mandatory and can never be `DISABLED`. */
export const TRADING_RISK_DISABLEABLE_CONTROLS: readonly TradingRiskControlId[] = Object.freeze([
  'LIMIT_PRICE_BOUND',
  'PRICE_BAND',
  'REFERENCE_PRICE',
  'REFERENCE_DEVIATION',
  'NOTIONAL_MAXIMUM',
  'EXPOSURE_CEILING',
  'ACTIVE_ORDER_LIMIT',
]);

export interface TradingRiskControlResult {
  readonly control: TradingRiskControlId;
  /** `<profileId>@<version>:<pairId | *>:<control>`. */
  readonly ruleId: string;
  readonly outcome: TradingRiskControlOutcome;
  readonly reason: string;
  /** What was measured, as exact text (a decimal or `n/d`). */
  readonly observed?: string;
  /** What it was held to, as exact text. */
  readonly limit?: string;
}

export interface TradingRiskSourceEvidence {
  readonly sourceId: string;
  readonly digest: string;
  readonly observedAt: string;
  readonly provenance: 'operational' | 'simulated' | 'unrecorded';
}

export interface TradingRiskFreshnessEntry {
  readonly fact: 'delegation' | 'reference' | 'valuation' | 'exposure-valuation' | 'exposure' | 'active-orders';
  readonly observedAt: string;
  readonly maxAgeSeconds: number;
}

export interface TradingRiskAssessmentEvidence {
  readonly schema: typeof TRADING_RISK_ASSESSMENT_SCHEMA;
  readonly organizationId: string;
  readonly principalId: string;
  readonly requestId: string;
  readonly proposalDigest: string;
  readonly action: string;
  readonly network: string;
  readonly ownerAccount: string;
  readonly delegateAccount: string;
  readonly pair: { readonly base: string; readonly quote: string };
  readonly side: string;
  /** Base quantity, canonical decimal in the base unit. */
  readonly quantity: string;
  /** Quote per base, `n/d`. */
  readonly limitPrice: string;
  readonly ownerGiven: { readonly asset: string; readonly value: string };
  readonly riskProfile: { readonly profileId: string; readonly profileVersion: number; readonly digest: string };
  readonly governanceProfile?: { readonly id: string; readonly version: number };
  readonly outcome: TradingRiskOutcome;
  readonly disposition: TradingRiskDisposition;
  readonly approvalTriggers: readonly string[];
  readonly controls: readonly TradingRiskControlResult[];
  readonly sources: {
    readonly reference?: TradingRiskSourceEvidence & { readonly price: string; readonly convention: string };
    readonly valuation?: TradingRiskSourceEvidence & { readonly price: string; readonly convention: string };
    readonly exposureValuation?: TradingRiskSourceEvidence & { readonly price: string; readonly convention: string };
    readonly exposure?: TradingRiskSourceEvidence & { readonly validatedLedgerIndex: number };
    readonly activeOrders?: TradingRiskSourceEvidence & { readonly validatedLedgerIndex: number };
    readonly delegation?: TradingRiskSourceEvidence & { readonly factsDigest: string; readonly validatedLedgerIndex: number };
  };
  readonly freshness: readonly TradingRiskFreshnessEntry[];
  /** Whether any fact relied on came from a source marked `simulated`. */
  readonly simulatedFacts: boolean;
  readonly limitations: readonly string[];
  readonly assessedAt: string;
  /** How long after `assessedAt` this record may be relied on (the profile's bound at assessment). */
  readonly relianceMaxAgeSeconds: number;
  readonly digest: string;
}

export interface TradingRiskAssessmentInput {
  /** The proposal as the applicant side shaped it (a canonical proposal is fine). Validated here. */
  readonly proposal: unknown;
  /** The authenticated identity the request is bound to. Never from the proposal. */
  readonly identity: { readonly organizationId: string; readonly principalId: string };
  /** Trusted host configuration: the governed action identifier (TRADE-01 binding). */
  readonly binding: { readonly action: string };
  /** Trusted configuration: the profile's data form. Parsed and sealed here. */
  readonly profile: unknown;
  /** Facts the **trusted composition** obtained. The applicant supplies none of them. */
  readonly facts: {
    readonly delegation?: unknown;
    readonly marketPrices?: readonly unknown[];
    readonly exposure?: unknown;
    readonly activeOrders?: unknown;
  };
  /** Trusted pins: a validated ledger index exposure and order readings must have reached. */
  readonly pins?: { readonly minimumValidatedLedgerIndex?: number };
  /** The Governance Profile the request resolved to, recorded for audit. */
  readonly governanceProfile?: { readonly id: string; readonly version: number };
  /** The trusted clock's instant. */
  readonly assessedAt: string;
}

export const TRADING_RISK_ASSESSMENT_REFUSALS = Object.freeze({
  PROPOSAL_INVALID: 'RISK_ASSESSMENT_PROPOSAL_INVALID',
  IDENTITY_INVALID: 'RISK_ASSESSMENT_IDENTITY_INVALID',
  ORGANIZATION_MISMATCH: 'RISK_ASSESSMENT_ORGANIZATION_MISMATCH',
  PRINCIPAL_MISMATCH: 'RISK_ASSESSMENT_PRINCIPAL_MISMATCH',
  BINDING_INVALID: 'RISK_ASSESSMENT_BINDING_INVALID',
  PROFILE_INVALID: 'RISK_ASSESSMENT_PROFILE_INVALID',
  PROFILE_ORGANIZATION_MISMATCH: 'RISK_ASSESSMENT_PROFILE_ORGANIZATION_MISMATCH',
  CLOCK_INVALID: 'RISK_ASSESSMENT_CLOCK_INVALID',
  INPUT_INVALID: 'RISK_ASSESSMENT_INPUT_INVALID',
} as const);

export type TradingRiskAssessmentRefusal = (typeof TRADING_RISK_ASSESSMENT_REFUSALS)[keyof typeof TRADING_RISK_ASSESSMENT_REFUSALS];

/**
 * `assessed: false` when the inputs do not even identify what to assess
 * (an invalid proposal, profile, identity or clock, or a profile of another
 * organization). No evidence is produced then, so there is nothing that could
 * be mistaken for compliance.
 */
export type TradingRiskAssessmentResult = { readonly assessed: true; readonly evidence: TradingRiskAssessmentEvidence } | { readonly assessed: false; readonly refusal: TradingRiskAssessmentRefusal };

/** Which controls the profile disables for a pair and side — the only controls that may be `DISABLED`. */
export function tradingRiskDisabledControls(profile: TradingRiskProfile, pair: TradingPairRiskPolicy | undefined, side: string): ReadonlySet<TradingRiskControlId> {
  const out = new Set<TradingRiskControlId>();
  if (profile.marketReference.mode === 'disabled') out.add('REFERENCE_PRICE');
  if (profile.exposure.mode === 'disabled') out.add('EXPOSURE_CEILING');
  if (profile.activeOrders.mode === 'disabled') out.add('ACTIVE_ORDER_LIMIT');
  if (pair !== undefined) {
    const sideBound = side === 'sell' ? pair.minSellPrice : side === 'buy' ? pair.maxBuyPrice : undefined;
    if (sideBound !== undefined && 'mode' in sideBound) out.add('LIMIT_PRICE_BOUND');
    if (pair.priceBand.mode === 'disabled') out.add('PRICE_BAND');
    if (pair.referenceDeviation.mode === 'disabled') out.add('REFERENCE_DEVIATION');
    if (pair.notional.mode === 'disabled') out.add('NOTIONAL_MAXIMUM');
  }
  return out;
}

/** The pair policy for exactly this base/quote, issuers included. */
export function tradingPairPolicyFor(profile: TradingRiskProfile, base: TradeAsset, quote: TradeAsset): TradingPairRiskPolicy | undefined {
  return profile.pairs.find((pair) => tradeAssetsEqual(pair.base, base) && tradeAssetsEqual(pair.quote, quote));
}

const R = TRADING_RISK_ASSESSMENT_REFUSALS;

/** Controls configured per pair; their rule ids name the pair. */
const PAIR_SCOPED_CONTROLS: ReadonlySet<TradingRiskControlId> = new Set<TradingRiskControlId>([
  'PAIR_APPROVED',
  'SIDE_APPROVED',
  'OWNER_GIVEN_AMOUNT_MAXIMUM',
  'BASE_QUANTITY_MAXIMUM',
  'LIMIT_PRICE_BOUND',
  'PRICE_BAND',
  'REFERENCE_DEVIATION',
  'NOTIONAL_MAXIMUM',
]);

function refused(refusal: TradingRiskAssessmentRefusal): TradingRiskAssessmentResult {
  return Object.freeze({ assessed: false as const, refusal });
}

function readIdentity(raw: unknown): { readonly organizationId: string; readonly principalId: string } | undefined {
  const snapshot = snapshotTradeRecord(raw, 2);
  if (!snapshot.ok || snapshot.entries.size !== 2) return undefined;
  const organizationId = snapshot.entries.get('organizationId');
  const principalId = snapshot.entries.get('principalId');
  return isTradeIdentifier(organizationId) && isTradeIdentifier(principalId) ? { organizationId, principalId } : undefined;
}

function readGovernanceProfile(raw: unknown): { readonly ok: true; readonly value?: { readonly id: string; readonly version: number } } | { readonly ok: false } {
  if (raw === undefined) return { ok: true };
  const snapshot = snapshotTradeRecord(raw, 2);
  if (!snapshot.ok || snapshot.entries.size !== 2) return { ok: false };
  const id = snapshot.entries.get('id');
  const version = snapshot.entries.get('version');
  if (!isTradeIdentifier(id) || !isSafeIntegerIn(version, 1, 1_000_000_000)) return { ok: false };
  return { ok: true, value: Object.freeze({ id, version }) };
}

function readPins(raw: unknown): { readonly ok: true; readonly minimumValidatedLedgerIndex?: number } | { readonly ok: false } {
  if (raw === undefined) return { ok: true };
  const snapshot = snapshotTradeRecord(raw, 1);
  if (!snapshot.ok) return { ok: false };
  if (snapshot.entries.size === 0) return { ok: true };
  const index = snapshot.entries.get('minimumValidatedLedgerIndex');
  if (snapshot.entries.size !== 1 || !isSafeIntegerIn(index, 1, 4_294_967_295)) return { ok: false };
  return { ok: true, minimumValidatedLedgerIndex: index };
}

interface Measured {
  readonly value: TradeRational;
  readonly snapshot?: TrustedMarketPriceSnapshot;
}

type Valuation = { readonly ok: true; readonly measured: Measured } | { readonly ok: false; readonly reason: TradeReferenceReason | 'REFERENCE_NOT_CONFIGURED' };

/**
 * Assesses one proposal. Total: every input yields either a refusal (nothing
 * to assess) or exactly one sealed evidence record.
 */
export function assessTradingRisk(input: TradingRiskAssessmentInput): TradingRiskAssessmentResult {
  if (!isPlainRecord(input)) return refused(R.INPUT_INVALID);
  const identity = readIdentity(input.identity);
  if (identity === undefined) return refused(R.IDENTITY_INVALID);
  const action: unknown = isPlainRecord(input.binding) ? input.binding['action'] : undefined;
  if (!isTradeIdentifier(action)) return refused(R.BINDING_INVALID);
  if (!isTradeInstant(input.assessedAt)) return refused(R.CLOCK_INVALID);
  const at = input.assessedAt;
  const validation = validateTradeProposal(input.proposal);
  if (!validation.valid) return refused(R.PROPOSAL_INVALID);
  const accepted = validation.accepted;
  const { proposal, terms } = accepted;
  if (proposal.organizationId !== identity.organizationId) return refused(R.ORGANIZATION_MISMATCH);
  if (proposal.principalId !== identity.principalId) return refused(R.PRINCIPAL_MISMATCH);
  const parsedProfile = parseTradingRiskProfile(input.profile);
  if (!parsedProfile.valid) return refused(R.PROFILE_INVALID);
  const profile = parsedProfile.profile;
  // A profile of another organization is never applicable here — not even as a basis for a refusal record.
  if (profile.organizationId !== identity.organizationId) return refused(R.PROFILE_ORGANIZATION_MISMATCH);
  const governanceProfile = readGovernanceProfile(input.governanceProfile);
  const pins = readPins(input.pins);
  if (!governanceProfile.ok || !pins.ok) return refused(R.INPUT_INVALID);
  const facts: Record<string, unknown> = isPlainRecord(input.facts) ? input.facts : {};
  const marketPrices = facts['marketPrices'] === undefined ? [] : plainList(facts['marketPrices'], 64);

  const pair = tradingPairPolicyFor(profile, terms.base, terms.quote);
  const disabled = tradingRiskDisabledControls(profile, pair, terms.side);
  const results = new Map<TradingRiskControlId, TradingRiskControlResult>();
  const pairScope = pair?.pairId ?? '*';
  const record = (control: TradingRiskControlId, outcome: TradingRiskControlOutcome, reason: string, detail: { readonly observed?: string; readonly limit?: string } = {}): void => {
    // A control is recorded once; a DISABLED outcome is only ever what the profile sanctions.
    if (results.has(control)) return;
    const sanctioned = outcome !== 'DISABLED' || disabled.has(control);
    results.set(
      control,
      Object.freeze({
        control,
        ruleId: `${profile.profileId}@${profile.profileVersion}:${PAIR_SCOPED_CONTROLS.has(control) ? pairScope : '*'}:${control}`,
        outcome: sanctioned ? outcome : 'UNAVAILABLE',
        reason: sanctioned ? reason : 'CONTROL_DISABLE_NOT_SANCTIONED',
        ...(detail.observed !== undefined ? { observed: detail.observed } : {}),
        ...(detail.limit !== undefined ? { limit: detail.limit } : {}),
      }),
    );
  };
  const sources: Record<string, unknown> = {};
  const freshness: TradingRiskFreshnessEntry[] = [];
  let simulated = false;
  const noteSnapshot = (key: 'reference' | 'valuation' | 'exposureValuation', fact: TradingRiskFreshnessEntry['fact'], snapshot: TrustedMarketPriceSnapshot, maxAgeSeconds: number): void => {
    sources[key] = { sourceId: snapshot.sourceId, digest: snapshot.digest, observedAt: snapshot.observedAt, provenance: snapshot.provenance.kind, price: formatTradePrice(snapshot.price), convention: snapshot.convention };
    freshness.push({ fact, observedAt: snapshot.observedAt, maxAgeSeconds });
    if (snapshot.provenance.kind === 'simulated') simulated = true;
  };

  // ── Profile in force, scope ──────────────────────────────────────────────
  const inWindow = millisecondsBetween(profile.effectiveFrom, at) >= 0 && millisecondsBetween(at, profile.expiresAt) > 0;
  if (profile.status !== 'active') record('PROFILE_IN_FORCE', 'VIOLATED', 'PROFILE_NOT_ACTIVE', { observed: profile.status });
  else if (!inWindow) record('PROFILE_IN_FORCE', 'VIOLATED', 'PROFILE_OUTSIDE_VALIDITY_WINDOW');
  else if (profile.action !== action) record('PROFILE_IN_FORCE', 'VIOLATED', 'PROFILE_ACTION_MISMATCH');
  else if (profile.network !== proposal.network) record('PROFILE_IN_FORCE', 'VIOLATED', 'NETWORK_NOT_APPROVED', { observed: proposal.network, limit: profile.network });
  else record('PROFILE_IN_FORCE', 'SATISFIED', 'PROFILE_IN_FORCE');

  record('OWNER_IN_SCOPE', profile.ownerAccounts.includes(proposal.ownerAccount) ? 'SATISFIED' : 'VIOLATED', profile.ownerAccounts.includes(proposal.ownerAccount) ? 'OWNER_IN_SCOPE' : 'OWNER_NOT_IN_SCOPE');
  record('DELEGATE_IN_SCOPE', profile.delegateAccounts.includes(proposal.delegateAccount) ? 'SATISFIED' : 'VIOLATED', profile.delegateAccounts.includes(proposal.delegateAccount) ? 'DELEGATE_IN_SCOPE' : 'DELEGATE_NOT_IN_SCOPE');
  const disallowedFlag = proposal.flags.find((flag) => !profile.allowedFlags.includes(flag));
  record('FLAGS_PERMITTED', disallowedFlag === undefined ? 'SATISFIED' : 'VIOLATED', disallowedFlag === undefined ? 'FLAGS_PERMITTED' : 'FLAG_NOT_PERMITTED', disallowedFlag !== undefined ? { observed: disallowedFlag } : {});

  // ── Pair, issuers, side ──────────────────────────────────────────────────
  const pairText = `${tradeAssetToken(terms.base)}|${tradeAssetToken(terms.quote)}`;
  const quantity = rationalOfQuantity(tradeExactQuantity(terms.side === 'sell' ? proposal.takerGets : proposal.takerPays));
  const ownerGivenValue = tradeDecimalQuantity(proposal.takerGets);

  if (pair === undefined) {
    // An issued asset is its currency *and* its issuer: the same code from another issuer is another pair.
    const sameCodes = profile.pairs.some((candidate) => sameCode(candidate.base, terms.base) && sameCode(candidate.quote, terms.quote));
    record('PAIR_APPROVED', 'VIOLATED', sameCodes ? 'ISSUER_NOT_APPROVED' : 'PAIR_NOT_APPROVED', { observed: pairText });
    for (const control of ['SIDE_APPROVED', 'OWNER_GIVEN_AMOUNT_MAXIMUM', 'BASE_QUANTITY_MAXIMUM', 'LIMIT_PRICE_BOUND', 'PRICE_BAND', 'REFERENCE_DEVIATION', 'NOTIONAL_MAXIMUM'] as const) {
      record(control, 'UNAVAILABLE', 'PAIR_PREREQUISITE_NOT_MET');
    }
  } else {
    record('PAIR_APPROVED', 'SATISFIED', 'PAIR_APPROVED', { observed: pairText });
    record('SIDE_APPROVED', pair.sides.includes(terms.side) ? 'SATISFIED' : 'VIOLATED', pair.sides.includes(terms.side) ? 'SIDE_APPROVED' : 'SIDE_NOT_APPROVED', { observed: terms.side });

    const givenLimit = terms.side === 'sell' ? pair.maxOwnerGiven.sell : pair.maxOwnerGiven.buy;
    if (givenLimit === undefined) record('OWNER_GIVEN_AMOUNT_MAXIMUM', 'UNAVAILABLE', 'SIDE_PREREQUISITE_NOT_MET');
    else withinLimit(record, 'OWNER_GIVEN_AMOUNT_MAXIMUM', rationalOfDecimal(ownerGivenValue), givenLimit, ownerGivenValue);
    withinLimit(record, 'BASE_QUANTITY_MAXIMUM', quantity, pair.maxBaseQuantity, terms.quantity);

    // Exact limit price: a sell states its floor, a buy its ceiling.
    const sideBound = terms.side === 'sell' ? pair.minSellPrice : pair.maxBuyPrice;
    const limitText = formatTradePrice(terms.limitPrice);
    if (sideBound === undefined) record('LIMIT_PRICE_BOUND', 'UNAVAILABLE', 'SIDE_PREREQUISITE_NOT_MET');
    else if ('mode' in sideBound) record('LIMIT_PRICE_BOUND', 'DISABLED', `DISABLED:${sideBound.reason}`);
    else if (terms.side === 'sell') {
      const order = compareTradePrices(terms.limitPrice, sideBound);
      record('LIMIT_PRICE_BOUND', order >= 0 ? 'SATISFIED' : 'VIOLATED', order >= 0 ? 'SELL_AT_OR_ABOVE_MINIMUM' : 'SELL_BELOW_MINIMUM', { observed: limitText, limit: formatTradePrice(sideBound) });
    } else {
      const order = compareTradePrices(terms.limitPrice, sideBound);
      record('LIMIT_PRICE_BOUND', order <= 0 ? 'SATISFIED' : 'VIOLATED', order <= 0 ? 'BUY_AT_OR_BELOW_MAXIMUM' : 'BUY_ABOVE_MAXIMUM', { observed: limitText, limit: formatTradePrice(sideBound) });
    }
    if (pair.priceBand.mode === 'disabled') record('PRICE_BAND', 'DISABLED', `DISABLED:${pair.priceBand.reason}`);
    else {
      const band = pair.priceBand;
      const below = compareTradePrices(terms.limitPrice, band.floor) < 0;
      const above = compareTradePrices(terms.limitPrice, band.ceiling) > 0;
      record('PRICE_BAND', below || above ? 'VIOLATED' : 'SATISFIED', below ? 'PRICE_BELOW_FLOOR' : above ? 'PRICE_ABOVE_CEILING' : 'PRICE_WITHIN_BAND', { observed: limitText, limit: `${formatTradePrice(band.floor)}..${formatTradePrice(band.ceiling)}` });
    }
  }

  // ── Trusted market reference, deviation, notional ────────────────────────
  const marketPolicy = profile.marketReference;
  const valuationOf = (target: TradeAsset): Valuation => {
    if (tradeAssetsEqual(target, terms.base)) return { ok: true, measured: { value: quantity } };
    if (marketPolicy.mode !== 'enforce' || marketPrices === undefined) return { ok: false, reason: marketPrices === undefined ? 'REFERENCE_MALFORMED' : 'REFERENCE_NOT_CONFIGURED' };
    const selection = selectTradeReference(marketPrices, { organizationId: profile.organizationId, network: profile.network, base: terms.base, quote: target, policy: marketPolicy, provenance: profile.factProvenance, at });
    if (!selection.available) return { ok: false, reason: selection.reason };
    return { ok: true, measured: { value: multiplyRationals(quantity, selection.snapshot.price), snapshot: selection.snapshot } };
  };

  let reference: TrustedMarketPriceSnapshot | undefined;
  if (marketPolicy.mode === 'disabled') record('REFERENCE_PRICE', 'DISABLED', `DISABLED:${marketPolicy.reason}`);
  else if (marketPrices === undefined) record('REFERENCE_PRICE', 'UNAVAILABLE', 'REFERENCE_MALFORMED');
  else {
    const selection = selectTradeReference(marketPrices, { organizationId: profile.organizationId, network: profile.network, base: terms.base, quote: terms.quote, policy: marketPolicy, provenance: profile.factProvenance, at });
    if (selection.available) {
      reference = selection.snapshot;
      noteSnapshot('reference', 'reference', reference, smallerOf(reference.maxAgeSeconds, marketPolicy.maxAgeSeconds));
      record('REFERENCE_PRICE', 'SATISFIED', 'REFERENCE_AVAILABLE', { observed: formatTradePrice(reference.price) });
    } else record('REFERENCE_PRICE', 'UNAVAILABLE', selection.reason);
  }

  let deviation: TradeRational | undefined;
  let notional: TradeRational | undefined;
  if (pair !== undefined) {
    if (pair.referenceDeviation.mode === 'disabled') record('REFERENCE_DEVIATION', 'DISABLED', `DISABLED:${pair.referenceDeviation.reason}`);
    else if (reference === undefined) record('REFERENCE_DEVIATION', 'UNAVAILABLE', 'REFERENCE_PREREQUISITE_NOT_MET');
    else {
      const policy = pair.referenceDeviation;
      deviation = deviationBasisPoints(terms.limitPrice, reference.price);
      const exceeds = compareRationals(deviation, { numerator: BigInt(policy.maxBasisPoints), denominator: 1n }) > 0;
      // Adverse: a sell priced below the reference, or a buy priced above it. Symmetric: either direction.
      const adverse = terms.side === 'sell' ? compareTradePrices(terms.limitPrice, reference.price) < 0 : compareTradePrices(terms.limitPrice, reference.price) > 0;
      const violated = exceeds && (policy.rule === 'symmetric' || adverse);
      record('REFERENCE_DEVIATION', violated ? 'VIOLATED' : 'SATISFIED', violated ? 'DEVIATION_EXCEEDS_MAXIMUM' : 'DEVIATION_WITHIN_MAXIMUM', { observed: `${formatTradeRational(deviation)}bps`, limit: `${policy.maxBasisPoints}bps:${policy.rule}` });
    }

    if (pair.notional.mode === 'disabled') record('NOTIONAL_MAXIMUM', 'DISABLED', `DISABLED:${pair.notional.reason}`);
    else {
      const valuation = valuationOf(pair.notional.valuationAsset);
      if (!valuation.ok) record('NOTIONAL_MAXIMUM', 'UNAVAILABLE', valuation.reason === 'REFERENCE_MISSING' ? 'VALUATION_PRICE_MISSING' : valuation.reason);
      else {
        if (valuation.measured.snapshot !== undefined) noteSnapshot('valuation', 'valuation', valuation.measured.snapshot, smallerOf(valuation.measured.snapshot.maxAgeSeconds, marketPolicy.mode === 'enforce' ? marketPolicy.maxAgeSeconds : 1));
        notional = valuation.measured.value;
        withinLimit(record, 'NOTIONAL_MAXIMUM', notional, pair.notional.maximum, formatTradeRational(notional));
      }
    }
  }

  // ── Aggregate exposure (snapshot-advisory) ───────────────────────────────
  const exposurePolicy = profile.exposure;
  let exposureSnapshot: TradeExposureSnapshot | undefined;
  if (exposurePolicy.mode === 'disabled') record('EXPOSURE_CEILING', 'DISABLED', `DISABLED:${exposurePolicy.reason}`);
  else if (facts['exposure'] === undefined) record('EXPOSURE_CEILING', 'UNAVAILABLE', 'EXPOSURE_SNAPSHOT_MISSING');
  else {
    const snapshot = parseTradeExposureSnapshot(facts['exposure']);
    const age = snapshot !== undefined ? freshnessAt(snapshot.observedAt, smallerOf(snapshot.maxAgeSeconds, exposurePolicy.maxAgeSeconds), at) : 'invalid';
    const minimumLedger = pins.minimumValidatedLedgerIndex;
    if (snapshot === undefined) record('EXPOSURE_CEILING', 'UNAVAILABLE', 'EXPOSURE_SNAPSHOT_MALFORMED');
    else if (!exposurePolicy.sourceIds.includes(snapshot.sourceId)) record('EXPOSURE_CEILING', 'UNAVAILABLE', 'EXPOSURE_SOURCE_NOT_ACCEPTED');
    else if (snapshot.organizationId !== profile.organizationId) record('EXPOSURE_CEILING', 'UNAVAILABLE', 'EXPOSURE_ORGANIZATION_MISMATCH');
    else if (snapshot.network !== proposal.network || snapshot.ownerAccount !== proposal.ownerAccount) record('EXPOSURE_CEILING', 'UNAVAILABLE', 'EXPOSURE_SCOPE_MISMATCH');
    else if (snapshot.riskBucket !== exposurePolicy.riskBucket) record('EXPOSURE_CEILING', 'UNAVAILABLE', 'EXPOSURE_RISK_BUCKET_MISMATCH');
    else if (!tradeAssetsEqual(snapshot.denomination, exposurePolicy.denomination)) record('EXPOSURE_CEILING', 'UNAVAILABLE', 'EXPOSURE_DENOMINATION_MISMATCH');
    else if (!provenanceAdmitted(profile.factProvenance, snapshot.provenance)) record('EXPOSURE_CEILING', 'UNAVAILABLE', 'EXPOSURE_SIMULATED_NOT_ACCEPTED');
    else if (!snapshot.complete) record('EXPOSURE_CEILING', 'UNAVAILABLE', 'EXPOSURE_SNAPSHOT_INCOMPLETE');
    else if (age !== 'fresh') record('EXPOSURE_CEILING', 'UNAVAILABLE', age === 'future' ? 'EXPOSURE_FROM_FUTURE' : 'EXPOSURE_STALE');
    else if (minimumLedger !== undefined && snapshot.validatedLedgerIndex < minimumLedger) record('EXPOSURE_CEILING', 'UNAVAILABLE', 'EXPOSURE_LEDGER_BEHIND');
    else {
      exposureSnapshot = snapshot;
      const increment = valuationOf(exposurePolicy.denomination);
      if (!increment.ok) record('EXPOSURE_CEILING', 'UNAVAILABLE', increment.reason === 'REFERENCE_MISSING' ? 'EXPOSURE_VALUATION_PRICE_MISSING' : increment.reason);
      else {
        if (increment.measured.snapshot !== undefined) noteSnapshot('exposureValuation', 'exposure-valuation', increment.measured.snapshot, smallerOf(increment.measured.snapshot.maxAgeSeconds, marketPolicy.mode === 'enforce' ? marketPolicy.maxAgeSeconds : 1));
        const projected = addRationals(tradeExposureCommitted(snapshot), increment.measured.value);
        const overCeiling = compareRationals(projected, rationalOfDecimal(exposurePolicy.ceiling)) > 0;
        const overCapacity = compareRationals(increment.measured.value, rationalOfDecimal(snapshot.capacityRemaining)) > 0;
        record('EXPOSURE_CEILING', overCeiling || overCapacity ? 'VIOLATED' : 'SATISFIED', overCeiling ? 'EXPOSURE_CEILING_EXCEEDED' : overCapacity ? 'EXPOSURE_CAPACITY_EXCEEDED' : 'EXPOSURE_WITHIN_CEILING_SNAPSHOT', {
          observed: formatTradeRational(projected),
          limit: exposurePolicy.ceiling,
        });
      }
    }
  }
  if (exposureSnapshot !== undefined) {
    sources['exposure'] = { sourceId: exposureSnapshot.sourceId, digest: exposureSnapshot.digest, observedAt: exposureSnapshot.observedAt, provenance: exposureSnapshot.provenance.kind, validatedLedgerIndex: exposureSnapshot.validatedLedgerIndex };
    freshness.push({ fact: 'exposure', observedAt: exposureSnapshot.observedAt, maxAgeSeconds: smallerOf(exposureSnapshot.maxAgeSeconds, exposurePolicy.mode === 'enforce' ? exposurePolicy.maxAgeSeconds : 1) });
    if (exposureSnapshot.provenance.kind === 'simulated') simulated = true;
  }

  // ── Active orders (snapshot-advisory) ────────────────────────────────────
  const orderPolicy = profile.activeOrders;
  if (orderPolicy.mode === 'disabled') record('ACTIVE_ORDER_LIMIT', 'DISABLED', `DISABLED:${orderPolicy.reason}`);
  else if (facts['activeOrders'] === undefined) record('ACTIVE_ORDER_LIMIT', 'UNAVAILABLE', 'ACTIVE_ORDER_SNAPSHOT_MISSING');
  else {
    const snapshot: TradeActiveOrderSnapshot | undefined = parseTradeActiveOrderSnapshot(facts['activeOrders']);
    const expectedKey = tradeActiveOrderScopeKey(orderPolicy.scope, { organizationId: proposal.organizationId, ownerAccount: proposal.ownerAccount, delegateAccount: proposal.delegateAccount, baseToken: tradeAssetToken(terms.base), quoteToken: tradeAssetToken(terms.quote) });
    const age = snapshot !== undefined ? freshnessAt(snapshot.observedAt, smallerOf(snapshot.maxAgeSeconds, orderPolicy.maxAgeSeconds), at) : 'invalid';
    const minimumLedger = pins.minimumValidatedLedgerIndex;
    if (snapshot === undefined) record('ACTIVE_ORDER_LIMIT', 'UNAVAILABLE', 'ACTIVE_ORDER_SNAPSHOT_MALFORMED');
    else if (!orderPolicy.sourceIds.includes(snapshot.sourceId)) record('ACTIVE_ORDER_LIMIT', 'UNAVAILABLE', 'ACTIVE_ORDER_SOURCE_NOT_ACCEPTED');
    else if (snapshot.organizationId !== profile.organizationId) record('ACTIVE_ORDER_LIMIT', 'UNAVAILABLE', 'ACTIVE_ORDER_ORGANIZATION_MISMATCH');
    else if (snapshot.network !== proposal.network || snapshot.scope !== orderPolicy.scope || snapshot.scopeKey !== expectedKey) record('ACTIVE_ORDER_LIMIT', 'UNAVAILABLE', 'ACTIVE_ORDER_SCOPE_MISMATCH');
    else if (!provenanceAdmitted(profile.factProvenance, snapshot.provenance)) record('ACTIVE_ORDER_LIMIT', 'UNAVAILABLE', 'ACTIVE_ORDER_SIMULATED_NOT_ACCEPTED');
    else if (!snapshot.complete) record('ACTIVE_ORDER_LIMIT', 'UNAVAILABLE', 'ACTIVE_ORDER_SNAPSHOT_INCOMPLETE');
    else if (age !== 'fresh') record('ACTIVE_ORDER_LIMIT', 'UNAVAILABLE', age === 'future' ? 'ACTIVE_ORDER_FROM_FUTURE' : 'ACTIVE_ORDER_STALE');
    else if (minimumLedger !== undefined && snapshot.validatedLedgerIndex < minimumLedger) record('ACTIVE_ORDER_LIMIT', 'UNAVAILABLE', 'ACTIVE_ORDER_LEDGER_BEHIND');
    else {
      const occupied = tradeActiveOrderCount(snapshot);
      // This order would be one more.
      const within = occupied + 1 <= orderPolicy.maximum;
      record('ACTIVE_ORDER_LIMIT', within ? 'SATISFIED' : 'VIOLATED', within ? 'ACTIVE_ORDERS_WITHIN_LIMIT_SNAPSHOT' : 'ACTIVE_ORDER_LIMIT_REACHED', { observed: `${occupied + 1}`, limit: `${orderPolicy.maximum}` });
      sources['activeOrders'] = { sourceId: snapshot.sourceId, digest: snapshot.digest, observedAt: snapshot.observedAt, provenance: snapshot.provenance.kind, validatedLedgerIndex: snapshot.validatedLedgerIndex };
      freshness.push({ fact: 'active-orders', observedAt: snapshot.observedAt, maxAgeSeconds: smallerOf(snapshot.maxAgeSeconds, orderPolicy.maxAgeSeconds) });
      if (snapshot.provenance.kind === 'simulated') simulated = true;
    }
  }

  // ── XLS-75 delegation: TRADE-02's reliance check, never a second reading of the ledger ──
  const delegation = facts['delegation'];
  if (delegation === undefined) record('DELEGATION_VERIFIED', 'UNAVAILABLE', 'DELEGATION_EVIDENCE_MISSING');
  else {
    const reliance = checkTradeDelegationReliance(delegation, { proposal, proposalDigest: accepted.digest, at, policy: profile.delegation });
    if (reliance.reliable) {
      // The reliance check proved this record intact and bound; read it again only through a plain copy.
      const copy = plainRiskData(delegation) as { readonly digest: string; readonly factsDigest: string; readonly source: { readonly sourceId: string }; readonly facts: { readonly validatedLedgerIndex: number }; readonly timing: { readonly observedAt: string; readonly maxAgeSeconds: number } };
      record('DELEGATION_VERIFIED', 'SATISFIED', 'DELEGATION_VERIFIED');
      sources['delegation'] = { sourceId: copy.source.sourceId, digest: copy.digest, factsDigest: copy.factsDigest, observedAt: copy.timing.observedAt, provenance: 'unrecorded', validatedLedgerIndex: copy.facts.validatedLedgerIndex };
      freshness.push({ fact: 'delegation', observedAt: copy.timing.observedAt, maxAgeSeconds: smallerOf(profile.delegation.maxAgeSeconds, copy.timing.maxAgeSeconds) });
    } else {
      // Only an intact, correctly bound assessment that observed the ledger and found no delegation proves a violation; everything else is merely unavailable.
      const provedAbsent = reliance.code === TRADE_DELEGATION_RELIANCE_REFUSALS.NOT_AUTHORIZED && isPlainRecord(delegation) && delegation['status'] === 'NOT_AUTHORIZED';
      record('DELEGATION_VERIFIED', provedAbsent ? 'VIOLATED' : 'UNAVAILABLE', reliance.code);
    }
  }

  // ── Completeness, outcome, disposition ───────────────────────────────────
  for (const control of TRADING_RISK_CONTROLS) if (!results.has(control)) record(control, 'UNAVAILABLE', 'CONTROL_NOT_EVALUATED');
  const controls = TRADING_RISK_CONTROLS.map((control) => results.get(control) as TradingRiskControlResult);
  const outcome: TradingRiskOutcome = controls.some((result) => result.outcome === 'VIOLATED')
    ? 'VIOLATED'
    : controls.every((result) => result.outcome === 'SATISFIED' || (result.outcome === 'DISABLED' && disabled.has(result.control)))
      ? 'SATISFIED'
      : 'UNAVAILABLE';

  const approvalTriggers: string[] = [];
  if (pair !== undefined) {
    if (pair.approval.restricted) approvalTriggers.push('PAIR_RESTRICTED');
    if (pair.approval.notionalAbove !== undefined && notional !== undefined && compareRationals(notional, rationalOfDecimal(pair.approval.notionalAbove)) > 0) approvalTriggers.push('NOTIONAL_ABOVE_REVIEW_THRESHOLD');
    if (pair.approval.deviationAboveBasisPoints !== undefined && deviation !== undefined && compareRationals(deviation, { numerator: BigInt(pair.approval.deviationAboveBasisPoints), denominator: 1n }) > 0) {
      approvalTriggers.push('DEVIATION_ABOVE_REVIEW_THRESHOLD');
    }
  }
  if (profile.approval.sensitiveOwners.includes(proposal.ownerAccount)) approvalTriggers.push('SENSITIVE_OWNER');
  if (profile.approval.sensitiveDelegates.includes(proposal.delegateAccount)) approvalTriggers.push('SENSITIVE_DELEGATE');
  const disposition: TradingRiskDisposition = outcome === 'VIOLATED' ? 'PROHIBITED' : outcome === 'UNAVAILABLE' ? 'WITHHELD' : approvalTriggers.length > 0 ? 'APPROVAL_REQUIRED' : 'ELIGIBLE';

  const limitations = ['LIMIT_PRICE_IS_NOT_EXECUTION_PRICE', 'DELEGATION_REQUIRES_PRE_SIGN_REREAD', 'EVIDENCE_DIGEST_IS_NOT_A_SIGNATURE'];
  if (exposurePolicy.mode === 'enforce') limitations.push('AGGREGATE_EXPOSURE_NOT_RESERVED');
  if (orderPolicy.mode === 'enforce') limitations.push('ACTIVE_ORDERS_NOT_RESERVED');
  if (simulated) limitations.push('SIMULATED_FACTS');

  const body = {
    schema: TRADING_RISK_ASSESSMENT_SCHEMA,
    organizationId: proposal.organizationId,
    principalId: proposal.principalId,
    requestId: proposal.requestId,
    proposalDigest: accepted.digest,
    action,
    network: proposal.network,
    ownerAccount: proposal.ownerAccount,
    delegateAccount: proposal.delegateAccount,
    pair: { base: tradeAssetToken(terms.base), quote: tradeAssetToken(terms.quote) },
    side: terms.side,
    quantity: terms.quantity,
    limitPrice: formatTradePrice(terms.limitPrice),
    ownerGiven: { asset: tradeAssetToken(terms.side === 'sell' ? terms.base : terms.quote), value: ownerGivenValue },
    riskProfile: { profileId: profile.profileId, profileVersion: profile.profileVersion, digest: profile.digest },
    ...(governanceProfile.value !== undefined ? { governanceProfile: governanceProfile.value } : {}),
    outcome,
    disposition,
    approvalTriggers: outcome === 'SATISFIED' ? approvalTriggers.sort() : [],
    controls,
    sources,
    freshness: [...freshness].sort((left, right) => (left.fact < right.fact ? -1 : left.fact > right.fact ? 1 : 0)),
    simulatedFacts: simulated,
    limitations: limitations.sort(),
    assessedAt: at,
    relianceMaxAgeSeconds: profile.assessmentMaxAgeSeconds,
  };
  return Object.freeze({ assessed: true as const, evidence: deepFreeze(sealRiskRecord(TRADING_RISK_ASSESSMENT_DIGEST_DOMAIN, body)) as unknown as TradingRiskAssessmentEvidence });
}


function withinLimit(
  record: (control: TradingRiskControlId, outcome: TradingRiskControlOutcome, reason: string, detail?: { readonly observed?: string; readonly limit?: string }) => void,
  control: TradingRiskControlId,
  value: TradeRational,
  maximum: string,
  observed: string,
): void {
  const order = compareRationals(value, rationalOfDecimal(maximum));
  record(control, order <= 0 ? 'SATISFIED' : 'VIOLATED', order <= 0 ? 'WITHIN_MAXIMUM' : 'EXCEEDS_MAXIMUM', { observed, limit: maximum });
}

/** Same currency code, regardless of issuer — used only to name an issuer refusal precisely. */
function sameCode(left: TradeAsset, right: TradeAsset): boolean {
  if (left.kind === 'xrp' || right.kind === 'xrp') return left.kind === right.kind;
  return left.currency === right.currency;
}

function smallerOf(left: number, right: number): number {
  return left < right ? left : right;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
    Object.freeze(value);
  } else if (typeof value === 'object' && value !== null) {
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}
