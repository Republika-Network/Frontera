import { evaluateContextDerivation, type ContextDerivation } from '../domain/context-derivation.js';
import {
  isFreshAt,
  staleAtFor,
  type ContextFact,
  type ContextFactFreshness,
  type ContextFactObservation,
  type ContextFactValue,
  type ResolvedContextFactStatus,
} from '../domain/context-fact.js';
import {
  contextDeclarationAssertedFactPolicy,
  validateContextDeclaration,
  type ContextAssertedFactPolicy,
  type ContextDeclaration,
  type ContextRequirement,
} from '../domain/context-requirement.js';
import type { ContextResolution } from '../domain/context-resolution.js';
import { CONTEXT_DERIVED_SOURCE_ID, type ContextSource } from '../domain/context-source.js';
import { contextTrustClassSatisfies, minimumContextTrustClass, type TerminalContextTrustClass } from '../domain/context-trust.js';
import { ContextConfigurationError } from './context-resolution-errors.js';
import { ContextSourceRegistry } from './context-source-registry.js';

export interface ContextResolutionServiceOptions {
  readonly sources: readonly ContextSource[];
  readonly declaration: ContextDeclaration;
}

/**
 * Turns a resolver's raw observations into a classified, stably-ordered
 * `ContextResolution`.
 *
 * Deterministic from the Kernel's perspective, which is the property the whole
 * layer rests on: given the same observations and the same instant, this
 * produces the same resolution, byte for byte. It reads no clock (the instant
 * is passed in), no store, no network and no randomness, and it contains no
 * `eval`, no `new Function` and no expression parser — the only computation it
 * performs is the closed derivation algebra.
 *
 * It also produces no verdict. Every output is a statement about facts; what
 * any of it means for a request is decided afterwards, by the deployment's
 * declaration and by the Kernel.
 */
export class ContextResolutionService {
  private readonly registry: ContextSourceRegistry;
  private readonly declaration: ContextDeclaration;
  private readonly derivations: readonly ContextDerivation[];
  private readonly requirementsByKey: ReadonlyMap<string, ContextRequirement>;
  private readonly requested: readonly string[];
  private readonly declared: readonly string[];

  constructor(options: ContextResolutionServiceOptions) {
    const violations = validateContextDeclaration(options.declaration);
    if (violations.length > 0) throw new ContextConfigurationError('Context declaration is invalid.', violations);

    this.registry = new ContextSourceRegistry(options.sources);
    this.declaration = options.declaration;
    this.derivations = options.declaration.derivations ?? [];

    const requirementsByKey = new Map<string, ContextRequirement>();
    for (const requirement of options.declaration.requirements) requirementsByKey.set(requirement.key, requirement);
    this.requirementsByKey = requirementsByKey;

    const derivedKeys = new Set(this.derivations.map((derivation) => derivation.key));
    // A derived key is computed here, never asked of a resolver: it is
    // Frontera's own arithmetic over facts it already holds, and asking an
    // external system for it would be asking that system to do the derivation
    // — at which point the inheritance rule could not be enforced.
    this.requested = [...new Set(options.declaration.requirements.map((requirement) => requirement.key))].filter((key) => !derivedKeys.has(key)).sort();
    this.declared = [...new Set([...options.declaration.requirements.map((requirement) => requirement.key), ...derivedKeys])].sort();
  }

  /** Exactly the keys a resolver is asked for: the declared requirements, minus anything this service derives itself. */
  requestedKeys(): readonly string[] {
    return this.requested;
  }

  /** Every key this resolution speaks about, declared requirements and derived keys alike. */
  declaredKeys(): readonly string[] {
    return this.declared;
  }

  requirements(): readonly ContextRequirement[] {
    return this.declaration.requirements;
  }

  sources(): readonly ContextSource[] {
    return this.registry.list();
  }

  /** The deployment's migration posture, readable without running a resolution — a failed resolution still has to report which posture it was configured under. */
  assertedFactPolicy(): ContextAssertedFactPolicy {
    return contextDeclarationAssertedFactPolicy(this.declaration);
  }

  assertableKeys(): readonly string[] {
    return [...(this.declaration.assertableKeys ?? [])].sort();
  }

