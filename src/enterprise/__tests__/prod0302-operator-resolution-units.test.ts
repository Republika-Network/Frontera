import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';

import { EMERGENCY_CONTROL_REASON_CODE_VALUES } from '../../features/emergency-control-runtime/index.js';
import { EXECUTION_FAILURE_REASON_VALUES } from '../../features/execution-runtime/index.js';
import { RESOLUTION_FAILURE_REASONS } from '../../control-plane-web/wire.js';
import { EnterpriseHttpError } from '../api/enterprise-http-errors.js';
import type { AuthorityTrace } from '../evidence/trace-contracts.js';
import { discloseAuthorityTrace, getDisclosurePolicyV2 } from '../evidence/trace-disclosure.js';
import { createExecutionActivityGuard } from '../execution-reconciliation/activity-guard.js';
import type { OperatorResolutionRequest, OperatorResolutionResult } from '../execution-reconciliation/contracts.js';
import { OPERATOR_ATTESTATION_AUTHORITY_ID, createOperatorAttestationAuthority, selectOperatorAttestation } from '../execution-reconciliation/operator-attestation.js';
import { snapshotResolutionAuthorities } from '../execution-reconciliation/authority.js';
import { createExecutionReconciliationService } from '../execution-reconciliation/service.js';
import { createInMemoryExecutionOutcomeStore } from '../execution-outcome-store/in-memory-execution-outcome-store.js';
import { EXECUTION_RESOLUTION_STORE_SCHEMA_VERSION, type RecordExecutionResolutionInput } from '../execution-resolution-store/contracts.js';
import { createInMemoryExecutionResolutionStore } from '../execution-resolution-store/in-memory-execution-resolution-store.js';
import { buildExecutionResolutionRecord, resolutionFact } from '../execution-resolution-store/integrity.js';
import { createSqliteExecutionResolutionStore } from '../execution-resolution-store/sqlite-execution-resolution-store.js';
import { computeDigest } from '../governance-store/digest.js';
import { decodeDefinitiveExecutionSummary, encodeResolutionSummary } from '../governed-action/execution-summary.js';
import { discloseOperationalView, operationalViewOf } from '../operations/classification.js';
import { createOperatorResolutionLog, OPERATOR_RESOLUTION_LOG_EVENTS } from '../operations/governed-path-log.js';
import { createOperatorResolutionCommand } from '../operations/resolution.js';
import { operatorMay, OPERATOR_ROLES, LEGACY_ADMINISTRATOR_ROLE } from '../operator-control/roles.js';
import type { EnterpriseOperatorPrincipal, OperatorAuthenticator } from '../operator-control/operator-authenticator.js';

/**
 * PROD-03-02 — focused units: the canonical vocabulary and its symmetry, the
 * attested P12 record (and its compatibility with every record before it),
 * the activity guard, the operator attestation's eligibility, conflict,
 * idempotency, race and crash behaviour over real P11 / P12 stores, the
 * resolution command's closed contract, logging and disclosure.
 */

const ORG = 'org-prod0302';
const T0 = '2026-10-07T10:00:00.000Z';
const OPERATOR = 'operator:ops-admin';
const OTHER_OPERATOR = 'operator:ops-other';
const clock = (): (() => string) => {
  let tick = 0;
  return () => new Date(Date.parse(T0) + 1000 * tick++).toISOString();
};
const digestOf = (seed: string): string => computeDigest({ seed });

// -- the canonical vocabulary -------------------------------------------------------------

describe('PROD-03-02 — writer / decoder symmetry of the resolution summary', () => {
  it('every form the product can write decodes to exactly what was written', () => {
    const writable: [('confirmed-completed' | 'confirmed-not-completed'), string | undefined][] = [
      ['confirmed-completed', undefined],
      ...EXECUTION_FAILURE_REASON_VALUES.map((failure) => ['confirmed-not-completed', failure] as ['confirmed-not-completed', string]),
    ];
    for (const [certainty, failure] of writable) {
      const encoded = encodeResolutionSummary(certainty, failure);
      assert.ok(encoded !== undefined, `${certainty}/${String(failure)} is writable`);
      assert.deepEqual(decodeDefinitiveExecutionSummary(encoded), { kind: 'resolved', certainty, ...(failure !== undefined ? { failure } : {}) });
    }
  });

  it('nothing outside the closed vocabulary is written, and the decoder is not loosened', () => {
    assert.equal(encodeResolutionSummary('confirmed-completed', 'PROVIDER_REJECTED'), undefined);
    assert.equal(encodeResolutionSummary('confirmed-not-completed', undefined), undefined);
    assert.equal(encodeResolutionSummary('confirmed-not-completed', 'BANK_SAID_NO'), undefined);
    assert.equal(encodeResolutionSummary('confirmed' as never, undefined), undefined);
    for (const malformed of ['resolved:', 'resolved:confirmed-not-completed', 'resolved:confirmed-not-completed:', 'resolved:confirmed-not-completed:BANK', 'resolved:confirmed-completed:PROVIDER_REJECTED', 'resolved:operator']) {
      assert.equal(decodeDefinitiveExecutionSummary(malformed), undefined, malformed);
    }
  });

  it('the console offers exactly the runtime’s failure vocabulary', () => {
    assert.deepEqual([...RESOLUTION_FAILURE_REASONS].sort(), [...EXECUTION_FAILURE_REASON_VALUES].sort());
  });
});

// -- the attested P12 record --------------------------------------------------------------

function resolutionInput(overrides: Partial<RecordExecutionResolutionInput> & { readonly bindingDigest: string; readonly attemptDigest: string }): RecordExecutionResolutionInput {
  return {
    organizationId: ORG,
    executionId: 'aoc.exec:unit',
    authorityId: OPERATOR_ATTESTATION_AUTHORITY_ID,
    certainty: 'confirmed-completed',
    resolvedAt: T0,
    ...overrides,
  } as RecordExecutionResolutionInput;
}

