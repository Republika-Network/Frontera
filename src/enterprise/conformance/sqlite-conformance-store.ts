import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import Database from 'better-sqlite3';

import type {
  CredentialHead,
  CredentialRecord,
  CredentialState,
  EvaluationRecord,
  HumanDecisionRef,
  IntegrationVersionRecord,
  PlatformRecord,
  SignedChallenge,
  SignedHumanDecision,
  SignedTransition,
  ValidatorEnrollmentRecord,
  ValidatorOperatorRecord,
} from './contracts.js';
import { canonicalizeConformance } from './canonical.js';

/**
 * RN-CONFORM-02 / WP-08 — the dedicated conformance store.
 *
 * Separate from every Assurance table and file. Nothing here reads or writes
 * Assurance persistence.
 *
 * ## The P0 invariant and how it is enforced
 *
 * > A confirmed critical-failure evaluation cannot exist in committed storage
 * > while the affected credential remains ACTIVE.
 *
 * SQLite triggers are row-level and run immediately; there are no deferred
 * triggers, and foreign keys are a *per-connection* setting that is off by
 * default, so neither a deferred check nor a deferred foreign key would hold
 * against a second connection. The write path is therefore restructured so
 * that the evaluation and its mandatory protective transition are **one row
 * insert**:
 *
 * - `cc_evaluations` carries the pre-signed protective transition in its
 *   `pt_*` columns. A `BEFORE INSERT` trigger refuses an evaluation that
 *   confirms a critical failure (or otherwise requires suspension) against an
 *   ACTIVE head unless those columns are present, name reason
 *   `CRITICAL_VIOLATION_CONFIRMED`, and target exactly the next state
 *   version.
 * - An `AFTER INSERT` trigger on `cc_evaluations` inserts that transition into
 *   `cc_transitions`; the transition's own `BEFORE INSERT` checks the chain;
 *   its `AFTER INSERT` advances `cc_heads`. If any step raises, SQLite aborts
 *   the whole statement — no evaluation, no transition, no head change.
 * - `cc_transitions` refuses an `ACTIVE → SUSPENDED` row that did not come
 *   from such an evaluation, and `cc_heads` refuses every write that does not
 *   equal the latest transition. So there is no ordering of statements, on
 *   any connection, that commits a critical failure next to an ACTIVE head.
 *
 * Every evaluation must also be computed against the **current** head
 * (`credential_state_version` = head version), which is the compare-and-swap:
 * an evaluation computed before a concurrent transition is refused and must
 * be recomputed.
 *
 * ## What this does not defend against
 *
 * Triggers stop unintended application-level mutation and enforce the local
 * data invariants. They do not stop a database administrator who drops them
 * or replaces the file. The store refuses to open a file whose trigger set is
 * not exactly this schema's, and the history verifier recomputes every digest
 * and signature, so such tampering is detected — not prevented.
 */

export const CONFORMANCE_STORE_SCHEMA_VERSION = 'rn.conformance.store/1';

const TWO_HUMANS = (action: string, consumedFor: string, binding: string, subject: string) => `(
  (SELECT COUNT(DISTINCT d.principal_id) FROM cc_consumed_decisions d WHERE d.consumed_for = ${consumedFor} AND d.action = '${action}' AND d.action_binding_digest IS ${binding} AND d.subject_ref = ${subject}) >= 2
  AND (SELECT COUNT(DISTINCT d.role) FROM cc_consumed_decisions d WHERE d.consumed_for = ${consumedFor} AND d.action = '${action}' AND d.action_binding_digest IS ${binding} AND d.subject_ref = ${subject}) = 2
)`;

const PREV = (column: string) => `(SELECT p.${column} FROM cc_transitions p WHERE p.credential_id = NEW.credential_id AND p.state_version = NEW.state_version - 1)`;
const HEAD = (column: string) => `(SELECT h.${column} FROM cc_heads h WHERE h.credential_id = NEW.credential_id)`;

