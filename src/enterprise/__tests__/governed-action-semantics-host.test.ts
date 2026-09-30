import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ExecutionAdapter, ValidatedExecutionAction } from '../../features/execution-runtime/index.js';
import { bootEnterpriseHost, type EnterpriseHost } from '../host/enterprise-host.js';
import { EnterpriseHostConfigurationError } from '../host/host-configuration.js';
import { buildDurableAuthorityPayloads, DURABLE_FIXTURE_OPERATOR } from '../kernel-authority/fixtures/durable-authority.fixture.js';
import { authorityAuthenticityEnv } from './authority-authenticity-fixture.js';
import { CUSTOMER_DATA, EXPORT_ACTION, READ_ACTION, SEMANTIC_CONFIGURATION, SEMANTIC_CONFIGURATION_WITHOUT_FACTS, APPROVED_DESTINATION } from './governed-action-semantics-fixture.js';
import { withDeploymentWitness } from './core07-freshness-fixture.js';

/**
 * CORE-03 §63 / §66 — the semantic model through the **canonical shipped
 * Host**: `bootEnterpriseHost()` (what `npm run start:enterprise` runs) under
 * the `production` secure profile, SQLite everywhere, Ed25519-signed grants,
 * a real loopback listener, and the CTRL-01 administration API over HTTP.
 *
 * Governance Profiles reach the Host only through the canonical governed-action
 * file (strictly parsed; a malformed profile refuses startup). The Host does
 * not compose policy packs (NB-008, unchanged by CORE-03), so what is proven
 * here is the path — classification, typed parameters, signed parameter bounds
 * and profile binding, restart durability, operator inspection and revocation
 * — while policy-driven differentiation is proven on the same composition root
 * in `governed-action-thesis-read-export.test.ts`.
 */

const ORG = 'org-core03';
const TRUST_DOMAIN = 'trust-domain-core03';
const OWNER = 'actor-owner';
const AGENT = 'actor-agent';
const AGENT_SUBJECT = { system: 'data-app', subjectId: 'agent-1' } as const;
const ADAPTER_ID = 'test.recording';
const AGENT_KEY = 'FRONTERA_CORE03_AGENT_KEY_SENTINEL_9f41c2';
const LEGACY_KEY = 'FRONTERA_CORE03_LEGACY_KEY_SENTINEL_1b7e55';
const ADMIN_KEY = 'FRONTERA_CORE03_ADMIN_KEY_SENTINEL_5d2a8c1e9b0f7a43';

const directories: string[] = [];
const hosts: EnterpriseHost[] = [];
after(async () => {
  for (const host of hosts) await host.close().catch(() => {});
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

function workDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'frontera-core03-host-'));
  directories.push(directory);
  return directory;
}

function governedFile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    trustDomainId: TRUST_DOMAIN,
    grantLifetimeSeconds: 300,
    customerPrincipals: [{ principalId: 'principal-agent', externalSubject: AGENT_SUBJECT, apiKeyEnv: 'FRONTERA_TEST_AGENT_KEY' }],
    administrators: [{ operatorId: 'ops-primary', apiKeyEnv: 'FRONTERA_TEST_ADMIN_KEY' }],
    // CORE-04: this Host composes no policy, and a profile declaring material
    // facts now needs one (an admitted fact informs policy); this suite never
    // exercised facts, so it runs on the facts-free variant of the fixture.
    governance: SEMANTIC_CONFIGURATION_WITHOUT_FACTS,
    routes: [
      { action: READ_ACTION, adapterId: ADAPTER_ID },
      { action: EXPORT_ACTION, adapterId: ADAPTER_ID },
    ],
    ...overrides,
  };
}