describe('PROD-03-02 — the attested P12 resolution record', () => {
  for (const provider of ['memory', 'sqlite'] as const) {
    it(`${provider}: an attested resolution round-trips, verifies, and conflicts with any other operator's identical answer`, async () => {
      const now = clock();
      const store = provider === 'memory' ? createInMemoryExecutionResolutionStore({ now }) : await createSqliteExecutionResolutionStore(join(mkdtempSync(join(tmpdir(), 'prod0302-p12-')), 'r.sqlite'), { now });
      try {
        const attemptDigest = digestOf('attempt');
        const bound = await store.bind({ organizationId: ORG }, { organizationId: ORG, executionId: 'aoc.exec:unit', attemptDigest, authorityId: OPERATOR_ATTESTATION_AUTHORITY_ID, origin: 'pre-claim', boundAt: T0 });
        const input = resolutionInput({ attemptDigest, bindingDigest: bound.binding.bindingDigest, attestedBy: OPERATOR });
        const recorded = await store.recordResolution({ organizationId: ORG }, input);
        assert.equal(recorded.outcome, 'recorded');
        assert.equal(recorded.resolution.attestedBy, OPERATOR);
        assert.equal((await store.read({ organizationId: ORG }, 'aoc.exec:unit'))?.resolution?.attestedBy, OPERATOR, 'read back exactly');
        // The identical attestation (any instant) is the same fact.
        assert.equal((await store.recordResolution({ organizationId: ORG }, { ...input, resolvedAt: '2026-10-07T11:00:00.000Z' })).outcome, 'existing');
        // The same answer from another operator is not this operator's attestation.
        await assert.rejects(store.recordResolution({ organizationId: ORG }, { ...input, attestedBy: OTHER_OPERATOR }), /EXECUTION_RESOLUTION_CONFLICT|already has a different/);
        await assert.rejects(store.recordResolution({ organizationId: ORG }, { ...input, certainty: 'confirmed-not-completed', failure: 'PROVIDER_REJECTED' } as RecordExecutionResolutionInput), /different definitive resolution/);
        // Never an arbitrary identity.
        for (const attestedBy of ['ops-admin', 'operator:', 'operator:bad id', 'customer:agent', 'operator:' + 'x'.repeat(200)]) {
          const other = await store.bind({ organizationId: ORG }, { organizationId: ORG, executionId: `aoc.exec:unit-${attestedBy.length}`, attemptDigest, authorityId: OPERATOR_ATTESTATION_AUTHORITY_ID, origin: 'pre-claim', boundAt: T0 });
          await assert.rejects(
            store.recordResolution({ organizationId: ORG }, resolutionInput({ executionId: `aoc.exec:unit-${attestedBy.length}`, attemptDigest, bindingDigest: other.binding.bindingDigest, attestedBy })),
            /attestedBy is not an operator reference/,
            attestedBy,
          );
        }
      } finally {
        await store.close();
      }
    });
  }

  it('an unattested resolution’s fact and digest are exactly what they were before PROD-03-02', () => {
    const input = resolutionInput({ attemptDigest: digestOf('a'), bindingDigest: digestOf('b'), providerRef: 'job-1' });
    assert.equal('attestedBy' in resolutionFact(input), false);
    const record = buildExecutionResolutionRecord(input, T0);
    // The pre-PROD-03-02 formula, restated: no attestedBy key at all.
    const legacy = computeDigest({
      domain: 'aoc.execution-resolution.resolution.v1',
      schemaVersion: EXECUTION_RESOLUTION_STORE_SCHEMA_VERSION,
      organizationId: input.organizationId,
      executionId: input.executionId,
      attemptDigest: input.attemptDigest,
      bindingDigest: input.bindingDigest,
      authorityId: input.authorityId,
      certainty: input.certainty,
      providerRef: 'job-1',
      resolvedAt: input.resolvedAt,
      basisObservationDigest: null,
      failure: null,
      recordedAt: T0,
    });
    assert.equal(record.resolutionDigest, legacy);
    assert.notEqual(buildExecutionResolutionRecord({ ...input, attestedBy: OPERATOR }, T0).resolutionDigest, legacy, 'the attestation is committed by the digest');
  });

  it('a SQLite file created before the attested_by column gains it on open; its rows read and verify unchanged', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'prod0302-legacy-')), 'legacy.sqlite');
    const db = new Database(path);
    db.exec(`
      CREATE TABLE execution_resolution_store_versions (id INTEGER PRIMARY KEY AUTOINCREMENT, schema_version TEXT NOT NULL, migration_state TEXT NOT NULL, recorded_at TEXT NOT NULL);
      CREATE TABLE execution_resolution_bindings (execution_id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, attempt_digest TEXT NOT NULL, authority_id TEXT NOT NULL, origin TEXT NOT NULL, bound_at TEXT NOT NULL, recorded_at TEXT NOT NULL, schema_version TEXT NOT NULL, binding_digest TEXT NOT NULL);
      CREATE TABLE execution_resolutions (execution_id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, attempt_digest TEXT NOT NULL, binding_digest TEXT NOT NULL, basis_observation_digest TEXT, authority_id TEXT NOT NULL, certainty TEXT NOT NULL, failure TEXT, provider_ref TEXT, resolved_at TEXT NOT NULL, recorded_at TEXT NOT NULL, schema_version TEXT NOT NULL, resolution_digest TEXT NOT NULL);
    `);
    db.prepare(`INSERT INTO execution_resolution_store_versions (schema_version, migration_state, recorded_at) VALUES (?, 'current', ?)`).run(EXECUTION_RESOLUTION_STORE_SCHEMA_VERSION, T0);
    db.close();
    // Written through a store that predates nothing but the column: bind and resolve with a host authority.
    const now = clock();
    let store = await createSqliteExecutionResolutionStore(path, { now });
    const attemptDigest = digestOf('legacy');
    const bound = await store.bind({ organizationId: ORG }, { organizationId: ORG, executionId: 'aoc.exec:legacy', attemptDigest, authorityId: 'resolver-legacy', origin: 'pre-claim', boundAt: T0 });
    const recorded = await store.recordResolution({ organizationId: ORG }, resolutionInput({ executionId: 'aoc.exec:legacy', authorityId: 'resolver-legacy', attemptDigest, bindingDigest: bound.binding.bindingDigest, certainty: 'confirmed-not-completed', failure: 'PROVIDER_UNAVAILABLE' } as never));
    await store.close();
    const columns = new Database(path, { readonly: true });
    assert.ok((columns.prepare(`PRAGMA table_info(execution_resolutions)`).all() as { name: string }[]).some((column) => column.name === 'attested_by'));
    columns.close();
    store = await createSqliteExecutionResolutionStore(path, { now });
    try {
      const read = await store.read({ organizationId: ORG }, 'aoc.exec:legacy');
      assert.equal(read?.resolution?.resolutionDigest, recorded.resolution.resolutionDigest);
      assert.equal(read?.resolution?.attestedBy, undefined);
    } finally {
      await store.close();
    }
  });
});

