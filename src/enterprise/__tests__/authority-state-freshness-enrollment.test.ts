import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';

import { createGrantIssuanceService, type GrantCorrelation, type GrantSourceAuthorization } from '../../features/grant-runtime/index.js';
import { createSqliteApprovalStore } from '../approval-authority/sqlite-approval-store.js';
import { AuthorityStateFreshnessError, type AuthorityStateEnrollmentContext, type AuthorityStateKind } from '../authority-state-freshness/index.js';
import { createSqliteBoundedGrantStore } from '../bounded-grant-store/index.js';
import { enrollExistingAuthorityStores } from '../composition/composition-root.js';
import { loadEnterpriseConfiguration, validateEnterpriseEnvironment } from '../configuration/enterprise-configuration.js';
import { createSqliteObligationDischargeStore } from '../obligation-discharge/sqlite-obligation-discharge-store.js';
import { authorityAuthenticityEnv, dropAuthorityStoreTriggers, testAuthenticity } from './authority-authenticity-fixture.js';
import { WITNESS_TOKEN, closeAllWitnesses, freshnessEnv, startWitness, witnessRows, type StartedWitness } from './core07-freshness-fixture.js';

/**
 * CORE-07 — the explicit enrollment ceremony refuses, all or nothing, when a
 * named store's local authenticated state does not verify.
 *
 * Enrollment is the operator's declaration that a store's **verified** state
 * is the baseline freshness starts from. A store whose state does not verify
 * has no such baseline: the ceremony must neither enroll it, nor skip it
 * silently and report success, nor enroll the *other* named stores behind a
 * refusal. Exercised through the real ceremony (`enrollExistingAuthorityStores`,
 * which the operator script calls) and through the operator script itself,
 * against a real reference witness.
 */

const ORG = 'org-core07-enrollment';
const NOW = '2026-01-01T12:00:00.000Z';
const OPERATOR: AuthorityStateEnrollmentContext = { operator: true, operatorId: 'ops-primary', attestation: 'verified-local-state-is-current' };
const ALL: readonly AuthorityStateKind[] = ['bounded-grant-revocation-state', 'obligation-discharge-state', 'approval-state'];
const CORRUPT_DIGEST = `sha256:${'f'.repeat(64)}`;

