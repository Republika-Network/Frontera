import dns from 'node:dns';
import https from 'node:https';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { after, afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { ExecutionAdapter, ValidatedExecutionAction } from '../../features/execution-runtime/index.js';
import { GENERIC_HTTP_REQUEST_BINDING_FORMAT } from '../execution-adapters/generic-http/request-binding.js';
import { openExecutionCapabilityIssuanceLedger } from '../execution-capability-issuance/index.js';
import { openExecutionReceiptEvidenceStore } from '../execution-receipt-evidence/index.js';
import { bootEnterpriseHost, type EnterpriseHost } from '../host/enterprise-host.js';
import { buildDurableAuthorityPayloads, DURABLE_FIXTURE_OPERATOR } from '../kernel-authority/fixtures/durable-authority.fixture.js';
import { AUTHORITY_KEY_A, trustedKeyOf } from './authority-authenticity-fixture.js';
import { ACTIONS, ADAPTER_ID, ADMIN, AGENT, AGENT_SUBJECT, GOVERNANCE, ORG, OWNER, PRODUCTION, RESOURCES, TRUST_DOMAIN, Workspace, call, createContextTable, govern, governedFile, nextKey, policyPackProvider, secureEnv } from './core04-host-fixture.js';
import { withDeploymentWitness } from './core07-freshness-fixture.js';
import { CREDENTIAL_TOKEN } from './g02c0-execution-binding-fixture.js';
import { rawExchange } from './g02c1a-reference-executor-fixture.js';
import { E2E_EXECUTOR_ID, E2E_RECEIPT_KEY_ID, afterObservers, eventually, executorDomain, loopbackHostPrimitive, spawnE2EExecutor, startRelay, type ExecutorDomain, type Relay } from './g02c1d-end-to-end-fixture.js';

/**
 * G-02C1D on the canonical shipped Host (production profile, SQLite, signed
 * grants, CORE-07 witness, software custody) against the reference executor in
 * its own process: an authenticated customer request → Kernel policy → a
 * BoundedGrant → the claimed execution → the Generic HTTP mapping → G-02C0
 * binding and G-02B issuance → the one presentation header → executor
 * verification, durable consumption, one synthetic effect, a durable signed
 * receipt → the receipt header → Host verification against the pinned
 * executor, correlation with the Host's own issuance ledger → the evidence
 * store. P11 records the adapter's outcome exactly as before; P12 is untouched.
 *
 * Network, test-only: the adapter's resolver is stubbed to answer one public
 * documentation address for the executor's hostname, and `node:https`'s
 * request is replaced — for that hostname alone — by plain HTTP to a local
 * relay in front of the executor. There is no TLS, no public DNS and no
 * address-policy decision over a real answer; the transport's connect-address
 * check is not exercised (the relay is a Unix socket). Everything else is the
 * shipped code path.
 */

const ISSUER = 'frontera-deployment-g02c1d-host';
const AUDIENCE = 'executor-synthetic-gateway';
const GATED = 'synthetic.http';
const HOSTNAME = 'synthetic-executor.example';
const SYNTHETIC = 'synthetic.deploy-release';
const TOKEN_ENV = 'G02C1A_GATEWAY_TOKEN';
/** The Host reads the adapter credential from its environment, by name, never from the file. */
const CREDENTIAL_ENV = 'FRONTERA_TEST_G02C1D_EXECUTOR_TOKEN';
const envFor = (dir: string, governed: Record<string, unknown>) => ({ ...secureEnv(dir, governed), [CREDENTIAL_ENV]: CREDENTIAL_TOKEN });

const workspace = new Workspace();
const cleanups: (() => void | Promise<void>)[] = [];
after(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  await workspace.cleanup();
});

