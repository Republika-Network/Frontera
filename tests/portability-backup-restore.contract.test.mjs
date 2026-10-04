// Contract tests for the Soberanía Enterprise v1 backup/restore/portability
// tooling (docs/operations/AOC_ENTERPRISE_BACKUP_V1.md,
// AOC_ENTERPRISE_RESTORE_V1.md). Exercises the real scripts against real
// SQLite stores seeded through the actual Enterprise Host services (via
// the synthetic portability fixture) -- no mocked stores.
//
// Requires `npm run build` to have already produced `dist/` (these tests
// run via `npm test`, which builds first).

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, writeFileSync, readFileSync, existsSync, unlinkSync, symlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

import { generateFixture } from '../scripts/portability/generate-portability-fixture.mjs';
import { runBackup } from '../scripts/portability/backup-enterprise-v1.mjs';
import { runRestore } from '../scripts/portability/restore-enterprise-v1.mjs';
import { comparePortabilityState } from '../scripts/portability/compare-portability-state.mjs';

function workDir(prefix) {
  return mkdtempSync(join(tmpdir(), `aoc-portability-test-${prefix}-`));
}

function backupEnvFor(preDir) {
  return {
    ...process.env,
    AOC_ENTERPRISE_PERSISTENCE_PROVIDER: 'sqlite',
    AOC_ENTERPRISE_SQLITE_PATH: join(preDir, 'enterprise-host.sqlite'),
    AOC_ENTERPRISE_PASSPORT_SQLITE_PATH: join(preDir, 'agent-passport.sqlite'),
    AOC_ENTERPRISE_ASSURANCE_SQLITE_PATH: join(preDir, 'assurance.sqlite'),
    AOC_ENTERPRISE_KERNEL_AUTHORITY_SQLITE_PATH: join(preDir, 'kernel-authority.sqlite'),
    AOC_ENTERPRISE_EVIDENCE_SQLITE_PATH: join(preDir, 'evidence-bundles.sqlite'),
    AOC_ENTERPRISE_KERNEL_AUTHORITY_ENABLED: 'true',
  };
}

