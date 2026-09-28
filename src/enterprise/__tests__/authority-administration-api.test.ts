import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';

import type { ExecutionAdapter, ExecutionAdapterResult, ValidatedExecutionAction } from '../../features/execution-runtime/index.js';
import { deriveAuthorityEventStreamId } from '../authority-event-stream/identifiers.js';
import { bootEnterpriseHost, type EnterpriseHost } from '../host/enterprise-host.js';
import { EnterpriseHostConfigurationError } from '../host/host-configuration.js';
import { buildDurableAuthorityPayloads, DURABLE_FIXTURE_OPERATOR } from '../kernel-authority/fixtures/durable-authority.fixture.js';
import { createKernelAuthorityProvisioningService, type KernelAuthorityProvisioningService } from '../kernel-authority/provisioning-service.js';
import type { EnterpriseLogger } from '../telemetry/enterprise-logger.js';
import { AUTHORITY_KEY_A, authorityAuthenticityEnv, dropAuthorityStoreTriggers } from './authority-authenticity-fixture.js';

/**
 * CTRL-01 — the authority administration API, qualified through the real
 * Enterprise Host.
 *
 * Every test boots through `bootEnterpriseHost()` — the function `npm run
 * start:enterprise` calls — from a plain environment and a governed-action
 * file, over real SQLite files, a real loopback listener and real Ed25519
 * authority signing, and calls `/api/admin/...` over HTTP with the real
 * authentication path. The only in-process seam is the recording provider
 * adapter (the bootstrap's documented embedder seam), so adapter calls can be
 * counted; and the operator's authority world is provisioned through the
 * existing in-process provisioning surface, because provisioning is
 * deliberately not part of CTRL-01.
 */

const ORG = 'org-acme';
const TRUST_DOMAIN = 'trust-domain-acme';
const ACTION = 'invoice.approve';
const RESOURCE = 'resource-ledger-1';
const OWNER = 'actor-owner';
const AGENT = 'actor-agent';
const AGENT_SUBJECT = { system: 'erp-app', subjectId: 'agent-1' } as const;
const DELEGATION = 'delegation-agent';
const ADAPTER_ID = 'test.recording';

const AGENT_KEY = 'FRONTERA_CTRL01_AGENT_KEY_SENTINEL_4c1d9e';
const LEGACY_KEY = 'FRONTERA_CTRL01_LEGACY_KEY_SENTINEL_77aa01';
const ADMIN_KEY = 'FRONTERA_CTRL01_ADMIN_KEY_SENTINEL_0f5e2b9c7d31a8e4';
const SECOND_ADMIN_KEY = 'FRONTERA_CTRL01_SECOND_ADMIN_SENTINEL_b93c01d2e4f6a7c8';
const PRIVATE_KEY_LINE = AUTHORITY_KEY_A.privateKeyPem.split('\n')[1] ?? 'unreachable';
const SECRETS = [AGENT_KEY, LEGACY_KEY, ADMIN_KEY, SECOND_ADMIN_KEY, PRIVATE_KEY_LINE];

const PRIMARY = 'operator:ops-primary';
const SECONDARY = 'operator:ops-secondary';

// -- workspace -------------------------------------------------------------------

const directories: string[] = [];
const hosts: EnterpriseHost[] = [];
after(async () => {
  for (const host of hosts) await host.close().catch(() => {});
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

function workDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'frontera-ctrl01-'));
  directories.push(directory);
  return directory;
}

const ADMINISTRATORS = [
  { operatorId: 'ops-primary', apiKeyEnv: 'FRONTERA_TEST_ADMIN_KEY' },
  { operatorId: 'ops-secondary', apiKeyEnv: 'FRONTERA_TEST_SECOND_ADMIN_KEY' },
];

function governedFile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    trustDomainId: TRUST_DOMAIN,
    grantLifetimeSeconds: 300,
    customerPrincipals: [{ principalId: 'principal-agent', externalSubject: AGENT_SUBJECT, apiKeyEnv: 'FRONTERA_TEST_AGENT_KEY' }],
    administrators: ADMINISTRATORS,
    routes: [{ action: ACTION, adapterId: ADAPTER_ID }],
    ...overrides,
  };
}

function secureEnv(dir: string, file: Record<string, unknown> = governedFile(), overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  const filePath = join(dir, 'governed-actions.json');
  writeFileSync(filePath, JSON.stringify(file));
  return {
    AOC_ENTERPRISE_ENV: 'production',
    AOC_ENTERPRISE_PERSISTENCE_PROVIDER: 'sqlite',
    AOC_ENTERPRISE_REQUIRE_AUTH: 'true',
    AOC_ENTERPRISE_API_KEYS: `${LEGACY_KEY}:${ORG}`,
    AOC_ENTERPRISE_HTTP_HOST: '127.0.0.1',
    AOC_ENTERPRISE_HTTP_PORT: '0',
    AOC_ENTERPRISE_LOG_LEVEL: 'info',
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
    FRONTERA_TEST_SECOND_ADMIN_KEY: SECOND_ADMIN_KEY,
    ...overrides,
  };
}

interface RecordingAdapter extends ExecutionAdapter {
  readonly calls: ValidatedExecutionAction[];
}

function recordingAdapter(result: ExecutionAdapterResult = { outcome: 'completed', providerRef: 'provider-ref-1' }): RecordingAdapter {
  const calls: ValidatedExecutionAction[] = [];
  return {
    adapterId: ADAPTER_ID,
    calls,
    async execute(action) {
      calls.push(action);
      return result;
    },
  };
}

const logLines: string[] = [];
const capturingLogger: EnterpriseLogger = {
  debug: (message, fields) => logLines.push(JSON.stringify({ message, fields })),
  info: (message, fields) => logLines.push(JSON.stringify({ message, fields })),
  warn: (message, fields) => logLines.push(JSON.stringify({ message, fields })),
  error: (message, fields) => logLines.push(JSON.stringify({ message, fields })),
};

interface Booted {
  readonly host: EnterpriseHost;
  readonly adapter: RecordingAdapter;
  readonly baseUrl: string;
}

async function boot(env: Record<string, string | undefined>, adapter: RecordingAdapter = recordingAdapter()): Promise<Booted> {
  const host = await bootEnterpriseHost({ env, executionAdapters: [adapter], logger: capturingLogger });
  hosts.push(host);
  const { port } = await host.listen();
  return { host, adapter, baseUrl: `http://127.0.0.1:${port}` };
}

