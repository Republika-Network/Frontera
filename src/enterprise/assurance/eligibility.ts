import type {
  AssuranceControlEvaluation,
  AssuranceDomainAssessment,
  AssuranceEligibilityProfile,
  AssuranceEligibilityResult,
  AssuranceEvidenceReference,
  AssuranceFinding,
  AssuranceFramework,
  AssuranceScope,
  AssuranceScore,
} from './contracts.js';
import { isHostVerified } from './manual-evidence-trust.js';

/**
 * The Assurance eligibility evaluator (mission sections 33-35).
 *
 * Eligibility is deliberately DISTINCT from certification: it states that
 * one assessment, under one framework version and one immutable scope,
 * satisfied one named profile's thresholds -- an internal, evidence-bound,
 * reconstructable determination. It is never a statutory certification, a
 * legal opinion, an external attestation, or a universal trust level, and
 * nothing here may be renamed "certificate" without legal and governance
 * approval.
 *
 * Deterministic: same inputs, same result, same reason codes in the same
 * order.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export interface EvaluateEligibilityInput {
  readonly framework: AssuranceFramework;
  readonly profile: AssuranceEligibilityProfile;
  readonly scope: AssuranceScope;
  readonly score: AssuranceScore;
  readonly domainAssessments: readonly AssuranceDomainAssessment[];
  readonly controlEvaluations: readonly AssuranceControlEvaluation[];
  readonly findings: readonly AssuranceFinding[];
  readonly evidenceReferences: readonly AssuranceEvidenceReference[];
  readonly evaluatedAt: string;
}

export function evaluateEligibility(input: EvaluateEligibilityInput): AssuranceEligibilityResult {
  const { framework, profile, scope, score, domainAssessments, controlEvaluations, findings, evidenceReferences } = input;
  const reasonCodes: string[] = [];

  // -- Overall score threshold.
  const minimumScoreSatisfied = profile.minimumOverallScore === undefined || score.normalizedScore >= profile.minimumOverallScore;
  if (!minimumScoreSatisfied) reasonCodes.push('ELIGIBILITY_SCORE_BELOW_MINIMUM');

  // -- Per-domain thresholds.
  let domainThresholdsSatisfied = true;
  for (const [domainId, minimum] of Object.entries(profile.minimumDomainScores ?? {})) {
    const domain = domainAssessments.find((assessment) => assessment.domainId === domainId);
    if (domain === undefined || domain.normalizedScore < minimum || domain.status === 'unknown') {
      domainThresholdsSatisfied = false;
      reasonCodes.push('ELIGIBILITY_DOMAIN_BELOW_MINIMUM');
      break;
    }
  }

  // -- Mandatory controls must pass.
  const blockingControlIds: string[] = [];
  for (const controlId of profile.mandatoryControlIds ?? []) {
    const evaluation = controlEvaluations.find((candidate) => candidate.controlId === controlId);
    if (evaluation === undefined || evaluation.status !== 'pass') {
      blockingControlIds.push(controlId);
    }
  }
  if (blockingControlIds.length > 0) reasonCodes.push('ELIGIBILITY_MANDATORY_CONTROL_NOT_PASSED');

  // -- Framework blocking controls (mission section 30): where blockingRule
  // covers eligibility, a failed blocking control blocks regardless of score.
  const blockingApplies = framework.scoringModel.blockingRule === 'eligibility_only' || framework.scoringModel.blockingRule === 'both';
  if (blockingApplies) {
    for (const domain of framework.domains) {
      for (const controlId of domain.blockingControlIds ?? []) {
        const evaluation = controlEvaluations.find((candidate) => candidate.controlId === controlId);
        if (evaluation?.status === 'fail' && !blockingControlIds.includes(controlId)) {
          blockingControlIds.push(controlId);
        }
      }
    }
    if (blockingControlIds.length > 0 && !reasonCodes.includes('ELIGIBILITY_BLOCKING_CONTROL_FAILED')) {
      const frameworkBlocking = blockingControlIds.some((controlId) => framework.domains.some((domain) => domain.blockingControlIds?.includes(controlId) === true));
      if (frameworkBlocking) reasonCodes.push('ELIGIBILITY_BLOCKING_CONTROL_FAILED');
    }
  }

  // -- Prohibited open finding severities.
  const blockingFindingIds = findings
    .filter(
      (finding) =>
        (finding.status === 'open' || finding.status === 'accepted' || finding.status === 'remediation_planned') &&
        (profile.prohibitedOpenSeverities ?? []).includes(finding.severity),
    )
    .map((finding) => finding.findingId);
  if (blockingFindingIds.length > 0) reasonCodes.push('ELIGIBILITY_PROHIBITED_OPEN_FINDING');

  // -- Evidence quality thresholds.
  let evidenceRequirementsSatisfied = true;
  if (profile.minimumVerifiedEvidenceRate !== undefined) {
    // ASSURE-SEC-01C: only Host verification counts toward the verified rate, never a supplier's own claim.
    const verifiedRate = evidenceReferences.length === 0 ? 0 : evidenceReferences.filter((reference) => isHostVerified(reference)).length / evidenceReferences.length;
    if (verifiedRate < profile.minimumVerifiedEvidenceRate) {
      evidenceRequirementsSatisfied = false;
      reasonCodes.push('ELIGIBILITY_EVIDENCE_RATE_BELOW_MINIMUM');
    }
  }
  const maximumEvidenceAgeDays = profile.maximumEvidenceAgeDays;
  if (maximumEvidenceAgeDays !== undefined) {
    const cutoffMs = Date.parse(scope.evidenceCutoffAt);
    const tooOld = evidenceReferences.some((reference) => {
      const occurredAtMs = reference.occurredAt !== undefined ? Date.parse(reference.occurredAt) : Number.NaN;
      return !Number.isNaN(occurredAtMs) && cutoffMs - occurredAtMs > maximumEvidenceAgeDays * DAY_MS;
    });
    if (tooOld) {
      evidenceRequirementsSatisfied = false;
      reasonCodes.push('ELIGIBILITY_EVIDENCE_TOO_OLD');
    }
  }

  // -- Manual review state (mission section 20): unresolved required manual
  // reviews prevent eligibility unless the framework explicitly allows a
  // provisional state.
  const pendingManualReview = controlEvaluations.some((evaluation) => evaluation.status === 'manual_review_required');
  const manualReviewRequired = profile.manualReviewRequired || pendingManualReview;
  if (pendingManualReview) reasonCodes.push('ELIGIBILITY_MANUAL_REVIEW_PENDING');

  const structurallySatisfied =
    minimumScoreSatisfied && domainThresholdsSatisfied && blockingControlIds.length === 0 && blockingFindingIds.length === 0 && evidenceRequirementsSatisfied;

  const provisional = structurallySatisfied && pendingManualReview && framework.scoringModel.manualReviewPolicy === 'provisional';
  const eligible = structurallySatisfied && !pendingManualReview && !profile.manualReviewRequired;

  if (profile.manualReviewRequired && !pendingManualReview && structurallySatisfied) {
    // The profile itself demands a human review step beyond automated checks.
    reasonCodes.push('ELIGIBILITY_PROFILE_MANUAL_REVIEW_REQUIRED');
  }
  if (eligible) reasonCodes.push('ELIGIBILITY_SATISFIED');
  if (provisional) reasonCodes.push('ELIGIBILITY_PROVISIONAL');

  return {
    profileId: profile.profileId,
    eligible,
    provisional,
    blockingControlIds,
    blockingFindingIds,
    minimumScoreSatisfied,
    domainThresholdsSatisfied,
    evidenceRequirementsSatisfied,
    manualReviewRequired,
    reasonCodes,
    evaluatedAt: input.evaluatedAt,
  };
}
