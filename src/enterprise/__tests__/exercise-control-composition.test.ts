import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';

import {
  EXERCISE_CONTROL_REASON_CODES as X,
  createInMemoryExerciseControlLedger,
  type ExerciseControlLedgerPort,
  type ExerciseControlPolicy,
} from '../../features/exercise-control-runtime/index.js';
import { createRecordingExecutionAdapter, type RecordingExecutionAdapter } from '../../features/execution-runtime/tests/execution-fixture.js';
import { KernelGrantCapability } from '../../kernel/orchestration/grant-adapter.js';
import { createEnterprise, type AocEnterprise, type CreateEnterpriseOptions, type EnterpriseExerciseControlsOptions } from '../composition/composition-root.js';
import { loadEnterpriseConfiguration, type EnterpriseApiKey, type EnterpriseConfiguration } from '../configuration/enterprise-configuration.js';
import { createSqliteExerciseControlLedger } from '../exercise-control-ledger/index.js';
import { isExecutionGovernanceError } from '../execution-governance/index.js';
import { createInMemoryKernelAuthorityStore } from '../kernel-authority/in-memory-kernel-authority-store.js';
import type { KernelAuthorityStore } from '../kernel-authority/kernel-authority-store.js';
import { createKernelAuthorityProvisioningService } from '../kernel-authority/provisioning-service.js';
import { EXERCISE_CONTROL_MODULE_ID } from '../modules/exercise-control-module.js';
import { ALLOWED_INTENT, EVALUATED_AT_POLICY, NO_TEMPORAL_BOUND, ORG, PMFREAK_ACTOR_ID, TRUST_DOMAIN_ID } from './governed-action-support.js';
import { buildTestKernelProviders } from './support.js';

/**
 * §33 / §58 — P7 composition: opt-in, refused at startup when it could never
 * work, a durable ledger opened only when enabled, and the same ownership rule
 * every other authority store follows.
 */

const SUBJECT = { system: 'datasys-app', subjectId: 'user-pmfreak' } as const;
const SECRET = 'AOC_EXERCISE_CONTROL_COMPOSITION_API_KEY_SENTINEL';
const KEYS: readonly EnterpriseApiKey[] = [{ key: SECRET, organizationId: ORG, customerIdentity: { principalId: 'principal-pmfreak', externalSubject: SUBJECT } }];

const directories: string[] = [];
const enterprises: AocEnterprise[] = [];
const authorityStores: KernelAuthorityStore[] = [];
after(async () => {
  await Promise.all(enterprises.map((enterprise) => enterprise.close().catch(() => {})));
  await Promise.all(authorityStores.map((store) => store.close().catch(() => {})));
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

function freshLedgerPath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'aoc-exercise-composition-'));
  directories.push(directory);
  return join(directory, 'nested', 'exercise-ledger.sqlite');
}

function configuration(ledgerPath: string): EnterpriseConfiguration {
  const base = loadEnterpriseConfiguration({
    AOC_ENTERPRISE_PERSISTENCE_PROVIDER: 'memory',
    AOC_ENTERPRISE_KERNEL_AUTHORITY_ORGANIZATION_ID: ORG,
    AOC_ENTERPRISE_EXERCISE_LEDGER_SQLITE_PATH: ledgerPath,
  });
  return { ...base, authentication: { apiKeys: KEYS } };
}

async function boundStore(): Promise<KernelAuthorityStore> {
  const store = createInMemoryKernelAuthorityStore();
  authorityStores.push(store);
  await createKernelAuthorityProvisioningService({ store, organizationId: ORG }).provisionActor(
    { system: true, actorId: 'operator-1' },
    { actorId: PMFREAK_ACTOR_ID, type: 'agent', displayName: 'PMFreak', externalSubject: SUBJECT },
  );
  return store;
}

const ONE_PER_ACTOR: ExerciseControlPolicy = (query) => [{ limitId: 'actor-uses', scopeKey: `actor:${query.subject}`, metric: 'count', maximum: 1, window: { kind: 'lifetime' } }];

