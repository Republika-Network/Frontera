import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';

import {
  EXECUTION_RESOLUTION_STORE_SCHEMA_VERSION,
  createInMemoryExecutionResolutionStore,
  createSqliteExecutionResolutionStore,
  isExecutionResolutionStoreError,
  type BindExecutionResolutionAuthorityInput,
  type ExecutionResolutionStore,
  type ExecutionResolutionStoreErrorCode,
  type RecordExecutionResolutionInput,
} from '../execution-resolution-store/index.js';

/**
 * P12 — the execution resolution store: one shared contract run against the
 * process-local and the SQLite store, then what only the durable store has —
 * restart, append-only triggers, verification of every persisted field and
 * schema refusal before mutation.
 */

const ORG = 'org-a';
const A = { organizationId: ORG };
const T = (seconds: number): string => new Date(Date.parse('2026-09-01T00:00:00.000Z') + seconds * 1000).toISOString();
const ATTEMPT = `sha256:${'1'.repeat(64)}`;
const OTHER_ATTEMPT = `sha256:${'2'.repeat(64)}`;
const OBSERVATION = `sha256:${'3'.repeat(64)}`;

const directories: string[] = [];
after(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

function freshPath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'aoc-p12-resolution-'));
  directories.push(directory);
  return join(directory, 'execution-resolutions.sqlite');
}

function clock() {
  let seconds = 0;
  return () => T((seconds += 1));
}

let sequence = 0;
function bindingInput(overrides: Partial<BindExecutionResolutionAuthorityInput> = {}): BindExecutionResolutionAuthorityInput {
  return { organizationId: ORG, executionId: `aoc.exec:p12-${(sequence += 1)}`, attemptDigest: ATTEMPT, authorityId: 'resolver-a', origin: 'pre-claim', boundAt: T(0), ...overrides };
}

function resolutionInput(binding: { readonly executionId: string; readonly bindingDigest: string; readonly attemptDigest: string; readonly authorityId: string }, overrides: Partial<RecordExecutionResolutionInput> = {}): RecordExecutionResolutionInput {
  return {
    organizationId: ORG,
    executionId: binding.executionId,
    attemptDigest: binding.attemptDigest,
    bindingDigest: binding.bindingDigest,
    basisObservationDigest: OBSERVATION,
    authorityId: binding.authorityId,
    certainty: 'confirmed-not-completed',
    failure: 'PROVIDER_REJECTED',
    resolvedAt: T(10),
    ...overrides,
  } as RecordExecutionResolutionInput;
}

async function rejectsWith(promise: Promise<unknown>, code: ExecutionResolutionStoreErrorCode): Promise<void> {
  await assert.rejects(promise, (error: unknown) => isExecutionResolutionStoreError(error) && error.code === code, `expected ${code}`);
}

