import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createFinancialActionClassifier } from '../../features/monetary-runtime/index.js';
import {
  PAYMENT_PARAMETER_DIMENSIONS,
  PAYMENT_PROFILE_PARAMETERS,
  PAYMENT_PROTOCOL_RESERVED_CONTEXT_KEYS,
  createPaymentGovernanceBinding,
  createPaymentRailExecutionAdapter,
  type PaymentRailResult,
} from '../../features/payment-runtime/index.js';
import { MPP_RESERVED_CONTEXT_KEYS } from '../../features/payment-runtime/protocols/mpp/index.js';
import { DEFAULT_CHARGE, paymentChallenge, testAdapter } from '../../features/payment-runtime/protocols/mpp/tests/mpp-test-support.js';
import { createRecordingPaymentRail, type RecordingPaymentRail } from '../../features/payment-runtime/tests/payment-rail-fixture.js';
import {
  AuthorityStateFreshnessError,
  createAuthorityStateFreshnessBoundary,
  createHttpAuthorityStateWitnessTransport,
  type AuthorityStateEnrollmentContext,
  type AuthorityStateFreshnessBoundary,
} from '../authority-state-freshness/index.js';
import { createSqliteExecutionOutcomeStore } from '../execution-outcome-store/sqlite-execution-outcome-store.js';
import { createSqliteExerciseControlLedger } from '../exercise-control-ledger/sqlite-exercise-control-ledger.js';
import { createGovernanceProfileRegistry } from '../governance-profile/index.js';
import { createSqliteGovernanceStore } from '../governance-store/sqlite-governance-store.js';
import type { GovernedActionResult } from '../governed-action/index.js';
import {
  PAYMENT_BUSINESS_OPERATION_STATE_KIND,
  PAYMENT_BUSINESS_OPERATION_STORE_ANCHORED_SCHEMA_VERSION,
  PaymentProtocolIngressConfigurationError,
  createInMemoryPaymentBusinessOperationStore,
  createPaymentProtocolIngress,
  createSqlitePaymentBusinessOperationStore,
  derivePaymentBusinessOperationRequestId,
  type DurablePaymentBusinessOperationStore,
  type PaymentBusinessOperationStore,
  type PaymentProtocolIngress,
  type PaymentProtocolIngressResult,
} from '../payment-protocol-ingress/index.js';
import { ScriptedWitnessTransport, WITNESS_TOKEN, boundaryFor, closeAllWitnesses, connect, startWitness, witnessRows, type StartedWitness } from './core07-freshness-fixture.js';
import { ALLOWED_INTENT, IDENTITY, NO_TEMPORAL_BOUND, ORG, TEST_ASSETS, buildGovernedWorld, monetaryAuthority, type GovernedWorld } from './governed-action-support.js';
import { storeEntry } from './pay04-protocol-support.js';

/**
 * PAY-04 post-merge hardening — challenge ownership survives rollback.
 *
 * The merged PAY-04 pinned a residual: the one-operation-per-challenge record
 * lived only in the business-operation store, so after that store was lost or
 * stale-restored, the **same** already-paid challenge presented under a **new**
 * `businessOperationId` derived a different governed key — a different
 * governed request — and the rail was called a second time.
 *
 * The fix anchors the store's ownership history at the CORE-07 external
 * witness (slot `payment-business-operation-state`): every accepted challenge
 * is a witness transition completed before governance, every presentation is
 * compared with the witness first, and an older, lost, forked or pending
 * history refuses the open. These tests use the reference witness over real
 * loopback HTTP, with its own database in its own directory — outside the
 * restore domain of every store under test, which is the deployment rule the
 * guarantee rests on. Every case counts governance calls and rail calls.
 *
 * F1 – F12 are the hardening's regression matrix.
 */

const ACTION = ALLOWED_INTENT.action;
const ACCOUNT = ALLOWED_INTENT.resource;
const BINDING = createPaymentGovernanceBinding({ action: ACTION });
const MONETARY = Object.freeze({ assets: TEST_ASSETS, actionClassifier: createFinancialActionClassifier({ financialActions: [ACTION] }) });
const GOVERNANCE = createGovernanceProfileRegistry({
  parameterDimensions: PAYMENT_PARAMETER_DIMENSIONS,
  actionClasses: [{ id: 'payment', actions: [ACTION] }],
  resourceClasses: [{ id: 'governed-account', resources: [ACCOUNT] }],
  profiles: [
    {
      profileId: 'governed-payment',
      version: 1,
      owner: ORG,
      provenance: { authoredBy: 'operator:treasury', approvedBy: 'operator:security' },
      actionClass: 'payment',
      resourceClass: 'governed-account',
      parameters: PAYMENT_PROFILE_PARAMETERS,
      materialFacts: [],
      relevantPolicies: [],
    },
  ],
  reservedContextKeys: [...PAYMENT_PROTOCOL_RESERVED_CONTEXT_KEYS, ...MPP_RESERVED_CONTEXT_KEYS],
});

const directories: string[] = [];
after(async () => {
  await closeAllWitnesses();
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});
function workDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'aoc-pay04-rollback-'));
  directories.push(directory);
  return directory;
}

