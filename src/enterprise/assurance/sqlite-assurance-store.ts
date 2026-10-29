import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { AssuranceError } from './errors.js';
import { verifyAssuranceAssessment } from './verification.js';
import { applyFindingTransition, foldFindingStatus } from './findings.js';
import { assertCompletionCommit } from './finding-history.js';
import {
  canAccessAssuranceOrganization,
  requireAccessToAssuranceOrganization,
  requireAssuranceTenantScope,
  type AssuranceStore,
} from './assurance-store.js';
import type {
  AssuranceAccessContext,
  AssuranceAssessment,
  AssuranceAssessmentSummary,
  AssuranceFinding,
  AssuranceFindingEvent,
  AssuranceFindingEventType,
  AssuranceFramework,
  AssuranceManualReviewRecord,
  AssuranceSignal,
} from './contracts.js';
import { ASSURANCE_STORE_SCHEMA_VERSION, ASSURANCE_TERMINAL_STATUSES } from './contracts.js';
import { commercialReleaseCustodyViolations, type CommercialReleaseCustodyRecord } from './commercial-release-custody.js';

export interface CreateSqliteAssuranceStoreOptions {
  readonly now?: () => string;
  readonly busyTimeoutMs?: number;
}

const DEFAULT_BUSY_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------------------
// Schema (`aoc.assurance-store.schema.v1`). The assessment aggregate is
// canonical in `assessment_json`; the normalized child tables
// (evidence references, control evaluations, domain assessments, scores,
// eligibility) are written once, when the assessment reaches a terminal
// status, purely as queryable projections -- never a second source of truth.
// Finding events, manual reviews, and signals are append-only.
// ---------------------------------------------------------------------------
const SCHEMA_V1 = `
  CREATE TABLE IF NOT EXISTS assurance_store_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    schema_version TEXT NOT NULL,
    migration_state TEXT NOT NULL,
    recorded_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS assurance_frameworks (
    framework_id TEXT NOT NULL,
    framework_version TEXT NOT NULL,
    status TEXT NOT NULL,
    definition_json TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    PRIMARY KEY (framework_id, framework_version)
  );

  CREATE TABLE IF NOT EXISTS assurance_assessments (
    assessment_id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    subject_id TEXT NOT NULL,
    subject_type TEXT NOT NULL,
    framework_id TEXT NOT NULL,
    framework_version TEXT NOT NULL,
    status TEXT NOT NULL,
    normalized_score REAL NOT NULL,
    created_at TEXT NOT NULL,
    completed_at TEXT,
    superseded_by TEXT,
    assessment_json TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_assurance_assessments_org ON assurance_assessments(organization_id);
  CREATE INDEX IF NOT EXISTS idx_assurance_assessments_subject ON assurance_assessments(organization_id, subject_id);

  CREATE TABLE IF NOT EXISTS assurance_evidence_references (
    evidence_reference_id TEXT PRIMARY KEY,
    assessment_id TEXT NOT NULL REFERENCES assurance_assessments(assessment_id),
    organization_id TEXT NOT NULL,
    evidence_type TEXT NOT NULL,
    external_id TEXT NOT NULL,
    verified INTEGER NOT NULL,
    reference_json TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_assurance_evidence_assessment ON assurance_evidence_references(assessment_id);

  CREATE TABLE IF NOT EXISTS assurance_control_evaluations (
    control_evaluation_id TEXT PRIMARY KEY,
    assessment_id TEXT NOT NULL REFERENCES assurance_assessments(assessment_id),
    control_id TEXT NOT NULL,
    domain_id TEXT NOT NULL,
    status TEXT NOT NULL,
    evaluation_json TEXT NOT NULL,
    UNIQUE(assessment_id, control_id)
  );

  CREATE TABLE IF NOT EXISTS assurance_domain_assessments (
    domain_assessment_id TEXT PRIMARY KEY,
    assessment_id TEXT NOT NULL REFERENCES assurance_assessments(assessment_id),
    domain_id TEXT NOT NULL,
    status TEXT NOT NULL,
    normalized_score REAL NOT NULL,
    domain_json TEXT NOT NULL,
    UNIQUE(assessment_id, domain_id)
  );

  CREATE TABLE IF NOT EXISTS assurance_scores (
    assessment_id TEXT PRIMARY KEY REFERENCES assurance_assessments(assessment_id),
    normalized_score REAL NOT NULL,
    methodology_id TEXT NOT NULL,
    methodology_version TEXT NOT NULL,
    score_json TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS assurance_eligibility_results (
    assessment_id TEXT NOT NULL REFERENCES assurance_assessments(assessment_id),
    profile_id TEXT NOT NULL,
    eligible INTEGER NOT NULL,
    provisional INTEGER NOT NULL,
    result_json TEXT NOT NULL,
    PRIMARY KEY (assessment_id, profile_id)
  );

  CREATE TABLE IF NOT EXISTS assurance_findings (
    finding_id TEXT PRIMARY KEY,
    assessment_id TEXT NOT NULL REFERENCES assurance_assessments(assessment_id),
    organization_id TEXT NOT NULL,
    control_id TEXT NOT NULL,
    domain_id TEXT NOT NULL,
    severity TEXT NOT NULL,
    finding_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_assurance_findings_assessment ON assurance_findings(assessment_id);

  CREATE TABLE IF NOT EXISTS assurance_finding_events (
    finding_event_id TEXT PRIMARY KEY,
    finding_id TEXT NOT NULL REFERENCES assurance_findings(finding_id),
    assessment_id TEXT NOT NULL,
    organization_id TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    rationale TEXT,
    payload_json TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    event_digest TEXT NOT NULL,
    UNIQUE(finding_id, sequence)
  );

  CREATE TABLE IF NOT EXISTS assurance_manual_reviews (
    review_id TEXT PRIMARY KEY,
    assessment_id TEXT NOT NULL REFERENCES assurance_assessments(assessment_id),
    organization_id TEXT NOT NULL,
    control_id TEXT NOT NULL,
    reviewer_id TEXT NOT NULL,
    review_json TEXT NOT NULL,
    reviewed_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_assurance_reviews_assessment ON assurance_manual_reviews(assessment_id);

  CREATE TABLE IF NOT EXISTS assurance_signals (
    signal_id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    subject_id TEXT NOT NULL,
    subject_type TEXT NOT NULL,
    signal_type TEXT NOT NULL,
    severity TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    signal_json TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_assurance_signals_subject ON assurance_signals(organization_id, subject_id);
`;

