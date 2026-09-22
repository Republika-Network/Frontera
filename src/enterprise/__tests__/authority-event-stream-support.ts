import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  authorityEventSourceId,
  deriveAuthorityEventId,
  deriveAuthorityEventStreamId,
  isAuthorityEventStreamError,
  type AppendAuthorityEventInput,
  type AuthorityEventBody,
  type AuthorityEventStreamErrorCode,
  type AuthorityEventStreamStore,
} from '../authority-event-stream/index.js';

/**
 * Shared fixtures for the canonical authority event stream suites, and the one
 * store contract both implementations are measured against.
 */

export const ORG_A = 'org-alpha';
export const ORG_B = 'org-beta';
export const REQUEST_1 = 'aoc.gar:0123456789abcdef0123456789abcdef';
export const REQUEST_2 = 'aoc.gar:fedcba9876543210fedcba9876543210';
export const DIGEST_A = `sha256:${'a'.repeat(64)}`;
export const DIGEST_B = `sha256:${'b'.repeat(64)}`;
export const T0 = '2026-03-01T10:00:00.000Z';

/** A clock that answers one-second steps from `start`, and records every sample. */
export function steppingClock(start = '2026-03-01T12:00:00.000Z'): { readonly now: () => string; readonly samples: string[] } {
  let at = Date.parse(start);
  const samples: string[] = [];
  return {
    samples,
    now: () => {
      const value = new Date(at).toISOString();
      at += 1000;
      samples.push(value);
      return value;
    },
  };
}

/** Completes a body into an append input, deriving its stream and event ids exactly as the projector does. */
export function eventInput(body: AuthorityEventBody, options: { readonly organizationId?: string; readonly occurredAt?: string } = {}): AppendAuthorityEventInput {
  const organizationId = options.organizationId ?? ORG_A;
  const streamId = deriveAuthorityEventStreamId({ organizationId, requestId: body.references.requestId });
  const sourceId = authorityEventSourceId(body);
  assert.ok(sourceId !== undefined);
  return { ...body, eventId: deriveAuthorityEventId({ streamId, eventType: body.eventType, sourceId }), streamId, organizationId, occurredAt: options.occurredAt ?? T0 } as AppendAuthorityEventInput;
}

export interface LifecycleIds {
  readonly requestId?: string;
  readonly evaluationId?: string;
  readonly decisionId?: string;
  readonly boundedGrantId?: string;
  readonly executionId?: string;
  readonly reservationId?: string;
}

function ids(input: LifecycleIds) {
  return {
    requestId: input.requestId ?? REQUEST_1,
    evaluationId: input.evaluationId ?? 'gov-evaluation-1',
    decisionId: input.decisionId ?? 'decision-1',
    boundedGrantId: input.boundedGrantId ?? 'aoc.grant:00000000000000000000000000000001',
    executionId: input.executionId ?? 'aoc.exec:00000000000000000000000000000001',
    reservationId: input.reservationId ?? 'aoc.exercise-reservation:00000000000000000000000000000001',
  };
}

/** One valid body per event type — the closed vocabulary, exercised end to end. */
export function bodies(input: LifecycleIds = {}): Readonly<Record<AuthorityEventBody['eventType'], AuthorityEventBody>> {
  const i = ids(input);
  const grant = { requestId: i.requestId, decisionId: i.decisionId, boundedGrantId: i.boundedGrantId };
  const execution = { ...grant, evaluationId: i.evaluationId, executionId: i.executionId };
  const reservation = { ...grant, executionId: i.executionId, reservationId: i.reservationId };
  return {
    'governance.decision.committed': {
      eventType: 'governance.decision.committed',
      references: { requestId: i.requestId, evaluationId: i.evaluationId, decisionId: i.decisionId },
      payload: { status: 'allowed', reasonCodes: ['AOC_ALLOWED'], evaluatedAt: T0, aggregateDigest: DIGEST_A },
    },
    'grant.issued': { eventType: 'grant.issued', references: grant, payload: { grantDigest: DIGEST_A, expiresAt: '2026-03-01T10:10:00.000Z', authorityBindingDigest: DIGEST_B } },
    'grant.revoked': { eventType: 'grant.revoked', references: grant, payload: { reason: 'security-incident' } },
    'grant.expiry.observed': { eventType: 'grant.expiry.observed', references: grant, payload: { expiresAt: '2026-03-01T10:10:00.000Z' } },
    'execution.attempt.claimed': { eventType: 'execution.attempt.claimed', references: execution, payload: {} },
    'exercise.reservation.reserved': { eventType: 'exercise.reservation.reserved', references: reservation, payload: { policyDigest: DIGEST_A, authorityBindingDigest: DIGEST_B } },
    'exercise.reservation.settled': { eventType: 'exercise.reservation.settled', references: reservation, payload: { reason: 'executed' } },
    'exercise.reservation.released': { eventType: 'exercise.reservation.released', references: reservation, payload: { reason: 'execution-failed' } },
    'execution.outcome.observed': {
      eventType: 'execution.outcome.observed',
      references: execution,
      payload: { status: 'executed', reasonCodes: [], adapterId: 'test.adapter', providerRef: 'provider-ref-1', outcomeRecorded: true },
    },
  };
}

