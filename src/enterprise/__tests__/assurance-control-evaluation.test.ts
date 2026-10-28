import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createAssuranceControlEvaluator, type AssuranceEvaluationContext } from '../assurance/control-evaluator.js';
import { computeDigest } from '../governance-store/digest.js';
import type { AssuranceControlCriteria, AssuranceControlDefinition, AssuranceEvidenceResolution, AssuranceManualReviewRecord } from '../assurance/contracts.js';
import { buildAttestation, buildTestFramework, buildTestScope } from './assurance-support.js';

const framework = buildTestFramework();
const evaluator = createAssuranceControlEvaluator();

function controlById(controlId: string): AssuranceControlDefinition {
  const control = framework.controls.find((candidate) => candidate.controlId === controlId);
  assert.ok(control);
  return control;
}

function withCriteria(controlId: string, criteria: AssuranceControlCriteria): AssuranceControlDefinition {
  return { ...controlById(controlId), criteria };
}

function resolution(overrides: Partial<AssuranceEvidenceResolution> = {}): AssuranceEvidenceResolution {
  return {
    requirementId: 'req.attest',
    status: 'satisfied',
    acceptedEvidence: [buildAttestation('test.bool', true)],
    rejectedEvidence: [],
    missingEvidence: [],
    contradictions: [],
    resolvedAt: '2026-06-14T00:00:00.000Z',
    resolverVersion: 'aoc.assurance-evidence-resolver.v1',
    ...overrides,
  };
}

function buildContext(overrides: Partial<AssuranceEvaluationContext> = {}): AssuranceEvaluationContext {
  let counter = 0;
  return {
    assessmentId: 'assessment-1',
    metrics: {},
    manualReviews: [],
    scoringModel: framework.scoringModel,
    evaluatedAt: '2026-06-15T00:00:00.000Z',
    nextId: (prefix: string) => `${prefix}-${(counter += 1)}`,
    ...overrides,
  };
}

function review(outcome: AssuranceManualReviewRecord['outcome'], overrides: Partial<AssuranceManualReviewRecord> = {}): AssuranceManualReviewRecord {
  const base = {
    reviewId: 'review-1',
    assessmentId: 'assessment-1',
    controlId: 'c.manual',
    reviewerId: 'human-1',
    reviewerRole: 'reviewer',
    outcome,
    rationale: 'Reviewed against operating records.',
    evidenceReferenceIds: ['attest-x'],
    reviewedAt: '2026-06-14T12:00:00.000Z',
    // ASSURE-SEC-01B: a review the service recorded from an authenticated reviewer credential.
    reviewerAuthentication: 'assurance_reviewer_credential' as const,
  };
  return { ...base, ...overrides, reviewDigest: computeDigest(base) };
}

