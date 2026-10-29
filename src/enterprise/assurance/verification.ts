import type { AssuranceAssessment, AssuranceAssessmentVerificationResult, AssuranceFramework, AssuranceVerificationFailure } from './contracts.js';
import { recomputeAssessmentIntegrity } from './assessment.js';
import { computeDomainAssessments, computeOverallScore } from './scoring.js';
import { evaluateEligibility } from './eligibility.js';
import { boundEvidenceViolation, manualReviewEvidencePolicy } from './manual-review-evidence.js';
import { assessmentTerminationViolations } from './assessment-termination.js';

/**
 * Independent assessment verification (mission sections 64-65): recomputes
 * every digest from the stored content and independently re-derives the
 * domain calculations, overall score, and eligibility results from the
 * stored control evaluations via the framework's own scoring model. Stored
 * numbers are never trusted without recomputation.
 *
 * This is INTERNAL verification -- it demonstrates the stored assessment is
 * intact and its calculations reproduce; it is not an external attestation,
 * signature, or audit opinion.
 */

export interface VerifyAssuranceAssessmentInput {
  readonly assessment: AssuranceAssessment;
  /** The registered framework version the assessment claims. Absent -> the framework check fails explicitly rather than being assumed valid. */
  readonly framework?: AssuranceFramework;
  readonly now: () => string;
}

