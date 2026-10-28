import type {
  AssuranceControlCriteria,
  AssuranceControlDefinition,
  AssuranceControlEvaluation,
  AssuranceControlStatus,
  AssuranceCriteriaResult,
  AssuranceEvidenceContradictionPolicy,
  AssuranceEvidenceResolution,
  AssuranceManualReviewRecord,
  AssuranceScope,
  AssuranceScoringModel,
} from './contracts.js';
import { ASSURANCE_EVALUATOR_VERSION } from './contracts.js';
import { checkManualReviewEvidence } from './manual-review-evidence.js';

/**
 * The deterministic Assurance Control Evaluator (mission section 17). For
 * the same framework version, control definition, scope, evidence set,
 * evaluator version, and scoring configuration, the result is byte-for-byte
 * identical -- there is no wall-clock, randomness, or model inference
 * anywhere in this module. Timestamps come from the injected `evaluatedAt`.
 *
 * Status discipline (mission section 7): `unknown` is produced when
 * evidence is unavailable/undecidable and is never converted to `fail`;
 * `manual_review_required` is produced when automated evidence cannot
 * yield a defensible result and is never converted to `pass`.
 */

/** Everything one control evaluation may consult, resolved ahead of time by the service so the evaluator itself stays pure. */
export interface AssuranceEvaluationContext {
  readonly assessmentId: string;
  /** Deterministic metric values derived from accepted evidence (see `service.ts`'s metric derivation) -- boolean/threshold criteria read only from here. */
  readonly metrics: Readonly<Record<string, number | boolean>>;
  /** Attributable manual review records for this assessment (mission section 21). */
  readonly manualReviews: readonly AssuranceManualReviewRecord[];
  readonly scoringModel: AssuranceScoringModel;
  readonly evaluatedAt: string;
  readonly nextId: (prefix: string) => string;
}

export interface AssuranceControlEvaluator {
  evaluate(
    control: AssuranceControlDefinition,
    scope: AssuranceScope,
    evidence: readonly AssuranceEvidenceResolution[],
    context: AssuranceEvaluationContext,
  ): Promise<AssuranceControlEvaluation>;
}

/** Internal quad-state for one evaluated criterion tree. */
type CriteriaOutcome = 'met' | 'partial' | 'unmet' | 'undetermined';

interface CriteriaEvaluation {
  readonly outcome: CriteriaOutcome;
  readonly results: readonly AssuranceCriteriaResult[];
}

function formatValue(value: number | boolean | undefined): string {
  return value === undefined ? 'absent' : String(value);
}

function compareThreshold(actual: number, operator: string, value: number): boolean {
  switch (operator) {
    case 'gte':
      return actual >= value;
    case 'gt':
      return actual > value;
    case 'lte':
      return actual <= value;
    case 'lt':
      return actual < value;
    case 'eq':
      return actual === value;
    case 'neq':
      return actual !== value;
    default:
      return false;
  }
}

function outcomeToSatisfied(outcome: CriteriaOutcome): boolean | null {
  if (outcome === 'met' || outcome === 'partial') return true;
  if (outcome === 'unmet') return false;
  return null;
}

