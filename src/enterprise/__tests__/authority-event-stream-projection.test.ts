import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { ExecutionOutcome } from '../../features/execution-runtime/index.js';
import type { BoundedGrant, BoundedGrantReaderPort, GrantRevocation } from '../../features/grant-runtime/index.js';
import {
  createAuthorityEventProjector,
  createInMemoryAuthorityEventStreamStore,
  deriveAuthorityEventStreamId,
  type AppendAuthorityEventInput,
  type AppendAuthorityEventResult,
  type AuthorityEventStreamAccessContext,
  type AuthorityEventStreamStore,
  type AuthorityEventStreamWriter,
} from '../authority-event-stream/index.js';
import type { GovernanceRecord } from '../governance-store/contracts.js';
import { DIGEST_A, DIGEST_B, ORG_A, REQUEST_1, REQUEST_2, T0, steppingClock } from './authority-event-stream-support.js';

/**
 * §4 / §10 of the P8 hardening — the projector's queue.
 *
 * Two properties, and they pull in opposite directions: reporting a fact must
 * **never** make an authority path wait, and one stream's events must still be
 * appended strictly in order. The queue is what holds both: enqueue returns
 * immediately, and the append for event N+1 is not invoked until N's has
 * settled — per stream, so a stuck stream holds only itself.
 */

const EXECUTION = 'aoc.exec:00000000000000000000000000000001';
const GRANT_ID = 'aoc.grant:00000000000000000000000000000001';
const EVALUATION = 'gov-evaluation-1';
const DECISION = 'decision-1';

/** The few fields the projector actually reads, shaped as the real artifacts. */
function committedRecord(requestId = REQUEST_1): GovernanceRecord {
  return {
    request: { organizationId: ORG_A },
    evaluation: { requestId, evaluationId: EVALUATION, decisionId: DECISION, status: 'allowed', reasonCodes: ['AOC_ALLOWED'], evaluatedAt: T0, persistedAt: T0 },
    integrity: { aggregateDigest: DIGEST_A },
  } as unknown as GovernanceRecord;
}

const GRANT_ID_2 = 'aoc.grant:00000000000000000000000000000002';

/** One grant per lifecycle, as in production: a grant belongs to exactly one request. */
function issuedGrant(requestId = REQUEST_1): BoundedGrant {
  return {
    id: requestId === REQUEST_1 ? GRANT_ID : GRANT_ID_2,
    correlation: { requestId, decisionId: DECISION },
    digest: DIGEST_A,
    issuedAt: T0,
    expiresAt: '2026-03-01T10:10:00.000Z',
    authorityBindingDigest: DIGEST_B,
  } as unknown as BoundedGrant;
}

const EXECUTED: ExecutionOutcome = {
  status: 'executed',
  correlation: { executionId: EXECUTION },
  adapterId: 'test.adapter',
  exercisedAt: T0,
} as unknown as ExecutionOutcome;

const grantsReader = (grant: BoundedGrant): BoundedGrantReaderPort => ({ async read() {
  return { grant };
} });

/** Lets the test decide exactly when each append is allowed to reach the real store. */
function gated(inner: AuthorityEventStreamStore) {
  const invoked: string[] = [];
  const held: { readonly streamId: string; readonly release: () => void }[] = [];
  const writer: AuthorityEventStreamWriter = {
    append(context: AuthorityEventStreamAccessContext, input: AppendAuthorityEventInput): Promise<AppendAuthorityEventResult> {
      invoked.push(input.eventType);
      return new Promise<AppendAuthorityEventResult>((resolve, reject) => {
        held.push({ streamId: input.streamId, release: () => void inner.append(context, input).then(resolve, reject) });
      });
    },
  };
  return {
    writer,
    invoked,
    /** Release the oldest held append (optionally for one stream). Resolves once it has settled. */
    async release(streamId?: string): Promise<void> {
      const index = streamId === undefined ? 0 : held.findIndex((entry) => entry.streamId === streamId);
      assert.notEqual(index, -1, 'expected a held append');
      const [entry] = held.splice(index, 1);
      entry?.release();
      await tick();
    },
    heldCount: () => held.length,
  };
}

