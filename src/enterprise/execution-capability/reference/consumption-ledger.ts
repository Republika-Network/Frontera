import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { isExecutionCapabilityIdentifier } from '../capability.js';
import { readVerifiedExecutionCapability } from '../verifier.js';

/**
 * G-02A — the **reference durable consumption ledger** an executor keeps:
 * one row per execution capability it ever accepted, committed **before** any
 * side effect. Adapted from the TRADE-04C-S1 reference capability ledger of
 * the delegated signer, which is left unchanged.
 *
 * ## The consumption domain, stated exactly
 *
 * One ledger file is one consumption domain, pinned to **one audience** when it
 * is created. Inside it:
 *
 * - a capability id is consumed at most once, whatever its state;
 * - an issuer's execution id is consumed at most once — a second capability for
 *   the same execution is refused even though its id is new;
 * - every claim is an `IMMEDIATE` transaction with `synchronous = FULL`, so
 *   connections and processes sharing the file serialize on it, and a crash
 *   after the commit leaves the capability consumed.
 *
 * Two executor instances with **separate** ledger files are two consumption
 * domains: each would accept the same capability once. Single use is global
 * only across instances that share one ledger. Nothing here makes an external
 * side effect happen exactly once; it makes the *authorization* usable at most
 * once per domain, and records what the executor says happened afterwards.
 *
 * ## Uncertainty is explicit
 *
 * `claimed` is not an outcome. A crash, a timeout or a lost response after the
 * claim leaves the row `claimed` — "authorized and possibly attempted, outcome
 * not recorded" — and the capability is never claimable again. An executor may
 * record `outcome-unknown` when it knows it cannot tell, and later resolve that
 * to `completed` or `failed`; nothing moves backwards and nothing is deleted.
 * These are the executor's own statements, not authenticated execution
 * evidence (signed receipts are G-02C).
 *
 * ## What it is not
 *
 * As trustworthy as the host that keeps it: whoever can rewrite or restore the
 * file can forget a consumption. The triggers refuse a `DELETE` or a backward
 * `UPDATE`; a raw writer can still remove rows by other means (an
 * `INSERT OR REPLACE`, a rewritten file). It is not anchored against rollback.
 *
 * `claim` accepts any `verified` result of this runtime's verifier and itself
 * re-checks only the audience, status eligibility and expiry: the issuers,
 * organizations and trust domain accepted are the composed verifier's. A claim
 * that cannot take the write lock within the busy timeout throws (nothing is
 * consumed); the executor must then not act. A missing
 * file is never an empty ledger — it is created only by an explicit
 * `create: true`, which refuses to overwrite any existing file.
 */

export const EXECUTION_CAPABILITY_LEDGER_SCHEMA_VERSION = 'frontera.execution-capability-consumption-ledger.v1';

export const EXECUTION_CAPABILITY_CONSUMPTION_STATES = Object.freeze(['claimed', 'completed', 'failed', 'outcome-unknown'] as const);
export type ExecutionCapabilityConsumptionState = (typeof EXECUTION_CAPABILITY_CONSUMPTION_STATES)[number];

/** What an executor may record after a claim. */
export type ExecutionCapabilityReportedOutcome = Exclude<ExecutionCapabilityConsumptionState, 'claimed'>;

export const EXECUTION_CAPABILITY_CLAIM_REFUSALS = Object.freeze([
  /** Not a verification result produced by this runtime's verifier, or a rejected one. */
  'NOT_VERIFIED',
  /** The verification requires an authoritative status answer that is not available (G-02D). Never claimable without it. */
  'STATUS_REQUIRED_UNAVAILABLE',
  /** Verified for an audience other than the one this ledger is pinned to. */
  'AUDIENCE_MISMATCH',
  /** Expired by the ledger's clock at claim time. */
  'CAPABILITY_EXPIRED',
  /** This capability id was consumed before. */
  'CAPABILITY_CONSUMED',
  /** Another capability for the same issuer execution was consumed before. */
  'EXECUTION_CONSUMED',
] as const);
export type ExecutionCapabilityClaimRefusal = (typeof EXECUTION_CAPABILITY_CLAIM_REFUSALS)[number];

export type ExecutionCapabilityClaim =
  | { readonly outcome: 'claimed'; readonly capabilityId: string; readonly claimedAt: string }
  | { readonly outcome: 'refused'; readonly reason: ExecutionCapabilityClaimRefusal };

