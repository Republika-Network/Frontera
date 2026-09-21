import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  EMERGENCY_CONTROL_REASON_CODES,
  createInMemoryEmergencyControlStore,
  type EmergencyControlReaderPort,
} from '../../features/emergency-control-runtime/index.js';
import { GRANT_EXERCISE_REASON_CODES, createExecutionAdapterRegistry, type ExecutionAdapter } from '../../features/execution-runtime/index.js';
import { createRecordingExecutionAdapter, type RecordingExecutionAdapter } from '../../features/execution-runtime/tests/execution-fixture.js';
import { executionOutcomeReferenceId } from '../governed-action/identifiers.js';
import type { GovernanceRecord } from '../governance-store/contracts.js';
import {
  ALLOWED_INTENT,
  IDENTITY,
  NOW,
  ORG,
  PMFREAK_ACTOR_ID,
  buildGovernedWorld,
  type GovernedWorld,
  type WorldOptions,
} from './governed-action-support.js';

/**
 * The operational interlock on the canonical governed-action path, measured at
 * every one of its four checkpoints — and measured, as always, by **whether the
 * adapter ran**.
 *
 * The cases that matter most are the two races. A pre-issuance check alone
 * leaves a window in which a stop activated a millisecond later still mints
 * fresh bounded authority; a pre-exercise check alone leaves a window in which
 * an already-issued grant still reaches a provider. Both windows are stood in
 * explicitly below.
 */

const ISSUER = 'operator:on-call';

function controls() {
  return createInMemoryEmergencyControlStore();
}

async function recordFor(world: GovernedWorld, requestId: string): Promise<GovernanceRecord | null> {
  return world.rawStore.getByRequestId({ system: false, organizationId: ORG }, requestId);
}

function withheldBy(result: { readonly status: string } & Partial<{ readonly withheldBy: string }>): string | undefined {
  return result.status === 'withheld' ? result.withheldBy : undefined;
}

function world(options: WorldOptions = {}): GovernedWorld {
  return buildGovernedWorld(options);
}

