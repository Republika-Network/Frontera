import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { AssuranceError } from '../assurance/errors.js';
import { computeDigest } from '../governance-store/digest.js';
import { createAssuranceEvidenceResolver } from '../assurance/evidence-resolver.js';
import { deriveAssuranceMetrics } from '../assurance/metrics.js';
import { createSqliteAssuranceStore } from '../assurance/sqlite-assurance-store.js';
import { AOC_SAF_FRAMEWORK_ID, AOC_SAF_FRAMEWORK_V1, AOC_SAF_FRAMEWORK_VERSION } from '../assurance/saf-framework.js';
import { RN_SV_FRAMEWORK_ID, RN_SV_FRAMEWORK_V0_1, RN_SV_FRAMEWORK_VERSION } from '../assurance/frameworks/rn-sv-framework.js';
import { RESERVED_METRIC_NAMESPACES, isHostVerified, manualMetricNameViolation } from '../assurance/manual-evidence-trust.js';
import {
  ASSURANCE_CUTOFF,
  ASSURANCE_ORG,
  buildAssuranceClock,
  buildAssuranceHarness,
  buildAssuranceIdGenerator,
  buildAttestation,
  buildHostVerifiedReference,
  buildTestScope,
  reviewerContext,
  type AssuranceTestHarness,
} from './assurance-support.js';
import type { AssuranceAssessment, AssuranceEvidenceReference, AssuranceEvidenceRequirement, AssuranceEvidenceResolution } from '../assurance/contracts.js';

/**
 * ASSURE-SEC-01C: manual evidence is candidate evidence, never authority.
 * C1 verification cannot be self-declared; C2 attestations cannot set
 * Host-derived metrics; C3 manual evidence satisfies only the requirements it
 * is explicitly bound to. Synthetic data only.
 */

const RESERVED_DERIVED_METRICS = [
  'governance.records.all_verified',
  'governance.records.count',
  'evidence.bundles.all_verified',
  'passport.verified',
  'passport.present',
  'passport.active',
  'enterprise.ready',
  'modules.unhealthy_count',
] as const;

const ATTEST_REQUIREMENT: AssuranceEvidenceRequirement = {
  requirementId: 'req.attest',
  description: 'attestation',
  acceptedEvidenceTypes: ['control_attestation'],
  minimumCount: 1,
  manualEvidenceAllowed: true,
  contradictionPolicy: 'manual_review',
};

function resolverWith(manualEvidence: readonly AssuranceEvidenceReference[]) {
  return createAssuranceEvidenceResolver({ sources: {}, manualEvidence, now: buildAssuranceClock(), nextId: buildAssuranceIdGenerator() });
}

function artifact(id: string, overrides: Partial<AssuranceEvidenceReference> = {}): AssuranceEvidenceReference {
  return {
    evidenceReferenceId: id,
    evidenceType: 'external_artifact_reference',
    externalId: `artifact-${id}`,
    organizationId: 'org-1',
    digest: computeDigest({ artifact: id }),
    occurredAt: '2026-06-10T00:00:00.000Z',
    collectedAt: '2026-06-14T00:00:00.000Z',
    verified: false,
    provenance: { sourceSystem: 'synthetic-test-fixture', sourceType: 'external_artifact_reference', collectedBy: 'preparer-1', collectedAt: '2026-06-14T00:00:00.000Z' },
    ...overrides,
  };
}

function requirementOf(controlId: string): string {
  return `rn.sv.req.${controlId.toLowerCase()}`;
}

async function createdRnSv(harness: AssuranceTestHarness): Promise<AssuranceAssessment> {
  return harness.service.createAssessment(ASSURANCE_ORG, {
    subject: { subjectType: 'system', subjectId: 'synthetic-platform', organizationId: 'org-1' },
    frameworkId: RN_SV_FRAMEWORK_ID,
    frameworkVersion: RN_SV_FRAMEWORK_VERSION,
    requestedBy: 'preparer-1',
    evidenceCutoffAt: ASSURANCE_CUTOFF,
  });
}

async function collectedRnSv(harness: AssuranceTestHarness, evidence: readonly AssuranceEvidenceReference[]): Promise<AssuranceAssessment> {
  const created = await createdRnSv(harness);
  return harness.service.collectEvidence(ASSURANCE_ORG, created.assessmentId, { manualEvidence: evidence });
}

