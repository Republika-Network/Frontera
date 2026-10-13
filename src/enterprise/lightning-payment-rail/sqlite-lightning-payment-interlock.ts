import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import {
  LIGHTNING_NETWORKS,
  isLightningNodePublicKey,
  isLightningPaymentHash,
  type LightningNetwork,
  type LightningPaymentInterlock,
  type LightningPaymentReservation,
  type LightningPaymentReservationInput,
} from '../../features/payment-runtime/rails/lightning/index.js';
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
import { computeDigest } from '../governance-store/digest.js';
import { isCanonicalOutcomeInstant, isOpaqueExecutionIdentifier } from '../execution-outcome-store/validation.js';

/**
 * PAY-06 — the durable Lightning payment interlock: SQLite, append-only,
 * hash-chained, and **always** anchored at the CORE-07 external witness.
 *
 * One row per governed execution that ever reached the send step, written
 * strictly **before** that execution's one `sendPayment` — the binding
 * between the execution and exactly one logical payment (payment hash,
 * payee, network, payer node identity, invoice digest, amount, fee cap,
 * expiry). Two `UNIQUE`
 * columns make the uniqueness rules durable: one row per execution, one row
 * per payment hash, ever. Nothing is updated or deleted (triggers refuse it);
 * there is no status column — P11, P12 and the node hold payment state.
 *
 * ```
 * open      version guard (before any CREATE) → schema → anchor (a new file is a genesis enrolled at the witness
 *           before it is written here) → every row verified, the chain recomputed → the history reconciled with the
 *           witness: older (rollback / stale restore), forked, a prepared reservation this file does not hold, an
 *           unreachable witness → refused, nothing is sent
 * reserve   witness probe → decide on the verified head (BEGIN IMMEDIATE, no write) → witness PREPARE the successor
 *           → BEGIN IMMEDIATE: head unchanged, decision unchanged, insert → FINALIZE. Durable and witnessed on return.
 * read      verified, and the head held against what the witness established (local, no network)
 * ```
 *
 * ## Why the witness (PAY-04's lesson)
 *
 * A local file cannot prove it is the newest one. A stale restore of this file
 * would lose exactly the reservations of payments already initiated — and a
 * governed path whose P11 claim was restored with it could then present the
 * same execution as new, or a second execution could take a payment hash an
 * earlier one already paid. The node's own duplicate-payment refusal is
 * defence in depth, not the guarantee. So the reservation history is anchored
 * at the witness, in the rail-neutral operational slot
 * `payment-initiation-reservations`, and a history older than the witness's is
 * refused at open — before anything is sent, whatever the node says. The
 * witness and this file must never be restored as one snapshot (CORE-07's
 * deployment prohibition).
 *
 * ## Integrity and freshness are two layers
 *
 * Every read recomputes every row's digest from its content and the chain
 * from genesis (integrity: these rows are exactly that history); the witness
 * holds the head (freshness: that history is the newest). A row rewritten
 * with its digest strings kept still matches the witness and is refused here.
 *
 * One Host per state volume; across processes on one volume the witness's
 * compare-and-advance and `BEGIN IMMEDIATE` decide, and exactly one process
 * reserves a given execution or payment hash.
 *
 * ## Schema v2: the payer node is part of the reservation
 *
 * v2 binds `payerNodeId` into every entry's canonical content — so into its
 * entry digest, the chain and the witnessed state digest. There is **no
 * migration** from v1 (the pre-merge PAY-06 shape, without a payer): a v1 file
 * is refused at open by the version guard, and a v1-shaped entry is refused by
 * the shape check. A payer is never inferred for an old reservation — reading
 * whichever node happens to be configured now would defeat the binding.
 */
export const LIGHTNING_INTERLOCK_SCHEMA_VERSION = 'aoc.lightning-payment-interlock.schema.v2';

/** The CORE-07 slot of the reservation history — rail-neutral by name (CORE names no Lightning concept). */
export const PAYMENT_INITIATION_STATE_KIND = 'payment-initiation-reservations';

