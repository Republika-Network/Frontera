import type { ObligationCorrelation } from './obligation-correlation.js';
import { obligationInstanceId } from './obligation-correlation.js';
import type { ObligationDischargeRecord, ObligationVerificationRecord } from './obligation-discharge.js';
import type { ObligationType } from './obligation-requirement.js';
import { isTerminalObligationState, obligationStateSatisfies, type ObligationState } from './obligation-state.js';

/**
 * Why the lifecycle moved. A closed vocabulary, so the history a reviewer reads
 * is a record of causes rather than a list of state names.
 *
 * One reason per legal transition, and every one of the five is emitted:
 * `activated` for `required → pending`, `discharge_reported` for
 * `pending → discharged`, `discharge_confirmed` for `discharged → verified`,
 * `waiver_recorded` for either edge into `waived`, and `deadline_passed` for
 * any edge into `expired`.
 *
 * There is no reason for a refused verification, because a refused
 * verification causes no transition — ADR §2.
 */
export type ObligationTransitionReason = 'activated' | 'discharge_reported' | 'discharge_confirmed' | 'waiver_recorded' | 'deadline_passed';

/** One step of the closed lifecycle, written as it is taken. `from === to` never appears: an idempotent re-application records nothing. */
export interface ObligationTransition {
  readonly from: ObligationState;
  readonly to: ObligationState;
  readonly at: string;
  readonly reason: ObligationTransitionReason;
}

/**
 * One declared obligation, with everything needed to reconstruct how it reached
 * the state it is in.
 *
 * **There is no authorization field on this shape, and its absence is the
 * point.** No `allowed`, no `denied`, no decision status, no policy effect, no
 * severity. An obligation instance cannot carry an authorization outcome, so no
 * code path can read one off it, and
 * `tests/obligation-layer-boundaries.test.ts` fails the build if one ever
 * appears. What an obligation says is whether an already-authorized action is
 * currently eligible to be exercised — never whether it was authorized.
 */
export interface ObligationInstance {
  /** Deterministic, derived from the correlation and the type. Stable across evaluations of the same request. */
  readonly id: string;
  readonly obligationType: ObligationType;
  readonly blocking: boolean;
  readonly correlation: ObligationCorrelation;
  readonly state: ObligationState;
  /** The instant the declaration was read. Passed in, never taken from a clock this layer owns. */
  readonly declaredAt: string;
  /** Every step taken, in order. `[]` for an obligation nothing has been observed about. */
  readonly transitions: readonly ObligationTransition[];
  /** The discharge the obligation came to rest on, when one applied. Absent for an obligation still in `required`. */
  readonly discharge?: ObligationDischargeRecord;
  /**
   * The most recent verification attempt that did not succeed, when one was
   * made.
   *
   * The audit half of ADR §2. Its presence never changes the state and never
   * changes satisfaction: an obligation carrying one is `discharged`, which is
   * unsatisfied, exactly as it would be with no attempt recorded at all. What
   * it adds is the answer to "somebody looked at this — what did they find?".
   */
  readonly verification?: ObligationVerificationRecord;
  /** The deadline this obligation was declared with, when it was declared with one. Copied from the requirement; never requester-supplied. */
  readonly expiresAt?: string;
}

/** The declared, untouched starting point: what Layer B hands to Layer D before anything has been observed. */
export function declareObligation(input: {
  readonly obligationType: ObligationType;
  readonly blocking: boolean;
  readonly correlation: ObligationCorrelation;
  readonly declaredAt: string;
  readonly expiresAt?: string;
}): ObligationInstance {
  return {
    id: obligationInstanceId(input.correlation, input.obligationType),
    obligationType: input.obligationType,
    blocking: input.blocking,
    correlation: input.correlation,
    state: 'required',
    declaredAt: input.declaredAt,
    transitions: [],
    ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
  };
}

/**
 * Whether this obligation currently withholds exercise.
 *
 * A non-blocking obligation never withholds, whatever state it is in. A
 * blocking one withholds unless it is `verified` or `waived` *and* no
 * admissible observation contradicted another.
 */
export function obligationWithholdsExercise(instance: ObligationInstance): boolean {
  if (!instance.blocking) return false;
  return !obligationStateSatisfies(instance.state);
}

/** Whether this obligation's condition is met, independent of whether it blocks. Reported so a non-blocking obligation's state is still legible. */
export function obligationIsSatisfied(instance: ObligationInstance): boolean {
  return obligationStateSatisfies(instance.state);
}

export function obligationIsTerminal(instance: ObligationInstance): boolean {
  return isTerminalObligationState(instance.state);
}
