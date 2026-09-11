/**
 * The obligation lifecycle, as a closed set of states and a closed set of legal
 * transitions between them.
 *
 * ## The ADR mapping, recorded here because the count needs reconciling
 *
 * `docs/architecture/ADR-OBLIGATION-DISCHARGE-AND-BOUNDED-GRANT.md` §1 draws
 * the lifecycle as:
 *
 * ```
 * required ──▶ pending ──▶ discharged ──▶ verified
 *    │            │             │
 *    ├──────────▶ waived        └──▶ rejected
 *    └──────────▶ expired
 * ```
 *
 * and describes it, in the same paragraph, as "six states, one closed set, no
 * branching, no parallelism, no assignment".
 * `TARGET_AUTHORITY_CONTROL_ARCHITECTURE.md` §D names six by hand — "`required →
 * pending → discharged → verified`, plus `waived` and `expired`" — and omits
 * `rejected`, which the ADR's own diagram draws.
 *
 * Seven nodes are implemented, not six, and none is collapsed. `rejected` is
 * not a synonym for anything: ADR §2 makes "a discharge that cannot be
 * verified stays `discharged`" — an *unconfirmed* discharge — which leaves no
 * state for the materially different case of a discharge an independent party
 * actively refuted. Dropping `rejected` would silently merge "nobody could
 * confirm it" with "the approver said no", and those are the two readings an
 * auditor most needs kept apart.
 *
 * The two counts are reconciled, rather than one being ignored, like this:
 * `required` is the **declared** state — what Layer B hands to Layer D the
 * moment a policy declares an obligation, before this layer has observed
 * anything at all. The six states this layer itself *manages* are `pending`,
 * `discharged`, `verified`, `rejected`, `waived` and `expired`. Both documents
 * are then true of the same closed set.
 *
 * ## State → terminality → blocking consequence
 *
 * | state | terminal | satisfies a blocking obligation | meaning |
 * | --- | --- | --- | --- |
 * | `required`   | no  | no  | policy declared it; nothing has been observed |
 * | `pending`    | no  | no  | a trusted source reports it has been raised and is outstanding |
 * | `discharged` | no  | **no** | reported discharged by a source this deployment classifies as self-reporting |
 * | `verified`   | yes | yes | confirmed by a source independent of the party that benefits |
 * | `rejected`   | yes | no  | an independent source refuted a reported discharge |
 * | `waived`     | yes | yes | an independent source recorded that the deployment excused it |
 * | `expired`    | yes | no  | the discharge window closed without a valid discharge |
 *
 * `discharged` not satisfying is ADR hard invariant 4 — "a required obligation
 * that is not `verified` blocks issuance" — and hard invariant 5 — "a discharge
 * that cannot be verified is not `verified`". It is the whole difference
 * between "the requester says it obtained finance approval" and "finance says
 * so", which §2 names as the reason the two states exist at all.
 *
 * Nothing in this file, or in this module, decides whether an action is
 * authorized. These states say whether an *already-authorized* action is
 * currently eligible to be exercised, which is a different question with a
 * different answer.
 */

export type ObligationState = 'required' | 'pending' | 'discharged' | 'verified' | 'rejected' | 'waived' | 'expired';

/** Every state, in lifecycle order. Sorted output elsewhere never reorders this: it is the documented reading order, not a comparison. */
export const OBLIGATION_STATES: readonly ObligationState[] = ['required', 'pending', 'discharged', 'verified', 'rejected', 'waived', 'expired'];

/**
 * The states from which no transition is legal.
 *
 * A terminal obligation cannot be reopened, and an observation that would
 * reopen one is rejected as an illegal transition rather than silently applied
 * — "do not silently fix illegal state" is the rule, and a terminal state that
 * can be talked out of being terminal is not one.
 */
export const TERMINAL_OBLIGATION_STATES: readonly ObligationState[] = ['verified', 'rejected', 'waived', 'expired'];

/**
 * The only two states in which a blocking obligation stops blocking.
 *
 * `verified` is ADR hard invariant 4. `waived` joins it because a waiver that
 * still blocked would be a state with no consequence — and because a waiver is
 * reachable only from a source this deployment configured as independent (see
 * `obligation-source.ts`), so it is the deployment excusing the obligation, never
 * the beneficiary excusing itself.
 */
export const SATISFYING_OBLIGATION_STATES: readonly ObligationState[] = ['verified', 'waived'];

/**
 * The complete transition table. A transition absent from here is illegal, and
 * illegality is reported rather than repaired.
 *
 * Six of the seven edges are drawn in the ADR diagram verbatim. The seventh —
 * `pending → expired` — is not drawn there, and is the one deliberate,
 * documented extension this phase makes: ADR §6 rules that "expiry is a state,
 * not a background job … derived from the clock at read time", and an
 * obligation cannot be made exempt from its own discharge window merely by
 * having been reported outstanding first. It moves an obligation into a
 * terminal, *blocking* state, so the extension can only ever withhold exercise,
 * never permit it. It is recorded in `README.md` under "Divergence from the
 * ADR" rather than left to be discovered here.
 */
export const OBLIGATION_STATE_TRANSITIONS: Readonly<Record<ObligationState, readonly ObligationState[]>> = {
  required: ['pending', 'waived', 'expired'],
  pending: ['discharged', 'waived', 'expired'],
  discharged: ['verified', 'rejected'],
  verified: [],
  rejected: [],
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
 * Total over the closed set, and fail-closed by construction: a state that is
 * ever added without being listed in `SATISFYING_OBLIGATION_STATES` blocks,
 * which is the safe direction.
 */
export function obligationStateSatisfies(state: ObligationState): boolean {
  return SATISFYING_OBLIGATION_STATES.includes(state);
}

export function isLegalObligationTransition(from: ObligationState, to: ObligationState): boolean {
  return OBLIGATION_STATE_TRANSITIONS[from].includes(to);
}

/**
 * The monotone progress chain: the one ordered spine the lifecycle advances
 * along, from declared to independently confirmed.
 *
 * `waived`, `rejected` and `expired` are deliberately absent. They are exits
 * from the chain, not positions on it, and giving them a rank would imply an
 * ordering between "excused" and "refuted" that does not exist.
 */
export const OBLIGATION_PROGRESS_CHAIN: readonly ObligationState[] = ['required', 'pending', 'discharged', 'verified'];

/**
 * How far along the progress chain a state sits, or `undefined` for a state
 * that is not on it.
 *
 * Used for exactly one thing: deciding that a step which would move an
 * obligation *backwards* along the chain has already been taken, so
 * re-delivering the same discharge is idempotent rather than an error. A step
 * that is not simply backwards is put to `isLegalObligationTransition`, which
 * refuses it.
 */
export function obligationProgressRank(state: ObligationState): number | undefined {
  const index = OBLIGATION_PROGRESS_CHAIN.indexOf(state);
  return index === -1 ? undefined : index;
}
