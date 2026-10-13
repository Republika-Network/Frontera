import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import {
  STRIPE_CURRENCIES,
  STRIPE_MODES,
  centsOfUsdDecimal,
  isStripeAccountId,
  isStripeCustomerId,
  isStripePaymentIntentId,
  isStripePaymentMethodId,
  type StripeMode,
  type StripePaymentBinding,
  type StripePaymentInterlock,
  type StripePaymentReservation,
  type StripePaymentReservationInput,
  type StripePaymentReservationRecord,
} from '../../features/payment-runtime/rails/stripe/index.js';
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
 * PAY-09 — the durable Stripe payment interlock: SQLite, append-only,
 * hash-chained, and **always** anchored at the CORE-07 external witness.
 *
 * Two kinds of entry, in one chain, both written strictly **before** the one
 * money-moving request of an execution:
 *
 * - `reservation` — written before anything exists at Stripe: the execution
 *   and every term of its payment (the platform account the credential proved
 *   to be, the governed source and its Stripe Customer and PaymentMethod, the
 *   connected account, the canonical amount and its cents, the currency, the
 *   mode, both idempotency keys);
 * - `binding` — written after the PaymentIntent was created (`confirm=false`,
 *   so it cannot have charged) and before it is confirmed: the execution ↔ the
 *   PaymentIntent id.
 *
 * `UNIQUE (execution_id, kind)` and `UNIQUE (payment_intent_id)` make the
 * rules durable: one reservation and one binding per execution, one execution
 * per PaymentIntent, ever. Nothing is updated or deleted (triggers refuse it);
 * there is no status column — P11, P12 and Stripe hold payment state.
 *
 * ```
 * open      version guard (before any CREATE) → schema → anchor (a new file is a genesis enrolled at the witness before
 *           it is written here; bound to the organization, rail, mode and platform account) → every row verified, the
 *           chain recomputed from genesis → the history reconciled with the witness: older (rollback / stale restore),
 *           forked, a prepared write this file does not hold, an unreachable witness → refused, nothing is created
 * write     witness probe → decide on the verified head (no write) → witness PREPARE the successor → BEGIN IMMEDIATE:
 *           full history re-verified, head unchanged, decision unchanged, insert → FINALIZE. Durable and witnessed on return.
 * read      the full history verified, its head held against what the witness established (local, no network)
 * ```
 *
 * ## The CORE-07 slot
 *
 * The rail-neutral operational slot `payment-initiation-reservations` (PAY-06):
 * "the append-only history that binds each governed execution to the one
 * rail-level payment it may initiate". PAY-09 adds no slot and changes no CORE
 * byte. A witness keeps **one** store per slot per organization, so one
 * organization composes one payment-initiation interlock — a Stripe interlock
 * opened where a Lightning interlock already holds the slot is refused at
 * genesis (fail closed, `pay09-stripe-interlock.test.ts`). That is a residual,
 * not a safety gap.
 *
 * ## Integrity: always from genesis
 *
 * Every read and every write decision recomputes every row's digest from its
 * content and the whole chain from genesis (PAY-06's pattern — not PAY-04's
 * cached head). The witness holds the head (freshness). A row rewritten with
 * its digests kept still matches the witness and is refused here.
 *
 * One Host per state volume; across processes on one volume the witness's
 * compare-and-advance and `BEGIN IMMEDIATE` decide.
 */
export const STRIPE_INTERLOCK_SCHEMA_VERSION = 'aoc.stripe-payment-interlock.schema.v1';

/** The CORE-07 slot — rail-neutral by name (PAY-06's). CORE names no Stripe concept. */
export const PAYMENT_INITIATION_STATE_KIND = 'payment-initiation-reservations';

