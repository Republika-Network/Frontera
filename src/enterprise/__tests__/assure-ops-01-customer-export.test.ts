import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import { computeDigest } from '../governance-store/digest.js';
import { isAssuranceError } from '../assurance/errors.js';
import {
  COMMERCIAL_REPORT_RELEASE_ROLE,
  buildCommercialReportRelease,
  type CommercialReportContent,
  type CommercialReportDraft,
  type CommercialReportManifest,
  type CommercialReportRelease,
} from '../assurance/commercial-report.js';
import { COMMERCIAL_RELEASE_CUSTODY_VERSION_V1, COMMERCIAL_RELEASE_CUSTODY_VERSION_V2, buildCommercialReleaseCustodyRecord } from '../assurance/commercial-release-custody.js';
import {
  COMMERCIAL_RELEASE_PACKAGE_FILES,
  COMMERCIAL_RELEASE_PACKAGE_MAX_BYTES,
  materializeCommercialReleasePackage,
  type CommercialReleasePackageExport,
} from '../assurance/commercial-release-package.js';
import {
  PILOT_ACKNOWLEDGEMENTS,
  PILOT_ORG,
  PILOT_ORG_CONTEXT,
  PILOT_SYSTEM_CONTEXT,
  buildPilotWorld,
  pilotContext,
  runPilotHappyPath,
  snapshotPilotStore,
  type PilotWorld,
} from './assure-pilot-01-scenario.js';

/**
 * ASSURE-OPS-01 (R-05): the supported customer-package export.
 *
 * The package comes from durable custody only: a release kept since this
 * mission (custody v2) carries the approved content and Markdown; the export
 * assembles them with the kept manifest and release record, verifies the
 * exact bytes against custody with the REL-01A verification, and only then
 * returns them. Nothing is re-drafted. Synthetic data only.
 */

const dirs: string[] = [];
const worlds: PilotWorld[] = [];
after(async () => {
  for (const world of worlds) await world.store.close().catch(() => {});
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'assure-ops-01-r05-'));
  dirs.push(dir);
  return dir;
};
const track = (world: PilotWorld): PilotWorld => {
  worlds.push(world);
  return world;
};

const VERIFIER = join(process.cwd(), 'scripts', 'assurance', 'verify-commercial-package.mjs');
const MATERIALIZER = join(process.cwd(), 'scripts', 'assurance', 'materialize-commercial-package.mjs');
const RENDERER = join(process.cwd(), 'dist', 'src', 'enterprise', 'assurance', 'commercial-report-markdown.js');

const code = (expected: string, reason?: string) => (error: unknown): boolean =>
  isAssuranceError(error) && error.code === expected && (reason === undefined || error.details?.['reason'] === reason);

const sha256 = (bytes: Buffer): string => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const bytesOf = (exported: CommercialReleasePackageExport, path: string): Buffer => Buffer.from(exported.files.find((file) => file.path === path)?.contentBase64 ?? '', 'base64');

async function released(): Promise<{ world: PilotWorld; dbPath: string; draft: CommercialReportDraft; release: CommercialReportRelease }> {
  const dbPath = join(tempDir(), 'assurance.sqlite');
  const world = track(await buildPilotWorld(dbPath));
  const { draft, release } = await runPilotHappyPath(world);
  return { world, dbPath, draft, release };
}

function cli(script: string, args: readonly string[]): { readonly exit: number | null; readonly stdout: string; readonly json: Record<string, unknown> } {
  const run = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 60_000, env: {} });
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(run.stdout) as Record<string, unknown>;
  } catch {
    json = {};
  }
  return { exit: run.status, stdout: run.stdout, json };
}