describe('Assurance Control Evaluator -- statuses (mission sections 7/17/80)', () => {
  const scope = buildTestScope();

  it('boolean criteria: pass, fail, and unknown (missing metric) are all distinct', async () => {
    const control = controlById('c.bool');
    const pass = await evaluator.evaluate(control, scope, [resolution()], buildContext({ metrics: { 'test.bool': true } }));
    assert.equal(pass.status, 'pass');
    assert.equal(pass.score, 100);

    const fail = await evaluator.evaluate(control, scope, [resolution()], buildContext({ metrics: { 'test.bool': false } }));
    assert.equal(fail.status, 'fail');
    assert.equal(fail.score, 0);

    const unknown = await evaluator.evaluate(control, scope, [resolution()], buildContext({ metrics: {} }));
    assert.equal(unknown.status, 'unknown');
    assert.ok(unknown.reasonCodes.includes('CONTROL_METRIC_UNAVAILABLE'));
    assert.notEqual(unknown.status, 'fail', 'unknown is never silently converted to fail');
  });

  it('threshold criteria: every operator compares deterministically', async () => {
    const cases: readonly { op: 'gte' | 'gt' | 'lte' | 'lt' | 'eq' | 'neq'; value: number; actual: number; expected: 'pass' | 'fail' }[] = [
      { op: 'gte', value: 2, actual: 2, expected: 'pass' },
      { op: 'gt', value: 2, actual: 2, expected: 'fail' },
      { op: 'lte', value: 2, actual: 3, expected: 'fail' },
      { op: 'lt', value: 2, actual: 1, expected: 'pass' },
      { op: 'eq', value: 0, actual: 0, expected: 'pass' },
      { op: 'neq', value: 0, actual: 0, expected: 'fail' },
    ];
    for (const testCase of cases) {
      const control = withCriteria('c.threshold', { type: 'threshold', metric: 'm', operator: testCase.op, value: testCase.value });
      const result = await evaluator.evaluate(control, scope, [], buildContext({ metrics: { m: testCase.actual } }));
      assert.equal(result.status, testCase.expected, `${testCase.op} ${testCase.value} with actual ${testCase.actual}`);
    }
  });

  it('evidence_presence: satisfied -> pass, partially satisfied -> partial, unavailable -> unknown (never fail)', async () => {
    const control = controlById('c.presence');
    const pass = await evaluator.evaluate(control, scope, [resolution()], buildContext());
    assert.equal(pass.status, 'pass');

    const partial = await evaluator.evaluate(control, scope, [resolution({ status: 'partially_satisfied' })], buildContext());
    assert.equal(partial.status, 'partial');

    const unknown = await evaluator.evaluate(control, scope, [resolution({ status: 'unavailable', acceptedEvidence: [] })], buildContext());
    assert.equal(unknown.status, 'unknown');

    const missing = await evaluator.evaluate(control, scope, [], buildContext());
    assert.equal(missing.status, 'unknown', 'absent evidence is unknown, not fail');
  });

  it('composite all / any / minimum aggregate deterministically', async () => {
    const boolTrue: AssuranceControlCriteria = { type: 'boolean', metric: 'a', expected: true };
    const boolFalse: AssuranceControlCriteria = { type: 'boolean', metric: 'b', expected: true };
    const metrics = { a: true, b: false };

    const all = await evaluator.evaluate(withCriteria('c.bool', { type: 'composite', operator: 'all', criteria: [boolTrue, boolFalse] }), scope, [], buildContext({ metrics }));
    assert.equal(all.status, 'fail');

    const any = await evaluator.evaluate(withCriteria('c.bool', { type: 'composite', operator: 'any', criteria: [boolTrue, boolFalse] }), scope, [], buildContext({ metrics }));
    assert.equal(any.status, 'pass');

    const minimum = await evaluator.evaluate(
      withCriteria('c.bool', { type: 'composite', operator: 'minimum', minimum: 2, criteria: [boolTrue, boolFalse] }),
      scope,
      [],
      buildContext({ metrics }),
    );
    assert.equal(minimum.status, 'fail');

    const minimumUndecided = await evaluator.evaluate(
      withCriteria('c.bool', { type: 'composite', operator: 'minimum', minimum: 2, criteria: [boolTrue, { type: 'boolean', metric: 'absent', expected: true }] }),
      scope,
      [],
      buildContext({ metrics }),
    );
    assert.equal(minimumUndecided.status, 'unknown');
  });

  it('not_applicable comes only from the framework applicability rule, with a rule-attributed justification', async () => {
    const control = controlById('c.agent-only');
    const orgScope = buildTestScope({ subject: { subjectType: 'organization', subjectId: 'org-1', organizationId: 'org-1' } });
    const result = await evaluator.evaluate(control, orgScope, [], buildContext({ metrics: { 'test.agent': true } }));
    assert.equal(result.status, 'not_applicable');
    assert.ok(result.reasonCodes.includes('CONTROL_NOT_APPLICABLE_BY_RULE'));
    assert.ok(result.summary.includes('does not apply to subject type'));

    const agentResult = await evaluator.evaluate(control, scope, [], buildContext({ metrics: { 'test.agent': true } }));
    assert.equal(agentResult.status, 'pass', 'the same control evaluates normally for an in-rule subject');
  });

  it('manual_review criteria without a recorded review yields manual_review_required (never pass)', async () => {
    const control = controlById('c.manual');
    const result = await evaluator.evaluate(control, scope, [resolution()], buildContext());
    assert.equal(result.status, 'manual_review_required');
    assert.ok(result.manualReview);
    assert.equal(result.manualReview?.requiredReviewerRole, 'reviewer');
    assert.ok(result.reasonCodes.includes('CONTROL_MANUAL_REVIEW_PENDING'));
  });

  it('an attributable manual review resolves the control: pass/partial/fail/insufficient_evidence -> unknown', async () => {
    const control = controlById('c.manual');
    for (const [outcome, expected] of [
      ['pass', 'pass'],
      ['partial', 'partial'],
      ['fail', 'fail'],
      ['insufficient_evidence', 'unknown'],
    ] as const) {
      const result = await evaluator.evaluate(control, scope, [resolution()], buildContext({ manualReviews: [review(outcome)] }));
      assert.equal(result.status, expected, `review outcome ${outcome}`);
      assert.ok(result.reasonCodes.includes('CONTROL_MANUAL_REVIEW_APPLIED'));
    }
  });

  it('a review by the wrong reviewer role is ignored -- the control stays manual_review_required', async () => {
    const control = controlById('c.manual');
    const result = await evaluator.evaluate(control, scope, [resolution()], buildContext({ manualReviews: [review('pass', { reviewerRole: 'intern' })] }));
    assert.equal(result.status, 'manual_review_required');
  });
});

