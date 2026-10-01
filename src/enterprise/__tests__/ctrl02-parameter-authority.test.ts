import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { EnterpriseHttpError } from '../api/enterprise-http-errors.js';
import { createGovernanceProfileRegistry, type GovernanceConfiguration } from '../governance-profile/index.js';
import { grantAuthorityBindingDigest, type GrantAuthorityBinding } from '../execution-governance/authority-binding.js';
import { grantAuthorityProvenanceDigest } from '../execution-governance/financial-authority.js';
import { parameterAuthorityViolation, type ParameterAuthority } from '../execution-governance/parameter-authority.js';
import type { KernelAuthorityAccessContext, KernelAuthorityRecord, ProvisionAuthorityGrantInput } from '../kernel-authority/contracts.js';
import { createDurableKernelWorld } from '../kernel-authority/durable-kernel-providers.js';
import { KernelAuthorityError, isKernelAuthorityError } from '../kernel-authority/errors.js';
import { hydrateKernelAuthorityWorld } from '../kernel-authority/hydration.js';
import { createInMemoryKernelAuthorityStore } from '../kernel-authority/in-memory-kernel-authority-store.js';
import type { KernelAuthorityStore } from '../kernel-authority/kernel-authority-store.js';
import { createKernelParameterAuthorityResolver } from '../kernel-authority/parameter-authority-resolver.js';
import { createKernelAuthorityProvisioningService, type KernelAuthorityProvisioningService } from '../kernel-authority/provisioning-service.js';
import { createSqliteControlPlaneStore, replayProfileLifecycle, type ProfileLifecycleState } from '../operator-control/control-plane-store.js';
import { createOperatorAuthenticator } from '../operator-control/operator-authenticator.js';
import { createOperatorControlService } from '../operator-control/service.js';
import type { EnterpriseLogger } from '../telemetry/enterprise-logger.js';

/**
 * CTRL-02 pre-push hardening — standing typed-parameter authority below the
 * Host (durable validation, hydration, the resolver's lineage semantics,
 * containment and provenance), committed-refresh failure semantics, and the
 * Governance Profile state machine's concurrency and draft → retired edges.
 */

const ORG = 'org-pilot';
const TD = 'td-pilot';
const OP: KernelAuthorityAccessContext = { system: true, actorId: 'operator:test' };
const READ: KernelAuthorityAccessContext = { system: false, organizationId: ORG };
const MAX3 = { dimension: 'replicaCount', kind: 'maximum', type: 'integer', limit: 3 } as const;

function grant(id: string, extra: Partial<ProvisionAuthorityGrantInput> = {}): ProvisionAuthorityGrantInput {
  return {
    authorityGrantId: id,
    issuerActorId: 'actor-org',
    subjectActorId: 'actor-owner',
    trustDomainId: TD,
    capability: 'release.manage',
    actions: ['deploy-release'],
    resourceScopes: ['production-cluster'],
    ...extra,
  };
}

async function baseWorld(store: KernelAuthorityStore = createInMemoryKernelAuthorityStore(), onCommitted?: () => Promise<void>): Promise<{ store: KernelAuthorityStore; provisioning: KernelAuthorityProvisioningService }> {
  const provisioning = createKernelAuthorityProvisioningService({ store, organizationId: ORG, ...(onCommitted !== undefined ? { onCommitted } : {}) });
  await provisioning.provisionActor(OP, { actorId: 'actor-org', type: 'organization', displayName: 'Org' });
  await provisioning.provisionTrustDomain(OP, { trustDomainId: TD, name: 'TD', issuerActorId: 'actor-org', acceptedIssuerIds: ['actor-org'], acceptedActorTypes: ['human', 'agent', 'organization'] });
  await provisioning.provisionRootIssuer(OP, { trustDomainId: TD, actorId: 'actor-org' });
  await provisioning.provisionActor(OP, { actorId: 'actor-owner', type: 'human', displayName: 'Owner', issuerId: 'actor-org', trustDomainId: TD });
  return { store, provisioning };
}

