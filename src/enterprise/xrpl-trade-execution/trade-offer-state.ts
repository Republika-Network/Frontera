import type { XrplValidatedLedgerReader } from '../../features/xrpl-transport/index.js';
import type { TradeLedgerEvidence } from './trade-ledger-evidence.js';

/**
 * TRADE-04D — read-only interpretation of what one validated OfferCreate did
 * to the order book, and of whether its offer is on the book at an identified
 * later validated ledger. Pure, apart from the one validated snapshot read.
 *
 * **A transaction's success is not an order's state.** `tesSUCCESS` says the
 * OfferCreate applied; it does not say the order filled, rested or partially
 * filled. Each classification here is the narrowest one the evidence proves:
 *
 * | evidence (validated metadata of the one transaction) | effect |
 * | --- | --- |
 * | `tecKILLED` | `killed` — Fill-or-Kill / Immediate-or-Cancel killed: nothing placed, nothing crossed; fee consumed |
 * | any other `tec…` | `transaction-failed` — fee consumed, no offer placed |
 * | `tesSUCCESS`, one `CreatedNode` Offer of (owner, `Sequence`) with the transaction's own amounts | `offer-resting` — placed; nothing crossed |
 * | `tesSUCCESS`, that Offer with both amounts no larger and at least one smaller | `partially-executed-remainder-resting` — the remainder (amounts as the ledger states them) rests |
 * | `tesSUCCESS`, no such Offer, `tfFillOrKill` | `executed-in-full` — Fill-or-Kill succeeds only in full |
 * | `tesSUCCESS`, no such Offer, otherwise | `applied-not-resting` — nothing rests: a full crossing, a cancelled Immediate-or-Cancel remainder or an unplaced remainder are **not** told apart |
 * | anything inconsistent (two such Offers, an Offer an IOC/FOK could not leave, an Offer of (owner, `Sequence`) modified or deleted, amounts that grew, no ledger hash) | `unknown` |
 *
 * No executed quantity, fill price, liquidity or exposure is computed: the
 * only amounts reported are the ones the ledger itself states for the offer.
 *
 * The **later snapshot** is an independent observation, `ledger_entry
 * {offer: {account, seq}}` through the shared validated reader (bound to a
 * validated ledger's index and hash). An offer the metadata placed and the
 * snapshot no longer finds is `no-longer-present` as of that ledger — its
 * cause (filled, cancelled, expired, removed unfunded) is **not** inferred.
 */

const TF_IMMEDIATE_OR_CANCEL = 0x0002_0000;
const TF_FILL_OR_KILL = 0x0004_0000;

export type TradeOfferEffect = 'offer-resting' | 'partially-executed-remainder-resting' | 'executed-in-full' | 'applied-not-resting' | 'killed' | 'transaction-failed' | 'unknown';

/** Amounts exactly as a ledger object or the transaction states them: drops text, or `{currency, issuer, value}`. */
export interface TradeOfferAmounts {
  readonly takerGets: unknown;
  readonly takerPays: unknown;
}

/** The initial effect, from the validated transaction's own metadata. */
export interface TradeOfferEffectReading {
  readonly basis: 'validated-transaction-metadata';
  readonly transactionHash: string;
  readonly ledgerIndex: number;
  readonly ledgerHash?: string;
  readonly engineResult: string;
  readonly effect: TradeOfferEffect;
  /** The offer as the metadata created it (`offer-resting`, `partially-executed-remainder-resting`). */
  readonly offer?: TradeOfferAmounts & { readonly ledgerEntryIndex: string };
  /** Why the reading is `unknown`. */
  readonly reason?: string;
}

export type TradeOfferSnapshot =
  | { readonly basis: 'validated-offer-snapshot'; readonly state: 'present'; readonly ledgerIndex: number; readonly ledgerHash: string; readonly offer: TradeOfferAmounts }
  | { readonly basis: 'validated-offer-snapshot'; readonly state: 'not-present'; readonly ledgerIndex: number; readonly ledgerHash: string }
  | { readonly basis: 'validated-offer-snapshot'; readonly state: 'unavailable'; readonly reason: string };

export type TradeOfferInterpretation =
  /** The metadata placed the offer; no later observation was made. As of the including ledger. */
  | 'placed-as-of-inclusion'
  /** A later validated snapshot finds the offer on the book. */
  | 'resting-as-of-snapshot'
  /** A later validated snapshot no longer finds an offer the metadata placed. Cause not established. */
  | 'no-longer-present-as-of-snapshot'
  /** Nothing was placed (killed, executed in full, or applied without resting). */
  | 'not-placed'
  | 'transaction-failed'
  | 'state-unknown';

export interface TradeOfferStateAssessment {
  readonly initial: TradeOfferEffectReading;
  readonly snapshot?: TradeOfferSnapshot;
  readonly interpretation: TradeOfferInterpretation;
  readonly reason?: string;
}

