import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';

import Database from 'better-sqlite3';

import { createInMemoryEmergencyControlStore } from '../../features/emergency-control-runtime/index.js';
import { createRecordingExecutionAdapter } from '../../features/execution-runtime/tests/execution-fixture.js';
import type { ValidatedExecutionAction } from '../../features/execution-runtime/index.js';
import { createInMemoryBoundedGrantStore } from '../../features/grant-runtime/index.js';
import type { KernelEvaluationRequest, KernelEvaluationResult } from '../../kernel/index.js';
import { KernelGrantCapability } from '../../kernel/orchestration/grant-adapter.js';
import type { GovernanceEvaluateRequestBody } from '../api/governance-evaluate-contract.js';
import { createAssuranceEvidenceResolver } from '../assurance/evidence-resolver.js';
import type { AssuranceScope } from '../assurance/contracts.js';
import { createEnterprise, type AocEnterprise, type CreateEnterpriseOptions } from '../composition/composition-root.js';
import { loadEnterpriseConfiguration, type EnterpriseApiKey, type EnterpriseConfiguration, type EnterpriseServicePrincipal } from '../configuration/enterprise-configuration.js';
import { EvidenceError } from '../evidence/errors.js';
import { createSqliteEvidenceStore } from '../evidence/sqlite-evidence-store.js';
import type { EnterpriseEvent } from '../events/enterprise-events.js';
import { createInMemoryExecutionOutcomeStore } from '../execution-outcome-store/index.js';
import { readRecordedAttribution } from '../governance-store/attribution.js';
import {
  GOVERNANCE_ATTRIBUTION_EVENT_TYPE,
  GOVERNANCE_ATTRIBUTION_VERSION,
  type AppendGovernanceEvaluationInput,
  type GovernanceEvaluationAttribution,
  type GovernanceRecord,
  type GovernanceStoreAccessContext,
} from '../governance-store/contracts.js';
import { GovernanceStoreError } from '../governance-store/errors.js';
import type { GovernanceStore } from '../governance-store/governance-store.js';
import { hasGovernedActionProvenance } from '../governance-store/governed-provenance.js';
import { createInMemoryGovernanceStore } from '../governance-store/in-memory-governance-store.js';
import { createSqliteGovernanceStore } from '../governance-store/sqlite-governance-store.js';
import { createEnterpriseServer, type EnterpriseServer } from '../host/enterprise-server.js';
import { EnterpriseHostConfigurationError, loadEnterpriseHostConfiguration } from '../host/host-configuration.js';
import { createInMemoryKernelAuthorityStore } from '../kernel-authority/in-memory-kernel-authority-store.js';
import { createKernelAuthorityProvisioningService } from '../kernel-authority/provisioning-service.js';
import { AgentPassportError } from '../passport/errors.js';
import { deriveGovernedActionRequestId } from '../governed-action/index.js';
import { ALLOWED_INTENT, EVALUATED_AT_POLICY, NO_TEMPORAL_BOUND, ORG, PMFREAK_ACTOR_ID, TRUST_DOMAIN_ID } from './governed-action-support.js';
import { buildAllowedRequestBody, buildTestKernelProviders } from './support.js';

/**
 * G-01C — cross-surface security qualification of the single-organization
 * secure Enterprise Host (G-01B0 + G-01A + G-01B1 composed).
 *
 * The suite is organized by what each case is evidence of:
 *
 * 1. **Existing guarantees** — expected to pass on the merged baseline.
 * 2. **Confirmed vulnerabilities** — each fails on the merged baseline and is
 *    fixed in this milestone (the tests-only commit records the failures).
 * 3. **Accepted limitations** — characterized as they are, documented in
 *    `docs/security/G-01C-SECURITY-QUALIFICATION.md`; they pass today and a
 *    change to them is a founder decision.
 * 4. **Hypotheses** — marked TODO: CI records whether they reproduce without
 *    failing the suite. Nothing in production code depends on them.
 *
 * Nothing here claims multi-organization isolation: the store-wide request-id
 * oracle (P2-1) stands until G-01B2.
 */

const run = promisify(execFile);

const SUBJECT = { system: 'datasys-app', subjectId: 'user-pmfreak' } as const;
const PRINCIPAL = 'principal-g01c';
const OTHER_PRINCIPAL = 'principal-g01c-other';
const SERVICE_PRINCIPAL = 'svc-g01c';
const FOREIGN_ORG = 'org-g01c-foreign';
const ATTACKER_TRUST_DOMAIN = 'trust-domain-g01c-attacker';
const NOW = '2026-01-01T00:00:00.000Z';

const CUSTOMER_KEY = 'G01C_CUSTOMER_KEY_SENTINEL_0123456789abcdef';
const OTHER_CUSTOMER_KEY = 'G01C_OTHER_CUSTOMER_KEY_SENTINEL_012345678';
const LEGACY_KEY = 'G01C_LEGACY_SCOPED_KEY_SENTINEL_0123456789';
const FOREIGN_LEGACY_KEY = 'G01C_FOREIGN_SCOPED_KEY_SENTINEL_012345678';
const BARE_KEY = 'G01C_LEGACY_BARE_KEY_SENTINEL_0123456789ab';
const SERVICE_KEY = 'G01C_SERVICE_KEY_SENTINEL_0123456789abcdef';

const KEYS: readonly EnterpriseApiKey[] = [
  { key: CUSTOMER_KEY, organizationId: ORG, customerIdentity: { principalId: PRINCIPAL, externalSubject: SUBJECT } },
  // A second principal bound to the same subject, so to the same actor.
  { key: OTHER_CUSTOMER_KEY, organizationId: ORG, customerIdentity: { principalId: OTHER_PRINCIPAL, externalSubject: SUBJECT } },
  { key: LEGACY_KEY, organizationId: ORG },
  { key: BARE_KEY },
];

const SERVICES: readonly EnterpriseServicePrincipal[] = [{ principalId: SERVICE_PRINCIPAL, organizationId: ORG, key: SERVICE_KEY, onBehalfOfActors: [PMFREAK_ACTOR_ID] }];

const SYSTEM: GovernanceStoreAccessContext = { system: true };
const TENANT: GovernanceStoreAccessContext = { system: false, organizationId: ORG };
const FOREIGN_TENANT: GovernanceStoreAccessContext = { system: false, organizationId: FOREIGN_ORG };

let sequence = 0;
const fresh = (label: string): string => `g01c-${label}-${(sequence += 1)}`;

