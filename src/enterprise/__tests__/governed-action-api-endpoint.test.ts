import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  EMERGENCY_CONTROL_REASON_CODES,
  createInMemoryEmergencyControlStore,
  type EmergencyControlStorePort,
} from '../../features/emergency-control-runtime/index.js';
import { createRecordingExecutionAdapter, type RecordingExecutionAdapter } from '../../features/execution-runtime/tests/execution-fixture.js';
import type { ExecutionAdapterResult, ValidatedExecutionAction } from '../../features/execution-runtime/index.js';
import { createInMemoryBoundedGrantStore, type BoundedGrantStorePort } from '../../features/grant-runtime/index.js';
import { KernelGrantCapability } from '../../kernel/orchestration/grant-adapter.js';
import { createEnterpriseRequestListener } from '../adapters/node-http-adapter.js';
import { createEnterprise, type AocEnterprise, type CreateEnterpriseOptions } from '../composition/composition-root.js';
import { loadEnterpriseConfiguration, type EnterpriseApiKey, type EnterpriseConfiguration } from '../configuration/enterprise-configuration.js';
import { createCustomerIdentityAdmission, createKernelAuthoritySubjectBindingReader } from '../customer-identity/index.js';
import { GOVERNED_ACTION_REASON_CODES, GovernedActionConfigurationError, type GovernedActionResult } from '../governed-action/index.js';
import type { GovernanceStore } from '../governance-store/governance-store.js';
import { createInMemoryGovernanceStore } from '../governance-store/in-memory-governance-store.js';
import { createEnterpriseServer, type EnterpriseServer } from '../host/enterprise-server.js';
import { createInMemoryKernelAuthorityStore } from '../kernel-authority/in-memory-kernel-authority-store.js';
import type { KernelAuthorityStore } from '../kernel-authority/kernel-authority-store.js';
import { createKernelAuthorityProvisioningService } from '../kernel-authority/provisioning-service.js';
import { governGovernedActionRequest } from '../orchestration/govern-governed-action-request.js';
import type { EnterpriseLogContext, EnterpriseLogger } from '../telemetry/enterprise-logger.js';
import {
  ALLOWED_INTENT,
  APPROVAL_INTENT,
  DENIED_ACTOR,
  DENIED_INTENT,
  EVALUATED_AT_POLICY,
  NO_TEMPORAL_BOUND,
  ORG,
  PMFREAK_ACTOR_ID,
  TRUST_DOMAIN_ID,
  buildGovernedWorld,
} from './governed-action-support.js';
import { buildAllowedRequestBody, buildTestKernelProviders } from './support.js';

/**
 * `POST /api/governed-actions`, end to end over real HTTP against the REAL
 * Enterprise Host composition: customer identity admission (P2) → Governed
 * Action Orchestrator (P3) → trusted adapter routing and emergency control
 * (P4). Nothing below the router is faked: the Kernel is the real `AocKernel`
 * over the Datasys fixture, the Governance, bounded-grant, Kernel Authority and
 * emergency-control stores are real, and the providers are recording adapters
 * behind the real registry. The only instrumentation is counting — and, where
 * a row names it, a failure injected into a store or port the Host already
 * accepts from its composer.
 */

const SUBJECT = { system: 'datasys-app', subjectId: 'user-pmfreak' } as const;
const SECRET = 'AOC_GOVERNED_ACTION_API_SECRET_SENTINEL_DO_NOT_USE';
const SECRET_SAME_ACTOR_OTHER_PRINCIPAL = 'AOC_GOVERNED_ACTION_API_SECOND_PRINCIPAL_SENTINEL';
const SECRET_DENIED = 'AOC_GOVERNED_ACTION_API_DENIED_ACTOR_SENTINEL';
const SECRET_UNBOUND = 'AOC_GOVERNED_ACTION_API_UNBOUND_SENTINEL';
const SECRET_REVOKED = 'AOC_GOVERNED_ACTION_API_REVOKED_SENTINEL';
const SECRET_LEGACY = 'AOC_GOVERNED_ACTION_API_LEGACY_KEY_SENTINEL';
const SECRET_UNSCOPED = 'AOC_GOVERNED_ACTION_API_UNSCOPED_KEY_SENTINEL';
const ALL_SECRETS = [SECRET, SECRET_SAME_ACTOR_OTHER_PRINCIPAL, SECRET_DENIED, SECRET_UNBOUND, SECRET_REVOKED, SECRET_LEGACY, SECRET_UNSCOPED];

const KEYS: readonly EnterpriseApiKey[] = [
  { key: SECRET, organizationId: ORG, customerIdentity: { principalId: 'principal-pmfreak', externalSubject: SUBJECT } },
  // A second principal whose external subject is bound to the same actor: same actor, different idempotency scope.
  { key: SECRET_SAME_ACTOR_OTHER_PRINCIPAL, organizationId: ORG, customerIdentity: { principalId: 'principal-pmfreak-ops', externalSubject: SUBJECT } },
  { key: SECRET_DENIED, organizationId: ORG, customerIdentity: { principalId: 'principal-unknown', externalSubject: { system: 'datasys-app', subjectId: 'user-unknown-agent' } } },
  { key: SECRET_UNBOUND, organizationId: ORG, customerIdentity: { principalId: 'principal-nobody', externalSubject: { system: 'datasys-app', subjectId: 'user-nobody' } } },
  { key: SECRET_REVOKED, organizationId: ORG, customerIdentity: { principalId: 'principal-revoked', externalSubject: { system: 'datasys-app', subjectId: 'user-revoked' } } },
  // Legacy keys: valid for the legacy routes, never a customer principal.
  { key: SECRET_LEGACY, organizationId: ORG },
  { key: SECRET_UNSCOPED },
];

const OPERATOR = { system: true, actorId: 'operator-1' } as const;
const ISSUER = 'operator:on-call';
const AT = '2026-01-01T00:00:00.000Z';
const ROUTE = '/api/governed-actions';

function configuration(): EnterpriseConfiguration {
  const base = loadEnterpriseConfiguration({
    AOC_ENTERPRISE_PERSISTENCE_PROVIDER: 'memory',
    AOC_ENTERPRISE_KERNEL_AUTHORITY_ORGANIZATION_ID: ORG,
    AOC_ENTERPRISE_HTTP_PORT: '0',
    AOC_ENTERPRISE_HTTP_HOST: '127.0.0.1',
    // Deliberately OFF: the legacy flag must not open the customer route.
    AOC_ENTERPRISE_REQUIRE_AUTH: 'false',
    AOC_ENTERPRISE_LOG_LEVEL: 'error',
  });
  return { ...base, authentication: { apiKeys: KEYS } };
}

// ---------------------------------------------------------------------------
// The instrumented, fully composed Host (P2 + P3 + P4).