const RESERVATION_DOMAIN = 'aoc.stripe-payment-interlock.reservation.v1';
const BINDING_DOMAIN = 'aoc.stripe-payment-interlock.binding.v1';
const CHAIN_DOMAIN = 'aoc.stripe-payment-interlock.chain.v1';
const VERSIONS_TABLE = 'stripe_interlock_versions';
const ANCHOR_TABLE = 'stripe_interlock_anchor';
const ENTRIES_TABLE = 'stripe_payment_entries';
const DEFAULT_BUSY_TIMEOUT_MS = 5_000;
const MAXIMUM_BUSY_TIMEOUT_MS = 60_000;
/** Bounded attempts when another writer wins the witness first: contention before any money-moving request — never a payment retry. */
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
    mode TEXT NOT NULL,
    platform_account_id TEXT NOT NULL,
    anchored_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS ${ENTRIES_TABLE} (
    sequence INTEGER PRIMARY KEY,
    execution_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('reservation', 'binding')),
    payment_intent_id TEXT UNIQUE,
    entry_json TEXT NOT NULL,
    entry_digest TEXT NOT NULL,
    chain_digest TEXT NOT NULL,
    UNIQUE (execution_id, kind)
  );
  CREATE TRIGGER IF NOT EXISTS stripe_entries_append_only_update BEFORE UPDATE ON ${ENTRIES_TABLE}
    BEGIN SELECT RAISE(ABORT, 'stripe payment entries are append-only'); END;
  CREATE TRIGGER IF NOT EXISTS stripe_entries_append_only_delete BEFORE DELETE ON ${ENTRIES_TABLE}
    BEGIN SELECT RAISE(ABORT, 'stripe payment entries are append-only'); END;
  CREATE TRIGGER IF NOT EXISTS stripe_interlock_anchor_immutable BEFORE UPDATE ON ${ANCHOR_TABLE}
    BEGIN SELECT RAISE(ABORT, 'the stripe interlock anchor is immutable'); END;
  CREATE TRIGGER IF NOT EXISTS stripe_interlock_anchor_no_delete BEFORE DELETE ON ${ANCHOR_TABLE}
    BEGIN SELECT RAISE(ABORT, 'the stripe interlock anchor is immutable'); END;
