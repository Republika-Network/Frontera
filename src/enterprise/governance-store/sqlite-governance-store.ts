import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type BetterSqlite3 from 'better-sqlite3';

import type { KernelEvaluationRequest, KernelEvaluationResult, KernelTrace } from '../../kernel/index.js';
import type { EnterpriseEvent } from '../events/enterprise-events.js';
import {
  GOVERNANCE_MIGRATION_SOURCE_PR_002,
  GOVERNANCE_REFERENCE_INTEGRITY_VERSION,
  GOVERNANCE_STORE_SCHEMA_VERSION,
  type AppendGovernanceEvaluationInput,
  type AppendGovernanceEvaluationResult,
  type GovernanceEventRecord,
  type GovernanceEvaluationRecord,
  type GovernanceIdempotencyProbe,
  type GovernanceIdempotencyResolution,
  type GovernanceIntegrityMetadata,
  type GovernanceRecord,
  type GovernanceRecordLoadResult,
  type GovernanceRecordMetadata,
  type GovernanceRecordVerificationResult,
  type GovernanceReferenceChainState,
  type GovernanceReferenceInput,
  type GovernanceReferenceRecord,
  type GovernanceRequestRecord,
  type GovernanceStoreAccessContext,
  type GovernanceStoreHealth,
  type GovernanceGovernedPathFilter,
  type GovernanceStoreCountQuery,
  type GovernanceStoreQuery,
  type GovernanceStoreQueryResult,
  type GovernanceTraceRecord,
  type GovernanceReasonRecord,
} from './contracts.js';
import { GovernanceStoreError } from './errors.js';
import type { EnterpriseEventRecord, EnterpriseVersionRecord, GovernanceStore, PersistEvaluationInput, PersistEvaluationResult } from './governance-store.js';
import { buildGovernanceAggregate, computeAggregateDigest, computeGovernanceRequestPayloadDigest, metadataDigestInput, type GovernanceAggregate } from './projection.js';
import { computeDigest } from './digest.js';
import { sealGovernanceReference } from './reference-integrity.js';
import { verifyGovernanceRecordIntegrity } from './verification.js';
import { resolveStoreOptions, toLegacyAppendInput, type CreateGovernanceStoreOptions } from './in-memory-governance-store.js';
import {
  assertCanonicalReferenceType,
  canSeeRecord,
  decodeQueryCursor,
  encodeQueryCursor,
  legacyEventToRecord,
  normalizeQueryLimit,
  recordToLegacyEvent,
  requireReadScope,
  resolveQueryOrganization,
  toKernelTrace,
  toStandaloneEventRecord,
} from './store-common.js';

/** SQLite-specific construction options. `busyTimeoutMs` bounds waits on a locked database file instead of failing immediately with SQLITE_BUSY. */
export interface CreateSqliteGovernanceStoreOptions extends CreateGovernanceStoreOptions {
  readonly busyTimeoutMs?: number;
}

const DEFAULT_BUSY_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------------------
// Schema v1 (`aoc.governance-store.schema.v1`)
//
// Note on naming: the PR-002 tables (`GovernanceRequests`, `GovernanceEvaluations`,
// `GovernanceTraces`, `RuntimeEvents`, `RuntimeVersions`) are left completely
// untouched — SQLite identifiers are case-insensitive but the v1 snake_case
// names differ by their underscores, so both generations coexist. Migration
// *copies* legacy rows into v1 tables; it never renames, drops, or rewrites
// the originals.
// ---------------------------------------------------------------------------

const SCHEMA_V1 = `
  CREATE TABLE IF NOT EXISTS governance_store_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    schema_version TEXT NOT NULL,
    migration_state TEXT NOT NULL,
    details_json TEXT,
    recorded_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS governance_requests (
    record_id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL UNIQUE,
    correlation_id TEXT,
    organization_id TEXT,
    actor_id TEXT NOT NULL,
    actor_type TEXT,
    action_type TEXT NOT NULL,
    action_domain TEXT,
    resource_scope TEXT NOT NULL,
    target_type TEXT,
    target_id TEXT,
    requested_at TEXT NOT NULL,
    received_at TEXT NOT NULL,
    request_contract TEXT NOT NULL,
    request_payload_json TEXT NOT NULL,
    payload_digest TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_gov_requests_correlation ON governance_requests(correlation_id);
  CREATE INDEX IF NOT EXISTS idx_gov_requests_org_time ON governance_requests(organization_id, requested_at);
  CREATE INDEX IF NOT EXISTS idx_gov_requests_actor_time ON governance_requests(actor_id, requested_at);
  CREATE INDEX IF NOT EXISTS idx_gov_requests_action_time ON governance_requests(action_type, requested_at);

  CREATE TABLE IF NOT EXISTS governance_evaluations (
    record_id TEXT PRIMARY KEY,
    evaluation_id TEXT NOT NULL UNIQUE,
    decision_id TEXT NOT NULL UNIQUE,
    request_id TEXT NOT NULL REFERENCES governance_requests(request_id),
    correlation_id TEXT,
    status TEXT NOT NULL,
    summary TEXT NOT NULL,
    reason_codes_json TEXT NOT NULL,
    evaluated_at TEXT NOT NULL,
    persisted_at TEXT NOT NULL,
    kernel_version TEXT NOT NULL,
    enterprise_version TEXT NOT NULL,
    evaluation_contract TEXT NOT NULL,
    result_payload_json TEXT NOT NULL,
    result_digest TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_gov_evaluations_request ON governance_evaluations(request_id);
  CREATE INDEX IF NOT EXISTS idx_gov_evaluations_correlation ON governance_evaluations(correlation_id);
  CREATE INDEX IF NOT EXISTS idx_gov_evaluations_status_time ON governance_evaluations(status, evaluated_at);
  CREATE INDEX IF NOT EXISTS idx_gov_evaluations_kernel_version ON governance_evaluations(kernel_version);
  CREATE INDEX IF NOT EXISTS idx_gov_evaluations_enterprise_version ON governance_evaluations(enterprise_version);

  CREATE TABLE IF NOT EXISTS governance_trace_steps (
    trace_record_id TEXT PRIMARY KEY,
    evaluation_id TEXT NOT NULL REFERENCES governance_evaluations(evaluation_id),
    sequence INTEGER NOT NULL,
    operator TEXT NOT NULL,
    status TEXT NOT NULL,
    reason_codes_json TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT,
    metadata_json TEXT,
    trace_contract TEXT NOT NULL,
    trace_digest TEXT NOT NULL,
    UNIQUE(evaluation_id, sequence)
  );

  CREATE TABLE IF NOT EXISTS governance_reason_codes (
    reason_record_id TEXT PRIMARY KEY,
    evaluation_id TEXT NOT NULL REFERENCES governance_evaluations(evaluation_id),
    sequence INTEGER NOT NULL,
    reason_code TEXT NOT NULL,
    UNIQUE(evaluation_id, sequence)
  );
  CREATE INDEX IF NOT EXISTS idx_gov_reasons_code ON governance_reason_codes(reason_code);
  CREATE INDEX IF NOT EXISTS idx_gov_reasons_eval_code ON governance_reason_codes(evaluation_id, reason_code);

  CREATE TABLE IF NOT EXISTS governance_events (
    event_id TEXT PRIMARY KEY,
    event_type TEXT NOT NULL,
    aggregate_type TEXT NOT NULL,
    aggregate_id TEXT NOT NULL,
    request_id TEXT,
    decision_id TEXT,
    correlation_id TEXT,
    causation_id TEXT,
    sequence INTEGER,
    occurred_at TEXT NOT NULL,
    persisted_at TEXT NOT NULL,
    enterprise_version TEXT NOT NULL,
    kernel_version TEXT,
    event_contract TEXT NOT NULL,
    event_payload_json TEXT NOT NULL,
    event_digest TEXT NOT NULL,
    UNIQUE(aggregate_type, aggregate_id, sequence)
  );
  CREATE INDEX IF NOT EXISTS idx_gov_events_aggregate ON governance_events(aggregate_type, aggregate_id);
  CREATE INDEX IF NOT EXISTS idx_gov_events_request ON governance_events(request_id);
  CREATE INDEX IF NOT EXISTS idx_gov_events_correlation ON governance_events(correlation_id);
  CREATE INDEX IF NOT EXISTS idx_gov_events_causation ON governance_events(causation_id);
  CREATE INDEX IF NOT EXISTS idx_gov_events_type_time ON governance_events(event_type, occurred_at);

  CREATE TABLE IF NOT EXISTS governance_record_metadata (
    metadata_id TEXT PRIMARY KEY,
    evaluation_id TEXT NOT NULL UNIQUE REFERENCES governance_evaluations(evaluation_id),
    enterprise_version TEXT NOT NULL,
    kernel_version TEXT NOT NULL,
    lifecycle_state TEXT NOT NULL,
    module_snapshot_json TEXT NOT NULL,
    provider_snapshot_json TEXT,
    environment TEXT,
    build_version TEXT,
    created_at TEXT NOT NULL,
    schema_version TEXT NOT NULL,
    migration_source TEXT
  );

  CREATE TABLE IF NOT EXISTS governance_integrity (
    integrity_id TEXT PRIMARY KEY,
    evaluation_id TEXT NOT NULL UNIQUE REFERENCES governance_evaluations(evaluation_id),
    algorithm TEXT NOT NULL,
    canonicalization_version TEXT NOT NULL,
    request_digest TEXT NOT NULL,
    evaluation_digest TEXT NOT NULL,
    trace_digest TEXT NOT NULL,
    events_digest TEXT NOT NULL,
    metadata_digest TEXT NOT NULL,
    aggregate_digest TEXT NOT NULL,
    previous_aggregate_digest TEXT,
    chain_position INTEGER NOT NULL UNIQUE,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS governance_idempotency (
    scope TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    request_digest TEXT NOT NULL,
    evaluation_id TEXT NOT NULL REFERENCES governance_evaluations(evaluation_id),
    created_at TEXT NOT NULL,
    PRIMARY KEY(scope, idempotency_key)
  );

  CREATE TABLE IF NOT EXISTS governance_references (
    reference_id TEXT PRIMARY KEY,
    evaluation_id TEXT NOT NULL REFERENCES governance_evaluations(evaluation_id),
    reference_type TEXT NOT NULL,
    external_id TEXT NOT NULL,
    external_version TEXT,
    digest TEXT,
    uri TEXT,
    created_at TEXT NOT NULL,
    -- Reference-integrity columns. Nullable on purpose: rows written before
    -- this feature existed genuinely have no integrity metadata, and
    -- back-filling one would claim protection that never existed. See
    -- ensureReferenceIntegritySchema for the additive upgrade of an
    -- existing database.
    sequence INTEGER,
    reference_integrity_version TEXT,
    previous_reference_digest TEXT,
    reference_digest TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_gov_references_evaluation ON governance_references(evaluation_id);
  -- The chain-position index and governance_reference_chains are created by
  -- ensureReferenceIntegritySchema, not here: on a pre-hardening database this
  -- CREATE TABLE is a no-op and the sequence column does not exist yet, so an
  -- index over it must wait until after the ALTER TABLEs.

  CREATE TABLE IF NOT EXISTS RuntimeVersions (
    boot_id          TEXT PRIMARY KEY,
    runtime_version  TEXT NOT NULL,
    kernel_version   TEXT NOT NULL,
    recorded_at      TEXT NOT NULL
  );
`;

