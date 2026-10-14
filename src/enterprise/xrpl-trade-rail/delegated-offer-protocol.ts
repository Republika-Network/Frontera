import { checkTradeAccountAddress, isTradeIdentifier, isTradeNetwork, parseTradeAmount, TRADE_MAXIMUM_EXPIRATION, TRADE_OFFER_FLAGS, type TradeNetwork } from '../../features/trade-runtime/index.js';
import { isXrplSigningPublicKey, isXrplTransactionHash } from '../../features/xrpl-transport/index.js';

/**
 * TRADE-04B — `frontera.xrpl-delegated-offer-signer.v1`: the closed, versioned
 * protocol between the Frontera Host and an external XRPL **delegated
 * OfferCreate** signer.
 *
 * Distinct from PAY-03's `frontera.external-xrpl-transaction-signer.v1` in
 * every respect — protocol id, operation, path, request and response — so a
 * Payment signer can never be pointed at by a trade client, nor a trade
 * signer by the Payment rail, and neither protocol widens the other.
 *
 * ```
 * GET  /v1/identity                     → { protocol, signerId, operations: ['sign-xrpl-delegated-offer'], network,
 *                                           pairs: [{ ownerAccount, delegateAccount, signingPublicKey }] }
 * POST /v1/sign/xrpl-delegated-offer    ← { protocol, signerId, requestId, network, ownerAccount, delegateAccount,
 *                                           transaction, audit: { executionId, grantRef, grantDigest } }
 *                                       → { protocol, signerId, requestId, ownerAccount, delegateAccount, signedTransaction, hash }
 * ```
 *
 * One operation: sign the one closed shape of unsigned, single-signed,
 * delegated `OfferCreate` below, as the **delegate** of exactly one configured
 * owner. There is no "sign these bytes", no other transaction type, no
 * multisigning, no algorithm choice, no key export and no submission.
 *
 * The signer decides **nothing** about authority. The `audit` block names the
 * execution and the grant the Host is acting under so both sides' records can
 * be correlated; it is never verified by the signer and never treated as
 * authority — whoever can reach the signer with its credential can have any
 * closed, in-bounds OfferCreate signed for a configured pair. That is why
 * access to the signing capability belongs below the bounded grant
 * (TRADE-04C), and why the Host trusts nothing the signer answers: every
 * signed blob is decoded and verified locally before anything relies on it
 * (`delegated-offer-verification.ts`).
 *
 * Both directions are exact, closed, plain-JSON records: an unknown, missing
 * or extra field, an accessor, a symbol key or a non-plain object is refused,
 * never ignored or repaired.
 */
export const DELEGATED_OFFER_SIGNER_PROTOCOL = 'frontera.xrpl-delegated-offer-signer.v1';
export const DELEGATED_OFFER_SIGNER_OPERATION = 'sign-xrpl-delegated-offer';
export const DELEGATED_OFFER_SIGNER_PATHS = Object.freeze({ identity: '/v1/identity', signDelegatedOffer: '/v1/sign/xrpl-delegated-offer' });

/** The ledgers this protocol may name: TRADE-01's networks (XRPL Testnet and Devnet). Mainnet is not representable. */
export type DelegatedOfferNetwork = TradeNetwork;

/** At most this many owner/delegate pairs per signer identity. */
export const DELEGATED_OFFER_SIGNER_MAXIMUM_PAIRS = 64;

/** The prepared transaction's closed field set: exactly these fields are required … */
export const DELEGATED_OFFER_REQUIRED_FIELDS = Object.freeze(['TransactionType', 'Account', 'Delegate', 'TakerGets', 'TakerPays', 'Flags', 'Sequence', 'Fee', 'LastLedgerSequence'] as const);
/** … and this one is optional. Nothing else is part of the contract. */
export const DELEGATED_OFFER_OPTIONAL_FIELDS = Object.freeze(['Expiration'] as const);
/** The only fields a signature may add to the prepared transaction. */
export const DELEGATED_OFFER_SIGNATURE_FIELDS = Object.freeze(['SigningPubKey', 'TxnSignature'] as const);

/**
 * The OfferCreate flag bits a prepared transaction may carry: exactly TRADE-01's
 * canonical flags (`passive`, `immediate-or-cancel`, `fill-or-kill`, `sell`),
 * never `tfHybrid` and never a universal flag.
 */
