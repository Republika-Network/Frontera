import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  createInMemoryObligationDischargeProvider,
  type ObligationDeclaration,
  type ObligationDischargeObservation,
  type ObligationDischargeSource,
} from '../../features/obligation-runtime/index.js';
import { createAocKernel, type KernelEvaluationRequest, type KernelEvaluationResult } from '../../kernel/index.js';
import { toKernelEvaluationOptions, toKernelEvaluationRequest } from '../api/governance-evaluate-contract.js';
import { projectResultPayload } from '../governance-store/projection.js';
import { computeDigest } from '../governance-store/digest.js';
import { createInMemoryGovernanceStore } from '../persistence/in-memory-governance-store.js';
import { buildAllowedRequestBody, buildTestKernelProviders } from './support.js';

/**
 * What the obligation capability does, and does not, do to the durable record.
 *
 * `TARGET_AUTHORITY_CONTROL_ARCHITECTURE.md` §8 puts obligations as an evidence
 * subject at phase 9, so this phase deliberately adds no evidence subject, no
 * bundle field, no disclosure-policy entry and no store schema change. What it
 * does do is carry obligation *state and provenance* on the decision, which the
 * Governance Record canonicalizes like every other result field — so both
 * halves need pinning: unchanged when the capability is absent, and
 * payload-free when it is present.
 */

const APPROVAL: ObligationDischargeSource = { id: 'obl.src.approval.finance', kind: 'approval_runtime', name: 'Finance approvals', verificationClass: 'independent' };
const DECLARATION: ObligationDeclaration = { requirements: [{ obligationType: 'finance.approval', blocking: true }] };

function observationsFor(requestId: string, action: string, resourceScope: string): readonly ObligationDischargeObservation[] {
  return [
    {
      obligationType: 'finance.approval',
      correlation: { requestId, action, resourceScope },
      sourceId: APPROVAL.id,
      outcome: 'discharged',
      observedAt: '2026-01-01T00:00:00.000Z',
      subjectId: 'cfo@example.test',
      reference: 'AP-COMMERCIALLY-SENSITIVE-771',
    },
  ];
}

async function evaluate(requestId: string, withObligations: boolean): Promise<{ request: KernelEvaluationRequest; result: KernelEvaluationResult }> {
  const providers = buildTestKernelProviders();
  const body = buildAllowedRequestBody({ requestId });
  const request = toKernelEvaluationRequest(body, providers.clock, providers.idGenerator);
  const kernel = createAocKernel({
    recognitionProvider: providers.recognitionProvider,
    clock: providers.clock,
    idGenerator: providers.idGenerator,
    ...(withObligations
      ? {
          obligations: {
            provider: createInMemoryObligationDischargeProvider(observationsFor(request.requestId, request.action.capability ?? request.action.type, request.action.resourceScope)),
            sources: [APPROVAL],
            declaration: DECLARATION,
          },
        }
      : {}),
  });
  const result = await kernel.evaluate(request, toKernelEvaluationOptions(body, 'full'));
  return { request, result };
}

describe('Governance record — unchanged when the obligation capability is absent', () => {
  it('the projected result payload carries no obligations key at all', async () => {
    const { result } = await evaluate('obl-record-absent', false);
    assert.equal('obligations' in projectResultPayload(result), false);
  });

  it('the result digest is byte-identical to one computed before the capability existed in the wiring', async () => {
    const first = await evaluate('obl-record-parity', false);
    const second = await evaluate('obl-record-parity', false);

    assert.equal(
      computeDigest(projectResultPayload(first.result)),
      computeDigest(projectResultPayload(second.result)),
      'two independently-composed kernels without the capability produce the same canonical payload',
    );
  });

  it('the record commits and verifies exactly as it always has', async () => {
    const store = await createInMemoryGovernanceStore();
    const { request, result } = await evaluate('obl-record-commit-absent', false);

    const persisted = await store.persistEvaluation({ request, result, receivedAt: request.requestedAt });
    assert.equal(persisted.outcome, 'stored');
    assert.equal('obligations' in persisted.evaluation.resultPayload, false);

    await store.close();
  });
});

describe('Governance record — state and provenance without payload when the capability is present', () => {
  it('the record carries which obligation, in what state, discharged by which source and when', async () => {
    const { result } = await evaluate('obl-record-present', true);
    const payload = projectResultPayload(result);
    const serialized = JSON.stringify(payload);

    assert.ok('obligations' in payload);
    assert.match(serialized, /finance\.approval/);
    assert.match(serialized, /verified/);
    assert.match(serialized, /obl\.src\.approval\.finance/);
    assert.match(serialized, /independent/);
  });

  it('the decision half of the record is unchanged by the obligation half', async () => {
    const withCapability = await evaluate('obl-record-decision-parity', true);
    const withoutCapability = await evaluate('obl-record-decision-parity', false);

    const decisionOnly = (result: KernelEvaluationResult) => {
      const { obligations: _obligations, trace: _trace, decisionId: _decisionId, ...rest } = result;
      return computeDigest(rest as unknown as Readonly<Record<string, unknown>>);
    };

    assert.equal(decisionOnly(withCapability.result), decisionOnly(withoutCapability.result), 'adding obligations changed nothing a decision is made of');
  });

  it('the record is deterministic: the same world produces the same digest', async () => {
    const first = await evaluate('obl-record-determinism', true);
    const second = await evaluate('obl-record-determinism', true);

    assert.equal(computeDigest(projectResultPayload(first.result)), computeDigest(projectResultPayload(second.result)));
  });

  it('the record still commits, and an idempotent replay is still recognized as one', async () => {
    const store = await createInMemoryGovernanceStore();
    const { request, result } = await evaluate('obl-record-commit-present', true);

    const first = await store.persistEvaluation({ request, result, receivedAt: request.requestedAt });
    const second = await store.persistEvaluation({ request, result, receivedAt: request.requestedAt });

    assert.equal(first.outcome, 'stored');
    assert.equal(second.outcome, 'idempotent_replay');

    const stored = await store.getEvaluationByRequestId(request.requestId);
    const storedObligations = stored?.resultPayload['obligations'] as { readonly obligations: readonly Record<string, unknown>[] } | undefined;
    assert.ok(storedObligations !== undefined);
    assert.equal('payload' in (storedObligations.obligations[0] ?? {}), false, 'an obligation carries provenance, never an approval body');

    await store.close();
  });
});