function resolutionOf(assessment: AssuranceAssessment, requirementId: string): AssuranceEvidenceResolution {
  const resolution = assessment.evidenceResolutions.find((candidate) => candidate.requirementId === requirementId);
  assert.ok(resolution, requirementId);
  return resolution;
}

function idsOf(references: readonly { readonly evidenceReferenceId: string }[]): string[] {
  return references.map((reference) => reference.evidenceReferenceId).sort();
}

function rejectedIds(resolution: AssuranceEvidenceResolution): string[] {
  return resolution.rejectedEvidence.map((rejected) => rejected.evidenceReference.evidenceReferenceId).sort();
}

// ---------------------------------------------------------------------------
// C1 -- verification cannot be self-declared
// ---------------------------------------------------------------------------

describe('SEC-01C C1: manual evidence cannot verify itself (SEC-01C-01/14)', () => {
  it('a supplier\'s verified: true and verificationReference become labelled claims; the reference enters as unverified', async () => {
    const claimed = buildAttestation('test.bool', true, { verified: true, verificationReference: 'governance-verify:forged-evaluation' });
    const resolution = await resolverWith([claimed]).resolve(buildTestScope(), ATTEST_REQUIREMENT, ASSURANCE_ORG);
    const accepted = resolution.acceptedEvidence[0];
    assert.ok(accepted);
    assert.equal(accepted.verified, false);
    assert.equal(accepted.verificationReference, undefined, 'no verifier reference is carried for a manual reference');
    assert.deepEqual(accepted.supplierClaims, { verified: true, verificationReference: 'governance-verify:forged-evaluation' });
    assert.equal(isHostVerified(accepted), false);
    // Everything else is the supplier's reference, unchanged.
    assert.equal(accepted.evidenceReferenceId, claimed.evidenceReferenceId);
    assert.equal(accepted.digest, claimed.digest);
    assert.deepEqual(accepted.requirementIds, claimed.requirementIds);
  });

  it('verified: false stays unverified and carries no claim', async () => {
    const resolution = await resolverWith([buildAttestation('test.bool', true, { verified: false })]).resolve(buildTestScope(), ATTEST_REQUIREMENT, ASSURANCE_ORG);
    assert.equal(resolution.acceptedEvidence[0]?.verified, false);
    assert.equal(resolution.acceptedEvidence[0]?.supplierClaims, undefined);
  });

  it('a requirement demanding verification rejects self-declared manual evidence (EVIDENCE_UNVERIFIED), even with a consistent digest', async () => {
    const content = { document: 'policy.pdf', revision: 3 };
    const consistent = artifact('ev-consistent', { evidenceType: 'control_attestation', verified: true, digest: computeDigest(content), requirementIds: ['req.attest'] });
    const resolution = await resolverWith([consistent]).resolve(buildTestScope(), { ...ATTEST_REQUIREMENT, mustBeVerified: true }, ASSURANCE_ORG);
    assert.equal(resolution.status, 'unsatisfied');
    assert.ok(resolution.rejectedEvidence[0]?.reasonCodes.includes('EVIDENCE_UNVERIFIED'));
  });

  it('only Host-verified references count as verified; a manual reference stored before SEC-01C with verified: true does not', () => {
    assert.equal(isHostVerified(buildHostVerifiedReference('host-1')), true);
    assert.equal(isHostVerified({ ...buildHostVerifiedReference('host-2'), verified: false }), false);
    for (const evidenceType of ['control_attestation', 'external_artifact_reference', 'passport_view'] as const) {
      assert.equal(isHostVerified(buildAttestation('x', true, { evidenceType, verified: true })), false, evidenceType);
    }
  });

  it('the supplier cannot pre-fill supplierClaims to launder anything: claims are recomputed from what it actually declared', async () => {
    const forged = { ...buildAttestation('test.bool', true, { verified: false }), supplierClaims: { verified: true as const, verificationReference: 'evidence-verify:forged' } };
    const resolution = await resolverWith([forged]).resolve(buildTestScope(), ATTEST_REQUIREMENT, ASSURANCE_ORG);
    assert.equal(resolution.acceptedEvidence[0]?.supplierClaims, undefined);
    assert.equal(resolution.acceptedEvidence[0]?.verified, false);
  });
});

// ---------------------------------------------------------------------------
// C2 -- metric namespace integrity
// ---------------------------------------------------------------------------

