import { computeDigest } from '../governance-store/digest.js';
import type { AssuranceAssessment, AssuranceAssessmentTermination, AssuranceTerminationReasonCode } from './contracts.js';

/**
 * Ending an assessment attempt as inconclusive (ASSURE-REL-01B).
 *
 * An attempt whose evidence contradicts itself (two accepted references to the
 * same artifact with different digests) cannot be concluded: a favourable
 * review is refused, a FAIL review does not settle the control, the framework
 * allows no provisional completion, and accepted evidence is never withdrawn
 * from an attempt (ASSURE-PILOT-01, F02). The way out is to END the attempt --
 * the existing terminal status `failed`, with this record -- and continue in a
 * new attempt (`requestReassessment`) whose evidence is collected afresh.
 *
 * A termination resolves nothing: it records no control result, converts no
 * contradiction into PASS or FAIL, removes no evidence and produces no report.
 * The contradictions stay in the record and in the evidence.
 */

export const ASSURANCE_TERMINATION_VERSION = 'aoc.assurance.assessment-termination.v1';

/** The role an authenticated reviewer needs to end an attempt. Not implied by the release role. */
export const ASSURANCE_TERMINATION_ROLE = 'assure.reviewer';

export const ASSURANCE_TERMINATION_REASON_CODES: readonly AssuranceTerminationReasonCode[] = ['unresolved_contradiction', 'engagement_withdrawn'];

export const ASSURANCE_TERMINATION_RATIONALE_MAX_LENGTH = 2000;

/** The contradictions an assessment's stored evidence holds, in requirement order. Derived only from the stored resolutions. */
export function unresolvedContradictions(assessment: AssuranceAssessment): AssuranceAssessmentTermination['unresolvedContradictions'] {
  return assessment.evidenceResolutions.flatMap((resolution) =>
    resolution.contradictions.map((contradiction) => ({
      requirementId: resolution.requirementId,
      evidenceReferenceIds: [...contradiction.evidenceReferenceIds],
      reason: contradiction.reason,
    })),
  );
}

export function buildAssessmentTermination(input: {
  readonly assessment: AssuranceAssessment;
  readonly reasonCode: AssuranceTerminationReasonCode;
  readonly rationale: string;
  readonly terminatedBy: string;
  readonly terminatedAt: string;
}): AssuranceAssessmentTermination {
  const body = {
    terminationVersion: ASSURANCE_TERMINATION_VERSION,
    outcome: 'inconclusive' as const,
    reasonCode: input.reasonCode,
    rationale: input.rationale,
    terminatedBy: input.terminatedBy,
    terminatorRole: ASSURANCE_TERMINATION_ROLE,
    authentication: 'assurance_reviewer_credential' as const,
    terminatedAt: input.terminatedAt,
    statusAtTermination: input.assessment.status,
    assessmentDigest: input.assessment.integrity.assessmentDigest,
    unresolvedContradictions: unresolvedContradictions(input.assessment),
  };
  return { ...body, terminationDigest: computeDigest(body) };
}

/** Why a stored assessment's termination record is not intact and coherent with it, or an empty list. */
export function assessmentTerminationViolations(assessment: AssuranceAssessment): readonly string[] {
  const termination = assessment.termination;
  if (termination === undefined) return [];
  const violations: string[] = [];
  const { terminationDigest, ...body } = termination;
  if (computeDigest(body) !== terminationDigest) violations.push('terminationDigest does not recompute');
  if (assessment.status !== 'failed') violations.push(`a terminated assessment must be 'failed', not '${assessment.status}'`);
  if (termination.terminationVersion !== ASSURANCE_TERMINATION_VERSION) violations.push('unknown termination version');
  if (termination.outcome !== 'inconclusive') violations.push('a termination is always inconclusive');
  if (!ASSURANCE_TERMINATION_REASON_CODES.includes(termination.reasonCode)) violations.push('unknown termination reason');
  if (termination.authentication !== 'assurance_reviewer_credential' || termination.terminatorRole !== ASSURANCE_TERMINATION_ROLE) violations.push('termination not attributed to an authenticated reviewer');
  if (termination.assessmentDigest !== assessment.integrity.assessmentDigest) violations.push('termination is bound to other assessment content');
  if (computeDigest(termination.unresolvedContradictions) !== computeDigest(unresolvedContradictions(assessment))) violations.push('recorded contradictions differ from the stored evidence');
  if (termination.reasonCode === 'unresolved_contradiction' && termination.unresolvedContradictions.length === 0) violations.push('unresolved_contradiction recorded without a contradiction');
  return violations;
}

/** Whether a repeated termination request matches the termination already kept (an idempotent replay). */
export function isSameTermination(kept: AssuranceAssessmentTermination, request: { readonly reasonCode: string; readonly rationale: string; readonly terminatedBy: string }): boolean {
  return kept.reasonCode === request.reasonCode && kept.rationale === request.rationale && kept.terminatedBy === request.terminatedBy;
}
