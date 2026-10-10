import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import {
  XRPL_INTERLOCK_SETTLEMENTS,
  type XrplInterlockSettlement,
  type XrplSubmissionInterlock,
  type XrplSubmissionRecordInput,
  type XrplSubmissionReservation,
} from '../../features/payment-runtime/rails/xrpl/index.js';
import { computeDigest } from '../governance-store/digest.js';

/**
 * PAY-03 — the durable XRPL submission interlock.
 *
 * Its own SQLite file. One row per execution that ever **signed** an XRPL
 * Payment, written strictly **before** that payment's one submission; the
 * only mutable columns are the lifecycle (`state`, `settlement`), moved
 * forward only (`submitting → unconfirmed → settled`, or `submitting →
 * settled`) by SQL triggers and mirrored by an append-only transition log.
 * Nothing is ever deleted — not on restart, not on shutdown, not on settle.
 *
 * Every read re-checks each row's digests and its lifecycle against the log,
 * and the table against the log as a whole (a row that disappeared still has
 * its transitions), and refuses — never repairs — anything that does not hold
 * (`XRPL_INTERLOCK_CORRUPT`). A refused read makes the rail refuse the payment
 * with nothing signed or submitted: uncertainty fails closed.
 *
 * ## Scope
 *
 * The store is bound at creation to one rail id and one XRPL network id
 * (`xrpl_interlock_scope`). An XRPL account's `Sequence` is a ledger-global
 * fact, not an organization's, so records are keyed by source account within
 * that scope; the execution id ties each record to its P11 attempt.
 *
 * ## Concurrency (single shared state, any number of processes)
 *
 * `reserve` is one `BEGIN IMMEDIATE` transaction: it re-reads every open
 * record for the account, applies the blocking rule, enforces one record per
 * execution, and inserts — so two processes on one file cannot both reserve a
 * competing sequence. No transaction is held across a network call.
 *
 * The digests are unkeyed: a writer able to rewrite a row *and* recompute its
 * digests defeats them (integrity, not authenticity). Rollback of the whole
 * file is bounded by the rail's restart quarantine, not by this store
 * (`docs/payments/XRPL_PRODUCTION_COMPOSITION.md` §9).
 */
export const XRPL_INTERLOCK_STORE_SCHEMA_VERSION = 'aoc.xrpl-submission-interlock.schema.v1';

const IDENTITY_DIGEST_DOMAIN = 'aoc.xrpl-submission-interlock.identity.v1';
const STATE_DIGEST_DOMAIN = 'aoc.xrpl-submission-interlock.state.v1';
const SCOPE_DIGEST_DOMAIN = 'aoc.xrpl-submission-interlock.scope.v1';
const DEFAULT_BUSY_TIMEOUT_MS = 5_000;
const MAX_BUSY_TIMEOUT_MS = 60_000;

export type XrplInterlockStoreErrorCode = 'XRPL_INTERLOCK_UNAVAILABLE' | 'XRPL_INTERLOCK_CORRUPT' | 'XRPL_INTERLOCK_INVALID';

/** Messages name the check that failed, never a value. */
export class XrplInterlockStoreError extends Error {
  readonly code: XrplInterlockStoreErrorCode;
  readonly check?: string;

  constructor(code: XrplInterlockStoreErrorCode, message: string, check?: string) {
    super(message);
    this.name = 'XrplInterlockStoreError';
    this.code = code;
    if (check !== undefined) this.check = check;
  }
}

export const XRPL_SUBMISSION_STATES = ['submitting', 'unconfirmed', 'settled'] as const;
export type XrplSubmissionState = (typeof XRPL_SUBMISSION_STATES)[number];

export interface XrplSubmissionRecord extends XrplSubmissionRecordInput {
  readonly state: XrplSubmissionState;
  readonly settlement?: XrplInterlockSettlement;
  readonly reservedAt: string;
  readonly updatedAt: string;
}

