import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { EmergencyControlWithheldError, createInMemoryEmergencyControlStore, EMERGENCY_CONTROL_REASON_CODES } from '../../emergency-control-runtime/index.js';
import { createInMemoryBoundedGrantStore, type BoundedGrantStorePort } from '../../grant-runtime/index.js';
import {
  EXECUTION_FAILURE_REASONS,
  createExecutionAdapterRegistry,
  createGrantExecutionService,
  isExecutionAdapterRegistry,
  isExecutionAdapterRegistryError,
  isRecordableExecutionAdapterId,
  type ExecutionAdapter,
  type ExecutionOutcome,
  type ValidatedExecutionAction,
} from '../index.js';
import { buildExerciseRequest, buildTestGrant, createRecordingExecutionAdapter, type RecordingExecutionAdapter } from './execution-fixture.js';

/**
 * Server-side routing, measured by **which** child ran and **how many times**.
 *
 * The property is never "the registry returned something". It is that exactly
 * one registered adapter was invoked, exactly once, with exactly the action the
 * exercise gate assessed — and that every failure mode invokes none of them.
 */

const AT_T_PLUS_5 = '2026-01-01T12:05:00.000Z';
const ISSUER = 'operator:on-call';
const AT = '2026-01-01T00:00:00.000Z';

function namedAdapter(adapterId: string): RecordingExecutionAdapter {
  const adapter = createRecordingExecutionAdapter();
  return { ...adapter, adapterId, get callCount() { return adapter.callCount; }, calls: adapter.calls, execute: (action) => adapter.execute(action) };
}

async function seed(): Promise<BoundedGrantStorePort> {
  const store = createInMemoryBoundedGrantStore();
  const issued = await store.issue({ grant: buildTestGrant(), commitGuard: () => ({ permitted: true, reasonCodes: [] }) });
  assert.equal(issued.outcome, 'issued');
  return store;
}

/** The exercise gate over a registry, so the registry is only ever reached the way production reaches it. */
async function exerciseThrough(registry: ExecutionAdapter, emergencyControl?: ReturnType<typeof createInMemoryEmergencyControlStore>): Promise<ExecutionOutcome> {
  const store = await seed();
  const service = createGrantExecutionService({
    store,
    adapter: registry,
    now: () => AT_T_PLUS_5,
    ...(emergencyControl !== undefined ? { emergencyControl } : {}),
  });
  return service.exercise(buildExerciseRequest(buildTestGrant()));
}

describe('Adapter registry — composition refuses what it could not route deterministically', () => {
  const selector = () => 'adapter-a';

  it('refuses an empty registry: a registry that can route nothing must not be composed as the execution adapter', () => {
    assert.throws(
      () => createExecutionAdapterRegistry({ adapters: [], selectAdapter: selector }),
      (error: unknown) => isExecutionAdapterRegistryError(error) && error.code === 'EXECUTION_ADAPTER_REGISTRY_EMPTY',
    );
  });

  it('refuses duplicate adapter ids: routing would resolve to whichever was registered last', () => {
    assert.throws(
      () => createExecutionAdapterRegistry({ adapters: [namedAdapter('adapter-a'), namedAdapter('adapter-a')], selectAdapter: selector }),
      (error: unknown) => isExecutionAdapterRegistryError(error) && error.code === 'EXECUTION_ADAPTER_ID_DUPLICATE',
    );
  });

  it('refuses a blank adapter id and a malformed adapter object', () => {
    for (const adapters of [[namedAdapter('')], [{ adapterId: 'adapter-a' } as unknown as ExecutionAdapter], [null as unknown as ExecutionAdapter]]) {
      assert.throws(
        () => createExecutionAdapterRegistry({ adapters, selectAdapter: selector }),
        (error: unknown) => isExecutionAdapterRegistryError(error) && error.code === 'EXECUTION_ADAPTER_MALFORMED',
      );
    }
  });

  it('refuses a registry registered inside a registry — one routing decision resolves to one provider', () => {
    const inner = createExecutionAdapterRegistry({ adapters: [namedAdapter('adapter-a')], selectAdapter: selector });
    assert.throws(
      () => createExecutionAdapterRegistry({ adapters: [inner, namedAdapter('adapter-b')], selectAdapter: selector }),
      (error: unknown) => isExecutionAdapterRegistryError(error) && error.code === 'EXECUTION_ADAPTER_REGISTRY_RECURSIVE',
    );
  });

  it('refuses an adapter that claims the registry’s own identity', () => {
    assert.throws(
      () => createExecutionAdapterRegistry({ adapterId: 'router', adapters: [namedAdapter('router')], selectAdapter: selector }),
      (error: unknown) => isExecutionAdapterRegistryError(error) && error.code === 'EXECUTION_ADAPTER_REGISTRY_RECURSIVE',
    );
  });

  it('refuses a selector that is not a function', () => {
    assert.throws(
      () => createExecutionAdapterRegistry({ adapters: [namedAdapter('adapter-a')], selectAdapter: undefined as never }),
      (error: unknown) => isExecutionAdapterRegistryError(error) && error.code === 'EXECUTION_ADAPTER_SELECTOR_INVALID',
    );
  });

  it('membership is frozen: there is no register/unregister surface to mutate while traffic flows', () => {
    const registry = createExecutionAdapterRegistry({ adapters: [namedAdapter('adapter-a')], selectAdapter: selector }) as unknown as Record<string, unknown>;
    assert.deepEqual(Object.keys(registry).sort(), ['adapterId', 'execute']);
    assert.equal(Object.isFrozen(registry), true);
    for (const mutation of ['register', 'unregister', 'add', 'remove', 'adapters']) {
      assert.equal(mutation in registry, false, `a registry must not expose '${mutation}'`);
    }
  });

  it('satisfies the ExecutionAdapter port itself, which is what lets it stand where one adapter stood', () => {
    const registry: ExecutionAdapter = createExecutionAdapterRegistry({ adapterId: 'router', adapters: [namedAdapter('adapter-a')], selectAdapter: selector });
    assert.equal(registry.adapterId, 'router');
    assert.equal(typeof registry.execute, 'function');
  });
});