/** The merchant's challenges expire at 12:05; the ingress observes at 12:00. */
let tick = 0;
const ingressClock = (): string => new Date(Date.parse('2026-09-24T12:00:00.000Z') + (tick += 1)).toISOString();

const OPERATOR: AuthorityStateEnrollmentContext = { operator: true, operatorId: 'operator:payments-sre', attestation: 'verified-local-state-is-current' };

function anchored(path: string, boundary: AuthorityStateFreshnessBoundary, options: { readonly now?: () => string; readonly enrollment?: AuthorityStateEnrollmentContext } = {}): Promise<DurablePaymentBusinessOperationStore> {
  return createSqlitePaymentBusinessOperationStore(path, { now: options.now ?? ingressClock, freshness: { boundary, ...(options.enrollment !== undefined ? { enrollment: options.enrollment } : {}) } });
}

/** A boundary whose witness calls the test can script; by default it follows `target()` — so a witness restart (new port) is followed. */
async function scriptedBoundary(witness: StartedWitness): Promise<{ readonly boundary: AuthorityStateFreshnessBoundary; readonly transport: ScriptedWitnessTransport; follow(next: StartedWitness): void }> {
  let target = createHttpAuthorityStateWitnessTransport({ endpoint: witness.endpoint, credential: WITNESS_TOKEN });
  const transport = new ScriptedWitnessTransport(target);
  transport.answer = (request) => target.call(request, { timeoutMs: 2_000 });
  const { anchor, monitor } = await connect(witness, { transport });
  return {
    boundary: createAuthorityStateFreshnessBoundary({ anchor, monitor, organizationId: ORG }),
    transport,
    follow(next) {
      target = createHttpAuthorityStateWitnessTransport({ endpoint: next.endpoint, credential: WITNESS_TOKEN });
    },
  };
}

interface Payments {
  readonly world: GovernedWorld;
  readonly rail: RecordingPaymentRail;
}

function payments(behaviour: () => PaymentRailResult = () => ({ status: 'completed', externalReference: 'prov-1' })): Payments {
  const rail = createRecordingPaymentRail(behaviour);
  const world = buildGovernedWorld({ monetary: MONETARY, governance: GOVERNANCE, financialAuthority: monetaryAuthority('5000', '20000'), executionAdapter: createPaymentRailExecutionAdapter({ rail, binding: BINDING }) });
  return { world, rail };
}

interface Ingress {
  readonly ingress: PaymentProtocolIngress;
  /** Every intent the ingress handed to governance. */
  readonly governed: unknown[];
}

function ingressOver(store: PaymentBusinessOperationStore, world: GovernedWorld): Ingress {
  const governed: unknown[] = [];
  const orchestrator = {
    organizationId: world.orchestrator.organizationId,
    govern: (identity: Parameters<GovernedWorld['orchestrator']['govern']>[0], intent: unknown) => {
      governed.push(intent);
      return world.orchestrator.govern(identity, intent);
    },
  };
  return { ingress: createPaymentProtocolIngress({ orchestrator, store, adapters: [testAdapter()], binding: BINDING, monetary: MONETARY, governance: GOVERNANCE, now: ingressClock }), governed };
}

/** Challenge C is the default challenge (`ch-1`); operation A is `checkout-A`. */
function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    businessOperationId: 'checkout-A',
    protocol: 'mpp',
    challenges: paymentChallenge(),
    protectedRequest: { target: 'merchant:report-42', method: 'GET' },
    payment: { source: { accountId: ACCOUNT }, purpose: 'purchase' },
    envelope: { assertedContext: ALLOWED_INTENT.assertedContext },
    ...overrides,
  };
}
const UNDER_B = { businessOperationId: 'checkout-B' };

function governedOf(outcome: PaymentProtocolIngressResult): GovernedActionResult & { readonly operation: string; readonly challenge: string; readonly sequence: number } {
  assert.equal(outcome.outcome, 'governed', JSON.stringify(outcome));
  if (outcome.outcome !== 'governed') throw new Error('unreachable');
  return { ...outcome.result, operation: outcome.operation, challenge: outcome.challenge, sequence: outcome.challengeSequence };
}

function refusalOf(outcome: PaymentProtocolIngressResult): string {
  assert.equal(outcome.outcome, 'refused', JSON.stringify(outcome));
  return outcome.outcome === 'refused' ? outcome.refusal : '';
}

const freshnessCode = (code: string) => (error: { code?: string }) => error.code === code;

/** A file copied as an operator would restore it: the live file and its WAL siblings removed first. */
function restoreFile(from: string, to: string): void {
  for (const suffix of ['', '-wal', '-shm']) if (existsSync(`${to}${suffix}`)) rmSync(`${to}${suffix}`);
  copyFileSync(from, to);
}

function remove(path: string): void {
  for (const suffix of ['', '-wal', '-shm']) if (existsSync(`${path}${suffix}`)) rmSync(`${path}${suffix}`);
}

