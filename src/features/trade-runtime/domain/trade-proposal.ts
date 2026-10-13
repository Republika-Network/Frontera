import { tradeProposalDigest } from './trade-canonical.js';
import {
  TRADE_AMOUNT_VIOLATIONS,
  formatTradeExactQuantity,
  parseTradeAmount,
  tradeAssetOf,
  tradeAssetToken,
  tradeAssetsEqual,
  tradeExactQuantity,
  type TradeAmount,
  type TradeAsset,
} from './trade-asset.js';
import {
  checkTradeAccountAddress,
  isSecretShapedPropertyName,
  isTradeIdentifier,
  isTradeNetwork,
  isTradeReference,
  reportablePropertyName,
  snapshotTradeRecord,
  type TradeNetwork,
} from './trade-grammar.js';
import { compareTradePrices, parseTradePriceAssertion, tradePriceOf, type TradePrice } from './trade-price.js';

/**
 * The canonical governed trading proposal: one XRP Ledger OfferCreate an
 * automated trading engine asks Frontera to authorize (TRADE-01).
 *
 * > **A proposal is applicant intent, never a fact.** Frontera decides on it;
 * > nothing in it is believed because the applicant said it.
 *
 * ## Closed, and refused rather than repaired
 *
 * Exactly the properties below. Anything else is refused with a reason: raw
 * transaction fields (`Fee`, `Sequence`, `LastLedgerSequence`,
 * `OfferSequence`, `DomainID`, `SigningPubKey`, a `tx_json` …) because the
 * trusted execution adapter alone sets them; claims of trusted facts (a
 * reference price, an exposure, a verified delegation, an approval) because
 * those are admitted only through the Trusted Context Boundary; secret-shaped
 * names, whose values are never read; and `__proto__` / `constructor` /
 * `prototype`, accessors and symbols, which are not data.
 *
 * ## XRP Ledger OfferCreate semantics
 *
 * `takerGets` is what the **owner gives up** (sells); `takerPays` is what the
 * **owner wants to receive** (buys) — named from the counterparty's view on
 * the ledger, and kept with exactly that meaning here. Everything else about
 * the order is **derived** from those two amounts and never stated
 * independently:
 *
 * - the canonical pair: XRP, when present, is the quote; otherwise the asset
 *   whose token sorts first (code-unit order) is the base;
 * - the side: `sell` when the owner gives the base asset, `buy` when it gives
 *   the quote;
 * - the quantity: the base-asset amount;
 * - the limit price: quote per base, an exact reduced fraction.
 *
 * An applicant may *assert* `pair`, `side` or `limitPrice`; an assertion that
 * disagrees with the amounts is refused, and an agreeing one changes nothing —
 * it is not part of the canonical proposal or its digest.
 */

export const TRADE_PROPOSAL_SCHEMA = 'frontera.trade-proposal.v1';
/** The one delegated permission TRADE-01 governs: the ledger's transaction-type permission for OfferCreate. */
export const TRADE_REQUIRED_PERMISSION = 'OfferCreate';
/** The longest authorization validity an applicant may request, in seconds — the Host's grant ceiling. */
export const TRADE_MAXIMUM_VALIDITY_SECONDS = 3600;
/** The largest ledger time (Ripple-epoch seconds) an `expiration` may name: an unsigned 32-bit value. */
export const TRADE_MAXIMUM_EXPIRATION = 4_294_967_295;

/**
 * The OfferCreate flags a proposal may request, by name, with the ledger's bit
 * for each. Hybrid offers (`tfHybrid`, which needs a `DomainID`) are not
 * representable in TRADE-01.
 */
export const TRADE_OFFER_FLAGS = Object.freeze({
  passive: 0x0001_0000,
  'immediate-or-cancel': 0x0002_0000,
  'fill-or-kill': 0x0004_0000,
  sell: 0x0008_0000,
} as const);

export type TradeOfferFlag = keyof typeof TRADE_OFFER_FLAGS;

