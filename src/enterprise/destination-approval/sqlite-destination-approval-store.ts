import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { executionDestinationKey, parseExecutionDestination } from '../../features/destination-runtime/index.js';
import { isDestinationRegistryError, type DestinationRegistryReaderPort } from '../../features/destination-runtime/registry/index.js';
import {
  DestinationApprovalError,
  buildDestinationApproval,
  buildDestinationApprovalRevocation,
  deriveDestinationApprovalState,
  isCanonicalApprovalInstant,
  isDestinationApprovalError,
  isDestinationApprovalIdempotencyKey,
  isDestinationApprovalOrganizationId,
  isDestinationGovernanceReference,
  requireApproveDestinationCommand,
  requireDestinationApprovalQuery,
  requireDestinationGovernanceAuthority,
  requireRevokeDestinationCommand,
  sampleApprovalInstant,
  type ApproveDestinationCommand,
  type ApproveDestinationResult,
  type DestinationApproval,
  type DestinationApprovalHistoryEntry,
  type DestinationApprovalQuery,
  type DestinationApprovalRevocation,
  type DestinationApprovalState,
  type DestinationApprovalStorePort,
  type DestinationGovernanceAuthority,
  type RevokeDestinationCommand,
  type RevokeDestinationResult,
} from '../../features/destination-runtime/approval/index.js';
import {
  DESTINATION_APPROVAL_GENESIS_DIGEST,
  DESTINATION_APPROVAL_SCHEMA_VERSION,
  destinationApprovalCommandDigest,
  destinationApprovalEventDigest,
  destinationApprovalHeadDigest,
  destinationApprovalRequestDigest,
  isDestinationApprovalOperation,
  isDestinationApprovalTransition,
  isOutcomeOf,
  type DestinationApprovalCommandRecord,
  type DestinationApprovalEventRecord,
  type DestinationApprovalHeadRecord,
  type DestinationApprovalOperation,
} from './destination-approval-record.js';

/**
 * The durable destination approval store (ANDREW-P0-03) — the production
 * implementation of `DestinationApprovalStorePort`.
 *
 * ## Organization-scoped governance over a deployment-wide registry
 *
 * The P0-02 registry says which destinations Frontera *knows*. This store says
 * which of them each **organization** has approved, and it never writes the
 * registry: an approval requires the destination to already be `known`
 * (`DESTINATION_APPROVAL_DESTINATION_UNKNOWN` otherwise), and is never a way
 * to register one. The registry is append-only, so a destination found known
 * stays known; the two files need no shared transaction.
 *
 * ## Append-only history, a command journal, a head anchor
 *
 * ```
 * destination_approval_events    sequence (store-assigned, contiguous), organization_id,
 *                                destination_key, namespace, identifier, transition,
 *                                actor_ref, authority_basis, recorded_at, expires_at,
 *                                approval_sequence, previous_event_digest, event_digest
 * destination_approval_commands  (organization_id, idempotency_key) PRIMARY KEY,
 *                                operation, request_digest, outcome, event_sequence, ...
 * destination_approval_head      one row: latest sequence and digest, event and command counts
 * ```
 *
 * There is no current-state column anywhere. State is derived on every read
 * from the organization's events for the destination and the injected clock
 * (`deriveDestinationApprovalState`), so expiry needs no background job and
 * never mutates history. See `destination-approval-record.ts` for why the
 * chain and the head exist.
 *
 * ## Structural refusals, in depth
 *
 * Every write is one `BEGIN IMMEDIATE` transaction: verify the head (walking
 * the whole chain), resolve the idempotency key, derive current state, then
 * append. Beneath that, SQLite itself refuses:
 *
 * - `UPDATE` and `DELETE` of events and commands (triggers);
 * - an `approved` event while the same organization's latest event for the
 *   destination is an approval still unexpired at the new instant (trigger) —
 *   so concurrent approvals cannot create two active approvals;
 * - a `revoked` event that does not name that organization's latest, still
 *   active approval of the destination (trigger), and a second revocation of
 *   one approval (`UNIQUE (approval_sequence)`);
 * - a reused `(organization_id, idempotency_key)` (primary key).
 *
 * The triggers are defense in depth, as in the bounded-grant store: the
 * verification on read is what makes damage *detected* rather than obeyed.
 *
 * ## Verified on every read, never repaired
 *
 * A read walks the entire event chain from genesis and checks it against the
 * head, recounts the command journal, re-parses each destination through P0-01
 * and recomputes its key, and re-derives state. Any disagreement is
 * `DESTINATION_APPROVAL_CORRUPT` — never `never-approved`, never `approved`.
 * Cost is O(governance decisions), bounded by administrator actions, never by
 * request traffic. Verification is store-wide: damage anywhere refuses every
 * read, for every organization — the fail-closed side of that trade-off.
 *
 * ## What this is not
 *
 * - **Not action authorization.** An approved destination is not permission to
 *   send any amount of anything; that is a later Kernel/policy decision.
 * - **Not wired.** No Kernel, policy, grant, governed-action or trusted-context
 *   code reads this store yet (ANDREW-P0-04).
 * - **Not authenticity.** `actor_ref` and `authority_basis` are recorded
 *   provenance from the trusted authority context; no signature proves a row.
 * - **Not distributed.** Single-host SQLite, the repository's existing
 *   deployment assumption.
 */

