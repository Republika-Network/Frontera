import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { recordingAdapter } from './ctrl02-host-fixture.js';
import { witnessRows } from './core07-freshness-fixture.js';
import {
  EDGE,
  EVIDENCE_HASH,
  LEGACY,
  MAINTAIN,
  OBLIGATION,
  OFFBOARDED,
  PROD,
  RELEASE,
  RESTART,
  STAGING,
  DEPLOY,
  approvalCommand,
  approvalFor,
  approverStanding,
  authFor,
  bootProd02,
  bootRefusal,
  bootstrap,
  createDeployment,
  govern,
  grantOf,
  key,
  maintain,
  onboard,
  portability,
  profiles,
  release,
  restart,
  transition,
  type BootedProd02,
  type Deployment,
} from './prod02-recovery-fixture.js';
import { call, expectStatus } from './ctrl02-host-fixture.js';

/**
 * PROD-02 × CORE-07 — the restore-domain rule, adversarially.
 *
 * The freshness witness is never in the backup. These drills prove the two
 * consequences that rule exists for:
 *
 * - a backup taken BEFORE an authority transition (grant revocation, approval
 *   revocation, obligation discharge), restored after the surviving witness
 *   has moved past it, refuses to start — before any authority is handed out,
 *   with zero provider calls, and without the witness being reset or
 *   re-enrolled by anything;
 * - the control-plane store is NOT witness-anchored, so the same kind of stale
 *   restore resurrects a revoked agent credential and an older profile
 *   lifecycle. That is pinned here as the honest PROD-02 residual, with the
 *   operational mitigation the runbook prescribes.
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

async function coldBackup(deployment: Deployment, dataDir: string, name: string): Promise<string> {
  const { runBackup } = await portability();
  const output = deployment.dir(name);
  const report = await runBackup({ output, env: deployment.envFor(dataDir), cold: true });
  assert.equal(report['coverageComplete'], true);
  return output;
}

const freshnessCode = (error: Error): unknown => (error as Error & { code?: unknown }).code;

describe('PROD-02 stale-backup drill — an older authority backup never becomes current under a newer surviving witness', () => {
  it('S1 → backup A → S2 (revoke grant, revoke approval, discharge obligation) → restore A → refused before any authority, adapter untouched, witness unchanged; each signed store alone is refused; restore of S2 works', async () => {
    const deployment = await createDeployment('software');
    deployments.push(deployment);
    const { runRestore } = await portability();
    const auth = authFor(deployment.secrets);
    const data = deployment.dir('data');

    // ── S1 ────────────────────────────────────────────────────────────────────────
    let host = await boot(deployment.envFor(data));
    await bootstrap(host.baseUrl, auth);
    for (const profileId of ['release-production', 'edge-maintenance']) await transition(host.baseUrl, auth, profileId, 'activate');
    await approverStanding(host.baseUrl, auth, 'approver-a');
    const agent = await onboard(host.baseUrl, auth, { agentId: RELEASE, subjectId: 'release-1', actions: [DEPLOY, MAINTAIN, RESTART], resources: [PROD, LEGACY, EDGE, STAGING] });
    const x1 = await govern(host.baseUrl, agent.credential, restart(key('x1')));
    assert.equal(x1.body['status'], 'executed', x1.text);
    const grantId = await grantOf(host.baseUrl, auth, x1);
    const approvalKey = key('a1');
    const a1 = await govern(host.baseUrl, agent.credential, release(PROD, approvalKey));
    const view = await approvalFor(host.baseUrl, auth, a1.body['requestId'] as string);
    assert.equal((await approvalCommand(host.baseUrl, auth.approverA, view, 'approve', { evidence: [{ type: 'source_document', hash: EVIDENCE_HASH }] })).status, 200);
    const obligationKey = key('m1');
    const m1 = await govern(host.baseUrl, agent.credential, maintain(obligationKey));
    assert.equal(m1.body['withheldBy'], 'obligations');
    await host.host.close();
    const backupA = await coldBackup(deployment, data, 'backup-A');

    // ── S1 → S2: three authority transitions, each anchored at the witness ──────────
    host = await boot(deployment.envFor(data));
    expectStatus(await call(host.baseUrl, 'POST', `/api/admin/authority/grants/${encodeURIComponent(grantId)}/revoke`, { authorization: auth.responder, body: { reason: 'security-incident' } }), 200, 'revoke grant');
    assert.equal((await approvalCommand(host.baseUrl, auth.approverA, await approvalFor(host.baseUrl, auth, a1.body['requestId'] as string), 'revoke', { reason: 'window closed' })).status, 200);
    const discharges = host.host.enterprise.obligationDischarges;
    assert.ok(discharges !== undefined);
    await discharges.record(
      { system: true, actorId: 'operator:change-board-integration' },
      { correlation: { requestId: m1.body['requestId'] as string, action: MAINTAIN, resourceScope: EDGE }, obligationType: OBLIGATION, sourceId: 'change-approvals', outcome: 'discharged', observedAt: new Date(Date.now() - 60_000).toISOString(), reference: 'CAB-2' },
    );
    await host.host.close();
    const backupB = await coldBackup(deployment, data, 'backup-B');

    const witnessS2 = await witnessRows(deployment.witness.databasePath);
    const manifestA = JSON.parse(readFileSync(join(backupA, 'backup-manifest.json'), 'utf8')) as { stores: { name: string; signedHead?: { sequence: number; freshnessStateKind: string } }[] };
    for (const store of manifestA.stores.filter((entry) => entry.signedHead !== undefined)) {
      const slot = witnessS2.find((row) => row['state_kind'] === store.signedHead?.freshnessStateKind);
      assert.ok(Number(slot?.['committed_sequence']) > (store.signedHead?.sequence ?? Infinity), `${store.name}: the witness moved past backup A`);
    }

    // ── restore A, keep the witness at S2 ─────────────────────────────────────────────
    const staleDir = deployment.dir('restored-A');
    // Even with the witness's own database reachable from the restoring environment, restore leaves it alone.
    const restoredA = await runRestore({ backup: backupA, target: staleDir, env: { ...deployment.envFor(staleDir), FRONTERA_REFERENCE_WITNESS_DB: deployment.witness.databasePath } });
    assert.equal(restoredA['status'], 'restored', 'restore cannot know freshness; the Host decides at startup');
    const adapter = recordingAdapter();
    const refused = await bootRefusal(deployment.envFor(staleDir), adapter);
    assert.equal(freshnessCode(refused), 'AUTHORITY_FRESHNESS_ROLLBACK_DETECTED', refused.message);
    assert.equal(adapter.calls.length, 0, 'no authority was handed out: zero provider calls');
    assert.deepEqual(await witnessRows(deployment.witness.databasePath), witnessS2, 'nothing reset, rebound or re-enrolled the witness');

    // ── each signed store alone, stale inside an otherwise-current restore ────────────
    const { registry } = await portability();
    for (const storeDef of registry.STORE_DEFINITIONS.filter((entry) => entry.freshnessStateKind !== undefined)) {
      const mixed = deployment.dir(`restored-B-stale-${storeDef.name}`);
      await runRestore({ backup: backupB, target: mixed, env: { ...deployment.envFor(mixed), FRONTERA_REFERENCE_WITNESS_DB: deployment.witness.databasePath } });
      copyFileSync(join(backupA, 'stores', storeDef.filename), join(mixed, storeDef.targetFilename));
      const error = await bootRefusal(deployment.envFor(mixed), adapter);
      assert.equal(freshnessCode(error), 'AUTHORITY_FRESHNESS_ROLLBACK_DETECTED', `${storeDef.name}: ${error.message}`);
      assert.equal(adapter.calls.length, 0);
    }
    assert.deepEqual(await witnessRows(deployment.witness.databasePath), witnessS2, 'still untouched after every refusal');

    // ── control: the current backup restores and boots; S2's restrictions hold ─────────
    const currentDir = deployment.dir('restored-B');
    await runRestore({ backup: backupB, target: currentDir, env: deployment.envFor(currentDir) });
    host = await boot(deployment.envFor(currentDir));
    const grant = expectStatus(await call(host.baseUrl, 'GET', `/api/admin/authority/grants/${encodeURIComponent(grantId)}`, { authorization: auth.observer }), 200, 'grant');
    assert.notEqual((grant.body['status'] as Record<string, unknown>)['eligibility'], 'exercisable', 'the revocation is current');
    assert.notEqual((await govern(host.baseUrl, agent.credential, release(PROD, approvalKey))).body['status'], 'executed', 'the revoked approval stays revoked');
    assert.equal((await govern(host.baseUrl, agent.credential, maintain(obligationKey))).body['status'], 'executed', 'the discharge is current');
    assert.equal(host.adapter.calls.length, 1);
    await host.host.close();
  });
});

describe('PROD-02 residual — the control-plane store is not witness-anchored', () => {
  it('RESIDUAL: restoring a control-plane state from before a credential revocation and a profile retirement resurrects both; re-revoking after recovery is the mitigation', async () => {
    const deployment = await createDeployment('software');
    deployments.push(deployment);
    const { runRestore } = await portability();
    const auth = authFor(deployment.secrets);
    const data = deployment.dir('data');

    let host = await boot(deployment.envFor(data));
    await bootstrap(host.baseUrl, auth);
    await transition(host.baseUrl, auth, 'release-production', 'activate');
    const agent = await onboard(host.baseUrl, auth, { agentId: OFFBOARDED, subjectId: 'offboarded-1', actions: [RESTART], resources: [STAGING] });
    assert.equal((await govern(host.baseUrl, agent.credential, restart(key('r1')))).body['status'], 'executed');
    await host.host.close();
    const backupA = await coldBackup(deployment, data, 'backup-A');

    // After backup A: the credential is revoked and the profile retired. Neither is a CORE-07 anchored transition.
    host = await boot(deployment.envFor(data));
    expectStatus(await call(host.baseUrl, 'POST', `/api/admin/agents/${OFFBOARDED}/credentials/${agent.credentialId}/revoke`, { authorization: auth.responder, body: { reason: 'compromised' } }), 200, 'revoke credential');
    await transition(host.baseUrl, auth, 'release-production', 'retire');
    assert.equal((await govern(host.baseUrl, agent.credential, restart(key('r2')))).status, 401);
    await host.host.close();
    const witnessBefore = await witnessRows(deployment.witness.databasePath);

    // Restore the older control-plane state. The anchored stores did not move, so the Host starts.
    const restored = deployment.dir('restored-A');
    await runRestore({ backup: backupA, target: restored, env: deployment.envFor(restored) });
    host = await boot(deployment.envFor(restored));
    const resurrected = await govern(host.baseUrl, agent.credential, restart(key('r3')));
    assert.equal(resurrected.body['status'], 'executed', 'RESIDUAL (PROD-02): a credential revoked after the backup is accepted again — control-plane state is not witness-anchored');
    const lifecycle = (await profiles(host.baseUrl, auth)).find((view) => view['profileId'] === 'release-production');
    assert.equal(lifecycle?.['state'], 'active', 'RESIDUAL (PROD-02): a profile retired after the backup is active again');
    assert.deepEqual(await witnessRows(deployment.witness.databasePath), witnessBefore, 'the witness did not move: nothing anchored detected it');

    // Mitigation (RUNBOOKS_V1 §DR): re-apply every control-plane revocation and retirement recorded since the backup.
    expectStatus(await call(host.baseUrl, 'POST', `/api/admin/agents/${OFFBOARDED}/credentials/${agent.credentialId}/revoke`, { authorization: auth.responder, body: { reason: 'post-recovery re-revocation' } }), 200, 're-revoke');
    await transition(host.baseUrl, auth, 'release-production', 'retire');
    assert.equal((await govern(host.baseUrl, agent.credential, restart(key('r4')))).status, 401, 'after the runbook step the credential is dead again');
    assert.equal((await profiles(host.baseUrl, auth)).find((view) => view['profileId'] === 'release-production')?.['state'], 'retired');
    await host.host.close();
  });
});