async function compose(options: {
  readonly ledgerPath: string;
  readonly exerciseControls?: EnterpriseExerciseControlsOptions | Record<string, unknown>;
  readonly adapter?: RecordingExecutionAdapter;
}): Promise<{ readonly enterprise: AocEnterprise; readonly adapter: RecordingExecutionAdapter }> {
  const adapter = options.adapter ?? createRecordingExecutionAdapter();
  const enterprise = await createEnterprise({
    configuration: configuration(options.ledgerPath),
    kernelProviders: buildTestKernelProviders(),
    kernelAuthorityStore: await boundStore(),
    customerIdentityAdmission: { enabled: true },
    authorityControlledExecution: {
      grantCapability: new KernelGrantCapability({ declaration: {} }),
      executionAdapter: adapter,
      resolveAuthorityBinding: () => NO_TEMPORAL_BOUND,
      ...('exerciseControls' in options ? { exerciseControls: options.exerciseControls as EnterpriseExerciseControlsOptions } : {}),
    },
    governedActionOrchestrator: { enabled: true, trustDomainId: TRUST_DOMAIN_ID, grantPolicy: EVALUATED_AT_POLICY },
  } satisfies CreateEnterpriseOptions);
  enterprises.push(enterprise);
  return { enterprise, adapter };
}

let keySequence = 0;
async function govern(enterprise: AocEnterprise) {
  assert.ok(enterprise.governAction !== undefined);
  return (await enterprise.governAction({ ...ALLOWED_INTENT, idempotencyKey: `composition-${(keySequence += 1)}` }, { authorizationHeader: `Bearer ${SECRET}` })).body;
}

function reservationsIn(path: string): number {
  const db = new Database(path, { readonly: true });
  try {
    return (db.prepare(`SELECT COUNT(*) AS n FROM exercise_control_reservations`).get() as { n: number }).n;
  } finally {
    db.close();
  }
}

