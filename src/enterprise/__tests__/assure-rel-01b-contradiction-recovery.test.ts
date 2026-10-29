import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';

import { AssuranceError } from '../assurance/errors.js';
import { computeDigest } from '../governance-store/digest.js';
import { RN_SV_FRAMEWORK_V0_1, RN_SV_REVIEWER_ROLE } from '../assurance/frameworks/rn-sv-framework.js';
import { AOC_SAF_FRAMEWORK_ID, AOC_SAF_FRAMEWORK_V1, AOC_SAF_FRAMEWORK_VERSION } from '../assurance/saf-framework.js';
import { ASSURANCE_TERMINATION_ROLE } from '../assurance/assessment-termination.js';
import type { AssuranceAccessContext, AssuranceAssessment, AssuranceEvidenceReference, AssuranceManualReviewOutcome } from '../assurance/contracts.js';
import type { AssuranceReviewerCredential } from '../assurance/reviewer-identity.js';
import type { TerminateAssessmentInput } from '../assurance/service.js';
import type { EnterpriseLogContext, EnterpriseLogger } from '../telemetry/enterprise-logger.js';
import {
  PILOT_CONTROLS,
  PILOT_CREDENTIALS,
  PILOT_CUTOFF,
  PILOT_ENGAGEMENT,
  PILOT_ISSUE,
  PILOT_ORG,
  PILOT_ORG_CONTEXT,
  PILOT_SYSTEM_CONTEXT,
  buildPilotWorld,
  pilotArtifact,
  pilotContext,
  pilotContradictoryEvidence,
  pilotEvidenceId,
  pilotReviewInput,
  releasePilotReport,
  runPilotHappyPath,
  type PilotWorld,
} from './assure-pilot-01-scenario.js';

/**
 * ASSURE-REL-01B -- recovery from the contradiction deadlock (ASSURE-PILOT-01, F02).
 *
 * An attempt whose evidence contradicts itself cannot be concluded and, before
 * REL-01B, could not be ended either. The supported way out is explicit: an
 * authenticated reviewer ENDS the attempt as inconclusive (`terminateAssessment`
 * -> status `failed` with a self-digested termination record), and a new attempt
 * follows it (`requestReassessment`), linked but never superseding it, with its
 * evidence collected afresh. Nothing in either step turns a contradiction into
 * PASS or FAIL. Persistence is proven on real SQLite files, reopened.
 * See docs/security/ASSURE-REL-01B-CONTRADICTION-RECOVERY.md.
 */

const tempDirs: string[] = [];
const worlds: PilotWorld[] = [];
after(async () => {
  for (const world of worlds) await world.store.close().catch(() => {});
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'assure-rel-01b-'));
  tempDirs.push(dir);
  return dir;
};

const SUBJECT = 'pilot-contradiction-subject';
/** A second reviewer of the same organization, for concurrent terminations. */
const SECOND_REVIEWER: AssuranceReviewerCredential = { reviewerId: 'pilot-reviewer-2', organizationId: PILOT_ORG, roles: [RN_SV_REVIEWER_ROLE], key: `rel01b-${randomBytes(24).toString('hex')}` };
const REVIEWERS: readonly AssuranceReviewerCredential[] = [...Object.values(PILOT_CREDENTIALS), SECOND_REVIEWER];
const ENDED: TerminateAssessmentInput = { reasonCode: 'unresolved_contradiction', rationale: 'The two copies of the SV-08 runbook carry different digests; neither can be shown to be the operative one.' };

interface LogLine {
  readonly message: string;
  readonly fields: EnterpriseLogContext | undefined;
}
function capturingLogger(): { readonly logger: EnterpriseLogger; readonly lines: LogLine[] } {
  const lines: LogLine[] = [];
  const at = (message: string, fields?: EnterpriseLogContext) => lines.push({ message, fields });
  return { logger: { debug: at, info: at, warn: at, error: at }, lines };
}

async function open(dbPath: string, options: Parameters<typeof buildPilotWorld>[1] = {}): Promise<PilotWorld> {
  const world = await buildPilotWorld(dbPath, { reviewers: REVIEWERS, ...options });
  worlds.push(world);
  return world;
}
function contextOf(world: PilotWorld, credential: AssuranceReviewerCredential): AssuranceAccessContext {
  const reviewer = world.service.authenticateReviewer(credential.key);
  assert.ok(reviewer);
  return { system: false, organizationId: reviewer.organizationId, actorId: reviewer.reviewerId, roles: reviewer.roles, reviewer };
}
const isCode = (code: string, reason?: string) => (error: unknown) =>
  error instanceof AssuranceError && error.code === code && (reason === undefined || error.details?.['reason'] === reason);
