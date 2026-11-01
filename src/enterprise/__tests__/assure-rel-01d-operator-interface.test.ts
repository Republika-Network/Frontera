import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { bootEnterpriseHost } from '../host/enterprise-host.js';
import { EnterpriseHostConfigurationError } from '../host/host-configuration.js';
import { withDeploymentWitness } from './core07-freshness-fixture.js';
import { ORG, call, capturingLogger, createWorkspace, errorCode, logLines, responses, type Reply } from './ctrl02-host-fixture.js';
import { PILOT_ORG, buildPilotWorld, runPilotHappyPath } from './assure-pilot-01-scenario.js';
import {
  ALL_SECRETS,
  REL01D_AUTH,
  REL01D_IDS,
  bootRel01d,
  completedAssessmentOverHttp,
  createRnSvAssessment,
  draftBody,
  hostEvidence,
  rel01dEnv,
  releaseBody,
  reviewAllOverHttp,
  type Rel01dHost,
} from './assure-rel-01d-host-fixture.js';

/**
 * ASSURE-REL-01D -- the Secure Host Operator Interface, adversarially, through
 * the real Enterprise Host (production posture) over HTTP.
 *
 * The operator identity is the SEC-01B Assurance reviewer credential: nothing
 * else -- no organization key, operator secret, system context or body field --
 * authenticates an operator, assigns a role, names an actor or approves a
 * release. A release needs `assure.report-release`, durable custody, the exact
 * current digest and an approver who did not review the assessment.
 */

const workspace = createWorkspace('frontera-rel01d-');
after(() => workspace.close());

const NO_STORE = 'no-store';

interface Foreign {
  readonly assessmentId: string;
  readonly reportId: string;
  readonly delivered: Record<string, unknown>;
}

/** Seeds another organization's completed assessment and kept release into the Host's Assurance file before it boots. */
async function seedForeign(assurancePath: string): Promise<Foreign> {
  const world = await buildPilotWorld(assurancePath);
  try {
    const { assessment, draft, release } = await runPilotHappyPath(world);
    assert.equal(assessment.subject.organizationId, PILOT_ORG);
    return { assessmentId: assessment.assessmentId, reportId: draft.content.reportId, delivered: { content: draft.content, markdown: draft.markdown, manifest: draft.manifest, release } };
  } finally {
    await world.store.close();
  }
}

/** Sends a request whose raw body is not even JSON: a route that reads the body before authorizing would answer 400. */
async function unreadable(baseUrl: string, method: string, path: string, authorization?: string): Promise<Reply> {
  return call(baseUrl, method, path, { ...(authorization !== undefined ? { authorization } : {}), ...(method === 'POST' ? { rawBody: '{ not json' } : {}) });
}

async function noStoreHeader(baseUrl: string, method: string, path: string, authorization: string, body?: unknown): Promise<string | null> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { authorization, 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  await response.text();
  return response.headers.get('cache-control');
}

const isReason = (reply: Reply, reason: string): boolean => ((reply.body['error'] as Record<string, unknown> | undefined)?.['reason'] ?? ((reply.body['error'] as Record<string, unknown> | undefined)?.['details'] as Record<string, unknown> | undefined)?.['reason']) === reason;

