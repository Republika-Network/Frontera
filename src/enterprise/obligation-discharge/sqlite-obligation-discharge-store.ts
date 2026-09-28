import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { OBLIGATION_DISCHARGE_STORE_SCHEMA_VERSION, type ObligationDischargeCorrelation, type ObligationDischargeStore, type StoredObligationDischarge } from './contracts.js';
import { ObligationDischargeError } from './errors.js';
import { verifiedDischargeRows } from './integrity.js';

/**
 * The durable obligation discharge store (CORE-04): one SQLite file of its own,
 * append-only, every row digested and verified on every read.
 *
 * Its own file for the reason every authority store has its own: the reports
 * that release withheld executions must be backed up, restored and rotated on
 * their own terms. `UPDATE` and `DELETE` are refused by triggers, so a report
 * can be added and never rewritten; a row altered underneath the triggers fails
 * its digest, and a failed read leaves every blocking obligation unsatisfied.
 */

export interface SqliteObligationDischargeStoreOptions {
  readonly now: () => string;
  readonly busyTimeoutMs?: number;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS obligation_discharge_store_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    schema_version INTEGER NOT NULL,
    recorded_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS obligation_discharges (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    organization_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    action TEXT NOT NULL,
    resource_scope TEXT NOT NULL,
    obligation_type TEXT NOT NULL,
    source_id TEXT NOT NULL,
    outcome TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    reference TEXT,
    subject_id TEXT,
    recorded_by TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    digest TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS obligation_discharges_by_correlation
    ON obligation_discharges (organization_id, request_id, action, resource_scope, sequence);
  CREATE TRIGGER IF NOT EXISTS obligation_discharges_no_update
    BEFORE UPDATE ON obligation_discharges
    BEGIN SELECT RAISE(ABORT, 'obligation discharges are append-only'); END;
  CREATE TRIGGER IF NOT EXISTS obligation_discharges_no_delete
    BEFORE DELETE ON obligation_discharges
    BEGIN SELECT RAISE(ABORT, 'obligation discharges are append-only'); END;
`;

interface Row {
  readonly organization_id: string;
  readonly request_id: string;
  readonly action: string;
  readonly resource_scope: string;
  readonly obligation_type: string;
  readonly source_id: string;
  readonly outcome: string;
  readonly observed_at: string;
  readonly reference: string | null;
  readonly subject_id: string | null;
  readonly recorded_by: string;
  readonly recorded_at: string;
  readonly digest: string;
}

const MAXIMUM_BUSY_TIMEOUT_MS = 60_000;

export async function createSqliteObligationDischargeStore(path: string, options: SqliteObligationDischargeStoreOptions): Promise<ObligationDischargeStore> {
  const busyTimeoutMs = options.busyTimeoutMs ?? 5_000;
  if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 1 || busyTimeoutMs > MAXIMUM_BUSY_TIMEOUT_MS) {
    throw new RangeError(`busyTimeoutMs must be a positive integer of at most ${String(MAXIMUM_BUSY_TIMEOUT_MS)}.`);
  }
  const absolute = resolve(path);
  const dir = dirname(absolute);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const { default: Database } = await import('better-sqlite3');
  const db = new Database(absolute);
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = FULL');
    db.pragma(`busy_timeout = ${busyTimeoutMs}`);
    db.exec(SCHEMA);
    const version = db.prepare('SELECT schema_version FROM obligation_discharge_store_versions ORDER BY id DESC LIMIT 1').get() as { readonly schema_version: number } | undefined;
    if (version === undefined) {
      db.prepare('INSERT INTO obligation_discharge_store_versions (schema_version, recorded_at) VALUES (?, ?)').run(OBLIGATION_DISCHARGE_STORE_SCHEMA_VERSION, options.now());
    } else if (version.schema_version !== OBLIGATION_DISCHARGE_STORE_SCHEMA_VERSION) {
      throw new ObligationDischargeError('OBLIGATION_DISCHARGE_STORE_UNSUPPORTED', `The obligation discharge store is schema version ${String(version.schema_version)}; this build reads only version ${String(OBLIGATION_DISCHARGE_STORE_SCHEMA_VERSION)}.`);
    }
  } catch (error) {
    db.close();
    throw error;
  }

  const insert = db.prepare(
    `INSERT INTO obligation_discharges (organization_id, request_id, action, resource_scope, obligation_type, source_id, outcome, observed_at, reference, subject_id, recorded_by, recorded_at, digest)
     VALUES (@organization_id, @request_id, @action, @resource_scope, @obligation_type, @source_id, @outcome, @observed_at, @reference, @subject_id, @recorded_by, @recorded_at, @digest)`,
  );
  const select = db.prepare(
    `SELECT organization_id, request_id, action, resource_scope, obligation_type, source_id, outcome, observed_at, reference, subject_id, recorded_by, recorded_at, digest
     FROM obligation_discharges WHERE organization_id = ? AND request_id = ? AND action = ? AND resource_scope = ? ORDER BY sequence ASC`,
  );

  let closed = false;
  const open = (): void => {
    if (closed) throw new ObligationDischargeError('OBLIGATION_DISCHARGE_STORE_CLOSED', 'The obligation discharge store is closed.');
  };

  return {
    kind: 'durable',
    append(row: StoredObligationDischarge): Promise<void> {
      try {
        open();
        insert.run({
          organization_id: row.organizationId,
          request_id: row.correlation.requestId,
          action: row.correlation.action,
          resource_scope: row.correlation.resourceScope,
          obligation_type: row.obligationType,
          source_id: row.sourceId,
          outcome: row.outcome,
          observed_at: row.observedAt,
          reference: row.reference ?? null,
          subject_id: row.subjectId ?? null,
          recorded_by: row.recordedBy,
          recorded_at: row.recordedAt,
          digest: row.digest,
        });
        return Promise.resolve();
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    },
    read(organizationId: string, correlation: ObligationDischargeCorrelation): Promise<readonly StoredObligationDischarge[]> {
      try {
        open();
        const rows = (select.all(organizationId, correlation.requestId, correlation.action, correlation.resourceScope) as Row[]).map(
          (row): StoredObligationDischarge => ({
            organizationId: row.organization_id,
            correlation: { requestId: row.request_id, action: row.action, resourceScope: row.resource_scope },
            obligationType: row.obligation_type,
            sourceId: row.source_id,
            outcome: row.outcome as StoredObligationDischarge['outcome'],
            observedAt: row.observed_at,
            ...(row.reference !== null ? { reference: row.reference } : {}),
            ...(row.subject_id !== null ? { subjectId: row.subject_id } : {}),
            recordedBy: row.recorded_by,
            recordedAt: row.recorded_at,
            digest: row.digest,
          }),
        );
        return Promise.resolve(verifiedDischargeRows(rows, organizationId, correlation));
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    },
    close(): Promise<void> {
      if (!closed) {
        closed = true;
        db.close();
      }
      return Promise.resolve();
    },
  };
}