/** The pre-existing in-process provisioning surface. CTRL-01 deliberately does not expose provisioning. */
async function provision(host: EnterpriseHost): Promise<void> {
  const service = host.enterprise.kernelAuthorityProvisioning;
  assert.ok(service !== undefined);
  const payloads = buildDurableAuthorityPayloads(ORG, TRUST_DOMAIN);
  const operator = DURABLE_FIXTURE_OPERATOR;
  await service.provisionActor(operator, payloads.issuerActor);
  await service.provisionTrustDomain(operator, payloads.trustDomain);
  await service.provisionRootIssuer(operator, payloads.rootIssuer);
  await service.provisionActor(operator, { ...payloads.ownerActor, actorId: OWNER, displayName: 'Owner', externalSubject: { system: 'erp-app', subjectId: 'owner-1' } });
  await service.provisionActor(operator, { ...payloads.agentActor, actorId: AGENT, displayName: 'Agent', externalSubject: AGENT_SUBJECT });
  await service.provisionPassport(operator, { ...payloads.passport, passportId: `passport-${AGENT}`, subjectActorId: AGENT });
  await service.provisionCapabilityToken(operator, {
    ...payloads.capabilityToken,
    capabilityTokenId: `cap-${AGENT}`,
    subjectActorId: AGENT,
    principalActorId: OWNER,
    issuerActorId: OWNER,
    actions: [ACTION],
    resourceScopes: [RESOURCE],
  });
  await service.provisionAuthorityGrant(operator, { ...payloads.authorityGrant, authorityGrantId: 'authority-grant-owner', subjectActorId: OWNER, actions: [ACTION], resourceScopes: [RESOURCE] });
  await service.provisionDelegationGrant(operator, {
    ...payloads.delegationGrant,
    delegationGrantId: DELEGATION,
    delegatorActorId: OWNER,
    delegateActorId: AGENT,
    sourceAuthorityGrantId: 'authority-grant-owner',
    actions: [ACTION],
    resourceScopes: [RESOURCE],
  });
}

// -- HTTP ------------------------------------------------------------------------

interface Reply {
  readonly status: number;
  readonly text: string;
  readonly body: Record<string, unknown>;
}

const responses: string[] = [];

async function call(baseUrl: string, method: string, path: string, options: { readonly authorization?: string; readonly body?: unknown; readonly headers?: Record<string, string>; readonly rawBody?: string } = {}): Promise<Reply> {
  const headers: Record<string, string> = { ...(options.authorization !== undefined ? { authorization: options.authorization } : {}), ...(options.headers ?? {}) };
  let payload: string | undefined = options.rawBody;
  if (options.body !== undefined) {
    payload = JSON.stringify(options.body);
    headers['content-type'] ??= 'application/json';
  }
  const response = await fetch(`${baseUrl}${path}`, { method, headers, ...(payload !== undefined ? { body: payload } : {}) });
  const text = await response.text();
  responses.push(text);
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = {};
  }
  return { status: response.status, text, body };
}

const bearer = (secret: string): string => `Bearer ${secret}`;
const ADMIN = bearer(ADMIN_KEY);
let sequence = 0;
const intent = (): Record<string, unknown> => ({ action: ACTION, resource: RESOURCE, idempotencyKey: `ctrl01-${(sequence += 1)}` });

async function govern(baseUrl: string, body: Record<string, unknown> = intent()): Promise<Reply> {
  return call(baseUrl, 'POST', '/api/governed-actions', { authorization: bearer(AGENT_KEY), body });
}

const grantPath = (grantId: string) => `/api/admin/authority/grants/${encodeURIComponent(grantId)}`;
const delegationPath = `/api/admin/authority/entities/delegation-grant/${DELEGATION}`;
const errorCode = (reply: Reply): unknown => (reply.body['error'] as Record<string, unknown> | undefined)?.['code'];

/** Governs one action and resolves its bounded grant through the administration API — the operator's route from an execution to the grant, with no database. */
async function executedGrant(baseUrl: string): Promise<{ readonly grantId: string; readonly executionId: string; readonly requestId: string }> {
  const reply = await govern(baseUrl);
  assert.equal(reply.body['status'], 'executed', reply.text);
  const executionId = reply.body['executionId'] as string;
  const lookup = await call(baseUrl, 'GET', `/api/admin/authority/executions/${encodeURIComponent(executionId)}`, { authorization: ADMIN });
  assert.equal(lookup.status, 200, lookup.text);
  assert.equal(lookup.body['requestId'], reply.body['requestId']);
  return { grantId: lookup.body['grantId'] as string, executionId, requestId: reply.body['requestId'] as string };
}

function revocationRows(dir: string): { grant_id: string; issuer_ref: string; reason: string; revoked_at: string; signing_key_id: string; signature: string }[] {
  const db = new Database(join(dir, 'bounded-grants.sqlite'), { readonly: true });
  try {
    return db.prepare('SELECT grant_id, issuer_ref, reason, revoked_at, signing_key_id, signature FROM bounded_grant_revocations ORDER BY sequence').all() as never;
  } finally {
    db.close();
  }
}

async function revocationSequence(baseUrl: string): Promise<unknown> {
  const health = await call(baseUrl, 'GET', '/health');
  const modules = health.body['modules'] as Record<string, { health: { details?: Record<string, unknown> } }>;
  return modules['aoc.enterprise.authority-controlled-execution']?.health.details?.['revocationSequence'];
}

function assertNoSecret(text: string, where: string): void {
  for (const secret of SECRETS) assert.equal(text.includes(secret), false, `${where} must not contain a configured secret`);
}

/** The exercise request the governed path would build for this grant — so the real ACE exercise path can be driven against it. */
function exerciseOf(view: Record<string, unknown>, executionId: string) {
  const provenance = view['provenance'] as { requestId: string; decisionId: string; action: string; resourceScope: string };
  return {
    boundedGrantId: view['grantId'] as string,
    subject: view['subject'] as string,
    action: provenance.action,
    resource: provenance.resourceScope,
    organization: ORG,
    correlation: provenance,
    executionId,
  };
}

// ---------------------------------------------------------------------------------

describe('CTRL-01 reproduction — before CTRL-01 no HTTP route administered authority', () => {
  it('a Host with no administrator configured mounts no administration route: every credential gets the unmounted 404, and posture says not-configured', async () => {
    const dir = workDir();
    const { host, baseUrl } = await boot(secureEnv(dir, governedFile({ administrators: undefined })));
    await provision(host);
    const { executionId } = { executionId: (await govern(baseUrl)).body['executionId'] as string };
    assert.equal(host.posture.authorityAdministration, 'not-configured');
    assert.equal(host.enterprise.authorityAdministration, undefined);
    for (const authorization of [undefined, bearer(AGENT_KEY), bearer(LEGACY_KEY), ADMIN]) {
      for (const [method, path] of [
        ['GET', `/api/admin/authority/executions/${executionId}`],
        ['POST', `/api/admin/authority/entities/delegation-grant/${DELEGATION}/revoke`],
        ['POST', '/api/admin/emergency-controls/activate'],
      ] as const) {
        const reply = await call(baseUrl, method, path, { ...(authorization !== undefined ? { authorization } : {}), ...(method === 'POST' ? { body: { reason: 'x' } } : {}) });
        assert.equal(reply.status, 404, `${method} ${path}: ${reply.text}`);
        assert.equal(errorCode(reply), 'NOT_FOUND');
      }
    }
    const health = await call(baseUrl, 'GET', '/health');
    assert.equal((health.body['posture'] as Record<string, unknown>)['authorityAdministration'], 'not-configured');
  });
});

