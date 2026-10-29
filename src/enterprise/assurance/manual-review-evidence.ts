import type {
  AssuranceControlDefinition,
  AssuranceEvidenceReference,
  AssuranceEvidenceResolution,
  AssuranceManualReviewCriteria,
  AssuranceManualReviewOutcome,
} from './contracts.js';
import { MANUAL_EVIDENCE_TYPES } from './manual-evidence-trust.js';

/**
 * Evidence-bound manual conclusions (ASSURE-SEC-01A). The one deterministic
 * rule deciding whether a manual review may carry its outcome, shared by the
 * service (validate on write), the control evaluator (re-check every stored
 * review on evaluation), and assessment verification (detect a definitive
 * manual conclusion with no bound evidence behind it).
 *
 * Two policies, selected from the control definition itself:
 *
 * - `declared_citation` -- the criteria declare `requiredEvidenceRequirementIds`.
 *   The framework-authored citation rule is honoured exactly as before: every
 *   outcome must cite at least one evidence reference. (`aoc.saf` 1.0.0 and
 *   existing callers keep their behaviour; tightening it is a framework
 *   decision, not an engine default.)
 * - `control_bound` -- the criteria declare no citation rule. A definitive
 *   outcome (`pass`, `partial`, `fail`) must cite evidence that is accepted
 *   in this assessment, bound to this organization, and bound to one of this
 *   control's own evidence requirements; every such requirement must be
 *   sufficiently covered and, for a favourable outcome, free of unresolved
 *   contradictions. `insufficient_evidence` needs no evidence and maps to
 *   `unknown`, never `fail`.
 *
 * Binding: evidence the resolver gathers from a source is produced per
 * requirement and is bound by its resolution. Manually supplied evidence is
 * offered to every requirement that accepts its type, so it binds to a
 * requirement only when it names that requirement in `requirementIds` --
 * reuse across controls is an explicit association, never a coincidence.
 *
 * What this does NOT establish: that the evidence is authentic, truthful, or
 * from the claimed provenance, or that the reviewer's conclusion is correct.
 * It enforces structural binding and sufficiency only.
 */

export type ManualReviewEvidencePolicy = 'declared_citation' | 'control_bound';

export type ManualReviewEvidenceViolationCode =
  | 'MANUAL_REVIEW_EVIDENCE_MISSING'
  | 'MANUAL_REVIEW_EVIDENCE_NOT_FOUND'
  | 'MANUAL_REVIEW_EVIDENCE_REJECTED'
  | 'MANUAL_REVIEW_EVIDENCE_WRONG_TENANT'
  | 'MANUAL_REVIEW_EVIDENCE_NOT_BOUND'
  | 'MANUAL_REVIEW_EVIDENCE_INSUFFICIENT'
  | 'MANUAL_REVIEW_EVIDENCE_CONTRADICTED';

export interface ManualReviewEvidenceCheck {
  readonly valid: boolean;
  readonly policy: ManualReviewEvidencePolicy;
  readonly violation?: ManualReviewEvidenceViolationCode;
  readonly message?: string;
}

export interface ManualReviewEvidenceInput {
  readonly control: AssuranceControlDefinition;
  readonly criteria: AssuranceManualReviewCriteria;
  readonly outcome: AssuranceManualReviewOutcome;
  readonly citedEvidenceReferenceIds: readonly string[];
  /** The assessment's own evidence resolutions -- the only evidence a review may cite. */
  readonly resolutions: readonly AssuranceEvidenceResolution[];
  /** The assessed subject's organization. */
  readonly organizationId: string;
}

const DEFINITIVE_OUTCOMES: ReadonlySet<AssuranceManualReviewOutcome> = new Set(['pass', 'partial', 'fail']);
const FAVOURABLE_OUTCOMES: ReadonlySet<AssuranceManualReviewOutcome> = new Set(['pass', 'partial']);

export function manualReviewEvidencePolicy(criteria: AssuranceManualReviewCriteria): ManualReviewEvidencePolicy {
  return (criteria.requiredEvidenceRequirementIds?.length ?? 0) > 0 ? 'declared_citation' : 'control_bound';
}

export function isDefinitiveManualOutcome(outcome: AssuranceManualReviewOutcome): boolean {
  return DEFINITIVE_OUTCOMES.has(outcome);
}

/** Whether `reference`, accepted in `resolution`, is bound to that resolution's requirement and to `organizationId`. */
function isBound(reference: AssuranceEvidenceReference, resolution: AssuranceEvidenceResolution, organizationId: string): boolean {
  if (reference.organizationId !== organizationId) return false;
  if (!MANUAL_EVIDENCE_TYPES.includes(reference.evidenceType)) return true;
  return reference.requirementIds?.includes(resolution.requirementId) === true;
}

function resolutionsFor(control: AssuranceControlDefinition, resolutions: readonly AssuranceEvidenceResolution[]): readonly AssuranceEvidenceResolution[] {
  return resolutions.filter((resolution) => control.evidenceRequirementIds.includes(resolution.requirementId));
}

