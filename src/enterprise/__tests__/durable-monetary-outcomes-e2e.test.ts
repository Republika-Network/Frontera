import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';

import type { ExecutionAdapterResult } from '../../features/execution-runtime/index.js';
import { createRecordingExecutionAdapter, type RecordingExecutionAdapter } from '../../features/execution-runtime/tests/execution-fixture.js';
import { KernelGrantCapability } from '../../kernel/orchestration/grant-adapter.js';
import type { AuthorityEventStreamStore } from '../authority-event-stream/stream-store.js';
import { createEnterprise, type AocEnterprise, type CreateEnterpriseOptions } from '../composition/composition-root.js';
import { loadEnterpriseConfiguration, type EnterpriseApiKey } from '../configuration/enterprise-configuration.js';
import type { GrantAuthorityBinding } from '../execution-governance/index.js';
import { createSqliteExecutionOutcomeStore, type ExecutionOutcomeRecord, type ExecutionOutcomeStore } from '../execution-outcome-store/index.js';
import { GOVERNED_ACTION_REASON_CODES as R } from '../governed-action/index.js';
import { executionOutcomeReferenceId } from '../governed-action/identifiers.js';
import { buildDurableAuthorityPayloads, DURABLE_FIXTURE_OPERATOR } from '../kernel-authority/fixtures/durable-authority.fixture.js';
import type { KernelAuthorityMonetaryConstraint as AuthorityConstraint } from '../kernel-authority/contracts.js';
import type { KernelAuthorityStore } from '../kernel-authority/kernel-authority-store.js';
import type { KernelAuthorityProvisioningService } from '../kernel-authority/provisioning-service.js';
import { createSqliteKernelAuthorityStore } from '../kernel-authority/sqlite-kernel-authority-store.js';
import { createSqliteGovernanceStore } from '../governance-store/sqlite-governance-store.js';
import { authorityAuthenticityEnv } from './authority-authenticity-fixture.js';

/**
 * P11 — durable monetary outcomes, end to end, through the one customer entry
 * point and **every** durable store on SQLite:
 *
 * ```
 * operator ─ P10 authority (SQLite) ─ Kernel ─ Governance Store (SQLite)
 *   ─ bounded grant (SQLite) ─ P7 ledger (SQLite) ─ P11 prepare (SQLite)
 *   ─ claim ─ adapter ─ P7 settle/release ─ P11 observation (SQLite) ─ P8 (SQLite)
 * ```
 *
 * A restart closes every store and the Host, reopens every file, rebuilds the
 * Enterprise with a **fresh** adapter, and replays the same governed action.
 */

const ORG = 'org-a';
const TRUST_DOMAIN = 'trust-domain-a';
const ACTION = 'payment.send';
const RESOURCE = 'resource-treasury-1';
const AGENT = 'agent-a';
const OWNER = 'owner-a';
const SUBJECT = { system: 'payments-app', subjectId: 'principal-agent-a' } as const;
const SECRET = 'AOC_P11_DURABLE_OUTCOMES_API_KEY_SENTINEL';
const KEYS: readonly EnterpriseApiKey[] = [{ key: SECRET, organizationId: ORG, customerIdentity: { principalId: 'principal-agent-a', externalSubject: SUBJECT } }];
const NO_TEMPORAL_BOUND: GrantAuthorityBinding = { kind: 'no-temporal-authority-bound', sourceKind: 'organizational-authority', justification: 'Durable Kernel Authority; no mandate window.' };
const A = { organizationId: ORG };

const directories: string[] = [];
const closers: (() => Promise<void>)[] = [];
after(async () => {
  for (const close of closers.reverse()) await close().catch(() => {});
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

function workDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'aoc-p11-'));
  directories.push(directory);
  return directory;
}

const ceiling = (value: string): AuthorityConstraint => ({ type: 'max_amount', currency: 'USD', value });
const lifetime = (maximum: string): AuthorityConstraint => ({ type: 'spending_limit', limitId: 'lifetime', currency: 'USD', maximum, window: { kind: 'lifetime' } });

