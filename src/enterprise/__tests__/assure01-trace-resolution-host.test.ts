import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createRecordingExecutionAdapter, type RecordingExecutionAdapter } from '../../features/execution-runtime/tests/execution-fixture.js';
import { KernelGrantCapability } from '../../kernel/orchestration/grant-adapter.js';
import { loadEnterpriseConfiguration, type EnterpriseApiKey } from '../configuration/enterprise-configuration.js';
import type { GrantAuthorityBinding } from '../execution-governance/index.js';
import type { ExecutionResolutionAuthority, ExecutionResolutionQuery } from '../execution-reconciliation/index.js';
import { createEnterpriseServer, type EnterpriseServer } from '../host/enterprise-server.js';
import { buildDurableAuthorityPayloads, DURABLE_FIXTURE_OPERATOR } from '../kernel-authority/fixtures/durable-authority.fixture.js';
import type { KernelAuthorityStore } from '../kernel-authority/kernel-authority-store.js';
import { createSqliteKernelAuthorityStore } from '../kernel-authority/sqlite-kernel-authority-store.js';
import { authorityAuthenticityEnv } from './authority-authenticity-fixture.js';

/**
 * ASSURE-01 — the P12 cases of the trace: *execution initially unconfirmed,
 * then resolved*.
 *
 * The shipped Host composes no resolution authority (Master Plan §3.8: no
 * resolver ships), so these cases run on the one composition that has one —
 * an embedder's `createEnterpriseServer({ executionReconciliation })`, the same
 * composition root, served over a real loopback listener. The governed action
 * is a real HTTP request; the reconciliation is the trusted in-process P12
 * service (it has no route, by design); the third party — an auditor's
 * organization-scoped key — fetches and verifies the trace over HTTP only.
 */

const ORG = 'org-assure01-p12';
const TRUST_DOMAIN = 'trust-domain-assure01-p12';
const ACTION = 'transfer-funds';
const RESOURCE = 'operating-account';
const AGENT = 'agent-assure01';
const OWNER = 'owner-assure01';
const SUBJECT = { system: 'assure01-app', subjectId: 'agent-assure01' } as const;
const CUSTOMER = 'ASSURE01_P12_CUSTOMER_KEY_SENTINEL_9f2c41';
const AUDITOR_KEY = 'ASSURE01_P12_AUDITOR_KEY_SENTINEL_51d7e0';
const KEYS: readonly EnterpriseApiKey[] = [
  { key: CUSTOMER, organizationId: ORG, customerIdentity: { principalId: 'principal-assure01', externalSubject: SUBJECT } },
  { key: AUDITOR_KEY, organizationId: ORG },
];
const AUDITOR = `Bearer ${AUDITOR_KEY}`;
const NO_TEMPORAL_BOUND: GrantAuthorityBinding = { kind: 'no-temporal-authority-bound', sourceKind: 'organizational-authority', justification: 'Durable Kernel Authority; no mandate window.' };

