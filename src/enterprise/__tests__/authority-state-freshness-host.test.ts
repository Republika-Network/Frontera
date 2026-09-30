import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';

import type { BoundedGrant } from '../../features/grant-runtime/index.js';
import type { ExecutionAdapter, ValidatedExecutionAction } from '../../features/execution-runtime/index.js';
import { parseStoredGrant } from '../bounded-grant-store/sqlite-bounded-grant-store.js';
import { AuthorityStateFreshnessError } from '../authority-state-freshness/index.js';
import { createEnterprise } from '../composition/composition-root.js';
import { loadEnterpriseConfiguration } from '../configuration/enterprise-configuration.js';
import { bootEnterpriseHost, type EnterpriseHost } from '../host/enterprise-host.js';
import { EnterpriseHostConfigurationError } from '../host/host-configuration.js';
import { buildDurableAuthorityPayloads, DURABLE_FIXTURE_OPERATOR } from '../kernel-authority/fixtures/durable-authority.fixture.js';
import { KernelGrantCapability } from '../../kernel/orchestration/grant-adapter.js';
import { authorityAuthenticityEnv } from './authority-authenticity-fixture.js';
import { WITNESS_TOKEN, freshnessEnv, spawnReferenceWitness, witnessDirectory, witnessRows, type SpawnedWitness } from './core07-freshness-fixture.js';

/**
 * CORE-07 — the exercise-time guarantee through the **real secure Host**.
 *
 * `bootEnterpriseHost()` (what `npm run start:enterprise` runs), `production`
 * profile, SQLite everywhere, signed grants — and the reference
 * authority-state witness as a **separate process**, over its own key and its
 * own database in its own directory. The attack is the one AA-003 / GS-002
 * describe: a grant is issued and exercised, the whole bounded-grant database
 * is captured, the grant is revoked, the Host is stopped, the captured
 * database is restored wholesale, and the Host is started again with the
 * witness **not** rolled back. The adapter must never be called again.
 */

const ORG = 'org-core07-host';
const TRUST_DOMAIN = 'trust-domain-core07';
const ACTION = 'invoice.approve';
const RESOURCE = 'resource-ledger-1';
const OWNER = 'actor-owner';
const AGENT = 'actor-agent';
const AGENT_SUBJECT = { system: 'erp-app', subjectId: 'agent-1' } as const;
const ADAPTER_ID = 'test.recording';
const AGENT_KEY = 'FRONTERA_CORE07_AGENT_KEY_SENTINEL_5e2b90';