// -- the activity guard -------------------------------------------------------------------

describe('PROD-03-02 — the per-execution activity guard', () => {
  it('a live governed path refuses an attestation; an attestation makes a governed path wait, then lets it through', async () => {
    const guard = createExecutionActivityGuard();
    const leave = await guard.enter('aoc.exec:g');
    assert.equal(guard.isActive('aoc.exec:g'), true);
    assert.equal(guard.tryExclusive('aoc.exec:g'), undefined, 'refused while live');
    leave();
    leave();
    assert.equal(guard.isActive('aoc.exec:g'), false);
    const release = guard.tryExclusive('aoc.exec:g');
    assert.ok(release !== undefined);
    assert.equal(guard.tryExclusive('aoc.exec:g'), undefined, 'one attestation at a time');
    const order: string[] = [] as string[];
    const entering = guard.enter('aoc.exec:g').then((leaveAgain) => {
      order.push('entered');
      return leaveAgain;
    });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    assert.equal(order.length, 0, 'the governed path waits');
    (order as string[]).push('released');
    release();
    (await entering)();
    assert.deepEqual(order, ['released', 'entered']);
    assert.ok(guard.tryExclusive('aoc.exec:g') !== undefined, 'nothing left held');
    assert.ok(guard.tryExclusive('aoc.exec:other') !== undefined, 'executions are independent');
  });
});

// -- operator attestation over real P11 / P12 stores --------------------------------------

interface Rig {
  readonly service: ReturnType<typeof createExecutionReconciliationService>;
  readonly outcomes: ReturnType<typeof createInMemoryExecutionOutcomeStore>;
  readonly resolutions: ReturnType<typeof createInMemoryExecutionResolutionStore>;
  readonly guard: ReturnType<typeof createExecutionActivityGuard>;
  readonly claimed: Set<string>;
  readonly evidence: { executionId: string; certainty: string }[];
  readonly capacity: string[];
  prepare(executionId: string, organizationId?: string): Promise<string>;
}

async function rig(options: { readonly authorities?: readonly { readonly authorityId: string; resolve(query: never): Promise<unknown> }[]; readonly guard?: boolean } = {}): Promise<Rig> {
  const now = clock();
  const outcomes = createInMemoryExecutionOutcomeStore({ now });
  const resolutions = createInMemoryExecutionResolutionStore({ now });
  const guard = createExecutionActivityGuard();
  const claimed = new Set<string>();
  const evidence: { executionId: string; certainty: string }[] = [];
  const capacity: string[] = [];
  const authorities = options.authorities ?? [createOperatorAttestationAuthority()];
  const composition = snapshotResolutionAuthorities(authorities, selectOperatorAttestation, 'test');
  const service = createExecutionReconciliationService({
    outcomes,
    resolutions,
    composition,
    claimed: async (_scope, _evaluationId, executionId) => claimed.has(executionId),
    capacity: {
      reconcileResolution: async (input) => {
        capacity.push(input.resolution);
        return { outcome: 'not-found' } as never;
      },
    },
    governanceEvidence: async (_scope, _evaluationId, executionId, resolution) => {
      evidence.push({ executionId, certainty: resolution.certainty });
    },
    ...(options.guard === false ? {} : { activity: guard }),
    now,
  });
  return {
    service,
    outcomes,
    resolutions,
    guard,
    claimed,
    evidence,
    capacity,
    async prepare(executionId, organizationId = ORG) {
      const prepared = await outcomes.prepareAttempt({ organizationId }, {
        organizationId,
        executionId,
        evaluationId: `eval-${executionId.slice(9)}`,
        requestId: `aoc.gar:${executionId.slice(9)}`,
        decisionId: `decision-${executionId.slice(9)}`,
        boundedGrantId: `grant-${executionId.slice(9)}`,
        action: 'restart-service',
        preparedAt: T0,
      });
      return prepared.attempt.attemptDigest;
    },
  };
}

const attest = (executionId: string, overrides: Partial<OperatorResolutionRequest> = {}): OperatorResolutionRequest =>
  ({ organizationId: ORG, executionId, attestedBy: OPERATOR, observedOutcome: 'none', certainty: 'confirmed-completed', ...overrides }) as OperatorResolutionRequest;

