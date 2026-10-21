import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';

import { createInMemoryEmergencyControlStore } from '../../features/emergency-control-runtime/index.js';
import { createRecordingExecutionAdapter } from '../../features/execution-runtime/tests/execution-fixture.js';
import type { ValidatedExecutionAction } from '../../features/execution-runtime/index.js';
import { createInMemoryBoundedGrantStore } from '../../features/grant-runtime/index.js';
import { KernelGrantCapability } from '../../kernel/orchestration/grant-adapter.js';
import { EnterpriseHttpError } from '../api/enterprise-http-errors.js';
import { toKernelEvaluationRequest, type GovernanceEvaluateRequestBody } from '../api/governance-evaluate-contract.js';
import { createEnterprise, type AocEnterprise, type CreateEnterpriseOptions } from '../composition/composition-root.js';
import {
  loadEnterpriseConfiguration,
  validateEnterpriseEnvironment,
  type EnterpriseApiKey,
  type EnterpriseConfiguration,
  type EnterpriseServicePrincipal,
} from '../configuration/enterprise-configuration.js';
import type { EnterpriseEvent } from '../events/enterprise-events.js';
import { createInMemoryExecutionOutcomeStore } from '../execution-outcome-store/index.js';
import { readRecordedAttribution, sameRequester } from '../governance-store/attribution.js';
import {
  GOVERNANCE_ATTRIBUTION_EVENT_TYPE,
  GOVERNANCE_ATTRIBUTION_VERSION,
  type GovernanceEvaluationAttribution,
  type GovernanceRecord,
  type GovernanceStoreAccessContext,
} from '../governance-store/contracts.js';
import type { GovernanceStore } from '../governance-store/governance-store.js';
import { createInMemoryGovernanceStore } from '../governance-store/in-memory-governance-store.js';
import { createSqliteGovernanceStore } from '../governance-store/sqlite-governance-store.js';
import { GOVERNED_ACTION_REASON_CODES as R } from '../governed-action/index.js';
import { createEnterpriseServer, type EnterpriseServer } from '../host/enterprise-server.js';
import { EnterpriseHostConfigurationError, loadEnterpriseHostConfiguration } from '../host/host-configuration.js';
import { createInMemoryKernelAuthorityStore } from '../kernel-authority/in-memory-kernel-authority-store.js';
import { createKernelAuthorityProvisioningService } from '../kernel-authority/provisioning-service.js';
import { LegacyKeyConfigurationError, mayReplayTo, ServicePrincipalConfigurationError } from '../orchestration/advisory-identity.js';
import { authorityAuthenticityEnv } from './authority-authenticity-fixture.js';
import { freshnessEnv } from './core07-freshness-fixture.js';
import { ALLOWED_INTENT, EVALUATED_AT_POLICY, NO_TEMPORAL_BOUND, ORG, PMFREAK_ACTOR_ID, TRUST_DOMAIN_ID } from './governed-action-support.js';
import { buildAllowedRequestBody, buildTestKernelProviders } from './support.js';

/**
 * G-01A — trusted identity and attribution on the advisory evaluate route.
 *
 * Before G-01A, `POST /api/governance/evaluate` trusted the actor and
 * organization a request named because the request was authenticated: every
 * key could evaluate, and be recorded, as whichever actor it named; an organization-scoped key
 * could omit its organization; and an idempotent replay answered whoever reused
 * a key. Here every one of those is a claim, checked against the credential:
 *
 * - customer principals evaluate only as the actor customer identity admission
 *   binds them to, in their organization and the Host's trust domain;
 * - service principals evaluate only for actors on their explicit allow-list,
 *   and are recorded apart from the actor they evaluated;
 * - legacy keys keep working, recorded as asserted; a scoped key must state
 *   its organization; an unscoped key needs the explicit `compat` mode;
 * - a stored decision replays only to the requester that committed it, and a
 *   record with no attribution never answers an authenticated principal.
 *
 * Refusals are the frozen v1 codes and write nothing. Attribution is sealed in
 * the aggregate (covered by its digests), never published, and never disclosed
 * by an evidence bundle at any level.
 */

const SUBJECT = { system: 'datasys-app', subjectId: 'user-pmfreak' } as const;
const PRINCIPAL = 'principal-pmfreak';
const OTHER_PRINCIPAL = 'principal-pmfreak-ops';
const SERVICE_PRINCIPAL = 'svc-g01a-closure-review';
const NARROW_SERVICE_PRINCIPAL = 'svc-g01a-narrow';
const OTHER_ACTOR = 'actor-g01a-someone-else';

const CUSTOMER_KEY = 'G01A_CUSTOMER_KEY_SENTINEL_0123456789abcdef';
const OTHER_CUSTOMER_KEY = 'G01A_OTHER_CUSTOMER_KEY_SENTINEL_0123456789';
const LEGACY_KEY = 'G01A_LEGACY_SCOPED_KEY_SENTINEL_0123456789';
const BARE_KEY = 'G01A_LEGACY_BARE_KEY_SENTINEL_0123456789ab';
const SERVICE_KEY = 'G01A_SERVICE_KEY_SENTINEL_0123456789abcdef';
const NARROW_SERVICE_KEY = 'G01A_NARROW_SERVICE_KEY_SENTINEL_01234567';

const KEYS: readonly EnterpriseApiKey[] = [
  { key: CUSTOMER_KEY, organizationId: ORG, customerIdentity: { principalId: PRINCIPAL, externalSubject: SUBJECT } },
  // A second principal bound to the same subject, so to the same actor: the cross-principal replay case.
  { key: OTHER_CUSTOMER_KEY, organizationId: ORG, customerIdentity: { principalId: OTHER_PRINCIPAL, externalSubject: SUBJECT } },
  { key: LEGACY_KEY, organizationId: ORG },
  { key: BARE_KEY },
];

const SERVICES: readonly EnterpriseServicePrincipal[] = [
  { principalId: SERVICE_PRINCIPAL, organizationId: ORG, key: SERVICE_KEY, onBehalfOfActors: [PMFREAK_ACTOR_ID] },
  { principalId: NARROW_SERVICE_PRINCIPAL, organizationId: ORG, key: NARROW_SERVICE_KEY, onBehalfOfActors: [OTHER_ACTOR] },
];

const SYSTEM: GovernanceStoreAccessContext = { system: true };
const ALL_SECRETS = [CUSTOMER_KEY, OTHER_CUSTOMER_KEY, LEGACY_KEY, BARE_KEY, SERVICE_KEY, NARROW_SERVICE_KEY];

function body(overrides: Partial<GovernanceEvaluateRequestBody> = {}): GovernanceEvaluateRequestBody {
  return buildAllowedRequestBody({ organization: { id: ORG }, ...overrides });
}

function configuration(legacyKeyMode: 'compat' | 'restricted' = 'compat'): EnterpriseConfiguration {
  const base = loadEnterpriseConfiguration({
    AOC_ENTERPRISE_PERSISTENCE_PROVIDER: 'memory',
    AOC_ENTERPRISE_KERNEL_AUTHORITY_ORGANIZATION_ID: ORG,
    AOC_ENTERPRISE_HTTP_PORT: '0',
    AOC_ENTERPRISE_HTTP_HOST: '127.0.0.1',
    AOC_ENTERPRISE_REQUIRE_AUTH: 'true',
    AOC_ENTERPRISE_LOG_LEVEL: 'error',
  });
  return { ...base, authentication: { apiKeys: legacyKeyMode === 'restricted' ? KEYS.filter((apiKey) => apiKey.key !== BARE_KEY) : KEYS, servicePrincipals: SERVICES, legacyKeyMode } };
}

// ---------------------------------------------------------------------------
// A composed Host — customer admission, governed actions, service principals —
// over each Governance Store provider, with every append counted.

