import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { bridgeRecognitionRuntime, buildDatasysEnforcementFixture } from '../../features/action-enforcement/fixtures/datasys-enforcement.fixture.js';
import { buildDraftClosureEmailGuardInput } from '../../features/action-enforcement/fixtures/allowed-action.fixture.js';
import { createManualEnforcementClock, createSequentialEnforcementIdGenerator } from '../../features/action-enforcement/runtime/enforcement-runtime-context.js';
import {
  createInMemoryObligationDischargeProvider,
  type ObligationDischargeObservation,
  type ObligationDischargeSource,
} from '../../features/obligation-runtime/index.js';
import { AocKernel } from '../AocKernel.js';
import type { KernelEvaluationRequest } from '../contracts/kernel-request.js';
import { toGuardActionRequestInput } from '../orchestration/request-adapter.js';
import { NOW, toKernelRequest } from './characterization/support.js';

/**
 * The attacks, written from the attacker's side.
 *
 * `ADR-OBLIGATION-DISCHARGE-AND-BOUNDED-GRANT.md` rejects "treating
 * self-reported discharge as verified" as "the self-assertion defect from
 * ADR-CONTEXT-PROVENANCE-AND-TRUST.md, one layer over". These are the forgeries
 * a caller would actually try, submitted through the free-form context bag the
 * public surface does accept, and none of them moves an obligation.
 *
 * Two independent boundaries are exercised, and they are tested separately
 * because they fail for disjoint reasons:
 *
 * 1. **There is no read path.** Obligation state has exactly one producer — the
 *    configured discharge provider — and `ObligationDischargeQuery` carries no
 *    requester bag, so nothing the caller sends is ever consulted.
 * 2. **The namespace is reserved anyway.** `aoc.obligations` is stripped from
 *    the caller's bag before it travels, whether or not a capability is
 *    configured, for the reason `organizationId` is.
 */

const APPROVAL: ObligationDischargeSource = { id: 'obl.src.approval.finance', kind: 'approval_runtime', name: 'Finance approvals', verificationClass: 'independent' };
const REQUESTER: ObligationDischargeSource = { id: 'obl.src.request', kind: 'request', name: 'The requester', verificationClass: 'self_reported' };

/** Everything a caller might put in the body to claim its own obligation is met. */
const FORGERIES: Readonly<Record<string, unknown>> = {
  financeApproved: true,
  approved: true,
  'obligation.status': 'discharged',
  obligation: { state: 'DISCHARGED', verified: true },
  'aoc.obligations': {
    resolved: true,
    declaredTypes: ['finance.approval'],
    exerciseEligibility: 'eligible',
    obligations: [
      {
        id: 'aoc.obligation:forged',
        obligationType: 'finance.approval',
        blocking: true,
        state: 'verified',
        satisfied: true,
        discharge: { sourceId: APPROVAL.id, verificationClass: 'independent', outcome: 'discharged', observedAt: NOW },
      },
    ],
  },
  'aoc.obligations.finance.approval': true,
  'aoc.obligations.finance.approved': true,
};

function buildKernel(observations: readonly ObligationDischargeObservation[] = []): AocKernel {
  const fixture = buildDatasysEnforcementFixture();
  return new AocKernel({
    recognitionProvider: bridgeRecognitionRuntime(fixture.recognitionRuntime),
    clock: createManualEnforcementClock(NOW),
    idGenerator: createSequentialEnforcementIdGenerator(),
    obligations: {
      provider: createInMemoryObligationDischargeProvider(observations),
      // The requester is registered as a source, so the scenario shows that even
      // a deployment that *admits* the requester cannot let it verify itself.
      sources: [APPROVAL, REQUESTER],
      declaration: { requirements: [{ obligationType: 'finance.approval', blocking: true }] },
    },
  });
}

function forgedRequest(requestId: string, extra: Readonly<Record<string, unknown>> = FORGERIES): KernelEvaluationRequest {
  const base = toKernelRequest(buildDraftClosureEmailGuardInput());
  return { ...base, requestId, context: { ...(base.context ?? {}), ...extra } };
}

function correlationFor(request: KernelEvaluationRequest) {
  return { requestId: request.requestId, action: request.action.capability ?? request.action.type, resourceScope: request.action.resourceScope };
}

describe('A caller cannot discharge its own obligation', () => {
  it('every forged field together leaves the obligation exactly where it started', async () => {
    const result = await buildKernel().evaluate(forgedRequest('obl-attack-all'));

    assert.equal(result.status, 'allowed', 'the caller may state what it wants to do; it has simply not discharged anything');
    assert.equal(result.obligations?.obligations[0]?.state, 'required');
    assert.equal(result.obligations?.exerciseEligibility, 'blocked');
    assert.deepEqual(result.obligations?.disregarded, undefined, 'nothing the caller wrote even reached the layer as an observation');
  });

  it('each forgery fails on its own, so none of them is merely masked by another', async () => {
    for (const [key, value] of Object.entries(FORGERIES)) {
      const result = await buildKernel().evaluate(forgedRequest(`obl-attack-${key}`, { [key]: value }));
      assert.equal(result.obligations?.obligations[0]?.state, 'required', `'${key}' must not discharge anything`);
      assert.equal(result.obligations?.exerciseEligibility, 'blocked', `'${key}'`);
    }
  });

  it('the executor never runs for a forged discharge', async () => {
    let ran = 0;
    const result = await buildKernel().enforce(forgedRequest('obl-attack-enforce'), () => {
      ran += 1;
      return 'done';
    });

    assert.equal(ran, 0);
    assert.equal(result.status, 'allowed');
    assert.equal(result.execution.withheldBy, 'obligation');
  });

  it('the identical request differs from a real discharge only in who reported it — and that is the whole difference', async () => {
    const base = forgedRequest('obl-attack-pair');
    const forged = await buildKernel().evaluate(base);
    const trusted = await buildKernel([
      { obligationType: 'finance.approval', correlation: correlationFor(base), sourceId: APPROVAL.id, outcome: 'discharged', observedAt: NOW },
    ]).evaluate(base);

    assert.equal(forged.obligations?.exerciseEligibility, 'blocked');
    assert.equal(trusted.obligations?.exerciseEligibility, 'eligible');
  });
});