async function witnessed(witness: StartedWitness): Promise<{ readonly sequence: number; readonly pending: boolean }> {
  const row = (await witnessRows(witness.databasePath)).find((entry) => entry['state_kind'] === PAYMENT_BUSINESS_OPERATION_STATE_KIND);
  return { sequence: Number(row?.['committed_sequence'] ?? -1), pending: row?.['pending_sequence'] !== null && row?.['pending_sequence'] !== undefined };
}

describe('PAY-04 hardening — the merged fail-open, and why the merged composition is now refused', () => {
  it('OLD BEHAVIOUR (store level): an unanchored store stale-restored to before challenge C accepts C under a new operation — the record the duplicate barrier rests on is gone', async () => {
    const path = join(workDir(), 'unanchored.sqlite');
    await (await createSqlitePaymentBusinessOperationStore(path, { now: ingressClock })).close();
    copyFileSync(path, `${path}.stale`);
    const store = await createSqlitePaymentBusinessOperationStore(path, { now: ingressClock });
    await store.record({ organizationId: 'org-a' }, storeEntry({ businessOperationId: 'op-A' }, { id: 'C' }));
    await assert.rejects(store.record({ organizationId: 'org-a' }, storeEntry({ businessOperationId: 'op-B' }, { id: 'C' })), freshnessCode('PAYMENT_BUSINESS_OPERATION_CHALLENGE_CONFLICT'), 'intact: refused');
    await store.close();
    restoreFile(`${path}.stale`, path);
    const restored = await createSqlitePaymentBusinessOperationStore(path, { now: ingressClock });
    const reused = await restored.record({ organizationId: 'org-a' }, storeEntry({ businessOperationId: 'op-B' }, { id: 'C' }));
    assert.equal(reused.operationOutcome, 'created', 'the stale copy forgot that C was owned by op-A');
    assert.notEqual(reused.operation.governedRequestId, derivePaymentBusinessOperationRequestId({ organizationId: 'org-a', principalId: 'principal-a', businessOperationId: 'op-A' }), 'a different governed request: the governed spine sees a new purchase');
    await restored.close();
  });

  it('the ingress refuses to compose the merged composition — a durable store without a witness — and a store anchored for another organization', async () => {
    const { world } = payments();
    const unanchored = await createSqlitePaymentBusinessOperationStore(join(workDir(), 'legacy.sqlite'), { now: ingressClock });
    assert.throws(() => ingressOver(unanchored, world), (error: unknown) => error instanceof PaymentProtocolIngressConfigurationError && /CORE-07 freshness witness/.test(error.message));
    await unanchored.close();
    const foreign = { record: async () => assert.fail('never called') } as unknown as PaymentBusinessOperationStore;
    assert.throws(() => ingressOver(foreign, world), PaymentProtocolIngressConfigurationError, 'an unknown store is not trusted to be anchored');

    const witness = await startWitness();
    const elsewhere = await createSqlitePaymentBusinessOperationStore(join(workDir(), 'other-org.sqlite'), { now: ingressClock, freshness: { boundary: await boundaryFor(witness, 'org-elsewhere') } });
    assert.throws(() => ingressOver(elsewhere, world), /another organization/);
    await elsewhere.close();
    // The volatile test store remains composable — it is volatile by construction, and says so.
    assert.doesNotThrow(() => ingressOver(createInMemoryPaymentBusinessOperationStore({ now: ingressClock }), world));
  });
});

describe('PAY-04 hardening — F1 – F3: challenge C cannot be repackaged as a new purchase, across restart, stale restore or loss', () => {
  it('F1: C + A pays → normal restart → C + B is a conflict before governance; zero further rail calls', async () => {
    const witness = await startWitness();
    const path = join(workDir(), 'bop.sqlite');
    const { world, rail } = payments();
    const store = await anchored(path, await boundaryFor(witness, ORG));
    assert.equal(governedOf(await ingressOver(store, world).ingress.prepareAndGovern(IDENTITY, request())).status, 'executed');
    await store.close();
    const restarted = await anchored(path, await boundaryFor(witness, ORG));
    const after = ingressOver(restarted, world);
    assert.equal(refusalOf(await after.ingress.prepareAndGovern(IDENTITY, request(UNDER_B))), 'challenge-conflict');
    assert.equal(after.governed.length, 0, 'never reached governance');
    assert.equal(rail.callCount, 1);
    await restarted.close();
  });

  for (const [label, status] of [
    ['F2: completed', 'completed'],
    ['F3: unconfirmed', 'unconfirmed'],
  ] as const) {
    it(`${label} — C + A → the store stale-restored to before C, or lost → the open is refused before anything can govern; zero second rail calls (formerly the pinned SEC-INV-242 residual)`, async () => {
      const witness = await startWitness();
      const dir = workDir();
      const path = join(dir, 'bop.sqlite');
      const { world, rail } = payments(() => ({ status, externalReference: 'ref-1' }));
      // An empty anchored store, backed up before the payment.
      await (await anchored(path, await boundaryFor(witness, ORG))).close();
      copyFileSync(path, join(dir, 'before-C.sqlite'));
      const store = await anchored(path, await boundaryFor(witness, ORG));
      const first = governedOf(await ingressOver(store, world).ingress.prepareAndGovern(IDENTITY, request()));
      assert.equal(first.status, status === 'completed' ? 'executed' : 'execution_unconfirmed');
      await store.close();
      const kernelCalls = world.kernelRequests.length;

      // Stale restore: the copy predates C's ownership.
      restoreFile(join(dir, 'before-C.sqlite'), path);
      await assert.rejects(anchored(path, await boundaryFor(witness, ORG)), freshnessCode('AUTHORITY_FRESHNESS_ROLLBACK_DETECTED'));
      // Loss: the file is gone, and a new empty one is never a fresh start.
      remove(path);
      await assert.rejects(anchored(path, await boundaryFor(witness, ORG)), freshnessCode('AUTHORITY_FRESHNESS_ROLLBACK_DETECTED'));
      // Nor is the stale copy ever served without its witness.
      remove(path);
      copyFileSync(join(dir, 'before-C.sqlite'), path);
      await assert.rejects(createSqlitePaymentBusinessOperationStore(path, { now: ingressClock }), /never opened without it/);

      assert.equal(world.kernelRequests.length, kernelCalls, 'nothing reached the Kernel');
      assert.equal(rail.callCount, 1, 'C + B never became a second payment');
    });
  }
});

