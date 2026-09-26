import { after, afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns';
import diagnosticsChannel from 'node:diagnostics_channel';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';

import type { ExecutionAdapter, ExecutionAdapterResult, ValidatedExecutionAction } from '../../features/execution-runtime/index.js';
import { loadEnterpriseConfiguration } from '../configuration/enterprise-configuration.js';
import { AuthorityAuthenticityConfigurationError } from '../authority-authenticity/index.js';
import { GenericHttpConfigurationError } from '../execution-adapters/generic-http/index.js';
import { buildDurableAuthorityPayloads, DURABLE_FIXTURE_OPERATOR } from '../kernel-authority/fixtures/durable-authority.fixture.js';
import type { KernelAuthorityProvisioningService } from '../kernel-authority/provisioning-service.js';
import { createEnterpriseServer } from '../host/enterprise-server.js';
import { bootEnterpriseHost, type EnterpriseHost } from '../host/enterprise-host.js';
import { EnterpriseHostConfigurationError } from '../host/host-configuration.js';
import type { EnterpriseLogger } from '../telemetry/enterprise-logger.js';
import { AUTHORITY_KEY_A, AUTHORITY_KEY_UNTRUSTED, authorityAuthenticityEnv, dropAuthorityStoreTriggers, trustedKeyOf } from './authority-authenticity-fixture.js';

/**
 * PROD-01 — the Enterprise Host an operator starts, qualified end to end.
 *
 * Every test here boots through `bootEnterpriseHost()` — the function
 * `npm run start:enterprise` calls — from a plain environment and a
 * governed-action file, over real SQLite files, a real listener and real
 * Ed25519 authority signing. Nothing below the bootstrap is injected except
 * one in-process provider adapter (the bootstrap's documented embedder seam,
 * which the launcher never uses), because the only production adapter,
 * Generic HTTP, is HTTPS-to-public-addresses only and a test must not reach
 * the network. The Generic HTTP adapter is composed in every secure Host here
 * and is exercised through its own public-address refusal, with the system
 * resolver replaced and HTTP client requests counted.
 */

const ORG = 'org-acme';
const TRUST_DOMAIN = 'trust-domain-acme';
const ACTION = 'invoice.approve';
const GENERIC_ACTION = 'invoice.sync';
const RESOURCE = 'resource-ledger-1';
const OWNER = 'actor-owner';
const AGENT = 'actor-agent';
const OUTSIDER = 'actor-outsider';
const AGENT_SUBJECT = { system: 'erp-app', subjectId: 'agent-1' } as const;
const OUTSIDER_SUBJECT = { system: 'erp-app', subjectId: 'outsider-1' } as const;
const RECORDING_ADAPTER_ID = 'test.recording';
const GENERIC_ADAPTER_ID = 'erp.generic';

const AGENT_KEY = 'FRONTERA_PROD01_AGENT_KEY_SENTINEL_7f3a91';
const OUTSIDER_KEY = 'FRONTERA_PROD01_OUTSIDER_KEY_SENTINEL_c02d';
const LEGACY_KEY = 'FRONTERA_PROD01_LEGACY_KEY_SENTINEL_5be8';
const ERP_TOKEN = 'FRONTERA_PROD01_ERP_TOKEN_SENTINEL_91c2';
const SECRETS = [AGENT_KEY, OUTSIDER_KEY, LEGACY_KEY, ERP_TOKEN, AUTHORITY_KEY_A.privateKeyPem.split('\n')[1] ?? 'unreachable'];

// -- network observation (Generic HTTP) ------------------------------------------

const network = { lookups: [] as string[], httpRequests: 0 };
diagnosticsChannel.subscribe('http.client.request.start', () => {
  network.httpRequests += 1;
});
const realLookup = dns.promises.lookup;
beforeEach(() => {
  network.lookups.length = 0;
  network.httpRequests = 0;
  // The pinned hostname resolves to a private address: the production adapter
  // must refuse it before any connection. No test here can reach the network.
  (dns.promises as { lookup: unknown }).lookup = async (hostname: string) => {
    network.lookups.push(hostname);
    return [{ address: '10.20.30.40', family: 4 }];
  };
});
afterEach(() => {
  (dns.promises as { lookup: unknown }).lookup = realLookup;
});

// -- workspace -----------------------------------------------------------------

const directories: string[] = [];
const hosts: EnterpriseHost[] = [];
after(async () => {
  for (const host of hosts) await host.close().catch(() => {});
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

function workDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'frontera-prod01-'));
  directories.push(directory);
  return directory;
}

interface GovernedFile {
  readonly [key: string]: unknown;
}