describe('Adapter registry — exactly one child, exactly once', () => {
  function world(select: (action: ValidatedExecutionAction) => string | undefined) {
    const a = namedAdapter('adapter-a');
    const b = namedAdapter('adapter-b');
    return { a, b, registry: createExecutionAdapterRegistry({ adapters: [a, b], selectAdapter: select }) };
  }

  it('routes to A, and B is never touched', async () => {
    const { a, b, registry } = world((action) => (action.resource === 'vendor/V123' ? 'adapter-a' : 'adapter-b'));
    const outcome = await exerciseThrough(registry);
    assert.equal(outcome.status, 'executed');
    assert.equal(a.callCount, 1);
    assert.equal(b.callCount, 0);
  });

  it('routes to B when the trusted selector says so, and A is never touched', async () => {
    const { a, b, registry } = world(() => 'adapter-b');
    const outcome = await exerciseThrough(registry);
    assert.equal(outcome.status, 'executed');
    assert.equal(a.callCount, 0);
    assert.equal(b.callCount, 1);
  });

  it('an unknown adapter id calls no child and fails safely — not a denial', async () => {
    const { a, b, registry } = world(() => 'adapter-that-does-not-exist');
    const outcome = await exerciseThrough(registry);
    assert.equal(outcome.status, 'execution-failed');
    assert.equal(outcome.status === 'execution-failed' ? outcome.reason : undefined, EXECUTION_FAILURE_REASONS.ADAPTER_ERROR);
    assert.equal(a.callCount + b.callCount, 0);
    // The authorization is untouched: nothing here is a Kernel status or a
    // grant refusal, and the assessment that permitted it still says so.
    assert.equal(outcome.status === 'execution-failed' ? outcome.assessment.usable : undefined, true);
  });

  it('an undefined route calls no child', async () => {
    const { a, b, registry } = world(() => undefined);
    const outcome = await exerciseThrough(registry);
    assert.equal(outcome.status, 'execution-failed');
    assert.equal(a.callCount + b.callCount, 0);
  });

  it('a selector that throws calls no child, and the throw never escapes as an authorization outcome', async () => {
    const { a, b, registry } = world(() => {
      throw new Error('routing table unavailable');
    });
    const outcome = await exerciseThrough(registry);
    assert.equal(outcome.status, 'execution-failed');
    assert.equal(a.callCount + b.callCount, 0);
  });

  it('a child that throws keeps the existing ADAPTER_ERROR semantics', async () => {
    const throwing: ExecutionAdapter = {
      adapterId: 'adapter-a',
      execute() {
        throw new Error('provider client exploded');
      },
    };
    const registry = createExecutionAdapterRegistry({ adapters: [throwing], selectAdapter: () => 'adapter-a' });
    const outcome = await exerciseThrough(registry);
    assert.equal(outcome.status, 'execution-failed');
    assert.equal(outcome.status === 'execution-failed' ? outcome.reason : undefined, EXECUTION_FAILURE_REASONS.ADAPTER_ERROR);
  });

  it('a child that reports a provider failure keeps reporting a provider failure', async () => {
    const failing: ExecutionAdapter = {
      adapterId: 'adapter-a',
      async execute() {
        return { outcome: 'failed', reason: EXECUTION_FAILURE_REASONS.PROVIDER_REJECTED };
      },
    };
    const registry = createExecutionAdapterRegistry({ adapters: [failing], selectAdapter: () => 'adapter-a' });
    const outcome = await exerciseThrough(registry);
    assert.equal(outcome.status === 'execution-failed' ? outcome.reason : undefined, EXECUTION_FAILURE_REASONS.PROVIDER_REJECTED);
  });
});

