import { after, afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns';
import diagnosticsChannel from 'node:diagnostics_channel';
import { createConnection, createServer as createNetServer } from 'node:net';

import { EMERGENCY_CONTROL_REASON_CODES } from '../../features/emergency-control-runtime/index.js';
import {
  createExecutionAdapterRegistry,
  isExecutionAdapterRegistryError,
  type ExecutionAdapter,
  type ValidatedExecutionAction,
} from '../../features/execution-runtime/index.js';
import { createRecordingExecutionAdapter, type RecordingExecutionAdapter } from '../../features/execution-runtime/tests/execution-fixture.js';
import type { BoundedGrantStorePort } from '../../features/grant-runtime/index.js';
import { KernelGrantCapability } from '../../kernel/orchestration/grant-adapter.js';
import { createEnterprise, type AocEnterprise, type CreateEnterpriseOptions } from '../composition/composition-root.js';
import { loadEnterpriseConfiguration, type EnterpriseApiKey, type EnterpriseConfiguration } from '../configuration/enterprise-configuration.js';
import { createInProcessEventPublisher, type EnterpriseEvent } from '../events/enterprise-events.js';
import { GenericHttpConfigurationError, type EnterpriseGenericHttpExecutionAdapterOptions } from '../execution-adapters/generic-http/index.js';
import { snapshotGenericHttpOptions } from '../execution-adapters/generic-http/configuration.js';
import { createGenericHttpExecutionAdapterCore } from '../execution-adapters/generic-http/generic-http-execution-adapter.js';
import type { GenericHttpNetworkRuntime } from '../execution-adapters/generic-http/node-https-transport.js';
import type { GenericHttpWireRequest } from '../execution-adapters/generic-http/request-mapper.js';
import type { GovernanceStore } from '../governance-store/governance-store.js';
import { createInMemoryGovernanceStore } from '../governance-store/in-memory-governance-store.js';
import { GOVERNED_ACTION_REASON_CODES as R } from '../governed-action/index.js';
import { mapGovernedActionResultToHttpStatus } from '../api/governed-action-contract.js';
import { createInMemoryKernelAuthorityStore } from '../kernel-authority/in-memory-kernel-authority-store.js';
import type { KernelAuthorityStore } from '../kernel-authority/kernel-authority-store.js';
import { createKernelAuthorityProvisioningService } from '../kernel-authority/provisioning-service.js';
import type { EnterpriseLogger } from '../telemetry/enterprise-logger.js';
import { ALLOWED_INTENT, EVALUATED_AT_POLICY, IDENTITY, NO_TEMPORAL_BOUND, ORG, PMFREAK_ACTOR_ID, TRUST_DOMAIN_ID, buildGovernedWorld } from './governed-action-support.js';
import { buildTestKernelProviders } from './support.js';

/**
 * The Generic HTTP adapter **in composition**: a child of the one existing
 * registry, reached only through the governed path, stopped by the existing
 * adapter-scoped emergency control, and never configurable by a customer.
 *
 * No test here opens a socket to anything. The system resolver is replaced for
 * the duration of each test by a counting stand-in, and every TCP socket and
 * HTTP client request the process creates is counted through Node's own
 * diagnostics channels — so "zero network attempts" is measured, not assumed.
 * Where the production adapter is exercised end to end, it is stopped by its
 * own public-address policy: the stand-in resolver answers a private address.
 */

const SUBJECT = { system: 'datasys-app', subjectId: 'user-pmfreak' } as const;
const SECRET = 'AOC_GENERIC_HTTP_COMPOSITION_API_KEY_SENTINEL';
const TOKEN = 'P6CompositionBearerSentinel42';
const KEYS: readonly EnterpriseApiKey[] = [{ key: SECRET, organizationId: ORG, customerIdentity: { principalId: 'principal-pmfreak', externalSubject: SUBJECT } }];
const ISSUER = 'operator:on-call';
const AT = '2026-01-01T00:00:00.000Z';
const GENERIC_ID = 'erp.invoice-payment';

// -- network observation --------------------------------------------------------

const network = { lookups: [] as string[], sockets: 0, httpRequests: 0 };
const onSocket = (): void => {
  network.sockets += 1;
};
const onHttpRequest = (): void => {
  network.httpRequests += 1;
};
diagnosticsChannel.subscribe('net.client.socket', onSocket);
diagnosticsChannel.subscribe('http.client.request.start', onHttpRequest);

const realLookup = dns.promises.lookup;
let lookupAnswer: readonly { address: string; family: number }[] = [{ address: '10.20.30.40', family: 4 }];

beforeEach(() => {
  network.lookups.length = 0;
  network.sockets = 0;
  network.httpRequests = 0;
  lookupAnswer = [{ address: '10.20.30.40', family: 4 }];
  (dns.promises as { lookup: unknown }).lookup = async (hostname: string) => {
    network.lookups.push(hostname);
    return lookupAnswer;
  };
});
afterEach(() => {
  (dns.promises as { lookup: unknown }).lookup = realLookup;
});

// -- composition helpers --------------------------------------------------------

const enterprises: AocEnterprise[] = [];
const authorityStores: KernelAuthorityStore[] = [];
after(async () => {
  diagnosticsChannel.unsubscribe('net.client.socket', onSocket);
  diagnosticsChannel.unsubscribe('http.client.request.start', onHttpRequest);
  await Promise.all(enterprises.map((enterprise) => enterprise.close().catch(() => {})));
  await Promise.all(authorityStores.map((store) => store.close().catch(() => {})));
});

function configuration(): EnterpriseConfiguration {
  const base = loadEnterpriseConfiguration({ AOC_ENTERPRISE_PERSISTENCE_PROVIDER: 'memory', AOC_ENTERPRISE_KERNEL_AUTHORITY_ORGANIZATION_ID: ORG });
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

/** The customer-facing action the Datasys fixture allows: no counterparty, no amount. */
function genericOptions(overrides: Record<string, unknown> = {}): EnterpriseGenericHttpExecutionAdapterOptions {
  return {
    adapterId: GENERIC_ID,
    origin: 'https://api.erp.example',
    method: 'POST',
    path: [{ kind: 'literal', value: 'v1' }, { kind: 'literal', value: 'actions' }],
    headers: { 'Idempotency-Key': { kind: 'source', source: 'correlation.executionId' } },
    body: {
      kind: 'json-object',
      fields: {
        action: { kind: 'source', source: 'action' },
        resource: { kind: 'source', source: 'resource' },
        subject: { kind: 'source', source: 'subject' },
        organization: { kind: 'source', source: 'organization', required: false },
      },
    },
    credential: { kind: 'bearer', token: TOKEN },
    providerRefHeader: 'x-request-id',
    timeoutMs: 1000,
    ...overrides,
  } as EnterpriseGenericHttpExecutionAdapterOptions;
}

interface Composed {
  readonly enterprise: AocEnterprise;
  readonly persistence: GovernanceStore;
  readonly logs: string[];
  readonly events: EnterpriseEvent[];
}

async function compose(
  routing: NonNullable<NonNullable<CreateEnterpriseOptions['authorityControlledExecution']>['executionAdapterRouting']> | undefined,
  overrides: Partial<CreateEnterpriseOptions> = {},
  single?: ExecutionAdapter,
): Promise<Composed> {
  const persistence = createInMemoryGovernanceStore();
  const logs: string[] = [];
  const logger: EnterpriseLogger = {
    debug: (message, fields) => logs.push(JSON.stringify({ message, fields })),
    info: (message, fields) => logs.push(JSON.stringify({ message, fields })),
    warn: (message, fields) => logs.push(JSON.stringify({ message, fields })),
    error: (message, fields) => logs.push(JSON.stringify({ message, fields })),
  };
  const eventPublisher = createInProcessEventPublisher();
  const events: EnterpriseEvent[] = [];
  eventPublisher.subscribe((event) => events.push(event));
  const enterprise = await createEnterprise({
    configuration: configuration(),
    kernelProviders: buildTestKernelProviders(),
    kernelAuthorityStore: await boundStore(),
    persistence,
    logger,
    eventPublisher,
    customerIdentityAdmission: { enabled: true },
    authorityControlledExecution: {
      grantCapability: new KernelGrantCapability({ declaration: {} }),
      ...(routing !== undefined ? { executionAdapterRouting: routing } : { executionAdapter: single ?? createRecordingExecutionAdapter() }),
      resolveAuthorityBinding: () => NO_TEMPORAL_BOUND,
    },
    governedActionOrchestrator: { enabled: true, trustDomainId: TRUST_DOMAIN_ID, grantPolicy: EVALUATED_AT_POLICY },
    ...overrides,
  });
  enterprises.push(enterprise);
  return { enterprise, persistence, logs, events };
}

async function govern(enterprise: AocEnterprise, intent: unknown = ALLOWED_INTENT) {
  assert.ok(enterprise.governAction !== undefined, 'the governed-action route must be composed');
  return enterprise.governAction(intent, { authorizationHeader: `Bearer ${SECRET}` });
}

async function outcomeRow(persistence: GovernanceStore, requestId: string | undefined): Promise<string | undefined> {
  assert.ok(requestId !== undefined);
  const record = await persistence.getByRequestId({ system: true }, requestId);
  assert.ok(record !== null);
  return record.references.map((reference) => reference.externalVersion).find((version) => version !== undefined && version !== 'attempt');
}

function namedAdapter(adapterId: string): RecordingExecutionAdapter {
  const inner = createRecordingExecutionAdapter();
  return {
    adapterId,
    calls: inner.calls,
    get callCount(): number {
      return inner.callCount;
    },
    execute: (action: ValidatedExecutionAction) => inner.execute(action),
  };
}

// ---------------------------------------------------------------------------

describe('Generic HTTP composition — the observation is not vacuous', () => {
  it('the diagnostics channels count a real client socket, and the resolver stand-in is the one the adapter reaches', async () => {
    const server = createNetServer((socket) => socket.destroy());
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address !== null && typeof address === 'object');
    await new Promise<void>((resolve) => {
      const client = createConnection(address.port, '127.0.0.1');
      client.on('close', () => resolve());
      client.on('error', () => {});
    });
    server.close();
    assert.equal(network.sockets, 1, 'a real outbound socket is observed');
    assert.equal((await dns.promises.lookup('anything.example', { all: true })).length, 1);
    assert.deepEqual(network.lookups, ['anything.example']);
  });
});

describe('Generic HTTP composition — A–C: existing compositions are unchanged', () => {
  it('A. a single executionAdapter still executes', async () => {
    const adapter = createRecordingExecutionAdapter();
    const { enterprise } = await compose(undefined, {}, adapter);
    const response = await govern(enterprise);
    assert.equal(response.body.status, 'executed', JSON.stringify(response.body));
    assert.equal(adapter.callCount, 1);
  });

  it('B–C. routing over host adapters alone, with genericHttpAdapters omitted, still executes through the chosen child', async () => {
    const a = namedAdapter('adapter-a');
    const { enterprise } = await compose({ adapters: [a], selectAdapter: () => 'adapter-a' });
    const response = await govern(enterprise);
    assert.equal(response.body.status, 'executed', JSON.stringify(response.body));
    assert.equal(a.callCount, 1);
    assert.equal(network.lookups.length + network.sockets + network.httpRequests, 0);
  });
});

describe('Generic HTTP composition — D–G: one registry, two kinds of child', () => {
  it('D. custom and generic adapters are children of the same registry; trusted routing picks between them', async () => {
    const custom = namedAdapter('adapter-a');
    const selected: string[] = [];
    let route = 'adapter-a';
    const { enterprise, persistence } = await compose({
      adapters: [custom],
      genericHttpAdapters: [genericOptions()],
      selectAdapter: () => {
        selected.push(route);
        return route;
      },
    });

    const first = await govern(enterprise);
    assert.equal(first.body.status, 'executed');
    assert.equal(custom.callCount, 1);
    assert.equal(network.lookups.length, 0, 'the generic child was not touched while routing chose the custom one');

    route = GENERIC_ID;
    const second = await govern(enterprise, { ...ALLOWED_INTENT, idempotencyKey: 'key-generic-route' });
    assert.equal(second.body.status, 'execution_failed');
    assert.equal(second.body.status === 'execution_failed' ? second.body.failure : undefined, 'ADAPTER_ERROR');
    assert.equal(custom.callCount, 1);
    assert.deepEqual(network.lookups, ['api.erp.example'], 'the generic child resolved its pinned hostname exactly once');
    assert.equal(network.sockets, 0, 'the private answer was refused: no socket');
    assert.equal(network.httpRequests, 0);
    assert.equal(await outcomeRow(persistence, second.body.requestId), `execution-failed:ADAPTER_ERROR@${GENERIC_ID}`, 'the durable record names the generic child');
  });

  it('E. genericHttpAdapters alone, with adapters: [], is a valid registry', async () => {
    const { enterprise, persistence } = await compose({ adapters: [], genericHttpAdapters: [genericOptions()], selectAdapter: () => GENERIC_ID });
    const response = await govern(enterprise);
    assert.equal(response.body.status, 'execution_failed');
    assert.equal(await outcomeRow(persistence, response.body.requestId), `execution-failed:ADAPTER_ERROR@${GENERIC_ID}`);
    assert.equal(network.sockets, 0);
  });

  it('F. no host adapters and no generic adapters still fails composition closed', async () => {
    await assert.rejects(
      compose({ adapters: [], selectAdapter: () => GENERIC_ID }),
      (error: unknown) => isExecutionAdapterRegistryError(error) && error.code === 'EXECUTION_ADAPTER_REGISTRY_EMPTY',
    );
    await assert.rejects(
      compose({ adapters: [], genericHttpAdapters: [], selectAdapter: () => GENERIC_ID }),
      (error: unknown) => isExecutionAdapterRegistryError(error) && error.code === 'EXECUTION_ADAPTER_REGISTRY_EMPTY',
    );
  });

  it('G. a generic id colliding with a host adapter, or with another generic adapter, is refused', async () => {
    await assert.rejects(
      compose({ adapters: [namedAdapter(GENERIC_ID)], genericHttpAdapters: [genericOptions()], selectAdapter: () => GENERIC_ID }),
      (error: unknown) => isExecutionAdapterRegistryError(error) && error.code === 'EXECUTION_ADAPTER_ID_DUPLICATE',
    );
    await assert.rejects(
      compose({ adapters: [], genericHttpAdapters: [genericOptions(), genericOptions({ origin: 'https://other.erp.example' })], selectAdapter: () => GENERIC_ID }),
      (error: unknown) => isExecutionAdapterRegistryError(error) && error.code === 'EXECUTION_ADAPTER_ID_DUPLICATE',
    );
  });
});

describe('Generic HTTP composition — H: invalid configuration fails startup, before any store is touched', () => {
  function watched<T extends object>(target: T, reads: string[]): T {
    return new Proxy(target, {
      get(inner, key, receiver) {
        reads.push(String(key));
        return Reflect.get(inner, key, receiver) as unknown;
      },
    });
  }

  for (const [label, bad, code] of [
    ['an http origin', { origin: 'http://api.erp.example' }, 'GENERIC_HTTP_ORIGIN_INVALID'],
    ['an IP-literal origin', { origin: 'https://169.254.169.254' }, 'GENERIC_HTTP_ORIGIN_INVALID'],
    ['a boundedGrantId mapping', { body: { kind: 'json-object', fields: { g: { kind: 'source', source: 'boundedGrantId' } } } }, 'GENERIC_HTTP_MAPPING_INVALID'],
    ['a Host header', { headers: { Host: { kind: 'literal', value: 'evil.example' } } }, 'GENERIC_HTTP_HEADER_INVALID'],
    ['a followRedirects escape hatch', { followRedirects: true }, 'GENERIC_HTTP_OPTIONS_INVALID'],
    ['an unlimited timeout', { timeoutMs: 0 }, 'GENERIC_HTTP_LIMIT_INVALID'],
  ] as const) {
    it(`${label} is refused with ${code}, and neither the Governance Store nor the grant store is read`, async () => {
      const persistenceReads: string[] = [];
      const grantReads: string[] = [];
      const grantStore = watched({} as BoundedGrantStorePort, grantReads);
      await assert.rejects(
        createEnterprise({
          configuration: configuration(),
          kernelProviders: buildTestKernelProviders(),
          kernelAuthorityStore: createInMemoryKernelAuthorityStore(),
          persistence: watched(createInMemoryGovernanceStore(), persistenceReads),
          customerIdentityAdmission: { enabled: true },
          authorityControlledExecution: {
            grantCapability: new KernelGrantCapability({ declaration: {} }),
            grantStore,
            executionAdapterRouting: { adapters: [], genericHttpAdapters: [genericOptions(bad)], selectAdapter: () => GENERIC_ID },
            resolveAuthorityBinding: () => NO_TEMPORAL_BOUND,
          },
          governedActionOrchestrator: { enabled: true, trustDomainId: TRUST_DOMAIN_ID, grantPolicy: EVALUATED_AT_POLICY },
        }),
        (error: unknown) => error instanceof GenericHttpConfigurationError && error.code === code && !error.message.includes(TOKEN),
      );
      assert.deepEqual(persistenceReads, []);
      assert.deepEqual(grantReads, []);
    });
  }

  it('control: a valid configuration does go on to read the Governance Store, so the empty read logs above are not vacuous', async () => {
    const persistenceReads: string[] = [];
    const enterprise = await createEnterprise({
      configuration: configuration(),
      kernelProviders: buildTestKernelProviders(),
      kernelAuthorityStore: await boundStore(),
      persistence: watched(createInMemoryGovernanceStore(), persistenceReads),
      customerIdentityAdmission: { enabled: true },
      authorityControlledExecution: {
        grantCapability: new KernelGrantCapability({ declaration: {} }),
        executionAdapterRouting: { adapters: [], genericHttpAdapters: [genericOptions()], selectAdapter: () => GENERIC_ID },
        resolveAuthorityBinding: () => NO_TEMPORAL_BOUND,
      },
      governedActionOrchestrator: { enabled: true, trustDomainId: TRUST_DOMAIN_ID, grantPolicy: EVALUATED_AT_POLICY },
    });
    enterprises.push(enterprise);
    assert.ok(persistenceReads.includes('appendEvaluation'));
  });

  it('a non-array genericHttpAdapters is refused', async () => {
    await assert.rejects(
      compose({ adapters: [], genericHttpAdapters: { adapterId: GENERIC_ID } as unknown as readonly EnterpriseGenericHttpExecutionAdapterOptions[], selectAdapter: () => GENERIC_ID }),
      (error: unknown) => error instanceof GenericHttpConfigurationError && error.code === 'GENERIC_HTTP_OPTIONS_INVALID',
    );
  });

  it('mutating the host configuration after startup changes nothing the running adapter does', async () => {
    const options = genericOptions() as unknown as { origin: string; path: unknown[] };
    const { enterprise } = await compose({ adapters: [], genericHttpAdapters: [options as unknown as EnterpriseGenericHttpExecutionAdapterOptions], selectAdapter: () => GENERIC_ID });
    options.origin = 'https://evil.example';
    options.path.length = 0;
    await govern(enterprise);
    assert.deepEqual(network.lookups, ['api.erp.example']);
  });
});

describe('Generic HTTP composition — I–J: the selector and the adapter see only the validated action; customers configure nothing', () => {
  it('I. the selector receives exactly a ValidatedExecutionAction', async () => {
    const seen: ValidatedExecutionAction[] = [];
    const { enterprise } = await compose({
      adapters: [],
      genericHttpAdapters: [genericOptions()],
      selectAdapter: (action) => {
        seen.push(action);
        return GENERIC_ID;
      },
    });
    await govern(enterprise);
    assert.equal(seen.length, 1);
    const keys = Object.keys(seen[0] ?? {}).sort();
    assert.deepEqual(keys, ['action', 'boundedGrantId', 'correlation', 'notAfter', 'organization', 'resource', 'subject'].sort());
    assert.equal(seen[0]?.subject, PMFREAK_ACTOR_ID, 'the subject is the grant holder, from the store');
  });

  for (const field of ['url', 'origin', 'host', 'endpoint', 'method', 'headers', 'credential', 'providerPayload', 'adapterId', 'provider']) {
    it(`J. a customer intent carrying '${field}' is rejected at validation: 0 provider calls, 0 generic HTTP attempts`, async () => {
      const custom = namedAdapter('adapter-a');
      const { enterprise } = await compose({ adapters: [custom], genericHttpAdapters: [genericOptions()], selectAdapter: () => GENERIC_ID });
      const response = await govern(enterprise, { ...ALLOWED_INTENT, idempotencyKey: `key-field-${field}`, [field]: field === 'headers' ? { Host: 'evil.example' } : 'https://evil.example/' });
      assert.equal(response.body.status, 'rejected');
      assert.deepEqual([...response.body.reasonCodes], [R.GOVERNED_ACTION_INTENT_INVALID]);
      assert.equal(custom.callCount, 0);
      assert.equal(network.lookups.length, 0);
      assert.equal(network.sockets, 0);
      assert.equal(network.httpRequests, 0);
    });
  }

  it('J. no AocEnterprise member exposes Generic HTTP configuration, and the credential is nowhere in results, records, logs, events or health', async () => {
    const { enterprise, persistence, logs, events } = await compose({ adapters: [], genericHttpAdapters: [genericOptions()], selectAdapter: () => GENERIC_ID });
    const response = await govern(enterprise);
    const record = await persistence.getByRequestId({ system: true }, response.body.requestId ?? '');
    const health = await enterprise.health();
    for (const [label, value] of [
      ['result', response],
      ['record', record],
      ['logs', logs],
      ['events', events],
      ['health', health],
    ] as const) {
      const serialized = JSON.stringify(value);
      assert.equal(serialized.includes(TOKEN), false, `${label} must not carry the credential`);
      assert.equal(serialized.includes(SECRET), false, `${label} must not carry the customer API key`);
      if (label === 'result') assert.equal(serialized.includes(GENERIC_ID), false, 'no adapter identity reaches the customer');
    }
    for (const key of Object.keys(enterprise)) assert.equal(/generic|http.*adapter/i.test(key), false, `AocEnterprise.${key} must not expose adapter configuration`);
  });
});

describe('Generic HTTP composition — K: the adapter-scoped emergency stop blocks the generic child before any network attempt', () => {
  it('a stop on the generic adapter withholds it; releasing it lets the same child run again', async () => {
    const custom = namedAdapter('adapter-a');
    const { enterprise } = await compose(
      { adapters: [custom], genericHttpAdapters: [genericOptions()], selectAdapter: () => GENERIC_ID },
      { emergencyControl: { enabled: true } },
    );
    const control = enterprise.emergencyControlAdministration;
    assert.ok(control !== undefined);
    control.activate({ scope: 'adapter', value: GENERIC_ID, issuerRef: ISSUER, declaredAt: AT });

    const stopped = await govern(enterprise);
    assert.equal(stopped.body.status, 'withheld');
    assert.equal(stopped.body.status === 'withheld' ? stopped.body.withheldBy : undefined, 'emergency-control');
    assert.deepEqual([...stopped.body.reasonCodes], [EMERGENCY_CONTROL_REASON_CODES.EMERGENCY_CONTROL_ACTIVE]);
    assert.equal(network.lookups.length, 0, 'the generic child was never invoked: no DNS');
    assert.equal(network.sockets, 0);
    assert.equal(custom.callCount, 0);

    control.release({ scope: 'adapter', value: GENERIC_ID, issuerRef: ISSUER, releasedAt: AT });
    const resumed = await govern(enterprise, { ...ALLOWED_INTENT, idempotencyKey: 'key-after-release' });
    assert.equal(resumed.body.status, 'execution_failed', 'released, the child runs and meets its own address policy');
    assert.deepEqual(network.lookups, ['api.erp.example'], 'non-vacuity: the same child does reach DNS once the stop is released');
  });

  it('the generic module holds no emergency-control reader of its own', async () => {
    const { readFileSync } = await import('node:fs');
    for (const name of ['generic-http-execution-adapter.ts', 'node-https-transport.ts', 'configuration.ts', 'request-mapper.ts']) {
      assert.equal(/EmergencyControl/.test(readFileSync(`src/enterprise/execution-adapters/generic-http/${name}`, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')), false);
    }
  });
});

describe('Generic HTTP — §44: the full governed path reaches the mapping, and the provider receives only proven values', () => {
  interface Sent {
    readonly request: GenericHttpWireRequest;
  }

  function runtime(status: number, providerRefValues: readonly string[] = ['prov-ref-1']): GenericHttpNetworkRuntime & { readonly sent: Sent[]; readonly resolved: string[] } {
    const sent: Sent[] = [];
    const resolved: string[] = [];
    return {
      sent,
      resolved,
      async resolve(hostname) {
        resolved.push(hostname);
        return { kind: 'resolved', answers: [{ address: '93.184.216.34', family: 4 }] };
      },
      async send(request) {
        sent.push({ request });
        return { kind: 'response', status, providerRefValues };
      },
    };
  }

  function world(status: number, providerRefValues?: readonly string[], overrides: Record<string, unknown> = {}) {
    const net = runtime(status, providerRefValues);
    const generic = createGenericHttpExecutionAdapterCore(snapshotGenericHttpOptions(genericOptions(overrides)), net);
    const registry = createExecutionAdapterRegistry({ adapterId: 'router', adapters: [generic], selectAdapter: () => GENERIC_ID });
    return { net, governed: buildGovernedWorld({ executionAdapter: registry }) };
  }

  it('Kernel → committed decision → grant → claim → re-read → registry → mapping → one request carrying only validated fields', async () => {
    const { net, governed } = world(201);
    const result = await governed.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
    assert.equal(result.status, 'executed', JSON.stringify(result));
    assert.equal(result.status === 'executed' ? result.providerRef : undefined, 'prov-ref-1');
    assert.equal(net.sent.length, 1);
    assert.deepEqual(net.resolved, ['api.erp.example']);

    const request = net.sent[0]?.request;
    assert.ok(request !== undefined);
    assert.equal(request.hostname, 'api.erp.example');
    assert.equal(request.path, '/v1/actions');
    assert.equal(request.method, 'POST');
    assert.equal(request.headers.find(([name]) => name === 'idempotency-key')?.[1], result.executionId, 'the provider idempotency value is the server-derived execution id');
    assert.deepEqual(JSON.parse(request.body ?? ''), { action: ALLOWED_INTENT.action, resource: ALLOWED_INTENT.resource, subject: PMFREAK_ACTOR_ID, organization: ORG });

    const everything = JSON.stringify(request);
    const grantId = (await governed.store.getByRequestId({ system: false, organizationId: ORG }, result.requestId ?? ''))?.references.find((reference) => reference.referenceType === 'authorization_artifact')?.externalId;
    assert.ok(grantId !== undefined);
    assert.equal(everything.includes(grantId), false, 'boundedGrantId never reaches the provider');
    for (const asserted of Object.values(ALLOWED_INTENT.assertedContext)) assert.equal(everything.includes(String(asserted)), false, 'assertedContext never reaches the provider');
    assert.equal(everything.includes(ALLOWED_INTENT.idempotencyKey), false, 'the customer idempotency key is not a provider value');

    const log = governed.log.entries;
    assert.ok(log.indexOf('kernel.evaluate') < log.indexOf('store.appendEvaluation'));
    assert.ok(log.indexOf('store.appendEvaluation') < log.indexOf('grantStore.issue'));
    assert.ok(log.indexOf('grantStore.issue') < log.indexOf('store.appendReference:execution_record:attempt'));
  });

  it('a 500 is execution_unconfirmed, recorded against the generic child, replayed without a second request, and never carries the credential', async () => {
    const { net, governed } = world(500);
    const result = await governed.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
    assert.equal(result.status, 'execution_unconfirmed');
    assert.deepEqual([...result.reasonCodes], [R.GOVERNED_ACTION_EXECUTION_OUTCOME_UNCONFIRMED]);
    const record = await governed.store.getByRequestId({ system: false, organizationId: ORG }, result.requestId ?? '');
    assert.ok(record !== null);
    assert.ok(record.references.some((reference) => reference.externalVersion === `execution-unconfirmed@${GENERIC_ID}`));

    const replay = await governed.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
    assert.equal(replay.status, 'execution_unconfirmed');
    assert.equal(net.sent.length, 1, 'replay never contacts the provider again');

    for (const value of [result, replay, record, governed.events]) assert.equal(JSON.stringify(value).includes(TOKEN), false);
  });

  it('a 302 is execution_unconfirmed — never a definite failure — recorded against the child, and replay does not contact the provider again', async () => {
    const redirected = world(302);
    const redirect = await redirected.governed.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
    assert.equal(redirect.status, 'execution_unconfirmed');
    assert.deepEqual([...redirect.reasonCodes], [R.GOVERNED_ACTION_EXECUTION_OUTCOME_UNCONFIRMED]);
    const record = await redirected.governed.store.getByRequestId({ system: false, organizationId: ORG }, redirect.requestId ?? '');
    assert.ok(record !== null);
    assert.ok(record.references.some((reference) => reference.externalVersion === `execution-unconfirmed@${GENERIC_ID}`));
    assert.equal(record.references.some((reference) => reference.externalVersion?.startsWith('execution-failed') === true), false);

    const replay = await redirected.governed.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
    assert.equal(replay.status, 'execution_unconfirmed');
    assert.deepEqual([...replay.reasonCodes], [R.GOVERNED_ACTION_EXECUTION_OUTCOME_UNCONFIRMED]);
    assert.equal(redirected.net.sent.length, 1, 'one request in total: the redirect was not followed and the replay sent nothing');
  });

  it('16. a provider reflecting the configured credential into the providerRef header: still executed, providerRef absent, no credential anywhere', async () => {
    const API_KEY = 'p6-composition-api-key-secret-123';
    for (const [label, overrides, reflected] of [
      ['bearer token', {}, `ref-${TOKEN}`],
      ['full bearer value', {}, `Bearer ${TOKEN}`],
      ['header credential', { credential: { kind: 'header', name: 'X-API-Key', value: API_KEY } }, `prefix-${API_KEY}-suffix`],
    ] as const) {
      for (const status of [200, 201]) {
        const { net, governed } = world(status, [reflected], overrides);
        const result = await governed.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
        assert.equal(result.status, 'executed', `${label} ${status}`);
        assert.equal('providerRef' in result, false, `${label}: the reflected reference is omitted, not redacted`);
        assert.equal(mapGovernedActionResultToHttpStatus(result), 200);
        assert.equal(net.sent.length, 1);
        const record = await governed.store.getByRequestId({ system: false, organizationId: ORG }, result.requestId ?? '');
        for (const value of [result, record, governed.events]) {
          const serialized = JSON.stringify(value);
          assert.equal(serialized.includes(TOKEN), false, `${label}: no bearer token in the result, record or events`);
          assert.equal(serialized.includes(API_KEY), false, `${label}: no API key in the result, record or events`);
        }
      }
    }
  });

  it('a safe providerRef still reaches the governed-action result', async () => {
    const { governed } = world(201, ['req-2026-0001']);
    const result = await governed.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
    assert.equal(result.status === 'executed' ? result.providerRef : undefined, 'req-2026-0001');
  });

  it('a 202 Accepted is execution_unconfirmed, not executed', async () => {
    const accepted = world(202);
    const result = await accepted.governed.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
    assert.equal(result.status, 'execution_unconfirmed');
    assert.deepEqual([...result.reasonCodes], [R.GOVERNED_ACTION_EXECUTION_OUTCOME_UNCONFIRMED]);
  });

  it('a 404 stays execution_failed / PROVIDER_REJECTED', async () => {
    const rejected = world(404);
    const reject = await rejected.governed.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
    assert.equal(reject.status, 'execution_failed');
    assert.equal(reject.status === 'execution_failed' ? reject.failure : undefined, 'PROVIDER_REJECTED');
    assert.equal(rejected.net.sent.length, 1);
  });
});
