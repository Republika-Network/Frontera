import type { KernelEvaluationResult } from './kernel-result.js';

/** Mirrors `ExecutionResultStatus` from the wrapped engine. */
export type KernelExecutionStatus = 'not_executed' | 'executed' | 'failed' | 'skipped' | 'duplicate';

/**
 * Which layer withheld an execution that the authorization decision itself did
 * not stop.
 *
 * A closed union of one today, and additive by design: the Grants layer will
 * need its own entry, and a caller programming against `'obligation'` keeps
 * working when it arrives.
 *
 * It exists because `status: 'not_executed'` alone cannot distinguish "policy
 * denied this" from "policy allowed this and a declared condition has not been
 * met". Those are the two readings `ADR-OBLIGATION-DISCHARGE-AND-BOUNDED-GRANT.md`
 * §3 insists must stay apart, and this field is where the second one is said
 * plainly — while `status`/`reasonCodes` continue to report, untouched, what
 * the authority and policy layers actually concluded.
 */
export type KernelExecutionWithholdingLayer = 'obligation';

export interface KernelExecutionOutcome<T = unknown> {
  readonly status: KernelExecutionStatus;
  readonly executed: boolean;
  readonly value?: T;
  readonly errorMessage?: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  /**
   * Present only when the executor was withheld by a layer *below* the
   * decision — never on a denial, and never on a successful execution.
   *
   * `withheldBy: 'obligation'` on a result whose `status` is `'allowed'` is the
   * intended, normal combination: the action was authorized and a blocking
   * obligation is not yet discharged. Read
   * `obligations.exerciseReasonCodes` for which of the five obligation
   * conditions applied.
   */
  readonly withheldBy?: KernelExecutionWithholdingLayer;
}

/**
 * Returned only by `AocKernel.enforce()` -- the higher-level operation that,
 * unlike `evaluate()`, may invoke a caller-supplied adapter as a real side
 * effect. `execution.executed` is `true` only when the evaluation portion
 * (identical in shape/derivation to `KernelEvaluationResult`) resolved to an
 * executable status and the adapter actually ran.
 */
export interface KernelEnforcementResult<T = unknown> extends KernelEvaluationResult {
  readonly execution: KernelExecutionOutcome<T>;
}
