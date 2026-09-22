import { createHash } from 'node:crypto';

import type { GrantValidityCeiling } from '../../features/grant-runtime/index.js';

/**
 * Which world a composition root is in when it issues a bounded grant.
 *
 * ## The hazard this closes
 *
 * `GrantSourceAuthorization.validityCeilings` permits `[]`, and that is correct
 * — `ADR-OBLIGATION-DISCHARGE-AND-BOUNDED-GRANT.md` §4 rule 4 measured that no
 * decision record in this repository carries a validity window, so on the
 * generic Kernel path there is frequently nothing to contain against and none
 * is invented.
 *
 * But an empty list cannot distinguish two very different facts:
 *
 * ```
 * A.  no upstream authority validity window applies to this action
 * B.  a mandate governs this action and the host forgot to pass its expiry
 * ```
 *
 * In case B an empty list silently issues a grant that may outlive the
 * authority justifying it — a breach of ADR hard invariant 10 that nothing
 * would report, because "no ceiling" and "ceiling not supplied" look identical
 * at the point of use. That is a *wiring* hazard rather than a layer E defect,
 * so it is closed here, at the composition boundary, and layer E's generic
 * semantics are left exactly as they are.
 *
 * ## How it is closed
 *
 * By making the composition root state which world it is in, in a type that has
 * no third option and no default. There is no optional `expiresAt`, no
 * `undefined` that could mean either thing, and no way to spell case B's
 * mistake: `bounded-authority` without an `expiresAt` does not compile, and
 * `no-temporal-authority-bound` costs an explicit `sourceKind` and an explicit
 * `justification`, so it cannot be arrived at by omission.
 *
 * This is the same discipline `scopeLimit` and the grant declaration already
 * follow — "the permissive case must cost an explicit word" — applied to the
 * one value whose absence is indistinguishable from its non-existence.
 */
export type GrantAuthorityBinding =
  | {
      /** A mandate, representative authority or other governed authorization artifact with a finite validity window governs this action. */
      readonly kind: 'bounded-authority';
      /** Which kind of artifact. Closed, so "what bounded this?" is answerable from the binding alone. */
      readonly authorityKind: GrantBoundedAuthorityKind;
      /** The artifact's identity, carried into evidence correlation. */
      readonly authorityRef: string;
      /**
       * The artifact's own `expiresAt`.
       *
       * Required, and required to be a real instant: this is the value ADR hard
       * invariant 10 turns on, and a binding that cannot state it is not a
       * bounded-authority binding.
       */
      readonly expiresAt: string;
    }
  | {
      /**
       * No upstream authority validity window applies — the honest case A.
       *
       * It is not "we did not look". `sourceKind` says what kind of authority
       * the action stands on, and `justification` is a free-text record of why
       * that kind carries no window, both of which an operator can be held to.
       */
      readonly kind: 'no-temporal-authority-bound';
      readonly sourceKind: GrantUnboundedAuthoritySourceKind;
      readonly justification: string;
    };

/** The governed artifacts that carry a finite validity window today. Closed; extending it is a deliberate change, not a string a caller invents. */
export const GRANT_BOUNDED_AUTHORITY_KINDS = ['mandate', 'representative-authority', 'governed-authorization-artifact', 'reservation'] as const;

export type GrantBoundedAuthorityKind = (typeof GRANT_BOUNDED_AUTHORITY_KINDS)[number];

/**
 * The authority shapes that genuinely carry no temporal window.
 *
 * `standing-capability` is a recognition/capability-token authority resolved
 * per evaluation; `organizational-authority` is the durable Kernel Authority
 * Store's organization scoping; `none-applicable` is the generic Kernel path,
 * where the decision itself is the only thing upstream and no decision record
 * carries a horizon.
 */
export const GRANT_UNBOUNDED_AUTHORITY_SOURCE_KINDS = ['standing-capability', 'organizational-authority', 'none-applicable'] as const;

export type GrantUnboundedAuthoritySourceKind = (typeof GRANT_UNBOUNDED_AUTHORITY_SOURCE_KINDS)[number];