interface Provider {
  readonly name: string;
  open(): Promise<GovernanceStore>;
}

const PROVIDERS: readonly Provider[] = [
  { name: 'in-memory', open: async () => createInMemoryGovernanceStore() },
  { name: 'sqlite', open: async () => createSqliteGovernanceStore(':memory:') },
];

interface Harness {
  readonly enterprise: AocEnterprise;
  readonly raw: GovernanceStore;
  readonly appends: () => number;
  readonly baseUrl: string;
}

const servers: EnterpriseServer[] = [];
const enterprises: AocEnterprise[] = [];
const directories: string[] = [];
after(async () => {
  await Promise.all(servers.map((server) => server.close().catch(() => {})));
  await Promise.all(enterprises.map((enterprise) => enterprise.close().catch(() => {})));
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

function counting(raw: GovernanceStore): { readonly store: GovernanceStore; readonly appends: () => number } {
  let appends = 0;
  const store = new Proxy(raw, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof value !== 'function') return value;
      if (property === 'appendEvaluation') {
        return (...args: unknown[]) => {
          appends += 1;
          return (value as (...inner: unknown[]) => unknown).apply(target, args);
        };
      }
      return (value as (...inner: unknown[]) => unknown).bind(target);
    },
  });
  return { store, appends: () => appends };
}

async function hostOptions(persistence: GovernanceStore, legacyKeyMode: 'compat' | 'restricted' = 'compat'): Promise<CreateEnterpriseOptions> {
  const authority = createInMemoryKernelAuthorityStore();
  await createKernelAuthorityProvisioningService({ store: authority, organizationId: ORG }).provisionActor(
    { system: true, actorId: 'operator-g01a' },
    { actorId: PMFREAK_ACTOR_ID, type: 'agent', displayName: 'PMFreak', externalSubject: SUBJECT },
  );
  const inner = createRecordingExecutionAdapter(async () => ({ outcome: 'completed', providerRef: 'provider-ref-g01a' }));
  return {
    configuration: configuration(legacyKeyMode),
    kernelProviders: buildTestKernelProviders(),
    kernelAuthorityStore: authority,
    persistence,
    customerIdentityAdmission: { enabled: true },
    authorityControlledExecution: {
      grantCapability: new KernelGrantCapability({ declaration: {} }),
      grantStore: createInMemoryBoundedGrantStore(),
      executionAdapterRouting: { adapters: [{ adapterId: 'adapter-g01a', execute: (action: ValidatedExecutionAction) => inner.execute(action) }], selectAdapter: () => 'adapter-g01a' },
      resolveAuthorityBinding: () => NO_TEMPORAL_BOUND,
    },
    governedActionOrchestrator: { enabled: true, trustDomainId: TRUST_DOMAIN_ID, grantPolicy: EVALUATED_AT_POLICY },
    monetary: { assets: [{ assetId: 'USD', scale: 2 }], financialActions: [] },
    emergencyControl: { enabled: true, store: createInMemoryEmergencyControlStore() },
    executionOutcomes: { store: createInMemoryExecutionOutcomeStore({ now: () => new Date().toISOString() }) },
  };
}

async function harness(provider: Provider, legacyKeyMode: 'compat' | 'restricted' = 'compat'): Promise<Harness> {
  const raw = await provider.open();
  const { store, appends } = counting(raw);
  const server = await createEnterpriseServer(await hostOptions(store, legacyKeyMode));
  servers.push(server);
  const { port } = await server.listen();
  return { enterprise: server.enterprise, raw, appends, baseUrl: `http://127.0.0.1:${port}` };
}

interface Reply {
  readonly status: number;
  readonly text: string;
  readonly body: Record<string, unknown>;
}

