import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import Database from 'better-sqlite3';

import { canonicalizeConformance, conformanceDigest } from './canonical.js';
import {
  FEDERATION_EVENT_KINDS,
  FEDERATION_TIMING,
  GENERATION_STATES,
  JOB_PURPOSES,
  JOB_STATES,
  OPERATOR_STATES,
  VALIDATOR_STATES,
  type FederationEvent,
  type FederationEventKind,
  type FederationOperatorRecord,
  type FederationValidatorRecord,
  type GenerationState,
  type JobAssignment,
  type JobLease,
  type JobPurpose,
  type JobState,
  type OperatorState,
  type ScheduledJob,
  type TestingAuthorization,
  type ValidatorState,
} from './federation-contracts.js';

/**
 * RN-CONFORM-05 — the durable federation store (SQLite, synthetic only).
 *
 * A SEPARATE file from the RN-CONFORM-02 conformance store, which is left byte-for-byte unchanged: that store refuses any
 * schema it did not create, and it stays the only source of evidence, corroboration and credential truth. This store
 * holds what the federation needs to OPERATE validators — operator and validator lifecycles, key generations, proof-of-
 * possession nonces, heartbeat sessions, testing authorizations, the durable job queue with leases and fencing, and an
 * append-only operational event log. Nothing here is read by the engine.
 *
 * Integrity, following the conformance store's conventions:
 * - `create` refuses an existing file; reopening never re-creates; on open the exact table/index/trigger set, a
 *   `quick_check` and the schema identity are verified (a tampered trigger is CORRUPT, never silently repaired).
 * - Identity and history tables are append-only by trigger. Lifecycle state is a versioned event log
 *   (`version = previous + 1`); REVOKED is terminal at the database level.
 * - The job row is the one mutable record. Its identity columns are immutable, its lease generation (the fencing
 *   token) and attempt count only increase, its challenge binding is write-once, terminal states never change, and
 *   every state change must be an allowed edge — all enforced by trigger, so a stale writer cannot move a job even by
 *   bypassing the TypeScript API.
 * - `fed_meta.state_seq` increases on every write and `clock_hwm_ms` records the highest clock ever presented; a caller
 *   can pin the sequence it last saw (`expectedMinimumStateSeq`) so a restored older copy is refused (F-06), and a
 *   presented clock far behind the high-water mark is refused (F-11).
 * - Every write is one IMMEDIATE transaction (WAL, synchronous = FULL).
 */

export const FEDERATION_STORE_SCHEMA_VERSION = 'rn.conformance.federation-store/1';

const list = (values: readonly string[]): string => values.map((v) => `'${v}'`).join(', ');

const JOB_EDGES: readonly (readonly [JobState, JobState])[] = [
  ['PENDING', 'LEASED'],
  ['PENDING', 'EXPIRED'],
  ['PENDING', 'CANCELLED'],
  ['LEASED', 'LEASED'],
  ['LEASED', 'DISPATCHED'],
  ['LEASED', 'COMPLETED'],
  ['LEASED', 'RETRY_PENDING'],
  ['LEASED', 'EXPIRED'],
  ['LEASED', 'FAILED_FINAL'],
  ['LEASED', 'CANCELLED'],
  ['DISPATCHED', 'LEASED'],
  ['DISPATCHED', 'COMPLETED'],
  ['DISPATCHED', 'EXPIRED'],
  ['DISPATCHED', 'CANCELLED'],
  ['RETRY_PENDING', 'LEASED'],
  ['RETRY_PENDING', 'EXPIRED'],
  ['RETRY_PENDING', 'FAILED_FINAL'],
  ['RETRY_PENDING', 'CANCELLED'],
  // Recovery: every assigned observation turned out to be committed already (lost acknowledgement / crash after dispatch).
  ['RETRY_PENDING', 'COMPLETED'],
];
const EDGE_SQL = JOB_EDGES.map(([from, to]) => `(OLD.state = '${from}' AND NEW.state = '${to}')`).join(' OR ');

const APPEND_ONLY = [
  'fed_operators',
  'fed_operator_states',
  'fed_validators',
  'fed_validator_states',
  'fed_generations',
  'fed_generation_states',
  'fed_possession_requests',
  'fed_possession_consumed',
  'fed_sessions',
  'fed_authorizations',
  'fed_consumed_decisions',
  'fed_deliveries',
  'fed_violations',
  'fed_events',
] as const;

