import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { computeDigest } from '../governance-store/digest.js';
import { loadEnterpriseConfiguration } from '../configuration/enterprise-configuration.js';
import { AssuranceReviewerConfigurationError, assertAssuranceReviewerConfiguration } from '../orchestration/assurance-reviewer-credentials.js';
import { createAssuranceReviewerAuthenticator, type AssuranceReviewerCredential } from '../assurance/reviewer-identity.js';
import { WITHHELD_REVIEWER_PREFIX, isSafeReviewerReference, publicReviewerReference, reviewerReferenceViolation } from '../assurance/reviewer-reference.js';
import { COMMERCIAL_REPORT_RELEASE_ROLE, buildCommercialReportRelease, verifyCommercialReport, type CommercialReportDraft } from '../assurance/commercial-report.js';
import { isAssuranceError } from '../assurance/errors.js';
import { escapeMarkdownText } from '../assurance/commercial-report-markdown.js';
import type { AssuranceManualReviewRecord } from '../assurance/contracts.js';
import { RN_SV_REVIEWER_ROLE } from '../assurance/frameworks/rn-sv-framework.js';
import {
  PILOT_CONTROLS,
  PILOT_ENGAGEMENT,
  PILOT_ISSUE,
  PILOT_ORG_CONTEXT,
  PILOT_REVIEW_PLAN,
  buildPilotWorld,
  pilotContext,
  pilotReviewInput,
  preparePilotAssessment,
  type PilotWorld,
} from './assure-pilot-01-scenario.js';

/**
 * ASSURE-OPS-01 (R-04): reviewer identifiers printed in delivered reports are
 * safe, opaque references. Unsafe ones are refused at configuration (Host
 * loader and every authenticator); an unsafe identifier a historical review
 * already carries is withheld deterministically in newly built reports and
 * never rewritten in the store. All identifiers below are synthetic; the
 * example domain is reserved (`.invalid`) and the telephone digits are the
 * fictional 555-01xx range.
 */

