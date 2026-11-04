import { createHash } from 'node:crypto';

import { canonicalizeConformance, conformanceDigest, snapshotPlainJson } from './canonical.js';
import {
  EXPECTED_OUTCOMES,
  OBSERVED_OUTCOMES,
  OUTCOME_CLASSES,
  compareSemver,
  isDigest,
  isIdentifier,
  isSemver,
  isTimestamp,
  readClosed,
  toMs,
  type AcceptedObservation,
  type ChallengePayload,
  type ObservationPayload,
} from './contracts.js';
import { verifyChallenge } from './coordinator.js';
import { classifyOutcome } from './engine.js';
import type { ConformanceProfileRegistry } from './profile.js';
import type { ConformanceClock } from './registry.js';
import { ConformanceStoreError, type ConformanceStore, type StoredObservationRow, type StoredValidator } from './sqlite-conformance-store.js';
import { verifyConformanceSignature } from './signing.js';

/**
 * RN-CONFORM-02 / WP-06, WP-07 — the evidence acceptance boundary.
 *
 * The only way an observation reaches evaluation. Input is a bounded JSON
 * **string** (never an object graph a caller built), parsed once, read
 * through a closed schema, authenticated against the validator's
 * **enrolled** key (never a key carried in the submission), bound to its
 * challenge, and only then stored. Checks run in the order of
 * `VALIDATOR_PROTOCOL.md` §3 and each fails closed with one reason.
 *
 * Rejected submissions are retained (append-only) with safe metadata only:
 * the reason, a digest of the raw bytes, and identifiers that are themselves
 * well-formed. Never the payload, never evidence content.
 */

export const MAX_SUBMISSION_BYTES = 16 * 1024;
export const MAX_EVIDENCE_PACKAGE_BYTES = 4 * 1024;
export const CLOCK_SKEW_MS = 5_000;

export const EVIDENCE_REJECTIONS = Object.freeze([
  // 1 — structure
  'SUBMISSION_TOO_LARGE',
  'MALFORMED_JSON',
  'MISSING_FIELD',
  'UNKNOWN_FIELD',
  'MALFORMED_FIELD',
  // 2 — validator
  'UNKNOWN_VALIDATOR',
  // 3 — validator status and key
  'VALIDATOR_REVOKED',
  'VALIDATOR_QUARANTINED',
  'KEY_NOT_VALID',
  // 4 — signature
  'SIGNATURE_MISMATCH',
  // 5 — challenge
  'CHALLENGE_UNKNOWN',
  'CHALLENGE_BINDING_MISMATCH',
  'NOT_ASSIGNED',
  // 6 — subject
  'SUBJECT_BINDING_MISMATCH',
  // 7 — profile
  'UNSUPPORTED_PROFILE',
  'PROFILE_DOWNGRADE',
  // 8 — time
  'CHALLENGE_EXPIRED',
  'FUTURE_DATED',
  // 9 — replay
  'REPLAYED',
  'VALIDATOR_CONFLICT',
  // 10 — evidence custody
  'EVIDENCE_MISSING',
] as const);
export type EvidenceRejection = (typeof EVIDENCE_REJECTIONS)[number];

export type SubmissionResult =
  | { readonly accepted: true; readonly observation: AcceptedObservation }
  | { readonly accepted: false; readonly reason: EvidenceRejection };

const OBSERVATION_FIELDS = [
  'schema', 'eventId', 'challengeId', 'challengeNonce', 'validatorId', 'validatorKeyId', 'organizationId', 'platformId', 'integrationId', 'integrationVersion',
  'integrationDigest', 'observedDeploymentDigest', 'profileId', 'profileVersion', 'controlId', 'operation', 'expectedOutcome', 'observedOutcome', 'outcomeClass',
  'evidenceDigest', 'observedAt', 'submittedAt',
] as const;

const NONCE = /^[A-Za-z0-9_-]{43}$/;
const OPERATION = /^[a-z][a-z0-9.-]{0,63}$/;

