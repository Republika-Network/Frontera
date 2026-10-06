import Database from 'better-sqlite3';

/**
 * The durable submission-attempt store (ANDREW-P0-08).
 *
 * Why a transport-local store: the runtime's execution-outcome store (P10/P11)
 * prepares a durable attempt keyed by `executionId` before the adapter runs and
 * records the terminal outcome after — but adapters and their transports are
 * structurally barred from it, and it does not own ledger facts. What a
 * reliable XRPL submission must persist *before* submit — the prepared
 * sequence, `LastLedgerSequence`, the signed hash and blob, the validated
 * ledger observed — belongs here, keyed by the same `executionId`, so the two
 * records join on `executionId` and the transaction hash.
 *
 * Append-only: an attempt row is written once (prepare → sign → **persist** →
 * submit) and never updated or deleted; every later fact is a new event.
 * Triggers refuse UPDATE and DELETE. One attempt per `executionId` (primary
 * key) and per transaction hash (unique): a second attempt for an execution
 * is refused by the database, so a retry can never sign a second transaction.
 *
 * The signed blob is replay-sensitive (not a key, but submittable): it is
 * stored, never returned by `find`, and readable only through `signedBlob`.
 */

export type XrplAttemptState =
  /** Persisted after signing, before the submit call. */
  | 'signed'
  /** The submit call returned (preliminary result recorded; not an outcome). */
  | 'submitted'
  /** The submit call threw: the transaction may or may not have reached the network. */
  | 'submit-uncertain'
  /** Validated, `tesSUCCESS`, and every evidence check passed. Terminal. */
  | 'validated-success'
  /** Validated with a `tec…` result: the payment did not happen (a fee was charged). Terminal. */
  | 'validated-tec'
  /** `LastLedgerSequence` passed and the server searched every ledger in range: never applied. Terminal. */
  | 'expired'
  /** Validated, but evidence is missing, inconsistent or outside the grant horizon. Value may have moved: manual reconciliation. Terminal for automation. */
  | 'anomaly'
  /** No final answer within the wait. Re-checkable; never re-signed. */
  | 'unresolved';

export const TERMINAL_ATTEMPT_STATES: readonly XrplAttemptState[] = ['validated-success', 'validated-tec', 'expired', 'anomaly'];

export interface XrplSubmissionAttempt {
  readonly executionId: string;
  readonly requestId: string;
  readonly decisionId: string;
  readonly network: string;
  readonly sourceAccount: string;
  readonly destination: string;
  readonly currency: string;
  readonly issuer: string;
  readonly value: string;
  readonly fee: string;
  readonly sequence: number;
  readonly lastLedgerSequence: number;
  readonly transactionHash: string;
  readonly validatedLedgerAtPrepare: number;
  readonly notAfter: string;
  readonly createdAt: string;
}

export interface XrplAttemptEvent {
  readonly state: XrplAttemptState;
  readonly recordedAt: string;
  readonly evidence?: Readonly<Record<string, string>>;
}

export interface XrplAttemptRecord {
  readonly attempt: XrplSubmissionAttempt;
  readonly events: readonly XrplAttemptEvent[];
  readonly state: XrplAttemptState;
}

