import { canonicalSerialize } from '../governance-store/canonical-json.js';
import { computeDigest, isWellFormedDigest } from '../governance-store/digest.js';
import { deepFreeze } from '../governance-store/store-common.js';
import {
  EXECUTION_OUTCOME_STORE_SCHEMA_VERSION,
  type ExecutionAttemptRecord,
  type ExecutionTerminalObservation,
  type ExecutionTerminalRecord,
  type PrepareExecutionAttemptInput,
  type RecordExecutionTerminalInput,
} from './contracts.js';
import { executionAttemptViolation, executionTerminalObservationViolation, isCanonicalOutcomeInstant } from './validation.js';

/**
 * Integrity for the execution outcome store: what each digest commits to, how a
 * record is built from a validated input, and how a persisted one is verified.
 *
 * One canonicalization and one digest primitive — `aoc.canonical-json.v1` and
 * SHA-256 from the Governance Store — reused verbatim. Each digest input is
 * domain-separated by a versioned tag, so an attempt digest can never equal an
 * observation digest over the same bytes.
 *
 * An observation digest commits to the attempt digest it belongs to, so an
 * observation cannot be re-pointed at another attempt — another amount, another
 * grant, another tenant — without failing verification.
 *
 * Integrity is not authenticity: a writer able to rewrite a row *and* its
 * digest consistently is not detected from inside this file.
 */

const ATTEMPT_DOMAIN = 'aoc.execution-outcome.attempt.v1';
const OBSERVATION_DOMAIN = 'aoc.execution-outcome.terminal.v1';

/** A fresh, plain copy of an attempt input with only the declared fields — nothing the caller's object carries survives. */
function attemptFact(input: PrepareExecutionAttemptInput): PrepareExecutionAttemptInput {
  return {
    organizationId: input.organizationId,
    executionId: input.executionId,
    evaluationId: input.evaluationId,
    requestId: input.requestId,
    decisionId: input.decisionId,
    boundedGrantId: input.boundedGrantId,
    action: input.action,
    ...(input.amount !== undefined ? { amount: { value: input.amount.value, unit: input.amount.unit } } : {}),
    preparedAt: input.preparedAt,
  };
}

/** A fresh, plain copy of an observation with only its arm's declared fields. */
export function copyObservation(observation: ExecutionTerminalObservation): ExecutionTerminalObservation {
  if (observation.kind === 'withheld') {
    return { kind: 'withheld', withheldBy: observation.withheldBy, reasonCodes: [...observation.reasonCodes], observedAt: observation.observedAt };
  }
  const attribution = { adapterId: observation.adapterId, ...(observation.routedBy !== undefined ? { routedBy: observation.routedBy } : {}) };
  const reference = observation.providerRef !== undefined ? { providerRef: observation.providerRef } : {};
  if (observation.certainty === 'confirmed-not-completed') {
    return { kind: 'provider', certainty: 'confirmed-not-completed', ...attribution, ...reference, failure: observation.failure, observedAt: observation.observedAt };
  }
  return { kind: 'provider', certainty: observation.certainty, ...attribution, ...reference, observedAt: observation.observedAt };
}

function attemptDigestOf(fact: PrepareExecutionAttemptInput, schemaVersion: string, recordedAt: string): string {
  return computeDigest({ domain: ATTEMPT_DOMAIN, schemaVersion, ...fact, amount: fact.amount ?? null, recordedAt });
}

function observationDigestOf(input: { readonly organizationId: string; readonly executionId: string; readonly attemptDigest: string; readonly observation: ExecutionTerminalObservation }, schemaVersion: string, recordedAt: string): string {
  return computeDigest({
    domain: OBSERVATION_DOMAIN,
    schemaVersion,
    organizationId: input.organizationId,
    executionId: input.executionId,
    attemptDigest: input.attemptDigest,
    observation: input.observation,
    recordedAt,
  });
}

