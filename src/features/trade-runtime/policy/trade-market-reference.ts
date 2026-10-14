import type { TradeAsset } from '../domain/trade-asset.js';
import { tradeAssetsEqual } from '../domain/trade-asset.js';
import { isTradeInstant } from '../domain/trade-delegation.js';
import { isTradeIdentifier, isTradeNetwork, isTradeReference, type TradeNetwork } from '../domain/trade-grammar.js';
import type { TradePrice } from '../domain/trade-price.js';
import {
  assetRecord,
  closedRecord,
  freshnessAt,
  isSafeIntegerIn,
  parseRiskAsset,
  parseRiskPrice,
  priceRecord,
  sealRiskRecord,
  unsealRiskRecord,
} from './trade-risk-exact.js';
import { TRADE_REFERENCE_CONVENTIONS, TRADING_RISK_MAXIMUM_FACT_AGE_SECONDS, type TradeFactProvenancePolicy, type TradeMarketReferencePolicy, type TradeReferenceConvention } from './trade-risk-profile.js';

/**
 * The trusted market reference (TRADE-03): one closed, sealed snapshot of a
 * reference price for one exact pair, from one configured source.
 *
 * > A snapshot is trusted because the **trusted composition** obtained it from
 * > a **configured source** — never because an applicant supplied or named
 * > it. A proposal's `referenceContextId` is a reference the applicant states;
 * > it is never a price and never selects one.
 *
 * - The price is quote units per one base unit, an exact positive rational —
 *   TRADE-01's `TradePrice`. A snapshot for the inverted pair is a different
 *   snapshot and is never silently inverted.
 * - The convention (`mid`, `bid`, `ask`, `consolidated`) is explicit. A
 *   reference is a yardstick for a risk check; it is never an executable price.
 * - The provenance states whether the reading is `operational` or `simulated`.
 *   A profile that admits operational sources only refuses a simulated one, and
 *   every assessment records which it relied on (SEC-TRADE03-20).
 * - `digest` is an integrity and correlation primitive (anyone can compute it):
 *   it shows a snapshot was not altered after it was sealed, not who sealed it.
 *
 * TRADE-03 adds **no market-data client**. Tests use deterministic fake sources.
 */

export const TRADE_MARKET_SNAPSHOT_SCHEMA = 'frontera.trade-market-price-snapshot.v1';
export const TRADE_MARKET_SNAPSHOT_DIGEST_DOMAIN = 'frontera.trade-market-price-snapshot-digest.v1';

export type TradeFactProvenanceKind = 'operational' | 'simulated';

export interface TradeFactProvenance {
  readonly kind: TradeFactProvenanceKind;
  /** How the source produced the reading (an identifier, e.g. `validated-ledger-book`, `fixture`). */
  readonly method: string;
}

export interface TrustedMarketPriceSnapshot {
  readonly schema: typeof TRADE_MARKET_SNAPSHOT_SCHEMA;
  readonly sourceId: string;
  /** The trust scope: the organization the source serves. */
  readonly organizationId: string;
  readonly network: TradeNetwork;
  readonly base: TradeAsset;
  readonly quote: TradeAsset;
  /** Quote per base, exact. */
  readonly price: TradePrice;
  readonly convention: TradeReferenceConvention;
  readonly observedAt: string;
  /** The source's own freshness horizon for this reading. */
  readonly maxAgeSeconds: number;
  readonly sourceReference: string;
  readonly provenance: TradeFactProvenance;
  readonly digest: string;
}

/** The fields a trusted source states; the snapshot is these plus a schema and a digest. */
export interface TrustedMarketPriceReading {
  readonly sourceId: string;
  readonly organizationId: string;
  readonly network: TradeNetwork;
  readonly base: TradeAsset;
  readonly quote: TradeAsset;
  readonly price: TradePrice;
  readonly convention: TradeReferenceConvention;
  readonly observedAt: string;
  readonly maxAgeSeconds: number;
  readonly sourceReference: string;
  readonly provenance: TradeFactProvenance;
}