export const DELEGATED_OFFER_ALLOWED_FLAGS = Object.values(TRADE_OFFER_FLAGS).reduce((mask, bit) => mask | bit, 0) >>> 0;

/** A signer identity: a recordable handle, never a secret. */
const SIGNER_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/;
/** A per-request correlation the Host draws fresh: 32 random bytes as lowercase hex. */
const REQUEST_ID = /^[0-9a-f]{64}$/;
const GRANT_DIGEST = /^sha256:[0-9a-f]{64}$/;
/** A fee in drops: a positive integer, at most 16 digits (the signer and the Host each cap it far lower). */
const FEE = /^[1-9][0-9]{0,15}$/;
/** A signed blob in the response: uppercase hex. A delegated OfferCreate is a few hundred bytes; 4 KiB is a generous ceiling. */
const SIGNED_BLOB = /^(?:[0-9A-F]{2}){32,4096}$/;
const UINT32_MAXIMUM = 0xffff_ffff;

export function isDelegatedOfferSignerId(value: unknown): value is string {
  return typeof value === 'string' && SIGNER_ID.test(value);
}

export function isDelegatedOfferRequestId(value: unknown): value is string {
  return typeof value === 'string' && REQUEST_ID.test(value);
}

/** An owner, delegate or issuer: a valid classic address that is not one of the two reserved accounts. */
export function isDelegatedOfferAccount(value: unknown): value is string {
  return checkTradeAccountAddress(value) === 'valid';
}

/** XRP in the wire form: whole drops as a canonical positive integer string. */
export type DelegatedOfferXrpAmount = string;
/** An issued amount in the wire form: currency, issuer and canonical decimal value. */
export interface DelegatedOfferIssuedAmount {
  readonly currency: string;
  readonly issuer: string;
  readonly value: string;
}
export type DelegatedOfferAmount = DelegatedOfferXrpAmount | DelegatedOfferIssuedAmount;

/**
 * The prepared, unsigned, delegated OfferCreate — what the future executor
 * (TRADE-04C) builds from granted terms only, and the only thing this protocol
 * signs.
 *
 * - `Account` is the **owner**: its offer, its funds, its `Sequence`.
 * - `Delegate` is the **delegate** that signs and pays the fee (XLS-75).
 * - `TakerGets` is what the owner **gives**; `TakerPays` what it **receives**.
 */
export interface PreparedDelegatedOffer {
  readonly TransactionType: 'OfferCreate';
  readonly Account: string;
  readonly Delegate: string;
  readonly TakerGets: DelegatedOfferAmount;
  readonly TakerPays: DelegatedOfferAmount;
  readonly Flags: number;
  readonly Sequence: number;
  readonly Fee: string;
  readonly LastLedgerSequence: number;
  readonly Expiration?: number;
}

/** One owner/delegate pair a signer serves, with the delegate's signing public key. */
export interface DelegatedOfferSignerPair {
  readonly ownerAccount: string;
  readonly delegateAccount: string;
  readonly signingPublicKey: string;
}

export interface DelegatedOfferSignerIdentity {
  readonly protocol: typeof DELEGATED_OFFER_SIGNER_PROTOCOL;
  readonly signerId: string;
  readonly operations: readonly [typeof DELEGATED_OFFER_SIGNER_OPERATION];
  readonly network: DelegatedOfferNetwork;
  readonly pairs: readonly DelegatedOfferSignerPair[];
}

/**
 * Audit references: what the Host says it is acting under. Recorded by both
 * sides for correlation — **never verified by the signer and never authority**.
 */
export interface DelegatedOfferAuditReference {
  readonly executionId: string;
  readonly grantRef: string;
  readonly grantDigest: string;
}

export interface DelegatedOfferSigningRequest {
  readonly protocol: typeof DELEGATED_OFFER_SIGNER_PROTOCOL;
  readonly signerId: string;
  readonly requestId: string;
  readonly network: DelegatedOfferNetwork;
  readonly ownerAccount: string;
  readonly delegateAccount: string;
  readonly transaction: PreparedDelegatedOffer;
  readonly audit: DelegatedOfferAuditReference;
}

