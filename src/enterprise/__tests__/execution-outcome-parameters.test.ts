import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';

import type { GovernedParameter } from '../../features/governed-parameter-runtime/index.js';
import {
  EXECUTION_OUTCOME_STORE_SCHEMA_VERSION_V1,
  EXECUTION_OUTCOME_STORE_SCHEMA_VERSION,
  type ExecutionAttemptRecord,
  type PrepareExecutionAttemptInput,
} from '../execution-outcome-store/contracts.js';
import { buildExecutionAttemptRecord, executionAttemptRecordFailure } from '../execution-outcome-store/integrity.js';
import { createInMemoryExecutionOutcomeStore, createSqliteExecutionOutcomeStore, isExecutionOutcomeStoreError, type ExecutionOutcomeStore } from '../execution-outcome-store/index.js';
import { computeDigest } from '../governance-store/digest.js';
import { createExecutionReconciliationService, createExecutionResolutionBinder, selectionContextOf } from '../execution-reconciliation/index.js';
import { snapshotResolutionAuthorities } from '../execution-reconciliation/authority.js';
import { createInMemoryExecutionResolutionStore } from '../execution-resolution-store/index.js';

/**
 * CORE-08 §14 – §18 / §57 / §72 — P11 binds the exact typed governed
 * parameters an adapter receives, without reinterpreting a single historical
 * record.
 *
 * The legacy half is measured against a **real** pre-CORE-08 store: the rows,
 * DDL and digests in `fixtures/pre-core-08/p11-v1-execution-outcome-store.json`
 * were written by the unmodified P11 runtime at `main @ 8d99567` (see the
 * fixture's `generatedBy`), not constructed here with fields omitted.
 */

const AT = '2026-09-30T12:00:00.000Z';
const ORG = 'org-core08';
const SCOPE = { organizationId: ORG };
const directories: string[] = [];
after(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

function freshDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'aoc-core08-p11-'));
  directories.push(directory);
  return directory;
}

function clock(start = AT): () => string {
  let tick = 0;
  return () => new Date(Date.parse(start) + (tick += 1)).toISOString();
}

const STRATEGY: GovernedParameter = { dimension: 'deploymentStrategy', type: 'token', value: 'rolling' };
const DRY_RUN: GovernedParameter = { dimension: 'dryRun', type: 'boolean', value: false };
const REPLICAS: GovernedParameter = { dimension: 'replicaCount', type: 'integer', value: 4 };
const PARAMETERS: readonly GovernedParameter[] = [STRATEGY, DRY_RUN, REPLICAS];

function input(overrides: Partial<PrepareExecutionAttemptInput> = {}): PrepareExecutionAttemptInput {
  return {
    organizationId: ORG,
    executionId: 'aoc.exec:core08-1',
    evaluationId: 'eval-core08-1',
    requestId: 'aoc.gar:core08-1',
    decisionId: 'dec-core08-1',
    boundedGrantId: 'grant-core08-1',
    action: 'deploy-release',
    parameters: PARAMETERS,
    preparedAt: AT,
    ...overrides,
  };
}

async function rejectsWith(promise: Promise<unknown>, code: string, message?: RegExp): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(isExecutionOutcomeStoreError(error), String(error));
    assert.equal(error.code, code, error.message);
    if (message !== undefined) assert.match(error.message, message);
    return true;
  });
}