const SCHEMA = `
CREATE TABLE fed_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  schema_version TEXT NOT NULL,
  synthetic INTEGER NOT NULL CHECK (synthetic = 1),
  state_seq INTEGER NOT NULL CHECK (state_seq >= 0),
  clock_hwm_ms INTEGER NOT NULL CHECK (clock_hwm_ms >= 0)
);
CREATE TABLE fed_operators (
  operator_id TEXT PRIMARY KEY,
  record_json TEXT NOT NULL,
  record_digest TEXT NOT NULL,
  synthetic INTEGER NOT NULL CHECK (synthetic = 1)
);
CREATE TABLE fed_operator_states (
  operator_id TEXT NOT NULL REFERENCES fed_operators(operator_id),
  version INTEGER NOT NULL CHECK (version >= 1),
  state TEXT NOT NULL CHECK (state IN (${list(OPERATOR_STATES)})),
  at_ms INTEGER NOT NULL,
  reason TEXT NOT NULL,
  decisions_json TEXT NOT NULL,
  PRIMARY KEY (operator_id, version)
);
CREATE TABLE fed_validators (
  validator_id TEXT PRIMARY KEY,
  operator_id TEXT NOT NULL REFERENCES fed_operators(operator_id),
  record_json TEXT NOT NULL,
  record_digest TEXT NOT NULL,
  synthetic INTEGER NOT NULL CHECK (synthetic = 1)
);
CREATE TABLE fed_validator_states (
  validator_id TEXT NOT NULL REFERENCES fed_validators(validator_id),
  version INTEGER NOT NULL CHECK (version >= 1),
  state TEXT NOT NULL CHECK (state IN (${list(VALIDATOR_STATES)})),
  at_ms INTEGER NOT NULL,
  reason TEXT NOT NULL,
  decisions_json TEXT NOT NULL,
  PRIMARY KEY (validator_id, version)
);
CREATE TABLE fed_generations (
  validator_id TEXT NOT NULL REFERENCES fed_validators(validator_id),
  generation INTEGER NOT NULL CHECK (generation >= 1),
  conformance_validator_id TEXT NOT NULL UNIQUE,
  operator_id TEXT NOT NULL REFERENCES fed_operators(operator_id),
  key_id TEXT NOT NULL UNIQUE,
  public_key_pem TEXT NOT NULL,
  valid_from_ms INTEGER NOT NULL,
  valid_until_ms INTEGER NOT NULL,
  enrollment_kind TEXT NOT NULL CHECK (enrollment_kind IN ('ENROLL', 'ROTATE', 'REINSTATE')),
  binding_digest TEXT NOT NULL,
  created_ms INTEGER NOT NULL,
  CHECK (valid_until_ms > valid_from_ms),
  PRIMARY KEY (validator_id, generation)
);
CREATE TABLE fed_generation_states (
  validator_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  state TEXT NOT NULL CHECK (state IN (${list(GENERATION_STATES)})),
  at_ms INTEGER NOT NULL,
  reason TEXT NOT NULL,
  PRIMARY KEY (validator_id, generation, version),
  FOREIGN KEY (validator_id, generation) REFERENCES fed_generations(validator_id, generation)
);
CREATE TABLE fed_possession_requests (
  request_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('ENROLL', 'ROTATE', 'REINSTATE')),
  validator_id TEXT NOT NULL,
  operator_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation >= 1),
  key_id TEXT NOT NULL,
  public_key_pem TEXT NOT NULL,
  valid_from_ms INTEGER NOT NULL,
  valid_until_ms INTEGER NOT NULL,
  nonce TEXT NOT NULL UNIQUE,
  issued_ms INTEGER NOT NULL,
  expires_ms INTEGER NOT NULL,
  CHECK (expires_ms > issued_ms)
);
CREATE TABLE fed_possession_consumed (
  request_id TEXT PRIMARY KEY REFERENCES fed_possession_requests(request_id),
  consumed_ms INTEGER NOT NULL
);
CREATE TABLE fed_sessions (
  session_id TEXT PRIMARY KEY,
  conformance_validator_id TEXT NOT NULL REFERENCES fed_generations(conformance_validator_id),
  issued_ms INTEGER NOT NULL
);
CREATE TABLE fed_heartbeat_heads (
  conformance_validator_id TEXT PRIMARY KEY REFERENCES fed_generations(conformance_validator_id),
  session_id TEXT NOT NULL REFERENCES fed_sessions(session_id),
  sequence INTEGER NOT NULL CHECK (sequence >= 1),
  emitted_ms INTEGER NOT NULL,
  received_ms INTEGER NOT NULL,
  heartbeat_digest TEXT NOT NULL,
  operational_state TEXT NOT NULL CHECK (operational_state IN ('READY', 'DRAINING'))
);
CREATE TABLE fed_authorizations (
  authorization_id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  integration_digest TEXT NOT NULL,
  not_before_ms INTEGER NOT NULL,
  not_after_ms INTEGER NOT NULL,
  record_json TEXT NOT NULL,
  record_digest TEXT NOT NULL,
  decisions_json TEXT NOT NULL,
  CHECK (not_after_ms > not_before_ms)
);
CREATE TABLE fed_consumed_decisions (
  decision_id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  subject_ref TEXT NOT NULL,
  binding_digest TEXT NOT NULL,
  consumed_for TEXT NOT NULL,
  consumed_ms INTEGER NOT NULL
);
CREATE TABLE fed_jobs (
  job_id TEXT PRIMARY KEY,
  purpose TEXT NOT NULL CHECK (purpose IN (${list(JOB_PURPOSES)})),
  organization_id TEXT NOT NULL,
  integration_digest TEXT NOT NULL,
  challenge_type TEXT NOT NULL,
  operation TEXT NOT NULL,
  fixture_ref TEXT NOT NULL,
  authorization_id TEXT NOT NULL REFERENCES fed_authorizations(authorization_id),
  assignments_json TEXT NOT NULL,
  required_operators INTEGER NOT NULL CHECK (required_operators >= 1),
  deadline_seconds INTEGER NOT NULL CHECK (deadline_seconds >= 1 AND deadline_seconds <= 900),
  state TEXT NOT NULL CHECK (state IN (${list(JOB_STATES)})),
  attempts INTEGER NOT NULL CHECK (attempts >= 0),
  next_attempt_ms INTEGER NOT NULL,
  challenge_id TEXT,
  challenge_deadline_ms INTEGER,
  lease_owner TEXT,
  lease_generation INTEGER NOT NULL CHECK (lease_generation >= 0),
  lease_expires_ms INTEGER,
  created_ms INTEGER NOT NULL,
  updated_ms INTEGER NOT NULL,
  last_error TEXT,
  CHECK ((state = 'LEASED') = (lease_owner IS NOT NULL AND lease_expires_ms IS NOT NULL)),
  CHECK ((challenge_id IS NULL) = (challenge_deadline_ms IS NULL))
);
CREATE INDEX fed_jobs_by_state ON fed_jobs(state, next_attempt_ms);
CREATE TABLE fed_deliveries (
  job_id TEXT NOT NULL REFERENCES fed_jobs(job_id),
  conformance_validator_id TEXT NOT NULL,
  lease_generation INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  at_ms INTEGER NOT NULL,
  outcome TEXT NOT NULL,
  PRIMARY KEY (job_id, conformance_validator_id, seq)
);
CREATE TABLE fed_violations (
  violation_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  conformance_validator_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  ref TEXT NOT NULL,
  at_ms INTEGER NOT NULL,
  UNIQUE (conformance_validator_id, kind, ref)
);
CREATE TABLE fed_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN (${list(FEDERATION_EVENT_KINDS)})),
  at_ms INTEGER NOT NULL,
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('operator', 'validator', 'job', 'federation')),
  subject_id TEXT NOT NULL,
  detail_json TEXT NOT NULL CHECK (length(detail_json) <= ${FEDERATION_TIMING.maxEventDetailBytes})
);

${APPEND_ONLY.map(
  (t) => `CREATE TRIGGER ${t}_no_update BEFORE UPDATE ON ${t} BEGIN SELECT RAISE(ABORT, 'fed:immutable ${t}'); END;
CREATE TRIGGER ${t}_no_delete BEFORE DELETE ON ${t} BEGIN SELECT RAISE(ABORT, 'fed:immutable ${t}'); END;`,
).join('\n')}
CREATE TRIGGER fed_meta_no_delete BEFORE DELETE ON fed_meta BEGIN SELECT RAISE(ABORT, 'fed:immutable fed_meta'); END;
CREATE TRIGGER fed_meta_monotonic BEFORE UPDATE ON fed_meta
WHEN NEW.id IS NOT OLD.id OR NEW.schema_version IS NOT OLD.schema_version OR NEW.synthetic IS NOT OLD.synthetic OR NEW.state_seq < OLD.state_seq OR NEW.clock_hwm_ms < OLD.clock_hwm_ms
BEGIN SELECT RAISE(ABORT, 'fed:meta only moves forward'); END;
CREATE TRIGGER fed_heartbeat_heads_no_delete BEFORE DELETE ON fed_heartbeat_heads BEGIN SELECT RAISE(ABORT, 'fed:immutable fed_heartbeat_heads'); END;
CREATE TRIGGER fed_heartbeat_heads_monotonic BEFORE UPDATE ON fed_heartbeat_heads
WHEN NEW.conformance_validator_id IS NOT OLD.conformance_validator_id OR NEW.sequence <= OLD.sequence OR NEW.emitted_ms < OLD.emitted_ms OR NEW.received_ms < OLD.received_ms
BEGIN SELECT RAISE(ABORT, 'fed:heartbeat sequence only increases'); END;
CREATE TRIGGER fed_jobs_no_delete BEFORE DELETE ON fed_jobs BEGIN SELECT RAISE(ABORT, 'fed:immutable fed_jobs'); END;
CREATE TRIGGER fed_jobs_identity BEFORE UPDATE ON fed_jobs
WHEN NEW.job_id IS NOT OLD.job_id OR NEW.purpose IS NOT OLD.purpose OR NEW.organization_id IS NOT OLD.organization_id OR NEW.integration_digest IS NOT OLD.integration_digest
  OR NEW.challenge_type IS NOT OLD.challenge_type OR NEW.operation IS NOT OLD.operation OR NEW.fixture_ref IS NOT OLD.fixture_ref OR NEW.authorization_id IS NOT OLD.authorization_id
  OR NEW.assignments_json IS NOT OLD.assignments_json OR NEW.required_operators IS NOT OLD.required_operators OR NEW.deadline_seconds IS NOT OLD.deadline_seconds OR NEW.created_ms IS NOT OLD.created_ms
BEGIN SELECT RAISE(ABORT, 'fed:job identity is immutable'); END;
CREATE TRIGGER fed_jobs_terminal BEFORE UPDATE ON fed_jobs
WHEN OLD.state IN ('COMPLETED', 'EXPIRED', 'FAILED_FINAL', 'CANCELLED')
BEGIN SELECT RAISE(ABORT, 'fed:terminal job'); END;
CREATE TRIGGER fed_jobs_edges BEFORE UPDATE ON fed_jobs
WHEN NOT (${EDGE_SQL})
BEGIN SELECT RAISE(ABORT, 'fed:job transition not allowed'); END;
CREATE TRIGGER fed_jobs_fencing BEFORE UPDATE ON fed_jobs
WHEN NEW.lease_generation < OLD.lease_generation OR NEW.attempts < OLD.attempts OR NEW.updated_ms < OLD.updated_ms
  OR (NEW.state = 'LEASED' AND OLD.state <> 'LEASED' AND NEW.lease_generation <> OLD.lease_generation + 1)
  OR (NEW.state = 'LEASED' AND OLD.state = 'LEASED' AND NEW.lease_owner IS NOT OLD.lease_owner AND NEW.lease_generation <> OLD.lease_generation + 1)
  OR (NEW.state = 'LEASED' AND OLD.state = 'LEASED' AND NEW.lease_owner IS OLD.lease_owner AND NEW.lease_generation <> OLD.lease_generation)
BEGIN SELECT RAISE(ABORT, 'fed:fencing token must advance on every new lease'); END;
CREATE TRIGGER fed_jobs_challenge_once BEFORE UPDATE ON fed_jobs
WHEN OLD.challenge_id IS NOT NULL AND (NEW.challenge_id IS NOT OLD.challenge_id OR NEW.challenge_deadline_ms IS NOT OLD.challenge_deadline_ms)
BEGIN SELECT RAISE(ABORT, 'fed:challenge binding is write-once'); END;
CREATE TRIGGER fed_jobs_insert BEFORE INSERT ON fed_jobs
WHEN NEW.state <> 'PENDING' OR NEW.attempts <> 0 OR NEW.lease_generation <> 0 OR NEW.challenge_id IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'fed:a job starts PENDING and unleased'); END;
${(['operator', 'validator'] as const)
  .map(
    (k) => `CREATE TRIGGER fed_${k}_states_sequence BEFORE INSERT ON fed_${k}_states
