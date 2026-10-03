import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createEnterprise } from '../composition/composition-root.js';
import { loadEnterpriseConfiguration } from '../configuration/enterprise-configuration.js';
import { createInMemoryKernelAuthorityStore } from '../kernel-authority/in-memory-kernel-authority-store.js';
import { KERNEL_AUTHORITY_MODULE_ID } from '../modules/kernel-authority-module.js';
import { KernelAuthorityError } from '../kernel-authority/errors.js';
import {
  DURABLE_FIXTURE_OPERATOR,
  DURABLE_FIXTURE_ORGANIZATION_ID,
  DURABLE_FIXTURE_OTHER_ACTION,
  buildDurableFixtureRequest,
  provisionDurableAuthorityFixture,
} from '../kernel-authority/fixtures/durable-authority.fixture.js';
import { buildTestKernelProviders } from './support.js';
import type { AocEnterprise } from '../composition/composition-root.js';

const tempDirs: string[] = [];
const instances: AocEnterprise[] = [];
after(async () => {
  await Promise.all(instances.map((instance) => instance.close().catch(() => {})));
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'aoc-kernel-authority-composition-'));
  tempDirs.push(dir);
  return dir;
}

function baseEnv(dir: string, overrides: Record<string, string> = {}): Record<string, string> {
  return {
    AOC_ENTERPRISE_ENV: 'test',
    AOC_ENTERPRISE_PERSISTENCE_PROVIDER: 'sqlite',
    AOC_ENTERPRISE_SQLITE_PATH: join(dir, 'governance.sqlite'),
    AOC_ENTERPRISE_PASSPORT_SQLITE_PATH: join(dir, 'passport.sqlite'),
    AOC_ENTERPRISE_ASSURANCE_SQLITE_PATH: join(dir, 'assurance.sqlite'),
    AOC_ENTERPRISE_EVIDENCE_SQLITE_PATH: join(dir, 'evidence-bundles.sqlite'),
    AOC_ENTERPRISE_KERNEL_AUTHORITY_SQLITE_PATH: join(dir, 'kernel-authority.sqlite'),
    ...overrides,
  };
}

async function track(instance: Promise<AocEnterprise>): Promise<AocEnterprise> {
  const resolved = await instance;
  instances.push(resolved);
  return resolved;
}