function governedFile(overrides: GovernedFile = {}): GovernedFile {
  return {
    version: 1,
    trustDomainId: TRUST_DOMAIN,
    grantLifetimeSeconds: 300,
    customerPrincipals: [
      { principalId: 'principal-agent', externalSubject: AGENT_SUBJECT, apiKeyEnv: 'FRONTERA_TEST_AGENT_KEY' },
      { principalId: 'principal-outsider', externalSubject: OUTSIDER_SUBJECT, apiKeyEnv: 'FRONTERA_TEST_OUTSIDER_KEY' },
    ],
    genericHttpAdapters: [
      {
        adapterId: GENERIC_ADAPTER_ID,
        origin: 'https://erp.example.com',
        method: 'POST',
        path: [{ kind: 'literal', value: 'actions' }],
        body: { kind: 'json-object', fields: { action: { kind: 'source', source: 'action' }, executionId: { kind: 'source', source: 'correlation.executionId' } } },
        credential: { kind: 'bearer', tokenEnv: 'FRONTERA_TEST_ERP_TOKEN' },
      },
    ],
    routes: [
      { action: ACTION, adapterId: RECORDING_ADAPTER_ID },
      { action: GENERIC_ACTION, adapterId: GENERIC_ADAPTER_ID },
    ],
    ...overrides,
  };
}

function secureEnv(dir: string, overrides: Record<string, string | undefined> = {}, file: GovernedFile = governedFile()): Record<string, string | undefined> {
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
    FRONTERA_TEST_OUTSIDER_KEY: OUTSIDER_KEY,
    FRONTERA_TEST_ERP_TOKEN: ERP_TOKEN,
    ...overrides,
  };
}

interface RecordingAdapter extends ExecutionAdapter {
  readonly calls: ValidatedExecutionAction[];
}

