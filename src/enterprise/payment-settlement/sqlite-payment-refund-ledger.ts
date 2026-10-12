import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import type { MonetaryAmount } from '../../features/monetary-runtime/index.js';
import type { AuthorityStateCheckpoint } from '../authority-state-freshness/checkpoint.js';
import { AuthorityStateFreshnessError, isAuthorityStateFreshnessError, type AuthorityStateFreshnessErrorCode } from '../authority-state-freshness/errors.js';
import {
  isAuthorityStateFreshnessBoundary,
  isFailedAuthorityStateFreshnessStatus,
  markComposedUnderFreshness,
  type AuthorityStateFreshnessBoundary,
  type AuthorityStateFreshnessSession,
  type AuthorityStateFreshnessStatusValue,
} from '../authority-state-freshness/session.js';
import { canonicalSerialize } from '../governance-store/canonical-json.js';
import { isCanonicalOutcomeInstant, isOpaqueExecutionIdentifier } from './validation.js';
import { PaymentSettlementStoreError, isPaymentSettlementStoreError } from './errors.js';
import {
  PAYMENT_REFUND_LEDGER_SCHEMA_VERSION,
  PAYMENT_REFUND_STATE_KIND,
  buildPaymentRefundEntry,
  corruptLedger,
  paymentRefundBalance,
  paymentRefundEntryFailure,
  paymentRefundGenesisDigest,
  paymentRefundReservations,
  planPaymentRefundRelease,
  planPaymentRefundReservation,
  requireRefundReleaseInput,
  requireRefundReserveInput,
  type PaymentRefundBalance,
  type PaymentRefundEntry,
  type PaymentRefundEntryContent,
  type PaymentRefundLedger,
  type PaymentRefundReservation,
  type ReleasePaymentRefundInput,
  type ReleasePaymentRefundResult,
  type ReservePaymentRefundInput,
  type ReservePaymentRefundResult,
} from './refund-ledger.js';

/**
 * The durable refund accounting (PAY-05) — SQLite, append-only, hash-chained,
 * and **always** anchored at the CORE-07 external witness.
 *
 * ```
 * open      version guard (before any CREATE) → schema → anchor (a new file is a genesis enrolled at the
 *           witness before it is written here) → every entry verified, the chain recomputed
 *           → the history reconciled with the witness: older (rollback / stale restore), forked,
 *           a prepared transition this file does not hold, an unreachable witness → refused
 * reserve   witness probe → decide on the verified head (BEGIN IMMEDIATE, no write) → witness PREPARE
 *           the successor → BEGIN IMMEDIATE: head unchanged, decision unchanged, insert → FINALIZE
 * release   the same transition
 * read      verified, and the head held against what the witness established (local, no network)
 * ```
 *
 * ## Two layers, neither a substitute for the other
 *
 * - **Freshness (CORE-07):** "is this the newest committed history?" The
 *   witness holds the head `(sequence, chain digest)`; an older or forked head
 *   is refused.
 * - **Integrity (local hash chain):** "are these rows exactly the contents of
 *   that history?" Every read recomputes every entry's digest from its content
 *   and the chain from genesis. A witnessed head says nothing about the rows
 *   under it: a row whose amount, principal, original or release was rewritten
 *   while its stored digest strings were kept matches the witness and fails
 *   here. Nothing is trusted because a digest *string* is unchanged — no
 *   cached position skips the recomputation.
 *
 * A reservation is acknowledged only once it is durable **and** witnessed, so
 * no refund is ever governed against a reservation a restore could erase; a
 * witness that does not prepare refuses it with nothing written. There is no
 * unanchored mode, no enrollment of an earlier file (none ever existed), no
 * repair and no "force clear": a refused history is resolved by restoring the
 * newest file, or by trusted recovery at the witness — never by the Host.
 * One Host per state volume; across processes on one volume the witness's
 * compare-and-advance and `BEGIN IMMEDIATE` decide.
 */

