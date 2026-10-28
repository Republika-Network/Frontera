import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { AssuranceError } from '../assurance/errors.js';
import { computeDigest } from '../governance-store/digest.js';
import { validateAssuranceFramework } from '../assurance/framework-validation.js';
import { createAssuranceFrameworkRegistry, resolveFrameworkForAssessment } from '../assurance/framework-registry.js';
import { createAssuranceControlEvaluator } from '../assurance/control-evaluator.js';
import { verifyAssuranceAssessment } from '../assurance/verification.js';
import { AOC_SAF_FRAMEWORK_V1 } from '../assurance/saf-framework.js';
import { RN_SV_FRAMEWORK_ID, RN_SV_FRAMEWORK_V0_1, RN_SV_FRAMEWORK_VERSION, RN_SV_REVIEWER_ROLE } from '../assurance/frameworks/rn-sv-framework.js';
import { POLICY_PACK_PROHIBITED_OVERCLAIM_PHRASES } from '../../features/policy-pack-foundation/manifest/policy-pack-manifest-constants.js';
import { ASSURANCE_CUTOFF, ASSURANCE_ORG, buildAssuranceHarness, buildTestScope, type AssuranceTestHarness } from './assurance-support.js';
import type {
  AssuranceAssessment,
  AssuranceControlStatus,
  AssuranceEvidenceReference,
  AssuranceManualReviewOutcome,
  AssuranceSubject,
} from '../assurance/contracts.js';

/**
 * ASSURE-CAT-01: the `rn.sv` 0.1.0 Republika Sovereignty Assessment framework.
 *
 * Golden digests were generated once from the complete, validated objects
 * (`computeDigest`, `aoc.canonical-json.v1`) on the ASSURE-CAT-01 branch.
 * A content change to `rn.sv` without a new framework version must fail
 * here; the `aoc.saf` digest pins that this PR leaves SAF untouched.
 */
const RN_SV_GOLDEN_DIGEST = 'sha256:e71fafe1a10af95514823e35d43138b1b93cdb72e37765200447a37748c13a58';
const AOC_SAF_GOLDEN_DIGEST = 'sha256:4c0b5c65a0b8cfe40de726f26d80b80224fac6ca80fe2c221f7a734548899bb9';

const SV_CONTROL_IDS = ['SV-01', 'SV-02', 'SV-03', 'SV-04', 'SV-05', 'SV-06', 'SV-07', 'SV-08', 'SV-09', 'SV-10'] as const;

const SYNTHETIC_SUBJECT: AssuranceSubject = {
  subjectType: 'system',
  subjectId: 'synthetic-platform',
  organizationId: 'org-1',
  displayName: 'Synthetic Platform',
};

/**
 * Synthetic customer artifact reference -- deliberately `verified: false`: nothing here vouches for it except the reviewer.
 * It is explicitly bound to its own control's requirement (ASSURE-SEC-01A), so it supports a conclusion on that control only.
 */
function syntheticArtifact(controlId: string): AssuranceEvidenceReference {
  return {
    evidenceReferenceId: `synthetic-evidence-${controlId}`,
    evidenceType: 'external_artifact_reference',
    externalId: `synthetic-artifact-${controlId}`,
    organizationId: 'org-1',
    subjectId: 'synthetic-platform',
    digest: computeDigest({ syntheticArtifact: controlId }),
    occurredAt: '2026-06-10T00:00:00.000Z',
    collectedAt: '2026-06-14T00:00:00.000Z',
    verified: false,
    requirementIds: [`rn.sv.req.${controlId.toLowerCase()}`],
    provenance: {
      sourceSystem: 'synthetic-test-fixture',
      sourceType: 'external_artifact_reference',
      collectedBy: 'preparer-1',
      collectedAt: '2026-06-14T00:00:00.000Z',
    },
  };
}

const SYNTHETIC_EVIDENCE: readonly AssuranceEvidenceReference[] = SV_CONTROL_IDS.map((controlId) => syntheticArtifact(controlId));

