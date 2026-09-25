import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';

import type { ExecutionAdapterResult } from '../../features/execution-runtime/index.js';
import { createRecordingExecutionAdapter, type RecordingExecutionAdapter } from '../../features/execution-runtime/tests/execution-fixture.js';
import { KernelGrantCapability } from '../../kernel/orchestration/grant-adapter.js';
import { createEnterprise, type AocEnterprise, type CreateEnterpriseOptions } from '../composition/composition-root.js';
import { loadEnterpriseConfiguration, type EnterpriseApiKey } from '../configuration/enterprise-configuration.js';
import type { GrantAuthorityBinding } from '../execution-governance/index.js';
import type { ExecutionResolutionAuthority, ExecutionResolutionAuthorityResult, ExecutionResolutionQuery, ExecutionResolutionSelectionContext } from '../execution-reconciliation/index.js';
import { createSqliteExecutionOutcomeStore, type ExecutionOutcomeStore } from '../execution-outcome-store/index.js';
import { createSqliteExecutionResolutionStore, type ExecutionResolutionStore } from '../execution-resolution-store/index.js';
import { GOVERNED_ACTION_REASON_CODES as R } from '../governed-action/index.js';
import { executionResolutionReferenceId, executionOutcomeReferenceId } from '../governed-action/identifiers.js';
import { buildDurableAuthorityPayloads, DURABLE_FIXTURE_OPERATOR } from '../kernel-authority/fixtures/durable-authority.fixture.js';
import type { KernelAuthorityMonetaryConstraint as AuthorityConstraint } from '../kernel-authority/contracts.js';
import type { KernelAuthorityStore } from '../kernel-authority/kernel-authority-store.js';
import type { KernelAuthorityProvisioningService } from '../kernel-authority/provisioning-service.js';
import { createSqliteKernelAuthorityStore } from '../kernel-authority/sqlite-kernel-authority-store.js';
import { createSqliteGovernanceStore } from '../governance-store/sqlite-governance-store.js';
import { authorityAuthenticityEnv } from './authority-authenticity-fixture.js';

/**
 * P12 — execution reconciliation and resolution authority, end to end, through
 * the one customer entry point and every durable store on SQLite:
 *
 * ```
 * P10 authority ─ Kernel ─ Governance ─ grant ─ P7 reserve ─ P11 prepare
 *   ─ P12 BIND ─ claim ─ adapter ─ P7 settle ─ P11 observation
 *   … later, trusted and explicit …
 * executionReconciliation.reconcile ─ bound authority (once) ─ P12 resolution
 *   ─ P7 resolution row ─ P8 / Governance evidence
 * ```
 *
 * A restart closes every store and the Host, reopens every file, and rebuilds
 * the Enterprise with fresh adapters and fresh authorities.
 */

const ORG = 'org-a';
const TRUST_DOMAIN = 'trust-domain-a';
const ACTION = 'payment.send';
const RESOURCE = 'resource-treasury-1';
const AGENT = 'agent-a';
const OWNER = 'owner-a';
const SUBJECT = { system: 'payments-app', subjectId: 'principal-agent-a' } as const;
const SECRET = 'AOC_P12_RECONCILIATION_API_KEY_SENTINEL';
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
  const directory = mkdtempSync(join(tmpdir(), 'aoc-p12-'));
  directories.push(directory);
  return directory;
}

const ceiling = (value: string): AuthorityConstraint => ({ type: 'max_amount', currency: 'USD', value });
const lifetime = (maximum: string): AuthorityConstraint => ({ type: 'spending_limit', limitId: 'lifetime', currency: 'USD', maximum, window: { kind: 'lifetime' } });
const daily = (maximum: string): AuthorityConstraint => ({ type: 'spending_limit', limitId: 'daily', currency: 'USD', maximum, window: { kind: 'rolling', seconds: 86_400 } });

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
    resolutions: join(dir, 'execution-resolutions.sqlite'),
    events: join(dir, 'authority-event-stream.sqlite'),
  };
}

/** A trusted resolution authority a test scripts — and counts. */
interface ScriptedAuthority extends ExecutionResolutionAuthority {
  readonly queries: ExecutionResolutionQuery[];
  answer: (query: ExecutionResolutionQuery) => unknown;
}

function authority(authorityId: string, answer: (query: ExecutionResolutionQuery) => unknown = () => ({ outcome: 'unresolved' })): ScriptedAuthority {
  const queries: ExecutionResolutionQuery[] = [];
  const scripted: ScriptedAuthority = {
    authorityId,
    queries,
    answer,
    async resolve(query) {
      queries.push(query);
      return scripted.answer(query) as ExecutionResolutionAuthorityResult;
    },
  };
  return scripted;
}

interface Host {
  readonly enterprise: AocEnterprise;
  readonly adapter: RecordingExecutionAdapter;
  readonly authorities: readonly ScriptedAuthority[];
  close(): Promise<void>;
}

interface HostOptions {
  readonly behaviour?: (amount: string) => ExecutionAdapterResult | Promise<ExecutionAdapterResult>;
  /** P12 composition. `false` composes none, exactly as P11. */
  readonly reconciliation?: false | { readonly authorities: readonly ScriptedAuthority[]; readonly select?: (context: ExecutionResolutionSelectionContext) => string; readonly store?: ExecutionResolutionStore };
  readonly executionOutcomes?: ExecutionOutcomeStore;
}

async function openHost(dir: string, options: HostOptions = {}): Promise<Host & { readonly authorityStore: KernelAuthorityStore }> {
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
    AOC_ENTERPRISE_EXECUTION_RESOLUTION_SQLITE_PATH: file.resolutions,
    AOC_ENTERPRISE_AUTHORITY_EVENT_STREAM_SQLITE_PATH: file.events,
    AOC_ENTERPRISE_KERNEL_AUTHORITY_ORGANIZATION_ID: ORG,
  });
  const adapter = createRecordingExecutionAdapter((action) => (options.behaviour === undefined ? { outcome: 'unconfirmed', providerRef: 'job-123' } : options.behaviour(action.amount?.value ?? '')));
  const reconciliation = options.reconciliation === false ? undefined : (options.reconciliation ?? { authorities: [authority('resolver-a')] });
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
    monetary: { assets: [{ assetId: 'USD', scale: 2 }], financialActions: [ACTION] },
    ...(options.executionOutcomes !== undefined ? { executionOutcomes: { store: options.executionOutcomes } } : {}),
    ...(reconciliation !== undefined
      ? {
          executionReconciliation: {
            enabled: true,
            authorities: reconciliation.authorities,
            selectAuthority: reconciliation.select ?? (() => reconciliation.authorities[0]?.authorityId ?? 'none'),
            ...(reconciliation.store !== undefined ? { store: reconciliation.store } : {}),
          },
        }
      : {}),
  } satisfies CreateEnterpriseOptions);
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await enterprise.close();
    await authorityStore.close();
  };
  closers.push(close);
  return { enterprise, adapter, authorities: reconciliation?.authorities ?? [], authorityStore, close };
}