export interface CreateSqlitePaymentRefundLedgerOptions {
  readonly now: () => string;
  /** The CORE-07 boundary of the organization this ledger serves. Required: refund accounting is never kept without its witness. */
  readonly freshness: { readonly boundary: AuthorityStateFreshnessBoundary };
  readonly busyTimeoutMs?: number;
}

export interface DurablePaymentRefundLedger extends PaymentRefundLedger {
  readonly providerKind: 'sqlite';
  /** Re-verifies every entry and the whole chain. */
  verifyAll(): Promise<{ readonly entries: number }>;
  health(): Promise<{ readonly status: 'healthy' | 'unhealthy'; readonly readable: boolean; readonly writable: boolean; readonly schemaVersion: string; readonly freshness: AuthorityStateFreshnessStatusValue; readonly checkedAt: string }>;
}

const VERSIONS_TABLE = 'payment_refund_ledger_versions';
const ANCHOR_TABLE = 'payment_refund_ledger_anchor';
const ENTRIES_TABLE = 'payment_refund_entries';
const DEFAULT_BUSY_TIMEOUT_MS = 5_000;
const MAXIMUM_BUSY_TIMEOUT_MS = 60_000;
/** Bounded write attempts when another writer holds or wins the witness first. Contention before any refund is governed — never a payment retry. */
const ANCHORED_WRITE_ATTEMPTS = 8;
const ANCHORED_WRITE_BACKOFF_MS = 25;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS ${VERSIONS_TABLE} (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    schema_version TEXT NOT NULL,
    migration_state TEXT NOT NULL,
    recorded_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS ${ANCHOR_TABLE} (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    store_id TEXT NOT NULL,
    organization_id TEXT NOT NULL,
    anchored_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS ${ENTRIES_TABLE} (
    sequence INTEGER PRIMARY KEY,
    kind TEXT NOT NULL,
    organization_id TEXT NOT NULL,
    refund_operation_id TEXT NOT NULL,
    original_settlement_id TEXT,
    entry_json TEXT NOT NULL,
    entry_digest TEXT NOT NULL,
    chain_digest TEXT NOT NULL
  );

  CREATE UNIQUE INDEX IF NOT EXISTS payment_refund_entries_operation_kind ON ${ENTRIES_TABLE} (refund_operation_id, kind);
  CREATE INDEX IF NOT EXISTS payment_refund_entries_original ON ${ENTRIES_TABLE} (organization_id, original_settlement_id);

  CREATE TRIGGER IF NOT EXISTS payment_refund_entries_append_only_update
    BEFORE UPDATE ON ${ENTRIES_TABLE}
    BEGIN SELECT RAISE(ABORT, 'refund accounting is append-only'); END;
  CREATE TRIGGER IF NOT EXISTS payment_refund_entries_append_only_delete
    BEFORE DELETE ON ${ENTRIES_TABLE}
    BEGIN SELECT RAISE(ABORT, 'refund accounting is append-only'); END;
  CREATE TRIGGER IF NOT EXISTS payment_refund_ledger_anchor_immutable
    BEFORE UPDATE ON ${ANCHOR_TABLE}
    BEGIN SELECT RAISE(ABORT, 'the refund accounting anchor is immutable'); END;
  CREATE TRIGGER IF NOT EXISTS payment_refund_ledger_anchor_no_delete
    BEFORE DELETE ON ${ANCHOR_TABLE}
    BEGIN SELECT RAISE(ABORT, 'the refund accounting anchor is immutable'); END;
`;

type Row = Readonly<Record<string, unknown>>;

interface LedgerHead {
  readonly sequence: number;
  readonly digest: string;
}

const pause = (ms: number): Promise<void> => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

function sticky(code: AuthorityStateFreshnessErrorCode): boolean {
  return code === 'AUTHORITY_FRESHNESS_PENDING_RECOVERY' || code === 'AUTHORITY_FRESHNESS_FORK_DETECTED' || code === 'AUTHORITY_FRESHNESS_ROLLBACK_DETECTED' || code === 'AUTHORITY_FRESHNESS_BINDING_MISMATCH';
}

function contended(code: AuthorityStateFreshnessErrorCode): boolean {
  return code === 'AUTHORITY_FRESHNESS_CONFLICT' || code === 'AUTHORITY_FRESHNESS_PENDING_RECOVERY';
}

function unavailable(message: string): PaymentSettlementStoreError {
  return new PaymentSettlementStoreError('PAYMENT_SETTLEMENT_STORE_UNAVAILABLE', message);
}

function tableExists(db: import('better-sqlite3').Database, name: string): boolean {
  return db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) !== undefined;
}

function resolveOnDisk(path: string): string {
  const absolute = resolve(path);
  const parent = dirname(absolute);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
  return absolute;
}

/** A row back into an entry: decoded exactly; its key columns must restate it. Verification against the chain follows. */
function entryOf(row: Row): PaymentRefundEntry {
  if (typeof row['entry_json'] !== 'string') throw corruptLedger('an entry is not text');
  let entry: PaymentRefundEntry;
  try {
    entry = JSON.parse(row['entry_json']) as PaymentRefundEntry;
  } catch {
    throw corruptLedger('an entry does not decode');
  }
  if (entry === null || typeof entry !== 'object') throw corruptLedger('an entry is not a record');
  const original = entry.kind === 'reserve' ? entry.originalSettlementId : null;
  if (
    row['sequence'] !== entry.sequence ||
    row['kind'] !== entry.kind ||
    row['organization_id'] !== entry.organizationId ||
    row['refund_operation_id'] !== entry.refundOperationId ||
    row['original_settlement_id'] !== original ||
    row['entry_digest'] !== entry.entryDigest ||
    row['chain_digest'] !== entry.chainDigest
  ) {
    throw corruptLedger('the key columns disagree with an entry');
  }
  return entry;
}

export async function createSqlitePaymentRefundLedger(dbPath: string, options: CreateSqlitePaymentRefundLedgerOptions): Promise<DurablePaymentRefundLedger> {
  if (typeof dbPath !== 'string' || dbPath.trim().length === 0) throw unavailable('The refund accounting path must be a non-empty string.');
  if (typeof options?.now !== 'function') throw unavailable('The refund accounting requires an injected clock.');
  const boundary = options.freshness?.boundary;
  if (!isAuthorityStateFreshnessBoundary(boundary)) throw unavailable('The refund accounting is anchored at the CORE-07 witness and is never opened without its freshness boundary.');
  const busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
  if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs <= 0 || busyTimeoutMs > MAXIMUM_BUSY_TIMEOUT_MS) throw new RangeError(`busyTimeoutMs must be a positive integer of at most ${String(MAXIMUM_BUSY_TIMEOUT_MS)}.`);
  const now = options.now;
  const organizationId = boundary.organizationId;
  const { default: Database } = await import('better-sqlite3');

  const db = new Database(dbPath === ':memory:' ? ':memory:' : resolveOnDisk(dbPath));
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = FULL');
    db.pragma(`busy_timeout = ${busyTimeoutMs}`);
    // The version guard runs before any CREATE: a file under a schema this runtime does not implement is refused unmutated.
    if (tableExists(db, VERSIONS_TABLE)) {
      const latest = (db.prepare(`SELECT schema_version FROM ${VERSIONS_TABLE} ORDER BY id DESC LIMIT 1`).get() as { schema_version: unknown } | undefined)?.schema_version;
      if (latest !== PAYMENT_REFUND_LEDGER_SCHEMA_VERSION) throw unavailable(`The refund accounting is recorded under a schema version this runtime does not implement (expected '${PAYMENT_REFUND_LEDGER_SCHEMA_VERSION}'). Refusing to open it.`);
    } else if (tableExists(db, ENTRIES_TABLE) || tableExists(db, ANCHOR_TABLE)) {
      throw unavailable('The refund accounting holds tables but no schema version record. Refusing to open it.');
    }
    db.exec(SCHEMA);
    db.transaction(() => {
      if (db.prepare(`SELECT 1 FROM ${VERSIONS_TABLE} LIMIT 1`).get() === undefined) {
        const openedAt = now();
        if (!isCanonicalOutcomeInstant(openedAt)) throw unavailable('The store clock did not answer a canonical instant.');
        db.prepare(`INSERT INTO ${VERSIONS_TABLE} (schema_version, migration_state, recorded_at) VALUES (?, 'current', ?)`).run(PAYMENT_REFUND_LEDGER_SCHEMA_VERSION, openedAt);
      }
    }).immediate();
  } catch (error) {
    db.close();
    throw isPaymentSettlementStoreError(error) ? error : unavailable('The refund accounting could not be opened.');
  }

  const selectAnchor = db.prepare(`SELECT store_id, organization_id FROM ${ANCHOR_TABLE} WHERE id = 1`);
  const selectAfter = db.prepare(`SELECT sequence, kind, organization_id, refund_operation_id, original_settlement_id, entry_json, entry_digest, chain_digest FROM ${ENTRIES_TABLE} WHERE sequence > ? ORDER BY sequence ASC`);
  const selectOperation = db.prepare(`SELECT sequence, kind, organization_id, refund_operation_id, original_settlement_id, entry_json, entry_digest, chain_digest FROM ${ENTRIES_TABLE} WHERE organization_id = ? AND refund_operation_id = ? ORDER BY sequence ASC`);
  const selectOriginalOperations = db.prepare(`SELECT refund_operation_id FROM ${ENTRIES_TABLE} WHERE organization_id = ? AND original_settlement_id = ? AND kind = 'reserve'`);
  const countEntries = db.prepare(`SELECT COUNT(*) AS n FROM ${ENTRIES_TABLE}`);
  const countOutside = db.prepare(`SELECT COUNT(*) AS n FROM ${ENTRIES_TABLE} WHERE organization_id != ?`);
  const insertEntry = db.prepare(
    `INSERT INTO ${ENTRIES_TABLE} (sequence, kind, organization_id, refund_operation_id, original_settlement_id, entry_json, entry_digest, chain_digest)
     VALUES (@sequence, @kind, @organizationId, @refundOperationId, @originalSettlementId, @entryJson, @entryDigest, @chainDigest)`,
  );

  let anchor: { readonly storeId: string; readonly organizationId: string } | undefined;
  let session: AuthorityStateFreshnessSession | undefined;
  /**
   * The last verified head. Not a shortcut — every read still recomputes the whole chain — but a prefix this process
   * already accepted: the recomputed chain must pass through it, so a history replaced underneath a running process is
   * noticed at its next read even before the witness is consulted.
   */
  let verified: LedgerHead | undefined;
  let closed = false;
  let failedTransition: AuthorityStateFreshnessError | undefined;
  let writing: Promise<unknown> = Promise.resolve();

  function assertOpen(): void {
    if (closed) throw unavailable('The refund accounting has been closed.');
  }

  function genesis(): LedgerHead {
    if (anchor === undefined) throw unavailable('The refund accounting is not anchored.');
    return { sequence: 0, digest: paymentRefundGenesisDigest(anchor.storeId, anchor.organizationId) };
  }

  /**
   * The head, recomputed from genesis over **every** entry: each entry's digest from its content, each link of the chain
   * from its predecessor. Called inside the same SQLite transaction as every read of entries, so the rows a balance or a
   * decision consumes are exactly the rows just verified.
   */
  function currentHead(): LedgerHead {
    let { sequence, digest } = genesis();
    const accepted = verified;
    for (const row of selectAfter.all(0) as Row[]) {
      const entry = entryOf(row);
      const failure = paymentRefundEntryFailure(entry, sequence + 1, digest);
      if (failure !== undefined) throw corruptLedger(failure);
      if (entry.organizationId !== anchor?.organizationId) throw corruptLedger("the ledger holds another organization's entries");
      sequence = entry.sequence;
      digest = entry.chainDigest;
      if (accepted !== undefined && sequence === accepted.sequence && digest !== accepted.digest) throw corruptLedger('the history changed underneath this process');
    }
    if (accepted !== undefined && sequence < accepted.sequence) throw corruptLedger('the history changed underneath this process');
    if ((countEntries.get() as { n: unknown }).n !== sequence) throw corruptLedger('the chain does not account for every entry');
    verified = { sequence, digest };
    return { sequence, digest };
  }

  function checkpointOf(head: LedgerHead): AuthorityStateCheckpoint {
    if (anchor === undefined) throw unavailable('The refund accounting is not anchored.');
    return { stateKind: PAYMENT_REFUND_STATE_KIND, organizationId: anchor.organizationId, storeId: anchor.storeId, sequence: head.sequence, stateDigest: head.digest };
  }

  /** Local, synchronous: refuses when the history is older than, or forked from, what the witness established. */
  function observeFresh(): LedgerHead {
    const head = currentHead();
    session?.observe(checkpointOf(head));
    return head;
  }

  function requireOrganization(requested: string): void {
    if (!isOpaqueExecutionIdentifier(requested) || requested !== organizationId) {
      throw new PaymentSettlementStoreError('PAYMENT_SETTLEMENT_TENANT_VIOLATION', 'This refund accounting serves another organization.');
    }
  }

  function entriesOfOperation(refundOperationId: string): PaymentRefundEntry[] {
    return (selectOperation.all(organizationId, refundOperationId) as Row[]).map(entryOf);
  }

  function entriesOfOriginal(originalSettlementId: string): PaymentRefundEntry[] {
    const operations = (selectOriginalOperations.all(organizationId, originalSettlementId) as Row[]).map((row) => row['refund_operation_id'] as string);
    return operations.flatMap(entriesOfOperation).sort((left, right) => left.sequence - right.sequence);
  }

  function guarded<T>(work: () => T): T {
    try {
      return work();
    } catch (error) {
      if (isPaymentSettlementStoreError(error) || isAuthorityStateFreshnessError(error)) throw error;
      throw unavailable('The refund accounting could not complete the operation; nothing was written.');
    }
  }

  type Decision<R> = { readonly answer: R } | { readonly content: PaymentRefundEntryContent };

  /**
   * One anchored write: witness probe first (so nothing is decided over a
   * history the witness does not hold as current), a decision on the verified
   * head, then a CORE-07 transition whose local commit re-decides under
   * `BEGIN IMMEDIATE` and must reach the same decision on the same head.
   */
  async function anchoredWrite<R>(decide: () => Decision<R>, after: (entry: PaymentRefundEntry) => R): Promise<R> {
    const live = session;
    if (live === undefined) throw unavailable('The refund accounting is not anchored.');
    for (let attempt = 1; ; attempt += 1) {
      if (failedTransition !== undefined) throw failedTransition;
      try {
        assertOpen();
        const status = await live.probe();
        if (status.status !== 'ready') throw new AuthorityStateFreshnessError(status.reason ?? 'AUTHORITY_FRESHNESS_UNAVAILABLE', `The refund accounting's freshness is '${status.status}': nothing is reserved or released.`);
        const decided = guarded(() =>
          db.transaction(() => {
            const head = observeFresh();
            return { decision: decide(), head };
          })(),
        );
        if ('answer' in decided.decision) return decided.decision.answer;
        const prepared = decided.decision.content;
        const head = decided.head;
        const at = now();
        if (!isCanonicalOutcomeInstant(at)) throw unavailable('The store clock did not answer a canonical instant; nothing was written.');
        const entry = buildPaymentRefundEntry(prepared, head.sequence + 1, at, head.digest);
        const expected = checkpointOf(head);
        const proposed: AuthorityStateCheckpoint = { ...expected, sequence: entry.sequence, stateDigest: entry.chainDigest };
        try {
          return await live.transition(expected, proposed, () =>
            guarded(() =>
              db
                .transaction(() => {
                  const before = currentHead();
                  if (before.sequence !== head.sequence || before.digest !== head.digest) throw corruptLedger('the history moved under a prepared transition');
                  const again = decide();
                  if ('answer' in again || canonicalSerialize(again.content) !== canonicalSerialize(prepared)) throw corruptLedger('the decision changed under a prepared transition');
                  insertEntry.run({
                    sequence: entry.sequence,
                    kind: entry.kind,
                    organizationId: entry.organizationId,
                    refundOperationId: entry.refundOperationId,
                    originalSettlementId: entry.kind === 'reserve' ? entry.originalSettlementId : null,
                    entryJson: canonicalSerialize(entry),
                    entryDigest: entry.entryDigest,
                    chainDigest: entry.chainDigest,
                  });
                  const committed = currentHead();
                  return { value: after(entry), state: checkpointOf(committed) };
                })
                .immediate(),
            ),
          );
        } catch (error) {
          if (isAuthorityStateFreshnessError(error) && sticky(error.code)) failedTransition = error;
          throw error;
        }
      } catch (error) {
        if (isAuthorityStateFreshnessError(error) && contended(error.code) && failedTransition === undefined && attempt < ANCHORED_WRITE_ATTEMPTS) {
          await pause(ANCHORED_WRITE_BACKOFF_MS * attempt + Math.floor(Math.random() * ANCHORED_WRITE_BACKOFF_MS));
          continue;
        }
        throw error;
      }
    }
  }

  function serialized<T>(work: () => Promise<T>): Promise<T> {
    const result = writing.then(work);
    writing = result.catch(() => undefined);
    return result;
  }

  const ledger: DurablePaymentRefundLedger = {
    providerKind: 'sqlite',

    reserve(input: ReservePaymentRefundInput): Promise<ReservePaymentRefundResult> {
      return serialized(async () => {
        assertOpen();
        requireRefundReserveInput(input);
        requireOrganization(input.organizationId);
        return anchoredWrite<ReservePaymentRefundResult>(
          () => {
            const plan = planPaymentRefundReservation(input, entriesOfOriginal(input.originalSettlementId));
            return plan.kind === 'answer' ? { answer: plan.result } : { content: plan.content };
          },
          () => {
            const after = planPaymentRefundReservation(input, entriesOfOriginal(input.originalSettlementId));
            if (after.kind !== 'answer' || after.result.outcome !== 'existing') throw corruptLedger('a reservation did not take effect');
            return { ...after.result, outcome: 'reserved' };
          },
        );
      });
    },

    release(input: ReleasePaymentRefundInput): Promise<ReleasePaymentRefundResult> {
      return serialized(async () => {
        assertOpen();
        requireRefundReleaseInput(input);
        requireOrganization(input.organizationId);
        return anchoredWrite<ReleasePaymentRefundResult>(
          () => {
            const plan = planPaymentRefundRelease(input, entriesOfOperation(input.refundOperationId));
            return plan.kind === 'answer' ? { answer: plan.result } : { content: plan.content };
          },
          () => {
            const reservation = paymentRefundReservations(entriesOfOperation(input.refundOperationId))[0];
            if (reservation?.release === undefined) throw corruptLedger('a release did not take effect');
            return { outcome: 'released', reservation };
          },
        );
      });
    },

    async readOperation(requested: string, refundOperationId: string): Promise<PaymentRefundReservation | undefined> {
      assertOpen();
      requireOrganization(requested);
      return guarded(() =>
        db.transaction(() => {
          observeFresh();
          return paymentRefundReservations(entriesOfOperation(refundOperationId))[0];
        })(),
      );
    },

    async readBalance(requested: string, originalSettlementId: string, originalAmount: MonetaryAmount): Promise<PaymentRefundBalance> {
      assertOpen();
      requireOrganization(requested);
      return guarded(() =>
        db.transaction(() => {
          observeFresh();
          return paymentRefundBalance(originalSettlementId, paymentRefundReservations(entriesOfOriginal(originalSettlementId)), originalAmount);
        })(),
      );
    },

    async verifyAll(): Promise<{ readonly entries: number }> {
      assertOpen();
      return guarded(() =>
        db.transaction(() => {
          verified = undefined;
          const head = currentHead();
          if ((countOutside.get(organizationId) as { n: unknown }).n !== 0) throw corruptLedger("the ledger holds another organization's entries");
          paymentRefundReservations(((db.prepare(`SELECT sequence, kind, organization_id, refund_operation_id, original_settlement_id, entry_json, entry_digest, chain_digest FROM ${ENTRIES_TABLE} ORDER BY sequence ASC`).all() as Row[]).map(entryOf)));
          return { entries: head.sequence };
        })(),
      );
    },

    async health() {
      let readable = false;
      try {
        if (!closed) readable = (db.prepare(`SELECT schema_version FROM ${VERSIONS_TABLE} ORDER BY id DESC LIMIT 1`).get() as { schema_version: unknown } | undefined)?.schema_version === PAYMENT_REFUND_LEDGER_SCHEMA_VERSION;
      } catch {
        readable = false;
      }
      const freshness = session?.status().status ?? 'unbound';
      const writable = readable && !closed && !db.readonly && !isFailedAuthorityStateFreshnessStatus(freshness) && failedTransition === undefined;
      return { status: readable && writable ? 'healthy' : 'unhealthy', readable, writable, schemaVersion: PAYMENT_REFUND_LEDGER_SCHEMA_VERSION, freshness, checkedAt: now() };
    },

    async close(): Promise<void> {
      if (!closed) {
        closed = true;
        db.close();
      }
    },
  };

  try {
    const anchorRow = selectAnchor.get() as Row | undefined;
    if (anchorRow !== undefined) {
      const storeId = anchorRow['store_id'];
      const anchoredFor = anchorRow['organization_id'];
      if (typeof storeId !== 'string' || storeId.length === 0 || typeof anchoredFor !== 'string') throw corruptLedger('the anchor is malformed');
      if (anchoredFor !== organizationId) throw unavailable('The refund accounting is anchored for another organization than the freshness boundary serves. Refusing to open it.');
      anchor = { storeId, organizationId: anchoredFor };
    } else {
      if ((countEntries.get() as { n: unknown }).n !== 0) throw corruptLedger('entries exist with no anchor');
      // Genesis: enrolled at the witness before it is committed here. A witness that holds this slot beyond genesis refuses the
      // empty file — a lost ledger, or a stale restore of a never-used backup, never silently starts over at zero refunds.
      const storeId = await boundary.genesisStoreId(PAYMENT_REFUND_STATE_KIND, {
        newStoreId: () => `payment-refund-ledger:${randomUUID()}`,
        genesisDigest: (id) => paymentRefundGenesisDigest(id, organizationId),
      });
      guarded(() =>
        db
          .transaction(() => {
            const raced = selectAnchor.get() as Row | undefined;
            if (raced !== undefined) {
              if (raced['store_id'] !== storeId || raced['organization_id'] !== organizationId) throw corruptLedger('another process anchored this ledger differently');
            } else {
              const at = now();
              if (!isCanonicalOutcomeInstant(at)) throw unavailable('The store clock did not answer a canonical instant.');
              db.prepare(`INSERT INTO ${ANCHOR_TABLE} (id, store_id, organization_id, anchored_at) VALUES (1, ?, ?, ?)`).run(storeId, organizationId, at);
            }
          })
          .immediate(),
      );
      anchor = { storeId, organizationId };
    }
    await ledger.verifyAll();
    // CORE-07, before the ledger is handed to anything.
    session = await boundary.establish(checkpointOf(guarded(() => currentHead())), () => checkpointOf(guarded(() => currentHead())));
    markComposedUnderFreshness(ledger, boundary);
  } catch (error) {
    closed = true;
    db.close();
    throw error;
  }
  return Object.freeze(ledger);
}