function describeContract(name: string, open: () => Promise<ExecutionResolutionStore>): void {
  describe(`${name} — P12 binding`, () => {
    it('§119 bind, then read it back verified and frozen', async () => {
      const store = await open();
      const input = bindingInput();
      const bound = await store.bind(A, input);
      assert.equal(bound.outcome, 'bound');
      const state = await store.read(A, input.executionId);
      assert.deepEqual(state?.binding, bound.binding);
      assert.equal(state?.resolution, undefined);
      assert.ok(Object.isFrozen(state?.binding));
      await store.close();
    });

    it('§121 / §25 the same binding is idempotent; another authority or attempt is a conflict and nothing is overwritten', async () => {
      const store = await open();
      const input = bindingInput();
      const first = (await store.bind(A, input)).binding;
      const again = await store.bind(A, { ...input, boundAt: T(99), origin: 'adopted' });
      assert.equal(again.outcome, 'existing');
      assert.equal(again.binding.bindingDigest, first.bindingDigest, 'never re-dated');
      await rejectsWith(store.bind(A, { ...input, authorityId: 'resolver-b' }), 'EXECUTION_RESOLUTION_CONFLICT');
      await rejectsWith(store.bind(A, { ...input, attemptDigest: OTHER_ATTEMPT }), 'EXECUTION_RESOLUTION_CONFLICT');
      assert.equal((await store.read(A, input.executionId))?.binding?.authorityId, 'resolver-a');
      await store.close();
    });

    it('refuses a binding outside the closed contract', async () => {
      const store = await open();
      for (const bad of [{ authorityId: '' }, { authorityId: 'has space' }, { attemptDigest: 'nope' }, { origin: 'inferred' }, { boundAt: 'yesterday' }, { amount: '100' }] as const) {
        await rejectsWith(store.bind(A, { ...bindingInput(), ...bad } as BindExecutionResolutionAuthorityInput), 'EXECUTION_RESOLUTION_INPUT_INVALID');
      }
      await store.close();
    });
  });

  describe(`${name} — P12 resolution`, () => {
    it('only the bound authority, attempt and binding can resolve', async () => {
      const store = await open();
      const binding = (await store.bind(A, bindingInput())).binding;
      await rejectsWith(store.recordResolution(A, resolutionInput(binding, { authorityId: 'resolver-b' })), 'EXECUTION_RESOLUTION_NOT_BOUND');
      await rejectsWith(store.recordResolution(A, resolutionInput(binding, { attemptDigest: OTHER_ATTEMPT })), 'EXECUTION_RESOLUTION_NOT_BOUND');
      await rejectsWith(store.recordResolution(A, resolutionInput(binding, { bindingDigest: `sha256:${'9'.repeat(64)}` })), 'EXECUTION_RESOLUTION_NOT_BOUND');
      await rejectsWith(store.recordResolution(A, resolutionInput({ ...binding, executionId: 'aoc.exec:unbound' })), 'EXECUTION_RESOLUTION_NOT_BOUND');
      await store.close();
    });

    it('§46 / §96 an identical resolution is idempotent (another instant); a different one is a conflict — never latest-wins', async () => {
      const store = await open();
      const binding = (await store.bind(A, bindingInput())).binding;
      const first = await store.recordResolution(A, resolutionInput(binding));
      assert.equal(first.outcome, 'recorded');
      const again = await store.recordResolution(A, resolutionInput(binding, { resolvedAt: T(50) }));
      assert.equal(again.outcome, 'existing');
      assert.equal(again.resolution.resolvedAt, T(10));
      await rejectsWith(store.recordResolution(A, (({ failure: _failure, ...rest }) => ({ ...rest, certainty: 'confirmed-completed' }))(resolutionInput(binding)) as RecordExecutionResolutionInput), 'EXECUTION_RESOLUTION_CONFLICT');
      await rejectsWith(store.recordResolution(A, resolutionInput(binding, { failure: 'PROVIDER_UNAVAILABLE' })), 'EXECUTION_RESOLUTION_CONFLICT');
      await rejectsWith(store.recordResolution(A, resolutionInput(binding, { providerRef: 'payment-123' })), 'EXECUTION_RESOLUTION_CONFLICT');
      assert.equal((await store.read(A, binding.executionId))?.resolution?.resolutionDigest, first.resolution.resolutionDigest);
      await store.close();
    });

    it('§9 / §37 / §38 closed answers only: no probability, no amount, no correlation, no failure on a completion', async () => {
      const store = await open();
      const binding = (await store.bind(A, bindingInput())).binding;
      for (const bad of [
        { certainty: 'probably-completed' },
        { certainty: 'confirmed-completed' },
        { failure: 'TIMEOUT' },
        { failure: undefined },
        { amount: { value: '100', unit: 'USD' } },
        { requestId: 'req-x' },
        { confidence: 0.9 },
        { providerRef: 'Bearer abcdefghijkl' },
        { providerRef: 'https://provider.example/payments/1' },
        { providerRef: 42 },
      ]) {
        await rejectsWith(store.recordResolution(A, { ...resolutionInput(binding), ...bad } as unknown as RecordExecutionResolutionInput), 'EXECUTION_RESOLUTION_INPUT_INVALID');
      }
      assert.equal((await store.read(A, binding.executionId))?.resolution, undefined);
      await store.close();
    });

    it('§28 a claim-only resolution has no basis observation, and says so', async () => {
      const store = await open();
      const binding = (await store.bind(A, bindingInput())).binding;
      const recorded = await store.recordResolution(A, {
        organizationId: ORG,
        executionId: binding.executionId,
        attemptDigest: binding.attemptDigest,
        bindingDigest: binding.bindingDigest,
        authorityId: binding.authorityId,
        certainty: 'confirmed-completed',
        providerRef: 'p-123',
        resolvedAt: T(10),
      });
      assert.equal(recorded.resolution.basisObservationDigest, undefined);
      assert.equal(recorded.resolution.providerRef, 'p-123');
      await store.close();
    });
  });

  describe(`${name} — P12 §88 tenant confinement`, () => {
    it('another organization reads nothing and writes nothing; no system escape', async () => {
      const store = await open();
      const binding = (await store.bind(A, bindingInput())).binding;
      await rejectsWith(store.read({ organizationId: 'org-b' }, binding.executionId), 'EXECUTION_RESOLUTION_TENANT_VIOLATION');
      await rejectsWith(store.bind({ organizationId: 'org-b' }, bindingInput()), 'EXECUTION_RESOLUTION_TENANT_VIOLATION');
      await rejectsWith(store.recordResolution({ organizationId: 'org-b' }, { ...resolutionInput(binding), organizationId: 'org-b' }), 'EXECUTION_RESOLUTION_TENANT_VIOLATION');
      await rejectsWith(store.read({ organizationId: ORG, system: true } as unknown as { organizationId: string }, binding.executionId), 'EXECUTION_RESOLUTION_TENANT_VIOLATION');
      await store.close();
    });
  });
}

