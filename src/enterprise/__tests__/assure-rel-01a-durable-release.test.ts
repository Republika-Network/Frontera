import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';

import { AssuranceError } from '../assurance/errors.js';
import { computeDigest } from '../governance-store/digest.js';
import { COMMERCIAL_REPORT_RELEASE_ROLE, buildCommercialReportRelease, verifyCommercialReport, type CommercialReportDraft, type CommercialReportRelease } from '../assurance/commercial-report.js';
import { buildCommercialReleaseCustodyRecord, type CommercialReleasePackage } from '../assurance/commercial-release-custody.js';
import { RN_SV_FRAMEWORK_V0_1 } from '../assurance/frameworks/rn-sv-framework.js';
import { AOC_SAF_FRAMEWORK_ID, AOC_SAF_FRAMEWORK_V1, AOC_SAF_FRAMEWORK_VERSION } from '../assurance/saf-framework.js';
import { ASSURANCE_STORE_SCHEMA_VERSION } from '../assurance/contracts.js';
import { createSqliteAssuranceStore, providesDurableReleaseCustody } from '../assurance/sqlite-assurance-store.js';
import type { AssuranceStore } from '../assurance/assurance-store.js';
import type { AssuranceAccessContext } from '../assurance/contracts.js';
import type { AssuranceReviewerCredential } from '../assurance/reviewer-identity.js';
import { createAssuranceService, type CommercialReportReleaseRequest } from '../assurance/service.js';
import type { EnterpriseLogContext, EnterpriseLogger } from '../telemetry/enterprise-logger.js';
import {
  PILOT_ACKNOWLEDGEMENTS,
  PILOT_CREDENTIALS,
  PILOT_CUTOFF,
  PILOT_ENGAGEMENT,
  PILOT_ISSUE,
  PILOT_ORG,
  PILOT_ORG_CONTEXT,
  PILOT_OTHER_ORG_CONTEXT,
  PILOT_SYSTEM_CONTEXT,
  buildPilotWorld,
  pilotContext,
  preparePilotAssessment,
  reviewPilotAssessment,
  type PilotWorld,
} from './assure-pilot-01-scenario.js';

/**
 * ASSURE-REL-01A -- durable commercial release custody, approval authenticity
 * and anti-replay. Closes ASSURE-PILOT-01 F01.
 *
 * Every durability property is proven by closing the SQLite store and opening
 * the same file again, never by an object kept in memory. The adversarial
 * matrix (R01-R26) and the direct-storage cases (A10) are documented in
 * docs/security/ASSURE-REL-01A-DURABLE-RELEASE-AUTHENTICITY.md.
 */

const tempDirs: string[] = [];
const worlds: PilotWorld[] = [];
after(async () => {
  for (const world of worlds) await world.store.close().catch(() => {});
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'assure-rel-01a-'));
  tempDirs.push(dir);
  return dir;
};

/** A second approver of the same organization: the "different approver" of the anti-replay cases. */
const SECOND_APPROVER: AssuranceReviewerCredential = { reviewerId: 'pilot-approver-2', organizationId: PILOT_ORG, roles: [COMMERCIAL_REPORT_RELEASE_ROLE], key: `rel01a-${randomBytes(24).toString('hex')}` };
const ALL_REVIEWERS: readonly AssuranceReviewerCredential[] = [...Object.values(PILOT_CREDENTIALS), SECOND_APPROVER];

