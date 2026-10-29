import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { AssuranceError } from '../assurance/errors.js';
import { computeDigest } from '../governance-store/digest.js';
import { renderCommercialReportMarkdown } from '../assurance/commercial-report-markdown.js';
import { COMMERCIAL_REPORT_GENERATOR_V1, COMMERCIAL_REPORT_GENERATOR_V2, RELEASE_STATEMENT_V1, RELEASE_STATEMENT_V2 } from '../assurance/commercial-report-format.js';
import {
  COMMERCIAL_REPORT_RELEASE_ROLE,
  buildCommercialReportRelease,
  verifyCommercialReport,
  type CommercialReportDraft,
  type CommercialReportManifest,
  type CommercialReportRelease,
} from '../assurance/commercial-report.js';
import { buildCommercialReleaseCustodyRecord, type CommercialReleasePackage } from '../assurance/commercial-release-custody.js';
import { RN_SV_FRAMEWORK_V0_1 } from '../assurance/frameworks/rn-sv-framework.js';
import { AOC_SAF_FRAMEWORK_ID, AOC_SAF_FRAMEWORK_V1, AOC_SAF_FRAMEWORK_VERSION } from '../assurance/saf-framework.js';
import {
  PILOT_ACKNOWLEDGEMENTS,
  PILOT_CUTOFF,
  PILOT_ENGAGEMENT,
  PILOT_ISSUE,
  PILOT_ORG,
  PILOT_ORG_CONTEXT,
  PILOT_OTHER_ORG_CONTEXT,
  buildPilotWorld,
  pilotContext,
  preparePilotAssessment,
  releasePilotReport,
  reviewPilotAssessment,
  runPilotHappyPath,
  writePilotPackage,
  type PilotWorld,
} from './assure-pilot-01-scenario.js';

/**
 * ASSURE-REL-01C -- a released report no longer contradicts its release
 * (ASSURE-PILOT-01, F03).
 *
 * The report is frozen at approval, so it cannot be told afterwards that it
 * was released. From generator v2 it states no release status of its own;
 * release is established by the release record and the Host's custody (REL-01A).
 * v1 reports, whose text says "not yet released", stay valid and unedited.
 * See docs/security/ASSURE-REL-01C-RELEASED-REPORT-CONSISTENCY.md.
 */

