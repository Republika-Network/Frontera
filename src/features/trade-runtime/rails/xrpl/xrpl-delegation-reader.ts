import {
  TRADE_DELEGATION_MAXIMUM_PERMISSIONS,
  TRADE_DELEGATION_OBSERVATION_SCHEMA,
  TRADE_NETWORKS,
  canonicalTradeDelegationPermission,
  checkTradeAccountAddress,
  isTradeInstant,
  isTradeNetwork,
  parseTradeDelegationObservation,
  tradeDelegateEntryIndex,
} from '../../domain/index.js';
import type { TradeDelegationObservation, TradeNetwork } from '../../domain/index.js';

/**
 * The read-only XRPL delegation reader (TRADE-02).
 *
 * It answers one question — what does the latest validated ledger say about
 * the XLS-75 `Delegate` entry for (owner, delegate)? — with an observation, or
 * says it cannot answer. It never treats a failure as an answer: an
 * unreachable node, a response of the wrong shape, an unvalidated or lagging
 * ledger, or an entry for another pair is `unavailable`, never "absent" and
 * never "granted". Absence is reported only from a validated ledger's own
 * `entryNotFound` at a stated ledger index and hash.
 *
 * It reaches the ledger only through `XrplDelegationLedgerPort`, which has
 * exactly two read methods and no way to sign, submit or ask anything else.
 * One attempt per read: no retry, no fallback node. Composing a real port over
 * a network transport is TRADE-04's (shared transport, architectural review);
 * here the port is satisfied by fakes only.
 */

/**
 * The only two ledger requests the reader can make. Each returns the
 * JSON-RPC `result` object exactly as the server sent it — error results such
 * as `entryNotFound` included — and rejects only when the server could not be
 * asked or did not answer.
 */
export interface XrplDelegationLedgerPort {
  /** `server_info`. */
  serverInfo(): Promise<unknown>;
  /** `ledger_entry` for a `Delegate` entry, always at the latest validated ledger. */
  ledgerEntryDelegate(request: XrplDelegateLedgerEntryRequest): Promise<unknown>;
}

export interface XrplDelegateLedgerEntryRequest {
  readonly delegate: { readonly account: string; readonly authorize: string };
  readonly ledger_index: 'validated';
}

export interface XrplDelegationReaderOptions {
  readonly port: XrplDelegationLedgerPort;
  readonly network: TradeNetwork;
  /** The instant source; must return `Date.prototype.toISOString` form. Injected, so the reader holds no clock of its own. */
  readonly clock: () => string;
  /** How long ago the node's latest validated ledger may have closed, 1 to 60 seconds. A node further behind is not asked about the entry. */
  readonly maxValidatedLedgerAgeSeconds: number;
}

export const XRPL_DELEGATION_READ_FAILURES = Object.freeze({
  REQUEST_INVALID: 'DELEGATION_READ_REQUEST_INVALID',
  CLOCK_INVALID: 'DELEGATION_READ_CLOCK_INVALID',
  LEDGER_UNREACHABLE: 'DELEGATION_READ_LEDGER_UNREACHABLE',
  RESPONSE_MALFORMED: 'DELEGATION_READ_RESPONSE_MALFORMED',
  NETWORK_MISMATCH: 'DELEGATION_READ_NETWORK_MISMATCH',
  NO_VALIDATED_LEDGER: 'DELEGATION_READ_NO_VALIDATED_LEDGER',
  VALIDATED_LEDGER_TOO_OLD: 'DELEGATION_READ_VALIDATED_LEDGER_TOO_OLD',
  NOT_VALIDATED: 'DELEGATION_READ_NOT_VALIDATED',
  LEDGER_REGRESSED: 'DELEGATION_READ_LEDGER_REGRESSED',
  LEDGER_HASH_CONFLICT: 'DELEGATION_READ_LEDGER_HASH_CONFLICT',
  ENTRY_MISMATCH: 'DELEGATION_READ_ENTRY_MISMATCH',
  LEDGER_ERROR: 'DELEGATION_READ_LEDGER_ERROR',
} as const);

export type XrplDelegationReadFailure = (typeof XRPL_DELEGATION_READ_FAILURES)[keyof typeof XRPL_DELEGATION_READ_FAILURES];

export type XrplDelegationRead =
  | { readonly outcome: 'observed'; readonly observation: TradeDelegationObservation }
  | { readonly outcome: 'unavailable'; readonly failure: XrplDelegationReadFailure };

