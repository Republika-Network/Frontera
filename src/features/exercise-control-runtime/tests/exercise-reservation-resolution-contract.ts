import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  exerciseReservationConsumes,
  exerciseReservationResolutionConsistent,
  type ExerciseControlLedgerPort,
  type ExerciseControlReconciliationPort,
  type ExerciseReservationResolutionInput,
  type ExerciseReservationRequest,
} from '../index.js';
import { T0, amount, at, count, manualClock, reservation } from './exercise-control-ledger-contract.js';

/**
 * P12 — the resolution contract every ledger offering
 * `ExerciseControlReconciliationPort` must honour, run against the in-memory
 * ledger here and the production SQLite ledger in
 * `src/enterprise/__tests__/exercise-control-resolution-sqlite.test.ts`.
 *
 * The property under test: a reservation's **original** terminal history stays
 * exactly as written, and a verified `confirmed-not-completed` resolution row
 * beside it — bound to a P12 resolution digest — stops the whole reservation
 * consuming, in every bucket, atomically. A completion never creates capacity.
 */

export const RESOLUTION_DIGEST = `sha256:${'d'.repeat(64)}`;
export const OTHER_RESOLUTION_DIGEST = `sha256:${'e'.repeat(64)}`;

export type ResolvingLedger = ExerciseControlLedgerPort & ExerciseControlReconciliationPort;

export interface ResolvingLedgerUnderTest {
  readonly ledger: ResolvingLedger;
  close?(): Promise<void>;
}

let sequence = 0;
const nextId = (label: string): string => `exec-p12-${label}-${(sequence += 1)}`;

export function resolutionOf(request: ExerciseReservationRequest, overrides: Partial<ExerciseReservationResolutionInput> = {}): ExerciseReservationResolutionInput {
  return {
    reservationId: request.reservationId,
    executionId: request.executionId,
    resolutionDigest: RESOLUTION_DIGEST,
    resolution: 'confirmed-not-completed',
    basis: 'initial-observation-unconfirmed',
    recordedAt: at(5),
    ...overrides,
  };
}

