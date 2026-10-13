import { createHash } from 'node:crypto';

import { TRADE_NETWORKS, checkTradeAccountAddress, isTradeNetwork, tradeAccountIdOf } from './trade-grammar.js';
import type { TradeNetwork } from './trade-grammar.js';

/**
 * Delegation evidence for governed trading (TRADE-02).
 *
 * An owner account lets a delegate account submit OfferCreate on its behalf
 * through an XLS-75 `Delegate` ledger entry. Frontera never creates, changes
 * or revokes that entry — the owner does, with its own tooling. This module
 * only says what an observation of the entry is, and whether one proves what a
 * trade needs:
 *
 * - **an observation** is what a read-only reader saw at one *validated*
 *   ledger: either the entry with its permissions, or its validated absence.
 *   It is a closed record, re-validated in full wherever it is used;
 * - **a verification** proves, for one network, owner and delegate, at one
 *   instant: the observation is fresh, not older than a ledger the caller
 *   already knows about, at the entry's own ledger key, and grants
 *   `OfferCreate` — and nothing beyond the trading permissions. Anything else
 *   is a refusal with one reason code, never a repaired or partial "yes".
 *
 * This is defence in depth, not the authority: the ledger re-checks the
 * permission when a delegated transaction is applied, and refuses it
 * (`terNO_DELEGATE_PERMISSION`) if the entry has been revoked meanwhile.
 *
 * Pure: no I/O, no clock (the instant is passed in), no randomness. The one
 * hash used (`createHash('sha512')`) computes the entry's ledger key.
 */

export const TRADE_DELEGATION_OBSERVATION_SCHEMA = 'frontera.trade-delegation-observation.v1';
export const TRADE_DELEGATION_EVIDENCE_SCHEMA = 'frontera.trade-delegation-evidence.v1';

/** The ledger permission a delegated OfferCreate needs (transaction type 7, permission value 8). */
export const TRADE_DELEGATION_REQUIRED_PERMISSION = 'OfferCreate';
/**
 * The permissions a trading delegation may carry. A delegate that may also
 * pay, set trust lines or burn tokens on the owner's behalf is a larger blast
 * radius than governed trading accepts (TRADE-00 §13.2), so an entry granting
 * anything else is refused even when it includes `OfferCreate`.
 */
export const TRADE_DELEGATION_TOLERATED_PERMISSIONS: readonly string[] = Object.freeze(['OfferCancel', 'OfferCreate']);
/** Transaction-type permissions, by the numeric value a ledger may report instead of the name (type + 1). */
const PERMISSION_NAMES_BY_VALUE: ReadonlyMap<number, string> = new Map([
  [8, 'OfferCreate'],
  [9, 'OfferCancel'],
]);
/** XLS-75: a `Delegate` entry carries 1 to 10 permissions. */
export const TRADE_DELEGATION_MAXIMUM_PERMISSIONS = 10;
/** The longest a delegation observation may be relied on. A requirement asking for more is refused, not clamped. */
export const TRADE_DELEGATION_MAXIMUM_AGE_SECONDS = 60;

const LEDGER_HASH = /^[0-9A-F]{64}$/;
const PERMISSION_NAME = /^[A-Za-z][A-Za-z0-9]{0,63}$/;
/** An instant, in exactly the form `Date.prototype.toISOString` writes it. */
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const UINT32_MAXIMUM = 4_294_967_295;

/** The `Delegate` ledger namespace (`'E'`), as the two-byte space prefix of its key. */
const DELEGATE_KEY_SPACE = Uint8Array.from([0x00, 0x45]);

/**
 * The ledger key of the `Delegate` entry for (owner, delegate):
 * SHA-512Half(0x0045 ‖ AccountID(owner) ‖ AccountID(delegate)), as 64
 * upper-case hexadecimal digits. `undefined` when either address is not a
 * valid, non-reserved classic address.
 */
