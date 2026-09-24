import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import {
  MPP_BUSINESS_OPERATION_STORE_SCHEMA_VERSION,
  type MppBusinessOperationAccessContext,
  type MppBusinessOperationRecord,
  type MppBusinessOperationState,
  type MppBusinessOperationStoreHealth,
  type MppChallengeInstanceRecord,
  type MppGovernedRequestState,
  type RecordMppChallengeInput,
  type RecordMppChallengeResult,
} from './contracts.js';
import { MppBusinessOperationStoreError } from './errors.js';
import { buildMppBusinessOperationRecord, buildMppChallengeInstanceRecord } from './integrity.js';
import {
  latestMppChallenge,
  planMppRecord,
  requireMppAccessContext,
  requireMppIdentifier,
  requireValidRecordInput,
  verifyLoadedMppOperationState,
  type MppBusinessOperationStore,
} from './operation-store.js';
import { isCanonicalMppInstant } from './validation.js';

/**
 * The durable MPP business-operation store — the production implementation of
 * `MppBusinessOperationStore` (P13). Its own file: never the Governance Store,
 * the P7 ledger, P11, P12, the Kernel Authority Store or the P8 stream.
 *
 * ## Two append-only tables
 *
 * ```
 * mpp_business_operations    one row per (organization_id, principal_id,
 *                            business_operation_id) — the PRIMARY KEY is the
 *                            business idempotency guarantee, under any number
 *                            of concurrent writers; a UNIQUE index maps the
 *                            deterministic governed request id back to it
 * mpp_challenge_instances    one row per accepted challenge, keyed by the
 *                            operation and a store-assigned sequence
 * ```
 *
 * Triggers refuse `UPDATE` and `DELETE` on both. There is no status column:
 * what an execution did is P11's and P12's.
 *
 * ## Every write decision is one `BEGIN IMMEDIATE` transaction
 *
 * Load the operation and **every** challenge row → verify all of them → decide
 * created / existing / conflict and appended / existing → sample `recordedAt` →
 * insert, with the write lock held from before the first read. Money is stored
 * as text, exactly as P9 produced it.
 *
 * `WAL` + `synchronous = FULL`; an unknown schema version refuses to open the
 * file before anything is created in it; every row read is re-validated and its
 * digests and derivations recomputed. Anything else is
 * `MPP_BUSINESS_OPERATION_CORRUPT`, never repaired and never read as absent.
 */

export interface CreateSqliteMppBusinessOperationStoreOptions {
  /** The injected clock: sampled inside every write's `BEGIN IMMEDIATE`, after the lock is held, as `recordedAt`. Required. */
  readonly now: () => string;
  readonly busyTimeoutMs?: number;
}

export interface DurableMppBusinessOperationStore extends MppBusinessOperationStore {
  readonly providerKind: 'sqlite';
}

const DEFAULT_BUSY_TIMEOUT_MS = 5_000;
const MAXIMUM_BUSY_TIMEOUT_MS = 60_000;