const directories: string[] = [];
const servers: EnterpriseServer[] = [];
const enterprises: AocEnterprise[] = [];
const stores: GovernanceStore[] = [];
after(async () => {
  await Promise.all(servers.map((server) => server.close().catch(() => {})));
  await Promise.all(enterprises.map((enterprise) => enterprise.close().catch(() => {})));
  for (const store of stores) await store.close().catch(() => {});
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

function workDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'frontera-g01c-'));
  directories.push(directory);
  return directory;
}

function body(overrides: Partial<GovernanceEvaluateRequestBody> = {}): GovernanceEvaluateRequestBody {
  return buildAllowedRequestBody({ organization: { id: ORG }, ...overrides });
}

function configuration(legacyKeyMode: 'compat' | 'restricted' = 'restricted'): EnterpriseConfiguration {
  const base = loadEnterpriseConfiguration({
    AOC_ENTERPRISE_PERSISTENCE_PROVIDER: 'memory',
    AOC_ENTERPRISE_KERNEL_AUTHORITY_ORGANIZATION_ID: ORG,
    AOC_ENTERPRISE_HTTP_PORT: '0',
    AOC_ENTERPRISE_HTTP_HOST: '127.0.0.1',
    AOC_ENTERPRISE_REQUIRE_AUTH: 'true',
    AOC_ENTERPRISE_LOG_LEVEL: 'error',
  });
  const apiKeys = legacyKeyMode === 'restricted' ? KEYS.filter((apiKey) => apiKey.key !== BARE_KEY) : KEYS;
  return { ...base, authentication: { apiKeys, servicePrincipals: SERVICES, legacyKeyMode } };
}

/** The G-01A composed Host: customer admission, governed actions, service principals. */
async function hostOptions(persistence: GovernanceStore, legacyKeyMode: 'compat' | 'restricted' = 'restricted'): Promise<CreateEnterpriseOptions> {
  const authority = createInMemoryKernelAuthorityStore();
  await createKernelAuthorityProvisioningService({ store: authority, organizationId: ORG }).provisionActor(
    { system: true, actorId: 'operator-g01c' },
    { actorId: PMFREAK_ACTOR_ID, type: 'agent', displayName: 'PMFreak', externalSubject: SUBJECT },
  );
  const inner = createRecordingExecutionAdapter(async () => ({ outcome: 'completed', providerRef: 'provider-ref-g01c' }));
  return {
    configuration: configuration(legacyKeyMode),
    kernelProviders: buildTestKernelProviders(),
    kernelAuthorityStore: authority,
    persistence,
    customerIdentityAdmission: { enabled: true },
    authorityControlledExecution: {
      grantCapability: new KernelGrantCapability({ declaration: {} }),
      grantStore: createInMemoryBoundedGrantStore(),
      executionAdapterRouting: { adapters: [{ adapterId: 'adapter-g01c', execute: (action: ValidatedExecutionAction) => inner.execute(action) }], selectAdapter: () => 'adapter-g01c' },
      resolveAuthorityBinding: () => NO_TEMPORAL_BOUND,
    },
    governedActionOrchestrator: { enabled: true, trustDomainId: TRUST_DOMAIN_ID, grantPolicy: EVALUATED_AT_POLICY },
    monetary: { assets: [{ assetId: 'USD', scale: 2 }], financialActions: [] },
    emergencyControl: { enabled: true, store: createInMemoryEmergencyControlStore() },
    executionOutcomes: { store: createInMemoryExecutionOutcomeStore({ now: () => new Date().toISOString() }) },
  };
}

interface Harness {
  readonly enterprise: AocEnterprise;
  readonly server: EnterpriseServer;
  readonly raw: GovernanceStore;
  readonly baseUrl: string;
}

async function harness(raw: GovernanceStore, legacyKeyMode: 'compat' | 'restricted' = 'restricted'): Promise<Harness> {
  const server = await createEnterpriseServer(await hostOptions(raw, legacyKeyMode));
  servers.push(server);
  const { port } = await server.listen();
  return { enterprise: server.enterprise, server, raw, baseUrl: `http://127.0.0.1:${port}` };
}

interface Reply {
  readonly status: number;
  readonly text: string;
  readonly body: Record<string, unknown>;
}

async function call(baseUrl: string, method: string, path: string, secret: string | undefined, payload?: unknown, headers: Record<string, string> = {}): Promise<Reply> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(secret !== undefined ? { authorization: `Bearer ${secret}` } : {}), ...headers },
    ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
  });
  const text = await response.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    parsed = {};
  }
  return { status: response.status, text, body: parsed };
}

const evaluate = (h: Harness, secret: string | undefined, payload: unknown, idempotencyKey?: string): Promise<Reply> =>
  call(h.baseUrl, 'POST', '/api/governance/evaluate', secret, payload, idempotencyKey !== undefined ? { 'idempotency-key': idempotencyKey } : {});

const errorCode = (reply: Reply): unknown => (reply.body['error'] as Record<string, unknown> | undefined)?.['code'];
const evaluationIdOf = (reply: Reply): string => String((reply.body['governanceRecord'] as Record<string, unknown> | undefined)?.['evaluationId']);

async function refusedWith(status: number, pending: Promise<unknown>): Promise<boolean> {
  try {
    await pending;
    return false;
  } catch (error) {
    return (error as { httpStatus?: unknown }).httpStatus === status;
  }
}

const isStoreError = (code: string) => (error: unknown): boolean => error instanceof GovernanceStoreError && error.code === code;

/** A Governance Store append, built directly: the in-process embedder surface (`AocEnterprise.persistence`). */
function appendInput(requestId: string, overrides: Partial<AppendGovernanceEvaluationInput> = {}, organizationId = ORG): AppendGovernanceEvaluationInput {
  const decisionId = `${requestId}-decision`;
  const request: KernelEvaluationRequest = {
    requestId,
    actor: { id: PMFREAK_ACTOR_ID, trustDomainId: TRUST_DOMAIN_ID },
    action: { type: 'draft_closure_email', resourceScope: 'project:closure' },
    organization: { id: organizationId },
    requestedAt: NOW,
  };
  const result = {
    requestId,
    decisionId,
    status: 'allowed',
    reasonCodes: ['OK'],
    summary: 'fine',
    recognition: { performed: true },
    authority: { performed: false },
    policies: [],
    approval: { performed: false, status: 'not_applicable' },
    evidence: [],
    trace: { steps: [{ sequence: 1, operator: 'recognition', status: 'passed', reasonCodes: ['OK'] }], decisionId, kernelVersion: '1.0.0' },
    evaluatedAt: NOW,
    kernelVersion: '1.0.0',
  } as KernelEvaluationResult;
  return {
    request,
    result,
    receivedAt: NOW,
    enterpriseContext: { enterpriseVersion: 'g01c', lifecycleState: 'ready', modules: [] },
    events: [{ eventId: `evt-${requestId}`, type: 'GovernanceEvaluationRequested', occurredAt: NOW, requestId } as unknown as EnterpriseEvent],
    accessContext: { system: true, organizationId, actorId: PMFREAK_ACTOR_ID },
    ...overrides,
  };
}

