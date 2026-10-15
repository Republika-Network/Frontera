import { tradeAssetToken } from '../domain/trade-asset.js';
import { checkTradeDelegationReliance, type TradeDelegationPolicy } from '../domain/trade-delegation-assessment.js';
import { isTradeInstant } from '../domain/trade-delegation.js';
import { isPlainRecord, isTradeIdentifier } from '../domain/trade-grammar.js';
import { validateTradeProposal } from '../domain/trade-proposal.js';
import { TRADE_PARAMETER_DIMENSION_IDS, compileTradeProposal, createTradeGovernanceBinding, tradeResourceOf, type TradeGovernedActionIntent } from '../domain/trade-governance.js';
import {
  TRADING_RISK_ASSESSMENT_DIGEST_DOMAIN,
  TRADING_RISK_ASSESSMENT_SCHEMA,
  TRADING_RISK_CONTROLS,
  tradingPairPolicyFor,
  tradingRiskDisabledControls,
  type TradingRiskDisposition,
} from './trade-risk-assessment.js';
import { freshnessAt, isSafeIntegerIn, millisecondsBetween, plainList, plainRiskData, unsealRiskRecord } from './trade-risk-exact.js';
import { parseTradingRiskProfile, tradingRiskProfileReference, type TradingRiskProfile } from './trade-risk-profile.js';

/**
 * Relying on trading-risk evidence, and what a trusted CORE-04 source may
 * state from it (TRADE-03).
 *
 * `checkTradingRiskReliance` is the consumer side: it decides whether a
 * previously produced assessment may be relied on **now**, for exactly this
 * proposal, under exactly the profile in force — never permanently, and
 * never because the record says so. It recomputes the digest, re-derives which
 * controls the current profile allows to be disabled, re-checks every source
 * against the current allowlists and every fact's freshness at the reliance
 * instant.
 *
 * `tradingRiskContextReadings` is what a **trusted** context provider (a
 * reviewed composition edge — none exists yet, see the TRADE-03 doc) would
 * hand to the Trusted Context Boundary: fact values bound to the proposal by
 * its digest, so a policy rule can require `tradeProposalDigest` (an exact
 * CORE-03 parameter) to equal the attested fact. A reading for another
 * proposal therefore cannot satisfy this one, and an applicant can neither
 * state these facts (they are reserved context keys) nor choose their source.
 */

export const TRADING_RISK_RELIANCE_REFUSALS = Object.freeze({
  EXPECTATION_INVALID: 'RISK_RELIANCE_EXPECTATION_INVALID',
  MALFORMED: 'RISK_RELIANCE_MALFORMED',
  DIGEST_MISMATCH: 'RISK_RELIANCE_DIGEST_MISMATCH',
  NOT_SATISFIED: 'RISK_RELIANCE_NOT_SATISFIED',
  ORGANIZATION_MISMATCH: 'RISK_RELIANCE_ORGANIZATION_MISMATCH',
  PROPOSAL_MISMATCH: 'RISK_RELIANCE_PROPOSAL_MISMATCH',
  PROFILE_MISMATCH: 'RISK_RELIANCE_PROFILE_MISMATCH',
  PROFILE_NOT_IN_FORCE: 'RISK_RELIANCE_PROFILE_NOT_IN_FORCE',
  GOVERNANCE_PROFILE_MISMATCH: 'RISK_RELIANCE_GOVERNANCE_PROFILE_MISMATCH',
  CONTROLS_INCOMPLETE: 'RISK_RELIANCE_CONTROLS_INCOMPLETE',
  SOURCE_NOT_ACCEPTED: 'RISK_RELIANCE_SOURCE_NOT_ACCEPTED',
  SIMULATED_NOT_ACCEPTED: 'RISK_RELIANCE_SIMULATED_NOT_ACCEPTED',
  FROM_FUTURE: 'RISK_RELIANCE_FROM_FUTURE',
  STALE: 'RISK_RELIANCE_STALE',
  FACT_STALE: 'RISK_RELIANCE_FACT_STALE',
} as const);

export type TradingRiskRelianceRefusal = (typeof TRADING_RISK_RELIANCE_REFUSALS)[keyof typeof TRADING_RISK_RELIANCE_REFUSALS];

