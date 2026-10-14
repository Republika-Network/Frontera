import { formatTradeExactQuantity, type TradeAsset } from '../domain/trade-asset.js';
import { isTradeInstant } from '../domain/trade-delegation.js';
import { checkTradeAccountAddress, isTradeIdentifier, isTradeNetwork, isTradeReference, type TradeNetwork } from '../domain/trade-grammar.js';
import { parseTradeFactProvenance, type TradeFactProvenance } from './trade-market-reference.js';
import {
  addRationals,
  assetRecord,
  closedRecord,
  formatTradeRational,
  isSafeIntegerIn,
  parseRiskAsset,
  parseRiskDecimal,
  plainList,
  rationalOfDecimal,
  sealRiskRecord,
  unsealRiskRecord,
  ZERO_RATIONAL,
  type TradeRational,
} from './trade-risk-exact.js';
import { TRADING_RISK_MAXIMUM_FACT_AGE_SECONDS, type TradeActiveOrderScope } from './trade-risk-profile.js';

/**
 * Aggregate exposure and active-order prerequisites (TRADE-03).
 *
 * These are **contracts and deterministic arithmetic**, not enforcement:
 *
 * - `TradeExposureSnapshot` is what an authoritative exposure source would
 *   state for one organization, network, owner and risk bucket, in one
 *   denomination: settled exposure, exposure pending submission (including
 *   submissions whose outcome is uncertain), the open remainder of resting
 *   orders, the capacity the source itself still reports, the validated ledger
 *   the figures were read at, and whether the reading is complete.
 * - `TradeActiveOrderSnapshot` is the same for a count of concurrent orders in
 *   one scope: open ledger offers **plus** Frontera's own orders awaiting or
 *   uncertain of submission — an order not yet on the ledger still occupies
 *   capacity, so counting visible offers alone undercounts.
 * - `summarizeTradeOrderInventory` derives both from a list of order records
 *   deterministically (cancelled and expired release; partially filled moves
 *   the filled part to settled exposure and keeps the remainder open; an
 *   uncertain submission is counted as pending, never as gone).
 *
 * **Neither snapshot is a reservation.** A check against a snapshot cannot
 * stop two concurrent orders that each fit the remaining capacity from
 * jointly exceeding it. TRADE-03 builds no exposure ledger; the existing P7
 * reservation is per execution, in the governed amount's own asset, with no
 * release on cancel or fill (see the TRADE-03 doc). Every assessment that uses
 * these records says so (`AGGREGATE_EXPOSURE_NOT_RESERVED`).
 */

export const TRADE_EXPOSURE_SNAPSHOT_SCHEMA = 'frontera.trade-exposure-snapshot.v1';
export const TRADE_EXPOSURE_SNAPSHOT_DIGEST_DOMAIN = 'frontera.trade-exposure-snapshot-digest.v1';
export const TRADE_ACTIVE_ORDER_SNAPSHOT_SCHEMA = 'frontera.trade-active-order-snapshot.v1';
export const TRADE_ACTIVE_ORDER_SNAPSHOT_DIGEST_DOMAIN = 'frontera.trade-active-order-snapshot-digest.v1';

const MAXIMUM_LEDGER_INDEX = 4_294_967_295;
const MAXIMUM_COUNT = 1_000_000;

export interface TradeExposureSnapshot {
  readonly schema: typeof TRADE_EXPOSURE_SNAPSHOT_SCHEMA;
  readonly sourceId: string;
  readonly organizationId: string;
  readonly network: TradeNetwork;
  readonly ownerAccount: string;
  readonly riskBucket: string;
  readonly denomination: TradeAsset;
  /** Settled (filled) exposure, canonical decimal in the denomination. */
  readonly currentExposure: string;
  /** Awaiting submission or of uncertain submission outcome. */
  readonly pendingExposure: string;
  /** The unfilled remainder of resting offers. */
  readonly activeOrderExposure: string;
  /** What the source itself reports as still available. */
  readonly capacityRemaining: string;
  readonly validatedLedgerIndex: number;
  /** `false` when the source could not account for every order: never a basis for a positive claim. */
  readonly complete: boolean;
  readonly observedAt: string;
  readonly maxAgeSeconds: number;
  readonly sourceReference: string;
  readonly provenance: TradeFactProvenance;
  readonly digest: string;
}