describe('Emergency control — checkpoint 1, admission', () => {
  it('a global stop withholds before any grant is minted, and no adapter runs', async () => {
    const emergencyControl = controls();
    emergencyControl.activate({ scope: 'global', issuerRef: ISSUER, declaredAt: NOW });
    const w = world({ emergencyControl });

    const result = await w.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
    assert.equal(result.status, 'withheld');
    assert.equal(withheldBy(result), 'emergency-control');
    assert.deepEqual([...result.reasonCodes], [EMERGENCY_CONTROL_REASON_CODES.EMERGENCY_CONTROL_ACTIVE]);
    assert.equal(w.adapter.callCount, 0);
    assert.equal(w.issueOutcomes.length, 0, 'no grant may be minted for an unattempted action while execution is stopped');
    assert.equal(w.log.indexOf('grantStore.issue'), -1);
  });

  it('the decision is still committed first, and is still the Kernel’s own', async () => {
    const emergencyControl = controls();
    emergencyControl.activate({ scope: 'global', issuerRef: ISSUER, declaredAt: NOW });
    const w = world({ emergencyControl });

    const result = await w.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
    // Admission runs *after* the commit, so the governance record exists and
    // the decision it holds is untouched: an interlock never rewrites a
    // decision, and never prevents one from being recorded.
    assert.equal(result.decision?.status, 'allowed');
    const record = await recordFor(w, result.requestId ?? '');
    assert.ok(record !== null);
    assert.equal(record.evaluation.status, 'allowed');
    assert.equal(record.references.length, 0, 'no authorization artifact and no execution attempt were recorded');
  });

  it('an unreadable control withholds at admission — an outage is never permission', async () => {
    const emergencyControl = controls();
    emergencyControl.simulateUnavailable(true);
    const w = world({ emergencyControl });

    const result = await w.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
    assert.equal(withheldBy(result), 'emergency-control');
    assert.deepEqual([...result.reasonCodes], [EMERGENCY_CONTROL_REASON_CODES.EMERGENCY_CONTROL_UNAVAILABLE]);
    assert.equal(w.adapter.callCount, 0);
    assert.equal(w.issueOutcomes.length, 0);
  });

  it('a reader that throws withholds rather than escaping as a system error', async () => {
    const throwing: EmergencyControlReaderPort = {
      read() {
        throw new Error('control plane unreachable');
      },
    };
    const w = world({ emergencyControl: throwing });
    const result = await w.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
    assert.equal(withheldBy(result), 'emergency-control');
    assert.equal(w.adapter.callCount, 0);
  });

  it('a stop scoped to another organization does not touch this one', async () => {
    const emergencyControl = controls();
    emergencyControl.activate({ scope: 'organization', value: 'org-someone-else', issuerRef: ISSUER, declaredAt: NOW });
    const w = world({ emergencyControl });

    const result = await w.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
    assert.equal(result.status, 'executed');
    assert.equal(w.adapter.callCount, 1);
  });

  it('a stop scoped to this organization, actor or resource each withhold', async () => {
    for (const [index, control] of [
      { scope: 'organization', value: ORG },
      { scope: 'actor', value: PMFREAK_ACTOR_ID },
      { scope: 'resource', value: ALLOWED_INTENT.resource },
    ].entries()) {
      const emergencyControl = controls();
      emergencyControl.activate({ ...control, issuerRef: ISSUER, declaredAt: NOW } as never);
      const w = world({ emergencyControl });
      const result = await w.orchestrator.govern(IDENTITY, { ...ALLOWED_INTENT, idempotencyKey: `key-scope-${index}` });
      assert.equal(withheldBy(result), 'emergency-control', `${control.scope} must withhold`);
      assert.equal(w.adapter.callCount, 0);
    }
  });

  it('clearing the stop lets a never-attempted action proceed — nothing was revoked', async () => {
    const emergencyControl = controls();
    emergencyControl.activate({ scope: 'global', issuerRef: ISSUER, declaredAt: NOW });
    const w = world({ emergencyControl });

    assert.equal(withheldBy(await w.orchestrator.govern(IDENTITY, ALLOWED_INTENT)), 'emergency-control');
    emergencyControl.release({ scope: 'global', issuerRef: ISSUER, releasedAt: NOW });
    const retry = await w.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
    assert.equal(retry.status, 'executed');
    assert.equal(w.adapter.callCount, 1);
  });

  it('no emergency scope is derived from caller input: the intent cannot name one', async () => {
    const emergencyControl = controls();
    const w = world({ emergencyControl });
    for (const forbidden of ['workflowId', 'adapterId', 'adapter', 'provider', 'url', 'credential', 'emergencyControl']) {
      const result = await w.orchestrator.govern(IDENTITY, { ...ALLOWED_INTENT, [forbidden]: 'anything' });
      assert.equal(result.status, 'rejected', `an intent carrying '${forbidden}' must be refused, not partially honoured`);
    }
  });
});