  /**
   * Classifies observations into facts.
   *
   * Observations for keys that were not declared are discarded. That is not
   * tidiness: a resolver that could widen the fact set beyond the declaration
   * would make the declared-keys-only guarantee — and the bounded blast radius
   * that follows from it — untrue.
   */
  classify(observations: readonly ContextFactObservation[], at: string): ContextResolution {
    const byKey = new Map<string, ContextFactObservation[]>();
    for (const key of this.requested) byKey.set(key, []);
    for (const observation of observations) {
      const bucket = byKey.get(observation.key);
      if (bucket === undefined) continue;
      bucket.push(observation);
    }

    const facts: ContextFact[] = [];
    const unresolved: string[] = [];

    for (const key of this.requested) {
      const usable = (byKey.get(key) ?? []).filter((observation) => this.isUsable(observation));
      if (usable.length === 0) {
        unresolved.push(key);
        continue;
      }

      const distinctValues = new Set<ContextFactValue>(usable.map((observation) => observation.value));
      if (distinctValues.size > 1) {
        // Never reduced to a winner. Every answering source is reported, each
        // naming the others, so a deployment's rule sees the disagreement
        // itself rather than one side of it.
        const sourceIds = usable.map((observation) => observation.sourceId);
        for (const observation of usable) {
          facts.push(this.toFact(observation, 'conflicted', at, sourceIds.filter((sourceId) => sourceId !== observation.sourceId)));
        }
        continue;
      }

      const winner = this.preferred(usable);
      facts.push(this.toFact(winner, this.freshnessStatus(winner, at), at));
    }

    for (const derivation of this.derivations) {
      const derived = this.derive(derivation, facts, at);
      if (derived === undefined) {
        unresolved.push(derivation.key);
        continue;
      }
      facts.push(derived);
    }

    const ordered = [...facts].sort(byKeyThenSource);
    return {
      resolved: true,
      declaredKeys: this.declared,
      facts: ordered,
      unresolved: [...new Set(unresolved)].sort(),
      stale: uniqueSortedKeys(ordered, 'stale'),
      conflicted: uniqueSortedKeys(ordered, 'conflicted'),
      assertedFactPolicy: contextDeclarationAssertedFactPolicy(this.declaration),
      assertableKeys: [...(this.declaration.assertableKeys ?? [])].sort(),
      resolvedAt: at,
    };
  }

  /**
   * An observation is usable only if it can be fully classified.
   *
   * Three ways to fail, all fail-closed to `unresolved` rather than to some
   * default class: an unregistered source (no origin means no trust), an
   * unparseable observation time (hard invariant 1), and an `attested` source
   * that produced no attestation reference (an attestation is what is verified;
   * without one there is nothing that was).
   */
  private isUsable(observation: ContextFactObservation): boolean {
    const source = this.registry.get(observation.sourceId);
    if (source === undefined) return false;
    if (Number.isNaN(Date.parse(observation.observedAt))) return false;
    if (source.trustClass === 'attested' && observation.attestationRef === undefined) return false;
    return true;
  }

  /** Among observations that agree on the value, the one with the strongest claim: highest trust class, then most recently observed, then lowest source id. Total and stable. */
  private preferred(observations: readonly ContextFactObservation[]): ContextFactObservation {
    let best = observations[0] as ContextFactObservation;
    for (const candidate of observations.slice(1)) {
      const candidateClass = this.trustClassOf(candidate);
      const bestClass = this.trustClassOf(best);
      const stronger = contextTrustClassSatisfies(candidateClass, bestClass) && !contextTrustClassSatisfies(bestClass, candidateClass);
      if (stronger) {
        best = candidate;
        continue;
      }
      const weaker = contextTrustClassSatisfies(bestClass, candidateClass) && !contextTrustClassSatisfies(candidateClass, bestClass);
      if (weaker) continue;
      const candidateAt = Date.parse(candidate.observedAt);
      const bestAt = Date.parse(best.observedAt);
      if (candidateAt > bestAt || (candidateAt === bestAt && candidate.sourceId < best.sourceId)) best = candidate;
    }
    return best;
  }

  private trustClassOf(observation: ContextFactObservation): TerminalContextTrustClass {
    // Never `undefined` in practice: `isUsable` already rejected unregistered
    // sources. `asserted` is the fail-closed fallback rather than a throw, so a
    // mis-ordered call can only ever under-trust a fact.
    return this.registry.get(observation.sourceId)?.trustClass ?? 'asserted';
  }

  /** The stricter of the requirement's bound and the source's own. Absent on both means this key carries no freshness tolerance and can never be stale. */
  private maxAgeFor(key: string, observation: ContextFactObservation): number | undefined {
    const declared = this.requirementsByKey.get(key)?.maxAgeSeconds;
    const observed = observation.maxAgeSeconds;
    if (declared === undefined) return observed;
    if (observed === undefined) return declared;
    return Math.min(declared, observed);
  }