export function tradeDelegateEntryIndex(owner: unknown, delegate: unknown): string | undefined {
  const ownerId = tradeAccountIdOf(owner);
  const delegateId = tradeAccountIdOf(delegate);
  if (ownerId === undefined || delegateId === undefined) return undefined;
  const digest = createHash('sha512').update(DELEGATE_KEY_SPACE).update(ownerId).update(delegateId).digest();
  return digest.subarray(0, 32).toString('hex').toUpperCase();
}

/**
 * One permission as an entry reports it: a name, or the numeric permission
 * value. The two trading permissions are canonicalised to their names; any
 * other number is kept as `value:<n>` so that it is visible — and refused as
 * excess — rather than silently dropped. `undefined` for anything else.
 */
export function canonicalTradeDelegationPermission(value: unknown): string | undefined {
  if (typeof value === 'string') return PERMISSION_NAME.test(value) ? value : undefined;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= UINT32_MAXIMUM) return PERMISSION_NAMES_BY_VALUE.get(value) ?? `value:${String(value)}`;
  return undefined;
}

/** A permission exactly as `canonicalTradeDelegationPermission` writes it: a name, or `value:<n>` for a number that has no canonical name. */
function isCanonicalPermission(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (PERMISSION_NAME.test(value)) return true;
  const match = /^value:([1-9]\d{0,9})$/.exec(value);
  if (match === null) return false;
  const number = Number.parseInt(match[1] as string, 10);
  return number <= UINT32_MAXIMUM && !PERMISSION_NAMES_BY_VALUE.has(number);
}

// ── Observation ──────────────────────────────────────────────────────────────

interface TradeDelegationObservationBase {
  readonly schema: typeof TRADE_DELEGATION_OBSERVATION_SCHEMA;
  readonly network: TradeNetwork;
  readonly networkId: number;
  /** The validated ledger the entry (or its absence) was read at. */
  readonly validatedLedgerIndex: number;
  readonly validatedLedgerHash: string;
  readonly owner: string;
  readonly delegate: string;
  /** The entry's ledger key, `tradeDelegateEntryIndex(owner, delegate)`. */
  readonly entryIndex: string;
  /** When the reader began the read — taken before the ledger was asked, so an observation is never younger than what it saw. */
  readonly observedAt: string;
}

export interface TradeDelegationGrantedObservation extends TradeDelegationObservationBase {
  readonly state: 'granted';
  /** Canonical permissions, sorted. */
  readonly permissions: readonly string[];
  /** The transaction that last changed the entry, and its ledger. A revoke-and-re-grant changes both. */
  readonly previousTxnId: string;
  readonly previousTxnLedgerIndex: number;
}

export interface TradeDelegationAbsentObservation extends TradeDelegationObservationBase {
  /** The validated ledger has no entry at the key: never granted, or revoked. */
  readonly state: 'absent';
}

export type TradeDelegationObservation = TradeDelegationGrantedObservation | TradeDelegationAbsentObservation;

const BASE_FIELDS = ['schema', 'network', 'networkId', 'validatedLedgerIndex', 'validatedLedgerHash', 'owner', 'delegate', 'entryIndex', 'observedAt', 'state'] as const;
const GRANTED_FIELDS = [...BASE_FIELDS, 'permissions', 'previousTxnId', 'previousTxnLedgerIndex'] as const;

function isLedgerIndex(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= UINT32_MAXIMUM;
}

export function isTradeInstant(value: unknown): value is string {
  return typeof value === 'string' && INSTANT.test(value) && !Number.isNaN(Date.parse(value));
}

/** A plain object's own data properties, exactly the named ones; `undefined` for anything else (accessors, symbols, prototypes, extra or missing keys). */
function exactRecord(raw: unknown, fields: readonly string[]): Record<string, unknown> | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const prototype = Object.getPrototypeOf(raw) as unknown;
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  if (Object.getOwnPropertySymbols(raw).length > 0) return undefined;
  const keys = Object.getOwnPropertyNames(raw);
  if (keys.length !== fields.length || !fields.every((field) => keys.includes(field))) return undefined;
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(raw, field);
    if (descriptor === undefined || !('value' in descriptor)) return undefined;
    out[field] = descriptor.value;
  }
  return out;
}