/**
 * ASSURE-REL-01A: commercial release custody. Added at open time to an
 * existing database -- like the Governance Store's reference-integrity
 * columns, without changing the frozen schema identifier: an older runtime
 * opens the database and never reads this table; this runtime creates it on an
 * older database without touching any existing row. Each row carries its own
 * `custody_version`. The primary key on `report_id` makes a release unique per
 * report version; the triggers refuse any UPDATE or DELETE.
 */
const COMMERCIAL_RELEASE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS assurance_commercial_releases (
    report_id TEXT PRIMARY KEY,
    assessment_id TEXT NOT NULL REFERENCES assurance_assessments(assessment_id),
    organization_id TEXT NOT NULL,
    framework_id TEXT NOT NULL,
    framework_version TEXT NOT NULL,
    content_digest TEXT NOT NULL,
    release_digest TEXT NOT NULL,
    approved_by TEXT NOT NULL,
    approved_at TEXT NOT NULL,
    custody_version TEXT NOT NULL,
    record_json TEXT NOT NULL,
    record_digest TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_assurance_releases_assessment ON assurance_commercial_releases(assessment_id);
  CREATE TRIGGER IF NOT EXISTS assurance_commercial_releases_no_update BEFORE UPDATE ON assurance_commercial_releases
    BEGIN SELECT RAISE(ABORT, 'assurance_commercial_releases is append-only'); END;
  CREATE TRIGGER IF NOT EXISTS assurance_commercial_releases_no_delete BEFORE DELETE ON assurance_commercial_releases
    BEGIN SELECT RAISE(ABORT, 'assurance_commercial_releases is append-only'); END;
`;

interface CommercialReleaseRow {
  readonly report_id: string;
  readonly assessment_id: string;
  readonly organization_id: string;
  readonly content_digest: string;
  readonly release_digest: string;
  readonly approved_by: string;
  readonly record_json: string;
  readonly record_digest: string;
}

/** A stored release, checked against its own columns and digests: a row edited outside the store is reported, never returned as custody. */
function rowToCommercialRelease(row: CommercialReleaseRow): CommercialReleaseCustodyRecord {
  let record: CommercialReleaseCustodyRecord;
  try {
    record = JSON.parse(row.record_json) as CommercialReleaseCustodyRecord;
  } catch {
    throw new AssuranceError('ASSURANCE_INTEGRITY_FAILED', `The release custody record for '${row.report_id}' is corrupted.`, { reportId: row.report_id });
  }
  const consistent =
    record.reportId === row.report_id &&
    record.assessmentId === row.assessment_id &&
    record.organizationId === row.organization_id &&
    record.recordDigest === row.record_digest &&
    record.release?.releaseDigest === row.release_digest &&
    record.release?.contentDigest === row.content_digest &&
    record.release?.approvedBy === row.approved_by;
  if (!consistent || commercialReleaseCustodyViolations(record).length > 0) {
    throw new AssuranceError('ASSURANCE_INTEGRITY_FAILED', `The release custody record for '${row.report_id}' is corrupted.`, { reportId: row.report_id });
  }
  return record;
}

interface AssessmentRow {
  readonly assessment_id: string;
  readonly organization_id: string;
  readonly status: string;
  readonly superseded_by: string | null;
  readonly assessment_json: string;
}

function resolveBusyTimeoutMs(value: number | undefined): number {
  const timeout = value ?? DEFAULT_BUSY_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout <= 0) {
    throw new RangeError(`busyTimeoutMs must be a positive integer, received '${String(value)}'.`);
  }
  return timeout;
}

function isSqliteConstraintViolation(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code.startsWith('SQLITE_CONSTRAINT');
}

function resolveOnDisk(dbPath: string): string {
  const absPath = resolve(dbPath);
  const dir = dirname(absPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return absPath;
}

function rowToAssessment(row: AssessmentRow): AssuranceAssessment {
  const assessment = JSON.parse(row.assessment_json) as AssuranceAssessment;
  // The store-level lifecycle overlay (supersession) lives in columns, not in
  // the frozen JSON -- overlay it on read (mission section 40).
  if (row.status === 'superseded' && row.superseded_by !== null) {
    return { ...assessment, status: 'superseded', supersededByAssessmentId: row.superseded_by };
  }
  return assessment;
}

// ---------------------------------------------------------------------------
// ASSURE-REL-01A-R1: open without mutating what is refused.
//
// Everything that reads the file runs before anything that writes it: the
// journal-mode switch to WAL rewrites the file header, and every CREATE adds
// objects. A file the store refuses -- another schema version, an unreadable
// version ledger, objects of something that is not an Assurance Store, or a
// release-custody table that is not this one -- is closed exactly as it was
// found. A compatible file is then initialized in one transaction: the v1
// schema, the release-custody extension and the version row are kept
// together or not at all.
// ---------------------------------------------------------------------------

const COMMERCIAL_RELEASE_TABLE = 'assurance_commercial_releases';
/** `name:type:notnull:pk` of every column, in order, as COMMERCIAL_RELEASE_SCHEMA creates them. */
const COMMERCIAL_RELEASE_COLUMNS = [
  'report_id:TEXT:0:1',
  'assessment_id:TEXT:1:0',
  'organization_id:TEXT:1:0',
  'framework_id:TEXT:1:0',
  'framework_version:TEXT:1:0',
  'content_digest:TEXT:1:0',
  'release_digest:TEXT:1:0',
  'approved_by:TEXT:1:0',
  'approved_at:TEXT:1:0',
  'custody_version:TEXT:1:0',
  'record_json:TEXT:1:0',
  'record_digest:TEXT:1:0',
].join(',');
const COMMERCIAL_RELEASE_COMPANIONS: readonly { readonly type: string; readonly name: string }[] = [
  { type: 'index', name: 'idx_assurance_releases_assessment' },
  { type: 'trigger', name: 'assurance_commercial_releases_no_update' },
  { type: 'trigger', name: 'assurance_commercial_releases_no_delete' },
];

interface SchemaObject {
  readonly type: string;
  readonly name: string;
  readonly tbl_name: string;
}

/** What a file holds, learned by reading only. `fresh`: no object at all. */
type OpenedDatabaseState = { readonly fresh: true } | { readonly fresh: false; readonly versionRecorded: boolean };

/** Why the release-custody objects present in a file are not this runtime's, or `undefined`. Never repairs: an unexpected object is refused, not dropped. */
function commercialReleaseObjectsProblem(db: import('better-sqlite3').Database, objects: readonly SchemaObject[]): string | undefined {
  const table = objects.find((object) => object.name === COMMERCIAL_RELEASE_TABLE);
  const companions = COMMERCIAL_RELEASE_COMPANIONS.filter((companion) => objects.some((object) => object.name === companion.name));
  if (table === undefined) {
    return companions.length > 0 ? `objects of the release-custody extension exist without '${COMMERCIAL_RELEASE_TABLE}'` : undefined;
  }
  if (table.type !== 'table') return `'${COMMERCIAL_RELEASE_TABLE}' is not a table`;
  const columns = (db.prepare(`PRAGMA table_info(${COMMERCIAL_RELEASE_TABLE})`).all() as { name: string; type: string; notnull: number; pk: number }[])
    .map((column) => `${column.name}:${column.type}:${column.notnull}:${column.pk}`)
    .join(',');
  if (columns !== COMMERCIAL_RELEASE_COLUMNS) return `'${COMMERCIAL_RELEASE_TABLE}' has a structure this runtime does not recognize`;
  const missing = COMMERCIAL_RELEASE_COMPANIONS.filter((companion) => !objects.some((object) => object.name === companion.name && object.type === companion.type && object.tbl_name === COMMERCIAL_RELEASE_TABLE));
  if (missing.length > 0) return `'${COMMERCIAL_RELEASE_TABLE}' is only partially created (missing ${missing.map((companion) => companion.name).join(', ')})`;
  return undefined;
}

/** Reads the file and refuses it, unchanged, unless it is empty or a compatible Assurance Store. */
function preflightAssuranceDatabase(db: import('better-sqlite3').Database): OpenedDatabaseState {
  const refuse = (reason: string): never => {
    db.close();
    throw new AssuranceError('ASSURANCE_STORE_UNAVAILABLE', `${reason} Refusing to open the Assurance Store; nothing was changed.`);
  };
  let objects: SchemaObject[] = [];
  try {
    objects = db.prepare(`SELECT type, name, tbl_name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'`).all() as SchemaObject[];
  } catch {
    refuse('The Assurance Store file is not a readable SQLite database.');
  }
  if (objects.length === 0) return { fresh: true };
  if (!objects.some((object) => object.type === 'table' && object.name === 'assurance_store_versions')) {
    refuse('The database holds objects but no Assurance Store version ledger, so it is not an Assurance Store.');
  }
  let latest: { schema_version: unknown } | undefined;
  try {
    latest = db.prepare(`SELECT schema_version FROM assurance_store_versions ORDER BY id DESC LIMIT 1`).get() as { schema_version: unknown } | undefined;
  } catch {
    refuse('The Assurance Store version ledger is unreadable.');
  }
  if (latest !== undefined && latest.schema_version !== ASSURANCE_STORE_SCHEMA_VERSION) {
    refuse(`Assurance Store schema version '${String(latest.schema_version).slice(0, 80)}' is not supported by this runtime (expected '${ASSURANCE_STORE_SCHEMA_VERSION}').`);
  }
  let problem: string | undefined;
  try {
    problem = commercialReleaseObjectsProblem(db, objects);
  } catch {
    problem = 'the release-custody objects are unreadable';
  }
  if (problem !== undefined) refuse(`The Assurance Store's ${problem}.`);
  // A ledger without a row: an initialization interrupted before it recorded its version. It is completed below.
  return { fresh: false, versionRecorded: latest !== undefined };
}