const SCHEMA_V1 = `
  CREATE TABLE IF NOT EXISTS mpp_business_operation_store_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    schema_version TEXT NOT NULL,
    migration_state TEXT NOT NULL,
    recorded_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS mpp_business_operations (
    organization_id TEXT NOT NULL,
    principal_id TEXT NOT NULL,
    business_operation_id TEXT NOT NULL,
    business_semantic_digest TEXT NOT NULL,
    action TEXT NOT NULL,
    resource TEXT NOT NULL,
    counterparty TEXT NOT NULL,
    amount_value TEXT NOT NULL,
    amount_unit TEXT NOT NULL,
    intent TEXT NOT NULL,
    http_method TEXT NOT NULL,
    content_digest TEXT,
    external_id TEXT,
    governed_idempotency_key TEXT NOT NULL,
    governed_request_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    schema_version TEXT NOT NULL,
    record_digest TEXT NOT NULL,
    PRIMARY KEY (organization_id, principal_id, business_operation_id)
  );

  CREATE UNIQUE INDEX IF NOT EXISTS mpp_business_operations_governed_request
    ON mpp_business_operations (organization_id, governed_request_id);

  CREATE TABLE IF NOT EXISTS mpp_challenge_instances (
    organization_id TEXT NOT NULL,
    principal_id TEXT NOT NULL,
    business_operation_id TEXT NOT NULL,
    challenge_sequence INTEGER NOT NULL,
    business_semantic_digest TEXT NOT NULL,
    challenge_digest TEXT NOT NULL,
    challenge_id TEXT NOT NULL,
    realm TEXT NOT NULL,
    method TEXT NOT NULL,
    intent TEXT NOT NULL,
    request TEXT NOT NULL,
    expires TEXT,
    digest TEXT,
    opaque TEXT,
    header TEXT,
    description TEXT,
    observed_at TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    schema_version TEXT NOT NULL,
    record_digest TEXT NOT NULL,
    PRIMARY KEY (organization_id, principal_id, business_operation_id, challenge_sequence)
  );

  CREATE TRIGGER IF NOT EXISTS mpp_business_operations_append_only_update
    BEFORE UPDATE ON mpp_business_operations
    BEGIN SELECT RAISE(ABORT, 'MPP business operations are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS mpp_business_operations_append_only_delete
    BEFORE DELETE ON mpp_business_operations
    BEGIN SELECT RAISE(ABORT, 'MPP business operations are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS mpp_challenge_instances_append_only_update
    BEFORE UPDATE ON mpp_challenge_instances
    BEGIN SELECT RAISE(ABORT, 'MPP challenge instances are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS mpp_challenge_instances_append_only_delete
    BEFORE DELETE ON mpp_challenge_instances
    BEGIN SELECT RAISE(ABORT, 'MPP challenge instances are immutable'); END;
`;

const OPERATION_COLUMNS = `organization_id, principal_id, business_operation_id, business_semantic_digest, action, resource, counterparty, amount_value, amount_unit, intent, http_method,
  content_digest, external_id, governed_idempotency_key, governed_request_id, created_at, recorded_at, schema_version, record_digest`;
const CHALLENGE_COLUMNS = `organization_id, principal_id, business_operation_id, challenge_sequence, business_semantic_digest, challenge_digest, challenge_id, realm, method, intent, request,
  expires, digest, opaque, header, description, observed_at, recorded_at, schema_version, record_digest`;

type Row = Readonly<Record<string, unknown>>;

function unavailable(message: string): MppBusinessOperationStoreError {
  return new MppBusinessOperationStoreError('MPP_BUSINESS_OPERATION_STORE_UNAVAILABLE', message);
}