describe('PROD-03-02 — operator attestation: eligibility', () => {
  it('no attempt, another organization’s attempt, never claimed, a definitive outcome and a withholding are never resolved; nothing is written', async () => {
    const r = await rig();
    assert.deepEqual(await r.service.recordOperatorResolution(attest('aoc.exec:none')), { outcome: 'not-found' });

    await r.prepare('aoc.exec:foreign', 'org-other');
    r.claimed.add('aoc.exec:foreign');
    assert.deepEqual(await r.service.recordOperatorResolution(attest('aoc.exec:foreign')), { outcome: 'not-found' }, 'another organization’s execution is indistinguishable from none');

    await r.prepare('aoc.exec:unclaimed');
    assert.deepEqual(await r.service.recordOperatorResolution(attest('aoc.exec:unclaimed')), { outcome: 'not-eligible', reason: 'not-claimed' });

    for (const [executionId, observation, reason] of [
      ['aoc.exec:completed', { kind: 'provider', certainty: 'confirmed-completed', adapterId: 'a', observedAt: T0 }, 'initial-observation-definitive'],
      ['aoc.exec:failed', { kind: 'provider', certainty: 'confirmed-not-completed', adapterId: 'a', failure: 'PROVIDER_REJECTED', observedAt: T0 }, 'initial-observation-definitive'],
      ['aoc.exec:withheld', { kind: 'withheld', withheldBy: 'emergency-control', reasonCodes: [EMERGENCY_CONTROL_REASON_CODE_VALUES[0]], observedAt: T0 }, 'withheld'],
    ] as const) {
      await r.prepare(executionId);
      r.claimed.add(executionId);
      await r.outcomes.recordTerminal({ organizationId: ORG }, { organizationId: ORG, executionId, observation: observation as never });
      assert.deepEqual(await r.service.recordOperatorResolution(attest(executionId)), { outcome: 'not-eligible', reason }, executionId);
      assert.equal(await r.resolutions.read({ organizationId: ORG }, executionId), undefined, `${executionId}: nothing bound, nothing resolved`);
    }
    assert.deepEqual(r.evidence, []);
    assert.deepEqual(r.capacity, []);
  });

  it('the basis the operator reviewed must be the current one', async () => {
    const r = await rig();
    await r.prepare('aoc.exec:unconfirmed');
    r.claimed.add('aoc.exec:unconfirmed');
    await r.outcomes.recordTerminal({ organizationId: ORG }, { organizationId: ORG, executionId: 'aoc.exec:unconfirmed', observation: { kind: 'provider', certainty: 'unconfirmed', adapterId: 'a', observedAt: T0 } });
    assert.deepEqual(await r.service.recordOperatorResolution(attest('aoc.exec:unconfirmed')), { outcome: 'basis-changed', current: 'unconfirmed' });
    const recorded = await r.service.recordOperatorResolution(attest('aoc.exec:unconfirmed', { observedOutcome: 'unconfirmed' }));
    assert.equal(recorded.outcome, 'recorded');
    assert.ok(recorded.outcome === 'recorded' && recorded.resolution.basisObservationDigest !== undefined, 'the resolution names the observation it resolved');
  });

  it('an execution bound to another authority is that authority’s; an unbound one is adopted — bound, never declared — then attested', async () => {
    const r = await rig({ authorities: [createOperatorAttestationAuthority(), { authorityId: 'resolver-provider', resolve: async () => ({ outcome: 'unresolved' }) }] });
    const attemptDigest = await r.prepare('aoc.exec:theirs');
    r.claimed.add('aoc.exec:theirs');
    await r.resolutions.bind({ organizationId: ORG }, { organizationId: ORG, executionId: 'aoc.exec:theirs', attemptDigest, authorityId: 'resolver-provider', origin: 'pre-claim', boundAt: T0 });
    assert.deepEqual(await r.service.recordOperatorResolution(attest('aoc.exec:theirs')), { outcome: 'authority-mismatch' });
    assert.equal((await r.resolutions.read({ organizationId: ORG }, 'aoc.exec:theirs'))?.resolution, undefined);

    await r.prepare('aoc.exec:legacy');
    r.claimed.add('aoc.exec:legacy');
    const recorded = await r.service.recordOperatorResolution(attest('aoc.exec:legacy'));
    assert.equal(recorded.outcome, 'recorded');
    const state = await r.resolutions.read({ organizationId: ORG }, 'aoc.exec:legacy');
    assert.equal(state?.binding?.origin, 'adopted');
    assert.equal(state?.binding?.authorityId, OPERATOR_ATTESTATION_AUTHORITY_ID);
    assert.equal(state?.resolution?.attestedBy, OPERATOR);
  });

  it('a deployment that does not compose attestation never records one', async () => {
    const r = await rig({ authorities: [{ authorityId: 'resolver-provider', resolve: async () => ({ outcome: 'unresolved' }) }] });
    await r.prepare('aoc.exec:x');
    r.claimed.add('aoc.exec:x');
    assert.deepEqual(await r.service.recordOperatorResolution(attest('aoc.exec:x')), { outcome: 'authority-mismatch' });
  });

  it('invalid attestations are refused before anything is read', async () => {
    const r = await rig();
    await r.prepare('aoc.exec:x');
    r.claimed.add('aoc.exec:x');
    for (const bad of [
      { attestedBy: 'ops-admin' },
      { certainty: 'confirmed-not-completed' },
      { certainty: 'confirmed-not-completed', failure: 'BANK_SAID_NO' },
      { certainty: 'maybe' },
      { observedOutcome: 'confirmed-completed' },
    ]) {
      assert.deepEqual(await r.service.recordOperatorResolution(attest('aoc.exec:x', bad as never)), { outcome: 'resolution-unrecorded' }, JSON.stringify(bad));
    }
    assert.equal(await r.resolutions.read({ organizationId: ORG }, 'aoc.exec:x'), undefined);
  });

  it('operator attestation never answers on its own: an explicit reconcile writes and releases nothing', async () => {
    const r = await rig();
    await r.prepare('aoc.exec:asked');
    r.claimed.add('aoc.exec:asked');
    await r.resolutions.bind({ organizationId: ORG }, { organizationId: ORG, executionId: 'aoc.exec:asked', attemptDigest: (await r.outcomes.read({ organizationId: ORG }, 'aoc.exec:asked'))?.attempt.attemptDigest ?? '', authorityId: OPERATOR_ATTESTATION_AUTHORITY_ID, origin: 'pre-claim', boundAt: T0 });
    assert.deepEqual(await r.service.reconcile({ organizationId: ORG, executionId: 'aoc.exec:asked' }), { outcome: 'unresolved' });
    assert.equal((await r.resolutions.read({ organizationId: ORG }, 'aoc.exec:asked'))?.resolution, undefined);
    assert.deepEqual(r.capacity, []);
  });
});

