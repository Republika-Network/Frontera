import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';

import {
  EXECUTION_OUTCOME_STORE_SCHEMA_VERSION,
  createInMemoryExecutionOutcomeStore,
  createSqliteExecutionOutcomeStore,
  isExecutionOutcomeStoreError,
  type ExecutionOutcomeStore,
  type ExecutionTerminalObservation,
  type PrepareExecutionAttemptInput,
} from '../execution-outcome-store/index.js';

/**
 * P11 — the execution outcome store contract, against both implementations,
 * then what only the durable store has: restart, exact money byte-for-byte,
 * append-only triggers, schema refusal before mutation, and fail-closed
 * verification of raw-SQLite corruption.
 */

const ORG_A = 'org-a';
const ORG_B = 'org-b';
const A = { organizationId: ORG_A };
const B = { organizationId: ORG_B };
const AT = '2026-03-01T12:00:00.000Z';

const directories: string[] = [];
after(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

function freshPath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'aoc-execution-outcomes-'));
  directories.push(directory);
  return join(directory, 'execution-outcomes.sqlite');
}

function steppingClock(start = AT): { readonly now: () => string } {
  let tick = 0;
  return { now: () => new Date(Date.parse(start) + (tick += 1)).toISOString() };
}

function attemptInput(overrides: Partial<PrepareExecutionAttemptInput> = {}): PrepareExecutionAttemptInput {
  return {
    organizationId: ORG_A,
    executionId: 'aoc.exec:0001',
    evaluationId: 'eval-0001',
    requestId: 'aoc.gar:0001',
    decisionId: 'dec-0001',
    boundedGrantId: 'grant-0001',
    action: 'payment.send',
    amount: { value: '25', unit: 'USD' },
    preparedAt: AT,
    ...overrides,
  };
}

const COMPLETED = { kind: 'provider', certainty: 'confirmed-completed', adapterId: 'provider.a', providerRef: 'payment-123', observedAt: AT } as const satisfies ExecutionTerminalObservation;
const FAILED = { kind: 'provider', certainty: 'confirmed-not-completed', adapterId: 'provider.a', providerRef: 'request-123', failure: 'PROVIDER_REJECTED', observedAt: AT } as const satisfies ExecutionTerminalObservation;
const UNCONFIRMED = { kind: 'provider', certainty: 'unconfirmed', adapterId: 'provider.a', routedBy: 'frontera.execution-adapter-registry', providerRef: 'provider-job-123', observedAt: AT } as const satisfies ExecutionTerminalObservation;
const WITHHELD = { kind: 'withheld', withheldBy: 'emergency-control', reasonCodes: ['EMERGENCY_CONTROL_ACTIVE'] as readonly string[], observedAt: AT } as const satisfies ExecutionTerminalObservation;

async function rejectsWith(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => isExecutionOutcomeStoreError(error) && error.code === code);
}

interface Harness {
  readonly store: ExecutionOutcomeStore;
  readonly reopen?: () => Promise<ExecutionOutcomeStore>;
}