function evaluateCriteria(
  criteria: AssuranceControlCriteria,
  resolutionsById: ReadonlyMap<string, AssuranceEvidenceResolution>,
  metrics: Readonly<Record<string, number | boolean>>,
): CriteriaEvaluation {
  switch (criteria.type) {
    case 'boolean': {
      const actual = metrics[criteria.metric];
      if (actual === undefined || typeof actual !== 'boolean') {
        return {
          outcome: 'undetermined',
          results: [
            {
              criteriaType: 'boolean',
              description: `metric '${criteria.metric}' === ${criteria.expected}`,
              satisfied: null,
              metric: criteria.metric,
              expected: String(criteria.expected),
              actual: formatValue(actual),
              reasonCodes: ['CONTROL_METRIC_UNAVAILABLE'],
            },
          ],
        };
      }
      const met = actual === criteria.expected;
      return {
        outcome: met ? 'met' : 'unmet',
        results: [
          {
            criteriaType: 'boolean',
            description: `metric '${criteria.metric}' === ${criteria.expected}`,
            satisfied: met,
            metric: criteria.metric,
            expected: String(criteria.expected),
            actual: String(actual),
            reasonCodes: [met ? 'CONTROL_CRITERIA_SATISFIED' : 'CONTROL_CRITERIA_UNMET'],
          },
        ],
      };
    }

    case 'threshold': {
      const actual = metrics[criteria.metric];
      if (actual === undefined || typeof actual !== 'number') {
        return {
          outcome: 'undetermined',
          results: [
            {
              criteriaType: 'threshold',
              description: `metric '${criteria.metric}' ${criteria.operator} ${criteria.value}`,
              satisfied: null,
              metric: criteria.metric,
              expected: `${criteria.operator} ${criteria.value}`,
              actual: formatValue(actual),
              reasonCodes: ['CONTROL_METRIC_UNAVAILABLE'],
            },
          ],
        };
      }
      const met = compareThreshold(actual, criteria.operator, criteria.value);
      return {
        outcome: met ? 'met' : 'unmet',
        results: [
          {
            criteriaType: 'threshold',
            description: `metric '${criteria.metric}' ${criteria.operator} ${criteria.value}`,
            satisfied: met,
            metric: criteria.metric,
            expected: `${criteria.operator} ${criteria.value}`,
            actual: String(actual),
            reasonCodes: [met ? 'CONTROL_CRITERIA_SATISFIED' : 'CONTROL_CRITERIA_UNMET'],
          },
        ],
      };
    }

    case 'evidence_presence': {
      let satisfiedCount = 0;
      let partialCount = 0;
      let unavailableCount = 0;
      const reasonCodes: string[] = [];
      for (const requirementId of criteria.requirementIds) {
        const resolution = resolutionsById.get(requirementId);
        if (resolution === undefined || resolution.status === 'unavailable') {
          unavailableCount += 1;
          continue;
        }
        if (resolution.status === 'satisfied') satisfiedCount += 1;
        else if (resolution.status === 'partially_satisfied') partialCount += 1;
      }

      // Absence of evidence is never `fail` (mission section 63): missing or
      // unresolved evidence yields `undetermined`/`partial`, and only a
      // contradiction policy can turn this criteria kind into a failure
      // (handled by the control-level contradiction step, not here).
      let outcome: CriteriaOutcome;
      if (criteria.allMandatory) {
        if (satisfiedCount === criteria.requirementIds.length) outcome = 'met';
        else if (satisfiedCount + partialCount === criteria.requirementIds.length) outcome = 'partial';
        else outcome = 'undetermined';
      } else if (satisfiedCount >= criteria.minimumSatisfied) {
        outcome = satisfiedCount === criteria.requirementIds.length ? 'met' : 'partial';
      } else if (satisfiedCount + partialCount >= criteria.minimumSatisfied) {
        outcome = 'partial';
      } else {
        outcome = 'undetermined';
      }

      if (outcome === 'met') reasonCodes.push('CONTROL_CRITERIA_SATISFIED');
      if (outcome === 'partial') reasonCodes.push('CONTROL_EVIDENCE_PARTIAL');
      if (outcome === 'undetermined') reasonCodes.push('CONTROL_EVIDENCE_MISSING');
      if (unavailableCount > 0 && outcome !== 'undetermined') reasonCodes.push('CONTROL_EVIDENCE_SOURCE_UNAVAILABLE');

      return {
        outcome,
        results: [
          {
            criteriaType: 'evidence_presence',
            description: `evidence requirements [${criteria.requirementIds.join(', ')}] -- minimum ${criteria.allMandatory ? 'all' : criteria.minimumSatisfied} satisfied`,
            satisfied: outcomeToSatisfied(outcome),
            expected: criteria.allMandatory ? `all ${criteria.requirementIds.length} satisfied` : `>= ${criteria.minimumSatisfied} satisfied`,
            actual: `${satisfiedCount} satisfied, ${partialCount} partially satisfied, ${unavailableCount} unavailable`,
            reasonCodes,
          },
        ],
      };
    }

    case 'composite': {
      const children = criteria.criteria.map((child) => evaluateCriteria(child, resolutionsById, metrics));
      const results = children.flatMap((child) => child.results);
      const metCount = children.filter((child) => child.outcome === 'met').length;
      const partialCount = children.filter((child) => child.outcome === 'partial').length;
      const unmetCount = children.filter((child) => child.outcome === 'unmet').length;
      const undeterminedCount = children.filter((child) => child.outcome === 'undetermined').length;

      let outcome: CriteriaOutcome;
      if (criteria.operator === 'all') {
        if (unmetCount > 0) outcome = 'unmet';
        else if (undeterminedCount > 0) outcome = 'undetermined';
        else if (partialCount > 0) outcome = 'partial';
        else outcome = 'met';
      } else if (criteria.operator === 'any') {
        if (metCount > 0) outcome = 'met';
        else if (partialCount > 0) outcome = 'partial';
        else if (undeterminedCount > 0) outcome = 'undetermined';
        else outcome = 'unmet';
      } else {
        const minimum = criteria.minimum ?? criteria.criteria.length;
        const satisfiedEnough = metCount + partialCount;
        if (metCount >= minimum) outcome = 'met';
        else if (satisfiedEnough >= minimum) outcome = 'partial';
        else if (satisfiedEnough + undeterminedCount >= minimum) outcome = 'undetermined';
        else outcome = 'unmet';
      }

      return {
        outcome,
        results: [
          {
            criteriaType: 'composite',
            description: `composite '${criteria.operator}'${criteria.operator === 'minimum' ? ` (minimum ${criteria.minimum})` : ''} over ${criteria.criteria.length} criteria`,
            satisfied: outcomeToSatisfied(outcome),
            expected: criteria.operator === 'minimum' ? `>= ${criteria.minimum} met` : criteria.operator,
            actual: `${metCount} met, ${partialCount} partial, ${unmetCount} unmet, ${undeterminedCount} undetermined`,
            reasonCodes: [outcome === 'met' ? 'CONTROL_CRITERIA_SATISFIED' : outcome === 'unmet' ? 'CONTROL_CRITERIA_UNMET' : outcome === 'partial' ? 'CONTROL_EVIDENCE_PARTIAL' : 'CONTROL_CRITERIA_UNDETERMINED'],
          },
          ...results,
        ],
      };
    }

    case 'manual_review':
      // Handled at the control level (an attributable review record either
      // exists or the control requires one) -- reaching here means the
      // control-level handler was bypassed, so surface it as undetermined.
      return {
        outcome: 'undetermined',
        results: [
          {
            criteriaType: 'manual_review',
            description: `manual review over ${criteria.questions.length} question(s)`,
            satisfied: null,
            reasonCodes: ['CONTROL_MANUAL_REVIEW_PENDING'],
          },
        ],
      };
  }
}