async function call(h: Harness, method: string, path: string, secret: string | undefined, payload?: unknown, headers: Record<string, string> = {}): Promise<Reply> {
  const response = await fetch(`${h.baseUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(secret !== undefined ? { authorization: `Bearer ${secret}` } : {}), ...headers },
    ...(payload !== undefined ? { body: typeof payload === 'string' ? payload : JSON.stringify(payload) } : {}),
  });
  const text = await response.text();
  return { status: response.status, text, body: text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

const evaluate = (h: Harness, secret: string | undefined, payload: unknown, idempotencyKey?: string): Promise<Reply> =>
  call(h, 'POST', '/api/governance/evaluate', secret, payload, idempotencyKey !== undefined ? { 'idempotency-key': idempotencyKey } : {});

const errorCode = (reply: Reply): unknown => (reply.body['error'] as Record<string, unknown> | undefined)?.['code'];
const evaluationIdOf = (reply: Reply): string => String((reply.body['governanceRecord'] as Record<string, unknown> | undefined)?.['evaluationId']);

let sequence = 0;
const fresh = (label: string): string => `g01a-${label}-${(sequence += 1)}`;

async function storedRecord(h: Harness, reply: Reply): Promise<GovernanceRecord> {
  const record = await h.raw.getByEvaluationId(SYSTEM, evaluationIdOf(reply));
  assert.ok(record !== null, `a record was committed for ${reply.text}`);
  return record;
}

async function attributionOf(h: Harness, reply: Reply): Promise<GovernanceEvaluationAttribution> {
  const recorded = readRecordedAttribution(await storedRecord(h, reply));
  assert.equal(recorded.status, 'attributed');
  if (recorded.status !== 'attributed') throw new Error('unreachable');
  return recorded.attribution;
}

async function refusedWithoutWrite(h: Harness, reply: Promise<Reply>, status: number, code: string): Promise<void> {
  const before = h.appends();
  const answered = await reply;
  assert.equal(answered.status, status, answered.text);
  assert.equal(errorCode(answered), code, answered.text);
  assert.equal(h.appends(), before, 'a refusal reaches no Governance Store append');
  for (const secret of ALL_SECRETS) assert.equal(answered.text.includes(secret), false, 'no refusal echoes a credential');
}

for (const provider of PROVIDERS) {
  describe(`G-01A — ${provider.name} Store — customer principals evaluate only as their bound actor`, () => {
    let pending: Promise<Harness> | undefined;
    const ready = (): Promise<Harness> => (pending ??= harness(provider));

    it('a bound principal stating its own actor, organization and trust domain evaluates; the record carries its principal, verifiably', async () => {
      const h = await ready();
      const reply = await evaluate(h, CUSTOMER_KEY, body({ requestId: fresh('customer') }));
      assert.equal(reply.status, 200, reply.text);
      assert.deepEqual(await attributionOf(h, reply), {
        version: GOVERNANCE_ATTRIBUTION_VERSION,
        basis: 'customer-principal',
        organizationId: ORG,
        requestingPrincipalId: PRINCIPAL,
        evaluatedActorId: PMFREAK_ACTOR_ID,
      });
      const verification = await h.raw.verify(SYSTEM, evaluationIdOf(reply));
      assert.equal(verification.valid, true, JSON.stringify(verification));
      assert.deepEqual(Object.keys(reply.body).sort(), ['correlationId', 'decisionId', 'evaluatedAt', 'governanceRecord', 'kernelVersion', 'reasonCodes', 'requestId', 'status', 'summary', 'trace'].filter((key) => key in reply.body).sort(), 'the v1 response shape is unchanged');
    });

    it('actor impersonation: naming another actor is the v1 403 and writes nothing', async () => {
      const h = await ready();
      await refusedWithoutWrite(h, evaluate(h, CUSTOMER_KEY, body({ requestId: fresh('impersonate'), actor: { id: OTHER_ACTOR, trustDomainId: TRUST_DOMAIN_ID } })), 403, 'AUTHORIZATION_FAILED');
    });

    it('organization substitution: naming another organization is the v1 403 and writes nothing', async () => {
      const h = await ready();
      await refusedWithoutWrite(h, evaluate(h, CUSTOMER_KEY, body({ requestId: fresh('substitute'), organization: { id: 'org-g01a-foreign' } })), 403, 'AUTHORIZATION_FAILED');
    });

    it('organization omission: an unstated organization is not an implicit match — 403, nothing written', async () => {
      const h = await ready();
      const omitted = buildAllowedRequestBody({ requestId: fresh('omitted') });
      assert.equal('organization' in omitted, false);
      await refusedWithoutWrite(h, evaluate(h, CUSTOMER_KEY, omitted), 403, 'AUTHORIZATION_FAILED');
    });

    it('trust domain: a caller-supplied trust domain is never an authority source — a mismatch is 403', async () => {
      const h = await ready();
      await refusedWithoutWrite(h, evaluate(h, CUSTOMER_KEY, body({ requestId: fresh('trust-domain'), actor: { id: PMFREAK_ACTOR_ID, trustDomainId: 'trust-domain-g01a-attacker' } })), 403, 'AUTHORIZATION_FAILED');
    });

    it('principal spoofing: identity named anywhere in the body never changes the recorded requester', async () => {
      const h = await ready();
      const spoof = body({
        requestId: fresh('spoof'),
        context: { passportId: 'passport-pmfreak', requestingPrincipalId: SERVICE_PRINCIPAL, principalId: SERVICE_PRINCIPAL, principal: { principalId: SERVICE_PRINCIPAL }, system: true, attribution: { basis: 'service-principal' } },
      });
      const reply = await evaluate(h, CUSTOMER_KEY, spoof);
      assert.ok([200, 422].includes(reply.status), reply.text);
      const attribution = await attributionOf(h, reply);
      assert.equal(attribution.basis, 'customer-principal');
      assert.equal(attribution.basis === 'customer-principal' ? attribution.requestingPrincipalId : undefined, PRINCIPAL);
    });

    it('an unknown credential is the v1 401 and writes nothing', async () => {
      const h = await ready();
      await refusedWithoutWrite(h, evaluate(h, 'G01A_NOT_A_CONFIGURED_KEY_0123456789', body({ requestId: fresh('unknown') })), 401, 'AUTHENTICATION_FAILED');
    });
  });

  describe(`G-01A — ${provider.name} Store — service principals act only within their explicit allow-list`, () => {
    let pending: Promise<Harness> | undefined;
    const ready = (): Promise<Harness> => (pending ??= harness(provider));

    it('an allow-listed actor evaluates; the requester and the evaluated actor stay distinct', async () => {
      const h = await ready();
      const reply = await evaluate(h, SERVICE_KEY, body({ requestId: fresh('service') }));
      assert.equal(reply.status, 200, reply.text);
      assert.deepEqual(await attributionOf(h, reply), {
        version: GOVERNANCE_ATTRIBUTION_VERSION,
        basis: 'service-principal',
        organizationId: ORG,
        requestingPrincipalId: SERVICE_PRINCIPAL,
        evaluatedActorId: PMFREAK_ACTOR_ID,
      });
      assert.equal((await h.raw.verify(SYSTEM, evaluationIdOf(reply))).valid, true);
    });

    it('delegation outside the allow-list is 403 and writes nothing', async () => {
      const h = await ready();
      await refusedWithoutWrite(h, evaluate(h, NARROW_SERVICE_KEY, body({ requestId: fresh('outside') })), 403, 'AUTHORIZATION_FAILED');
      await refusedWithoutWrite(h, evaluate(h, SERVICE_KEY, body({ requestId: fresh('outside-2'), actor: { id: OTHER_ACTOR, trustDomainId: TRUST_DOMAIN_ID } })), 403, 'AUTHORIZATION_FAILED');
    });

    it('organization omission, substitution and a foreign trust domain are 403 and write nothing', async () => {
      const h = await ready();
      await refusedWithoutWrite(h, evaluate(h, SERVICE_KEY, buildAllowedRequestBody({ requestId: fresh('svc-omitted') })), 403, 'AUTHORIZATION_FAILED');
      await refusedWithoutWrite(h, evaluate(h, SERVICE_KEY, body({ requestId: fresh('svc-foreign'), organization: { id: 'org-g01a-foreign' } })), 403, 'AUTHORIZATION_FAILED');
      await refusedWithoutWrite(h, evaluate(h, SERVICE_KEY, body({ requestId: fresh('svc-domain'), actor: { id: PMFREAK_ACTOR_ID, trustDomainId: 'trust-domain-g01a-attacker' } })), 403, 'AUTHORIZATION_FAILED');
    });

    it('no privilege escalation: a service secret authenticates no read, no customer route and no operator plane', async () => {
      const h = await ready();
      const committed = await evaluate(h, SERVICE_KEY, body({ requestId: fresh('svc-read') }));
      assert.equal(committed.status, 200, committed.text);
      const read = await call(h, 'GET', `/api/governance/evaluations/${evaluationIdOf(committed)}`, SERVICE_KEY);
      assert.equal(read.status, 401, read.text);
      const governed = await call(h, 'POST', '/api/governed-actions', SERVICE_KEY, { ...ALLOWED_INTENT, idempotencyKey: fresh('svc-governed') });
      assert.equal(governed.status, 401, governed.text);
      for (const path of ['/api/admin/agents', '/api/admin/approvals']) {
        const admin = await call(h, 'GET', path, SERVICE_KEY);
        assert.ok([401, 403, 404].includes(admin.status), `${path}: ${admin.text}`);
        assert.notEqual(admin.status, 200);
      }
    });
  });

  describe(`G-01A — ${provider.name} Store — legacy keys are asserted, never authenticated`, () => {
    let pending: Promise<Harness> | undefined;
    const ready = (): Promise<Harness> => (pending ??= harness(provider));

    it('a scoped legacy key stating its organization keeps working; its actor is recorded as asserted, with no principal', async () => {
      const h = await ready();
      const reply = await evaluate(h, LEGACY_KEY, body({ requestId: fresh('legacy') }));
      assert.equal(reply.status, 200, reply.text);
      const attribution = await attributionOf(h, reply);
      assert.deepEqual(attribution, { version: GOVERNANCE_ATTRIBUTION_VERSION, basis: 'legacy-asserted', legacyScope: 'organization', organizationId: ORG, evaluatedActorId: PMFREAK_ACTOR_ID });
      assert.equal('requestingPrincipalId' in attribution, false);
    });

    it('a scoped legacy key omitting its organization is 403 (the v1 bypass is closed) and writes nothing', async () => {
      const h = await ready();
      await refusedWithoutWrite(h, evaluate(h, LEGACY_KEY, buildAllowedRequestBody({ requestId: fresh('legacy-omitted') })), 403, 'AUTHORIZATION_FAILED');
    });

    it('compat (explicit): an unscoped key keeps its v1 meaning, recorded as asserted and unscoped', async () => {
      const h = await ready();
      const reply = await evaluate(h, BARE_KEY, buildAllowedRequestBody({ requestId: fresh('bare') }));
      assert.equal(reply.status, 200, reply.text);
      assert.deepEqual(await attributionOf(h, reply), { version: GOVERNANCE_ATTRIBUTION_VERSION, basis: 'legacy-asserted', legacyScope: 'unscoped', evaluatedActorId: PMFREAK_ACTOR_ID });
    });
  });

  describe(`G-01A — ${provider.name} Store — a stored decision replays only to the requester that committed it`, () => {
    let pending: Promise<Harness> | undefined;
    const ready = (): Promise<Harness> => (pending ??= harness(provider));

    it('Idempotency-Key: another principal of the same organization and actor gets the existing 409, never the record', async () => {
      const h = await ready();
      const key = fresh('idem');
      const payload = body({ requestId: fresh('idem-req') });
      const first = await evaluate(h, CUSTOMER_KEY, payload, key);
      assert.equal(first.status, 200, first.text);
      await refusedWithoutWrite(h, evaluate(h, OTHER_CUSTOMER_KEY, payload, key), 409, 'GOVERNANCE_IDEMPOTENCY_CONFLICT');
      await refusedWithoutWrite(h, evaluate(h, SERVICE_KEY, payload, key), 409, 'GOVERNANCE_IDEMPOTENCY_CONFLICT');
      await refusedWithoutWrite(h, evaluate(h, LEGACY_KEY, payload, key), 409, 'GOVERNANCE_IDEMPOTENCY_CONFLICT');
      const again = await evaluate(h, CUSTOMER_KEY, payload, key);
      assert.equal(again.status, 200, again.text);
      assert.equal(evaluationIdOf(again), evaluationIdOf(first), 'the committing principal still replays its own decision');
    });

    it('request id: a reused request id from another requester is the existing 409, never the record', async () => {
      const h = await ready();
      const payload = body({ requestId: fresh('rid') });
      const first = await evaluate(h, SERVICE_KEY, payload);
      assert.equal(first.status, 200, first.text);
      await refusedWithoutWrite(h, evaluate(h, CUSTOMER_KEY, payload), 409, 'CONCURRENCY_CONFLICT');
      await refusedWithoutWrite(h, evaluate(h, LEGACY_KEY, payload), 409, 'CONCURRENCY_CONFLICT');
      const again = await evaluate(h, SERVICE_KEY, payload);
      assert.equal(evaluationIdOf(again), evaluationIdOf(first));
    });

    it('historical unattributed record: never adopted by a principal, never promoted; still answers a legacy key as before', async () => {
      const h = await ready();
      // Committed exactly as the pre-G-01A evaluate route committed it: system
      // context, the body's actor and organization, an org-scoped key, no attribution.
      const requestBody = body({ requestId: fresh('historical'), requestedAt: '2026-01-01T00:00:00.000Z' });
      const key = fresh('historical-key');
      const request = toKernelEvaluationRequest(requestBody, { now: () => 'unused' }, { nextId: () => 'unused' });
      const result = await h.enterprise.kernel.evaluate(request);
      const planted = await h.raw.appendEvaluation({
        request,
        result,
        receivedAt: '2026-01-01T00:00:00.000Z',
        enterpriseContext: { enterpriseVersion: 'pre-g01a', lifecycleState: 'ready', modules: [] },
        events: [],
        idempotency: { idempotencyKey: key, scope: `org:${ORG}` },
        accessContext: { system: true, organizationId: ORG, actorId: PMFREAK_ACTOR_ID },
      });
      const before = await h.raw.getByEvaluationId(SYSTEM, planted.evaluationId);
      assert.ok(before !== null);
      assert.equal(readRecordedAttribution(before).status, 'unattributed');

      for (const secret of [CUSTOMER_KEY, SERVICE_KEY]) {
        await refusedWithoutWrite(h, evaluate(h, secret, requestBody, key), 409, 'GOVERNANCE_IDEMPOTENCY_CONFLICT');
        await refusedWithoutWrite(h, evaluate(h, secret, requestBody), 409, 'CONCURRENCY_CONFLICT');
      }
      const legacy = await evaluate(h, LEGACY_KEY, requestBody, key);
      assert.equal(legacy.status, 200, legacy.text);
      assert.equal(evaluationIdOf(legacy), planted.evaluationId, 'a legacy key replays the historical decision exactly as before');
      const afterwards = await h.raw.getByEvaluationId(SYSTEM, planted.evaluationId);
      assert.deepEqual(afterwards, before, 'the historical record is returned untouched: no attribution is added to it');
      assert.equal((await h.raw.verify(SYSTEM, planted.evaluationId)).valid, true, 'historical verification is unchanged');
    });
  });

  describe(`G-01A — ${provider.name} Store — attribution is sealed, verifiable and never disclosed below the record`, () => {
    let pending: Promise<Harness> | undefined;
    const ready = (): Promise<Harness> => (pending ??= harness(provider));

    it('exactly one store-only attribution event, after the operational events, without a request id', async () => {
      const h = await ready();
      const reply = await evaluate(h, SERVICE_KEY, body({ requestId: fresh('sealed') }));
      const record = await storedRecord(h, reply);
      const attributionEvents = record.events.filter((event) => event.eventType === GOVERNANCE_ATTRIBUTION_EVENT_TYPE);
      assert.equal(attributionEvents.length, 1);
      const [event] = attributionEvents;
      assert.equal(event?.requestId, undefined, 'never on the legacy listEnterpriseEvents surface');
      assert.equal(event?.sequence, record.events.length, 'sealed last');
      const listed = await h.raw.listEnterpriseEvents();
      assert.equal(listed.some((entry) => entry.eventType === GOVERNANCE_ATTRIBUTION_EVENT_TYPE), false);
      assert.equal(JSON.stringify(listed).includes(SERVICE_PRINCIPAL), false);
    });

    it('is never published: no subscriber sees the attribution or a principal id', async () => {
      const h = await ready();
      const received: EnterpriseEvent[] = [];
      const unsubscribe = h.enterprise.eventPublisher.subscribe((event) => received.push(event));
      try {
        const reply = await evaluate(h, CUSTOMER_KEY, body({ requestId: fresh('published') }));
        assert.equal(reply.status, 200, reply.text);
      } finally {
        unsubscribe();
      }
      assert.ok(received.length > 0, 'operational events are still published');
      assert.equal(received.some((event) => (event.type as string) === GOVERNANCE_ATTRIBUTION_EVENT_TYPE), false);
      assert.equal(JSON.stringify(received).includes(PRINCIPAL), false);
    });

    it('no evidence bundle, at any disclosure level, carries the principal id', async () => {
      const h = await ready();
      let built = 0;
      for (const level of ['FULL', 'AUDITOR', 'PARTNER', 'CUSTOMER', 'PUBLIC']) {
        const reply = await evaluate(h, SERVICE_KEY, body({ requestId: fresh(`evidence-${level}`) }));
        assert.equal(reply.status, 200, reply.text);
        try {
          const bundle = await h.enterprise.evidence.build(`Bearer ${LEGACY_KEY}`, { evaluationId: evaluationIdOf(reply), level });
          built += 1;
          assert.equal(JSON.stringify(bundle).includes(SERVICE_PRINCIPAL), false, `${level}: the principal id is not disclosed`);
        } catch (error) {
          assert.equal(String(error).includes(SERVICE_PRINCIPAL), false);
        }
      }
      assert.ok(built >= 3, 'the lower disclosure levels were actually exercised');
    });

    it('tampering with a sealed attribution breaks the record’s verification', async (t) => {
      if (provider.name !== 'sqlite') {
        t.skip('row-level tampering is exercised on the SQLite provider');
        return;
      }
      const directory = mkdtempSync(join(tmpdir(), 'frontera-g01a-'));
      directories.push(directory);
      const path = join(directory, 'governance.sqlite');
      const store = await createSqliteGovernanceStore(path);
      try {
        const local = await createEnterprise({ configuration: configuration(), kernelProviders: buildTestKernelProviders(), persistence: store });
        enterprises.push(local);
        const committed = await local.evaluate(body({ requestId: fresh('tamper') }), { authorizationHeader: `Bearer ${LEGACY_KEY}` });
        const evaluationId = committed.body.governanceRecord?.evaluationId ?? '';
        assert.equal((await store.verify(SYSTEM, evaluationId)).valid, true);
        const db = new Database(path);
        try {
          const forged = JSON.stringify({ attribution: { version: GOVERNANCE_ATTRIBUTION_VERSION, basis: 'customer-principal', organizationId: ORG, requestingPrincipalId: PRINCIPAL, evaluatedActorId: PMFREAK_ACTOR_ID } });
          const changed = db.prepare('UPDATE governance_events SET event_payload_json = ? WHERE event_type = ? AND aggregate_id = ?').run(forged, GOVERNANCE_ATTRIBUTION_EVENT_TYPE, evaluationId);
          assert.equal(changed.changes, 1);
        } finally {
          db.close();
        }
        const verification = await store.verify(SYSTEM, evaluationId);
        assert.equal(verification.valid, false, 'a promoted attribution is detected');
        assert.equal(verification.checks.eventsDigest, false);
      } finally {
        await store.close().catch(() => {});
      }
    });
  });

  describe(`G-01A — ${provider.name} Store — the Store refuses an attribution that contradicts its request`, () => {
    const request = async () => {
      const enterprise = await createEnterprise({ configuration: configuration(), kernelProviders: buildTestKernelProviders() });
      enterprises.push(enterprise);
      const kernelRequest = toKernelEvaluationRequest(body({ requestId: fresh('store') }), { now: () => '2026-01-01T00:00:00.000Z' }, { nextId: () => 'unused' });
      return { kernelRequest, result: await enterprise.kernel.evaluate(kernelRequest) };
    };
    const base = (attribution: unknown, input: Awaited<ReturnType<typeof request>>) => ({
      request: input.kernelRequest,
      result: input.result,
      receivedAt: '2026-01-01T00:00:00.000Z',
      enterpriseContext: { enterpriseVersion: 'test', lifecycleState: 'ready', modules: [] },
      events: [],
      accessContext: { system: false, organizationId: ORG, actorId: PMFREAK_ACTOR_ID },
      attribution: attribution as GovernanceEvaluationAttribution,
    });
    const valid = { version: GOVERNANCE_ATTRIBUTION_VERSION, basis: 'customer-principal', organizationId: ORG, requestingPrincipalId: PRINCIPAL, evaluatedActorId: PMFREAK_ACTOR_ID } as const;

    const refusals: readonly [string, unknown][] = [
      ['another actor', { ...valid, evaluatedActorId: OTHER_ACTOR }],
      ['another organization', { ...valid, organizationId: 'org-g01a-foreign' }],
      ['an unknown version', { ...valid, version: 'aoc.governance-attribution.v0' }],
      ['an unknown basis', { ...valid, basis: 'system' }],
      ['an extra field', { ...valid, system: true }],
      ['a principal without an id', { ...valid, requestingPrincipalId: '' }],
      ['a legacy attribution without a scope', { version: GOVERNANCE_ATTRIBUTION_VERSION, basis: 'legacy-asserted', organizationId: ORG, evaluatedActorId: PMFREAK_ACTOR_ID }],
      ['a legacy attribution carrying a principal', { version: GOVERNANCE_ATTRIBUTION_VERSION, basis: 'legacy-asserted', legacyScope: 'organization', organizationId: ORG, requestingPrincipalId: PRINCIPAL, evaluatedActorId: PMFREAK_ACTOR_ID }],
    ];
    for (const [label, attribution] of refusals) {
      it(`${label}: GOVERNANCE_STORE_VALIDATION_ERROR, nothing appended`, async () => {
        const store = await provider.open();
        try {
          await assert.rejects(store.appendEvaluation(base(attribution, await request())), (error: unknown) => (error as { code?: string }).code === 'GOVERNANCE_STORE_VALIDATION_ERROR');
          assert.equal((await store.query(SYSTEM, {})).records.length, 0);
        } finally {
          await store.close().catch(() => {});
        }
      });
    }

    it('without an attribution the aggregate is exactly what it was before G-01A', async () => {
      const store = await provider.open();
      try {
        const appended = await store.appendEvaluation({ ...base(undefined, await request()), attribution: undefined } as never);
        const record = await store.getByEvaluationId(SYSTEM, appended.evaluationId);
        assert.ok(record !== null);
        assert.equal(record.events.length, 0);
        assert.equal(readRecordedAttribution(record).status, 'unattributed');
        assert.equal((await store.verify(SYSTEM, appended.evaluationId)).valid, true);
      } finally {
        await store.close().catch(() => {});
      }
    });
  });

  describe(`G-01A — ${provider.name} Store — the governed-action path is unchanged`, () => {
    it('a customer governed action still executes, and its record carries no advisory attribution', async () => {
      const h = await harness(provider);
      const governed = await call(h, 'POST', '/api/governed-actions', CUSTOMER_KEY, { ...ALLOWED_INTENT, idempotencyKey: fresh('governed') });
      assert.equal(governed.body['status'], 'executed', governed.text);
      assert.ok(!(governed.body['reasonCodes'] as string[]).includes(R.GOVERNED_ACTION_IDEMPOTENCY_CONFLICT));
      const record = await h.raw.getByRequestId(SYSTEM, String(governed.body['requestId']));
      assert.ok(record !== null);
      assert.equal(readRecordedAttribution(record).status, 'unattributed');
      assert.equal(record.events.some((event) => event.eventType === GOVERNANCE_ATTRIBUTION_EVENT_TYPE), false);
    });
  });
}

// ---------------------------------------------------------------------------
// Replay race: a decision committed between the probe and the append.

describe('G-01A — the requester check also holds inside the append transaction', () => {
  for (const provider of PROVIDERS) {
    it(`${provider.name}: a record committed by another principal after the probe is a 409, never this caller's answer`, async () => {
      const raw = await provider.open();
      let blindProbe = false;
      const store = new Proxy(raw, {
        get(target, property, receiver) {
          const value = Reflect.get(target, property, receiver) as unknown;
          if (typeof value !== 'function') return value;
          if (property === 'resolveIdempotency' && blindProbe) return async () => ({ kind: 'new' });
          return (value as (...inner: unknown[]) => unknown).bind(target);
        },
      });
      const enterprise = await createEnterprise(await hostOptions(store));
      enterprises.push(enterprise);
      const payload = body({ requestId: fresh('race') });
      const key = fresh('race-key');
      const first = await enterprise.evaluate(payload, { authorizationHeader: `Bearer ${CUSTOMER_KEY}`, idempotencyKey: key });
      assert.equal(first.httpStatus, 200);
      blindProbe = true;
      const before = (await raw.query(SYSTEM, {})).records.length;
      await assert.rejects(
        enterprise.evaluate(payload, { authorizationHeader: `Bearer ${OTHER_CUSTOMER_KEY}`, idempotencyKey: key }),
        (error: unknown) => error instanceof EnterpriseHttpError && error.httpStatus === 409 && error.code === 'GOVERNANCE_IDEMPOTENCY_CONFLICT',
      );
      assert.equal((await raw.query(SYSTEM, {})).records.length, before, 'nothing was written');
      const own = await enterprise.evaluate(payload, { authorizationHeader: `Bearer ${CUSTOMER_KEY}`, idempotencyKey: key });
      assert.equal(own.body.governanceRecord?.evaluationId, first.body.governanceRecord?.evaluationId, 'the committing principal still replays inside the transaction');
    });
  }
});