interface Knobs {
  recognitionThrows: boolean;
  bindingLookupThrows: boolean;
  grantTermsUnavailable: boolean;
  authorityBindingUnresolved: boolean;
  issuedGrantsVanish: boolean;
  outcomeReferenceFails: boolean;
  controlUnreadable: boolean;
  adapter: 'completed' | 'rejected' | 'throws';
}

const DEFAULT_KNOBS: Knobs = {
  recognitionThrows: false,
  bindingLookupThrows: false,
  grantTermsUnavailable: false,
  authorityBindingUnresolved: false,
  issuedGrantsVanish: false,
  outcomeReferenceFails: false,
  controlUnreadable: false,
  adapter: 'completed',
};

const knobs: Knobs = { ...DEFAULT_KNOBS };
const counts = { recognition: 0, appendEvaluation: 0 };
const logLines: string[] = [];

function namedAdapter(adapterId: string): RecordingExecutionAdapter {
  const inner = createRecordingExecutionAdapter(async (): Promise<ExecutionAdapterResult> => {
    if (knobs.adapter === 'throws') throw new Error('provider socket reset');
    if (knobs.adapter === 'rejected') return { outcome: 'failed', reason: 'PROVIDER_REJECTED' };
    return { outcome: 'completed', providerRef: 'provider-ref-1' };
  });
  return {
    adapterId,
    calls: inner.calls,
    get callCount(): number {
      return inner.callCount;
    },
    execute: (action: ValidatedExecutionAction) => inner.execute(action),
  };
}

const adapterA = namedAdapter('adapter-a');
const adapterB = namedAdapter('adapter-b');
const providerCalls = (): number => adapterA.callCount + adapterB.callCount;

const capturingLogger: EnterpriseLogger = {
  debug: (message, fields) => logLines.push(JSON.stringify({ message, fields })),
  info: (message, fields) => logLines.push(JSON.stringify({ message, fields })),
  warn: (message, fields) => logLines.push(JSON.stringify({ message, fields })),
  error: (message, fields) => logLines.push(JSON.stringify({ message, fields })),
};

function countingProviders(): ReturnType<typeof buildTestKernelProviders> {
  const providers = buildTestKernelProviders();
  const recognition = providers.recognitionProvider;
  const recognitionProvider = new Proxy(recognition, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        counts.recognition += 1;
        if (knobs.recognitionThrows) throw new Error('recognition provider unreachable');
        return (value as (...inner: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return { ...providers, recognitionProvider };
}

function instrumentedGovernanceStore(): GovernanceStore {
  const raw = createInMemoryGovernanceStore();
  return new Proxy(raw, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof value !== 'function') return value;
      if (property === 'appendEvaluation') {
        return (...args: unknown[]) => {
          counts.appendEvaluation += 1;
          return (value as (...inner: unknown[]) => unknown).apply(target, args);
        };
      }
      if (property === 'appendReference') {
        return async (...args: unknown[]) => {
          const reference = args[1] as { referenceType: string; externalVersion?: string };
          if (knobs.outcomeReferenceFails && reference.referenceType === 'execution_record' && reference.externalVersion !== 'attempt') {
            throw new Error('injected outcome reference failure');
          }
          return (value as (...inner: unknown[]) => Promise<unknown>).apply(target, args);
        };
      }
      return (value as (...inner: unknown[]) => unknown).bind(target);
    },
  });
}

function instrumentedGrantStore(): BoundedGrantStorePort {
  const raw = createInMemoryBoundedGrantStore();
  return {
    issue: (input) => raw.issue(input),
    // A grant lost between issuance and exercise (e.g. an in-memory store
    // restarted) reads as not found: the closed direction.
    read: async (grantId) => (knobs.issuedGrantsVanish ? {} : raw.read(grantId)),
    revoke: (input) => raw.revoke(input),
  };
}

const controls = createInMemoryEmergencyControlStore();
const controlStore: EmergencyControlStorePort = {
  read(query) {
    if (knobs.controlUnreadable) throw new Error('control plane unreachable');
    return controls.read(query);
  },
  activate: (declaration) => controls.activate(declaration),
  release: (release) => controls.release(release),
  active: () => controls.active(),
};

async function provisionedAuthorityStore(): Promise<KernelAuthorityStore> {
  const store = createInMemoryKernelAuthorityStore();
  const provisioning = createKernelAuthorityProvisioningService({ store, organizationId: ORG });
  await provisioning.provisionActor(OPERATOR, { actorId: PMFREAK_ACTOR_ID, type: 'agent', displayName: 'PMFreak', externalSubject: SUBJECT });
  // Bound in the authority store, unknown to the Kernel's recognition world: admitted, then denied.
  await provisioning.provisionActor(OPERATOR, { actorId: DENIED_ACTOR, type: 'agent', displayName: 'Unknown', externalSubject: { system: 'datasys-app', subjectId: 'user-unknown-agent' } });
  await provisioning.provisionActor(OPERATOR, { actorId: 'actor-revoked', type: 'agent', displayName: 'Offboarded', externalSubject: { system: 'datasys-app', subjectId: 'user-revoked' } });
  await provisioning.revoke(OPERATOR, { entityKind: 'actor', entityId: 'actor-revoked', reason: 'offboarded' });
  return new Proxy(store, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof value !== 'function') return value;
      if (property === 'findActorByExternalSubject') {
        return async (...args: unknown[]) => {
          if (knobs.bindingLookupThrows) throw new Error('authority store unreachable');
          return (value as (...inner: unknown[]) => Promise<unknown>).apply(target, args);
        };
      }
      return (value as (...inner: unknown[]) => unknown).bind(target);
    },
  });
}

async function fullOptions(): Promise<CreateEnterpriseOptions> {
  return {
    configuration: configuration(),
    kernelProviders: countingProviders(),
    kernelAuthorityStore: await provisionedAuthorityStore(),
    persistence: instrumentedGovernanceStore(),
    logger: capturingLogger,
    customerIdentityAdmission: { enabled: true },
    authorityControlledExecution: {
      grantCapability: new KernelGrantCapability({ declaration: {} }),
      grantStore: instrumentedGrantStore(),
      executionAdapterRouting: { adapters: [adapterA, adapterB], selectAdapter: () => 'adapter-a' },
      resolveAuthorityBinding: () => (knobs.authorityBindingUnresolved ? undefined : NO_TEMPORAL_BOUND),
    },
    governedActionOrchestrator: {
      enabled: true,
      trustDomainId: TRUST_DOMAIN_ID,
      grantPolicy: (query) => (knobs.grantTermsUnavailable ? undefined : EVALUATED_AT_POLICY(query)),
    },
    emergencyControl: { enabled: true, store: controlStore },
  };
}

// ---------------------------------------------------------------------------

