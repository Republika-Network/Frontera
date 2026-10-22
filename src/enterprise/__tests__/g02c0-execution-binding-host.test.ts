import dns from 'node:dns';
import diagnosticsChannel from 'node:diagnostics_channel';
import { join } from 'node:path';
import { after, afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { ExecutionAdapter, ValidatedExecutionAction } from '../../features/execution-runtime/index.js';
import { snapshotGenericHttpOptions } from '../execution-adapters/generic-http/configuration.js';
import type { EnterpriseGenericHttpExecutionAdapterOptions } from '../execution-adapters/generic-http/contracts.js';
import { GENERIC_HTTP_REQUEST_BINDING_FORMAT, genericHttpRequestBinding } from '../execution-adapters/generic-http/request-binding.js';
import { mapGenericHttpRequest } from '../execution-adapters/generic-http/request-mapper.js';
import { createExecutionCapabilityVerifier, executionCapabilityActionBindingDigest } from '../execution-capability/index.js';
import { openExecutionCapabilityIssuanceLedger } from '../execution-capability-issuance/index.js';
import { bootEnterpriseHost } from '../host/enterprise-host.js';
import { EnterpriseHostConfigurationError } from '../host/host-configuration.js';
import { AUTHORITY_KEY_A, trustedKeyOf } from './authority-authenticity-fixture.js';
import { ACTIONS, ADAPTER_ID, ADMIN, ORG, PAYABLES, PAYABLES_WORLD, SETTLE, TRUST_DOMAIN, Workspace, call, createContextTable, govern, governedFile, policyPackProvider, provision, secureEnv, settle, storedGrant } from './core04-host-fixture.js';
import { withDeploymentWitness } from './core07-freshness-fixture.js';

/**
 * G-02C0 on the canonical shipped Host (production profile, SQLite, signed
 * grants, CORE-07 witness, software custody): a Generic HTTP adapter listed in
 * `executionCapabilities.adapters` binds its request to a capability issued
 * through the real authenticated grant store, custody and issuance ledger, and
 * verifies it before DNS. DNS is stubbed to answer a private address, so the
 * adapter's own address policy refuses after the gate and **no socket is ever
 * opened**: what is observed is that the gate proceeded (one lookup, one
 * issued row bound to the exact request), not a provider call.
 */

const ISSUER = 'frontera-deployment-g02c0-host';
const AUDIENCE = 'executor-payables-gateway';
const GATED = 'payables.http';
const HOSTNAME = 'payables-gateway.example';

const workspace = new Workspace();
const network = { lookups: [] as string[], sockets: 0 };
const onSocket = (): void => {
  network.sockets += 1;
};
diagnosticsChannel.subscribe('net.client.socket', onSocket);
const realLookup = dns.promises.lookup;
beforeEach(() => {
  network.lookups.length = 0;
  network.sockets = 0;
  (dns.promises as { lookup: unknown }).lookup = async (hostname: string) => {
    network.lookups.push(hostname);
    return [{ address: '10.20.30.40', family: 4 }];
  };
});
afterEach(() => {
  (dns.promises as { lookup: unknown }).lookup = realLookup;
});
after(async () => {
  diagnosticsChannel.unsubscribe('net.client.socket', onSocket);
  await workspace.cleanup();
});

const ADAPTER_OPTIONS = {
  adapterId: GATED,
  origin: `https://${HOSTNAME}`,
  method: 'POST',
  path: [{ kind: 'literal', value: 'v1' }, { kind: 'literal', value: 'settlements' }],
  headers: { 'Idempotency-Key': { kind: 'source', source: 'correlation.executionId' } },
  body: { kind: 'json-object', fields: { resource: { kind: 'source', source: 'resource' }, subject: { kind: 'source', source: 'subject' } } },
  timeoutMs: 2000,
} as const;

function file(dir: string, capabilities: Record<string, unknown> = {}): Record<string, unknown> {
  return governedFile({
    genericHttpAdapters: [ADAPTER_OPTIONS],
    routes: ACTIONS.map((action) => ({ action, adapterId: action === SETTLE ? GATED : ADAPTER_ID })),
    executionCapabilities: {
      issuer: ISSUER,
      issuanceLedgerPath: join(dir, 'execution-capability-issuance.sqlite'),
      audiences: [{ audience: AUDIENCE, actions: [SETTLE], bindingFormats: [GENERIC_HTTP_REQUEST_BINDING_FORMAT] }],
      adapters: [{ adapterId: GATED, audience: AUDIENCE }],
      ...capabilities,
    },
  });
}

async function initializeLedger(dir: string): Promise<void> {
  (await openExecutionCapabilityIssuanceLedger(join(dir, 'execution-capability-issuance.sqlite'), { issuer: ISSUER, clock: Date.now, create: true })).close();
}

async function bootWith(env: Record<string, string | undefined>) {
  const calls: ValidatedExecutionAction[] = [];
  const adapter: ExecutionAdapter = {
    adapterId: ADAPTER_ID,
    async execute(action) {
      calls.push(action);
      return { outcome: 'completed', providerRef: `provider-ref-${calls.length}` };
    },
  };
  const context = createContextTable();
  const host = workspace.track(await bootEnterpriseHost({ env: await withDeploymentWitness(env), executionAdapters: [adapter], contextProvider: context.provider, policyPackProvider: policyPackProvider() }));
  const { port } = await host.listen();
  return { host, calls, context, baseUrl: `http://127.0.0.1:${port}` };
}

describe('G-02C0 on the shipped Host — a listed Generic HTTP adapter binds every request before DNS', () => {
  it('the gate issues one capability for the exact request, verifies it and proceeds; the adapter then meets its own address policy — no socket', async () => {
    const dir = workspace.dir();
    await initializeLedger(dir);
    const booted = await bootWith(secureEnv(dir, file(dir)));
    await provision(booted.host);
    booted.context.set(PAYABLES_WORLD);
    const reply = await govern(booted.baseUrl, settle());
    assert.equal(reply.body['status'], 'execution_failed', reply.text);
    assert.equal(reply.body['failure'], 'ADAPTER_ERROR');
    assert.deepEqual(network.lookups, [HOSTNAME], 'the gate proceeded: the adapter resolved its pinned hostname once');
    assert.equal(network.sockets, 0, 'the private answer was refused: nothing left the process');
    assert.equal(JSON.stringify(reply.body).toLowerCase().includes('capabilit'), false, 'the response carries no capability');

    const executionId = reply.body['executionId'] as string;
    const lookup = await call(booted.baseUrl, 'GET', `/api/admin/authority/executions/${encodeURIComponent(executionId)}`, { authorization: ADMIN });
    assert.equal(lookup.status, 200, lookup.text);
    const grant = storedGrant(dir, lookup.body['grantId'] as string);

    const ledger = await openExecutionCapabilityIssuanceLedger(join(dir, 'execution-capability-issuance.sqlite'), { issuer: ISSUER, clock: Date.now });
    try {
      const record = ledger.read(executionId);
      assert.ok(record.state === 'issued' && record.signature !== undefined, 'issued through the Host’s authenticated store and custody');
      assert.equal(record.capability.audience, AUDIENCE);
      assert.equal(record.capability.executionId, executionId);
      // The request the adapter built (it reads only resource, subject and execution id), recomputed independently.
      const plan = snapshotGenericHttpOptions(ADAPTER_OPTIONS as unknown as EnterpriseGenericHttpExecutionAdapterOptions);
      const action = { boundedGrantId: grant.id, subject: grant.subject, action: SETTLE, resource: PAYABLES, notAfter: grant.expiresAt, correlation: { requestId: grant.correlation.requestId, decisionId: grant.correlation.decisionId, executionId } } as ValidatedExecutionAction;
      const mapped = mapGenericHttpRequest(plan, action);
      assert.ok(mapped.ok);
      const value = genericHttpRequestBinding(plan, mapped.request);
      assert.equal(record.capability.actionBinding.digest, executionCapabilityActionBindingDigest({ format: GENERIC_HTTP_REQUEST_BINDING_FORMAT, value }));
      const executor = createExecutionCapabilityVerifier({ trustedIssuers: [{ issuer: ISSUER, keys: [trustedKeyOf(AUTHORITY_KEY_A)] }], executor: { audience: AUDIENCE, organizationIds: [ORG], trustDomain: TRUST_DOMAIN }, clock: () => Date.parse(record.capability.issuedAt) + 1_000 });
      assert.equal(executor.verify({ presentation: { capability: record.canonical, signature: record.signature }, action: SETTLE, resource: PAYABLES, actionBinding: { format: GENERIC_HTTP_REQUEST_BINDING_FORMAT, value } }).verification, 'verified');
    } finally {
      ledger.close();
    }

  });

  it('an adapter not listed is unchanged: no issuance, the routed child executes as before', async () => {
    const dir = workspace.dir();
    await initializeLedger(dir);
    const booted = await bootWith(secureEnv(dir, file(dir, { adapters: [] })));
    await provision(booted.host);
    booted.context.set(PAYABLES_WORLD);
    const reply = await govern(booted.baseUrl, settle());
    assert.equal(reply.body['status'], 'execution_failed', reply.text);
    assert.deepEqual(network.lookups, [HOSTNAME]);
    const ledger = await openExecutionCapabilityIssuanceLedger(join(dir, 'execution-capability-issuance.sqlite'), { issuer: ISSUER, clock: Date.now });
    try {
      assert.equal(ledger.read(reply.body['executionId'] as string).state, 'absent', 'no gate, no capability');
    } finally {
      ledger.close();
    }
  });
});

describe('G-02C0 on the shipped Host — executionCapabilities.adapters is validated at boot', () => {
  async function refused(env: Record<string, string | undefined>): Promise<unknown> {
    try {
      await bootWith(env);
    } catch (error) {
      return error;
    }
    return undefined;
  }

  const invalid: readonly [string, Record<string, unknown>][] = [
    ['an adapter that is not a configured Generic HTTP adapter', { adapters: [{ adapterId: ADAPTER_ID, audience: AUDIENCE }] }],
    ['the same adapter twice', { adapters: [{ adapterId: GATED, audience: AUDIENCE }, { adapterId: GATED, audience: AUDIENCE }] }],
    ['an unregistered audience', { adapters: [{ adapterId: GATED, audience: 'executor-unknown' }] }],
    ['an audience without the HTTP binding format', { audiences: [{ audience: AUDIENCE, actions: [SETTLE], bindingFormats: ['frontera.other-binding.v1'] }] }],
    ['an audience that does not permit an action routed to the adapter', { audiences: [{ audience: AUDIENCE, actions: [ACTIONS.find((action) => action !== SETTLE) as string], bindingFormats: [GENERIC_HTTP_REQUEST_BINDING_FORMAT] }] }],
    ['an extra key', { adapters: [{ adapterId: GATED, audience: AUDIENCE, presentHeader: 'x-capability' }] }],
    ['a non-array', { adapters: { adapterId: GATED, audience: AUDIENCE } }],
  ];
  for (const [name, capabilities] of invalid) {
    it(`refuses ${name} (HOST_GOVERNED_ACTIONS_FILE_INVALID)`, async () => {
      const dir = workspace.dir();
      await initializeLedger(dir);
      const error = await refused(secureEnv(dir, file(dir, capabilities)));
      assert.ok(error instanceof EnterpriseHostConfigurationError && error.code === 'HOST_GOVERNED_ACTIONS_FILE_INVALID', String(error));
      assert.equal(network.lookups.length + network.sockets, 0);
    });
  }
});
