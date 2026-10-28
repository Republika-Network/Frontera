import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AssuranceError } from '../assurance/errors.js';
import { computeDigest } from '../governance-store/digest.js';
import { createAssuranceControlEvaluator } from '../assurance/control-evaluator.js';
import { createAssuranceFrameworkRegistry } from '../assurance/framework-registry.js';
import { createInMemoryAssuranceStore } from '../assurance/in-memory-assurance-store.js';
import { createAssuranceService } from '../assurance/service.js';
import { AOC_SAF_FRAMEWORK_ID, AOC_SAF_FRAMEWORK_VERSION } from '../assurance/saf-framework.js';
import { RN_SV_FRAMEWORK_ID, RN_SV_FRAMEWORK_V0_1, RN_SV_FRAMEWORK_VERSION } from '../assurance/frameworks/rn-sv-framework.js';
import { createEnterprise } from '../composition/composition-root.js';
import { loadEnterpriseConfiguration, type EnterpriseConfiguration } from '../configuration/enterprise-configuration.js';
import { createInProcessEventPublisher, type EnterpriseEvent } from '../events/enterprise-events.js';
import { createEnterpriseServer, type EnterpriseServer } from '../host/enterprise-server.js';
import { EnterpriseHostConfigurationError, loadEnterpriseHostConfiguration } from '../host/host-configuration.js';
import { AssuranceReviewerConfigurationError } from '../orchestration/assurance-reviewer-credentials.js';
import {
  ASSURANCE_CUTOFF,
  ASSURANCE_ORG,
  TEST_REVIEWERS,
  buildAssuranceClock,
  buildAssuranceHarness,
  buildAssuranceIdGenerator,
  reviewerContext,
  testReviewerSecret,
  type AssuranceTestHarness,
} from './assurance-support.js';
import { ORG, TRUST_DOMAIN_ID } from './governed-action-support.js';
import { buildTestKernelProviders } from './support.js';
import type {
  AssuranceAccessContext,
  AssuranceAssessment,
  AssuranceEvidenceReference,
  AssuranceManualReviewRecord,
  AssuranceReviewerPrincipal,
} from '../assurance/contracts.js';
import type { RecordManualReviewInput } from '../assurance/service.js';

/**
 * ASSURE-SEC-01B: authenticated reviewer identity and role binding.
 * Adversarial cases through the service (direct calls), the control
 * evaluator (historical records), the HTTP adapter and the Host
 * configuration loader. Synthetic data only.
 */

const SV08_REQUIREMENT = 'rn.sv.req.sv-08';

/** One bound artifact per rn.sv control (SEC-01A), so evidence never blocks the identity cases below. */
const BOUND_EVIDENCE: readonly AssuranceEvidenceReference[] = RN_SV_FRAMEWORK_V0_1.controls.map((control) => ({
  evidenceReferenceId: `ev-${control.controlId}`,
  evidenceType: 'external_artifact_reference',
  externalId: `artifact-${control.controlId}`,
  organizationId: 'org-1',
  digest: computeDigest({ artifact: control.controlId }),
  occurredAt: '2026-06-10T00:00:00.000Z',
  collectedAt: '2026-06-14T00:00:00.000Z',
  verified: false,
  requirementIds: [`rn.sv.req.${control.controlId.toLowerCase()}`],
  provenance: { sourceSystem: 'synthetic-test-fixture', sourceType: 'external_artifact_reference', collectedBy: 'preparer-1', collectedAt: '2026-06-14T00:00:00.000Z' },
}));

async function evaluatedRnSv(harness: AssuranceTestHarness): Promise<AssuranceAssessment> {
  const created = await harness.service.createAssessment(ASSURANCE_ORG, {
    subject: { subjectType: 'system', subjectId: 'synthetic-platform', organizationId: 'org-1' },
    frameworkId: RN_SV_FRAMEWORK_ID,
    frameworkVersion: RN_SV_FRAMEWORK_VERSION,
    requestedBy: 'preparer-1',
    evidenceCutoffAt: ASSURANCE_CUTOFF,
  });
  await harness.service.collectEvidence(ASSURANCE_ORG, created.assessmentId, { manualEvidence: BOUND_EVIDENCE });
  return harness.service.evaluateAssessment(ASSURANCE_ORG, created.assessmentId);
}

function sv08Review(assessmentId: string, overrides: Partial<RecordManualReviewInput> = {}): RecordManualReviewInput {
  return { assessmentId, controlId: 'SV-08', outcome: 'pass', rationale: 'Reviewed against the bound artifact.', evidenceReferenceIds: ['ev-SV-08'], ...overrides };
}