export interface TradingRiskRelianceExpectation {
  /** The proposal the evidence must be for (raw or canonical; validated here). */
  readonly proposal: unknown;
  /** The trusted profile **in force now** (data form). */
  readonly profile: unknown;
  /** The trusted clock's instant of reliance. */
  readonly at: string;
  /** The Governance Profile the request resolved to; when given, the evidence must name exactly it. */
  readonly governanceProfile?: { readonly id: string; readonly version: number };
  /**
   * F-1: the instant the projected readings are stated at — the Kernel's evaluation instant, which the
   * Trusted Context Boundary classifies against. Never later than `at`. Absent: `at`. It only moves the
   * start of each reading's window; the window's end stays the absolute, fact-derived `validUntilMs`.
   */
  readonly readingAt?: string;
}

/**
 * F-1 — the reading instant: `readingAt` when given (it must be a trusted instant no later than the
 * reliance instant `at`), else `at`. `undefined` when it is malformed or later than `at`: a reading is
 * never stated after the instant its facts were relied on.
 */
function readingInstantOf(expected: { readonly at: string; readonly readingAt?: unknown }): { readonly ms: number; readonly instant: string } | undefined {
  const reliance = Date.parse(expected.at);
  if (expected.readingAt === undefined) return { ms: reliance, instant: expected.at };
  if (!isTradeInstant(expected.readingAt)) return undefined;
  const reading = Date.parse(expected.readingAt);
  return reading <= reliance ? { ms: reading, instant: expected.readingAt } : undefined;
}

export type TradingRiskReliance =
  | { readonly reliable: true; readonly disposition: Extract<TradingRiskDisposition, 'ELIGIBLE' | 'APPROVAL_REQUIRED'>; readonly evidenceDigest: string; readonly validUntilMs: number }
  | { readonly reliable: false; readonly code: TradingRiskRelianceRefusal };

const RR = TRADING_RISK_RELIANCE_REFUSALS;

function refuse(code: TradingRiskRelianceRefusal): TradingRiskReliance {
  return Object.freeze({ reliable: false as const, code });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isPlainRecord(value) ? (value as Record<string, unknown>) : undefined;
}

function sourceAccepted(profile: TradingRiskProfile, key: string, sourceId: unknown): boolean {
  if (typeof sourceId !== 'string') return false;
  switch (key) {
    case 'reference':
    case 'valuation':
    case 'exposureValuation':
      return profile.marketReference.mode === 'enforce' && profile.marketReference.sourceIds.includes(sourceId);
    case 'exposure':
      return profile.exposure.mode === 'enforce' && profile.exposure.sourceIds.includes(sourceId);
    case 'activeOrders':
      return profile.activeOrders.mode === 'enforce' && profile.activeOrders.sourceIds.includes(sourceId);
    case 'delegation':
      return profile.delegation.sourceId === sourceId;
    default:
      return false;
  }
}

/**
 * Whether `evidence` may be relied on at `expected.at` for `expected.proposal`
 * under `expected.profile`. Every refusal is final for this use; nothing is
 * repaired or re-read. A satisfied record is reliable for at most the
 * profile's `assessmentMaxAgeSeconds` and never beyond any fact's freshness.
 */