export function parseTradeFactProvenance(raw: unknown): TradeFactProvenance | undefined {
  const entries = closedRecord(raw, ['kind', 'method']);
  if (entries === undefined) return undefined;
  const kind = entries.get('kind');
  const method = entries.get('method');
  if ((kind !== 'operational' && kind !== 'simulated') || !isTradeIdentifier(method)) return undefined;
  return Object.freeze({ kind, method });
}

/** Whether the profile's provenance policy admits a reading of this kind. */
export function provenanceAdmitted(policy: TradeFactProvenancePolicy, provenance: TradeFactProvenance): boolean {
  return provenance.kind === 'operational' || policy === 'simulated-permitted';
}

function snapshotData(reading: TrustedMarketPriceReading): Record<string, unknown> {
  return {
    schema: TRADE_MARKET_SNAPSHOT_SCHEMA,
    sourceId: reading.sourceId,
    organizationId: reading.organizationId,
    network: reading.network,
    base: assetRecord(reading.base),
    quote: assetRecord(reading.quote),
    price: priceRecord(reading.price),
    convention: reading.convention,
    observedAt: reading.observedAt,
    maxAgeSeconds: reading.maxAgeSeconds,
    sourceReference: reading.sourceReference,
    provenance: { kind: reading.provenance.kind, method: reading.provenance.method },
  };
}

const SNAPSHOT_FIELDS = ['schema', 'sourceId', 'organizationId', 'network', 'base', 'quote', 'price', 'convention', 'observedAt', 'maxAgeSeconds', 'sourceReference', 'provenance'] as const;

function readSnapshot(entries: ReadonlyMap<string, unknown>): Omit<TrustedMarketPriceSnapshot, 'digest'> | undefined {
  if (entries.get('schema') !== TRADE_MARKET_SNAPSHOT_SCHEMA) return undefined;
  const sourceId = entries.get('sourceId');
  const organizationId = entries.get('organizationId');
  const network = entries.get('network');
  const base = parseRiskAsset(entries.get('base'));
  const quote = parseRiskAsset(entries.get('quote'));
  const price = parseRiskPrice(entries.get('price'));
  const convention = entries.get('convention');
  const observedAt = entries.get('observedAt');
  const maxAgeSeconds = entries.get('maxAgeSeconds');
  const sourceReference = entries.get('sourceReference');
  const provenance = parseTradeFactProvenance(entries.get('provenance'));
  if (!isTradeIdentifier(sourceId) || !isTradeIdentifier(organizationId) || !isTradeNetwork(network)) return undefined;
  if (base === undefined || quote === undefined || tradeAssetsEqual(base, quote) || price === undefined) return undefined;
  if (typeof convention !== 'string' || !(TRADE_REFERENCE_CONVENTIONS as readonly string[]).includes(convention)) return undefined;
  if (!isTradeInstant(observedAt) || !isSafeIntegerIn(maxAgeSeconds, 1, TRADING_RISK_MAXIMUM_FACT_AGE_SECONDS) || !isTradeReference(sourceReference) || provenance === undefined) return undefined;
  return Object.freeze({
    schema: TRADE_MARKET_SNAPSHOT_SCHEMA,
    sourceId,
    organizationId,
    network,
    base,
    quote,
    price,
    convention: convention as TradeReferenceConvention,
    observedAt,
    maxAgeSeconds,
    sourceReference,
    provenance,
  });
}

/**
 * Seals a reading from a trusted source into a snapshot. The trusted side
 * calls this; the reading is validated exactly as a received snapshot would be
 * and a malformed reading throws `RangeError` — a source is never repaired.
 */
export function sealTrustedMarketPriceSnapshot(reading: TrustedMarketPriceReading): TrustedMarketPriceSnapshot {
  const data = snapshotData(reading);
  const entries = closedRecord(data, SNAPSHOT_FIELDS);
  const parsed = entries !== undefined ? readSnapshot(entries) : undefined;
  if (parsed === undefined) throw new RangeError('The market reading is malformed.');
  const sealed = sealRiskRecord(TRADE_MARKET_SNAPSHOT_DIGEST_DOMAIN, data);
  return Object.freeze({ ...parsed, digest: sealed.digest });
}

