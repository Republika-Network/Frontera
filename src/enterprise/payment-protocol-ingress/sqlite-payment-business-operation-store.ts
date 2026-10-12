import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import type { AuthorityStateCheckpoint } from '../authority-state-freshness/checkpoint.js';
import { AuthorityStateFreshnessError, isAuthorityStateFreshnessError, type AuthorityStateFreshnessErrorCode } from '../authority-state-freshness/errors.js';
import {
  isAuthorityStateEnrollmentContext,
  isAuthorityStateFreshnessBoundary,
  isFailedAuthorityStateFreshnessStatus,
  markComposedUnderFreshness,
  type AuthorityStateEnrollmentContext,
  type AuthorityStateFreshnessBoundary,
  type AuthorityStateFreshnessSession,
} from '../authority-state-freshness/session.js';
import { isCanonicalCustomerIdentifier } from '../customer-identity/identifiers.js';
import { computeDigest } from '../governance-store/digest.js';
import { derivePaymentBusinessOperationRequestId } from './business-operation.js';
import {
  PAYMENT_BUSINESS_OPERATION_STORE_SCHEMA_VERSION,
  type PaymentBusinessOperationAccessContext,
  type PaymentBusinessOperationRecord,
  type PaymentBusinessOperationState,
  type PaymentBusinessOperationStore,
  type PaymentBusinessOperationStoreHealth,
  type PaymentChallengeRecord,
  type PaymentGovernedRequestState,
  type RecordPaymentChallengeInput,
  type RecordPaymentChallengeResult,
} from './store-contracts.js';
import { PaymentBusinessOperationStoreError, isPaymentBusinessOperationStoreError } from './store-errors.js';
import {
  buildPaymentBusinessOperationRecord,
  buildPaymentChallengeRecord,
  corruptPaymentBusinessOperation,
  isCanonicalPaymentInstant,
  latestPaymentChallenge,
  planPaymentRecord,
  requirePaymentAccessContext,
  requirePaymentIdentifier,
  requireValidPaymentRecordInput,
  verifyLoadedPaymentOperationState,
  type PaymentChallengeOwner,
  type PaymentRecordPlan,
} from './store-integrity.js';

/**
 * The durable payment business-operation store (PAY-04) — the production
 * implementation of `PaymentBusinessOperationStore`. Its own file: never the
 * Governance Store, P7, P11, P12, the Kernel Authority Store or P8.
 *
 * ## Two append-only tables
 *
 * ```
 * payment_business_operations   one row per (organization_id, principal_id, business_operation_id) —
 *                               the PRIMARY KEY is the business idempotency guarantee under any number
 *                               of concurrent writers; a UNIQUE index maps the derived governed
 *                               request id back to it
 * payment_protocol_challenges   one row per accepted challenge, keyed by its operation and a
 *                               store-assigned position; a UNIQUE index gives each challenge identity
 *                               one operation per organization
 * ```
 *
 * Triggers refuse `UPDATE` and `DELETE` on both. There is no status, outcome,
 * credential or secret column. Money is `TEXT`, exactly as P9 produced it.
 *
 * ## Every write decision is one `BEGIN IMMEDIATE` transaction
 *
 * Load and verify the operation and **every** one of its challenges, and the
 * operation owning the presented challenge identity → decide created /
 * existing / conflict and appended / existing → sample `recordedAt` → insert,
 * with the write lock held from before the first read. `WAL` +
 * `synchronous = FULL`: durable before `record` resolves.
 *
 * ## Verify-first, fail closed
 *
 * The schema guard runs before `CREATE TABLE IF NOT EXISTS`; opening verifies
 * every operation; every read re-validates each row and recomputes its digests
 * and derivations. Anything else is `PAYMENT_BUSINESS_OPERATION_CORRUPT` —
 * never repaired, never read as "no previous operation".
 *
 * ## Freshness (`freshness`: the CORE-07 witness — PAY-04 post-merge hardening)
 *
 * The one-operation-per-challenge rule lives only here: the governed key is
 * derived from the business operation, so nothing below this store ever sees
 * a challenge identity. A store cannot prove its own freshness, and a stale
 * restore — or the loss of the file — makes a challenge already paid for look
 * unowned: presented under a **new** `businessOperationId`, it would derive a
 * new governed key and be paid again. So, composed with a CORE-07 freshness
 * boundary, the store anchors its **ownership history** at the external
 * witness, in the protocol-neutral slot `payment-business-operation-state`:
 *
 * ```
 * sequence = the number of challenge rows ever accepted (each one a challenge identity
 *            becoming owned; an operation's creation is its first row)
 * digest   = a hash chain, in commit order, over each row's ownership entry:
 *            organization, principal, businessOperationId, business semantic digest,
 *            governed request id, challenge identity, challenge digest, position
 * genesis  = H(storeId, organization), so a substituted store or organization slot never matches
 * ```
 *
 * Every write that accepts a challenge is one CORE-07 transition — witness
 * `prepare` → this file's `BEGIN IMMEDIATE` insert → `finalize` — completed
 * before `record` resolves, so before the ingress can reach governance: no
 * challenge is ever owned (and so no payment ever attempted) that the witness
 * has not seen. A presentation that writes nothing (the exact challenge again)
 * still compares the witness with this file first. At open, the history is
 * reconciled with the witness before the store is handed to anything: an
 * older history (stale restore, rollback) is `ROLLBACK_DETECTED`, a different
 * one a fork, a prepared transition the file does not hold `PENDING_RECOVERY`,
 * an empty file under a slot the witness holds beyond genesis (a lost store) a
 * rollback — each refuses the open. There is no fallback to "the file looks
 * valid": an unreachable witness refuses the open and every presentation.
 *
 * An anchored file is written under the file schema `…schema.v2` (its records
 * keep the v1 record format), so a runtime that predates the hardening — which
 * would write without the witness — refuses to open it. A non-empty file
 * recorded before the hardening is never anchored after the fact, except by
 * the explicit CORE-07 enrollment ceremony (`freshness.enrollment`), where an
 * operator attests that the verified file is the newest state. The witness
 * must live outside this file's backup, restore and snapshot domain
 * (`docs/payments/PAY-04-PAYMENT-PROTOCOL-ADAPTER.md` §10.1).
 */

