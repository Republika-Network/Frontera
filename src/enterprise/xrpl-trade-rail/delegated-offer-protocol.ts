import { checkTradeAccountAddress, isTradeIdentifier, isTradeNetwork, parseTradeAmount, validateTradeProposal, TRADE_MAXIMUM_EXPIRATION, TRADE_OFFER_FLAGS, type TradeNetwork, type TradeProposal } from '../../features/trade-runtime/index.js';
import { isXrplSigningPublicKey, isXrplTransactionHash } from '../../features/xrpl-transport/index.js';

/**
 * TRADE-04B — `frontera.xrpl-delegated-offer-signer` — and, since TRADE-04C-S1,
 * its **v2**: the closed, versioned protocol between the Frontera Host and an
 * external XRPL **delegated OfferCreate** signer.
 *
 * Distinct from PAY-03's `frontera.external-xrpl-transaction-signer.v1` in
 * every respect — protocol id, operation, path, request and response — so a
 * Payment signer can never be pointed at by a trade client, nor a trade
 * signer by the Payment rail, and neither protocol widens the other.
 *
 * ```
 * GET  /v1/identity                     → { protocol, signerId, operations: ['sign-xrpl-delegated-offer'], network,
 *                                           pairs: [{ ownerAccount, delegateAccount, signingPublicKey }],
 *                                           authorization: { trustDomain, organizationId, issuerKeyIds } }
 * POST /v1/sign/xrpl-delegated-offer    ← { protocol, signerId, requestId, network, ownerAccount, delegateAccount,
 *                                           transaction, proposal, authorization: { capability, signature } }
 *                                       → { protocol, signerId, requestId, capabilityId, ownerAccount, delegateAccount, signedTransaction, hash }
 * ```
 *
 * One operation: sign the one closed shape of unsigned, single-signed,
 * delegated `OfferCreate` below, as the **delegate** of exactly one configured
 * owner. There is no "sign these bytes", no other transaction type, no
 * multisigning, no algorithm choice, no key export and no submission.
 *
 * **v2 (TRADE-04C-S1) — authorization in the custody boundary.** v1 carried
 * an unverified `audit` block, so whoever held the bearer credential could
 * have any closed, in-bounds OfferCreate signed (TRADE-04C R1). v2 replaces it
 * with `authorization`: a CORE-02 **delegated-offer signing capability** in its
 * canonical bytes and the authority signature over them, plus the canonical
 * TRADE-01 `proposal` the grant names. The signer refuses unless the
 * capability verifies under an authority key it pins, for its pinned trust
 * domain and organization, unexpired, bound to exactly this transaction's
 * signing preimage and fields, for a proposal whose digest it names and whose
 * terms are this transaction's — and unless it was never consumed before
 * (`delegated-offer-authorization.ts`; consumption is durable in the signer).
 * The bearer credential remains transport authentication only. v1 is gone:
 * there is no fallback to a request without a capability.
 *
 * The signer still decides nothing about *policy*: it verifies that the
 * authority already decided, once, for this exact signature. And the Host
 * still trusts nothing the signer answers: every signed blob is decoded and
 * verified locally before anything relies on it (`delegated-offer-verification.ts`).
 *
 * Both directions are exact, closed, plain-JSON records: an unknown, missing
 * or extra field, an accessor, a symbol key or a non-plain object is refused,
 * never ignored or repaired.
 */
export const DELEGATED_OFFER_SIGNER_PROTOCOL = 'frontera.xrpl-delegated-offer-signer.v2';
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
/** A capability id: 32 random bytes as lowercase hex. */
const CAPABILITY_ID = /^[0-9a-f]{64}$/;
/** An authority signature envelope's fields, as the CORE-02 envelope spells them. */
const SIGNATURE_ALGORITHM = 'ed25519-v1';
const BASE64URL = /^[A-Za-z0-9_-]{1,128}$/;
/** At most this many authority keys a signer pins as capability issuers (rotation overlap). */
export const DELEGATED_OFFER_SIGNER_MAXIMUM_ISSUER_KEYS = 8;
/** A capability, in its canonical text, is a few hundred bytes. */
const CAPABILITY_MAXIMUM_LENGTH = 8_192;
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

/**
 * What a signer pins as the authority it accepts capabilities from: the
 * deployment's trust domain, the organization it signs for, and the CORE-02
 * key ids it trusts (public identifiers; the keys themselves are the signer's
 * configuration). Advertised for comparison and diagnostics — never adopted.
 */
