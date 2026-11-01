import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { CommercialReportDraft, CommercialReportRelease } from '../assurance/commercial-report.js';
import { call, createWorkspace, errorCode, logLines, type Reply } from './ctrl02-host-fixture.js';
import { writePilotPackage } from './assure-pilot-01-scenario.js';
import {
  ALL_SECRETS,
  REL01D_AUTH,
  REL01D_IDS,
  bootRel01d,
  createRnSvAssessment,
  draftBody,
  hostEvidence,
  rel01dEnv,
  releaseBody,
  reviewAllOverHttp,
  snapshotSqlite,
} from './assure-rel-01d-host-fixture.js';

/**
 * ASSURE-REL-01D Stage 5 -- the synthetic Founding Assessment flow, end to end,
 * against the real Enterprise Host listening on loopback, through HTTP only:
 * reviewer-only mode, rn.sv@0.1.0 opted in, a reviewer who assesses and a
 * distinct approver who releases into durable SQLite custody, a Host restart,
 * and the independent package verifier. Synthetic data only; nothing here is
 * a commercial authorization (rn.sv@0.1.0 stays `commercialUse: restricted`).
 */

const workspace = createWorkspace('frontera-rel01d-pilot-');
after(() => workspace.close());

const VERIFIER = join(process.cwd(), 'scripts', 'assurance', 'verify-commercial-package.mjs');
const RENDERER = join(process.cwd(), 'dist', 'src', 'enterprise', 'assurance', 'commercial-report-markdown.js');

function independentVerifier(dir: string, storeCopy: string): { readonly exit: number | null; readonly verdict: string; readonly externalAuthenticity: string } {
  const run = spawnSync(process.execPath, [VERIFIER, dir, '--store-copy', storeCopy, '--renderer', RENDERER], { encoding: 'utf8', timeout: 60_000, env: {} });
  let output: Record<string, unknown> = {};
  try {
    output = JSON.parse(run.stdout) as Record<string, unknown>;
  } catch {
    output = { verdict: `unparseable output (exit ${String(run.status)}): ${run.stderr.slice(0, 300)}` };
  }
  return { exit: run.status, verdict: String(output['verdict']), externalAuthenticity: String((output['externalAuthenticity'] as { status?: unknown } | undefined)?.status) };
}

function expect(reply: Reply, status: number, where: string): Reply {
  assert.equal(reply.status, status, `${where}: ${reply.text.slice(0, 500)}`);
  return reply;
}