describe('ASSURE-REL-01D operator interface -- the real Host, over HTTP', () => {
  let booted: Rel01dHost;
  let foreign: Foreign;
  let baseUrl: string;

  before(async () => {
    const dir = workspace.dir();
    foreign = await seedForeign(`${dir}/assurance.sqlite`);
    booted = await bootRel01d(workspace, dir, rel01dEnv(dir));
    baseUrl = booted.baseUrl;
  });

  const operatorRoutes = (assessmentId: string, reportId: string): readonly (readonly [string, string])[] => [
    ['POST', `/api/assurance/assessments/${assessmentId}/evidence`],
    ['POST', `/api/assurance/assessments/${assessmentId}/terminate`],
    ['POST', `/api/assurance/assessments/${assessmentId}/commercial-report/draft`],
    ['POST', `/api/assurance/assessments/${assessmentId}/commercial-report/release`],
    ['GET', `/api/assurance/assessments/${assessmentId}/commercial-releases`],
    ['GET', `/api/assurance/commercial-releases/${reportId}`],
    ['POST', '/api/assurance/commercial-releases/verify'],
  ];

  it('O01 every operator route refuses no credential, an organization key, an operator secret and an unknown token -- 401, no-store, before the body is read', async () => {
    const created = await createRnSvAssessment(baseUrl, REL01D_AUTH.reviewer);
    assert.equal(created.status, 201, created.text);
    const assessmentId = created.body['assessmentId'] as string;
    for (const [method, path] of operatorRoutes(assessmentId, 'any-report')) {
      for (const authorization of [undefined, REL01D_AUTH.organizationKey, REL01D_AUTH.operator, REL01D_AUTH.unknown]) {
        const reply = await unreadable(baseUrl, method, path, authorization);
        assert.equal(reply.status, 401, `${method} ${path} with ${authorization === undefined ? 'no credential' : 'a non-reviewer credential'}: ${reply.text.slice(0, 200)}`);
        assert.equal(errorCode(reply), 'AUTHENTICATION_FAILED');
      }
      assert.equal(await noStoreHeader(baseUrl, method, path, REL01D_AUTH.organizationKey, method === 'POST' ? {} : undefined), NO_STORE, `${method} ${path} 401 is not cached`);
    }
    const stored = await call(baseUrl, 'GET', `/api/assurance/assessments/${assessmentId}`, { authorization: REL01D_AUTH.reviewer });
    assert.equal(stored.body['status'], 'created', 'nothing was written by a refused caller');
  });

  it('O02 roles are enforced before the body: an approver cannot collect, end or create; a reviewer cannot release; both may read and draft', async () => {
    const created = await createRnSvAssessment(baseUrl, REL01D_AUTH.reviewer);
    const assessmentId = created.body['assessmentId'] as string;
    for (const [path, authorization] of [
      [`/api/assurance/assessments/${assessmentId}/evidence`, REL01D_AUTH.approver],
      [`/api/assurance/assessments/${assessmentId}/terminate`, REL01D_AUTH.approver],
      [`/api/assurance/assessments/${assessmentId}/commercial-report/release`, REL01D_AUTH.reviewer],
    ] as const) {
      const reply = await unreadable(baseUrl, 'POST', path, authorization);
      assert.equal(reply.status, 403, `${path}: ${reply.text.slice(0, 200)}`);
      assert.equal(errorCode(reply), 'ASSURANCE_REVIEWER_UNAUTHORIZED');
    }
    const approverCreate = await createRnSvAssessment(baseUrl, REL01D_AUTH.approver);
    assert.equal(approverCreate.status, 403, 'a v1 write needs assure.reviewer');
    assert.equal((await call(baseUrl, 'GET', `/api/assurance/assessments/${assessmentId}`, { authorization: REL01D_AUTH.approver })).status, 200, 'an approver reads');
    // Authorized for both roles: the draft reaches the service, which answers for the assessment's state (not completed yet).
    for (const authorization of [REL01D_AUTH.approver, REL01D_AUTH.reviewer]) {
      const draft = await call(baseUrl, 'POST', `/api/assurance/assessments/${assessmentId}/commercial-report/draft`, { authorization, body: draftBody() });
      assert.equal(draft.status, 409, draft.text.slice(0, 300));
      assert.equal(errorCode(draft), 'ASSURANCE_ASSESSMENT_INCOMPLETE');
    }
  });

  it('O03 the actor of a reviewer write is the credential: a forged requestedBy is refused, a restated one accepted, an absent one derived', async () => {
    const forged = await createRnSvAssessment(baseUrl, REL01D_AUTH.reviewer, { requestedBy: REL01D_IDS.reviewer2 });
    assert.equal(forged.status, 403, forged.text);
    assert.equal(errorCode(forged), 'ASSURANCE_REVIEWER_UNAUTHORIZED');
    const restated = await createRnSvAssessment(baseUrl, REL01D_AUTH.reviewer, { requestedBy: REL01D_IDS.reviewer });
    assert.equal(restated.status, 201);
    const derived = await createRnSvAssessment(baseUrl, REL01D_AUTH.reviewer2);
    assert.equal(derived.status, 201);
    assert.equal((restated.body['provenance'] as Record<string, unknown>)['requestedBy'], REL01D_IDS.reviewer);
    assert.equal((derived.body['provenance'] as Record<string, unknown>)['requestedBy'], REL01D_IDS.reviewer2);
    // Outside reviewer-only mode the v1 organization-key path is unchanged (and still requires requestedBy).
    const v1 = await createRnSvAssessment(baseUrl, REL01D_AUTH.organizationKey, { requestedBy: 'v1-caller' });
    assert.equal(v1.status, 201, v1.text);
    assert.equal((await createRnSvAssessment(baseUrl, REL01D_AUTH.organizationKey)).status, 400);
  });

  it('O04 request hygiene: JSON only (415), malformed or oversized bodies (400), strict evidence shape, no declared terminator -- all no-store', async () => {
    const created = await createRnSvAssessment(baseUrl, REL01D_AUTH.reviewer);
    const assessmentId = created.body['assessmentId'] as string;
    const evidencePath = `/api/assurance/assessments/${assessmentId}/evidence`;
    const plain = await call(baseUrl, 'POST', evidencePath, { authorization: REL01D_AUTH.reviewer, rawBody: JSON.stringify({ manualEvidence: hostEvidence() }), headers: { 'content-type': 'text/plain' } });
    assert.equal(plain.status, 415);
    assert.equal((await call(baseUrl, 'POST', evidencePath, { authorization: REL01D_AUTH.reviewer, rawBody: '{ not json' })).status, 400);
    // Over the 1 MiB bound the shared body reader answers 400 and drops the connection; a client may see either.
    const oversized = await call(baseUrl, 'POST', evidencePath, { authorization: REL01D_AUTH.reviewer, rawBody: JSON.stringify({ manualEvidence: [], pad: 'x'.repeat(1024 * 1024 + 16) }) }).then(
      (reply) => reply.status,
      () => 'connection closed',
    );
    assert.ok(oversized === 400 || oversized === 'connection closed', String(oversized));
    assert.equal((await call(baseUrl, 'POST', evidencePath, { authorization: REL01D_AUTH.reviewer, body: { manualEvidence: [] } })).status, 400);
    const shape = await call(baseUrl, 'POST', evidencePath, {
      authorization: REL01D_AUTH.reviewer,
      body: { manualEvidence: [{ ...hostEvidence()[0], verified: 'yes', supplierClaims: { verified: true }, provenance: { sourceSystem: 's' } }] },
    });
    assert.equal(shape.status, 400);
    const violations = JSON.stringify((shape.body['error'] as Record<string, unknown>)['details']);
    for (const expected of ['verified is a required boolean', 'supplierClaims is not an evidence reference field', 'provenance.collectedBy']) assert.ok(violations.includes(expected), `${expected} in ${violations}`);
    const terminatedBy = await call(baseUrl, 'POST', `/api/assurance/assessments/${assessmentId}/terminate`, { authorization: REL01D_AUTH.reviewer, body: { reasonCode: 'engagement_withdrawn', rationale: 'r', terminatedBy: REL01D_IDS.reviewer2 } });
    assert.equal(terminatedBy.status, 400);
    assert.equal(await noStoreHeader(baseUrl, 'POST', evidencePath, REL01D_AUTH.reviewer, { manualEvidence: [] }), NO_STORE);
    assert.equal((await call(baseUrl, 'GET', `/api/assurance/assessments/${assessmentId}`, { authorization: REL01D_AUTH.reviewer })).body['status'], 'created', 'no refused request changed the assessment');
  });

  let released: { assessmentId: string; reportId: string; record: Record<string, unknown>; delivered: Record<string, unknown> } | undefined;

  it('O05 draft, then an exact, acknowledged, durable release by a distinct approver; identity, staleness, replay and conflict are each answered precisely', async () => {
    const assessmentId = await completedAssessmentOverHttp(baseUrl, REL01D_AUTH.reviewer);
    const draftPath = `/api/assurance/assessments/${assessmentId}/commercial-report/draft`;
    const releasePath = `/api/assurance/assessments/${assessmentId}/commercial-report/release`;
    const draft = await call(baseUrl, 'POST', draftPath, { authorization: REL01D_AUTH.reviewer, body: draftBody() });
    assert.equal(draft.status, 200, draft.text.slice(0, 400));
    const content = draft.body['content'] as Record<string, unknown>;
    assert.equal((content['readiness'] as Record<string, unknown>)['status'], 'READY_FOR_RELEASE', JSON.stringify(content['readiness']).slice(0, 600));
    const digest = (draft.body['manifest'] as Record<string, unknown>)['contentDigest'] as string;
    assert.equal(((await call(baseUrl, 'GET', `/api/assurance/assessments/${assessmentId}/commercial-releases`, { authorization: REL01D_AUTH.reviewer })).body['releases'] as unknown[]).length, 0, 'a draft writes no release');

    const forged = await call(baseUrl, 'POST', releasePath, { authorization: REL01D_AUTH.approver, body: releaseBody(digest, { approvedBy: REL01D_IDS.approver2 }) });
    assert.equal(forged.status, 403, forged.text.slice(0, 300));
    assert.equal((await call(baseUrl, 'POST', releasePath, { authorization: REL01D_AUTH.approver, body: releaseBody(digest, { approverRole: 'assure.reviewer' }) })).status, 400);
    const stale = await call(baseUrl, 'POST', releasePath, { authorization: REL01D_AUTH.approver, body: releaseBody(`sha256:${'0'.repeat(64)}`) });
    assert.equal(stale.status, 409, stale.text.slice(0, 300));
    assert.equal(errorCode(stale), 'ASSURANCE_INTEGRITY_FAILED');
    assert.ok(isReason(stale, 'approved_digest_stale'), stale.text.slice(0, 300));
    const unacknowledged = await call(baseUrl, 'POST', releasePath, { authorization: REL01D_AUTH.approver, body: releaseBody(digest, { acknowledgements: { limitationsReviewed: true, commercialUseRestrictionAcknowledged: false } }) });
    assert.equal(unacknowledged.status, 400);

    const committed = await call(baseUrl, 'POST', releasePath, { authorization: REL01D_AUTH.approver, body: releaseBody(digest, { approvedBy: REL01D_IDS.approver }) });
    assert.equal(committed.status, 201, committed.text.slice(0, 400));
    assert.deepEqual(committed.body['custody'], { outcome: 'committed' });
    const release = committed.body['release'] as Record<string, unknown>;
    assert.equal(release['approvedBy'], REL01D_IDS.approver);
    assert.equal(release['approverRole'], 'assure.report-release');

    const replay = await call(baseUrl, 'POST', releasePath, { authorization: REL01D_AUTH.approver, body: releaseBody(digest) });
    assert.equal(replay.status, 200, replay.text.slice(0, 300));
    assert.deepEqual(replay.body['custody'], { outcome: 'replayed' });
    assert.deepEqual(replay.body['release'], release, 'the original release, not a new one');
    const conflict = await call(baseUrl, 'POST', releasePath, { authorization: REL01D_AUTH.approver2, body: releaseBody(digest) });
    assert.equal(conflict.status, 409, conflict.text.slice(0, 300));
    assert.equal(errorCode(conflict), 'ASSURANCE_ASSESSMENT_IMMUTABLE');

    const reportId = (draft.body['content'] as Record<string, unknown>)['reportId'] as string;
    const kept = await call(baseUrl, 'GET', `/api/assurance/commercial-releases/${reportId}`, { authorization: REL01D_AUTH.reviewer });
    assert.equal(kept.status, 200, kept.text.slice(0, 300));
    assert.deepEqual(kept.body['release'], release);
    const listed = await call(baseUrl, 'GET', `/api/assurance/assessments/${assessmentId}/commercial-releases`, { authorization: REL01D_AUTH.approver });
    assert.equal((listed.body['releases'] as unknown[]).length, 1);
    released = { assessmentId, reportId, record: kept.body, delivered: { content: draft.body['content'], markdown: draft.body['markdown'], manifest: draft.body['manifest'], release } };
  });

  it('O06 verification answers integrity and the Host authority separately, never claims a signature, and catches tampering', async () => {
    assert.ok(released);
    const verify = (delivered: unknown) => call(baseUrl, 'POST', '/api/assurance/commercial-releases/verify', { authorization: REL01D_AUTH.reviewer, body: delivered });
    const good = await verify(released.delivered);
    assert.equal(good.status, 200, good.text.slice(0, 300));
    assert.equal(good.body['authority'], 'RELEASE_MATCHES_AUTHORITY');
    assert.equal(good.body['releaseAuthenticated'], true);
    assert.equal(good.body['externalSignature'], 'EXTERNAL_SIGNATURE_NOT_AVAILABLE');
    assert.equal(good.body['approverCurrentlyAuthorized'], true);

    const reworded = await verify({ ...released.delivered, markdown: `${String(released.delivered['markdown'])}\nAn added sentence.` });
    assert.equal(reworded.status, 200);
    assert.equal(reworded.body['releaseAuthenticated'], false);
    const reattributed = await verify({ ...released.delivered, release: { ...(released.delivered['release'] as Record<string, unknown>), approvedBy: REL01D_IDS.approver2 } });
    assert.equal(reattributed.body['releaseAuthenticated'], false);
    const unknownReport = await verify({ ...released.delivered, manifest: { ...(released.delivered['manifest'] as Record<string, unknown>), reportId: 'no-such-report' } });
    assert.equal(unknownReport.body['releaseAuthenticated'], false);
    assert.equal((await call(baseUrl, 'POST', '/api/assurance/commercial-releases/verify', { authorization: REL01D_AUTH.reviewer, body: { markdown: 'x' } })).status, 400);
  });

  it('O07 separation of duties: the credential that reviewed cannot release, even holding both roles or having reviewed one control; a distinct approver can', async () => {
    const byDual = await completedAssessmentOverHttp(baseUrl, REL01D_AUTH.dual);
    const draft = await call(baseUrl, 'POST', `/api/assurance/assessments/${byDual}/commercial-report/draft`, { authorization: REL01D_AUTH.dual, body: draftBody() });
    const digest = (draft.body['manifest'] as Record<string, unknown>)['contentDigest'] as string;
    const self = await call(baseUrl, 'POST', `/api/assurance/assessments/${byDual}/commercial-report/release`, { authorization: REL01D_AUTH.dual, body: releaseBody(digest) });
    assert.equal(self.status, 403, self.text.slice(0, 300));
    assert.equal(errorCode(self), 'ASSURANCE_REVIEWER_UNAUTHORIZED');
    assert.ok(isReason(self, 'separation_of_duties'), self.text.slice(0, 300));
    assert.equal(((await call(baseUrl, 'GET', `/api/assurance/assessments/${byDual}/commercial-releases`, { authorization: REL01D_AUTH.dual })).body['releases'] as unknown[]).length, 0, 'nothing was released');
    const distinct = await call(baseUrl, 'POST', `/api/assurance/assessments/${byDual}/commercial-report/release`, { authorization: REL01D_AUTH.approver, body: releaseBody(digest) });
    assert.equal(distinct.status, 201, distinct.text.slice(0, 300));

    // One control reviewed by the dual-role credential is enough to disqualify it.
    const created = await createRnSvAssessment(baseUrl, REL01D_AUTH.reviewer);
    const mixed = created.body['assessmentId'] as string;
    await call(baseUrl, 'POST', `/api/assurance/assessments/${mixed}/evidence`, { authorization: REL01D_AUTH.reviewer, body: { manualEvidence: hostEvidence() } });
    await call(baseUrl, 'POST', `/api/assurance/assessments/${mixed}/evaluate`, { authorization: REL01D_AUTH.reviewer, body: { complete: false } });
    await reviewAllOverHttp(baseUrl, REL01D_AUTH.reviewer, mixed, ['SV-01', 'SV-02', 'SV-03', 'SV-04', 'SV-05', 'SV-06', 'SV-07', 'SV-08', 'SV-09']);
    await reviewAllOverHttp(baseUrl, REL01D_AUTH.dual, mixed, ['SV-10']);
    assert.equal((await call(baseUrl, 'POST', `/api/assurance/assessments/${mixed}/evaluate`, { authorization: REL01D_AUTH.reviewer, body: {} })).body['status'], 'completed');
    const mixedDraft = await call(baseUrl, 'POST', `/api/assurance/assessments/${mixed}/commercial-report/draft`, { authorization: REL01D_AUTH.approver, body: draftBody() });
    const mixedDigest = (mixedDraft.body['manifest'] as Record<string, unknown>)['contentDigest'] as string;
    const refused = await call(baseUrl, 'POST', `/api/assurance/assessments/${mixed}/commercial-report/release`, { authorization: REL01D_AUTH.dual, body: releaseBody(mixedDigest) });
    assert.equal(refused.status, 403);
    assert.ok(isReason(refused, 'separation_of_duties'));
  });

  it('O08 tenant boundary: another organization’s assessment, release and package are indistinguishable from absent ones', async () => {
    const id = foreign.assessmentId;
    for (const [method, path, authorization, body] of [
      ['GET', `/api/assurance/assessments/${id}`, REL01D_AUTH.reviewer, undefined],
      ['POST', `/api/assurance/assessments/${id}/evidence`, REL01D_AUTH.reviewer, { manualEvidence: hostEvidence() }],
      ['POST', `/api/assurance/assessments/${id}/terminate`, REL01D_AUTH.reviewer, { reasonCode: 'engagement_withdrawn', rationale: 'cross-tenant probe' }],
      ['POST', `/api/assurance/assessments/${id}/commercial-report/draft`, REL01D_AUTH.reviewer, draftBody()],
      ['POST', `/api/assurance/assessments/${id}/commercial-report/release`, REL01D_AUTH.approver, releaseBody('sha256:any')],
      ['GET', `/api/assurance/assessments/${id}/commercial-releases`, REL01D_AUTH.reviewer, undefined],
    ] as const) {
      const reply = await call(baseUrl, method, path, { authorization, ...(body !== undefined ? { body } : {}) });
      assert.equal(reply.status, 404, `${method} ${path}: ${reply.text.slice(0, 200)}`);
      assert.equal(reply.text.includes(PILOT_ORG), false, 'the foreign organization is never named');
    }
    const foreignRelease = await call(baseUrl, 'GET', `/api/assurance/commercial-releases/${foreign.reportId}`, { authorization: REL01D_AUTH.reviewer });
    const absentRelease = await call(baseUrl, 'GET', '/api/assurance/commercial-releases/no-such-report', { authorization: REL01D_AUTH.reviewer });
    assert.equal(foreignRelease.status, 404);
    assert.equal(errorCode(foreignRelease), 'ASSURANCE_RELEASE_NOT_FOUND');
    assert.equal(errorCode(absentRelease), errorCode(foreignRelease));
    const foreignPackage = await call(baseUrl, 'POST', '/api/assurance/commercial-releases/verify', { authorization: REL01D_AUTH.reviewer, body: foreign.delivered });
    assert.equal(foreignPackage.status, 200);
    assert.equal(foreignPackage.body['authority'], 'RELEASE_NOT_IN_CUSTODY');
    assert.equal(foreignPackage.body['releaseAuthenticated'], false);
    const otherOrg = await call(baseUrl, 'POST', '/api/assurance/assessments', {
      authorization: REL01D_AUTH.reviewer,
      body: { subject: { subjectType: 'system', subjectId: 's', organizationId: PILOT_ORG }, frameworkId: 'rn.sv', frameworkVersion: '0.1.0' },
    });
    assert.equal(otherOrg.status, 403, 'a reviewer cannot open an assessment for another organization');
    // Cross-tenant evidence offered to the Host's own assessment is rejected per reference by the SEC-01D resolver.
    const created = await createRnSvAssessment(baseUrl, REL01D_AUTH.reviewer);
    const collected = await call(baseUrl, 'POST', `/api/assurance/assessments/${created.body['assessmentId'] as string}/evidence`, { authorization: REL01D_AUTH.reviewer, body: { manualEvidence: hostEvidence() } });
    assert.equal(collected.status, 200);
    const accepted = ((collected.body['evidenceReferences'] as Record<string, unknown>[]) ?? []).filter((reference) => reference['organizationId'] === PILOT_ORG);
    const rejectedForeign = JSON.stringify(collected.body['evidenceResolutions']).includes('EVIDENCE_WRONG_TENANT');
    assert.ok(accepted.length === 0 || rejectedForeign, 'a foreign artifact is never accepted as this organization’s evidence');
  });

  it('O09 termination over HTTP: authenticated and attributed, idempotent, a different end refused, and nothing writes after it', async () => {
    const created = await createRnSvAssessment(baseUrl, REL01D_AUTH.reviewer);
    const assessmentId = created.body['assessmentId'] as string;
    assert.equal((await call(baseUrl, 'POST', `/api/assurance/assessments/${assessmentId}/evidence`, { authorization: REL01D_AUTH.reviewer, body: { manualEvidence: hostEvidence() } })).status, 200);
    const end = { reasonCode: 'engagement_withdrawn', rationale: 'The synthetic engagement was withdrawn.' };
    const path = `/api/assurance/assessments/${assessmentId}/terminate`;
    const ended = await call(baseUrl, 'POST', path, { authorization: REL01D_AUTH.reviewer, body: end });
    assert.equal(ended.status, 200, ended.text.slice(0, 300));
    assert.equal(ended.body['outcome'], 'terminated');
    const termination = (ended.body['assessment'] as Record<string, unknown>)['termination'] as Record<string, unknown>;
    assert.equal(termination['terminatedBy'], REL01D_IDS.reviewer);
    assert.equal(termination['outcome'], 'inconclusive');
    const replayed = await call(baseUrl, 'POST', path, { authorization: REL01D_AUTH.reviewer, body: end });
    assert.equal(replayed.body['outcome'], 'replayed');
    const different = await call(baseUrl, 'POST', path, { authorization: REL01D_AUTH.reviewer2, body: end });
    assert.equal(different.status, 409);
    assert.equal((await call(baseUrl, 'POST', `/api/assurance/assessments/${assessmentId}/evidence`, { authorization: REL01D_AUTH.reviewer, body: { manualEvidence: hostEvidence() } })).status, 409);
    // An inconclusive attempt concludes nothing (REL-01B B21): no commercial draft, no release.
    const draft = await call(baseUrl, 'POST', `/api/assurance/assessments/${assessmentId}/commercial-report/draft`, { authorization: REL01D_AUTH.reviewer, body: draftBody() });
    assert.equal(draft.status, 409, draft.text.slice(0, 200));
    assert.equal(errorCode(draft), 'ASSURANCE_ASSESSMENT_INCOMPLETE');
  });

  it('O10 two concurrent evidence writers over HTTP: one is stored, the other is refused (409), never merged or overwritten', async () => {
    const created = await createRnSvAssessment(baseUrl, REL01D_AUTH.reviewer);
    const assessmentId = created.body['assessmentId'] as string;
    const path = `/api/assurance/assessments/${assessmentId}/evidence`;
    const setA = hostEvidence();
    const setB = hostEvidence().slice(0, 4).map((reference) => ({ ...reference, evidenceReferenceId: `${reference.evidenceReferenceId}-b`, digest: `sha256:${'b'.repeat(64)}` }));
    const [a, b] = await Promise.all([
      call(baseUrl, 'POST', path, { authorization: REL01D_AUTH.reviewer, body: { manualEvidence: setA } }),
      call(baseUrl, 'POST', path, { authorization: REL01D_AUTH.reviewer2, body: { manualEvidence: setB } }),
    ]);
    const statuses = [a.status, b.status].sort();
    assert.deepEqual(statuses, [200, 409], `${a.text.slice(0, 200)} | ${b.text.slice(0, 200)}`);
    const loser = a.status === 409 ? a : b;
    assert.ok(['ASSURANCE_ASSESSMENT_CONFLICT', 'ASSURANCE_ASSESSMENT_IMMUTABLE'].includes(String(errorCode(loser))), loser.text.slice(0, 200));
    const winner = a.status === 200 ? a : b;
    const stored = await call(baseUrl, 'GET', `/api/assurance/assessments/${assessmentId}`, { authorization: REL01D_AUTH.reviewer });
    assert.deepEqual(stored.body['evidenceReferences'], winner.body['evidenceReferences']);
  });

  it('O11 no token, secret, rationale, evidence content or store internal reaches a log line or an error body; every operator action is audited by id', () => {
    const logs = logLines.join('\n');
    for (const secret of ALL_SECRETS) assert.equal(logs.includes(secret), false, 'no secret in logs');
    for (const planted of ['PilotSynthetic123', 'REL01D-RATIONALE-NEVER-LOGGED', 'internal.pilot-coop.invalid', 'contributor note']) assert.equal(logs.includes(planted), false, `${planted} is not logged`);
    const errors = responses.filter((text) => text.includes('"error"')).join('\n');
    for (const internal of ['SQLITE', 'better-sqlite3', booted.dir, '.sqlite', 'at Object.', 'node:internal']) assert.equal(errors.includes(internal), false, `${internal} is not in an error body`);
    for (const secret of ALL_SECRETS) assert.equal(errors.includes(secret), false);
    const audits = logLines.map((line) => JSON.parse(line) as { message: string; fields?: Record<string, unknown> }).filter((line) => line.message === 'enterprise.assurance.operator');
    const operations = new Set(audits.map((line) => `${String(line.fields?.['operation'])}:${String(line.fields?.['operatorId'])}`));
    for (const expected of [`assurance.release:${REL01D_IDS.approver}`, `assurance.evidence:${REL01D_IDS.reviewer}`, `assurance.terminate:${REL01D_IDS.reviewer}`, `assurance.verify:${REL01D_IDS.reviewer}`, `assurance.create:${REL01D_IDS.reviewer}`]) {
      assert.ok(operations.has(expected), `${expected} audited`);
    }
    assert.ok(audits.some((line) => line.fields?.['operation'] === 'assurance.release' && line.fields?.['errorCode'] === 'ASSURANCE_REVIEWER_UNAUTHORIZED'), 'a refused release is audited too');
  });
});

