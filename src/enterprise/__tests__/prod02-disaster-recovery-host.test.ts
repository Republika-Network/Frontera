import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import Database from 'better-sqlite3';

import { createSqliteExecutionResolutionStore } from '../execution-resolution-store/index.js';
import { witnessRows } from './core07-freshness-fixture.js';
import {
  ACCOUNT,
  EDGE,
  EVIDENCE_HASH,
  FROZEN,
  LEGACY,
  OBLIGATION,
  OFFBOARDED,
  ORG,
  PAYABLES,
  PROD,
  RELEASE,
  RESTART,
  STAGING,
  TRANSFER,
  WITHDRAWN,
  CEILING,
  DEPLOY,
  LIFETIME_LIMIT,
  MAINTAIN,
  approvalCommand,
  approvalFor,
  approverStanding,
  authFor,
  backupCli,
  bootProd02,
  bootstrap,
  createDeployment,
  filesUnder,
  govern,
  grantOf,
  key,
  maintain,
  onboard,
  portability,
  profiles,
  readManifest,
  release,
  restart,
  secretsFound,
  transfer,
  transition,
  type BootedProd02,
  type Custody,
  type Deployment,
} from './prod02-recovery-fixture.js';
import { call, expectStatus, type Reply } from './ctrl02-host-fixture.js';

/**
 * PROD-02 — the official exit proof: "a clean-room drill restores exercisable
 * grants, revocations, ledgers and trace".
 *
 * One production-shaped deployment on the shipped Host (`bootEnterpriseHost`,
 * `production` profile, every composable store on SQLite, Ed25519 authority
 * under software **and** external custody, a separate-process CORE-07
 * witness) accumulates meaningful state through its public APIs; the Host is
 * stopped; a cold `backup:v1` is taken; the data directory is **destroyed**;
 * `restore:v1` rebuilds a fresh directory from the backup alone; secrets and
 * key material come from outside the backup; the witness is the surviving one,
 * never restored; and the real secure Host boots on the restored data. Then
 * every security property is asserted by *behaviour* — decisions, refusals and
 * provider-adapter call counts — not by row counts.
 */

const deployments: Deployment[] = [];
const hosts: BootedProd02[] = [];
after(async () => {
  for (const booted of hosts) await booted.host.close().catch(() => {});
  for (const deployment of deployments) await deployment.close().catch(() => {});
});

async function boot(env: Record<string, string | undefined>): Promise<BootedProd02> {
  const booted = await bootProd02(env);
  hosts.push(booted);
  return booted;
}

const status = (reply: Reply): unknown => reply.body['status'];

/** How the Host refused a request: HTTP status and error code. A refusal is never an execution. */
function refusal(reply: Reply): { readonly httpStatus: number; readonly code: unknown } {
  assert.notEqual(reply.body['status'], 'executed', reply.text);
  assert.ok(reply.status >= 400, reply.text);
  return { httpStatus: reply.status, code: (reply.body['error'] as Record<string, unknown> | undefined)?.['code'] };
}

function eventDigests(dataDir: string): string[] {
  const db = new Database(join(dataDir, 'authority-event-stream.sqlite'), { readonly: true });
  try {
    return (db.prepare('SELECT event_digest FROM authority_events ORDER BY stream_id, sequence').all() as { event_digest: string }[]).map((row) => row.event_digest);
  } finally {
    db.close();
  }
}

/** Everything the deployment holds before the disaster, recorded so the restored deployment can be compared by behaviour. */
interface PreState {
  readonly payables: string;
  readonly rotatedOut: string;
  readonly offboarded: string;
  readonly withdrawn: string;
  readonly withdrawnRefusal: { readonly httpStatus: number; readonly code: unknown };
  readonly release: string;
  readonly t1: { readonly key: string; readonly executionId: string; readonly requestId: string; readonly grantId: string };
  readonly liveGrant: string;
  readonly revokedGrant: string;
  readonly approved: { readonly key: string; readonly approvalRequestId: string; readonly approvalDigest: string };
  readonly rejected: { readonly key: string; readonly approvalRequestId: string };
  readonly pending: { readonly key: string; readonly approvalRequestId: string };
  readonly revokedApproval: { readonly key: string; readonly approvalRequestId: string };
  readonly discharged: { readonly key: string };
  readonly undischarged: { readonly key: string };
  readonly profileStates: readonly string[];
  readonly emergencyActive: unknown;
  readonly adapterCalls: number;
  readonly eventDigests: readonly string[];
  readonly resolution: { readonly executionId: string; readonly bindingDigest: string; readonly resolutionDigest: string };
}

