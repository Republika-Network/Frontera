import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';

import { createRecordingExecutionAdapter, type RecordingExecutionAdapter } from '../../features/execution-runtime/tests/execution-fixture.js';
import { KernelGrantCapability } from '../../kernel/orchestration/grant-adapter.js';
import { RESOLUTION_CAPACITY_RESULTS } from '../../control-plane-web/wire.js';
import { EnterpriseHttpError } from '../api/enterprise-http-errors.js';
import { createEnterprise, type AocEnterprise, type CreateEnterpriseOptions } from '../composition/composition-root.js';
import { loadEnterpriseConfiguration, type EnterpriseApiKey } from '../configuration/enterprise-configuration.js';
import type { GrantAuthorityBinding } from '../execution-governance/index.js';
import { snapshotResolutionAuthorities, type ExecutionResolutionAuthority, type ExecutionResolutionAuthoritySelector } from '../execution-reconciliation/authority.js';
import { EXECUTION_RECONCILIATION_CAPACITY_VALUES, type ExecutionReconciliationCapacity, type OperatorResolutionRequest } from '../execution-reconciliation/contracts.js';
import { composesOperatorAttestation, createOperatorAttestationAuthority, selectOperatorAttestation } from '../execution-reconciliation/operator-attestation.js';
import { createExecutionActivityGuard } from '../execution-reconciliation/activity-guard.js';
import { createExecutionReconciliationService } from '../execution-reconciliation/service.js';
import { createInMemoryExecutionOutcomeStore } from '../execution-outcome-store/in-memory-execution-outcome-store.js';
import { createSqliteExecutionResolutionStore, type ExecutionResolutionStore } from '../execution-resolution-store/index.js';
import { createInMemoryExecutionResolutionStore } from '../execution-resolution-store/in-memory-execution-resolution-store.js';
import { createEnterpriseServer } from '../host/enterprise-server.js';
import { buildDurableAuthorityPayloads, DURABLE_FIXTURE_OPERATOR } from '../kernel-authority/fixtures/durable-authority.fixture.js';
import type { KernelAuthorityMonetaryConstraint as AuthorityConstraint } from '../kernel-authority/contracts.js';
import type { KernelAuthorityProvisioningService } from '../kernel-authority/provisioning-service.js';
import { createSqliteKernelAuthorityStore } from '../kernel-authority/sqlite-kernel-authority-store.js';
import { EXECUTION_RESOLUTION_MODULE_ID } from '../modules/execution-resolution-module.js';
import { createOperatorResolutionLog, OPERATOR_RESOLUTION_LOG_EVENTS } from '../operations/governed-path-log.js';
import { createOperatorResolutionCommand } from '../operations/resolution.js';
import type { EnterpriseOperatorPrincipal, OperatorAuthenticator } from '../operator-control/operator-authenticator.js';
import { createEnterpriseLogger } from '../telemetry/enterprise-logger.js';
import { authorityAuthenticityEnv } from './authority-authenticity-fixture.js';

/**
 * PROD-03-02 — post-merge review hardening (#171 review):
 *
 * | Finding | Case |
 * |---|---|
 * | A (P1) | the P12 resolution store takes the governed spine's criticality: required on a Host that runs for governed execution (unhealthy → not ready, `/ready` 503), optional for an embedder that did not mark the spine required; no other module's criticality moves |
 * | B (P2) | operator attestation is offered only where the snapshotted P12 authorities include `frontera.operator-attestation`: a custom authority set composes no resolution command, nothing is `resolvable`, the route answers NOT_AVAILABLE, and its own reconciliation still works |
 * | D (P2) | every canonical capacity result reaches the operator response and the log beside the durable resolution; an identical replay re-runs only the capacity step; a conflicting resolution is still refused; nothing executes |
 *
 * | C (P2) | the Host API's closed body refuses what the console now refuses too (C7: a crafted request cannot bypass it); the console half is `control-plane-web/__tests__/prod0302-web-hardening.test.tsx` |
 */