describe('PAY-04 hardening — F4: coordinated rollback of PAY-04 + Governance Store + P11 + P7, witness current', () => {
  it('the restored world has forgotten payment A entirely — and the PAY-04 open still refuses before governance; zero second rail calls', async () => {
    const witness = await startWitness();
    const dir = workDir();
    const files = { bop: join(dir, 'bop.sqlite'), governance: join(dir, 'governance.sqlite'), outcomes: join(dir, 'outcomes.sqlite'), ledger: join(dir, 'ledger.sqlite') } as const;
    const rail = createRecordingPaymentRail(() => ({ status: 'completed', externalReference: 'prov-A' }));
    const p11Clock = (): string => new Date(Date.parse('2026-01-01T00:00:00.000Z') + (tick += 1)).toISOString();
    const open = async () => {
      const governance = await createSqliteGovernanceStore(files.governance);
      const outcomes = await createSqliteExecutionOutcomeStore(files.outcomes, { now: p11Clock });
      const ledger = await createSqliteExerciseControlLedger(files.ledger, { now: p11Clock });
      const world = buildGovernedWorld({
        monetary: MONETARY,
        governance: GOVERNANCE,
        financialAuthority: monetaryAuthority('5000', '20000'),
        executionAdapter: createPaymentRailExecutionAdapter({ rail, binding: BINDING }),
        store: governance,
        executionOutcomes: outcomes,
        exerciseControls: { policy: () => [], revalidateAuthorityBinding: () => NO_TEMPORAL_BOUND, reservationLedger: ledger },
      });
      return { world, close: async () => Promise.all([governance.close(), outcomes.close(), ledger.close()]) };
    };

    // The coordinated snapshot: every local store, empty, before payment A.
    const before = await open();
    await (await anchored(files.bop, await boundaryFor(witness, ORG))).close();
    await before.close();
    for (const file of Object.values(files)) copyFileSync(file, `${file}.snapshot`);

    const live = await open();
    const store = await anchored(files.bop, await boundaryFor(witness, ORG));
    const paid = governedOf(await ingressOver(store, live.world).ingress.prepareAndGovern(IDENTITY, request()));
    assert.equal(paid.status, 'executed');
    assert.equal(rail.callCount, 1);
    await store.close();
    await live.close();

    // One backup rolls every local store back together. The witness, outside that backup, is not.
    for (const file of Object.values(files)) restoreFile(`${file}.snapshot`, file);
    const restored = await open();
    assert.equal(await restored.world.outcomes.read({ organizationId: ORG }, paid.executionId!), undefined, 'P11 forgot the execution');
    const governanceStore = await createSqliteGovernanceStore(files.governance);
    assert.equal(await governanceStore.getByRequestId({ system: false, organizationId: ORG }, paid.requestId!), null, 'the Governance Store forgot the decision');
    await governanceStore.close();

    // With every at-most-once record below it erased, only the witness remembers that C is owned — and it refuses the stale image.
    await assert.rejects(anchored(files.bop, await boundaryFor(witness, ORG)), freshnessCode('AUTHORITY_FRESHNESS_ROLLBACK_DETECTED'));
    // A replacement empty PAY-04 file (the PAY-04 store "lost" instead of restored) is refused the same way.
    remove(files.bop);
    await assert.rejects(anchored(files.bop, await boundaryFor(witness, ORG)), freshnessCode('AUTHORITY_FRESHNESS_ROLLBACK_DETECTED'));
    assert.equal(restored.world.kernelRequests.length, 0, 'nothing reached the restored Kernel');
    assert.equal(rail.callCount, 1, 'zero second rail calls');
    await restored.close();
  });
});

