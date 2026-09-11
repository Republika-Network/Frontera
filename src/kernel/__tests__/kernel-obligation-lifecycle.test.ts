import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { bridgeRecognitionRuntime, buildDatasysEnforcementFixture } from '../../features/action-enforcement/fixtures/datasys-enforcement.fixture.js';
import { buildDraftClosureEmailGuardInput } from '../../features/action-enforcement/fixtures/allowed-action.fixture.js';
import { buildUnknownAgentReadGuardInput } from '../../features/action-enforcement/fixtures/denied-action.fixture.js';
import { createManualEnforcementClock, createSequentialEnforcementIdGenerator } from '../../features/action-enforcement/runtime/enforcement-runtime-context.js';
import {
  createFailingObligationDischargeProvider,
  createInMemoryObligationDischargeProvider,
  type ObligationDeclaration,
  type ObligationDischargeObservation,
  type ObligationDischargeSource,
} from '../../features/obligation-runtime/index.js';
import { AocKernel } from '../AocKernel.js';
import type { KernelEvaluationRequest } from '../contracts/kernel-request.js';
import { AOC_KERNEL_EXERCISE_REASON_CODES } from '../reason-codes/exercise-reason-codes.js';
import { AOC_KERNEL_REASON_CODES } from '../reason-codes/reason-codes.js';
import { NOW, toKernelRequest } from './characterization/support.js';

/**
 * The obligation capability at the Kernel boundary, and the invariant the whole
 * phase exists to hold:
 *
 * > An obligation never changes the meaning of an authorization decision.
 *
 * Every test below is written so that it would fail if an obligation were ever
 * folded into `status` or `reasonCodes`. The settling one is
 * "the decision is byte-identical with and without every obligation": remove
 * the obligation state and the authorization comes back the same, so all an
 * obligation can change is whether the already-authorized action may proceed.
 */

const APPROVAL: ObligationDischargeSource = { id: 'obl.src.approval.finance', kind: 'approval_runtime', name: 'Finance approvals', verificationClass: 'independent' };
const HOST: ObligationDischargeSource = { id: 'obl.src.host', kind: 'internal_store', name: 'Host-recorded state', verificationClass: 'self_reported' };
const TREASURY: ObligationDischargeSource = { id: 'obl.src.approval.treasury', kind: 'approval_runtime', name: 'Treasury approvals', verificationClass: 'independent' };
const REQUESTER: ObligationDischargeSource = { id: 'obl.src.request', kind: 'request', name: 'The requester', verificationClass: 'self_reported' };
const SOURCES = [APPROVAL, TREASURY, HOST, REQUESTER];

const BLOCKING: ObligationDeclaration = { requirements: [{ obligationType: 'finance.approval', blocking: true }] };
/** A deadline already in the past at `NOW`, so an obligation declared with it is `expired` the moment it is read. */
const DEADLINE = '2025-12-31T00:00:00.000Z';
const BLOCKING_WITH_DEADLINE: ObligationDeclaration = { requirements: [{ obligationType: 'finance.approval', blocking: true, expiresAt: DEADLINE }] };
const NON_BLOCKING: ObligationDeclaration = { requirements: [{ obligationType: 'finance.approval', blocking: false }] };

function request(overrides: Partial<KernelEvaluationRequest> = {}): KernelEvaluationRequest {
  return { ...toKernelRequest(buildDraftClosureEmailGuardInput()), requestId: 'obl-req-1', ...overrides };
}

function correlationFor(kernelRequest: KernelEvaluationRequest) {
  return {
    requestId: kernelRequest.requestId,
    action: kernelRequest.action.capability ?? kernelRequest.action.type,
    resourceScope: kernelRequest.action.resourceScope,
  };
}

function buildKernel(options: { readonly declaration?: ObligationDeclaration; readonly observations?: readonly ObligationDischargeObservation[]; readonly failing?: boolean } = {}): AocKernel {
  const fixture = buildDatasysEnforcementFixture();
  return new AocKernel({
    recognitionProvider: bridgeRecognitionRuntime(fixture.recognitionRuntime),
    clock: createManualEnforcementClock(NOW),
    idGenerator: createSequentialEnforcementIdGenerator(),
    obligations: {
      provider: options.failing === true ? createFailingObligationDischargeProvider() : createInMemoryObligationDischargeProvider(options.observations ?? []),
      sources: SOURCES,
      declaration: options.declaration ?? BLOCKING,
    },
  });
}

