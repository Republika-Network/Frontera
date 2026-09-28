import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { bridgeRecognitionRuntime, buildDatasysEnforcementFixture } from '../../features/action-enforcement/fixtures/datasys-enforcement.fixture.js';
import { buildDraftClosureEmailGuardInput } from '../../features/action-enforcement/fixtures/allowed-action.fixture.js';
import { createManualEnforcementClock, createSequentialEnforcementIdGenerator } from '../../features/action-enforcement/runtime/enforcement-runtime-context.js';
import type { EnforcementPolicyPackEvaluationInput } from '../../features/action-enforcement/domain/policy-pack-enforcement.js';
import { grantSourceDigest, serializeGrantScope } from '../../features/grant-runtime/index.js';
import { AocKernel } from '../AocKernel.js';
import type { KernelEvaluationRequest, KernelEvaluationResult, PolicyPackProvider } from '../index.js';
import { KernelGrantCapability, deriveGrantSourceAuthorization } from '../orchestration/grant-adapter.js';
import { toGuardActionRequestInput } from '../orchestration/request-adapter.js';
import { NOW, toKernelRequest } from './characterization/support.js';

/**
 * CORE-03 — the legacy, untyped `ActionDescriptor.parameters` bag is
 * non-authoritative. There is one canonical authority-relevant parameter
 * model (`governedParameters`); the old bag, however loud, changes no policy
 * input, no grant source and therefore no exercise bound. Measured through the
 * real request adapter, the real grant projection and a real `AocKernel`.
 */

const LOUD_BAG = Object.freeze({ recordCount: 1_000_000, amount: '99999999', actionClass: 'export', governanceProfile: 'anything', maxAmount: 1e12, allow: true });
const DIGEST = `sha256:${'7'.repeat(64)}`;

function semantic(request: KernelEvaluationRequest): KernelEvaluationRequest {
  return {
    ...request,
    action: {
      ...request.action,
      semantics: { actionClass: 'draft', resourceClass: 'project', governanceProfile: { id: 'project-drafting', version: 1, digest: DIGEST } },
      governedParameters: [{ dimension: 'recordCount', bound: 'maximum', type: 'integer', value: 5 }],
    },
  };
}

function withBag(request: KernelEvaluationRequest): KernelEvaluationRequest {
  return { ...request, action: { ...request.action, parameters: LOUD_BAG } };
}

describe('CORE-03 — ActionDescriptor.parameters cannot affect policy, grant issuance or exercise', () => {
  const base = semantic(toKernelRequest(buildDraftClosureEmailGuardInput()));

  it('the policy input is identical with and without the legacy bag', () => {
    assert.deepEqual(toGuardActionRequestInput(withBag(base), undefined).policyEvaluationInput, toGuardActionRequestInput(base, undefined).policyEvaluationInput);
    assert.equal(JSON.stringify(toGuardActionRequestInput(withBag(base), undefined).policyEvaluationInput).includes('1000000'), false);
  });

  it('the grant source — and so every bound a grant or an exercise is held to — is identical with and without it', () => {
    const decision = { decisionId: 'dec-legacy-bag', status: 'allowed', evaluatedAt: NOW } as KernelEvaluationResult;
    const capability = new KernelGrantCapability({ declaration: {} });
    const plain = deriveGrantSourceAuthorization(capability, base, decision);
    const loud = deriveGrantSourceAuthorization(capability, withBag(base), decision);
    assert.equal(serializeGrantScope(loud.scope), serializeGrantScope(plain.scope));
    assert.equal(grantSourceDigest(loud), grantSourceDigest(plain));
    assert.deepEqual(loud.scope.parameters, [{ dimension: 'recordCount', kind: 'maximum', type: 'integer', limit: 5 }], 'only the typed parameter is bounded');
  });

  it('a real Kernel shows the policy layer the same input and reaches the same decision and grant facts', async () => {
    const seen: EnforcementPolicyPackEvaluationInput[] = [];
    const capturing: PolicyPackProvider = {
      evaluatePolicyForEnforcement(input) {
        seen.push(input);
        return { type: 'policy_allowed', allowed: true, reasonCode: 'CAPTURED', reason: 'captured' };
      },
    };
    const kernel = () => {
      const fixture = buildDatasysEnforcementFixture();
      return new AocKernel({
        recognitionProvider: bridgeRecognitionRuntime(fixture.recognitionRuntime),
        clock: createManualEnforcementClock(NOW),
        idGenerator: createSequentialEnforcementIdGenerator(),
        policyPackProvider: capturing,
        grants: { declaration: {} },
      });
    };
    const plain = await kernel().evaluate({ ...base, requestId: 'legacy-bag-plain' });
    const loud = await kernel().evaluate(withBag({ ...base, requestId: 'legacy-bag-plain' }));
    assert.equal(seen.length, 2);
    const strip = ({ enforcementRequestId: _id, requestedAt: _at, ...rest }: EnforcementPolicyPackEvaluationInput) => rest;
    assert.deepEqual(strip(seen[1] as EnforcementPolicyPackEvaluationInput), strip(seen[0] as EnforcementPolicyPackEvaluationInput));
    assert.equal(loud.status, plain.status);
    assert.deepEqual(loud.grants?.sourceBounds, plain.grants?.sourceBounds);
  });

  it('the governed-action path never populates the legacy bag', async () => {
    const { readFileSync } = await import('node:fs');
    const builder = readFileSync('src/enterprise/governed-action/kernel-request.ts', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.equal(/\bparameters\s*:/.test(builder), false, 'buildGovernedActionKernelRequest writes governedParameters, never parameters');
  });
});