export { DESTINATION_APPROVAL_SCHEMA_VERSION } from './destination-approval-record.js';

export interface CreateSqliteDestinationApprovalStoreOptions {
  /** The injected clock: sampled inside each write's `BEGIN IMMEDIATE` as the decision instant, and on each read as the instant expiry is judged at. Required. */
  readonly now: () => string;
  /** The P0-02 registry, read only: an approval requires the destination to be `known`. Required. */
  readonly registry: DestinationRegistryReaderPort;
  readonly busyTimeoutMs?: number;
}

/** The durable store, plus the lifecycle surface a host needs. */
export interface DurableDestinationApprovalStore extends DestinationApprovalStorePort {
  readonly providerKind: 'sqlite';
  close(): Promise<void>;
}

const DEFAULT_BUSY_TIMEOUT_MS = 5_000;
const MAXIMUM_BUSY_TIMEOUT_MS = 60_000;

const SCHEMA_V1 = `
  CREATE TABLE IF NOT EXISTS destination_approval_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    schema_version TEXT NOT NULL,
    migration_state TEXT NOT NULL,
    recorded_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS destination_approval_events (
    sequence INTEGER PRIMARY KEY CHECK (sequence >= 1),
    organization_id TEXT NOT NULL,
    destination_key TEXT NOT NULL,
    namespace TEXT NOT NULL,
    identifier TEXT NOT NULL,
    transition TEXT NOT NULL CHECK (transition IN ('approved', 'revoked')),
    actor_ref TEXT NOT NULL,
    authority_basis TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    expires_at TEXT,
    approval_sequence INTEGER UNIQUE,
    previous_event_digest TEXT NOT NULL,
    event_digest TEXT NOT NULL,
    schema_version TEXT NOT NULL,
    CHECK (
      (transition = 'approved' AND approval_sequence IS NULL)
      OR (transition = 'revoked' AND approval_sequence IS NOT NULL AND expires_at IS NULL)
    )
  );

  CREATE INDEX IF NOT EXISTS destination_approval_events_by_scope
    ON destination_approval_events (organization_id, destination_key, sequence);

  CREATE TABLE IF NOT EXISTS destination_approval_commands (
    organization_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    operation TEXT NOT NULL CHECK (operation IN ('approve', 'revoke')),
    request_digest TEXT NOT NULL,
    outcome TEXT NOT NULL,
    event_sequence INTEGER,
    destination_key TEXT NOT NULL,
    actor_ref TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    record_digest TEXT NOT NULL,
    schema_version TEXT NOT NULL,
    PRIMARY KEY (organization_id, idempotency_key)
  );

  CREATE TABLE IF NOT EXISTS destination_approval_head (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    event_sequence INTEGER NOT NULL,
    event_count INTEGER NOT NULL,
    event_digest TEXT NOT NULL,
    command_count INTEGER NOT NULL,
    head_digest TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    schema_version TEXT NOT NULL
  );

  CREATE TRIGGER IF NOT EXISTS destination_approval_events_append_only_update
    BEFORE UPDATE ON destination_approval_events
    BEGIN SELECT RAISE(ABORT, 'destination approval events are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS destination_approval_events_append_only_delete
    BEFORE DELETE ON destination_approval_events
    BEGIN SELECT RAISE(ABORT, 'destination approval events are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS destination_approval_commands_append_only_update
    BEFORE UPDATE ON destination_approval_commands
    BEGIN SELECT RAISE(ABORT, 'destination approval commands are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS destination_approval_commands_append_only_delete
    BEFORE DELETE ON destination_approval_commands
    BEGIN SELECT RAISE(ABORT, 'destination approval commands are immutable'); END;

  CREATE TRIGGER IF NOT EXISTS destination_approval_events_one_active_approval
    BEFORE INSERT ON destination_approval_events
    WHEN NEW.transition = 'approved' AND EXISTS (
      SELECT 1 FROM destination_approval_events latest
       WHERE latest.organization_id = NEW.organization_id
         AND latest.destination_key = NEW.destination_key
         AND latest.transition = 'approved'
         AND (latest.expires_at IS NULL OR latest.expires_at > NEW.recorded_at)
         AND latest.sequence = (
           SELECT MAX(scoped.sequence) FROM destination_approval_events scoped
            WHERE scoped.organization_id = NEW.organization_id AND scoped.destination_key = NEW.destination_key))
    BEGIN SELECT RAISE(ABORT, 'an approval of this destination is already active for this organization'); END;

  CREATE TRIGGER IF NOT EXISTS destination_approval_events_revoke_active_only
    BEFORE INSERT ON destination_approval_events
    WHEN NEW.transition = 'revoked' AND NOT EXISTS (
      SELECT 1 FROM destination_approval_events approval
       WHERE approval.sequence = NEW.approval_sequence
         AND approval.transition = 'approved'
         AND approval.organization_id = NEW.organization_id
         AND approval.destination_key = NEW.destination_key
         AND (approval.expires_at IS NULL OR approval.expires_at > NEW.recorded_at)
         AND approval.sequence = (
           SELECT MAX(scoped.sequence) FROM destination_approval_events scoped
            WHERE scoped.organization_id = NEW.organization_id AND scoped.destination_key = NEW.destination_key))
    BEGIN SELECT RAISE(ABORT, 'a revocation must end this organization''s active approval of this destination'); END;
`;