function secureEnv(dir: string, file: Record<string, unknown> = governedFile()): Record<string, string | undefined> {
  const filePath = join(dir, 'governed-actions.json');
  writeFileSync(filePath, JSON.stringify(file));
  return {
    AOC_ENTERPRISE_ENV: 'production',
    AOC_ENTERPRISE_PERSISTENCE_PROVIDER: 'sqlite',
    AOC_ENTERPRISE_REQUIRE_AUTH: 'true',
    AOC_ENTERPRISE_API_KEYS: `${LEGACY_KEY}:${ORG}`,
    AOC_ENTERPRISE_HTTP_HOST: '127.0.0.1',
    AOC_ENTERPRISE_HTTP_PORT: '0',
    AOC_ENTERPRISE_LOG_LEVEL: 'error',
    AOC_ENTERPRISE_KERNEL_AUTHORITY_ENABLED: 'true',
    AOC_ENTERPRISE_KERNEL_AUTHORITY_ORGANIZATION_ID: ORG,
    AOC_ENTERPRISE_SQLITE_PATH: join(dir, 'governance.sqlite'),
    AOC_ENTERPRISE_PASSPORT_SQLITE_PATH: join(dir, 'passport.sqlite'),
    AOC_ENTERPRISE_ASSURANCE_SQLITE_PATH: join(dir, 'assurance.sqlite'),
    AOC_ENTERPRISE_KERNEL_AUTHORITY_SQLITE_PATH: join(dir, 'kernel-authority.sqlite'),
    AOC_ENTERPRISE_BOUNDED_GRANT_SQLITE_PATH: join(dir, 'bounded-grants.sqlite'),
    AOC_ENTERPRISE_EMERGENCY_CONTROL_SQLITE_PATH: join(dir, 'emergency-controls.sqlite'),
    AOC_ENTERPRISE_EXERCISE_LEDGER_SQLITE_PATH: join(dir, 'exercise-ledger.sqlite'),
    AOC_ENTERPRISE_AUTHORITY_EVENT_STREAM_SQLITE_PATH: join(dir, 'authority-event-stream.sqlite'),
    AOC_ENTERPRISE_EXECUTION_OUTCOME_SQLITE_PATH: join(dir, 'execution-outcomes.sqlite'),
    AOC_ENTERPRISE_EXECUTION_RESOLUTION_SQLITE_PATH: join(dir, 'execution-resolutions.sqlite'),
    ...authorityAuthenticityEnv(),
    AOC_ENTERPRISE_GOVERNED_ACTIONS_FILE: filePath,
    FRONTERA_TEST_AGENT_KEY: AGENT_KEY,
    FRONTERA_TEST_ADMIN_KEY: ADMIN_KEY,
  };
}

interface Booted {
  readonly host: EnterpriseHost;
  readonly calls: ValidatedExecutionAction[];
  readonly baseUrl: string;
}

async function boot(env: Record<string, string | undefined>): Promise<Booted> {
  const calls: ValidatedExecutionAction[] = [];
  const adapter: ExecutionAdapter = {
    adapterId: ADAPTER_ID,
    async execute(action) {
      calls.push(action);
      return { outcome: 'completed', providerRef: 'provider-ref-core03' };
    },
  };
  const host = await bootEnterpriseHost({ env: await withDeploymentWitness(env), executionAdapters: [adapter] });
  hosts.push(host);
  const { port } = await host.listen();
  return { host, calls, baseUrl: `http://127.0.0.1:${port}` };
}

async function provision(host: EnterpriseHost): Promise<void> {
  const service = host.enterprise.kernelAuthorityProvisioning;
  assert.ok(service !== undefined);
  const payloads = buildDurableAuthorityPayloads(ORG, TRUST_DOMAIN);
  const operator = DURABLE_FIXTURE_OPERATOR;
  const actions = [READ_ACTION, EXPORT_ACTION];
  await service.provisionActor(operator, payloads.issuerActor);
  await service.provisionTrustDomain(operator, payloads.trustDomain);
  await service.provisionRootIssuer(operator, payloads.rootIssuer);
  await service.provisionActor(operator, { ...payloads.ownerActor, actorId: OWNER, displayName: 'Owner', externalSubject: { system: 'data-app', subjectId: 'owner-1' } });
  await service.provisionActor(operator, { ...payloads.agentActor, actorId: AGENT, displayName: 'Agent', externalSubject: AGENT_SUBJECT });
  await service.provisionPassport(operator, { ...payloads.passport, passportId: `passport-${AGENT}`, subjectActorId: AGENT });
  await service.provisionCapabilityToken(operator, { ...payloads.capabilityToken, capabilityTokenId: `cap-${AGENT}`, subjectActorId: AGENT, principalActorId: OWNER, issuerActorId: OWNER, actions, resourceScopes: [CUSTOMER_DATA] });
  await service.provisionAuthorityGrant(operator, { ...payloads.authorityGrant, authorityGrantId: 'authority-grant-owner', subjectActorId: OWNER, actions, resourceScopes: [CUSTOMER_DATA] });
  await service.provisionDelegationGrant(operator, {
    ...payloads.delegationGrant,
    delegationGrantId: 'delegation-agent',
    delegatorActorId: OWNER,
    delegateActorId: AGENT,
    sourceAuthorityGrantId: 'authority-grant-owner',
    actions,
    resourceScopes: [CUSTOMER_DATA],
  });
}