// Test-only network: the gated adapter's hostname resolves to a public documentation address, and its HTTPS request goes,
// as plain HTTP, to the relay in front of the executor. Every other lookup and request is the real one.
let route: { readonly path: string } | undefined;
const realLookup = dns.promises.lookup;
const realRequest = https.request;
beforeEach(() => {
  (dns.promises as { lookup: unknown }).lookup = async (hostname: string, options?: unknown) => (hostname === HOSTNAME ? [{ address: '93.184.216.34', family: 4 }] : (realLookup as (h: string, o?: unknown) => Promise<unknown>)(hostname, options));
  (https as unknown as { request: unknown }).request = (options: { readonly hostname?: string }, onResponse: never) => {
    if (options?.hostname === HOSTNAME && route !== undefined) return loopbackHostPrimitive(route)(options as never, onResponse);
    return (realRequest as unknown as (o: unknown, c: unknown) => unknown)(options, onResponse);
  };
});
afterEach(() => {
  (dns.promises as { lookup: unknown }).lookup = realLookup;
  (https as unknown as { request: unknown }).request = realRequest;
  route = undefined;
});

const ADAPTER_OPTIONS = {
  adapterId: GATED,
  origin: `https://${HOSTNAME}`,
  method: 'POST',
  path: [{ kind: 'literal', value: 'v1' }, { kind: 'literal', value: 'deployments' }, { kind: 'source', source: 'resource' }],
  headers: { 'Idempotency-Key': { kind: 'source', source: 'correlation.executionId' } },
  body: { kind: 'json-object', fields: { release: { kind: 'parameter', dimension: 'releaseVersion' }, subject: { kind: 'source', source: 'subject' } } },
  credential: { kind: 'bearer', tokenEnv: CREDENTIAL_ENV },
  timeoutMs: 5_000,
} as const;

const GOVERNANCE_WITH_SYNTHETIC = {
  ...GOVERNANCE,
  actionClasses: [...(GOVERNANCE.actionClasses ?? []), { id: 'synthetic', actions: [SYNTHETIC] }],
  profiles: [
    ...(GOVERNANCE.profiles ?? []),
    {
      profileId: 'synthetic-deploy',
      version: 1,
      owner: ORG,
      provenance: { authoredBy: 'operator:platform', approvedBy: 'operator:security' },
      actionClass: 'synthetic',
      resourceClass: 'production_environment',
      parameters: [{ dimension: 'releaseVersion', required: true }],
      materialFacts: [],
      relevantPolicies: ['core04-policy'],
    },
  ],
};

function file(dir: string, domain: ExecutorDomain, receiptEvidence: Record<string, unknown> | null = {}): Record<string, unknown> {
  return governedFile({
    governance: GOVERNANCE_WITH_SYNTHETIC,
    genericHttpAdapters: [ADAPTER_OPTIONS],
    routes: [...ACTIONS.map((action) => ({ action, adapterId: ADAPTER_ID })), { action: SYNTHETIC, adapterId: GATED }],
    executionCapabilities: {
      issuer: ISSUER,
      issuanceLedgerPath: join(dir, 'execution-capability-issuance.sqlite'),
      audiences: [{ audience: AUDIENCE, actions: [SYNTHETIC], bindingFormats: [GENERIC_HTTP_REQUEST_BINDING_FORMAT] }],
      adapters: [{ adapterId: GATED, audience: AUDIENCE }],
      ...(receiptEvidence === null
        ? {}
        : {
            receiptEvidence: {
              storePath: join(dir, 'evidence', 'receipt-evidence.sqlite'),
              trustedExecutors: [{ executorId: E2E_EXECUTOR_ID, keys: [{ keyId: E2E_RECEIPT_KEY_ID, algorithm: 'ed25519-v1', publicKeyPem: domain.publicKeyPem }], audiences: [AUDIENCE], organizationIds: [ORG], trustDomains: [TRUST_DOMAIN] }],
              ...receiptEvidence,
            },
          }),
    },
  });
}