function statusFromOutcome(outcome: CriteriaOutcome): AssuranceControlStatus {
  switch (outcome) {
    case 'met':
      return 'pass';
    case 'partial':
      return 'partial';
    case 'unmet':
      return 'fail';
    case 'undetermined':
      return 'unknown';
  }
}

/** Deterministic evidence-quality confidence (mission section 19) -- rules over the resolution set, never probabilistic. */
function deriveConfidence(
  status: AssuranceControlStatus,
  resolutions: readonly AssuranceEvidenceResolution[],
  hasContradictions: boolean,
): 'high' | 'medium' | 'low' {
  if (status === 'unknown' || status === 'manual_review_required' || hasContradictions) return 'low';
  if (resolutions.length === 0) return 'medium';
  const allSatisfied = resolutions.every((resolution) => resolution.status === 'satisfied');
  const allVerified = resolutions.every((resolution) => resolution.acceptedEvidence.every((evidence) => evidence.verified));
  const anyUnavailable = resolutions.some((resolution) => resolution.status === 'unavailable' || resolution.status === 'unsatisfied');
  if (anyUnavailable) return 'low';
  if (allSatisfied && allVerified) return 'high';
  return 'medium';
}

const DEFAULT_CONTRADICTION_POLICY: AssuranceEvidenceContradictionPolicy = 'manual_review';

