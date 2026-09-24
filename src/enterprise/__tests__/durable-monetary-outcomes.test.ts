import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { AuthorityEventRecorder } from '../authority-event-stream/recorder.js';
import { createInMemoryExecutionOutcomeStore, type ExecutionOutcomeStore } from '../execution-outcome-store/index.js';
import { GOVERNED_ACTION_REASON_CODES as R, type GovernedActionResult } from '../governed-action/index.js';
import { executionAttemptReferenceId, executionOutcomeReferenceId } from '../governed-action/identifiers.js';
import {
  ALLOWED_INTENT,
  DRAFTING_IS_FINANCIAL,
  IDENTITY,
  NOW,
  ORG,
  buildGovernedWorld,
  faultyOutcomes,
  monetaryAuthority,
  preP11History,
  type CallLog,
  type GovernedWorld,
  type WorldOptions,
} from './governed-action-support.js';

/**
 * P11 — durable monetary outcomes and provider certainty, through the real
 * orchestrator, the real Kernel, real ACE and real P7 (in memory here; the
 * SQLite restart scenarios are in `durable-monetary-outcomes-e2e.test.ts`).
 *
 * ```
 * pre-assessment -> P11 prepare -> claim -> adapter -> P7 finalize -> P11 observation -> summary -> P8
 * ```
 */

const A = { organizationId: ORG };

function financialWorld(options: WorldOptions = {}): GovernedWorld {
  return buildGovernedWorld({ monetary: DRAFTING_IS_FINANCIAL, financialAuthority: monetaryAuthority('100000000000000000000'), ...options });
}

function pay(value: string, key: string, currency = 'USD'): unknown {
  return { ...ALLOWED_INTENT, amount: { value, currency }, idempotencyKey: key };
}

async function restartedOver(first: GovernedWorld, options: WorldOptions = {}): Promise<GovernedWorld> {
  // A second process: the same durable Governance Store and execution outcome
  // store, a fresh adapter, fresh ACE, fresh orchestrator, no shared memory.
  return financialWorld({ store: first.rawStore, executionOutcomes: first.outcomes, kernelIdStart: 500, ...options });
}

async function outcomeOf(world: GovernedWorld, result: GovernedActionResult) {
  assert.ok(result.executionId !== undefined, JSON.stringify(result));
  return world.outcomes.read(A, result.executionId);
}