// ---------------------------------------------------------------------------
// Legacy-key mode and the Host's configuration.

describe('G-01A — legacy keys: restricted by default in secure profiles, compat only by explicit opt-in', () => {
  it('production and staging default to restricted; other profiles keep compat; an explicit mode wins', () => {
    assert.equal(loadEnterpriseConfiguration({ AOC_ENTERPRISE_ENV: 'production' }).authentication.legacyKeyMode, 'restricted');
    assert.equal(loadEnterpriseConfiguration({ AOC_ENTERPRISE_ENV: 'staging' }).authentication.legacyKeyMode, 'restricted');
    assert.equal(loadEnterpriseConfiguration({ AOC_ENTERPRISE_ENV: 'development' }).authentication.legacyKeyMode, 'compat');
    assert.equal(loadEnterpriseConfiguration({}).authentication.legacyKeyMode, 'compat');
    assert.equal(loadEnterpriseConfiguration({ AOC_ENTERPRISE_ENV: 'production', AOC_ENTERPRISE_LEGACY_KEY_MODE: 'compat' }).authentication.legacyKeyMode, 'compat');
    assert.equal(loadEnterpriseConfiguration({ AOC_ENTERPRISE_LEGACY_KEY_MODE: 'restricted' }).authentication.legacyKeyMode, 'restricted');
    assert.deepEqual(validateEnterpriseEnvironment({ AOC_ENTERPRISE_LEGACY_KEY_MODE: 'open' }), ['AOC_ENTERPRISE_LEGACY_KEY_MODE must be one of: restricted, compat.']);
  });

  for (const provider of PROVIDERS) {
    it(`${provider.name}: restricted — an unscoped key cannot evaluate; a scoped key still can`, async () => {
      const raw = await provider.open();
      const enterprise = await createEnterprise({
        ...(await hostOptions(raw, 'restricted')),
        configuration: { ...configuration('restricted'), authentication: { apiKeys: KEYS, servicePrincipals: SERVICES, legacyKeyMode: 'restricted' } },
      });
      enterprises.push(enterprise);
      await assert.rejects(
        enterprise.evaluate(buildAllowedRequestBody({ requestId: fresh('restricted-bare') }), { authorizationHeader: `Bearer ${BARE_KEY}` }),
        (error: unknown) => error instanceof EnterpriseHttpError && error.httpStatus === 403 && error.code === 'AUTHORIZATION_FAILED',
      );
      assert.equal((await raw.query(SYSTEM, {})).records.length, 0);
      const scoped = await enterprise.evaluate(body({ requestId: fresh('restricted-scoped') }), { authorizationHeader: `Bearer ${LEGACY_KEY}` });
      assert.equal(scoped.httpStatus, 200);
    });
  }

  it('without authentication (development, loopback) nothing changes: the record carries no attribution', async () => {
    const enterprise = await createEnterprise({ configuration: loadEnterpriseConfiguration({ AOC_ENTERPRISE_PERSISTENCE_PROVIDER: 'memory' }), kernelProviders: buildTestKernelProviders() });
    enterprises.push(enterprise);
    const outcome = await enterprise.evaluate(buildAllowedRequestBody({ requestId: fresh('unauthenticated') }));
    const record = await enterprise.persistence.getByRequestId(SYSTEM, outcome.body.requestId);
    assert.ok(record !== null);
    assert.equal(readRecordedAttribution(record).status, 'unattributed');
    assert.equal(record.events.length, 2, 'Requested and completion events only, as before G-01A');
  });
});

