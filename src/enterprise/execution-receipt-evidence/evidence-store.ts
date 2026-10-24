import { existsSync, lstatSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { EXECUTOR_RECEIPT_OUTCOMES, executorReceiptDigest, parseExecutorReceipt, type ExecutorReceipt, type ExecutorReceiptOutcome } from '../executor-receipt/index.js';

/** A stored receipt as it was presented: its canonical text and its CORE-02 envelope, checked to be four strings. */
export interface StoredPresentedReceipt {
  readonly receipt: string;
  readonly signature: Readonly<Record<string, string>>;
}

/**
 * G-02C1D (D8) — the Host's receipt evidence store,
 * `frontera.execution-receipt-evidence-store.v1`.
 *
 * A separate SQLite file the operator initializes once; the Host opens it and
 * never creates it. It is **additive**: it holds no P11 outcome and no P12
 * resolution, it is read by neither, and nothing here can change either. What
 * it records is what the executor *stated* about one execution, and whether
 * the Host could tie that statement to a capability it issued.
 *
 * ## Three append-only tables
 *
 * | Table | One row per | What it means |
 * |---|---|---|
 * | `receipt_evidence` | verified, issuance-correlated receipt | the executor's signed statement, accepted as **evidence** for its execution — never as settlement, never as a resolution |
 * | `receipt_conflicts` | verified, correlated receipt that contradicts the accepted chain | preserved, never merged and never authoritative |
 * | `receipt_observations` | presented exchange | how the exchange ended (transmission, status, the Generic HTTP outcome) and what became of its receipt (missing, duplicated, invalid, uncorrelated, conflicting or correlated) |
 *
 * ## Rules enforced here and again by the schema
 *
 * - **Identity:** one row per receipt id and per digest; one receipt per
 *   (capability, sequence). The same receipt again is idempotent; a different
 *   text for a taken position is a conflict, preserved in `receipt_conflicts`.
 * - **Forward only:** a successor is accepted only when it names, as
 *   `supersedes`, the accepted receipt at the position before it, which said
 *   `attempted-outcome-unknown`, and it reports a definite outcome observed no
 *   earlier. A successor whose predecessor the Host never saw is preserved as
 *   a conflict, not accepted.
 * - **Immutable:** no table can be updated or deleted; the identity row is fixed.
 * - **Integrity at open:** tables, triggers, `quick_check`, schema version and
 *   identity are checked, and every evidence and conflict row is re-parsed and
 *   re-digested against its columns. A store that fails is refused.
 *
 * Signatures are verified **before** a receipt reaches this store (the
 * recorder); the store keeps the envelope verbatim so anyone can re-verify.
 */

export const EXECUTION_RECEIPT_EVIDENCE_STORE_SCHEMA_VERSION = 'frontera.execution-receipt-evidence-store.v1';

export const EXECUTION_RECEIPT_TRANSMISSIONS = Object.freeze(['not-sent', 'unconfirmed', 'response'] as const);
export type ExecutionReceiptTransmission = (typeof EXECUTION_RECEIPT_TRANSMISSIONS)[number];

/** The Generic HTTP adapter's own outcome for the exchange, exactly as P11 records it: never changed here. */
export const EXECUTION_RECEIPT_HTTP_OUTCOMES = Object.freeze(['completed', 'failed', 'unconfirmed'] as const);
export type ExecutionReceiptHttpOutcome = (typeof EXECUTION_RECEIPT_HTTP_OUTCOMES)[number];

export const EXECUTION_RECEIPT_DISPOSITIONS = Object.freeze([
  /** No receipt header came back — including when nothing came back at all. Never proof that nothing happened. */
  'receipt-missing',
  /** More than one receipt header: ambiguous, so none is read. */
  'receipt-duplicated',
  /** A receipt that is malformed, from an unpinned executor or key, badly signed, or outside the executor's pinned scope. */
  'receipt-invalid',
  /** A validly signed receipt that does not match the capability this Host issued for this execution. */
  'receipt-uncorrelated',
  /** A validly signed, correlated receipt that contradicts the accepted chain: preserved, not accepted. */
  'receipt-conflicting',
  /** A validly signed receipt matched to this Host's issuance for this execution, and accepted as evidence. */
  'receipt-correlated',
] as const);
export type ExecutionReceiptDisposition = (typeof EXECUTION_RECEIPT_DISPOSITIONS)[number];

/** How the executor's statement relates to the Generic HTTP outcome. A contradiction is recorded, never resolved. */
export const EXECUTION_RECEIPT_AGREEMENTS = Object.freeze(['consistent', 'contradicts', 'not-comparable'] as const);
export type ExecutionReceiptAgreement = (typeof EXECUTION_RECEIPT_AGREEMENTS)[number];

export const EXECUTION_RECEIPT_CONFLICT_REASONS = Object.freeze(['POSITION_TAKEN', 'SUPERSESSION_INVALID', 'PREDECESSOR_UNKNOWN'] as const);
export type ExecutionReceiptConflictReason = (typeof EXECUTION_RECEIPT_CONFLICT_REASONS)[number];

/** A receipt the recorder verified and correlated, ready to be accepted or preserved as a conflict. */
export interface ExecutionReceiptCandidate {
  readonly receipt: ExecutorReceipt;
  readonly canonical: string;
  readonly signature: Readonly<Record<string, string>>;
}

/** One presented exchange, as the recorder classified it. */
export interface ExecutionReceiptExchange {
  readonly executionId: string;
  readonly adapterId: string;
  /** The capability this Host issued for the execution, when the issuance ledger names one. */
  readonly capabilityId: string | null;
  readonly transmission: ExecutionReceiptTransmission;
  readonly httpStatus: number | null;
  readonly httpOutcome: ExecutionReceiptHttpOutcome;
  /** Present exactly when the receipt verified and correlated; the store then decides `receipt-correlated` or `receipt-conflicting`. */
  readonly candidate: ExecutionReceiptCandidate | null;
  /** The recorder's disposition when there is no candidate. Ignored when there is one. */
  readonly disposition: Exclude<ExecutionReceiptDisposition, 'receipt-correlated' | 'receipt-conflicting'> | null;
  /** A closed failure code, never input text. */
  readonly failure: string | null;
  /** The digest of the receipt text, when one was readable. */
  readonly receiptDigest: string | null;
  readonly agreement: ExecutionReceiptAgreement;
}

export interface ExecutionReceiptExchangeRecord {
  readonly disposition: ExecutionReceiptDisposition;
  readonly failure: string | null;
  /** True when the accepted receipt was already in the store (an identical repeat). */
  readonly repeated: boolean;
}

export interface StoredExecutionReceiptEvidence {
  readonly receiptId: string;
  readonly digest: string;
  readonly executionId: string;
  readonly capabilityId: string;
  readonly executorId: string;
  readonly sequence: number;
  readonly supersedes: string | null;
  readonly outcome: ExecutorReceiptOutcome;
  readonly receipt: ExecutorReceipt;
  readonly presented: StoredPresentedReceipt;
  readonly recordedAt: string;
}

export interface StoredExecutionReceiptConflict {
  readonly digest: string;
  readonly receiptId: string;
  readonly executionId: string;
  readonly capabilityId: string;
  readonly sequence: number;
  readonly reason: ExecutionReceiptConflictReason;
  readonly presented: StoredPresentedReceipt;
  readonly recordedAt: string;
}

export interface StoredExecutionReceiptObservation {
  readonly observationId: number;
  readonly executionId: string;
  readonly adapterId: string;
  readonly capabilityId: string | null;
  readonly transmission: ExecutionReceiptTransmission;
  readonly httpStatus: number | null;
  readonly httpOutcome: ExecutionReceiptHttpOutcome;
  readonly disposition: ExecutionReceiptDisposition;
  readonly failure: string | null;
  readonly receiptDigest: string | null;
  readonly receiptOutcome: ExecutorReceiptOutcome | null;
  readonly agreement: ExecutionReceiptAgreement;
  readonly observedAt: string;
}

export interface ExecutionReceiptEvidenceStore {
  readonly issuer: string;
  readonly organizationId: string;
  readonly trustDomain: string;
  /** Records one presented exchange, atomically: the observation, and the receipt as evidence or as a conflict. */
  record(exchange: ExecutionReceiptExchange): ExecutionReceiptExchangeRecord;
  /** The accepted receipts for a capability, oldest first, as presented. */
  history(capabilityId: string): readonly StoredPresentedReceipt[];
  evidenceFor(executionId: string): readonly StoredExecutionReceiptEvidence[];
  conflictsFor(executionId: string): readonly StoredExecutionReceiptConflict[];
  observationsFor(executionId: string): readonly StoredExecutionReceiptObservation[];
  close(): void;
}

export interface ExecutionReceiptEvidenceStoreOptions {
  /** The Host's capability issuer, organization and trust domain: every accepted receipt names them. */
  readonly issuer: string;
  readonly organizationId: string;
  readonly trustDomain: string;
  readonly clock: () => number;
  /** The operator's one explicit initialization. The Host never passes it. */
  readonly create?: boolean;
  readonly busyTimeoutMs?: number;
}

const OUTCOME_LIST = EXECUTOR_RECEIPT_OUTCOMES.map((outcome) => `'${outcome}'`).join(', ');
const quoted = (values: readonly string[]): string => values.map((value) => `'${value}'`).join(', ');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS receipt_evidence_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  schema_version TEXT NOT NULL,
  issuer TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  trust_domain TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS receipt_evidence (
  receipt_id TEXT PRIMARY KEY,
  digest TEXT NOT NULL UNIQUE,
  execution_id TEXT NOT NULL,
  capability_id TEXT NOT NULL,
  executor_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence >= 1),
  supersedes TEXT UNIQUE REFERENCES receipt_evidence (receipt_id),
  outcome TEXT NOT NULL CHECK (outcome IN (${OUTCOME_LIST})),
  canonical TEXT NOT NULL,
  signature TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  UNIQUE (capability_id, sequence),
  CHECK ((sequence = 1 AND supersedes IS NULL) OR (sequence > 1 AND supersedes IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS receipt_conflicts (
  digest TEXT PRIMARY KEY,
  receipt_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  capability_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence >= 1),
  reason TEXT NOT NULL CHECK (reason IN (${quoted(EXECUTION_RECEIPT_CONFLICT_REASONS)})),
  canonical TEXT NOT NULL,
  signature TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS receipt_observations (
  observation_id INTEGER PRIMARY KEY AUTOINCREMENT,
  execution_id TEXT NOT NULL,
  adapter_id TEXT NOT NULL,
  capability_id TEXT,
  transmission TEXT NOT NULL CHECK (transmission IN (${quoted(EXECUTION_RECEIPT_TRANSMISSIONS)})),
  http_status INTEGER,
  http_outcome TEXT NOT NULL CHECK (http_outcome IN (${quoted(EXECUTION_RECEIPT_HTTP_OUTCOMES)})),
  disposition TEXT NOT NULL CHECK (disposition IN (${quoted(EXECUTION_RECEIPT_DISPOSITIONS)})),
  failure TEXT,
  receipt_digest TEXT,
  receipt_outcome TEXT CHECK (receipt_outcome IS NULL OR receipt_outcome IN (${OUTCOME_LIST})),
  agreement TEXT NOT NULL CHECK (agreement IN (${quoted(EXECUTION_RECEIPT_AGREEMENTS)})),
  observed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS receipt_evidence_by_execution ON receipt_evidence (execution_id, sequence);
CREATE INDEX IF NOT EXISTS receipt_conflicts_by_execution ON receipt_conflicts (execution_id, sequence);
CREATE INDEX IF NOT EXISTS receipt_observations_by_execution ON receipt_observations (execution_id, observation_id);
CREATE TRIGGER IF NOT EXISTS receipt_evidence_meta_fixed_update BEFORE UPDATE ON receipt_evidence_meta
BEGIN SELECT RAISE(ABORT, 'the evidence store identity is fixed'); END;
CREATE TRIGGER IF NOT EXISTS receipt_evidence_meta_fixed_delete BEFORE DELETE ON receipt_evidence_meta
BEGIN SELECT RAISE(ABORT, 'the evidence store identity is fixed'); END;
CREATE TRIGGER IF NOT EXISTS receipt_evidence_never_updated BEFORE UPDATE ON receipt_evidence
BEGIN SELECT RAISE(ABORT, 'receipt evidence is immutable'); END;
CREATE TRIGGER IF NOT EXISTS receipt_evidence_never_deleted BEFORE DELETE ON receipt_evidence
BEGIN SELECT RAISE(ABORT, 'receipt evidence is permanent'); END;
CREATE TRIGGER IF NOT EXISTS receipt_conflicts_never_updated BEFORE UPDATE ON receipt_conflicts
BEGIN SELECT RAISE(ABORT, 'a receipt conflict is immutable'); END;
CREATE TRIGGER IF NOT EXISTS receipt_conflicts_never_deleted BEFORE DELETE ON receipt_conflicts
BEGIN SELECT RAISE(ABORT, 'a receipt conflict is permanent'); END;
CREATE TRIGGER IF NOT EXISTS receipt_observations_never_updated BEFORE UPDATE ON receipt_observations
BEGIN SELECT RAISE(ABORT, 'a receipt observation is immutable'); END;
CREATE TRIGGER IF NOT EXISTS receipt_observations_never_deleted BEFORE DELETE ON receipt_observations
BEGIN SELECT RAISE(ABORT, 'a receipt observation is permanent'); END;
CREATE TRIGGER IF NOT EXISTS receipt_evidence_forward_supersession BEFORE INSERT ON receipt_evidence
WHEN NEW.supersedes IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM receipt_evidence AS prior
  WHERE prior.receipt_id = NEW.supersedes AND prior.capability_id = NEW.capability_id AND prior.execution_id = NEW.execution_id
    AND prior.sequence = NEW.sequence - 1 AND prior.outcome = 'attempted-outcome-unknown' AND NEW.outcome <> 'attempted-outcome-unknown'
)
BEGIN SELECT RAISE(ABORT, 'a receipt supersedes only the unknown before it, with a definite outcome'); END;
`;

const TABLES = ['receipt_evidence_meta', 'receipt_evidence', 'receipt_conflicts', 'receipt_observations'];
const TRIGGERS = [
  'receipt_evidence_meta_fixed_update',
  'receipt_evidence_meta_fixed_delete',
  'receipt_evidence_never_updated',
  'receipt_evidence_never_deleted',
  'receipt_conflicts_never_updated',
  'receipt_conflicts_never_deleted',
  'receipt_observations_never_updated',
  'receipt_observations_never_deleted',
  'receipt_evidence_forward_supersession',
];

const SIGNATURE_FIELDS = ['algorithm', 'artifactVersion', 'keyId', 'signature'];

type Database = import('better-sqlite3').Database;

interface EvidenceRow {
  readonly receipt_id: unknown;
  readonly digest: unknown;
  readonly execution_id: unknown;
  readonly capability_id: unknown;
  readonly executor_id: unknown;
  readonly sequence: unknown;
  readonly supersedes: unknown;
  readonly outcome: unknown;
  readonly canonical: unknown;
  readonly signature: unknown;
  readonly recorded_at: unknown;
}

interface ConflictRow {
  readonly digest: unknown;
  readonly receipt_id: unknown;
  readonly execution_id: unknown;
  readonly capability_id: unknown;
  readonly sequence: unknown;
  readonly reason: unknown;
  readonly canonical: unknown;
  readonly signature: unknown;
  readonly recorded_at: unknown;
}

interface ObservationRow {
  readonly observation_id: unknown;
  readonly execution_id: unknown;
  readonly adapter_id: unknown;
  readonly capability_id: unknown;
  readonly transmission: unknown;
  readonly http_status: unknown;
  readonly http_outcome: unknown;
  readonly disposition: unknown;
  readonly failure: unknown;
  readonly receipt_digest: unknown;
  readonly receipt_outcome: unknown;
  readonly agreement: unknown;
  readonly observed_at: unknown;
}

const corrupt = (): never => {
  throw new Error('The execution receipt evidence store holds a corrupted row.');
};

function signatureOf(text: unknown, keyId: string): Readonly<Record<string, string>> {
  let envelope: unknown;
  try {
    envelope = JSON.parse(String(text));
  } catch {
    return corrupt();
  }
  if (envelope === null || typeof envelope !== 'object' || Array.isArray(envelope)) return corrupt();
  const fields = Object.keys(envelope).sort();
  if (JSON.stringify(fields) !== JSON.stringify(SIGNATURE_FIELDS) || !Object.values(envelope).every((value) => typeof value === 'string')) return corrupt();
  if ((envelope as Record<string, string>)['keyId'] !== keyId) return corrupt();
  return Object.freeze({ ...(envelope as Record<string, string>) });
}

/** The envelope as stored: its four fields in one order. */
function signatureText(signature: Readonly<Record<string, string>>): string {
  return JSON.stringify(Object.fromEntries(SIGNATURE_FIELDS.map((field) => [field, signature[field]])));
}

export async function openExecutionReceiptEvidenceStore(path: string, options: ExecutionReceiptEvidenceStoreOptions): Promise<ExecutionReceiptEvidenceStore> {
  if (typeof path !== 'string' || path.trim().length === 0 || path.trim() === ':memory:') throw new Error('The execution receipt evidence store needs a durable file path.');
  const { issuer, organizationId, trustDomain, clock } = options;
  for (const value of [issuer, organizationId, trustDomain]) {
    if (typeof value !== 'string' || value.length === 0) throw new Error('The execution receipt evidence store needs its issuer, organization and trust domain.');
  }
  if (typeof clock !== 'function') throw new Error('The execution receipt evidence store needs a clock.');
  const busyTimeoutMs = options.busyTimeoutMs ?? 5_000;
  if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 0 || busyTimeoutMs > 60_000) throw new Error('The execution receipt evidence store busy timeout is out of bounds.');
  const create = options.create === true;
  const file = resolve(path);
  if (create && existsSync(file)) throw new Error('The execution receipt evidence store already exists at that path. It is never re-initialized over existing evidence.');
  if (!create && !existsSync(file)) throw new Error('The execution receipt evidence store does not exist at its configured path. It is never created implicitly.');
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  // Whoever can rewrite this file can plant "correlated" evidence: it and its directory belong to this user alone.
  const private_ = (target: string, kind: 'file' | 'directory'): boolean => {
    try {
      const stat = lstatSync(target);
      const shape = kind === 'file' ? stat.isFile() : stat.isDirectory();
      return shape && !stat.isSymbolicLink() && stat.uid === uid && (stat.mode & 0o022) === 0;
    } catch {
      return false;
    }
  };
  if (uid === undefined || !private_(dirname(file), 'directory') || (!create && !private_(file, 'file'))) {
    throw new Error('The execution receipt evidence store and its directory must belong to this user and be writable by no one else.');
  }

  const evidenceOf = (row: EvidenceRow): StoredExecutionReceiptEvidence => {
    const parsed = parseExecutorReceipt(row.canonical);
    if (!parsed.ok) return corrupt();
    const receipt = parsed.receipt;
    if (row.digest !== executorReceiptDigest(row.canonical as string)) return corrupt();
    const columnsMatch =
      row.receipt_id === receipt.receiptId &&
      row.execution_id === receipt.executionId &&
      row.capability_id === receipt.capabilityId &&
      row.executor_id === receipt.executorId &&
      row.sequence === receipt.sequence &&
      row.supersedes === receipt.supersedes &&
      row.outcome === receipt.outcome &&
      receipt.issuer === issuer &&
      receipt.organizationId === organizationId &&
      receipt.trustDomain === trustDomain &&
      typeof row.recorded_at === 'string';
    if (!columnsMatch) return corrupt();
    const signature = signatureOf(row.signature, receipt.executorKeyId);
    return Object.freeze({
      receiptId: receipt.receiptId,
      digest: row.digest as string,
      executionId: receipt.executionId,
      capabilityId: receipt.capabilityId,
      executorId: receipt.executorId,
      sequence: receipt.sequence,
      supersedes: receipt.supersedes,
      outcome: receipt.outcome,
      receipt,
      presented: Object.freeze({ receipt: row.canonical as string, signature }),
      recordedAt: row.recorded_at as string,
    });
  };

  const conflictOf = (row: ConflictRow): StoredExecutionReceiptConflict => {
    const parsed = parseExecutorReceipt(row.canonical);
    if (!parsed.ok) return corrupt();
    const receipt = parsed.receipt;
    if (row.digest !== executorReceiptDigest(row.canonical as string)) return corrupt();
    const reason = EXECUTION_RECEIPT_CONFLICT_REASONS.find((candidate) => candidate === row.reason);
    const columnsMatch = row.receipt_id === receipt.receiptId && row.execution_id === receipt.executionId && row.capability_id === receipt.capabilityId && row.sequence === receipt.sequence && typeof row.recorded_at === 'string';
    if (reason === undefined || !columnsMatch) return corrupt();
    return Object.freeze({
      digest: row.digest as string,
      receiptId: receipt.receiptId,
      executionId: receipt.executionId,
      capabilityId: receipt.capabilityId,
      sequence: receipt.sequence,
      reason,
      presented: Object.freeze({ receipt: row.canonical as string, signature: signatureOf(row.signature, receipt.executorKeyId) }),
      recordedAt: row.recorded_at as string,
    });
  };

  const observationOf = (row: ObservationRow): StoredExecutionReceiptObservation => {
    const transmission = EXECUTION_RECEIPT_TRANSMISSIONS.find((value) => value === row.transmission);
    const httpOutcome = EXECUTION_RECEIPT_HTTP_OUTCOMES.find((value) => value === row.http_outcome);
    const disposition = EXECUTION_RECEIPT_DISPOSITIONS.find((value) => value === row.disposition);
    const agreement = EXECUTION_RECEIPT_AGREEMENTS.find((value) => value === row.agreement);
    const receiptOutcome = row.receipt_outcome === null ? null : EXECUTOR_RECEIPT_OUTCOMES.find((value) => value === row.receipt_outcome);
    const nullableText = (value: unknown): value is string | null => value === null || typeof value === 'string';
    const shaped =
      typeof row.observation_id === 'number' &&
      typeof row.execution_id === 'string' &&
      typeof row.adapter_id === 'string' &&
      nullableText(row.capability_id) &&
      (row.http_status === null || typeof row.http_status === 'number') &&
      nullableText(row.failure) &&
      nullableText(row.receipt_digest) &&
      typeof row.observed_at === 'string';
    if (!shaped || transmission === undefined || httpOutcome === undefined || disposition === undefined || agreement === undefined || receiptOutcome === undefined) return corrupt();
    return Object.freeze({
      observationId: row.observation_id as number,
      executionId: row.execution_id as string,
      adapterId: row.adapter_id as string,
      capabilityId: row.capability_id as string | null,
      transmission,
      httpStatus: row.http_status as number | null,
      httpOutcome,
      disposition,
      failure: row.failure as string | null,
      receiptDigest: row.receipt_digest as string | null,
      receiptOutcome,
      agreement,
      observedAt: row.observed_at as string,
    });
  };

  const { default: SqliteDatabase } = await import('better-sqlite3');
  const db: Database = new SqliteDatabase(file, create ? {} : { fileMustExist: true });
  const statements = (() => {
    try {
      db.pragma(`busy_timeout = ${busyTimeoutMs}`);
      if (!create) {
        const table = (name: string): boolean => db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) !== undefined;
        if (!TABLES.every(table)) throw new Error('The execution receipt evidence store file is not an initialized evidence store; refusing to open it.');
        if (db.pragma('quick_check', { simple: true }) !== 'ok') throw new Error('The execution receipt evidence store failed its integrity check; refusing to open it.');
        const triggers = db.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger' AND name IN (${TRIGGERS.map(() => '?').join(', ')})`).get(...TRIGGERS) as { n: unknown };
        if (triggers.n !== TRIGGERS.length) throw new Error('The execution receipt evidence store is missing its integrity triggers; refusing to open it.');
      }
      db.pragma('journal_mode = WAL');
      db.pragma('synchronous = FULL');
      if (create) {
        db.transaction(() => {
          db.exec(SCHEMA);
          db.prepare('INSERT INTO receipt_evidence_meta (id, schema_version, issuer, organization_id, trust_domain) VALUES (1, ?, ?, ?, ?)').run(EXECUTION_RECEIPT_EVIDENCE_STORE_SCHEMA_VERSION, issuer, organizationId, trustDomain);
        }).immediate();
      }
      const meta = db.prepare('SELECT schema_version, issuer, organization_id, trust_domain FROM receipt_evidence_meta WHERE id = 1').get() as
        | { schema_version: unknown; issuer: unknown; organization_id: unknown; trust_domain: unknown }
        | undefined;
      if (meta?.schema_version !== EXECUTION_RECEIPT_EVIDENCE_STORE_SCHEMA_VERSION) throw new Error('The execution receipt evidence store is recorded under another schema version; refusing to open it.');
      if (meta.issuer !== issuer || meta.organization_id !== organizationId || meta.trust_domain !== trustDomain) throw new Error('The execution receipt evidence store belongs to another issuer, organization or trust domain; refusing to open it.');
      // Every row, re-read against its own text: a store that was edited underneath is refused, not trusted.
      for (const row of db.prepare('SELECT * FROM receipt_evidence').all() as EvidenceRow[]) evidenceOf(row);
      for (const row of db.prepare('SELECT * FROM receipt_conflicts').all() as ConflictRow[]) conflictOf(row);
      for (const row of db.prepare('SELECT * FROM receipt_observations').all() as ObservationRow[]) observationOf(row);
      return {
        evidenceById: db.prepare('SELECT * FROM receipt_evidence WHERE receipt_id = ?'),
        evidenceAt: db.prepare('SELECT * FROM receipt_evidence WHERE capability_id = ? AND sequence = ?'),
        evidenceByCapability: db.prepare('SELECT * FROM receipt_evidence WHERE capability_id = ? ORDER BY sequence'),
        evidenceByExecution: db.prepare('SELECT * FROM receipt_evidence WHERE execution_id = ? ORDER BY capability_id, sequence'),
        conflictsByExecution: db.prepare('SELECT * FROM receipt_conflicts WHERE execution_id = ? ORDER BY capability_id, sequence, digest'),
        observationsByExecution: db.prepare('SELECT * FROM receipt_observations WHERE execution_id = ? ORDER BY observation_id'),
        insertEvidence: db.prepare(
          'INSERT INTO receipt_evidence (receipt_id, digest, execution_id, capability_id, executor_id, sequence, supersedes, outcome, canonical, signature, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        ),
        insertConflict: db.prepare(
          'INSERT OR IGNORE INTO receipt_conflicts (digest, receipt_id, execution_id, capability_id, sequence, reason, canonical, signature, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        ),
        insertObservation: db.prepare(
          'INSERT INTO receipt_observations (execution_id, adapter_id, capability_id, transmission, http_status, http_outcome, disposition, failure, receipt_digest, receipt_outcome, agreement, observed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        ),
      };
    } catch (error) {
      db.close();
      throw error instanceof Error && error.message.startsWith('The execution receipt evidence store') ? error : new Error('The execution receipt evidence store could not be opened.');
    }
  })();

  let closed = false;
  const ensureOpen = (): void => {
    if (closed) throw new Error('The execution receipt evidence store is closed.');
  };
  const instant = (): string => {
    const now = clock();
    if (!Number.isSafeInteger(now)) throw new Error('The execution receipt evidence store clock did not answer.');
    return new Date(now).toISOString();
  };

  /** Where `candidate` belongs: accepted (new or repeated), or a conflict with its reason. */
  const placementOf = (candidate: ExecutionReceiptCandidate, digest: string): { readonly accept: boolean; readonly repeated: boolean; readonly reason?: ExecutionReceiptConflictReason } => {
    const receipt = candidate.receipt;
    const sameId = statements.evidenceById.get(receipt.receiptId) as EvidenceRow | undefined;
    if (sameId !== undefined) return evidenceOf(sameId).digest === digest ? { accept: true, repeated: true } : { accept: false, repeated: false, reason: 'POSITION_TAKEN' };
    if (statements.evidenceAt.get(receipt.capabilityId, receipt.sequence) !== undefined) return { accept: false, repeated: false, reason: 'POSITION_TAKEN' };
    if (receipt.supersedes === null) return { accept: true, repeated: false };
    const priorRow = statements.evidenceById.get(receipt.supersedes) as EvidenceRow | undefined;
    if (priorRow === undefined) return { accept: false, repeated: false, reason: 'PREDECESSOR_UNKNOWN' };
    const prior = evidenceOf(priorRow);
    // Forward only: the unknown at the position before, resolved by a definite outcome observed no earlier.
    const forward =
      prior.capabilityId === receipt.capabilityId &&
      prior.executionId === receipt.executionId &&
      prior.sequence === receipt.sequence - 1 &&
      prior.outcome === 'attempted-outcome-unknown' &&
      receipt.outcome !== 'attempted-outcome-unknown' &&
      receipt.observedAt >= prior.receipt.observedAt;
    return forward ? { accept: true, repeated: false } : { accept: false, repeated: false, reason: 'SUPERSESSION_INVALID' };
  };

  const recordInTransaction = db.transaction((exchange: ExecutionReceiptExchange): ExecutionReceiptExchangeRecord => {
    const at = instant();
    let outcome: ExecutionReceiptExchangeRecord;
    const candidate = exchange.candidate;
    let digest: string | null = exchange.receiptDigest;
    if (candidate !== null) {
      digest = executorReceiptDigest(candidate.canonical);
      // The text is what is stored, so the text is what is judged: its own parse, never the object handed in.
      const reparsed = parseExecutorReceipt(candidate.canonical);
      if (!reparsed.ok || reparsed.receipt.receiptId !== candidate.receipt.receiptId) throw new Error('The execution receipt evidence store refuses a candidate that is not its own canonical text.');
      const receipt = reparsed.receipt;
      // Only this Host's own receipts, for this exchange's execution and capability, are ever evidence here.
      if (receipt.issuer !== issuer || receipt.organizationId !== organizationId || receipt.trustDomain !== trustDomain || receipt.executionId !== exchange.executionId || receipt.capabilityId !== exchange.capabilityId) {
        throw new Error('The execution receipt evidence store refuses a receipt for another issuer, scope, execution or capability.');
      }
      const placed = placementOf({ ...candidate, receipt }, digest);
      if (placed.accept) {
        if (!placed.repeated) {
          statements.insertEvidence.run(receipt.receiptId, digest, receipt.executionId, receipt.capabilityId, receipt.executorId, receipt.sequence, receipt.supersedes, receipt.outcome, candidate.canonical, signatureText(candidate.signature), at);
        }
        outcome = Object.freeze({ disposition: 'receipt-correlated' as const, failure: null, repeated: placed.repeated });
      } else {
        const reason = placed.reason as ExecutionReceiptConflictReason;
        statements.insertConflict.run(digest, receipt.receiptId, receipt.executionId, receipt.capabilityId, receipt.sequence, reason, candidate.canonical, signatureText(candidate.signature), at);
        outcome = Object.freeze({ disposition: 'receipt-conflicting' as const, failure: reason, repeated: false });
      }
    } else {
      outcome = Object.freeze({ disposition: exchange.disposition ?? 'receipt-missing', failure: exchange.failure, repeated: false });
    }
    statements.insertObservation.run(
      exchange.executionId,
      exchange.adapterId,
      exchange.capabilityId,
      exchange.transmission,
      exchange.httpStatus,
      exchange.httpOutcome,
      outcome.disposition,
      outcome.failure,
      digest,
      candidate?.receipt.outcome ?? null,
      exchange.agreement,
      at,
    );
    return outcome;
  });

  const store: ExecutionReceiptEvidenceStore = {
    issuer,
    organizationId,
    trustDomain,
    record(exchange: ExecutionReceiptExchange): ExecutionReceiptExchangeRecord {
      ensureOpen();
      return recordInTransaction.immediate(exchange);
    },
    history(capabilityId: string): readonly StoredPresentedReceipt[] {
      ensureOpen();
      return Object.freeze((statements.evidenceByCapability.all(capabilityId) as EvidenceRow[]).map((row) => evidenceOf(row).presented));
    },
    evidenceFor(executionId: string): readonly StoredExecutionReceiptEvidence[] {
      ensureOpen();
      return Object.freeze((statements.evidenceByExecution.all(executionId) as EvidenceRow[]).map(evidenceOf));
    },
    conflictsFor(executionId: string): readonly StoredExecutionReceiptConflict[] {
      ensureOpen();
      return Object.freeze((statements.conflictsByExecution.all(executionId) as ConflictRow[]).map(conflictOf));
    },
    observationsFor(executionId: string): readonly StoredExecutionReceiptObservation[] {
      ensureOpen();
      return Object.freeze((statements.observationsByExecution.all(executionId) as ObservationRow[]).map(observationOf));
    },
    close(): void {
      if (closed) return;
      closed = true;
      db.close();
    },
  };
  return Object.freeze(store);
}
