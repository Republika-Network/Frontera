import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import Database from 'better-sqlite3';

import { bootEnterpriseHost } from '../host/enterprise-host.js';
import { capturingLogger, recordingAdapter } from './ctrl02-host-fixture.js';
import {
  ACCOUNT,
  CEILING,
  DEPLOY,
  EDGE,
  EVIDENCE_HASH,
  FROZEN,
  LEGACY,
  LIFETIME_LIMIT,
  MAINTAIN,
  OBLIGATION,
  PAYABLES,
  PROD,
  RELEASE,
  RESTART,
  STAGING,
  TRANSFER,
  approvalCommand,
  approvalFor,
  approverStanding,
  authFor,
  bootProd02,
  bootRefusal,
  bootstrap,
  createDeployment,
  govern,
  key,
  maintain,
  onboard,
  portability,
  prod02File,
  readManifest,
  type Manifest,
  type ManifestStore,
  release,
  restart,
  transfer,
  transition,
  type BootedProd02,
  type Deployment,
} from './prod02-recovery-fixture.js';
import { call, expectStatus } from './ctrl02-host-fixture.js';

/**
 * PROD-02 — backup/restore integrity against a real deployment's data.
 *
 * One production-shaped deployment populates every Host-composable store
 * through the shipped Host; a cold backup of it is the specimen. Each case
 * below damages a copy of that specimen in one way and requires `restore:v1`
 * to refuse before touching the target — or, for promotion failures, to roll
 * the target back to exactly what it was. The composition cross-check boots
 * real Hosts and requires the registry's requirement derivation to predict
 * exactly the store files the composition root opens.
 */

const deployments: Deployment[] = [];
const hosts: BootedProd02[] = [];
const scratch: string[] = [];
after(async () => {
  for (const booted of hosts) await booted.host.close().catch(() => {});
  for (const deployment of deployments) await deployment.close().catch(() => {});
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `frontera-prod02-${prefix}-`));
  scratch.push(dir);
  return dir;
}

const sha256 = (path: string): string => `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;

let deployment: Deployment;
let data: string;
let specimen: string;

before(async () => {
  deployment = await createDeployment('software');
  deployments.push(deployment);
  const auth = authFor(deployment.secrets);
  data = deployment.dir('data');
  const host = await bootProd02(deployment.envFor(data));
  hosts.push(host);
  const { baseUrl } = host;
  await bootstrap(baseUrl, auth);
  for (const profileId of ['release-production', 'edge-maintenance']) await transition(baseUrl, auth, profileId, 'activate');
  await approverStanding(baseUrl, auth, 'approver-a');
  const payables = await onboard(baseUrl, auth, {
    agentId: PAYABLES,
    subjectId: 'payables-1',
    actions: [TRANSFER],
    resources: [ACCOUNT, FROZEN],
    constraints: [
      { type: 'max_amount', currency: 'USD', value: CEILING },
      { type: 'spending_limit', limitId: 'payables-lifetime', currency: 'USD', maximum: LIFETIME_LIMIT, window: { kind: 'lifetime' } },
    ],
  });
  const agent = await onboard(baseUrl, auth, { agentId: RELEASE, subjectId: 'release-1', actions: [DEPLOY, MAINTAIN, RESTART], resources: [PROD, LEGACY, EDGE, STAGING] });
  assert.equal((await govern(baseUrl, payables.credential, transfer('100', key('t')))).body['status'], 'executed');
  assert.equal((await govern(baseUrl, agent.credential, restart(key('x')))).body['status'], 'executed');
  const a1 = await govern(baseUrl, agent.credential, release(PROD, key('a')));
  assert.equal((await approvalCommand(baseUrl, auth.approverA, await approvalFor(baseUrl, auth, a1.body['requestId'] as string), 'approve', { evidence: [{ type: 'source_document', hash: EVIDENCE_HASH }] })).status, 200);
  const m1 = await govern(baseUrl, agent.credential, maintain(key('m')));
  await host.host.enterprise.obligationDischarges?.record(
    { system: true, actorId: 'operator:change-board-integration' },
    { correlation: { requestId: m1.body['requestId'] as string, action: MAINTAIN, resourceScope: EDGE }, obligationType: OBLIGATION, sourceId: 'change-approvals', outcome: 'discharged', observedAt: new Date(Date.now() - 60_000).toISOString(), reference: 'CAB-3' },
  );
  expectStatus(await call(baseUrl, 'POST', '/api/admin/emergency-controls/activate', { authorization: auth.responder, body: { scope: 'resource', value: FROZEN } }), 200, 'stop');
  await host.host.close();
  const { runBackup } = await portability();
  specimen = deployment.dir('specimen');
  await runBackup({ output: specimen, env: deployment.envFor(data), cold: true });
});

/** A private, writable copy of the specimen. */
function copyOfSpecimen(): string {
  const dir = join(tempDir('tamper'), 'backup');
  cpSync(specimen, dir, { recursive: true });
  return dir;
}

const manifestOf = readManifest;
function storeIn(manifest: Manifest, name: string): ManifestStore {
  const entry = manifest.stores.find((store) => store.name === name);
  assert.ok(entry !== undefined, name);
  return entry;
}

function writeManifest(backup: string, manifest: Manifest | Record<string, unknown>): void {
  writeFileSync(join(backup, 'backup-manifest.json'), JSON.stringify(manifest, null, 2));
}

function rechecksum(backup: string, name: string): void {
  const manifest = manifestOf(backup);
  const entry = storeIn(manifest, name);
  entry.checksum = sha256(join(backup, 'stores', entry.filename));
  writeManifest(backup, manifest);
}

/** Opens a backed-up store file for a deliberate, attacker-style edit (triggers dropped). */
function editStore(backup: string, filename: string, edit: (db: Database.Database) => void): void {
  const db = new Database(join(backup, 'stores', filename));
  try {
    for (const { name } of db.prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger'`).all() as { name: string }[]) db.exec(`DROP TRIGGER "${name}"`);
    edit(db);
  } finally {
    db.close();
  }
}