describe('G-01A — the Host parses service principals strictly and refuses unscoped keys when restricted', () => {
  const SERVICE_SECRET = 'G01A_FILE_SERVICE_SECRET_0123456789abcdef0123';
  const CUSTOMER_SECRET = 'G01A_FILE_CUSTOMER_SECRET_0123456789abcdef012';

  function file(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      version: 1,
      trustDomainId: TRUST_DOMAIN_ID,
      grantLifetimeSeconds: 300,
      customerPrincipals: [{ principalId: PRINCIPAL, externalSubject: SUBJECT, apiKeyEnv: 'G01A_CUSTOMER_KEY' }],
      servicePrincipals: [{ principalId: SERVICE_PRINCIPAL, apiKeyEnv: 'G01A_SERVICE_KEY', onBehalfOf: { actors: [PMFREAK_ACTOR_ID] } }],
      routes: [{ action: 'draft_closure_email', adapterId: 'adapter-g01a' }],
      ...overrides,
    };
  }

  function env(governed: Record<string, unknown>, overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
    const directory = mkdtempSync(join(tmpdir(), 'frontera-g01a-host-'));
    directories.push(directory);
    const path = join(directory, 'governed-actions.json');
    writeFileSync(path, JSON.stringify(governed));
    return {
      AOC_ENTERPRISE_REQUIRE_AUTH: 'true',
      AOC_ENTERPRISE_HTTP_HOST: '127.0.0.1',
      AOC_ENTERPRISE_KERNEL_AUTHORITY_ENABLED: 'true',
      AOC_ENTERPRISE_KERNEL_AUTHORITY_ORGANIZATION_ID: ORG,
      AOC_ENTERPRISE_GOVERNED_ACTIONS_FILE: path,
      G01A_CUSTOMER_KEY: CUSTOMER_SECRET,
      G01A_SERVICE_KEY: SERVICE_SECRET,
      ...overrides,
    };
  }

  function refusal(environment: Record<string, string | undefined>): EnterpriseHostConfigurationError {
    try {
      loadEnterpriseHostConfiguration(environment);
    } catch (error) {
      assert.ok(error instanceof EnterpriseHostConfigurationError, String(error));
      for (const secret of [SERVICE_SECRET, CUSTOMER_SECRET, BARE_KEY]) assert.equal(error.message.includes(secret), false, 'no refusal names a secret');
      return error;
    }
    assert.fail('the Host must refuse this configuration');
  }

  it('a valid service principal is resolved apart from every ordinary key, scoped to the served organization', () => {
    const { configuration: resolved } = loadEnterpriseHostConfiguration(env(file()));
    assert.deepEqual(resolved.authentication.servicePrincipals, [{ principalId: SERVICE_PRINCIPAL, organizationId: ORG, key: SERVICE_SECRET, onBehalfOfActors: [PMFREAK_ACTOR_ID] }]);
    assert.equal(resolved.authentication.apiKeys.some((apiKey) => apiKey.key === SERVICE_SECRET), false, 'never an ordinary API key');
  });

  const refusals: readonly [string, Record<string, unknown>, Record<string, string | undefined>, string][] = [
    ['a wildcard form (anyBoundActorInOrganization)', file({ servicePrincipals: [{ principalId: SERVICE_PRINCIPAL, apiKeyEnv: 'G01A_SERVICE_KEY', onBehalfOf: { anyBoundActorInOrganization: true } }] }), {}, 'HOST_GOVERNED_ACTIONS_FILE_INVALID'],
    ['a wildcard actor', file({ servicePrincipals: [{ principalId: SERVICE_PRINCIPAL, apiKeyEnv: 'G01A_SERVICE_KEY', onBehalfOf: { actors: ['*'] } }] }), {}, 'HOST_SERVICE_PRINCIPAL_INVALID'],
    ['an empty allow-list', file({ servicePrincipals: [{ principalId: SERVICE_PRINCIPAL, apiKeyEnv: 'G01A_SERVICE_KEY', onBehalfOf: { actors: [] } }] }), {}, 'HOST_SERVICE_PRINCIPAL_INVALID'],
    ['an organization of its own', file({ servicePrincipals: [{ principalId: SERVICE_PRINCIPAL, apiKeyEnv: 'G01A_SERVICE_KEY', organizationId: 'org-other', onBehalfOf: { actors: [PMFREAK_ACTOR_ID] } }] }), {}, 'HOST_GOVERNED_ACTIONS_FILE_INVALID'],
    ['a system flag', file({ servicePrincipals: [{ principalId: SERVICE_PRINCIPAL, apiKeyEnv: 'G01A_SERVICE_KEY', system: true, onBehalfOf: { actors: [PMFREAK_ACTOR_ID] } }] }), {}, 'HOST_GOVERNED_ACTIONS_FILE_INVALID'],
    ['a principal id shared with a customer principal', file({ servicePrincipals: [{ principalId: PRINCIPAL, apiKeyEnv: 'G01A_SERVICE_KEY', onBehalfOf: { actors: [PMFREAK_ACTOR_ID] } }] }), {}, 'HOST_SERVICE_PRINCIPAL_INVALID'],
    ['an operator-issued agent principal id', file({ servicePrincipals: [{ principalId: 'agent:g01a', apiKeyEnv: 'G01A_SERVICE_KEY', onBehalfOf: { actors: [PMFREAK_ACTOR_ID] } }] }), {}, 'HOST_SERVICE_PRINCIPAL_INVALID'],
    ['a short secret', file(), { G01A_SERVICE_KEY: 'short' }, 'HOST_SERVICE_PRINCIPAL_INVALID'],
    ['an inline secret', file({ servicePrincipals: [{ principalId: SERVICE_PRINCIPAL, apiKey: SERVICE_SECRET, onBehalfOf: { actors: [PMFREAK_ACTOR_ID] } }] }), {}, 'HOST_GOVERNED_ACTIONS_FILE_INVALID'],
    ['a secret shared with a customer principal', file(), { G01A_SERVICE_KEY: CUSTOMER_SECRET }, 'HOST_CREDENTIALS_AMBIGUOUS'],
    ['a secret shared with a legacy key', file(), { AOC_ENTERPRISE_API_KEYS: `${SERVICE_SECRET}:${ORG}` }, 'HOST_CREDENTIALS_AMBIGUOUS'],
    ['an unscoped legacy key while restricted', file(), { AOC_ENTERPRISE_API_KEYS: BARE_KEY, AOC_ENTERPRISE_LEGACY_KEY_MODE: 'restricted' }, 'HOST_LEGACY_KEY_UNSCOPED'],
  ];
  for (const [label, governed, overrides, code] of refusals) {
    it(`${label} → ${code}`, () => {
      assert.equal(refusal(env(governed, overrides)).code, code);
    });
  }

  it('compat stays available: an unscoped key is accepted only where compat is in force', () => {
    const { configuration: resolved } = loadEnterpriseHostConfiguration(env(file(), { AOC_ENTERPRISE_API_KEYS: BARE_KEY }));
    assert.equal(resolved.authentication.legacyKeyMode, 'compat');
    assert.equal(resolved.authentication.apiKeys.some((apiKey) => apiKey.key === BARE_KEY), true);
  });

  function secureEnvironment(overrides: Record<string, string | undefined>): Record<string, string | undefined> {
    const { publicKey } = generateKeyPairSync('ed25519');
    const directory = mkdtempSync(join(tmpdir(), 'frontera-g01a-secure-'));
    directories.push(directory);
    return env(file(), {
      AOC_ENTERPRISE_ENV: 'production',
      AOC_ENTERPRISE_PERSISTENCE_PROVIDER: 'sqlite',
      AOC_ENTERPRISE_KERNEL_AUTHORITY_REQUIRED: 'true',
      AOC_ENTERPRISE_SQLITE_PATH: join(directory, 'governance.sqlite'),
      ...authorityAuthenticityEnv(),
      ...freshnessEnv({ endpoint: 'http://127.0.0.1:9', witnessId: 'witness-g01a', publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString() }),
      ...overrides,
    });
  }

  it('production: an unscoped key refuses startup by default (no implicit cross-organization system access); a scoped key is accepted', () => {
    assert.equal(refusal(secureEnvironment({ AOC_ENTERPRISE_API_KEYS: BARE_KEY })).code, 'HOST_LEGACY_KEY_UNSCOPED');
    const scoped = loadEnterpriseHostConfiguration(secureEnvironment({ AOC_ENTERPRISE_API_KEYS: `${LEGACY_KEY}:${ORG}` }));
    assert.equal(scoped.configuration.authentication.legacyKeyMode, 'restricted');
  });

  it('production: compat is an explicit opt-in, never implied', () => {
    const opted = loadEnterpriseHostConfiguration(secureEnvironment({ AOC_ENTERPRISE_API_KEYS: BARE_KEY, AOC_ENTERPRISE_LEGACY_KEY_MODE: 'compat' }));
    assert.equal(opted.configuration.authentication.legacyKeyMode, 'compat');
  });
});