describe('PAY-04 hardening — F5 / F6 / divergence: the witness itself rolled back, unavailable, or diverged', () => {
  it('F5: local history current, witness rolled back alone → a running process refuses before governance, and a restart is refused as a fork', async () => {
    let witness = await startWitness();
    const dir = workDir();
    const path = join(dir, 'bop.sqlite');
    const scripted = await scriptedBoundary(witness);
    const { world, rail } = payments();
    const store = await anchored(path, scripted.boundary);
    const { ingress, governed } = ingressOver(store, world);
    // The witness's own state, captured before C is owned.
    await witness.close();
    copyFileSync(witness.databasePath, join(dir, 'witness-before.sqlite'));
    witness = await witness.restart();
    scripted.follow(witness);
    governedOf(await ingress.prepareAndGovern(IDENTITY, request()));
    // The witness alone is rolled back.
    await witness.close();
    restoreFile(join(dir, 'witness-before.sqlite'), witness.databasePath);
    witness = await witness.restart();
    scripted.follow(witness);

    const governedBefore = governed.length;
    assert.equal(refusalOf(await ingress.prepareAndGovern(IDENTITY, request(UNDER_B))), 'store-freshness-unverified');
    assert.equal(refusalOf(await ingress.prepareAndGovern(IDENTITY, request({ challenges: paymentChallenge({ id: 'ch-refresh' }) }))), 'store-freshness-unverified', 'even a refresh of A');
    assert.equal(governed.length, governedBefore, 'never reached governance');
    assert.equal((await store.health()).freshness, 'forked');
    assert.equal((await store.health()).status, 'unhealthy');
    await store.close();
    await assert.rejects(anchored(path, await boundaryFor(witness, ORG)), freshnessCode('AUTHORITY_FRESHNESS_FORK_DETECTED'));
    assert.equal(rail.callCount, 1);
  });

  it('F6: the witness unavailable → every presentation (new operation, refresh, exact replay) refuses before governance; a restart is refused while it lasts', async () => {
    const witness = await startWitness();
    const path = join(workDir(), 'bop.sqlite');
    const boundary = await boundaryFor(witness, ORG);
    const { world, rail } = payments();
    const store = await anchored(path, boundary);
    const { ingress, governed } = ingressOver(store, world);
    governedOf(await ingress.prepareAndGovern(IDENTITY, request()));
    const kernelCalls = world.kernelRequests.length;
    await witness.close();
    for (const presented of [request(UNDER_B), request({ businessOperationId: 'checkout-new', challenges: paymentChallenge({ id: 'ch-new' }) }), request({ challenges: paymentChallenge({ id: 'ch-2' }) }), request()]) {
      assert.equal(refusalOf(await ingress.prepareAndGovern(IDENTITY, presented)), 'store-freshness-unverified');
    }
    assert.equal(governed.length, 1, 'no timeout-to-success, no "the local store looks valid"');
    assert.equal(world.kernelRequests.length, kernelCalls);
    assert.equal(rail.callCount, 1);
    assert.equal((await store.health()).freshness, 'unavailable');
    await store.close();
    await assert.rejects(anchored(path, boundary), freshnessCode('AUTHORITY_FRESHNESS_UNAVAILABLE'));
  });

  it('a witness that refuses one prepare (authentication) → that presentation is refused with nothing written; the store is not disabled, and the next presentation proceeds', async () => {
    const witness = await startWitness();
    const scripted = await scriptedBoundary(witness);
    const { world, rail } = payments();
    const store = await anchored(join(workDir(), 'bop.sqlite'), scripted.boundary);
    const { ingress, governed } = ingressOver(store, world);
    const forward = scripted.transport.answer;
    let refuseNext = true;
    scripted.transport.answer = (call, next) => {
      if (call.operation === 'prepare' && refuseNext) {
        refuseNext = false;
        return Promise.reject(new AuthorityStateFreshnessError('AUTHORITY_FRESHNESS_AUTHENTICATION_FAILED', 'simulated credential refusal'));
      }
      return forward(call, next);
    };
    assert.equal(refusalOf(await ingress.prepareAndGovern(IDENTITY, request())), 'store-freshness-unverified');
    assert.equal(governed.length, 0);
    assert.deepEqual(await witnessed(witness), { sequence: 0, pending: false }, 'nothing was prepared');
    assert.equal(await store.readOperation({ organizationId: ORG }, IDENTITY.principal.principalId, 'checkout-A'), undefined, 'nothing was written');
    assert.equal(governedOf(await ingress.prepareAndGovern(IDENTITY, request())).status, 'executed', 'a refused prepare is not a sticky failure');
    assert.equal(rail.callCount, 1);
    await store.close();
  });

  it('divergence: two histories at the same position (a same-snapshot restore of both, then different ownership) → the other copy is refused as a fork', async () => {
    let witness = await startWitness();
    const dir = workDir();
    const path = join(dir, 'bop.sqlite');
    const scripted = await scriptedBoundary(witness);
    const first = await anchored(path, scripted.boundary);
    await first.record({ organizationId: ORG }, entryFor('op-A', 'C'));
    await first.close();
    copyFileSync(path, join(dir, 'local-1.sqlite'));
    await witness.close();
    copyFileSync(witness.databasePath, join(dir, 'witness-1.sqlite'));
    witness = await witness.restart();
    scripted.follow(witness);
    // History 1: op-A takes D.
    const one = await anchored(path, await boundaryFor(witness, ORG));
    await one.record({ organizationId: ORG }, entryFor('op-A', 'D'));
    await one.close();
    copyFileSync(path, join(dir, 'local-2a.sqlite'));
    // The forbidden same-snapshot restore of BOTH, then history 2: op-A takes E at the same position.
    await witness.close();
    restoreFile(join(dir, 'witness-1.sqlite'), witness.databasePath);
    witness = await witness.restart();
    restoreFile(join(dir, 'local-1.sqlite'), path);
    const two = await anchored(path, await boundaryFor(witness, ORG));
    await two.record({ organizationId: ORG }, entryFor('op-A', 'E'));
    await two.close();
    // History 1's file against history 2's witness: same sequence, different ownership.
    restoreFile(join(dir, 'local-2a.sqlite'), path);
    await assert.rejects(anchored(path, await boundaryFor(witness, ORG)), freshnessCode('AUTHORITY_FRESHNESS_FORK_DETECTED'));
  });
});