describe('CTRL-01 configuration — administrators are explicit, server-side, strictly validated, and never a default', () => {
  it('a configured Host mounts the API and reports it; /health and the public configuration carry a count, never a secret or identity', async () => {
    const dir = workDir();
    const { host, baseUrl } = await boot(secureEnv(dir));
    assert.equal(host.posture.authorityAdministration, 'enabled');
    const health = await call(baseUrl, 'GET', '/health');
    assert.equal((health.body['posture'] as Record<string, unknown>)['authorityAdministration'], 'enabled');
    assertNoSecret(health.text, '/health');
    assert.equal(health.text.includes('ops-primary'), false, '/health does not name operators');
    assert.deepEqual(host.enterprise.configuration.administration, { administratorCount: 2 });
    assertNoSecret(JSON.stringify(host.enterprise.configuration), 'the public configuration');
    assert.equal(host.enterprise.configuration.authentication.apiKeyCount, 2, 'administrator secrets are not ordinary API keys');
  });

  const refusals: readonly [string, Record<string, unknown>, Record<string, string | undefined>, string][] = [
    ['a short administrator secret', governedFile(), { FRONTERA_TEST_ADMIN_KEY: 'admin' }, 'HOST_ADMINISTRATOR_INVALID'],
    ['an administrator secret with surrounding whitespace', governedFile(), { FRONTERA_TEST_ADMIN_KEY: ` ${ADMIN_KEY}` }, 'HOST_ADMINISTRATOR_INVALID'],
    ['an administrator secret that is also a customer key', governedFile(), { FRONTERA_TEST_ADMIN_KEY: 'FRONTERA_CTRL01_SHARED_SECRET_0123456789abcdef', FRONTERA_TEST_AGENT_KEY: 'FRONTERA_CTRL01_SHARED_SECRET_0123456789abcdef' }, 'HOST_CREDENTIALS_AMBIGUOUS'],
    ['an administrator secret that is also a legacy key', governedFile(), { AOC_ENTERPRISE_API_KEYS: `${ADMIN_KEY}:${ORG}` }, 'HOST_CREDENTIALS_AMBIGUOUS'],
    ['an unset administrator secret variable', governedFile(), { FRONTERA_TEST_ADMIN_KEY: undefined }, 'HOST_SECRET_REFERENCE_UNRESOLVED'],
    ['an inline administrator secret', governedFile({ administrators: [{ operatorId: 'ops-primary', apiKey: ADMIN_KEY }] }), {}, 'HOST_GOVERNED_ACTIONS_FILE_INVALID'],
    ['an administrator role field', governedFile({ administrators: [{ operatorId: 'ops-primary', apiKeyEnv: 'FRONTERA_TEST_ADMIN_KEY', role: 'superuser' }] }), {}, 'HOST_GOVERNED_ACTIONS_FILE_INVALID'],
    ['a duplicate operator id', governedFile({ administrators: [ADMINISTRATORS[0], { operatorId: 'ops-primary', apiKeyEnv: 'FRONTERA_TEST_SECOND_ADMIN_KEY' }] }), {}, 'HOST_GOVERNED_ACTIONS_FILE_INVALID'],
    ['a malformed operator id', governedFile({ administrators: [{ operatorId: 'ops primary!', apiKeyEnv: 'FRONTERA_TEST_ADMIN_KEY' }] }), {}, 'HOST_GOVERNED_ACTIONS_FILE_INVALID'],
    ['an empty administrators list', governedFile({ administrators: [] }), {}, 'HOST_GOVERNED_ACTIONS_FILE_INVALID'],
  ];
  for (const [label, file, overrides, code] of refusals) {
    it(`${label} → ${code}; the Host never starts and the refusal names no secret`, async () => {
      const dir = workDir();
      let refused: unknown;
      try {
        const host = await bootEnterpriseHost({ env: secureEnv(dir, file, overrides), executionAdapters: [recordingAdapter()], logger: capturingLogger });
        hosts.push(host);
      } catch (error) {
        refused = error;
      }
      assert.ok(refused instanceof EnterpriseHostConfigurationError, `${label} must refuse: ${String(refused)}`);
      assert.equal(refused.code, code);
      assertNoSecret(refused.message, 'the refusal');
      assert.equal(refused.message.includes('FRONTERA_CTRL01_SHARED_SECRET'), false);
    });
  }
});

