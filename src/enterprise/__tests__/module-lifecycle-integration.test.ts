import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';

import { createEnterprise } from '../composition/composition-root.js';
import { createEnterpriseServer, type EnterpriseServer } from '../host/enterprise-server.js';
import { loadEnterpriseConfiguration } from '../configuration/enterprise-configuration.js';
import { buildAllowedRequestBody, buildTestKernelProviders } from './support.js';

const startedServers: EnterpriseServer[] = [];
after(async () => {
  await Promise.all(startedServers.map((server) => server.close().catch(() => undefined)));
});

describe('Soberanía Enterprise Module Lifecycle & Registry (integration via createEnterprise)', () => {
  it('createEnterprise() auto-starts and reports the built-in modules as ready', async () => {
    const enterprise = await createEnterprise({ kernelProviders: buildTestKernelProviders() });

    assert.equal(enterprise.isLive(), true);
    assert.equal(enterprise.isReady(), true);
    assert.equal(enterprise.lifecycleState(), 'ready');

    const modules = enterprise.modules();
    const ids = modules.map((m) => m.id).sort();
    // PR-004: 'aoc.enterprise.persistence' evolved into the Governance Store module (documented migration).
    // PR-006: 'aoc.enterprise.agent-passport' (Agent Passport Runtime) joined the built-in module set.
    // PR-007: 'aoc.enterprise.assurance' (Assurance Runtime) joined the built-in module set.
    // ASSURE-01: 'aoc.enterprise.evidence-bundles' (the Evidence Bundle Store's health) joined it.
    assert.deepEqual(
      ids,
      [
        'aoc.enterprise.agent-passport',
        'aoc.enterprise.assurance',
        'aoc.enterprise.events',
        'aoc.enterprise.evidence-bundles',
        'aoc.enterprise.governance-store',
        'aoc.enterprise.providers',
        'aoc.enterprise.telemetry',
        'aoc.kernel',
      ].sort(),
    );
    for (const module of modules) assert.equal(module.state, 'ready');

    const kernelModule = modules.find((m) => m.id === 'aoc.kernel');
    assert.equal(kernelModule?.required, true);
    assert.deepEqual(kernelModule?.dependencies, [{ moduleId: 'aoc.enterprise.providers' }]);

    await enterprise.close();
  });

  it('start() is a safe idempotent no-op after auto-start', async () => {
    const enterprise = await createEnterprise({ kernelProviders: buildTestKernelProviders() });
    await enterprise.start();
    assert.equal(enterprise.isReady(), true);
    await enterprise.close();
  });

  it('health() reports lifecycleState/live/ready/modules alongside the existing persistence/providers fields', async () => {
    const enterprise = await createEnterprise({ kernelProviders: buildTestKernelProviders() });
    const report = await enterprise.health();

    assert.equal(report.status, 'healthy');
    assert.equal(report.lifecycleState, 'ready');
    assert.equal(report.live, true);
    assert.equal(report.ready, true);
    assert.ok(report.modules);
    assert.equal(report.modules?.['aoc.kernel']?.health.status, 'healthy');
    // Existing PR-002 fields remain present, unchanged in shape.
    assert.equal(report.persistence.connected, true);
    assert.ok(report.providers.loaded.includes('recognitionProvider'));

    await enterprise.close();
  });

  it('evaluate() is rejected with ENTERPRISE_NOT_READY once close() has been called', async () => {
    const enterprise = await createEnterprise({ kernelProviders: buildTestKernelProviders() });
    await enterprise.close();

    assert.equal(enterprise.isReady(), false);
    assert.equal(enterprise.isLive(), false);
    await assert.rejects(
      () => enterprise.evaluate(buildAllowedRequestBody({ requestId: 'req-not-ready-1' })),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'ENTERPRISE_NOT_READY');
        assert.equal((error as { httpStatus?: number }).httpStatus, 503);
        return true;
      },
    );
  });

  it('close() shuts down modules in reverse order and is idempotent', async () => {
    const enterprise = await createEnterprise({ kernelProviders: buildTestKernelProviders() });
    await enterprise.close();
    await enterprise.close(); // must not throw
    assert.equal(enterprise.lifecycleState(), 'stopped');
  });

  it('stop() is an alias for close()', async () => {
    const enterprise = await createEnterprise({ kernelProviders: buildTestKernelProviders() });
    await enterprise.stop();
    assert.equal(enterprise.lifecycleState(), 'stopped');
  });

  it('an Enterprise instance with event publishing disabled degrades the events module without blocking readiness', async () => {
    const configuration = loadEnterpriseConfiguration({ AOC_ENTERPRISE_EVENTS_ENABLED: 'false' });
    const enterprise = await createEnterprise({ configuration, kernelProviders: buildTestKernelProviders() });

    assert.equal(enterprise.isReady(), true);
    assert.equal(enterprise.lifecycleState(), 'degraded');
    const eventsModule = enterprise.modules().find((m) => m.id === 'aoc.enterprise.events');
    assert.equal(eventsModule?.state, 'degraded');
    assert.equal(eventsModule?.required, false);

    const outcome = await enterprise.evaluate(buildAllowedRequestBody({ requestId: 'req-degraded-events-1' }));
    assert.equal(outcome.body.status, 'allowed', 'a degraded optional module must not block governance evaluation');

    await enterprise.close();
  });

  it('GET /live and /ready report the Host lifecycle over HTTP', async () => {
    const configuration = loadEnterpriseConfiguration({ AOC_ENTERPRISE_HTTP_PORT: '0', AOC_ENTERPRISE_HTTP_HOST: '127.0.0.1' });
    const server = await createEnterpriseServer({ configuration, kernelProviders: buildTestKernelProviders() });
    startedServers.push(server);
    const { port, host } = await server.listen();
    const baseUrl = `http://${host}:${port}`;

    const live = await fetch(`${baseUrl}/live`);
    assert.equal(live.status, 200);
    const liveBody = await live.json();
    assert.equal(liveBody.live, true);
    assert.equal(liveBody.lifecycleState, 'ready');

    const ready = await fetch(`${baseUrl}/ready`);
    assert.equal(ready.status, 200);
    const readyBody = await ready.json();
    assert.equal(readyBody.ready, true);
    assert.equal(readyBody.lifecycleState, 'ready');
  });

  it('POST /api/governance/evaluate returns 503 ENTERPRISE_NOT_READY once the Host has been closed', async () => {
    const configuration = loadEnterpriseConfiguration({ AOC_ENTERPRISE_HTTP_PORT: '0', AOC_ENTERPRISE_HTTP_HOST: '127.0.0.1' });
    const server = await createEnterpriseServer({ configuration, kernelProviders: buildTestKernelProviders() });
    const { port, host } = await server.listen();
    const baseUrl = `http://${host}:${port}`;

    await server.enterprise.close();

    const response = await fetch(`${baseUrl}/api/governance/evaluate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(buildAllowedRequestBody({ requestId: 'req-http-not-ready-1' })),
    });
    const body = await response.json();

    assert.equal(response.status, 503);
    assert.equal(body.error.code, 'ENTERPRISE_NOT_READY');
    assert.equal(body.error.lifecycleState, 'stopped');

    await new Promise<void>((resolvePromise, rejectPromise) => server.server.close((error) => (error ? rejectPromise(error) : resolvePromise())));
  });
});
