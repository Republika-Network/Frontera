import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ExecutionAdapterResult, ValidatedExecutionAction } from '../../features/execution-runtime/index.js';
import { createRecordingExecutionAdapter, type RecordingExecutionAdapter } from '../../features/execution-runtime/tests/execution-fixture.js';
import { KernelGrantCapability } from '../../kernel/orchestration/grant-adapter.js';
import { createEnterprise, type AocEnterprise, type CreateEnterpriseOptions } from '../composition/composition-root.js';
import { loadEnterpriseConfiguration, type EnterpriseApiKey } from '../configuration/enterprise-configuration.js';
import type { BoundCustomerIdentity } from '../customer-identity/index.js';
import type { GrantAuthorityBinding } from '../execution-governance/index.js';
import type { ExecutionResolutionAuthority, ExecutionResolutionQuery } from '../execution-reconciliation/index.js';
import { GOVERNED_ACTION_REASON_CODES as R } from '../governed-action/index.js';
import { buildDurableAuthorityPayloads, DURABLE_FIXTURE_OPERATOR } from '../kernel-authority/fixtures/durable-authority.fixture.js';
import type { KernelAuthorityMonetaryConstraint as AuthorityConstraint } from '../kernel-authority/contracts.js';
import type { KernelAuthorityStore } from '../kernel-authority/kernel-authority-store.js';
import type { KernelAuthorityProvisioningService } from '../kernel-authority/provisioning-service.js';
import { createSqliteKernelAuthorityStore } from '../kernel-authority/sqlite-kernel-authority-store.js';
import { deriveMppGovernedIdempotencyKey, deriveMppGovernedRequestId } from '../mpp-challenge/business-identity.js';
import type { MppChallengePaymentResult, VerifiedMppChallengeContext } from '../mpp-challenge/contracts.js';
import { isMppChallengeUsableAt } from '../mpp-challenge/protocol.js';
import { MPP_TEST_REALM, chargeRequest, encodeJcs, fakepayNormalizer, paymentChallenge, testCounterpartyResolver, testSelector } from './mpp-challenge-support.js';

/**
 * P13 — MPP challenge adaptation and business-level idempotency, end to end,
 * through the trusted in-process surface and every durable store on SQLite:
 *
 * ```
 * 402 challenge ─ P13 parse/validate/normalize ─ P13 business operation (durable)
 *   ─ governed intent ─ Kernel ─ Governance ─ grant ─ P7 ─ P11 ─ P12 bind ─ claim
 *   ─ fake adapter (reads the P13 context by correlation.requestId, like P14 will)
 * ```
 *
 * The adapter is a test double that records calls; nothing here charges a
 * card, signs a transaction or contacts a merchant.
 */

const ORG = 'org-a';
const TRUST_DOMAIN = 'trust-domain-a';
const ACTION = 'payment.send';
const RESOURCE = 'resource-report-1';
const AGENT = 'agent-a';
const OWNER = 'owner-a';
const SUBJECT = { system: 'payments-app', subjectId: 'principal-agent-a' } as const;
const SECRET = 'AOC_P13_MPP_API_KEY_SENTINEL';
const KEYS: readonly EnterpriseApiKey[] = [{ key: SECRET, organizationId: ORG, customerIdentity: { principalId: 'principal-agent-a', externalSubject: SUBJECT } }];
const NO_TEMPORAL_BOUND: GrantAuthorityBinding = { kind: 'no-temporal-authority-bound', sourceKind: 'organizational-authority', justification: 'Durable Kernel Authority; no mandate window.' };
const A = { organizationId: ORG };
const NOW = '2026-09-24T12:00:00.000Z';

const directories: string[] = [];
const closers: (() => Promise<void>)[] = [];
after(async () => {
  for (const close of closers.reverse()) await close().catch(() => {});
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

function workDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'aoc-p13-'));
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

interface ScriptedAuthority extends ExecutionResolutionAuthority {
  answer: (query: ExecutionResolutionQuery) => unknown;
}

function resolver(): ScriptedAuthority {
  const scripted: ScriptedAuthority = {
    authorityId: 'resolver-a',
    answer: () => ({ outcome: 'unresolved' }),
    async resolve(query) {
      return scripted.answer(query) as never;
    },
  };
  return scripted;
}