export function describeExerciseReservationResolutionContract(name: string, open: (now: () => string) => Promise<ResolvingLedgerUnderTest>): void {
  const clock = manualClock();

  async function withLedger(run: (ledger: ResolvingLedger) => Promise<void>): Promise<void> {
    clock.set(T0);
    const subject = await open(clock.now);
    try {
      await run(subject.ledger);
    } finally {
      await subject.close?.();
    }
  }

  const usd = (limitId: string, maximum: string, window: Parameters<typeof amount>[4] = { kind: 'lifetime' }) => amount(limitId, 'org:org-a', maximum, 'USD', window);

  describe(`${name} — P12 §59 effective consumption`, () => {
    it('§125 settled / execution-unconfirmed + confirmed-not-completed: the original event stands, and the capacity returns', () =>
      withLedger(async (ledger) => {
        const limits = [usd('lifetime-usd', '100')];
        const first = reservation({ executionId: nextId('unconfirmed'), limits, amount: { value: '100', unit: 'USD' } });
        assert.equal((await ledger.reserve(first)).outcome, 'reserved');
        await ledger.settle({ reservationId: first.reservationId, reason: 'execution-unconfirmed', recordedAt: at(1) });
        assert.equal((await ledger.reserve(reservation({ executionId: nextId('blocked'), limits, amount: { value: '100', unit: 'USD' } }))).outcome, 'refused');

        const applied = await ledger.reconcileResolution(resolutionOf(first));
        assert.equal(applied.outcome, 'applied');
        const view = await ledger.read(first.reservationId);
        assert.equal(view?.state, 'settled', 'the original terminal event is never rewritten');
        assert.equal(view?.terminal?.reason, 'execution-unconfirmed');
        assert.equal(view?.resolution?.resolution, 'confirmed-not-completed');
        assert.equal(view?.resolution?.resolutionDigest, RESOLUTION_DIGEST);

        assert.equal((await ledger.reserve(reservation({ executionId: nextId('after'), limits, amount: { value: '100', unit: 'USD' } }))).outcome, 'reserved');
      }));

    it('§124 / §138 confirmed-completed keeps the capacity consumed — it never creates capacity', () =>
      withLedger(async (ledger) => {
        const limits = [usd('lifetime-usd', '100')];
        const first = reservation({ executionId: nextId('completed'), limits, amount: { value: '100', unit: 'USD' } });
        await ledger.reserve(first);
        await ledger.settle({ reservationId: first.reservationId, reason: 'execution-unconfirmed', recordedAt: at(1) });
        assert.equal((await ledger.reconcileResolution(resolutionOf(first, { resolution: 'confirmed-completed' }))).outcome, 'applied');
        assert.equal((await ledger.reserve(reservation({ executionId: nextId('still-blocked'), limits, amount: { value: '1', unit: 'USD' } }))).outcome, 'refused');
      }));

    it('§71 claim-only: reserved with no terminal event, resolved not-completed — returned; resolved completed — consumed', () =>
      withLedger(async (ledger) => {
        const limits = [count('uses', 'grant:claim-only', 1)];
        const pending = reservation({ executionId: nextId('pending'), limits });
        await ledger.reserve(pending);
        assert.equal((await ledger.reconcileResolution(resolutionOf(pending, { basis: 'no-initial-observation', resolution: 'confirmed-completed' }))).outcome, 'applied');
        assert.equal((await ledger.reserve(reservation({ executionId: nextId('x'), limits }))).outcome, 'refused');

        const other = [count('uses', 'grant:claim-only-2', 1)];
        const second = reservation({ executionId: nextId('pending-2'), limits: other });
        await ledger.reserve(second);
        assert.equal((await ledger.reconcileResolution(resolutionOf(second, { basis: 'no-initial-observation' }))).outcome, 'applied');
        assert.equal((await ledger.read(second.reservationId))?.state, 'reserved', 'no terminal event is invented');
        assert.equal((await ledger.reserve(reservation({ executionId: nextId('y'), limits: other }))).outcome, 'reserved');
      }));

    it('§62 / §136 one reservation across two limits is released from both, atomically', () =>
      withLedger(async (ledger) => {
        const limits = [usd('lifetime-usd', '100'), usd('rolling-usd', '100', { kind: 'rolling', seconds: 86_400 })];
        const first = reservation({ executionId: nextId('multi'), limits, amount: { value: '100', unit: 'USD' } });
        await ledger.reserve(first);
        await ledger.settle({ reservationId: first.reservationId, reason: 'execution-unconfirmed', recordedAt: at(1) });
        // Neither bucket alone admits another 100.
        assert.equal((await ledger.reserve(reservation({ executionId: nextId('lifetime-only'), limits: [usd('lifetime-usd', '100')], amount: { value: '100', unit: 'USD' } }))).outcome, 'refused');
        assert.equal((await ledger.reserve(reservation({ executionId: nextId('rolling-only'), limits: [usd('rolling-usd', '100', { kind: 'rolling', seconds: 86_400 })], amount: { value: '100', unit: 'USD' } }))).outcome, 'refused');
        await ledger.reconcileResolution(resolutionOf(first));
        assert.equal((await ledger.reserve(reservation({ executionId: nextId('both'), limits, amount: { value: '100', unit: 'USD' } }))).outcome, 'reserved');
      }));

    it('§139 a reservation that already aged out of a rolling window is resolved without creating extra capacity', () =>
      withLedger(async (ledger) => {
        const rolling = [usd('rolling-usd', '100', { kind: 'rolling', seconds: 60 })];
        const old = reservation({ executionId: nextId('aged'), limits: rolling, amount: { value: '100', unit: 'USD' } });
        await ledger.reserve(old);
        await ledger.settle({ reservationId: old.reservationId, reason: 'execution-unconfirmed', recordedAt: at(1) });
        clock.set(at(120));
        const fresh = reservation({ executionId: nextId('fresh'), limits: rolling, amount: { value: '100', unit: 'USD' } });
        assert.equal((await ledger.reserve(fresh)).outcome, 'reserved', 'the window already freed it');
        assert.equal((await ledger.reconcileResolution(resolutionOf(old, { recordedAt: at(121) }))).outcome, 'applied', 'history is still recorded');
        assert.equal((await ledger.reserve(reservation({ executionId: nextId('extra'), limits: rolling, amount: { value: '1', unit: 'USD' } }))).outcome, 'refused', 'no capacity beyond the window');
      }));
  });

  describe(`${name} — P12 §46 / §63 identity, conflict and binding`, () => {
    it('the identical resolution is idempotent; a different answer or digest is a conflict and changes nothing', () =>
      withLedger(async (ledger) => {
        const limits = [count('uses', 'grant:conflict', 1)];
        const first = reservation({ executionId: nextId('conflict'), limits });
        await ledger.reserve(first);
        await ledger.settle({ reservationId: first.reservationId, reason: 'execution-unconfirmed', recordedAt: at(1) });
        assert.equal((await ledger.reconcileResolution(resolutionOf(first, { resolution: 'confirmed-completed' }))).outcome, 'applied');
        const again = await ledger.reconcileResolution(resolutionOf(first, { resolution: 'confirmed-completed', recordedAt: at(99) }));
        assert.equal(again.outcome, 'already-applied');
        assert.equal(again.outcome === 'already-applied' ? again.event.recordedAt : undefined, at(5), 'the first row stands, never re-dated');
        assert.equal((await ledger.reconcileResolution(resolutionOf(first))).outcome, 'conflict');
        assert.equal((await ledger.reconcileResolution(resolutionOf(first, { resolution: 'confirmed-completed', resolutionDigest: OTHER_RESOLUTION_DIGEST }))).outcome, 'conflict');
        assert.equal((await ledger.reserve(reservation({ executionId: nextId('z'), limits }))).outcome, 'refused', 'a conflicting not-completed never took effect');
      }));

    it('an unknown reservation, or one named under another execution, is not-found', () =>
      withLedger(async (ledger) => {
        const first = reservation({ executionId: nextId('known'), limits: [] });
        await ledger.reserve(first);
        assert.equal((await ledger.reconcileResolution(resolutionOf(reservation({ executionId: nextId('unknown'), limits: [] })))).outcome, 'not-found');
        assert.equal((await ledger.reconcileResolution({ ...resolutionOf(first), executionId: 'another-execution' })).outcome, 'not-found');
      }));

    it('input outside the closed contract is refused and nothing is written', () =>
      withLedger(async (ledger) => {
        const first = reservation({ executionId: nextId('closed'), limits: [] });
        await ledger.reserve(first);
        for (const bad of [
          { ...resolutionOf(first), resolution: 'probably-failed' },
          { ...resolutionOf(first), resolutionDigest: 'not-a-digest' },
          { ...resolutionOf(first), basis: 'timeout' },
          { ...resolutionOf(first), amount: '100' },
        ]) {
          await assert.rejects(ledger.reconcileResolution(bad as unknown as ExerciseReservationResolutionInput));
        }
        assert.equal((await ledger.read(first.reservationId))?.resolution, undefined);
      }));
  });

  describe(`${name} — P12 §70 contradictory history fails closed`, () => {
    it('a reservation resolved not-completed while still in flight, then settled executed by the runtime, consumes again', () =>
      withLedger(async (ledger) => {
        const limits = [count('uses', 'grant:in-flight', 1)];
        const first = reservation({ executionId: nextId('in-flight'), limits });
        await ledger.reserve(first);
        await ledger.reconcileResolution(resolutionOf(first, { basis: 'no-initial-observation' }));
        await ledger.settle({ reservationId: first.reservationId, reason: 'executed', recordedAt: at(9) });
        assert.equal((await ledger.reserve(reservation({ executionId: nextId('after-contradiction'), limits }))).outcome, 'refused');
      }));

    it('a reservation resolved completed while still in flight, then released by the runtime, keeps consuming', () =>
      withLedger(async (ledger) => {
        const limits = [count('uses', 'grant:in-flight-release', 1)];
        const first = reservation({ executionId: nextId('in-flight-release'), limits });
        await ledger.reserve(first);
        await ledger.reconcileResolution(resolutionOf(first, { basis: 'no-initial-observation', resolution: 'confirmed-completed' }));
        await ledger.release({ reservationId: first.reservationId, reason: 'execution-failed', recordedAt: at(9) });
        assert.equal((await ledger.reserve(reservation({ executionId: nextId('after-release-contradiction'), limits }))).outcome, 'refused');
      }));

    it('an unconfirmed observation whose reservation was released is inconsistent: nothing is written or repaired', () =>
      withLedger(async (ledger) => {
        const first = reservation({ executionId: nextId('released'), limits: [] });
        await ledger.reserve(first);
        await ledger.release({ reservationId: first.reservationId, reason: 'execution-failed', recordedAt: at(1) });
        assert.equal((await ledger.reconcileResolution(resolutionOf(first))).outcome, 'inconsistent');
        assert.equal((await ledger.reconcileResolution(resolutionOf(first, { resolution: 'confirmed-completed' }))).outcome, 'inconsistent');
        const view = await ledger.read(first.reservationId);
        assert.equal(view?.state, 'released');
        assert.equal(view?.resolution, undefined);
      }));

    it('with no observation: released cannot be resolved completed, settled executed cannot be resolved not-completed', () =>
      withLedger(async (ledger) => {
        const released = reservation({ executionId: nextId('rel'), limits: [] });
        await ledger.reserve(released);
        await ledger.release({ reservationId: released.reservationId, reason: 'execution-failed', recordedAt: at(1) });
        assert.equal((await ledger.reconcileResolution(resolutionOf(released, { basis: 'no-initial-observation', resolution: 'confirmed-completed' }))).outcome, 'inconsistent');
        assert.equal((await ledger.reconcileResolution(resolutionOf(released, { basis: 'no-initial-observation' }))).outcome, 'applied');

        const executed = reservation({ executionId: nextId('exe'), limits: [] });
        await ledger.reserve(executed);
        await ledger.settle({ reservationId: executed.reservationId, reason: 'executed', recordedAt: at(1) });
        assert.equal((await ledger.reconcileResolution(resolutionOf(executed, { basis: 'no-initial-observation' }))).outcome, 'inconsistent');
        assert.equal((await ledger.reconcileResolution(resolutionOf(executed, { basis: 'no-initial-observation', resolution: 'confirmed-completed' }))).outcome, 'applied');
      }));
  });
}

