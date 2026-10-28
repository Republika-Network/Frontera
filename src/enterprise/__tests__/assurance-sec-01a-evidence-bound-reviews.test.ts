import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { AssuranceError } from '../assurance/errors.js';
import { computeDigest } from '../governance-store/digest.js';
import { recomputeAssessmentIntegrity } from '../assurance/assessment.js';
import { createAssuranceControlEvaluator, type AssuranceEvaluationContext } from '../assurance/control-evaluator.js';
import { createSqliteAssuranceStore } from '../assurance/sqlite-assurance-store.js';
import { verifyAssuranceAssessment } from '../assurance/verification.js';
import { manualReviewEvidencePolicy } from '../assurance/manual-review-evidence.js';
import { AOC_SAF_FRAMEWORK_V1 } from '../assurance/saf-framework.js';
import { RN_SV_FRAMEWORK_ID, RN_SV_FRAMEWORK_V0_1, RN_SV_FRAMEWORK_VERSION, RN_SV_REVIEWER_ROLE } from '../assurance/frameworks/rn-sv-framework.js';
import { ASSURANCE_CUTOFF, ASSURANCE_ORG, buildAssuranceClock, buildAssuranceHarness, reviewerContext, type AssuranceTestHarness } from './assurance-support.js';
import type {
  AssuranceAssessment,
  AssuranceControlDefinition,
  AssuranceEvidenceReference,
  AssuranceEvidenceResolution,
  AssuranceManualReviewOutcome,
  AssuranceManualReviewRecord,
  AssuranceSubject,
} from '../assurance/contracts.js';

/**
 * ASSURE-SEC-01A: evidence-bound manual conclusions. Adversarial cases
 * against `rn.sv` 0.1.0 (the `control_bound` policy) through the service,
 * the control evaluator called directly, and assessment verification.
 * Synthetic data only.
 */

const SV_CONTROL_IDS = ['SV-01', 'SV-02', 'SV-03', 'SV-04', 'SV-05', 'SV-06', 'SV-07', 'SV-08', 'SV-09', 'SV-10'] as const;

const SUBJECT: AssuranceSubject = { subjectType: 'system', subjectId: 'synthetic-platform', organizationId: 'org-1', displayName: 'Synthetic Platform' };

function requirementOf(controlId: string): string {
  return `rn.sv.req.${controlId.toLowerCase()}`;
}

function artifact(id: string, overrides: Partial<AssuranceEvidenceReference> = {}): AssuranceEvidenceReference {
  return {
    evidenceReferenceId: id,
    evidenceType: 'external_artifact_reference',
    externalId: `artifact-${id}`,
    organizationId: 'org-1',
    subjectId: 'synthetic-platform',
    digest: computeDigest({ artifact: id }),
    occurredAt: '2026-06-10T00:00:00.000Z',
    collectedAt: '2026-06-14T00:00:00.000Z',
    verified: false,
    provenance: { sourceSystem: 'synthetic-test-fixture', sourceType: 'external_artifact_reference', collectedBy: 'preparer-1', collectedAt: '2026-06-14T00:00:00.000Z' },
    ...overrides,
  };
}

/** One artifact per control, each explicitly bound to its own control's requirement. */
const BOUND_EVIDENCE: readonly AssuranceEvidenceReference[] = SV_CONTROL_IDS.map((controlId) => artifact(`ev-${controlId}`, { requirementIds: [requirementOf(controlId)] }));

function controlById(controlId: string): AssuranceControlDefinition {
  const control = RN_SV_FRAMEWORK_V0_1.controls.find((candidate) => candidate.controlId === controlId);
  assert.ok(control);
  return control;
}

async function evaluated(harness: AssuranceTestHarness, evidence: readonly AssuranceEvidenceReference[]): Promise<AssuranceAssessment> {
  const created = await harness.service.createAssessment(ASSURANCE_ORG, {
    subject: SUBJECT,
    frameworkId: RN_SV_FRAMEWORK_ID,
    frameworkVersion: RN_SV_FRAMEWORK_VERSION,
    requestedBy: 'preparer-1',
    evidenceCutoffAt: ASSURANCE_CUTOFF,
    purpose: 'ASSURE-SEC-01A synthetic assessment',
  });
  await harness.service.collectEvidence(ASSURANCE_ORG, created.assessmentId, { manualEvidence: evidence });
  return harness.service.evaluateAssessment(ASSURANCE_ORG, created.assessmentId);
}

