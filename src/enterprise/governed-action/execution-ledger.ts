import type { BoundedGrant } from '../../features/grant-runtime/index.js';
import { GRANT_EXERCISE_REASON_CODE_VALUES, type ExecutionOutcome, type GrantExerciseReasonCode } from '../../features/execution-runtime/index.js';
import type { GovernanceRecord, GovernanceReferenceInput, GovernanceStoreAccessContext } from '../governance-store/contracts.js';
import type { GovernanceStore } from '../governance-store/governance-store.js';
import { authorizationReferenceId, executionAttemptReferenceId, executionOutcomeReferenceId } from './identifiers.js';

/**
 * Evidence writing for a governed action: which authorization artifact a
 * committed decision produced, which execution identity was attempted under
 * it, and what that attempt did.
 *
 * Every row is a Governance Store reference — **evidence, never authority**.
 * The one behavioural use of a row is negative: an existing `attempt` row for
 * an execution identity *prevents* a second adapter invocation. Nothing here
 * can permit one; the exercise gate reads the authoritative bounded-grant
 * store and nothing else.
 *
 * Reference ids are deterministic, and the Store refuses a second append of
 * one id (SQLite: `reference_id PRIMARY KEY`; in-memory: checked inside the
 * synchronous commit section for the evaluation, and every row for one
 * execution id attaches to the one evaluation its decision lives in). That is
 * what makes the `attempt` row a durable at-most-once marker — and no more
 * than that: it is not exactly-once.
 */
export interface PriorExecution {
  readonly attempted: boolean;
  /**
   * `executed` | `withheld` | `execution-failed:<reason>`, as recorded — or the
   * raw recorded string when it cannot be decoded, which no replay maps onto a
   * known outcome. Absent when no outcome row exists.
   */
  readonly outcome?: string;
  /** The exercise assessment's reason codes, exactly as recorded. Present only with `outcome: 'withheld'`. */
  readonly withheldReasonCodes?: readonly GrantExerciseReasonCode[];
}

/**
 * A withheld exercise is recorded as `withheld:<CODE>,<CODE>…` — the
 * assessment's reason codes in the assessment's own (stable) order. The format
 * is deterministic and bounded: at least one code, every code drawn from the
 * closed `GRANT_EXERCISE_REASON_CODES` vocabulary, none repeated, so at most one
 * entry per vocabulary member. Anything else is not encoded and never decoded:
 * a replay reports only reasons that were recorded, and records nothing it
 * could not later read back exactly.
 *
 * The codes explain a refusal. They are evidence of why nothing ran, and they
 * cannot permit anything.
 */
const WITHHELD_PREFIX = 'withheld:';
const EXERCISE_REASON_CODES: ReadonlySet<string> = new Set(GRANT_EXERCISE_REASON_CODE_VALUES);

function isCanonicalWithheldCodes(codes: readonly string[]): codes is readonly GrantExerciseReasonCode[] {
  return codes.length > 0 && codes.length <= EXERCISE_REASON_CODES.size && new Set(codes).size === codes.length && codes.every((code) => EXERCISE_REASON_CODES.has(code));
}

function encodeWithheldOutcome(reasonCodes: readonly string[]): string | undefined {
  return isCanonicalWithheldCodes(reasonCodes) ? `${WITHHELD_PREFIX}${reasonCodes.join(',')}` : undefined;
}

function decodeWithheldOutcome(recorded: string): readonly GrantExerciseReasonCode[] | undefined {
  if (!recorded.startsWith(WITHHELD_PREFIX)) return undefined;
  const codes = recorded.slice(WITHHELD_PREFIX.length).split(',');
  return isCanonicalWithheldCodes(codes) ? Object.freeze([...codes]) : undefined;
}

export type ExecutionClaim = { readonly kind: 'claimed' } | { readonly kind: 'already-claimed'; readonly prior: PriorExecution };

