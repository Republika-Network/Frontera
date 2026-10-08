import type { ExecutionResolutionAuthority, ExecutionResolutionAuthoritySelector } from './authority.js';

/**
 * PROD-03-02 — operator attestation: an authorized human operator as the
 * trusted resolution authority of an uncertain execution.
 *
 * P12 already states that a resolution authority is "trusted host / operator
 * integration". This is the operator half, composed by the Enterprise Host
 * when it serves an operator plane. It changes nothing about P12's rules:
 *
 * - **Bound before the claim**, like every authority: the Host's selector
 *   names it for every new governed execution, so the binding says, durably,
 *   that this execution's uncertainty may later be closed by an operator's
 *   attestation and by nothing else. An execution claimed before it was
 *   composed has no binding and is *adopted* to it (`origin: 'adopted'`) —
 *   adoption binds, it never declares an outcome.
 * - **It never answers on its own.** `resolve()` is `unresolved`, always: an
 *   explicit `reconcile()` writes nothing and releases nothing. Time is never
 *   evidence, and neither is configuration.
 * - **The answer is the operator's**, recorded through
 *   `ExecutionReconciliationService.recordOperatorResolution`, which runs the
 *   same eligibility, the same append-only store decision and the same P7 /
 *   evidence completion as `reconcile()`, and records **who** attested it
 *   (`attestedBy`, from the authenticated operator principal) inside the
 *   resolution's own digest.
 * - **It never executes.** Like every authority it has no adapter, no exercise
 *   gate and no grant writer. Recording that an effect completed or did not
 *   complete does not make it happen, happen again or stop happening.
 */

/** The authority id an operator-attested resolution is bound to and recorded under. Recordable and stable: it is part of every binding and resolution digest. */
export const OPERATOR_ATTESTATION_AUTHORITY_ID = 'frontera.operator-attestation';

/** The authority itself: present so the binding has an authority to name; asked automatically, it never resolves anything. */
export function createOperatorAttestationAuthority(): ExecutionResolutionAuthority {
  return Object.freeze({
    authorityId: OPERATOR_ATTESTATION_AUTHORITY_ID,
    // An operator's attestation arrives through the operator plane, never as the answer to a query.
    resolve: async () => Object.freeze({ outcome: 'unresolved' as const }),
  });
}

/** The Host's selector: every governed execution is bound to operator attestation. */
export const selectOperatorAttestation: ExecutionResolutionAuthoritySelector = () => OPERATOR_ATTESTATION_AUTHORITY_ID;
