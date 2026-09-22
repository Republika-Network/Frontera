import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  EXERCISE_CONTROL_REASON_CODES as R,
  createExerciseControlGate,
  exerciseControlPolicyDigest,
  exerciseReservationId,
  exerciseReservationRequestDigest,
  sortExerciseControlLimits,
  type ExerciseControlLedgerPort,
  type ExerciseControlLimit,
  type ExerciseReservationRequest,
} from '../index.js';

/**
 * The one behavioural contract every `ExerciseControlLedgerPort` must honour,
 * written once and run against **both** implementations — the in-memory ledger
 * here and the production SQLite ledger in
 * `src/enterprise/__tests__/exercise-control-sqlite.test.ts` — so a test cannot
 * pass against the process-local ledger while proving a weaker rule than
 * production enforces.
 *
 * The ledger under test is opened over a clock this contract controls, because
 * the reservation instant is the **ledger's**: sampled inside its admission
 * critical section, never handed in by a caller.
 */

export const BINDING = `sha256:${'b'.repeat(64)}`;
export const OTHER_BINDING = `sha256:${'c'.repeat(64)}`;
export const T0 = '2026-03-01T00:00:00.000Z';

export function at(seconds: number): string {
  return new Date(Date.parse(T0) + seconds * 1000).toISOString();
}

export const count = (limitId: string, scopeKey: string, maximum: number, window: ExerciseControlLimit['window'] = { kind: 'lifetime' }): ExerciseControlLimit => ({
  limitId,
  scopeKey,
  metric: 'count',
  maximum,
  window,
});

export const amount = (limitId: string, scopeKey: string, maximum: string, unit: string, window: ExerciseControlLimit['window'] = { kind: 'lifetime' }): ExerciseControlLimit => ({
  limitId,
  scopeKey,
  metric: 'amount',
  maximum,
  unit,
  window,
});

export interface ReservationSpec {
  readonly executionId: string;
  readonly limits: readonly ExerciseControlLimit[];
  readonly boundedGrantId?: string;
  readonly action?: string;
  /** Canonical decimal text and unit. */
  readonly amount?: { readonly value: string; readonly unit: string };
  readonly authorityBindingDigest?: string;
}

/** A well-formed reservation request, built the way the gate builds one. */
export function reservation(spec: ReservationSpec): ExerciseReservationRequest {
  const boundedGrantId = spec.boundedGrantId ?? 'aoc.grant:contract';
  const limits = sortExerciseControlLimits(spec.limits);
  return {
    reservationId: exerciseReservationId({ boundedGrantId, executionId: spec.executionId }),
    executionId: spec.executionId,
    boundedGrantId,
    requestDigest: exerciseReservationRequestDigest({
      boundedGrantId,
      executionId: spec.executionId,
      subject: 'agent-A',
      action: spec.action ?? 'payment',
      resource: 'vendor/V123',
      ...(spec.amount !== undefined ? { amount: spec.amount } : {}),
      correlation: { requestId: 'req-1', decisionId: 'dec-1', action: 'payment', resourceScope: 'vendor/V123' },
    }),
    policyDigest: exerciseControlPolicyDigest(limits),
    authorityBindingDigest: spec.authorityBindingDigest ?? BINDING,
    rules: limits.map((limit) => {
      if (limit.metric === 'count') return { limit, usage: '1' };
      assert.ok(spec.amount !== undefined, 'an amount rule needs an amount in the test spec');
      return { limit, usage: spec.amount.value };
    }),
  };
}

export interface LedgerUnderTest {
  readonly ledger: ExerciseControlLedgerPort;
  close?(): Promise<void>;
}

let sequence = 0;
const nextId = (label: string): string => `exec-${label}-${(sequence += 1)}`;

/** A clock a test moves by hand. The ledger under test samples it inside admission. */
export interface ManualClock {
  readonly now: () => string;
  set(instant: string): void;
  advance(seconds: number): void;
}

export function manualClock(start: string = T0): ManualClock {
  let current = start;
  return {
    now: () => current,
    set(instant) {
      current = instant;
    },
    advance(seconds) {
      current = new Date(Date.parse(current) + seconds * 1000).toISOString();
    },
  };
}

