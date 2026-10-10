import { isXrplClassicAddress, isXrplCurrencyCode, isXrplSigningPublicKey, isXrplTransactionHash, type XrplPreparedPayment } from '../../features/payment-runtime/rails/xrpl/index.js';

/**
 * PAY-03 — `frontera.external-xrpl-transaction-signer.v1`: the closed,
 * versioned protocol between the Frontera Host and an external,
 * customer-controlled XRPL transaction signer.
 *
 * Modelled on CORE-02's external authority signer: one non-signing identity
 * answer, and **one** narrowly typed signing operation — sign the XRPL
 * `Payment` PAY-02 prepared. There is no "sign these bytes", no "sign any
 * transaction", no key export and no submission: a signer that implements this
 * protocol signs exactly one shape of transaction and hands it back.
 *
 * ```
 * GET  /v1/identity            → { protocol, signerId, operations: ['sign-xrpl-payment'], accounts: [{ address, signingPublicKey }] }
 * POST /v1/sign/xrpl-payment   ← { protocol, signerId, requestId, account, transaction }
 *                              → { protocol, signerId, requestId, account, signedTransaction, hash }
 * ```
 *
 * The signer decides **nothing**: governance, limits, approvals and the grant
 * were settled before the Host prepared the payment. The Host trusts nothing
 * it answers: the identity is compared with trusted configuration (no TOFU),
 * and every signed blob is decoded and verified locally — same transaction,
 * pinned signing key, valid signature, own hash — before the one submission.
 *
 * Both directions are exact, closed, plain-JSON records: an unknown, missing
 * or extra field is refused, never ignored.
 */
export const EXTERNAL_XRPL_SIGNER_PROTOCOL = 'frontera.external-xrpl-transaction-signer.v1';
export const EXTERNAL_XRPL_SIGNER_OPERATION = 'sign-xrpl-payment';
export const EXTERNAL_XRPL_SIGNER_PATHS = Object.freeze({ identity: '/v1/identity', signPayment: '/v1/sign/xrpl-payment' });

/** A signer identity: a recordable handle, never a secret. */
const SIGNER_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/;
/** A per-request correlation the Host draws fresh: 32 random bytes as lowercase hex. A response for another request is refused. */
const REQUEST_ID = /^[0-9a-f]{64}$/;
const SIGNED_BLOB = /^(?:[0-9A-F]{2}){32,4096}$/;
const DECIMAL = /^(?:0|[1-9][0-9]{0,39})(?:\.[0-9]{1,96})?$/;
const FEE = /^[1-9][0-9]{0,15}$/;
const MAXIMUM_ACCOUNTS = 64;

export function isExternalXrplSignerId(value: unknown): value is string {
  return typeof value === 'string' && SIGNER_ID.test(value);
}

export function isExternalXrplSignerRequestId(value: unknown): value is string {
  return typeof value === 'string' && REQUEST_ID.test(value);
}

export interface ExternalXrplSignerIdentity {
  readonly protocol: typeof EXTERNAL_XRPL_SIGNER_PROTOCOL;
  readonly signerId: string;
  readonly operations: readonly [typeof EXTERNAL_XRPL_SIGNER_OPERATION];
  readonly accounts: readonly { readonly address: string; readonly signingPublicKey: string }[];
}

export interface ExternalXrplSigningRequest {
  readonly protocol: typeof EXTERNAL_XRPL_SIGNER_PROTOCOL;
  readonly signerId: string;
  readonly requestId: string;
  readonly account: string;
  readonly transaction: XrplPreparedPayment;
}

export interface ExternalXrplSigningResponse {
  readonly protocol: typeof EXTERNAL_XRPL_SIGNER_PROTOCOL;
  readonly signerId: string;
  readonly requestId: string;
  readonly account: string;
  readonly signedTransaction: string;
  readonly hash: string;
}

/** A plain object whose own keys are exactly `required` plus any of `optional`, all enumerable data properties. */
function exactRecord(value: unknown, required: readonly string[], optional: readonly string[] = []): Readonly<Record<string, unknown>> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const keys = Reflect.ownKeys(value);
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (typeof key !== 'string' || (!required.includes(key) && !optional.includes(key))) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor) || descriptor.enumerable !== true) return undefined;
    out[key] = descriptor.value as unknown;
  }
  for (const key of required) if (!(key in out)) return undefined;
  return out;
}

const isPositiveInteger = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const isUint32 = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff;

