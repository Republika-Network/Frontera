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
 * The compatibility characterization for the bounded-grant capability.
 *
 * `TARGET_AUTHORITY_CONTROL_ARCHITECTURE.md` §7 makes this the governing
 * constraint of the whole migration: "every new capability is an optional port.
 * Omitted → byte-identical behaviour. Each new port carries a characterization
 * test proving the unconfigured path is unchanged." This is that test for layer
 * E, and it pins three things rather than one: the field is absent (not empty),
 * the observable result is identical, and nothing about the obligation or
 * context layers changes when grants are added on top of them.
 */

const APPROVAL: ObligationDischargeSource = { id: 'obl.src.approval.finance', kind: 'approval_runtime', name: 'Finance approvals', verificationClass: 'independent' };

function buildKernel(options: { readonly policyPackProvider?: PolicyPackProvider; readonly withObligations?: boolean } = {}): AocKernel {
  const fixture = buildDatasysEnforcementFixture();
  return new AocKernel({
    recognitionProvider: bridgeRecognitionRuntime(fixture.recognitionRuntime),
    clock: createManualEnforcementClock(NOW),
    idGenerator: createSequentialEnforcementIdGenerator(),
    ...(options.policyPackProvider !== undefined ? { policyPackProvider: options.policyPackProvider } : {}),
    ...(options.withObligations === true
      ? {
          obligations: {
            provider: createInMemoryObligationDischargeProvider([]),
            sources: [APPROVAL],
            declaration: { requirements: [{ obligationType: 'finance.approval', blocking: true }] },
          },
        }
      : {}),
  });
}

/** Everything a caller observes, minus the ids a sequential generator assigns per instance. */
function observable(result: Awaited<ReturnType<AocKernel['evaluate']>>): unknown {
  const { decisionId: _decisionId, trace, ...rest } = result;
  return { ...rest, trace: { steps: trace.steps.map(({ ...step }) => step), kernelVersion: trace.kernelVersion } };
}

describe('Characterization: a kernel with no grant capability is unchanged', () => {
  it('an allowed evaluation carries no grants field at all — absent, not empty', async () => {
    const result = await buildKernel().evaluate(toKernelRequest(buildDraftClosureEmailGuardInput()));

    assert.equal(result.status, 'allowed');
    assert.equal(result.grants, undefined, 'no grant capability means the kernel asked no grant question');
    assert.equal('grants' in result, false, 'the field is absent from the object, so a canonical-JSON record is byte-identical');
  });

  it('a denied evaluation is equally unchanged', async () => {
    const result = await buildKernel().evaluate(toKernelRequest(buildUnknownAgentReadGuardInput()));

    assert.equal(result.status, 'denied');
    assert.equal('grants' in result, false);
  });

  it('two kernels composed the same way produce the same observable result', async () => {
    const request = toKernelRequest(buildDraftClosureEmailGuardInput());
    const left = await buildKernel().evaluate({ ...request, requestId: 'characterization-grant-absent-1' });
    const right = await buildKernel().evaluate({ ...request, requestId: 'characterization-grant-absent-1' });

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
    assert.equal('grants' in result, false);
    assert.equal(result.execution.withheldBy, undefined);
  });

  it('the obligation layer is unaffected: a withheld execution is still withheld by the obligation, and carries no grants field', async () => {
    let ran = 0;
    const result = await buildKernel({ withObligations: true }).enforce(toKernelRequest(buildDraftClosureEmailGuardInput()), () => {
      ran += 1;
      return 'done';
    });

    assert.equal(result.status, 'allowed');
    assert.equal(ran, 0);
    assert.equal(result.execution.withheldBy, 'obligation');
    assert.equal('grants' in result, false);
  });

  it('no grant namespace reaches a configured policy pack — a grant is never a policy input', async () => {
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
    await kernel.evaluate({ ...base, action: { ...base.action, amount: '7500', currency: 'USD' } });

    assert.ok(seen.length > 0, 'the policy pack was consulted');
    for (const metadata of seen) {
      assert.equal(metadata?.['aoc.grant'], undefined);
      assert.equal(metadata?.['aoc.grants'], undefined);
    }
  });
});

describe('Characterization: configuring grants changes nothing about the authorization', () => {
  function withGrants(): AocKernel {
    const fixture = buildDatasysEnforcementFixture();
    return new AocKernel({
      recognitionProvider: bridgeRecognitionRuntime(fixture.recognitionRuntime),
      clock: createManualEnforcementClock(NOW),
      idGenerator: createSequentialEnforcementIdGenerator(),
      grants: { declaration: { maximumGrantLifetimeSeconds: 600 } },
    });
  }

  it('the authorization half of the result is byte-identical with and without the capability', async () => {
    const request = toKernelRequest(buildDraftClosureEmailGuardInput());
    const without = await buildKernel().evaluate({ ...request, requestId: 'characterization-grant-parity-1' });
    const withCapability = await withGrants().evaluate({ ...request, requestId: 'characterization-grant-parity-1' });

    const { grants, ...rest } = withCapability;
    assert.ok(grants !== undefined, 'the capability is configured, so the field is present');
    assert.deepEqual(observable(rest as typeof withCapability), observable(without), 'the grant step adds a field and changes nothing else');
  });

  it('the same holds for a denial', async () => {
    const request = toKernelRequest(buildUnknownAgentReadGuardInput());
    const without = await buildKernel().evaluate({ ...request, requestId: 'characterization-grant-parity-2' });
    const withCapability = await withGrants().evaluate({ ...request, requestId: 'characterization-grant-parity-2' });

    const { grants, ...rest } = withCapability;
    assert.equal(withCapability.status, 'denied');
    assert.equal(grants?.eligibility, 'ineligible');
    assert.deepEqual(observable(rest as typeof withCapability), observable(without));
  });

  it('enforce() still invokes the executor exactly once — a configured grant capability gates nothing', async () => {
    let ran = 0;
    const result = await withGrants().enforce(toKernelRequest(buildDraftClosureEmailGuardInput()), () => {
      ran += 1;
      return 'done';
    });

    assert.equal(ran, 1);
    assert.equal(result.execution.executed, true);
    assert.equal(result.grants?.eligibility, 'eligible');
  });

  it('an empty declaration is valid — a deployment adopts grants by composing the capability, not by configuring a limit', async () => {
    const fixture = buildDatasysEnforcementFixture();
    const kernel = new AocKernel({
      recognitionProvider: bridgeRecognitionRuntime(fixture.recognitionRuntime),
      clock: createManualEnforcementClock(NOW),
      idGenerator: createSequentialEnforcementIdGenerator(),
      grants: { declaration: {} },
    });

    const result = await kernel.evaluate(toKernelRequest(buildDraftClosureEmailGuardInput()));
    assert.equal(result.grants?.eligibility, 'eligible', 'no deployment cap is not a reason to withhold eligibility');
    assert.deepEqual(result.grants?.validityCeilings, [], 'and it imposes no ceiling, which is an ordinary answer rather than an unbounded one');
  });

  it('a wiring-time misconfiguration is rejected when the Kernel is built, not when a payment is evaluated', () => {
    const fixture = buildDatasysEnforcementFixture();
    for (const maximumGrantLifetimeSeconds of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(
        () =>
          new AocKernel({
            recognitionProvider: bridgeRecognitionRuntime(fixture.recognitionRuntime),
            clock: createManualEnforcementClock(NOW),
            idGenerator: createSequentialEnforcementIdGenerator(),
            grants: { declaration: { maximumGrantLifetimeSeconds } },
          }),
        /maximumGrantLifetimeSeconds/,
      );
    }
  });
});
