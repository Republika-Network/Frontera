import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  createExerciseControlGate,
  createInMemoryExerciseControlLedger,
  type ExerciseControlAdmissionInput,
  type ExerciseControlLedgerPort,
  type ExerciseControlObserver,
  type ExerciseControlPolicy,
  type ExerciseReservationObservation,
} from '../index.js';

/**
 * P8 — the gate's write-only observer: told only what the ledger proved, after
 * it proved it, and unable to change **or delay** an admission, a finalization
 * or a revalidation whatever it does.
 *
 * The delay half is the P8 hardening: `reservationObserved` returns `void`, so
 * the gate has nothing to await. A reservation is committed and has no TTL, so a
 * gate that could be held between the ledger's `reserved` and the provider —
 * or between a terminal event and its caller — would leave capacity consumed
 * indefinitely.
 */

const BINDING = `sha256:${'b'.repeat(64)}`;
const AT = '2026-04-01T00:00:00.000Z';
const LEDGER_AT = '2026-04-01T00:00:05.000Z';
const ONE: ExerciseControlPolicy = () => [{ limitId: 'uses', scopeKey: 'grant:g', metric: 'count', maximum: 1, window: { kind: 'lifetime' } }];

function input(executionId: string): ExerciseControlAdmissionInput {
  return {
    grant: { id: 'aoc.grant:g', subject: 'actor-1', issuedAt: AT, expiresAt: '2026-04-01T01:00:00.000Z', correlation: { requestId: 'aoc.gar:r', decisionId: 'decision-1', action: 'pay', resourceScope: 'invoices' }, authorityBindingDigest: BINDING },
    attempt: { action: 'pay', resource: 'invoices' },
    executionId,
    at: AT,
  };
}

function recording(): ExerciseControlObserver & { readonly seen: ExerciseReservationObservation[] } {
  const seen: ExerciseReservationObservation[] = [];
  return {
    seen,
    reservationObserved(observation) {
      seen.push(observation);
    },
  };
}

const throwing: ExerciseControlObserver = {
  reservationObserved() {
    throw new Error('observer exploded');
  },
};

/**
 * The adversarial shape the hardening exists for: an observer that hands back
 * something that never settles. The gate must not be holding anything that
 * could await it — the return value is typed `void` and is dropped.
 */
const neverSettling: ExerciseControlObserver = {
  reservationObserved() {
    return new Promise<void>(() => {}) as unknown as void;
  },
};

function gate(observer?: ExerciseControlObserver, ledger: ExerciseControlLedgerPort = createInMemoryExerciseControlLedger({ now: () => LEDGER_AT })) {
  return createExerciseControlGate({ policy: ONE, authorityBinding: () => BINDING, reservationLedger: ledger, now: () => '2026-04-01T00:00:09.000Z', ...(observer !== undefined ? { observer } : {}) });
}