function review(assessmentId: string, controlId: string, outcome: AssuranceManualReviewOutcome, evidenceReferenceIds?: readonly string[]) {
  return {
    assessmentId,
    controlId,
    reviewerId: 'reviewer-1',
    reviewerRole: RN_SV_REVIEWER_ROLE,
    outcome,
    rationale: `Synthetic '${outcome}' review of ${controlId}.`,
    ...(evidenceReferenceIds !== undefined ? { evidenceReferenceIds } : {}),
  };
}

function rejectedWith(violation: string) {
  return (error: unknown) => error instanceof AssuranceError && error.code === 'ASSURANCE_MANUAL_REVIEW_INVALID' && error.details?.['violation'] === violation;
}

function statusOf(assessment: AssuranceAssessment, controlId: string): string | undefined {
  return assessment.controlEvaluations.find((evaluation) => evaluation.controlId === controlId)?.status;
}

async function expectRefusedAndNothingPersisted(harness: AssuranceTestHarness, assessmentId: string, input: ReturnType<typeof review>, violation: string): Promise<void> {
  await assert.rejects(() => harness.service.recordManualReview(reviewerContext(harness), input), rejectedWith(violation));
  assert.deepEqual(await harness.store.listManualReviews(ASSURANCE_ORG, assessmentId), [], 'a refused review must never reach the store');
}

describe('SEC-01A policy selection', () => {
  it('rn.sv controls use control_bound; the aoc.saf manual control keeps its declared citation rule', () => {
    for (const control of RN_SV_FRAMEWORK_V0_1.controls) {
      assert.equal(control.criteria.type === 'manual_review' && manualReviewEvidencePolicy(control.criteria), 'control_bound', control.controlId);
    }
    const safManual = AOC_SAF_FRAMEWORK_V1.controls.filter((control) => control.criteria.type === 'manual_review');
    assert.equal(safManual.length, 1);
    for (const control of safManual) {
      assert.equal(control.criteria.type === 'manual_review' && manualReviewEvidencePolicy(control.criteria), 'declared_citation');
    }
  });
});