export function verifyAssuranceAssessment(input: VerifyAssuranceAssessmentInput): AssuranceAssessmentVerificationResult {
  const { assessment, framework } = input;
  const failures: AssuranceVerificationFailure[] = [];
  const fail = (check: string, message: string): void => {
    failures.push({ check, message });
  };

  // -- Framework identity and version.
  let frameworkOk = true;
  if (assessment.frameworkId !== assessment.scope.frameworkId || assessment.frameworkVersion !== assessment.scope.frameworkVersion) {
    frameworkOk = false;
    fail('framework', `Assessment names framework '${assessment.frameworkId}@${assessment.frameworkVersion}' but its scope names '${assessment.scope.frameworkId}@${assessment.scope.frameworkVersion}'.`);
  }
  if (framework === undefined) {
    frameworkOk = false;
    fail('framework', `Framework '${assessment.frameworkId}@${assessment.frameworkVersion}' is not registered; the assessment cannot be verified against its framework.`);
  } else if (framework.frameworkId !== assessment.frameworkId || framework.frameworkVersion !== assessment.frameworkVersion) {
    frameworkOk = false;
    fail('framework', `Supplied framework '${framework.frameworkId}@${framework.frameworkVersion}' does not match the assessment's '${assessment.frameworkId}@${assessment.frameworkVersion}'.`);
  }

  // -- Recompute all digests from stored content.
  const recomputed = recomputeAssessmentIntegrity(assessment);
  const digestCheck = (check: keyof typeof recomputed, label: string): boolean => {
    if (recomputed[check] !== assessment.integrity[check]) {
      fail(label, `${label} digest mismatch: stored '${String(assessment.integrity[check])}', recomputed '${String(recomputed[check])}'.`);
      return false;
    }
    return true;
  };

  const scopeOk = digestCheck('scopeDigest', 'scope');
  let evidenceOk = digestCheck('evidenceDigest', 'evidence');
  let controlsOk = digestCheck('controlEvaluationsDigest', 'controls');
  const findingsOk = digestCheck('findingsDigest', 'findings');
  let domainsOk = digestCheck('domainAssessmentsDigest', 'domains');
  let scoreOk = digestCheck('scoreDigest', 'score');
  let eligibilityOk = digestCheck('eligibilityDigest', 'eligibility');
  // ASSURE-REL-01B: a termination record must be intact and bound to this content; it is reported under `integrity`.
  const terminationViolations = assessmentTerminationViolations(assessment);
  for (const violation of terminationViolations) fail('integrity', `Termination record: ${violation}.`);
  const integrityOk = digestCheck('assessmentDigest', 'integrity') && terminationViolations.length === 0;

  // -- Evidence tenant consistency: every reference must be bound to the
  // assessment subject's organization (mission section 64).
  for (const reference of assessment.evidenceReferences) {
    if (reference.organizationId !== assessment.subject.organizationId) {
      evidenceOk = false;
      fail('evidence', `Evidence reference '${reference.evidenceReferenceId}' is bound to organization '${reference.organizationId}', not the subject's '${assessment.subject.organizationId}'.`);
    }
  }

  // -- Framework-referential checks and calculation reproduction.
  if (framework !== undefined) {
    const controlIds = new Set(framework.controls.map((control) => control.controlId));
    for (const evaluation of assessment.controlEvaluations) {
      if (!controlIds.has(evaluation.controlId)) {
        controlsOk = false;
        fail('controls', `Control evaluation '${evaluation.controlEvaluationId}' references controlId '${evaluation.controlId}', which the framework does not define.`);
      }
    }

    // -- Evidence-bound manual conclusions (ASSURE-SEC-01A): a definitive
    // manual result under the `control_bound` policy must have bound,
    // sufficient evidence in the stored resolutions. This detects the absence
    // of support; it cannot show which references the reviewer relied on.
    for (const evaluation of assessment.controlEvaluations) {
      const control = framework.controls.find((candidate) => candidate.controlId === evaluation.controlId);
      if (control === undefined || control.criteria.type !== 'manual_review' || manualReviewEvidencePolicy(control.criteria) !== 'control_bound') continue;
      if (!evaluation.reasonCodes.includes('CONTROL_MANUAL_REVIEW_APPLIED') || !['pass', 'partial', 'fail'].includes(evaluation.status)) continue;
      const violation = boundEvidenceViolation(control, assessment.evidenceResolutions, assessment.subject.organizationId, evaluation.status !== 'fail');
      if (violation !== undefined) {
        controlsOk = false;
        fail('controls', `Control '${evaluation.controlId}' carries a definitive manual result (${evaluation.status}) without bound evidence: ${violation.violation}. ${violation.message}`);
      }
    }

    if (assessment.domainAssessments.length > 0) {
      // Reproduce domain calculations from the stored control evaluations.
      const reproducedDomains = computeDomainAssessments({
        framework,
        evaluations: assessment.controlEvaluations,
        findings: assessment.findings,
        assessmentId: assessment.assessmentId,
        nextId: () => 'reverify',
        evaluatedAt: 'reverify',
      });
      for (const stored of assessment.domainAssessments) {
        const reproduced = reproducedDomains.find((candidate) => candidate.domainId === stored.domainId);
        if (reproduced === undefined) {
          domainsOk = false;
          fail('domains', `Domain assessment '${stored.domainId}' could not be reproduced from the framework definition.`);
          continue;
        }
        if (reproduced.normalizedScore !== stored.normalizedScore || reproduced.status !== stored.status || reproduced.score !== stored.score) {
          domainsOk = false;
          fail(
            'domains',
            `Domain '${stored.domainId}' does not reproduce: stored ${stored.normalizedScore}/100 (${stored.status}), recomputed ${reproduced.normalizedScore}/100 (${reproduced.status}).`,
          );
        }
      }

      // Reproduce the overall score from the STORED domain assessments.
      const reproducedScore = computeOverallScore({ framework, domainAssessments: assessment.domainAssessments, calculatedAt: assessment.score.calculatedAt });
      if (reproducedScore.normalizedScore !== assessment.score.normalizedScore || reproducedScore.rawScore !== assessment.score.rawScore) {
        scoreOk = false;
        fail('score', `Overall score does not reproduce: stored ${assessment.score.normalizedScore}, recomputed ${reproducedScore.normalizedScore}.`);
      }

      // Reproduce eligibility from stored components.
      for (const stored of assessment.eligibility) {
        const profile = framework.eligibilityProfiles.find((candidate) => candidate.profileId === stored.profileId);
        if (profile === undefined) {
          eligibilityOk = false;
          fail('eligibility', `Eligibility result names profile '${stored.profileId}', which the framework does not define.`);
          continue;
        }
        const reproduced = evaluateEligibility({
          framework,
          profile,
          scope: assessment.scope,
          score: assessment.score,
          domainAssessments: assessment.domainAssessments,
          controlEvaluations: assessment.controlEvaluations,
          findings: assessment.findings,
          evidenceReferences: assessment.evidenceReferences,
          evaluatedAt: stored.evaluatedAt,
        });
        if (reproduced.eligible !== stored.eligible || reproduced.provisional !== stored.provisional) {
          eligibilityOk = false;
          fail('eligibility', `Eligibility for profile '${stored.profileId}' does not reproduce: stored eligible=${stored.eligible}, recomputed eligible=${reproduced.eligible}.`);
        }
      }
    }
  }

  const checks = {
    framework: frameworkOk,
    scope: scopeOk,
    evidence: evidenceOk,
    controls: controlsOk,
    findings: findingsOk,
    domains: domainsOk,
    score: scoreOk,
    eligibility: eligibilityOk,
    integrity: integrityOk,
  };

  return {
    assessmentId: assessment.assessmentId,
    valid: Object.values(checks).every((check) => check),
    checks,
    failures,
    verifiedAt: input.now(),
  };
}
