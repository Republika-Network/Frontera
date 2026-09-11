import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type {
  ObligationDischargeObservation,
  ObligationInstance,
  ObligationResolution,
} from '../../features/obligation-runtime/index.js';
import { declareObligation, transitionObligation } from '../../features/obligation-runtime/index.js';
import type { KernelDecisionStatus, ObligationEvaluation } from '../contracts/kernel-result.js';
import { AOC_KERNEL_EXERCISE_REASON_CODES, type AocKernelExerciseReasonCode } from '../reason-codes/exercise-reason-codes.js';
import { AOC_KERNEL_REASON_CODES, type AocKernelReasonCode } from '../reason-codes/reason-codes.js';

/**
 * The layer boundary proved at the *type* level, not only by import rules and
 * runtime shape.
 *
 * `ADR-AUTHORITY-CONTROL-LAYERING.md` names three mechanisms and says why three
 * rather than one: "a type rule stops the obvious mistake, an import rule stops
 * the clever one, and a determinism test stops the accidental one."
 * `obligation-layer-boundaries.test.ts` holds the import rule and the runtime
 * shape; `obligation-determinism.test.ts` holds determinism. This file is the
 * type rule: every `@ts-expect-error` below is a compile-time proof that fails
 * the build the moment the thing it forbids becomes possible — including, and
 * especially, if someone *removes* the restriction, since an unnecessary
 * `@ts-expect-error` is itself a compile error.
 */

const CORRELATION = { requestId: 'req-1', action: 'payment.execute', resourceScope: 'finance:payments' };
const AT = '2026-01-01T00:00:00.000Z';

describe('Type boundary — an obligation cannot carry an authorization', () => {
  it('an ObligationInstance cannot be constructed with a decision status', () => {
    const instance: ObligationInstance = {
      ...declareObligation({ obligationType: 'finance.approval', blocking: true, correlation: CORRELATION, declaredAt: AT }),
      // @ts-expect-error an obligation has no field an authorization could occupy
      status: 'allowed' satisfies KernelDecisionStatus,
    };
    assert.equal(instance.state, 'required');
  });

  it('an ObligationInstance cannot be constructed with an allow, a deny, or a policy effect', () => {
    const base = declareObligation({ obligationType: 'finance.approval', blocking: true, correlation: CORRELATION, declaredAt: AT });

    // @ts-expect-error there is no `allowed` on this layer, at any depth
    const allowed: ObligationInstance = { ...base, allowed: true };
    // @ts-expect-error there is no `denied` either
    const denied: ObligationInstance = { ...base, denied: true };
    // @ts-expect-error nor an effect a policy engine would read
    const effect: ObligationInstance = { ...base, effect: 'permit' };

    assert.equal(allowed.state, 'required');
    assert.equal(denied.state, 'required');
    assert.equal(effect.state, 'required');
  });

  it('an ObligationResolution cannot carry a decision or a grant', () => {
    const base: ObligationResolution = {
      resolved: true,
      declaredTypes: ['finance.approval'],
      obligations: [],
      disregarded: [],
      exerciseEligibility: 'eligible',
      resolvedAt: AT,
    };

    // @ts-expect-error the resolution answers "may this be exercised", never "was this authorized"
    const withDecision: ObligationResolution = { ...base, decision: 'allowed' };
    // @ts-expect-error and it never issues anything — layer E does not exist to this layer
    const withGrant: ObligationResolution = { ...base, grant: { id: 'grant-1' } };

    assert.equal(withDecision.exerciseEligibility, 'eligible');
    assert.equal(withGrant.exerciseEligibility, 'eligible');
  });

  it('exercise eligibility is its own vocabulary — a decision status is not assignable to it', () => {
    // @ts-expect-error 'allowed' is a KernelDecisionStatus and must never be readable as an eligibility
    const eligibility: ObligationResolution['exerciseEligibility'] = 'allowed';
    // @ts-expect-error nor the other way round
    const status: KernelDecisionStatus = 'eligible' satisfies ObligationResolution['exerciseEligibility'];

    assert.equal(typeof eligibility, 'string');
    assert.equal(typeof status, 'string');
  });
});