describe('PROD-03-02 — operator attestation: idempotency, conflict, races and crashes', () => {
  it('recorded, then replayed (identical: same operator, answer and basis), then refused for anything else — one durable resolution', async () => {
    const r = await rig();
    await r.prepare('aoc.exec:one');
    r.claimed.add('aoc.exec:one');
    const first = await r.service.recordOperatorResolution(attest('aoc.exec:one'));
    assert.equal(first.outcome, 'recorded');
    const replay = await r.service.recordOperatorResolution(attest('aoc.exec:one'));
    assert.equal(replay.outcome, 'replayed');
    assert.ok(first.outcome === 'recorded' && replay.outcome === 'replayed' && replay.resolution.resolutionDigest === first.resolution.resolutionDigest);
    for (const conflicting of [{ attestedBy: OTHER_OPERATOR }, { certainty: 'confirmed-not-completed', failure: 'PROVIDER_REJECTED' }]) {
      const result = await r.service.recordOperatorResolution(attest('aoc.exec:one', conflicting as never));
      assert.equal(result.outcome, 'already-resolved', JSON.stringify(conflicting));
      assert.ok(result.outcome === 'already-resolved' && first.outcome === 'recorded' && result.resolution.resolutionDigest === first.resolution.resolutionDigest, 'the first stands, unchanged');
    }
    assert.deepEqual(r.evidence.map((entry) => entry.certainty), ['confirmed-completed', 'confirmed-completed'], 'the replay completed the evidence again, idempotently; the conflicts wrote nothing');
  });

  it('two operators at once: exactly one resolution; the other is refused, never a second, contradictory one', async () => {
    const r = await rig();
    await r.prepare('aoc.exec:two');
    r.claimed.add('aoc.exec:two');
    const [a, b] = await Promise.all([
      r.service.recordOperatorResolution(attest('aoc.exec:two')),
      r.service.recordOperatorResolution(attest('aoc.exec:two', { attestedBy: OTHER_OPERATOR, certainty: 'confirmed-not-completed', failure: 'PROVIDER_UNAVAILABLE' } as never)),
    ]);
    const outcomes = [a.outcome, b.outcome].sort();
    assert.deepEqual(outcomes, ['in-flight', 'recorded'], JSON.stringify([a, b]));
    const loser = a.outcome === 'recorded' ? attest('aoc.exec:two', { attestedBy: OTHER_OPERATOR, certainty: 'confirmed-not-completed', failure: 'PROVIDER_UNAVAILABLE' } as never) : attest('aoc.exec:two');
    assert.equal((await r.service.recordOperatorResolution(loser)).outcome, 'already-resolved', 'retried, the loser loses deterministically');
  });

  it('the provider outcome wins: an attestation is refused while the governed path holds the execution, and finds the outcome after', async () => {
    const r = await rig();
    await r.prepare('aoc.exec:race');
    r.claimed.add('aoc.exec:race');
    const leave = await r.guard.enter('aoc.exec:race');
    assert.deepEqual(await r.service.recordOperatorResolution(attest('aoc.exec:race')), { outcome: 'in-flight' });
    await r.outcomes.recordTerminal({ organizationId: ORG }, { organizationId: ORG, executionId: 'aoc.exec:race', observation: { kind: 'provider', certainty: 'confirmed-completed', adapterId: 'a', observedAt: T0 } });
    leave();
    assert.deepEqual(await r.service.recordOperatorResolution(attest('aoc.exec:race')), { outcome: 'not-eligible', reason: 'initial-observation-definitive' });
    assert.equal(await r.resolutions.read({ organizationId: ORG }, 'aoc.exec:race'), undefined, 'no contradictory evidence');
  });

  it('a governed path that arrives while an attestation is being recorded waits for it, then sees it — it can never record an observation in between', async () => {
    const r = await rig();
    await r.prepare('aoc.exec:between');
    r.claimed.add('aoc.exec:between');
    const order: string[] = [];
    // Inject the governed path exactly between the attestation's eligibility read and its commit.
    const read = r.outcomes.read.bind(r.outcomes);
    let entered: Promise<() => void> | undefined;
    (r.outcomes as { read: typeof read }).read = async (context, executionId) => {
      const result = await read(context, executionId);
      entered ??= r.guard.enter(executionId).then((leave) => {
        order.push('governed path entered');
        return leave;
      });
      return result;
    };
    const result = await r.service.recordOperatorResolution(attest('aoc.exec:between'));
    order.push('attestation returned');
    assert.equal(result.outcome, 'recorded');
    const leave = await (entered as Promise<() => void>);
    assert.deepEqual(order, ['attestation returned', 'governed path entered']);
    // Had the governed path held the execution first, the attestation would have been refused; here it only waited.
    leave();
  });

  it('without the guard, attestation is refused: ordering against a live provider call cannot be shown', async () => {
    const r = await rig({ guard: false });
    await r.prepare('aoc.exec:unguarded');
    r.claimed.add('aoc.exec:unguarded');
    assert.deepEqual(await r.service.recordOperatorResolution(attest('aoc.exec:unguarded')), { outcome: 'in-flight' });
  });

  it('crash before the append writes nothing (a retry records it); crash after the append is completed by the identical retry, never duplicated', async () => {
    const r = await rig();
    await r.prepare('aoc.exec:crash');
    r.claimed.add('aoc.exec:crash');
    const record = r.resolutions.recordResolution.bind(r.resolutions);
    (r.resolutions as { recordResolution: typeof record }).recordResolution = async () => {
      throw new Error('disk gone');
    };
    assert.deepEqual(await r.service.recordOperatorResolution(attest('aoc.exec:crash')), { outcome: 'resolution-unrecorded' });
    assert.equal((await r.resolutions.read({ organizationId: ORG }, 'aoc.exec:crash'))?.resolution, undefined, 'no half-resolution');
    assert.deepEqual(r.evidence, []);
    (r.resolutions as { recordResolution: typeof record }).recordResolution = record;

    // After the append, before any evidence: the durable resolution exists alone (the HTTP response, too, may be lost).
    const attempt = (await r.outcomes.read({ organizationId: ORG }, 'aoc.exec:crash'))?.attempt;
    const binding = (await r.resolutions.read({ organizationId: ORG }, 'aoc.exec:crash'))?.binding;
    assert.ok(attempt !== undefined && binding !== undefined, 'the failed attempt left only its adopted binding: it binds, it never declares');
    await record({ organizationId: ORG }, { organizationId: ORG, executionId: 'aoc.exec:crash', attemptDigest: attempt.attemptDigest, bindingDigest: binding.bindingDigest, authorityId: OPERATOR_ATTESTATION_AUTHORITY_ID, certainty: 'confirmed-completed', attestedBy: OPERATOR, resolvedAt: T0 });
    const retried = await r.service.recordOperatorResolution(attest('aoc.exec:crash'));
    assert.equal(retried.outcome, 'replayed');
    assert.deepEqual(r.evidence, [{ executionId: 'aoc.exec:crash', certainty: 'confirmed-completed' }], 'the retry completed the evidence the crash left undone');
  });
});

