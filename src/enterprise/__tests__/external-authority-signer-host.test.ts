import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import Database from 'better-sqlite3';

import { AuthorityAuthenticityConfigurationError, AuthoritySigningUnavailableError } from '../authority-authenticity/errors.js';
import type { AuthorityArtifactSigner } from '../authority-authenticity/signer.js';
import { createAuthorityArtifactVerifier } from '../authority-authenticity/verifier.js';
import { createSqliteApprovalStore } from '../approval-authority/index.js';
import { createSqliteBoundedGrantStore } from '../bounded-grant-store/index.js';
import { getInternalEnterpriseConfiguration } from '../composition/composition-root.js';
import { bootEnterpriseHost } from '../host/enterprise-host.js';
import { isEnterpriseHostConfigurationError } from '../host/host-configuration.js';
import { createSqliteObligationDischargeStore, type ObligationDischargeRecordInput } from '../obligation-discharge/index.js';
import { ADMIN, DEPLOY, ORG, PRODUCTION, Workspace, boot, call, createContextTable, govern, nextKey, provision, secureEnv, settle, type Booted, type Reply } from './core04-host-fixture.js';
import { APPROVER_A, APPROVER_B, LARGE, approvalPolicy, approvals, approvalsFile, as, commandFor, describe as describeApproval, payablesWorld, provisionApprovers } from './core05-host-fixture.js';
import { SIGNER_TOKEN, externalCustodyEnv, signerKeyDirectory, spawnReferenceSigner, withoutSoftwareCustody, type SpawnedSigner } from './core02-external-signer-fixture.js';

/**
 * CORE-02 — external key custody on the **canonical shipped Host**
 * (`bootEnterpriseHost()`, `production` secure profile, SQLite everywhere, a
 * real loopback listener), with the authority signer in a **separate process**:
 * `scripts/run-reference-authority-signer.mjs`, launched with its own
 * environment and its own key file.
 *
 * What makes this a custody proof rather than a claim: the signer generates its
 * key into a file this test process never reads — the test reads only the
 * public half the signer writes beside it (`<file>.pub`), which is the
 * out-of-band step an operator takes to install trust. The Host is given an
 * endpoint, a credential, the pinned key id and public verification material,
 * and nothing else; the assertions below inspect the environment, the process
 * environment and the Host's full internal configuration for key material.
 */

const workspace = new Workspace();
const keys = signerKeyDirectory();
const WRITER = { system: true, actorId: 'operator:change-board-integration' } as const;
const signers: SpawnedSigner[] = [];
after(async () => {
  await workspace.cleanup();
  for (const signer of signers) await signer.kill();
  keys.cleanup();
});

const KEY_ID = 'frontera-core02-external-key-1';
let signer: SpawnedSigner;
let trusted: { keyId: string; algorithm: string; publicKeyPem: string }[];

before(async () => {
  signer = await spawn(join(keys.dir, 'authority-key.pem'), KEY_ID);
  trusted = [{ keyId: KEY_ID, algorithm: 'ed25519-v1', publicKeyPem: signer.publicKeyPem }];
});

async function spawn(keyFile: string, keyId: string, port?: number): Promise<SpawnedSigner> {
  const spawned = await spawnReferenceSigner({ keyFile, keyId, ...(port !== undefined ? { port } : {}) });
  signers.push(spawned);
  return spawned;
}

function externalEnv(dir: string, extra: Record<string, string> = {}): Record<string, string | undefined> {
  return { ...withoutSoftwareCustody(secureEnv(dir, approvalsFile())), ...externalCustodyEnv({ endpoint: signer.endpoint, keyId: KEY_ID }, trusted), ...extra };
}

async function bootExternal(dir: string): Promise<Booted & { context: ReturnType<typeof createContextTable> }> {
  const context = createContextTable();
  const booted = await boot(workspace, externalEnv(dir), { context, policy: approvalPolicy() });
  return { ...booted, context };
}

function count(dir: string, file: string, table: string): number {
  const db = new Database(join(dir, file), { readonly: true });
  try {
    return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  } finally {
    db.close();
  }
}

let observed = Date.now() - 3_600_000;
function discharge(reply: Reply): ObligationDischargeRecordInput {
  observed += 1000;
  return { correlation: { requestId: reply.body['requestId'] as string, action: DEPLOY, resourceScope: PRODUCTION }, obligationType: 'change.approval', sourceId: 'change-approvals', outcome: 'discharged', observedAt: new Date(observed).toISOString() };
}

const deploy = () => ({ action: DEPLOY, resource: PRODUCTION, parameters: { releaseVersion: `release-${nextKey('v')}` } });