function discharge(kernelRequest: KernelEvaluationRequest, overrides: Partial<ObligationDischargeObservation> = {}): ObligationDischargeObservation {
  return {
    obligationType: 'finance.approval',
    correlation: correlationFor(kernelRequest),
    sourceId: APPROVAL.id,
    outcome: 'discharged',
    observedAt: NOW,
    ...overrides,
  };
}

describe('evaluate() — an allowed decision stays allowed while a blocking obligation withholds exercise', () => {
  it('reports ALLOW, the obligation pending, and exercise blocked — all three at once', async () => {
    const base = request();
    const result = await buildKernel().evaluate(base);

    assert.equal(result.status, 'allowed', 'the policy authorized the action, and nothing about an obligation may revisit that');
    assert.deepEqual(result.reasonCodes, [AOC_KERNEL_REASON_CODES.ACTION_ALLOWED]);
    assert.equal(result.obligations?.exerciseEligibility, 'blocked');
    assert.equal(result.obligations?.allBlockingObligationsSatisfied, false);
    assert.equal(result.obligations?.obligations[0]?.state, 'required');
    assert.deepEqual(result.obligations?.exerciseReasonCodes, [AOC_KERNEL_EXERCISE_REASON_CODES.OBLIGATION_PENDING]);
  });

  it('the obligation reason code never appears in the authorization reason codes', async () => {
    const result = await buildKernel().evaluate(request());
    const exerciseCodes: readonly string[] = Object.values(AOC_KERNEL_EXERCISE_REASON_CODES);
    for (const code of result.reasonCodes) {
      assert.equal(exerciseCodes.includes(code), false, `'${code}' is an exercise condition and must never be reported as an authorization reason`);
    }
  });

  it('a validly discharged blocking obligation reports ALLOW and exercise eligible', async () => {
    const base = request({ requestId: 'obl-req-discharged' });
    const result = await buildKernel({ observations: [discharge(base, { subjectId: 'cfo@example.test', reference: 'AP-771' })] }).evaluate(base);

    assert.equal(result.status, 'allowed');
    assert.equal(result.obligations?.exerciseEligibility, 'eligible');
    assert.equal(result.obligations?.allBlockingObligationsSatisfied, true);
    assert.equal(result.obligations?.obligations[0]?.state, 'verified');
    assert.equal(result.obligations?.obligations[0]?.discharge?.verificationClass, 'independent');
    assert.equal(result.obligations?.exerciseReasonCodes, undefined);
  });

  it('a self-reported discharge reports ALLOW, state `discharged`, and exercise still blocked', async () => {
    const base = request({ requestId: 'obl-req-self' });
    const result = await buildKernel({ observations: [discharge(base, { sourceId: HOST.id })] }).evaluate(base);

    assert.equal(result.status, 'allowed');
    assert.equal(result.obligations?.obligations[0]?.state, 'discharged');
    assert.equal(result.obligations?.exerciseEligibility, 'blocked');
    assert.deepEqual(result.obligations?.exerciseReasonCodes, [AOC_KERNEL_EXERCISE_REASON_CODES.OBLIGATION_DISCHARGE_UNVERIFIED]);
  });

  it('an obligation past its declared deadline reports ALLOW, state `expired`, and exercise blocked', async () => {
    const base = request({ requestId: 'obl-req-expired' });
    const result = await buildKernel({ declaration: BLOCKING_WITH_DEADLINE }).evaluate(base);

    assert.equal(result.status, 'allowed');
    assert.equal(result.obligations?.obligations[0]?.state, 'expired');
    assert.equal(result.obligations?.obligations[0]?.expiresAt, DEADLINE);
    assert.deepEqual(result.obligations?.exerciseReasonCodes, [AOC_KERNEL_EXERCISE_REASON_CODES.OBLIGATION_EXPIRED]);
  });

  it('an obligation with no declared deadline never expires, however old the discharge is', async () => {
    const base = request({ requestId: 'obl-req-no-deadline' });
    const result = await buildKernel({ observations: [discharge(base, { observedAt: '2020-01-01T00:00:00.000Z' })] }).evaluate(base);

    assert.equal(result.obligations?.obligations[0]?.state, 'verified', 'proof freshness is a verification question, never a lifecycle deadline');
    assert.equal(result.obligations?.exerciseEligibility, 'eligible');
  });

  it('a verification that did not succeed reports ALLOW, state `discharged`, and records why', async () => {
    const base = request({ requestId: 'obl-req-unverified' });
    const result = await buildKernel({
      observations: [discharge(base, { sourceId: HOST.id, observedAt: '2026-01-01T00:00:00.000Z' }), discharge(base, { outcome: 'refused', observedAt: '2026-01-01T00:00:01.000Z', reference: 'AP-DECLINED-3' })],
    }).evaluate(base);

    assert.equal(result.status, 'allowed', 'an approver declining is not the policy denying, and the record must keep them apart');
    assert.equal(result.obligations?.obligations[0]?.state, 'discharged', 'ADR §2: a failed verification has no state of its own');
    assert.equal(result.obligations?.obligations[0]?.verification?.verified, false);
    assert.equal(result.obligations?.obligations[0]?.verification?.reference, 'AP-DECLINED-3');
    assert.deepEqual(result.obligations?.exerciseReasonCodes, [AOC_KERNEL_EXERCISE_REASON_CODES.OBLIGATION_DISCHARGE_UNVERIFIED]);
    assert.equal(result.obligations?.exerciseEligibility, 'blocked');
  });

  it('a confirmation from a second independent source after a failed attempt still verifies', async () => {
    const base = request({ requestId: 'obl-req-reverified' });
    const result = await buildKernel({
      observations: [
        discharge(base, { sourceId: HOST.id, observedAt: '2026-01-01T00:00:00.000Z' }),
        discharge(base, { outcome: 'refused', sourceId: APPROVAL.id, observedAt: '2026-01-01T00:00:01.000Z' }),
        discharge(base, { sourceId: TREASURY.id, observedAt: '2026-01-01T00:00:02.000Z' }),
      ],
    }).evaluate(base);

    assert.equal(result.status, 'allowed');
    assert.equal(result.obligations?.obligations[0]?.state, 'verified');
    assert.equal(result.obligations?.exerciseEligibility, 'eligible');
  });

  it('an unreadable discharge provider reports ALLOW, `resolved: false`, and exercise blocked', async () => {
    const result = await buildKernel({ failing: true }).evaluate(request({ requestId: 'obl-req-unreadable' }));

    assert.equal(result.status, 'allowed');
    assert.equal(result.obligations?.resolved, false, '"the approval system is down" is never "there are no obligations"');
    assert.equal(result.obligations?.exerciseEligibility, 'blocked');
  });

  it('a non-blocking obligation is reported in full and gates nothing', async () => {
    const result = await buildKernel({ declaration: NON_BLOCKING }).evaluate(request({ requestId: 'obl-req-nonblocking' }));

    assert.equal(result.obligations?.obligations[0]?.state, 'required');
    assert.equal(result.obligations?.obligations[0]?.blocking, false);
    assert.equal(result.obligations?.exerciseEligibility, 'eligible');
  });

  it('carries the transition history, so the state is reconstructible rather than merely asserted', async () => {
    const base = request({ requestId: 'obl-req-history' });
    const result = await buildKernel({ observations: [discharge(base)] }).evaluate(base);

    assert.deepEqual(
      result.obligations?.obligations[0]?.transitions.map((transition) => `${transition.from}->${transition.to}`),
      ['required->pending', 'pending->discharged', 'discharged->verified'],
    );
  });
});