function unauthorized(error: unknown): boolean {
  return error instanceof AssuranceError && error.code === 'ASSURANCE_REVIEWER_UNAUTHORIZED';
}

async function assertNothingRecorded(harness: AssuranceTestHarness, assessmentId: string): Promise<void> {
  assert.deepEqual(await harness.store.listManualReviews(ASSURANCE_ORG, assessmentId), [], 'a refused review must never reach the store');
}

describe('SEC-01B service: identity and roles come only from an authenticated reviewer credential', () => {
  it('#7 an authenticated reviewer with the required role records a review attributed to itself, with the role derived from its credential', async () => {
    const harness = rnSvHarness();
    const assessment = await evaluatedRnSv(harness);
    // No reviewerId or reviewerRole in the input at all: nothing is needed from the caller.
    const review = await harness.service.recordManualReview(reviewerContext(harness, 'reviewer-1'), sv08Review(assessment.assessmentId));
    assert.equal(review.reviewerId, 'reviewer-1');
    assert.equal(review.reviewerRole, 'assure.reviewer');
    assert.equal(review.reviewerAuthentication, 'assurance_reviewer_credential');
    assert.deepEqual(await harness.store.listManualReviews(ASSURANCE_ORG, assessment.assessmentId), [review]);
  });

  it('#1 impersonation: a declared reviewerId other than the authenticated one is refused, never replaced', async () => {
    const harness = rnSvHarness();
    const assessment = await evaluatedRnSv(harness);
    await assert.rejects(() => harness.service.recordManualReview(reviewerContext(harness, 'reviewer-1'), sv08Review(assessment.assessmentId, { reviewerId: 'reviewer-2' })), unauthorized);
    await assertNothingRecorded(harness, assessment.assessmentId);
  });

  it('#2/#3/#5/#17 a role declared in the body, or stated in the context, but not held by the credential is refused', async () => {
    const harness = rnSvHarness();
    const assessment = await evaluatedRnSv(harness);
    // intern-1 holds only `intern`.
    await assert.rejects(() => harness.service.recordManualReview(reviewerContext(harness, 'intern-1'), sv08Review(assessment.assessmentId, { reviewerRole: 'assure.reviewer' })), unauthorized);
    await assert.rejects(() => harness.service.recordManualReview(reviewerContext(harness, 'intern-1'), sv08Review(assessment.assessmentId)), unauthorized);
    // Roles stated in the context grant nothing: only the principal's roles count.
    const widened: AssuranceAccessContext = { ...reviewerContext(harness, 'intern-1'), roles: ['assure.reviewer'] };
    await assert.rejects(() => harness.service.recordManualReview(widened, sv08Review(assessment.assessmentId)), unauthorized);
    // An escalation attempt through fields the input contract does not have is inert.
    const smuggled = { ...sv08Review(assessment.assessmentId), roles: ['assure.reviewer'], reviewerAuthentication: 'assurance_reviewer_credential', system: true } as RecordManualReviewInput;
    await assert.rejects(() => harness.service.recordManualReview(reviewerContext(harness, 'intern-1'), smuggled), unauthorized);
    // A role the reviewer does hold, but not the one this control is reviewed under, is refused rather than recorded under it.
    await assert.rejects(() => harness.service.recordManualReview(reviewerContext(harness, 'reviewer-1'), sv08Review(assessment.assessmentId, { reviewerRole: 'assurance-reviewer' })), unauthorized);
    await assertNothingRecorded(harness, assessment.assessmentId);
  });

  it('#2 on a control with no required role, a declared role the reviewer does not hold is refused, and one it holds is recorded', async () => {
    // The generic test framework: `c.presence` is an automated control with no reviewer role of its own.
    const harness = buildAssuranceHarness();
    const created = await harness.service.createAssessment(ASSURANCE_ORG, {
      subject: { subjectType: 'agent', subjectId: 'agent-under-test', organizationId: 'org-1' },
      frameworkId: 'test.framework',
      frameworkVersion: '1.0.0',
      requestedBy: 'assessor-1',
      evidenceCutoffAt: ASSURANCE_CUTOFF,
    });
    const input = { assessmentId: created.assessmentId, controlId: 'c.presence', outcome: 'insufficient_evidence' as const, rationale: 'Role assertion probe.' };
    await assert.rejects(() => harness.service.recordManualReview(reviewerContext(harness, 'reviewer-2'), { ...input, reviewerRole: 'organization-administrator' }), unauthorized);
    await assertNothingRecorded(harness, created.assessmentId);
    const recorded = await harness.service.recordManualReview(reviewerContext(harness, 'reviewer-2'), { ...input, reviewerRole: 'assure.reviewer' });
    assert.equal(recorded.reviewerRole, 'assure.reviewer');
    const unstated = await harness.service.recordManualReview(reviewerContext(harness, 'reviewer-2'), input);
    assert.equal(unstated.reviewerRole, undefined, 'no role is invented when the control requires none and none is asserted');
  });

  it('#4/#6 anonymous or incomplete contexts are refused: no principal, actorId and roles alone, or a context that disagrees with the principal', async () => {
    const harness = rnSvHarness();
    const assessment = await evaluatedRnSv(harness);
    const contexts: readonly AssuranceAccessContext[] = [
      { system: false },
      ASSURANCE_ORG,
      { system: false, organizationId: 'org-1', actorId: 'reviewer-1', roles: ['assure.reviewer'] },
      { ...reviewerContext(harness, 'reviewer-1'), actorId: 'reviewer-2' },
      { ...reviewerContext(harness, 'reviewer-1'), organizationId: 'org-2' },
    ];
    for (const context of contexts) {
      await assert.rejects(() => harness.service.recordManualReview(context, sv08Review(assessment.assessmentId)), unauthorized, JSON.stringify(context));
    }
    await assertNothingRecorded(harness, assessment.assessmentId);
  });

  it('#8 forged system and forged principals are refused: system context, a structural copy, or a principal from another service instance', async () => {
    const harness = rnSvHarness();
    const assessment = await evaluatedRnSv(harness);
    const forged: AssuranceReviewerPrincipal = { credentialClass: 'assurance-reviewer', reviewerId: 'reviewer-1', organizationId: 'org-1', roles: ['assure.reviewer'] };
    const otherInstance = rnSvHarness().service.authenticateReviewer(testReviewerSecret('reviewer-1'));
    assert.ok(otherInstance);
    const contexts: readonly AssuranceAccessContext[] = [
      { system: true },
      { system: true, actorId: 'system', roles: ['assure.reviewer'] },
      { system: false, organizationId: 'org-1', actorId: 'reviewer-1', roles: ['assure.reviewer'], reviewer: forged },
      { system: false, organizationId: 'org-1', reviewer: { ...reviewerContext(harness, 'reviewer-1').reviewer! } },
      { system: false, organizationId: 'org-1', reviewer: otherInstance },
    ];
    for (const context of contexts) {
      await assert.rejects(() => harness.service.recordManualReview(context, sv08Review(assessment.assessmentId)), unauthorized);
    }
    await assertNothingRecorded(harness, assessment.assessmentId);
  });

  it('#6 a reviewer of another organization cannot review this assessment', async () => {
    const harness = rnSvHarness();
    const assessment = await evaluatedRnSv(harness);
    await assert.rejects(
      () => harness.service.recordManualReview(reviewerContext(harness, 'reviewer-org-2'), sv08Review(assessment.assessmentId)),
      (error: unknown) => error instanceof AssuranceError && (error.code === 'ASSURANCE_ASSESSMENT_NOT_FOUND' || error.code === 'ASSURANCE_ACCESS_SCOPE_VIOLATION'),
    );
    await assertNothingRecorded(harness, assessment.assessmentId);
  });

  it('#9 no internal or system identity is a reviewer: with no reviewer credentials configured, no review can be recorded at all', async () => {
    const harness = buildAssuranceHarness({ framework: RN_SV_FRAMEWORK_V0_1, reviewers: [] });
    const assessment = await evaluatedRnSv(harness);
    for (const reviewer of TEST_REVIEWERS) assert.equal(harness.service.authenticateReviewer(reviewer.key), undefined);
    await assert.rejects(() => harness.service.recordManualReview({ system: true }, sv08Review(assessment.assessmentId)), unauthorized);
    await assertNothingRecorded(harness, assessment.assessmentId);
  });

  it('a wrong or empty secret authenticates nobody', () => {
    const harness = rnSvHarness();
    for (const token of ['', 'assure.reviewer', 'reviewer-1', `${testReviewerSecret('reviewer-1')} `, testReviewerSecret('reviewer-1').slice(0, -1)]) {
      assert.equal(harness.service.authenticateReviewer(token), undefined, JSON.stringify(token));
    }
  });
});