const statusOf = (assessment: AssuranceAssessment, controlId: string): string | undefined => assessment.controlEvaluations.find((evaluation) => evaluation.controlId === controlId)?.status;

/** Reviews every control: `SV-08` as given, the others as evidence gaps. */
async function reviewAll(world: PilotWorld, assessmentId: string, sv08: readonly [AssuranceManualReviewOutcome, (readonly string[])?]): Promise<void> {
  const reviewer = pilotContext(world, 'reviewer');
  await world.service.recordManualReview(reviewer, pilotReviewInput(assessmentId, 'SV-08', sv08[0], sv08[1]));
  for (const controlId of PILOT_CONTROLS.filter((candidate) => candidate !== 'SV-08')) await world.service.recordManualReview(reviewer, pilotReviewInput(assessmentId, controlId, 'insufficient_evidence'));
}

interface Deadlocked {
  readonly world: PilotWorld;
  readonly dbPath: string;
  readonly assessmentId: string;
  /** The attempt as the deadlock leaves it: `manual_review`, SV-08 pending despite an accepted FAIL review. */
  readonly before: AssuranceAssessment;
}

/** F02 exactly as the pilot reproduced it: contradictory SV-08 evidence, an accepted FAIL review, and no way to conclude. */
async function deadlocked(options: Parameters<typeof buildPilotWorld>[1] = {}): Promise<Deadlocked> {
  const dbPath = join(tempDir(), 'assurance.db');
  const world = await open(dbPath, options);
  const created = await world.service.createAssessment(PILOT_ORG_CONTEXT, { subject: { subjectType: 'system', subjectId: SUBJECT, organizationId: PILOT_ORG }, frameworkId: 'rn.sv', frameworkVersion: '0.1.0', requestedBy: 'pilot-preparer', evidenceCutoffAt: PILOT_CUTOFF });
  await world.service.collectEvidence(PILOT_ORG_CONTEXT, created.assessmentId, { manualEvidence: pilotContradictoryEvidence(SUBJECT) });
  await world.service.evaluateAssessment(PILOT_ORG_CONTEXT, created.assessmentId);
  await reviewAll(world, created.assessmentId, ['fail', ['sv08-a']]);
  const before = await world.service.evaluateAssessment(PILOT_ORG_CONTEXT, created.assessmentId);
  assert.equal(before.status, 'manual_review');
  assert.equal(statusOf(before, 'SV-08'), 'manual_review_required');
  return { world, dbPath, assessmentId: created.assessmentId, before };
}

/** Follows an ended attempt with a new one, collects `evidence`, reviews and evaluates it. Returns it evaluated (not completed). */
async function followWith(world: PilotWorld, endedId: string, evidence: readonly AssuranceEvidenceReference[], sv08: readonly [AssuranceManualReviewOutcome, (readonly string[])?]): Promise<AssuranceAssessment> {
  const successor = await world.service.requestReassessment(PILOT_ORG_CONTEXT, { assessmentId: endedId, reason: 'New attempt after an inconclusive one: the customer supplied one authoritative copy of the runbook.', requestedBy: 'pilot-preparer' });
  await world.service.collectEvidence(PILOT_ORG_CONTEXT, successor.assessmentId, { manualEvidence: evidence });
  await world.service.evaluateAssessment(PILOT_ORG_CONTEXT, successor.assessmentId);
  await reviewAll(world, successor.assessmentId, sv08);
  return world.service.evaluateAssessment(PILOT_ORG_CONTEXT, successor.assessmentId);
}
const fixedRunbook = (): AssuranceEvidenceReference[] => [pilotArtifact('sv08-fixed', 'SV-08', { subjectId: SUBJECT, externalId: 'https://internal.pilot-coop.invalid/sv08-runbook-v2', digest: computeDigest({ pilot01: 'sv08', copy: 'authoritative' }) })];
/** What an attempt's evidence and results are -- everything but its lifecycle overlay. */
const contentOf = (assessment: AssuranceAssessment) => ({
  evidenceReferences: assessment.evidenceReferences,
  evidenceResolutions: assessment.evidenceResolutions,
  controlEvaluations: assessment.controlEvaluations,
  findings: assessment.findings,
  score: assessment.score,
  integrity: assessment.integrity,
});
const findingRows = (dbPath: string, assessmentId: string): number => {
  const raw = new Database(dbPath, { readonly: true });
  try {
    return (raw.prepare('SELECT count(*) AS n FROM assurance_findings WHERE assessment_id = ?').get(assessmentId) as { n: number }).n;
  } finally {
    raw.close();
  }
};