// -- row shapes -------------------------------------------------------------

interface RequestRow {
  readonly record_id: string;
  readonly request_id: string;
  readonly correlation_id: string | null;
  readonly organization_id: string | null;
  readonly actor_id: string;
  readonly actor_type: string | null;
  readonly action_type: string;
  readonly action_domain: string | null;
  readonly resource_scope: string;
  readonly target_type: string | null;
  readonly target_id: string | null;
  readonly requested_at: string;
  readonly received_at: string;
  readonly request_contract: string;
  readonly request_payload_json: string;
  readonly payload_digest: string;
}

interface EvaluationRow {
  readonly record_id: string;
  readonly evaluation_id: string;
  readonly decision_id: string;
  readonly request_id: string;
  readonly correlation_id: string | null;
  readonly status: string;
  readonly summary: string;
  readonly reason_codes_json: string;
  readonly evaluated_at: string;
  readonly persisted_at: string;
  readonly kernel_version: string;
  readonly enterprise_version: string;
  readonly evaluation_contract: string;
  readonly result_payload_json: string;
  readonly result_digest: string;
}

interface TraceRow {
  readonly trace_record_id: string;
  readonly evaluation_id: string;
  readonly sequence: number;
  readonly operator: string;
  readonly status: string;
  readonly reason_codes_json: string;
  readonly started_at: string | null;
  readonly completed_at: string | null;
  readonly metadata_json: string | null;
  readonly trace_contract: string;
  readonly trace_digest: string;
}

interface ReasonRow {
  readonly reason_record_id: string;
  readonly evaluation_id: string;
  readonly sequence: number;
  readonly reason_code: string;
}

interface EventRow {
  readonly event_id: string;
  readonly event_type: string;
  readonly aggregate_type: string;
  readonly aggregate_id: string;
  readonly request_id: string | null;
  readonly decision_id: string | null;
  readonly correlation_id: string | null;
  readonly causation_id: string | null;
  readonly sequence: number | null;
  readonly occurred_at: string;
  readonly persisted_at: string;
  readonly enterprise_version: string;
  readonly kernel_version: string | null;
  readonly event_contract: string;
  readonly event_payload_json: string;
  readonly event_digest: string;
}

interface MetadataRow {
  readonly metadata_id: string;
  readonly evaluation_id: string;
  readonly enterprise_version: string;
  readonly kernel_version: string;
  readonly lifecycle_state: string;
  readonly module_snapshot_json: string;
  readonly provider_snapshot_json: string | null;
  readonly environment: string | null;
  readonly build_version: string | null;
  readonly created_at: string;
  readonly schema_version: string;
  readonly migration_source: string | null;
}

interface IntegrityRow {
  readonly integrity_id: string;
  readonly evaluation_id: string;
  readonly algorithm: string;
  readonly canonicalization_version: string;
  readonly request_digest: string;
  readonly evaluation_digest: string;
  readonly trace_digest: string;
  readonly events_digest: string;
  readonly metadata_digest: string;
  readonly aggregate_digest: string;
  readonly previous_aggregate_digest: string | null;
  readonly chain_position: number;
  readonly created_at: string;
}

interface ReferenceRow {
  readonly reference_id: string;
  readonly evaluation_id: string;
  readonly reference_type: string;
  readonly external_id: string;
  readonly external_version: string | null;
  readonly digest: string | null;
  readonly uri: string | null;
  readonly created_at: string;
  readonly sequence: number | null;
  readonly reference_integrity_version: string | null;
  readonly previous_reference_digest: string | null;
  readonly reference_digest: string | null;
}

interface ReferenceChainRow {
  readonly evaluation_id: string;
  readonly integrity_version: string;
  readonly latest_sequence: number;
  readonly latest_reference_digest: string;
  readonly updated_at: string;
}

interface IdempotencyRow {
  readonly scope: string;
  readonly idempotency_key: string;
  readonly request_digest: string;
  readonly evaluation_id: string;
  readonly created_at: string;
}

interface StoreVersionRow {
  readonly schema_version: string;
  readonly migration_state: string;
  readonly recorded_at: string;
}

// -- legacy (PR-002) row shapes, read-only during migration ------------------

interface LegacyRequestRow {
  readonly request_id: string;
  readonly received_at: string;
  readonly request_payload: string;
}

interface LegacyEvaluationRow {
  readonly decision_id: string;
  readonly request_id: string;
  readonly status: string;
  readonly reason_codes: string;
  readonly summary: string;
  readonly kernel_version: string;
  readonly evaluated_at: string;
  readonly correlation_id: string | null;
}

interface LegacyTraceRow {
  readonly decision_id: string;
  readonly steps_json: string;
}

interface LegacyEventRow {
  readonly event_id: string;
  readonly event_type: string;
  readonly request_id: string;
  readonly decision_id: string | null;
  readonly correlation_id: string | null;
  readonly occurred_at: string;
  readonly payload: string;
}

function sqliteErrorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

function resolveOnDisk(dbPath: string): string {
  const absPath = resolve(dbPath);
  const dir = dirname(absPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return absPath;
}

function parseJson<T>(json: string, what: string, failures: string[]): T | undefined {
  try {
    return JSON.parse(json) as T;
  } catch {
    failures.push(`${what} contains invalid JSON.`);
    return undefined;
  }
}

/**
 * The query filters as SQL, shared by `query` and `count` so the two can never
 * select different records. Mirrors `matchesQueryFilters` (`store-common.ts`).
 */
function filterClauses(context: GovernanceStoreAccessContext, query: GovernanceStoreCountQuery, organizationId: string | undefined): { clauses: string[]; params: (string | number)[] } {
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (organizationId !== undefined) {
    clauses.push('r.organization_id = ?');
    params.push(organizationId);
  } else if (!context.system) {
    // requireReadScope already rejected this; defensive.
    clauses.push('1 = 0');
  }
  if (query.requestId !== undefined) { clauses.push('e.request_id = ?'); params.push(query.requestId); }
  if (query.evaluationId !== undefined) { clauses.push('e.evaluation_id = ?'); params.push(query.evaluationId); }
  if (query.decisionId !== undefined) { clauses.push('e.decision_id = ?'); params.push(query.decisionId); }
  if (query.correlationId !== undefined) { clauses.push('e.correlation_id = ?'); params.push(query.correlationId); }
  if (query.actorId !== undefined) { clauses.push('r.actor_id = ?'); params.push(query.actorId); }
  if (query.actionType !== undefined) { clauses.push('r.action_type = ?'); params.push(query.actionType); }
  if (query.status !== undefined) { clauses.push('e.status = ?'); params.push(query.status); }
  if (query.reasonCode !== undefined) {
    clauses.push('EXISTS (SELECT 1 FROM governance_reason_codes rc WHERE rc.evaluation_id = e.evaluation_id AND rc.reason_code = ?)');
    params.push(query.reasonCode);
  }
  if (query.governedPath !== undefined) clauses.push(GOVERNED_PATH_SQL[query.governedPath]);
  if (query.from !== undefined) { clauses.push('e.evaluated_at >= ?'); params.push(query.from); }
  if (query.to !== undefined) { clauses.push('e.evaluated_at <= ?'); params.push(query.to); }
  return { clauses, params };
}

/** A claim row of this evaluation (`execution_record`, `attempt`). */
const CLAIM_ROW = `SELECT 1 FROM governance_references c WHERE c.evaluation_id = e.evaluation_id AND c.reference_type = 'execution_record' AND c.external_version = 'attempt'`;

/** `isDefinitiveExecutionEvidence` (`store-common.ts`) as exact prefixes — `substr`, never a case-insensitive `LIKE`. */
const DEFINITIVE_ROW_FOR_CLAIM = `SELECT 1 FROM governance_references o
  WHERE o.evaluation_id = c.evaluation_id AND o.reference_type = 'execution_record' AND o.external_id = c.external_id
    AND (o.external_version = 'executed' OR substr(o.external_version, 1, 9) = 'executed@' OR substr(o.external_version, 1, 17) = 'execution-failed:'
         OR substr(o.external_version, 1, 9) = 'withheld:' OR substr(o.external_version, 1, 9) = 'resolved:')`;

/** PROD-03-01 — `GovernanceStoreQuery.governedPath` in SQL. Constant text: no value is interpolated. */
const GOVERNED_PATH_SQL: Readonly<Record<GovernanceGovernedPathFilter, string>> = Object.freeze({
  'execution-claimed': `EXISTS (${CLAIM_ROW})`,
  'execution-open': `EXISTS (${CLAIM_ROW} AND NOT EXISTS (${DEFINITIVE_ROW_FOR_CLAIM}))`,
  'issuance-withheld': `EXISTS (SELECT 1 FROM governance_references g WHERE g.evaluation_id = e.evaluation_id AND g.reference_type = 'issuance_record')`,
});

/**
 * Durable Governance Store v1 backed by SQLite (`better-sqlite3`, loaded
 * lazily; hand-written SQL, no ORM). Pragmas: `foreign_keys = ON` (every
 * documented FK is enforced), `journal_mode = WAL` (concurrent readers
 * during writes; PR-002 already used WAL), `synchronous = FULL` (a
 * governance record store chooses commit durability over write throughput),
 * `busy_timeout` (bounded waits instead of immediate SQLITE_BUSY).
 *
 * Every evaluation append is one `db.transaction(...)` — better-sqlite3 is
 * synchronous, so a transaction can never interleave with another in-process
 * caller, and cross-process writers are serialized by SQLite's own locking
 * plus the uniqueness constraints.
 */
function resolveBusyTimeoutMs(value: number | undefined): number {
  const timeout = value ?? DEFAULT_BUSY_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout <= 0) {
    throw new RangeError(`busyTimeoutMs must be a positive integer, received '${String(value)}'.`);
  }
  return timeout;
}

