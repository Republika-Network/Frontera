import { after, afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns';
import diagnosticsChannel from 'node:diagnostics_channel';

import { EMERGENCY_CONTROL_REASON_CODES, createEmergencyControlReader, createInMemoryEmergencyControlStore } from '../../features/emergency-control-runtime/index.js';
import {
  EXERCISE_CONTROL_REASON_CODES as X,
  createInMemoryExerciseControlLedger,
  exerciseReservationId,
  type ExerciseControlLedgerPort,
  type ExerciseControlPolicy,
} from '../../features/exercise-control-runtime/index.js';
import { GRANT_EXERCISE_REASON_CODES, createExecutionAdapterRegistry } from '../../features/execution-runtime/index.js';
import { createInMemoryBoundedGrantStore, type BoundedGrantStorePort } from '../../features/grant-runtime/index.js';
import { KernelGrantCapability } from '../../kernel/orchestration/grant-adapter.js';
import { mapGovernedActionResultToHttpStatus } from '../api/governed-action-contract.js';
import { createEnterprise, type AocEnterprise } from '../composition/composition-root.js';
import { loadEnterpriseConfiguration, type EnterpriseApiKey } from '../configuration/enterprise-configuration.js';
import { snapshotGenericHttpOptions } from '../execution-adapters/generic-http/configuration.js';
import { createGenericHttpExecutionAdapterCore } from '../execution-adapters/generic-http/generic-http-execution-adapter.js';
import type { GenericHttpNetworkRuntime } from '../execution-adapters/generic-http/node-https-transport.js';
import type { EnterpriseGenericHttpExecutionAdapterOptions } from '../execution-adapters/generic-http/index.js';
import type { GovernanceStore } from '../governance-store/governance-store.js';
import { createInMemoryGovernanceStore } from '../governance-store/in-memory-governance-store.js';
import { GOVERNED_ACTION_REASON_CODES as R, type GovernedActionResult } from '../governed-action/index.js';
import { executionOutcomeReferenceId } from '../governed-action/identifiers.js';
import { createInMemoryKernelAuthorityStore } from '../kernel-authority/in-memory-kernel-authority-store.js';
import type { KernelAuthorityStore } from '../kernel-authority/kernel-authority-store.js';
import { createKernelAuthorityProvisioningService } from '../kernel-authority/provisioning-service.js';
import { ALLOWED_INTENT, IDENTITY, NOW, NO_TEMPORAL_BOUND, ORG, PMFREAK_ACTOR_ID, TRUST_DOMAIN_ID, EVALUATED_AT_POLICY, buildGovernedWorld } from './governed-action-support.js';
import { buildTestKernelProviders } from './support.js';

/**
 * §12, §13, §37, §38, §49, §50 — P7 on the full governed-action path: the
 * public mapping (internal `exercise-control` → public `exercise`), the evidence
 * encoding and its replay, the Generic HTTP outcome interaction, and a caller
 * who tries to name any P7 structure.
 */

const ONE_PER_ACTOR: ExerciseControlPolicy = (query) => [{ limitId: 'actor-uses', scopeKey: `actor:${query.subject}`, metric: 'count', maximum: 1, window: { kind: 'lifetime' } }];

interface Counted {
  readonly ledger: ExerciseControlLedgerPort;
  readonly inner: ExerciseControlLedgerPort;
  readonly counts: { reserve: number; settle: number; release: number };
}

function counted(inner: ExerciseControlLedgerPort = createInMemoryExerciseControlLedger({ now: () => NOW }), faults: { readonly reserveThrows?: boolean } = {}): Counted {
  const counts = { reserve: 0, settle: 0, release: 0 };
  return {
    inner,
    counts,
    ledger: {
      async reserve(request) {
        counts.reserve += 1;
        if (faults.reserveThrows === true) throw new Error('ledger corrupt');
        return inner.reserve(request);
      },
      async settle(input) {
        counts.settle += 1;
        return inner.settle(input);
      },
      async release(input) {
        counts.release += 1;
        return inner.release(input);
      },
      read: (reservationId) => inner.read(reservationId),
    },
  };
}

function world(options: { readonly policy?: ExerciseControlPolicy; readonly ledger?: Counted; readonly binding?: () => typeof NO_TEMPORAL_BOUND | undefined } & Parameters<typeof buildGovernedWorld>[0] = {}) {
  const ledger = options.ledger ?? counted();
  const governed = buildGovernedWorld({
    ...options,
    exerciseControls: {
      policy: options.policy ?? ONE_PER_ACTOR,
      revalidateAuthorityBinding: options.binding ?? (() => NO_TEMPORAL_BOUND),
      reservationLedger: ledger.ledger,
    },
  });
  return { governed, ledger };
}

async function outcomeRow(store: GovernanceStore, result: GovernedActionResult): Promise<string | undefined> {
  const record = await store.getByRequestId({ system: false, organizationId: ORG }, result.requestId ?? '');
  assert.ok(record !== null);
  return record.references.find((reference) => reference.referenceType === 'execution_record' && reference.externalVersion !== 'attempt')?.externalVersion;
}

async function reservationStateFor(store: GovernanceStore, ledger: ExerciseControlLedgerPort, result: GovernedActionResult) {
  const record = await store.getByRequestId({ system: false, organizationId: ORG }, result.requestId ?? '');
  const grantId = record?.references.find((reference) => reference.referenceType === 'authorization_artifact')?.externalId;
  assert.ok(grantId !== undefined && result.executionId !== undefined);
  return (await ledger.read(exerciseReservationId({ boundedGrantId: grantId, executionId: result.executionId })))?.state;
}

const intent = (key: string) => ({ ...ALLOWED_INTENT, idempotencyKey: key });

describe('P7 governed action — §49 public mapping and evidence', () => {
  it('aggregate limit exceeded → withheld / exercise / EXERCISE_CONTROL_LIMIT_EXCEEDED, the existing withheld HTTP status, no adapter', async () => {
    const { governed } = world();
    assert.equal((await governed.orchestrator.govern(IDENTITY, intent('first'))).status, 'executed');
    const second = await governed.orchestrator.govern(IDENTITY, intent('second'));
    assert.equal(second.status, 'withheld');
    assert.equal(second.status === 'withheld' ? second.withheldBy : undefined, 'exercise', 'the public withheldBy union is unchanged');
    assert.deepEqual([...second.reasonCodes], [X.EXERCISE_CONTROL_LIMIT_EXCEEDED]);
    assert.equal(mapGovernedActionResultToHttpStatus(second), 409);
    assert.equal(governed.adapter.callCount, 1);
    assert.equal(await outcomeRow(governed.store, second), `withheld:exercise-control:${X.EXERCISE_CONTROL_LIMIT_EXCEEDED}`, 'recorded under its own layer');
  });

  it('§37. no reservation, limit, bucket, quota or digest reaches the customer result', async () => {
    const { governed } = world();
    const results = [await governed.orchestrator.govern(IDENTITY, intent('leak-1')), await governed.orchestrator.govern(IDENTITY, intent('leak-2'))];
    for (const result of results) {
      const serialized = JSON.stringify(result);
      for (const forbidden of ['reservation', 'limitId', 'scopeKey', 'actor-uses', 'policyDigest', 'authorityBindingDigest', 'remaining', 'quota', 'budget', 'aoc.exercise-reservation']) {
        assert.equal(serialized.includes(forbidden), false, `${forbidden} in ${serialized}`);
      }
    }
  });

  it('authority binding changed → withheld / exercise, no adapter', async () => {
    const { governed } = world({ binding: () => ({ kind: 'no-temporal-authority-bound', sourceKind: 'standing-capability', justification: 'changed' }) });
    const result = await governed.orchestrator.govern(IDENTITY, intent('changed'));
    assert.equal(result.status === 'withheld' ? result.withheldBy : undefined, 'exercise');
    assert.deepEqual([...result.reasonCodes], [X.EXERCISE_CONTROL_AUTHORITY_BINDING_CHANGED]);
    assert.equal(governed.adapter.callCount, 0);
  });

  it('ledger unavailable or corrupt → withheld / exercise / LEDGER_UNAVAILABLE, no adapter', async () => {
    const { governed } = world({ ledger: counted(undefined, { reserveThrows: true }) });
    const result = await governed.orchestrator.govern(IDENTITY, intent('ledger-down'));
    assert.equal(result.status === 'withheld' ? result.withheldBy : undefined, 'exercise');
    assert.deepEqual([...result.reasonCodes], [X.EXERCISE_CONTROL_LEDGER_UNAVAILABLE]);
    assert.equal(governed.adapter.callCount, 0);
  });

  it('§38. replay of an executed action reserves nothing and calls no adapter', async () => {
    const { governed, ledger } = world();
    const first = await governed.orchestrator.govern(IDENTITY, intent('replay'));
    assert.equal(first.status, 'executed');
    const counts = { ...ledger.counts };
    const replay = await governed.orchestrator.govern(IDENTITY, intent('replay'));
    assert.equal(replay.status, 'executed');
    assert.equal(replay.status === 'executed' ? replay.replayed : undefined, true);
    assert.deepEqual(ledger.counts, counts, 'no new reservation, settlement or release');
    assert.equal(governed.adapter.callCount, 1);
  });

  it('§13. replay of an exercise-control withholding reports withheld / exercise with the recorded codes, and reserves nothing', async () => {
    const { governed, ledger } = world();
    await governed.orchestrator.govern(IDENTITY, intent('fill'));
    const withheld = await governed.orchestrator.govern(IDENTITY, intent('withheld-replay'));
    assert.deepEqual([...withheld.reasonCodes], [X.EXERCISE_CONTROL_LIMIT_EXCEEDED]);
    const reserves = ledger.counts.reserve;
    const replay = await governed.orchestrator.govern(IDENTITY, intent('withheld-replay'));
    assert.equal(replay.status === 'withheld' ? replay.withheldBy : undefined, 'exercise');
    assert.deepEqual([...replay.reasonCodes], [X.EXERCISE_CONTROL_LIMIT_EXCEEDED]);
    assert.equal(ledger.counts.reserve, reserves);
    assert.equal(governed.adapter.callCount, 1);
  });

  it('§48.5. historical replay is unaffected by the current emergency state', async () => {
    const controls = createInMemoryEmergencyControlStore();
    const { governed, ledger } = world({ emergencyControl: createEmergencyControlReader(controls) });
    const first = await governed.orchestrator.govern(IDENTITY, intent('history'));
    assert.equal(first.status, 'executed');
    controls.activate({ scope: 'global', issuerRef: 'operator:on-call', declaredAt: '2026-01-01T00:00:00.000Z' });
    const counts = { ...ledger.counts };
    const replay = await governed.orchestrator.govern(IDENTITY, intent('history'));
    assert.equal(replay.status, 'executed', 'a stop today does not rewrite what happened yesterday');
    assert.deepEqual(ledger.counts, counts);
    const fresh = await governed.orchestrator.govern(IDENTITY, intent('history-new'));
    assert.equal(fresh.status === 'withheld' ? fresh.withheldBy : undefined, 'emergency-control');
    assert.deepEqual([...fresh.reasonCodes], [EMERGENCY_CONTROL_REASON_CODES.EMERGENCY_CONTROL_ACTIVE]);
  });
});

describe('P7 governed action — §13 evidence rows stay closed per layer', () => {
  async function replayOf(row: string, key: string) {
    const governed = buildGovernedWorld({
      beforeExercise: async () => {
        throw new Error('the exercise port is unreachable');
      },
    });
    const unconfirmed = await governed.orchestrator.govern(IDENTITY, intent(key));
    assert.equal(unconfirmed.status, 'execution_unconfirmed');
    const record = await governed.store.getByRequestId({ system: false, organizationId: ORG }, unconfirmed.requestId ?? '');
    assert.ok(record !== null && unconfirmed.executionId !== undefined);
    await governed.rawStore.appendReference({ system: false, organizationId: ORG }, {
      referenceId: executionOutcomeReferenceId(unconfirmed.executionId),
      evaluationId: record.evaluation.evaluationId,
      referenceType: 'execution_record',
      externalId: unconfirmed.executionId,
      externalVersion: row,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const replay = await governed.orchestrator.govern(IDENTITY, intent(key));
    assert.equal(governed.adapter.callCount, 0);
    return replay;
  }

  it('a canonical exercise-control row replays as withheld / exercise with exactly its codes', async () => {
    const replay = await replayOf(`withheld:exercise-control:${X.EXERCISE_CONTROL_AUTHORITY_BINDING_CHANGED},${X.EXERCISE_CONTROL_LIMIT_EXCEEDED}`, 'row-canonical');
    assert.equal(replay.status === 'withheld' ? replay.withheldBy : undefined, 'exercise');
    assert.deepEqual([...replay.reasonCodes], [X.EXERCISE_CONTROL_AUTHORITY_BINDING_CHANGED, X.EXERCISE_CONTROL_LIMIT_EXCEEDED]);
  });

  for (const forged of [
    `withheld:exercise-control:${GRANT_EXERCISE_REASON_CODES.GRANT_EXERCISE_REVOKED}`,
    `withheld:exercise-control:${EMERGENCY_CONTROL_REASON_CODES.EMERGENCY_CONTROL_ACTIVE}`,
    `withheld:grant-exercise:${X.EXERCISE_CONTROL_LIMIT_EXCEEDED}`,
    `withheld:emergency-control:${X.EXERCISE_CONTROL_LIMIT_EXCEEDED}`,
    `withheld:${X.EXERCISE_CONTROL_LIMIT_EXCEEDED}`,
    `withheld:exercise-control:${X.EXERCISE_CONTROL_LIMIT_EXCEEDED},${X.EXERCISE_CONTROL_LIMIT_EXCEEDED}`,
    'withheld:exercise-control:',
  ]) {
    it(`'${forged}' decodes as nothing — replayed as unconfirmed, never as a withholding`, async () => {
      const replay = await replayOf(forged, `row-${forged.length}-${forged.slice(-12)}`);
      assert.equal(replay.status, 'execution_unconfirmed');
    });
  }

  it('historical grant-exercise and emergency-control rows still replay as they always did', async () => {
    const unlayered = await replayOf(`withheld:${GRANT_EXERCISE_REASON_CODES.GRANT_EXERCISE_REVOKED}`, 'row-p3');
    assert.equal(unlayered.status === 'withheld' ? unlayered.withheldBy : undefined, 'exercise');
    const emergency = await replayOf(`withheld:emergency-control:${EMERGENCY_CONTROL_REASON_CODES.EMERGENCY_CONTROL_ACTIVE}`, 'row-p4');
    assert.equal(emergency.status === 'withheld' ? emergency.withheldBy : undefined, 'emergency-control');
    const unconfirmed = await replayOf('execution-unconfirmed@test.fake-provider', 'row-p6');
    assert.deepEqual([...unconfirmed.reasonCodes], [R.GOVERNED_ACTION_EXECUTION_OUTCOME_UNCONFIRMED]);
  });
});

describe('P7 governed action — §29 / §49 Generic HTTP outcomes against the reservation', () => {
  const GENERIC_ID = 'erp.invoice-payment';

  function genericOptions(): EnterpriseGenericHttpExecutionAdapterOptions {
    return {
      adapterId: GENERIC_ID,
      origin: 'https://api.erp.example',
      method: 'POST',
      path: [{ kind: 'literal', value: 'v1' }, { kind: 'literal', value: 'actions' }],
      headers: { 'Idempotency-Key': { kind: 'source', source: 'correlation.executionId' } },
      body: { kind: 'json-object', fields: { action: { kind: 'source', source: 'action' } } },
      credential: { kind: 'bearer', token: 'P7GenericHttpBearerSentinel' },
      timeoutMs: 1000,
    } as EnterpriseGenericHttpExecutionAdapterOptions;
  }

  function generic(status: number) {
    const sent: unknown[] = [];
    const runtime: GenericHttpNetworkRuntime = {
      async resolve() {
        return { kind: 'resolved', answers: [{ address: '93.184.216.34', family: 4 }] };
      },
      async send(request) {
        sent.push(request);
        return { kind: 'response', status, providerRefValues: [] };
      },
    };
    const child = createGenericHttpExecutionAdapterCore(snapshotGenericHttpOptions(genericOptions()), runtime);
    const registry = createExecutionAdapterRegistry({ adapterId: 'router', adapters: [child], selectAdapter: () => GENERIC_ID });
    const { governed, ledger } = world({ executionAdapter: registry });
    return { governed, ledger, sent };
  }

  for (const [status, publicStatus, state] of [
    [201, 'executed', 'settled'],
    [200, 'executed', 'settled'],
    [202, 'execution_unconfirmed', 'settled'],
    [302, 'execution_unconfirmed', 'settled'],
    [408, 'execution_unconfirmed', 'settled'],
    [500, 'execution_unconfirmed', 'settled'],
    [404, 'execution_failed', 'released'],
    [422, 'execution_failed', 'released'],
  ] as const) {
    it(`HTTP ${status} → ${publicStatus}; exactly one reservation, one outbound request, reservation ${state}`, async () => {
      const { governed, ledger, sent } = generic(status);
      const result = await governed.orchestrator.govern(IDENTITY, intent(`http-${status}`));
      assert.equal(result.status, publicStatus, JSON.stringify(result));
      assert.equal(sent.length, 1);
      assert.equal(ledger.counts.reserve, 1);
      assert.equal(await reservationStateFor(governed.store, ledger.inner, result), state);
      // Consumed or not: the next distinct action is admitted only when the
      // first reservation was released.
      const next = await governed.orchestrator.govern(IDENTITY, intent(`http-${status}-next`));
      if (state === 'released') assert.equal(next.status, publicStatus);
      else assert.deepEqual([...next.reasonCodes], [X.EXERCISE_CONTROL_LIMIT_EXCEEDED]);
      assert.equal(sent.length, state === 'released' ? 2 : 1);
    });
  }

  it('a 500 replay never contacts the provider again and never reserves again', async () => {
    const { governed, ledger, sent } = generic(500);
    await governed.orchestrator.govern(IDENTITY, intent('http-500-replay'));
    const reserves = ledger.counts.reserve;
    const replay = await governed.orchestrator.govern(IDENTITY, intent('http-500-replay'));
    assert.equal(replay.status, 'execution_unconfirmed');
    assert.equal(sent.length, 1);
    assert.equal(ledger.counts.reserve, reserves);
  });
});

describe('P7 governed action — §6 / §50 a caller cannot name, suggest or influence any P7 structure', () => {
  const SUBJECT = { system: 'datasys-app', subjectId: 'user-pmfreak' } as const;
  const SECRET = 'AOC_P7_CALLER_QUOTA_API_KEY_SENTINEL';
  const KEYS: readonly EnterpriseApiKey[] = [{ key: SECRET, organizationId: ORG, customerIdentity: { principalId: 'principal-pmfreak', externalSubject: SUBJECT } }];
  const network = { lookups: 0, sockets: 0 };
  const onSocket = (): void => {
    network.sockets += 1;
  };
  const realLookup = dns.promises.lookup;
  const enterprises: AocEnterprise[] = [];
  const authorityStores: KernelAuthorityStore[] = [];
  const counts = { appendEvaluation: 0, issue: 0, policy: 0, resolver: 0 };

  beforeEach(() => {
    diagnosticsChannel.subscribe('net.client.socket', onSocket);
    (dns.promises as { lookup: unknown }).lookup = async () => {
      network.lookups += 1;
      return [{ address: '10.0.0.1', family: 4 }];
    };
  });
  afterEach(() => {
    diagnosticsChannel.unsubscribe('net.client.socket', onSocket);
    (dns.promises as { lookup: unknown }).lookup = realLookup;
  });
  after(async () => {
    await Promise.all(enterprises.map((enterprise) => enterprise.close().catch(() => {})));
    await Promise.all(authorityStores.map((store) => store.close().catch(() => {})));
  });

  async function host() {
    const authority = createInMemoryKernelAuthorityStore();
    authorityStores.push(authority);
    await createKernelAuthorityProvisioningService({ store: authority, organizationId: ORG }).provisionActor(
      { system: true, actorId: 'operator-1' },
      { actorId: PMFREAK_ACTOR_ID, type: 'agent', displayName: 'PMFreak', externalSubject: SUBJECT },
    );
    const raw = createInMemoryGovernanceStore();
    const persistence = new Proxy(raw, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver) as unknown;
        if (typeof value !== 'function') return value;
        if (property === 'appendEvaluation') counts.appendEvaluation += 1;
        return (value as (...args: unknown[]) => unknown).bind(target);
      },
    });
    const grants = createInMemoryBoundedGrantStore();
    const grantStore: BoundedGrantStorePort = { issue: (input) => ((counts.issue += 1), grants.issue(input)), read: (id) => grants.read(id), revoke: (input) => grants.revoke(input) };
    const ledger = counted();
    const enterprise = await createEnterprise({
      configuration: { ...loadEnterpriseConfiguration({ AOC_ENTERPRISE_PERSISTENCE_PROVIDER: 'memory', AOC_ENTERPRISE_KERNEL_AUTHORITY_ORGANIZATION_ID: ORG }), authentication: { apiKeys: KEYS } },
      kernelProviders: buildTestKernelProviders(),
      kernelAuthorityStore: authority,
      persistence,
      customerIdentityAdmission: { enabled: true },
      authorityControlledExecution: {
        grantCapability: new KernelGrantCapability({ declaration: {} }),
        grantStore,
        executionAdapterRouting: { adapters: [], genericHttpAdapters: [{ ...genericHttp() }], selectAdapter: () => 'erp.p7' },
        resolveAuthorityBinding: () => NO_TEMPORAL_BOUND,
        exerciseControls: {
          policy: (query) => ((counts.policy += 1), ONE_PER_ACTOR(query)),
          revalidateAuthorityBinding: () => ((counts.resolver += 1), NO_TEMPORAL_BOUND),
          ledger: ledger.ledger,
        },
      },
      governedActionOrchestrator: { enabled: true, trustDomainId: TRUST_DOMAIN_ID, grantPolicy: EVALUATED_AT_POLICY },
    });
    enterprises.push(enterprise);
    return { enterprise, ledger };
  }

  function genericHttp(): EnterpriseGenericHttpExecutionAdapterOptions {
    return {
      adapterId: 'erp.p7',
      origin: 'https://api.erp.example',
      method: 'POST',
      path: [{ kind: 'literal', value: 'v1' }],
      body: { kind: 'json-object', fields: { action: { kind: 'source', source: 'action' } } },
      credential: { kind: 'bearer', token: 'P7CallerQuotaBearerSentinel' },
      timeoutMs: 1000,
    } as EnterpriseGenericHttpExecutionAdapterOptions;
  }

  const TOP_LEVEL: readonly (readonly [string, unknown])[] = [
    ['limit', 5],
    ['limits', [{ limitId: 'x', maximum: 1e9 }]],
    ['limitId', 'caller-limit'],
    ['scopeKey', 'caller-scope'],
    ['quota', 1e9],
    ['budget', { amount: 1e9, currency: 'USD' }],
    ['velocity', { perMinute: 1e6 }],
    ['window', { kind: 'lifetime' }],
    ['windowSeconds', 1],
    ['maximum', 1e9],
    ['maxCount', 1e9],
    ['maxAmount', '1000000000'],
    ['reservation', { state: 'released' }],
    ['reservationId', 'aoc.exercise-reservation:caller'],
    ['exerciseControls', { policy: 'none' }],
    ['aggregateControls', { enabled: false }],
    ['authorityBindingDigest', `sha256:${'a'.repeat(64)}`],
  ];

  for (const [field, value] of TOP_LEVEL) {
    it(`'${field}' at the top level → rejected before the Kernel, grant issuance, the P7 policy, the ledger, the adapter, DNS or a socket`, async () => {
      const { enterprise, ledger } = await host();
      const before = { ...counts, ...network };
      const response = await enterprise.governAction?.({ ...intent(`caller-${field}`), [field]: value }, { authorizationHeader: `Bearer ${SECRET}` });
      assert.ok(response !== undefined);
      assert.equal(response.body.status, 'rejected');
      assert.deepEqual([...response.body.reasonCodes], [R.GOVERNED_ACTION_INTENT_INVALID]);
      assert.equal(response.httpStatus, 400);
      assert.deepEqual({ ...counts, ...network }, before, 'no Kernel commit, no grant issuance, no policy, no resolver, no DNS, no socket');
      assert.deepEqual(ledger.counts, { reserve: 0, settle: 0, release: 0 });
    });
  }

  for (const [field, value] of TOP_LEVEL) {
    it(`'${field}' inside assertedContext → rejected as a reserved key, with nothing evaluated`, async () => {
      const { enterprise, ledger } = await host();
      const before = { ...counts, ...network };
      const response = await enterprise.governAction?.({ ...intent(`ctx-${field}`), assertedContext: { ...ALLOWED_INTENT.assertedContext, [field]: value } }, { authorizationHeader: `Bearer ${SECRET}` });
      assert.equal(response?.body.status, 'rejected');
      assert.deepEqual({ ...counts, ...network }, before);
      assert.deepEqual(ledger.counts, { reserve: 0, settle: 0, release: 0 });
    });
  }

  it('an ordinary intent on the same host reaches the policy and the ledger — so the zero counts above are not vacuous', async () => {
    const { enterprise, ledger } = await host();
    const before = { ...counts };
    const response = await enterprise.governAction?.(intent('ordinary'), { authorizationHeader: `Bearer ${SECRET}` });
    assert.ok(response !== undefined);
    assert.equal(counts.appendEvaluation, before.appendEvaluation + 1);
    assert.equal(counts.policy, before.policy + 1);
    assert.equal(ledger.counts.reserve, 1);
    // The Generic HTTP child is stopped by its own public-address policy (the
    // stand-in resolver answers a private address), so the reservation is
    // released and the outcome is a definite pre-send failure.
    assert.equal(response.body.status, 'execution_failed', JSON.stringify(response.body));
    assert.equal(network.lookups, 1);
    assert.equal(network.sockets, 0);
    assert.equal(ledger.counts.release, 1);
  });
});