/** The state-bearing tables. The version table is the *marker* they are judged against, not one of them. */
const STATE_TABLES = ['destination_approval_events', 'destination_approval_commands', 'destination_approval_head'] as const;

interface EventRow {
  readonly sequence: unknown;
  readonly organization_id: unknown;
  readonly destination_key: unknown;
  readonly namespace: unknown;
  readonly identifier: unknown;
  readonly transition: unknown;
  readonly actor_ref: unknown;
  readonly authority_basis: unknown;
  readonly recorded_at: unknown;
  readonly expires_at: unknown;
  readonly approval_sequence: unknown;
  readonly previous_event_digest: unknown;
  readonly event_digest: unknown;
  readonly schema_version: unknown;
}

interface CommandRow {
  readonly organization_id: unknown;
  readonly idempotency_key: unknown;
  readonly operation: unknown;
  readonly request_digest: unknown;
  readonly outcome: unknown;
  readonly event_sequence: unknown;
  readonly destination_key: unknown;
  readonly actor_ref: unknown;
  readonly recorded_at: unknown;
  readonly record_digest: unknown;
  readonly schema_version: unknown;
}

interface HeadRow {
  readonly event_sequence: unknown;
  readonly event_count: unknown;
  readonly event_digest: unknown;
  readonly command_count: unknown;
  readonly head_digest: unknown;
  readonly updated_at: unknown;
  readonly schema_version: unknown;
}

function unavailable(message: string): DestinationApprovalError {
  return new DestinationApprovalError('DESTINATION_APPROVAL_UNAVAILABLE', message);
}

function corrupt(message: string): DestinationApprovalError {
  return new DestinationApprovalError('DESTINATION_APPROVAL_CORRUPT', `${message} Refused, never repaired.`);
}

function isPositiveSequence(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value);
}

/**
 * The event a row holds, re-derived rather than trusted — or `undefined`. The
 * destination goes back through P0-01's ingress and its key is recomputed;
 * the shape each transition requires is re-checked; the digest is recomputed
 * over every field.
 */
function parseEventRow(row: EventRow): DestinationApprovalEventRecord | undefined {
  if (row.schema_version !== DESTINATION_APPROVAL_SCHEMA_VERSION) return undefined;
  if (!isPositiveSequence(row.sequence)) return undefined;
  if (!isDestinationApprovalOrganizationId(row.organization_id)) return undefined;
  const parsed = parseExecutionDestination({ namespace: row.namespace, identifier: row.identifier });
  if (!parsed.valid) return undefined;
  if (row.destination_key !== executionDestinationKey(parsed.destination)) return undefined;
  if (!isDestinationApprovalTransition(row.transition)) return undefined;
  if (!isDestinationGovernanceReference(row.actor_ref) || !isDestinationGovernanceReference(row.authority_basis)) return undefined;
  if (!isCanonicalApprovalInstant(row.recorded_at)) return undefined;
  if (!isDigest(row.previous_event_digest) || !isDigest(row.event_digest)) return undefined;
  let expiresAt: string | null;
  let approvalSequence: number | null;
  if (row.transition === 'approved') {
    if (row.approval_sequence !== null) return undefined;
    if (row.expires_at !== null && !isCanonicalApprovalInstant(row.expires_at)) return undefined;
    expiresAt = row.expires_at;
    approvalSequence = null;
  } else {
    if (row.expires_at !== null) return undefined;
    if (!isPositiveSequence(row.approval_sequence) || row.approval_sequence >= row.sequence) return undefined;
    expiresAt = null;
    approvalSequence = row.approval_sequence;
  }
  const event: DestinationApprovalEventRecord = {
    sequence: row.sequence,
    organizationId: row.organization_id,
    destinationKey: row.destination_key,
    namespace: parsed.destination.namespace,
    identifier: parsed.destination.identifier,
    transition: row.transition,
    actorRef: row.actor_ref,
    authorityBasis: row.authority_basis,
    recordedAt: row.recorded_at,
    expiresAt,
    approvalSequence,
    previousEventDigest: row.previous_event_digest,
  };
  return destinationApprovalEventDigest(event) === row.event_digest ? event : undefined;
}

