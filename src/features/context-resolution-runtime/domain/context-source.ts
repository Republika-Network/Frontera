import type { TerminalContextTrustClass } from './context-trust.js';

/**
 * CORE-04 — a fact class: the exact key a fact is known by (`invoice.exists`,
 * `destination.registered`, `release.testsPassed`).
 *
 * An opaque, domain-declared identifier, exactly as an action class or a
 * resource class is (CORE-03): CORE owns the grammar, never the meaning, and
 * there is no universal enum of facts. Case-sensitive and matched exactly;
 * a registry refuses two classes that differ only by case, so a caller can
 * never shadow one with a differently-cased spelling.
 */
export const CONTEXT_FACT_CLASS_MAX_LENGTH = 96;
const CONTEXT_FACT_CLASS = /^[a-z][A-Za-z0-9]*(?:[._-][A-Za-z0-9]+)*$/;

export function isContextFactClass(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= CONTEXT_FACT_CLASS_MAX_LENGTH && CONTEXT_FACT_CLASS.test(value);
}

/** The largest freshness bound a source may declare for one fact class: seven days. A fact nobody re-reads for a week is not current. */
export const CONTEXT_MAX_AGE_SECONDS_LIMIT = 7 * 24 * 60 * 60;

/**
 * CORE-04 — one fact class a source has **authority to attest**, and how long
 * one of its readings of that class stays current.
 *
 * Authority to attest is scoped per fact class and granted by configuration
 * only: a source trusted for `invoice.exists` is not thereby trusted for
 * `destination.registered`, and nothing a resolver or a requester says can
 * widen the list. Authority to attest is also never authority to authorize —
 * an attested fact is an input to deterministic policy and nothing more.
 *
 * `maxAgeSeconds` is the **canonical freshness owner** for this class from this
 * source. A requirement or the reading itself may only tighten it, never relax
 * it (the stricter bound always applies).
 */
export interface ContextSourceAttestation {
  readonly factClass: string;
  readonly maxAgeSeconds?: number;
}

/**
 * CORE-04 — what a source must carry alongside each reading.
 *
 * - `none` — nothing beyond source id and observation time (the pre-CORE-04
 *   contract; still the minimum every fact meets).
 * - `reference-digest` — a non-empty provenance `reference` (the record the
 *   reading came from) and a `provenanceDigest` that recomputes over the whole
 *   reading. A reading without both, or whose digest does not recompute, is
 *   refused. This is **integrity** of the reading as the connector produced it,
 *   not authenticity of the connector: a signed attestation is the
 *   `signed_attestation` kind's business.
 */
export type ContextSourceProvenanceRequirement = 'none' | 'reference-digest';

export const CONTEXT_SOURCE_PROVENANCE_REQUIREMENTS: readonly ContextSourceProvenanceRequirement[] = ['none', 'reference-digest'];

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
  /**
   * CORE-04 — the fact classes this source has authority to attest.
   * Exhaustive and required: a reading of another class from this source is
   * refused (`fact_class_not_attested`), whatever its value. There is no
   * wildcard.
   */
  readonly attests: readonly ContextSourceAttestation[];
  /**
   * CORE-04 — the organization this source attests for. When present, a
   * reading is admitted only for a request made in exactly that organization:
   * a source configured for one organization never becomes authoritative for
   * another because a request, a resolver or a copied reading names it.
   */
  readonly organizationId?: string;
  /** CORE-04 — what each reading from this source must carry. Absent means `none`. */
  readonly provenance?: ContextSourceProvenanceRequirement;
}

/** The attestation entry of `source` for `factClass`, or `undefined` when the source has no authority to attest it. Exact match; no prefix, pattern or case folding. */
export function contextSourceAttestationFor(source: ContextSource, factClass: string): ContextSourceAttestation | undefined {
  return source.attests.find((attestation) => attestation.factClass === factClass);
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
  // Derived facts are computed, never read, so no reading is ever attributed
  // to this source by a resolver: it attests nothing.
  attests: [],
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
  if (!Array.isArray(source.attests) || source.attests.length === 0) {
    violations.push(`ContextSource '${source.id}': attests must name at least one fact class — authority to attest is granted per fact class, never wholesale.`);
  } else {
    const folds = new Set<string>();
    for (const attestation of source.attests) {
      if (attestation === null || typeof attestation !== 'object' || !isContextFactClass(attestation.factClass)) {
        violations.push(`ContextSource '${source.id}': attests holds a malformed fact class.`);
        continue;
      }
      const fold = attestation.factClass.toLowerCase();
      if (folds.has(fold)) violations.push(`ContextSource '${source.id}': attests names fact class '${attestation.factClass}' more than once (fact classes are unique regardless of case).`);
      folds.add(fold);
      const { maxAgeSeconds } = attestation;
      if (maxAgeSeconds !== undefined && (!Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds < 1 || maxAgeSeconds > CONTEXT_MAX_AGE_SECONDS_LIMIT)) {
        violations.push(`ContextSource '${source.id}': the freshness bound for '${attestation.factClass}' must be an integer number of seconds from 1 to ${CONTEXT_MAX_AGE_SECONDS_LIMIT}.`);
      }
    }
  }
  if (source.organizationId !== undefined && (typeof source.organizationId !== 'string' || source.organizationId.trim().length === 0)) {
    violations.push(`ContextSource '${source.id}': organizationId must be a non-empty string when present.`);
  }
  if (source.provenance !== undefined && !CONTEXT_SOURCE_PROVENANCE_REQUIREMENTS.includes(source.provenance)) {
    violations.push(`ContextSource '${source.id}': provenance '${String(source.provenance)}' is not a declared provenance requirement.`);
  }
  return violations;
}
