import type { ObligationCorrelation } from './obligation-correlation.js';
import type { ObligationDischargeObservation } from './obligation-discharge.js';

/**
 * What a discharge provider is asked.
 *
 * Every field is either typed request identity, the correlation the Kernel
 * derived from it, or the declared obligation set. There is deliberately **no**
 * free-form bag, no requester metadata and no source-selection field, so a
 * requester can neither introduce a source, steer which source answers an
 * obligation, nor smuggle a value into a provider's input. It is the shape of
 * `ContextResolutionQuery`, for the identical reason.
 */
export interface ObligationDischargeQuery {
  /** Exactly the declared obligation types, sorted and deduplicated. A provider answering anything else has its extra observations discarded. */
  readonly obligationTypes: readonly string[];
  readonly correlation: ObligationCorrelation;
  readonly actorId: string;
  readonly trustDomainId: string;
  readonly organizationId?: string;
  readonly targetId?: string;
  /** The instant the Kernel is resolving at. Supplied rather than read, so a provider needs no clock and a test can pin one. */
  readonly at: string;
}

/**
 * What a provider returns: observations, and nothing else.
 *
 * No state, no eligibility, no verdict, no recommendation and no verification
 * claim. Layer D's law in `ADR-AUTHORITY-CONTROL-LAYERING.md` is that it "may
 * not grant anything, or narrow policy's conclusion"; this port's return type is
 * that law expressed as a type rather than as a comment, one step further out —
 * a provider cannot even name the lifecycle state it would like.
 */
export interface ObligationDischargeProviderOutput {
  readonly observations: readonly ObligationDischargeObservation[];
}

/**
 * The optional port through which a deployment tells Frontera what has been
 * done about its obligations.
 *
 * A *fifth* narrow port alongside `GovernedAuthorityProviderPort`,
 * `GovernedRepresentationProviderPort`, `GovernedConstraintProviderPort` and
 * `ContextResolverPort`, and separate from all four for the reason they are
 * separate from each other: it answers a different question and fails for
 * disjoint reasons.
 *
 * It is emphatically **not** an approval router. Frontera does not ask anyone
 * for an approval through this port, does not notify, does not remind, does not
 * escalate and does not schedule. It reads. Who was asked, how they were
 * reached and what happens if they are slow is the deployment's business, and
 * the ADR is explicit that "Frontera would be wrong to own it".
 *
 * A provider that throws is not a fault the Kernel reports as `indeterminate`:
 * it produces a resolution with `resolved: false`, every blocking obligation
 * stays unsatisfied, and exercise is withheld. "The approval system is down" is
 * a fact about the world, and the fail-closed direction is the only one this
 * layer has.
 */
export interface ObligationDischargeProviderPort {
  resolveObligationDischarges(query: ObligationDischargeQuery): Promise<ObligationDischargeProviderOutput>;
}