describe('CTRL-01 authorization matrix — reaching the server, or holding an ordinary credential, is not authority', () => {
  it('no credential / invalid / malformed → 401; customer and legacy keys → 403; forged admin flags change nothing; administrator → 200', async () => {
    const dir = workDir();
    const { host, baseUrl, adapter } = await boot(secureEnv(dir));
    await provision(host);
    const { grantId, executionId } = await executedGrant(baseUrl);
    const operations: readonly [string, string, unknown][] = [
      ['GET', grantPath(grantId), undefined],
      ['POST', `${grantPath(grantId)}/revoke`, { reason: 'security-incident' }],
      ['GET', `/api/admin/authority/executions/${executionId}`, undefined],
      ['GET', delegationPath, undefined],
      ['POST', `${delegationPath}/revoke`, { reason: 'offboarded' }],
      ['GET', '/api/admin/emergency-controls', undefined],
      ['POST', '/api/admin/emergency-controls/activate', { scope: 'global' }],
      ['POST', '/api/admin/emergency-controls/release', { scope: 'global' }],
    ];
    const callers: readonly [string, string | undefined, number][] = [
      ['no credential', undefined, 401],
      ['an unknown secret', bearer('not-a-configured-key'), 401],
      ['a default-looking secret', bearer('admin'), 401],
      ['a truncated administrator secret', bearer(ADMIN_KEY.slice(0, -1)), 401],
      ['a non-Bearer scheme with the administrator secret', `Basic ${ADMIN_KEY}`, 401],
      ['a customer principal key', bearer(AGENT_KEY), 403],
      ['a legacy organization key', bearer(LEGACY_KEY), 403],
    ];
    for (const [label, authorization, expected] of callers) {
      for (const [method, path, body] of operations) {
        const reply = await call(baseUrl, method, path, { ...(authorization !== undefined ? { authorization } : {}), ...(body !== undefined ? { body } : {}) });
        assert.equal(reply.status, expected, `${label}: ${method} ${path} → ${reply.text}`);
        assert.equal(errorCode(reply), expected === 401 ? 'AUTHENTICATION_FAILED' : 'AUTHORIZATION_FAILED');
      }
    }

    // Forged privilege, in every place a client can put it: never read.
    const forged = { 'x-admin': 'true', 'x-role': 'admin', 'x-operator': 'ops-primary', 'x-forwarded-user': 'ops-primary' };
    for (const authorization of [bearer(AGENT_KEY), bearer(LEGACY_KEY)]) {
      const reply = await call(baseUrl, 'POST', `${grantPath(grantId)}/revoke?admin=true&role=admin`, {
        authorization,
        headers: forged,
        body: { reason: 'security-incident', admin: true, role: 'admin', operator: 'ops-primary', permissions: ['authority:revoke'] },
      });
      assert.equal(reply.status, 403, reply.text);
    }
    const unauthenticatedForged = await call(baseUrl, 'POST', `${grantPath(grantId)}/revoke?admin=true`, { headers: forged, body: { reason: 'security-incident', admin: true } });
    assert.equal(unauthenticatedForged.status, 401);
    // Authentication runs before anything about the body: a wrong content type is still a 401 to an unauthenticated caller.
    assert.equal((await call(baseUrl, 'POST', `${grantPath(grantId)}/revoke`, { rawBody: 'reason=x', headers: { 'content-type': 'text/plain' } })).status, 401);

    // The administrator credential is administration-only: it is not an ordinary API key.
    const adminOnGoverned = await govern(baseUrl);
    assert.equal(adminOnGoverned.status, 200);
    assert.equal((await call(baseUrl, 'POST', '/api/governed-actions', { authorization: ADMIN, body: intent() })).status, 401, 'an administrator secret is not a customer principal');
    assert.equal((await call(baseUrl, 'GET', '/api/governance/requests/anything', { authorization: ADMIN })).status, 401, 'nor a legacy key');

    // Nothing above changed anything.
    const grant = await call(baseUrl, 'GET', grantPath(grantId), { authorization: ADMIN });
    assert.equal(grant.status, 200, grant.text);
    assert.equal((grant.body['status'] as Record<string, unknown>)['eligibility'], 'exercisable');
    assert.equal(grant.body['revocation'], null);
    const delegation = await call(baseUrl, 'GET', delegationPath, { authorization: ADMIN });
    assert.equal(delegation.body['status'], 'active');
    assert.deepEqual((await call(baseUrl, 'GET', '/api/admin/emergency-controls', { authorization: ADMIN })).body, { active: [] });
    assert.equal(revocationRows(dir).length, 0);
    assert.equal(adapter.calls.length, 2, 'governed execution is unaffected by every refused administration attempt');
    for (const text of responses) assertNoSecret(text, 'an administration response');
  });

  it('forged actor fields are refused; the recorded actor is the operator bound to the credential that authenticated', async () => {
    const dir = workDir();
    const { host, baseUrl } = await boot(secureEnv(dir));
    await provision(host);
    const { grantId } = await executedGrant(baseUrl);

    for (const field of ['issuerRef', 'revokedBy', 'actor', 'operatorId', 'administrator', 'organizationId', 'revokedAt']) {
      const reply = await call(baseUrl, 'POST', `${grantPath(grantId)}/revoke`, { authorization: ADMIN, body: { reason: 'security-incident', [field]: 'operator:attacker' } });
      assert.equal(reply.status, 400, `${field}: ${reply.text}`);
      assert.equal(errorCode(reply), 'INVALID_REQUEST');
    }
    assert.equal(revocationRows(dir).length, 0, 'a refused body revokes nothing');

    const revoked = await call(baseUrl, 'POST', `${grantPath(grantId)}/revoke`, {
      authorization: ADMIN,
      headers: { 'x-operator': 'attacker', 'x-forwarded-user': 'attacker' },
      body: { reason: 'security-incident' },
    });
    assert.equal(revoked.status, 200, revoked.text);
    assert.equal((revoked.body['revocation'] as Record<string, unknown>)['revokedBy'], PRIMARY);
    assert.deepEqual(
      revocationRows(dir).map((row) => row.issuer_ref),
      [PRIMARY],
      'the signed revocation records the configured operator',
    );

    // A second administrator is a second, distinct identity.
    const entity = await call(baseUrl, 'POST', `${delegationPath}/revoke`, { authorization: bearer(SECOND_ADMIN_KEY), body: { reason: 'offboarded' } });
    assert.equal(entity.status, 200, entity.text);
    const view = entity.body['entity'] as Record<string, unknown>;
    assert.equal(view['revokedBy'], SECONDARY);
    const events = await host.enterprise.kernelAuthorityProvisioning?.listEvents({ system: false, organizationId: ORG }, 'delegation-grant', DELEGATION);
    assert.deepEqual(
      events?.map((event) => [event.eventType, event.provisionedBy]),
      [
        ['KernelAuthorityEntityProvisioned', DURABLE_FIXTURE_OPERATOR.actorId],
        ['KernelAuthorityEntityRevoked', SECONDARY],
      ],
    );
    const auditLines = logLines.filter((line) => line.includes('enterprise.admin.authority'));
    assert.ok(auditLines.some((line) => line.includes('"operatorId":"ops-primary"') && line.includes('"operation":"grant.revoke"') && line.includes(grantId)));
    assert.ok(auditLines.every((line) => !line.includes('attacker')), 'no request-supplied identity reaches the audit log');
    for (const line of logLines) assertNoSecret(line, 'the Host log');
  });

  it('SCOPE: the Host serves one organization; another organization\'s authority is invisible and unrevocable through it, whatever the request names', async () => {
    const dir = workDir();
    const { host, baseUrl } = await boot(secureEnv(dir));
    await provision(host);
    const store = host.enterprise.kernelAuthorityStore;
    assert.ok(store !== undefined);
    // Another organization's record in the same durable store, written through the store's own operator surface.
    const other: KernelAuthorityProvisioningService = createKernelAuthorityProvisioningService({ store, organizationId: 'org-other' });
    await other.provisionActor({ system: true, actorId: 'operator-other' }, { actorId: 'actor-other', type: 'agent', displayName: 'Other' });

    for (const path of ['/api/admin/authority/entities/actor/actor-other', '/api/admin/authority/entities/actor/actor-other?organizationId=org-other']) {
      const read = await call(baseUrl, 'GET', path, { authorization: ADMIN, headers: { 'x-organization-id': 'org-other', 'x-tenant-id': 'org-other' } });
      assert.equal(read.status, 404, read.text);
      assert.equal(errorCode(read), 'AUTHORITY_ADMIN_TARGET_NOT_FOUND');
    }
    const revoke = await call(baseUrl, 'POST', '/api/admin/authority/entities/actor/actor-other/revoke?organizationId=org-other', { authorization: ADMIN, body: { reason: 'cross-tenant attempt' } });
    assert.equal(revoke.status, 404, revoke.text);
    const smuggled = await call(baseUrl, 'POST', '/api/admin/authority/entities/actor/actor-other/revoke', { authorization: ADMIN, body: { reason: 'cross-tenant attempt', organizationId: 'org-other' } });
    assert.equal(smuggled.status, 400, smuggled.text);
    const record = await store.getRecord({ system: true }, 'org-other', 'actor', 'actor-other');
    assert.equal(record?.status, 'active', "the other organization's authority is untouched");
    // This organization's own actor is visible.
    assert.equal((await call(baseUrl, 'GET', `/api/admin/authority/entities/actor/${AGENT}`, { authorization: ADMIN })).body['organizationId'], ORG);
  });
});