export type TradeSide = 'buy' | 'sell';

/** The accepted canonical proposal. Frozen; every field in its one spelling. Absent optional fields are absent, never `null`. */
export interface TradeProposal {
  readonly schema: typeof TRADE_PROPOSAL_SCHEMA;
  readonly organizationId: string;
  readonly principalId: string;
  readonly requestId: string;
  readonly idempotencyKey: string;
  readonly network: TradeNetwork;
  readonly ownerAccount: string;
  readonly delegateAccount: string;
  readonly permission: typeof TRADE_REQUIRED_PERMISSION;
  readonly takerGets: TradeAmount;
  readonly takerPays: TradeAmount;
  /** Canonical order: ascending ledger bit. Always present; empty when none is requested. */
  readonly flags: readonly TradeOfferFlag[];
  readonly expiration?: number;
  readonly requestedValiditySeconds: number;
  readonly referenceContextId?: string;
  readonly policyContextRef?: string;
}

/** What the amounts imply. Derived, never stated, and therefore never part of the digest. */
export interface TradeOrderTerms {
  readonly base: TradeAsset;
  readonly quote: TradeAsset;
  readonly side: TradeSide;
  /** The base-asset amount, canonical decimal text in the base unit (XRP in XRP). */
  readonly quantity: string;
  /** The quote-asset amount, canonical decimal text in the quote unit. */
  readonly counterQuantity: string;
  /** Quote per base, exact. A floor for a sell, a ceiling for a buy. */
  readonly limitPrice: TradePrice;
  /** The OfferCreate `Flags` value the requested flags make. */
  readonly flagsValue: number;
}

/** An accepted proposal: the canonical proposal, its derived terms and its digest. */
export interface AcceptedTradeProposal {
  readonly proposal: TradeProposal;
  readonly terms: TradeOrderTerms;
  readonly digest: string;
}

export const TRADE_PROPOSAL_VIOLATIONS = {
  ...TRADE_AMOUNT_VIOLATIONS,
  NOT_AN_OBJECT: 'NOT_AN_OBJECT',
  TOO_MANY_PROPERTIES: 'TOO_MANY_PROPERTIES',
  SYMBOL_PROPERTY: 'SYMBOL_PROPERTY',
  DANGEROUS_PROPERTY: 'DANGEROUS_PROPERTY',
  ACCESSOR_PROPERTY: 'ACCESSOR_PROPERTY',
  UNDECLARED_PROPERTY: 'UNDECLARED_PROPERTY',
  EXECUTION_FIELD_REFUSED: 'EXECUTION_FIELD_REFUSED',
  TRUSTED_FACT_CLAIM_REFUSED: 'TRUSTED_FACT_CLAIM_REFUSED',
  SECRET_PROPERTY_REFUSED: 'SECRET_PROPERTY_REFUSED',
  MISSING_FIELD: 'MISSING_FIELD',
  SCHEMA_UNSUPPORTED: 'SCHEMA_UNSUPPORTED',
  IDENTIFIER_MALFORMED: 'IDENTIFIER_MALFORMED',
  NETWORK_UNSUPPORTED: 'NETWORK_UNSUPPORTED',
  ACCOUNT_MALFORMED: 'ACCOUNT_MALFORMED',
  ACCOUNT_RESERVED: 'ACCOUNT_RESERVED',
  OWNER_IS_DELEGATE: 'OWNER_IS_DELEGATE',
  PERMISSION_UNSUPPORTED: 'PERMISSION_UNSUPPORTED',
  XRP_FOR_XRP: 'XRP_FOR_XRP',
  SAME_ASSET: 'SAME_ASSET',
  PAIR_ASSERTION_MALFORMED: 'PAIR_ASSERTION_MALFORMED',
  PAIR_CONTRADICTS_AMOUNTS: 'PAIR_CONTRADICTS_AMOUNTS',
  SIDE_MALFORMED: 'SIDE_MALFORMED',
  SIDE_CONTRADICTS_AMOUNTS: 'SIDE_CONTRADICTS_AMOUNTS',
  PRICE_MALFORMED: 'PRICE_MALFORMED',
  PRICE_CONTRADICTS_AMOUNTS: 'PRICE_CONTRADICTS_AMOUNTS',
  FLAGS_MALFORMED: 'FLAGS_MALFORMED',
  FLAG_UNSUPPORTED: 'FLAG_UNSUPPORTED',
  FLAG_DUPLICATED: 'FLAG_DUPLICATED',
  FLAGS_CONFLICT: 'FLAGS_CONFLICT',
  EXPIRATION_MALFORMED: 'EXPIRATION_MALFORMED',
  VALIDITY_OUT_OF_RANGE: 'VALIDITY_OUT_OF_RANGE',
  REFERENCE_MALFORMED: 'REFERENCE_MALFORMED',
} as const;