describe('P11 — the exact monetary attempt is durable before the provider crossing', () => {
  it('the prepared attempt carries the exact amount the adapter received, by reference to the committed authorization only', async () => {
    const world = financialWorld();
    const result = await world.orchestrator.govern(IDENTITY, pay('25', 'p11-prepared'));
    assert.equal(result.status, 'executed', JSON.stringify(result));
    const durable = await outcomeOf(world, result);
    assert.ok(durable !== undefined);
    const call = world.adapter.calls[0];
    assert.ok(call !== undefined);
    assert.deepEqual(durable.attempt.amount, { value: '25', unit: 'USD' });
    assert.deepEqual(durable.attempt.amount, call.amount, 'the attempt is the ValidatedExecutionAction.amount, verbatim');
    assert.equal(durable.attempt.boundedGrantId, call.boundedGrantId);
    assert.equal(durable.attempt.requestId, call.correlation.requestId);
    assert.equal(durable.attempt.decisionId, call.correlation.decisionId);
    assert.equal(durable.attempt.executionId, call.correlation.executionId);
    assert.equal(durable.attempt.evaluationId, result.decision?.evaluationId);
    assert.equal(durable.attempt.action, call.action);
    for (const embedded of ['record', 'grant', 'policy', 'trace', 'assertedContext', 'decision', 'authority']) {
      assert.equal(embedded in durable.attempt, false, `the attempt references the authorization; it never embeds '${embedded}'`);
    }
  });

  it('order: prepare → claim → adapter → observation → Governance summary', async () => {
    const entries: string[] = [];
    const log: CallLog = { entries, indexOf: (entry) => entries.indexOf(entry) };
    const inner = createInMemoryExecutionOutcomeStore({ now: () => NOW });
    const outcomes: ExecutionOutcomeStore = {
      providerKind: 'memory',
      prepareAttempt: async (context, input) => {
        entries.push('p11.prepare');
        return inner.prepareAttempt(context, input);
      },
      recordTerminal: async (context, input) => {
        entries.push('p11.observation');
        return inner.recordTerminal(context, input);
      },
      read: (context, executionId) => inner.read(context, executionId),
      health: () => inner.health(),
      close: () => inner.close(),
    };
    const world = financialWorld({ executionOutcomes: outcomes, log });
    await world.orchestrator.govern(IDENTITY, pay('25', 'p11-order'));
    const order = ['p11.prepare', 'store.appendReference:execution_record:attempt', 'adapter.execute', 'p11.observation', 'store.appendReference:execution_record:executed@test.fake-provider'].map((entry) => log.indexOf(entry));
    for (const index of order) assert.notEqual(index, -1, JSON.stringify(entries));
    assert.deepEqual([...order].sort((a, b) => a - b), order, JSON.stringify(entries));
  });

  it('a preparation that cannot be proven written stops before the claim: no claim row, no adapter, system_error — and the request stays safe to retry', async () => {
    const inner = createInMemoryExecutionOutcomeStore({ now: () => NOW });
    let failing = true;
    const flaky: ExecutionOutcomeStore = {
      ...faultyOutcomes({}, inner),
      prepareAttempt: async (context, input) => {
        if (failing) throw new Error('outcome store unavailable');
        return inner.prepareAttempt(context, input);
      },
    };
    const broken = financialWorld({ executionOutcomes: flaky });
    const failed = await broken.orchestrator.govern(IDENTITY, pay('25', 'p11-prepare-fails'));
    assert.equal(failed.status, 'system_error');
    assert.deepEqual([...failed.reasonCodes], [R.GOVERNED_ACTION_EXECUTION_CLAIM_FAILED]);
    assert.equal(broken.adapter.callCount, 0);
    assert.equal(broken.log.entries.includes('store.appendReference:execution_record:attempt'), false, 'no write-ahead claim: nothing is stranded');

    // The store recovers; the same request runs exactly once.
    failing = false;
    const retried = await broken.orchestrator.govern(IDENTITY, pay('25', 'p11-prepare-fails'));
    assert.equal(retried.status, 'executed', JSON.stringify(retried));
    assert.equal(broken.adapter.callCount, 1);
  });

  it('crash after preparation, before the claim: the retry finds its own attempt, claims, and executes once', async () => {
    const fault: { appendReferenceFor?: readonly ('authorization_artifact' | 'execution_record')[] } = { appendReferenceFor: ['execution_record'] };
    const world = financialWorld({ storeFault: fault });
    const crashed = await world.orchestrator.govern(IDENTITY, pay('25', 'p11-prep-no-claim'));
    assert.equal(crashed.status, 'system_error');
    assert.deepEqual([...crashed.reasonCodes], [R.GOVERNED_ACTION_EXECUTION_CLAIM_FAILED]);
    const prepared = await outcomeOf(world, crashed);
    assert.ok(prepared !== undefined && prepared.terminal === undefined, 'prepared, never "attempted": no provider was contacted');
    assert.equal(world.adapter.callCount, 0);

    delete fault.appendReferenceFor;
    const retried = await world.orchestrator.govern(IDENTITY, pay('25', 'p11-prep-no-claim'));
    assert.equal(retried.status, 'executed', JSON.stringify(retried));
    assert.equal(world.adapter.callCount, 1);
    const after = await outcomeOf(world, retried);
    assert.equal(after?.attempt.preparedAt, prepared.attempt.preparedAt, 'the first preparation stands, never re-dated');
  });
});