// ===========================================================================

describe('ASSURE-REL-01B -- the contradiction deadlock has an explicit, safe exit', () => {
  it('B01 F02 as found: with contradictory evidence, an accepted FAIL review leaves the attempt pending and every pre-existing exit refused', async () => {
    const { world, assessmentId, before } = await deadlocked();
    assert.deepEqual(before.evidenceResolutions.find((resolution) => resolution.requirementId === 'rn.sv.req.sv-08')?.contradictions.map((contradiction) => contradiction.evidenceReferenceIds), [[pilotEvidenceId('sv08-a'), pilotEvidenceId('sv08-b')]]);
    assert.ok(before.controlEvaluations.find((evaluation) => evaluation.controlId === 'SV-08')?.reasonCodes.includes('CONTROL_EVIDENCE_CONTRADICTORY'));
    await assert.rejects(world.service.completeAssessment(PILOT_ORG_CONTEXT, assessmentId), isCode('ASSURANCE_MANUAL_REVIEW_REQUIRED'));
    await assert.rejects(world.service.collectEvidence(PILOT_ORG_CONTEXT, assessmentId, { manualEvidence: fixedRunbook() }), isCode('ASSURANCE_ASSESSMENT_IMMUTABLE'));
    await assert.rejects(world.service.requestReassessment(PILOT_ORG_CONTEXT, { assessmentId, reason: 'x', requestedBy: 'pilot-preparer' }), isCode('ASSURANCE_ASSESSMENT_INCOMPLETE'), 'an attempt that was not ended is still not continued');
  });

  it('B02/B11 an authenticated reviewer ends the attempt as inconclusive: evidence, contradiction and results are kept, the record is attributed and verifies, and a linked new attempt follows', async () => {
    const { logger, lines } = capturingLogger();
    const { world, assessmentId, before } = await deadlocked({ logger });
    const result = await world.service.terminateAssessment(pilotContext(world, 'reviewer'), assessmentId, { ...ENDED, reasonCode: 'unresolved_contradiction' });
    assert.equal(result.outcome, 'terminated');
    const ended = result.assessment;
    assert.equal(ended.status, 'failed');
    assert.deepEqual(contentOf(ended), contentOf(before), 'no evidence, contradiction, result or digest changed');
    const termination = ended.termination;
    assert.ok(termination);
    assert.equal(termination.outcome, 'inconclusive');
    assert.equal(termination.terminatedBy, 'pilot-reviewer', 'from the credential');
    assert.equal(termination.terminatorRole, ASSURANCE_TERMINATION_ROLE);
    assert.equal(termination.authentication, 'assurance_reviewer_credential');
    assert.equal(termination.statusAtTermination, 'manual_review');
    assert.equal(termination.assessmentDigest, before.integrity.assessmentDigest);
    assert.deepEqual(termination.unresolvedContradictions.map((contradiction) => [contradiction.requirementId, ...contradiction.evidenceReferenceIds]), [['rn.sv.req.sv-08', pilotEvidenceId('sv08-a'), pilotEvidenceId('sv08-b')]]);
    assert.deepEqual(await world.service.getAssessment(PILOT_ORG_CONTEXT, assessmentId), ended, 'what is stored is what was returned');
    assert.equal((await world.service.verifyAssessment(PILOT_ORG_CONTEXT, assessmentId)).valid, true);
    assert.equal((await world.store.listManualReviews(PILOT_ORG_CONTEXT, assessmentId)).length, 10, 'the reviews are kept');
    assert.deepEqual(world.events.filter((event) => event.type === 'AssuranceAssessmentFailed' && event.assessmentId === assessmentId).map((event) => (event as { readonly detail?: Readonly<Record<string, unknown>> }).detail?.['termination']), ['unresolved_contradiction']);
    assert.deepEqual(lines.filter((line) => line.message === 'assurance.assessment.terminated').map((line) => line.fields?.status), ['terminated']);
    assert.equal(JSON.stringify(lines).includes(ENDED.rationale), false, 'the rationale is not logged');

    const successor = await world.service.requestReassessment(PILOT_ORG_CONTEXT, { assessmentId, reason: 'New attempt with one authoritative runbook.', requestedBy: 'pilot-preparer' });
    assert.equal(successor.previousAssessmentId, assessmentId);
    assert.equal(successor.supersedesAssessmentId, undefined, 'an inconclusive attempt is followed, never superseded');
    assert.deepEqual(successor.evidenceReferences, [], 'the new attempt collects its evidence afresh');
    assert.notEqual(successor.assessmentId, assessmentId);
    assert.deepEqual(await world.service.getAssessment(PILOT_ORG_CONTEXT, assessmentId), ended, 'the ended attempt is untouched by its successor');
  });

  it('B03-B06 an unauthenticated reviewer, a reviewer without the role, another tenant and the system context end nothing', async () => {
    const { world, assessmentId, before } = await deadlocked();
    const forged = { credentialClass: 'assurance-reviewer', reviewerId: 'pilot-reviewer', organizationId: PILOT_ORG, roles: [RN_SV_REVIEWER_ROLE] } as const;
    const unauthorized = isCode('ASSURANCE_REVIEWER_UNAUTHORIZED');
    await assert.rejects(world.service.terminateAssessment({ ...PILOT_ORG_CONTEXT, actorId: 'pilot-reviewer', roles: [RN_SV_REVIEWER_ROLE], reviewer: forged }, assessmentId, ENDED), unauthorized);
    await assert.rejects(world.service.terminateAssessment({ ...PILOT_ORG_CONTEXT, actorId: 'pilot-reviewer', roles: [RN_SV_REVIEWER_ROLE] }, assessmentId, ENDED), unauthorized);
    await assert.rejects(world.service.terminateAssessment(pilotContext(world, 'approver'), assessmentId, ENDED), unauthorized, 'the release role does not imply it');
    await assert.rejects(world.service.terminateAssessment(pilotContext(world, 'preparer'), assessmentId, ENDED), unauthorized);
    await assert.rejects(world.service.terminateAssessment(pilotContext(world, 'otherReviewer'), assessmentId, ENDED), isCode('ASSURANCE_ASSESSMENT_NOT_FOUND'));
    await assert.rejects(world.service.terminateAssessment(PILOT_SYSTEM_CONTEXT, assessmentId, ENDED), unauthorized);
    await assert.rejects(world.service.terminateAssessment({ ...pilotContext(world, 'reviewer'), actorId: 'someone-else' }, assessmentId, ENDED), unauthorized);
    assert.deepEqual(await world.service.getAssessment(PILOT_ORG_CONTEXT, assessmentId), before, 'nothing changed');
  });

  it('B07/B08 no laundering: a contradiction never becomes PASS, a FAIL review does not settle it, and ending the attempt concludes nothing', async () => {
    const { world, dbPath, assessmentId } = await deadlocked();
    await assert.rejects(world.service.recordManualReview(pilotContext(world, 'reviewer'), pilotReviewInput(assessmentId, 'SV-08', 'pass', ['sv08-a'])), isCode('ASSURANCE_MANUAL_REVIEW_INVALID'));
    const { assessment: ended } = await world.service.terminateAssessment(pilotContext(world, 'reviewer'), assessmentId, ENDED);
    assert.equal(statusOf(ended, 'SV-08'), 'manual_review_required', 'neither PASS nor FAIL');
    assert.deepEqual(await world.service.listFindings(PILOT_ORG_CONTEXT, assessmentId), [], 'no finding is issued for an attempt that concluded nothing');
    assert.equal(findingRows(dbPath, assessmentId), 0);
    await assert.rejects(world.service.evaluateEligibility(PILOT_ORG_CONTEXT, assessmentId), isCode('ASSURANCE_ASSESSMENT_INCOMPLETE'), 'no eligibility is reported for it');
    await assert.rejects(world.service.buildCommercialReportDraft(PILOT_ORG_CONTEXT, assessmentId, { engagement: PILOT_ENGAGEMENT, issue: PILOT_ISSUE }), isCode('ASSURANCE_ASSESSMENT_INCOMPLETE'));
    await assert.rejects(world.service.buildAssuranceReport(PILOT_ORG_CONTEXT, assessmentId, 'CUSTOMER', 'pilot'), isCode('ASSURANCE_ASSESSMENT_INCOMPLETE'));
    await assert.rejects(world.service.evaluateAssessment(PILOT_ORG_CONTEXT, assessmentId), isCode('ASSURANCE_ASSESSMENT_IMMUTABLE'));
    await assert.rejects(world.service.recordManualReview(pilotContext(world, 'reviewer'), pilotReviewInput(assessmentId, 'SV-08', 'pass', ['sv08-a'])), isCode('ASSURANCE_MANUAL_REVIEW_INVALID'), 'still no PASS after the end');
  });

  it('B09 positive and negative cases are reached in the new attempt, on new evidence: one authoritative runbook supports PASS, or a FAIL review bound to it gives FAIL', async () => {
    const pass = await deadlocked();
    await pass.world.service.terminateAssessment(pilotContext(pass.world, 'reviewer'), pass.assessmentId, ENDED);
    const passed = await followWith(pass.world, pass.assessmentId, fixedRunbook(), ['pass', ['sv08-fixed']]);
    assert.equal(statusOf(passed, 'SV-08'), 'pass');
    const completed = await pass.world.service.completeAssessment(PILOT_ORG_CONTEXT, passed.assessmentId);
    assert.equal(completed.status, 'completed');
    assert.equal((await pass.world.service.verifyAssessment(PILOT_ORG_CONTEXT, completed.assessmentId)).valid, true);
    assert.ok(completed.evidenceReferences.every((reference) => reference.evidenceReferenceId === pilotEvidenceId('sv08-fixed')), 'the new evidence has its own identity; the contradictory copies stay with the ended attempt');

    const fail = await deadlocked();
    await fail.world.service.terminateAssessment(pilotContext(fail.world, 'reviewer'), fail.assessmentId, ENDED);
    const failed = await followWith(fail.world, fail.assessmentId, fixedRunbook(), ['fail', ['sv08-fixed']]);
    assert.equal(statusOf(failed, 'SV-08'), 'fail', 'an observed failure, on consistent evidence');
    assert.equal((await fail.world.service.completeAssessment(PILOT_ORG_CONTEXT, failed.assessmentId)).status, 'completed');
  });

  it('B10 new evidence that is contradictory too leaves the new attempt inconclusive; it can be ended in turn, and the chain stays linked', async () => {
    const first = await deadlocked();
    await first.world.service.terminateAssessment(pilotContext(first.world, 'reviewer'), first.assessmentId, ENDED);
    // Two NEW copies (their own identities) of another runbook, again with different digests.
    const contradictoryAgain = ['sv08-c', 'sv08-d'].map((id) => pilotArtifact(id, 'SV-08', { subjectId: SUBJECT, externalId: 'https://internal.pilot-coop.invalid/sv08-runbook-v3', digest: computeDigest({ pilot01: 'sv08-v3', copy: id }) }));
    const second = await followWith(first.world, first.assessmentId, contradictoryAgain, ['fail', ['sv08-c']]);
    assert.equal(second.status, 'manual_review');
    assert.equal(statusOf(second, 'SV-08'), 'manual_review_required', 'the FAIL review settles nothing here either');
    await assert.rejects(first.world.service.completeAssessment(PILOT_ORG_CONTEXT, second.assessmentId), isCode('ASSURANCE_MANUAL_REVIEW_REQUIRED'));
    const ended = await first.world.service.terminateAssessment(pilotContext(first.world, 'reviewer'), second.assessmentId, ENDED);
    assert.equal(ended.assessment.previousAssessmentId, first.assessmentId);
    assert.deepEqual(ended.assessment.termination?.unresolvedContradictions.flatMap((contradiction) => contradiction.evidenceReferenceIds), [pilotEvidenceId('sv08-c'), pilotEvidenceId('sv08-d')]);
    const third = await first.world.service.requestReassessment(PILOT_ORG_CONTEXT, { assessmentId: second.assessmentId, reason: 'Third attempt.', requestedBy: 'pilot-preparer' });
    assert.equal(third.previousAssessmentId, second.assessmentId);
  });

  it('B12 a rejected reference (another tenant) does not satisfy the requirement in the new attempt: no PASS on it', async () => {
    const { world, assessmentId } = await deadlocked();
    await world.service.terminateAssessment(pilotContext(world, 'reviewer'), assessmentId, ENDED);
    const foreign = [pilotArtifact('sv08-foreign', 'SV-08', { subjectId: SUBJECT, organizationId: 'pilot-org-other-synthetic' })];
    const successor = await world.service.requestReassessment(PILOT_ORG_CONTEXT, { assessmentId, reason: 'Retry.', requestedBy: 'pilot-preparer' });
    await world.service.collectEvidence(PILOT_ORG_CONTEXT, successor.assessmentId, { manualEvidence: foreign });
    const evaluated = await world.service.evaluateAssessment(PILOT_ORG_CONTEXT, successor.assessmentId);
    const resolution = evaluated.evidenceResolutions.find((candidate) => candidate.requirementId === 'rn.sv.req.sv-08');
    assert.equal(resolution?.status, 'unsatisfied');
    assert.ok(resolution?.rejectedEvidence.some((rejected) => rejected.reasonCodes.includes('EVIDENCE_WRONG_TENANT')));
    await assert.rejects(world.service.recordManualReview(pilotContext(world, 'reviewer'), pilotReviewInput(successor.assessmentId, 'SV-08', 'pass', ['sv08-foreign'])), isCode('ASSURANCE_MANUAL_REVIEW_INVALID'));
  });

  it('B13 a termination record or its binding altered in storage fails verification, and the attempt can no longer be continued', async () => {
    const { world, dbPath, assessmentId } = await deadlocked();
    await world.service.terminateAssessment(pilotContext(world, 'reviewer'), assessmentId, ENDED);
    const raw = new Database(dbPath);
    try {
      const row = raw.prepare('SELECT assessment_json FROM assurance_assessments WHERE assessment_id = ?').get(assessmentId) as { assessment_json: string };
      const stored = JSON.parse(row.assessment_json) as { termination: { terminatedBy: string } };
      stored.termination.terminatedBy = 'pilot-reviewer-2';
      raw.prepare('UPDATE assurance_assessments SET assessment_json = ? WHERE assessment_id = ?').run(JSON.stringify(stored), assessmentId);
    } finally {
      raw.close();
    }
    const verification = await world.service.verifyAssessment(PILOT_ORG_CONTEXT, assessmentId);
    assert.equal(verification.valid, false);
    assert.ok(verification.failures.some((failure) => failure.check === 'integrity' && /Termination record: terminationDigest does not recompute/.test(failure.message)));
    await assert.rejects(world.service.requestReassessment(PILOT_ORG_CONTEXT, { assessmentId, reason: 'Retry.', requestedBy: 'pilot-preparer' }), isCode('ASSURANCE_INTEGRITY_FAILED'));
  });

  it('B14 a completed assessment cannot be ended, and stays completed and releasable', async () => {
    const world = await open(join(tempDir(), 'assurance.db'));
    const { assessment } = await runPilotHappyPath(world);
    await assert.rejects(world.service.terminateAssessment(pilotContext(world, 'reviewer'), assessment.assessmentId, { reasonCode: 'engagement_withdrawn', rationale: 'Too late.' }), isCode('ASSURANCE_ASSESSMENT_IMMUTABLE', 'assessment_terminal'));
    assert.equal((await world.service.getAssessment(PILOT_ORG_CONTEXT, assessment.assessmentId))?.status, 'completed');
    assert.equal((await world.service.listCommercialReleases(PILOT_ORG_CONTEXT, assessment.assessmentId)).length, 1, 'its release custody is intact (REL-01A)');
  });

  it('B15 ending requires a recognized reason and a rationale; an unresolved contradiction is recorded only when the evidence does contradict itself', async () => {
    const dbPath = join(tempDir(), 'assurance.db');
    const world = await open(dbPath);
    const created = await world.service.createAssessment(PILOT_ORG_CONTEXT, { subject: { subjectType: 'system', subjectId: 'withdrawn-subject', organizationId: PILOT_ORG }, frameworkId: 'rn.sv', frameworkVersion: '0.1.0', requestedBy: 'pilot-preparer', evidenceCutoffAt: PILOT_CUTOFF });
    const reviewer = pilotContext(world, 'reviewer');
    const invalid = isCode('ASSURANCE_VALIDATION_ERROR');
    await assert.rejects(world.service.terminateAssessment(reviewer, created.assessmentId, { reasonCode: 'unresolved_contradiction', rationale: 'No contradiction here.' }), invalid);
    await assert.rejects(world.service.terminateAssessment(reviewer, created.assessmentId, { reasonCode: 'because' as never, rationale: 'x' }), invalid);
    await assert.rejects(world.service.terminateAssessment(reviewer, created.assessmentId, { reasonCode: 'engagement_withdrawn', rationale: '   ' }), invalid);
    await assert.rejects(world.service.terminateAssessment(reviewer, created.assessmentId, { reasonCode: 'engagement_withdrawn', rationale: 'x'.repeat(2001) }), invalid);
    const withdrawn = await world.service.terminateAssessment(reviewer, created.assessmentId, { reasonCode: 'engagement_withdrawn', rationale: 'The customer withdrew the engagement before evidence was supplied.' });
    assert.equal(withdrawn.assessment.termination?.statusAtTermination, 'created');
    assert.deepEqual(withdrawn.assessment.termination?.unresolvedContradictions, []);
    assert.equal((await world.service.verifyAssessment(PILOT_ORG_CONTEXT, created.assessmentId)).valid, true);
  });

  it('B16 an identical retry returns the kept termination and writes nothing; a different one is refused', async () => {
    const { world, assessmentId } = await deadlocked();
    const first = await world.service.terminateAssessment(pilotContext(world, 'reviewer'), assessmentId, ENDED);
    const again = await world.service.terminateAssessment(pilotContext(world, 'reviewer'), assessmentId, ENDED);
    assert.equal(again.outcome, 'replayed');
    assert.deepEqual(again.assessment, first.assessment);
    assert.equal(world.events.filter((event) => event.type === 'AssuranceAssessmentFailed' && event.assessmentId === assessmentId).length, 1);
    await assert.rejects(world.service.terminateAssessment(pilotContext(world, 'reviewer'), assessmentId, { ...ENDED, rationale: 'Another reason.' }), isCode('ASSURANCE_ASSESSMENT_IMMUTABLE', 'assessment_already_terminated'));
    await assert.rejects(world.service.terminateAssessment(contextOf(world, SECOND_REVIEWER), assessmentId, ENDED), isCode('ASSURANCE_ASSESSMENT_IMMUTABLE', 'assessment_already_terminated'));
  });

  it('B17 two reviewers ending it concurrently through two connections to one file yield one termination; an end racing an evaluation leaves a coherent state', async () => {
    const { world, dbPath, assessmentId } = await deadlocked();
    const other = await open(dbPath, { startTick: 500_000, startId: 50_000 });
    const outcomes = await Promise.allSettled([
      world.service.terminateAssessment(pilotContext(world, 'reviewer'), assessmentId, ENDED),
      other.service.terminateAssessment(contextOf(other, SECOND_REVIEWER), assessmentId, ENDED),
    ]);
    const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled');
    const rejected = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.ok(isCode('ASSURANCE_ASSESSMENT_IMMUTABLE', 'assessment_already_terminated')(rejected[0]?.reason), String(rejected[0]?.reason));
    const stored = await world.service.getAssessment(PILOT_ORG_CONTEXT, assessmentId);
    assert.equal(stored?.status, 'failed');
    assert.equal((await world.service.verifyAssessment(PILOT_ORG_CONTEXT, assessmentId)).valid, true);

    const race = await deadlocked();
    const raced = await Promise.allSettled([
      race.world.service.evaluateAssessment(PILOT_ORG_CONTEXT, race.assessmentId),
      race.world.service.terminateAssessment(pilotContext(race.world, 'reviewer'), race.assessmentId, ENDED),
    ]);
    assert.equal(raced[1]?.status, 'fulfilled', 'the end is not lost to the evaluation');
    const final = await race.world.service.getAssessment(PILOT_ORG_CONTEXT, race.assessmentId);
    assert.equal(final?.status, 'failed');
    assert.equal((await race.world.service.verifyAssessment(PILOT_ORG_CONTEXT, race.assessmentId)).valid, true, 'the termination is bound to the content that was stored');
  });

  it('B18 a write failure while ending gives no success, no event, no log and no partial state; the retry ends it once', async () => {
    const { logger, lines } = capturingLogger();
    const { world, dbPath, assessmentId, before } = await deadlocked({ logger });
    const raw = new Database(dbPath);
    try {
      raw.exec(`CREATE TRIGGER rel01b_inject BEFORE UPDATE ON assurance_assessments WHEN NEW.status = 'failed' BEGIN SELECT RAISE(ABORT, 'rel01b injected'); END`);
      await assert.rejects(world.service.terminateAssessment(pilotContext(world, 'reviewer'), assessmentId, ENDED), (error: unknown) => {
        assert.ok(error instanceof AssuranceError && error.code === 'ASSURANCE_STORE_UNAVAILABLE', String(error));
        assert.equal(error.details?.['retryable'], true);
        assert.equal(/injected|SQLITE|assurance\.db|\//.test(error.message), false, error.message);
        return true;
      });
      assert.deepEqual(await world.service.getAssessment(PILOT_ORG_CONTEXT, assessmentId), before);
      assert.equal(world.events.some((event) => event.type === 'AssuranceAssessmentFailed'), false);
      assert.equal(lines.some((line) => line.message === 'assurance.assessment.terminated'), false);
      raw.exec('DROP TRIGGER rel01b_inject');
    } finally {
      raw.close();
    }
    assert.equal((await world.service.terminateAssessment(pilotContext(world, 'reviewer'), assessmentId, ENDED)).outcome, 'terminated');
    assert.equal(world.events.filter((event) => event.type === 'AssuranceAssessmentFailed').length, 1);
  });

  it('B19/B20 the ended attempt survives a restart and a portability backup and restore, verifies, and can be continued from either', async () => {
    const portability = (await import(pathToFileURL(join(process.cwd(), 'scripts', 'portability', 'lib-portability.mjs')).href)) as { safeSqliteCopy(source: string, destination: string): Promise<void> };
    const { world, dbPath, assessmentId } = await deadlocked();
    const { assessment: ended } = await world.service.terminateAssessment(pilotContext(world, 'reviewer'), assessmentId, ENDED);
    await world.store.close();
    const restarted = await open(dbPath, { startTick: 1_000_000, startId: 100_000 });
    assert.deepEqual(await restarted.service.getAssessment(PILOT_ORG_CONTEXT, assessmentId), ended);
    assert.equal((await restarted.service.verifyAssessment(PILOT_ORG_CONTEXT, assessmentId)).valid, true);
    const backup = join(tempDir(), 'assurance.sqlite');
    await portability.safeSqliteCopy(dbPath, backup);
    const restored = await open(backup, { startTick: 2_000_000, startId: 200_000 });
    assert.deepEqual(await restored.service.getAssessment(PILOT_ORG_CONTEXT, assessmentId), ended);
    assert.equal((await restored.service.terminateAssessment(pilotContext(restored, 'reviewer'), assessmentId, ENDED)).outcome, 'replayed');
    assert.equal((await restored.service.requestReassessment(PILOT_ORG_CONTEXT, { assessmentId, reason: 'After restore.', requestedBy: 'pilot-preparer' })).previousAssessmentId, assessmentId);
  });

  it('B-13 SEC-01E gap closed: a failed attempt saved by the store gets no finding rows without history', async () => {
    const { world, dbPath, assessmentId, before } = await deadlocked();
    assert.ok(before.findings.length > 0, 'the working set holds findings');
    await world.store.saveAssessment(PILOT_ORG_CONTEXT, { ...before, status: 'failed', failureReason: 'synthetic evaluation failure' });
    assert.equal(findingRows(dbPath, assessmentId), 0);
    assert.deepEqual(await world.store.listFindings(PILOT_ORG_CONTEXT, assessmentId), []);
    // An attempt that failed without being ended has no termination record: it is neither continued nor ended after the fact (B-06: explicit intent only).
    await assert.rejects(world.service.requestReassessment(PILOT_ORG_CONTEXT, { assessmentId, reason: 'Retry.', requestedBy: 'pilot-preparer' }), isCode('ASSURANCE_ASSESSMENT_INCOMPLETE'));
    await assert.rejects(world.service.terminateAssessment(pilotContext(world, 'reviewer'), assessmentId, ENDED), isCode('ASSURANCE_ASSESSMENT_IMMUTABLE', 'assessment_terminal'));
  });

  it('B21/B22 an inconclusive attempt yields no commercial report and no release; REL-01A custody of a completed report is unaffected', async () => {
    const { world, assessmentId } = await deadlocked();
    await world.service.terminateAssessment(pilotContext(world, 'reviewer'), assessmentId, ENDED);
    await assert.rejects(releasePilotReport(world, assessmentId), isCode('ASSURANCE_ASSESSMENT_INCOMPLETE'));
    assert.deepEqual(await world.service.listCommercialReleases(PILOT_ORG_CONTEXT, assessmentId), []);
    const released = await open(join(tempDir(), 'assurance.db'));
    const { assessment, release } = await runPilotHappyPath(released);
    assert.equal((await released.service.getCommercialRelease(PILOT_ORG_CONTEXT, release.reportId))?.release.releaseDigest, release.releaseDigest);
    assert.equal(assessment.termination, undefined);
  });

  it('B23/B24 an aoc.saf attempt can be ended the same way, and both framework definitions keep their golden digests', async () => {
    const world = await open(join(tempDir(), 'assurance.db'));
    const saf = await world.service.createAssessment(PILOT_ORG_CONTEXT, { subject: { subjectType: 'agent', subjectId: 'rel01b-agent', organizationId: PILOT_ORG }, frameworkId: AOC_SAF_FRAMEWORK_ID, frameworkVersion: AOC_SAF_FRAMEWORK_VERSION, requestedBy: 'pilot-preparer', evidenceCutoffAt: PILOT_CUTOFF });
    const ended = await world.service.terminateAssessment(pilotContext(world, 'reviewer'), saf.assessmentId, { reasonCode: 'engagement_withdrawn', rationale: 'Agent decommissioned before evaluation.' });
    assert.equal(ended.assessment.status, 'failed');
    assert.equal((await world.service.verifyAssessment(PILOT_ORG_CONTEXT, saf.assessmentId)).valid, true);
    assert.equal(computeDigest(RN_SV_FRAMEWORK_V0_1), 'sha256:e71fafe1a10af95514823e35d43138b1b93cdb72e37765200447a37748c13a58');
    assert.equal(computeDigest(AOC_SAF_FRAMEWORK_V1), 'sha256:4c0b5c65a0b8cfe40de726f26d80b80224fac6ca80fe2c221f7a734548899bb9');
  });
});