const SCHEMA = `
CREATE TABLE cc_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  schema_version TEXT NOT NULL,
  synthetic INTEGER NOT NULL CHECK (synthetic = 1)
);
CREATE TABLE cc_profiles (
  profile_id TEXT NOT NULL,
  profile_version TEXT NOT NULL,
  profile_digest TEXT NOT NULL,
  definition_json TEXT NOT NULL,
  PRIMARY KEY (profile_id, profile_version)
);
CREATE TABLE cc_platforms (
  platform_id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  record_digest TEXT NOT NULL,
  record_json TEXT NOT NULL,
  synthetic INTEGER NOT NULL CHECK (synthetic = 1)
);
CREATE TABLE cc_integrations (
  integration_id TEXT NOT NULL,
  integration_version INTEGER NOT NULL CHECK (integration_version >= 1),
  organization_id TEXT NOT NULL,
  platform_id TEXT NOT NULL REFERENCES cc_platforms (platform_id),
  profile_id TEXT NOT NULL,
  profile_version TEXT NOT NULL,
  integration_digest TEXT NOT NULL UNIQUE,
  record_json TEXT NOT NULL,
  synthetic INTEGER NOT NULL CHECK (synthetic = 1),
  PRIMARY KEY (integration_id, integration_version)
);
CREATE TABLE cc_operators (
  operator_id TEXT PRIMARY KEY,
  record_json TEXT NOT NULL,
  synthetic INTEGER NOT NULL CHECK (synthetic = 1)
);
CREATE TABLE cc_consumed_decisions (
  decision_id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('attest', 'approve')),
  action TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  subject_ref TEXT NOT NULL,
  action_binding_digest TEXT NOT NULL,
  decision_digest TEXT NOT NULL,
  decision_json TEXT NOT NULL,
  consumed_for TEXT NOT NULL,
  consumed_at TEXT NOT NULL
);
CREATE TABLE cc_validators (
  validator_id TEXT PRIMARY KEY,
  operator_id TEXT NOT NULL REFERENCES cc_operators (operator_id),
  key_id TEXT NOT NULL UNIQUE,
  public_key_pem TEXT NOT NULL,
  key_valid_from_ms INTEGER NOT NULL,
  key_valid_until_ms INTEGER NOT NULL,
  binding_digest TEXT NOT NULL,
  record_json TEXT NOT NULL,
  decisions_json TEXT NOT NULL,
  enrolled_at TEXT NOT NULL,
  synthetic INTEGER NOT NULL CHECK (synthetic = 1)
);
CREATE TABLE cc_validator_events (
  validator_id TEXT NOT NULL REFERENCES cc_validators (validator_id),
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('KEY_REVOKED', 'QUARANTINED')),
  at_ms INTEGER NOT NULL,
  reason TEXT NOT NULL,
  PRIMARY KEY (validator_id, seq)
);
CREATE TABLE cc_challenges (
  challenge_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  nonce TEXT NOT NULL UNIQUE,
  organization_id TEXT NOT NULL,
  integration_digest TEXT NOT NULL REFERENCES cc_integrations (integration_digest),
  profile_id TEXT NOT NULL,
  profile_version TEXT NOT NULL,
  control_id TEXT NOT NULL,
  issued_at_ms INTEGER NOT NULL,
  deadline_ms INTEGER NOT NULL,
  challenge_json TEXT NOT NULL,
  signature_json TEXT NOT NULL
);
CREATE TABLE cc_evidence_packages (
  evidence_digest TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  package_json TEXT NOT NULL,
  stored_at TEXT NOT NULL
);
CREATE TABLE cc_observations (
  event_id TEXT PRIMARY KEY,
  challenge_id TEXT NOT NULL REFERENCES cc_challenges (challenge_id),
  validator_id TEXT NOT NULL REFERENCES cc_validators (validator_id),
  operator_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  integration_digest TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  profile_version TEXT NOT NULL,
  control_id TEXT NOT NULL,
  evidence_digest TEXT NOT NULL,
  outcome_class TEXT NOT NULL CHECK (outcome_class IN ('conformant', 'violation', 'inconclusive')),
  claim_matches INTEGER NOT NULL CHECK (claim_matches IN (0, 1)),
  observed_at TEXT NOT NULL,
  accepted_at TEXT NOT NULL,
  observation_digest TEXT NOT NULL,
  submission_json TEXT NOT NULL,
  UNIQUE (challenge_id, validator_id)
);
CREATE TABLE cc_rejections (
  rejection_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  received_at TEXT NOT NULL,
  reason TEXT NOT NULL,
  submission_digest TEXT NOT NULL,
  event_id TEXT,
  validator_id TEXT,
  challenge_id TEXT,
  conflicts_with_event_id TEXT
);
CREATE TABLE cc_credentials (
  credential_id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  integration_digest TEXT NOT NULL REFERENCES cc_integrations (integration_digest),
  profile_id TEXT NOT NULL,
  profile_version TEXT NOT NULL,
  profile_digest TEXT NOT NULL,
  candidate_until_ms INTEGER NOT NULL,
  valid_until_ms INTEGER NOT NULL,
  suspension_revocation_ms INTEGER NOT NULL,
  record_json TEXT NOT NULL,
  synthetic INTEGER NOT NULL CHECK (synthetic = 1),
  UNIQUE (integration_digest, profile_id, profile_version)
);
CREATE TABLE cc_evaluations (
  evaluation_id TEXT PRIMARY KEY,
  credential_id TEXT NOT NULL REFERENCES cc_credentials (credential_id),
  evaluated_at_ms INTEGER NOT NULL,
  credential_state_version INTEGER NOT NULL,
  critical_failure INTEGER NOT NULL CHECK (critical_failure IN (0, 1)),
  requires_suspension INTEGER NOT NULL CHECK (requires_suspension IN (0, 1)),
  eligible_for_active INTEGER NOT NULL CHECK (eligible_for_active IN (0, 1)),
  evaluation_digest TEXT NOT NULL UNIQUE,
  record_json TEXT NOT NULL,
  pt_transition_id TEXT,
  pt_reason_code TEXT,
  pt_rule_id TEXT,
  pt_previous_digest TEXT,
  pt_transition_digest TEXT,
  pt_effective_at_ms INTEGER,
  pt_record_json TEXT,
  pt_signature_json TEXT,
  CHECK ((pt_transition_id IS NULL) = (pt_transition_digest IS NULL)),
  CHECK (pt_transition_id IS NULL OR (pt_reason_code IS NOT NULL AND pt_rule_id IS NOT NULL AND pt_previous_digest IS NOT NULL AND pt_effective_at_ms IS NOT NULL AND pt_record_json IS NOT NULL AND pt_signature_json IS NOT NULL))
);
CREATE TABLE cc_transitions (
  credential_id TEXT NOT NULL REFERENCES cc_credentials (credential_id),
  state_version INTEGER NOT NULL,
  transition_id TEXT NOT NULL UNIQUE,
  from_state TEXT,
  to_state TEXT NOT NULL CHECK (to_state IN ('CANDIDATE', 'ACTIVE', 'SUSPENDED', 'REVOKED', 'EXPIRED')),
  transition_code TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  rule_id TEXT NOT NULL,
  evaluation_id TEXT,
  previous_transition_digest TEXT,
  transition_digest TEXT NOT NULL UNIQUE,
  action_binding_digest TEXT,
  effective_at_ms INTEGER NOT NULL,
  record_json TEXT NOT NULL,
  signature_json TEXT NOT NULL,
  PRIMARY KEY (credential_id, state_version)
);
CREATE TABLE cc_heads (
  credential_id TEXT PRIMARY KEY REFERENCES cc_credentials (credential_id),
  state TEXT NOT NULL,
  state_version INTEGER NOT NULL,
  head_transition_digest TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  effective_at_ms INTEGER NOT NULL
);

-- Immutable records: never updated, never deleted.
${['cc_meta', 'cc_profiles', 'cc_platforms', 'cc_integrations', 'cc_operators', 'cc_consumed_decisions', 'cc_validators', 'cc_validator_events', 'cc_challenges', 'cc_evidence_packages', 'cc_observations', 'cc_rejections', 'cc_credentials', 'cc_evaluations', 'cc_transitions']
  .map(
    (table) => `CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT, 'cc:immutable ${table}'); END;
CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT, 'cc:immutable ${table}'); END;`,
  )
  .join('\n')}
CREATE TRIGGER cc_heads_no_delete BEFORE DELETE ON cc_heads BEGIN SELECT RAISE(ABORT, 'cc:immutable cc_heads'); END;

-- Tenancy and identity of registrations.
CREATE TRIGGER cc_integrations_bound BEFORE INSERT ON cc_integrations BEGIN
  SELECT RAISE(ABORT, 'cc:cross-tenant platform') WHERE NOT EXISTS (SELECT 1 FROM cc_platforms p WHERE p.platform_id = NEW.platform_id AND p.organization_id = NEW.organization_id);
  SELECT RAISE(ABORT, 'cc:unknown profile') WHERE NOT EXISTS (SELECT 1 FROM cc_profiles p WHERE p.profile_id = NEW.profile_id AND p.profile_version = NEW.profile_version);
  SELECT RAISE(ABORT, 'cc:integration version gap') WHERE NEW.integration_version <> COALESCE((SELECT MAX(i.integration_version) FROM cc_integrations i WHERE i.integration_id = NEW.integration_id), 0) + 1;
  SELECT RAISE(ABORT, 'cc:integration identity changed') WHERE EXISTS (SELECT 1 FROM cc_integrations i WHERE i.integration_id = NEW.integration_id AND (i.platform_id <> NEW.platform_id OR i.organization_id <> NEW.organization_id));
END;
CREATE TRIGGER cc_validators_enrolled BEFORE INSERT ON cc_validators BEGIN
  SELECT RAISE(ABORT, 'cc:unknown operator') WHERE NOT EXISTS (SELECT 1 FROM cc_operators o WHERE o.operator_id = NEW.operator_id AND o.synthetic = 1);
  SELECT RAISE(ABORT, 'cc:enrollment requires two humans') WHERE NOT ${TWO_HUMANS('validator.enroll', "'validator:' || NEW.validator_id", 'NEW.binding_digest', 'NEW.validator_id')};
END;
CREATE TRIGGER cc_observations_attributed BEFORE INSERT ON cc_observations BEGIN
  SELECT RAISE(ABORT, 'cc:observation operator mismatch') WHERE NOT EXISTS (SELECT 1 FROM cc_validators v WHERE v.validator_id = NEW.validator_id AND v.operator_id = NEW.operator_id);
  SELECT RAISE(ABORT, 'cc:observation challenge mismatch') WHERE NOT EXISTS (SELECT 1 FROM cc_challenges c WHERE c.challenge_id = NEW.challenge_id AND c.organization_id = NEW.organization_id AND c.integration_digest = NEW.integration_digest AND c.control_id = NEW.control_id AND c.profile_id = NEW.profile_id AND c.profile_version = NEW.profile_version);
  SELECT RAISE(ABORT, 'cc:observation evidence missing') WHERE NOT EXISTS (SELECT 1 FROM cc_evidence_packages e WHERE e.evidence_digest = NEW.evidence_digest AND e.organization_id = NEW.organization_id);
END;
CREATE TRIGGER cc_credentials_bound BEFORE INSERT ON cc_credentials BEGIN
  SELECT RAISE(ABORT, 'cc:credential integration mismatch') WHERE NOT EXISTS (SELECT 1 FROM cc_integrations i WHERE i.integration_digest = NEW.integration_digest AND i.organization_id = NEW.organization_id AND i.profile_id = NEW.profile_id AND i.profile_version = NEW.profile_version);
  SELECT RAISE(ABORT, 'cc:credential profile digest mismatch') WHERE NOT EXISTS (SELECT 1 FROM cc_profiles p WHERE p.profile_id = NEW.profile_id AND p.profile_version = NEW.profile_version AND p.profile_digest = NEW.profile_digest);
END;

-- Evaluations: the atomicity invariant.
CREATE TRIGGER cc_evaluations_guard BEFORE INSERT ON cc_evaluations BEGIN
  SELECT RAISE(ABORT, 'cc:unknown credential') WHERE NOT EXISTS (SELECT 1 FROM cc_heads h WHERE h.credential_id = NEW.credential_id);
  SELECT RAISE(ABORT, 'cc:stale head') WHERE NEW.credential_state_version IS NOT ${HEAD('state_version')};
  SELECT RAISE(ABORT, 'cc:evaluation json mismatch') WHERE json_extract(NEW.record_json, '$.evaluationId') IS NOT NEW.evaluation_id
    OR json_extract(NEW.record_json, '$.credentialId') IS NOT NEW.credential_id
    OR json_extract(NEW.record_json, '$.credentialStateVersion') IS NOT NEW.credential_state_version
    OR json_extract(NEW.record_json, '$.criticalFailureConfirmed') IS NOT NEW.critical_failure
    OR (json_extract(NEW.record_json, '$.proposal.kind') = 'SUSPEND') IS NOT NEW.requires_suspension
    OR (json_extract(NEW.record_json, '$.proposal.kind') = 'ELIGIBLE_FOR_ACTIVE') IS NOT NEW.eligible_for_active
    OR json_extract(NEW.record_json, '$.synthetic') IS NOT 1;
  SELECT RAISE(ABORT, 'cc:critical failure without suspension') WHERE ${HEAD('state')} = 'ACTIVE' AND (NEW.critical_failure = 1 OR NEW.requires_suspension = 1) AND NEW.pt_transition_id IS NULL;
  SELECT RAISE(ABORT, 'cc:critical failure wrong reason') WHERE ${HEAD('state')} = 'ACTIVE' AND NEW.critical_failure = 1 AND NEW.pt_reason_code IS NOT 'CRITICAL_VIOLATION_CONFIRMED';
  SELECT RAISE(ABORT, 'cc:suspension proposed for non-active credential') WHERE NEW.requires_suspension = 1 AND ${HEAD('state')} <> 'ACTIVE';
  SELECT RAISE(ABORT, 'cc:protective transition not applicable') WHERE NEW.pt_transition_id IS NOT NULL AND (NEW.requires_suspension <> 1 OR ${HEAD('state')} <> 'ACTIVE');
  SELECT RAISE(ABORT, 'cc:eligibility with failure') WHERE NEW.eligible_for_active = 1 AND (NEW.critical_failure = 1 OR NEW.requires_suspension = 1);
END;
CREATE TRIGGER cc_evaluations_protective_transition AFTER INSERT ON cc_evaluations WHEN NEW.pt_transition_id IS NOT NULL BEGIN
  INSERT INTO cc_transitions (credential_id, state_version, transition_id, from_state, to_state, transition_code, reason_code, rule_id, evaluation_id, previous_transition_digest, transition_digest, action_binding_digest, effective_at_ms, record_json, signature_json)
  VALUES (NEW.credential_id, NEW.credential_state_version + 1, NEW.pt_transition_id, 'ACTIVE', 'SUSPENDED', 'T4', NEW.pt_reason_code, NEW.pt_rule_id, NEW.evaluation_id, NEW.pt_previous_digest, NEW.pt_transition_digest, NULL, NEW.pt_effective_at_ms, NEW.pt_record_json, NEW.pt_signature_json);
END;

-- Transitions: append-only, contiguous, hash-linked, and only along the lifecycle's edges.
CREATE TRIGGER cc_transitions_guard BEFORE INSERT ON cc_transitions BEGIN
  SELECT RAISE(ABORT, 'cc:unknown credential') WHERE NOT EXISTS (SELECT 1 FROM cc_credentials c WHERE c.credential_id = NEW.credential_id);
  SELECT RAISE(ABORT, 'cc:transition json mismatch') WHERE json_extract(NEW.record_json, '$.stateVersion') IS NOT NEW.state_version
    OR json_extract(NEW.record_json, '$.credentialId') IS NOT NEW.credential_id
    OR json_extract(NEW.record_json, '$.transitionId') IS NOT NEW.transition_id
    OR json_extract(NEW.record_json, '$.from') IS NOT NEW.from_state
    OR json_extract(NEW.record_json, '$.to') IS NOT NEW.to_state
    OR json_extract(NEW.record_json, '$.transitionCode') IS NOT NEW.transition_code
    OR json_extract(NEW.record_json, '$.reasonCode') IS NOT NEW.reason_code
    OR json_extract(NEW.record_json, '$.ruleId') IS NOT NEW.rule_id
    OR json_extract(NEW.record_json, '$.evaluationId') IS NOT NEW.evaluation_id
    OR json_extract(NEW.record_json, '$.previousTransitionDigest') IS NOT NEW.previous_transition_digest
    OR json_extract(NEW.record_json, '$.actionBindingDigest') IS NOT NEW.action_binding_digest
    OR json_extract(NEW.record_json, '$.synthetic') IS NOT 1;
  SELECT RAISE(ABORT, 'cc:genesis') WHERE NEW.state_version = 1 AND (NEW.from_state IS NOT NULL OR NEW.to_state <> 'CANDIDATE' OR NEW.transition_code <> 'T1' OR NEW.previous_transition_digest IS NOT NULL);
  SELECT RAISE(ABORT, 'cc:stale head') WHERE EXISTS (SELECT 1 FROM cc_transitions p WHERE p.credential_id = NEW.credential_id AND p.state_version >= NEW.state_version);
  SELECT RAISE(ABORT, 'cc:state version gap') WHERE NEW.state_version < 1 OR (NEW.state_version > 1 AND NOT EXISTS (SELECT 1 FROM cc_transitions p WHERE p.credential_id = NEW.credential_id AND p.state_version = NEW.state_version - 1));
  SELECT RAISE(ABORT, 'cc:chain mismatch') WHERE NEW.state_version > 1 AND (${PREV('transition_digest')} IS NOT NEW.previous_transition_digest OR ${PREV('to_state')} IS NOT NEW.from_state OR ${PREV('effective_at_ms')} > NEW.effective_at_ms);
  SELECT RAISE(ABORT, 'cc:transition not allowed') WHERE NEW.state_version > 1 AND NOT (
       (NEW.from_state = 'CANDIDATE' AND NEW.to_state = 'ACTIVE' AND NEW.transition_code = 'T2')
    OR (NEW.from_state = 'CANDIDATE' AND NEW.to_state = 'EXPIRED' AND NEW.transition_code = 'T3')
    OR (NEW.from_state = 'ACTIVE' AND NEW.to_state = 'SUSPENDED' AND NEW.transition_code = 'T4')
    OR (NEW.from_state = 'SUSPENDED' AND NEW.to_state = 'ACTIVE' AND NEW.transition_code = 'T5')
    OR (NEW.from_state = 'SUSPENDED' AND NEW.to_state = 'REVOKED' AND NEW.transition_code = 'T6')
    OR (NEW.from_state = 'ACTIVE' AND NEW.to_state = 'REVOKED' AND NEW.transition_code = 'T7')
    OR (NEW.from_state IN ('ACTIVE', 'SUSPENDED') AND NEW.to_state = 'EXPIRED' AND NEW.transition_code = 'T8'));
  SELECT RAISE(ABORT, 'cc:suspension without evaluation') WHERE NEW.to_state = 'SUSPENDED' AND NOT EXISTS (SELECT 1 FROM cc_evaluations e WHERE e.evaluation_id = NEW.evaluation_id AND e.credential_id = NEW.credential_id AND e.requires_suspension = 1 AND e.pt_transition_id IS NEW.transition_id);
  SELECT RAISE(ABORT, 'cc:activation without eligible evaluation') WHERE NEW.to_state = 'ACTIVE' AND NOT EXISTS (SELECT 1 FROM cc_evaluations e WHERE e.evaluation_id = NEW.evaluation_id AND e.credential_id = NEW.credential_id AND e.eligible_for_active = 1 AND e.credential_state_version = NEW.state_version - 1 AND e.evaluated_at_ms <= NEW.effective_at_ms);
  SELECT RAISE(ABORT, 'cc:activation against standing failure') WHERE NEW.to_state = 'ACTIVE' AND EXISTS (SELECT 1 FROM cc_evaluations f, cc_evaluations e WHERE e.evaluation_id = NEW.evaluation_id AND f.credential_id = NEW.credential_id AND f.critical_failure = 1 AND f.evaluation_id <> e.evaluation_id AND f.evaluated_at_ms >= e.evaluated_at_ms);
  SELECT RAISE(ABORT, 'cc:activation after credential term') WHERE NEW.to_state = 'ACTIVE' AND NEW.effective_at_ms >= (SELECT c.valid_until_ms FROM cc_credentials c WHERE c.credential_id = NEW.credential_id);
  SELECT RAISE(ABORT, 'cc:issuance requires two humans') WHERE NEW.transition_code = 'T2' AND NOT ${TWO_HUMANS('credential.issue', 'NEW.transition_id', 'NEW.action_binding_digest', 'NEW.credential_id')};
  SELECT RAISE(ABORT, 'cc:reinstatement requires two humans') WHERE NEW.transition_code = 'T5' AND ${PREV('reason_code')} IN ('CRITICAL_VIOLATION_CONFIRMED', 'CONFLICTING_EVIDENCE') AND NOT ${TWO_HUMANS('credential.reinstate', 'NEW.transition_id', 'NEW.action_binding_digest', 'NEW.credential_id')};
  SELECT RAISE(ABORT, 'cc:revocation requires two humans or the suspension timeout') WHERE NEW.to_state = 'REVOKED' AND NOT (
       (NEW.reason_code = 'SUSPENSION_TIMEOUT' AND NEW.from_state = 'SUSPENDED' AND NEW.action_binding_digest IS NULL
         AND NEW.effective_at_ms >= ${PREV('effective_at_ms')} + (SELECT c.suspension_revocation_ms FROM cc_credentials c WHERE c.credential_id = NEW.credential_id))
    OR (NEW.reason_code <> 'SUSPENSION_TIMEOUT' AND ${TWO_HUMANS('credential.revoke', 'NEW.transition_id', 'NEW.action_binding_digest', 'NEW.credential_id')}));
  SELECT RAISE(ABORT, 'cc:expiry before term') WHERE NEW.to_state = 'EXPIRED' AND (
       (NEW.transition_code = 'T3' AND NEW.effective_at_ms < (SELECT c.candidate_until_ms FROM cc_credentials c WHERE c.credential_id = NEW.credential_id))
    OR (NEW.transition_code = 'T8' AND NEW.effective_at_ms < (SELECT c.valid_until_ms FROM cc_credentials c WHERE c.credential_id = NEW.credential_id)));
END;
CREATE TRIGGER cc_transitions_advance_head AFTER INSERT ON cc_transitions BEGIN
  INSERT INTO cc_heads (credential_id, state, state_version, head_transition_digest, reason_code, effective_at_ms)
    SELECT NEW.credential_id, NEW.to_state, NEW.state_version, NEW.transition_digest, NEW.reason_code, NEW.effective_at_ms WHERE NEW.state_version = 1;
  UPDATE cc_heads SET state = NEW.to_state, state_version = NEW.state_version, head_transition_digest = NEW.transition_digest, reason_code = NEW.reason_code, effective_at_ms = NEW.effective_at_ms
    WHERE credential_id = NEW.credential_id AND NEW.state_version > 1;
END;

-- The head is a projection of the latest committed transition and nothing else.
CREATE TRIGGER cc_heads_insert_guard BEFORE INSERT ON cc_heads BEGIN
  SELECT RAISE(ABORT, 'cc:head must equal the latest transition') WHERE NEW.state_version <> 1 OR NOT EXISTS (SELECT 1 FROM cc_transitions t WHERE t.credential_id = NEW.credential_id AND t.state_version = 1
    AND t.to_state = NEW.state AND t.transition_digest = NEW.head_transition_digest AND t.reason_code = NEW.reason_code AND t.effective_at_ms = NEW.effective_at_ms);
END;
CREATE TRIGGER cc_heads_update_guard BEFORE UPDATE ON cc_heads BEGIN
  SELECT RAISE(ABORT, 'cc:head must equal the latest transition') WHERE NEW.credential_id <> OLD.credential_id OR NEW.state_version <> OLD.state_version + 1
    OR NOT EXISTS (SELECT 1 FROM cc_transitions t WHERE t.credential_id = NEW.credential_id AND t.state_version = NEW.state_version
      AND t.to_state = NEW.state AND t.transition_digest = NEW.head_transition_digest AND t.reason_code = NEW.reason_code AND t.effective_at_ms = NEW.effective_at_ms);
END;
`;