export function buildExecutionAttemptRecord(input: PrepareExecutionAttemptInput, recordedAt: string): ExecutionAttemptRecord {
  const fact = attemptFact(input);
  const schemaVersion = EXECUTION_OUTCOME_STORE_SCHEMA_VERSION;
  return deepFreeze({ ...fact, schemaVersion, recordedAt, attemptDigest: attemptDigestOf(fact, schemaVersion, recordedAt) });
}

export function buildExecutionTerminalRecord(input: RecordExecutionTerminalInput, attempt: ExecutionAttemptRecord, recordedAt: string): ExecutionTerminalRecord {
  const observation = copyObservation(input.observation);
  const schemaVersion = EXECUTION_OUTCOME_STORE_SCHEMA_VERSION;
  const body = { organizationId: attempt.organizationId, executionId: attempt.executionId, attemptDigest: attempt.attemptDigest, observation };
  return deepFreeze({ schemaVersion, ...body, recordedAt, observationDigest: observationDigestOf(body, schemaVersion, recordedAt) });
}

/**
 * Whether a retried preparation describes the same attempt.
 *
 * Everything but `preparedAt`: a request that crashed after preparing and
 * before claiming is retried later, at a later instant, and must find its own
 * attempt rather than a conflict that would strand a request that never
 * reached a provider. The first `preparedAt` stands.
 */
export function sameExecutionAttempt(recorded: ExecutionAttemptRecord, input: PrepareExecutionAttemptInput): boolean {
  const { preparedAt: _recordedAt, ...left } = attemptFact(recorded);
  const { preparedAt: _inputAt, ...right } = attemptFact(input);
  return canonicalSerialize(left) === canonicalSerialize(right);
}

/** Whether a repeated observation is the identical fact — every field, including the reference, the attribution and the instant. */
export function sameExecutionObservation(recorded: ExecutionTerminalRecord, observation: ExecutionTerminalObservation): boolean {
  return canonicalSerialize(recorded.observation) === canonicalSerialize(copyObservation(observation));
}

/** Why a persisted attempt fails verification, or `undefined` when it verifies. */
export function executionAttemptRecordFailure(record: ExecutionAttemptRecord): string | undefined {
  if (record.schemaVersion !== EXECUTION_OUTCOME_STORE_SCHEMA_VERSION) return 'the attempt carries an unknown schema version';
  const { schemaVersion, recordedAt, attemptDigest, ...fact } = record;
  const violation = executionAttemptViolation(fact);
  if (violation !== undefined) return `the attempt is outside the contract (${violation})`;
  if (!isCanonicalOutcomeInstant(recordedAt)) return 'the attempt recordedAt is not a canonical instant';
  if (typeof attemptDigest !== 'string' || !isWellFormedDigest(attemptDigest)) return 'the attempt digest is malformed';
  if (attemptDigestOf(attemptFact(fact), schemaVersion, recordedAt) !== attemptDigest) return 'the attempt digest does not recompute';
  return undefined;
}

/** Why a persisted observation fails verification against its attempt, or `undefined` when it verifies. */
export function executionTerminalRecordFailure(record: ExecutionTerminalRecord, attempt: ExecutionAttemptRecord): string | undefined {
  if (record.schemaVersion !== EXECUTION_OUTCOME_STORE_SCHEMA_VERSION) return 'the observation carries an unknown schema version';
  if (record.organizationId !== attempt.organizationId || record.executionId !== attempt.executionId) return 'the observation does not belong to its attempt';
  if (record.attemptDigest !== attempt.attemptDigest) return 'the observation names a different attempt';
  const violation = executionTerminalObservationViolation(record.observation);
  if (violation !== undefined) return `the observation is outside the contract (${violation})`;
  if (!isCanonicalOutcomeInstant(record.recordedAt)) return 'the observation recordedAt is not a canonical instant';
  if (typeof record.observationDigest !== 'string' || !isWellFormedDigest(record.observationDigest)) return 'the observation digest is malformed';
  const body = { organizationId: record.organizationId, executionId: record.executionId, attemptDigest: record.attemptDigest, observation: copyObservation(record.observation) };
  if (observationDigestOf(body, record.schemaVersion, record.recordedAt) !== record.observationDigest) return 'the observation digest does not recompute';
  return undefined;
}
