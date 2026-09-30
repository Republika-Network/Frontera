import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { decideKernelAuthorityAppend, validateKernelAuthorityAppendInput } from './append-rules.js';
import {
  AOC_KERNEL_AUTHORITY_RUNTIME_VERSION,
  KERNEL_AUTHORITY_SCHEMA_VERSION,
  type AppendKernelAuthorityEventInput,
  type AppendKernelAuthorityEventResult,
  type KernelAuthorityAccessContext,
  type KernelAuthorityEntityKind,
  type KernelAuthorityEvent,
  type KernelAuthorityEventType,
  type KernelAuthorityExternalSubject,
  type KernelAuthorityRecord,
  type KernelAuthorityRecordQuery,
  type KernelAuthorityStoreHealth,
} from './contracts.js';
import { KernelAuthorityError } from './errors.js';
import {
  buildKernelAuthorityEvent,
  compareKernelAuthorityRecords,
  isKernelAuthorityEntityKind,
  readExternalSubject,
  reconstructKernelAuthorityRecord,
  requireKernelAuthorityOperator,
  requireKernelAuthorityReadAccess,
  type KernelAuthorityStore,
} from './kernel-authority-store.js';

export interface CreateSqliteKernelAuthorityStoreOptions {
  readonly now?: () => string;
  readonly nextId?: (prefix: string) => string;
  readonly runtimeVersion?: string;
  readonly busyTimeoutMs?: number;
}

const DEFAULT_BUSY_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------------------
// Schema (`aoc.kernel-authority.schema.v1`). Four tables.
//
// `kernel_authority_events` is canonical -- the append-only, digest-chained
// history of every provisioning and revocation. `kernel_authority_records` is
// a reconstructable projection cache and never a second source of truth: every
// column on it is re-derivable from the event table, and `listRecords` proves
// that by replaying the chain rather than trusting the row. The projection
// exists so a hydration is one indexed scan instead of a full replay of every
// chain in the organization.
//
// `kernel_authority_idempotency` records provisioning idempotency claims, and
// `kernel_authority_external_subjects` enforces the one-external-principal-to-
// one-actor binding at the database layer via its primary key, in addition to
// the application-level check performed before insert.
// ---------------------------------------------------------------------------
const SCHEMA_V1 = `
  CREATE TABLE IF NOT EXISTS kernel_authority_store_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    schema_version TEXT NOT NULL,
    migration_state TEXT NOT NULL,
    recorded_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS kernel_authority_records (
    organization_id TEXT NOT NULL,
    entity_kind TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    trust_domain_id TEXT,
    status TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    payload_digest TEXT NOT NULL,
    provisioned_by TEXT NOT NULL,
    provisioned_at TEXT NOT NULL,
    revoked_by TEXT,
    revoked_at TEXT,
    revocation_reason TEXT,
    latest_sequence INTEGER NOT NULL,
    latest_event_digest TEXT NOT NULL,
    schema_version TEXT NOT NULL,
    PRIMARY KEY (organization_id, entity_kind, entity_id)
  );
  CREATE INDEX IF NOT EXISTS idx_kernel_authority_records_org_kind ON kernel_authority_records(organization_id, entity_kind);
  CREATE INDEX IF NOT EXISTS idx_kernel_authority_records_trust_domain ON kernel_authority_records(organization_id, trust_domain_id);

  CREATE TABLE IF NOT EXISTS kernel_authority_events (
    event_id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    entity_kind TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    previous_event_digest TEXT,
    event_digest TEXT NOT NULL,
    provisioned_by TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    persisted_at TEXT NOT NULL,
    schema_version TEXT NOT NULL,
    runtime_version TEXT NOT NULL,
    FOREIGN KEY (organization_id, entity_kind, entity_id)
      REFERENCES kernel_authority_records(organization_id, entity_kind, entity_id),
    UNIQUE(organization_id, entity_kind, entity_id, sequence)
  );
  CREATE INDEX IF NOT EXISTS idx_kernel_authority_events_entity
    ON kernel_authority_events(organization_id, entity_kind, entity_id, sequence);

  CREATE TABLE IF NOT EXISTS kernel_authority_idempotency (
    organization_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    payload_digest TEXT NOT NULL,
    entity_kind TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (organization_id, idempotency_key)
  );

  CREATE TABLE IF NOT EXISTS kernel_authority_external_subjects (
    organization_id TEXT NOT NULL,
    external_system TEXT NOT NULL,
    external_subject_id TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (organization_id, external_system, external_subject_id)
  );
  CREATE INDEX IF NOT EXISTS idx_kernel_authority_external_subjects_actor
    ON kernel_authority_external_subjects(organization_id, actor_id);
`;