const ORG = 'org-hardening';
const TRUST_DOMAIN = 'trust-domain-hardening';
const ACTION = 'payment.send';
const RESOURCE = 'resource-treasury-1';
const AGENT = 'agent-a';
const OWNER = 'owner-a';
const SUBJECT = { system: 'payments-app', subjectId: 'principal-agent-a' } as const;
const SECRET = 'AOC_PROD0302_HARDENING_API_KEY_SENTINEL';
const KEYS: readonly EnterpriseApiKey[] = [{ key: SECRET, organizationId: ORG, customerIdentity: { principalId: 'principal-agent-a', externalSubject: SUBJECT } }];
const ADMIN_KEY = 'prod0302-hardening-operator-administrator-key-000000000001';
const OBSERVER_KEY = 'prod0302-hardening-operator-observer-key-0000000000000000002';
const NO_TEMPORAL_BOUND: GrantAuthorityBinding = { kind: 'no-temporal-authority-bound', sourceKind: 'organizational-authority', justification: 'Durable Kernel Authority; no mandate window.' };

const directories: string[] = [];
const closers: (() => Promise<void>)[] = [];
after(async () => {
  for (const close of closers.reverse()) await close().catch(() => {});
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

function workDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'aoc-prod0302-hardening-'));
  directories.push(directory);
  return directory;
}

async function provision(service: KernelAuthorityProvisioningService): Promise<void> {
  const payloads = buildDurableAuthorityPayloads(ORG, TRUST_DOMAIN);
  const constraints: readonly AuthorityConstraint[] = [
    { type: 'max_amount', currency: 'USD', value: '1000' },
    { type: 'spending_limit', limitId: 'lifetime', currency: 'USD', maximum: '5000', window: { kind: 'lifetime' } },
  ];
  await service.provisionActor(DURABLE_FIXTURE_OPERATOR, payloads.issuerActor);
  await service.provisionTrustDomain(DURABLE_FIXTURE_OPERATOR, payloads.trustDomain);
  await service.provisionRootIssuer(DURABLE_FIXTURE_OPERATOR, payloads.rootIssuer);
  await service.provisionActor(DURABLE_FIXTURE_OPERATOR, { ...payloads.ownerActor, actorId: OWNER, displayName: 'Owner', externalSubject: { system: 'payments-app', subjectId: 'owner-a' } });
  await service.provisionActor(DURABLE_FIXTURE_OPERATOR, { ...payloads.agentActor, actorId: AGENT, displayName: 'Agent', externalSubject: SUBJECT });
  await service.provisionPassport(DURABLE_FIXTURE_OPERATOR, { ...payloads.passport, passportId: `passport-${AGENT}`, subjectActorId: AGENT });
  await service.provisionCapabilityToken(DURABLE_FIXTURE_OPERATOR, {
    ...payloads.capabilityToken,
    capabilityTokenId: `cap-${AGENT}`,
    subjectActorId: AGENT,
    principalActorId: OWNER,
    issuerActorId: OWNER,
    actions: [ACTION],
    resourceScopes: [RESOURCE],
  });
  await service.provisionAuthorityGrant(DURABLE_FIXTURE_OPERATOR, { ...payloads.authorityGrant, authorityGrantId: 'authority-grant-owner-a', subjectActorId: OWNER, actions: [ACTION], resourceScopes: [RESOURCE], constraints });
  await service.provisionDelegationGrant(DURABLE_FIXTURE_OPERATOR, {
    ...payloads.delegationGrant,
    delegationGrantId: 'delegation-agent-a',
    delegatorActorId: OWNER,
    delegateActorId: AGENT,
    sourceAuthorityGrantId: 'authority-grant-owner-a',
    actions: [ACTION],
    resourceScopes: [RESOURCE],
  });
}

/** A host-owned P12 store whose health a test can break after startup, as a failing disk would. */
interface BreakableStore {
  readonly store: ExecutionResolutionStore;
  broken: boolean;
}