export function decision(input: LifecycleIds = {}, options: { readonly organizationId?: string; readonly occurredAt?: string } = {}): AppendAuthorityEventInput {
  return eventInput(bodies(input)['governance.decision.committed'], options);
}

/** A distinct, valid, non-genesis fact for `executionId` — what the race tests append many of. */
export function attempt(executionId: string, input: LifecycleIds = {}, options: { readonly organizationId?: string; readonly occurredAt?: string } = {}): AppendAuthorityEventInput {
  return eventInput(bodies({ ...input, executionId })['execution.attempt.claimed'], options);
}

export async function rejectsWith(promise: Promise<unknown>, code: AuthorityEventStreamErrorCode): Promise<void> {
  await assert.rejects(promise, (error: unknown) => isAuthorityEventStreamError(error) && error.code === code, `expected ${code}`);
}

export interface StoreHarness {
  readonly store: AuthorityEventStreamStore;
  close(): Promise<void>;
  /** Durable stores only: close and open the same file again. */
  readonly reopen?: () => Promise<AuthorityEventStreamStore>;
}

/**
 * The store contract. Run against the in-memory reference and the SQLite store;
 * the restart case runs only where the harness can reopen.
 */
export function describeAuthorityEventStreamStoreContract(name: string, open: (now: () => string) => Promise<StoreHarness>): void {
  const A = { organizationId: ORG_A };
  const B = { organizationId: ORG_B };

  describe(`${name} — the authority event stream store contract`, () => {
    it('first append → sequence 1, no previous digest, the store clock as recordedAt', async () => {
      const clock = steppingClock();
      const harness = await open(clock.now);
      try {
        const first = await harness.store.append(A, decision());
        assert.equal(first.outcome, 'appended');
        assert.equal(first.event.sequence, 1);
        assert.equal(first.event.previousEventDigest, undefined);
        assert.equal(first.event.occurredAt, T0, 'occurredAt is the source fact, untouched');
        assert.ok(clock.samples.includes(first.event.recordedAt), 'recordedAt is the store clock');
        assert.notEqual(first.event.recordedAt, first.event.occurredAt);
      } finally {
        await harness.close();
      }
    });

    it('second append → sequence 2, pointing at event 1 exactly', async () => {
      const harness = await open(steppingClock().now);
      try {
        const first = await harness.store.append(A, decision());
        const second = await harness.store.append(A, attempt('aoc.exec:second'));
        assert.equal(second.event.sequence, 2);
        assert.equal(second.event.previousEventDigest, first.event.eventDigest);
      } finally {
        await harness.close();
      }
    });

    it('is contiguous: every event points at the one before it, the head names the last, and the stream verifies', async () => {
      const harness = await open(steppingClock().now);
      try {
        await harness.store.append(A, decision());
        for (let index = 0; index < 9; index += 1) await harness.store.append(A, attempt(`aoc.exec:c-${index}`));
        const events = await harness.store.readStream(A, decision().streamId);
        assert.deepEqual(
          events.map((event) => event.sequence),
          Array.from({ length: 10 }, (_, index) => index + 1),
        );
        events.forEach((event, index) => assert.equal(event.previousEventDigest, index === 0 ? undefined : events[index - 1]?.eventDigest));
        const verification = await harness.store.verifyStream(A, decision().streamId);
        assert.equal(verification.valid, true, verification.failures.join('; '));
        assert.equal(verification.head?.sequence, 10);
        assert.equal(verification.head?.eventDigest, events[9]?.eventDigest);
      } finally {
        await harness.close();
      }
    });

    it('the returned event is the persisted event, field for field', async () => {
      const harness = await open(steppingClock().now);
      try {
        const returned = [(await harness.store.append(A, decision())).event, (await harness.store.append(A, eventInput(bodies()['grant.issued']))).event];
        assert.deepEqual([...(await harness.store.readStream(A, decision().streamId))], returned);
      } finally {
        await harness.close();
      }
    });

    it('recordedAt belongs to the store clock and is sampled per append — never taken from the input', async () => {
      const clock = steppingClock('2030-01-01T00:00:00.000Z');
      const harness = await open(clock.now);
      try {
        const input = { ...decision(), recordedAt: '1999-01-01T00:00:00.000Z' } as unknown as AppendAuthorityEventInput;
        await rejectsWith(harness.store.append(A, input), 'AUTHORITY_EVENT_INPUT_INVALID');
        const event = (await harness.store.append(A, decision())).event;
        assert.ok(event.recordedAt.startsWith('2030-'));
      } finally {
        await harness.close();
      }
    });

    it('same event id + the same canonical fact → the existing event, unchanged: no second row, no re-dating', async () => {
      const harness = await open(steppingClock().now);
      try {
        const first = await harness.store.append(A, decision());
        const again = await harness.store.append(A, decision());
        assert.equal(again.outcome, 'existing');
        assert.deepEqual(again.event, first.event);
        const grant = await harness.store.append(A, eventInput(bodies()['grant.issued']));
        const grantAgain = await harness.store.append(A, eventInput(bodies()['grant.issued']));
        assert.equal(grantAgain.outcome, 'existing');
        assert.deepEqual(grantAgain.event, grant.event);
        assert.equal((await harness.store.readStream(A, decision().streamId)).length, 2);
      } finally {
        await harness.close();
      }
    });

    it('same event id + a different fact → AUTHORITY_EVENT_CONFLICT; the first stands and nothing is written', async () => {
      const harness = await open(steppingClock().now);
      try {
        const first = await harness.store.append(A, decision());
        await rejectsWith(harness.store.append(A, decision({}, { occurredAt: '2026-03-01T10:00:01.000Z' })), 'AUTHORITY_EVENT_CONFLICT');
        const changed = eventInput({ ...bodies()['governance.decision.committed'], payload: { status: 'denied', reasonCodes: ['AOC_DENIED'], evaluatedAt: T0, aggregateDigest: DIGEST_A } } as AuthorityEventBody);
        assert.equal(changed.eventId, first.event.eventId, 'same source artifact → same id');
        await rejectsWith(harness.store.append(A, changed), 'AUTHORITY_EVENT_CONFLICT');
        const events = await harness.store.readStream(A, decision().streamId);
        assert.deepEqual([...events], [first.event]);
      } finally {
        await harness.close();
      }
    });

    it('cross-stream identities stay independent: two lifecycles each run 1, 2, 3 however they interleave', async () => {
      const harness = await open(steppingClock().now);
      try {
        const two = { requestId: REQUEST_2 };
        await harness.store.append(A, decision());
        await harness.store.append(A, decision(two));
        await harness.store.append(A, attempt('aoc.exec:x'));
        await harness.store.append(A, attempt('aoc.exec:x', two));
        await harness.store.append(A, attempt('aoc.exec:y', two));
        const one = await harness.store.readStream(A, decision().streamId);
        const other = await harness.store.readStream(A, decision(two).streamId);
        assert.deepEqual(one.map((event) => event.sequence), [1, 2]);
        assert.deepEqual(other.map((event) => event.sequence), [1, 2, 3]);
        assert.notEqual(one[1]?.eventId, other[1]?.eventId, 'the same execution id in another lifecycle is another fact');
      } finally {
        await harness.close();
      }
    });

    it('is tenant-confined: no append, read or verify under another organization, and one request id is two streams in two tenants', async () => {
      const harness = await open(steppingClock().now);
      try {
        await harness.store.append(A, decision());
        await rejectsWith(harness.store.append(B, attempt('aoc.exec:foreign')), 'AUTHORITY_EVENT_TENANT_VIOLATION');
        await rejectsWith(harness.store.append(B, decision({}, { organizationId: ORG_A })), 'AUTHORITY_EVENT_TENANT_VIOLATION');
        await rejectsWith(harness.store.readStream(B, decision().streamId), 'AUTHORITY_EVENT_TENANT_VIOLATION');
        await rejectsWith(harness.store.verifyStream(B, decision().streamId), 'AUTHORITY_EVENT_TENANT_VIOLATION');
        await rejectsWith(harness.store.readStream({ organizationId: '' }, decision().streamId), 'AUTHORITY_EVENT_TENANT_VIOLATION');
        // Forging the victim's stream id under the attacker's organization is refused on identity.
        await rejectsWith(harness.store.append(B, { ...decision({}, { organizationId: ORG_B }), streamId: decision().streamId }), 'AUTHORITY_EVENT_INPUT_INVALID');
        const theirs = await harness.store.append(B, decision({}, { organizationId: ORG_B }));
        assert.notEqual(theirs.event.streamId, decision().streamId);
        assert.equal(theirs.event.sequence, 1);
        assert.equal((await harness.store.readStream(A, decision().streamId)).length, 1);
      } finally {
        await harness.close();
      }
    });

    it('a stream begins with its committed decision and holds exactly one', async () => {
      const harness = await open(steppingClock().now);
      try {
        await rejectsWith(harness.store.append(A, attempt('aoc.exec:orphan')), 'AUTHORITY_EVENT_SEQUENCE_INVALID');
        assert.deepEqual([...(await harness.store.readStream(A, decision().streamId))], []);
        await harness.store.append(A, decision());
        await rejectsWith(harness.store.append(A, decision({ evaluationId: 'gov-evaluation-2' })), 'AUTHORITY_EVENT_SEQUENCE_INVALID');
      } finally {
        await harness.close();
      }
    });

    it('refuses input outside the closed contract, and writes nothing for it', async () => {
      const harness = await open(steppingClock().now);
      try {
        await harness.store.append(A, decision());
        const base = attempt('aoc.exec:bad');
        for (const bad of [
          { ...base, eventType: 'grant.minted' },
          { ...base, occurredAt: 'yesterday' },
          { ...base, payload: { note: 'hello' } },
          { ...base, references: { ...base.references, authorization: 'x' } },
          { ...base, eventId: 'aoc.aev:forged' },
          { ...base, sequence: 1 },
        ]) {
          await rejectsWith(harness.store.append(A, bad as unknown as AppendAuthorityEventInput), 'AUTHORITY_EVENT_INPUT_INVALID');
        }
        assert.equal((await harness.store.readStream(A, base.streamId)).length, 1);
      } finally {
        await harness.close();
      }
    });

    it('a clock that answers no instant appends nothing', async () => {
      let broken = false;
      const clock = steppingClock();
      const harness = await open(() => (broken ? 'not-a-time' : clock.now()));
      try {
        await harness.store.append(A, decision());
        broken = true;
        await rejectsWith(harness.store.append(A, attempt('aoc.exec:clock')), 'AUTHORITY_EVENT_STREAM_UNAVAILABLE');
        broken = false;
        assert.equal((await harness.store.readStream(A, decision().streamId)).length, 1);
      } finally {
        await harness.close();
      }
    });

    it('has no update, delete, truncate, repair or cleanup API — only append, read, verify, health, close', async () => {
      const harness = await open(steppingClock().now);
      try {
        assert.deepEqual(Object.keys(harness.store).sort(), ['append', 'close', 'health', 'providerKind', 'readStream', 'verifyStream']);
        for (const forbidden of ['update', 'delete', 'remove', 'truncate', 'repair', 'rewrite', 'cleanup', 'sweep', 'purge', 'setHead']) {
          assert.equal(forbidden in harness.store, false, forbidden);
        }
      } finally {
        await harness.close();
      }
    });

    it('an unknown stream reads as empty and verifies as empty', async () => {
      const harness = await open(steppingClock().now);
      try {
        assert.deepEqual([...(await harness.store.readStream(A, decision().streamId))], []);
        const verification = await harness.store.verifyStream(A, decision().streamId);
        assert.equal(verification.valid, true);
        assert.equal(verification.eventCount, 0);
      } finally {
        await harness.close();
      }
    });

    it('survives a restart: the reopened store holds the same verified chain and continues it at head + 1', async (t) => {
      const harness = await open(steppingClock().now);
      if (harness.reopen === undefined) {
        await harness.close();
        t.skip('not durable');
        return;
      }
      const before = [(await harness.store.append(A, decision())).event, (await harness.store.append(A, attempt('aoc.exec:r1'))).event];
      const reopened = await harness.reopen();
      try {
        assert.deepEqual([...(await reopened.readStream(A, decision().streamId))], before);
        assert.equal((await reopened.append(A, decision())).outcome, 'existing');
        const next = await reopened.append(A, attempt('aoc.exec:r2'));
        assert.equal(next.event.sequence, 3);
        assert.equal(next.event.previousEventDigest, before[1]?.eventDigest);
      } finally {
        await reopened.close();
      }
    });
  });
}