export interface CreateSqlitePaymentBusinessOperationStoreOptions {
  /** The injected clock: sampled inside every write's `BEGIN IMMEDIATE`, after the lock is held, as `recordedAt`. Required. */
  readonly now: () => string;
  readonly busyTimeoutMs?: number;
  /**
   * CORE-07: anchors the ownership history at the external witness (see the
   * module comment). Required for the store to be composed into the payment
   * protocol ingress. A store once anchored is never opened without it.
   *
   * `enrollment` — only for the one-time ceremony that anchors a **non-empty**
   * store recorded before the hardening: the operator attests that the
   * verified file is the newest state. Never needed for a new store.
   */
  readonly freshness?: { readonly boundary: AuthorityStateFreshnessBoundary; readonly enrollment?: AuthorityStateEnrollmentContext };
}

/** The file schema of an anchored store. Its records keep the v1 record format; only the file is newer, so a pre-hardening runtime refuses to open it. */
export const PAYMENT_BUSINESS_OPERATION_STORE_ANCHORED_SCHEMA_VERSION = 'aoc.payment-business-operation-store.schema.v2';

/** The CORE-07 slot of the business-operation ownership history. */
export const PAYMENT_BUSINESS_OPERATION_STATE_KIND = 'payment-business-operation-state';

export interface DurablePaymentBusinessOperationStore extends PaymentBusinessOperationStore {
  readonly providerKind: 'sqlite';
  /** Whether the ownership history is anchored at a CORE-07 freshness witness. */
  readonly anchored: boolean;
  /** Re-verifies every operation and challenge in the file. Run at open; for restore's deep verification. */
  verifyAll(): Promise<{ readonly operations: number; readonly challenges: number }>;
}

const DEFAULT_BUSY_TIMEOUT_MS = 5_000;
const MAXIMUM_BUSY_TIMEOUT_MS = 60_000;
const VERSIONS_TABLE = 'payment_business_operation_store_versions';
const ANCHOR_TABLE = 'payment_business_operation_anchor';
const OWNERSHIP_CHAIN_DOMAIN = 'aoc.payment.business-operation-ownership.v1';
const OWNERSHIP_ENTRY_DOMAIN = 'aoc.payment.business-operation-ownership-entry.v1';
const ENROLLMENT_STORE_ID_DOMAIN = 'aoc.payment.business-operation-enrollment.v1';
/** Bounded write attempts when another writer holds or wins the witness first. Contention before governance — never a payment retry. */
const ANCHORED_WRITE_ATTEMPTS = 8;
const ANCHORED_WRITE_BACKOFF_MS = 25;

const SCHEMA_V1 = `
  CREATE TABLE IF NOT EXISTS ${VERSIONS_TABLE} (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    schema_version TEXT NOT NULL,
    migration_state TEXT NOT NULL,
    recorded_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS payment_business_operations (
    organization_id TEXT NOT NULL,
    principal_id TEXT NOT NULL,
    business_operation_id TEXT NOT NULL,
    business_semantic_digest TEXT NOT NULL,
    action TEXT NOT NULL,
    source_account_id TEXT NOT NULL,
    destination_kind TEXT NOT NULL,
    destination_reference TEXT NOT NULL,
    amount_value TEXT NOT NULL,
    amount_unit TEXT NOT NULL,
    purpose TEXT NOT NULL,
    reference TEXT,
    rail TEXT,
    binding_target TEXT NOT NULL,
    binding_method TEXT NOT NULL,
    binding_content_digest TEXT,
    governed_idempotency_key TEXT NOT NULL,
    governed_request_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    schema_version TEXT NOT NULL,
    record_digest TEXT NOT NULL,
    PRIMARY KEY (organization_id, principal_id, business_operation_id)
  );

  CREATE UNIQUE INDEX IF NOT EXISTS payment_business_operations_governed_request
    ON payment_business_operations (organization_id, governed_request_id);

  CREATE TABLE IF NOT EXISTS payment_protocol_challenges (
    organization_id TEXT NOT NULL,
    principal_id TEXT NOT NULL,
    business_operation_id TEXT NOT NULL,
    challenge_sequence INTEGER NOT NULL,
    business_semantic_digest TEXT NOT NULL,
    protocol_id TEXT NOT NULL,
    challenge_key TEXT NOT NULL,
    challenge_identity TEXT NOT NULL,
    challenge_digest TEXT NOT NULL,
    fields TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    schema_version TEXT NOT NULL,
    record_digest TEXT NOT NULL,
    PRIMARY KEY (organization_id, principal_id, business_operation_id, challenge_sequence)
  );

  CREATE UNIQUE INDEX IF NOT EXISTS payment_protocol_challenges_identity
    ON payment_protocol_challenges (organization_id, challenge_identity);

  CREATE TRIGGER IF NOT EXISTS payment_business_operations_append_only_update
    BEFORE UPDATE ON payment_business_operations
    BEGIN SELECT RAISE(ABORT, 'payment business operations are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS payment_business_operations_append_only_delete
    BEFORE DELETE ON payment_business_operations
    BEGIN SELECT RAISE(ABORT, 'payment business operations are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS payment_protocol_challenges_append_only_update
    BEFORE UPDATE ON payment_protocol_challenges
    BEGIN SELECT RAISE(ABORT, 'payment protocol challenges are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS payment_protocol_challenges_append_only_delete
    BEFORE DELETE ON payment_protocol_challenges
    BEGIN SELECT RAISE(ABORT, 'payment protocol challenges are immutable'); END;
`;

/** The CORE-07 anchor: the store id the witness binds, and the one organization an anchored store serves. Written with the v2 version row, in one transaction. */
const ANCHOR_SCHEMA = `
  CREATE TABLE IF NOT EXISTS ${ANCHOR_TABLE} (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    store_id TEXT NOT NULL,
    organization_id TEXT NOT NULL,
    anchored_at TEXT NOT NULL
  );
  CREATE TRIGGER IF NOT EXISTS payment_business_operation_anchor_immutable
    BEFORE UPDATE ON ${ANCHOR_TABLE}
    BEGIN SELECT RAISE(ABORT, 'the business-operation store anchor is immutable'); END;
  CREATE TRIGGER IF NOT EXISTS payment_business_operation_anchor_no_delete
    BEFORE DELETE ON ${ANCHOR_TABLE}
    BEGIN SELECT RAISE(ABORT, 'the business-operation store anchor is immutable'); END;
`;

const FILE_SCHEMA_VERSIONS: readonly string[] = [PAYMENT_BUSINESS_OPERATION_STORE_SCHEMA_VERSION, PAYMENT_BUSINESS_OPERATION_STORE_ANCHORED_SCHEMA_VERSION];

function ownershipGenesisDigest(storeId: string, organizationId: string): string {
  return computeDigest({ domain: OWNERSHIP_CHAIN_DOMAIN, storeId, organizationId, sequence: 0 });
}