describeContract('In-memory execution resolution store', async () => createInMemoryExecutionResolutionStore({ now: clock() }));
describeContract('SQLite execution resolution store', async () => createSqliteExecutionResolutionStore(freshPath(), { now: clock() }));

function tamper(path: string, statements: readonly string[]): void {
  const db = new Database(path);
  try {
    for (const trigger of db.prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger'`).all() as { name: string }[]) db.exec(`DROP TRIGGER ${trigger.name}`);
    for (const statement of statements) db.exec(statement);
  } finally {
    db.close();
  }
}

describe('SQLite execution resolution store — durability and integrity', () => {
  async function resolved(path: string) {
    const store = await createSqliteExecutionResolutionStore(path, { now: clock() });
    const binding = (await store.bind(A, bindingInput())).binding;
    const resolution = (await store.recordResolution(A, resolutionInput(binding))).resolution;
    await store.close();
    return { binding, resolution };
  }

  it('§119 survives restart byte for byte', async () => {
    const path = freshPath();
    const { binding, resolution } = await resolved(path);
    const store = await createSqliteExecutionResolutionStore(path, { now: clock() });
    assert.deepEqual(await store.read(A, binding.executionId), { binding, resolution });
    await store.close();
  });

  it('WAL, synchronous = FULL, and UPDATE / DELETE refused on both tables', async () => {
    const path = freshPath();
    await resolved(path);
    const db = new Database(path);
    try {
      assert.equal(db.pragma('journal_mode', { simple: true }), 'wal');
      for (const statement of [
        `UPDATE execution_resolution_bindings SET authority_id = 'resolver-b'`,
        `DELETE FROM execution_resolution_bindings`,
        `UPDATE execution_resolutions SET certainty = 'confirmed-completed'`,
        `DELETE FROM execution_resolutions`,
      ]) {
        assert.throws(() => db.exec(statement), /immutable/, statement);
      }
    } finally {
      db.close();
    }
  });

  for (const [column, table, value] of [
    ['authority_id', 'execution_resolution_bindings', `'resolver-b'`],
    ['attempt_digest', 'execution_resolution_bindings', `'sha256:${'7'.repeat(64)}'`],
    ['binding_digest', 'execution_resolution_bindings', `'sha256:${'7'.repeat(64)}'`],
    ['certainty', 'execution_resolutions', `'confirmed-completed'`],
    ['failure', 'execution_resolutions', `'PROVIDER_UNAVAILABLE'`],
    ['provider_ref', 'execution_resolutions', `'forged-ref'`],
    ['basis_observation_digest', 'execution_resolutions', 'NULL'],
    ['resolution_digest', 'execution_resolutions', `'sha256:${'7'.repeat(64)}'`],
  ] as const) {
    it(`§134 / §135 a tampered ${table}.${column} is EXECUTION_RESOLUTION_CORRUPT, never repaired`, async () => {
      const path = freshPath();
      const { binding } = await resolved(path);
      tamper(path, [`UPDATE ${table} SET ${column} = ${value}`]);
      const store = await createSqliteExecutionResolutionStore(path, { now: clock() });
      await rejectsWith(store.read(A, binding.executionId), 'EXECUTION_RESOLUTION_CORRUPT');
      await rejectsWith(store.recordResolution(A, resolutionInput(binding)), 'EXECUTION_RESOLUTION_CORRUPT');
      await store.close();
    });
  }

  it('a resolution whose binding was deleted is corrupt', async () => {
    const path = freshPath();
    const { binding } = await resolved(path);
    tamper(path, [`DELETE FROM execution_resolution_bindings`]);
    const store = await createSqliteExecutionResolutionStore(path, { now: clock() });
    await rejectsWith(store.read(A, binding.executionId), 'EXECUTION_RESOLUTION_CORRUPT');
    await store.close();
  });

  it('an unknown schema version is refused before mutation', async () => {
    const path = freshPath();
    await resolved(path);
    tamper(path, [`INSERT INTO execution_resolution_store_versions (schema_version, migration_state, recorded_at) VALUES ('aoc.execution-resolution-store.schema.v999', 'current', '${T(1)}')`]);
    await rejectsWith(createSqliteExecutionResolutionStore(path, { now: clock() }), 'EXECUTION_RESOLUTION_STORE_UNAVAILABLE');
    const db = new Database(path, { readonly: true });
    try {
      assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM execution_resolution_store_versions WHERE schema_version = ?`).get(EXECUTION_RESOLUTION_STORE_SCHEMA_VERSION) as { n: number }).n, 1);
    } finally {
      db.close();
    }
  });

  it('health reports store readability only, and closed is unhealthy', async () => {
    const store = await createSqliteExecutionResolutionStore(freshPath(), { now: clock() });
    assert.equal((await store.health()).status, 'healthy');
    await store.close();
    assert.equal((await store.health()).status, 'unhealthy');
    await rejectsWith(store.read(A, 'aoc.exec:x'), 'EXECUTION_RESOLUTION_STORE_UNAVAILABLE');
  });
});