function rnSvHarness(): AssuranceTestHarness {
  return buildAssuranceHarness({ framework: RN_SV_FRAMEWORK_V0_1 });
}

async function evaluateRnSv(harness: AssuranceTestHarness, evidence: readonly AssuranceEvidenceReference[]): Promise<AssuranceAssessment> {
  const created = await harness.service.createAssessment(ASSURANCE_ORG, {
    subject: SYNTHETIC_SUBJECT,
    frameworkId: RN_SV_FRAMEWORK_ID,
    frameworkVersion: RN_SV_FRAMEWORK_VERSION,
    requestedBy: 'preparer-1',
    evidenceCutoffAt: ASSURANCE_CUTOFF,
    purpose: 'ASSURE-CAT-01 synthetic assessment',
  });
  await harness.service.collectEvidence(ASSURANCE_ORG, created.assessmentId, { manualEvidence: evidence });
  return harness.service.evaluateAssessment(ASSURANCE_ORG, created.assessmentId);
}

async function recordReviews(
  harness: AssuranceTestHarness,
  assessmentId: string,
  outcomes: Readonly<Record<string, AssuranceManualReviewOutcome>>,
  citeEvidence: boolean,
): Promise<void> {
  for (const [controlId, outcome] of Object.entries(outcomes)) {
    await harness.service.recordManualReview(ASSURANCE_ORG, {
      assessmentId,
      controlId,
      reviewerId: 'reviewer-1',
      reviewerRole: RN_SV_REVIEWER_ROLE,
      outcome,
      rationale: `Synthetic '${outcome}' review of ${controlId}.`,
      ...(citeEvidence ? { evidenceReferenceIds: [`synthetic-evidence-${controlId}`] } : {}),
    });
  }
}

function allControls(outcome: AssuranceManualReviewOutcome): Record<string, AssuranceManualReviewOutcome> {
  return Object.fromEntries(SV_CONTROL_IDS.map((controlId) => [controlId, outcome]));
}

function statusesOf(assessment: AssuranceAssessment): Record<string, AssuranceControlStatus> {
  return Object.fromEntries(assessment.controlEvaluations.map((evaluation) => [evaluation.controlId, evaluation.status]));
}