async function grantIdOf(baseUrl: string, reply: Reply): Promise<string> {
  const lookup = await call(baseUrl, 'GET', `/api/admin/authority/executions/${encodeURIComponent(reply.body['executionId'] as string)}`, { authorization: ADMIN });
  assert.equal(lookup.status, 200, lookup.text);
  return lookup.body['grantId'] as string;
}

/** The canonical bootstrap without listening — for the refusals, which must happen before any socket exists. */
function bootRaw(env: Record<string, string | undefined>) {
  return bootEnterpriseHost({
    env,
    executionAdapters: [{ adapterId: 'test.recording', execute: async () => ({ outcome: 'completed', providerRef: 'never' }) }],
    contextProvider: createContextTable().provider,
    policyPackProvider: approvalPolicy(),
  });
}

const grantPath = (grantId: string) => `/api/admin/authority/grants/${encodeURIComponent(grantId)}`;
const PRIVATE_KEY = /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/;

describe('CORE-02 — the canonical Host runs all five authority operations with no authority private key in its process', () => {
  const dir = workspace.dir();
  let host: Booted & { context: ReturnType<typeof createContextTable> };
  let grantId: string;

  it('boots in external mode with NO private key anywhere it can see — environment, process environment, full internal configuration', async () => {
    const env = externalEnv(dir);
    assert.equal(env.AOC_ENTERPRISE_AUTHORITY_SIGNING_KEY_PEM, undefined);
    for (const [name, value] of Object.entries(env)) assert.equal(PRIVATE_KEY.test(value ?? ''), false, `${name} carries no private key`);
    assert.equal(process.env.AOC_ENTERPRISE_AUTHORITY_SIGNING_KEY_PEM, undefined, 'nor does this process');
    for (const [name, value] of Object.entries(process.env)) assert.equal(PRIVATE_KEY.test(value ?? ''), false, `process.env.${name}`);

    host = await bootExternal(dir);
    assert.equal(host.host.posture.authoritySigner, 'external');
    assert.equal(host.host.posture.authorityStore, 'authenticated-durable');
    const internal = getInternalEnterpriseConfiguration(host.host.enterprise);
    assert.equal(internal.authorityAuthenticity.mode, 'external');
    assert.equal(PRIVATE_KEY.test(JSON.stringify(internal)), false, 'the Host’s full configuration holds no private key');
    assert.equal('signingKeyPem' in internal.authorityAuthenticity, false);
    const health = await call(host.baseUrl, 'GET', '/health');
    assert.equal(health.body['status'], 'healthy', health.text);
    assert.deepEqual((health.body['authoritySigner'] as Record<string, unknown>)['custody'], 'external');
    assert.equal(health.text.includes(SIGNER_TOKEN) || PRIVATE_KEY.test(health.text), false);
    // Genesis of every store this Host opened was signed across the boundary — and nothing else yet.
    assert.deepEqual(await signer.counts(), { signGrant: 0, signRevocation: 0, signRevocationState: 1, signObligationDischargeState: 1, signApprovalState: 1 });
    await provision(host.host);
    await provisionApprovers(host.host);
  });

  it('issue → revoke → discharge → approve: every operation crosses the boundary exactly as often as it must', async () => {
    // A. Issuance: one grant, one external signature.
    host.context.set(payablesWorld(500));
    const executed = await govern(host.baseUrl, settle(500));
    assert.equal(executed.body['status'], 'executed', executed.text);
    assert.equal(host.calls.length, 1);
    grantId = await grantIdOf(host.baseUrl, executed);
    let counts = await signer.counts();
    assert.equal(counts['signGrant'], 1);

    // B. Revocation: the revocation and the successor revocation state.
    const revoked = await call(host.baseUrl, 'POST', `${grantPath(grantId)}/revoke`, { authorization: ADMIN, body: { reason: 'security-incident' } });
    assert.equal(revoked.status, 200, revoked.text);
    assert.equal(revoked.body['outcome'], 'revoked');
    counts = await signer.counts();
    assert.deepEqual([counts['signRevocation'], counts['signRevocationState']], [1, 2]);
    // A duplicate revocation is settled without a signature.
    assert.equal((await call(host.baseUrl, 'POST', `${grantPath(grantId)}/revoke`, { authorization: ADMIN, body: { reason: 'security-incident' } })).body['outcome'], 'already-revoked');
    assert.deepEqual([(await signer.counts())['signRevocation'], (await signer.counts())['signRevocationState']], [1, 2]);

    // C. Obligation discharge state.
    const withheld = await govern(host.baseUrl, deploy());
    assert.equal(withheld.body['status'], 'withheld', withheld.text);
    const recorder = host.host.enterprise.obligationDischarges;
    assert.ok(recorder !== undefined);
    await recorder.record(WRITER, discharge(withheld));
    assert.equal((await signer.counts())['signObligationDischargeState'], 2);

    // D. Approval state: the request, then two distinct approvals, then the resumed grant.
    host.context.set(payablesWorld(LARGE));
    const key = nextKey('core02-approval');
    const awaiting = await govern(host.baseUrl, settle(LARGE), key);
    assert.equal(awaiting.body['withheldBy'], 'approval', awaiting.text);
    const view = await describeApproval(host.host, awaiting);
    await approvals(host.host).approve(as(APPROVER_A), commandFor(view));
    await approvals(host.host).approve(as(APPROVER_B), commandFor(view));
    const resumed = await govern(host.baseUrl, settle(LARGE), key);
    assert.equal(resumed.body['status'], 'executed', resumed.text);
    counts = await signer.counts();
    assert.equal(counts['signApprovalState'], 1 + 1 + 3, 'genesis + the deployment\u2019s approval request (C) + this request + two approvals');
    assert.equal(counts['signGrant'], 2, 'the resumed grant');
  });

  it('every persisted authority artifact verifies locally, from public key material alone', async () => {
    await host.host.close();
    const verifier = createAuthorityArtifactVerifier(trusted.map((entry) => ({ ...entry, algorithm: 'ed25519-v1' as const })));
    // A signer that refuses every call: opening and reading must need none.
    const refuse = (): Promise<never> => Promise.reject(new AuthoritySigningUnavailableError('this reader holds no signer'));
    const noSigner: AuthorityArtifactSigner = { activeKeyId: KEY_ID, algorithm: 'ed25519-v1', signGrant: refuse, signRevocation: refuse, signRevocationState: refuse, signObligationDischargeState: refuse, signApprovalState: refuse };
    const authenticity = { signer: noSigner, verifier };
    const grants = await createSqliteBoundedGrantStore(join(dir, 'bounded-grants.sqlite'), { authenticity });
    const db = new Database(join(dir, 'bounded-grants.sqlite'), { readonly: true });
    const ids = (db.prepare('SELECT grant_id FROM bounded_grants').all() as { grant_id: string }[]).map((row) => row.grant_id);
    db.close();
    assert.equal(ids.length, 2);
    for (const id of ids) assert.equal((await grants.read(id)).grant?.id, id);
    assert.equal((await grants.read(grantId)).revocation?.grantId, grantId, 'the revocation and the revocation state verify');
    await grants.close();
    const discharges = await createSqliteObligationDischargeStore(join(dir, 'obligation-discharges.sqlite'), { now: () => new Date().toISOString(), organizationId: ORG, authenticity });
    await discharges.close();
    const approvalStore = await createSqliteApprovalStore(join(dir, 'approvals.sqlite'), { now: () => new Date().toISOString(), organizationId: ORG, authenticity });
    assert.equal((await approvalStore.read(ORG)).length, 4);
    await approvalStore.close();
  });
});