export interface XrplInterlockStoreHealth {
  readonly status: 'healthy' | 'unhealthy';
  readonly readable: boolean;
  readonly writable: boolean;
  readonly schemaVersion: string;
  /** Records still open (`submitting` or `unconfirmed`). Never itself unhealthy: an open record is the interlock doing its job. */
  readonly open?: number;
}

/** The interlock port the rail uses, plus what the resolver, readiness and restore read. */
export interface DurableXrplSubmissionInterlock extends XrplSubmissionInterlock {
  readonly providerKind: 'sqlite';
  /** The record for one execution, verified, or `undefined`. */
  read(executionId: string): Promise<XrplSubmissionRecord | undefined>;
  /** Re-verifies every row and the transition log as a whole. Throws `XRPL_INTERLOCK_CORRUPT`. */
  verifyAll(): Promise<{ readonly records: number; readonly open: number }>;
  health(): Promise<XrplInterlockStoreHealth>;
  close(): Promise<void>;
}

export interface CreateSqliteXrplSubmissionInterlockOptions {
  /**
   * The rail id and XRPL network id this store is bound to. A file bound to
   * another scope is refused unmutated. Omitted only by verification tooling
   * (restore): the file must then already be bound, and its recorded scope is
   * verified and used; nothing is created.
   */
  readonly scope?: { readonly railId: string; readonly networkId: number };
  readonly now: () => string;
  readonly busyTimeoutMs?: number;
}