/**
 * Whether a binding states enough to be believed.
 *
 * Total and fail-closed on both arms. A `bounded-authority` binding whose
 * `expiresAt` is unparseable is *worse* than no binding — it is a cap that
 * silently stopped capping — so it is refused rather than dropped, which is the
 * same treatment `resolveGrantValidity` gives an unparseable ceiling.
 */
export function isWellFormedGrantAuthorityBinding(binding: GrantAuthorityBinding): boolean {
  if (binding.kind === 'bounded-authority') {
    return (
      GRANT_BOUNDED_AUTHORITY_KINDS.includes(binding.authorityKind) &&
      binding.authorityRef.length > 0 &&
      binding.expiresAt.length > 0 &&
      !Number.isNaN(Date.parse(binding.expiresAt))
    );
  }
  return GRANT_UNBOUNDED_AUTHORITY_SOURCE_KINDS.includes(binding.sourceKind) && binding.justification.trim().length > 0;
}

/**
 * The validity ceilings a binding contributes to issuance.
 *
 * One `authority` ceiling for the bounded arm, none for the other — which is
 * how ADR §4 rule 3 ("contained by every applicable upstream ceiling that
 * exists") and rule 4 ("no upstream bound is invented where none exists") both
 * hold at the same call site, with the choice between them made explicitly
 * rather than by the shape of an array.
 *
 * Callers must reject a malformed binding before calling this; it returns no
 * ceiling for one, and silently returning none for a binding that claimed to
 * carry one is exactly the failure this module exists to prevent.
 */
export function grantValidityCeilingsFor(binding: GrantAuthorityBinding): readonly GrantValidityCeiling[] {
  if (binding.kind === 'bounded-authority' && isWellFormedGrantAuthorityBinding(binding)) {
    return [{ source: 'authority', notAfter: binding.expiresAt }];
  }
  return [];
}

/** The canonical-serialization format of an authority binding. Bumped only if the bytes below ever change; a digest taken under another value is not comparable. */
export const GRANT_AUTHORITY_BINDING_FORMAT = 'aoc.grant-authority-binding.v1';

/**
 * The canonical serialization of an authority binding: every field that gives
 * the binding its meaning, in fixed lexicographic key order, no whitespace, no
 * ambient `JSON.stringify` key ordering, and the format tag in the bytes so a
 * digest can never be confused with one taken over a different encoding.
 *
 * ```
 * bounded-authority            authorityKind, authorityRef, expiresAt, kind
 * no-temporal-authority-bound  justification, kind, sourceKind
 * ```
 *
 * Exactly the fields `grantAuthorityBindingsMatch` compares at the issuance
 * commit boundary, so "the same binding" means the same thing at issuance and
 * at exercise.
 */
export function serializeGrantAuthorityBinding(binding: GrantAuthorityBinding): string {
  if (binding.kind === 'bounded-authority') {
    return `{"authorityKind":${JSON.stringify(binding.authorityKind)},"authorityRef":${JSON.stringify(binding.authorityRef)},"expiresAt":${JSON.stringify(binding.expiresAt)},"format":${JSON.stringify(GRANT_AUTHORITY_BINDING_FORMAT)},"kind":"bounded-authority"}`;
  }
  return `{"format":${JSON.stringify(GRANT_AUTHORITY_BINDING_FORMAT)},"justification":${JSON.stringify(binding.justification)},"kind":"no-temporal-authority-bound","sourceKind":${JSON.stringify(binding.sourceKind)}}`;
}

/**
 * `sha256:<hex>` over `serializeGrantAuthorityBinding` — the provenance
 * commitment recorded on a bounded grant as `authorityBindingDigest`, and the
 * value exercise-time revalidation compares for exact equality.
 *
 * Integrity, not authenticity: unkeyed, like every other digest in this
 * repository. It proves "this is the binding the grant was issued under", not
 * who asserted it.
 */
export function grantAuthorityBindingDigest(binding: GrantAuthorityBinding): string {
  return `sha256:${createHash('sha256').update(serializeGrantAuthorityBinding(binding)).digest('hex')}`;
}
