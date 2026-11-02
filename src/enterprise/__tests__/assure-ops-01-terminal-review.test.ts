import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import { computeDigest } from '../governance-store/digest.js';
import { AssuranceError, isAssuranceError } from '../assurance/errors.js';
import type { AssuranceStore } from '../assurance/assurance-store.js';
import type { AssuranceManualReviewRecord } from '../assurance/contracts.js';
import { RN_SV_REVIEWER_ROLE } from '../assurance/frameworks/rn-sv-framework.js';
import {
  PILOT_ORG,
  PILOT_ORG_CONTEXT,
  PILOT_SYSTEM_CONTEXT,
  buildPilotWorld,
  pilotContext,
  pilotReviewInput,
  preparePilotAssessment,
  reviewPilotAssessment,
  type PilotWorld,
} from './assure-pilot-01-scenario.js';

/**
 * ASSURE-OPS-01 (R-02): a terminal assessment accepts no new manual review.
 *
 * The invariant lives at the store boundary (`AssuranceStore.appendManualReview`):
 * the status that admits a review is read in the same SQLite IMMEDIATE
 * transaction as its insert, so a review that races a completion is recorded
 * before it or refused after it. The service refuses earlier, after
 * authorization, so a terminal status is disclosed only to an authorized
 * reviewer of the assessment's own organization. Synthetic data only.
 */

const dirs: string[] = [];
const worlds: PilotWorld[] = [];
after(async () => {
  for (const world of worlds) await world.store.close().catch(() => {});
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
const dbPath = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'assure-ops-01-r02-'));
  dirs.push(dir);
  return join(dir, 'assurance.sqlite');
};
const world = async (path: string, options: Parameters<typeof buildPilotWorld>[1] = {}): Promise<PilotWorld> => {
  const built = await buildPilotWorld(path, options);
  worlds.push(built);
  return built;
};

const terminalRefusal = (error: unknown): boolean => isAssuranceError(error) && error.code === 'ASSURANCE_ASSESSMENT_IMMUTABLE' && error.details?.['reason'] === 'terminal_assessment';
const isCode = (code: string) => (error: unknown): boolean => error instanceof AssuranceError && error.code === code;

function reviewRows(path: string, assessmentId: string): number {
  const raw = new Database(path, { readonly: true });
  try {
    return (raw.prepare('SELECT COUNT(*) AS n FROM assurance_manual_reviews WHERE assessment_id = ?').get(assessmentId) as { n: number }).n;
  } finally {
    raw.close();
  }
}

/** A review record shaped exactly as the service builds one, for direct store calls. */
function storeReview(assessmentId: string, reviewId: string, controlId = 'SV-10'): AssuranceManualReviewRecord {
  const base = {
    reviewId,
    assessmentId,
    controlId,
    reviewerId: 'pilot-reviewer',
    reviewerRole: RN_SV_REVIEWER_ROLE,
    outcome: 'insufficient_evidence' as const,
    rationale: 'synthetic',
    evidenceReferenceIds: [],
    reviewedAt: '2026-10-28T10:00:00.000Z',
    reviewerAuthentication: 'assurance_reviewer_credential' as const,
  };
  return { ...base, reviewDigest: computeDigest(base) };
}

async function completedAssessment(target: PilotWorld): Promise<string> {
  const prepared = await preparePilotAssessment(target);
  await reviewPilotAssessment(target, prepared.assessmentId);
  await target.service.completeAssessment(PILOT_ORG_CONTEXT, prepared.assessmentId);
  return prepared.assessmentId;
}

const LATE = (assessmentId: string) => pilotReviewInput(assessmentId, 'SV-10', 'insufficient_evidence');
const withoutRole = (input: ReturnType<typeof LATE>): ReturnType<typeof LATE> => {
  const { reviewerRole: _declared, ...rest } = input;
  return rest;
};