  private freshnessStatus(observation: ContextFactObservation, at: string): ResolvedContextFactStatus {
    const maxAgeSeconds = this.maxAgeFor(observation.key, observation);
    if (maxAgeSeconds === undefined) return 'resolved';
    return isFreshAt(observation.observedAt, maxAgeSeconds, at) ? 'resolved' : 'stale';
  }

  private toFact(
    observation: ContextFactObservation,
    resolution: ResolvedContextFactStatus,
    at: string,
    conflictingSourceIds?: readonly string[],
  ): ContextFact {
    const source = this.registry.get(observation.sourceId) as ContextSource;
    const trustClass = source.trustClass;
    const maxAgeSeconds = this.maxAgeFor(observation.key, observation);
    const freshness = this.toFreshness(observation.observedAt, maxAgeSeconds);
    // A conflicted reading is reported with its own freshness for completeness,
    // but never re-classified as fresh: the conflict is the stronger statement.
    const status = resolution === 'conflicted' ? 'conflicted' : this.freshnessStatus(observation, at);
    return {
      key: observation.key,
      value: observation.value,
      sourceId: observation.sourceId,
      sourceKind: source.kind,
      observedAt: observation.observedAt,
      trustClass,
      effectiveTrustClass: trustClass,
      resolution: status,
      ...(freshness !== undefined ? { freshness } : {}),
      ...(trustClass === 'attested' && observation.attestationRef !== undefined ? { attestationRef: observation.attestationRef } : {}),
      ...(conflictingSourceIds !== undefined && conflictingSourceIds.length > 0 ? { conflictingSourceIds: [...conflictingSourceIds].sort() } : {}),
    };
  }

  private toFreshness(observedAt: string, maxAgeSeconds: number | undefined): ContextFactFreshness | undefined {
    if (maxAgeSeconds === undefined) return undefined;
    const staleAt = staleAtFor(observedAt, maxAgeSeconds);
    return staleAt === undefined ? undefined : { maxAgeSeconds, staleAt };
  }

  /**
   * Computes one declared derivation, or `undefined` when it cannot be
   * computed — which the caller reports as `unresolved`, never as zero.
   *
   * Every operand must be `resolved`. A derivation over a stale or conflicted
   * operand would launder that operand's status into a clean-looking number,
   * which is the same laundering the trust-inheritance rule exists to prevent,
   * one axis over.
   *
   * `observedAt` is the *oldest* operand's: an aggregate is only as current as
   * its stalest input, and dating it from the freshest would make a derived
   * fact look fresher than anything it was computed from.
   */
  private derive(derivation: ContextDerivation, facts: readonly ContextFact[], at: string): ContextFact | undefined {
    const operands: ContextFact[] = [];
    for (const operandKey of derivation.operandKeys) {
      const operand = facts.find((fact) => fact.key === operandKey && fact.resolution === 'resolved');
      if (operand === undefined) return undefined;
      operands.push(operand);
    }

    const outcome = evaluateContextDerivation(derivation.operator, operands.map((operand) => operand.value));
    if (!outcome.ok) return undefined;

    const effectiveTrustClass = minimumContextTrustClass(operands.map((operand) => operand.effectiveTrustClass));
    const observedAt = operands.reduce((oldest, operand) => (Date.parse(operand.observedAt) < Date.parse(oldest) ? operand.observedAt : oldest), operands[0]?.observedAt ?? at);
    const maxAgeSeconds = this.requirementsByKey.get(derivation.key)?.maxAgeSeconds;
    const freshness = this.toFreshness(observedAt, maxAgeSeconds);
    const fresh = maxAgeSeconds === undefined || isFreshAt(observedAt, maxAgeSeconds, at);

    return {
      key: derivation.key,
      value: outcome.value,
      sourceId: CONTEXT_DERIVED_SOURCE_ID,
      sourceKind: 'internal_store',
      observedAt,
      trustClass: 'derived',
      effectiveTrustClass,
      resolution: fresh ? 'resolved' : 'stale',
      ...(freshness !== undefined ? { freshness } : {}),
      derivation: { operator: derivation.operator, operandKeys: [...derivation.operandKeys] },
    };
  }
}

function uniqueSortedKeys(facts: readonly ContextFact[], status: ResolvedContextFactStatus): readonly string[] {
  return [...new Set(facts.filter((fact) => fact.resolution === status).map((fact) => fact.key))].sort();
}

function byKeyThenSource(left: ContextFact, right: ContextFact): number {
  if (left.key !== right.key) return left.key < right.key ? -1 : 1;
  if (left.sourceId !== right.sourceId) return left.sourceId < right.sourceId ? -1 : 1;
  return 0;
}