// -- the resolution command (operator plane) ----------------------------------------------

function authenticatorFor(permissionHolder: boolean, seen: string[] = []): OperatorAuthenticator {
  return {
    organizationId: ORG,
    authorize(header, permission): EnterpriseOperatorPrincipal {
      seen.push(permission);
      if (header !== 'Bearer admin') throw new EnterpriseHttpError(401, 'AUTHENTICATION_FAILED', 'no');
      if (!permissionHolder) throw new EnterpriseHttpError(403, 'OPERATOR_PERMISSION_DENIED', 'no');
      return { plane: 'operator', operatorId: 'ops-admin', organizationId: ORG, role: 'organization-administrator', credentialClass: 'operator', actorRef: OPERATOR };
    },
  };
}

const EXECUTION = `aoc.exec:${'ab'.repeat(16)}`;
const okResult = (request: OperatorResolutionRequest): OperatorResolutionResult => ({
  outcome: 'recorded',
  requestId: 'aoc.gar:1',
  evaluationId: 'eval-1',
  capacity: 'no-reservation',
  resolution: {
    ...(request as unknown as RecordExecutionResolutionInput),
    attemptDigest: digestOf('a'),
    bindingDigest: digestOf('b'),
    authorityId: OPERATOR_ATTESTATION_AUTHORITY_ID,
    resolvedAt: T0,
    schemaVersion: EXECUTION_RESOLUTION_STORE_SCHEMA_VERSION,
    recordedAt: T0,
    resolutionDigest: digestOf('r'),
  } as never,
});