/** The operator's one-time initializations: the issuance ledger and the evidence store (in a directory of its own). */
async function initialize(dir: string): Promise<void> {
  (await openExecutionCapabilityIssuanceLedger(join(dir, 'execution-capability-issuance.sqlite'), { issuer: ISSUER, clock: Date.now, create: true })).close();
  mkdirSync(join(dir, 'evidence'), { mode: 0o700 });
  (await openExecutionReceiptEvidenceStore(join(dir, 'evidence', 'receipt-evidence.sqlite'), { issuer: ISSUER, organizationId: ORG, trustDomain: TRUST_DOMAIN, clock: Date.now, create: true })).close();
}

/** The executor pinned to this Host: its issuer and active authority key, its organization and trust domain, the one synthetic action. */
async function executorFor(options: { readonly receipts?: boolean; readonly audience?: string } = {}) {
  const audience = options.audience ?? AUDIENCE;
  const domain = await executorDomain(audience);
  cleanups.push(() => domain.cleanup());
  const executor = await spawnE2EExecutor(domain, {
    audience,
    ...(options.receipts === false ? { receipts: false } : {}),
    overrides: {
      organizationIds: [ORG],
      trustDomain: TRUST_DOMAIN,
      trustedIssuers: [{ issuer: ISSUER, keys: [{ ...trustedKeyOf(AUTHORITY_KEY_A) }] }],
      permittedActions: [SYNTHETIC],
      permittedResources: [PRODUCTION],
      expectedOrigin: `https://${HOSTNAME}`,
      syntheticExecution: { effect: 'frontera.synthetic-deployment-record.v1', consumptionLedgerPath: domain.ledgerPath, outputDirectory: domain.outputDirectory, syntheticActions: [SYNTHETIC] },
    },
  });
  cleanups.push(() => executor.kill());
  assert.equal(executor.environment[TOKEN_ENV], CREDENTIAL_TOKEN, 'the executor expects the credential the Host adapter sends');
  const relay: Relay = await startRelay(domain.root, executor.port);
  cleanups.push(() => relay.close());
  return { domain, executor, relay };
}

async function provision(host: EnterpriseHost): Promise<void> {
  const service = host.enterprise.kernelAuthorityProvisioning;
  assert.ok(service !== undefined);
  const actions = [...ACTIONS, SYNTHETIC];
  const payloads = buildDurableAuthorityPayloads(ORG, TRUST_DOMAIN);
  const operator = DURABLE_FIXTURE_OPERATOR;
  await service.provisionActor(operator, payloads.issuerActor);
  await service.provisionTrustDomain(operator, payloads.trustDomain);
  await service.provisionRootIssuer(operator, payloads.rootIssuer);
  await service.provisionActor(operator, { ...payloads.ownerActor, actorId: OWNER, displayName: 'Owner', externalSubject: { system: 'core04-app', subjectId: 'owner-1' } });
  await service.provisionActor(operator, { ...payloads.agentActor, actorId: AGENT, displayName: 'Agent', externalSubject: AGENT_SUBJECT });
  await service.provisionPassport(operator, { ...payloads.passport, passportId: `passport-${AGENT}`, subjectActorId: AGENT });
  await service.provisionCapabilityToken(operator, { ...payloads.capabilityToken, capabilityTokenId: `cap-${AGENT}`, subjectActorId: AGENT, principalActorId: OWNER, issuerActorId: OWNER, actions, resourceScopes: RESOURCES });
  await service.provisionAuthorityGrant(operator, { ...payloads.authorityGrant, authorityGrantId: 'authority-grant-owner', subjectActorId: OWNER, actions, resourceScopes: RESOURCES });
  await service.provisionDelegationGrant(operator, { ...payloads.delegationGrant, delegationGrantId: 'delegation-agent', delegatorActorId: OWNER, delegateActorId: AGENT, sourceAuthorityGrantId: 'authority-grant-owner', actions, resourceScopes: RESOURCES });
}