/** One challenge row's ownership entry: everything that makes it "challenge C belongs to operation A of principal P, with these semantics". */
interface OwnershipEntry {
  readonly organizationId: string;
  readonly principalId: string;
  readonly businessOperationId: string;
  readonly businessSemanticDigest: string;
  readonly challengeIdentity: string;
  readonly challengeDigest: string;
  readonly challengeSequence: number;
}

function ownershipEntryDigest(entry: OwnershipEntry): string {
  const scope = { organizationId: entry.organizationId, principalId: entry.principalId, businessOperationId: entry.businessOperationId };
  return computeDigest({
    domain: OWNERSHIP_ENTRY_DOMAIN,
    ...scope,
    businessSemanticDigest: entry.businessSemanticDigest,
    governedRequestId: derivePaymentBusinessOperationRequestId(scope),
    challengeIdentity: entry.challengeIdentity,
    challengeDigest: entry.challengeDigest,
    challengeSequence: entry.challengeSequence,
  });
}

function nextOwnershipDigest(previous: string, entryDigest: string): string {
  return computeDigest({ domain: OWNERSHIP_CHAIN_DOMAIN, previous, entryDigest });
}

/** The ownership history's head: how many rows, the chain over them, and the last row folded in. */
interface OwnershipHead {
  readonly lastRowId: number;
  /** The entry digest of that last row, so a history replaced underneath a running process is noticed. */
  readonly lastEntry: string | null;
  readonly sequence: number;
  readonly digest: string;
}

const pause = (ms: number): Promise<void> => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

/** The answers a CORE-07 session never clears once a transition produced them. */
function sticky(code: AuthorityStateFreshnessErrorCode): boolean {
  return code === 'AUTHORITY_FRESHNESS_PENDING_RECOVERY' || code === 'AUTHORITY_FRESHNESS_FORK_DETECTED' || code === 'AUTHORITY_FRESHNESS_ROLLBACK_DETECTED' || code === 'AUTHORITY_FRESHNESS_BINDING_MISMATCH';
}

/** Another writer between its witness prepare and its local commit: the only freshness answers a bounded wait can change. */
function contended(code: AuthorityStateFreshnessErrorCode): boolean {
  return code === 'AUTHORITY_FRESHNESS_CONFLICT' || code === 'AUTHORITY_FRESHNESS_PENDING_RECOVERY';
}

const OPERATION_COLUMNS = `organization_id, principal_id, business_operation_id, business_semantic_digest, action, source_account_id, destination_kind, destination_reference,
  amount_value, amount_unit, purpose, reference, rail, binding_target, binding_method, binding_content_digest, governed_idempotency_key, governed_request_id,
  created_at, recorded_at, schema_version, record_digest`;
const CHALLENGE_COLUMNS = `organization_id, principal_id, business_operation_id, challenge_sequence, business_semantic_digest, protocol_id, challenge_key, challenge_identity,
  challenge_digest, fields, observed_at, recorded_at, schema_version, record_digest`;

type Row = Readonly<Record<string, unknown>>;

function unavailable(message: string): PaymentBusinessOperationStoreError {
  return new PaymentBusinessOperationStoreError('PAYMENT_BUSINESS_OPERATION_STORE_UNAVAILABLE', message);
}

function resolveBusyTimeoutMs(value: number | undefined): number {
  const timeout = value ?? DEFAULT_BUSY_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > MAXIMUM_BUSY_TIMEOUT_MS) {
    throw new RangeError(`busyTimeoutMs must be a positive integer of at most ${String(MAXIMUM_BUSY_TIMEOUT_MS)}.`);
  }
  return timeout;
}

function resolveOnDisk(path: string): string {
  const absolute = resolve(path);
  const parent = dirname(absolute);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
  return absolute;
}

function tableExists(db: { prepare(sql: string): { get(...args: unknown[]): unknown } }, name: string): boolean {
  return db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) !== undefined;
}

/** A column read back literally: `NULL` is absence, anything that is not text is corruption. */
function text(subject: string, row: Row, column: string): string {
  const value = row[column];
  if (typeof value !== 'string') throw corruptPaymentBusinessOperation(subject, `${column} is not text`);
  return value;
}

function optional(subject: string, row: Row, column: string, key: string): Record<string, string> {
  return row[column] === null ? {} : { [key]: text(subject, row, column) };
}

function operationOf(subject: string, row: Row): PaymentBusinessOperationRecord {
  return {
    schemaVersion: text(subject, row, 'schema_version'),
    organizationId: text(subject, row, 'organization_id'),
    principalId: text(subject, row, 'principal_id'),
    businessOperationId: text(subject, row, 'business_operation_id'),
    businessSemanticDigest: text(subject, row, 'business_semantic_digest'),
    terms: {
      action: text(subject, row, 'action'),
      source: { accountId: text(subject, row, 'source_account_id') },
      destination: { kind: text(subject, row, 'destination_kind'), reference: text(subject, row, 'destination_reference') },
      amount: { value: text(subject, row, 'amount_value'), unit: text(subject, row, 'amount_unit') },
      purpose: text(subject, row, 'purpose'),
      ...optional(subject, row, 'reference', 'reference'),
      ...optional(subject, row, 'rail', 'rail'),
      binding: { target: text(subject, row, 'binding_target'), method: text(subject, row, 'binding_method'), ...optional(subject, row, 'binding_content_digest', 'contentDigest') },
    },
    governedIdempotencyKey: text(subject, row, 'governed_idempotency_key'),
    governedRequestId: text(subject, row, 'governed_request_id'),
    createdAt: text(subject, row, 'created_at'),
    recordedAt: text(subject, row, 'recorded_at'),
    recordDigest: text(subject, row, 'record_digest'),
  };
}

/** The evidence fields as stored: a JSON object of strings, parsed into a null-prototype record. Its exact spelling is checked by the record digest. */
function fieldsOf(subject: string, row: Row): Readonly<Record<string, string>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text(subject, row, 'fields')) as unknown;
  } catch {
    throw corruptPaymentBusinessOperation(subject, 'fields is not JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw corruptPaymentBusinessOperation(subject, 'fields is not a JSON object');
  const fields: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== 'string') throw corruptPaymentBusinessOperation(subject, 'a field is not text');
    fields[name] = value;
  }
  return fields;
}