export type ExecutionCapabilityConsumptionRecord =
  | { readonly state: 'absent' }
  | {
      readonly state: ExecutionCapabilityConsumptionState;
      readonly capabilityId: string;
      readonly issuer: string;
      readonly executionId: string;
      readonly claimedAt: string;
      /** `false` while `claimed`: authorized and possibly attempted, outcome not recorded. */
      readonly outcomeRecorded: boolean;
    };

export interface ExecutionCapabilityConsumptionLedger {
  /** The one audience this ledger consumes for. */
  readonly audience: string;
  /** Consumes durably before any side effect, or refuses with one closed reason. Accepts only a `verified` result of this runtime's verifier. */
  claim(verification: unknown): ExecutionCapabilityClaim;
  /** Records the executor's own statement of what happened. Forward only: `claimed` → any outcome; `outcome-unknown` → `completed` | `failed`. */
  recordOutcome(capabilityId: string, outcome: ExecutionCapabilityReportedOutcome): 'recorded' | 'not-claimed' | 'not-forward';
  read(capabilityId: string): ExecutionCapabilityConsumptionRecord;
  readExecution(issuer: string, executionId: string): ExecutionCapabilityConsumptionRecord;
  close(): void;
}

export interface ExecutionCapabilityConsumptionLedgerOptions {
  /** The audience this ledger is pinned to. Recorded at creation; an existing ledger pinned to another audience is refused. */
  readonly audience: string;
  /** Wall clock, ms since the epoch. Required: expiry is re-checked at claim time. */
  readonly clock: () => number;
  /** `true` only to initialize a **new** ledger. Refused over any existing file. */
  readonly create?: boolean;
  readonly busyTimeoutMs?: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS execution_capability_ledger_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  schema_version TEXT NOT NULL,
  audience TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS execution_capability_consumptions (
  capability_id TEXT PRIMARY KEY,
  issuer TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  trust_domain TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  action_binding_digest TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  claimed_at TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('claimed', 'completed', 'failed', 'outcome-unknown')),
  outcome_recorded_at TEXT,
  UNIQUE (issuer, execution_id)
);
CREATE TRIGGER IF NOT EXISTS execution_capability_ledger_meta_fixed_update BEFORE UPDATE ON execution_capability_ledger_meta
BEGIN SELECT RAISE(ABORT, 'the ledger identity is fixed'); END;
CREATE TRIGGER IF NOT EXISTS execution_capability_ledger_meta_fixed_delete BEFORE DELETE ON execution_capability_ledger_meta
BEGIN SELECT RAISE(ABORT, 'the ledger identity is fixed'); END;
CREATE TRIGGER IF NOT EXISTS execution_capability_consumptions_never_deleted BEFORE DELETE ON execution_capability_consumptions
BEGIN SELECT RAISE(ABORT, 'a consumed capability is permanent'); END;
CREATE TRIGGER IF NOT EXISTS execution_capability_consumptions_forward_only BEFORE UPDATE ON execution_capability_consumptions
WHEN NOT (
    (OLD.state = 'claimed' AND NEW.state IN ('completed', 'failed', 'outcome-unknown'))
    OR (OLD.state = 'outcome-unknown' AND NEW.state IN ('completed', 'failed'))
  )
  OR NEW.capability_id IS NOT OLD.capability_id OR NEW.issuer IS NOT OLD.issuer
  OR NEW.organization_id IS NOT OLD.organization_id OR NEW.trust_domain IS NOT OLD.trust_domain
  OR NEW.execution_id IS NOT OLD.execution_id OR NEW.action_binding_digest IS NOT OLD.action_binding_digest
  OR NEW.expires_at IS NOT OLD.expires_at OR NEW.claimed_at IS NOT OLD.claimed_at