WHEN NEW.version <> COALESCE((SELECT MAX(version) FROM fed_${k}_states WHERE ${k}_id = NEW.${k}_id), 0) + 1
  OR (SELECT state FROM fed_${k}_states WHERE ${k}_id = NEW.${k}_id ORDER BY version DESC LIMIT 1) = 'REVOKED'
BEGIN SELECT RAISE(ABORT, 'fed:${k} history is sequential and REVOKED is terminal'); END;`,
  )
  .join('\n')}
CREATE TRIGGER fed_generation_states_sequence BEFORE INSERT ON fed_generation_states
WHEN NEW.version <> COALESCE((SELECT MAX(version) FROM fed_generation_states WHERE validator_id = NEW.validator_id AND generation = NEW.generation), 0) + 1
  OR (SELECT state FROM fed_generation_states WHERE validator_id = NEW.validator_id AND generation = NEW.generation ORDER BY version DESC LIMIT 1) = 'REVOKED'
  OR ((SELECT state FROM fed_generation_states WHERE validator_id = NEW.validator_id AND generation = NEW.generation ORDER BY version DESC LIMIT 1) IN ('QUARANTINED', 'RETIRED') AND NEW.state <> 'REVOKED')
BEGIN SELECT RAISE(ABORT, 'fed:a retired, revoked or quarantined generation never returns'); END;
CREATE TRIGGER fed_generations_sequence BEFORE INSERT ON fed_generations
WHEN NEW.generation <> COALESCE((SELECT MAX(generation) FROM fed_generations WHERE validator_id = NEW.validator_id), 0) + 1
  OR NEW.operator_id IS NOT (SELECT operator_id FROM fed_validators WHERE validator_id = NEW.validator_id)
BEGIN SELECT RAISE(ABORT, 'fed:generations are sequential and pinned to the validator operator'); END;
`;

const TABLES = Object.freeze([
  'fed_meta', 'fed_operators', 'fed_operator_states', 'fed_validators', 'fed_validator_states', 'fed_generations', 'fed_generation_states', 'fed_possession_requests',
  'fed_possession_consumed', 'fed_sessions', 'fed_heartbeat_heads', 'fed_authorizations', 'fed_consumed_decisions', 'fed_jobs', 'fed_deliveries', 'fed_violations', 'fed_events',
]);

export type FederationStoreErrorCode = 'OPEN_REFUSED' | 'CORRUPT' | 'ROLLBACK_DETECTED' | 'CLOCK_REGRESSION' | 'CONFLICT' | 'FENCED' | 'QUEUE_FULL' | 'INVARIANT_REFUSED' | 'BUSY' | 'NOT_FOUND';

export class FederationStoreError extends Error {
  readonly code: FederationStoreErrorCode;
  readonly detail: string;
  constructor(code: FederationStoreErrorCode, detail: string) {
    super(`Federation store: ${code} (${detail})`);
    this.name = 'FederationStoreError';
    this.code = code;
    this.detail = detail;
  }
}

