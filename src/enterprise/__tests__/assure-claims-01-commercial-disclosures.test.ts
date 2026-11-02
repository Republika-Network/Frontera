import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { computeDigest } from '../governance-store/digest.js';
import { isAssuranceError } from '../assurance/errors.js';
import { renderCommercialReportMarkdown } from '../assurance/commercial-report-markdown.js';
import {
  COMMERCIAL_REPORT_GENERATOR_V1,
  COMMERCIAL_REPORT_GENERATOR_V2,
  COMMERCIAL_REPORT_GENERATOR_V3,
  COMMERCIAL_REPORT_GENERATOR_VERSIONS,
  DISCLOSURE_WORDING_V1_V2,
  DISCLOSURE_WORDING_V3,
  disclosureWording,
} from '../assurance/commercial-report-format.js';
import {
  COMMERCIAL_REPORT_GENERATOR_VERSION,
  COMMERCIAL_REPORT_RELEASE_ROLE,
  buildCommercialReportRelease,
  verifyCommercialReport,
  type CommercialReportContent,
  type CommercialReportDraft,
  type CommercialReportRelease,
} from '../assurance/commercial-report.js';
import { buildCommercialReleaseCustodyRecord, type CommercialReleasePackage } from '../assurance/commercial-release-custody.js';
import { COMMERCIAL_RELEASE_PACKAGE_FILES, commercialPackageVerificationInstructions, materializeCommercialReleasePackage } from '../assurance/commercial-release-package.js';
import { RN_SV_FRAMEWORK_V0_1 } from '../assurance/frameworks/rn-sv-framework.js';
import { asHistoricalDraft } from './commercial-report-historical.js';
import {
  PILOT_ACKNOWLEDGEMENTS,
  PILOT_ENGAGEMENT,
  PILOT_ISSUE,
  PILOT_ORG,
  PILOT_ORG_CONTEXT,
  buildPilotWorld,
  pilotContext,
  preparePilotAssessment,
  releasePilotReport,
  reviewPilotAssessment,
  snapshotPilotStore,
  writePilotPackage,
  type PilotWorld,
} from './assure-pilot-01-scenario.js';
import { call, createWorkspace, type Reply } from './ctrl02-host-fixture.js';
import { REL01D_AUTH, REL01D_IDS, bootRel01d, completedAssessmentOverHttp, draftBody, rel01dEnv, releaseBody, snapshotSqlite } from './assure-rel-01d-host-fixture.js';

/**
 * ASSURE-CLAIMS-01 -- commercial claims integrity and report disclosure.
 *
 * GF-01: generators v1 and v2 told the customer that the internal release
 * approver "act[s] as" the controlled review the rn.sv@0.1.0 commercial-use
 * restriction requires. GF-06 / C9: customer drafts claimed independence and
 * "proof". Generator v3 and the corrected drafts keep apart internal review,
 * internal release approval, external review and commercial authorization.
 *
 * The assertions are semantic: text is normalised (Markdown escapes and
 * emphasis removed, whitespace collapsed) and judged per sentence, so a
 * reflowed paragraph passes and a reintroduced claim fails wherever it
 * appears. Synthetic data only; nothing here authorizes commercial use.
 * See docs/security/ASSURE-CLAIMS-01-REPORT-DISCLOSURE-INTEGRITY.md.
 */

const ROOT = process.cwd();
const VERIFIER = join(ROOT, 'scripts', 'assurance', 'verify-commercial-package.mjs');
const MATERIALIZER = join(ROOT, 'scripts', 'assurance', 'materialize-commercial-package.mjs');
const RENDERER = join(ROOT, 'dist', 'src', 'enterprise', 'assurance', 'commercial-report-markdown.js');
const HISTORICAL = join(ROOT, 'docs', 'enterprise', 'examples', 'historical');
const COMMERCIAL = join(ROOT, 'docs', 'commercial', 'founding-assessment');

const dirs: string[] = [];
const worlds: PilotWorld[] = [];
const workspace = createWorkspace('frontera-claims01-');
after(async () => {
  for (const world of worlds) await world.store.close().catch(() => {});
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  workspace.close();
});
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'assure-claims-01-'));
  dirs.push(dir);
  return dir;
};

// ---------------------------------------------------------------------------
// Semantic text helpers
// ---------------------------------------------------------------------------