async function restoreRejects(backup: string, pattern: RegExp, options: Record<string, unknown> = {}, envOverrides: Record<string, string> = {}): Promise<string> {
  const { runRestore } = await portability();
  const target = join(tempDir('target'), 'data');
  await assert.rejects(() => runRestore({ backup, target, env: { ...deployment.envFor(target), ...envOverrides }, ...options }), pattern);
  // Nothing was written: no store file, no staging directory, no report.
  const left = existsSync(target) ? readdirSync(target) : [];
  assert.deepEqual(left, [], `the target was left untouched: ${left.join(', ')}`);
  return target;
}

describe('PROD-02 restore refuses a damaged or incomplete backup before touching the target', () => {
  const cases: [string, (backup: string) => void, RegExp][] = [
    ['an unsupported (future) backup format', (b) => writeManifest(b, { ...manifestOf(b), backupFormat: 'aoc.enterprise.backup.v2' }), /Unsupported backup format/],
    ['a malformed manifest', (b) => writeFileSync(join(b, 'backup-manifest.json'), '{ not json'), /not valid JSON/],
    ['a missing manifest', (b) => unlinkSync(join(b, 'backup-manifest.json')), /No backup-manifest\.json/],
    [
      'a manifest that silently drops the approval store',
      (b) => {
        const m = manifestOf(b);
        m.stores = m.stores.filter((store) => store.name !== 'approvals');
        assert.ok(m.coverage !== undefined);
        m.coverage.stores = m.coverage.stores.map((store) => (store.name === 'approvals' ? { ...store, included: false, present: false, status: 'not-configured' } : store));
        unlinkSync(join(b, 'stores', 'approvals.sqlite'));
        writeManifest(b, m);
      },
      /incomplete: the source deployment composed approvals.*the manifest claims to be complete/,
    ],
    ['a missing store file', (b) => unlinkSync(join(b, 'stores', 'bounded-grants.sqlite')), /missing from stores\//],
    ['an unexpected extra store file', (b) => writeFileSync(join(b, 'stores', 'payments-ledger.sqlite'), 'x'), /Unexpected file 'payments-ledger\.sqlite'/],
    ['a witness database planted in the backup set', (b) => writeFileSync(join(b, 'stores', 'witness.sqlite'), 'x'), /Unexpected file 'witness\.sqlite'/],
    [
      'a checksum mismatch in the exercise ledger',
      (b) => {
        const path = join(b, 'stores', 'exercise-ledger.sqlite');
        const bytes = readFileSync(path);
        bytes[Math.floor(bytes.length / 2)] = (bytes[Math.floor(bytes.length / 2)] ?? 0) ^ 0xff;
        writeFileSync(path, bytes);
      },
      /Checksum mismatch for store 'exercise-ledger'/,
    ],
    [
      'SQLite corruption behind a recomputed checksum (emergency controls)',
      (b) => {
        const path = join(b, 'stores', 'emergency-controls.sqlite');
        const bytes = readFileSync(path);
        for (let offset = 4096; offset < Math.min(bytes.length, 8192); offset += 1) bytes[offset] = 0x41;
        writeFileSync(path, bytes);
        rechecksum(b, 'emergency-controls');
      },
      /SQLite integrity check failed for store 'emergency-controls'/,
    ],
    [
      'a schema version this build does not support (control plane)',
      (b) => {
        const m = manifestOf(b);
        storeIn(m, 'control-plane').schemaVersion = 'frontera.control-plane.schema.v99';
        writeManifest(b, m);
      },
      /control-plane' was backed up under schema version 'frontera\.control-plane\.schema\.v99'/,
    ],
    [
      'a file whose recorded schema disagrees with the manifest (execution outcomes)',
      (b) => {
        editStore(b, 'execution-outcomes.sqlite', (db) => db.prepare(`UPDATE execution_outcome_store_versions SET schema_version = 'aoc.execution-outcome-store.schema.v1'`).run());
        rechecksum(b, 'execution-outcomes');
      },
      /file records schema version/,
    ],
    [
      'a symlinked store',
      (b) => {
        unlinkSync(join(b, 'stores', 'approvals.sqlite'));
        symlinkSync('/etc/hostname', join(b, 'stores', 'approvals.sqlite'));
      },
      /symlink/,
    ],
    [
      'a path-traversing filename',
      (b) => {
        const m = manifestOf(b);
        storeIn(m, 'obligation-discharges').filename = '../../../etc/hostname';
        writeManifest(b, m);
      },
      /must be stored as 'stores\/obligation-discharges\.sqlite'/,
    ],
    [
      'a store mapped to another store\'s file',
      (b) => {
        const m = manifestOf(b);
        storeIn(m, 'bounded-grants').filename = 'approvals.sqlite';
        writeManifest(b, m);
      },
      /claimed by more than one store|must be stored as/,
    ],
    [
      'duplicate store names',
      (b) => {
        const m = manifestOf(b);
        m.stores.push({ ...storeIn(m, 'approvals'), filename: 'approvals-2.sqlite' });
        writeManifest(b, m);
      },
      /appears more than once/,
    ],
    [
      'an unknown critical store',
      (b) => {
        const m = manifestOf(b);
        m.stores.push({ name: 'payments-ledger', filename: 'payments-ledger.sqlite', checksum: 'sha256:00', schemaVersion: 'x' });
        writeManifest(b, m);
      },
      /Unknown store 'payments-ledger'/,
    ],
    ['an unknown (newer) coverage model', (b) => writeManifest(b, { ...manifestOf(b), coverage: { ...manifestOf(b).coverage, coverageModel: 'aoc.enterprise.backup.coverage.v9' } }), /Unsupported coverage model/],
    [
      'approval rows without their signed head',
      (b) => {
        editStore(b, 'approvals.sqlite', (db) => db.prepare('DELETE FROM approval_head').run());
        rechecksum(b, 'approvals');
      },
      /approvals' has an inconsistent signed head \(rows without a signed head\)/,
    ],
    [
      'a signed approval head without the rows it commits to',
      (b) => {
        editStore(b, 'approvals.sqlite', (db) => db.prepare('DELETE FROM approval_records WHERE sequence = (SELECT MAX(sequence) FROM approval_records)').run());
        rechecksum(b, 'approvals');
      },
      /approvals' has an inconsistent signed head/,
    ],
    [
      'a revocation-state commitment that no longer commits to the revocations present',
      (b) => {
        editStore(b, 'bounded-grants.sqlite', (db) => db.prepare('UPDATE bounded_grant_revocation_state SET sequence = sequence + 1').run());
        rechecksum(b, 'bounded-grants');
      },
      /bounded-grants' has an inconsistent signed head/,
    ],
    [
      'a signed obligation head substituted from another state',
      (b) => {
        editStore(b, 'obligation-discharges.sqlite', (db) => db.prepare(`UPDATE obligation_discharge_head SET chain_digest = 'sha256:${'0'.repeat(64)}'`).run());
        rechecksum(b, 'obligation-discharges');
      },
      /signed head does not match the head the manifest recorded/,
    ],
    [
      'a forged signed head whose manifest was rewritten to match (caught by the trusted keys)',
      (b) => {
        editStore(b, 'obligation-discharges.sqlite', (db) => db.prepare(`UPDATE obligation_discharge_head SET chain_digest = 'sha256:${'0'.repeat(64)}'`).run());
        const m = manifestOf(b);
        const entry = storeIn(m, 'obligation-discharges');
        assert.ok(entry.signedHead !== undefined);
        entry.signedHead.stateDigest = `sha256:${'0'.repeat(64)}`;
        entry.checksum = sha256(join(b, 'stores', 'obligation-discharges.sqlite'));
        writeManifest(b, m);
      },
      /obligation-discharges' does not open as a valid store/,
    ],
  ];

  for (const [label, damage, pattern] of cases) {
    it(`refuses ${label}`, async () => {
      const backup = copyOfSpecimen();
      damage(backup);
      await restoreRejects(backup, pattern);
    });
  }

  it('refuses a backup of another organization for this deployment', async () => {
    await restoreRejects(specimen, /belongs to organization 'org-prod02', but the restoring deployment serves 'org-elsewhere'/, {}, { AOC_ENTERPRISE_KERNEL_AUTHORITY_ORGANIZATION_ID: 'org-elsewhere' });
  });

  it('refuses a signed store transplanted from another organization', async () => {
    const backup = copyOfSpecimen();
    editStore(backup, 'approvals.sqlite', (db) => db.prepare(`UPDATE approval_store_meta SET organization_id = 'org-elsewhere'`).run());
    rechecksum(backup, 'approvals');
    await restoreRejects(backup, /approvals' is bound to organization 'org-elsewhere'/);
  });

  it('refuses a source/target overlap', async () => {
    const { runRestore } = await portability();
    await assert.rejects(() => runRestore({ backup: specimen, target: join(specimen, 'stores'), env: deployment.envFor(specimen) }), /must not be nested|must not be identical/);
  });

  it('a pre-PROD-02 (legacy) backup is never accepted as complete; with the explicit flag it restores and says so', async () => {
    const legacy = copyOfSpecimen();
    const m = manifestOf(legacy);
    delete m.coverage;
    writeManifest(legacy, m);
    await restoreRejects(legacy, /pre-PROD-02 backup with no coverage record/);
    const { runRestore } = await portability();
    const target = join(tempDir('legacy'), 'data');
    const report = (await runRestore({ backup: legacy, target, env: deployment.envFor(target), allowLegacyBackup: true }));
    assert.equal(report.coverage.model, 'legacy');
    assert.equal(report.coverage.complete, false);
  });

  it('a historical four-store backup is refused for a deployment that requires the governed stores — even when legacy backups are allowed', async () => {
    const legacy = copyOfSpecimen();
    const m = manifestOf(legacy);
    delete m.coverage;
    const historical = new Set(['governance', 'agent-passport', 'assurance', 'kernel-authority']);
    for (const store of m.stores) if (!historical.has(store.name)) unlinkSync(join(legacy, 'stores', store.filename));
    m.stores = m.stores.filter((store) => historical.has(store.name));
    writeManifest(legacy, m);
    await restoreRejects(legacy, /restoring deployment requires bounded-grants, emergency-controls, exercise-ledger, authority-event-stream, execution-outcomes, obligation-discharges, approvals, control-plane/, { allowLegacyBackup: true });
  });

  it('an incomplete backup (missing stores explicitly allowed) is refused; with --allow-incomplete it restores without inventing the missing store, and the secure Host still refuses it', async () => {
    const { runBackup, runRestore } = await portability();
    const source = join(tempDir('incomplete'), 'data');
    cpSync(data, source, { recursive: true });
    unlinkSync(join(source, 'approvals.sqlite'));
    const backup = join(tempDir('incomplete-backup'), 'backup');
    await assert.rejects(() => runBackup({ output: backup, env: deployment.envFor(source) }), /Required store 'approvals'/);
    const report = await runBackup({ output: backup, env: deployment.envFor(source), allowMissingStores: true });
    assert.equal(report['coverageComplete'], false);
    assert.equal(manifestOf(backup).coverage?.complete, false);
    assert.ok(readFileSync(join(backup, 'RESTORE.md'), 'utf8').includes('INCOMPLETE'));
    await restoreRejects(backup, /is incomplete: the source deployment composed approvals/);

    const target = join(tempDir('incomplete-target'), 'data');
    const restored = (await runRestore({ backup, target, env: deployment.envFor(target), allowIncomplete: true }));
    assert.equal(restored.coverage.complete, false);
    assert.deepEqual(restored.notRestored, ['execution-resolutions', 'approvals'], 'P12 was never configured; approvals was missing');
    assert.equal(existsSync(join(target, 'approvals.sqlite')), false, 'restore never creates an empty authority store');
    // The Host would create a fresh approval store — and the surviving witness refuses that empty genesis.
    const adapter = recordingAdapter();
    const refusal = await bootRefusal(deployment.envFor(target), adapter);
    assert.equal((refusal as Error & { code?: string }).code, 'AUTHORITY_FRESHNESS_ROLLBACK_DETECTED', refusal.message);
    assert.equal(adapter.calls.length, 0);
  });
});

describe('PROD-02 restore replacement: exactly the old state or exactly the new one', () => {
  function stateOf(dir: string): Record<string, string> {
    return Object.fromEntries(
      readdirSync(dir)
        .filter((name) => !name.startsWith('.'))
        .sort()
        .map((name) => [name, sha256(join(dir, name))]),
    );
  }

  for (const failAt of [1, 6, 12]) {
    it(`a failure after ${failAt} store(s) were promoted rolls every managed file back`, async () => {
      const { runRestore } = await portability();
      const target = join(tempDir('rollback'), 'data');
      await runRestore({ backup: specimen, target, env: deployment.envFor(target) });
      // The live target differs from the specimen afterwards: it carries an extra registry-managed file and sidecars.
      writeFileSync(join(target, 'execution-resolutions.sqlite'), 'pre-existing');
      writeFileSync(join(target, 'approvals.sqlite-wal'), 'pre-existing-wal');
      const before = stateOf(target);
      await assert.rejects(
        () =>
          runRestore({
            backup: specimen,
            target,
            env: deployment.envFor(target),
            force: true,
            faultInjection: {
              afterPromote: (index: number) => {
                if (index === failAt) throw new Error(`injected failure after store ${index}`);
              },
            },
          }),
        /injected failure/,
      );
      assert.deepEqual(stateOf(target), before, 'byte-for-byte the state before the restore');
      assert.deepEqual(readdirSync(target).filter((name) => name.startsWith('.')), [], 'no staging or safety directory left behind');
    });
  }

  it('a failure in post-promotion verification rolls back too', async () => {
    const { runRestore } = await portability();
    const target = join(tempDir('rollback-verify'), 'data');
    await runRestore({ backup: specimen, target, env: deployment.envFor(target) });
    const before = stateOf(target);
    await assert.rejects(
      () =>
        runRestore({
          backup: specimen,
          target,
          env: deployment.envFor(target),
          force: true,
          faultInjection: {
            afterVerify: () => {
              throw new Error('injected verification failure');
            },
          },
        }),
      /injected verification failure/,
    );
    assert.deepEqual(stateOf(target), before);
  });

  it('a successful --force restore leaves exactly the backup set: stale managed files and sidecars are moved aside, never mixed in', async () => {
    const { runRestore, registry } = await portability();
    const target = join(tempDir('replace'), 'data');
    await runRestore({ backup: specimen, target, env: deployment.envFor(target) });
    await assert.rejects(() => runRestore({ backup: specimen, target, env: deployment.envFor(target) }), /already has store file/);
    writeFileSync(join(target, 'execution-resolutions.sqlite'), 'stale');
    writeFileSync(join(target, 'approvals.sqlite-wal'), 'stale-wal');
    const report = (await runRestore({ backup: specimen, target, env: deployment.envFor(target), force: true }));
    assert.ok(report.preRestoreSafetyCopy !== null && existsSync(report.preRestoreSafetyCopy));
    assert.equal(existsSync(join(target, 'approvals.sqlite-wal')), false, 'no foreign WAL is left beside a restored database');
    const manifest = manifestOf(specimen);
    for (const store of manifest.stores) {
      const storeDef = registry.STORE_DEFINITIONS.find((entry) => entry.name === store.name);
      assert.ok(storeDef !== undefined);
      assert.equal(sha256(join(target, storeDef.targetFilename)), store.checksum, store.name);
    }
    const included = new Set(manifest.stores.map((store) => store.name));
    for (const storeDef of registry.STORE_DEFINITIONS.filter((entry) => !included.has(entry.name))) {
      assert.equal(existsSync(join(target, storeDef.targetFilename)), false, `${storeDef.name} is not in the backup, so it is not in the target`);
    }
  });
});

describe('PROD-02 backup refusals and evidence', () => {
  it('--cold refuses while the Host is running; a live backup records what it observed and claims no atomicity', async () => {
    const { runBackup } = await portability();
    const host = await bootProd02(deployment.envFor(data));
    hosts.push(host);
    const auth = authFor(deployment.secrets);
    expectStatus(await call(host.baseUrl, 'POST', '/api/admin/emergency-controls/activate', { authorization: auth.responder, body: { scope: 'actor', value: 'actor-live-backup' } }), 200, 'write while live');
    await assert.rejects(() => runBackup({ output: join(tempDir('live'), 'backup'), env: deployment.envFor(data), cold: true }), /appears to be running/);
    const output = join(tempDir('live-ok'), 'backup');
    await runBackup({ output, env: deployment.envFor(data) });
    const manifest = manifestOf(output);
    assert.equal(manifest.consistency.mode, 'live-per-file');
    assert.equal(manifest.consistency.crossStoreAtomic, false);
    assert.ok(manifest.consistency.nonEmptyWalObserved.length > 0);
    await host.host.close();
  });

  it('a configured governed-action file that cannot be read refuses: the required stores would be unknowable', async () => {
    const { runBackup } = await portability();
    await assert.rejects(() => runBackup({ output: join(tempDir('nofile'), 'backup'), env: { ...deployment.envFor(data), AOC_ENTERPRISE_GOVERNED_ACTIONS_FILE: join(tempDir('missing'), 'absent.json') } }), /could not be read/);
  });

  it('a clean Host shutdown leaves no open database handle and no WAL beside any store (the cold-backup precondition)', async () => {
    const dir = deployment.dir('close-check');
    cpSync(data, dir, { recursive: true });
    const host = await bootProd02(deployment.envFor(dir));
    await host.host.close();
    if (existsSync('/proc/self/fd')) {
      const open = readdirSync('/proc/self/fd')
        .map((fd) => {
          try {
            return readlinkSync(join('/proc/self/fd', fd));
          } catch {
            return '';
          }
        })
        .filter((path) => path.startsWith(resolve(dir)));
      assert.deepEqual(open, [], 'every store the Host opened was closed');
    }
    assert.deepEqual(readdirSync(dir).filter((name) => name.endsWith('-wal') || name.endsWith('-shm')), []);
  });
});

describe('PROD-02 registry ↔ composition: the derived requirements are exactly the stores the Host opens', () => {
  async function opened(env: Record<string, string | undefined>, dir: string): Promise<string[]> {
    const { registry } = await portability();
    const host = await bootEnterpriseHost({ env, executionAdapters: [recordingAdapter()], logger: capturingLogger, policyPackProvider: (await import('./prod02-recovery-fixture.js')).prod02Policy() });
    await host.close();
    return registry.STORE_DEFINITIONS.filter((storeDef) => existsSync(join(dir, storeDef.targetFilename))).map((storeDef) => storeDef.name);
  }

  async function derived(env: Record<string, string | undefined>): Promise<string[]> {
    const { registry } = await portability();
    const enterprise = await import('../configuration/enterprise-configuration.js');
    const requirements = registry.deriveDeploymentRequirements(env as never, enterprise.loadEnterpriseConfiguration(env) as never);
    return registry.STORE_DEFINITIONS.filter((storeDef) => (registry.conditionHolds as (c: string, r: unknown) => boolean)(storeDef.condition, requirements)).map((storeDef) => storeDef.name);
  }

  // Each production variant gets its own deployment — and so its own witness: a fresh data
  // directory under a witness that already holds this organization's state is (correctly) refused.
  const variants: [string, () => Promise<(dir: string) => Record<string, string | undefined>>][] = [
    [
      'the full production deployment (operators, approvals, obligations)',
      async () => {
        const fresh = await createDeployment('software');
        deployments.push(fresh);
        return (dir) => fresh.envFor(dir);
      },
    ],
    [
      'a production deployment without operators, approvals or obligations',
      async () => {
        const fresh = await createDeployment('software');
        deployments.push(fresh);
        const file = JSON.parse(JSON.stringify(prod02File())) as Record<string, unknown>;
        for (const field of ['operators', 'administrators', 'profileLifecycle', 'obligations']) delete file[field];
        const governance = file['governance'] as { profiles: Record<string, unknown>[] };
        governance.profiles = governance.profiles.map(({ approval: _approval, obligations: _obligations, ...profile }) => profile);
        const path = join(fresh.configDir, 'governed-actions-minimal.json');
        writeFileSync(path, JSON.stringify(file));
        return (dir) => ({ ...fresh.envFor(dir), AOC_ENTERPRISE_GOVERNED_ACTIONS_FILE: path });
      },
    ],
    [
      'a development SQLite Host without governed actions or Kernel Authority',
      async () => (dir) => ({ AOC_ENTERPRISE_ENV: 'development', AOC_ENTERPRISE_PERSISTENCE_PROVIDER: 'sqlite', AOC_ENTERPRISE_HTTP_PORT: '0', ...Object.fromEntries(Object.entries(deployment.envFor(dir)).filter(([name]) => name.endsWith('_SQLITE_PATH'))) }),
    ],
    [
      'a development SQLite Host with Kernel Authority enabled',
      async () => (dir) => ({
        AOC_ENTERPRISE_ENV: 'development',
        AOC_ENTERPRISE_PERSISTENCE_PROVIDER: 'sqlite',
        AOC_ENTERPRISE_HTTP_PORT: '0',
        AOC_ENTERPRISE_KERNEL_AUTHORITY_ENABLED: 'true',
        ...Object.fromEntries(Object.entries(deployment.envFor(dir)).filter(([name]) => name.endsWith('_SQLITE_PATH'))),
      }),
    ],
  ];

  for (const [label, prepare] of variants) {
    it(label, async () => {
      const envOf = await prepare();
      const dir = join(tempDir('compose'), 'data');
      mkdirSync(dir, { recursive: true });
      const env = envOf(dir);
      assert.deepEqual(await opened(env, dir), await derived(env));
    });
  }
});
