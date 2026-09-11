import type { DisregardedObligationObservation } from './obligation-discharge.js';
import type { ObligationInstance } from './obligation-instance.js';

/**
 * Whether an already-authorized action may currently be exercised.
 *
 * Deliberately a vocabulary of its own — not `allowed`/`denied`, not a policy
 * effect, not a decision status. That separation is the core invariant of this
 * phase: an obligation never changes what the authority and policy layers
 * concluded, and a type that could be mistaken for their conclusion would make
 * violating that a copy-paste away.
 *
 * ```
 * eligible  every blocking obligation this decision declared is satisfied
 * blocked   at least one is not, and the authorization it qualifies is untouched
 * ```
 */
export type ObligationExerciseEligibility = 'eligible' | 'blocked';

/**
 * The complete, bounded answer to "what obligations stand over this
 * authorization, and are they met?".
 *
 * Modelled on `ContextResolution`, in the same position in the pipeline and
 * with the same explicit `resolved` flag rather than an empty set: "the
 * approval system could not be read" and "nobody has approved" must never be
 * the same input to anything.
 */
export interface ObligationResolution {
  /**
   * Whether discharge resolution actually ran to completion.
   *
   * `false` means the provider was consulted and could not answer — it threw,
   * or returned something malformed. It never means "there are no discharges".
   * Every blocking obligation then stays `required` and exercise is `blocked`,
   * which is the fail-closed direction ADR §1 requires.
   */
  readonly resolved: boolean;
  /** Exactly the obligation types the deployment declared, sorted. Nothing was resolved speculatively; nothing else was asked for. */
  readonly declaredTypes: readonly string[];
  /** Stably ordered by obligation type, so the same world produces the same resolution byte for byte. */
  readonly obligations: readonly ObligationInstance[];
  /** Observations that arrived and did not count, with the reason. Reported rather than dropped, so "why is this still blocked" is answerable. */
  readonly disregarded: readonly DisregardedObligationObservation[];
  readonly exerciseEligibility: ObligationExerciseEligibility;
  readonly resolvedAt: string;
}

/**
 * The requester-facing reserved namespace.
 *
 * The same defence `CONTEXT_RESERVED_REQUEST_KEY_PREFIX` performs for resolved
 * facts, performed for obligation state. Every key in a caller's free-form
 * context bag that is `aoc.obligations`, or sits under it, is dropped before
 * the bag travels anywhere, whether or not an obligation capability is
 * configured.
 *
 * Note what this is *not* doing: it is not the only thing standing between a
 * caller and a discharge. Obligation state is never read out of the request bag
 * under any name — the sole producer is the configured discharge provider — so
 * a forged `aoc.obligations` would have had nowhere to be read from even if it
 * survived. The namespace is reserved anyway, for the same reason
 * `organizationId` is: a key that means something internally must not be
 * writable from outside, whether or not a reader exists today.
 */
export const OBLIGATION_RESERVED_REQUEST_KEY_PREFIX = 'aoc.obligations';

export function isReservedObligationKey(key: string): boolean {
  return key === OBLIGATION_RESERVED_REQUEST_KEY_PREFIX || key.startsWith(`${OBLIGATION_RESERVED_REQUEST_KEY_PREFIX}.`);
}

/**
 * What a decision carries when the discharge provider was consulted and could
 * not answer.
 *
 * Distinct from "no capability configured", which produces no resolution object
 * at all and leaves the Kernel result byte-identical to what it was before this
 * layer existed.
 */
export function unresolvedObligationResolution(input: {
  readonly declaredTypes: readonly string[];
  readonly obligations: readonly ObligationInstance[];
  readonly resolvedAt: string;
}): ObligationResolution {
  const blocking = input.obligations.some((obligation) => obligation.blocking);
  return {
    resolved: false,
    declaredTypes: [...input.declaredTypes].sort(),
    obligations: input.obligations,
    disregarded: [],
    exerciseEligibility: blocking ? 'blocked' : 'eligible',
    resolvedAt: input.resolvedAt,
  };
}