async function provision(service: KernelAuthorityProvisioningService, constraints: readonly AuthorityConstraint[]): Promise<void> {
  const payloads = buildDurableAuthorityPayloads(ORG, TRUST_DOMAIN);
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

function paths(dir: string) {
  return {
    governance: join(dir, 'governance.sqlite'),
    grants: join(dir, 'bounded-grants.sqlite'),
    authority: join(dir, 'kernel-authority.sqlite'),
    ledger: join(dir, 'exercise-ledger.sqlite'),
    outcomes: join(dir, 'execution-outcomes.sqlite'),
    events: join(dir, 'authority-event-stream.sqlite'),
  };
}

interface Host {
  readonly enterprise: AocEnterprise;
  readonly adapter: RecordingExecutionAdapter;
  readonly authorityStore: KernelAuthorityStore;
  close(): Promise<void>;
}

interface HostOptions {
  readonly behaviour?: (amount: string) => ExecutionAdapterResult;
  readonly assetScale?: number;
  /** Host-supplied stores, for the fault windows a real process death leaves behind. */
  readonly executionOutcomes?: ExecutionOutcomeStore;
  readonly authorityEventStream?: AuthorityEventStreamStore;
}

async function openHost(dir: string, options: HostOptions = {}): Promise<Host> {
  const file = paths(dir);
  const authorityStore = await createSqliteKernelAuthorityStore(file.authority);
  const configuration = loadEnterpriseConfiguration({
    AOC_ENTERPRISE_PERSISTENCE_PROVIDER: 'sqlite',
    ...authorityAuthenticityEnv(),
    AOC_ENTERPRISE_SQLITE_PATH: file.governance,
    AOC_ENTERPRISE_PASSPORT_SQLITE_PATH: join(dir, 'passport.sqlite'),
    AOC_ENTERPRISE_ASSURANCE_SQLITE_PATH: join(dir, 'assurance.sqlite'),
    AOC_ENTERPRISE_BOUNDED_GRANT_SQLITE_PATH: file.grants,
    AOC_ENTERPRISE_EXERCISE_LEDGER_SQLITE_PATH: file.ledger,
    AOC_ENTERPRISE_EXECUTION_OUTCOME_SQLITE_PATH: file.outcomes,
    AOC_ENTERPRISE_AUTHORITY_EVENT_STREAM_SQLITE_PATH: file.events,
    AOC_ENTERPRISE_KERNEL_AUTHORITY_ORGANIZATION_ID: ORG,
  });
  const adapter = createRecordingExecutionAdapter((action) => (options.behaviour === undefined ? { outcome: 'completed', providerRef: 'provider-ref' } : options.behaviour(action.amount?.value ?? '')));
  const enterprise = await createEnterprise({
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
    monetary: { assets: [{ assetId: 'USD', scale: options.assetScale ?? 2 }], financialActions: [ACTION] },
    ...(options.executionOutcomes !== undefined ? { executionOutcomes: { store: options.executionOutcomes } } : {}),
    ...(options.authorityEventStream !== undefined ? { authorityEventStream: { store: options.authorityEventStream } } : {}),
  } satisfies CreateEnterpriseOptions);
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await enterprise.close();
    await authorityStore.close();
  };
  closers.push(close);
  return { enterprise, adapter, authorityStore, close };
}

async function freshHost(dir: string, constraints: readonly AuthorityConstraint[], options: HostOptions = {}): Promise<Host> {
  const host = await openHost(dir, options);
  const provisioning = host.enterprise.kernelAuthorityProvisioning;
  assert.ok(provisioning !== undefined);
  await provision(provisioning, constraints);
  return host;
}

type Body = {
  readonly status: string;
  readonly reasonCodes: readonly string[];
  readonly executionId?: string;
  readonly requestId?: string;
  readonly providerRef?: string;
  readonly replayed?: boolean;
  readonly outcomeRecorded?: boolean;
  readonly failure?: string;
  readonly decision?: { readonly status: string; readonly evaluationId: string };
};