function mapError(error: unknown): FederationStoreError {
  if (error instanceof FederationStoreError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const code = typeof error === 'object' && error !== null ? String((error as { code?: unknown }).code ?? '') : '';
  if (code.startsWith('SQLITE_BUSY') || code.startsWith('SQLITE_LOCKED')) return new FederationStoreError('BUSY', 'database is busy');
  if (code === 'SQLITE_CONSTRAINT_PRIMARYKEY' || code === 'SQLITE_CONSTRAINT_UNIQUE') return new FederationStoreError('CONFLICT', message);
  return new FederationStoreError('INVARIANT_REFUSED', message);
}

export interface StateEntry<S extends string> {
  readonly state: S;
  readonly version: number;
  readonly atMs: number;
  readonly reason: string;
}

export interface GenerationRow {
  readonly validatorId: string;
  readonly generation: number;
  readonly conformanceValidatorId: string;
  readonly operatorId: string;
  readonly keyId: string;
  readonly publicKeyPem: string;
  readonly validFromMs: number;
  readonly validUntilMs: number;
  readonly enrollmentKind: 'ENROLL' | 'ROTATE' | 'REINSTATE';
  readonly bindingDigest: string;
  readonly createdMs: number;
}

export interface PossessionRequestRow {
  readonly requestId: string;
  readonly kind: 'ENROLL' | 'ROTATE' | 'REINSTATE';
  readonly validatorId: string;
  readonly operatorId: string;
  readonly generation: number;
  readonly keyId: string;
  readonly publicKeyPem: string;
  readonly validFromMs: number;
  readonly validUntilMs: number;
  readonly nonce: string;
  readonly issuedMs: number;
  readonly expiresMs: number;
}

export interface HeartbeatHead {
  readonly conformanceValidatorId: string;
  readonly sessionId: string;
  readonly sequence: number;
  readonly emittedMs: number;
  readonly receivedMs: number;
  readonly heartbeatDigest: string;
  readonly operationalState: 'READY' | 'DRAINING';
}

export interface StoredAuthorization {
  readonly record: TestingAuthorization;
  readonly recordDigest: string;
}

export interface FederationConsumedDecision {
  readonly decisionId: string;
  readonly action: string;
  readonly subjectRef: string;
  readonly bindingDigest: string;
}

export interface NewJob {
  readonly jobId: string;
  readonly purpose: JobPurpose;
  readonly organizationId: string;
  readonly integrationDigest: string;
  readonly challengeType: string;
  readonly operation: string;
  readonly fixtureRef: string;
  readonly authorizationId: string;
  readonly assignments: readonly JobAssignment[];
  readonly requiredOperators: number;
  readonly deadlineSeconds: number;
  readonly nextAttemptMs: number;
}

/** What a fenced commit may change. Everything else about the job is immutable. */
export interface JobPatch {
  readonly state: Exclude<JobState, 'PENDING' | 'LEASED'>;
  readonly attempts?: number;
  readonly nextAttemptMs?: number;
  readonly challenge?: { readonly challengeId: string; readonly deadlineMs: number };
  readonly lastError?: string | null;
}

export interface FederationStore {
  readonly path: string;
  /** The durable write sequence: pin it to detect a restored older copy on the next open. */
  stateSeq(): number;
  clockHighWaterMs(): number;
  /** Refuses (CLOCK_REGRESSION) a presented clock more than the tolerance behind the durable high-water mark, else advances the mark. */
  observeClock(nowMs: number): void;
  /** Runs `fn` in one IMMEDIATE transaction (nested calls become savepoints). */
  atomically<T>(fn: () => T): T;

  insertOperator(record: FederationOperatorRecord, atMs: number): void;
  getOperator(operatorId: string): FederationOperatorRecord | undefined;
  listOperators(): readonly FederationOperatorRecord[];
  appendOperatorState(operatorId: string, state: OperatorState, atMs: number, reason: string, decisions: readonly FederationConsumedDecision[]): StateEntry<OperatorState>;
  operatorState(operatorId: string): StateEntry<OperatorState> | undefined;
  operatorHistory(operatorId: string): readonly StateEntry<OperatorState>[];

  insertValidator(record: FederationValidatorRecord): void;
  getValidator(validatorId: string): FederationValidatorRecord | undefined;
  listValidators(): readonly FederationValidatorRecord[];
  appendValidatorState(validatorId: string, state: ValidatorState, atMs: number, reason: string, decisions: readonly FederationConsumedDecision[]): StateEntry<ValidatorState>;
  validatorState(validatorId: string): StateEntry<ValidatorState> | undefined;
  validatorHistory(validatorId: string): readonly StateEntry<ValidatorState>[];

  insertGeneration(row: GenerationRow): void;
  listGenerations(validatorId: string): readonly GenerationRow[];
  getGenerationByConformanceId(conformanceValidatorId: string): GenerationRow | undefined;
  getGenerationByKeyId(keyId: string): GenerationRow | undefined;
  appendGenerationState(validatorId: string, generation: number, state: GenerationState, atMs: number, reason: string): StateEntry<GenerationState>;
  generationState(validatorId: string, generation: number): StateEntry<GenerationState> | undefined;

  insertPossessionRequest(row: PossessionRequestRow): void;
  getPossessionRequest(requestId: string): PossessionRequestRow | undefined;
  isPossessionConsumed(requestId: string): boolean;
  consumePossession(requestId: string, atMs: number): void;

  insertSession(sessionId: string, conformanceValidatorId: string, issuedMs: number): void;
  getSession(sessionId: string): { readonly conformanceValidatorId: string; readonly issuedMs: number } | undefined;
  heartbeatHead(conformanceValidatorId: string): HeartbeatHead | undefined;
  /** Inserts or advances the head; the trigger refuses a non-increasing sequence or a clock that moved backwards. */
  writeHeartbeatHead(head: HeartbeatHead): void;

  insertAuthorization(record: TestingAuthorization, decisions: readonly FederationConsumedDecision[], atMs: number): void;
  getAuthorization(authorizationId: string): StoredAuthorization | undefined;

  isDecisionConsumed(decisionId: string): boolean;
  consumeDecisions(decisions: readonly FederationConsumedDecision[], consumedFor: string, atMs: number): void;

  /** Inserts a PENDING job, or returns `identical` for the same job id and content (idempotent scheduling). QUEUE_FULL at the bound. */
  insertJob(job: NewJob, atMs: number): 'inserted' | 'identical';
  getJob(jobId: string): ScheduledJob | undefined;
  listJobs(states?: readonly JobState[]): readonly ScheduledJob[];
  countOpenJobs(): number;
  /** Atomically takes the job if it is due (PENDING/RETRY_PENDING/DISPATCHED) or its LEASED lease has expired; advances the fencing token. */
  acquireLease(jobId: string, owner: string, nowMs: number, leaseMs: number): JobLease | null;
  renewLease(lease: JobLease, nowMs: number, leaseMs: number): JobLease;
  /** Binds the issued challenge to the job while keeping the lease (fenced; write-once by trigger). */
  bindChallengeWithLease(lease: JobLease, nowMs: number, challenge: { readonly challengeId: string; readonly deadlineMs: number }): ScheduledJob;
  /** Commits a state change only if `lease` is still the job's current, unexpired lease (FENCED otherwise). */
  commitWithLease(lease: JobLease, nowMs: number, patch: JobPatch): ScheduledJob;
  /** An expired lease is released back to RETRY_PENDING (attempt counted) without any worker's cooperation. */
  releaseExpiredLeases(nowMs: number): readonly string[];
  /** Coordinator-side transitions that need no lease: expiry at the challenge deadline / authorization end, and cancellation. */
  closeWithoutLease(jobId: string, nowMs: number, state: 'EXPIRED' | 'CANCELLED' | 'COMPLETED', reason: string): ScheduledJob;

  appendDelivery(jobId: string, conformanceValidatorId: string, leaseGeneration: number, atMs: number, outcome: string): void;
  listDeliveries(jobId: string): readonly { readonly conformanceValidatorId: string; readonly leaseGeneration: number; readonly atMs: number; readonly outcome: string }[];

  /** Records one attributable protocol violation; the same (validator, kind, ref) is recorded once. Returns false when it was already recorded. */
  recordViolation(conformanceValidatorId: string, kind: string, ref: string, atMs: number): boolean;
  countViolations(conformanceValidatorId: string, sinceMs: number): number;

  appendEvent(kind: FederationEventKind, atMs: number, subjectKind: FederationEvent['subjectKind'], subjectId: string, detail?: FederationEvent['detail']): void;
  listEvents(): readonly FederationEvent[];
  close(): void;
}

function tableSet(db: Database.Database): string[] {
  return (db.prepare("SELECT type, name, sql FROM sqlite_master WHERE type IN ('table', 'index', 'trigger') ORDER BY type, name").all() as { type: string; name: string; sql: string | null }[]).map(
    (row) => `${row.type}:${row.name}:${row.sql ?? ''}`,
  );
}

let canonicalSchema: string[] | undefined;
function schemaSet(): string[] {
  if (canonicalSchema === undefined) {
    const probe = new Database(':memory:');
    try {
      probe.exec(SCHEMA);
      canonicalSchema = tableSet(probe);
    } finally {
      probe.close();
    }
  }
  return canonicalSchema;
}

export interface FederationStoreOpenOptions {
  readonly create?: boolean;
  readonly busyTimeoutMs?: number;
  /** The `stateSeq()` the caller last observed (kept outside this file). A lower durable sequence is a restored older copy. */
  readonly expectedMinimumStateSeq?: number;
}

export function openFederationStore(path: string, options: FederationStoreOpenOptions = {}): FederationStore {
  const file = resolve(path);
  const create = options.create === true;
  if (create && existsSync(file)) throw new FederationStoreError('OPEN_REFUSED', 'a federation store already exists at that path; it is never re-initialized');
  if (!create && !existsSync(file)) throw new FederationStoreError('OPEN_REFUSED', 'no federation store exists at that path; it is never recreated implicitly');
  if (create) mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const db = new Database(file, create ? {} : { fileMustExist: true });
  try {
    db.pragma(`busy_timeout = ${Math.max(0, Math.floor(options.busyTimeoutMs ?? 2000))}`);
    db.pragma('foreign_keys = ON');
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = FULL');
    if (create) {
      db.transaction(() => {
        db.exec(SCHEMA);
        db.prepare('INSERT INTO fed_meta (id, schema_version, synthetic, state_seq, clock_hwm_ms) VALUES (1, ?, 1, 0, 0)').run(FEDERATION_STORE_SCHEMA_VERSION);
      }).immediate();
    } else {
      for (const table of TABLES) {
        if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) === undefined) throw new FederationStoreError('CORRUPT', `missing table ${table}`);
      }
      if (db.pragma('quick_check', { simple: true }) !== 'ok') throw new FederationStoreError('CORRUPT', 'integrity check failed');
      if (JSON.stringify(tableSet(db)) !== JSON.stringify(schemaSet())) throw new FederationStoreError('CORRUPT', 'tables or triggers differ from the schema');
      const meta = db.prepare('SELECT schema_version, synthetic, state_seq FROM fed_meta WHERE id = 1').get() as { schema_version: string; synthetic: number; state_seq: number } | undefined;
      if (meta?.schema_version !== FEDERATION_STORE_SCHEMA_VERSION || meta.synthetic !== 1) throw new FederationStoreError('CORRUPT', 'unexpected schema identity');
      if (options.expectedMinimumStateSeq !== undefined && meta.state_seq < options.expectedMinimumStateSeq) {
        throw new FederationStoreError('ROLLBACK_DETECTED', `durable sequence ${meta.state_seq} is behind the pinned ${options.expectedMinimumStateSeq}`);
      }
    }
  } catch (error) {
    db.close();
    throw error instanceof FederationStoreError ? error : new FederationStoreError('OPEN_REFUSED', 'the federation store could not be opened');
  }
  return buildStore(db, file);
}

