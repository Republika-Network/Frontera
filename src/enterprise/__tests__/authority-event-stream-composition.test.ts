import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createExecutionAdapterRegistry, type ExecutionAdapter } from '../../features/execution-runtime/index.js';
import { createRecordingExecutionAdapter } from '../../features/execution-runtime/tests/execution-fixture.js';
import { KernelGrantCapability } from '../../kernel/orchestration/grant-adapter.js';
import {
  createInMemoryAuthorityEventStreamStore,
  createSqliteAuthorityEventStreamStore,
  deriveAuthorityEventStreamId,
  isAuthorityEventStreamError,
  type AuthorityEvent,
  type AuthorityEventStreamStore,
} from '../authority-event-stream/index.js';
import { createEnterprise, type AocEnterprise, type CreateEnterpriseOptions } from '../composition/composition-root.js';
import { loadEnterpriseConfiguration, type EnterpriseApiKey, type EnterpriseConfiguration } from '../configuration/enterprise-configuration.js';
import { snapshotGenericHttpOptions } from '../execution-adapters/generic-http/configuration.js';
import { createGenericHttpExecutionAdapterCore } from '../execution-adapters/generic-http/generic-http-execution-adapter.js';
import type { EnterpriseGenericHttpExecutionAdapterOptions } from '../execution-adapters/generic-http/index.js';
import type { GenericHttpNetworkRuntime } from '../execution-adapters/generic-http/node-https-transport.js';
import { createInMemoryKernelAuthorityStore } from '../kernel-authority/in-memory-kernel-authority-store.js';
import type { KernelAuthorityStore } from '../kernel-authority/kernel-authority-store.js';
import { createKernelAuthorityProvisioningService } from '../kernel-authority/provisioning-service.js';
import { AUTHORITY_EVENT_STREAM_MODULE_ID } from '../modules/authority-event-stream-module.js';
import { ALLOWED_INTENT, EVALUATED_AT_POLICY, NO_TEMPORAL_BOUND, ORG, PMFREAK_ACTOR_ID, TRUST_DOMAIN_ID } from './governed-action-support.js';
import { steppingClock } from './authority-event-stream-support.js';
import { buildTestKernelProviders } from './support.js';

/**
 * §16 / §22 / §23 / §33 — P8 composed by `createEnterprise`: present exactly
 * with governed actions, durable under SQLite persistence, owned correctly,
 * degraded (never gating) when it cannot work, tenant-confined through its one
 * read surface — and carrying no customer or provider secret.
 */

const SUBJECT = { system: 'datasys-app', subjectId: 'user-pmfreak' } as const;
const CUSTOMER_SECRET = 'AOC_P8_CUSTOMER_API_KEY_SENTINEL';
const KEYS: readonly EnterpriseApiKey[] = [{ key: CUSTOMER_SECRET, organizationId: ORG, customerIdentity: { principalId: 'principal-pmfreak', externalSubject: SUBJECT } }];
const A = { organizationId: ORG };

const directories: string[] = [];
const enterprises: AocEnterprise[] = [];
const authorityStores: KernelAuthorityStore[] = [];
after(async () => {
  await Promise.all(enterprises.map((enterprise) => enterprise.close().catch(() => {})));
  await Promise.all(authorityStores.map((store) => store.close().catch(() => {})));
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

function freshDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'aoc-authority-event-composition-'));
  directories.push(directory);
  return directory;
}

function configuration(options: { readonly sqlite?: string } = {}): EnterpriseConfiguration {
  const dir = options.sqlite;
  const base = loadEnterpriseConfiguration({
    AOC_ENTERPRISE_PERSISTENCE_PROVIDER: dir === undefined ? 'memory' : 'sqlite',
    AOC_ENTERPRISE_KERNEL_AUTHORITY_ORGANIZATION_ID: ORG,
    ...(dir === undefined
      ? { AOC_ENTERPRISE_AUTHORITY_EVENT_STREAM_SQLITE_PATH: join(freshDirectory(), 'never', 'authority-event-stream.sqlite') }
      : {
          AOC_ENTERPRISE_SQLITE_PATH: join(dir, 'governance.sqlite'),
          AOC_ENTERPRISE_PASSPORT_SQLITE_PATH: join(dir, 'passport.sqlite'),
          AOC_ENTERPRISE_ASSURANCE_SQLITE_PATH: join(dir, 'assurance.sqlite'),
          AOC_ENTERPRISE_BOUNDED_GRANT_SQLITE_PATH: join(dir, 'grants.sqlite'),
          AOC_ENTERPRISE_AUTHORITY_EVENT_STREAM_SQLITE_PATH: join(dir, 'events', 'authority-event-stream.sqlite'),
        }),
  });
  return { ...base, authentication: { apiKeys: KEYS } };
}

