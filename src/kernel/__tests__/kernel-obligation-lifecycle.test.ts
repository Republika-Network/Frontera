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
const BLOCKING_WITH_WINDOW: ObligationDeclaration = { requirements: [{ obligationType: 'finance.approval', blocking: true, maxDischargeAgeSeconds: 3_600 }] };
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

  it('a stale discharge reports ALLOW, state `expired`, and exercise blocked', async () => {
    const base = request({ requestId: 'obl-req-stale' });
    const result = await buildKernel({ declaration: BLOCKING_WITH_WINDOW, observations: [discharge(base, { observedAt: '2025-12-31T00:00:00.000Z' })] }).evaluate(base);

    assert.equal(result.status, 'allowed');
    assert.equal(result.obligations?.obligations[0]?.state, 'expired');
    assert.deepEqual(result.obligations?.exerciseReasonCodes, [AOC_KERNEL_EXERCISE_REASON_CODES.OBLIGATION_EXPIRED]);
  });

  it('a refuted discharge reports ALLOW, state `rejected`, and exercise blocked', async () => {
    const base = request({ requestId: 'obl-req-rejected' });
    const result = await buildKernel({
      observations: [discharge(base, { sourceId: HOST.id, observedAt: '2026-01-01T00:00:00.000Z' }), discharge(base, { outcome: 'refused', observedAt: '2026-01-01T00:00:01.000Z' })],
    }).evaluate(base);

    assert.equal(result.status, 'allowed', 'an approver saying no is not the policy saying no, and the record must keep them apart');
    assert.equal(result.obligations?.obligations[0]?.state, 'rejected');
    assert.deepEqual(result.obligations?.exerciseReasonCodes, [AOC_KERNEL_EXERCISE_REASON_CODES.OBLIGATION_DISCHARGE_REJECTED]);
  });

  it('two independent sources contradicting each other reports ALLOW, conflicted, and exercise blocked', async () => {
    const base = request({ requestId: 'obl-req-conflicted' });
    const result = await buildKernel({
      observations: [
        discharge(base, { sourceId: HOST.id, observedAt: '2026-01-01T00:00:00.000Z' }),
        discharge(base, { outcome: 'refused', sourceId: APPROVAL.id, observedAt: '2026-01-01T00:00:01.000Z' }),
        discharge(base, { sourceId: TREASURY.id, observedAt: '2026-01-01T00:00:02.000Z' }),
      ],
    }).evaluate(base);

    assert.equal(result.status, 'allowed');
    assert.equal(result.obligations?.obligations[0]?.conflicted, true);
    assert.deepEqual(result.obligations?.exerciseReasonCodes, [AOC_KERNEL_EXERCISE_REASON_CODES.OBLIGATION_DISCHARGE_CONFLICTED]);
    assert.equal(result.obligations?.exerciseEligibility, 'blocked');
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
