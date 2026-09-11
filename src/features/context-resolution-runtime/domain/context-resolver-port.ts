import type { ContextFactObservation } from './context-fact.js';

/**
 * What a resolver is asked.
 *
 * Every field is either typed request identity or the declared key set. There
 * is deliberately **no** free-form bag, no requester metadata and no
 * source-selection field, so a requester can neither introduce a source, steer
 * which source answers a key, nor smuggle a value into a resolver's input —
 * ADR §3. What a requester may influence is which *action* is being evaluated
 * and over which resource, which is exactly what it is entitled to state.
 */
export interface ContextResolutionQuery {
  /** Exactly the declared keys, sorted and deduplicated. A resolver answering anything else has its extra observations discarded. */
  readonly keys: readonly string[];
  readonly actorId: string;
  readonly trustDomainId: string;
  readonly action: string;
  readonly resourceScope: string;
  readonly organizationId?: string;
  readonly targetId?: string;
  /** The instant the Kernel is resolving at. Supplied rather than read, so a resolver needs no clock and a test can pin one. */
  readonly at: string;
}

/**
 * What a resolver returns: observations, and nothing else.
 *
 * There is no status, no verdict, no recommendation and no trust claim on this
 * shape, and that is the layer law rather than an omission —
 * `ADR-AUTHORITY-CONTROL-LAYERING.md`: "a resolver cannot allow, deny or
 * narrow. Its return type has no such shape." The rejected alternative is
 * recorded in the ADR: "letting a model — or an ERP — return a recommended
 * decision" would make "an ERP outage become an authorization outcome decided
 * by the ERP."
 */
export interface ContextResolverOutput {
  readonly observations: readonly ContextFactObservation[];
}

/**
 * The optional port through which a deployment tells Frontera what is true.
 *
 * A *fourth* narrow port alongside `GovernedAuthorityProviderPort`,
 * `GovernedRepresentationProviderPort` and `GovernedConstraintProviderPort`, and
 * separate from all three for the reason they are separate from each other: it
 * answers a different question and fails for disjoint reasons.
 *
 * Configured, it is consulted before policy evaluation begins, for exactly the
 * declared keys. Omitted, Kernel behaviour is identical to this layer not
 * existing.
 *
 * A resolver that throws is not an error the Kernel reports as a fault: it
 * produces a resolution with `resolved: false`, because "the ERP is down" is a
 * fact about the world that the deployment's own declaration decides the
 * meaning of.
 */
export interface ContextResolverPort {
  resolveContext(query: ContextResolutionQuery): Promise<ContextResolverOutput>;
}