async function freshHost(dir: string, constraints: readonly AuthorityConstraint[], options: HostOptions = {}) {
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
  readonly withheldBy?: string;
};

async function pay(host: Host, value: string, key: string, extra: Record<string, unknown> = {}): Promise<Body> {
  assert.ok(host.enterprise.governAction !== undefined);
  const reply = await host.enterprise.governAction({ action: ACTION, resource: RESOURCE, amount: { value, currency: 'USD' }, idempotencyKey: key, ...extra }, { authorizationHeader: `Bearer ${SECRET}` });
  return reply.body as Body;
}

function reconcile(host: Host, executionId: string | undefined) {
  assert.ok(executionId !== undefined);
  const service = host.enterprise.executionReconciliation;
  assert.ok(service !== undefined, 'the trusted reconciliation surface is composed');
  return service.reconcile({ organizationId: ORG, executionId });
}

function reservationRows(dir: string, executionId: string): { readonly kind: string | null; readonly reason: string | null; readonly resolution: string | null; readonly resolutionDigest: string | null } | undefined {
  const db = new Database(paths(dir).ledger, { readonly: true });
  try {
    return db
      .prepare(
        `SELECT t.terminal_kind AS kind, t.reason AS reason, s.resolution AS resolution, s.resolution_digest AS resolutionDigest
           FROM exercise_control_reservations r
           LEFT JOIN exercise_control_terminal_events t ON t.reservation_id = r.reservation_id
           LEFT JOIN exercise_control_reservation_resolutions s ON s.reservation_id = r.reservation_id
          WHERE r.execution_id = ?`,
      )
      .get(executionId) as never;
  } finally {
    db.close();
  }
}

const notCompleted = (failure = 'PROVIDER_UNAVAILABLE') => () => ({ outcome: 'resolved', certainty: 'confirmed-not-completed', failure });
const completed = (providerRef?: string) => () => ({ outcome: 'resolved', certainty: 'confirmed-completed', ...(providerRef !== undefined ? { providerRef } : {}) });

describe('P12 §125 / §171 — the flagship: 100 USD unconfirmed, later proven not completed, capacity returned', () => {
  it('P11 stays unconfirmed, P12 records the resolution, P7 records its row beside the original settlement, and a new 100 succeeds', async () => {
    const dir = workDir();
    const resolver = authority('resolver-a');
    const host = await freshHost(dir, [ceiling('100'), lifetime('100')], { reconciliation: { authorities: [resolver] } });

    const live = await pay(host, '100', 'p12-flagship');
    assert.equal(live.status, 'execution_unconfirmed', JSON.stringify(live));
    assert.deepEqual([...live.reasonCodes], [R.GOVERNED_ACTION_EXECUTION_OUTCOME_UNCONFIRMED]);
    assert.deepEqual(reservationRows(dir, live.executionId ?? ''), { kind: 'settled', reason: 'execution-unconfirmed', resolution: null, resolutionDigest: null });
    const binding = (await host.enterprise.executionResolutions?.read(A, live.executionId ?? ''))?.binding;
    assert.equal(binding?.authorityId, 'resolver-a');
    assert.equal(binding?.origin, 'pre-claim');

    const blocked = await pay(host, '100', 'p12-flagship-blocked');
    assert.equal(blocked.status, 'withheld', 'the unconfirmed 100 still consumes the lifetime budget');

    resolver.answer = notCompleted();
    const reconciled = await reconcile(host, live.executionId);
    assert.equal(reconciled.outcome, 'resolved', JSON.stringify(reconciled));
    assert.equal(reconciled.outcome === 'resolved' ? reconciled.capacity : undefined, 'adjusted');
    assert.equal(reconciled.outcome === 'resolved' ? reconciled.established : undefined, 'now');
    assert.equal(resolver.queries.length, 1);
    assert.equal(resolver.queries[0]?.providerRef, 'job-123', 'the authority is told the P11 handle');
    assert.equal(resolver.queries[0]?.basis, 'initial-observation-unconfirmed');
    assert.deepEqual(resolver.queries[0]?.amount, { value: '100', unit: 'USD' });

    // P11 history is never rewritten.
    const p11 = await host.enterprise.executionOutcomes?.read(A, live.executionId ?? '');
    assert.equal(p11?.terminal?.observation.kind === 'provider' ? p11.terminal.observation.certainty : undefined, 'unconfirmed');
    const p12 = (await host.enterprise.executionResolutions?.read(A, live.executionId ?? ''))?.resolution;
    assert.equal(p12?.basisObservationDigest, p11?.terminal?.observationDigest, 'the resolution names the uncertainty it resolved');
    assert.equal(p12?.attemptDigest, p11?.attempt.attemptDigest);
    // P7: the original settle stands; the resolution row sits beside it, bound to the P12 digest.
    assert.deepEqual(reservationRows(dir, live.executionId ?? ''), { kind: 'settled', reason: 'execution-unconfirmed', resolution: 'confirmed-not-completed', resolutionDigest: p12?.resolutionDigest ?? null });

    // Customer replay answers from durable state; nothing is re-executed and nothing is re-asked.
    const replay = await pay(host, '100', 'p12-flagship');
    assert.equal(replay.status, 'execution_failed');
    assert.equal(replay.failure, 'PROVIDER_UNAVAILABLE');
    assert.equal(replay.replayed, true);
    assert.equal(replay.outcomeRecorded, true);
    assert.equal(resolver.queries.length, 1, 'customer replay never queries the resolver');

    const next = await pay(host, '100', 'p12-flagship-next');
    assert.equal(next.status, 'execution_unconfirmed', 'the capacity is available again: the new 100 is admitted and reaches the provider');
    assert.equal(host.adapter.callCount, 2, 'one call for the original, one for the new request — never a retry');

    // Reconcile again: the authority is not asked again, and P7 is idempotent.
    const again = await reconcile(host, live.executionId);
    assert.equal(again.outcome === 'resolved' ? again.established : undefined, 'previously');
    assert.equal(again.outcome === 'resolved' ? again.capacity : undefined, 'adjusted');
    assert.equal(resolver.queries.length, 1);

    // Governance evidence: a new reference, distinct from the P11 summary, which is untouched.
    const governance = await createSqliteGovernanceStore(paths(dir).governance);
    try {
      const committed = await governance.getByRequestId({ system: false, organizationId: ORG }, live.requestId ?? '');
      const summary = committed?.references.find((reference) => reference.referenceId === executionOutcomeReferenceId(live.executionId ?? ''));
      const resolution = committed?.references.find((reference) => reference.referenceId === executionResolutionReferenceId(live.executionId ?? ''));
      assert.equal(summary?.digest, p11?.terminal?.observationDigest);
      assert.equal(resolution?.digest, p12?.resolutionDigest);
      assert.equal(resolution?.externalVersion, 'resolved:confirmed-not-completed:PROVIDER_UNAVAILABLE');
    } finally {
      await governance.close();
    }
    await host.close();
  });
});