describe('Exercise-control observer (P8) — what it is told', () => {
  it('reserved carries the ledger\'s own admission instant and fingerprints; settled carries the recorded terminal', async () => {
    const observer = recording();
    const g = gate(observer);
    const admission = await g.admit(input('exec-1'));
    assert.equal(admission.kind, 'admitted');
    assert.equal(observer.seen.length, 1);
    const reserved = observer.seen[0];
    assert.equal(reserved?.kind, 'reserved');
    assert.equal(reserved?.kind === 'reserved' ? reserved.admittedAt : undefined, LEDGER_AT, 'the ledger instant, not the exercise instant');
    assert.equal(reserved?.requestId, 'aoc.gar:r');
    assert.equal(reserved?.kind === 'reserved' ? reserved.authorityBindingDigest : undefined, BINDING);
    if (admission.kind !== 'admitted') return;
    assert.equal(await g.finalize(admission.reservation, { kind: 'settle', reason: 'executed' }), 'settled');
    assert.deepEqual(observer.seen[1], { kind: 'settled', reservationId: admission.reservation.reservationId, executionId: 'exec-1', boundedGrantId: 'aoc.grant:g', requestId: 'aoc.gar:r', decisionId: 'decision-1', reason: 'executed', recordedAt: '2026-04-01T00:00:09.000Z' });
  });

  it('a refused admission, a conflicting terminal and an unrecordable finalization are not observed', async () => {
    const observer = recording();
    const g = gate(observer);
    const first = await g.admit(input('exec-a'));
    assert.equal((await g.admit(input('exec-b'))).kind, 'withheld', 'limit reached');
    assert.equal(observer.seen.length, 1, 'only the admitted reservation');
    if (first.kind !== 'admitted') return;
    await g.finalize(first.reservation, { kind: 'release', reason: 'execution-failed' });
    assert.equal(await g.finalize(first.reservation, { kind: 'settle', reason: 'executed' }), 'retained', 'conflict');
    assert.deepEqual(observer.seen.map((o) => o.kind), ['reserved', 'released']);

    const inner = createInMemoryExerciseControlLedger({ now: () => LEDGER_AT });
    const failing: ExerciseControlLedgerPort = { reserve: (r) => inner.reserve(r), settle: async () => Promise.reject(new Error('disk')), release: async () => Promise.reject(new Error('disk')), read: (id) => inner.read(id) };
    const other = recording();
    const g2 = gate(other, failing);
    const admitted = await g2.admit(input('exec-c'));
    if (admitted.kind !== 'admitted') return assert.fail('expected admission');
    assert.equal(await g2.finalize(admitted.reservation, { kind: 'settle', reason: 'executed' }), 'retained');
    assert.deepEqual(other.seen.map((o) => o.kind), ['reserved']);
  });
});

describe('Exercise-control observer (P8) — it can change nothing', () => {
  it('a throwing observer leaves every admission, revalidation and finalization identical to no observer', async () => {
    const run = async (observer?: ExerciseControlObserver) => {
      const ledger = createInMemoryExerciseControlLedger({ now: () => LEDGER_AT });
      const g = gate(observer, ledger);
      const first = await g.admit(input('exec-x'));
      const second = await g.admit(input('exec-y'));
      const revalidated = first.kind === 'admitted' ? g.revalidate(first.reservation, input('exec-x')) : undefined;
      const finalized = first.kind === 'admitted' ? await g.finalize(first.reservation, { kind: 'release', reason: 'grant-exercise' }) : undefined;
      const third = await g.admit(input('exec-z'));
      const view = first.kind === 'admitted' ? await ledger.read(first.reservation.reservationId) : undefined;
      return { first, second, revalidated, finalized, third: third.kind, state: view?.state };
    };
    const baseline = await run();
    assert.deepEqual(await run(throwing), baseline);
    assert.deepEqual(await run(recording()), baseline);
    assert.deepEqual(await run(neverSettling), baseline, 'a never-settling observer holds nothing');
    assert.equal(baseline.finalized, 'released');
    assert.equal(baseline.third, 'admitted', 'the release really returned capacity in every run');
  });
});

describe('Exercise-control observer (P8) — it can delay nothing', () => {
  it('admission and finalization return while a never-settling observer is outstanding', { timeout: 30_000 }, async () => {
    const ledger = createInMemoryExerciseControlLedger({ now: () => LEDGER_AT });
    const g = gate(neverSettling, ledger);
    const started = Date.now();
    const admission = await g.admit(input('exec-hang'));
    assert.equal(admission.kind, 'admitted', 'the ledger admitted it, and the gate returned');
    if (admission.kind !== 'admitted') return;
    assert.equal(g.revalidate(admission.reservation, input('exec-hang')).kind, 'verified');
    assert.equal(await g.finalize(admission.reservation, { kind: 'settle', reason: 'executed' }), 'settled');
    assert.ok(Date.now() - started < 1_000);
    assert.equal((await ledger.read(admission.reservation.reservationId))?.state, 'settled', 'capacity was finalized, never stranded');
  });
});