/** The adapter the fixture's other routes name; never reached by the synthetic action. */
function recordingAdapter(): ExecutionAdapter {
  const calls: ValidatedExecutionAction[] = [];
  return {
    adapterId: ADAPTER_ID,
    async execute(action) {
      calls.push(action);
      return { outcome: 'completed', providerRef: `provider-ref-${calls.length}` };
    },
  };
}

async function bootWith(dir: string, governed: Record<string, unknown>) {
  const host = workspace.track(await bootEnterpriseHost({ env: await withDeploymentWitness(envFor(dir, governed)), executionAdapters: [recordingAdapter()], contextProvider: createContextTable().provider, policyPackProvider: policyPackProvider() }));
  const { port } = await host.listen();
  await provision(host);
  return { host, baseUrl: `http://127.0.0.1:${port}` };
}

const deploy = (releaseVersion = 'release-42') => ({ action: SYNTHETIC, resource: PRODUCTION, parameters: { releaseVersion } });

async function evidenceOf(dir: string, executionId: string) {
  const store = await openExecutionReceiptEvidenceStore(join(dir, 'evidence', 'receipt-evidence.sqlite'), { issuer: ISSUER, organizationId: ORG, trustDomain: TRUST_DOMAIN, clock: Date.now });
  try {
    return { observations: store.observationsFor(executionId), evidence: store.evidenceFor(executionId) };
  } finally {
    store.close();
  }
}