describe('SEC-01A service: definitive outcomes require bound, accepted evidence (INV-01/02/03/05/10)', () => {
  for (const outcome of ['pass', 'partial', 'fail'] as const) {
    it(`#${outcome === 'pass' ? 1 : outcome === 'partial' ? 2 : 3} ${outcome.toUpperCase()} without evidence is refused and nothing is persisted`, async () => {
      const harness = buildAssuranceHarness({ framework: RN_SV_FRAMEWORK_V0_1 });
      const assessment = await evaluated(harness, BOUND_EVIDENCE);
      await expectRefusedAndNothingPersisted(harness, assessment.assessmentId, review(assessment.assessmentId, 'SV-08', outcome), 'MANUAL_REVIEW_EVIDENCE_MISSING');
      await expectRefusedAndNothingPersisted(harness, assessment.assessmentId, review(assessment.assessmentId, 'SV-08', outcome, []), 'MANUAL_REVIEW_EVIDENCE_MISSING');
    });
  }

  it('#4 PASS / FAIL citing a reference that does not exist is refused', async () => {
    const harness = buildAssuranceHarness({ framework: RN_SV_FRAMEWORK_V0_1 });
    const assessment = await evaluated(harness, BOUND_EVIDENCE);
    for (const outcome of ['pass', 'fail'] as const) {
      await expectRefusedAndNothingPersisted(harness, assessment.assessmentId, review(assessment.assessmentId, 'SV-08', outcome, ['no-such-evidence']), 'MANUAL_REVIEW_EVIDENCE_NOT_FOUND');
    }
  });

  it('#5 PASS citing a reference the resolver rejected is refused', async () => {
    const harness = buildAssuranceHarness({ framework: RN_SV_FRAMEWORK_V0_1 });
    // Occurs after the evidence cutoff -> rejected (EVIDENCE_INCOMPLETE), even though it names the right requirement.
    const late = artifact('ev-late', { requirementIds: [requirementOf('SV-08')], occurredAt: '2027-01-01T00:00:00.000Z' });
    const assessment = await evaluated(harness, [late]);
    assert.ok(assessment.evidenceResolutions.some((resolution) => resolution.rejectedEvidence.some((rejected) => rejected.evidenceReference.evidenceReferenceId === 'ev-late')));
    await expectRefusedAndNothingPersisted(harness, assessment.assessmentId, review(assessment.assessmentId, 'SV-08', 'pass', ['ev-late']), 'MANUAL_REVIEW_EVIDENCE_REJECTED');
  });

  it('#6 PASS citing evidence bound to another control, or bound to no control, is refused (INV-06)', async () => {
    const harness = buildAssuranceHarness({ framework: RN_SV_FRAMEWORK_V0_1 });
    const unbound = artifact('ev-unbound');
    const assessment = await evaluated(harness, [...BOUND_EVIDENCE, unbound]);
    // The resolver offers manual evidence to every requirement, so ev-SV-01 IS accepted in SV-08's resolution -- yet it was not supplied for SV-08.
    const sv08 = assessment.evidenceResolutions.find((resolution) => resolution.requirementId === requirementOf('SV-08'));
    assert.ok(sv08?.acceptedEvidence.some((reference) => reference.evidenceReferenceId === 'ev-SV-01'));
    await expectRefusedAndNothingPersisted(harness, assessment.assessmentId, review(assessment.assessmentId, 'SV-08', 'pass', ['ev-SV-01']), 'MANUAL_REVIEW_EVIDENCE_NOT_BOUND');
    await expectRefusedAndNothingPersisted(harness, assessment.assessmentId, review(assessment.assessmentId, 'SV-08', 'pass', ['ev-unbound']), 'MANUAL_REVIEW_EVIDENCE_NOT_BOUND');
    // One bound reference does not launder an unbound one cited alongside it.
    await expectRefusedAndNothingPersisted(harness, assessment.assessmentId, review(assessment.assessmentId, 'SV-08', 'pass', ['ev-SV-08', 'ev-SV-01']), 'MANUAL_REVIEW_EVIDENCE_NOT_BOUND');
  });

  it('explicit reuse: one artifact bound to two requirements supports both controls', async () => {
    const harness = buildAssuranceHarness({ framework: RN_SV_FRAMEWORK_V0_1 });
    const shared = artifact('ev-shared', { requirementIds: [requirementOf('SV-01'), requirementOf('SV-08')] });
    const assessment = await evaluated(harness, [shared]);
    await harness.service.recordManualReview(reviewerContext(harness), review(assessment.assessmentId, 'SV-01', 'pass', ['ev-shared']));
    await harness.service.recordManualReview(reviewerContext(harness), review(assessment.assessmentId, 'SV-08', 'pass', ['ev-shared']));
    const reevaluated = await harness.service.evaluateAssessment(ASSURANCE_ORG, assessment.assessmentId);
    assert.equal(statusOf(reevaluated, 'SV-01'), 'pass');
    assert.equal(statusOf(reevaluated, 'SV-08'), 'pass');
  });

  it('#7 PASS citing evidence that belongs to another assessment is refused (INV-07)', async () => {
    const harness = buildAssuranceHarness({ framework: RN_SV_FRAMEWORK_V0_1 });
    const other = await evaluated(harness, [artifact('ev-other-assessment', { requirementIds: [requirementOf('SV-08')] })]);
    assert.ok(other.evidenceReferences.some((reference) => reference.evidenceReferenceId === 'ev-other-assessment'));
    const assessment = await evaluated(harness, BOUND_EVIDENCE);
    await expectRefusedAndNothingPersisted(harness, assessment.assessmentId, review(assessment.assessmentId, 'SV-08', 'pass', ['ev-other-assessment']), 'MANUAL_REVIEW_EVIDENCE_NOT_FOUND');
  });

  it('#8 PASS citing evidence bound to another organization is refused (INV-08)', async () => {
    const harness = buildAssuranceHarness({ framework: RN_SV_FRAMEWORK_V0_1 });
    const foreign = artifact('ev-foreign', { organizationId: 'org-2', requirementIds: [requirementOf('SV-08')] });
    const assessment = await evaluated(harness, [foreign]);
    const rejected = assessment.evidenceResolutions.flatMap((resolution) => resolution.rejectedEvidence).find((entry) => entry.evidenceReference.evidenceReferenceId === 'ev-foreign');
    assert.ok(rejected?.reasonCodes.includes('EVIDENCE_WRONG_TENANT'));
    await expectRefusedAndNothingPersisted(harness, assessment.assessmentId, review(assessment.assessmentId, 'SV-08', 'pass', ['ev-foreign']), 'MANUAL_REVIEW_EVIDENCE_REJECTED');
  });

  it('#9/#10/#11 PASS, PARTIAL and FAIL citing bound, accepted evidence are recorded and applied', async () => {
    const harness = buildAssuranceHarness({ framework: RN_SV_FRAMEWORK_V0_1 });
    const assessment = await evaluated(harness, BOUND_EVIDENCE);
    await harness.service.recordManualReview(reviewerContext(harness), review(assessment.assessmentId, 'SV-01', 'pass', ['ev-SV-01']));
    await harness.service.recordManualReview(reviewerContext(harness), review(assessment.assessmentId, 'SV-02', 'partial', ['ev-SV-02']));
    await harness.service.recordManualReview(reviewerContext(harness), review(assessment.assessmentId, 'SV-03', 'fail', ['ev-SV-03']));
    const reevaluated = await harness.service.evaluateAssessment(ASSURANCE_ORG, assessment.assessmentId);
    assert.equal(statusOf(reevaluated, 'SV-01'), 'pass');
    assert.equal(statusOf(reevaluated, 'SV-02'), 'partial');
    assert.equal(statusOf(reevaluated, 'SV-03'), 'fail');
  });
});