interface Host {
  readonly enterprise: AocEnterprise;
  readonly adapter: RecordingExecutionAdapter;
  readonly authority: ScriptedAuthority;
  readonly contexts: VerifiedMppChallengeContext[];
  close(): Promise<void>;
}

async function openHost(dir: string, behaviour: (action: ValidatedExecutionAction) => ExecutionAdapterResult | Promise<ExecutionAdapterResult> = () => ({ outcome: 'completed', providerRef: 'pay-1' })): Promise<Host & { readonly authorityStore: KernelAuthorityStore }> {
  const authorityStore = await createSqliteKernelAuthorityStore(join(dir, 'kernel-authority.sqlite'));
  const configuration = loadEnterpriseConfiguration({
    AOC_ENTERPRISE_PERSISTENCE_PROVIDER: 'sqlite',
    AOC_ENTERPRISE_SQLITE_PATH: join(dir, 'governance.sqlite'),
    AOC_ENTERPRISE_PASSPORT_SQLITE_PATH: join(dir, 'passport.sqlite'),
    AOC_ENTERPRISE_ASSURANCE_SQLITE_PATH: join(dir, 'assurance.sqlite'),
    AOC_ENTERPRISE_BOUNDED_GRANT_SQLITE_PATH: join(dir, 'bounded-grants.sqlite'),
    AOC_ENTERPRISE_EXERCISE_LEDGER_SQLITE_PATH: join(dir, 'exercise-ledger.sqlite'),
    AOC_ENTERPRISE_EXECUTION_OUTCOME_SQLITE_PATH: join(dir, 'execution-outcomes.sqlite'),
    AOC_ENTERPRISE_EXECUTION_RESOLUTION_SQLITE_PATH: join(dir, 'execution-resolutions.sqlite'),
    AOC_ENTERPRISE_AUTHORITY_EVENT_STREAM_SQLITE_PATH: join(dir, 'authority-event-stream.sqlite'),
    AOC_ENTERPRISE_MPP_BUSINESS_OPERATION_SQLITE_PATH: join(dir, 'mpp-business-operations.sqlite'),
    AOC_ENTERPRISE_KERNEL_AUTHORITY_ORGANIZATION_ID: ORG,
  });
  const contexts: VerifiedMppChallengeContext[] = [];
  let enterprise: AocEnterprise | undefined;
  // The adapter stands in for P14's future payment adapter: it receives only a
  // ValidatedExecutionAction, and looks the challenge up by its trusted
  // correlation — nothing more crosses the boundary.
  const adapter = createRecordingExecutionAdapter(async (action) => {
    const context = await enterprise?.mppChallengeContexts?.readByGovernedRequestId(ORG, action.correlation.requestId);
    if (context !== undefined) contexts.push(context);
    return behaviour(action);
  });
  const authority = resolver();
  enterprise = await createEnterprise({
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
    monetary: { assets: [{ assetId: 'USD', scale: 2 }, { assetId: 'USDC', scale: 6 }], financialActions: [ACTION] },
    executionReconciliation: { enabled: true, authorities: [authority], selectAuthority: () => 'resolver-a' },
    mppChallengePayments: { enabled: true, methods: [fakepayNormalizer()], selectChallenge: testSelector, resolveCounterparty: testCounterpartyResolver },
  } satisfies CreateEnterpriseOptions);
  const composed = enterprise;
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await composed.close();
    await authorityStore.close();
  };
  closers.push(close);
  return { enterprise: composed, adapter, authority, contexts, authorityStore, close };
}

async function freshHost(dir: string, constraints: readonly AuthorityConstraint[], behaviour?: Parameters<typeof openHost>[1]) {
  const host = await openHost(dir, behaviour);
  const provisioning = host.enterprise.kernelAuthorityProvisioning;
  assert.ok(provisioning !== undefined);
  await provision(provisioning, constraints);
  return host;
}

async function bound(host: Host): Promise<BoundCustomerIdentity> {
  const admission = host.enterprise.customerIdentityAdmission;
  assert.ok(admission !== undefined);
  const admitted = await admission.admit({ authorizationHeader: `Bearer ${SECRET}` });
  assert.equal(admitted.status, 'bound');
  if (admitted.status !== 'bound') throw new Error('unreachable');
  return admitted.identity;
}