describe('G-02C1D on the shipped Host — the governed path end to end, with verified receipt evidence', { timeout: 300_000 }, () => {
  it('an authenticated request is governed, granted, bound, presented once, executed once, receipted, verified, correlated and recorded; P11 is unchanged and P12 untouched', async () => {
    const { domain, executor, relay } = await executorFor();
    const dir = workspace.dir();
    await initialize(dir);
    const { host, baseUrl } = await bootWith(dir, file(dir, domain));
    route = relay.target;

    const key = nextKey('g02c1d');
    const reply = await govern(baseUrl, deploy(), key);
    assert.equal(reply.body['status'], 'executed', reply.text);
    assert.equal(JSON.stringify(reply.body).toLowerCase().includes('capabilit'), false, 'the response carries no capability');
    assert.equal(JSON.stringify(reply.body).includes('receipt'), false, 'and no receipt: evidence is not a governed-action result');
    const executionId = reply.body['executionId'] as string;
    assert.equal(relay.requests.length, 1, 'one request reached the executor');
    assert.equal(domain.records().length, 1, 'one synthetic effect');

    const ledger = await openExecutionCapabilityIssuanceLedger(join(dir, 'execution-capability-issuance.sqlite'), { issuer: ISSUER, clock: Date.now });
    let capabilityId: string;
    try {
      const record = ledger.read(executionId);
      assert.ok(record.state === 'issued', 'issued through the Host’s authenticated store and custody');
      capabilityId = record.capabilityId;
    } finally {
      ledger.close();
    }
    assert.equal((await domain.state(capabilityId)).state, 'completed');
    const executorReceipts = await domain.receipts(capabilityId);
    assert.equal(executorReceipts.length, 1);

    // The recorder runs detached, after the result was handed back (and P11 recorded): wait for it.
    await eventually(async () => (await evidenceOf(dir, executionId)).observations.length > 0);
    const { observations, evidence } = await evidenceOf(dir, executionId);
    assert.deepEqual(observations.map((observation) => [observation.disposition, observation.agreement, observation.httpOutcome, observation.receiptOutcome]), [['receipt-correlated', 'consistent', 'completed', 'completed-observed']]);
    assert.equal(evidence[0]?.presented.receipt, executorReceipts[0]?.receipt, 'the executor’s persisted receipt, verbatim, as Host evidence');

    // P11 still records what the adapter classified, and nothing was resolved: the execution reads as executed.
    const lookup = await call(baseUrl, 'GET', `/api/admin/authority/executions/${encodeURIComponent(executionId)}`, { authorization: ADMIN });
    assert.equal(lookup.status, 200, lookup.text);
    assert.equal(JSON.stringify(lookup.body).includes('receipt'), false, 'the authority view is unchanged by evidence');

    // The same request again is answered by governance, without a second presentation, a second effect or a second receipt.
    const replay = await govern(baseUrl, deploy(), key);
    assert.equal(replay.body['status'], 'executed', replay.text);
    assert.equal(replay.body['executionId'], executionId);
    assert.equal(relay.requests.length, 1, 'no second presentation');
    assert.equal(domain.records().length, 1);

    // The captured bytes, presented directly again: consumed once — the executor performs nothing and replays its receipt.
    const again = await rawExchange(executor.port, relay.requests[0] as Buffer);
    assert.equal(again.status, 202);
    assert.equal(domain.records().length, 1);
    await host.close();
  });

  it('an executor serving another audience refuses the capability: the Host records a provider rejection and a missing receipt; nothing is consumed', async () => {
    const { domain, relay } = await executorFor({ audience: 'executor-elsewhere' });
    const dir = workspace.dir();
    await initialize(dir);
    const { baseUrl } = await bootWith(dir, file(dir, domain));
    route = relay.target;
    const reply = await govern(baseUrl, deploy());
    assert.equal(reply.body['status'], 'execution_failed', reply.text);
    assert.equal(reply.body['failure'], 'PROVIDER_REJECTED');
    assert.deepEqual(domain.records(), []);
    await eventually(async () => (await evidenceOf(dir, reply.body['executionId'] as string)).observations.length > 0);
    const { observations, evidence } = await evidenceOf(dir, reply.body['executionId'] as string);
    assert.deepEqual(observations.map((observation) => observation.disposition), ['receipt-missing']);
    assert.deepEqual(evidence, []);
  });

  it('an executor that delivers no receipt: executed by its status, and the evidence says missing — uncertainty, never proof', async () => {
    const { domain, relay } = await executorFor({ receipts: false });
    const dir = workspace.dir();
    await initialize(dir);
    const { baseUrl } = await bootWith(dir, file(dir, domain));
    route = relay.target;
    const reply = await govern(baseUrl, deploy());
    assert.equal(reply.body['status'], 'executed', reply.text);
    assert.equal(domain.records().length, 1);
    await eventually(async () => (await evidenceOf(dir, reply.body['executionId'] as string)).observations.length > 0);
    const { observations } = await evidenceOf(dir, reply.body['executionId'] as string);
    assert.deepEqual(observations.map((observation) => [observation.disposition, observation.agreement]), [['receipt-missing', 'not-comparable']]);
  });

  it('without receiptEvidence a gated adapter still presents and executes exactly as configured, and nothing is recorded', async () => {
    const { domain, relay } = await executorFor();
    const dir = workspace.dir();
    await initialize(dir);
    const { baseUrl } = await bootWith(dir, file(dir, domain, null));
    route = relay.target;
    const reply = await govern(baseUrl, deploy());
    assert.equal(reply.body['status'], 'executed', reply.text);
    await afterObservers();
    const { observations } = await evidenceOf(dir, reply.body['executionId'] as string);
    assert.deepEqual(observations, []);
  });
});