describe('SEC-01A service: insufficient_evidence stays available and maps to unknown (INV-04)', () => {
  it('#12 insufficient_evidence with no evidence at all is accepted -> unknown, never fail', async () => {
    const harness = buildAssuranceHarness({ framework: RN_SV_FRAMEWORK_V0_1 });
    const assessment = await evaluated(harness, []);
    await harness.service.recordManualReview(reviewerContext(harness), review(assessment.assessmentId, 'SV-08', 'insufficient_evidence'));
    const reevaluated = await harness.service.evaluateAssessment(ASSURANCE_ORG, assessment.assessmentId);
    assert.equal(statusOf(reevaluated, 'SV-08'), 'unknown');
  });

  it('#13 insufficient_evidence with incomplete (rejected or unbound) evidence is accepted -> unknown', async () => {
    const harness = buildAssuranceHarness({ framework: RN_SV_FRAMEWORK_V0_1 });
    const late = artifact('ev-late', { requirementIds: [requirementOf('SV-08')], occurredAt: '2027-01-01T00:00:00.000Z' });
    const assessment = await evaluated(harness, [late, artifact('ev-unbound')]);
    await harness.service.recordManualReview(reviewerContext(harness), review(assessment.assessmentId, 'SV-08', 'insufficient_evidence', ['ev-late', 'ev-unbound']));
    const reevaluated = await harness.service.evaluateAssessment(ASSURANCE_ORG, assessment.assessmentId);
    assert.equal(statusOf(reevaluated, 'SV-08'), 'unknown');
    assert.notEqual(statusOf(reevaluated, 'SV-08'), 'fail');
  });
});