const servers: EnterpriseServer[] = [];
const rawServers: Server[] = [];
after(async () => {
  await Promise.all(servers.map((server) => server.close().catch(() => {})));
  await Promise.all(rawServers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function start(options: CreateEnterpriseOptions): Promise<{ server: EnterpriseServer; baseUrl: string }> {
  const server = await createEnterpriseServer(options);
  servers.push(server);
  const { port } = await server.listen();
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

interface HttpReply {
  readonly status: number;
  readonly text: string;
  readonly body: Record<string, unknown>;
}

async function send(baseUrl: string, body: unknown, options: { readonly authorization?: string; readonly method?: string; readonly headers?: Record<string, string>; readonly raw?: string } = {}): Promise<HttpReply> {
  const method = options.method ?? 'POST';
  const response = await fetch(`${baseUrl}${ROUTE}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(options.authorization !== undefined ? { authorization: options.authorization } : {}),
      ...options.headers,
    },
    ...(method === 'POST' ? { body: options.raw ?? JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  return { status: response.status, text, body: JSON.parse(text) as Record<string, unknown> };
}

let keySequence = 0;
const freshKey = (label: string): string => `http-${label}-${(keySequence += 1)}`;
const allowed = (label: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ ...ALLOWED_INTENT, idempotencyKey: freshKey(label), ...extra });
const bearer = (secret: string): string => `Bearer ${secret}`;

/** Every key anywhere in a JSON value — the leak check walks structure, not just text. */
function keysOf(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) value.forEach((item) => keysOf(item, into));
  else if (value !== null && typeof value === 'object') {
    for (const [key, inner] of Object.entries(value)) {
      into.add(key);
      keysOf(inner, into);
    }
  }
  return into;
}

const FORBIDDEN_RESPONSE_KEYS = [
  'grant',
  'grantId',
  'boundedGrantId',
  'grantDigest',
  'digest',
  'grantExpiresAt',
  'scope',
  'authorityBinding',
  'adapterId',
  'adapter',
  'provider',
  'credential',
  'credentials',
  'apiKey',
  'privateKey',
  'signer',
  'system',
  'principal',
  'identity',
];

function assertNoAuthorityArtifact(reply: HttpReply): void {
  const keys = keysOf(reply.body);
  for (const key of FORBIDDEN_RESPONSE_KEYS) assert.equal(keys.has(key), false, `response must not carry '${key}': ${reply.text}`);
  for (const secret of ALL_SECRETS) assert.equal(reply.text.includes(secret), false, 'no credential may appear in a response');
  assert.equal(/adapter-[ab]/.test(reply.text), false, 'the routed adapter identity is server-side only');
}

/** A domain result, never an Enterprise error envelope. */
function assertDomainBody(reply: HttpReply, status: string): GovernedActionResult {
  assert.equal(reply.body['error'], undefined, `a governed outcome is a result body, not an error envelope: ${reply.text}`);
  assert.equal(reply.body['status'], status, reply.text);
  assert.ok(Array.isArray(reply.body['reasonCodes']), reply.text);
  assertNoAuthorityArtifact(reply);
  return reply.body as unknown as GovernedActionResult;
}

/** The Enterprise Host error envelope, never a result. */
function assertEnvelope(reply: HttpReply, httpStatus: number, code: string): void {
  assert.equal(reply.status, httpStatus, reply.text);
  const error = reply.body['error'] as { code?: string; message?: string } | undefined;
  assert.ok(error !== undefined, `expected an error envelope: ${reply.text}`);
  assert.equal(error.code, code);
  assert.equal(reply.body['status'], undefined, 'an envelope is never a governed result');
  for (const secret of ALL_SECRETS) assert.equal(reply.text.includes(secret), false, 'no credential may appear in an error');
}

// ---------------------------------------------------------------------------

describe('POST /api/governed-actions — mounting is capability-gated', () => {
  it('1. the default Enterprise Host does not mount it: 404 NOT_FOUND, the unmounted-route envelope', async () => {
    const { baseUrl } = await start({ configuration: configuration(), kernelProviders: buildTestKernelProviders() });
    const reply = await send(baseUrl, allowed('default'), { authorization: bearer(SECRET) });
    assertEnvelope(reply, 404, 'NOT_FOUND');
    assert.match(String((reply.body['error'] as { message: string }).message), /^No route for POST \/api\/governed-actions/);
  });

  it('2. customer identity admission alone does not mount it', async () => {
    const { server, baseUrl } = await start({
      configuration: configuration(),
      kernelProviders: buildTestKernelProviders(),
      kernelAuthorityStore: await provisionedAuthorityStore(),
      customerIdentityAdmission: { enabled: true },
    });
    assert.ok(server.enterprise.customerIdentityAdmission !== undefined);
    assert.equal(server.enterprise.governedActionOrchestrator, undefined);
    assert.equal(server.enterprise.governAction, undefined, 'no weaker application call exists');
    const reply = await send(baseUrl, allowed('identity-only'), { authorization: bearer(SECRET) });
    assertEnvelope(reply, 404, 'NOT_FOUND');
  });

  it('3. the orchestrator cannot be composed without customer identity or execution — so it can never mount the route alone', async () => {
    const { customerIdentityAdmission: _identity, ...withoutIdentity } = await fullOptions();
    await assert.rejects(createEnterprise(withoutIdentity), (error: unknown) => error instanceof GovernedActionConfigurationError && error.code === 'GOVERNED_ACTION_CUSTOMER_IDENTITY_REQUIRED');
    const { authorityControlledExecution: _execution, emergencyControl: _control, ...withoutExecution } = await fullOptions();
    await assert.rejects(createEnterprise(withoutExecution), (error: unknown) => error instanceof GovernedActionConfigurationError && error.code === 'GOVERNED_ACTION_EXECUTION_REQUIRED');
  });

  it('3b. the listener requires BOTH capabilities, not merely the application call', async () => {
    // An embedder that hands the listener an object with a `governAction` but
    // without both composed capabilities gets the unmounted route, not a
    // fallback. Real HTTP listener, no orchestrator anywhere.
    let invoked = 0;
    const partial = {
      logger: capturingLogger,
      governAction: async () => {
        invoked += 1;
        throw new Error('must not be reached');
      },
    } as unknown as AocEnterprise;
    const server = createServer(createEnterpriseRequestListener(partial));
    rawServers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const reply = await send(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, allowed('partial'), { authorization: bearer(SECRET) });
    assertEnvelope(reply, 404, 'NOT_FOUND');
    assert.equal(invoked, 0);
  });

  it('4. the full P2 + P3 + P4 composition mounts it', async () => {
    const { server, baseUrl } = await start(await fullOptions());
    assert.ok(server.enterprise.customerIdentityAdmission !== undefined);
    assert.ok(server.enterprise.governedActionOrchestrator !== undefined);
    assert.equal(typeof server.enterprise.governAction, 'function');
    const reply = await send(baseUrl, allowed('mounted'), { authorization: bearer(SECRET) });
    assert.equal(reply.status, 200, reply.text);
    assertDomainBody(reply, 'executed');
  });
});

describe('POST /api/governed-actions — the fully composed Host', () => {
  let host: { server: EnterpriseServer; baseUrl: string };
  let baseUrl: string;

  before(async () => {
    host = await start(await fullOptions());
    baseUrl = host.baseUrl;
  });

  beforeEach(() => {
    Object.assign(knobs, DEFAULT_KNOBS);
    for (const control of controls.active()) {
      controls.release({ scope: control.scope, ...(control.value !== undefined ? { value: control.value } : {}), issuerRef: ISSUER, releasedAt: AT } as never);
    }
  });

  /** Runs `act` and returns how many Kernel evaluations, commits and provider calls it caused. */
  async function measure<T>(act: () => Promise<T>): Promise<{ readonly value: T; readonly kernel: number; readonly commits: number; readonly provider: number }> {
    const before = { kernel: counts.recognition, commits: counts.appendEvaluation, provider: providerCalls() };
    const value = await act();
    return { value, kernel: counts.recognition - before.kernel, commits: counts.appendEvaluation - before.commits, provider: providerCalls() - before.provider };
  }

  describe('authentication — always customer-plane admission, whatever AOC_ENTERPRISE_REQUIRE_AUTH says', () => {
    it('the legacy flag is off on this Host, and the legacy route stays open while this one stays closed', async () => {
      assert.equal(host.server.enterprise.configuration.features.requireAuthentication, false);
      const legacy = await fetch(`${baseUrl}/api/governance/evaluate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(buildAllowedRequestBody({ organization: { id: ORG } })),
      });
      assert.equal(legacy.status, 200, 'the legacy evaluate route keeps its own v1 authentication behaviour');
      assertEnvelope(await send(baseUrl, allowed('flag-off')), 401, 'AUTHENTICATION_FAILED');
    });

    const rows: readonly { readonly name: string; readonly authorization?: string; readonly status: number; readonly code: string; readonly reason: string }[] = [
      { name: '5. missing Authorization', status: 401, code: 'AUTHENTICATION_FAILED', reason: 'CUSTOMER_AUTH_REQUIRED' },
      { name: '6. malformed Authorization', authorization: `Basic ${SECRET}`, status: 401, code: 'AUTHENTICATION_FAILED', reason: 'CUSTOMER_AUTH_MALFORMED' },
      { name: '7. unknown credential', authorization: bearer('not-a-configured-key'), status: 401, code: 'AUTHENTICATION_FAILED', reason: 'CUSTOMER_AUTH_INVALID' },
      { name: '8. legacy key without customerIdentity', authorization: bearer(SECRET_LEGACY), status: 403, code: 'AUTHORIZATION_FAILED', reason: 'CUSTOMER_IDENTITY_NOT_CONFIGURED' },
      { name: '8b. legacy unscoped key', authorization: bearer(SECRET_UNSCOPED), status: 403, code: 'AUTHORIZATION_FAILED', reason: 'CUSTOMER_AUTH_UNSCOPED' },
      { name: '9. unbound subject', authorization: bearer(SECRET_UNBOUND), status: 403, code: 'AUTHORIZATION_FAILED', reason: 'CUSTOMER_SUBJECT_UNBOUND' },
      { name: '10. revoked binding', authorization: bearer(SECRET_REVOKED), status: 403, code: 'AUTHORIZATION_FAILED', reason: 'CUSTOMER_SUBJECT_ACTOR_REVOKED' },
    ];
    for (const row of rows) {
      it(`${row.name} → ${row.status} ${row.code}; nothing reaches the Kernel, the Store or a provider`, async () => {
        logLines.length = 0;
        const measured = await measure(() => send(baseUrl, allowed('auth'), row.authorization !== undefined ? { authorization: row.authorization } : {}));
        assertEnvelope(measured.value, row.status, row.code);
        assert.equal(measured.kernel, 0, 'no Kernel evaluation');
        assert.equal(measured.commits, 0, 'no Governance Record');
        assert.equal(measured.provider, 0, 'no provider call');
        // The stable reason code is logged server-side, never returned, and no credential is logged.
        assert.equal(measured.value.text.includes(row.reason), false, 'the CUSTOMER_* reason stays server-side');
        assert.ok(logLines.some((line) => line.includes(row.reason)), `expected ${row.reason} in the server log`);
        for (const secret of ALL_SECRETS) assert.equal(logLines.join('\n').includes(secret), false, 'no credential may be logged');
      });
    }

    it('11. binding reader unavailable → 503 INFRASTRUCTURE_FAILURE; nothing evaluated, no provider', async () => {
      knobs.bindingLookupThrows = true;
      const measured = await measure(() => send(baseUrl, allowed('lookup'), { authorization: bearer(SECRET) }));
      assertEnvelope(measured.value, 503, 'INFRASTRUCTURE_FAILURE');
      assert.equal(measured.kernel, 0);
      assert.equal(measured.commits, 0);
      assert.equal(measured.provider, 0);
    });

    it('a request carrying identity headers or body fields still admits only the credential’s actor', async () => {
      const reply = await send(baseUrl, allowed('headers'), { authorization: bearer(SECRET), headers: { 'x-actor-id': DENIED_ACTOR, 'x-organization-id': 'org-other' } });
      assert.equal(reply.status, 200, reply.text);
    });
  });

  describe('identity — actor, organization and system context never come from the request', () => {
    for (const [name, extra] of [
      ['12. actorId', { actorId: DENIED_ACTOR }],
      ['13. organizationId', { organizationId: 'org-other' }],
      ['14. system: true', { system: true }],
      ['principalId', { principalId: 'principal-other' }],
      ['externalSubject', { externalSubject: { system: 'x', subjectId: 'y' } }],
      ['trustDomainId', { trustDomainId: 'td-other' }],
    ] as const) {
      it(`${name} in the body → 400 rejected / GOVERNED_ACTION_INTENT_INVALID; no Kernel, no provider`, async () => {
        const measured = await measure(() => send(baseUrl, allowed('identity', extra as Record<string, unknown>), { authorization: bearer(SECRET) }));
        assert.equal(measured.value.status, 400, measured.value.text);
        const body = assertDomainBody(measured.value, 'rejected');
        assert.deepEqual([...body.reasonCodes], [GOVERNED_ACTION_REASON_CODES.GOVERNED_ACTION_INTENT_INVALID]);
        assert.equal(measured.kernel, 0);
        assert.equal(measured.commits, 0);
        assert.equal(measured.provider, 0);
      });
    }

    it('15. the persisted Kernel request names the admitted actor and organization — only those', async () => {
      const reply = await send(baseUrl, allowed('persisted'), { authorization: bearer(SECRET) });
      const body = assertDomainBody(reply, 'executed');
      const record = await host.server.enterprise.persistence.getByRequestId({ system: true }, body.requestId ?? '');
      assert.ok(record !== null);
      assert.equal(record.request.actorId, PMFREAK_ACTOR_ID);
      assert.equal(record.request.organizationId, ORG);
      const payload = JSON.stringify(record.request.requestPayload);
      assert.equal(payload.includes(DENIED_ACTOR), false);
      assert.equal(payload.includes('principal-pmfreak'), false, 'the principal is not the actor and is not recorded as one');
    });
  });

  describe('intent — the existing closed GovernedActionIntent validator, unchanged', () => {
    it('16. minimal valid action/resource/idempotencyKey reaches the Kernel', async () => {
      const measured = await measure(() => send(baseUrl, { action: DENIED_INTENT.action, resource: DENIED_INTENT.resource, idempotencyKey: freshKey('minimal') }, { authorization: bearer(SECRET) }));
      assert.notEqual(measured.value.body['status'], 'rejected', measured.value.text);
      assert.ok(measured.kernel > 0);
      assert.equal(measured.commits, 1);
    });

    it('17–20. counterparty, amount, assertedContext and correlationId are accepted and carried into the committed request', async () => {
      const reply = await send(baseUrl, allowed('full', { counterparty: 'vendor:V123', amount: { value: 7500, currency: 'USD' }, correlationId: 'order-123' }), { authorization: bearer(SECRET) });
      assert.notEqual(reply.body['status'], 'rejected', reply.text);
      assert.equal(reply.body['correlationId'], 'order-123');
      const record = await host.server.enterprise.persistence.getByRequestId({ system: true }, String(reply.body['requestId']));
      assert.ok(record !== null);
      const payload = JSON.stringify(record.request.requestPayload);
      assert.ok(payload.includes('vendor:V123'), payload);
      assert.ok(payload.includes('7500') && payload.includes('USD'), payload);
      assert.ok(payload.includes('passport-pmfreak'), 'asserted context reaches the Kernel as context to verify');
    });

    for (const [name, intent] of [
      ['21. malformed amount', () => allowed('bad-amount', { amount: { value: -1, currency: 'USD' } })],
      ['21b. amount with an extra field', () => allowed('bad-amount-2', { amount: { value: 1, currency: 'USD', unit: 'x' } })],
      ['22. missing idempotencyKey', () => ({ action: ALLOWED_INTENT.action, resource: ALLOWED_INTENT.resource })],
      ['23. blank idempotencyKey', () => allowed('blank', { idempotencyKey: '' })],
      ['23b. padded idempotencyKey', () => allowed('padded', { idempotencyKey: ' key ' })],
      ['24. undeclared top-level property', () => allowed('undeclared', { note: 'hello' })],
      ['empty body', () => ({})],
      ['array body', () => [ALLOWED_INTENT]],
    ] as const) {
      it(`${name} → 400 rejected; nothing evaluated`, async () => {
        const measured = await measure(() => send(baseUrl, intent(), { authorization: bearer(SECRET) }));
        assert.equal(measured.value.status, 400, measured.value.text);
        assertDomainBody(measured.value, 'rejected');
        assert.equal(measured.kernel, 0);
        assert.equal(measured.provider, 0);
      });
    }

    it('malformed JSON is a transport failure: the Enterprise envelope, never a result', async () => {
      const measured = await measure(() => send(baseUrl, undefined, { authorization: bearer(SECRET), raw: '{"action":' }));
      assertEnvelope(measured.value, 400, 'INVALID_REQUEST');
      assert.equal(measured.kernel, 0);
      assert.equal(measured.provider, 0);
    });

    it('an oversized body is refused by the shared reader before admission or the Kernel', async () => {
      // The adapter's existing 1 MiB reader rejects and destroys the request
      // stream, so a client may see the 400 envelope or a reset connection.
      // Either way nothing is admitted, evaluated or executed.
      const measured = await measure(async () => {
        try {
          return await send(baseUrl, undefined, { authorization: bearer(SECRET), raw: JSON.stringify({ ...allowed('huge'), assertedContext: { blob: 'x'.repeat(1024 * 1024 + 10) } }) });
        } catch {
          return undefined;
        }
      });
      if (measured.value !== undefined) assertEnvelope(measured.value, 400, 'INVALID_REQUEST');
      assert.equal(measured.kernel, 0);
      assert.equal(measured.commits, 0);
      assert.equal(measured.provider, 0);
    });
  });

  describe('routing — provider selection is never caller input', () => {
    const attempts: readonly (readonly [string, Record<string, unknown>])[] = [
      ['25. adapterId', { adapterId: 'adapter-b' }],
      ['26. provider', { provider: 'stripe' }],
      ['27. url', { url: 'https://attacker.example' }],
      ['27b. host', { host: 'attacker.example' }],
      ['27c. destination', { destination: 'acct-attacker' }],
      ['27d. endpoint', { endpoint: '/v1/charges' }],
      ['27e. origin', { origin: 'https://attacker.example' }],
      ['28. credential', { credential: 'sk_live_x' }],
      ['28b. credentials', { credentials: { token: 'x' } }],
      ['28c. providerPayload', { providerPayload: { amount: 999999 } }],
      ['28d. headers', { headers: { authorization: 'Bearer x' } }],
      ['28e. grant', { grant: { expiresAt: '2099-01-01T00:00:00Z' } }],
      ['28f. boundedGrantId', { boundedGrantId: 'grant-1' }],
      ['28g. signer / privateKey', { signer: 'x', privateKey: 'y' }],
    ];
    for (const [name, extra] of attempts) {
      it(`${name} at top level → 400 rejected; no Kernel, no provider`, async () => {
        const measured = await measure(() => send(baseUrl, allowed('route', extra), { authorization: bearer(SECRET) }));
        assert.equal(measured.value.status, 400, measured.value.text);
        assertDomainBody(measured.value, 'rejected');
        assert.equal(measured.kernel, 0);
        assert.equal(measured.provider, 0);
      });
    }

    // P7: aggregate / velocity exercise controls are trusted host composition.
    // No limit, bucket, budget, window, reservation or binding digest can be
    // named by a caller — at the top level or in asserted context — and every
    // attempt stops before the Kernel with no provider call.
    const P7_FIELDS: readonly (readonly [string, unknown])[] = [
      ['limit', 5],
      ['limits', [{ limitId: 'x', maximum: 1e9 }]],
      ['limitId', 'caller-limit'],
      ['scopeKey', 'caller-scope'],
      ['quota', 1e9],
      ['budget', { amount: 1e9 }],
      ['velocity', { perMinute: 1e6 }],
      ['window', { kind: 'lifetime' }],
      ['windowSeconds', 1],
      ['maximum', 1e9],
      ['maxCount', 1e9],
      ['maxAmount', '1000000000'],
      ['reservation', { state: 'released' }],
      ['reservationId', 'aoc.exercise-reservation:caller'],
      ['exerciseControls', { policy: 'none' }],
      ['aggregateControls', { enabled: false }],
      ['authorityBindingDigest', `sha256:${'a'.repeat(64)}`],
    ];
    for (const [field, value] of P7_FIELDS) {
      it(`P7 '${field}' at top level → 400 rejected / GOVERNED_ACTION_INTENT_INVALID; no Kernel, no Store, no provider`, async () => {
        const measured = await measure(() => send(baseUrl, allowed('p7', { [field]: value }), { authorization: bearer(SECRET) }));
        assert.equal(measured.value.status, 400, measured.value.text);
        const body = assertDomainBody(measured.value, 'rejected');
        assert.deepEqual([...body.reasonCodes], [GOVERNED_ACTION_REASON_CODES.GOVERNED_ACTION_INTENT_INVALID]);
        assert.equal(measured.kernel, 0);
        assert.equal(measured.commits, 0);
        assert.equal(measured.provider, 0);
      });
      it(`P7 '${field}' inside assertedContext → 400 rejected; no Kernel, no provider`, async () => {
        const measured = await measure(() => send(baseUrl, allowed('p7-ctx', { assertedContext: { ...ALLOWED_INTENT.assertedContext, [field]: value } }), { authorization: bearer(SECRET) }));
        assert.equal(measured.value.status, 400, measured.value.text);
        assertDomainBody(measured.value, 'rejected');
        assert.equal(measured.kernel, 0);
        assert.equal(measured.provider, 0);
      });
    }

    for (const key of ['adapterId', 'adapter', 'url', 'grant', 'actorId', 'organizationId', 'system', 'credential', 'authorization']) {
      it(`reserved assertedContext key '${key}' → 400 rejected`, async () => {
        const measured = await measure(() => send(baseUrl, allowed('ctx', { assertedContext: { ...ALLOWED_INTENT.assertedContext, [key]: 'x' } }), { authorization: bearer(SECRET) }));
        assert.equal(measured.value.status, 400, measured.value.text);
        assertDomainBody(measured.value, 'rejected');
        assert.equal(measured.provider, 0);
      });
    }

    it('an allowed action runs on the server-selected child only', async () => {
      const a = adapterA.callCount;
      const b = adapterB.callCount;
      assertDomainBody(await send(baseUrl, allowed('selected'), { authorization: bearer(SECRET) }), 'executed');
      assert.equal(adapterA.callCount, a + 1);
      assert.equal(adapterB.callCount, b);
    });
  });

  describe('governance outcomes — domain result bodies with the transport mapping', () => {
    it('29. allowed + successful adapter → 200 executed', async () => {
      const measured = await measure(() => send(baseUrl, allowed('executed'), { authorization: bearer(SECRET) }));
      assert.equal(measured.value.status, 200);
      const body = assertDomainBody(measured.value, 'executed');
      assert.equal(body.status === 'executed' ? body.replayed : undefined, false);
      assert.equal(body.decision?.status, 'allowed');
      assert.equal(measured.provider, 1);
    });

    it('30. Kernel denied → 422 denied; no provider', async () => {
      const measured = await measure(() => send(baseUrl, { ...DENIED_INTENT, idempotencyKey: freshKey('denied') }, { authorization: bearer(SECRET_DENIED) }));
      assert.equal(measured.value.status, 422, measured.value.text);
      const body = assertDomainBody(measured.value, 'denied');
      assert.equal(body.decision?.status, 'denied');
      assert.equal(measured.commits, 1, 'a denial is a committed decision');
      assert.equal(measured.provider, 0);
    });

    it('31. approval required → 409 withheld / approval; no provider', async () => {
      const measured = await measure(() => send(baseUrl, { ...APPROVAL_INTENT, idempotencyKey: freshKey('approval') }, { authorization: bearer(SECRET) }));
      assert.equal(measured.value.status, 409, measured.value.text);
      const body = assertDomainBody(measured.value, 'withheld');
      assert.equal(body.status === 'withheld' ? body.withheldBy : undefined, 'approval');
      assert.equal(measured.provider, 0);
    });

    it('32. indeterminate → 503 indeterminate; no provider', async () => {
      knobs.recognitionThrows = true;
      const measured = await measure(() => send(baseUrl, allowed('indeterminate'), { authorization: bearer(SECRET) }));
      assert.equal(measured.value.status, 503, measured.value.text);
      assertDomainBody(measured.value, 'indeterminate');
      assert.equal(measured.provider, 0);
    });

    it('34. grant terms unavailable → 409 withheld / grant-terms; no provider', async () => {
      knobs.grantTermsUnavailable = true;
      const measured = await measure(() => send(baseUrl, allowed('terms'), { authorization: bearer(SECRET) }));
      assert.equal(measured.value.status, 409, measured.value.text);
      const body = assertDomainBody(measured.value, 'withheld');
      assert.equal(body.status === 'withheld' ? body.withheldBy : undefined, 'grant-terms');
      assert.equal(measured.provider, 0);
    });

    it('35. authority binding unresolved → 409 withheld / authority-binding; no provider', async () => {
      knobs.authorityBindingUnresolved = true;
      const measured = await measure(() => send(baseUrl, allowed('binding'), { authorization: bearer(SECRET) }));
      assert.equal(measured.value.status, 409, measured.value.text);
      const body = assertDomainBody(measured.value, 'withheld');
      assert.equal(body.status === 'withheld' ? body.withheldBy : undefined, 'authority-binding');
      assert.equal(measured.provider, 0);
    });

    it('36. exercise withheld (the grant is gone at exercise) → 409 withheld / exercise; no provider', async () => {
      knobs.issuedGrantsVanish = true;
      const measured = await measure(() => send(baseUrl, allowed('exercise'), { authorization: bearer(SECRET) }));
      assert.equal(measured.value.status, 409, measured.value.text);
      const body = assertDomainBody(measured.value, 'withheld');
      assert.equal(body.status === 'withheld' ? body.withheldBy : undefined, 'exercise');
      assert.equal(measured.provider, 0);
    });

    it('37. provider rejected → 502 execution_failed', async () => {
      knobs.adapter = 'rejected';
      const measured = await measure(() => send(baseUrl, allowed('rejected'), { authorization: bearer(SECRET) }));
      assert.equal(measured.value.status, 502, measured.value.text);
      const body = assertDomainBody(measured.value, 'execution_failed');
      assert.equal(body.status === 'execution_failed' ? body.failure : undefined, 'PROVIDER_REJECTED');
      assert.equal(measured.provider, 1);
    });

    it('38. adapter error → 502 execution_failed', async () => {
      knobs.adapter = 'throws';
      const measured = await measure(() => send(baseUrl, allowed('adapter-error'), { authorization: bearer(SECRET) }));
      assert.equal(measured.value.status, 502, measured.value.text);
      const body = assertDomainBody(measured.value, 'execution_failed');
      assert.equal(body.status === 'execution_failed' ? body.failure : undefined, 'ADAPTER_ERROR');
      assert.equal(measured.value.text.includes('socket reset'), false, 'provider error text never reaches the caller');
    });

    it('39. already attempted, outcome not on record → 409 execution_unconfirmed; the adapter is not called again', async () => {
      const intent = allowed('unconfirmed');
      knobs.outcomeReferenceFails = true;
      const first = await measure(() => send(baseUrl, intent, { authorization: bearer(SECRET) }));
      const firstBody = assertDomainBody(first.value, 'executed');
      assert.equal(firstBody.status === 'executed' ? firstBody.outcomeRecorded : undefined, false);
      assert.equal(first.provider, 1);

      knobs.outcomeReferenceFails = false;
      const retry = await measure(() => send(baseUrl, intent, { authorization: bearer(SECRET) }));
      assert.equal(retry.value.status, 409, retry.value.text);
      assertDomainBody(retry.value, 'execution_unconfirmed');
      assert.equal(retry.provider, 0);
    });
  });

  describe('idempotency — the intent’s own idempotencyKey, scoped to (organization, principal)', () => {
    it('40. identical retry replays the recorded result; one external call in total', async () => {
      const intent = allowed('replay');
      const first = await measure(() => send(baseUrl, intent, { authorization: bearer(SECRET) }));
      const second = await measure(() => send(baseUrl, intent, { authorization: bearer(SECRET) }));
      const a = assertDomainBody(first.value, 'executed');
      const b = assertDomainBody(second.value, 'executed');
      assert.equal(second.value.status, 200);
      assert.equal(b.status === 'executed' ? b.replayed : undefined, true);
      assert.equal(b.requestId, a.requestId);
      assert.equal(b.executionId, a.executionId);
      assert.equal(b.decision?.decisionId, a.decision?.decisionId);
      assert.equal(first.provider + second.provider, 1);
      assert.equal(second.commits, 0, 'the committed decision is reused, not re-made');
    });

    it('the legacy Idempotency-Key header is not an idempotency source here', async () => {
      const intent = allowed('header');
      const first = await measure(() => send(baseUrl, intent, { authorization: bearer(SECRET), headers: { 'idempotency-key': 'header-1' } }));
      const second = await measure(() => send(baseUrl, intent, { authorization: bearer(SECRET), headers: { 'idempotency-key': 'header-2' } }));
      assert.equal(second.value.body['requestId'], first.value.body['requestId']);
      assert.equal(first.provider + second.provider, 1);
    });

    it('41. conflicting reuse → 409 rejected / GOVERNED_ACTION_IDEMPOTENCY_CONFLICT; still one external call', async () => {
      const key = freshKey('conflict');
      const first = await measure(() => send(baseUrl, { ...ALLOWED_INTENT, idempotencyKey: key }, { authorization: bearer(SECRET) }));
      assertDomainBody(first.value, 'executed');
      const conflict = await measure(() => send(baseUrl, { ...ALLOWED_INTENT, idempotencyKey: key, counterparty: 'vendor:OTHER' }, { authorization: bearer(SECRET) }));
      assert.equal(conflict.value.status, 409, conflict.value.text);
      const body = assertDomainBody(conflict.value, 'rejected');
      assert.deepEqual([...body.reasonCodes], [GOVERNED_ACTION_REASON_CODES.GOVERNED_ACTION_IDEMPOTENCY_CONFLICT]);
      assert.equal(first.provider + conflict.provider, 1);
      assert.equal(conflict.commits, 0);
    });

    it('42. the same raw key under a different principal does not collide', async () => {
      const intent = allowed('principal');
      const a = await measure(() => send(baseUrl, intent, { authorization: bearer(SECRET) }));
      const b = await measure(() => send(baseUrl, intent, { authorization: bearer(SECRET_SAME_ACTOR_OTHER_PRINCIPAL) }));
      const bodyA = assertDomainBody(a.value, 'executed');
      const bodyB = assertDomainBody(b.value, 'executed');
      assert.notEqual(bodyA.requestId, bodyB.requestId, 'the key is principal-qualified');
      assert.equal(bodyB.status === 'executed' ? bodyB.replayed : undefined, false);
      assert.equal(a.provider, 1);
      assert.equal(b.provider, 1);
    });
  });

  describe('emergency control — inherited from P4, never administered here', () => {
    const stops: readonly (readonly [string, Record<string, unknown>])[] = [
      ['43. global', { scope: 'global' }],
      ['44. organization', { scope: 'organization', value: ORG }],
      ['45. actor', { scope: 'actor', value: PMFREAK_ACTOR_ID }],
      ['46. resource', { scope: 'resource', value: ALLOWED_INTENT.resource }],
      ['47. selected adapter', { scope: 'adapter', value: 'adapter-a' }],
    ];
    for (const [name, control] of stops) {
      it(`${name} stop → 409 withheld / emergency-control; no provider call`, async () => {
        controls.activate({ ...control, issuerRef: ISSUER, declaredAt: AT } as never);
        const measured = await measure(() => send(baseUrl, allowed('stop'), { authorization: bearer(SECRET) }));
        assert.equal(measured.value.status, 409, measured.value.text);
        const body = assertDomainBody(measured.value, 'withheld');
        assert.equal(body.status === 'withheld' ? body.withheldBy : undefined, 'emergency-control');
        assert.deepEqual([...body.reasonCodes], [EMERGENCY_CONTROL_REASON_CODES.EMERGENCY_CONTROL_ACTIVE]);
        assert.equal(measured.provider, 0);
        assert.equal(measured.value.text.includes(ISSUER), false, 'who declared the stop is operator information');
      });
    }

    it('an adapter stop on the child that was NOT selected does not withhold', async () => {
      controls.activate({ scope: 'adapter', value: 'adapter-b', issuerRef: ISSUER, declaredAt: AT });
      assertDomainBody(await send(baseUrl, allowed('other-child'), { authorization: bearer(SECRET) }), 'executed');
    });

    it('48. unreadable control → 409 withheld / emergency-control (fail closed); no provider call', async () => {
      knobs.controlUnreadable = true;
      const measured = await measure(() => send(baseUrl, allowed('unreadable'), { authorization: bearer(SECRET) }));
      assert.equal(measured.value.status, 409, measured.value.text);
      const body = assertDomainBody(measured.value, 'withheld');
      assert.equal(body.status === 'withheld' ? body.withheldBy : undefined, 'emergency-control');
      assert.deepEqual([...body.reasonCodes], [EMERGENCY_CONTROL_REASON_CODES.EMERGENCY_CONTROL_UNAVAILABLE]);
      assert.equal(measured.provider, 0);
    });

    it('49. a recorded result is replayed after the stop state changes — history is not rewritten', async () => {
      const intent = allowed('history');
      assertDomainBody(await send(baseUrl, intent, { authorization: bearer(SECRET) }), 'executed');
      controls.activate({ scope: 'global', issuerRef: ISSUER, declaredAt: AT });
      const replay = await measure(() => send(baseUrl, intent, { authorization: bearer(SECRET) }));
      assert.equal(replay.value.status, 200, replay.value.text);
      const body = assertDomainBody(replay.value, 'executed');
      assert.equal(body.status === 'executed' ? body.replayed : undefined, true);
      assert.equal(replay.provider, 0);
    });

    it('the customer route cannot read, activate or release a control', async () => {
      for (const method of ['GET', 'PUT', 'DELETE', 'PATCH']) {
        assertEnvelope(await send(baseUrl, undefined, { method, authorization: bearer(SECRET) }), 404, 'NOT_FOUND');
      }
      for (const path of ['/api/emergency-control', '/api/emergency-controls', '/api/governed-actions/emergency-control']) {
        for (const method of ['GET', 'POST', 'DELETE']) {
          const response = await fetch(`${baseUrl}${path}`, { method, headers: { authorization: bearer(SECRET), 'content-type': 'application/json' }, ...(method === 'POST' ? { body: '{"scope":"global"}' } : {}) });
          assert.equal(response.status, 404, `${method} ${path}`);
        }
      }
      assert.deepEqual(controls.active(), [], 'nothing a customer sent created a control');
    });
  });

  describe('security — what a response can never contain', () => {
    it('50–51. no grant, digest, adapter, credential or system context in any outcome, and no credential in any body', async () => {
      const replies: HttpReply[] = [];
      replies.push(await send(baseUrl, allowed('leak-exec'), { authorization: bearer(SECRET) }));
      replies.push(await send(baseUrl, { ...APPROVAL_INTENT, idempotencyKey: freshKey('leak-approval') }, { authorization: bearer(SECRET) }));
      replies.push(await send(baseUrl, { ...DENIED_INTENT, idempotencyKey: freshKey('leak-denied') }, { authorization: bearer(SECRET_DENIED) }));
      replies.push(await send(baseUrl, allowed('leak-rejected', { adapterId: 'adapter-b' }), { authorization: bearer(SECRET) }));
      knobs.adapter = 'rejected';
      replies.push(await send(baseUrl, allowed('leak-failed'), { authorization: bearer(SECRET) }));
      knobs.adapter = 'completed';
      replies.push(await send(baseUrl, allowed('leak-auth'), { authorization: bearer(SECRET_LEGACY) }));
      for (const reply of replies) assertNoAuthorityArtifact(reply);
    });

    it('52. an unknown method or path still returns the existing 404 envelope', async () => {
      const response = await fetch(`${baseUrl}/api/governed-actions/extra`, { method: 'POST', headers: { authorization: bearer(SECRET) }, body: '{}' });
      assert.equal(response.status, 404);
      assert.equal(((await response.json()) as { error: { code: string } }).error.code, 'NOT_FOUND');
    });
  });
});