export function checkTradingRiskReliance(evidence: unknown, expected: TradingRiskRelianceExpectation): TradingRiskReliance {
  if (!isPlainRecord(expected) || !isTradeInstant(expected.at)) return refuse(RR.EXPECTATION_INVALID);
  const validation = validateTradeProposal(expected.proposal);
  const parsedProfile = parseTradingRiskProfile(expected.profile);
  if (!validation.valid || !parsedProfile.valid) return refuse(RR.EXPECTATION_INVALID);
  const { proposal, terms } = validation.accepted;
  const profile = parsedProfile.profile;
  const at = expected.at;

  if (!isPlainRecord(plainRiskData(evidence))) return refuse(RR.MALFORMED);
  const copy = unsealRiskRecord(TRADING_RISK_ASSESSMENT_DIGEST_DOMAIN, evidence);
  if (copy === undefined) return refuse(RR.DIGEST_MISMATCH);
  if (copy['schema'] !== TRADING_RISK_ASSESSMENT_SCHEMA) return refuse(RR.MALFORMED);
  const disposition = copy['disposition'];
  if (copy['outcome'] !== 'SATISFIED' || (disposition !== 'ELIGIBLE' && disposition !== 'APPROVAL_REQUIRED')) return refuse(RR.NOT_SATISFIED);

  // Bindings: organization, proposal, profile identity, governance profile.
  if (copy['organizationId'] !== proposal.organizationId || profile.organizationId !== proposal.organizationId) return refuse(RR.ORGANIZATION_MISMATCH);
  if (
    copy['proposalDigest'] !== validation.accepted.digest ||
    copy['principalId'] !== proposal.principalId ||
    copy['requestId'] !== proposal.requestId ||
    copy['network'] !== proposal.network ||
    copy['ownerAccount'] !== proposal.ownerAccount ||
    copy['delegateAccount'] !== proposal.delegateAccount ||
    copy['side'] !== terms.side
  ) {
    return refuse(RR.PROPOSAL_MISMATCH);
  }
  const riskProfile = asRecord(copy['riskProfile']);
  if (riskProfile === undefined || riskProfile['profileId'] !== profile.profileId || riskProfile['profileVersion'] !== profile.profileVersion || riskProfile['digest'] !== profile.digest) return refuse(RR.PROFILE_MISMATCH);
  if (expected.governanceProfile !== undefined) {
    const recorded = asRecord(copy['governanceProfile']);
    if (recorded === undefined || recorded['id'] !== expected.governanceProfile.id || recorded['version'] !== expected.governanceProfile.version) return refuse(RR.GOVERNANCE_PROFILE_MISMATCH);
  }
  const inWindow = millisecondsBetween(profile.effectiveFrom, at) >= 0 && millisecondsBetween(at, profile.expiresAt) > 0;
  if (profile.status !== 'active' || !inWindow || copy['action'] !== profile.action || profile.network !== proposal.network) return refuse(RR.PROFILE_NOT_IN_FORCE);

  // Completeness: exactly the sixteen controls, each satisfied or disabled *as the current profile sanctions*.
  const pair = tradingPairPolicyFor(profile, terms.base, terms.quote);
  const pairText = asRecord(copy['pair']);
  if (pair === undefined || pairText?.['base'] !== tradeAssetToken(terms.base) || pairText['quote'] !== tradeAssetToken(terms.quote)) return refuse(RR.CONTROLS_INCOMPLETE);
  const disabled = tradingRiskDisabledControls(profile, pair, terms.side);
  const controls = plainList(copy['controls'], TRADING_RISK_CONTROLS.length);
  if (controls === undefined || controls.length !== TRADING_RISK_CONTROLS.length) return refuse(RR.CONTROLS_INCOMPLETE);
  for (let index = 0; index < TRADING_RISK_CONTROLS.length; index += 1) {
    const control = asRecord(controls[index]);
    const id = TRADING_RISK_CONTROLS[index] as (typeof TRADING_RISK_CONTROLS)[number];
    if (control === undefined || control['control'] !== id) return refuse(RR.CONTROLS_INCOMPLETE);
    const outcome = control['outcome'];
    if (outcome === 'SATISFIED' && !disabled.has(id)) continue;
    if (outcome === 'DISABLED' && disabled.has(id)) continue;
    return refuse(RR.CONTROLS_INCOMPLETE);
  }

  // Sources: each one recorded must still be accepted by the profile in force.
  const sources = asRecord(copy['sources']);
  if (sources === undefined) return refuse(RR.MALFORMED);
  for (const [key, value] of Object.entries(sources)) {
    const source = asRecord(value);
    if (source === undefined || !sourceAccepted(profile, key, source['sourceId'])) return refuse(RR.SOURCE_NOT_ACCEPTED);
    if (source['provenance'] === 'simulated' && profile.factProvenance !== 'simulated-permitted') return refuse(RR.SIMULATED_NOT_ACCEPTED);
  }
  if (copy['simulatedFacts'] !== false && profile.factProvenance !== 'simulated-permitted') return refuse(RR.SIMULATED_NOT_ACCEPTED);

  // Time: the record itself, then every fact it relied on.
  const assessedAt = copy['assessedAt'];
  const recordedBound = copy['relianceMaxAgeSeconds'];
  if (!isTradeInstant(assessedAt) || !isSafeIntegerIn(recordedBound, 1, 300)) return refuse(RR.MALFORMED);
  const age = millisecondsBetween(assessedAt, at);
  if (age < 0) return refuse(RR.FROM_FUTURE);
  const bound = recordedBound < profile.assessmentMaxAgeSeconds ? recordedBound : profile.assessmentMaxAgeSeconds;
  if (age > bound * 1000) return refuse(RR.STALE);
  let validUntilMs = Date.parse(assessedAt) + bound * 1000;
  const freshness = plainList(copy['freshness'], 16);
  if (freshness === undefined) return refuse(RR.MALFORMED);
  for (const entry of freshness) {
    const fact = asRecord(entry);
    const maxAge = fact?.['maxAgeSeconds'];
    const observedAt = fact?.['observedAt'];
    if (fact === undefined || !isSafeIntegerIn(maxAge, 1, 31_536_000) || !isTradeInstant(observedAt)) return refuse(RR.MALFORMED);
    const verdict = freshnessAt(observedAt, maxAge, at);
    if (verdict === 'future') return refuse(RR.FROM_FUTURE);
    if (verdict !== 'fresh') return refuse(RR.FACT_STALE);
    const expiresMs = Date.parse(observedAt) + maxAge * 1000;
    if (expiresMs < validUntilMs) validUntilMs = expiresMs;
  }
  const profileEnd = Date.parse(profile.expiresAt);
  if (profileEnd < validUntilMs) validUntilMs = profileEnd;
  return Object.freeze({ reliable: true as const, disposition, evidenceDigest: copy['digest'] as string, validUntilMs });
}

