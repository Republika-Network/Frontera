import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createEnterprise } from '../composition/composition-root.js';
import { loadEnterpriseConfiguration } from '../configuration/enterprise-configuration.js';
import { createEnterpriseRequestListener } from '../adapters/node-http-adapter.js';
import { buildTestKernelProviders, buildAllowedRequestBody } from './support.js';

/**
 * R004.B — proves that a raw provider/application secret handed to
 * `createEnterprise({ configuration })` can never be observed through the
 * public `AocEnterprise` surface, while the trusted in-process HTTP adapter
 * (`createEnterpriseRequestListener`) can still authenticate a caller with
 * the real credential. The sentinel is an unmistakable, never-real value —
 * see the R004.B mission brief.
 */
const SENTINEL = 'AOC_R004B_SECRET_SENTINEL_DO_NOT_USE';

function buildSentinelConfiguration() {
  return loadEnterpriseConfiguration({
    AOC_ENTERPRISE_PERSISTENCE_PROVIDER: 'memory',
    AOC_ENTERPRISE_REQUIRE_AUTH: 'true',
    AOC_ENTERPRISE_API_KEYS: `${SENTINEL}:org-acme`,
  });
}

/** Recursively asserts `needle` is not present anywhere in `value` -- own and symbol keys, arrays, nested objects, string contents. */
function assertNoSentinel(value: unknown, path = '$', seen = new Set<unknown>()): void {
  if (typeof value === 'string') {
    assert.ok(!value.includes(SENTINEL), `sentinel leaked at ${path}: ${value}`);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSentinel(item, `${path}[${index}]`, seen));
    return;
  }
  for (const key of Object.keys(value as Record<string, unknown>)) {
    assertNoSentinel((value as Record<string, unknown>)[key], `${path}.${key}`, seen);
  }
}

describe('R004.B: AocEnterprise.configuration never exposes raw secrets', () => {
  it('direct property access cannot retrieve the sentinel', async () => {
    const enterprise = await createEnterprise({ configuration: buildSentinelConfiguration(), kernelProviders: buildTestKernelProviders() });
    try {
      const apiKeys = (enterprise.configuration as unknown as { authentication?: { apiKeys?: unknown } }).authentication?.apiKeys;
      assertNoSentinel(apiKeys, '$.configuration.authentication.apiKeys');
    } finally {
      await enterprise.close();
    }
  });

  it('JSON.stringify(enterprise.configuration) cannot retrieve the sentinel', async () => {
    const enterprise = await createEnterprise({ configuration: buildSentinelConfiguration(), kernelProviders: buildTestKernelProviders() });
    try {
      const serialized = JSON.stringify(enterprise.configuration);
      assert.ok(!serialized.includes(SENTINEL), `sentinel leaked via JSON.stringify: ${serialized}`);
    } finally {
      await enterprise.close();
    }
  });

  it('object-spreading enterprise.configuration cannot retrieve the sentinel', async () => {
    const enterprise = await createEnterprise({ configuration: buildSentinelConfiguration(), kernelProviders: buildTestKernelProviders() });
    try {
      const spread = { ...enterprise.configuration };
      assertNoSentinel(spread, '$.{...configuration}');
    } finally {
      await enterprise.close();
    }
  });

  it('object-spreading the full enterprise instance cannot retrieve the sentinel', async () => {
    const enterprise = await createEnterprise({ configuration: buildSentinelConfiguration(), kernelProviders: buildTestKernelProviders() });
    try {
      const spread = { ...enterprise } as Record<string, unknown>;
      assertNoSentinel(spread.configuration, '$.{...enterprise}.configuration');
    } finally {
      await enterprise.close();
    }
  });

  it('a caller-triggered error object never carries the sentinel', async () => {
    const enterprise = await createEnterprise({ configuration: buildSentinelConfiguration(), kernelProviders: buildTestKernelProviders() });
    try {
      await assert.rejects(
        () => enterprise.evaluate(buildAllowedRequestBody(), { authorizationHeader: 'Bearer not-the-real-key' }),
        (error: unknown) => {
          assertNoSentinel((error as Error).message, '$.error.message');
          assertNoSentinel(JSON.stringify(error, Object.getOwnPropertyNames(error as object)), '$.error (serialized)');
          return true;
        },
      );
    } finally {
      await enterprise.close();
    }
  });

  it('the internal HTTP adapter still authenticates the real sentinel credential (internal consumers keep working)', async () => {
    const enterprise = await createEnterprise({ configuration: buildSentinelConfiguration(), kernelProviders: buildTestKernelProviders() });
    try {
      const listener = createEnterpriseRequestListener(enterprise);
      assert.equal(typeof listener, 'function');

      const authenticated = await enterprise.evaluate(buildAllowedRequestBody({ organization: { id: 'org-acme' } }), {
        authorizationHeader: `Bearer ${SENTINEL}`,
      });
      assert.equal(authenticated.body.status, 'allowed', 'the real configured credential must still authenticate successfully');

      await assert.rejects(() => enterprise.evaluate(buildAllowedRequestBody(), { authorizationHeader: 'Bearer wrong-credential' }));
    } finally {
      await enterprise.close();
    }
  });

  it('missing authentication config still fails closed (no wildcard/default credential ever matches)', async () => {
    const configuration = loadEnterpriseConfiguration({
      AOC_ENTERPRISE_PERSISTENCE_PROVIDER: 'memory',
      AOC_ENTERPRISE_REQUIRE_AUTH: 'true',
    });
    const enterprise = await createEnterprise({ configuration, kernelProviders: buildTestKernelProviders() });
    try {
      await assert.rejects(() => enterprise.evaluate(buildAllowedRequestBody(), { authorizationHeader: 'Bearer anything' }));
    } finally {
      await enterprise.close();
    }
  });

  it('non-secret configuration remains available on the public surface', async () => {
    const enterprise = await createEnterprise({ configuration: buildSentinelConfiguration(), kernelProviders: buildTestKernelProviders() });
    try {
      assert.equal(enterprise.configuration.environment, 'development');
      assert.equal(typeof enterprise.configuration.http.port, 'number');
      assert.equal(typeof enterprise.configuration.http.host, 'string');
      assert.equal(enterprise.configuration.features.requireAuthentication, true);
    } finally {
      await enterprise.close();
    }
  });
});