describe('SEC-01B audit consistency (INV-09)', () => {
  it('#10/#11 the digest and the audit event carry exactly the authenticated identity', async () => {
    const now = buildAssuranceClock();
    const registry = createAssuranceFrameworkRegistry();
    registry.register(RN_SV_FRAMEWORK_V0_1);
    const store = createInMemoryAssuranceStore({ now });
    const eventPublisher = createInProcessEventPublisher();
    const events: EnterpriseEvent[] = [];
    eventPublisher.subscribe((event) => events.push(event));
    const service = createAssuranceService({ store, registry, evidenceSources: {}, eventPublisher, now, nextId: buildAssuranceIdGenerator(), enterpriseVersion: 'test-1.0.0', reviewers: TEST_REVIEWERS });
    const harness: AssuranceTestHarness = { service, store, registry, now, nextId: buildAssuranceIdGenerator() };
    const assessment = await evaluatedRnSv(harness);

    const review = await service.recordManualReview(reviewerContext(harness, 'reviewer-1'), sv08Review(assessment.assessmentId, { reviewerId: 'reviewer-1' }));
    const { reviewDigest, ...base } = review;
    assert.equal(reviewDigest, computeDigest(base), 'the digest covers the authenticated reviewer and its provenance');

    const completed = events.filter((event) => event.type === 'AssuranceManualReviewCompleted');
    assert.equal(completed.length, 1);
    const detail = (completed[0] as unknown as { detail?: Readonly<Record<string, unknown>> }).detail;
    assert.equal(detail?.['reviewerId'], 'reviewer-1');
    assert.equal(detail?.['reviewerRole'], 'assure.reviewer');
    assert.equal(detail?.['reviewerAuthentication'], 'assurance_reviewer_credential');

    // #12 a refused attempt leaves no event behind.
    await assert.rejects(() => service.recordManualReview(reviewerContext(harness, 'intern-1'), sv08Review(assessment.assessmentId)), unauthorized);
    assert.equal(events.filter((event) => event.type === 'AssuranceManualReviewCompleted').length, 1);
  });
});