// ── CORE-04 projection ───────────────────────────────────────────────────────

/**
 * The fact classes a trading Governance Profile declares as **material**
 * (required): each must be admitted from an authoritative, organization-scoped
 * source, fresh and unconflicted, or the Kernel denies before policy runs.
 *
 * - `trade.risk.assessedProposal` — the digest of the proposal whose risk
 *   assessment is reliable now. Policy denies unless it equals the request's
 *   `tradeProposalDigest` parameter.
 * - `trade.risk.assessedAmount` / `trade.risk.assessedAsset` — the governed
 *   leg of that proposal (`TakerGets`, canonical decimal, and its P9 asset id).
 *   Policy denies unless they equal the request's `amount` and `currency`.
 *   The digest parameter is an opaque applicant token: without these two, a
 *   request could repeat an assessed digest beside a different amount or
 *   asset, and P10 ceilings and P7 reservations would measure the wrong leg.
 * - `trade.risk.profile` — `<profileId>@<version>` of the trading-risk profile
 *   the assessment relied on. Policy denies unless it equals the configured one.
 * - `trade.risk.approvalRequired` — `true` when a satisfied order is marked for
 *   review. Policy requires CORE-05 approval when it is `true`.
 * - `trade.delegation.offercreate` — the digest of the proposal whose XLS-75
 *   delegation assessment is reliable now. Policy denies unless it equals
 *   `tradeProposalDigest`.
 */
export const TRADE_RISK_FACT_CLASSES = Object.freeze({
  assessedProposal: 'trade.risk.assessedProposal',
  assessedAmount: 'trade.risk.assessedAmount',
  assessedAsset: 'trade.risk.assessedAsset',
  assessedNetwork: 'trade.risk.assessedNetwork',
  assessedDelegate: 'trade.risk.assessedDelegate',
  assessedBaseAsset: 'trade.risk.assessedBaseAsset',
  assessedQuoteAsset: 'trade.risk.assessedQuoteAsset',
  assessedSide: 'trade.risk.assessedSide',
  assessedQuantity: 'trade.risk.assessedQuantity',
  profile: 'trade.risk.profile',
  approvalRequired: 'trade.risk.approvalRequired',
  delegation: 'trade.delegation.offercreate',
} as const);

/**
 * K1 — the full intent binding: each TRADE-01 parameter dimension of the
 * compiled intent, and the fact class that attests its assessed value. With
 * the governed amount and asset, and the Kernel's own action, resource
 * (network + owner) and organization in the query, every field of the
 * compiled `GovernedActionIntent` but the request identity (idempotency key,
 * correlation id) is bound to the assessed proposal; the digest binds every
 * proposal field (flags, `takerPays`, expiration, requested validity …) in
 * turn.
 */