interface Reply {
  readonly status: number;
  readonly text: string;
  readonly body: Record<string, unknown>;
}

async function call(baseUrl: string, method: string, path: string, options: { readonly authorization?: string; readonly body?: unknown; readonly rawBody?: string } = {}): Promise<Reply> {
  const headers: Record<string, string> = { ...(options.authorization !== undefined ? { authorization: options.authorization } : {}), 'content-type': 'application/json' };
  const payload = options.rawBody ?? (options.body !== undefined ? JSON.stringify(options.body) : undefined);
  const response = await fetch(`${baseUrl}${path}`, { method, headers, ...(payload !== undefined ? { body: payload } : {}) });
  const text = await response.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = {};
  }
  return { status: response.status, text, body };
}

let sequence = 0;
const govern = (baseUrl: string, intent: Record<string, unknown>) => call(baseUrl, 'POST', '/api/governed-actions', { authorization: `Bearer ${AGENT_KEY}`, body: { idempotencyKey: `core03-host-${(sequence += 1)}`, ...intent } });
const ADMIN = `Bearer ${ADMIN_KEY}`;

async function grantOf(baseUrl: string, reply: Reply): Promise<Reply> {
  const lookup = await call(baseUrl, 'GET', `/api/admin/authority/executions/${encodeURIComponent(reply.body['executionId'] as string)}`, { authorization: ADMIN });
  assert.equal(lookup.status, 200, lookup.text);
  return call(baseUrl, 'GET', `/api/admin/authority/grants/${encodeURIComponent(lookup.body['grantId'] as string)}`, { authorization: ADMIN });
}

