import { isCanonicalCustomerIdentifier } from '../customer-identity/identifiers.js';
import { deepFreeze } from '../governance-store/store-common.js';
import {
  MPP_CHALLENGE_INSTANCES_PER_OPERATION_MAX,
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
import { mppBusinessOperationDerivationFailure, mppBusinessOperationRecordFailure, mppChallengeDerivationFailure, mppChallengeInstanceRecordFailure } from './integrity.js';
import { mppBusinessOperationViolation, mppChallengeInstanceViolation } from './validation.js';

/**
 * The read half the P14 handoff needs, and nothing else: the verified
 * operation a governed request maps to and its latest accepted challenge.
 * Keyed by the trusted governed request id, never by a challenge id a caller
 * or adapter supplies.
 */
export interface MppGovernedRequestReader {
  readByGovernedRequestId(context: MppBusinessOperationAccessContext, requestId: string): Promise<MppGovernedRequestState | undefined>;
}

/** The full read half: one operation and its whole challenge history, verified. */
export interface MppBusinessOperationReader extends MppGovernedRequestReader {
  readOperation(context: MppBusinessOperationAccessContext, principalId: string, businessOperationId: string): Promise<MppBusinessOperationState | undefined>;
}

/**
 * The write half — append only. One call resolves the operation and appends
 * the challenge in one critical section:
 *
 * - operation absent → created; present with the same business semantic digest
 *   → `existing`, returned unchanged; present with a different one →
 *   `MPP_BUSINESS_OPERATION_CONFLICT`, and nothing is written;
 * - challenge with a digest already on the operation → `existing`; otherwise a
 *   new instance at the next store-assigned sequence.
 *
 * No update, no delete, no overwrite, no "latest wins" for the operation.
 */
export interface MppBusinessOperationWriter {
  record(context: MppBusinessOperationAccessContext, input: RecordMppChallengeInput): Promise<RecordMppChallengeResult>;
}

export interface MppBusinessOperationPort extends MppBusinessOperationReader, MppBusinessOperationWriter {}

/**
 * The MPP business-operation store (P13).
 *
 * ## What an implementation must guarantee
 *
 * 1. **Atomic write decisions.** Each `record` loads and verifies the existing
 *    operation and every one of its challenges, decides and writes in one
 *    critical section (SQLite: one `BEGIN IMMEDIATE` transaction; memory: one
 *    synchronous section). No network call is ever made inside it.
 * 2. **Uniqueness.** At most one operation per (organization, principal,
 *    businessOperationId), enforced by the store — a primary key in SQLite —
 *    under genuinely concurrent writers, never by process memory.
 * 3. **Immutability.** Operations and challenges are never updated or deleted
 *    (SQLite: triggers refuse both).
 * 4. **Tenant confinement.** A call under another organization reads nothing
 *    and writes nothing.
 * 5. **Verify before trusting — and before filtering.** Every candidate row
 *    is re-validated and its digests recomputed before its sequence or any
 *    other field can select or exclude it.
 * 6. **Fail closed, never repair.** Corrupt state is an error, never "absent".
 */
export interface MppBusinessOperationStore extends MppBusinessOperationPort {
  readonly providerKind: 'memory' | 'sqlite';
  health(): Promise<MppBusinessOperationStoreHealth>;
  close(): Promise<void>;
}

export function requireMppAccessContext(context: MppBusinessOperationAccessContext): string {
  const organizationId = (context as { readonly organizationId?: unknown } | undefined)?.organizationId;
  const system = (context as { readonly system?: unknown } | undefined)?.system;
  if (!isCanonicalCustomerIdentifier(organizationId) || system !== undefined) {
    throw new MppBusinessOperationStoreError('MPP_BUSINESS_OPERATION_TENANT_VIOLATION', 'An MPP business-operation call requires exactly one organization scope.');
  }
  return organizationId;
}

export function requireMppIdentifier(value: unknown, what: string): string {
  if (!isCanonicalCustomerIdentifier(value)) throw new MppBusinessOperationStoreError('MPP_BUSINESS_OPERATION_INPUT_INVALID', `${what} is not a canonical identifier.`);
  return value;
}

function corrupt(subject: string, what: string): MppBusinessOperationStoreError {
  return new MppBusinessOperationStoreError('MPP_BUSINESS_OPERATION_CORRUPT', `The persisted business-operation state for '${subject}' failed verification (${what}). Refused, never repaired.`);
}

/**
 * The one verification every implementation runs over a loaded operation and
 * **all** of its challenge rows. Integrity comes first: a row that does not
 * verify is corrupt whoever asks, and only then is its organization compared.
 * Sequences must run 1…n without a gap or a repeat.
 */
export function verifyLoadedMppOperationState(
  subject: string,
  organizationId: string,
  operation: MppBusinessOperationRecord | undefined,
  challenges: readonly MppChallengeInstanceRecord[],
): MppBusinessOperationState | undefined {
  if (operation === undefined) {
    if (challenges.length > 0) throw corrupt(subject, 'challenges exist with no operation');
    return undefined;
  }
  const failure = mppBusinessOperationRecordFailure(operation);
  if (failure !== undefined) throw corrupt(subject, failure);
  for (const challenge of challenges) {
    const challengeFailure = mppChallengeInstanceRecordFailure(challenge, operation);
    if (challengeFailure !== undefined) throw corrupt(subject, challengeFailure);
  }
  const ordered = [...challenges].sort((left, right) => left.challengeSequence - right.challengeSequence);
  for (const [index, challenge] of ordered.entries()) {
    if (challenge.challengeSequence !== index + 1) throw corrupt(subject, 'the challenge sequence has a gap or a repeat');
  }
  if (new Set(ordered.map((challenge) => challenge.challengeDigest)).size !== ordered.length) throw corrupt(subject, 'one challenge is recorded twice');
  if (ordered.length === 0) throw corrupt(subject, 'an operation exists with no accepted challenge');
  if (operation.organizationId !== organizationId) {
    throw new MppBusinessOperationStoreError('MPP_BUSINESS_OPERATION_TENANT_VIOLATION', `The caller is not authorized to access business operation '${subject}'.`);
  }
  return deepFreeze({ operation, challenges: ordered });
}

export function requireValidRecordInput(context: MppBusinessOperationAccessContext, input: RecordMppChallengeInput): void {
  const organizationId = requireMppAccessContext(context);
  const invalid = (message: string) => new MppBusinessOperationStoreError('MPP_BUSINESS_OPERATION_INPUT_INVALID', message);
  if (input === null || typeof input !== 'object') throw invalid('The record input is not an object.');
  const operationViolation = mppBusinessOperationViolation(input.operation);
  if (operationViolation !== undefined) throw invalid(`The business operation is outside the closed contract: ${operationViolation}.`);
  const challengeViolation = mppChallengeInstanceViolation(input.challenge);
  if (challengeViolation !== undefined) throw invalid(`The challenge instance is outside the closed contract: ${challengeViolation}.`);
  const derivation = mppBusinessOperationDerivationFailure(input.operation) ?? mppChallengeDerivationFailure(input.challenge);
  if (derivation !== undefined) throw invalid(`The record input is inconsistent: ${derivation}.`);
  const { operation, challenge } = input;
  if (
    challenge.organizationId !== operation.organizationId ||
    challenge.principalId !== operation.principalId ||
    challenge.businessOperationId !== operation.businessOperationId ||
    challenge.businessSemanticDigest !== operation.businessSemanticDigest
  ) {
    throw invalid('The challenge instance does not belong to the business operation it is recorded with.');
  }
  if (operation.organizationId !== organizationId) {
    throw new MppBusinessOperationStoreError('MPP_BUSINESS_OPERATION_TENANT_VIOLATION', 'A business operation for another organization cannot be recorded under this scope.');
  }
}

export type MppRecordPlan =
  | { readonly operation: { readonly kind: 'create' } | { readonly kind: 'existing'; readonly record: MppBusinessOperationRecord }; readonly challenge: { readonly kind: 'existing'; readonly record: MppChallengeInstanceRecord } | { readonly kind: 'append'; readonly sequence: number } };

/** The one write decision, taken inside the critical section over state read and verified there. */
export function planMppRecord(input: RecordMppChallengeInput, existing: MppBusinessOperationState | undefined): MppRecordPlan {
  if (existing === undefined) return { operation: { kind: 'create' }, challenge: { kind: 'append', sequence: 1 } };
  if (existing.operation.businessSemanticDigest !== input.operation.businessSemanticDigest) {
    throw new MppBusinessOperationStoreError(
      'MPP_BUSINESS_OPERATION_CONFLICT',
      `Business operation '${input.operation.businessOperationId}' is already on record with different business semantics; the recorded operation stands.`,
    );
  }
  const same = existing.challenges.find((challenge) => challenge.challengeDigest === input.challenge.challengeDigest);
  if (same !== undefined) return { operation: { kind: 'existing', record: existing.operation }, challenge: { kind: 'existing', record: same } };
  if (existing.challenges.length >= MPP_CHALLENGE_INSTANCES_PER_OPERATION_MAX) {
    throw new MppBusinessOperationStoreError(
      'MPP_BUSINESS_OPERATION_CHALLENGE_HISTORY_FULL',
      `Business operation '${input.operation.businessOperationId}' already holds ${String(MPP_CHALLENGE_INSTANCES_PER_OPERATION_MAX)} challenges; nothing was recorded.`,
    );
  }
  return { operation: { kind: 'existing', record: existing.operation }, challenge: { kind: 'append', sequence: existing.challenges.length + 1 } };
}

/** The latest accepted challenge of a verified state: the highest store-assigned sequence. */
export function latestMppChallenge(state: MppBusinessOperationState): MppChallengeInstanceRecord {
  const latest = state.challenges[state.challenges.length - 1];
  if (latest === undefined) throw corrupt(state.operation.businessOperationId, 'an operation exists with no accepted challenge');
  return latest;
}
