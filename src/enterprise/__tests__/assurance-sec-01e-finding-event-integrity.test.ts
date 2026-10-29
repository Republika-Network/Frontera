import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import { AssuranceError } from '../assurance/errors.js';
import { buildFindingEvent } from '../assurance/findings.js';
import { assertCompletionCommit, findingHistoryViolations, type AssuranceCompletionCommit } from '../assurance/finding-history.js';
import { createInMemoryAssuranceStore } from '../assurance/in-memory-assurance-store.js';
import { createSqliteAssuranceStore } from '../assurance/sqlite-assurance-store.js';
import { AOC_SAF_FRAMEWORK_V1 } from '../assurance/saf-framework.js';
import { RN_SV_FRAMEWORK_V0_1 } from '../assurance/frameworks/rn-sv-framework.js';
import { computeDigest } from '../governance-store/digest.js';
import type { AssuranceStore } from '../assurance/assurance-store.js';
import type { AssuranceAssessment, AssuranceFindingEvent } from '../assurance/contracts.js';
import { ASSURANCE_ORG, ASSURANCE_SYSTEM, buildAssuranceHarness, buildTestSubject, type AssuranceTestHarness } from './assurance-support.js';

/**
 * ASSURE-SEC-01E -- a completed assessment and the opening event of each of
 * its findings persist as one unit, or not at all.
 *
 * Failures are injected for real: SQLite triggers installed on a temporary
 * database through a second connection abort the store's own transaction at
 * the first, an intermediate or the last event, at the assessment write, at
 * BEGIN (a held write lock) and at COMMIT (a deferred foreign key). After each
 * one the persisted state is read back, then the completion is retried.
 */