describe('POST /api/governed-actions — obligations, through the real listener and application sequence', () => {
  // The composed Host's grant-aware Kernel is built by the composition root
  // with no obligation capability, and composition refuses a host-supplied
  // Kernel it cannot prove grant-aware — so "obligations unsatisfied" has no
  // composition-root knob. It is proven here through the real HTTP listener,
  // the real customer admission, the real application sequence and a real
  // orchestrator whose real Kernel declares a blocking obligation. Nothing is
  // faked at the router: the result is what the orchestrator produced.
  it('33. obligations unsatisfied → 409 withheld / obligations; no provider', async () => {
    const world = buildGovernedWorld({ obligationsPending: true });
    const authorityStore = await provisionedAuthorityStore();
    const admission = createCustomerIdentityAdmission({ apiKeys: KEYS, subjectBindings: createKernelAuthoritySubjectBindingReader(authorityStore), organizationId: ORG });
    const enterprise = {
      logger: capturingLogger,
      customerIdentityAdmission: admission,
      governedActionOrchestrator: world.orchestrator,
      governAction: (rawIntent: unknown, context?: { readonly authorizationHeader?: string }) =>
        governGovernedActionRequest({ rawIntent, ...(context?.authorizationHeader !== undefined ? { authorizationHeader: context.authorizationHeader } : {}) }, { admission, orchestrator: world.orchestrator, logger: capturingLogger }),
    } as unknown as AocEnterprise;
    const server = createServer(createEnterpriseRequestListener(enterprise));
    rawServers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const reply = await send(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, allowed('obligations'), { authorization: bearer(SECRET) });
    assert.equal(reply.status, 409, reply.text);
    const body = assertDomainBody(reply, 'withheld');
    assert.equal(body.status === 'withheld' ? body.withheldBy : undefined, 'obligations');
    assert.equal(world.adapter.callCount, 0);
  });
});

