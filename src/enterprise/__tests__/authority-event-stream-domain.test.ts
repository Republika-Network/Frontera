import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  AUTHORITY_EVENT_SCHEMA_VERSION,
  AUTHORITY_EVENT_TYPES,
  authorityEventDigestInput,
  authorityEventInputViolation,
  authorityEventStreamHeadDigest,
  buildAuthorityEvent,
  canonicalAuthorityEventFact,
  computeAuthorityEventDigest,
  deriveAuthorityEventId,
  deriveAuthorityEventStreamId,
  isAuthorityEventType,
  isValidAuthorityEventInput,
  verifyAuthorityEventStream,
  type AppendAuthorityEventInput,
  type AuthorityEvent,
  type AuthorityEventBody,
} from '../authority-event-stream/index.js';
import { ORG_A, ORG_B, REQUEST_1, REQUEST_2, T0, attempt, bodies, decision, eventInput } from './authority-event-stream-support.js';

/**
 * §7 / §26 — the pure event domain: the closed vocabulary, deterministic
 * identity, the canonical digest input, the closed per-type contract, and chain
 * verification that fails closed on every kind of mutation.
 */

const R1 = '2026-03-01T12:00:00.000Z';

/** A valid, fully built chain of `count` events for REQUEST_1. */
function chain(count: number): AuthorityEvent[] {
  const inputs: AppendAuthorityEventInput[] = [decision(), ...Array.from({ length: count - 1 }, (_, index) => attempt(`aoc.exec:chain-${index}`))];
  const events: AuthorityEvent[] = [];
  inputs.forEach((input, index) => {
    const previous = events[index - 1];
    events.push(buildAuthorityEvent(input, { sequence: index + 1, recordedAt: new Date(Date.parse(R1) + index * 1000).toISOString(), ...(previous !== undefined ? { previousEventDigest: previous.eventDigest } : {}) }));
  });
  return events;
}

function headOf(events: readonly AuthorityEvent[]) {
  const last = events[events.length - 1];
  assert.ok(last !== undefined);
  const head = { streamId: last.streamId, organizationId: last.organizationId, sequence: last.sequence, eventDigest: last.eventDigest };
  return { head, headDigest: authorityEventStreamHeadDigest(head) };
}

/** A mutable copy of one event, re-typed so a test can do what a raw writer could. */
function edit(event: AuthorityEvent, change: Record<string, unknown>): AuthorityEvent {
  return { ...JSON.parse(JSON.stringify(event)), ...change } as AuthorityEvent;
}

describe('Authority event domain — §7 the closed vocabulary', () => {
  it('is exactly the nine lifecycle facts Stage A projects, plus the two P12 resolution facts', () => {
    assert.deepEqual([...AUTHORITY_EVENT_TYPES], [
      'governance.decision.committed',
      'grant.issued',
      'grant.revoked',
      'grant.expiry.observed',
      'execution.attempt.claimed',
      'exercise.reservation.reserved',
      'exercise.reservation.settled',
      'exercise.reservation.released',
      'execution.outcome.observed',
      'execution.outcome.resolved',
      'exercise.reservation.reconciled',
    ]);
    for (const type of AUTHORITY_EVENT_TYPES) assert.equal(isAuthorityEventType(type), true);
  });

  it('every event type has a valid shape, and each is accepted', () => {
    for (const [type, body] of Object.entries(bodies())) {
      assert.equal(authorityEventInputViolation(eventInput(body)), undefined, type);
    }
  });

  it('an unknown kind is refused — including decision-flavoured and authority-flavoured names', () => {
    for (const kind of ['grant.minted', 'decision.allowed', 'authorization.granted', 'quota.consumed', 'execution.retry', 'GRANT.ISSUED', '', 42]) {
      assert.equal(isAuthorityEventType(kind), false, String(kind));
      assert.notEqual(authorityEventInputViolation({ ...attempt('aoc.exec:k'), eventType: kind }), undefined, String(kind));
    }
  });

  it('names no allow/deny/permit event — the vocabulary reports facts and cannot express a permission', () => {
    for (const type of AUTHORITY_EVENT_TYPES) assert.equal(/allow|deny|permit|authoriz|approve|entitle/i.test(type), false, type);
  });
});

