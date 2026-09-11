/**
 * The trust classification of a context fact: *who says so*, expressed as a
 * closed vocabulary rather than as a boolean.
 *
 * Decided by `docs/architecture/ADR-CONTEXT-PROVENANCE-AND-TRUST.md` §2. The
 * rejected alternative recorded there is the one worth restating: a single
 * `trusted: true/false` per fact "cannot distinguish a verified attestation
 * from a direct read from a computed aggregate, and gives the wrong answer the
 * first time one is derived from the other."
 */

/**
 * What kind of claim a fact is.
 *
 * ```
 * attested        signed by an issuer this deployment trusts; signature verified here
 * authoritative   read by Frontera directly from a configured system of record
 * derived         computed by Frontera from other facts
 * asserted        supplied by the requester
 * ```
 */
export type ContextTrustClass = 'attested' | 'authoritative' | 'derived' | 'asserted';

/**
 * The three classes that can be *compared*.
 *
 * `derived` is deliberately absent, and its absence is the load-bearing part.
 * A derived fact has no trust of its own: it "inherits the lowest class it
 * derives from", so it always reduces to one of these three before any
 * comparison happens. Making the reduced class a distinct type means a
 * requirement cannot be written against `derived` at all — there is no
 * meaningful answer to "at least as trusted as derived", and the type system
 * refuses the question rather than inventing one.
 */
export type TerminalContextTrustClass = 'attested' | 'authoritative' | 'asserted';

export const CONTEXT_TRUST_CLASSES: readonly ContextTrustClass[] = ['asserted', 'authoritative', 'attested', 'derived'];

export const TERMINAL_CONTEXT_TRUST_CLASSES: readonly TerminalContextTrustClass[] = ['asserted', 'authoritative', 'attested'];

/**
 * The comparison order, and the only one there is.
 *
 * `asserted` sits at the bottom because it is the requester's own claim.
 * `authoritative` and `attested` are both admissible for a decision; `attested`
 * ranks above `authoritative` because a verified signature survives the
 * transport that a direct read does not. Nothing in the platform turns on the
 * gap between those two — a requirement naming either is satisfied by itself or
 * better — but the order has to be total for `minimumContextTrustClass` to be
 * total.
 */
const TERMINAL_RANK: Readonly<Record<TerminalContextTrustClass, number>> = {
  asserted: 0,
  authoritative: 1,
  attested: 2,
};

export function isTerminalContextTrustClass(trustClass: ContextTrustClass): trustClass is TerminalContextTrustClass {
  return trustClass !== 'derived';
}

/**
 * The lowest class among a derived fact's operands — hard invariant 2 of the
 * ADR, and the rule that stops trust laundering: "a spend aggregate computed
 * from one authoritative ledger read and one asserted line item is asserted.
 * Any other rule launders trust."
 *
 * Empty reduces to `asserted`, the lowest class, because a derivation with no
 * operands has demonstrated nothing. That case is separately rejected at
 * validation; the fallback exists so this function is total and so the failure
 * mode, if validation is ever bypassed, is the safe direction.
 */
export function minimumContextTrustClass(classes: readonly TerminalContextTrustClass[]): TerminalContextTrustClass {
  let lowest: TerminalContextTrustClass = 'attested';
  if (classes.length === 0) return 'asserted';
  for (const trustClass of classes) {
    if (TERMINAL_RANK[trustClass] < TERMINAL_RANK[lowest]) lowest = trustClass;
  }
  return lowest;
}

/**
 * Whether a fact's effective class meets a declared minimum.
 *
 * This is the one guarantee the platform makes unconditionally, per ADR §5: "a
 * rule that requires trust class `authoritative` for a key that resolved
 * `asserted` does not match, and no configuration can make it match."
 * No deployment posture, source configuration or declaration relaxes it — the
 * asserted-fact posture governs a *different* question (see
 * `context-requirement.ts`), and it is applied on top of this, never instead
 * of it.
 */
export function contextTrustClassSatisfies(effective: TerminalContextTrustClass, minimum: TerminalContextTrustClass): boolean {
  return TERMINAL_RANK[effective] >= TERMINAL_RANK[minimum];
}
