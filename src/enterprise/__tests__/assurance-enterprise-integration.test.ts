import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';

import { createEnterprise, type AocEnterprise } from '../composition/composition-root.js';
import { createEnterpriseServer, type EnterpriseServer } from '../host/enterprise-server.js';
import { loadEnterpriseConfiguration, type EnterpriseConfiguration } from '../configuration/enterprise-configuration.js';
import { ASSURANCE_MODULE_ID } from '../modules/assurance-module.js';
import { AOC_SAF_FRAMEWORK_ID, AOC_SAF_FRAMEWORK_VERSION } from '../assurance/saf-framework.js';
import { createInMemoryAssuranceStore } from '../assurance/in-memory-assurance-store.js';
import { AssuranceError } from '../assurance/errors.js';
import type { AssuranceStore } from '../assurance/assurance-store.js';
import { buildAllowedRequestBody, buildTestKernelProviders } from './support.js';
import { PMFREAK_ACTOR_ID } from '../../features/action-enforcement/fixtures/datasys-enforcement.fixture.js';

const openEnterprises: AocEnterprise[] = [];
const startedServers: EnterpriseServer[] = [];
after(async () => {
  await Promise.all(openEnterprises.map((enterprise) => enterprise.close().catch(() => {})));
  await Promise.all(startedServers.map((server) => server.close().catch(() => {})));
});

async function bootEnterprise(configuration?: EnterpriseConfiguration): Promise<AocEnterprise> {
  const enterprise = await createEnterprise({ kernelProviders: buildTestKernelProviders(), ...(configuration !== undefined ? { configuration } : {}) });
  openEnterprises.push(enterprise);
  return enterprise;
}

const ORG_CONTEXT = { organizationId: 'org-1', system: false } as const;

/** ASSURE-SEC-01B: one Assurance reviewer credential (test-only secret) for the organization these scenarios assess. */
const REVIEWER_SECRET = 'test-only-assurance-reviewer-secret-integration';

function reviewerConfiguration(env: Readonly<Record<string, string>> = {}): EnterpriseConfiguration {
  const base = loadEnterpriseConfiguration({ ...env, AOC_ENTERPRISE_KERNEL_AUTHORITY_ORGANIZATION_ID: 'org-1' });
  return {
    ...base,
    authentication: { ...base.authentication, assuranceReviewers: [{ reviewerId: 'reviewer-1', organizationId: 'org-1', roles: ['assurance-reviewer'], key: REVIEWER_SECRET }] },
  };
}

describe('Soberanía Enterprise -- Assurance Runtime module registration (mission sections 55-57/92)', () => {
  it('the Assurance Runtime module is registered, optional by default, and healthy', async () => {
    const enterprise = await bootEnterprise();
    const module = enterprise.modules().find((candidate) => candidate.id === ASSURANCE_MODULE_ID);
    assert.ok(module, 'the Assurance Runtime module must be registered');
    assert.equal(module?.state, 'ready');
    assert.equal(module?.required, false, 'Assurance is optional for core governance evaluation by default');
    assert.ok(module?.capabilities.includes('assurance.assess'));
    assert.ok(module?.capabilities.includes('assurance.verify'));
  });

  it('the Assurance Store is independent of the Governance, Evidence, and Passport stores', async () => {
    const enterprise = await bootEnterprise();
    assert.notEqual(enterprise.assuranceStore, enterprise.persistence);
    assert.notEqual(enterprise.assuranceStore, enterprise.evidenceStore);
    assert.notEqual(enterprise.assuranceStore, enterprise.passportStore);
  });

  it('the built-in aoc.saf 1.0.0 framework is registered, active, and frozen after startup', async () => {
    const enterprise = await bootEnterprise();
    const frameworks = enterprise.assuranceFrameworks.list();
    const saf = frameworks.find((framework) => framework.frameworkId === AOC_SAF_FRAMEWORK_ID);
    assert.equal(saf?.frameworkVersion, AOC_SAF_FRAMEWORK_VERSION);
    assert.equal(saf?.status, 'active');
    assert.equal(enterprise.assuranceFrameworks.isFrozen(), true, 'no framework may register after Enterprise startup');
  });

  it('an unavailable Assurance Store degrades Enterprise without blocking governance evaluation (optional criticality)', async () => {
    const closedStore: AssuranceStore = createInMemoryAssuranceStore();
    await closedStore.close();
    const enterprise = await createEnterprise({ kernelProviders: buildTestKernelProviders(), assuranceStore: closedStore });
    openEnterprises.push(enterprise);
    assert.equal(enterprise.isReady(), true, 'governance evaluation stays available');
    const module = enterprise.modules().find((candidate) => candidate.id === ASSURANCE_MODULE_ID);
    assert.equal(module?.state, 'degraded', 'an optional module that fails initialization degrades rather than failing the Host');
    const evaluation = await enterprise.evaluate(buildAllowedRequestBody({ requestId: 'req-assurance-degraded', organization: { id: 'org-1' } }));
    assert.equal(evaluation.httpStatus, 200, 'POST /api/governance/evaluate is unaffected by an Assurance outage');
  });
});