export type TradeProposalViolationCode = (typeof TRADE_PROPOSAL_VIOLATIONS)[keyof typeof TRADE_PROPOSAL_VIOLATIONS];

export interface TradeProposalViolation {
  readonly code: TradeProposalViolationCode;
  readonly field: string;
}

export type TradeProposalValidation = { readonly valid: true; readonly accepted: AcceptedTradeProposal } | { readonly valid: false; readonly violations: readonly TradeProposalViolation[] };

const V = TRADE_PROPOSAL_VIOLATIONS;

const REQUIRED_FIELDS = [
  'schema',
  'organizationId',
  'principalId',
  'requestId',
  'idempotencyKey',
  'network',
  'ownerAccount',
  'delegateAccount',
  'permission',
  'takerGets',
  'takerPays',
  'requestedValiditySeconds',
] as const;
const OPTIONAL_FIELDS = ['pair', 'side', 'limitPrice', 'flags', 'expiration', 'referenceContextId', 'policyContextRef'] as const;
const DECLARED: ReadonlySet<string> = new Set<string>([...REQUIRED_FIELDS, ...OPTIONAL_FIELDS]);

/**
 * Transaction fields the trusted execution adapter alone sets, plus the
 * spellings of a raw transaction. Compared case-insensitively, so `fee` is
 * refused like `Fee`. A declared field (`flags`, `expiration`) is matched
 * first, by exact name.
 */
const EXECUTION_FIELDS: ReadonlySet<string> = new Set(
  [
    'TransactionType',
    'Account',
    'Delegate',
    'Fee',
    'Sequence',
    'TicketSequence',
    'LastLedgerSequence',
    'SigningPubKey',
    'TxnSignature',
    'Signers',
    'Memos',
    'Flags',
    'OfferSequence',
    'DomainID',
    'NetworkID',
    'SourceTag',
    'AccountTxnID',
    'Expiration',
    'TakerGets',
    'TakerPays',
    'tx_json',
    'tx_blob',
    'txJson',
    'txBlob',
    'transaction',
    'rawTransaction',
    'signedTransaction',
    'signature',
    'hash',
  ].map((name) => name.toLowerCase()),
);

/** Names that claim a fact only the Trusted Context Boundary or the ledger may establish. */
const TRUSTED_FACT_CLAIM = /(price|exposure|activeorders|openorders|delegation|verified|attest|oracle|approved|approval|decision|grant|trusted|riskscore|balance|reserve|ceiling|limit)/i;

const TRADE_PROPOSAL_MAXIMUM_PROPERTIES = 32;

function classifyUndeclared(name: string): TradeProposalViolationCode {
  if (isSecretShapedPropertyName(name)) return V.SECRET_PROPERTY_REFUSED;
  if (EXECUTION_FIELDS.has(name.toLowerCase())) return V.EXECUTION_FIELD_REFUSED;
  if (TRUSTED_FACT_CLAIM.test(name)) return V.TRUSTED_FACT_CLAIM_REFUSED;
  return V.UNDECLARED_PROPERTY;
}