async function boundStore(): Promise<KernelAuthorityStore> {
  const store = createInMemoryKernelAuthorityStore();
  authorityStores.push(store);
  await createKernelAuthorityProvisioningService({ store, organizationId: ORG }).provisionActor(
    { system: true, actorId: 'operator-1' },
    { actorId: PMFREAK_ACTOR_ID, type: 'agent', displayName: 'PMFreak', externalSubject: SUBJECT },
  );
  return store;
}

async function compose(options: { readonly configuration?: EnterpriseConfiguration; readonly governed?: boolean; readonly store?: AuthorityEventStreamStore; readonly adapter?: ExecutionAdapter } = {}): Promise<AocEnterprise> {
  const enterprise = await createEnterprise({
    configuration: options.configuration ?? configuration(),
    kernelProviders: buildTestKernelProviders(),
    kernelAuthorityStore: await boundStore(),
    customerIdentityAdmission: { enabled: true },
    authorityControlledExecution: {
      grantCapability: new KernelGrantCapability({ declaration: {} }),
      executionAdapter: options.adapter ?? createRecordingExecutionAdapter(),
      resolveAuthorityBinding: () => NO_TEMPORAL_BOUND,
    },
    ...(options.governed === false ? {} : { governedActionOrchestrator: { enabled: true, trustDomainId: TRUST_DOMAIN_ID, grantPolicy: EVALUATED_AT_POLICY } }),
    ...(options.store !== undefined ? { authorityEventStream: { store: options.store } } : {}),
  } satisfies CreateEnterpriseOptions);
  enterprises.push(enterprise);
  return enterprise;
}

let keySequence = 0;
async function govern(enterprise: AocEnterprise, key = `p8-composition-${(keySequence += 1)}`) {
  assert.ok(enterprise.governAction !== undefined);
  return (await enterprise.governAction({ ...ALLOWED_INTENT, idempotencyKey: key }, { authorizationHeader: `Bearer ${CUSTOMER_SECRET}` })).body;
}

const streamIdOf = (requestId: string | undefined) => deriveAuthorityEventStreamId({ organizationId: ORG, requestId: requestId ?? '' });

async function moduleHealth(enterprise: AocEnterprise) {
  return (await enterprise.health()).modules?.[AUTHORITY_EVENT_STREAM_MODULE_ID];
}

describe('P8 composition — present exactly with governed actions', () => {
  it('without governed actions: no stream, no module, no reader, and no file is created', async () => {
    const config = configuration();
    const enterprise = await compose({ configuration: config, governed: false });
    assert.equal(enterprise.authorityEventStream, undefined);
    assert.equal(enterprise.modules().some((module) => module.id === AUTHORITY_EVENT_STREAM_MODULE_ID), false);
    assert.equal(existsSync(config.authorityEventStream.sqlitePath), false);
  });

  it('with governed actions (memory persistence): the module is healthy, the reader is read-only, and the lifecycle is on the stream', async () => {
    const config = configuration();
    const enterprise = await compose({ configuration: config });
    assert.equal(existsSync(config.authorityEventStream.sqlitePath), false, 'memory persistence selects the process-local store');
    const reader = enterprise.authorityEventStream;
    assert.ok(reader !== undefined);
    assert.deepEqual(Object.keys(reader).sort(), ['readStream', 'verifyStream'], 'no append, no health, no close');
    const result = await govern(enterprise);
    assert.equal(result.status, 'executed');
    const events = await reader.readStream(A, streamIdOf(result.requestId));
    assert.deepEqual(
      events.map((event) => event.eventType),
      ['governance.decision.committed', 'grant.issued', 'execution.attempt.claimed', 'execution.outcome.observed'],
    );
    assert.equal((await reader.verifyStream(A, streamIdOf(result.requestId))).valid, true);
    const health = await moduleHealth(enterprise);
    assert.equal(health?.health.status, 'healthy');
    assert.equal(health?.required, false, 'optional: it can never take the Host out of ready');
    assert.equal(health?.health.details?.appended, 4);
  });

  it('the one read surface is tenant-confined', async () => {
    const enterprise = await compose();
    const result = await govern(enterprise);
    const reader = enterprise.authorityEventStream;
    assert.ok(reader !== undefined);
    await assert.rejects(reader.readStream({ organizationId: 'org-other' }, streamIdOf(result.requestId)), (error: unknown) => isAuthorityEventStreamError(error) && error.code === 'AUTHORITY_EVENT_TENANT_VIOLATION');
    await assert.rejects(reader.verifyStream({ organizationId: 'org-other' }, streamIdOf(result.requestId)), (error: unknown) => isAuthorityEventStreamError(error) && error.code === 'AUTHORITY_EVENT_TENANT_VIOLATION');
  });
});