describe('SEC-01C C2: attestations cannot set Host-derived metrics (SEC-01C-02/03/04)', () => {
  it('every metric the Host derives lies in a reserved namespace (catalog check)', () => {
    const host = (id: string, evidenceType: AssuranceEvidenceReference['evidenceType'], metadata: Record<string, unknown>) => ({
      ...buildHostVerifiedReference(id),
      evidenceType,
      metadata,
    });
    const resolution: AssuranceEvidenceResolution = {
      requirementId: 'all-sources',
      status: 'satisfied',
      acceptedEvidence: [
        host('g', 'governance_record', { status: 'allowed' }),
        host('b', 'evidence_bundle', {}),
        host('p', 'agent_passport', { status: 'active', chainValid: true, lifecycleValid: true, governanceReferenceCount: 1, evidenceReferenceCount: 1 }),
        host('e', 'enterprise_health', { ready: true }),
        host('m', 'module_health', { status: 'ready' }),
      ],
      rejectedEvidence: [],
      missingEvidence: [],
      contradictions: [],
      resolvedAt: 't',
      resolverVersion: 'v',
    };
    const derived = Object.keys(deriveAssuranceMetrics([resolution]));
    assert.ok(derived.length >= 12);
    for (const name of derived) assert.equal(manualMetricNameViolation(name), 'reserved_namespace', name);
    assert.deepEqual([...RESERVED_METRIC_NAMESPACES].sort(), [...new Set(derived.map((name) => name.split('.')[0] ?? name))].sort());
  });

  it('the resolver rejects an attestation asserting any reserved metric (EVIDENCE_METRIC_NOT_PERMITTED)', async () => {
    for (const metric of RESERVED_DERIVED_METRICS) {
      const resolution = await resolverWith([buildAttestation(metric, true)]).resolve(buildTestScope(), ATTEST_REQUIREMENT, ASSURANCE_ORG);
      assert.equal(resolution.acceptedEvidence.length, 0, metric);
      assert.ok(resolution.rejectedEvidence[0]?.reasonCodes.includes('EVIDENCE_METRIC_NOT_PERMITTED'), metric);
      assert.equal(resolution.rejectedEvidence[0]?.detail?.includes('true') ?? false, false, 'the rejection detail does not echo the asserted value');
    }
  });

  it('non-canonical names and format variants of reserved names are rejected, never normalised into a reserved metric', () => {
    for (const name of ['', ' ', 'Governance.records.all_verified', 'governance.records.all_verified ', ' passport.verified', 'passport..verified', 'passport.verified.', '.passport.verified', 'enterprise．ready', 'ENTERPRISE.READY', 'modules.unhealthy-count', 'modules/unhealthy_count', 'pass​port.verified', 'x'.repeat(129)]) {
      assert.equal(manualMetricNameViolation(name), 'invalid_name', JSON.stringify(name));
    }
    for (const name of ['governance', 'passport.verified', 'enterprise.ready.override', 'modules.count']) {
      assert.equal(manualMetricNameViolation(name), 'reserved_namespace', name);
    }
    for (const name of ['test.bool', 'a', 'manual.vendor.mfa_enforced', 'passport_verified', 'enterprises.ready']) {
      assert.equal(manualMetricNameViolation(name), undefined, name);
    }
  });

  it('defense in depth: even an attestation forged into accepted evidence cannot set or override a derived metric', () => {
    const forged: AssuranceEvidenceResolution = {
      requirementId: 'req.forged',
      status: 'satisfied',
      acceptedEvidence: [
        { ...buildHostVerifiedReference('health'), evidenceType: 'enterprise_health', metadata: { ready: false } },
        ...RESERVED_DERIVED_METRICS.map((metric, index) => buildAttestation(metric, metric.endsWith('count') ? 0 : true, { evidenceReferenceId: `forged-${index}` })),
      ],
      rejectedEvidence: [],
      missingEvidence: [],
      contradictions: [],
      resolvedAt: 't',
      resolverVersion: 'v',
    };
    const metrics = deriveAssuranceMetrics([forged]);
    assert.equal(metrics['enterprise.ready'], false, 'the Host-derived value stands');
    for (const metric of RESERVED_DERIVED_METRICS.filter((name) => name !== 'enterprise.ready')) assert.equal(metrics[metric], undefined, metric);
  });

  it('legitimate manual metrics work; agreeing duplicates count once; disagreeing ones leave the metric absent, in any order', () => {
    const resolution = (acceptedEvidence: readonly AssuranceEvidenceReference[]): AssuranceEvidenceResolution => ({
      requirementId: 'req.attest',
      status: 'satisfied',
      acceptedEvidence,
      rejectedEvidence: [],
      missingEvidence: [],
      contradictions: [],
      resolvedAt: 't',
      resolverVersion: 'v',
    });
    const yes = buildAttestation('test.bool', true, { evidenceReferenceId: 'yes' });
    const alsoYes = buildAttestation('test.bool', true, { evidenceReferenceId: 'also-yes' });
    const no = buildAttestation('test.bool', false, { evidenceReferenceId: 'no' });
    const count = buildAttestation('test.count', 3, { evidenceReferenceId: 'count' });

    assert.equal(deriveAssuranceMetrics([resolution([yes, count])])['test.bool'], true);
    assert.equal(deriveAssuranceMetrics([resolution([yes, alsoYes])])['test.bool'], true);
    // The same attestation accepted under two requirements counts once.
    assert.equal(deriveAssuranceMetrics([resolution([yes]), resolution([yes])])['test.bool'], true);
    for (const order of [[yes, no, count], [no, yes, count], [count, no, yes]]) {
      const metrics = deriveAssuranceMetrics([resolution(order)]);
      assert.equal(metrics['test.bool'], undefined, 'conflicting attestations never resolve by order');
      assert.equal(metrics['test.count'], 3);
    }
  });

  it('end to end: malicious attestations naming reserved metrics change neither the score nor any control status of aoc.saf', async () => {
    async function safRun(evidence: readonly AssuranceEvidenceReference[]): Promise<AssuranceAssessment> {
      const harness = buildAssuranceHarness({ framework: AOC_SAF_FRAMEWORK_V1 });
      const created = await harness.service.createAssessment(ASSURANCE_ORG, {
        subject: { subjectType: 'agent', subjectId: 'agent-under-test', organizationId: 'org-1' },
        frameworkId: AOC_SAF_FRAMEWORK_ID,
        frameworkVersion: AOC_SAF_FRAMEWORK_VERSION,
        requestedBy: 'assessor-1',
        evidenceCutoffAt: ASSURANCE_CUTOFF,
      });
      await harness.service.collectEvidence(ASSURANCE_ORG, created.assessmentId, { manualEvidence: evidence });
      return harness.service.evaluateAssessment(ASSURANCE_ORG, created.assessmentId);
    }
    const baseline = await safRun([]);
    const malicious = await safRun(
      RESERVED_DERIVED_METRICS.map((metric, index) =>
        buildAttestation(metric, metric.endsWith('count') ? 0 : true, { evidenceReferenceId: `malicious-${index}`, verified: true, requirementIds: ['saf.req.review-attestation'] }),
      ),
    );
    assert.equal(malicious.score.normalizedScore, baseline.score.normalizedScore);
    assert.deepEqual(
      malicious.controlEvaluations.map((evaluation) => [evaluation.controlId, evaluation.status]),
      baseline.controlEvaluations.map((evaluation) => [evaluation.controlId, evaluation.status]),
    );
    assert.equal(malicious.controlEvaluations.some((evaluation) => evaluation.status === 'pass'), false);
    const attestations = resolutionOf(malicious, 'saf.req.review-attestation');
    assert.equal(attestations.acceptedEvidence.length, 0);
    assert.ok(attestations.rejectedEvidence.every((rejected) => rejected.reasonCodes.includes('EVIDENCE_METRIC_NOT_PERMITTED')));
  });
});