function snapshotRefusal(refusal: 'NOT_AN_OBJECT' | 'TOO_MANY_PROPERTIES' | 'SYMBOL_PROPERTY' | 'DANGEROUS_PROPERTY' | 'ACCESSOR_PROPERTY'): TradeProposalViolationCode {
  return V[refusal];
}

function isSafeIntegerIn(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && !Object.is(value, -0) && value >= minimum && value <= maximum;
}

/** Canonical pair orientation: XRP is always the quote; otherwise the asset whose token sorts first is the base. */
export function canonicalTradePair(left: TradeAsset, right: TradeAsset): { readonly base: TradeAsset; readonly quote: TradeAsset } {
  if (left.kind === 'xrp') return { base: right, quote: left };
  if (right.kind === 'xrp') return { base: left, quote: right };
  return tradeAssetToken(left) < tradeAssetToken(right) ? { base: left, quote: right } : { base: right, quote: left };
}

function parseFlags(raw: unknown, violations: TradeProposalViolation[]): readonly TradeOfferFlag[] | undefined {
  if (raw === undefined) return Object.freeze([]);
  if (!Array.isArray(raw) || raw.length > 4 || Reflect.ownKeys(raw).length !== raw.length + 1) {
    violations.push({ code: V.FLAGS_MALFORMED, field: 'flags' });
    return undefined;
  }
  const seen = new Set<TradeOfferFlag>();
  for (let index = 0; index < raw.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(raw, index);
    const name: unknown = descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined;
    if (typeof name !== 'string' || !Object.prototype.hasOwnProperty.call(TRADE_OFFER_FLAGS, name)) {
      violations.push({ code: V.FLAG_UNSUPPORTED, field: `flags[${index}]` });
      return undefined;
    }
    if (seen.has(name as TradeOfferFlag)) {
      violations.push({ code: V.FLAG_DUPLICATED, field: `flags[${index}]` });
      return undefined;
    }
    seen.add(name as TradeOfferFlag);
  }
  // The ledger refuses an offer that is both immediate-or-cancel and fill-or-kill.
  if (seen.has('immediate-or-cancel') && seen.has('fill-or-kill')) {
    violations.push({ code: V.FLAGS_CONFLICT, field: 'flags' });
    return undefined;
  }
  return Object.freeze([...seen].sort((left, right) => TRADE_OFFER_FLAGS[left] - TRADE_OFFER_FLAGS[right]));
}

function parseAssetAssertion(raw: unknown): TradeAsset | undefined {
  const snapshot = snapshotTradeRecord(raw, 4);
  if (!snapshot.ok) return undefined;
  if (snapshot.entries.get('currency') === 'XRP') return snapshot.entries.size === 1 ? { kind: 'xrp' } : undefined;
  // Reuse the amount grammar for the asset: a nominal positive value makes it an amount to parse.
  const parsed = parseTradeAmount({ currency: snapshot.entries.get('currency'), issuer: snapshot.entries.get('issuer'), value: '1' }, 'pair');
  if (!parsed.valid || snapshot.entries.size !== 2) return undefined;
  return tradeAssetOf(parsed.amount);
}

/**
 * Validates untrusted data as a trading proposal and returns its canonical
 * form, derived terms and digest — or every violation found, each naming a
 * code and a field (never a value). Pure and deterministic: no clock, no I/O.
 * The canonical proposal is itself a valid input that validates to itself.
 */