describe('Type boundary — a discharge observation cannot promote itself', () => {
  const base: ObligationDischargeObservation = {
    obligationType: 'finance.approval',
    correlation: CORRELATION,
    sourceId: 'obl.src.approval.finance',
    outcome: 'discharged',
    observedAt: AT,
  };

  it('cannot declare its own verification class — the registry decides that and nothing else', () => {
    // @ts-expect-error a source reports what it saw; what that is worth is operator configuration
    const promoted: ObligationDischargeObservation = { ...base, verificationClass: 'independent' };
    assert.equal(promoted.outcome, 'discharged');
  });

  it('cannot declare the lifecycle state it would like to be in', () => {
    // @ts-expect-error the state is derived by the closed transition table, never submitted
    const stateful: ObligationDischargeObservation = { ...base, state: 'verified' };
    // @ts-expect-error and it cannot claim satisfaction directly either
    const satisfied: ObligationDischargeObservation = { ...base, satisfied: true };

    assert.equal(stateful.outcome, 'discharged');
    assert.equal(satisfied.outcome, 'discharged');
  });

  it('cannot carry an authorization outcome as its discharge outcome', () => {
    // @ts-expect-error the outcome vocabulary is pending/discharged/refused/waived, and nothing that reads as a verdict
    const forged: ObligationDischargeObservation = { ...base, outcome: 'allow' };
    assert.equal(forged.obligationType, 'finance.approval');
  });
});

describe('Type boundary — the two reason-code vocabularies do not mix', () => {
  it('an exercise reason code is not an authorization reason code', () => {
    // @ts-expect-error OBLIGATION_PENDING must never be assignable where an authorization reason is expected
    const asAuthorization: AocKernelReasonCode = AOC_KERNEL_EXERCISE_REASON_CODES.OBLIGATION_PENDING;
    assert.equal(asAuthorization, 'OBLIGATION_PENDING');
  });

  it('an authorization reason code is not an exercise reason code', () => {
    // @ts-expect-error and a policy denial must never be reportable as an exercise condition
    const asExercise: AocKernelExerciseReasonCode = AOC_KERNEL_REASON_CODES.POLICY_ACTION_PROHIBITED;
    assert.equal(asExercise, 'POLICY_ACTION_PROHIBITED');
  });

  it('the two constants share no value at runtime either', () => {
    const authorization = new Set<string>(Object.values(AOC_KERNEL_REASON_CODES));
    for (const code of Object.values(AOC_KERNEL_EXERCISE_REASON_CODES)) {
      assert.equal(authorization.has(code), false, `'${code}' appears in both vocabularies`);
    }
  });
});

describe('Type boundary — the obligation evaluation on the result cannot be a decision', () => {
  it('ObligationEvaluation has no status, reason codes or policy field of its own', () => {
    const evaluation: ObligationEvaluation = {
      performed: true,
      resolved: true,
      declaredTypes: ['finance.approval'],
      obligations: [],
      exerciseEligibility: 'eligible',
      allBlockingObligationsSatisfied: true,
    };

    // @ts-expect-error the decision lives on the result, not inside the obligation block
    const withStatus: ObligationEvaluation = { ...evaluation, status: 'allowed' };
    // @ts-expect-error authorization reasons are `reasonCodes` on the result; this block carries `exerciseReasonCodes`
    const withReasons: ObligationEvaluation = { ...evaluation, reasonCodes: ['POLICY_ACTION_PROHIBITED'] };
    // @ts-expect-error and it never reports a policy result
    const withPolicies: ObligationEvaluation = { ...evaluation, policies: [] };

    assert.equal(withStatus.allBlockingObligationsSatisfied, true);
    assert.equal(withReasons.allBlockingObligationsSatisfied, true);
    assert.equal(withPolicies.allBlockingObligationsSatisfied, true);
  });
});

describe('Type boundary — the transition function cannot be talked into an authorization state', () => {
  it('only the seven lifecycle states are acceptable targets', () => {
    const instance = declareObligation({ obligationType: 'finance.approval', blocking: true, correlation: CORRELATION, declaredAt: AT });

    // @ts-expect-error 'allowed' is not a lifecycle state, and the closed union is what refuses it
    const toAllowed = transitionObligation(instance, 'allowed', AT, 'discharge_reported');
    // @ts-expect-error nor is 'denied'
    const toDenied = transitionObligation(instance, 'denied', AT, 'discharge_reported');

    assert.equal(toAllowed.instance.state, 'required');
    assert.equal(toDenied.instance.state, 'required');
  });

  it('only the six declared reasons are acceptable', () => {
    const instance = declareObligation({ obligationType: 'finance.approval', blocking: true, correlation: CORRELATION, declaredAt: AT });
    // @ts-expect-error a transition reason is a closed vocabulary, not free text
    const outcome = transitionObligation(instance, 'pending', AT, 'because the caller said so');
    assert.equal(outcome.result, 'applied');
  });
});