describe('Adapter registry — the child sees exactly what was assessed', () => {
  it('every field the gate proved arrives unchanged, and nothing is added', async () => {
    const child = namedAdapter('adapter-a');
    const registry = createExecutionAdapterRegistry({ adapters: [child], selectAdapter: () => 'adapter-a' });

    const store = await seed();
    const direct = createRecordingExecutionAdapter();
    const throughRegistry = createGrantExecutionService({ store, adapter: registry, now: () => AT_T_PLUS_5 });
    const throughAdapter = createGrantExecutionService({ store, adapter: direct, now: () => AT_T_PLUS_5 });

    await throughRegistry.exercise(buildExerciseRequest(buildTestGrant()));
    await throughAdapter.exercise(buildExerciseRequest(buildTestGrant()));

    assert.equal(child.callCount, 1);
    assert.equal(direct.callCount, 1);
    // Byte-identical: routing widened nothing, narrowed nothing, and injected
    // no provider material on the way down.
    assert.deepEqual(child.calls[0], direct.calls[0]);
  });

  it('the action the child receives carries no adapter, provider, url or credential field', async () => {
    const child = namedAdapter('adapter-a');
    const registry = createExecutionAdapterRegistry({ adapters: [child], selectAdapter: () => 'adapter-a' });
    await exerciseThrough(registry);
    const action = child.calls[0] as unknown as Record<string, unknown>;
    assert.deepEqual(Object.keys(action).sort(), ['action', 'amount', 'boundedGrantId', 'correlation', 'counterparty', 'notAfter', 'organization', 'resource', 'subject'].sort());
    for (const forbidden of ['adapter', 'adapterId', 'provider', 'url', 'endpoint', 'host', 'credential', 'payload', 'grant', 'decision']) {
      assert.equal(forbidden in action, false, `'${forbidden}' must not cross the adapter boundary`);
    }
  });

  it('the selector is handed the validated action and nothing else', async () => {
    const seen: unknown[] = [];
    const child = namedAdapter('adapter-a');
    const registry = createExecutionAdapterRegistry({
      adapters: [child],
      selectAdapter: (...args) => {
        seen.push(args);
        return 'adapter-a';
      },
    });
    await exerciseThrough(registry);
    assert.equal(seen.length, 1);
    assert.equal((seen[0] as readonly unknown[]).length, 1, 'the selector receives one argument: the validated action');
    assert.deepEqual(seen[0], [child.calls[0]]);
  });
});

describe('Adapter registry — the outcome names the child that performed the effect', () => {
  it('a successful route reports the child as the performer and the registry as the router', async () => {
    const a = namedAdapter('adapter-a');
    const b = namedAdapter('adapter-b');
    const registry = createExecutionAdapterRegistry({ adapterId: 'registry', adapters: [a, b], selectAdapter: () => 'adapter-a' });

    const outcome = await exerciseThrough(registry);
    assert.equal(outcome.status, 'executed');
    // The question an auditor asks is "which provider did this", and the name
    // of the router is not an answer to it.
    assert.equal(outcome.status === 'executed' ? outcome.adapterId : undefined, 'adapter-a');
    assert.equal(outcome.status === 'executed' ? outcome.routedBy : undefined, 'registry');
    assert.equal(a.callCount, 1);
    assert.equal(b.callCount, 0);
  });

  it('a different route reports a different performer, so two effects are distinguishable', async () => {
    const a = namedAdapter('adapter-a');
    const b = namedAdapter('adapter-b');
    const registry = createExecutionAdapterRegistry({ adapterId: 'registry', adapters: [a, b], selectAdapter: () => 'adapter-b' });

    const outcome = await exerciseThrough(registry);
    assert.equal(outcome.status === 'executed' ? outcome.adapterId : undefined, 'adapter-b');
    assert.equal(outcome.status === 'executed' ? outcome.routedBy : undefined, 'registry');
  });

  it('a provider failure names the provider that failed, not the router', async () => {
    const failing: ExecutionAdapter = {
      adapterId: 'adapter-a',
      async execute() {
        return { outcome: 'failed', reason: EXECUTION_FAILURE_REASONS.PROVIDER_REJECTED };
      },
    };
    const registry = createExecutionAdapterRegistry({ adapterId: 'registry', adapters: [failing], selectAdapter: () => 'adapter-a' });
    const outcome = await exerciseThrough(registry);
    assert.ok(outcome.status === 'execution-failed');
    assert.equal(outcome.reason, EXECUTION_FAILURE_REASONS.PROVIDER_REJECTED);
    assert.equal(outcome.adapterId, 'adapter-a');
    assert.equal(outcome.routedBy, 'registry');
  });

  it('a child that throws is still attributed to that child', async () => {
    const throwing: ExecutionAdapter = {
      adapterId: 'adapter-a',
      execute() {
        throw new Error('provider client exploded');
      },
    };
    const registry = createExecutionAdapterRegistry({ adapterId: 'registry', adapters: [throwing], selectAdapter: () => 'adapter-a' });
    const outcome = await exerciseThrough(registry);
    assert.ok(outcome.status === 'execution-failed');
    assert.equal(outcome.reason, EXECUTION_FAILURE_REASONS.ADAPTER_ERROR);
    assert.equal(outcome.adapterId, 'adapter-a');
    assert.equal(outcome.detail, 'provider client exploded');
  });

  it('an unresolved route is attributed to the router, because no child ran', async () => {
    const registry = createExecutionAdapterRegistry({ adapterId: 'registry', adapters: [namedAdapter('adapter-a')], selectAdapter: () => undefined });
    const outcome = await exerciseThrough(registry);
    assert.ok(outcome.status === 'execution-failed');
    assert.equal(outcome.adapterId, 'registry');
    assert.equal(outcome.routedBy, undefined);
  });

  it('a child cannot claim to be a different adapter — attribution is the routing decision’s', async () => {
    const liar: ExecutionAdapter = {
      adapterId: 'adapter-a',
      async execute() {
        return { outcome: 'completed', providerRef: 'ref', adapterId: 'adapter-b' };
      },
    };
    const registry = createExecutionAdapterRegistry({ adapterId: 'registry', adapters: [liar], selectAdapter: () => 'adapter-a' });
    const outcome = await exerciseThrough(registry);
    assert.equal(outcome.status === 'executed' ? outcome.adapterId : undefined, 'adapter-a', 'the registry overwrites what the child claimed');
  });

  it('a single composed adapter names itself and reports no router — unchanged behaviour', async () => {
    const store = await seed();
    const direct = createRecordingExecutionAdapter();
    const service = createGrantExecutionService({ store, adapter: direct, now: () => AT_T_PLUS_5 });
    const outcome = await service.exercise(buildExerciseRequest(buildTestGrant()));
    assert.equal(outcome.status === 'executed' ? outcome.adapterId : undefined, direct.adapterId);
    assert.equal(outcome.status === 'executed' ? outcome.routedBy : undefined, undefined);
  });

  it('an identity that could not be recorded exactly is refused at composition', async () => {
    for (const adapterId of ['has@delimiter', 'x'.repeat(65), '-leading-dash', 'has space']) {
      assert.throws(
        () => createExecutionAdapterRegistry({ adapters: [namedAdapter(adapterId)], selectAdapter: () => adapterId }),
        (error: unknown) => isExecutionAdapterRegistryError(error) && error.code === 'EXECUTION_ADAPTER_MALFORMED',
        `'${adapterId}' must be refused`,
      );
    }
    assert.equal(isRecordableExecutionAdapterId('frontera.execution-adapter-registry'), true);
    assert.equal(isRecordableExecutionAdapterId('test.fake-provider'), true);
  });
});