function readObservation(value: unknown): ObservationPayload | 'MISSING_FIELD' | 'UNKNOWN_FIELD' | 'MALFORMED_FIELD' {
  const read = readClosed(value, OBSERVATION_FIELDS);
  if (!read.ok) return read.reason;
  const o = read.record;
  const ok =
    o['schema'] === 'rn.conformance.observation/1' &&
    isIdentifier(o['eventId']) && isIdentifier(o['challengeId']) && typeof o['challengeNonce'] === 'string' && NONCE.test(o['challengeNonce']) &&
    isIdentifier(o['validatorId']) && isDigest(o['validatorKeyId']) && isIdentifier(o['organizationId']) && isIdentifier(o['platformId']) &&
    isIdentifier(o['integrationId']) && Number.isSafeInteger(o['integrationVersion']) && (o['integrationVersion'] as number) >= 1 && isDigest(o['integrationDigest']) &&
    (o['observedDeploymentDigest'] === null || isDigest(o['observedDeploymentDigest'])) &&
    isIdentifier(o['profileId']) && isSemver(o['profileVersion']) && isIdentifier(o['controlId']) && typeof o['operation'] === 'string' && OPERATION.test(o['operation']) &&
    typeof o['expectedOutcome'] === 'string' && (EXPECTED_OUTCOMES as readonly string[]).includes(o['expectedOutcome']) &&
    typeof o['observedOutcome'] === 'string' && (OBSERVED_OUTCOMES as readonly string[]).includes(o['observedOutcome']) &&
    typeof o['outcomeClass'] === 'string' && (OUTCOME_CLASSES as readonly string[]).includes(o['outcomeClass']) &&
    isDigest(o['evidenceDigest']) && isTimestamp(o['observedAt']) && isTimestamp(o['submittedAt']);
  return ok ? (o as unknown as ObservationPayload) : 'MALFORMED_FIELD';
}

export interface EvidencePackageInput {
  readonly schema: 'rn.conformance.evidence-package/1';
  readonly challengeId: string;
  readonly validatorId: string;
  readonly requestDigest: string;
  readonly responseDigest: string;
  readonly statusCode: number;
  readonly latencyMs: number;
  readonly synthetic: true;
}

export interface EvidenceService {
  /** Stores a redacted evidence package (digests and status only) and returns its digest. Free text, content and credentials have no field to go in. */
  depositEvidencePackage(organizationId: string, pkg: EvidencePackageInput): string;
  submitObservation(raw: string): SubmissionResult;
}