function recordingAdapter(result: ExecutionAdapterResult = { outcome: 'completed', providerRef: 'provider-ref-1' }): RecordingAdapter {
  const calls: ValidatedExecutionAction[] = [];
  return {
    adapterId: RECORDING_ADAPTER_ID,
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

/** The operator's authority world, through the trusted in-process provisioning surface — the only one today (CTRL-01 adds a route). */
async function provision(service: KernelAuthorityProvisioningService): Promise<void> {
  const payloads = buildDurableAuthorityPayloads(ORG, TRUST_DOMAIN);
  const operator = DURABLE_FIXTURE_OPERATOR;
  await service.provisionActor(operator, payloads.issuerActor);
  await service.provisionTrustDomain(operator, payloads.trustDomain);
  await service.provisionRootIssuer(operator, payloads.rootIssuer);
  await service.provisionActor(operator, { ...payloads.ownerActor, actorId: OWNER, displayName: 'Owner', externalSubject: { system: 'erp-app', subjectId: 'owner-1' } });
  await service.provisionActor(operator, { ...payloads.agentActor, actorId: AGENT, displayName: 'Agent', externalSubject: AGENT_SUBJECT });
  await service.provisionActor(operator, { ...payloads.agentActor, actorId: OUTSIDER, displayName: 'Outsider', externalSubject: OUTSIDER_SUBJECT });
  await service.provisionPassport(operator, { ...payloads.passport, passportId: `passport-${AGENT}`, subjectActorId: AGENT });
  await service.provisionCapabilityToken(operator, {
    ...payloads.capabilityToken,
    capabilityTokenId: `cap-${AGENT}`,
    subjectActorId: AGENT,
    principalActorId: OWNER,
    issuerActorId: OWNER,
    actions: [ACTION, GENERIC_ACTION],
    resourceScopes: [RESOURCE],
  });
  await service.provisionAuthorityGrant(operator, { ...payloads.authorityGrant, authorityGrantId: 'authority-grant-owner', subjectActorId: OWNER, actions: [ACTION, GENERIC_ACTION], resourceScopes: [RESOURCE] });
  await service.provisionDelegationGrant(operator, {
    ...payloads.delegationGrant,
    delegationGrantId: 'delegation-agent',
    delegatorActorId: OWNER,
    delegateActorId: AGENT,
    sourceAuthorityGrantId: 'authority-grant-owner',
    actions: [ACTION, GENERIC_ACTION],
    resourceScopes: [RESOURCE],
  });
}

function provisioningOf(host: EnterpriseHost): KernelAuthorityProvisioningService {
  const provisioning = host.enterprise.kernelAuthorityProvisioning;
  assert.ok(provisioning !== undefined, 'the secure Host composes the durable Kernel Authority operator surface');
  return provisioning;
}

interface Reply {
  readonly status: number;
  readonly text: string;
  readonly body: Record<string, unknown>;
}

async function govern(baseUrl: string, intent: Record<string, unknown>, authorization?: string): Promise<Reply> {
  const response = await fetch(`${baseUrl}/api/governed-actions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(authorization !== undefined ? { authorization } : {}) },
    body: JSON.stringify(intent),
  });
  const text = await response.text();
  return { status: response.status, text, body: JSON.parse(text) as Record<string, unknown> };
}

async function getJson(baseUrl: string, path: string, authorization?: string): Promise<Reply> {
  const response = await fetch(`${baseUrl}${path}`, { headers: authorization !== undefined ? { authorization } : {} });
  const text = await response.text();
  return { status: response.status, text, body: JSON.parse(text) as Record<string, unknown> };
}

const bearer = (secret: string): string => `Bearer ${secret}`;
let sequence = 0;
const intent = (action: string = ACTION, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ action, resource: RESOURCE, idempotencyKey: `prod01-${(sequence += 1)}`, ...extra });

function assertNoSecret(text: string, where: string): void {
  for (const secret of SECRETS) assert.equal(text.includes(secret), false, `${where} must not contain a configured secret`);
}

/** Open descriptors of this process pointing into `dir`. Linux only; elsewhere the leak checks skip rather than pass vacuously. */
const CAN_SEE_HANDLES = existsSync('/proc/self/fd');
function handlesUnder(dir: string): string[] {
  const open: string[] = [];
  for (const fd of readdirSync('/proc/self/fd')) {
    try {
      const target = readlinkSync(`/proc/self/fd/${fd}`);
      if (target.startsWith(dir)) open.push(target);
    } catch {
      // raced with a close
    }
  }
  return open;
}

async function refusal(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof Error);
    return error;
  }
  assert.fail('expected the Enterprise Host to refuse to boot');
}

function grantRows(dir: string): { grant_id: string; signature: string; signing_key_id: string }[] {
  const db = new Database(join(dir, 'bounded-grants.sqlite'), { readonly: true });
  try {
    return db.prepare('SELECT grant_id, signature, signing_key_id FROM bounded_grants').all() as { grant_id: string; signature: string; signing_key_id: string }[];
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------------

describe('PROD-01 reproduction — the pre-PROD-01 shipped host path composed no governed-action spine', () => {
  it('createEnterpriseServer() over a production/SQLite environment — what the launcher used to call — boots ready with no governed actions, no authority store and no authentication', async () => {
    const dir = workDir();
    // Exactly the old launcher: `createEnterpriseServer()` over the process
    // environment, here a production + SQLite one with nothing else configured.
    const env = { AOC_ENTERPRISE_ENV: 'production', AOC_ENTERPRISE_PERSISTENCE_PROVIDER: 'sqlite', AOC_ENTERPRISE_SQLITE_PATH: join(dir, 'governance.sqlite'), AOC_ENTERPRISE_PASSPORT_SQLITE_PATH: join(dir, 'passport.sqlite'), AOC_ENTERPRISE_ASSURANCE_SQLITE_PATH: join(dir, 'assurance.sqlite'), AOC_ENTERPRISE_HTTP_HOST: '127.0.0.1', AOC_ENTERPRISE_HTTP_PORT: '0', AOC_ENTERPRISE_LOG_LEVEL: 'error' };
    const server = await createEnterpriseServer({ configuration: loadEnterpriseConfiguration(env) });
    try {
      const { port } = await server.listen();
      const baseUrl = `http://127.0.0.1:${port}`;
      const health = await server.enterprise.health();
      assert.equal(health.status, 'healthy', 'the old path reported fully healthy');
      assert.deepEqual(
        { governedActions: health.posture?.governedActions, authorityStore: health.posture?.authorityStore, authentication: health.posture?.authentication, kernelAuthority: health.posture?.kernelAuthority },
        { governedActions: 'not-composed', authorityStore: 'not-composed', authentication: 'disabled', kernelAuthority: 'not-composed' },
      );
      assert.equal(server.enterprise.governAction, undefined);
      assert.equal(server.enterprise.authorityControlledExecution, undefined);
      assert.equal((await getJson(baseUrl, '/ready')).status, 200, 'and it reported ready');
      const reply = await govern(baseUrl, intent(), bearer(AGENT_KEY));
      assert.equal(reply.status, 404, 'POST /api/governed-actions was not mounted');
      assert.equal(existsSync(join(dir, 'bounded-grants.sqlite')), false, 'no authenticated authority store was ever opened');
    } finally {
      await server.close();
    }
  });

  it('the same environment is refused by the canonical bootstrap', async () => {
    const dir = workDir();
    const error = await refusal(bootEnterpriseHost({ env: { AOC_ENTERPRISE_ENV: 'production', AOC_ENTERPRISE_PERSISTENCE_PROVIDER: 'sqlite', AOC_ENTERPRISE_SQLITE_PATH: join(dir, 'g.sqlite') } }));
    assert.ok(error instanceof EnterpriseHostConfigurationError);
    assert.equal(error.code, 'HOST_AUTHENTICATION_REQUIRED');
  });
});