function tamper(path: string, statements: readonly string[]): void {
  const db = new Database(path);
  try {
    for (const trigger of db.prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger'`).all() as { name: string }[]) db.exec(`DROP TRIGGER ${trigger.name}`);
    for (const statement of statements) db.exec(statement);
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------

describe('CORE-08 §16 — a new attempt binds the exact parameters: dimension, type and value', () => {
  for (const [name, open] of [
    ['SQLite', async () => createSqliteExecutionOutcomeStore(join(freshDir(), 'outcomes.sqlite'), { now: clock() })],
    ['in-memory', async () => createInMemoryExecutionOutcomeStore({ now: clock() })],
  ] as const) {
    it(`${name}: prepared under v2, read back exactly, frozen, verified`, async () => {
      const store: ExecutionOutcomeStore = await open();
      const prepared = await store.prepareAttempt(SCOPE, input());
      assert.equal(prepared.outcome, 'prepared');
      assert.equal(prepared.attempt.schemaVersion, EXECUTION_OUTCOME_STORE_SCHEMA_VERSION);
      assert.deepEqual(prepared.attempt.parameters, PARAMETERS);
      const read = await store.read(SCOPE, 'aoc.exec:core08-1');
      assert.deepEqual(read?.attempt, prepared.attempt);
      assert.equal(typeof read?.attempt.parameters?.[1]?.value, 'boolean');
      assert.equal(typeof read?.attempt.parameters?.[2]?.value, 'number');
      assert.ok(Object.isFrozen(read?.attempt.parameters));
      assert.equal(executionAttemptRecordFailure(prepared.attempt), undefined);
      await store.close();
    });

    it(`${name}: preparation is idempotent, and the same execution with any other parameter is a conflict`, async () => {
      const store: ExecutionOutcomeStore = await open();
      const first = await store.prepareAttempt(SCOPE, input());
      const again = await store.prepareAttempt(SCOPE, input({ preparedAt: '2026-09-30T12:05:00.000Z' }));
      assert.equal(again.outcome, 'existing');
      assert.deepEqual(again.attempt, first.attempt);
      for (const parameters of [
        [STRATEGY, DRY_RUN, { dimension: 'replicaCount', type: 'integer', value: 5 }],
        [{ dimension: 'deploymentStrategy', type: 'token', value: 'Rolling' }, DRY_RUN, REPLICAS],
        [STRATEGY, REPLICAS],
      ] as (readonly GovernedParameter[])[]) {
        await rejectsWith(store.prepareAttempt(SCOPE, input({ parameters })), 'EXECUTION_OUTCOME_CONFLICT');
      }
      const { parameters: _none, ...withoutParameters } = input();
      await rejectsWith(store.prepareAttempt(SCOPE, withoutParameters), 'EXECUTION_OUTCOME_CONFLICT');
      await store.close();
    });
  }

  it('the attempt digest commits to every dimension, type and value, and to their absence', () => {
    const base = buildExecutionAttemptRecord(input(), AT);
    const variants: readonly (readonly GovernedParameter[] | undefined)[] = [
      [STRATEGY, DRY_RUN, { dimension: 'replicaCount', type: 'integer', value: 3 }],
      [STRATEGY, { dimension: 'dryRun', type: 'boolean', value: true }, REPLICAS],
      [{ dimension: 'deploymentStrategy', type: 'token', value: 'blue-green' }, DRY_RUN, REPLICAS],
      [STRATEGY, DRY_RUN, { dimension: 'replicaCounts', type: 'integer', value: 4 }],
      [STRATEGY, DRY_RUN, { dimension: 'replicaCount', type: 'token', value: '4' }],
      [STRATEGY, DRY_RUN],
      undefined,
    ];
    const digests = new Set([base.attemptDigest]);
    for (const parameters of variants) {
      const { parameters: _drop, ...rest } = input();
      digests.add(buildExecutionAttemptRecord(parameters === undefined ? rest : { ...rest, parameters }, AT).attemptDigest);
    }
    assert.equal(digests.size, variants.length + 1, 'every change is a different digest');
    assert.equal(buildExecutionAttemptRecord(input(), AT).attemptDigest, base.attemptDigest, 'deterministic');
  });

  it('only the canonical form is accepted: unsorted, duplicated, coerced, extra-keyed or empty lists are refused, never repaired', async () => {
    const store = createInMemoryExecutionOutcomeStore({ now: clock() });
    for (const parameters of [
      [REPLICAS, STRATEGY, DRY_RUN],
      [STRATEGY, STRATEGY, REPLICAS],
      [STRATEGY, DRY_RUN, { dimension: 'replicaCount', type: 'integer', value: '4' }],
      [STRATEGY, DRY_RUN, { dimension: 'replicaCount', type: 'integer', value: 4, path: '/admin' }],
      [STRATEGY, { dimension: 'dryRun', type: 'boolean', value: 0 }],
      [],
    ]) {
      await rejectsWith(store.prepareAttempt(SCOPE, input({ parameters: parameters as never })), 'EXECUTION_OUTCOME_INPUT_INVALID');
    }
  });

  it('a tampered parameter value, type or dimension in a persisted v2 row is detected and refused, never repaired', async () => {
    for (const replacement of [
      '[{"dimension":"deploymentStrategy","type":"token","value":"rolling"},{"dimension":"dryRun","type":"boolean","value":false},{"dimension":"replicaCount","type":"integer","value":40}]',
      '[{"dimension":"deploymentStrategy","type":"token","value":"rolling"},{"dimension":"dryRun","type":"boolean","value":true},{"dimension":"replicaCount","type":"integer","value":4}]',
      '[{"dimension":"deploymentStrategy","type":"token","value":"rolling"},{"dimension":"replicaCount","type":"integer","value":4}]',
      'null',
      'not json',
    ]) {
      const path = join(freshDir(), 'outcomes.sqlite');
      const store = await createSqliteExecutionOutcomeStore(path, { now: clock() });
      await store.prepareAttempt(SCOPE, input());
      await store.close();
      tamper(path, [`UPDATE execution_attempts SET parameters_json = ${replacement === 'null' ? 'NULL' : `'${replacement}'`}`]);
      const reopened = await createSqliteExecutionOutcomeStore(path, { now: clock() });
      await rejectsWith(reopened.read(SCOPE, 'aoc.exec:core08-1'), 'EXECUTION_OUTCOME_CORRUPT');
      await reopened.close();
    }
  });
});

// ---------------------------------------------------------------------------

interface LegacyFixture {
  readonly generatedBy: string;
  readonly schema: readonly { readonly type: string; readonly name: string; readonly sql: string }[];
  readonly tables: Record<string, readonly Record<string, unknown>[]>;
}

const FIXTURE = JSON.parse(readFileSync('src/enterprise/__tests__/fixtures/pre-core-08/p11-v1-execution-outcome-store.json', 'utf8')) as LegacyFixture;

/** Materializes the historical v1 file byte-for-byte in its schema and rows, exactly as the pre-CORE-08 runtime wrote it. */
function legacyStore(): string {
  const path = join(freshDir(), 'legacy.sqlite');
  const db = new Database(path);
  try {
    for (const object of FIXTURE.schema) if (object.name !== 'sqlite_sequence') db.exec(object.sql);
    for (const [table, rows] of Object.entries(FIXTURE.tables)) {
      for (const row of rows) {
        const columns = Object.keys(row);
        db.prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map((column) => `@${column}`).join(', ')})`).run(row);
      }
    }
  } finally {
    db.close();
  }
  return path;
}

const LEGACY = { organizationId: 'org-legacy' };

describe('CORE-08 §15 / §57 — historical P11 v1 records are read exactly as they were written', () => {
  it('the fixture is a real pre-CORE-08 v1 store (not a reconstruction)', () => {
    assert.match(FIXTURE.generatedBy, /8d995676d250a7b7bc43fc32c0cb6f68e49fb021/);
    assert.equal(FIXTURE.tables['execution_outcome_store_versions']?.[0]?.['schema_version'], EXECUTION_OUTCOME_STORE_SCHEMA_VERSION_V1);
    const ddl = FIXTURE.schema.find((object) => object.name === 'execution_attempts')?.sql ?? '';
    assert.equal(ddl.includes('parameters_json'), false, 'the v1 table has no parameter column');
    assert.equal(FIXTURE.tables['execution_attempts']?.length, 2);
  });

  it('the v1 digest formula is unchanged: an independent recomputation matches every historical digest', () => {
    for (const row of FIXTURE.tables['execution_attempts'] ?? []) {
      const amount = row['amount_value'] === null ? null : { value: row['amount_value'], unit: row['amount_unit'] };
      const recomputed = computeDigest({
        domain: 'aoc.execution-outcome.attempt.v1',
        schemaVersion: row['schema_version'],
        organizationId: row['organization_id'],
        executionId: row['execution_id'],
        evaluationId: row['evaluation_id'],
        requestId: row['request_id'],
        decisionId: row['decision_id'],
        boundedGrantId: row['bounded_grant_id'],
        action: row['action'],
        amount,
        preparedAt: row['prepared_at'],
        recordedAt: row['recorded_at'],
      });
      assert.equal(recomputed, row['attempt_digest']);
    }
  });

  it('opening a v1 file migrates it additively: one column, one appended history row, no record rewritten', async () => {
    const path = legacyStore();
    const before = new Database(path, { readonly: true });
    const rowsBefore = before.prepare('SELECT * FROM execution_attempts ORDER BY rowid').all();
    before.close();
    const store = await createSqliteExecutionOutcomeStore(path, { now: clock() });
    await store.close();
    const db = new Database(path, { readonly: true });
    try {
      const history = db.prepare('SELECT schema_version, migration_state FROM execution_outcome_store_versions ORDER BY id').all();
      assert.deepEqual(history, [
        { schema_version: EXECUTION_OUTCOME_STORE_SCHEMA_VERSION_V1, migration_state: 'current' },
        { schema_version: EXECUTION_OUTCOME_STORE_SCHEMA_VERSION, migration_state: 'migrated' },
      ]);
      const rowsAfter = db.prepare('SELECT * FROM execution_attempts ORDER BY rowid').all() as Record<string, unknown>[];
      assert.deepEqual(
        rowsAfter.map(({ parameters_json: added, ...rest }) => {
          assert.equal(added, null, 'no parameter is invented for a historical attempt');
          return rest;
        }),
        rowsBefore,
      );
      // A v1-only runtime refuses any file whose newest version is not v1: the migrated file is closed to it.
      assert.equal((history.at(-1) as { schema_version: string }).schema_version, EXECUTION_OUTCOME_STORE_SCHEMA_VERSION);
    } finally {
      db.close();
    }
    // Reopening is idempotent: no second migration row.
    const again = await createSqliteExecutionOutcomeStore(path, { now: clock() });
    await again.close();
    const check = new Database(path, { readonly: true });
    assert.equal((check.prepare('SELECT COUNT(*) AS n FROM execution_outcome_store_versions').get() as { n: number }).n, 2);
    check.close();
  });

  it('legacy attempts and observations read back as v1, verified, with no parameters and their exact money', async () => {
    const store = await createSqliteExecutionOutcomeStore(legacyStore(), { now: clock() });
    const monetary = await store.read(LEGACY, 'exec-legacy-monetary');
    assert.ok(monetary !== undefined);
    assert.equal(monetary.attempt.schemaVersion, EXECUTION_OUTCOME_STORE_SCHEMA_VERSION_V1);
    assert.deepEqual(monetary.attempt.amount, { value: '125.5', unit: 'USD' });
    assert.equal(Object.prototype.hasOwnProperty.call(monetary.attempt, 'parameters'), false);
    assert.equal(monetary.attempt.attemptDigest, FIXTURE.tables['execution_attempts']?.[0]?.['attempt_digest']);
    assert.equal(monetary.terminal?.schemaVersion, EXECUTION_OUTCOME_STORE_SCHEMA_VERSION_V1);
    assert.equal(monetary.terminal?.observation.kind, 'provider');
    const plain = await store.read(LEGACY, 'exec-legacy-plain');
    assert.equal(plain?.attempt.amount, undefined);
    assert.equal(Object.prototype.hasOwnProperty.call(plain?.attempt ?? {}, 'parameters'), false);
    await store.close();
  });

  it('a historical attempt replays unchanged; it is never re-prepared with parameters it did not have', async () => {
    const store = await createSqliteExecutionOutcomeStore(legacyStore(), { now: clock() });
    const legacy = (await store.read(LEGACY, 'exec-legacy-plain'))?.attempt as ExecutionAttemptRecord;
    const { schemaVersion: _s, recordedAt: _r, attemptDigest: _d, ...fact } = legacy;
    const replay = await store.prepareAttempt(LEGACY, { ...fact, preparedAt: '2026-09-30T00:00:00.000Z' });
    assert.equal(replay.outcome, 'existing');
    assert.deepEqual(replay.attempt, legacy, 'the v1 record is returned as written');
    await rejectsWith(store.prepareAttempt(LEGACY, { ...fact, parameters: [{ dimension: 'replicaCount', type: 'integer', value: 4 }] }), 'EXECUTION_OUTCOME_CONFLICT');
    await store.close();
  });

  it('M13 — a v1 record carrying parameters is corrupt: v1 never had that meaning', async () => {
    const path = legacyStore();
    const opened = await createSqliteExecutionOutcomeStore(path, { now: clock() });
    await opened.close();
    tamper(path, [`UPDATE execution_attempts SET parameters_json = '[{"dimension":"replicaCount","type":"integer","value":4}]' WHERE execution_id = 'exec-legacy-plain'`]);
    const store = await createSqliteExecutionOutcomeStore(path, { now: clock() });
    await rejectsWith(store.read(LEGACY, 'exec-legacy-plain'), 'EXECUTION_OUTCOME_CORRUPT', /v1 attempt cannot carry governed parameters/);
    const record = buildExecutionAttemptRecord(input(), AT);
    assert.equal(executionAttemptRecordFailure({ ...record, schemaVersion: EXECUTION_OUTCOME_STORE_SCHEMA_VERSION_V1 }), 'a v1 attempt cannot carry governed parameters');
    await store.close();
  });

  it('a tampered historical amount still fails verification after the migration', async () => {
    const path = legacyStore();
    tamper(path, [`UPDATE execution_attempts SET amount_value = '1255' WHERE execution_id = 'exec-legacy-monetary'`]);
    const store = await createSqliteExecutionOutcomeStore(path, { now: clock() });
    await rejectsWith(store.read(LEGACY, 'exec-legacy-monetary'), 'EXECUTION_OUTCOME_CORRUPT');
    await store.close();
  });

  it('a file at an unknown version is still refused unopened', async () => {
    const path = legacyStore();
    tamper(path, [`INSERT INTO execution_outcome_store_versions (schema_version, migration_state, recorded_at) VALUES ('aoc.execution-outcome-store.schema.v3', 'current', '${AT}')`]);
    await assert.rejects(createSqliteExecutionOutcomeStore(path, { now: clock() }), (error: unknown) => isExecutionOutcomeStoreError(error) && error.code === 'EXECUTION_OUTCOME_STORE_UNAVAILABLE');
  });
});

// ---------------------------------------------------------------------------

describe('CORE-08 §18 / §59 — P12 binds and resolves a parameter-bearing attempt by its digest; it never re-executes', () => {
  it('the binder binds the v2 attempt digest; selection sees no parameter; reconciliation resolves from the store without any provider call', async () => {
    const outcomes = createInMemoryExecutionOutcomeStore({ now: clock() });
    const resolutions = createInMemoryExecutionResolutionStore({ now: clock('2026-09-30T13:00:00.000Z') });
    const queries: unknown[] = [];
    const composition = snapshotResolutionAuthorities(
      [
        {
          authorityId: 'devops-status',
          async resolve(query: unknown) {
            queries.push(query);
            return { outcome: 'resolved', certainty: 'confirmed-completed' };
          },
        },
      ],
      () => 'devops-status',
      'test',
    );
    const { attempt } = await outcomes.prepareAttempt(SCOPE, input());
    const binder = createExecutionResolutionBinder({ store: resolutions, composition, now: clock('2026-09-30T12:30:00.000Z') });
    assert.equal(await binder.bindBeforeClaim(attempt), true);
    assert.equal((await resolutions.read(SCOPE, attempt.executionId))?.binding?.attemptDigest, attempt.attemptDigest);
    assert.equal(Object.prototype.hasOwnProperty.call(selectionContextOf(attempt), 'parameters'), false, 'routing a resolution never reads parameters');
    await outcomes.recordTerminal(SCOPE, { organizationId: ORG, executionId: attempt.executionId, observation: { kind: 'provider', certainty: 'unconfirmed', adapterId: 'devops-http', observedAt: '2026-09-30T12:40:00.000Z' } });
    const service = createExecutionReconciliationService({ outcomes, resolutions, composition, claimed: async () => true, now: clock('2026-09-30T14:00:00.000Z') });
    const result = await service.reconcile({ organizationId: ORG, executionId: attempt.executionId });
    assert.equal(result.outcome, 'resolved', JSON.stringify(result));
    assert.ok(result.outcome === 'resolved' && result.resolution.attemptDigest === attempt.attemptDigest);
    assert.equal(queries.length, 1, 'one status query — no resend, no rebuilt payload');
    assert.equal(JSON.stringify(queries[0]).includes('replicaCount'), false, 'the resolution query carries no provider payload');
    // Asked again: answered from the record, the authority is not queried again.
    const again = await service.reconcile({ organizationId: ORG, executionId: attempt.executionId });
    assert.ok(again.outcome === 'resolved' && again.established === 'previously');
    assert.equal(queries.length, 1);
  });
});