describe('SEC-01B preserves SEC-01A (INV-12)', () => {
  it('#13 an authenticated reviewer still needs bound evidence for a definitive outcome, and may still record insufficient_evidence', async () => {
    const harness = rnSvHarness();
    const assessment = await evaluatedRnSv(harness);
    await assert.rejects(
      () => harness.service.recordManualReview(reviewerContext(harness), sv08Review(assessment.assessmentId, { evidenceReferenceIds: [] })),
      (error: unknown) => error instanceof AssuranceError && error.code === 'ASSURANCE_MANUAL_REVIEW_INVALID' && error.details?.['violation'] === 'MANUAL_REVIEW_EVIDENCE_MISSING',
    );
    await assert.rejects(
      () => harness.service.recordManualReview(reviewerContext(harness), sv08Review(assessment.assessmentId, { evidenceReferenceIds: ['ev-SV-01'] })),
      (error: unknown) => error instanceof AssuranceError && error.details?.['violation'] === 'MANUAL_REVIEW_EVIDENCE_NOT_BOUND',
    );
    await harness.service.recordManualReview(reviewerContext(harness), sv08Review(assessment.assessmentId, { outcome: 'insufficient_evidence', evidenceReferenceIds: [] }));
    const reevaluated = await harness.service.evaluateAssessment(ASSURANCE_ORG, assessment.assessmentId);
    assert.equal(reevaluated.controlEvaluations.find((evaluation) => evaluation.controlId === 'SV-08')?.status, 'unknown');
  });
});