export const TRADE_INTENT_BINDING_FACTS: Readonly<Record<(typeof TRADE_PARAMETER_DIMENSION_IDS)[keyof typeof TRADE_PARAMETER_DIMENSION_IDS], string>> = Object.freeze({
  [TRADE_PARAMETER_DIMENSION_IDS.proposalDigest]: TRADE_RISK_FACT_CLASSES.assessedProposal,
  [TRADE_PARAMETER_DIMENSION_IDS.network]: TRADE_RISK_FACT_CLASSES.assessedNetwork,
  [TRADE_PARAMETER_DIMENSION_IDS.delegateAccount]: TRADE_RISK_FACT_CLASSES.assessedDelegate,
  [TRADE_PARAMETER_DIMENSION_IDS.baseAsset]: TRADE_RISK_FACT_CLASSES.assessedBaseAsset,
  [TRADE_PARAMETER_DIMENSION_IDS.quoteAsset]: TRADE_RISK_FACT_CLASSES.assessedQuoteAsset,
  [TRADE_PARAMETER_DIMENSION_IDS.side]: TRADE_RISK_FACT_CLASSES.assessedSide,
  [TRADE_PARAMETER_DIMENSION_IDS.quantity]: TRADE_RISK_FACT_CLASSES.assessedQuantity,
});

/** The intent the proposal compiles to under the profile's action — the one source of every bound value. `undefined` if it does not compile. */
function compiledIntentOf(proposal: unknown, action: string, organizationId: string, principalId: string): TradeGovernedActionIntent | undefined {
  try {
    return compileTradeProposal(proposal, createTradeGovernanceBinding({ action }), { organizationId, principalId }).intent;
  } catch {
    return undefined;
  }
}

export interface TradeContextReading {
  readonly key: string;
  readonly value: string | boolean;
  readonly observedAt: string;
  /** Whole seconds the reading stays valid after `observedAt` — never longer than the evidence it came from. */
  readonly maxAgeSeconds: number;
  /** The evidence digest the reading was derived from. */
  readonly reference: string;
}

export type TradeContextProjection =
  | { readonly projected: true; readonly readings: readonly TradeContextReading[] }
  | { readonly projected: false; readonly code: TradingRiskRelianceRefusal | 'RISK_PROJECTION_QUERY_MISMATCH' };

/**
 * The trusted fields of the CORE-04 query the readings answer — the Kernel's
 * own action, resource scope and organization for the request. Never from the
 * applicant: the query carries no applicant-chosen field.
 */
export interface TradeContextQueryBinding {
  readonly action: string;
  readonly resourceScope: string;
  readonly organizationId: string;
}

function queryMatches(binding: TradeContextQueryBinding, expected: { readonly action: string; readonly resource: string; readonly organizationId: string }): boolean {
  return isPlainRecord(binding) && binding.action === expected.action && binding.resourceScope === expected.resource && binding.organizationId === expected.organizationId;
}

function wholeSecondsBetween(fromMs: number, toMs: number): number {
  const difference = toMs - fromMs;
  return (difference - (difference % 1000)) / 1000;
}

/**
 * The readings a trusted provider may hand to the Trusted Context Boundary for
 * one risk assessment — only when `checkTradingRiskReliance` holds now, and
 * then with an observation time of `at` and a lifetime that ends no later
 * than the earliest freshness bound inside the evidence. An unreliable record
 * yields **no reading at all**: a missing material fact is the Kernel's denial.
 */