const PROVIDERS: readonly { readonly name: string; readonly open: () => Promise<GovernanceStore> }[] = [
  { name: 'in-memory', open: async () => createInMemoryGovernanceStore() },
  { name: 'sqlite', open: async () => createSqliteGovernanceStore(':memory:') },
];

// ===========================================================================
// 1. Existing guarantees — expected to pass on the merged baseline.

for (const provider of PROVIDERS) {
  describe(`G-01C §1 — ${provider.name} Store — concurrent requesters never receive each other's decision (T6, SEC-INV-342)`, () => {
    it('two principals racing one request id: exactly one commits, the other is the request-id 409 carrying nothing of the winner', async () => {
      const h = await harness(await provider.open());
      for (let round = 0; round < 4; round += 1) {
        const payload = body({ requestId: fresh('race-request-id') });
        const replies = await Promise.all([evaluate(h, CUSTOMER_KEY, payload), evaluate(h, OTHER_CUSTOMER_KEY, payload)]);
        const won = replies.filter((reply) => reply.status === 200);
        const lost = replies.filter((reply) => reply.status !== 200);
        assert.equal(won.length, 1, replies.map((reply) => reply.text).join(' | '));
        assert.equal(lost.length, 1);
        const winner = won[0];
        const loser = lost[0];
        assert.ok(winner !== undefined && loser !== undefined);
        assert.equal(loser.status, 409, loser.text);
        assert.equal(errorCode(loser), 'CONCURRENCY_CONFLICT', loser.text);
        assert.equal(loser.text.includes(evaluationIdOf(winner)), false, 'the loser learns nothing of the committed record');
        assert.equal(loser.text.includes(String(winner.body['decisionId'])), false);
      }
    });

    it('a legacy key and a principal racing one Idempotency-Key with one payload: one commits, the other is refused, never replayed', async () => {
      const h = await harness(await provider.open());
      for (let round = 0; round < 4; round += 1) {
        const payload = body({ requestId: fresh('race-key') });
        const key = fresh('race-key-idempotency');
        const replies = await Promise.all([evaluate(h, CUSTOMER_KEY, payload, key), evaluate(h, LEGACY_KEY, payload, key)]);
        const won = replies.filter((reply) => reply.status === 200);
        const lost = replies.filter((reply) => reply.status !== 200);
        assert.equal(won.length, 1, replies.map((reply) => reply.text).join(' | '));
        const winner = won[0];
        const loser = lost[0];
        assert.ok(winner !== undefined && loser !== undefined);
        assert.equal(loser.status, 409, loser.text);
        assert.ok(['GOVERNANCE_IDEMPOTENCY_CONFLICT', 'CONCURRENCY_CONFLICT'].includes(String(errorCode(loser))), loser.text);
        assert.equal(loser.text.includes(evaluationIdOf(winner)), false);
      }
    });
  });

  describe(`G-01C §1 — ${provider.name} Store — a service principal reaches the advisory evaluate route only (T10, SEC-INV-339)`, () => {
    const routes: readonly (readonly [string, string, unknown])[] = [
      ['POST', '/api/governed-actions', { ...ALLOWED_INTENT, idempotencyKey: 'g01c-service' }],
      ['GET', '/api/governance/requests/g01c-anything', undefined],
      ['POST', '/api/evidence/build', { evaluationId: 'g01c-anything', level: 'PUBLIC' }],
      ['POST', '/api/passports', { subject: { agentId: PMFREAK_ACTOR_ID, agentType: 'autonomous_agent' }, organization: { organizationId: ORG, recognizedBy: 'registry' }, actorId: 'user-g01c' }],
      ['POST', '/api/passports/passport-g01c/governance', { reference: {}, actorId: 'user-g01c' }],
      ['GET', '/api/assurance/assessments', undefined],
      ['POST', '/api/assurance/assessments', {}],
    ];

    let pending: Promise<Harness> | undefined;
    const ready = (): Promise<Harness> => (pending ??= provider.open().then((raw) => harness(raw)));

    it('the service secret evaluates for an allow-listed actor', async () => {
      const h = await ready();
      const reply = await evaluate(h, SERVICE_KEY, body({ requestId: fresh('service') }));
      assert.equal(reply.status, 200, reply.text);
    });

    for (const [method, path, payload] of routes) {
      it(`${method} ${path} with the service secret is 401 and writes nothing`, async () => {
        const h = await ready();
        const before = (await h.raw.query(SYSTEM, { limit: 100 })).records.length;
        const reply = await call(h.baseUrl, method, path, SERVICE_KEY, payload);
        assert.equal(reply.status, 401, `${method} ${path}: ${reply.text}`);
        assert.equal(reply.text.includes(SERVICE_KEY), false);
        assert.equal((await h.raw.query(SYSTEM, { limit: 100 })).records.length, before);
      });
    }
  });
}