const ENTRY_DOMAIN = 'aoc.lightning-payment-interlock.entry.v2';
const CHAIN_DOMAIN = 'aoc.lightning-payment-interlock.chain.v1';
const VERSIONS_TABLE = 'lightning_interlock_versions';
const ANCHOR_TABLE = 'lightning_interlock_anchor';
const ENTRIES_TABLE = 'lightning_payment_reservations';
const DEFAULT_BUSY_TIMEOUT_MS = 5_000;
const MAXIMUM_BUSY_TIMEOUT_MS = 60_000;
/** Bounded attempts when another writer wins the witness first: contention before any send — never a payment retry. */
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
    rail_id TEXT NOT NULL,
    network TEXT NOT NULL,
    anchored_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS ${ENTRIES_TABLE} (
    sequence INTEGER PRIMARY KEY,
    execution_id TEXT NOT NULL UNIQUE,
    payment_hash TEXT NOT NULL UNIQUE,
    entry_json TEXT NOT NULL,
    entry_digest TEXT NOT NULL,
    chain_digest TEXT NOT NULL
  );
  CREATE TRIGGER IF NOT EXISTS lightning_reservations_append_only_update BEFORE UPDATE ON ${ENTRIES_TABLE}
    BEGIN SELECT RAISE(ABORT, 'lightning payment reservations are append-only'); END;
  CREATE TRIGGER IF NOT EXISTS lightning_reservations_append_only_delete BEFORE DELETE ON ${ENTRIES_TABLE}
    BEGIN SELECT RAISE(ABORT, 'lightning payment reservations are append-only'); END;
  CREATE TRIGGER IF NOT EXISTS lightning_interlock_anchor_immutable BEFORE UPDATE ON ${ANCHOR_TABLE}
    BEGIN SELECT RAISE(ABORT, 'the lightning interlock anchor is immutable'); END;
  CREATE TRIGGER IF NOT EXISTS lightning_interlock_anchor_no_delete BEFORE DELETE ON ${ANCHOR_TABLE}
    BEGIN SELECT RAISE(ABORT, 'the lightning interlock anchor is immutable'); END;