/** Plain prose: Markdown escapes, emphasis, code ticks and quote markers removed; whitespace collapsed. */
function prose(text: string): string {
  return text
    .replace(/\\(.)/g, '$1')
    .replace(/[*_`]/g, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}
/** Sentences of `prose(text)`; table cells and list items end sentences too. */
function sentences(text: string): string[] {
  return prose(text.replace(/\|/g, '.\n').replace(/^\s*[-*]\s+/gm, '.\n'))
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 1);
}
const NEGATION = /\b(not|no|never|none|nor|without|cannot|absent|neither)\b|\bnon-/i;

/** GF-01: internal approval presented as the framework's controlled or external review, or an external review claimed. */
const REVIEW_CONFLATION =
  /act as (?:that|the|its) (?:controlled )?review|acts? as (?:the|its|that) controlled review|(?:external|independent|third[- ]party) review(?:er)? (?:was|has been) (?:performed|completed|obtained)|independently (?:reviewed|audited|certified|verified)|reviewed by an? (?:external|independent|third[- ]party)|third[- ]party reviewed|external(?:ly)? (?:reviewer )?sign(?:ed)?[- ]?off/i;
/** GF-06 / C9: an independence or proof promise. */
const OVERCLAIM = /\bprove it\b|\bproof of (?:sovereignty|posture|security)\b|\bindependent,? evidence-based\b|\bindependent sign-?off\b|\bindependent of the reviewers\b|\bindependent approval\b|\bapprover independently releases\b|\bindependently releases\b|\bguaranteed? (?:sovereignty|security|compliance)\b|\bcryptographically (?:authentic|proven|authenticated)\b|\bcertified (?:by|as)\b|\baccredited (?:by|as)\b|\b(?:full|complete|total) independence\b/i;
/** Every sentence calling something independent names its axis, or denies it. (The noun "independence" as a topic, e.g. a heading, is not a claim; "full independence" is caught by OVERCLAIM.) */
function unqualifiedIndependence(text: string): string[] {
  // A label ("Independence.") is not a claim; a sentence is judged when it says something.
  return sentences(text).filter((sentence) => sentence.split(' ').length > 3 && /\bindependent(?:ly)?\b/i.test(sentence) && !NEGATION.test(sentence) && !/independent of (?:your|the assessed|the customer'?s?) organi[sz]ation/i.test(sentence) && !/independent controller/i.test(sentence));
}
/** Sentences that affirm `pattern` (no negation in the same sentence). */
const affirming = (text: string, pattern: RegExp): string[] => sentences(text).filter((sentence) => pattern.test(sentence) && !NEGATION.test(sentence));

const sha256 = (data: string | Buffer): string => `sha256:${createHash('sha256').update(data).digest('hex')}`;
const read = (...path: string[]): string => readFileSync(join(...path), 'utf8');

function runVerifier(dir: string, args: readonly string[] = []): { readonly exit: number | null; readonly output: Record<string, unknown> } {
  const run = spawnSync(process.execPath, [VERIFIER, dir, ...args], { encoding: 'utf8', timeout: 60_000, env: {} });
  let output: Record<string, unknown> = {};
  try {
    output = JSON.parse(run.stdout) as Record<string, unknown>;
  } catch {
    output = { verdict: `unparseable (exit ${String(run.status)}): ${run.stderr.slice(0, 300)}` };
  }
  return { exit: run.status, output };
}
const consistency = (output: Record<string, unknown>): Record<string, unknown> => (output['reportConsistency'] ?? {}) as Record<string, unknown>;

async function readyWorld(): Promise<{ readonly world: PilotWorld; readonly dbPath: string; readonly assessmentId: string; readonly draft: CommercialReportDraft }> {
  const dbPath = join(tempDir(), 'assurance.sqlite');
  const world = await buildPilotWorld(dbPath);
  worlds.push(world);
  const prepared = await preparePilotAssessment(world);
  await reviewPilotAssessment(world, prepared.assessmentId);
  await world.service.completeAssessment(PILOT_ORG_CONTEXT, prepared.assessmentId);
  const draft = await world.service.buildCommercialReportDraft(PILOT_ORG_CONTEXT, prepared.assessmentId, { engagement: PILOT_ENGAGEMENT, issue: PILOT_ISSUE });
  return { world, dbPath, assessmentId: prepared.assessmentId, draft };
}
/** The generator-authored disclosure of a content: what the issuer says, as opposed to what the customer declared. */
const authored = (content: CommercialReportContent): string => JSON.stringify({ integrity: content.integrity, methodology: content.methodology, limitations: content.limitations, readiness: content.readiness });

/** Pinned identities of the historical examples, read from `origin/main` before ASSURE-CLAIMS-01. */
const HISTORICAL_PINS = {
  v1: {
    generator: COMMERCIAL_REPORT_GENERATOR_V1,
    files: {
      json: 'sha256:9e218a1ca09c778430f51fbd94f3b1409653a4e4bf67de87829c40eaf91aa8ba',
      'manifest.json': 'sha256:aa6573becf2669abc6a85e4b755c1a7c5c3cb81931d9a2c73c7940d12cef9339',
      md: 'sha256:ca94949699b7f40155b345843aadd2eaf8e0563bbf2cab5519b9668bceeba15d',
      'release.json': 'sha256:3ce7532bbc1f5cb4427dd1740b641ad5c7aafa2af232666c6fbb418dfcbbc99e',
    },
    contentDigest: 'sha256:00e43f33c28c92e044bd9bebd500be72d1c7bd2dc6941383406d04c0fbca25eb',
    markdownDigest: 'sha256:ca94949699b7f40155b345843aadd2eaf8e0563bbf2cab5519b9668bceeba15d',
    manifestDigest: 'sha256:f4da981cc3f19c6456f1cedf94cd90d447a7f5bc8a42ffae834780ab875009eb',
    releaseDigest: 'sha256:cb7cbcf74d90f99b67ae6c08f73c87ce65bc0df382d4eb734a2682cd9b639625',
  },
  v2: {
    generator: COMMERCIAL_REPORT_GENERATOR_V2,
    files: {
      json: 'sha256:4dedc99644b946587c183ec8f73e631aed463fcdc65ddd4b9569f5e4058dee0d',
      'manifest.json': 'sha256:7fe7425b8880a134dd274cc03daf83daf9837b020b9b53d5afc32ea6f65113a3',
      md: 'sha256:631d348edf969ab5e97e350df4ec2d26e70f8e758e44c1d27f3c375ccf012644',
      'release.json': 'sha256:b1a11e6e62f41b32b998e5d8868e03eb856ebdcc63b44641cd1b84817e2e5bdf',
    },
    contentDigest: 'sha256:8bb6a5b6471dff3e2674376a2e53fde689f9686b3e21c89e8c0270c801f5edaa',
    markdownDigest: 'sha256:631d348edf969ab5e97e350df4ec2d26e70f8e758e44c1d27f3c375ccf012644',
    manifestDigest: 'sha256:1eceb8e1f1f7e3ebc84fd13aa4f04da96dd6b578c10f299fddc710c90ad4155e',
    releaseDigest: 'sha256:d3fc0564a7c4efd27535fa86a019d9061b3b35a76eda50355173ed3b7c74f03e',
  },
} as const;

function historicalPackage(version: 'v1' | 'v2'): string {
  const dir = join(tempDir(), `${version}-package`);
  mkdirSync(dir, { recursive: true });
  for (const [from, to] of [['md', 'report.md'], ['json', 'report.json'], ['manifest.json', 'integrity-manifest.json'], ['release.json', 'release-record.json']] as const) {
    cpSync(join(HISTORICAL, `rn-sv-founding-assessment.synthetic.${version}.${from}`), join(dir, to));
  }
  return dir;
}

/** A package whose content was edited and every digest recomputed: integrity-consistent, so only a semantic check can refuse it. */
function resealed(draft: CommercialReportDraft, release: CommercialReportRelease, content: CommercialReportContent): string {
  const markdown = renderCommercialReportMarkdown(content);
  const { manifestDigest: _m, ...body } = { ...draft.manifest, contentDigest: computeDigest(content), markdownDigest: sha256(markdown) };
  const manifest = { ...body, manifestDigest: computeDigest(body) };
  const { releaseDigest: _r, ...releaseBody } = { ...release, contentDigest: manifest.contentDigest, markdownDigest: manifest.markdownDigest, manifestDigest: manifest.manifestDigest };
  const dir = join(tempDir(), 'resealed');
  writePilotPackage(dir, { content, markdown, manifest }, { ...releaseBody, releaseDigest: computeDigest(releaseBody) });
  return dir;
}

// ===========================================================================
// GF-01 -- the report generator
// ===========================================================================

describe('ASSURE-CLAIMS-01 GF-01 -- newly generated reports keep internal review, internal approval, external review and commercial authorization apart', () => {
  it('G01-01 a new report never claims that internal approval is, or satisfies, the controlled or external review', async () => {
    const { draft } = await readyWorld();
    assert.equal(draft.content.readiness.status, 'READY_FOR_RELEASE');
    assert.equal(REVIEW_CONFLATION.test(prose(draft.markdown)), false, 'no conflation anywhere in the Markdown');
    assert.equal(REVIEW_CONFLATION.test(authored(draft.content)), false, 'no conflation in the generator-authored content');
    const statement = draft.content.integrity.commercialUse.statement;
    assert.match(statement, /Internal review and internal release approval do not constitute an independent external review/);
    assert.match(statement, /do not remove the framework’s commercial-use restriction/);
    assert.match(prose(draft.markdown), /Internal review and internal release approval do not constitute an independent external review/, 'the Markdown says what the JSON says');
    // The old v1/v2 sentence is detected by the same check (negative control for the regex).
    assert.equal(REVIEW_CONFLATION.test(DISCLOSURE_WORDING_V1_V2.commercialUseStatement), true);
  });

  it('G01-01b the independent verifier refuses a v3 package whose GF-01 wording was put back, even with every digest recomputed', async () => {
    const { world, assessmentId } = await readyWorld();
    const { draft, release } = await releasePilotReport(world, assessmentId);
    const regressed: CommercialReportContent = { ...draft.content, integrity: { ...draft.content.integrity, commercialUse: { ...draft.content.integrity.commercialUse, statement: DISCLOSURE_WORDING_V1_V2.commercialUseStatement } } };
    const run = runVerifier(resealed(draft, release, regressed));
    assert.equal(run.exit, 1, String(run.output['verdict']));
    assert.equal(consistency(run.output)['internal approval not presented as external or controlled review (v3)'], false);
    assert.equal(consistency(run.output)['states internal approval is not an independent external review (v3)'], false);
    const unsigned: CommercialReportContent = { ...draft.content, integrity: { ...draft.content.integrity, limitation: DISCLOSURE_WORDING_V1_V2.integrityLimitation } };
    assert.equal(consistency(runVerifier(resealed(draft, release, unsigned)).output)['states the report is not digitally signed (v3)'], false);
  });

  it('G01-02 the internal reviewer, the internal approver, an external reviewer and commercial authorization are distinct concepts; no caller can make the report claim an external review', async () => {
    const { world, assessmentId, draft } = await readyWorld();
    const statement = sentences(draft.content.integrity.commercialUse.statement);
    const has = (pattern: RegExp): string | undefined => statement.find((sentence) => pattern.test(sentence));
    const reviewers = has(/conclusions in this report are recorded by authenticated reviewers/);
    const approver = has(/separate authorized Republika approver whose credential recorded none of those conclusions/);
    const external = has(/No external review of this assessment is recorded/);
    const authorization = has(/Authorizing the framework for commercial use is a separate governance decision/);
    assert.ok(reviewers && approver && external && authorization, 'A, B, C and D are each stated');
    assert.equal(new Set([reviewers, approver, external, authorization]).size, 4, 'in four separate sentences, none standing for another');
    assert.match(draft.content.methodology.steps.at(-1) ?? '', /This is internal release approval, not an external review\./);

    // No input names an external review: extra fields in the engagement or the issue change nothing, and no such field exists.
    const asserted = await world.service.buildCommercialReportDraft(PILOT_ORG_CONTEXT, assessmentId, {
      engagement: { ...PILOT_ENGAGEMENT, externalReview: true, externalReviewer: 'Synthetic Audit LLP', independentReview: { performed: true } } as typeof PILOT_ENGAGEMENT,
      issue: { ...PILOT_ISSUE, externalReview: true } as typeof PILOT_ISSUE,
    });
    assert.equal(asserted.manifest.contentDigest, draft.manifest.contentDigest, 'a client-set external-review flag has no effect on the report');
    assert.equal(/externalReview|independentReview|Synthetic Audit/i.test(JSON.stringify(asserted.content)), false);
    const fieldNames = JSON.stringify(Object.keys(draft.content.integrity)) + JSON.stringify(Object.keys(draft.content));
    assert.equal(/external/i.test(fieldNames), false, 'the report schema has no external-review field to set');
  });

  it('G01-03 in the synthetic default case no external review, auditor or third-party sign-off is claimed anywhere in the delivered report', async () => {
    const { draft } = await readyWorld();
    const text = `${prose(draft.markdown)}\n${authored(draft.content)}`;
    assert.equal(REVIEW_CONFLATION.test(text), false);
    // Every mention of external review is a denial -- except the framework's own restriction, which names the review it requires.
    assert.deepEqual(
      affirming(draft.markdown, /\b(external|independent|third[- ]party) (review|reviewer|auditor|audit|attestation)\b/i).filter((sentence) => !/restricted pending controlled external review/.test(sentence)),
      [],
    );
    assert.ok(draft.content.limitations.includes(DISCLOSURE_WORDING_V3.whoPerformsLimitation ?? '<missing>'));
    assert.match(prose(draft.markdown), /No external auditor or independent reviewer has reviewed it\./);
    assert.match(prose(draft.markdown), /independent of the assessed organization, not of the framework author or the tooling operator/);
  });

  it('G01-04 the commercial-use restriction stays visible in the cover integrity table, the statement, the release acknowledgement and the limitations extract', async () => {
    const { world, assessmentId, draft } = await readyWorld();
    assert.equal(draft.content.integrity.commercialUse.frameworkStatus, 'restricted');
    assert.match(draft.markdown, /\| Framework commercial use \| restricted \|/);
    assert.match(draft.content.integrity.commercialUse.statement, /records commercial use of rn\.sv@0\.1\.0 as restricted pending controlled external review/);
    assert.match(draft.content.integrity.commercialUse.statement, /does not state that the restriction has been satisfied or lifted/);
    const { release } = await releasePilotReport(world, assessmentId);
    assert.equal(release.acknowledgements.commercialUseRestrictionAcknowledged, true, 'release still requires the acknowledgement (semantics unchanged)');
    assert.match(release.statement, /commercial-use restriction/);
    const exported = await world.service.exportCommercialReleasePackage(pilotContext(world, 'approver'), release.reportId);
    const limitations = Buffer.from(exported?.files.find((file) => file.path === 'limitations.md')?.contentBase64 ?? '', 'base64').toString('utf8');
    assert.match(limitations, /No external auditor or independent reviewer has reviewed it\./);
  });

  it('G01-05 new reports and manifests carry generator v3; the known-version list keeps v1 and v2; the wording follows the version', async () => {
    const { draft } = await readyWorld();
    assert.equal(COMMERCIAL_REPORT_GENERATOR_VERSION, COMMERCIAL_REPORT_GENERATOR_V3);
    assert.equal(COMMERCIAL_REPORT_GENERATOR_V3, 'aoc.assurance.commercial-report.v3');
    assert.equal(draft.content.integrity.generatorVersion, COMMERCIAL_REPORT_GENERATOR_V3);
    assert.equal(draft.manifest.generatorVersion, COMMERCIAL_REPORT_GENERATOR_V3);
    assert.match(draft.markdown, /\| Generator \| aoc\\\.assurance\\\.commercial\\-report\\\.v3 \|/);
    assert.deepEqual([...COMMERCIAL_REPORT_GENERATOR_VERSIONS], [COMMERCIAL_REPORT_GENERATOR_V1, COMMERCIAL_REPORT_GENERATOR_V2, COMMERCIAL_REPORT_GENERATOR_V3]);
    assert.equal(disclosureWording(COMMERCIAL_REPORT_GENERATOR_V3), DISCLOSURE_WORDING_V3);
    assert.equal(disclosureWording(COMMERCIAL_REPORT_GENERATOR_V2), DISCLOSURE_WORDING_V1_V2);
    assert.equal(draft.content.integrity.commercialUse.statement, DISCLOSURE_WORDING_V3.commercialUseStatement);
    assert.equal(draft.content.integrity.limitation, DISCLOSURE_WORDING_V3.integrityLimitation);
  });

  for (const version of ['v1', 'v2'] as const) {
    it(`G01-0${version === 'v1' ? '6' : '7'} the historical ${version} report is byte-identical: file bytes and every digest equal the values pinned from origin/main`, () => {
      const pins = HISTORICAL_PINS[version];
      for (const [suffix, expected] of Object.entries(pins.files)) {
        assert.equal(sha256(readFileSync(join(HISTORICAL, `rn-sv-founding-assessment.synthetic.${version}.${suffix}`))), expected, `${version}.${suffix} bytes unchanged`);
      }
      const content = JSON.parse(read(HISTORICAL, `rn-sv-founding-assessment.synthetic.${version}.json`)) as CommercialReportContent;
      const markdown = read(HISTORICAL, `rn-sv-founding-assessment.synthetic.${version}.md`);
      const manifest = JSON.parse(read(HISTORICAL, `rn-sv-founding-assessment.synthetic.${version}.manifest.json`)) as CommercialReportDraft['manifest'];
      const release = JSON.parse(read(HISTORICAL, `rn-sv-founding-assessment.synthetic.${version}.release.json`)) as CommercialReportRelease;
      assert.equal(content.integrity.generatorVersion, pins.generator);
      assert.equal(computeDigest(content), pins.contentDigest);
      assert.equal(sha256(markdown), pins.markdownDigest);
      assert.equal(manifest.manifestDigest, pins.manifestDigest);
      assert.equal(release.releaseDigest, pins.releaseDigest);
      assert.equal(renderCommercialReportMarkdown(content), markdown, 'today’s renderer reproduces the historical bytes');
      assert.equal(verifyCommercialReport({ content, markdown, manifest, release }).valid, true);
      assert.match(markdown, /act as that review/, 'the historical GF-01 wording is preserved, not rewritten');
    });
  }

  it('G01-08 the historical v1 and v2 packages pass the independent verifier, which names their format and their historical review wording', () => {
    for (const version of ['v1', 'v2'] as const) {
      const run = runVerifier(historicalPackage(version));
      assert.equal(run.exit, 0, `${version}: ${String(run.output['verdict'])}`);
      assert.match(String(run.output['verdict']), /^PASS \(files, artifactIntegrity, reportConsistency, approvalConsistency\); external authenticity NOT DEMONSTRATED$/);
      assert.match(String(run.output['reviewDisclosure']), /historical wording, GF-01/);
      assert.match(String(run.output['reviewDisclosure']), /internal approval, not an independent external review/);
      assert.equal('internal approval not presented as external or controlled review (v3)' in consistency(run.output), false, 'v3 checks apply to v3 only');
    }
  });

  it('G01-09 a v2 release kept before the upgrade stays authentic against custody and exportable; it is never reissued as v3; a new v3 release commits and verifies', async () => {
    const { world, assessmentId, draft } = await readyWorld();
    const v2 = asHistoricalDraft(draft, COMMERCIAL_REPORT_GENERATOR_V2);
    const v2Release = buildCommercialReportRelease(v2, { approvedBy: 'pilot-approver', approverRole: COMMERCIAL_REPORT_RELEASE_ROLE, approvedAt: '2026-10-28T09:30:00.000Z', acknowledgements: PILOT_ACKNOWLEDGEMENTS });
    const commit = world.store.commitCommercialRelease;
    assert.ok(commit);
    const record = buildCommercialReleaseCustodyRecord({ organizationId: PILOT_ORG, manifest: v2.manifest, release: v2Release, artifacts: { content: v2.content, markdown: v2.markdown } });
    assert.equal((await commit.call(world.store, PILOT_ORG_CONTEXT, record)).outcome, 'committed');
    const kept: CommercialReleasePackage = { content: v2.content, markdown: v2.markdown, manifest: v2.manifest, release: v2Release };
    const verdict = await world.service.verifyCommercialRelease(PILOT_ORG_CONTEXT, kept);
    assert.equal(verdict.releaseAuthenticated, true, 'the v2 release keeps its identity after the generator upgrade');
    const exported = await world.service.exportCommercialReleasePackage(pilotContext(world, 'approver'), v2Release.reportId);
    assert.equal(Buffer.from(exported?.files.find((file) => file.path === 'report.md')?.contentBase64 ?? '', 'base64').toString('utf8'), v2.markdown, 'exported from custody exactly as approved (v2 wording)');
    const request = { engagement: PILOT_ENGAGEMENT, issue: PILOT_ISSUE, acknowledgements: PILOT_ACKNOWLEDGEMENTS };
    await assert.rejects(
      world.service.releaseCommercialReport(pilotContext(world, 'approver'), assessmentId, { ...request, approvedContentDigest: draft.manifest.contentDigest }),
      (error: unknown) => isAssuranceError(error) && error.code === 'ASSURANCE_ASSESSMENT_IMMUTABLE',
      'approving today’s v3 draft under the released version is a different report: refused',
    );
    assert.deepEqual((await world.service.getCommercialRelease(PILOT_ORG_CONTEXT, v2Release.reportId))?.release, v2Release, 'custody untouched');

    // A new report version is released under v3, into the same custody.
    const v3Request = { engagement: PILOT_ENGAGEMENT, issue: { ...PILOT_ISSUE, reportVersion: '1.1' } };
    const v3Draft = await world.service.buildCommercialReportDraft(PILOT_ORG_CONTEXT, assessmentId, v3Request);
    const v3 = await world.service.releaseCommercialReport(pilotContext(world, 'approver'), assessmentId, { ...v3Request, approvedContentDigest: v3Draft.manifest.contentDigest, acknowledgements: PILOT_ACKNOWLEDGEMENTS });
    assert.equal(v3.custody.outcome, 'committed');
    assert.equal(v3.draft.manifest.generatorVersion, COMMERCIAL_REPORT_GENERATOR_V3);
    assert.equal((await world.service.verifyCommercialRelease(PILOT_ORG_CONTEXT, { ...v3.draft, release: v3.release })).releaseAuthenticated, true);
    assert.equal(v3.release.releaseVersion, v2Release.releaseVersion, 'the release-record format is unchanged');
    assert.deepEqual(Object.keys(v3.release).sort(), Object.keys(v2Release).sort(), 'release-record fields unchanged');
  });

  it('G01-10 a v3 package exported through OPS-01 and materialised passes the independent verifier with the store copy and the renderer, including the v3 disclosure checks', async () => {
    const { world, assessmentId } = await readyWorld();
    const { release } = await releasePilotReport(world, assessmentId);
    const exported = await world.service.exportCommercialReleasePackage(pilotContext(world, 'approver'), release.reportId);
    assert.ok(exported !== null);
    const dir = join(tempDir(), 'founding-assessment');
    mkdirSync(dir, { recursive: true });
    for (const file of materializeCommercialReleasePackage(exported.files)) writeFileSync(join(dir, file.path), file.bytes);
    assert.deepEqual(readdirSync(dir).sort(), [...COMMERCIAL_RELEASE_PACKAGE_FILES]);
    const storeCopy = join(tempDir(), 'store-copy.sqlite');
    await snapshotPilotStore(world, storeCopy);
    const run = runVerifier(dir, ['--store-copy', storeCopy, '--renderer', RENDERER]);
    assert.equal(run.exit, 0, String(run.output['verdict']));
    assert.match(String(run.output['verdict']), /^PASS \(files, artifactIntegrity, reportConsistency, approvalConsistency, assessmentConsistency, releaseCustody\); external authenticity NOT DEMONSTRATED$/);
    for (const name of ['report makes no claim about its own release (v3)', 'internal approval not presented as external or controlled review (v3)', 'states internal approval is not an independent external review (v3)', 'states the report is not digitally signed (v3)', 'known report format']) {
      const value = consistency(run.output)[name];
      assert.equal(typeof value === 'object' && value !== null ? (value as { ok: boolean }).ok : value, true, name);
    }
    assert.match(String(run.output['reviewDisclosure']), /^aoc\.assurance\.commercial-report\.v3: /);
  });

  it('G01-11 internal approval does not authorize commercial use: after release the framework stays restricted and frozen, and nothing in the release or report says otherwise', async () => {
    const { world, assessmentId } = await readyWorld();
    const { draft, release } = await releasePilotReport(world, assessmentId);
    const commercialUse = (RN_SV_FRAMEWORK_V0_1.metadata?.['commercialUse'] ?? {}) as { status?: string };
    assert.equal(commercialUse.status, 'restricted');
    assert.equal(computeDigest(RN_SV_FRAMEWORK_V0_1), 'sha256:e71fafe1a10af95514823e35d43138b1b93cdb72e37765200447a37748c13a58', 'rn.sv@0.1.0 golden digest unchanged');
    const stored = await world.service.getAssessment(PILOT_ORG_CONTEXT, assessmentId);
    assert.equal(stored?.frameworkVersion, '0.1.0', 'no other framework version is in use');
    const releaseText = JSON.stringify(release);
    assert.equal(/authoriz(?:e|ed|ation) (?:for )?commercial|commercial use (?:is )?(?:authorized|permitted|approved|lifted)|restriction (?:lifted|satisfied|removed)/i.test(releaseText), false, 'the release record grants nothing');
    assert.deepEqual(affirming(draft.markdown, /commercial use (?:is |was )?(?:authorized|permitted|approved)|restriction (?:has been |is |was )?(?:lifted|satisfied|removed)/i), []);
  });

  it('G01-12 the customer disclosure keeps integrity, custody and external authenticity apart; no signature or cryptographic authenticity is claimed', async () => {
    const { world, assessmentId } = await readyWorld();
    const { draft, release } = await releasePilotReport(world, assessmentId);
    const limitation = draft.content.integrity.limitation;
    assert.match(limitation, /show integrity only/);
    assert.match(limitation, /They are not a digital signature, and this report carries none\./);
    assert.match(limitation, /do not establish who issued the report/);
    assert.match(limitation, /confirm the release digest with Republika over a separate, trusted channel/);
    assert.deepEqual(affirming(draft.markdown, /digitally signed|cryptographically (authentic|authenticated|proven)|signed by|signature:/i), []);
    const verdict = await world.service.verifyCommercialRelease(PILOT_ORG_CONTEXT, { ...draft, release });
    assert.equal(verdict.releaseAuthenticated, true, 'custody matches...');
    assert.equal(verdict.externalSignature, 'EXTERNAL_SIGNATURE_NOT_AVAILABLE', '...and is still not an external signature');
    const instructions = commercialPackageVerificationInstructions();
    assert.match(instructions, /Authentic: shown only by the issuer confirming/);
    assert.match(instructions, /A digest is not a digital signature/);
    const dir = join(tempDir(), 'package');
    writePilotPackage(dir, draft, release);
    const run = runVerifier(dir);
    assert.equal((run.output['externalAuthenticity'] as { status?: string }).status, 'NOT_DEMONSTRATED');
    assert.match(String(run.output['verdict']), /external authenticity NOT DEMONSTRATED$/);
  });
});

// ===========================================================================
// GF-06 / C9 -- customer-facing commercial materials
// ===========================================================================

const doc = (...path: string[]): string => read(COMMERCIAL, ...path);
const CUSTOMER_FACING = ['drafts/A_ONE_PAGE_OFFER.md', 'drafts/B_STATEMENT_OF_WORK.md', 'drafts/D_CONFIDENTIALITY_DATA_HANDLING_ADDENDUM.md', 'drafts/F_DELIVERABLES_ACCEPTANCE_CHECKLIST.md', 'drafts/G_LIMITATIONS_NON_CERTIFICATION_NOTICE.md', 'drafts/H_CUSTOMER_HANDOFF_VERIFICATION.md', 'SERVICE_SPECIFICATION.md', 'README.md'] as const;

describe('ASSURE-CLAIMS-01 GF-06 / C9 -- customer-facing drafts make no unsupported independence, proof or review claim', () => {
  it('G06-01 the offer promises no independence or proof; it names who performs the assessment and the separate release approval', () => {
    const offer = doc('drafts', 'A_ONE_PAGE_OFFER.md');
    assert.deepEqual(prose(offer).match(OVERCLAIM) ?? [], [], 'no "prove it", "independent, evidence-based", "independent sign-off"');
    assert.deepEqual(unqualifiedIndependence(offer), [], 'any "independent" names its axis or is a denial');
    assert.match(prose(offer), /## Know who can act on your behalf — and see the evidence behind it/);
    assert.match(prose(offer), /structured, evidence-based assessment conducted by Republika reviewers/);
    assert.match(prose(offer), /Separate release approval: a distinct authorized Republika approver, who did not perform any of the control reviews, approves your report/);
    assert.match(prose(offer), /No external auditor reviews it\./);
    assert.match(prose(offer), /DRAFT — NOT FOR DISTRIBUTION/);
    assert.match(prose(offer), /subject to qualified legal review/i);
  });

  it('G06-02 the service specification states Republika’s roles, the meaning and limits of PASS, the boundaries and the absence of external review and accreditation', () => {
    const spec = prose(doc('SERVICE_SPECIFICATION.md'));
    assert.deepEqual(spec.match(OVERCLAIM) ?? [], []);
    assert.deepEqual(unqualifiedIndependence(doc('SERVICE_SPECIFICATION.md')), []);
    for (const required of [
      /Republika authored rn\.sv@0\.1\.0/,
      /Republika operates the assessment tooling/,
      /Republika personnel or authorized contractors perform the control reviews, and a separate one approves the release/,
      /No external auditor or independent reviewer has reviewed any assessment/,
      /PASS means\. A reviewer['’]s conclusion, from accepted customer evidence bound to that control/,
      /does not guarantee that the supplied evidence is authentic, complete or representative/,
      /constrained by the declared scope, the evidence cut-off and the ten-control set/,
      /No accreditation or certification is implied/,
      /It is currently restricted\./,
      /is not digitally signed/,
    ]) {
      assert.match(spec, required, String(required));
    }
  });

  it('G06-03 the handoff names the issuer’s approver accurately and does not present per-person separation as cryptographically proven', () => {
    const handoff = doc('drafts', 'H_CUSTOMER_HANDOFF_VERIFICATION.md');
    const text = prose(handoff);
    assert.match(text, /A different authorized Republika approver approved this exact report content for release/);
    assert.equal(/independent of the reviewers/i.test(text), false);
    assert.match(text, /they are not external to Republika and not an independent reviewer/);
    assert.match(text, /separate approved credential/);
    assert.match(text, /enforced by Republika['’]s operating procedure; it is not cryptographically proven/);
    assert.deepEqual(affirming(handoff, /cryptographically (proven|authentic)|proves? (who|the origin)|§3 and §5 do\b/i), [], 'nothing claims proof of origin');
    assert.match(text, /external authenticity NOT DEMONSTRATED/, 'the verifier line is preserved');
    assert.match(text, /not digitally signed/);
  });

  it('G06-04 the limitations notice implies no certification and states who performs the assessment and what is outside scope', () => {
    const notice = doc('drafts', 'G_LIMITATIONS_NON_CERTIFICATION_NOTICE.md');
    const text = prose(notice);
    // The out-of-scope list is introduced by a denial ("makes no statement, and gives no assurance, about:"); everything before it is judged per sentence.
    const [beforeExclusions = '', exclusions = ''] = notice.split('## What is outside scope');
    assert.deepEqual(affirming(beforeExclusions, /\b(certified|accredited|certification|accreditation|attestation|attested)\b/i), [], 'every certification word is a denial');
    assert.match(prose(exclusions), /It makes no statement, and gives no assurance, about:/);
    assert.match(text, /## Who performs the assessment/);
    assert.match(text, /it is not independent of the framework author or of the tooling operator, and no external auditor or independent third party has reviewed it/);
    assert.match(text, /## What is outside scope/);
    for (const excluded of [/penetration testing/, /infrastructure or network security certification/, /regulatory or legal compliance/, /security certification of any cloud or hosting provider/, /availability/, /correctness, safety or behaviour of any AI model/, /supply-chain security assurance/, /immunity to, or prevention of, autonomous-agent failures/]) {
      assert.match(text, excluded, String(excluded));
    }
    // The ten-control boundary, exactly as the frozen framework names it.
    for (const control of RN_SV_FRAMEWORK_V0_1.controls) assert.match(text.toLowerCase(), new RegExp(`${control.controlId.toLowerCase()} ${control.title.toLowerCase()}`), control.controlId);
    assert.equal(RN_SV_FRAMEWORK_V0_1.controls.length, 10);
    assert.match(text, /That acknowledgement is an internal approval step; it is not an external review and does not lift the restriction/);
  });

  it('G06-05 the claims review and governance record describe the implementation as it now is, and leave review, legal and risk acceptance PENDING', () => {
    const claims = prose(doc('governance', 'CUSTOMER_CLAIMS_REVIEW.md'));
    assert.match(claims, /aoc\.assurance\.commercial-report\.v3/, 'the claims review names the corrected generator');
    assert.deepEqual(
      sentences(doc('governance', 'CUSTOMER_CLAIMS_REVIEW.md')).filter((sentence) => /act as that review|acts as the controlled review/i.test(sentence) && !/v1|v2|histor/i.test(sentence)),
      [],
      'the GF-01 wording is attributed only to historical v1/v2 reports',
    );
    const readiness = prose(doc('governance', 'GOVERNANCE_READINESS.md'));
    assert.match(readiness, /GF-01[^|]*\|[\s\S]*?ASSURE-CLAIMS-01/);
    for (const pending of [/R1[^.]*PENDING|independent R1\/R2 review[^.]*PENDING/i, /B7[^.]*OPEN/, /risk acceptance[^.]*PENDING/i]) assert.match(readiness, pending, String(pending));
    // The decision lines themselves (bold statements, not the procedure that describes how a future GO would be worded) all say NO-GO.
    for (const path of ['governance/GOVERNANCE_READINESS.md', 'ASSURE_COMMERCIAL_GO_NO_GO.md']) {
      const decisions = doc(path).split('\n').filter((line) => /^(?:>\s*)?\*\*FINAL COMMERCIAL DECISION:/.test(line));
      assert.ok(decisions.length > 0, `${path} states its decision`);
      for (const line of decisions) assert.match(line, /FINAL COMMERCIAL DECISION: NO-GO\./, `${path}: ${line}`);
      assert.match(doc(path), /\| \*\*Final\*\* \| \*\*NO-GO\*\* \|/, `${path}: gate matrix final row`);
    }
  });

  it('G06-06 no customer-facing draft, report or package file refers to an external reviewer’s sign-off that does not exist', async () => {
    for (const path of CUSTOMER_FACING) {
      const text = doc(path);
      assert.equal(REVIEW_CONFLATION.test(prose(text)), false, `${path}: review conflation`);
      assert.deepEqual(affirming(text, /\b(external|independent|third[- ]party) (reviewer|auditor)\b[^.]*\b(signed|approved|reviewed|attested)\b/i), [], `${path}: affirmed external sign-off`);
      assert.deepEqual(affirming(text, OVERCLAIM), [], `${path}: overclaim`);
      assert.match(prose(text), /DRAFT/, `${path}: still marked DRAFT`);
    }
    const { draft } = await readyWorld();
    assert.equal(REVIEW_CONFLATION.test(prose(draft.markdown)), false);
    assert.equal(REVIEW_CONFLATION.test(commercialPackageVerificationInstructions()), false);
  });
});

// ===========================================================================
// Phase H -- the synthetic Founding Assessment through the real Host
// ===========================================================================

function expectStatus(reply: Reply, status: number, where: string): Reply {
  assert.equal(reply.status, status, `${where}: ${reply.text.slice(0, 400)}`);
  return reply;
}

describe('ASSURE-CLAIMS-01 Phase H -- synthetic end-to-end assessment on the Host with the corrected generator', () => {
  it('H01 reviewer-only Host, authenticated reviews, separate approver, v3 draft, durable custody, OPS-01 export, materialisation, independent and authoritative verification, restart, byte-identical re-export', async () => {
    const historicalBefore = Object.fromEntries(readdirSync(HISTORICAL).sort().map((name) => [name, sha256(readFileSync(join(HISTORICAL, name)))]));
    const dir = workspace.dir();
    const env = rel01dEnv(dir, { reviewerOnly: true });
    const first = await bootRel01d(workspace, dir, env);
    const base = first.baseUrl;

    // 1-5. rn.sv@0.1.0, reviewer-only mode, the Host's dedicated test organization, synthetic evidence, authenticated reviews.
    const assessmentId = await completedAssessmentOverHttp(base, REL01D_AUTH.reviewer);

    // 6-7. A separate approver drafts with the corrected generator.
    const draftReply = expectStatus(await call(base, 'POST', `/api/assurance/assessments/${assessmentId}/commercial-report/draft`, { authorization: REL01D_AUTH.approver, body: draftBody() }), 200, 'draft');
    const content = draftReply.body['content'] as CommercialReportContent;
    const markdown = String(draftReply.body['markdown']);
    const manifest = draftReply.body['manifest'] as CommercialReportDraft['manifest'];
    assert.equal(content.readiness.status, 'READY_FOR_RELEASE');
    assert.equal(manifest.generatorVersion, COMMERCIAL_REPORT_GENERATOR_V3);
    assert.equal(REVIEW_CONFLATION.test(prose(markdown)), false, 'no fake external review, no conflation');
    assert.deepEqual(prose(markdown).match(OVERCLAIM) ?? [], [], 'no misleading independence or certification statement');
    assert.deepEqual(affirming(markdown, /\b(certified|accredited|certification|accreditation|attestation)\b/i), []);
    assert.match(markdown, /\| Framework commercial use \| restricted \|/, 'restriction visible');

    // 8. Durable custody, approved by a credential that recorded no review.
    const releasePath = `/api/assurance/assessments/${assessmentId}/commercial-report/release`;
    expectStatus(await call(base, 'POST', releasePath, { authorization: REL01D_AUTH.reviewer, body: releaseBody(manifest.contentDigest) }), 403, 'the reviewer cannot release');
    const committed = expectStatus(await call(base, 'POST', releasePath, { authorization: REL01D_AUTH.approver, body: releaseBody(manifest.contentDigest) }), 201, 'release');
    const release = committed.body['release'] as CommercialReportRelease;
    assert.equal(release.approvedBy, REL01D_IDS.approver);
    assert.notEqual(release.approvedBy, REL01D_IDS.reviewer);
    assert.equal(release.contentDigest, manifest.contentDigest);
    assert.equal(release.markdownDigest, sha256(markdown), 'report and release digests consistent');

    // 9. Export via OPS-01.
    const packagePath = `/api/assurance/commercial-releases/${content.reportId}/package`;
    const exported = expectStatus(await call(base, 'GET', packagePath, { authorization: REL01D_AUTH.approver }), 200, 'export').body as { files: { path: string; contentBase64: string }[]; packageDigest: string; externalSignature: string };
    assert.equal(exported.externalSignature, 'EXTERNAL_SIGNATURE_NOT_AVAILABLE');

    // 12 (before restart). Authoritative verification against the Host's custody.
    const delivered = { content, markdown, manifest, release };
    const authoritative = expectStatus(await call(base, 'POST', '/api/assurance/commercial-releases/verify', { authorization: REL01D_AUTH.approver, body: delivered }), 200, 'verify');
    assert.equal(authoritative.body['authority'], 'RELEASE_MATCHES_AUTHORITY');
    assert.equal(authoritative.body['externalSignature'], 'EXTERNAL_SIGNATURE_NOT_AVAILABLE');

    // 13-14. Restart; re-export; byte-for-byte comparison.
    await first.host.close();
    const second = await bootRel01d(workspace, dir, env);
    const reexported = expectStatus(await call(second.baseUrl, 'GET', packagePath, { authorization: REL01D_AUTH.approver }), 200, 'export after restart').body as typeof exported;
    assert.deepEqual(reexported.files, exported.files, 'byte-identical after restart');
    assert.equal(reexported.packageDigest, exported.packageDigest);
    const reverified = expectStatus(await call(second.baseUrl, 'POST', '/api/assurance/commercial-releases/verify', { authorization: REL01D_AUTH.reviewer, body: delivered }), 200, 'verify after restart');
    assert.equal(reverified.body['authority'], 'RELEASE_MATCHES_AUTHORITY');

    // 10. Materialise the six files with the operator CLI.
    const exportFile = join(dir, 'export.json');
    writeFileSync(exportFile, JSON.stringify(reexported));
    const out = join(dir, 'delivery', 'founding-assessment');
    const materialized = spawnSync(process.execPath, [MATERIALIZER, exportFile, '--out', out], { encoding: 'utf8', timeout: 60_000, env: {} });
    assert.equal(materialized.status, 0, materialized.stdout);
    assert.deepEqual(readdirSync(out).sort(), [...COMMERCIAL_RELEASE_PACKAGE_FILES]);
    assert.equal(readFileSync(join(out, 'report.md'), 'utf8'), markdown);

    // 11. Independent offline verification, with a consistent copy of the Host's store.
    await second.host.close();
    const storeCopy = join(dir, 'assurance-copy.sqlite');
    await snapshotSqlite(second.assurancePath, storeCopy);
    const run = runVerifier(out, ['--store-copy', storeCopy, '--renderer', RENDERER]);
    assert.equal(run.exit, 0, String(run.output['verdict']));
    assert.match(String(run.output['verdict']), /^PASS \(files, artifactIntegrity, reportConsistency, approvalConsistency, assessmentConsistency, releaseCustody\); external authenticity NOT DEMONSTRATED$/);
    assert.equal((run.output['externalAuthenticity'] as { status?: string }).status, 'NOT_DEMONSTRATED');
    assert.equal((consistency(run.output)['internal approval not presented as external or controlled review (v3)'] as unknown), true);

    // Historical reports are unchanged by the run.
    assert.deepEqual(Object.fromEntries(readdirSync(HISTORICAL).sort().map((name) => [name, sha256(readFileSync(join(HISTORICAL, name)))])), historicalBefore);
  });
});