function recordOf(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Readonly<Record<string, unknown>>) : undefined;
}

/** An exact decimal: `mantissa × 10^exponent`, or `undefined`. Accepts the ledger's exponent notation; never a float. */
function decimalOf(text: unknown): { readonly mantissa: bigint; readonly exponent: number } | undefined {
  if (typeof text !== 'string') return undefined;
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d{1,3}))?$/.exec(text);
  if (match === null) return undefined;
  const fraction = match[3] ?? '';
  const mantissa = BigInt(`${match[1]}${match[2]}${fraction}`);
  return { mantissa, exponent: Number(match[4] ?? '0') - fraction.length };
}

function compareDecimal(left: unknown, right: unknown): -1 | 0 | 1 | undefined {
  const a = decimalOf(left);
  const b = decimalOf(right);
  if (a === undefined || b === undefined) return undefined;
  const exponent = Math.min(a.exponent, b.exponent);
  const x = a.mantissa * 10n ** BigInt(a.exponent - exponent);
  const y = b.mantissa * 10n ** BigInt(b.exponent - exponent);
  return x === y ? 0 : x < y ? -1 : 1;
}

/** Compares two amounts of the same asset; `undefined` for different assets or unreadable amounts. */
export function compareTradeAmounts(left: unknown, right: unknown): -1 | 0 | 1 | undefined {
  if (typeof left === 'string' && typeof right === 'string') {
    if (!/^\d+$/.test(left) || !/^\d+$/.test(right)) return undefined;
    const x = BigInt(left);
    const y = BigInt(right);
    return x === y ? 0 : x < y ? -1 : 1;
  }
  const a = recordOf(left);
  const b = recordOf(right);
  if (a === undefined || b === undefined) return undefined;
  if (typeof a['currency'] !== 'string' || a['currency'] !== b['currency'] || typeof a['issuer'] !== 'string' || a['issuer'] !== b['issuer']) return undefined;
  return compareDecimal(a['value'], b['value']);
}

function offerFieldsOf(node: Readonly<Record<string, unknown>>, kind: 'CreatedNode' | 'ModifiedNode' | 'DeletedNode'): Readonly<Record<string, unknown>> | undefined {
  const inner = recordOf(node[kind]);
  if (inner === undefined || inner['LedgerEntryType'] !== 'Offer') return undefined;
  return recordOf(inner[kind === 'CreatedNode' ? 'NewFields' : 'FinalFields']);
}

/**
 * The initial effect of the one OfferCreate, from its validated metadata.
 * `evidence` must be an `included` reading of the transaction (owner and
 * `Sequence` bound by `readTradeLedgerEvidence`). `ledgerHash` may be supplied
 * from a validated header when the `tx` answer did not state it.
 */
export function readOfferCreateEffect(evidence: Extract<TradeLedgerEvidence, { readonly status: 'included' }>, owner: string, sequence: number, ledgerHash: string | undefined = evidence.ledgerHash): TradeOfferEffectReading {
  const base = {
    basis: 'validated-transaction-metadata' as const,
    transactionHash: evidence.transactionHash,
    ledgerIndex: evidence.ledgerIndex,
    ...(ledgerHash !== undefined ? { ledgerHash } : {}),
    engineResult: evidence.engineResult,
  };
  const unknown = (reason: string): TradeOfferEffectReading => Object.freeze({ ...base, effect: 'unknown', reason });
  if (ledgerHash === undefined) return unknown('ledger-hash-unavailable');
  if (evidence.resultClass === 'tec') return Object.freeze({ ...base, effect: evidence.engineResult === 'tecKILLED' ? 'killed' : 'transaction-failed' });
  const nodes = evidence.meta?.['AffectedNodes'];
  if (!Array.isArray(nodes)) return unknown('metadata-unreadable');
  const flags = evidence.transaction['Flags'];
  const flagValue = typeof flags === 'number' && Number.isSafeInteger(flags) && flags >= 0 ? flags : flags === undefined ? 0 : undefined;
  if (flagValue === undefined) return unknown('flags-unreadable');
  const own = (fields: Readonly<Record<string, unknown>> | undefined): boolean => fields !== undefined && fields['Account'] === owner && fields['Sequence'] === sequence;
  const created: { readonly fields: Readonly<Record<string, unknown>>; readonly index: unknown }[] = [];
  for (const entry of nodes) {
    const node = recordOf(entry);
    if (node === undefined) return unknown('metadata-unreadable');
    const fields = offerFieldsOf(node, 'CreatedNode');
    if (own(fields)) created.push({ fields: fields!, index: recordOf(node['CreatedNode'])?.['LedgerIndex'] });
    if (own(offerFieldsOf(node, 'ModifiedNode')) || own(offerFieldsOf(node, 'DeletedNode'))) return unknown('own-offer-modified-in-creating-transaction');
  }
  if (created.length > 1) return unknown('offer-created-twice');
  const immediate = (flagValue & (TF_IMMEDIATE_OR_CANCEL | TF_FILL_OR_KILL)) !== 0;
  if (created.length === 0) {
    if ((flagValue & TF_FILL_OR_KILL) !== 0) return Object.freeze({ ...base, effect: 'executed-in-full' });
    return Object.freeze({ ...base, effect: 'applied-not-resting' });
  }
  if (immediate) return unknown('immediate-offer-left-on-book');
  const { fields, index } = created[0]!;
  if (typeof index !== 'string') return unknown('offer-index-unreadable');
  const gets = compareTradeAmounts(fields['TakerGets'], evidence.transaction['TakerGets']);
  const pays = compareTradeAmounts(fields['TakerPays'], evidence.transaction['TakerPays']);
  const offer = Object.freeze({ takerGets: fields['TakerGets'], takerPays: fields['TakerPays'], ledgerEntryIndex: index });
  if (gets === 0 && pays === 0) return Object.freeze({ ...base, effect: 'offer-resting', offer });
  if (gets !== undefined && pays !== undefined && gets <= 0 && pays <= 0) return Object.freeze({ ...base, effect: 'partially-executed-remainder-resting', offer });
  return unknown('offer-amounts-inconsistent');
}