const dirs: string[] = [];
const worlds: PilotWorld[] = [];
after(async () => {
  for (const world of worlds) await world.store.close().catch(() => {});
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const SYNTHETIC_EMAIL = 'reviewer.one@example.invalid';
const SYNTHETIC_PHONE = '555-010-0199';

const UNSAFE: readonly (readonly [string, string, string])[] = [
  ['R04-02 email-like', SYNTHETIC_EMAIL, 'email_like'],
  ['R04-03 phone-like', SYNTHETIC_PHONE, 'phone_like'],
  ['R04-03 phone-like, international', '+15550100199', 'charset'],
  ['R04-03 phone-like, dotted', 'rev.555.010.0199', 'phone_like'],
  ['R04-04 newline injection', 'reviewer-1\nApproved by the CEO', 'charset'],
  ['R04-04 control character', 'reviewer-1\u0007', 'charset'],
  ['R04-04 HTML-like', '<b>reviewer</b>', 'charset'],
  ['R04-04 Markdown link', '[reviewer](https://example.invalid)', 'charset'],
  ['path-like', '../reviewer', 'charset'],
  ['path separator', 'team/reviewer', 'charset'],
  ['Windows path', 'C:\\reviewer', 'charset'],
  ['Unicode confusable (Cyrillic e)', 'r\u0435viewer-1', 'charset'],
  ['upper-case twin', 'Reviewer-1', 'charset'],
  ['full name with a space', 'jane doe', 'charset'],
  ['excessive length', 'r'.repeat(65), 'too_long'],
  ['reserved alias namespace', `${WITHHELD_REVIEWER_PREFIX}0011223344556677`, 'reserved_prefix'],
  ['empty', '', 'empty'],
];

const SAFE: readonly string[] = ['reviewer-001', 'assure-reviewer-7f3a', 'rn-reviewer-01', 'pilot-reviewer', 'r', 'review_team.a'];

const credential = (reviewerId: string, key = 'synthetic-reviewer-secret-0000000000000001'): AssuranceReviewerCredential => ({
  reviewerId,
  organizationId: 'org-1',
  roles: [RN_SV_REVIEWER_ROLE],
  key,
});

function hostConfiguration(reviewers: readonly AssuranceReviewerCredential[]) {
  const base = loadEnterpriseConfiguration({ AOC_ENTERPRISE_KERNEL_AUTHORITY_ORGANIZATION_ID: 'org-1' });
  return { ...base, authentication: { ...base.authentication, assuranceReviewers: reviewers } };
}

describe('ASSURE-OPS-01 R-04 -- the reviewer reference policy', () => {
  it('R04-01 opaque, role-style references are accepted everywhere', () => {
    for (const id of SAFE) {
      assert.equal(reviewerReferenceViolation(id), undefined, id);
      assert.equal(publicReviewerReference(id), id, 'a safe reference is printed as is');
    }
    assert.doesNotThrow(() => createAssuranceReviewerAuthenticator(SAFE.map((id, index) => credential(id, `synthetic-reviewer-secret-${String(index).padStart(32, '0')}`))));
    assert.doesNotThrow(() => assertAssuranceReviewerConfiguration(hostConfiguration([credential('rn-reviewer-01')]), 'org-1'));
  });

  for (const [label, id, violation] of UNSAFE) {
    it(`${label}: refused by the policy, by every authenticator and by the Host loader, without echoing the value`, () => {
      assert.equal(reviewerReferenceViolation(id), violation);
      assert.equal(isSafeReviewerReference(id), false);
      assert.throws(
        () => createAssuranceReviewerAuthenticator([credential(id)]),
        (error: unknown) => isAssuranceError(error) && error.code === 'ASSURANCE_VALIDATION_ERROR' && (id.length === 0 || !error.message.includes(id)),
      );
      if (id.length > 0) {
        assert.throws(
          () => assertAssuranceReviewerConfiguration(hostConfiguration([credential(id)]), 'org-1'),
          (error: unknown) => error instanceof AssuranceReviewerConfigurationError && !error.message.includes(id),
        );
      }
    });
  }

  it('R04-05 duplicate reviewer ids are refused (no two credentials share an identity)', () => {
    assert.throws(
      () => createAssuranceReviewerAuthenticator([credential('reviewer-001', 'synthetic-reviewer-secret-0000000000000001'), credential('reviewer-001', 'synthetic-reviewer-secret-0000000000000002')]),
      (error: unknown) => isAssuranceError(error) && error.details?.['violation'] === 'duplicate',
    );
    assert.throws(
      () => assertAssuranceReviewerConfiguration(hostConfiguration([credential('reviewer-001', 'synthetic-reviewer-secret-0000000000000001'), credential('reviewer-001', 'synthetic-reviewer-secret-0000000000000002')]), 'org-1'),
      AssuranceReviewerConfigurationError,
    );
  });

  it('the withheld alias is deterministic, distinct per identifier, safe in form, and never contains the original', () => {
    const a = publicReviewerReference(SYNTHETIC_EMAIL);
    const b = publicReviewerReference('reviewer.two@example.invalid');
    assert.equal(a, publicReviewerReference(SYNTHETIC_EMAIL));
    assert.notEqual(a, b, 'distinct reviewers never collapse into one alias');
    assert.match(a, /^withheld-reviewer-[0-9a-f]{16}$/);
    assert.equal(a.includes('example'), false);
    // Distinct unsafe ids that differ only in a confusable or case stay distinct.
    assert.notEqual(publicReviewerReference('Reviewer-1'), publicReviewerReference('r\u0435viewer-1'));
  });

  it('a release record never carries an unsafe approver (defence in depth below the authenticator)', () => {
    const draft = { content: { reportId: 'rn-sv-report:x:v1', integrity: { assessmentId: 'x' } }, manifest: { contentDigest: 'sha256:0', markdownDigest: 'sha256:0', manifestDigest: 'sha256:0' } } as unknown as CommercialReportDraft;
    assert.throws(
      () => buildCommercialReportRelease(draft, { approvedBy: SYNTHETIC_EMAIL, approverRole: COMMERCIAL_REPORT_RELEASE_ROLE, approvedAt: '2026-10-28T00:00:00.000Z', acknowledgements: { limitationsReviewed: true, commercialUseRestrictionAcknowledged: true } }),
      (error: unknown) => isAssuranceError(error) && error.details?.['reason'] === 'unsafe_reviewer_reference',
    );
  });
});

describe('ASSURE-OPS-01 R-04 -- customer-facing disclosure', () => {
  it('R04-07 an unsafe identifier on a historical review is withheld in the new report JSON and Markdown; the stored review keeps it; output is deterministic', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'assure-ops-01-r04-'));
    dirs.push(dir);
    const world = await buildPilotWorld(join(dir, 'assurance.sqlite'));
    worlds.push(world);
    const prepared = await preparePilotAssessment(world);
    const reviewer = pilotContext(world, 'reviewer');
    for (const controlId of PILOT_CONTROLS.filter((id) => id !== 'SV-10')) {
      const [outcome, evidence] = PILOT_REVIEW_PLAN[controlId] ?? ['insufficient_evidence'];
      await world.service.recordManualReview(reviewer, pilotReviewInput(prepared.assessmentId, controlId, outcome, evidence));
    }
    // A review kept from before this policy, attributed to an email-like credential id.
    const base = {
      reviewId: 'historical-review-sv10',
      assessmentId: prepared.assessmentId,
      controlId: 'SV-10',
      reviewerId: SYNTHETIC_EMAIL,
      reviewerRole: RN_SV_REVIEWER_ROLE,
      outcome: 'insufficient_evidence' as const,
      rationale: 'historical synthetic review',
      evidenceReferenceIds: [],
      reviewedAt: '2026-10-28T09:30:00.000Z',
      reviewerAuthentication: 'assurance_reviewer_credential' as const,
    };
    const historical: AssuranceManualReviewRecord = { ...base, reviewDigest: computeDigest(base) };
    await world.store.appendManualReview(PILOT_ORG_CONTEXT, historical);
    await world.service.evaluateAssessment(PILOT_ORG_CONTEXT, prepared.assessmentId);
    await world.service.completeAssessment(PILOT_ORG_CONTEXT, prepared.assessmentId);

    const draft = await world.service.buildCommercialReportDraft(PILOT_ORG_CONTEXT, prepared.assessmentId, { engagement: PILOT_ENGAGEMENT, issue: PILOT_ISSUE });
    const alias = publicReviewerReference(SYNTHETIC_EMAIL);
    const json = JSON.stringify(draft.content);
    for (const output of [json, draft.markdown]) {
      assert.equal(output.includes(SYNTHETIC_EMAIL), false, 'the email never reaches the report');
      assert.equal(output.includes('example.invalid'), false);
      assert.equal(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/.test(output), false, 'no email-shaped value at all (the framework id rn.sv@0.1.0 is not one)');
    }
    assert.equal(json.includes(alias), true, 'JSON names the withheld alias');
    assert.equal(draft.markdown.includes(escapeMarkdownText(alias)), true, 'Markdown names the withheld alias (Markdown-escaped like every value)');
    assert.deepEqual(draft.content.controls.find((control) => control.controlId === 'SV-10')?.review.reviewers, [alias]);
    assert.equal(verifyCommercialReport(draft).valid, true);
    // The stored review is unchanged: audit identity is not rewritten.
    const stored = await world.store.listManualReviews(PILOT_ORG_CONTEXT, prepared.assessmentId);
    assert.equal(stored.find((review) => review.reviewId === 'historical-review-sv10')?.reviewerId, SYNTHETIC_EMAIL);
    // Deterministic: drafting again yields the same digests.
    const again = await world.service.buildCommercialReportDraft(PILOT_ORG_CONTEXT, prepared.assessmentId, { engagement: PILOT_ENGAGEMENT, issue: PILOT_ISSUE });
    assert.equal(again.manifest.contentDigest, draft.manifest.contentDigest);
    assert.equal(again.manifest.markdownDigest, draft.manifest.markdownDigest);
  });

  it('R04-06 the committed historical v1 and v2 example packages still verify byte for byte', () => {
    for (const [directory, suffix] of [
      [join(process.cwd(), 'docs', 'enterprise', 'examples', 'historical'), 'v1.'],
      [join(process.cwd(), 'docs', 'enterprise', 'examples'), ''],
    ] as const) {
      const read = (part: string): string => readFileSync(join(directory, `rn-sv-founding-assessment.synthetic.${suffix}${part}`), 'utf8').replace(/\r\n/g, '\n');
      const content = JSON.parse(read('json')) as CommercialReportDraft['content'];
      const markdown = read('md');
      const manifest = JSON.parse(read('manifest.json')) as CommercialReportDraft['manifest'];
      const release = JSON.parse(read('release.json')) as Parameters<typeof verifyCommercialReport>[0]['release'];
      assert.equal(verifyCommercialReport({ content, markdown, manifest, ...(release !== undefined ? { release } : {}) }).valid, true, directory);
    }
  });
});