describe('rn.sv 0.1.0 framework definition (ASSURE-CAT-01)', () => {
  it('passes validateAssuranceFramework with no issues', () => {
    const result = validateAssuranceFramework(RN_SV_FRAMEWORK_V0_1);
    assert.deepEqual(result.issues, []);
    assert.equal(result.valid, true);
  });

  it('defines exactly the ten SV controls, in order, bound to rn.sv@0.1.0', () => {
    assert.equal(RN_SV_FRAMEWORK_V0_1.frameworkId, 'rn.sv');
    assert.equal(RN_SV_FRAMEWORK_V0_1.frameworkVersion, '0.1.0');
    assert.equal(RN_SV_FRAMEWORK_V0_1.name, 'Republika Sovereignty Assessment');
    assert.deepEqual(
      RN_SV_FRAMEWORK_V0_1.controls.map((control) => control.controlId),
      [...SV_CONTROL_IDS],
    );
    assert.equal(new Set(RN_SV_FRAMEWORK_V0_1.controls.map((control) => control.controlId)).size, 10);
    for (const control of RN_SV_FRAMEWORK_V0_1.controls) {
      assert.equal(control.frameworkId, 'rn.sv');
      assert.equal(control.frameworkVersion, '0.1.0');
    }
  });

  it('places every control in exactly one defined domain', () => {
    const domainIds = new Set(RN_SV_FRAMEWORK_V0_1.domains.map((domain) => domain.domainId));
    const listed = RN_SV_FRAMEWORK_V0_1.domains.flatMap((domain) => domain.controlIds);
    assert.deepEqual([...listed].sort(), [...SV_CONTROL_IDS]);
    for (const control of RN_SV_FRAMEWORK_V0_1.controls) {
      assert.ok(domainIds.has(control.domainId), `${control.controlId} names an unknown domain`);
      const owner = RN_SV_FRAMEWORK_V0_1.domains.find((domain) => domain.controlIds.includes(control.controlId));
      assert.equal(owner?.domainId, control.domainId);
    }
  });

  it('gives every control one manually supplied, organization-bound requirement that never trusts a self-declared verified flag', () => {
    const requirements = new Map(RN_SV_FRAMEWORK_V0_1.evidenceRequirements.map((requirement) => [requirement.requirementId, requirement]));
    assert.equal(requirements.size, 10);
    for (const control of RN_SV_FRAMEWORK_V0_1.controls) {
      assert.equal(control.evidenceRequirementIds.length, 1);
      const requirement = requirements.get(control.evidenceRequirementIds[0] ?? '');
      assert.ok(requirement, `${control.controlId} references a missing requirement`);
      assert.deepEqual(requirement.acceptedEvidenceTypes, ['external_artifact_reference', 'control_attestation']);
      assert.equal(requirement.manualEvidenceAllowed, true);
      assert.equal(requirement.mustBeOrganizationBound, true);
      assert.equal(requirement.contradictionPolicy, 'manual_review');
      assert.equal(requirement.mustBeVerified, undefined, 'a self-declared verified flag must not be a requirement');
    }
  });

  it('makes every control a structured manual review by assure.reviewer with a complete control profile', () => {
    const metadata = RN_SV_FRAMEWORK_V0_1.metadata ?? {};
    const profiles = metadata['controlProfiles'] as Readonly<Record<string, Readonly<Record<string, unknown>>>>;
    const spanishTitles = (metadata['localizedTitles'] as Readonly<Record<string, Readonly<Record<string, string>>>>)['es'] ?? {};
    for (const control of RN_SV_FRAMEWORK_V0_1.controls) {
      assert.equal(control.evaluationMethod, 'manual_review');
      assert.equal(control.criteria.type, 'manual_review');
      if (control.criteria.type !== 'manual_review') continue;
      assert.equal(control.criteria.requiredReviewerRole, RN_SV_REVIEWER_ROLE);
      assert.ok(control.criteria.questions.length >= 3, `${control.controlId} needs structured questions`);
      assert.ok((control.remediationGuidance ?? '').length > 0, `${control.controlId} needs remediation guidance`);
      assert.equal(control.severityMapping?.unknown, 'low', 'an evidence gap is never reported at failure severity');
      assert.equal(control.severityMapping?.manual_review_required, 'informational');
      assert.ok(control.severityMapping?.fail !== undefined);

      const profile = profiles[control.controlId];
      assert.ok(profile, `${control.controlId} has no control profile`);
      for (const field of ['risk', 'protectedAsset', 'satisfiedWhen', 'notSatisfiedWhen', 'inconclusiveWhen', 'revalidation']) {
        assert.equal(typeof profile[field], 'string', `${control.controlId}.${field}`);
        assert.ok((profile[field] as string).length > 0, `${control.controlId}.${field}`);
      }
      assert.ok(Array.isArray(profile['limitations']) && profile['limitations'].length > 0, `${control.controlId}.limitations`);
      assert.ok(Array.isArray(profile['verificationMethods']) && profile['verificationMethods'].length > 0, `${control.controlId}.verificationMethods`);
      assert.ok((spanishTitles[control.controlId] ?? '').length > 0, `${control.controlId} has no Spanish title`);
    }
    assert.equal(metadata['reviewerRole'], RN_SV_REVIEWER_ROLE);
    assert.equal((metadata['commercialUse'] as Readonly<Record<string, unknown>>)['status'], 'restricted');
  });

  it('is deeply immutable', () => {
    const control = RN_SV_FRAMEWORK_V0_1.controls[0];
    assert.ok(control);
    assert.ok(Object.isFrozen(RN_SV_FRAMEWORK_V0_1));
    assert.ok(Object.isFrozen(RN_SV_FRAMEWORK_V0_1.controls));
    assert.ok(Object.isFrozen(control));
    assert.ok(Object.isFrozen(control.criteria));
    assert.ok(Object.isFrozen(RN_SV_FRAMEWORK_V0_1.metadata?.['controlProfiles']));
    assert.throws(() => {
      (RN_SV_FRAMEWORK_V0_1 as { frameworkVersion: string }).frameworkVersion = '0.1.1';
    }, TypeError);
    assert.equal(RN_SV_FRAMEWORK_V0_1.frameworkVersion, '0.1.0');
  });
});