async function refused(promise: Promise<unknown>, code: string): Promise<KernelAuthorityError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(isKernelAuthorityError(error), String(error));
    assert.equal(error.code, code, error.message);
    return error;
  }
  return assert.fail(`expected ${code}`);
}

describe('CTRL-02 — durable standing parameter authority: the canonical CORE-03 bound, validated on every append and every hydration', () => {
  it('a canonical exact or maximum bound is stored exactly; a record without one keeps its historical meaning', async () => {
    const { provisioning, store } = await baseWorld();
    const tokenExact = { dimension: 'deploymentStrategy', kind: 'exact', type: 'token', value: 'rolling' } as const;
    const boolExact = { dimension: 'canary', kind: 'exact', type: 'boolean', value: false } as const;
    const intExact = { dimension: 'shards', kind: 'exact', type: 'integer', value: 4 } as const;
    await provisioning.provisionAuthorityGrant(OP, grant('g-bounded', { parameterBounds: [boolExact, tokenExact, MAX3, intExact] }));
    await provisioning.provisionAuthorityGrant(OP, grant('g-open'));
    const bounded = await store.getRecord(READ, ORG, 'authority-grant', 'g-bounded');
    assert.deepEqual(bounded?.payload['parameterBounds'], [boolExact, tokenExact, MAX3, intExact]);
    const open = await store.getRecord(READ, ORG, 'authority-grant', 'g-open');
    assert.equal(Object.prototype.hasOwnProperty.call(open?.payload, 'parameterBounds'), false);
  });

  it('malformed, coerced, out-of-order, duplicated, accessor-bearing or misplaced bounds are refused before the append', async () => {
    const { provisioning } = await baseWorld();
    const getter = Object.defineProperty({ dimension: 'replicaCount', kind: 'maximum', type: 'integer' }, 'limit', { get: () => 3, enumerable: true });
    for (const [label, parameterBounds] of [
      ['string limit', [{ ...MAX3, limit: '3' }]],
      ['negative zero', [{ ...MAX3, limit: -0 }]],
      ['unsafe integer', [{ ...MAX3, limit: 2 ** 53 }]],
      ['float', [{ ...MAX3, limit: 2.5 }]],
      ['maximum over a token', [{ dimension: 'strategy', kind: 'maximum', type: 'token', limit: 3 }]],
      ['bad token', [{ dimension: 'strategy', kind: 'exact', type: 'token', value: 'a b' }]],
      ['boolean as string', [{ dimension: 'canary', kind: 'exact', type: 'boolean', value: 'false' }]],
      ['unknown kind', [{ dimension: 'replicaCount', kind: 'minimum', type: 'integer', limit: 1 }]],
      ['extra key', [{ ...MAX3, expression: 'x' }]],
      ['missing key', [{ dimension: 'replicaCount', kind: 'maximum', type: 'integer' }]],
      ['bad dimension id', [{ ...MAX3, dimension: 'replica count' }]],
      ['duplicate dimension', [MAX3, { ...MAX3, limit: 2 }]],
      ['out of order', [MAX3, { dimension: 'canary', kind: 'exact', type: 'boolean', value: true }]],
      ['empty', []],
      ['accessor', [getter]],
    ] as const) {
      await refused(provisioning.provisionAuthorityGrant(OP, grant(`g-${label.length}-${label[0]}`, { parameterBounds: parameterBounds as never })), 'KERNEL_AUTHORITY_VALIDATION_ERROR');
    }
    await provisioning.provisionActor(OP, { actorId: 'actor-agent', type: 'agent', displayName: 'Agent', issuerId: 'actor-org', trustDomainId: TD });
    await refused(
      provisioning.provisionPassport(OP, { passportId: 'p1', type: 'agent_passport', subjectActorId: 'actor-agent', issuerActorId: 'actor-org', trustDomainId: TD, parameterBounds: [MAX3] } as never),
      'KERNEL_AUTHORITY_VALIDATION_ERROR',
    );
  });

  it('hydration re-proves the bounds: a record carrying malformed parameter authority never replays into usable authority', () => {
    const record: KernelAuthorityRecord = {
      organizationId: ORG,
      entityKind: 'authority-grant',
      entityId: 'g-forged',
      trustDomainId: TD,
      status: 'active',
      payload: { ...grant('g-forged'), parameterBounds: [{ ...MAX3, limit: '999' }] },
      provisionedBy: 'operator:test',
      provisionedAt: '2026-10-01T00:00:00.000Z',
      latestSequence: 1,
      latestEventDigest: 'x',
    };
    assert.throws(() => hydrateKernelAuthorityWorld([record], { now: () => '2026-10-01T00:00:00.000Z', nextId: (prefix) => `${prefix}-1` }), (error: unknown) => isKernelAuthorityError(error) && error.code === 'KERNEL_AUTHORITY_INTEGRITY_FAILED');
  });
});