async function pay(host: Host, value: string, key: string): Promise<Body> {
  assert.ok(host.enterprise.governAction !== undefined);
  const reply = await host.enterprise.governAction({ action: ACTION, resource: RESOURCE, amount: { value, currency: 'USD' }, idempotencyKey: key }, { authorizationHeader: `Bearer ${SECRET}` });
  return reply.body as Body;
}

async function durable(host: Host, body: Body): Promise<ExecutionOutcomeRecord | undefined> {
  assert.ok(body.executionId !== undefined, JSON.stringify(body));
  const reader = host.enterprise.executionOutcomes;
  assert.ok(reader !== undefined, 'the read-only P11 surface is composed with governed actions');
  return reader.read(A, body.executionId);
}

/** P7's own durable answer for one execution: settled, released, or still reserved. */
function reservationState(dir: string, executionId: string): string | undefined {
  const db = new Database(paths(dir).ledger, { readonly: true });
  try {
    const row = db
      .prepare(
        `SELECT t.terminal_kind AS kind FROM exercise_control_reservations r LEFT JOIN exercise_control_terminal_events t ON t.reservation_id = r.reservation_id WHERE r.execution_id = ?`,
      )
      .get(executionId) as { kind: string | null } | undefined;
    return row === undefined ? undefined : (row.kind ?? 'reserved');
  } finally {
    db.close();
  }
}

async function projected(host: Host): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const module = (await host.enterprise.health()).modules?.['aoc.enterprise.authority-event-stream'];
    if (Number(module?.health.details?.pending ?? 0) === 0) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe('P11 §137 / §100 — completed: 75 USD under a 100 ceiling and a 250 lifetime budget, then restart and replay', () => {
  it('P10 passes, P7 reserves and settles, P11 records the exact attempt and confirmed completion, Governance and P8 reference it; after restart the replay reconstructs it with no adapter call', async () => {
    const dir = workDir();
    const host = await freshHost(dir, [ceiling('100'), lifetime('250')], { behaviour: () => ({ outcome: 'completed', providerRef: 'provider-payment-001' }) });
    const live = await pay(host, '75', 'p11-e2e-completed');
    assert.equal(live.status, 'executed', JSON.stringify(live));
    assert.equal(live.decision?.status, 'allowed');
    assert.equal(live.providerRef, 'provider-payment-001');
    assert.equal(live.outcomeRecorded, true);
    assert.equal(host.adapter.callCount, 1);
    assert.equal(host.adapter.calls[0]?.amount?.value, '75');
    assert.equal(reservationState(dir, live.executionId ?? ''), 'settled', 'P7 reserved 75 and settled it');

    const record = await durable(host, live);
    assert.deepEqual(record?.attempt.amount, { value: '75', unit: 'USD' });
    assert.equal(record?.attempt.organizationId, ORG);
    assert.equal(record?.attempt.action, ACTION);
    const observation = record?.terminal?.observation;
    assert.equal(observation?.kind === 'provider' ? observation.certainty : undefined, 'confirmed-completed');
    assert.equal(observation?.kind === 'provider' ? observation.providerRef : undefined, 'provider-payment-001');

    // Governance outcome evidence names the canonical observation by digest.
    const governance = await createSqliteGovernanceStore(paths(dir).governance);
    try {
      const committed = await governance.getByRequestId({ system: false, organizationId: ORG }, live.requestId ?? '');
      const summary = committed?.references.find((reference) => reference.referenceId === executionOutcomeReferenceId(live.executionId ?? ''));
      assert.equal(summary?.digest, record?.terminal?.observationDigest);
    } finally {
      await governance.close();
    }

    // P8 can observe the same fact — as evidence only.
    await projected(host);
    const events = host.enterprise.authorityEventStream;
    assert.ok(events !== undefined);
    const streams = new Database(paths(dir).events, { readonly: true });
    try {
      const outcomeEvents = streams.prepare(`SELECT payload_json FROM authority_events WHERE event_type = 'execution.outcome.observed'`).all() as { payload_json: string }[];
      assert.equal(outcomeEvents.length, 1);
      const payload = JSON.parse(outcomeEvents[0]?.payload_json ?? '{}') as { status?: string; providerRef?: string; outcomeRecorded?: boolean };
      assert.deepEqual([payload.status, payload.providerRef, payload.outcomeRecorded], ['executed', 'provider-payment-001', true]);
    } finally {
      streams.close();
    }

    // Restart: every store closed, every file reopened, a fresh adapter.
    await host.close();
    const restarted = await openHost(dir, { behaviour: () => ({ outcome: 'completed', providerRef: 'SHOULD-NEVER-BE-CALLED' }) });
    const replay = await pay(restarted, '75', 'p11-e2e-completed');
    assert.equal(replay.status, 'executed', JSON.stringify(replay));
    assert.equal(replay.executionId, live.executionId);
    assert.equal(replay.providerRef, 'provider-payment-001');
    assert.equal(replay.replayed, true);
    assert.equal(restarted.adapter.callCount, 0, 'no adapter invocation after restart');
    assert.equal(reservationState(dir, live.executionId ?? ''), 'settled');
    const reopened = await durable(restarted, replay);
    assert.deepEqual(reopened, record, 'the durable record survives the restart byte for byte');
    await restarted.close();
  });
});