/** Parses an identity answer. `undefined` for anything that is not exactly one. */
export function parseExternalXrplSignerIdentity(raw: unknown): ExternalXrplSignerIdentity | undefined {
  const record = exactRecord(raw, ['protocol', 'signerId', 'operations', 'accounts']);
  if (record === undefined || record['protocol'] !== EXTERNAL_XRPL_SIGNER_PROTOCOL || !isExternalXrplSignerId(record['signerId'])) return undefined;
  const operations = record['operations'];
  if (!Array.isArray(operations) || operations.length !== 1 || operations[0] !== EXTERNAL_XRPL_SIGNER_OPERATION) return undefined;
  const accounts = record['accounts'];
  if (!Array.isArray(accounts) || accounts.length === 0 || accounts.length > MAXIMUM_ACCOUNTS) return undefined;
  const parsed: { address: string; signingPublicKey: string }[] = [];
  const seen = new Set<string>();
  for (const entry of accounts as unknown[]) {
    const account = exactRecord(entry, ['address', 'signingPublicKey']);
    if (account === undefined || !isXrplClassicAddress(account['address']) || !isXrplSigningPublicKey(account['signingPublicKey'])) return undefined;
    if (seen.has(account['address'])) return undefined;
    seen.add(account['address']);
    parsed.push(Object.freeze({ address: account['address'], signingPublicKey: account['signingPublicKey'] }));
  }
  return Object.freeze({ protocol: EXTERNAL_XRPL_SIGNER_PROTOCOL, signerId: record['signerId'], operations: Object.freeze([EXTERNAL_XRPL_SIGNER_OPERATION] as const), accounts: Object.freeze(parsed) });
}

/**
 * Parses a prepared Payment exactly as PAY-02 builds it — server side, so the
 * signer can refuse anything else before it touches its key: `Payment`, flags
 * 0, an issued-currency amount, the rail's own fields and nothing more (no
 * memo, path, `SendMax`, `SigningPubKey`, signer list or anything new).
 */
export function parsePreparedXrplPayment(raw: unknown): XrplPreparedPayment | undefined {
  const tx = exactRecord(raw, ['TransactionType', 'Account', 'Destination', 'Amount', 'Flags', 'LastLedgerSequence', 'Sequence', 'Fee'], ['DestinationTag']);
  if (tx === undefined || tx['TransactionType'] !== 'Payment' || tx['Flags'] !== 0) return undefined;
  if (!isXrplClassicAddress(tx['Account']) || !isXrplClassicAddress(tx['Destination']) || tx['Account'] === tx['Destination']) return undefined;
  if (tx['DestinationTag'] !== undefined && !isUint32(tx['DestinationTag'])) return undefined;
  if (!isPositiveInteger(tx['LastLedgerSequence']) || !isPositiveInteger(tx['Sequence']) || typeof tx['Fee'] !== 'string' || !FEE.test(tx['Fee'])) return undefined;
  const amount = exactRecord(tx['Amount'], ['currency', 'issuer', 'value']);
  if (amount === undefined || !isXrplCurrencyCode(amount['currency']) || !isXrplClassicAddress(amount['issuer']) || typeof amount['value'] !== 'string' || !DECIMAL.test(amount['value'])) return undefined;
  return Object.freeze({
    TransactionType: 'Payment',
    Account: tx['Account'],
    Destination: tx['Destination'],
    ...(tx['DestinationTag'] !== undefined ? { DestinationTag: tx['DestinationTag'] as number } : {}),
    Amount: Object.freeze({ currency: amount['currency'], issuer: amount['issuer'], value: amount['value'] }),
    Flags: 0,
    LastLedgerSequence: tx['LastLedgerSequence'],
    Sequence: tx['Sequence'],
    Fee: tx['Fee'],
  });
}

/** Parses a signing request (server side). */
export function parseExternalXrplSigningRequest(raw: unknown): ExternalXrplSigningRequest | undefined {
  const record = exactRecord(raw, ['protocol', 'signerId', 'requestId', 'account', 'transaction']);
  if (record === undefined || record['protocol'] !== EXTERNAL_XRPL_SIGNER_PROTOCOL) return undefined;
  if (!isExternalXrplSignerId(record['signerId']) || !isExternalXrplSignerRequestId(record['requestId']) || !isXrplClassicAddress(record['account'])) return undefined;
  const transaction = parsePreparedXrplPayment(record['transaction']);
  if (transaction === undefined || transaction.Account !== record['account']) return undefined;
  return Object.freeze({ protocol: EXTERNAL_XRPL_SIGNER_PROTOCOL, signerId: record['signerId'], requestId: record['requestId'], account: record['account'], transaction });
}

/** Parses a signing response (Host side). Shape only; the binding and the blob are verified by the caller and the rail. */
export function parseExternalXrplSigningResponse(raw: unknown): ExternalXrplSigningResponse | undefined {
  const record = exactRecord(raw, ['protocol', 'signerId', 'requestId', 'account', 'signedTransaction', 'hash']);
  if (record === undefined || record['protocol'] !== EXTERNAL_XRPL_SIGNER_PROTOCOL) return undefined;
  if (!isExternalXrplSignerId(record['signerId']) || !isExternalXrplSignerRequestId(record['requestId']) || !isXrplClassicAddress(record['account'])) return undefined;
  if (typeof record['signedTransaction'] !== 'string' || !SIGNED_BLOB.test(record['signedTransaction']) || !isXrplTransactionHash(record['hash'])) return undefined;
  return Object.freeze({
    protocol: EXTERNAL_XRPL_SIGNER_PROTOCOL,
    signerId: record['signerId'],
    requestId: record['requestId'],
    account: record['account'],
    signedTransaction: record['signedTransaction'],
    hash: record['hash'],
  });
}