describe('CTRL-01 bounded-grant revocation — the CORE-01 path, through HTTP', () => {
  it('inspect → revoke → inspect; signed, committed, evidenced; the real exercise path withholds and no adapter runs', async () => {
    const dir = workDir();
    const { host, baseUrl, adapter } = await boot(secureEnv(dir));
    await provision(host);
    const { grantId, executionId, requestId } = await executedGrant(baseUrl);
    assert.equal(adapter.calls.length, 1);

    const before = await call(baseUrl, 'GET', grantPath(grantId), { authorization: ADMIN });
    assert.equal(before.status, 200, before.text);
    assert.equal(before.body['grantId'], grantId);
    assert.equal(before.body['subject'], AGENT);
    assert.deepEqual(before.body['provenance'], { requestId, decisionId: (before.body['provenance'] as Record<string, unknown>)['decisionId'], action: ACTION, resourceScope: RESOURCE });
    assert.deepEqual((before.body['status'] as Record<string, unknown>)['eligibility'], 'exercisable');
    for (const internal of ['digest', 'sourceDigest', 'signature', 'signing_key_id', 'grant_json', 'authorityBindingDigest']) {
      assert.equal(before.text.includes(`"${internal}"`), false, `the grant view does not serialize ${internal}`);
    }
    const ace = host.enterprise.authorityControlledExecution;
    assert.ok(ace !== undefined);
    const exercise = exerciseOf(before.body, `${executionId}:ctrl01-retry`);
    assert.equal((await ace.assessExercise(exercise)).usable, true, 'before revocation the exercise path would accept this grant');

    const revoked = await call(baseUrl, 'POST', `${grantPath(grantId)}/revoke`, { authorization: ADMIN, body: { reason: 'security-incident' } });
    assert.equal(revoked.status, 200, revoked.text);
    assert.equal(revoked.body['outcome'], 'revoked');
    const revocation = revoked.body['revocation'] as Record<string, unknown>;
    assert.equal(revocation['reason'], 'security-incident');
    assert.equal(revocation['revokedBy'], PRIMARY);

    // CORE-01: one signed revocation, signed by the configured key, and the signed state commitment advanced.
    const rows = revocationRows(dir);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.grant_id, grantId);
    assert.equal(rows[0]?.signing_key_id, AUTHORITY_KEY_A.keyId);
    assert.ok((rows[0]?.signature.length ?? 0) > 0);
    assert.equal(await revocationSequence(baseUrl), 1);

    // Read-after-write: immediately authoritative.
    const afterRead = await call(baseUrl, 'GET', grantPath(grantId), { authorization: ADMIN });
    assert.deepEqual((afterRead.body['status'] as Record<string, unknown>)['reasonCodes'], ['GRANT_REVOKED']);
    assert.deepEqual(afterRead.body['revocation'], revocation);

    // The same state the execution path consumes: withheld, no adapter call.
    const assessment = await ace.assessExercise(exercise);
    assert.equal(assessment.usable, false);
    assert.ok(assessment.reasonCodes.some((code) => code.includes('REVOKED')), String(assessment.reasonCodes));
    const outcome = await ace.exercise(exercise);
    assert.equal(outcome.status, 'withheld');
    assert.equal(adapter.calls.length, 1, 'adapter calls after revocation == 0');

    // P8: the canonical stream carries the revocation against this grant's own request.
    const reader = host.enterprise.authorityEventStream;
    assert.ok(reader !== undefined);
    const streamId = deriveAuthorityEventStreamId({ organizationId: ORG, requestId });
    let events: readonly { eventType: string; references: { boundedGrantId?: string } }[] = [];
    for (let attempt = 0; attempt < 200 && !events.some((event) => event.eventType === 'grant.revoked'); attempt += 1) {
      await new Promise((resolvePromise) => setImmediate(resolvePromise));
      events = await reader.readStream({ organizationId: ORG }, streamId);
    }
    const revokedEvent = events.find((event) => event.eventType === 'grant.revoked');
    assert.ok(revokedEvent !== undefined, 'grant.revoked is on the canonical stream');
    assert.equal(revokedEvent.references.boundedGrantId, grantId);
    assert.equal((await reader.verifyStream({ organizationId: ORG }, streamId)).valid, true);
  });

  it('IDEMPOTENT: a repeat — even with a different reason — reports already-revoked with the first revocation, and signs nothing new', async () => {
    const dir = workDir();
    const { host, baseUrl } = await boot(secureEnv(dir));
    await provision(host);
    const { grantId } = await executedGrant(baseUrl);
    const first = await call(baseUrl, 'POST', `${grantPath(grantId)}/revoke`, { authorization: ADMIN, body: { reason: 'security-incident' } });
    const second = await call(baseUrl, 'POST', `${grantPath(grantId)}/revoke`, { authorization: bearer(SECOND_ADMIN_KEY), body: { reason: 'policy-changed' } });
    assert.equal(first.body['outcome'], 'revoked');
    assert.equal(second.status, 200, second.text);
    assert.equal(second.body['outcome'], 'already-revoked');
    assert.deepEqual(second.body['revocation'], first.body['revocation'], 'the first revocation stands, unchanged');
    assert.equal(revocationRows(dir).length, 1);
    assert.equal(await revocationSequence(baseUrl), 1, 'the signed commitment was not advanced again');
  });

  it('CONCURRENT: many simultaneous revocations of two grants each commit exactly once; the signed state verifies and survives restart', async () => {
    const dir = workDir();
    const env = secureEnv(dir);
    const first = await boot(env);
    await provision(first.host);
    const a = await executedGrant(first.baseUrl);
    const b = await executedGrant(first.baseUrl);
    const attempts = Array.from({ length: 24 }, (_, index) =>
      call(first.baseUrl, 'POST', `${grantPath(index % 2 === 0 ? a.grantId : b.grantId)}/revoke`, { authorization: index % 3 === 0 ? bearer(SECOND_ADMIN_KEY) : ADMIN, body: { reason: 'security-incident' } }),
    );
    const replies = await Promise.all(attempts);
    for (const reply of replies) assert.equal(reply.status, 200, reply.text);
    for (const grantId of [a.grantId, b.grantId]) {
      const mine = replies.filter((reply) => reply.body['grantId'] === grantId);
      assert.equal(mine.filter((reply) => reply.body['outcome'] === 'revoked').length, 1, 'exactly one revocation commits per grant');
      assert.equal(new Set(mine.map((reply) => JSON.stringify(reply.body['revocation']))).size, 1, 'every reply reports the same revocation');
    }
    assert.equal(revocationRows(dir).length, 2);
    assert.equal(await revocationSequence(first.baseUrl), 2);
    assert.equal((await call(first.baseUrl, 'GET', '/ready')).status, 200);
    await first.host.close();

    const second = await boot(env);
    for (const grantId of [a.grantId, b.grantId]) {
      const view = await call(second.baseUrl, 'GET', grantPath(grantId), { authorization: ADMIN });
      assert.deepEqual((view.body['status'] as Record<string, unknown>)['reasonCodes'], ['GRANT_REVOKED']);
    }
  });

  it('NO UN-REVOKE: no method or path restores, deletes or clears a revocation; every attempt is a 404 and the revocation stands', async () => {
    const dir = workDir();
    const { host, baseUrl } = await boot(secureEnv(dir));
    await provision(host);
    const { grantId } = await executedGrant(baseUrl);
    await call(baseUrl, 'POST', `${grantPath(grantId)}/revoke`, { authorization: ADMIN, body: { reason: 'security-incident' } });
    await call(baseUrl, 'POST', `${delegationPath}/revoke`, { authorization: ADMIN, body: { reason: 'offboarded' } });

    const attempts: readonly [string, string][] = [
      ['DELETE', `${grantPath(grantId)}/revoke`],
      ['DELETE', `${grantPath(grantId)}/revocation`],
      ['DELETE', grantPath(grantId)],
      ['PUT', grantPath(grantId)],
      ['PATCH', grantPath(grantId)],
      ['POST', `${grantPath(grantId)}/unrevoke`],
      ['POST', `${grantPath(grantId)}/restore`],
      ['POST', `${grantPath(grantId)}/reactivate`],
      ['POST', `${grantPath(grantId)}/reinstate`],
      ['POST', grantPath(grantId)],
      ['GET', `${grantPath(grantId)}/revoke`],
      ['DELETE', `${delegationPath}/revoke`],
      ['POST', `${delegationPath}/unrevoke`],
      ['POST', `${delegationPath}/reactivate`],
      ['PATCH', delegationPath],
      ['POST', '/api/admin/authority/grants'],
      ['POST', '/api/admin/authority/entities/delegation-grant'],
    ];
    for (const [method, path] of attempts) {
      const reply = await call(baseUrl, method, path, { authorization: ADMIN, ...(method === 'GET' ? {} : { body: { status: 'active', reason: 'restore' } }) });
      assert.equal(reply.status, 404, `${method} ${path}: ${reply.text}`);
      assert.equal(errorCode(reply), 'NOT_FOUND');
    }
    assert.deepEqual(((await call(baseUrl, 'GET', grantPath(grantId), { authorization: ADMIN })).body['status'] as Record<string, unknown>)['reasonCodes'], ['GRANT_REVOKED']);
    assert.equal((await call(baseUrl, 'GET', delegationPath, { authorization: ADMIN })).body['status'], 'revoked');
    assert.equal(revocationRows(dir).length, 1);
    // The in-process surface agrees: re-provisioning a revoked id is refused by the store's own rule.
    const service = host.enterprise.kernelAuthorityProvisioning;
    assert.ok(service !== undefined);
    const payloads = buildDurableAuthorityPayloads(ORG, TRUST_DOMAIN);
    await assert.rejects(
      service.provisionDelegationGrant(DURABLE_FIXTURE_OPERATOR, { ...payloads.delegationGrant, delegationGrantId: DELEGATION, delegatorActorId: OWNER, delegateActorId: AGENT, sourceAuthorityGrantId: 'authority-grant-owner', actions: [ACTION], resourceScopes: [RESOURCE] }),
      /revoked/,
    );
  });

  it('INPUT: unknown id → 404; malformed id, bad JSON, wrong reason → 400; non-JSON → 415; oversized → 400 — and nothing is revoked', async () => {
    const dir = workDir();
    const { host, baseUrl } = await boot(secureEnv(dir));
    await provision(host);
    const { grantId } = await executedGrant(baseUrl);
    const unknown = `aoc.grant:${'0'.repeat(32)}`;
    const cases: readonly [string, string, Parameters<typeof call>[3], number, string][] = [
      ['GET', grantPath(unknown), {}, 404, 'AUTHORITY_ADMIN_TARGET_NOT_FOUND'],
      ['POST', `${grantPath(unknown)}/revoke`, { body: { reason: 'security-incident' } }, 404, 'AUTHORITY_ADMIN_TARGET_NOT_FOUND'],
      ['GET', grantPath('grant-1'), {}, 400, 'INVALID_REQUEST'],
      ['GET', '/api/admin/authority/grants/%E0%A4%A', {}, 400, 'INVALID_REQUEST'],
      ['POST', `${grantPath(grantId)}/revoke`, { rawBody: '{"reason":', headers: { 'content-type': 'application/json' } }, 400, 'INVALID_REQUEST'],
      ['POST', `${grantPath(grantId)}/revoke`, { body: { reason: 'because' } }, 400, 'INVALID_REQUEST'],
      ['POST', `${grantPath(grantId)}/revoke`, { body: {} }, 400, 'INVALID_REQUEST'],
      ['POST', `${grantPath(grantId)}/revoke`, { rawBody: '{"reason":"security-incident"}', headers: { 'content-type': 'text/plain' } }, 415, 'INVALID_REQUEST'],
      ['GET', '/api/admin/authority/entities/galaxy/x', {}, 400, 'INVALID_REQUEST'],
      ['GET', '/api/admin/authority/entities/delegation-grant/unknown-delegation', {}, 404, 'AUTHORITY_ADMIN_TARGET_NOT_FOUND'],
      ['POST', '/api/admin/authority/entities/delegation-grant/unknown-delegation/revoke', { body: { reason: 'x' } }, 404, 'AUTHORITY_ADMIN_TARGET_NOT_FOUND'],
      ['POST', `/api/admin/authority/entities/trust-domain/${TRUST_DOMAIN}/revoke`, { body: { reason: 'x' } }, 400, 'INVALID_REQUEST'],
      ['POST', `${delegationPath}/revoke`, { body: { reason: '' } }, 400, 'INVALID_REQUEST'],
      ['GET', '/api/admin/authority/executions/aoc.gex:unknown', {}, 404, 'AUTHORITY_ADMIN_TARGET_NOT_FOUND'],
    ];
    for (const [method, path, options, status, code] of cases) {
      const reply = await call(baseUrl, method, path, { authorization: ADMIN, ...options });
      assert.equal(reply.status, status, `${method} ${path}: ${reply.text}`);
      assert.equal(errorCode(reply), code, `${method} ${path}: ${reply.text}`);
    }
    // An oversized body is cut off by the Host's shared body reader (it answers
    // 400 and destroys the request stream, so a client may see either).
    let oversized: number | 'connection-closed';
    try {
      oversized = (await call(baseUrl, 'POST', `${grantPath(grantId)}/revoke`, { rawBody: JSON.stringify({ reason: 'security-incident', pad: 'x'.repeat(64 * 1024) }), headers: { 'content-type': 'application/json' }, authorization: ADMIN })).status;
    } catch {
      oversized = 'connection-closed';
    }
    assert.ok(oversized === 400 || oversized === 'connection-closed', String(oversized));
    assert.equal(revocationRows(dir).length, 0);
    assert.equal((await call(baseUrl, 'GET', delegationPath, { authorization: ADMIN })).body['status'], 'active');
  });
});