describe('G-01A — composition holds an embedder to the Host’s service-principal rules (one shared validator)', () => {
  const SECRET = 'G01A_COMPOSITION_SERVICE_SECRET_000000000';
  const ADMIN_SECRET = 'G01A_COMPOSITION_ADMIN_SECRET_00000000000';
  const OPERATOR_SECRET = 'G01A_COMPOSITION_OPERATOR_SECRET_0000000';
  const administration = { administrators: [{ operatorId: 'ops-admin-g01a', key: ADMIN_SECRET }], operators: [{ operatorId: 'ops-observer-g01a', role: 'observer', key: OPERATOR_SECRET }] };
  const valid: EnterpriseServicePrincipal = { principalId: 'svc-x', organizationId: ORG, key: SECRET, onBehalfOfActors: [PMFREAK_ACTOR_ID] };
  const variants: readonly [string, EnterpriseServicePrincipal][] = [
    ['another organization', { ...valid, organizationId: 'org-other' }],
    ['an empty allow-list', { ...valid, onBehalfOfActors: [] }],
    ['a wildcard actor', { ...valid, onBehalfOfActors: ['*'] }],
    ['a duplicated actor', { ...valid, onBehalfOfActors: [PMFREAK_ACTOR_ID, PMFREAK_ACTOR_ID] }],
    ['a secret shared with an API key', { ...valid, key: LEGACY_KEY }],
    ['a secret shared with an administrator', { ...valid, key: ADMIN_SECRET }],
    ['a secret shared with an operator', { ...valid, key: OPERATOR_SECRET }],
    ['a short secret', { ...valid, key: 'short-secret' }],
    ['a secret with surrounding whitespace', { ...valid, key: ` ${SECRET}` }],
    ['a customer principal id', { ...valid, principalId: PRINCIPAL }],
    ['an operator id', { ...valid, principalId: 'ops-observer-g01a' }],
    ['an administrator id', { ...valid, principalId: 'ops-admin-g01a' }],
    ['the reserved agent: prefix', { ...valid, principalId: 'agent:g01a' }],
    ['a malformed principal id', { ...valid, principalId: ' svc-x' }],
  ];
  for (const [label, servicePrincipal] of variants) {
    it(`${label} is refused before anything is composed`, async () => {
      const base = configuration();
      await assert.rejects(
        createEnterprise({ configuration: { ...base, administration, authentication: { ...base.authentication, servicePrincipals: [servicePrincipal] } }, kernelProviders: buildTestKernelProviders() }),
        (error: unknown) => error instanceof ServicePrincipalConfigurationError && !error.message.includes(SECRET) && !error.message.includes(ADMIN_SECRET) && !error.message.includes(OPERATOR_SECRET),
      );
    });
  }

  it('two service principals sharing one id or one secret are refused', async () => {
    const base = configuration();
    for (const second of [{ ...valid, key: 'G01A_COMPOSITION_SERVICE_SECRET_111111111' }, { ...valid, principalId: 'svc-y' }]) {
      await assert.rejects(
        createEnterprise({ configuration: { ...base, authentication: { ...base.authentication, servicePrincipals: [valid, second] } }, kernelProviders: buildTestKernelProviders() }),
        (error: unknown) => error instanceof ServicePrincipalConfigurationError,
      );
    }
  });
});

