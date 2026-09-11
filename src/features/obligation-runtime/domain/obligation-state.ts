/**
 * The obligation lifecycle: six states, eight legal transitions, and nothing
 * else.
 *
 * Normative source: `docs/architecture/ADR-OBLIGATION-DISCHARGE-AND-BOUNDED-GRANT.md`
 * §1, which states the state set and the transition graph as two tables. This
 * file is those tables, transcribed.
 *
 * The ADR states them as tables rather than as a drawing for a measured reason,
 * recorded there and worth repeating here: an earlier revision drew the
 * lifecycle as ASCII art carrying a seventh node, `rejected`, that no prose in
 * any architecture document ever defined, and an earlier revision of *this
 * file* implemented that drawing — arriving at seven states, an invented
 * distinction between an unverifiable discharge and a refuted one, and a
 * transition the drawing did not contain. Both are gone. There is no seventh
 * state and no replacement for one.
 *
 * ## State → terminality → satisfaction
 *
 * | state | meaning | terminal | satisfies a blocking obligation |
 * | --- | --- | --- | --- |
 * | `required`   | declared as a consequence or condition of an authorization | no | **no** |
 * | `pending`    | active, awaiting valid discharge | no | **no** |
 * | `discharged` | a discharge was supplied and has not been successfully verified | no | **no** |
 * | `verified`   | the discharge was validly verified | yes | yes |
 * | `waived`     | an authorized waiver validly removed the requirement | yes | yes |
 * | `expired`    | the declared deadline passed before a satisfying terminal state | yes | **no** |
 *
 * Terminality and satisfaction are different properties. `expired` is terminal
 * and unsatisfying — the condition can no longer be met, and it was not met —
 * which is the combination a deployment has to be able to see.
 *
 * `discharged` not satisfying is ADR §2 and the whole point of the layer: "the
 * requester says it obtained finance approval" is not "finance says so".
 *
 * ## `required` belongs to this layer
 *
 * `required` is a real state of this lifecycle, and it is the state every
 * obligation instance begins in. Layer B *declares* that an obligation is
 * required; layer D materializes the instance in `required` and manages it from
 * there, activating it into `pending` and onward. ADR §1 says so explicitly,
 * and says so because an earlier revision of this module claimed the opposite
 * in order to reconcile a seven-node drawing with six-state prose.
 *
 * ## There is no state for a failed verification
 *
 * A verification attempt that does not succeed leaves the obligation
 * `discharged` and records why. ADR §2. Nothing in this file expresses a
 * refutation, because a refuted discharge and an unconfirmed one have the same
 * consequence — unsatisfied, exercise withheld — and a state whose consequence
 * duplicates an existing state's is a field on a record, not a state.
 */

export type ObligationState = 'required' | 'pending' | 'discharged' | 'verified' | 'waived' | 'expired';

/** Every state, in lifecycle order. The documented reading order, not a comparison. */
export const OBLIGATION_STATES: readonly ObligationState[] = ['required', 'pending', 'discharged', 'verified', 'waived', 'expired'];

/**
 * The states from which no transition is legal.
 *
 * A terminal obligation cannot be reopened, and an observation that would
 * reopen one is refused as an illegal transition rather than silently applied —
 * a terminal state that can be talked out of being terminal is not one.
 */
export const TERMINAL_OBLIGATION_STATES: readonly ObligationState[] = ['verified', 'waived', 'expired'];

/**
 * The only two states in which a blocking obligation stops blocking.
 *
 * ADR §1's satisfaction column, and ADR hard invariant 4: "a required
 * obligation that is not satisfied — in any state other than `verified` or
 * `waived` — blocks issuance, never the decision."
 */
export const SATISFYING_OBLIGATION_STATES: readonly ObligationState[] = ['verified', 'waived'];

/**
 * The complete transition table — ADR §1's second table, verbatim.
 *
 * Eight edges. A transition absent from here is illegal, and illegality is
 * reported rather than repaired.
 */
export const OBLIGATION_STATE_TRANSITIONS: Readonly<Record<ObligationState, readonly ObligationState[]>> = {
  required: ['pending', 'waived', 'expired'],
  pending: ['discharged', 'waived', 'expired'],
  discharged: ['verified', 'expired'],
  verified: [],
  waived: [],
  expired: [],
};

export function isTerminalObligationState(state: ObligationState): boolean {
  return TERMINAL_OBLIGATION_STATES.includes(state);
}

/**
 * Whether an obligation in this state stops a blocking obligation from
 * withholding exercise.
 *
 * Total over the closed set, and fail-closed by construction: a state ever
 * added without being listed in `SATISFYING_OBLIGATION_STATES` blocks, which is
 * the safe direction.
 */
export function obligationStateSatisfies(state: ObligationState): boolean {
  return SATISFYING_OBLIGATION_STATES.includes(state);
}

export function isLegalObligationTransition(from: ObligationState, to: ObligationState): boolean {
  return OBLIGATION_STATE_TRANSITIONS[from].includes(to);
}

/**
 * The monotone progress chain: the one ordered spine the lifecycle advances
 * along, from declared to independently verified.
 *
 * `waived` and `expired` are deliberately absent. They are exits from the
 * chain, not positions on it, and giving them a rank would imply an ordering
 * between "excused" and "out of time" that does not exist.
 */
export const OBLIGATION_PROGRESS_CHAIN: readonly ObligationState[] = ['required', 'pending', 'discharged', 'verified'];

/**
 * How far along the progress chain a state sits, or `undefined` for a state
 * that is not on it.
 *
 * Used for exactly one thing: recognizing that a step which would move an
 * obligation *backwards* along the chain has already been taken, so
 * re-delivering the same discharge is idempotent rather than an error. Any
 * other step is put to `isLegalObligationTransition`, which refuses it.
 */
export function obligationProgressRank(state: ObligationState): number | undefined {
  const index = OBLIGATION_PROGRESS_CHAIN.indexOf(state);
  return index === -1 ? undefined : index;
}

/**
 * Whether an obligation's declared deadline has passed at `at` — ADR §6.
 *
 * Total: an unparseable instant is *not* expired, because expiry is a
 * consequence a deployment declared and a malformed timestamp is a
 * configuration fault, not a deadline. The obligation stays where it is, which
 * for a blocking one means it keeps blocking.
 */
export function isObligationExpiredAt(expiresAt: string, at: string): boolean {
  const deadline = Date.parse(expiresAt);
  const now = Date.parse(at);
  if (Number.isNaN(deadline) || Number.isNaN(now)) return false;
  return now >= deadline;
}