describe('P11 — the initial observation, and replay from it', () => {
  it('completed → confirmed-completed with its providerRef; replay reconstructs executed + providerRef, no adapter', async () => {
    const world = financialWorld({ adapterBehaviour: () => ({ outcome: 'completed', providerRef: 'payment-123' }) });
    const live = await world.orchestrator.govern(IDENTITY, pay('25', 'p11-completed'));
    assert.equal(live.status, 'executed');
    assert.equal(live.status === 'executed' ? live.providerRef : undefined, 'payment-123');
    assert.equal(live.status === 'executed' ? live.outcomeRecorded : undefined, true);
    const durable = await outcomeOf(world, live);
    assert.deepEqual(durable?.terminal?.observation, { kind: 'provider', certainty: 'confirmed-completed', adapterId: 'test.fake-provider', providerRef: 'payment-123', observedAt: NOW });

    const next = await restartedOver(world);
    const replay = await next.orchestrator.govern(IDENTITY, pay('25', 'p11-completed'));
    assert.equal(replay.status, 'executed');
    assert.equal(replay.status === 'executed' ? replay.providerRef : undefined, 'payment-123', 'P11 preserves the providerRef the pre-P11 replay lost');
    assert.equal(replay.status === 'executed' ? replay.replayed : undefined, true);
    assert.equal(next.adapter.callCount, 0);
    assert.equal(replay.executionId, live.executionId);
  });

  it('failed / PROVIDER_REJECTED with a request id → confirmed-not-completed; replay is execution_failed, never unconfirmed', async () => {
    const world = financialWorld({ adapterBehaviour: () => ({ outcome: 'failed', reason: 'PROVIDER_REJECTED', providerRef: 'request-123', detail: 'card declined: 4000 0000 0000 0002' }) });
    const live = await world.orchestrator.govern(IDENTITY, pay('25', 'p11-failed'));
    assert.equal(live.status, 'execution_failed');
    const durable = await outcomeOf(world, live);
    assert.deepEqual(durable?.terminal?.observation, { kind: 'provider', certainty: 'confirmed-not-completed', adapterId: 'test.fake-provider', providerRef: 'request-123', failure: 'PROVIDER_REJECTED', observedAt: NOW });
    assert.equal(JSON.stringify(durable).includes('card declined'), false, 'adapter detail is never a durable financial fact');
    const next = await restartedOver(world);
    const replay = await next.orchestrator.govern(IDENTITY, pay('25', 'p11-failed'));
    assert.equal(replay.status, 'execution_failed');
    assert.equal(replay.status === 'execution_failed' ? replay.failure : undefined, 'PROVIDER_REJECTED');
    assert.equal(replay.status === 'execution_failed' ? replay.replayed : undefined, true);
    assert.equal(next.adapter.callCount, 0);
  });

  it('unconfirmed with a job id → unconfirmed, providerRef kept internally; replay is OUTCOME_UNCONFIRMED — never failed', async () => {
    const world = financialWorld({ adapterBehaviour: () => ({ outcome: 'unconfirmed', providerRef: 'provider-job-123' }) });
    const live = await world.orchestrator.govern(IDENTITY, pay('25', 'p11-unconfirmed'));
    assert.equal(live.status, 'execution_unconfirmed');
    assert.deepEqual([...live.reasonCodes], [R.GOVERNED_ACTION_EXECUTION_OUTCOME_UNCONFIRMED]);
    assert.equal('providerRef' in live, false, 'the frozen v1 execution_unconfirmed shape is unchanged');
    const durable = await outcomeOf(world, live);
    const observation = durable?.terminal?.observation;
    assert.equal(observation?.kind === 'provider' ? observation.certainty : undefined, 'unconfirmed');
    assert.equal(observation?.kind === 'provider' ? observation.providerRef : undefined, 'provider-job-123');
    const next = await restartedOver(world);
    const replay = await next.orchestrator.govern(IDENTITY, pay('25', 'p11-unconfirmed'));
    assert.equal(replay.status, 'execution_unconfirmed');
    assert.deepEqual([...replay.reasonCodes], [R.GOVERNED_ACTION_EXECUTION_OUTCOME_UNCONFIRMED]);
    assert.equal(next.adapter.callCount, 0);
  });

  it('two forms of unknown stay distinct: the provider said unknown (OUTCOME_UNCONFIRMED) vs no observation on record (ALREADY_ATTEMPTED)', async () => {
    const said = financialWorld({ adapterBehaviour: () => ({ outcome: 'unconfirmed' }) });
    const saidLive = await said.orchestrator.govern(IDENTITY, pay('25', 'p11-two-unknowns-a'));
    const saidReplay = await said.orchestrator.govern(IDENTITY, pay('25', 'p11-two-unknowns-a'));
    assert.deepEqual([...saidReplay.reasonCodes], [R.GOVERNED_ACTION_EXECUTION_OUTCOME_UNCONFIRMED]);
    assert.ok((await outcomeOf(said, saidLive))?.terminal !== undefined);

    const silent = financialWorld({ beforeExercise: async () => Promise.reject(new Error('process died after the claim')) });
    const silentLive = await silent.orchestrator.govern(IDENTITY, pay('25', 'p11-two-unknowns-b'));
    assert.deepEqual([...silentLive.reasonCodes], [R.GOVERNED_ACTION_EXECUTION_ALREADY_ATTEMPTED]);
    const silentReplay = await silent.orchestrator.govern(IDENTITY, pay('25', 'p11-two-unknowns-b'));
    assert.deepEqual([...silentReplay.reasonCodes], [R.GOVERNED_ACTION_EXECUTION_ALREADY_ATTEMPTED]);
    const durable = await outcomeOf(silent, silentLive);
    assert.ok(durable !== undefined && durable.terminal === undefined, 'prepared + claimed + no observation: the principal P12 input');
    assert.deepEqual(durable.attempt.amount, { value: '25', unit: 'USD' }, 'the unresolved attempt still has its exact monetary context');
    assert.equal(silent.adapter.callCount, 0);
  });

  it('crash after the provider effect, before the observation: the live caller learns executed/unrecorded; replay is ALREADY_ATTEMPTED and never retries', async () => {
    const inner = createInMemoryExecutionOutcomeStore({ now: () => NOW });
    const world = financialWorld({ executionOutcomes: faultyOutcomes({ recordTerminal: true }, inner), adapterBehaviour: () => ({ outcome: 'completed', providerRef: 'payment-lost' }) });
    const live = await world.orchestrator.govern(IDENTITY, pay('25', 'p11-lost-observation'));
    assert.equal(live.status, 'executed', 'the provider truth is never rewritten because recording failed');
    assert.equal(live.status === 'executed' ? live.outcomeRecorded : undefined, false);
    assert.ok(live.reasonCodes.includes(R.GOVERNED_ACTION_EXECUTION_OUTCOME_UNRECORDED));
    const record = await world.rawStore.getByRequestId({ system: false, organizationId: ORG }, live.requestId ?? '');
    assert.equal(
      record?.references.some((reference) => reference.referenceId === executionOutcomeReferenceId(live.executionId ?? '')),
      false,
      'no Governance summary claims an outcome the canonical store does not hold',
    );
    const next = await restartedOver(world, { executionOutcomes: inner });
    const replay = await next.orchestrator.govern(IDENTITY, pay('25', 'p11-lost-observation'));
    assert.equal(replay.status, 'execution_unconfirmed');
    assert.deepEqual([...replay.reasonCodes], [R.GOVERNED_ACTION_EXECUTION_ALREADY_ATTEMPTED], 'a confirmation that only lived in memory is never reconstructed');
    assert.equal(next.adapter.callCount, 0);
  });

  it('terminal committed, response lost: the retry reconstructs the exact answer from durable state', async () => {
    const world = financialWorld({ adapterBehaviour: () => ({ outcome: 'completed', providerRef: 'payment-777' }) });
    const live = await world.orchestrator.govern(IDENTITY, pay('25', 'p11-response-lost'));
    const next = await restartedOver(world);
    const replay = await next.orchestrator.govern(IDENTITY, pay('25', 'p11-response-lost'));
    assert.deepEqual(
      { status: replay.status, executionId: replay.executionId, providerRef: replay.status === 'executed' ? replay.providerRef : undefined },
      { status: live.status, executionId: live.executionId, providerRef: live.status === 'executed' ? live.providerRef : undefined },
    );
    assert.equal(next.adapter.callCount, 0);
  });

  it('the Governance outcome summary points at the canonical observation by digest', async () => {
    const world = financialWorld();
    const live = await world.orchestrator.govern(IDENTITY, pay('25', 'p11-summary-digest'));
    const durable = await outcomeOf(world, live);
    const record = await world.rawStore.getByRequestId({ system: false, organizationId: ORG }, live.requestId ?? '');
    const summary = record?.references.find((reference) => reference.referenceId === executionOutcomeReferenceId(live.executionId ?? ''));
    assert.equal(summary?.digest, durable?.terminal?.observationDigest);
    assert.equal(summary?.externalVersion, 'executed@test.fake-provider', 'the compact legacy summary form is unchanged');
    const claim = record?.references.find((reference) => reference.referenceId === executionAttemptReferenceId(live.executionId ?? ''));
    assert.equal(claim?.externalVersion, 'attempt', 'the write-ahead claim is unchanged');
  });

  it('a withheld exercise after the claim is recorded as a withholding — never as a provider certainty', async () => {
    const world = financialWorld({
      beforeExercise: async ({ ace }, grantId) => {
        await ace.revokeGrant({ grantId, reason: 'manual-revocation', issuerRef: 'operator-1' });
      },
    });
    const live = await world.orchestrator.govern(IDENTITY, pay('25', 'p11-withheld'));
    assert.equal(live.status, 'withheld');
    const observation = (await outcomeOf(world, live))?.terminal?.observation;
    assert.equal(observation?.kind, 'withheld');
    assert.equal(observation !== undefined && 'certainty' in observation, false);
    assert.equal(observation !== undefined && 'adapterId' in observation, false);
    const replay = await world.orchestrator.govern(IDENTITY, pay('25', 'p11-withheld'));
    assert.equal(replay.status, 'withheld');
    assert.deepEqual([...replay.reasonCodes], [...live.reasonCodes]);
  });
});