/** One validated `ledger_entry {offer}` read: present (with the amounts the ledger states), not present, or unavailable. */
export async function readTradeOfferSnapshot(reader: Pick<XrplValidatedLedgerReader, 'ledgerEntry'>, owner: string, sequence: number): Promise<TradeOfferSnapshot> {
  let read;
  try {
    read = await reader.ledgerEntry({ offer: { account: owner, seq: sequence } });
  } catch {
    return Object.freeze({ basis: 'validated-offer-snapshot', state: 'unavailable', reason: 'read-failed' });
  }
  if (read.outcome !== 'read') return Object.freeze({ basis: 'validated-offer-snapshot', state: 'unavailable', reason: read.failure });
  const { ledgerIndex, ledgerHash, entry } = read.value;
  if (entry.state === 'absent') return Object.freeze({ basis: 'validated-offer-snapshot', state: 'not-present', ledgerIndex, ledgerHash });
  const node = recordOf(entry.node);
  if (node === undefined || node['LedgerEntryType'] !== 'Offer' || node['Account'] !== owner || node['Sequence'] !== sequence) return Object.freeze({ basis: 'validated-offer-snapshot', state: 'unavailable', reason: 'offer-node-mismatch' });
  return Object.freeze({ basis: 'validated-offer-snapshot', state: 'present', ledgerIndex, ledgerHash, offer: Object.freeze({ takerGets: node['TakerGets'], takerPays: node['TakerPays'] }) });
}

/** Combines the initial effect with an optional later snapshot. Only what both support together is claimed. */
export function assessTradeOfferState(initial: TradeOfferEffectReading, snapshot?: TradeOfferSnapshot): TradeOfferStateAssessment {
  const answer = (interpretation: TradeOfferInterpretation, reason?: string): TradeOfferStateAssessment =>
    Object.freeze({ initial, ...(snapshot !== undefined ? { snapshot } : {}), interpretation, ...(reason !== undefined ? { reason } : {}) });
  if (initial.effect === 'unknown') return answer('state-unknown', initial.reason);
  if (initial.effect === 'transaction-failed' || initial.effect === 'killed') {
    if (snapshot?.state === 'present') return answer('state-unknown', 'snapshot-contradicts-metadata');
    return answer(initial.effect === 'killed' ? 'not-placed' : 'transaction-failed');
  }
  const placed = initial.effect === 'offer-resting' || initial.effect === 'partially-executed-remainder-resting';
  if (snapshot === undefined || snapshot.state === 'unavailable') return answer(placed ? 'placed-as-of-inclusion' : 'not-placed', snapshot?.state === 'unavailable' ? `snapshot-${snapshot.reason}` : undefined);
  if (snapshot.ledgerIndex < initial.ledgerIndex) return answer(placed ? 'placed-as-of-inclusion' : 'not-placed', 'snapshot-precedes-inclusion');
  if (!placed) return snapshot.state === 'present' ? answer('state-unknown', 'snapshot-contradicts-metadata') : answer('not-placed');
  if (snapshot.state === 'present') {
    // The amounts it states may be smaller than the remainder the metadata placed (later crossings) — reported, never turned into a fill.
    const gets = compareTradeAmounts(snapshot.offer.takerGets, initial.offer!.takerGets);
    const pays = compareTradeAmounts(snapshot.offer.takerPays, initial.offer!.takerPays);
    if (gets === undefined || pays === undefined || gets > 0 || pays > 0) return answer('state-unknown', 'snapshot-amounts-inconsistent');
    return answer('resting-as-of-snapshot');
  }
  if (snapshot.ledgerIndex === initial.ledgerIndex) return answer('state-unknown', 'snapshot-contradicts-metadata');
  return answer('no-longer-present-as-of-snapshot');
}
