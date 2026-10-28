import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { AssuranceError } from '../assurance/errors.js';
import { assertAssessmentTransition } from '../assurance/assessment.js';
import {
  ASSURANCE_ORG,
  ASSURANCE_ORG_2,
  buildAssuranceHarness,
  buildAttestation,
  buildTestFramework,
  buildTestSubject,
  persistHarnessFramework,
  reviewerContext,
  type AssuranceTestHarness,
} from './assurance-support.js';
import type { AssuranceAssessment, AssuranceEvidenceReference } from '../assurance/contracts.js';

const PASSING_EVIDENCE: readonly AssuranceEvidenceReference[] = [
  buildAttestation('test.bool', true),
  buildAttestation('test.count', 3),
  buildAttestation('test.agent', true),
];

async function runToEvaluated(harness: AssuranceTestHarness, evidence: readonly AssuranceEvidenceReference[] = PASSING_EVIDENCE): Promise<AssuranceAssessment> {
  const created = await harness.service.createAssessment(ASSURANCE_ORG, {
    subject: buildTestSubject(),
    frameworkId: 'test.framework',
    frameworkVersion: '1.0.0',
    requestedBy: 'assessor-1',
    evidenceCutoffAt: '2026-06-15T00:00:00.000Z',
  });
  await harness.service.collectEvidence(ASSURANCE_ORG, created.assessmentId, { manualEvidence: evidence });
  return harness.service.evaluateAssessment(ASSURANCE_ORG, created.assessmentId);
}