export interface DelegatedOfferSignerAuthorization {
  readonly trustDomain: string;
  readonly organizationId: string;
  readonly issuerKeyIds: readonly string[];
}

export interface DelegatedOfferSignerIdentity {
  readonly protocol: typeof DELEGATED_OFFER_SIGNER_PROTOCOL;
  readonly signerId: string;
  readonly operations: readonly [typeof DELEGATED_OFFER_SIGNER_OPERATION];
  readonly network: DelegatedOfferNetwork;
  readonly pairs: readonly DelegatedOfferSignerPair[];
  readonly authorization: DelegatedOfferSignerAuthorization;
}

/** The CORE-02 envelope over a capability, as it travels: exactly the four envelope fields. */
export interface DelegatedOfferAuthoritySignature {
  readonly algorithm: typeof SIGNATURE_ALGORITHM;
  readonly keyId: string;
  readonly signature: string;
  readonly artifactVersion: string;
}

/**
 * The authorization a v2 request carries: the capability's **canonical** text
 * (exactly the bytes after the domain prefix the signature covers — parsed and
 * verified by the signer, never re-serialized from a JSON object) and the
 * authority signature over it.
 */
export interface DelegatedOfferAuthorization {
  readonly capability: string;
  readonly signature: DelegatedOfferAuthoritySignature;
}

export interface DelegatedOfferSigningRequest {
  readonly protocol: typeof DELEGATED_OFFER_SIGNER_PROTOCOL;
  readonly signerId: string;
  readonly requestId: string;
  readonly network: DelegatedOfferNetwork;
  readonly ownerAccount: string;
  readonly delegateAccount: string;
  readonly transaction: PreparedDelegatedOffer;
  /** The canonical TRADE-01 proposal the grant names (by digest). Re-validated by the signer. */
  readonly proposal: TradeProposal;
  readonly authorization: DelegatedOfferAuthorization;
}