export function tradingRiskContextReadings(evidence: unknown, expected: TradingRiskRelianceExpectation, query: TradeContextQueryBinding): TradeContextProjection {
  const reliance = checkTradingRiskReliance(evidence, expected);
  if (!reliance.reliable) return Object.freeze({ projected: false as const, code: reliance.code });
  const validation = validateTradeProposal(expected.proposal);
  const parsedProfile = parseTradingRiskProfile(expected.profile);
  if (!validation.valid || !parsedProfile.valid) return Object.freeze({ projected: false as const, code: RR.EXPECTATION_INVALID });
  const { proposal } = validation.accepted;
  // The readings answer exactly the request the Kernel is deciding: its action, its owner resource, its organization.
  if (!queryMatches(query, { action: parsedProfile.profile.action, resource: tradeResourceOf(validation.accepted), organizationId: proposal.organizationId })) {
    return Object.freeze({ projected: false as const, code: 'RISK_PROJECTION_QUERY_MISMATCH' as const });
  }
  const readingAt = readingInstantOf(expected);
  if (readingAt === undefined) return Object.freeze({ projected: false as const, code: RR.EXPECTATION_INVALID });
  // At least a second of validity must remain at the reliance instant; the reading's window then runs from the
  // reading instant to the same absolute end — its end is never extended (whole seconds, rounded down).
  if (wholeSecondsBetween(Date.parse(expected.at), reliance.validUntilMs) < 1) return Object.freeze({ projected: false as const, code: RR.STALE });
  const maxAgeSeconds = wholeSecondsBetween(readingAt.ms, reliance.validUntilMs);
  // Every bound value is read from the compiled intent itself, so a reading can never disagree with what compilation produces.
  const intent = compiledIntentOf(proposal, parsedProfile.profile.action, proposal.organizationId, proposal.principalId);
  if (intent === undefined || intent.parameters[TRADE_PARAMETER_DIMENSION_IDS.proposalDigest] !== validation.accepted.digest) return Object.freeze({ projected: false as const, code: RR.EXPECTATION_INVALID });
  const base = { observedAt: readingAt.instant, maxAgeSeconds, reference: reliance.evidenceDigest };
  const parameterReadings = Object.entries(TRADE_INTENT_BINDING_FACTS).map(([dimension, key]) => Object.freeze({ key, value: intent.parameters[dimension] as string, ...base }));
  return Object.freeze({
    projected: true as const,
    readings: Object.freeze([
      ...parameterReadings,
      Object.freeze({ key: TRADE_RISK_FACT_CLASSES.assessedAmount, value: intent.amount.value, ...base }),
      Object.freeze({ key: TRADE_RISK_FACT_CLASSES.assessedAsset, value: intent.amount.currency, ...base }),
      Object.freeze({ key: TRADE_RISK_FACT_CLASSES.profile, value: tradingRiskProfileReference(parsedProfile.profile), ...base }),
      Object.freeze({ key: TRADE_RISK_FACT_CLASSES.approvalRequired, value: reliance.disposition === 'APPROVAL_REQUIRED', ...base }),
    ]),
  });
}

/**
 * The delegation reading for one TRADE-02 assessment: the proposal digest, but
 * only when TRADE-02's own reliance check holds now under the trusted policy.
 * Its lifetime ends when the assessment's observation stops being fresh.
 * `UNAVAILABLE`, `NOT_AUTHORIZED`, another organization's, another proposal's
 * or a stale assessment yields no reading.
 */
export function tradeDelegationContextReading(
  assessment: unknown,
  expected: { readonly proposal: unknown; readonly at: string; readonly policy: TradeDelegationPolicy; readonly action: string; readonly readingAt?: string },
  query: TradeContextQueryBinding,
): { readonly projected: true; readonly reading: TradeContextReading } | { readonly projected: false; readonly code: string } {
  if (!isPlainRecord(expected) || !isTradeInstant(expected.at)) return { projected: false, code: RR.EXPECTATION_INVALID };
  const validation = validateTradeProposal(expected.proposal);
  if (!validation.valid) return { projected: false, code: RR.EXPECTATION_INVALID };
  if (!queryMatches(query, { action: expected.action, resource: tradeResourceOf(validation.accepted), organizationId: validation.accepted.proposal.organizationId })) {
    return { projected: false, code: 'RISK_PROJECTION_QUERY_MISMATCH' };
  }
  const reliance = checkTradeDelegationReliance(assessment, { proposal: validation.accepted.proposal, proposalDigest: validation.accepted.digest, at: expected.at, policy: expected.policy });
  if (!reliance.reliable) return { projected: false, code: reliance.code };
  const copy = plainRiskData(assessment) as { readonly digest: string; readonly timing: { readonly observedAt: string; readonly maxAgeSeconds: number } };
  const bound = copy.timing.maxAgeSeconds < expected.policy.maxAgeSeconds ? copy.timing.maxAgeSeconds : expected.policy.maxAgeSeconds;
  const readingAt = readingInstantOf(expected);
  if (readingAt === undefined) return { projected: false, code: RR.EXPECTATION_INVALID };
  const freshUntilMs = Date.parse(copy.timing.observedAt) + bound * 1000;
  // As for the risk readings: a second must remain at the reliance instant, and the window's absolute end is the observation's freshness end.
  if (wholeSecondsBetween(Date.parse(expected.at), freshUntilMs) < 1 || !isTradeIdentifier(expected.policy.sourceId)) return { projected: false, code: 'DELEGATION_NOT_RELIABLE' };
  const maxAgeSeconds = wholeSecondsBetween(readingAt.ms, freshUntilMs);
  return {
    projected: true,
    reading: Object.freeze({ key: TRADE_RISK_FACT_CLASSES.delegation, value: validation.accepted.digest, observedAt: readingAt.instant, maxAgeSeconds, reference: copy.digest }),
  };
}
