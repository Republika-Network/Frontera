import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { bridgeRecognitionRuntime, buildDatasysEnforcementFixture } from '../../../features/action-enforcement/fixtures/datasys-enforcement.fixture.js';
import { createManualEnforcementClock, createSequentialEnforcementIdGenerator } from '../../../features/action-enforcement/runtime/enforcement-runtime-context.js';
import { buildDraftClosureEmailGuardInput } from '../../../features/action-enforcement/fixtures/allowed-action.fixture.js';
import { buildUnknownAgentReadGuardInput } from '../../../features/action-enforcement/fixtures/denied-action.fixture.js';
import { AocKernel } from '../../AocKernel.js';
import type { PolicyPackProvider } from '../../contracts/ports.js';
import { NOW, toKernelRequest } from './support.js';

/**
 * The compatibility characterization for the trusted-context capability.
 *
 * `TARGET_AUTHORITY_CONTROL_ARCHITECTURE.md` §7 makes this the governing
 * constraint of the whole migration: "every new capability is an optional port.
 * Omitted → byte-identical behaviour. Each new port carries a characterization
 * test proving the unconfigured path is unchanged." This is that test.
 *
 * The comparison is between two independently-composed kernels over the same
 * recognition world — one built exactly as every existing deployment builds
 * one, the other identical in every respect. Agreement is therefore evidence
 * about the code path, not about shared state.
 */

function buildKernel(options: { readonly policyPackProvider?: PolicyPackProvider } = {}): AocKernel {
  const fixture = buildDatasysEnforcementFixture();
  return new AocKernel({
    recognitionProvider: bridgeRecognitionRuntime(fixture.recognitionRuntime),
    clock: createManualEnforcementClock(NOW),
    idGenerator: createSequentialEnforcementIdGenerator(),
    ...(options.policyPackProvider !== undefined ? { policyPackProvider: options.policyPackProvider } : {}),
  });
}

/** Everything a caller observes, minus the ids a sequential generator assigns per instance. */
function observable(result: Awaited<ReturnType<AocKernel['evaluate']>>): unknown {
  const { decisionId: _decisionId, trace, ...rest } = result;
  return {
    ...rest,
    trace: { steps: trace.steps.map(({ ...step }) => step), kernelVersion: trace.kernelVersion },
  };
}

describe('Characterization: a kernel with no context capability is unchanged', () => {
  it('an allowed evaluation carries no context field at all — absent, not empty', async () => {
    const result = await buildKernel().evaluate(toKernelRequest(buildDraftClosureEmailGuardInput()));

    assert.equal(result.status, 'allowed');
    assert.equal(result.context, undefined, 'no context capability means the kernel asked no context question');
    assert.equal('context' in result, false, 'the field is absent from the object, so a canonical-JSON record is byte-identical');
  });

  it('a denied evaluation is equally unchanged', async () => {
    const result = await buildKernel().evaluate(toKernelRequest(buildUnknownAgentReadGuardInput()));

    assert.equal(result.status, 'denied');
    assert.equal('context' in result, false);
  });

  it('two kernels composed the same way produce the same observable result', async () => {
    const request = toKernelRequest(buildDraftClosureEmailGuardInput());
    const left = await buildKernel().evaluate({ ...request, requestId: 'characterization-context-absent-1' });
    const right = await buildKernel().evaluate({ ...request, requestId: 'characterization-context-absent-1' });

    assert.deepEqual(observable(left), observable(right));
  });

  it('no `aoc.context` key reaches a configured policy pack', async () => {
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
    await kernel.evaluate({ ...base, action: { ...base.action, amount: '7500', currency: 'USD', counterpartyId: 'V123' } });

    assert.ok(seen.length > 0, 'the policy pack was consulted');
    for (const metadata of seen) {
      assert.equal(metadata?.['aoc.context'], undefined, 'no context namespace exists in a deployment that has not adopted the capability');
    }
  });

  it('the policy input the pack sees is exactly the caller-supplied action fields, unreinterpreted', async () => {
    let observedAmount: unknown;
    let observedCounterparty: unknown;
    const kernel = buildKernel({
      policyPackProvider: {
        evaluatePolicyForEnforcement(input) {
          observedAmount = input.amount;
          observedCounterparty = input.counterpartyId;
          return { type: 'policy_allowed', allowed: true, reasonCode: 'POLICY_ALLOWED', reason: 'ok' };
        },
      },
    });

    const base = toKernelRequest(buildDraftClosureEmailGuardInput());
    await kernel.evaluate({ ...base, action: { ...base.action, amount: '7500', counterpartyId: 'V123' } });

    // `ActionDescriptor.amount` keeps exactly the meaning it has today. The
    // capability adds a second, namespaced channel; it reinterprets nothing.
    assert.equal(observedAmount, '7500');
    assert.equal(observedCounterparty, 'V123');
  });

  it('enforce() is likewise unchanged, and the executor still runs', async () => {
    let ran = 0;
    const result = await buildKernel().enforce(toKernelRequest(buildDraftClosureEmailGuardInput()), () => {
      ran += 1;
      return 'done';
    });

    assert.equal(result.status, 'allowed');
    assert.equal(ran, 1);
    assert.equal('context' in result, false);
  });
});