describe('rn.sv 0.1.0 registry behaviour', () => {
  it('registers alongside aoc.saf without replacing it', () => {
    const registry = createAssuranceFrameworkRegistry();
    registry.register(AOC_SAF_FRAMEWORK_V1);
    registry.register(RN_SV_FRAMEWORK_V0_1);
    assert.deepEqual(
      registry.list().map((summary) => `${summary.frameworkId}@${summary.frameworkVersion}`).sort(),
      ['aoc.saf@1.0.0', 'rn.sv@0.1.0'],
    );
    assert.equal(registry.get('aoc.saf', '1.0.0'), AOC_SAF_FRAMEWORK_V1);
    assert.equal(registry.get('rn.sv', '0.1.0'), RN_SV_FRAMEWORK_V0_1);
    assert.equal(resolveFrameworkForAssessment(registry, 'rn.sv', '0.1.0'), RN_SV_FRAMEWORK_V0_1);
  });

  it('rejects a duplicate rn.sv@0.1.0 registration', () => {
    const registry = createAssuranceFrameworkRegistry();
    registry.register(RN_SV_FRAMEWORK_V0_1);
    assert.throws(
      () => registry.register(RN_SV_FRAMEWORK_V0_1),
      (error: unknown) => error instanceof AssuranceError && error.code === 'ASSURANCE_FRAMEWORK_INVALID',
    );
  });

  it('leaves the aoc.saf definition (including its scoring model) byte-identical', () => {
    assert.equal(computeDigest(AOC_SAF_FRAMEWORK_V1), AOC_SAF_GOLDEN_DIGEST);
  });
});