describe('G-02C1D on the shipped Host — receiptEvidence is validated at boot', { timeout: 300_000 }, () => {
  const refusals: readonly [string, (dir: string, domain: ExecutorDomain) => Record<string, unknown>, string][] = [
    ['an unknown field', (dir, domain) => file(dir, domain, { publicKeyUrl: 'https://keys.example/executor' }), 'HOST_GOVERNED_ACTIONS_FILE_INVALID'],
    ['no trusted executor', (dir, domain) => file(dir, domain, { trustedExecutors: [] }), 'HOST_GOVERNED_ACTIONS_FILE_INVALID'],
    ['an executor not permitted this organization', (dir, domain) => file(dir, domain, { trustedExecutors: [{ executorId: E2E_EXECUTOR_ID, keys: [{ keyId: E2E_RECEIPT_KEY_ID, algorithm: 'ed25519-v1', publicKeyPem: domain.publicKeyPem }], audiences: [AUDIENCE], organizationIds: ['org-elsewhere'], trustDomains: [TRUST_DOMAIN] }] }), 'HOST_GOVERNED_ACTIONS_FILE_INVALID'],
    ['two executors pinned for the gated audience', (dir, domain) => {
      const key = { keyId: E2E_RECEIPT_KEY_ID, algorithm: 'ed25519-v1', publicKeyPem: domain.publicKeyPem };
      return file(dir, domain, { trustedExecutors: [
        { executorId: E2E_EXECUTOR_ID, keys: [key], audiences: [AUDIENCE], organizationIds: [ORG], trustDomains: [TRUST_DOMAIN] },
        { executorId: 'reference-executor-second', keys: [{ ...key, keyId: 'g02c1d-second-key', publicKeyPem: trustedKeyOf(AUTHORITY_KEY_A).publicKeyPem }], audiences: [AUDIENCE], organizationIds: [ORG], trustDomains: [TRUST_DOMAIN] },
      ] });
    }, 'HOST_GOVERNED_ACTIONS_FILE_INVALID'],
    ['no executor for the gated audience', (dir, domain) => file(dir, domain, { trustedExecutors: [{ executorId: E2E_EXECUTOR_ID, keys: [{ keyId: E2E_RECEIPT_KEY_ID, algorithm: 'ed25519-v1', publicKeyPem: domain.publicKeyPem }], audiences: ['executor-elsewhere'], organizationIds: [ORG], trustDomains: [TRUST_DOMAIN] }] }), 'HOST_GOVERNED_ACTIONS_FILE_INVALID'],
  ];
  for (const [label, governed, code] of refusals) {
    it(`refuses ${label} (${code})`, async () => {
      const domain = await executorDomain(AUDIENCE);
      cleanups.push(() => domain.cleanup());
      const dir = workspace.dir();
      await initialize(dir);
      await assert.rejects(bootEnterpriseHost({ env: await withDeploymentWitness(envFor(dir, governed(dir, domain))), executionAdapters: [recordingAdapter()], policyPackProvider: policyPackProvider() }), (error: { readonly code?: string }) => error.code === code);
    });
  }

  it('refuses an authority key pinned as an executor receipt key, and an evidence store that was never initialized', async () => {
    const domain = await executorDomain(AUDIENCE);
    cleanups.push(() => domain.cleanup());
    const authority = trustedKeyOf(AUTHORITY_KEY_A);
    const dir = workspace.dir();
    await initialize(dir);
    const asExecutor = file(dir, domain, { trustedExecutors: [{ executorId: E2E_EXECUTOR_ID, keys: [{ keyId: 'g02c1d-executor-key-borrowed', algorithm: 'ed25519-v1', publicKeyPem: authority.publicKeyPem }], audiences: [AUDIENCE], organizationIds: [ORG], trustDomains: [TRUST_DOMAIN] }] });
    await assert.rejects(bootEnterpriseHost({ env: await withDeploymentWitness(envFor(dir, asExecutor)), executionAdapters: [recordingAdapter()], policyPackProvider: policyPackProvider() }), /may not be an authority key/);
    const fresh = workspace.dir();
    (await openExecutionCapabilityIssuanceLedger(join(fresh, 'execution-capability-issuance.sqlite'), { issuer: ISSUER, clock: Date.now, create: true })).close();
    mkdirSync(join(fresh, 'evidence'), { mode: 0o700 });
    await assert.rejects(bootEnterpriseHost({ env: await withDeploymentWitness(envFor(fresh, file(fresh, domain))), executionAdapters: [recordingAdapter()], policyPackProvider: policyPackProvider() }), /never created implicitly/, 'the Host never creates the evidence store');
  });
});