describe('CTRL-01 fail-closed — unverifiable authority state is reported as an integrity failure, never as absent, active or revoked', () => {
  it('a revocation deleted from the database while the Host runs: reads and revocations refuse with AUTHORITY_STATE_INTEGRITY_FAILED, not 404 and not success', async () => {
    const dir = workDir();
    const { host, baseUrl, adapter } = await boot(secureEnv(dir));
    await provision(host);
    const a = await executedGrant(baseUrl);
    const b = await executedGrant(baseUrl);
    await call(baseUrl, 'POST', `${grantPath(a.grantId)}/revoke`, { authorization: ADMIN, body: { reason: 'security-incident' } });

    const db = new Database(join(dir, 'bounded-grants.sqlite'));
    dropAuthorityStoreTriggers(db);
    db.prepare('DELETE FROM bounded_grant_revocations WHERE grant_id = ?').run(a.grantId);
    db.prepare('UPDATE bounded_grants SET revocation_digest = NULL WHERE grant_id = ?').run(a.grantId);
    db.close();

    for (const reply of [
      await call(baseUrl, 'GET', grantPath(a.grantId), { authorization: ADMIN }),
      await call(baseUrl, 'GET', grantPath(b.grantId), { authorization: ADMIN }),
      await call(baseUrl, 'POST', `${grantPath(b.grantId)}/revoke`, { authorization: ADMIN, body: { reason: 'security-incident' } }),
    ]) {
      assert.equal(reply.status, 500, reply.text);
      assert.equal(errorCode(reply), 'AUTHORITY_STATE_INTEGRITY_FAILED');
      assert.equal((reply.body['error'] as Record<string, unknown>)['failure'], 'BOUNDED_GRANT_STORE_REVOCATION_STATE_INCONSISTENT');
      assertNoSecret(reply.text, 'an integrity refusal');
      assert.equal(/SELECT|sqlite|\.sqlite|BEGIN PUBLIC KEY/i.test(reply.text), false, 'no internals in the refusal');
    }
    assert.equal((await govern(baseUrl)).body['status'] === 'executed', false, 'nothing executes against an unverifiable revocation state');
    assert.equal(adapter.calls.length, 2);
  });

  it('a tampered grant record is an integrity failure on read', async () => {
    const dir = workDir();
    const { host, baseUrl } = await boot(secureEnv(dir));
    await provision(host);
    const { grantId } = await executedGrant(baseUrl);
    const db = new Database(join(dir, 'bounded-grants.sqlite'));
    dropAuthorityStoreTriggers(db);
    db.prepare("UPDATE bounded_grants SET grant_json = replace(grant_json, 'resource-ledger-1', 'resource-ledger-9') WHERE grant_id = ?").run(grantId);
    db.close();
    const reply = await call(baseUrl, 'GET', grantPath(grantId), { authorization: ADMIN });
    assert.equal(reply.status, 500, reply.text);
    assert.equal(errorCode(reply), 'AUTHORITY_STATE_INTEGRITY_FAILED');
  });

  it('a tampered Kernel Authority event is an integrity failure on read, never a status', async () => {
    const dir = workDir();
    const { host, baseUrl } = await boot(secureEnv(dir));
    await provision(host);
    const db = new Database(join(dir, 'kernel-authority.sqlite'));
    dropAuthorityStoreTriggers(db);
    db.prepare("UPDATE kernel_authority_events SET payload_json = replace(payload_json, 'resource-ledger-1', 'resource-ledger-9') WHERE entity_id = ?").run(DELEGATION);
    db.close();
    const reply = await call(baseUrl, 'GET', delegationPath, { authorization: ADMIN });
    assert.equal(reply.status, 500, reply.text);
    assert.equal(errorCode(reply), 'AUTHORITY_STATE_INTEGRITY_FAILED');
  });
});