// ---------------------------------------------------------------------------
// C3 -- explicit requirement binding
// ---------------------------------------------------------------------------

describe('SEC-01C C3: manual evidence satisfies only the requirements it is bound to (SEC-01C-05..10)', () => {
  it('evidence bound to SV-01 is not even a candidate for SV-08; unbound evidence is rejected everywhere (EVIDENCE_NOT_BOUND)', async () => {
    const harness = buildAssuranceHarness({ framework: RN_SV_FRAMEWORK_V0_1 });
    const assessment = await collectedRnSv(harness, [artifact('ev-sv01', { requirementIds: [requirementOf('SV-01')] }), artifact('ev-unbound')]);
    assert.deepEqual(idsOf(resolutionOf(assessment, requirementOf('SV-01')).acceptedEvidence), ['ev-sv01']);
    const sv08 = resolutionOf(assessment, requirementOf('SV-08'));
    assert.deepEqual(idsOf(sv08.acceptedEvidence), []);
    assert.deepEqual(rejectedIds(sv08), ['ev-unbound']);
    assert.ok(sv08.rejectedEvidence[0]?.reasonCodes.includes('EVIDENCE_NOT_BOUND'));
    assert.equal(sv08.status, 'unsatisfied');
    for (const resolution of assessment.evidenceResolutions) {
      assert.equal(resolution.acceptedEvidence.some((reference) => reference.evidenceReferenceId === 'ev-unbound'), false, resolution.requirementId);
    }
  });

  it('explicit reuse: one artifact bound to two requirements satisfies exactly those two, as one reference', async () => {
    const harness = buildAssuranceHarness({ framework: RN_SV_FRAMEWORK_V0_1 });
    const assessment = await collectedRnSv(harness, [artifact('ev-shared', { requirementIds: [requirementOf('SV-01'), requirementOf('SV-08')] })]);
    const satisfied = assessment.evidenceResolutions.filter((resolution) => resolution.status === 'satisfied').map((resolution) => resolution.requirementId).sort();
    assert.deepEqual(satisfied, [requirementOf('SV-01'), requirementOf('SV-08')]);
    assert.deepEqual(idsOf(assessment.evidenceReferences), ['ev-shared'], 'the association creates no copy of the reference');
  });

  for (const [label, requirementIds] of [
    ['a requirement the framework does not define', ['rn.sv.req.sv-99']],
    ['an empty binding list', []],
    ['a repeated requirement', [requirementOf('SV-01'), requirementOf('SV-01')]],
  ] as const) {
    it(`refuses the whole set before collecting when evidence names ${label}; the assessment does not change state`, async () => {
      const harness = buildAssuranceHarness({ framework: RN_SV_FRAMEWORK_V0_1 });
      const created = await createdRnSv(harness);
      for (const call of [
        () => harness.service.collectEvidence(ASSURANCE_ORG, created.assessmentId, { manualEvidence: [artifact('ev-bad', { requirementIds })] }),
        () => harness.service.evaluateAssessment(ASSURANCE_ORG, created.assessmentId, { manualEvidence: [artifact('ev-bad', { requirementIds })] }),
      ]) {
        await assert.rejects(call, (error: unknown) => error instanceof AssuranceError && error.code === 'ASSURANCE_EVIDENCE_INVALID');
      }
      assert.equal((await harness.service.getAssessment(ASSURANCE_ORG, created.assessmentId))?.status, 'created');
    });
  }

  it('one evidenceReferenceId naming two different references is refused; an exact repeat is harmless', async () => {
    const harness = buildAssuranceHarness({ framework: RN_SV_FRAMEWORK_V0_1 });
    const first = artifact('ev-dup', { requirementIds: [requirementOf('SV-01')] });
    const created = await createdRnSv(harness);
    await assert.rejects(
      () => harness.service.collectEvidence(ASSURANCE_ORG, created.assessmentId, { manualEvidence: [first, { ...first, requirementIds: [requirementOf('SV-08')] }] }),
      (error: unknown) => error instanceof AssuranceError && error.code === 'ASSURANCE_EVIDENCE_INVALID',
    );
    const collected = await harness.service.collectEvidence(ASSURANCE_ORG, created.assessmentId, { manualEvidence: [first, first] });
    assert.deepEqual(idsOf(resolutionOf(collected, requirementOf('SV-01')).acceptedEvidence), ['ev-dup', 'ev-dup']);
    assert.deepEqual(idsOf(collected.evidenceReferences), ['ev-dup']);
  });

  it('no cross-assessment reuse: evidence supplied to one assessment is absent from another', async () => {
    const harness = buildAssuranceHarness({ framework: RN_SV_FRAMEWORK_V0_1 });
    await collectedRnSv(harness, [artifact('ev-a', { requirementIds: [requirementOf('SV-08')] })]);
    const other = await collectedRnSv(harness, []);
    assert.equal(other.evidenceResolutions.some((resolution) => resolution.acceptedEvidence.length > 0 || resolution.rejectedEvidence.length > 0), false);
  });

  it('no cross-tenant reuse: a correctly bound reference of another organization is rejected (EVIDENCE_WRONG_TENANT)', async () => {
    const harness = buildAssuranceHarness({ framework: RN_SV_FRAMEWORK_V0_1 });
    const assessment = await collectedRnSv(harness, [artifact('ev-foreign', { organizationId: 'org-2', requirementIds: [requirementOf('SV-08')] })]);
    const sv08 = resolutionOf(assessment, requirementOf('SV-08'));
    assert.equal(sv08.acceptedEvidence.length, 0);
    assert.ok(sv08.rejectedEvidence[0]?.reasonCodes.includes('EVIDENCE_WRONG_TENANT'));
  });

  it('rejected evidence never satisfies, and a correctly bound but rejected artifact leaves the control to insufficient_evidence -> unknown', async () => {
    const harness = buildAssuranceHarness({ framework: RN_SV_FRAMEWORK_V0_1 });
    const late = artifact('ev-late', { requirementIds: [requirementOf('SV-08')], occurredAt: '2027-01-01T00:00:00.000Z' });
    const assessment = await collectedRnSv(harness, [late]);
    assert.equal(resolutionOf(assessment, requirementOf('SV-08')).status, 'unsatisfied');
    await harness.service.evaluateAssessment(ASSURANCE_ORG, assessment.assessmentId);
    await assert.rejects(
      () => harness.service.recordManualReview(reviewerContext(harness), { assessmentId: assessment.assessmentId, controlId: 'SV-08', outcome: 'pass', rationale: 'r', evidenceReferenceIds: ['ev-late'] }),
      (error: unknown) => error instanceof AssuranceError && error.details?.['violation'] === 'MANUAL_REVIEW_EVIDENCE_REJECTED',
    );
    await harness.service.recordManualReview(reviewerContext(harness), { assessmentId: assessment.assessmentId, controlId: 'SV-08', outcome: 'insufficient_evidence', rationale: 'r' });
    const reevaluated = await harness.service.evaluateAssessment(ASSURANCE_ORG, assessment.assessmentId);
    assert.equal(reevaluated.controlEvaluations.find((evaluation) => evaluation.controlId === 'SV-08')?.status, 'unknown');
  });

  it('resolution is reproducible, and different associations of the same artifact resolve differently', async () => {
    const shape = (assessment: AssuranceAssessment) =>
      assessment.evidenceResolutions.map((resolution) => [resolution.requirementId, resolution.status, idsOf(resolution.acceptedEvidence), rejectedIds(resolution)]);
    const evidence = [artifact('ev-x', { requirementIds: [requirementOf('SV-02')] }), artifact('ev-y')];
    const first = await collectedRnSv(buildAssuranceHarness({ framework: RN_SV_FRAMEWORK_V0_1 }), evidence);
    const again = await collectedRnSv(buildAssuranceHarness({ framework: RN_SV_FRAMEWORK_V0_1 }), [...evidence].reverse());
    assert.deepEqual(shape(again), shape(first));
    const rebound = await collectedRnSv(buildAssuranceHarness({ framework: RN_SV_FRAMEWORK_V0_1 }), [artifact('ev-x', { requirementIds: [requirementOf('SV-03')] })]);
    assert.equal(resolutionOf(rebound, requirementOf('SV-02')).status, 'unsatisfied');
    assert.equal(resolutionOf(rebound, requirementOf('SV-03')).status, 'satisfied');
  });

  it('the binding and the supplier claims persist and recover through the SQLite store', async () => {
    const store = await createSqliteAssuranceStore(':memory:', { now: buildAssuranceClock() });
    const harness = buildAssuranceHarness({ framework: RN_SV_FRAMEWORK_V0_1, store });
    const assessment = await collectedRnSv(harness, [artifact('ev-p', { verified: true, requirementIds: [requirementOf('SV-08')] })]);
    const reloaded = await store.getAssessment(ASSURANCE_ORG, assessment.assessmentId);
    const reference = reloaded?.evidenceReferences.find((candidate) => candidate.evidenceReferenceId === 'ev-p');
    assert.deepEqual(reference?.requirementIds, [requirementOf('SV-08')]);
    assert.equal(reference?.verified, false);
    assert.deepEqual(reference?.supplierClaims, { verified: true });
  });
});
