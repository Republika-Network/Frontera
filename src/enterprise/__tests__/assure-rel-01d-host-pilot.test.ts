import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import Database from 'better-sqlite3';

import type { CommercialReportRelease } from '../assurance/commercial-report.js';
import { COMMERCIAL_RELEASE_PACKAGE_FILES } from '../assurance/commercial-release-package.js';
import { call, createWorkspace, errorCode, logLines, type Reply } from './ctrl02-host-fixture.js';
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
const MATERIALIZER = join(process.cwd(), 'scripts', 'assurance', 'materialize-commercial-package.mjs');

/** ASSURE-OPS-01: writes an export body to disk and materialises it with the operator CLI, as an operator would. */
function materialize(exportBody: unknown, dir: string): { readonly exit: number | null; readonly stdout: string } {
  mkdirSync(dir, { recursive: true });
  const exportFile = join(dir, 'export.json');
  writeFileSync(exportFile, JSON.stringify(exportBody));
  const run = spawnSync(process.execPath, [MATERIALIZER, exportFile, '--out', join(dir, 'founding-assessment')], { encoding: 'utf8', timeout: 60_000, env: {} });
  return { exit: run.status, stdout: run.stdout };
}

async function rawGet(baseUrl: string, path: string, authorization?: string): Promise<{ readonly status: number; readonly cacheControl: string | null; readonly text: string }> {
  const response = await fetch(`${baseUrl}${path}`, { headers: authorization !== undefined ? { authorization } : {} });
  return { status: response.status, cacheControl: response.headers.get('cache-control'), text: await response.text() };
}

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
    // ASSURE-OPS-01 (R-02): the completed assessment takes no further review over HTTP.
    const late = expect(await call(base, 'POST', '/api/assurance/manual-reviews', { authorization: REL01D_AUTH.reviewer, body: { assessmentId, controlId: 'SV-10', outcome: 'insufficient_evidence', rationale: 'late' } }), 409, 'a review after completion');
    assert.equal(errorCode(late), 'ASSURANCE_ASSESSMENT_IMMUTABLE');

    // ASSURE-OPS-01 (R-05): export the delivery package from custody over HTTP.
    const packagePath = `/api/assurance/commercial-releases/${reportId}/package`;
    const exportedRaw = await rawGet(base, packagePath, REL01D_AUTH.approver);
    assert.equal(exportedRaw.status, 200, exportedRaw.text.slice(0, 300));
    assert.equal(exportedRaw.cacheControl, 'no-store', 'R05-15: a package is never cached');
    const exported = JSON.parse(exportedRaw.text) as { files: { path: string; contentBase64: string }[]; packageDigest: string; externalSignature: string; authority: Record<string, unknown> };
    assert.deepEqual(exported.files.map((file) => file.path), [...COMMERCIAL_RELEASE_PACKAGE_FILES]);
    assert.equal(exported.externalSignature, 'EXTERNAL_SIGNATURE_NOT_AVAILABLE');
    assert.equal(exported.authority['approvedBy'], REL01D_IDS.approver);
    assert.equal(Buffer.from(exported.files.find((file) => file.path === 'report.md')?.contentBase64 ?? '', 'base64').toString('utf8'), draft.body['markdown'], 'the approved Markdown, exactly');
    expect(await call(base, 'GET', packagePath, { authorization: REL01D_AUTH.reviewer }), 200, 'the assessing reviewer may export too');
    expect(await call(base, 'GET', packagePath), 401, 'unauthenticated export');
    expect(await call(base, 'GET', packagePath, { authorization: REL01D_AUTH.organizationKey }), 401, 'an organization key is not an operator');
    expect(await call(base, 'GET', packagePath, { authorization: REL01D_AUTH.operator }), 401, 'a CTRL-02 administrator is not an operator');
    expect(await call(base, 'GET', packagePath, { authorization: REL01D_AUTH.unknown }), 401, 'an unknown credential');
    const unknownExport = await rawGet(base, '/api/assurance/commercial-releases/rn-sv-report%3Ano-such%3Av1/package', REL01D_AUTH.approver);
    assert.equal(unknownExport.status, 404);
    assert.match(unknownExport.text, /ASSURANCE_RELEASE_NOT_FOUND/);
    assert.equal(unknownExport.cacheControl, 'no-store');

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

    // ASSURE-OPS-01 (R-05): export again after the restart -- the same bytes -- and materialise it with the operator CLI.
    const reexported = expect(await call(restarted, 'GET', packagePath, { authorization: REL01D_AUTH.approver }), 200, 'export after restart');
    assert.deepEqual(reexported.body['files'], exported.files, 'byte-identical after restart');
    assert.equal(reexported.body['packageDigest'], exported.packageDigest);
    const deliveryDir = join(dir, 'delivery');
    const materialized = materialize(reexported.body, deliveryDir);
    assert.equal(materialized.exit, 0, materialized.stdout);

    // 15. The independent verifier, against the exported files and a consistent copy of the Host's store.
    const packageDir = join(deliveryDir, 'founding-assessment');
    assert.deepEqual(readdirSync(packageDir).sort(), [...COMMERCIAL_RELEASE_PACKAGE_FILES]);
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

    // ASSURE-OPS-01: a custody row altered on disk is never exported -- the Host answers an integrity failure and no report content.
    const raw = new Database(second.assurancePath);
    try {
      const trigger = raw.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'assurance_commercial_releases_no_update'").get() as { sql: string };
      const row = raw.prepare('SELECT record_json FROM assurance_commercial_releases WHERE report_id = ?').get(reportId) as { record_json: string };
      const kept = JSON.parse(row.record_json) as { artifacts: { markdown: string } };
      raw.exec('DROP TRIGGER assurance_commercial_releases_no_update');
      raw.prepare('UPDATE assurance_commercial_releases SET record_json = ? WHERE report_id = ?').run(JSON.stringify({ ...kept, artifacts: { ...kept.artifacts, markdown: `${kept.artifacts.markdown}\nAltered on disk.\n` } }), reportId);
      raw.exec(trigger.sql);
    } finally {
      raw.close();
    }
    const third = await bootRel01d(workspace, dir, env);
    const refusedExport = await rawGet(third.baseUrl, packagePath, REL01D_AUTH.approver);
    assert.equal(refusedExport.status, 500, refusedExport.text.slice(0, 300));
    assert.match(refusedExport.text, /ASSURANCE_INTEGRITY_FAILED/);
    assert.equal(refusedExport.cacheControl, 'no-store');
    assert.equal(refusedExport.text.includes('Altered on disk'), false, 'no report content in the refusal');
    assert.equal(refusedExport.text.includes('contentBase64'), false);
    await third.host.close();

    // Nothing secret or evidentiary was logged on the way.
    const logs = logLines.join('\n');
    for (const secret of ALL_SECRETS) assert.equal(logs.includes(secret), false);
    assert.equal(logs.includes('PilotSynthetic123'), false);
    assert.equal(errorCode(replay), undefined);
  });
});