interface EventRow {
  readonly event_id: string;
  readonly organization_id: string;
  readonly entity_kind: string;
  readonly entity_id: string;
  readonly sequence: number;
  readonly event_type: string;
  readonly payload_json: string;
  readonly previous_event_digest: string | null;
  readonly event_digest: string;
  readonly provisioned_by: string;
  readonly occurred_at: string;
  readonly persisted_at: string;
  readonly schema_version: string;
  readonly runtime_version: string;
}

interface RecordRow {
  readonly organization_id: string;
  readonly entity_kind: string;
  readonly entity_id: string;
}

function rowToEvent(row: EventRow): KernelAuthorityEvent {
  if (!isKernelAuthorityEntityKind(row.entity_kind)) {
    throw new KernelAuthorityError(
      'KERNEL_AUTHORITY_INTEGRITY_FAILED',
      `Persisted Kernel Authority event '${row.event_id}' names an unknown entity kind '${row.entity_kind}'. Refusing to interpret it rather than skipping it, which could drop a revocation.`,
    );
  }
  let payload: Readonly<Record<string, unknown>>;
  try {
    payload = JSON.parse(row.payload_json) as Readonly<Record<string, unknown>>;
  } catch {
    throw new KernelAuthorityError('KERNEL_AUTHORITY_INTEGRITY_FAILED', `Persisted Kernel Authority event '${row.event_id}' has a malformed payload and cannot be interpreted.`);
  }
  return {
    eventId: row.event_id,
    organizationId: row.organization_id,
    entityKind: row.entity_kind,
    entityId: row.entity_id,
    eventType: row.event_type as KernelAuthorityEventType,
    sequence: row.sequence,
    payload,
    provisionedBy: row.provisioned_by,
    occurredAt: row.occurred_at,
    persistedAt: row.persisted_at,
    eventDigest: row.event_digest,
    schemaVersion: row.schema_version,
    runtimeVersion: row.runtime_version,
    ...(row.previous_event_digest !== null ? { previousEventDigest: row.previous_event_digest } : {}),
  };
}

function tableExists(db: import('better-sqlite3').Database, tableName: string): boolean {
  return db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(tableName) !== undefined;
}

function resolveBusyTimeoutMs(value: number | undefined): number {
  const timeout = value ?? DEFAULT_BUSY_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout <= 0) {
    throw new RangeError(`busyTimeoutMs must be a positive integer, received '${String(value)}'.`);
  }
  return timeout;
}

