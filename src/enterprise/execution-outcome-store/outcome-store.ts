import type {
  ExecutionAttemptRecord,
  ExecutionOutcomeAccessContext,
  ExecutionOutcomeRecord,
  ExecutionOutcomeStoreHealth,
  ExecutionTerminalRecord,
  PrepareExecutionAttemptInput,
  PrepareExecutionAttemptResult,
  RecordExecutionTerminalInput,
  RecordExecutionTerminalResult,
} from './contracts.js';
import { deepFreeze } from '../governance-store/store-common.js';
import { ExecutionOutcomeStoreError } from './errors.js';
import { executionAttemptRecordFailure, executionTerminalRecordFailure, sameExecutionAttempt, sameExecutionObservation } from './integrity.js';
import { executionAttemptViolation, executionTerminalObservationViolation, isOpaqueExecutionIdentifier } from './validation.js';

/**
 * The read half. Returns a record only after the attempt, and the observation
 * when one exists, verified against each other — never a partial, repaired or
 * best-effort copy. A record that does not verify throws
 * `EXECUTION_OUTCOME_CORRUPT`, which the governed-action replay treats as
 * "attempted, outcome not on record": a corrupted success never replays as one.
 */
export interface ExecutionOutcomeReader {
  read(context: ExecutionOutcomeAccessContext, executionId: string): Promise<ExecutionOutcomeRecord | undefined>;
}

/**
 * The write half — append only. There is no update, no delete, no overwrite, no
 * resolve and no repair, in this port or in any implementation of it.
 *
 * - `prepareAttempt` — the same execution id with the same canonical attempt
 *   returns the one already prepared (`existing`, its first `preparedAt`
 *   intact); with any other attempt it is `EXECUTION_OUTCOME_CONFLICT`.
 * - `recordTerminal` — requires a prepared attempt of the same organization and
 *   inherits its amount and correlation; there is no field to restate either.
 *   The identical observation returns `existing`; any other observation for the
 *   same execution — another certainty, reference, attribution, reason or
 *   instant — is `EXECUTION_OUTCOME_CONFLICT`. One initial observation per
 *   execution, never chosen by timestamp. A later reconciliation is a
 *   different future artifact, not a second observation here.
 */
export interface ExecutionOutcomeWriter {
  prepareAttempt(context: ExecutionOutcomeAccessContext, input: PrepareExecutionAttemptInput): Promise<PrepareExecutionAttemptResult>;
  recordTerminal(context: ExecutionOutcomeAccessContext, input: RecordExecutionTerminalInput): Promise<RecordExecutionTerminalResult>;
}

/**
 * The narrow port the governed-action lifecycle is handed: prepare, record,
 * read. No `health`, no `close`, and nothing that decides.
 */
export interface ExecutionOutcomePort extends ExecutionOutcomeReader, ExecutionOutcomeWriter {}

/**
 * The execution outcome store.
 *
 * ## What an implementation must guarantee
 *
 * 1. **Atomic write decisions.** Each write reads the existing state, decides
 *    and writes in one critical section (SQLite: one `BEGIN IMMEDIATE`
 *    transaction; memory: one synchronous section).
 * 2. **Immutability.** An attempt and an observation, once written, are never
 *    updated or deleted (SQLite: triggers refuse both).
 * 3. **Deterministic identity.** The execution id is the identity of both the
 *    attempt and its one initial observation.
 * 4. **Tenant confinement.** A record belongs to one organization forever; a
 *    call under any other organization reads nothing and writes nothing.
 * 5. **Verify before trusting.** Every read, and every write that finds an
 *    existing row, re-validates and recomputes the digests first.
 * 6. **Fail closed, never repair.** Corruption throws; nothing is skipped,
 *    rewritten or normalized.
 */
export interface ExecutionOutcomeStore extends ExecutionOutcomePort {
  readonly providerKind: 'memory' | 'sqlite';
  health(): Promise<ExecutionOutcomeStoreHealth>;
  close(): Promise<void>;
}

export function requireOutcomeAccessContext(context: ExecutionOutcomeAccessContext): string {
  const organizationId = (context as { readonly organizationId?: unknown } | undefined)?.organizationId;
  const system = (context as { readonly system?: unknown } | undefined)?.system;
  if (!isOpaqueExecutionIdentifier(organizationId) || system !== undefined) {
    throw new ExecutionOutcomeStoreError('EXECUTION_OUTCOME_TENANT_VIOLATION', 'An execution outcome call requires exactly one organization scope.');
  }
  return organizationId;
}

export function requireExecutionId(executionId: string): void {
  if (!isOpaqueExecutionIdentifier(executionId)) throw new ExecutionOutcomeStoreError('EXECUTION_OUTCOME_INPUT_INVALID', 'The execution id is not an opaque identifier.');
}

function corrupt(executionId: string, what: string): ExecutionOutcomeStoreError {
  return new ExecutionOutcomeStoreError('EXECUTION_OUTCOME_CORRUPT', `The persisted outcome for execution '${executionId}' failed verification (${what}). Refused, never repaired.`);
}

function foreign(executionId: string): ExecutionOutcomeStoreError {
  return new ExecutionOutcomeStoreError('EXECUTION_OUTCOME_TENANT_VIOLATION', `The caller is not authorized to access execution '${executionId}'.`);
}