describe('Adapter registry — the adapter-scoped emergency control', () => {
  function twoAdapterWorld() {
    const a = namedAdapter('adapter-a');
    const b = namedAdapter('adapter-b');
    const controls = createInMemoryEmergencyControlStore();
    const registry = createExecutionAdapterRegistry({
      adapters: [a, b],
      // Route by counterparty, so two different actions reach two different providers.
      selectAdapter: (action) => (action.counterparty === 'V123' ? 'adapter-a' : 'adapter-b'),
      emergencyControl: controls,
    });
    return { a, b, controls, registry };
  }

  it('a stop on adapter-a withholds the action routed to it, and calls neither child', async () => {
    const { a, b, controls, registry } = twoAdapterWorld();
    controls.activate({ scope: 'adapter', value: 'adapter-a', issuerRef: ISSUER, declaredAt: AT });

    const outcome = await exerciseThrough(registry, controls);
    assert.equal(outcome.status, 'withheld');
    assert.equal(outcome.status === 'withheld' ? outcome.withheldBy : undefined, 'emergency-control');
    assert.deepEqual(
      outcome.status === 'withheld' && outcome.withheldBy === 'emergency-control' ? outcome.emergencyControl.reasonCodes : [],
      [EMERGENCY_CONTROL_REASON_CODES.EMERGENCY_CONTROL_ACTIVE],
    );
    assert.equal(a.callCount, 0);
    assert.equal(b.callCount, 0);
    // The grant was fine. That is the whole point of the separate case.
    assert.equal(outcome.status === 'withheld' ? outcome.assessment.usable : undefined, true);
    assert.deepEqual(outcome.status === 'withheld' ? outcome.assessment.reasonCodes : ['x'], []);
  });

  it('an unrelated adapter keeps running while adapter-a is stopped', async () => {
    const { a, b, controls, registry } = twoAdapterWorld();
    controls.activate({ scope: 'adapter', value: 'adapter-a', issuerRef: ISSUER, declaredAt: AT });

    // The same grant, exercised for a counterparty the routing sends to B.
    const grant = buildTestGrant({
      scope: {
        action: { kind: 'identity', value: 'payment' },
        amount: { kind: 'ceiling', limit: 7_500, unit: 'USD' },
        counterparty: { kind: 'identity', value: 'V999' },
        organization: { kind: 'identity', value: 'org-acme' },
        resources: { kind: 'set', values: ['vendor/V123'] },
      },
    });
    const store = createInMemoryBoundedGrantStore();
    await store.issue({ grant, commitGuard: () => ({ permitted: true, reasonCodes: [] }) });
    const service = createGrantExecutionService({ store, adapter: registry, now: () => AT_T_PLUS_5, emergencyControl: controls });
    const outcome = await service.exercise(buildExerciseRequest(grant, { counterparty: 'V999' }));

    assert.equal(outcome.status, 'executed');
    assert.equal(a.callCount, 0);
    assert.equal(b.callCount, 1);
  });

  it('an unreadable control at the adapter check calls no child', async () => {
    const { a, b, controls, registry } = twoAdapterWorld();
    controls.simulateUnavailable(true);
    const outcome = await exerciseThrough(registry, controls);
    assert.equal(outcome.status === 'withheld' ? outcome.withheldBy : undefined, 'emergency-control');
    assert.deepEqual(
      outcome.status === 'withheld' && outcome.withheldBy === 'emergency-control' ? outcome.emergencyControl.reasonCodes : [],
      [EMERGENCY_CONTROL_REASON_CODES.EMERGENCY_CONTROL_UNAVAILABLE],
    );
    assert.equal(a.callCount + b.callCount, 0);
  });

  it('a clear control runs exactly one child exactly once', async () => {
    const { a, b, controls, registry } = twoAdapterWorld();
    const outcome = await exerciseThrough(registry, controls);
    assert.equal(outcome.status, 'executed');
    assert.equal(a.callCount, 1);
    assert.equal(b.callCount, 0);
  });

  it('an adapter that throws an ordinary error is never reported as an emergency stop', async () => {
    const controls = createInMemoryEmergencyControlStore();
    const impostor: ExecutionAdapter = {
      adapterId: 'adapter-a',
      execute() {
        // Deliberately shaped like the signal, but not the signal.
        const error = new Error('Execution was withheld by an active or unreadable emergency control.');
        error.name = 'EmergencyControlWithheldError';
        throw error;
      },
    };
    const registry = createExecutionAdapterRegistry({ adapters: [impostor], selectAdapter: () => 'adapter-a', emergencyControl: controls });
    const outcome = await exerciseThrough(registry, controls);
    assert.equal(outcome.status, 'execution-failed');
    assert.equal(outcome.status === 'execution-failed' ? outcome.reason : undefined, EXECUTION_FAILURE_REASONS.ADAPTER_ERROR);
  });

  it('a registry composed with no reader enforces no adapter stop, and says so by behaving unchanged', async () => {
    const a = namedAdapter('adapter-a');
    const controls = createInMemoryEmergencyControlStore();
    controls.activate({ scope: 'adapter', value: 'adapter-a', issuerRef: ISSUER, declaredAt: AT });
    const registry = createExecutionAdapterRegistry({ adapters: [a], selectAdapter: () => 'adapter-a' });
    const outcome = await exerciseThrough(registry);
    assert.equal(outcome.status, 'executed');
    assert.equal(a.callCount, 1);
  });
});