function resolveOnDisk(dbPath: string): string {
  const absPath = resolve(dbPath);
  const dir = dirname(absPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return absPath;
}

function defaultNextId(prefix: string, counterRef: { value: number }): string {
  counterRef.value += 1;
  return `${prefix}-${counterRef.value.toString(36)}-${Date.now().toString(36)}`;
}

/**
 * SQLite-backed `KernelAuthorityStore` -- the durable authority source an
 * external application's evaluation ultimately decides against.
 *
 * `better-sqlite3` loaded lazily, hand-written SQL, following the Governance /
 * Passport / Assurance store pattern exactly. Every `appendEvent` runs inside
 * one synchronous `db.transaction(...)`: better-sqlite3 is synchronous, so no
 * other in-process caller can interleave, and the `(organization, kind, id,
 * sequence)` uniqueness plus the external-subject primary key serialize
 * cross-process writers too. A concurrent duplicate provision therefore
 * commits once and the loser sees a conflict -- never two grants for one
 * entity.
 */
export async function createSqliteKernelAuthorityStore(
  dbPath: string,
  options: CreateSqliteKernelAuthorityStoreOptions = {},
): Promise<KernelAuthorityStore> {
  const { default: Database } = await import('better-sqlite3');

  const now = options.now ?? (() => new Date().toISOString());
  const counter = { value: 0 };
  const nextId = options.nextId ?? ((prefix: string) => defaultNextId(prefix, counter));
  const runtimeVersion = options.runtimeVersion ?? AOC_KERNEL_AUTHORITY_RUNTIME_VERSION;

  const path = dbPath === ':memory:' ? ':memory:' : resolveOnDisk(dbPath);
  const db = new Database(path);
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = FULL');
  db.pragma(`busy_timeout = ${resolveBusyTimeoutMs(options.busyTimeoutMs)}`);

  // Check the recorded schema version BEFORE applying SCHEMA_V1, exactly as
  // the sibling stores do: a database recorded under a different schema must
  // not be mutated (e.g. by adding this runtime's tables alongside a
  // differently-shaped store) merely because we were asked to open it.
  if (tableExists(db, 'kernel_authority_store_versions')) {
    const existingVersion = db.prepare(`SELECT schema_version FROM kernel_authority_store_versions ORDER BY id DESC LIMIT 1`).get() as
      | { schema_version: string }
      | undefined;
    if (existingVersion !== undefined && existingVersion.schema_version !== KERNEL_AUTHORITY_SCHEMA_VERSION) {
      db.close();
      throw new KernelAuthorityError(
        'KERNEL_AUTHORITY_VERSION_UNSUPPORTED',
        `Kernel Authority Store schema version '${existingVersion.schema_version}' is not supported by this runtime (expected '${KERNEL_AUTHORITY_SCHEMA_VERSION}'). Refusing to open the store.`,
      );
    }
  }

  db.exec(SCHEMA_V1);

  const latestVersion = db.prepare(`SELECT schema_version FROM kernel_authority_store_versions ORDER BY id DESC LIMIT 1`).get() as
    | { schema_version: string }
    | undefined;
  if (latestVersion === undefined) {
    db.prepare(`INSERT INTO kernel_authority_store_versions (schema_version, migration_state, recorded_at) VALUES (?, 'current', ?)`).run(
      KERNEL_AUTHORITY_SCHEMA_VERSION,
      now(),
    );
  } else if (latestVersion.schema_version !== KERNEL_AUTHORITY_SCHEMA_VERSION) {
    db.close();
    throw new KernelAuthorityError(
      'KERNEL_AUTHORITY_VERSION_UNSUPPORTED',
      `Kernel Authority Store schema version '${latestVersion.schema_version}' is not supported by this runtime (expected '${KERNEL_AUTHORITY_SCHEMA_VERSION}'). Refusing to open the store.`,
    );
  }

  const insertRecord = db.prepare(`INSERT INTO kernel_authority_records
    (organization_id, entity_kind, entity_id, trust_domain_id, status, payload_json, payload_digest, provisioned_by, provisioned_at,
     revoked_by, revoked_at, revocation_reason, latest_sequence, latest_event_digest, schema_version)
    VALUES (@organizationId, @entityKind, @entityId, @trustDomainId, @status, @payloadJson, @payloadDigest, @provisionedBy, @provisionedAt,
            @revokedBy, @revokedAt, @revocationReason, @latestSequence, @latestEventDigest, @schemaVersion)`);
  const updateRecord = db.prepare(`UPDATE kernel_authority_records
    SET status = @status, revoked_by = @revokedBy, revoked_at = @revokedAt, revocation_reason = @revocationReason,
        latest_sequence = @latestSequence, latest_event_digest = @latestEventDigest
    WHERE organization_id = @organizationId AND entity_kind = @entityKind AND entity_id = @entityId`);
  const insertEvent = db.prepare(`INSERT INTO kernel_authority_events
    (event_id, organization_id, entity_kind, entity_id, sequence, event_type, payload_json, previous_event_digest, event_digest,
     provisioned_by, occurred_at, persisted_at, schema_version, runtime_version)
    VALUES (@eventId, @organizationId, @entityKind, @entityId, @sequence, @eventType, @payloadJson, @previousEventDigest, @eventDigest,
            @provisionedBy, @occurredAt, @persistedAt, @schemaVersion, @runtimeVersion)`);
  const insertIdempotency = db.prepare(
    `INSERT INTO kernel_authority_idempotency (organization_id, idempotency_key, payload_digest, entity_kind, entity_id, created_at)
     VALUES (@organizationId, @idempotencyKey, @payloadDigest, @entityKind, @entityId, @createdAt)`,
  );
  const insertExternalSubject = db.prepare(
    `INSERT INTO kernel_authority_external_subjects (organization_id, external_system, external_subject_id, actor_id, created_at)
     VALUES (@organizationId, @externalSystem, @externalSubjectId, @actorId, @createdAt)`,
  );

  const selectEventsByEntity = db.prepare(
    `SELECT * FROM kernel_authority_events WHERE organization_id = ? AND entity_kind = ? AND entity_id = ? ORDER BY sequence ASC`,
  );
  const selectIdempotencyClaim = db.prepare(`SELECT * FROM kernel_authority_idempotency WHERE organization_id = ? AND idempotency_key = ?`);
  const selectExternalSubject = db.prepare(
    `SELECT actor_id FROM kernel_authority_external_subjects WHERE organization_id = ? AND external_system = ? AND external_subject_id = ?`,
  );
  const selectChainHead = db.prepare(
    `SELECT latest_sequence, latest_event_digest FROM kernel_authority_records WHERE organization_id = ? AND entity_kind = ? AND entity_id = ?`,
  );
  const selectRecordKeys = db.prepare(
    `SELECT organization_id, entity_kind, entity_id FROM kernel_authority_records WHERE organization_id = ? ORDER BY entity_kind ASC, entity_id ASC`,
  );
  const countRecords = db.prepare(`SELECT COUNT(*) AS count FROM kernel_authority_records`);

  let closed = false;

  function assertOpen(): void {
    if (closed) throw new KernelAuthorityError('KERNEL_AUTHORITY_STORE_UNAVAILABLE', 'The Kernel Authority Store has been closed.');
  }

  function loadEvents(organizationId: string, entityKind: KernelAuthorityEntityKind, entityId: string): KernelAuthorityEvent[] {
    return (selectEventsByEntity.all(organizationId, entityKind, entityId) as EventRow[]).map(rowToEvent);
  }

  /**
   * Reconstructs from the canonical event chain, cross-checked against the
   * independently-written head on the projection row.
   *
   * The projection is a cache of state, but its head columns serve a second
   * purpose that is not caching at all: they are the only record of how long
   * the chain is supposed to be. Without comparing them, losing the last event
   * of a chain is undetectable -- and the last event is exactly where a
   * revocation lives.
   */
  function reconstructWithHead(organizationId: string, entityKind: KernelAuthorityEntityKind, entityId: string, events: readonly KernelAuthorityEvent[]): KernelAuthorityRecord {
    const head = selectChainHead.get(organizationId, entityKind, entityId) as { latest_sequence: number; latest_event_digest: string } | undefined;
    return reconstructKernelAuthorityRecord(
      events,
      head !== undefined ? { latestSequence: head.latest_sequence, latestEventDigest: head.latest_event_digest } : undefined,
    );
  }

  return {
    providerKind: 'sqlite',

    async appendEvent(context: KernelAuthorityAccessContext, input: AppendKernelAuthorityEventInput): Promise<AppendKernelAuthorityEventResult> {
      assertOpen();
      const operatorId = requireKernelAuthorityOperator(context);
      validateKernelAuthorityAppendInput(input);

      const runAppend = db.transaction((): AppendKernelAuthorityEventResult => {
        const existingEvents = loadEvents(input.organizationId, input.entityKind, input.entityId);
        const claimRow =
          input.idempotency !== undefined
            ? (selectIdempotencyClaim.get(input.organizationId, input.idempotency.idempotencyKey) as
                | { payload_digest: string; entity_kind: string; entity_id: string }
                | undefined)
            : undefined;
        const externalSubject =
          input.entityKind === 'actor' && input.eventType === 'KernelAuthorityEntityProvisioned' ? readExternalSubject(input.payload) : undefined;
        const boundRow =
          externalSubject !== undefined
            ? (selectExternalSubject.get(input.organizationId, externalSubject.system, externalSubject.subjectId) as { actor_id: string } | undefined)
            : undefined;

        const decision = decideKernelAuthorityAppend(input, {
          existingEvents,
          ...(claimRow !== undefined
            ? { idempotencyClaim: { payloadDigest: claimRow.payload_digest, entityKind: claimRow.entity_kind, entityId: claimRow.entity_id } }
            : {}),
          ...(boundRow !== undefined && boundRow.actor_id !== input.entityId ? { conflictingExternalSubjectActorId: boundRow.actor_id } : {}),
        });

        if (decision.outcome === 'replay') {
          // The entity needs no second event, but an unclaimed key still must
          // be pinned to this payload -- otherwise a key first used on a
          // replayed provision stays free, and can later be spent on a
          // different entity in the same organization.
          if (input.idempotency !== undefined && claimRow === undefined) {
            insertIdempotency.run({
              organizationId: input.organizationId,
              idempotencyKey: input.idempotency.idempotencyKey,
              payloadDigest: decision.payloadDigest,
              entityKind: input.entityKind,
              entityId: input.entityId,
              createdAt: now(),
            });
          }
          return { event: existingEvents[existingEvents.length - 1] as KernelAuthorityEvent, record: decision.record, replayed: true };
        }

        const timestamp = now();
        const event = buildKernelAuthorityEvent({
          eventId: nextId('kernel-authority-event'),
          organizationId: input.organizationId,
          entityKind: input.entityKind,
          entityId: input.entityId,
          eventType: input.eventType,
          sequence: decision.sequence,
          payload: input.payload,
          provisionedBy: operatorId,
          occurredAt: input.occurredAt ?? timestamp,
          persistedAt: timestamp,
          runtimeVersion,
          ...(decision.previousEventDigest !== undefined ? { previousEventDigest: decision.previousEventDigest } : {}),
        });

        const nextChain = [...existingEvents, event];
        const record = reconstructKernelAuthorityRecord(nextChain);

        // The projection row is written first so the event's foreign key
        // resolves inside the same transaction -- events are canonical, the
        // row is derived, and both commit or neither does.
        if (existingEvents.length === 0) {
          insertRecord.run({
            organizationId: record.organizationId,
            entityKind: record.entityKind,
            entityId: record.entityId,
            trustDomainId: record.trustDomainId ?? null,
            status: record.status,
            payloadJson: JSON.stringify(record.payload),
            payloadDigest: decision.payloadDigest,
            provisionedBy: record.provisionedBy,
            provisionedAt: record.provisionedAt,
            revokedBy: record.revokedBy ?? null,
            revokedAt: record.revokedAt ?? null,
            revocationReason: record.revocationReason ?? null,
            latestSequence: record.latestSequence,
            latestEventDigest: record.latestEventDigest,
            schemaVersion: KERNEL_AUTHORITY_SCHEMA_VERSION,
          });
        } else {
          updateRecord.run({
            organizationId: record.organizationId,
            entityKind: record.entityKind,
            entityId: record.entityId,
            status: record.status,
            revokedBy: record.revokedBy ?? null,
            revokedAt: record.revokedAt ?? null,
            revocationReason: record.revocationReason ?? null,
            latestSequence: record.latestSequence,
            latestEventDigest: record.latestEventDigest,
          });
        }

        insertEvent.run({
          eventId: event.eventId,
          organizationId: event.organizationId,
          entityKind: event.entityKind,
          entityId: event.entityId,
          sequence: event.sequence,
          eventType: event.eventType,
          payloadJson: JSON.stringify(event.payload),
          previousEventDigest: event.previousEventDigest ?? null,
          eventDigest: event.eventDigest,
          provisionedBy: event.provisionedBy,
          occurredAt: event.occurredAt,
          persistedAt: event.persistedAt,
          schemaVersion: event.schemaVersion,
          runtimeVersion: event.runtimeVersion,
        });

        if (input.idempotency !== undefined) {
          insertIdempotency.run({
            organizationId: input.organizationId,
            idempotencyKey: input.idempotency.idempotencyKey,
            payloadDigest: decision.payloadDigest,
            entityKind: input.entityKind,
            entityId: input.entityId,
            createdAt: timestamp,
          });
        }
        if (externalSubject !== undefined && boundRow === undefined) {
          insertExternalSubject.run({
            organizationId: input.organizationId,
            externalSystem: externalSubject.system,
            externalSubjectId: externalSubject.subjectId,
            actorId: input.entityId,
            createdAt: timestamp,
          });
        }

        return { event, record, replayed: false };
      });

      return runAppend();
    },

    async getRecord(context, organizationId, entityKind, entityId): Promise<KernelAuthorityRecord | null> {
      assertOpen();
      requireKernelAuthorityReadAccess(context, organizationId);
      const events = loadEvents(organizationId, entityKind, entityId);
      return events.length === 0 ? null : reconstructWithHead(organizationId, entityKind, entityId, events);
    },

    async listRecords(context, query: KernelAuthorityRecordQuery): Promise<readonly KernelAuthorityRecord[]> {
      assertOpen();
      requireKernelAuthorityReadAccess(context, query.organizationId);
      const keys = selectRecordKeys.all(query.organizationId) as RecordRow[];
      const records: KernelAuthorityRecord[] = [];
      for (const key of keys) {
        if (!isKernelAuthorityEntityKind(key.entity_kind)) {
          throw new KernelAuthorityError(
            'KERNEL_AUTHORITY_INTEGRITY_FAILED',
            `Persisted Kernel Authority record '${key.entity_kind}:${key.entity_id}' names an unknown entity kind. Refusing to hydrate a world from state this runtime cannot interpret.`,
          );
        }
        if (query.entityKind !== undefined && key.entity_kind !== query.entityKind) continue;
        // Replayed from the canonical event chain rather than read off the
        // projection row: the row is a cache, and a hydration must never
        // inherit a status the events do not support.
        const record = reconstructWithHead(query.organizationId, key.entity_kind, key.entity_id, loadEvents(query.organizationId, key.entity_kind, key.entity_id));
        if (query.trustDomainId !== undefined && record.trustDomainId !== query.trustDomainId) continue;
        if (query.status !== undefined && record.status !== query.status) continue;
        records.push(record);
      }
      return records.sort(compareKernelAuthorityRecords);
    },

    async listEvents(context, organizationId, entityKind, entityId): Promise<readonly KernelAuthorityEvent[]> {
      assertOpen();
      requireKernelAuthorityReadAccess(context, organizationId);
      return loadEvents(organizationId, entityKind, entityId);
    },

    async findActorByExternalSubject(
      context,
      organizationId: string,
      externalSubject: KernelAuthorityExternalSubject,
    ): Promise<KernelAuthorityRecord | null> {
      assertOpen();
      requireKernelAuthorityReadAccess(context, organizationId);
      const row = selectExternalSubject.get(organizationId, externalSubject.system, externalSubject.subjectId) as { actor_id: string } | undefined;
      if (row === undefined) return null;
      const events = loadEvents(organizationId, 'actor', row.actor_id);
      return events.length === 0 ? null : reconstructWithHead(organizationId, 'actor', row.actor_id, events);
    },

    async health(): Promise<KernelAuthorityStoreHealth> {
      if (closed) {
        return {
          providerKind: 'sqlite',
          status: 'unhealthy',
          readable: false,
          writable: false,
          schemaVersion: KERNEL_AUTHORITY_SCHEMA_VERSION,
          migrationState: 'closed',
          recordCount: 0,
        };
      }
      try {
        const { count } = countRecords.get() as { count: number };
        return {
          providerKind: 'sqlite',
          status: 'healthy',
          readable: true,
          writable: !db.readonly,
          schemaVersion: KERNEL_AUTHORITY_SCHEMA_VERSION,
          migrationState: 'current',
          recordCount: count,
        };
      } catch {
        // The driver's message is not reported: it can name the database file.
        return {
          providerKind: 'sqlite',
          status: 'unhealthy',
          readable: false,
          writable: false,
          schemaVersion: KERNEL_AUTHORITY_SCHEMA_VERSION,
          migrationState: 'unavailable',
          recordCount: 0,
        };
      }
    },

    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      db.close();
    },
  };
}
