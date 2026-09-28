import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createPolicyPackRuntimeContext } from '../runtime/policy-pack-runtime-context.js';
import { PolicyPackStore } from '../services/policy-pack-store.js';
import { PolicyPackLedger } from '../services/policy-pack-ledger.js';
import { PolicyPackRegistry, type RegisterPolicyPackInput, type RegisterPolicyPackVersionInput } from '../services/policy-pack-registry.js';

/** NB-008: the trusted policy author these tests write as. */
const POLICY_WRITER = { system: true, actorId: 'operator:policy-pack-test' } as const;

const NOW = '2026-01-01T00:00:00.000Z';

function buildPackInput(overrides: Partial<RegisterPolicyPackInput> = {}): RegisterPolicyPackInput {
  return {
    id: 'pack-1',
    name: 'Test Pack',
    description: 'A test pack.',
    kind: 'demo',
    domain: 'payments',
    ...overrides,
  };
}

function buildVersionInput(overrides: Partial<RegisterPolicyPackVersionInput> = {}): RegisterPolicyPackVersionInput {
  return {
    id: 'pack-1-v1',
    policyPackId: 'pack-1',
    version: '1.0.0',
    scope: {},
    rules: [
      {
        id: 'rule-1',
        policyPackVersionId: 'pack-1-v1',
        name: 'Test rule',
        description: 'A test rule.',
        status: 'active',
        priority: 100,
        condition: { type: 'predicate', field: 'action', operator: 'equals', value: 'do_thing' },
        effect: { type: 'allow', reasonCode: 'TEST_ALLOW', reason: 'Allowed for test.' },
        obligations: [],
        evidenceRequirements: [],
        approvalRequirements: [],
        severity: 'info',
        sourceIds: [],
      },
    ],
    sources: [],
    effectiveFrom: NOW,
    demoOnly: true,
    legalCompleteness: 'not_legal_advice',
    ...overrides,
  };
}

function setUp() {
  const ctx = createPolicyPackRuntimeContext(NOW);
  const store = new PolicyPackStore();
  const ledger = new PolicyPackLedger(ctx, store);
  const registry = new PolicyPackRegistry(ctx, store, ledger);
  return { ctx, store, ledger, registry };
}

describe('PolicyPackRegistry', () => {
  it('1. registers policy pack', () => {
    const { registry } = setUp();
    const pack = registry.registerPolicyPack(POLICY_WRITER, buildPackInput());
    assert.equal(pack.id, 'pack-1');
    assert.equal(pack.status, 'draft');
  });

  it('2. registers policy pack version', () => {
    const { registry } = setUp();
    registry.registerPolicyPack(POLICY_WRITER, buildPackInput());
    const version = registry.registerPolicyPackVersion(POLICY_WRITER, buildVersionInput());
    assert.equal(version.id, 'pack-1-v1');
    assert.equal(version.status, 'draft');
  });

  it('3. rejects duplicate pack ID', () => {
    const { registry } = setUp();
    registry.registerPolicyPack(POLICY_WRITER, buildPackInput());
    assert.throws(() => registry.registerPolicyPack(POLICY_WRITER, buildPackInput()));
  });

  it('4. rejects duplicate version ID', () => {
    const { registry } = setUp();
    registry.registerPolicyPack(POLICY_WRITER, buildPackInput());
    registry.registerPolicyPackVersion(POLICY_WRITER, buildVersionInput());
    assert.throws(() => registry.registerPolicyPackVersion(POLICY_WRITER, buildVersionInput()));
  });

  it('5. activates version', () => {
    const { registry } = setUp();
    registry.registerPolicyPack(POLICY_WRITER, buildPackInput());
    registry.registerPolicyPackVersion(POLICY_WRITER, buildVersionInput());
    const activated = registry.activatePolicyPackVersion(POLICY_WRITER, 'pack-1-v1');
    assert.equal(activated.status, 'active');
    assert.equal(registry.listActivePacks()[0]?.currentVersionId, 'pack-1-v1');
  });

  it('6. deprecates version', () => {
    const { registry } = setUp();
    registry.registerPolicyPack(POLICY_WRITER, buildPackInput());
    registry.registerPolicyPackVersion(POLICY_WRITER, buildVersionInput());
    registry.activatePolicyPackVersion(POLICY_WRITER, 'pack-1-v1');
    const deprecated = registry.deprecatePolicyPackVersion(POLICY_WRITER, 'pack-1-v1');
    assert.equal(deprecated.status, 'deprecated');
  });

  it('7. revokes version', () => {
    const { registry } = setUp();
    registry.registerPolicyPack(POLICY_WRITER, buildPackInput());
    registry.registerPolicyPackVersion(POLICY_WRITER, buildVersionInput());
    const revoked = registry.revokePolicyPackVersion(POLICY_WRITER, 'pack-1-v1');
    assert.equal(revoked.status, 'revoked');
    assert.throws(() => registry.activatePolicyPackVersion(POLICY_WRITER, 'pack-1-v1'));
  });

  it('8. supersedes version', () => {
    const { registry, store } = setUp();
    registry.registerPolicyPack(POLICY_WRITER, buildPackInput());
    registry.registerPolicyPackVersion(POLICY_WRITER, buildVersionInput());
    registry.activatePolicyPackVersion(POLICY_WRITER, 'pack-1-v1');
    registry.registerPolicyPackVersion(POLICY_WRITER, buildVersionInput({ id: 'pack-1-v2', version: '2.0.0', supersedesVersionId: 'pack-1-v1' }));
    registry.activatePolicyPackVersion(POLICY_WRITER, 'pack-1-v2');
    assert.equal(store.getVersion('pack-1-v1')?.status, 'superseded');
  });

  it('9. lists active packs', () => {
    const { registry } = setUp();
    registry.registerPolicyPack(POLICY_WRITER, buildPackInput());
    registry.registerPolicyPackVersion(POLICY_WRITER, buildVersionInput());
    assert.equal(registry.listActivePacks().length, 0);
    registry.activatePolicyPackVersion(POLICY_WRITER, 'pack-1-v1');
    assert.equal(registry.listActivePacks().length, 1);
    assert.equal(registry.listActiveVersions().length, 1);
  });

  it('10. records lifecycle events', () => {
    const { registry, ledger } = setUp();
    registry.registerPolicyPack(POLICY_WRITER, buildPackInput());
    registry.registerPolicyPackVersion(POLICY_WRITER, buildVersionInput());
    registry.activatePolicyPackVersion(POLICY_WRITER, 'pack-1-v1');
    registry.deprecatePolicyPackVersion(POLICY_WRITER, 'pack-1-v1');
    const types = ledger.getEvents().map((event) => event.type);
    assert.deepEqual(types, [
      'policy_pack_registered',
      'policy_pack_version_activated',
      'policy_pack_version_deprecated',
    ]);
  });
});