`;

export type LightningInterlockStoreErrorCode = 'LIGHTNING_INTERLOCK_UNAVAILABLE' | 'LIGHTNING_INTERLOCK_CORRUPT' | 'LIGHTNING_INTERLOCK_INVALID';

/** Messages name the rule that failed, never a value. */
export class LightningInterlockStoreError extends Error {
  readonly code: LightningInterlockStoreErrorCode;

  constructor(code: LightningInterlockStoreErrorCode, message: string) {
    super(message);
    this.name = 'LightningInterlockStoreError';
    this.code = code;
  }
}

/** A reservation as recorded: the input, its sequence and when it was written (the store's clock — never part of any payment fact). */
export interface LightningPaymentReservationRecord extends LightningPaymentReservationInput {
  readonly sequence: number;
  readonly reservedAt: string;
}

export interface LightningInterlockHealth {
  readonly status: 'healthy' | 'unhealthy';
  readonly readable: boolean;
  readonly writable: boolean;
  readonly schemaVersion: string;
  readonly freshness: AuthorityStateFreshnessStatusValue | 'unbound';
  readonly reservations?: number;
}

export interface DurableLightningPaymentInterlock extends LightningPaymentInterlock {
  readonly providerKind: 'sqlite';
  /** The verified reservation of one execution, or `undefined`. What the P12 and finality authorities read. */
  read(executionId: string): Promise<LightningPaymentReservationRecord | undefined>;
  verifyAll(): Promise<{ readonly reservations: number }>;
  health(): Promise<LightningInterlockHealth>;
  close(): Promise<void>;
}

export interface CreateSqliteLightningPaymentInterlockOptions {
  /** The rail id and Lightning network this file is bound to. A file bound to another scope is refused unmutated. */
  readonly scope: { readonly railId: string; readonly network: LightningNetwork };
  readonly now: () => string;
  /** The CORE-07 boundary of the organization this interlock serves. Required: there is no unanchored durable mode. */
  readonly freshness: { readonly boundary: AuthorityStateFreshnessBoundary };
  readonly busyTimeoutMs?: number;
}

type Row = Readonly<Record<string, unknown>>;

interface Head {
  readonly sequence: number;
  readonly digest: string;
}

/** The canonical content of one entry — bigint amounts as decimal text. */
interface EntryContent {
  readonly sequence: number;
  readonly executionId: string;
  readonly paymentHash: string;
  readonly payee: string;
  readonly network: LightningNetwork;
  readonly payerNodeId: string;
  readonly invoiceDigest: string;
  readonly amountMsat: string;
  readonly feeLimitMsat: string;
  readonly expiresAt: number;
  readonly reservedAt: string;
}

const unavailable = (message: string): LightningInterlockStoreError => new LightningInterlockStoreError('LIGHTNING_INTERLOCK_UNAVAILABLE', message);
const corrupt = (rule: string): LightningInterlockStoreError => new LightningInterlockStoreError('LIGHTNING_INTERLOCK_CORRUPT', `The Lightning payment interlock failed its integrity check: ${rule}. It is refused, never repaired.`);
const invalid = (field: string): LightningInterlockStoreError => new LightningInterlockStoreError('LIGHTNING_INTERLOCK_INVALID', `The Lightning payment interlock refused a malformed '${field}'.`);

const pause = (ms: number): Promise<void> => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
const DECIMAL_MSAT = /^(?:0|[1-9][0-9]{0,18})$/;

function sticky(code: AuthorityStateFreshnessErrorCode): boolean {
  return code === 'AUTHORITY_FRESHNESS_PENDING_RECOVERY' || code === 'AUTHORITY_FRESHNESS_FORK_DETECTED' || code === 'AUTHORITY_FRESHNESS_ROLLBACK_DETECTED' || code === 'AUTHORITY_FRESHNESS_BINDING_MISMATCH';
}

function contended(code: AuthorityStateFreshnessErrorCode): boolean {
  return code === 'AUTHORITY_FRESHNESS_CONFLICT' || code === 'AUTHORITY_FRESHNESS_PENDING_RECOVERY';
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

function validateInput(record: LightningPaymentReservationInput): void {
  if (record === null || typeof record !== 'object') throw invalid('record');
  if (!isOpaqueExecutionIdentifier(record.executionId)) throw invalid('executionId');
  if (!isLightningPaymentHash(record.paymentHash)) throw invalid('paymentHash');
  if (!isLightningNodePublicKey(record.payee)) throw invalid('payee');
  if (!LIGHTNING_NETWORKS.includes(record.network)) throw invalid('network');
  if (!isLightningNodePublicKey(record.payerNodeId)) throw invalid('payerNodeId');
  // A SHA-256 digest: the same 32-byte lowercase-hex shape as a payment hash.
  if (!isLightningPaymentHash(record.invoiceDigest)) throw invalid('invoiceDigest');
  if (typeof record.amountMsat !== 'bigint' || record.amountMsat <= 0n || !DECIMAL_MSAT.test(record.amountMsat.toString())) throw invalid('amountMsat');
  if (typeof record.feeLimitMsat !== 'bigint' || record.feeLimitMsat < 0n || !DECIMAL_MSAT.test(record.feeLimitMsat.toString())) throw invalid('feeLimitMsat');
  if (!Number.isSafeInteger(record.expiresAt) || record.expiresAt <= 0) throw invalid('expiresAt');
}

function genesisDigest(storeId: string, organizationId: string, railId: string, network: string): string {
  return computeDigest({ domain: CHAIN_DOMAIN, storeId, organizationId, railId, network, sequence: 0 });
}

function entryDigestOf(content: EntryContent): string {
  return computeDigest({ domain: ENTRY_DOMAIN, ...content });
}

function chainDigestOf(previous: string, entryDigest: string): string {
  return computeDigest({ domain: CHAIN_DOMAIN, previous, entryDigest });
}

function recordOf(content: EntryContent): LightningPaymentReservationRecord {
  return Object.freeze({
    executionId: content.executionId,
    paymentHash: content.paymentHash,
    payee: content.payee,
    network: content.network,
    payerNodeId: content.payerNodeId,
    invoiceDigest: content.invoiceDigest,
    amountMsat: BigInt(content.amountMsat),
    feeLimitMsat: BigInt(content.feeLimitMsat),
    expiresAt: content.expiresAt,
    sequence: content.sequence,
    reservedAt: content.reservedAt,
  });
}

/** Opens (or creates) the interlock file, verifying it completely and reconciling it with the witness before returning. */
export async function createSqliteLightningPaymentInterlock(dbPath: string, options: CreateSqliteLightningPaymentInterlockOptions): Promise<DurableLightningPaymentInterlock> {
  if (typeof dbPath !== 'string' || dbPath.trim().length === 0) throw unavailable('The Lightning payment interlock path must be a non-empty string.');
  if (typeof options?.now !== 'function') throw unavailable('The Lightning payment interlock requires an injected clock.');
  const boundary = options.freshness?.boundary;
  if (!isAuthorityStateFreshnessBoundary(boundary)) throw unavailable('The Lightning payment interlock is anchored at the CORE-07 witness and is never opened without its freshness boundary.');
  const scope = options.scope;
  if (typeof scope?.railId !== 'string' || scope.railId.length === 0 || scope.railId.length > 128 || !LIGHTNING_NETWORKS.includes(scope.network)) throw unavailable('The Lightning payment interlock requires its rail id and network scope.');
  const busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
  if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs <= 0 || busyTimeoutMs > MAXIMUM_BUSY_TIMEOUT_MS) throw unavailable(`The Lightning payment interlock busy timeout must be an integer from 1 to ${MAXIMUM_BUSY_TIMEOUT_MS}.`);
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
      if (latest !== LIGHTNING_INTERLOCK_SCHEMA_VERSION) throw unavailable(`The Lightning payment interlock is recorded under a schema version this runtime does not implement (expected '${LIGHTNING_INTERLOCK_SCHEMA_VERSION}'). Refusing to open it.`);
    } else if (tableExists(db, ENTRIES_TABLE) || tableExists(db, ANCHOR_TABLE)) {
      throw unavailable('The Lightning payment interlock holds tables but no schema version record. Refusing to open it.');
    }
    db.exec(SCHEMA);
    db.transaction(() => {
      if (db.prepare(`SELECT 1 FROM ${VERSIONS_TABLE} LIMIT 1`).get() === undefined) {
        const openedAt = now();
        if (!isCanonicalOutcomeInstant(openedAt)) throw unavailable('The interlock clock did not answer a canonical instant.');
        db.prepare(`INSERT INTO ${VERSIONS_TABLE} (schema_version, migration_state, recorded_at) VALUES (?, 'current', ?)`).run(LIGHTNING_INTERLOCK_SCHEMA_VERSION, openedAt);
      }
    }).immediate();
  } catch (error) {
    db.close();
    throw error instanceof LightningInterlockStoreError ? error : unavailable('The Lightning payment interlock could not be opened.');
  }

  const selectAnchor = db.prepare(`SELECT store_id, organization_id, rail_id, network FROM ${ANCHOR_TABLE} WHERE id = 1`);
  const selectAll = db.prepare(`SELECT sequence, execution_id, payment_hash, entry_json, entry_digest, chain_digest FROM ${ENTRIES_TABLE} ORDER BY sequence ASC`);
  const selectByExecution = db.prepare(`SELECT sequence, execution_id, payment_hash, entry_json, entry_digest, chain_digest FROM ${ENTRIES_TABLE} WHERE execution_id = ?`);
  const selectByPaymentHash = db.prepare(`SELECT sequence FROM ${ENTRIES_TABLE} WHERE payment_hash = ?`);
  const countEntries = db.prepare(`SELECT COUNT(*) AS n FROM ${ENTRIES_TABLE}`);
  const insertEntry = db.prepare(
    `INSERT INTO ${ENTRIES_TABLE} (sequence, execution_id, payment_hash, entry_json, entry_digest, chain_digest) VALUES (@sequence, @executionId, @paymentHash, @entryJson, @entryDigest, @chainDigest)`,
  );

  let anchor: { readonly storeId: string } | undefined;
  let session: AuthorityStateFreshnessSession | undefined;
  let verified: Head | undefined;
  let closed = false;
  let failedTransition: AuthorityStateFreshnessError | undefined;
  let writing: Promise<unknown> = Promise.resolve();

  const assertOpen = (): void => {
    if (closed) throw unavailable('The Lightning payment interlock has been closed.');
  };

  function genesis(): Head {
    if (anchor === undefined) throw unavailable('The Lightning payment interlock is not anchored.');
    return { sequence: 0, digest: genesisDigest(anchor.storeId, organizationId, scope.railId, scope.network) };
  }

  /** One row back into its content: decoded exactly, its key columns restating it, its digest recomputed from the content. */
  function contentOf(row: Row, expectedSequence: number, previousChain: string): EntryContent {
    if (typeof row['entry_json'] !== 'string') throw corrupt('an entry is not text');
    let content: EntryContent;
    try {
      content = JSON.parse(row['entry_json']) as EntryContent;
    } catch {
      throw corrupt('an entry does not decode');
    }
    if (content === null || typeof content !== 'object' || canonicalSerialize(content) !== row['entry_json']) throw corrupt('an entry is not canonical');
    const keys = Object.keys(content).sort().join(',');
    if (keys !== 'amountMsat,executionId,expiresAt,feeLimitMsat,invoiceDigest,network,payee,payerNodeId,paymentHash,reservedAt,sequence') throw corrupt('an entry has another shape');
    if (content.sequence !== expectedSequence || row['sequence'] !== expectedSequence) throw corrupt('the sequence is not contiguous');
    if (row['execution_id'] !== content.executionId || row['payment_hash'] !== content.paymentHash) throw corrupt('the key columns disagree with an entry');
    if (typeof content.amountMsat !== 'string' || !DECIMAL_MSAT.test(content.amountMsat) || typeof content.feeLimitMsat !== 'string' || !DECIMAL_MSAT.test(content.feeLimitMsat)) throw corrupt('an amount is malformed');
    try {
      validateInput(recordOf(content));
    } catch {
      throw corrupt('an entry holds a malformed field');
    }
    if (content.network !== scope.network) throw corrupt('an entry names another network');
    if (!isCanonicalOutcomeInstant(content.reservedAt)) throw corrupt('an entry instant is malformed');
    const entryDigest = entryDigestOf(content);
    if (row['entry_digest'] !== entryDigest) throw corrupt('an entry digest does not match its content');
    if (row['chain_digest'] !== chainDigestOf(previousChain, entryDigest)) throw corrupt('the chain is broken');
    return content;
  }

  /** The head, recomputed from genesis over every row, inside the caller's transaction. Returns every verified entry too. */
  function verifiedHistory(): { readonly head: Head; readonly entries: readonly EntryContent[] } {
    let head = genesis();
    const entries: EntryContent[] = [];
    const accepted = verified;
    for (const row of selectAll.all() as Row[]) {
      const content = contentOf(row, head.sequence + 1, head.digest);
      head = { sequence: content.sequence, digest: row['chain_digest'] as string };
      entries.push(content);
      if (accepted !== undefined && head.sequence === accepted.sequence && head.digest !== accepted.digest) throw corrupt('the history changed underneath this process');
    }
    if (accepted !== undefined && head.sequence < accepted.sequence) throw corrupt('the history changed underneath this process');
    if ((countEntries.get() as { n: unknown }).n !== head.sequence) throw corrupt('the chain does not account for every row');
    verified = head;
    return { head, entries };
  }

  function checkpointOf(head: Head): AuthorityStateCheckpoint {
    if (anchor === undefined) throw unavailable('The Lightning payment interlock is not anchored.');
    return { stateKind: PAYMENT_INITIATION_STATE_KIND, organizationId, storeId: anchor.storeId, sequence: head.sequence, stateDigest: head.digest };
  }

  /** Local, synchronous: refuses when the history is older than, or forked from, what the witness established. */
  function observeFresh(): { readonly head: Head; readonly entries: readonly EntryContent[] } {
    const history = verifiedHistory();
    session?.observe(checkpointOf(history.head));
    return history;
  }

  function guarded<T>(work: () => T): T {
    try {
      return work();
    } catch (error) {
      if (error instanceof LightningInterlockStoreError || isAuthorityStateFreshnessError(error)) throw error;
      throw unavailable('The Lightning payment interlock could not complete the operation; nothing was written.');
    }
  }

  type Decision = { readonly answer: LightningPaymentReservation } | { readonly insert: true };

  function decide(record: LightningPaymentReservationInput, entries: readonly EntryContent[]): Decision {
    const existing = entries.find((entry) => entry.executionId === record.executionId);
    if (existing !== undefined) return { answer: { outcome: 'execution-recorded', record: recordOf(existing) } };
    if (entries.some((entry) => entry.paymentHash === record.paymentHash)) return { answer: { outcome: 'payment-hash-reserved' } };
    return { insert: true };
  }

  /** One anchored reservation — a CORE-07 transition whose local commit re-decides under `BEGIN IMMEDIATE` on the same head. */
  async function reserveAnchored(record: LightningPaymentReservationInput): Promise<LightningPaymentReservation> {
    const live = session;
    if (live === undefined) throw unavailable('The Lightning payment interlock is not anchored.');
    for (let attempt = 1; ; attempt += 1) {
      if (failedTransition !== undefined) throw failedTransition;
      try {
        assertOpen();
        // CORE-07, before every reservation — and so before every send: unreachable, ahead of this file, or failed → refused.
        const status = await live.probe();
        if (status.status !== 'ready') throw new AuthorityStateFreshnessError(status.reason ?? 'AUTHORITY_FRESHNESS_UNAVAILABLE', `The Lightning reservation history's freshness is '${status.status}': nothing is reserved, so nothing is sent.`);
        const decided = guarded(() =>
          db.transaction(() => {
            const history = observeFresh();
            return { decision: decide(record, history.entries), head: history.head };
          })(),
        );
        if ('answer' in decided.decision) return decided.decision.answer;
        const head = decided.head;
        const reservedAt = now();
        if (!isCanonicalOutcomeInstant(reservedAt)) throw unavailable('The interlock clock did not answer a canonical instant; nothing was reserved.');
        const content: EntryContent = {
          sequence: head.sequence + 1,
          executionId: record.executionId,
          paymentHash: record.paymentHash,
          payee: record.payee,
          network: record.network,
          payerNodeId: record.payerNodeId,
          invoiceDigest: record.invoiceDigest,
          amountMsat: record.amountMsat.toString(),
          feeLimitMsat: record.feeLimitMsat.toString(),
          expiresAt: record.expiresAt,
          reservedAt,
        };
        const entryDigest = entryDigestOf(content);
        const chainDigest = chainDigestOf(head.digest, entryDigest);
        const expected = checkpointOf(head);
        const proposed: AuthorityStateCheckpoint = { ...expected, sequence: content.sequence, stateDigest: chainDigest };
        try {
          return await live.transition(expected, proposed, () =>
            guarded(() =>
              db
                .transaction(() => {
                  const before = verifiedHistory();
                  if (before.head.sequence !== head.sequence || before.head.digest !== head.digest) throw corrupt('the history moved under a prepared reservation');
                  if ('answer' in decide(record, before.entries)) throw corrupt('the decision changed under a prepared reservation');
                  insertEntry.run({ sequence: content.sequence, executionId: content.executionId, paymentHash: content.paymentHash, entryJson: canonicalSerialize(content), entryDigest, chainDigest });
                  const committed = verifiedHistory();
                  return { value: { outcome: 'reserved' } as LightningPaymentReservation, state: checkpointOf(committed.head) };
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

  function readOne(executionId: string): LightningPaymentReservationRecord | undefined {
    const { entries } = observeFresh();
    const row = selectByExecution.get(executionId) as Row | undefined;
    const found = entries.find((entry) => entry.executionId === executionId);
    // The indexed row and the verified history must agree: a row reachable by key but absent from the chain (or the reverse) is corruption.
    if ((row === undefined) !== (found === undefined)) throw corrupt('the execution index disagrees with the history');
    return found === undefined ? undefined : recordOf(found);
  }

  const store: DurableLightningPaymentInterlock = {
    providerKind: 'sqlite',

    async recorded(executionId: string): Promise<LightningPaymentReservationInput | undefined> {
      assertOpen();
      if (!isOpaqueExecutionIdentifier(executionId)) throw invalid('executionId');
      return guarded(() => db.transaction(() => readOne(executionId))());
    },

    reserve(record: LightningPaymentReservationInput): Promise<LightningPaymentReservation> {
      const result = writing.then(async () => {
        assertOpen();
        validateInput(record);
        if (record.network !== scope.network) throw invalid('network');
        return reserveAnchored(record);
      });
      writing = result.catch(() => undefined);
      return result;
    },

    async read(executionId: string): Promise<LightningPaymentReservationRecord | undefined> {
      assertOpen();
      if (!isOpaqueExecutionIdentifier(executionId)) return undefined;
      return guarded(() => db.transaction(() => readOne(executionId))());
    },

    async verifyAll(): Promise<{ readonly reservations: number }> {
      assertOpen();
      return guarded(() =>
        db.transaction(() => {
          verified = undefined;
          const { head, entries } = verifiedHistory();
          for (const entry of entries) {
            if ((selectByPaymentHash.get(entry.paymentHash) as { sequence: unknown } | undefined)?.sequence !== entry.sequence) throw corrupt('the payment-hash index disagrees with the history');
          }
          return { reservations: head.sequence };
        })(),
      );
    },

    async health(): Promise<LightningInterlockHealth> {
      let readable = false;
      let reservations: number | undefined;
      try {
        if (!closed) {
          reservations = guarded(() => db.transaction(() => verifiedHistory().head.sequence)());
          readable = true;
        }
      } catch {
        readable = false;
      }
      const freshness = session?.status().status ?? 'unbound';
      const writable = readable && !closed && !db.readonly && freshness !== 'unbound' && !isFailedAuthorityStateFreshnessStatus(freshness) && failedTransition === undefined;
      return { status: readable && writable ? 'healthy' : 'unhealthy', readable, writable, schemaVersion: LIGHTNING_INTERLOCK_SCHEMA_VERSION, freshness, ...(reservations !== undefined ? { reservations } : {}) };
    },

    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      // Never clears anything: a reservation outlives every shutdown.
      db.close();
    },
  };

  try {
    const anchorRow = selectAnchor.get() as Row | undefined;
    if (anchorRow !== undefined) {
      const storeId = anchorRow['store_id'];
      if (typeof storeId !== 'string' || storeId.length === 0) throw corrupt('the anchor is malformed');
      if (anchorRow['organization_id'] !== organizationId) throw unavailable('The Lightning payment interlock is anchored for another organization than the freshness boundary serves. Refusing to open it.');
      if (anchorRow['rail_id'] !== scope.railId || anchorRow['network'] !== scope.network) throw unavailable('The Lightning payment interlock is bound to another rail or Lightning network than the one configured. Refusing to open it.');
      anchor = { storeId };
    } else {
      if ((countEntries.get() as { n: unknown }).n !== 0) throw corrupt('reservations exist with no anchor');
      // Genesis: enrolled at the witness before it is committed here. A witness that holds this slot beyond genesis refuses
      // the empty file — a lost interlock, or a stale restore of a never-used backup, never silently starts over.
      const storeId = await boundary.genesisStoreId(PAYMENT_INITIATION_STATE_KIND, {
        newStoreId: () => `lightning-payment-interlock:${randomUUID()}`,
        genesisDigest: (id) => genesisDigest(id, organizationId, scope.railId, scope.network),
      });
      guarded(() =>
        db
          .transaction(() => {
            const raced = selectAnchor.get() as Row | undefined;
            if (raced !== undefined) {
              if (raced['store_id'] !== storeId || raced['organization_id'] !== organizationId || raced['rail_id'] !== scope.railId || raced['network'] !== scope.network) throw corrupt('another process anchored this interlock differently');
            } else {
              const at = now();
              if (!isCanonicalOutcomeInstant(at)) throw unavailable('The interlock clock did not answer a canonical instant.');
              db.prepare(`INSERT INTO ${ANCHOR_TABLE} (id, store_id, organization_id, rail_id, network, anchored_at) VALUES (1, ?, ?, ?, ?, ?)`).run(storeId, organizationId, scope.railId, scope.network, at);
            }
          })
          .immediate(),
      );
      anchor = { storeId };
    }
    await store.verifyAll();
    // CORE-07, before the interlock is handed to anything.
    session = await boundary.establish(checkpointOf(guarded(() => verifiedHistory().head)), () => checkpointOf(guarded(() => verifiedHistory().head)));
    markComposedUnderFreshness(store, boundary);
  } catch (error) {
    closed = true;
    db.close();
    throw error;
  }
  return Object.freeze(store);
}