describe('rn.sv 0.1.0 manual evaluation', () => {
  it('passes no control without a review, even with evidence, and refuses to complete', async () => {
    const harness = rnSvHarness();
    const evaluated = await evaluateRnSv(harness, SYNTHETIC_EVIDENCE);
    assert.equal(evaluated.status, 'manual_review');
    assert.deepEqual(Object.values(statusesOf(evaluated)), SV_CONTROL_IDS.map(() => 'manual_review_required'));
    assert.ok(evaluated.findings.every((finding) => finding.findingType === 'manual_review' && finding.severity === 'informational'));
    await assert.rejects(
      () => harness.service.completeAssessment(ASSURANCE_ORG, evaluated.assessmentId),
      (error: unknown) => error instanceof AssuranceError && error.code === 'ASSURANCE_MANUAL_REVIEW_REQUIRED',
    );
  });

  it('never fails a control for absent evidence: insufficient_evidence reviews resolve to unknown evidence gaps', async () => {
    const harness = rnSvHarness();
    const evaluated = await evaluateRnSv(harness, []);
    assert.equal(evaluated.evidenceReferences.length, 0);
    assert.ok(evaluated.evidenceResolutions.every((resolution) => resolution.status === 'unsatisfied'));
    assert.ok(evaluated.controlEvaluations.every((evaluation) => evaluation.status === 'manual_review_required'));

    // The reviewer can record a conclusion without citing evidence that does not exist.
    await recordReviews(harness, evaluated.assessmentId, allControls('insufficient_evidence'), false);
    const reevaluated = await harness.service.evaluateAssessment(ASSURANCE_ORG, evaluated.assessmentId);
    assert.deepEqual(Object.values(statusesOf(reevaluated)), SV_CONTROL_IDS.map(() => 'unknown'));
    assert.ok(reevaluated.controlEvaluations.every((evaluation) => evaluation.status !== 'fail'));
    assert.equal(reevaluated.findings.length, 10);
    assert.ok(reevaluated.findings.every((finding) => finding.findingType === 'evidence_gap' && finding.severity === 'low'));

    const completed = await harness.service.completeAssessment(ASSURANCE_ORG, evaluated.assessmentId);
    assert.equal(completed.status, 'completed');
  });

  it('refuses a review by the wrong role at the service, and the evaluator ignores one that is already recorded', async () => {
    const harness = rnSvHarness();
    const evaluated = await evaluateRnSv(harness, SYNTHETIC_EVIDENCE);
    for (const reviewerRole of ['assurance-reviewer', undefined]) {
      await assert.rejects(
        () =>
          harness.service.recordManualReview(ASSURANCE_ORG, {
            assessmentId: evaluated.assessmentId,
            controlId: 'SV-01',
            reviewerId: 'reviewer-1',
            ...(reviewerRole !== undefined ? { reviewerRole } : {}),
            outcome: 'pass',
            rationale: 'Wrong-role review.',
          }),
        (error: unknown) => error instanceof AssuranceError && error.code === 'ASSURANCE_MANUAL_REVIEW_INVALID',
      );
    }

    const control = RN_SV_FRAMEWORK_V0_1.controls[0];
    assert.ok(control);
    const evaluation = await createAssuranceControlEvaluator().evaluate(
      control,
      buildTestScope({ subject: SYNTHETIC_SUBJECT, frameworkId: RN_SV_FRAMEWORK_ID, frameworkVersion: RN_SV_FRAMEWORK_VERSION }),
      [],
      {
        assessmentId: 'assessment-wrong-role',
        metrics: {},
        manualReviews: [
          {
            reviewId: 'review-wrong-role',
            assessmentId: 'assessment-wrong-role',
            controlId: control.controlId,
            reviewerId: 'reviewer-1',
            reviewerRole: 'assurance-reviewer',
            outcome: 'pass',
            rationale: 'Recorded under the wrong role.',
            evidenceReferenceIds: [],
            reviewedAt: '2026-06-14T00:00:00.000Z',
            reviewDigest: 'sha256:wrong-role',
          },
        ],
        scoringModel: RN_SV_FRAMEWORK_V0_1.scoringModel,
        evaluatedAt: '2026-06-14T00:00:00.000Z',
        nextId: (prefix) => `${prefix}-1`,
      },
    );
    assert.equal(evaluation.status, 'manual_review_required');
  });

  it('maps valid reviews one-to-one through the existing lifecycle: manual_review -> evaluating -> completed', async () => {
    const harness = rnSvHarness();
    const evaluated = await evaluateRnSv(harness, SYNTHETIC_EVIDENCE);
    assert.equal(evaluated.status, 'manual_review');

    await recordReviews(harness, evaluated.assessmentId, { ...allControls('pass'), 'SV-02': 'partial', 'SV-03': 'fail', 'SV-04': 'insufficient_evidence' }, true);
    const reevaluated = await harness.service.evaluateAssessment(ASSURANCE_ORG, evaluated.assessmentId);
    assert.equal(reevaluated.status, 'evaluating');
    assert.deepEqual(statusesOf(reevaluated), {
      'SV-01': 'pass',
      'SV-02': 'partial',
      'SV-03': 'fail',
      'SV-04': 'unknown',
      'SV-05': 'pass',
      'SV-06': 'pass',
      'SV-07': 'pass',
      'SV-08': 'pass',
      'SV-09': 'pass',
      'SV-10': 'pass',
    });

    const completed = await harness.service.completeAssessment(ASSURANCE_ORG, evaluated.assessmentId);
    assert.equal(completed.status, 'completed');
  });
});