const directories: string[] = [];
const closers: (() => Promise<void>)[] = [];
after(async () => {
  for (const close of closers.reverse()) await close().catch(() => {});
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

interface Resolver extends ExecutionResolutionAuthority {
  readonly queries: ExecutionResolutionQuery[];
  answer: unknown;
}
function resolver(): Resolver {
  const queries: ExecutionResolutionQuery[] = [];
  const scripted: Resolver = {
    authorityId: 'resolver-assure01',
    queries,
    answer: { outcome: 'unresolved' },
    async resolve(query) {
      queries.push(query);
      return scripted.answer as never;
    },
  };
  return scripted;
}

interface Served {
  readonly server: EnterpriseServer;
  readonly baseUrl: string;
  readonly adapter: RecordingExecutionAdapter;
  readonly authorityStore: KernelAuthorityStore;
  close(): Promise<void>;
}

async function serve(dir: string, authority: Resolver, provisionWorld: boolean): Promise<Served> {
  const authorityStore = await createSqliteKernelAuthorityStore(join(dir, 'kernel-authority.sqlite'));
  const configuration = loadEnterpriseConfiguration({
    AOC_ENTERPRISE_PERSISTENCE_PROVIDER: 'sqlite',
    AOC_ENTERPRISE_REQUIRE_AUTH: 'true',
    AOC_ENTERPRISE_HTTP_HOST: '127.0.0.1',
    AOC_ENTERPRISE_HTTP_PORT: '0',
    ...authorityAuthenticityEnv(),
    AOC_ENTERPRISE_SQLITE_PATH: join(dir, 'governance.sqlite'),
    AOC_ENTERPRISE_PASSPORT_SQLITE_PATH: join(dir, 'passport.sqlite'),
    AOC_ENTERPRISE_ASSURANCE_SQLITE_PATH: join(dir, 'assurance.sqlite'),
    AOC_ENTERPRISE_BOUNDED_GRANT_SQLITE_PATH: join(dir, 'bounded-grants.sqlite'),
    AOC_ENTERPRISE_EXERCISE_LEDGER_SQLITE_PATH: join(dir, 'exercise-ledger.sqlite'),
    AOC_ENTERPRISE_EXECUTION_OUTCOME_SQLITE_PATH: join(dir, 'execution-outcomes.sqlite'),
    AOC_ENTERPRISE_EXECUTION_RESOLUTION_SQLITE_PATH: join(dir, 'execution-resolutions.sqlite'),
    AOC_ENTERPRISE_AUTHORITY_EVENT_STREAM_SQLITE_PATH: join(dir, 'authority-event-stream.sqlite'),
    AOC_ENTERPRISE_EVIDENCE_SQLITE_PATH: join(dir, 'evidence-bundles.sqlite'),
    AOC_ENTERPRISE_KERNEL_AUTHORITY_ORGANIZATION_ID: ORG,
  });
  const adapter = createRecordingExecutionAdapter(() => ({ outcome: 'unconfirmed', providerRef: 'job-assure01' }));
  const server = await createEnterpriseServer({
    configuration: { ...configuration, authentication: { apiKeys: KEYS } },
    kernelAuthorityStore: authorityStore,
    customerIdentityAdmission: { enabled: true },
    authorityControlledExecution: {
      grantCapability: new KernelGrantCapability({ declaration: {} }),
      executionAdapter: adapter,
      resolveAuthorityBinding: () => NO_TEMPORAL_BOUND,
      exerciseControls: { policy: () => [], revalidateAuthorityBinding: () => NO_TEMPORAL_BOUND },
    },
    governedActionOrchestrator: {
      enabled: true,
      trustDomainId: TRUST_DOMAIN,
      grantPolicy: (query) => ({ grantExpiresAt: new Date(Date.parse(query.evaluatedAt) + 10 * 60 * 1000).toISOString() }),
    },
    monetary: { assets: [{ assetId: 'USD', scale: 2 }], financialActions: [ACTION] },
    executionReconciliation: { enabled: true, authorities: [authority], selectAuthority: () => authority.authorityId },
  });
  if (provisionWorld) {
    const provisioning = server.enterprise.kernelAuthorityProvisioning;
    assert.ok(provisioning !== undefined);
    const payloads = buildDurableAuthorityPayloads(ORG, TRUST_DOMAIN);
    await provisioning.provisionActor(DURABLE_FIXTURE_OPERATOR, payloads.issuerActor);
    await provisioning.provisionTrustDomain(DURABLE_FIXTURE_OPERATOR, payloads.trustDomain);
    await provisioning.provisionRootIssuer(DURABLE_FIXTURE_OPERATOR, payloads.rootIssuer);
    await provisioning.provisionActor(DURABLE_FIXTURE_OPERATOR, { ...payloads.ownerActor, actorId: OWNER, displayName: 'Owner', externalSubject: { system: 'assure01-app', subjectId: 'owner' } });
    await provisioning.provisionActor(DURABLE_FIXTURE_OPERATOR, { ...payloads.agentActor, actorId: AGENT, displayName: 'Agent', externalSubject: SUBJECT });
    await provisioning.provisionPassport(DURABLE_FIXTURE_OPERATOR, { ...payloads.passport, passportId: `passport-${AGENT}`, subjectActorId: AGENT });
    await provisioning.provisionCapabilityToken(DURABLE_FIXTURE_OPERATOR, { ...payloads.capabilityToken, capabilityTokenId: `cap-${AGENT}`, subjectActorId: AGENT, principalActorId: OWNER, issuerActorId: OWNER, actions: [ACTION], resourceScopes: [RESOURCE] });
    await provisioning.provisionAuthorityGrant(DURABLE_FIXTURE_OPERATOR, {
      ...payloads.authorityGrant,
      authorityGrantId: 'authority-owner',
      subjectActorId: OWNER,
      actions: [ACTION],
      resourceScopes: [RESOURCE],
      constraints: [
        { type: 'max_amount', currency: 'USD', value: '1000' },
        { type: 'spending_limit', limitId: 'lifetime', currency: 'USD', maximum: '10000', window: { kind: 'lifetime' } },
      ],
    });
    await provisioning.provisionDelegationGrant(DURABLE_FIXTURE_OPERATOR, { ...payloads.delegationGrant, delegationGrantId: 'delegation-agent', delegatorActorId: OWNER, delegateActorId: AGENT, sourceAuthorityGrantId: 'authority-owner', actions: [ACTION], resourceScopes: [RESOURCE] });
  }
  const { port } = await server.listen();
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await server.close();
    await authorityStore.close();
  };
  closers.push(close);
  return { server, baseUrl: `http://127.0.0.1:${port}`, adapter, authorityStore, close };
}

async function http(baseUrl: string, method: string, path: string, authorization: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown>; text: string }> {
  const response = await fetch(`${baseUrl}${path}`, { method, headers: { authorization, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await response.text();
  return { status: response.status, body: JSON.parse(text) as Record<string, unknown>, text };
}

const trace = async (baseUrl: string, requestId: string) => {
  const reply = await http(baseUrl, 'GET', `/api/evidence/traces/${encodeURIComponent(requestId)}?level=AUDITOR`, AUDITOR);
  assert.equal(reply.status, 200, reply.text);
  const disclosed = reply.body['trace'] as Record<string, unknown>;
  return { digest: reply.body['traceDigest'] as string, summary: disclosed['summary'] as Record<string, unknown>, stages: disclosed['stages'] as Record<string, Record<string, unknown>>, events: ((disclosed['stages'] as Record<string, Record<string, unknown>>)['events']?.['events'] as { eventType: string }[]).map((event) => event.eventType) };
};
const verify = async (baseUrl: string, requestId: string) => {
  const reply = await http(baseUrl, 'GET', `/api/evidence/traces/${encodeURIComponent(requestId)}/verify`, AUDITOR);
  assert.equal(reply.status, 200, reply.text);
  return reply.body;
};

describe('ASSURE-01 — unconfirmed, then resolved by the P12 resolution authority', () => {
  for (const [certainty, finalState] of [
    ['confirmed-completed', 'resolved-confirmed-completed'],
    ['confirmed-not-completed', 'resolved-confirmed-not-completed'],
  ] as const) {
    it(`the trace stays unconfirmed until P12 resolves it (${certainty}); the P11 observation is never rewritten; the sealed bundle progresses; restart keeps it`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'frontera-assure01-p12-'));
      directories.push(dir);
      const authority = resolver();
      let served = await serve(dir, authority, true);

      const paid = await http(served.baseUrl, 'POST', '/api/governed-actions', `Bearer ${CUSTOMER}`, { action: ACTION, resource: RESOURCE, amount: { value: '100', currency: 'USD' }, idempotencyKey: `assure01-p12-${certainty}` });
      assert.equal(paid.body['status'], 'execution_unconfirmed', paid.text);
      const requestId = paid.body['requestId'] as string;
      const executionId = paid.body['executionId'] as string;

      const before = await trace(served.baseUrl, requestId);
      assert.equal(before.summary['finalState'], 'executed-unconfirmed', 'unconfirmed stays unconfirmed: no resolution exists yet');
      assert.equal(before.stages['resolution']?.['presence'], 'unresolved');
      assert.equal((before.stages['resolution']?.['binding'] as Record<string, unknown>)['authorityId'], 'resolver-assure01', 'the pre-claim P12 binding names who may resolve it');
      assert.equal((await verify(served.baseUrl, requestId))['verified'], true);
      const sealed = await http(served.baseUrl, 'POST', '/api/evidence/build', AUDITOR, { requestId, level: 'AUDITOR' });
      assert.equal(sealed.status, 201, sealed.text);

      authority.answer = { outcome: 'resolved', certainty, ...(certainty === 'confirmed-not-completed' ? { failure: 'PROVIDER_REJECTED' } : { providerRef: 'job-assure01-final' }) };
      const reconciled = await served.server.enterprise.executionReconciliation?.reconcile({ organizationId: ORG, executionId });
      assert.equal(reconciled?.outcome, 'resolved', JSON.stringify(reconciled));

      const after = await trace(served.baseUrl, requestId);
      assert.equal(after.summary['finalState'], finalState);
      assert.equal((after.stages['resolution']?.['resolution'] as Record<string, unknown>)['certainty'], certainty);
      assert.equal((after.stages['resolution']?.['resolution'] as Record<string, unknown>)['basisObservationDigest'], after.stages['outcome']?.['observationDigest'], 'the resolution names the observation it resolved');
      assert.equal(after.stages['outcome']?.['certainty'], 'unconfirmed', 'the initial observation is historical truth, never rewritten');
      assert.ok(after.events.includes('execution.outcome.resolved'));
      const verification = await verify(served.baseUrl, requestId);
      assert.equal(verification['verified'], true, JSON.stringify((verification['checks'] as { status: string }[]).filter((entry) => entry.status === 'fail')));

      const bundleId = (sealed.body['bundle'] as Record<string, unknown>)['bundleId'] as string;
      const bundleCheck = await http(served.baseUrl, 'POST', '/api/evidence/verify', AUDITOR, { bundleId });
      assert.equal(bundleCheck.body['valid'], true, bundleCheck.text);
      assert.equal(bundleCheck.body['freshness'], 'superseded-by-later-facts');

      // Restart on the same stores: the same trace, the same bundle.
      await served.close();
      served = await serve(dir, authority, false);
      assert.equal((await trace(served.baseUrl, requestId)).digest, after.digest);
      assert.equal((await verify(served.baseUrl, requestId))['verified'], true);
      assert.equal((await http(served.baseUrl, 'GET', `/api/evidence/${encodeURIComponent(bundleId)}`, AUDITOR)).body['state'], 'VERIFIED', 'the lifecycle survived the restart');
      assert.equal(served.adapter.callCount, 0, 'nothing re-executed after the restart');
      assert.equal(authority.queries.length, 1, 'reading and verifying never asked the resolver');
    });
  }
});