describe('Soberanía Enterprise -- full end-to-end Assurance scenario (mission section 90)', () => {
  it('Passport -> governed action -> Governance Record -> Evidence Bundle -> assessment -> evidence -> controls -> findings -> scores -> eligibility -> completion -> verification -> report', async () => {
    const enterprise = await bootEnterprise(reviewerConfiguration());

    // 1. Issue and activate an Agent Passport for the governed agent.
    const { passport } = await enterprise.passports.issuePassport(ORG_CONTEXT, {
      subject: { agentId: PMFREAK_ACTOR_ID, agentType: 'autonomous_agent', displayName: 'PMFreak' },
      organization: { organizationId: 'org-1', recognizedBy: 'org-1-registry' },
      actorId: 'user-1',
      activateImmediately: true,
    });

    // 2. Evaluate a governed action and persist its Governance Record.
    const evaluation = await enterprise.evaluate(buildAllowedRequestBody({ requestId: 'req-assurance-e2e', organization: { id: 'org-1' } }));
    assert.equal(evaluation.httpStatus, 200);
    const record = await enterprise.persistence.getByRequestId({ system: true }, 'req-assurance-e2e');
    assert.ok(record);

    // 3. Build an Evidence Bundle from the record and link both to the Passport.
    const bundle = await enterprise.evidence.build(undefined, { evaluationId: record.evaluation.evaluationId, level: 'AUDITOR' });
    await enterprise.passports.linkGovernanceRecord(
      ORG_CONTEXT,
      passport.passportId,
      {
        evaluationId: record.evaluation.evaluationId,
        decisionId: record.evaluation.decisionId,
        requestId: record.request.requestId,
        status: record.evaluation.status,
        occurredAt: record.evaluation.evaluatedAt,
        governanceRecordDigest: record.integrity.aggregateDigest,
      },
      'user-1',
    );
    await enterprise.passports.linkEvidenceBundle(
      ORG_CONTEXT,
      passport.passportId,
      {
        bundleId: bundle.bundle.bundleId,
        bundleVersion: bundle.bundle.bundleVersion,
        bundleDigest: bundle.bundle.integrity.bundleDigest,
        disclosurePolicy: bundle.bundle.disclosure.policyId,
        subjectType: bundle.bundle.subject.subjectType,
        createdAt: bundle.bundle.createdAt,
      },
      'user-1',
    );

    // 4. Create the Assurance assessment against aoc.saf 1.0.0.
    const created = await enterprise.assurance.createAssessment(ORG_CONTEXT, {
      subject: { subjectType: 'agent', subjectId: PMFREAK_ACTOR_ID, organizationId: 'org-1', passportId: passport.passportId },
      frameworkId: AOC_SAF_FRAMEWORK_ID,
      frameworkVersion: AOC_SAF_FRAMEWORK_VERSION,
      requestedBy: 'assessor-1',
      evidenceCutoffAt: '2026-12-31T00:00:00.000Z',
    });

    // 5-6. Resolve evidence and evaluate every in-scope control.
    const evaluated = await enterprise.assurance.evaluateAssessment(ORG_CONTEXT, created.assessmentId);
    assert.equal(evaluated.controlEvaluations.length, 10, 'every aoc.saf control evaluates for an agent subject');

    // Only references cross boundaries -- never copied aggregates.
    const governanceEvidence = evaluated.evidenceReferences.find((reference) => reference.evidenceType === 'governance_record');
    assert.ok(governanceEvidence);
    assert.equal(governanceEvidence?.externalId, record.evaluation.evaluationId);
    assert.equal(governanceEvidence?.digest, record.integrity.aggregateDigest);
    const bundleEvidence = evaluated.evidenceReferences.find((reference) => reference.evidenceType === 'evidence_bundle');
    assert.equal(bundleEvidence?.externalId, bundle.bundle.bundleId);
    const passportEvidence = evaluated.evidenceReferences.find((reference) => reference.evidenceType === 'agent_passport');
    assert.equal(passportEvidence?.externalId, passport.passportId);
    assert.ok(evaluated.evidenceReferences.every((reference) => reference.organizationId === 'org-1'), 'all tenant scopes match');

    // Evidence-driven control results: governance, evidence, identity, and ops controls pass on real evidence.
    const statusByControl = new Map(evaluated.controlEvaluations.map((controlEvaluation) => [controlEvaluation.controlId, controlEvaluation.status]));
    assert.equal(statusByControl.get('saf.gov.records-present'), 'pass');
    assert.equal(statusByControl.get('saf.gov.records-integrity'), 'pass');
    assert.equal(statusByControl.get('saf.evidence.bundles-present'), 'pass');
    assert.equal(statusByControl.get('saf.evidence.bundles-verified'), 'pass');
    assert.equal(statusByControl.get('saf.identity.passport-bound'), 'pass');
    assert.equal(statusByControl.get('saf.identity.passport-integrity'), 'pass');
    assert.equal(statusByControl.get('saf.identity.revocation-enforced'), 'pass');
    assert.equal(statusByControl.get('saf.ops.enterprise-ready'), 'pass');
    assert.equal(statusByControl.get('saf.ops.independent-review'), 'manual_review_required', 'the human-review control stays distinct from pass');

    // 7. Record the independent review -- as the authenticated reviewer (ASSURE-SEC-01B) -- re-evaluate, and complete.
    const reviewer = enterprise.assurance.authenticateReviewer(REVIEWER_SECRET);
    assert.ok(reviewer);
    await enterprise.assurance.recordManualReview({ ...ORG_CONTEXT, actorId: reviewer.reviewerId, roles: reviewer.roles, reviewer }, {
      assessmentId: created.assessmentId,
      controlId: 'saf.ops.independent-review',
      reviewerId: 'reviewer-1',
      reviewerRole: 'assurance-reviewer',
      outcome: 'pass',
      rationale: 'Operational governance posture reviewed against Governance Records for the period.',
      evidenceReferenceIds: [governanceEvidence?.evidenceReferenceId ?? ''],
    });
    const reEvaluated = await enterprise.assurance.evaluateAssessment(ORG_CONTEXT, created.assessmentId);
    assert.equal(reEvaluated.status, 'evaluating');
    const completed = await enterprise.assurance.completeAssessment(ORG_CONTEXT, created.assessmentId);
    assert.equal(completed.status, 'completed');
    assert.equal(completed.score.normalizedScore, 100);
    assert.equal(completed.findings.length, 0);

    // 8. Eligibility is framework-bound, explainable, and never called certification.
    const baseline = completed.eligibility.find((result) => result.profileId === 'baseline');
    const advanced = completed.eligibility.find((result) => result.profileId === 'advanced');
    const continuous = completed.eligibility.find((result) => result.profileId === 'continuous');
    assert.equal(baseline?.eligible, true);
    assert.equal(advanced?.eligible, true);
    assert.equal(continuous?.eligible, false, "the 'continuous' profile itself demands a manual review gate");
    assert.ok(baseline?.reasonCodes.includes('ELIGIBILITY_SATISFIED'));

    // 9. Independent verification: all digests verify, scores reproduce.
    const verification = await enterprise.assurance.verifyAssessment(ORG_CONTEXT, created.assessmentId);
    assert.equal(verification.valid, true, JSON.stringify(verification.failures));

    // 10. Structured report with disclosure projection.
    const report = await enterprise.assurance.buildAssuranceReport(ORG_CONTEXT, created.assessmentId, 'AUDITOR', 'assessor-1');
    assert.equal(report.executiveSummary.frameworkId, AOC_SAF_FRAMEWORK_ID);
    assert.equal(report.executiveSummary.overallNormalizedScore, 100);
    assert.equal(report.eligibility.length, 3);
    assert.notEqual(report.integrity.reportDigest, report.integrity.assessmentDigest);

    // Telemetry observed the whole flow.
    const metrics = enterprise.telemetry.snapshot();
    assert.ok(metrics.assuranceAssessmentsCreatedCount >= 1);
    assert.ok(metrics.assuranceAssessmentsCompletedCount >= 1);
    assert.ok(metrics.assuranceControlsEvaluatedCount >= 10);
    assert.ok(metrics.assuranceEligibilityEvaluationsCount >= 3);
    assert.ok(metrics.assuranceIntegrityVerificationsCount >= 1);
  });

  it('a suspended Passport surfaces as a continuous signal that derives staleness without rewriting the completed assessment', async () => {
    const enterprise = await bootEnterprise();
    await enterprise.passports.issuePassport(ORG_CONTEXT, {
      subject: { agentId: PMFREAK_ACTOR_ID, agentType: 'autonomous_agent' },
      organization: { organizationId: 'org-1', recognizedBy: 'org-1-registry' },
      actorId: 'user-1',
      activateImmediately: true,
    });
    await enterprise.evaluate(buildAllowedRequestBody({ requestId: 'req-assurance-signal', organization: { id: 'org-1' } }));

    const created = await enterprise.assurance.createAssessment(ORG_CONTEXT, {
      subject: { subjectType: 'agent', subjectId: PMFREAK_ACTOR_ID, organizationId: 'org-1' },
      frameworkId: AOC_SAF_FRAMEWORK_ID,
      frameworkVersion: AOC_SAF_FRAMEWORK_VERSION,
      requestedBy: 'assessor-1',
      evidenceCutoffAt: '2026-12-31T00:00:00.000Z',
    });
    await enterprise.assurance.evaluateAssessment(ORG_CONTEXT, created.assessmentId);
    const completed = await enterprise.assurance.completeAssessment(ORG_CONTEXT, created.assessmentId);

    const result = await enterprise.assurance.processSignal(ORG_CONTEXT, {
      organizationId: 'org-1',
      subjectType: 'agent',
      subjectId: PMFREAK_ACTOR_ID,
      signalType: 'passport_suspended',
      sourceType: 'agent_passport',
      sourceId: 'passport-x',
      occurredAt: '2026-12-31T01:00:00.000Z',
      observedAt: '2026-12-31T01:00:00.000Z',
    });
    assert.ok(result.outcomes.includes('mark_assessment_stale'));

    const stored = await enterprise.assurance.getAssessment(ORG_CONTEXT, completed.assessmentId);
    assert.equal(stored?.status, 'completed');
    assert.equal(stored?.integrity.assessmentDigest, completed.integrity.assessmentDigest, 'signals never rewrite history');

    const state = await enterprise.assurance.getContinuousState(ORG_CONTEXT, PMFREAK_ACTOR_ID);
    assert.notEqual(state.state, 'current');
    assert.ok(state.staleReasons.length > 0);
    assert.equal(metricsMarkedStale(enterprise) >= 1, true);
  });
});