describe('PROD-03-02 — the resolution command: authorization, closed body, closed results', () => {
  it('authorizes operations.resolve before the body is read; a refused caller’s body is never read', async () => {
    let bodyReads = 0;
    const seen: string[] = [];
    const command = createOperatorResolutionCommand({ authenticator: authenticatorFor(false, seen), organizationId: ORG, record: async () => assert.fail('never recorded') });
    await assert.rejects(
      command.resolveExecution('Bearer admin', EXECUTION, async () => {
        bodyReads += 1;
        return {};
      }),
      (error: unknown) => error instanceof EnterpriseHttpError && error.httpStatus === 403,
    );
    assert.deepEqual(seen, ['operations.resolve']);
    assert.equal(bodyReads, 0);
  });

  it('the operator and organization are the server’s; the body is closed; the identity sent to P12 is the principal’s', async () => {
    const sent: OperatorResolutionRequest[] = [];
    const command = createOperatorResolutionCommand({
      authenticator: authenticatorFor(true),
      organizationId: ORG,
      record: async (request) => {
        sent.push(request);
        return okResult(request);
      },
    });
    const ok = await command.resolveExecution('Bearer admin', EXECUTION, async () => ({ resolution: 'confirmed-completed', observedOutcome: 'none' }));
    assert.equal(ok.outcome, 'recorded');
    assert.equal(ok.effect, 'resolution-recorded-no-action-performed');
    assert.deepEqual(sent, [{ organizationId: ORG, executionId: EXECUTION, attestedBy: OPERATOR, certainty: 'confirmed-completed', observedOutcome: 'none' }]);
    for (const body of [
      { resolution: 'confirmed-completed', observedOutcome: 'none', attestedBy: 'operator:mallory' },
      { resolution: 'confirmed-completed', observedOutcome: 'none', organizationId: 'org-other' },
      { resolution: 'confirmed-completed', observedOutcome: 'none', resolvedAt: T0 },
      { resolution: 'confirmed-completed', observedOutcome: 'none', note: 'free text' },
      { resolution: 'confirmed-completed', observedOutcome: 'none', failure: 'PROVIDER_REJECTED' },
      { resolution: 'confirmed-not-completed', observedOutcome: 'none' },
      { resolution: 'confirmed-not-completed', observedOutcome: 'none', failure: 'NEW_REASON' },
      { resolution: 'executed', observedOutcome: 'none' },
      { resolution: 'confirmed-completed', observedOutcome: 'executed' },
      { resolution: 'confirmed-completed' },
      null,
      [],
      'confirmed-completed',
    ]) {
      await assert.rejects(command.resolveExecution('Bearer admin', EXECUTION, async () => body), (error: unknown) => error instanceof EnterpriseHttpError && error.httpStatus === 400, JSON.stringify(body));
    }
    for (const executionId of ['aoc.gar:' + 'ab'.repeat(16), 'aoc.exec:short', `aoc.exec:${'AB'.repeat(16)}`, '../../x', '']) {
      await assert.rejects(command.resolveExecution('Bearer admin', executionId, async () => ({ resolution: 'confirmed-completed', observedOutcome: 'none' })), (error: unknown) => error instanceof EnterpriseHttpError && error.httpStatus === 400, executionId);
    }
    assert.equal(sent.length, 1, 'no refused command reached P12');
  });

  it('every closed result maps to one closed, safe answer — and none of them claims an action was performed', async () => {
    const expected: [OperatorResolutionResult, number, string][] = [
      [{ outcome: 'not-found' }, 404, 'EXECUTION_NOT_FOUND'],
      [{ outcome: 'not-eligible', reason: 'not-claimed' }, 409, 'EXECUTION_NOT_RESOLVABLE'],
      [{ outcome: 'not-eligible', reason: 'withheld' }, 409, 'EXECUTION_NOT_RESOLVABLE'],
      [{ outcome: 'not-eligible', reason: 'initial-observation-definitive' }, 409, 'EXECUTION_OUTCOME_ALREADY_DEFINITIVE'],
      [{ outcome: 'in-flight' }, 409, 'EXECUTION_IN_FLIGHT'],
      [{ outcome: 'basis-changed', current: 'unconfirmed' }, 409, 'EXECUTION_RESOLUTION_BASIS_CHANGED'],
      [{ outcome: 'authority-mismatch' }, 409, 'EXECUTION_RESOLUTION_AUTHORITY_MISMATCH'],
      [{ outcome: 'already-resolved', resolution: (okResult(attest(EXECUTION)) as unknown as { readonly resolution: never }).resolution }, 409, 'EXECUTION_ALREADY_RESOLVED'],
      [{ outcome: 'basis-unavailable', reason: 'outcome-corrupt' }, 500, 'AUTHORITY_STATE_INTEGRITY_FAILED'],
      [{ outcome: 'basis-unavailable', reason: 'outcome-unreadable' }, 503, 'EXECUTION_RESOLUTION_UNAVAILABLE'],
      [{ outcome: 'resolution-unrecorded' }, 503, 'EXECUTION_RESOLUTION_UNAVAILABLE'],
    ];
    for (const [result, status, code] of expected) {
      const command = createOperatorResolutionCommand({ authenticator: authenticatorFor(true), organizationId: ORG, record: async () => result });
      await assert.rejects(
        command.resolveExecution('Bearer admin', EXECUTION, async () => ({ resolution: 'confirmed-completed', observedOutcome: 'none' })),
        (error: unknown) => {
          assert.ok(error instanceof EnterpriseHttpError);
          assert.equal(error.httpStatus, status, result.outcome);
          assert.equal(error.code, code, result.outcome);
          assert.doesNotMatch(error.message, /SQLITE|stack|Error:/);
          return true;
        },
      );
    }
    // A throw from the port is never stated as "nothing was recorded": it is unknown, and a resubmission is safe.
    const throwing = createOperatorResolutionCommand({ authenticator: authenticatorFor(true), organizationId: ORG, record: async () => { throw new Error('SQLITE_BUSY at /data/x.sqlite'); } });
    await assert.rejects(throwing.resolveExecution('Bearer admin', EXECUTION, async () => ({ resolution: 'confirmed-completed', observedOutcome: 'none' })), (error: unknown) => {
      assert.ok(error instanceof EnterpriseHttpError);
      assert.equal(error.httpStatus, 503);
      assert.doesNotMatch(error.message, /SQLITE|\/data\//);
      assert.match(error.message, /recorded at most once/);
      return true;
    });
  });

  it('logs closed fields only, through a guarded logger', async () => {
    const lines: { level: string; message: string; fields: Record<string, unknown> }[] = [];
    const logger = {
      debug: () => {},
      info: (message: string, fields?: Record<string, unknown>) => lines.push({ level: 'info', message, fields: fields ?? {} }),
      warn: (message: string, fields?: Record<string, unknown>) => lines.push({ level: 'warn', message, fields: fields ?? {} }),
      error: () => {},
    };
    const command = createOperatorResolutionCommand({ authenticator: authenticatorFor(true), organizationId: ORG, record: async (request) => okResult(request), log: createOperatorResolutionLog(logger) });
    await command.resolveExecution('Bearer admin', EXECUTION, async () => ({ resolution: 'confirmed-not-completed', failure: 'PROVIDER_UNAVAILABLE', observedOutcome: 'none' }));
    assert.deepEqual(lines.map((line) => line.message), [OPERATOR_RESOLUTION_LOG_EVENTS.requested, OPERATOR_RESOLUTION_LOG_EVENTS.recorded]);
    assert.deepEqual(lines[0]?.fields, { executionId: EXECUTION, operatorId: 'ops-admin', certainty: 'confirmed-not-completed', reasonCodes: ['PROVIDER_UNAVAILABLE'] });
    const throwingLog = createOperatorResolutionCommand({
      authenticator: authenticatorFor(true),
      organizationId: ORG,
      record: async (request) => okResult(request),
      log: { requested: () => assert.fail('boom'), recorded: () => assert.fail('boom'), rejected: () => assert.fail('boom') },
    });
    assert.equal((await throwingLog.resolveExecution('Bearer admin', EXECUTION, async () => ({ resolution: 'confirmed-completed', observedOutcome: 'none' }))).outcome, 'recorded', 'a logger never changes a result');
  });
});

// -- authorization and disclosure ---------------------------------------------------------

describe('PROD-03-02 — operations.resolve is held by organization-administrator only', () => {
  it('no other role — not responder, observer, approver, provisioner or steward — and not the CTRL-01 class', () => {
    const holders = [...OPERATOR_ROLES, LEGACY_ADMINISTRATOR_ROLE].filter((role) => operatorMay(role, 'operations.resolve'));
    assert.deepEqual(holders, ['organization-administrator']);
  });
});

function resolvedTrace(attestedBy: string | undefined, authorityId: string, bindingAuthority: string = authorityId): AuthorityTrace {
  const resolved = { authorityId, certainty: 'confirmed-completed', ...(attestedBy !== undefined ? { attestedBy } : {}), resolvedAt: T0, resolutionDigest: digestOf('r') };
  return {
    traceVersion: 'aoc.authority-trace.v1',
    requestId: 'aoc.gar:t',
    organizationId: ORG,
    evaluationId: 'eval-t',
    decisionId: 'decision-t',
    executionId: 'aoc.exec:t',
    path: 'allowed',
    finalState: 'resolved-confirmed-completed',
    stages: {
      request: { presence: 'recorded', actorId: 'agent', actionType: 'restart-service', resourceScope: 'env:staging', requestedAt: T0, receivedAt: T0, payloadDigest: digestOf('p') },
      decision: { presence: 'recorded', status: 'allowed', reasonCodes: [], evaluatedAt: T0 },
      approval: { presence: 'not-applicable', records: [] },
      obligations: { presence: 'not-applicable', discharges: [] },
      authority: { presence: 'recorded', grants: [{ grantId: 'g', issuedAt: T0 }] },
      execution: { presence: 'recorded', claim: { presence: 'recorded', claimedAt: T0 } },
      parameters: { presence: 'not-applicable' },
      reservation: { presence: 'not-applicable' },
      outcome: { presence: 'unresolved' },
      resolution: { presence: 'recorded', binding: { authorityId: bindingAuthority, origin: 'pre-claim', boundAt: T0, bindingDigest: digestOf('b') }, resolution: resolved },
      events: { presence: 'not-composed', events: [] },
    },
  } as unknown as AuthorityTrace;
}

const SUMMARY = { requestId: 'aoc.gar:t', evaluationId: 'eval-t', decisionId: 'decision-t', actorId: 'agent', actionType: 'restart-service', status: 'allowed', reasonCodes: [], evaluatedAt: T0, persistedAt: T0 };

describe('PROD-03-02 — the view names an operator resolution as one, and discloses it by level', () => {
  it('operator attestation vs a resolution authority; resolvable only where attestation is composed and nothing is resolved', () => {
    const operator = operationalViewOf(resolvedTrace(OPERATOR, OPERATOR_ATTESTATION_AUTHORITY_ID), SUMMARY, { attestation: true });
    assert.equal(operator.classification, 'executed-succeeded');
    assert.deepEqual(operator.resolution, { resolvedBy: 'operator-attestation', attestedBy: OPERATOR, certainty: 'confirmed-completed', failure: null, resolvedAt: T0 });
    assert.equal(operator.resolvable, false, 'already resolved');
    const provider = operationalViewOf(resolvedTrace(undefined, 'resolver-provider'), SUMMARY, { attestation: true });
    assert.equal(provider.resolution?.resolvedBy, 'resolution-authority');
    assert.equal(provider.resolution?.attestedBy, null);

    const open = resolvedTrace(undefined, OPERATOR_ATTESTATION_AUTHORITY_ID);
    const claimedOnly = { ...open, finalState: 'claimed-outcome-unrecorded', stages: { ...open.stages, resolution: { presence: 'unresolved', binding: open.stages.resolution.binding } } } as unknown as AuthorityTrace;
    assert.equal(operationalViewOf(claimedOnly, SUMMARY, { attestation: true }).resolvable, true);
    assert.equal(operationalViewOf(claimedOnly, SUMMARY).resolvable, false, 'not composed: never resolvable');
    const theirs = { ...claimedOnly, stages: { ...claimedOnly.stages, resolution: { presence: 'unresolved', binding: { ...open.stages.resolution.binding, authorityId: 'resolver-provider' } } } } as unknown as AuthorityTrace;
    assert.equal(operationalViewOf(theirs, SUMMARY, { attestation: true }).resolvable, false, 'bound to another authority');
  });

  it('AUDITOR states who; PARTNER the mechanism but not the person; CUSTOMER the answer only; PUBLIC nothing of it', () => {
    const trace = resolvedTrace(OPERATOR, OPERATOR_ATTESTATION_AUTHORITY_ID);
    const view = operationalViewOf(trace, SUMMARY, { attestation: true });
    const at = (level: 'AUDITOR' | 'PARTNER' | 'CUSTOMER' | 'PUBLIC') => {
      const disclosed = discloseAuthorityTrace(trace, getDisclosurePolicyV2(level));
      return { disclosed, operational: discloseOperationalView(view, disclosed) };
    };
    assert.equal(at('AUDITOR').operational.resolution?.attestedBy, OPERATOR);
    assert.equal(JSON.stringify(at('AUDITOR').disclosed).includes(OPERATOR), true);
    for (const level of ['PARTNER', 'CUSTOMER', 'PUBLIC'] as const) {
      const { disclosed, operational } = at(level);
      assert.equal(JSON.stringify(disclosed).includes('ops-admin'), false, `${level}: the trace hides the person`);
      assert.equal(JSON.stringify(operational).includes('ops-admin'), false, `${level}: the sidecar hides the person`);
    }
    assert.equal(at('PARTNER').operational.resolution?.resolvedBy, 'operator-attestation');
    assert.equal(at('CUSTOMER').operational.resolution?.resolvedBy, null);
    assert.equal(at('CUSTOMER').operational.resolution?.certainty, 'confirmed-completed');
    assert.equal(JSON.stringify(at('CUSTOMER').disclosed).includes(OPERATOR_ATTESTATION_AUTHORITY_ID), false);
    assert.equal('resolution' in at('PUBLIC').operational, false);
    assert.equal('resolvable' in at('CUSTOMER').operational, false);
  });
});
