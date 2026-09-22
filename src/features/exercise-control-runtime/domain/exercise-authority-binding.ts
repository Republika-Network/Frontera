import { EXERCISE_CONTROL_REASON_CODES, type ExerciseControlReasonCode } from './exercise-control-reason-codes.js';
import type { ExerciseControlQuery } from './exercise-control-limits.js';
import { isWellFormedExerciseDigest } from './exercise-reservation.js';

/**
 * Exercise-time revalidation of the authority binding a grant was issued
 * under.
 *
 * ## What is compared, and why it is opaque here
 *
 * At issuance the Enterprise composition resolves a `GrantAuthorityBinding` —
 * "which authority world is this action in, and until when?" — twice, and
 * commits the grant only when both answers are identical. The grant then
 * carries `authorityBindingDigest`: a SHA-256 commitment over that binding's
 * canonical serialization. This runtime never learns what a binding *is*. It
 * receives, from a trusted resolver, the canonical digest of the binding that
 * holds **now**, and compares it to the grant's for **exact equality**.
 *
 * Equality, not containment. A different `authorityRef` with the same horizon
 * is a different authority; a shortened horizon that still outlasts the grant
 * is a changed one; a changed justification for a no-window binding is a
 * changed one. Each of them withholds — the same rule the commit-boundary
 * comparison applies at issuance, applied again at the moment of effect.
 *
 * ## What is not claimed
 *
 * The comparison happens immediately before Frontera crosses its execution
 * boundary, and once more after the reservation commits. It is not atomic with
 * the external authority store and not atomic with the provider: a binding can
 * still change after the last check and before or during provider execution.
 * No distributed transaction, no two-phase commit and no linearizability with
 * any external system is implied.
 */
export type ExerciseAuthorityBindingQuery = ExerciseControlQuery;

/**
 * The trusted resolver, as this runtime sees it: the canonical digest of the
 * binding that holds now, or `undefined` when it cannot be established.
 * **Synchronous, read-only.** The Enterprise layer builds this from the host's
 * `ExerciseAuthorityBindingResolver`, validating and digesting the binding it
 * returns; this runtime is never handed the binding itself.
 */
export type ExerciseAuthorityBindingDigestResolver = (query: ExerciseAuthorityBindingQuery) => string | undefined;

export type ExerciseAuthorityBindingVerification = { readonly verified: true } | { readonly verified: false; readonly reasonCode: ExerciseControlReasonCode };

/**
 * Whether the binding holding now is exactly the one the grant was issued
 * under. Total: a missing provenance, a throwing resolver, a non-string or a
 * malformed answer are all `UNVERIFIABLE`; a well-formed different digest is
 * `CHANGED`.
 */
export function verifyExerciseAuthorityBinding(
  recorded: string | undefined,
  resolve: ExerciseAuthorityBindingDigestResolver,
  query: ExerciseAuthorityBindingQuery,
): ExerciseAuthorityBindingVerification {
  const unverifiable = { verified: false, reasonCode: EXERCISE_CONTROL_REASON_CODES.EXERCISE_CONTROL_AUTHORITY_BINDING_UNVERIFIABLE } as const;
  // A grant issued before binding provenance existed cannot be revalidated.
  // That is not the same as "unchanged", and it is refused as such.
  if (!isWellFormedExerciseDigest(recorded)) return unverifiable;
  let current: unknown;
  try {
    current = resolve(query);
  } catch {
    return unverifiable;
  }
  if (!isWellFormedExerciseDigest(current)) return unverifiable;
  return current === recorded ? { verified: true } : { verified: false, reasonCode: EXERCISE_CONTROL_REASON_CODES.EXERCISE_CONTROL_AUTHORITY_BINDING_CHANGED };
}