async function accumulateState(deployment: Deployment, dataDir: string): Promise<PreState> {
  const auth = authFor(deployment.secrets);
  const h1 = await boot(deployment.envFor(dataDir));
  const { baseUrl } = h1;
  assert.equal(h1.host.posture.authorityFreshness, 'external');

  // Kernel Authority world + CTRL-02 profile lifecycle.
  await bootstrap(baseUrl, auth);
  for (const profileId of ['release-production', 'release-legacy', 'edge-maintenance']) await transition(baseUrl, auth, profileId, 'activate');
  await transition(baseUrl, auth, 'release-legacy', 'retire');
  await approverStanding(baseUrl, auth, 'approver-a');
  await approverStanding(baseUrl, auth, 'approver-b');

  // Agents and their credentials (CTRL-02): one rotated, one revoked credential, one withdrawn actor.
  const payablesInitial = await onboard(baseUrl, auth, {
    agentId: PAYABLES,
    subjectId: 'payables-1',
    actions: [TRANSFER],
    resources: [ACCOUNT, FROZEN],
    constraints: [
      { type: 'max_amount', currency: 'USD', value: CEILING },
      { type: 'spending_limit', limitId: 'payables-lifetime', currency: 'USD', maximum: LIFETIME_LIMIT, window: { kind: 'lifetime' } },
    ],
  });
  const rotated = expectStatus(
    await call(baseUrl, 'POST', `/api/admin/agents/${PAYABLES}/credentials/${payablesInitial.credentialId}/rotate`, { authorization: auth.provisioner, body: { idempotencyKey: 'prod02-rotate-1' } }),
    200,
    'rotate',
  );
  const payables = rotated.body['bearerCredential'] as string;
  const releaseAgent = await onboard(baseUrl, auth, { agentId: RELEASE, subjectId: 'release-1', actions: [DEPLOY, MAINTAIN, RESTART], resources: [PROD, LEGACY, EDGE, STAGING] });
  const offboarded = await onboard(baseUrl, auth, { agentId: OFFBOARDED, subjectId: 'offboarded-1', actions: [RESTART], resources: [STAGING] });
  expectStatus(await call(baseUrl, 'POST', `/api/admin/agents/${OFFBOARDED}/credentials/${offboarded.credentialId}/revoke`, { authorization: auth.responder, body: { reason: 'offboarded' } }), 200, 'revoke credential');
  const withdrawn = await onboard(baseUrl, auth, { agentId: WITHDRAWN, subjectId: 'withdrawn-1', actions: [RESTART], resources: [STAGING] });
  expectStatus(await call(baseUrl, 'POST', `/api/admin/authority/entities/actor/${WITHDRAWN}/revoke`, { authorization: auth.responder, body: { reason: 'offboarded' } }), 200, 'revoke actor');

  // Before the backup, every one of those is in force.
  assert.equal((await govern(baseUrl, offboarded.credential, restart(key('off')))).status, 401, 'a revoked credential is not admitted');
  assert.equal((await govern(baseUrl, payablesInitial.credential, transfer('1', key('rot')))).status, 401, 'a rotated-out credential is dead');
  // Offboarding by actor revocation: every credential bound to the actor stops admitting it.
  const withdrawnRefusal = refusal(await govern(baseUrl, withdrawn.credential, restart(key('wd'))));

  // P7/P10 exercise ledger: 500 of 800 consumed.
  const t1Key = key('t1');
  const t1 = await govern(baseUrl, payables, transfer('500', t1Key));
  assert.equal(status(t1), 'executed', t1.text);
  // The durable P11 outcome names the grant the execution ran under.
  const t1GrantId = await grantOf(baseUrl, auth, t1);

  // Bounded grants: one left live, one revoked by an operator.
  const x1 = await govern(baseUrl, releaseAgent.credential, restart(key('x1')));
  assert.equal(status(x1), 'executed', x1.text);
  const liveGrant = await grantOf(baseUrl, auth, x1);
  const x2 = await govern(baseUrl, releaseAgent.credential, restart(key('x2')));
  assert.equal(status(x2), 'executed', x2.text);
  const revokedGrant = await grantOf(baseUrl, auth, x2);
  expectStatus(await call(baseUrl, 'POST', `/api/admin/authority/grants/${encodeURIComponent(revokedGrant)}/revoke`, { authorization: auth.responder, body: { reason: 'security-incident' } }), 200, 'revoke grant');

  // CORE-05 approvals: approved (with evidence), rejected, pending, approved-then-revoked.
  const approvedKey = key('a1');
  const a1 = await govern(baseUrl, releaseAgent.credential, release(PROD, approvedKey));
  assert.equal(a1.body['withheldBy'], 'approval', a1.text);
  const a1View = await approvalFor(baseUrl, auth, a1.body['requestId'] as string);
  const a1Approved = await approvalCommand(baseUrl, auth.approverA, a1View, 'approve', { evidence: [{ type: 'source_document', hash: EVIDENCE_HASH }] });
  assert.equal(a1Approved.status, 200, a1Approved.text);
  const rejectedKey = key('a2');
  const a2 = await govern(baseUrl, releaseAgent.credential, release(PROD, rejectedKey));
  const a2View = await approvalFor(baseUrl, auth, a2.body['requestId'] as string);
  assert.equal((await approvalCommand(baseUrl, auth.approverA, a2View, 'reject', { reason: 'not this window' })).status, 200);
  const pendingKey = key('a3');
  const a3 = await govern(baseUrl, releaseAgent.credential, release(PROD, pendingKey));
  const a3View = await approvalFor(baseUrl, auth, a3.body['requestId'] as string);
  const revokedKey = key('a4');
  const a4 = await govern(baseUrl, releaseAgent.credential, release(PROD, revokedKey));
  const a4View = await approvalFor(baseUrl, auth, a4.body['requestId'] as string);
  assert.equal((await approvalCommand(baseUrl, auth.approverA, a4View, 'approve', { evidence: [{ type: 'source_document', hash: EVIDENCE_HASH }] })).status, 200);
  assert.equal((await approvalCommand(baseUrl, auth.approverB, await approvalFor(baseUrl, auth, a4.body['requestId'] as string), 'revoke', { reason: 'window closed' })).status, 200);

  // CORE-04 obligations: one discharged by the configured independent source (not yet resumed), one not.
  const dischargedKey = key('m1');
  const m1 = await govern(baseUrl, releaseAgent.credential, maintain(dischargedKey));
  assert.equal(m1.body['withheldBy'], 'obligations', m1.text);
  const discharges = h1.host.enterprise.obligationDischarges;
  assert.ok(discharges !== undefined);
  await discharges.record(
    { system: true, actorId: 'operator:change-board-integration' },
    { correlation: { requestId: m1.body['requestId'] as string, action: MAINTAIN, resourceScope: EDGE }, obligationType: OBLIGATION, sourceId: 'change-approvals', outcome: 'discharged', observedAt: new Date(Date.now() - 60_000).toISOString(), reference: 'CAB-1' },
  );
  const undischargedKey = key('m2');
  assert.equal((await govern(baseUrl, releaseAgent.credential, maintain(undischargedKey))).body['withheldBy'], 'obligations');

  // Emergency control: one stop active, one declared and released.
  expectStatus(await call(baseUrl, 'POST', '/api/admin/emergency-controls/activate', { authorization: auth.responder, body: { scope: 'resource', value: FROZEN } }), 200, 'stop');
  expectStatus(await call(baseUrl, 'POST', '/api/admin/emergency-controls/activate', { authorization: auth.administrator, body: { scope: 'actor', value: 'actor-prod02-ghost' } }), 200, 'stop ghost');
  expectStatus(await call(baseUrl, 'POST', '/api/admin/emergency-controls/release', { authorization: auth.administrator, body: { scope: 'actor', value: 'actor-prod02-ghost' } }), 200, 'release ghost');
  assert.equal((await govern(baseUrl, payables, transfer('1', key('frozen'), FROZEN))).body['withheldBy'], 'emergency-control');

  const profileStates = (await profiles(baseUrl, auth)).map((view) => `${String(view['profileId'])}@${String(view['version'])}:${String(view['state'])}`).sort();
  const emergencyActive = expectStatus(await call(baseUrl, 'GET', '/api/admin/emergency-controls', { authorization: auth.observer }), 200, 'controls').body['active'];
  const approvedDetail = await approvalFor(baseUrl, auth, a1.body['requestId'] as string);
  const adapterCalls = h1.adapter.calls.length;
  await h1.host.close();

  // P12 (embedder-composed): a binding and an immutable resolution, written through the store's own factory.
  const resolutions = await createSqliteExecutionResolutionStore(join(dataDir, 'execution-resolutions.sqlite'), { now: () => new Date().toISOString() });
  const attemptDigest = `sha256:${'4d'.repeat(32)}`;
  const bound = await resolutions.bind({ organizationId: ORG }, { organizationId: ORG, executionId: 'aoc.exec:prod02-p12', attemptDigest, authorityId: 'resolver-prod02', origin: 'pre-claim', boundAt: new Date().toISOString() });
  const resolved = await resolutions.recordResolution(
    { organizationId: ORG },
    { organizationId: ORG, executionId: 'aoc.exec:prod02-p12', attemptDigest, bindingDigest: bound.binding.bindingDigest, authorityId: 'resolver-prod02', certainty: 'confirmed-not-completed', failure: 'PROVIDER_REJECTED', resolvedAt: new Date().toISOString() },
  );
  await resolutions.close();

  return {
    payables,
    rotatedOut: payablesInitial.credential,
    offboarded: offboarded.credential,
    withdrawn: withdrawn.credential,
    withdrawnRefusal,
    release: releaseAgent.credential,
    t1: { key: t1Key, executionId: t1.body['executionId'] as string, requestId: t1.body['requestId'] as string, grantId: t1GrantId },
    liveGrant,
    revokedGrant,
    approved: { key: approvedKey, approvalRequestId: a1View['approvalRequestId'] as string, approvalDigest: (approvedDetail as Record<string, unknown>)['approvalDigest'] as string },
    rejected: { key: rejectedKey, approvalRequestId: a2View['approvalRequestId'] as string },
    pending: { key: pendingKey, approvalRequestId: a3View['approvalRequestId'] as string },
    revokedApproval: { key: revokedKey, approvalRequestId: a4View['approvalRequestId'] as string },
    discharged: { key: dischargedKey },
    undischarged: { key: undischargedKey },
    profileStates,
    emergencyActive,
    adapterCalls,
    eventDigests: eventDigests(dataDir),
    resolution: { executionId: 'aoc.exec:prod02-p12', bindingDigest: bound.binding.bindingDigest, resolutionDigest: resolved.resolution.resolutionDigest },
  };
}