export interface DelegatedOfferSigningResponse {
  readonly protocol: typeof DELEGATED_OFFER_SIGNER_PROTOCOL;
  readonly signerId: string;
  readonly requestId: string;
  readonly ownerAccount: string;
  readonly delegateAccount: string;
  readonly signedTransaction: string;
  readonly hash: string;
}

/**
 * A plain object whose own keys are exactly `required` plus any of
 * `optional`, each an enumerable data property — read once, as data. A
 * class instance, an array, a symbol key, an accessor or a key outside the
 * schema (an own `__proto__` from `JSON.parse` included) is `undefined`.
 */
function exactRecord(value: unknown, required: readonly string[], optional: readonly string[] = []): Readonly<Record<string, unknown>> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const keys = Reflect.ownKeys(value);
  if (keys.length > required.length + optional.length) return undefined;
  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    if (typeof key !== 'string' || (!required.includes(key) && !optional.includes(key))) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor) || descriptor.enumerable !== true) return undefined;
    out[key] = descriptor.value as unknown;
  }
  for (const key of required) if (!Object.prototype.hasOwnProperty.call(out, key)) return undefined;
  return out;
}

/** A plain array, read as data: every index an enumerable data property, no extra own key but `length`. */
function exactArray(value: unknown, maximum: number): readonly unknown[] | undefined {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum) return undefined;
  if (Reflect.ownKeys(value).length !== value.length + 1) return undefined;
  const out: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, index);
    if (descriptor === undefined || !('value' in descriptor) || descriptor.enumerable !== true) return undefined;
    out.push(descriptor.value as unknown);
  }
  return out;
}

const isUint32Positive = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= UINT32_MAXIMUM;

/**
 * One amount in the XRPL wire form, accepted only when it is already in
 * TRADE-01's canonical spelling: XRP as whole drops (`"1000000"`), an issued
 * amount as `{ currency, issuer, value }` with a canonical decimal, an exact
 * currency code (a 40-digit code in upper case) and a valid issuer. Nothing
 * is normalized: `"10.50"`, `"1e3"`, a lower-case hex code or a number is
 * refused, because the bytes signed must be the bytes that were authorized.
 */
function parseWireAmount(raw: unknown): DelegatedOfferAmount | undefined {
  if (typeof raw === 'string') {
    const parsed = parseTradeAmount({ currency: 'XRP', drops: raw }, 'amount');
    return parsed.valid && 'drops' in parsed.amount && parsed.amount.drops === raw ? raw : undefined;
  }
  const record = exactRecord(raw, ['currency', 'issuer', 'value']);
  if (record === undefined) return undefined;
  const parsed = parseTradeAmount({ currency: record['currency'], issuer: record['issuer'], value: record['value'] }, 'amount');
  if (!parsed.valid || !('issuer' in parsed.amount)) return undefined;
  const { currency, issuer, value } = parsed.amount;
  if (currency !== record['currency'] || issuer !== record['issuer'] || value !== record['value']) return undefined;
  return Object.freeze({ currency, issuer, value });
}

const isXrpWire = (amount: DelegatedOfferAmount): amount is DelegatedOfferXrpAmount => typeof amount === 'string';

/** Whether two wire amounts name the same asset (both XRP, or the same currency and issuer). */
function sameAsset(left: DelegatedOfferAmount, right: DelegatedOfferAmount): boolean {
  if (isXrpWire(left) || isXrpWire(right)) return isXrpWire(left) && isXrpWire(right);
  return left.currency === right.currency && left.issuer === right.issuer;
}

/**
 * Parses a prepared unsigned delegated OfferCreate — both sides use it: the
 * signer refuses anything else before it touches its key, and the Host before
 * it asks.
 *
 * Exactly the closed field set: `TransactionType` `OfferCreate`; `Account`
 * (owner) and `Delegate`, different valid accounts; `TakerGets` and
 * `TakerPays`, canonical, of two different assets, at most one of them XRP;
 * `Flags` within TRADE-01's four offer flags and not both immediate-or-cancel
 * and fill-or-kill; positive 32-bit `Sequence` and `LastLedgerSequence`; a
 * positive integer `Fee` in drops; an optional positive 32-bit `Expiration`.
 * Anything else — `Memos`, `Signers`, `SigningPubKey`, `TxnSignature`,
 * `OfferSequence`, `DomainID`, `NetworkID`, `TicketSequence`, `SourceTag`,
 * Payment fields, an unknown field — is refused.
 */