export interface TradeActiveOrderSnapshot {
  readonly schema: typeof TRADE_ACTIVE_ORDER_SNAPSHOT_SCHEMA;
  readonly sourceId: string;
  readonly organizationId: string;
  readonly network: TradeNetwork;
  readonly scope: TradeActiveOrderScope;
  /** The scope's key (see `tradeActiveOrderScopeKey`). */
  readonly scopeKey: string;
  readonly ledgerOpenOffers: number;
  readonly pendingSubmissions: number;
  readonly uncertainSubmissions: number;
  readonly validatedLedgerIndex: number;
  readonly complete: boolean;
  readonly observedAt: string;
  readonly maxAgeSeconds: number;
  readonly sourceReference: string;
  readonly provenance: TradeFactProvenance;
  readonly digest: string;
}

export type TradeExposureReading = Omit<TradeExposureSnapshot, 'schema' | 'digest'>;
export type TradeActiveOrderReading = Omit<TradeActiveOrderSnapshot, 'schema' | 'digest'>;

const EXPOSURE_FIELDS = [
  'schema',
  'sourceId',
  'organizationId',
  'network',
  'ownerAccount',
  'riskBucket',
  'denomination',
  'currentExposure',
  'pendingExposure',
  'activeOrderExposure',
  'capacityRemaining',
  'validatedLedgerIndex',
  'complete',
  'observedAt',
  'maxAgeSeconds',
  'sourceReference',
  'provenance',
] as const;

const ACTIVE_ORDER_FIELDS = [
  'schema',
  'sourceId',
  'organizationId',
  'network',
  'scope',
  'scopeKey',
  'ledgerOpenOffers',
  'pendingSubmissions',
  'uncertainSubmissions',
  'validatedLedgerIndex',
  'complete',
  'observedAt',
  'maxAgeSeconds',
  'sourceReference',
  'provenance',
] as const;

/** Fields common to both snapshots. */
function readCommon(entries: ReadonlyMap<string, unknown>): { readonly ok: boolean; readonly provenance?: TradeFactProvenance } {
  const provenance = parseTradeFactProvenance(entries.get('provenance'));
  const ok =
    isTradeIdentifier(entries.get('sourceId')) &&
    isTradeIdentifier(entries.get('organizationId')) &&
    isTradeNetwork(entries.get('network')) &&
    isSafeIntegerIn(entries.get('validatedLedgerIndex'), 1, MAXIMUM_LEDGER_INDEX) &&
    typeof entries.get('complete') === 'boolean' &&
    isTradeInstant(entries.get('observedAt')) &&
    isSafeIntegerIn(entries.get('maxAgeSeconds'), 1, TRADING_RISK_MAXIMUM_FACT_AGE_SECONDS) &&
    isTradeReference(entries.get('sourceReference')) &&
    provenance !== undefined;
  return provenance !== undefined ? { ok, provenance } : { ok };
}

function readExposure(entries: ReadonlyMap<string, unknown>): Omit<TradeExposureSnapshot, 'digest'> | undefined {
  if (entries.get('schema') !== TRADE_EXPOSURE_SNAPSHOT_SCHEMA) return undefined;
  const common = readCommon(entries);
  const denomination = parseRiskAsset(entries.get('denomination'));
  const figures = (['currentExposure', 'pendingExposure', 'activeOrderExposure', 'capacityRemaining'] as const).map((key) => parseRiskDecimal(entries.get(key)));
  if (!common.ok || common.provenance === undefined || denomination === undefined || figures.some((figure) => figure === undefined)) return undefined;
  if (checkTradeAccountAddress(entries.get('ownerAccount')) !== 'valid' || !isTradeIdentifier(entries.get('riskBucket'))) return undefined;
  const [currentExposure, pendingExposure, activeOrderExposure, capacityRemaining] = figures as string[];
  return Object.freeze({
    schema: TRADE_EXPOSURE_SNAPSHOT_SCHEMA,
    sourceId: entries.get('sourceId') as string,
    organizationId: entries.get('organizationId') as string,
    network: entries.get('network') as TradeNetwork,
    ownerAccount: entries.get('ownerAccount') as string,
    riskBucket: entries.get('riskBucket') as string,
    denomination,
    currentExposure: currentExposure as string,
    pendingExposure: pendingExposure as string,
    activeOrderExposure: activeOrderExposure as string,
    capacityRemaining: capacityRemaining as string,
    validatedLedgerIndex: entries.get('validatedLedgerIndex') as number,
    complete: entries.get('complete') as boolean,
    observedAt: entries.get('observedAt') as string,
    maxAgeSeconds: entries.get('maxAgeSeconds') as number,
    sourceReference: entries.get('sourceReference') as string,
    provenance: common.provenance,
  });
}