/** A store entry in the served organization (the anchored store serves exactly one). */
function entryFor(businessOperationId: string, challengeId: string, value?: string) {
  return storeEntry({ organizationId: ORG, businessOperationId, ...(value !== undefined ? { value } : {}) }, { id: challengeId });
}

describe('PAY-04 hardening — F7 / F8: crash safety of the witness transition', () => {
  it('F7: prepared at the witness, never committed locally (a crash in between) → the restart refuses: pending recovery', async () => {
    const witness = await startWitness();
    const path = join(workDir(), 'bop.sqlite');
    const store = await anchored(path, await boundaryFor(witness, ORG));
    await store.record({ organizationId: ORG }, entryFor('op-A', 'C'));
    await store.close();
    // The crash: a writer prepared ownership of the next challenge, and died before its BEGIN IMMEDIATE committed.
    const { anchor } = await connect(witness);
    const state = await anchor.read({ stateKind: PAYMENT_BUSINESS_OPERATION_STATE_KIND, organizationId: ORG });
    assert.equal(state.status, 'bound');
    if (state.status !== 'bound') return;
    const expected = { stateKind: PAYMENT_BUSINESS_OPERATION_STATE_KIND, organizationId: ORG, storeId: state.storeId, ...state.committed } as const;
    await anchor.prepare(expected, { ...expected, sequence: expected.sequence + 1, stateDigest: `sha256:${'ab'.repeat(32)}` });
    await assert.rejects(anchored(path, await boundaryFor(witness, ORG)), freshnessCode('AUTHORITY_FRESHNESS_PENDING_RECOVERY'));
  });

  it('F7 / C5 (in process): the local commit fails after the prepare → refused, sticky for the process, and the restart refuses too; nothing reached governance', async () => {
    const witness = await startWitness();
    const path = join(workDir(), 'bop.sqlite');
    let clockBroken = false;
    const store = await anchored(path, await boundaryFor(witness, ORG), { now: () => (clockBroken ? 'not-an-instant' : ingressClock()) });
    const { world, rail } = payments();
    const { ingress, governed } = ingressOver(store, world);
    clockBroken = true; // sampled inside BEGIN IMMEDIATE, after the witness prepared: the commit throws.
    assert.equal(refusalOf(await ingress.prepareAndGovern(IDENTITY, request())), 'store-freshness-unverified');
    clockBroken = false;
    assert.equal(refusalOf(await ingress.prepareAndGovern(IDENTITY, request({ businessOperationId: 'checkout-other', challenges: paymentChallenge({ id: 'other' }) }))), 'store-freshness-unverified', 'sticky until trusted recovery');
    assert.equal(governed.length, 0);
    assert.equal(rail.callCount, 0);
    assert.equal((await store.health()).freshness, 'pending-recovery');
    assert.deepEqual(await witnessed(witness), { sequence: 0, pending: true });
    await store.close();
    await assert.rejects(anchored(path, await boundaryFor(witness, ORG)), freshnessCode('AUTHORITY_FRESHNESS_PENDING_RECOVERY'));
  });

  it('F8: committed locally, finalize lost → the payment proceeds (ownership is already prepared at the witness); further presentations refuse until finalized; the restart completes it and C + B stays a conflict', async () => {
    const witness = await startWitness();
    const dir = workDir();
    const path = join(dir, 'bop.sqlite');
    const scripted = await scriptedBoundary(witness);
    const { world, rail } = payments();
    const store = await anchored(path, scripted.boundary);
    const { ingress, governed } = ingressOver(store, world);
    const forward = scripted.transport.answer;
    scripted.transport.answer = (call, next) => (call.operation === 'finalize' ? Promise.reject(new Error('simulated crash before finalize')) : forward(call, next));
    assert.equal(governedOf(await ingress.prepareAndGovern(IDENTITY, request())).status, 'executed');
    assert.deepEqual(await witnessed(witness), { sequence: 0, pending: true }, 'C is prepared — protected — at the witness');
    // A stale restore now would be refused: the image before C is the witnessed committed state with C pending.
    assert.equal(refusalOf(await ingress.prepareAndGovern(IDENTITY, request({ challenges: paymentChallenge({ id: 'ch-2' }) }))), 'store-freshness-unverified', 'refused while the witness cannot finalize');
    assert.equal(governed.length, 1);
    await store.close();
    scripted.transport.answer = forward;
    const restarted = await anchored(path, await boundaryFor(witness, ORG));
    assert.deepEqual(await witnessed(witness), { sequence: 1, pending: false }, 'finalized at restart, conservatively: the local file holds exactly the prepared head');
    const after = ingressOver(restarted, world);
    assert.equal(refusalOf(await after.ingress.prepareAndGovern(IDENTITY, request(UNDER_B))), 'challenge-conflict');
    assert.equal(after.governed.length, 0);
    assert.equal(rail.callCount, 1);
    await restarted.close();
  });
});

