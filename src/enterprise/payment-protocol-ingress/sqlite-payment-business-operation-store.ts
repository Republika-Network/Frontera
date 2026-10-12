import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

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
 */

export interface CreateSqlitePaymentBusinessOperationStoreOptions {
  /** The injected clock: sampled inside every write's `BEGIN IMMEDIATE`, after the lock is held, as `recordedAt`. Required. */
  readonly now: () => string;
  readonly busyTimeoutMs?: number;
}

export interface DurablePaymentBusinessOperationStore extends PaymentBusinessOperationStore {
  readonly providerKind: 'sqlite';
  /** Re-verifies every operation and challenge in the file. Run at open; for restore's deep verification. */
  verifyAll(): Promise<{ readonly operations: number; readonly challenges: number }>;
}

const DEFAULT_BUSY_TIMEOUT_MS = 5_000;
const MAXIMUM_BUSY_TIMEOUT_MS = 60_000;
const VERSIONS_TABLE = 'payment_business_operation_store_versions';

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
      if (existing !== undefined && existing.schema_version !== PAYMENT_BUSINESS_OPERATION_STORE_SCHEMA_VERSION) {
        throw unavailable(`The business-operation store is recorded under a schema version this runtime does not implement (expected '${PAYMENT_BUSINESS_OPERATION_STORE_SCHEMA_VERSION}'). Refusing to open it.`);
      }
      if (existing === undefined && tableExists(db, 'payment_business_operations')) throw unavailable('The business-operation store holds tables but an empty schema version record. Refusing to open it.');
    } else if (tableExists(db, 'payment_business_operations') || tableExists(db, 'payment_protocol_challenges')) {
      throw unavailable('The business-operation store holds tables but no schema version record. Refusing to open it.');
    }
    db.exec(SCHEMA_V1);
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

  const runRecord = db.transaction((input: RecordPaymentChallengeInput): RecordPaymentChallengeResult => {
    const { operation: operationInput, challenge: challengeInput } = input;
    const subject = operationInput.businessOperationId;
    const existing = load(operationInput.organizationId, operationInput.principalId, operationInput.businessOperationId, subject);
    const plan = planPaymentRecord(input, existing, ownerOf(input, existing, subject));
    if (plan.challenge.kind === 'existing') {
      if (plan.operation.kind !== 'existing') throw corruptPaymentBusinessOperation(subject, 'a challenge exists with no operation');
      return { operationOutcome: 'existing', challengeOutcome: 'existing', operation: plan.operation.record, challenge: plan.challenge.record };
    }
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
  });

  const runReadOperation = db.transaction((organizationId: string, principalId: string, businessOperationId: string) => load(organizationId, principalId, businessOperationId, businessOperationId));

  const runReadByRequest = db.transaction((organizationId: string, requestId: string): PaymentGovernedRequestState | undefined => {
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
    return { operations, challenges };
  });

  /** Store errors pass through; anything SQLite throws (a constraint, a busy lock) is `unavailable` — never a silent success. */
  function guarded<T>(work: () => T): T {
    try {
      return work();
    } catch (error) {
      if (isPaymentBusinessOperationStoreError(error)) throw error;
      throw unavailable('The business-operation store could not complete the operation; nothing was written.');
    }
  }

  try {
    guarded(() => runVerifyAll.immediate());
  } catch (error) {
    db.close();
    throw error;
  }

  return {
    providerKind: 'sqlite',

    async record(context: PaymentBusinessOperationAccessContext, input: RecordPaymentChallengeInput): Promise<RecordPaymentChallengeResult> {
      assertOpen();
      requireValidPaymentRecordInput(context, input);
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
          readable = version?.schema_version === PAYMENT_BUSINESS_OPERATION_STORE_SCHEMA_VERSION;
        }
      } catch {
        readable = false;
      }
      const writable = readable && !closed && !db.readonly;
      return { status: readable && writable ? 'healthy' : 'unhealthy', readable, writable, schemaVersion: PAYMENT_BUSINESS_OPERATION_STORE_SCHEMA_VERSION, checkedAt: now() };
    },

    async close(): Promise<void> {
      if (!closed) {
        closed = true;
        db.close();
      }
    },
  };
}