describe('CTRL-02 — the standing parameter-authority resolver follows the Authority Graph lineage, every hop applies, and it fails closed', () => {
  async function resolverFor(store: KernelAuthorityStore) {
    const world = await createDurableKernelWorld({ store, organizationId: ORG });
    return {
      world,
      resolve: createKernelParameterAuthorityResolver({ organizationId: ORG, trustDomainId: TD, authority: () => world.providerSet.authorityRuntime, records: () => world.service.records() }),
    };
  }
  const query = { phase: 'exercise' as const, subject: 'actor-owner', action: 'deploy-release', resourceScope: 'production-cluster', organizationId: ORG, at: '2026-10-01T00:00:00.000Z' };

  it('a world without any parameter bound is unbounded — exactly the behaviour before CTRL-02, even where no lineage resolves', async () => {
    const { store, provisioning } = await baseWorld();
    await provisioning.provisionAuthorityGrant(OP, grant('g-open'));
    const { resolve } = await resolverFor(store);
    assert.deepEqual(resolve(query), { kind: 'unbounded' });
    assert.deepEqual(resolve({ ...query, subject: 'actor-nobody' }), { kind: 'unbounded' });
  });

  it('once parameter authority exists, an unresolvable lineage is unresolved — never unbounded', async () => {
    const { store, provisioning } = await baseWorld();
    await provisioning.provisionAuthorityGrant(OP, grant('g-bounded', { parameterBounds: [MAX3] }));
    const { resolve } = await resolverFor(store);
    assert.equal(resolve({ ...query, subject: 'actor-nobody' }).kind, 'unresolved');
    assert.equal(resolve({ ...query, organizationId: 'org-other' }).kind, 'unresolved');
    const bounded = resolve(query);
    assert.equal(bounded.kind, 'bounded');
  });

  it('independent grants are not intersected and not searched: the Authority Graph’s deterministic lineage (first matching grant, by id) alone applies', async () => {
    const { store, provisioning } = await baseWorld();
    await provisioning.provisionAuthorityGrant(OP, grant('g1-tight', { parameterBounds: [MAX3] }));
    await provisioning.provisionAuthorityGrant(OP, grant('g2-loose', { parameterBounds: [{ ...MAX3, limit: 10 }] }));
    const { resolve } = await resolverFor(store);
    const resolution = resolve(query);
    assert.equal(resolution.kind, 'bounded');
    if (resolution.kind !== 'bounded') return;
    assert.deepEqual(resolution.authority.lineage, ['authority-grant:g1-tight']);
    assert.equal(parameterAuthorityViolation(resolution.authority, [{ dimension: 'replicaCount', type: 'integer', value: 5 }]), 'PARAMETER_AUTHORITY_EXCEEDED', 'the looser alternative is not searched for');
  });

  it('every hop of a delegated lineage applies — a delegate that dropped or widened a bound in-process still cannot exceed its source', async () => {
    const { store, provisioning } = await baseWorld();
    await provisioning.provisionActor(OP, { actorId: 'actor-agent', type: 'agent', displayName: 'Agent', issuerId: 'actor-org', trustDomainId: TD });
    await provisioning.provisionAuthorityGrant(OP, grant('g-src', { parameterBounds: [MAX3], canDelegate: true, allowedDelegateActorTypes: ['agent'], maxDelegationDepth: 1 }));
    // Provisioned in-process (no operator-plane attenuation check): the delegate states a wider bound.
    await provisioning.provisionDelegationGrant(OP, {
      delegationGrantId: 'd-wide',
      delegatorActorId: 'actor-owner',
      delegateActorId: 'actor-agent',
      delegateActorType: 'agent',
      trustDomainId: TD,
      sourceAuthorityGrantId: 'g-src',
      capability: 'release.execute',
      actions: ['deploy-release'],
      resourceScopes: ['production-cluster'],
      parameterBounds: [{ ...MAX3, limit: 50 }],
    });
    const { resolve } = await resolverFor(store);
    const resolution = resolve({ ...query, subject: 'actor-agent' });
    assert.equal(resolution.kind, 'bounded');
    if (resolution.kind !== 'bounded') return;
    assert.deepEqual(resolution.authority.lineage, ['delegation-grant:d-wide', 'authority-grant:g-src']);
    assert.equal(parameterAuthorityViolation(resolution.authority, [{ dimension: 'replicaCount', type: 'integer', value: 4 }]), 'PARAMETER_AUTHORITY_EXCEEDED');
    assert.equal(parameterAuthorityViolation(resolution.authority, [{ dimension: 'replicaCount', type: 'integer', value: 3 }]), undefined);
  });

  it('an expired hop makes bounded authority inactive', async () => {
    const { store, provisioning } = await baseWorld();
    await provisioning.provisionAuthorityGrant(OP, grant('g-expired', { parameterBounds: [MAX3], expiresAt: '2026-01-01T00:00:00.000Z' }));
    const { resolve } = await resolverFor(store);
    assert.deepEqual(resolve(query), { kind: 'unresolved', reasonCode: 'PARAMETER_AUTHORITY_INACTIVE' });
  });
});