describe('Assurance Control Evaluator -- contradictions (mission section 61)', () => {
  const scope = buildTestScope();

  function contradictedResolution(policy: 'fail' | 'manual_review' | 'unknown'): AssuranceEvidenceResolution {
    return resolution({
      contradictions: [{ evidenceReferenceIds: ['attest-1', 'attest-2'], reason: 'two digests for one artifact', appliedPolicy: policy }],
    });
  }

  it("contradiction policy 'fail' fails the control", async () => {
    const result = await evaluator.evaluate(controlById('c.bool'), scope, [contradictedResolution('fail')], buildContext({ metrics: { 'test.bool': true } }));
    assert.equal(result.status, 'fail');
    assert.ok(result.reasonCodes.includes('CONTROL_EVIDENCE_CONTRADICTORY'));
  });

  it("contradiction policy 'manual_review' requires manual review with the conflicting references recorded", async () => {
    const result = await evaluator.evaluate(controlById('c.bool'), scope, [contradictedResolution('manual_review')], buildContext({ metrics: { 'test.bool': true } }));
    assert.equal(result.status, 'manual_review_required');
    assert.deepEqual(result.manualReview?.requiredEvidenceReferenceIds, ['attest-1', 'attest-2']);
  });

  it("contradiction policy 'unknown' yields unknown", async () => {
    const result = await evaluator.evaluate(controlById('c.bool'), scope, [contradictedResolution('unknown')], buildContext({ metrics: { 'test.bool': true } }));
    assert.equal(result.status, 'unknown');
  });
});

describe('Assurance Control Evaluator -- determinism and confidence (mission sections 17/19)', () => {
  const scope = buildTestScope();

  it('repeated evaluation of identical inputs produces identical results (minus generated ids)', async () => {
    const control = controlById('c.bool');
    const evidence = [resolution()];
    const first = await evaluator.evaluate(control, scope, evidence, buildContext({ metrics: { 'test.bool': true } }));
    const second = await evaluator.evaluate(control, scope, evidence, buildContext({ metrics: { 'test.bool': true } }));
    const { controlEvaluationId: id1, ...rest1 } = first;
    const { controlEvaluationId: id2, ...rest2 } = second;
    assert.notEqual(id1, '');
    assert.notEqual(id2, '');
    assert.deepEqual(rest1, rest2);
  });

  it('evidence ordering does not change the outcome', async () => {
    const control = controlById('c.presence');
    const resolutionA = resolution();
    const resolutionB = resolution({ requirementId: 'req.other', status: 'unavailable', acceptedEvidence: [] });
    const forward = await evaluator.evaluate(control, scope, [resolutionA, resolutionB], buildContext());
    const backward = await evaluator.evaluate(control, scope, [resolutionB, resolutionA], buildContext());
    assert.equal(forward.status, backward.status);
    assert.deepEqual(forward.reasonCodes, backward.reasonCodes);
  });

  it('confidence is high with verified satisfied evidence, medium with unverified evidence, low for unknown', async () => {
    const control = controlById('c.bool');
    const high = await evaluator.evaluate(control, scope, [resolution()], buildContext({ metrics: { 'test.bool': true } }));
    assert.equal(high.confidence, 'high');

    const unverified = resolution({ acceptedEvidence: [buildAttestation('test.bool', true, { verified: false })] });
    const medium = await evaluator.evaluate(control, scope, [unverified], buildContext({ metrics: { 'test.bool': true } }));
    assert.equal(medium.confidence, 'medium');

    const low = await evaluator.evaluate(control, scope, [resolution()], buildContext({ metrics: {} }));
    assert.equal(low.confidence, 'low');
  });

  it('criteria results carry a full trace: metric, expected, actual, reason codes', async () => {
    const result = await evaluator.evaluate(controlById('c.threshold'), scope, [], buildContext({ metrics: { 'test.count': 5 } }));
    const trace = result.criteriaResults[0];
    assert.ok(trace);
    assert.equal(trace?.metric, 'test.count');
    assert.equal(trace?.expected, 'gte 2');
    assert.equal(trace?.actual, '5');
    assert.equal(trace?.satisfied, true);
  });
});