describe('P11 — unreadable or corrupt state never replays optimistically', () => {
  it('an execution outcome store that cannot be read replays ALREADY_ATTEMPTED — even though the Governance summary says executed', async () => {
    const world = financialWorld();
    const live = await world.orchestrator.govern(IDENTITY, pay('25', 'p11-unreadable'));
    assert.equal(live.status, 'executed');
    const next = await restartedOver(world, { executionOutcomes: faultyOutcomes({ read: true }, world.outcomes) });
    const replay = await next.orchestrator.govern(IDENTITY, pay('25', 'p11-unreadable'));
    assert.equal(replay.status, 'execution_unconfirmed');
    assert.deepEqual([...replay.reasonCodes], [R.GOVERNED_ACTION_EXECUTION_ALREADY_ATTEMPTED]);
    assert.equal(next.adapter.callCount, 0, 'unknown is never a reason to try again');
  });

  it('a P11 record overrides a forged Governance summary: evidence rows cannot rewrite the canonical outcome', async () => {
    const world = financialWorld({ adapterBehaviour: () => ({ outcome: 'unconfirmed' }), storeFault: { appendOutcomeReference: true } });
    const live = await world.orchestrator.govern(IDENTITY, pay('25', 'p11-forged-summary'));
    const record = await world.rawStore.getByRequestId({ system: false, organizationId: ORG }, live.requestId ?? '');
    assert.ok(record !== null && live.executionId !== undefined);
    await world.rawStore.appendReference({ system: false, organizationId: ORG }, {
      referenceId: executionOutcomeReferenceId(live.executionId),
      evaluationId: record.evaluation.evaluationId,
      referenceType: 'execution_record',
      externalId: live.executionId,
      externalVersion: 'executed@test.fake-provider',
      createdAt: NOW,
    });
    const replay = await world.orchestrator.govern(IDENTITY, pay('25', 'p11-forged-summary'));
    assert.equal(replay.status, 'execution_unconfirmed', 'the canonical unconfirmed observation stands');
    assert.deepEqual([...replay.reasonCodes], [R.GOVERNED_ACTION_EXECUTION_OUTCOME_UNCONFIRMED]);
  });
});