function breakable(inner: ExecutionResolutionStore): BreakableStore {
  const state: { broken: boolean } = { broken: false };
  const store = new Proxy(inner, {
    get(target, property) {
      if (property === 'health' && state.broken) {
        return async () => ({ status: 'unhealthy' as const, readable: false, writable: false, schemaVersion: 'unknown', checkedAt: '2026-10-07T00:00:00.000Z' });
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
  return {
    store,
    get broken() {
      return state.broken;
    },
    set broken(value: boolean) {
      state.broken = value;
    },
  };
}

interface ComposeOptions {
  /** The governed spine's criticality, as the Enterprise Host bootstrap states it (`required: true`). */
  readonly spineRequired: boolean;
  /** P12 authorities; `false` composes no P12 at all. */
  readonly authorities: false | readonly ExecutionResolutionAuthority[];
  readonly select?: ExecutionResolutionAuthoritySelector;
  readonly operators?: boolean;
  readonly http?: boolean;
}

interface Composed {
  readonly enterprise: AocEnterprise;
  readonly adapter: RecordingExecutionAdapter;
  readonly resolutionStore?: BreakableStore;
  readonly baseUrl?: string;
  readonly dir: string;
}

async function compose(options: ComposeOptions): Promise<Composed> {
  const dir = workDir();
  const authorityStore = await createSqliteKernelAuthorityStore(join(dir, 'kernel-authority.sqlite'));
  const loaded = loadEnterpriseConfiguration({
    AOC_ENTERPRISE_PERSISTENCE_PROVIDER: 'sqlite',
    ...authorityAuthenticityEnv(),
    AOC_ENTERPRISE_SQLITE_PATH: join(dir, 'governance.sqlite'),
    AOC_ENTERPRISE_PASSPORT_SQLITE_PATH: join(dir, 'passport.sqlite'),
    AOC_ENTERPRISE_ASSURANCE_SQLITE_PATH: join(dir, 'assurance.sqlite'),
    AOC_ENTERPRISE_EVIDENCE_SQLITE_PATH: join(dir, 'evidence-bundles.sqlite'),
    AOC_ENTERPRISE_BOUNDED_GRANT_SQLITE_PATH: join(dir, 'bounded-grants.sqlite'),
    AOC_ENTERPRISE_EXERCISE_LEDGER_SQLITE_PATH: join(dir, 'exercise-ledger.sqlite'),
    AOC_ENTERPRISE_EXECUTION_OUTCOME_SQLITE_PATH: join(dir, 'execution-outcomes.sqlite'),
    AOC_ENTERPRISE_EXECUTION_RESOLUTION_SQLITE_PATH: join(dir, 'execution-resolutions.sqlite'),
    AOC_ENTERPRISE_AUTHORITY_EVENT_STREAM_SQLITE_PATH: join(dir, 'authority-event-stream.sqlite'),
    AOC_ENTERPRISE_CONTROL_PLANE_SQLITE_PATH: join(dir, 'control-plane.sqlite'),
    AOC_ENTERPRISE_KERNEL_AUTHORITY_ORGANIZATION_ID: ORG,
    AOC_ENTERPRISE_HTTP_PORT: '0',
    AOC_ENTERPRISE_HTTP_HOST: '127.0.0.1',
  });
  const configuration = {
    ...loaded,
    authentication: { apiKeys: KEYS },
    ...(options.operators === true
      ? {
          administration: {
            administrators: [],
            operators: [
              { operatorId: 'ops-admin', role: 'organization-administrator', key: ADMIN_KEY },
              { operatorId: 'ops-observer', role: 'observer', key: OBSERVER_KEY },
            ],
          },
        }
      : {}),
  };
  // The unconfirmed provider answer leaves a claim with no definitive outcome — exactly what an operator may resolve.
  const adapter = createRecordingExecutionAdapter(() => ({ outcome: 'unconfirmed', providerRef: 'job-1' }));
  const resolutionStore = options.authorities === false ? undefined : breakable(await createSqliteExecutionResolutionStore(join(dir, 'execution-resolutions.sqlite'), { now: () => new Date().toISOString() }));
  const authorities = options.authorities;
  const createOptions = {
    configuration,
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
      ...(options.spineRequired ? { required: true } : {}),
    },
    monetary: { assets: [{ assetId: 'USD', scale: 2 }], financialActions: [ACTION] },
    ...(authorities !== false && resolutionStore !== undefined
      ? { executionReconciliation: { enabled: true, authorities, selectAuthority: options.select ?? (() => authorities[0]?.authorityId ?? 'none'), store: resolutionStore.store } }
      : {}),
  } satisfies CreateEnterpriseOptions;

  let enterprise: AocEnterprise;
  let baseUrl: string | undefined;
  if (options.http === true) {
    const server = await createEnterpriseServer(createOptions);
    const { port } = await server.listen();
    baseUrl = `http://127.0.0.1:${String(port)}`;
    enterprise = server.enterprise;
    closers.push(async () => {
      await server.close();
      await resolutionStore?.store.close();
      await authorityStore.close();
    });
  } else {
    enterprise = await createEnterprise(createOptions);
    closers.push(async () => {
      await enterprise.close();
      await resolutionStore?.store.close();
      await authorityStore.close();
    });
  }
  return { enterprise, adapter, dir, ...(resolutionStore !== undefined ? { resolutionStore } : {}), ...(baseUrl !== undefined ? { baseUrl } : {}) };
}

async function pay(composed: Composed, key: string): Promise<{ readonly status: string; readonly executionId?: string; readonly requestId?: string }> {
  assert.ok(composed.enterprise.governAction !== undefined);
  const reply = await composed.enterprise.governAction({ action: ACTION, resource: RESOURCE, amount: { value: '10', currency: 'USD' }, idempotencyKey: key }, { authorizationHeader: `Bearer ${SECRET}` });
  return reply.body as { readonly status: string; readonly executionId?: string; readonly requestId?: string };
}

const bearer = (key: string): string => `Bearer ${key}`;

// -- Finding A ----------------------------------------------------------------------------

describe('PROD-03-02 hardening A — the P12 resolution store takes the governed spine’s criticality', () => {
  it('A1 / A4: a Host that runs for governed execution with operator attestation reports P12 as required, and healthy → ready', async () => {
    const host = await compose({ spineRequired: true, authorities: [createOperatorAttestationAuthority()], select: selectOperatorAttestation, operators: true });
    const report = await host.enterprise.health();
    const module = report.modules?.[EXECUTION_RESOLUTION_MODULE_ID];
    assert.ok(module !== undefined, 'the P12 module is registered');
    assert.equal(module.required, true, 'A4: required, not optional');
    assert.equal(module.health.status, 'healthy');
    assert.notEqual(report.status, 'unhealthy');
    assert.equal(host.enterprise.isReady(), true);
  });

  it('A2 / A3: the same Host with its P12 store unhealthy after startup is unhealthy, and /ready answers 503', async () => {
    const host = await compose({ spineRequired: true, authorities: [createOperatorAttestationAuthority()], select: selectOperatorAttestation, operators: true, http: true });
    assert.ok(host.baseUrl !== undefined && host.resolutionStore !== undefined);
    const healthy = await fetch(`${host.baseUrl}/ready`);
    assert.equal(healthy.status, 200, 'ready while P12 is healthy');

    host.resolutionStore.broken = true;
    const report = await host.enterprise.health();
    assert.equal(report.modules?.[EXECUTION_RESOLUTION_MODULE_ID]?.health.status, 'unhealthy');
    assert.equal(report.modules?.[EXECUTION_RESOLUTION_MODULE_ID]?.required, true);
    assert.equal(report.status, 'unhealthy', 'A2: a required spine dependency failing is not a mere degradation');
    const notReady = await fetch(`${host.baseUrl}/ready`);
    assert.equal(notReady.status, 503, 'A3: /ready refuses — every new governed action would fail at its binding');
    assert.equal(((await notReady.json()) as { ready: boolean }).ready, false);

    host.resolutionStore.broken = false;
    assert.equal((await fetch(`${host.baseUrl}/ready`)).status, 200, 'recovers with the store');
  });

  it('A5: an embedder that did not mark the governed spine required keeps P12 optional — degraded, still ready', async () => {
    const host = await compose({ spineRequired: false, authorities: [createOperatorAttestationAuthority()], select: selectOperatorAttestation, operators: true });
    assert.ok(host.resolutionStore !== undefined);
    assert.equal((await host.enterprise.health()).modules?.[EXECUTION_RESOLUTION_MODULE_ID]?.required, false);
    host.resolutionStore.broken = true;
    const report = await host.enterprise.health();
    assert.equal(report.modules?.[EXECUTION_RESOLUTION_MODULE_ID]?.health.status, 'unhealthy');
    assert.notEqual(report.status, 'unhealthy', 'optional: degraded, never unhealthy on its own');
    assert.equal(host.enterprise.isReady(), true);
  });

  it('A6: composing P12 changes no other module’s criticality', async () => {
    const withP12 = await compose({ spineRequired: true, authorities: [createOperatorAttestationAuthority()], select: selectOperatorAttestation, operators: true });
    const withoutP12 = await compose({ spineRequired: true, authorities: false, operators: true });
    const criticality = async (composed: Composed): Promise<Record<string, boolean>> =>
      Object.fromEntries(Object.entries((await composed.enterprise.health()).modules ?? {}).map(([moduleId, entry]) => [moduleId, entry.required]));
    const a = await criticality(withP12);
    const b = await criticality(withoutP12);
    assert.equal(EXECUTION_RESOLUTION_MODULE_ID in b, false);
    const { [EXECUTION_RESOLUTION_MODULE_ID]: p12, ...rest } = a;
    assert.equal(p12, true);
    assert.deepEqual(rest, b, 'every other module keeps exactly its criticality');
  });
});

// -- Finding B ----------------------------------------------------------------------------

describe('PROD-03-02 hardening B — operator attestation is offered only where its authority is composed', () => {
  it('the canonical predicate reads the snapshotted authority set, and nothing else', () => {
    const custom = { authorityId: 'resolver-provider', resolve: async () => ({ outcome: 'unresolved' as const }) };
    assert.equal(composesOperatorAttestation(snapshotResolutionAuthorities([createOperatorAttestationAuthority()], selectOperatorAttestation, 't')), true);
    assert.equal(composesOperatorAttestation(snapshotResolutionAuthorities([custom, createOperatorAttestationAuthority()], () => 'resolver-provider', 't')), true);
    assert.equal(composesOperatorAttestation(snapshotResolutionAuthorities([custom], () => 'resolver-provider', 't')), false);
  });

  it('B1 / B6: operators + the built-in attestation authority → the unresolved execution is resolvable and the resolution is recorded, with no adapter call', async () => {
    const host = await compose({ spineRequired: true, authorities: [createOperatorAttestationAuthority()], select: selectOperatorAttestation, operators: true });
    const provisioning = host.enterprise.kernelAuthorityProvisioning;
    assert.ok(provisioning !== undefined);
    await provision(provisioning);
    const paid = await pay(host, 'b1-unconfirmed');
    assert.equal(paid.status, 'execution_unconfirmed');
    const operations = host.enterprise.operatorOperations;
    assert.ok(operations !== undefined);
    const view = (await operations.listExecutions(bearer(OBSERVER_KEY), { requestId: paid.requestId ?? '' })).executions[0];
    assert.equal(view?.classification, 'claimed-outcome-unconfirmed');
    assert.equal(view?.resolvable, true, 'B1: offered');
    const calls = host.adapter.calls.length;
    const resolved = await operations.resolveExecution(bearer(ADMIN_KEY), paid.executionId ?? '', async () => ({ resolution: 'confirmed-not-completed', failure: 'PROVIDER_REJECTED', observedOutcome: 'unconfirmed' }));
    assert.equal(resolved.outcome, 'recorded');
    assert.equal(resolved.capacity, 'adjusted', 'the reservation was reconciled with the non-completion');
    assert.equal(host.adapter.calls.length, calls, 'ZERO adapter calls');
  });

  it('B2 / B3 / B4 / B5: operators + a custom P12 authority set without attestation → no command, nothing resolvable, NOT_AVAILABLE; its own reconciliation still works', async () => {
    let answer: unknown = { outcome: 'unresolved' };
    const queries: unknown[] = [];
    const custom: ExecutionResolutionAuthority = {
      authorityId: 'resolver-provider',
      resolve: async (query) => {
        queries.push(query);
        return answer as never;
      },
    };
    const host = await compose({ spineRequired: true, authorities: [custom], operators: true });
    const provisioning = host.enterprise.kernelAuthorityProvisioning;
    assert.ok(provisioning !== undefined);
    await provision(provisioning);
    const paid = await pay(host, 'b2-unconfirmed');
    assert.equal(paid.status, 'execution_unconfirmed');
    const operations = host.enterprise.operatorOperations;
    assert.ok(operations !== undefined, 'the operations plane itself is composed');

    // B3: the unresolved execution is under attention, never offered for an operator resolution.
    const view = (await operations.listExecutions(bearer(OBSERVER_KEY), { requestId: paid.requestId ?? '' })).executions[0];
    assert.equal(view?.classification, 'claimed-outcome-unconfirmed');
    assert.equal(view?.attentionRequired, true);
    assert.equal(view?.resolvable, false, 'B3: not resolvable — this Host cannot record an attestation');
    const attention = await operations.listAttention(bearer(OBSERVER_KEY), {});
    assert.ok(attention.attention.every((entry) => entry.resolvable === false));

    // B2 / B4: the route answers NOT_AVAILABLE — authorized first — and never the false authority-mismatch.
    const calls = host.adapter.calls.length;
    await assert.rejects(
      operations.resolveExecution(bearer(ADMIN_KEY), paid.executionId ?? '', async () => ({ resolution: 'confirmed-completed', observedOutcome: 'unconfirmed' })),
      (error: unknown) => error instanceof EnterpriseHttpError && error.httpStatus === 409 && error.code === 'EXECUTION_RESOLUTION_NOT_AVAILABLE',
    );
    await assert.rejects(
      operations.resolveExecution(bearer(OBSERVER_KEY), paid.executionId ?? '', async () => ({ resolution: 'confirmed-completed', observedOutcome: 'unconfirmed' })),
      (error: unknown) => error instanceof EnterpriseHttpError && error.httpStatus === 403,
      'still authorized first',
    );
    assert.equal((await host.enterprise.executionResolutions?.read({ organizationId: ORG }, paid.executionId ?? ''))?.resolution, undefined, 'nothing recorded');
    assert.equal(host.adapter.calls.length, calls, 'ZERO adapter calls');

    // B5: the custom authority keeps doing exactly what it was composed for.
    const reconciliation = host.enterprise.executionReconciliation;
    assert.ok(reconciliation !== undefined);
    assert.deepEqual(await reconciliation.reconcile({ organizationId: ORG, executionId: paid.executionId ?? '' }), { outcome: 'unresolved' });
    answer = { outcome: 'resolved', certainty: 'confirmed-completed' };
    const reconciled = await reconciliation.reconcile({ organizationId: ORG, executionId: paid.executionId ?? '' });
    assert.equal(reconciled.outcome, 'resolved');
    assert.ok(reconciled.outcome === 'resolved' && reconciled.resolution.authorityId === 'resolver-provider');
    assert.equal(queries.length, 2, 'asked once per explicit reconcile');
    assert.equal(host.adapter.calls.length, calls, 'ZERO adapter calls');
  });
});

// -- Finding D ----------------------------------------------------------------------------

const T0 = '2026-10-07T10:00:00.000Z';
const OPERATOR = 'operator:ops-admin';
const EXECUTION = `aoc.exec:${'cd'.repeat(16)}`;

/** The real P12 service over real P11 / P12 stores, with a scripted P7 reconciliation port answering a chosen ledger result. */
async function capacityRig(ledger: () => unknown) {
  let tick = 0;
  const now = (): string => new Date(Date.parse(T0) + 1000 * tick++).toISOString();
  const outcomes = createInMemoryExecutionOutcomeStore({ now });
  const resolutions = createInMemoryExecutionResolutionStore({ now });
  const capacityCalls: string[] = [];
  const service = createExecutionReconciliationService({
    outcomes,
    resolutions,
    composition: snapshotResolutionAuthorities([createOperatorAttestationAuthority()], selectOperatorAttestation, 'test'),
    claimed: async () => true,
    capacity: {
      reconcileResolution: async (input) => {
        capacityCalls.push(input.resolution);
        return ledger() as never;
      },
    },
    activity: createExecutionActivityGuard(),
    now,
  });
  await outcomes.prepareAttempt({ organizationId: ORG }, { organizationId: ORG, executionId: EXECUTION, evaluationId: 'eval-1', requestId: 'aoc.gar:1', decisionId: 'decision-1', boundedGrantId: 'grant-1', action: 'restart-service', preparedAt: T0 });
  return { service, resolutions, capacityCalls };
}

const notCompleted: OperatorResolutionRequest = { organizationId: ORG, executionId: EXECUTION, attestedBy: OPERATOR, observedOutcome: 'none', certainty: 'confirmed-not-completed', failure: 'PROVIDER_UNAVAILABLE' };

function adminAuthenticator(): OperatorAuthenticator {
  return {
    organizationId: ORG,
    authorize(): EnterpriseOperatorPrincipal {
      return { plane: 'operator', operatorId: 'ops-admin', organizationId: ORG, role: 'organization-administrator', credentialClass: 'operator', actorRef: OPERATOR };
    },
  };
}

const appliedEvent = { reservationId: 'r-1', resolution: 'confirmed-not-completed', resolutionDigest: 'd', recordedAt: T0 };
/** P7's own answers, by the capacity result P12 maps each to. `not-composed` is the absence of the port. */
const LEDGER_ANSWER: Readonly<Record<Exclude<ExecutionReconciliationCapacity, 'not-composed'>, () => unknown>> = {
  adjusted: () => ({ outcome: 'applied', event: appliedEvent }),
  'no-reservation': () => ({ outcome: 'not-found' }),
  pending: () => {
    throw new Error('ledger unreachable');
  },
  conflict: () => ({ outcome: 'conflict' }),
  inconsistent: () => ({ outcome: 'inconsistent' }),
};

describe('PROD-03-02 hardening D — the capacity result is surfaced beside the durable resolution', () => {
  it('the canonical vocabulary is one list, every value is covered here, and the console states exactly it', () => {
    assert.deepEqual([...EXECUTION_RECONCILIATION_CAPACITY_VALUES].sort(), [...Object.keys(LEDGER_ANSWER), 'not-composed'].sort());
    assert.deepEqual([...RESOLUTION_CAPACITY_RESULTS].sort(), [...EXECUTION_RECONCILIATION_CAPACITY_VALUES].sort());
  });

  for (const capacity of EXECUTION_RECONCILIATION_CAPACITY_VALUES) {
    it(`D1–D5 (${capacity}): the resolution is recorded (200), and the response and the log state capacity '${capacity}' — never a 5xx`, async () => {
      const lines: Record<string, unknown>[] = [];
      const logger = createEnterpriseLogger('debug', { write: (line) => lines.push(JSON.parse(line) as Record<string, unknown>) });
      let service;
      let resolutions;
      if (capacity === 'not-composed') {
        let tick = 0;
        const now = (): string => new Date(Date.parse(T0) + 1000 * tick++).toISOString();
        const outcomes = createInMemoryExecutionOutcomeStore({ now });
        resolutions = createInMemoryExecutionResolutionStore({ now });
        service = createExecutionReconciliationService({ outcomes, resolutions, composition: snapshotResolutionAuthorities([createOperatorAttestationAuthority()], selectOperatorAttestation, 'test'), claimed: async () => true, activity: createExecutionActivityGuard(), now });
        await outcomes.prepareAttempt({ organizationId: ORG }, { organizationId: ORG, executionId: EXECUTION, evaluationId: 'eval-1', requestId: 'aoc.gar:1', decisionId: 'decision-1', boundedGrantId: 'grant-1', action: 'restart-service', preparedAt: T0 });
      } else {
        const rig = await capacityRig(LEDGER_ANSWER[capacity]);
        service = rig.service;
        resolutions = rig.resolutions;
      }
      const command = createOperatorResolutionCommand({ authenticator: adminAuthenticator(), organizationId: ORG, record: (request) => service.recordOperatorResolution(request), log: createOperatorResolutionLog(logger) });
      const view = await command.resolveExecution('Bearer admin', EXECUTION, async () => ({ resolution: 'confirmed-not-completed', failure: 'PROVIDER_UNAVAILABLE', observedOutcome: 'none' }));
      assert.equal(view.outcome, 'recorded', 'the resolution is durable whatever capacity says');
      assert.equal(view.capacity, capacity, 'P12’s capacity result, verbatim');
      assert.equal(view.effect, 'resolution-recorded-no-action-performed');
      assert.equal((await resolutions.read({ organizationId: ORG }, EXECUTION))?.resolution?.certainty, 'confirmed-not-completed');
      const recorded = lines.find((line) => line['message'] === OPERATOR_RESOLUTION_LOG_EVENTS.recorded);
      assert.ok(recorded !== undefined, `logged: ${JSON.stringify(lines.map((line) => line['message']))}`);
      assert.equal(recorded['capacity'], capacity, 'the closed capacity result is logged');
    });
  }

  it('D6: an identical replay after `pending` re-runs only the capacity step — no second resolution — and reports the new result', async () => {
    let reachable = false;
    const rig = await capacityRig(() => {
      if (!reachable) throw new Error('ledger unreachable');
      return { outcome: 'applied', event: appliedEvent };
    });
    const first = await rig.service.recordOperatorResolution(notCompleted);
    assert.ok(first.outcome === 'recorded');
    assert.equal(first.capacity, 'pending');
    const digest = first.resolution.resolutionDigest;

    reachable = true;
    const again = await rig.service.recordOperatorResolution(notCompleted);
    assert.ok(again.outcome === 'replayed', 'the identical attestation replays');
    assert.equal(again.capacity, 'adjusted', 'only the capacity step ran again, and completed');
    assert.equal(again.resolution.resolutionDigest, digest, 'the same resolution, unchanged');
    assert.deepEqual(rig.capacityCalls, ['confirmed-not-completed', 'confirmed-not-completed']);
  });

  it('D7: a conflicting second resolution is still refused; the first stands', async () => {
    const rig = await capacityRig(LEDGER_ANSWER.pending);
    const first = await rig.service.recordOperatorResolution(notCompleted);
    assert.equal(first.outcome, 'recorded');
    const other = await rig.service.recordOperatorResolution({ ...notCompleted, certainty: 'confirmed-completed' } as OperatorResolutionRequest);
    assert.equal(other.outcome, 'already-resolved');
    const another = await rig.service.recordOperatorResolution({ ...notCompleted, attestedBy: 'operator:ops-other' });
    assert.equal(another.outcome, 'already-resolved', 'another operator’s identical answer is not this attestation');
    assert.equal(rig.capacityCalls.length, 1, 'no second capacity transition for a refused resolution');
  });

  it('D8 / D9: the resolution path holds no adapter, and a capacity outcome never reaches one (real Host, every capacity path above)', async () => {
    const host = await compose({ spineRequired: true, authorities: [createOperatorAttestationAuthority()], select: selectOperatorAttestation, operators: true });
    const provisioning = host.enterprise.kernelAuthorityProvisioning;
    assert.ok(provisioning !== undefined);
    await provision(provisioning);
    const paid = await pay(host, 'd8-unconfirmed');
    const operations = host.enterprise.operatorOperations;
    assert.ok(operations !== undefined);
    const calls = host.adapter.calls.length;
    const body = async (): Promise<unknown> => ({ resolution: 'confirmed-not-completed', failure: 'PROVIDER_UNAVAILABLE', observedOutcome: 'unconfirmed' });
    const first = await operations.resolveExecution(bearer(ADMIN_KEY), paid.executionId ?? '', body);
    const replay = await operations.resolveExecution(bearer(ADMIN_KEY), paid.executionId ?? '', body);
    assert.equal(first.outcome, 'recorded');
    assert.equal(replay.outcome, 'replayed');
    assert.equal(replay.capacity, first.capacity);
    assert.equal(host.adapter.calls.length, calls, 'ZERO adapter calls across the resolution and its replay');
    const rows = new Database(join(host.dir, 'execution-resolutions.sqlite'), { readonly: true });
    try {
      assert.equal((rows.prepare('SELECT COUNT(*) AS n FROM execution_resolutions WHERE execution_id = ?').get(paid.executionId) as { n: number }).n, 1, 'one durable resolution');
    } finally {
      rows.close();
    }
    // Still one governed request for the execution, now resolved by the operator: nothing was re-requested or re-claimed.
    const view = (await operations.listExecutions(bearer(OBSERVER_KEY), {})).executions.filter((entry) => entry.executionId === paid.executionId);
    assert.equal(view.length, 1);
    assert.equal(view[0]?.classification, 'executed-failed');
  });
});

// -- Finding C (Host side) -----------------------------------------------------------------

describe('PROD-03-02 hardening C — the Host API stays closed under a crafted request', () => {
  it('C7: a completion with a failure reason, a non-completion without one, and an unknown reason are refused (400) before P12 is reached', async () => {
    let recorded = 0;
    const command = createOperatorResolutionCommand({
      authenticator: adminAuthenticator(),
      organizationId: ORG,
      record: async () => {
        recorded += 1;
        throw new Error('unreachable');
      },
    });
    for (const body of [
      { resolution: 'confirmed-completed', failure: 'PROVIDER_REJECTED', observedOutcome: 'none' },
      { resolution: 'confirmed-completed', failure: '', observedOutcome: 'none' },
      { resolution: 'confirmed-not-completed', observedOutcome: 'none' },
      { resolution: 'confirmed-not-completed', failure: 'BANK_SAID_NO', observedOutcome: 'none' },
    ]) {
      await assert.rejects(
        command.resolveExecution('Bearer admin', EXECUTION, async () => body),
        (error: unknown) => error instanceof EnterpriseHttpError && error.httpStatus === 400,
        JSON.stringify(body),
      );
    }
    assert.equal(recorded, 0, 'nothing reached P12');
  });
});