describe('P7 composition — §58', () => {
  it('A / G. absent: existing behaviour unchanged, no module, and no ledger file is opened or created', async () => {
    const ledgerPath = freshLedgerPath();
    const { enterprise, adapter } = await compose({ ledgerPath });
    assert.equal((await govern(enterprise)).status, 'executed');
    assert.equal((await govern(enterprise)).status, 'executed');
    assert.equal(adapter.callCount, 2);
    assert.equal(existsSync(ledgerPath), false, 'the default ledger is never created when P7 is not composed');
    assert.equal(enterprise.modules().some((module) => module.id === EXERCISE_CONTROL_MODULE_ID), false);
  });

  it('B. enabled with a policy, a resolver and the default ledger: the durable SQLite ledger is opened and enforced', async () => {
    const ledgerPath = freshLedgerPath();
    const { enterprise, adapter } = await compose({ ledgerPath, exerciseControls: { policy: ONE_PER_ACTOR, revalidateAuthorityBinding: () => NO_TEMPORAL_BOUND } });
    assert.equal((await govern(enterprise)).status, 'executed');
    const second = await govern(enterprise);
    assert.equal(second.status, 'withheld');
    assert.equal(second.status === 'withheld' ? second.withheldBy : undefined, 'exercise');
    assert.deepEqual([...second.reasonCodes], [X.EXERCISE_CONTROL_LIMIT_EXCEEDED]);
    assert.equal(adapter.callCount, 1);
    assert.ok(existsSync(ledgerPath), 'the configured path (and its directory) was created');
    assert.equal(reservationsIn(ledgerPath), 1);
    const module = enterprise.modules().find((entry) => entry.id === EXERCISE_CONTROL_MODULE_ID);
    assert.ok(module !== undefined, 'the exercise-control module is registered');
    const health = await enterprise.health();
    assert.ok(JSON.stringify(health).includes(EXERCISE_CONTROL_MODULE_ID));
  });

  it('C. a custom ledger is used verbatim', async () => {
    const ledgerPath = freshLedgerPath();
    const inner = createInMemoryExerciseControlLedger({ now: () => '2026-01-01T00:00:00.000Z' });
    let reserves = 0;
    const ledger: ExerciseControlLedgerPort = { ...inner, reserve: (request) => ((reserves += 1), inner.reserve(request)) };
    const { enterprise } = await compose({ ledgerPath, exerciseControls: { policy: ONE_PER_ACTOR, revalidateAuthorityBinding: () => NO_TEMPORAL_BOUND, ledger } });
    assert.equal((await govern(enterprise)).status, 'executed');
    assert.equal(reserves, 1);
    assert.equal(existsSync(ledgerPath), false, 'no default ledger is opened when the host supplies one');
  });

  for (const [label, block, path] of [
    ['D. without a policy', { revalidateAuthorityBinding: () => NO_TEMPORAL_BOUND }, undefined],
    ['E. without an exercise-time binding resolver', { policy: ONE_PER_ACTOR }, undefined],
    ['E2. with a non-function policy', { policy: [], revalidateAuthorityBinding: () => NO_TEMPORAL_BOUND }, undefined],
    ['F. with an object that is not a ledger', { policy: ONE_PER_ACTOR, revalidateAuthorityBinding: () => NO_TEMPORAL_BOUND, ledger: { reserve: () => undefined } }, undefined],
    ['F2. with no usable ledger location', { policy: ONE_PER_ACTOR, revalidateAuthorityBinding: () => NO_TEMPORAL_BOUND }, '   '],
  ] as const) {
    it(`${label}: startup is refused before any traffic, and no ledger file is created`, async () => {
      const ledgerPath = path ?? freshLedgerPath();
      await assert.rejects(
        compose({ ledgerPath, exerciseControls: block as Record<string, unknown> }),
        (error: unknown) => isExecutionGovernanceError(error) && error.code === 'EXECUTION_EXERCISE_CONTROLS_INVALID',
      );
      if (path === undefined) assert.equal(existsSync(ledgerPath), false);
    });
  }

  it('F3. a stated-but-undefined exerciseControls is refused rather than read as "absent"', async () => {
    await assert.rejects(
      compose({ ledgerPath: freshLedgerPath(), exerciseControls: undefined as unknown as Record<string, unknown> }),
      (error: unknown) => isExecutionGovernanceError(error) && error.code === 'EXECUTION_EXERCISE_CONTROLS_INVALID',
    );
  });

  it('H. a ledger the composition opened is closed on Enterprise close', async () => {
    const ledgerPath = freshLedgerPath();
    const { enterprise } = await compose({ ledgerPath, exerciseControls: { policy: ONE_PER_ACTOR, revalidateAuthorityBinding: () => NO_TEMPORAL_BOUND } });
    await govern(enterprise);
    assert.ok(existsSync(`${ledgerPath}-wal`), 'an open WAL connection holds its -wal file');
    await enterprise.close();
    assert.equal(existsSync(`${ledgerPath}-wal`), false, 'the last connection closed and checkpointed: the composition closed what it opened');
  });

  it('I. a host-supplied ledger is NOT closed by the Enterprise', async () => {
    const ledgerPath = freshLedgerPath();
    const ledger = await createSqliteExerciseControlLedger(ledgerPath);
    const { enterprise } = await compose({ ledgerPath: freshLedgerPath(), exerciseControls: { policy: ONE_PER_ACTOR, revalidateAuthorityBinding: () => NO_TEMPORAL_BOUND, ledger } });
    await govern(enterprise);
    await enterprise.close();
    const health = await ledger.health();
    assert.equal(health.status, 'healthy', 'the host still owns an open ledger');
    await ledger.close();
  });

  it('J. two Enterprise instances on the same ledger file cannot over-reserve one quota', async () => {
    const ledgerPath = freshLedgerPath();
    const exerciseControls = { policy: ONE_PER_ACTOR, revalidateAuthorityBinding: () => NO_TEMPORAL_BOUND };
    const left = await compose({ ledgerPath, exerciseControls });
    const right = await compose({ ledgerPath, exerciseControls });
    const results = await Promise.all([govern(left.enterprise), govern(right.enterprise)]);
    assert.deepEqual(results.map((result) => result.status).sort(), ['executed', 'withheld']);
    assert.equal(left.adapter.callCount + right.adapter.callCount, 1);
    assert.equal(reservationsIn(ledgerPath), 1);
  });
});
