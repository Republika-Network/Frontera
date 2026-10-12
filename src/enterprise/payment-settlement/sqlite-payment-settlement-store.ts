import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { canonicalSerialize } from '../governance-store/canonical-json.js';
import { isCanonicalOutcomeInstant } from './validation.js';
import {
  PAYMENT_SETTLEMENT_STORE_SCHEMA_VERSION,
  type PaymentSettlementAccessContext,
  type PaymentSettlementRecord,
  type PaymentSettlementStoreHealth,
  type RecordPaymentSettlementInput,
  type RecordPaymentSettlementResult,
} from './contracts.js';
import { PaymentSettlementStoreError } from './errors.js';
import { buildPaymentSettlementRecord } from './integrity.js';
import { corrupt, planPaymentSettlement, requireSettlementAccessContext, requireSettlementExecutionId, requireValidSettlement, verifyLoadedSettlement, type PaymentSettlementStore } from './settlement-store.js';

/**
 * The durable settlement store — the production implementation of
 * `PaymentSettlementStore` (PAY-05).
 *
 * ## One append-only table, one row per execution
 *
 * `payment_settlements` holds each settlement as its canonical JSON
 * (`aoc.canonical-json.v1`, the serialization its digests are taken over),
 * keyed by `execution_id` (primary key) and its derived `settlement_id`
 * (unique). Triggers refuse `UPDATE` and `DELETE`; nothing here issues either.
 * There is no status column: "not settled" is the absence of a row.
 *
 * ## Every write decision is one `BEGIN IMMEDIATE` transaction
 *
 * The write lock is taken before the existing row is read, so "load → verify →
 * existing / conflict / record → sample `recordedAt` → insert" happens with no
 * other writer — in this process or another sharing the file — able to
 * interleave. Two workers verifying the same execution converge on one row; a
 * different final transfer for the same execution is a conflict.
 *
 * ## Verified on every read, never repaired
 *
 * An unknown schema version refuses to open the file, unmutated. Every row read
 * is decoded, held to the closed contract and its digests recomputed; its key
 * columns must equal what the record states. Anything else is
 * `PAYMENT_SETTLEMENT_CORRUPT`. `WAL` + `synchronous = FULL`.
 *
 * ## Why no CORE-07 anchor
 *
 * A settlement is reconstructible from immutable external finality: a rollback
 * or loss of this file makes a settled payment read **not yet settled** — a
 * receipt, a payment-obligation discharge or a refund is then refused until an
 * explicit verification re-establishes the identical content from the rail. It
 * never makes anything payable, refundable or verified that was not. The
 * receipt carries no local instant, so the re-derived receipt is byte-identical
 * (`docs/payments/PAY-05-SETTLEMENT-AND-RECEIPTS.md` §12). Refund accounting,
 * which a rollback *could* turn into money, is anchored separately.
 */

export interface CreateSqlitePaymentSettlementStoreOptions {
  /** The injected clock: sampled inside every write's `BEGIN IMMEDIATE`, as `recordedAt`. Required. */
  readonly now: () => string;
  readonly busyTimeoutMs?: number;
}

export interface DurablePaymentSettlementStore extends PaymentSettlementStore {
  readonly providerKind: 'sqlite';
}

