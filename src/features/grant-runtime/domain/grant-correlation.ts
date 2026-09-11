/**
 * What a grant is derived from, and what it can be traced back to.
 *
 * A grant is never free-floating. `ADR-OBLIGATION-DISCHARGE-AND-BOUNDED-GRANT.md`
 * §4.1 requires the authorizing decision to be *read* rather than trusted, and
 * the ADR's own worst case — "a caller holding grant-issuance rights can mint a
 * grant citing a decision that denied, or a decision for a different resource,
 * or no decision at all" — is exactly what an exact, four-field correlation
 * closes.
 *
 * Every field is derived from the authoritative evaluation, never from a
 * requester-supplied bag, so a caller cannot widen what a grant appears to
 * cover by describing it differently.
 *
 * ## Why these four
 *
 * `requestId` and `decisionId` name the evaluation; `action` and
 * `resourceScope` name what was evaluated. The first two alone would let a
 * grant cite the right decision and describe the wrong act; the last two alone
 * would let a grant describe the right act under a decision that never
 * happened. `ObligationCorrelation` makes the same argument with three fields
 * one layer down, and adds `decisionId` here because layer D re-derives its
 * state per evaluation while a grant is a durable artifact that outlives the
 * evaluation that produced it.
 *
 * ## What a correlation is deliberately not
 *
 * Not evidence, not a proof, not a signature, and not a capability. It is an
 * identity, and it is checked by equality. `ADR-EVIDENCE-CORRELATION.md` owns
 * what a correlated record has to look like once the Evidence phase reaches
 * grants; this is the field set that phase needs to exist, kept stable now so
 * the correlation it will read is not destroyed in the meantime.
 */
export interface GrantCorrelation {
  readonly requestId: string;
  readonly decisionId: string;
  readonly action: string;
  readonly resourceScope: string;
}

/** Whether two correlations name the same authorization. Exact on all four fields: a partial match is a mismatch, exactly as `obligationCorrelationMatches` treats its three. */
export function grantCorrelationMatches(left: GrantCorrelation, right: GrantCorrelation): boolean {
  return (
    left.requestId === right.requestId &&
    left.decisionId === right.decisionId &&
    left.action === right.action &&
    left.resourceScope === right.resourceScope
  );
}

/** The deterministic serialization of a correlation. Fixed field order; no clock, no ambient state. */
export function serializeGrantCorrelation(correlation: GrantCorrelation): string {
  return [
    `"action":${JSON.stringify(correlation.action)}`,
    `"decisionId":${JSON.stringify(correlation.decisionId)}`,
    `"requestId":${JSON.stringify(correlation.requestId)}`,
    `"resourceScope":${JSON.stringify(correlation.resourceScope)}`,
  ].join(',');
}

/** Whether a correlation states all four fields. A blank field is refused rather than compared, so an empty string can never match an empty string into permission. */
export function isWellFormedGrantCorrelation(correlation: GrantCorrelation): boolean {
  return (
    correlation.requestId.length > 0 &&
    correlation.decisionId.length > 0 &&
    correlation.action.length > 0 &&
    correlation.resourceScope.length > 0
  );
}