/**
 * Re-validates an observation in full and returns a frozen copy, or
 * `undefined`. Every field is checked against its grammar and against the
 * others: the network id is the network's, the addresses are valid and
 * distinct, the entry index is the key of exactly this pair, and a granted
 * entry's permissions are canonical, sorted, distinct and 1 to 10.
 */
export function parseTradeDelegationObservation(raw: unknown): TradeDelegationObservation | undefined {
  // The field list depends on the state, read as a data property — a getter is never run.
  const stateDescriptor = typeof raw === 'object' && raw !== null ? Object.getOwnPropertyDescriptor(raw, 'state') : undefined;
  const granted = stateDescriptor !== undefined && 'value' in stateDescriptor && stateDescriptor.value === 'granted';
  const probe = exactRecord(raw, granted ? GRANTED_FIELDS : BASE_FIELDS);
  if (probe === undefined || probe['schema'] !== TRADE_DELEGATION_OBSERVATION_SCHEMA) return undefined;
  const network = probe['network'];
  if (!isTradeNetwork(network) || probe['networkId'] !== TRADE_NETWORKS[network].networkId) return undefined;
  const owner = probe['owner'];
  const delegate = probe['delegate'];
  if (checkTradeAccountAddress(owner) !== 'valid' || checkTradeAccountAddress(delegate) !== 'valid' || owner === delegate) return undefined;
  if (probe['entryIndex'] !== tradeDelegateEntryIndex(owner, delegate)) return undefined;
  if (!isLedgerIndex(probe['validatedLedgerIndex']) || typeof probe['validatedLedgerHash'] !== 'string' || !LEDGER_HASH.test(probe['validatedLedgerHash'])) return undefined;
  if (!isTradeInstant(probe['observedAt'])) return undefined;
  const base = {
    schema: TRADE_DELEGATION_OBSERVATION_SCHEMA,
    network,
    networkId: TRADE_NETWORKS[network].networkId,
    validatedLedgerIndex: probe['validatedLedgerIndex'],
    validatedLedgerHash: probe['validatedLedgerHash'],
    owner: owner as string,
    delegate: delegate as string,
    entryIndex: probe['entryIndex'] as string,
    observedAt: probe['observedAt'],
  } as const;
  if (probe['state'] === 'absent') return Object.freeze({ ...base, state: 'absent' as const });
  if (probe['state'] !== 'granted') return undefined;
  const permissions = probe['permissions'];
  if (!Array.isArray(permissions) || permissions.length < 1 || permissions.length > TRADE_DELEGATION_MAXIMUM_PERMISSIONS) return undefined;
  if (!permissions.every(isCanonicalPermission)) return undefined;
  const sorted = permissions as string[];
  if (sorted.some((permission, index) => index > 0 && !((sorted[index - 1] as string) < permission))) return undefined;
  if (typeof probe['previousTxnId'] !== 'string' || !LEDGER_HASH.test(probe['previousTxnId']) || !isLedgerIndex(probe['previousTxnLedgerIndex'])) return undefined;
  if (probe['previousTxnLedgerIndex'] > base.validatedLedgerIndex) return undefined;
  return Object.freeze({
    ...base,
    state: 'granted' as const,
    permissions: Object.freeze([...sorted]),
    previousTxnId: probe['previousTxnId'],
    previousTxnLedgerIndex: probe['previousTxnLedgerIndex'],
  });
}

// ── Verification ─────────────────────────────────────────────────────────────