// ---------------------------------------------------------------------------
// Row parsing: every JSON record is re-verified against its stored digest (F-07: corruption is refused, never repaired).
// ---------------------------------------------------------------------------

function parseRecord<T>(json: string, digest: string, what: string): T {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new FederationStoreError('CORRUPT', `${what} is not JSON`);
  }
  if (conformanceDigest(value) !== digest || canonicalizeConformance(value) !== json) throw new FederationStoreError('CORRUPT', `${what} does not match its digest`);
  return Object.freeze(value) as T;
}

function parseJson<T>(json: string | null, what: string): T {
  try {
    return JSON.parse(json ?? 'null') as T;
  } catch {
    throw new FederationStoreError('CORRUPT', `${what} is not JSON`);
  }
}

interface JobRow {
  job_id: string;
  purpose: string;
  organization_id: string;
  integration_digest: string;
  challenge_type: string;
  operation: string;
  fixture_ref: string;
  authorization_id: string;
  assignments_json: string;
  required_operators: number;
  deadline_seconds: number;
  state: string;
  attempts: number;
  next_attempt_ms: number;
  challenge_id: string | null;
  challenge_deadline_ms: number | null;
  lease_owner: string | null;
  lease_generation: number;
  lease_expires_ms: number | null;
  created_ms: number;
  updated_ms: number;
  last_error: string | null;
}

function parseAssignments(json: string): readonly JobAssignment[] {
  const value = parseJson<unknown>(json, 'job assignments');
  const ok =
    Array.isArray(value) &&
    value.length >= 1 &&
    value.every(
      (a: unknown) =>
        typeof a === 'object' && a !== null && typeof (a as JobAssignment).validatorId === 'string' && Number.isSafeInteger((a as JobAssignment).generation) &&
        typeof (a as JobAssignment).conformanceValidatorId === 'string' && typeof (a as JobAssignment).operatorId === 'string' && Object.keys(a).length === 4,
    );
  if (!ok) throw new FederationStoreError('CORRUPT', 'job assignments are malformed');
  return Object.freeze((value as JobAssignment[]).map((a) => Object.freeze({ ...a })));
}

function toJob(row: JobRow): ScheduledJob {
  if (!(JOB_STATES as readonly string[]).includes(row.state) || !(JOB_PURPOSES as readonly string[]).includes(row.purpose)) throw new FederationStoreError('CORRUPT', 'job row is malformed');
  return Object.freeze({
    jobId: row.job_id,
    purpose: row.purpose as JobPurpose,
    organizationId: row.organization_id,
    integrationDigest: row.integration_digest,
    challengeType: row.challenge_type as ScheduledJob['challengeType'],
    operation: row.operation,
    fixtureRef: row.fixture_ref,
    authorizationId: row.authorization_id,
    assignments: parseAssignments(row.assignments_json),
    requiredOperators: row.required_operators,
    deadlineSeconds: row.deadline_seconds,
    state: row.state as JobState,
    attempts: row.attempts,
    nextAttemptMs: row.next_attempt_ms,
    challengeId: row.challenge_id,
    challengeDeadlineMs: row.challenge_deadline_ms,
    leaseOwner: row.lease_owner,
    leaseGeneration: row.lease_generation,
    leaseExpiresMs: row.lease_expires_ms,
    createdMs: row.created_ms,
    updatedMs: row.updated_ms,
    lastError: row.last_error,
  });
}

const OPEN_STATES = ['PENDING', 'LEASED', 'DISPATCHED', 'RETRY_PENDING'] as const;