describe('evaluate() — a denied decision stays denied, whatever the obligation state', () => {
  it('a denial with a fully verified obligation is still a denial', async () => {
    const base = { ...toKernelRequest(buildUnknownAgentReadGuardInput()), requestId: 'obl-req-denied' };
    const result = await buildKernel({ observations: [discharge(base)] }).evaluate(base);

    assert.equal(result.status, 'denied');
    assert.equal(result.obligations?.obligations[0]?.state, 'verified');
    assert.equal(result.obligations?.exerciseEligibility, 'eligible', 'the obligation is satisfied; the action is still not authorized');
  });

  it('no obligation state converts a denial into an authorization', async () => {
    const base = { ...toKernelRequest(buildUnknownAgentReadGuardInput()), requestId: 'obl-req-denied-2' };
    for (const outcome of ['pending', 'discharged', 'waived'] as const) {
      const result = await buildKernel({ observations: [discharge(base, { outcome })] }).evaluate(base);
      assert.equal(result.status, 'denied', `outcome '${outcome}' must not rescue a denial`);
    }
  });
});

describe('The settling invariant — removing obligation state changes no decision', () => {
  it('the authorization is byte-identical with the capability, without it, and at every lifecycle state', async () => {
    const base = request({ requestId: 'obl-req-settling' });
    const fixture = buildDatasysEnforcementFixture();
    const withoutCapability = await new AocKernel({
      recognitionProvider: bridgeRecognitionRuntime(fixture.recognitionRuntime),
      clock: createManualEnforcementClock(NOW),
      idGenerator: createSequentialEnforcementIdGenerator(),
    }).evaluate(base);

    const authorizationOf = (result: Awaited<ReturnType<AocKernel['evaluate']>>) =>
      JSON.stringify({ status: result.status, reasonCodes: result.reasonCodes, summary: result.summary, policies: result.policies, approval: result.approval, recognition: result.recognition });

    const baseline = authorizationOf(withoutCapability);

    for (const observations of [
      [],
      [discharge(base, { outcome: 'pending' })],
      [discharge(base, { sourceId: HOST.id })],
      [discharge(base)],
      [discharge(base, { outcome: 'waived' })],
    ]) {
      const result = await buildKernel({ observations }).evaluate(base);
      assert.equal(authorizationOf(result), baseline, 'an obligation may change only whether an authorized action may proceed');
    }
  });
});