export interface XrplDelegationReader {
  observe(request: { readonly owner: string; readonly delegate: string }): Promise<XrplDelegationRead>;
}

export class XrplDelegationReaderConfigurationError extends Error {
  readonly code: 'TRADE_CONFIGURATION_INVALID';

  constructor(message: string) {
    super(message);
    this.name = 'XrplDelegationReaderConfigurationError';
    this.code = 'TRADE_CONFIGURATION_INVALID';
  }
}

const MAXIMUM_VALIDATED_LEDGER_AGE_SECONDS = 60;
const LEDGER_HASH = /^[0-9A-F]{64}$/;
const UINT32_MAXIMUM = 4_294_967_295;
/** Fields a `Delegate` entry may carry (rippled 3.4.1 `ledger_entries.macro`, plus the common `Flags` and the JSON `index`). Anything else is a shape this reader does not know, and it refuses rather than guesses. */
const DELEGATE_ENTRY_REQUIRED = ['Account', 'Authorize', 'Flags', 'LedgerEntryType', 'OwnerNode', 'Permissions', 'PreviousTxnID', 'PreviousTxnLgrSeq', 'index'] as const;
const DELEGATE_ENTRY_OPTIONAL = ['DestinationNode'] as const;
const OWNER_NODE = /^[0-9A-Fa-f]{1,16}$/;