describe('G-01C §1 — SQLite — attribution, replay and governed provenance survive a restart (T8)', () => {
  it('a reopened Store replays to the same principal only, keeps the sealed attribution, and resolves provenance identically', async () => {
    const path = join(workDir(), 'restart.sqlite');
    const payload = body({ requestId: fresh('restart') });
    const key = fresh('restart-key');

    const first = await createSqliteGovernanceStore(path);
    const before = await harness(first);
    const committed = await evaluate(before, CUSTOMER_KEY, payload, key);
    assert.equal(committed.status, 200, committed.text);
    const governedKey = fresh('restart-governed');
    const governedReply = await call(before.baseUrl, 'POST', '/api/governed-actions', CUSTOMER_KEY, { ...ALLOWED_INTENT, idempotencyKey: governedKey });
    const governedRequestId = deriveGovernedActionRequestId({ organizationId: ORG, principalId: PRINCIPAL, idempotencyKey: governedKey });
    assert.ok((await first.getByRequestId(SYSTEM, governedRequestId)) !== null, `the governed path committed its record: ${governedReply.status} ${governedReply.text}`);
    await before.server.close();
    await first.close();

    const second = await createSqliteGovernanceStore(path);
    stores.push(second);
    const restarted = await harness(second);
    const replayed = await evaluate(restarted, CUSTOMER_KEY, payload, key);
    assert.equal(replayed.status, 200, replayed.text);
    assert.equal(evaluationIdOf(replayed), evaluationIdOf(committed), 'the same requester is replayed its own decision');
    const other = await evaluate(restarted, OTHER_CUSTOMER_KEY, payload, key);
    assert.equal(other.status, 409, other.text);

    const advisory = await second.getByEvaluationId(SYSTEM, evaluationIdOf(committed));
    assert.ok(advisory !== null);
    const recorded = readRecordedAttribution(advisory);
    assert.equal(recorded.status, 'attributed');
    if (recorded.status === 'attributed') {
      assert.equal(recorded.attribution.basis, 'customer-principal');
      assert.equal('requestingPrincipalId' in recorded.attribution ? recorded.attribution.requestingPrincipalId : undefined, PRINCIPAL);
    }
    assert.equal((await second.verify(SYSTEM, advisory.evaluation.evaluationId)).valid, true);
    assert.equal(await hasGovernedActionProvenance(second, TENANT, advisory), false, 'an advisory record is not governed after a restart');

    const governedRecord = await second.getByRequestId(SYSTEM, governedRequestId);
    assert.ok(governedRecord !== null);
    assert.equal(await hasGovernedActionProvenance(second, TENANT, governedRecord), true, 'a governed record is still governed after a restart');
  });
});

describe('G-01C §1 — SQLite — a held write lock is a classified, atomic refusal (T7)', () => {
  it('an append under another connection’s write lock is GOVERNANCE_STORE_UNAVAILABLE, writes nothing, and succeeds once the lock is released', async (t) => {
    const path = join(workDir(), 'contention.sqlite');
    const store = await createSqliteGovernanceStore(path, { busyTimeoutMs: 1000 });
    stores.push(store);
    await store.appendEvaluation(appendInput(fresh('contention-seed')));
    const contended = fresh('contention');

    const holder = new Database(path);
    holder.exec('BEGIN IMMEDIATE');
    const started = performance.now();
    let outcome: unknown = 'committed';
    try {
      await store.appendEvaluation(appendInput(contended));
    } catch (error) {
      outcome = error;
    }
    const elapsed = performance.now() - started;
    holder.exec('ROLLBACK');
    holder.close();
    t.diagnostic(`governance append under a held write lock: ${outcome instanceof GovernanceStoreError ? outcome.code : String(outcome)} after ${elapsed.toFixed(0)} ms (busy timeout 1000 ms)`);

    assert.ok(isStoreError('GOVERNANCE_STORE_UNAVAILABLE')(outcome), `classified as unavailable, got ${String(outcome)}`);
    assert.equal(await store.getByRequestId(SYSTEM, contended), null, 'nothing of the refused append was committed');
    await store.appendEvaluation(appendInput(contended));
    assert.ok((await store.getByRequestId(SYSTEM, contended)) !== null, 'the same append commits once the lock is gone');
  });
});

describe('G-01C §1 — the Host refuses unauthenticated exposure; the trusted embedder profile does not (Decision 7)', () => {
  it('the Host loader refuses authentication off in production', () => {
    assert.throws(
      () =>
        loadEnterpriseHostConfiguration({
          AOC_ENTERPRISE_ENV: 'production',
          AOC_ENTERPRISE_PERSISTENCE_PROVIDER: 'sqlite',
          AOC_ENTERPRISE_REQUIRE_AUTH: 'false',
          AOC_ENTERPRISE_HTTP_HOST: '127.0.0.1',
          AOC_ENTERPRISE_KERNEL_AUTHORITY_ORGANIZATION_ID: ORG,
        }),
      (error: unknown) => error instanceof EnterpriseHostConfigurationError && error.code === 'HOST_AUTHENTICATION_REQUIRED',
    );
  });

  it('the Host loader refuses authentication off on a network address', () => {
    assert.throws(
      () => loadEnterpriseHostConfiguration({ AOC_ENTERPRISE_REQUIRE_AUTH: 'false', AOC_ENTERPRISE_HTTP_HOST: '0.0.0.0', AOC_ENTERPRISE_KERNEL_AUTHORITY_ORGANIZATION_ID: ORG }),
      (error: unknown) => error instanceof EnterpriseHostConfigurationError && error.code === 'HOST_UNAUTHENTICATED_NETWORK_BIND',
    );
  });

  it('accepted limitation: createEnterprise composes a production, in-memory, authentication-off configuration — the trusted-code profile', async () => {
    const enterprise = await createEnterprise({
      configuration: loadEnterpriseConfiguration({
        AOC_ENTERPRISE_ENV: 'production',
        AOC_ENTERPRISE_PERSISTENCE_PROVIDER: 'memory',
        AOC_ENTERPRISE_REQUIRE_AUTH: 'false',
        AOC_ENTERPRISE_HTTP_HOST: '0.0.0.0',
        AOC_ENTERPRISE_KERNEL_AUTHORITY_ORGANIZATION_ID: ORG,
        AOC_ENTERPRISE_LOG_LEVEL: 'error',
      }),
      kernelProviders: buildTestKernelProviders(),
    });
    enterprises.push(enterprise);
    const requestId = fresh('unauthenticated-embedder');
    const reply = await enterprise.evaluate(body({ requestId }));
    assert.equal(reply.httpStatus, 200);
    const record = await enterprise.persistence.getByRequestId(SYSTEM, requestId);
    assert.ok(record !== null);
    assert.equal(readRecordedAttribution(record).status, 'unattributed', 'no identity exists, so none is recorded');
  });
});

// ===========================================================================
// 2. Confirmed vulnerabilities — fail on the merged baseline, fixed here.