describe('P11 — legacy (pre-P11) history stays readable, and is never enriched', () => {
  for (const [name, behaviour, check] of [
    [
      'executed@adapter → executed, providerRef absent (never invented)',
      () => ({ outcome: 'completed' as const, providerRef: 'never-persisted-before-p11' }),
      (replay: GovernedActionResult) => {
        assert.equal(replay.status, 'executed');
        assert.equal('providerRef' in replay, false);
        assert.equal(replay.status === 'executed' ? replay.replayed : undefined, true);
      },
    ],
    [
      'execution-failed:PROVIDER_REJECTED@adapter → execution_failed',
      () => ({ outcome: 'failed' as const, reason: 'PROVIDER_REJECTED' as const }),
      (replay: GovernedActionResult) => assert.equal(replay.status === 'execution_failed' ? replay.failure : undefined, 'PROVIDER_REJECTED'),
    ],
    [
      'execution-unconfirmed@adapter → OUTCOME_UNCONFIRMED',
      () => ({ outcome: 'unconfirmed' as const }),
      (replay: GovernedActionResult) => assert.deepEqual([...replay.reasonCodes], [R.GOVERNED_ACTION_EXECUTION_OUTCOME_UNCONFIRMED]),
    ],
  ] as const) {
    it(name, async () => {
      const world = financialWorld({ executionOutcomes: preP11History(), adapterBehaviour: behaviour });
      await world.orchestrator.govern(IDENTITY, pay('25', `legacy-${name.length}`));
      const replay = await world.orchestrator.govern(IDENTITY, pay('25', `legacy-${name.length}`));
      check(replay);
      assert.equal(world.adapter.callCount, 1, 'the adapter is not invoked again');
    });
  }

  it('a legacy claim with no outcome row → ALREADY_ATTEMPTED, unchanged', async () => {
    const world = financialWorld({ executionOutcomes: preP11History(), beforeExercise: async () => Promise.reject(new Error('crash')) });
    await world.orchestrator.govern(IDENTITY, pay('25', 'legacy-claim-only'));
    const replay = await world.orchestrator.govern(IDENTITY, pay('25', 'legacy-claim-only'));
    assert.deepEqual([...replay.reasonCodes], [R.GOVERNED_ACTION_EXECUTION_ALREADY_ATTEMPTED]);
    assert.equal(world.adapter.callCount, 0);
  });
});