describe('SEC-01B historical reviews (no promotion of declared identity)', () => {
  function legacyReview(assessmentId: string, overrides: Partial<AssuranceManualReviewRecord> = {}): AssuranceManualReviewRecord {
    const base = {
      reviewId: 'review-legacy',
      assessmentId,
      controlId: 'SV-08',
      reviewerId: 'someone-declared',
      reviewerRole: 'assure.reviewer',
      outcome: 'pass' as const,
      rationale: 'Recorded before SEC-01B from caller-declared fields.',
      evidenceReferenceIds: ['ev-SV-08'],
      reviewedAt: '2026-06-14T12:00:00.000Z',
      ...overrides,
    };
    return { ...base, reviewDigest: computeDigest(base) };
  }

  it('#16 a stored pre-SEC-01B review stays on record but resolves no control; an authenticated review does', async () => {
    const harness = rnSvHarness();
    const assessment = await evaluatedRnSv(harness);
    await harness.store.appendManualReview(ASSURANCE_ORG, legacyReview(assessment.assessmentId));
    const pending = await harness.service.evaluateAssessment(ASSURANCE_ORG, assessment.assessmentId);
    const sv08 = pending.controlEvaluations.find((evaluation) => evaluation.controlId === 'SV-08');
    assert.equal(sv08?.status, 'manual_review_required');
    assert.ok(sv08?.reasonCodes.includes('CONTROL_MANUAL_REVIEW_IDENTITY_UNVERIFIED'));
    assert.equal((await harness.store.listManualReviews(ASSURANCE_ORG, assessment.assessmentId)).length, 1, 'history is kept, not rewritten');

    await harness.service.recordManualReview(reviewerContext(harness), sv08Review(assessment.assessmentId));
    const resolved = await harness.service.evaluateAssessment(ASSURANCE_ORG, assessment.assessmentId);
    assert.equal(resolved.controlEvaluations.find((evaluation) => evaluation.controlId === 'SV-08')?.status, 'pass');
  });

  it('#16 the evaluator called directly ignores a newer unauthenticated review in favour of the latest authenticated one', async () => {
    const control = RN_SV_FRAMEWORK_V0_1.controls.find((candidate) => candidate.controlId === 'SV-08');
    assert.ok(control);
    const evidence = [
      {
        requirementId: SV08_REQUIREMENT,
        status: 'satisfied' as const,
        acceptedEvidence: BOUND_EVIDENCE.filter((reference) => reference.evidenceReferenceId === 'ev-SV-08'),
        rejectedEvidence: [],
        missingEvidence: [],
        contradictions: [],
        resolvedAt: '2026-06-14T00:00:00.000Z',
        resolverVersion: 'aoc.assurance-evidence-resolver.v1',
      },
    ];
    const scope = {
      scopeId: 'scope-direct',
      subject: { subjectType: 'system' as const, subjectId: 'synthetic-platform', organizationId: 'org-1' },
      frameworkId: RN_SV_FRAMEWORK_ID,
      frameworkVersion: RN_SV_FRAMEWORK_VERSION,
      evidenceCutoffAt: ASSURANCE_CUTOFF,
      includeHistoricalEvidence: false,
      requestedBy: 'preparer-1',
      requestedAt: '2026-06-14T00:00:00.000Z',
    };
    const authenticatedFail = legacyReview('assessment-direct', { reviewId: 'review-auth', reviewerId: 'reviewer-1', outcome: 'fail', reviewerAuthentication: 'assurance_reviewer_credential' });
    const newerDeclaredPass = legacyReview('assessment-direct', { reviewId: 'review-declared', outcome: 'pass' });
    let counter = 0;
    const result = await createAssuranceControlEvaluator().evaluate(control, scope, evidence, {
      assessmentId: 'assessment-direct',
      metrics: {},
      manualReviews: [authenticatedFail, newerDeclaredPass],
      scoringModel: RN_SV_FRAMEWORK_V0_1.scoringModel,
      evaluatedAt: '2026-06-15T00:00:00.000Z',
      nextId: (prefix) => `${prefix}-${++counter}`,
    });
    assert.equal(result.status, 'fail', 'the declared PASS is never promoted over the authenticated FAIL');
  });
});

// ---------------------------------------------------------------------------
// HTTP (#18) and Host configuration
// ---------------------------------------------------------------------------

const ORG_API_KEY = 'test-only-org-1-api-key-sec01b-000000000000';
const startedServers: EnterpriseServer[] = [];
const directories: string[] = [];
after(async () => {
  await Promise.all(startedServers.map((server) => server.close().catch(() => {})));
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

function httpConfiguration(requireAuthentication: boolean): EnterpriseConfiguration {
  const base = loadEnterpriseConfiguration({
    AOC_ENTERPRISE_HTTP_PORT: '0',
    AOC_ENTERPRISE_HTTP_HOST: '127.0.0.1',
    AOC_ENTERPRISE_KERNEL_AUTHORITY_ORGANIZATION_ID: 'org-1',
    ...(requireAuthentication ? { AOC_ENTERPRISE_REQUIRE_AUTH: 'true', AOC_ENTERPRISE_API_KEYS: `${ORG_API_KEY}:org-1` } : {}),
  });
  return { ...base, authentication: { ...base.authentication, assuranceReviewers: TEST_REVIEWERS.filter((reviewer) => reviewer.organizationId === 'org-1') } };
}

async function startServer(requireAuthentication: boolean): Promise<{ baseUrl: string; store: ReturnType<typeof createInMemoryAssuranceStore> }> {
  const store = createInMemoryAssuranceStore();
  const server = await createEnterpriseServer({ kernelProviders: buildTestKernelProviders(), configuration: httpConfiguration(requireAuthentication), assuranceStore: store });
  startedServers.push(server);
  const { port } = await server.listen();
  return { baseUrl: `http://127.0.0.1:${port}`, store };
}

async function pendingSafAssessment(baseUrl: string, authorization: Record<string, string>): Promise<string> {
  const headers = { 'content-type': 'application/json', ...authorization };
  const created = await fetch(`${baseUrl}/api/assurance/assessments`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      subject: { subjectType: 'agent', subjectId: 'agent-http', organizationId: 'org-1' },
      frameworkId: AOC_SAF_FRAMEWORK_ID,
      frameworkVersion: AOC_SAF_FRAMEWORK_VERSION,
      requestedBy: 'assessor-http',
      evidenceCutoffAt: '2026-12-31T00:00:00.000Z',
    }),
  });
  assert.equal(created.status, 201);
  const { assessmentId } = (await created.json()) as { assessmentId: string };
  const evaluated = await fetch(`${baseUrl}/api/assurance/assessments/${assessmentId}/evaluate`, { method: 'POST', headers, body: '{}' });
  assert.equal(evaluated.status, 200);
  return assessmentId;
}