describe('CTRL-02 — containment and provenance use the one CORE-03 algebra', () => {
  const authority: ParameterAuthority = {
    organizationId: ORG,
    trustDomainId: TD,
    subject: 'actor-agent',
    lineage: ['authority-grant:g'],
    bounds: [
      { ref: 'authority-grant:g', dimension: 'deploymentStrategy', bound: { kind: 'exact', type: 'token', value: 'rolling' } },
      { ref: 'authority-grant:g', dimension: 'replicaCount', bound: { kind: 'maximum', type: 'integer', limit: 3 } },
    ],
  };
  const rolling = { dimension: 'deploymentStrategy', type: 'token', value: 'rolling' } as const;

  it('maximum admits ≤ limit; exact admits the value only; no coercion; an unstated bounded dimension is required', () => {
    assert.equal(parameterAuthorityViolation(authority, [rolling, { dimension: 'replicaCount', type: 'integer', value: 3 }]), undefined);
    assert.equal(parameterAuthorityViolation(authority, [rolling, { dimension: 'replicaCount', type: 'integer', value: 4 }]), 'PARAMETER_AUTHORITY_EXCEEDED');
    assert.equal(parameterAuthorityViolation(authority, [rolling, { dimension: 'replicaCount', type: 'token', value: '3' } as never]), 'PARAMETER_AUTHORITY_EXCEEDED');
    assert.equal(parameterAuthorityViolation(authority, [{ ...rolling, value: 'blue-green' }, { dimension: 'replicaCount', type: 'integer', value: 1 }]), 'PARAMETER_AUTHORITY_EXCEEDED');
    assert.equal(parameterAuthorityViolation(authority, [rolling]), 'PARAMETER_AUTHORITY_VALUE_REQUIRED');
    assert.equal(parameterAuthorityViolation(authority, undefined), 'PARAMETER_AUTHORITY_VALUE_REQUIRED');
  });

  it('a grant without parameter authority keeps its byte-identical provenance digest; with it, the digest commits to the lineage and its bounds', () => {
    const binding: GrantAuthorityBinding = { kind: 'no-temporal-authority-bound', sourceKind: 'organizational-authority', justification: 'test' };
    assert.equal(grantAuthorityProvenanceDigest(binding, undefined), grantAuthorityBindingDigest(binding));
    assert.equal(grantAuthorityProvenanceDigest(binding, undefined, undefined), grantAuthorityBindingDigest(binding));
    const bounded = grantAuthorityProvenanceDigest(binding, undefined, authority);
    assert.notEqual(bounded, grantAuthorityBindingDigest(binding));
    const narrower = { ...authority, bounds: [authority.bounds[0], { ...authority.bounds[1], bound: { kind: 'maximum', type: 'integer', limit: 2 } }] } as ParameterAuthority;
    assert.notEqual(grantAuthorityProvenanceDigest(binding, undefined, narrower), bounded, 'a changed standing bound is a changed provenance');
    assert.notEqual(grantAuthorityProvenanceDigest(binding, undefined, { ...authority, lineage: ['authority-grant:other'], bounds: authority.bounds.map((entry) => ({ ...entry, ref: 'authority-grant:other' })) }), bounded, 're-lineaged is changed');
  });
});