function readActiveOrders(entries: ReadonlyMap<string, unknown>): Omit<TradeActiveOrderSnapshot, 'digest'> | undefined {
  if (entries.get('schema') !== TRADE_ACTIVE_ORDER_SNAPSHOT_SCHEMA) return undefined;
  const common = readCommon(entries);
  const scope = entries.get('scope');
  if (!common.ok || common.provenance === undefined) return undefined;
  if (scope !== 'organization' && scope !== 'owner' && scope !== 'owner-pair' && scope !== 'delegate') return undefined;
  const scopeKey = entries.get('scopeKey');
  if (typeof scopeKey !== 'string' || scopeKey.length === 0 || scopeKey.length > 512) return undefined;
  for (const key of ['ledgerOpenOffers', 'pendingSubmissions', 'uncertainSubmissions'] as const) if (!isSafeIntegerIn(entries.get(key), 0, MAXIMUM_COUNT)) return undefined;
  return Object.freeze({
    schema: TRADE_ACTIVE_ORDER_SNAPSHOT_SCHEMA,
    sourceId: entries.get('sourceId') as string,
    organizationId: entries.get('organizationId') as string,
    network: entries.get('network') as TradeNetwork,
    scope,
    scopeKey,
    ledgerOpenOffers: entries.get('ledgerOpenOffers') as number,
    pendingSubmissions: entries.get('pendingSubmissions') as number,
    uncertainSubmissions: entries.get('uncertainSubmissions') as number,
    validatedLedgerIndex: entries.get('validatedLedgerIndex') as number,
    complete: entries.get('complete') as boolean,
    observedAt: entries.get('observedAt') as string,
    maxAgeSeconds: entries.get('maxAgeSeconds') as number,
    sourceReference: entries.get('sourceReference') as string,
    provenance: common.provenance,
  });
}

function exposureData(reading: TradeExposureReading): Record<string, unknown> {
  return { schema: TRADE_EXPOSURE_SNAPSHOT_SCHEMA, ...reading, denomination: assetRecord(reading.denomination), provenance: { kind: reading.provenance.kind, method: reading.provenance.method } };
}

function activeOrderData(reading: TradeActiveOrderReading): Record<string, unknown> {
  return { schema: TRADE_ACTIVE_ORDER_SNAPSHOT_SCHEMA, ...reading, provenance: { kind: reading.provenance.kind, method: reading.provenance.method } };
}

/** Seals a trusted exposure reading. Throws `RangeError` on a malformed reading. */
export function sealTradeExposureSnapshot(reading: TradeExposureReading): TradeExposureSnapshot {
  const data = exposureData(reading);
  const entries = closedRecord(data, EXPOSURE_FIELDS);
  const parsed = entries !== undefined ? readExposure(entries) : undefined;
  if (parsed === undefined) throw new RangeError('The exposure reading is malformed.');
  return Object.freeze({ ...parsed, digest: sealRiskRecord(TRADE_EXPOSURE_SNAPSHOT_DIGEST_DOMAIN, data).digest });
}

/** Seals a trusted active-order reading. Throws `RangeError` on a malformed reading. */
export function sealTradeActiveOrderSnapshot(reading: TradeActiveOrderReading): TradeActiveOrderSnapshot {
  const data = activeOrderData(reading);
  const entries = closedRecord(data, ACTIVE_ORDER_FIELDS);
  const parsed = entries !== undefined ? readActiveOrders(entries) : undefined;
  if (parsed === undefined) throw new RangeError('The active-order reading is malformed.');
  return Object.freeze({ ...parsed, digest: sealRiskRecord(TRADE_ACTIVE_ORDER_SNAPSHOT_DIGEST_DOMAIN, data).digest });
}