const TABLES = Object.freeze([
  'cc_meta', 'cc_profiles', 'cc_platforms', 'cc_integrations', 'cc_operators', 'cc_consumed_decisions', 'cc_validators', 'cc_validator_events',
  'cc_challenges', 'cc_evidence_packages', 'cc_observations', 'cc_rejections', 'cc_credentials', 'cc_evaluations', 'cc_transitions', 'cc_heads',
]);

export type ConformanceStoreErrorCode = 'CAS_CONFLICT' | 'INVARIANT_REFUSED' | 'CONFLICT' | 'NOT_FOUND' | 'CORRUPT' | 'BUSY' | 'OPEN_REFUSED';

export class ConformanceStoreError extends Error {
  readonly code: ConformanceStoreErrorCode;
  readonly detail: string;
  constructor(code: ConformanceStoreErrorCode, detail: string) {
    super(`Conformance store: ${code} (${detail})`);
    this.name = 'ConformanceStoreError';
    this.code = code;
    this.detail = detail;
  }
}

function mapError(error: unknown): ConformanceStoreError {
  if (error instanceof ConformanceStoreError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const code = typeof error === 'object' && error !== null ? String((error as { code?: unknown }).code ?? '') : '';
  if (code.startsWith('SQLITE_BUSY') || code.startsWith('SQLITE_LOCKED')) return new ConformanceStoreError('BUSY', 'database is busy');
  if (message.startsWith('cc:stale head') || message.startsWith('cc:state version gap')) return new ConformanceStoreError('CAS_CONFLICT', message);
  if (message.startsWith('cc:')) return new ConformanceStoreError('INVARIANT_REFUSED', message);
  if (code === 'SQLITE_CONSTRAINT_PRIMARYKEY' || code === 'SQLITE_CONSTRAINT_UNIQUE') return new ConformanceStoreError('CONFLICT', message);
  return new ConformanceStoreError('INVARIANT_REFUSED', message);
}

/** The flags of an evaluation as the store records them. Derived from the record by the caller and re-checked by trigger against `record_json`. */
export interface EvaluationCommit {
  readonly record: EvaluationRecord;
  readonly evaluationDigest: string;
  /** Present exactly when the evaluation suspends an ACTIVE credential. */
  readonly protectiveTransition: SignedTransition | null;
}

export interface ConsumedDecision {
  readonly ref: HumanDecisionRef;
  readonly signed: SignedHumanDecision;
  readonly action: string;
  readonly organizationId: string;
  readonly subjectRef: string;
}

export interface StoredValidator {
  readonly record: ValidatorEnrollmentRecord;
  readonly bindingDigest: string;
  readonly decisions: readonly HumanDecisionRef[];
  readonly keyRevokedAtMs: number | null;
  readonly quarantinedAtMs: number | null;
}

export interface StoredObservationRow {
  readonly eventId: string;
  readonly challengeId: string;
  readonly validatorId: string;
  readonly operatorId: string;
  readonly organizationId: string;
  readonly integrationDigest: string;
  readonly profileId: string;
  readonly profileVersion: string;
  readonly controlId: string;
  readonly evidenceDigest: string;
  readonly outcomeClass: 'conformant' | 'violation' | 'inconclusive';
  readonly claimMatches: boolean;
  readonly observedAt: string;
  readonly acceptedAt: string;
  readonly observationDigest: string;
  readonly submissionJson: string;
}

export interface StoredTransitionRow {
  readonly credentialId: string;
  readonly stateVersion: number;
  readonly transitionDigest: string;
  readonly recordJson: string;
  readonly signatureJson: string;
  readonly columns: {
    readonly transitionId: string;
    readonly from: CredentialState | null;
    readonly to: CredentialState;
    readonly previousTransitionDigest: string | null;
    readonly reasonCode: string;
  };
}

export interface ConformanceStore {
  readonly path: string;
  insertProfile(profileId: string, profileVersion: string, digest: string, definitionJson: string): 'inserted' | 'identical';
  getProfileDigest(profileId: string, profileVersion: string): string | undefined;
  insertPlatform(record: PlatformRecord, digest: string): 'inserted' | 'identical';
  getPlatform(platformId: string): { record: PlatformRecord; digest: string } | undefined;
  insertIntegration(record: IntegrationVersionRecord, integrationDigest: string): void;
  getIntegrationByDigest(organizationId: string, integrationDigest: string): { record: IntegrationVersionRecord; integrationDigest: string } | undefined;
  getIntegrationVersions(organizationId: string, integrationId: string): readonly { record: IntegrationVersionRecord; integrationDigest: string }[];
  insertOperator(record: ValidatorOperatorRecord): 'inserted' | 'identical';
  getOperator(operatorId: string): ValidatorOperatorRecord | undefined;
  insertValidator(record: ValidatorEnrollmentRecord, bindingDigest: string, decisions: readonly ConsumedDecision[], enrolledAt: string): void;
  getValidator(validatorId: string): StoredValidator | undefined;
  getValidatorByKeyId(keyId: string): StoredValidator | undefined;
  appendValidatorEvent(validatorId: string, kind: 'KEY_REVOKED' | 'QUARANTINED', atMs: number, reason: string): void;
  isDecisionConsumed(decisionId: string): boolean;
  listConsumedDecisions(consumedFor: string): readonly { ref: HumanDecisionRef; decisionJson: string; action: string; subjectRef: string; organizationId: string }[];
  insertChallenge(signed: SignedChallenge): void;
  getChallenge(challengeId: string): SignedChallenge | undefined;
  getChallengeByIdempotencyKey(idempotencyKey: string): SignedChallenge | undefined;
  insertEvidencePackage(organizationId: string, digest: string, packageJson: string, storedAt: string): 'inserted' | 'identical';
  hasEvidencePackage(organizationId: string, digest: string): boolean;
  insertObservation(row: StoredObservationRow): void;
  getObservation(eventId: string): StoredObservationRow | undefined;
  getObservationForChallengeValidator(challengeId: string, validatorId: string): StoredObservationRow | undefined;
  listObservations(organizationId: string, integrationDigest: string): readonly StoredObservationRow[];
  insertRejection(rejection: { receivedAt: string; reason: string; submissionDigest: string; eventId: string | null; validatorId: string | null; challengeId: string | null; conflictsWithEventId: string | null }, sideEffect?: () => void): void;
  listRejections(): readonly { reason: string; eventId: string | null; validatorId: string | null; challengeId: string | null; submissionDigest: string; conflictsWithEventId: string | null }[];
  createCredential(record: CredentialRecord, suspensionRevocationMs: number, genesis: SignedTransition): void;
  getCredential(organizationId: string, credentialId: string): CredentialRecord | undefined;
  getHead(organizationId: string, credentialId: string): CredentialHead | undefined;
  listTransitions(organizationId: string, credentialId: string): readonly StoredTransitionRow[];
  listEvaluations(organizationId: string, credentialId: string): readonly { record: EvaluationRecord; evaluationDigest: string; recordJson: string }[];
  /** Commits one evaluation (and, when it suspends, its protective transition) in one IMMEDIATE transaction. `hook` runs inside the transaction after the insert (test fault injection). */
  commitEvaluation(commit: EvaluationCommit, hook?: () => void): void;
  /** Commits an activation/reinstatement/revocation/expiry: optional eligible evaluation, consumed decisions, then the transition, in one IMMEDIATE transaction. */
  commitTransition(input: { readonly evaluation: EvaluationCommit | null; readonly decisions: readonly ConsumedDecision[]; readonly transition: SignedTransition }, hook?: () => void): void;
  close(): void;
}

interface OpenOptions {
  readonly create?: boolean;
  readonly busyTimeoutMs?: number;
}

function expectedTriggers(db: Database.Database): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name").all() as { name: string }[]).map((row) => row.name);
}