interface LogLine {
  readonly level: string;
  readonly message: string;
  readonly fields: EnterpriseLogContext | undefined;
}
function capturingLogger(): { readonly logger: EnterpriseLogger; readonly lines: LogLine[] } {
  const lines: LogLine[] = [];
  const at = (level: string) => (message: string, fields?: EnterpriseLogContext) => lines.push({ level, message, fields });
  return { logger: { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') }, lines };
}

async function open(dbPath: string, options: Parameters<typeof buildPilotWorld>[1] = {}): Promise<PilotWorld> {
  const world = await buildPilotWorld(dbPath, { reviewers: ALL_REVIEWERS, ...options });
  worlds.push(world);
  return world;
}

function contextOf(world: PilotWorld, credential: AssuranceReviewerCredential): AssuranceAccessContext {
  const reviewer = world.service.authenticateReviewer(credential.key);
  assert.ok(reviewer, `${credential.reviewerId} is configured`);
  return { system: false, organizationId: reviewer.organizationId, actorId: reviewer.reviewerId, roles: reviewer.roles, reviewer };
}

/** A second service over `store` with the world's registry and credentials: how an embedder would compose a custom store. */
function serviceOver(store: AssuranceStore, world: PilotWorld): { readonly service: ReturnType<typeof createAssuranceService>; readonly context: AssuranceAccessContext } {
  const service = createAssuranceService({ store, registry: world.registry, evidenceSources: {}, now: () => '2026-10-28T12:00:00.000Z', nextId: (prefix) => `${prefix}-embedded`, enterpriseVersion: 'embedded', reviewers: ALL_REVIEWERS });
  const approver = service.authenticateReviewer(PILOT_CREDENTIALS.approver.key);
  assert.ok(approver);
  return { service, context: { system: false, organizationId: approver.organizationId, actorId: approver.reviewerId, roles: approver.roles, reviewer: approver } };
}

interface Completed {
  readonly world: PilotWorld;
  readonly dbPath: string;
  readonly assessmentId: string;
  readonly draft: CommercialReportDraft;
  readonly request: CommercialReportReleaseRequest;
}

/** A completed pilot assessment with a READY_FOR_RELEASE draft, nothing released yet. */
async function completed(options: Parameters<typeof buildPilotWorld>[1] = {}): Promise<Completed> {
  const dbPath = join(tempDir(), 'assurance.db');
  const world = await open(dbPath, options);
  const prepared = await preparePilotAssessment(world);
  await reviewPilotAssessment(world, prepared.assessmentId);
  await world.service.completeAssessment(PILOT_ORG_CONTEXT, prepared.assessmentId);
  const draft = await world.service.buildCommercialReportDraft(PILOT_ORG_CONTEXT, prepared.assessmentId, { engagement: PILOT_ENGAGEMENT, issue: PILOT_ISSUE });
  assert.equal(draft.content.readiness.status, 'READY_FOR_RELEASE');
  const request = { engagement: PILOT_ENGAGEMENT, issue: PILOT_ISSUE, approvedContentDigest: draft.manifest.contentDigest, acknowledgements: PILOT_ACKNOWLEDGEMENTS };
  return { world, dbPath, assessmentId: prepared.assessmentId, draft, request };
}

const packageOf = (draft: CommercialReportDraft, release: CommercialReportRelease): CommercialReleasePackage => ({ content: draft.content, markdown: draft.markdown, manifest: draft.manifest, release });
const withoutKey = <T extends object>(value: T, key: keyof T): Omit<T, typeof key> => Object.fromEntries(Object.entries(value).filter(([name]) => name !== key)) as Omit<T, typeof key>;
/** What anyone holding a package can do: edit the release record, then recompute its digest. */
const forgeRelease = (release: CommercialReportRelease, change: Partial<CommercialReportRelease>): CommercialReportRelease => {
  const body = withoutKey({ ...release, ...change }, 'releaseDigest');
  return { ...(body as Omit<CommercialReportRelease, 'releaseDigest'>), releaseDigest: computeDigest(body) };
};
const rowCount = (dbPath: string): number => {
  const raw = new Database(dbPath, { readonly: true });
  try {
    return (raw.prepare('SELECT count(*) AS n FROM assurance_commercial_releases').get() as { n: number }).n;
  } finally {
    raw.close();
  }
};
const isCode = (code: string, detail?: (details: Readonly<Record<string, unknown>> | undefined) => boolean) => (error: unknown) =>
  error instanceof AssuranceError && error.code === code && (detail === undefined || detail(error.details));
const isConflict = (conflict: 'content' | 'approver') => isCode('ASSURANCE_ASSESSMENT_IMMUTABLE', (details) => details?.['reason'] === 'commercial_release_conflict' && details?.['conflict'] === conflict);

// ===========================================================================

describe('ASSURE-REL-01A -- a release is kept in custody, bound to the authenticated approver and the exact content', () => {
  it('R01 a first valid release is committed once, durably, with the tenant derived from the assessment and the approver from the credential', async () => {
    const { world, dbPath, assessmentId, request } = await completed();
    const result = await world.service.releaseCommercialReport(pilotContext(world, 'approver'), assessmentId, { ...request, approvedBy: 'someone-else', organizationId: 'another-org' } as CommercialReportReleaseRequest);
    assert.deepEqual(result.custody, { outcome: 'committed' });
    assert.equal(providesDurableReleaseCustody(world.store), true);
    assert.equal(result.release.approvedBy, PILOT_CREDENTIALS.approver.reviewerId, 'the approver comes from the credential, never from the request body');
    assert.equal(rowCount(dbPath), 1);
    const kept = await world.service.getCommercialRelease(PILOT_ORG_CONTEXT, result.release.reportId);
    assert.ok(kept);
    assert.deepEqual(kept.release, result.release, 'the whole delivered record is kept, not only its digest');
    assert.deepEqual(kept.manifest, result.draft.manifest);
    assert.equal(kept.organizationId, PILOT_ORG);
    assert.equal(kept.assessmentId, assessmentId);
    assert.equal(kept.manifest.frameworkId, 'rn.sv');
    assert.equal(kept.manifest.frameworkVersion, '0.1.0');
    assert.equal('organizationId' in result.release, false, 'the delivered release record still carries no tenant identifier');
    assert.deepEqual(result.release.acknowledgements, PILOT_ACKNOWLEDGEMENTS);
  });

  it('R02/R03 a forged approver, or digests recomputed over changed content, keep offline integrity but never match custody', async () => {
    const { world, assessmentId, request } = await completed();
    const { draft, release } = await world.service.releaseCommercialReport(pilotContext(world, 'approver'), assessmentId, request);
    const forgedApprover = forgeRelease(release, { approvedBy: 'pilot-approver-2' });
    assert.equal(verifyCommercialReport(packageOf(draft, forgedApprover)).valid, true, 'self-consistent: integrity is not authenticity');
    const verdict = await world.service.verifyCommercialRelease(PILOT_ORG_CONTEXT, packageOf(draft, forgedApprover));
    assert.equal(verdict.integrity, 'INTEGRITY_VALID');
    assert.equal(verdict.authority, 'RELEASE_MISMATCH');
    assert.deepEqual(verdict.mismatchedFields, ['release.approvedBy', 'release.releaseDigest']);
    assert.equal(verdict.releaseAuthenticated, false);
    assert.equal(verdict.custody?.approvedBy, PILOT_CREDENTIALS.approver.reviewerId);

    // A different report presented as approved: content, Markdown and manifest all resealed.
    const content = { ...draft.content, results: { ...draft.content.results, normalizedScore: 100 } };
    const manifestBody = withoutKey({ ...draft.manifest, contentDigest: computeDigest(content) }, 'manifestDigest');
    const manifest = { ...(manifestBody as Omit<typeof draft.manifest, 'manifestDigest'>), manifestDigest: computeDigest(manifestBody) };
    const resealed = forgeRelease(release, { contentDigest: manifest.contentDigest, manifestDigest: manifest.manifestDigest });
    const rescored: CommercialReleasePackage = { content, markdown: draft.markdown, manifest, release: resealed };
    assert.equal(verifyCommercialReport(rescored).valid, true);
    const rescoredVerdict = await world.service.verifyCommercialRelease(PILOT_ORG_CONTEXT, rescored);
    assert.equal(rescoredVerdict.authority, 'RELEASE_MISMATCH');
    assert.ok(rescoredVerdict.mismatchedFields.includes('release.contentDigest') && rescoredVerdict.mismatchedFields.includes('manifest.contentDigest'));
    assert.equal(rescoredVerdict.releaseAuthenticated, false);

    const genuine = await world.service.verifyCommercialRelease(PILOT_ORG_CONTEXT, packageOf(draft, release));
    assert.equal(genuine.authority, 'RELEASE_MATCHES_AUTHORITY');
    assert.equal(genuine.releaseAuthenticated, true);
    assert.equal(genuine.approverCurrentlyAuthorized, true);
  });

  it('R04 the same release requested again -- even after its issue date, from a restarted Host -- returns the kept record and writes nothing', async () => {
    const { world, dbPath, assessmentId, request } = await completed();
    const first = await world.service.releaseCommercialReport(pilotContext(world, 'approver'), assessmentId, request);
    const again = await world.service.releaseCommercialReport(pilotContext(world, 'approver'), assessmentId, request);
    assert.deepEqual(again.custody, { outcome: 'replayed' });
    assert.deepEqual(again.release, first.release);
    await world.store.close();
    // The next day: a fresh release would be refused for its date; the retry still recovers the original.
    const nextDay = await open(dbPath, { startTick: 86_400_000 });
    const retried = await nextDay.service.releaseCommercialReport(pilotContext(nextDay, 'approver'), assessmentId, request);
    assert.equal(retried.custody.outcome, 'replayed');
    assert.deepEqual(retried.release, first.release);
    assert.equal(rowCount(dbPath), 1);
  });

  it('R05 two approvers releasing concurrently through two connections to the same file yield exactly one release', async () => {
    const { world, dbPath, assessmentId, request } = await completed();
    const other = await open(dbPath, { startTick: 500_000, startId: 50_000 });
    const outcomes = await Promise.allSettled([
      world.service.releaseCommercialReport(pilotContext(world, 'approver'), assessmentId, request),
      other.service.releaseCommercialReport(contextOf(other, SECOND_APPROVER), assessmentId, request),
    ]);
    const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled');
    const rejected = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.ok(isConflict('approver')(rejected[0]?.reason), String(rejected[0]?.reason));
    assert.equal(rowCount(dbPath), 1);

    // Below the service's own lookup: two records for one report version committed straight to the two stores.
    const kept = await world.service.getCommercialRelease(PILOT_ORG_CONTEXT, `rn-sv-report:${assessmentId}:v1.0`);
    assert.ok(kept);
    const rival = buildCommercialReleaseCustodyRecord({ organizationId: PILOT_ORG, manifest: kept.manifest, release: forgeRelease(kept.release, { approvedBy: 'pilot-approver-2' }) });
    const commit = world.store.commitCommercialRelease;
    const commitOther = other.store.commitCommercialRelease;
    assert.ok(commit && commitOther);
    const [a, b] = await Promise.all([commit.call(world.store, PILOT_ORG_CONTEXT, rival), commitOther.call(other.store, PILOT_ORG_CONTEXT, rival)]);
    assert.deepEqual([a.outcome, b.outcome], ['existing', 'existing'], 'the stored release is returned, never overwritten');
    assert.equal(a.record.release.approvedBy, kept.release.approvedBy);
    assert.equal(rowCount(dbPath), 1);
  });

  it('R06-R09 another tenant, an organization key, a reviewer without the release role and the system context release nothing', async () => {
    const { world, dbPath, assessmentId, request } = await completed();
    await assert.rejects(world.service.releaseCommercialReport(pilotContext(world, 'otherApprover'), assessmentId, request), isCode('ASSURANCE_ASSESSMENT_NOT_FOUND'));
    await assert.rejects(world.service.releaseCommercialReport({ ...PILOT_ORG_CONTEXT, actorId: 'pilot-approver', roles: [COMMERCIAL_REPORT_RELEASE_ROLE] }, assessmentId, request), isCode('ASSURANCE_REVIEWER_UNAUTHORIZED'));
    await assert.rejects(world.service.releaseCommercialReport(pilotContext(world, 'reviewer'), assessmentId, request), isCode('ASSURANCE_REVIEWER_UNAUTHORIZED'));
    await assert.rejects(world.service.releaseCommercialReport(PILOT_SYSTEM_CONTEXT, assessmentId, request), isCode('ASSURANCE_REVIEWER_UNAUTHORIZED'));
    assert.equal(rowCount(dbPath), 0);
  });

  it('R10-R12 a changed content digest is refused at release; a changed content, manifest or release record never verifies as the kept release', async () => {
    const { world, dbPath, assessmentId, request } = await completed();
    await assert.rejects(world.service.releaseCommercialReport(pilotContext(world, 'approver'), assessmentId, { ...request, approvedContentDigest: computeDigest('another report') }), isCode('ASSURANCE_INTEGRITY_FAILED'));
    assert.equal(rowCount(dbPath), 0);
    const { draft, release } = await world.service.releaseCommercialReport(pilotContext(world, 'approver'), assessmentId, request);
    const verify = (delivered: CommercialReleasePackage) => world.service.verifyCommercialRelease(PILOT_ORG_CONTEXT, delivered);

    const changedContent = await verify({ ...packageOf(draft, release), content: { ...draft.content, reportId: 'x' } });
    assert.equal(changedContent.integrity, 'INTEGRITY_INVALID');
    assert.equal(changedContent.releaseAuthenticated, false);
    const changedManifest = await verify({ ...packageOf(draft, release), manifest: { ...draft.manifest, readiness: 'DRAFT' } });
    assert.equal(changedManifest.authority, 'RELEASE_MISMATCH');
    assert.deepEqual(changedManifest.mismatchedFields, ['manifest.readiness']);
    assert.equal(changedManifest.releaseAuthenticated, false);
    const changedRelease = await verify(packageOf(draft, { ...release, approvedAt: '2026-10-27T00:00:00.000Z' }));
    assert.equal(changedRelease.integrity, 'INTEGRITY_INVALID');
    assert.equal(changedRelease.authority, 'RELEASE_MISMATCH');
    assert.deepEqual(changedRelease.mismatchedFields, ['release.approvedAt']);
    const missingRelease = await verify({ content: draft.content, markdown: draft.markdown, manifest: draft.manifest });
    assert.equal(missingRelease.releaseAuthenticated, false);
    assert.deepEqual(missingRelease.mismatchedFields, ['release']);
  });

  it('R13 a write failure at the custody insert gives no success, no row, no success log and no driver detail; the retry commits once', async () => {
    const { logger, lines } = capturingLogger();
    const { world, dbPath, assessmentId, request } = await completed({ logger });
    const raw = new Database(dbPath);
    try {
      raw.exec(`CREATE TRIGGER rel01a_inject BEFORE INSERT ON assurance_commercial_releases BEGIN SELECT RAISE(ABORT, 'rel01a injected'); END`);
      await assert.rejects(world.service.releaseCommercialReport(pilotContext(world, 'approver'), assessmentId, request), (error: unknown) => {
        assert.ok(error instanceof AssuranceError && error.code === 'ASSURANCE_STORE_UNAVAILABLE', String(error));
        assert.equal(error.details?.['retryable'], true);
        assert.equal(/injected|SQLITE|assurance\.db|\//.test(error.message), false, `no driver detail or path: ${error.message}`);
        return true;
      });
      assert.equal(rowCount(dbPath), 0);
      assert.equal(lines.some((line) => line.message === 'assurance.commercial_report.released'), false, 'no success is logged before the commit');
      raw.exec('DROP TRIGGER rel01a_inject');
    } finally {
      raw.close();
    }
    const retried = await world.service.releaseCommercialReport(pilotContext(world, 'approver'), assessmentId, request);
    assert.equal(retried.custody.outcome, 'committed');
    assert.equal(rowCount(dbPath), 1);
    assert.deepEqual(lines.filter((line) => line.message === 'assurance.commercial_report.released').map((line) => line.fields?.status), ['committed']);
    assert.ok(lines.every((line) => !JSON.stringify(line.fields ?? {}).includes(PILOT_CREDENTIALS.approver.key)), 'no credential is logged');
  });

  it('R14 custody survives closing and reopening the store: the record, its uniqueness and its verification', async () => {
    const { world, dbPath, assessmentId, request } = await completed();
    const { draft, release } = await world.service.releaseCommercialReport(pilotContext(world, 'approver'), assessmentId, request);
    await world.store.close();
    const restarted = await open(dbPath, { startTick: 1_000_000, startId: 100_000 });
    assert.deepEqual((await restarted.service.getCommercialRelease(PILOT_ORG_CONTEXT, release.reportId))?.release, release);
    assert.equal((await restarted.service.verifyCommercialRelease(PILOT_ORG_CONTEXT, packageOf(draft, release))).releaseAuthenticated, true);
    await assert.rejects(restarted.service.releaseCommercialReport(contextOf(restarted, SECOND_APPROVER), assessmentId, request), isConflict('approver'));
    assert.equal(rowCount(dbPath), 1);
  });

  it('R15 a backup made with the portability tooling and restored keeps the release, its uniqueness and its append-only guard', async () => {
    const portability = (await import(pathToFileURL(join(process.cwd(), 'scripts', 'portability', 'lib-portability.mjs')).href)) as {
      safeSqliteCopy(source: string, destination: string): Promise<void>;
      sqliteIntegrityCheck(path: string): Promise<{ readonly ok: boolean }>;
      tableCounts(path: string): Promise<Readonly<Record<string, number>>>;
    };
    const { world, dbPath, assessmentId, request } = await completed();
    const { draft, release } = await world.service.releaseCommercialReport(pilotContext(world, 'approver'), assessmentId, request);
    const backup = join(tempDir(), 'assurance.sqlite');
    await portability.safeSqliteCopy(dbPath, backup);
    assert.equal((await portability.sqliteIntegrityCheck(backup)).ok, true);
    assert.equal((await portability.tableCounts(backup))['assurance_commercial_releases'], 1);
    await world.store.close();
    const restored = await open(backup, { startTick: 1_000_000, startId: 100_000 });
    assert.equal((await restored.service.verifyCommercialRelease(PILOT_ORG_CONTEXT, packageOf(draft, release))).authority, 'RELEASE_MATCHES_AUTHORITY');
    assert.equal((await restored.service.releaseCommercialReport(pilotContext(restored, 'approver'), assessmentId, request)).custody.outcome, 'replayed');
    await assert.rejects(restored.service.releaseCommercialReport(contextOf(restored, SECOND_APPROVER), assessmentId, request), isConflict('approver'));
    const raw = new Database(backup);
    try {
      assert.throws(() => raw.prepare(`UPDATE assurance_commercial_releases SET approved_by = 'x'`).run(), /append-only/);
      assert.throws(() => raw.prepare('DELETE FROM assurance_commercial_releases').run(), /append-only/);
    } finally {
      raw.close();
    }
  });

  it('R16 another tenant reads no release: get returns nothing, listing refuses the assessment, verification finds nothing in its own custody', async () => {
    const { world, assessmentId, request } = await completed();
    const { draft, release } = await world.service.releaseCommercialReport(pilotContext(world, 'approver'), assessmentId, request);
    assert.equal(await world.service.getCommercialRelease(PILOT_OTHER_ORG_CONTEXT, release.reportId), null);
    await assert.rejects(world.service.listCommercialReleases(PILOT_OTHER_ORG_CONTEXT, assessmentId), isCode('ASSURANCE_ASSESSMENT_NOT_FOUND'));
    const foreign = await world.service.verifyCommercialRelease(PILOT_OTHER_ORG_CONTEXT, packageOf(draft, release));
    assert.equal(foreign.authority, 'RELEASE_NOT_IN_CUSTODY');
    assert.equal(foreign.custody, undefined, 'nothing of the other tenant is disclosed');
    await assert.rejects(world.service.getCommercialRelease({ system: false }, release.reportId), isCode('ASSURANCE_TENANT_SCOPE_REQUIRED'));
  });

  it('R17/R23 a released report version is never re-approved: other content under the same version conflicts; a new version is a new, explicit release', async () => {
    const { world, dbPath, assessmentId, request } = await completed();
    const first = await world.service.releaseCommercialReport(pilotContext(world, 'approver'), assessmentId, request);
    // A later finding event changes the report: the earlier approval no longer matches it.
    const finding = (await world.service.listFindings(PILOT_ORG_CONTEXT, assessmentId))[0];
    assert.ok(finding);
    await world.service.appendFindingEvent(PILOT_ORG_CONTEXT, { findingId: finding.findingId, eventType: 'AssuranceFindingAccepted', actorId: 'pilot-customer-owner' });
    await assert.rejects(world.service.releaseCommercialReport(pilotContext(world, 'approver'), assessmentId, request), isCode('ASSURANCE_INTEGRITY_FAILED'));
    // Approving the changed report under the version already released is the "key reused for other content" case.
    const changed = await world.service.buildCommercialReportDraft(PILOT_ORG_CONTEXT, assessmentId, { engagement: PILOT_ENGAGEMENT, issue: PILOT_ISSUE });
    assert.equal(changed.content.reportId, first.release.reportId);
    await assert.rejects(world.service.releaseCommercialReport(pilotContext(world, 'approver'), assessmentId, { ...request, approvedContentDigest: changed.manifest.contentDigest }), isConflict('content'));
    // A new report version needs, and gets, its own approval.
    const issue = { ...PILOT_ISSUE, reportVersion: '1.1' };
    const reissued = await world.service.buildCommercialReportDraft(PILOT_ORG_CONTEXT, assessmentId, { engagement: PILOT_ENGAGEMENT, issue });
    const second = await world.service.releaseCommercialReport(pilotContext(world, 'approver'), assessmentId, { ...request, issue, approvedContentDigest: reissued.manifest.contentDigest });
    assert.equal(second.custody.outcome, 'committed');
    assert.notEqual(second.release.reportId, first.release.reportId);
    assert.deepEqual((await world.service.listCommercialReleases(PILOT_ORG_CONTEXT, assessmentId)).map((kept) => kept.reportId), [first.release.reportId, second.release.reportId]);
    assert.equal(rowCount(dbPath), 2);
    assert.deepEqual((await world.service.getCommercialRelease(PILOT_ORG_CONTEXT, first.release.reportId))?.release, first.release, 'the first release is untouched');
  });

  it('R18 a later revocation keeps the recorded approval and reports, separately, that the approver no longer holds the role', async () => {
    const { world, dbPath, assessmentId, request } = await completed();
    const { draft, release } = await world.service.releaseCommercialReport(pilotContext(world, 'approver'), assessmentId, request);
    await world.store.close();
    const revoked = await open(dbPath, { startTick: 1_000_000, startId: 100_000, reviewers: ALL_REVIEWERS.filter((credential) => credential.reviewerId !== 'pilot-approver') });
    const verdict = await revoked.service.verifyCommercialRelease(PILOT_ORG_CONTEXT, packageOf(draft, release));
    assert.equal(verdict.authority, 'RELEASE_MATCHES_AUTHORITY', 'history is not rewritten');
    assert.equal(verdict.releaseAuthenticated, true);
    assert.equal(verdict.custody?.approvedBy, 'pilot-approver');
    assert.equal(verdict.approverCurrentlyAuthorized, false, 'current validity is distinguishable');
    assert.equal(revoked.service.authenticateReviewer(PILOT_CREDENTIALS.approver.key), undefined, 'the revoked credential releases nothing more');
  });

  it('R19/R20 without the authority nothing is authenticated, and no signature is ever claimed', async () => {
    const { world, assessmentId, request } = await completed();
    const { draft, release } = await world.service.releaseCommercialReport(pilotContext(world, 'approver'), assessmentId, request);
    const genuine = await world.service.verifyCommercialRelease(PILOT_ORG_CONTEXT, packageOf(draft, release));
    assert.equal(genuine.externalSignature, 'EXTERNAL_SIGNATURE_NOT_AVAILABLE');
    assert.match(release.statement, /not a digital signature/);
    const kept = await world.service.getCommercialRelease(PILOT_ORG_CONTEXT, release.reportId);
    assert.equal(/signature/i.test(Object.keys(kept ?? {}).join() + Object.keys(kept?.release ?? {}).join()), false, 'no signature field exists to be mistaken for one');
    await world.store.close();
    const unavailable = await world.service.verifyCommercialRelease(PILOT_ORG_CONTEXT, packageOf(draft, release));
    assert.equal(unavailable.authority, 'AUTHORITY_UNAVAILABLE');
    assert.equal(unavailable.authorityFailure, 'ASSURANCE_STORE_UNAVAILABLE');
    assert.equal(unavailable.integrity, 'INTEGRITY_VALID');
    assert.equal(unavailable.releaseAuthenticated, false);
  });

  it('R19 a store without release custody can neither release nor verify: a release is never returned unkept', async () => {
    const { world, dbPath, assessmentId, request } = await completed();
    const { commitCommercialRelease: _commit, getCommercialRelease: _get, listCommercialReleases: _list, ...withoutCustody } = world.store;
    const legacy: AssuranceStore = withoutCustody;
    const { service, context } = serviceOver(legacy, world);
    await assert.rejects(service.releaseCommercialReport(context, assessmentId, request), isCode('ASSURANCE_STORE_UNAVAILABLE'));
    const draft = await service.buildCommercialReportDraft(PILOT_ORG_CONTEXT, assessmentId, { engagement: PILOT_ENGAGEMENT, issue: PILOT_ISSUE });
    const unkept = buildCommercialReportRelease(draft, { approvedBy: 'pilot-approver', approverRole: COMMERCIAL_REPORT_RELEASE_ROLE, approvedAt: '2026-10-28T09:00:00.000Z', acknowledgements: PILOT_ACKNOWLEDGEMENTS });
    assert.equal((await service.verifyCommercialRelease(PILOT_ORG_CONTEXT, packageOf(draft, unkept))).authority, 'AUTHORITY_UNAVAILABLE');
    assert.equal(rowCount(dbPath), 0);
  });

  it('R1-01 a store that only claims to be SQLite -- same providerKind, every custody method, the real database behind it -- cannot release', async () => {
    const { world, dbPath, assessmentId, request } = await completed();
    const impersonator: AssuranceStore = { ...world.store };
    assert.equal(impersonator.providerKind, 'sqlite');
    assert.equal(typeof impersonator.commitCommercialRelease, 'function');
    assert.equal(providesDurableReleaseCustody(impersonator), false, 'durability is the factory instance, not a string');
    const { service, context } = serviceOver(impersonator, world);
    await assert.rejects(service.releaseCommercialReport(context, assessmentId, request), isCode('ASSURANCE_STORE_UNAVAILABLE'));
    assert.equal(rowCount(dbPath), 0, 'nothing was written');
    // An unauthorized caller still learns only that it is unauthorized.
    await assert.rejects(service.releaseCommercialReport(PILOT_SYSTEM_CONTEXT, assessmentId, request), isCode('ASSURANCE_REVIEWER_UNAUTHORIZED'));
  });

  it('R21/R22 an incomplete assessment or a release without the commercial-use acknowledgement records nothing', async () => {
    const { world, dbPath, assessmentId, request } = await completed();
    await assert.rejects(world.service.releaseCommercialReport(pilotContext(world, 'approver'), assessmentId, { ...request, acknowledgements: { limitationsReviewed: true } as never }), isCode('ASSURANCE_VALIDATION_ERROR'));
    const incomplete = await preparePilotAssessment(world);
    await assert.rejects(world.service.releaseCommercialReport(pilotContext(world, 'approver'), incomplete.assessmentId, request), isCode('ASSURANCE_ASSESSMENT_INCOMPLETE'));
    // Below the service: the store itself refuses a coherent record for an assessment that is not completed...
    const ready = await world.service.buildCommercialReportDraft(PILOT_ORG_CONTEXT, assessmentId, { engagement: PILOT_ENGAGEMENT, issue: PILOT_ISSUE });
    const reportId = `rn-sv-report:${incomplete.assessmentId}:v1.0`;
    const manifestBody = withoutKey({ ...ready.manifest, assessmentId: incomplete.assessmentId, reportId }, 'manifestDigest');
    const manifest = { ...(manifestBody as Omit<typeof ready.manifest, 'manifestDigest'>), manifestDigest: computeDigest(manifestBody) };
    const content = { ...ready.content, reportId, integrity: { ...ready.content.integrity, assessmentId: incomplete.assessmentId } };
    const release = buildCommercialReportRelease({ content, markdown: ready.markdown, manifest }, { approvedBy: 'pilot-approver', approverRole: COMMERCIAL_REPORT_RELEASE_ROLE, approvedAt: '2026-10-28T09:30:00.000Z', acknowledgements: PILOT_ACKNOWLEDGEMENTS });
    const commit = world.store.commitCommercialRelease;
    assert.ok(commit);
    await assert.rejects(commit.call(world.store, PILOT_ORG_CONTEXT, buildCommercialReleaseCustodyRecord({ organizationId: PILOT_ORG, manifest, release })), isCode('ASSURANCE_ASSESSMENT_INCOMPLETE'));
    // ...and an incoherent record outright.
    await assert.rejects(commit.call(world.store, PILOT_ORG_CONTEXT, buildCommercialReleaseCustodyRecord({ organizationId: PILOT_ORG, manifest, release: { ...release, approvedBy: 'edited-after-digest' } })), isCode('ASSURANCE_VALIDATION_ERROR'));
    assert.equal(rowCount(dbPath), 0);
  });

  it('R24/R25 aoc.saf has no commercial report and rn.sv@0.1.0 keeps its golden digest', async () => {
    const { world } = await completed();
    const saf = await world.service.createAssessment(PILOT_ORG_CONTEXT, { subject: { subjectType: 'agent', subjectId: 'rel01a-agent', organizationId: PILOT_ORG }, frameworkId: AOC_SAF_FRAMEWORK_ID, frameworkVersion: AOC_SAF_FRAMEWORK_VERSION, requestedBy: 'pilot-preparer', evidenceCutoffAt: PILOT_CUTOFF });
    await assert.rejects(world.service.releaseCommercialReport(pilotContext(world, 'approver'), saf.assessmentId, { engagement: PILOT_ENGAGEMENT, issue: PILOT_ISSUE, approvedContentDigest: computeDigest('x'), acknowledgements: PILOT_ACKNOWLEDGEMENTS }), isCode('ASSURANCE_FRAMEWORK_VERSION_UNSUPPORTED'));
    assert.equal(computeDigest(RN_SV_FRAMEWORK_V0_1), 'sha256:e71fafe1a10af95514823e35d43138b1b93cdb72e37765200447a37748c13a58');
    assert.equal(computeDigest(AOC_SAF_FRAMEWORK_V1), 'sha256:4c0b5c65a0b8cfe40de726f26d80b80224fac6ca80fe2c221f7a734548899bb9');
  });

  it('R1-01 the in-memory store refuses every commercial release; drafting, verification and reads still work, and nothing is kept', async () => {
    const { logger, lines } = capturingLogger();
    const { world, assessmentId, draft, request } = await completed({ inMemory: true, logger });
    assert.equal(providesDurableReleaseCustody(world.store), false);
    await assert.rejects(world.service.releaseCommercialReport(pilotContext(world, 'approver'), assessmentId, request), isCode('ASSURANCE_STORE_UNAVAILABLE', () => true));
    await assert.rejects(world.service.releaseCommercialReport(pilotContext(world, 'approver'), assessmentId, request), isCode('ASSURANCE_STORE_UNAVAILABLE'), 'a retry is refused too');
    assert.equal(draft.content.readiness.status, 'READY_FOR_RELEASE', 'drafting works');
    assert.deepEqual(await world.service.listCommercialReleases(PILOT_ORG_CONTEXT, assessmentId), [], 'no approval was kept');
    assert.equal(await world.service.getCommercialRelease(PILOT_ORG_CONTEXT, draft.content.reportId), null);
    const unkept = buildCommercialReportRelease(draft, { approvedBy: 'pilot-approver', approverRole: COMMERCIAL_REPORT_RELEASE_ROLE, approvedAt: '2026-10-28T09:00:00.000Z', acknowledgements: PILOT_ACKNOWLEDGEMENTS });
    const verdict = await world.service.verifyCommercialRelease(PILOT_ORG_CONTEXT, packageOf(draft, unkept));
    assert.equal(verdict.integrity, 'INTEGRITY_VALID', 'integrity can still be checked');
    assert.equal(verdict.authority, 'RELEASE_NOT_IN_CUSTODY');
    assert.equal(lines.some((line) => line.message === 'assurance.commercial_report.released'), false, 'no success is logged');
    assert.equal(world.events.some((event) => /release/i.test(event.type)), false, 'no success event');
  });
});

// ===========================================================================

describe('ASSURE-REL-01A -- direct storage writes (A10) and migration of an existing database', () => {
  it('A10 the append-only guard refuses UPDATE and DELETE; a row edited around it is reported as corrupted custody, never returned', async () => {
    const { world, dbPath, assessmentId, request } = await completed();
    const { draft, release } = await world.service.releaseCommercialReport(pilotContext(world, 'approver'), assessmentId, request);
    const raw = new Database(dbPath);
    try {
      assert.throws(() => raw.prepare(`UPDATE assurance_commercial_releases SET approved_by = 'pilot-approver-2'`).run(), /append-only/);
      assert.throws(() => raw.prepare('DELETE FROM assurance_commercial_releases').run(), /append-only/);
      // Someone with write access drops the guard and edits the approver inside the stored JSON only.
      raw.exec('DROP TRIGGER assurance_commercial_releases_no_update');
      const row = raw.prepare('SELECT record_json FROM assurance_commercial_releases WHERE report_id = ?').get(release.reportId) as { record_json: string };
      raw.prepare('UPDATE assurance_commercial_releases SET record_json = ? WHERE report_id = ?').run(row.record_json.replace('"approvedBy":"pilot-approver"', '"approvedBy":"pilot-approver-2"'), release.reportId);
    } finally {
      raw.close();
    }
    await assert.rejects(world.service.getCommercialRelease(PILOT_ORG_CONTEXT, release.reportId), isCode('ASSURANCE_INTEGRITY_FAILED'));
    const verdict = await world.service.verifyCommercialRelease(PILOT_ORG_CONTEXT, packageOf(draft, release));
    assert.equal(verdict.authority, 'AUTHORITY_UNAVAILABLE');
    assert.equal(verdict.authorityFailure, 'ASSURANCE_INTEGRITY_FAILED');
    assert.equal(verdict.releaseAuthenticated, false);
  });

  it('A10 KNOWN LIMITATION -- a writer who rewrites a row and recomputes every digest is not detected: custody is the issuer’s record, not non-repudiation', async () => {
    const { world, dbPath, assessmentId, request } = await completed();
    const { draft, release } = await world.service.releaseCommercialReport(pilotContext(world, 'approver'), assessmentId, request);
    const forged = forgeRelease(release, { approvedBy: 'pilot-approver-2' });
    const record = buildCommercialReleaseCustodyRecord({ organizationId: PILOT_ORG, manifest: draft.manifest, release: forged });
    const raw = new Database(dbPath);
    try {
      raw.exec('DROP TRIGGER assurance_commercial_releases_no_update');
      raw.prepare('UPDATE assurance_commercial_releases SET approved_by = ?, release_digest = ?, record_json = ?, record_digest = ? WHERE report_id = ?').run(
        forged.approvedBy, forged.releaseDigest, JSON.stringify(record), record.recordDigest, release.reportId,
      );
    } finally {
      raw.close();
    }
    const verdict = await world.service.verifyCommercialRelease(PILOT_ORG_CONTEXT, packageOf(draft, forged));
    assert.equal(verdict.releaseAuthenticated, true, 'undetected: the store is the authority, and whoever can rewrite it can rewrite history');
  });

  it('migration: a database written before release custody opens, keeps every row and digest, gains an empty custody table and corroborates no earlier release', async () => {
    const { world, dbPath, assessmentId, draft } = await completed();
    // An "earlier" release: built and delivered before custody existed, never kept.
    const historical = buildCommercialReportRelease(draft, { approvedBy: 'pilot-approver', approverRole: COMMERCIAL_REPORT_RELEASE_ROLE, approvedAt: '2026-10-28T09:30:00.000Z', acknowledgements: PILOT_ACKNOWLEDGEMENTS });
    const assessmentBefore = await world.service.getAssessment(PILOT_ORG_CONTEXT, assessmentId);
    await world.store.close();
    const raw = new Database(dbPath);
    try {
      raw.exec('DROP TABLE assurance_commercial_releases'); // the database as a runtime before ASSURE-REL-01A left it
      assert.equal(raw.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'assurance_commercial_releases'`).get(), undefined);
    } finally {
      raw.close();
    }
    const upgraded = await open(dbPath, { startTick: 1_000_000, startId: 100_000 });
    assert.deepEqual(await upgraded.service.getAssessment(PILOT_ORG_CONTEXT, assessmentId), assessmentBefore, 'no existing row changes');
    assert.equal((await upgraded.service.verifyAssessment(PILOT_ORG_CONTEXT, assessmentId)).valid, true);
    assert.equal(rowCount(dbPath), 0, 'no release is fabricated retroactively');
    const verdict = await upgraded.service.verifyCommercialRelease(PILOT_ORG_CONTEXT, packageOf(draft, historical));
    assert.equal(verdict.integrity, 'INTEGRITY_VALID');
    assert.equal(verdict.authority, 'RELEASE_NOT_IN_CUSTODY', 'an earlier release is not corroborated, and no identity is assigned to it');
    assert.equal(verdict.releaseAuthenticated, false);
    const rawAfter = new Database(dbPath, { readonly: true });
    try {
      const versions = rawAfter.prepare('SELECT schema_version FROM assurance_store_versions').all() as { schema_version: string }[];
      assert.deepEqual(versions.map((row) => row.schema_version), [ASSURANCE_STORE_SCHEMA_VERSION], 'the frozen schema identifier is unchanged');
    } finally {
      rawAfter.close();
    }
  });

});

// ===========================================================================

/**
 * A complete picture of a database file, read-only: every schema object and
 * its SQL, every row of every table, `user_version` and the journal mode.
 * Two equal snapshots mean nothing in the schema or data changed.
 */
function snapshot(dbPath: string): string {
  const raw = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const schema = raw.prepare(`SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name`).all() as { type: string; name: string }[];
    const tables = schema
      .filter((object) => object.type === 'table' && !object.name.startsWith('sqlite_'))
      .map((object) => [object.name, raw.prepare(`SELECT * FROM "${object.name}"`).all()]);
    return JSON.stringify({ schema, tables, userVersion: raw.pragma('user_version', { simple: true }), journalMode: raw.pragma('journal_mode', { simple: true }) });
  } finally {
    raw.close();
  }
}
const sha256File = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex');
const objectNames = (dbPath: string): string[] => {
  const raw = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return (raw.prepare(`SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name`).all() as { name: string }[]).map((row) => row.name);
  } finally {
    raw.close();
  }
};
const CUSTODY_OBJECTS = ['assurance_commercial_releases', 'assurance_commercial_releases_no_delete', 'assurance_commercial_releases_no_update', 'idx_assurance_releases_assessment'];
const refusedUnchanged = async (dbPath: string, message: RegExp): Promise<void> => {
  const before = snapshot(dbPath);
  await assert.rejects(createSqliteAssuranceStore(dbPath), (error: unknown) => {
    assert.ok(error instanceof AssuranceError && error.code === 'ASSURANCE_STORE_UNAVAILABLE', String(error));
    assert.match(error.message, message);
    assert.match(error.message, /nothing was changed/);
    assert.equal(/SQLITE|\//.test(error.message), false, `no driver detail or path: ${error.message}`);
    return true;
  });
  assert.equal(snapshot(dbPath), before, 'schema, rows, user_version and journal mode are exactly as they were');
};
/** A completed, released pilot assessment on disk, closed: an ordinary v1 database with release custody. */
async function releasedDatabase(): Promise<{ readonly dbPath: string; readonly assessmentId: string }> {
  const { world, dbPath, assessmentId, request } = await completed();
  await world.service.releaseCommercialReport(pilotContext(world, 'approver'), assessmentId, request);
  await world.store.close();
  return { dbPath, assessmentId };
}

describe('ASSURE-REL-01A-R1 -- opening a database reads before it writes, and refuses without changing anything', () => {
  it('a brand-new file is initialized with the v1 schema, release custody and one version row, in WAL mode', async () => {
    const dbPath = join(tempDir(), 'fresh.db');
    const store = await createSqliteAssuranceStore(dbPath);
    await store.close();
    assert.ok(CUSTODY_OBJECTS.every((name) => objectNames(dbPath).includes(name)));
    const raw = new Database(dbPath, { readonly: true });
    try {
      assert.deepEqual((raw.prepare('SELECT schema_version FROM assurance_store_versions').all() as { schema_version: string }[]).map((row) => row.schema_version), [ASSURANCE_STORE_SCHEMA_VERSION]);
      assert.equal(raw.pragma('journal_mode', { simple: true }), 'wal');
    } finally {
      raw.close();
    }
  });

  it('a v1 database with release custody reopens without any change', async () => {
    const { dbPath } = await releasedDatabase();
    const before = snapshot(dbPath);
    const store = await createSqliteAssuranceStore(dbPath);
    await store.close();
    assert.equal(snapshot(dbPath), before);
  });

  it('a v1 database written before release custody gains exactly the custody objects; every other object and row is unchanged', async () => {
    const { dbPath } = await releasedDatabase();
    const raw = new Database(dbPath);
    raw.exec('DROP TABLE assurance_commercial_releases');
    raw.close();
    const before = JSON.parse(snapshot(dbPath)) as { schema: unknown[]; tables: unknown[] };
    const store = await createSqliteAssuranceStore(dbPath);
    await store.close();
    const after = JSON.parse(snapshot(dbPath)) as { schema: { tbl_name: string }[]; tables: [string, unknown][] };
    // Every object the extension adds belongs to the custody table (its triggers, its index and SQLite's own primary-key index).
    assert.deepEqual(after.schema.filter((object) => object.tbl_name !== 'assurance_commercial_releases'), before.schema);
    assert.deepEqual(after.tables.filter(([name]) => name !== 'assurance_commercial_releases'), before.tables);
    assert.ok(CUSTODY_OBJECTS.every((name) => objectNames(dbPath).includes(name)));
  });

  it('an unsupported schema version without release custody is refused untouched: no table, index or trigger, no WAL switch', async () => {
    const dbPath = join(tempDir(), 'foreign-version.db');
    const raw = new Database(dbPath);
    raw.exec(`CREATE TABLE assurance_store_versions (id INTEGER PRIMARY KEY AUTOINCREMENT, schema_version TEXT NOT NULL, migration_state TEXT NOT NULL, recorded_at TEXT NOT NULL);
      INSERT INTO assurance_store_versions (schema_version, migration_state, recorded_at) VALUES ('aoc.assurance-store.schema.v9', 'current', '2026-01-01T00:00:00.000Z');`);
    raw.pragma('user_version = 7');
    raw.close();
    await refusedUnchanged(dbPath, /schema version 'aoc\.assurance-store\.schema\.v9' is not supported/);
    assert.deepEqual(objectNames(dbPath), ['assurance_store_versions']);
  });

  it('an unsupported schema version with release custody is refused with its releases, triggers and rows intact', async () => {
    const { dbPath } = await releasedDatabase();
    const raw = new Database(dbPath);
    raw.prepare(`INSERT INTO assurance_store_versions (schema_version, migration_state, recorded_at) VALUES ('aoc.assurance-store.schema.v2', 'current', '2027-01-01T00:00:00.000Z')`).run();
    raw.close();
    await refusedUnchanged(dbPath, /schema version 'aoc\.assurance-store\.schema\.v2'/);
    assert.equal(rowCount(dbPath), 1);
  });

  it('an unreadable version ledger, a file that is not a database, and a foreign database without a ledger are refused, unchanged', async () => {
    const ledger = join(tempDir(), 'corrupt-ledger.db');
    const raw = new Database(ledger);
    raw.exec(`CREATE TABLE assurance_store_versions (id INTEGER PRIMARY KEY, label TEXT); INSERT INTO assurance_store_versions (label) VALUES ('garbage');`);
    raw.close();
    await refusedUnchanged(ledger, /version ledger is unreadable/);

    const foreign = join(tempDir(), 'foreign-app.db');
    const other = new Database(foreign);
    other.exec(`CREATE TABLE invoices (id TEXT PRIMARY KEY, total REAL); INSERT INTO invoices VALUES ('i-1', 10.5);`);
    other.close();
    await refusedUnchanged(foreign, /no Assurance Store version ledger/);
    assert.deepEqual(objectNames(foreign), ['invoices']);

    const garbage = join(tempDir(), 'not-a-database.db');
    writeFileSync(garbage, Buffer.from('this is not an SQLite database, only bytes '.repeat(200)));
    const bytes = sha256File(garbage);
    await assert.rejects(createSqliteAssuranceStore(garbage), (error: unknown) => error instanceof AssuranceError && error.code === 'ASSURANCE_STORE_UNAVAILABLE' && /not a readable SQLite database/.test(error.message) && !/SQLITE/.test(error.message));
    assert.equal(sha256File(garbage), bytes, 'the bytes are untouched');
  });

  it('a release-custody table of another structure, or one only partially created, is refused -- never repaired, never dropped', async () => {
    const shaped = await releasedDatabase();
    let raw = new Database(shaped.dbPath);
    raw.exec('DROP TABLE assurance_commercial_releases');
    raw.exec(`CREATE TABLE assurance_commercial_releases (report_id TEXT PRIMARY KEY, approved_by TEXT); INSERT INTO assurance_commercial_releases VALUES ('r-1', 'someone');`);
    raw.close();
    await refusedUnchanged(shaped.dbPath, /structure this runtime does not recognize/);

    const partial = await releasedDatabase();
    raw = new Database(partial.dbPath);
    raw.exec('DROP TRIGGER assurance_commercial_releases_no_delete');
    raw.close();
    await refusedUnchanged(partial.dbPath, /only partially created \(missing assurance_commercial_releases_no_delete\)/);
    assert.equal(rowCount(partial.dbPath), 1, 'the kept release is still there');
  });

  it('a failure in the middle of initialization keeps no part of it; once the cause is gone the same file opens and is completed', async () => {
    // An initialization interrupted before it recorded its version (a ledger without rows), on a database written before release custody.
    const { dbPath, assessmentId } = await releasedDatabase();
    let raw = new Database(dbPath);
    raw.exec('DROP TABLE assurance_commercial_releases');
    raw.exec('DELETE FROM assurance_store_versions');
    // The version row is the last write of the initialization: make it fail after the custody objects were created.
    raw.exec(`CREATE TRIGGER rel01a_r1_inject BEFORE INSERT ON assurance_store_versions BEGIN SELECT RAISE(ABORT, 'rel01a-r1 injected'); END`);
    raw.close();
    const before = snapshot(dbPath);
    await assert.rejects(createSqliteAssuranceStore(dbPath), (error: unknown) => {
      assert.ok(error instanceof AssuranceError && error.code === 'ASSURANCE_STORE_UNAVAILABLE', String(error));
      assert.match(error.message, /no part of the initialization was kept/);
      assert.equal(/injected|SQLITE|\//.test(error.message), false, error.message);
      return true;
    });
    const after = JSON.parse(snapshot(dbPath)) as { schema: unknown; tables: unknown; userVersion: unknown };
    const expected = JSON.parse(before) as { schema: unknown; tables: unknown; userVersion: unknown };
    assert.deepEqual([after.schema, after.tables, after.userVersion], [expected.schema, expected.tables, expected.userVersion], 'no custody table, no version row: nothing partial was kept');
    assert.equal(objectNames(dbPath).includes('assurance_commercial_releases'), false);

    raw = new Database(dbPath);
    raw.exec('DROP TRIGGER rel01a_r1_inject');
    raw.close();
    const reopened = await open(dbPath, { startTick: 1_000_000, startId: 100_000 });
    assert.equal((await reopened.service.verifyAssessment(PILOT_ORG_CONTEXT, assessmentId)).valid, true, 'the history is intact');
    assert.ok(CUSTODY_OBJECTS.every((name) => objectNames(dbPath).includes(name)));
    const check = new Database(dbPath, { readonly: true });
    try {
      assert.equal((check.prepare('SELECT count(*) AS n FROM assurance_store_versions').get() as { n: number }).n, 1);
    } finally {
      check.close();
    }
  });
});
