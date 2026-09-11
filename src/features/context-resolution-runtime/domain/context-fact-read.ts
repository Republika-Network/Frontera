import type { ContextFact, ContextFactValue } from './context-fact.js';
import type { ContextRequirement } from './context-requirement.js';
import type { ContextResolution } from './context-resolution.js';
import { contextTrustClassSatisfies, type ContextTrustClass, type TerminalContextTrustClass } from './context-trust.js';

/**
 * Why a declared requirement was or was not met by resolved context.
 *
 * Deliberately **not** an allow/deny vocabulary, and deliberately not reducible
 * to one. Every member names a property of the *facts* — this key was not
 * answered, this fact is older than the deployment's tolerance, two sources
 * disagree, the class is below what was declared. What any of that should mean
 * for a request is the deployment's to decide, exactly as
 * `ADR-AUTHORITY-CONTROL-LAYERING.md` requires of layer C: "C and G return
 * types carry no allow, no deny, no narrow, no severity that maps onto a
 * decision. This is a type-level property, not a documented promise."
 */
export type ContextFactReadStatus =
  /** The fact met the declared minimum trust class and the declared freshness. */
  | 'satisfied'
  /** Context resolution did not run to completion — the resolver was consulted and could not answer. */
  | 'context_not_resolved'
  /** The key was never declared, so nothing resolved it and nothing could have. */
  | 'undeclared'
  /** Declared and asked for; nothing answered. */
  | 'unresolved'
  /** Answered, but older than the applicable freshness bound. */
  | 'stale'
  /** Answered by more than one source, differently. Never reduced to a winner. */
  | 'conflicted'
  /** Answered at a class below the declared minimum. Unconditional: no posture relaxes this. */
  | 'insufficient_trust'
  /** Answered by the requester, for a key this deployment has not declared assertable, under the `require-declaration` posture. */
  | 'asserted_not_declared';

/**
 * One requirement measured against what was resolved.
 *
 * There is no boolean on this shape. `status === 'satisfied'` is the only way
 * to ask, and it reads as what it is — a comparison of a fact against a
 * declared requirement — rather than as a verdict a caller might forward.
 */
export interface ContextFactRead {
  readonly key: string;
  readonly status: ContextFactReadStatus;
  /** The fact's value, present only when the read was satisfied. A value that failed its own requirement is not offered up for a rule to use anyway. */
  readonly value?: ContextFactValue;
  readonly trustClass?: ContextTrustClass;
  readonly effectiveTrustClass?: TerminalContextTrustClass;
  readonly sourceId?: string;
  readonly observedAt?: string;
  /**
   * Set when a satisfied read turned on a fact the requester supplied, under
   * the `report` posture.
   *
   * This is the migration list ADR §7 asks for: it names what would stop
   * matching under `require-declaration`, before anything stops matching.
   */
  readonly assertedFactReported?: boolean;
}

/**
 * Reads one declared requirement out of a resolution. Pure, total and
 * deterministic — no clock, no store, no I/O; freshness was already decided
 * when the fact was classified, against the instant the Kernel resolved at.
 *
 * The order of the checks is load-bearing:
 *
 * 1. **Whether resolution happened at all.** An unreadable resolver is not a
 *    key that turned out to have no value.
 * 2. **Whether the key was declared.** An undeclared key was never asked for,
 *    which is a configuration fact rather than a fact about the world.
 * 3. **Resolution status**, in the order `conflicted`, `stale`, `unresolved` —
 *    a conflict is the strongest statement about the world and is reported even
 *    though a stale reading of the same key also exists.
 * 4. **Trust class**, which no configuration relaxes.
 * 5. **The asserted-fact posture**, which applies only after the declared
 *    minimum has already been met, and only to a fact the requester supplied.
 */
export function readContextFact(resolution: ContextResolution, requirement: ContextRequirement): ContextFactRead {
  const { key } = requirement;

  if (!resolution.resolved) return { key, status: 'context_not_resolved' };
  if (!resolution.declaredKeys.includes(key)) return { key, status: 'undeclared' };
  if (resolution.conflicted.includes(key)) return { key, status: 'conflicted' };
  if (resolution.stale.includes(key)) return { key, status: 'stale' };

  const fact = resolution.facts.find((candidate) => candidate.key === key && candidate.resolution === 'resolved');
  if (fact === undefined) return { key, status: 'unresolved' };

  const provenance = {
    trustClass: fact.trustClass,
    effectiveTrustClass: fact.effectiveTrustClass,
    sourceId: fact.sourceId,
    observedAt: fact.observedAt,
  } as const;

  if (!contextTrustClassSatisfies(fact.effectiveTrustClass, requirement.minimumTrustClass)) {
    return { key, status: 'insufficient_trust', ...provenance };
  }

  if (fact.effectiveTrustClass === 'asserted') {
    if (resolution.assertedFactPolicy === 'require-declaration' && !resolution.assertableKeys.includes(key)) {
      return { key, status: 'asserted_not_declared', ...provenance };
    }
    if (resolution.assertedFactPolicy === 'report') {
      return { key, status: 'satisfied', value: fact.value, ...provenance, assertedFactReported: true };
    }
  }

  return { key, status: 'satisfied', value: fact.value, ...provenance };
}

/** Reads every declared requirement, in declaration order. The list a Kernel step and a migration report are both built from. */
export function readContextFacts(resolution: ContextResolution, requirements: readonly ContextRequirement[]): readonly ContextFactRead[] {
  return requirements.map((requirement) => readContextFact(resolution, requirement));
}