describe('Adapter trust — only a real registry can name another adapter, or claim an emergency stop', () => {
  /** The exercise gate over a **directly composed** adapter, the way a host that never built a registry reaches it. */
  async function exerciseDirect(adapter: ExecutionAdapter, emergencyControl?: ReturnType<typeof createInMemoryEmergencyControlStore>): Promise<ExecutionOutcome> {
    const store = await seed();
    const service = createGrantExecutionService({
      store,
      adapter,
      now: () => AT_T_PLUS_5,
      ...(emergencyControl !== undefined ? { emergencyControl } : {}),
    });
    return service.exercise(buildExerciseRequest(buildTestGrant()));
  }

  it('membership is the proof, and it cannot be forged from outside', () => {
    // Every cheaper test is a value some caller can also produce. This one is a
    // `WeakSet` the factory alone adds to, so the impostors below — including
    // one that copies the real registry's own shape and identity — are all
    // answered `false`.
    const real = createExecutionAdapterRegistry({ adapterId: 'registry', adapters: [namedAdapter('adapter-a')], selectAdapter: () => 'adapter-a' });
    assert.equal(isExecutionAdapterRegistry(real), true);

    const impostors: unknown[] = [
      namedAdapter('adapter-a'),
      { adapterId: 'frontera.execution-adapter-registry', execute: async () => ({ outcome: 'completed' }) },
      { adapterId: 'registry', execute: real.execute },
      Object.freeze({ ...real }),
      Object.create(real as object),
      null,
      undefined,
      'registry',
    ];
    for (const impostor of impostors) {
      assert.equal(isExecutionAdapterRegistry(impostor), false, `${String((impostor as { adapterId?: string } | null)?.adapterId ?? impostor)} must not pass as a registry`);
    }
  });

  it('REGRESSION — A. a direct adapter returning another adapterId is ignored; it keeps its own identity', async () => {
    // The defect this pins. `ExecutionAdapterResult.adapterId` exists for the
    // registry's benefit, but the type exposes it to every adapter in
    // existence, and the service used to honour it from any of them: an effect
    // performed by adapter-a persisted as having been performed by adapter-b,
    // with no registry and no routing anywhere in the picture. A durable record
    // that names the wrong party is worse than one that names nobody.
    const liar: ExecutionAdapter = {
      adapterId: 'adapter-a',
      async execute() {
        return { outcome: 'completed', providerRef: 'ref', adapterId: 'adapter-b' };
      },
    };
    const outcome = await exerciseDirect(liar);
    assert.equal(outcome.status, 'executed');
    assert.equal(outcome.status === 'executed' ? outcome.adapterId : undefined, 'adapter-a', 'a direct adapter cannot override its own identity');
    assert.equal(outcome.status === 'executed' ? outcome.routedBy : undefined, undefined, 'nothing routed, so nothing routed it');
  });

  it('REGRESSION — A. the same holds on the failure arm, where attribution also persists', async () => {
    const liar: ExecutionAdapter = {
      adapterId: 'adapter-a',
      async execute() {
        return { outcome: 'failed', reason: EXECUTION_FAILURE_REASONS.PROVIDER_REJECTED, adapterId: 'adapter-b' };
      },
    };
    const outcome = await exerciseDirect(liar);
    assert.ok(outcome.status === 'execution-failed');
    assert.equal(outcome.adapterId, 'adapter-a');
    assert.equal(outcome.routedBy, undefined);
  });

  it('B. a direct adapter returning its own id behaves exactly as it always did', async () => {
    const honest: ExecutionAdapter = {
      adapterId: 'adapter-a',
      async execute() {
        return { outcome: 'completed', providerRef: 'ref', adapterId: 'adapter-a' };
      },
    };
    const outcome = await exerciseDirect(honest);
    assert.equal(outcome.status === 'executed' ? outcome.adapterId : undefined, 'adapter-a');
    assert.equal(outcome.status === 'executed' ? outcome.routedBy : undefined, undefined);

    // And so does one that says nothing at all about its identity.
    const silent = createRecordingExecutionAdapter();
    const quiet = await exerciseDirect(silent);
    assert.equal(quiet.status === 'executed' ? quiet.adapterId : undefined, silent.adapterId);
    assert.equal(quiet.status === 'executed' ? quiet.routedBy : undefined, undefined);
  });

  it('C and D. a real registry still carries its child’s identity through, whichever child it chose', async () => {
    for (const child of ['adapter-a', 'adapter-b'] as const) {
      const a = namedAdapter('adapter-a');
      const b = namedAdapter('adapter-b');
      const registry = createExecutionAdapterRegistry({ adapterId: 'router', adapters: [a, b], selectAdapter: () => child });
      const outcome = await exerciseThrough(registry);
      assert.equal(outcome.status, 'executed');
      assert.equal(outcome.status === 'executed' ? outcome.adapterId : undefined, child, 'trusted routing may name the child it resolved');
      assert.equal(outcome.status === 'executed' ? outcome.routedBy : undefined, 'router');
      assert.equal(child === 'adapter-a' ? a.callCount : b.callCount, 1);
      assert.equal(child === 'adapter-a' ? b.callCount : a.callCount, 0);
    }
  });

  it('REGRESSION — a direct adapter throwing a real EmergencyControlWithheldError is still ADAPTER_ERROR', async () => {
    // The defect this pins. The class is an ordinary one whose constructor
    // takes an assessment object, so recognising it by type alone let any
    // directly composed adapter relabel its own provider failure as an
    // operator stop — and that mislabelling is what gets persisted. The type is
    // not the authentication; registry membership is, because only a registry
    // actually consults an EmergencyControlReaderPort before reaching a child.
    const spoofer: ExecutionAdapter = {
      adapterId: 'adapter-a',
      async execute(): Promise<never> {
        throw new EmergencyControlWithheldError({
          state: 'blocked',
          reasonCodes: [EMERGENCY_CONTROL_REASON_CODES.EMERGENCY_CONTROL_ACTIVE],
          matchedScopes: [{ scope: 'global' }],
        });
      },
    };
    const outcome = await exerciseDirect(spoofer);
    assert.equal(outcome.status, 'execution-failed', 'no reader withheld anything, so nothing was withheld');
    assert.ok(outcome.status === 'execution-failed');
    assert.equal(outcome.reason, EXECUTION_FAILURE_REASONS.ADAPTER_ERROR);
    assert.equal(outcome.adapterId, 'adapter-a');
    assert.equal(Object.hasOwn(outcome, 'withheldBy'), false);

    // It holds with an interlock composed, too: the reader is clear, and the
    // adapter's throw must not be able to speak for it.
    const controls = createInMemoryEmergencyControlStore();
    const withReader = await exerciseDirect(spoofer, controls);
    assert.equal(withReader.status, 'execution-failed');
  });

  it('B. a direct adapter throwing a lookalike is ADAPTER_ERROR, as it always was', async () => {
    class EmergencyControlWithheldError2 extends Error {
      readonly reasonCodes = [EMERGENCY_CONTROL_REASON_CODES.EMERGENCY_CONTROL_ACTIVE];
      readonly matchedScopes = [{ scope: 'global' as const }];
      constructor() {
        super('Execution was withheld by an active or unreadable emergency control.');
        this.name = 'EmergencyControlWithheldError';
      }
    }
    for (const error of [new EmergencyControlWithheldError2(), new Error('provider exploded'), 'a string']) {
      const thrower: ExecutionAdapter = {
        adapterId: 'adapter-a',
        async execute(): Promise<never> {
          throw error;
        },
      };
      const outcome = await exerciseDirect(thrower);
      assert.ok(outcome.status === 'execution-failed', `${String(error)} must not be read as a withholding`);
      assert.equal(outcome.reason, EXECUTION_FAILURE_REASONS.ADAPTER_ERROR);
    }
  });

  it('C. a registry that finds an adapter-scoped stop still withholds through the interlock', async () => {
    const child = namedAdapter('adapter-a');
    const controls = createInMemoryEmergencyControlStore();
    controls.activate({ scope: 'adapter', value: 'adapter-a', issuerRef: ISSUER, declaredAt: AT });
    const registry = createExecutionAdapterRegistry({ adapterId: 'router', adapters: [child], selectAdapter: () => 'adapter-a', emergencyControl: controls });

    const outcome = await exerciseThrough(registry, controls);
    assert.equal(outcome.status, 'withheld');
    assert.equal(outcome.status === 'withheld' ? outcome.withheldBy : undefined, 'emergency-control');
    assert.deepEqual(
      outcome.status === 'withheld' && outcome.withheldBy === 'emergency-control' ? outcome.emergencyControl.reasonCodes : [],
      [EMERGENCY_CONTROL_REASON_CODES.EMERGENCY_CONTROL_ACTIVE],
    );
    assert.equal(child.callCount, 0, 'the provider is never contacted');
  });

  it('D. a registry whose emergency reader is unreadable withholds rather than proceeding', async () => {
    const child = namedAdapter('adapter-a');
    const controls = createInMemoryEmergencyControlStore();
    controls.simulateUnavailable(true);
    const registry = createExecutionAdapterRegistry({ adapterId: 'router', adapters: [child], selectAdapter: () => 'adapter-a', emergencyControl: controls });

    const outcome = await exerciseThrough(registry);
    assert.equal(outcome.status, 'withheld');
    assert.equal(outcome.status === 'withheld' ? outcome.withheldBy : undefined, 'emergency-control');
    assert.deepEqual(
      outcome.status === 'withheld' && outcome.withheldBy === 'emergency-control' ? outcome.emergencyControl.reasonCodes : [],
      [EMERGENCY_CONTROL_REASON_CODES.EMERGENCY_CONTROL_UNAVAILABLE],
    );
    assert.equal(child.callCount, 0);
  });

  it('E. an ordinary throw from a child behind a registry stays ADAPTER_ERROR, attributed to that child', async () => {
    const throwing: ExecutionAdapter = {
      adapterId: 'adapter-b',
      async execute(): Promise<never> {
        throw new Error('provider timed out');
      },
    };
    const registry = createExecutionAdapterRegistry({
      adapterId: 'router',
      adapters: [namedAdapter('adapter-a'), throwing],
      selectAdapter: () => 'adapter-b',
    });
    const outcome = await exerciseThrough(registry);
    assert.ok(outcome.status === 'execution-failed');
    assert.equal(outcome.reason, EXECUTION_FAILURE_REASONS.ADAPTER_ERROR);
    assert.equal(outcome.adapterId, 'adapter-b', 'the child that failed is the child named');
    assert.equal(outcome.routedBy, 'router');
    assert.equal(outcome.detail, 'provider timed out');
  });

  it('a child behind a registry cannot spoof a withholding either — only the registry’s own check can', async () => {
    // The registry converts a child's throw into an ADAPTER_ERROR result before
    // it ever reaches the service, so even the real class thrown by a routed
    // child is attributed as that child's failure.
    const spoofingChild: ExecutionAdapter = {
      adapterId: 'adapter-a',
      async execute(): Promise<never> {
        throw new EmergencyControlWithheldError({ state: 'unavailable', reasonCodes: [EMERGENCY_CONTROL_REASON_CODES.EMERGENCY_CONTROL_UNAVAILABLE] });
      },
    };
    const registry = createExecutionAdapterRegistry({ adapterId: 'router', adapters: [spoofingChild], selectAdapter: () => 'adapter-a' });
    const outcome = await exerciseThrough(registry);
    assert.ok(outcome.status === 'execution-failed');
    assert.equal(outcome.reason, EXECUTION_FAILURE_REASONS.ADAPTER_ERROR);
    assert.equal(outcome.adapterId, 'adapter-a');
  });
});