describe('the application sequence stays outside the orchestrator', () => {
  it('admission is the only identity source, and a refused caller never reaches govern()', async () => {
    let governed = 0;
    const authorityStore = await provisionedAuthorityStore();
    const admission = createCustomerIdentityAdmission({ apiKeys: KEYS, subjectBindings: createKernelAuthoritySubjectBindingReader(authorityStore), organizationId: ORG });
    const orchestrator = {
      organizationId: ORG,
      govern: async (): Promise<GovernedActionResult> => {
        governed += 1;
        return { status: 'system_error', reasonCodes: [] };
      },
    };
    await assert.rejects(governGovernedActionRequest({ rawIntent: allowed('seq') }, { admission, orchestrator, logger: capturingLogger }), (error: unknown) => {
      assert.equal((error as { httpStatus?: number }).httpStatus, 401);
      return true;
    });
    assert.equal(governed, 0);
  });

  it('an identity the orchestrator refuses fails closed as 403, and any other rejection as 400', async () => {
    const authorityStore = await provisionedAuthorityStore();
    const admission = createCustomerIdentityAdmission({ apiKeys: KEYS, subjectBindings: createKernelAuthoritySubjectBindingReader(authorityStore), organizationId: ORG });
    // A real orchestrator for a *different* organization: admission binds the
    // caller in ORG, and the orchestrator refuses that identity.
    const foreign = buildGovernedWorld({ organizationId: 'org-elsewhere' });
    const refused = await governGovernedActionRequest({ rawIntent: allowed('foreign'), authorizationHeader: bearer(SECRET) }, { admission, orchestrator: foreign.orchestrator, logger: capturingLogger });
    assert.equal(refused.body.status, 'rejected');
    assert.deepEqual([...refused.body.reasonCodes], [GOVERNED_ACTION_REASON_CODES.GOVERNED_ACTION_IDENTITY_INVALID]);
    assert.equal(refused.httpStatus, 403);
    assert.equal(foreign.adapter.callCount, 0);
  });
});
