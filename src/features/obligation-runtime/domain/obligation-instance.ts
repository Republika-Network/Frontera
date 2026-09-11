import type { ObligationCorrelation } from './obligation-correlation.js';
import { obligationInstanceId } from './obligation-correlation.js';
import type { ObligationDischargeRecord } from './obligation-discharge.js';
import type { ObligationType } from './obligation-requirement.js';
import { isTerminalObligationState, obligationStateSatisfies, type ObligationState } from './obligation-state.js';

/**
 * Why the lifecycle moved. A closed vocabulary, so the history a reviewer reads
 * is a record of causes rather than a list of state names.
 */
export type ObligationTransitionReason = 'declared' | 'discharge_reported' | 'discharge_confirmed' | 'discharge_refused' | 'waiver_recorded' | 'discharge_window_closed';

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
  /** When the discharge stops being good, for a requirement that declared a window and an obligation that has a discharge. */
  readonly dischargeExpiresAt?: string;
  /**
   * Whether admissible observations contradicted one another.
   *
   * Two registered sources reporting a discharge and a refusal of the same
   * obligation is a fact about the world, not a tie to be broken silently — the
   * rule `ContextResolution.conflicted` already establishes for two systems of
   * record disagreeing. A conflicted blocking obligation is never satisfied,
   * whatever state the transitions left it in, so the disagreement withholds
   * exercise rather than being resolved in someone's favour.
   */
  readonly conflicted?: boolean;
}

/** The declared, untouched starting point: what Layer B hands to Layer D before anything has been observed. */
export function declareObligation(input: {
  readonly obligationType: ObligationType;
  readonly blocking: boolean;
  readonly correlation: ObligationCorrelation;
  readonly declaredAt: string;
}): ObligationInstance {
  return {
    id: obligationInstanceId(input.correlation, input.obligationType),
    obligationType: input.obligationType,
    blocking: input.blocking,
    correlation: input.correlation,
    state: 'required',
    declaredAt: input.declaredAt,
    transitions: [],
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
  if (instance.conflicted === true) return true;
  return !obligationStateSatisfies(instance.state);
}

/** Whether this obligation's condition is met, independent of whether it blocks. Reported so a non-blocking obligation's state is still legible. */
export function obligationIsSatisfied(instance: ObligationInstance): boolean {
  return instance.conflicted !== true && obligationStateSatisfies(instance.state);
}

export function obligationIsTerminal(instance: ObligationInstance): boolean {
  return isTerminalObligationState(instance.state);
}