describe('PROD-01 — a secure Host composes the real governed-action spine', () => {
  it('boots durable, authenticated and governed; health and posture say so; the spine is required', async () => {
    const dir = workDir();
    const { host, baseUrl } = await boot(secureEnv(dir));
    assert.deepEqual(host.posture, {
      environment: 'production',
      persistence: 'durable',
      authentication: 'required',
      governedActions: 'composed',
      authorityStore: 'authenticated-durable',
      kernelAuthority: 'composed',
      emergencyControl: 'composed',
      exerciseControls: 'composed',
      executionAdapters: 2,
    });
    const health = await getJson(baseUrl, '/health');
    assert.equal(health.status, 200);
    assert.equal(health.body['status'], 'healthy');
    const modules = health.body['modules'] as Record<string, { required: boolean; health: { details?: Record<string, unknown> } }>;
    for (const id of ['aoc.enterprise.authority-controlled-execution', 'aoc.enterprise.exercise-control', 'aoc.enterprise.governed-action-orchestrator', 'aoc.enterprise.execution-outcomes', 'aoc.enterprise.kernel-authority']) {
      assert.equal(modules[id]?.required, true, `${id} is required on a governed-action Host`);
    }
    const ace = modules['aoc.enterprise.authority-controlled-execution']?.health.details ?? {};
    assert.equal(ace['grantStore'], 'authenticated-durable');
    assert.equal(ace['revocationState'], 'verified');
    assert.deepEqual((await getJson(baseUrl, '/ready')).body, { ready: true, lifecycleState: 'ready', status: 'healthy' });
    assertNoSecret(health.text, '/health');
    for (const file of ['governance.sqlite', 'kernel-authority.sqlite', 'bounded-grants.sqlite', 'emergency-controls.sqlite', 'exercise-ledger.sqlite', 'execution-outcomes.sqlite', 'authority-event-stream.sqlite']) {
      assert.equal(existsSync(join(dir, file)), true, `${file} is opened at its configured path`);
    }
    assert.equal(existsSync(join(dir, 'execution-resolutions.sqlite')), false, 'P12 is not composed: no resolver implementation ships');
  });

  it('END TO END: an authenticated principal, authorized by durable authority, executes once through a signed grant; the outcome is durable', async () => {
    const dir = workDir();
    const { host, adapter, baseUrl } = await boot(secureEnv(dir));
    await provision(provisioningOf(host));

    const reply = await govern(baseUrl, intent(), bearer(AGENT_KEY));
    assert.equal(reply.status, 200, reply.text);
    assert.equal(reply.body['status'], 'executed', reply.text);
    assert.equal(adapter.calls.length, 1, 'the adapter is reached exactly once');
    const action = adapter.calls[0];
    assert.ok(action !== undefined);
    assert.equal(action.action, ACTION);
    assert.equal(action.resource, RESOURCE);
    assert.equal(action.subject, AGENT, 'the executing subject is the actor bound to the authenticated principal');
    assert.equal(action.organization, ORG);

    // The grant the execution ran under was persisted, signed, by the key the deployment configured.
    const rows = grantRows(dir);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.signing_key_id, AUTHORITY_KEY_A.keyId);
    assert.ok((rows[0]?.signature.length ?? 0) > 0);

    // The durable outcome, read back through the Host's read-only surface.
    const executionId = reply.body['executionId'];
    assert.equal(typeof executionId, 'string');
    const outcome = await host.enterprise.executionOutcomes?.read({ organizationId: ORG }, executionId as string);
    assert.ok(outcome !== undefined, 'the outcome is on durable record');
    assertNoSecret(reply.text, 'a governed-action response');
    assertNoSecret(logLines.join('\n'), 'the Host log');
  });

  it('DENIAL / NO-BYPASS: no credential, a wrong credential, a legacy key, an unauthorized principal and an ungranted resource never reach the adapter', async () => {
    const dir = workDir();
    const { host, adapter, baseUrl } = await boot(secureEnv(dir));
    await provision(provisioningOf(host));

    const missing = await govern(baseUrl, intent());
    assert.equal(missing.status, 401, missing.text);
    const wrong = await govern(baseUrl, intent(), bearer('not-a-configured-key'));
    assert.equal(wrong.status, 401, wrong.text);
    // There is no hidden default credential.
    for (const guess of ['admin', 'secret', 'changeme', 'test-key', 'local-key', 'admin123', 'frontera', 'aoc-enterprise']) {
      const guessed = await govern(baseUrl, intent(), bearer(guess));
      assert.equal(guessed.status, 401, `'${guess}' must not authenticate: ${guessed.text}`);
    }
    const legacy = await govern(baseUrl, intent(), bearer(LEGACY_KEY));
    assert.equal(legacy.status, 403, 'a legacy key is never a customer principal');
    const outsider = await govern(baseUrl, intent(), bearer(OUTSIDER_KEY));
    assert.equal(outsider.body['status'], 'denied', `an authenticated principal without authority is denied: ${outsider.text}`);
    const elsewhere = await govern(baseUrl, intent(ACTION, { resource: 'resource-ledger-2' }), bearer(AGENT_KEY));
    assert.equal(elsewhere.body['status'], 'denied', elsewhere.text);
    // Execution parameters a caller supplies are not authority: routing, adapter
    // and credential fields are rejected at validation.
    for (const field of ['adapterId', 'credential', 'grantId']) {
      const smuggled = await govern(baseUrl, intent(ACTION, { [field]: 'x' }), bearer(AGENT_KEY));
      assert.equal(smuggled.body['status'], 'rejected', `${field}: ${smuggled.text}`);
    }
    assert.equal(adapter.calls.length, 0, 'endpoint accessibility is never authority');
    assert.equal(network.lookups.length, 0);
    assert.equal(network.httpRequests, 0);
  });

  it('GENERIC HTTP: the configured adapter is reached only after authorization, through its own public-address refusal, with no request sent', async () => {
    const dir = workDir();
    const { host, adapter, baseUrl } = await boot(secureEnv(dir));
    await provision(provisioningOf(host));

    const denied = await govern(baseUrl, intent(GENERIC_ACTION), bearer(OUTSIDER_KEY));
    assert.equal(denied.body['status'], 'denied');
    assert.deepEqual(network.lookups, [], 'a denied action never resolves the provider');

    const authorized = await govern(baseUrl, intent(GENERIC_ACTION), bearer(AGENT_KEY));
    assert.equal(authorized.body['status'], 'execution_failed', authorized.text);
    assert.deepEqual(network.lookups, ['erp.example.com'], 'the authorized action reached the Generic HTTP child, which resolved its pinned origin once');
    assert.equal(network.httpRequests, 0, 'a private answer is refused before any request');
    assert.equal(adapter.calls.length, 0, 'routing is by trusted configuration, not by caller');
    assertNoSecret(authorized.text, 'a Generic HTTP result');
  });

  it('the documented example governed-action file boots a secure Host exactly as the launcher would (no embedder adapters)', async () => {
    const dir = workDir();
    // Resolved from the repository root, where the suite runs, like every structural test here.
    const example = join(process.cwd(), 'examples/enterprise-host/governed-actions.example.json');
    const env = secureEnv(dir, { AOC_ENTERPRISE_GOVERNED_ACTIONS_FILE: example, FRONTERA_CUSTOMER_KEY_AGENT_1: AGENT_KEY, FRONTERA_ERP_API_TOKEN: ERP_TOKEN });
    const host = await bootEnterpriseHost({ env });
    hosts.push(host);
    assert.equal(host.posture.governedActions, 'composed');
    assert.equal(host.posture.authorityStore, 'authenticated-durable');
    assert.equal(host.posture.executionAdapters, 1, 'only the configured Generic HTTP adapter');
    await host.close();
  });

  it('an action with no configured route is authorized by the Kernel and still reaches no adapter', async () => {
    const dir = workDir();
    const file = governedFile({ routes: [{ action: GENERIC_ACTION, adapterId: GENERIC_ADAPTER_ID }] });
    const { host, adapter, baseUrl } = await boot(secureEnv(dir, {}, file));
    await provision(provisioningOf(host));
    const reply = await govern(baseUrl, intent(ACTION), bearer(AGENT_KEY));
    assert.notEqual(reply.body['status'], 'executed', reply.text);
    assert.equal(adapter.calls.length, 0);
  });
});