export function describeExerciseControlLedgerContract(name: string, open: (now: () => string) => Promise<LedgerUnderTest>): void {
  // One clock per contract, reset to T0 for every test, read by the ledger.
  const clock = manualClock();

  async function withLedger(run: (ledger: ExerciseControlLedgerPort) => Promise<void>): Promise<void> {
    clock.set(T0);
    const subject = await open(clock.now);
    try {
      await run(subject.ledger);
    } finally {
      await subject.close?.();
    }
  }

  /** Reserve with the ledger clock standing at `at` (T0 by default): the instant the ledger will admit at. */
  async function reserve(ledger: ExerciseControlLedgerPort, spec: Omit<ReservationSpec, 'executionId'> & { readonly executionId?: string; readonly at?: string }) {
    const { at: instant = T0, ...rest } = spec;
    clock.set(instant);
    return ledger.reserve(reservation({ executionId: spec.executionId ?? nextId('r'), ...rest }));
  }

  describe(`${name} — §40 aggregate count`, () => {
    const one = [count('grant-uses', 'grant:g1', 1)];

    it('1–2. lifetime max=1: the first reserve succeeds and a second active execution is refused', () =>
      withLedger(async (ledger) => {
        assert.equal((await reserve(ledger, { limits: one })).outcome, 'reserved');
        const second = await reserve(ledger, { limits: one });
        assert.equal(second.outcome, 'refused');
        assert.deepEqual(second.outcome === 'refused' ? [...second.reasonCodes] : [], [R.EXERCISE_CONTROL_LIMIT_EXCEEDED]);
        assert.deepEqual(second.outcome === 'refused' ? second.refusedBuckets : [], [{ limitId: 'grant-uses', scopeKey: 'grant:g1' }]);
      }));

    it('3. a settled reservation still consumes', () =>
      withLedger(async (ledger) => {
        const first = reservation({ executionId: nextId('settled'), limits: one });
        await ledger.reserve(first);
        assert.equal((await ledger.settle({ reservationId: first.reservationId, reason: 'executed', recordedAt: at(1) })).outcome, 'settled');
        assert.equal((await reserve(ledger, { limits: one })).outcome, 'refused');
      }));

    it('4. a released reservation no longer consumes', () =>
      withLedger(async (ledger) => {
        const first = reservation({ executionId: nextId('released'), limits: one });
        await ledger.reserve(first);
        assert.equal((await ledger.release({ reservationId: first.reservationId, reason: 'execution-failed', recordedAt: at(1) })).outcome, 'released');
        assert.equal((await reserve(ledger, { limits: one })).outcome, 'reserved');
      }));

    it('5. a pending (reserved, unfinalized) reservation consumes', () =>
      withLedger(async (ledger) => {
        const first = reservation({ executionId: nextId('pending'), limits: one });
        await ledger.reserve(first);
        assert.equal((await ledger.read(first.reservationId))?.state, 'reserved');
        assert.equal((await reserve(ledger, { limits: one })).outcome, 'refused');
      }));

    it('6. lifetime max=3: three pass, the fourth is refused', () =>
      withLedger(async (ledger) => {
        const three = [count('grant-uses', 'grant:g3', 3)];
        for (let index = 0; index < 3; index += 1) assert.equal((await reserve(ledger, { limits: three })).outcome, 'reserved');
        assert.equal((await reserve(ledger, { limits: three })).outcome, 'refused');
      }));

    it('7. count is scoped by limitId', () =>
      withLedger(async (ledger) => {
        await reserve(ledger, { limits: [count('limit-a', 'shared-scope', 1)] });
        assert.equal((await reserve(ledger, { limits: [count('limit-b', 'shared-scope', 1)] })).outcome, 'reserved');
        assert.equal((await reserve(ledger, { limits: [count('limit-a', 'shared-scope', 1)] })).outcome, 'refused');
      }));

    it('8–9. count is scoped by scopeKey, and another scope is not consumed', () =>
      withLedger(async (ledger) => {
        await reserve(ledger, { limits: [count('per-actor', 'actor:actor-1', 1)] });
        assert.equal((await reserve(ledger, { limits: [count('per-actor', 'actor:actor-2', 1)] })).outcome, 'reserved');
        assert.equal((await reserve(ledger, { limits: [count('per-actor', 'actor:actor-1', 1)] })).outcome, 'refused');
        assert.equal((await reserve(ledger, { limits: [count('per-actor', 'actor:actor-2', 1)] })).outcome, 'refused');
      }));

    it('an empty limit set still reserves: the execution identity is recorded even when no aggregate applies', () =>
      withLedger(async (ledger) => {
        const request = reservation({ executionId: nextId('no-limits'), limits: [] });
        assert.equal((await ledger.reserve(request)).outcome, 'reserved');
        assert.equal((await ledger.read(request.reservationId))?.state, 'reserved');
      }));
  });

  describe(`${name} — §41 rolling velocity`, () => {
    const velocity = [count('velocity', 'grant:v', 2, { kind: 'rolling', seconds: 60 })];

    it('1–4. max 2 / 60s: t=0 and t=10 reserve, and a third at t=20 is refused', () =>
      withLedger(async (ledger) => {
        assert.equal((await reserve(ledger, { limits: velocity, at: at(0) })).outcome, 'reserved');
        assert.equal((await reserve(ledger, { limits: velocity, at: at(10) })).outcome, 'reserved');
        const third = await reserve(ledger, { limits: velocity, at: at(20) });
        assert.equal(third.outcome, 'refused');
        assert.deepEqual(third.outcome === 'refused' ? [...third.reasonCodes] : [], [R.EXERCISE_CONTROL_LIMIT_EXCEEDED]);
      }));

    it('the window edge is exact: a reservation leaves exactly `seconds` after its reservation instant', () =>
      withLedger(async (ledger) => {
        const edge = [count('edge', 'grant:e', 1, { kind: 'rolling', seconds: 60 })];
        assert.equal((await reserve(ledger, { limits: edge, at: at(0) })).outcome, 'reserved');
        assert.equal((await reserve(ledger, { limits: edge, at: at(59.999) })).outcome, 'refused');
        assert.equal((await reserve(ledger, { limits: edge, at: at(60) })).outcome, 'reserved');
      }));

    it('5. at t=61 the t=0 reservation has aged out and one more is admitted', () =>
      withLedger(async (ledger) => {
        await reserve(ledger, { limits: velocity, at: at(0) });
        await reserve(ledger, { limits: velocity, at: at(10) });
        assert.equal((await reserve(ledger, { limits: velocity, at: at(61) })).outcome, 'reserved');
        assert.equal((await reserve(ledger, { limits: velocity, at: at(62) })).outcome, 'refused');
      }));

    it('6. settled rows age by reservation time, not settlement time', () =>
      withLedger(async (ledger) => {
        const early = reservation({ executionId: nextId('age'), limits: [count('age', 'grant:a', 1, { kind: 'rolling', seconds: 60 })] });
        await ledger.reserve(early);
        await ledger.settle({ reservationId: early.reservationId, reason: 'executed', recordedAt: at(59) });
        assert.equal((await reserve(ledger, { limits: [count('age', 'grant:a', 1, { kind: 'rolling', seconds: 60 })], at: at(61) })).outcome, 'reserved');
      }));

    it('7. a released row does not count inside the window', () =>
      withLedger(async (ledger) => {
        const first = reservation({ executionId: nextId('rel'), limits: velocity });
        await ledger.reserve(first);
        await reserve(ledger, { limits: velocity, at: at(1) });
        await ledger.release({ reservationId: first.reservationId, reason: 'emergency-control', recordedAt: at(2) });
        assert.equal((await reserve(ledger, { limits: velocity, at: at(3) })).outcome, 'reserved');
      }));

    it('8. a pending row counts inside the window', () =>
      withLedger(async (ledger) => {
        await reserve(ledger, { limits: velocity, at: at(0) });
        await reserve(ledger, { limits: velocity, at: at(1) });
        assert.equal((await reserve(ledger, { limits: velocity, at: at(2) })).outcome, 'refused');
      }));

    it('9. a reservation apparently in the future is counted conservatively — clock rollback frees nothing', () =>
      withLedger(async (ledger) => {
        const rolled = [count('rollback', 'grant:r', 1, { kind: 'rolling', seconds: 60 })];
        assert.equal((await reserve(ledger, { limits: rolled, at: at(3600) })).outcome, 'reserved');
        assert.equal((await reserve(ledger, { limits: rolled, at: at(0) })).outcome, 'refused', 'the clock went back an hour; the future reservation still counts');
      }));
  });

  describe(`${name} — §42 exact amounts`, () => {
    it('1–2. max "100": 60 then 40 fills it exactly, and the smallest further positive amount is refused', () =>
      withLedger(async (ledger) => {
        const budget = (value: string) => ({ limits: [amount('spend', 'grant:s', '100', 'USD')], amount: { value, unit: 'USD' } });
        assert.equal((await reserve(ledger, budget('60'))).outcome, 'reserved');
        assert.equal((await reserve(ledger, budget('40'))).outcome, 'reserved');
        const over = await reserve(ledger, budget('0.000000000000000000000000000001'));
        assert.equal(over.outcome, 'refused');
        assert.deepEqual(over.outcome === 'refused' ? [...over.reasonCodes] : [], [R.EXERCISE_CONTROL_LIMIT_EXCEEDED]);
      }));

    it('3–4. 0.1 + 0.2 under "0.3" is admitted exactly — never 0.30000000000000004 — and anything more is refused', () =>
      withLedger(async (ledger) => {
        const budget = (value: string) => ({ limits: [amount('spend', 'grant:f', '0.3', 'USD')], amount: { value, unit: 'USD' } });
        assert.equal((await reserve(ledger, budget('0.1'))).outcome, 'reserved');
        assert.equal((await reserve(ledger, budget('0.2'))).outcome, 'reserved', 'exactly full');
        assert.equal((await reserve(ledger, budget('0.0000001'))).outcome, 'refused');
      }));

    it('6. a large finite decimal is summed exactly', () =>
      withLedger(async (ledger) => {
        const big = '99999999999999999999999999999999999999.000000000000000000000001';
        const limits = [amount('spend', 'grant:big', '199999999999999999999999999999999999998.000000000000000000000002', 'USD')];
        assert.equal((await reserve(ledger, { limits, amount: { value: big, unit: 'USD' } })).outcome, 'reserved');
        assert.equal((await reserve(ledger, { limits, amount: { value: big, unit: 'USD' } })).outcome, 'reserved');
        assert.equal((await reserve(ledger, { limits, amount: { value: '0.000000000000000000000001', unit: 'USD' } })).outcome, 'refused');
      }));

    it('8–9. usage in USD cannot be summed into an EUR limit on the same bucket, and nothing is converted', () =>
      withLedger(async (ledger) => {
        assert.equal((await reserve(ledger, { limits: [amount('spend', 'grant:fx', '100', 'USD')], amount: { value: '10', unit: 'USD' } })).outcome, 'reserved');
        const eur = await reserve(ledger, { limits: [amount('spend', 'grant:fx', '1000000', 'EUR')], amount: { value: '1', unit: 'EUR' } });
        assert.equal(eur.outcome, 'refused');
        assert.deepEqual(eur.outcome === 'refused' ? [...eur.reasonCodes] : [], [R.EXERCISE_CONTROL_UNIT_MISMATCH]);
      }));

    it('15. release restores amount capacity', () =>
      withLedger(async (ledger) => {
        const limits = [amount('spend', 'grant:rel', '100', 'USD')];
        const first = reservation({ executionId: nextId('amt'), limits, amount: { value: '100', unit: 'USD' } });
        await ledger.reserve(first);
        assert.equal((await reserve(ledger, { limits, amount: { value: '1', unit: 'USD' } })).outcome, 'refused');
        await ledger.release({ reservationId: first.reservationId, reason: 'execution-failed', recordedAt: at(1) });
        assert.equal((await reserve(ledger, { limits, amount: { value: '100', unit: 'USD' } })).outcome, 'reserved');
      }));

    it('16. an unconfirmed (settled) effect does NOT restore amount capacity', () =>
      withLedger(async (ledger) => {
        const limits = [amount('spend', 'grant:unc', '100', 'USD')];
        const first = reservation({ executionId: nextId('unc'), limits, amount: { value: '100', unit: 'USD' } });
        await ledger.reserve(first);
        await ledger.settle({ reservationId: first.reservationId, reason: 'execution-unconfirmed', recordedAt: at(1) });
        assert.equal((await reserve(ledger, { limits, amount: { value: '0.01', unit: 'USD' } })).outcome, 'refused');
      }));
  });

  describe(`${name} — §16 atomic admission across every limit`, () => {
    it('one refusing limit refuses the whole reservation, and the other bucket is left untouched', () =>
      withLedger(async (ledger) => {
        const small = count('small', 'grant:x', 1);
        const large = count('large', 'grant:x', 10);
        await reserve(ledger, { limits: [small] });
        const both = await reserve(ledger, { limits: [small, large] });
        assert.equal(both.outcome, 'refused');
        assert.deepEqual(both.outcome === 'refused' ? both.refusedBuckets : [], [{ limitId: 'small', scopeKey: 'grant:x' }]);
        // Nothing was reserved against `large`: ten more fit.
        for (let index = 0; index < 10; index += 1) assert.equal((await reserve(ledger, { limits: [large] })).outcome, 'reserved');
        assert.equal((await reserve(ledger, { limits: [large] })).outcome, 'refused');
      }));

    it('a refused reservation writes nothing: its id stays unknown', () =>
      withLedger(async (ledger) => {
        await reserve(ledger, { limits: [count('solo', 'grant:w', 1)] });
        const refused = reservation({ executionId: nextId('refused'), limits: [count('solo', 'grant:w', 1)] });
        assert.equal((await ledger.reserve(refused)).outcome, 'refused');
        assert.equal(await ledger.read(refused.reservationId), undefined);
      }));
  });

  describe(`${name} — §44 reservation identity`, () => {
    const limits = [count('identity', 'grant:i', 5)];

    it('1. the same execution, request, policy and provenance is already-reserved and writes nothing', () =>
      withLedger(async (ledger) => {
        const request = reservation({ executionId: nextId('same'), limits });
        assert.equal((await ledger.reserve(request)).outcome, 'reserved');
        clock.set(at(30));
        const again = await ledger.reserve(request);
        assert.equal(again.outcome, 'already-reserved');
        assert.equal(again.outcome === 'already-reserved' ? again.reservation.reservedAt : undefined, T0, 'the first reservation stands, never re-dated');
        // Four more fit, so the re-delivery did not consume a second unit.
        for (let index = 0; index < 4; index += 1) assert.equal((await reserve(ledger, { limits })).outcome, 'reserved');
        assert.equal((await reserve(ledger, { limits })).outcome, 'refused');
      }));

    for (const [label, change] of [
      ['2. altered action', { action: 'refund' }],
      ['3. altered amount', { amount: { value: '2', unit: 'USD' } }],
      ['5. altered policy limit', { limits: [count('identity', 'grant:i', 6)] }],
      ['6. altered authority-binding provenance', { authorityBindingDigest: OTHER_BINDING }],
    ] as const) {
      it(`${label} under the same reservation id is a conflict and writes nothing`, () =>
        withLedger(async (ledger) => {
          const executionId = nextId('conflict');
          const base: ReservationSpec = { executionId, limits, amount: { value: '1', unit: 'USD' } };
          const original = reservation(base);
          assert.equal((await ledger.reserve(original)).outcome, 'reserved');
          const altered = reservation({ ...base, ...change });
          assert.equal(altered.reservationId, original.reservationId);
          assert.equal((await ledger.reserve(altered)).outcome, 'conflict');
          const view = await ledger.read(original.reservationId);
          assert.equal(view?.reservation.requestDigest, original.requestDigest, 'the original stands unchanged');
          assert.equal(view?.reservation.policyDigest, original.policyDigest);
          assert.equal(view?.reservation.authorityBindingDigest, original.authorityBindingDigest);
        }));
    }

    it('4. the same execution id under a different grant is a conflict — one execution identity is one attempt', () =>
      withLedger(async (ledger) => {
        const executionId = nextId('grant');
        assert.equal((await ledger.reserve(reservation({ executionId, limits, boundedGrantId: 'aoc.grant:one' }))).outcome, 'reserved');
        const other = reservation({ executionId, limits, boundedGrantId: 'aoc.grant:two' });
        assert.equal((await ledger.reserve(other)).outcome, 'conflict');
        assert.equal(await ledger.read(other.reservationId), undefined);
      }));

    it('a request whose reservation id is not the one its grant and execution derive is refused before anything is written', () =>
      withLedger(async (ledger) => {
        const request = reservation({ executionId: nextId('forged'), limits });
        await assert.rejects(ledger.reserve({ ...request, boundedGrantId: 'aoc.grant:someone-else' }));
        await assert.rejects(ledger.reserve({ ...request, policyDigest: `sha256:${'0'.repeat(64)}` }), 'a policy digest that does not match the rules is refused');
        await assert.rejects(ledger.reserve({ ...request, rules: [{ limit: count('identity', 'grant:i', 5), usage: '2' }] }), 'a count consumes exactly one');
        assert.equal(await ledger.read(request.reservationId), undefined);
      }));
  });

  describe(`${name} — the reservation instant is the ledger's admission instant`, () => {
    const rolling = [count('lock-wait', 'grant:lw', 1, { kind: 'rolling', seconds: 60 })];

    /**
     * A ledger whose admission is delayed: time moves on while the caller waits
     * for it — the SQLite `BEGIN IMMEDIATE` write-lock wait, simulated — and only
     * then does the ledger under test run its critical section.
     */
    function delayed(ledger: ExerciseControlLedgerPort, waitSeconds: number): ExerciseControlLedgerPort {
      return {
        async reserve(request) {
          clock.advance(waitSeconds);
          return ledger.reserve(request);
        },
        settle: (input) => ledger.settle(input),
        release: (input) => ledger.release(input),
        read: (reservationId) => ledger.read(reservationId),
      };
    }

    it('the returned record carries the instant the ledger sampled, and it is the one persisted', () =>
      withLedger(async (ledger) => {
        const request = reservation({ executionId: nextId('instant'), limits: rolling });
        clock.set(at(5));
        const outcome = await ledger.reserve(request);
        assert.equal(outcome.outcome === 'reserved' ? outcome.reservation.reservedAt : undefined, at(5));
        assert.equal((await ledger.read(request.reservationId))?.reservation.reservedAt, at(5));
      }));

    it('max=1 / 60 s through the gate: a reservation assessed at t=0 that waits 5 s to be admitted blocks until t=65, not t=60', () =>
      withLedger(async (inner) => {
        const gate = createExerciseControlGate({ policy: () => rolling, authorityBinding: () => BINDING, reservationLedger: delayed(inner, 5), now: clock.now });
        const admit = (executionId: string, assessedAt: string) =>
          gate.admit({
            grant: { id: 'aoc.grant:contract', subject: 'agent-A', issuedAt: at(-60), expiresAt: at(3600), correlation: { requestId: 'req-1', decisionId: 'dec-1', action: 'payment', resourceScope: 'vendor/V123' }, authorityBindingDigest: BINDING },
            attempt: { action: 'payment', resource: 'vendor/V123' },
            executionId,
            at: assessedAt,
          });

        // Assessed at t=0; the ledger admits at t=5, after the simulated wait.
        clock.set(at(0));
        const first = await admit('lock-wait-1', at(0));
        assert.equal(first.kind, 'admitted');
        const reservationId = first.kind === 'admitted' ? first.reservation.reservationId : '';
        assert.equal((await inner.read(reservationId))?.reservation.reservedAt, at(5), 'the persisted instant is the ledger admission instant, not the assessment instant');

        // Immediately after it completes, and for the FULL window from t=5, it blocks.
        for (const seconds of [5, 30, 60, 64.999]) {
          clock.set(at(seconds));
          const blocked = await inner.reserve(reservation({ executionId: nextId('blocked'), limits: rolling }));
          assert.equal(blocked.outcome, 'refused', `still inside the window at t=${String(seconds)}`);
        }
        // At the real reservation instant + window, capacity returns.
        clock.set(at(65));
        assert.equal((await inner.reserve(reservation({ executionId: nextId('after'), limits: rolling }))).outcome, 'reserved');
      }));
  });

  describe(`${name} — §45 settlement and release`, () => {
    const limits = [count('terminal', 'grant:t', 10)];

    it('11. a repeated identical settlement is idempotent, and the first event stands', () =>
      withLedger(async (ledger) => {
        const request = reservation({ executionId: nextId('s'), limits });
        await ledger.reserve(request);
        assert.equal((await ledger.settle({ reservationId: request.reservationId, reason: 'executed', recordedAt: at(1) })).outcome, 'settled');
        const again = await ledger.settle({ reservationId: request.reservationId, reason: 'executed', recordedAt: at(2) });
        assert.equal(again.outcome, 'already-settled');
        assert.equal(again.outcome === 'already-settled' ? again.terminal.recordedAt : undefined, at(1));
      }));

    it('12. a repeated identical release is idempotent', () =>
      withLedger(async (ledger) => {
        const request = reservation({ executionId: nextId('r'), limits });
        await ledger.reserve(request);
        assert.equal((await ledger.release({ reservationId: request.reservationId, reason: 'execution-failed', recordedAt: at(1) })).outcome, 'released');
        assert.equal((await ledger.release({ reservationId: request.reservationId, reason: 'execution-failed', recordedAt: at(2) })).outcome, 'already-released');
      }));

    it('13. release after settle is refused, and the reservation keeps consuming', () =>
      withLedger(async (ledger) => {
        const one = [count('terminal-one', 'grant:t1', 1)];
        const request = reservation({ executionId: nextId('rs'), limits: one });
        await ledger.reserve(request);
        await ledger.settle({ reservationId: request.reservationId, reason: 'execution-unconfirmed', recordedAt: at(1) });
        const release = await ledger.release({ reservationId: request.reservationId, reason: 'execution-failed', recordedAt: at(2) });
        assert.equal(release.outcome, 'conflict');
        assert.equal((await ledger.read(request.reservationId))?.state, 'settled');
        assert.equal((await reserve(ledger, { limits: one })).outcome, 'refused');
      }));

    it('14. settle after release is refused', () =>
      withLedger(async (ledger) => {
        const request = reservation({ executionId: nextId('sr'), limits });
        await ledger.reserve(request);
        await ledger.release({ reservationId: request.reservationId, reason: 'emergency-control', recordedAt: at(1) });
        assert.equal((await ledger.settle({ reservationId: request.reservationId, reason: 'executed', recordedAt: at(2) })).outcome, 'conflict');
        assert.equal((await ledger.read(request.reservationId))?.state, 'released');
      }));

    it('the same terminal kind for a different reason is a conflict, not an overwrite', () =>
      withLedger(async (ledger) => {
        const request = reservation({ executionId: nextId('reason'), limits });
        await ledger.reserve(request);
        await ledger.release({ reservationId: request.reservationId, reason: 'execution-failed', recordedAt: at(1) });
        const other = await ledger.release({ reservationId: request.reservationId, reason: 'emergency-control', recordedAt: at(2) });
        assert.equal(other.outcome, 'conflict');
        assert.equal((await ledger.read(request.reservationId))?.terminal?.reason, 'execution-failed');
      }));

    it('a terminal transition for an unknown reservation writes nothing', () =>
      withLedger(async (ledger) => {
        assert.equal((await ledger.settle({ reservationId: 'aoc.exercise-reservation:unknown', reason: 'executed', recordedAt: at(1) })).outcome, 'not-found');
      }));

    it('a settlement naming a release reason, or a release naming a settlement reason, is outside the contract', () =>
      withLedger(async (ledger) => {
        const request = reservation({ executionId: nextId('vocab'), limits });
        await ledger.reserve(request);
        await assert.rejects(ledger.settle({ reservationId: request.reservationId, reason: 'execution-failed' as never, recordedAt: at(1) }));
        await assert.rejects(ledger.release({ reservationId: request.reservationId, reason: 'executed' as never, recordedAt: at(1) }));
        assert.equal((await ledger.read(request.reservationId))?.state, 'reserved');
      }));

    it('§39. release never deletes: the reservation and its release both stay readable', () =>
      withLedger(async (ledger) => {
        const request = reservation({ executionId: nextId('history'), limits });
        await ledger.reserve(request);
        await ledger.release({ reservationId: request.reservationId, reason: 'exercise-control', recordedAt: at(1) });
        const view = await ledger.read(request.reservationId);
        assert.equal(view?.state, 'released');
        assert.equal(view?.reservation.executionId, request.executionId);
        assert.deepEqual(view?.terminal, { reservationId: request.reservationId, kind: 'released', reason: 'exercise-control', recordedAt: at(1) });
      }));
  });
}