/** The pure rules, independent of any ledger. */
export function describeExerciseReservationResolutionRules(): void {
  describe('P12 — the pure resolution rules', () => {
    const settled = (reason: 'executed' | 'execution-unconfirmed') => ({ reservationId: 'r', kind: 'settled' as const, reason, recordedAt: T0 });
    const released = { reservationId: 'r', kind: 'released' as const, reason: 'execution-failed' as const, recordedAt: T0 };
    const resolved = (resolution: 'confirmed-completed' | 'confirmed-not-completed') => ({ reservationId: 'r', executionId: 'e', resolutionDigest: RESOLUTION_DIGEST, resolution, recordedAt: T0 });

    it('consumption: released never; a verified not-completed resolution never; everything else always', () => {
      assert.equal(exerciseReservationConsumes(undefined, undefined), true);
      assert.equal(exerciseReservationConsumes(settled('execution-unconfirmed'), undefined), true);
      assert.equal(exerciseReservationConsumes(settled('execution-unconfirmed'), resolved('confirmed-completed')), true);
      assert.equal(exerciseReservationConsumes(settled('execution-unconfirmed'), resolved('confirmed-not-completed')), false);
      assert.equal(exerciseReservationConsumes(undefined, resolved('confirmed-not-completed')), false);
      assert.equal(exerciseReservationConsumes(released, undefined), false);
      assert.equal(exerciseReservationConsumes(released, resolved('confirmed-not-completed')), false);
      // An in-flight execution released by the runtime after a completed resolution: a contradiction never returns capacity.
      assert.equal(exerciseReservationConsumes(released, resolved('confirmed-completed')), true);
      // An in-flight execution that settled `executed` after a not-completed resolution: a contradiction never returns capacity.
      assert.equal(exerciseReservationConsumes(settled('executed'), resolved('confirmed-not-completed')), true);
    });

    it('consistency: an unconfirmed basis admits only reserved or settled-unconfirmed', () => {
      assert.equal(exerciseReservationResolutionConsistent(undefined, 'confirmed-not-completed', 'initial-observation-unconfirmed'), true);
      assert.equal(exerciseReservationResolutionConsistent(settled('execution-unconfirmed'), 'confirmed-not-completed', 'initial-observation-unconfirmed'), true);
      assert.equal(exerciseReservationResolutionConsistent(settled('executed'), 'confirmed-completed', 'initial-observation-unconfirmed'), false);
      assert.equal(exerciseReservationResolutionConsistent(released, 'confirmed-not-completed', 'initial-observation-unconfirmed'), false);
    });
  });
}