describe('PROD-01 — revocation is visible at the product boundary (CORE-01 through the real Host)', () => {
  it('revoking the delegation in the durable authority world stops the next governed action', async () => {
    const dir = workDir();
    const { host, adapter, baseUrl } = await boot(secureEnv(dir));
    const provisioning = provisioningOf(host);
    await provision(provisioning);
    assert.equal((await govern(baseUrl, intent(), bearer(AGENT_KEY))).body['status'], 'executed');

    await provisioning.revoke(DURABLE_FIXTURE_OPERATOR, { entityKind: 'delegation-grant', entityId: 'delegation-agent', reason: 'offboarded' });
    const after = await govern(baseUrl, intent(), bearer(AGENT_KEY));
    assert.equal(after.body['status'], 'denied', after.text);
    assert.equal(adapter.calls.length, 1, 'no execution after revocation');
  });

  it('a signed bounded-grant revocation erased from the database refuses the restart: the Host never binds', async () => {
    const dir = workDir();
    const env = secureEnv(dir);
    const first = await boot(env);
    await provision(provisioningOf(first.host));
    assert.equal((await govern(first.baseUrl, intent(), bearer(AGENT_KEY))).body['status'], 'executed');
    const [grant] = grantRows(dir);
    assert.ok(grant !== undefined);
    const revoked = await first.host.enterprise.authorityControlledExecution?.revokeGrant({ grantId: grant.grant_id, reason: 'administrator-revoked', issuerRef: 'operator:on-call' });
    assert.equal(revoked?.outcome, 'revoked');
    await first.host.close();

    // A database-only writer erases the revocation: drop the append-only
    // triggers, delete the revocation row and clear the pointer.
    const db = new Database(join(dir, 'bounded-grants.sqlite'));
    dropAuthorityStoreTriggers(db);
    db.prepare('DELETE FROM bounded_grant_revocations WHERE grant_id = ?').run(grant.grant_id);
    db.prepare('UPDATE bounded_grants SET revocation_digest = NULL WHERE grant_id = ?').run(grant.grant_id);
    db.close();

    const error = await refusal(bootEnterpriseHost({ env, executionAdapters: [recordingAdapter()], logger: capturingLogger }));
    assert.ok(error instanceof EnterpriseHostConfigurationError, String(error));
    assert.equal(error.code, 'HOST_NOT_HEALTHY');
    assert.match(error.message, /aoc\.enterprise\.authority-controlled-execution/);
    assertNoSecret(error.message, 'the refusal');
    if (CAN_SEE_HANDLES) assert.deepEqual(handlesUnder(dir), [], 'the refused Host left no store open');
  });

  it('a revocation state tampered while the Host runs makes /ready and /health fail, and nothing executes', async () => {
    const dir = workDir();
    const { host, adapter, baseUrl } = await boot(secureEnv(dir));
    await provision(provisioningOf(host));
    assert.equal((await govern(baseUrl, intent(), bearer(AGENT_KEY))).body['status'], 'executed');
    const [grant] = grantRows(dir);
    assert.ok(grant !== undefined);
    await host.enterprise.authorityControlledExecution?.revokeGrant({ grantId: grant.grant_id, reason: 'administrator-revoked', issuerRef: 'operator:on-call' });

    const db = new Database(join(dir, 'bounded-grants.sqlite'));
    dropAuthorityStoreTriggers(db);
    db.prepare('DELETE FROM bounded_grant_revocations WHERE grant_id = ?').run(grant.grant_id);
    db.prepare('UPDATE bounded_grants SET revocation_digest = NULL WHERE grant_id = ?').run(grant.grant_id);
    db.close();

    const ready = await getJson(baseUrl, '/ready');
    assert.equal(ready.status, 503, ready.text);
    assert.equal(ready.body['ready'], false);
    assert.equal((await getJson(baseUrl, '/health')).status, 503);
    const reply = await govern(baseUrl, intent(), bearer(AGENT_KEY));
    assert.notEqual(reply.body['status'], 'executed', reply.text);
    assert.equal(adapter.calls.length, 1, 'no execution against an unverifiable revocation state');
  });
});