describe('P12 §124 — unconfirmed, later proven completed', () => {
  it('capacity stays consumed; replay is executed with the resolver-learned providerRef; after restart too', async () => {
    const dir = workDir();
    const resolver = authority('resolver-a', completed('payment-123'));
    const host = await freshHost(dir, [ceiling('100'), lifetime('150')], { reconciliation: { authorities: [resolver] } });
    const live = await pay(host, '100', 'p12-completed');
    assert.equal(live.status, 'execution_unconfirmed');
    const reconciled = await reconcile(host, live.executionId);
    assert.equal(reconciled.outcome === 'resolved' ? reconciled.resolution.certainty : reconciled.outcome, 'confirmed-completed');
    assert.equal(reservationRows(dir, live.executionId ?? '')?.resolution, 'confirmed-completed');
    assert.equal((await pay(host, '100', 'p12-completed-next')).status, 'withheld', 'a completed resolution never returns capacity');
    await host.close();

    const restarted = await openHost(dir, { reconciliation: { authorities: [authority('resolver-a', () => assert.fail('never asked'))] } });
    const replay = await pay(restarted, '100', 'p12-completed');
    assert.equal(replay.status, 'executed', JSON.stringify(replay));
    assert.equal(replay.providerRef, 'payment-123', 'P12 providerRef wins over P11 job-123');
    assert.equal(replay.replayed, true);
    assert.equal(replay.outcomeRecorded, true);
    assert.equal(restarted.adapter.callCount, 0);
    const p11 = await restarted.enterprise.executionOutcomes?.read(A, live.executionId ?? '');
    assert.equal(p11?.terminal?.observation.kind === 'provider' ? p11.terminal.observation.providerRef : undefined, 'job-123', 'both references survive in their own records');
    await restarted.close();
  });

  it('§50 without a resolver-learned reference, the P11 reference is replayed', async () => {
    const dir = workDir();
    const host = await freshHost(dir, [ceiling('100'), lifetime('150')], { reconciliation: { authorities: [authority('resolver-a', completed())] } });
    const live = await pay(host, '10', 'p12-completed-no-ref');
    await reconcile(host, live.executionId);
    assert.equal((await pay(host, '10', 'p12-completed-no-ref')).providerRef, 'job-123');
    await host.close();
  });
});

describe('P12 §126 — still unresolved', () => {
  it('nothing written, P7 unchanged, replay stays unconfirmed, no adapter retry; a later call may ask again', async () => {
    const dir = workDir();
    const resolver = authority('resolver-a');
    const host = await freshHost(dir, [ceiling('100'), lifetime('100')], { reconciliation: { authorities: [resolver] } });
    const live = await pay(host, '100', 'p12-unresolved');
    assert.equal((await reconcile(host, live.executionId)).outcome, 'unresolved');
    assert.equal((await host.enterprise.executionResolutions?.read(A, live.executionId ?? ''))?.resolution, undefined);
    assert.deepEqual(reservationRows(dir, live.executionId ?? ''), { kind: 'settled', reason: 'execution-unconfirmed', resolution: null, resolutionDigest: null });
    const replay = await pay(host, '100', 'p12-unresolved');
    assert.equal(replay.status, 'execution_unconfirmed');
    assert.deepEqual([...replay.reasonCodes], [R.GOVERNED_ACTION_EXECUTION_OUTCOME_UNCONFIRMED]);
    assert.equal(host.adapter.callCount, 1);
    assert.equal((await reconcile(host, live.executionId)).outcome, 'unresolved');
    assert.equal(resolver.queries.length, 2, 'one query per explicit call — no polling in between');
    await host.close();
  });
});

describe('P12 §122 / §123 / §71 — claim exists, P11 recorded no observation, P7 still reserved', () => {
  for (const [label, answer, expected] of [
    ['completed', completed('p-123'), 'executed'],
    ['not completed', notCompleted('PROVIDER_UNAVAILABLE'), 'execution_failed'],
  ] as const) {
    it(`the process never finished the provider call; the bound authority later answers ${label}`, async () => {
      const dir = workDir();
      const resolver = authority('resolver-a', answer);
      // The provider call never returns: the claim and the P7 reservation exist, and nothing after them.
      let calls = 0;
      const host = await freshHost(dir, [ceiling('100'), lifetime('100')], {
        reconciliation: { authorities: [resolver] },
        behaviour: () => ((calls += 1) === 1 ? new Promise<never>(() => {}) : { outcome: 'unconfirmed', providerRef: 'job-next' }),
      });
      void pay(host, '100', `p12-claim-only-${label}`);
      for (let attempt = 0; attempt < 200 && host.adapter.callCount === 0; attempt += 1) await new Promise((resolve) => setImmediate(resolve));
      assert.equal(host.adapter.callCount, 1);

      const replayBefore = await pay(host, '100', `p12-claim-only-${label}`);
      assert.equal(replayBefore.status, 'execution_unconfirmed');
      assert.deepEqual([...replayBefore.reasonCodes], [R.GOVERNED_ACTION_EXECUTION_ALREADY_ATTEMPTED]);
      const executionId = replayBefore.executionId ?? '';
      assert.equal((await host.enterprise.executionOutcomes?.read(A, executionId))?.terminal, undefined);
      assert.deepEqual(reservationRows(dir, executionId), { kind: null, reason: null, resolution: null, resolutionDigest: null });

      const reconciled = await reconcile(host, executionId);
      assert.equal(reconciled.outcome, 'resolved', JSON.stringify(reconciled));
      assert.equal(reconciled.outcome === 'resolved' ? reconciled.resolution.basisObservationDigest : 'x', undefined, 'claim-only has no basis observation');
      assert.equal(resolver.queries[0]?.basis, 'no-initial-observation');
      assert.equal(reconciled.outcome === 'resolved' ? reconciled.capacity : undefined, 'adjusted');
      assert.equal(reservationRows(dir, executionId)?.kind, null, 'no terminal event is invented');

      const replay = await pay(host, '100', `p12-claim-only-${label}`);
      assert.equal(replay.status, expected);
      if (expected === 'executed') assert.equal(replay.providerRef, 'p-123');
      else assert.equal(replay.failure, 'PROVIDER_UNAVAILABLE');
      assert.equal(host.adapter.callCount, 1, 'no provider execution');
      // Capacity follows the answer.
      const next = await pay(host, '100', `p12-claim-only-${label}-next`);
      assert.equal(next.status, expected === 'executed' ? 'withheld' : 'execution_unconfirmed', JSON.stringify(next));
      await host.close();
    });
  }
});