describe('G-01A — composition enforces the restricted legacy-key mode for embedders too', () => {
  it('a programmatic production configuration with an unscoped key is refused — restricted is the default, not a Host-loader feature', async () => {
    const fromEnvironment = loadEnterpriseConfiguration({ AOC_ENTERPRISE_ENV: 'production', AOC_ENTERPRISE_PERSISTENCE_PROVIDER: 'memory', AOC_ENTERPRISE_REQUIRE_AUTH: 'true', AOC_ENTERPRISE_API_KEYS: BARE_KEY, AOC_ENTERPRISE_KERNEL_AUTHORITY_ORGANIZATION_ID: ORG });
    await assert.rejects(createEnterprise({ configuration: fromEnvironment, kernelProviders: buildTestKernelProviders() }), (error: unknown) => error instanceof LegacyKeyConfigurationError && !error.message.includes(BARE_KEY));

    // A hand-built configuration that never states a mode: the environment's default applies.
    const base = configuration();
    for (const environment of ['production', 'staging'] as const) {
      await assert.rejects(
        createEnterprise({ configuration: { ...base, environment, authentication: { apiKeys: [{ key: BARE_KEY }] } }, kernelProviders: buildTestKernelProviders() }),
        (error: unknown) => error instanceof LegacyKeyConfigurationError,
      );
    }
    await assert.rejects(
      createEnterprise({ configuration: { ...base, authentication: { apiKeys: [{ key: BARE_KEY }], legacyKeyMode: 'restricted' } }, kernelProviders: buildTestKernelProviders() }),
      (error: unknown) => error instanceof LegacyKeyConfigurationError,
    );
  });

  it('compat stays an explicit, working opt-in; a development configuration keeps its v1 default', async () => {
    const base = configuration();
    const explicit = await createEnterprise({ configuration: { ...base, environment: 'production', authentication: { apiKeys: [{ key: BARE_KEY }], legacyKeyMode: 'compat' } }, kernelProviders: buildTestKernelProviders() });
    enterprises.push(explicit);
    const development = await createEnterprise({ configuration: { ...base, authentication: { apiKeys: [{ key: BARE_KEY }] } }, kernelProviders: buildTestKernelProviders() });
    enterprises.push(development);
    const outcome = await development.evaluate(buildAllowedRequestBody({ requestId: fresh('dev-compat') }), { authorizationHeader: `Bearer ${BARE_KEY}` });
    assert.equal(outcome.httpStatus, 200);
  });

  it('an empty organization on a key is malformed, never unscoped: evaluate refuses it, and restricted refuses it at startup', async () => {
    const base = configuration();
    const compat = await createEnterprise({ configuration: { ...base, authentication: { apiKeys: [{ key: BARE_KEY, organizationId: '' }], legacyKeyMode: 'compat' } }, kernelProviders: buildTestKernelProviders() });
    enterprises.push(compat);
    await assert.rejects(
      compat.evaluate(buildAllowedRequestBody({ requestId: fresh('empty-org') }), { authorizationHeader: `Bearer ${BARE_KEY}` }),
      (error: unknown) => error instanceof EnterpriseHttpError && error.httpStatus === 403,
    );
    await assert.rejects(
      createEnterprise({ configuration: { ...base, authentication: { apiKeys: [{ key: BARE_KEY, organizationId: '' }], legacyKeyMode: 'restricted' } }, kernelProviders: buildTestKernelProviders() }),
      (error: unknown) => error instanceof LegacyKeyConfigurationError,
    );
  });
});