const DEFAULT_BUSY_TIMEOUT_MS = 5_000;
const MAXIMUM_BUSY_TIMEOUT_MS = 60_000;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS payment_settlement_store_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    schema_version TEXT NOT NULL,
    migration_state TEXT NOT NULL,
    recorded_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS payment_settlements (
    execution_id TEXT PRIMARY KEY,
    settlement_id TEXT NOT NULL UNIQUE,
    organization_id TEXT NOT NULL,
    record_json TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    settlement_digest TEXT NOT NULL
  );

  CREATE TRIGGER IF NOT EXISTS payment_settlements_append_only_update
    BEFORE UPDATE ON payment_settlements
    BEGIN SELECT RAISE(ABORT, 'payment settlements are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS payment_settlements_append_only_delete
    BEFORE DELETE ON payment_settlements
    BEGIN SELECT RAISE(ABORT, 'payment settlements are immutable'); END;
`;

interface SettlementRow {
  readonly execution_id: unknown;
  readonly settlement_id: unknown;
  readonly organization_id: unknown;
  readonly record_json: unknown;
  readonly recorded_at: unknown;
  readonly settlement_digest: unknown;
}

function unavailable(message: string): PaymentSettlementStoreError {
  return new PaymentSettlementStoreError('PAYMENT_SETTLEMENT_STORE_UNAVAILABLE', message);
}

function resolveBusyTimeoutMs(value: number | undefined): number {
  const timeout = value ?? DEFAULT_BUSY_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > MAXIMUM_BUSY_TIMEOUT_MS) {
    throw new RangeError(`busyTimeoutMs must be a positive integer of at most ${String(MAXIMUM_BUSY_TIMEOUT_MS)}, received '${String(value)}'.`);
  }
  return timeout;
}

function tableExists(db: import('better-sqlite3').Database, tableName: string): boolean {
  return db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(tableName) !== undefined;
}

function resolveOnDisk(dbPath: string): string {
  const absPath = resolve(dbPath);
  const dir = dirname(absPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return absPath;
}

/** A row back into a record: decoded exactly, then left to verification — never reshaped. */
function settlementOf(executionId: string, row: SettlementRow): PaymentSettlementRecord {
  if (typeof row.record_json !== 'string') throw corrupt(executionId, 'record_json is not text');
  let record: PaymentSettlementRecord;
  try {
    record = JSON.parse(row.record_json) as PaymentSettlementRecord;
  } catch {
    throw corrupt(executionId, 'the record does not decode');
  }
  if (record === null || typeof record !== 'object') throw corrupt(executionId, 'the record is not an object');
  // The key columns are a second statement of the record's identity; they must agree with it exactly.
  if (row.execution_id !== record.executionId || row.settlement_id !== record.settlementId || row.organization_id !== record.organizationId || row.recorded_at !== record.recordedAt || row.settlement_digest !== record.settlementDigest) {
    throw corrupt(executionId, 'the key columns disagree with the record');
  }
  return record;
}

export async function createSqlitePaymentSettlementStore(dbPath: string, options: CreateSqlitePaymentSettlementStoreOptions): Promise<DurablePaymentSettlementStore> {
  if (typeof dbPath !== 'string' || dbPath.trim().length === 0) throw unavailable('The settlement store path must be a non-empty string.');
  if (typeof options?.now !== 'function') throw unavailable('The settlement store requires an injected clock.');
  const busyTimeoutMs = resolveBusyTimeoutMs(options.busyTimeoutMs);
  const now = options.now;
  const { default: Database } = await import('better-sqlite3');

  const path = dbPath === ':memory:' ? ':memory:' : resolveOnDisk(dbPath);
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = FULL');
  db.pragma(`busy_timeout = ${busyTimeoutMs}`);

  // The version decision is one `BEGIN IMMEDIATE`, read before any CREATE: a
  // file under a schema this runtime does not implement is refused unmutated.
  try {
    db.transaction(() => {
      const latest = tableExists(db, 'payment_settlement_store_versions')
        ? (db.prepare(`SELECT schema_version FROM payment_settlement_store_versions ORDER BY id DESC LIMIT 1`).get() as { schema_version: string } | undefined)?.schema_version
        : undefined;
      if (latest !== undefined && latest !== PAYMENT_SETTLEMENT_STORE_SCHEMA_VERSION) {
        throw unavailable(`The settlement store is recorded under schema version '${latest}', which this runtime does not implement (expected '${PAYMENT_SETTLEMENT_STORE_SCHEMA_VERSION}'). Refusing to open it.`);
      }
      if (latest === undefined && tableExists(db, 'payment_settlements')) throw unavailable('The settlement store holds settlements with no version history. Refusing to open it.');
      const openedAt = latest === undefined ? now() : undefined;
      if (latest === undefined && !isCanonicalOutcomeInstant(openedAt)) throw unavailable('The store clock did not answer a canonical instant.');
      db.exec(SCHEMA);
      if (latest === undefined) {
        db.prepare(`INSERT INTO payment_settlement_store_versions (schema_version, migration_state, recorded_at) VALUES (?, 'current', ?)`).run(PAYMENT_SETTLEMENT_STORE_SCHEMA_VERSION, openedAt);
      }
    }).immediate();
  } catch (error) {
    db.close();
    throw error;
  }

  const selectSettlement = db.prepare(`SELECT execution_id, settlement_id, organization_id, record_json, recorded_at, settlement_digest FROM payment_settlements WHERE execution_id = ?`);
  const insertSettlement = db.prepare(
    `INSERT INTO payment_settlements (execution_id, settlement_id, organization_id, record_json, recorded_at, settlement_digest)
     VALUES (@executionId, @settlementId, @organizationId, @recordJson, @recordedAt, @settlementDigest)`,
  );

  let closed = false;

  function assertOpen(): void {
    if (closed) throw unavailable('The settlement store has been closed.');
  }

  function load(executionId: string, organizationId: string): PaymentSettlementRecord | undefined {
    const row = selectSettlement.get(executionId) as SettlementRow | undefined;
    return verifyLoadedSettlement(executionId, organizationId, row === undefined ? undefined : settlementOf(executionId, row));
  }

  const runRecord = db.transaction((input: RecordPaymentSettlementInput): RecordPaymentSettlementResult => {
    const plan = planPaymentSettlement(input, load(input.executionId, input.organizationId));
    if (plan.kind === 'existing') return { outcome: 'existing', settlement: plan.settlement };
    const instant = now();
    if (!isCanonicalOutcomeInstant(instant)) throw unavailable('The store clock did not answer a canonical instant; nothing was written.');
    const settlement = buildPaymentSettlementRecord(input, instant);
    insertSettlement.run({
      executionId: settlement.executionId,
      settlementId: settlement.settlementId,
      organizationId: settlement.organizationId,
      recordJson: canonicalSerialize(settlement),
      recordedAt: settlement.recordedAt,
      settlementDigest: settlement.settlementDigest,
    });
    return { outcome: 'recorded', settlement };
  });

  const runRead = db.transaction((executionId: string, organizationId: string): PaymentSettlementRecord | undefined => load(executionId, organizationId));

  return {
    providerKind: 'sqlite',

    async record(context: PaymentSettlementAccessContext, input: RecordPaymentSettlementInput): Promise<RecordPaymentSettlementResult> {
      assertOpen();
      requireValidSettlement(context, input);
      // BEGIN IMMEDIATE; durable before this resolves (`synchronous = FULL`).
      return runRecord.immediate(input);
    },

    async read(context: PaymentSettlementAccessContext, executionId: string): Promise<PaymentSettlementRecord | undefined> {
      assertOpen();
      const organizationId = requireSettlementAccessContext(context);
      requireSettlementExecutionId(executionId);
      return runRead(executionId, organizationId);
    },

    async health(): Promise<PaymentSettlementStoreHealth> {
      let readable = false;
      try {
        if (!closed) {
          const version = db.prepare(`SELECT schema_version FROM payment_settlement_store_versions ORDER BY id DESC LIMIT 1`).get() as { schema_version: string } | undefined;
          readable = version?.schema_version === PAYMENT_SETTLEMENT_STORE_SCHEMA_VERSION;
        }
      } catch {
        readable = false;
      }
      const writable = readable && !closed && !db.readonly;
      return { status: readable && writable ? 'healthy' : 'unhealthy', readable, writable, schemaVersion: PAYMENT_SETTLEMENT_STORE_SCHEMA_VERSION, checkedAt: now() };
    },

    async close(): Promise<void> {
      if (!closed) {
        closed = true;
        db.close();
      }
    },
  };
}