describe('rn.sv 0.1.0 scoring', () => {
  it('never scores unknown as demonstrated compliance', async () => {
    const harness = rnSvHarness();
    const evaluated = await evaluateRnSv(harness, []);
    await recordReviews(harness, evaluated.assessmentId, allControls('insufficient_evidence'), false);
    const reevaluated = await harness.service.evaluateAssessment(ASSURANCE_ORG, evaluated.assessmentId);
    assert.equal(reevaluated.score.normalizedScore, 0);
    for (const domain of reevaluated.domainAssessments) {
      assert.equal(domain.normalizedScore, 0, `${domain.domainId} scored an unknown as compliance`);
      assert.notEqual(domain.status, 'healthy');
      assert.ok(domain.contributions.every((contribution) => !contribution.excluded && contribution.rawValue === 0));
    }

    // Contrast: demonstrated compliance scores in full.
    const passing = rnSvHarness();
    const passingEvaluated = await evaluateRnSv(passing, SYNTHETIC_EVIDENCE);
    await recordReviews(passing, passingEvaluated.assessmentId, allControls('pass'), true);
    const passingReevaluated = await passing.service.evaluateAssessment(ASSURANCE_ORG, passingEvaluated.assessmentId);
    assert.equal(passingReevaluated.score.normalizedScore, 100);
    assert.ok(passingReevaluated.domainAssessments.every((domain) => domain.status === 'healthy'));
  });

  it('produces no eligibility result of any kind and carries no overclaim phrase', async () => {
    assert.deepEqual(RN_SV_FRAMEWORK_V0_1.eligibilityProfiles, []);
    const harness = rnSvHarness();
    const evaluated = await evaluateRnSv(harness, SYNTHETIC_EVIDENCE);
    await recordReviews(harness, evaluated.assessmentId, allControls('pass'), true);
    await harness.service.evaluateAssessment(ASSURANCE_ORG, evaluated.assessmentId);
    const completed = await harness.service.completeAssessment(ASSURANCE_ORG, evaluated.assessmentId);
    assert.deepEqual(completed.eligibility, []);
    assert.deepEqual(await harness.service.evaluateEligibility(ASSURANCE_ORG, evaluated.assessmentId), []);

    const text = JSON.stringify(RN_SV_FRAMEWORK_V0_1).toLowerCase();
    for (const phrase of POLICY_PACK_PROHIBITED_OVERCLAIM_PHRASES) {
      assert.ok(!text.includes(phrase.toLowerCase()), `framework text contains overclaim phrase '${phrase}'`);
    }
  });

  it('lets a failed SV-06 or SV-08 override its domain average (domain_override)', async () => {
    for (const [blockingControl, domainId] of [
      ['SV-06', 'rn.sv.data-boundaries'],
      ['SV-08', 'rn.sv.authority'],
    ] as const) {
      const harness = rnSvHarness();
      const evaluated = await evaluateRnSv(harness, SYNTHETIC_EVIDENCE);
      await recordReviews(harness, evaluated.assessmentId, { ...allControls('pass'), [blockingControl]: 'fail' }, true);
      const reevaluated = await harness.service.evaluateAssessment(ASSURANCE_ORG, evaluated.assessmentId);
      const domain = reevaluated.domainAssessments.find((candidate) => candidate.domainId === domainId);
      assert.ok(domain);
      assert.ok(domain.normalizedScore > 0, 'the numeric average alone would not flag the domain');
      assert.equal(domain.status, 'unhealthy');
      assert.equal(domain.blockingFindingIds.length, 1);
      const finding = reevaluated.findings.find((candidate) => candidate.controlId === blockingControl);
      assert.equal(finding?.severity, 'critical');
      assert.equal(finding?.findingType, 'control_failure');
    }
  });
});