export interface TradeDelegationRequirement {
  readonly network: TradeNetwork;
  readonly owner: string;
  readonly delegate: string;
  /** The instant the delegation must hold at (decision time, or immediately before signing). */
  readonly at: string;
  /** How old the observation may be at `at`, 1 to `TRADE_DELEGATION_MAXIMUM_AGE_SECONDS`. */
  readonly maxAgeSeconds: number;
  /**
   * The newest validated ledger the caller already holds an observation of
   * for this pair. An older observation is refused, so a revocation once seen
   * cannot be overridden by replaying an earlier "granted".
   */
  readonly minimumValidatedLedgerIndex?: number;
  /**
   * The `PreviousTxnID` of the entry the caller relied on earlier (for
   * example at decision time). A different one means the entry was changed —
   * possibly revoked and re-granted — in between, and is refused.
   */
  readonly expectedPreviousTxnId?: string;
}

export const TRADE_DELEGATION_REFUSAL_CODES = Object.freeze({
  OBSERVATION_MALFORMED: 'DELEGATION_OBSERVATION_MALFORMED',
  REQUIREMENT_INVALID: 'DELEGATION_REQUIREMENT_INVALID',
  NETWORK_MISMATCH: 'DELEGATION_NETWORK_MISMATCH',
  OWNER_MISMATCH: 'DELEGATION_OWNER_MISMATCH',
  DELEGATE_MISMATCH: 'DELEGATION_DELEGATE_MISMATCH',
  LEDGER_BELOW_MINIMUM: 'DELEGATION_LEDGER_BELOW_MINIMUM',
  OBSERVATION_FROM_FUTURE: 'DELEGATION_OBSERVATION_FROM_FUTURE',
  OBSERVATION_STALE: 'DELEGATION_OBSERVATION_STALE',
  ABSENT: 'DELEGATION_ABSENT',
  CHANGED: 'DELEGATION_CHANGED',
  PERMISSION_MISSING: 'DELEGATION_PERMISSION_MISSING',
  PERMISSION_EXCESS: 'DELEGATION_PERMISSION_EXCESS',
} as const);

export type TradeDelegationRefusalCode = (typeof TRADE_DELEGATION_REFUSAL_CODES)[keyof typeof TRADE_DELEGATION_REFUSAL_CODES];

/** What a successful verification proves, and from which ledger. */
export interface TradeDelegationEvidence {
  readonly schema: typeof TRADE_DELEGATION_EVIDENCE_SCHEMA;
  readonly network: TradeNetwork;
  readonly networkId: number;
  readonly owner: string;
  readonly delegate: string;
  readonly permission: typeof TRADE_DELEGATION_REQUIRED_PERMISSION;
  readonly permissions: readonly string[];
  readonly entryIndex: string;
  readonly validatedLedgerIndex: number;
  readonly validatedLedgerHash: string;
  readonly previousTxnId: string;
  readonly previousTxnLedgerIndex: number;
  readonly observedAt: string;
  readonly verifiedAt: string;
  readonly maxAgeSeconds: number;
}

export type TradeDelegationVerification =
  | { readonly verified: true; readonly evidence: TradeDelegationEvidence }
  | { readonly verified: false; readonly code: TradeDelegationRefusalCode };

function refused(code: TradeDelegationRefusalCode): TradeDelegationVerification {
  return Object.freeze({ verified: false as const, code });
}

function isValidRequirement(requirement: TradeDelegationRequirement): boolean {
  const record = requirement as unknown;
  if (typeof record !== 'object' || record === null) return false;
  if (!isTradeNetwork(requirement.network) || checkTradeAccountAddress(requirement.owner) !== 'valid' || checkTradeAccountAddress(requirement.delegate) !== 'valid') return false;
  if (requirement.owner === requirement.delegate || !isTradeInstant(requirement.at)) return false;
  const age = requirement.maxAgeSeconds;
  if (typeof age !== 'number' || !Number.isSafeInteger(age) || age < 1 || age > TRADE_DELEGATION_MAXIMUM_AGE_SECONDS) return false;
  if (requirement.minimumValidatedLedgerIndex !== undefined && !isLedgerIndex(requirement.minimumValidatedLedgerIndex)) return false;
  if (requirement.expectedPreviousTxnId !== undefined && (typeof requirement.expectedPreviousTxnId !== 'string' || !LEDGER_HASH.test(requirement.expectedPreviousTxnId))) return false;
  return true;
}

