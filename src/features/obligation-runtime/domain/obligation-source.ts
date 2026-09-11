/**
 * A declared, configured, named origin for obligation discharge observations —
 * and the only place the *weight* of a discharge is ever decided.
 *
 * This is `ContextSource` one layer over, and deliberately so:
 * `ADR-CONTEXT-PROVENANCE-AND-TRUST.md`'s rejected alternative — "treating
 * self-reported discharge as verified" — is named in the obligation ADR's own
 * rejection table as "the self-assertion defect from
 * ADR-CONTEXT-PROVENANCE-AND-TRUST.md, one layer over". The observer says
 * *what* happened and *where* it came from; operator configuration decides how
 * that source is treated.
 *
 * It is a separate registry from the context one rather than a reuse of it, and
 * the separation is load-bearing. A context source answers "what is true", a
 * discharge source answers "who confirmed this condition was met", and the two
 * classify along different axes: context ranks `attested`/`authoritative`/
 * `asserted`, while a discharge's only question is whether the confirming party
 * is independent of the party that benefits. Folding them would force one
 * vocabulary to carry two unrelated judgments.
 */
export type ObligationDischargeSourceKind =
  | 'request'
  | 'internal_store'
  | 'approval_runtime'
  | 'provider_adapter'
  | 'signed_attestation'
  | 'external_api';

export const OBLIGATION_DISCHARGE_SOURCE_KINDS: readonly ObligationDischargeSourceKind[] = [
  'request',
  'internal_store',
  'approval_runtime',
  'provider_adapter',
  'signed_attestation',
  'external_api',
];

/**
 * How much a discharge from this source is worth.
 *
 * ```
 * independent    a party structurally independent of the one that benefits from
 *                the discharge — an Approval Runtime proof, a provider adapter's
 *                acknowledgement, a verified attestation. Its report can reach
 *                `verified`, and only its report can.
 * self_reported  the acting party, or something it controls. Its report reaches
 *                `discharged` and stops there, for exactly the reason ADR §2
 *                gives: "the requester says it watermarked the content" is not
 *                "the provider says so".
 * ```
 *
 * Two classes rather than a rank, because the only question a discharge poses
 * is the binary one. There is no useful ordering between an approval proof and
 * a provider acknowledgement; there is a decisive difference between either of
 * them and the beneficiary's own say-so.
 */
export type ObligationDischargeVerificationClass = 'independent' | 'self_reported';

export const OBLIGATION_DISCHARGE_VERIFICATION_CLASSES: readonly ObligationDischargeVerificationClass[] = ['independent', 'self_reported'];

export interface ObligationDischargeSource {
  /** Stable, operator-chosen identifier, e.g. `obl.src.approval.finance`. Appears verbatim in the decision's obligation evaluation. */
  readonly id: string;
  readonly kind: ObligationDischargeSourceKind;
  readonly name: string;
  /**
   * A *configuration* property, never something an observation reports.
   * `ObligationDischargeObservation` has no field for it and no way to acquire
   * one through the port, which is what makes "a requester cannot promote its
   * own discharge" mechanical rather than reviewed.
   */
  readonly verificationClass: ObligationDischargeVerificationClass;
}

/**
 * Structural violations of a source declaration, as a list rather than a throw,
 * so a registry reports every bad row at once.
 *
 * Two rules beyond required-field shape, both read straight off the ADR:
 *
 * - a source of kind `request` is *by definition* the requester talking, so it
 *   can only ever be `self_reported`. A deployment able to register the request
 *   itself as independent would have configured away the boundary this layer is.
 * - `independent` is reserved to the three kinds that can actually be
 *   independent of a beneficiary. An `internal_store` is where a host records
 *   what it was told; a host recording its caller's claim does not make the
 *   claim independent of the caller.
 */
export function validateObligationDischargeSource(source: ObligationDischargeSource): readonly string[] {
  const violations: string[] = [];
  if (typeof source.id !== 'string' || source.id.trim().length === 0) violations.push('ObligationDischargeSource.id is required and must be non-empty.');
  if (typeof source.name !== 'string' || source.name.trim().length === 0) violations.push(`ObligationDischargeSource '${source.id}': name is required and must be non-empty.`);
  if (!OBLIGATION_DISCHARGE_SOURCE_KINDS.includes(source.kind)) {
    violations.push(`ObligationDischargeSource '${source.id}': kind '${String(source.kind)}' is not a declared source kind.`);
  }
  if (!OBLIGATION_DISCHARGE_VERIFICATION_CLASSES.includes(source.verificationClass)) {
    violations.push(`ObligationDischargeSource '${source.id}': verificationClass '${String(source.verificationClass)}' is not a declared verification class.`);
  }
  if (source.kind === 'request' && source.verificationClass !== 'self_reported') {
    violations.push(`ObligationDischargeSource '${source.id}': a source of kind 'request' carries the requester's own claim and may only be 'self_reported'.`);
  }
  if (source.verificationClass === 'independent' && !['approval_runtime', 'provider_adapter', 'signed_attestation'].includes(source.kind)) {
    violations.push(
      `ObligationDischargeSource '${source.id}': verificationClass 'independent' requires kind 'approval_runtime', 'provider_adapter' or 'signed_attestation' — a store that records what it was told is not independent of whoever told it.`,
    );
  }
  return violations;
}