describe('rn.sv 0.1.0 integrity', () => {
  it('matches the golden digest', () => {
    assert.equal(computeDigest(RN_SV_FRAMEWORK_V0_1), RN_SV_GOLDEN_DIGEST);
  });

  it('yields a different digest for any content change under the same version', () => {
    const questionChanged = JSON.parse(JSON.stringify(RN_SV_FRAMEWORK_V0_1)) as { frameworkVersion: string; controls: { criteria: { questions: string[] } }[] };
    const firstQuestions = questionChanged.controls[0]?.criteria.questions;
    assert.ok(firstQuestions);
    firstQuestions[0] = `${firstQuestions[0] ?? ''} (edited)`;
    assert.equal(questionChanged.frameworkVersion, RN_SV_FRAMEWORK_VERSION);
    assert.notEqual(computeDigest(questionChanged), RN_SV_GOLDEN_DIGEST);

    const scoringChanged = JSON.parse(JSON.stringify(RN_SV_FRAMEWORK_V0_1)) as { scoringModel: { unknownPolicy: string } };
    scoringChanged.scoringModel.unknownPolicy = 'exclude';
    assert.notEqual(computeDigest(scoringChanged), RN_SV_GOLDEN_DIGEST);

    assert.equal(computeDigest(JSON.parse(JSON.stringify(RN_SV_FRAMEWORK_V0_1))), RN_SV_GOLDEN_DIGEST, 'an unchanged copy keeps the golden digest');
  });
});

/**
 * Independent-review follow-up (F01, F02). F01 pinned the gap CAT-01 shipped
 * with (no evidence -> ten PASS reviews -> 100 -> a valid assessment);
 * ASSURE-SEC-01A closed it in the engine, so F01 now fails on any regression
 * that lets an unsupported PASS back in. F02 is unchanged.
 */
describe('rn.sv 0.1.0 commercial-use limits', () => {
  it('F01 (fixed by ASSURE-SEC-01A): a PASS review citing no evidence is rejected, persists nothing, and cannot score or complete', async () => {
    const harness = rnSvHarness();
    // No evidence collected at all: nothing could support a pass.
    const evaluated = await evaluateRnSv(harness, []);
    assert.equal(evaluated.evidenceReferences.length, 0);

    for (const controlId of SV_CONTROL_IDS) {
      await assert.rejects(
        () =>
          harness.service.recordManualReview(ASSURANCE_ORG, {
            assessmentId: evaluated.assessmentId,
            controlId,
            reviewerId: 'reviewer-1',
            reviewerRole: RN_SV_REVIEWER_ROLE,
            outcome: 'pass',
            rationale: 'Unsupported pass: must be refused.',
          }),
        (error: unknown) => error instanceof AssuranceError && error.code === 'ASSURANCE_MANUAL_REVIEW_INVALID' && error.details?.['violation'] === 'MANUAL_REVIEW_EVIDENCE_MISSING',
      );
    }
    assert.deepEqual(await harness.store.listManualReviews(ASSURANCE_ORG, evaluated.assessmentId), []);

    const reevaluated = await harness.service.evaluateAssessment(ASSURANCE_ORG, evaluated.assessmentId);
    assert.deepEqual(Object.values(statusesOf(reevaluated)), SV_CONTROL_IDS.map(() => 'manual_review_required'));
    assert.equal(reevaluated.score.normalizedScore, 0);
    await assert.rejects(
      () => harness.service.completeAssessment(ASSURANCE_ORG, evaluated.assessmentId),
      (error: unknown) => error instanceof AssuranceError && error.code === 'ASSURANCE_MANUAL_REVIEW_REQUIRED',
    );

    // The framework definition itself is unchanged: the fix lives in the engine.
    assert.ok(RN_SV_FRAMEWORK_V0_1.controls.every((control) => control.criteria.type === 'manual_review' && control.criteria.requiredEvidenceRequirementIds === undefined));
  });

  it('F02: status active means available to register and assess, not commercially authorized; commercialUse is informative only', async () => {
    assert.equal(RN_SV_FRAMEWORK_V0_1.status, 'active');
    const commercialUse = RN_SV_FRAMEWORK_V0_1.metadata?.['commercialUse'] as Readonly<Record<string, unknown>>;
    assert.equal(commercialUse['status'], 'restricted');

    // `active` is what makes the definition assessable at all: a draft is refused outright.
    const registry = createAssuranceFrameworkRegistry();
    registry.register(RN_SV_FRAMEWORK_V0_1);
    assert.equal(resolveFrameworkForAssessment(registry, RN_SV_FRAMEWORK_ID, RN_SV_FRAMEWORK_VERSION), RN_SV_FRAMEWORK_V0_1);
    const draftRegistry = createAssuranceFrameworkRegistry();
    draftRegistry.register({ ...RN_SV_FRAMEWORK_V0_1, status: 'draft' });
    assert.throws(
      () => resolveFrameworkForAssessment(draftRegistry, RN_SV_FRAMEWORK_ID, RN_SV_FRAMEWORK_VERSION),
      (error: unknown) => error instanceof AssuranceError && error.code === 'ASSURANCE_FRAMEWORK_VERSION_UNSUPPORTED',
    );

    // `restricted` is not enforced: an assessment runs to completion regardless, and nothing in it
    // carries a commercial authorization -- no eligibility result is produced.
    const harness = rnSvHarness();
    const evaluated = await evaluateRnSv(harness, SYNTHETIC_EVIDENCE);
    await recordReviews(harness, evaluated.assessmentId, allControls('pass'), true);
    await harness.service.evaluateAssessment(ASSURANCE_ORG, evaluated.assessmentId);
    const completed = await harness.service.completeAssessment(ASSURANCE_ORG, evaluated.assessmentId);
    assert.equal(completed.status, 'completed');
    assert.deepEqual(completed.eligibility, []);
  });
});