describe('CORE-02 / AA-004 — signer outage: reads continue, every mutation fails honestly and writes nothing; recovery commits exactly once', () => {
  const dir = workspace.dir();
  let host: Booted & { context: ReturnType<typeof createContextTable> };
  let grantId: string;
  let withheldDeploy: Reply;
  let approvalCommand: ReturnType<typeof commandFor>;

  it('setup: a live grant, a withheld deployment and an open approval request', async () => {
    host = await bootExternal(dir);
    await provision(host.host);
    await provisionApprovers(host.host);
    host.context.set(payablesWorld(500));
    const executed = await govern(host.baseUrl, settle(500));
    assert.equal(executed.body['status'], 'executed', executed.text);
    grantId = await grantIdOf(host.baseUrl, executed);
    withheldDeploy = await govern(host.baseUrl, deploy());
    host.context.set(payablesWorld(LARGE));
    const awaiting = await govern(host.baseUrl, settle(LARGE), 'core02-outage-approval');
    approvalCommand = commandFor(await describeApproval(host.host, awaiting));
  });

  it('the signer dies: /health degrades (never unhealthy), existing authority still reads and verifies', async () => {
    await signer.kill();
    const health = await call(host.baseUrl, 'GET', '/health');
    assert.equal(health.body['status'], 'degraded', health.text);
    assert.deepEqual(health.body['authoritySigner'], {
      custody: 'external',
      keyId: KEY_ID,
      algorithm: 'ed25519-v1',
      state: 'unavailable',
      reason: 'EXTERNAL_SIGNER_UNREACHABLE',
      identity: { state: 'unavailable', reason: 'EXTERNAL_SIGNER_UNREACHABLE' },
      lastSigning: { state: 'ready' },
      signing: (health.body['authoritySigner'] as Record<string, unknown>)['signing'],
    });
    const inspected = await call(host.baseUrl, 'GET', grantPath(grantId), { authorization: ADMIN });
    assert.equal(inspected.status, 200, inspected.text);
    assert.equal(inspected.body['revocation'] ?? null, null, 'not revoked');
    assert.equal(host.host.enterprise.isReady(), true);
    const ready = await call(host.baseUrl, 'GET', '/ready');
    assert.equal(ready.status, 200, `a signer outage is not unreadiness: ${ready.text}`);
    assert.equal(ready.body['status'], 'degraded');
  });

  it('revocation fails honestly: 503 AUTHORITY_SIGNER_UNAVAILABLE, recorded: false, no row, no head change — the grant stays exercisable and the operator is told so', async () => {
    const before = count(dir, 'bounded-grants.sqlite', 'bounded_grant_revocations');
    const reply = await call(host.baseUrl, 'POST', `${grantPath(grantId)}/revoke`, { authorization: ADMIN, body: { reason: 'security-incident' } });
    assert.equal(reply.status, 503, reply.text);
    const error = reply.body['error'] as Record<string, unknown>;
    assert.equal(error['code'], 'AUTHORITY_SIGNER_UNAVAILABLE');
    assert.equal(error['failure'], 'EXTERNAL_SIGNER_UNREACHABLE');
    assert.equal(error['recorded'], false);
    assert.match(String(error['message']), /nothing was recorded/);
    assert.match(String(error['message']), /remains exercisable/);
    assert.equal(reply.text.includes(SIGNER_TOKEN), false);
    assert.equal(count(dir, 'bounded-grants.sqlite', 'bounded_grant_revocations'), before);
    const db = new Database(join(dir, 'bounded-grants.sqlite'), { readonly: true });
    assert.equal((db.prepare('SELECT sequence FROM bounded_grant_revocation_state').get() as { sequence: number }).sequence, 0);
    db.close();
    assert.equal((await call(host.baseUrl, 'GET', grantPath(grantId), { authorization: ADMIN })).body['revocation'] ?? null, null, 'still not revoked');
  });

  it('issuance, discharge and approval all fail without writing; nothing appears accepted', async () => {
    const grantsBefore = count(dir, 'bounded-grants.sqlite', 'bounded_grants');
    host.context.set(payablesWorld(700));
    const refused = await govern(host.baseUrl, settle(700));
    assert.notEqual(refused.body['status'], 'executed', refused.text);
    assert.equal(host.calls.length, 1, 'no adapter call');
    assert.equal(count(dir, 'bounded-grants.sqlite', 'bounded_grants'), grantsBefore, 'no unsigned grant');

    const dischargesBefore = count(dir, 'obligation-discharges.sqlite', 'obligation_discharges');
    await assert.rejects(() => host.host.enterprise.obligationDischarges!.record(WRITER, discharge(withheldDeploy)), (error: unknown) => error instanceof AuthoritySigningUnavailableError);
    assert.equal(count(dir, 'obligation-discharges.sqlite', 'obligation_discharges'), dischargesBefore);

    const approvalsBefore = count(dir, 'approvals.sqlite', 'approval_records');
    await assert.rejects(() => approvals(host.host).approve(as(APPROVER_A), approvalCommand), (error: unknown) => error instanceof AuthoritySigningUnavailableError);
    assert.equal(count(dir, 'approvals.sqlite', 'approval_records'), approvalsBefore);
  });

  it('the one control that does not depend on the signer still works: an emergency stop is recorded during the outage', async () => {
    const activated = await call(host.baseUrl, 'POST', '/api/admin/emergency-controls/activate', { authorization: ADMIN, body: { scope: 'global' } });
    assert.equal(activated.status, 200, activated.text);
    assert.deepEqual(activated.body['active'], [{ scope: 'global' }]);
  });

  it('the signer returns (same key, same port): the stop still withholds, the revocation commits, discharge and approval proceed, nothing is duplicated', async () => {
    signer = await spawn(signer.keyFile, KEY_ID, signer.port);
    host.context.set(payablesWorld(800));
    const stopped = await govern(host.baseUrl, settle(800));
    assert.equal(stopped.body['withheldBy'], 'emergency-control', stopped.text);
    assert.equal(host.calls.length, 1, 'withheld by the stop, adapter 0');
    assert.equal((await call(host.baseUrl, 'POST', '/api/admin/emergency-controls/release', { authorization: ADMIN, body: { scope: 'global' } })).status, 200);

    const revoked = await call(host.baseUrl, 'POST', `${grantPath(grantId)}/revoke`, { authorization: ADMIN, body: { reason: 'security-incident' } });
    assert.equal(revoked.status, 200, revoked.text);
    assert.equal(revoked.body['outcome'], 'revoked');
    assert.equal(count(dir, 'bounded-grants.sqlite', 'bounded_grant_revocations'), 1);
    await host.host.enterprise.obligationDischarges!.record(WRITER, discharge(withheldDeploy));
    await approvals(host.host).approve(as(APPROVER_A), approvalCommand);
    assert.equal((await call(host.baseUrl, 'GET', '/health')).body['status'], 'healthy');
    assert.deepEqual(await signer.counts(), { signGrant: 0, signRevocation: 1, signRevocationState: 1, signObligationDischargeState: 1, signApprovalState: 1 }, 'the restarted signer signed exactly the recovered mutations, once each (the stopped action was never issued)');
  });

  it('restart: with the signer up, the Host boots and reads its verified state; with the signer down, it refuses to start (identity cannot be proven) — it never runs on a guess', async () => {
    await host.host.close();
    const again = await bootExternal(dir);
    const inspected = await call(again.baseUrl, 'GET', grantPath(grantId), { authorization: ADMIN });
    assert.equal((inspected.body['revocation'] as Record<string, unknown> | undefined)?.['reason'], 'security-incident', inspected.text);
    await again.host.close();

    await signer.kill();
    await assert.rejects(
      () => bootRaw(externalEnv(dir)),
      (error: unknown) => error instanceof AuthorityAuthenticityConfigurationError && error.reason === 'EXTERNAL_SIGNER_UNREACHABLE',
    );
    signer = await spawn(signer.keyFile, KEY_ID, signer.port);
  });
});

