/**
 * TRADE-04D D-1 qualification fixture — the TRADE-04C trade interlock **exactly
 * as shipped before D-1** (schema v1, commit 5d57d90), kept verbatim apart
 * from this header, its export names and its relative import paths, so the
 * migration suite can write genuine v1 files (anchored at a real CORE-07
 * witness) and hand them to the v2 runtime. Test-only: never imported by
 * production code.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import type { XrplReservedSubmissionAuthority, XrplSubmissionClaim } from '../../features/payment-runtime/rails/xrpl/index.js';
import { xrplSequenceWindowBlocks } from '../../features/xrpl-transport/index.js';
import type { AuthorityStateCheckpoint } from '../authority-state-freshness/checkpoint.js';
import { AuthorityStateFreshnessError } from '../authority-state-freshness/errors.js';
import {
  isAuthorityStateFreshnessBoundary,
  isFailedAuthorityStateFreshnessStatus,
  markComposedUnderFreshness,
  type AuthorityStateFreshnessBoundary,
  type AuthorityStateFreshnessSession,
  type AuthorityStateFreshnessStatusValue,
} from '../authority-state-freshness/session.js';
import { computeDigest } from '../governance-store/digest.js';

/**
 * TRADE-04C (gate G4) — the durable **trade** owner-account `Sequence`
 * interlock: the governed trade executor's own submission domain, on owner
 * accounts disjoint from every Payment source account (the Host refuses an
 * overlap with `assertXrplSequenceOwnership` before either store is opened;
 * a shared, account-scoped authority is gate G1 and is not implemented).
 *
 * Its own SQLite file, built on PAY-03's proven patterns — immutable identity
 * rows, forward-only lifecycle triggers, an append-only transition log, every
 * read fully re-verified and refused (never repaired) on any mismatch — with
 * two strengthenings:
 *
 * 1. **A reservation is not yet a submission.** A row is written in state
 *    `reserved` strictly after the delegated signature was verified and
 *    strictly before anything is sent. Only the one submit site can move it to
 *    `submitting`, through `claimSubmission`, and only for exactly the blob the
 *    row names (hash, owner, `Sequence`, `LastLedgerSequence`, network, type),
 *    once, ever. So no signed blob reaches the network without a matching,
 *    durable reservation, and no reservation reaches it twice.
 * 2. **Claims are anchored too.** The CORE-07 history in slot
 *    `trade-sequence-reservations` is a hash chain over every reservation
 *    **and** every claim, in commit order: a stale restore or rollback that
 *    lost a submission attempt is `ROLLBACK_DETECTED` at the next open.
 *
 * ```
 * reserved ──claim──▶ submitting ──▶ unconfirmed ──▶ settled
 *    │                    └──────────────────────────▶ settled
 *    └──(ledger fact only: expired / validated)───────▶ settled
 * ```
 *
 * Every state but `settled` is **open** and blocks a competing `Sequence` on
 * the same owner under the shared blocking rule (`xrplSequenceWindowBlocks`)
 * until a ledger fact closes it or the validated ledger reaches its
 * `LastLedgerSequence`. There is no `not-submitted` release: a signed blob
 * exists outside this process (the signer holds it), so "Frontera did not
 * send it" never proves it cannot be included. Nothing is ever deleted.
 *
 * The digests are unkeyed: integrity, not authenticity (as PAY-03).
 */
export const V1_FIXTURE_SCHEMA_VERSION = 'aoc.trade-sequence-interlock.schema.v1';
/** The CORE-07 slot of the reservation-and-claim history. */
export const TRADE_RESERVATIONS_STATE_KIND = 'trade-sequence-reservations';
/** The one transaction type this store reserves. */
export const TRADE_INTERLOCK_TRANSACTION_TYPE = 'OfferCreate';

const IDENTITY_DIGEST_DOMAIN = 'aoc.trade-sequence-interlock.identity.v1';
const STATE_DIGEST_DOMAIN = 'aoc.trade-sequence-interlock.state.v1';
const SCOPE_DIGEST_DOMAIN = 'aoc.trade-sequence-interlock.scope.v1';
const HISTORY_DIGEST_DOMAIN = 'aoc.trade-sequence-interlock.history.v1';
const DEFAULT_BUSY_TIMEOUT_MS = 5_000;
const MAX_BUSY_TIMEOUT_MS = 60_000;

export type TradeInterlockStoreErrorCode = 'TRADE_INTERLOCK_UNAVAILABLE' | 'TRADE_INTERLOCK_CORRUPT' | 'TRADE_INTERLOCK_INVALID' | 'TRADE_INTERLOCK_CLAIM_REFUSED';

/** Messages name the check that failed, never a value. */
export class TradeInterlockStoreError extends Error {
  readonly code: TradeInterlockStoreErrorCode;
  readonly check?: string;

  constructor(code: TradeInterlockStoreErrorCode, message: string, check?: string) {
    super(message);
    this.name = 'TradeInterlockStoreError';
    this.code = code;
    if (check !== undefined) this.check = check;
  }
}

export const TRADE_SUBMISSION_STATES = ['reserved', 'submitting', 'unconfirmed', 'settled'] as const;
export type TradeSubmissionState = (typeof TRADE_SUBMISSION_STATES)[number];

/** Why a record was closed. Every value is a ledger fact. */
export const TRADE_INTERLOCK_SETTLEMENTS = ['validated-success', 'validated-failure', 'malformed', 'expired'] as const;
export type TradeInterlockSettlement = (typeof TRADE_INTERLOCK_SETTLEMENTS)[number];

/**
 * The evidence recorded with a reservation: public identifiers, digests and
 * ledger references only — never a key, a credential, a blob or a strategy.
 * Closed: exactly these keys.
 */
export interface TradeReservationEvidence {
  readonly organizationId: string;
  readonly subject: string;
  readonly requestId: string;
  readonly decisionId: string;
  readonly boundedGrantId: string;
  readonly proposalDigest: string;
  readonly delegateAccount: string;
  readonly signerId: string;
  readonly signerRequestId: string;
  readonly signingPublicKey: string;
  readonly keyAuthority: 'master-key' | 'regular-key';
  readonly preparedDigest: string;
  readonly delegationAssessmentDigest: string;
  readonly delegationFactsDigest: string;
  readonly referenceLedgerIndex: number;
  readonly referenceLedgerHash: string;
  readonly delegationLedgerIndex: number;
  readonly delegateRootLedgerIndex: number;
  readonly ownerRootLedgerIndex: number;
  readonly fee: string;
  /** Where the ledger facts came from: the configured XRPL network through the SDK client, or a client injected by trusted in-process composition (qualification doubles). */
  readonly ledgerProvenance: 'xrpl-network' | 'injected-ledger-client';
}