/** The canonical data form of a snapshot (what crosses a boundary and what the digest covers). */
export function trustedMarketPriceSnapshotData(snapshot: TrustedMarketPriceSnapshot): Record<string, unknown> {
  return { ...snapshotData(snapshot), digest: snapshot.digest };
}

/**
 * Reads a snapshot from data. Closed, every field in its grammar, and the
 * digest recomputed: a snapshot altered after sealing is `undefined`. Accepts
 * either a sealed snapshot object or its data form.
 */
export function parseTrustedMarketPriceSnapshot(raw: unknown): TrustedMarketPriceSnapshot | undefined {
  const data = isSealedSnapshotObject(raw) ? trustedMarketPriceSnapshotData(raw) : raw;
  const intact = unsealRiskRecord(TRADE_MARKET_SNAPSHOT_DIGEST_DOMAIN, data);
  if (intact === undefined) return undefined;
  const entries = closedRecord(intact, SNAPSHOT_FIELDS, ['digest']);
  const parsed = entries !== undefined ? readSnapshot(entries) : undefined;
  return parsed === undefined ? undefined : Object.freeze({ ...parsed, digest: intact['digest'] as string });
}

function isSealedSnapshotObject(raw: unknown): raw is TrustedMarketPriceSnapshot {
  if (typeof raw !== 'object' || raw === null) return false;
  const descriptor = Object.getOwnPropertyDescriptor(raw, 'price');
  const value: unknown = descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined;
  if (typeof value !== 'object' || value === null) return false;
  const numerator = Object.getOwnPropertyDescriptor(value, 'numerator');
  return numerator !== undefined && 'value' in numerator && typeof numerator.value === 'bigint';
}

// ── Selecting the reference for a pair ───────────────────────────────────────

export const TRADE_REFERENCE_REASONS = Object.freeze({
  AVAILABLE: 'REFERENCE_AVAILABLE',
  MISSING: 'REFERENCE_MISSING',
  MALFORMED: 'REFERENCE_MALFORMED',
  SOURCE_NOT_ACCEPTED: 'REFERENCE_SOURCE_NOT_ACCEPTED',
  ORGANIZATION_MISMATCH: 'REFERENCE_ORGANIZATION_MISMATCH',
  NETWORK_MISMATCH: 'REFERENCE_NETWORK_MISMATCH',
  ORIENTATION_INVERTED: 'REFERENCE_ORIENTATION_INVERTED',
  CONVENTION_NOT_ACCEPTED: 'REFERENCE_CONVENTION_NOT_ACCEPTED',
  SIMULATED_NOT_ACCEPTED: 'REFERENCE_SIMULATED_NOT_ACCEPTED',
  STALE: 'REFERENCE_STALE',
  FROM_FUTURE: 'REFERENCE_FROM_FUTURE',
  CONFLICT: 'REFERENCE_CONFLICT',
} as const);

export type TradeReferenceReason = (typeof TRADE_REFERENCE_REASONS)[keyof typeof TRADE_REFERENCE_REASONS];

export type TradeReferenceSelection = { readonly available: true; readonly snapshot: TrustedMarketPriceSnapshot } | { readonly available: false; readonly reason: TradeReferenceReason };

export interface TradeReferenceRequirement {
  readonly organizationId: string;
  readonly network: TradeNetwork;
  readonly base: TradeAsset;
  readonly quote: TradeAsset;
  readonly policy: TradeMarketReferencePolicy;
  readonly provenance: TradeFactProvenancePolicy;
  readonly at: string;
}

/** How specific a refusal is: when several snapshots fail, the most informative reason is reported. */
const REASON_RANK: readonly TradeReferenceReason[] = [
  TRADE_REFERENCE_REASONS.MISSING,
  TRADE_REFERENCE_REASONS.MALFORMED,
  TRADE_REFERENCE_REASONS.NETWORK_MISMATCH,
  TRADE_REFERENCE_REASONS.ORIENTATION_INVERTED,
  TRADE_REFERENCE_REASONS.ORGANIZATION_MISMATCH,
  TRADE_REFERENCE_REASONS.SOURCE_NOT_ACCEPTED,
  TRADE_REFERENCE_REASONS.CONVENTION_NOT_ACCEPTED,
  TRADE_REFERENCE_REASONS.SIMULATED_NOT_ACCEPTED,
  TRADE_REFERENCE_REASONS.FROM_FUTURE,
  TRADE_REFERENCE_REASONS.STALE,
];