const VERIFIER = join(process.cwd(), 'scripts', 'assurance', 'verify-commercial-package.mjs');
const HISTORICAL = join(process.cwd(), 'docs', 'enterprise', 'examples', 'historical');
const tempDirs: string[] = [];
const worlds: PilotWorld[] = [];
after(async () => {
  for (const world of worlds) await world.store.close().catch(() => {});
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'assure-rel-01c-'));
  tempDirs.push(dir);
  return dir;
};
async function open(dbPath: string, options: Parameters<typeof buildPilotWorld>[1] = {}): Promise<PilotWorld> {
  const world = await buildPilotWorld(dbPath, options);
  worlds.push(world);
  return world;
}
const isCode = (code: string, conflict?: string) => (error: unknown) => error instanceof AssuranceError && error.code === code && (conflict === undefined || error.details?.['conflict'] === conflict);
const sha256 = (text: string): string => `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
const packageOf = (draft: CommercialReportDraft, release?: CommercialReportRelease): CommercialReleasePackage => ({ content: draft.content, markdown: draft.markdown, manifest: draft.manifest, ...(release !== undefined ? { release } : {}) });
/** Any statement a report could make about its own release status. */
const RELEASE_STATUS_CLAIM = /not yet released|Not released by this document|has been released|\breleased on\b|\bRELEASED\b/;

/** A completed pilot assessment and its READY draft, nothing released. */
async function ready(): Promise<{ readonly world: PilotWorld; readonly dbPath: string; readonly assessmentId: string; readonly draft: CommercialReportDraft }> {
  const dbPath = join(tempDir(), 'assurance.db');
  const world = await open(dbPath);
  const prepared = await preparePilotAssessment(world);
  await reviewPilotAssessment(world, prepared.assessmentId);
  await world.service.completeAssessment(PILOT_ORG_CONTEXT, prepared.assessmentId);
  const draft = await world.service.buildCommercialReportDraft(PILOT_ORG_CONTEXT, prepared.assessmentId, { engagement: PILOT_ENGAGEMENT, issue: PILOT_ISSUE });
  return { world, dbPath, assessmentId: prepared.assessmentId, draft };
}

/**
 * The same draft as generator v1 produced it: identical content but for the
 * generator version and the release statement. REP-01 proves that this equals
 * the historical v1 example byte for byte.
 */
function asV1(draft: CommercialReportDraft): CommercialReportDraft {
  const content = { ...draft.content, integrity: { ...draft.content.integrity, generatorVersion: COMMERCIAL_REPORT_GENERATOR_V1, release: RELEASE_STATEMENT_V1 } };
  const markdown = renderCommercialReportMarkdown(content);
  const { manifestDigest: _replaced, ...body } = { ...draft.manifest, generatorVersion: COMMERCIAL_REPORT_GENERATOR_V1, contentDigest: computeDigest(content), markdownDigest: sha256(markdown) };
  const manifest: CommercialReportManifest = { ...body, manifestDigest: computeDigest(body) };
  return { content, markdown, manifest };
}

function runVerifier(dir: string, storeCopy?: string): { readonly exit: number | null; readonly output: Record<string, unknown> } {
  const run = spawnSync(process.execPath, [VERIFIER, dir, ...(storeCopy !== undefined ? ['--store-copy', storeCopy] : [])], { encoding: 'utf8', timeout: 60_000, env: {} });
  return { exit: run.status, output: JSON.parse(run.stdout) as Record<string, unknown> };
}

// ===========================================================================

describe('ASSURE-REL-01C -- preparation, release and authenticity are never confused', () => {
  it('C01/C03/C14 a READY report claims neither release nor its absence as a fact, says where release is established, and is not released without a kept record', async () => {
    const { world, draft } = await ready();
    assert.equal(draft.content.readiness.status, 'READY_FOR_RELEASE');
    assert.equal(draft.manifest.generatorVersion, COMMERCIAL_REPORT_GENERATOR_V2);
    assert.equal(draft.content.integrity.release, RELEASE_STATEMENT_V2);
    assert.equal(RELEASE_STATUS_CLAIM.test(draft.markdown), false, 'no statement a later release could contradict, and none of release');
    assert.match(draft.markdown, /Readiness is not release/);
    assert.match(draft.markdown, /A release is established only by an accompanying release record whose digests match this report’s manifest, confirmed by the issuer’s release custody\. Without one, this report is not released\./);
    assert.equal(await world.service.getCommercialRelease(PILOT_ORG_CONTEXT, draft.content.reportId), null, 'READY is not RELEASED');
    const unkept = buildCommercialReportRelease(draft, { approvedBy: 'pilot-approver', approverRole: COMMERCIAL_REPORT_RELEASE_ROLE, approvedAt: '2026-10-28T09:00:00.000Z', acknowledgements: PILOT_ACKNOWLEDGEMENTS });
    const verdict = await world.service.verifyCommercialRelease(PILOT_ORG_CONTEXT, packageOf(draft, unkept));
    assert.equal(verdict.integrity, 'INTEGRITY_VALID', 'a release record can be internally consistent...');
    assert.equal(verdict.authority, 'RELEASE_NOT_IN_CUSTODY', '...without any release having happened');
    assert.equal(verdict.releaseAuthenticated, false);
  });

  it('C02 a report that fails a release check is visibly a DRAFT and cannot be released', async () => {
    const { world, assessmentId } = await ready();
    const { exclusions: _omitted, ...withoutExclusions } = PILOT_ENGAGEMENT;
    const draft = await world.service.buildCommercialReportDraft(PILOT_ORG_CONTEXT, assessmentId, { engagement: withoutExclusions, issue: PILOT_ISSUE });
    assert.equal(draft.content.readiness.status, 'DRAFT');
    assert.match(draft.markdown, /^# [^\n]*\n\n> \*\*DRAFT — NOT FOR DELIVERY\.\*\*/);
    assert.equal(draft.markdown.includes('READY FOR RELEASE'), false);
    await assert.rejects(world.service.releaseCommercialReport(pilotContext(world, 'approver'), assessmentId, { engagement: withoutExclusions, issue: PILOT_ISSUE, approvedContentDigest: draft.manifest.contentDigest, acknowledgements: PILOT_ACKNOWLEDGEMENTS }), isCode('ASSURANCE_ASSESSMENT_INCOMPLETE'));
  });

  it('C04/C12 a durable release keeps the approved bytes exactly; the package agrees with custody; an idempotent repeat returns the same release and the same bytes', async () => {
    const { world, assessmentId, draft } = await ready();
    const first = await releasePilotReport(world, assessmentId);
    assert.equal(first.custody.outcome, 'committed');
    assert.equal(first.draft.markdown, draft.markdown, 'the release does not change the report');
    assert.deepEqual(first.draft.manifest, draft.manifest);
    assert.equal(first.release.markdownDigest, sha256(draft.markdown));
    const kept = await world.service.getCommercialRelease(PILOT_ORG_CONTEXT, draft.content.reportId);
    assert.equal(kept?.manifest.generatorVersion, COMMERCIAL_REPORT_GENERATOR_V2);
    const verdict = await world.service.verifyCommercialRelease(PILOT_ORG_CONTEXT, packageOf(first.draft, first.release));
    assert.equal(verdict.releaseAuthenticated, true);
    const again = await releasePilotReport(world, assessmentId);
    assert.equal(again.custody.outcome, 'replayed');
    assert.deepEqual(again.release, first.release);
    assert.equal(again.draft.markdown, first.draft.markdown);
  });

  it('C05-C10/C15 a missing, altered or resealed release, a changed report, JSON or manifest, and a release banner added after approval never verify as the kept release', async () => {
    const { world, assessmentId } = await ready();
    const { draft, release } = await releasePilotReport(world, assessmentId);
    const verify = (delivered: CommercialReleasePackage) => world.service.verifyCommercialRelease(PILOT_ORG_CONTEXT, delivered);
    const genuine = packageOf(draft, release);

    const missing = await verify(packageOf(draft));
    assert.equal(missing.releaseAuthenticated, false);
    assert.deepEqual(missing.mismatchedFields, ['release']);
    assert.equal(verifyCommercialReport({ ...genuine, release: { ...release, approvedAt: '2026-10-27T00:00:00.000Z' } }).checks.release, false);
    assert.equal((await verify({ ...genuine, release: { ...release, approvedAt: '2026-10-27T00:00:00.000Z' } })).authority, 'RELEASE_MISMATCH');
    const bannered = draft.markdown.replace('> **READY FOR RELEASE.**', '> **RELEASED.**');
    assert.notEqual(bannered, draft.markdown);
    assert.equal(verifyCommercialReport({ ...genuine, markdown: bannered }).checks.markdown, false, 'a banner added after approval breaks the Markdown digest');
    assert.equal((await verify({ ...genuine, markdown: bannered })).releaseAuthenticated, false);
    assert.equal(verifyCommercialReport({ ...genuine, content: { ...draft.content, reportId: 'x' } }).checks.content, false);
    assert.equal(verifyCommercialReport({ ...genuine, manifest: { ...draft.manifest, readiness: 'DRAFT' } }).checks.manifest, false);

    // The banner, with every digest recomputed: self-consistent, and still not the kept release.
    const { manifestDigest: _old, ...body } = { ...draft.manifest, markdownDigest: sha256(bannered) };
    const manifest = { ...body, manifestDigest: computeDigest(body) };
    const { releaseDigest: _oldRelease, ...releaseBody } = { ...release, markdownDigest: manifest.markdownDigest, manifestDigest: manifest.manifestDigest };
    const resealed: CommercialReleasePackage = { content: draft.content, markdown: bannered, manifest, release: { ...releaseBody, releaseDigest: computeDigest(releaseBody) } };
    assert.equal(verifyCommercialReport(resealed).valid, true, 'integrity alone cannot tell');
    const verdict = await verify(resealed);
    assert.equal(verdict.authority, 'RELEASE_MISMATCH');
    assert.ok(verdict.mismatchedFields.includes('release.markdownDigest') && verdict.mismatchedFields.includes('manifest.markdownDigest'));
  });

  it('C11/C24 without the authority nothing is authenticated; no signature is claimed anywhere', async () => {
    const { world, assessmentId } = await ready();
    const { draft, release } = await releasePilotReport(world, assessmentId);
    assert.equal((await world.service.verifyCommercialRelease(PILOT_ORG_CONTEXT, packageOf(draft, release))).externalSignature, 'EXTERNAL_SIGNATURE_NOT_AVAILABLE');
    assert.match(draft.markdown, /They are not a digital signature/);
    assert.equal(/digitally signed|signed by|signature:/i.test(draft.markdown), false);
    await world.store.close();
    const unavailable = await world.service.verifyCommercialRelease(PILOT_ORG_CONTEXT, packageOf(draft, release));
    assert.equal(unavailable.integrity, 'INTEGRITY_VALID');
    assert.equal(unavailable.authority, 'AUTHORITY_UNAVAILABLE');
    assert.equal(unavailable.releaseAuthenticated, false);
  });

  it('C13 a v1 report released before this change stays valid, unedited and authentic against custody; it is never silently reissued as v2', async () => {
    // The historical example verifies offline, with its v1 wording, and the verifier names the format.
    const historical = join(tempDir(), 'v1-package');
    for (const [from, to] of [['md', 'report.md'], ['json', 'report.json'], ['manifest.json', 'integrity-manifest.json'], ['release.json', 'release-record.json']] as const) {
      cpSync(join(HISTORICAL, `rn-sv-founding-assessment.synthetic.v1.${from}`), join(historical, to));
    }
    const offline = runVerifier(historical);
    assert.equal(offline.exit, 0, String(offline.output['verdict']));
    assert.match(String(offline.output['reportFormat']), /aoc\.assurance\.commercial-report\.v1 \(historical\)/);
    assert.match(readFileSync(join(historical, 'report.md'), 'utf8'), /not yet released/, 'never edited');

    // A v1 release a pre-REL-01C Host kept in custody: still authentic after the upgrade.
    const { world, assessmentId, draft } = await ready();
    const v1 = asV1(draft);
    const v1Release = buildCommercialReportRelease(v1, { approvedBy: 'pilot-approver', approverRole: COMMERCIAL_REPORT_RELEASE_ROLE, approvedAt: '2026-10-28T09:30:00.000Z', acknowledgements: PILOT_ACKNOWLEDGEMENTS });
    const commit = world.store.commitCommercialRelease;
    assert.ok(commit);
    assert.equal((await commit.call(world.store, PILOT_ORG_CONTEXT, buildCommercialReleaseCustodyRecord({ organizationId: PILOT_ORG, manifest: v1.manifest, release: v1Release }))).outcome, 'committed');
    const verdict = await world.service.verifyCommercialRelease(PILOT_ORG_CONTEXT, packageOf(v1, v1Release));
    assert.equal(verdict.releaseAuthenticated, true, 'the v1 release keeps its identity');
    // Approving today's v2 draft under the released version is a different report: refused, never a silent reissue.
    const request = { engagement: PILOT_ENGAGEMENT, issue: PILOT_ISSUE, acknowledgements: PILOT_ACKNOWLEDGEMENTS };
    await assert.rejects(world.service.releaseCommercialReport(pilotContext(world, 'approver'), assessmentId, { ...request, approvedContentDigest: draft.manifest.contentDigest }), isCode('ASSURANCE_ASSESSMENT_IMMUTABLE', 'content'));
    await assert.rejects(world.service.releaseCommercialReport(pilotContext(world, 'approver'), assessmentId, { ...request, approvedContentDigest: v1.manifest.contentDigest }), isCode('ASSURANCE_INTEGRITY_FAILED'), 'the v1 report is not rebuilt; it is read back with getCommercialRelease');
    assert.deepEqual((await world.service.getCommercialRelease(PILOT_ORG_CONTEXT, draft.content.reportId))?.release, v1Release, 'custody is untouched');
  });

  it('C16/C17 another tenant sees no release, and a reviewer without the release role releases nothing', async () => {
    const { world, assessmentId, draft } = await ready();
    const request = { engagement: PILOT_ENGAGEMENT, issue: PILOT_ISSUE, approvedContentDigest: draft.manifest.contentDigest, acknowledgements: PILOT_ACKNOWLEDGEMENTS };
    await assert.rejects(world.service.releaseCommercialReport(pilotContext(world, 'reviewer'), assessmentId, request), isCode('ASSURANCE_REVIEWER_UNAUTHORIZED'));
    await assert.rejects(world.service.releaseCommercialReport(pilotContext(world, 'otherApprover'), assessmentId, request), isCode('ASSURANCE_ASSESSMENT_NOT_FOUND'));
    const { release } = await releasePilotReport(world, assessmentId);
    assert.equal(await world.service.getCommercialRelease(PILOT_OTHER_ORG_CONTEXT, release.reportId), null);
    assert.equal((await world.service.verifyCommercialRelease(PILOT_OTHER_ORG_CONTEXT, packageOf(draft, release))).authority, 'RELEASE_NOT_IN_CUSTODY');
  });

  it('C18/C19/C20 the commercial-use restriction is preserved; aoc.saf still has no commercial report; both golden digests are intact', async () => {
    const { world, draft } = await ready();
    assert.equal(draft.content.integrity.commercialUse.frameworkStatus, 'restricted');
    assert.match(draft.markdown, /\| Framework commercial use \| restricted \|/);
    const saf = await world.service.createAssessment(PILOT_ORG_CONTEXT, { subject: { subjectType: 'agent', subjectId: 'rel01c-agent', organizationId: PILOT_ORG }, frameworkId: AOC_SAF_FRAMEWORK_ID, frameworkVersion: AOC_SAF_FRAMEWORK_VERSION, requestedBy: 'pilot-preparer', evidenceCutoffAt: PILOT_CUTOFF });
    await assert.rejects(world.service.buildCommercialReportDraft(PILOT_ORG_CONTEXT, saf.assessmentId, { engagement: PILOT_ENGAGEMENT, issue: PILOT_ISSUE }), isCode('ASSURANCE_FRAMEWORK_VERSION_UNSUPPORTED'));
    assert.equal(computeDigest(RN_SV_FRAMEWORK_V0_1), 'sha256:e71fafe1a10af95514823e35d43138b1b93cdb72e37765200447a37748c13a58');
    assert.equal(computeDigest(AOC_SAF_FRAMEWORK_V1), 'sha256:4c0b5c65a0b8cfe40de726f26d80b80224fac6ca80fe2c221f7a734548899bb9');
  });

  it('C23 a portability backup and restore keeps the release identity; the package verifies against the restored store and its copy', async () => {
    const portability = (await import(pathToFileURL(join(process.cwd(), 'scripts', 'portability', 'lib-portability.mjs')).href)) as { safeSqliteCopy(source: string, destination: string): Promise<void> };
    const { world, dbPath, assessmentId } = await ready();
    const { draft, release } = await releasePilotReport(world, assessmentId);
    const backup = join(tempDir(), 'assurance.sqlite');
    await portability.safeSqliteCopy(dbPath, backup);
    await world.store.close();
    const restored = await open(backup, { startTick: 1_000_000, startId: 100_000 });
    const kept = await restored.service.getCommercialRelease(PILOT_ORG_CONTEXT, release.reportId);
    assert.deepEqual(kept?.release, release, 'reportId, digests, approver and approval time unchanged');
    assert.equal((await restored.service.verifyCommercialRelease(PILOT_ORG_CONTEXT, packageOf(draft, release))).releaseAuthenticated, true);
    const delivered = join(tempDir(), 'package');
    writePilotPackage(delivered, draft, release);
    const compared = runVerifier(delivered, backup);
    assert.equal(compared.exit, 0, String(compared.output['verdict']));
    assert.match(String(compared.output['reportFormat']), /states no release status of its own/);
  });

  it('the independent verifier refuses an unknown report format, and a v2 report that states a release status of its own, even with every digest recomputed', async () => {
    const { world, assessmentId } = await ready();
    const { draft, release } = await releasePilotReport(world, assessmentId);
    const resealedPackage = (content: CommercialReportDraft['content'], markdown: string): string => {
      const { manifestDigest: _m, ...body } = { ...draft.manifest, generatorVersion: content.integrity.generatorVersion, contentDigest: computeDigest(content), markdownDigest: sha256(markdown) };
      const manifest = { ...body, manifestDigest: computeDigest(body) };
      const { releaseDigest: _r, ...releaseBody } = { ...release, contentDigest: manifest.contentDigest, markdownDigest: manifest.markdownDigest, manifestDigest: manifest.manifestDigest };
      const dir = join(tempDir(), 'package');
      writePilotPackage(dir, { content, markdown, manifest }, { ...releaseBody, releaseDigest: computeDigest(releaseBody) });
      return dir;
    };
    const unknown = { ...draft.content, integrity: { ...draft.content.integrity, generatorVersion: 'aoc.assurance.commercial-report.v9' } };
    const unknownRun = runVerifier(resealedPackage(unknown, renderCommercialReportMarkdown(unknown)));
    assert.equal(unknownRun.exit, 1);
    assert.deepEqual((unknownRun.output['reportConsistency'] as Record<string, { ok: boolean }>)['known report format']?.ok, false);
    const claiming = draft.markdown.replace('Readiness is not release', 'This report is not yet released');
    const claimingRun = runVerifier(resealedPackage(draft.content, claiming));
    assert.equal(claimingRun.exit, 1);
    assert.equal((claimingRun.output['reportConsistency'] as Record<string, unknown>)['report makes no claim about its own release (v2)'], false);
  });

  it('determinism: the same inputs give byte-identical content, Markdown, manifest and release record (deterministic clock)', async () => {
    const runs = [];
    for (let run = 0; run < 2; run += 1) {
      const world = await open(join(tempDir(), 'assurance.db'));
      runs.push(await runPilotHappyPath(world));
    }
    const [first, second] = runs;
    assert.ok(first && second);
    assert.equal(computeDigest(first.draft.content), computeDigest(second.draft.content));
    assert.equal(first.draft.markdown, second.draft.markdown);
    assert.deepEqual(first.draft.manifest, second.draft.manifest);
    assert.deepEqual(first.release, second.release, 'with a real clock only approvedAt, and so releaseDigest, would differ');
    assert.equal(first.draft.markdown.includes('\r'), false);
    assert.ok(first.draft.markdown.endsWith('\n') && !first.draft.markdown.endsWith('\n\n'));
  });
});
