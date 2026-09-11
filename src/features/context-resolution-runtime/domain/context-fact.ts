import type { ContextDerivationOperator } from './context-derivation.js';
import type { ContextSourceKind } from './context-source.js';
import type { ContextTrustClass, TerminalContextTrustClass } from './context-trust.js';

/**
 * What a fact's value may be.
 *
 * Closed on purpose. A context fact is read by a comparison — equals, in,
 * less-than — and every one of those is total over these three types. Admitting
 * arbitrary objects would make canonical ordering, equality and serialization
 * open questions in a layer whose whole value is that it is deterministic.
 */
export type ContextFactValue = string | number | boolean;

/**
 * How a key resolved.
 *
 * `unresolved` is a first-class member of this vocabulary and is emphatically
 * not an absence — ADR §5: "a resolver that cannot answer reports `unresolved`.
 * It does not report absence, and it never substitutes a default." `stale` and
 * `conflicted` are likewise distinct: "two sources disagreeing is a fact about
 * the world, not a tie to be broken silently."
 */
export type ContextFactResolution = 'resolved' | 'unresolved' | 'stale' | 'conflicted';

/**
 * The resolutions a *fact* may carry.
 *
 * `unresolved` is excluded structurally, and that is the point. An unresolved
 * key has no source and no observation time, so a `ContextFact` for it would
 * violate hard invariant 1 the moment it existed. Unresolved keys are carried
 * on `ContextResolution.unresolved` as keys — reported, never absent, and never
 * wearing the shape of an answer.
 */
export type ResolvedContextFactStatus = 'resolved' | 'stale' | 'conflicted';

export interface ContextFactFreshness {
  readonly maxAgeSeconds: number;
  /** `observedAt + maxAgeSeconds`, precomputed so a reader never re-derives it and never needs a clock of its own. */
  readonly staleAt: string;
}

/** How a derived fact was computed, carried so an auditor can see the arithmetic rather than infer it. */
export interface ContextFactDerivation {
  readonly operator: ContextDerivationOperator;
  readonly operandKeys: readonly string[];
}

/**
 * One resolved value together with its origin. *A value without an origin is
 * not a fact* — ADR §1 — and there is deliberately no shape in this layer that
 * carries a value alone.
 */
export interface ContextFact {
  readonly key: string;
  readonly value: ContextFactValue;
  readonly sourceId: string;
  readonly sourceKind: ContextSourceKind;
  readonly observedAt: string;
  /** The declared label, including `derived`. */
  readonly trustClass: ContextTrustClass;
  /**
   * The class this fact is actually compared at: itself for the three terminal
   * classes, and the minimum of the operands' effective classes for a `derived`
   * one. Precomputed here rather than re-derived at each read so that the
   * inheritance rule is applied in exactly one place.
   */
  readonly effectiveTrustClass: TerminalContextTrustClass;
  readonly resolution: ResolvedContextFactStatus;
  readonly freshness?: ContextFactFreshness;
  /** Present only when `trustClass === 'attested'`. Opaque to this layer. */
  readonly attestationRef?: string;
  /** Present only when `trustClass === 'derived'`. */
  readonly derivation?: ContextFactDerivation;
  /** Present only when `resolution === 'conflicted'`: the other sources that answered this key differently. Never reduced to a winner. */
  readonly conflictingSourceIds?: readonly string[];
}

/**
 * What a resolver returns: an observation, not a fact.
 *
 * The omission is the security property. There is **no** `trustClass` field
 * here and no way to add one through the port — a resolver reports what it read
 * and where it read it, and the configured `ContextSource` registry decides
 * what that is worth. A resolver cannot promote its own output, and neither can
 * anything upstream of it, including the requester.
 */
export interface ContextFactObservation {
  readonly key: string;
  readonly value: ContextFactValue;
  /** Must name a source the deployment has registered. An observation citing an unregistered source cannot be classified and is discarded — the key then resolves `unresolved`, never at some default class. */
  readonly sourceId: string;
  readonly observedAt: string;
  /** The source's own freshness bound for this reading, when it has one. The stricter of this and the requirement's bound is what applies. */
  readonly maxAgeSeconds?: number;
  /** Opaque attestation reference, honoured only when the citing source is configured `attested`. */
  readonly attestationRef?: string;
}

/** Structural violations of a fact. Hard invariant 1 made checkable: no `sourceId`, no `observedAt`, no fact. */
export function validateContextFact(fact: ContextFact): readonly string[] {
  const violations: string[] = [];
  if (typeof fact.key !== 'string' || fact.key.trim().length === 0) violations.push('ContextFact.key is required and must be non-empty.');
  if (typeof fact.sourceId !== 'string' || fact.sourceId.trim().length === 0) violations.push(`ContextFact '${fact.key}': sourceId is required — a value without an origin is not a fact.`);
  if (typeof fact.observedAt !== 'string' || Number.isNaN(Date.parse(fact.observedAt))) {
    violations.push(`ContextFact '${fact.key}': observedAt is required and must be a valid ISO-8601 timestamp.`);
  }
  if (fact.trustClass === 'derived' && fact.derivation === undefined) {
    violations.push(`ContextFact '${fact.key}': a derived fact must record the derivation it came from.`);
  }
  if (fact.trustClass === 'attested' && fact.attestationRef === undefined) {
    violations.push(`ContextFact '${fact.key}': an attested fact must carry the attestation it was verified against.`);
  }
  if (fact.resolution === 'conflicted' && (fact.conflictingSourceIds ?? []).length === 0) {
    violations.push(`ContextFact '${fact.key}': a conflicted fact must name the sources it conflicts with.`);
  }
  return violations;
}

/** Whether an observation is still fresh at `at`, given a bound. Total: an unparseable timestamp is not fresh, which is the safe direction. */
export function isFreshAt(observedAt: string, maxAgeSeconds: number, at: string): boolean {
  const observed = Date.parse(observedAt);
  const now = Date.parse(at);
  if (Number.isNaN(observed) || Number.isNaN(now)) return false;
  return now - observed < maxAgeSeconds * 1000;
}

/** `observedAt + maxAgeSeconds`, as an ISO-8601 instant. Returns `undefined` for an unparseable `observedAt` rather than inventing one. */
export function staleAtFor(observedAt: string, maxAgeSeconds: number): string | undefined {
  const observed = Date.parse(observedAt);
  if (Number.isNaN(observed)) return undefined;
  return new Date(observed + maxAgeSeconds * 1000).toISOString();
}