export function tradeExposureSnapshotData(snapshot: TradeExposureSnapshot): Record<string, unknown> {
  const { digest, schema: _schema, ...reading } = snapshot;
  return { ...exposureData(reading), digest };
}

export function tradeActiveOrderSnapshotData(snapshot: TradeActiveOrderSnapshot): Record<string, unknown> {
  const { digest, schema: _schema, ...reading } = snapshot;
  return { ...activeOrderData(reading), digest };
}

function hasAssetObject(raw: unknown, key: string): boolean {
  if (typeof raw !== 'object' || raw === null) return false;
  const descriptor = Object.getOwnPropertyDescriptor(raw, key);
  const value: unknown = descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined;
  return typeof value === 'object' && value !== null && Object.getOwnPropertyDescriptor(value, 'kind') !== undefined;
}

/** Reads an exposure snapshot from data or a sealed object; `undefined` when malformed or altered after sealing. */
export function parseTradeExposureSnapshot(raw: unknown): TradeExposureSnapshot | undefined {
  const data = hasAssetObject(raw, 'denomination') ? tradeExposureSnapshotData(raw as TradeExposureSnapshot) : raw;
  const intact = unsealRiskRecord(TRADE_EXPOSURE_SNAPSHOT_DIGEST_DOMAIN, data);
  if (intact === undefined) return undefined;
  const entries = closedRecord(intact, EXPOSURE_FIELDS, ['digest']);
  const parsed = entries !== undefined ? readExposure(entries) : undefined;
  return parsed === undefined ? undefined : Object.freeze({ ...parsed, digest: intact['digest'] as string });
}

/** Reads an active-order snapshot; `undefined` when malformed or altered after sealing. */
export function parseTradeActiveOrderSnapshot(raw: unknown): TradeActiveOrderSnapshot | undefined {
  const intact = unsealRiskRecord(TRADE_ACTIVE_ORDER_SNAPSHOT_DIGEST_DOMAIN, raw);
  if (intact === undefined) return undefined;
  const entries = closedRecord(intact, ACTIVE_ORDER_FIELDS, ['digest']);
  const parsed = entries !== undefined ? readActiveOrders(entries) : undefined;
  return parsed === undefined ? undefined : Object.freeze({ ...parsed, digest: intact['digest'] as string });
}

/** The exposure already committed in a snapshot: settled + pending + open remainder, exactly. */
export function tradeExposureCommitted(snapshot: TradeExposureSnapshot): TradeRational {
  return [snapshot.currentExposure, snapshot.pendingExposure, snapshot.activeOrderExposure].map(rationalOfDecimal).reduce(addRationals, ZERO_RATIONAL);
}

/** Orders already occupying the count: open on the ledger, awaiting submission, or of uncertain outcome. */
export function tradeActiveOrderCount(snapshot: TradeActiveOrderSnapshot): number {
  return snapshot.ledgerOpenOffers + snapshot.pendingSubmissions + snapshot.uncertainSubmissions;
}

/** The key an active-order count is kept under, for a scope. Injective per scope. */
export function tradeActiveOrderScopeKey(scope: TradeActiveOrderScope, order: { readonly organizationId: string; readonly ownerAccount: string; readonly delegateAccount: string; readonly baseToken: string; readonly quoteToken: string }): string {
  switch (scope) {
    case 'organization':
      return `organization:${order.organizationId}`;
    case 'owner':
      return `owner:${order.ownerAccount}`;
    case 'delegate':
      return `delegate:${order.delegateAccount}`;
    case 'owner-pair':
      return `owner-pair:${order.ownerAccount}|${order.baseToken}|${order.quoteToken}`;
  }
}

// ── Deterministic inventory arithmetic ───────────────────────────────────────

export type TradeOrderLifecycleState = 'pending-submission' | 'submitted-uncertain' | 'open' | 'partially-filled' | 'filled' | 'cancelled' | 'expired';

/** One order as an authoritative inventory would record it, in the exposure denomination. */
export interface TradeOrderInventoryEntry {
  readonly state: TradeOrderLifecycleState;
  /** The order's full exposure when placed. */
  readonly orderedExposure: string;
  /** The part that has filled (settled). */
  readonly filledExposure: string;
}