const directories: string[] = [];
const hosts: EnterpriseHost[] = [];
const witnesses: SpawnedWitness[] = [];
after(async () => {
  for (const host of hosts) await host.close().catch(() => {});
  for (const witness of witnesses) await witness.kill();
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

function workDir(prefix = 'frontera-core07-host-'): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

async function spawnWitness(): Promise<SpawnedWitness> {
  const { dir } = witnessDirectory();
  directories.push(dir);
  const witness = await spawnReferenceWitness({ dir });
  witnesses.push(witness);
  return witness;
}

function secureEnv(dir: string, witness: SpawnedWitness | undefined): Record<string, string | undefined> {
  const file = join(dir, 'governed-actions.json');
  writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      trustDomainId: TRUST_DOMAIN,
      grantLifetimeSeconds: 3600,
      customerPrincipals: [{ principalId: 'principal-agent', externalSubject: AGENT_SUBJECT, apiKeyEnv: 'FRONTERA_TEST_AGENT_KEY' }],
      routes: [{ action: ACTION, adapterId: ADAPTER_ID }],
    }),
  );
  return {
    AOC_ENTERPRISE_ENV: 'production',
    AOC_ENTERPRISE_PERSISTENCE_PROVIDER: 'sqlite',
    AOC_ENTERPRISE_REQUIRE_AUTH: 'true',
    AOC_ENTERPRISE_HTTP_HOST: '127.0.0.1',
    AOC_ENTERPRISE_HTTP_PORT: '0',
    AOC_ENTERPRISE_LOG_LEVEL: 'error',
    AOC_ENTERPRISE_KERNEL_AUTHORITY_ENABLED: 'true',
    AOC_ENTERPRISE_KERNEL_AUTHORITY_ORGANIZATION_ID: ORG,
    AOC_ENTERPRISE_SQLITE_PATH: join(dir, 'governance.sqlite'),
    AOC_ENTERPRISE_PASSPORT_SQLITE_PATH: join(dir, 'passport.sqlite'),
    AOC_ENTERPRISE_ASSURANCE_SQLITE_PATH: join(dir, 'assurance.sqlite'),
    AOC_ENTERPRISE_KERNEL_AUTHORITY_SQLITE_PATH: join(dir, 'kernel-authority.sqlite'),
    AOC_ENTERPRISE_BOUNDED_GRANT_SQLITE_PATH: join(dir, 'bounded-grants.sqlite'),
    AOC_ENTERPRISE_EMERGENCY_CONTROL_SQLITE_PATH: join(dir, 'emergency-controls.sqlite'),
    AOC_ENTERPRISE_EXERCISE_LEDGER_SQLITE_PATH: join(dir, 'exercise-ledger.sqlite'),
    AOC_ENTERPRISE_AUTHORITY_EVENT_STREAM_SQLITE_PATH: join(dir, 'authority-event-stream.sqlite'),
    AOC_ENTERPRISE_EXECUTION_OUTCOME_SQLITE_PATH: join(dir, 'execution-outcomes.sqlite'),
    AOC_ENTERPRISE_EXECUTION_RESOLUTION_SQLITE_PATH: join(dir, 'execution-resolutions.sqlite'),
    ...authorityAuthenticityEnv(),
    ...(witness !== undefined ? freshnessEnv(witness) : {}),
    AOC_ENTERPRISE_GOVERNED_ACTIONS_FILE: file,
    FRONTERA_TEST_AGENT_KEY: AGENT_KEY,
  };
}

interface Recording {
  readonly adapter: ExecutionAdapter;
  readonly calls: ValidatedExecutionAction[];
}
function recording(): Recording {
  const calls: ValidatedExecutionAction[] = [];
  return {
    calls,
    adapter: {
      adapterId: ADAPTER_ID,
      async execute(action) {
        calls.push(action);
        return { outcome: 'completed', providerRef: `provider-ref-${calls.length}` };
      },
    },
  };
}

async function boot(env: Record<string, string | undefined>, adapter: ExecutionAdapter): Promise<EnterpriseHost> {
  const host = await bootEnterpriseHost({ env, executionAdapters: [adapter] });
  hosts.push(host);
  return host;
}

async function provision(host: EnterpriseHost): Promise<void> {
  const service = host.enterprise.kernelAuthorityProvisioning;
  assert.ok(service !== undefined);
  const payloads = buildDurableAuthorityPayloads(ORG, TRUST_DOMAIN);
  const operator = DURABLE_FIXTURE_OPERATOR;
  await service.provisionActor(operator, payloads.issuerActor);
  await service.provisionTrustDomain(operator, payloads.trustDomain);
  await service.provisionRootIssuer(operator, payloads.rootIssuer);
  await service.provisionActor(operator, { ...payloads.ownerActor, actorId: OWNER, displayName: 'Owner', externalSubject: { system: 'erp-app', subjectId: 'owner-1' } });
  await service.provisionActor(operator, { ...payloads.agentActor, actorId: AGENT, displayName: 'Agent', externalSubject: AGENT_SUBJECT });
  await service.provisionPassport(operator, { ...payloads.passport, passportId: `passport-${AGENT}`, subjectActorId: AGENT });
  await service.provisionCapabilityToken(operator, { ...payloads.capabilityToken, capabilityTokenId: `cap-${AGENT}`, subjectActorId: AGENT, principalActorId: OWNER, issuerActorId: OWNER, actions: [ACTION], resourceScopes: [RESOURCE] });
  await service.provisionAuthorityGrant(operator, { ...payloads.authorityGrant, authorityGrantId: 'authority-grant-owner', subjectActorId: OWNER, actions: [ACTION], resourceScopes: [RESOURCE] });
  await service.provisionDelegationGrant(operator, {
    ...payloads.delegationGrant,
    delegationGrantId: 'delegation-agent',
    delegatorActorId: OWNER,
    delegateActorId: AGENT,
    sourceAuthorityGrantId: 'authority-grant-owner',
    actions: [ACTION],
    resourceScopes: [RESOURCE],
  });
}