describe('Authority event domain — §8 / §9 deterministic identity', () => {
  it('a stream id is derived from organization and request, and nothing else', () => {
    const a = deriveAuthorityEventStreamId({ organizationId: ORG_A, requestId: REQUEST_1 });
    assert.equal(a, deriveAuthorityEventStreamId({ organizationId: ORG_A, requestId: REQUEST_1 }));
    assert.match(a, /^aoc\.aes:[0-9a-f]{32}$/);
    assert.notEqual(a, deriveAuthorityEventStreamId({ organizationId: ORG_B, requestId: REQUEST_1 }), 'tenant is part of the identity');
    assert.notEqual(a, deriveAuthorityEventStreamId({ organizationId: ORG_A, requestId: REQUEST_2 }));
  });

  it('an event id is derived from stream, type and source artifact — the same fact re-derives the same id', () => {
    const streamId = deriveAuthorityEventStreamId({ organizationId: ORG_A, requestId: REQUEST_1 });
    const id = deriveAuthorityEventId({ streamId, eventType: 'grant.issued', sourceId: 'aoc.grant:1' });
    assert.equal(id, deriveAuthorityEventId({ streamId, eventType: 'grant.issued', sourceId: 'aoc.grant:1' }));
    assert.match(id, /^aoc\.aev:[0-9a-f]{32}$/);
    assert.notEqual(id, deriveAuthorityEventId({ streamId, eventType: 'grant.revoked', sourceId: 'aoc.grant:1' }), 'type separates issuance from revocation of one grant');
    assert.notEqual(id, deriveAuthorityEventId({ streamId, eventType: 'grant.issued', sourceId: 'aoc.grant:2' }));
    assert.notEqual(id, deriveAuthorityEventId({ streamId: deriveAuthorityEventStreamId({ organizationId: ORG_A, requestId: REQUEST_2 }), eventType: 'grant.issued', sourceId: 'aoc.grant:1' }));
  });

  it('refuses an id its own content does not derive', () => {
    const valid = attempt('aoc.exec:id');
    assert.equal(isValidAuthorityEventInput(valid), true);
    const moved = { ...valid, references: { ...valid.references, executionId: 'aoc.exec:other' } };
    assert.equal(authorityEventInputViolation(moved), undefined, 'shape alone is fine');
    const built = buildAuthorityEvent(moved, { sequence: 2, recordedAt: R1, previousEventDigest: `sha256:${'0'.repeat(64)}` });
    const verification = verifyAuthorityEventStream(moved.streamId, [chain(1)[0] as AuthorityEvent, built], undefined);
    assert.ok(verification.failures.some((failure) => failure.includes('id its own content does not derive')));
  });
});

describe('Authority event domain — §7 canonical serialization and digest input', () => {
  it('the canonical fact does not depend on key insertion order', () => {
    const input = attempt('aoc.exec:order');
    const reordered = JSON.parse(JSON.stringify({ payload: input.payload, occurredAt: input.occurredAt, references: { ...input.references }, organizationId: input.organizationId, eventType: input.eventType, streamId: input.streamId, eventId: input.eventId })) as AppendAuthorityEventInput;
    assert.equal(canonicalAuthorityEventFact(reordered), canonicalAuthorityEventFact(input));
  });

  it('the digest covers every stored security-relevant field, and exactly those', () => {
    const [event] = chain(2).slice(1);
    assert.ok(event !== undefined);
    const input = authorityEventDigestInput(event);
    assert.deepEqual(Object.keys(input).sort(), ['eventId', 'eventType', 'occurredAt', 'organizationId', 'payload', 'previousEventDigest', 'recordedAt', 'references', 'schemaVersion', 'sequence', 'streamId']);
    const mutations: Record<string, unknown> = {
      eventId: 'aoc.aev:ffffffffffffffffffffffffffffffff',
      eventType: 'grant.issued',
      occurredAt: '2026-03-01T10:00:00.001Z',
      organizationId: ORG_B,
      payload: { tampered: true },
      previousEventDigest: `sha256:${'0'.repeat(64)}`,
      recordedAt: '2026-03-01T12:00:00.001Z',
      references: { ...event.references, executionId: 'aoc.exec:other' },
      schemaVersion: 'aoc.authority-event.v0',
      sequence: 9,
      streamId: 'aoc.aes:ffffffffffffffffffffffffffffffff',
    };
    for (const [field, value] of Object.entries(mutations)) {
      assert.notEqual(computeAuthorityEventDigest(edit(event, { [field]: value })), event.eventDigest, field);
    }
    assert.equal(computeAuthorityEventDigest(event), event.eventDigest);
    assert.equal(event.schemaVersion, AUTHORITY_EVENT_SCHEMA_VERSION);
  });

  it('a built event is deep-frozen and carries no undefined keys', () => {
    const event = chain(1)[0] as AuthorityEvent;
    assert.ok(Object.isFrozen(event) && Object.isFrozen(event.payload) && Object.isFrozen(event.references));
    assert.equal('previousEventDigest' in event, false, 'the first event carries no previous digest at all');
  });
});