describe('CTRL-01 emergency control — the existing durable interlock, operable over HTTP by administrators only', () => {
  it('activate → governed execution withheld (adapter 0) → survives restart → release → executes; the store records the operator', async () => {
    const dir = workDir();
    const env = secureEnv(dir);
    const first = await boot(env);
    await provision(first.host);
    assert.equal((await govern(first.baseUrl)).body['status'], 'executed');

    const activated = await call(first.baseUrl, 'POST', '/api/admin/emergency-controls/activate', { authorization: ADMIN, body: { scope: 'global' } });
    assert.equal(activated.status, 200, activated.text);
    assert.deepEqual(activated.body, { outcome: 'activated', control: { scope: 'global' }, active: [{ scope: 'global' }] });
    const withheld = await govern(first.baseUrl);
    assert.equal(withheld.body['status'], 'withheld', withheld.text);
    assert.equal(withheld.body['withheldBy'], 'emergency-control');
    assert.equal(first.adapter.calls.length, 1, 'no adapter call while stopped');
    // Idempotent: re-activating leaves one control.
    assert.deepEqual((await call(first.baseUrl, 'POST', '/api/admin/emergency-controls/activate', { authorization: ADMIN, body: { scope: 'global' } })).body['active'], [{ scope: 'global' }]);
    await first.host.close();

    const second = await boot(env);
    assert.deepEqual((await call(second.baseUrl, 'GET', '/api/admin/emergency-controls', { authorization: ADMIN })).body, { active: [{ scope: 'global' }] });
    assert.equal((await govern(second.baseUrl)).body['status'], 'withheld', 'the stop survived the restart');
    assert.equal((await call(second.baseUrl, 'POST', '/api/admin/emergency-controls/release', { authorization: bearer(AGENT_KEY), body: { scope: 'global' } })).status, 403, 'an ordinary caller cannot resume execution');
    const released = await call(second.baseUrl, 'POST', '/api/admin/emergency-controls/release', { authorization: bearer(SECOND_ADMIN_KEY), body: { scope: 'global' } });
    assert.equal(released.status, 200, released.text);
    assert.deepEqual(released.body['active'], []);
    assert.equal((await govern(second.baseUrl)).body['status'], 'executed');
    assert.equal(second.adapter.calls.length, 1);

    const db = new Database(join(dir, 'emergency-controls.sqlite'), { readonly: true });
    const history = db.prepare('SELECT transition, issuer_ref FROM emergency_control_events ORDER BY sequence').all() as { transition: string; issuer_ref: string }[];
    db.close();
    assert.deepEqual(
      history.map((row) => [row.transition, row.issuer_ref]),
      [
        ['activated', PRIMARY],
        ['released', SECONDARY],
      ],
    );
  });

  it('an actor-scoped stop withholds that actor only; malformed or inert controls are refused', async () => {
    const dir = workDir();
    const { host, baseUrl, adapter } = await boot(secureEnv(dir));
    await provision(host);
    assert.equal((await call(baseUrl, 'POST', '/api/admin/emergency-controls/activate', { authorization: ADMIN, body: { scope: 'actor', value: 'actor-someone-else' } })).status, 200);
    assert.equal((await govern(baseUrl)).body['status'], 'executed', 'a stop on another actor does not apply');
    assert.equal((await call(baseUrl, 'POST', '/api/admin/emergency-controls/activate', { authorization: ADMIN, body: { scope: 'actor', value: AGENT } })).status, 200);
    assert.equal((await govern(baseUrl)).body['withheldBy'], 'emergency-control');
    assert.equal(adapter.calls.length, 1);
    for (const body of [{ scope: 'workflow', value: 'wf-1' }, { scope: 'global', value: 'x' }, { scope: 'actor' }, { scope: 'global', issuerRef: 'attacker' }, { scope: 'everything' }]) {
      const reply = await call(baseUrl, 'POST', '/api/admin/emergency-controls/activate', { authorization: ADMIN, body });
      assert.equal(reply.status, 400, `${JSON.stringify(body)}: ${reply.text}`);
    }
  });
});