export interface ExecutionLedger {
  /** Append the `authorization_artifact` reference for an issued grant. Idempotent on retry. Throws when it cannot be proven written. */
  recordAuthorization(evaluationId: string, grant: BoundedGrant): Promise<void>;
  /** What the record already says about an execution identity. A pure read of an already-loaded record. */
  prior(record: GovernanceRecord, executionId: string): PriorExecution;
  /** The write-ahead claim, BEFORE the adapter. Throws when the claim cannot be proven either way — the caller must not invoke the adapter. */
  claim(evaluationId: string, executionId: string): Promise<ExecutionClaim>;
  /** Record the outcome. Returns `false` when it could not be written; the outcome itself is never rewritten. */
  recordOutcome(evaluationId: string, executionId: string, outcome: ExecutionOutcome): Promise<boolean>;
}

export function createExecutionLedger(store: GovernanceStore, accessContext: GovernanceStoreAccessContext, now: () => string): ExecutionLedger {
  /**
   * Appends a reference exactly once. A refusal is read back and reported as
   * `existing` only when the row really is there — a lost race for a chain
   * position is not mistaken for success.
   */
  async function appendOnce(reference: GovernanceReferenceInput): Promise<'appended' | 'existing'> {
    try {
      await store.appendReference(accessContext, reference);
      return 'appended';
    } catch (error) {
      const record = await store.getByEvaluationId(accessContext, reference.evaluationId);
      const existing = record?.references.find((entry) => entry.referenceId === reference.referenceId);
      if (existing !== undefined && existing.referenceType === reference.referenceType && existing.externalId === reference.externalId) return 'existing';
      throw error;
    }
  }

  function prior(record: GovernanceRecord, executionId: string): PriorExecution {
    const attempted = record.references.some((entry) => entry.referenceId === executionAttemptReferenceId(executionId) && entry.externalId === executionId);
    const outcome = record.references.find((entry) => entry.referenceId === executionOutcomeReferenceId(executionId) && entry.externalId === executionId);
    const recorded = outcome?.externalVersion;
    if (recorded === undefined) return { attempted };
    const withheldReasonCodes = decodeWithheldOutcome(recorded);
    return withheldReasonCodes === undefined ? { attempted, outcome: recorded } : { attempted, outcome: 'withheld', withheldReasonCodes };
  }

  return {
    async recordAuthorization(evaluationId, grant) {
      await appendOnce({
        referenceId: authorizationReferenceId({ evaluationId, grantId: grant.id }),
        evaluationId,
        referenceType: 'authorization_artifact',
        externalId: grant.id,
        digest: grant.digest,
        createdAt: now(),
      });
    },

    prior,

    async claim(evaluationId, executionId) {
      const written = await appendOnce({
        referenceId: executionAttemptReferenceId(executionId),
        evaluationId,
        referenceType: 'execution_record',
        externalId: executionId,
        externalVersion: 'attempt',
        createdAt: now(),
      });
      if (written === 'appended') return { kind: 'claimed' };
      // Another call claimed it first. Report what it recorded, if anything.
      let latest: GovernanceRecord | null = null;
      try {
        latest = await store.getByEvaluationId(accessContext, evaluationId);
      } catch {
        latest = null;
      }
      return { kind: 'already-claimed', prior: latest === null ? { attempted: true } : prior(latest, executionId) };
    },

    async recordOutcome(evaluationId, executionId, outcome) {
      const recordedAs =
        outcome.status === 'executed' ? 'executed' : outcome.status === 'withheld' ? encodeWithheldOutcome(outcome.assessment.reasonCodes) : `execution-failed:${outcome.reason}`;
      // A withheld assessment whose reasons cannot be recorded exactly is not
      // recorded at all: a replay then reports the attempt as unconfirmed rather
      // than a refusal stripped of its explanation.
      if (recordedAs === undefined) return false;
      try {
        await appendOnce({
          referenceId: executionOutcomeReferenceId(executionId),
          evaluationId,
          referenceType: 'execution_record',
          externalId: executionId,
          externalVersion: recordedAs,
          createdAt: now(),
        });
        return true;
      } catch {
        return false;
      }
    },
  };
}