describe('SEC-01A contradictions (INV-09)', () => {
  it('#14 an unresolved contradiction refuses PASS/PARTIAL and keeps the control pending', async () => {
    const harness = buildAssuranceHarness({ framework: RN_SV_FRAMEWORK_V0_1 });
    const first = artifact('ev-a', { externalId: 'same-artifact', digest: computeDigest({ v: 1 }), requirementIds: [requirementOf('SV-08')] });
    const second = artifact('ev-b', { externalId: 'same-artifact', digest: computeDigest({ v: 2 }), requirementIds: [requirementOf('SV-08')] });
    const assessment = await evaluated(harness, [first, second]);
    assert.ok((assessment.evidenceResolutions.find((resolution) => resolution.requirementId === requirementOf('SV-08'))?.contradictions.length ?? 0) > 0);
    await expectRefusedAndNothingPersisted(harness, assessment.assessmentId, review(assessment.assessmentId, 'SV-08', 'pass', ['ev-a']), 'MANUAL_REVIEW_EVIDENCE_CONTRADICTED');
    await expectRefusedAndNothingPersisted(harness, assessment.assessmentId, review(assessment.assessmentId, 'SV-08', 'partial', ['ev-a', 'ev-b']), 'MANUAL_REVIEW_EVIDENCE_CONTRADICTED');
    const reevaluated = await harness.service.evaluateAssessment(ASSURANCE_ORG, assessment.assessmentId);
    assert.equal(statusOf(reevaluated, 'SV-08'), 'manual_review_required');
  });
});

describe('SEC-01A persisted state (INV-10/11)', () => {
  it('#15 a stored PASS whose evidence is withdrawn resolves nothing on re-evaluation', async () => {
    const harness = buildAssuranceHarness({ framework: RN_SV_FRAMEWORK_V0_1 });
    const assessment = await evaluated(harness, BOUND_EVIDENCE);
    await harness.service.recordManualReview(reviewerContext(harness), review(assessment.assessmentId, 'SV-08', 'pass', ['ev-SV-08']));
    const before = await harness.service.evaluateAssessment(ASSURANCE_ORG, assessment.assessmentId);
    assert.equal(statusOf(before, 'SV-08'), 'pass');

    // Simulate the evidence being withdrawn from the stored assessment (corruption, or a later store-level change).
    const withdrawn: AssuranceAssessment = {
      ...before,
      evidenceResolutions: before.evidenceResolutions.map((resolution) =>
        resolution.requirementId === requirementOf('SV-08') ? { ...resolution, status: 'unsatisfied', acceptedEvidence: [] } : resolution,
      ),
    };
    await harness.store.saveAssessment(ASSURANCE_ORG, withdrawn);
    const after = await harness.service.evaluateAssessment(ASSURANCE_ORG, assessment.assessmentId);
    const sv08 = after.controlEvaluations.find((evaluation) => evaluation.controlId === 'SV-08');
    assert.equal(sv08?.status, 'manual_review_required');
    assert.ok(sv08?.reasonCodes.includes('CONTROL_MANUAL_REVIEW_EVIDENCE_INVALID'));
  });

  it('#16 a valid review persists and recovers through the SQLite store with its citations intact', async () => {
    const store = await createSqliteAssuranceStore(':memory:', { now: buildAssuranceClock() });
    const harness = buildAssuranceHarness({ framework: RN_SV_FRAMEWORK_V0_1, store });
    const assessment = await evaluated(harness, BOUND_EVIDENCE);
    const recorded = await harness.service.recordManualReview(reviewerContext(harness), review(assessment.assessmentId, 'SV-08', 'pass', ['ev-SV-08']));
    const stored = await store.listManualReviews(ASSURANCE_ORG, assessment.assessmentId);
    assert.deepEqual(stored, [recorded]);
    const reloaded = await store.getAssessment(ASSURANCE_ORG, assessment.assessmentId);
    assert.deepEqual(reloaded?.evidenceReferences.find((reference) => reference.evidenceReferenceId === 'ev-SV-08')?.requirementIds, [requirementOf('SV-08')]);
    const reevaluated = await harness.service.evaluateAssessment(ASSURANCE_ORG, assessment.assessmentId);
    assert.equal(statusOf(reevaluated, 'SV-08'), 'pass');
  });

  it('#17 an invalid review cannot be persisted through the SQLite store either', async () => {
    const store = await createSqliteAssuranceStore(':memory:', { now: buildAssuranceClock() });
    const harness = buildAssuranceHarness({ framework: RN_SV_FRAMEWORK_V0_1, store });
    const assessment = await evaluated(harness, BOUND_EVIDENCE);
    await expectRefusedAndNothingPersisted(harness, assessment.assessmentId, review(assessment.assessmentId, 'SV-08', 'pass', ['ev-SV-01']), 'MANUAL_REVIEW_EVIDENCE_NOT_BOUND');
  });

  it('re-evaluation over the same evidence and reviews is semantically deterministic', async () => {
    const harness = buildAssuranceHarness({ framework: RN_SV_FRAMEWORK_V0_1 });
    const assessment = await evaluated(harness, BOUND_EVIDENCE);
    await harness.service.recordManualReview(reviewerContext(harness), review(assessment.assessmentId, 'SV-08', 'pass', ['ev-SV-08']));
    await harness.service.recordManualReview(reviewerContext(harness), review(assessment.assessmentId, 'SV-06', 'insufficient_evidence'));
    const semantics = (value: AssuranceAssessment) => ({
      statuses: value.controlEvaluations.map((evaluation) => [evaluation.controlId, evaluation.status, evaluation.reasonCodes]),
      score: value.score.normalizedScore,
      domains: value.domainAssessments.map((domain) => [domain.domainId, domain.status, domain.normalizedScore]),
    });
    const first = await harness.service.evaluateAssessment(ASSURANCE_ORG, assessment.assessmentId);
    const second = await harness.service.evaluateAssessment(ASSURANCE_ORG, assessment.assessmentId);
    assert.deepEqual(semantics(second), semantics(first));
  });

  it('#20 a completed assessment stays immutable: it cannot be re-evaluated under the new rule', async () => {
    const harness = buildAssuranceHarness({ framework: RN_SV_FRAMEWORK_V0_1 });
    const assessment = await evaluated(harness, BOUND_EVIDENCE);
    for (const controlId of SV_CONTROL_IDS) {
      await harness.service.recordManualReview(reviewerContext(harness), review(assessment.assessmentId, controlId, 'pass', [`ev-${controlId}`]));
    }
    await harness.service.evaluateAssessment(ASSURANCE_ORG, assessment.assessmentId);
    const completed = await harness.service.completeAssessment(ASSURANCE_ORG, assessment.assessmentId);
    await assert.rejects(
      () => harness.service.evaluateAssessment(ASSURANCE_ORG, assessment.assessmentId),
      (error: unknown) => error instanceof AssuranceError && error.code === 'ASSURANCE_ASSESSMENT_IMMUTABLE',
    );
    assert.deepEqual(await harness.service.getAssessment(ASSURANCE_ORG, assessment.assessmentId), completed);
  });
});