describe('P12 §119 / §18 — the binding is durable before the claim and never re-inferred after restart', () => {
  it('bound to resolver-a; after restart the selector would pick resolver-b; reconciliation still asks resolver-a', async () => {
    const dir = workDir();
    const host = await freshHost(dir, [ceiling('100'), lifetime('100')], { reconciliation: { authorities: [authority('resolver-a'), authority('resolver-b')], select: () => 'resolver-a' } });
    const live = await pay(host, '50', 'p12-binding');
    await host.close();

    const a = authority('resolver-a', notCompleted());
    const b = authority('resolver-b', completed());
    const restarted = await openHost(dir, { reconciliation: { authorities: [a, b], select: () => 'resolver-b' } });
    assert.equal((await restarted.enterprise.executionResolutions?.read(A, live.executionId ?? ''))?.binding?.authorityId, 'resolver-a');
    const reconciled = await reconcile(restarted, live.executionId);
    assert.equal(reconciled.outcome === 'resolved' ? reconciled.resolution.certainty : reconciled.outcome, 'confirmed-not-completed');
    assert.equal(a.queries.length, 1);
    assert.equal(b.queries.length, 0, 'current configuration never substitutes another authority');
    await restarted.close();
  });

  it('a bound authority no longer composed is authority-unavailable — never substituted', async () => {
    const dir = workDir();
    const host = await freshHost(dir, [ceiling('100'), lifetime('100')], { reconciliation: { authorities: [authority('resolver-a')] } });
    const live = await pay(host, '50', 'p12-binding-gone');
    await host.close();
    const other = authority('resolver-b', notCompleted());
    const restarted = await openHost(dir, { reconciliation: { authorities: [other] } });
    assert.deepEqual(await reconcile(restarted, live.executionId), { outcome: 'authority-unavailable', reason: 'not-composed' });
    assert.equal(other.queries.length, 0);
    await restarted.close();
  });
});

describe('P12 §120 / §142 / §22 — no binding, no claim, no provider', () => {
  for (const [label, select] of [
    ['throws', () => {
      throw new Error('selector down');
    }],
    ['returns an unknown id', () => 'resolver-unknown'],
    ['returns a blank id', () => ''],
    ['returns a promise', () => Promise.resolve('resolver-a') as unknown as string],
    ['returns a getter-backed object', () => ({ get toString() { return () => 'resolver-a'; } }) as unknown as string],
  ] as const) {
    it(`a selector that ${label}: system_error / CLAIM_FAILED, claim absent, provider calls 0, and a retry is still possible`, async () => {
      const dir = workDir();
      const resolver = authority('resolver-a');
      const host = await freshHost(dir, [ceiling('100'), lifetime('100')], { reconciliation: { authorities: [resolver], select: select as (context: ExecutionResolutionSelectionContext) => string } });
      const live = await pay(host, '50', 'p12-no-binding');
      assert.equal(live.status, 'system_error', JSON.stringify(live));
      assert.deepEqual([...live.reasonCodes], [R.GOVERNED_ACTION_EXECUTION_CLAIM_FAILED]);
      assert.equal(host.adapter.callCount, 0);
      assert.equal((await host.enterprise.executionResolutions?.read(A, live.executionId ?? ''))?.binding, undefined);
      assert.deepEqual(await reconcile(host, live.executionId), { outcome: 'not-eligible', reason: 'not-claimed' }, 'prepared but never claimed is not a provider uncertainty');
      assert.equal(resolver.queries.length, 0);
      await host.close();
    });
  }

  it('a resolution store that cannot write stops the execution before its claim', async () => {
    const dir = workDir();
    const real = await createSqliteExecutionResolutionStore(paths(dir).resolutions, { now: () => new Date().toISOString() });
    const failing: ExecutionResolutionStore = { ...real, providerKind: 'sqlite', bind: async () => { throw new Error('disk full'); }, read: (context, executionId) => real.read(context, executionId), recordResolution: (context, input) => real.recordResolution(context, input), health: () => real.health(), close: () => real.close() };
    const host = await freshHost(dir, [ceiling('100'), lifetime('100')], { reconciliation: { authorities: [authority('resolver-a')], store: failing } });
    const live = await pay(host, '50', 'p12-bind-fails');
    assert.equal(live.status, 'system_error');
    assert.equal(host.adapter.callCount, 0);
    await host.close();
    await real.close();
  });

  it('§23 omitting executionReconciliation preserves P11 exactly: no binding step, no surfaces', async () => {
    const dir = workDir();
    const host = await freshHost(dir, [ceiling('100'), lifetime('100')], { reconciliation: false });
    const live = await pay(host, '50', 'p12-disabled');
    assert.equal(live.status, 'execution_unconfirmed');
    assert.equal(host.enterprise.executionReconciliation, undefined);
    assert.equal(host.enterprise.executionResolutions, undefined);
    assert.equal((await host.enterprise.health()).modules?.['aoc.enterprise.execution-resolutions'], undefined);
    await host.close();
  });
});

describe('P12 §128 / §66 — crash after the resolution, before the P7 row', () => {
  it('replay already answers from the resolution; capacity stays consumed; the next reconcile repairs P7 without asking again', async () => {
    const dir = workDir();
    const resolver = authority('resolver-a');
    const host = await freshHost(dir, [ceiling('100'), lifetime('100')], { reconciliation: { authorities: [resolver] } });
    const live = await pay(host, '100', 'p12-crash-gap');
    const p11 = await host.enterprise.executionOutcomes?.read(A, live.executionId ?? '');
    const binding = (await host.enterprise.executionResolutions?.read(A, live.executionId ?? ''))?.binding;
    await host.close();
    // What a process that died right after the resolution commit leaves behind.
    const store = await createSqliteExecutionResolutionStore(paths(dir).resolutions, { now: () => new Date().toISOString() });
    assert.ok(p11 !== undefined && binding !== undefined && p11.terminal !== undefined);
    await store.recordResolution(A, {
      organizationId: ORG,
      executionId: live.executionId ?? '',
      attemptDigest: p11.attempt.attemptDigest,
      bindingDigest: binding.bindingDigest,
      basisObservationDigest: p11.terminal.observationDigest,
      authorityId: 'resolver-a',
      certainty: 'confirmed-not-completed',
      failure: 'PROVIDER_REJECTED',
      resolvedAt: new Date().toISOString(),
    });
    await store.close();

    const restartedResolver = authority('resolver-a', () => assert.fail('a definitive resolution is never re-asked'));
    const restarted = await openHost(dir, { reconciliation: { authorities: [restartedResolver] } });
    const replay = await pay(restarted, '100', 'p12-crash-gap');
    assert.equal(replay.status, 'execution_failed');
    assert.equal(replay.failure, 'PROVIDER_REJECTED');
    assert.equal(reservationRows(dir, live.executionId ?? '')?.resolution, null, 'the P7 row is still missing: capacity conservatively consumed');
    assert.equal((await pay(restarted, '100', 'p12-crash-gap-blocked')).status, 'withheld');

    const repaired = await reconcile(restarted, live.executionId);
    assert.equal(repaired.outcome === 'resolved' ? repaired.established : undefined, 'previously');
    assert.equal(repaired.outcome === 'resolved' ? repaired.capacity : undefined, 'adjusted');
    assert.equal(restartedResolver.queries.length, 0);
    assert.equal(reservationRows(dir, live.executionId ?? '')?.resolution, 'confirmed-not-completed');
    assert.equal((await pay(restarted, '100', 'p12-crash-gap-next')).status, 'execution_unconfirmed', 'capacity returned');
    await restarted.close();
  });
});

