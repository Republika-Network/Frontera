import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { evaluateEligibility } from '../assurance/eligibility.js';
import { computeDomainAssessments, computeOverallScore } from '../assurance/scoring.js';
import { deriveFindingsFromEvaluations } from '../assurance/findings.js';
import { buildAttestation, buildHostVerifiedReference, buildTestFramework, buildTestScope } from './assurance-support.js';
import type { AssuranceControlEvaluation, AssuranceControlStatus, AssuranceEligibilityProfile, AssuranceEvidenceReference, AssuranceFinding } from '../assurance/contracts.js';

const framework = buildTestFramework();
const scope = buildTestScope();

function evaluation(controlId: string, domainId: string, status: AssuranceControlStatus): AssuranceControlEvaluation {
  return {
    controlEvaluationId: `eval-${controlId}`,
    assessmentId: 'assessment-1',
    controlId,
    controlVersion: '1.0.0',
    domainId,
    status,
    score: 0,
    maximumScore: 100,
    confidence: 'high',
    evidenceReferenceIds: [],
    rejectedEvidenceReferenceIds: [],
    criteriaResults: [],
    reasonCodes: [],
    summary: `${controlId}: ${status}`,
    evaluatedAt: 't',
    evaluatorVersion: 'aoc.assurance-evaluator.v1',
  };
}

const ALL_PASS: readonly AssuranceControlEvaluation[] = [
  evaluation('c.bool', 'd.core', 'pass'),
  evaluation('c.threshold', 'd.core', 'pass'),
  evaluation('c.presence', 'd.review', 'pass'),
  evaluation('c.manual', 'd.review', 'pass'),
  evaluation('c.agent-only', 'd.review', 'pass'),
];

function evaluate(options: {
  evaluations?: readonly AssuranceControlEvaluation[];
  profile?: AssuranceEligibilityProfile;
  findings?: readonly AssuranceFinding[];
  evidence?: readonly AssuranceEvidenceReference[];
}) {
  const evaluations = options.evaluations ?? ALL_PASS;
  let counter = 0;
  const nextId = (prefix: string) => `${prefix}-${(counter += 1)}`;
  const findings =
    options.findings ?? deriveFindingsFromEvaluations({ framework, evaluations, assessmentId: 'assessment-1', nextId, now: () => 't' });
  const domainAssessments = computeDomainAssessments({ framework, evaluations, findings, assessmentId: 'assessment-1', nextId, evaluatedAt: 't' });
  const score = computeOverallScore({ framework, domainAssessments, calculatedAt: 't' });
  const profile = options.profile ?? framework.eligibilityProfiles[0]!;
  return evaluateEligibility({
    framework,
    profile,
    scope,
    score,
    domainAssessments,
    controlEvaluations: evaluations,
    findings,
    evidenceReferences: options.evidence ?? [buildHostVerifiedReference('host-evidence-1')],
    evaluatedAt: 't',
  });
}

