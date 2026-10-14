import { isXrplLedgerHash, isXrplLedgerIndex } from './xrpl-ledger-grammar.js';
import { checkXrplNetworkIdentity } from './xrpl-network-identity.js';

/**
 * Validated-ledger evidence (TRADE-04A) — pure, total and conservative.
 *
 * Only a **validated** ledger is evidence: validated ledgers are the output of
 * consensus and immutable. A current (open) or closed-but-unvalidated answer
 * can still change, so it never satisfies a validated-read contract, however
 * plausible it looks. Every reader here answers a value only from an answer
 * that says `validated: true` (or, for `server_info`, names its
 * `validated_ledger`), on the expected network, with a well-formed index and
 * hash — and `undefined` or a closed failure code otherwise.
 */

function recordOf(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Readonly<Record<string, unknown>>) : undefined;
}

/** A plain object's own data property, never a getter; `undefined` when absent or not a data property. */
function field(record: unknown, name: string): unknown {
  if (typeof record !== 'object' || record === null || Array.isArray(record)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(record, name);
  return descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return (prototype === Object.prototype || prototype === null) && Object.getOwnPropertySymbols(value).length === 0;
}

/** The validated ledger index a client answered, or `undefined`. The PAY-02 rail's `readLedgerIndex`, unchanged. */
export function readXrplLedgerIndex(raw: unknown): number | undefined {
  return typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0 ? raw : undefined;
}

/**
 * A **validated** ledger's index and consensus close time (seconds since the
 * Ripple epoch), or `undefined` when it is not validated or either fact is
 * absent or malformed. The PAY-03 rail's `readLedgerHeader`, unchanged.
 */
export function readXrplLedgerHeader(raw: unknown): { readonly index: number; readonly closeTime: number } | undefined {
  const header = recordOf(raw);
  const index = readXrplLedgerIndex(header?.['ledger_index']);
  const closeTime = header?.['close_time'];
  if (header?.['validated'] !== true || index === undefined || typeof closeTime !== 'number' || !Number.isSafeInteger(closeTime) || closeTime < 0) return undefined;
  return { index, closeTime };
}

/** Closed failure codes of the validated-read contracts. A code names the check that failed; never a value, an endpoint or a credential. */
export const XRPL_VALIDATED_READ_FAILURES = Object.freeze({
  READER_INVALID: 'XRPL_READ_REQUEST_INVALID',
  LEDGER_UNREACHABLE: 'XRPL_READ_LEDGER_UNREACHABLE',
  TIMEOUT: 'XRPL_READ_TIMEOUT',
  RESPONSE_MALFORMED: 'XRPL_READ_RESPONSE_MALFORMED',
  RESPONSE_TOO_LARGE: 'XRPL_READ_RESPONSE_TOO_LARGE',
  NETWORK_UNSTATED: 'XRPL_READ_NETWORK_UNSTATED',
  NETWORK_MISMATCH: 'XRPL_READ_NETWORK_MISMATCH',
  NODE_IDENTITY_MISMATCH: 'XRPL_READ_NODE_IDENTITY_MISMATCH',
  NO_VALIDATED_LEDGER: 'XRPL_READ_NO_VALIDATED_LEDGER',
  VALIDATED_LEDGER_TOO_OLD: 'XRPL_READ_VALIDATED_LEDGER_TOO_OLD',
  NOT_VALIDATED: 'XRPL_READ_NOT_VALIDATED',
  LEDGER_REGRESSED: 'XRPL_READ_LEDGER_REGRESSED',
  LEDGER_HASH_CONFLICT: 'XRPL_READ_LEDGER_HASH_CONFLICT',
  LEDGER_ERROR: 'XRPL_READ_LEDGER_ERROR',
} as const);

export type XrplValidatedReadFailure = (typeof XRPL_VALIDATED_READ_FAILURES)[keyof typeof XRPL_VALIDATED_READ_FAILURES];

/** The latest validated ledger a server reported, on the network it was required to be on. */
export interface XrplValidatedLedger {
  readonly networkId: number;
  readonly ledgerIndex: number;
  readonly ledgerHash: string;
  /** Seconds since that ledger closed, as the server reported it. */
  readonly ageSeconds: number;
}

/** The node's public identity in `server_info.info.pubkey_node` (base58, `n…`). Compared exactly when trusted configuration pins it. */
const NODE_PUBLIC_KEY = /^n[1-9A-HJ-NP-Za-km-z]{50,52}$/;

export function isXrplNodePublicKey(value: unknown): value is string {
  return typeof value === 'string' && NODE_PUBLIC_KEY.test(value);
}

/**
 * `server_info` → the network's latest validated ledger, or a failure.
 *
 * The network identity is checked first: a server that does not state its
 * network id, or states another, is refused before anything else it says is
 * read. A pinned node identity, when configured, must match exactly. A server
 * with no validated ledger, or one older than `maxAgeSeconds`, is not current
 * evidence.
 */
export function readXrplServerValidatedLedger(
  serverInfo: unknown,
  expected: { readonly networkId: number; readonly maxAgeSeconds: number; readonly nodePublicKey?: string },
): XrplValidatedLedger | XrplValidatedReadFailure {
  const F = XRPL_VALIDATED_READ_FAILURES;
  if (!isPlainRecord(serverInfo)) return F.RESPONSE_MALFORMED;
  if (field(serverInfo, 'error') !== undefined) return F.LEDGER_ERROR;
  const info = field(serverInfo, 'info');
  if (!isPlainRecord(info)) return F.RESPONSE_MALFORMED;
  const identity = checkXrplNetworkIdentity({ info: { network_id: field(info, 'network_id') } }, expected.networkId);
  if (!identity.ok) return identity.failure === 'NETWORK_UNSTATED' ? F.NETWORK_UNSTATED : F.NETWORK_MISMATCH;
  if (expected.nodePublicKey !== undefined && field(info, 'pubkey_node') !== expected.nodePublicKey) return F.NODE_IDENTITY_MISMATCH;
  const validated = field(info, 'validated_ledger');
  if (validated === undefined) return F.NO_VALIDATED_LEDGER;
  if (!isPlainRecord(validated)) return F.RESPONSE_MALFORMED;
  const index = field(validated, 'seq');
  const hash = field(validated, 'hash');
  const age = field(validated, 'age');
  if (!isXrplLedgerIndex(index) || !isXrplLedgerHash(hash) || typeof age !== 'number' || !Number.isSafeInteger(age) || age < 0) return F.RESPONSE_MALFORMED;
  if (age > expected.maxAgeSeconds) return F.VALIDATED_LEDGER_TOO_OLD;
  return Object.freeze({ networkId: identity.networkId, ledgerIndex: index, ledgerHash: hash, ageSeconds: age });
}

/** A validated ledger header: index, hash and consensus close time. */
export interface XrplValidatedLedgerHeader {
  readonly ledgerIndex: number;
  readonly ledgerHash: string;
  /** Seconds since the Ripple epoch. */
  readonly closeTime: number;
}

/** A raw `ledger` header answer for `index` → its validated header, or a failure. An unvalidated header is `NOT_VALIDATED`, never a header. */
export function readXrplValidatedLedgerHeader(raw: unknown, index: number): XrplValidatedLedgerHeader | XrplValidatedReadFailure {
  const F = XRPL_VALIDATED_READ_FAILURES;
  if (!isPlainRecord(raw)) return F.RESPONSE_MALFORMED;
  if (field(raw, 'validated') !== true) return F.NOT_VALIDATED;
  const header = readXrplLedgerHeader({ ledger_index: field(raw, 'ledger_index'), close_time: field(raw, 'close_time'), validated: true });
  const ledgerHash = field(raw, 'ledger_hash');
  if (header === undefined || !isXrplLedgerIndex(header.index) || !isXrplLedgerHash(ledgerHash)) return F.RESPONSE_MALFORMED;
  if (header.index !== index) return F.RESPONSE_MALFORMED;
  return Object.freeze({ ledgerIndex: header.index, ledgerHash, closeTime: header.closeTime });
}

/**
 * Binds a validated answer (a `ledger_entry`, `account_info`, … result) to the
 * validated ledger the same server just reported:
 *
 * - it says `validated: true`, with a well-formed index and hash;
 * - its index is not **behind** the reported validated ledger (a lagging or
 *   different node answered);
 * - at the same index, it states the same hash (one index has one validated
 *   hash: two mean two chains).
 */
export function bindXrplValidatedAnswer(result: unknown, reference: XrplValidatedLedger): { readonly ledgerIndex: number; readonly ledgerHash: string } | XrplValidatedReadFailure {
  const F = XRPL_VALIDATED_READ_FAILURES;
  if (!isPlainRecord(result)) return F.RESPONSE_MALFORMED;
  if (field(result, 'validated') !== true) return F.NOT_VALIDATED;
  const ledgerIndex = field(result, 'ledger_index');
  const ledgerHash = field(result, 'ledger_hash');
  if (!isXrplLedgerIndex(ledgerIndex) || !isXrplLedgerHash(ledgerHash)) return F.RESPONSE_MALFORMED;
  if (ledgerIndex < reference.ledgerIndex) return F.LEDGER_REGRESSED;
  if (ledgerIndex === reference.ledgerIndex && ledgerHash !== reference.ledgerHash) return F.LEDGER_HASH_CONFLICT;
  return Object.freeze({ ledgerIndex, ledgerHash });
}