/**
 * The one verification every implementation runs over persisted state, before
 * believing any of it. The organization check comes after integrity: a record
 * that does not verify is corrupt whoever asks, and a verified record of
 * another organization is refused without revealing anything about it.
 */
export function verifyLoadedOutcome(executionId: string, organizationId: string, attempt: ExecutionAttemptRecord | undefined, terminal: ExecutionTerminalRecord | undefined): ExecutionOutcomeRecord | undefined {
  if (attempt === undefined) {
    if (terminal !== undefined) throw corrupt(executionId, 'an observation exists with no attempt');
    return undefined;
  }
  if (attempt.executionId !== executionId) throw corrupt(executionId, 'the attempt is filed under another execution id');
  const attemptFailure = executionAttemptRecordFailure(attempt);
  if (attemptFailure !== undefined) throw corrupt(executionId, attemptFailure);
  if (terminal !== undefined) {
    const terminalFailure = executionTerminalRecordFailure(terminal, attempt);
    if (terminalFailure !== undefined) throw corrupt(executionId, terminalFailure);
  }
  if (attempt.organizationId !== organizationId) throw foreign(executionId);
  // Frozen: nothing a reader holds can reach back into the store.
  return deepFreeze(terminal === undefined ? { attempt } : { attempt, terminal });
}

/** Refuses a malformed preparation before any state is read. */
export function requireValidAttempt(context: ExecutionOutcomeAccessContext, input: PrepareExecutionAttemptInput): void {
  const organizationId = requireOutcomeAccessContext(context);
  const violation = executionAttemptViolation(input);
  if (violation !== undefined) throw new ExecutionOutcomeStoreError('EXECUTION_OUTCOME_INPUT_INVALID', `The execution attempt is outside the closed contract: ${violation}.`);
  if (input.organizationId !== organizationId) throw new ExecutionOutcomeStoreError('EXECUTION_OUTCOME_TENANT_VIOLATION', 'An attempt for another organization cannot be prepared under this scope.');
}

/** Refuses a malformed observation before any state is read. */
export function requireValidTerminal(context: ExecutionOutcomeAccessContext, input: RecordExecutionTerminalInput): void {
  const organizationId = requireOutcomeAccessContext(context);
  if (input === null || typeof input !== 'object') throw new ExecutionOutcomeStoreError('EXECUTION_OUTCOME_INPUT_INVALID', 'The terminal observation input is not an object.');
  const extra = Object.keys(input).find((key) => key !== 'organizationId' && key !== 'executionId' && key !== 'observation');
  // No amount, correlation or attempt field: all of them are inherited from the prepared attempt.
  if (extra !== undefined) throw new ExecutionOutcomeStoreError('EXECUTION_OUTCOME_INPUT_INVALID', `The terminal observation may not carry '${extra}'; amount and correlation are inherited from the attempt.`);
  requireExecutionId(input.executionId);
  const violation = executionTerminalObservationViolation(input.observation);
  if (violation !== undefined) throw new ExecutionOutcomeStoreError('EXECUTION_OUTCOME_INPUT_INVALID', `The terminal observation is outside the closed contract: ${violation}.`);
  if (input.organizationId !== organizationId) throw new ExecutionOutcomeStoreError('EXECUTION_OUTCOME_TENANT_VIOLATION', 'An observation for another organization cannot be recorded under this scope.');
}

export type AttemptPlan = { readonly kind: 'existing'; readonly attempt: ExecutionAttemptRecord } | { readonly kind: 'prepare' };

/** The one preparation decision, taken inside the critical section over state read there. */
export function planExecutionAttempt(input: PrepareExecutionAttemptInput, existing: ExecutionOutcomeRecord | undefined): AttemptPlan {
  if (existing === undefined) return { kind: 'prepare' };
  if (!sameExecutionAttempt(existing.attempt, input)) {
    throw new ExecutionOutcomeStoreError('EXECUTION_OUTCOME_CONFLICT', `Execution '${input.executionId}' is already prepared with a different attempt; the recorded attempt stands.`);
  }
  return { kind: 'existing', attempt: existing.attempt };
}

export type TerminalPlan = { readonly kind: 'existing'; readonly terminal: ExecutionTerminalRecord } | { readonly kind: 'record'; readonly attempt: ExecutionAttemptRecord };

/** The one observation decision, taken inside the critical section over state read there. */
export function planExecutionTerminal(input: RecordExecutionTerminalInput, existing: ExecutionOutcomeRecord | undefined): TerminalPlan {
  if (existing === undefined) {
    throw new ExecutionOutcomeStoreError('EXECUTION_OUTCOME_ATTEMPT_NOT_FOUND', `Execution '${input.executionId}' has no prepared attempt; nothing was recorded.`);
  }
  if (existing.terminal !== undefined) {
    if (!sameExecutionObservation(existing.terminal, input.observation)) {
      throw new ExecutionOutcomeStoreError('EXECUTION_OUTCOME_CONFLICT', `Execution '${input.executionId}' already has a different initial observation; the recorded observation stands.`);
    }
    return { kind: 'existing', terminal: existing.terminal };
  }
  return { kind: 'record', attempt: existing.attempt };
}