/** Rewrites the kept custody row at the storage level, as a writer with file access could: drop the update trigger, rewrite, restore it. */
function rewriteCustody(dbPath: string, reportId: string, mutate: (record: Record<string, unknown>) => Record<string, unknown>, options: { readonly recomputeRecordDigest: boolean }): void {
  const raw = new Database(dbPath);
  try {
    const row = raw.prepare('SELECT record_json FROM assurance_commercial_releases WHERE report_id = ?').get(reportId) as { record_json: string };
    const changed = mutate(JSON.parse(row.record_json) as Record<string, unknown>);
    const { recordDigest: _old, ...body } = changed;
    const recordDigest = options.recomputeRecordDigest ? computeDigest(body) : (changed['recordDigest'] as string);
    const trigger = raw.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'assurance_commercial_releases_no_update'").get() as { sql: string };
    raw.exec('DROP TRIGGER assurance_commercial_releases_no_update');
    raw.prepare('UPDATE assurance_commercial_releases SET record_json = ?, record_digest = ? WHERE report_id = ?').run(JSON.stringify({ ...body, recordDigest }), recordDigest, reportId);
    // Put the trigger back, so the store opens the file as its own.
    raw.exec(trigger.sql);
  } finally {
    raw.close();
  }
}

/** A coherent custody record for a new report version, every digest recomputed -- what a direct store writer could forge (REL-01A A10). */
function forgedRecord(draft: CommercialReportDraft, release: CommercialReportRelease, reportVersion: string, limitations: readonly string[]) {
  const reportId = `${draft.content.reportId.replace(/:v[^:]+$/, '')}:v${reportVersion}`;
  const content = { ...draft.content, reportId, limitations } as CommercialReportContent;
  const { manifestDigest: _drop, ...manifestBody } = { ...draft.manifest, reportId, contentDigest: computeDigest(content) };
  const manifest: CommercialReportManifest = { ...manifestBody, manifestDigest: computeDigest(manifestBody) };
  const forgedRelease = buildCommercialReportRelease({ content, markdown: draft.markdown, manifest }, {
    approvedBy: release.approvedBy,
    approverRole: COMMERCIAL_REPORT_RELEASE_ROLE,
    approvedAt: release.approvedAt,
    acknowledgements: PILOT_ACKNOWLEDGEMENTS,
  });
  return buildCommercialReleaseCustodyRecord({ organizationId: PILOT_ORG, manifest, release: forgedRelease, artifacts: { content, markdown: draft.markdown } });
}