export function createAssuranceControlEvaluator(): AssuranceControlEvaluator {
  return {
    async evaluate(control, scope, evidence, context) {
      const resolutionsById = new Map<string, AssuranceEvidenceResolution>();
      for (const resolution of evidence) resolutionsById.set(resolution.requirementId, resolution);

      const relevantResolutions = control.evidenceRequirementIds
        .map((requirementId) => resolutionsById.get(requirementId))
        .filter((resolution): resolution is AssuranceEvidenceResolution => resolution !== undefined);

      const acceptedEvidenceIds = [...new Set(relevantResolutions.flatMap((resolution) => resolution.acceptedEvidence.map((reference) => reference.evidenceReferenceId)))];
      const rejectedEvidenceIds = [
        ...new Set(relevantResolutions.flatMap((resolution) => resolution.rejectedEvidence.map((rejected) => rejected.evidenceReference.evidenceReferenceId))),
      ];

      const base = {
        controlEvaluationId: context.nextId('assurance-control-eval'),
        assessmentId: context.assessmentId,
        controlId: control.controlId,
        controlVersion: control.frameworkVersion,
        domainId: control.domainId,
        evidenceReferenceIds: acceptedEvidenceIds,
        rejectedEvidenceReferenceIds: rejectedEvidenceIds,
        evaluatedAt: context.evaluatedAt,
        evaluatorVersion: ASSURANCE_EVALUATOR_VERSION,
        maximumScore: control.scoring.maximumScore,
      };

      const finish = (
        status: AssuranceControlStatus,
        criteriaResults: readonly AssuranceCriteriaResult[],
        reasonCodes: readonly string[],
        summary: string,
        manualReview?: AssuranceControlEvaluation['manualReview'],
      ): AssuranceControlEvaluation => {
        const multiplier = context.scoringModel.statusScores[status];
        return {
          ...base,
          status,
          score: multiplier === null ? 0 : Math.round(control.scoring.maximumScore * multiplier * 10_000) / 10_000,
          confidence: status === 'not_applicable' ? 'high' : deriveConfidence(status, relevantResolutions, reasonCodes.includes('CONTROL_EVIDENCE_CONTRADICTORY')),
          criteriaResults,
          reasonCodes,
          summary,
          ...(manualReview !== undefined ? { manualReview } : {}),
        };
      };

      // -- Framework-defined applicability (mission section 62): the only
      // path to `not_applicable`, always rule-attributed, never caller-chosen.
      if (control.applicability !== undefined && !control.applicability.subjectTypes.includes(scope.subject.subjectType)) {
        return finish(
          'not_applicable',
          [
            {
              criteriaType: control.criteria.type,
              description: `applicability rule: subject types [${control.applicability.subjectTypes.join(', ')}]`,
              satisfied: null,
              expected: control.applicability.subjectTypes.join('|'),
              actual: scope.subject.subjectType,
              reasonCodes: ['CONTROL_NOT_APPLICABLE_BY_RULE'],
            },
          ],
          ['CONTROL_NOT_APPLICABLE_BY_RULE'],
          `Control '${control.controlId}' does not apply to subject type '${scope.subject.subjectType}': ${control.applicability.justification}`,
        );
      }

      // -- Contradictory evidence (mission section 61): deterministic
      // per-requirement policy, applied before criteria evaluation.
      const contradictions = relevantResolutions.flatMap((resolution) => resolution.contradictions);
      if (contradictions.length > 0) {
        const policies = new Set(contradictions.map((contradiction) => contradiction.appliedPolicy ?? DEFAULT_CONTRADICTION_POLICY));
        const criteriaResult: AssuranceCriteriaResult = {
          criteriaType: control.criteria.type,
          description: 'contradictory evidence detected across accepted candidates',
          satisfied: policies.has('fail') ? false : null,
          actual: contradictions.map((contradiction) => contradiction.reason).join('; '),
          reasonCodes: ['CONTROL_EVIDENCE_CONTRADICTORY'],
        };
        if (policies.has('fail')) {
          return finish('fail', [criteriaResult], ['CONTROL_EVIDENCE_CONTRADICTORY'], `Control '${control.controlId}' failed: contradictory evidence with a 'fail' contradiction policy.`);
        }
        if (policies.has('manual_review')) {
          return finish(
            'manual_review_required',
            [criteriaResult],
            ['CONTROL_EVIDENCE_CONTRADICTORY', 'CONTROL_MANUAL_REVIEW_PENDING'],
            `Control '${control.controlId}' requires manual review: contradictory evidence with a 'manual_review' contradiction policy.`,
            {
              reviewType: 'evidence_contradiction',
              questions: [`Resolve contradictory evidence for control '${control.controlId}': ${contradictions.map((contradiction) => contradiction.reason).join('; ')}`],
              requiredEvidenceReferenceIds: [...new Set(contradictions.flatMap((contradiction) => contradiction.evidenceReferenceIds))],
              reason: 'Contradictory evidence cannot be resolved automatically.',
            },
          );
        }
        return finish('unknown', [criteriaResult], ['CONTROL_EVIDENCE_CONTRADICTORY'], `Control '${control.controlId}' is unknown: contradictory evidence with an 'unknown' contradiction policy.`);
      }

      // -- Manual review controls (mission sections 20-21).
      if (control.criteria.type === 'manual_review') {
        const criteria = control.criteria;
        const roleMatchingReviews = context.manualReviews.filter(
          (review) =>
            review.controlId === control.controlId &&
            review.assessmentId === context.assessmentId &&
            (criteria.requiredReviewerRole === undefined || review.reviewerRole === criteria.requiredReviewerRole),
        );
        // ASSURE-SEC-01B: only a review attributed from an authenticated reviewer
        // credential resolves a control. Earlier reviews with caller-declared
        // identity stay on record but are never promoted to authenticated.
        const applicableReviews = roleMatchingReviews.filter((review) => review.reviewerAuthentication === 'assurance_reviewer_credential');
        const review = applicableReviews[applicableReviews.length - 1];
        if (review === undefined) {
          const unverifiedOnly = roleMatchingReviews.length > 0;
          const reasonCodes = unverifiedOnly ? ['CONTROL_MANUAL_REVIEW_PENDING', 'CONTROL_MANUAL_REVIEW_IDENTITY_UNVERIFIED'] : ['CONTROL_MANUAL_REVIEW_PENDING'];
          return finish(
            'manual_review_required',
            [
              {
                criteriaType: 'manual_review',
                description: `manual review over ${criteria.questions.length} question(s)`,
                satisfied: null,
                ...(criteria.requiredReviewerRole !== undefined ? { expected: `review by role '${criteria.requiredReviewerRole}'` } : {}),
                actual: unverifiedOnly ? 'only reviews without an authenticated reviewer identity are recorded' : 'no attributable review recorded',
                reasonCodes,
              },
            ],
            reasonCodes,
            unverifiedOnly
              ? `Control '${control.controlId}' requires manual review; the recorded review(s) carry no authenticated reviewer identity.`
              : `Control '${control.controlId}' requires manual review; no attributable review has been recorded.`,
            {
              reviewType: 'control_review',
              questions: criteria.questions,
              ...(criteria.requiredReviewerRole !== undefined ? { requiredReviewerRole: criteria.requiredReviewerRole } : {}),
              reason: 'Automated evidence cannot produce a defensible result for this control.',
            },
          );
        }
        // Defense in depth (ASSURE-SEC-01A): a stored review is re-checked against
        // the evidence in hand. A review that no longer has bound evidence -- or
        // never had it -- resolves nothing; the control stays pending.
        const evidenceCheck = checkManualReviewEvidence({
          control,
          criteria,
          outcome: review.outcome,
          citedEvidenceReferenceIds: review.evidenceReferenceIds,
          resolutions: evidence,
          organizationId: scope.subject.organizationId,
        });
        if (!evidenceCheck.valid) {
          const reasonCodes = ['CONTROL_MANUAL_REVIEW_PENDING', 'CONTROL_MANUAL_REVIEW_EVIDENCE_INVALID'];
          return finish(
            'manual_review_required',
            [
              {
                criteriaType: 'manual_review',
                description: `manual review over ${criteria.questions.length} question(s)`,
                satisfied: null,
                expected: 'attributable manual review supported by evidence bound to the control',
                actual: `review '${review.reviewId}' -> ${review.outcome} rejected: ${evidenceCheck.violation ?? 'invalid'}`,
                reasonCodes,
              },
            ],
            reasonCodes,
            `Control '${control.controlId}' requires manual review; review '${review.reviewId}' is not supported by bound evidence (${evidenceCheck.violation ?? 'invalid'}).`,
            {
              reviewType: 'control_review',
              questions: criteria.questions,
              ...(criteria.requiredReviewerRole !== undefined ? { requiredReviewerRole: criteria.requiredReviewerRole } : {}),
              reason: evidenceCheck.message ?? 'The recorded review is not supported by evidence bound to this control.',
            },
          );
        }
        const statusByOutcome: Record<string, AssuranceControlStatus> = {
          pass: 'pass',
          partial: 'partial',
          fail: 'fail',
          insufficient_evidence: 'unknown',
        };
        const status = statusByOutcome[review.outcome] ?? 'unknown';
        return finish(
          status,
          [
            {
              criteriaType: 'manual_review',
              description: `manual review over ${criteria.questions.length} question(s)`,
              satisfied: status === 'pass' || status === 'partial' ? true : status === 'fail' ? false : null,
              expected: 'attributable manual review',
              actual: `review '${review.reviewId}' by '${review.reviewerId}' -> ${review.outcome}`,
              reasonCodes: ['CONTROL_MANUAL_REVIEW_APPLIED'],
            },
          ],
          ['CONTROL_MANUAL_REVIEW_APPLIED'],
          `Control '${control.controlId}' resolved by manual review '${review.reviewId}' (${review.outcome}): ${review.rationale}`,
        );
      }

      // -- Automated criteria.
      const evaluation = evaluateCriteria(control.criteria, resolutionsById, context.metrics);
      const status = statusFromOutcome(evaluation.outcome);
      const reasonCodes = [...new Set(evaluation.results.flatMap((result) => result.reasonCodes))];
      const unknownSummary = `Control '${control.controlId}' is unknown: evidence is unavailable, insufficient, or undecidable.`;
      const summaryByStatus: Record<string, string> = {
        pass: `Control '${control.controlId}' passed: all mandatory criteria are satisfied by accepted evidence.`,
        partial: `Control '${control.controlId}' partially passed: material criteria are satisfied but a documented gap remains.`,
        fail: `Control '${control.controlId}' failed: evidence demonstrates one or more required criteria are not met.`,
        unknown: unknownSummary,
      };
      return finish(status, evaluation.results, reasonCodes, summaryByStatus[status] ?? unknownSummary);
    },
  };
}