/** Let every already-scheduled microtask and I/O callback run. */
async function tick(times = 3): Promise<void> {
  for (let index = 0; index < times; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

function projectorOver(writer: AuthorityEventStreamWriter, grant = issuedGrant()) {
  return createAuthorityEventProjector({ organizationId: ORG_A, store: writer, grants: grantsReader(grant) });
}

describe('P8 projection queue — reporting never waits', () => {
  it('every recorder method returns synchronously, before its append is even invoked', async () => {
    const store = createInMemoryAuthorityEventStreamStore({ now: steppingClock().now });
    const gate = gated(store);
    const projector = projectorOver(gate.writer);

    const returned = projector.decisionCommitted(committedRecord());
    assert.equal(returned, undefined, 'enqueue returns void, never a promise');
    assert.equal(gate.invoked.length, 0, 'the append has not even been invoked when the caller continues');
    assert.equal(projector.health().pending, 1);
    await tick();
    assert.deepEqual(gate.invoked, ['governance.decision.committed']);
    assert.equal(projector.health().appended, 0, 'and it is still not durable');
    await gate.release();
    assert.equal(projector.health().appended, 1);
    assert.equal(projector.health().pending, 0);
  });

  it('an append that never settles blocks nothing: every later report still returns at once', async () => {
    const never: AuthorityEventStreamWriter = { append: () => new Promise<AppendAuthorityEventResult>(() => {}) };
    const projector = projectorOver(never);
    const started = Date.now();
    projector.decisionCommitted(committedRecord());
    projector.grantIssued(issuedGrant());
    projector.executionClaimed({ evaluationId: EVALUATION, executionId: EXECUTION, grant: issuedGrant(), claimedAt: T0 });
    projector.executionOutcomeObserved({ evaluationId: EVALUATION, executionId: EXECUTION, grant: issuedGrant(), outcome: EXECUTED, outcomeRecorded: true });
    projector.grantRevoked({ grantId: GRANT_ID, revokedAt: T0, reason: 'security-incident', issuerRef: 'operator:1' } as GrantRevocation);
    assert.ok(Date.now() - started < 1_000, 'five reports returned immediately');
    await tick();
    assert.equal(projector.health().pending, 5, 'all five are queued, none complete');
    assert.equal(projector.health().appended, 0);
    assert.equal(projector.health().failed, 0);
  });
});

describe('P8 projection queue — §10 one stream keeps its order', () => {
  it('invokes one append at a time, in enqueue order, and persists the canonical chain', async () => {
    const store = createInMemoryAuthorityEventStreamStore({ now: steppingClock().now });
    const gate = gated(store);
    const projector = projectorOver(gate.writer);

    projector.decisionCommitted(committedRecord());
    projector.grantIssued(issuedGrant());
    projector.executionClaimed({ evaluationId: EVALUATION, executionId: EXECUTION, grant: issuedGrant(), claimedAt: T0 });
    projector.executionOutcomeObserved({ evaluationId: EVALUATION, executionId: EXECUTION, grant: issuedGrant(), outcome: EXECUTED, outcomeRecorded: true });
    await tick();

    // The decision's append is the only one invoked; nothing else may start.
    assert.deepEqual(gate.invoked, ['governance.decision.committed']);
    await gate.release();
    assert.deepEqual(gate.invoked, ['governance.decision.committed', 'grant.issued']);
    await gate.release();
    assert.deepEqual(gate.invoked, ['governance.decision.committed', 'grant.issued', 'execution.attempt.claimed']);
    await gate.release();
    assert.deepEqual(gate.invoked, ['governance.decision.committed', 'grant.issued', 'execution.attempt.claimed', 'execution.outcome.observed']);
    await gate.release();

    const streamId = deriveAuthorityEventStreamId({ organizationId: ORG_A, requestId: REQUEST_1 });
    const events = await store.readStream({ organizationId: ORG_A }, streamId);
    assert.deepEqual(events.map((event) => event.eventType), ['governance.decision.committed', 'grant.issued', 'execution.attempt.claimed', 'execution.outcome.observed']);
    assert.deepEqual(events.map((event) => event.sequence), [1, 2, 3, 4]);
    events.forEach((event, index) => assert.equal(event.previousEventDigest, index === 0 ? undefined : events[index - 1]?.eventDigest));
    assert.equal((await store.verifyStream({ organizationId: ORG_A }, streamId)).valid, true);
    assert.equal(projector.health().pending, 0);
  });

  it('a chain continues after an append fails: the failure is counted and the next event still lands', async () => {
    const store = createInMemoryAuthorityEventStreamStore({ now: steppingClock().now });
    let failNext = false;
    const flaky: AuthorityEventStreamWriter = {
      append(context, input) {
        if (failNext) {
          failNext = false;
          return Promise.reject(new Error('transient evidence failure'));
        }
        return store.append(context, input);
      },
    };
    const projector = projectorOver(flaky);
    projector.decisionCommitted(committedRecord());
    await tick();
    failNext = true;
    projector.grantIssued(issuedGrant());
    projector.executionClaimed({ evaluationId: EVALUATION, executionId: EXECUTION, grant: issuedGrant(), claimedAt: T0 });
    await tick();

    const events = await store.readStream({ organizationId: ORG_A }, deriveAuthorityEventStreamId({ organizationId: ORG_A, requestId: REQUEST_1 }));
    assert.deepEqual(events.map((event) => event.eventType), ['governance.decision.committed', 'execution.attempt.claimed'], 'the lost event is lost — the rest still projects');
    assert.equal(projector.health().failed, 1);
    assert.equal(projector.health().status, 'degraded');
    assert.equal(projector.health().pending, 0);
  });
});

describe('P8 projection queue — a stuck stream holds only itself', () => {
  it('stream B projects to completion while stream A is stuck forever', async () => {
    const store = createInMemoryAuthorityEventStreamStore({ now: steppingClock().now });
    const streamA = deriveAuthorityEventStreamId({ organizationId: ORG_A, requestId: REQUEST_1 });
    const streamB = deriveAuthorityEventStreamId({ organizationId: ORG_A, requestId: REQUEST_2 });
    const stuckOnA: AuthorityEventStreamWriter = {
      append(context, input) {
        return input.streamId === streamA ? new Promise<AppendAuthorityEventResult>(() => {}) : store.append(context, input);
      },
    };
    const projector = projectorOver(stuckOnA);

    projector.decisionCommitted(committedRecord(REQUEST_1));
    projector.grantIssued(issuedGrant(REQUEST_1));
    projector.decisionCommitted(committedRecord(REQUEST_2));
    projector.grantIssued(issuedGrant(REQUEST_2));
    await tick();

    assert.deepEqual((await store.readStream({ organizationId: ORG_A }, streamB)).map((event) => event.eventType), ['governance.decision.committed', 'grant.issued'], 'B finished');
    assert.deepEqual([...(await store.readStream({ organizationId: ORG_A }, streamA))], [], 'A wrote nothing');
    assert.equal(projector.health().pending, 2, 'A alone is still queued');
    assert.equal(projector.health().appended, 2);
  });

  it('a stuck grant attribution holds that grant\'s own evidence and nothing else', async () => {
    const store = createInMemoryAuthorityEventStreamStore({ now: steppingClock().now });
    // Only the stuck grant's attribution hangs; the other lifecycle's grant reads normally.
    const stuckReader: BoundedGrantReaderPort = { read: (id) => (id === GRANT_ID ? new Promise(() => {}) : Promise.resolve({ grant: issuedGrant(REQUEST_2) })) };
    const projector = createAuthorityEventProjector({ organizationId: ORG_A, store, grants: stuckReader });
    projector.decisionCommitted(committedRecord());
    projector.grantRevoked({ grantId: GRANT_ID, revokedAt: T0, reason: 'security-incident', issuerRef: 'operator:1' } as GrantRevocation);
    projector.grantIssued(issuedGrant());
    // Another lifecycle, whose grant has nothing to do with the stuck one.
    projector.decisionCommitted(committedRecord(REQUEST_2));
    projector.grantIssued(issuedGrant(REQUEST_2));
    await tick();

    assert.deepEqual(
      (await store.readStream({ organizationId: ORG_A }, deriveAuthorityEventStreamId({ organizationId: ORG_A, requestId: REQUEST_1 }))).map((event) => event.eventType),
      ['governance.decision.committed'],
      'the decision landed; everything behind the barrier waits, so nothing can overtake the revocation',
    );
    assert.deepEqual(
      (await store.readStream({ organizationId: ORG_A }, deriveAuthorityEventStreamId({ organizationId: ORG_A, requestId: REQUEST_2 }))).map((event) => event.eventType),
      ['governance.decision.committed', 'grant.issued'],
      'an unrelated lifecycle is unaffected',
    );
  });
});

describe('P8 projection queue — §2 a revocation cannot be overtaken by the facts it precedes', () => {
  /** A grant reader the test releases by hand, so "attribution is slow" is a state, not a timing hope. */
  function heldReader(grant: BoundedGrant): { readonly reader: BoundedGrantReaderPort; readonly release: () => Promise<void>; readonly reads: () => number } {
    let reads = 0;
    const waiting: (() => void)[] = [];
    return {
      reads: () => reads,
      reader: {
        read() {
          reads += 1;
          return new Promise((resolve) => waiting.push(() => resolve({ grant })));
        },
      },
      async release() {
        for (const resolve of waiting.splice(0)) resolve();
        await tick();
      },
    };
  }

  it('holds later facts for the same grant behind a pending attribution, then appends in report order', async () => {
    const store = createInMemoryAuthorityEventStreamStore({ now: steppingClock().now });
    const gate = gated(store);
    const grant = issuedGrant();
    const held = heldReader(grant);
    const projector = createAuthorityEventProjector({ organizationId: ORG_A, store: gate.writer, grants: held.reader });

    // 1. issuance and the claim are established first.
    projector.decisionCommitted(committedRecord());
    projector.grantIssued(grant);
    projector.executionClaimed({ evaluationId: EVALUATION, executionId: EXECUTION, grant, claimedAt: T0 });
    await tick();
    await gate.release();
    await gate.release();
    await gate.release();
    assert.deepEqual(gate.invoked, ['governance.decision.committed', 'grant.issued', 'execution.attempt.claimed']);

    // 2-4. the attribution read is pending; the revocation and then an outcome
    //      for the same grant are reported.
    projector.grantRevoked({ grantId: grant.id, revokedAt: '2026-03-01T10:05:00.000Z', reason: 'security-incident', issuerRef: 'operator:1' } as GrantRevocation);
    projector.executionOutcomeObserved({ evaluationId: EVALUATION, executionId: EXECUTION, grant, outcome: EXECUTED, outcomeRecorded: true });
    await tick(10);

    // 5. the outcome has not been invoked — it cannot pass the revocation.
    assert.equal(held.reads(), 1, 'the attribution read is outstanding');
    assert.deepEqual(gate.invoked, ['governance.decision.committed', 'grant.issued', 'execution.attempt.claimed'], 'nothing was appended past the barrier');
    assert.equal(gate.heldCount(), 0);

    // 6. release the attribution.
    await held.release();
    await tick();

    // 7. the revocation goes first, and only then the outcome.
    assert.deepEqual(gate.invoked, ['governance.decision.committed', 'grant.issued', 'execution.attempt.claimed', 'grant.revoked']);
    await gate.release();
    assert.deepEqual(gate.invoked, ['governance.decision.committed', 'grant.issued', 'execution.attempt.claimed', 'grant.revoked', 'execution.outcome.observed']);
    await gate.release();

    // 8. the persisted chain is exactly that order, contiguous and verified.
    const streamId = deriveAuthorityEventStreamId({ organizationId: ORG_A, requestId: REQUEST_1 });
    const events = await store.readStream({ organizationId: ORG_A }, streamId);
    assert.deepEqual(events.map((event) => event.eventType), ['governance.decision.committed', 'grant.issued', 'execution.attempt.claimed', 'grant.revoked', 'execution.outcome.observed']);
    assert.deepEqual(events.map((event) => event.sequence), [1, 2, 3, 4, 5]);
    events.forEach((event, index) => assert.equal(event.previousEventDigest, index === 0 ? undefined : events[index - 1]?.eventDigest));
    assert.equal((await store.verifyStream({ organizationId: ORG_A }, streamId)).valid, true);
    assert.equal(events[3]?.occurredAt, '2026-03-01T10:05:00.000Z', 'the revocation still carries its own instant');
  });

  it('every grant-scoped fact reported after a pending revocation waits, in its own report order', async () => {
    const store = createInMemoryAuthorityEventStreamStore({ now: steppingClock().now });
    const grant = issuedGrant();
    const held = heldReader(grant);
    const projector = createAuthorityEventProjector({ organizationId: ORG_A, store, grants: held.reader });
    projector.decisionCommitted(committedRecord());
    projector.grantIssued(grant);
    projector.grantRevoked({ grantId: grant.id, revokedAt: T0, reason: 'policy-changed', issuerRef: 'operator:1' } as GrantRevocation);
    projector.executionClaimed({ evaluationId: EVALUATION, executionId: EXECUTION, grant, claimedAt: T0 });
    projector.executionOutcomeObserved({ evaluationId: EVALUATION, executionId: EXECUTION, grant, outcome: EXECUTED, outcomeRecorded: true });
    projector.grantExpiryObserved(grant);
    await tick(10);
    const streamId = deriveAuthorityEventStreamId({ organizationId: ORG_A, requestId: REQUEST_1 });
    assert.deepEqual((await store.readStream({ organizationId: ORG_A }, streamId)).map((event) => event.eventType), ['governance.decision.committed', 'grant.issued']);
    await held.release();
    await tick(5);
    assert.deepEqual(
      (await store.readStream({ organizationId: ORG_A }, streamId)).map((event) => event.eventType),
      ['governance.decision.committed', 'grant.issued', 'grant.revoked', 'execution.attempt.claimed', 'execution.outcome.observed', 'grant.expiry.observed'],
      'report order, exactly',
    );
    assert.equal(projector.health().pending, 0, 'a completed chain drains');
  });

  it('a completed lifecycle leaves no queue behind: pending returns to 0 and the chains are dropped', async () => {
    const store = createInMemoryAuthorityEventStreamStore({ now: steppingClock().now });
    const grant = issuedGrant();
    const projector = createAuthorityEventProjector({ organizationId: ORG_A, store, grants: grantsReader(grant) });
    projector.decisionCommitted(committedRecord());
    projector.grantIssued(grant);
    projector.executionClaimed({ evaluationId: EVALUATION, executionId: EXECUTION, grant, claimedAt: T0 });
    projector.executionOutcomeObserved({ evaluationId: EVALUATION, executionId: EXECUTION, grant, outcome: EXECUTED, outcomeRecorded: true });
    projector.grantRevoked({ grantId: grant.id, revokedAt: T0, reason: 'policy-changed', issuerRef: 'operator:1' } as GrantRevocation);
    assert.ok(projector.health().pending > 0);
    await tick(10);
    assert.equal(projector.health().pending, 0);
    assert.equal(projector.health().failed, 0);
    assert.equal(projector.health().appended, 5);
  });
});