describe('P8 composition — durable and owned correctly', () => {
  it('SQLite persistence: the stream is written to its own file and survives the Host, readable after a restart', async () => {
    const dir = freshDirectory();
    const config = configuration({ sqlite: dir });
    const enterprise = await compose({ configuration: config });
    const result = await govern(enterprise, 'durable-1');
    const live = await enterprise.authorityEventStream?.readStream(A, streamIdOf(result.requestId));
    await enterprise.close();
    assert.ok(existsSync(config.authorityEventStream.sqlitePath));
    const reopened = await createSqliteAuthorityEventStreamStore(config.authorityEventStream.sqlitePath, { now: steppingClock().now });
    try {
      assert.deepEqual([...(await reopened.readStream(A, streamIdOf(result.requestId)))], [...(live ?? [])]);
      assert.equal(live?.length, 4);
    } finally {
      await reopened.close();
    }
  });

  it('a host-supplied store is used verbatim and never closed by the Host', async () => {
    const store = createInMemoryAuthorityEventStreamStore({ now: steppingClock().now });
    const enterprise = await compose({ store });
    const result = await govern(enterprise);
    await enterprise.close();
    assert.equal((await store.health()).status, 'healthy', 'still open after the Host closed');
    assert.equal((await store.readStream(A, streamIdOf(result.requestId))).length, 4);
    await store.close();
  });
});

describe('P8 composition — §16 evidence never gates: unavailable or failing stores degrade the module, not the Host', () => {
  it('a store that cannot be opened: the Host starts ready, governed actions execute, the module reports unhealthy, no reader', async () => {
    const dir = freshDirectory();
    const config = configuration({ sqlite: dir });
    // A directory where the database file should be: unopenable.
    mkdirSync(config.authorityEventStream.sqlitePath, { recursive: true });
    const adapter = createRecordingExecutionAdapter();
    const enterprise = await compose({ configuration: config, adapter });
    assert.equal(enterprise.isReady(), true);
    assert.equal(enterprise.authorityEventStream, undefined);
    const result = await govern(enterprise);
    assert.equal(result.status, 'executed');
    assert.equal(adapter.callCount, 1);
    const health = await moduleHealth(enterprise);
    assert.equal(health?.health.status, 'unhealthy');
    assert.ok(Number(health?.health.details?.failed) >= 4);
    assert.equal(JSON.stringify(health).includes(dir), false, 'no path is disclosed through health');
  });

  it('a store whose appends fail: identical results and adapter calls to a Host without failure; the module is degraded; the Host stays ready', async () => {
    const failing = createInMemoryAuthorityEventStreamStore({ now: steppingClock().now });
    const broken: AuthorityEventStreamStore = { ...failing, append: async () => Promise.reject(new Error('evidence volume full')) };
    const brokenAdapter = createRecordingExecutionAdapter();
    const healthyAdapter = createRecordingExecutionAdapter();
    const brokenHost = await compose({ store: broken, adapter: brokenAdapter });
    const healthyHost = await compose({ adapter: healthyAdapter });
    const a = await govern(brokenHost, 'same-key');
    const b = await govern(healthyHost, 'same-key');
    const strip = (value: object) => JSON.parse(JSON.stringify(value, (key, inner: unknown) => (key === 'evaluationId' || key === 'decisionId' ? undefined : inner))) as unknown;
    assert.deepEqual(strip(a), strip(b), 'the governed result does not depend on evidence');
    assert.equal(brokenAdapter.callCount, healthyAdapter.callCount);
    assert.equal(brokenHost.isReady(), true);
    const health = await moduleHealth(brokenHost);
    assert.equal(health?.health.status, 'degraded');
    assert.equal(health?.health.details?.lastFailureCode, 'AUTHORITY_EVENT_PROJECTION_FAILED');
    assert.equal((await brokenHost.health()).ready, true);
  });
});