describe('SEC-01A control evaluator called directly (defense in depth)', () => {
  const evaluator = createAssuranceControlEvaluator();
  const control = controlById('SV-08');
  const scope = {
    scopeId: 'scope-direct',
    subject: SUBJECT,
    frameworkId: RN_SV_FRAMEWORK_ID,
    frameworkVersion: RN_SV_FRAMEWORK_VERSION,
    evidenceCutoffAt: ASSURANCE_CUTOFF,
    includeHistoricalEvidence: false,
    requestedBy: 'preparer-1',
    requestedAt: '2026-06-14T00:00:00.000Z',
  };

  function resolutionFor(controlId: string, accepted: readonly AssuranceEvidenceReference[]): AssuranceEvidenceResolution {
    return {
      requirementId: requirementOf(controlId),
      status: accepted.length > 0 ? 'satisfied' : 'unsatisfied',
      acceptedEvidence: accepted,
      rejectedEvidence: [],
      missingEvidence: [],
      contradictions: [],
      resolvedAt: '2026-06-14T00:00:00.000Z',
      resolverVersion: 'aoc.assurance-evidence-resolver.v1',
    };
  }

  function storedReview(outcome: AssuranceManualReviewOutcome, evidenceReferenceIds: readonly string[]): AssuranceManualReviewRecord {
    const base = {
      reviewId: 'review-direct',
      assessmentId: 'assessment-direct',
      controlId: 'SV-08',
      reviewerId: 'reviewer-1',
      reviewerRole: RN_SV_REVIEWER_ROLE,
      outcome,
      rationale: 'Stored without passing through the service.',
      evidenceReferenceIds,
      reviewedAt: '2026-06-14T12:00:00.000Z',
      reviewerAuthentication: 'assurance_reviewer_credential' as const,
    };
    return { ...base, reviewDigest: computeDigest(base) };
  }

  function contextWith(manualReviews: readonly AssuranceManualReviewRecord[]): AssuranceEvaluationContext {
    let counter = 0;
    return {
      assessmentId: 'assessment-direct',
      metrics: {},
      manualReviews,
      scoringModel: RN_SV_FRAMEWORK_V0_1.scoringModel,
      evaluatedAt: '2026-06-15T00:00:00.000Z',
      nextId: (prefix) => `${prefix}-${++counter}`,
    };
  }

  const bound = artifact('ev-SV-08', { requirementIds: [requirementOf('SV-08')] });

  it('ignores a stored PASS with no citations, an unbound citation, or another control\'s evidence', async () => {
    const otherControl = artifact('ev-SV-01', { requirementIds: [requirementOf('SV-01')] });
    const resolutions = [resolutionFor('SV-08', [bound, otherControl]), resolutionFor('SV-01', [otherControl])];
    for (const cited of [[], ['ev-SV-01'], ['missing']]) {
      const result = await evaluator.evaluate(control, scope, resolutions, contextWith([storedReview('pass', cited)]));
      assert.equal(result.status, 'manual_review_required', `cited ${JSON.stringify(cited)}`);
      assert.ok(result.reasonCodes.includes('CONTROL_MANUAL_REVIEW_EVIDENCE_INVALID'));
    }
  });

  it('ignores a stored PASS resting on evidence forged into another organization', async () => {
    const foreign = artifact('ev-foreign', { organizationId: 'org-2', requirementIds: [requirementOf('SV-08')] });
    const result = await evaluator.evaluate(control, scope, [resolutionFor('SV-08', [foreign])], contextWith([storedReview('pass', ['ev-foreign'])]));
    assert.equal(result.status, 'manual_review_required');
  });

  it('applies a stored review with bound evidence, and still maps insufficient_evidence to unknown without evidence', async () => {
    const pass = await evaluator.evaluate(control, scope, [resolutionFor('SV-08', [bound])], contextWith([storedReview('pass', ['ev-SV-08'])]));
    assert.equal(pass.status, 'pass');
    const unknown = await evaluator.evaluate(control, scope, [resolutionFor('SV-08', [])], contextWith([storedReview('insufficient_evidence', [])]));
    assert.equal(unknown.status, 'unknown');
  });
});