export interface TradeOrderInventorySummary {
  readonly currentExposure: string;
  readonly pendingExposure: string;
  readonly activeOrderExposure: string;
  readonly ledgerOpenOffers: number;
  readonly pendingSubmissions: number;
  readonly uncertainSubmissions: number;
}

export type TradeOrderInventoryResult = { readonly valid: true; readonly summary: TradeOrderInventorySummary } | { readonly valid: false; readonly index: number };

const STATES: readonly TradeOrderLifecycleState[] = ['pending-submission', 'submitted-uncertain', 'open', 'partially-filled', 'filled', 'cancelled', 'expired'];

/**
 * Summarizes an order inventory exactly. Rules (conservative where an outcome
 * is unknown):
 *
 * | state | settled | pending | open remainder | counts as |
 * | --- | --- | --- | --- | --- |
 * | pending-submission | filled | ordered − filled | — | pending |
 * | submitted-uncertain | filled | ordered − filled | — | uncertain |
 * | open | filled | — | ordered − filled | open offer |
 * | partially-filled | filled | — | ordered − filled | open offer |
 * | filled | filled | — | — | — |
 * | cancelled / expired | filled | — | — | — |
 *
 * `filled` may not exceed `ordered`; a malformed entry refuses the whole
 * inventory (its index is returned) — a partial sum is never a total.
 */
export function summarizeTradeOrderInventory(raw: unknown): TradeOrderInventoryResult {
  const entries = plainList(raw, 100_000);
  if (entries === undefined) return { valid: false, index: -1 };
  let settled = ZERO_RATIONAL;
  let pending = ZERO_RATIONAL;
  let open = ZERO_RATIONAL;
  let ledgerOpenOffers = 0;
  let pendingSubmissions = 0;
  let uncertainSubmissions = 0;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = closedRecord(entries[index], ['state', 'orderedExposure', 'filledExposure']);
    const state = entry?.get('state');
    const ordered = parseRiskDecimal(entry?.get('orderedExposure'));
    const filled = parseRiskDecimal(entry?.get('filledExposure'));
    if (typeof state !== 'string' || !(STATES as readonly string[]).includes(state) || ordered === undefined || filled === undefined) return { valid: false, index };
    const orderedValue = rationalOfDecimal(ordered);
    const filledValue = rationalOfDecimal(filled);
    if (filledValue.numerator * orderedValue.denominator > orderedValue.numerator * filledValue.denominator) return { valid: false, index };
    const remainder: TradeRational = {
      numerator: orderedValue.numerator * filledValue.denominator - filledValue.numerator * orderedValue.denominator,
      denominator: orderedValue.denominator * filledValue.denominator,
    };
    const remaining = addRationals(ZERO_RATIONAL, remainder);
    settled = addRationals(settled, filledValue);
    if (state === 'pending-submission' || state === 'submitted-uncertain') {
      pending = addRationals(pending, remaining);
      if (state === 'pending-submission') pendingSubmissions += 1;
      else uncertainSubmissions += 1;
    } else if (state === 'open' || state === 'partially-filled') {
      open = addRationals(open, remaining);
      ledgerOpenOffers += 1;
    }
  }
  return {
    valid: true,
    summary: Object.freeze({
      currentExposure: decimalOf(settled),
      pendingExposure: decimalOf(pending),
      activeOrderExposure: decimalOf(open),
      ledgerOpenOffers,
      pendingSubmissions,
      uncertainSubmissions,
    }),
  };
}

/** A rational whose denominator is 2^a·5^b (every sum of decimals) as canonical decimal text; any other rational keeps its `n/d` spelling. */
function decimalOf(value: TradeRational): string {
  let rest = value.denominator;
  let twos = 0;
  let fives = 0;
  while (rest % 2n === 0n) {
    rest /= 2n;
    twos += 1;
  }
  while (rest % 5n === 0n) {
    rest /= 5n;
    fives += 1;
  }
  if (rest !== 1n) return formatTradeRational(value);
  const scale = twos > fives ? twos : fives;
  const coefficient = value.numerator * (10n ** BigInt(scale) / value.denominator);
  return formatTradeExactQuantity({ coefficient, scale });
}