export interface XrplSubmissionAttemptStore {
  /** Persist a signed attempt and its `signed` event atomically and durably. Throws if the execution or hash already has an attempt. */
  record(attempt: XrplSubmissionAttempt, signedBlob: string): void;
  append(executionId: string, state: XrplAttemptState, evidence?: Readonly<Record<string, string>>): void;
  find(executionId: string): XrplAttemptRecord | undefined;
  /** Replay-sensitive. For manual reconciliation only; the transport never resubmits automatically. */
  signedBlob(executionId: string): string | undefined;
  close(): void;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS xrpl_submission_attempts (
  execution_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  decision_id TEXT NOT NULL,
  network TEXT NOT NULL,
  source_account TEXT NOT NULL,
  destination TEXT NOT NULL,
  currency TEXT NOT NULL,
  issuer TEXT NOT NULL,
  value TEXT NOT NULL,
  fee TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  last_ledger_sequence INTEGER NOT NULL,
  transaction_hash TEXT NOT NULL UNIQUE,
  signed_blob TEXT NOT NULL,
  validated_ledger_at_prepare INTEGER NOT NULL,
  not_after TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS xrpl_submission_attempt_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  execution_id TEXT NOT NULL REFERENCES xrpl_submission_attempts(execution_id),
  state TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  evidence_json TEXT
);
CREATE TRIGGER IF NOT EXISTS xrpl_attempts_no_update BEFORE UPDATE ON xrpl_submission_attempts BEGIN SELECT RAISE(ABORT, 'xrpl submission attempts are immutable'); END;
CREATE TRIGGER IF NOT EXISTS xrpl_attempts_no_delete BEFORE DELETE ON xrpl_submission_attempts BEGIN SELECT RAISE(ABORT, 'xrpl submission attempts are immutable'); END;
CREATE TRIGGER IF NOT EXISTS xrpl_attempt_events_no_update BEFORE UPDATE ON xrpl_submission_attempt_events BEGIN SELECT RAISE(ABORT, 'xrpl submission attempt events are immutable'); END;
CREATE TRIGGER IF NOT EXISTS xrpl_attempt_events_no_delete BEFORE DELETE ON xrpl_submission_attempt_events BEGIN SELECT RAISE(ABORT, 'xrpl submission attempt events are immutable'); END;
`;

interface AttemptRow {
  readonly execution_id: string;
  readonly request_id: string;
  readonly decision_id: string;
  readonly network: string;
  readonly source_account: string;
  readonly destination: string;
  readonly currency: string;
  readonly issuer: string;
  readonly value: string;
  readonly fee: string;
  readonly sequence: number;
  readonly last_ledger_sequence: number;
  readonly transaction_hash: string;
  readonly validated_ledger_at_prepare: number;
  readonly not_after: string;
  readonly created_at: string;
}

export function createSqliteXrplAttemptStore(path: string, options: { readonly now?: () => string } = {}): XrplSubmissionAttemptStore {
  const now = options.now ?? (() => new Date().toISOString());
  const db = new Database(path);
  db.pragma('busy_timeout = 10000');
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = FULL');
  db.exec(SCHEMA);

  const insertAttempt = db.prepare(`INSERT INTO xrpl_submission_attempts (execution_id, request_id, decision_id, network, source_account, destination, currency, issuer, value, fee, sequence, last_ledger_sequence, transaction_hash, signed_blob, validated_ledger_at_prepare, not_after, created_at)
    VALUES (@executionId, @requestId, @decisionId, @network, @sourceAccount, @destination, @currency, @issuer, @value, @fee, @sequence, @lastLedgerSequence, @transactionHash, @signedBlob, @validatedLedgerAtPrepare, @notAfter, @createdAt)`);
  const insertEvent = db.prepare('INSERT INTO xrpl_submission_attempt_events (execution_id, state, recorded_at, evidence_json) VALUES (?, ?, ?, ?)');
  const selectAttempt = db.prepare('SELECT execution_id, request_id, decision_id, network, source_account, destination, currency, issuer, value, fee, sequence, last_ledger_sequence, transaction_hash, validated_ledger_at_prepare, not_after, created_at FROM xrpl_submission_attempts WHERE execution_id = ?');
  const selectEvents = db.prepare('SELECT state, recorded_at, evidence_json FROM xrpl_submission_attempt_events WHERE execution_id = ? ORDER BY id');
  const selectBlob = db.prepare('SELECT signed_blob FROM xrpl_submission_attempts WHERE execution_id = ?');

  const recordTransaction = db.transaction((attempt: XrplSubmissionAttempt, signedBlob: string) => {
    insertAttempt.run({ ...attempt, signedBlob });
    insertEvent.run(attempt.executionId, 'signed', now(), null);
  });

  return Object.freeze({
    record(attempt: XrplSubmissionAttempt, signedBlob: string) {
      recordTransaction.immediate(attempt, signedBlob);
    },
    append(executionId: string, state: XrplAttemptState, evidence?: Readonly<Record<string, string>>) {
      insertEvent.run(executionId, state, now(), evidence === undefined ? null : JSON.stringify(evidence));
    },
    find(executionId: string): XrplAttemptRecord | undefined {
      const row = selectAttempt.get(executionId) as AttemptRow | undefined;
      if (row === undefined) return undefined;
      const events = (selectEvents.all(executionId) as { readonly state: XrplAttemptState; readonly recorded_at: string; readonly evidence_json: string | null }[]).map((event) => ({
        state: event.state,
        recordedAt: event.recorded_at,
        ...(event.evidence_json !== null ? { evidence: JSON.parse(event.evidence_json) as Record<string, string> } : {}),
      }));
      const attempt: XrplSubmissionAttempt = {
        executionId: row.execution_id,
        requestId: row.request_id,
        decisionId: row.decision_id,
        network: row.network,
        sourceAccount: row.source_account,
        destination: row.destination,
        currency: row.currency,
        issuer: row.issuer,
        value: row.value,
        fee: row.fee,
        sequence: row.sequence,
        lastLedgerSequence: row.last_ledger_sequence,
        transactionHash: row.transaction_hash,
        validatedLedgerAtPrepare: row.validated_ledger_at_prepare,
        notAfter: row.not_after,
        createdAt: row.created_at,
      };
      const last = events.at(-1);
      return { attempt, events, state: last === undefined ? 'signed' : last.state };
    },
    signedBlob(executionId: string) {
      return (selectBlob.get(executionId) as { readonly signed_blob: string } | undefined)?.signed_blob;
    },
    close() {
      db.close();
    },
  });
}