const EVIDENCE_TEXT_KEYS = [
  'organizationId',
  'subject',
  'requestId',
  'decisionId',
  'boundedGrantId',
  'proposalDigest',
  'delegateAccount',
  'signerId',
  'signerRequestId',
  'signingPublicKey',
  'keyAuthority',
  'preparedDigest',
  'delegationAssessmentDigest',
  'delegationFactsDigest',
  'referenceLedgerHash',
  'fee',
  'ledgerProvenance',
] as const;
const EVIDENCE_NUMBER_KEYS = ['referenceLedgerIndex', 'delegationLedgerIndex', 'delegateRootLedgerIndex', 'ownerRootLedgerIndex'] as const;

/** Everything recorded before the one submission. */
export interface TradeReservationInput {
  readonly executionId: string;
  /** The owner: the account whose `Sequence` the transaction consumes. */
  readonly account: string;
  readonly sequence: number;
  readonly lastLedgerSequence: number;
  /** The first ledger the transaction could appear in: the reference validated index + 1. */
  readonly minLedger: number;
  readonly transactionHash: string;
  readonly evidence: TradeReservationEvidence;
}

export interface TradeSubmissionTransition {
  readonly from: TradeSubmissionState | null;
  readonly to: TradeSubmissionState;
  readonly settlement?: TradeInterlockSettlement;
  readonly detail?: string;
  readonly at: string;
}

export interface TradeSubmissionRecord extends TradeReservationInput {
  readonly transactionType: typeof TRADE_INTERLOCK_TRANSACTION_TYPE;
  readonly state: TradeSubmissionState;
  readonly settlement?: TradeInterlockSettlement;
  /** 0 or 1: how many times the submit site claimed this reservation (never more). */
  readonly submissionAttempts: number;
  readonly transitions: readonly TradeSubmissionTransition[];
  readonly reservedAt: string;
  readonly updatedAt: string;
}

export type TradeReservation = { readonly outcome: 'reserved' } | { readonly outcome: 'blocked' } | { readonly outcome: 'execution-recorded'; readonly transactionHash: string };

export interface TradeInterlockStoreHealth {
  readonly status: 'healthy' | 'unhealthy';
  readonly readable: boolean;
  readonly writable: boolean;
  readonly schemaVersion: string;
  readonly open?: number;
  readonly freshness?: AuthorityStateFreshnessStatusValue | 'not-anchored';
}

export interface DurableTradeSequenceInterlock extends XrplReservedSubmissionAuthority {
  readonly providerKind: 'sqlite';
  readonly anchored: boolean;
  /** The transaction hash already recorded for this execution, if any. Throws when the state cannot be read. */
  recorded(executionId: string): Promise<string | undefined>;
  /** Non-binding pre-signing check (the witness is probed first). Throws when the state cannot be read or proven fresh. */
  blocking(query: { readonly account: string; readonly sequence: number; readonly validatedLedgerIndex: number }): Promise<boolean>;
  /** One atomic, anchored check-and-record. Throws when it cannot: nothing is submitted. */
  reserve(record: TradeReservationInput, validatedLedgerIndex: number): Promise<TradeReservation>;
  markUnconfirmed(executionId: string, transactionHash: string, detail?: string): Promise<void>;
  /** A definitive ledger fact. Moves a record to `settled`; never reopens one. */
  settle(executionId: string, transactionHash: string, settlement: TradeInterlockSettlement, detail?: string): Promise<void>;
  read(executionId: string): Promise<TradeSubmissionRecord | undefined>;
  /** Owner accounts with a record still open. For operations and the Host's cross-domain check. */
  openAccounts(): Promise<readonly string[]>;
  verifyAll(): Promise<{ readonly records: number; readonly open: number }>;
  health(): Promise<TradeInterlockStoreHealth>;
  close(): Promise<void>;
}

export interface CreateSqliteTradeSequenceInterlockOptions {
  /** The domain id and XRPL network this file is bound to. Omitted only by verification tooling (restore), which never creates or writes. */
  readonly scope?: { readonly domainId: string; readonly networkId: number };
  /** The owner accounts this composition may reserve for (its configured sequence accounts). Reserving for any other is refused. */
  readonly sequenceAccounts?: readonly string[];
  readonly now: () => string;
  readonly busyTimeoutMs?: number;
  /** CORE-07: required by the Host. A store once anchored is never opened for the executor without it. */
  readonly freshness?: { readonly boundary: AuthorityStateFreshnessBoundary };
}