describe('ASSURE-OPS-01 R-05 -- customer package export from custody', () => {
  it('R05-01 / R05-08 / R05-11 an authorized export returns the approved bytes exactly, deterministically, read-only, with the authenticity limitation explicit', async () => {
    const { world, dbPath, draft, release } = await released();
    const custodyBefore = new Database(dbPath, { readonly: true });
    const rowBefore = custodyBefore.prepare('SELECT * FROM assurance_commercial_releases').all();
    custodyBefore.close();
    assert.equal((rowBefore[0] as { custody_version: string }).custody_version, COMMERCIAL_RELEASE_CUSTODY_VERSION_V2, 'new releases keep their approved artifacts');

    const byApprover = await world.service.exportCommercialReleasePackage(pilotContext(world, 'approver'), release.reportId);
    const byReviewer = await world.service.exportCommercialReleasePackage(pilotContext(world, 'reviewer'), release.reportId);
    assert.ok(byApprover !== null && byReviewer !== null);
    assert.deepEqual(byReviewer.files, byApprover.files, 'R05-08 deterministic');
    assert.equal(byReviewer.packageDigest, byApprover.packageDigest);
    assert.deepEqual(byApprover.files.map((file) => file.path), [...COMMERCIAL_RELEASE_PACKAGE_FILES]);
    assert.deepEqual(
      Object.fromEntries(byApprover.files.map((file) => [file.path, file.binding])),
      { 'integrity-manifest.json': 'integrity-bound', 'limitations.md': 'informational', 'release-record.json': 'integrity-bound', 'report.json': 'integrity-bound', 'report.md': 'integrity-bound', 'verification-instructions.md': 'informational' },
    );
    for (const file of byApprover.files) {
      const bytes = Buffer.from(file.contentBase64, 'base64');
      assert.equal(file.size, bytes.length);
      assert.equal(file.sha256, sha256(bytes));
    }
    // The approved artifacts, byte for byte / value for value.
    assert.equal(bytesOf(byApprover, 'report.md').equals(Buffer.from(draft.markdown, 'utf8')), true, 'report.md is the approved Markdown, byte for byte');
    assert.deepEqual(JSON.parse(bytesOf(byApprover, 'report.json').toString('utf8')), draft.content);
    assert.deepEqual(JSON.parse(bytesOf(byApprover, 'integrity-manifest.json').toString('utf8')), draft.manifest);
    assert.deepEqual(JSON.parse(bytesOf(byApprover, 'release-record.json').toString('utf8')), release);
    assert.equal(byApprover.authority.status, 'RELEASE_MATCHES_AUTHORITY');
    assert.equal(byApprover.authority.approvedBy, release.approvedBy);
    assert.equal(byApprover.authority.releaseDigest, release.releaseDigest);
    assert.equal(byApprover.externalSignature, 'EXTERNAL_SIGNATURE_NOT_AVAILABLE', 'R05-11');
    assert.match(byApprover.statement, /no digital signature/);
    assert.match(bytesOf(byApprover, 'verification-instructions.md').toString('utf8'), /A digest is not a digital signature/);

    // Read-only: custody is exactly as it was.
    const custodyAfter = new Database(dbPath, { readonly: true });
    assert.deepEqual(custodyAfter.prepare('SELECT * FROM assurance_commercial_releases').all(), rowBefore);
    custodyAfter.close();
  });

  it('R05-02 / R05-03 / R05-04 unauthenticated, role-less, foreign-tenant and unknown exports disclose nothing', async () => {
    const { world, release } = await released();
    const refused = code('ASSURANCE_REVIEWER_UNAUTHORIZED');
    await assert.rejects(world.service.exportCommercialReleasePackage(PILOT_SYSTEM_CONTEXT, release.reportId), refused, 'the system context is not an operator');
    await assert.rejects(world.service.exportCommercialReleasePackage(PILOT_ORG_CONTEXT, release.reportId), refused, 'an organization context without a reviewer credential');
    await assert.rejects(world.service.exportCommercialReleasePackage(pilotContext(world, 'preparer'), release.reportId), refused, 'a credential without an export role');
    const reviewer = pilotContext(world, 'reviewer');
    await assert.rejects(world.service.exportCommercialReleasePackage({ ...reviewer, organizationId: 'pilot-org-other-synthetic' }, release.reportId), refused, 'a context naming another organization');
    assert.equal(await world.service.exportCommercialReleasePackage(pilotContext(world, 'otherReviewer'), release.reportId), null, 'another tenant: absent, exactly as unknown');
    assert.equal(await world.service.exportCommercialReleasePackage(pilotContext(world, 'otherApprover'), release.reportId), null);
    assert.equal(await world.service.exportCommercialReleasePackage(reviewer, 'rn-sv-report:no-such-assessment:v1'), null, 'R05-04 unknown');
  });

  it('R05-05 / R05-06 / R05-07 a custody row altered at the storage level is never exported (content, Markdown, manifest, release; with and without a recomputed record digest)', async () => {
    const cases: readonly (readonly [string, (record: Record<string, unknown>) => Record<string, unknown>])[] = [
      ['content', (record) => ({ ...record, artifacts: { ...(record['artifacts'] as object), content: { ...((record['artifacts'] as Record<string, unknown>)['content'] as object), reportId: 'tampered' } } })],
      ['content score', (record) => {
        const artifacts = record['artifacts'] as Record<string, Record<string, unknown>>;
        return { ...record, artifacts: { ...artifacts, content: { ...artifacts['content'], limitations: ['Tampered after release.'] } } };
      }],
      ['markdown', (record) => ({ ...record, artifacts: { ...(record['artifacts'] as object), markdown: `${String((record['artifacts'] as Record<string, unknown>)['markdown'])}\nAltered after release.\n` } })],
      ['manifest', (record) => ({ ...record, manifest: { ...(record['manifest'] as object), frameworkVersion: '9.9.9' } })],
      ['release', (record) => ({ ...record, release: { ...(record['release'] as object), approvedAt: '2030-01-01T00:00:00.000Z' } })],
    ];
    for (const [label, mutate] of cases) {
      for (const recomputeRecordDigest of [false, true]) {
        const { world, dbPath, release } = await released();
        await world.store.close();
        rewriteCustody(dbPath, release.reportId, mutate, { recomputeRecordDigest });
        const reopened = track(await buildPilotWorld(dbPath, { startTick: 900_000, startId: 90_000 }));
        await assert.rejects(
          reopened.service.exportCommercialReleasePackage(pilotContext(reopened, 'approver'), release.reportId),
          code('ASSURANCE_INTEGRITY_FAILED'),
          `${label} (record digest ${recomputeRecordDigest ? 'recomputed' : 'stale'}) must fail closed`,
        );
        // The custody read itself refuses the row, so no route returns altered artifacts.
        await assert.rejects(reopened.service.getCommercialRelease(PILOT_ORG_CONTEXT, release.reportId), code('ASSURANCE_INTEGRITY_FAILED'), `${label}: a custody read refuses it too`);
      }
    }
  });

  it('R05-09 / R05-10 after a restart the same release exports the same bytes, materialises through the CLI and passes the independent verifier; tampered files are refused', async () => {
    const { world, dbPath, release } = await released();
    const first = await world.service.exportCommercialReleasePackage(pilotContext(world, 'approver'), release.reportId);
    await world.store.close();
    const restarted = track(await buildPilotWorld(dbPath, { startTick: 600_000, startId: 60_000 }));
    const second = await restarted.service.exportCommercialReleasePackage(pilotContext(restarted, 'reviewer'), release.reportId);
    assert.ok(first !== null && second !== null);
    assert.deepEqual(second.files, first.files, 'R05-09 byte-identical after restart');
    assert.equal(second.packageDigest, first.packageDigest);

    const dir = tempDir();
    const exportFile = join(dir, 'export.json');
    writeFileSync(exportFile, JSON.stringify(second));
    const packageDir = join(dir, 'founding-assessment');
    const materialized = cli(MATERIALIZER, [exportFile, '--out', packageDir]);
    assert.equal(materialized.exit, 0, materialized.stdout);
    assert.equal(materialized.json['externalSignature'], 'EXTERNAL_SIGNATURE_NOT_AVAILABLE');
    assert.deepEqual(readdirSync(packageDir).sort(), [...COMMERCIAL_RELEASE_PACKAGE_FILES]);
    for (const file of second.files) assert.equal(sha256(readFileSync(join(packageDir, file.path))), file.sha256, `${file.path} written byte for byte`);

    const storeCopy = join(dir, 'store-copy.sqlite');
    await snapshotPilotStore(restarted, storeCopy);
    const verified = cli(VERIFIER, [packageDir, '--store-copy', storeCopy, '--renderer', RENDERER]);
    assert.equal(verified.exit, 0, verified.stdout.slice(0, 2000));
    assert.match(String(verified.json['verdict']), /^PASS \(files, artifactIntegrity, reportConsistency, approvalConsistency, assessmentConsistency, releaseCustody\); external authenticity NOT DEMONSTRATED$/);
    assert.equal((verified.json['externalAuthenticity'] as Record<string, unknown>)['status'], 'NOT_DEMONSTRATED', 'R05-11 lack of a signature stays explicit');
    assert.match(String(verified.json['storeCopy']), /^UNAUTHENTICATED_COPY/, 'a copied store is comparison material, never the authority');
    // Without the store copy it still passes integrity and consistency, offline.
    assert.equal(cli(VERIFIER, [packageDir]).exit, 0);

    const tampers: readonly (readonly [string, (text: string) => string])[] = [
      ['report.json', (text) => text.replace('"READY_FOR_RELEASE"', '"DRAFT"')],
      ['report.md', (text) => `${text}\nA sentence added after release.\n`],
      ['integrity-manifest.json', (text) => text.replace(/"frameworkVersion": "[^"]+"/, '"frameworkVersion": "9.9.9"')],
      ['release-record.json', (text) => text.replace(/"approvedAt": "[^"]+"/, '"approvedAt": "2030-01-01T00:00:00.000Z"')],
    ];
    for (const [file, tamper] of tampers) {
      const altered = join(dir, `altered-${file}`);
      cpSync(packageDir, altered, { recursive: true });
      const original = readFileSync(join(altered, file), 'utf8');
      const changed = tamper(original);
      assert.notEqual(changed, original, `the ${file} tamper changes something`);
      writeFileSync(join(altered, file), changed);
      assert.equal(cli(VERIFIER, [altered, '--store-copy', storeCopy]).exit, 1, `the verifier refuses a tampered ${file}`);
      // And the Host's authority refuses it too.
      const delivered = {
        content: JSON.parse(readFileSync(join(altered, 'report.json'), 'utf8')) as unknown,
        markdown: readFileSync(join(altered, 'report.md'), 'utf8'),
        manifest: JSON.parse(readFileSync(join(altered, 'integrity-manifest.json'), 'utf8')) as CommercialReportManifest,
        release: JSON.parse(readFileSync(join(altered, 'release-record.json'), 'utf8')) as CommercialReportRelease,
      };
      assert.equal((await restarted.service.verifyCommercialRelease(PILOT_ORG_CONTEXT, delivered)).releaseAuthenticated, false, `custody refuses a tampered ${file}`);
    }
  });

  it('R05-12 without durable custody, or with the store closed, export fails closed (store unavailable)', async () => {
    const memory = track(await buildPilotWorld('', { inMemory: true }));
    await assert.rejects(memory.service.exportCommercialReleasePackage(pilotContext(memory, 'approver'), 'rn-sv-report:synthetic-absent:v1'), code('ASSURANCE_STORE_UNAVAILABLE'));
    const { world, release } = await released();
    await world.store.close();
    await assert.rejects(world.service.exportCommercialReleasePackage(pilotContext(world, 'approver'), release.reportId), code('ASSURANCE_STORE_UNAVAILABLE'));
  });

  it('R05-13 an oversized package is refused, not truncated; A10 KNOWN LIMITATION -- a coherent forgery written directly into custody is exported (custody is the issuer’s record, not non-repudiation)', async () => {
    const { world, draft, release } = await released();
    const huge = forgedRecord(draft, release, '9', ['x'.repeat(COMMERCIAL_RELEASE_PACKAGE_MAX_BYTES)]);
    await world.store.commitCommercialRelease?.(PILOT_ORG_CONTEXT, huge);
    await assert.rejects(world.service.exportCommercialReleasePackage(pilotContext(world, 'approver'), huge.reportId), code('ASSURANCE_RELEASE_NOT_EXPORTABLE', 'package_too_large'));

    const coherent = forgedRecord(draft, release, '8', ['A limitation a direct store writer invented.']);
    await world.store.commitCommercialRelease?.(PILOT_ORG_CONTEXT, coherent);
    const exported = await world.service.exportCommercialReleasePackage(pilotContext(world, 'approver'), coherent.reportId);
    assert.equal(exported?.authority.status, 'RELEASE_MATCHES_AUTHORITY', 'undetected, as REL-01A A10 documents: whoever can write the store can write history');
    assert.equal(exported?.externalSignature, 'EXTERNAL_SIGNATURE_NOT_AVAILABLE');
  });

  it('a release kept before artifact custody (v1) still verifies but is not exportable', async () => {
    const { world, draft, release } = await released();
    const legacyContent = { ...draft.content, reportId: draft.content.reportId.replace(/:v[^:]+$/, ':v7') } as CommercialReportContent;
    const { manifestDigest: _drop, ...manifestBody } = { ...draft.manifest, reportId: legacyContent.reportId, contentDigest: computeDigest(legacyContent) };
    const manifest: CommercialReportManifest = { ...manifestBody, manifestDigest: computeDigest(manifestBody) };
    const legacyRelease = buildCommercialReportRelease({ content: legacyContent, markdown: draft.markdown, manifest }, { approvedBy: release.approvedBy, approverRole: COMMERCIAL_REPORT_RELEASE_ROLE, approvedAt: release.approvedAt, acknowledgements: PILOT_ACKNOWLEDGEMENTS });
    const legacy = buildCommercialReleaseCustodyRecord({ organizationId: PILOT_ORG, manifest, release: legacyRelease });
    assert.equal(legacy.custodyVersion, COMMERCIAL_RELEASE_CUSTODY_VERSION_V1);
    await world.store.commitCommercialRelease?.(PILOT_ORG_CONTEXT, legacy);
    await assert.rejects(world.service.exportCommercialReleasePackage(pilotContext(world, 'approver'), legacy.reportId), code('ASSURANCE_RELEASE_NOT_EXPORTABLE', 'artifacts_not_in_custody'));
    const verdict = await world.service.verifyCommercialRelease(PILOT_ORG_CONTEXT, { content: legacyContent, markdown: draft.markdown, manifest, release: legacyRelease });
    assert.equal(verdict.releaseAuthenticated, true, 'a v1 release keeps verifying against custody');
  });

  it('R05-14 materialisation refuses traversal, foreign names, duplicates, missing files, non-canonical base64, digest mismatches and oversize -- in the module and in the CLI, writing nothing', async () => {
    const { world, release } = await released();
    const exported = await world.service.exportCommercialReleasePackage(pilotContext(world, 'approver'), release.reportId);
    assert.ok(exported !== null);
    const files = exported.files;
    const first = files[0]!;
    const hostile: readonly (readonly [string, unknown[]])[] = [
      ['traversal', [...files.slice(1), { ...first, path: '../report.md' }]],
      ['absolute path', [...files.slice(1), { ...first, path: '/etc/report.md' }]],
      ['nested path', [...files.slice(1), { ...first, path: 'sub/integrity-manifest.json' }]],
      ['foreign name', [...files, { ...first, path: 'run-me.sh' }]],
      ['duplicate', [...files, first]],
      ['missing file', files.slice(1)],
      ['non-canonical base64', [{ ...first, contentBase64: `${first.contentBase64}\n` }, ...files.slice(1)]],
      ['digest mismatch', [{ ...first, sha256: `sha256:${'0'.repeat(64)}` }, ...files.slice(1)]],
      ['size mismatch', [{ ...first, size: first.size + 1 }, ...files.slice(1)]],
      ['oversize', [{ ...first, contentBase64: Buffer.alloc(COMMERCIAL_RELEASE_PACKAGE_MAX_BYTES + 1).toString('base64') }, ...files.slice(1)]],
    ];
    assert.equal(materializeCommercialReleasePackage(files).length, 6, 'the genuine export materialises');
    for (const [label, entries] of hostile) {
      assert.throws(() => materializeCommercialReleasePackage(entries), Error, label);
      const dir = tempDir();
      const exportFile = join(dir, 'export.json');
      writeFileSync(exportFile, JSON.stringify({ ...exported, files: entries }));
      const out = join(dir, 'out');
      const run = cli(MATERIALIZER, [exportFile, '--out', out]);
      assert.equal(run.exit, 1, `${label}: ${run.stdout}`);
      assert.equal(existsSync(out) && readdirSync(out).length > 0, false, `${label}: nothing was written`);
      assert.equal(existsSync(join(dir, 'report.md')), false, `${label}: nothing escaped the output directory`);
    }
    // A non-empty output directory is never overwritten.
    const dir = tempDir();
    writeFileSync(join(dir, 'export.json'), JSON.stringify(exported));
    writeFileSync(join(dir, 'keep.txt'), 'operator file');
    assert.equal(cli(MATERIALIZER, [join(dir, 'export.json'), '--out', dir]).exit, 1);
    assert.equal(readFileSync(join(dir, 'keep.txt'), 'utf8'), 'operator file');
  });
});