describe('CTRL-01 END TO END — the operator flow, without a database, a REPL or the repository', () => {
  it('authenticate → inspect → revoke → inspect → governed action denied (adapter 0) → restart → still revoked → still denied', async () => {
    const dir = workDir();
    const env = secureEnv(dir);
    const first = await boot(env);
    await provision(first.host);

    // A governed action executes under the provisioned authority. The operator
    // has only what the application has: the response's executionId.
    const { grantId } = await executedGrant(first.baseUrl);
    assert.equal(first.adapter.calls.length, 1);

    // Inspect the standing authority the agent acts under, and the grant its last action ran under.
    const delegationBefore = await call(first.baseUrl, 'GET', delegationPath, { authorization: ADMIN });
    assert.equal(delegationBefore.status, 200, delegationBefore.text);
    assert.equal(delegationBefore.body['status'], 'active');
    assert.deepEqual((delegationBefore.body['terms'] as Record<string, unknown>)['actions'], [ACTION]);
    assert.equal(((await call(first.baseUrl, 'GET', grantPath(grantId), { authorization: ADMIN })).body['status'] as Record<string, unknown>)['eligibility'], 'exercisable');

    // Revoke both through CTRL-01.
    const revokeDelegation = await call(first.baseUrl, 'POST', `${delegationPath}/revoke`, { authorization: ADMIN, body: { reason: 'agent offboarded after incident INC-1' } });
    assert.equal(revokeDelegation.status, 200, revokeDelegation.text);
    assert.equal(revokeDelegation.body['outcome'], 'revoked');
    const revokeGrant = await call(first.baseUrl, 'POST', `${grantPath(grantId)}/revoke`, { authorization: ADMIN, body: { reason: 'security-incident' } });
    assert.equal(revokeGrant.body['outcome'], 'revoked');

    // Inspect again: revoked, immediately.
    const delegationAfter = await call(first.baseUrl, 'GET', delegationPath, { authorization: ADMIN });
    assert.equal(delegationAfter.body['status'], 'revoked');
    assert.equal(delegationAfter.body['revokedBy'], PRIMARY);
    assert.equal(delegationAfter.body['revocationReason'], 'agent offboarded after incident INC-1');
    assert.deepEqual(((await call(first.baseUrl, 'GET', grantPath(grantId), { authorization: ADMIN })).body['status'] as Record<string, unknown>)['reasonCodes'], ['GRANT_REVOKED']);

    // The agent tries again: the Kernel denies it against the same durable authority the API changed.
    const denied = await govern(first.baseUrl);
    assert.equal(denied.body['status'], 'denied', denied.text);
    assert.equal(first.adapter.calls.length, 1, 'adapter calls after revocation == 0');
    await first.host.close();

    // A fresh process image over the same files.
    const second = await boot(env);
    assert.equal((await call(second.baseUrl, 'GET', delegationPath, { authorization: ADMIN })).body['status'], 'revoked', 'the revocation survived the restart');
    assert.deepEqual(((await call(second.baseUrl, 'GET', grantPath(grantId), { authorization: ADMIN })).body['status'] as Record<string, unknown>)['reasonCodes'], ['GRANT_REVOKED']);
    const stillDenied = await govern(second.baseUrl);
    assert.equal(stillDenied.body['status'], 'denied', stillDenied.text);
    assert.equal(second.adapter.calls.length, 0, 'adapter calls after restart == 0');
    // A repeat after restart is idempotent, not a second history.
    assert.equal((await call(second.baseUrl, 'POST', `${delegationPath}/revoke`, { authorization: ADMIN, body: { reason: 'retry' } })).body['outcome'], 'already-revoked');
    const events = await second.host.enterprise.kernelAuthorityProvisioning?.listEvents({ system: false, organizationId: ORG }, 'delegation-grant', DELEGATION);
    assert.equal(events?.length, 2);

    for (const text of responses) assertNoSecret(text, 'an administration response');
    for (const line of logLines) assertNoSecret(line, 'the Host log');
  });

  it('CONCURRENT Kernel Authority revocation commits once; every reply agrees', async () => {
    const dir = workDir();
    const { host, baseUrl } = await boot(secureEnv(dir));
    await provision(host);
    const replies = await Promise.all(Array.from({ length: 12 }, () => call(baseUrl, 'POST', `${delegationPath}/revoke`, { authorization: ADMIN, body: { reason: 'offboarded' } })));
    for (const reply of replies) assert.equal(reply.status, 200, reply.text);
    assert.equal(replies.filter((reply) => reply.body['outcome'] === 'revoked').length, 1);
    assert.equal(new Set(replies.map((reply) => (reply.body['entity'] as Record<string, unknown>)['revokedAt'])).size, 1);
    const events = await host.enterprise.kernelAuthorityProvisioning?.listEvents({ system: false, organizationId: ORG }, 'delegation-grant', DELEGATION);
    assert.equal(events?.length, 2, 'one provisioning event, one revocation event');
  });
});