describe('SEC-01A assessment verification (integrity is not authenticity, INV-12)', () => {
  it('flags a re-sealed assessment whose definitive manual result has no bound evidence behind it', async () => {
    const harness = buildAssuranceHarness({ framework: RN_SV_FRAMEWORK_V0_1 });
    const assessment = await evaluated(harness, BOUND_EVIDENCE);
    for (const controlId of SV_CONTROL_IDS) {
      await harness.service.recordManualReview(reviewerContext(harness), review(assessment.assessmentId, controlId, 'pass', [`ev-${controlId}`]));
    }
    await harness.service.evaluateAssessment(ASSURANCE_ORG, assessment.assessmentId);
    const completed = await harness.service.completeAssessment(ASSURANCE_ORG, assessment.assessmentId);
    assert.equal(verifyAssuranceAssessment({ assessment: completed, framework: RN_SV_FRAMEWORK_V0_1, now: harness.now }).valid, true);

    // Strip SV-08's evidence and recompute every digest: integrity alone would call this valid.
    const stripped: AssuranceAssessment = {
      ...completed,
      evidenceResolutions: completed.evidenceResolutions.map((resolution) =>
        resolution.requirementId === requirementOf('SV-08') ? { ...resolution, status: 'unsatisfied', acceptedEvidence: [] } : resolution,
      ),
    };
    const resealed: AssuranceAssessment = { ...stripped, integrity: recomputeAssessmentIntegrity(stripped) };
    const verification = verifyAssuranceAssessment({ assessment: resealed, framework: RN_SV_FRAMEWORK_V0_1, now: harness.now });
    assert.equal(verification.checks.integrity, true, 'the digests are consistent');
    assert.equal(verification.checks.controls, false);
    assert.equal(verification.valid, false);
    assert.ok(verification.failures.some((failure) => failure.check === 'controls' && failure.message.includes('SV-08')));
  });
});