describe('enforce() — the executor gate', () => {
  it('ALLOW with no blocking obligation declared: the executor runs exactly once', async () => {
    let ran = 0;
    const result = await buildKernel({ declaration: NON_BLOCKING }).enforce(request({ requestId: 'obl-enf-nonblocking' }), () => {
      ran += 1;
      return 'done';
    });

    assert.equal(result.status, 'allowed');
    assert.equal(ran, 1);
    assert.equal(result.execution.executed, true);
    assert.equal(result.execution.withheldBy, undefined);
  });

  it('ALLOW with a blocking obligation pending: the executor is never invoked, and the decision is untouched', async () => {
    let ran = 0;
    const result = await buildKernel().enforce(request({ requestId: 'obl-enf-pending' }), () => {
      ran += 1;
      return 'done';
    });

    assert.equal(ran, 0, 'a side effect that has already happened cannot be withheld afterwards');
    assert.equal(result.status, 'allowed', 'the authorization stands; only the exercise was withheld');
    assert.deepEqual(result.reasonCodes, [AOC_KERNEL_REASON_CODES.ACTION_ALLOWED]);
    assert.equal(result.execution.status, 'not_executed');
    assert.equal(result.execution.executed, false);
    assert.equal(result.execution.withheldBy, 'obligation');
    assert.equal(result.obligations?.exerciseEligibility, 'blocked');
    assert.ok((result.obligations?.summary ?? '').length > 0);
  });

  it('ALLOW with a validly discharged blocking obligation: the executor runs exactly once', async () => {
    const base = request({ requestId: 'obl-enf-discharged' });
    let ran = 0;
    const result = await buildKernel({ observations: [discharge(base)] }).enforce(base, () => {
      ran += 1;
      return 'done';
    });

    assert.equal(ran, 1);
    assert.equal(result.status, 'allowed');
    assert.equal(result.execution.executed, true);
    assert.equal(result.obligations?.obligations[0]?.state, 'verified');
    assert.equal(result.execution.withheldBy, undefined);
  });

  it('DENY: the executor never runs, and the withholding layer is not named — the denial is the reason', async () => {
    const base = { ...toKernelRequest(buildUnknownAgentReadGuardInput()), requestId: 'obl-enf-denied' };
    let ran = 0;
    const result = await buildKernel().enforce(base, () => {
      ran += 1;
      return 'done';
    });

    assert.equal(ran, 0);
    assert.equal(result.status, 'denied');
    assert.equal(result.execution.executed, false);
    assert.equal(result.execution.withheldBy, undefined, 'one outcome must not be given two causes');
  });

  it('a self-reported discharge does not open the gate', async () => {
    const base = request({ requestId: 'obl-enf-self' });
    let ran = 0;
    await buildKernel({ observations: [discharge(base, { sourceId: HOST.id })] }).enforce(base, () => {
      ran += 1;
      return 'done';
    });
    assert.equal(ran, 0);
  });

  it('an unreadable provider does not open the gate', async () => {
    let ran = 0;
    const result = await buildKernel({ failing: true }).enforce(request({ requestId: 'obl-enf-unreadable' }), () => {
      ran += 1;
      return 'done';
    });
    assert.equal(ran, 0);
    assert.equal(result.status, 'allowed');
    assert.equal(result.execution.withheldBy, 'obligation');
  });

  it('repeated enforce over the same world neither double-discharges nor mutates the lifecycle', async () => {
    const base = request({ requestId: 'obl-enf-repeat' });
    const kernel = buildKernel({ observations: [discharge(base)] });
    let ran = 0;
    const first = await kernel.enforce(base, () => {
      ran += 1;
      return 'done';
    });
    const second = await kernel.enforce({ ...base, requestId: base.requestId }, () => {
      ran += 1;
      return 'done';
    });

    assert.equal(JSON.stringify(first.obligations), JSON.stringify(second.obligations), 'obligation state is derived, never consumed');
    assert.equal(ran, 2, 'the engine’s own idempotency governs execution counts; the obligation layer neither adds nor removes a run');
  });

  it('repeated enforce on a blocked obligation never runs the executor, however many times it is called', async () => {
    const base = request({ requestId: 'obl-enf-repeat-blocked' });
    const kernel = buildKernel();
    let ran = 0;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await kernel.enforce(base, () => {
        ran += 1;
        return 'done';
      });
      assert.equal(result.execution.executed, false);
    }
    assert.equal(ran, 0);
  });
});

