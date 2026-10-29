import type { AssuranceEvidenceReference, AssuranceEvidenceType } from './contracts.js';

/**
 * Manual evidence trust boundaries (ASSURE-SEC-01C).
 *
 * Evidence an interested party supplies (`control_attestation`,
 * `external_artifact_reference`, `passport_view`) is candidate evidence, not
 * authority over the result:
 *
 * - **Verification.** Only the Host verifies. A supplier's `verified: true` or
 *   `verificationReference` is preserved as a claim (`supplierClaims`) and the
 *   reference enters the assessment with `verified: false`. Every reader asks
 *   `isHostVerified`, so a manual reference recorded before this rule is not
 *   trusted either. A digest proves which bytes were referenced, not who wrote
 *   them or whether they are true.
 * - **Metrics.** An attestation may assert one metric only under a canonical
 *   name outside the reserved namespaces of Host-derived metrics.
 *
 * Nothing here makes a document authentic or a claim true.
 */

export const MANUAL_EVIDENCE_TYPES: readonly AssuranceEvidenceType[] = ['control_attestation', 'external_artifact_reference', 'passport_view'];

/**
 * Top-level namespaces of the metrics `metrics.ts` derives from Host sources
 * (governance records, evidence bundles, agent passports, enterprise and
 * module health). A test derives the full catalog and fails if any derived
 * metric falls outside these namespaces.
 */
export const RESERVED_METRIC_NAMESPACES: readonly string[] = ['governance', 'evidence', 'passport', 'enterprise', 'modules'];

/** Lower-case ASCII segments separated by single dots -- no case, whitespace, Unicode look-alike or separator variant of a reserved name passes. */
const CANONICAL_METRIC_NAME = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/;
const MAXIMUM_METRIC_NAME_LENGTH = 128;

export type ManualMetricViolation = 'invalid_name' | 'reserved_namespace';

/** Why `name` may not be asserted by a manual attestation, or `undefined` when it may. Deterministic; never logs the value. */
export function manualMetricNameViolation(name: unknown): ManualMetricViolation | undefined {
  if (typeof name !== 'string' || name.length === 0 || name.length > MAXIMUM_METRIC_NAME_LENGTH || !CANONICAL_METRIC_NAME.test(name)) return 'invalid_name';
  const namespace = name.split('.')[0] ?? '';
  return RESERVED_METRIC_NAMESPACES.includes(namespace) ? 'reserved_namespace' : undefined;
}

export function isManualEvidence(reference: Pick<AssuranceEvidenceReference, 'evidenceType'>): boolean {
  return MANUAL_EVIDENCE_TYPES.includes(reference.evidenceType);
}

/** The single "verified" question every reader asks: verified by a Host mechanism, never by its supplier. */
export function isHostVerified(reference: AssuranceEvidenceReference): boolean {
  return reference.verified && !isManualEvidence(reference);
}

/**
 * The form a supplied manual reference takes inside an assessment: `verified`
 * is `false` and no verifier reference is carried, and whatever the supplier
 * claimed about verification is kept, labelled as its claim, in
 * `supplierClaims`. Everything else -- id, digest, binding, metadata -- is
 * unchanged.
 */
export function asSuppliedManualReference(reference: AssuranceEvidenceReference): AssuranceEvidenceReference {
  const { verified, verificationReference, supplierClaims: _previousClaims, ...rest } = reference;
  const claims = {
    ...(verified ? { verified: true as const } : {}),
    ...(verificationReference !== undefined ? { verificationReference } : {}),
  };
  return { ...rest, verified: false, ...(Object.keys(claims).length > 0 ? { supplierClaims: claims } : {}) };
}

/**
 * Structural problems in a supplied manual evidence set that make its
 * bindings ambiguous (ASSURE-SEC-01C), checked before anything is collected:
 * one `evidenceReferenceId` naming two different references, or a
 * `requirementIds` list that is empty, repeats an id, or names a requirement
 * the framework does not define. Unbound references are not listed here --
 * the resolver rejects them per requirement with `EVIDENCE_NOT_BOUND`.
 */
export function manualEvidenceBindingViolations(
  manualEvidence: readonly AssuranceEvidenceReference[],
  frameworkRequirementIds: readonly string[],
  digestOf: (value: unknown) => string,
): readonly string[] {
  const violations: string[] = [];
  const digestsById = new Map<string, string>();
  manualEvidence.forEach((reference, index) => {
    const digest = digestOf(reference);
    const seen = digestsById.get(reference.evidenceReferenceId);
    if (seen !== undefined && seen !== digest) violations.push(`manualEvidence[${index}]: evidenceReferenceId '${reference.evidenceReferenceId}' already names a different reference.`);
    digestsById.set(reference.evidenceReferenceId, seen ?? digest);
    const requirementIds: unknown = reference.requirementIds;
    if (requirementIds === undefined) return;
    if (!Array.isArray(requirementIds) || requirementIds.length === 0) {
      violations.push(`manualEvidence[${index}].requirementIds must list at least one requirement when present.`);
      return;
    }
    const listed = new Set<unknown>();
    for (const requirementId of requirementIds) {
      if (typeof requirementId !== 'string' || !frameworkRequirementIds.includes(requirementId)) {
        violations.push(`manualEvidence[${index}].requirementIds names '${String(requirementId)}', which the framework does not define.`);
      } else if (listed.has(requirementId)) {
        violations.push(`manualEvidence[${index}].requirementIds repeats '${requirementId}'.`);
      }
      listed.add(requirementId);
    }
  });
  return violations;
}
