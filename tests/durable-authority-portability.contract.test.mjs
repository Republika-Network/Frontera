// Disaster-recovery acceptance for the durable Kernel Authority world.
//
// The backup/restore contract tests next door prove the *file set* round-trips.
// This suite proves the thing that actually matters for an authority source:
// after the original durable state is destroyed and rebuilt from a backup
// alone, in a process that provisions nothing, the same decisions come back --
// a legitimate ALLOW returns, and a revocation stays revoked.
//
// A production authority world that disappears (or worse, quietly reopens) in
// disaster recovery is not complete, so this is asserted rather than assumed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { generateFixture } from '../scripts/portability/generate-portability-fixture.mjs';
import { runBackup } from '../scripts/portability/backup-enterprise-v1.mjs';
import { runRestore } from '../scripts/portability/restore-enterprise-v1.mjs';

const ROOT = resolve(new URL('..', import.meta.url).pathname);

async function loadRuntime() {
  const enterprise = await import(join(ROOT, 'dist/src/enterprise/index.js'));
  const kernel = await import(join(ROOT, 'dist/src/kernel/index.js'));
  return { enterprise, kernel };
}

function backupEnvFor(preDir) {
  return {
    ...process.env,
    AOC_ENTERPRISE_PERSISTENCE_PROVIDER: 'sqlite',
    AOC_ENTERPRISE_SQLITE_PATH: join(preDir, 'enterprise-host.sqlite'),
    AOC_ENTERPRISE_PASSPORT_SQLITE_PATH: join(preDir, 'agent-passport.sqlite'),
    AOC_ENTERPRISE_ASSURANCE_SQLITE_PATH: join(preDir, 'assurance.sqlite'),
    AOC_ENTERPRISE_EVIDENCE_SQLITE_PATH: join(preDir, 'evidence-bundles.sqlite'),
    AOC_ENTERPRISE_KERNEL_AUTHORITY_SQLITE_PATH: join(preDir, 'kernel-authority.sqlite'),
    // This suite is about a deployment that HAS adopted durable authority.
    AOC_ENTERPRISE_KERNEL_AUTHORITY_ENABLED: 'true',
  };
}

/** Opens the restored authority store and asks it the questions the fixture recorded. Provisions nothing. */
async function decideAgainst(storePath, expected) {
  const { enterprise, kernel: kernelModule } = await loadRuntime();
  const store = await enterprise.createSqliteKernelAuthorityStore(storePath);
  try {
    const providers = await enterprise.createDurableKernelProviders({ store, organizationId: expected.organizationId });
    const kernel = kernelModule.createAocKernel({
      recognitionProvider: providers.recognitionProvider,
      clock: providers.clock,
      idGenerator: providers.idGenerator,
    });

    const evaluate = async (requestId, capabilityTokenId) =>
      (
        await kernel.evaluate({
          requestId,
          actor: { id: expected.agentActorId, principalId: expected.ownerActorId, trustDomainId: expected.trustDomainId, type: 'agent' },
          action: { type: expected.action, resourceScope: expected.resourceScope, capability: expected.capability },
          organization: { id: expected.organizationId },
          requestedAt: '2026-01-01T00:00:00.000Z',
          ...(capabilityTokenId !== undefined ? { context: { capabilityTokenId } } : {}),
        })
      ).status;

    return {
      records: providers.records().length,
      allowed: await evaluate('restored-allowed'),
      revoked: await evaluate('restored-revoked', expected.revokedCapabilityTokenId),
      wrongAction: (
        await kernel.evaluate({
          requestId: 'restored-wrong-action',
          actor: { id: expected.agentActorId, principalId: expected.ownerActorId, trustDomainId: expected.trustDomainId, type: 'agent' },
          action: { type: 'delete.material-action', resourceScope: expected.resourceScope },
          organization: { id: expected.organizationId },
          requestedAt: '2026-01-01T00:00:00.000Z',
        })
      ).status,
      unknownActor: (
        await kernel.evaluate({
          requestId: 'restored-unknown-actor',
          actor: { id: 'actor-nobody', trustDomainId: expected.trustDomainId, type: 'agent' },
          action: { type: expected.action, resourceScope: expected.resourceScope },
          organization: { id: expected.organizationId },
          requestedAt: '2026-01-01T00:00:00.000Z',
        })
      ).status,
      externalSubjectActorId: (await store.findActorByExternalSubject({ system: true }, expected.organizationId, expected.externalSubject))?.entityId ?? null,
    };
  } finally {
    await store.close();
  }
}

test('durable authority survives destroy-and-restore, and revocation survives with it', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'aoc-durable-authority-portability-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const preDir = join(root, 'pre');
  const backupDir = join(root, 'backup');
  const restoredDir = join(root, 'restored');

  const fixture = await generateFixture({ target: preDir });
  const expected = fixture.record.kernelAuthority;
  assert.ok(expected, 'the portability fixture must seed a Kernel Authority world');

  const sourcePath = join(preDir, 'kernel-authority.sqlite');
  assert.ok(existsSync(sourcePath), 'the fixture must have created a durable authority store on disk');

  // Baseline: the original world decides as the fixture describes.
  const before = await decideAgainst(sourcePath, expected);
  assert.equal(before.allowed, 'allowed');
  assert.equal(before.revoked, 'denied');
  assert.equal(before.wrongAction, 'denied');
  assert.equal(before.unknownActor, 'denied');
  assert.equal(before.externalSubjectActorId, expected.ownerActorId);

  await runBackup({ output: backupDir, env: backupEnvFor(preDir) });

  // The authority store must actually be in the backup -- an authority world
  // that is merely "backed up" by omission is the failure this asserts against.
  const backedUp = join(backupDir, 'stores', 'kernel-authority.sqlite');
  assert.ok(existsSync(backedUp), 'the backup must carry the Kernel Authority Store');

  // Destroy the original durable state completely, including SQLite sidecars.
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${sourcePath}${suffix}`, { force: true });
  assert.equal(existsSync(sourcePath), false);

  await runRestore({ backup: backupDir, target: restoredDir });

  const restoredPath = join(restoredDir, 'kernel-authority.sqlite');
  assert.ok(existsSync(restoredPath), 'restore must recreate the Kernel Authority Store');

  // The whole point: a fresh process, restoring from the backup alone, with no
  // provisioning of any kind.
  const after = await decideAgainst(restoredPath, expected);

  assert.equal(after.records, before.records, 'the restored world must hold exactly the records the original held');
  assert.equal(after.allowed, 'allowed', 'a legitimate ALLOW must survive disaster recovery');
  assert.equal(after.revoked, 'denied', 'a revocation must survive disaster recovery -- restore must never reopen withdrawn authority');
  assert.equal(after.wrongAction, 'denied');
  assert.equal(after.unknownActor, 'denied');
  assert.equal(after.externalSubjectActorId, expected.ownerActorId, 'the external principal binding must survive disaster recovery');
});