for (const custody of ['software', 'external'] as const satisfies readonly Custody[]) {
  describe(`PROD-02 clean-room disaster recovery — ${custody} authority custody`, () => {
    it('stop → cold backup → destroy → restore into a fresh directory → secure Host boots on the surviving witness → every security property holds by behaviour', async () => {
      const startedAt = Date.now();
      const deployment = await createDeployment(custody);
      deployments.push(deployment);
      const { registry, runRestore } = await portability();
      const auth = authFor(deployment.secrets);
      const original = deployment.dir('data-original');
      const pre = await accumulateState(deployment, original);

      // ── cold backup, by the CLI, exactly as an operator runs it ──────────────────
      const backupDir = deployment.dir('backup');
      const cli = backupCli(deployment.envFor(original), backupDir, ['--cold']);
      assert.equal(cli.status, 0, cli.stderr);
      const manifest = readManifest(backupDir);
      assert.ok(manifest.coverage !== undefined);
      assert.equal(manifest.backupFormat, 'aoc.enterprise.backup.v1');
      assert.equal(manifest.coverage.coverageModel, registry.COVERAGE_MODEL);
      assert.equal(manifest.coverage.complete, true);
      assert.equal(manifest.consistency.mode, 'cold-attested');
      assert.equal(manifest.consistency.toolVerifiedHostStopped, false, 'the tool never claims to have proven the Host stopped');
      // Every store the shipped Host composes, plus the embedder's P12 store because its file exists.
      assert.deepEqual(
        manifest.stores.map((store) => store.name),
        registry.STORE_DEFINITIONS.map((storeDef) => storeDef.name),
        'every registry store is in the backup (thirteen at PROD-02; fourteen since ASSURE-01 added the Evidence Bundle Store)',
      );
      assert.deepEqual(
        manifest.coverage.stores.filter((store) => store.required).map((store) => store.name).sort(),
        registry.STORE_DEFINITIONS.filter((storeDef) => storeDef.name !== 'execution-resolutions').map((storeDef) => storeDef.name).sort(),
        'every store but P12 is required by this deployment (twelve at PROD-02, thirteen since ASSURE-01); P12 is present but never required from configuration',
      );

      // ── no secret value, no private key, no witness state in any byte of the backup ──
      assert.deepEqual(secretsFound(backupDir, deployment.secretValues(), [cli.stdout, cli.stderr]), [], 'no canary appears anywhere in the backup set or the CLI output');
      assert.equal(manifest.authority.signer.privateKeyIncluded, false);
      assert.equal(manifest.authority.freshness.witnessStateIncluded, false);
      assert.equal(manifest.authority.freshness.witnessId, 'witness-prod02');
      assert.equal(manifest.authority.signer.mode, custody);
      for (const file of filesUnder(backupDir)) assert.equal(relative(backupDir, file).includes('witness'), false, `no witness file in the backup: ${file}`);
      assert.equal(filesUnder(backupDir).some((file) => readFileSync(file).includes(Buffer.from('witness_bindings'))), false, 'no witness table in any backed-up database');
      // The secret inventory names the variables to restore from the secret manager — names, never values.
      for (const name of ['AOC_ENTERPRISE_API_KEYS', 'AOC_ENTERPRISE_AUTHORITY_FRESHNESS_TOKEN', 'FRONTERA_PROD02_PROVIDER_TOKEN', 'FRONTERA_PROD02_CUSTOMER_KEY', 'FRONTERA_PROD02_APPROVER_A', 'FRONTERA_PROD02_LEGACY_ADMIN']) {
        assert.ok(manifest.configuration.secretEnvironmentVariables.includes(name), name);
      }

      // The restored heads are the heads the surviving witness holds.
      const witnessed = await witnessRows(deployment.witness.databasePath);
      for (const store of manifest.stores) {
        if (store.signedHead === undefined) continue;
        const slot = witnessed.find((row) => row['state_kind'] === store.signedHead?.freshnessStateKind);
        assert.ok(slot !== undefined, `${store.name} is anchored`);
        assert.equal(slot['committed_sequence'], store.signedHead.sequence, `${store.name}: backup head = witness head`);
        assert.equal(slot['committed_digest'], store.signedHead.stateDigest);
        assert.equal(slot['store_id'], store.signedHead.storeId);
      }

      // ── disaster: the data directory is gone ─────────────────────────────────────
      rmSync(original, { recursive: true, force: true });
      assert.equal(existsSync(original), false);

      // ── restore into a truly fresh directory, from the backup alone ────────────────
      const recovered = deployment.dir('data-recovered');
      const recoveredEnv = deployment.envFor(recovered);
      const report = await runRestore({ backup: backupDir, target: recovered, env: recoveredEnv });
      assert.equal(report.status, 'restored');
      assert.equal(report.coverage.complete, true);
      for (const name of ['bounded-grants', 'obligation-discharges', 'approvals']) {
        assert.equal(report.objectVerification[name]?.authenticity, 'verified-under-trusted-keys', `${name}: signed state verifies under the trusted keys after restore`);
      }
      // Restore mapping: each restored file is the one the Host variable names.
      for (const target of report.targets) assert.equal(recoveredEnv[target.envVar], target.path, target.envVar);
      assert.deepEqual(report.notRestored, []);

      // ── the real secure Host on the restored data, the surviving witness, secrets from outside ──
      const h2 = await boot(recoveredEnv);
      const { baseUrl } = h2;
      assert.equal(h2.host.posture.authorityFreshness, 'external');
      assert.equal(h2.host.posture.authorityStore, 'authenticated-durable');
      assert.equal(h2.host.posture.authoritySigner, custody === 'external' ? 'external' : 'software');
      assert.equal((await call(baseUrl, 'GET', '/ready')).status, 200);
      const calls = (): number => h2.adapter.calls.length;

      // Execution outcomes + ledger: the completed transfer, retried with its key, is the recorded result — no provider call.
      const t1Retry = await govern(baseUrl, pre.payables, transfer('500', pre.t1.key));
      assert.equal(status(t1Retry), 'executed', t1Retry.text);
      assert.equal(t1Retry.body['executionId'], pre.t1.executionId, 'the same execution, not a new one');
      assert.equal(calls(), 0, 'restoring state did not make the provider be called again');
      // The durable outcome record itself survived (not merely re-derived elsewhere): same execution, same grant.
      assert.equal(await grantOf(baseUrl, auth, t1Retry), pre.t1.grantId, 'the completed execution\'s P11 outcome is the one recorded before the backup');
      // Ledger: consumption survived — 400 exceeds the 300 left, 300 fits exactly, then nothing is left.
      assert.equal((await govern(baseUrl, pre.payables, transfer('400', key('t3')))).body['status'], 'withheld');
      assert.equal(calls(), 0, 'a limit already consumed did not regain capacity');
      const t4 = await govern(baseUrl, pre.payables, transfer('300', key('t4')));
      assert.equal(status(t4), 'executed', t4.text);
      assert.equal(calls(), 1);
      assert.equal(status(await govern(baseUrl, pre.payables, transfer('1', key('t5')))), 'withheld');
      assert.equal(calls(), 1);

      // Control plane: active credential admits, rotated-out and revoked stay dead.
      assert.equal((await govern(baseUrl, pre.rotatedOut, transfer('1', key('rot2')))).status, 401, 'a rotated-out credential stays dead');
      assert.equal((await govern(baseUrl, pre.offboarded, restart(key('off2')))).status, 401, 'a revoked credential stays revoked');
      // Kernel Authority: authority recognized, revocation kept.
      assert.deepEqual(refusal(await govern(baseUrl, pre.withdrawn, restart(key('wd2')))), pre.withdrawnRefusal, 'a withdrawn actor stays withdrawn');
      const x3 = await govern(baseUrl, pre.release, restart(key('x3')));
      assert.equal(status(x3), 'executed', `the restored authority world recognizes its actors: ${x3.text}`);
      assert.equal(calls(), 2);

      // Bounded grants: the live grant is exercisable; the revoked one stays revoked (authenticated).
      const ace = h2.host.enterprise.authorityControlledExecution;
      assert.ok(ace !== undefined);
      const readGrant = async (grantId: string) => expectStatus(await call(baseUrl, 'GET', `/api/admin/authority/grants/${encodeURIComponent(grantId)}`, { authorization: auth.observer }), 200, 'grant');
      const live = await readGrant(pre.liveGrant);
      assert.equal((live.body['status'] as Record<string, unknown>)['eligibility'], 'exercisable', live.text);
      assert.equal(live.body['revocation'], null);
      const revoked = await readGrant(pre.revokedGrant);
      assert.notEqual((revoked.body['status'] as Record<string, unknown>)['eligibility'], 'exercisable', revoked.text);
      assert.equal((revoked.body['revocation'] as Record<string, unknown>)['reason'], 'security-incident', 'the signed revocation is the one recorded before the backup');
      const exerciseOf = async (grantId: string, executionId: string) => {
        const view = (await readGrant(grantId)).body;
        return ace.exercise({ boundedGrantId: grantId, correlation: view['provenance'] as Parameters<typeof ace.exercise>[0]['correlation'], executionId, subject: view['subject'] as string, action: RESTART, resource: STAGING, organization: ORG });
      };
      assert.equal((await exerciseOf(pre.liveGrant, 'aoc.exec:prod02-live-after-restore')).status, 'executed', 'a valid restored grant is exercisable');
      assert.equal(calls(), 3);
      assert.equal((await exerciseOf(pre.revokedGrant, 'aoc.exec:prod02-revoked-after-restore')).status, 'withheld', 'a grant revoked before the backup stays revoked');
      assert.equal(calls(), 3);

      // Emergency control: the active stop is still active; the released one stays released.
      assert.deepEqual(expectStatus(await call(baseUrl, 'GET', '/api/admin/emergency-controls', { authorization: auth.observer }), 200, 'controls').body['active'], pre.emergencyActive);
      assert.equal((await govern(baseUrl, pre.payables, transfer('1', key('frozen2'), FROZEN))).body['withheldBy'], 'emergency-control', 'restore did not release the stop');
      assert.equal(calls(), 3);

      // Approvals: approved resumes (once); rejected and revoked stay restrictive; pending stays pending; evidence stays bound.
      const approvedDetail = await approvalFor(baseUrl, auth, (await govern(baseUrl, pre.release, release(PROD, pre.approved.key))).body['requestId'] as string);
      assert.equal(calls(), 4, 'the approved, withheld action resumed into exactly one execution');
      assert.equal(approvedDetail['approvalDigest'], pre.approved.approvalDigest, 'the approval is the one given before the backup');
      assert.ok(JSON.stringify(approvedDetail['verdicts']).includes(EVIDENCE_HASH), 'the recorded evidence hash is still bound');
      assert.equal(status(await govern(baseUrl, pre.release, release(PROD, pre.approved.key))), 'executed');
      assert.equal(calls(), 4, 'replay: exactly once');
      const rejected = await govern(baseUrl, pre.release, release(PROD, pre.rejected.key));
      assert.notEqual(status(rejected), 'executed', rejected.text);
      const revokedApproval = await govern(baseUrl, pre.release, release(PROD, pre.revokedApproval.key));
      assert.notEqual(status(revokedApproval), 'executed', revokedApproval.text);
      const pending = await govern(baseUrl, pre.release, release(PROD, pre.pending.key));
      assert.equal(pending.body['withheldBy'], 'approval', pending.text);
      assert.equal((await approvalFor(baseUrl, auth, pending.body['requestId'] as string))['status'], 'pending');
      assert.equal(calls(), 4);

      // Obligations: the discharge survived and releases; the undischarged one still withholds.
      assert.equal(status(await govern(baseUrl, pre.release, maintain(pre.discharged.key))), 'executed');
      assert.equal(calls(), 5);
      assert.equal((await govern(baseUrl, pre.release, maintain(pre.undischarged.key))).body['withheldBy'], 'obligations');
      assert.equal(calls(), 5);

      // Profile lifecycle: unchanged; the retired profile still governs nothing.
      assert.deepEqual((await profiles(baseUrl, auth)).map((view) => `${String(view['profileId'])}@${String(view['version'])}:${String(view['state'])}`).sort(), pre.profileStates);
      assert.equal(status(await govern(baseUrl, pre.release, release(LEGACY, key('legacy')))), 'rejected', 'a retired profile stays retired');
      assert.equal(calls(), 5);

      // Governance: the committed decisions are re-readable.
      const decisions = expectStatus(await call(baseUrl, 'GET', `/api/admin/activity/decisions?requestId=${encodeURIComponent(pre.t1.requestId)}`, { authorization: auth.observer }), 200, 'decisions');
      assert.equal((decisions.body['decisions'] as unknown[]).length, 1, decisions.text);

      await h2.host.close();

      // Trace (P8): every event recorded before the disaster survived, and the restored stream kept growing.
      const after = eventDigests(recovered);
      assert.deepEqual(after.filter((digest) => pre.eventDigests.includes(digest)).length, pre.eventDigests.length, 'every pre-backup authority event is present after restore');
      assert.ok(after.length > pre.eventDigests.length, 'the restored stream accepted new events');

      // P12: the binding was restored, not re-inferred; the resolution stays immutable.
      const resolutions = await createSqliteExecutionResolutionStore(join(recovered, 'execution-resolutions.sqlite'), { now: () => new Date().toISOString() });
      try {
        const state = await resolutions.read({ organizationId: ORG }, pre.resolution.executionId);
        assert.equal(state?.binding?.bindingDigest, pre.resolution.bindingDigest);
        assert.equal(state?.binding?.authorityId, 'resolver-prod02');
        assert.equal(state?.resolution?.resolutionDigest, pre.resolution.resolutionDigest);
        await assert.rejects(() =>
          resolutions.bind({ organizationId: ORG }, { organizationId: ORG, executionId: pre.resolution.executionId, attemptDigest: `sha256:${'4d'.repeat(32)}`, authorityId: 'resolver-other', origin: 'adopted', boundAt: new Date().toISOString() }),
        );
      } finally {
        await resolutions.close();
      }

      // Observed (not an SLA): how long this drill's backup → restore → boot cycle took on this machine.
      writeFileSync(join(deployment.root, 'drill-duration-ms'), String(Date.now() - startedAt));
    });
  });
}
