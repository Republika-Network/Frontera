import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AssuranceError } from '../assurance/errors.js';
import { computeDigest } from '../governance-store/digest.js';
import { RN_SV_FRAMEWORK_V0_1 } from '../assurance/frameworks/rn-sv-framework.js';
import { AOC_SAF_FRAMEWORK_V1 } from '../assurance/saf-framework.js';
import { assessmentWritePrecondition, type AssuranceStore } from '../assurance/assurance-store.js';
import { createSqliteAssuranceStore } from '../assurance/sqlite-assurance-store.js';
import { createInMemoryAssuranceStore } from '../assurance/in-memory-assurance-store.js';
import { assessmentTerminationViolations } from '../assurance/assessment-termination.js';
import { mapAssuranceErrorToHttp } from '../api/enterprise-http-errors.js';
import type { AssuranceAssessment, AssuranceEvidenceReference } from '../assurance/contracts.js';
import {
  PILOT_CUTOFF,
  PILOT_ORG,
  PILOT_ORG_CONTEXT,
  buildPilotWorld,
  pilotArtifact,
  pilotContext,
  pilotEvidence,
  preparePilotAssessment,
  reviewPilotAssessment,
  type PilotWorld,
} from './assure-pilot-01-scenario.js';

/**
 * ASSURE-REL-01D Stage 0 -- nonterminal assessment writes are compare-and-set.
 *
 * Before REL-01D two writers of a nonterminal assessment were last-writer-wins
 * (ASSURE-REL-01B §10): the second save replaced the first one's evidence or
 * evaluation with a snapshot computed from an older state. Now every rewrite
 * names the stored state it read (status + integrity.assessmentDigest) and the
 * store refuses it, under its write lock, when that state changed.
 *
 * The races below are real: two services over two SQLite connections to one
 * file. A read barrier makes both writers read before either writes, so the
 * conflict is forced, not left to scheduling.
 */

const RN_SV_GOLDEN_DIGEST = 'sha256:e71fafe1a10af95514823e35d43138b1b93cdb72e37765200447a37748c13a58';
const AOC_SAF_GOLDEN_DIGEST = 'sha256:4c0b5c65a0b8cfe40de726f26d80b80224fac6ca80fe2c221f7a734548899bb9';

const tempDirs: string[] = [];
const stores: AssuranceStore[] = [];
after(async () => {
  for (const store of stores) await store.close().catch(() => {});
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});
const dbFile = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'assure-rel-01d-cas-'));
  tempDirs.push(dir);
  return join(dir, 'assurance.db');
};

/**
 * The race harness. Armed for one race at a time:
 *  - a read barrier lets the two writers through only once both have read, so
 *    each computes its write from the same stored state;
 *  - optionally a write order holds side B's writes until side A's first write
 *    has landed (or A's operation ended without one), forcing the interleaving
 *    in which the shorter operation loses -- left to scheduling it would win
 *    every time and the stale-overwrite path would never run.
 * Unarmed, the wrapped stores behave exactly like the stores they wrap.
 */
