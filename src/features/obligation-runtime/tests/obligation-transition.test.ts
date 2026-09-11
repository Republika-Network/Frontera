import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { declareObligation, obligationInstanceId, obligationIsSatisfied, obligationWithholdsExercise, transitionObligation, type ObligationInstance } from '../index.js';

const CORRELATION = { requestId: 'req-1', action: 'payment.execute', resourceScope: 'finance:payments' };
const AT = '2026-01-01T12:00:00.000Z';

function blocking(): ObligationInstance {
  return declareObligation({ obligationType: 'finance.approval', blocking: true, correlation: CORRELATION, declaredAt: AT });
}

describe('transitionObligation — a pure function that never repairs state', () => {
  it('a declared obligation starts in `required`, with no history and no discharge', () => {
    const instance = blocking();
    assert.equal(instance.state, 'required');
    assert.deepEqual(instance.transitions, []);
    assert.equal(instance.discharge, undefined);
    assert.equal(obligationWithholdsExercise(instance), true);
  });

  it('applies a legal transition and writes it to the history', () => {
    const outcome = transitionObligation(blocking(), 'pending', AT, 'discharge_reported');
    assert.equal(outcome.result, 'applied');
    assert.equal(outcome.instance.state, 'pending');
    assert.deepEqual(outcome.instance.transitions, [{ from: 'required', to: 'pending', at: AT, reason: 'discharge_reported' }]);
  });

  it('takes exactly one step, and never invents the states between two', () => {
    const outcome = transitionObligation(blocking(), 'verified', AT, 'discharge_confirmed');
    assert.equal(outcome.result, 'illegal', 'required → verified is not a legal single step, and no path is fabricated for it');
    assert.equal(outcome.instance.state, 'required');
  });

  it('a caller that wants several steps says so several times, and the history records each', () => {
    let instance = blocking();
    for (const [state, reason] of [
      ['pending', 'activated'],
      ['discharged', 'discharge_reported'],
      ['verified', 'discharge_confirmed'],
    ] as const) {
      const outcome = transitionObligation(instance, state, AT, reason);
      assert.equal(outcome.result, 'applied');
      instance = outcome.instance;
    }
    assert.deepEqual(
      instance.transitions.map((transition) => `${transition.from}->${transition.to}`),
      ['required->pending', 'pending->discharged', 'discharged->verified'],
      'the history is the closed lifecycle, not a pair of endpoints',
    );
  });

  it('does not mutate the instance it was given', () => {
    const before = blocking();
    const snapshot = JSON.stringify(before);
    transitionObligation(before, 'pending', AT, 'discharge_reported');
    assert.equal(JSON.stringify(before), snapshot);
  });

  it('is idempotent: asking for the state it is already in changes nothing and records nothing', () => {
    const first = transitionObligation(blocking(), 'pending', AT, 'activated');
    assert.equal(first.result, 'applied');
    const second = transitionObligation(first.instance, 'pending', '2026-01-02T00:00:00.000Z', 'activated');
    assert.equal(second.result, 'unchanged');
    assert.equal(second.instance, first.instance, 'an unchanged transition returns the identical object');
    assert.equal(second.instance.transitions.length, 1, 'no duplicate history entry');
  });

  it('a step backwards along the progress chain is already-taken, not illegal — which is what makes a re-delivered discharge idempotent', () => {
    const discharged = transitionObligation(transitionObligation(blocking(), 'pending', AT, 'activated').instance, 'discharged', AT, 'discharge_reported');
    const backwards = transitionObligation(discharged.instance, 'pending', AT, 'activated');

    assert.equal(backwards.result, 'unchanged');
    assert.equal(backwards.instance.state, 'discharged');
  });

  it('refuses an illegal transition and returns the obligation exactly as it was', () => {
    const waived = transitionObligation(blocking(), 'waived', AT, 'waiver_recorded');
    assert.equal(waived.result, 'applied');
    const reopened = transitionObligation(waived.instance, 'pending', AT, 'activated');
    assert.equal(reopened.result, 'illegal');
    assert.equal(reopened.instance, waived.instance);
    assert.equal(reopened.instance.state, 'waived');
    if (reopened.result === 'illegal') {
      assert.equal(reopened.from, 'waived');
      assert.equal(reopened.to, 'pending');
    }
  });

  it('a satisfied obligation can never be expired — the transition table refuses it', () => {
    const verified = transitionObligation(
      transitionObligation(transitionObligation(blocking(), 'pending', AT, 'activated').instance, 'discharged', AT, 'discharge_reported').instance,
      'verified',
      AT,
      'discharge_confirmed',
    );
    const expiryAttempt = transitionObligation(verified.instance, 'expired', AT, 'deadline_passed');

    assert.equal(expiryAttempt.result, 'illegal', 'a deadline passing is not a reason to withdraw a condition that was met');
    assert.equal(expiryAttempt.instance.state, 'verified');

    const waived = transitionObligation(blocking(), 'waived', AT, 'waiver_recorded');
    assert.equal(transitionObligation(waived.instance, 'expired', AT, 'deadline_passed').result, 'illegal');
  });

  it('an expired obligation is not rescued, and its state survives the attempt untouched', () => {
    const expired = transitionObligation(blocking(), 'expired', AT, 'deadline_passed');
    assert.equal(expired.result, 'applied');
    const rescue = transitionObligation(expired.instance, 'discharged', AT, 'discharge_reported');
    assert.equal(rescue.result, 'illegal');
    assert.equal(rescue.instance.state, 'expired');
    assert.equal(obligationWithholdsExercise(rescue.instance), true);
  });

  it('attaches the discharge record only when one is supplied, and never invents one', () => {
    const withoutRecord = transitionObligation(blocking(), 'pending', AT, 'activated');
    assert.equal(withoutRecord.instance.discharge, undefined, 'an activation discharged nothing, so it carries no discharge record');

    const withRecord = transitionObligation(withoutRecord.instance, 'discharged', AT, 'discharge_reported', {
      sourceId: 'obl.src.approval.finance',
      sourceKind: 'approval_runtime',
      verificationClass: 'independent',
      outcome: 'discharged',
      observedAt: AT,
      subjectId: 'cfo@example.test',
    });
    assert.equal(withRecord.instance.discharge?.verificationClass, 'independent');
    assert.equal(withRecord.instance.discharge?.subjectId, 'cfo@example.test');
  });
});

