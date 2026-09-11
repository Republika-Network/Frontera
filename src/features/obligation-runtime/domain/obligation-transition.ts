import type { ObligationDischargeRecord } from './obligation-discharge.js';
import type { ObligationInstance, ObligationTransition, ObligationTransitionReason } from './obligation-instance.js';
import { isLegalObligationTransition, obligationProgressRank, type ObligationState } from './obligation-state.js';

/**
 * The result of asking an obligation to take one step.
 *
 * Three outcomes rather than two, because "already past it" and "cannot get
 * there" are different facts and an operator needs them apart:
 *
 * - `applied` — the step was legal and was written to the history.
 * - `unchanged` — the obligation is already in that state, or already further
 *   along the progress chain than it. Idempotent: re-delivering the same
 *   discharge observation changes nothing and records nothing, which is what
 *   makes repeated `enforce()` calls safe by construction rather than by a
 *   guard someone has to remember.
 * - `illegal` — the step is not in the transition table from here. **Nothing is
 *   mutated and nothing is repaired.** A terminal obligation is not reopened
 *   and an out-of-order observation does not rewrite history; the obligation is
 *   returned exactly as it was.
 */
export type ObligationTransitionOutcome =
  | { readonly result: 'applied'; readonly instance: ObligationInstance }
  | { readonly result: 'unchanged'; readonly instance: ObligationInstance }
  | { readonly result: 'illegal'; readonly instance: ObligationInstance; readonly from: ObligationState; readonly to: ObligationState };

/**
 * The one function that moves an obligation, and a pure one.
 *
 * It reads no clock (`at` is passed in), no store, no registry and no request.
 * It returns a new instance rather than mutating the one it was given, so a
 * caller that ignores an `illegal` outcome still holds unmodified state.
 *
 * **It takes exactly one step, and never invents the states between two.** An
 * earlier draft searched the transition graph for a path, which would have let
 * a caller ask for a distant state and have the intermediate ones written into
 * the history as though they had been observed. A caller that wants an
 * obligation to advance several steps says so several times, each with its own
 * reason, and each step is legal on its own terms. See
 * `ObligationLifecycleService`, which composes exactly those sequences.
 */
export function transitionObligation(
  instance: ObligationInstance,
  to: ObligationState,
  at: string,
  reason: ObligationTransitionReason,
  discharge?: ObligationDischargeRecord,
): ObligationTransitionOutcome {
  if (instance.state === to) return { result: 'unchanged', instance };

  // A step *backwards* along the progress chain is a step already taken — a
  // re-delivered discharge, or a progress report that arrived after the
  // confirmation it precedes. Idempotent rather than illegal: nothing about the
  // obligation has to change for the observation to be consistent with it.
  const currentRank = obligationProgressRank(instance.state);
  const targetRank = obligationProgressRank(to);
  if (currentRank !== undefined && targetRank !== undefined && targetRank < currentRank) return { result: 'unchanged', instance };

  if (!isLegalObligationTransition(instance.state, to)) return { result: 'illegal', instance, from: instance.state, to };

  const transitions: readonly ObligationTransition[] = [...instance.transitions, { from: instance.state, to, at, reason }];

  return {
    result: 'applied',
    instance: {
      ...instance,
      state: to,
      transitions,
      ...(discharge !== undefined ? { discharge } : {}),
    },
  };
}