let canonicalTriggerSet: string[] | undefined;

/** The exact trigger names this schema creates, computed once from an in-memory database. */
function schemaTriggers(): string[] {
  if (canonicalTriggerSet === undefined) {
    const probe = new Database(':memory:');
    try {
      probe.exec(SCHEMA);
      canonicalTriggerSet = expectedTriggers(probe);
    } finally {
      probe.close();
    }
  }
  return canonicalTriggerSet;
}

export function openConformanceStore(path: string, options: OpenOptions = {}): ConformanceStore {
  const file = resolve(path);
  const create = options.create === true;
  if (create && existsSync(file)) throw new ConformanceStoreError('OPEN_REFUSED', 'a store already exists at that path; it is never re-initialized');
  if (!create && !existsSync(file)) throw new ConformanceStoreError('OPEN_REFUSED', 'no store exists at that path; it is never recreated implicitly');
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
        db.prepare('INSERT INTO cc_meta (id, schema_version, synthetic) VALUES (1, ?, 1)').run(CONFORMANCE_STORE_SCHEMA_VERSION);
      }).immediate();
    } else {
      for (const table of TABLES) {
        if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) === undefined) throw new ConformanceStoreError('CORRUPT', `missing table ${table}`);
      }
      if (db.pragma('quick_check', { simple: true }) !== 'ok') throw new ConformanceStoreError('CORRUPT', 'integrity check failed');
      // Exactly this schema's triggers: a missing one would let history move backwards, an extra one could rewrite it.
      if (JSON.stringify(expectedTriggers(db)) !== JSON.stringify(schemaTriggers())) throw new ConformanceStoreError('CORRUPT', 'trigger set differs from the schema');
      const meta = db.prepare('SELECT schema_version, synthetic FROM cc_meta WHERE id = 1').get() as { schema_version: string; synthetic: number } | undefined;
      if (meta?.schema_version !== CONFORMANCE_STORE_SCHEMA_VERSION || meta.synthetic !== 1) throw new ConformanceStoreError('CORRUPT', 'unexpected schema identity');
    }
  } catch (error) {
    db.close();
    throw error instanceof ConformanceStoreError ? error : new ConformanceStoreError('OPEN_REFUSED', 'the store could not be opened');
  }
  return buildStore(db, file);
}