function safReviewBody(assessmentId: string, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    assessmentId,
    controlId: 'saf.ops.independent-review',
    outcome: 'insufficient_evidence',
    rationale: 'No operational records were provided for the period.',
    evidenceReferenceIds: ['manual-note-1'],
    ...overrides,
  });
}

async function postReview(baseUrl: string, body: string, authorization?: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}/api/assurance/manual-reviews`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(authorization !== undefined ? { authorization } : {}) },
    body,
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe('SEC-01B HTTP: POST /api/assurance/manual-reviews authenticates a reviewer credential only (#18)', () => {
  it('refuses anonymous, organization-key and wrong-credential callers, and every impersonation, without writing anything', async () => {
    const { baseUrl, store } = await startServer(true);
    const assessmentId = await pendingSafAssessment(baseUrl, { authorization: `Bearer ${ORG_API_KEY}` });
    const reviewer1 = `Bearer ${testReviewerSecret('reviewer-1')}`;

    const refusals: readonly [string, string, string | undefined, number][] = [
      ['no credential', safReviewBody(assessmentId, { reviewerId: 'reviewer-1' }), undefined, 401],
      ['an organization API key', safReviewBody(assessmentId, { reviewerId: 'reviewer-1', reviewerRole: 'assurance-reviewer' }), `Bearer ${ORG_API_KEY}`, 401],
      ['an unknown secret', safReviewBody(assessmentId), 'Bearer not-a-configured-reviewer-secret-00000000', 401],
      ['a reviewer declaring another reviewerId', safReviewBody(assessmentId, { reviewerId: 'reviewer-2' }), reviewer1, 403],
      ['a reviewer without the required role, declaring it', safReviewBody(assessmentId, { reviewerRole: 'assurance-reviewer' }), `Bearer ${testReviewerSecret('intern-1')}`, 403],
      ['a reviewer without the required role, smuggling roles', safReviewBody(assessmentId, { roles: ['assurance-reviewer'], system: true }), `Bearer ${testReviewerSecret('intern-1')}`, 403],
    ];
    for (const [label, body, authorization, status] of refusals) {
      const reply = await postReview(baseUrl, body, authorization);
      assert.equal(reply.status, status, label);
      if (status === 403) assert.equal((reply.body['error'] as { code?: string } | undefined)?.code, 'ASSURANCE_REVIEWER_UNAUTHORIZED', label);
    }
    assert.deepEqual(await store.listManualReviews({ system: true }, assessmentId), [], 'no refused request reached the store');

    // The authenticated reviewer, with or without the optional v1 fields, is recorded under its own identity.
    const accepted = await postReview(baseUrl, safReviewBody(assessmentId), reviewer1);
    assert.equal(accepted.status, 201);
    assert.equal(accepted.body['reviewerId'], 'reviewer-1');
    assert.equal(accepted.body['reviewerRole'], 'assurance-reviewer');
    assert.equal(accepted.body['reviewerAuthentication'], 'assurance_reviewer_credential');
    const stored = await store.listManualReviews({ system: true }, assessmentId);
    assert.equal(stored.length, 1);
    assert.equal(stored[0]?.reviewerId, 'reviewer-1');
  });

  it('fails closed even when AOC_ENTERPRISE_REQUIRE_AUTH is off: the unauthenticated system context records no review', async () => {
    const { baseUrl, store } = await startServer(false);
    const assessmentId = await pendingSafAssessment(baseUrl, {});
    const anonymous = await postReview(baseUrl, safReviewBody(assessmentId, { reviewerId: 'reviewer-1', reviewerRole: 'assurance-reviewer' }));
    assert.equal(anonymous.status, 401);
    assert.deepEqual(await store.listManualReviews({ system: true }, assessmentId), []);
    const accepted = await postReview(baseUrl, safReviewBody(assessmentId, { reviewerId: 'reviewer-1', reviewerRole: 'assurance-reviewer' }), `Bearer ${testReviewerSecret('reviewer-1')}`);
    assert.equal(accepted.status, 201, 'v1 bodies that name the authenticated reviewer keep working');
  });
});

describe('SEC-01B configuration: reviewers are explicit, scoped, role-bearing and never share a secret', () => {
  const CUSTOMER_SECRET = 'SEC01B_FILE_CUSTOMER_SECRET_0123456789abcdef';
  const REVIEWER_SECRET = 'SEC01B_FILE_REVIEWER_SECRET_0123456789abcdef';
  const AUDITOR_SECRET = 'SEC01B_FILE_AUDITOR_SECRET_0123456789abcdef0';
  const SUBJECT = { system: 'datasys-app', subjectId: 'user-pmfreak' } as const;
  const PRINCIPAL = 'principal-pmfreak';

  function file(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      version: 1,
      trustDomainId: TRUST_DOMAIN_ID,
      grantLifetimeSeconds: 300,
      customerPrincipals: [{ principalId: PRINCIPAL, externalSubject: SUBJECT, apiKeyEnv: 'SEC01B_CUSTOMER_KEY' }],
      auditors: [{ auditorId: 'auditor-sec01b', apiKeyEnv: 'SEC01B_AUDITOR_KEY' }],
      assuranceReviewers: [{ reviewerId: 'reviewer-sec01b', roles: ['assure.reviewer'], apiKeyEnv: 'SEC01B_REVIEWER_KEY' }],
      routes: [{ action: 'draft_closure_email', adapterId: 'adapter-sec01b' }],
      ...overrides,
    };
  }

  function env(governed: Record<string, unknown>, overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
    const directory = mkdtempSync(join(tmpdir(), 'frontera-sec01b-reviewer-'));
    directories.push(directory);
    const path = join(directory, 'governed-actions.json');
    writeFileSync(path, JSON.stringify(governed));
    return {
      AOC_ENTERPRISE_REQUIRE_AUTH: 'true',
      AOC_ENTERPRISE_HTTP_HOST: '127.0.0.1',
      AOC_ENTERPRISE_KERNEL_AUTHORITY_ENABLED: 'true',
      AOC_ENTERPRISE_KERNEL_AUTHORITY_ORGANIZATION_ID: ORG,
      AOC_ENTERPRISE_GOVERNED_ACTIONS_FILE: path,
      SEC01B_CUSTOMER_KEY: CUSTOMER_SECRET,
      SEC01B_AUDITOR_KEY: AUDITOR_SECRET,
      SEC01B_REVIEWER_KEY: REVIEWER_SECRET,
      ...overrides,
    };
  }

  function refusalCode(environment: Record<string, string | undefined>): string {
    try {
      loadEnterpriseHostConfiguration(environment);
    } catch (error) {
      assert.ok(error instanceof EnterpriseHostConfigurationError, String(error));
      for (const secret of [CUSTOMER_SECRET, AUDITOR_SECRET, REVIEWER_SECRET]) assert.equal(error.message.includes(secret), false, 'no refusal names a secret');
      return error.code;
    }
    return assert.fail('the Host must refuse this configuration');
  }

  it('a valid reviewer resolves to the served organization with exactly its configured roles, apart from every ordinary key', () => {
    const { configuration } = loadEnterpriseHostConfiguration(env(file()));
    assert.deepEqual(configuration.authentication.assuranceReviewers, [{ reviewerId: 'reviewer-sec01b', organizationId: ORG, roles: ['assure.reviewer'], key: REVIEWER_SECRET }]);
    assert.equal(configuration.authentication.apiKeys.some((apiKey) => apiKey.key === REVIEWER_SECRET), false);
    assert.equal(JSON.stringify(configuration.authentication.auditors).includes(REVIEWER_SECRET), false);
  });

  const refusals: readonly [string, Record<string, unknown>, Record<string, string | undefined>, string][] = [
    ['an organization field', file({ assuranceReviewers: [{ reviewerId: 'r', roles: ['assure.reviewer'], apiKeyEnv: 'SEC01B_REVIEWER_KEY', organizationId: 'org-other' }] }), {}, 'HOST_GOVERNED_ACTIONS_FILE_INVALID'],
    ['an inline secret', file({ assuranceReviewers: [{ reviewerId: 'r', roles: ['assure.reviewer'], apiKey: REVIEWER_SECRET }] }), {}, 'HOST_GOVERNED_ACTIONS_FILE_INVALID'],
    ['an empty list', file({ assuranceReviewers: [] }), {}, 'HOST_GOVERNED_ACTIONS_FILE_INVALID'],
    ['no roles', file({ assuranceReviewers: [{ reviewerId: 'r', roles: [], apiKeyEnv: 'SEC01B_REVIEWER_KEY' }] }), {}, 'HOST_ASSURANCE_REVIEWER_INVALID'],
    ['a wildcard role', file({ assuranceReviewers: [{ reviewerId: 'r', roles: ['assure.*'], apiKeyEnv: 'SEC01B_REVIEWER_KEY' }] }), {}, 'HOST_ASSURANCE_REVIEWER_INVALID'],
    ['a short secret', file(), { SEC01B_REVIEWER_KEY: 'short' }, 'HOST_ASSURANCE_REVIEWER_INVALID'],
    ['an id shared with an auditor', file({ assuranceReviewers: [{ reviewerId: 'auditor-sec01b', roles: ['assure.reviewer'], apiKeyEnv: 'SEC01B_REVIEWER_KEY' }] }), {}, 'HOST_ASSURANCE_REVIEWER_INVALID'],
    ['an id shared with a customer principal', file({ assuranceReviewers: [{ reviewerId: PRINCIPAL, roles: ['assure.reviewer'], apiKeyEnv: 'SEC01B_REVIEWER_KEY' }] }), {}, 'HOST_ASSURANCE_REVIEWER_INVALID'],
    ['the reserved agent: prefix', file({ assuranceReviewers: [{ reviewerId: 'agent:r', roles: ['assure.reviewer'], apiKeyEnv: 'SEC01B_REVIEWER_KEY' }] }), {}, 'HOST_ASSURANCE_REVIEWER_INVALID'],
    ['a secret shared with an auditor', file(), { SEC01B_REVIEWER_KEY: AUDITOR_SECRET }, 'HOST_CREDENTIALS_AMBIGUOUS'],
    ['a secret shared with a legacy key', file(), { AOC_ENTERPRISE_API_KEYS: `${REVIEWER_SECRET}:${ORG}` }, 'HOST_CREDENTIALS_AMBIGUOUS'],
  ];
  for (const [label, governed, overrides, code] of refusals) {
    it(`Host: ${label} → ${code}`, () => {
      assert.equal(refusalCode(env(governed, overrides)), code);
    });
  }

  it('embedder: a reviewer for another organization or sharing an API key secret is refused before anything is composed', async () => {
    const base = loadEnterpriseConfiguration({ AOC_ENTERPRISE_KERNEL_AUTHORITY_ORGANIZATION_ID: 'org-1', AOC_ENTERPRISE_API_KEYS: `${ORG_API_KEY}:org-1` });
    const valid = { reviewerId: 'reviewer-embedder', organizationId: 'org-1', roles: ['assure.reviewer'], key: 'test-only-embedder-reviewer-secret-0000000' };
    for (const reviewer of [
      { ...valid, organizationId: 'org-2' },
      { ...valid, key: ORG_API_KEY },
      { ...valid, roles: [] },
    ]) {
      await assert.rejects(
        () => createEnterprise({ kernelProviders: buildTestKernelProviders(), configuration: { ...base, authentication: { ...base.authentication, assuranceReviewers: [reviewer] } } }),
        (error: unknown) => error instanceof AssuranceReviewerConfigurationError,
      );
    }
  });

  it('the public configuration view never carries a reviewer secret', async () => {
    const base = loadEnterpriseConfiguration({ AOC_ENTERPRISE_KERNEL_AUTHORITY_ORGANIZATION_ID: 'org-1' });
    const enterprise = await createEnterprise({
      kernelProviders: buildTestKernelProviders(),
      configuration: { ...base, authentication: { ...base.authentication, assuranceReviewers: TEST_REVIEWERS.filter((reviewer) => reviewer.organizationId === 'org-1') } },
    });
    try {
      const view = JSON.stringify(enterprise.configuration);
      for (const reviewer of TEST_REVIEWERS) assert.equal(view.includes(reviewer.key), false);
    } finally {
      await enterprise.close();
    }
  });
});

function rnSvHarness(): AssuranceTestHarness {
  return buildAssuranceHarness({ framework: RN_SV_FRAMEWORK_V0_1 });
}