describe('Emergency control — checkpoint 2, the grant commit boundary', () => {
  it('a stop that activates after admission and before the commit refuses the grant', async () => {
    const emergencyControl = controls();
    const w = world({
      emergencyControl,
      // Stands exactly in the TOCTOU window: admission has passed, and the
      // store's synchronous guard has not yet run.
      beforeGrantIssue: () => emergencyControl.activate({ scope: 'global', issuerRef: ISSUER, declaredAt: NOW }),
    });

    const result = await w.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
    assert.equal(withheldBy(result), 'emergency-control', JSON.stringify(result));
    assert.deepEqual([...result.reasonCodes], [EMERGENCY_CONTROL_REASON_CODES.EMERGENCY_CONTROL_ACTIVE]);
    assert.equal(w.adapter.callCount, 0);

    // The store was asked, and refused: no grant exists.
    assert.equal(w.issueOutcomes.length, 1);
    assert.equal(w.issueOutcomes[0]?.outcome, 'refused');
    const record = await recordFor(w, result.requestId ?? '');
    assert.equal(record?.references.length, 0, 'no authorization artifact was recorded, because no grant was committed');
  });

  it('a reader that becomes unreadable in that window also refuses the grant', async () => {
    const emergencyControl = controls();
    const w = world({
      emergencyControl,
      beforeGrantIssue: () => emergencyControl.simulateUnavailable(true),
    });

    const result = await w.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
    assert.equal(withheldBy(result), 'emergency-control');
    assert.deepEqual([...result.reasonCodes], [EMERGENCY_CONTROL_REASON_CODES.EMERGENCY_CONTROL_UNAVAILABLE]);
    assert.equal(w.adapter.callCount, 0);
    assert.equal(w.issueOutcomes[0]?.outcome, 'refused');
  });

  it('a commit-boundary refusal is reported as an interlock, never as a correlation defect', async () => {
    const emergencyControl = controls();
    const w = world({
      emergencyControl,
      beforeGrantIssue: () => emergencyControl.activate({ scope: 'global', issuerRef: ISSUER, declaredAt: NOW }),
    });
    const result = await w.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
    // The store's guard reports GRANT_CORRELATION_INVALID when the synchronous
    // revalidation returns `undefined`. Surfacing that here would send an
    // operator hunting a correlation bug that does not exist.
    assert.equal(result.reasonCodes.includes('GRANT_CORRELATION_INVALID'), false);
    assert.equal(withheldBy(result), 'emergency-control');
  });

  it('a clear commit boundary issues normally', async () => {
    const emergencyControl = controls();
    const w = world({ emergencyControl });
    const result = await w.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
    assert.equal(result.status, 'executed');
    assert.equal(w.issueOutcomes[0]?.outcome, 'issued');
    assert.equal(w.adapter.callCount, 1);
  });

  it('an ordinary grant refusal is still an ordinary grant refusal while the interlock is composed', async () => {
    const emergencyControl = controls();
    // A host revalidator that refuses: the classic commit-boundary grant
    // refusal, which must keep its own vocabulary.
    const w = world({ emergencyControl, revalidateSource: () => undefined });
    const result = await w.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
    assert.equal(withheldBy(result), 'grant');
    assert.equal(result.reasonCodes.includes(EMERGENCY_CONTROL_REASON_CODES.EMERGENCY_CONTROL_ACTIVE), false);
    assert.equal(w.adapter.callCount, 0);
  });

  it('the commit-boundary capture cannot leak between concurrent governed actions', async () => {
    // Two actions in flight over one orchestrator. The interlock activates
    // while the *second* is between admission and commit; the first must keep
    // its own outcome, because the capture belongs to one issuance call.
    const emergencyControl = controls();
    let issues = 0;
    const w = world({
      emergencyControl,
      beforeGrantIssue: () => {
        issues += 1;
        if (issues === 2) emergencyControl.activate({ scope: 'global', issuerRef: ISSUER, declaredAt: NOW });
      },
    });

    const first = await w.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
    const second = await w.orchestrator.govern(IDENTITY, { ...ALLOWED_INTENT, idempotencyKey: 'key-second' });
    assert.equal(first.status, 'executed');
    assert.equal(withheldBy(second), 'emergency-control');
    assert.equal(w.adapter.callCount, 1);
  });
});

