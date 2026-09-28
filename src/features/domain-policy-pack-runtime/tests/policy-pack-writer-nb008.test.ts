import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { PolicyPackWriterContext } from '../domain/policy-pack-writer.js';
import { PAYMENTS_BASIC_POLICY_PACK, PAYMENTS_BASIC_POLICY_PACK_VERSION_V1 } from '../packs/payments-basic.policy-pack.js';
import { createPolicyPackRuntimeContext } from '../runtime/policy-pack-runtime-context.js';
import { PolicyPackWriteRefusedError } from '../runtime/policy-pack-runtime-errors.js';
import { PolicyPackStore } from '../services/policy-pack-store.js';
import { createPolicyPackRuntime, type PolicyPackRuntime } from '../services/policy-pack-runtime.js';

/**
 * NB-008 — closed by CORE-03. Policy-pack writes determine the authority every
 * bounded grant is minted under, so:
 *
 * 1. every write requires a trusted writer context (`system: true` + an
 *    operator identity) and is refused without one, changing nothing;
 * 2. the writer is recorded on the pack, the version and every lifecycle
 *    event;
 * 3. the runtime exposes no write path around that gate — its store is a
 *    frozen read-only facade and its registry is private;
 * 4. `freeze` makes policy read-only for the rest of the process.
 */

const NOW = '2026-01-01T00:00:00.000Z';
const OPERATOR: PolicyPackWriterContext = { system: true, actorId: 'operator:policy-admin' };
const SECOND: PolicyPackWriterContext = { system: true, actorId: 'operator:security-lead' };

function runtime(): PolicyPackRuntime {
  return createPolicyPackRuntime(createPolicyPackRuntimeContext(NOW));
}

function refusedWith(code: 'POLICY_PACK_WRITER_REQUIRED' | 'POLICY_PACK_REGISTRY_FROZEN', run: () => unknown, why: string): void {
  assert.throws(run, (error: unknown) => error instanceof PolicyPackWriteRefusedError && error.code === code, why);
}

describe('NB-008 — a policy-pack write without a trusted writer is refused and changes nothing', () => {
  const forged: readonly [string, unknown][] = [
    ['no writer', undefined],
    ['null', null],
    ['system false', { system: false, actorId: 'operator:x' }],
    ['system as a truthy string', { system: 'true', actorId: 'operator:x' }],
    ['no identity', { system: true }],
    ['an empty identity', { system: true, actorId: '' }],
    ['a whitespace-padded identity', { system: true, actorId: ' operator:x' }],
    ['a control character', { system: true, actorId: 'operator:x\u0000' }],
    ['an array', [true, 'operator:x']],
  ];
  for (const [name, writer] of forged) {
    it(`register / version / activate refuse ${name}`, () => {
      const policy = runtime();
      refusedWith('POLICY_PACK_WRITER_REQUIRED', () => policy.registerPolicyPack(writer as PolicyPackWriterContext, PAYMENTS_BASIC_POLICY_PACK), name);
      assert.equal(policy.store.listPacks().length, 0, 'nothing registered');
      policy.registerPolicyPack(OPERATOR, PAYMENTS_BASIC_POLICY_PACK);
      refusedWith('POLICY_PACK_WRITER_REQUIRED', () => policy.registerPolicyPackVersion(writer as PolicyPackWriterContext, PAYMENTS_BASIC_POLICY_PACK_VERSION_V1), name);
      assert.equal(policy.store.listVersions().length, 0, 'no version registered');
      policy.registerPolicyPackVersion(OPERATOR, PAYMENTS_BASIC_POLICY_PACK_VERSION_V1);
      refusedWith('POLICY_PACK_WRITER_REQUIRED', () => policy.activatePolicyPackVersion(writer as PolicyPackWriterContext, PAYMENTS_BASIC_POLICY_PACK_VERSION_V1.id), name);
      assert.equal(policy.store.getVersion(PAYMENTS_BASIC_POLICY_PACK_VERSION_V1.id)?.status, 'draft', 'not activated');
    });
  }
});