describe('ASSURE-REL-01D Stage 5 -- synthetic Founding Assessment through the real Host', () => {
  it('P01 create, evidence, reviews, completion, draft, distinct approval into durable custody, retrieval, verification, restart, independent verification', async () => {
    const dir = workspace.dir();
    const env = rel01dEnv(dir, { reviewerOnly: true });
    // 1-2. Boot the Host: rn.sv@0.1.0 registered, reviewer-only mode.
    const first = await bootRel01d(workspace, dir, env);
    const base = first.baseUrl;
    const health = await call(base, 'GET', '/ready');
    expect(health, 200, 'the Host is ready');

    // Rejections on the way in: no credential, an organization key, a wrong role.
    expect(await createRnSvAssessment(base, REL01D_AUTH.organizationKey, { requestedBy: 'v1' }), 401, 'reviewer-only: an organization key cannot create');
    expect(await createRnSvAssessment(base, REL01D_AUTH.approver), 403, 'an approver cannot create');

    // 3-4. The reviewer creates the synthetic assessment (the actor is the credential).
    const created = expect(await createRnSvAssessment(base, REL01D_AUTH.reviewer), 201, 'create');
    const assessmentId = created.body['assessmentId'] as string;
    assert.equal((created.body['provenance'] as Record<string, unknown>)['requestedBy'], REL01D_IDS.reviewer);

    // 5. Synthetic evidence, under the SEC-01C trust model.
    const collected = expect(await call(base, 'POST', `/api/assurance/assessments/${assessmentId}/evidence`, { authorization: REL01D_AUTH.reviewer, body: { manualEvidence: hostEvidence() } }), 200, 'evidence');
    const references = collected.body['evidenceReferences'] as Record<string, unknown>[];
    assert.ok(references.length > 0);
    assert.ok(references.every((reference) => reference['verified'] === false), 'manually supplied evidence is never recorded as verified');
    expect(await call(base, 'POST', `/api/assurance/assessments/${assessmentId}/evidence`, { authorization: REL01D_AUTH.reviewer2, body: { manualEvidence: hostEvidence() } }), 409, 'a second, stale evidence write');

    // 6-7. Evaluate (pending reviews), the reviewer's ten authenticated reviews, then evaluate and complete.
    expect(await call(base, 'POST', `/api/assurance/assessments/${assessmentId}/evaluate`, { authorization: REL01D_AUTH.reviewer, body: { complete: false } }), 200, 'evaluate');
    for (const review of await reviewAllOverHttp(base, REL01D_AUTH.reviewer, assessmentId)) expect(review, 201, 'manual review');
    const completed = expect(await call(base, 'POST', `/api/assurance/assessments/${assessmentId}/evaluate`, { authorization: REL01D_AUTH.reviewer, body: {} }), 200, 'complete');
    assert.equal(completed.body['status'], 'completed');
    expect(await call(base, 'POST', `/api/assurance/assessments/${assessmentId}/verify`, { authorization: REL01D_AUTH.approver }), 200, 'the stored assessment verifies');

    // 8-9. The distinct approver drafts, inspects and approves the exact digest.
    const draft = expect(await call(base, 'POST', `/api/assurance/assessments/${assessmentId}/commercial-report/draft`, { authorization: REL01D_AUTH.approver, body: draftBody() }), 200, 'draft');
    const content = draft.body['content'] as Record<string, unknown>;
    assert.equal((content['readiness'] as Record<string, unknown>)['status'], 'READY_FOR_RELEASE');
    assert.equal(JSON.stringify(content).includes('restricted'), true, 'the commercial-use restriction is carried in the report');
    const digest = (draft.body['manifest'] as Record<string, unknown>)['contentDigest'] as string;
    const releasePath = `/api/assurance/assessments/${assessmentId}/commercial-report/release`;
    expect(await call(base, 'POST', releasePath, { authorization: REL01D_AUTH.reviewer, body: releaseBody(digest) }), 403, 'the substantive reviewer holds no release role');
    expect(await call(base, 'POST', releasePath, { authorization: REL01D_AUTH.organizationKey, body: releaseBody(digest) }), 401, 'an organization key cannot release');
    expect(await call(base, 'POST', releasePath, { authorization: REL01D_AUTH.approver, body: releaseBody(digest, { approvedBy: REL01D_IDS.reviewer }) }), 403, 'a declared approver is never the approver');

    // 10. Commit to durable SQLite custody.
    const committed = expect(await call(base, 'POST', releasePath, { authorization: REL01D_AUTH.approver, body: releaseBody(digest) }), 201, 'release');
    const release = committed.body['release'] as CommercialReportRelease;
    assert.equal(release.approvedBy, REL01D_IDS.approver);
    assert.notEqual(release.approvedBy, (created.body['provenance'] as Record<string, unknown>)['requestedBy'], 'approver and assessor are distinct credentials');
    expect(await call(base, 'POST', releasePath, { authorization: REL01D_AUTH.approver2, body: releaseBody(digest) }), 409, 'a second approval of the same report version');

    // 11. Retrieve the release over HTTP.
    const reportId = content['reportId'] as string;
    const kept = expect(await call(base, 'GET', `/api/assurance/commercial-releases/${reportId}`, { authorization: REL01D_AUTH.reviewer }), 200, 'retrieve');
    assert.deepEqual(kept.body['release'], release);

    // 12. Verify the delivered package against the Host.
    const delivered = { content, markdown: draft.body['markdown'], manifest: draft.body['manifest'], release };
    const verified = expect(await call(base, 'POST', '/api/assurance/commercial-releases/verify', { authorization: REL01D_AUTH.approver, body: delivered }), 200, 'verify');
    assert.equal(verified.body['authority'], 'RELEASE_MATCHES_AUTHORITY');
    assert.equal(verified.body['releaseAuthenticated'], true);
    assert.equal(verified.body['externalSignature'], 'EXTERNAL_SIGNATURE_NOT_AVAILABLE');
    const tamperedCheck = expect(await call(base, 'POST', '/api/assurance/commercial-releases/verify', { authorization: REL01D_AUTH.approver, body: { ...delivered, markdown: `${String(delivered.markdown)}\nAltered after release.` } }), 200, 'verify tampered');
    assert.equal(tamperedCheck.body['releaseAuthenticated'], false);
    const assessmentBefore = expect(await call(base, 'GET', `/api/assurance/assessments/${assessmentId}`, { authorization: REL01D_AUTH.reviewer }), 200, 'read before restart');

    // 13. Restart the Host on the same data directory.
    await first.host.close();
    const second = await bootRel01d(workspace, dir, env);
    const restarted = second.baseUrl;

    // 14. The release still exists and matches; the replay answers with the original.
    const afterRestart = expect(await call(restarted, 'GET', `/api/assurance/commercial-releases/${reportId}`, { authorization: REL01D_AUTH.approver }), 200, 'retrieve after restart');
    assert.deepEqual(afterRestart.body, kept.body);
    assert.deepEqual(expect(await call(restarted, 'GET', `/api/assurance/assessments/${assessmentId}`, { authorization: REL01D_AUTH.reviewer }), 200, 'read after restart').body, assessmentBefore.body);
    const reverified = expect(await call(restarted, 'POST', '/api/assurance/commercial-releases/verify', { authorization: REL01D_AUTH.reviewer, body: delivered }), 200, 'verify after restart');
    assert.equal(reverified.body['authority'], 'RELEASE_MATCHES_AUTHORITY');
    const replay = expect(await call(restarted, 'POST', releasePath, { authorization: REL01D_AUTH.approver, body: releaseBody(digest) }), 200, 'replay after restart');
    assert.deepEqual(replay.body['release'], release);
    expect(await call(restarted, 'POST', releasePath, { authorization: REL01D_AUTH.approver2, body: releaseBody(digest) }), 409, 'conflict after restart');
    expect(await call(restarted, 'POST', `/api/assurance/assessments/${assessmentId}/evidence`, { authorization: REL01D_AUTH.reviewer, body: { manualEvidence: hostEvidence() } }), 409, 'a completed assessment takes no evidence');

    // 15. The independent verifier, against the delivered files and a consistent copy of the Host's store.
    const packageDir = join(dir, 'delivered-package');
    writePilotPackage(packageDir, { content, markdown: draft.body['markdown'], manifest: draft.body['manifest'] } as unknown as CommercialReportDraft, release);
    await second.host.close();
    const storeCopy = join(dir, 'assurance-copy.sqlite');
    await snapshotSqlite(second.assurancePath, storeCopy);
    const independent = independentVerifier(packageDir, storeCopy);
    assert.equal(independent.exit, 0, independent.verdict);
    assert.match(independent.verdict, /^PASS \(files, artifactIntegrity, reportConsistency, approvalConsistency, assessmentConsistency, releaseCustody\); external authenticity NOT DEMONSTRATED$/);
    assert.equal(independent.externalAuthenticity, 'NOT_DEMONSTRATED');

    const altered = join(dir, 'altered-package');
    cpSync(packageDir, altered, { recursive: true });
    writeFileSync(join(altered, 'report.md'), `${readFileSync(join(altered, 'report.md'), 'utf8')}\nA sentence added after release.\n`);
    assert.equal(independentVerifier(altered, storeCopy).exit, 1, 'the verifier refuses an altered package');

    // Nothing secret or evidentiary was logged on the way.
    const logs = logLines.join('\n');
    for (const secret of ALL_SECRETS) assert.equal(logs.includes(secret), false);
    assert.equal(logs.includes('PilotSynthetic123'), false);
    assert.equal(errorCode(replay), undefined);
  });
});