export function parsePreparedDelegatedOffer(raw: unknown): PreparedDelegatedOffer | undefined {
  const tx = exactRecord(raw, DELEGATED_OFFER_REQUIRED_FIELDS, DELEGATED_OFFER_OPTIONAL_FIELDS);
  if (tx === undefined || tx['TransactionType'] !== 'OfferCreate') return undefined;
  if (!isDelegatedOfferAccount(tx['Account']) || !isDelegatedOfferAccount(tx['Delegate']) || tx['Account'] === tx['Delegate']) return undefined;
  const takerGets = parseWireAmount(tx['TakerGets']);
  const takerPays = parseWireAmount(tx['TakerPays']);
  if (takerGets === undefined || takerPays === undefined || sameAsset(takerGets, takerPays)) return undefined;
  const flags = tx['Flags'];
  if (typeof flags !== 'number' || !Number.isSafeInteger(flags) || flags < 0 || flags > UINT32_MAXIMUM || (flags & ~DELEGATED_OFFER_ALLOWED_FLAGS) !== 0) return undefined;
  const immediateOrCancel = TRADE_OFFER_FLAGS['immediate-or-cancel'];
  const fillOrKill = TRADE_OFFER_FLAGS['fill-or-kill'];
  if ((flags & immediateOrCancel) !== 0 && (flags & fillOrKill) !== 0) return undefined;
  if (!isUint32Positive(tx['Sequence']) || !isUint32Positive(tx['LastLedgerSequence'])) return undefined;
  if (typeof tx['Fee'] !== 'string' || !FEE.test(tx['Fee'])) return undefined;
  const expiration = tx['Expiration'];
  if (expiration !== undefined && !(isUint32Positive(expiration) && expiration <= TRADE_MAXIMUM_EXPIRATION)) return undefined;
  return Object.freeze({
    TransactionType: 'OfferCreate',
    Account: tx['Account'],
    Delegate: tx['Delegate'],
    TakerGets: takerGets,
    TakerPays: takerPays,
    Flags: flags,
    Sequence: tx['Sequence'],
    Fee: tx['Fee'],
    LastLedgerSequence: tx['LastLedgerSequence'],
    ...(expiration !== undefined ? { Expiration: expiration as number } : {}),
  });
}

/** Parses one owner/delegate pair. Owner and delegate must differ. */
export function parseDelegatedOfferSignerPair(raw: unknown): DelegatedOfferSignerPair | undefined {
  const pair = exactRecord(raw, ['ownerAccount', 'delegateAccount', 'signingPublicKey']);
  if (pair === undefined || !isDelegatedOfferAccount(pair['ownerAccount']) || !isDelegatedOfferAccount(pair['delegateAccount']) || pair['ownerAccount'] === pair['delegateAccount']) return undefined;
  if (!isXrplSigningPublicKey(pair['signingPublicKey'])) return undefined;
  return Object.freeze({ ownerAccount: pair['ownerAccount'], delegateAccount: pair['delegateAccount'], signingPublicKey: pair['signingPublicKey'] });
}

/** The key two pairs collide on: one owner/delegate relationship is served once, under one key. */
export function delegatedOfferPairKey(pair: { readonly ownerAccount: string; readonly delegateAccount: string }): string {
  return `${pair.ownerAccount}/${pair.delegateAccount}`;
}

/** Parses an identity answer. `undefined` for anything that is not exactly one: one operation, a TRADE-01 network, 1…64 distinct pairs. */
export function parseDelegatedOfferSignerIdentity(raw: unknown): DelegatedOfferSignerIdentity | undefined {
  const record = exactRecord(raw, ['protocol', 'signerId', 'operations', 'network', 'pairs']);
  if (record === undefined || record['protocol'] !== DELEGATED_OFFER_SIGNER_PROTOCOL || !isDelegatedOfferSignerId(record['signerId']) || !isTradeNetwork(record['network'])) return undefined;
  const operations = exactArray(record['operations'], 1);
  if (operations === undefined || operations.length !== 1 || operations[0] !== DELEGATED_OFFER_SIGNER_OPERATION) return undefined;
  const entries = exactArray(record['pairs'], DELEGATED_OFFER_SIGNER_MAXIMUM_PAIRS);
  if (entries === undefined || entries.length === 0) return undefined;
  const pairs: DelegatedOfferSignerPair[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const pair = parseDelegatedOfferSignerPair(entry);
    if (pair === undefined || seen.has(delegatedOfferPairKey(pair))) return undefined;
    seen.add(delegatedOfferPairKey(pair));
    pairs.push(pair);
  }
  return Object.freeze({
    protocol: DELEGATED_OFFER_SIGNER_PROTOCOL,
    signerId: record['signerId'],
    operations: Object.freeze([DELEGATED_OFFER_SIGNER_OPERATION] as const),
    network: record['network'],
    pairs: Object.freeze(pairs),
  });
}