describe('CORE-02 — the canonical Host refuses every custody it cannot prove, before listen', () => {
  it('a private key alongside external custody is refused, not ignored', async () => {
    const dir = workspace.dir();
    const { privateKeyPem } = await import('./authority-authenticity-fixture.js').then((fixture) => fixture.AUTHORITY_KEY_A);
    await assert.rejects(
      () => bootRaw(externalEnv(dir, { AOC_ENTERPRISE_AUTHORITY_SIGNING_KEY_PEM: privateKeyPem })),
      (error: unknown) => isEnterpriseHostConfigurationError(error) && error.code === 'HOST_ENVIRONMENT_INVALID' && /must not be set/.test(error.message),
    );
  });

  it('endpoint substitution (the endpoint serves another key) and verification-registry substitution are refused at startup', async () => {
    const other = await spawn(join(keys.dir, 'other-key.pem'), 'frontera-core02-other-key');
    const dir = workspace.dir();
    const substitutedEndpoint = { ...externalEnv(dir), AOC_ENTERPRISE_AUTHORITY_SIGNER_ENDPOINT: other.endpoint };
    await assert.rejects(() => bootRaw(substitutedEndpoint), (error: unknown) => error instanceof AuthorityAuthenticityConfigurationError && error.reason === 'EXTERNAL_SIGNER_IDENTITY_MISMATCH');
    // The right endpoint, but the trusted registry holds the other key's public material under this key id.
    const substitutedRegistry = { ...externalEnv(dir), AOC_ENTERPRISE_AUTHORITY_VERIFICATION_KEYS: JSON.stringify([{ keyId: KEY_ID, algorithm: 'ed25519-v1', publicKeyPem: other.publicKeyPem }]) };
    await assert.rejects(() => bootRaw(substitutedRegistry), (error: unknown) => error instanceof AuthorityAuthenticityConfigurationError && error.reason === 'EXTERNAL_SIGNER_IDENTITY_MISMATCH');
    // A wrong credential is an authentication failure, never "key not found" or "invalid signature".
    const wrongToken = { ...externalEnv(dir), AOC_ENTERPRISE_AUTHORITY_SIGNER_TOKEN: 'WRONG_TOKEN_SENTINEL_00000000000000000000' };
    await assert.rejects(() => bootRaw(wrongToken), (error: unknown) => error instanceof AuthorityAuthenticityConfigurationError && error.reason === 'EXTERNAL_SIGNER_AUTHENTICATION_FAILED' && !error.message.includes('WRONG_TOKEN_SENTINEL'));
    await other.kill();
  });
});