function unavailable(failure: XrplDelegationReadFailure): XrplDelegationRead {
  return Object.freeze({ outcome: 'unavailable' as const, failure });
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

function isLedgerIndex(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= UINT32_MAXIMUM;
}

function isLedgerHash(value: unknown): value is string {
  return typeof value === 'string' && LEDGER_HASH.test(value);
}

interface ValidatedLedger {
  readonly index: number;
  readonly hash: string;
  readonly ageSeconds: number;
}

/** `server_info` → the node's network id and latest validated ledger, or a failure. */
function readServerInfo(result: unknown, networkId: number): ValidatedLedger | XrplDelegationReadFailure {
  if (!isPlainRecord(result)) return XRPL_DELEGATION_READ_FAILURES.RESPONSE_MALFORMED;
  if (field(result, 'error') !== undefined) return XRPL_DELEGATION_READ_FAILURES.LEDGER_ERROR;
  const info = field(result, 'info');
  if (!isPlainRecord(info)) return XRPL_DELEGATION_READ_FAILURES.RESPONSE_MALFORMED;
  // A node that does not state its network id is not the network asked for.
  if (field(info, 'network_id') !== networkId) return XRPL_DELEGATION_READ_FAILURES.NETWORK_MISMATCH;
  const validated = field(info, 'validated_ledger');
  if (validated === undefined) return XRPL_DELEGATION_READ_FAILURES.NO_VALIDATED_LEDGER;
  if (!isPlainRecord(validated)) return XRPL_DELEGATION_READ_FAILURES.RESPONSE_MALFORMED;
  const index = field(validated, 'seq');
  const age = field(validated, 'age');
  const hash = field(validated, 'hash');
  if (!isLedgerIndex(index) || !isLedgerHash(hash) || typeof age !== 'number' || !Number.isSafeInteger(age) || age < 0) return XRPL_DELEGATION_READ_FAILURES.RESPONSE_MALFORMED;
  return { index, hash, ageSeconds: age };
}

type EntryRead =
  | { readonly state: 'absent'; readonly ledgerIndex: number; readonly ledgerHash: string }
  | { readonly state: 'granted'; readonly ledgerIndex: number; readonly ledgerHash: string; readonly permissions: readonly string[]; readonly previousTxnId: string; readonly previousTxnLedgerIndex: number };

/** `ledger_entry` → the entry (or its validated absence) for exactly (owner, delegate) at `entryIndex`, or a failure. */
function readDelegateEntry(result: unknown, owner: string, delegate: string, entryIndex: string): EntryRead | XrplDelegationReadFailure {
  if (!isPlainRecord(result)) return XRPL_DELEGATION_READ_FAILURES.RESPONSE_MALFORMED;
  const ledgerIndex = field(result, 'ledger_index');
  const ledgerHash = field(result, 'ledger_hash');
  const error = field(result, 'error');
  if (error !== undefined) {
    // Absence is an answer only from a validated ledger that says which one it is.
    if (error !== 'entryNotFound') return XRPL_DELEGATION_READ_FAILURES.LEDGER_ERROR;
    if (field(result, 'validated') !== true) return XRPL_DELEGATION_READ_FAILURES.NOT_VALIDATED;
    if (!isLedgerIndex(ledgerIndex) || !isLedgerHash(ledgerHash)) return XRPL_DELEGATION_READ_FAILURES.RESPONSE_MALFORMED;
    // rippled 3.4.1 names the key it looked up; when it does, it must be this pair's key.
    const lookedUp = field(result, 'index');
    if (lookedUp !== undefined && lookedUp !== entryIndex) return XRPL_DELEGATION_READ_FAILURES.ENTRY_MISMATCH;
    return { state: 'absent', ledgerIndex, ledgerHash };
  }
  if (field(result, 'validated') !== true) return XRPL_DELEGATION_READ_FAILURES.NOT_VALIDATED;
  if (!isLedgerIndex(ledgerIndex) || !isLedgerHash(ledgerHash)) return XRPL_DELEGATION_READ_FAILURES.RESPONSE_MALFORMED;
  const node = field(result, 'node');
  if (!isPlainRecord(node)) return XRPL_DELEGATION_READ_FAILURES.RESPONSE_MALFORMED;
  const keys = Object.getOwnPropertyNames(node);
  if (!DELEGATE_ENTRY_REQUIRED.every((name) => keys.includes(name)) || !keys.every((name) => (DELEGATE_ENTRY_REQUIRED as readonly string[]).includes(name) || (DELEGATE_ENTRY_OPTIONAL as readonly string[]).includes(name))) {
    return XRPL_DELEGATION_READ_FAILURES.RESPONSE_MALFORMED;
  }
  if (field(node, 'LedgerEntryType') !== 'Delegate' || field(node, 'Flags') !== 0) return XRPL_DELEGATION_READ_FAILURES.RESPONSE_MALFORMED;
  // The entry must be the one asked about: its own key, both in the response and in the node, and its own pair.
  if (field(result, 'index') !== entryIndex || field(node, 'index') !== entryIndex) return XRPL_DELEGATION_READ_FAILURES.ENTRY_MISMATCH;
  if (field(node, 'Account') !== owner || field(node, 'Authorize') !== delegate) return XRPL_DELEGATION_READ_FAILURES.ENTRY_MISMATCH;
  const ownerNode = field(node, 'OwnerNode');
  const destinationNode = field(node, 'DestinationNode');
  if (typeof ownerNode !== 'string' || !OWNER_NODE.test(ownerNode) || (destinationNode !== undefined && (typeof destinationNode !== 'string' || !OWNER_NODE.test(destinationNode)))) return XRPL_DELEGATION_READ_FAILURES.RESPONSE_MALFORMED;
  const previousTxnId = field(node, 'PreviousTxnID');
  const previousTxnLedgerIndex = field(node, 'PreviousTxnLgrSeq');
  if (!isLedgerHash(previousTxnId) || !isLedgerIndex(previousTxnLedgerIndex) || previousTxnLedgerIndex > ledgerIndex) return XRPL_DELEGATION_READ_FAILURES.RESPONSE_MALFORMED;
  const rawPermissions = field(node, 'Permissions');
  if (!Array.isArray(rawPermissions) || rawPermissions.length < 1 || rawPermissions.length > TRADE_DELEGATION_MAXIMUM_PERMISSIONS) return XRPL_DELEGATION_READ_FAILURES.RESPONSE_MALFORMED;
  const permissions: string[] = [];
  for (let position = 0; position < rawPermissions.length; position += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(rawPermissions, position);
    const wrapper = descriptor !== undefined && 'value' in descriptor ? (descriptor.value as unknown) : undefined;
    const holder = isPlainRecord(wrapper) && Object.getOwnPropertyNames(wrapper).length === 1 ? field(wrapper, 'Permission') : undefined;
    const value = isPlainRecord(holder) && Object.getOwnPropertyNames(holder).length === 1 ? field(holder, 'PermissionValue') : undefined;
    const permission = canonicalTradeDelegationPermission(value);
    if (permission === undefined || permissions.includes(permission)) return XRPL_DELEGATION_READ_FAILURES.RESPONSE_MALFORMED;
    permissions.push(permission);
  }
  return { state: 'granted', ledgerIndex, ledgerHash, permissions: permissions.sort(), previousTxnId, previousTxnLedgerIndex };
}

export function createXrplDelegationReader(options: XrplDelegationReaderOptions): XrplDelegationReader {
  if (typeof options !== 'object' || options === null) throw new XrplDelegationReaderConfigurationError('Delegation reader options are required.');
  const { port, network, clock, maxValidatedLedgerAgeSeconds } = options;
  if (typeof port !== 'object' || port === null || typeof port.serverInfo !== 'function' || typeof port.ledgerEntryDelegate !== 'function') throw new XrplDelegationReaderConfigurationError('A ledger read port with serverInfo and ledgerEntryDelegate is required.');
  if (!isTradeNetwork(network)) throw new XrplDelegationReaderConfigurationError('The network must be a TRADE network (Testnet or Devnet).');
  if (typeof clock !== 'function') throw new XrplDelegationReaderConfigurationError('A clock is required.');
  if (typeof maxValidatedLedgerAgeSeconds !== 'number' || !Number.isSafeInteger(maxValidatedLedgerAgeSeconds) || maxValidatedLedgerAgeSeconds < 1 || maxValidatedLedgerAgeSeconds > MAXIMUM_VALIDATED_LEDGER_AGE_SECONDS) {
    throw new XrplDelegationReaderConfigurationError(`maxValidatedLedgerAgeSeconds must be an integer from 1 to ${String(MAXIMUM_VALIDATED_LEDGER_AGE_SECONDS)}.`);
  }
  const networkId = TRADE_NETWORKS[network].networkId;

  async function observe(request: { readonly owner: string; readonly delegate: string }): Promise<XrplDelegationRead> {
    const owner = field(request, 'owner');
    const delegate = field(request, 'delegate');
    if (checkTradeAccountAddress(owner) !== 'valid' || checkTradeAccountAddress(delegate) !== 'valid' || owner === delegate) return unavailable(XRPL_DELEGATION_READ_FAILURES.REQUEST_INVALID);
    const entryIndex = tradeDelegateEntryIndex(owner, delegate) as string;

    // The instant is taken before anything is asked: the observation is never younger than what it saw.
    let observedAt: unknown;
    try {
      observedAt = clock();
    } catch {
      return unavailable(XRPL_DELEGATION_READ_FAILURES.CLOCK_INVALID);
    }
    if (!isTradeInstant(observedAt)) return unavailable(XRPL_DELEGATION_READ_FAILURES.CLOCK_INVALID);

    let info: unknown;
    try {
      info = await port.serverInfo();
    } catch {
      return unavailable(XRPL_DELEGATION_READ_FAILURES.LEDGER_UNREACHABLE);
    }
    const validated = readServerInfo(info, networkId);
    if (typeof validated === 'string') return unavailable(validated);
    if (validated.ageSeconds > maxValidatedLedgerAgeSeconds) return unavailable(XRPL_DELEGATION_READ_FAILURES.VALIDATED_LEDGER_TOO_OLD);

    let response: unknown;
    try {
      response = await port.ledgerEntryDelegate(Object.freeze({ delegate: Object.freeze({ account: owner as string, authorize: delegate as string }), ledger_index: 'validated' as const }));
    } catch {
      return unavailable(XRPL_DELEGATION_READ_FAILURES.LEDGER_UNREACHABLE);
    }
    const entry = readDelegateEntry(response, owner as string, delegate as string, entryIndex);
    if (typeof entry === 'string') return unavailable(entry);
    // The entry read must come from the validated ledger just reported, or a later one — never an earlier one (a lagging or different node).
    if (entry.ledgerIndex < validated.index) return unavailable(XRPL_DELEGATION_READ_FAILURES.LEDGER_REGRESSED);
    // One ledger index has one validated hash: two different ones mean two different chains (a fork, or two nodes answering).
    if (entry.ledgerIndex === validated.index && entry.ledgerHash !== validated.hash) return unavailable(XRPL_DELEGATION_READ_FAILURES.LEDGER_HASH_CONFLICT);

    const base = {
      schema: TRADE_DELEGATION_OBSERVATION_SCHEMA,
      network,
      networkId,
      validatedLedgerIndex: entry.ledgerIndex,
      validatedLedgerHash: entry.ledgerHash,
      owner,
      delegate,
      entryIndex,
      observedAt,
    };
    const candidate =
      entry.state === 'absent'
        ? { ...base, state: 'absent' }
        : { ...base, state: 'granted', permissions: entry.permissions, previousTxnId: entry.previousTxnId, previousTxnLedgerIndex: entry.previousTxnLedgerIndex };
    // The reader's output passes the same closed parser every consumer uses.
    const observation = parseTradeDelegationObservation(candidate);
    if (observation === undefined) return unavailable(XRPL_DELEGATION_READ_FAILURES.RESPONSE_MALFORMED);
    return Object.freeze({ outcome: 'observed' as const, observation });
  }

  return Object.freeze({ observe });
}