const directories: string[] = [];
after(async () => {
  await closeAllWitnesses();
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

interface Deployment {
  readonly env: Record<string, string>;
  readonly witness: StartedWitness;
  readonly paths: Readonly<Record<AuthorityStateKind, string>>;
}

/** An existing deployment the witness has never seen: a grant store beyond genesis, a discharge store and an approval store, all authentic. */
async function existingDeployment(): Promise<Deployment> {
  const dir = mkdtempSync(join(tmpdir(), 'frontera-core07-enroll-'));
  directories.push(dir);
  const paths: Record<AuthorityStateKind, string> = {
    'bounded-grant-revocation-state': join(dir, 'bounded-grants.sqlite'),
    'obligation-discharge-state': join(dir, 'obligation-discharges.sqlite'),
    'approval-state': join(dir, 'approvals.sqlite'),
  };
  const authenticity = testAuthenticity();
  const grants = await createSqliteBoundedGrantStore(paths['bounded-grant-revocation-state'], { authenticity });
  const correlation: GrantCorrelation = { requestId: 'req-1', decisionId: 'dec-1', action: 'payment.send', resourceScope: 'record:contract' };
  const source: GrantSourceAuthorization = {
    correlation,
    subject: 'actor-a',
    scope: { action: { kind: 'identity', value: 'payment.send' }, amount: { kind: 'ceiling', limit: '10', unit: 'USD' }, resources: { kind: 'set', values: ['record:contract'] } },
    authorizationPermitsExercise: true,
    allBlockingObligationsSatisfied: true,
    evaluatedAt: NOW,
    validityCeilings: [],
  };
  const issued = await createGrantIssuanceService({ store: grants }).issueGrant({ source, subject: 'actor-a', correlation, issuedAt: NOW, expiresAt: '2026-01-01T12:10:00.000Z' });
  assert.equal(issued.outcome, 'issued');
  if (issued.outcome !== 'issued') throw new Error('unreachable');
  assert.equal((await grants.revoke({ grantId: issued.grant.id, reason: 'security-incident', revokedAt: '2026-01-01T12:05:00.000Z', issuerRef: 'operator-a' })).outcome, 'revoked');
  await grants.close();
  const now = () => NOW;
  await (await createSqliteObligationDischargeStore(paths['obligation-discharge-state'], { now, organizationId: ORG, authenticity })).close();
  await (await createSqliteApprovalStore(paths['approval-state'], { now, organizationId: ORG, authenticity })).close();

  const witness = await startWitness();
  const env: Record<string, string> = {
    AOC_ENTERPRISE_ENV: 'development',
    AOC_ENTERPRISE_PERSISTENCE_PROVIDER: 'sqlite',
    AOC_ENTERPRISE_SQLITE_PATH: join(dir, 'governance.sqlite'),
    AOC_ENTERPRISE_KERNEL_AUTHORITY_ORGANIZATION_ID: ORG,
    AOC_ENTERPRISE_BOUNDED_GRANT_SQLITE_PATH: paths['bounded-grant-revocation-state'],
    AOC_ENTERPRISE_OBLIGATION_DISCHARGE_SQLITE_PATH: paths['obligation-discharge-state'],
    AOC_ENTERPRISE_APPROVAL_SQLITE_PATH: paths['approval-state'],
    ...authorityAuthenticityEnv(),
    ...freshnessEnv(witness),
  };
  assert.deepEqual(validateEnterpriseEnvironment(env), []);
  return { env, witness, paths };
}

/** A database-level writer breaks the store's signed head: the digest no longer matches its signature. */
function corrupt(deployment: Deployment, kind: AuthorityStateKind): void {
  const db = new Database(deployment.paths[kind]);
  try {
    dropAuthorityStoreTriggers(db);
    const table = kind === 'bounded-grant-revocation-state' ? 'bounded_grant_revocation_state' : kind === 'obligation-discharge-state' ? 'obligation_discharge_head' : 'approval_head';
    const column = kind === 'bounded-grant-revocation-state' ? 'revocation_set_digest' : 'chain_digest';
    assert.equal(db.prepare(`UPDATE ${table} SET ${column} = ?`).run(CORRUPT_DIGEST).changes, 1);
  } finally {
    db.close();
  }
}

async function nothingEnrolled(witness: StartedWitness): Promise<void> {
  assert.deepEqual(await witnessRows(witness.databasePath), [], 'the witness holds no binding at all');
  assert.equal(witness.operationCounts()['enroll'], 0, 'no enrollment was ever sent to the witness');
}

function refusedNaming(kind: AuthorityStateKind) {
  return (error: unknown): true => {
    assert.ok(error instanceof AuthorityStateFreshnessError, `expected an AuthorityStateFreshnessError, got ${String(error)}`);
    assert.equal(error.code, 'AUTHORITY_FRESHNESS_CONFIGURATION_INVALID');
    assert.match(error.message, new RegExp(`Nothing was enrolled: the local authority state of [^.]*${kind}[^.]* does not verify`));
    return true;
  };
}

describe('CORE-07 — the enrollment ceremony refuses a named store whose local state does not verify', () => {
  it('control: three verified stores are enrolled, each at its verified sequence', async () => {
    const deployment = await existingDeployment();
    const enrolled = await enrollExistingAuthorityStores(loadEnterpriseConfiguration(deployment.env), OPERATOR, ALL);
    assert.deepEqual(
      [...enrolled].sort((a, b) => a.stateKind.localeCompare(b.stateKind)),
      [
        { stateKind: 'approval-state', sequence: 0 },
        { stateKind: 'bounded-grant-revocation-state', sequence: 1 },
        { stateKind: 'obligation-discharge-state', sequence: 0 },
      ],
    );
    assert.equal((await witnessRows(deployment.witness.databasePath)).length, 3);
  });

  for (const invalid of ALL) {
    it(`an unverifiable ${invalid} store refuses the whole ceremony — never skipped, and no other named store is enrolled behind the refusal`, async () => {
      const deployment = await existingDeployment();
      corrupt(deployment, invalid);
      // Named last, so the valid stores come first: nothing may be enrolled before the refusal.
      const order = [...ALL.filter((kind) => kind !== invalid), invalid];
      await assert.rejects(() => enrollExistingAuthorityStores(loadEnterpriseConfiguration(deployment.env), OPERATOR, order), refusedNaming(invalid));
      await nothingEnrolled(deployment.witness);
    });
  }

  it('the operator script: exit 1, a refusal naming the store, no "enrolled" line, no secret, and an untouched witness', async () => {
    const deployment = await existingDeployment();
    corrupt(deployment, 'bounded-grant-revocation-state');
    const script = join(process.cwd(), 'scripts/enroll-authority-state-freshness.mjs');
    const result = spawnSync(process.execPath, [script, '--operator', 'ops-primary', '--attest-current-state', '--store', 'obligations', '--store', 'approvals', '--store', 'grants'], {
      env: { PATH: process.env.PATH ?? '', ...deployment.env } as NodeJS.ProcessEnv,
      encoding: 'utf8',
    });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.equal(result.stdout, '', 'nothing is reported as enrolled');
    assert.match(result.stderr, /authority-state enrollment refused: AUTHORITY_FRESHNESS_CONFIGURATION_INVALID: Nothing was enrolled: the local authority state of bounded-grant-revocation-state does not verify/);
    for (const secret of [WITNESS_TOKEN, deployment.env['AOC_ENTERPRISE_AUTHORITY_SIGNING_KEY_PEM']!]) assert.ok(!result.stderr.includes(secret));
    await nothingEnrolled(deployment.witness);
  });
});