describe('PROD-01 — restart proves durable state, not hidden memory', () => {
  it('authority, grants, decisions and outcomes survive a full stop/start; a replay does not re-execute; new authority-backed work executes', async () => {
    const dir = workDir();
    const env = secureEnv(dir);
    const first = await boot(env);
    await provision(provisioningOf(first.host));
    const original = intent();
    const firstReply = await govern(first.baseUrl, original, bearer(AGENT_KEY));
    assert.equal(firstReply.body['status'], 'executed');
    await first.host.close();
    if (CAN_SEE_HANDLES) assert.deepEqual(handlesUnder(dir), [], 'every store closed on shutdown');

    // A fresh process image: new adapter, no re-provisioning.
    const second = await boot(env);
    const replay = await govern(second.baseUrl, original, bearer(AGENT_KEY));
    assert.equal(replay.body['status'], 'executed', replay.text);
    assert.equal(replay.body['replayed'], true, 'the committed decision and outcome came back from disk');
    assert.equal(replay.body['executionId'], firstReply.body['executionId']);
    assert.equal(second.adapter.calls.length, 0, 'a replay never re-executes');

    const fresh = await govern(second.baseUrl, intent(), bearer(AGENT_KEY));
    assert.equal(fresh.body['status'], 'executed', `the provisioned authority world survived the restart: ${fresh.text}`);
    assert.equal(second.adapter.calls.length, 1);
    assert.equal(grantRows(dir).length, 2, 'both signed grants are on disk');
  });
});