function sha256(path) {
  return `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
}

// A single fixture + backup is expensive (spins up a full Enterprise Host);
// share it read-only across the tests that only need a valid backup to
// tamper with, and build fresh ones only for tests that mutate the source.
let sharedRoot;
let sharedPreDir;
let sharedBackupDir;

test.before(async () => {
  sharedRoot = workDir('shared');
  sharedPreDir = join(sharedRoot, 'pre');
  sharedBackupDir = join(sharedRoot, 'backup');
  await generateFixture({ target: sharedPreDir });
  await runBackup({ output: sharedBackupDir, env: backupEnvFor(sharedPreDir) });
});

test.after(() => {
  rmSync(sharedRoot, { recursive: true, force: true });
});

test('complete backup: manifest, checksums, RESTORE.md, and stable store ordering', () => {
  const manifest = JSON.parse(readFileSync(join(sharedBackupDir, 'backup-manifest.json'), 'utf8'));
  assert.equal(manifest.backupFormat, 'aoc.enterprise.backup.v1');
  assert.equal(manifest.coverage.complete, true, 'PROD-02: every store this deployment composes is included');
  // The fixture deployment composes five stores (no governed actions): the
  // Kernel Authority Store is authority source-of-truth, so a backup that
  // omitted it would restore a deployment in which every actor is unrecognized
  // and every action denied; since ASSURE-01 the Evidence Bundle Store is
  // durable and composed whenever persistence is. The full registry (thirteen
  // stores at PROD-02, fourteen since ASSURE-01) is qualified on the real Host
  // (src/enterprise/__tests__/prod02-*.test.ts, assure01-trace-host.test.ts).
  assert.deepEqual(manifest.stores.map((s) => s.name), ['governance', 'agent-passport', 'assurance', 'kernel-authority', 'evidence-bundles']);
  assert.ok(existsSync(join(sharedBackupDir, 'checksums.sha256')));
  assert.ok(existsSync(join(sharedBackupDir, 'RESTORE.md')));
  assert.ok(existsSync(join(sharedBackupDir, 'metadata', 'store-versions.json')));
  for (const store of manifest.stores) {
    assert.equal(store.integrityCheck, 'ok');
    assert.equal(sha256(join(sharedBackupDir, 'stores', store.filename)), store.checksum);
  }
});

test('backup does not demand the authority store when durable authority is disabled', async () => {
  // Durable authority is opt-in and defaults to off, so an existing SQLite
  // deployment has no kernel-authority.sqlite. Requiring one would break every
  // previously-working backup command on upgrade, and the usual remedy ("start
  // the Host once") cannot help -- a disabled feature never creates the file.
  const root = workDir('authority-disabled');
  const preDir = join(root, 'pre');
  const backupDir = join(root, 'backup');
  await generateFixture({ target: preDir });
  unlinkSync(join(preDir, 'kernel-authority.sqlite'));

  const env = { ...backupEnvFor(preDir), AOC_ENTERPRISE_KERNEL_AUTHORITY_ENABLED: 'false' };
  const report = await runBackup({ output: backupDir, env });

  assert.deepEqual(
    report.stores.map((s) => s.name),
    ['governance', 'agent-passport', 'assurance', 'evidence-bundles'],
    'a disabled authority store must simply not be part of the backup set',
  );
  assert.equal(existsSync(join(backupDir, 'stores', 'kernel-authority.sqlite')), false);
  // And the backup is a real, restorable one rather than a partial write.
  const manifest = JSON.parse(readFileSync(join(backupDir, 'backup-manifest.json'), 'utf8'));
  assert.deepEqual(manifest.stores.map((s) => s.name), ['governance', 'agent-passport', 'assurance', 'evidence-bundles']);
  const target = join(root, 'restored');
  const restored = await runRestore({ backup: backupDir, target });
  assert.equal(restored.status, 'restored');
  rmSync(root, { recursive: true, force: true });
});

test('a store file at a default path the deployment neither requires nor names is never swept into the backup (PROD-02)', async () => {
  // The four-store fixture deployment composes no governed actions. A stray
  // governed-action store left at its *default* relative path (here under the
  // working directory's .data/) is not this deployment's state.
  const root = workDir('stray-default');
  const original = process.cwd();
  try {
    await generateFixture({ target: join(root, 'pre') });
    const enterprise = await import('../dist/src/enterprise/index.js');
    process.chdir(root);
    const stray = await enterprise.createSqliteGovernanceStore(join(root, '.data', 'authority-event-stream.sqlite'));
    await stray.close();
    const report = await runBackup({ output: join(root, 'backup'), env: backupEnvFor(join(root, 'pre')) });
    assert.deepEqual(report.stores.map((s) => s.name), ['governance', 'agent-passport', 'assurance', 'kernel-authority', 'evidence-bundles']);
    const manifest = JSON.parse(readFileSync(join(root, 'backup', 'backup-manifest.json'), 'utf8'));
    assert.equal(manifest.coverage.stores.find((s) => s.name === 'authority-event-stream').status, 'present-not-configured', 'skipped, but never silently');
    assert.equal(report.warnings.length, 1);
    assert.match(report.warnings[0], /authority-event-stream.*NOT backed up/);
  } finally {
    process.chdir(original);
    rmSync(root, { recursive: true, force: true });
  }
});

test('secret exclusion: manifest declares excluded secrets and never embeds them', () => {
  const manifest = JSON.parse(readFileSync(join(sharedBackupDir, 'backup-manifest.json'), 'utf8'));
  assert.ok(manifest.configuration.excludedSecrets.includes('AOC_ENTERPRISE_API_KEYS'));
  const raw = readFileSync(join(sharedBackupDir, 'backup-manifest.json'), 'utf8');
  assert.ok(!raw.includes('AOC_ENTERPRISE_API_KEYS='), 'manifest must never embed an actual secret value');
});

test('successful restore into a fresh target opens all four stores healthy', async () => {
  const target = join(workDir('restore-ok'), 'target');
  const report = await runRestore({ backup: sharedBackupDir, target });
  assert.equal(report.status, 'restored');
  for (const name of ['governance', 'agent-passport', 'assurance', 'kernel-authority']) {
    assert.equal(report.objectVerification[name].status, 'healthy');
  }
  rmSync(dirname(target), { recursive: true, force: true });
});

test('full backup -> restore -> compare proves logical equivalence across Governance, Evidence, Passport, Assurance, and Kernel Authority', async () => {
  const root = workDir('roundtrip');
  const preDir = join(root, 'pre');
  const backupDir = join(root, 'backup');
  const postDir = join(root, 'post');
  try {
    await generateFixture({ target: preDir });
    await runBackup({ output: backupDir, env: backupEnvFor(preDir) });
    await runRestore({ backup: backupDir, target: postDir });
    const comparison = await comparePortabilityState({ pre: preDir, post: postDir, fixture: join(preDir, 'fixture-manifest.json') });
    assert.equal(comparison.governance.equivalent, true);
    assert.equal(comparison.evidence.equivalent, true);
    assert.equal(comparison.passport.equivalent, true);
    assert.equal(comparison.assurance.equivalent, true);
    assert.equal(comparison.overallEquivalent, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('backup rejects when a required store is missing, and leaves no partial output directory', async () => {
  const root = workDir('missing-store');
  const preDir = join(root, 'pre');
  const outputDir = join(root, 'backup');
  try {
    await generateFixture({ target: preDir });
    unlinkSync(join(preDir, 'enterprise-host.sqlite'));
    await assert.rejects(() => runBackup({ output: outputDir, env: backupEnvFor(preDir) }), /Required store 'governance'/);
    assert.equal(existsSync(outputDir), false, 'a failed backup must leave no partial output directory');
    const stagingDirs = readdirSync(root).filter((entry) => entry.includes('backup-staging'));
    assert.deepEqual(stagingDirs, [], 'staging directory must be cleaned up on failure');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('backup refuses the memory persistence provider (nothing durable to back up)', async () => {
  const root = workDir('memory-provider');
  try {
    await assert.rejects(
      () => runBackup({ output: join(root, 'backup'), env: { ...process.env, AOC_ENTERPRISE_PERSISTENCE_PROVIDER: 'memory' } }),
      /requires AOC_ENTERPRISE_PERSISTENCE_PROVIDER=sqlite/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('backup refuses to overwrite an existing non-empty output directory without --force, and succeeds with it', async () => {
  const root = workDir('overwrite');
  const preDir = join(root, 'pre');
  const outputDir = join(root, 'backup');
  try {
    await generateFixture({ target: preDir });
    await runBackup({ output: outputDir, env: backupEnvFor(preDir) });
    await assert.rejects(() => runBackup({ output: outputDir, env: backupEnvFor(preDir) }), /already exists and is non-empty/);
    const secondReport = await runBackup({ output: outputDir, force: true, env: backupEnvFor(preDir) });
    assert.ok(secondReport.backupId);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('restore rejects an unsupported (future) backup format', async () => {
  const root = workDir('bad-format');
  try {
    const badBackup = join(root, 'backup');
    const cp = await import('node:fs');
    cp.cpSync(sharedBackupDir, badBackup, { recursive: true });
    const manifestPath = join(badBackup, 'backup-manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.backupFormat = 'aoc.enterprise.backup.v99';
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    await assert.rejects(() => runRestore({ backup: badBackup, target: join(root, 'target') }), /Unsupported backup format/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('restore rejects a checksum mismatch (tampered or corrupted store file)', async () => {
  const root = workDir('checksum-mismatch');
  try {
    const badBackup = join(root, 'backup');
    const cp = await import('node:fs');
    cp.cpSync(sharedBackupDir, badBackup, { recursive: true });
    const governancePath = join(badBackup, 'stores', 'governance.sqlite');
    const bytes = readFileSync(governancePath);
    bytes[Math.floor(bytes.length / 2)] ^= 0xff;
    writeFileSync(governancePath, bytes);
    await assert.rejects(() => runRestore({ backup: badBackup, target: join(root, 'target') }), /Checksum mismatch/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('restore rejects a store whose SQLite integrity check fails even when its checksum matches the (also-recomputed) manifest', async () => {
  const root = workDir('integrity-failure');
  try {
    const badBackup = join(root, 'backup');
    const cp = await import('node:fs');
    cp.cpSync(sharedBackupDir, badBackup, { recursive: true });
    const governancePath = join(badBackup, 'stores', 'governance.sqlite');
    const bytes = readFileSync(governancePath);
    // Corrupt well past the file header so the file still "looks like"
    // SQLite (same magic bytes) but its internal page structure is invalid.
    for (let offset = bytes.length - 200; offset < bytes.length - 100; offset += 1) bytes[offset] = 0;
    writeFileSync(governancePath, bytes);
    // Recompute the checksum against the now-corrupted bytes so this test
    // isolates the integrity-check guard from the checksum guard.
    const manifestPath = join(badBackup, 'backup-manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const entry = manifest.stores.find((s) => s.name === 'governance');
    entry.checksum = sha256(governancePath);
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    await assert.rejects(() => runRestore({ backup: badBackup, target: join(root, 'target') }), /SQLite integrity check failed|Checksum mismatch/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('restore rejects a store recorded under an unsupported (future) schema version', async () => {
  const root = workDir('future-schema');
  try {
    const badBackup = join(root, 'backup');
    const cp = await import('node:fs');
    cp.cpSync(sharedBackupDir, badBackup, { recursive: true });
    const manifestPath = join(badBackup, 'backup-manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.stores.find((s) => s.name === 'governance').schemaVersion = 'aoc.governance-store.schema.v99';
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    await assert.rejects(() => runRestore({ backup: badBackup, target: join(root, 'target') }), /unsupported schema version|Store 'governance' was backed up under schema version/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('restore rejects an existing target without --force, and succeeds with --force after taking a pre-restore safety copy', async () => {
  const root = workDir('existing-target');
  const target = join(root, 'target');
  try {
    await runRestore({ backup: sharedBackupDir, target });
    await assert.rejects(() => runRestore({ backup: sharedBackupDir, target }), /already has store file/);
    const report = await runRestore({ backup: sharedBackupDir, target, force: true });
    assert.equal(report.status, 'restored');
    assert.ok(report.preRestoreSafetyCopy && existsSync(report.preRestoreSafetyCopy), 'a pre-restore safety copy must exist before destructive replacement');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('restore rejects a manifest declaring a store filename that path-traverses out of stores/', async () => {
  const root = workDir('path-traversal');
  try {
    const badBackup = join(root, 'backup');
    const cp = await import('node:fs');
    cp.cpSync(sharedBackupDir, badBackup, { recursive: true });
    const manifestPath = join(badBackup, 'backup-manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.stores.find((s) => s.name === 'governance').filename = '../../../etc/passwd';
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    await assert.rejects(() => runRestore({ backup: badBackup, target: join(root, 'target') }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('restore rejects a symlinked store file in the backup set', async () => {
  const root = workDir('symlink');
  try {
    const badBackup = join(root, 'backup');
    const cp = await import('node:fs');
    cp.cpSync(sharedBackupDir, badBackup, { recursive: true });
    const governancePath = join(badBackup, 'stores', 'governance.sqlite');
    unlinkSync(governancePath);
    symlinkSync('/etc/passwd', governancePath);
    await assert.rejects(() => runRestore({ backup: badBackup, target: join(root, 'target') }), /symlink/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('restore rejects an unexpected extra file in the backup stores/ directory', async () => {
  const root = workDir('extra-file');
  try {
    const badBackup = join(root, 'backup');
    const cp = await import('node:fs');
    cp.cpSync(sharedBackupDir, badBackup, { recursive: true });
    writeFileSync(join(badBackup, 'stores', 'unexpected.sqlite'), 'not a real database');
    await assert.rejects(() => runRestore({ backup: badBackup, target: join(root, 'target') }), /Unexpected file/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('restore rejects a malformed (non-JSON) manifest', async () => {
  const root = workDir('malformed-manifest');
  try {
    const badBackup = join(root, 'backup');
    const cp = await import('node:fs');
    cp.cpSync(sharedBackupDir, badBackup, { recursive: true });
    writeFileSync(join(badBackup, 'backup-manifest.json'), '{ this is not valid json');
    await assert.rejects(() => runRestore({ backup: badBackup, target: join(root, 'target') }), /not valid JSON/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('restore and backup both refuse an output/target path that overlaps a source store path', async () => {
  const root = workDir('path-overlap');
  const preDir = join(root, 'pre');
  try {
    await generateFixture({ target: preDir });
    await assert.rejects(() => runBackup({ output: preDir, env: backupEnvFor(preDir) }), /must not be nested/);
    await assert.rejects(() => runRestore({ backup: sharedBackupDir, target: sharedBackupDir }), /must not be identical|must not be nested/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('restored stores can be closed and reopened cleanly (use-after-restore)', async () => {
  const root = workDir('reopen');
  const target = join(root, 'target');
  try {
    await runRestore({ backup: sharedBackupDir, target });
    const enterpriseModule = await import('../dist/src/enterprise/index.js');
    const store = await enterpriseModule.createSqliteGovernanceStore(join(target, 'enterprise-host.sqlite'));
    const health = await store.health();
    assert.equal(health.status, 'healthy');
    await store.close();
    const reopened = await enterpriseModule.createSqliteGovernanceStore(join(target, 'enterprise-host.sqlite'));
    assert.equal((await reopened.health()).status, 'healthy');
    await reopened.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