describe('Assurance assessment lifecycle (mission sections 36-40/84)', () => {
  it('walks created -> collecting_evidence -> evaluating|manual_review -> completed with an immutable scope', async () => {
    const harness = buildAssuranceHarness();
    const created = await harness.service.createAssessment(ASSURANCE_ORG, {
      subject: buildTestSubject(),
      frameworkId: 'test.framework',
      frameworkVersion: '1.0.0',
      requestedBy: 'assessor-1',
      evidenceCutoffAt: '2026-06-15T00:00:00.000Z',
      purpose: 'lifecycle test',
    });
    assert.equal(created.status, 'created');
    assert.equal(created.scope.evidenceCutoffAt, '2026-06-15T00:00:00.000Z');

    const collected = await harness.service.collectEvidence(ASSURANCE_ORG, created.assessmentId, { manualEvidence: PASSING_EVIDENCE });
    assert.equal(collected.status, 'collecting_evidence');
    assert.ok(collected.evidenceReferences.length > 0);
    assert.deepEqual(collected.scope, created.scope, 'the scope never changes after creation');

    const evaluated = await harness.service.evaluateAssessment(ASSURANCE_ORG, created.assessmentId);
    assert.equal(evaluated.status, 'manual_review', 'the c.manual control keeps the assessment in manual_review until reviewed');
    assert.equal(evaluated.controlEvaluations.length, 5);
    assert.deepEqual(evaluated.scope, created.scope);

    const completed = await harness.service.completeAssessment(ASSURANCE_ORG, created.assessmentId);
    assert.equal(completed.status, 'completed');
    assert.ok(completed.completedAt);
    assert.ok(completed.integrity.assessmentDigest.startsWith('sha256:'));
  });

  it('a completed assessment is immutable: no further content writes, no re-evaluation', async () => {
    const harness = buildAssuranceHarness();
    const evaluated = await runToEvaluated(harness);
    await harness.service.completeAssessment(ASSURANCE_ORG, evaluated.assessmentId);
    await assert.rejects(
      () => harness.service.evaluateAssessment(ASSURANCE_ORG, evaluated.assessmentId),
      (error: unknown) => error instanceof AssuranceError && error.code === 'ASSURANCE_ASSESSMENT_IMMUTABLE',
    );
    await assert.rejects(
      () => harness.service.collectEvidence(ASSURANCE_ORG, evaluated.assessmentId),
      (error: unknown) => error instanceof AssuranceError && error.code === 'ASSURANCE_ASSESSMENT_IMMUTABLE',
    );
  });

  it('completeAssessment refuses an unevaluated assessment', async () => {
    const harness = buildAssuranceHarness();
    const created = await harness.service.createAssessment(ASSURANCE_ORG, {
      subject: buildTestSubject(),
      frameworkId: 'test.framework',
      frameworkVersion: '1.0.0',
      requestedBy: 'assessor-1',
    });
    await assert.rejects(
      () => harness.service.completeAssessment(ASSURANCE_ORG, created.assessmentId),
      (error: unknown) => error instanceof AssuranceError && error.code === 'ASSURANCE_ASSESSMENT_IMMUTABLE',
    );
  });

  it("a framework whose manualReviewPolicy is not 'provisional' cannot complete with pending manual reviews", async () => {
    const framework = buildTestFramework({
      scoringModel: { ...buildTestFramework().scoringModel, manualReviewPolicy: 'zero' },
    });
    const harness = buildAssuranceHarness({ framework });
    const evaluated = await runToEvaluated(harness);
    assert.equal(evaluated.status, 'manual_review');
    await assert.rejects(
      () => harness.service.completeAssessment(ASSURANCE_ORG, evaluated.assessmentId),
      (error: unknown) => error instanceof AssuranceError && error.code === 'ASSURANCE_MANUAL_REVIEW_REQUIRED',
    );
  });

  it('invalid lifecycle transitions are rejected structurally', () => {
    assert.throws(() => assertAssessmentTransition('created', 'completed'), (error: unknown) => error instanceof AssuranceError);
    assert.throws(() => assertAssessmentTransition('completed', 'evaluating'), (error: unknown) => error instanceof AssuranceError);
    assert.throws(() => assertAssessmentTransition('failed', 'completed'), (error: unknown) => error instanceof AssuranceError);
    assert.throws(() => assertAssessmentTransition('superseded', 'completed'), (error: unknown) => error instanceof AssuranceError);
  });

  it('rejects a scope naming unknown domains/controls or an unregistered framework version', async () => {
    const harness = buildAssuranceHarness();
    const base = { subject: buildTestSubject(), frameworkId: 'test.framework', frameworkVersion: '1.0.0', requestedBy: 'assessor-1' };
    await assert.rejects(
      () => harness.service.createAssessment(ASSURANCE_ORG, { ...base, domainIds: ['d.missing'] }),
      (error: unknown) => error instanceof AssuranceError && error.code === 'ASSURANCE_SCOPE_INVALID',
    );
    await assert.rejects(
      () => harness.service.createAssessment(ASSURANCE_ORG, { ...base, controlIds: ['c.missing'] }),
      (error: unknown) => error instanceof AssuranceError && error.code === 'ASSURANCE_CONTROL_NOT_FOUND',
    );
    await assert.rejects(
      () => harness.service.createAssessment(ASSURANCE_ORG, { ...base, frameworkVersion: '9.9.9' }),
      (error: unknown) => error instanceof AssuranceError && error.code === 'ASSURANCE_FRAMEWORK_NOT_FOUND',
    );
  });

  it('a non-system caller may only assess subjects within its own organization', async () => {
    const harness = buildAssuranceHarness();
    await assert.rejects(
      () =>
        harness.service.createAssessment(ASSURANCE_ORG_2, {
          subject: buildTestSubject(),
          frameworkId: 'test.framework',
          frameworkVersion: '1.0.0',
          requestedBy: 'assessor-1',
        }),
      (error: unknown) => error instanceof AssuranceError && error.code === 'ASSURANCE_ACCESS_SCOPE_VIOLATION',
    );
  });
});

