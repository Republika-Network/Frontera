/**
 * What an obligation, and any discharge of it, is attached to.
 *
 * An obligation is never free-floating: it is a condition on *this* action, for
 * *this* request, over *this* resource scope. A discharge that does not name
 * the same three is a discharge of something else, and the ADR's rejected
 * alternative — "a grant citing a decision for a different resource" — is the
 * same defect one layer up.
 *
 * Every field is derived by the Kernel from the typed request, never read from
 * a requester-supplied bag, so a caller cannot widen what a discharge it
 * obtained elsewhere appears to cover.
 */
export interface ObligationCorrelation {
  readonly requestId: string;
  readonly action: string;
  readonly resourceScope: string;
}

/** Whether two correlations name the same authorization. Exact on all three fields: a partial match is a mismatch. */
export function obligationCorrelationMatches(left: ObligationCorrelation, right: ObligationCorrelation): boolean {
  return left.requestId === right.requestId && left.action === right.action && left.resourceScope === right.resourceScope;
}

/**
 * The deterministic identity of one obligation instance.
 *
 * Derived from stable, correlated inputs and nothing else — no UUID, no
 * counter, no clock, no hash. Two evaluations of the same request against the
 * same declaration therefore produce byte-identical ids, which is what lets the
 * whole layer be re-derived rather than stored, and what makes the Governance
 * Record of a repeated evaluation identical.
 */
export function obligationInstanceId(correlation: ObligationCorrelation, obligationType: string): string {
  return `aoc.obligation:${correlation.requestId}:${correlation.action}:${correlation.resourceScope}:${obligationType}`;
}