describe('enforce() — the same authorization, before and after the discharge arrives', () => {
  /**
   * The transition the phase exists to make expressible, measured on one
   * request rather than inferred from two.
   *
   * Two kernels over the same recognition world, the same request and the same
   * policy, differing in exactly one thing: whether a trusted finance discharge
   * exists. The authorization each produces must be identical — same status,
   * same reason codes, same summary, same policy chain, same approval and
   * recognition evaluations. The *only* things allowed to differ are whether
   * the action is currently eligible to be exercised and whether the executor
   * ran.
   */
  const authorizationOf = (result: Awaited<ReturnType<AocKernel['enforce']>>) =>
    JSON.stringify({
      status: result.status,
      reasonCodes: result.reasonCodes,
      summary: result.summary,
      policies: result.policies,
      approval: result.approval,
      recognition: result.recognition,
      authority: result.authority,
      evidence: result.evidence,
    });

  async function enforceWith(observations: readonly ObligationDischargeObservation[], requestId: string) {
    const base = request({ requestId });
    let ran = 0;
    const result = await buildKernel({ observations: observations.map((observation) => ({ ...observation, correlation: correlationFor(base) })) }).enforce(base, () => {
      ran += 1;
      return 'executed';
    });
    return { result, ran };
  }

  it('the authorization is byte-identical before and after the discharge; only eligibility and the executor change', async () => {
    const base = request({ requestId: 'obl-enf-transition' });
    const blocked = await enforceWith([], 'obl-enf-transition');
    const eligible = await enforceWith([discharge(base)], 'obl-enf-transition');

    assert.equal(authorizationOf(blocked.result), authorizationOf(eligible.result), 'discharging an obligation must not alter one field of the authorization');

    assert.equal(blocked.result.status, 'allowed');
    assert.equal(eligible.result.status, 'allowed');

    assert.equal(blocked.result.obligations?.exerciseEligibility, 'blocked');
    assert.equal(eligible.result.obligations?.exerciseEligibility, 'eligible');

    assert.equal(blocked.ran, 0);
    assert.equal(eligible.ran, 1);

    assert.equal(blocked.result.execution.withheldBy, 'obligation');
    assert.equal(eligible.result.execution.withheldBy, undefined);
    assert.equal(eligible.result.execution.value, 'executed');
  });

  it('the obligation, not the decision, is what moved: `required` to `verified` across the same authorization', async () => {
    const base = request({ requestId: 'obl-enf-transition-state' });
    const blocked = await enforceWith([], 'obl-enf-transition-state');
    const eligible = await enforceWith([discharge(base)], 'obl-enf-transition-state');

    assert.equal(blocked.result.obligations?.obligations[0]?.state, 'required');
    assert.equal(eligible.result.obligations?.obligations[0]?.state, 'verified');
    assert.equal(blocked.result.obligations?.obligations[0]?.id, eligible.result.obligations?.obligations[0]?.id, 'the same obligation, deterministically identified, at two points in its life');
  });

  it('obligation state is never represented as a policy failure — the policy chain is untouched and names no obligation', async () => {
    const fixture = buildDatasysEnforcementFixture();
    let ranWithout = 0;
    const withoutCapability = await new AocKernel({
      recognitionProvider: bridgeRecognitionRuntime(fixture.recognitionRuntime),
      clock: createManualEnforcementClock(NOW),
      idGenerator: createSequentialEnforcementIdGenerator(),
    }).enforce(request({ requestId: 'obl-enf-policy-chain' }), () => {
      ranWithout += 1;
      return 'executed';
    });
    const blocked = await enforceWith([], 'obl-enf-policy-chain');

    assert.equal(ranWithout, 1, 'the comparison kernel really did execute');
    assert.equal(blocked.ran, 0, 'the measured kernel really did not');

    assert.deepEqual(blocked.result.policies, withoutCapability.policies, 'no synthetic policy result is injected to represent an unmet obligation');
    for (const policy of blocked.result.policies) {
      assert.equal(/obligation/i.test(`${policy.policyId} ${policy.reasonCode} ${policy.reason}`), false, `policy '${policy.policyId}' must not carry obligation state`);
      assert.equal(policy.passed, true, 'a withheld execution is not a failed policy');
    }
  });

  it('a caller reading only `status` sees an authorization; a caller reading `execution` sees why nothing happened', async () => {
    const blocked = await enforceWith([], 'obl-enf-two-readings');

    assert.equal(blocked.result.status, 'allowed');
    assert.equal(blocked.result.reasonCodes.includes('POLICY_ACTION_PROHIBITED'), false);
    assert.equal(blocked.result.reasonCodes.includes('POLICY_CONDITION_UNSATISFIED'), false);
    assert.equal(blocked.result.execution.status, 'not_executed');
    assert.equal(blocked.result.execution.executed, false);
    assert.equal(blocked.result.execution.withheldBy, 'obligation');
  });
});