describe('Assurance manual review flow (mission sections 20-21/85)', () => {
  it('an attributable review by the required role resolves the pending control and lets completion proceed non-provisionally', async () => {
    const harness = buildAssuranceHarness();
    const evaluated = await runToEvaluated(harness);
    assert.equal(evaluated.status, 'manual_review');

    const review = await harness.service.recordManualReview(reviewerContext(harness, 'human-1'), {
      assessmentId: evaluated.assessmentId,
      controlId: 'c.manual',
      reviewerId: 'human-1',
      reviewerRole: 'reviewer',
      outcome: 'pass',
      rationale: 'Operations reviewed against records.',
      evidenceReferenceIds: ['attest-1'],
    });
    assert.ok(review.reviewDigest.startsWith('sha256:'));

    const reEvaluated = await harness.service.evaluateAssessment(ASSURANCE_ORG, evaluated.assessmentId);
    assert.equal(reEvaluated.status, 'evaluating', 'no pending manual reviews remain');
    const manualControl = reEvaluated.controlEvaluations.find((evaluation) => evaluation.controlId === 'c.manual');
    assert.equal(manualControl?.status, 'pass');

    const completed = await harness.service.completeAssessment(ASSURANCE_ORG, evaluated.assessmentId);
    assert.equal(completed.status, 'completed');
  });

  it('rejects a mismatched (or empty) declared reviewer, missing rationale, a role the reviewer does not hold, and missing required evidence references', async () => {
    const harness = buildAssuranceHarness();
    const evaluated = await runToEvaluated(harness);
    const base = {
      assessmentId: evaluated.assessmentId,
      controlId: 'c.manual',
      reviewerId: 'human-1',
      reviewerRole: 'reviewer',
      outcome: 'pass' as const,
      rationale: 'ok',
      evidenceReferenceIds: ['attest-1'],
    };
    await assert.rejects(
      () => harness.service.recordManualReview(reviewerContext(harness, 'human-1'), { ...base, reviewerId: '' }),
      (error: unknown) => error instanceof AssuranceError && error.code === 'ASSURANCE_REVIEWER_UNAUTHORIZED',
    );
    await assert.rejects(
      () => harness.service.recordManualReview(reviewerContext(harness, 'human-1'), { ...base, rationale: '   ' }),
      (error: unknown) => error instanceof AssuranceError && error.code === 'ASSURANCE_MANUAL_REVIEW_INVALID',
    );
    await assert.rejects(
      () => harness.service.recordManualReview(reviewerContext(harness, 'human-1'), { ...base, reviewerRole: 'intern' }),
      (error: unknown) => error instanceof AssuranceError && error.code === 'ASSURANCE_REVIEWER_UNAUTHORIZED',
    );
    await assert.rejects(
      () => harness.service.recordManualReview(reviewerContext(harness, 'human-1'), { ...base, evidenceReferenceIds: [] }),
      (error: unknown) => error instanceof AssuranceError && error.code === 'ASSURANCE_MANUAL_REVIEW_INVALID',
    );
  });
});

describe('Assurance reassessment (mission section 40/84)', () => {
  it('creates a new assessment id, preserves the prior one, references it, records the reason, and supersedes on completion', async () => {
    const harness = buildAssuranceHarness();
    const evaluated = await runToEvaluated(harness);
    const first = await harness.service.completeAssessment(ASSURANCE_ORG, evaluated.assessmentId);

    const reassessment = await harness.service.requestReassessment(ASSURANCE_ORG, {
      assessmentId: first.assessmentId,
      reason: 'Passport was suspended after completion.',
      requestedBy: 'assessor-2',
      evidenceCutoffAt: '2026-06-20T00:00:00.000Z',
    });
    assert.notEqual(reassessment.assessmentId, first.assessmentId);
    assert.equal(reassessment.previousAssessmentId, first.assessmentId);
    assert.equal(reassessment.supersedesAssessmentId, first.assessmentId);
    assert.equal(reassessment.reassessmentReason, 'Passport was suspended after completion.');
    assert.equal(reassessment.scope.evidenceCutoffAt, '2026-06-20T00:00:00.000Z');
    assert.notEqual(reassessment.scope.scopeId, first.scope.scopeId, 'a new immutable scope, not a mutation of the old one');

    // The prior assessment is untouched until the replacement completes.
    const priorBefore = await harness.service.getAssessment(ASSURANCE_ORG, first.assessmentId);
    assert.equal(priorBefore?.status, 'completed');

    await harness.service.collectEvidence(ASSURANCE_ORG, reassessment.assessmentId, { manualEvidence: PASSING_EVIDENCE });
    await harness.service.evaluateAssessment(ASSURANCE_ORG, reassessment.assessmentId);
    const completed = await harness.service.completeAssessment(ASSURANCE_ORG, reassessment.assessmentId);
    assert.equal(completed.status, 'completed');

    const priorAfter = await harness.service.getAssessment(ASSURANCE_ORG, first.assessmentId);
    assert.equal(priorAfter?.status, 'superseded');
    assert.equal(priorAfter?.supersededByAssessmentId, reassessment.assessmentId);
    assert.equal(priorAfter?.integrity.assessmentDigest, first.integrity.assessmentDigest, 'supersession never touches the frozen content or digests');
  });

  it('refuses to reassess a non-completed assessment and demands a reason', async () => {
    const harness = buildAssuranceHarness();
    const created = await harness.service.createAssessment(ASSURANCE_ORG, {
      subject: buildTestSubject(),
      frameworkId: 'test.framework',
      frameworkVersion: '1.0.0',
      requestedBy: 'assessor-1',
    });
    await assert.rejects(
      () => harness.service.requestReassessment(ASSURANCE_ORG, { assessmentId: created.assessmentId, reason: 'x', requestedBy: 'a' }),
      (error: unknown) => error instanceof AssuranceError && error.code === 'ASSURANCE_ASSESSMENT_INCOMPLETE',
    );
  });
});