/** A merchant 402 for `baseUnits` cents, with a challenge `id` and `expires` the merchant chose. */
function challenge(options: { readonly id?: string; readonly baseUnits?: string; readonly expires?: string; readonly opaque?: unknown; readonly header?: string; readonly currency?: string; readonly recipient?: string } = {}): string {
  const request = chargeRequest({ amount: options.baseUnits ?? '1000', ...(options.currency !== undefined ? { currency: options.currency } : {}), ...(options.recipient !== undefined ? { recipient: options.recipient } : {}) });
  // Expiry is judged against the host clock (real time here), so the default is comfortably in the future.
  return paymentChallenge({ id: options.id ?? 'ch-a', request, expires: options.expires ?? '2099-01-01T00:00:00Z', ...(options.opaque !== undefined ? { opaque: options.opaque } : {}), ...(options.header !== undefined ? { header: options.header } : {}) });
}

async function pay(host: Host, businessOperationId: string, challenges: string | readonly string[]): Promise<MppChallengePaymentResult> {
  const service = host.enterprise.mppChallengePayments;
  assert.ok(service !== undefined, 'the trusted in-process MPP surface is composed');
  return service.prepareAndGovern(await bound(host), {
    businessOperationId,
    action: ACTION,
    challenges,
    protectedRequest: { resource: RESOURCE, httpMethod: 'GET', expectedRealm: MPP_TEST_REALM },
  });
}

function governed(result: MppChallengePaymentResult) {
  assert.equal(result.outcome, 'governed', JSON.stringify(result));
  if (result.outcome !== 'governed') throw new Error('unreachable');
  return result;
}

async function kernelDecisions(host: Host): Promise<number> {
  return (await host.enterprise.persistence.query({ system: false, organizationId: ORG, actorId: AGENT }, { organizationId: ORG, limit: 200 })).records.length;
}

describe('P13 §188 / §141 / §140 — the same business operation, repeated and raced', () => {
  it('one operation, one governed request, one Kernel decision, adapter ≤ 1 across 100 concurrent submissions', async () => {
    const host = await freshHost(workDir(), [ceiling('100'), lifetime('1000')]);
    const first = governed(await pay(host, 'op-1', challenge()));
    assert.equal(first.result.status, 'executed', JSON.stringify(first.result));
    assert.equal(first.requestId, deriveMppGovernedRequestId({ organizationId: ORG, principalId: 'principal-agent-a', businessOperationId: 'op-1' }), '§87 predicted === governed');
    const decisionsAfterFirst = await kernelDecisions(host);
    assert.ok(decisionsAfterFirst >= 1, 'the counter observes committed decisions');

    const raced = await Promise.all(Array.from({ length: 100 }, () => pay(host, 'op-1', challenge())));
    for (const result of raced) {
      const answer = governed(result);
      assert.equal(answer.requestId, first.requestId);
      assert.equal(answer.result.status, 'executed');
    }
    assert.equal(host.adapter.callCount, 1, 'at most one provider effect');
    assert.equal(await kernelDecisions(host), decisionsAfterFirst, 'replays resolve before the Kernel: no new decision');
    assert.equal((await host.enterprise.mppChallengeContexts?.readByGovernedRequestId(ORG, first.requestId))?.challengeSequence, 1);
    await host.close();
  });

  it('100 concurrent first submissions of one operation still produce at most one effect', async () => {
    const host = await freshHost(workDir(), [ceiling('100'), lifetime('1000')]);
    const raced = await Promise.all(Array.from({ length: 100 }, () => pay(host, 'op-race', challenge())));
    const requestIds = new Set(raced.map((result) => governed(result).requestId));
    assert.equal(requestIds.size, 1, [...requestIds].join(','));
    assert.equal(host.adapter.callCount, 1, 'exactly one provider effect for one business operation');
    assert.equal(raced.filter((result) => result.outcome === 'governed' && result.operation === 'created').length, 1, 'exactly one submission created the operation');
    await host.close();
  });
});

describe('P13 §142 / §189 / §239 — a refreshed challenge after execution', () => {
  it('challenge A executes; challenge B for the same operation replays it — same request, adapter still 1', async () => {
    const host = await freshHost(workDir(), [ceiling('100'), lifetime('1000')]);
    const a = governed(await pay(host, 'op-x', challenge({ id: 'abc', expires: '2099-01-01T00:00:00Z' })));
    assert.equal(a.result.status, 'executed');
    const b = governed(await pay(host, 'op-x', challenge({ id: 'xyz', expires: '2099-01-02T00:00:00Z', opaque: { pi: 'pi_2' } })));
    assert.equal(b.requestId, a.requestId);
    assert.equal(b.operation, 'existing');
    assert.equal(b.challengeSequence, 2);
    assert.equal(b.result.status, 'executed');
    assert.equal(b.result.status === 'executed' ? b.result.replayed : false, true);
    assert.equal(b.result.executionId, a.result.executionId, 'no new execution identity');
    assert.equal(host.adapter.callCount, 1);
    await host.close();
  });
});