describe('P12 §127 — the resolution append fails', () => {
  it('no P7 release, no changed replay, no provider retry', async () => {
    const dir = workDir();
    const real = await createSqliteExecutionResolutionStore(paths(dir).resolutions, { now: () => new Date().toISOString() });
    const failing: ExecutionResolutionStore = { providerKind: 'sqlite', bind: (context, input) => real.bind(context, input), read: (context, executionId) => real.read(context, executionId), recordResolution: async () => { throw new Error('disk full'); }, health: () => real.health(), close: async () => {} };
    const host = await freshHost(dir, [ceiling('100'), lifetime('100')], { reconciliation: { authorities: [authority('resolver-a', notCompleted())], store: failing } });
    const live = await pay(host, '100', 'p12-append-fails');
    assert.deepEqual(await reconcile(host, live.executionId), { outcome: 'resolution-unrecorded' });
    assert.equal(reservationRows(dir, live.executionId ?? '')?.resolution, null);
    assert.equal((await pay(host, '100', 'p12-append-fails')).status, 'execution_unconfirmed');
    assert.equal(host.adapter.callCount, 1);
    await host.close();
    await real.close();
  });
});

describe('P12 §130 / §131 / §132 — idempotency and concurrency', () => {
  it('concurrent reconcile calls in one process share one authority query and one resolution', async () => {
    const dir = workDir();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const resolver = authority('resolver-a', async () => {
      await gate;
      return { outcome: 'resolved', certainty: 'confirmed-not-completed', failure: 'PROVIDER_REJECTED' };
    });
    const host = await freshHost(dir, [ceiling('100'), lifetime('100')], { reconciliation: { authorities: [resolver] } });
    const live = await pay(host, '100', 'p12-concurrent');
    const racing = [reconcile(host, live.executionId), reconcile(host, live.executionId), reconcile(host, live.executionId)];
    release();
    const results = await Promise.all(racing);
    assert.equal(resolver.queries.length, 1);
    const digests = new Set(results.map((result) => (result.outcome === 'resolved' ? result.resolution.resolutionDigest : result.outcome)));
    assert.equal(digests.size, 1);
    await host.close();
  });

  it('two hosts on the same files, racing contradictory answers: exactly one resolution stands, the other is conflict, one P7 transition', async () => {
    const dir = workDir();
    const first = await freshHost(dir, [ceiling('100'), lifetime('100')], { reconciliation: { authorities: [authority('resolver-a')] } });
    const live = await pay(first, '100', 'p12-cross-process');
    let releaseA: () => void = () => {};
    let releaseB: () => void = () => {};
    const gateA = new Promise<void>((resolve) => (releaseA = resolve));
    const gateB = new Promise<void>((resolve) => (releaseB = resolve));
    first.authorities[0]!.answer = async () => {
      await gateA;
      return { outcome: 'resolved', certainty: 'confirmed-completed' };
    };
    const second = await openHost(dir, {
      reconciliation: {
        authorities: [
          authority('resolver-a', async () => {
            await gateB;
            return { outcome: 'resolved', certainty: 'confirmed-not-completed', failure: 'PROVIDER_REJECTED' };
          }),
        ],
      },
    });
    const a = reconcile(first, live.executionId);
    const b = reconcile(second, live.executionId);
    for (let attempt = 0; attempt < 20; attempt += 1) await new Promise((resolve) => setImmediate(resolve));
    releaseA();
    const ra = await a;
    releaseB();
    const rb = await b;
    assert.equal(ra.outcome, 'resolved');
    assert.deepEqual(rb, { outcome: 'conflict' });
    assert.equal(reservationRows(dir, live.executionId ?? '')?.resolution, 'confirmed-completed', 'no second P7 transition');
    assert.equal((await pay(second, '100', 'p12-cross-process')).status, 'executed');
    await second.close();
    await first.close();
  });
});

