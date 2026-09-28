import type { ContextFact } from './context-fact.js';
import { DEFAULT_CONTEXT_ASSERTED_FACT_POLICY, type ContextAssertedFactPolicy } from './context-requirement.js';

/**
 * CORE-04 — why the Trusted Context Boundary refused one reading.
 *
 * A closed vocabulary of *facts about the reading*, never a verdict about the
 * request. Every refusal leaves the key exactly as if the reading had never
 * arrived (`unresolved` unless another admissible reading answers it), and is
 * recorded so a refused reading is diagnosable rather than silently dropped.
 *
 * ```
 * source_untrusted          the cited source is not configured
 * fact_class_not_attested   the source is configured, but not for this fact class
 * organization_mismatch     the source, or the reading, is scoped to another organization
 * future_dated              the reading claims a time after the resolution instant, beyond the tolerated skew
 * observation_time_invalid  the reading's time is not a valid instant
 * provenance_invalid        the source requires provenance and the reading's is missing or does not recompute
 * attestation_missing       an attested source produced no (or an empty) attestation reference
 * attestation_invalid       an attested source's evidence was not verified: no attestation verifier is
 *                           configured, or the configured verifier did not accept it (CORE-04 review)
 * value_malformed           the value is not an admissible fact value (e.g. a non-integer number)
 * ```
 */
export type ContextObservationRefusalReason =
  | 'source_untrusted'
  | 'fact_class_not_attested'
  | 'organization_mismatch'
  | 'future_dated'
  | 'observation_time_invalid'
  | 'provenance_invalid'
  | 'attestation_missing'
  | 'attestation_invalid'
  | 'value_malformed';

export const CONTEXT_OBSERVATION_REFUSAL_REASONS: readonly ContextObservationRefusalReason[] = [
  'source_untrusted',
  'fact_class_not_attested',
  'organization_mismatch',
  'future_dated',
  'observation_time_invalid',
  'provenance_invalid',
  'attestation_missing',
  'attestation_invalid',
  'value_malformed',
];

/** One refused reading, reduced to what is safe to record: never its value. */
export interface RefusedContextObservation {
  readonly key: string;
  readonly sourceId: string;
  readonly reason: ContextObservationRefusalReason;
}

/**
 * The complete, bounded answer to "what was resolved for this request?".
 *
 * Modelled directly on `GovernedConstraintPolicyContext`, the precedent already
 * in the tree that `CURRENT_STATE_AUTHORITY_CONTROL.md` §2.1 calls "in
 * miniature, the entire Context layer the target architecture asks for" — same
 * position in the pipeline, same facts-only contract, same explicit `resolved`
 * flag rather than an empty set. The one addition is that a fact now carries
 * who said it.
 *
 * ## Why the four lists, and why `facts` does not contain unresolved keys
 *
 * `facts` holds only keys that something actually answered — each carrying its
 * own `resolution` of `resolved`, `stale` or `conflicted`. A key nothing
 * answered has no source and no observation time, so it cannot be a fact
 * without violating hard invariant 1. It is reported by name on `unresolved`
 * instead: still a *value* in the resolution, never an absence, and never a
 * default.
 *
 * `stale` and `conflicted` repeat keys that are also present in `facts`,
 * deliberately: a reader that only wants "what went wrong" should not have to
 * filter the fact list to find out, and a policy that wants the stale value
 * anyway can still reach it.
 */
export interface ContextResolution {
  /**
   * Whether context resolution actually ran to completion for this request.
   *
   * `false` means the resolver was consulted and could not answer — the store
   * was unreadable, the call threw. It never means "there are none". This is
   * the same distinction `GovernedConstraintPolicyContext.resolved` draws and
   * for the same reason: "the store could not be read" and "the key has no
   * value" must never be the same input to a rule.
   */
  readonly resolved: boolean;
  /** Exactly the keys the deployment declared, sorted. Nothing was resolved speculatively; nothing else was asked for. */
  readonly declaredKeys: readonly string[];
  /** Stably ordered by key, then source id, so the same world produces the same resolution. */
  readonly facts: readonly ContextFact[];
  readonly unresolved: readonly string[];
  readonly stale: readonly string[];
  readonly conflicted: readonly string[];
  /**
   * CORE-04 — every reading the Trusted Context Boundary refused, sorted by
   * key, source and reason. A refused reading never becomes a fact; this list
   * is how a refusal stays diagnosable.
   */
  readonly refused: readonly RefusedContextObservation[];
  readonly assertedFactPolicy: ContextAssertedFactPolicy;
  /** The keys the deployment declared assertable, sorted. Consulted only under the `require-declaration` posture. */
  readonly assertableKeys: readonly string[];
  readonly resolvedAt: string;
}

/**
 * The key resolved context travels under into the policy pack's deployment
 * metadata bag.
 *
 * Namespaced exactly as `aoc.governedConstraints` is, and reserved on the
 * requester-facing side by `isReservedContextKey` below. ADR §6: "resolved
 * facts reach policy under a namespace the requester cannot write to."
 */
export const CONTEXT_RESOLUTION_POLICY_METADATA_KEY = 'aoc.context';

/**
 * The requester-facing reserved namespace, and the generalization of the
 * `organizationId`/`organizationName` defence in `request-adapter.ts`.
 *
 * That defence covered exactly two field names. This covers a namespace. Every
 * key in the caller's free-form context bag that is `aoc.context`, or sits
 * under it, is dropped before the bag travels anywhere, whether or not the
 * context capability is configured. A forged `aoc.context` therefore never becomes
 * input to anything — and because the namespace did not exist before this
 * capability did, no deployment can have been relying on passing one through.
 */
export const CONTEXT_RESERVED_REQUEST_KEY_PREFIX = 'aoc.context';

export function isReservedContextKey(key: string): boolean {
  return key === CONTEXT_RESERVED_REQUEST_KEY_PREFIX || key.startsWith(`${CONTEXT_RESERVED_REQUEST_KEY_PREFIX}.`);
}

/**
 * What a request carries when the resolver was consulted and could not answer.
 *
 * Distinct from "no capability configured", which produces no resolution object
 * at all and leaves the policy input byte-identical to what it was before this
 * layer existed.
 */
export function unresolvedContextResolution(input: {
  readonly declaredKeys: readonly string[];
  readonly assertedFactPolicy?: ContextAssertedFactPolicy;
  readonly assertableKeys?: readonly string[];
  readonly resolvedAt: string;
}): ContextResolution {
  const declaredKeys = [...input.declaredKeys].sort();
  return {
    resolved: false,
    declaredKeys,
    facts: [],
    unresolved: declaredKeys,
    stale: [],
    conflicted: [],
    refused: [],
    assertedFactPolicy: input.assertedFactPolicy ?? DEFAULT_CONTEXT_ASSERTED_FACT_POLICY,
    assertableKeys: [...(input.assertableKeys ?? [])].sort(),
    resolvedAt: input.resolvedAt,
  };
}