describe('Emergency control — checkpoint 3, exercise after the authoritative grant re-read', () => {
  it('a stop that activates after issuance withholds at exercise, and the adapter is never called', async () => {
    const emergencyControl = controls();
    const w = world({
      emergencyControl,
      // After the pre-assessment and after the write-ahead claim: the grant is
      // issued, valid, and covers the action.
      beforeExercise: async () => {
        emergencyControl.activate({ scope: 'global', issuerRef: ISSUER, declaredAt: NOW });
      },
    });

    const result = await w.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
    assert.equal(withheldBy(result), 'emergency-control');
    assert.deepEqual([...result.reasonCodes], [EMERGENCY_CONTROL_REASON_CODES.EMERGENCY_CONTROL_ACTIVE]);
    assert.equal(w.adapter.callCount, 0);
    // The grant was issued and is still perfectly usable. Nothing revoked it.
    assert.equal(w.issueOutcomes[0]?.outcome, 'issued');
    const grantId = w.issueOutcomes[0]?.outcome === 'issued' ? w.issueOutcomes[0].grant.id : '';
    const read = await w.grantStore.read(grantId);
    assert.ok(read.grant !== undefined);
    assert.equal(read.revocation, undefined, 'an interlock is not a revocation');
  });

  it('a reader that becomes unreadable before the provider call withholds, and the adapter is never called', async () => {
    const emergencyControl = controls();
    const w = world({
      emergencyControl,
      beforeExercise: async () => {
        emergencyControl.simulateUnavailable(true);
      },
    });
    const result = await w.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
    assert.equal(withheldBy(result), 'emergency-control');
    assert.deepEqual([...result.reasonCodes], [EMERGENCY_CONTROL_REASON_CODES.EMERGENCY_CONTROL_UNAVAILABLE]);
    assert.equal(w.adapter.callCount, 0);
  });

  it('a clear interlock at exercise calls the adapter exactly once', async () => {
    const emergencyControl = controls();
    const w = world({ emergencyControl });
    const result = await w.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
    assert.equal(result.status, 'executed');
    assert.equal(w.adapter.callCount, 1);
  });

  it('an exercise-time withholding is durably recorded as an emergency-control withholding', async () => {
    const emergencyControl = controls();
    const w = world({
      emergencyControl,
      beforeExercise: async () => {
        emergencyControl.activate({ scope: 'global', issuerRef: ISSUER, declaredAt: NOW });
      },
    });
    const result = await w.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
    const record = await recordFor(w, result.requestId ?? '');
    assert.deepEqual(
      record?.references.map((reference) => reference.externalVersion ?? reference.referenceType),
      ['authorization_artifact', 'attempt', `withheld:emergency-control:${EMERGENCY_CONTROL_REASON_CODES.EMERGENCY_CONTROL_ACTIVE}`],
    );
  });

  it('a grant that is genuinely unusable is still reported by the grant-exercise layer', async () => {
    const emergencyControl = controls();
    const w = world({
      emergencyControl,
      beforeExercise: async ({ ace }, grantId) => {
        await ace.revokeGrant({ grantId, reason: 'manual-revocation', issuerRef: 'operator-1' });
        emergencyControl.activate({ scope: 'global', issuerRef: ISSUER, declaredAt: NOW });
      },
    });
    const result = await w.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
    // The grant gate answers first, so a revoked grant is reported as revoked
    // rather than as an operational stop. They are different problems.
    assert.equal(withheldBy(result), 'exercise');
    assert.ok(result.reasonCodes.includes(GRANT_EXERCISE_REASON_CODES.GRANT_EXERCISE_REVOKED));
    assert.equal(w.adapter.callCount, 0);
  });
});

describe('Emergency control — checkpoint 4, the adapter-scoped stop after trusted routing', () => {
  /** A recorder under a chosen identity. The `callCount` getter is redefined rather than spread, so it keeps reporting the live count. */
  function namedAdapter(adapterId: string): RecordingExecutionAdapter {
    const inner = createRecordingExecutionAdapter();
    return {
      adapterId,
      calls: inner.calls,
      get callCount(): number {
        return inner.callCount;
      },
      execute: (action) => inner.execute(action),
    };
  }

  function routedWorld(emergencyControl: EmergencyControlReaderPort): {
    readonly w: GovernedWorld;
    readonly a: RecordingExecutionAdapter;
    readonly b: RecordingExecutionAdapter;
  } {
    const a = namedAdapter('adapter-a');
    const b = namedAdapter('adapter-b');
    const registry: ExecutionAdapter = createExecutionAdapterRegistry({
      adapters: [a, b],
      // Trusted host routing, on a field that was already proven inside a bound.
      selectAdapter: (action) => (action.action === ALLOWED_INTENT.action ? 'adapter-a' : 'adapter-b'),
      emergencyControl,
    });
    return { w: world({ emergencyControl, executionAdapter: registry }), a, b };
  }

  it('a stop on the selected adapter withholds, and neither child is invoked', async () => {
    const emergencyControl = controls();
    emergencyControl.activate({ scope: 'adapter', value: 'adapter-a', issuerRef: ISSUER, declaredAt: NOW });
    const { w, a, b } = routedWorld(emergencyControl);

    const result = await w.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
    assert.equal(withheldBy(result), 'emergency-control');
    assert.deepEqual([...result.reasonCodes], [EMERGENCY_CONTROL_REASON_CODES.EMERGENCY_CONTROL_ACTIVE]);
    assert.equal(a.callCount, 0);
    assert.equal(b.callCount, 0);
  });

  it('a stop on an unrelated adapter leaves this action alone', async () => {
    const emergencyControl = controls();
    emergencyControl.activate({ scope: 'adapter', value: 'adapter-b', issuerRef: ISSUER, declaredAt: NOW });
    const { w, a, b } = routedWorld(emergencyControl);

    const result = await w.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
    assert.equal(result.status, 'executed');
    assert.equal(a.callCount, 1);
    assert.equal(b.callCount, 0);
  });

  it('an unreadable control at the adapter check withholds and invokes no child', async () => {
    // Clear at the three checkpoints that know no adapter, and unreadable at
    // the only one that does. That isolates the adapter check: everything
    // earlier passes, and the child is still never invoked.
    const reader: EmergencyControlReaderPort = {
      read: (query) =>
        query.adapterId === undefined
          ? { state: 'clear', reasonCodes: [] }
          : { state: 'unavailable', reasonCodes: [EMERGENCY_CONTROL_REASON_CODES.EMERGENCY_CONTROL_UNAVAILABLE] },
    };
    const { w, a, b } = routedWorld(reader);

    const result = await w.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
    assert.equal(withheldBy(result), 'emergency-control');
    assert.deepEqual([...result.reasonCodes], [EMERGENCY_CONTROL_REASON_CODES.EMERGENCY_CONTROL_UNAVAILABLE]);
    assert.equal(a.callCount, 0);
    assert.equal(b.callCount, 0);
  });

  it('with a healthy reader the routed child runs exactly once', async () => {
    const emergencyControl = controls();
    const { w, a, b } = routedWorld(emergencyControl);
    const result = await w.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
    assert.equal(result.status, 'executed');
    assert.equal(a.callCount, 1);
    assert.equal(b.callCount, 0);
  });

  it('an adapter-scoped stop never becomes a provider rejection', async () => {
    const emergencyControl = controls();
    emergencyControl.activate({ scope: 'adapter', value: 'adapter-a', issuerRef: ISSUER, declaredAt: NOW });
    const { w } = routedWorld(emergencyControl);
    const result = await w.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
    assert.notEqual(result.status, 'execution_failed');
    assert.equal(result.reasonCodes.includes('PROVIDER_REJECTED'), false);
  });
});