describe('NB-008 — the operator identity is recorded on every mutation', () => {
  it('pack, version and lifecycle events carry the writer who changed them', () => {
    const policy = runtime();
    policy.registerPolicyPack(OPERATOR, PAYMENTS_BASIC_POLICY_PACK);
    policy.registerPolicyPackVersion(OPERATOR, PAYMENTS_BASIC_POLICY_PACK_VERSION_V1);
    policy.activatePolicyPackVersion(SECOND, PAYMENTS_BASIC_POLICY_PACK_VERSION_V1.id);

    const pack = policy.store.getPack(PAYMENTS_BASIC_POLICY_PACK.id);
    assert.equal(pack?.registeredBy, OPERATOR.actorId);
    assert.equal(pack?.lastWrittenBy, SECOND.actorId, 'the activation is the latest change');
    const version = policy.store.getVersion(PAYMENTS_BASIC_POLICY_PACK_VERSION_V1.id);
    assert.equal(version?.registeredBy, OPERATOR.actorId);
    assert.equal(version?.statusChangedBy, SECOND.actorId);

    policy.deprecatePolicyPackVersion(OPERATOR, PAYMENTS_BASIC_POLICY_PACK_VERSION_V1.id);
    policy.revokePolicyPackVersion(SECOND, PAYMENTS_BASIC_POLICY_PACK_VERSION_V1.id);
    assert.equal(policy.store.getVersion(PAYMENTS_BASIC_POLICY_PACK_VERSION_V1.id)?.statusChangedBy, SECOND.actorId);

    const lifecycle = policy.store.getEvents().filter((event) => event.type.startsWith('policy_pack_'));
    assert.deepEqual(
      lifecycle.map((event) => [event.type, (event.payload as { actorId?: string }).actorId]),
      [
        ['policy_pack_registered', OPERATOR.actorId],
        ['policy_pack_version_activated', SECOND.actorId],
        ['policy_pack_version_deprecated', OPERATOR.actorId],
        ['policy_pack_version_revoked', SECOND.actorId],
      ],
    );
  });
});

describe('NB-008 — no write path around the gate', () => {
  it('the runtime store is a frozen, read-only facade and the registry is not reachable', () => {
    const policy = runtime();
    const store = policy.store as unknown as Record<string, unknown>;
    assert.equal(Object.isFrozen(policy.store), true);
    for (const method of ['savePack', 'saveVersion', 'updateVersionStatus', 'updatePackStatus', 'freezeAuthority']) {
      assert.equal(store[method], undefined, `runtime.store.${method} must not exist`);
    }
    assert.equal((policy as unknown as Record<string, unknown>)['registry'], undefined, 'no public registry');
    assert.deepEqual(
      Object.keys(policy).filter((key) => key !== 'ctx' && key !== 'evaluationService' && key !== 'simulationService').sort(),
      ['ledger', 'store'],
      'the only public state is the read facade and the append-only ledger',
    );
  });
});

describe('NB-008 — freeze: policy becomes read-only for the rest of the process', () => {
  it('after freeze every write is refused, reads and evaluation continue, and the freeze is attributed', () => {
    const policy = runtime();
    policy.registerPolicyPack(OPERATOR, PAYMENTS_BASIC_POLICY_PACK);
    policy.registerPolicyPackVersion(OPERATOR, PAYMENTS_BASIC_POLICY_PACK_VERSION_V1);
    policy.activatePolicyPackVersion(OPERATOR, PAYMENTS_BASIC_POLICY_PACK_VERSION_V1.id);
    refusedWith('POLICY_PACK_WRITER_REQUIRED', () => policy.freeze({ system: false } as unknown as PolicyPackWriterContext), 'freezing needs a writer too');
    policy.freeze(SECOND);
    assert.equal(policy.isFrozen(), true);

    refusedWith('POLICY_PACK_REGISTRY_FROZEN', () => policy.registerPolicyPack(OPERATOR, { ...PAYMENTS_BASIC_POLICY_PACK, id: 'another' }), 'register');
    refusedWith('POLICY_PACK_REGISTRY_FROZEN', () => policy.deprecatePolicyPackVersion(OPERATOR, PAYMENTS_BASIC_POLICY_PACK_VERSION_V1.id), 'deprecate');
    refusedWith('POLICY_PACK_REGISTRY_FROZEN', () => policy.revokePolicyPackVersion(OPERATOR, PAYMENTS_BASIC_POLICY_PACK_VERSION_V1.id), 'revoke');
    refusedWith('POLICY_PACK_REGISTRY_FROZEN', () => policy.freeze(OPERATOR), 'a second freeze');
    assert.equal(policy.store.getVersion(PAYMENTS_BASIC_POLICY_PACK_VERSION_V1.id)?.status, 'active', 'nothing changed');

    const frozen = policy.store.getEvents().find((event) => event.type === 'policy_pack_registry_frozen');
    assert.equal((frozen?.payload as { actorId?: string } | undefined)?.actorId, SECOND.actorId);
    const decision = policy.evaluatePolicy({ id: 'eval-after-freeze', trustDomainId: 'td', actorId: 'a', action: 'approve_payment', resourceScope: 'r', riskLevel: 'low', requestedAt: NOW, amount: '1', currency: 'USD', domain: 'payments' });
    assert.ok(decision.decision !== undefined, 'evaluation is unaffected by the freeze');
  });

  it('a frozen store refuses pack and version writes at its own boundary too', () => {
    const store = new PolicyPackStore();
    store.freezeAuthority();
    assert.throws(() => store.savePack({ id: 'p' } as never), PolicyPackWriteRefusedError);
    assert.throws(() => store.saveVersion({ id: 'v' } as never), PolicyPackWriteRefusedError);
    assert.throws(() => store.updateVersionStatus('v', 'active', NOW), PolicyPackWriteRefusedError);
  });
});