describe('Assurance eligibility (mission sections 33-35/83)', () => {
  it('a fully passing assessment is eligible for both profiles with deterministic reason codes', () => {
    const baseline = evaluate({});
    assert.equal(baseline.eligible, true);
    assert.equal(baseline.provisional, false);
    assert.deepEqual(baseline.reasonCodes, ['ELIGIBILITY_SATISFIED']);

    const strict = evaluate({ profile: framework.eligibilityProfiles[1]! });
    assert.equal(strict.eligible, true);
  });

  it('a score below minimumOverallScore blocks eligibility', () => {
    const evaluations = [
      evaluation('c.bool', 'd.core', 'fail'),
      evaluation('c.threshold', 'd.core', 'fail'),
      evaluation('c.presence', 'd.review', 'fail'),
      evaluation('c.manual', 'd.review', 'fail'),
      evaluation('c.agent-only', 'd.review', 'fail'),
    ];
    const result = evaluate({ evaluations });
    assert.equal(result.eligible, false);
    assert.equal(result.minimumScoreSatisfied, false);
    assert.ok(result.reasonCodes.includes('ELIGIBILITY_SCORE_BELOW_MINIMUM'));
  });

  it('a domain below its minimum blocks the strict profile', () => {
    const evaluations = [
      evaluation('c.bool', 'd.core', 'pass'),
      evaluation('c.threshold', 'd.core', 'fail'),
      evaluation('c.presence', 'd.review', 'pass'),
      evaluation('c.manual', 'd.review', 'pass'),
      evaluation('c.agent-only', 'd.review', 'pass'),
    ];
    const result = evaluate({ evaluations, profile: framework.eligibilityProfiles[1]! });
    assert.equal(result.domainThresholdsSatisfied, false);
    assert.ok(result.reasonCodes.includes('ELIGIBILITY_DOMAIN_BELOW_MINIMUM'));
  });

  it('a mandatory-control failure blocks eligibility and names the control', () => {
    const evaluations = ALL_PASS.map((entry) => (entry.controlId === 'c.bool' ? evaluation('c.bool', 'd.core', 'fail') : entry));
    const result = evaluate({ evaluations, profile: framework.eligibilityProfiles[1]! });
    assert.equal(result.eligible, false);
    assert.ok(result.blockingControlIds.includes('c.bool'));
    assert.ok(result.reasonCodes.includes('ELIGIBILITY_MANDATORY_CONTROL_NOT_PASSED'));
  });

  it("a framework blocking-control failure blocks eligibility under blockingRule 'both' even for profiles without mandatory controls", () => {
    const evaluations = ALL_PASS.map((entry) => (entry.controlId === 'c.bool' ? evaluation('c.bool', 'd.core', 'fail') : entry));
    const result = evaluate({ evaluations });
    assert.equal(result.eligible, false);
    assert.ok(result.blockingControlIds.includes('c.bool'));
  });

  it('a prohibited open finding severity blocks eligibility and names the finding', () => {
    const evaluations = ALL_PASS.map((entry) => (entry.controlId === 'c.bool' ? evaluation('c.bool', 'd.core', 'fail') : entry));
    const result = evaluate({ evaluations });
    assert.ok(result.blockingFindingIds.length > 0, 'the critical c.bool finding blocks the baseline profile');
    assert.ok(result.reasonCodes.includes('ELIGIBILITY_PROHIBITED_OPEN_FINDING'));
  });

  it('a verified-evidence rate below the profile minimum blocks eligibility', () => {
    const result = evaluate({
      profile: framework.eligibilityProfiles[1]!,
      evidence: [buildAttestation('a', true, { verified: false }), buildAttestation('b', true, { verified: false }), buildAttestation('c', true)],
    });
    assert.equal(result.evidenceRequirementsSatisfied, false);
    assert.ok(result.reasonCodes.includes('ELIGIBILITY_EVIDENCE_RATE_BELOW_MINIMUM'));
  });

  it('ASSURE-SEC-01C: manual evidence declaring itself verified does not count toward the verified-evidence rate', () => {
    const result = evaluate({
      profile: framework.eligibilityProfiles[1]!,
      evidence: [buildAttestation('a', true, { verified: true }), buildAttestation('b', true, { verified: true }), buildAttestation('c', true, { verified: true })],
    });
    assert.equal(result.evidenceRequirementsSatisfied, false);
    assert.ok(result.reasonCodes.includes('ELIGIBILITY_EVIDENCE_RATE_BELOW_MINIMUM'));
  });

  it('evidence older than maximumEvidenceAgeDays blocks eligibility', () => {
    const profile: AssuranceEligibilityProfile = { ...framework.eligibilityProfiles[0]!, profileId: 'aged', maximumEvidenceAgeDays: 1 };
    const result = evaluate({ profile, evidence: [buildAttestation('a', true, { occurredAt: '2026-01-01T00:00:00.000Z' })] });
    assert.equal(result.evidenceRequirementsSatisfied, false);
    assert.ok(result.reasonCodes.includes('ELIGIBILITY_EVIDENCE_TOO_OLD'));
  });

  it("pending manual review makes an otherwise-satisfying result PROVISIONAL under manualReviewPolicy 'provisional' -- never silently eligible", () => {
    const evaluations = ALL_PASS.map((entry) => (entry.controlId === 'c.manual' ? evaluation('c.manual', 'd.review', 'manual_review_required') : entry));
    const result = evaluate({ evaluations });
    assert.equal(result.eligible, false);
    assert.equal(result.provisional, true);
    assert.equal(result.manualReviewRequired, true);
    assert.ok(result.reasonCodes.includes('ELIGIBILITY_MANUAL_REVIEW_PENDING'));
    assert.ok(result.reasonCodes.includes('ELIGIBILITY_PROVISIONAL'));
  });

  it('a profile with manualReviewRequired: true is never automatically eligible', () => {
    const profile: AssuranceEligibilityProfile = { ...framework.eligibilityProfiles[0]!, profileId: 'human-gated', manualReviewRequired: true };
    const result = evaluate({ profile });
    assert.equal(result.eligible, false);
    assert.equal(result.manualReviewRequired, true);
    assert.ok(result.reasonCodes.includes('ELIGIBILITY_PROFILE_MANUAL_REVIEW_REQUIRED'));
  });

  it('multiple profiles evaluate independently over the same assessment', () => {
    const evaluations = ALL_PASS.map((entry) => (entry.controlId === 'c.threshold' ? evaluation('c.threshold', 'd.core', 'partial') : entry));
    const baseline = evaluate({ evaluations });
    const strict = evaluate({ evaluations, profile: framework.eligibilityProfiles[1]! });
    assert.equal(baseline.eligible, true);
    assert.equal(strict.eligible, false, 'partial in d.core drops below the strict 90 threshold');
  });

  it('eligibility results are deterministic: identical inputs, identical reason codes in identical order', () => {
    const first = evaluate({});
    const second = evaluate({});
    assert.deepEqual(first, second);
  });
});