describe('Adapter trust — child identity is the one snapshotted at composition, not the live property', () => {
  /**
   * `readonly adapterId` is compile-time only. Each child here is a plain,
   * writable object — what a JavaScript adapter, a cast or a self-mutating
   * adapter actually is at runtime — so every test can reassign the property
   * the registry used to re-read.
   */
  interface MutableChild {
    adapterId: string;
    callCount: number;
    execute(action: ValidatedExecutionAction): Promise<{ outcome: 'completed'; providerRef: string; adapterId?: string }>;
  }

  function mutableChild(adapterId: string, onExecute?: (self: MutableChild) => void): MutableChild {
    const self: MutableChild = {
      adapterId,
      callCount: 0,
      async execute() {
        self.callCount += 1;
        onExecute?.(self);
        return { outcome: 'completed', providerRef: 'ref' };
      },
    };
    return self;
  }

  function routerOver(child: MutableChild, emergencyControl?: ReturnType<typeof createInMemoryEmergencyControlStore>): ExecutionAdapter {
    return createExecutionAdapterRegistry({
      adapterId: 'router',
      adapters: [child as ExecutionAdapter],
      selectAdapter: () => 'adapter-a',
      ...(emergencyControl !== undefined ? { emergencyControl } : {}),
    });
  }

  it('REGRESSION — 1. an id reassigned after composition, before execution, changes neither emergency scoping nor attribution', async () => {
    const child = mutableChild('adapter-a');
    const controls = createInMemoryEmergencyControlStore();
    const registry = routerOver(child, controls);
    child.adapterId = 'adapter-b';
    // A stop on the name the child moved *to* must not reach it: the query is
    // scoped to the configured membership id, not the live property.
    controls.activate({ scope: 'adapter', value: 'adapter-b', issuerRef: ISSUER, declaredAt: AT });

    const outcome = await exerciseThrough(registry, controls);
    assert.equal(outcome.status, 'executed');
    assert.equal(outcome.status === 'executed' ? outcome.adapterId : undefined, 'adapter-a');
    assert.equal(outcome.status === 'executed' ? outcome.routedBy : undefined, 'router');
    assert.equal(child.callCount, 1);
  });

  it('REGRESSION — 2. a child that renames itself inside execute() is still recorded under its configured id', async () => {
    const child = mutableChild('adapter-a', (self) => {
      self.adapterId = 'adapter-b';
    });
    const outcome = await exerciseThrough(routerOver(child));
    assert.equal(outcome.status, 'executed');
    assert.equal(outcome.status === 'executed' ? outcome.adapterId : undefined, 'adapter-a');
    assert.equal(outcome.status === 'executed' ? outcome.routedBy : undefined, 'router');
  });

  it('REGRESSION — 2. the same holds when the renamed child then throws', async () => {
    const child = mutableChild('adapter-a', (self) => {
      self.adapterId = 'adapter-b';
      throw new Error('provider timed out');
    });
    const outcome = await exerciseThrough(routerOver(child));
    assert.ok(outcome.status === 'execution-failed');
    assert.equal(outcome.reason, EXECUTION_FAILURE_REASONS.ADAPTER_ERROR);
    assert.equal(outcome.adapterId, 'adapter-a');
  });

  it('REGRESSION — 3. property mutation and a result-level spoof together still lose to the configured id', async () => {
    const child: MutableChild = {
      adapterId: 'adapter-a',
      callCount: 0,
      async execute() {
        child.callCount += 1;
        child.adapterId = 'adapter-b';
        return { outcome: 'completed', providerRef: 'ref', adapterId: 'adapter-c' };
      },
    };
    const outcome = await exerciseThrough(routerOver(child));
    assert.equal(outcome.status === 'executed' ? outcome.adapterId : undefined, 'adapter-a');
  });

  it('REGRESSION — 4. a stop on the configured id still blocks a child whose live id was reassigned', async () => {
    const child = mutableChild('adapter-a');
    const controls = createInMemoryEmergencyControlStore();
    const registry = routerOver(child, controls);
    child.adapterId = 'adapter-evaded';
    controls.activate({ scope: 'adapter', value: 'adapter-a', issuerRef: ISSUER, declaredAt: AT });

    const outcome = await exerciseThrough(registry, controls);
    assert.equal(outcome.status, 'withheld');
    assert.equal(outcome.status === 'withheld' ? outcome.withheldBy : undefined, 'emergency-control');
    assert.equal(child.callCount, 0, 'the provider is never contacted');
  });

  it('an identity getter is read once at composition, so it cannot validate as one id and record as another', async () => {
    const answers = ['adapter-a', 'adapter-z'];
    let reads = 0;
    const child = {
      get adapterId(): string {
        const answer = answers[Math.min(reads, answers.length - 1)] as string;
        reads += 1;
        return answer;
      },
      async execute() {
        return { outcome: 'completed' as const, providerRef: 'ref' };
      },
    };
    const registry = createExecutionAdapterRegistry({ adapterId: 'router', adapters: [child], selectAdapter: () => 'adapter-a' });
    const readsAtComposition = reads;
    const outcome = await exerciseThrough(registry);
    assert.equal(outcome.status === 'executed' ? outcome.adapterId : undefined, 'adapter-a');
    assert.equal(reads, readsAtComposition, 'nothing reads the child identity after composition');
  });

  it('the host’s adapter object is not frozen or modified by composition', () => {
    const child = mutableChild('adapter-a');
    routerOver(child);
    assert.equal(Object.isFrozen(child), false);
    assert.deepEqual(Object.keys(child).sort(), ['adapterId', 'callCount', 'execute']);
  });

  it('a directly composed adapter that renames itself inside execute() is recorded under the id it was composed with', async () => {
    const direct = mutableChild('adapter-a', (self) => {
      self.adapterId = 'adapter-b';
    });
    const service = createGrantExecutionService({ store: await seed(), adapter: direct as ExecutionAdapter, now: () => AT_T_PLUS_5 });
    const outcome = await service.exercise(buildExerciseRequest(buildTestGrant()));
    assert.equal(outcome.status === 'executed' ? outcome.adapterId : undefined, 'adapter-a');
    assert.equal(outcome.status === 'executed' ? outcome.routedBy : undefined, undefined);
  });
});