describe('rn.sv 0.1.0 end-to-end (synthetic data only)', () => {
  it('completes a synthetic assessment under valid reviews, and it verifies', async () => {
    const harness = rnSvHarness();
    const evaluated = await evaluateRnSv(harness, SYNTHETIC_EVIDENCE);
    assert.equal(evaluated.status, 'manual_review');
    assert.equal(evaluated.evidenceReferences.length, 10);
    assert.ok(evaluated.evidenceReferences.every((reference) => reference.verified === false));

    await recordReviews(
      harness,
      evaluated.assessmentId,
      { ...allControls('pass'), 'SV-07': 'partial', 'SV-09': 'insufficient_evidence', 'SV-10': 'fail' },
      true,
    );
    await harness.service.evaluateAssessment(ASSURANCE_ORG, evaluated.assessmentId);
    const completed = await harness.service.completeAssessment(ASSURANCE_ORG, evaluated.assessmentId);
    assert.equal(completed.status, 'completed');
    assert.equal(completed.frameworkId, 'rn.sv');
    assert.equal(completed.frameworkVersion, '0.1.0');

    const findings = Object.fromEntries(completed.findings.map((finding) => [finding.controlId, `${finding.findingType}/${finding.severity}`]));
    assert.deepEqual(findings, {
      'SV-07': 'evidence_gap/medium',
      'SV-09': 'evidence_gap/low',
      'SV-10': 'control_failure/medium',
    });

    const verification = verifyAssuranceAssessment({ assessment: completed, framework: RN_SV_FRAMEWORK_V0_1, now: harness.now });
    assert.deepEqual(verification.failures, []);
    assert.equal(verification.valid, true);
    assert.ok(Object.values(verification.checks).every((check) => check));

    const serviceVerification = await harness.service.verifyAssessment(ASSURANCE_ORG, evaluated.assessmentId);
    assert.equal(serviceVerification.valid, true);
  });
});