describe('Governed action — the durable record names the child adapter that performed the effect', () => {
  function namedAdapter(adapterId: string): RecordingExecutionAdapter {
    const inner = createRecordingExecutionAdapter();
    return {
      adapterId,
      calls: inner.calls,
      get callCount(): number {
        return inner.callCount;
      },
      execute: (action) => inner.execute(action),
    };
  }

  /** Two children behind one registry, routed by the intent's action. */
  function routedWorld(options: { readonly select: (action: { readonly action: string }) => string }) {
    const a = namedAdapter('adapter-a');
    const b = namedAdapter('adapter-b');
    const registry: ExecutionAdapter = createExecutionAdapterRegistry({
      adapterId: 'registry',
      adapters: [a, b],
      selectAdapter: (action) => options.select(action),
    });
    return { a, b, w: world({ executionAdapter: registry }) };
  }

  async function outcomeRowFor(w: GovernedWorld, requestId: string, executionId: string): Promise<string | undefined> {
    const record = await recordFor(w, requestId);
    return record?.references.find((reference) => reference.referenceId === executionOutcomeReferenceId(executionId))?.externalVersion;
  }

  it('two successful effects through two different children are distinguishable in the durable record', async () => {
    const routedToA = routedWorld({ select: () => 'adapter-a' });
    const first = await routedToA.w.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
    assert.equal(first.status, 'executed', JSON.stringify(first));

    const routedToB = routedWorld({ select: () => 'adapter-b' });
    const second = await routedToB.w.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
    assert.equal(second.status, 'executed', JSON.stringify(second));

    // The two requests are byte-identical apart from which child trusted
    // routing chose — and the record says which one it was.
    assert.equal(await outcomeRowFor(routedToA.w, first.requestId ?? '', first.executionId ?? ''), 'executed@adapter-a');
    assert.equal(await outcomeRowFor(routedToB.w, second.requestId ?? '', second.executionId ?? ''), 'executed@adapter-b');
    assert.equal(routedToA.a.callCount, 1);
    assert.equal(routedToA.b.callCount, 0);
    assert.equal(routedToB.a.callCount, 0);
    assert.equal(routedToB.b.callCount, 1);
  });

  it('the recorded identity is the child, never the registry that routed to it', async () => {
    const { w } = routedWorld({ select: () => 'adapter-a' });
    const result = await w.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
    const recorded = await outcomeRowFor(w, result.requestId ?? '', result.executionId ?? '');
    assert.equal(recorded, 'executed@adapter-a');
    assert.equal(recorded?.includes('registry'), false, 'naming the router would answer the wrong question');
  });

  it('a replay preserves the same child identity, because it replays the same row', async () => {
    const { w, a } = routedWorld({ select: () => 'adapter-a' });
    const first = await w.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
    const before = await outcomeRowFor(w, first.requestId ?? '', first.executionId ?? '');

    const retry = await w.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
    assert.equal(retry.status, 'executed');
    assert.equal(retry.status === 'executed' ? retry.replayed : undefined, true);
    assert.equal(a.callCount, 1, 'the adapter is not invoked again');

    const after = await outcomeRowFor(w, first.requestId ?? '', first.executionId ?? '');
    assert.equal(after, before, 'the outcome row is never rewritten');
    assert.equal(after, 'executed@adapter-a');
  });

  it('a provider failure records which child failed, and replays as that failure', async () => {
    const failing: ExecutionAdapter = {
      adapterId: 'adapter-b',
      async execute() {
        return { outcome: 'failed', reason: 'PROVIDER_REJECTED' };
      },
    };
    const registry: ExecutionAdapter = createExecutionAdapterRegistry({
      adapterId: 'registry',
      adapters: [namedAdapter('adapter-a'), failing],
      selectAdapter: () => 'adapter-b',
    });
    const w = world({ executionAdapter: registry });

    const first = await w.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
    assert.equal(first.status, 'execution_failed');
    assert.equal(await outcomeRowFor(w, first.requestId ?? '', first.executionId ?? ''), 'execution-failed:PROVIDER_REJECTED@adapter-b');

    const retry = await w.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
    assert.equal(retry.status, 'execution_failed');
    assert.deepEqual([...retry.reasonCodes], ['PROVIDER_REJECTED'], 'the suffix never leaks into the reported failure');
  });

  it('a withheld attempt records no adapter, because nothing performed anything', async () => {
    const emergencyControl = controls();
    const w = world({
      emergencyControl,
      beforeExercise: async () => {
        emergencyControl.activate({ scope: 'global', issuerRef: ISSUER, declaredAt: NOW });
      },
    });
    const result = await w.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
    const recorded = await outcomeRowFor(w, result.requestId ?? '', result.executionId ?? '');
    assert.equal(recorded, `withheld:emergency-control:${EMERGENCY_CONTROL_REASON_CODES.EMERGENCY_CONTROL_ACTIVE}`);
    assert.equal(recorded?.includes('@'), false);
  });

  it('the child identity stays out of the customer result — evidence, not disclosure', async () => {
    const { w } = routedWorld({ select: () => 'adapter-a' });
    const result = await w.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes('adapter-a'), false, 'which provider ran is answerable from the record, not handed to the caller');
    assert.equal(serialized.includes('registry'), false);
    assert.equal(Object.hasOwn(result, 'adapterId'), false);
  });
});