describe('P11 §138 / §101 — unconfirmed: 50 USD, the provider answers with a job id and no confirmation', () => {
  it('P7 capacity stays consumed, P11 records unconfirmed + the job id, the wire stays execution_unconfirmed, and restart never retries', async () => {
    const dir = workDir();
    const host = await freshHost(dir, [ceiling('100'), lifetime('250')], { behaviour: () => ({ outcome: 'unconfirmed', providerRef: 'provider-job-002' }) });
    const live = await pay(host, '50', 'p11-e2e-unconfirmed');
    assert.equal(live.status, 'execution_unconfirmed', JSON.stringify(live));
    assert.deepEqual([...live.reasonCodes], [R.GOVERNED_ACTION_EXECUTION_OUTCOME_UNCONFIRMED]);
    assert.equal(reservationState(dir, live.executionId ?? ''), 'settled', 'unconfirmed must never release capacity: the money may have moved');
    const observation = (await durable(host, live))?.terminal?.observation;
    assert.equal(observation?.kind === 'provider' ? observation.certainty : undefined, 'unconfirmed');
    assert.equal(observation?.kind === 'provider' ? observation.providerRef : undefined, 'provider-job-002');
    await host.close();

    const restarted = await openHost(dir);
    const replay = await pay(restarted, '50', 'p11-e2e-unconfirmed');
    assert.equal(replay.status, 'execution_unconfirmed');
    assert.deepEqual([...replay.reasonCodes], [R.GOVERNED_ACTION_EXECUTION_OUTCOME_UNCONFIRMED]);
    assert.equal(restarted.adapter.callCount, 0);
    const reopened = (await durable(restarted, replay))?.terminal?.observation;
    assert.equal(reopened?.kind === 'provider' ? reopened.providerRef : undefined, 'provider-job-002', 'the reconciliation handle survives the restart');
    assert.equal(reservationState(dir, live.executionId ?? ''), 'settled');
    await restarted.close();
  });
});