const tempDirs: string[] = [];
const closers: (() => Promise<void>)[] = [];
after(async () => {
  for (const close of closers) await close().catch(() => {});
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

interface SqliteWorld {
  readonly path: string;
  readonly store: AssuranceStore;
  /** A second connection to the same database, used only to install and remove failure triggers and to read rows back. */
  readonly raw: Database.Database;
}

async function sqliteWorld(options: { readonly busyTimeoutMs?: number } = {}): Promise<SqliteWorld> {
  const dir = mkdtempSync(join(tmpdir(), 'assure-sec-01e-'));
  tempDirs.push(dir);
  const path = join(dir, 'assurance.db');
  const store = await createSqliteAssuranceStore(path, options.busyTimeoutMs !== undefined ? { busyTimeoutMs: options.busyTimeoutMs } : {});
  closers.push(() => store.close());
  const raw = new Database(path);
  closers.push(async () => {
    raw.close();
  });
  return { path, store, raw };
}

/** Evaluated (not completed) with no evidence: every control yields a finding. */
async function evaluatedWithFindings(harness: AssuranceTestHarness): Promise<AssuranceAssessment> {
  const created = await harness.service.createAssessment(ASSURANCE_ORG, {
    subject: buildTestSubject(),
    frameworkId: 'test.framework',
    frameworkVersion: '1.0.0',
    requestedBy: 'assessor-1',
    evidenceCutoffAt: '2026-06-15T00:00:00.000Z',
  });
  const evaluated = await harness.service.evaluateAssessment(ASSURANCE_ORG, created.assessmentId);
  assert.ok(evaluated.findings.length >= 3, `the fixture needs at least three findings (has ${evaluated.findings.length})`);
  return evaluated;
}

function rowCounts(raw: Database.Database, assessmentId: string) {
  const status = (raw.prepare('SELECT status FROM assurance_assessments WHERE assessment_id = ?').get(assessmentId) as { status: string } | undefined)?.status;
  const findings = (raw.prepare('SELECT count(*) AS n FROM assurance_findings WHERE assessment_id = ?').get(assessmentId) as { n: number }).n;
  const events = (raw.prepare('SELECT count(*) AS n FROM assurance_finding_events WHERE assessment_id = ?').get(assessmentId) as { n: number }).n;
  const projections = (raw.prepare('SELECT count(*) AS n FROM assurance_control_evaluations WHERE assessment_id = ?').get(assessmentId) as { n: number }).n;
  return { status, findings, events, projections };
}

/** Every finding of a completed assessment has exactly one, intact, opening event. */
async function assertCompleteHistory(store: AssuranceStore, assessmentId: string): Promise<void> {
  const findings = await store.listFindings(ASSURANCE_ORG, assessmentId);
  assert.ok(findings.length > 0);
  for (const finding of findings) {
    const events = await store.listFindingEvents(ASSURANCE_ORG, finding.findingId);
    assert.equal(events.length, 1, `finding ${finding.findingId} has exactly one event`);
    assert.deepEqual(findingHistoryViolations(finding, 'org-1', events), []);
    assert.equal(finding.status, 'open');
  }
}

const isCode = (code: string) => (error: unknown) => error instanceof AssuranceError && error.code === code;

describe('ASSURE-SEC-01E -- SQLite: an injected failure anywhere in the unit leaves nothing behind, and a retry completes once', () => {
  const injections: readonly { readonly name: string; readonly install: (raw: Database.Database, findingCount: number) => void; readonly expected: string }[] = [
    {
      name: 'the first event',
      install: (raw) => raw.exec(`CREATE TRIGGER inject BEFORE INSERT ON assurance_finding_events BEGIN SELECT RAISE(ABORT, 'injected first'); END`),
      expected: 'ASSURANCE_STORE_UNAVAILABLE',
    },
    {
      name: 'an intermediate event',
      install: (raw) =>
        raw.exec(`CREATE TRIGGER inject BEFORE INSERT ON assurance_finding_events WHEN (SELECT count(*) FROM assurance_finding_events WHERE assessment_id = NEW.assessment_id) = 1 BEGIN SELECT RAISE(ABORT, 'injected middle'); END`),
      expected: 'ASSURANCE_STORE_UNAVAILABLE',
    },
    {
      name: 'the last event',
      install: (raw, findingCount) =>
        raw.exec(
          `CREATE TRIGGER inject BEFORE INSERT ON assurance_finding_events WHEN (SELECT count(*) FROM assurance_finding_events WHERE assessment_id = NEW.assessment_id) = ${findingCount - 1} BEGIN SELECT RAISE(ABORT, 'injected last'); END`,
        ),
      expected: 'ASSURANCE_STORE_UNAVAILABLE',
    },
    {
      name: 'the assessment write',
      install: (raw) => raw.exec(`CREATE TRIGGER inject BEFORE UPDATE ON assurance_assessments WHEN NEW.status = 'completed' BEGIN SELECT RAISE(ABORT, 'injected assessment'); END`),
      expected: 'ASSURANCE_STORE_UNAVAILABLE',
    },
    {
      name: 'a finding row',
      install: (raw) => raw.exec(`CREATE TRIGGER inject BEFORE INSERT ON assurance_findings BEGIN SELECT RAISE(ABORT, 'injected finding'); END`),
      expected: 'ASSURANCE_STORE_UNAVAILABLE',
    },
    {
      name: 'COMMIT (a deferred foreign key checked only at commit)',
      install: (raw) =>
        raw.exec(`CREATE TABLE IF NOT EXISTS inject_parent (id TEXT PRIMARY KEY);
          CREATE TABLE IF NOT EXISTS inject_child (ref TEXT REFERENCES inject_parent(id) DEFERRABLE INITIALLY DEFERRED);
          CREATE TRIGGER inject AFTER UPDATE ON assurance_assessments WHEN NEW.status = 'completed' BEGIN INSERT INTO inject_child (ref) VALUES ('missing'); END`),
      expected: 'ASSURANCE_STORE_UNAVAILABLE',
    },
  ];

  for (const injection of injections) {
    it(`a failure at ${injection.name}: no false success, no partial completion, no driver detail; the retry completes exactly once`, async () => {
      const world = await sqliteWorld();
      const harness = buildAssuranceHarness({ store: world.store });
      const evaluated = await evaluatedWithFindings(harness);
      const before = rowCounts(world.raw, evaluated.assessmentId);
      injection.install(world.raw, evaluated.findings.length);

      await assert.rejects(harness.service.completeAssessment(ASSURANCE_ORG, evaluated.assessmentId), (error: unknown) => {
        assert.ok(error instanceof AssuranceError);
        assert.equal(error.code, injection.expected);
        assert.equal(/injected|SQLITE|assurance\.db|\//.test(error.message), false, `no driver detail or path: ${error.message}`);
        assert.equal(error.details?.['retryable'], true);
        return true;
      });
      // Read back what is persisted -- not just the error.
      assert.deepEqual(rowCounts(world.raw, evaluated.assessmentId), before, 'nothing of the completion was persisted');
      assert.equal((await harness.service.getAssessment(ASSURANCE_ORG, evaluated.assessmentId))?.status, evaluated.status);
      assert.deepEqual(await harness.service.listFindings(ASSURANCE_ORG, evaluated.assessmentId), []);
      if (world.raw.prepare(`SELECT name FROM sqlite_master WHERE name = 'inject_child'`).get() !== undefined) {
        assert.equal((world.raw.prepare('SELECT count(*) AS n FROM inject_child').get() as { n: number }).n, 0, 'the trigger\'s own write rolled back too');
      }

      world.raw.exec('DROP TRIGGER inject');
      const completed = await harness.service.completeAssessment(ASSURANCE_ORG, evaluated.assessmentId);
      assert.equal(completed.status, 'completed');
      const after = rowCounts(world.raw, evaluated.assessmentId);
      assert.equal(after.status, 'completed');
      assert.equal(after.findings, evaluated.findings.length);
      assert.equal(after.events, evaluated.findings.length, 'one opening event per finding, no duplicates from the failed attempt');
      await assertCompleteHistory(world.store, evaluated.assessmentId);

      // A repeated retry after success is a conflict, and adds nothing.
      await assert.rejects(harness.service.completeAssessment(ASSURANCE_ORG, evaluated.assessmentId), isCode('ASSURANCE_ASSESSMENT_IMMUTABLE'));
      assert.deepEqual(rowCounts(world.raw, evaluated.assessmentId), after);
    });
  }

  it('a failure at BEGIN (another connection holds the write lock) is a retryable store failure; the retry completes once the lock is released', async () => {
    const world = await sqliteWorld({ busyTimeoutMs: 50 });
    const harness = buildAssuranceHarness({ store: world.store });
    const evaluated = await evaluatedWithFindings(harness);
    world.raw.exec('BEGIN IMMEDIATE');
    try {
      await assert.rejects(harness.service.completeAssessment(ASSURANCE_ORG, evaluated.assessmentId), isCode('ASSURANCE_STORE_UNAVAILABLE'));
    } finally {
      world.raw.exec('ROLLBACK');
    }
    assert.equal(rowCounts(world.raw, evaluated.assessmentId).events, 0);
    await harness.service.completeAssessment(ASSURANCE_ORG, evaluated.assessmentId);
    await assertCompleteHistory(world.store, evaluated.assessmentId);
  });

  it('the completion survives reopening the database: assessment, findings and events together', async () => {
    const world = await sqliteWorld();
    const harness = buildAssuranceHarness({ store: world.store });
    const evaluated = await evaluatedWithFindings(harness);
    await harness.service.completeAssessment(ASSURANCE_ORG, evaluated.assessmentId);
    const reopened = await createSqliteAssuranceStore(world.path);
    closers.push(() => reopened.close());
    assert.equal((await reopened.getAssessment(ASSURANCE_ORG, evaluated.assessmentId))?.status, 'completed');
    await assertCompleteHistory(reopened, evaluated.assessmentId);
  });

  it('two connections completing the same assessment at once: exactly one succeeds, the other is refused, events are written once', async () => {
    const world = await sqliteWorld();
    const first = buildAssuranceHarness({ store: world.store });
    const evaluated = await evaluatedWithFindings(first);
    const otherConnection = await createSqliteAssuranceStore(world.path);
    closers.push(() => otherConnection.close());
    const second = buildAssuranceHarness({ store: otherConnection });
    const outcomes = await Promise.allSettled([
      first.service.completeAssessment(ASSURANCE_ORG, evaluated.assessmentId),
      second.service.completeAssessment(ASSURANCE_ORG, evaluated.assessmentId),
    ]);
    assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
    const refused = outcomes.find((outcome) => outcome.status === 'rejected');
    assert.ok(refused !== undefined && refused.status === 'rejected' && isCode('ASSURANCE_ASSESSMENT_IMMUTABLE')(refused.reason));
    assert.equal(rowCounts(world.raw, evaluated.assessmentId).events, evaluated.findings.length);
    await assertCompleteHistory(world.store, evaluated.assessmentId);
  });
});

describe('ASSURE-SEC-01E -- store parity: the same commit is refused, whole, by both stores', () => {
  const stores: readonly { readonly name: string; readonly open: () => Promise<{ store: AssuranceStore; events: (assessmentId: string) => number }> }[] = [
    {
      name: 'in-memory',
      open: async () => {
        const store = createInMemoryAssuranceStore();
        // No rows to count: the in-memory store is read back through its own contract below.
        return { store, events: () => 0 };
      },
    },
    {
      name: 'SQLite',
      open: async () => {
        const world = await sqliteWorld();
        return { store: world.store, events: (assessmentId) => rowCounts(world.raw, assessmentId).events };
      },
    },
  ];

  async function prepared(store: AssuranceStore) {
    const harness = buildAssuranceHarness({ store });
    const evaluated = await evaluatedWithFindings(harness);
    const completed: AssuranceAssessment = { ...evaluated, status: 'completed', completedAt: '2026-06-14T00:00:00.000Z' };
    const events = completed.findings.map((finding, index) =>
      buildFindingEvent({
        findingEventId: `opening-${evaluated.assessmentId}-${index}`,
        findingId: finding.findingId,
        assessmentId: completed.assessmentId,
        organizationId: completed.subject.organizationId,
        eventType: 'AssuranceFindingCreated',
        sequence: 1,
        actorId: 'assessor-1',
        occurredAt: '2026-06-14T00:00:00.000Z',
      }),
    );
    return { harness, evaluated, completed, events };
  }

  const corruptions: readonly { readonly name: string; readonly corrupt: (events: AssuranceFindingEvent[], completed: AssuranceAssessment) => AssuranceFindingEvent[]; readonly code: string }[] = [
    { name: 'an event for a finding the assessment does not contain', corrupt: (events) => [...events.slice(0, -1), buildFindingEvent({ ...events.at(-1)!, findingId: 'finding-that-does-not-exist' })], code: 'ASSURANCE_INVALID_FINDING_TRANSITION' },
    { name: 'an event attributed to another organization', corrupt: (events) => [events[0]!, buildFindingEvent({ ...events[1]!, organizationId: 'org-2' }), ...events.slice(2)], code: 'ASSURANCE_INVALID_FINDING_TRANSITION' },
    { name: 'a duplicated event identifier in the middle', corrupt: (events) => [events[0]!, buildFindingEvent({ ...events[1]!, findingEventId: events[0]!.findingEventId }), ...events.slice(2)], code: 'ASSURANCE_INVALID_FINDING_TRANSITION' },
    { name: 'a finding left without its opening event', corrupt: (events) => events.slice(0, -1), code: 'ASSURANCE_INVALID_FINDING_TRANSITION' },
    { name: 'a finding opened twice', corrupt: (events) => [...events, buildFindingEvent({ ...events[0]!, findingEventId: 'second-opening' })], code: 'ASSURANCE_INVALID_FINDING_TRANSITION' },
    { name: 'an altered event digest', corrupt: (events) => [{ ...events[0]!, actorId: 'someone-else' }, ...events.slice(1)], code: 'ASSURANCE_INVALID_FINDING_TRANSITION' },
    { name: 'a non-opening event type', corrupt: (events) => [buildFindingEvent({ ...events[0]!, eventType: 'AssuranceFindingClosed' }), ...events.slice(1)], code: 'ASSURANCE_INVALID_FINDING_TRANSITION' },
  ];

  for (const backend of stores) {
    for (const corruption of corruptions) {
      it(`${backend.name}: ${corruption.name} is refused and nothing is persisted`, async () => {
        const { store, events: countEvents } = await backend.open();
        const { harness, evaluated, completed, events } = await prepared(store);
        const commit: AssuranceCompletionCommit = { assessment: completed, findingEvents: corruption.corrupt([...events], completed) };
        await assert.rejects(store.completeAssessment(ASSURANCE_ORG, commit), isCode(corruption.code));
        assert.equal((await store.getAssessment(ASSURANCE_ORG, evaluated.assessmentId))?.status, evaluated.status);
        assert.deepEqual(await store.listFindings(ASSURANCE_ORG, evaluated.assessmentId), []);
        for (const finding of evaluated.findings) assert.deepEqual(await store.listFindingEvents(ASSURANCE_ORG, finding.findingId), []);
        assert.equal(countEvents(evaluated.assessmentId), 0);
        // The service still completes it afterwards.
        await harness.service.completeAssessment(ASSURANCE_ORG, evaluated.assessmentId);
        await assertCompleteHistory(store, evaluated.assessmentId);
      });
    }

    it(`${backend.name}: a valid commit completes; repeating it is a conflict and adds no event`, async () => {
      const { store } = await backend.open();
      const { evaluated, completed, events } = await prepared(store);
      await store.completeAssessment(ASSURANCE_ORG, { assessment: completed, findingEvents: events });
      await assertCompleteHistory(store, evaluated.assessmentId);
      await assert.rejects(store.completeAssessment(ASSURANCE_ORG, { assessment: completed, findingEvents: events }), isCode('ASSURANCE_ASSESSMENT_IMMUTABLE'));
      await assertCompleteHistory(store, evaluated.assessmentId);
    });

    it(`${backend.name}: another organization cannot complete the assessment`, async () => {
      const { store } = await backend.open();
      const { evaluated, completed, events } = await prepared(store);
      await assert.rejects(store.completeAssessment({ organizationId: 'org-2', system: false }, { assessment: completed, findingEvents: events }), isCode('ASSURANCE_ACCESS_SCOPE_VIOLATION'));
      assert.equal((await store.getAssessment(ASSURANCE_ORG, evaluated.assessmentId))?.status, evaluated.status);
    });

    it(`${backend.name}: two concurrent service completions -- one transition, one refusal, one event per finding`, async () => {
      const { store } = await backend.open();
      const harness = buildAssuranceHarness({ store });
      const evaluated = await evaluatedWithFindings(harness);
      const outcomes = await Promise.allSettled([harness.service.completeAssessment(ASSURANCE_ORG, evaluated.assessmentId), harness.service.completeAssessment(ASSURANCE_ORG, evaluated.assessmentId)]);
      assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
      await assertCompleteHistory(store, evaluated.assessmentId);
    });
  }
});

describe('ASSURE-SEC-01E -- the service never reports a completion the store did not persist', () => {
  it('a store failure that is not an Assurance error is reported as a store failure, never as success, and is observable', async () => {
    const inner = createInMemoryAssuranceStore();
    const failing: AssuranceStore = { ...inner, completeAssessment: async () => Promise.reject(new Error('EIO: /var/lib/secret/path')) };
    const harness = buildAssuranceHarness({ store: failing });
    const evaluated = await evaluatedWithFindings(harness);
    await assert.rejects(harness.service.completeAssessment(ASSURANCE_ORG, evaluated.assessmentId), (error: unknown) => {
      assert.ok(isCode('ASSURANCE_STORE_UNAVAILABLE')(error));
      assert.equal((error as Error).message.includes('/var/lib'), false, 'no store detail in the error');
      return true;
    });
    assert.equal((await inner.getAssessment(ASSURANCE_ORG, evaluated.assessmentId))?.status, evaluated.status);
  });

  it('the opening events are attributed to the assessment, the finding and the organization, and their digests verify', async () => {
    const harness = buildAssuranceHarness();
    const evaluated = await evaluatedWithFindings(harness);
    const completed = await harness.service.completeAssessment(ASSURANCE_ORG, evaluated.assessmentId);
    for (const finding of completed.findings) {
      const [event] = await harness.store.listFindingEvents(ASSURANCE_ORG, finding.findingId);
      assert.equal(event?.assessmentId, completed.assessmentId);
      assert.equal(event?.findingId, finding.findingId);
      assert.equal(event?.organizationId, 'org-1');
      assert.equal(event?.actorId, completed.provenance.requestedBy);
      assert.equal(event?.occurredAt, completed.completedAt);
    }
    await assertCompleteHistory(harness.store, completed.assessmentId);
  });

  it('later lifecycle events still append after the opening one, with contiguous sequences', async () => {
    const harness = buildAssuranceHarness();
    const evaluated = await evaluatedWithFindings(harness);
    const completed = await harness.service.completeAssessment(ASSURANCE_ORG, evaluated.assessmentId);
    const finding = completed.findings[0]!;
    await harness.service.appendFindingEvent(ASSURANCE_ORG, { findingId: finding.findingId, eventType: 'AssuranceFindingAccepted', actorId: 'owner-1' });
    const events = await harness.store.listFindingEvents(ASSURANCE_ORG, finding.findingId);
    assert.deepEqual(events.map((event) => [event.sequence, event.eventType]), [[1, 'AssuranceFindingCreated'], [2, 'AssuranceFindingAccepted']]);
    assert.deepEqual(findingHistoryViolations(finding, 'org-1', events), []);
  });
});

describe('ASSURE-SEC-01E -- reassessment supersession is part of the completion unit', () => {
  async function completedOnce(harness: AssuranceTestHarness): Promise<AssuranceAssessment> {
    const evaluated = await evaluatedWithFindings(harness);
    return harness.service.completeAssessment(ASSURANCE_ORG, evaluated.assessmentId);
  }

  it('SQLite: a failed reassessment completion leaves the prior assessment completed (not superseded); the retry supersedes it', async () => {
    const world = await sqliteWorld();
    const harness = buildAssuranceHarness({ store: world.store });
    const first = await completedOnce(harness);
    const reassessment = await harness.service.requestReassessment(ASSURANCE_ORG, { assessmentId: first.assessmentId, reason: 'test', requestedBy: 'assessor-2' });
    await harness.service.evaluateAssessment(ASSURANCE_ORG, reassessment.assessmentId);
    world.raw.exec(`CREATE TRIGGER inject BEFORE INSERT ON assurance_finding_events WHEN NEW.assessment_id = '${reassessment.assessmentId}' BEGIN SELECT RAISE(ABORT, 'injected'); END`);
    await assert.rejects(harness.service.completeAssessment(ASSURANCE_ORG, reassessment.assessmentId), isCode('ASSURANCE_STORE_UNAVAILABLE'));
    assert.equal((await harness.service.getAssessment(ASSURANCE_ORG, first.assessmentId))?.status, 'completed', 'the prior assessment is not superseded by a completion that did not happen');
    world.raw.exec('DROP TRIGGER inject');
    await harness.service.completeAssessment(ASSURANCE_ORG, reassessment.assessmentId);
    const prior = await harness.service.getAssessment(ASSURANCE_ORG, first.assessmentId);
    assert.equal(prior?.status, 'superseded');
    assert.equal(prior?.supersededByAssessmentId, reassessment.assessmentId);
    assert.equal(prior?.integrity.assessmentDigest, first.integrity.assessmentDigest);
  });

  for (const backend of ['in-memory', 'SQLite'] as const) {
    it(`${backend}: reassessing an already superseded assessment completes, and keeps the first supersession as recorded`, async () => {
      const store = backend === 'SQLite' ? (await sqliteWorld()).store : createInMemoryAssuranceStore();
      const harness = buildAssuranceHarness({ store });
      const first = await completedOnce(harness);
      const replacements: string[] = [];
      for (const reason of ['first replacement', 'second replacement']) {
        const reassessment = await harness.service.requestReassessment(ASSURANCE_ORG, { assessmentId: first.assessmentId, reason, requestedBy: 'assessor-2' });
        await harness.service.evaluateAssessment(ASSURANCE_ORG, reassessment.assessmentId);
        const completed = await harness.service.completeAssessment(ASSURANCE_ORG, reassessment.assessmentId);
        assert.equal(completed.status, 'completed', `${reason} completes`);
        await assertCompleteHistory(store, completed.assessmentId);
        replacements.push(completed.assessmentId);
      }
      const prior = await harness.service.getAssessment(ASSURANCE_ORG, first.assessmentId);
      assert.equal(prior?.supersededByAssessmentId, replacements[0], 'history is not rewritten');
    });
  }
});

describe('ASSURE-SEC-01E -- historical records: diagnosed read-only, never rewritten', () => {
  it('a completed assessment written without opening events (pre-SEC-01E partial completion) is reported, not repaired, and stays immutable', async () => {
    const world = await sqliteWorld();
    const harness = buildAssuranceHarness({ store: world.store });
    const evaluated = await evaluatedWithFindings(harness);
    // The pre-SEC-01E path: the completed assessment saved alone, its events lost.
    await world.store.saveAssessment(ASSURANCE_ORG, { ...evaluated, status: 'completed', completedAt: '2026-06-14T00:00:00.000Z' });
    const findings = await world.store.listFindings(ASSURANCE_ORG, evaluated.assessmentId);
    for (const finding of findings) {
      assert.deepEqual(findingHistoryViolations(finding, 'org-1', await world.store.listFindingEvents(ASSURANCE_ORG, finding.findingId)), ['missing_opening_event']);
    }
    const rowsBefore = rowCounts(world.raw, evaluated.assessmentId);
    await assert.rejects(harness.service.completeAssessment(ASSURANCE_ORG, evaluated.assessmentId), isCode('ASSURANCE_ASSESSMENT_IMMUTABLE'));
    assert.deepEqual(rowCounts(world.raw, evaluated.assessmentId), rowsBefore, 'no repair, no rewrite');
  });

  it('the diagnostic detects gaps, repeats, wrong attribution, altered digests and impossible transitions', async () => {
    const harness = buildAssuranceHarness();
    const evaluated = await evaluatedWithFindings(harness);
    const completed = await harness.service.completeAssessment(ASSURANCE_ORG, evaluated.assessmentId);
    const finding = completed.findings[0]!;
    const [opening] = await harness.store.listFindingEvents(ASSURANCE_ORG, finding.findingId);
    assert.ok(opening);
    const next = (overrides: Partial<Parameters<typeof buildFindingEvent>[0]>) => buildFindingEvent({ ...opening, findingEventId: 'e2', eventType: 'AssuranceFindingAccepted', sequence: 2, ...overrides });
    assert.deepEqual(findingHistoryViolations(finding, 'org-1', [opening, next({ sequence: 3 })]), ['event 2: sequence_3_expected_2']);
    assert.deepEqual(findingHistoryViolations(finding, 'org-1', [opening, next({ findingEventId: opening.findingEventId })]), ['event 2: duplicate_event_id']);
    assert.deepEqual(findingHistoryViolations(finding, 'org-1', [opening, next({ findingId: 'other-finding' })]), ['event 2: wrong_attribution']);
    assert.deepEqual(findingHistoryViolations(finding, 'org-2', [opening]), ['event 1: wrong_attribution']);
    assert.deepEqual(findingHistoryViolations(finding, 'org-1', [{ ...opening, rationale: 'rewritten' }]), ['event 1: digest_mismatch']);
    assert.deepEqual(findingHistoryViolations(finding, 'org-1', [opening, next({ eventType: 'AssuranceFindingCreated' })]), ['event 2: impossible_transition_AssuranceFindingCreated']);
    assert.deepEqual(findingHistoryViolations(finding, 'org-1', [next({ sequence: 1 })]), ['missing_opening_event', 'event 1: impossible_transition_AssuranceFindingAccepted']);
  });

  it('the commit check is the store-independent rule both stores apply', () => {
    assert.throws(() => assertCompletionCommit({ assessment: { status: 'evaluated' } as unknown as AssuranceAssessment, findingEvents: [] }), isCode('ASSURANCE_VALIDATION_ERROR'));
  });
});

describe('ASSURE-SEC-01E -- compatibility', () => {
  it('the system context completes as before', async () => {
    const harness = buildAssuranceHarness();
    const evaluated = await evaluatedWithFindings(harness);
    const completed = await harness.service.completeAssessment(ASSURANCE_SYSTEM, evaluated.assessmentId);
    assert.equal(completed.status, 'completed');
    await assertCompleteHistory(harness.store, completed.assessmentId);
  });

  it('the rn.sv@0.1.0 and aoc.saf golden digests are unchanged', () => {
    assert.equal(computeDigest(RN_SV_FRAMEWORK_V0_1), 'sha256:e71fafe1a10af95514823e35d43138b1b93cdb72e37765200447a37748c13a58');
    assert.equal(computeDigest(AOC_SAF_FRAMEWORK_V1), 'sha256:4c0b5c65a0b8cfe40de726f26d80b80224fac6ca80fe2c221f7a734548899bb9');
  });
});