describe('Authority event domain — §26 the closed per-type contract', () => {
  const base = attempt('aoc.exec:contract');

  it('refuses an invalid timestamp', () => {
    for (const occurredAt of ['2026-03-01T10:00:00Z', '2026-02-30T10:00:00.000Z', '2026-03-01 10:00:00.000Z', '1709287200000', '', 1709287200000, null]) {
      assert.notEqual(authorityEventInputViolation({ ...base, occurredAt }), undefined, String(occurredAt));
    }
    assert.notEqual(authorityEventInputViolation(eventInput({ ...bodies()['grant.issued'], payload: { grantDigest: `sha256:${'a'.repeat(64)}`, expiresAt: 'soon' } } as AuthorityEventBody)), undefined);
  });

  it('refuses an invalid tenant', () => {
    for (const organizationId of ['', ' org-alpha', 'org alpha', 'org\nalpha', 'x'.repeat(300), undefined, 7]) {
      assert.notEqual(authorityEventInputViolation({ ...base, organizationId }), undefined, String(organizationId));
    }
  });

  it('refuses an invalid stream id or event id', () => {
    for (const streamId of ['', 'aoc.aev:0123', 'stream-1', `aoc.aes:${'f'.repeat(300)}`]) assert.notEqual(authorityEventInputViolation({ ...base, streamId }), undefined, streamId);
    for (const eventId of ['', 'aoc.aes:0123', 'uuid-1', `aoc.aev:${'f'.repeat(300)}`]) assert.notEqual(authorityEventInputViolation({ ...base, eventId }), undefined, eventId);
  });

  it('refuses a missing, undeclared or malformed reference', () => {
    const { executionId: _omitted, ...missing } = base.references;
    for (const references of [missing, { ...base.references, reservationId: 'aoc.exercise-reservation:x' }, { ...base.references, correlationId: 'caller' }, { ...base.references, executionId: 42 }, { ...base.references, executionId: 'has space' }, [], 'aoc.gar:x', null]) {
      assert.notEqual(authorityEventInputViolation({ ...base, references }), undefined, JSON.stringify(references));
    }
  });

  it('refuses an undeclared or unsafe payload shape', () => {
    for (const payload of [{ note: 'x' }, { authorization: 'Bearer x' }, { headers: {} }, { url: 'https://x' }, { body: '{}' }, [], null]) {
      assert.notEqual(authorityEventInputViolation({ ...base, payload }), undefined, JSON.stringify(payload));
    }
  });

  it('refuses secret- or destination-shaped VALUES, not only key names', () => {
    const outcome = bodies()['execution.outcome.observed'];
    for (const providerRef of [
      'Bearer sk_live_123',
      'basic dXNlcjpwYXNzd29yZA==',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig',
      '-----BEGIN PRIVATE KEY-----',
      'https://api.erp.example/v1/actions',
      'cookie=session',
      'authorization: token',
      'line\nbreak',
      'x'.repeat(513),
    ]) {
      const input = eventInput({ ...outcome, payload: { ...outcome.payload, providerRef } } as AuthorityEventBody);
      assert.notEqual(authorityEventInputViolation(input), undefined, providerRef);
    }
  });

  it('has no secret-shaped field anywhere in the contract: every such key is undeclared for every type', () => {
    for (const body of Object.values(bodies())) {
      for (const key of ['authorization', 'cookie', 'token', 'jwt', 'apiKey', 'secret', 'password', 'credential', 'privateKey', 'seed', 'mnemonic', 'headers', 'url', 'origin', 'destination', 'responseBody', 'assertedContext', 'intent', 'detail']) {
        assert.notEqual(authorityEventInputViolation(eventInput({ ...body, payload: { ...body.payload, [key]: 'value' } } as AuthorityEventBody)), undefined, `${body.eventType}.${key}`);
      }
    }
  });

  it('keeps the execution certainty rules: four statuses, never collapsed or blurred', () => {
    const outcome = bodies()['execution.outcome.observed'];
    const withPayload = (payload: Record<string, unknown>) => eventInput({ ...outcome, payload } as AuthorityEventBody);
    const valid = [
      { status: 'executed', reasonCodes: [], outcomeRecorded: true },
      { status: 'execution-failed', failure: 'PROVIDER_REJECTED', reasonCodes: ['PROVIDER_REJECTED'], adapterId: 'a.b', outcomeRecorded: false },
      { status: 'execution-unconfirmed', reasonCodes: [], adapterId: 'a.b', outcomeRecorded: true },
      { status: 'withheld', withheldBy: 'exercise-control', reasonCodes: ['EXERCISE_CONTROL_LIMIT_EXCEEDED'], outcomeRecorded: true },
    ];
    for (const payload of valid) assert.equal(authorityEventInputViolation(withPayload(payload)), undefined, JSON.stringify(payload));
    const blurred = [
      { status: 'success', reasonCodes: [], outcomeRecorded: true },
      { status: true, reasonCodes: [], outcomeRecorded: true },
      { status: 'executed', withheldBy: 'grant-exercise', reasonCodes: [], outcomeRecorded: true },
      { status: 'executed', failure: 'PROVIDER_REJECTED', reasonCodes: [], outcomeRecorded: true },
      { status: 'execution-failed', reasonCodes: ['PROVIDER_REJECTED'], outcomeRecorded: true },
      { status: 'execution-failed', failure: 'PROVIDER_REJECTED', reasonCodes: ['ADAPTER_ERROR'], outcomeRecorded: true },
      { status: 'execution-failed', failure: 'PROVIDER_REJECTED', reasonCodes: ['PROVIDER_REJECTED'], providerRef: 'ref', outcomeRecorded: true },
      { status: 'execution-unconfirmed', reasonCodes: [], providerRef: 'ref', outcomeRecorded: true },
      { status: 'withheld', reasonCodes: ['X'], outcomeRecorded: true },
      { status: 'withheld', withheldBy: 'exercise-control', reasonCodes: [], outcomeRecorded: true },
      { status: 'withheld', withheldBy: 'grant-exercise', reasonCodes: ['GRANT_EXERCISE_REVOKED'], adapterId: 'a.b', outcomeRecorded: true },
      { status: 'withheld', withheldBy: 'caller', reasonCodes: ['X'], outcomeRecorded: true },
      { status: 'executed', reasonCodes: [] },
    ];
    for (const payload of blurred) assert.notEqual(authorityEventInputViolation(withPayload(payload)), undefined, JSON.stringify(payload));
  });
});