describe('PAY-04 hardening — F9: one challenge raced for two operations (in process; across processes see pay04-business-operation-concurrency)', () => {
  it('exactly one ownership transition wins; the other is a conflict before governance', async () => {
    for (let round = 0; round < 3; round += 1) {
      const witness = await startWitness();
      const store = await anchored(join(workDir(), 'bop.sqlite'), await boundaryFor(witness, ORG));
      const { world, rail } = payments();
      const { ingress } = ingressOver(store, world);
      const outcomes = await Promise.all([ingress.prepareAndGovern(IDENTITY, request()), ingress.prepareAndGovern(IDENTITY, request(UNDER_B)), ingress.prepareAndGovern(IDENTITY, request({ businessOperationId: 'checkout-Z' }))]);
      assert.equal(outcomes.filter((outcome) => outcome.outcome === 'governed').length, 1, JSON.stringify(outcomes));
      assert.equal(outcomes.filter((outcome) => outcome.outcome === 'refused' && outcome.refusal === 'challenge-conflict').length, 2);
      assert.equal(rail.callCount, 1);
      assert.deepEqual(await witnessed(witness), { sequence: 1, pending: false }, 'one ownership transition');
      await store.close();
    }
  });
});

describe('PAY-04 hardening — F10 – F12: refreshed challenges are owned and anchored too; refresh stays a replay', () => {
  it('F10: a fresh challenge D for existing operation A is accepted and anchored as owned by A; D under B then conflicts', async () => {
    const witness = await startWitness();
    const path = join(workDir(), 'bop.sqlite');
    const { world, rail } = payments();
    const store = await anchored(path, await boundaryFor(witness, ORG));
    const { ingress } = ingressOver(store, world);
    governedOf(await ingress.prepareAndGovern(IDENTITY, request()));
    const refreshed = governedOf(await ingress.prepareAndGovern(IDENTITY, request({ challenges: paymentChallenge({ id: 'D' }) })));
    assert.deepEqual([refreshed.operation, refreshed.challenge, refreshed.sequence], ['existing', 'appended', 2]);
    assert.equal(refreshed.status === 'executed' && refreshed.replayed, true, 'a replay of A, not a second payment');
    assert.deepEqual(await witnessed(witness), { sequence: 2, pending: false }, 'D is an ownership transition at the witness');
    assert.equal(refusalOf(await ingress.prepareAndGovern(IDENTITY, request({ ...UNDER_B, challenges: paymentChallenge({ id: 'D' }) }))), 'challenge-conflict');
    assert.equal(rail.callCount, 1);
    await store.close();
  });

  it('F11: a rollback that loses only D (C kept) is still detected — every owned challenge is in the anchored history', async () => {
    const witness = await startWitness();
    const dir = workDir();
    const path = join(dir, 'bop.sqlite');
    const store = await anchored(path, await boundaryFor(witness, ORG));
    await store.record({ organizationId: ORG }, entryFor('op-A', 'C'));
    await store.close();
    copyFileSync(path, join(dir, 'with-C.sqlite'));
    const later = await anchored(path, await boundaryFor(witness, ORG));
    await later.record({ organizationId: ORG }, entryFor('op-A', 'D'));
    await later.close();
    restoreFile(join(dir, 'with-C.sqlite'), path);
    await assert.rejects(anchored(path, await boundaryFor(witness, ORG)), freshnessCode('AUTHORITY_FRESHNESS_ROLLBACK_DETECTED'));
  });

  it('F12: the same operation refreshed — and the exact challenge again — replays; no extra rail call; changed terms still conflict', async () => {
    const witness = await startWitness();
    const { world, rail } = payments(() => ({ status: 'unconfirmed', externalReference: 'job-1' }));
    const store = await anchored(join(workDir(), 'bop.sqlite'), await boundaryFor(witness, ORG));
    const { ingress, governed } = ingressOver(store, world);
    const first = governedOf(await ingress.prepareAndGovern(IDENTITY, request()));
    for (const id of ['r-2', 'r-3']) {
      const again = governedOf(await ingress.prepareAndGovern(IDENTITY, request({ challenges: paymentChallenge({ id }) })));
      assert.deepEqual([again.status, again.executionId], ['execution_unconfirmed', first.executionId]);
    }
    const exact = governedOf(await ingress.prepareAndGovern(IDENTITY, request()));
    assert.deepEqual([exact.operation, exact.challenge, exact.sequence], ['existing', 'existing', 1]);
    assert.deepEqual(await witnessed(witness), { sequence: 3, pending: false }, 'the exact challenge again is no transition');
    assert.equal(refusalOf(await ingress.prepareAndGovern(IDENTITY, request({ challenges: paymentChallenge({ id: 'r-4', request: { ...DEFAULT_CHARGE, amount: '1100' } }) }))), 'business-operation-conflict');
    assert.equal(governed.length, 4);
    assert.equal(rail.callCount, 1, 'refresh is a replay, never a retry');
    await store.close();
  });
});