`;

export type StripeInterlockStoreErrorCode = 'STRIPE_INTERLOCK_UNAVAILABLE' | 'STRIPE_INTERLOCK_CORRUPT' | 'STRIPE_INTERLOCK_INVALID';

/** Messages name the rule that failed, never a value. */
export class StripeInterlockStoreError extends Error {
  readonly code: StripeInterlockStoreErrorCode;

  constructor(code: StripeInterlockStoreErrorCode, message: string) {
    super(message);
    this.name = 'StripeInterlockStoreError';
    this.code = code;
  }
}

/** A record as stored: the reservation, its binding when there is one, and when each was written (the store's clock — never a payment fact). */
export interface StripePaymentInterlockRecord extends StripePaymentReservationRecord {
  readonly reservedAt: string;
  readonly boundAt?: string;
}

export interface StripeInterlockHealth {
  readonly status: 'healthy' | 'unhealthy';
  readonly readable: boolean;
  readonly writable: boolean;
  readonly schemaVersion: string;
  readonly freshness: AuthorityStateFreshnessStatusValue | 'unbound';
  readonly entries?: number;
}

export interface DurableStripePaymentInterlock extends StripePaymentInterlock {
  readonly providerKind: 'sqlite';
  /** The verified record of one execution, or `undefined`. What the P12 and finality authorities read. */
  read(executionId: string): Promise<StripePaymentInterlockRecord | undefined>;
  /** The execution a PaymentIntent is bound to, or `undefined` — for the webhook signal boundary. Read only. */
  executionOfPaymentIntent(paymentIntentId: string): Promise<string | undefined>;
  verifyAll(): Promise<{ readonly entries: number }>;
  health(): Promise<StripeInterlockHealth>;
  close(): Promise<void>;
}

export interface CreateSqliteStripePaymentInterlockOptions {
  /** The rail id, mode and platform account this file is bound to. A file bound to another scope is refused unmutated. */
  readonly scope: { readonly railId: string; readonly mode: StripeMode; readonly platformAccountId: string };
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

/** The canonical content of a reservation — cents as decimal text. */
interface ReservationContent {
  readonly sequence: number;
  readonly kind: 'reservation';
  readonly executionId: string;
  readonly railId: string;
  readonly mode: StripeMode;
  readonly platformAccountId: string;
  readonly sourceAccountId: string;
  readonly customerId: string;
  readonly paymentMethodId: string;
  readonly destinationAccountId: string;
  readonly amountValue: string;
  readonly amountUnit: string;
  readonly amountCents: string;
  readonly currency: string;
  readonly createIdempotencyKey: string;
  readonly confirmIdempotencyKey: string;
  readonly recordedAt: string;
}

interface BindingContent {
  readonly sequence: number;
  readonly kind: 'binding';
  readonly executionId: string;
  readonly paymentIntentId: string;
  readonly recordedAt: string;
}

type EntryContent = ReservationContent | BindingContent;

const RESERVATION_KEYS = 'amountCents,amountUnit,amountValue,confirmIdempotencyKey,createIdempotencyKey,currency,customerId,destinationAccountId,executionId,kind,mode,paymentMethodId,platformAccountId,railId,recordedAt,sequence,sourceAccountId';
const BINDING_KEYS = 'executionId,kind,paymentIntentId,recordedAt,sequence';

const unavailable = (message: string): StripeInterlockStoreError => new StripeInterlockStoreError('STRIPE_INTERLOCK_UNAVAILABLE', message);
const corrupt = (rule: string): StripeInterlockStoreError => new StripeInterlockStoreError('STRIPE_INTERLOCK_CORRUPT', `The Stripe payment interlock failed its integrity check: ${rule}. It is refused, never repaired.`);
const invalid = (field: string): StripeInterlockStoreError => new StripeInterlockStoreError('STRIPE_INTERLOCK_INVALID', `The Stripe payment interlock refused a malformed '${field}'.`);

const pause = (ms: number): Promise<void> => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
const DECIMAL_CENTS = /^[1-9][0-9]{0,17}$/;
const IDEMPOTENCY_KEY = /^frontera:[A-Za-z0-9._:@+=-]{1,246}$/;

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

function genesisDigest(storeId: string, organizationId: string, railId: string, mode: string, platformAccountId: string): string {
  return computeDigest({ domain: CHAIN_DOMAIN, storeId, organizationId, railId, mode, platformAccountId, sequence: 0 });
}

function entryDigestOf(content: EntryContent): string {
  return computeDigest({ domain: content.kind === 'reservation' ? RESERVATION_DOMAIN : BINDING_DOMAIN, ...content });
}

function chainDigestOf(previous: string, entryDigest: string): string {
  return computeDigest({ domain: CHAIN_DOMAIN, previous, entryDigest });
}

/** Opens (or creates) the interlock file, verifying it completely and reconciling it with the witness before returning. */
export async function createSqliteStripePaymentInterlock(dbPath: string, options: CreateSqliteStripePaymentInterlockOptions): Promise<DurableStripePaymentInterlock> {
  if (typeof dbPath !== 'string' || dbPath.trim().length === 0) throw unavailable('The Stripe payment interlock path must be a non-empty string.');
  if (typeof options?.now !== 'function') throw unavailable('The Stripe payment interlock requires an injected clock.');
  const boundary = options.freshness?.boundary;
  if (!isAuthorityStateFreshnessBoundary(boundary)) throw unavailable('The Stripe payment interlock is anchored at the CORE-07 witness and is never opened without its freshness boundary.');
  const scope = options.scope;
  if (typeof scope?.railId !== 'string' || scope.railId.length === 0 || scope.railId.length > 128 || !(STRIPE_MODES as readonly unknown[]).includes(scope.mode) || !isStripeAccountId(scope.platformAccountId)) {
    throw unavailable('The Stripe payment interlock requires its rail id, mode and platform account scope.');
  }
  const busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
  if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs <= 0 || busyTimeoutMs > MAXIMUM_BUSY_TIMEOUT_MS) throw unavailable(`The Stripe payment interlock busy timeout must be an integer from 1 to ${MAXIMUM_BUSY_TIMEOUT_MS}.`);
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
      if (latest !== STRIPE_INTERLOCK_SCHEMA_VERSION) throw unavailable(`The Stripe payment interlock is recorded under a schema version this runtime does not implement (expected '${STRIPE_INTERLOCK_SCHEMA_VERSION}'). Refusing to open it.`);
    } else if (tableExists(db, ENTRIES_TABLE) || tableExists(db, ANCHOR_TABLE)) {
      throw unavailable('The Stripe payment interlock holds tables but no schema version record. Refusing to open it.');
    }
    db.exec(SCHEMA);
    db.transaction(() => {
      if (db.prepare(`SELECT 1 FROM ${VERSIONS_TABLE} LIMIT 1`).get() === undefined) {
        const openedAt = now();
        if (!isCanonicalOutcomeInstant(openedAt)) throw unavailable('The interlock clock did not answer a canonical instant.');
        db.prepare(`INSERT INTO ${VERSIONS_TABLE} (schema_version, migration_state, recorded_at) VALUES (?, 'current', ?)`).run(STRIPE_INTERLOCK_SCHEMA_VERSION, openedAt);
      }
    }).immediate();
  } catch (error) {
    db.close();
    throw error instanceof StripeInterlockStoreError ? error : unavailable('The Stripe payment interlock could not be opened.');
  }

  const selectAnchor = db.prepare(`SELECT store_id, organization_id, rail_id, mode, platform_account_id FROM ${ANCHOR_TABLE} WHERE id = 1`);
  const selectAll = db.prepare(`SELECT sequence, execution_id, kind, payment_intent_id, entry_json, entry_digest, chain_digest FROM ${ENTRIES_TABLE} ORDER BY sequence ASC`);
  const countEntries = db.prepare(`SELECT COUNT(*) AS n FROM ${ENTRIES_TABLE}`);
  const selectIndexed = db.prepare(`SELECT sequence FROM ${ENTRIES_TABLE} WHERE execution_id = ? AND kind = ?`);
  const selectByPaymentIntent = db.prepare(`SELECT sequence FROM ${ENTRIES_TABLE} WHERE payment_intent_id = ?`);
  const insertEntry = db.prepare(
    `INSERT INTO ${ENTRIES_TABLE} (sequence, execution_id, kind, payment_intent_id, entry_json, entry_digest, chain_digest) VALUES (@sequence, @executionId, @kind, @paymentIntentId, @entryJson, @entryDigest, @chainDigest)`,
  );

  let anchor: { readonly storeId: string } | undefined;
  let session: AuthorityStateFreshnessSession | undefined;
  let verified: Head | undefined;
  let closed = false;
  let failedTransition: AuthorityStateFreshnessError | undefined;
  let writing: Promise<unknown> = Promise.resolve();

  const assertOpen = (): void => {
    if (closed) throw unavailable('The Stripe payment interlock has been closed.');
  };

  function genesis(): Head {
    if (anchor === undefined) throw unavailable('The Stripe payment interlock is not anchored.');
    return { sequence: 0, digest: genesisDigest(anchor.storeId, organizationId, scope.railId, scope.mode, scope.platformAccountId) };
  }

  function reservationProblem(content: Omit<ReservationContent, 'sequence' | 'recordedAt'>): string | undefined {
    if (!isOpaqueExecutionIdentifier(content.executionId)) return 'executionId';
    if (content.railId !== scope.railId) return 'railId';
    if (content.mode !== scope.mode) return 'mode';
    if (content.platformAccountId !== scope.platformAccountId) return 'platformAccountId';
    if (typeof content.sourceAccountId !== 'string' || content.sourceAccountId.length === 0 || content.sourceAccountId.length > 200) return 'sourceAccountId';
    if (!isStripeCustomerId(content.customerId)) return 'customerId';
    if (!isStripePaymentMethodId(content.paymentMethodId)) return 'paymentMethodId';
    if (!isStripeAccountId(content.destinationAccountId) || content.destinationAccountId === scope.platformAccountId) return 'destinationAccountId';
    if (typeof content.amountCents !== 'string' || !DECIMAL_CENTS.test(content.amountCents)) return 'amountCents';
    // The canonical amount and its cents must be the same quantity, exactly.
    if (centsOfUsdDecimal(content.amountValue)?.toString() !== content.amountCents) return 'amountValue';
    if (typeof content.amountUnit !== 'string' || content.amountUnit.length === 0 || content.amountUnit.length > 64) return 'amountUnit';
    if (!(STRIPE_CURRENCIES as readonly unknown[]).includes(content.currency)) return 'currency';
    for (const [field, key] of [['createIdempotencyKey', content.createIdempotencyKey], ['confirmIdempotencyKey', content.confirmIdempotencyKey]] as const) {
      if (typeof key !== 'string' || key.length > 255 || !IDEMPOTENCY_KEY.test(key)) return field;
    }
    if (content.createIdempotencyKey === content.confirmIdempotencyKey) return 'confirmIdempotencyKey';
    return undefined;
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
    if (content.sequence !== expectedSequence || row['sequence'] !== expectedSequence) throw corrupt('the sequence is not contiguous');
    if (row['execution_id'] !== content.executionId || row['kind'] !== content.kind) throw corrupt('the key columns disagree with an entry');
    if (!isCanonicalOutcomeInstant(content.recordedAt)) throw corrupt('an entry instant is malformed');
    if (content.kind === 'reservation') {
      if (keys !== RESERVATION_KEYS) throw corrupt('a reservation has another shape');
      if (row['payment_intent_id'] !== null) throw corrupt('a reservation carries a PaymentIntent');
      if (reservationProblem(content) !== undefined) throw corrupt('a reservation holds a malformed or out-of-scope field');
    } else if (content.kind === 'binding') {
      if (keys !== BINDING_KEYS) throw corrupt('a binding has another shape');
      if (!isOpaqueExecutionIdentifier(content.executionId) || !isStripePaymentIntentId(content.paymentIntentId) || row['payment_intent_id'] !== content.paymentIntentId) throw corrupt('a binding holds a malformed field');
    } else {
      throw corrupt('an entry has an unknown kind');
    }
    const entryDigest = entryDigestOf(content);
    if (row['entry_digest'] !== entryDigest) throw corrupt('an entry digest does not match its content');
    if (row['chain_digest'] !== chainDigestOf(previousChain, entryDigest)) throw corrupt('the chain is broken');
    return content;
  }

  /** The head, recomputed from genesis over every row, inside the caller's transaction — with the history's own uniqueness and ordering rules. */
  function verifiedHistory(): { readonly head: Head; readonly entries: readonly EntryContent[] } {
    let head = genesis();
    const entries: EntryContent[] = [];
    const reserved = new Set<string>();
    const bound = new Set<string>();
    const intents = new Set<string>();
    const accepted = verified;
    for (const row of selectAll.all() as Row[]) {
      const content = contentOf(row, head.sequence + 1, head.digest);
      if (content.kind === 'reservation') {
        if (reserved.has(content.executionId)) throw corrupt('an execution is reserved twice');
        reserved.add(content.executionId);
      } else {
        // A binding follows its own reservation, once, and names a PaymentIntent no other execution holds.
        if (!reserved.has(content.executionId) || bound.has(content.executionId) || intents.has(content.paymentIntentId)) throw corrupt('a binding breaks the one-PaymentIntent-per-execution rule');
        bound.add(content.executionId);
        intents.add(content.paymentIntentId);
      }
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
    if (anchor === undefined) throw unavailable('The Stripe payment interlock is not anchored.');
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
      if (error instanceof StripeInterlockStoreError || isAuthorityStateFreshnessError(error)) throw error;
      throw unavailable('The Stripe payment interlock could not complete the operation; nothing was written.');
    }
  }

  function recordOf(entries: readonly EntryContent[], executionId: string): StripePaymentInterlockRecord | undefined {
    const reservation = entries.find((entry): entry is ReservationContent => entry.kind === 'reservation' && entry.executionId === executionId);
    if (reservation === undefined) return undefined;
    const binding = entries.find((entry): entry is BindingContent => entry.kind === 'binding' && entry.executionId === executionId);
    return Object.freeze({
      executionId: reservation.executionId,
      railId: reservation.railId,
      mode: reservation.mode,
      platformAccountId: reservation.platformAccountId,
      sourceAccountId: reservation.sourceAccountId,
      customerId: reservation.customerId,
      paymentMethodId: reservation.paymentMethodId,
      destinationAccountId: reservation.destinationAccountId,
      amountValue: reservation.amountValue,
      amountUnit: reservation.amountUnit,
      amountCents: BigInt(reservation.amountCents),
      currency: reservation.currency as StripePaymentReservationInput['currency'],
      createIdempotencyKey: reservation.createIdempotencyKey,
      confirmIdempotencyKey: reservation.confirmIdempotencyKey,
      reservedAt: reservation.recordedAt,
      ...(binding !== undefined ? { paymentIntentId: binding.paymentIntentId, boundAt: binding.recordedAt } : {}),
    });
  }

  type Decision<T> = { readonly answer: T } | { readonly insert: Omit<ReservationContent, 'sequence' | 'recordedAt'> | Omit<BindingContent, 'sequence' | 'recordedAt'> };

  /** One anchored write — a CORE-07 transition whose local commit re-decides under `BEGIN IMMEDIATE` on the same head. */
  async function writeAnchored<T>(decide: (entries: readonly EntryContent[]) => Decision<T>, written: T): Promise<T> {
    const live = session;
    if (live === undefined) throw unavailable('The Stripe payment interlock is not anchored.');
    for (let attempt = 1; ; attempt += 1) {
      if (failedTransition !== undefined) throw failedTransition;
      try {
        assertOpen();
        // CORE-07, before every write — and so before every creation and every confirmation: unreachable, ahead of this file, or failed → refused.
        const status = await live.probe();
        if (status.status !== 'ready') throw new AuthorityStateFreshnessError(status.reason ?? 'AUTHORITY_FRESHNESS_UNAVAILABLE', `The Stripe payment history's freshness is '${status.status}': nothing is written, so nothing is created or confirmed.`);
        const decided = guarded(() =>
          db.transaction(() => {
            const history = observeFresh();
            return { decision: decide(history.entries), head: history.head };
          })(),
        );
        if ('answer' in decided.decision) return decided.decision.answer;
        const head = decided.head;
        const recordedAt = now();
        if (!isCanonicalOutcomeInstant(recordedAt)) throw unavailable('The interlock clock did not answer a canonical instant; nothing was written.');
        const content = { ...decided.decision.insert, sequence: head.sequence + 1, recordedAt } as EntryContent;
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
                  if (before.head.sequence !== head.sequence || before.head.digest !== head.digest) throw corrupt('the history moved under a prepared write');
                  if ('answer' in decide(before.entries)) throw corrupt('the decision changed under a prepared write');
                  insertEntry.run({
                    sequence: content.sequence,
                    executionId: content.executionId,
                    kind: content.kind,
                    paymentIntentId: content.kind === 'binding' ? content.paymentIntentId : null,
                    entryJson: canonicalSerialize(content),
                    entryDigest,
                    chainDigest,
                  });
                  const committed = verifiedHistory();
                  return { value: written, state: checkpointOf(committed.head) };
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

  function readOne(executionId: string): StripePaymentInterlockRecord | undefined {
    const { entries } = observeFresh();
    const found = recordOf(entries, executionId);
    // The indexed rows and the verified history must agree: a row reachable by key but absent from the chain (or the reverse) is corruption.
    const indexedReservation = selectIndexed.get(executionId, 'reservation') !== undefined;
    const indexedBinding = selectIndexed.get(executionId, 'binding') !== undefined;
    if (indexedReservation !== (found !== undefined) || indexedBinding !== (found?.paymentIntentId !== undefined)) throw corrupt('the execution index disagrees with the history');
    return found;
  }

  const store: DurableStripePaymentInterlock = {
    providerKind: 'sqlite',

    async recorded(executionId: string): Promise<StripePaymentReservationRecord | undefined> {
      assertOpen();
      if (!isOpaqueExecutionIdentifier(executionId)) throw invalid('executionId');
      return guarded(() => db.transaction(() => readOne(executionId))());
    },

    reserve(record: StripePaymentReservationInput): Promise<StripePaymentReservation> {
      return serialized(async () => {
        assertOpen();
        if (record === null || typeof record !== 'object') throw invalid('record');
        if (typeof record.amountCents !== 'bigint') throw invalid('amountCents');
        const insert: Omit<ReservationContent, 'sequence' | 'recordedAt'> = {
          kind: 'reservation',
          executionId: record.executionId,
          railId: record.railId,
          mode: record.mode,
          platformAccountId: record.platformAccountId,
          sourceAccountId: record.sourceAccountId,
          customerId: record.customerId,
          paymentMethodId: record.paymentMethodId,
          destinationAccountId: record.destinationAccountId,
          amountValue: record.amountValue,
          amountUnit: record.amountUnit,
          amountCents: record.amountCents.toString(),
          currency: record.currency,
          createIdempotencyKey: record.createIdempotencyKey,
          confirmIdempotencyKey: record.confirmIdempotencyKey,
        };
        const problem = reservationProblem(insert);
        if (problem !== undefined) throw invalid(problem);
        return writeAnchored<StripePaymentReservation>(
          (entries) => {
            const existing = recordOf(entries, record.executionId);
            return existing !== undefined ? { answer: { outcome: 'execution-recorded', record: existing } } : { insert };
          },
          { outcome: 'reserved' },
        );
      });
    },

    bind(executionId: string, paymentIntentId: string): Promise<StripePaymentBinding> {
      return serialized(async () => {
        assertOpen();
        if (!isOpaqueExecutionIdentifier(executionId)) throw invalid('executionId');
        if (!isStripePaymentIntentId(paymentIntentId)) throw invalid('paymentIntentId');
        return writeAnchored<StripePaymentBinding>(
          (entries) => {
            const existing = recordOf(entries, executionId);
            if (existing === undefined) return { answer: { outcome: 'not-reserved' } };
            if (existing.paymentIntentId !== undefined) return { answer: { outcome: 'execution-bound', paymentIntentId: existing.paymentIntentId } };
            if (entries.some((entry) => entry.kind === 'binding' && entry.paymentIntentId === paymentIntentId)) return { answer: { outcome: 'payment-intent-bound-elsewhere' } };
            return { insert: { kind: 'binding', executionId, paymentIntentId } };
          },
          { outcome: 'bound' },
        );
      });
    },

    async read(executionId: string): Promise<StripePaymentInterlockRecord | undefined> {
      assertOpen();
      if (!isOpaqueExecutionIdentifier(executionId)) return undefined;
      return guarded(() => db.transaction(() => readOne(executionId))());
    },

    async executionOfPaymentIntent(paymentIntentId: string): Promise<string | undefined> {
      assertOpen();
      if (!isStripePaymentIntentId(paymentIntentId)) return undefined;
      return guarded(() =>
        db.transaction(() => {
          const { entries } = observeFresh();
          const binding = entries.find((entry): entry is BindingContent => entry.kind === 'binding' && entry.paymentIntentId === paymentIntentId);
          if ((selectByPaymentIntent.get(paymentIntentId) !== undefined) !== (binding !== undefined)) throw corrupt('the PaymentIntent index disagrees with the history');
          return binding?.executionId;
        })(),
      );
    },

    async verifyAll(): Promise<{ readonly entries: number }> {
      assertOpen();
      return guarded(() =>
        db.transaction(() => {
          verified = undefined;
          const { head, entries } = verifiedHistory();
          for (const entry of entries) {
            if ((selectIndexed.get(entry.executionId, entry.kind) as { sequence: unknown } | undefined)?.sequence !== entry.sequence) throw corrupt('the execution index disagrees with the history');
            if (entry.kind === 'binding' && (selectByPaymentIntent.get(entry.paymentIntentId) as { sequence: unknown } | undefined)?.sequence !== entry.sequence) throw corrupt('the PaymentIntent index disagrees with the history');
          }
          return { entries: head.sequence };
        })(),
      );
    },

    async health(): Promise<StripeInterlockHealth> {
      let readable = false;
      let entries: number | undefined;
      try {
        if (!closed) {
          entries = guarded(() => db.transaction(() => verifiedHistory().head.sequence)());
          readable = true;
        }
      } catch {
        readable = false;
      }
      const freshness = session?.status().status ?? 'unbound';
      const writable = readable && !closed && !db.readonly && freshness !== 'unbound' && !isFailedAuthorityStateFreshnessStatus(freshness) && failedTransition === undefined;
      return { status: readable && writable ? 'healthy' : 'unhealthy', readable, writable, schemaVersion: STRIPE_INTERLOCK_SCHEMA_VERSION, freshness, ...(entries !== undefined ? { entries } : {}) };
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
      if (anchorRow['organization_id'] !== organizationId) throw unavailable('The Stripe payment interlock is anchored for another organization than the freshness boundary serves. Refusing to open it.');
      if (anchorRow['rail_id'] !== scope.railId || anchorRow['mode'] !== scope.mode || anchorRow['platform_account_id'] !== scope.platformAccountId) {
        throw unavailable('The Stripe payment interlock is bound to another rail, mode or platform account than the one configured. Refusing to open it.');
      }
      anchor = { storeId };
    } else {
      if ((countEntries.get() as { n: unknown }).n !== 0) throw corrupt('entries exist with no anchor');
      // Genesis: enrolled at the witness before it is committed here. A witness that holds this slot beyond genesis refuses
      // the empty file — a lost interlock, or a stale restore of a never-used backup, never silently starts over.
      const storeId = await boundary.genesisStoreId(PAYMENT_INITIATION_STATE_KIND, {
        newStoreId: () => `stripe-payment-interlock:${randomUUID()}`,
        genesisDigest: (id) => genesisDigest(id, organizationId, scope.railId, scope.mode, scope.platformAccountId),
      });
      guarded(() =>
        db
          .transaction(() => {
            const raced = selectAnchor.get() as Row | undefined;
            if (raced !== undefined) {
              if (raced['store_id'] !== storeId || raced['organization_id'] !== organizationId || raced['rail_id'] !== scope.railId || raced['mode'] !== scope.mode || raced['platform_account_id'] !== scope.platformAccountId) {
                throw corrupt('another process anchored this interlock differently');
              }
            } else {
              const at = now();
              if (!isCanonicalOutcomeInstant(at)) throw unavailable('The interlock clock did not answer a canonical instant.');
              db.prepare(`INSERT INTO ${ANCHOR_TABLE} (id, store_id, organization_id, rail_id, mode, platform_account_id, anchored_at) VALUES (1, ?, ?, ?, ?, ?, ?)`).run(storeId, organizationId, scope.railId, scope.mode, scope.platformAccountId, at);
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