describe('P12 §133 — a corrupt P11 basis is never reconciled', () => {
  for (const [label, statement] of [
    ['attempt amount', `UPDATE execution_attempts SET amount_value = '1'`],
    ['attempt digest', `UPDATE execution_attempts SET attempt_digest = 'sha256:${'0'.repeat(64)}'`],
    ['observation digest', `UPDATE execution_terminal_observations SET observation_digest = 'sha256:${'0'.repeat(64)}'`],
  ] as const) {
    it(`tampered ${label}: authority calls 0, P12 writes 0, P7 changes 0`, async () => {
      const dir = workDir();
      const resolver = authority('resolver-a', notCompleted());
      const host = await freshHost(dir, [ceiling('100'), lifetime('100')], { reconciliation: { authorities: [resolver] } });
      const live = await pay(host, '100', `p12-corrupt-${label}`);
      await host.close();
      const db = new Database(paths(dir).outcomes);
      try {
        for (const trigger of db.prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger'`).all() as { name: string }[]) db.exec(`DROP TRIGGER ${trigger.name}`);
        db.exec(statement);
      } finally {
        db.close();
      }
      const restartedResolver = authority('resolver-a', notCompleted());
      const restarted = await openHost(dir, { reconciliation: { authorities: [restartedResolver] } });
      assert.deepEqual(await reconcile(restarted, live.executionId), { outcome: 'basis-unavailable', reason: 'outcome-corrupt' });
      assert.equal(restartedResolver.queries.length, 0);
      assert.equal((await restarted.enterprise.executionResolutions?.read(A, live.executionId ?? ''))?.resolution, undefined);
      assert.equal(reservationRows(dir, live.executionId ?? '')?.resolution, null);
      await restarted.close();
    });
  }
});

describe('P12 §134 / §135 — corrupt P12 state', () => {
  it('a tampered binding authority: no authority call, no resolution, no capacity mutation', async () => {
    const dir = workDir();
    const host = await freshHost(dir, [ceiling('100'), lifetime('100')], { reconciliation: { authorities: [authority('resolver-a'), authority('resolver-b')], select: () => 'resolver-a' } });
    const live = await pay(host, '100', 'p12-corrupt-binding');
    await host.close();
    const db = new Database(paths(dir).resolutions);
    try {
      for (const trigger of db.prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger'`).all() as { name: string }[]) db.exec(`DROP TRIGGER ${trigger.name}`);
      db.exec(`UPDATE execution_resolution_bindings SET authority_id = 'resolver-b'`);
    } finally {
      db.close();
    }
    const a = authority('resolver-a', notCompleted());
    const b = authority('resolver-b', notCompleted());
    const restarted = await openHost(dir, { reconciliation: { authorities: [a, b] } });
    assert.deepEqual(await reconcile(restarted, live.executionId), { outcome: 'basis-unavailable', reason: 'resolution-corrupt' });
    assert.equal(a.queries.length + b.queries.length, 0);
    assert.equal(reservationRows(dir, live.executionId ?? '')?.resolution, null);
    await restarted.close();
  });

  it('a completed resolution tampered on disk never replays as executed and never returns capacity', async () => {
    const dir = workDir();
    const host = await freshHost(dir, [ceiling('100'), lifetime('100')], { reconciliation: { authorities: [authority('resolver-a', notCompleted())] } });
    const live = await pay(host, '100', 'p12-corrupt-resolution');
    await host.close();
    const restarted = await openHost(dir, { reconciliation: { authorities: [authority('resolver-a', notCompleted())] } });
    const reconciled = await reconcile(restarted, live.executionId);
    assert.equal(reconciled.outcome, 'resolved');
    await restarted.close();
    const raw = new Database(paths(dir).resolutions);
    try {
      for (const trigger of raw.prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger'`).all() as { name: string }[]) raw.exec(`DROP TRIGGER ${trigger.name}`);
      raw.exec(`UPDATE execution_resolutions SET certainty = 'confirmed-completed', failure = NULL`);
    } finally {
      raw.close();
    }
    const again = await openHost(dir, { reconciliation: { authorities: [authority('resolver-a', completed())] } });
    const replay = await pay(again, '100', 'p12-corrupt-resolution');
    assert.equal(replay.status, 'execution_unconfirmed', 'a corrupt resolution is never an answer');
    assert.deepEqual(await reconcile(again, live.executionId), { outcome: 'basis-unavailable', reason: 'resolution-corrupt' });
    assert.equal(again.adapter.callCount, 0);
    await again.close();
  });
});

describe('P12 §143 — adversarial authority answers write nothing and release nothing', () => {
  // `then` answers undefined so the Promise machinery passes it through; every other read throws. The
  // normalizer reads descriptors only, and refuses the accessor it finds, without ever calling `get`.
  const trap = new Proxy({}, { get: (_target, key) => { if (key === 'then') return undefined; throw new Error('trap'); }, getPrototypeOf: () => Object.prototype, ownKeys: () => ['outcome'], getOwnPropertyDescriptor: () => ({ configurable: true, enumerable: true, get: () => 'resolved' }) });
  for (const [label, answer] of [
    ['an unknown certainty', { outcome: 'resolved', certainty: 'probably-failed', failure: 'PROVIDER_REJECTED' }],
    ['an extra amount', { outcome: 'resolved', certainty: 'confirmed-not-completed', failure: 'PROVIDER_REJECTED', amount: { value: '1', unit: 'USD' } }],
    ['a wrong failure type', { outcome: 'resolved', certainty: 'confirmed-not-completed', failure: 'TIMEOUT' }],
    ['a completion with a failure', { outcome: 'resolved', certainty: 'confirmed-completed', failure: 'PROVIDER_REJECTED' }],
    ['a providerRef object', { outcome: 'resolved', certainty: 'confirmed-completed', providerRef: { id: 'x' } }],
    ['a throwing getter', { outcome: 'resolved', get certainty(): string { throw new Error('boom'); }, failure: 'PROVIDER_REJECTED' }],
    ['a Proxy', trap],
    ['a confidence score', { outcome: 'resolved', certainty: 'confirmed-not-completed', failure: 'PROVIDER_REJECTED', confidence: 0.99 }],
    ['null', null],
  ] as const) {
    it(`${label}: authority-unavailable / invalid-answer, no resolution, no P7 release`, async () => {
      const dir = workDir();
      const host = await freshHost(dir, [ceiling('100'), lifetime('100')], { reconciliation: { authorities: [authority('resolver-a', () => answer)] } });
      const live = await pay(host, '100', `p12-adversarial-${label}`);
      assert.deepEqual(await reconcile(host, live.executionId), { outcome: 'authority-unavailable', reason: 'invalid-answer' });
      assert.equal((await host.enterprise.executionResolutions?.read(A, live.executionId ?? ''))?.resolution, undefined);
      assert.equal(reservationRows(dir, live.executionId ?? '')?.resolution, null);
      assert.equal((await pay(host, '100', `p12-adversarial-${label}-next`)).status, 'withheld');
      await host.close();
    });
  }

  it('an authority that throws or rejects is authority-unavailable / failed', async () => {
    const dir = workDir();
    const host = await freshHost(dir, [ceiling('100'), lifetime('100')], {
      reconciliation: {
        authorities: [
          authority('resolver-a', () => {
            throw new Error('provider API down');
          }),
        ],
      },
    });
    const live = await pay(host, '100', 'p12-authority-throws');
    assert.deepEqual(await reconcile(host, live.executionId), { outcome: 'authority-unavailable', reason: 'failed' });
    host.authorities[0]!.answer = () => Promise.reject(new Error('timeout'));
    assert.deepEqual(await reconcile(host, live.executionId), { outcome: 'authority-unavailable', reason: 'failed' });
    await host.close();
  });

  it('an unsafe providerRef string is omitted and never changes certainty', async () => {
    const dir = workDir();
    const host = await freshHost(dir, [ceiling('100'), lifetime('150')], { reconciliation: { authorities: [authority('resolver-a', completed('https://provider.example/pay/1'))] } });
    const live = await pay(host, '10', 'p12-unsafe-ref');
    const reconciled = await reconcile(host, live.executionId);
    assert.equal(reconciled.outcome === 'resolved' ? reconciled.resolution.certainty : undefined, 'confirmed-completed');
    assert.equal(reconciled.outcome === 'resolved' ? reconciled.resolution.providerRef : 'x', undefined);
    await host.close();
  });
});

describe('P12 §144 / §113 / §114 — a caller cannot self-resolve', () => {
  it('reconciliation vocabulary inside assertedContext is rejected before the Kernel', async () => {
    const dir = workDir();
    const resolver = authority('resolver-a');
    const host = await freshHost(dir, [ceiling('100'), lifetime('100')], { reconciliation: { authorities: [resolver] } });
    for (const key of ['resolution', 'resolved', 'reconciled', 'reconciliation', 'resolutionAuthority', 'resolutionAuthorityId', 'providerResolution', 'providerOutcome', 'finalOutcome', 'confirmedCompleted', 'confirmedNotCompleted', 'providerRef']) {
      const reply = await pay(host, '100', `p12-self-${key}`, { assertedContext: { [key]: 'confirmed-not-completed' } });
      assert.equal(reply.status, 'rejected', key);
      assert.deepEqual([...reply.reasonCodes], [R.GOVERNED_ACTION_INTENT_INVALID], key);
    }
    const combined = await pay(host, '100', 'p12-self-all', { assertedContext: { resolution: 'confirmed-not-completed', resolutionAuthority: 'admin', providerOutcome: 'failed', providerRef: 'fake' } });
    assert.equal(combined.status, 'rejected');
    assert.equal(host.adapter.callCount, 0);
    assert.equal(resolver.queries.length, 0);
    await host.close();
  });
});

describe('P12 §141 / §89 — exact money across every store and a restart', () => {
  it('9007199254740993.01 USD: P11 text unchanged, P12 bound to the same attempt digest, P7 row names the same execution and resolution', async () => {
    const dir = workDir();
    const big = '9007199254740993.01';
    const resolver = authority('resolver-a', notCompleted('PROVIDER_REJECTED'));
    const host = await freshHost(dir, [ceiling('100000000000000000000'), lifetime('100000000000000000000')], { reconciliation: { authorities: [resolver] } });
    const live = await pay(host, big, 'p12-exact');
    assert.equal(live.status, 'execution_unconfirmed', JSON.stringify(live));
    assert.deepEqual(resolver.queries, []);
    await host.close();
    const restartedResolver = authority('resolver-a', notCompleted('PROVIDER_REJECTED'));
    const restarted = await openHost(dir, { reconciliation: { authorities: [restartedResolver] } });
    const reconciled = await reconcile(restarted, live.executionId);
    assert.equal(reconciled.outcome, 'resolved');
    assert.equal(restartedResolver.queries[0]?.amount?.value, big);
    await restarted.close();
    const again = await openHost(dir, { reconciliation: { authorities: [authority('resolver-a')] } });
    const p11 = await again.enterprise.executionOutcomes?.read(A, live.executionId ?? '');
    const p12 = await again.enterprise.executionResolutions?.read(A, live.executionId ?? '');
    assert.equal(p11?.attempt.amount?.value, big);
    assert.equal(p12?.binding?.attemptDigest, p11?.attempt.attemptDigest);
    assert.equal(p12?.resolution?.attemptDigest, p11?.attempt.attemptDigest);
    assert.equal(reservationRows(dir, live.executionId ?? '')?.resolutionDigest, p12?.resolution?.resolutionDigest);
    await again.close();
    const db = new Database(paths(dir).outcomes, { readonly: true });
    try {
      assert.deepEqual(db.prepare(`SELECT amount_value AS value, typeof(amount_value) AS type FROM execution_attempts`).get(), { value: big, type: 'text' });
    } finally {
      db.close();
    }
  });
});

describe('P12 §136 — one reservation across a lifetime and a rolling limit, released from both', () => {
  it('lifetime 100 + rolling 24h 100: an unconfirmed 100 consumes both; not-completed returns both; the next 100 is admitted', async () => {
    const dir = workDir();
    const host = await freshHost(dir, [ceiling('100'), lifetime('100'), daily('100')], { reconciliation: { authorities: [authority('resolver-a', notCompleted())] } });
    const live = await pay(host, '100', 'p12-multi');
    assert.equal((await pay(host, '1', 'p12-multi-blocked')).status, 'withheld');
    const reconciled = await reconcile(host, live.executionId);
    assert.equal(reconciled.outcome === 'resolved' ? reconciled.capacity : undefined, 'adjusted');
    assert.equal((await pay(host, '100', 'p12-multi-next')).status, 'execution_unconfirmed');
    await host.close();
  });
});

describe('P12 §29 / §31 / §24 — eligibility and legacy adoption', () => {
  it('initially confirmed and withheld executions are not eligible; the authority is never asked', async () => {
    const dir = workDir();
    const resolver = authority('resolver-a', notCompleted());
    const host = await freshHost(dir, [ceiling('100'), lifetime('150')], { reconciliation: { authorities: [resolver] }, behaviour: () => ({ outcome: 'completed', providerRef: 'done-1' }) });
    const done = await pay(host, '10', 'p12-eligible-completed');
    assert.deepEqual(await reconcile(host, done.executionId), { outcome: 'not-eligible', reason: 'initial-observation-definitive' });
    assert.deepEqual(await reconcile(host, 'aoc.exec:does-not-exist'), { outcome: 'not-eligible', reason: 'no-attempt' });
    assert.equal(resolver.queries.length, 0);
    await host.close();
  });

  it('a pre-P12 execution is adopted by a trusted operator: binding only, no outcome; the adopted authority must still answer; rebinding conflicts', async () => {
    const dir = workDir();
    const legacy = await freshHost(dir, [ceiling('100'), lifetime('100')], { reconciliation: false });
    const live = await pay(legacy, '100', 'p12-legacy');
    assert.equal(live.status, 'execution_unconfirmed');
    await legacy.close();

    const a = authority('resolver-a', notCompleted());
    const host = await openHost(dir, { reconciliation: { authorities: [a, authority('resolver-b')] } });
    assert.deepEqual(await reconcile(host, live.executionId), { outcome: 'authority-unavailable', reason: 'unbound' }, 'never chosen from current config');
    assert.equal(a.queries.length, 0);
    const service = host.enterprise.executionReconciliation;
    assert.ok(service !== undefined);
    assert.deepEqual(await service.adoptResolutionAuthority({ organizationId: ORG, executionId: live.executionId ?? '', authorityId: 'resolver-unknown' }), { outcome: 'authority-not-composed' });
    const adopted = await service.adoptResolutionAuthority({ organizationId: ORG, executionId: live.executionId ?? '', authorityId: 'resolver-a' });
    assert.equal(adopted.outcome, 'bound');
    assert.equal(adopted.outcome === 'bound' ? adopted.binding.origin : undefined, 'adopted');
    assert.equal((await host.enterprise.executionResolutions?.read(A, live.executionId ?? ''))?.resolution, undefined, 'adoption declares no outcome');
    assert.equal((await service.adoptResolutionAuthority({ organizationId: ORG, executionId: live.executionId ?? '', authorityId: 'resolver-a' })).outcome, 'existing');
    assert.deepEqual(await service.adoptResolutionAuthority({ organizationId: ORG, executionId: live.executionId ?? '', authorityId: 'resolver-b' }), { outcome: 'conflict' });
    const reconciled = await reconcile(host, live.executionId);
    assert.equal(reconciled.outcome === 'resolved' ? reconciled.resolution.certainty : reconciled.outcome, 'confirmed-not-completed');
    assert.equal(a.queries.length, 1);
    await host.close();
  });

  it('§88 another organization can neither reconcile nor adopt', async () => {
    const dir = workDir();
    const resolver = authority('resolver-a', notCompleted());
    const host = await freshHost(dir, [ceiling('100'), lifetime('100')], { reconciliation: { authorities: [resolver] } });
    const live = await pay(host, '100', 'p12-tenant');
    const service = host.enterprise.executionReconciliation;
    assert.ok(service !== undefined);
    const foreign = await service.reconcile({ organizationId: 'org-b', executionId: live.executionId ?? '' });
    assert.notEqual(foreign.outcome, 'resolved');
    const adopt = await service.adoptResolutionAuthority({ organizationId: 'org-b', executionId: live.executionId ?? '', authorityId: 'resolver-a' });
    assert.notEqual(adopt.outcome, 'bound');
    assert.equal(resolver.queries.length, 0);
    await assert.rejects(host.enterprise.executionResolutions!.read({ organizationId: 'org-b' }, live.executionId ?? ''));
    await host.close();
  });
});

describe('P12 §110 — composition and health', () => {
  it('its own SQLite file, a healthy module that reports authorities composed — not connectivity — and read-only / action surfaces kept apart', async () => {
    const dir = workDir();
    const host = await openHost(dir, { reconciliation: { authorities: [authority('resolver-a'), authority('resolver-b')] } });
    const module = (await host.enterprise.health()).modules?.['aoc.enterprise.execution-resolutions'];
    assert.equal(module?.health.status, 'healthy');
    assert.equal(module?.health.details?.provider, 'sqlite');
    assert.equal(module?.health.details?.authoritiesComposed, 2);
    const reader = host.enterprise.executionResolutions;
    assert.ok(reader !== undefined);
    assert.deepEqual(Object.keys(reader), ['read']);
    assert.deepEqual(Object.keys(host.enterprise.executionReconciliation ?? {}).sort(), ['adoptResolutionAuthority', 'reconcile']);
    await host.close();
    const db = new Database(paths(dir).resolutions, { readonly: true });
    try {
      assert.ok(db.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'execution_resolution_bindings'`).get() !== undefined);
    } finally {
      db.close();
    }
  });

  it('§21 / §107 duplicate or unrecordable authority ids, no authorities, no selector, or reconciliation without governed actions fail createEnterprise', async () => {
    const dir = workDir();
    const base = loadEnterpriseConfiguration({ AOC_ENTERPRISE_PERSISTENCE_PROVIDER: 'memory', AOC_ENTERPRISE_KERNEL_AUTHORITY_ORGANIZATION_ID: ORG, AOC_ENTERPRISE_SQLITE_PATH: join(dir, 'g.sqlite') });
    for (const reconciliation of [
      { enabled: true, authorities: [authority('dup'), authority('dup')], selectAuthority: () => 'dup' },
      { enabled: true, authorities: [authority('has space')], selectAuthority: () => 'has space' },
      { enabled: true, authorities: [], selectAuthority: () => 'x' },
      { enabled: true, authorities: [authority('resolver-a')] },
    ]) {
      await assert.rejects(createEnterprise({ configuration: base, executionReconciliation: reconciliation as never }), /executionReconciliation|resolution|authorit/i);
    }
  });
});

async function projected(host: Host): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const module = (await host.enterprise.health()).modules?.['aoc.enterprise.authority-event-stream'];
    if (Number(module?.health.details?.pending ?? 0) === 0) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe('P12 §91 / §92 / §93 — P8 records the resolution as a new fact; the observation event stays', () => {
  it('execution.outcome.observed stays unconfirmed; execution.outcome.resolved and exercise.reservation.reconciled follow', async () => {
    const dir = workDir();
    const host = await freshHost(dir, [ceiling('100'), lifetime('100')], { reconciliation: { authorities: [authority('resolver-a', notCompleted('PROVIDER_REJECTED'))] } });
    const live = await pay(host, '100', 'p12-evidence');
    const reconciled = await reconcile(host, live.executionId);
    assert.equal(reconciled.outcome, 'resolved');
    await projected(host);
    const db = new Database(paths(dir).events, { readonly: true });
    try {
      const rows = db.prepare(`SELECT event_type AS type, payload_json AS payload FROM authority_events ORDER BY sequence`).all() as { type: string; payload: string }[];
      const types = rows.map((row) => row.type);
      assert.ok(types.indexOf('execution.outcome.observed') < types.indexOf('execution.outcome.resolved'), types.join(','));
      assert.ok(types.includes('exercise.reservation.reconciled'), types.join(','));
      const observed = JSON.parse(rows.find((row) => row.type === 'execution.outcome.observed')?.payload ?? '{}') as { status?: string };
      assert.equal(observed.status, 'execution-unconfirmed', 'the initial observation event is never rewritten');
      const resolved = JSON.parse(rows.find((row) => row.type === 'execution.outcome.resolved')?.payload ?? '{}') as Record<string, unknown>;
      assert.deepEqual(Object.keys(resolved).sort(), ['authorityId', 'certainty', 'failure', 'resolutionDigest']);
      assert.equal(resolved.certainty, 'confirmed-not-completed');
      assert.equal(resolved.resolutionDigest, reconciled.outcome === 'resolved' ? reconciled.resolution.resolutionDigest : undefined);
    } finally {
      db.close();
    }
    await host.close();
  });
});

describe('P12 §129 / §95 — evidence is never load-bearing', () => {
  it('a P8 store whose append never settles: the resolution, the P7 row and the replay are all exactly as without it', async () => {
    const dir = workDir();
    const resolver = authority('resolver-a', notCompleted());
    const host = await freshHost(dir, [ceiling('100'), lifetime('100')], { reconciliation: { authorities: [resolver] } });
    const live = await pay(host, '100', 'p12-evidence-stuck');
    await host.close();
    const stuckHost = await (async () => {
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
        AOC_ENTERPRISE_EXECUTION_RESOLUTION_SQLITE_PATH: file.resolutions,
        AOC_ENTERPRISE_KERNEL_AUTHORITY_ORGANIZATION_ID: ORG,
      });
      const adapter = createRecordingExecutionAdapter(() => ({ outcome: 'unconfirmed' }));
      const stuck = authority('resolver-a', notCompleted());
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
        governedActionOrchestrator: { enabled: true, trustDomainId: TRUST_DOMAIN, grantPolicy: (query) => ({ grantExpiresAt: new Date(Date.parse(query.evaluatedAt) + 10 * 60 * 1000).toISOString() }) },
        monetary: { assets: [{ assetId: 'USD', scale: 2 }], financialActions: [ACTION] },
        authorityEventStream: {
          store: {
            providerKind: 'memory',
            append: () => new Promise<never>(() => {}),
            readStream: async () => [],
            verifyStream: async (_context, streamId) => ({ streamId, valid: true, eventCount: 0, failures: [] }),
            health: async () => ({ status: 'healthy', readable: true, writable: true, schemaVersion: 'x', checkedAt: new Date().toISOString() }),
            close: async () => {},
          },
        },
        executionReconciliation: { enabled: true, authorities: [stuck], selectAuthority: () => 'resolver-a' },
      });
      const close = async () => {
        await enterprise.close();
        await authorityStore.close();
      };
      closers.push(close);
      return { enterprise, adapter, authorities: [stuck], close } satisfies Host;
    })();
    const reconciled = await reconcile(stuckHost, live.executionId);
    assert.equal(reconciled.outcome === 'resolved' ? reconciled.capacity : reconciled.outcome, 'adjusted');
    assert.equal((await pay(stuckHost, '100', 'p12-evidence-stuck')).status, 'execution_failed');
    assert.equal(stuckHost.adapter.callCount, 0);
    await stuckHost.close();
  });
});