export function validateTradeProposal(raw: unknown): TradeProposalValidation {
  const snapshot = snapshotTradeRecord(raw, TRADE_PROPOSAL_MAXIMUM_PROPERTIES);
  if (!snapshot.ok) return { valid: false, violations: [{ code: snapshotRefusal(snapshot.refusal), field: snapshot.property !== undefined ? reportablePropertyName(snapshot.property) : '<proposal>' }] };
  const entries = snapshot.entries;
  const violations: TradeProposalViolation[] = [];

  for (const key of entries.keys()) if (!DECLARED.has(key)) violations.push({ code: classifyUndeclared(key), field: reportablePropertyName(key) });
  for (const field of REQUIRED_FIELDS) if (!entries.has(field)) violations.push({ code: V.MISSING_FIELD, field });
  if (violations.length > 0) return { valid: false, violations };

  if (entries.get('schema') !== TRADE_PROPOSAL_SCHEMA) violations.push({ code: V.SCHEMA_UNSUPPORTED, field: 'schema' });
  for (const field of ['organizationId', 'principalId', 'requestId', 'idempotencyKey'] as const) {
    if (!isTradeIdentifier(entries.get(field))) violations.push({ code: V.IDENTIFIER_MALFORMED, field });
  }
  const network = entries.get('network');
  if (!isTradeNetwork(network)) violations.push({ code: V.NETWORK_UNSUPPORTED, field: 'network' });
  for (const field of ['ownerAccount', 'delegateAccount'] as const) {
    const check = checkTradeAccountAddress(entries.get(field));
    if (check === 'reserved') violations.push({ code: V.ACCOUNT_RESERVED, field });
    else if (check !== 'valid') violations.push({ code: V.ACCOUNT_MALFORMED, field });
  }
  if (entries.get('ownerAccount') === entries.get('delegateAccount')) violations.push({ code: V.OWNER_IS_DELEGATE, field: 'delegateAccount' });
  if (entries.get('permission') !== TRADE_REQUIRED_PERMISSION) violations.push({ code: V.PERMISSION_UNSUPPORTED, field: 'permission' });

  const gets = parseTradeAmount(entries.get('takerGets'), 'takerGets');
  if (!gets.valid) violations.push({ code: gets.violation, field: gets.field });
  const pays = parseTradeAmount(entries.get('takerPays'), 'takerPays');
  if (!pays.valid) violations.push({ code: pays.violation, field: pays.field });

  const flags = parseFlags(entries.get('flags'), violations);
  const expiration = entries.get('expiration');
  if (expiration !== undefined && !isSafeIntegerIn(expiration, 1, TRADE_MAXIMUM_EXPIRATION)) violations.push({ code: V.EXPIRATION_MALFORMED, field: 'expiration' });
  const validity = entries.get('requestedValiditySeconds');
  if (!isSafeIntegerIn(validity, 1, TRADE_MAXIMUM_VALIDITY_SECONDS)) violations.push({ code: V.VALIDITY_OUT_OF_RANGE, field: 'requestedValiditySeconds' });
  for (const field of ['referenceContextId', 'policyContextRef'] as const) {
    const value = entries.get(field);
    if (value !== undefined && !isTradeReference(value)) violations.push({ code: V.REFERENCE_MALFORMED, field });
  }
  if (!gets.valid || !pays.valid) return { valid: false, violations };

  // Economic meaning: two different assets, at most one of them XRP.
  const given = tradeAssetOf(gets.amount);
  const received = tradeAssetOf(pays.amount);
  if (given.kind === 'xrp' && received.kind === 'xrp') violations.push({ code: V.XRP_FOR_XRP, field: 'takerPays' });
  else if (tradeAssetsEqual(given, received)) violations.push({ code: V.SAME_ASSET, field: 'takerPays' });
  if (violations.length > 0 || flags === undefined) return { valid: false, violations };

  const { base, quote } = canonicalTradePair(given, received);
  const side: TradeSide = tradeAssetsEqual(given, base) ? 'sell' : 'buy';
  const baseAmount = side === 'sell' ? gets.amount : pays.amount;
  const quoteAmount = side === 'sell' ? pays.amount : gets.amount;
  const limitPrice = tradePriceOf(tradeExactQuantity(quoteAmount), tradeExactQuantity(baseAmount));

  // Assertions: checked against what the amounts imply, never used to set it.
  const pairAssertion = entries.get('pair');
  if (pairAssertion !== undefined) {
    const pair = snapshotTradeRecord(pairAssertion, 4);
    const assertedBase = pair.ok && pair.entries.size === 2 ? parseAssetAssertion(pair.entries.get('base')) : undefined;
    const assertedQuote = pair.ok && pair.entries.size === 2 ? parseAssetAssertion(pair.entries.get('quote')) : undefined;
    if (assertedBase === undefined || assertedQuote === undefined) violations.push({ code: V.PAIR_ASSERTION_MALFORMED, field: 'pair' });
    else if (!tradeAssetsEqual(assertedBase, base) || !tradeAssetsEqual(assertedQuote, quote)) violations.push({ code: V.PAIR_CONTRADICTS_AMOUNTS, field: 'pair' });
  }
  const sideAssertion = entries.get('side');
  if (sideAssertion !== undefined) {
    if (sideAssertion !== 'buy' && sideAssertion !== 'sell') violations.push({ code: V.SIDE_MALFORMED, field: 'side' });
    else if (sideAssertion !== side) violations.push({ code: V.SIDE_CONTRADICTS_AMOUNTS, field: 'side' });
  }
  const priceAssertion = entries.get('limitPrice');
  if (priceAssertion !== undefined) {
    const asserted = parseTradePriceAssertion(priceAssertion);
    if (!asserted.valid) violations.push({ code: V.PRICE_MALFORMED, field: 'limitPrice' });
    else if (compareTradePrices(asserted.price, limitPrice) !== 0) violations.push({ code: V.PRICE_CONTRADICTS_AMOUNTS, field: 'limitPrice' });
  }
  if (violations.length > 0) return { valid: false, violations };

  const referenceContextId = entries.get('referenceContextId') as string | undefined;
  const policyContextRef = entries.get('policyContextRef') as string | undefined;
  const proposal: TradeProposal = Object.freeze({
    schema: TRADE_PROPOSAL_SCHEMA,
    organizationId: entries.get('organizationId') as string,
    principalId: entries.get('principalId') as string,
    requestId: entries.get('requestId') as string,
    idempotencyKey: entries.get('idempotencyKey') as string,
    network: network as TradeNetwork,
    ownerAccount: entries.get('ownerAccount') as string,
    delegateAccount: entries.get('delegateAccount') as string,
    permission: TRADE_REQUIRED_PERMISSION,
    takerGets: gets.amount,
    takerPays: pays.amount,
    flags,
    ...(expiration !== undefined ? { expiration: expiration as number } : {}),
    requestedValiditySeconds: validity as number,
    ...(referenceContextId !== undefined ? { referenceContextId } : {}),
    ...(policyContextRef !== undefined ? { policyContextRef } : {}),
  });
  const terms: TradeOrderTerms = Object.freeze({
    base: Object.freeze(base),
    quote: Object.freeze(quote),
    side,
    quantity: formatTradeExactQuantity(tradeExactQuantity(baseAmount)),
    counterQuantity: formatTradeExactQuantity(tradeExactQuantity(quoteAmount)),
    limitPrice,
    flagsValue: flags.reduce((sum, flag) => sum + TRADE_OFFER_FLAGS[flag], 0),
  });
  return { valid: true, accepted: Object.freeze({ proposal, terms, digest: tradeProposalDigest(proposal) }) };
}

/**
 * How two accepted proposals relate as requests (the governed path decides
 * replay and conflict itself; this is the same rule, for a TRADE caller that
 * needs it before submitting):
 *
 * - `replay` — same organization, principal and idempotency key, same digest;
 * - `conflict` — same organization, principal and idempotency key, a
 *   **different** digest: one key can never name two different orders;
 * - `distinct` — anything else.
 */
export function classifyTradeProposalReplay(previous: AcceptedTradeProposal, next: AcceptedTradeProposal): 'replay' | 'conflict' | 'distinct' {
  const a = previous.proposal;
  const b = next.proposal;
  if (a.organizationId !== b.organizationId || a.principalId !== b.principalId || a.idempotencyKey !== b.idempotencyKey) return 'distinct';
  return previous.digest === next.digest ? 'replay' : 'conflict';
}
