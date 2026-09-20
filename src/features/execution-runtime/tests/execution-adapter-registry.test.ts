import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createInMemoryEmergencyControlStore, EMERGENCY_CONTROL_REASON_CODES } from '../../emergency-control-runtime/index.js';
import { createInMemoryBoundedGrantStore, type BoundedGrantStorePort } from '../../grant-runtime/index.js';
import {
  EXECUTION_FAILURE_REASONS,
  createExecutionAdapterRegistry,
  createGrantExecutionService,
  isExecutionAdapterRegistryError,
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
