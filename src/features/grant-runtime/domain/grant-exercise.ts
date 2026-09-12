import { boundedGrantDigestMatches, type BoundedGrant } from './bounded-grant.js';
import { GRANT_REASON_CODES, type GrantReasonCode } from './grant-reason-codes.js';
import type { GrantRevocation } from './grant-revocation.js';

/**
 * Whether an issued grant may be exercised *right now*.
 *
 * Three ways it may not, and all three are derived at read time:
 *
 * | state | derived from |
 * | --- | --- |
 * | `expired` | the passed-in instant against `expiresAt` |
 * | `revoked` | a revocation held beside the grant |
 * | `tampered` | the grant's own digest against its fields |
 *
 * `ADR-OBLIGATION-DISCHARGE-AND-BOUNDED-GRANT.md` §6: "A grant past its own
 * `expiresAt` is expired **when read**, deterministically, from the clock —
 * never 'when a sweeper gets to it'. A sweeper may exist for provider
 * enforcement and for housekeeping, and it is an optimization: correctness
 * never depends on it having run." Hard invariant 7 says the same. There is
 * therefore no sweeper in this module, no timer, no scheduled job, and nothing
 * that has to have run for an expired grant to read as expired.
 *
 * The instant is **passed in**, never read from an ambient clock. No
 * `Date.now()` appears in this layer's domain logic, and
 * `tests/grant-layer-boundaries.test.ts` fails the build if one does — the same
 * rule `isObligationExpiredAt` follows one layer down, and for the same reason:
 * a hidden clock makes a lifecycle untestable and a replay non-deterministic.
 *
 * ## Order
 *
 * Tamper first, then revocation, then expiry, and every failing reason is
 * reported rather than only the first. A revoked grant that is also expired is
 * both, and an operator asking "why can this not be used" deserves both
 * answers.
 */
export type GrantExerciseEligibility = 'exercisable' | 'unusable';

export interface GrantExerciseAssessment {
  readonly eligibility: GrantExerciseEligibility;
  readonly reasonCodes: readonly GrantReasonCode[];
}

/**
 * Total over every input, including a malformed `expiresAt`.
 *
 * An unparseable instant on either side makes the grant **unusable**, not
 * usable-forever. This is the opposite of `isObligationExpiredAt`'s treatment
 * of a malformed deadline, and deliberately so: there, a malformed deadline
 * leaves a *blocking* obligation blocking, which is the closed direction; here,
 * a malformed horizon on a *permission* must not read as no horizon at all.
 * Both choices are the fail-closed one for what they govern.
 */
export function assessGrantExercise(input: {
  readonly grant: BoundedGrant;
  readonly revocation?: GrantRevocation;
  readonly at: string;
}): GrantExerciseAssessment {
  const reasonCodes: GrantReasonCode[] = [];

  if (!boundedGrantDigestMatches(input.grant)) reasonCodes.push(GRANT_REASON_CODES.GRANT_CORRELATION_INVALID);
  if (input.revocation !== undefined) reasonCodes.push(GRANT_REASON_CODES.GRANT_REVOKED);

  const expiry = Date.parse(input.grant.expiresAt);
  const now = Date.parse(input.at);
  if (Number.isNaN(expiry) || Number.isNaN(now) || now >= expiry) reasonCodes.push(GRANT_REASON_CODES.GRANT_EXPIRED);

  return reasonCodes.length === 0 ? { eligibility: 'exercisable', reasonCodes: [] } : { eligibility: 'unusable', reasonCodes };
}