function corrupt(subject: string, what: string): MppBusinessOperationStoreError {
  return new MppBusinessOperationStoreError('MPP_BUSINESS_OPERATION_CORRUPT', `The persisted business-operation state for '${subject}' failed validation (${what}). Refused, never repaired.`);
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

/** A column read back literally: `NULL` is absence, anything that is not text is corruption. */
function text(subject: string, row: Row, column: string): string {
  const value = row[column];
  if (typeof value !== 'string') throw corrupt(subject, `${column} is not text`);
  return value;
}

function optional(subject: string, row: Row, column: string, key: string): Record<string, string> {
  if (row[column] === null) return {};
  return { [key]: text(subject, row, column) };
}

function operationOf(subject: string, row: Row): MppBusinessOperationRecord {
  return {
    schemaVersion: text(subject, row, 'schema_version'),
    organizationId: text(subject, row, 'organization_id'),
    principalId: text(subject, row, 'principal_id'),
    businessOperationId: text(subject, row, 'business_operation_id'),
    businessSemanticDigest: text(subject, row, 'business_semantic_digest'),
    action: text(subject, row, 'action'),
    resource: text(subject, row, 'resource'),
    counterparty: text(subject, row, 'counterparty'),
    amount: { value: text(subject, row, 'amount_value'), unit: text(subject, row, 'amount_unit') },
    intent: text(subject, row, 'intent') as 'charge',
    httpMethod: text(subject, row, 'http_method'),
    ...optional(subject, row, 'content_digest', 'contentDigest'),
    ...optional(subject, row, 'external_id', 'externalId'),
    governedIdempotencyKey: text(subject, row, 'governed_idempotency_key'),
    governedRequestId: text(subject, row, 'governed_request_id'),
    createdAt: text(subject, row, 'created_at'),
    recordedAt: text(subject, row, 'recorded_at'),
    recordDigest: text(subject, row, 'record_digest'),
  };
}

function challengeOf(subject: string, row: Row): MppChallengeInstanceRecord {
  const sequence = row['challenge_sequence'];
  if (typeof sequence !== 'number' || !Number.isSafeInteger(sequence)) throw corrupt(subject, 'challenge_sequence is not an integer');
  return {
    schemaVersion: text(subject, row, 'schema_version'),
    organizationId: text(subject, row, 'organization_id'),
    principalId: text(subject, row, 'principal_id'),
    businessOperationId: text(subject, row, 'business_operation_id'),
    challengeSequence: sequence,
    businessSemanticDigest: text(subject, row, 'business_semantic_digest'),
    challengeDigest: text(subject, row, 'challenge_digest'),
    id: text(subject, row, 'challenge_id'),
    realm: text(subject, row, 'realm'),
    method: text(subject, row, 'method'),
    intent: text(subject, row, 'intent'),
    request: text(subject, row, 'request'),
    ...optional(subject, row, 'expires', 'expires'),
    ...optional(subject, row, 'digest', 'digest'),
    ...optional(subject, row, 'opaque', 'opaque'),
    ...(optional(subject, row, 'header', 'header') as { readonly header?: 'Payment-Authorization' }),
    ...optional(subject, row, 'description', 'description'),
    observedAt: text(subject, row, 'observed_at'),
    recordedAt: text(subject, row, 'recorded_at'),
    recordDigest: text(subject, row, 'record_digest'),
  };
}

export async function createSqliteMppBusinessOperationStore(dbPath: string, options: CreateSqliteMppBusinessOperationStoreOptions): Promise<DurableMppBusinessOperationStore> {
  if (typeof dbPath !== 'string' || dbPath.trim().length === 0) throw unavailable('The MPP business-operation store path must be a non-empty string.');
  if (typeof options?.now !== 'function') throw unavailable('The MPP business-operation store requires an injected clock.');
  const busyTimeoutMs = resolveBusyTimeoutMs(options.busyTimeoutMs);
  const now = options.now;
  const { default: Database } = await import('better-sqlite3');

  const path = dbPath === ':memory:' ? ':memory:' : resolveOnDisk(dbPath);
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = FULL');
  db.pragma(`busy_timeout = ${busyTimeoutMs}`);

  // The version guard runs before `CREATE TABLE IF NOT EXISTS`, so a file
  // written under a schema this runtime does not implement is refused unmutated.
  if (tableExists(db, 'mpp_business_operation_store_versions')) {
    const existing = db.prepare(`SELECT schema_version FROM mpp_business_operation_store_versions ORDER BY id DESC LIMIT 1`).get() as { schema_version: string } | undefined;
    if (existing !== undefined && existing.schema_version !== MPP_BUSINESS_OPERATION_STORE_SCHEMA_VERSION) {
      db.close();
      throw unavailable(
        `The MPP business-operation store is recorded under schema version '${existing.schema_version}', which this runtime does not implement (expected '${MPP_BUSINESS_OPERATION_STORE_SCHEMA_VERSION}'). Refusing to open it.`,
      );
    }
  }

  db.exec(SCHEMA_V1);
  const latest = db.prepare(`SELECT schema_version FROM mpp_business_operation_store_versions ORDER BY id DESC LIMIT 1`).get() as { schema_version: string } | undefined;
  if (latest === undefined) {
    const openedAt = now();
    if (!isCanonicalMppInstant(openedAt)) {
      db.close();
      throw unavailable('The store clock did not answer a canonical instant.');
    }
    db.prepare(`INSERT INTO mpp_business_operation_store_versions (schema_version, migration_state, recorded_at) VALUES (?, 'current', ?)`).run(MPP_BUSINESS_OPERATION_STORE_SCHEMA_VERSION, openedAt);
  }

  const selectOperation = db.prepare(`SELECT ${OPERATION_COLUMNS} FROM mpp_business_operations WHERE organization_id = ? AND principal_id = ? AND business_operation_id = ?`);
  const selectOperationByRequest = db.prepare(`SELECT ${OPERATION_COLUMNS} FROM mpp_business_operations WHERE organization_id = ? AND governed_request_id = ?`);
  // Every challenge row of the operation, unfiltered by sequence, expiry or anything a row states about itself.
  const selectChallenges = db.prepare(`SELECT ${CHALLENGE_COLUMNS} FROM mpp_challenge_instances WHERE organization_id = ? AND principal_id = ? AND business_operation_id = ?`);
  const insertOperation = db.prepare(
    `INSERT INTO mpp_business_operations (${OPERATION_COLUMNS})
     VALUES (@organizationId, @principalId, @businessOperationId, @businessSemanticDigest, @action, @resource, @counterparty, @amountValue, @amountUnit, @intent, @httpMethod,
       @contentDigest, @externalId, @governedIdempotencyKey, @governedRequestId, @createdAt, @recordedAt, @schemaVersion, @recordDigest)`,
  );
  const insertChallenge = db.prepare(
    `INSERT INTO mpp_challenge_instances (${CHALLENGE_COLUMNS})
     VALUES (@organizationId, @principalId, @businessOperationId, @challengeSequence, @businessSemanticDigest, @challengeDigest, @id, @realm, @method, @intent, @request,
       @expires, @digest, @opaque, @header, @description, @observedAt, @recordedAt, @schemaVersion, @recordDigest)`,
  );

  let closed = false;

  function assertOpen(): void {
    if (closed) throw unavailable('The MPP business-operation store has been closed.');
  }

  function recordedAt(): string {
    const instant = now();
    if (!isCanonicalMppInstant(instant)) throw unavailable('The store clock did not answer a canonical instant; nothing was written.');
    return instant;
  }

  function loadChallenges(subject: string, organizationId: string, principalId: string, businessOperationId: string): MppChallengeInstanceRecord[] {
    return (selectChallenges.all(organizationId, principalId, businessOperationId) as Row[]).map((row) => challengeOf(subject, row));
  }

  function load(organizationId: string, principalId: string, businessOperationId: string): MppBusinessOperationState | undefined {
    const row = selectOperation.get(organizationId, principalId, businessOperationId) as Row | undefined;
    return verifyLoadedMppOperationState(
      businessOperationId,
      organizationId,
      row === undefined ? undefined : operationOf(businessOperationId, row),
      loadChallenges(businessOperationId, organizationId, principalId, businessOperationId),
    );
  }

  const runRecord = db.transaction((input: RecordMppChallengeInput): RecordMppChallengeResult => {
    const { operation: operationInput, challenge: challengeInput } = input;
    const plan = planMppRecord(input, load(operationInput.organizationId, operationInput.principalId, operationInput.businessOperationId));
    if (plan.operation.kind === 'existing' && plan.challenge.kind === 'existing') {
      return { operationOutcome: 'existing', challengeOutcome: 'existing', operation: plan.operation.record, challenge: plan.challenge.record };
    }
    const at = recordedAt();
    const operation = plan.operation.kind === 'existing' ? plan.operation.record : buildMppBusinessOperationRecord(operationInput, at);
    const sequence = plan.challenge.kind === 'append' ? plan.challenge.sequence : 0;
    const challenge = buildMppChallengeInstanceRecord(challengeInput, sequence, at);
    if (plan.operation.kind === 'create') {
      insertOperation.run({
        organizationId: operation.organizationId,
        principalId: operation.principalId,
        businessOperationId: operation.businessOperationId,
        businessSemanticDigest: operation.businessSemanticDigest,
        action: operation.action,
        resource: operation.resource,
        counterparty: operation.counterparty,
        amountValue: operation.amount.value,
        amountUnit: operation.amount.unit,
        intent: operation.intent,
        httpMethod: operation.httpMethod,
        contentDigest: operation.contentDigest ?? null,
        externalId: operation.externalId ?? null,
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
      challengeDigest: challenge.challengeDigest,
      id: challenge.id,
      realm: challenge.realm,
      method: challenge.method,
      intent: challenge.intent,
      request: challenge.request,
      expires: challenge.expires ?? null,
      digest: challenge.digest ?? null,
      opaque: challenge.opaque ?? null,
      header: challenge.header ?? null,
      description: challenge.description ?? null,
      observedAt: challenge.observedAt,
      recordedAt: challenge.recordedAt,
      schemaVersion: challenge.schemaVersion,
      recordDigest: challenge.recordDigest,
    });
    return { operationOutcome: plan.operation.kind === 'create' ? 'created' : 'existing', challengeOutcome: 'appended', operation, challenge };
  });

  const runReadOperation = db.transaction((organizationId: string, principalId: string, businessOperationId: string) => load(organizationId, principalId, businessOperationId));

  const runReadByRequest = db.transaction((organizationId: string, requestId: string): MppGovernedRequestState | undefined => {
    const row = selectOperationByRequest.get(organizationId, requestId) as Row | undefined;
    if (row === undefined) return undefined;
    const operation = operationOf(requestId, row);
    const state = verifyLoadedMppOperationState(requestId, organizationId, operation, loadChallenges(requestId, operation.organizationId, operation.principalId, operation.businessOperationId));
    if (state === undefined || state.operation.governedRequestId !== requestId) throw corrupt(requestId, 'the request index does not name its operation');
    return Object.freeze({ operation: state.operation, latestChallenge: latestMppChallenge(state) });
  });

  return {
    providerKind: 'sqlite',

    async record(context: MppBusinessOperationAccessContext, input: RecordMppChallengeInput): Promise<RecordMppChallengeResult> {
      assertOpen();
      requireValidRecordInput(context, input);
      // BEGIN IMMEDIATE; durable before this resolves (`synchronous = FULL`).
      return runRecord.immediate(input);
    },

    async readOperation(context: MppBusinessOperationAccessContext, principalId: string, businessOperationId: string): Promise<MppBusinessOperationState | undefined> {
      assertOpen();
      const organizationId = requireMppAccessContext(context);
      requireMppIdentifier(principalId, 'The principal id');
      requireMppIdentifier(businessOperationId, 'The business operation id');
      return runReadOperation(organizationId, principalId, businessOperationId);
    },

    async readByGovernedRequestId(context: MppBusinessOperationAccessContext, requestId: string): Promise<MppGovernedRequestState | undefined> {
      assertOpen();
      const organizationId = requireMppAccessContext(context);
      requireMppIdentifier(requestId, 'The governed request id');
      return runReadByRequest(organizationId, requestId);
    },

    async health(): Promise<MppBusinessOperationStoreHealth> {
      let readable = false;
      try {
        if (!closed) {
          const version = db.prepare(`SELECT schema_version FROM mpp_business_operation_store_versions ORDER BY id DESC LIMIT 1`).get() as { schema_version: string } | undefined;
          readable = version?.schema_version === MPP_BUSINESS_OPERATION_STORE_SCHEMA_VERSION;
        }
      } catch {
        readable = false;
      }
      const writable = readable && !closed && !db.readonly;
      return { status: readable && writable ? 'healthy' : 'unhealthy', readable, writable, schemaVersion: MPP_BUSINESS_OPERATION_STORE_SCHEMA_VERSION, checkedAt: now() };
    },

    async close(): Promise<void> {
      if (!closed) {
        closed = true;
        db.close();
      }
    },
  };
}