describe('ASSURE-REL-01D Host configuration -- opt-in framework, reviewer-only mode, durable custody', () => {
  it('O12 rn.sv@0.1.0 exists on a Host only when opted in; an unknown framework is refused at boot', async () => {
    const dir = workspace.dir();
    const plain = await bootRel01d(workspace, dir, rel01dEnv(dir, { frameworks: undefined }));
    const refused = await createRnSvAssessment(plain.baseUrl, REL01D_AUTH.reviewer);
    assert.equal(refused.status, 404, refused.text.slice(0, 200));
    assert.equal(errorCode(refused), 'ASSURANCE_FRAMEWORK_NOT_FOUND');
    await plain.host.close();
    const badDir = workspace.dir();
    await assert.rejects(
      async () => bootEnterpriseHost({ env: await withDeploymentWitness(rel01dEnv(badDir, { frameworks: 'rn.sv@0.2.0' })), logger: capturingLogger }),
      (error: unknown) => error instanceof EnterpriseHostConfigurationError,
    );
  });

  it('O13 reviewer-only mode: every Assurance write needs a reviewer credential; reads and the manual-review route are unchanged', async () => {
    const dir = workspace.dir();
    const { baseUrl } = await bootRel01d(workspace, dir, rel01dEnv(dir, { reviewerOnly: true }));
    const created = await createRnSvAssessment(baseUrl, REL01D_AUTH.reviewer);
    assert.equal(created.status, 201);
    const assessmentId = created.body['assessmentId'] as string;
    for (const [path, body] of [
      ['/api/assurance/assessments', { subject: { subjectType: 'system', subjectId: 's', organizationId: ORG }, frameworkId: 'rn.sv', frameworkVersion: '0.1.0', requestedBy: 'v1-caller' }],
      [`/api/assurance/assessments/${assessmentId}/evaluate`, {}],
      ['/api/assurance/signals', { organizationId: ORG, subjectId: 's', subjectType: 'system', signalType: 'policy_changed', sourceType: 'governance_record', sourceId: 'x', occurredAt: '2026-10-01T00:00:00.000Z' }],
      ['/api/assurance/subjects/s/reassess', { reason: 'r', requestedBy: 'v1-caller' }],
      ['/api/assurance/findings/f/events', { eventType: 'AssuranceFindingAccepted', actorId: 'v1-caller' }],
    ] as const) {
      const reply = await call(baseUrl, 'POST', path, { authorization: REL01D_AUTH.organizationKey, body });
      assert.equal(reply.status, 401, `${path}: ${reply.text.slice(0, 200)}`);
    }
    assert.equal((await call(baseUrl, 'GET', `/api/assurance/assessments/${assessmentId}`, { authorization: REL01D_AUTH.organizationKey })).status, 200, 'an organization key still reads');
    assert.equal((await call(baseUrl, 'GET', `/api/assurance/assessments/${assessmentId}`, { authorization: REL01D_AUTH.reviewer })).body['status'], 'created', 'no refused write changed it');
  });

  it('O14 a Host whose Assurance Store keeps no durable custody refuses to release (503) and keeps nothing', async () => {
    const dir = workspace.dir();
    const env = { ...rel01dEnv(dir), AOC_ENTERPRISE_ENV: 'development', AOC_ENTERPRISE_PERSISTENCE_PROVIDER: 'memory' };
    const { baseUrl } = await bootRel01d(workspace, dir, env);
    const assessmentId = await completedAssessmentOverHttp(baseUrl, REL01D_AUTH.reviewer);
    const draft = await call(baseUrl, 'POST', `/api/assurance/assessments/${assessmentId}/commercial-report/draft`, { authorization: REL01D_AUTH.reviewer, body: draftBody() });
    assert.equal(draft.status, 200, 'drafting works on any store');
    const digest = (draft.body['manifest'] as Record<string, unknown>)['contentDigest'] as string;
    const refused = await call(baseUrl, 'POST', `/api/assurance/assessments/${assessmentId}/commercial-report/release`, { authorization: REL01D_AUTH.approver, body: releaseBody(digest) });
    assert.equal(refused.status, 503, refused.text.slice(0, 300));
    assert.equal(errorCode(refused), 'ASSURANCE_STORE_UNAVAILABLE');
    const listed = await call(baseUrl, 'GET', `/api/assurance/assessments/${assessmentId}/commercial-releases`, { authorization: REL01D_AUTH.reviewer });
    if (listed.status === 200) assert.deepEqual(listed.body['releases'], [], 'nothing was kept');
    else assert.equal(listed.status, 503);
  });
});