describe('PROD-01 — security-critical misconfiguration refuses to boot, precisely and secret-free', () => {
  const cases: readonly [string, (dir: string) => Record<string, string | undefined>, string][] = [
    ['memory persistence in production', (dir) => secureEnv(dir, { AOC_ENTERPRISE_PERSISTENCE_PROVIDER: 'memory' }), 'HOST_PERSISTENCE_NOT_DURABLE'],
    ['persistence provider left to its default in production', (dir) => secureEnv(dir, { AOC_ENTERPRISE_PERSISTENCE_PROVIDER: undefined }), 'HOST_PERSISTENCE_NOT_DURABLE'],
    ['a mistyped persistence provider (silent memory fallback)', (dir) => secureEnv(dir, { AOC_ENTERPRISE_PERSISTENCE_PROVIDER: 'sqllite' }), 'HOST_ENVIRONMENT_INVALID'],
    ['a mistyped environment (silent development fallback)', (dir) => secureEnv(dir, { AOC_ENTERPRISE_ENV: 'prod' }), 'HOST_ENVIRONMENT_INVALID'],
    ['authentication not required in production', (dir) => secureEnv(dir, { AOC_ENTERPRISE_REQUIRE_AUTH: 'false' }), 'HOST_AUTHENTICATION_REQUIRED'],
    ['authentication unstated in production', (dir) => secureEnv(dir, { AOC_ENTERPRISE_REQUIRE_AUTH: undefined }), 'HOST_AUTHENTICATION_REQUIRED'],
    ['an unparseable authentication flag', (dir) => secureEnv(dir, { AOC_ENTERPRISE_REQUIRE_AUTH: 'yes' }), 'HOST_ENVIRONMENT_INVALID'],
    ['no governed-action file in production', (dir) => secureEnv(dir, { AOC_ENTERPRISE_GOVERNED_ACTIONS_FILE: undefined }), 'HOST_GOVERNED_ACTIONS_REQUIRED'],
    ['no authority signing key in durable mode', (dir) => secureEnv(dir, { AOC_ENTERPRISE_AUTHORITY_SIGNING_KEY_PEM: undefined }), 'HOST_AUTHORITY_SIGNING_KEY_REQUIRED'],
    ['malformed verification keys', (dir) => secureEnv(dir, { AOC_ENTERPRISE_AUTHORITY_VERIFICATION_KEYS: '[{"keyId":' }), 'HOST_ENVIRONMENT_INVALID'],
    ['Kernel Authority disabled with governed actions', (dir) => secureEnv(dir, { AOC_ENTERPRISE_KERNEL_AUTHORITY_ENABLED: 'false' }), 'HOST_KERNEL_AUTHORITY_REQUIRED'],
    ['Kernel Authority optional in production', (dir) => secureEnv(dir, { AOC_ENTERPRISE_KERNEL_AUTHORITY_REQUIRED: 'false' }), 'HOST_KERNEL_AUTHORITY_REQUIRED'],
    ['a customer key variable that is not set', (dir) => secureEnv(dir, { FRONTERA_TEST_AGENT_KEY: undefined }), 'HOST_SECRET_REFERENCE_UNRESOLVED'],
    ['a provider credential variable that is empty', (dir) => secureEnv(dir, { FRONTERA_TEST_ERP_TOKEN: '' }), 'HOST_SECRET_REFERENCE_UNRESOLVED'],
    ['a customer key reused as a legacy key', (dir) => secureEnv(dir, { AOC_ENTERPRISE_API_KEYS: `${AGENT_KEY}:${ORG}` }), 'HOST_CREDENTIALS_AMBIGUOUS'],
    ['an unreadable governed-action file', (dir) => secureEnv(dir, { AOC_ENTERPRISE_GOVERNED_ACTIONS_FILE: join(dir, 'missing.json') }), 'HOST_GOVERNED_ACTIONS_FILE_UNREADABLE'],
    ['a route to an unconfigured adapter', (dir) => secureEnv(dir, {}, governedFile({ routes: [{ action: ACTION, adapterId: 'nowhere' }] })), 'HOST_EXECUTION_ROUTE_INVALID'],
    ['no routes at all', (dir) => secureEnv(dir, {}, governedFile({ routes: [] })), 'HOST_EXECUTION_ROUTE_INVALID'],
    ['an inline provider secret in the file', (dir) => secureEnv(dir, {}, governedFile({ genericHttpAdapters: [{ ...(governedFile()['genericHttpAdapters'] as object[])[0], credential: { kind: 'bearer', token: ERP_TOKEN } }] })), 'HOST_GOVERNED_ACTIONS_FILE_INVALID'],
    ['an unknown field in the file', (dir) => secureEnv(dir, {}, governedFile({ allowPrivateNetwork: true })), 'HOST_GOVERNED_ACTIONS_FILE_INVALID'],
    ['a grant lifetime above one hour', (dir) => secureEnv(dir, {}, governedFile({ grantLifetimeSeconds: 7200 })), 'HOST_GOVERNED_ACTIONS_FILE_INVALID'],
    ['a malformed log level', (dir) => secureEnv(dir, { AOC_ENTERPRISE_LOG_LEVEL: 'verbose' }), 'HOST_ENVIRONMENT_INVALID'],
    ...['99999', '65536', '-1', 'abc', ' 8787', '8787 ', '80.5', ''].map(
      (port): [string, (dir: string) => Record<string, string | undefined>, string] => [`an invalid port '${port}'`, (dir) => secureEnv(dir, { AOC_ENTERPRISE_HTTP_PORT: port }), 'HOST_ENVIRONMENT_INVALID'],
    ),
    ['the pre-PROD-01 combination: production, SQLite, authentication off, network bind', (dir) => secureEnv(dir, { AOC_ENTERPRISE_REQUIRE_AUTH: 'false', AOC_ENTERPRISE_HTTP_HOST: '0.0.0.0' }), 'HOST_UNAUTHENTICATED_NETWORK_BIND'],
    ['production on an IPv6 wildcard bind without authentication', (dir) => secureEnv(dir, { AOC_ENTERPRISE_REQUIRE_AUTH: 'false', AOC_ENTERPRISE_HTTP_HOST: '::' }), 'HOST_UNAUTHENTICATED_NETWORK_BIND'],
    ['a network bind without authentication (development)', () => ({ AOC_ENTERPRISE_HTTP_HOST: '0.0.0.0' }), 'HOST_UNAUTHENTICATED_NETWORK_BIND'],
    ['required authentication with no credential (development)', () => ({ AOC_ENTERPRISE_REQUIRE_AUTH: 'true' }), 'HOST_CREDENTIALS_MISSING'],
  ];

  for (const [label, envOf, code] of cases) {
    it(`${label} → ${code}; nothing is opened and nothing listens`, async () => {
      const dir = workDir();
      const env = envOf(dir);
      const error = await refusal(bootEnterpriseHost({ env, executionAdapters: [recordingAdapter()] }));
      assert.ok(error instanceof EnterpriseHostConfigurationError, `${label}: ${String(error)}`);
      assert.equal(error.code, code, error.message);
      assertNoSecret(error.message, 'a configuration refusal');
      assert.deepEqual(readdirSync(dir).filter((name) => name.endsWith('.sqlite')), [], 'refused before any store was opened');
    });
  }

  it('a signing key absent from the trusted set is refused by composition before any store is opened', async () => {
    const dir = workDir();
    const env = secureEnv(dir, { AOC_ENTERPRISE_AUTHORITY_VERIFICATION_KEYS: JSON.stringify([trustedKeyOf(AUTHORITY_KEY_UNTRUSTED)]) });
    const error = await refusal(bootEnterpriseHost({ env, executionAdapters: [recordingAdapter()] }));
    assert.ok(error instanceof AuthorityAuthenticityConfigurationError, String(error));
    assertNoSecret(error.message, 'an authenticity refusal');
    assert.deepEqual(readdirSync(dir).filter((name) => name.endsWith('.sqlite')), [], 'the key boundary is checked before any SQLite file exists');
  });

  it('an unusable Generic HTTP configuration (plain http origin) is refused before any store is opened', async () => {
    const dir = workDir();
    const adapters = governedFile()['genericHttpAdapters'] as Record<string, unknown>[];
    const env = secureEnv(dir, {}, governedFile({ genericHttpAdapters: [{ ...adapters[0], origin: 'http://erp.example.com' }] }));
    const error = await refusal(bootEnterpriseHost({ env, executionAdapters: [recordingAdapter()] }));
    assert.ok(error instanceof GenericHttpConfigurationError, String(error));
    assertNoSecret(error.message, 'a Generic HTTP refusal');
    assert.deepEqual(readdirSync(dir).filter((name) => name.endsWith('.sqlite')), []);
  });

  it('ATOMIC STARTUP: a store failing mid-composition closes every store already opened', { skip: !CAN_SEE_HANDLES && 'needs /proc/self/fd' }, async () => {
    const dir = workDir();
    // A directory where the outcome store's file should be: it cannot open,
    // after the Governance, Passport, Assurance, Kernel Authority and grant stores have.
    const blocked = join(dir, 'execution-outcomes.sqlite');
    mkdirSync(blocked);
    const error = await refusal(bootEnterpriseHost({ env: secureEnv(dir), executionAdapters: [recordingAdapter()] }));
    assert.ok(!(error instanceof EnterpriseHostConfigurationError), 'the root error surfaces unchanged');
    assert.equal(existsSync(join(dir, 'bounded-grants.sqlite')), true, 'the grant store had been opened before the failure');
    assert.deepEqual(handlesUnder(dir), [], 'and was closed again, with every other store');
  });
});

