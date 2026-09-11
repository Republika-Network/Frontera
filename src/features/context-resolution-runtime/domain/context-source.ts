import type { TerminalContextTrustClass } from './context-trust.js';

/**
 * A declared, configured, named origin for context facts.
 *
 * Operator-provisioned, in the same posture as `KernelAuthorityProvisioningService`
 * — per `ADR-CONTEXT-PROVENANCE-AND-TRUST.md` §3 a request "may not introduce a
 * source, select which source answers a key, or influence a source's trust
 * class." Nothing in this module reads a request, and the resolver port
 * (`context-resolver-port.ts`) deliberately carries no requester-supplied bag,
 * so there is no route by which it could.
 */
export type ContextSourceKind =
  | 'request'
  | 'internal_store'
  | 'erp'
  | 'crm'
  | 'external_api'
  | 'ledger'
  | 'identity_provider'
  | 'approval_system'
  | 'risk_engine'
  | 'signed_attestation';

export const CONTEXT_SOURCE_KINDS: readonly ContextSourceKind[] = [
  'request',
  'internal_store',
  'erp',
  'crm',
  'external_api',
  'ledger',
  'identity_provider',
  'approval_system',
  'risk_engine',
  'signed_attestation',
];

export interface ContextSource {
  /** Stable, operator-chosen identifier, e.g. `ctx.src.erp.sap-prod`. Appears verbatim in the decision's context evaluation. */
  readonly id: string;
  readonly kind: ContextSourceKind;
  readonly name: string;
  /**
   * The class every fact from this source is admitted at.
   *
   * A *configuration* property, not something a resolver reports. A resolver
   * returns observations and no trust claim at all (see
   * `ContextFactObservation`), so the class of a fact is decided entirely by
   * which configured source answered — which is what makes "a requester cannot
   * influence a trust class" mechanical rather than reviewed.
   */
  readonly trustClass: TerminalContextTrustClass;
}

/**
 * The source every derived fact is attributed to.
 *
 * Hard invariant 1 — "a `ContextFact` without a `sourceId` and an `observedAt`
 * is invalid" — applies to derived facts too, and the honest answer to "who
 * says so" for a computed aggregate is Frontera itself. Registered
 * automatically and reserved: an operator cannot claim this id, because a
 * configured source carrying it could attribute a system-of-record read to a
 * computation that never happened.
 */
export const CONTEXT_DERIVED_SOURCE_ID = 'aoc.context.derived';

export const CONTEXT_DERIVED_SOURCE: ContextSource = {
  id: CONTEXT_DERIVED_SOURCE_ID,
  kind: 'internal_store',
  name: 'Frontera derived context',
  // Never binds: a derived fact's effective class is the minimum of its
  // operands', which is at most `authoritative` unless every operand is
  // attested. Recorded here only so the registry's shape is uniform.
  trustClass: 'authoritative',
};

/**
 * Structural violations of a source declaration, as a list rather than a throw,
 * so a registry can report every bad row at once.
 *
 * Two rules beyond required-field shape, both read straight off the ADR's trust
 * table:
 *
 * - a source of kind `request` is *by definition* the requester talking, so it
 *   may only ever be `asserted`. A deployment that could register the request
 *   as authoritative would have configured away the entire boundary.
 * - `attested` means "signed by an issuer this deployment trusts; signature
 *   verified here", which only a `signed_attestation` source can claim.
 */
export function validateContextSource(source: ContextSource): readonly string[] {
  const violations: string[] = [];
  if (typeof source.id !== 'string' || source.id.trim().length === 0) violations.push('ContextSource.id is required and must be non-empty.');
  if (typeof source.name !== 'string' || source.name.trim().length === 0) violations.push(`ContextSource '${source.id}': name is required and must be non-empty.`);
  if (!CONTEXT_SOURCE_KINDS.includes(source.kind)) violations.push(`ContextSource '${source.id}': kind '${String(source.kind)}' is not a declared source kind.`);
  if (source.kind === 'request' && source.trustClass !== 'asserted') {
    violations.push(`ContextSource '${source.id}': a source of kind 'request' carries the requester's own claim and may only be 'asserted'.`);
  }
  if (source.trustClass === 'attested' && source.kind !== 'signed_attestation') {
    violations.push(`ContextSource '${source.id}': trust class 'attested' requires kind 'signed_attestation' — an attestation is what is verified, not the channel it arrived on.`);
  }
  return violations;
}
