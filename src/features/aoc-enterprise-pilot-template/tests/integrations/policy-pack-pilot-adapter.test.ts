import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createPolicyPackRuntime } from '../../../domain-policy-pack-runtime/services/policy-pack-runtime.js';
import { createPolicyPackRuntimeContext } from '../../../domain-policy-pack-runtime/runtime/policy-pack-runtime-context.js';
import { registerPaymentsBasicPolicyPack } from '../../../domain-policy-pack-runtime/packs/payments-basic.policy-pack.js';
import {
  mapPolicyPackVersionLegalCompleteness,
  summarizePolicyPackVersion,
  requiredPolicyPackIds,
  policyModelClaimsValidatedCompleteness,
} from '../../integrations/policy-pack-pilot-adapter.js';
import type { PilotPolicyModel } from '../../domain/pilot-policy.js';

/** NB-008: the trusted policy author these tests write as. */
const POLICY_WRITER = { system: true, actorId: 'operator:policy-pack-test' } as const;

describe('policy-pack-pilot-adapter', () => {
  it('1. maps policy packs', () => {
    const runtime = createPolicyPackRuntime(createPolicyPackRuntimeContext('2026-01-01T00:00:00.000Z'));
    const version = registerPaymentsBasicPolicyPack(runtime, POLICY_WRITER);
    const pack = runtime.listActivePolicyPacks().find((p) => p.id === version.policyPackId);
    if (pack === undefined) {
      throw new Error('Expected active policy pack.');
    }
    const summary = summarizePolicyPackVersion(pack, version);
    assert.equal(summary.policyPackId, pack.id);
    assert.equal(summary.policyPackVersionId, version.id);
    assert.ok(summary.ruleIds.length > 0);
  });

  it('2. preserves demoOnly', () => {
    const runtime = createPolicyPackRuntime(createPolicyPackRuntimeContext('2026-01-01T00:00:00.000Z'));
    const version = registerPaymentsBasicPolicyPack(runtime, POLICY_WRITER);
    assert.equal(version.demoOnly, true);
  });

  it('3. preserves legalCompleteness', () => {
    const runtime = createPolicyPackRuntime(createPolicyPackRuntimeContext('2026-01-01T00:00:00.000Z'));
    const version = registerPaymentsBasicPolicyPack(runtime, POLICY_WRITER);
    assert.equal(mapPolicyPackVersionLegalCompleteness(version), 'not_legal_advice');
  });

  it('4. does not claim compliance', () => {
    const policyModel: PilotPolicyModel = { policyPackIds: [], policyPackVersionIds: [], demoOnly: true, legalCompleteness: 'demo_policy_model', policyScenarios: [], walkthrough: [] };
    assert.equal(policyModelClaimsValidatedCompleteness(policyModel), false);

    const validated: PilotPolicyModel = { ...policyModel, legalCompleteness: 'counsel_validated' };
    assert.equal(policyModelClaimsValidatedCompleteness(validated), true);
  });

  it('5. identifies required pack IDs', () => {
    const policyModel: PilotPolicyModel = { policyPackIds: ['policy-pack-payments-basic'], policyPackVersionIds: [], demoOnly: true, legalCompleteness: 'demo_policy_model', policyScenarios: [], walkthrough: [] };
    assert.deepEqual(requiredPolicyPackIds(policyModel), ['policy-pack-payments-basic']);
  });
});