export async function createSqliteGovernanceStore(dbPath: string, options: CreateSqliteGovernanceStoreOptions = {}): Promise<GovernanceStore> {
  const { default: Database } = await import('better-sqlite3');
  const resolved = resolveStoreOptions(options);

  const path = dbPath === ':memory:' ? ':memory:' : resolveOnDisk(dbPath);
  const db = new Database(path);
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = FULL');
  db.pragma(`busy_timeout = ${resolveBusyTimeoutMs(options.busyTimeoutMs)}`);

  initSchemaAndMigrate(db, resolved.now);

  // -- prepared statements ---------------------------------------------------

  const insertRequest = db.prepare(`INSERT INTO governance_requests
    (record_id, request_id, correlation_id, organization_id, actor_id, actor_type, action_type, action_domain, resource_scope, target_type, target_id, requested_at, received_at, request_contract, request_payload_json, payload_digest, created_at)
    VALUES (@recordId, @requestId, @correlationId, @organizationId, @actorId, @actorType, @actionType, @actionDomain, @resourceScope, @targetType, @targetId, @requestedAt, @receivedAt, @requestContract, @requestPayloadJson, @payloadDigest, @createdAt)`);
  const insertEvaluation = db.prepare(`INSERT INTO governance_evaluations
    (record_id, evaluation_id, decision_id, request_id, correlation_id, status, summary, reason_codes_json, evaluated_at, persisted_at, kernel_version, enterprise_version, evaluation_contract, result_payload_json, result_digest, created_at)
    VALUES (@recordId, @evaluationId, @decisionId, @requestId, @correlationId, @status, @summary, @reasonCodesJson, @evaluatedAt, @persistedAt, @kernelVersion, @enterpriseVersion, @evaluationContract, @resultPayloadJson, @resultDigest, @createdAt)`);
  const insertTrace = db.prepare(`INSERT INTO governance_trace_steps
    (trace_record_id, evaluation_id, sequence, operator, status, reason_codes_json, started_at, completed_at, metadata_json, trace_contract, trace_digest)
    VALUES (@traceRecordId, @evaluationId, @sequence, @operator, @status, @reasonCodesJson, @startedAt, @completedAt, @metadataJson, @traceContract, @traceDigest)`);
  const insertReason = db.prepare(`INSERT INTO governance_reason_codes (reason_record_id, evaluation_id, sequence, reason_code) VALUES (@reasonRecordId, @evaluationId, @sequence, @reasonCode)`);
  const insertEvent = db.prepare(`INSERT INTO governance_events
    (event_id, event_type, aggregate_type, aggregate_id, request_id, decision_id, correlation_id, causation_id, sequence, occurred_at, persisted_at, enterprise_version, kernel_version, event_contract, event_payload_json, event_digest)
    VALUES (@eventId, @eventType, @aggregateType, @aggregateId, @requestId, @decisionId, @correlationId, @causationId, @sequence, @occurredAt, @persistedAt, @enterpriseVersion, @kernelVersion, @eventContract, @eventPayloadJson, @eventDigest)`);
  const insertMetadata = db.prepare(`INSERT INTO governance_record_metadata
    (metadata_id, evaluation_id, enterprise_version, kernel_version, lifecycle_state, module_snapshot_json, provider_snapshot_json, environment, build_version, created_at, schema_version, migration_source)
    VALUES (@metadataId, @evaluationId, @enterpriseVersion, @kernelVersion, @lifecycleState, @moduleSnapshotJson, @providerSnapshotJson, @environment, @buildVersion, @createdAt, @schemaVersion, @migrationSource)`);
  const insertIntegrity = db.prepare(`INSERT INTO governance_integrity
    (integrity_id, evaluation_id, algorithm, canonicalization_version, request_digest, evaluation_digest, trace_digest, events_digest, metadata_digest, aggregate_digest, previous_aggregate_digest, chain_position, created_at)
    VALUES (@integrityId, @evaluationId, @algorithm, @canonicalizationVersion, @requestDigest, @evaluationDigest, @traceDigest, @eventsDigest, @metadataDigest, @aggregateDigest, @previousAggregateDigest, @chainPosition, @createdAt)`);
  const insertIdempotency = db.prepare(`INSERT INTO governance_idempotency (scope, idempotency_key, request_digest, evaluation_id, created_at) VALUES (@scope, @idempotencyKey, @requestDigest, @evaluationId, @createdAt)`);
  const insertReference = db.prepare(`INSERT INTO governance_references
    (reference_id, evaluation_id, reference_type, external_id, external_version, digest, uri, created_at, sequence, reference_integrity_version, previous_reference_digest, reference_digest)
    VALUES (@referenceId, @evaluationId, @referenceType, @externalId, @externalVersion, @digest, @uri, @createdAt, @sequence, @integrityVersion, @previousReferenceDigest, @referenceDigest)`);
  // The chain head is a *projection* of the append-only reference rows, not a
  // record of its own; advancing it in the same transaction is what makes
  // deletion of the newest references detectable.
  const upsertReferenceChain = db.prepare(`INSERT INTO governance_reference_chains (evaluation_id, integrity_version, latest_sequence, latest_reference_digest, updated_at)
    VALUES (@evaluationId, @integrityVersion, @latestSequence, @latestReferenceDigest, @updatedAt)
    ON CONFLICT(evaluation_id) DO UPDATE SET
      integrity_version = excluded.integrity_version,
      latest_sequence = excluded.latest_sequence,
      latest_reference_digest = excluded.latest_reference_digest,
      updated_at = excluded.updated_at`);
  const selectReferenceChain = db.prepare(`SELECT * FROM governance_reference_chains WHERE evaluation_id = ?`);

  const selectRequestByRequestId = db.prepare(`SELECT * FROM governance_requests WHERE request_id = ?`);
  const selectEvaluationByEvaluationId = db.prepare(`SELECT * FROM governance_evaluations WHERE evaluation_id = ?`);
  const selectEvaluationByRequestId = db.prepare(`SELECT * FROM governance_evaluations WHERE request_id = ?`);
  const selectEvaluationByDecisionId = db.prepare(`SELECT * FROM governance_evaluations WHERE decision_id = ?`);
  const selectTraceByEvaluationId = db.prepare(`SELECT * FROM governance_trace_steps WHERE evaluation_id = ? ORDER BY sequence ASC`);
  const selectReasonsByEvaluationId = db.prepare(`SELECT * FROM governance_reason_codes WHERE evaluation_id = ? ORDER BY sequence ASC`);
  const selectEventsByAggregate = db.prepare(`SELECT * FROM governance_events WHERE aggregate_type = ? AND aggregate_id = ? ORDER BY sequence ASC, rowid ASC`);
  const selectMetadataByEvaluationId = db.prepare(`SELECT * FROM governance_record_metadata WHERE evaluation_id = ?`);
  const selectIntegrityByEvaluationId = db.prepare(`SELECT * FROM governance_integrity WHERE evaluation_id = ?`);
  const selectIntegrityByChainPosition = db.prepare(`SELECT * FROM governance_integrity WHERE chain_position = ?`);
  const selectChainHead = db.prepare(`SELECT aggregate_digest, chain_position FROM governance_integrity ORDER BY chain_position DESC LIMIT 1`);
  const selectReferencesByEvaluationId = db.prepare(`SELECT * FROM governance_references WHERE evaluation_id = ? ORDER BY created_at ASC, rowid ASC`);
  const selectIdempotencyByKey = db.prepare(`SELECT * FROM governance_idempotency WHERE scope = ? AND idempotency_key = ?`);
  const selectMaxEventSequence = db.prepare(`SELECT MAX(sequence) AS max_sequence FROM governance_events WHERE aggregate_type = ? AND aggregate_id = ?`);
  const selectLatestStoreVersion = db.prepare(`SELECT schema_version, migration_state, recorded_at FROM governance_store_versions ORDER BY id DESC LIMIT 1`);

  const insertVersion = db.prepare(`INSERT INTO RuntimeVersions (boot_id, runtime_version, kernel_version, recorded_at) VALUES (@bootId, @enterpriseVersion, @kernelVersion, @recordedAt)`);
  const selectLatestVersion = db.prepare(`SELECT * FROM RuntimeVersions ORDER BY recorded_at DESC, rowid DESC LIMIT 1`);

  let closed = false;

  function assertOpen(): void {
    if (closed) throw new GovernanceStoreError('GOVERNANCE_STORE_UNAVAILABLE', 'The Governance Store has been closed.');
  }

  // -- row mapping -----------------------------------------------------------

  function rowToRequestRecord(row: RequestRow, failures: string[]): GovernanceRequestRecord | undefined {
    const payload = parseJson<Readonly<Record<string, unknown>>>(row.request_payload_json, `governance_requests.request_payload_json (${row.request_id})`, failures);
    if (payload === undefined) return undefined;
    return {
      recordId: row.record_id,
      requestId: row.request_id,
      ...(row.correlation_id !== null ? { correlationId: row.correlation_id } : {}),
      actorId: row.actor_id,
      ...(row.actor_type !== null ? { actorType: row.actor_type } : {}),
      ...(row.organization_id !== null ? { organizationId: row.organization_id } : {}),
      actionType: row.action_type,
      ...(row.action_domain !== null ? { actionDomain: row.action_domain } : {}),
      resourceScope: row.resource_scope,
      ...(row.target_type !== null ? { targetType: row.target_type } : {}),
      ...(row.target_id !== null ? { targetId: row.target_id } : {}),
      requestedAt: row.requested_at,
      receivedAt: row.received_at,
      requestContract: row.request_contract,
      requestPayload: payload,
      payloadDigest: row.payload_digest,
    };
  }

  function rowToEvaluationRecord(row: EvaluationRow, failures: string[]): GovernanceEvaluationRecord | undefined {
    const reasonCodes = parseJson<readonly string[]>(row.reason_codes_json, `governance_evaluations.reason_codes_json (${row.evaluation_id})`, failures);
    const resultPayload = parseJson<Readonly<Record<string, unknown>>>(row.result_payload_json, `governance_evaluations.result_payload_json (${row.evaluation_id})`, failures);
    if (reasonCodes === undefined || resultPayload === undefined) return undefined;
    return {
      recordId: row.record_id,
      evaluationId: row.evaluation_id,
      decisionId: row.decision_id,
      requestId: row.request_id,
      ...(row.correlation_id !== null ? { correlationId: row.correlation_id } : {}),
      status: row.status as GovernanceEvaluationRecord['status'],
      summary: row.summary,
      reasonCodes,
      evaluatedAt: row.evaluated_at,
      persistedAt: row.persisted_at,
      kernelVersion: row.kernel_version,
      enterpriseVersion: row.enterprise_version,
      evaluationContract: row.evaluation_contract,
      resultPayload,
      resultDigest: row.result_digest,
    };
  }

  function rowToTraceRecord(row: TraceRow, failures: string[]): GovernanceTraceRecord | undefined {
    const reasonCodes = parseJson<readonly string[]>(row.reason_codes_json, `governance_trace_steps.reason_codes_json (${row.trace_record_id})`, failures);
    if (reasonCodes === undefined) return undefined;
    let metadata: Readonly<Record<string, unknown>> | undefined;
    if (row.metadata_json !== null) {
      metadata = parseJson<Readonly<Record<string, unknown>>>(row.metadata_json, `governance_trace_steps.metadata_json (${row.trace_record_id})`, failures);
      if (metadata === undefined) return undefined;
    }
    return {
      traceRecordId: row.trace_record_id,
      evaluationId: row.evaluation_id,
      sequence: row.sequence,
      operator: row.operator,
      status: row.status,
      reasonCodes,
      ...(row.started_at !== null ? { startedAt: row.started_at } : {}),
      ...(row.completed_at !== null ? { completedAt: row.completed_at } : {}),
      ...(metadata !== undefined ? { metadata } : {}),
      traceContract: row.trace_contract,
      traceDigest: row.trace_digest,
    };
  }

  function rowToEventRecord(row: EventRow, failures: string[]): GovernanceEventRecord | undefined {
    const payload = parseJson<Readonly<Record<string, unknown>>>(row.event_payload_json, `governance_events.event_payload_json (${row.event_id})`, failures);
    if (payload === undefined) return undefined;
    return {
      eventId: row.event_id,
      eventType: row.event_type,
      aggregateType: row.aggregate_type as GovernanceEventRecord['aggregateType'],
      aggregateId: row.aggregate_id,
      ...(row.request_id !== null ? { requestId: row.request_id } : {}),
      ...(row.decision_id !== null ? { decisionId: row.decision_id } : {}),
      ...(row.correlation_id !== null ? { correlationId: row.correlation_id } : {}),
      ...(row.causation_id !== null ? { causationId: row.causation_id } : {}),
      ...(row.sequence !== null ? { sequence: row.sequence } : {}),
      occurredAt: row.occurred_at,
      persistedAt: row.persisted_at,
      enterpriseVersion: row.enterprise_version,
      ...(row.kernel_version !== null ? { kernelVersion: row.kernel_version } : {}),
      eventContract: row.event_contract,
      eventPayload: payload,
      eventDigest: row.event_digest,
    };
  }

  function rowToMetadataRecord(row: MetadataRow, failures: string[]): GovernanceRecordMetadata | undefined {
    const moduleSnapshot = parseJson<GovernanceRecordMetadata['moduleSnapshot']>(row.module_snapshot_json, `governance_record_metadata.module_snapshot_json (${row.metadata_id})`, failures);
    if (moduleSnapshot === undefined) return undefined;
    let providerSnapshot: GovernanceRecordMetadata['providerSnapshot'];
    if (row.provider_snapshot_json !== null) {
      providerSnapshot = parseJson<NonNullable<GovernanceRecordMetadata['providerSnapshot']>>(row.provider_snapshot_json, `governance_record_metadata.provider_snapshot_json (${row.metadata_id})`, failures);
      if (providerSnapshot === undefined) return undefined;
    }
    return {
      metadataId: row.metadata_id,
      evaluationId: row.evaluation_id,
      enterpriseVersion: row.enterprise_version,
      kernelVersion: row.kernel_version,
      lifecycleState: row.lifecycle_state,
      moduleSnapshot,
      ...(providerSnapshot !== undefined ? { providerSnapshot } : {}),
      ...(row.environment !== null ? { environment: row.environment } : {}),
      ...(row.build_version !== null ? { buildVersion: row.build_version } : {}),
      createdAt: row.created_at,
      schemaVersion: row.schema_version,
      ...(row.migration_source !== null ? { migrationSource: row.migration_source } : {}),
    };
  }

  function rowToIntegrityRecord(row: IntegrityRow): GovernanceIntegrityMetadata {
    return {
      integrityId: row.integrity_id,
      evaluationId: row.evaluation_id,
      algorithm: row.algorithm as GovernanceIntegrityMetadata['algorithm'],
      canonicalizationVersion: row.canonicalization_version,
      requestDigest: row.request_digest,
      evaluationDigest: row.evaluation_digest,
      traceDigest: row.trace_digest,
      eventsDigest: row.events_digest,
      metadataDigest: row.metadata_digest,
      aggregateDigest: row.aggregate_digest,
      ...(row.previous_aggregate_digest !== null ? { previousAggregateDigest: row.previous_aggregate_digest } : {}),
      chainPosition: row.chain_position,
      createdAt: row.created_at,
    };
  }

  function rowToReferenceRecord(row: ReferenceRow): GovernanceReferenceRecord {
    return {
      referenceId: row.reference_id,
      evaluationId: row.evaluation_id,
      // Deliberately permissive: the write path (`assertCanonicalReferenceType`)
      // is what keeps unknown values out of this column. Reads never reject a
      // stored value, so history written before a vocabulary addition — and
      // rows written by a newer runtime — stay readable instead of turning an
      // otherwise intact aggregate into a corruption error.
      referenceType: row.reference_type as GovernanceReferenceRecord['referenceType'],
      externalId: row.external_id,
      ...(row.external_version !== null ? { externalVersion: row.external_version } : {}),
      ...(row.digest !== null ? { digest: row.digest } : {}),
      ...(row.uri !== null ? { uri: row.uri } : {}),
      createdAt: row.created_at,
      // Integrity columns are mapped exactly as stored — including partially
      // present ones. Normalizing a half-written row into a clean legacy row
      // here would hide precisely the tampering the verifier exists to catch.
      ...(row.sequence !== null ? { sequence: row.sequence } : {}),
      ...(row.reference_integrity_version !== null ? { integrityVersion: row.reference_integrity_version } : {}),
      ...(row.previous_reference_digest !== null ? { previousReferenceDigest: row.previous_reference_digest } : {}),
      ...(row.reference_digest !== null ? { referenceDigest: row.reference_digest } : {}),
    };
  }

  function rowToReferenceChainState(row: ReferenceChainRow): GovernanceReferenceChainState {
    return {
      evaluationId: row.evaluation_id,
      integrityVersion: row.integrity_version,
      latestSequence: row.latest_sequence,
      latestReferenceDigest: row.latest_reference_digest,
      updatedAt: row.updated_at,
    };
  }

  // -- aggregate loading -----------------------------------------------------

  function loadAggregate(evaluationId: string): GovernanceRecordLoadResult {
    const missing: string[] = [];
    const failures: string[] = [];

    const evaluationRow = selectEvaluationByEvaluationId.get(evaluationId) as EvaluationRow | undefined;
    if (evaluationRow === undefined) {
      return { status: 'incomplete', missingComponents: ['evaluation'], integrityFailures: [] };
    }
    const requestRow = selectRequestByRequestId.get(evaluationRow.request_id) as RequestRow | undefined;
    const metadataRow = selectMetadataByEvaluationId.get(evaluationId) as MetadataRow | undefined;
    const integrityRow = selectIntegrityByEvaluationId.get(evaluationId) as IntegrityRow | undefined;
    if (requestRow === undefined) missing.push('request');
    if (metadataRow === undefined) missing.push('metadata');
    if (integrityRow === undefined) missing.push('integrity');
    if (missing.length > 0) {
      return { status: 'incomplete', missingComponents: missing, integrityFailures: [] };
    }

    const request = rowToRequestRecord(requestRow as RequestRow, failures);
    const evaluation = rowToEvaluationRecord(evaluationRow, failures);
    const metadata = rowToMetadataRecord(metadataRow as MetadataRow, failures);
    const traceRows = selectTraceByEvaluationId.all(evaluationId) as TraceRow[];
    const trace: GovernanceTraceRecord[] = [];
    for (const row of traceRows) {
      const record = rowToTraceRecord(row, failures);
      if (record !== undefined) trace.push(record);
    }
    const reasonRows = selectReasonsByEvaluationId.all(evaluationId) as ReasonRow[];
    const reasons: GovernanceReasonRecord[] = reasonRows.map((row) => ({
      reasonRecordId: row.reason_record_id,
      evaluationId: row.evaluation_id,
      sequence: row.sequence,
      reasonCode: row.reason_code,
    }));
    const eventRows = selectEventsByAggregate.all('governance_evaluation', evaluationId) as EventRow[];
    const events: GovernanceEventRecord[] = [];
    for (const row of eventRows) {
      const record = rowToEventRecord(row, failures);
      if (record !== undefined) events.push(record);
    }
    const references = (selectReferencesByEvaluationId.all(evaluationId) as ReferenceRow[]).map(rowToReferenceRecord);

    if (failures.length > 0 || request === undefined || evaluation === undefined || metadata === undefined) {
      return { status: 'corrupted', missingComponents: [], integrityFailures: failures };
    }
    if (metadata.schemaVersion !== GOVERNANCE_STORE_SCHEMA_VERSION) {
      return { status: 'corrupted', missingComponents: [], integrityFailures: [`Unsupported schema version '${metadata.schemaVersion}'.`] };
    }

    const record: GovernanceRecord = {
      recordId: evaluation.recordId,
      request,
      evaluation,
      trace,
      reasons,
      events,
      metadata,
      integrity: rowToIntegrityRecord(integrityRow as IntegrityRow),
      references,
    };
    return { status: 'complete', record, missingComponents: [], integrityFailures: [] };
  }

  function loadVisibleRecord(context: GovernanceStoreAccessContext, evaluationId: string | undefined): GovernanceRecord | null {
    requireReadScope(context);
    if (evaluationId === undefined) return null;
    const loaded = loadAggregate(evaluationId);
    if (loaded.status === 'incomplete' && loaded.missingComponents.length === 1 && loaded.missingComponents[0] === 'evaluation') return null;
    if (loaded.status !== 'complete' || loaded.record === undefined) {
      throw new GovernanceStoreError('GOVERNANCE_RECORD_CORRUPTED', `The stored aggregate for evaluationId '${evaluationId}' is ${loaded.status}.`, {
        missingComponents: loaded.missingComponents,
        integrityFailures: loaded.integrityFailures,
      });
    }
    if (!canSeeRecord(context, loaded.record.request.organizationId)) return null;
    return loaded.record;
  }

  // -- idempotency -----------------------------------------------------------

  function resolveIdempotencySync(context: GovernanceStoreAccessContext, probe: GovernanceIdempotencyProbe): GovernanceIdempotencyResolution {
    if (probe.idempotency !== undefined) {
      const claim = selectIdempotencyByKey.get(probe.idempotency.scope, probe.idempotency.idempotencyKey) as IdempotencyRow | undefined;
      if (claim !== undefined) {
        if (claim.request_digest !== probe.payloadDigest) return { kind: 'conflict', conflictKind: 'idempotency-key' };
        const record = loadVisibleRecord(context, claim.evaluation_id);
        if (record === null) return { kind: 'conflict', conflictKind: 'idempotency-key' };
        return { kind: 'replay', record };
      }
    }
    const existingRequest = selectRequestByRequestId.get(probe.requestId) as RequestRow | undefined;
    if (existingRequest !== undefined) {
      if (existingRequest.payload_digest !== probe.payloadDigest) return { kind: 'conflict', conflictKind: 'request-id' };
      const evaluationRow = selectEvaluationByRequestId.get(probe.requestId) as EvaluationRow | undefined;
      const record = evaluationRow !== undefined ? loadVisibleRecord(context, evaluationRow.evaluation_id) : null;
      if (record === null) return { kind: 'conflict', conflictKind: 'request-id' };
      return { kind: 'replay', record };
    }
    return { kind: 'new' };
  }

  // -- append transaction ------------------------------------------------------

  function insertAggregateRows(aggregate: GovernanceAggregate, idempotency: AppendGovernanceEvaluationInput['idempotency'], payloadDigest: string): void {
    const { record } = aggregate;
    insertRequest.run({
      recordId: record.request.recordId,
      requestId: record.request.requestId,
      correlationId: record.request.correlationId ?? null,
      organizationId: record.request.organizationId ?? null,
      actorId: record.request.actorId,
      actorType: record.request.actorType ?? null,
      actionType: record.request.actionType,
      actionDomain: record.request.actionDomain ?? null,
      resourceScope: record.request.resourceScope,
      targetType: record.request.targetType ?? null,
      targetId: record.request.targetId ?? null,
      requestedAt: record.request.requestedAt,
      receivedAt: record.request.receivedAt,
      requestContract: record.request.requestContract,
      requestPayloadJson: JSON.stringify(record.request.requestPayload),
      payloadDigest: record.request.payloadDigest,
      createdAt: record.evaluation.persistedAt,
    });
    insertEvaluation.run({
      recordId: record.evaluation.recordId,
      evaluationId: record.evaluation.evaluationId,
      decisionId: record.evaluation.decisionId,
      requestId: record.evaluation.requestId,
      correlationId: record.evaluation.correlationId ?? null,
      status: record.evaluation.status,
      summary: record.evaluation.summary,
      reasonCodesJson: JSON.stringify(record.evaluation.reasonCodes),
      evaluatedAt: record.evaluation.evaluatedAt,
      persistedAt: record.evaluation.persistedAt,
      kernelVersion: record.evaluation.kernelVersion,
      enterpriseVersion: record.evaluation.enterpriseVersion,
      evaluationContract: record.evaluation.evaluationContract,
      resultPayloadJson: JSON.stringify(record.evaluation.resultPayload),
      resultDigest: record.evaluation.resultDigest,
      createdAt: record.evaluation.persistedAt,
    });
    for (const reason of record.reasons) {
      insertReason.run({ reasonRecordId: reason.reasonRecordId, evaluationId: reason.evaluationId, sequence: reason.sequence, reasonCode: reason.reasonCode });
    }
    for (const step of record.trace) {
      insertTrace.run({
        traceRecordId: step.traceRecordId,
        evaluationId: step.evaluationId,
        sequence: step.sequence,
        operator: step.operator,
        status: step.status,
        reasonCodesJson: JSON.stringify(step.reasonCodes),
        startedAt: step.startedAt ?? null,
        completedAt: step.completedAt ?? null,
        metadataJson: step.metadata !== undefined ? JSON.stringify(step.metadata) : null,
        traceContract: step.traceContract,
        traceDigest: step.traceDigest,
      });
    }
    for (const event of record.events) {
      insertEvent.run({
        eventId: event.eventId,
        eventType: event.eventType,
        aggregateType: event.aggregateType,
        aggregateId: event.aggregateId,
        requestId: event.requestId ?? null,
        decisionId: event.decisionId ?? null,
        correlationId: event.correlationId ?? null,
        causationId: event.causationId ?? null,
        sequence: event.sequence ?? null,
        occurredAt: event.occurredAt,
        persistedAt: event.persistedAt,
        enterpriseVersion: event.enterpriseVersion,
        kernelVersion: event.kernelVersion ?? null,
        eventContract: event.eventContract,
        eventPayloadJson: JSON.stringify(event.eventPayload),
        eventDigest: event.eventDigest,
      });
    }
    insertMetadata.run({
      metadataId: record.metadata.metadataId,
      evaluationId: record.metadata.evaluationId,
      enterpriseVersion: record.metadata.enterpriseVersion,
      kernelVersion: record.metadata.kernelVersion,
      lifecycleState: record.metadata.lifecycleState,
      moduleSnapshotJson: JSON.stringify(record.metadata.moduleSnapshot),
      providerSnapshotJson: record.metadata.providerSnapshot !== undefined ? JSON.stringify(record.metadata.providerSnapshot) : null,
      environment: record.metadata.environment ?? null,
      buildVersion: record.metadata.buildVersion ?? null,
      createdAt: record.metadata.createdAt,
      schemaVersion: record.metadata.schemaVersion,
      migrationSource: record.metadata.migrationSource ?? null,
    });
    insertIntegrity.run({
      integrityId: record.integrity.integrityId,
      evaluationId: record.integrity.evaluationId,
      algorithm: record.integrity.algorithm,
      canonicalizationVersion: record.integrity.canonicalizationVersion,
      requestDigest: record.integrity.requestDigest,
      evaluationDigest: record.integrity.evaluationDigest,
      traceDigest: record.integrity.traceDigest,
      eventsDigest: record.integrity.eventsDigest,
      metadataDigest: record.integrity.metadataDigest,
      aggregateDigest: record.integrity.aggregateDigest,
      previousAggregateDigest: record.integrity.previousAggregateDigest ?? null,
      chainPosition: record.integrity.chainPosition,
      createdAt: record.integrity.createdAt,
    });
    if (idempotency !== undefined) {
      insertIdempotency.run({
        scope: idempotency.scope,
        idempotencyKey: idempotency.idempotencyKey,
        requestDigest: payloadDigest,
        evaluationId: record.evaluation.evaluationId,
        createdAt: record.evaluation.persistedAt,
      });
    }
  }

  const appendEvaluationTxn = db.transaction((input: AppendGovernanceEvaluationInput, payloadDigest: string): AppendGovernanceEvaluationResult => {
    const probe: GovernanceIdempotencyProbe = {
      requestId: input.request.requestId,
      payloadDigest,
      ...(input.idempotency !== undefined ? { idempotency: input.idempotency } : {}),
    };
    const resolution = resolveIdempotencySync(input.accessContext, probe);
    if (resolution.kind === 'conflict') {
      throw new GovernanceStoreError(
        'GOVERNANCE_IDEMPOTENCY_CONFLICT',
        resolution.conflictKind === 'idempotency-key'
          ? 'This idempotency key was already used with a different request payload.'
          : `requestId '${input.request.requestId}' was already submitted with a different payload.`,
        { conflictKind: resolution.conflictKind },
      );
    }
    if (resolution.kind === 'replay') {
      return {
        evaluationId: resolution.record.evaluation.evaluationId,
        decisionId: resolution.record.evaluation.decisionId,
        requestId: resolution.record.evaluation.requestId,
        created: false,
        idempotentReplay: true,
        aggregateDigest: resolution.record.integrity.aggregateDigest,
        persistedAt: resolution.record.evaluation.persistedAt,
        existingRecord: resolution.record,
      };
    }

    const chainHead = selectChainHead.get() as { aggregate_digest: string; chain_position: number } | undefined;
    const aggregate = buildGovernanceAggregate(input, { now: resolved.now, nextId: resolved.nextId, limits: resolved.limits }, {
      ...(chainHead !== undefined ? { previousAggregateDigest: chainHead.aggregate_digest } : {}),
      chainPosition: (chainHead?.chain_position ?? 0) + 1,
    });
    insertAggregateRows(aggregate, input.idempotency, payloadDigest);

    return {
      evaluationId: aggregate.record.evaluation.evaluationId,
      decisionId: aggregate.record.evaluation.decisionId,
      requestId: aggregate.record.evaluation.requestId,
      created: true,
      idempotentReplay: false,
      aggregateDigest: aggregate.record.integrity.aggregateDigest,
      persistedAt: aggregate.record.evaluation.persistedAt,
    };
  });

  function mapSqliteError(error: unknown): never {
    if (error instanceof GovernanceStoreError) throw error;
    const code = sqliteErrorCode(error);
    if (code !== undefined && code.startsWith('SQLITE_CONSTRAINT')) {
      throw new GovernanceStoreError('GOVERNANCE_STORE_TRANSACTION_FAILED', 'The append transaction violated a uniqueness/foreign-key constraint and was rolled back.', { sqliteCode: code });
    }
    if (code !== undefined && (code === 'SQLITE_BUSY' || code === 'SQLITE_CANTOPEN' || code === 'SQLITE_READONLY' || code === 'SQLITE_IOERR')) {
      throw new GovernanceStoreError('GOVERNANCE_STORE_UNAVAILABLE', 'The Governance Store database is unavailable.', { sqliteCode: code });
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new GovernanceStoreError('GOVERNANCE_STORE_TRANSACTION_FAILED', `The Governance Store transaction failed and was rolled back: ${message}`);
  }

  // -- standalone event append -------------------------------------------------

  const appendStandaloneEventTxn = db.transaction((record: GovernanceEventRecord): void => {
    insertEvent.run({
      eventId: record.eventId,
      eventType: record.eventType,
      aggregateType: record.aggregateType,
      aggregateId: record.aggregateId,
      requestId: record.requestId ?? null,
      decisionId: record.decisionId ?? null,
      correlationId: record.correlationId ?? null,
      causationId: record.causationId ?? null,
      sequence: record.sequence ?? null,
      occurredAt: record.occurredAt,
      persistedAt: record.persistedAt,
      enterpriseVersion: record.enterpriseVersion,
      kernelVersion: record.kernelVersion ?? null,
      eventContract: record.eventContract,
      eventPayloadJson: JSON.stringify(record.eventPayload),
      eventDigest: record.eventDigest,
    });
  });

  /**
   * One transaction: resolve the chain head, assign the next position, seal
   * the reference, insert it, and advance the head. A committed reference can
   * therefore never lack its integrity metadata, and a crash between the two
   * writes leaves neither. `better-sqlite3` is synchronous, so two in-process
   * appends cannot interleave; cross-process writers are serialized by
   * SQLite's own write lock, and `idx_gov_references_chain_position` is the
   * backstop that rejects two references claiming one position.
   */
  const appendReferenceTxn = db.transaction((reference: GovernanceReferenceInput, organizationId: string | undefined): void => {
    const head = selectReferenceChain.get(reference.evaluationId) as ReferenceChainRow | undefined;
    // Fail closed *before* writing anything if the existing chain was sealed
    // under a version this build cannot verify — which happens on a rollback,
    // where a newer runtime wrote the chain and an older one is now serving.
    // Chaining a v1 row onto a digest whose definition we do not know would
    // extend a chain we cannot check, and the upsert below would additionally
    // overwrite the head's record of that newer version, destroying the only
    // evidence of what those rows were sealed under. Refusing costs one
    // rejected append; proceeding silently corrupts the audit trail.
    if (head !== undefined && head.integrity_version !== GOVERNANCE_REFERENCE_INTEGRITY_VERSION) {
      throw new GovernanceStoreError(
        'GOVERNANCE_SCHEMA_VERSION_UNSUPPORTED',
        `The reference chain for evaluationId '${reference.evaluationId}' was sealed under reference-integrity version '${head.integrity_version}', which this build cannot verify; refusing to append to it.`,
        { referenceIntegrityVersion: head.integrity_version, supportedVersion: GOVERNANCE_REFERENCE_INTEGRITY_VERSION },
      );
    }
    const sealed = sealGovernanceReference(reference, {
      ...(organizationId !== undefined ? { organizationId } : {}),
      sequence: (head?.latest_sequence ?? 0) + 1,
      ...(head !== undefined ? { previousReferenceDigest: head.latest_reference_digest } : {}),
    });
    insertReference.run({
      referenceId: sealed.referenceId,
      evaluationId: sealed.evaluationId,
      referenceType: sealed.referenceType,
      externalId: sealed.externalId,
      externalVersion: sealed.externalVersion ?? null,
      digest: sealed.digest ?? null,
      uri: sealed.uri ?? null,
      createdAt: sealed.createdAt,
      sequence: sealed.sequence ?? null,
      integrityVersion: sealed.integrityVersion ?? null,
      previousReferenceDigest: sealed.previousReferenceDigest ?? null,
      referenceDigest: sealed.referenceDigest ?? null,
    });
    upsertReferenceChain.run({
      evaluationId: sealed.evaluationId,
      integrityVersion: sealed.integrityVersion,
      latestSequence: sealed.sequence,
      latestReferenceDigest: sealed.referenceDigest,
      updatedAt: sealed.createdAt,
    });
  });

  function nextEventSequence(aggregateType: string, aggregateId: string): number {
    const row = selectMaxEventSequence.get(aggregateType, aggregateId) as { max_sequence: number | null } | undefined;
    return (row?.max_sequence ?? 0) + 1;
  }

  // -- store surface -----------------------------------------------------------

  const store: GovernanceStore = {
    providerKind: 'sqlite',

    async appendEvaluation(input: AppendGovernanceEvaluationInput): Promise<AppendGovernanceEvaluationResult> {
      assertOpen();
      const payloadDigest = computeGovernanceRequestPayloadDigest(input.request);
      try {
        return appendEvaluationTxn(input, payloadDigest);
      } catch (error) {
        mapSqliteError(error);
      }
    },

    async resolveIdempotency(context, probe) {
      assertOpen();
      return resolveIdempotencySync(context, probe);
    },

    async appendReference(context, reference) {
      assertOpen();
      assertCanonicalReferenceType(reference.referenceType);
      const record = loadVisibleRecord(context, reference.evaluationId);
      if (record === null) {
        throw new GovernanceStoreError('GOVERNANCE_RECORD_NOT_FOUND', `No governance record for evaluationId '${reference.evaluationId}' within this scope.`);
      }
      try {
        appendReferenceTxn(reference, record.request.organizationId);
      } catch (error) {
        const code = sqliteErrorCode(error);
        if (code !== undefined && code.startsWith('SQLITE_CONSTRAINT')) {
          // A duplicate reference id and a lost race for a chain position are
          // different facts: the first is a caller mistake to be reported as
          // such, the second is a concurrent writer whose transaction rolled
          // back and may be retried. Reporting the second as "already
          // appended" would tell the caller its reference exists when it does
          // not.
          const duplicate = db.prepare(`SELECT 1 FROM governance_references WHERE reference_id = ?`).get(reference.referenceId) !== undefined;
          if (duplicate) {
            throw new GovernanceStoreError('GOVERNANCE_STORE_VALIDATION_ERROR', `referenceId '${reference.referenceId}' was already appended; references are append-only and never overwritten.`);
          }
          throw new GovernanceStoreError('GOVERNANCE_STORE_TRANSACTION_FAILED', 'The reference append transaction lost a race for its chain position and was rolled back; nothing was persisted.', { sqliteCode: code });
        }
        mapSqliteError(error);
      }
    },

    async appendLifecycleEvent(event: EnterpriseEvent) {
      assertOpen();
      const aggregateId = 'lifecycleCorrelationId' in event ? (event.moduleId ?? event.lifecycleCorrelationId) : event.requestId;
      const aggregateType = 'lifecycleCorrelationId' in event ? (event.moduleId !== undefined ? 'enterprise_module' : 'enterprise_lifecycle') : 'governance_request';
      const record = toStandaloneEventRecord(event, { now: resolved.now, enterpriseVersion: resolved.enterpriseVersion, sequence: nextEventSequence(aggregateType, aggregateId) });
      try {
        appendStandaloneEventTxn(record);
      } catch (error) {
        mapSqliteError(error);
      }
    },

    async getByEvaluationId(context, evaluationId) {
      assertOpen();
      return loadVisibleRecord(context, evaluationId);
    },
    async getByDecisionId(context, decisionId) {
      assertOpen();
      requireReadScope(context);
      const row = selectEvaluationByDecisionId.get(decisionId) as EvaluationRow | undefined;
      return loadVisibleRecord(context, row?.evaluation_id);
    },
    async getByRequestId(context, requestId) {
      assertOpen();
      requireReadScope(context);
      const row = selectEvaluationByRequestId.get(requestId) as EvaluationRow | undefined;
      return loadVisibleRecord(context, row?.evaluation_id);
    },

    async query(context: GovernanceStoreAccessContext, query: GovernanceStoreQuery): Promise<GovernanceStoreQueryResult> {
      assertOpen();
      const organizationId = resolveQueryOrganization(context, query);
      const limit = normalizeQueryLimit(query.limit);

      const { clauses, params } = filterClauses(context, query, organizationId);
      if (query.cursor !== undefined) {
        clauses.unshift('i.chain_position < ?');
        params.unshift(decodeQueryCursor(query.cursor));
      }

      const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
      const sql = `
        SELECT e.evaluation_id, e.decision_id, e.request_id, e.correlation_id, r.organization_id, r.actor_id, r.action_type,
               e.status, e.reason_codes_json, e.evaluated_at, e.persisted_at, i.aggregate_digest, i.chain_position
        FROM governance_evaluations e
        JOIN governance_requests r ON r.request_id = e.request_id
        JOIN governance_integrity i ON i.evaluation_id = e.evaluation_id
        ${where}
        ORDER BY i.chain_position DESC
        LIMIT ?`;
      params.push(limit + 1);

      interface QueryRow {
        readonly evaluation_id: string;
        readonly decision_id: string;
        readonly request_id: string;
        readonly correlation_id: string | null;
        readonly organization_id: string | null;
        readonly actor_id: string;
        readonly action_type: string;
        readonly status: string;
        readonly reason_codes_json: string;
        readonly evaluated_at: string;
        readonly persisted_at: string;
        readonly aggregate_digest: string;
        readonly chain_position: number;
      }
      const rows = db.prepare(sql).all(...params) as QueryRow[];
      const page = rows.slice(0, limit);
      const lastRow = page[page.length - 1];
      return {
        records: page.map((row) => ({
          evaluationId: row.evaluation_id,
          decisionId: row.decision_id,
          requestId: row.request_id,
          ...(row.correlation_id !== null ? { correlationId: row.correlation_id } : {}),
          ...(row.organization_id !== null ? { organizationId: row.organization_id } : {}),
          actorId: row.actor_id,
          actionType: row.action_type,
          status: row.status as GovernanceEvaluationRecord['status'],
          reasonCodes: JSON.parse(row.reason_codes_json) as readonly string[],
          evaluatedAt: row.evaluated_at,
          persistedAt: row.persisted_at,
          aggregateDigest: row.aggregate_digest,
        })),
        ...(rows.length > limit && lastRow !== undefined ? { nextCursor: encodeQueryCursor(lastRow.chain_position) } : {}),
      };
    },

    async count(context: GovernanceStoreAccessContext, query: GovernanceStoreCountQuery): Promise<number> {
      assertOpen();
      const organizationId = resolveQueryOrganization(context, query);
      const { clauses, params } = filterClauses(context, query, organizationId);
      const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
      const row = db
        .prepare(
          `SELECT COUNT(*) AS total
           FROM governance_evaluations e
           JOIN governance_requests r ON r.request_id = e.request_id
           JOIN governance_integrity i ON i.evaluation_id = e.evaluation_id
           ${where}`,
        )
        .get(...params) as { readonly total: number };
      return row.total;
    },

    async reconstruct(context, evaluationId) {
      assertOpen();
      requireReadScope(context);
      const loaded = loadAggregate(evaluationId);
      if (loaded.status === 'incomplete' && loaded.missingComponents.length === 1 && loaded.missingComponents[0] === 'evaluation') {
        throw new GovernanceStoreError('GOVERNANCE_RECORD_NOT_FOUND', `No governance record for evaluationId '${evaluationId}' within this scope.`);
      }
      if (loaded.status === 'complete' && loaded.record !== undefined && !canSeeRecord(context, loaded.record.request.organizationId)) {
        throw new GovernanceStoreError('GOVERNANCE_RECORD_NOT_FOUND', `No governance record for evaluationId '${evaluationId}' within this scope.`);
      }
      return loaded;
    },

    async verify(context, evaluationId) {
      assertOpen();
      const record = loadVisibleRecord(context, evaluationId);
      if (record === null) {
        throw new GovernanceStoreError('GOVERNANCE_RECORD_NOT_FOUND', `No governance record for evaluationId '${evaluationId}' within this scope.`);
      }
      let expectedPrevious: string | null | undefined = null;
      if (record.integrity.chainPosition > 1) {
        const previousRow = selectIntegrityByChainPosition.get(record.integrity.chainPosition - 1) as IntegrityRow | undefined;
        expectedPrevious = previousRow?.aggregate_digest;
      }
      const chainRow = selectReferenceChain.get(evaluationId) as ReferenceChainRow | undefined;
      return verifyGovernanceRecordIntegrity(record, expectedPrevious, resolved.now, chainRow === undefined ? null : rowToReferenceChainState(chainRow));
    },

    async health(): Promise<GovernanceStoreHealth> {
      const checkedAt = resolved.now();
      if (closed) {
        return { status: 'unhealthy', writable: false, readable: false, schemaVersion: GOVERNANCE_STORE_SCHEMA_VERSION, migrationState: 'unknown', checkedAt, details: { provider: 'sqlite', closed: true } };
      }
      try {
        const versionRow = selectLatestStoreVersion.get() as StoreVersionRow | undefined;
        const readable = db.prepare('SELECT 1').get() !== undefined;
        const writable = !db.readonly;
        const migrationState = versionRow?.migration_state ?? 'unknown';
        const schemaVersion = versionRow?.schema_version ?? GOVERNANCE_STORE_SCHEMA_VERSION;
        return {
          status: readable && writable ? 'healthy' : readable ? 'degraded' : 'unhealthy',
          writable,
          readable,
          schemaVersion,
          migrationState,
          checkedAt,
          details: { provider: 'sqlite' },
        };
      } catch {
        return { status: 'unhealthy', writable: false, readable: false, schemaVersion: GOVERNANCE_STORE_SCHEMA_VERSION, migrationState: 'unknown', checkedAt, details: { provider: 'sqlite' } };
      }
    },

    // -- legacy compatibility surface ----------------------------------------

    async persistEvaluation(input: PersistEvaluationInput): Promise<PersistEvaluationResult> {
      assertOpen();
      try {
        const appendResult = await store.appendEvaluation(toLegacyAppendInput(input, resolved.enterpriseVersion));
        const record = appendResult.existingRecord ?? loadVisibleRecord({ system: true }, appendResult.evaluationId);
        if (record === null || record === undefined) throw new GovernanceStoreError('GOVERNANCE_STORE_TRANSACTION_FAILED', 'The appended aggregate could not be read back.');
        return { outcome: appendResult.idempotentReplay ? 'idempotent_replay' : 'stored', evaluation: record.evaluation };
      } catch (error) {
        if (error instanceof GovernanceStoreError && error.code === 'GOVERNANCE_IDEMPOTENCY_CONFLICT') {
          const existing = await store.getByRequestId({ system: true }, input.request.requestId);
          if (existing !== null) return { outcome: 'conflict', evaluation: existing.evaluation };
        }
        throw error;
      }
    },

    async getRequestById(requestId) {
      assertOpen();
      const record = await store.getByRequestId({ system: true }, requestId);
      return record?.request;
    },
    async getEvaluationByRequestId(requestId) {
      assertOpen();
      const record = await store.getByRequestId({ system: true }, requestId);
      return record?.evaluation;
    },
    async getEvaluationByDecisionId(decisionId) {
      assertOpen();
      const record = await store.getByDecisionId({ system: true }, decisionId);
      return record?.evaluation;
    },
    async getTraceByDecisionId(decisionId) {
      assertOpen();
      const record = await store.getByDecisionId({ system: true }, decisionId);
      return record !== null ? { decisionId: record.evaluation.decisionId, trace: toKernelTrace(record) } : undefined;
    },

    async appendEnterpriseEvent(legacy: EnterpriseEventRecord) {
      assertOpen();
      const record = legacyEventToRecord(legacy, { now: resolved.now, enterpriseVersion: resolved.enterpriseVersion, sequence: nextEventSequence('governance_request', legacy.requestId) });
      try {
        appendStandaloneEventTxn(record);
      } catch (error) {
        mapSqliteError(error);
      }
    },
    async listEnterpriseEvents(filter) {
      assertOpen();
      const clauses = ['request_id IS NOT NULL'];
      const params: string[] = [];
      if (filter?.requestId !== undefined) { clauses.push('request_id = ?'); params.push(filter.requestId); }
      if (filter?.correlationId !== undefined) { clauses.push('correlation_id = ?'); params.push(filter.correlationId); }
      const rows = db.prepare(`SELECT * FROM governance_events WHERE ${clauses.join(' AND ')} ORDER BY rowid ASC`).all(...params) as EventRow[];
      const failures: string[] = [];
      return rows
        .map((row) => rowToEventRecord(row, failures))
        .filter((record): record is GovernanceEventRecord => record !== undefined)
        .map(recordToLegacyEvent)
        .filter((event): event is EnterpriseEventRecord => event !== undefined);
    },

    async recordEnterpriseVersion(record: EnterpriseVersionRecord) {
      assertOpen();
      insertVersion.run(record);
    },
    async getLatestEnterpriseVersion() {
      assertOpen();
      interface VersionRow {
        readonly boot_id: string;
        readonly runtime_version: string;
        readonly kernel_version: string;
        readonly recorded_at: string;
      }
      const row = selectLatestVersion.get() as VersionRow | undefined;
      return row === undefined ? undefined : { bootId: row.boot_id, enterpriseVersion: row.runtime_version, kernelVersion: row.kernel_version, recordedAt: row.recorded_at };
    },

    async checkConnectivity() {
      if (closed) return false;
      try {
        db.prepare('SELECT 1').get();
        return true;
      } catch {
        return false;
      }
    },
    async close() {
      closed = true;
      db.close();
    },
  };

  return store;
}

// ---------------------------------------------------------------------------
// Schema initialization + PR-002 migration
// ---------------------------------------------------------------------------

function initSchemaAndMigrate(db: BetterSqlite3.Database, now: () => string): void {
  const initTxn = db.transaction(() => {
    db.exec(SCHEMA_V1);
    ensureReferenceIntegritySchema(db);

    const versionRow = db.prepare(`SELECT schema_version FROM governance_store_versions ORDER BY id DESC LIMIT 1`).get() as { schema_version: string } | undefined;
    if (versionRow !== undefined && versionRow.schema_version !== GOVERNANCE_STORE_SCHEMA_VERSION) {
      throw new GovernanceStoreError('GOVERNANCE_SCHEMA_VERSION_UNSUPPORTED', `This database reports schema '${versionRow.schema_version}'; this build supports only '${GOVERNANCE_STORE_SCHEMA_VERSION}'.`);
    }

    const migratedCount = migrateFromPr002(db, now);
    if (versionRow === undefined) {
      db.prepare(`INSERT INTO governance_store_versions (schema_version, migration_state, details_json, recorded_at) VALUES (?, ?, ?, ?)`).run(
        GOVERNANCE_STORE_SCHEMA_VERSION,
        migratedCount > 0 ? 'migrated-from-pr-002' : 'fresh',
        JSON.stringify({ migratedEvaluations: migratedCount }),
        now(),
      );
    } else if (migratedCount > 0) {
      db.prepare(`INSERT INTO governance_store_versions (schema_version, migration_state, details_json, recorded_at) VALUES (?, ?, ?, ?)`).run(
        GOVERNANCE_STORE_SCHEMA_VERSION,
        'migrated-from-pr-002',
        JSON.stringify({ migratedEvaluations: migratedCount }),
        now(),
      );
    }
  });

  try {
    initTxn();
  } catch (error) {
    if (error instanceof GovernanceStoreError) throw error;
    throw new GovernanceStoreError('GOVERNANCE_STORE_TRANSACTION_FAILED', `Governance Store schema initialization/migration failed and was rolled back: ${error instanceof Error ? error.message : 'unknown error'}.`);
  }
}

function tableExists(db: BetterSqlite3.Database, name: string): boolean {
  return db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) !== undefined;
}