describe('ASSURE-OPS-01 R-02 -- terminal assessments accept no new manual review', () => {
  it('R02-01 a review before the terminal transition is recorded; two concurrent reviews while the status permits both append', async () => {
    const path = dbPath();
    const pilot = await world(path);
    const prepared = await preparePilotAssessment(pilot);
    assert.equal(prepared.status, 'manual_review');
    const reviewer = pilotContext(pilot, 'reviewer');
    const [a, b] = await Promise.all([
      pilot.service.recordManualReview(reviewer, pilotReviewInput(prepared.assessmentId, 'SV-10', 'insufficient_evidence')),
      pilot.service.recordManualReview(reviewer, pilotReviewInput(prepared.assessmentId, 'SV-09', 'insufficient_evidence')),
    ]);
    assert.notEqual(a.reviewId, b.reviewId);
    assert.equal(reviewRows(path, prepared.assessmentId), 2, 'both appended, neither replaced');
  });

  it('R02-02 / R02-07 after completion a review is refused (409 semantics), repeatedly, recording nothing and publishing no review event; the completed assessment still verifies', async () => {
    const path = dbPath();
    const pilot = await world(path);
    const assessmentId = await completedAssessment(pilot);
    const rowsBefore = reviewRows(path, assessmentId);
    const before = await pilot.service.getAssessment(PILOT_ORG_CONTEXT, assessmentId);
    const eventsBefore = pilot.events.filter((event) => event.type === 'AssuranceManualReviewCompleted').length;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await assert.rejects(pilot.service.recordManualReview(pilotContext(pilot, 'reviewer'), LATE(assessmentId)), terminalRefusal);
      await assert.rejects(pilot.service.recordManualReview(pilotContext(pilot, 'reviewer'), pilotReviewInput(assessmentId, 'SV-06', 'pass', ['sv06'])), terminalRefusal);
    }
    // The terminal status is the answer, ahead of evidence validation: an unsupported PASS is refused as terminal, not as unsupported.
    await assert.rejects(pilot.service.recordManualReview(pilotContext(pilot, 'reviewer'), pilotReviewInput(assessmentId, 'SV-01', 'pass', [])), terminalRefusal);
    assert.equal(reviewRows(path, assessmentId), rowsBefore, 'no row was added');
    assert.equal(pilot.events.filter((event) => event.type === 'AssuranceManualReviewCompleted').length, eventsBefore, 'no review event');
    const afterwards = await pilot.service.getAssessment(PILOT_ORG_CONTEXT, assessmentId);
    assert.deepEqual(afterwards, before, 'the completed assessment is unchanged');
    assert.equal((await pilot.service.verifyAssessment(PILOT_ORG_CONTEXT, assessmentId)).valid, true);
    // Restart: a new connection over the same file sees no rejected review either.
    await pilot.store.close();
    const reopened = await world(path, { startTick: 500_000, startId: 50_000 });
    assert.equal((await reopened.store.listManualReviews(PILOT_ORG_CONTEXT, assessmentId)).length, rowsBefore);
    await assert.rejects(reopened.service.recordManualReview(pilotContext(reopened, 'reviewer'), LATE(assessmentId)), terminalRefusal);
  });

  it('R02-03 after an inconclusive termination (status failed) a review is refused', async () => {
    const path = dbPath();
    const pilot = await world(path);
    const prepared = await preparePilotAssessment(pilot);
    const { assessment: ended } = await pilot.service.terminateAssessment(pilotContext(pilot, 'reviewer'), prepared.assessmentId, {
      reasonCode: 'engagement_withdrawn',
      rationale: 'synthetic withdrawal',
    });
    assert.equal(ended.status, 'failed');
    const rows = reviewRows(path, prepared.assessmentId);
    await assert.rejects(pilot.service.recordManualReview(pilotContext(pilot, 'reviewer'), LATE(prepared.assessmentId)), terminalRefusal);
    assert.equal(reviewRows(path, prepared.assessmentId), rows);
  });

  it('R02-04 after supersession a review is refused, by the service and by the store', async () => {
    const path = dbPath();
    const pilot = await world(path);
    const assessmentId = await completedAssessment(pilot);
    await pilot.store.markSuperseded(PILOT_ORG_CONTEXT, assessmentId, 'synthetic-successor');
    assert.equal((await pilot.service.getAssessment(PILOT_ORG_CONTEXT, assessmentId))?.status, 'superseded');
    await assert.rejects(pilot.service.recordManualReview(pilotContext(pilot, 'reviewer'), LATE(assessmentId)), terminalRefusal);
    await assert.rejects(pilot.store.appendManualReview(PILOT_ORG_CONTEXT, storeReview(assessmentId, 'direct-superseded')), terminalRefusal);
  });

  it('R02-05 a review racing a completion on another connection is refused at the store, not recorded (the service had read a non-terminal status)', async () => {
    const path = dbPath();
    // Connection B completes; connection A's service reads the assessment, then
    // its store insert is held until B has committed the completion.
    const other = await world(path, { startTick: 700_000, startId: 70_000 });
    let releaseInsert: () => Promise<void> = async () => {};
    let readStatus: string | undefined;
    const wrap = (inner: AssuranceStore): AssuranceStore =>
      Object.assign(Object.create(inner) as AssuranceStore, {
        getAssessment: async (...args: Parameters<AssuranceStore['getAssessment']>) => {
          const read = await inner.getAssessment(...args);
          readStatus = read?.status;
          return read;
        },
        appendManualReview: async (...args: Parameters<AssuranceStore['appendManualReview']>) => {
          await releaseInsert();
          return inner.appendManualReview(...args);
        },
      });
    const racer = await world(path, { wrapStore: wrap });
    const prepared = await preparePilotAssessment(racer);
    releaseInsert = async () => {};
    await reviewPilotAssessment(racer, prepared.assessmentId);
    const rows = reviewRows(path, prepared.assessmentId);
    releaseInsert = async () => {
      releaseInsert = async () => {};
      const completed = await other.service.completeAssessment(PILOT_ORG_CONTEXT, prepared.assessmentId);
      assert.equal(completed.status, 'completed', 'B committed the completion while A was between its read and its insert');
    };
    await assert.rejects(racer.service.recordManualReview(pilotContext(racer, 'reviewer'), LATE(prepared.assessmentId)), terminalRefusal);
    assert.ok(readStatus !== undefined && !['completed', 'failed', 'superseded'].includes(readStatus), 'the service-level check saw a non-terminal status: only the store guard could refuse');
    assert.equal(reviewRows(path, prepared.assessmentId), rows, 'no late review was recorded');
    assert.equal((await other.service.verifyAssessment(PILOT_ORG_CONTEXT, prepared.assessmentId)).valid, true);
  });

  it('R02-05b the other order: a review committed first is kept, and the completion after it succeeds', async () => {
    const path = dbPath();
    const pilot = await world(path);
    const other = await world(path, { startTick: 800_000, startId: 80_000 });
    const prepared = await preparePilotAssessment(pilot);
    await reviewPilotAssessment(pilot, prepared.assessmentId);
    const rows = reviewRows(path, prepared.assessmentId);
    await pilot.service.recordManualReview(pilotContext(pilot, 'reviewer'), LATE(prepared.assessmentId));
    const completed = await other.service.completeAssessment(PILOT_ORG_CONTEXT, prepared.assessmentId);
    assert.equal(completed.status, 'completed');
    assert.equal(reviewRows(path, prepared.assessmentId), rows + 1);
  });

  it('R02-06 another organization, an unknown id, a role-less credential, a wrong declared role and the system context are refused without disclosing the terminal status', async () => {
    const path = dbPath();
    const pilot = await world(path);
    const assessmentId = await completedAssessment(pilot);
    const rows = reviewRows(path, assessmentId);
    // Another tenant: answered exactly as an unknown assessment.
    await assert.rejects(pilot.service.recordManualReview(pilotContext(pilot, 'otherReviewer'), LATE(assessmentId)), isCode('ASSURANCE_ASSESSMENT_NOT_FOUND'));
    await assert.rejects(pilot.service.recordManualReview(pilotContext(pilot, 'otherReviewer'), LATE('no-such-assessment')), isCode('ASSURANCE_ASSESSMENT_NOT_FOUND'));
    // Authenticated but not authorized for the control: 403, never the 409 that would reveal the status.
    await assert.rejects(pilot.service.recordManualReview(pilotContext(pilot, 'approver'), withoutRole(LATE(assessmentId))), isCode('ASSURANCE_REVIEWER_UNAUTHORIZED'));
    await assert.rejects(pilot.service.recordManualReview(pilotContext(pilot, 'reviewer'), { ...LATE(assessmentId), reviewerRole: 'assure.report-release' }), isCode('ASSURANCE_REVIEWER_UNAUTHORIZED'));
    await assert.rejects(pilot.service.recordManualReview(PILOT_SYSTEM_CONTEXT, LATE(assessmentId)), isCode('ASSURANCE_REVIEWER_UNAUTHORIZED'));
    await assert.rejects(pilot.service.recordManualReview(PILOT_ORG_CONTEXT, LATE(assessmentId)), isCode('ASSURANCE_REVIEWER_UNAUTHORIZED'));
    // A declared reviewer identity is never accepted (SEC-01B, unchanged).
    await assert.rejects(pilot.service.recordManualReview(pilotContext(pilot, 'reviewer'), { ...LATE(assessmentId), reviewerId: 'someone-else' }), isCode('ASSURANCE_REVIEWER_UNAUTHORIZED'));
    assert.equal(reviewRows(path, assessmentId), rows);
  });

  it('R02-08 the store refuses a direct append to a terminal assessment (SQLite and in memory) -- the guard does not depend on the service', async () => {
    const path = dbPath();
    const sqlite = await world(path);
    const assessmentId = await completedAssessment(sqlite);
    await assert.rejects(sqlite.store.appendManualReview(PILOT_ORG_CONTEXT, storeReview(assessmentId, 'direct-late')), terminalRefusal);
    assert.equal((await sqlite.store.listManualReviews(PILOT_ORG_CONTEXT, assessmentId)).some((review) => review.reviewId === 'direct-late'), false);

    const memory = await world('', { inMemory: true });
    const memoryId = await completedAssessment(memory);
    await assert.rejects(memory.store.appendManualReview(PILOT_ORG_CONTEXT, storeReview(memoryId, 'direct-late')), terminalRefusal);
    await assert.rejects(memory.service.recordManualReview(pilotContext(memory, 'reviewer'), LATE(memoryId)), terminalRefusal);
    // Non-terminal: the store still appends.
    const open = await preparePilotAssessment(memory);
    await memory.store.appendManualReview({ organizationId: PILOT_ORG, system: false }, storeReview(open.assessmentId, 'direct-open'));
    assert.equal((await memory.store.listManualReviews(PILOT_ORG_CONTEXT, open.assessmentId)).length, 1);
  });

  it('R02-09 reviews recorded before completion stay intact and keep counting for separation of duties', async () => {
    const path = dbPath();
    const pilot = await world(path);
    const assessmentId = await completedAssessment(pilot);
    const reviews = await pilot.store.listManualReviews(PILOT_ORG_CONTEXT, assessmentId);
    assert.equal(reviews.length, 10);
    assert.ok(reviews.every((review) => review.reviewerId === 'pilot-reviewer'));
    await assert.rejects(pilot.service.recordManualReview(pilotContext(pilot, 'reviewer'), LATE(assessmentId)), terminalRefusal);
    assert.deepEqual(await pilot.store.listManualReviews(PILOT_ORG_CONTEXT, assessmentId), reviews);
  });
});