describe('CTRL-02 — a committed write whose refresh fails is reported as committed, the projection fails closed, and the same request recovers', () => {
  it('the provisioning service: committed + REFRESH_FAILED; the same request replays and refreshes; a different body conflicts', async () => {
    let failNext = false;
    let refreshes = 0;
    const store = createInMemoryKernelAuthorityStore();
    const { provisioning } = await baseWorld(store, async () => {
      refreshes += 1;
      if (failNext) {
        failNext = false;
        throw new Error('simulated reload failure');
      }
    });
    failNext = true;
    const error = await refused(provisioning.provisionAuthorityGrant(OP, grant('g-committed'), { idempotency: { idempotencyKey: 'commit-0001' } }), 'KERNEL_AUTHORITY_REFRESH_FAILED');
    assert.equal(error.details?.['committed'], true);
    assert.equal((await store.getRecord(READ, ORG, 'authority-grant', 'g-committed'))?.status, 'active', 'the event is committed');
    const before = refreshes;
    const retry = await provisioning.provisionAuthorityGrant(OP, grant('g-committed'), { idempotency: { idempotencyKey: 'commit-0001' } });
    assert.equal(retry.replayed, true);
    assert.equal(refreshes, before + 1, 'the replay refreshed, because the last refresh had failed');
    await refused(provisioning.provisionAuthorityGrant(OP, grant('g-other'), { idempotency: { idempotencyKey: 'commit-0001' } }), 'KERNEL_AUTHORITY_IDEMPOTENCY_CONFLICT');
    // Once healthy, a replay no longer refreshes.
    const after = refreshes;
    await provisioning.provisionAuthorityGrant(OP, grant('g-committed'), { idempotency: { idempotencyKey: 'commit-0001' } });
    assert.equal(refreshes, after);
  });

  it('the durable world: a reload that fails leaves a deny-all projection, never the previous one', async () => {
    const base = createInMemoryKernelAuthorityStore();
    const { provisioning } = await baseWorld(base);
    await provisioning.provisionAuthorityGrant(OP, grant('g-live'));
    let failing = false;
    const store: KernelAuthorityStore = { ...base, listRecords: (context, query) => (failing ? Promise.reject(new Error('unavailable')) : base.listRecords(context, query)) };
    const world = await createDurableKernelWorld({ store, organizationId: ORG });
    assert.ok(world.service.records().length > 0);
    failing = true;
    await assert.rejects(world.service.reload());
    assert.equal(world.service.records().length, 0, 'fail closed: nothing is authorized until a reload succeeds');
    failing = false;
    await world.service.reload();
    assert.ok(world.service.records().length > 0);
  });

  it('the operator plane answers 503 AUTHORITY_STATE_REFRESH_FAILED with recorded: true — never “nothing was written” — and audits it as committed', async () => {
    let failNext = false;
    const store = createInMemoryKernelAuthorityStore();
    const { provisioning } = await baseWorld(store, async () => {
      if (failNext) {
        failNext = false;
        throw new Error('simulated');
      }
    });
    const logs: string[] = [];
    const logger: EnterpriseLogger = { debug: () => {}, info: (message, fields) => logs.push(JSON.stringify({ message, fields })), warn: () => {}, error: () => {} };
    const authenticator = createOperatorAuthenticator({ administrators: [], operators: [{ operatorId: 'ops-p', role: 'provisioner', key: 'provisioner-secret-0123456789abcdef0123456' }], ordinaryCredentials: [], organizationId: ORG, isReady: () => true, lifecycleState: () => 'ready' });
    const service = createOperatorControlService({
      authenticator,
      organizationId: ORG,
      now: () => '2026-10-01T00:00:00.000Z',
      logger,
      kernelAuthority: { store, provisioning },
      staticCustomerSubjects: [],
      governance: createGovernanceProfileRegistry(undefined),
    });
    const body = { actorId: 'actor-new', type: 'human', displayName: 'New', issuerId: 'actor-org', trustDomainId: TD, idempotencyKey: 'refresh-actor-0001' };
    failNext = true;
    let error: unknown;
    try {
      await service.provisionAuthorityEntity('Bearer provisioner-secret-0123456789abcdef0123456', 'actor', async () => body);
    } catch (caught) {
      error = caught;
    }
    assert.ok(error instanceof EnterpriseHttpError);
    assert.equal(error.httpStatus, 503);
    assert.equal(error.code, 'AUTHORITY_STATE_REFRESH_FAILED');
    assert.equal((error.extra as Record<string, unknown>)['recorded'], true);
    assert.equal(/nothing was (written|read or changed)/i.test(error.message), false);
    assert.ok(logs.some((line) => line.includes('committed-refresh-failed')));
    const retry = await service.provisionAuthorityEntity('Bearer provisioner-secret-0123456789abcdef0123456', 'actor', async () => body);
    assert.equal(retry.outcome, 'replayed');
  });
});