function parseCommandRow(row: CommandRow): DestinationApprovalCommandRecord | undefined {
  if (row.schema_version !== DESTINATION_APPROVAL_SCHEMA_VERSION) return undefined;
  if (!isDestinationApprovalOrganizationId(row.organization_id)) return undefined;
  if (!isDestinationApprovalIdempotencyKey(row.idempotency_key)) return undefined;
  if (!isDestinationApprovalOperation(row.operation)) return undefined;
  if (!isOutcomeOf(row.operation, row.outcome)) return undefined;
  if (!isDigest(row.request_digest) || !isDigest(row.record_digest)) return undefined;
  if (typeof row.destination_key !== 'string' || row.destination_key.length === 0) return undefined;
  if (!isDestinationGovernanceReference(row.actor_ref)) return undefined;
  if (!isCanonicalApprovalInstant(row.recorded_at)) return undefined;
  const eventSequence = row.event_sequence;
  if (row.outcome === 'not-active' ? eventSequence !== null : !isPositiveSequence(eventSequence)) return undefined;
  const command: DestinationApprovalCommandRecord = {
    organizationId: row.organization_id,
    idempotencyKey: row.idempotency_key,
    operation: row.operation,
    requestDigest: row.request_digest,
    outcome: row.outcome,
    eventSequence: eventSequence as number | null,
    destinationKey: row.destination_key,
    actorRef: row.actor_ref,
    recordedAt: row.recorded_at,
  };
  return destinationApprovalCommandDigest(command) === row.record_digest ? command : undefined;
}

function parseHeadRow(row: HeadRow): DestinationApprovalHeadRecord | undefined {
  if (row.schema_version !== DESTINATION_APPROVAL_SCHEMA_VERSION) return undefined;
  if (!isCount(row.event_sequence) || !isCount(row.event_count) || !isCount(row.command_count)) return undefined;
  if (!isDigest(row.event_digest) || !isDigest(row.head_digest)) return undefined;
  if (!isCanonicalApprovalInstant(row.updated_at)) return undefined;
  const head: DestinationApprovalHeadRecord = {
    eventSequence: row.event_sequence,
    eventCount: row.event_count,
    eventDigest: row.event_digest,
    commandCount: row.command_count,
    updatedAt: row.updated_at,
  };
  return destinationApprovalHeadDigest(head) === row.head_digest ? head : undefined;
}

function approvalOf(event: DestinationApprovalEventRecord): DestinationApproval {
  return buildDestinationApproval({
    organizationId: event.organizationId,
    destination: { namespace: event.namespace, identifier: event.identifier },
    sequence: event.sequence,
    approvedBy: event.actorRef,
    authorityBasis: event.authorityBasis,
    approvedAt: event.recordedAt,
    expiresAt: event.expiresAt,
  });
}

function revocationOf(event: DestinationApprovalEventRecord): DestinationApprovalRevocation {
  return buildDestinationApprovalRevocation({
    organizationId: event.organizationId,
    destinationKey: event.destinationKey,
    sequence: event.sequence,
    approvalSequence: event.approvalSequence ?? 0,
    revokedBy: event.actorRef,
    revocationBasis: event.authorityBasis,
    revokedAt: event.recordedAt,
  });
}