interface RaceHarness {
  wrap(store: AssuranceStore, side: 'a' | 'b'): AssuranceStore;
  race<A, B>(first: () => Promise<A>, second: () => Promise<B>, options?: { readonly aWritesFirst?: boolean }): Promise<[PromiseSettledResult<A>, PromiseSettledResult<B>]>;
}
function raceHarness(): RaceHarness {
  interface Armed {
    remaining: number;
    readonly releaseReads: () => void;
    readonly reads: Promise<void>;
    readonly ordered: boolean;
    readonly releaseB: () => void;
    readonly aWrote: Promise<void>;
  }
  let armed: Armed | undefined;
  const call = (target: AssuranceStore, value: unknown, args: unknown[]): Promise<unknown> => (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
  return {
    wrap(store, side) {
      return new Proxy(store, {
        get(target, property, receiver) {
          const value: unknown = Reflect.get(target, property, receiver);
          if (typeof value !== 'function') return value;
          if (property === 'getAssessment') {
            return async (...args: unknown[]) => {
              const read = await call(target, value, args);
              const current = armed;
              if (current !== undefined) {
                current.remaining -= 1;
                if (current.remaining <= 0) current.releaseReads();
                await current.reads;
              }
              return read;
            };
          }
          if (property === 'saveAssessment' || property === 'completeAssessment') {
            return async (...args: unknown[]) => {
              const current = armed;
              if (current === undefined || !current.ordered) return call(target, value, args);
              if (side === 'b') {
                await current.aWrote;
                return call(target, value, args);
              }
              try {
                return await call(target, value, args);
              } finally {
                current.releaseB();
              }
            };
          }
          return (value as (...a: unknown[]) => unknown).bind(target);
        },
      });
    },
    async race(first, second, options = {}) {
      let releaseReads = (): void => {};
      const reads = new Promise<void>((resolve) => (releaseReads = resolve));
      let releaseB = (): void => {};
      const aWrote = new Promise<void>((resolve) => (releaseB = resolve));
      const current: Armed = { remaining: 2, releaseReads, reads, ordered: options.aWritesFirst === true, releaseB, aWrote };
      armed = current;
      try {
        // A that ends without writing must not leave B waiting forever.
        return await Promise.allSettled([first().finally(() => current.releaseB()), second()]);
      } finally {
        current.releaseReads();
        current.releaseB();
        armed = undefined;
      }
    },
  };
}

interface RaceWorlds {
  readonly a: PilotWorld;
  readonly b: PilotWorld;
  readonly harness: RaceHarness;
}
/** Two services over two connections to one SQLite file, both behind one race harness. */
async function twoConnections(): Promise<RaceWorlds> {
  const path = dbFile();
  const harness = raceHarness();
  const a = await buildPilotWorld(path, { wrapStore: (store) => harness.wrap(store, 'a') });
  const b = await buildPilotWorld(path, { startTick: 500_000, startId: 50_000, wrapStore: (store) => harness.wrap(store, 'b') });
  stores.push(a.store, b.store);
  return { a, b, harness };
}

async function created(world: PilotWorld, subjectId = 'cas-subject'): Promise<AssuranceAssessment> {
  return world.service.createAssessment(PILOT_ORG_CONTEXT, {
    subject: { subjectType: 'system', subjectId, organizationId: PILOT_ORG },
    frameworkId: 'rn.sv',
    frameworkVersion: '0.1.0',
    requestedBy: 'cas-preparer',
    evidenceCutoffAt: PILOT_CUTOFF,
  });
}

const isCode = (code: string) => (error: unknown) => error instanceof AssuranceError && error.code === code;
const isConflict = (reason: unknown): boolean =>
  reason instanceof AssuranceError && reason.code === 'ASSURANCE_ASSESSMENT_CONFLICT' && reason.details?.['reason'] === 'concurrent_modification' && reason.details?.['retryable'] === true;
const refIds = (assessment: AssuranceAssessment | null | undefined): readonly string[] => (assessment?.evidenceReferences ?? []).map((reference) => reference.evidenceReferenceId).sort();

/** A second, distinct evidence set for the same requirements (different ids and digests). */
function alternativeEvidence(): AssuranceEvidenceReference[] {
  return ['SV-01', 'SV-02', 'SV-03'].map((controlId) =>
    pilotArtifact(`alt-${controlId.toLowerCase()}`, controlId, { digest: computeDigest({ rel01d: 'alternative', controlId }) }),
  );
}

describe('ASSURE-REL-01D Stage 0 -- compare-and-set for nonterminal assessment writes', () => {
  it('C01 store level, two SQLite connections: a writer that read an older state writes nothing and gets a typed, retryable conflict', async () => {
    const path = dbFile();
    const seed = await buildPilotWorld(path);
    stores.push(seed.store);
    const assessment = await created(seed);
    const one = await createSqliteAssuranceStore(path, { now: () => '2026-10-28T10:00:00.000Z' });
    const two = await createSqliteAssuranceStore(path, { now: () => '2026-10-28T10:00:00.000Z' });
    stores.push(one, two);

    const readOne = await one.getAssessment(PILOT_ORG_CONTEXT, assessment.assessmentId);
    const readTwo = await two.getAssessment(PILOT_ORG_CONTEXT, assessment.assessmentId);
    assert.ok(readOne && readTwo);
    const first = { ...readOne, status: 'collecting_evidence' as const, evidenceReferences: [pilotArtifact('first-writer', 'SV-01')] };
    await one.saveAssessment(PILOT_ORG_CONTEXT, first, assessmentWritePrecondition(readOne));

    // Same digest (still unsealed), different status: a status-only change is a change.
    await assert.rejects(
      two.saveAssessment(PILOT_ORG_CONTEXT, { ...readTwo, status: 'collecting_evidence', evidenceReferences: [pilotArtifact('second-writer', 'SV-01')] }, assessmentWritePrecondition(readTwo)),
      (error: unknown) => isConflict(error),
    );
    assert.deepEqual(refIds(await two.getAssessment(PILOT_ORG_CONTEXT, assessment.assessmentId)), refIds(first));

    // Same status, different content digest: also a change.
    const reread = await two.getAssessment(PILOT_ORG_CONTEXT, assessment.assessmentId);
    assert.ok(reread);
    await one.saveAssessment(PILOT_ORG_CONTEXT, { ...reread, integrity: { ...reread.integrity, assessmentDigest: 'sha256:moved-on' } }, assessmentWritePrecondition(reread));
    await assert.rejects(two.saveAssessment(PILOT_ORG_CONTEXT, { ...reread, evidenceReferences: [] }, assessmentWritePrecondition(reread)), (error: unknown) => isConflict(error));
    assert.equal((await one.getAssessment(PILOT_ORG_CONTEXT, assessment.assessmentId))?.integrity.assessmentDigest, 'sha256:moved-on');
  });

  it('C02 the in-memory store has the same conflict semantics', async () => {
    const store = createInMemoryAssuranceStore({ now: () => '2026-10-28T10:00:00.000Z' });
    const world = await buildPilotWorld('', { inMemory: true, wrapStore: () => store });
    const assessment = await created(world);
    const readA = await store.getAssessment(PILOT_ORG_CONTEXT, assessment.assessmentId);
    const readB = await store.getAssessment(PILOT_ORG_CONTEXT, assessment.assessmentId);
    assert.ok(readA && readB);
    await store.saveAssessment(PILOT_ORG_CONTEXT, { ...readA, status: 'collecting_evidence' }, assessmentWritePrecondition(readA));
    await assert.rejects(store.saveAssessment(PILOT_ORG_CONTEXT, { ...readB, status: 'collecting_evidence', evidenceReferences: [] }, assessmentWritePrecondition(readB)), (error: unknown) => isConflict(error));
  });

  it('C03 terminal immutability is checked first and keeps its own error; an unconditional legacy save still behaves as before', async () => {
    const path = dbFile();
    const world = await buildPilotWorld(path);
    stores.push(world.store);
    const assessment = await created(world);
    const read = await world.store.getAssessment(PILOT_ORG_CONTEXT, assessment.assessmentId);
    assert.ok(read);
    // Legacy (no precondition): still allowed while nonterminal.
    await world.store.saveAssessment(PILOT_ORG_CONTEXT, { ...read, status: 'failed', failureReason: 'synthetic' });
    const failed = await world.store.getAssessment(PILOT_ORG_CONTEXT, assessment.assessmentId);
    assert.ok(failed);
    // A precondition that matches the terminal state does not unlock it.
    await assert.rejects(world.store.saveAssessment(PILOT_ORG_CONTEXT, { ...failed, status: 'evaluating' }, assessmentWritePrecondition(failed)), isCode('ASSURANCE_ASSESSMENT_IMMUTABLE'));
  });

  it('C04 two concurrent evidence writers through two connections: exactly one evidence set is stored, the loser writes nothing', async () => {
    const { a, b, harness } = await twoConnections();
    const assessment = await created(a);
    const [first, second] = await harness.race(
      () => a.service.collectEvidence(PILOT_ORG_CONTEXT, assessment.assessmentId, { manualEvidence: pilotEvidence() }),
      () => b.service.collectEvidence(PILOT_ORG_CONTEXT, assessment.assessmentId, { manualEvidence: alternativeEvidence() }),
    );
    const settled = [first, second];
    const winners = settled.filter((outcome): outcome is PromiseFulfilledResult<AssuranceAssessment> => outcome.status === 'fulfilled');
    const losers = settled.filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
    assert.equal(winners.length, 1, 'exactly one writer succeeds');
    assert.equal(losers.length, 1);
    assert.ok(isConflict(losers[0]?.reason), String(losers[0]?.reason));
    const stored = await a.service.getAssessment(PILOT_ORG_CONTEXT, assessment.assessmentId);
    assert.deepEqual(refIds(stored), refIds(winners[0]?.value), 'the stored evidence is exactly the winner’s');
    assert.deepEqual(stored, winners[0]?.value);
    assert.equal((await a.service.verifyAssessment(PILOT_ORG_CONTEXT, assessment.assessmentId)).valid, true);
  });

  it('C05 two concurrent evaluations: one result is stored, the other is a conflict and is not recorded as a failure', async () => {
    const { a, b, harness } = await twoConnections();
    const prepared = await preparePilotAssessment(a);
    const [first, second] = await harness.race(
      () => a.service.evaluateAssessment(PILOT_ORG_CONTEXT, prepared.assessmentId),
      () => b.service.evaluateAssessment(PILOT_ORG_CONTEXT, prepared.assessmentId),
    );
    const settled = [first, second];
    const winners = settled.filter((outcome): outcome is PromiseFulfilledResult<AssuranceAssessment> => outcome.status === 'fulfilled');
    const losers = settled.filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
    assert.equal(winners.length, 1);
    assert.ok(isConflict(losers[0]?.reason), String(losers[0]?.reason));
    const stored = await a.service.getAssessment(PILOT_ORG_CONTEXT, prepared.assessmentId);
    assert.deepEqual(stored, winners[0]?.value);
    assert.notEqual(stored?.status, 'failed', 'a lost race is not an evaluation failure');
    assert.equal([...a.events, ...b.events].some((event) => event.type === 'AssuranceAssessmentFailed'), false);
  });

  it('C06 evaluation racing termination: the end is never lost and never overwrites a newer evaluation with a stale snapshot', async () => {
    // Round 0 forces the evaluation to write first (the end then loses the race and must re-read); the others are left to scheduling.
    for (let round = 0; round < 3; round += 1) {
      const forced = round === 0;
      const { a, b, harness } = await twoConnections();
      const prepared = await preparePilotAssessment(a);
      const preparedRead = prepared;
      const [evaluation, termination] = await harness.race(
        () => a.service.evaluateAssessment(PILOT_ORG_CONTEXT, prepared.assessmentId),
        () => b.service.terminateAssessment(pilotContext(b, 'reviewer'), prepared.assessmentId, { reasonCode: 'engagement_withdrawn', rationale: 'Synthetic race: the engagement ended.' }),
        { aWritesFirst: forced },
      );
      assert.equal(termination.status, 'fulfilled', String(termination.status === 'rejected' ? termination.reason : ''));
      const stored = await a.service.getAssessment(PILOT_ORG_CONTEXT, prepared.assessmentId);
      assert.ok(stored);
      assert.equal(stored.status, 'failed');
      assert.deepEqual(assessmentTerminationViolations(stored), []);
      if (forced) assert.equal(evaluation.status, 'fulfilled', 'the forced round runs the evaluation-first interleaving');
      if (evaluation.status === 'fulfilled') {
        // The evaluation landed first: the end was re-read and bound to the evaluation's content.
        assert.notEqual(evaluation.value.integrity.assessmentDigest, preparedRead.integrity.assessmentDigest, 'the evaluation changed the stored content');
        assert.deepEqual(stored.controlEvaluations, evaluation.value.controlEvaluations);
        assert.equal(stored.termination?.assessmentDigest, evaluation.value.integrity.assessmentDigest);
      } else {
        assert.ok(isCode('ASSURANCE_ASSESSMENT_IMMUTABLE')(evaluation.reason), String(evaluation.reason));
        assert.equal(stored.integrity.assessmentDigest, prepared.integrity.assessmentDigest, 'the stale evaluation wrote nothing');
      }
      assert.equal((await a.service.verifyAssessment(PILOT_ORG_CONTEXT, prepared.assessmentId)).valid, true);
    }
  });

  it('C07 a completion computed from a state another writer replaced is refused, not committed over it', async () => {
    // Once reviewed, an rn.sv attempt is 'evaluating': nothing but a completion, an end or a nonterminal rewrite
    // can follow. The rewrite (A, through the other connection) is forced to land first, so the completion (B)
    // was computed from a state that no longer exists.
    const { a, b, harness } = await twoConnections();
    const prepared = await preparePilotAssessment(a);
    const reviewed = await reviewPilotAssessment(a, prepared.assessmentId);
    assert.equal(reviewed.status, 'evaluating');
    const [rewrite, completion] = await harness.race(
      async () => {
        const read = await a.store.getAssessment(PILOT_ORG_CONTEXT, reviewed.assessmentId);
        assert.ok(read);
        await a.store.saveAssessment(PILOT_ORG_CONTEXT, { ...read, integrity: { ...read.integrity, assessmentDigest: 'sha256:concurrent-rewrite' } }, assessmentWritePrecondition(read));
      },
      () => b.service.completeAssessment(PILOT_ORG_CONTEXT, reviewed.assessmentId),
      { aWritesFirst: true },
    );
    assert.equal(rewrite.status, 'fulfilled', String(rewrite.status === 'rejected' ? rewrite.reason : ''));
    assert.equal(completion.status, 'rejected');
    assert.ok(isConflict(completion.status === 'rejected' ? completion.reason : undefined), String(completion.status === 'rejected' ? completion.reason : ''));
    const stored = await a.store.getAssessment(PILOT_ORG_CONTEXT, reviewed.assessmentId);
    assert.equal(stored?.status, 'evaluating', 'no completion was committed');
    assert.equal(stored?.integrity.assessmentDigest, 'sha256:concurrent-rewrite', 'the other writer\u2019s state is kept');
    assert.deepEqual(await a.store.listFindings(PILOT_ORG_CONTEXT, reviewed.assessmentId), [], 'no finding history was opened');
    assert.equal([...a.events, ...b.events].some((event) => event.type === 'AssuranceAssessmentCompleted'), false);
  });

  it('C08 a stale writer cannot overwrite a termination', async () => {
    const { a, b } = await twoConnections();
    const prepared = await preparePilotAssessment(a);
    const stale = await b.store.getAssessment(PILOT_ORG_CONTEXT, prepared.assessmentId);
    assert.ok(stale);
    const ended = await a.service.terminateAssessment(pilotContext(a, 'reviewer'), prepared.assessmentId, { reasonCode: 'engagement_withdrawn', rationale: 'Ended before the stale write.' });
    await assert.rejects(b.store.saveAssessment(PILOT_ORG_CONTEXT, { ...stale, status: 'evaluating' }, assessmentWritePrecondition(stale)), isCode('ASSURANCE_ASSESSMENT_IMMUTABLE'));
    assert.deepEqual(await b.service.getAssessment(PILOT_ORG_CONTEXT, prepared.assessmentId), ended.assessment);
  });

  it('C10 no service path rewrites a stored assessment unconditionally: only the first save of an assessment carries no precondition', async () => {
    const saves: { readonly assessmentId: string; readonly conditioned: boolean }[] = [];
    const world = await buildPilotWorld(dbFile(), {
      wrapStore: (store) =>
        new Proxy(store, {
          get(target, property, receiver) {
            const value: unknown = Reflect.get(target, property, receiver);
            if (typeof value !== 'function') return value;
            if (property === 'saveAssessment') {
              return (context: unknown, assessment: AssuranceAssessment, expected?: unknown) => {
                saves.push({ assessmentId: assessment.assessmentId, conditioned: expected !== undefined });
                return (value as (...a: unknown[]) => Promise<void>).call(target, context, assessment, expected);
              };
            }
            if (property === 'completeAssessment') {
              return (context: unknown, commit: { assessment: AssuranceAssessment; expected?: unknown }) => {
                saves.push({ assessmentId: commit.assessment.assessmentId, conditioned: commit.expected !== undefined });
                return (value as (...a: unknown[]) => Promise<void>).call(target, context, commit);
              };
            }
            return (value as (...a: unknown[]) => unknown).bind(target);
          },
        }),
    });
    stores.push(world.store);
    // Every rewriting operation: collect, evaluate, review + re-evaluate, complete, reassess, and an end.
    const prepared = await preparePilotAssessment(world);
    await reviewPilotAssessment(world, prepared.assessmentId);
    await world.service.completeAssessment(PILOT_ORG_CONTEXT, prepared.assessmentId);
    const next = await world.service.requestReassessment(PILOT_ORG_CONTEXT, { assessmentId: prepared.assessmentId, reason: 'C10', requestedBy: 'cas-preparer' });
    await world.service.terminateAssessment(pilotContext(world, 'reviewer'), next.assessmentId, { reasonCode: 'engagement_withdrawn', rationale: 'C10 end.' });
    const seen = new Set<string>();
    for (const save of saves) {
      if (seen.has(save.assessmentId)) assert.equal(save.conditioned, true, `a rewrite of '${save.assessmentId}' is conditioned`);
      else assert.equal(save.conditioned, false, 'a first save creates the assessment');
      seen.add(save.assessmentId);
    }
    assert.ok(saves.length >= 6 && seen.size === 2, JSON.stringify(saves));
  });

  it('C09 the conflict is HTTP 409 with a retryable reason; frozen framework digests are unchanged', () => {
    const http = mapAssuranceErrorToHttp(new AssuranceError('ASSURANCE_ASSESSMENT_CONFLICT', 'changed', { reason: 'concurrent_modification', retryable: true }));
    assert.equal(http.httpStatus, 409);
    assert.equal(http.code, 'ASSURANCE_ASSESSMENT_CONFLICT');
    assert.equal(computeDigest(RN_SV_FRAMEWORK_V0_1), RN_SV_GOLDEN_DIGEST);
    assert.equal(computeDigest(AOC_SAF_FRAMEWORK_V1), AOC_SAF_GOLDEN_DIGEST);
  });
});