/**
 * Whether `observation` proves that `requirement.delegate` may submit
 * OfferCreate for `requirement.owner` on `requirement.network` at
 * `requirement.at`. Checks, in order: the observation's own integrity; the
 * requirement's; the binding (network, owner, delegate); the ledger floor;
 * the time (not from the future, not older than `maxAgeSeconds`); and the
 * entry itself (present, unchanged if pinned, `OfferCreate` granted, nothing
 * beyond the trading permissions). The first failure is the answer.
 */
export function verifyTradeDelegation(observation: unknown, requirement: TradeDelegationRequirement): TradeDelegationVerification {
  const parsed = parseTradeDelegationObservation(observation);
  if (parsed === undefined) return refused(TRADE_DELEGATION_REFUSAL_CODES.OBSERVATION_MALFORMED);
  if (!isValidRequirement(requirement)) return refused(TRADE_DELEGATION_REFUSAL_CODES.REQUIREMENT_INVALID);
  if (parsed.network !== requirement.network) return refused(TRADE_DELEGATION_REFUSAL_CODES.NETWORK_MISMATCH);
  if (parsed.owner !== requirement.owner) return refused(TRADE_DELEGATION_REFUSAL_CODES.OWNER_MISMATCH);
  if (parsed.delegate !== requirement.delegate) return refused(TRADE_DELEGATION_REFUSAL_CODES.DELEGATE_MISMATCH);
  if (requirement.minimumValidatedLedgerIndex !== undefined && parsed.validatedLedgerIndex < requirement.minimumValidatedLedgerIndex) return refused(TRADE_DELEGATION_REFUSAL_CODES.LEDGER_BELOW_MINIMUM);
  const ageMs = Date.parse(requirement.at) - Date.parse(parsed.observedAt);
  if (ageMs < 0) return refused(TRADE_DELEGATION_REFUSAL_CODES.OBSERVATION_FROM_FUTURE);
  if (ageMs > requirement.maxAgeSeconds * 1000) return refused(TRADE_DELEGATION_REFUSAL_CODES.OBSERVATION_STALE);
  if (parsed.state === 'absent') return refused(TRADE_DELEGATION_REFUSAL_CODES.ABSENT);
  if (requirement.expectedPreviousTxnId !== undefined && parsed.previousTxnId !== requirement.expectedPreviousTxnId) return refused(TRADE_DELEGATION_REFUSAL_CODES.CHANGED);
  if (!parsed.permissions.includes(TRADE_DELEGATION_REQUIRED_PERMISSION)) return refused(TRADE_DELEGATION_REFUSAL_CODES.PERMISSION_MISSING);
  if (parsed.permissions.some((permission) => !TRADE_DELEGATION_TOLERATED_PERMISSIONS.includes(permission))) return refused(TRADE_DELEGATION_REFUSAL_CODES.PERMISSION_EXCESS);
  return Object.freeze({
    verified: true as const,
    evidence: Object.freeze({
      schema: TRADE_DELEGATION_EVIDENCE_SCHEMA,
      network: parsed.network,
      networkId: parsed.networkId,
      owner: parsed.owner,
      delegate: parsed.delegate,
      permission: TRADE_DELEGATION_REQUIRED_PERMISSION,
      permissions: parsed.permissions,
      entryIndex: parsed.entryIndex,
      validatedLedgerIndex: parsed.validatedLedgerIndex,
      validatedLedgerHash: parsed.validatedLedgerHash,
      previousTxnId: parsed.previousTxnId,
      previousTxnLedgerIndex: parsed.previousTxnLedgerIndex,
      observedAt: parsed.observedAt,
      verifiedAt: requirement.at,
      maxAgeSeconds: requirement.maxAgeSeconds,
    }),
  });
}