describe('P13 §245 / §75–§79 — P11 and P12 outcomes are replayed, never bypassed by a refresh', () => {
  it('§76 execution_failed replays as execution_failed; P13 never decides "failed means retry"', async () => {
    const host = await freshHost(workDir(), [ceiling('100'), lifetime('1000')], () => ({ outcome: 'failed', reason: 'PROVIDER_REJECTED' }));
    const a = governed(await pay(host, 'op-f', challenge({ id: 'f-1' })));
    assert.equal(a.result.status, 'execution_failed');
    const b = governed(await pay(host, 'op-f', challenge({ id: 'f-2' })));
    assert.equal(b.result.status, 'execution_failed');
    assert.equal(b.result.status === 'execution_failed' ? b.result.replayed : false, true);
    assert.equal(host.adapter.callCount, 1);
    await host.close();
  });

  it('§143 execution_unconfirmed stays unconfirmed under a refreshed challenge', async () => {
    const host = await freshHost(workDir(), [ceiling('100'), lifetime('1000')], () => ({ outcome: 'unconfirmed', providerRef: 'job-1' }));
    const a = governed(await pay(host, 'op-u', challenge({ id: 'u-1' })));
    assert.equal(a.result.status, 'execution_unconfirmed');
    const b = governed(await pay(host, 'op-u', challenge({ id: 'u-2' })));
    assert.equal(b.result.status, 'execution_unconfirmed');
    assert.deepEqual([...b.result.reasonCodes], [R.GOVERNED_ACTION_EXECUTION_OUTCOME_UNCONFIRMED]);
    assert.equal(host.adapter.callCount, 1);
    await host.close();
  });

  it('§144 / §78 a P12 completed resolution replays as executed under a refreshed challenge', async () => {
    const host = await freshHost(workDir(), [ceiling('100'), lifetime('1000')], () => ({ outcome: 'unconfirmed', providerRef: 'job-1' }));
    const a = governed(await pay(host, 'op-c', challenge({ id: 'c-1' })));
    host.authority.answer = () => ({ outcome: 'resolved', certainty: 'confirmed-completed', providerRef: 'pay-9' });
    const reconciled = await host.enterprise.executionReconciliation?.reconcile({ organizationId: ORG, executionId: a.result.executionId ?? '' });
    assert.equal(reconciled?.outcome, 'resolved');
    const b = governed(await pay(host, 'op-c', challenge({ id: 'c-2' })));
    assert.equal(b.result.status, 'executed');
    assert.equal(b.result.status === 'executed' ? b.result.providerRef : '', 'pay-9');
    assert.equal(host.adapter.callCount, 1);
    await host.close();
  });

  it('§145 / §79 / §80 / §146 P12 proves non-completion and P7 returns capacity — the same operation is NOT retried; a new operation may execute', async () => {
    const host = await freshHost(workDir(), [ceiling('100'), lifetime('10')], () => ({ outcome: 'unconfirmed', providerRef: 'job-1' }));
    const a = governed(await pay(host, 'op-n', challenge({ id: 'n-1' })));
    assert.equal(a.result.status, 'execution_unconfirmed');
    host.authority.answer = () => ({ outcome: 'resolved', certainty: 'confirmed-not-completed', failure: 'PROVIDER_UNAVAILABLE' });
    const reconciled = await host.enterprise.executionReconciliation?.reconcile({ organizationId: ORG, executionId: a.result.executionId ?? '' });
    assert.equal(reconciled?.outcome === 'resolved' ? reconciled.capacity : undefined, 'adjusted', 'P7 capacity returned');

    const refreshed = governed(await pay(host, 'op-n', challenge({ id: 'n-2', expires: '2099-06-01T00:00:00Z' })));
    assert.equal(refreshed.requestId, a.requestId);
    assert.equal(refreshed.result.status, 'execution_failed', JSON.stringify(refreshed.result));
    assert.equal(refreshed.result.status === 'execution_failed' ? refreshed.result.failure : '', 'PROVIDER_UNAVAILABLE');
    assert.equal(host.adapter.callCount, 1, 'capacity available is never a reason to retry the claimed execution');

    const fresh = governed(await pay(host, 'op-n-retry', challenge({ id: 'n-3' })));
    assert.notEqual(fresh.requestId, a.requestId);
    assert.equal(host.adapter.callCount, 2, 'an explicit new business operation enters governance and may execute');
    await host.close();
  });
});