/**
 * Brings a database created before reference integrity existed up to the
 * current `governance_references` shape. `db.exec(SCHEMA_V1)` only runs
 * `CREATE TABLE IF NOT EXISTS`, so an existing table keeps its original
 * columns; these `ALTER TABLE ... ADD COLUMN`s supply the rest.
 *
 * Deliberately additive and deliberately incomplete as a "migration":
 *
 * - every added column is nullable with no default, so **not one existing row
 *   changes**. Historical aggregate digests are unaffected because
 *   `governance_references` was never inside them, and historical reference
 *   rows stay exactly as written — classified `legacy_unprotected`, which is
 *   the truth about them.
 * - **nothing is back-filled.** Computing digests over historical rows now
 *   would prove only that they are self-consistent *today*, while presenting
 *   itself as evidence they were sealed when written. That is a claim this
 *   store cannot support, so it does not make it.
 * - the schema version is **not** bumped. It is checked in both directions
 *   (`initSchemaAndMigrate` refuses an unrecognized version; `loadAggregate`
 *   corrupts an aggregate whose stamped version differs), and
 *   `schema_version` sits inside `metadataDigest` inside `aggregateDigest`.
 *   Bumping it would make every historical aggregate unreadable and unfixable
 *   without rewriting history. Reference-integrity versioning is carried
 *   per-row in `reference_integrity_version` instead.
 */