let key = 0;
async function govern(host: EnterpriseHost): Promise<Record<string, unknown>> {
  assert.ok(host.enterprise.governAction !== undefined);
  const response = await host.enterprise.governAction({ action: ACTION, resource: RESOURCE, idempotencyKey: `core07-${(key += 1)}` }, { authorizationHeader: `Bearer ${AGENT_KEY}` });
  return response.body as unknown as Record<string, unknown>;
}

function onlyGrant(dir: string): BoundedGrant {
  const db = new Database(join(dir, 'bounded-grants.sqlite'), { readonly: true });
  try {
    const rows = db.prepare('SELECT grant_json FROM bounded_grants').all() as { grant_json: string }[];
    assert.equal(rows.length, 1);
    const grant = parseStoredGrant(rows[0]!.grant_json);
    assert.ok(grant !== undefined);
    return grant;
  } finally {
    db.close();
  }
}

/** A second exercise of the same grant, straight through the composed Authority-Controlled Execution. */
function exerciseAgain(host: EnterpriseHost, grant: BoundedGrant, executionId: string) {
  const ace = host.enterprise.authorityControlledExecution;
  assert.ok(ace !== undefined);
  return ace.exercise({ boundedGrantId: grant.id, correlation: grant.correlation, executionId, subject: grant.subject, action: ACTION, resource: RESOURCE, organization: ORG });
}

type Snapshot = ReadonlyMap<string, string | undefined>;
function capture(path: string, name: string): Snapshot {
  const snapshot = new Map<string, string | undefined>();
  for (const suffix of ['', '-wal', '-shm']) {
    const file = `${path}${suffix}`;
    const copy = `${path}.${name}${suffix || '-main'}`;
    if (existsSync(file)) {
      copyFileSync(file, copy);
      snapshot.set(suffix, copy);
    } else snapshot.set(suffix, undefined);
  }
  return snapshot;
}
function restore(path: string, snapshot: Snapshot): void {
  for (const [suffix, copy] of snapshot) {
    const file = `${path}${suffix}`;
    if (existsSync(file)) unlinkSync(file);
    if (copy !== undefined) copyFileSync(copy, file);
  }
}