describe('enforce() — a denial is a denial under every obligation state there is', () => {
  const outcomes = ['pending', 'discharged', 'refused', 'waived'] as const;

  for (const outcome of outcomes) {
    it(`DENY with a '${outcome}' observation stays DENY, and the executor never runs`, async () => {
      const base = { ...toKernelRequest(buildUnknownAgentReadGuardInput()), requestId: `obl-enf-deny-${outcome}` };
      let ran = 0;
      const result = await buildKernel({ observations: [discharge(base, { outcome })] }).enforce(base, () => {
        ran += 1;
        return 'executed';
      });

      assert.equal(result.status, 'denied');
      assert.equal(ran, 0);
      assert.equal(result.execution.executed, false);
      assert.equal(result.execution.withheldBy, undefined, 'the denial is the reason, and it is the only one');
    });
  }

  it('DENY with an expired obligation stays DENY', async () => {
    const base = { ...toKernelRequest(buildUnknownAgentReadGuardInput()), requestId: 'obl-enf-deny-expired' };
    let ran = 0;
    const result = await buildKernel({ declaration: BLOCKING_WITH_DEADLINE }).enforce(base, () => {
      ran += 1;
      return 'executed';
    });

    assert.equal(result.status, 'denied');
    assert.equal(result.obligations?.obligations[0]?.state, 'expired');
    assert.equal(ran, 0);
  });

  it('DENY with an unreadable discharge provider stays DENY, and is not reported as an obligation problem', async () => {
    const base = { ...toKernelRequest(buildUnknownAgentReadGuardInput()), requestId: 'obl-enf-deny-unreadable' };
    let ran = 0;
    const result = await buildKernel({ failing: true }).enforce(base, () => {
      ran += 1;
      return 'executed';
    });

    assert.equal(result.status, 'denied');
    assert.equal(ran, 0);
    assert.equal(result.execution.withheldBy, undefined);
  });
});