describe('PAY-04 hardening — open, legacy files, enrollment, health and no retry', () => {
  it('a non-empty store recorded before the hardening is never anchored after the fact — only by the explicit enrollment ceremony, which then protects it', async () => {
    const witness = await startWitness();
    const dir = workDir();
    const path = join(dir, 'legacy.sqlite');
    const legacy = await createSqlitePaymentBusinessOperationStore(path, { now: ingressClock });
    await legacy.record({ organizationId: ORG }, entryFor('op-A', 'C'));
    await legacy.close();
    await assert.rejects(anchored(path, await boundaryFor(witness, ORG)), /never anchored after the fact/);
    assert.deepEqual(await witnessRows(witness.databasePath), [], 'nothing was enrolled');
    copyFileSync(path, join(dir, 'legacy-copy.sqlite'));

    const enrolled = await anchored(path, await boundaryFor(witness, ORG), { enrollment: OPERATOR });
    assert.equal(enrolled.anchored, true);
    assert.equal((await enrolled.health()).schemaVersion, PAYMENT_BUSINESS_OPERATION_STORE_ANCHORED_SCHEMA_VERSION);
    assert.deepEqual(await witnessed(witness), { sequence: 1, pending: false }, 'the baseline is the verified file: one owned challenge');
    await assert.rejects(enrolled.record({ organizationId: ORG }, entryFor('op-B', 'C')), freshnessCode('PAYMENT_BUSINESS_OPERATION_CHALLENGE_CONFLICT'));
    await enrolled.record({ organizationId: ORG }, entryFor('op-A', 'D'));
    await enrolled.close();

    // From the baseline on, it is protected. The pre-enrollment copy (it lacks D) is refused for serving, and the ceremony
    // cannot enroll it over the witnessed history — and a refused ceremony leaves the file exactly as it was.
    restoreFile(join(dir, 'legacy-copy.sqlite'), path);
    await assert.rejects(anchored(path, await boundaryFor(witness, ORG)), /never anchored after the fact/);
    await assert.rejects(anchored(path, await boundaryFor(witness, ORG), { enrollment: OPERATOR }), freshnessCode('AUTHORITY_FRESHNESS_ALREADY_ENROLLED'), 'enrollment never rebinds a slot');
    const untouched = await createSqlitePaymentBusinessOperationStore(path, { now: ingressClock });
    assert.equal(untouched.anchored, false);
    assert.equal((await untouched.health()).schemaVersion, 'aoc.payment-business-operation-store.schema.v1', 'the refused ceremony wrote nothing');
    await untouched.close();
  });

  it('an anchored file is never opened without its witness, nor for another organization; a pre-hardening runtime cannot read it (schema v2)', async () => {
    const witness = await startWitness();
    const path = join(workDir(), 'bop.sqlite');
    await (await anchored(path, await boundaryFor(witness, ORG))).close();
    await assert.rejects(createSqlitePaymentBusinessOperationStore(path, { now: ingressClock }), /never opened without it/);
    await assert.rejects(anchored(path, await boundaryFor(witness, 'org-elsewhere')), /anchored for another organization/);
    const store = await anchored(path, await boundaryFor(witness, ORG));
    await assert.rejects(store.record({ organizationId: 'org-elsewhere' }, storeEntry({ organizationId: 'org-elsewhere' })), freshnessCode('PAYMENT_BUSINESS_OPERATION_TENANT_VIOLATION'));
    const health = await store.health();
    assert.deepEqual([health.status, health.freshness, health.schemaVersion], ['healthy', 'ready', PAYMENT_BUSINESS_OPERATION_STORE_ANCHORED_SCHEMA_VERSION]);
    assert.equal(/challenge|realm|sha256|token|credential|ch-/i.test(JSON.stringify(health)), false, 'health is bounded: no challenge, digest or credential');
    await store.close();
  });

  it('no retry, no resubmit: opening, reopening, finalizing at restart and refusing never call governance or a rail', async () => {
    const witness = await startWitness();
    const path = join(workDir(), 'bop.sqlite');
    const { world, rail } = payments(() => ({ status: 'unconfirmed', externalReference: 'job-9' }));
    const store = await anchored(path, await boundaryFor(witness, ORG));
    const { governed, ingress } = ingressOver(store, world);
    governedOf(await ingress.prepareAndGovern(IDENTITY, request()));
    await store.close();
    const kernelCalls = world.kernelRequests.length;
    for (let restart = 0; restart < 3; restart += 1) await (await anchored(path, await boundaryFor(witness, ORG))).close();
    assert.equal(governed.length, 1);
    assert.equal(world.kernelRequests.length, kernelCalls);
    assert.equal(rail.callCount, 1);
  });
});