function buildStore(db: Database.Database, file: string): FederationStore {
  const bump = () => db.prepare('UPDATE fed_meta SET state_seq = state_seq + 1 WHERE id = 1').run();
  const write = <T>(fn: () => T): T => {
    try {
      return db.transaction((): T => {
        const result = fn();
        bump();
        return result;
      }).immediate();
    } catch (error) {
      throw mapError(error);
    }
  };
  const decisionsJson = (decisions: readonly FederationConsumedDecision[]) => JSON.stringify(decisions.map((d) => d.decisionId));
  const stateOf = <S extends string>(table: string, key: string, id: string, states: readonly string[]): StateEntry<S> | undefined => {
    const row = db.prepare(`SELECT state, version, at_ms, reason FROM ${table} WHERE ${key} = ? ORDER BY version DESC LIMIT 1`).get(id) as { state: string; version: number; at_ms: number; reason: string } | undefined;
    if (row === undefined) return undefined;
    if (!states.includes(row.state)) throw new FederationStoreError('CORRUPT', `${table} state is unknown`);
    return Object.freeze({ state: row.state as S, version: row.version, atMs: row.at_ms, reason: row.reason });
  };
  const historyOf = <S extends string>(table: string, key: string, id: string): readonly StateEntry<S>[] =>
    Object.freeze(
      (db.prepare(`SELECT state, version, at_ms, reason FROM ${table} WHERE ${key} = ? ORDER BY version`).all(id) as { state: string; version: number; at_ms: number; reason: string }[]).map((r) =>
        Object.freeze({ state: r.state as S, version: r.version, atMs: r.at_ms, reason: r.reason }),
      ),
    );
  const consume = (decisions: readonly FederationConsumedDecision[], consumedFor: string, atMs: number) => {
    const insert = db.prepare('INSERT INTO fed_consumed_decisions (decision_id, action, subject_ref, binding_digest, consumed_for, consumed_ms) VALUES (?, ?, ?, ?, ?, ?)');
    for (const d of decisions) insert.run(d.decisionId, d.action, d.subjectRef, d.bindingDigest, consumedFor, atMs);
  };
  const toGeneration = (r: Record<string, unknown>): GenerationRow =>
    Object.freeze({
      validatorId: String(r['validator_id']),
      generation: Number(r['generation']),
      conformanceValidatorId: String(r['conformance_validator_id']),
      operatorId: String(r['operator_id']),
      keyId: String(r['key_id']),
      publicKeyPem: String(r['public_key_pem']),
      validFromMs: Number(r['valid_from_ms']),
      validUntilMs: Number(r['valid_until_ms']),
      enrollmentKind: r['enrollment_kind'] as GenerationRow['enrollmentKind'],
      bindingDigest: String(r['binding_digest']),
      createdMs: Number(r['created_ms']),
    });
  const getJobRow = (jobId: string) => db.prepare('SELECT * FROM fed_jobs WHERE job_id = ?').get(jobId) as JobRow | undefined;

  const store: FederationStore = {
    path: file,
    stateSeq: () => (db.prepare('SELECT state_seq FROM fed_meta WHERE id = 1').get() as { state_seq: number }).state_seq,
    clockHighWaterMs: () => (db.prepare('SELECT clock_hwm_ms FROM fed_meta WHERE id = 1').get() as { clock_hwm_ms: number }).clock_hwm_ms,
    observeClock(nowMs) {
      if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new FederationStoreError('CLOCK_REGRESSION', 'the presented clock is not a valid instant');
      write(() => {
        const hwm = (db.prepare('SELECT clock_hwm_ms FROM fed_meta WHERE id = 1').get() as { clock_hwm_ms: number }).clock_hwm_ms;
        if (nowMs < hwm - FEDERATION_TIMING.clockRegressionToleranceSeconds * 1000) throw new FederationStoreError('CLOCK_REGRESSION', `presented ${nowMs} is behind the durable high-water mark ${hwm}`);
        if (nowMs > hwm) db.prepare('UPDATE fed_meta SET clock_hwm_ms = ? WHERE id = 1').run(nowMs);
      });
    },
    atomically: (fn) => write(fn),

    insertOperator(record, atMs) {
      const json = canonicalizeConformance(record);
      write(() => {
        db.prepare('INSERT INTO fed_operators (operator_id, record_json, record_digest, synthetic) VALUES (?, ?, ?, 1)').run(record.operatorId, json, conformanceDigest(record));
        db.prepare("INSERT INTO fed_operator_states (operator_id, version, state, at_ms, reason, decisions_json) VALUES (?, 1, 'REGISTERED', ?, 'REGISTERED', '[]')").run(record.operatorId, atMs);
      });
    },
    getOperator(operatorId) {
      const row = db.prepare('SELECT record_json, record_digest FROM fed_operators WHERE operator_id = ?').get(operatorId) as { record_json: string; record_digest: string } | undefined;
      return row === undefined ? undefined : parseRecord<FederationOperatorRecord>(row.record_json, row.record_digest, 'operator record');
    },
    listOperators() {
      return Object.freeze(
        (db.prepare('SELECT record_json, record_digest FROM fed_operators ORDER BY operator_id').all() as { record_json: string; record_digest: string }[]).map((r) =>
          parseRecord<FederationOperatorRecord>(r.record_json, r.record_digest, 'operator record'),
        ),
      );
    },
    appendOperatorState(operatorId, state, atMs, reason, decisions) {
      return write(() => {
        const version = (stateOf<OperatorState>('fed_operator_states', 'operator_id', operatorId, OPERATOR_STATES)?.version ?? 0) + 1;
        if (decisions.length > 0) consume(decisions, `operator:${operatorId}:${version}`, atMs);
        db.prepare('INSERT INTO fed_operator_states (operator_id, version, state, at_ms, reason, decisions_json) VALUES (?, ?, ?, ?, ?, ?)').run(operatorId, version, state, atMs, reason, decisionsJson(decisions));
        return Object.freeze({ state, version, atMs, reason });
      });
    },
    operatorState: (operatorId) => stateOf<OperatorState>('fed_operator_states', 'operator_id', operatorId, OPERATOR_STATES),
    operatorHistory: (operatorId) => historyOf<OperatorState>('fed_operator_states', 'operator_id', operatorId),

    insertValidator(record) {
      const json = canonicalizeConformance(record);
      write(() => {
        db.prepare('INSERT INTO fed_validators (validator_id, operator_id, record_json, record_digest, synthetic) VALUES (?, ?, ?, ?, 1)').run(record.validatorId, record.operatorId, json, conformanceDigest(record));
      });
    },
    getValidator(validatorId) {
      const row = db.prepare('SELECT operator_id, record_json, record_digest FROM fed_validators WHERE validator_id = ?').get(validatorId) as { operator_id: string; record_json: string; record_digest: string } | undefined;
      if (row === undefined) return undefined;
      const record = parseRecord<FederationValidatorRecord>(row.record_json, row.record_digest, 'validator record');
      if (record.operatorId !== row.operator_id || record.validatorId !== validatorId) throw new FederationStoreError('CORRUPT', 'validator binding differs from its record');
      return record;
    },
    listValidators() {
      return Object.freeze(
        (db.prepare('SELECT validator_id FROM fed_validators ORDER BY validator_id').all() as { validator_id: string }[]).map((r) => store.getValidator(r.validator_id) as FederationValidatorRecord),
      );
    },
    appendValidatorState(validatorId, state, atMs, reason, decisions) {
      return write(() => {
        const version = (stateOf<ValidatorState>('fed_validator_states', 'validator_id', validatorId, VALIDATOR_STATES)?.version ?? 0) + 1;
        if (decisions.length > 0) consume(decisions, `validator:${validatorId}:${version}`, atMs);
        db.prepare('INSERT INTO fed_validator_states (validator_id, version, state, at_ms, reason, decisions_json) VALUES (?, ?, ?, ?, ?, ?)').run(validatorId, version, state, atMs, reason, decisionsJson(decisions));
        return Object.freeze({ state, version, atMs, reason });
      });
    },
    validatorState: (validatorId) => stateOf<ValidatorState>('fed_validator_states', 'validator_id', validatorId, VALIDATOR_STATES),
    validatorHistory: (validatorId) => historyOf<ValidatorState>('fed_validator_states', 'validator_id', validatorId),

    insertGeneration(row) {
      write(() => {
        db.prepare(
          'INSERT INTO fed_generations (validator_id, generation, conformance_validator_id, operator_id, key_id, public_key_pem, valid_from_ms, valid_until_ms, enrollment_kind, binding_digest, created_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        ).run(row.validatorId, row.generation, row.conformanceValidatorId, row.operatorId, row.keyId, row.publicKeyPem, row.validFromMs, row.validUntilMs, row.enrollmentKind, row.bindingDigest, row.createdMs);
        db.prepare("INSERT INTO fed_generation_states (validator_id, generation, version, state, at_ms, reason) VALUES (?, ?, 1, 'PENDING', ?, ?)").run(row.validatorId, row.generation, row.createdMs, row.enrollmentKind);
      });
    },
    listGenerations(validatorId) {
      return Object.freeze((db.prepare('SELECT * FROM fed_generations WHERE validator_id = ? ORDER BY generation').all(validatorId) as Record<string, unknown>[]).map(toGeneration));
    },
    getGenerationByConformanceId(id) {
      const row = db.prepare('SELECT * FROM fed_generations WHERE conformance_validator_id = ?').get(id) as Record<string, unknown> | undefined;
      return row === undefined ? undefined : toGeneration(row);
    },
    getGenerationByKeyId(keyId) {
      const row = db.prepare('SELECT * FROM fed_generations WHERE key_id = ?').get(keyId) as Record<string, unknown> | undefined;
      return row === undefined ? undefined : toGeneration(row);
    },
    appendGenerationState(validatorId, generation, state, atMs, reason) {
      return write(() => {
        const current = db.prepare('SELECT MAX(version) AS v FROM fed_generation_states WHERE validator_id = ? AND generation = ?').get(validatorId, generation) as { v: number | null };
        const version = (current.v ?? 0) + 1;
        db.prepare('INSERT INTO fed_generation_states (validator_id, generation, version, state, at_ms, reason) VALUES (?, ?, ?, ?, ?, ?)').run(validatorId, generation, version, state, atMs, reason);
        return Object.freeze({ state, version, atMs, reason });
      });
    },
    generationState(validatorId, generation) {
      const row = db.prepare('SELECT state, version, at_ms, reason FROM fed_generation_states WHERE validator_id = ? AND generation = ? ORDER BY version DESC LIMIT 1').get(validatorId, generation) as
        | { state: string; version: number; at_ms: number; reason: string }
        | undefined;
      if (row === undefined) return undefined;
      if (!(GENERATION_STATES as readonly string[]).includes(row.state)) throw new FederationStoreError('CORRUPT', 'generation state is unknown');
      return Object.freeze({ state: row.state as GenerationState, version: row.version, atMs: row.at_ms, reason: row.reason });
    },

    insertPossessionRequest(row) {
      write(() => {
        db.prepare(
          'INSERT INTO fed_possession_requests (request_id, kind, validator_id, operator_id, generation, key_id, public_key_pem, valid_from_ms, valid_until_ms, nonce, issued_ms, expires_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        ).run(row.requestId, row.kind, row.validatorId, row.operatorId, row.generation, row.keyId, row.publicKeyPem, row.validFromMs, row.validUntilMs, row.nonce, row.issuedMs, row.expiresMs);
      });
    },
    getPossessionRequest(requestId) {
      const r = db.prepare('SELECT * FROM fed_possession_requests WHERE request_id = ?').get(requestId) as Record<string, unknown> | undefined;
      if (r === undefined) return undefined;
      return Object.freeze({
        requestId: String(r['request_id']),
        kind: r['kind'] as PossessionRequestRow['kind'],
        validatorId: String(r['validator_id']),
        operatorId: String(r['operator_id']),
        generation: Number(r['generation']),
        keyId: String(r['key_id']),
        publicKeyPem: String(r['public_key_pem']),
        validFromMs: Number(r['valid_from_ms']),
        validUntilMs: Number(r['valid_until_ms']),
        nonce: String(r['nonce']),
        issuedMs: Number(r['issued_ms']),
        expiresMs: Number(r['expires_ms']),
      });
    },
    isPossessionConsumed: (requestId) => db.prepare('SELECT 1 FROM fed_possession_consumed WHERE request_id = ?').get(requestId) !== undefined,
    consumePossession(requestId, atMs) {
      write(() => {
        db.prepare('INSERT INTO fed_possession_consumed (request_id, consumed_ms) VALUES (?, ?)').run(requestId, atMs);
      });
    },

    insertSession(sessionId, conformanceValidatorId, issuedMs) {
      write(() => {
        db.prepare('INSERT INTO fed_sessions (session_id, conformance_validator_id, issued_ms) VALUES (?, ?, ?)').run(sessionId, conformanceValidatorId, issuedMs);
      });
    },
    getSession(sessionId) {
      const r = db.prepare('SELECT conformance_validator_id, issued_ms FROM fed_sessions WHERE session_id = ?').get(sessionId) as { conformance_validator_id: string; issued_ms: number } | undefined;
      return r === undefined ? undefined : Object.freeze({ conformanceValidatorId: r.conformance_validator_id, issuedMs: r.issued_ms });
    },
    heartbeatHead(id) {
      const r = db.prepare('SELECT * FROM fed_heartbeat_heads WHERE conformance_validator_id = ?').get(id) as Record<string, unknown> | undefined;
      if (r === undefined) return undefined;
      return Object.freeze({
        conformanceValidatorId: String(r['conformance_validator_id']),
        sessionId: String(r['session_id']),
        sequence: Number(r['sequence']),
        emittedMs: Number(r['emitted_ms']),
        receivedMs: Number(r['received_ms']),
        heartbeatDigest: String(r['heartbeat_digest']),
        operationalState: r['operational_state'] as HeartbeatHead['operationalState'],
      });
    },
    writeHeartbeatHead(head) {
      write(() => {
        const exists = db.prepare('SELECT 1 FROM fed_heartbeat_heads WHERE conformance_validator_id = ?').get(head.conformanceValidatorId) !== undefined;
        if (exists) {
          db.prepare('UPDATE fed_heartbeat_heads SET session_id = ?, sequence = ?, emitted_ms = ?, received_ms = ?, heartbeat_digest = ?, operational_state = ? WHERE conformance_validator_id = ?').run(
            head.sessionId, head.sequence, head.emittedMs, head.receivedMs, head.heartbeatDigest, head.operationalState, head.conformanceValidatorId,
          );
        } else {
          db.prepare('INSERT INTO fed_heartbeat_heads (conformance_validator_id, session_id, sequence, emitted_ms, received_ms, heartbeat_digest, operational_state) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
            head.conformanceValidatorId, head.sessionId, head.sequence, head.emittedMs, head.receivedMs, head.heartbeatDigest, head.operationalState,
          );
        }
      });
    },

    insertAuthorization(record, decisions, atMs) {
      write(() => {
        consume(decisions, `authorization:${record.authorizationId}`, atMs);
        db.prepare('INSERT INTO fed_authorizations (authorization_id, organization_id, integration_digest, not_before_ms, not_after_ms, record_json, record_digest, decisions_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
          record.authorizationId, record.organizationId, record.integrationDigest, Date.parse(record.notBefore), Date.parse(record.notAfter), canonicalizeConformance(record), conformanceDigest(record), decisionsJson(decisions),
        );
      });
    },
    getAuthorization(authorizationId) {
      const r = db.prepare('SELECT record_json, record_digest, organization_id, integration_digest FROM fed_authorizations WHERE authorization_id = ?').get(authorizationId) as
        | { record_json: string; record_digest: string; organization_id: string; integration_digest: string }
        | undefined;
      if (r === undefined) return undefined;
      const record = parseRecord<TestingAuthorization>(r.record_json, r.record_digest, 'testing authorization');
      if (record.organizationId !== r.organization_id || record.integrationDigest !== r.integration_digest) throw new FederationStoreError('CORRUPT', 'authorization columns differ from its record');
      return Object.freeze({ record, recordDigest: r.record_digest });
    },

    isDecisionConsumed: (decisionId) => db.prepare('SELECT 1 FROM fed_consumed_decisions WHERE decision_id = ?').get(decisionId) !== undefined,
    consumeDecisions(decisions, consumedFor, atMs) {
      write(() => consume(decisions, consumedFor, atMs));
    },

    insertJob(job, atMs) {
      return write((): 'inserted' | 'identical' => {
        const assignmentsJson = canonicalizeConformance(job.assignments.map((a) => ({ validatorId: a.validatorId, generation: a.generation, conformanceValidatorId: a.conformanceValidatorId, operatorId: a.operatorId })));
        const existing = getJobRow(job.jobId);
        if (existing !== undefined) {
          const same =
            existing.purpose === job.purpose && existing.organization_id === job.organizationId && existing.integration_digest === job.integrationDigest && existing.challenge_type === job.challengeType &&
            existing.operation === job.operation && existing.fixture_ref === job.fixtureRef && existing.authorization_id === job.authorizationId && existing.assignments_json === assignmentsJson &&
            existing.required_operators === job.requiredOperators && existing.deadline_seconds === job.deadlineSeconds;
          if (!same) throw new FederationStoreError('CONFLICT', 'a different job already holds this id');
          return 'identical';
        }
        const open = (db.prepare(`SELECT COUNT(*) AS n FROM fed_jobs WHERE state IN (${list(OPEN_STATES)})`).get() as { n: number }).n;
        if (open >= FEDERATION_TIMING.maxOpenJobs) throw new FederationStoreError('QUEUE_FULL', `${open} open jobs`);
        db.prepare(
          `INSERT INTO fed_jobs (job_id, purpose, organization_id, integration_digest, challenge_type, operation, fixture_ref, authorization_id, assignments_json, required_operators, deadline_seconds, state, attempts, next_attempt_ms, challenge_id, challenge_deadline_ms, lease_owner, lease_generation, lease_expires_ms, created_ms, updated_ms, last_error)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', 0, ?, NULL, NULL, NULL, 0, NULL, ?, ?, NULL)`,
        ).run(job.jobId, job.purpose, job.organizationId, job.integrationDigest, job.challengeType, job.operation, job.fixtureRef, job.authorizationId, assignmentsJson, job.requiredOperators, job.deadlineSeconds, job.nextAttemptMs, atMs, atMs);
        return 'inserted';
      });
    },
    getJob(jobId) {
      const row = getJobRow(jobId);
      return row === undefined ? undefined : toJob(row);
    },
    listJobs(states) {
      const rows = (states === undefined
        ? db.prepare('SELECT * FROM fed_jobs ORDER BY created_ms, job_id').all()
        : db.prepare(`SELECT * FROM fed_jobs WHERE state IN (${list(states)}) ORDER BY created_ms, job_id`).all()) as JobRow[];
      return Object.freeze(rows.map(toJob));
    },
    countOpenJobs: () => (db.prepare(`SELECT COUNT(*) AS n FROM fed_jobs WHERE state IN (${list(OPEN_STATES)})`).get() as { n: number }).n,
    acquireLease(jobId, owner, nowMs, leaseMs) {
      return write((): JobLease | null => {
        const row = getJobRow(jobId);
        if (row === undefined) throw new FederationStoreError('NOT_FOUND', jobId);
        const due = (row.state === 'PENDING' || row.state === 'RETRY_PENDING' || row.state === 'DISPATCHED') && row.next_attempt_ms <= nowMs;
        const takeover = row.state === 'LEASED' && row.lease_expires_ms !== null && row.lease_expires_ms <= nowMs;
        if (!due && !takeover) return null;
        const generation = row.lease_generation + 1;
        const expiresMs = nowMs + leaseMs;
        const changed = db
          .prepare("UPDATE fed_jobs SET state = 'LEASED', lease_owner = ?, lease_generation = ?, lease_expires_ms = ?, updated_ms = MAX(updated_ms, ?) WHERE job_id = ? AND lease_generation = ? AND state = ?")
          .run(owner, generation, expiresMs, nowMs, jobId, row.lease_generation, row.state).changes;
        if (changed !== 1) return null;
        return Object.freeze({ jobId, owner, fencingToken: generation, expiresMs });
      });
    },
    bindChallengeWithLease(lease, nowMs, challenge) {
      return write((): ScheduledJob => {
        const row = getJobRow(lease.jobId);
        if (row === undefined) throw new FederationStoreError('NOT_FOUND', lease.jobId);
        if (row.challenge_id !== null && row.challenge_id === challenge.challengeId && row.challenge_deadline_ms === challenge.deadlineMs) return toJob(row);
        const changed = db
          .prepare(
            "UPDATE fed_jobs SET challenge_id = ?, challenge_deadline_ms = ?, updated_ms = MAX(updated_ms, ?) WHERE job_id = ? AND state = 'LEASED' AND lease_owner = ? AND lease_generation = ? AND lease_expires_ms > ?",
          )
          .run(challenge.challengeId, challenge.deadlineMs, nowMs, lease.jobId, lease.owner, lease.fencingToken, nowMs).changes;
        if (changed !== 1) throw new FederationStoreError('FENCED', `lease ${lease.fencingToken} on ${lease.jobId} is no longer current`);
        return toJob(getJobRow(lease.jobId) as JobRow);
      });
    },
    renewLease(lease, nowMs, leaseMs) {
      return write((): JobLease => {
        const expiresMs = nowMs + leaseMs;
        const changed = db
          .prepare("UPDATE fed_jobs SET lease_expires_ms = ?, updated_ms = MAX(updated_ms, ?) WHERE job_id = ? AND state = 'LEASED' AND lease_owner = ? AND lease_generation = ? AND lease_expires_ms > ?")
          .run(expiresMs, nowMs, lease.jobId, lease.owner, lease.fencingToken, nowMs).changes;
        if (changed !== 1) throw new FederationStoreError('FENCED', `lease ${lease.fencingToken} on ${lease.jobId} is no longer current`);
        return Object.freeze({ ...lease, expiresMs });
      });
    },
    commitWithLease(lease, nowMs, patch) {
      return write((): ScheduledJob => {
        const row = getJobRow(lease.jobId);
        if (row === undefined) throw new FederationStoreError('NOT_FOUND', lease.jobId);
        if (row.state !== 'LEASED' || row.lease_owner !== lease.owner || row.lease_generation !== lease.fencingToken || row.lease_expires_ms === null || row.lease_expires_ms <= nowMs) {
          throw new FederationStoreError('FENCED', `lease ${lease.fencingToken} on ${lease.jobId} is no longer current`);
        }
        const challengeId = patch.challenge?.challengeId ?? row.challenge_id;
        const challengeDeadline = patch.challenge?.deadlineMs ?? row.challenge_deadline_ms;
        const changed = db
          .prepare(
            `UPDATE fed_jobs SET state = ?, attempts = ?, next_attempt_ms = ?, challenge_id = ?, challenge_deadline_ms = ?, lease_owner = NULL, lease_expires_ms = NULL, updated_ms = MAX(updated_ms, ?), last_error = ?
             WHERE job_id = ? AND state = 'LEASED' AND lease_owner = ? AND lease_generation = ?`,
          )
          .run(patch.state, patch.attempts ?? row.attempts, patch.nextAttemptMs ?? row.next_attempt_ms, challengeId, challengeDeadline, nowMs, patch.lastError === undefined ? row.last_error : patch.lastError, lease.jobId, lease.owner, lease.fencingToken).changes;
        if (changed !== 1) throw new FederationStoreError('FENCED', `lease ${lease.fencingToken} on ${lease.jobId} lost during commit`);
        return toJob(getJobRow(lease.jobId) as JobRow);
      });
    },
    releaseExpiredLeases(nowMs) {
      return write((): readonly string[] => {
        const expired = db.prepare("SELECT job_id, attempts FROM fed_jobs WHERE state = 'LEASED' AND lease_expires_ms <= ? ORDER BY job_id").all(nowMs) as { job_id: string; attempts: number }[];
        for (const r of expired) {
          db.prepare("UPDATE fed_jobs SET state = 'RETRY_PENDING', attempts = attempts + 1, next_attempt_ms = ?, lease_owner = NULL, lease_expires_ms = NULL, updated_ms = MAX(updated_ms, ?), last_error = 'LEASE_EXPIRED' WHERE job_id = ? AND state = 'LEASED'").run(
            nowMs, nowMs, r.job_id,
          );
        }
        return Object.freeze(expired.map((r) => r.job_id));
      });
    },
    closeWithoutLease(jobId, nowMs, state, reason) {
      return write((): ScheduledJob => {
        const row = getJobRow(jobId);
        if (row === undefined) throw new FederationStoreError('NOT_FOUND', jobId);
        db.prepare('UPDATE fed_jobs SET state = ?, lease_owner = NULL, lease_expires_ms = NULL, updated_ms = MAX(updated_ms, ?), last_error = ? WHERE job_id = ?').run(state, nowMs, reason, jobId);
        return toJob(getJobRow(jobId) as JobRow);
      });
    },

    appendDelivery(jobId, conformanceValidatorId, leaseGeneration, atMs, outcome) {
      write(() => {
        const next = (db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS s FROM fed_deliveries WHERE job_id = ? AND conformance_validator_id = ?').get(jobId, conformanceValidatorId) as { s: number }).s;
        db.prepare('INSERT INTO fed_deliveries (job_id, conformance_validator_id, lease_generation, seq, at_ms, outcome) VALUES (?, ?, ?, ?, ?, ?)').run(jobId, conformanceValidatorId, leaseGeneration, next, atMs, outcome);
      });
    },
    listDeliveries(jobId) {
      return Object.freeze(
        (db.prepare('SELECT conformance_validator_id, lease_generation, at_ms, outcome FROM fed_deliveries WHERE job_id = ? ORDER BY at_ms, conformance_validator_id, seq').all(jobId) as {
          conformance_validator_id: string;
          lease_generation: number;
          at_ms: number;
          outcome: string;
        }[]).map((r) => Object.freeze({ conformanceValidatorId: r.conformance_validator_id, leaseGeneration: r.lease_generation, atMs: r.at_ms, outcome: r.outcome })),
      );
    },

    recordViolation(conformanceValidatorId, kind, ref, atMs) {
      return write((): boolean => db.prepare('INSERT OR IGNORE INTO fed_violations (conformance_validator_id, kind, ref, at_ms) VALUES (?, ?, ?, ?)').run(conformanceValidatorId, kind, ref, atMs).changes === 1);
    },
    countViolations(conformanceValidatorId, sinceMs) {
      return (db.prepare('SELECT COUNT(*) AS n FROM fed_violations WHERE conformance_validator_id = ? AND at_ms >= ?').get(conformanceValidatorId, sinceMs) as { n: number }).n;
    },

    appendEvent(kind, atMs, subjectKind, subjectId, detail = {}) {
      const json = canonicalizeConformance(detail);
      write(() => {
        db.prepare('INSERT INTO fed_events (kind, at_ms, subject_kind, subject_id, detail_json) VALUES (?, ?, ?, ?, ?)').run(kind, atMs, subjectKind, subjectId, json);
      });
    },
    listEvents() {
      return Object.freeze(
        (db.prepare('SELECT seq, kind, at_ms, subject_kind, subject_id, detail_json FROM fed_events ORDER BY seq').all() as {
          seq: number;
          kind: string;
          at_ms: number;
          subject_kind: string;
          subject_id: string;
          detail_json: string;
        }[]).map((r) =>
          Object.freeze({
            seq: r.seq,
            kind: r.kind as FederationEventKind,
            atMs: r.at_ms,
            subjectKind: r.subject_kind as FederationEvent['subjectKind'],
            subjectId: r.subject_id,
            detail: Object.freeze(parseJson<FederationEvent['detail']>(r.detail_json, 'event detail')),
          }),
        ),
      );
    },
    close() {
      db.close();
    },
  };
  return Object.freeze(store);
}