describe('A discharge of an obligation this decision never declared cannot open the gate', () => {
  /**
   * The in-memory provider filters to the declared obligations, which is what a
   * well-behaved one does. This exercises a *misbehaving* one that volunteers an
   * obligation nobody declared, so the layer's own discard is what is measured
   * rather than the fixture's filter.
   */
  function buildKernelWithVolunteeringProvider(observations: readonly ObligationDischargeObservation[]): AocKernel {
    const fixture = buildDatasysEnforcementFixture();
    return new AocKernel({
      recognitionProvider: bridgeRecognitionRuntime(fixture.recognitionRuntime),
      clock: createManualEnforcementClock(NOW),
      idGenerator: createSequentialEnforcementIdGenerator(),
      obligations: {
        provider: { resolveObligationDischarges: () => Promise.resolve({ observations }) },
        sources: SOURCES,
        declaration: BLOCKING,
      },
    });
  }

  it('a provider volunteering an undeclared obligation has it discarded, and the declared one still blocks', async () => {
    const base = request({ requestId: 'obl-enf-undeclared' });
    let ran = 0;
    const result = await buildKernelWithVolunteeringProvider([discharge(base, { obligationType: 'second.signer' })]).enforce(base, () => {
      ran += 1;
      return 'executed';
    });

    assert.equal(result.status, 'allowed');
    assert.equal(result.obligations?.declaredTypes, result.obligations?.declaredTypes);
    assert.deepEqual(result.obligations?.obligations.map((obligation) => obligation.obligationType), ['finance.approval'], 'a provider cannot widen the obligation set beyond the declaration');
    assert.equal(result.obligations?.obligations[0]?.state, 'required');
    assert.deepEqual(result.obligations?.disregarded?.map((entry) => entry.reason), ['undeclared_obligation']);
    assert.equal(ran, 0);
  });

  it('a provider returning something malformed fails closed rather than reading as an empty, satisfied world', async () => {
    const fixture = buildDatasysEnforcementFixture();
    const kernel = new AocKernel({
      recognitionProvider: bridgeRecognitionRuntime(fixture.recognitionRuntime),
      clock: createManualEnforcementClock(NOW),
      idGenerator: createSequentialEnforcementIdGenerator(),
      obligations: {
        // A provider that answers with the wrong shape entirely — the case a
        // throwing one does not cover.
        provider: { resolveObligationDischarges: () => Promise.resolve({ observations: undefined as unknown as readonly ObligationDischargeObservation[] }) },
        sources: SOURCES,
        declaration: BLOCKING,
      },
    });

    let ran = 0;
    const result = await kernel.enforce(request({ requestId: 'obl-enf-malformed' }), () => {
      ran += 1;
      return 'executed';
    });

    assert.equal(result.status, 'allowed');
    assert.equal(result.obligations?.resolved, false);
    assert.equal(result.obligations?.exerciseEligibility, 'blocked');
    assert.equal(ran, 0);
  });
});