function ensureReferenceIntegritySchema(db: BetterSqlite3.Database): void {
  const columns = new Set((db.pragma(`table_info(governance_references)`) as { name: string }[]).map((column) => column.name));
  const additions: readonly (readonly [string, string])[] = [
    ['sequence', 'INTEGER'],
    ['reference_integrity_version', 'TEXT'],
    ['previous_reference_digest', 'TEXT'],
    ['reference_digest', 'TEXT'],
  ];
  for (const [name, type] of additions) {
    if (!columns.has(name)) db.exec(`ALTER TABLE governance_references ADD COLUMN ${name} ${type}`);
  }
  // Declared here rather than in SCHEMA_V1 because on an upgraded database the
  // column this indexes exists only after the ALTERs above. NULL sequences
  // (legacy rows) are distinct under SQLite's UNIQUE semantics, so this
  // constrains protected rows only: two protected references can never claim
  // the same chain position on one evaluation.
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_gov_references_chain_position ON governance_references(evaluation_id, sequence)`);
  db.exec(`CREATE TABLE IF NOT EXISTS governance_reference_chains (
    evaluation_id TEXT PRIMARY KEY REFERENCES governance_evaluations(evaluation_id),
    integrity_version TEXT NOT NULL,
    latest_sequence INTEGER NOT NULL,
    latest_reference_digest TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
}

/**
 * Copies PR-002 rows into the v1 schema. The legacy tables are read-only
 * inputs here — never renamed, altered, or dropped. Idempotent: a legacy
 * request whose request_id already exists in `governance_requests` is
 * skipped, so re-running on the same database migrates nothing twice.
 *
 * Historical honesty: PR-002 never stored the full Kernel result,
 * lifecycle state, or Enterprise version per decision, so migrated
 * aggregates carry only what actually existed. `lifecycleState` is
 * `'unrecorded'`, module snapshots are empty, `persistedAt`/`createdAt`
 * are the migration time (the original persistence time was never stored),
 * and integrity digests attest to the record *as migrated*, not to bytes
 * PR-002 wrote. Every migrated aggregate is marked
 * `migrationSource: 'pr-002-governance-store'`.
 */
function migrateFromPr002(db: BetterSqlite3.Database, now: () => string): number {
  if (!tableExists(db, 'GovernanceRequests') || !tableExists(db, 'GovernanceEvaluations')) return 0;

  const legacyEvaluations = db.prepare(`SELECT * FROM GovernanceEvaluations ORDER BY rowid ASC`).all() as LegacyEvaluationRow[];
  if (legacyEvaluations.length === 0) return 0;

  const selectLegacyRequest = db.prepare(`SELECT request_id, received_at, request_payload FROM GovernanceRequests WHERE request_id = ?`);
  const selectLegacyTrace = tableExists(db, 'GovernanceTraces') ? db.prepare(`SELECT * FROM GovernanceTraces WHERE decision_id = ?`) : undefined;
  const requestAlreadyMigrated = db.prepare(`SELECT 1 FROM governance_requests WHERE request_id = ?`);

  let migrationCounter = 0;
  const nextMigrationId = (prefix: string): string => {
    migrationCounter += 1;
    return `${prefix}-migrated-${migrationCounter}`;
  };

  let migrated = 0;
  for (const legacyEvaluation of legacyEvaluations) {
    if (requestAlreadyMigrated.get(legacyEvaluation.request_id) !== undefined) continue;
    const legacyRequest = selectLegacyRequest.get(legacyEvaluation.request_id) as LegacyRequestRow | undefined;
    if (legacyRequest === undefined) continue; // an orphan legacy evaluation cannot be reconstructed; left in place, documented in the migration guide

    const request = JSON.parse(legacyRequest.request_payload) as KernelEvaluationRequest;
    const traceRow = selectLegacyTrace?.get(legacyEvaluation.decision_id) as LegacyTraceRow | undefined;
    const trace: KernelTrace =
      traceRow !== undefined
        ? (JSON.parse(traceRow.steps_json) as KernelTrace)
        : { steps: [], decisionId: legacyEvaluation.decision_id, kernelVersion: legacyEvaluation.kernel_version };

    // Only fields PR-002 actually stored — the migrated result payload does
    // not invent recognition/authority/policy/approval/evidence sub-results.
    const migratedResult = {
      requestId: legacyEvaluation.request_id,
      decisionId: legacyEvaluation.decision_id,
      status: legacyEvaluation.status,
      reasonCodes: JSON.parse(legacyEvaluation.reason_codes) as readonly string[],
      summary: legacyEvaluation.summary,
      kernelVersion: legacyEvaluation.kernel_version,
      evaluatedAt: legacyEvaluation.evaluated_at,
      ...(legacyEvaluation.correlation_id !== null ? { correlationId: legacyEvaluation.correlation_id } : {}),
      trace,
    } as unknown as KernelEvaluationResult;

    const chainHead = db.prepare(`SELECT aggregate_digest, chain_position FROM governance_integrity ORDER BY chain_position DESC LIMIT 1`).get() as
      | { aggregate_digest: string; chain_position: number }
      | undefined;

    const aggregate = buildGovernanceAggregate(
      {
        request,
        result: migratedResult,
        receivedAt: legacyRequest.received_at,
        enterpriseContext: { enterpriseVersion: 'unrecorded', lifecycleState: 'unrecorded', modules: [] },
        events: [],
        accessContext: { system: true },
      },
      { now, nextId: nextMigrationId, limits: { maxRequestPayloadBytes: Number.MAX_SAFE_INTEGER, maxResultPayloadBytes: Number.MAX_SAFE_INTEGER, maxEventPayloadBytes: Number.MAX_SAFE_INTEGER, maxTraceSteps: Number.MAX_SAFE_INTEGER } },
      { ...(chainHead !== undefined ? { previousAggregateDigest: chainHead.aggregate_digest } : {}), chainPosition: (chainHead?.chain_position ?? 0) + 1 },
    );

    // Stamp the migration marker into metadata and recompute the affected digests.
    const record = withMigrationSource(aggregate.record);
    insertMigratedAggregate(db, record);
    migrated += 1;
  }

  // Preserve the legacy event ledger as standalone v1 event records.
  if (tableExists(db, 'RuntimeEvents')) {
    const legacyEvents = db.prepare(`SELECT * FROM RuntimeEvents ORDER BY rowid ASC`).all() as LegacyEventRow[];
    const eventAlreadyMigrated = db.prepare(`SELECT 1 FROM governance_events WHERE event_id = ?`);
    const maxSequence = db.prepare(`SELECT MAX(sequence) AS max_sequence FROM governance_events WHERE aggregate_type = ? AND aggregate_id = ?`);
    for (const legacyEvent of legacyEvents) {
      if (eventAlreadyMigrated.get(legacyEvent.event_id) !== undefined) continue;
      const sequenceRow = maxSequence.get('governance_request', legacyEvent.request_id) as { max_sequence: number | null } | undefined;
      const record = legacyEventToRecord(
        {
          eventId: legacyEvent.event_id,
          eventType: legacyEvent.event_type,
          requestId: legacyEvent.request_id,
          ...(legacyEvent.decision_id !== null ? { decisionId: legacyEvent.decision_id } : {}),
          ...(legacyEvent.correlation_id !== null ? { correlationId: legacyEvent.correlation_id } : {}),
          occurredAt: legacyEvent.occurred_at,
          payload: JSON.parse(legacyEvent.payload) as Readonly<Record<string, unknown>>,
        },
        { now, enterpriseVersion: 'unrecorded', sequence: (sequenceRow?.max_sequence ?? 0) + 1 },
      );
      insertStandaloneEventRow(db, record);
    }
  }

  return migrated;
}

/** Re-seals a freshly built aggregate after stamping `migrationSource` into its metadata (metadata participates in the digests, so the affected digests are recomputed with the same projection primitives). */
function withMigrationSource(record: GovernanceRecord): GovernanceRecord {
  const metadata: GovernanceRecordMetadata = { ...record.metadata, migrationSource: GOVERNANCE_MIGRATION_SOURCE_PR_002 };
  return recomputeIntegrity(record, metadata);
}

function recomputeIntegrity(record: GovernanceRecord, metadata: GovernanceRecordMetadata): GovernanceRecord {
  const metadataDigest = computeDigest(metadataDigestInput(metadata));
  const aggregateDigest = computeAggregateDigest({
    requestDigest: record.integrity.requestDigest,
    evaluationDigest: record.integrity.evaluationDigest,
    traceDigest: record.integrity.traceDigest,
    eventsDigest: record.integrity.eventsDigest,
    metadataDigest,
    ...(record.integrity.previousAggregateDigest !== undefined ? { previousAggregateDigest: record.integrity.previousAggregateDigest } : {}),
  });
  return {
    ...record,
    metadata,
    integrity: { ...record.integrity, metadataDigest, aggregateDigest },
  };
}

function insertMigratedAggregate(db: BetterSqlite3.Database, record: GovernanceRecord): void {
  db.prepare(`INSERT INTO governance_requests
    (record_id, request_id, correlation_id, organization_id, actor_id, actor_type, action_type, action_domain, resource_scope, target_type, target_id, requested_at, received_at, request_contract, request_payload_json, payload_digest, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    record.request.recordId,
    record.request.requestId,
    record.request.correlationId ?? null,
    record.request.organizationId ?? null,
    record.request.actorId,
    record.request.actorType ?? null,
    record.request.actionType,
    record.request.actionDomain ?? null,
    record.request.resourceScope,
    record.request.targetType ?? null,
    record.request.targetId ?? null,
    record.request.requestedAt,
    record.request.receivedAt,
    record.request.requestContract,
    JSON.stringify(record.request.requestPayload),
    record.request.payloadDigest,
    record.evaluation.persistedAt,
  );
  db.prepare(`INSERT INTO governance_evaluations
    (record_id, evaluation_id, decision_id, request_id, correlation_id, status, summary, reason_codes_json, evaluated_at, persisted_at, kernel_version, enterprise_version, evaluation_contract, result_payload_json, result_digest, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    record.evaluation.recordId,
    record.evaluation.evaluationId,
    record.evaluation.decisionId,
    record.evaluation.requestId,
    record.evaluation.correlationId ?? null,
    record.evaluation.status,
    record.evaluation.summary,
    JSON.stringify(record.evaluation.reasonCodes),
    record.evaluation.evaluatedAt,
    record.evaluation.persistedAt,
    record.evaluation.kernelVersion,
    record.evaluation.enterpriseVersion,
    record.evaluation.evaluationContract,
    JSON.stringify(record.evaluation.resultPayload),
    record.evaluation.resultDigest,
    record.evaluation.persistedAt,
  );
  const insertTraceStmt = db.prepare(`INSERT INTO governance_trace_steps
    (trace_record_id, evaluation_id, sequence, operator, status, reason_codes_json, started_at, completed_at, metadata_json, trace_contract, trace_digest)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const step of record.trace) {
    insertTraceStmt.run(
      step.traceRecordId,
      step.evaluationId,
      step.sequence,
      step.operator,
      step.status,
      JSON.stringify(step.reasonCodes),
      step.startedAt ?? null,
      step.completedAt ?? null,
      step.metadata !== undefined ? JSON.stringify(step.metadata) : null,
      step.traceContract,
      step.traceDigest,
    );
  }
  const insertReasonStmt = db.prepare(`INSERT INTO governance_reason_codes (reason_record_id, evaluation_id, sequence, reason_code) VALUES (?, ?, ?, ?)`);
  for (const reason of record.reasons) {
    insertReasonStmt.run(reason.reasonRecordId, reason.evaluationId, reason.sequence, reason.reasonCode);
  }
  db.prepare(`INSERT INTO governance_record_metadata
    (metadata_id, evaluation_id, enterprise_version, kernel_version, lifecycle_state, module_snapshot_json, provider_snapshot_json, environment, build_version, created_at, schema_version, migration_source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    record.metadata.metadataId,
    record.metadata.evaluationId,
    record.metadata.enterpriseVersion,
    record.metadata.kernelVersion,
    record.metadata.lifecycleState,
    JSON.stringify(record.metadata.moduleSnapshot),
    record.metadata.providerSnapshot !== undefined ? JSON.stringify(record.metadata.providerSnapshot) : null,
    record.metadata.environment ?? null,
    record.metadata.buildVersion ?? null,
    record.metadata.createdAt,
    record.metadata.schemaVersion,
    record.metadata.migrationSource ?? null,
  );
  db.prepare(`INSERT INTO governance_integrity
    (integrity_id, evaluation_id, algorithm, canonicalization_version, request_digest, evaluation_digest, trace_digest, events_digest, metadata_digest, aggregate_digest, previous_aggregate_digest, chain_position, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    record.integrity.integrityId,
    record.integrity.evaluationId,
    record.integrity.algorithm,
    record.integrity.canonicalizationVersion,
    record.integrity.requestDigest,
    record.integrity.evaluationDigest,
    record.integrity.traceDigest,
    record.integrity.eventsDigest,
    record.integrity.metadataDigest,
    record.integrity.aggregateDigest,
    record.integrity.previousAggregateDigest ?? null,
    record.integrity.chainPosition,
    record.integrity.createdAt,
  );
}

function insertStandaloneEventRow(db: BetterSqlite3.Database, record: GovernanceEventRecord): void {
  db.prepare(`INSERT INTO governance_events
    (event_id, event_type, aggregate_type, aggregate_id, request_id, decision_id, correlation_id, causation_id, sequence, occurred_at, persisted_at, enterprise_version, kernel_version, event_contract, event_payload_json, event_digest)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    record.eventId,
    record.eventType,
    record.aggregateType,
    record.aggregateId,
    record.requestId ?? null,
    record.decisionId ?? null,
    record.correlationId ?? null,
    record.causationId ?? null,
    record.sequence ?? null,
    record.occurredAt,
    record.persistedAt,
    record.enterpriseVersion,
    record.kernelVersion ?? null,
    record.eventContract,
    JSON.stringify(record.eventPayload),
    record.eventDigest,
  );
}