describe('P11 §139 / §102 — definitive failure: 50 USD rejected by the provider', () => {
  it('P7 releases 50, P11 records confirmed-not-completed / PROVIDER_REJECTED, and restart replays execution_failed with no adapter', async () => {
    const dir = workDir();
    const host = await freshHost(dir, [ceiling('100'), lifetime('250')], { behaviour: () => ({ outcome: 'failed', reason: 'PROVIDER_REJECTED' }) });
    const live = await pay(host, '50', 'p11-e2e-failed');
    assert.equal(live.status, 'execution_failed');
    assert.equal(reservationState(dir, live.executionId ?? ''), 'released');
    const observation = (await durable(host, live))?.terminal?.observation;
    assert.equal(observation?.kind === 'provider' ? observation.certainty : undefined, 'confirmed-not-completed');
    assert.equal(observation?.kind === 'provider' && observation.certainty === 'confirmed-not-completed' ? observation.failure : undefined, 'PROVIDER_REJECTED');
    await host.close();

    const restarted = await openHost(dir);
    const replay = await pay(restarted, '50', 'p11-e2e-failed');
    assert.equal(replay.status, 'execution_failed');
    assert.equal(replay.failure, 'PROVIDER_REJECTED');
    assert.equal(replay.replayed, true);
    assert.equal(restarted.adapter.callCount, 0);
    assert.equal(reservationState(dir, live.executionId ?? ''), 'released');
    await restarted.close();
  });
});

describe('P11 §140 — prepared and claimed, no observation: the process died after the provider crossing', () => {
  it('after restart: execution_unconfirmed / ALREADY_ATTEMPTED, no adapter retry, the prepared monetary context readable', async () => {
    const dir = workDir();
    // The observation write never lands — as if the process died right after the provider answered.
    const outcomes = await createSqliteExecutionOutcomeStore(paths(dir).outcomes, { now: () => new Date().toISOString() });
    const dying: ExecutionOutcomeStore = {
      providerKind: outcomes.providerKind,
      prepareAttempt: (context, input) => outcomes.prepareAttempt(context, input),
      recordTerminal: async () => {
        throw new Error('process died');
      },
      read: (context, executionId) => outcomes.read(context, executionId),
      health: () => outcomes.health(),
      close: () => outcomes.close(),
    };
    const host = await freshHost(dir, [ceiling('100'), lifetime('250')], { executionOutcomes: dying, behaviour: () => ({ outcome: 'completed', providerRef: 'provider-payment-lost' }) });
    const live = await pay(host, '50', 'p11-e2e-claim-only');
    assert.equal(live.status, 'executed');
    assert.equal(live.outcomeRecorded, false);
    assert.equal(host.adapter.callCount, 1);
    await host.close();
    await outcomes.close();

    const restarted = await openHost(dir);
    const replay = await pay(restarted, '50', 'p11-e2e-claim-only');
    assert.equal(replay.status, 'execution_unconfirmed');
    assert.deepEqual([...replay.reasonCodes], [R.GOVERNED_ACTION_EXECUTION_ALREADY_ATTEMPTED], 'never reported completed or failed');
    assert.equal(restarted.adapter.callCount, 0);
    const record = await durable(restarted, replay);
    assert.deepEqual(record?.attempt.amount, { value: '50', unit: 'USD' });
    assert.equal(record?.terminal, undefined);
    assert.equal(reservationState(dir, live.executionId ?? ''), 'settled', 'a persistence failure never releases consumed budget');
    await restarted.close();
  });
});

