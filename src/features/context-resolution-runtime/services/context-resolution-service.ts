import { evaluateContextDerivation, type ContextDerivation } from '../domain/context-derivation.js';
import { contextObservationProvenanceDigest } from '../domain/context-digest.js';
import {
  CONTEXT_FACT_STRING_MAX_LENGTH,
  isAdmissibleContextFactValue,
  isFreshAt,
  isFutureDatedAt,
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
import type { ContextObservationRefusalReason, ContextResolution, RefusedContextObservation } from '../domain/context-resolution.js';
import { CONTEXT_DERIVED_SOURCE_ID, contextSourceAttestationFor, type ContextSource } from '../domain/context-source.js';
import { contextTrustClassSatisfies, minimumContextTrustClass, type TerminalContextTrustClass } from '../domain/context-trust.js';
import { ContextConfigurationError } from './context-resolution-errors.js';
import { ContextSourceRegistry } from './context-source-registry.js';

export interface ContextResolutionServiceOptions {
  readonly sources: readonly ContextSource[];
  readonly declaration: ContextDeclaration;
  /**
   * CORE-04 review — the only thing that can make a reading `attested`.
   *
   * An attestation *reference* is an opaque string; carrying one proves
   * nothing. A reading from an `attested` source is admitted only when this
   * verifier — deterministic, synchronous, no network — accepts its evidence
   * for exactly that source and reading. Absent, no reading of any `attested`
   * source is admitted (`attestation_invalid`): the class is never conferred
   * by presence alone.
   */
  readonly attestationVerifier?: ContextAttestationVerifier;
}

/**
 * CORE-04 review — verifies an attested source's evidence for one reading:
 * issuer, key, artifact and signature as the deployment defines them. Returns
 * `true` only for evidence it verified; anything else, including a throw, is
 * refusal.
 */
export type ContextAttestationVerifier = (input: { readonly source: ContextSource; readonly observation: ContextFactObservation }) => boolean;

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
  private readonly maxFutureSkewSeconds: number;

  private readonly attestationVerifier: ContextAttestationVerifier | undefined;

  constructor(options: ContextResolutionServiceOptions) {
    const violations = validateContextDeclaration(options.declaration);
    if (violations.length > 0) throw new ContextConfigurationError('Context declaration is invalid.', violations);

    this.registry = new ContextSourceRegistry(options.sources);
    this.attestationVerifier = options.attestationVerifier;
    this.declaration = options.declaration;
    this.derivations = options.declaration.derivations ?? [];
    this.maxFutureSkewSeconds = options.declaration.maxFutureSkewSeconds ?? 0;

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
   * The Trusted Context Boundary: admits or refuses each reading, then
   * classifies the admitted ones into facts.
   *
   * Observations for keys that were not declared are discarded. That is not
   * tidiness: a resolver that could widen the fact set beyond the declaration
   * would make the declared-keys-only guarantee — and the bounded blast radius
   * that follows from it — untrue.
   *
   * Every other reading crosses the same ordered admission checks (CORE-04),
   * and a reading that fails any of them is refused — recorded on
   * `refused`, never turned into a fact, never defaulted:
   *
   * ```
   * source identity      → source_untrusted
   * fact-class authority → fact_class_not_attested
   * organization scope   → organization_mismatch
   * observation time     → observation_time_invalid, future_dated
   * value                → value_malformed
   * attestation          → attestation_missing
   * provenance           → provenance_invalid
   * ```
   *
   * Freshness is decided afterwards, on the admitted reading, against the
   * stricter of the source's bound for this class, the requirement's and the
   * reading's own: a stale reading is a `stale` fact, which no read reports as
   * satisfied.
   *
   * `organizationId` is the organization the request is made in — typed
   * request identity, never a requester claim.
   */
  classify(observations: readonly ContextFactObservation[], at: string, organizationId?: string): ContextResolution {
    const byKey = new Map<string, ContextFactObservation[]>();
    for (const key of this.requested) byKey.set(key, []);
    const refused: RefusedContextObservation[] = [];
    for (const observation of observations) {
      const bucket = byKey.get(observation.key);
      if (bucket === undefined) continue;
      const refusal = this.refusalOf(observation, at, organizationId);
      if (refusal !== undefined) {
        refused.push({ key: observation.key, sourceId: typeof observation.sourceId === 'string' ? observation.sourceId : '', reason: refusal });
        continue;
      }
      bucket.push(observation);
    }

    const facts: ContextFact[] = [];
    const unresolved: string[] = [];

    for (const key of this.requested) {
      const usable = deduplicated(byKey.get(key) ?? []);
      if (usable.length === 0) {
        unresolved.push(key);
        continue;
      }
      const distinctValues = new Set<ContextFactValue>(usable.map((observation) => observation.value));
      if (distinctValues.size > 1) {
        // Never reduced to a winner. Every answering source is reported, each
        // naming the others, so a deployment's rule sees the disagreement
        // itself rather than one side of it.
        for (const observation of usable) {
          const disagreeing = usable.filter((other) => other.value !== observation.value).map((other) => other.sourceId);
          facts.push(this.toFact(observation, 'conflicted', at, disagreeing));
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
      refused: [...refused].sort(byRefusal),
      assertedFactPolicy: contextDeclarationAssertedFactPolicy(this.declaration),
      assertableKeys: [...(this.declaration.assertableKeys ?? [])].sort(),
      resolvedAt: at,
    };
  }

  /**
   * Why a reading may not be admitted, or `undefined` when it may. The order is
   * the admission order and is load-bearing only for which single reason is
   * recorded; every failing reading is refused whichever check catches it.
   */
  private refusalOf(observation: ContextFactObservation, at: string, organizationId: string | undefined): ContextObservationRefusalReason | undefined {
    const source = typeof observation.sourceId === 'string' ? this.registry.get(observation.sourceId) : undefined;
    if (source === undefined || source.id === CONTEXT_DERIVED_SOURCE_ID) return 'source_untrusted';
    if (contextSourceAttestationFor(source, observation.key) === undefined) return 'fact_class_not_attested';
    if (source.organizationId !== undefined && source.organizationId !== organizationId) return 'organization_mismatch';
    if (observation.organizationId !== undefined && observation.organizationId !== organizationId) return 'organization_mismatch';
    if (typeof observation.observedAt !== 'string' || Number.isNaN(Date.parse(observation.observedAt))) return 'observation_time_invalid';
    if (isFutureDatedAt(observation.observedAt, at, this.maxFutureSkewSeconds)) return 'future_dated';
    if (!isAdmissibleContextFactValue(observation.value)) return 'value_malformed';
    if (source.trustClass === 'attested') {
      const reference = observation.attestationRef;
      if (typeof reference !== 'string' || reference.trim().length === 0) return 'attestation_missing';
      if (!this.attestationVerified(source, observation)) return 'attestation_invalid';
    }
    if (source.provenance === 'reference-digest' && !hasValidProvenance(observation)) return 'provenance_invalid';
    return undefined;
  }

  /** Only the configured verifier's explicit `true` is verification; no verifier, `false`, a non-boolean or a throw is not. */
  private attestationVerified(source: ContextSource, observation: ContextFactObservation): boolean {
    if (this.attestationVerifier === undefined) return false;
    try {
      return this.attestationVerifier({ source, observation }) === true;
    } catch {
      return false;
    }
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
    // Never `undefined` in practice: `refusalOf` already refused unregistered
    // sources. `asserted` is the fail-closed fallback rather than a throw, so a
    // mis-ordered call can only ever under-trust a fact.
    return this.registry.get(observation.sourceId)?.trustClass ?? 'asserted';
  }

  /**
   * The strictest applicable freshness bound: the source's configured bound for
   * this fact class (CORE-04's canonical owner), the requirement's, and the
   * reading's own. Each may only tighten the others. A reading that states a
   * malformed bound of its own is treated as already stale (bound `0`), never
   * as unbounded. Absent everywhere means this key carries no freshness
   * tolerance and can never be stale.
   */
  private maxAgeFor(key: string, observation: ContextFactObservation): number | undefined {
    const source = this.registry.get(observation.sourceId);
    const bounds: number[] = [];
    const attested = source === undefined ? undefined : contextSourceAttestationFor(source, key)?.maxAgeSeconds;
    if (attested !== undefined) bounds.push(attested);
    const declared = this.requirementsByKey.get(key)?.maxAgeSeconds;
    if (declared !== undefined) bounds.push(declared);
    const observed = observation.maxAgeSeconds;
    if (observed !== undefined) bounds.push(typeof observed === 'number' && Number.isFinite(observed) && observed > 0 ? observed : 0);
    return bounds.length === 0 ? undefined : Math.min(...bounds);
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
      ...(conflictingSourceIds !== undefined && conflictingSourceIds.length > 0 ? { conflictingSourceIds: [...new Set(conflictingSourceIds)].sort() } : {}),
      ...(typeof observation.reference === 'string' ? { reference: observation.reference } : {}),
      ...(source.provenance === 'reference-digest' && typeof observation.provenanceDigest === 'string' ? { provenanceDigest: observation.provenanceDigest } : {}),
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
    // CORE-04: a derived fact is admitted on the same terms as a read one — a
    // non-integer result has no canonical spelling, so it resolves `unresolved`.
    if (!isAdmissibleContextFactValue(outcome.value)) return undefined;

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

/**
 * CORE-04 — repeated readings of one value from one source collapse to one,
 * deterministically, whatever order they arrived in: the most recent, then the
 * lexicographically smallest reference. A duplicate can therefore neither
 * multiply a fact, nor manufacture a conflict with itself, nor change the
 * resolution digest by arriving in a different order.
 */
function deduplicated(observations: readonly ContextFactObservation[]): readonly ContextFactObservation[] {
  const byIdentity = new Map<string, ContextFactObservation>();
  for (const observation of observations) {
    const identity = `${observation.sourceId}\u0000${typeof observation.value}\u0000${String(observation.value)}`;
    const current = byIdentity.get(identity);
    if (current === undefined || laterReading(observation, current)) byIdentity.set(identity, observation);
  }
  return [...byIdentity.values()].sort((left, right) => (left.sourceId < right.sourceId ? -1 : left.sourceId > right.sourceId ? 1 : 0));
}

function laterReading(candidate: ContextFactObservation, current: ContextFactObservation): boolean {
  const candidateAt = Date.parse(candidate.observedAt);
  const currentAt = Date.parse(current.observedAt);
  if (candidateAt !== currentAt) return candidateAt > currentAt;
  return (candidate.reference ?? '') < (current.reference ?? '');
}

/** A reading carries valid provenance when its reference is present and bounded and its digest recomputes over the whole reading. */
function hasValidProvenance(observation: ContextFactObservation): boolean {
  const { reference, provenanceDigest } = observation;
  if (typeof reference !== 'string' || reference.length === 0 || reference.length > CONTEXT_FACT_STRING_MAX_LENGTH) return false;
  if (typeof provenanceDigest !== 'string') return false;
  return (
    provenanceDigest ===
    contextObservationProvenanceDigest({
      key: observation.key,
      value: observation.value,
      sourceId: observation.sourceId,
      observedAt: observation.observedAt,
      reference,
      ...(observation.organizationId !== undefined ? { organizationId: observation.organizationId } : {}),
    })
  );
}

function byRefusal(left: RefusedContextObservation, right: RefusedContextObservation): number {
  if (left.key !== right.key) return left.key < right.key ? -1 : 1;
  if (left.sourceId !== right.sourceId) return left.sourceId < right.sourceId ? -1 : 1;
  return left.reason < right.reason ? -1 : left.reason > right.reason ? 1 : 0;
}

function uniqueSortedKeys(facts: readonly ContextFact[], status: ResolvedContextFactStatus): readonly string[] {
  return [...new Set(facts.filter((fact) => fact.resolution === status).map((fact) => fact.key))].sort();
}

function byKeyThenSource(left: ContextFact, right: ContextFact): number {
  if (left.key !== right.key) return left.key < right.key ? -1 : 1;
  if (left.sourceId !== right.sourceId) return left.sourceId < right.sourceId ? -1 : 1;
  return 0;
}