for (const provider of PROVIDERS) {
  describe(`G-01C §2 — ${provider.name} Store — attribution is sealed only from the validated field (T4, fix A)`, () => {
    const forged = (requestId: string): EnterpriseEvent =>
      ({
        eventId: `evt-forged-${requestId}`,
        type: GOVERNANCE_ATTRIBUTION_EVENT_TYPE,
        occurredAt: NOW,
        attribution: {
          version: GOVERNANCE_ATTRIBUTION_VERSION,
          basis: 'customer-principal',
          organizationId: ORG,
          requestingPrincipalId: 'principal-g01c-forged',
          evaluatedActorId: PMFREAK_ACTOR_ID,
          salt: '0123456789abcdef0123456789abcdef',
        },
      }) as unknown as EnterpriseEvent;

    it('an attribution event in the ordinary events[] input is GOVERNANCE_STORE_VALIDATION_ERROR and nothing is written', async () => {
      const store = await provider.open();
      stores.push(store);
      const requestId = fresh('injected');
      const input = appendInput(requestId);
      await assert.rejects(store.appendEvaluation({ ...input, events: [...input.events, forged(requestId)] }), isStoreError('GOVERNANCE_STORE_VALIDATION_ERROR'));
      assert.equal(await store.getByRequestId(SYSTEM, requestId), null);
    });

    it('…also when it is the only event and no attribution field is given', async () => {
      const store = await provider.open();
      stores.push(store);
      const requestId = fresh('injected-alone');
      await assert.rejects(store.appendEvaluation(appendInput(requestId, { events: [forged(requestId)] })), isStoreError('GOVERNANCE_STORE_VALIDATION_ERROR'));
      assert.equal(await store.getByRequestId(SYSTEM, requestId), null);
    });

    it('…also when an accessor shows the check a harmless type and the record the attribution type', async () => {
      const store = await provider.open();
      stores.push(store);
      const requestId = fresh('injected-accessor');
      const template = forged(requestId) as unknown as Record<string, unknown>;
      let reads = 0;
      const shifting = Object.defineProperty({ ...template }, 'type', {
        enumerable: true,
        get: () => {
          reads += 1;
          return reads === 1 ? 'GovernanceEvaluationRequested' : GOVERNANCE_ATTRIBUTION_EVENT_TYPE;
        },
      }) as unknown as EnterpriseEvent;
      let appended: { readonly evaluationId: string } | undefined;
      try {
        appended = await store.appendEvaluation(appendInput(requestId, { events: [shifting] }));
      } catch (error) {
        assert.ok(isStoreError('GOVERNANCE_STORE_VALIDATION_ERROR')(error), String(error));
      }
      if (appended !== undefined) {
        const record = await store.getByEvaluationId(SYSTEM, appended.evaluationId);
        assert.ok(record !== null);
        assert.notEqual(readRecordedAttribution(record).status, 'attributed', 'what the check saw is what was recorded');
      }
    });

    it('control: the validated attribution field still seals one readable attribution', async () => {
      const store = await provider.open();
      stores.push(store);
      const requestId = fresh('sealed');
      const attribution: GovernanceEvaluationAttribution = {
        version: GOVERNANCE_ATTRIBUTION_VERSION,
        basis: 'legacy-asserted',
        legacyScope: 'organization',
        organizationId: ORG,
        evaluatedActorId: PMFREAK_ACTOR_ID,
        salt: '0123456789abcdef0123456789abcdef',
      };
      const appended = await store.appendEvaluation(appendInput(requestId, { attribution }));
      const record = await store.getByEvaluationId(SYSTEM, appended.evaluationId);
      assert.ok(record !== null);
      assert.equal(readRecordedAttribution(record).status, 'attributed');
    });
  });
}

describe('G-01C §2 — composition serves the trust domain it validated (T5, fix B)', () => {
  it('mutating the caller’s governed-action options after composition changes no authorization on the advisory route', async () => {
    const options = await hostOptions(createInMemoryGovernanceStore());
    const enterprise = await createEnterprise(options);
    enterprises.push(enterprise);
    const live = options.governedActionOrchestrator as unknown as { trustDomainId: string };
    live.trustDomainId = ATTACKER_TRUST_DOMAIN;

    const kept = await enterprise.evaluate(body({ requestId: fresh('trust-domain-kept') }), { authorizationHeader: `Bearer ${CUSTOMER_KEY}` });
    assert.equal(kept.httpStatus, 200, 'the validated trust domain still admits its principal');
    assert.equal(
      await refusedWith(403, enterprise.evaluate(body({ requestId: fresh('trust-domain-swapped'), actor: { id: PMFREAK_ACTOR_ID, trustDomainId: ATTACKER_TRUST_DOMAIN } }), { authorizationHeader: `Bearer ${CUSTOMER_KEY}` })),
      true,
      'a trust domain written after composition is never authority',
    );
  });
});