describe('Authority event domain — §15 chain verification fails closed', () => {
  it('a valid chain verifies; the first event has no previous digest and event N points at event N-1', () => {
    const events = chain(4);
    assert.equal(events[0]?.previousEventDigest, undefined);
    for (let index = 1; index < events.length; index += 1) assert.equal(events[index]?.previousEventDigest, events[index - 1]?.eventDigest);
    const verification = verifyAuthorityEventStream(events[0]?.streamId ?? '', events, headOf(events));
    assert.equal(verification.valid, true, verification.failures.join('; '));
    assert.equal(verification.eventCount, 4);
  });

  const cases: readonly (readonly [string, (events: AuthorityEvent[]) => AuthorityEvent[]])[] = [
    ['payload mutation', (e) => e.map((event, i) => (i === 1 ? edit(event, { payload: { status: 'executed' } }) : event))],
    ['eventType mutation', (e) => e.map((event, i) => (i === 1 ? edit(event, { eventType: 'grant.issued' }) : event))],
    ['sequence mutation', (e) => e.map((event, i) => (i === 2 ? edit(event, { sequence: 7 }) : event))],
    ['tenant mutation', (e) => e.map((event, i) => (i === 1 ? edit(event, { organizationId: ORG_B }) : event))],
    ['reference mutation', (e) => e.map((event, i) => (i === 1 ? edit(event, { references: { ...event.references, boundedGrantId: 'aoc.grant:other' } }) : event))],
    ['occurredAt mutation', (e) => e.map((event, i) => (i === 1 ? edit(event, { occurredAt: T0.replace('10:00', '09:00') }) : event))],
    ['recordedAt mutation', (e) => e.map((event, i) => (i === 1 ? edit(event, { recordedAt: '2020-01-01T00:00:00.000Z' }) : event))],
    ['previousEventDigest mutation', (e) => e.map((event, i) => (i === 2 ? edit(event, { previousEventDigest: `sha256:${'0'.repeat(64)}` }) : event))],
    ['eventDigest mutation', (e) => e.map((event, i) => (i === 1 ? edit(event, { eventDigest: `sha256:${'0'.repeat(64)}` }) : event))],
    ['a middle event deleted', (e) => e.filter((_, i) => i !== 1)],
    ['a re-sealed event inserted', (e) => [e[0] as AuthorityEvent, buildAuthorityEvent(attempt('aoc.exec:inserted'), { sequence: 2, recordedAt: R1, previousEventDigest: e[0]?.eventDigest as string }), ...e.slice(1)]],
    ['two events swapped', (e) => [e[0] as AuthorityEvent, e[2] as AuthorityEvent, e[1] as AuthorityEvent, ...e.slice(3)]],
    ['a first event that carries a previous digest', (e) => [edit(e[0] as AuthorityEvent, { previousEventDigest: `sha256:${'0'.repeat(64)}` }), ...e.slice(1)]],
    ['a stream that does not begin with its decision', (e) => e.slice(1)],
  ];

  for (const [label, mutate] of cases) {
    it(`detects: ${label} — and reports the whole stream invalid, never a prefix`, () => {
      const events = chain(4);
      const verification = verifyAuthorityEventStream(events[0]?.streamId ?? '', mutate(events), headOf(events));
      assert.equal(verification.valid, false);
      assert.ok(verification.failures.length > 0);
    });
  }

  it('a re-sealed last event behind the old head is detected; re-sealing the head too is the documented integrity limit, not authenticity', () => {
    const events = chain(3);
    const last = events[2] as AuthorityEvent;
    const { eventDigest: _dropped, ...rest } = edit(last, { occurredAt: '2020-01-01T00:00:00.000Z' });
    const resealed = { ...rest, eventDigest: computeAuthorityEventDigest(rest) } as AuthorityEvent;
    const rewritten = [events[0] as AuthorityEvent, events[1] as AuthorityEvent, resealed];
    // Old head: the chain no longer ends where the head says.
    assert.equal(verifyAuthorityEventStream(last.streamId, rewritten, headOf(events)).valid, false);
    // A writer who also re-seals the head is not detectable from inside the data — integrity, not authenticity.
    assert.equal(verifyAuthorityEventStream(last.streamId, rewritten, headOf(rewritten)).valid, true);
  });

  for (const [label, headChange] of [
    ['head sequence mutation', { sequence: 2 }],
    ['head digest mutation', { eventDigest: `sha256:${'0'.repeat(64)}` }],
    ['head organization mutation', { organizationId: ORG_B }],
  ] as const) {
    it(`detects: ${label}`, () => {
      const events = chain(3);
      const { head, headDigest } = headOf(events);
      assert.equal(verifyAuthorityEventStream(head.streamId, events, { head: { ...head, ...headChange }, headDigest }).valid, false);
    });
  }

  it('detects a missing head, a head with no events, and a deleted last event behind an intact head', () => {
    const events = chain(3);
    assert.equal(verifyAuthorityEventStream(events[0]?.streamId ?? '', events, undefined).valid, false);
    assert.equal(verifyAuthorityEventStream(events[0]?.streamId ?? '', [], headOf(events)).valid, false);
    assert.equal(verifyAuthorityEventStream(events[0]?.streamId ?? '', events.slice(0, 2), headOf(events)).valid, false);
  });
});