describe('G-01A — a replay signal without its record fails closed', () => {
  for (const provider of PROVIDERS) {
    for (const where of ['pre-evaluation probe', 'append transaction'] as const) {
      it(`${provider.name}, ${where}: an injected Store that signals a replay but returns no record is an integrity error — never a replay, never a fresh commit`, async () => {
        const raw = await provider.open();
        const store = new Proxy(raw, {
          get(target, property, receiver) {
            const value = Reflect.get(target, property, receiver) as unknown;
            if (typeof value !== 'function') return value;
            if (property === 'resolveIdempotency') return async () => (where === 'pre-evaluation probe' ? { kind: 'replay', record: undefined } : { kind: 'new' });
            if (property === 'appendEvaluation' && where === 'append transaction') {
              return async () => ({ evaluationId: 'gov-evaluation-foreign', decisionId: 'decision-foreign', requestId: 'foreign', created: false, idempotentReplay: true, aggregateDigest: `sha256:${'0'.repeat(64)}`, persistedAt: '2026-01-01T00:00:00.000Z' });
            }
            return (value as (...inner: unknown[]) => unknown).bind(target);
          },
        });
        const enterprise = await createEnterprise(await hostOptions(store));
        enterprises.push(enterprise);
        const published: EnterpriseEvent[] = [];
        const unsubscribe = enterprise.eventPublisher.subscribe((event) => published.push(event));
        try {
          for (const secret of [CUSTOMER_KEY, SERVICE_KEY, LEGACY_KEY]) {
            await assert.rejects(
              enterprise.evaluate(body({ requestId: fresh(`no-record-${where.length}`) }), { authorizationHeader: `Bearer ${secret}`, idempotencyKey: fresh('no-record-key') }),
              (error: unknown) => error instanceof EnterpriseHttpError && error.httpStatus === 500 && error.code === 'GOVERNANCE_RECORD_CORRUPTED' && !error.message.includes('foreign'),
            );
          }
        } finally {
          unsubscribe();
        }
        assert.equal((await raw.query(SYSTEM, {})).records.length, 0, 'nothing was written');
        assert.equal(published.some((event) => event.type === 'GovernanceRecordCommitted' || event.type === 'GovernanceEvaluationCompleted'), false, 'no commit or completion was announced');
      });
    }
  }
});

describe('G-01A — the replay rule, stated directly', () => {
  const customer = { version: GOVERNANCE_ATTRIBUTION_VERSION, basis: 'customer-principal', organizationId: ORG, requestingPrincipalId: PRINCIPAL, evaluatedActorId: PMFREAK_ACTOR_ID } as const;
  const legacy = { version: GOVERNANCE_ATTRIBUTION_VERSION, basis: 'legacy-asserted', legacyScope: 'organization', organizationId: ORG, evaluatedActorId: PMFREAK_ACTOR_ID } as const;

  function recordWith(events: GovernanceRecord['events']): GovernanceRecord {
    return { request: { actorId: PMFREAK_ACTOR_ID, organizationId: ORG }, events } as unknown as GovernanceRecord;
  }
  function sealed(attribution: unknown): GovernanceRecord['events'][number] {
    return { eventType: GOVERNANCE_ATTRIBUTION_EVENT_TYPE, eventContract: 'aoc.governance-event-record.v1', eventPayload: { attribution } } as unknown as GovernanceRecord['events'][number];
  }

  it('same requester replays; any other basis, principal or scope does not', () => {
    assert.equal(sameRequester(customer, customer), true);
    assert.equal(sameRequester(customer, { ...customer, requestingPrincipalId: OTHER_PRINCIPAL }), false);
    assert.equal(sameRequester(customer, { ...customer, basis: 'service-principal' }), false);
    assert.equal(sameRequester(legacy, { ...legacy, legacyScope: 'unscoped' }), false);
    assert.equal(sameRequester(customer, legacy), false);
  });

  it('an unattributed record answers only a legacy or unauthenticated caller', () => {
    const historical = recordWith([]);
    assert.equal(mayReplayTo(historical, undefined), true);
    assert.equal(mayReplayTo(historical, legacy), true);
    assert.equal(mayReplayTo(historical, customer), false);
    assert.equal(mayReplayTo(historical, { ...customer, basis: 'service-principal' }), false);
  });

  it('an attributed record never answers an unauthenticated caller, and an unreadable one answers no one', () => {
    assert.equal(mayReplayTo(recordWith([sealed(customer)]), undefined), false);
    assert.equal(mayReplayTo(recordWith([sealed(customer)]), customer), true);
    assert.equal(mayReplayTo(recordWith([sealed(customer), sealed(customer)]), customer), false, 'two attributions are unreadable');
    assert.equal(mayReplayTo(recordWith([sealed({ ...customer, evaluatedActorId: OTHER_ACTOR })]), { ...customer, evaluatedActorId: OTHER_ACTOR }), false, 'an attribution contradicting its request is unreadable');
    assert.equal(mayReplayTo(recordWith([sealed({ ...customer, version: 'v0' })]), customer), false);
  });
});