export interface DelegatedOfferSigningResponse {
  readonly protocol: typeof DELEGATED_OFFER_SIGNER_PROTOCOL;
  readonly signerId: string;
  readonly requestId: string;
  /** The capability this signature consumed. */
  readonly capabilityId: string;
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

/** Parses a signer's pinned authorization: a trust domain, an organization and 1…8 distinct issuer key ids. */
export function parseDelegatedOfferSignerAuthorization(raw: unknown): DelegatedOfferSignerAuthorization | undefined {
  const record = exactRecord(raw, ['trustDomain', 'organizationId', 'issuerKeyIds']);
  if (record === undefined || !isTradeIdentifier(record['trustDomain']) || !isTradeIdentifier(record['organizationId'])) return undefined;
  const keyIds = exactArray(record['issuerKeyIds'], DELEGATED_OFFER_SIGNER_MAXIMUM_ISSUER_KEYS);
  if (keyIds === undefined || keyIds.length === 0 || !keyIds.every(isTradeIdentifier) || new Set(keyIds).size !== keyIds.length) return undefined;
  return Object.freeze({ trustDomain: record['trustDomain'], organizationId: record['organizationId'], issuerKeyIds: Object.freeze([...(keyIds as string[])]) });
}

/** Parses an identity answer. `undefined` for anything that is not exactly one: one operation, a TRADE-01 network, 1…64 distinct pairs, a pinned authorization. */
export function parseDelegatedOfferSignerIdentity(raw: unknown): DelegatedOfferSignerIdentity | undefined {
  const record = exactRecord(raw, ['protocol', 'signerId', 'operations', 'network', 'pairs', 'authorization']);
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
  const authorization = parseDelegatedOfferSignerAuthorization(record['authorization']);
  if (authorization === undefined) return undefined;
  return Object.freeze({
    protocol: DELEGATED_OFFER_SIGNER_PROTOCOL,
    signerId: record['signerId'],
    operations: Object.freeze([DELEGATED_OFFER_SIGNER_OPERATION] as const),
    network: record['network'],
    pairs: Object.freeze(pairs),
    authorization,
  });
}

/**
 * Parses the authorization block's **shape**: a bounded canonical-capability
 * string and exactly the four CORE-02 envelope fields. Whether the capability
 * parses, verifies, is trusted, current and bound to this transaction is
 * `delegated-offer-authorization.ts`'s — never assumed from shape.
 */
export function parseDelegatedOfferAuthorization(raw: unknown): DelegatedOfferAuthorization | undefined {
  const record = exactRecord(raw, ['capability', 'signature']);
  if (record === undefined || typeof record['capability'] !== 'string' || record['capability'].length === 0 || record['capability'].length > CAPABILITY_MAXIMUM_LENGTH) return undefined;
  const envelope = exactRecord(record['signature'], ['algorithm', 'keyId', 'signature', 'artifactVersion']);
  if (envelope === undefined || envelope['algorithm'] !== SIGNATURE_ALGORITHM || !isTradeIdentifier(envelope['keyId']) || typeof envelope['signature'] !== 'string' || !BASE64URL.test(envelope['signature']) || !isTradeIdentifier(envelope['artifactVersion'])) return undefined;
  return Object.freeze({
    capability: record['capability'],
    signature: Object.freeze({ algorithm: SIGNATURE_ALGORITHM, keyId: envelope['keyId'], signature: envelope['signature'], artifactVersion: envelope['artifactVersion'] }),
  });
}

/** Parses a signing request (signer side). The transaction must be for exactly the named owner and delegate; the proposal must be an accepted TRADE-01 proposal; the authorization must have its shape. */
export function parseDelegatedOfferSigningRequest(raw: unknown): DelegatedOfferSigningRequest | undefined {
  const record = exactRecord(raw, ['protocol', 'signerId', 'requestId', 'network', 'ownerAccount', 'delegateAccount', 'transaction', 'proposal', 'authorization']);
  if (record === undefined || record['protocol'] !== DELEGATED_OFFER_SIGNER_PROTOCOL) return undefined;
  if (!isDelegatedOfferSignerId(record['signerId']) || !isDelegatedOfferRequestId(record['requestId']) || !isTradeNetwork(record['network'])) return undefined;
  if (!isDelegatedOfferAccount(record['ownerAccount']) || !isDelegatedOfferAccount(record['delegateAccount'])) return undefined;
  const transaction = parsePreparedDelegatedOffer(record['transaction']);
  if (transaction === undefined || transaction.Account !== record['ownerAccount'] || transaction.Delegate !== record['delegateAccount']) return undefined;
  const validation = validateTradeProposal(record['proposal']);
  if (!validation.valid) return undefined;
  const authorization = parseDelegatedOfferAuthorization(record['authorization']);
  if (authorization === undefined) return undefined;
  return Object.freeze({
    protocol: DELEGATED_OFFER_SIGNER_PROTOCOL,
    signerId: record['signerId'],
    requestId: record['requestId'],
    network: record['network'],
    ownerAccount: record['ownerAccount'],
    delegateAccount: record['delegateAccount'],
    transaction,
    proposal: validation.accepted.proposal,
    authorization,
  });
}

/** Parses a signing response (Host side). Shape only; the binding and the blob are verified by the caller. */
export function parseDelegatedOfferSigningResponse(raw: unknown): DelegatedOfferSigningResponse | undefined {
  const record = exactRecord(raw, ['protocol', 'signerId', 'requestId', 'capabilityId', 'ownerAccount', 'delegateAccount', 'signedTransaction', 'hash']);
  if (record === undefined || record['protocol'] !== DELEGATED_OFFER_SIGNER_PROTOCOL) return undefined;
  if (!isDelegatedOfferSignerId(record['signerId']) || !isDelegatedOfferRequestId(record['requestId'])) return undefined;
  if (typeof record['capabilityId'] !== 'string' || !CAPABILITY_ID.test(record['capabilityId'])) return undefined;
  if (!isDelegatedOfferAccount(record['ownerAccount']) || !isDelegatedOfferAccount(record['delegateAccount'])) return undefined;
  if (typeof record['signedTransaction'] !== 'string' || !SIGNED_BLOB.test(record['signedTransaction']) || !isXrplTransactionHash(record['hash'])) return undefined;
  return Object.freeze({
    protocol: DELEGATED_OFFER_SIGNER_PROTOCOL,
    signerId: record['signerId'],
    requestId: record['requestId'],
    capabilityId: record['capabilityId'],
    ownerAccount: record['ownerAccount'],
    delegateAccount: record['delegateAccount'],
    signedTransaction: record['signedTransaction'],
    hash: record['hash'],
  });
}