describe('P13 §96–§98 / §199 / §202 — the challenge proposes; P10 and P7 decide', () => {
  it('a merchant asking more than authority allows is withheld — no provider effect', async () => {
    const host = await freshHost(workDir(), [ceiling('100'), lifetime('1000000000')]);
    const result = governed(await pay(host, 'op-big', challenge({ baseUnits: '100000000' })));
    assert.equal(result.result.status, 'withheld');
    assert.equal(result.result.status === 'withheld' ? result.result.withheldBy : '', 'authority-binding');
    assert.equal(host.adapter.callCount, 0);
    await host.close();
  });

  it('a valid per-action amount is still withheld by the aggregate limit', async () => {
    const host = await freshHost(workDir(), [ceiling('100'), lifetime('15')]);
    assert.equal(governed(await pay(host, 'op-1', challenge())).result.status, 'executed');
    const second = governed(await pay(host, 'op-2', challenge({ id: 'ch-b' })));
    assert.equal(second.result.status, 'withheld');
    assert.equal(second.result.status === 'withheld' ? second.result.withheldBy : '', 'exercise');
    assert.equal(host.adapter.callCount, 1);
    await host.close();
  });
});

describe('P13 §240 — a semantic conflict stops before the Kernel', () => {
  it('op X = 10 USD, then op X = 11 USD: refused; no Kernel decision, no grant, no P7, no adapter', async () => {
    const host = await freshHost(workDir(), [ceiling('100'), lifetime('1000')]);
    governed(await pay(host, 'op-x', challenge()));
    const decisions = await kernelDecisions(host);
    const conflict = await pay(host, 'op-x', challenge({ id: 'ch-11', baseUnits: '1100' }));
    assert.deepEqual(conflict, { outcome: 'refused', refusal: 'business-operation-conflict', businessOperationId: 'op-x' });
    assert.equal(await kernelDecisions(host), decisions);
    assert.equal(host.adapter.callCount, 1);
    await host.close();
  });
});

describe('P13 §215 / §244 / §82–§85 — the P14 handoff by correlation.requestId', () => {
  it('the adapter receives a ValidatedExecutionAction only, and finds the exact accepted challenge by its trusted requestId', async () => {
    const host = await freshHost(workDir(), [ceiling('100'), lifetime('1000')]);
    const header = challenge({ id: 'handoff-1', header: 'Payment-Authorization', opaque: { pi: 'pi_123' } });
    const result = governed(await pay(host, 'op-h', header));
    assert.equal(host.adapter.callCount, 1);
    const action = host.adapter.calls[0];
    assert.ok(action !== undefined);
    assert.deepEqual(Object.keys(action).sort(), ['amount', 'boundedGrantId', 'correlation', 'counterparty', 'notAfter', 'organization', 'resource', 'subject', 'action'].sort(), 'ValidatedExecutionAction is not widened');
    assert.equal(action.correlation.requestId, result.requestId);
    assert.deepEqual(action.amount, { value: '10', unit: 'USD' });
    assert.equal(action.counterparty, 'merchant-a');
    const context = host.contexts[0];
    assert.ok(context !== undefined, 'the adapter found its context by correlation.requestId');
    assert.equal(context.challenge.id, 'handoff-1');
    assert.equal(context.challenge.request, encodeJcs(chargeRequest()), 'the exact accepted request text');
    assert.equal(context.challenge.opaque, encodeJcs({ pi: 'pi_123' }));
    assert.equal(context.challenge.header, 'Payment-Authorization');
    assert.equal(context.credentialHeaderField, 'Payment-Authorization');
    assert.deepEqual(context.terms.amount, action.amount, 'the operation terms agree with the governed exercise');
    assert.equal(isMppChallengeUsableAt(context.challenge, NOW), true, 'P14 re-checks expiry with its own clock');
    assert.equal(await host.enterprise.mppChallengeContexts?.readByGovernedRequestId('org-b', result.requestId), undefined, '§217 tenant-scoped');
    await host.close();
  });
});