describe('G-01C §2 — SQLite — tenant visibility is decided before integrity is disclosed (T9, fix C)', () => {
  async function corruptedWorld(): Promise<{ readonly store: GovernanceStore; readonly corrupted: GovernanceRecord; readonly intact: GovernanceRecord; readonly path: string }> {
    const path = join(workDir(), 'corrupted.sqlite');
    const seed = await createSqliteGovernanceStore(path);
    const victim = await seed.appendEvaluation(appendInput(fresh('corrupted')));
    const neighbour = await seed.appendEvaluation(appendInput(fresh('intact')));
    const corrupted = await seed.getByEvaluationId(SYSTEM, victim.evaluationId);
    const intact = await seed.getByEvaluationId(SYSTEM, neighbour.evaluationId);
    assert.ok(corrupted !== null && intact !== null);
    await seed.close();
    const db = new Database(path);
    db.prepare(`UPDATE governance_evaluations SET result_payload_json = 'not json{' WHERE evaluation_id = ?`).run(victim.evaluationId);
    db.close();
    const store = await createSqliteGovernanceStore(path);
    stores.push(store);
    return { store, corrupted, intact, path };
  }

  it('another organization reads another tenant’s corrupted record exactly as an absent one, on every read', async () => {
    const { store, corrupted } = await corruptedWorld();
    assert.equal(await store.getByEvaluationId(FOREIGN_TENANT, corrupted.evaluation.evaluationId), null);
    assert.equal(await store.getByRequestId(FOREIGN_TENANT, corrupted.request.requestId), null);
    assert.equal(await store.getByDecisionId(FOREIGN_TENANT, corrupted.evaluation.decisionId), null);
    await assert.rejects(store.verify(FOREIGN_TENANT, corrupted.evaluation.evaluationId), isStoreError('GOVERNANCE_RECORD_NOT_FOUND'));
    await assert.rejects(store.reconstruct(FOREIGN_TENANT, corrupted.evaluation.evaluationId), isStoreError('GOVERNANCE_RECORD_NOT_FOUND'));
  });

  it('its own organization and system scope still see the corruption; the intact neighbour still verifies', async () => {
    const { store, corrupted, intact } = await corruptedWorld();
    await assert.rejects(store.getByEvaluationId(TENANT, corrupted.evaluation.evaluationId), isStoreError('GOVERNANCE_RECORD_CORRUPTED'));
    await assert.rejects(store.getByEvaluationId(SYSTEM, corrupted.evaluation.evaluationId), isStoreError('GOVERNANCE_RECORD_CORRUPTED'));
    assert.equal((await store.reconstruct(TENANT, corrupted.evaluation.evaluationId)).status, 'corrupted');
    assert.equal((await store.reconstruct(SYSTEM, corrupted.evaluation.evaluationId)).status, 'corrupted');
    const neighbour = await store.verify(TENANT, intact.evaluation.evaluationId);
    assert.equal(neighbour.valid, true, JSON.stringify(neighbour));
    assert.deepEqual(await store.getByEvaluationId(TENANT, intact.evaluation.evaluationId), intact, 'the stored aggregate is returned complete and unchanged');
  });

  it('an aggregate whose request row is missing proves no owner: absent to every organization, the integrity error to system scope', async () => {
    const { store, corrupted, path } = await corruptedWorld();
    await store.close();
    const db = new Database(path);
    db.pragma('foreign_keys = OFF');
    db.prepare('DELETE FROM governance_requests WHERE request_id = ?').run(corrupted.request.requestId);
    db.close();
    const reopened = await createSqliteGovernanceStore(path);
    stores.push(reopened);
    for (const context of [TENANT, FOREIGN_TENANT]) {
      assert.equal(await reopened.getByEvaluationId(context, corrupted.evaluation.evaluationId), null);
      await assert.rejects(reopened.verify(context, corrupted.evaluation.evaluationId), isStoreError('GOVERNANCE_RECORD_NOT_FOUND'));
      await assert.rejects(reopened.reconstruct(context, corrupted.evaluation.evaluationId), isStoreError('GOVERNANCE_RECORD_NOT_FOUND'));
    }
    await assert.rejects(reopened.getByEvaluationId(SYSTEM, corrupted.evaluation.evaluationId), isStoreError('GOVERNANCE_RECORD_CORRUPTED'));
    assert.equal((await reopened.reconstruct(SYSTEM, corrupted.evaluation.evaluationId)).status, 'incomplete');
  });

  it('a foreign idempotency probe at another tenant’s corrupted record is the ordinary conflict, not the integrity error', async () => {
    const { store, corrupted } = await corruptedWorld();
    const resolution = await store.resolveIdempotency(FOREIGN_TENANT, { requestId: corrupted.request.requestId, payloadDigest: corrupted.request.payloadDigest });
    assert.equal(resolution.kind, 'conflict');
  });

  it('over HTTP on a composed Host: another organization’s key is the ordinary 404, the owner’s key the integrity error', async () => {
    const { store, corrupted } = await corruptedWorld();
    const base = loadEnterpriseConfiguration({ AOC_ENTERPRISE_PERSISTENCE_PROVIDER: 'memory', AOC_ENTERPRISE_KERNEL_AUTHORITY_ORGANIZATION_ID: ORG, AOC_ENTERPRISE_REQUIRE_AUTH: 'true', AOC_ENTERPRISE_LOG_LEVEL: 'error' });
    const server = await createEnterpriseServer({
      configuration: { ...base, authentication: { apiKeys: [{ key: LEGACY_KEY, organizationId: ORG }, { key: FOREIGN_LEGACY_KEY, organizationId: FOREIGN_ORG }], legacyKeyMode: 'restricted' } },
      kernelProviders: buildTestKernelProviders(),
      persistence: store,
    });
    servers.push(server);
    const { port } = await server.listen();
    const baseUrl = `http://127.0.0.1:${port}`;
    const path = `/api/governance/requests/${encodeURIComponent(corrupted.request.requestId)}`;
    const foreign = await call(baseUrl, 'GET', path, FOREIGN_LEGACY_KEY);
    const absent = await call(baseUrl, 'GET', `/api/governance/requests/${encodeURIComponent(fresh('never-committed'))}`, FOREIGN_LEGACY_KEY);
    assert.equal(foreign.status, 404, foreign.text);
    assert.equal(errorCode(foreign), errorCode(absent), 'indistinguishable from an id that was never committed');
    assert.equal(foreign.text.includes('GOVERNANCE_RECORD_CORRUPTED'), false, 'no integrity verdict crosses the tenant boundary');
    const owner = await call(baseUrl, 'GET', path, LEGACY_KEY);
    assert.equal(owner.status, 500, owner.text);
  });
});