/**
 * The one trusted reference for exactly `base`/`quote`, or why there is none.
 * Every candidate must be intact, for this organization and network, from an
 * accepted source, of an accepted convention and provenance, and fresh under
 * the stricter of the source's and the profile's bound. Two acceptable
 * snapshots that disagree on the price are a conflict — no winner is picked.
 * A snapshot for another pair is ignored; one for the inverted pair is named
 * as such and never inverted.
 */
export function selectTradeReference(candidates: readonly unknown[], requirement: TradeReferenceRequirement): TradeReferenceSelection {
  const accepted: TrustedMarketPriceSnapshot[] = [];
  let worst: TradeReferenceReason = TRADE_REFERENCE_REASONS.MISSING;
  const note = (reason: TradeReferenceReason): void => {
    if (REASON_RANK.indexOf(reason) > REASON_RANK.indexOf(worst)) worst = reason;
  };
  for (const candidate of candidates) {
    const snapshot = parseTrustedMarketPriceSnapshot(candidate);
    if (snapshot === undefined) {
      note(TRADE_REFERENCE_REASONS.MALFORMED);
      continue;
    }
    const samePair = tradeAssetsEqual(snapshot.base, requirement.base) && tradeAssetsEqual(snapshot.quote, requirement.quote);
    const inverted = tradeAssetsEqual(snapshot.base, requirement.quote) && tradeAssetsEqual(snapshot.quote, requirement.base);
    if (!samePair) {
      if (inverted) note(TRADE_REFERENCE_REASONS.ORIENTATION_INVERTED);
      continue;
    }
    if (snapshot.network !== requirement.network) note(TRADE_REFERENCE_REASONS.NETWORK_MISMATCH);
    else if (snapshot.organizationId !== requirement.organizationId) note(TRADE_REFERENCE_REASONS.ORGANIZATION_MISMATCH);
    else if (!requirement.policy.sourceIds.includes(snapshot.sourceId)) note(TRADE_REFERENCE_REASONS.SOURCE_NOT_ACCEPTED);
    else if (!requirement.policy.conventions.includes(snapshot.convention)) note(TRADE_REFERENCE_REASONS.CONVENTION_NOT_ACCEPTED);
    else if (!provenanceAdmitted(requirement.provenance, snapshot.provenance)) note(TRADE_REFERENCE_REASONS.SIMULATED_NOT_ACCEPTED);
    else {
      const freshness = freshnessAt(snapshot.observedAt, smallerOf(snapshot.maxAgeSeconds, requirement.policy.maxAgeSeconds), requirement.at);
      if (freshness === 'fresh') accepted.push(snapshot);
      else note(freshness === 'future' ? TRADE_REFERENCE_REASONS.FROM_FUTURE : TRADE_REFERENCE_REASONS.STALE);
    }
  }
  if (accepted.length === 0) return Object.freeze({ available: false as const, reason: worst });
  const first = accepted[0] as TrustedMarketPriceSnapshot;
  const agree = accepted.every((snapshot) => snapshot.price.numerator === first.price.numerator && snapshot.price.denominator === first.price.denominator);
  if (!agree) return Object.freeze({ available: false as const, reason: TRADE_REFERENCE_REASONS.CONFLICT });
  // Agreeing readings: the deterministic choice is the lowest digest.
  const chosen = [...accepted].sort((left, right) => (left.digest < right.digest ? -1 : left.digest > right.digest ? 1 : 0))[0] as TrustedMarketPriceSnapshot;
  return Object.freeze({ available: true as const, snapshot: chosen });
}

function smallerOf(left: number, right: number): number {
  return left < right ? left : right;
}