export function createEvidenceService(deps: {
  readonly store: ConformanceStore;
  readonly profiles: ConformanceProfileRegistry;
  readonly clock: ConformanceClock;
  readonly coordinatorPublicKeyPem: string;
}): EvidenceService {
  const { store, profiles, clock, coordinatorPublicKeyPem } = deps;

  return Object.freeze({
    depositEvidencePackage(organizationId: string, pkg: EvidencePackageInput): string {
      const read = readClosed(pkg, ['schema', 'challengeId', 'validatorId', 'requestDigest', 'responseDigest', 'statusCode', 'latencyMs', 'synthetic']);
      const ok =
        read.ok && pkg.schema === 'rn.conformance.evidence-package/1' && isIdentifier(organizationId) && isIdentifier(pkg.challengeId) && isIdentifier(pkg.validatorId) &&
        isDigest(pkg.requestDigest) && isDigest(pkg.responseDigest) && Number.isSafeInteger(pkg.statusCode) && pkg.statusCode >= 0 && pkg.statusCode <= 999 &&
        Number.isSafeInteger(pkg.latencyMs) && pkg.latencyMs >= 0 && pkg.synthetic === true;
      if (!ok) throw new TypeError('An evidence package carries digests, a status code and a latency only.');
      const json = canonicalizeConformance(pkg);
      if (Buffer.byteLength(json) > MAX_EVIDENCE_PACKAGE_BYTES) throw new TypeError('Evidence package too large.');
      const digest = conformanceDigest(pkg);
      store.insertEvidencePackage(organizationId, digest, json, clock.now());
      return digest;
    },

    submitObservation(raw: string): SubmissionResult {
      const receivedAt = clock.now();
      const nowMs = toMs(receivedAt);
      const text = typeof raw === 'string' ? raw : '';
      const submissionDigest = `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
      let meta: { eventId: string | null; validatorId: string | null; challengeId: string | null } = { eventId: null, validatorId: null, challengeId: null };
      const reject = (reason: EvidenceRejection, conflictsWithEventId: string | null = null, sideEffect?: () => void): SubmissionResult => {
        store.insertRejection({ receivedAt, reason, submissionDigest, ...meta, conflictsWithEventId }, sideEffect);
        return { accepted: false, reason };
      };

      // 1 — bounded parse, closed schema.
      if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > MAX_SUBMISSION_BYTES) return reject('SUBMISSION_TOO_LARGE');
      let parsed: unknown;
      try {
        parsed = snapshotPlainJson(JSON.parse(raw));
      } catch {
        return reject('MALFORMED_JSON');
      }
      const outer = readClosed(parsed, ['observation', 'validatorSignature']);
      if (!outer.ok) return reject(outer.reason);
      const observation = readObservation(outer.record['observation']);
      if (typeof observation === 'string') return reject(observation);
      const signature = outer.record['validatorSignature'];
      meta = { eventId: observation.eventId, validatorId: observation.validatorId, challengeId: observation.challengeId };

      // 2–8 — the one authoritative contract, shared with re-authentication of stored rows.
      const authority = checkObservationAuthority(store, profiles, observation, signature, nowMs, coordinatorPublicKeyPem);
      if (!authority.ok) return reject(authority.reason);
      const { validator, challenge } = authority;

      // 9 — replay and per-validator uniqueness. A second, different observation is retained as a conflict and quarantines the validator.
      if (store.getObservation(observation.eventId) !== undefined) return reject('REPLAYED');
      const prior = store.getObservationForChallengeValidator(observation.challengeId, observation.validatorId);
      if (prior !== undefined) {
        return reject('VALIDATOR_CONFLICT', prior.eventId, () => store.appendValidatorEvent(observation.validatorId, 'QUARANTINED', nowMs, 'VALIDATOR_CONFLICT'));
      }

      // 10 — evidence package in custody, and the classification the engine computes (never the validator's).
      const custody = checkObservationCustody(store, observation, challenge);
      if (!custody.ok) return reject(custody.reason);
      const { outcomeClass } = custody;
      const row: StoredObservationRow = Object.freeze({
        eventId: observation.eventId,
        challengeId: observation.challengeId,
        validatorId: observation.validatorId,
        operatorId: validator.record.operatorId,
        organizationId: observation.organizationId,
        integrationDigest: observation.integrationDigest,
        profileId: observation.profileId,
        profileVersion: observation.profileVersion,
        controlId: observation.controlId,
        operation: observation.operation,
        evidenceDigest: observation.evidenceDigest,
        outcomeClass,
        claimMatches: outcomeClass === observation.outcomeClass,
        observedAt: observation.observedAt,
        observedAtMs: toMs(observation.observedAt),
        acceptedAt: receivedAt,
        acceptedAtMs: nowMs,
        observationDigest: conformanceDigest({ observation, validatorSignature: signature }),
        submissionJson: canonicalizeConformance({ observation, validatorSignature: signature }),
      });
      try {
        store.insertObservation(row);
      } catch (error) {
        if (error instanceof ConformanceStoreError && error.code === 'CONFLICT') {
          return store.getObservation(observation.eventId) !== undefined ? reject('REPLAYED') : reject('VALIDATOR_CONFLICT');
        }
        throw error;
      }
      return { accepted: true, observation: toAccepted(row) };
    },
  });
}

/**
 * Steps 2–8 of `VALIDATOR_PROTOCOL.md` §3 — validator, status and key validity, signature under the
 * enrolled key, challenge authenticity and binding, exact subject, profile, and time — evaluated **as of
 * `atMs`**, the acceptance instant. This is the one evidence-validation contract (finding 5): the
 * acceptance boundary calls it with the trusted clock; every re-authentication of a stored row calls it
 * with that row's recorded acceptance time, so a row inserted outside the boundary passes only if the
 * boundary itself would have accepted it then.
 *
 * Retrospective policy: the checks are historical (key validity interval, challenge deadline, status at
 * acceptance). Later events do not make valid evidence invalid here; instead, a validator whose key is
 * revoked or who is quarantined **at evaluation time** is excluded from every later evaluation, including
 * for evidence accepted before the revocation (`loadEngineInput`). Compromise therefore withdraws a
 * validator's past evidence without rewriting it.
 */
export function checkObservationAuthority(
  store: ConformanceStore,
  profiles: ConformanceProfileRegistry,
  observation: ObservationPayload,
  signature: unknown,
  atMs: number,
  coordinatorPublicKeyPem: string,
  options: { readonly storedRow?: boolean } = {},
): { readonly ok: true; readonly validator: StoredValidator; readonly challenge: ChallengePayload } | { readonly ok: false; readonly reason: EvidenceRejection } {
  const no = (reason: EvidenceRejection) => ({ ok: false, reason }) as const;
  // 2 — known validator.
  const validator = store.getValidator(observation.validatorId);
  if (validator === undefined) return no('UNKNOWN_VALIDATOR');
  // 3 — status and key validity (the key is the enrolled one; a submitted key id is only a claim).
  // RN-CONFORM-05 compatibility fix: re-authenticating a STORED row, a status event stamped in the same millisecond as
  // the row's acceptance happened after it (live acceptance refuses an event at or before the acceptance instant, so a
  // row with that acceptance time could only have committed before the event). Without this, the automatic
  // VALIDATOR_CONFLICT quarantine (or another protective quarantine or revocation in the acceptance millisecond) made
  // already-accepted evidence look tampered and left the credential's status failing closed (EVIDENCE_TAMPERED) for
  // the whole evaluation horizon. Exclusion of the validator's evidence from later evaluations is unchanged.
  const statusApplies = (eventMs: number | null) => eventMs !== null && (options.storedRow === true ? eventMs < atMs : eventMs <= atMs);
  if (statusApplies(validator.keyRevokedAtMs)) return no('VALIDATOR_REVOKED');
  if (statusApplies(validator.quarantinedAtMs)) return no('VALIDATOR_QUARANTINED');
  const observedMs = toMs(observation.observedAt);
  const keyFrom = toMs(validator.record.keyValidFrom);
  const keyUntil = toMs(validator.record.keyValidUntil);
  if (observation.validatorKeyId !== validator.record.keyId || observedMs < keyFrom || observedMs > keyUntil || atMs > keyUntil) return no('KEY_NOT_VALID');
  // 4 — signature under the pinned key, in the observation domain.
  if (!verifyConformanceSignature('observation', observation, signature, validator.record.publicKeyPem).ok) return no('SIGNATURE_MISMATCH');

  // 5 — challenge exists (and is the coordinator's), nonce echoed, validator assigned.
  const signedChallenge = store.getChallenge(observation.challengeId);
  if (signedChallenge === undefined || !verifyChallenge(signedChallenge, coordinatorPublicKeyPem)) return no('CHALLENGE_UNKNOWN');
  const challenge = signedChallenge.challenge;
  if (challenge.challengeId !== observation.challengeId || challenge.nonce !== observation.challengeNonce) return no('CHALLENGE_BINDING_MISMATCH');
  if (!challenge.assignedValidatorIds.includes(observation.validatorId)) return no('NOT_ASSIGNED');

  // 6 — exact subject binding.
  const subjectOk =
    observation.organizationId === challenge.organizationId &&
    observation.platformId === challenge.platformId &&
    observation.integrationId === challenge.integrationId &&
    observation.integrationVersion === challenge.integrationVersion &&
    observation.integrationDigest === challenge.integrationDigest &&
    observation.controlId === challenge.controlId &&
    observation.operation === challenge.operation &&
    observation.expectedOutcome === challenge.expectedOutcome;
  if (!subjectOk) return no('SUBJECT_BINDING_MISMATCH');

  // 7 — profile: equal to the challenge's, supported, never lower.
  if (observation.profileId !== challenge.profileId) return no('UNSUPPORTED_PROFILE');
  if (observation.profileVersion !== challenge.profileVersion) return no(compareSemver(observation.profileVersion, challenge.profileVersion) < 0 ? 'PROFILE_DOWNGRADE' : 'UNSUPPORTED_PROFILE');
  if (!profiles.resolve(challenge.profileId, challenge.profileVersion, challenge.profileDigest).ok) return no('UNSUPPORTED_PROFILE');

  // 8 — time: observed after issuance, submitted after observation and before the deadline, accepted before the deadline, nothing in the future.
  const submittedMs = toMs(observation.submittedAt);
  if (observedMs > atMs + CLOCK_SKEW_MS || submittedMs > atMs + CLOCK_SKEW_MS) return no('FUTURE_DATED');
  const deadlineMs = toMs(challenge.deadline) + CLOCK_SKEW_MS;
  if (observedMs < toMs(challenge.issuedAt) || submittedMs < observedMs || submittedMs > deadlineMs || atMs > deadlineMs) return no('CHALLENGE_EXPIRED');
  return { ok: true, validator, challenge };
}

/** Step 10 — the evidence package is in custody for this organization and is this validator's, for this challenge — and the engine's classification. */
export function checkObservationCustody(
  store: ConformanceStore,
  observation: ObservationPayload,
  challenge: ChallengePayload,
): { readonly ok: true; readonly outcomeClass: AcceptedObservation['outcomeClass'] } | { readonly ok: false; readonly reason: EvidenceRejection } {
  // Another validator's package, or a package for another challenge, cannot be cited.
  const pkg = store.getEvidencePackage(observation.organizationId, observation.evidenceDigest);
  if (pkg === undefined || pkg.challengeId !== observation.challengeId || pkg.validatorId !== observation.validatorId) return { ok: false, reason: 'EVIDENCE_MISSING' };
  const integration = store.getIntegrationByDigest(challenge.organizationId, challenge.integrationDigest);
  if (integration === undefined) return { ok: false, reason: 'SUBJECT_BINDING_MISMATCH' };
  return { ok: true, outcomeClass: classifyOutcome(challenge.expectedOutcome, observation.observedOutcome, observation.observedDeploymentDigest, integration.record.deploymentDigest) };
}

/** A stored row that does not re-authenticate: either a structural defect of the row, or the acceptance rejection the boundary would have given. */
export type StoredObservationDefect =
  | 'SUBMISSION_UNREADABLE'
  | 'DIGEST_MISMATCH'
  | 'COLUMN_MISMATCH'
  | 'CLASSIFICATION_MISMATCH'
  | EvidenceRejection;

/**
 * Re-authenticates a **stored** observation row from its signed submission, so a row written or
 * rewritten outside the acceptance boundary (a raw SQL writer) never reaches evaluation. It applies
 * the same contract as acceptance (`checkObservationAuthority`, `checkObservationCustody`) as of the
 * row's recorded acceptance time, then checks the stored digest, every column against the signed
 * payload and the engine's own classification. Returns `null` when the row is authentic.
 *
 * Limitation (review P3-F): a row's recorded acceptance time is not signed. Whatever it says, the signed
 * observation must have been observed and submitted inside the signed challenge's window and the
 * enrolled key's validity; but a raw writer holding a genuinely signed submission that the boundary
 * refused only because it *arrived* late (after the deadline or the key's end) can choose an acceptance
 * time that makes it pass. Closing that needs a signed acceptance receipt (RN-CONFORM-03 key custody).
 */
export function authenticateStoredObservation(
  store: ConformanceStore,
  profiles: ConformanceProfileRegistry,
  row: StoredObservationRow,
  coordinatorPublicKeyPem: string,
): StoredObservationDefect | null {
  let submission: { observation: ObservationPayload; validatorSignature: unknown };
  try {
    const parsed = snapshotPlainJson(JSON.parse(row.submissionJson));
    const outer = readClosed(parsed, ['observation', 'validatorSignature']);
    if (!outer.ok) return 'SUBMISSION_UNREADABLE';
    const observation = readObservation(outer.record['observation']);
    if (typeof observation === 'string') return 'SUBMISSION_UNREADABLE';
    submission = { observation, validatorSignature: outer.record['validatorSignature'] };
    if (canonicalizeConformance(submission) !== row.submissionJson || conformanceDigest(submission) !== row.observationDigest) return 'DIGEST_MISMATCH';
  } catch {
    return 'SUBMISSION_UNREADABLE';
  }
  if (!isTimestamp(row.acceptedAt) || row.acceptedAtMs !== toMs(row.acceptedAt)) return 'COLUMN_MISMATCH';
  const o = submission.observation;
  const authority = checkObservationAuthority(store, profiles, o, submission.validatorSignature, row.acceptedAtMs, coordinatorPublicKeyPem, { storedRow: true });
  if (!authority.ok) return authority.reason;
  const columnsMatch =
    row.eventId === o.eventId && row.challengeId === o.challengeId && row.validatorId === o.validatorId && row.operatorId === authority.validator.record.operatorId &&
    row.organizationId === o.organizationId && row.integrationDigest === o.integrationDigest && row.profileId === o.profileId && row.profileVersion === o.profileVersion &&
    row.controlId === o.controlId && row.operation === o.operation && row.evidenceDigest === o.evidenceDigest && row.observedAt === o.observedAt && row.observedAtMs === toMs(o.observedAt);
  if (!columnsMatch) return 'COLUMN_MISMATCH';
  const custody = checkObservationCustody(store, o, authority.challenge);
  if (!custody.ok) return custody.reason;
  if (custody.outcomeClass !== row.outcomeClass || (custody.outcomeClass === o.outcomeClass) !== row.claimMatches) return 'CLASSIFICATION_MISMATCH';
  return null;
}

export function toAccepted(row: StoredObservationRow): AcceptedObservation {
  return Object.freeze({
    eventId: row.eventId,
    challengeId: row.challengeId,
    validatorId: row.validatorId,
    operatorId: row.operatorId,
    controlId: row.controlId,
    operation: row.operation,
    integrationDigest: row.integrationDigest,
    profileId: row.profileId,
    profileVersion: row.profileVersion,
    outcomeClass: row.outcomeClass,
    validatorClaimMatches: row.claimMatches,
    observedAt: row.observedAt,
    acceptedAt: row.acceptedAt,
    observationDigest: row.observationDigest,
  });
}