function entryOf(event: DestinationApprovalEventRecord): DestinationApprovalHistoryEntry {
  return event.transition === 'approved' ? Object.freeze({ transition: 'approved', approval: approvalOf(event) }) : Object.freeze({ transition: 'revoked', revocation: revocationOf(event) });
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

/**
 * Whether this file was initialized before — settled before any `CREATE`,
 * because recreating the schema erases the difference. Only a file with no
 * approval structure at all is `new`. A version table with no valid `current`
 * row, an unknown schema version, or approval tables with no version table are
 * each refused: initializing over them would mint a fresh, empty head over a
 * history that may have held revocations — the emergency-control store's
 * lesson (`classifyInitialization`), applied here.
 */
function classifyInitialization(db: import('better-sqlite3').Database): 'new' | 'initialized' {
  const stateTables = STATE_TABLES.filter((table) => tableExists(db, table));
  if (!tableExists(db, 'destination_approval_versions')) {
    if (stateTables.length > 0) throw unavailable('The destination approval database holds approval tables but no schema-version record. Refusing to open it rather than treating it as new.');
    return 'new';
  }
  const newest = db.prepare(`SELECT schema_version, migration_state FROM destination_approval_versions ORDER BY id DESC LIMIT 1`).get() as { schema_version: unknown; migration_state: unknown } | undefined;
  if (newest === undefined) throw unavailable('The destination approval database has a schema-version table but no version row. Refusing to open it rather than initializing over it.');
  if (newest.schema_version !== DESTINATION_APPROVAL_SCHEMA_VERSION) {
    throw unavailable(`The destination approval store is recorded under schema version '${String(newest.schema_version)}', which this runtime does not implement (expected '${DESTINATION_APPROVAL_SCHEMA_VERSION}'). Refusing to open it.`);
  }
  if (newest.migration_state !== 'current') throw unavailable('The destination approval store records an initialization that never completed. Refusing to open it.');
  return 'initialized';
}

function resolveOnDisk(dbPath: string): string {
  const absPath = resolve(dbPath);
  const dir = dirname(absPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return absPath;
}

export async function createSqliteDestinationApprovalStore(dbPath: string, options: CreateSqliteDestinationApprovalStoreOptions): Promise<DurableDestinationApprovalStore> {
  if (typeof dbPath !== 'string' || dbPath.trim().length === 0) throw unavailable('The destination approval store path must be a non-empty string.');
  if (typeof options?.now !== 'function') throw unavailable('The destination approval store requires an injected clock.');
  if (typeof options.registry?.lookup !== 'function') throw unavailable('The destination approval store requires the destination registry reader.');
  const busyTimeoutMs = resolveBusyTimeoutMs(options.busyTimeoutMs);
  const { now, registry } = options;
  const { default: Database } = await import('better-sqlite3');

  const path = dbPath === ':memory:' ? ':memory:' : resolveOnDisk(dbPath);
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = FULL');
  db.pragma(`busy_timeout = ${busyTimeoutMs}`);

  // Classification, schema, version marker and genesis head: one `BEGIN
  // IMMEDIATE`, so concurrent first openings initialize once and a refusal
  // leaves the file unmutated.
  try {
    db.transaction(() => {
      if (classifyInitialization(db) === 'new') {
        const at = sampleApprovalInstant(now);
        db.exec(SCHEMA_V1);
        db.prepare(`INSERT INTO destination_approval_versions (schema_version, migration_state, recorded_at) VALUES (?, 'current', ?)`).run(DESTINATION_APPROVAL_SCHEMA_VERSION, at);
        const genesis: DestinationApprovalHeadRecord = { eventSequence: 0, eventCount: 0, eventDigest: DESTINATION_APPROVAL_GENESIS_DIGEST, commandCount: 0, updatedAt: at };
        db.prepare(
          `INSERT INTO destination_approval_head (id, event_sequence, event_count, event_digest, command_count, head_digest, updated_at, schema_version) VALUES (1, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(genesis.eventSequence, genesis.eventCount, genesis.eventDigest, genesis.commandCount, destinationApprovalHeadDigest(genesis), at, DESTINATION_APPROVAL_SCHEMA_VERSION);
      } else {
        // Recreates a dropped table so statements can be prepared — empty, which
        // verification reads as damage. Never a version row, never a genesis head.
        db.exec(SCHEMA_V1);
      }
    }).immediate();
  } catch (error) {
    db.close();
    throw error;
  }

  const EVENT_COLUMNS = `sequence, organization_id, destination_key, namespace, identifier, transition, actor_ref, authority_basis, recorded_at, expires_at, approval_sequence, previous_event_digest, event_digest, schema_version`;
  const selectHead = db.prepare(`SELECT event_sequence, event_count, event_digest, command_count, head_digest, updated_at, schema_version FROM destination_approval_head WHERE id = 1`);
  const selectAllEvents = db.prepare(`SELECT ${EVENT_COLUMNS} FROM destination_approval_events ORDER BY sequence ASC`);
  const selectScopedEvents = db.prepare(`SELECT ${EVENT_COLUMNS} FROM destination_approval_events WHERE organization_id = ? AND destination_key = ? ORDER BY sequence ASC`);
  const selectEvent = db.prepare(`SELECT ${EVENT_COLUMNS} FROM destination_approval_events WHERE sequence = ?`);
  const countCommands = db.prepare(`SELECT COUNT(*) AS n FROM destination_approval_commands`);
  const selectCommand = db.prepare(
    `SELECT organization_id, idempotency_key, operation, request_digest, outcome, event_sequence, destination_key, actor_ref, recorded_at, record_digest, schema_version
       FROM destination_approval_commands WHERE organization_id = ? AND idempotency_key = ?`,
  );
  const insertEvent = db.prepare(
    `INSERT INTO destination_approval_events (${EVENT_COLUMNS})
     VALUES (@sequence, @organizationId, @destinationKey, @namespace, @identifier, @transition, @actorRef, @authorityBasis, @recordedAt, @expiresAt, @approvalSequence, @previousEventDigest, @eventDigest, @schemaVersion)`,
  );
  const insertCommand = db.prepare(
    `INSERT INTO destination_approval_commands (organization_id, idempotency_key, operation, request_digest, outcome, event_sequence, destination_key, actor_ref, recorded_at, record_digest, schema_version)
     VALUES (@organizationId, @idempotencyKey, @operation, @requestDigest, @outcome, @eventSequence, @destinationKey, @actorRef, @recordedAt, @recordDigest, @schemaVersion)`,
  );
  const updateHead = db.prepare(
    `UPDATE destination_approval_head
        SET event_sequence = @eventSequence, event_count = @eventCount, event_digest = @eventDigest, command_count = @commandCount,
            head_digest = @headDigest, updated_at = @updatedAt, schema_version = @schemaVersion
      WHERE id = 1`,
  );

  let closed = false;

  /**
   * The head, proven consistent with the **entire** event history and the
   * command journal's size. Contiguous from 1, every row re-parsed, every link
   * checked, so rewriting or deleting any event — not only the latest — breaks
   * verification; the command count catches a deleted command.
   */
  function verifiedHead(): DestinationApprovalHeadRecord {
    const headRow = selectHead.get() as HeadRow | undefined;
    const head = headRow === undefined ? undefined : parseHeadRow(headRow);
    if (head === undefined) throw corrupt('The destination approval head is missing or failed verification.');
    let expectedPrevious = DESTINATION_APPROVAL_GENESIS_DIGEST;
    let verified = 0;
    for (const row of selectAllEvents.all() as readonly EventRow[]) {
      if (row.sequence !== verified + 1) throw corrupt('The destination approval history is not contiguous.');
      const event = parseEventRow(row);
      if (event === undefined) throw corrupt('A destination approval event failed verification.');
      if (event.previousEventDigest !== expectedPrevious) throw corrupt('The destination approval history chain is broken.');
      expectedPrevious = row.event_digest as string;
      verified += 1;
    }
    if (verified !== head.eventCount || verified !== head.eventSequence || expectedPrevious !== head.eventDigest) throw corrupt('The destination approval head does not describe the recorded history.');
    if ((countCommands.get() as { n: number }).n !== head.commandCount) throw corrupt('The destination approval command journal does not match the head.');
    return head;
  }

  function scopedEntries(organizationId: string, destinationKey: string): readonly DestinationApprovalHistoryEntry[] {
    return (selectScopedEvents.all(organizationId, destinationKey) as readonly EventRow[]).map((row) => {
      const event = parseEventRow(row);
      if (event === undefined || event.organizationId !== organizationId || event.destinationKey !== destinationKey) throw corrupt('A destination approval event failed verification.');
      return entryOf(event);
    });
  }

  function loadEvent(sequence: number, organizationId: string, destinationKey: string, transition: DestinationApprovalEventRecord['transition']): DestinationApprovalEventRecord {
    const row = selectEvent.get(sequence) as EventRow | undefined;
    const event = row === undefined ? undefined : parseEventRow(row);
    if (event === undefined || event.organizationId !== organizationId || event.destinationKey !== destinationKey || event.transition !== transition) {
      throw corrupt('A recorded command does not name the event it produced.');
    }
    return event;
  }

  /** The recorded command for this key in this organization, verified — or `undefined` if the key is unused. */
  function loadCommand(organizationId: string, idempotencyKey: string): DestinationApprovalCommandRecord | undefined {
    const row = selectCommand.get(organizationId, idempotencyKey) as CommandRow | undefined;
    if (row === undefined) return undefined;
    const command = parseCommandRow(row);
    if (command === undefined || command.organizationId !== organizationId || command.idempotencyKey !== idempotencyKey) throw corrupt('A recorded destination approval command failed verification.');
    return command;
  }

  /** A key already used: the same request replays, any other request is refused. */
  function replayable(command: DestinationApprovalCommandRecord, operation: DestinationApprovalOperation, requestDigest: string): DestinationApprovalCommandRecord {
    if (command.operation !== operation || command.requestDigest !== requestDigest) {
      throw new DestinationApprovalError('DESTINATION_APPROVAL_IDEMPOTENCY_CONFLICT', 'This idempotency key was already used in this organization for a different request. Nothing was written.');
    }
    return command;
  }

  /** Appends one event and/or one command, and moves the head, in the caller's transaction. */
  function append(
    head: DestinationApprovalHeadRecord,
    event: Omit<DestinationApprovalEventRecord, 'sequence' | 'previousEventDigest'> | undefined,
    command: Omit<DestinationApprovalCommandRecord, 'eventSequence'> & { readonly eventSequence: number | null | 'new' },
  ): number | null {
    let next = { ...head, commandCount: head.commandCount + 1, updatedAt: command.recordedAt };
    let newSequence: number | null = null;
    if (event !== undefined) {
      const record: DestinationApprovalEventRecord = { ...event, sequence: head.eventSequence + 1, previousEventDigest: head.eventDigest };
      const eventDigest = destinationApprovalEventDigest(record);
      insertEvent.run({ ...record, eventDigest, schemaVersion: DESTINATION_APPROVAL_SCHEMA_VERSION });
      newSequence = record.sequence;
      next = { ...next, eventSequence: record.sequence, eventCount: head.eventCount + 1, eventDigest };
    }
    const eventSequence = command.eventSequence === 'new' ? newSequence : command.eventSequence;
    const recorded: DestinationApprovalCommandRecord = { ...command, eventSequence };
    insertCommand.run({ ...recorded, recordDigest: destinationApprovalCommandDigest(recorded), schemaVersion: DESTINATION_APPROVAL_SCHEMA_VERSION });
    updateHead.run({ ...next, headDigest: destinationApprovalHeadDigest(next), schemaVersion: DESTINATION_APPROVAL_SCHEMA_VERSION });
    return newSequence;
  }

  const runRead = db.transaction((query: DestinationApprovalQuery): { readonly state: DestinationApprovalState; readonly history: readonly DestinationApprovalHistoryEntry[] } => {
    const at = sampleApprovalInstant(now);
    verifiedHead();
    const destinationKey = executionDestinationKey(query.destination);
    const history = scopedEntries(query.organizationId, destinationKey);
    return { state: deriveDestinationApprovalState(query.organizationId, destinationKey, history, at), history };
  });

  const runApprove = db.transaction((authority: DestinationGovernanceAuthority, command: Required<ApproveDestinationCommand>): ApproveDestinationResult => {
    // Sampled after the write lock is held, however long it waited.
    const at = sampleApprovalInstant(now);
    const head = verifiedHead();
    const { organizationId, actorRef, authorityBasis } = authority;
    const destinationKey = executionDestinationKey(command.destination);
    const requestDigest = destinationApprovalRequestDigest({ operation: 'approve', destinationKey, expiresAt: command.expiresAt, actorRef });

    const recorded = loadCommand(organizationId, command.idempotencyKey);
    if (recorded !== undefined) {
      const replay = replayable(recorded, 'approve', requestDigest);
      const approval = approvalOf(loadEvent(replay.eventSequence ?? 0, organizationId, destinationKey, 'approved'));
      return Object.freeze({ outcome: replay.outcome as ApproveDestinationResult['outcome'], approval, replayed: true });
    }

    // Registration is a precondition, never a side effect: an unknown
    // destination is refused, and nothing here can register one.
    if (registry.lookup(command.destination).membership !== 'known') {
      throw new DestinationApprovalError('DESTINATION_APPROVAL_DESTINATION_UNKNOWN', 'The destination is not known to the destination registry, so it cannot be approved. Nothing was written.');
    }

    const commandFields = { organizationId, idempotencyKey: command.idempotencyKey, operation: 'approve' as const, requestDigest, destinationKey, actorRef, recordedAt: at };
    const state = deriveDestinationApprovalState(organizationId, destinationKey, scopedEntries(organizationId, destinationKey), at);
    if (state.state === 'approved') {
      // The first active approval stands, with its original provenance and terms.
      append(head, undefined, { ...commandFields, outcome: 'already-approved', eventSequence: state.approval.sequence });
      return Object.freeze({ outcome: 'already-approved', approval: state.approval, replayed: false });
    }
    if (command.expiresAt !== null && !(Date.parse(command.expiresAt) > Date.parse(at))) {
      throw new DestinationApprovalError('DESTINATION_APPROVAL_INPUT_INVALID', 'expiresAt must be later than the instant the approval is recorded. Nothing was written.');
    }
    const sequence = append(
      head,
      {
        organizationId,
        destinationKey,
        namespace: command.destination.namespace,
        identifier: command.destination.identifier,
        transition: 'approved',
        actorRef,
        authorityBasis,
        recordedAt: at,
        expiresAt: command.expiresAt,
        approvalSequence: null,
      },
      { ...commandFields, outcome: 'approved', eventSequence: 'new' },
    );
    const approval = buildDestinationApproval({ organizationId, destination: command.destination, sequence: sequence ?? 0, approvedBy: actorRef, authorityBasis, approvedAt: at, expiresAt: command.expiresAt });
    return Object.freeze({ outcome: 'approved', approval, replayed: false });
  });

  const runRevoke = db.transaction((authority: DestinationGovernanceAuthority, command: RevokeDestinationCommand): RevokeDestinationResult => {
    const at = sampleApprovalInstant(now);
    const head = verifiedHead();
    const { organizationId, actorRef, authorityBasis } = authority;
    const destinationKey = executionDestinationKey(command.destination);
    const requestDigest = destinationApprovalRequestDigest({ operation: 'revoke', destinationKey, expiresAt: null, actorRef });

    const recorded = loadCommand(organizationId, command.idempotencyKey);
    if (recorded !== undefined) {
      const replay = replayable(recorded, 'revoke', requestDigest);
      if (replay.outcome === 'not-active') return Object.freeze({ outcome: 'not-active', destinationKey, replayed: true });
      const revocation = revocationOf(loadEvent(replay.eventSequence ?? 0, organizationId, destinationKey, 'revoked'));
      return Object.freeze({ outcome: replay.outcome as 'revoked' | 'already-revoked', revocation, replayed: true });
    }

    const commandFields = { organizationId, idempotencyKey: command.idempotencyKey, operation: 'revoke' as const, requestDigest, destinationKey, actorRef, recordedAt: at };
    const state = deriveDestinationApprovalState(organizationId, destinationKey, scopedEntries(organizationId, destinationKey), at);
    if (state.state === 'revoked') {
      append(head, undefined, { ...commandFields, outcome: 'already-revoked', eventSequence: state.revocation.sequence });
      return Object.freeze({ outcome: 'already-revoked', revocation: state.revocation, replayed: false });
    }
    if (state.state !== 'approved') {
      // Never approved, or already expired: nothing is active, so nothing is revoked.
      append(head, undefined, { ...commandFields, outcome: 'not-active', eventSequence: null });
      return Object.freeze({ outcome: 'not-active', destinationKey, replayed: false });
    }
    const sequence = append(
      head,
      {
        organizationId,
        destinationKey,
        namespace: command.destination.namespace,
        identifier: command.destination.identifier,
        transition: 'revoked',
        actorRef,
        authorityBasis,
        recordedAt: at,
        expiresAt: null,
        approvalSequence: state.approval.sequence,
      },
      { ...commandFields, outcome: 'revoked', eventSequence: 'new' },
    );
    const revocation = buildDestinationApprovalRevocation({
      organizationId,
      destinationKey,
      sequence: sequence ?? 0,
      approvalSequence: state.approval.sequence,
      revokedBy: actorRef,
      revocationBasis: authorityBasis,
      revokedAt: at,
    });
    return Object.freeze({ outcome: 'revoked', revocation, replayed: false });
  });

  function assertOpen(): void {
    if (closed) throw unavailable('The destination approval store has been closed.');
  }

  /** A driver failure is reported as the condition, never as driver text; typed refusals pass through unchanged. */
  function guarded<T>(operation: () => T): T {
    try {
      return operation();
    } catch (error) {
      if (isDestinationApprovalError(error) || isDestinationRegistryError(error)) throw error;
      throw unavailable('The destination approval store could not complete the operation. Nothing was written.');
    }
  }

  return {
    providerKind: 'sqlite',

    read(query: DestinationApprovalQuery): DestinationApprovalState {
      assertOpen();
      const checked = requireDestinationApprovalQuery(query);
      return guarded(() => runRead(checked).state);
    },

    history(query: DestinationApprovalQuery): readonly DestinationApprovalHistoryEntry[] {
      assertOpen();
      const checked = requireDestinationApprovalQuery(query);
      // Derived as well as returned, so inconsistent history is refused here too.
      return guarded(() => Object.freeze([...runRead(checked).history]));
    },

    approve(authority: DestinationGovernanceAuthority, command: ApproveDestinationCommand): ApproveDestinationResult {
      assertOpen();
      const trusted = requireDestinationGovernanceAuthority(authority);
      const checked = requireApproveDestinationCommand(command);
      // BEGIN IMMEDIATE; durable before this returns (`synchronous = FULL`).
      return guarded(() => runApprove.immediate(trusted, checked));
    },

    revoke(authority: DestinationGovernanceAuthority, command: RevokeDestinationCommand): RevokeDestinationResult {
      assertOpen();
      const trusted = requireDestinationGovernanceAuthority(authority);
      const checked = requireRevokeDestinationCommand(command);
      return guarded(() => runRevoke.immediate(trusted, checked));
    },

    async close(): Promise<void> {
      if (!closed) {
        closed = true;
        db.close();
      }
    },
  };
}