describe('G-01C §2 — a Passport references only its own organization’s records (fix D, safe link-time validation)', () => {
  async function unauthenticated(): Promise<AocEnterprise> {
    const enterprise = await createEnterprise({
      configuration: loadEnterpriseConfiguration({ AOC_ENTERPRISE_PERSISTENCE_PROVIDER: 'memory', AOC_ENTERPRISE_KERNEL_AUTHORITY_ORGANIZATION_ID: ORG, AOC_ENTERPRISE_REQUIRE_AUTH: 'false', AOC_ENTERPRISE_LOG_LEVEL: 'error' }),
      kernelProviders: buildTestKernelProviders(),
    });
    enterprises.push(enterprise);
    return enterprise;
  }
  const reference = (record: GovernanceRecord) => ({
    evaluationId: record.evaluation.evaluationId,
    decisionId: record.evaluation.decisionId,
    requestId: record.request.requestId,
    status: record.evaluation.status,
    occurredAt: record.evaluation.evaluatedAt,
    governanceRecordDigest: record.integrity.aggregateDigest,
  });

  it('a system-scope caller linking another organization’s record is PASSPORT_GOVERNANCE_RECORD_NOT_FOUND, and nothing is linked', async () => {
    const enterprise = await unauthenticated();
    const scope = { system: true } as const;
    const { passport } = await enterprise.passports.issuePassport(scope, { subject: { agentId: PMFREAK_ACTOR_ID, agentType: 'autonomous_agent' }, organization: { organizationId: ORG, recognizedBy: 'registry' }, actorId: 'user-g01c' });
    const requestId = fresh('foreign-record');
    await enterprise.evaluate(body({ requestId, organization: { id: FOREIGN_ORG } }));
    const foreign = await enterprise.persistence.getByRequestId(SYSTEM, requestId);
    assert.ok(foreign !== null && foreign.request.organizationId === FOREIGN_ORG);
    await assert.rejects(
      enterprise.passports.linkGovernanceRecord(scope, passport.passportId, reference(foreign), 'user-g01c'),
      (error: unknown) => error instanceof AgentPassportError && error.code === 'PASSPORT_GOVERNANCE_RECORD_NOT_FOUND',
    );
    assert.equal((await enterprise.passports.getPassport(scope, passport.passportId)).passport?.governanceReferences.length, 0);
  });

  it('control: the same caller links its Passport organization’s record, whose reference then verifies', async () => {
    const enterprise = await unauthenticated();
    const scope = { system: true } as const;
    const { passport } = await enterprise.passports.issuePassport(scope, { subject: { agentId: PMFREAK_ACTOR_ID, agentType: 'autonomous_agent' }, organization: { organizationId: ORG, recognizedBy: 'registry' }, actorId: 'user-g01c' });
    const requestId = fresh('own-record');
    await enterprise.evaluate(body({ requestId }));
    const own = await enterprise.persistence.getByRequestId(SYSTEM, requestId);
    assert.ok(own !== null);
    const linked = await enterprise.passports.linkGovernanceRecord(scope, passport.passportId, reference(own), 'user-g01c');
    assert.equal(linked.governanceReferences.length, 1);
    const verification = await enterprise.passports.verifyPassport(scope, passport.passportId, 'REFERENTIAL');
    assert.equal(verification.checks.governanceReferences, true, JSON.stringify(verification.failures));
  });
});

// ===========================================================================
// 3. Accepted limitations — characterized; a change is a founder decision.

describe('G-01C §3 — compat: an unscoped key holds system scope for reads AND writes (T3, Decision 6)', () => {
  it('an unscoped compat key issues a Passport in, and evaluates for, an organization the Host does not serve', async () => {
    const h = await harness(createInMemoryGovernanceStore(), 'compat');
    const issued = await call(h.baseUrl, 'POST', '/api/passports', BARE_KEY, {
      subject: { agentId: 'agent-g01c-foreign', agentType: 'autonomous_agent' },
      organization: { organizationId: FOREIGN_ORG, recognizedBy: 'registry' },
      actorId: 'user-g01c',
    });
    assert.equal(issued.status, 201, issued.text);
    const requestId = fresh('compat-foreign');
    const evaluated = await evaluate(h, BARE_KEY, body({ requestId, organization: { id: FOREIGN_ORG } }));
    assert.equal(evaluated.status, 200, evaluated.text);
    assert.equal((await h.raw.getByRequestId(SYSTEM, requestId))?.request.organizationId, FOREIGN_ORG);
  });
});

describe('G-01C §3 — Assurance governance_record evidence demonstrates structural integrity only (T2, Decision 5)', () => {
  it('an agent subject’s verified evidence counts a principal-attributed, a legacy-asserted and an unattributed record alike', async () => {
    const h = await harness(createInMemoryGovernanceStore());
    const principal = await evaluate(h, CUSTOMER_KEY, body({ requestId: fresh('assurance-principal') }));
    const asserted = await evaluate(h, LEGACY_KEY, body({ requestId: fresh('assurance-asserted') }));
    assert.equal(principal.status, 200, principal.text);
    assert.equal(asserted.status, 200, asserted.text);
    const unattributed = await h.raw.appendEvaluation(appendInput(fresh('assurance-unattributed')));
    const bases = await Promise.all(
      [evaluationIdOf(principal), evaluationIdOf(asserted)].map(async (evaluationId) => {
        const record = await h.raw.getByEvaluationId(SYSTEM, evaluationId);
        assert.ok(record !== null);
        const recorded = readRecordedAttribution(record);
        return recorded.status === 'attributed' ? recorded.attribution.basis : recorded.status;
      }),
    );
    assert.deepEqual(bases, ['customer-principal', 'legacy-asserted']);

    const resolver = createAssuranceEvidenceResolver({ sources: { governanceStore: h.raw }, now: () => '2026-06-01T00:00:00.000Z', nextId: (prefix) => `${prefix}-${(sequence += 1)}` });
    const scope: AssuranceScope = {
      scopeId: fresh('assurance-scope'),
      subject: { subjectType: 'agent', subjectId: PMFREAK_ACTOR_ID, organizationId: ORG },
      frameworkId: 'g01c-framework',
      frameworkVersion: '1',
      evidenceCutoffAt: '2999-01-01T00:00:00.000Z',
      includeHistoricalEvidence: true,
      requestedBy: 'g01c',
      requestedAt: NOW,
    };
    const resolution = await resolver.resolve(
      scope,
      { requirementId: 'g01c-governance-records', description: 'Verified Governance Records for the subject', acceptedEvidenceTypes: ['governance_record'], mustBeVerified: true },
      { system: false, organizationId: ORG },
    );
    const accepted = resolution.acceptedEvidence.map((evidence) => evidence.externalId);
    for (const evaluationId of [evaluationIdOf(principal), evaluationIdOf(asserted), unattributed.evaluationId]) {
      assert.ok(accepted.includes(evaluationId), `${evaluationId} is counted as verified evidence for the subject`);
    }
  });
});

describe('G-01C §3 — Passport: a record of another actor is still linkable and counted (T1, Decision 4 pending)', () => {
  it('characterized: an organization-scoped caller links another actor’s record into a Passport, and its history counts it', async () => {
    const enterprise = await createEnterprise({ configuration: loadEnterpriseConfiguration({ AOC_ENTERPRISE_PERSISTENCE_PROVIDER: 'memory', AOC_ENTERPRISE_KERNEL_AUTHORITY_ORGANIZATION_ID: ORG, AOC_ENTERPRISE_LOG_LEVEL: 'error' }), kernelProviders: buildTestKernelProviders() });
    enterprises.push(enterprise);
    const scope = { system: false, organizationId: ORG } as const;
    const { passport } = await enterprise.passports.issuePassport(scope, { subject: { agentId: 'agent-g01c-not-pmfreak', agentType: 'autonomous_agent' }, organization: { organizationId: ORG, recognizedBy: 'registry' }, actorId: 'user-g01c' });
    const requestId = fresh('other-actor');
    await enterprise.evaluate(body({ requestId }));
    const record = await enterprise.persistence.getByRequestId(SYSTEM, requestId);
    assert.ok(record !== null && record.request.actorId === PMFREAK_ACTOR_ID);
    await enterprise.passports.linkGovernanceRecord(scope, passport.passportId, {
      evaluationId: record.evaluation.evaluationId,
      decisionId: record.evaluation.decisionId,
      requestId: record.request.requestId,
      status: record.evaluation.status,
      occurredAt: record.evaluation.evaluatedAt,
      governanceRecordDigest: record.integrity.aggregateDigest,
    }, 'user-g01c');
    const history = await enterprise.passports.getHistorySummary(scope, passport.passportId);
    assert.equal(history.governanceEvaluationsReferenced, 1, 'counted in the history of a subject that is not the record’s actor');
  });
});