describe('P8 composition — §33 no secret reaches the stream', () => {
  const PROVIDER_TOKEN = 'P8ProviderBearerTokenSentinel';
  const HEADER_LITERAL = 'P8HeaderLiteralSecretSentinel';
  const RESPONSE_BODY = 'P8_PROVIDER_RESPONSE_BODY_SENTINEL';
  const PROVIDER_REF = 'erp-ref-p8-777';
  const ORIGIN_HOST = 'api.p8-erp.example';

  function genericOptions(): EnterpriseGenericHttpExecutionAdapterOptions {
    return {
      adapterId: 'erp.p8',
      origin: `https://${ORIGIN_HOST}`,
      method: 'POST',
      path: [
        { kind: 'literal', value: 'v1' },
        { kind: 'literal', value: 'payments' },
      ],
      headers: { 'X-Tenant-Secret': { kind: 'literal', value: HEADER_LITERAL }, 'Idempotency-Key': { kind: 'source', source: 'correlation.executionId' } },
      body: { kind: 'json-object', fields: { action: { kind: 'source', source: 'action' }, resource: { kind: 'source', source: 'resource' } } },
      credential: { kind: 'bearer', token: PROVIDER_TOKEN },
      providerRefHeader: 'X-Provider-Ref',
      timeoutMs: 1000,
    } as EnterpriseGenericHttpExecutionAdapterOptions;
  }

  /** Every key and every string value, recursively. */
  function strings(value: unknown, out: string[] = []): string[] {
    if (typeof value === 'string') out.push(value);
    else if (Array.isArray(value)) for (const item of value) strings(item, out);
    else if (value !== null && typeof value === 'object')
      for (const [key, item] of Object.entries(value)) {
        out.push(key);
        strings(item, out);
      }
    return out;
  }

  it('customer bearer, provider credential, headers, destination, response body and asserted context never appear — keys or values', async () => {
    const sent: unknown[] = [];
    const runtime: GenericHttpNetworkRuntime = {
      async resolve() {
        return { kind: 'resolved', answers: [{ address: '93.184.216.34', family: 4 }] };
      },
      async send(request) {
        sent.push(request);
        return { kind: 'response', status: 201, providerRefValues: [PROVIDER_REF], body: RESPONSE_BODY, headers: { 'set-cookie': 'session=P8CookieSentinel' } } as unknown as Awaited<ReturnType<GenericHttpNetworkRuntime['send']>>;
      },
    };
    const child = createGenericHttpExecutionAdapterCore(snapshotGenericHttpOptions(genericOptions()), runtime);
    const registry = createExecutionAdapterRegistry({ adapterId: 'router', adapters: [child], selectAdapter: () => 'erp.p8' });
    const enterprise = await compose({ adapter: registry });
    const result = await govern(enterprise, 'secrets');
    assert.equal(result.status, 'executed', JSON.stringify(result));

    // Non-vacuous: the secrets really were on the effect path.
    const wire = JSON.stringify(sent);
    assert.ok(wire.includes(PROVIDER_TOKEN) && wire.includes(HEADER_LITERAL) && wire.includes(ORIGIN_HOST), 'the provider request carried the credential, header and destination');

    const events: readonly AuthorityEvent[] = (await enterprise.authorityEventStream?.readStream(A, streamIdOf(result.requestId))) ?? [];
    assert.equal(events.length, 4);
    const all = strings(events);
    const joined = all.join('\n');
    for (const sentinel of [CUSTOMER_SECRET, PROVIDER_TOKEN, HEADER_LITERAL, RESPONSE_BODY, ORIGIN_HOST, 'P8CookieSentinel', 'passport-pmfreak', ALLOWED_INTENT.assertedContext.capabilityTokenId, ALLOWED_INTENT.assertedContext.evidence]) {
      assert.equal(joined.includes(String(sentinel)), false, `${String(sentinel)} leaked into the stream`);
    }
    for (const text of all) {
      for (const pattern of [/bearer\s/i, /authorization/i, /cookie/i, /x-tenant-secret/i, /eyJ[A-Za-z0-9_-]{4,}\./, /-----BEGIN/, /\bseed\b/i, /mnemonic/i, /private.?key/i, /:\/\//, /assertedContext/i]) {
        assert.equal(pattern.test(text), false, `'${text}' matches ${String(pattern)}`);
      }
    }
    // Only the bounded provider-neutral facts the runtime already had.
    const outcome = events.find((event) => event.eventType === 'execution.outcome.observed');
    assert.deepEqual(outcome?.payload, { status: 'executed', reasonCodes: [], adapterId: 'erp.p8', routedBy: 'router', providerRef: PROVIDER_REF, outcomeRecorded: true });
  });
});