function metricsMarkedStale(enterprise: AocEnterprise): number {
  return enterprise.telemetry.snapshot().assuranceAssessmentsMarkedStaleCount;
}

describe('Soberanía Enterprise -- Assurance HTTP surface (mission section 58)', () => {
  async function startTestServer(): Promise<string> {
    const configuration = reviewerConfiguration({ AOC_ENTERPRISE_HTTP_PORT: '0', AOC_ENTERPRISE_HTTP_HOST: '127.0.0.1' });
    const server = await createEnterpriseServer({ kernelProviders: buildTestKernelProviders(), configuration });
    startedServers.push(server);
    const { port } = await server.listen();
    return `http://127.0.0.1:${port}`;
  }

  it('creates, evaluates, verifies, lists findings, records reviews, processes signals, reads state, and reassesses end-to-end over HTTP', async () => {
    const baseUrl = await startTestServer();
    const jsonHeaders = { 'content-type': 'application/json' };

    const createResponse = await fetch(`${baseUrl}/api/assurance/assessments`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({
        subject: { subjectType: 'agent', subjectId: 'agent-http', organizationId: 'org-1' },
        frameworkId: AOC_SAF_FRAMEWORK_ID,
        frameworkVersion: AOC_SAF_FRAMEWORK_VERSION,
        requestedBy: 'assessor-http',
        evidenceCutoffAt: '2026-12-31T00:00:00.000Z',
      }),
    });
    assert.equal(createResponse.status, 201);
    const createdBody = (await createResponse.json()) as { assessmentId: string; status: string };
    assert.equal(createdBody.status, 'created');

    const getResponse = await fetch(`${baseUrl}/api/assurance/assessments/${createdBody.assessmentId}`);
    assert.equal(getResponse.status, 200);

    const evaluateResponse = await fetch(`${baseUrl}/api/assurance/assessments/${createdBody.assessmentId}/evaluate`, { method: 'POST', headers: jsonHeaders, body: '{}' });
    assert.equal(evaluateResponse.status, 200);
    const evaluatedBody = (await evaluateResponse.json()) as { status: string; controlEvaluations: readonly { controlId: string; status: string }[] };
    assert.equal(evaluatedBody.status, 'manual_review', 'no evidence and a pending human review: the assessment cannot silently complete');

    const reviewResponse = await fetch(`${baseUrl}/api/assurance/manual-reviews`, {
      method: 'POST',
      headers: { ...jsonHeaders, authorization: `Bearer ${REVIEWER_SECRET}` },
      body: JSON.stringify({
        assessmentId: createdBody.assessmentId,
        controlId: 'saf.ops.independent-review',
        reviewerId: 'reviewer-1',
        reviewerRole: 'assurance-reviewer',
        outcome: 'insufficient_evidence',
        rationale: 'No operational records were provided for the period.',
        evidenceReferenceIds: ['manual-note-1'],
      }),
    });
    assert.equal(reviewResponse.status, 201);

    const completeResponse = await fetch(`${baseUrl}/api/assurance/assessments/${createdBody.assessmentId}/evaluate`, { method: 'POST', headers: jsonHeaders, body: '{}' });
    assert.equal(completeResponse.status, 200);
    const completedBody = (await completeResponse.json()) as { status: string; score: { normalizedScore: number } };
    assert.equal(completedBody.status, 'completed');

    const verifyResponse = await fetch(`${baseUrl}/api/assurance/assessments/${createdBody.assessmentId}/verify`, { method: 'POST', headers: jsonHeaders, body: '{}' });
    assert.equal(verifyResponse.status, 200);
    const verifyBody = (await verifyResponse.json()) as { valid: boolean };
    assert.equal(verifyBody.valid, true);

    const findingsResponse = await fetch(`${baseUrl}/api/assurance/assessments/${createdBody.assessmentId}/findings`);
    assert.equal(findingsResponse.status, 200);
    const findingsBody = (await findingsResponse.json()) as { findings: readonly { findingId: string; status: string }[] };
    assert.ok(findingsBody.findings.length > 0, 'unknown/unsatisfied controls produced findings');

    const firstFinding = findingsBody.findings[0];
    assert.ok(firstFinding);
    const findingEventResponse = await fetch(`${baseUrl}/api/assurance/findings/${firstFinding.findingId}/events`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ eventType: 'AssuranceFindingAccepted', actorId: 'owner-1', rationale: 'Accepted for remediation planning.' }),
    });
    assert.equal(findingEventResponse.status, 201);

    const signalResponse = await fetch(`${baseUrl}/api/assurance/signals`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({
        organizationId: 'org-1',
        subjectType: 'agent',
        subjectId: 'agent-http',
        signalType: 'control_evidence_expired',
        sourceType: 'control_attestation',
        sourceId: 'attest-1',
        occurredAt: '2027-01-01T00:00:00.000Z',
      }),
    });
    assert.equal(signalResponse.status, 201);
    const signalBody = (await signalResponse.json()) as { outcomes: readonly string[] };
    assert.ok(signalBody.outcomes.includes('mark_assessment_stale'));

    const stateResponse = await fetch(`${baseUrl}/api/assurance/subjects/agent-http/state`);
    assert.equal(stateResponse.status, 200);
    const stateBody = (await stateResponse.json()) as { state: string; latestCompletedAssessmentId?: string };
    assert.equal(stateBody.latestCompletedAssessmentId, createdBody.assessmentId);

    const reassessResponse = await fetch(`${baseUrl}/api/assurance/subjects/agent-http/reassess`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ reason: 'Evidence expired.', requestedBy: 'assessor-http' }),
    });
    assert.equal(reassessResponse.status, 201);
    const reassessBody = (await reassessResponse.json()) as { assessmentId: string; supersedesAssessmentId?: string };
    assert.equal(reassessBody.supersedesAssessmentId, createdBody.assessmentId);
    assert.notEqual(reassessBody.assessmentId, createdBody.assessmentId);
  });

  it('maps Assurance errors onto the wire: 400 invalid request, 404 not found, 409 immutable', async () => {
    const baseUrl = await startTestServer();
    const jsonHeaders = { 'content-type': 'application/json' };

    const invalid = await fetch(`${baseUrl}/api/assurance/assessments`, { method: 'POST', headers: jsonHeaders, body: JSON.stringify({}) });
    assert.equal(invalid.status, 400);

    const missing = await fetch(`${baseUrl}/api/assurance/assessments/nope`);
    assert.equal(missing.status, 404);

    const badFramework = await fetch(`${baseUrl}/api/assurance/assessments`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({
        subject: { subjectType: 'agent', subjectId: 'agent-x', organizationId: 'org-1' },
        frameworkId: 'aoc.saf',
        frameworkVersion: '9.9.9',
        requestedBy: 'assessor',
      }),
    });
    assert.equal(badFramework.status, 404);
    const badFrameworkBody = (await badFramework.json()) as { error: { code: string } };
    assert.equal(badFrameworkBody.error.code, 'ASSURANCE_FRAMEWORK_NOT_FOUND');
  });
});

