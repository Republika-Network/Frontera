// PROD-03 — a REAL backup:v1 set for the readiness gate's unit tests (not a
// drill fixture: the clean-room drill takes its backups with the supported CLI
// against its own deployment, and never imports anything from this directory): the PROD-02
// portability fixture deployment (seeded through the Enterprise Host's own
// services) backed up, cold, by the real backup command. Plus consistent
// forgeries of it: an attacker who can write the backup directory rewrites
// the manifest and checksums.sha256 to agree with whatever it changed.
//
// Requires `npm run build` (tests run through `npm test`, which builds first).
import { createHash } from 'node:crypto';
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { generateFixture } from '../../../scripts/portability/generate-portability-fixture.mjs';
import { runBackup } from '../../../scripts/portability/backup-enterprise-v1.mjs';
import { deriveDeploymentRequirements } from '../../../scripts/portability/store-registry.mjs';

/** The fixture deployment's environment (no governed-action file: five stores). */
export function fixtureEnv(preDir, extra = {}) {
  return {
    ...process.env,
    AOC_ENTERPRISE_PERSISTENCE_PROVIDER: 'sqlite',
    AOC_ENTERPRISE_SQLITE_PATH: join(preDir, 'enterprise-host.sqlite'),
    AOC_ENTERPRISE_PASSPORT_SQLITE_PATH: join(preDir, 'agent-passport.sqlite'),
    AOC_ENTERPRISE_ASSURANCE_SQLITE_PATH: join(preDir, 'assurance.sqlite'),
    AOC_ENTERPRISE_KERNEL_AUTHORITY_SQLITE_PATH: join(preDir, 'kernel-authority.sqlite'),
    AOC_ENTERPRISE_EVIDENCE_SQLITE_PATH: join(preDir, 'evidence-bundles.sqlite'),
    AOC_ENTERPRISE_KERNEL_AUTHORITY_ENABLED: 'true',
    AOC_ENTERPRISE_GOVERNED_ACTIONS_FILE: '',
    ...extra,
  };
}

/** What the gate's preflight returns as `deploymentRequirements` in that environment: PROD-02's canonical derivation. */
export function requirementsOf(env) {
  return deriveDeploymentRequirements(env, { persistence: { provider: 'sqlite' }, kernelAuthority: { enabled: env.AOC_ENTERPRISE_KERNEL_AUTHORITY_ENABLED === 'true' } });
}

/** A real cold backup of the fixture deployment under `root`. */
export async function createRealBackup(root) {
  const pre = join(root, 'pre');
  const dir = join(root, 'real-backup');
  await generateFixture({ target: pre });
  await runBackup({ output: dir, env: fixtureEnv(pre), cold: true });
  return { dir, pre, requirements: requirementsOf(fixtureEnv(pre)), manifest: JSON.parse(readFileSync(join(dir, 'backup-manifest.json'), 'utf8')) };
}

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** An exact copy. */
export function copyBackup(source, dest) {
  cpSync(source, dest, { recursive: true });
  return dest;
}

/**
 * A consistent forgery: `edit(dir, manifest)` may change files and the parsed
 * manifest; the manifest is rewritten, and every checksums.sha256 entry whose
 * file still exists is recomputed (entries for removed files are dropped).
 */
export function forgeBackup(source, dest, edit) {
  cpSync(source, dest, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(dest, 'backup-manifest.json'), 'utf8'));
  edit(dest, manifest);
  writeFileSync(join(dest, 'backup-manifest.json'), JSON.stringify(manifest));
  const files = readFileSync(join(dest, 'checksums.sha256'), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => line.replace(/^[0-9a-f]{64} {2}/, '').trim());
  const lines = [];
  for (const file of files) {
    try {
      lines.push(`${sha(readFileSync(join(dest, file)))}  ${file}`);
    } catch {
      // removed by the edit
    }
  }
  writeFileSync(join(dest, 'checksums.sha256'), `${lines.join('\n')}\n`);
  return dest;
}

/** The real backup re-bound to a deployment identity (organization, release, id) — still complete and consistent. */
export function reboundBackup(source, dest, { organizationId, commit, backupId, createdAt }) {
  return forgeBackup(source, dest, (dir, manifest) => {
    manifest.coverage.deployment.organizationId = organizationId;
    manifest.source.commit = commit;
    if (backupId !== undefined) manifest.backupId = backupId;
    if (createdAt !== undefined) manifest.createdAt = createdAt;
  });
}