describe('PROD-01 — development mode is explicit and visibly not production', () => {
  it('zero configuration boots development, ephemeral, unauthenticated, loopback-only — and says so', async () => {
    const host = await bootEnterpriseHost({ env: { AOC_ENTERPRISE_HTTP_PORT: '0', AOC_ENTERPRISE_LOG_LEVEL: 'error' } });
    hosts.push(host);
    const { host: address } = await host.listen();
    assert.equal(address, '127.0.0.1', 'the default bind is loopback');
    assert.equal(host.posture.environment, 'development');
    assert.equal(host.posture.persistence, 'ephemeral');
    assert.equal(host.posture.authentication, 'disabled');
    assert.equal(host.posture.governedActions, 'not-composed');
    await host.close();
  });

  it('development may compose governed actions over memory, and health reports the store as unauthenticated', async () => {
    const dir = workDir();
    const env = secureEnv(dir, { AOC_ENTERPRISE_ENV: 'development', AOC_ENTERPRISE_PERSISTENCE_PROVIDER: 'memory' });
    const { host, adapter, baseUrl } = await boot(env);
    assert.equal(host.posture.persistence, 'ephemeral');
    assert.equal(host.posture.authorityStore, 'unauthenticated');
    assert.equal(host.posture.governedActions, 'composed');
    await provision(provisioningOf(host));
    assert.equal((await govern(baseUrl, intent(), bearer(AGENT_KEY))).body['status'], 'executed');
    assert.equal(adapter.calls.length, 1);
    // Memory mode keeps no authority on disk. The P7 exercise ledger is the one
    // exception, by existing design: consumption forgotten on restart fails open.
    assert.deepEqual(readdirSync(dir).filter((name) => name.endsWith('.sqlite')), ['exercise-ledger.sqlite']);
  });
});

describe('PROD-01 — shutdown', () => {
  it('stops accepting, closes the listener and every store, and is idempotent', async () => {
    const dir = workDir();
    const { host, baseUrl } = await boot(secureEnv(dir));
    await host.close();
    await host.close();
    assert.equal(host.server.server.listening, false);
    await assert.rejects(fetch(`${baseUrl}/live`), 'no new work is accepted');
    assert.equal(host.enterprise.isLive(), false);
    if (CAN_SEE_HANDLES) assert.deepEqual(handlesUnder(dir), [], 'no store handle outlives close');
  });

  it('closing a Host that never listened still closes its stores', async () => {
    const dir = workDir();
    const host = await bootEnterpriseHost({ env: secureEnv(dir), executionAdapters: [recordingAdapter()] });
    await host.close();
    assert.equal(host.enterprise.isLive(), false);
    if (CAN_SEE_HANDLES) assert.deepEqual(handlesUnder(dir), []);
  });
});