// ===========================================================================
// 4. Hypotheses — TODO: CI records whether each reproduces.

describe('G-01C §4 — hypotheses', () => {
  for (const provider of PROVIDERS) {
    it(`H-1 (T12, ${provider.name}) — confirmed, then resolved by the G-01C stabilization: a lone-surrogate request id is refused before persistence`, async () => {
      const store = await provider.open();
      stores.push(store);
      const enterprise = await createEnterprise({ configuration: loadEnterpriseConfiguration({ AOC_ENTERPRISE_PERSISTENCE_PROVIDER: 'memory', AOC_ENTERPRISE_KERNEL_AUTHORITY_ORGANIZATION_ID: ORG, AOC_ENTERPRISE_LOG_LEVEL: 'error' }), kernelProviders: buildTestKernelProviders(), persistence: store });
      enterprises.push(enterprise);
      const requestId = `${fresh('lone')}-\uD800-surrogate`;
      assert.equal(await refusedWith(400, enterprise.evaluate(body({ requestId }))), true);
      assert.equal(await store.getByRequestId(SYSTEM, requestId), null, 'nothing was committed');
    });
  }

  it('H-2 (T7): a deferred append does not wait for its busy timeout when its write upgrade meets another writer', { todo: 'G-01C H-2: FRONTERA-PROD-01 F1 pattern on the Governance Store' }, async (t) => {
    const path = join(workDir(), 'upgrade.sqlite');
    const store = await createSqliteGovernanceStore(path, { busyTimeoutMs: 2000 });
    stores.push(store);
    await store.appendEvaluation(appendInput(fresh('upgrade-seed')));
    const holder = new Database(path);
    holder.exec('BEGIN IMMEDIATE');
    const started = performance.now();
    await store.appendEvaluation(appendInput(fresh('upgrade'))).catch(() => undefined);
    const elapsed = performance.now() - started;
    holder.exec('ROLLBACK');
    holder.close();
    t.diagnostic(`refused after ${elapsed.toFixed(0)} ms of a 2000 ms busy timeout`);
    assert.ok(elapsed < 1000, `refused immediately (${elapsed.toFixed(0)} ms)`);
  });

  it('H-3: the Evidence Bundle Store’s WAL conversion fails at once — not after its busy timeout — while another connection holds the file', { todo: 'G-01C H-3: CI lock failure of run 39702150821' }, async (t) => {
    const path = join(workDir(), 'evidence-contended.sqlite');
    const holder = new Database(path);
    holder.exec('CREATE TABLE g01c_probe (x INTEGER)');
    holder.exec('BEGIN');
    holder.prepare('SELECT count(*) AS n FROM g01c_probe').get();
    const started = performance.now();
    let failure: unknown;
    try {
      const opened = await createSqliteEvidenceStore(path, { now: () => NOW, busyTimeoutMs: 2000 });
      await opened.close();
    } catch (error) {
      failure = error;
    }
    const elapsed = performance.now() - started;
    holder.exec('COMMIT');
    holder.close();
    t.diagnostic(`contended open: ${failure === undefined ? 'opened' : String((failure as Error).message)} after ${elapsed.toFixed(0)} ms of a 2000 ms busy timeout`);
    assert.ok(failure instanceof EvidenceError, 'refused');
    assert.ok(elapsed < 1000, `refused immediately (${elapsed.toFixed(0)} ms)`);
  });

  it('H-4: concurrent processes opening one fresh Evidence Bundle Store file collide ("database is locked")', { todo: 'G-01C H-4: shared default .data/evidence-bundles.sqlite across parallel test processes' }, async (t) => {
    const modulePath = join(__dirname, '..', 'evidence', 'sqlite-evidence-store.js');
    const script = [
      'const [modulePath, dbPath] = process.argv.slice(1);',
      'require(modulePath).createSqliteEvidenceStore(dbPath, { now: () => new Date().toISOString() })',
      "  .then(async (store) => { await store.close(); process.stdout.write('opened'); })",
      "  .catch((error) => process.stdout.write('failed:' + String(error && error.message)));",
    ].join('\n');
    const outcomes: string[] = [];
    for (let round = 0; round < 3; round += 1) {
      const dbPath = join(workDir(), `shared-${round}.sqlite`);
      const results = await Promise.all(Array.from({ length: 6 }, () => run(process.execPath, ['-e', script, modulePath, dbPath]).then(({ stdout }) => stdout, (error: unknown) => `crashed:${String(error)}`)));
      outcomes.push(...results);
    }
    const locked = outcomes.filter((outcome) => outcome.includes('database is locked')).length;
    t.diagnostic(`${String(outcomes.length)} concurrent opens: ${String(outcomes.filter((outcome) => outcome === 'opened').length)} opened, ${String(locked)} "database is locked", others: ${JSON.stringify(outcomes.filter((outcome) => outcome !== 'opened' && !outcome.includes('database is locked')))}`);
    assert.ok(outcomes.every((outcome) => outcome === 'opened' || outcome.startsWith('failed:The Evidence Bundle Store could not be opened')), 'every refusal is the store’s own fail-closed refusal');
    assert.ok(locked > 0, 'reproduced');
  });

  it('control: an uncontended Evidence Bundle Store opens and leaves no stray file behind on refusal paths', async () => {
    const path = join(workDir(), 'evidence-uncontended.sqlite');
    const opened = await createSqliteEvidenceStore(path, { now: () => NOW, busyTimeoutMs: 1000 });
    await opened.close();
    assert.equal(existsSync(path), true);
  });
});