describe('P11 — concurrency on one execution identity', () => {
  it('two identical governed requests race: one provider invocation, one attempt, one observation', async () => {
    const world = financialWorld({ adapterBehaviour: async () => ({ outcome: 'completed', providerRef: 'payment-race' }) });
    const [left, right] = await Promise.all([world.orchestrator.govern(IDENTITY, pay('25', 'p11-race')), world.orchestrator.govern(IDENTITY, pay('25', 'p11-race'))]);
    assert.equal(world.adapter.callCount, 1);
    assert.equal(left.executionId, right.executionId);
    const statuses = [left.status, right.status].sort();
    assert.ok(statuses.includes('executed'), JSON.stringify([left, right]));
    const durable = await outcomeOf(world, left);
    const observation = durable?.terminal?.observation;
    assert.equal(observation?.kind === 'provider' ? observation.providerRef : undefined, 'payment-race');
  });
});

describe('P11 — P8 stays evidence only', () => {
  for (const [name, recorder] of [
    [
      'throws',
      new Proxy({} as AuthorityEventRecorder, {
        get: () => () => {
          throw new Error('recorder down');
        },
      }),
    ],
  ] as const) {
    it(`a recorder that ${name} changes nothing: the observation persists, the result returns, replay works`, async () => {
      const world = financialWorld({ evidence: recorder, adapterBehaviour: () => ({ outcome: 'completed', providerRef: `payment-p8-${name}` }) });
      const live = await world.orchestrator.govern(IDENTITY, pay('25', `p11-p8-${name}`));
      assert.equal(live.status, 'executed');
      assert.equal(live.status === 'executed' ? live.outcomeRecorded : undefined, true);
      assert.ok((await outcomeOf(world, live))?.terminal !== undefined);
      const replay = await world.orchestrator.govern(IDENTITY, pay('25', `p11-p8-${name}`));
      assert.equal(replay.status === 'executed' ? replay.providerRef : undefined, `payment-p8-${name}`);
      assert.equal(world.adapter.callCount, 1);
    });
  }
});