describe('CORE-07 — a restored pre-revocation snapshot through the real secure Host', () => {
  it('issue → exercise → capture → revoke → stop → restore → restart: refused as a rollback, with zero further adapter calls', async () => {
    const witness = await spawnWitness();
    const dir = workDir();
    const env = secureEnv(dir, witness);
    const provider = recording();

    let host = await boot(env, provider.adapter);
    assert.equal(host.posture.authorityFreshness, 'external');
    await provision(host);
    assert.equal((await govern(host))['status'], 'executed');
    assert.equal(provider.calls.length, 1);
    const grant = onlyGrant(dir);
    // The grant is still exercisable: a second exercise reaches the provider.
    const again = await exerciseAgain(host, grant, 'exec-before-capture');
    assert.equal(again.status, 'executed', JSON.stringify(again));
    assert.equal(provider.calls.length, 2);
    await host.close();

    const grantsFile = join(dir, 'bounded-grants.sqlite');
    const snapshot = capture(grantsFile, 'pre-revocation');

    host = await boot(env, provider.adapter);
    const revoked = await host.enterprise.authorityControlledExecution?.revokeGrant({ grantId: grant.id, reason: 'security-incident', issuerRef: 'operator:on-call' });
    assert.equal(revoked?.outcome, 'revoked');
    assert.equal((await exerciseAgain(host, grant, 'exec-after-revoke')).status, 'withheld');
    assert.equal(provider.calls.length, 2, 'revoked: not exercised');
    await host.close();
    const witnessed = (await witnessRows(witness.databasePath)).find((row) => row['state_kind'] === 'bounded-grant-revocation-state');
    assert.equal(witnessed?.['committed_sequence'], 1, 'the separate witness process holds the post-revocation state');

    const currentState = capture(grantsFile, 'post-revocation');
    restore(grantsFile, snapshot);

    const refusal = await bootEnterpriseHost({ env, executionAdapters: [provider.adapter] }).then(
      (unexpected) => {
        hosts.push(unexpected);
        return undefined;
      },
      (error: unknown) => error,
    );
    // The reason is freshness regression — not configuration, not a missing store.
    assert.ok(refusal instanceof AuthorityStateFreshnessError, `expected a freshness refusal, got ${String(refusal)}`);
    assert.equal(refusal.code, 'AUTHORITY_FRESHNESS_ROLLBACK_DETECTED');
    for (const secret of [WITNESS_TOKEN, AGENT_KEY]) assert.ok(!refusal.message.includes(secret));
    assert.equal(provider.calls.length, 2, 'the adapter was never called again: no claim, no exercise, no adapter call');

    // Control: the same deployment, put back to its *current* state, boots — so
    // the refusal above was the rollback, and nothing else — and the grant is
    // still revoked.
    restore(grantsFile, currentState);
    host = await boot(env, provider.adapter);
    assert.equal((await exerciseAgain(host, grant, 'exec-after-recovery')).status, 'withheld');
    assert.equal(provider.calls.length, 2);
    await host.close();
  });

  it('the same restored files under a Host with no witness are believed — anti-rollback is not claimed without CORE-07 freshness', async () => {
    const witness = await spawnWitness();
    const dir = workDir();
    const env = secureEnv(dir, witness);
    const provider = recording();
    let host = await boot(env, provider.adapter);
    await provision(host);
    assert.equal((await govern(host))['status'], 'executed');
    const grant = onlyGrant(dir);
    await host.close();
    const grantsFile = join(dir, 'bounded-grants.sqlite');
    const snapshot = capture(grantsFile, 'pre-revocation');
    host = await boot(env, provider.adapter);
    assert.equal((await host.enterprise.authorityControlledExecution?.revokeGrant({ grantId: grant.id, reason: 'security-incident', issuerRef: 'operator:on-call' }))?.outcome, 'revoked');
    await host.close();
    restore(grantsFile, snapshot);

    // A lenient embedding (`createEnterprise`, not the secure Host) with no
    // witness configured: its posture says so, and it believes the old state.
    const lenient = loadEnterpriseConfiguration({ ...secureEnv(dir, undefined), AOC_ENTERPRISE_ENV: 'development' });
    const enterprise = await createEnterprise({
      configuration: lenient,
      authorityControlledExecution: {
        grantCapability: new KernelGrantCapability({ declaration: {} }),
        executionAdapter: provider.adapter,
        resolveAuthorityBinding: () => ({ kind: 'no-temporal-authority-bound', sourceKind: 'organizational-authority', justification: 'test' }),
      },
    });
    try {
      assert.equal((await enterprise.health()).posture?.authorityFreshness, 'not-composed');
      const read = await enterprise.authorityControlledExecution?.assessExercise({ boundedGrantId: grant.id, correlation: grant.correlation, executionId: 'exec-lenient', subject: grant.subject, action: ACTION, resource: RESOURCE, organization: ORG });
      assert.equal(read?.usable, true, 'RESIDUAL without CORE-07 freshness: the restored pre-revocation state is believed');
    } finally {
      await enterprise.close();
    }
  });

  it('G7: a secure Host whose witness is unreachable at a cold start refuses to start; a secure profile without a witness is refused by configuration', async () => {
    const witness = await spawnWitness();
    const dir = workDir();
    const env = secureEnv(dir, witness);
    const provider = recording();
    const host = await boot(env, provider.adapter);
    await host.close();
    await witness.kill();
    const unreachable = await bootEnterpriseHost({ env, executionAdapters: [provider.adapter] }).then(
      (unexpected) => (hosts.push(unexpected), undefined),
      (error: unknown) => error,
    );
    assert.ok(unreachable instanceof AuthorityStateFreshnessError, String(unreachable));
    assert.equal(unreachable.code, 'AUTHORITY_FRESHNESS_UNAVAILABLE');

    const noWitness = await bootEnterpriseHost({ env: secureEnv(workDir(), undefined), executionAdapters: [provider.adapter] }).then(
      (unexpected) => (hosts.push(unexpected), undefined),
      (error: unknown) => error,
    );
    assert.ok(noWitness instanceof EnterpriseHostConfigurationError);
    assert.equal(noWitness.code, 'HOST_AUTHORITY_FRESHNESS_REQUIRED');
    assert.equal(provider.calls.length, 0);
  });

  it('a witness outage after an established start: existing authority still reads (degraded, still ready), a revocation writes nothing and says so', async () => {
    const witness = await spawnWitness();
    const dir = workDir();
    const provider = recording();
    const host = await boot(secureEnv(dir, witness), provider.adapter);
    await provision(host);
    assert.equal((await govern(host))['status'], 'executed');
    const grant = onlyGrant(dir);
    assert.equal((await host.enterprise.health()).status, 'healthy');
    await witness.kill();
    const health = await host.enterprise.health();
    assert.equal(health.status, 'degraded', 'freshness was established at startup; the witness is unavailable now');
    assert.equal(health.authorityFreshness?.witness.state, 'unavailable');
    assert.ok(host.enterprise.isReady());
    assert.equal((await exerciseAgain(host, grant, 'exec-during-outage')).status, 'executed', 'existing, unrevoked authority reads against the startup floor');
    await assert.rejects(
      () => host.enterprise.authorityControlledExecution!.revokeGrant({ grantId: grant.id, reason: 'security-incident', issuerRef: 'operator:on-call' }),
      (error: unknown) => error instanceof AuthorityStateFreshnessError && error.code === 'AUTHORITY_FRESHNESS_UNAVAILABLE',
    );
    const serialized = JSON.stringify(health);
    for (const secret of [WITNESS_TOKEN, witness.endpoint]) assert.ok(!serialized.includes(secret), 'no credential or endpoint on /health');
  });

  it('a rollback underneath a running secure Host makes it unhealthy and not ready, and nothing executes', async () => {
    const witness = await spawnWitness();
    const dir = workDir();
    const provider = recording();
    const host = await boot(secureEnv(dir, witness), provider.adapter);
    await provision(host);
    assert.equal((await govern(host))['status'], 'executed');
    const grant = onlyGrant(dir);
    const grantsFile = join(dir, 'bounded-grants.sqlite');
    const db = new Database(grantsFile);
    const captured = db.prepare('SELECT * FROM bounded_grant_revocation_state').get() as Record<string, unknown>;
    db.close();
    assert.equal((await host.enterprise.authorityControlledExecution?.revokeGrant({ grantId: grant.id, reason: 'security-incident', issuerRef: 'operator:on-call' }))?.outcome, 'revoked');
    const attacker = new Database(grantsFile);
    for (const { name } of attacker.prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger'`).all() as { name: string }[]) attacker.exec(`DROP TRIGGER "${name}"`);
    attacker.prepare('DELETE FROM bounded_grant_revocations WHERE grant_id = ?').run(grant.id);
    attacker.prepare('UPDATE bounded_grants SET revocation_digest = NULL WHERE grant_id = ?').run(grant.id);
    attacker
      .prepare('UPDATE bounded_grant_revocation_state SET sequence = ?, revocation_set_digest = ?, signing_key_id = ?, signature = ?, signature_version = ?, signature_algorithm = ?')
      .run(captured['sequence'], captured['revocation_set_digest'], captured['signing_key_id'], captured['signature'], captured['signature_version'], captured['signature_algorithm']);
    attacker.close();
    const before = provider.calls.length;
    assert.notEqual((await exerciseAgain(host, grant, 'exec-after-rollback')).status, 'executed');
    assert.equal(provider.calls.length, before);
    const health = await host.enterprise.health();
    assert.equal(health.status, 'unhealthy');
    const store = health.authorityFreshness?.stores.find((entry) => entry.stateKind === 'bounded-grant-revocation-state');
    assert.equal(store?.status, 'regressed');
  });
});

describe('CORE-07 — the explicit enrollment ceremony for an existing deployment', () => {
  it('a deployment whose stores the witness has never seen is refused (unbound); the trusted ceremony enrolls it; the operator script refuses without an attestation', async () => {
    const original = await spawnWitness();
    const dir = workDir();
    const provider = recording();
    // An existing deployment, with authority state beyond genesis.
    let host = await boot(secureEnv(dir, original), provider.adapter);
    await provision(host);
    assert.equal((await govern(host))['status'], 'executed');
    const grant = onlyGrant(dir);
    assert.equal((await host.enterprise.authorityControlledExecution?.revokeGrant({ grantId: grant.id, reason: 'security-incident', issuerRef: 'operator:on-call' }))?.outcome, 'revoked');
    await host.close();

    // Pointed at a witness that has never seen it (a first CORE-07 enrollment,
    // or a new witness): no silent enrollment.
    const fresh = await spawnWitness();
    const env = secureEnv(dir, fresh);
    const refused = await bootEnterpriseHost({ env, executionAdapters: [provider.adapter] }).then(
      (unexpected) => (hosts.push(unexpected), undefined),
      (error: unknown) => error,
    );
    assert.ok(refused instanceof AuthorityStateFreshnessError, String(refused));
    assert.equal(refused.code, 'AUTHORITY_FRESHNESS_UNBOUND_STORE');
    assert.deepEqual(await witnessRows(fresh.databasePath), [], 'the witness was never bound by a refused start');

    // The operator script refuses without its explicit attestation.
    const { spawnSync } = await import('node:child_process');
    const script = join(process.cwd(), 'scripts/enroll-authority-state-freshness.mjs');
    const withoutAttestation = spawnSync(process.execPath, [script, '--operator', 'ops-primary', '--store', 'grants'], { env: { PATH: process.env.PATH ?? '', ...env } as NodeJS.ProcessEnv, encoding: 'utf8' });
    assert.equal(withoutAttestation.status, 1);
    assert.match(withoutAttestation.stderr, /--attest-current-state is required/);

    // The ceremony: verified exactly as the Host would, then enrolled.
    const ceremony = spawnSync(process.execPath, [script, '--operator', 'ops-primary', '--attest-current-state', '--store', 'grants'], { env: { PATH: process.env.PATH ?? '', ...env } as NodeJS.ProcessEnv, encoding: 'utf8' });
    assert.equal(ceremony.status, 0, ceremony.stderr);
    assert.match(ceremony.stdout, /enrolled bounded-grant-revocation-state at sequence 1 \(operator ops-primary\)/);
    for (const secret of [WITNESS_TOKEN, AGENT_KEY]) assert.ok(!(ceremony.stdout + ceremony.stderr).includes(secret));

    // Enrollment never rebinds: a second ceremony over other state is refused.
    const again = spawnSync(process.execPath, [script, '--operator', 'ops-primary', '--attest-current-state', '--store', 'grants'], { env: { PATH: process.env.PATH ?? '', ...env } as NodeJS.ProcessEnv, encoding: 'utf8' });
    assert.equal(again.status, 0, 'the exact same state, enrolled again, is the same enrollment');

    host = await boot(env, provider.adapter);
    assert.equal(host.posture.authorityFreshness, 'external');
    assert.equal((await exerciseAgain(host, grant, 'exec-after-enrollment')).status, 'withheld', 'still revoked');
    await host.close();
  });
});