const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS xrpl_interlock_store_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  schema_version TEXT NOT NULL,
  migration_state TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS xrpl_interlock_scope (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  rail_id TEXT NOT NULL,
  network_id INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  scope_digest TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS xrpl_submissions (
  row_id INTEGER PRIMARY KEY AUTOINCREMENT,
  execution_id TEXT NOT NULL UNIQUE,
  account TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  last_ledger_sequence INTEGER NOT NULL,
  min_ledger INTEGER NOT NULL,
  -- Not unique: an execution whose transaction provably never left the process (not-submitted)
  -- may be followed by another that signs byte-identical content. The execution id is the key.
  transaction_hash TEXT NOT NULL,
  currency TEXT NOT NULL,
  issuer TEXT NOT NULL,
  value TEXT NOT NULL,
  reserved_at TEXT NOT NULL,
  identity_digest TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('submitting', 'unconfirmed', 'settled')),
  settlement TEXT,
  updated_at TEXT NOT NULL,
  state_digest TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS xrpl_submissions_by_hash ON xrpl_submissions (transaction_hash);
CREATE INDEX IF NOT EXISTS xrpl_submissions_live_by_account ON xrpl_submissions (account, last_ledger_sequence);
CREATE TABLE IF NOT EXISTS xrpl_submission_transitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  execution_id TEXT NOT NULL,
  from_state TEXT,
  to_state TEXT NOT NULL,
  settlement TEXT,
  recorded_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS xrpl_submission_transitions_by_execution ON xrpl_submission_transitions (execution_id);
CREATE TRIGGER IF NOT EXISTS xrpl_interlock_scope_immutable BEFORE UPDATE ON xrpl_interlock_scope
BEGIN SELECT RAISE(ABORT, 'xrpl interlock scope is immutable'); END;
CREATE TRIGGER IF NOT EXISTS xrpl_interlock_scope_no_delete BEFORE DELETE ON xrpl_interlock_scope
BEGIN SELECT RAISE(ABORT, 'xrpl interlock scope is immutable'); END;
CREATE TRIGGER IF NOT EXISTS xrpl_submissions_no_delete BEFORE DELETE ON xrpl_submissions
BEGIN SELECT RAISE(ABORT, 'xrpl submission records are never deleted'); END;
CREATE TRIGGER IF NOT EXISTS xrpl_submissions_identity_immutable BEFORE UPDATE OF execution_id, account, sequence, last_ledger_sequence, min_ledger, transaction_hash, currency, issuer, value, reserved_at, identity_digest ON xrpl_submissions
BEGIN SELECT RAISE(ABORT, 'xrpl submission identity is immutable'); END;
CREATE TRIGGER IF NOT EXISTS xrpl_submissions_forward_only BEFORE UPDATE OF state ON xrpl_submissions
WHEN NOT ((OLD.state = 'submitting' AND NEW.state IN ('unconfirmed', 'settled')) OR (OLD.state = 'unconfirmed' AND NEW.state = 'settled'))
BEGIN SELECT RAISE(ABORT, 'xrpl submission state moves forward only'); END;
CREATE TRIGGER IF NOT EXISTS xrpl_submission_transitions_append_only_update BEFORE UPDATE ON xrpl_submission_transitions
BEGIN SELECT RAISE(ABORT, 'xrpl submission transitions are append-only'); END;
CREATE TRIGGER IF NOT EXISTS xrpl_submission_transitions_append_only_delete BEFORE DELETE ON xrpl_submission_transitions
BEGIN SELECT RAISE(ABORT, 'xrpl submission transitions are append-only'); END;
`;

const COLUMNS = 'execution_id, account, sequence, last_ledger_sequence, min_ledger, transaction_hash, currency, issuer, value, reserved_at, identity_digest, state, settlement, updated_at, state_digest';

interface Row {
  readonly execution_id: unknown;
  readonly account: unknown;
  readonly sequence: unknown;
  readonly last_ledger_sequence: unknown;
  readonly min_ledger: unknown;
  readonly transaction_hash: unknown;
  readonly currency: unknown;
  readonly issuer: unknown;
  readonly value: unknown;
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
const CURRENCY = /^(?:[A-Za-z0-9?!@#$%^&*<>(){}[\]|]{3}|[0-9A-F]{40})$/;
const VALUE = /^(?:0|[1-9][0-9]{0,39})(?:\.[0-9]{1,96})?$/;

const unavailable = (message: string): XrplInterlockStoreError => new XrplInterlockStoreError('XRPL_INTERLOCK_UNAVAILABLE', message);
const corrupt = (check: string): XrplInterlockStoreError => new XrplInterlockStoreError('XRPL_INTERLOCK_CORRUPT', `The XRPL submission interlock failed its integrity check '${check}'. It is refused, never repaired.`, check);
const invalid = (field: string): XrplInterlockStoreError => new XrplInterlockStoreError('XRPL_INTERLOCK_INVALID', `The XRPL submission interlock refused a malformed '${field}'.`);

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

function identityDigest(record: XrplSubmissionRecordInput, reservedAt: string): string {
  return computeDigest({
    domain: IDENTITY_DIGEST_DOMAIN,
    executionId: record.executionId,
    account: record.account,
    sequence: record.sequence,
    lastLedgerSequence: record.lastLedgerSequence,
    minLedger: record.minLedger,
    transactionHash: record.transactionHash,
    amount: { currency: record.amount.currency, issuer: record.amount.issuer, value: record.amount.value },
    reservedAt,
  });
}

function stateDigest(identity: string, state: XrplSubmissionState, settlement: XrplInterlockSettlement | null, updatedAt: string): string {
  return computeDigest({ domain: STATE_DIGEST_DOMAIN, identityDigest: identity, state, settlement, updatedAt });
}

function validateInput(record: XrplSubmissionRecordInput): void {
  if (typeof record?.executionId !== 'string' || !EXECUTION_ID.test(record.executionId)) throw invalid('executionId');
  if (typeof record.account !== 'string' || !CLASSIC_ADDRESS.test(record.account)) throw invalid('account');
  if (!isPositiveInteger(record.sequence)) throw invalid('sequence');
  if (!isPositiveInteger(record.lastLedgerSequence)) throw invalid('lastLedgerSequence');
  if (!isPositiveInteger(record.minLedger) || record.minLedger > record.lastLedgerSequence) throw invalid('minLedger');
  if (typeof record.transactionHash !== 'string' || !HASH.test(record.transactionHash)) throw invalid('transactionHash');
  const amount = record.amount;
  if (typeof amount?.currency !== 'string' || !CURRENCY.test(amount.currency)) throw invalid('amount.currency');
  if (typeof amount.issuer !== 'string' || !CLASSIC_ADDRESS.test(amount.issuer)) throw invalid('amount.issuer');
  if (typeof amount.value !== 'string' || !VALUE.test(amount.value)) throw invalid('amount.value');
}

/**
 * Opens (or creates) the interlock file, verifying it completely before
 * returning: schema version, scope, every row and the transition log.
 */
export async function createSqliteXrplSubmissionInterlock(dbPath: string, options: CreateSqliteXrplSubmissionInterlockOptions): Promise<DurableXrplSubmissionInterlock> {
  if (typeof dbPath !== 'string' || dbPath.trim().length === 0) throw unavailable('The XRPL submission interlock path must be a non-empty string.');
  if (typeof options?.now !== 'function') throw unavailable('The XRPL submission interlock requires an injected clock.');
  const scope = options.scope;
  if (scope !== undefined && (typeof scope?.railId !== 'string' || scope.railId.length === 0 || !Number.isSafeInteger(scope.networkId) || scope.networkId < 0)) throw unavailable('The XRPL submission interlock requires its rail id and network id scope.');
  if (scope === undefined && dbPath === ':memory:') throw unavailable('The XRPL submission interlock requires its scope.');
  const busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
  if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 0 || busyTimeoutMs > MAX_BUSY_TIMEOUT_MS) throw unavailable(`The XRPL submission interlock busy timeout must be an integer from 0 to ${MAX_BUSY_TIMEOUT_MS}.`);
  const now = options.now;
  const { default: Database } = await import('better-sqlite3');

  const db = new Database(dbPath === ':memory:' ? ':memory:' : resolveOnDisk(dbPath));
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = FULL');
    db.pragma(`busy_timeout = ${busyTimeoutMs}`);
    // The version guard runs before `CREATE TABLE IF NOT EXISTS`: a file written
    // under a schema this runtime does not implement is refused unmutated.
    if (tableExists(db, 'xrpl_interlock_store_versions')) {
      const existing = db.prepare('SELECT schema_version FROM xrpl_interlock_store_versions ORDER BY id DESC LIMIT 1').get() as { schema_version: unknown } | undefined;
      if (existing !== undefined && existing.schema_version !== XRPL_INTERLOCK_STORE_SCHEMA_VERSION) {
        throw unavailable(`The XRPL submission interlock is recorded under a schema version this runtime does not implement (expected '${XRPL_INTERLOCK_STORE_SCHEMA_VERSION}'). Refusing to open it.`);
      }
      if (existing === undefined && tableExists(db, 'xrpl_submissions')) throw unavailable('The XRPL submission interlock holds tables but an empty schema version record. Refusing to open it.');
    } else if (tableExists(db, 'xrpl_submissions') || tableExists(db, 'xrpl_interlock_scope')) {
      throw unavailable('The XRPL submission interlock holds tables but no schema version record. Refusing to open it.');
    } else if (scope === undefined) {
      throw unavailable('The XRPL submission interlock does not exist; verification never creates one.');
    }
    db.exec(SCHEMA_V1);
    db.transaction(() => {
      if (db.prepare('SELECT 1 FROM xrpl_interlock_store_versions LIMIT 1').get() === undefined) {
        db.prepare(`INSERT INTO xrpl_interlock_store_versions (schema_version, migration_state, recorded_at) VALUES (?, 'current', ?)`).run(XRPL_INTERLOCK_STORE_SCHEMA_VERSION, now());
      }
      const bound = db.prepare('SELECT rail_id, network_id, created_at, scope_digest FROM xrpl_interlock_scope WHERE id = 1').get() as
        | { rail_id: unknown; network_id: unknown; created_at: unknown; scope_digest: unknown }
        | undefined;
      if (bound === undefined) {
        if (db.prepare('SELECT 1 FROM xrpl_submissions LIMIT 1').get() !== undefined) throw corrupt('scope-missing');
        if (scope === undefined) throw unavailable('The XRPL submission interlock is not bound to a scope; verification never binds one.');
        const createdAt = now();
        db.prepare('INSERT INTO xrpl_interlock_scope (id, rail_id, network_id, created_at, scope_digest) VALUES (1, ?, ?, ?, ?)').run(
          scope.railId,
          scope.networkId,
          createdAt,
          computeDigest({ domain: SCOPE_DIGEST_DOMAIN, railId: scope.railId, networkId: scope.networkId, createdAt }),
        );
        return;
      }
      if (typeof bound.created_at !== 'string' || bound.scope_digest !== computeDigest({ domain: SCOPE_DIGEST_DOMAIN, railId: bound.rail_id, networkId: bound.network_id, createdAt: bound.created_at })) {
        throw corrupt('scope-digest');
      }
      if (scope !== undefined && (bound.rail_id !== scope.railId || bound.network_id !== scope.networkId)) {
        throw unavailable('The XRPL submission interlock is bound to another rail or XRPL network than the one configured. Refusing to open it.');
      }
    }).immediate();
  } catch (error) {
    db.close();
    throw error instanceof XrplInterlockStoreError ? error : unavailable('The XRPL submission interlock could not be opened.');
  }

  const selectByExecution = db.prepare(`SELECT ${COLUMNS} FROM xrpl_submissions WHERE execution_id = ?`);
  // Every record of the account whose window the ledger has not yet closed — in ANY state: a row forged to look settled is verified, never trusted unread.
  const selectLiveByAccount = db.prepare(`SELECT ${COLUMNS} FROM xrpl_submissions WHERE account = ? AND last_ledger_sequence > ?`);
  const selectOpen = db.prepare(`SELECT ${COLUMNS} FROM xrpl_submissions WHERE state != 'settled'`);
  const selectAll = db.prepare(`SELECT ${COLUMNS} FROM xrpl_submissions ORDER BY row_id ASC`);
  const selectTransitions = db.prepare('SELECT from_state, to_state, settlement FROM xrpl_submission_transitions WHERE execution_id = ? ORDER BY id ASC');
  const countRows = db.prepare('SELECT COUNT(*) AS n FROM xrpl_submissions');
  const countLoggedExecutions = db.prepare('SELECT COUNT(DISTINCT execution_id) AS n FROM xrpl_submission_transitions');
  const insertRow = db.prepare(
    `INSERT INTO xrpl_submissions (${COLUMNS}) VALUES (@executionId, @account, @sequence, @lastLedgerSequence, @minLedger, @transactionHash, @currency, @issuer, @value, @reservedAt, @identityDigest, 'submitting', NULL, @reservedAt, @stateDigest)`,
  );
  const updateState = db.prepare('UPDATE xrpl_submissions SET state = @state, settlement = @settlement, updated_at = @updatedAt, state_digest = @stateDigest WHERE execution_id = @executionId');
  const insertTransition = db.prepare('INSERT INTO xrpl_submission_transitions (execution_id, from_state, to_state, settlement, recorded_at) VALUES (?, ?, ?, ?, ?)');

  let closed = false;
  const assertOpen = (): void => {
    if (closed) throw unavailable('The XRPL submission interlock has been closed.');
  };

  /** Decodes and fully verifies one row, including its lifecycle against the log. */
  function decode(row: Row): XrplSubmissionRecord {
    const executionId = row.execution_id;
    if (typeof executionId !== 'string' || !EXECUTION_ID.test(executionId)) throw corrupt('execution-id');
    const state = row.state;
    if (!XRPL_SUBMISSION_STATES.includes(state as XrplSubmissionState)) throw corrupt('state');
    const settlement = row.settlement;
    if (settlement !== null && !XRPL_INTERLOCK_SETTLEMENTS.includes(settlement as XrplInterlockSettlement)) throw corrupt('settlement');
    if ((state === 'settled') !== (settlement !== null)) throw corrupt('settlement-state');
    if (typeof row.reserved_at !== 'string' || typeof row.updated_at !== 'string') throw corrupt('timestamps');
    const input: XrplSubmissionRecordInput = {
      executionId,
      account: row.account as string,
      sequence: row.sequence as number,
      lastLedgerSequence: row.last_ledger_sequence as number,
      minLedger: row.min_ledger as number,
      transactionHash: row.transaction_hash as string,
      amount: { currency: row.currency as string, issuer: row.issuer as string, value: row.value as string },
    };
    try {
      validateInput(input);
    } catch {
      throw corrupt('row-fields');
    }
    const identity = identityDigest(input, row.reserved_at);
    if (row.identity_digest !== identity) throw corrupt('identity-digest');
    if (row.state_digest !== stateDigest(identity, state as XrplSubmissionState, settlement as XrplInterlockSettlement | null, row.updated_at)) throw corrupt('state-digest');
    // The lifecycle must be exactly what the append-only log says happened.
    const transitions = selectTransitions.all(executionId) as { from_state: unknown; to_state: unknown; settlement: unknown }[];
    if (transitions.length === 0 || transitions[0]!.from_state !== null || transitions[0]!.to_state !== 'submitting') throw corrupt('transition-log');
    for (const [index, transition] of transitions.entries()) {
      if (index > 0 && transition.from_state !== transitions[index - 1]!.to_state) throw corrupt('transition-log');
    }
    const last = transitions[transitions.length - 1]!;
    if (last.to_state !== state || (last.settlement ?? null) !== settlement) throw corrupt('transition-log');
    return Object.freeze({
      ...input,
      amount: Object.freeze({ ...input.amount }),
      state: state as XrplSubmissionState,
      ...(settlement !== null ? { settlement: settlement as XrplInterlockSettlement } : {}),
      reservedAt: row.reserved_at,
      updatedAt: row.updated_at,
    });
  }

  /** A record that disappeared still has its transitions: the table must account for every logged execution. */
  function verifyCompleteness(): void {
    const rows = (countRows.get() as { n: number }).n;
    const logged = (countLoggedExecutions.get() as { n: number }).n;
    if (rows !== logged) throw corrupt('record-missing');
  }

  /**
   * The blocking rule. Only a record whose window is still open can block, so
   * only those are read — and every one of them is fully verified, whatever
   * its state says, before any is believed. A settled record whose window the
   * ledger has closed cannot affect a new sequence either way.
   */
  function openBlocking(account: string, sequence: number, validatedLedgerIndex: number): boolean {
    verifyCompleteness();
    const live = (selectLiveByAccount.all(account, validatedLedgerIndex) as Row[]).map(decode);
    return live.some((record) => record.state !== 'settled' && record.sequence >= sequence);
  }

  function guarded<T>(work: () => T): T {
    try {
      return work();
    } catch (error) {
      if (error instanceof XrplInterlockStoreError) throw error;
      throw unavailable('The XRPL submission interlock could not complete the operation.');
    }
  }

  function transition(executionId: string, transactionHash: string, to: XrplSubmissionState, settlement: XrplInterlockSettlement | null): void {
    db.transaction(() => {
      const row = selectByExecution.get(executionId) as Row | undefined;
      if (row === undefined) throw unavailable('The XRPL submission interlock holds no record for this execution.');
      const record = decode(row);
      if (record.transactionHash !== transactionHash) throw corrupt('transaction-hash');
      // Forward only, and idempotent: an equal or later state is left as it is.
      if (record.state === 'settled' || record.state === to) return;
      const updatedAt = now();
      const identity = identityDigest(record, record.reservedAt);
      updateState.run({ executionId, state: to, settlement, updatedAt, stateDigest: stateDigest(identity, to, settlement, updatedAt) });
      insertTransition.run(executionId, record.state, to, settlement, updatedAt);
    }).immediate();
  }

  const store: DurableXrplSubmissionInterlock = {
    providerKind: 'sqlite',
    async recorded(executionId) {
      assertOpen();
      if (typeof executionId !== 'string' || !EXECUTION_ID.test(executionId)) throw invalid('executionId');
      return guarded(() =>
        db.transaction(() => {
          verifyCompleteness();
          const row = selectByExecution.get(executionId) as Row | undefined;
          return row === undefined ? undefined : decode(row).transactionHash;
        })(),
      );
    },
    async blocking(query) {
      assertOpen();
      if (typeof query?.account !== 'string' || !CLASSIC_ADDRESS.test(query.account) || !isPositiveInteger(query.sequence) || !isPositiveInteger(query.validatedLedgerIndex)) throw invalid('query');
      return guarded(() => db.transaction(() => openBlocking(query.account, query.sequence, query.validatedLedgerIndex))());
    },
    async reserve(record, validatedLedgerIndex): Promise<XrplSubmissionReservation> {
      assertOpen();
      validateInput(record);
      if (!isPositiveInteger(validatedLedgerIndex)) throw invalid('validatedLedgerIndex');
      return guarded(() =>
        db
          .transaction((): XrplSubmissionReservation => {
            const existing = selectByExecution.get(record.executionId) as Row | undefined;
            if (existing !== undefined) return { outcome: 'execution-recorded', transactionHash: decode(existing).transactionHash };
            if (openBlocking(record.account, record.sequence, validatedLedgerIndex)) return { outcome: 'blocked' };
            const reservedAt = now();
            const identity = identityDigest(record, reservedAt);
            insertRow.run({
              executionId: record.executionId,
              account: record.account,
              sequence: record.sequence,
              lastLedgerSequence: record.lastLedgerSequence,
              minLedger: record.minLedger,
              transactionHash: record.transactionHash,
              currency: record.amount.currency,
              issuer: record.amount.issuer,
              value: record.amount.value,
              reservedAt,
              identityDigest: identity,
              stateDigest: stateDigest(identity, 'submitting', null, reservedAt),
            });
            insertTransition.run(record.executionId, null, 'submitting', null, reservedAt);
            return { outcome: 'reserved' };
          })
          .immediate(),
      );
    },
    async markUnconfirmed(executionId, transactionHash) {
      assertOpen();
      guarded(() => transition(executionId, transactionHash, 'unconfirmed', null));
    },
    async settle(executionId, transactionHash, settlement) {
      assertOpen();
      if (!XRPL_INTERLOCK_SETTLEMENTS.includes(settlement)) throw invalid('settlement');
      guarded(() => transition(executionId, transactionHash, 'settled', settlement));
    },
    async read(executionId) {
      assertOpen();
      if (typeof executionId !== 'string' || !EXECUTION_ID.test(executionId)) return undefined;
      return guarded(() =>
        db.transaction(() => {
          verifyCompleteness();
          const row = selectByExecution.get(executionId) as Row | undefined;
          return row === undefined ? undefined : decode(row);
        })(),
      );
    },
    async verifyAll() {
      assertOpen();
      return guarded(() =>
        db.transaction(() => {
          verifyCompleteness();
          const records = (selectAll.all() as Row[]).map(decode);
          return { records: records.length, open: records.filter((record) => record.state !== 'settled').length };
        })(),
      );
    },
    async health() {
      if (closed) return { status: 'unhealthy', readable: false, writable: false, schemaVersion: XRPL_INTERLOCK_STORE_SCHEMA_VERSION };
      try {
        // Bounded per probe: completeness, and every open record verified. The full scan runs at open (and restore).
        const open = guarded(() =>
          db.transaction(() => {
            verifyCompleteness();
            return (selectOpen.all() as Row[]).map(decode).length;
          })(),
        );
        return { status: 'healthy', readable: true, writable: true, schemaVersion: XRPL_INTERLOCK_STORE_SCHEMA_VERSION, open };
      } catch {
        return { status: 'unhealthy', readable: false, writable: false, schemaVersion: XRPL_INTERLOCK_STORE_SCHEMA_VERSION };
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      // Never clears anything: an open record outlives every shutdown.
      db.close();
    },
  };
  try {
    await store.verifyAll();
  } catch (error) {
    closed = true;
    db.close();
    throw error;
  }
  return Object.freeze(store);
}