function describeContract(name: string, open: (now: () => string) => Promise<Harness>): void {
  describe(`${name} — the execution outcome store contract`, () => {
    it('prepares an attempt once; the same attempt retried later is the existing one, first preparedAt intact', async () => {
      const { store } = await open(steppingClock().now);
      const first = await store.prepareAttempt(A, attemptInput());
      assert.equal(first.outcome, 'prepared');
      assert.equal(first.attempt.schemaVersion, EXECUTION_OUTCOME_STORE_SCHEMA_VERSION);
      assert.match(first.attempt.attemptDigest, /^sha256:[0-9a-f]{64}$/);
      const retried = await store.prepareAttempt(A, attemptInput({ preparedAt: '2026-03-01T12:05:00.000Z' }));
      assert.equal(retried.outcome, 'existing');
      assert.deepEqual(retried.attempt, first.attempt);
      await store.close();
    });

    it('a different attempt for the same execution id conflicts, and the first stands', async () => {
      const { store } = await open(steppingClock().now);
      await store.prepareAttempt(A, attemptInput());
      for (const different of [{ amount: { value: '26', unit: 'USD' } }, { amount: { value: '25', unit: 'EUR' } }, { boundedGrantId: 'grant-0002' }, { action: 'payment.refund' }, { decisionId: 'dec-0002' }]) {
        await rejectsWith(store.prepareAttempt(A, attemptInput(different)), 'EXECUTION_OUTCOME_CONFLICT');
      }
      const read = await store.read(A, 'aoc.exec:0001');
      assert.deepEqual(read?.attempt.amount, { value: '25', unit: 'USD' });
      await store.close();
    });

    it('records one initial observation per execution; the identical one is idempotent, any other conflicts', async () => {
      const { store } = await open(steppingClock().now);
      await store.prepareAttempt(A, attemptInput());
      const recorded = await store.recordTerminal(A, { organizationId: ORG_A, executionId: 'aoc.exec:0001', observation: COMPLETED });
      assert.equal(recorded.outcome, 'recorded');
      assert.equal(recorded.terminal.attemptDigest, (await store.read(A, 'aoc.exec:0001'))?.attempt.attemptDigest);
      const again = await store.recordTerminal(A, { organizationId: ORG_A, executionId: 'aoc.exec:0001', observation: { ...COMPLETED } });
      assert.equal(again.outcome, 'existing');
      assert.deepEqual(again.terminal, recorded.terminal);
      const conflicting: readonly ExecutionTerminalObservation[] = [
        { ...COMPLETED, providerRef: 'payment-456' },
        { ...COMPLETED, adapterId: 'provider.b' },
        { ...COMPLETED, observedAt: '2026-03-01T12:00:01.000Z' },
        { kind: 'provider', certainty: 'confirmed-completed', adapterId: 'provider.a', observedAt: AT },
        UNCONFIRMED,
        FAILED,
        WITHHELD,
      ];
      for (const observation of conflicting) {
        await rejectsWith(store.recordTerminal(A, { organizationId: ORG_A, executionId: 'aoc.exec:0001', observation }), 'EXECUTION_OUTCOME_CONFLICT');
      }
      const read = await store.read(A, 'aoc.exec:0001');
      assert.deepEqual(read?.terminal?.observation, COMPLETED, 'the first observation stands; nothing chose a later one');
      await store.close();
    });

    it('an unconfirmed observation is never rewritten as failed or completed', async () => {
      const { store } = await open(steppingClock().now);
      await store.prepareAttempt(A, attemptInput());
      await store.recordTerminal(A, { organizationId: ORG_A, executionId: 'aoc.exec:0001', observation: UNCONFIRMED });
      await rejectsWith(store.recordTerminal(A, { organizationId: ORG_A, executionId: 'aoc.exec:0001', observation: { ...COMPLETED, providerRef: 'provider-job-123' } }), 'EXECUTION_OUTCOME_CONFLICT');
      await rejectsWith(store.recordTerminal(A, { organizationId: ORG_A, executionId: 'aoc.exec:0001', observation: FAILED }), 'EXECUTION_OUTCOME_CONFLICT');
      assert.equal((await store.read(A, 'aoc.exec:0001'))?.terminal?.observation.kind, 'provider');
      const observation = (await store.read(A, 'aoc.exec:0001'))?.terminal?.observation;
      assert.equal(observation?.kind === 'provider' ? observation.certainty : undefined, 'unconfirmed');
      assert.equal(observation?.kind === 'provider' ? observation.providerRef : undefined, 'provider-job-123', 'a reference rides beside an unconfirmed certainty and changes nothing');
      await store.close();
    });

    it('a terminal observation needs a prepared attempt, and cannot restate amount or correlation', async () => {
      const { store } = await open(steppingClock().now);
      await rejectsWith(store.recordTerminal(A, { organizationId: ORG_A, executionId: 'aoc.exec:none', observation: COMPLETED }), 'EXECUTION_OUTCOME_ATTEMPT_NOT_FOUND');
      await store.prepareAttempt(A, attemptInput());
      for (const extra of [{ amount: { value: '1', unit: 'USD' } }, { requestId: 'aoc.gar:other' }, { decisionId: 'dec-x' }, { boundedGrantId: 'grant-x' }, { attemptDigest: 'sha256:' + '0'.repeat(64) }]) {
        await rejectsWith(store.recordTerminal(A, { organizationId: ORG_A, executionId: 'aoc.exec:0001', observation: COMPLETED, ...extra } as never), 'EXECUTION_OUTCOME_INPUT_INVALID');
      }
      await store.close();
    });

    it('refuses impossible certainty combinations and unsafe references', async () => {
      const { store } = await open(steppingClock().now);
      await store.prepareAttempt(A, attemptInput());
      const impossible: readonly unknown[] = [
        { ...COMPLETED, failure: 'PROVIDER_REJECTED' },
        { kind: 'provider', certainty: 'unconfirmed', adapterId: 'provider.a', failure: 'PROVIDER_UNAVAILABLE', observedAt: AT },
        { kind: 'provider', certainty: 'confirmed-not-completed', adapterId: 'provider.a', observedAt: AT },
        { kind: 'provider', certainty: 'confirmed-not-completed', adapterId: 'provider.a', failure: 'NOT_A_REASON', observedAt: AT },
        { kind: 'provider', certainty: 'unconfirmed', adapterId: 'provider.a', withheldBy: 'exercise-control', observedAt: AT },
        { kind: 'provider', certainty: 'probably-completed', adapterId: 'provider.a', observedAt: AT },
        { kind: 'provider', certainty: 'confirmed-completed', observedAt: AT },
        { kind: 'provider', certainty: 'confirmed-completed', adapterId: 'has space', observedAt: AT },
        { ...WITHHELD, adapterId: 'stripe' },
        { ...WITHHELD, providerRef: 'ref' },
        { ...WITHHELD, certainty: 'confirmed-not-completed' },
        { ...WITHHELD, reasonCodes: [] },
        { ...WITHHELD, reasonCodes: ['GRANT_EXERCISE_EXPIRED'] },
        { ...WITHHELD, withheldBy: 'approval' },
        { ...COMPLETED, detail: 'provider said ok' },
        { ...COMPLETED, observedAt: 'yesterday' },
        { ...COMPLETED, settlement: 'final' },
        ...['Bearer abc.def', 'Basic dXNlcjpwYXNzd29yZA==', 'eyJhbGciOi.eyJzdWIiOi', 'https://provider.example/pay/1', 'session=1; cookie=abc', 'authorization: x', 'line\nbreak', ' padded', 'é-unicode', 'x'.repeat(513), '-----BEGIN PRIVATE KEY-----'].map((providerRef) => ({ ...COMPLETED, providerRef })),
      ];
      for (const observation of impossible) {
        await rejectsWith(store.recordTerminal(A, { organizationId: ORG_A, executionId: 'aoc.exec:0001', observation: observation as ExecutionTerminalObservation }), 'EXECUTION_OUTCOME_INPUT_INVALID');
      }
      assert.equal((await store.read(A, 'aoc.exec:0001'))?.terminal, undefined, 'nothing was written');
      await store.close();
    });

    it('refuses money that is not canonical decimal text in a canonical asset', async () => {
      const { store } = await open(steppingClock().now);
      for (const amount of [{ value: 25, unit: 'USD' }, { value: '25.00', unit: 'USD' }, { value: '1e3', unit: 'USD' }, { value: '-1', unit: 'USD' }, { value: '25', unit: '' }, { value: '25', unit: 'US D' }, { value: '25' }, { value: '25', unit: 'USD', scale: 2 }]) {
        await rejectsWith(store.prepareAttempt(A, attemptInput({ amount } as never)), 'EXECUTION_OUTCOME_INPUT_INVALID');
      }
      await rejectsWith(store.prepareAttempt(A, { ...attemptInput(), providerCertainty: 'confirmed-completed' } as never), 'EXECUTION_OUTCOME_INPUT_INVALID');
      await rejectsWith(store.prepareAttempt(A, attemptInput({ preparedAt: 'now' })), 'EXECUTION_OUTCOME_INPUT_INVALID');
      await store.close();
    });

    it('preserves a non-financial attempt with no amount', async () => {
      const { store } = await open(steppingClock().now);
      const { amount: _amount, ...nonFinancial } = attemptInput({ action: 'email.send' });
      const prepared = await store.prepareAttempt(A, nonFinancial);
      assert.equal('amount' in prepared.attempt, false);
      assert.equal('amount' in ((await store.read(A, 'aoc.exec:0001'))?.attempt ?? {}), false);
      await store.close();
    });

    it('is tenant-confined: another organization neither reads nor writes the same execution id', async () => {
      const { store } = await open(steppingClock().now);
      await store.prepareAttempt(A, attemptInput());
      await store.recordTerminal(A, { organizationId: ORG_A, executionId: 'aoc.exec:0001', observation: COMPLETED });
      await rejectsWith(store.read(B, 'aoc.exec:0001'), 'EXECUTION_OUTCOME_TENANT_VIOLATION');
      await rejectsWith(store.prepareAttempt(B, attemptInput({ organizationId: ORG_B })), 'EXECUTION_OUTCOME_TENANT_VIOLATION');
      await rejectsWith(store.recordTerminal(B, { organizationId: ORG_B, executionId: 'aoc.exec:0001', observation: FAILED }), 'EXECUTION_OUTCOME_TENANT_VIOLATION');
      await rejectsWith(store.prepareAttempt(A, attemptInput({ organizationId: ORG_B })), 'EXECUTION_OUTCOME_TENANT_VIOLATION');
      await rejectsWith(store.read({ organizationId: ORG_A, system: true } as never, 'aoc.exec:0001'), 'EXECUTION_OUTCOME_TENANT_VIOLATION');
      await rejectsWith(store.read({} as never, 'aoc.exec:0001'), 'EXECUTION_OUTCOME_TENANT_VIOLATION');
      assert.deepEqual((await store.read(A, 'aoc.exec:0001'))?.terminal?.observation, COMPLETED, "the first organization's outcome is untouched");
      await store.close();
    });

    it('returns frozen, plain records: nothing a reader holds reaches back into the store', async () => {
      const { store } = await open(steppingClock().now);
      await store.prepareAttempt(A, attemptInput());
      await store.recordTerminal(A, { organizationId: ORG_A, executionId: 'aoc.exec:0001', observation: WITHHELD });
      const read = await store.read(A, 'aoc.exec:0001');
      assert.ok(read !== undefined && Object.isFrozen(read) && Object.isFrozen(read.attempt) && Object.isFrozen(read.terminal?.observation));
      assert.equal(await store.read(A, 'aoc.exec:unknown'), undefined);
      await store.close();
    });

    it('two different assets with the same numeral stay different assets', async () => {
      const { store } = await open(steppingClock().now);
      await store.prepareAttempt(A, attemptInput({ executionId: 'aoc.exec:usd', amount: { value: '100', unit: 'USD' } }));
      await store.prepareAttempt(A, attemptInput({ executionId: 'aoc.exec:xrpl', amount: { value: '100', unit: 'xrpl:USD/rIssuer' } }));
      assert.deepEqual((await store.read(A, 'aoc.exec:usd'))?.attempt.amount, { value: '100', unit: 'USD' });
      assert.deepEqual((await store.read(A, 'aoc.exec:xrpl'))?.attempt.amount, { value: '100', unit: 'xrpl:USD/rIssuer' });
      await rejectsWith(store.prepareAttempt(A, attemptInput({ executionId: 'aoc.exec:usd', amount: { value: '100', unit: 'xrpl:USD/rIssuer' } })), 'EXECUTION_OUTCOME_CONFLICT');
      await store.close();
    });

    it('a closed store refuses every call', async () => {
      const { store } = await open(steppingClock().now);
      await store.close();
      await rejectsWith(store.prepareAttempt(A, attemptInput()), 'EXECUTION_OUTCOME_STORE_UNAVAILABLE');
      await rejectsWith(store.read(A, 'aoc.exec:0001'), 'EXECUTION_OUTCOME_STORE_UNAVAILABLE');
      assert.equal((await store.health()).status, 'unhealthy');
    });
  });
}