describe('P11 §85 — a corrupted durable observation never replays as executed', () => {
  it('a provider reference swapped on disk: the replay is ALREADY_ATTEMPTED, the adapter is not called', async () => {
    const dir = workDir();
    const host = await freshHost(dir, [ceiling('100'), lifetime('250')], { behaviour: () => ({ outcome: 'completed', providerRef: 'provider-payment-003' }) });
    const live = await pay(host, '25', 'p11-e2e-corrupt');
    assert.equal(live.status, 'executed');
    await host.close();
    const db = new Database(paths(dir).outcomes);
    try {
      for (const trigger of db.prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger'`).all() as { name: string }[]) db.exec(`DROP TRIGGER ${trigger.name}`);
      db.exec(`UPDATE execution_terminal_observations SET provider_ref = 'provider-payment-999'`);
    } finally {
      db.close();
    }
    const restarted = await openHost(dir);
    const replay = await pay(restarted, '25', 'p11-e2e-corrupt');
    assert.equal(replay.status, 'execution_unconfirmed');
    assert.deepEqual([...replay.reasonCodes], [R.GOVERNED_ACTION_EXECUTION_ALREADY_ATTEMPTED]);
    assert.equal(restarted.adapter.callCount, 0);
    await restarted.close();
  });
});

describe('P11 §97 — exact money through every durable store', () => {
  it('9007199254740993.01 USD: adapter, prepared attempt, SQLite, restart, read — the same text', async () => {
    const dir = workDir();
    const big = '9007199254740993.01';
    const host = await freshHost(dir, [ceiling('100000000000000000000'), lifetime('100000000000000000000')]);
    const live = await pay(host, big, 'p11-e2e-exact');
    assert.equal(live.status, 'executed', JSON.stringify(live));
    assert.equal(host.adapter.calls[0]?.amount?.value, big);
    assert.equal((await durable(host, live))?.attempt.amount?.value, big);
    await host.close();
    const restarted = await openHost(dir);
    const replay = await pay(restarted, big, 'p11-e2e-exact');
    assert.equal(replay.status, 'executed');
    assert.equal((await durable(restarted, replay))?.attempt.amount?.value, big);
    assert.equal(restarted.adapter.callCount, 0);
    await restarted.close();
    const db = new Database(paths(dir).outcomes, { readonly: true });
    try {
      assert.deepEqual(db.prepare(`SELECT amount_value AS value, typeof(amount_value) AS type FROM execution_attempts`).get(), { value: big, type: 'text' });
    } finally {
      db.close();
    }
  });
});

describe('P11 §141 — P8 cannot be load-bearing', () => {
  for (const [name, append] of [
    ['throws', () => {
      throw new Error('evidence store down');
    }],
    ['rejects', () => Promise.reject(new Error('evidence store down'))],
    ['never settles', () => new Promise<never>(() => {})],
  ] as const) {
    it(`an evidence store whose append ${name}: the observation persists, the result returns, the replay works`, async () => {
      const dir = workDir();
      const stuck: AuthorityEventStreamStore = {
        providerKind: 'memory',
        append: append as AuthorityEventStreamStore['append'],
        readStream: async () => [],
        verifyStream: async (_context, streamId) => ({ streamId, valid: true, eventCount: 0, failures: [] }),
        health: async () => ({ status: 'healthy', readable: true, writable: true, schemaVersion: 'x', checkedAt: new Date().toISOString() }),
        close: async () => {},
      };
      const host = await freshHost(dir, [ceiling('100'), lifetime('250')], { authorityEventStream: stuck, behaviour: () => ({ outcome: 'completed', providerRef: `provider-p8-${name.length}` }) });
      const live = await pay(host, '10', `p11-e2e-p8-${name.length}`);
      assert.equal(live.status, 'executed');
      assert.equal(live.outcomeRecorded, true);
      assert.ok((await durable(host, live))?.terminal !== undefined);
      const replay = await pay(host, '10', `p11-e2e-p8-${name.length}`);
      assert.equal(replay.providerRef, `provider-p8-${name.length}`);
      assert.equal(host.adapter.callCount, 1);
      await host.close();
    });
  }
});

describe('P11 — composition', () => {
  it('the execution outcome store is composed automatically with governed actions, on its own SQLite file, and reported healthy', async () => {
    const dir = workDir();
    const host = await openHost(dir);
    const module = (await host.enterprise.health()).modules?.['aoc.enterprise.execution-outcomes'];
    assert.equal(module?.health.status, 'healthy');
    assert.equal(module?.health.details?.provider, 'sqlite');
    assert.ok(host.enterprise.executionOutcomes !== undefined);
    assert.equal('prepareAttempt' in host.enterprise.executionOutcomes, false, 'the Host surface is read-only');
    assert.equal('recordTerminal' in host.enterprise.executionOutcomes, false);
    await host.close();
  });
});