describe('Kernel Authority composition: opt-in, additive, fail-closed', () => {
  it('composes no authority store and no provisioning surface when the deployment has not configured one', async () => {
    const app = await track(createEnterprise({ configuration: loadEnterpriseConfiguration(baseEnv(tempDir())) }));

    assert.equal(app.kernelAuthorityStore, undefined);
    assert.equal(app.kernelAuthorityProvisioning, undefined);
    assert.equal(
      app.modules().some((module) => module.id === KERNEL_AUTHORITY_MODULE_ID),
      false,
      'an unconfigured deployment must not gain a module it did not ask for',
    );
    assert.equal(app.isReady(), true);
  });

  it('registers the authority module as required and reports ready once it is healthy', async () => {
    const dir = tempDir();
    const app = await track(
      createEnterprise({
        configuration: loadEnterpriseConfiguration(
          baseEnv(dir, { AOC_ENTERPRISE_KERNEL_AUTHORITY_ENABLED: 'true', AOC_ENTERPRISE_KERNEL_AUTHORITY_ORGANIZATION_ID: DURABLE_FIXTURE_ORGANIZATION_ID }),
        ),
      }),
    );

    const module = app.modules().find((entry) => entry.id === KERNEL_AUTHORITY_MODULE_ID);
    assert.ok(module, 'the authority module must be registered when the deployment configures it');
    assert.equal(module.required, true, 'authority source-of-truth defaults to required, not gracefully degrading');
    assert.equal(module.state, 'ready');
    assert.equal(app.isReady(), true);
    assert.ok(app.kernelAuthorityStore);
    assert.ok(app.kernelAuthorityProvisioning);
    assert.equal(app.kernelAuthorityProvisioning.organizationId, DURABLE_FIXTURE_ORGANIZATION_ID);
  });

  it('evaluates through the durable world it restored, and reports it as such in health', async () => {
    const dir = tempDir();
    const configuration = loadEnterpriseConfiguration(
      baseEnv(dir, { AOC_ENTERPRISE_KERNEL_AUTHORITY_ENABLED: 'true', AOC_ENTERPRISE_KERNEL_AUTHORITY_ORGANIZATION_ID: DURABLE_FIXTURE_ORGANIZATION_ID }),
    );

    const first = await track(createEnterprise({ configuration }));
    const provisioning = first.kernelAuthorityProvisioning;
    assert.ok(provisioning);
    const ids = await provisionDurableAuthorityFixture(provisioning);

    const allowed = await first.kernel.evaluate(buildDurableFixtureRequest(ids, { requestId: 'req-composition-allowed' }));
    assert.equal(allowed.status, 'allowed');

    const health = await first.health();
    const moduleHealth = health.modules?.[KERNEL_AUTHORITY_MODULE_ID];
    assert.equal(moduleHealth?.health.details?.durable, true);
    assert.equal(moduleHealth?.health.details?.provider, 'sqlite');
    assert.equal(moduleHealth?.required, true);
    // Shape and counts only -- never an actor id or a resource scope.
    assert.equal(JSON.stringify(health).includes(ids.agentActorId), false);
    assert.equal(JSON.stringify(health).includes(ids.resourceScope), false);

    // --- A second Enterprise instance over the same durable configuration,
    // provisioning nothing at all. -------------------------------------------
    await first.close();
    const second = await track(createEnterprise({ configuration }));

    const restored = await second.kernel.evaluate(buildDurableFixtureRequest(ids, { requestId: 'req-composition-restored' }));
    assert.equal(restored.status, 'allowed', 'a restarted Host must restore the operator-provisioned world without re-seeding');

    const deniedAction = await second.kernel.evaluate(
      buildDurableFixtureRequest(ids, { requestId: 'req-composition-wrong-action', action: DURABLE_FIXTURE_OTHER_ACTION }),
    );
    assert.equal(deniedAction.status, 'denied');
  });

  it('never lets an explicitly-injected provider set be silently replaced by the durable path', async () => {
    const store = createInMemoryKernelAuthorityStore();
    const injected = buildTestKernelProviders();
    const app = await track(
      createEnterprise({
        configuration: loadEnterpriseConfiguration(baseEnv(tempDir())),
        kernelAuthorityStore: store,
        kernelProviders: injected,
      }),
    );

    assert.equal(app.kernelProviders, injected, 'an explicitly-supplied provider set wins outright');
    assert.ok(app.kernelAuthorityProvisioning, 'the operator surface is still composed over the supplied store');
  });

  it('refuses to start when a configured SQLite authority source cannot be opened, rather than substituting an empty world', async () => {
    const dir = tempDir();
    // A path that is a directory, so SQLite cannot open it as a database.
    await assert.rejects(
      () =>
        createEnterprise({
          configuration: loadEnterpriseConfiguration(
            baseEnv(dir, { AOC_ENTERPRISE_KERNEL_AUTHORITY_ENABLED: 'true', AOC_ENTERPRISE_KERNEL_AUTHORITY_SQLITE_PATH: dir }),
          ),
        }),
      (error: unknown) => error instanceof Error,
    );
  });

  it('does not expose an operator context anywhere on the evaluation path', async () => {
    const dir = tempDir();
    const app = await track(
      createEnterprise({
        configuration: loadEnterpriseConfiguration(
          baseEnv(dir, { AOC_ENTERPRISE_KERNEL_AUTHORITY_ENABLED: 'true', AOC_ENTERPRISE_KERNEL_AUTHORITY_ORGANIZATION_ID: DURABLE_FIXTURE_ORGANIZATION_ID }),
        ),
      }),
    );
    const provisioning = app.kernelAuthorityProvisioning;
    assert.ok(provisioning);
    await provisionDurableAuthorityFixture(provisioning);

    // The store handle is reachable from an embedder, but writing through it
    // still demands an operator context the evaluation path never has.
    const store = app.kernelAuthorityStore;
    assert.ok(store);
    await assert.rejects(
      () =>
        store.appendEvent(
          { system: false, organizationId: DURABLE_FIXTURE_ORGANIZATION_ID, actorId: 'actor-alice' },
          {
            organizationId: DURABLE_FIXTURE_ORGANIZATION_ID,
            entityKind: 'actor',
            entityId: 'actor-mallory',
            eventType: 'KernelAuthorityEntityProvisioned',
            payload: { actorId: 'actor-mallory', type: 'human', displayName: 'Mallory' },
          },
        ),
      (error: unknown) => error instanceof KernelAuthorityError && error.code === 'KERNEL_AUTHORITY_OPERATOR_CONTEXT_REQUIRED',
    );
  });

  it('degrades instead of refusing to start when the configured authority module is optional', async () => {
    const dir = tempDir();
    // A path that is a directory, so the store cannot be opened at all.
    const app = await track(
      createEnterprise({
        configuration: loadEnterpriseConfiguration(
          baseEnv(dir, {
            AOC_ENTERPRISE_KERNEL_AUTHORITY_ENABLED: 'true',
            AOC_ENTERPRISE_KERNEL_AUTHORITY_REQUIRED: 'false',
            AOC_ENTERPRISE_KERNEL_AUTHORITY_SQLITE_PATH: dir,
          }),
        ),
      }),
    );

    // Declaring the module optional has to mean something: the Host comes up,
    // and the world it evaluates against is the empty fail-closed one rather
    // than a stale or invented substitute.
    assert.equal(app.isLive(), true);
    const request = {
      requestId: 'req-degraded',
      actor: { id: 'actor-alice', trustDomainId: 'trust-domain-acme', type: 'human' },
      action: { type: 'execute.material-action', resourceScope: 'resource-project-1' },
      organization: { id: DURABLE_FIXTURE_ORGANIZATION_ID },
      requestedAt: '2026-01-01T00:00:00.000Z',
    };
    assert.equal((await app.kernel.evaluate(request)).status, 'denied', 'a degraded authority source must deny, never allow');
  });

  it('still refuses to start when the authority module is required and its store cannot be opened', async () => {
    const dir = tempDir();
    await assert.rejects(
      () =>
        createEnterprise({
          configuration: loadEnterpriseConfiguration(
            baseEnv(dir, {
              AOC_ENTERPRISE_KERNEL_AUTHORITY_ENABLED: 'true',
              AOC_ENTERPRISE_KERNEL_AUTHORITY_REQUIRED: 'true',
              AOC_ENTERPRISE_KERNEL_AUTHORITY_SQLITE_PATH: dir,
            }),
          ),
        }),
      (error: unknown) => error instanceof Error,
    );
  });

  it('closes the authority store on shutdown', async () => {
    const store = createInMemoryKernelAuthorityStore();
    const app = await createEnterprise({ configuration: loadEnterpriseConfiguration(baseEnv(tempDir())), kernelAuthorityStore: store });
    assert.equal((await store.health()).status, 'healthy');
    await app.close();
    assert.equal((await store.health()).status, 'unhealthy');
  });

  it('records the durable provenance of the world in persisted governance context', async () => {
    const dir = tempDir();
    const app = await track(
      createEnterprise({
        configuration: loadEnterpriseConfiguration(
          baseEnv(dir, { AOC_ENTERPRISE_KERNEL_AUTHORITY_ENABLED: 'true', AOC_ENTERPRISE_KERNEL_AUTHORITY_ORGANIZATION_ID: DURABLE_FIXTURE_ORGANIZATION_ID }),
        ),
      }),
    );
    const provisioning = app.kernelAuthorityProvisioning;
    assert.ok(provisioning);
    const ids = await provisionDurableAuthorityFixture(provisioning);

    await app.evaluate({
      requestId: 'req-composition-provenance',
      actor: { id: ids.agentActorId, principalId: ids.ownerActorId, trustDomainId: ids.trustDomainId },
      action: { type: ids.action, resourceScope: ids.resourceScope, capability: ids.capability },
      organization: { id: ids.organizationId },
    });

    const record = await app.persistence.getByRequestId({ system: true }, 'req-composition-provenance');
    assert.ok(record);
    const providers = record.metadata.providerSnapshot ?? [];
    assert.equal(
      providers.some((provider) => provider.providerType === 'recognition-durable'),
      true,
      'a decision made against a durable world must say so in its persisted context',
    );
  });

  it('records an immutable operator audit trail for every provisioning action', async () => {
    const dir = tempDir();
    const app = await track(
      createEnterprise({
        configuration: loadEnterpriseConfiguration(
          baseEnv(dir, { AOC_ENTERPRISE_KERNEL_AUTHORITY_ENABLED: 'true', AOC_ENTERPRISE_KERNEL_AUTHORITY_ORGANIZATION_ID: DURABLE_FIXTURE_ORGANIZATION_ID }),
        ),
      }),
    );
    const provisioning = app.kernelAuthorityProvisioning;
    assert.ok(provisioning);
    const ids = await provisionDurableAuthorityFixture(provisioning);
    await provisioning.revoke(DURABLE_FIXTURE_OPERATOR, { entityKind: 'capability-token', entityId: ids.capabilityTokenId, reason: 'rotated out' });

    const events = await provisioning.listEvents(DURABLE_FIXTURE_OPERATOR, 'capability-token', ids.capabilityTokenId);
    assert.equal(events.length, 2);

    const [provisioned, revoked] = events;
    assert.equal(provisioned?.eventType, 'KernelAuthorityEntityProvisioned');
    assert.equal(provisioned?.provisionedBy, DURABLE_FIXTURE_OPERATOR.actorId);
    assert.equal(provisioned?.previousEventDigest, undefined);
    assert.deepEqual((provisioned?.payload as { actions?: readonly string[] }).actions, [ids.action], 'the trail records what authority scope was granted');

    assert.equal(revoked?.eventType, 'KernelAuthorityEntityRevoked');
    assert.equal(revoked?.provisionedBy, DURABLE_FIXTURE_OPERATOR.actorId);
    assert.equal(revoked?.previousEventDigest, provisioned?.eventDigest, 'a revocation names exactly the state it superseded');
    assert.equal((revoked?.payload as { reason?: string }).reason, 'rotated out');
  });
});