function challengeOf(subject: string, row: Row): PaymentChallengeRecord {
  const sequence = row['challenge_sequence'];
  if (typeof sequence !== 'number' || !Number.isSafeInteger(sequence)) throw corruptPaymentBusinessOperation(subject, 'challenge_sequence is not an integer');
  return {
    schemaVersion: text(subject, row, 'schema_version'),
    organizationId: text(subject, row, 'organization_id'),
    principalId: text(subject, row, 'principal_id'),
    businessOperationId: text(subject, row, 'business_operation_id'),
    challengeSequence: sequence,
    businessSemanticDigest: text(subject, row, 'business_semantic_digest'),
    protocolId: text(subject, row, 'protocol_id'),
    challengeKey: text(subject, row, 'challenge_key'),
    challengeIdentity: text(subject, row, 'challenge_identity'),
    challengeDigest: text(subject, row, 'challenge_digest'),
    fields: fieldsOf(subject, row),
    observedAt: text(subject, row, 'observed_at'),
    recordedAt: text(subject, row, 'recorded_at'),
    recordDigest: text(subject, row, 'record_digest'),
  };
}

/** The fields as stored: one JSON object, keys sorted, no whitespace. */
function serializeFields(fields: Readonly<Record<string, string>>): string {
  const out: Record<string, string> = {};
  for (const name of Object.keys(fields).sort()) out[name] = fields[name] as string;
  return JSON.stringify(out);
}

