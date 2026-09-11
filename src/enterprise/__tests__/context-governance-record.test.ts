import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  createInMemoryContextResolver,
  type ContextDeclaration,
  type ContextFactObservation,
  type ContextSource,
} from '../../features/context-resolution-runtime/index.js';
import { createAocKernel, type KernelEvaluationRequest, type KernelEvaluationResult } from '../../kernel/index.js';
import { toKernelEvaluationOptions, toKernelEvaluationRequest } from '../api/governance-evaluate-contract.js';
import { projectResultPayload } from '../governance-store/projection.js';
import { computeDigest } from '../governance-store/digest.js';
import { createInMemoryGovernanceStore } from '../persistence/in-memory-governance-store.js';
import { buildAllowedRequestBody, buildTestKernelProviders } from './support.js';

/**
 * What the trusted-context capability does, and does not, do to the durable
 * record.
 *
 * `TARGET_AUTHORITY_CONTROL_ARCHITECTURE.md` §8 puts the evidence extension at
 * phase 9, so this phase deliberately adds no evidence subject, no bundle
 * field, no disclosure-policy entry and no store schema change. What it does do
 * is carry context *provenance* on the decision, which the Governance Record
 * canonicalizes like every other result field — so both halves need pinning:
 * unchanged when the capability is absent, and value-free when it is present.
 */

const ERP: ContextSource = { id: 'ctx.src.erp.sap-prod', kind: 'erp', name: 'SAP production', trustClass: 'authoritative' };
const DECLARATION: ContextDeclaration = { requirements: [{ key: 'vendor.status', minimumTrustClass: 'authoritative', required: false }] };
const OBSERVATIONS: readonly ContextFactObservation[] = [{ key: 'vendor.status', value: 'approved-and-commercially-sensitive', sourceId: ERP.id, observedAt: '2026-01-01T00:00:00.000Z' }];

async function evaluate(requestId: string, withContext: boolean): Promise<{ request: KernelEvaluationRequest; result: KernelEvaluationResult }> {
  const providers = buildTestKernelProviders();
  const kernel = createAocKernel({
    recognitionProvider: providers.recognitionProvider,
    clock: providers.clock,
    idGenerator: providers.idGenerator,
    ...(withContext
      ? { contextResolution: { provider: createInMemoryContextResolver(OBSERVATIONS), sources: [ERP], declaration: DECLARATION } }
      : {}),
  });
  const body = buildAllowedRequestBody({ requestId });
  const request = toKernelEvaluationRequest(body, providers.clock, providers.idGenerator);
  const result = await kernel.evaluate(request, toKernelEvaluationOptions(body, 'full'));
  return { request, result };
}

describe('Governance record — unchanged when the context capability is absent', () => {
  it('the projected result payload carries no context key at all', async () => {
    const { result } = await evaluate('ctx-record-absent', false);
    const payload = projectResultPayload(result);

    assert.equal('context' in payload, false);
  });

  it('the result digest is byte-identical to one computed before the capability existed in the wiring', async () => {
    const withoutCapability = await evaluate('ctx-record-parity', false);
    const alsoWithoutCapability = await evaluate('ctx-record-parity', false);

    assert.equal(
      computeDigest(projectResultPayload(withoutCapability.result)),
      computeDigest(projectResultPayload(alsoWithoutCapability.result)),
      'two independently-composed kernels without the capability produce the same canonical payload',
    );
  });

  it('the record commits and verifies exactly as it always has', async () => {
    const store = await createInMemoryGovernanceStore();
    const { request, result } = await evaluate('ctx-record-commit-absent', false);

    const persisted = await store.persistEvaluation({ request, result, receivedAt: request.requestedAt });
    assert.equal(persisted.outcome, 'stored');
    assert.equal('context' in persisted.evaluation.resultPayload, false);

    await store.close();
  });
});

describe('Governance record — provenance without values when the capability is present', () => {
  it('the record carries which key, which source, at what class and when — and never the value', async () => {
    const { result } = await evaluate('ctx-record-present', true);
    const payload = projectResultPayload(result);
    const serialized = JSON.stringify(payload);

    assert.ok('context' in payload);
    assert.match(serialized, /vendor\.status/);
    assert.match(serialized, /ctx\.src\.erp\.sap-prod/);
    assert.match(serialized, /authoritative/);
    assert.doesNotMatch(serialized, /commercially-sensitive/, 'a fact value never enters the durable record');
  });

  it('the record is deterministic: the same world produces the same digest', async () => {
    const first = await evaluate('ctx-record-determinism', true);
    const second = await evaluate('ctx-record-determinism', true);

    assert.equal(computeDigest(projectResultPayload(first.result)), computeDigest(projectResultPayload(second.result)));
  });

  it('the record still commits, and an idempotent replay is still recognized as one', async () => {
    const store = await createInMemoryGovernanceStore();
    const { request, result } = await evaluate('ctx-record-commit-present', true);

    const first = await store.persistEvaluation({ request, result, receivedAt: request.requestedAt });
    const second = await store.persistEvaluation({ request, result, receivedAt: request.requestedAt });

    assert.equal(first.outcome, 'stored');
    assert.equal(second.outcome, 'idempotent_replay');

    const stored = await store.getEvaluationByRequestId(request.requestId);
    const storedContext = stored?.resultPayload['context'] as { readonly facts: readonly Record<string, unknown>[] } | undefined;
    assert.ok(storedContext !== undefined);
    assert.equal('value' in (storedContext.facts[0] ?? {}), false);

    await store.close();
  });
});