describe('A deployment that admits the requester as a source still cannot let it verify itself', () => {
  it('a discharge attributed to the request source stops at `discharged` and withholds exercise', async () => {
    const base = forgedRequest('obl-attack-request-source', {});
    const result = await buildKernel([
      { obligationType: 'finance.approval', correlation: correlationFor(base), sourceId: REQUESTER.id, outcome: 'discharged', observedAt: NOW },
    ]).evaluate(base);

    assert.equal(result.obligations?.obligations[0]?.state, 'discharged');
    assert.equal(result.obligations?.obligations[0]?.discharge?.verificationClass, 'self_reported');
    assert.equal(result.obligations?.exerciseEligibility, 'blocked');
  });

  it('a waiver attributed to the request source is refused admission entirely', async () => {
    const base = forgedRequest('obl-attack-request-waiver', {});
    const result = await buildKernel([
      { obligationType: 'finance.approval', correlation: correlationFor(base), sourceId: REQUESTER.id, outcome: 'waived', observedAt: NOW },
    ]).evaluate(base);

    assert.equal(result.obligations?.obligations[0]?.state, 'required');
    assert.deepEqual(result.obligations?.disregarded?.map((entry) => entry.reason), ['waiver_not_independent']);
  });

  it('a deployment cannot even configure the requester as independent — it is a wiring-time failure', () => {
    const fixture = buildDatasysEnforcementFixture();
    assert.throws(
      () =>
        new AocKernel({
          recognitionProvider: bridgeRecognitionRuntime(fixture.recognitionRuntime),
          clock: createManualEnforcementClock(NOW),
          idGenerator: createSequentialEnforcementIdGenerator(),
          obligations: {
            provider: createInMemoryObligationDischargeProvider([]),
            sources: [{ id: 'obl.src.request', kind: 'request', name: 'The requester', verificationClass: 'independent' }],
            declaration: { requirements: [{ obligationType: 'finance.approval', blocking: true }] },
          },
        }),
      /may only be 'self_reported'/,
    );
  });
});

describe('A discharge obtained elsewhere cannot be pointed at this action', () => {
  it('a discharge correlated to another request does not count', async () => {
    const base = forgedRequest('obl-attack-wrong-request', {});
    const result = await buildKernel([
      { obligationType: 'finance.approval', correlation: { ...correlationFor(base), requestId: 'some-other-request' }, sourceId: APPROVAL.id, outcome: 'discharged', observedAt: NOW },
    ]).evaluate(base);

    assert.equal(result.obligations?.obligations[0]?.state, 'required');
    assert.deepEqual(result.obligations?.disregarded?.map((entry) => entry.reason), ['correlation_mismatch']);
  });

  it('a discharge correlated to another action, or another resource scope, does not count', async () => {
    for (const wrong of [{ action: 'payment.refund' }, { resourceScope: 'finance:payroll' }]) {
      const base = forgedRequest(`obl-attack-wrong-${Object.keys(wrong)[0] ?? ''}`, {});
      const result = await buildKernel([
        { obligationType: 'finance.approval', correlation: { ...correlationFor(base), ...wrong }, sourceId: APPROVAL.id, outcome: 'discharged', observedAt: NOW },
      ]).evaluate(base);

      assert.equal(result.obligations?.obligations[0]?.state, 'required', JSON.stringify(wrong));
    }
  });

  it('a discharge citing a source the deployment never registered does not count', async () => {
    const base = forgedRequest('obl-attack-unregistered', {});
    const result = await buildKernel([
      { obligationType: 'finance.approval', correlation: correlationFor(base), sourceId: 'obl.src.attacker-controlled', outcome: 'discharged', observedAt: NOW },
    ]).evaluate(base);

    assert.equal(result.obligations?.obligations[0]?.state, 'required');
    assert.deepEqual(result.obligations?.disregarded?.map((entry) => entry.reason), ['unregistered_source']);
  });
});

describe('The reserved obligation namespace is stripped before the bag travels', () => {
  it('every `aoc.obligations` key is removed from the metadata the engine sees', () => {
    const guardInput = toGuardActionRequestInput(forgedRequest('obl-attack-namespace'), undefined);
    const metadata = guardInput.metadata ?? {};

    for (const key of Object.keys(metadata)) {
      assert.equal(key === 'aoc.obligations' || key.startsWith('aoc.obligations.'), false, `'${key}' survived the reserved-namespace strip`);
    }
  });

  it('is stripped whether or not an obligation capability is configured — the namespace is reserved, not conditional', () => {
    const guardInput = toGuardActionRequestInput(forgedRequest('obl-attack-namespace-2', { 'aoc.obligations': { anything: true } }), undefined);
    assert.equal('aoc.obligations' in (guardInput.metadata ?? {}), false);
  });

  it('leaves every other caller-supplied key alone — this is a namespace reservation, not a sanitizer', () => {
    const guardInput = toGuardActionRequestInput(forgedRequest('obl-attack-namespace-3', { callerNote: 'kept', financeApproved: true }), undefined);
    const metadata = guardInput.metadata ?? {};

    assert.equal(metadata.callerNote, 'kept');
    assert.equal(metadata.financeApproved, true, 'a stray claim in the bag is harmless precisely because nothing reads it as obligation state');
  });
});