describe('Emergency control — historical replay is never rewritten by current state', () => {
  async function replayAfter(options: {
    readonly first: WorldOptions;
    readonly activateBeforeRetry?: boolean;
  }): Promise<{ readonly first: Awaited<ReturnType<GovernedWorld['orchestrator']['govern']>>; readonly retry: Awaited<ReturnType<GovernedWorld['orchestrator']['govern']>>; readonly w: GovernedWorld }> {
    const w = world(options.first);
    const first = await w.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
    if (options.activateBeforeRetry !== false) {
      const reader = options.first.emergencyControl as ReturnType<typeof controls>;
      reader.activate({ scope: 'global', issuerRef: ISSUER, declaredAt: NOW });
    }
    const retry = await w.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
    return { first, retry, w };
  }

  it('Case A — a recorded execution replays as executed, even with a global stop now active', async () => {
    const emergencyControl = controls();
    const { first, retry, w } = await replayAfter({ first: { emergencyControl } });
    assert.equal(first.status, 'executed');
    assert.equal(retry.status, 'executed');
    assert.equal(retry.status === 'executed' ? retry.replayed : undefined, true);
    assert.equal(w.adapter.callCount, 1, 'the adapter is never invoked a second time');
    assert.equal(w.issueOutcomes.length, 1, 'no new grant is minted to tell a caller what already happened');
  });

  it('a recorded provider failure replays as that failure, even with a stop now active', async () => {
    const emergencyControl = controls();
    const { first, retry, w } = await replayAfter({
      first: { emergencyControl, adapterBehaviour: () => ({ outcome: 'failed', reason: 'PROVIDER_REJECTED' }) },
    });
    assert.equal(first.status, 'execution_failed');
    assert.equal(retry.status, 'execution_failed');
    assert.deepEqual([...retry.reasonCodes], ['PROVIDER_REJECTED']);
    assert.equal(w.adapter.callCount, 1);
  });

  it('a recorded grant-exercise withholding replays in the grant-exercise vocabulary, not the interlock’s', async () => {
    const emergencyControl = controls();
    let revokeOnce = true;
    const { first, retry, w } = await replayAfter({
      first: {
        emergencyControl,
        beforeExercise: async ({ ace }, grantId) => {
          if (!revokeOnce) return;
          revokeOnce = false;
          await ace.revokeGrant({ grantId, reason: 'manual-revocation', issuerRef: 'operator-1' });
        },
      },
    });
    assert.equal(withheldBy(first), 'exercise');
    assert.equal(withheldBy(retry), 'exercise', 'a stop active today does not relabel yesterday’s grant refusal');
    assert.deepEqual([...retry.reasonCodes], [GRANT_EXERCISE_REASON_CODES.GRANT_EXERCISE_REVOKED]);
    assert.equal(w.adapter.callCount, 0);
  });

  it('a recorded emergency-control withholding replays as one, even after the stop is cleared', async () => {
    const emergencyControl = controls();
    const w = world({
      emergencyControl,
      beforeExercise: async () => {
        emergencyControl.activate({ scope: 'global', issuerRef: ISSUER, declaredAt: NOW });
      },
    });
    const first = await w.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
    assert.equal(withheldBy(first), 'emergency-control');

    emergencyControl.release({ scope: 'global', issuerRef: ISSUER, releasedAt: NOW });
    const retry = await w.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
    assert.equal(withheldBy(retry), 'emergency-control', 'the record is what happened; clearing the stop does not rewrite it');
    assert.deepEqual([...retry.reasonCodes], [EMERGENCY_CONTROL_REASON_CODES.EMERGENCY_CONTROL_ACTIVE]);
    assert.equal(w.adapter.callCount, 0);
    assert.equal(w.issueOutcomes.length, 1);
  });

  it('Case B — an attempt with no recorded outcome stays unconfirmed, whatever the interlock says now', async () => {
    for (const activate of [true, false]) {
      const emergencyControl = controls();
      const w = world({
        emergencyControl,
        beforeExercise: async () => {
          throw new Error('the exercise port is unreachable');
        },
      });
      const first = await w.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
      assert.equal(first.status, 'execution_unconfirmed');
      if (activate) emergencyControl.activate({ scope: 'global', issuerRef: ISSUER, declaredAt: NOW });
      const retry = await w.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
      assert.equal(retry.status, 'execution_unconfirmed');
      assert.equal(w.adapter.callCount, 0);
    }
  });

  it('Case D — a pre-execution withholding wrote no execution claim, so a cleared stop lets the retry proceed', async () => {
    const emergencyControl = controls();
    emergencyControl.activate({ scope: 'global', issuerRef: ISSUER, declaredAt: NOW });
    const w = world({ emergencyControl });

    const first = await w.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
    assert.equal(withheldBy(first), 'emergency-control');
    const record = await recordFor(w, first.requestId ?? '');
    assert.equal(record?.references.length, 0, 'an admission withholding claims no execution identity');

    emergencyControl.release({ scope: 'global', issuerRef: ISSUER, releasedAt: NOW });
    const retry = await w.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
    assert.equal(retry.status, 'executed');
    assert.equal(w.adapter.callCount, 1);
  });

  it('the recorded emergency outcome row is the layered form, and a forged one decodes as nothing', async () => {
    const emergencyControl = controls();
    const w = world({
      emergencyControl,
      beforeExercise: async () => {
        emergencyControl.activate({ scope: 'global', issuerRef: ISSUER, declaredAt: NOW });
      },
    });
    const first = await w.orchestrator.govern(IDENTITY, ALLOWED_INTENT);
    const record = await recordFor(w, first.requestId ?? '');
    const outcomeRow = record?.references.find((reference) => reference.referenceId === executionOutcomeReferenceId(first.executionId ?? ''));
    assert.equal(outcomeRow?.externalVersion, `withheld:emergency-control:${EMERGENCY_CONTROL_REASON_CODES.EMERGENCY_CONTROL_ACTIVE}`);
  });
});