function run<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    throw mapError(error);
  }
}

function buildStore(db: Database.Database, file: string): ConformanceStore {
  const parseValidator = (row: Record<string, unknown> | undefined): StoredValidator | undefined => {
    if (row === undefined) return undefined;
    const events = db.prepare('SELECT kind, at_ms FROM cc_validator_events WHERE validator_id = ? ORDER BY seq').all(row['validator_id']) as { kind: string; at_ms: number }[];
    const first = (kind: string) => {
      const found = events.filter((e) => e.kind === kind).map((e) => e.at_ms);
      return found.length === 0 ? null : Math.min(...found);
    };
    return Object.freeze({
      record: JSON.parse(String(row['record_json'])) as ValidatorEnrollmentRecord,
      bindingDigest: String(row['binding_digest']),
      decisions: JSON.parse(String(row['decisions_json'])) as HumanDecisionRef[],
      keyRevokedAtMs: first('KEY_REVOKED'),
      quarantinedAtMs: first('QUARANTINED'),
    });
  };
  const parseObservation = (row: Record<string, unknown> | undefined): StoredObservationRow | undefined =>
    row === undefined
      ? undefined
      : Object.freeze({
          eventId: String(row['event_id']),
          challengeId: String(row['challenge_id']),
          validatorId: String(row['validator_id']),
          operatorId: String(row['operator_id']),
          organizationId: String(row['organization_id']),
          integrationDigest: String(row['integration_digest']),
          profileId: String(row['profile_id']),
          profileVersion: String(row['profile_version']),
          controlId: String(row['control_id']),
          evidenceDigest: String(row['evidence_digest']),
          outcomeClass: String(row['outcome_class']) as StoredObservationRow['outcomeClass'],
          claimMatches: row['claim_matches'] === 1,
          observedAt: String(row['observed_at']),
          acceptedAt: String(row['accepted_at']),
          observationDigest: String(row['observation_digest']),
          submissionJson: String(row['submission_json']),
        });
  const parseChallenge = (row: Record<string, unknown> | undefined): SignedChallenge | undefined =>
    row === undefined ? undefined : Object.freeze({ challenge: JSON.parse(String(row['challenge_json'])), coordinatorSignature: JSON.parse(String(row['signature_json'])) }) as SignedChallenge;

  const insertDecision = db.prepare(
    'INSERT INTO cc_consumed_decisions (decision_id, principal_id, role, action, organization_id, subject_ref, action_binding_digest, decision_digest, decision_json, consumed_for, consumed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const consume = (decisions: readonly ConsumedDecision[], consumedFor: string, at: string) => {
    for (const d of decisions) {
      insertDecision.run(d.ref.decisionId, d.ref.principalId, d.ref.role, d.action, d.organizationId, d.subjectRef, d.ref.actionBindingDigest, d.ref.decisionDigest, canonicalizeConformance(d.signed), consumedFor, at);
    }
  };
  const insertTransition = db.prepare(
    'INSERT INTO cc_transitions (credential_id, state_version, transition_id, from_state, to_state, transition_code, reason_code, rule_id, evaluation_id, previous_transition_digest, transition_digest, action_binding_digest, effective_at_ms, record_json, signature_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const writeTransition = (t: SignedTransition) => {
    const r = t.record;
    insertTransition.run(r.credentialId, r.stateVersion, r.transitionId, r.from, r.to, r.transitionCode, r.reasonCode, r.ruleId, r.evaluationId, r.previousTransitionDigest, t.transitionDigest, r.actionBindingDigest, Date.parse(r.effectiveAt), canonicalizeConformance(r), canonicalizeConformance(t.registrySignature));
  };
  const insertEvaluation = db.prepare(
    `INSERT INTO cc_evaluations (evaluation_id, credential_id, evaluated_at_ms, credential_state_version, critical_failure, requires_suspension, eligible_for_active, evaluation_digest, record_json,
      pt_transition_id, pt_reason_code, pt_rule_id, pt_previous_digest, pt_transition_digest, pt_effective_at_ms, pt_record_json, pt_signature_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const writeEvaluation = (commit: EvaluationCommit) => {
    const r = commit.record;
    const pt = commit.protectiveTransition;
    insertEvaluation.run(
      r.evaluationId, r.credentialId, Date.parse(r.evaluatedAt), r.credentialStateVersion,
      r.criticalFailureConfirmed ? 1 : 0, r.proposal.kind === 'SUSPEND' ? 1 : 0, r.proposal.kind === 'ELIGIBLE_FOR_ACTIVE' ? 1 : 0,
      commit.evaluationDigest, canonicalizeConformance(r),
      pt?.record.transitionId ?? null, pt?.record.reasonCode ?? null, pt?.record.ruleId ?? null, pt?.record.previousTransitionDigest ?? null,
      pt?.transitionDigest ?? null, pt === null ? null : Date.parse(pt.record.effectiveAt),
      pt === null ? null : canonicalizeConformance(pt.record), pt === null ? null : canonicalizeConformance(pt.registrySignature),
    );
  };
  const insertOrIdentical = (sql: string, select: string, key: readonly unknown[], values: readonly unknown[], same: (row: Record<string, unknown>) => boolean): 'inserted' | 'identical' =>
    run(() =>
      db.transaction((): 'inserted' | 'identical' => {
        const existing = db.prepare(select).get(...key) as Record<string, unknown> | undefined;
        if (existing !== undefined) {
          if (same(existing)) return 'identical';
          throw new ConformanceStoreError('CONFLICT', 'a different record already exists under this identity');
        }
        db.prepare(sql).run(...values);
        return 'inserted';
      }).immediate(),
    );

  const credentialRow = (organizationId: string, credentialId: string) =>
    db.prepare('SELECT * FROM cc_credentials WHERE credential_id = ? AND organization_id = ?').get(credentialId, organizationId) as Record<string, unknown> | undefined;

  return Object.freeze<ConformanceStore>({
    path: file,
    insertProfile: (profileId: string, profileVersion: string, digest: string, definitionJson: string) =>
      insertOrIdentical(
        'INSERT INTO cc_profiles (profile_id, profile_version, profile_digest, definition_json) VALUES (?, ?, ?, ?)',
        'SELECT profile_digest FROM cc_profiles WHERE profile_id = ? AND profile_version = ?',
        [profileId, profileVersion],
        [profileId, profileVersion, digest, definitionJson],
        (row) => row['profile_digest'] === digest,
      ),
    getProfileDigest: (profileId: string, profileVersion: string) =>
      (db.prepare('SELECT profile_digest FROM cc_profiles WHERE profile_id = ? AND profile_version = ?').get(profileId, profileVersion) as { profile_digest: string } | undefined)?.profile_digest,
    insertPlatform: (record: PlatformRecord, digest: string) =>
      insertOrIdentical(
        'INSERT INTO cc_platforms (platform_id, organization_id, record_digest, record_json, synthetic) VALUES (?, ?, ?, ?, ?)',
        'SELECT record_digest FROM cc_platforms WHERE platform_id = ?',
        [record.platformId],
        [record.platformId, record.organizationId, digest, canonicalizeConformance(record), record.synthetic === true ? 1 : 0],
        (row) => row['record_digest'] === digest,
      ),
    getPlatform: (platformId: string) => {
      const row = db.prepare('SELECT record_json, record_digest FROM cc_platforms WHERE platform_id = ?').get(platformId) as { record_json: string; record_digest: string } | undefined;
      return row === undefined ? undefined : { record: JSON.parse(row.record_json) as PlatformRecord, digest: row.record_digest };
    },
    insertIntegration: (record: IntegrationVersionRecord, integrationDigest: string) =>
      run(() => {
        db.prepare(
          'INSERT INTO cc_integrations (integration_id, integration_version, organization_id, platform_id, profile_id, profile_version, integration_digest, record_json, synthetic) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        ).run(record.integrationId, record.integrationVersion, record.organizationId, record.platformId, record.profile.id, record.profile.version, integrationDigest, canonicalizeConformance(record), record.synthetic === true ? 1 : 0);
      }),
    getIntegrationByDigest: (organizationId: string, integrationDigest: string) => {
      const row = db.prepare('SELECT record_json, integration_digest FROM cc_integrations WHERE integration_digest = ? AND organization_id = ?').get(integrationDigest, organizationId) as
        | { record_json: string; integration_digest: string }
        | undefined;
      return row === undefined ? undefined : { record: JSON.parse(row.record_json) as IntegrationVersionRecord, integrationDigest: row.integration_digest };
    },
    getIntegrationVersions: (organizationId: string, integrationId: string) =>
      (db.prepare('SELECT record_json, integration_digest FROM cc_integrations WHERE integration_id = ? AND organization_id = ? ORDER BY integration_version').all(integrationId, organizationId) as {
        record_json: string;
        integration_digest: string;
      }[]).map((row) => ({ record: JSON.parse(row.record_json) as IntegrationVersionRecord, integrationDigest: row.integration_digest })),
    insertOperator: (record: ValidatorOperatorRecord) => {
      const json = canonicalizeConformance(record);
      return insertOrIdentical(
        'INSERT INTO cc_operators (operator_id, record_json, synthetic) VALUES (?, ?, ?)',
        'SELECT record_json FROM cc_operators WHERE operator_id = ?',
        [record.operatorId],
        [record.operatorId, json, record.synthetic === true ? 1 : 0],
        (row) => row['record_json'] === json,
      );
    },
    getOperator: (operatorId: string) => {
      const row = db.prepare('SELECT record_json FROM cc_operators WHERE operator_id = ?').get(operatorId) as { record_json: string } | undefined;
      return row === undefined ? undefined : (JSON.parse(row.record_json) as ValidatorOperatorRecord);
    },
    insertValidator: (record: ValidatorEnrollmentRecord, bindingDigest: string, decisions: readonly ConsumedDecision[], enrolledAt: string) =>
      run(() =>
        db.transaction(() => {
          consume(decisions, `validator:${record.validatorId}`, enrolledAt);
          db.prepare(
            'INSERT INTO cc_validators (validator_id, operator_id, key_id, public_key_pem, key_valid_from_ms, key_valid_until_ms, binding_digest, record_json, decisions_json, enrolled_at, synthetic) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          ).run(
            record.validatorId, record.operatorId, record.keyId, record.publicKeyPem, Date.parse(record.keyValidFrom), Date.parse(record.keyValidUntil), bindingDigest,
            canonicalizeConformance(record), canonicalizeConformance(decisions.map((d) => d.ref)), enrolledAt, record.synthetic === true ? 1 : 0,
          );
        }).immediate(),
      ),
    getValidator: (validatorId: string) => parseValidator(db.prepare('SELECT * FROM cc_validators WHERE validator_id = ?').get(validatorId) as Record<string, unknown> | undefined),
    getValidatorByKeyId: (keyId: string) => parseValidator(db.prepare('SELECT * FROM cc_validators WHERE key_id = ?').get(keyId) as Record<string, unknown> | undefined),
    appendValidatorEvent: (validatorId: string, kind: 'KEY_REVOKED' | 'QUARANTINED', atMs: number, reason: string) =>
      run(() =>
        db.transaction(() => {
          const next = ((db.prepare('SELECT MAX(seq) AS s FROM cc_validator_events WHERE validator_id = ?').get(validatorId) as { s: number | null }).s ?? 0) + 1;
          db.prepare('INSERT INTO cc_validator_events (validator_id, seq, kind, at_ms, reason) VALUES (?, ?, ?, ?, ?)').run(validatorId, next, kind, atMs, reason);
        }).immediate(),
      ),
    isDecisionConsumed: (decisionId: string) => db.prepare('SELECT 1 FROM cc_consumed_decisions WHERE decision_id = ?').get(decisionId) !== undefined,
    listConsumedDecisions: (consumedFor: string) =>
      (db.prepare('SELECT * FROM cc_consumed_decisions WHERE consumed_for = ? ORDER BY role').all(consumedFor) as Record<string, unknown>[]).map((row) => ({
        ref: {
          format: 'frontera.conformance-authority.v1' as const,
          decisionId: String(row['decision_id']),
          principalId: String(row['principal_id']),
          role: String(row['role']) as 'attest' | 'approve',
          decisionDigest: String(row['decision_digest']),
          actionBindingDigest: String(row['action_binding_digest']),
        },
        decisionJson: String(row['decision_json']),
        action: String(row['action']),
        subjectRef: String(row['subject_ref']),
        organizationId: String(row['organization_id']),
      })),
    insertChallenge: (signed: SignedChallenge) =>
      run(() => {
        const c = signed.challenge;
        db.prepare(
          'INSERT INTO cc_challenges (challenge_id, idempotency_key, nonce, organization_id, integration_digest, profile_id, profile_version, control_id, issued_at_ms, deadline_ms, challenge_json, signature_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        ).run(c.challengeId, c.idempotencyKey, c.nonce, c.organizationId, c.integrationDigest, c.profileId, c.profileVersion, c.controlId, Date.parse(c.issuedAt), Date.parse(c.deadline), canonicalizeConformance(c), canonicalizeConformance(signed.coordinatorSignature));
      }),
    getChallenge: (challengeId: string) => parseChallenge(db.prepare('SELECT challenge_json, signature_json FROM cc_challenges WHERE challenge_id = ?').get(challengeId) as Record<string, unknown> | undefined),
    getChallengeByIdempotencyKey: (key: string) => parseChallenge(db.prepare('SELECT challenge_json, signature_json FROM cc_challenges WHERE idempotency_key = ?').get(key) as Record<string, unknown> | undefined),
    insertEvidencePackage: (organizationId: string, digest: string, packageJson: string, storedAt: string) =>
      insertOrIdentical(
        'INSERT INTO cc_evidence_packages (evidence_digest, organization_id, package_json, stored_at) VALUES (?, ?, ?, ?)',
        'SELECT organization_id FROM cc_evidence_packages WHERE evidence_digest = ?',
        [digest],
        [digest, organizationId, packageJson, storedAt],
        (row) => row['organization_id'] === organizationId,
      ),
    hasEvidencePackage: (organizationId: string, digest: string) => db.prepare('SELECT 1 FROM cc_evidence_packages WHERE evidence_digest = ? AND organization_id = ?').get(digest, organizationId) !== undefined,
    insertObservation: (row: StoredObservationRow) =>
      run(() => {
        db.prepare(
          'INSERT INTO cc_observations (event_id, challenge_id, validator_id, operator_id, organization_id, integration_digest, profile_id, profile_version, control_id, evidence_digest, outcome_class, claim_matches, observed_at, accepted_at, observation_digest, submission_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        ).run(row.eventId, row.challengeId, row.validatorId, row.operatorId, row.organizationId, row.integrationDigest, row.profileId, row.profileVersion, row.controlId, row.evidenceDigest, row.outcomeClass, row.claimMatches ? 1 : 0, row.observedAt, row.acceptedAt, row.observationDigest, row.submissionJson);
      }),
    getObservation: (eventId: string) => parseObservation(db.prepare('SELECT * FROM cc_observations WHERE event_id = ?').get(eventId) as Record<string, unknown> | undefined),
    getObservationForChallengeValidator: (challengeId: string, validatorId: string) =>
      parseObservation(db.prepare('SELECT * FROM cc_observations WHERE challenge_id = ? AND validator_id = ?').get(challengeId, validatorId) as Record<string, unknown> | undefined),
    listObservations: (organizationId: string, integrationDigest: string) =>
      (db.prepare('SELECT * FROM cc_observations WHERE organization_id = ? AND integration_digest = ? ORDER BY observed_at, event_id').all(organizationId, integrationDigest) as Record<string, unknown>[]).map(
        (row) => parseObservation(row)!,
      ),
    insertRejection: (r, sideEffect?: () => void) =>
      run(() =>
        db.transaction(() => {
          db.prepare('INSERT INTO cc_rejections (received_at, reason, submission_digest, event_id, validator_id, challenge_id, conflicts_with_event_id) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
            r.receivedAt, r.reason, r.submissionDigest, r.eventId, r.validatorId, r.challengeId, r.conflictsWithEventId,
          );
          sideEffect?.();
        }).immediate(),
      ),
    listRejections: () =>
      (db.prepare('SELECT reason, event_id, validator_id, challenge_id, submission_digest, conflicts_with_event_id FROM cc_rejections ORDER BY rejection_seq').all() as Record<string, unknown>[]).map((row) => ({
        reason: String(row['reason']),
        eventId: row['event_id'] === null ? null : String(row['event_id']),
        validatorId: row['validator_id'] === null ? null : String(row['validator_id']),
        challengeId: row['challenge_id'] === null ? null : String(row['challenge_id']),
        submissionDigest: String(row['submission_digest']),
        conflictsWithEventId: row['conflicts_with_event_id'] === null ? null : String(row['conflicts_with_event_id']),
      })),
    createCredential: (record: CredentialRecord, suspensionRevocationMs: number, genesis: SignedTransition) =>
      run(() =>
        db.transaction(() => {
          db.prepare(
            'INSERT INTO cc_credentials (credential_id, organization_id, integration_digest, profile_id, profile_version, profile_digest, candidate_until_ms, valid_until_ms, suspension_revocation_ms, record_json, synthetic) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          ).run(record.credentialId, record.organizationId, record.integrationDigest, record.profileId, record.profileVersion, record.profileDigest, Date.parse(record.candidateUntil), Date.parse(record.validUntil), suspensionRevocationMs, canonicalizeConformance(record), record.synthetic === true ? 1 : 0);
          writeTransition(genesis);
        }).immediate(),
      ),
    getCredential: (organizationId: string, credentialId: string) => {
      const row = credentialRow(organizationId, credentialId);
      return row === undefined ? undefined : (JSON.parse(String(row['record_json'])) as CredentialRecord);
    },
    getHead: (organizationId: string, credentialId: string) => {
      if (credentialRow(organizationId, credentialId) === undefined) return undefined;
      const row = db.prepare('SELECT * FROM cc_heads WHERE credential_id = ?').get(credentialId) as Record<string, unknown> | undefined;
      return row === undefined
        ? undefined
        : Object.freeze({
            credentialId: String(row['credential_id']),
            state: String(row['state']) as CredentialState,
            stateVersion: Number(row['state_version']),
            headTransitionDigest: String(row['head_transition_digest']),
            reasonCode: String(row['reason_code']),
            effectiveAt: new Date(Number(row['effective_at_ms'])).toISOString(),
          });
    },
    listTransitions: (organizationId: string, credentialId: string) => {
      if (credentialRow(organizationId, credentialId) === undefined) return [];
      return (db.prepare('SELECT * FROM cc_transitions WHERE credential_id = ? ORDER BY state_version').all(credentialId) as Record<string, unknown>[]).map((row) =>
        Object.freeze({
          credentialId: String(row['credential_id']),
          stateVersion: Number(row['state_version']),
          transitionDigest: String(row['transition_digest']),
          recordJson: String(row['record_json']),
          signatureJson: String(row['signature_json']),
          columns: Object.freeze({
            transitionId: String(row['transition_id']),
            from: row['from_state'] === null ? null : (String(row['from_state']) as CredentialState),
            to: String(row['to_state']) as CredentialState,
            previousTransitionDigest: row['previous_transition_digest'] === null ? null : String(row['previous_transition_digest']),
            reasonCode: String(row['reason_code']),
          }),
        }),
      );
    },
    listEvaluations: (organizationId: string, credentialId: string) => {
      if (credentialRow(organizationId, credentialId) === undefined) return [];
      return (db.prepare('SELECT record_json, evaluation_digest FROM cc_evaluations WHERE credential_id = ? ORDER BY evaluated_at_ms, evaluation_id').all(credentialId) as { record_json: string; evaluation_digest: string }[]).map((row) => ({
        record: JSON.parse(row.record_json) as EvaluationRecord,
        evaluationDigest: row.evaluation_digest,
        recordJson: row.record_json,
      }));
    },
    commitEvaluation: (commit: EvaluationCommit, hook?: () => void) =>
      run(() =>
        db.transaction(() => {
          writeEvaluation(commit);
          hook?.();
        }).immediate(),
      ),
    commitTransition: (input, hook?: () => void) =>
      run(() =>
        db.transaction(() => {
          if (input.evaluation !== null) writeEvaluation(input.evaluation);
          consume(input.decisions, input.transition.record.transitionId, input.transition.record.effectiveAt);
          writeTransition(input.transition);
          hook?.();
        }).immediate(),
      ),
    close: () => db.close(),
  });
}