describe('Assurance reports (mission sections 66-68)', () => {
  it('builds view-projected reports from a completed assessment without mutating it', async () => {
    const harness = buildAssuranceHarness();
    await persistHarnessFramework(harness);
    const evaluated = await runToEvaluated(harness, [buildAttestation('test.bool', true), buildAttestation('test.count', 1), buildAttestation('test.agent', true)]);
    const completed = await harness.service.completeAssessment(ASSURANCE_ORG, evaluated.assessmentId);

    const internal = await harness.service.buildAssuranceReport(ASSURANCE_ORG, completed.assessmentId, 'INTERNAL', 'assessor-1');
    const auditor = await harness.service.buildAssuranceReport(ASSURANCE_ORG, completed.assessmentId, 'AUDITOR', 'assessor-1');
    const customer = await harness.service.buildAssuranceReport(ASSURANCE_ORG, completed.assessmentId, 'CUSTOMER', 'assessor-1');
    const publicReport = await harness.service.buildAssuranceReport(ASSURANCE_ORG, completed.assessmentId, 'PUBLIC', 'assessor-1');

    // Executive summary always names framework, scope, and cutoff -- a score is never a bare number.
    assert.equal(internal.executiveSummary.frameworkId, 'test.framework');
    assert.equal(internal.executiveSummary.evidenceCutoffAt, completed.scope.evidenceCutoffAt);
    assert.ok(internal.executiveSummary.narrative.includes('not a universal trust score'));

    // Projection: INTERNAL/AUDITOR carry criteria and evidence; CUSTOMER strips them; PUBLIC carries no control/finding detail.
    assert.ok(internal.controlResults[0]?.criteriaResults);
    assert.ok(auditor.controlResults[0]?.criteriaResults);
    assert.equal(customer.controlResults[0]?.criteriaResults, undefined);
    assert.equal(customer.findings[0]?.remediation, undefined);
    assert.deepEqual(publicReport.controlResults, []);
    assert.deepEqual(publicReport.findings, []);
    assert.deepEqual(customer.evidenceIndex, []);
    assert.ok(internal.evidenceIndex.length > 0);

    // Each report has its own digest, distinct from the assessment digest; the assessment is untouched.
    assert.notEqual(internal.integrity.reportDigest, internal.integrity.assessmentDigest);
    assert.notEqual(internal.integrity.reportDigest, customer.integrity.reportDigest);
    const untouched = await harness.service.getAssessment(ASSURANCE_ORG, completed.assessmentId);
    assert.equal(untouched?.integrity.assessmentDigest, completed.integrity.assessmentDigest);
  });

  it('refuses to report on an incomplete assessment and rejects unknown views', async () => {
    const harness = buildAssuranceHarness();
    const evaluated = await runToEvaluated(harness);
    await assert.rejects(
      () => harness.service.buildAssuranceReport(ASSURANCE_ORG, evaluated.assessmentId, 'INTERNAL', 'assessor-1'),
      (error: unknown) => error instanceof AssuranceError && error.code === 'ASSURANCE_ASSESSMENT_INCOMPLETE',
    );
    await assert.rejects(
      () => harness.service.buildAssuranceReport(ASSURANCE_ORG, evaluated.assessmentId, 'TABLOID', 'assessor-1'),
      (error: unknown) => error instanceof AssuranceError && error.code === 'ASSURANCE_VALIDATION_ERROR',
    );
  });
});