describe('P13 §136 / §137 / §242 — restart and exact money', () => {
  it('9007199254740993.01 survives normalization, the business store, a restart and governance, and a refresh after restart maps to the same request', async () => {
    const dir = workDir();
    const big = '900719925474099301';
    const host = await freshHost(dir, [ceiling('9007199254740993.01'), lifetime('90071992547409930')], () => ({ outcome: 'unconfirmed', providerRef: 'job-big' }));
    const a = governed(await pay(host, 'op-big', challenge({ id: 'big-a', baseUnits: big })));
    assert.equal(a.result.status, 'execution_unconfirmed', JSON.stringify(a.result));
    assert.deepEqual(host.adapter.calls[0]?.amount, { value: '9007199254740993.01', unit: 'USD' });
    await host.close();

    const restarted = await openHost(dir);
    const b = governed(await pay(restarted, 'op-big', challenge({ id: 'big-b', baseUnits: big, expires: '2099-02-01T00:00:00Z' })));
    assert.equal(b.requestId, a.requestId);
    assert.equal(b.operation, 'existing');
    assert.equal(b.challengeSequence, 2);
    assert.equal(b.result.status, 'execution_unconfirmed');
    assert.equal(restarted.adapter.callCount, 0, 'no execution after restart');
    const context = await restarted.enterprise.mppChallengeContexts?.readByGovernedRequestId(ORG, a.requestId);
    assert.equal(context?.terms.amount.value, '9007199254740993.01');
    assert.equal(context?.challenge.id, 'big-b');
    assert.equal(context?.challengeSequence, 2);
    await restarted.close();
  });
});

describe('P13 §147 / §148 / §91 — ordinary governed actions are untouched and cannot reach P13 state', () => {
  it('an ordinary caller choosing idempotencyKey "op-1" does not collide with P13 operation "op-1"', async () => {
    const host = await freshHost(workDir(), [ceiling('100'), lifetime('1000')]);
    const p13 = governed(await pay(host, 'op-1', challenge()));
    assert.ok(host.enterprise.governAction !== undefined);
    const ordinary = await host.enterprise.governAction({ action: ACTION, resource: RESOURCE, counterparty: 'merchant-a', amount: { value: '10', currency: 'USD' }, idempotencyKey: 'op-1' }, { authorizationHeader: `Bearer ${SECRET}` });
    const body = ordinary.body as { readonly requestId?: string; readonly status: string };
    assert.notEqual(body.requestId, p13.requestId);
    assert.equal(host.adapter.callCount, 2, 'two distinct requests');
    assert.notEqual(deriveMppGovernedIdempotencyKey({ organizationId: ORG, principalId: 'principal-agent-a', businessOperationId: 'op-1' }), 'op-1');
    await host.close();
  });

  it('the governed-action route refuses P13 vocabulary at the top level and in asserted context', async () => {
    const host = await freshHost(workDir(), [ceiling('100'), lifetime('1000')]);
    assert.ok(host.enterprise.governAction !== undefined);
    const base = { action: ACTION, resource: RESOURCE, amount: { value: '10', currency: 'USD' }, idempotencyKey: 'k-1' };
    for (const key of ['businessOperationId', 'mppChallenge', 'paymentChallenge', 'challengeId', 'mppMethod', 'mppIntent', 'mppRealm']) {
      const reply = await host.enterprise.governAction({ ...base, [key]: 'x' }, { authorizationHeader: `Bearer ${SECRET}` });
      assert.equal((reply.body as { status: string }).status, 'rejected', key);
    }
    for (const key of ['businessOperationId', 'challenge', 'challengeId', 'mppChallenge', 'mppMethod', 'mppIntent', 'paymentChallenge', 'paymentCredential', 'merchantRealm']) {
      const reply = await host.enterprise.governAction({ ...base, assertedContext: { [key]: 'x' } }, { authorizationHeader: `Bearer ${SECRET}` });
      assert.equal((reply.body as { status: string }).status, 'rejected', key);
      assert.deepEqual([...(reply.body as { readonly reasonCodes: readonly string[] }).reasonCodes], [R.GOVERNED_ACTION_INTENT_INVALID]);
    }
    assert.equal(host.adapter.callCount, 0);
    await host.close();
  });
});