/** Parses the audit block: recordable references only. */
export function parseDelegatedOfferAuditReference(raw: unknown): DelegatedOfferAuditReference | undefined {
  const audit = exactRecord(raw, ['executionId', 'grantRef', 'grantDigest']);
  if (audit === undefined || !isTradeIdentifier(audit['executionId']) || !isTradeIdentifier(audit['grantRef'])) return undefined;
  if (typeof audit['grantDigest'] !== 'string' || !GRANT_DIGEST.test(audit['grantDigest'])) return undefined;
  return Object.freeze({ executionId: audit['executionId'], grantRef: audit['grantRef'], grantDigest: audit['grantDigest'] });
}

/** Parses a signing request (signer side). The transaction must be for exactly the named owner and delegate. */
export function parseDelegatedOfferSigningRequest(raw: unknown): DelegatedOfferSigningRequest | undefined {
  const record = exactRecord(raw, ['protocol', 'signerId', 'requestId', 'network', 'ownerAccount', 'delegateAccount', 'transaction', 'audit']);
  if (record === undefined || record['protocol'] !== DELEGATED_OFFER_SIGNER_PROTOCOL) return undefined;
  if (!isDelegatedOfferSignerId(record['signerId']) || !isDelegatedOfferRequestId(record['requestId']) || !isTradeNetwork(record['network'])) return undefined;
  if (!isDelegatedOfferAccount(record['ownerAccount']) || !isDelegatedOfferAccount(record['delegateAccount'])) return undefined;
  const transaction = parsePreparedDelegatedOffer(record['transaction']);
  if (transaction === undefined || transaction.Account !== record['ownerAccount'] || transaction.Delegate !== record['delegateAccount']) return undefined;
  const audit = parseDelegatedOfferAuditReference(record['audit']);
  if (audit === undefined) return undefined;
  return Object.freeze({
    protocol: DELEGATED_OFFER_SIGNER_PROTOCOL,
    signerId: record['signerId'],
    requestId: record['requestId'],
    network: record['network'],
    ownerAccount: record['ownerAccount'],
    delegateAccount: record['delegateAccount'],
    transaction,
    audit,
  });
}

/** Parses a signing response (Host side). Shape only; the binding and the blob are verified by the caller. */
export function parseDelegatedOfferSigningResponse(raw: unknown): DelegatedOfferSigningResponse | undefined {
  const record = exactRecord(raw, ['protocol', 'signerId', 'requestId', 'ownerAccount', 'delegateAccount', 'signedTransaction', 'hash']);
  if (record === undefined || record['protocol'] !== DELEGATED_OFFER_SIGNER_PROTOCOL) return undefined;
  if (!isDelegatedOfferSignerId(record['signerId']) || !isDelegatedOfferRequestId(record['requestId'])) return undefined;
  if (!isDelegatedOfferAccount(record['ownerAccount']) || !isDelegatedOfferAccount(record['delegateAccount'])) return undefined;
  if (typeof record['signedTransaction'] !== 'string' || !SIGNED_BLOB.test(record['signedTransaction']) || !isXrplTransactionHash(record['hash'])) return undefined;
  return Object.freeze({
    protocol: DELEGATED_OFFER_SIGNER_PROTOCOL,
    signerId: record['signerId'],
    requestId: record['requestId'],
    ownerAccount: record['ownerAccount'],
    delegateAccount: record['delegateAccount'],
    signedTransaction: record['signedTransaction'],
    hash: record['hash'],
  });
}