describeContract('In-memory', async (now) => ({ store: createInMemoryExecutionOutcomeStore({ now }) }));
describeContract('SQLite', async (now) => ({ store: await createSqliteExecutionOutcomeStore(freshPath(), { now }) }));

/** A raw writer on the same file, standing in for someone with filesystem access. The immutability triggers are dropped first, exactly as such a writer could. */
function tamper(path: string, statements: readonly string[]): void {
  const db = new Database(path);
  try {
    for (const trigger of db.prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger'`).all() as { name: string }[]) db.exec(`DROP TRIGGER ${trigger.name}`);
    for (const statement of statements) db.exec(statement);
  } finally {
    db.close();
  }
}

async function seeded(observation: ExecutionTerminalObservation = COMPLETED): Promise<string> {
  const path = freshPath();
  const store = await createSqliteExecutionOutcomeStore(path, { now: steppingClock().now });
  await store.prepareAttempt(A, attemptInput());
  await store.recordTerminal(A, { organizationId: ORG_A, executionId: 'aoc.exec:0001', observation });
  await store.close();
  return path;
}

describe('SQLite execution outcome store — durability and exact money', () => {
  it('9007199254740993.01 survives prepare → SQLite → close → reopen → read byte-for-byte', async () => {
    const path = freshPath();
    const first = await createSqliteExecutionOutcomeStore(path, { now: steppingClock().now });
    await first.prepareAttempt(A, attemptInput({ amount: { value: '9007199254740993.01', unit: 'USD' } }));
    await first.close();
    const reopened = await createSqliteExecutionOutcomeStore(path, { now: steppingClock().now });
    const read = await reopened.read(A, 'aoc.exec:0001');
    assert.equal(read?.attempt.amount?.value, '9007199254740993.01');
    assert.equal(typeof read?.attempt.amount?.value, 'string');
    await reopened.close();
    const db = new Database(path, { readonly: true });
    try {
      const row = db.prepare(`SELECT amount_value, typeof(amount_value) AS type FROM execution_attempts`).get() as { amount_value: string; type: string };
      assert.deepEqual(row, { amount_value: '9007199254740993.01', type: 'text' }, 'stored as TEXT, never as a REAL');
    } finally {
      db.close();
    }
  });

  it('fractions are stored and read back exactly: 0.1, 0.2, 0.3 never become binary approximations', async () => {
    const path = freshPath();
    const store = await createSqliteExecutionOutcomeStore(path, { now: steppingClock().now });
    for (const value of ['0.1', '0.2', '0.3']) await store.prepareAttempt(A, attemptInput({ executionId: `aoc.exec:${value}`, amount: { value, unit: 'USD' } }));
    await store.close();
    const reopened = await createSqliteExecutionOutcomeStore(path, { now: steppingClock().now });
    for (const value of ['0.1', '0.2', '0.3']) assert.equal((await reopened.read(A, `aoc.exec:${value}`))?.attempt.amount?.value, value);
    await reopened.close();
  });

  it('every terminal kind survives a restart intact, with its reference and attribution', async () => {
    for (const observation of [COMPLETED, FAILED, UNCONFIRMED, WITHHELD]) {
      const path = await seeded(observation);
      const reopened = await createSqliteExecutionOutcomeStore(path, { now: steppingClock().now });
      assert.deepEqual((await reopened.read(A, 'aoc.exec:0001'))?.terminal?.observation, observation);
      await reopened.close();
    }
  });

  it('triggers refuse UPDATE and DELETE of attempts and observations', async () => {
    const path = await seeded();
    const db = new Database(path);
    try {
      assert.throws(() => db.exec(`UPDATE execution_attempts SET amount_value = '1'`), /immutable/);
      assert.throws(() => db.exec(`DELETE FROM execution_attempts`), /immutable/);
      assert.throws(() => db.exec(`UPDATE execution_terminal_observations SET certainty = 'unconfirmed'`), /immutable/);
      assert.throws(() => db.exec(`DELETE FROM execution_terminal_observations`), /immutable/);
    } finally {
      db.close();
    }
  });

  it('a file recorded under an unknown schema version is refused, unmutated', async () => {
    const path = await seeded();
    tamper(path, [`INSERT INTO execution_outcome_store_versions (schema_version, migration_state, recorded_at) VALUES ('aoc.execution-outcome-store.schema.v9', 'current', '${AT}')`]);
    await rejectsWith(createSqliteExecutionOutcomeStore(path, { now: steppingClock().now }), 'EXECUTION_OUTCOME_STORE_UNAVAILABLE');
    const db = new Database(path, { readonly: true });
    try {
      assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM execution_outcome_store_versions`).get() as { n: number }).n, 2);
    } finally {
      db.close();
    }
  });

  const corruptions: readonly (readonly [string, string])[] = [
    ['an edited amount', `UPDATE execution_attempts SET amount_value = '26'`],
    ['an amount turned into a REAL', `UPDATE execution_attempts SET amount_value = 25.0`],
    ['a non-canonical amount with a recomputed-looking spelling', `UPDATE execution_attempts SET amount_value = '25.00'`],
    ['an edited asset', `UPDATE execution_attempts SET amount_unit = 'EUR'`],
    ['a half-deleted amount', `UPDATE execution_attempts SET amount_unit = NULL`],
    ['a re-pointed grant', `UPDATE execution_attempts SET bounded_grant_id = 'grant-9999'`],
    ['a moved tenant', `UPDATE execution_attempts SET organization_id = 'org-b'`],
    ['an unknown attempt schema version', `UPDATE execution_attempts SET schema_version = 'v0'`],
    ['a forged attempt digest', `UPDATE execution_attempts SET attempt_digest = 'sha256:${'0'.repeat(64)}'`],
    ['an unconfirmed certainty upgraded to completed', `UPDATE execution_terminal_observations SET certainty = 'confirmed-completed'`],
    ['an unconfirmed certainty downgraded to failed', `UPDATE execution_terminal_observations SET certainty = 'confirmed-not-completed', failure = 'PROVIDER_UNAVAILABLE'`],
    ['a provider reference swapped', `UPDATE execution_terminal_observations SET provider_ref = 'payment-999'`],
    ['an adapter swapped', `UPDATE execution_terminal_observations SET adapter_id = 'provider.b'`],
    ['a failure added to an unconfirmed effect', `UPDATE execution_terminal_observations SET failure = 'PROVIDER_REJECTED'`],
    ['an observation re-pointed at another attempt digest', `UPDATE execution_terminal_observations SET attempt_digest = 'sha256:${'1'.repeat(64)}'`],
    ['an observation moved to another tenant', `UPDATE execution_terminal_observations SET organization_id = 'org-b'`],
    ['a forged observation digest', `UPDATE execution_terminal_observations SET observation_digest = 'sha256:${'2'.repeat(64)}'`],
    ['an orphaned observation', `DELETE FROM execution_attempts`],
    ['an unknown observation kind', `UPDATE execution_terminal_observations SET kind = 'settled'`],
  ];

  for (const [name, statement] of corruptions) {
    it(`fails closed on ${name} — never replayed, never repaired`, async () => {
      const path = await seeded(UNCONFIRMED);
      tamper(path, [statement]);
      const reopened = await createSqliteExecutionOutcomeStore(path, { now: steppingClock().now });
      await rejectsWith(reopened.read(A, 'aoc.exec:0001'), 'EXECUTION_OUTCOME_CORRUPT');
      await rejectsWith(reopened.recordTerminal(A, { organizationId: ORG_A, executionId: 'aoc.exec:0001', observation: COMPLETED }), 'EXECUTION_OUTCOME_CORRUPT');
      await reopened.close();
    });
  }

  it('reports health from the file it holds', async () => {
    const store = await createSqliteExecutionOutcomeStore(freshPath(), { now: steppingClock().now });
    const report = await store.health();
    assert.equal(report.status, 'healthy');
    assert.equal(report.schemaVersion, EXECUTION_OUTCOME_STORE_SCHEMA_VERSION);
    await store.close();
    assert.equal((await store.health()).status, 'unhealthy');
  });
});