const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS trade_interlock_store_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  schema_version TEXT NOT NULL,
  migration_state TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS trade_interlock_scope (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  domain_id TEXT NOT NULL,
  network_id INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  scope_digest TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS trade_reservations (
  row_id INTEGER PRIMARY KEY AUTOINCREMENT,
  execution_id TEXT NOT NULL UNIQUE,
  transaction_type TEXT NOT NULL CHECK (transaction_type = 'OfferCreate'),
  account TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  last_ledger_sequence INTEGER NOT NULL,
  min_ledger INTEGER NOT NULL,
  transaction_hash TEXT NOT NULL,
  evidence TEXT NOT NULL,
  reserved_at TEXT NOT NULL,
  identity_digest TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('reserved', 'submitting', 'unconfirmed', 'settled')),
  settlement TEXT,
  updated_at TEXT NOT NULL,
  state_digest TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS trade_reservations_by_hash ON trade_reservations (transaction_hash);
CREATE INDEX IF NOT EXISTS trade_reservations_live_by_account ON trade_reservations (account, last_ledger_sequence);
CREATE TABLE IF NOT EXISTS trade_reservation_transitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  execution_id TEXT NOT NULL,
  from_state TEXT,
  to_state TEXT NOT NULL,
  settlement TEXT,
  detail TEXT,
  recorded_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS trade_reservation_transitions_by_execution ON trade_reservation_transitions (execution_id);
CREATE TABLE IF NOT EXISTS trade_anchored_events (
  row_id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('reserve', 'claim')),
  execution_id TEXT NOT NULL,
  event_digest TEXT NOT NULL,
  UNIQUE (kind, execution_id)
);
CREATE TABLE IF NOT EXISTS trade_interlock_anchor (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  store_id TEXT NOT NULL,
  anchored_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS trade_interlock_scope_immutable BEFORE UPDATE ON trade_interlock_scope
BEGIN SELECT RAISE(ABORT, 'trade interlock scope is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trade_interlock_scope_no_delete BEFORE DELETE ON trade_interlock_scope
BEGIN SELECT RAISE(ABORT, 'trade interlock scope is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trade_reservations_no_delete BEFORE DELETE ON trade_reservations
BEGIN SELECT RAISE(ABORT, 'trade reservations are never deleted'); END;
CREATE TRIGGER IF NOT EXISTS trade_reservations_identity_immutable BEFORE UPDATE OF execution_id, transaction_type, account, sequence, last_ledger_sequence, min_ledger, transaction_hash, evidence, reserved_at, identity_digest ON trade_reservations
BEGIN SELECT RAISE(ABORT, 'trade reservation identity is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trade_reservations_forward_only BEFORE UPDATE OF state ON trade_reservations
WHEN NOT ((OLD.state = 'reserved' AND NEW.state IN ('submitting', 'settled')) OR (OLD.state = 'submitting' AND NEW.state IN ('unconfirmed', 'settled')) OR (OLD.state = 'unconfirmed' AND NEW.state = 'settled'))
BEGIN SELECT RAISE(ABORT, 'trade reservation state moves forward only'); END;
CREATE TRIGGER IF NOT EXISTS trade_reservation_transitions_append_only_update BEFORE UPDATE ON trade_reservation_transitions
BEGIN SELECT RAISE(ABORT, 'trade reservation transitions are append-only'); END;
CREATE TRIGGER IF NOT EXISTS trade_reservation_transitions_append_only_delete BEFORE DELETE ON trade_reservation_transitions
BEGIN SELECT RAISE(ABORT, 'trade reservation transitions are append-only'); END;
CREATE TRIGGER IF NOT EXISTS trade_anchored_events_append_only_update BEFORE UPDATE ON trade_anchored_events
BEGIN SELECT RAISE(ABORT, 'trade anchored events are append-only'); END;
CREATE TRIGGER IF NOT EXISTS trade_anchored_events_append_only_delete BEFORE DELETE ON trade_anchored_events
BEGIN SELECT RAISE(ABORT, 'trade anchored events are append-only'); END;
CREATE TRIGGER IF NOT EXISTS trade_interlock_anchor_immutable BEFORE UPDATE ON trade_interlock_anchor
BEGIN SELECT RAISE(ABORT, 'trade interlock anchor is immutable'); END;
CREATE TRIGGER IF NOT EXISTS trade_interlock_anchor_no_delete BEFORE DELETE ON trade_interlock_anchor
BEGIN SELECT RAISE(ABORT, 'trade interlock anchor is immutable'); END;
`;

const COLUMNS = 'execution_id, transaction_type, account, sequence, last_ledger_sequence, min_ledger, transaction_hash, evidence, reserved_at, identity_digest, state, settlement, updated_at, state_digest';

interface Row {
  readonly execution_id: unknown;
  readonly transaction_type: unknown;
  readonly account: unknown;
  readonly sequence: unknown;
  readonly last_ledger_sequence: unknown;
  readonly min_ledger: unknown;
  readonly transaction_hash: unknown;
  readonly evidence: unknown;
  readonly reserved_at: unknown;
  readonly identity_digest: unknown;
  readonly state: unknown;
  readonly settlement: unknown;
  readonly updated_at: unknown;
  readonly state_digest: unknown;
}

const EXECUTION_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$/;
const CLASSIC_ADDRESS = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/;
const HASH = /^[0-9A-F]{64}$/;
const DOMAIN_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/;
/** Evidence text: recordable identifiers, digests and keys — never free text. */
const EVIDENCE_TEXT = /^[A-Za-z0-9][A-Za-z0-9:._@-]{0,255}$/;
const DETAIL = /^[A-Za-z][A-Za-z0-9_.-]{0,95}$/;

const unavailable = (message: string): TradeInterlockStoreError => new TradeInterlockStoreError('TRADE_INTERLOCK_UNAVAILABLE', message);
const corrupt = (check: string): TradeInterlockStoreError => new TradeInterlockStoreError('TRADE_INTERLOCK_CORRUPT', `The trade sequence interlock failed its integrity check '${check}'. It is refused, never repaired.`, check);
const invalid = (field: string): TradeInterlockStoreError => new TradeInterlockStoreError('TRADE_INTERLOCK_INVALID', `The trade sequence interlock refused a malformed '${field}'.`);
const claimRefused = (check: string): TradeInterlockStoreError => new TradeInterlockStoreError('TRADE_INTERLOCK_CLAIM_REFUSED', `The trade sequence interlock refused a submission claim ('${check}'); nothing may be sent.`, check);

const isPositiveInteger = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

function resolveOnDisk(path: string): string {
  const absolute = resolve(path);
  const parent = dirname(absolute);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
  return absolute;
}

function tableExists(db: { prepare(sql: string): { get(...args: unknown[]): unknown } }, name: string): boolean {
  return db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) !== undefined;
}

/** A closed, frozen copy of the evidence, or `undefined`. */
function evidenceOf(value: unknown): TradeReservationEvidence | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const keys = Object.keys(value);
  const expected = [...EVIDENCE_TEXT_KEYS, ...EVIDENCE_NUMBER_KEYS];
  if (keys.length !== expected.length || !expected.every((key) => Object.prototype.hasOwnProperty.call(value, key))) return undefined;
  const record = value as Readonly<Record<string, unknown>>;
  const out: Record<string, unknown> = {};
  for (const key of EVIDENCE_TEXT_KEYS) {
    const text = record[key];
    if (typeof text !== 'string' || !EVIDENCE_TEXT.test(text)) return undefined;
    out[key] = text;
  }
  for (const key of EVIDENCE_NUMBER_KEYS) {
    if (!isPositiveInteger(record[key])) return undefined;
    out[key] = record[key];
  }
  if (out['keyAuthority'] !== 'master-key' && out['keyAuthority'] !== 'regular-key') return undefined;
  if (out['ledgerProvenance'] !== 'xrpl-network' && out['ledgerProvenance'] !== 'injected-ledger-client') return undefined;
  return Object.freeze(out) as unknown as TradeReservationEvidence;
}

function identityDigest(record: TradeReservationInput, reservedAt: string): string {
  return computeDigest({
    domain: IDENTITY_DIGEST_DOMAIN,
    executionId: record.executionId,
    transactionType: TRADE_INTERLOCK_TRANSACTION_TYPE,
    account: record.account,
    sequence: record.sequence,
    lastLedgerSequence: record.lastLedgerSequence,
    minLedger: record.minLedger,
    transactionHash: record.transactionHash,
    evidence: record.evidence,
    reservedAt,
  });
}

function stateDigest(identity: string, state: TradeSubmissionState, settlement: TradeInterlockSettlement | null, updatedAt: string): string {
  return computeDigest({ domain: STATE_DIGEST_DOMAIN, identityDigest: identity, state, settlement, updatedAt });
}

function eventDigest(kind: 'reserve' | 'claim', identity: string): string {
  return computeDigest({ domain: HISTORY_DIGEST_DOMAIN, kind, identityDigest: identity });
}

function historyGenesisDigest(storeId: string, scope: { readonly domainId: string; readonly networkId: number }): string {
  return computeDigest({ domain: HISTORY_DIGEST_DOMAIN, storeId, domainId: scope.domainId, networkId: scope.networkId, sequence: 0 });
}

function nextHistoryDigest(previous: string, event: string): string {
  return computeDigest({ domain: HISTORY_DIGEST_DOMAIN, previous, eventDigest: event });
}

function validateInput(record: TradeReservationInput): TradeReservationEvidence {
  if (typeof record?.executionId !== 'string' || !EXECUTION_ID.test(record.executionId)) throw invalid('executionId');
  if (typeof record.account !== 'string' || !CLASSIC_ADDRESS.test(record.account)) throw invalid('account');
  if (!isPositiveInteger(record.sequence)) throw invalid('sequence');
  if (!isPositiveInteger(record.lastLedgerSequence)) throw invalid('lastLedgerSequence');
  if (!isPositiveInteger(record.minLedger) || record.minLedger > record.lastLedgerSequence) throw invalid('minLedger');
  if (typeof record.transactionHash !== 'string' || !HASH.test(record.transactionHash)) throw invalid('transactionHash');
  const evidence = evidenceOf(record.evidence);
  if (evidence === undefined) throw invalid('evidence');
  if (evidence.delegateAccount === record.account || !CLASSIC_ADDRESS.test(evidence.delegateAccount)) throw invalid('evidence.delegateAccount');
  return evidence;
}

interface HistoryHead {
  readonly lastRowId: number;
  readonly lastEvent: string | null;
  readonly sequence: number;
  readonly digest: string;
}

/** Opens (or creates) the interlock file, verifying it completely before returning. */
export async function createV1TradeSequenceInterlockForMigrationTests(dbPath: string, options: CreateSqliteTradeSequenceInterlockOptions): Promise<DurableTradeSequenceInterlock> {
  if (typeof dbPath !== 'string' || dbPath.trim().length === 0) throw unavailable('The trade sequence interlock path must be a non-empty string.');
  if (typeof options?.now !== 'function') throw unavailable('The trade sequence interlock requires an injected clock.');
  const scope = options.scope;
  if (scope !== undefined && (typeof scope?.domainId !== 'string' || !DOMAIN_ID.test(scope.domainId) || !Number.isSafeInteger(scope.networkId) || scope.networkId < 1)) throw unavailable('The trade sequence interlock requires its domain id and a non-mainnet network id scope.');
  if (scope === undefined && dbPath === ':memory:') throw unavailable('The trade sequence interlock requires its scope.');
  let sequenceAccounts: ReadonlySet<string> | undefined;
  if (options.sequenceAccounts !== undefined) {
    if (!Array.isArray(options.sequenceAccounts) || options.sequenceAccounts.length === 0 || !options.sequenceAccounts.every((account) => typeof account === 'string' && CLASSIC_ADDRESS.test(account))) throw unavailable('The trade sequence interlock sequence accounts must be a non-empty list of classic addresses.');
    sequenceAccounts = new Set(options.sequenceAccounts);
  }
  if (scope !== undefined && sequenceAccounts === undefined) throw unavailable('The trade sequence interlock needs the sequence accounts it may reserve for.');
  const busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
  if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 0 || busyTimeoutMs > MAX_BUSY_TIMEOUT_MS) throw unavailable(`The trade sequence interlock busy timeout must be an integer from 0 to ${MAX_BUSY_TIMEOUT_MS}.`);
  const now = options.now;
  const freshness = options.freshness;
  if (freshness !== undefined && (!isAuthorityStateFreshnessBoundary(freshness.boundary) || scope === undefined)) {
    throw unavailable('The trade sequence interlock freshness option needs a boundary built by createAuthorityStateFreshnessBoundary, and the store scope.');
  }
  const { default: Database } = await import('better-sqlite3');

  const db = new Database(dbPath === ':memory:' ? ':memory:' : resolveOnDisk(dbPath));
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = FULL');
    db.pragma(`busy_timeout = ${busyTimeoutMs}`);
    // The version guard runs before `CREATE TABLE IF NOT EXISTS`: a file under another schema is refused unmutated.
    if (tableExists(db, 'trade_interlock_store_versions')) {
      const existing = db.prepare('SELECT schema_version FROM trade_interlock_store_versions ORDER BY id DESC LIMIT 1').get() as { schema_version: unknown } | undefined;
      if (existing !== undefined && existing.schema_version !== V1_FIXTURE_SCHEMA_VERSION) {
        throw unavailable(`The trade sequence interlock is recorded under a schema version this runtime does not implement (expected '${V1_FIXTURE_SCHEMA_VERSION}'). Refusing to open it.`);
      }
      if (existing === undefined && tableExists(db, 'trade_reservations')) throw unavailable('The trade sequence interlock holds tables but an empty schema version record. Refusing to open it.');
    } else if (tableExists(db, 'trade_reservations') || tableExists(db, 'trade_interlock_scope')) {
      throw unavailable('The trade sequence interlock holds tables but no schema version record. Refusing to open it.');
    } else if (scope === undefined) {
      throw unavailable('The trade sequence interlock does not exist; verification never creates one.');
    }
    db.exec(SCHEMA_V1);
    db.transaction(() => {
      if (db.prepare('SELECT 1 FROM trade_interlock_store_versions LIMIT 1').get() === undefined) {
        db.prepare(`INSERT INTO trade_interlock_store_versions (schema_version, migration_state, recorded_at) VALUES (?, 'current', ?)`).run(V1_FIXTURE_SCHEMA_VERSION, now());
      }
      const bound = db.prepare('SELECT domain_id, network_id, created_at, scope_digest FROM trade_interlock_scope WHERE id = 1').get() as { domain_id: unknown; network_id: unknown; created_at: unknown; scope_digest: unknown } | undefined;
      if (bound === undefined) {
        if (db.prepare('SELECT 1 FROM trade_reservations LIMIT 1').get() !== undefined) throw corrupt('scope-missing');
        if (scope === undefined) throw unavailable('The trade sequence interlock is not bound to a scope; verification never binds one.');
        const createdAt = now();
        db.prepare('INSERT INTO trade_interlock_scope (id, domain_id, network_id, created_at, scope_digest) VALUES (1, ?, ?, ?, ?)').run(
          scope.domainId,
          scope.networkId,
          createdAt,
          computeDigest({ domain: SCOPE_DIGEST_DOMAIN, domainId: scope.domainId, networkId: scope.networkId, createdAt }),
        );
        return;
      }
      if (typeof bound.created_at !== 'string' || bound.scope_digest !== computeDigest({ domain: SCOPE_DIGEST_DOMAIN, domainId: bound.domain_id, networkId: bound.network_id, createdAt: bound.created_at })) throw corrupt('scope-digest');
      if (scope !== undefined && (bound.domain_id !== scope.domainId || bound.network_id !== scope.networkId)) throw unavailable('The trade sequence interlock is bound to another domain or XRPL network than the one configured. Refusing to open it.');
    }).immediate();
  } catch (error) {
    db.close();
    throw error instanceof TradeInterlockStoreError ? error : unavailable('The trade sequence interlock could not be opened.');
  }

  const boundScope = db.prepare('SELECT domain_id, network_id FROM trade_interlock_scope WHERE id = 1').get() as { domain_id: string; network_id: number };
  const selectByExecution = db.prepare(`SELECT ${COLUMNS} FROM trade_reservations WHERE execution_id = ?`);
  // Every record of the account whose window the ledger has not yet closed — in ANY state: a row forged to look settled is verified, never trusted unread.
  const selectLiveByAccount = db.prepare(`SELECT ${COLUMNS} FROM trade_reservations WHERE account = ? AND last_ledger_sequence > ?`);
  const selectOpen = db.prepare(`SELECT ${COLUMNS} FROM trade_reservations WHERE state != 'settled'`);
  const selectAll = db.prepare(`SELECT ${COLUMNS} FROM trade_reservations ORDER BY row_id ASC`);
  const selectTransitions = db.prepare('SELECT from_state, to_state, settlement, detail, recorded_at FROM trade_reservation_transitions WHERE execution_id = ? ORDER BY id ASC');
  const countRows = db.prepare('SELECT COUNT(*) AS n FROM trade_reservations');
  const countLoggedExecutions = db.prepare('SELECT COUNT(DISTINCT execution_id) AS n FROM trade_reservation_transitions');
  const countEvents = db.prepare('SELECT COUNT(*) AS n FROM trade_anchored_events');
  const selectEvent = db.prepare('SELECT event_digest FROM trade_anchored_events WHERE kind = ? AND execution_id = ?');
  const insertRow = db.prepare(
    `INSERT INTO trade_reservations (${COLUMNS}) VALUES (@executionId, 'OfferCreate', @account, @sequence, @lastLedgerSequence, @minLedger, @transactionHash, @evidence, @reservedAt, @identityDigest, 'reserved', NULL, @reservedAt, @stateDigest)`,
  );
  const insertEvent = db.prepare('INSERT INTO trade_anchored_events (kind, execution_id, event_digest) VALUES (?, ?, ?)');
  const selectEventsAfter = db.prepare('SELECT row_id, event_digest FROM trade_anchored_events WHERE row_id > ? ORDER BY row_id ASC');
  const selectEventAt = db.prepare('SELECT event_digest FROM trade_anchored_events WHERE row_id = ?');
  const selectAnchor = db.prepare('SELECT store_id FROM trade_interlock_anchor WHERE id = 1');
  const updateState = db.prepare('UPDATE trade_reservations SET state = @state, settlement = @settlement, updated_at = @updatedAt, state_digest = @stateDigest WHERE execution_id = @executionId');
  const insertTransition = db.prepare('INSERT INTO trade_reservation_transitions (execution_id, from_state, to_state, settlement, detail, recorded_at) VALUES (?, ?, ?, ?, ?, ?)');

  let closed = false;
  const assertOpen = (): void => {
    if (closed) throw unavailable('The trade sequence interlock has been closed.');
  };

  let storeId: string | undefined;
  let session: AuthorityStateFreshnessSession | undefined;
  let headCache: HistoryHead | undefined;
  const historyScope = { domainId: boundScope.domain_id, networkId: boundScope.network_id };

  function headFrom(base: HistoryHead): HistoryHead {
    let { lastRowId, lastEvent, sequence, digest } = base;
    if (lastRowId > 0 && (selectEventAt.get(lastRowId) as { event_digest: unknown } | undefined)?.event_digest !== lastEvent) throw corrupt('history-head');
    for (const row of selectEventsAfter.all(lastRowId) as { row_id: number; event_digest: unknown }[]) {
      if (typeof row.event_digest !== 'string') throw corrupt('history-head');
      digest = nextHistoryDigest(digest, row.event_digest);
      sequence += 1;
      lastRowId = row.row_id;
      lastEvent = row.event_digest;
    }
    if (sequence !== (countEvents.get() as { n: number }).n) throw corrupt('history-head');
    return { lastRowId, lastEvent, sequence, digest };
  }

  function currentHead(): HistoryHead {
    if (storeId === undefined) throw unavailable('The trade sequence interlock is not anchored.');
    headCache = headFrom(headCache ?? { lastRowId: 0, lastEvent: null, sequence: 0, digest: historyGenesisDigest(storeId, historyScope) });
    return headCache;
  }

  function checkpointOf(head: HistoryHead): AuthorityStateCheckpoint {
    return { stateKind: TRADE_RESERVATIONS_STATE_KIND, organizationId: freshness!.boundary.organizationId, storeId: storeId!, sequence: head.sequence, stateDigest: head.digest };
  }

  function observeFresh(): void {
    if (session !== undefined) session.observe(checkpointOf(currentHead()));
  }

  /** One anchored write at a time in this process; across processes the witness's compare-and-advance decides. */
  let anchoring: Promise<unknown> = Promise.resolve();
  function serializedAnchoring<T>(work: () => Promise<T>): Promise<T> {
    const result = anchoring.then(work);
    anchoring = result.catch(() => undefined);
    return result;
  }

  function decode(row: Row): TradeSubmissionRecord {
    const executionId = row.execution_id;
    if (typeof executionId !== 'string' || !EXECUTION_ID.test(executionId)) throw corrupt('execution-id');
    if (row.transaction_type !== TRADE_INTERLOCK_TRANSACTION_TYPE) throw corrupt('transaction-type');
    const state = row.state;
    if (!TRADE_SUBMISSION_STATES.includes(state as TradeSubmissionState)) throw corrupt('state');
    const settlement = row.settlement;
    if (settlement !== null && !TRADE_INTERLOCK_SETTLEMENTS.includes(settlement as TradeInterlockSettlement)) throw corrupt('settlement');
    if ((state === 'settled') !== (settlement !== null)) throw corrupt('settlement-state');
    if (typeof row.reserved_at !== 'string' || typeof row.updated_at !== 'string' || typeof row.evidence !== 'string') throw corrupt('row-fields');
    let evidenceValue: unknown;
    try {
      evidenceValue = JSON.parse(row.evidence);
    } catch {
      throw corrupt('evidence');
    }
    const input: TradeReservationInput = {
      executionId,
      account: row.account as string,
      sequence: row.sequence as number,
      lastLedgerSequence: row.last_ledger_sequence as number,
      minLedger: row.min_ledger as number,
      transactionHash: row.transaction_hash as string,
      evidence: evidenceValue as TradeReservationEvidence,
    };
    let evidence: TradeReservationEvidence;
    try {
      evidence = validateInput(input);
    } catch {
      throw corrupt('row-fields');
    }
    const identity = identityDigest({ ...input, evidence }, row.reserved_at);
    if (row.identity_digest !== identity) throw corrupt('identity-digest');
    if (row.state_digest !== stateDigest(identity, state as TradeSubmissionState, settlement as TradeInterlockSettlement | null, row.updated_at)) throw corrupt('state-digest');
    const transitions = (selectTransitions.all(executionId) as { from_state: unknown; to_state: unknown; settlement: unknown; detail: unknown; recorded_at: unknown }[]).map((transition) => transition);
    if (transitions.length === 0 || transitions[0]!.from_state !== null || transitions[0]!.to_state !== 'reserved') throw corrupt('transition-log');
    for (const [index, transition] of transitions.entries()) {
      if (index > 0 && transition.from_state !== transitions[index - 1]!.to_state) throw corrupt('transition-log');
      if (!TRADE_SUBMISSION_STATES.includes(transition.to_state as TradeSubmissionState) || typeof transition.recorded_at !== 'string') throw corrupt('transition-log');
      if (transition.detail !== null && (typeof transition.detail !== 'string' || !DETAIL.test(transition.detail))) throw corrupt('transition-log');
    }
    const last = transitions[transitions.length - 1]!;
    if (last.to_state !== state || (last.settlement ?? null) !== settlement) throw corrupt('transition-log');
    // The anchored history must hold exactly this row's reservation, and a claim exactly when the log shows one.
    if ((selectEvent.get('reserve', executionId) as { event_digest: unknown } | undefined)?.event_digest !== eventDigest('reserve', identity)) throw corrupt('anchored-reservation');
    const claimed = transitions.some((transition) => transition.to_state === 'submitting');
    const claimEvent = selectEvent.get('claim', executionId) as { event_digest: unknown } | undefined;
    if (claimed !== (claimEvent !== undefined) || (claimEvent !== undefined && claimEvent.event_digest !== eventDigest('claim', identity))) throw corrupt('anchored-claim');
    return Object.freeze({
      ...input,
      evidence,
      transactionType: TRADE_INTERLOCK_TRANSACTION_TYPE,
      state: state as TradeSubmissionState,
      ...(settlement !== null ? { settlement: settlement as TradeInterlockSettlement } : {}),
      submissionAttempts: claimed ? 1 : 0,
      transitions: Object.freeze(
        transitions.map((transition) =>
          Object.freeze({
            from: transition.from_state as TradeSubmissionState | null,
            to: transition.to_state as TradeSubmissionState,
            ...(transition.settlement !== null ? { settlement: transition.settlement as TradeInterlockSettlement } : {}),
            ...(transition.detail !== null ? { detail: transition.detail as string } : {}),
            at: transition.recorded_at as string,
          }),
        ),
      ),
      reservedAt: row.reserved_at,
      updatedAt: row.updated_at,
    });
  }

  function verifyCompleteness(): void {
    const rows = (countRows.get() as { n: number }).n;
    if (rows !== (countLoggedExecutions.get() as { n: number }).n) throw corrupt('record-missing');
  }

  function openBlocking(account: string, sequence: number, validatedLedgerIndex: number): boolean {
    verifyCompleteness();
    const live = (selectLiveByAccount.all(account, validatedLedgerIndex) as Row[]).map(decode);
    return live.some((record) => xrplSequenceWindowBlocks({ sequence: record.sequence, lastLedgerSequence: record.lastLedgerSequence, open: record.state !== 'settled' }, sequence, validatedLedgerIndex));
  }

  function guarded<T>(work: () => T): T {
    try {
      return work();
    } catch (error) {
      if (error instanceof TradeInterlockStoreError) throw error;
      throw unavailable('The trade sequence interlock could not complete the operation.');
    }
  }

  function transition(executionId: string, transactionHash: string, to: TradeSubmissionState, settlement: TradeInterlockSettlement | null, detail: string | null): void {
    db.transaction(() => {
      observeFresh();
      const row = selectByExecution.get(executionId) as Row | undefined;
      if (row === undefined) throw unavailable('The trade sequence interlock holds no record for this execution.');
      const record = decode(row);
      if (record.transactionHash !== transactionHash) throw corrupt('transaction-hash');
      // Forward only, and idempotent. `unconfirmed` is reachable only from `submitting` (a claimed record).
      if (record.state === 'settled' || record.state === to) return;
      if (to === 'unconfirmed' && record.state !== 'submitting') return;
      const updatedAt = now();
      const identity = identityDigest(record, record.reservedAt);
      updateState.run({ executionId, state: to, settlement, updatedAt, stateDigest: stateDigest(identity, to, settlement, updatedAt) });
      insertTransition.run(executionId, record.state, to, settlement, detail, updatedAt);
    }).immediate();
  }

  async function anchoredWrite(prepare: () => { readonly event: string; readonly head: HistoryHead } | { readonly done: unknown }, commit: (head: HistoryHead) => void): Promise<unknown> {
    assertOpen();
    if (session === undefined) throw unavailable('The trade sequence interlock is not anchored.');
    const decided = guarded(() => db.transaction(prepare)());
    if ('done' in decided) return decided.done;
    const expected = checkpointOf(decided.head);
    const proposed: AuthorityStateCheckpoint = { ...expected, sequence: expected.sequence + 1, stateDigest: nextHistoryDigest(expected.stateDigest, decided.event) };
    await session.transition(expected, proposed, () => ({
      value: undefined,
      state: guarded(() =>
        db
          .transaction(() => {
            const before = currentHead();
            if (before.sequence !== decided.head.sequence || before.digest !== decided.head.digest) throw corrupt('history-head');
            commit(before);
            return checkpointOf(headFrom(before));
          })
          .immediate(),
      ),
    }));
    return undefined;
  }

  const sequenceAccountsOrRefuse = (account: string): void => {
    if (sequenceAccounts === undefined || !sequenceAccounts.has(account)) throw invalid('account');
  };

  const store: DurableTradeSequenceInterlock = {
    providerKind: 'sqlite',
    get anchored() {
      return session !== undefined;
    },
    async recorded(executionId) {
      assertOpen();
      if (typeof executionId !== 'string' || !EXECUTION_ID.test(executionId)) throw invalid('executionId');
      return guarded(() =>
        db.transaction(() => {
          observeFresh();
          verifyCompleteness();
          const row = selectByExecution.get(executionId) as Row | undefined;
          return row === undefined ? undefined : decode(row).transactionHash;
        })(),
      );
    },
    async blocking(query) {
      assertOpen();
      if (typeof query?.account !== 'string' || !CLASSIC_ADDRESS.test(query.account) || !isPositiveInteger(query.sequence) || !isPositiveInteger(query.validatedLedgerIndex)) throw invalid('query');
      if (session === undefined) throw unavailable('The trade sequence interlock is not anchored.');
      const freshnessNow = await session.probe();
      if (freshnessNow.status !== 'ready') throw new AuthorityStateFreshnessError(freshnessNow.reason ?? 'AUTHORITY_FRESHNESS_UNAVAILABLE', `The trade reservation history's freshness is '${freshnessNow.status}': nothing is signed.`);
      return guarded(() =>
        db.transaction(() => {
          observeFresh();
          return openBlocking(query.account, query.sequence, query.validatedLedgerIndex);
        })(),
      );
    },
    async reserve(record, validatedLedgerIndex): Promise<TradeReservation> {
      assertOpen();
      const evidence = validateInput(record);
      sequenceAccountsOrRefuse(record.account);
      if (!isPositiveInteger(validatedLedgerIndex) || record.minLedger !== validatedLedgerIndex + 1) throw invalid('validatedLedgerIndex');
      const input: TradeReservationInput = { ...record, evidence };
      return serializedAnchoring(async () => {
        const reservedAt = now();
        const identity = identityDigest(input, reservedAt);
        const answer = await anchoredWrite(
          () => {
            observeFresh();
            const existing = selectByExecution.get(input.executionId) as Row | undefined;
            if (existing !== undefined) return { done: { outcome: 'execution-recorded', transactionHash: decode(existing).transactionHash } satisfies TradeReservation };
            if (openBlocking(input.account, input.sequence, validatedLedgerIndex)) return { done: { outcome: 'blocked' } satisfies TradeReservation };
            return { event: eventDigest('reserve', identity), head: currentHead() };
          },
          () => {
            insertRow.run({
              executionId: input.executionId,
              account: input.account,
              sequence: input.sequence,
              lastLedgerSequence: input.lastLedgerSequence,
              minLedger: input.minLedger,
              transactionHash: input.transactionHash,
              evidence: JSON.stringify(input.evidence),
              reservedAt,
              identityDigest: identity,
              stateDigest: stateDigest(identity, 'reserved', null, reservedAt),
            });
            insertTransition.run(input.executionId, null, 'reserved', null, null, reservedAt);
            insertEvent.run('reserve', input.executionId, eventDigest('reserve', identity));
          },
        );
        return (answer as TradeReservation | undefined) ?? { outcome: 'reserved' };
      });
    },
    async claimSubmission(claim: XrplSubmissionClaim): Promise<void> {
      assertOpen();
      if (typeof claim?.executionId !== 'string' || !EXECUTION_ID.test(claim.executionId)) throw claimRefused('execution-id');
      await serializedAnchoring(async () => {
        await anchoredWrite(
          () => {
            observeFresh();
            const row = selectByExecution.get(claim.executionId) as Row | undefined;
            if (row === undefined) throw claimRefused('no-reservation');
            const record = decode(row);
            if (record.state !== 'reserved') throw claimRefused('already-claimed');
            if (claim.networkId !== boundScope.network_id) throw claimRefused('network');
            if (claim.transactionType !== TRADE_INTERLOCK_TRANSACTION_TYPE) throw claimRefused('transaction-type');
            if (claim.transactionHash !== record.transactionHash) throw claimRefused('transaction-hash');
            if (claim.account !== record.account) throw claimRefused('account');
            if (claim.sequence !== record.sequence) throw claimRefused('sequence');
            if (claim.lastLedgerSequence !== record.lastLedgerSequence) throw claimRefused('last-ledger-sequence');
            return { event: eventDigest('claim', identityDigest(record, record.reservedAt)), head: currentHead() };
          },
          () => {
            const record = decode(selectByExecution.get(claim.executionId) as Row);
            if (record.state !== 'reserved') throw claimRefused('already-claimed');
            const updatedAt = now();
            const identity = identityDigest(record, record.reservedAt);
            updateState.run({ executionId: claim.executionId, state: 'submitting', settlement: null, updatedAt, stateDigest: stateDigest(identity, 'submitting', null, updatedAt) });
            insertTransition.run(claim.executionId, 'reserved', 'submitting', null, null, updatedAt);
            insertEvent.run('claim', claim.executionId, eventDigest('claim', identity));
          },
        );
      });
    },
    async markUnconfirmed(executionId, transactionHash, detail) {
      assertOpen();
      if (detail !== undefined && !DETAIL.test(detail)) throw invalid('detail');
      guarded(() => transition(executionId, transactionHash, 'unconfirmed', null, detail ?? null));
    },
    async settle(executionId, transactionHash, settlement, detail) {
      assertOpen();
      if (!TRADE_INTERLOCK_SETTLEMENTS.includes(settlement)) throw invalid('settlement');
      if (detail !== undefined && !DETAIL.test(detail)) throw invalid('detail');
      guarded(() => transition(executionId, transactionHash, 'settled', settlement, detail ?? null));
    },
    async read(executionId) {
      assertOpen();
      if (typeof executionId !== 'string' || !EXECUTION_ID.test(executionId)) return undefined;
      return guarded(() =>
        db.transaction(() => {
          observeFresh();
          verifyCompleteness();
          const row = selectByExecution.get(executionId) as Row | undefined;
          return row === undefined ? undefined : decode(row);
        })(),
      );
    },
    async openAccounts() {
      assertOpen();
      return guarded(() =>
        db.transaction(() => {
          observeFresh();
          verifyCompleteness();
          return Object.freeze([...new Set((selectOpen.all() as Row[]).map(decode).map((record) => record.account))].sort());
        })(),
      );
    },
    async verifyAll() {
      assertOpen();
      return guarded(() =>
        db.transaction(() => {
          verifyCompleteness();
          const records = (selectAll.all() as Row[]).map(decode);
          const claims = records.filter((record) => record.submissionAttempts === 1).length;
          if ((countEvents.get() as { n: number }).n !== records.length + claims) throw corrupt('anchored-history');
          return { records: records.length, open: records.filter((record) => record.state !== 'settled').length };
        })(),
      );
    },
    async health() {
      if (closed) return { status: 'unhealthy', readable: false, writable: false, schemaVersion: V1_FIXTURE_SCHEMA_VERSION };
      try {
        const open = guarded(() =>
          db.transaction(() => {
            verifyCompleteness();
            return (selectOpen.all() as Row[]).map(decode).length;
          })(),
        );
        const freshnessStatus = session?.status().status ?? 'not-anchored';
        if (freshnessStatus === 'not-anchored' || isFailedAuthorityStateFreshnessStatus(freshnessStatus)) {
          return { status: 'unhealthy', readable: true, writable: false, schemaVersion: V1_FIXTURE_SCHEMA_VERSION, freshness: freshnessStatus };
        }
        return { status: 'healthy', readable: true, writable: true, schemaVersion: V1_FIXTURE_SCHEMA_VERSION, open, freshness: freshnessStatus };
      } catch {
        return { status: 'unhealthy', readable: false, writable: false, schemaVersion: V1_FIXTURE_SCHEMA_VERSION };
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      db.close();
    },
  };
  try {
    const anchorRow = selectAnchor.get() as { store_id: unknown } | undefined;
    if (anchorRow !== undefined && (typeof anchorRow.store_id !== 'string' || anchorRow.store_id.length === 0)) throw corrupt('anchor');
    if (freshness === undefined) {
      // Never served for execution without its witness. Verification tooling (no scope) only reads.
      if (scope !== undefined) throw unavailable('The trade sequence interlock is opened for execution only under the CORE-07 freshness witness.');
      storeId = typeof anchorRow?.store_id === 'string' ? anchorRow.store_id : undefined;
    } else if (anchorRow === undefined) {
      // Never anchored after the fact: an existing history the witness has not seen from its first event could already have lost one.
      if ((countRows.get() as { n: number }).n > 0 || (countEvents.get() as { n: number }).n > 0) throw unavailable('The trade sequence interlock holds records without a freshness anchor and is never anchored after the fact.');
      const genesisId = await freshness.boundary.genesisStoreId(TRADE_RESERVATIONS_STATE_KIND, { newStoreId: () => `trade-sequence-interlock:${randomUUID()}`, genesisDigest: (id) => historyGenesisDigest(id, historyScope) });
      db.transaction(() => {
        const raced = selectAnchor.get() as { store_id: unknown } | undefined;
        if (raced === undefined) db.prepare('INSERT INTO trade_interlock_anchor (id, store_id, anchored_at) VALUES (1, ?, ?)').run(genesisId, now());
        else if (raced.store_id !== genesisId) throw corrupt('anchor');
      }).immediate();
      storeId = genesisId;
    } else {
      storeId = anchorRow.store_id as string;
    }
    await store.verifyAll();
    if (freshness !== undefined) {
      // CORE-07, before the store is handed to anything: rollback, stale restore, fork, an unheld pending event, an unenrolled slot or an unreachable witness refuses the open.
      session = await freshness.boundary.establish(checkpointOf(currentHead()), () => checkpointOf(currentHead()));
      markComposedUnderFreshness(store, freshness.boundary);
    } else if (storeId !== undefined) {
      currentHead();
    }
  } catch (error) {
    closed = true;
    db.close();
    throw error;
  }
  return Object.freeze(store);
}