describe('Obligation satisfaction and withholding', () => {
  it('a blocking obligation withholds exercise until it is verified or waived', () => {
    assert.equal(obligationWithholdsExercise(blocking()), true);
    const pending = transitionObligation(blocking(), 'pending', AT, 'activated').instance;
    assert.equal(obligationWithholdsExercise(pending), true);
    const discharged = transitionObligation(pending, 'discharged', AT, 'discharge_reported').instance;
    assert.equal(obligationWithholdsExercise(discharged), true, 'self-reported is not confirmed');
    const verified = transitionObligation(discharged, 'verified', AT, 'discharge_confirmed').instance;
    assert.equal(obligationWithholdsExercise(verified), false);
    const waived = transitionObligation(blocking(), 'waived', AT, 'waiver_recorded').instance;
    assert.equal(obligationWithholdsExercise(waived), false);
  });

  it('a non-blocking obligation never withholds exercise, whatever state it reaches', () => {
    const nonBlocking = declareObligation({ obligationType: 'second.signer', blocking: false, correlation: CORRELATION, declaredAt: AT });
    assert.equal(obligationWithholdsExercise(nonBlocking), false);
    const expired = transitionObligation(nonBlocking, 'expired', AT, 'deadline_passed');
    assert.equal(obligationWithholdsExercise(expired.instance), false);
    assert.equal(obligationIsSatisfied(expired.instance), false, 'its state is still reported honestly');
  });

  it('a recorded failed verification never changes satisfaction — the obligation is `discharged`, which is unsatisfied either way', () => {
    const discharged = transitionObligation(transitionObligation(blocking(), 'pending', AT, 'activated').instance, 'discharged', AT, 'discharge_reported').instance;
    const withFailedVerification: ObligationInstance = {
      ...discharged,
      verification: { verified: false, sourceId: 'obl.src.approval.finance', sourceKind: 'approval_runtime', verificationClass: 'independent', observedAt: AT },
    };

    assert.equal(withFailedVerification.state, 'discharged', 'ADR §2: a failed verification attempt moves nothing');
    assert.equal(obligationIsSatisfied(withFailedVerification), obligationIsSatisfied(discharged));
    assert.equal(obligationWithholdsExercise(withFailedVerification), true);
  });
});

describe('Obligation identity is deterministic', () => {
  it('derives from the correlation and the type, with no clock, counter or randomness', () => {
    assert.equal(obligationInstanceId(CORRELATION, 'finance.approval'), 'aoc.obligation:req-1:payment.execute:finance:payments:finance.approval');
    assert.equal(obligationInstanceId(CORRELATION, 'finance.approval'), obligationInstanceId(CORRELATION, 'finance.approval'));
  });

  it('two obligations of different types on one request have different ids', () => {
    assert.notEqual(obligationInstanceId(CORRELATION, 'finance.approval'), obligationInstanceId(CORRELATION, 'second.signer'));
  });

  it('the same obligation on a different request has a different id', () => {
    assert.notEqual(obligationInstanceId(CORRELATION, 'finance.approval'), obligationInstanceId({ ...CORRELATION, requestId: 'req-2' }, 'finance.approval'));
  });
});