export async function createSqlitePaymentBusinessOperationStore(dbPath: string, options: CreateSqlitePaymentBusinessOperationStoreOptions): Promise<DurablePaymentBusinessOperationStore> {
  if (typeof dbPath !== 'string' || dbPath.trim().length === 0) throw unavailable('The business-operation store path must be a non-empty string.');
  if (typeof options?.now !== 'function') throw unavailable('The business-operation store requires an injected clock.');
  const busyTimeoutMs = resolveBusyTimeoutMs(options.busyTimeoutMs);
  const now = options.now;
  const freshness = options.freshness;
  if (freshness !== undefined && (freshness === null || typeof freshness !== 'object' || !isAuthorityStateFreshnessBoundary(freshness.boundary))) {
    throw unavailable('The business-operation store freshness option needs a boundary built by createAuthorityStateFreshnessBoundary.');
  }
  if (freshness?.enrollment !== undefined && !isAuthorityStateEnrollmentContext(freshness.enrollment)) {
    throw unavailable('Enrolling an existing business-operation store requires a trusted enrollment context { operator: true, operatorId, attestation }.');
  }
  const { default: Database } = await import('better-sqlite3');

  const db = new Database(dbPath === ':memory:' ? ':memory:' : resolveOnDisk(dbPath));
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = FULL');
    db.pragma(`busy_timeout = ${busyTimeoutMs}`);
    // The version guard runs before `CREATE TABLE IF NOT EXISTS`: a file written
    // under a schema this runtime does not implement is refused unmutated.
    if (tableExists(db, VERSIONS_TABLE)) {
      const existing = db.prepare(`SELECT schema_version FROM ${VERSIONS_TABLE} ORDER BY id DESC LIMIT 1`).get() as { schema_version: unknown } | undefined;
      if (existing !== undefined && !FILE_SCHEMA_VERSIONS.includes(existing.schema_version as string)) {
        throw unavailable(`The business-operation store is recorded under a schema version this runtime does not implement (expected '${PAYMENT_BUSINESS_OPERATION_STORE_SCHEMA_VERSION}' or '${PAYMENT_BUSINESS_OPERATION_STORE_ANCHORED_SCHEMA_VERSION}'). Refusing to open it.`);
      }
      if (existing === undefined && tableExists(db, 'payment_business_operations')) throw unavailable('The business-operation store holds tables but an empty schema version record. Refusing to open it.');
      if (existing?.schema_version === PAYMENT_BUSINESS_OPERATION_STORE_ANCHORED_SCHEMA_VERSION) {
        // Without its witness, an anchored history would forgo rollback detection — and a write would leave the witness behind.
        if (freshness === undefined) throw unavailable('The business-operation store is anchored at a freshness witness and is never opened without it.');
        if (!tableExists(db, ANCHOR_TABLE)) throw corruptPaymentBusinessOperation('<open>', 'an anchored store has no anchor');
      }
    } else if (tableExists(db, 'payment_business_operations') || tableExists(db, 'payment_protocol_challenges')) {
      throw unavailable('The business-operation store holds tables but no schema version record. Refusing to open it.');
    }
    db.exec(SCHEMA_V1);
    db.exec(ANCHOR_SCHEMA);
    db.transaction(() => {
      if (db.prepare(`SELECT 1 FROM ${VERSIONS_TABLE} LIMIT 1`).get() === undefined) {
        const openedAt = now();
        if (!isCanonicalPaymentInstant(openedAt)) throw unavailable('The store clock did not answer a canonical instant.');
        db.prepare(`INSERT INTO ${VERSIONS_TABLE} (schema_version, migration_state, recorded_at) VALUES (?, 'current', ?)`).run(PAYMENT_BUSINESS_OPERATION_STORE_SCHEMA_VERSION, openedAt);
      }
    }).immediate();
  } catch (error) {
    db.close();
    throw isPaymentBusinessOperationStoreError(error) ? error : unavailable('The business-operation store could not be opened.');
  }

  const selectOperation = db.prepare(`SELECT ${OPERATION_COLUMNS} FROM payment_business_operations WHERE organization_id = ? AND principal_id = ? AND business_operation_id = ?`);
  const selectOperationByRequest = db.prepare(`SELECT ${OPERATION_COLUMNS} FROM payment_business_operations WHERE organization_id = ? AND governed_request_id = ?`);
  const selectAllOperations = db.prepare(`SELECT ${OPERATION_COLUMNS} FROM payment_business_operations`);
  const countChallenges = db.prepare(`SELECT COUNT(*) AS n FROM payment_protocol_challenges`);
  // Every challenge row of the operation, unfiltered by position or by anything a row states about itself.
  const selectChallenges = db.prepare(`SELECT ${CHALLENGE_COLUMNS} FROM payment_protocol_challenges WHERE organization_id = ? AND principal_id = ? AND business_operation_id = ?`);
  const selectIdentityOwner = db.prepare(`SELECT principal_id, business_operation_id FROM payment_protocol_challenges WHERE organization_id = ? AND challenge_identity = ?`);
  const insertOperation = db.prepare(
    `INSERT INTO payment_business_operations (${OPERATION_COLUMNS})
     VALUES (@organizationId, @principalId, @businessOperationId, @businessSemanticDigest, @action, @sourceAccountId, @destinationKind, @destinationReference,
       @amountValue, @amountUnit, @purpose, @reference, @rail, @bindingTarget, @bindingMethod, @bindingContentDigest, @governedIdempotencyKey, @governedRequestId,
       @createdAt, @recordedAt, @schemaVersion, @recordDigest)`,
  );
  const insertChallenge = db.prepare(
    `INSERT INTO payment_protocol_challenges (${CHALLENGE_COLUMNS})
     VALUES (@organizationId, @principalId, @businessOperationId, @challengeSequence, @businessSemanticDigest, @protocolId, @challengeKey, @challengeIdentity,
       @challengeDigest, @fields, @observedAt, @recordedAt, @schemaVersion, @recordDigest)`,
  );

  // ── CORE-07: the ownership history ──
  const selectAnchor = db.prepare(`SELECT store_id, organization_id FROM ${ANCHOR_TABLE} WHERE id = 1`);
  const countAllChallenges = db.prepare(`SELECT COUNT(*) AS n FROM payment_protocol_challenges`);
  const countOperationsOutside = db.prepare(`SELECT COUNT(*) AS n FROM payment_business_operations WHERE organization_id != ?`);
  const countChallengesOutside = db.prepare(`SELECT COUNT(*) AS n FROM payment_protocol_challenges WHERE organization_id != ?`);
  const selectOwnershipAfter = db.prepare(
    `SELECT rowid AS row_id, organization_id, principal_id, business_operation_id, business_semantic_digest, challenge_identity, challenge_digest, challenge_sequence
     FROM payment_protocol_challenges WHERE rowid > ? ORDER BY rowid ASC`,
  );
  const selectOwnershipAt = db.prepare(
    `SELECT organization_id, principal_id, business_operation_id, business_semantic_digest, challenge_identity, challenge_digest, challenge_sequence FROM payment_protocol_challenges WHERE rowid = ?`,
  );

  /** Set once at open, when anchored: the store id the witness binds and the one organization this store serves. */
  let anchor: { readonly storeId: string; readonly organizationId: string } | undefined;
  let session: AuthorityStateFreshnessSession | undefined;
  let headCache: OwnershipHead | undefined;

  function entryOfRow(row: Row): OwnershipEntry {
    const sequence = row['challenge_sequence'];
    if (typeof sequence !== 'number' || !Number.isSafeInteger(sequence)) throw corruptPaymentBusinessOperation('<ownership>', 'challenge_sequence is not an integer');
    return {
      organizationId: text('<ownership>', row, 'organization_id'),
      principalId: text('<ownership>', row, 'principal_id'),
      businessOperationId: text('<ownership>', row, 'business_operation_id'),
      businessSemanticDigest: text('<ownership>', row, 'business_semantic_digest'),
      challengeIdentity: text('<ownership>', row, 'challenge_identity'),
      challengeDigest: text('<ownership>', row, 'challenge_digest'),
      challengeSequence: sequence,
    };
  }

  /** The head folded forward from `base` over every committed row after it. Pure: never caches. */
  function headFrom(base: OwnershipHead): OwnershipHead {
    let { lastRowId, lastEntry, sequence, digest } = base;
    if (lastRowId > 0) {
      const at = selectOwnershipAt.get(lastRowId) as Row | undefined;
      if (at === undefined || ownershipEntryDigest(entryOfRow(at)) !== lastEntry) throw corruptPaymentBusinessOperation('<ownership>', 'the ownership history changed underneath this process');
    }
    for (const row of selectOwnershipAfter.all(lastRowId) as Row[]) {
      const rowId = row['row_id'];
      if (typeof rowId !== 'number' || !Number.isSafeInteger(rowId)) throw corruptPaymentBusinessOperation('<ownership>', 'a challenge row has no position');
      const entry = ownershipEntryDigest(entryOfRow(row));
      digest = nextOwnershipDigest(digest, entry);
      sequence += 1;
      lastRowId = rowId;
      lastEntry = entry;
    }
    if (sequence !== (countAllChallenges.get() as { n: unknown }).n) throw corruptPaymentBusinessOperation('<ownership>', 'the ownership history does not account for every challenge');
    return { lastRowId, lastEntry, sequence, digest };
  }

  /** The current head (outside a write, or before this connection's own insert in one). */
  function currentHead(): OwnershipHead {
    if (anchor === undefined) throw unavailable('The business-operation store is not anchored.');
    headCache = headFrom(headCache ?? { lastRowId: 0, lastEntry: null, sequence: 0, digest: ownershipGenesisDigest(anchor.storeId, anchor.organizationId) });
    return headCache;
  }

  function checkpointOf(head: OwnershipHead): AuthorityStateCheckpoint {
    if (anchor === undefined) throw unavailable('The business-operation store is not anchored.');
    return { stateKind: PAYMENT_BUSINESS_OPERATION_STATE_KIND, organizationId: anchor.organizationId, storeId: anchor.storeId, sequence: head.sequence, stateDigest: head.digest };
  }

  /** Local, synchronous, no network: a read refuses when the history is older than (or forked from) what this process established. */
  function observeFresh(): void {
    if (session !== undefined) session.observe(checkpointOf(currentHead()));
  }

  /** An anchored store serves exactly one organization: the slot the witness binds. */
  function requireAnchoredOrganization(organizationId: string): void {
    if (anchor !== undefined && organizationId !== anchor.organizationId) {
      throw new PaymentBusinessOperationStoreError('PAYMENT_BUSINESS_OPERATION_TENANT_VIOLATION', 'This business-operation store is anchored for another organization.');
    }
  }

  let closed = false;

  function assertOpen(): void {
    if (closed) throw unavailable('The business-operation store has been closed.');
  }

  function load(organizationId: string, principalId: string, businessOperationId: string, subject: string): PaymentBusinessOperationState | undefined {
    const row = selectOperation.get(organizationId, principalId, businessOperationId) as Row | undefined;
    const challenges = (selectChallenges.all(organizationId, principalId, businessOperationId) as Row[]).map((challenge) => challengeOf(subject, challenge));
    return verifyLoadedPaymentOperationState(subject, organizationId, row === undefined ? undefined : operationOf(subject, row), challenges);
  }

  function ownerOf(input: RecordPaymentChallengeInput, existing: PaymentBusinessOperationState | undefined, subject: string): PaymentChallengeOwner {
    const { organizationId, principalId, businessOperationId } = input.operation;
    const owner = selectIdentityOwner.get(organizationId, input.challenge.challengeIdentity) as Row | undefined;
    if (owner === undefined) return { kind: 'none' };
    const ownerPrincipal = text(subject, owner, 'principal_id');
    const ownerOperation = text(subject, owner, 'business_operation_id');
    if (ownerPrincipal !== principalId || ownerOperation !== businessOperationId) {
      // Verify the other operation before its row can decide anything.
      if (load(organizationId, ownerPrincipal, ownerOperation, subject) === undefined) throw corruptPaymentBusinessOperation(subject, 'a challenge identity names no operation');
      return { kind: 'another-operation' };
    }
    const record = existing?.challenges.find((challenge) => challenge.challengeIdentity === input.challenge.challengeIdentity);
    if (record === undefined) throw corruptPaymentBusinessOperation(subject, 'a challenge identity names no challenge');
    return { kind: 'this-operation', record };
  }

  function recordedAt(): string {
    const instant = now();
    if (!isCanonicalPaymentInstant(instant)) throw unavailable('The store clock did not answer a canonical instant; nothing was written.');
    return instant;
  }

  /** Load, verify and decide. Pure with respect to the file: nothing is written. */
  function decide(input: RecordPaymentChallengeInput): { readonly plan: PaymentRecordPlan; readonly found?: RecordPaymentChallengeResult } {
    const { operation: operationInput } = input;
    const subject = operationInput.businessOperationId;
    const existing = load(operationInput.organizationId, operationInput.principalId, operationInput.businessOperationId, subject);
    const plan = planPaymentRecord(input, existing, ownerOf(input, existing, subject));
    if (plan.challenge.kind === 'existing') {
      if (plan.operation.kind !== 'existing') throw corruptPaymentBusinessOperation(subject, 'a challenge exists with no operation');
      return { plan, found: { operationOutcome: 'existing', challengeOutcome: 'existing', operation: plan.operation.record, challenge: plan.challenge.record } };
    }
    return { plan };
  }

  const runRecord = db.transaction((input: RecordPaymentChallengeInput): RecordPaymentChallengeResult => {
    const { plan, found } = decide(input);
    return found ?? apply(input, plan);
  });

  /** Inside the write transaction: sample `recordedAt` under the lock, build, insert. */
  function apply(input: RecordPaymentChallengeInput, plan: PaymentRecordPlan): RecordPaymentChallengeResult {
    const { operation: operationInput, challenge: challengeInput } = input;
    if (plan.challenge.kind !== 'append') throw corruptPaymentBusinessOperation(operationInput.businessOperationId, 'nothing to append');
    const at = recordedAt();
    const operation = plan.operation.kind === 'existing' ? plan.operation.record : buildPaymentBusinessOperationRecord(operationInput, at);
    const challenge = buildPaymentChallengeRecord(challengeInput, plan.challenge.sequence, at);
    if (plan.operation.kind === 'create') {
      const { terms } = operation;
      insertOperation.run({
        organizationId: operation.organizationId,
        principalId: operation.principalId,
        businessOperationId: operation.businessOperationId,
        businessSemanticDigest: operation.businessSemanticDigest,
        action: terms.action,
        sourceAccountId: terms.source.accountId,
        destinationKind: terms.destination.kind,
        destinationReference: terms.destination.reference,
        amountValue: terms.amount.value,
        amountUnit: terms.amount.unit,
        purpose: terms.purpose,
        reference: terms.reference ?? null,
        rail: terms.rail ?? null,
        bindingTarget: terms.binding.target,
        bindingMethod: terms.binding.method,
        bindingContentDigest: terms.binding.contentDigest ?? null,
        governedIdempotencyKey: operation.governedIdempotencyKey,
        governedRequestId: operation.governedRequestId,
        createdAt: operation.createdAt,
        recordedAt: operation.recordedAt,
        schemaVersion: operation.schemaVersion,
        recordDigest: operation.recordDigest,
      });
    }
    insertChallenge.run({
      organizationId: challenge.organizationId,
      principalId: challenge.principalId,
      businessOperationId: challenge.businessOperationId,
      challengeSequence: challenge.challengeSequence,
      businessSemanticDigest: challenge.businessSemanticDigest,
      protocolId: challenge.protocolId,
      challengeKey: challenge.challengeKey,
      challengeIdentity: challenge.challengeIdentity,
      challengeDigest: challenge.challengeDigest,
      fields: serializeFields(challenge.fields),
      observedAt: challenge.observedAt,
      recordedAt: challenge.recordedAt,
      schemaVersion: challenge.schemaVersion,
      recordDigest: challenge.recordDigest,
    });
    return { operationOutcome: plan.operation.kind === 'create' ? 'created' : 'existing', challengeOutcome: 'appended', operation, challenge };
  }

  /** The ownership entry a planned append will add — computed from the input exactly as `headFrom` will recompute it from the inserted row. */
  function plannedEntry(input: RecordPaymentChallengeInput, sequence: number): string {
    const { challenge } = input;
    return ownershipEntryDigest({
      organizationId: challenge.organizationId,
      principalId: challenge.principalId,
      businessOperationId: challenge.businessOperationId,
      businessSemanticDigest: challenge.businessSemanticDigest,
      challengeIdentity: challenge.challengeIdentity,
      challengeDigest: challenge.challengeDigest,
      challengeSequence: sequence,
    });
  }

  /** One anchored write in this process at a time; across processes the witness's compare-and-advance decides. */
  let recording: Promise<unknown> = Promise.resolve();
  /** A transition this process could not complete safely (a prepared commit that failed, a fork): the session refuses for the life of the process, and so does this store, at once. */
  let failedTransition: AuthorityStateFreshnessError | undefined;

  /**
   * One anchored `record`. The witness is compared with this file first —
   * even for a presentation that will write nothing — so no presentation
   * reaches governance over a history the witness does not hold as current.
   * A write is then one CORE-07 transition: decided on the current head; the
   * witness prepares exactly that head's successor (another writer that
   * advanced it first makes the prepare conflict: nothing written); the
   * `BEGIN IMMEDIATE` commit re-checks that the head and the decision are
   * unchanged and inserts; `finalize` follows. Durable and witnessed when this
   * resolves. Losing the witness to another writer is retried a bounded
   * number of times — contention before governance, never a payment retry.
   */
  async function recordAnchored(input: RecordPaymentChallengeInput): Promise<RecordPaymentChallengeResult> {
    const live = session;
    if (live === undefined) throw unavailable('The business-operation store is not anchored.');
    for (let attempt = 1; ; attempt += 1) {
      if (failedTransition !== undefined) throw failedTransition;
      try {
        assertOpen();
        const status = await live.probe();
        if (status.status !== 'ready') {
          throw new AuthorityStateFreshnessError(status.reason ?? 'AUTHORITY_FRESHNESS_UNAVAILABLE', `The business-operation history's freshness is '${status.status}': no challenge is accepted and nothing is governed.`);
        }
        const decided = guarded(() =>
          db.transaction(() => {
            observeFresh();
            return { ...decide(input), head: currentHead() };
          })(),
        );
        if (decided.found !== undefined) return decided.found;
        const { plan, head } = decided;
        if (plan.challenge.kind !== 'append') throw corruptPaymentBusinessOperation(input.operation.businessOperationId, 'nothing to append');
        const expected = checkpointOf(head);
        const proposed: AuthorityStateCheckpoint = { ...expected, sequence: expected.sequence + 1, stateDigest: nextOwnershipDigest(expected.stateDigest, plannedEntry(input, plan.challenge.sequence)) };
        try {
          return await live.transition(expected, proposed, () => guarded(() => runAnchoredCommit.immediate(input, plan, head)));
        } catch (error) {
          // A failed local commit after the prepare, or a fork, is sticky in the CORE-07 session; mirror it. A prepare the witness
          // refused (conflict, outage, authentication, a malformed answer) wrote nothing and leaves the session usable.
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

  /** Inside the write transaction: the head is still the one the witness prepared a successor of, and the decision still stands; insert; the successor. Synchronous. */
  const runAnchoredCommit = db.transaction((input: RecordPaymentChallengeInput, prepared: PaymentRecordPlan, preparedFrom: OwnershipHead) => {
    const subject = input.operation.businessOperationId;
    const before = currentHead();
    if (before.sequence !== preparedFrom.sequence || before.digest !== preparedFrom.digest) throw corruptPaymentBusinessOperation(subject, 'the ownership history moved under a prepared transition');
    const { plan } = decide(input);
    if (plan.operation.kind !== prepared.operation.kind || plan.challenge.kind !== 'append' || prepared.challenge.kind !== 'append' || plan.challenge.sequence !== prepared.challenge.sequence) {
      throw corruptPaymentBusinessOperation(subject, 'the decision changed under a prepared transition');
    }
    const value = apply(input, plan);
    return { value, state: checkpointOf(headFrom(before)) };
  });

  const runReadOperation = db.transaction((organizationId: string, principalId: string, businessOperationId: string) => {
    observeFresh();
    return load(organizationId, principalId, businessOperationId, businessOperationId);
  });

  const runReadByRequest = db.transaction((organizationId: string, requestId: string): PaymentGovernedRequestState | undefined => {
    observeFresh();
    const row = selectOperationByRequest.get(organizationId, requestId) as Row | undefined;
    if (row === undefined) return undefined;
    const candidate = operationOf(requestId, row);
    const state = load(organizationId, candidate.principalId, candidate.businessOperationId, requestId);
    if (state === undefined || state.operation.governedRequestId !== requestId) throw corruptPaymentBusinessOperation(requestId, 'the request index does not name its operation');
    return Object.freeze({ operation: state.operation, latestChallenge: latestPaymentChallenge(state) });
  });

  const runVerifyAll = db.transaction((): { readonly operations: number; readonly challenges: number } => {
    let operations = 0;
    let challenges = 0;
    for (const row of selectAllOperations.all() as Row[]) {
      const candidate = operationOf('<verify>', row);
      // Integrity before scope: the row is verified under its own organization.
      const state = load(candidate.organizationId, candidate.principalId, candidate.businessOperationId, candidate.businessOperationId);
      if (state === undefined) throw corruptPaymentBusinessOperation(candidate.businessOperationId, 'an operation vanished during verification');
      operations += 1;
      challenges += state.challenges.length;
    }
    const total = (countChallenges.get() as { n: unknown }).n;
    if (total !== challenges) throw corruptPaymentBusinessOperation('<verify>', 'challenges exist that belong to no operation');
    if (anchor !== undefined && ((countOperationsOutside.get(anchor.organizationId) as { n: unknown }).n !== 0 || (countChallengesOutside.get(anchor.organizationId) as { n: unknown }).n !== 0)) {
      throw corruptPaymentBusinessOperation('<verify>', 'an anchored store holds another organization\'s history');
    }
    return { operations, challenges };
  });

  /** Store errors pass through; anything SQLite throws (a constraint, a busy lock) is `unavailable` — never a silent success. */
  function guarded<T>(work: () => T): T {
    try {
      return work();
    } catch (error) {
      if (isPaymentBusinessOperationStoreError(error) || isAuthorityStateFreshnessError(error)) throw error;
      throw unavailable('The business-operation store could not complete the operation; nothing was written.');
    }
  }

  const store: DurablePaymentBusinessOperationStore = {
    providerKind: 'sqlite',

    get anchored() {
      return session !== undefined;
    },

    async record(context: PaymentBusinessOperationAccessContext, input: RecordPaymentChallengeInput): Promise<RecordPaymentChallengeResult> {
      assertOpen();
      requireValidPaymentRecordInput(context, input);
      if (session !== undefined) {
        requireAnchoredOrganization(input.operation.organizationId);
        // Witness first; every accepted challenge is a CORE-07 transition, durable and witnessed before this resolves.
        const result = recording.then(() => recordAnchored(input));
        recording = result.catch(() => undefined);
        return result;
      }
      // BEGIN IMMEDIATE; durable before this resolves (`synchronous = FULL`).
      return guarded(() => runRecord.immediate(input));
    },

    async readOperation(context: PaymentBusinessOperationAccessContext, principalId: string, businessOperationId: string): Promise<PaymentBusinessOperationState | undefined> {
      assertOpen();
      const organizationId = requirePaymentAccessContext(context);
      requirePaymentIdentifier(principalId, 'The principal id');
      requirePaymentIdentifier(businessOperationId, 'The business operation id');
      return guarded(() => runReadOperation(organizationId, principalId, businessOperationId));
    },

    async readByGovernedRequestId(context: PaymentBusinessOperationAccessContext, requestId: string): Promise<PaymentGovernedRequestState | undefined> {
      assertOpen();
      const organizationId = requirePaymentAccessContext(context);
      requirePaymentIdentifier(requestId, 'The governed request id');
      return guarded(() => runReadByRequest(organizationId, requestId));
    },

    async verifyAll(): Promise<{ readonly operations: number; readonly challenges: number }> {
      assertOpen();
      return guarded(() => runVerifyAll.immediate());
    },

    async health(): Promise<PaymentBusinessOperationStoreHealth> {
      let readable = false;
      try {
        if (!closed) {
          const version = db.prepare(`SELECT schema_version FROM ${VERSIONS_TABLE} ORDER BY id DESC LIMIT 1`).get() as { schema_version: unknown } | undefined;
          readable = FILE_SCHEMA_VERSIONS.includes(version?.schema_version as string);
        }
      } catch {
        readable = false;
      }
      const freshnessStatus = session?.status().status ?? 'not-anchored';
      const failed = freshnessStatus !== 'not-anchored' && isFailedAuthorityStateFreshnessStatus(freshnessStatus);
      const writable = readable && !closed && !db.readonly && !failed;
      const schemaVersion = anchor !== undefined ? PAYMENT_BUSINESS_OPERATION_STORE_ANCHORED_SCHEMA_VERSION : PAYMENT_BUSINESS_OPERATION_STORE_SCHEMA_VERSION;
      return { status: readable && writable ? 'healthy' : 'unhealthy', readable, writable, schemaVersion, checkedAt: now(), freshness: freshnessStatus };
    },

    async close(): Promise<void> {
      if (!closed) {
        closed = true;
        db.close();
      }
    },
  };

  /** Set only by the enrollment ceremony of a pre-hardening file: the anchor is persisted once the witness accepted the baseline. */
  let enrolling = false;
  try {
    const anchorRow = selectAnchor.get() as Row | undefined;
    if (anchorRow !== undefined) anchor = { storeId: text('<anchor>', anchorRow, 'store_id'), organizationId: text('<anchor>', anchorRow, 'organization_id') };
    if (anchor !== undefined && (anchor.storeId.length === 0 || !isCanonicalCustomerIdentifier(anchor.organizationId))) throw corruptPaymentBusinessOperation('<anchor>', 'the anchor is malformed');
    const latest = (db.prepare(`SELECT schema_version FROM ${VERSIONS_TABLE} ORDER BY id DESC LIMIT 1`).get() as { schema_version: unknown } | undefined)?.schema_version;
    if ((anchor !== undefined) !== (latest === PAYMENT_BUSINESS_OPERATION_STORE_ANCHORED_SCHEMA_VERSION)) throw corruptPaymentBusinessOperation('<anchor>', 'the anchor and the file schema disagree');
    if (freshness !== undefined) {
      const organizationId = freshness.boundary.organizationId;
      if (anchor !== undefined && anchor.organizationId !== organizationId) {
        throw unavailable('The business-operation store is anchored for another organization than the freshness boundary serves. Refusing to open it.');
      }
      if (anchor === undefined) {
        const rows = (countAllChallenges.get() as { n: unknown }).n !== 0 || (db.prepare('SELECT 1 FROM payment_business_operations LIMIT 1').get() !== undefined);
        if (rows && freshness.enrollment === undefined) {
          // Never anchored after the fact: a history the witness has not seen from its first challenge could already have lost one.
          throw unavailable(
            'The business-operation store holds history recorded without a freshness anchor, and is never anchored after the fact. Anchor it only through the explicit enrollment ceremony, after establishing that this file is the newest state (docs/payments/PAY-04-PAYMENT-PROTOCOL-ADAPTER.md §10.2).',
          );
        }
        if (!rows) {
          // Genesis: enrolled at the witness before it is committed here (CORE-07). A witness holding this slot beyond genesis refuses
          // the empty file — a lost store, or a stale restore of a never-used backup.
          const genesisId = await freshness.boundary.genesisStoreId(PAYMENT_BUSINESS_OPERATION_STATE_KIND, {
            newStoreId: () => `payment-business-operation-store:${randomUUID()}`,
            genesisDigest: (id) => ownershipGenesisDigest(id, organizationId),
          });
          writeAnchor(genesisId, organizationId);
        } else {
          // The enrollment ceremony for a pre-hardening file. Its store id is derived from the verified history itself, and the
          // anchor is written here only after the witness has accepted that history as the baseline (below): a refused ceremony
          // leaves the file exactly as it was, and a crash between the enrollment and the anchor derives the same id again.
          guarded(() => runVerifyAll.immediate());
          const provisional = guarded(() => headFrom({ lastRowId: 0, lastEntry: null, sequence: 0, digest: ownershipGenesisDigest(ENROLLMENT_STORE_ID_DOMAIN, organizationId) }));
          const derived = computeDigest({ domain: ENROLLMENT_STORE_ID_DOMAIN, organizationId, sequence: provisional.sequence, digest: provisional.digest });
          anchor = { storeId: `payment-business-operation-store:enrolled:${derived.slice('sha256:'.length, 'sha256:'.length + 32)}`, organizationId };
          enrolling = true;
        }
      }
    }
    guarded(() => runVerifyAll.immediate());
    if (freshness !== undefined) {
      // CORE-07, before the store is handed to anything: an older history (rollback, stale restore), a fork, a prepared transition
      // this file does not hold, an unenrolled slot or an unreachable witness refuses the open.
      session = await freshness.boundary.establish(checkpointOf(currentHead()), () => checkpointOf(currentHead()), freshness.enrollment !== undefined ? { enrollment: freshness.enrollment } : {});
      if (enrolling && anchor !== undefined) writeAnchor(anchor.storeId, anchor.organizationId);
      markComposedUnderFreshness(store, freshness.boundary);
    }
  } catch (error) {
    closed = true;
    db.close();
    throw error;
  }
  return Object.freeze(store);

  /** The anchor and the v2 file version, in one transaction: an anchored file is never readable by a runtime that would write without the witness. */
  function writeAnchor(storeId: string, organizationId: string): void {
    guarded(() =>
      db
        .transaction(() => {
          const raced = selectAnchor.get() as Row | undefined;
          if (raced !== undefined) {
            if (text('<anchor>', raced, 'store_id') !== storeId || text('<anchor>', raced, 'organization_id') !== organizationId) throw corruptPaymentBusinessOperation('<anchor>', 'another process anchored this store differently');
          } else {
            const at = recordedAt();
            db.prepare(`INSERT INTO ${ANCHOR_TABLE} (id, store_id, organization_id, anchored_at) VALUES (1, ?, ?, ?)`).run(storeId, organizationId, at);
            db.prepare(`INSERT INTO ${VERSIONS_TABLE} (schema_version, migration_state, recorded_at) VALUES (?, 'current', ?)`).run(PAYMENT_BUSINESS_OPERATION_STORE_ANCHORED_SCHEMA_VERSION, at);
          }
          anchor = { storeId, organizationId };
        })
        .immediate(),
    );
  }
}
