import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { bridgeRecognitionRuntime, buildDatasysEnforcementFixture } from '../../../features/action-enforcement/fixtures/datasys-enforcement.fixture.js';
import { createManualEnforcementClock, createSequentialEnforcementIdGenerator } from '../../../features/action-enforcement/runtime/enforcement-runtime-context.js';
import { buildDraftClosureEmailGuardInput } from '../../../features/action-enforcement/fixtures/allowed-action.fixture.js';
import { buildUnknownAgentReadGuardInput } from '../../../features/action-enforcement/fixtures/denied-action.fixture.js';
import { createInMemoryObligationDischargeProvider, type ObligationDischargeSource } from '../../../features/obligation-runtime/index.js';
import { AocKernel } from '../../AocKernel.js';
import type { PolicyPackProvider } from '../../contracts/ports.js';
import { NOW, toKernelRequest } from './support.js';

/**
 * The compatibility characterization for the obligation capability.
 *
 * `TARGET_AUTHORITY_CONTROL_ARCHITECTURE.md` §7 makes this the governing
 * constraint of the whole migration: "every new capability is an optional port.
 * Omitted → byte-identical behaviour. Each new port carries a characterization
 * test proving the unconfigured path is unchanged." This is that test, and it
 * pins *two* equivalences rather than one: capability omitted, and capability
 * configured with nothing declared.
 */

const APPROVAL: ObligationDischargeSource = { id: 'obl.src.approval.finance', kind: 'approval_runtime', name: 'Finance approvals', verificationClass: 'independent' };

function buildKernel(options: { readonly policyPackProvider?: PolicyPackProvider; readonly declareNothing?: boolean } = {}): AocKernel {
  const fixture = buildDatasysEnforcementFixture();
  return new AocKernel({
    recognitionProvider: bridgeRecognitionRuntime(fixture.recognitionRuntime),
    clock: createManualEnforcementClock(NOW),
    idGenerator: createSequentialEnforcementIdGenerator(),
    ...(options.policyPackProvider !== undefined ? { policyPackProvider: options.policyPackProvider } : {}),
    ...(options.declareNothing === true
      ? { obligations: { provider: createInMemoryObligationDischargeProvider([]), sources: [APPROVAL], declaration: { requirements: [] } } }
      : {}),
  });
}

/** Everything a caller observes, minus the ids a sequential generator assigns per instance. */
function observable(result: Awaited<ReturnType<AocKernel['evaluate']>>): unknown {
  const { decisionId: _decisionId, trace, ...rest } = result;
  return { ...rest, trace: { steps: trace.steps.map(({ ...step }) => step), kernelVersion: trace.kernelVersion } };
}

describe('Characterization: a kernel with no obligation capability is unchanged', () => {
  it('an allowed evaluation carries no obligations field at all — absent, not empty', async () => {
    const result = await buildKernel().evaluate(toKernelRequest(buildDraftClosureEmailGuardInput()));

    assert.equal(result.status, 'allowed');
    assert.equal(result.obligations, undefined, 'no obligation capability means the kernel asked no obligation question');
    assert.equal('obligations' in result, false, 'the field is absent from the object, so a canonical-JSON record is byte-identical');
  });

  it('a denied evaluation is equally unchanged', async () => {
    const result = await buildKernel().evaluate(toKernelRequest(buildUnknownAgentReadGuardInput()));

    assert.equal(result.status, 'denied');
    assert.equal('obligations' in result, false);
  });

  it('two kernels composed the same way produce the same observable result', async () => {
    const request = toKernelRequest(buildDraftClosureEmailGuardInput());
    const left = await buildKernel().evaluate({ ...request, requestId: 'characterization-obligation-absent-1' });
    const right = await buildKernel().evaluate({ ...request, requestId: 'characterization-obligation-absent-1' });

    assert.deepEqual(observable(left), observable(right));
  });

  it('enforce() is unchanged, and the executor still runs exactly once', async () => {
    let ran = 0;
    const result = await buildKernel().enforce(toKernelRequest(buildDraftClosureEmailGuardInput()), () => {
      ran += 1;
      return 'done';
    });

    assert.equal(result.status, 'allowed');
    assert.equal(ran, 1);
    assert.equal(result.execution.executed, true);
    assert.equal('obligations' in result, false);
    assert.equal(result.execution.withheldBy, undefined);
  });

  it('no obligation namespace reaches a configured policy pack — obligations are never a policy input', async () => {
    const seen: (Readonly<Record<string, unknown>> | undefined)[] = [];
    const kernel = buildKernel({
      policyPackProvider: {
        evaluatePolicyForEnforcement(input) {
          seen.push(input.metadata);
          return { type: 'policy_allowed', allowed: true, reasonCode: 'POLICY_ALLOWED', reason: 'ok' };
        },
      },
    });

    const base = toKernelRequest(buildDraftClosureEmailGuardInput());
    await kernel.evaluate({ ...base, action: { ...base.action, amount: 7_500, currency: 'USD' } });

    assert.ok(seen.length > 0, 'the policy pack was consulted');
    for (const metadata of seen) assert.equal(metadata?.['aoc.obligations'], undefined);
  });
});

describe('Characterization: configured with nothing declared is equivalent to not configured', () => {
  it('evaluate() produces the identical observable result either way', async () => {
    const request = toKernelRequest(buildDraftClosureEmailGuardInput());
    const unconfigured = await buildKernel().evaluate({ ...request, requestId: 'characterization-obligation-empty-1' });
    const declaredNothing = await buildKernel({ declareNothing: true }).evaluate({ ...request, requestId: 'characterization-obligation-empty-1' });

    assert.deepEqual(observable(declaredNothing), observable(unconfigured));
    assert.equal('obligations' in declaredNothing, false, 'a declaration with no requirements adds no field');
  });

  it('enforce() executes exactly as it does with no capability at all', async () => {
    let ran = 0;
    const result = await buildKernel({ declareNothing: true }).enforce(toKernelRequest(buildDraftClosureEmailGuardInput()), () => {
      ran += 1;
      return 'done';
    });

    assert.equal(result.status, 'allowed');
    assert.equal(ran, 1);
    assert.equal(result.execution.executed, true);
    assert.equal('obligations' in result, false);
  });

  it('the provider is never consulted when nothing is declared — no speculative read of an approval system', async () => {
    let consulted = 0;
    const fixture = buildDatasysEnforcementFixture();
    const kernel = new AocKernel({
      recognitionProvider: bridgeRecognitionRuntime(fixture.recognitionRuntime),
      clock: createManualEnforcementClock(NOW),
      idGenerator: createSequentialEnforcementIdGenerator(),
      obligations: {
        provider: {
          resolveObligationDischarges() {
            consulted += 1;
            return Promise.resolve({ observations: [] });
          },
        },
        sources: [APPROVAL],
        declaration: { requirements: [] },
      },
    });

    await kernel.evaluate(toKernelRequest(buildDraftClosureEmailGuardInput()));
    assert.equal(consulted, 0);
  });
});