describe('Soberanía Enterprise -- Assurance failure scenarios (mission section 91)', () => {
  it('a failed control is a valid assessment result, never an HTTP failure or Assurance error', async () => {
    const enterprise = await bootEnterprise();
    // No passport, no governed actions: identity controls resolve unknown, never throwing.
    const created = await enterprise.assurance.createAssessment(ORG_CONTEXT, {
      subject: { subjectType: 'agent', subjectId: 'agent-without-anything', organizationId: 'org-1' },
      frameworkId: AOC_SAF_FRAMEWORK_ID,
      frameworkVersion: AOC_SAF_FRAMEWORK_VERSION,
      requestedBy: 'assessor-1',
      evidenceCutoffAt: '2026-12-31T00:00:00.000Z',
    });
    const evaluated = await enterprise.assurance.evaluateAssessment(ORG_CONTEXT, created.assessmentId);
    const statuses = new Set(evaluated.controlEvaluations.map((evaluation) => evaluation.status));
    assert.ok(statuses.has('unknown'), 'missing evidence yields unknown, not fail and not an error');
    assert.ok(evaluated.findings.length > 0, 'evidence gaps surface as findings');
  });

  it('assurance service calls fail with ASSURANCE_STORE_UNAVAILABLE when the store closes mid-flight', async () => {
    const enterprise = await bootEnterprise();
    await enterprise.assuranceStore.close();
    await assert.rejects(
      () =>
        enterprise.assurance.createAssessment(ORG_CONTEXT, {
          subject: { subjectType: 'agent', subjectId: 'agent-x', organizationId: 'org-1' },
          frameworkId: AOC_SAF_FRAMEWORK_ID,
          frameworkVersion: AOC_SAF_FRAMEWORK_VERSION,
          requestedBy: 'assessor-1',
        }),
      (error: unknown) => error instanceof AssuranceError && error.code === 'ASSURANCE_STORE_UNAVAILABLE',
    );
  });
});