/**
 * ASSURE-REL-01A-R1: the stores this factory created. Only these provide the
 * durable release custody a commercial release requires -- an object that
 * merely looks like one (`providerKind: 'sqlite'`, the same methods) is not in
 * this set and cannot be added to it from outside this module.
 */
const durableReleaseCustodyStores = new WeakSet<object>();

/**
 * Whether `store` is a SQLite Assurance Store created by this module, and so
 * keeps release custody in a database file that survives a restart. What it
 * cannot vouch for: the durability of the disk, or a database file written
 * around the store.
 */
export function providesDurableReleaseCustody(store: unknown): boolean {
  return typeof store === 'object' && store !== null && durableReleaseCustodyStores.has(store);
}

/**
 * SQLite-backed Assurance Store (mission sections 50-51): `better-sqlite3`
 * loaded lazily, hand-written SQL, explicit schema, transactions, prepared
 * statements, foreign keys, uniqueness constraints, indexes. No SQLite
 * implementation type escapes this factory.
 */
export async function createSqliteAssuranceStore(dbPath: string, options: CreateSqliteAssuranceStoreOptions = {}): Promise<AssuranceStore> {
  const { default: Database } = await import('better-sqlite3');

  const now = options.now ?? (() => new Date().toISOString());
  const path = dbPath === ':memory:' ? ':memory:' : resolveOnDisk(dbPath);
  const db = new Database(path);
  // Connection settings only: neither writes the file.
  db.pragma('foreign_keys = ON');
  db.pragma(`busy_timeout = ${resolveBusyTimeoutMs(options.busyTimeoutMs)}`);

  // ASSURE-REL-01A-R1: read first. A refused file is closed as it was found --
  // before the WAL switch (which rewrites the header) and before any CREATE.
  preflightAssuranceDatabase(db);

  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = FULL');

  // One transaction: the v1 schema, the release-custody extension and the
  // version row are kept together, or nothing is. The ledger is read again
  // under the write lock, so a concurrent first open records one version row.
  const initialize = db.transaction(() => {
    db.exec(SCHEMA_V1);
    db.exec(COMMERCIAL_RELEASE_SCHEMA);
    const latestVersion = db.prepare(`SELECT schema_version FROM assurance_store_versions ORDER BY id DESC LIMIT 1`).get() as { schema_version: unknown } | undefined;
    if (latestVersion === undefined) {
      db.prepare(`INSERT INTO assurance_store_versions (schema_version, migration_state, recorded_at) VALUES (?, 'current', ?)`).run(ASSURANCE_STORE_SCHEMA_VERSION, now());
    } else if (latestVersion.schema_version !== ASSURANCE_STORE_SCHEMA_VERSION) {
      throw new AssuranceError(
        'ASSURANCE_STORE_UNAVAILABLE',
        `Assurance Store schema version '${String(latestVersion.schema_version).slice(0, 80)}' is not supported by this runtime (expected '${ASSURANCE_STORE_SCHEMA_VERSION}'). Refusing to open the store; nothing was changed.`,
      );
    }
  });
  try {
    initialize.immediate();
  } catch (error) {
    db.close();
    if (error instanceof AssuranceError) throw error;
    // The driver's message may name paths or SQL; it never leaves the store.
    throw new AssuranceError('ASSURANCE_STORE_UNAVAILABLE', 'The Assurance Store could not be initialized; no part of the initialization was kept.');
  }

  const selectAssessment = db.prepare(`SELECT * FROM assurance_assessments WHERE assessment_id = ?`);
  const upsertAssessment = db.prepare(`INSERT INTO assurance_assessments
    (assessment_id, organization_id, subject_id, subject_type, framework_id, framework_version, status, normalized_score, created_at, completed_at, superseded_by, assessment_json)
    VALUES (@assessmentId, @organizationId, @subjectId, @subjectType, @frameworkId, @frameworkVersion, @status, @normalizedScore, @createdAt, @completedAt, NULL, @assessmentJson)
    ON CONFLICT(assessment_id) DO UPDATE SET status = @status, normalized_score = @normalizedScore, completed_at = @completedAt, assessment_json = @assessmentJson`);
  const insertFinding = db.prepare(`INSERT INTO assurance_findings (finding_id, assessment_id, organization_id, control_id, domain_id, severity, finding_json, created_at)
    VALUES (@findingId, @assessmentId, @organizationId, @controlId, @domainId, @severity, @findingJson, @createdAt)`);
  const selectFinding = db.prepare(`SELECT * FROM assurance_findings WHERE finding_id = ?`);
  const selectFindingEventById = db.prepare(`SELECT finding_event_id FROM assurance_finding_events WHERE finding_event_id = ?`);
  const selectFindingsByAssessment = db.prepare(`SELECT * FROM assurance_findings WHERE assessment_id = ? ORDER BY created_at ASC, finding_id ASC`);
  const insertFindingEvent = db.prepare(`INSERT INTO assurance_finding_events
    (finding_event_id, finding_id, assessment_id, organization_id, sequence, event_type, actor_id, rationale, payload_json, occurred_at, event_digest)
    VALUES (@findingEventId, @findingId, @assessmentId, @organizationId, @sequence, @eventType, @actorId, @rationale, @payloadJson, @occurredAt, @eventDigest)`);
  const selectFindingEvents = db.prepare(`SELECT * FROM assurance_finding_events WHERE finding_id = ? ORDER BY sequence ASC`);
  const insertManualReview = db.prepare(`INSERT INTO assurance_manual_reviews (review_id, assessment_id, organization_id, control_id, reviewer_id, review_json, reviewed_at)
    VALUES (@reviewId, @assessmentId, @organizationId, @controlId, @reviewerId, @reviewJson, @reviewedAt)`);
  const selectManualReviews = db.prepare(`SELECT review_json FROM assurance_manual_reviews WHERE assessment_id = ? ORDER BY reviewed_at ASC, review_id ASC`);
  const insertSignal = db.prepare(`INSERT INTO assurance_signals (signal_id, organization_id, subject_id, subject_type, signal_type, severity, occurred_at, observed_at, signal_json)
    VALUES (@signalId, @organizationId, @subjectId, @subjectType, @signalType, @severity, @occurredAt, @observedAt, @signalJson)`);

  const insertEvidenceReference = db.prepare(`INSERT OR IGNORE INTO assurance_evidence_references (evidence_reference_id, assessment_id, organization_id, evidence_type, external_id, verified, reference_json)
    VALUES (@evidenceReferenceId, @assessmentId, @organizationId, @evidenceType, @externalId, @verified, @referenceJson)`);
  const insertControlEvaluation = db.prepare(`INSERT OR IGNORE INTO assurance_control_evaluations (control_evaluation_id, assessment_id, control_id, domain_id, status, evaluation_json)
    VALUES (@controlEvaluationId, @assessmentId, @controlId, @domainId, @status, @evaluationJson)`);
  const insertDomainAssessment = db.prepare(`INSERT OR IGNORE INTO assurance_domain_assessments (domain_assessment_id, assessment_id, domain_id, status, normalized_score, domain_json)
    VALUES (@domainAssessmentId, @assessmentId, @domainId, @status, @normalizedScore, @domainJson)`);
  const insertScore = db.prepare(`INSERT OR IGNORE INTO assurance_scores (assessment_id, normalized_score, methodology_id, methodology_version, score_json)
    VALUES (@assessmentId, @normalizedScore, @methodologyId, @methodologyVersion, @scoreJson)`);
  const insertEligibility = db.prepare(`INSERT OR IGNORE INTO assurance_eligibility_results (assessment_id, profile_id, eligible, provisional, result_json)
    VALUES (@assessmentId, @profileId, @eligible, @provisional, @resultJson)`);

  const selectCommercialRelease = db.prepare(`SELECT * FROM assurance_commercial_releases WHERE report_id = ?`);
  const selectCommercialReleasesByAssessment = db.prepare(`SELECT * FROM assurance_commercial_releases WHERE assessment_id = ? ORDER BY approved_at ASC, report_id ASC`);
  const insertCommercialRelease = db.prepare(`INSERT INTO assurance_commercial_releases
    (report_id, assessment_id, organization_id, framework_id, framework_version, content_digest, release_digest, approved_by, approved_at, custody_version, record_json, record_digest)
    VALUES (@reportId, @assessmentId, @organizationId, @frameworkId, @frameworkVersion, @contentDigest, @releaseDigest, @approvedBy, @approvedAt, @custodyVersion, @recordJson, @recordDigest)`);

  let closed = false;

  function assertOpen(): void {
    if (closed) throw new AssuranceError('ASSURANCE_STORE_UNAVAILABLE', 'The Assurance Store has been closed.');
  }

  function loadAssessmentRow(assessmentId: string): AssessmentRow | undefined {
    return selectAssessment.get(assessmentId) as AssessmentRow | undefined;
  }

  function loadFindingEvents(findingId: string): AssuranceFindingEvent[] {
    const rows = selectFindingEvents.all(findingId) as {
      finding_event_id: string;
      finding_id: string;
      assessment_id: string;
      organization_id: string;
      sequence: number;
      event_type: string;
      actor_id: string;
      rationale: string | null;
      payload_json: string;
      occurred_at: string;
      event_digest: string;
    }[];
    return rows.map((row) => ({
      findingEventId: row.finding_event_id,
      findingId: row.finding_id,
      assessmentId: row.assessment_id,
      organizationId: row.organization_id,
      eventType: row.event_type as AssuranceFindingEventType,
      sequence: row.sequence,
      actorId: row.actor_id,
      ...(row.rationale !== null ? { rationale: row.rationale } : {}),
      payload: JSON.parse(row.payload_json) as Readonly<Record<string, unknown>>,
      occurredAt: row.occurred_at,
      eventDigest: row.event_digest,
    }));
  }

  function findingWithFoldedStatus(finding: AssuranceFinding): AssuranceFinding {
    const folded = foldFindingStatus(loadFindingEvents(finding.findingId));
    return folded === undefined ? finding : { ...finding, status: folded };
  }

  function requireVisibleAssessment(context: AssuranceAccessContext, assessmentId: string): AssuranceAssessment {
    const row = loadAssessmentRow(assessmentId);
    if (row === undefined || !canAccessAssuranceOrganization(context, row.organization_id)) {
      throw new AssuranceError('ASSURANCE_ASSESSMENT_NOT_FOUND', `No Assurance assessment for assessmentId '${assessmentId}' within this scope.`);
    }
    return rowToAssessment(row);
  }

  /** The assessment row and, at a terminal status, its findings and queryable projections. Runs inside the caller's transaction. */
  function writeAssessment(assessment: AssuranceAssessment): void {
    const existing = loadAssessmentRow(assessment.assessmentId);
    if (existing !== undefined) {
      if (existing.organization_id !== assessment.subject.organizationId) {
        throw new AssuranceError('ASSURANCE_ACCESS_SCOPE_VIOLATION', `Assessment '${assessment.assessmentId}' belongs to a different organization.`);
      }
      if ((ASSURANCE_TERMINAL_STATUSES as readonly string[]).includes(existing.status)) {
        throw new AssuranceError('ASSURANCE_ASSESSMENT_IMMUTABLE', `Assessment '${assessment.assessmentId}' is '${existing.status}' and immutable; changed evidence or framework versions require a new assessment.`);
      }
    }
    upsertAssessment.run({
      assessmentId: assessment.assessmentId,
      organizationId: assessment.subject.organizationId,
      subjectId: assessment.subject.subjectId,
      subjectType: assessment.subject.subjectType,
      frameworkId: assessment.frameworkId,
      frameworkVersion: assessment.frameworkVersion,
      status: assessment.status,
      normalizedScore: assessment.score.normalizedScore,
      createdAt: assessment.createdAt,
      completedAt: assessment.completedAt ?? null,
      assessmentJson: JSON.stringify(assessment),
    });
    if ((ASSURANCE_TERMINAL_STATUSES as readonly string[]).includes(assessment.status)) {
      // Findings rows persist only at the terminal save (re-evaluation
      // before completion replaces the working findings set; only the
      // final set gets an append-only lifecycle).
      for (const finding of assessment.findings) {
        const existingFinding = selectFinding.get(finding.findingId) as { finding_id: string } | undefined;
        if (existingFinding === undefined) {
          insertFinding.run({
            findingId: finding.findingId,
            assessmentId: finding.assessmentId,
            organizationId: assessment.subject.organizationId,
            controlId: finding.controlId,
            domainId: finding.domainId,
            severity: finding.severity,
            findingJson: JSON.stringify(finding),
            createdAt: finding.createdAt,
          });
        }
      }
      // Queryable projections, written exactly once at the terminal save.
      for (const reference of assessment.evidenceReferences) {
        insertEvidenceReference.run({
          evidenceReferenceId: reference.evidenceReferenceId,
          assessmentId: assessment.assessmentId,
          organizationId: reference.organizationId,
          evidenceType: reference.evidenceType,
          externalId: reference.externalId,
          verified: reference.verified ? 1 : 0,
          referenceJson: JSON.stringify(reference),
        });
      }
      for (const evaluation of assessment.controlEvaluations) {
        insertControlEvaluation.run({
          controlEvaluationId: evaluation.controlEvaluationId,
          assessmentId: assessment.assessmentId,
          controlId: evaluation.controlId,
          domainId: evaluation.domainId,
          status: evaluation.status,
          evaluationJson: JSON.stringify(evaluation),
        });
      }
      for (const domain of assessment.domainAssessments) {
        insertDomainAssessment.run({
          domainAssessmentId: domain.domainAssessmentId,
          assessmentId: assessment.assessmentId,
          domainId: domain.domainId,
          status: domain.status,
          normalizedScore: domain.normalizedScore,
          domainJson: JSON.stringify(domain),
        });
      }
      insertScore.run({
        assessmentId: assessment.assessmentId,
        normalizedScore: assessment.score.normalizedScore,
        methodologyId: assessment.score.methodologyId,
        methodologyVersion: assessment.score.methodologyVersion,
        scoreJson: JSON.stringify(assessment.score),
      });
      for (const eligibility of assessment.eligibility) {
        insertEligibility.run({
          assessmentId: assessment.assessmentId,
          profileId: eligibility.profileId,
          eligible: eligibility.eligible ? 1 : 0,
          provisional: eligibility.provisional ? 1 : 0,
          resultJson: JSON.stringify(eligibility),
        });
      }
    }
  }

  const store: AssuranceStore = {
    providerKind: 'sqlite',

    async saveFramework(context, framework) {
      assertOpen();
      if (!context.system) {
        throw new AssuranceError('ASSURANCE_ACCESS_SCOPE_VIOLATION', 'Only system callers may persist Assurance framework definitions.');
      }
      try {
        db.prepare(`INSERT INTO assurance_frameworks (framework_id, framework_version, status, definition_json, recorded_at) VALUES (?, ?, ?, ?, ?)`).run(
          framework.frameworkId,
          framework.frameworkVersion,
          framework.status,
          JSON.stringify(framework),
          now(),
        );
      } catch (error) {
        if (isSqliteConstraintViolation(error)) {
          throw new AssuranceError('ASSURANCE_FRAMEWORK_INVALID', `Framework '${framework.frameworkId}@${framework.frameworkVersion}' is already persisted; framework versions are immutable.`);
        }
        const message = error instanceof Error ? error.message : String(error);
        throw new AssuranceError('ASSURANCE_STORE_UNAVAILABLE', `The Assurance Store failed to persist the framework definition: ${message}`);
      }
    },

    async getFramework(_context, frameworkId, frameworkVersion) {
      assertOpen();
      const row = db.prepare(`SELECT definition_json FROM assurance_frameworks WHERE framework_id = ? AND framework_version = ?`).get(frameworkId, frameworkVersion) as
        | { definition_json: string }
        | undefined;
      return row === undefined ? null : (JSON.parse(row.definition_json) as AssuranceFramework);
    },

    async listFrameworks(_context) {
      assertOpen();
      const rows = db.prepare(`SELECT definition_json FROM assurance_frameworks ORDER BY framework_id ASC, framework_version ASC`).all() as { definition_json: string }[];
      return rows.map((row) => JSON.parse(row.definition_json) as AssuranceFramework);
    },

    async saveAssessment(context, assessment) {
      assertOpen();
      requireAccessToAssuranceOrganization(context, assessment.subject.organizationId);
      db.transaction(() => writeAssessment(assessment))();
    },

    async completeAssessment(context, commit) {
      assertOpen();
      const { assessment, findingEvents } = commit;
      requireAccessToAssuranceOrganization(context, assessment.subject.organizationId);
      assertCompletionCommit(commit);
      // ASSURE-SEC-01E: one IMMEDIATE transaction -- the write lock is taken
      // before the status is read, so two connections cannot both complete;
      // any failure, including at COMMIT, rolls the whole unit back.
      const runComplete = db.transaction(() => {
        const existing = loadAssessmentRow(assessment.assessmentId);
        if (existing === undefined || !canAccessAssuranceOrganization(context, existing.organization_id)) {
          throw new AssuranceError('ASSURANCE_ASSESSMENT_NOT_FOUND', `No Assurance assessment for assessmentId '${assessment.assessmentId}' within this scope.`);
        }
        let supersede = false;
        if (assessment.supersedesAssessmentId !== undefined) {
          const previous = loadAssessmentRow(assessment.supersedesAssessmentId);
          if (previous === undefined || previous.organization_id !== assessment.subject.organizationId) {
            throw new AssuranceError('ASSURANCE_ASSESSMENT_NOT_FOUND', `No Assurance assessment for assessmentId '${assessment.supersedesAssessmentId}' within this scope.`);
          }
          if (previous.status === 'completed') supersede = true;
          else if (previous.status !== 'superseded') {
            throw new AssuranceError('ASSURANCE_ASSESSMENT_IMMUTABLE', `Only a completed assessment can be superseded; '${assessment.supersedesAssessmentId}' is '${previous.status}'.`);
          }
        }
        writeAssessment(assessment);
        for (const event of findingEvents) {
          if (loadFindingEvents(event.findingId).length > 0) {
            throw new AssuranceError('ASSURANCE_INVALID_FINDING_TRANSITION', `Finding '${event.findingId}' already has a history; its opening event cannot be appended again.`);
          }
          if (selectFindingEventById.get(event.findingEventId) !== undefined) {
            throw new AssuranceError('ASSURANCE_INVALID_FINDING_TRANSITION', `Finding event id '${event.findingEventId}' already exists.`);
          }
          insertFindingEvent.run({
            findingEventId: event.findingEventId,
            findingId: event.findingId,
            assessmentId: event.assessmentId,
            organizationId: event.organizationId,
            sequence: event.sequence,
            eventType: event.eventType,
            actorId: event.actorId,
            rationale: event.rationale ?? null,
            payloadJson: JSON.stringify(event.payload),
            occurredAt: event.occurredAt,
            eventDigest: event.eventDigest,
          });
        }
        if (supersede) {
          db.prepare(`UPDATE assurance_assessments SET status = 'superseded', superseded_by = ? WHERE assessment_id = ? AND status = 'completed'`).run(assessment.assessmentId, assessment.supersedesAssessmentId);
        }
      });
      try {
        runComplete.immediate();
      } catch (error) {
        if (error instanceof AssuranceError) throw error;
        // The driver's message may name paths or SQL; it never leaves the store.
        throw new AssuranceError('ASSURANCE_STORE_UNAVAILABLE', `Assessment '${assessment.assessmentId}' could not be completed: the Assurance Store did not persist the completion. Nothing was recorded; the completion can be retried.`, {
          assessmentId: assessment.assessmentId,
          retryable: true,
        });
      }
    },

    async getAssessment(context, assessmentId) {
      assertOpen();
      requireAssuranceTenantScope(context);
      const row = loadAssessmentRow(assessmentId);
      if (row === undefined || !canAccessAssuranceOrganization(context, row.organization_id)) return null;
      return rowToAssessment(row);
    },

    async queryAssessments(context, query) {
      assertOpen();
      requireAssuranceTenantScope(context);
      const clauses: string[] = [];
      const parameters: (string | number)[] = [];
      if (!context.system) {
        clauses.push('organization_id = ?');
        parameters.push(context.organizationId ?? '');
      }
      if (query.subjectId !== undefined) {
        clauses.push('subject_id = ?');
        parameters.push(query.subjectId);
      }
      if (query.frameworkId !== undefined) {
        clauses.push('framework_id = ?');
        parameters.push(query.frameworkId);
      }
      if (query.frameworkVersion !== undefined) {
        clauses.push('framework_version = ?');
        parameters.push(query.frameworkVersion);
      }
      if (query.status !== undefined) {
        clauses.push('status = ?');
        parameters.push(query.status);
      }
      const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
      const total = (db.prepare(`SELECT COUNT(*) AS count FROM assurance_assessments ${where}`).get(...parameters) as { count: number }).count;
      const rows = db
        .prepare(`SELECT * FROM assurance_assessments ${where} ORDER BY created_at DESC, assessment_id DESC LIMIT ?`)
        .all(...parameters, query.limit ?? 50) as (AssessmentRow & {
        subject_id: string;
        subject_type: string;
        framework_id: string;
        framework_version: string;
        normalized_score: number;
        created_at: string;
        completed_at: string | null;
      })[];
      const summaries: AssuranceAssessmentSummary[] = rows.map((row) => ({
        assessmentId: row.assessment_id,
        subjectId: row.subject_id,
        subjectType: row.subject_type as AssuranceAssessmentSummary['subjectType'],
        organizationId: row.organization_id,
        frameworkId: row.framework_id,
        frameworkVersion: row.framework_version,
        status: row.status as AssuranceAssessmentSummary['status'],
        normalizedScore: row.normalized_score,
        createdAt: row.created_at,
        ...(row.completed_at !== null ? { completedAt: row.completed_at } : {}),
      }));
      return { assessments: summaries, total };
    },

    async markSuperseded(context, assessmentId, supersededByAssessmentId) {
      assertOpen();
      const assessment = requireVisibleAssessment(context, assessmentId);
      requireAccessToAssuranceOrganization(context, assessment.subject.organizationId);
      if (assessment.status !== 'completed') {
        throw new AssuranceError('ASSURANCE_ASSESSMENT_IMMUTABLE', `Only a completed assessment can be marked superseded; '${assessmentId}' is '${assessment.status}'.`);
      }
      db.prepare(`UPDATE assurance_assessments SET status = 'superseded', superseded_by = ? WHERE assessment_id = ?`).run(supersededByAssessmentId, assessmentId);
    },

    async appendFindingEvent(context, event) {
      assertOpen();
      requireAccessToAssuranceOrganization(context, event.organizationId);
      const runAppend = db.transaction(() => {
        const findingRow = selectFinding.get(event.findingId) as { finding_id: string; organization_id: string } | undefined;
        if (findingRow === undefined) {
          throw new AssuranceError('ASSURANCE_FINDING_NOT_FOUND', `No Assurance finding for findingId '${event.findingId}'.`);
        }
        if (findingRow.organization_id !== event.organizationId) {
          throw new AssuranceError('ASSURANCE_ACCESS_SCOPE_VIOLATION', `Finding event organization '${event.organizationId}' does not match finding '${event.findingId}'.`);
        }
        const events = loadFindingEvents(event.findingId);
        if (event.sequence !== events.length + 1) {
          throw new AssuranceError('ASSURANCE_INVALID_FINDING_TRANSITION', `Finding event sequence ${event.sequence} is not contiguous (expected ${events.length + 1}).`);
        }
        applyFindingTransition(foldFindingStatus(events), event.eventType);
        insertFindingEvent.run({
          findingEventId: event.findingEventId,
          findingId: event.findingId,
          assessmentId: event.assessmentId,
          organizationId: event.organizationId,
          sequence: event.sequence,
          eventType: event.eventType,
          actorId: event.actorId,
          rationale: event.rationale ?? null,
          payloadJson: JSON.stringify(event.payload),
          occurredAt: event.occurredAt,
          eventDigest: event.eventDigest,
        });
      });
      runAppend();
    },

    async listFindingEvents(context, findingId) {
      assertOpen();
      requireAssuranceTenantScope(context);
      return loadFindingEvents(findingId).filter((event) => canAccessAssuranceOrganization(context, event.organizationId));
    },

    async listFindings(context, assessmentId) {
      assertOpen();
      requireAssuranceTenantScope(context);
      const row = loadAssessmentRow(assessmentId);
      if (row === undefined || !canAccessAssuranceOrganization(context, row.organization_id)) return [];
      const rows = selectFindingsByAssessment.all(assessmentId) as { finding_json: string }[];
      return rows.map((findingRow) => findingWithFoldedStatus(JSON.parse(findingRow.finding_json) as AssuranceFinding));
    },

    async getFinding(context, findingId) {
      assertOpen();
      requireAssuranceTenantScope(context);
      const row = selectFinding.get(findingId) as { organization_id: string; finding_json: string } | undefined;
      if (row === undefined || !canAccessAssuranceOrganization(context, row.organization_id)) return null;
      return findingWithFoldedStatus(JSON.parse(row.finding_json) as AssuranceFinding);
    },

    async saveFinding(context, finding) {
      assertOpen();
      const assessment = requireVisibleAssessment(context, finding.assessmentId);
      requireAccessToAssuranceOrganization(context, assessment.subject.organizationId);
      try {
        insertFinding.run({
          findingId: finding.findingId,
          assessmentId: finding.assessmentId,
          organizationId: assessment.subject.organizationId,
          controlId: finding.controlId,
          domainId: finding.domainId,
          severity: finding.severity,
          findingJson: JSON.stringify(finding),
          createdAt: finding.createdAt,
        });
      } catch (error) {
        if (isSqliteConstraintViolation(error)) {
          throw new AssuranceError('ASSURANCE_VALIDATION_ERROR', `Finding '${finding.findingId}' already exists; finding history is append-only.`);
        }
        throw error;
      }
    },

    async appendManualReview(context, review) {
      assertOpen();
      const assessment = requireVisibleAssessment(context, review.assessmentId);
      requireAccessToAssuranceOrganization(context, assessment.subject.organizationId);
      try {
        insertManualReview.run({
          reviewId: review.reviewId,
          assessmentId: review.assessmentId,
          organizationId: assessment.subject.organizationId,
          controlId: review.controlId,
          reviewerId: review.reviewerId,
          reviewJson: JSON.stringify(review),
          reviewedAt: review.reviewedAt,
        });
      } catch (error) {
        if (isSqliteConstraintViolation(error)) {
          throw new AssuranceError('ASSURANCE_MANUAL_REVIEW_INVALID', `Manual review '${review.reviewId}' already exists; reviews are append-only.`);
        }
        throw error;
      }
    },

    async listManualReviews(context, assessmentId) {
      assertOpen();
      requireAssuranceTenantScope(context);
      const row = loadAssessmentRow(assessmentId);
      if (row === undefined || !canAccessAssuranceOrganization(context, row.organization_id)) return [];
      const rows = selectManualReviews.all(assessmentId) as { review_json: string }[];
      return rows.map((reviewRow) => JSON.parse(reviewRow.review_json) as AssuranceManualReviewRecord);
    },

    async appendSignal(context, signal) {
      assertOpen();
      requireAccessToAssuranceOrganization(context, signal.organizationId);
      try {
        insertSignal.run({
          signalId: signal.signalId,
          organizationId: signal.organizationId,
          subjectId: signal.subjectId,
          subjectType: signal.subjectType,
          signalType: signal.signalType,
          severity: signal.severity,
          occurredAt: signal.occurredAt,
          observedAt: signal.observedAt,
          signalJson: JSON.stringify(signal),
        });
      } catch (error) {
        if (isSqliteConstraintViolation(error)) {
          throw new AssuranceError('ASSURANCE_SIGNAL_INVALID', `Signal '${signal.signalId}' already exists; signals are append-only.`);
        }
        throw error;
      }
    },

    async listSignals(context, query) {
      assertOpen();
      requireAssuranceTenantScope(context);
      const clauses: string[] = [];
      const parameters: (string | number)[] = [];
      if (!context.system) {
        clauses.push('organization_id = ?');
        parameters.push(context.organizationId ?? '');
      }
      if (query.subjectId !== undefined) {
        clauses.push('subject_id = ?');
        parameters.push(query.subjectId);
      }
      if (query.signalType !== undefined) {
        clauses.push('signal_type = ?');
        parameters.push(query.signalType);
      }
      if (query.since !== undefined) {
        clauses.push('observed_at >= ?');
        parameters.push(query.since);
      }
      const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
      const rows = db.prepare(`SELECT signal_json FROM assurance_signals ${where} ORDER BY observed_at ASC, signal_id ASC LIMIT ?`).all(...parameters, query.limit ?? 200) as {
        signal_json: string;
      }[];
      return rows.map((row) => JSON.parse(row.signal_json) as AssuranceSignal);
    },

    async verifyAssessment(context, assessmentId) {
      assertOpen();
      const assessment = requireVisibleAssessment(context, assessmentId);
      const frameworkRow = db
        .prepare(`SELECT definition_json FROM assurance_frameworks WHERE framework_id = ? AND framework_version = ?`)
        .get(assessment.frameworkId, assessment.frameworkVersion) as { definition_json: string } | undefined;
      const framework = frameworkRow === undefined ? undefined : (JSON.parse(frameworkRow.definition_json) as AssuranceFramework);
      return verifyAssuranceAssessment({ assessment, ...(framework !== undefined ? { framework } : {}), now });
    },

    async commitCommercialRelease(context, record) {
      assertOpen();
      requireAccessToAssuranceOrganization(context, record.organizationId);
      const violations = commercialReleaseCustodyViolations(record);
      if (violations.length > 0) {
        throw new AssuranceError('ASSURANCE_VALIDATION_ERROR', `The commercial release record for '${record.reportId}' is not coherent and was not recorded.`, { violations });
      }
      // ASSURE-REL-01A: one IMMEDIATE transaction -- the write lock is taken
      // before anything is read, so two connections cannot both find no
      // release and both insert; the primary key is the backstop.
      const runCommit = db.transaction((): { outcome: 'committed' | 'existing'; record: CommercialReleaseCustodyRecord } => {
        const assessment = loadAssessmentRow(record.assessmentId);
        if (assessment === undefined || assessment.organization_id !== record.organizationId) {
          throw new AssuranceError('ASSURANCE_ASSESSMENT_NOT_FOUND', `No Assurance assessment for assessmentId '${record.assessmentId}' within this scope.`);
        }
        if (assessment.status !== 'completed') {
          throw new AssuranceError('ASSURANCE_ASSESSMENT_INCOMPLETE', `Only the report of a completed, current assessment can be released; '${record.assessmentId}' is '${assessment.status}'.`);
        }
        const existing = selectCommercialRelease.get(record.reportId) as CommercialReleaseRow | undefined;
        if (existing !== undefined) {
          if (existing.organization_id !== record.organizationId) {
            throw new AssuranceError('ASSURANCE_INTEGRITY_FAILED', `The release custody for '${record.reportId}' is inconsistent.`);
          }
          return { outcome: 'existing', record: rowToCommercialRelease(existing) };
        }
        insertCommercialRelease.run({
          reportId: record.reportId,
          assessmentId: record.assessmentId,
          organizationId: record.organizationId,
          frameworkId: record.manifest.frameworkId,
          frameworkVersion: record.manifest.frameworkVersion,
          contentDigest: record.release.contentDigest,
          releaseDigest: record.release.releaseDigest,
          approvedBy: record.release.approvedBy,
          approvedAt: record.release.approvedAt,
          custodyVersion: record.custodyVersion,
          recordJson: JSON.stringify(record),
          recordDigest: record.recordDigest,
        });
        return { outcome: 'committed', record };
      });
      try {
        return runCommit.immediate();
      } catch (error) {
        if (error instanceof AssuranceError) throw error;
        // The driver's message may name paths or SQL; it never leaves the store.
        throw new AssuranceError('ASSURANCE_STORE_UNAVAILABLE', `The release of '${record.reportId}' could not be recorded: the Assurance Store did not persist it. Nothing was released; the release can be retried.`, {
          reportId: record.reportId,
          retryable: true,
        });
      }
    },

    async getCommercialRelease(context, reportId) {
      assertOpen();
      requireAssuranceTenantScope(context);
      const row = selectCommercialRelease.get(reportId) as CommercialReleaseRow | undefined;
      if (row === undefined || !canAccessAssuranceOrganization(context, row.organization_id)) return null;
      return rowToCommercialRelease(row);
    },

    async listCommercialReleases(context, assessmentId) {
      assertOpen();
      requireAssuranceTenantScope(context);
      const rows = selectCommercialReleasesByAssessment.all(assessmentId) as CommercialReleaseRow[];
      return rows.filter((row) => canAccessAssuranceOrganization(context, row.organization_id)).map(rowToCommercialRelease);
    },

    async health() {
      let readable = false;
      let migrationState = 'unknown';
      try {
        const row = db.prepare(`SELECT schema_version, migration_state FROM assurance_store_versions ORDER BY id DESC LIMIT 1`).get() as
          | { schema_version: string; migration_state: string }
          | undefined;
        readable = true;
        migrationState = row?.migration_state ?? 'unknown';
      } catch {
        readable = false;
      }
      const writable = readable && !closed;
      return {
        status: closed || !readable || !writable ? 'unhealthy' : 'healthy',
        readable,
        writable,
        schemaVersion: ASSURANCE_STORE_SCHEMA_VERSION,
        migrationState,
        checkedAt: now(),
      };
    },

    async close() {
      if (!closed) {
        closed = true;
        db.close();
      }
    },
  };
  durableReleaseCustodyStores.add(store);
  return store;
}