describe('CTRL-02 — Governance Profile catalog-backed lifecycle: the remaining state-machine edges', () => {
  const GOVERNANCE: GovernanceConfiguration = {
    actionClasses: [{ id: 'deploy', actions: ['deploy-release'] }],
    resourceClasses: [{ id: 'production', resources: ['production-cluster'] }],
    profiles: [1, 2].map((version) => ({
      profileId: 'deploy-production',
      version,
      owner: ORG,
      provenance: { authoredBy: 'platform-team', approvedBy: 'change-board' },
      actionClass: 'deploy',
      resourceClass: 'production',
      parameters: [],
      materialFacts: [],
      relevantPolicies: [`policy-v${version}`],
    })),
  };

  async function lifecycle() {
    const controlPlane = await createSqliteControlPlaneStore(':memory:');
    let state: ProfileLifecycleState = replayProfileLifecycle([]);
    const registry = createGovernanceProfileRegistry(GOVERNANCE, { lifecycle: { activeVersion: (id: string) => state.active.get(id) } });
    const authenticator = createOperatorAuthenticator({ administrators: [], operators: [{ operatorId: 'ops-s', role: 'profile-steward', key: 'steward-secret-0123456789abcdef01234567' }], ordinaryCredentials: [], organizationId: ORG, isReady: () => true, lifecycleState: () => 'ready' });
    let failReload = false;
    const service = createOperatorControlService({
      authenticator,
      organizationId: ORG,
      now: () => '2026-10-01T00:00:00.000Z',
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      kernelAuthority: { store: createInMemoryKernelAuthorityStore(), provisioning: createKernelAuthorityProvisioningService({ store: createInMemoryKernelAuthorityStore(), organizationId: ORG }) },
      controlPlane,
      staticCustomerSubjects: [],
      governance: registry,
      profileLifecycle: {
        reload: async () => {
          if (failReload) {
            failReload = false;
            state = replayProfileLifecycle([]);
            throw new Error('simulated');
          }
          state = replayProfileLifecycle(await controlPlane.listProfileLifecycleEvents(ORG));
        },
      },
    });
    const digest = (version: number): string => registry.profiles.find((profile) => profile.reference.version === version)?.reference.digest ?? '';
    const auth = 'Bearer steward-secret-0123456789abcdef01234567';
    return { service, registry, controlPlane, digest, auth, state: () => state, failNextReload: () => (failReload = true) };
  }

  it('concurrent activation of two versions: exactly one ends active, the history stays legal, and at no point are two active', async () => {
    const h = await lifecycle();
    const results = await Promise.allSettled([1, 2, 1, 2].map((version) => h.service.transitionGovernanceProfile(h.auth, 'deploy-production', String(version), 'activate', async () => ({ digest: h.digest(version) }))));
    const events = await h.controlPlane.listProfileLifecycleEvents(ORG);
    const replayed = replayProfileLifecycle(events);
    assert.equal(replayed.active.size, 1, 'one profile id, one active version');
    for (let index = 1; index <= events.length; index += 1) {
      const prefix = replayProfileLifecycle(events.slice(0, index));
      assert.ok(prefix.active.size <= 1);
    }
    assert.ok(results.every((result) => result.status === 'fulfilled' || (result.reason as EnterpriseHttpError).httpStatus === 409), 'a losing activation of a superseded version is refused (retired is terminal), never applied');
    assert.equal(h.registry.resolve('deploy-release', 'production-cluster').kind, 'resolved');
  });

  it('draft → retired is legal: a catalog version withdrawn before activation is retired, terminal, and never activatable', async () => {
    const h = await lifecycle();
    const retired = await h.service.transitionGovernanceProfile(h.auth, 'deploy-production', '1', 'retire', async () => ({ digest: h.digest(1), reason: 'withdrawn draft' }));
    assert.equal(retired.outcome, 'retired');
    assert.equal(retired.profile.state, 'retired');
    await assert.rejects(h.service.transitionGovernanceProfile(h.auth, 'deploy-production', '1', 'activate', async () => ({ digest: h.digest(1) })), (error: unknown) => error instanceof EnterpriseHttpError && error.httpStatus === 409);
    assert.equal(h.registry.resolve('deploy-release', 'production-cluster').kind, 'refused');
  });

  it('a lifecycle reload that fails after a recorded transition is reported as recorded, resolves nothing meanwhile, and the same request recovers', async () => {
    const h = await lifecycle();
    h.failNextReload();
    await assert.rejects(
      h.service.transitionGovernanceProfile(h.auth, 'deploy-production', '1', 'activate', async () => ({ digest: h.digest(1) })),
      (error: unknown) => error instanceof EnterpriseHttpError && error.code === 'AUTHORITY_STATE_REFRESH_FAILED' && (error.extra as Record<string, unknown>)['recorded'] === true,
    );
    assert.equal(h.registry.resolve('deploy-release', 'production-cluster').kind, 'refused', 'fails closed: nothing resolves');
    const retry = await h.service.transitionGovernanceProfile(h.auth, 'deploy-production', '1', 'activate', async () => ({ digest: h.digest(1) }));
    assert.equal(retry.outcome, 'already-active');
    assert.equal(h.registry.resolve('deploy-release', 'production-cluster').kind, 'resolved', 'the replay refreshed the view');
  });
});