describe('P11 — a caller can never self-report provider success or certainty', () => {
  const selfReport = { providerRef: 'fake-success', providerStatus: 'completed', executionOutcome: 'executed', providerCertainty: 'confirmed-completed' };

  it('at the top level of the intent: refused as undeclared, nothing evaluated, nothing prepared', async () => {
    const world = financialWorld();
    const result = await world.orchestrator.govern(IDENTITY, { ...(pay('25', 'p11-self-top') as object), ...selfReport });
    assert.equal(result.status, 'rejected');
    assert.deepEqual([...result.reasonCodes], [R.GOVERNED_ACTION_INTENT_INVALID]);
    assert.equal(world.adapter.callCount, 0);
  });

  it('inside assertedContext: every P11 self-report key is reserved and refused', async () => {
    for (const [key, value] of Object.entries({ ...selfReport, certainty: 'confirmed-completed', executionStatus: 'executed', outcomeRecorded: true })) {
      const world = financialWorld();
      const intent = pay('25', `p11-self-ctx-${key}`) as { assertedContext: Record<string, unknown> };
      const result = await world.orchestrator.govern(IDENTITY, { ...intent, assertedContext: { ...intent.assertedContext, [key]: value } });
      assert.equal(result.status, 'rejected', key);
      assert.equal(world.adapter.callCount, 0);
    }
  });

  it('deeper in assertedContext, a self-report reaches only the Kernel as unverified evidence: the durable outcome is the adapter’s', async () => {
    const world = financialWorld({ adapterBehaviour: () => ({ outcome: 'unconfirmed' }) });
    const intent = pay('25', 'p11-self-nested') as { assertedContext: Record<string, unknown> };
    const result = await world.orchestrator.govern(IDENTITY, { ...intent, assertedContext: { ...intent.assertedContext, nested: selfReport } });
    // Whether the Kernel accepts the evidence bag is its own business; what matters is that nothing in it reaches the outcome.
    if (result.executionId === undefined) return;
    const observation = (await outcomeOf(world, result))?.terminal?.observation;
    assert.equal(observation?.kind === 'provider' ? observation.certainty : undefined, 'unconfirmed');
    assert.equal(observation?.kind === 'provider' ? observation.providerRef : undefined, undefined);
  });

  it('a directly composed adapter cannot forge another adapter’s attribution into the durable record', async () => {
    const world = financialWorld({ adapterBehaviour: () => ({ outcome: 'completed', adapterId: 'somebody.else', providerRef: 'p-1' }) });
    const live = await world.orchestrator.govern(IDENTITY, pay('25', 'p11-forged-attribution'));
    const observation = (await outcomeOf(world, live))?.terminal?.observation;
    assert.equal(observation?.kind === 'provider' ? observation.adapterId : undefined, 'test.fake-provider');
    assert.equal(observation?.kind === 'provider' ? observation.routedBy : 'x', undefined);
  });
});

describe('P11 — money in the durable record', () => {
  it('9007199254740993.01 reaches the adapter and the prepared attempt as the same exact text', async () => {
    const world = financialWorld();
    const live = await world.orchestrator.govern(IDENTITY, pay('9007199254740993.01', 'p11-exact'));
    assert.equal(live.status, 'executed', JSON.stringify(live));
    assert.equal(world.adapter.calls[0]?.amount?.value, '9007199254740993.01');
    const durable = await outcomeOf(world, live);
    assert.equal(durable?.attempt.amount?.value, '9007199254740993.01');
    assert.equal(typeof durable?.attempt.amount?.value, 'string');
  });

  it('a non-financial governed execution is prepared and observed with no amount at all', async () => {
    const world = buildGovernedWorld();
    const live = await world.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
    assert.equal(live.status, 'executed');
    const durable = await world.outcomes.read(A, live.executionId ?? '');
    assert.equal(durable !== undefined && 'amount' in durable.attempt, false);
    assert.equal(durable?.terminal?.observation.kind, 'provider');
  });
});