/**
 * Requirement-level sufficiency of bound evidence for a `control_bound`
 * control -- independent of which references a review cites, so
 * verification can apply it to a stored assessment. Returns the first
 * violation, or `undefined` when every requirement of the control is covered.
 */
export function boundEvidenceViolation(
  control: AssuranceControlDefinition,
  resolutions: readonly AssuranceEvidenceResolution[],
  organizationId: string,
  favourable: boolean,
): { readonly violation: ManualReviewEvidenceViolationCode; readonly message: string } | undefined {
  if (control.evidenceRequirementIds.length === 0) {
    return { violation: 'MANUAL_REVIEW_EVIDENCE_INSUFFICIENT', message: `Control '${control.controlId}' defines no evidence requirement a definitive conclusion could rest on.` };
  }
  const relevant = resolutionsFor(control, resolutions);
  for (const requirementId of control.evidenceRequirementIds) {
    const resolution = relevant.find((candidate) => candidate.requirementId === requirementId);
    const bound = resolution === undefined ? [] : resolution.acceptedEvidence.filter((reference) => isBound(reference, resolution, organizationId));
    if (resolution === undefined || resolution.status !== 'satisfied' || bound.length === 0) {
      return {
        violation: 'MANUAL_REVIEW_EVIDENCE_INSUFFICIENT',
        message: `Requirement '${requirementId}' of control '${control.controlId}' is not satisfied by accepted evidence bound to it.`,
      };
    }
    if (favourable && resolution.contradictions.length > 0) {
      return {
        violation: 'MANUAL_REVIEW_EVIDENCE_CONTRADICTED',
        message: `Requirement '${requirementId}' of control '${control.controlId}' carries unresolved contradictory evidence; a favourable conclusion cannot rest on it.`,
      };
    }
  }
  return undefined;
}

export function checkManualReviewEvidence(input: ManualReviewEvidenceInput): ManualReviewEvidenceCheck {
  const { control, criteria, outcome, citedEvidenceReferenceIds: cited, resolutions, organizationId } = input;
  const policy = manualReviewEvidencePolicy(criteria);
  const invalid = (violation: ManualReviewEvidenceViolationCode, message: string): ManualReviewEvidenceCheck => ({ valid: false, policy, violation, message });

  if (policy === 'declared_citation') {
    return cited.length === 0
      ? invalid('MANUAL_REVIEW_EVIDENCE_MISSING', `Control '${control.controlId}' requires the manual review to reference supporting evidence.`)
      : { valid: true, policy };
  }

  if (!isDefinitiveManualOutcome(outcome)) return { valid: true, policy };
  if (cited.length === 0) {
    return invalid('MANUAL_REVIEW_EVIDENCE_MISSING', `A '${outcome}' conclusion on control '${control.controlId}' must cite accepted evidence bound to the control.`);
  }

  const relevant = resolutionsFor(control, resolutions);
  const citedRequirementIds = new Set<string>();
  for (const evidenceReferenceId of cited) {
    const boundIn = relevant.filter((resolution) =>
      resolution.acceptedEvidence.some((reference) => reference.evidenceReferenceId === evidenceReferenceId && isBound(reference, resolution, organizationId)),
    );
    if (boundIn.length > 0) {
      for (const resolution of boundIn) citedRequirementIds.add(resolution.requirementId);
      continue;
    }
    const accepted = resolutions.flatMap((resolution) => resolution.acceptedEvidence).filter((reference) => reference.evidenceReferenceId === evidenceReferenceId);
    if (accepted.some((reference) => reference.organizationId !== organizationId)) {
      return invalid('MANUAL_REVIEW_EVIDENCE_WRONG_TENANT', `Evidence '${evidenceReferenceId}' is not bound to organization '${organizationId}'.`);
    }
    if (accepted.length > 0) {
      return invalid('MANUAL_REVIEW_EVIDENCE_NOT_BOUND', `Evidence '${evidenceReferenceId}' is accepted in this assessment but not bound to a requirement of control '${control.controlId}'.`);
    }
    if (resolutions.some((resolution) => resolution.rejectedEvidence.some((rejected) => rejected.evidenceReference.evidenceReferenceId === evidenceReferenceId))) {
      return invalid('MANUAL_REVIEW_EVIDENCE_REJECTED', `Evidence '${evidenceReferenceId}' was rejected during resolution and cannot support a conclusion.`);
    }
    return invalid('MANUAL_REVIEW_EVIDENCE_NOT_FOUND', `Evidence '${evidenceReferenceId}' is not part of this assessment.`);
  }

  const uncited = control.evidenceRequirementIds.find((requirementId) => !citedRequirementIds.has(requirementId));
  if (uncited !== undefined) {
    return invalid('MANUAL_REVIEW_EVIDENCE_INSUFFICIENT', `A '${outcome}' conclusion on control '${control.controlId}' cites no evidence bound to requirement '${uncited}'.`);
  }
  const requirementViolation = boundEvidenceViolation(control, resolutions, organizationId, FAVOURABLE_OUTCOMES.has(outcome));
  return requirementViolation === undefined ? { valid: true, policy } : invalid(requirementViolation.violation, requirementViolation.message);
}