BEGIN SELECT RAISE(ABORT, 'a consumed capability only moves forward'); END;
`;

const LEDGER_TRIGGERS: readonly string[] = [
  'execution_capability_ledger_meta_fixed_update',
  'execution_capability_ledger_meta_fixed_delete',
  'execution_capability_consumptions_never_deleted',
  'execution_capability_consumptions_forward_only',
];

const REPORTED_OUTCOMES: readonly ExecutionCapabilityReportedOutcome[] = ['completed', 'failed', 'outcome-unknown'];

interface ConsumptionRow {
  readonly capability_id: unknown;
  readonly issuer: unknown;
  readonly execution_id: unknown;
  readonly claimed_at: unknown;
  readonly state: unknown;
}

type Database = import('better-sqlite3').Database;

function tableExists(db: Database, name: string): boolean {
  return db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) !== undefined;
}

function recordOf(row: ConsumptionRow | undefined): ExecutionCapabilityConsumptionRecord {
  if (row === undefined) return Object.freeze({ state: 'absent' as const });
  if (
    typeof row.capability_id !== 'string' ||
    typeof row.issuer !== 'string' ||
    typeof row.execution_id !== 'string' ||
    typeof row.claimed_at !== 'string' ||
    !(EXECUTION_CAPABILITY_CONSUMPTION_STATES as readonly unknown[]).includes(row.state)
  ) {
    throw new Error('The execution capability ledger holds a malformed row.');
  }
  const state = row.state as ExecutionCapabilityConsumptionState;
  return Object.freeze({ state, capabilityId: row.capability_id, issuer: row.issuer, executionId: row.execution_id, claimedAt: row.claimed_at, outcomeRecorded: state !== 'claimed' });
}

function instantOf(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * Opens the ledger at `path` — a file, never `:memory:`: a ledger that forgets
 * at restart is the replay it exists to refuse. An absent file is refused
 * unless `create: true`; `create: true` over an existing file is refused too,
 * so a ledger is never re-initialized over its own history.
 */
export async function openExecutionCapabilityConsumptionLedger(path: string, options: ExecutionCapabilityConsumptionLedgerOptions): Promise<ExecutionCapabilityConsumptionLedger> {
  if (typeof path !== 'string' || path.trim().length === 0 || path.trim() === ':memory:') throw new Error('The execution capability ledger needs a durable file path.');
  const { audience, clock } = options;
  if (!isExecutionCapabilityIdentifier(audience) || audience.includes('*')) throw new Error('The execution capability ledger needs exactly one audience.');
  if (typeof clock !== 'function') throw new Error('The execution capability ledger needs a clock: expiry is re-checked at claim time.');
  const busyTimeoutMs = options.busyTimeoutMs ?? 5_000;
  if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 0 || busyTimeoutMs > 60_000) throw new Error('The execution capability ledger busy timeout is out of bounds.');
  if (options.create !== undefined && typeof options.create !== 'boolean') throw new Error('The execution capability ledger create option is a boolean.');
  const create = options.create === true;
  const file = resolve(path);
  if (create && existsSync(file)) throw new Error('The execution capability ledger already exists at that path. A ledger is never re-initialized over existing history.');
  if (!create && !existsSync(file)) {
    throw new Error('The execution capability ledger does not exist at its configured path. It is never recreated implicitly: an empty ledger would forget every consumed capability.');
  }
  if (create && !existsSync(dirname(file))) mkdirSync(dirname(file), { recursive: true });
  const { default: SqliteDatabase } = await import('better-sqlite3');
  const db = new SqliteDatabase(file, create ? {} : { fileMustExist: true });
  try {
    // Before WAL: the journal-mode change itself must wait on a busy file rather than fail.
    db.pragma(`busy_timeout = ${busyTimeoutMs}`);
    if (!create) {
      if (!tableExists(db, 'execution_capability_ledger_meta') || !tableExists(db, 'execution_capability_consumptions')) throw new Error('The execution capability ledger file is not an initialized ledger; refusing to open it.');
      if (db.pragma('quick_check', { simple: true }) !== 'ok') throw new Error('The execution capability ledger failed its integrity check; refusing to open it.');
      // The forward-only and never-deleted rules live in triggers; a file without them is not this ledger.
      const triggers = db.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger' AND name IN (${LEDGER_TRIGGERS.map(() => '?').join(', ')})`).get(...LEDGER_TRIGGERS) as { n: unknown };
      if (triggers.n !== LEDGER_TRIGGERS.length) throw new Error('The execution capability ledger is missing its integrity triggers; refusing to open it.');
    }
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = FULL');
    if (create) {
      db.transaction(() => {
        db.exec(SCHEMA);
        db.prepare('INSERT INTO execution_capability_ledger_meta (id, schema_version, audience) VALUES (1, ?, ?)').run(EXECUTION_CAPABILITY_LEDGER_SCHEMA_VERSION, audience);
      }).immediate();
    }
    const meta = db.prepare('SELECT schema_version, audience FROM execution_capability_ledger_meta WHERE id = 1').get() as { schema_version: unknown; audience: unknown } | undefined;
    if (meta?.schema_version !== EXECUTION_CAPABILITY_LEDGER_SCHEMA_VERSION) throw new Error('The execution capability ledger is recorded under another schema version; refusing to open it.');
    if (meta.audience !== audience) throw new Error('The execution capability ledger is pinned to another audience; refusing to open it.');
  } catch (error) {
    db.close();
    throw error instanceof Error && error.message.startsWith('The execution capability ledger') ? error : new Error('The execution capability ledger could not be opened.');
  }

  const columns = 'capability_id, issuer, execution_id, claimed_at, state';
  const selectCapability = db.prepare(`SELECT ${columns} FROM execution_capability_consumptions WHERE capability_id = ?`);
  const selectExecution = db.prepare(`SELECT ${columns} FROM execution_capability_consumptions WHERE issuer = ? AND execution_id = ?`);
  const insert = db.prepare(
    `INSERT INTO execution_capability_consumptions (capability_id, issuer, organization_id, trust_domain, execution_id, action_binding_digest, expires_at, claimed_at, state)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'claimed')`,
  );
  const advance = db.prepare(
    `UPDATE execution_capability_consumptions SET state = ?, outcome_recorded_at = ?
     WHERE capability_id = ? AND (state = 'claimed' OR (state = 'outcome-unknown' AND ? IN ('completed', 'failed')))`,
  );

  const claimInTransaction = db.transaction((row: { readonly capabilityId: string; readonly issuer: string; readonly organizationId: string; readonly trustDomain: string; readonly executionId: string; readonly bindingDigest: string; readonly expiresAt: string; readonly claimedAt: string }): ExecutionCapabilityClaim => {
    if (selectCapability.get(row.capabilityId) !== undefined) return { outcome: 'refused', reason: 'CAPABILITY_CONSUMED' };
    if (selectExecution.get(row.issuer, row.executionId) !== undefined) return { outcome: 'refused', reason: 'EXECUTION_CONSUMED' };
    insert.run(row.capabilityId, row.issuer, row.organizationId, row.trustDomain, row.executionId, row.bindingDigest, row.expiresAt, row.claimedAt);
    return { outcome: 'claimed', capabilityId: row.capabilityId, claimedAt: row.claimedAt };
  });

  let closed = false;
  const ensureOpen = (): void => {
    if (closed) throw new Error('The execution capability ledger is closed.');
  };
  const refuse = (reason: ExecutionCapabilityClaimRefusal): ExecutionCapabilityClaim => Object.freeze({ outcome: 'refused' as const, reason });

  const ledger: ExecutionCapabilityConsumptionLedger = {
    audience,
    claim(verification: unknown): ExecutionCapabilityClaim {
      ensureOpen();
      const verified = readVerifiedExecutionCapability(verification);
      if (verified === undefined) return refuse('NOT_VERIFIED');
      if (!verified.consumptionEligible) return refuse('STATUS_REQUIRED_UNAVAILABLE');
      const capability = verified.capability;
      if (capability.audience !== audience) return refuse('AUDIENCE_MISMATCH');
      const now = clock();
      // A clock that cannot answer is not a clock that says "still valid".
      if (!Number.isSafeInteger(now) || !(now < Date.parse(capability.expiresAt))) return refuse('CAPABILITY_EXPIRED');
      // IMMEDIATE: the write lock is taken before the reads, so no other connection can interleave between check and insert.
      const claimed = claimInTransaction.immediate({
        capabilityId: capability.capabilityId,
        issuer: capability.issuer,
        organizationId: capability.organizationId,
        trustDomain: capability.trustDomain,
        executionId: capability.executionId,
        bindingDigest: capability.actionBinding.digest,
        expiresAt: capability.expiresAt,
        claimedAt: instantOf(now),
      });
      return Object.freeze(claimed);
    },
    recordOutcome(capabilityId: string, outcome: ExecutionCapabilityReportedOutcome): 'recorded' | 'not-claimed' | 'not-forward' {
      ensureOpen();
      if (!REPORTED_OUTCOMES.includes(outcome)) throw new Error('An execution capability outcome is completed, failed or outcome-unknown.');
      const now = clock();
      if (!Number.isSafeInteger(now)) throw new Error('The execution capability ledger clock did not answer.');
      if (advance.run(outcome, instantOf(now), capabilityId, outcome).changes === 1) return 'recorded';
      return selectCapability.get(capabilityId) === undefined ? 'not-claimed' : 'not-forward';
    },
    read(capabilityId: string): ExecutionCapabilityConsumptionRecord {
      ensureOpen();
      return recordOf(selectCapability.get(capabilityId) as ConsumptionRow | undefined);
    },
    readExecution(issuer: string, executionId: string): ExecutionCapabilityConsumptionRecord {
      ensureOpen();
      return recordOf(selectExecution.get(issuer, executionId) as ConsumptionRow | undefined);
    },
    close(): void {
      if (!closed) {
        closed = true;
        db.close();
      }
    },
  };
  return Object.freeze(ledger);
}