describe('CORE-03 §63 — the canonical secure Host governs a profiled, parameterized action end to end', () => {
  it('boots with profiles from the governed-action file, executes a typed read over HTTP, and signs the parameter bound', async () => {
    const dir = workDir();
    const { host, calls, baseUrl } = await boot(secureEnv(dir));
    await provision(host);

    const reply = await govern(baseUrl, { action: READ_ACTION, resource: CUSTOMER_DATA, parameters: { recordCount: 50 }, expectedGovernanceProfile: { id: 'customer-data-read', version: 1 } });
    assert.equal(reply.status, 200, reply.text);
    assert.equal(reply.body['status'], 'executed');
    assert.equal(calls.length, 1);

    // CTRL-01: the operator sees every bound the grant is enforced under.
    const view = await grantOf(baseUrl, reply);
    assert.equal(view.status, 200, view.text);
    const bounds = view.body['bounds'] as Record<string, unknown>;
    assert.match((bounds['governanceProfile'] as { value: string }).value, /^customer-data-read@1#sha256:[0-9a-f]{64}$/);
    assert.deepEqual(bounds['parameters'], [{ dimension: 'recordCount', kind: 'maximum', type: 'integer', limit: 50 }]);
    assert.deepEqual(bounds['resources'], { kind: 'set', values: [CUSTOMER_DATA] });
    assert.deepEqual([bounds['actionClass'], bounds['resourceClass']], [{ kind: 'identity', value: 'read' }, { kind: 'identity', value: 'customer_dataset' }]);
    assert.equal(view.body['semanticsFormat'], 'frontera.grant-semantics.v1');
    assert.equal((view.body['status'] as { eligibility: string }).eligibility, 'exercisable');

    // Restart: the signed, parameter-bound grant verifies from disk.
    const grantId = view.body['grantId'] as string;
    await host.close();
    const restarted = await boot(secureEnv(dir));
    const after = await call(restarted.baseUrl, 'GET', `/api/admin/authority/grants/${encodeURIComponent(grantId)}`, { authorization: ADMIN });
    assert.equal(after.status, 200, after.text);
    assert.deepEqual((after.body['bounds'] as Record<string, unknown>)['parameters'], [{ dimension: 'recordCount', kind: 'maximum', type: 'integer', limit: 50 }]);

    // CTRL-01 revocation still works on a parameter-bound grant — and stays revoked.
    const revoked = await call(restarted.baseUrl, 'POST', `/api/admin/authority/grants/${encodeURIComponent(grantId)}/revoke`, { authorization: ADMIN, body: { reason: 'security-incident' } });
    assert.equal(revoked.status, 200, revoked.text);
    const inspected = await call(restarted.baseUrl, 'GET', `/api/admin/authority/grants/${encodeURIComponent(grantId)}`, { authorization: ADMIN });
    assert.equal((inspected.body['status'] as { eligibility: string }).eligibility, 'unusable');
    assert.deepEqual((inspected.body['status'] as { reasonCodes: string[] }).reasonCodes, ['GRANT_REVOKED']);
  });

  it('refuses, over HTTP and before any decision, what the profile does not allow the envelope to say', async () => {
    const { host, calls, baseUrl } = await boot(secureEnv(workDir()));
    await provision(host);
    for (const intent of [
      { action: READ_ACTION, resource: CUSTOMER_DATA, parameters: { recordCount: '50' } },
      { action: READ_ACTION, resource: CUSTOMER_DATA },
      { action: READ_ACTION, resource: CUSTOMER_DATA, parameters: { recordCount: 50, destination: APPROVED_DESTINATION } },
      { action: READ_ACTION, resource: CUSTOMER_DATA, parameters: { recordCount: 50 }, expectedGovernanceProfile: { id: 'customer-data-export', version: 2 } },
      { action: EXPORT_ACTION, resource: CUSTOMER_DATA, parameters: { recordCount: 50, destination: APPROVED_DESTINATION }, expectedGovernanceProfile: { id: 'customer-data-export', version: 1 } },
    ]) {
      const reply = await govern(baseUrl, intent);
      assert.equal(reply.body['status'], 'rejected', `${JSON.stringify(intent)} → ${reply.text}`);
      assert.equal(reply.body['decision'], undefined);
    }
    // An integer with a fractional JSON lexeme never becomes an integer.
    const fractional = await call(baseUrl, 'POST', '/api/governed-actions', {
      authorization: `Bearer ${AGENT_KEY}`,
      rawBody: `{"action":"${READ_ACTION}","resource":"${CUSTOMER_DATA}","idempotencyKey":"core03-fraction","parameters":{"recordCount":50.5}}`,
    });
    assert.equal(fractional.body['status'], 'rejected', fractional.text);
    assert.equal(calls.length, 0);
  });
});

describe('CORE-03 §64 — Host configuration: strict, no silent fallback, no default profile', () => {
  const refusals: readonly [string, unknown][] = [
    ['a profile carrying an executable-looking rule', { ...SEMANTIC_CONFIGURATION, profiles: [{ ...(SEMANTIC_CONFIGURATION.profiles?.[0] ?? {}), rule: 'recordCount > 100' }] }],
    ['a profile naming an undeclared dimension', { ...SEMANTIC_CONFIGURATION, profiles: [{ ...(SEMANTIC_CONFIGURATION.profiles?.[0] ?? {}), parameters: [{ dimension: 'blastRadius', required: true }] }] }],
    ['an unsupported comparator', { ...SEMANTIC_CONFIGURATION, parameterDimensions: [{ id: 'environment', type: 'token', bound: 'maximum' }] }],
    ['a default profile', { ...SEMANTIC_CONFIGURATION, defaultProfile: 'customer-data-read' }],
    ['governance that is not an object', ['customer-data-read']],
  ];
  for (const [name, governance] of refusals) {
    it(`refuses to boot on ${name}`, async () => {
      await assert.rejects(
        async () => bootEnterpriseHost({ env: await withDeploymentWitness(secureEnv(workDir(), governedFile({ governance }))) }),
        (error: unknown) => error instanceof EnterpriseHostConfigurationError && error.code === 'HOST_GOVERNED_ACTIONS_FILE_INVALID',
      );
    });
  }

  it('a governed-action file without `governance` boots exactly as before, and refuses parameters on every action', async () => {
    const file = governedFile();
    delete file['governance'];
    const { host, calls, baseUrl } = await boot(secureEnv(workDir(), file));
    await provision(host);
    const plain = await govern(baseUrl, { action: READ_ACTION, resource: CUSTOMER_DATA });
    assert.equal(plain.body['status'], 'executed', plain.text);
    const parameterized = await govern(baseUrl, { action: READ_ACTION, resource: CUSTOMER_DATA, parameters: { recordCount: 1 } });
    assert.equal(parameterized.body['status'], 'rejected');
    assert.equal(calls.length, 1);
  });
});
