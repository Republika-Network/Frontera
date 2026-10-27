#!/usr/bin/env node
// AUTH-04D1 — the Authority pilot backup profile.
//
// A narrow profile ON TOP of backup:v1 / restore:v1, never a replacement:
// the store list, the SQLite Online Backup copy, integrity and schema checks,
// the signed-head and organization binding, staging, deep verification under
// the trusted authority keys and the rolled-back promotion are exactly theirs.
// This profile adds only what the single-organization Authority pilot needs:
//
//   - preconditions  the human-decision authority is composed, the CORE-07
//                    witness is external, and the backup is cold (the Host is
//                    stopped): the identity store and CORE-05 move together
//   - completeness   coverage must be complete and must include the human
//                    identity and approval stores with their signed heads;
//                    nothing "missing-allowed", no legacy or incomplete restore
//   - confidentiality the set is sealed into one AES-256-GCM file
//                    (lib-sealed-backup.mjs); plaintext exists only in a
//                    private temporary directory on the machine that already
//                    holds the stores, and is removed on every path
//   - verification   `verify` unseals, restores into a throwaway target with
//                    the restoring deployment's environment, and requires the
//                    signed stores to verify under the trusted keys
//
// It never contacts, reads, resets or enrolls the CORE-07 witness. Whether a
// restored state is current is decided by the Host at startup, against the
// SURVIVING witness (docs/security/AUTH-04D1-AUTHORITY-PILOT-RECOVERY-READINESS.md).
//
// Usage:
//   authority-pilot-backup.mjs keygen  --out <key-file>
//   authority-pilot-backup.mjs backup  --output <sealed-file> --key-file <key-file>
//   authority-pilot-backup.mjs verify  --archive <sealed-file> --key-file <key-file>
//   authority-pilot-backup.mjs restore --archive <sealed-file> --key-file <key-file> --target <dir> [--force]
//   authority-pilot-backup.mjs inspect --archive <sealed-file>
// Run backup, verify and restore with the Host's (or the restoring Host's) environment.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { runBackup } from './backup-enterprise-v1.mjs';
import { runRestore } from './restore-enterprise-v1.mjs';
import { loadEnterpriseModule } from './lib-portability.mjs';
import { canonicalJson, generateBackupKey, readBackupKey, readSealedHeader, sealBackupSet, unsealBackupSet, SealedBackupError } from './lib-sealed-backup.mjs';

/** The authority stores the profile requires, each with its signed head. */
export const AUTHORITY_PILOT_SIGNED_STORES = Object.freeze(['approvals', 'human-identity']);

export class AuthorityPilotBackupError extends Error {}

function privateWorkDir() {
  // mkdtemp creates the directory owner-only (0700).
  return mkdtempSync(join(tmpdir(), 'frontera-authority-pilot-'));
}

/** The profile's preconditions on the Host environment. Names variables, never values. */
async function assertAuthorityPilotDeployment(env, purpose) {
  const enterprise = await loadEnterpriseModule();
  const configuration = enterprise.loadEnterpriseConfiguration(env);
  if (configuration.persistence.provider !== 'sqlite') throw new AuthorityPilotBackupError(`The Authority pilot ${purpose} requires AOC_ENTERPRISE_PERSISTENCE_PROVIDER=sqlite.`);
  if (configuration.humanAuthority?.mode !== 'enabled') throw new AuthorityPilotBackupError(`The Authority pilot ${purpose} is for a Host with AOC_ENTERPRISE_HUMAN_AUTHORITY_MODE=enabled; use backup:v1 / restore:v1 otherwise.`);
  if (configuration.authorityFreshness?.mode !== 'external') throw new AuthorityPilotBackupError(`The Authority pilot ${purpose} requires the external CORE-07 witness (AOC_ENTERPRISE_AUTHORITY_FRESHNESS_MODE=external).`);
  // Signed authority state is restored only after it verifies: the trusted public keys must be known before anything is unsealed.
  if (purpose !== 'backup' && (configuration.authorityAuthenticity?.verificationKeys ?? []).length === 0) {
    throw new AuthorityPilotBackupError(`The Authority pilot ${purpose} requires the trusted authority verification keys (AOC_ENTERPRISE_AUTHORITY_VERIFICATION_KEYS, public keys).`);
  }
  return configuration;
}

/** The public binding of the backup: organization, store ids, signed heads, sequences. Read from the manifest backup:v1 wrote. */
export function authorityBinding(manifest) {
  if (manifest?.coverage?.complete !== true) throw new AuthorityPilotBackupError('The backup set is not complete; the Authority pilot profile never keeps an incomplete backup.');
  const organizationId = manifest.coverage.deployment?.organizationId;
  if (typeof organizationId !== 'string' || organizationId.length === 0) throw new AuthorityPilotBackupError('The backup set names no organization.');
  if (manifest.coverage.deployment.humanAuthorityEnabled !== true) throw new AuthorityPilotBackupError('The backup set was not taken from a Host with the human-decision authority enabled.');
  const authorityStores = manifest.stores
    .filter((store) => store.signedHead !== undefined)
    .map((store) => ({
      name: store.name,
      storeId: store.signedHead.storeId,
      organizationId: store.signedHead.organizationId,
      sequence: store.signedHead.sequence,
      stateDigest: store.signedHead.stateDigest,
      signingKeyId: store.signedHead.signingKeyId,
      freshnessStateKind: store.signedHead.freshnessStateKind,
    }));
  for (const name of AUTHORITY_PILOT_SIGNED_STORES) {
    const store = authorityStores.find((entry) => entry.name === name);
    if (store === undefined) throw new AuthorityPilotBackupError(`The backup set does not include the signed '${name}' store; the Authority pilot cannot be recovered without it.`);
    if (store.organizationId !== organizationId) throw new AuthorityPilotBackupError(`The '${name}' store is bound to another organization than the backup's.`);
  }
  return {
    backupId: manifest.backupId,
    createdAt: manifest.createdAt,
    sourceCommit: manifest.source?.commit ?? 'unknown',
    organizationId,
    consistency: manifest.consistency?.mode,
    coverageComplete: true,
    authorityStores,
    witnessId: manifest.authority?.freshness?.witnessId ?? null,
  };
}

const readManifest = (dir) => JSON.parse(readFileSync(join(dir, 'backup-manifest.json'), 'utf8'));

/** Cold, complete, sealed. `output` is created exclusively; plaintext never outlives the call. */
export async function runAuthorityPilotBackup({ output, keyFile, env }) {
  await assertAuthorityPilotDeployment(env, 'backup');
  const key = readBackupKey(keyFile);
  const work = privateWorkDir();
  try {
    const set = join(work, 'backup-set');
    // backup:v1, cold: it refuses a store with a non-empty WAL (a running Host) and a missing required store.
    await runBackup({ output: set, cold: true, env });
    const binding = authorityBinding(readManifest(set));
    if (binding.consistency !== 'cold-attested') throw new AuthorityPilotBackupError('The Authority pilot backup is cold only.');
    const sealed = sealBackupSet({ sourceDir: set, outputFile: resolve(output), key, header: { ...binding, sealedAt: new Date().toISOString() } });
    return { status: 'sealed', sealedFile: resolve(output), sha256: sealed.sha256, sealedBytes: sealed.sealedBytes, keyId: sealed.header.keyId, ...binding };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** The restored-and-verified report the profile accepts: every signed store verified under the trusted keys. */
function assertVerified(report) {
  if (report.status !== 'restored' || report.coverage?.complete !== true) throw new AuthorityPilotBackupError('The backup did not restore completely.');
  for (const [name, verification] of Object.entries(report.objectVerification ?? {})) {
    if (verification?.signedHead !== undefined && verification.authenticity !== 'verified-under-trusted-keys') {
      throw new AuthorityPilotBackupError(`The signed '${name}' store was not verified under trusted authority keys (${String(verification.authenticity)}); supply AOC_ENTERPRISE_AUTHORITY_VERIFICATION_KEYS.`);
    }
  }
  for (const name of AUTHORITY_PILOT_SIGNED_STORES) {
    if (report.objectVerification?.[name]?.authenticity !== 'verified-under-trusted-keys') throw new AuthorityPilotBackupError(`The '${name}' store did not verify under the trusted authority keys.`);
  }
}

/** The sealed header and the manifest inside must describe the same backup. */
function assertHeaderMatches(header, manifest) {
  const binding = authorityBinding(manifest);
  if (header.backupId !== binding.backupId || header.organizationId !== binding.organizationId) throw new AuthorityPilotBackupError('The sealed header does not describe the backup it holds.');
  if (canonicalJson(header.authorityStores) !== canonicalJson(binding.authorityStores)) throw new AuthorityPilotBackupError('The sealed header records other signed heads than the backup it holds.');
  return binding;
}

async function withUnsealed({ archive, keyFile }, work, use) {
  const key = readBackupKey(keyFile);
  const set = join(work, 'backup-set');
  const { header } = unsealBackupSet({ sealedFile: resolve(archive), key, outputDir: set });
  const binding = assertHeaderMatches(header, readManifest(set));
  return use(set, header, binding);
}

/** Explicit verification: unseal, restore into a throwaway target under the restoring deployment's environment, require trusted-key verification, discard. */
export async function runAuthorityPilotVerify({ archive, keyFile, env }) {
  await assertAuthorityPilotDeployment(env, 'verification');
  const work = privateWorkDir();
  try {
    return await withUnsealed({ archive, keyFile }, work, async (set, header, binding) => {
      const report = await runRestore({ backup: set, target: join(work, 'verify-target'), env });
      assertVerified(report);
      return { status: 'verified', keyId: header.keyId, ...binding, objectVerification: report.objectVerification, freshnessWitness: 'not contacted: whether this state is current is decided by the Host at startup, against the surviving witness' };
    });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Restore: unseal privately, then restore:v1 into `target` (complete only, verified only). The witness is never touched. */
export async function runAuthorityPilotRestore({ archive, keyFile, target, env, force = false }) {
  await assertAuthorityPilotDeployment(env, 'restore');
  const work = privateWorkDir();
  try {
    return await withUnsealed({ archive, keyFile }, work, async (set, header, binding) => {
      // restore:v1 verifies every signed store under the trusted keys (required above) before it promotes anything.
      const report = await runRestore({ backup: set, target: resolve(target), env, force });
      assertVerified(report);
      return { ...report, keyId: header.keyId, authorityBinding: binding };
    });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** The public header, without the key: which organization, which backup, which signed heads (compare with the witness before restoring). */
export function inspectSealedBackup(archive) {
  return readSealedHeader(readFileSync(resolve(archive))).header;
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const args = { command, force: false };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === '--output') args.output = rest[++i];
    else if (arg === '--out') args.out = rest[++i];
    else if (arg === '--key-file') args.keyFile = rest[++i];
    else if (arg === '--archive') args.archive = rest[++i];
    else if (arg === '--target') args.target = rest[++i];
    else if (arg === '--force') args.force = true;
    else throw new AuthorityPilotBackupError(`Unknown argument: ${arg}`);
  }
  return args;
}

const USAGE = 'Usage: authority-pilot-backup.mjs keygen --out <key-file> | backup --output <sealed-file> --key-file <key-file> | verify --archive <sealed-file> --key-file <key-file> | restore --archive <sealed-file> --key-file <key-file> --target <dir> [--force] | inspect --archive <sealed-file>';

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const need = (...names) => {
    for (const name of names) if (args[name] === undefined) throw new AuthorityPilotBackupError(USAGE);
  };
  let report;
  if (args.command === 'keygen') {
    need('out');
    report = { status: 'generated', keyFile: resolve(args.out), ...generateBackupKey(args.out), note: 'Store this key in the secret manager, apart from the backup storage and the witness. Without it no sealed backup can be read.' };
  } else if (args.command === 'backup') {
    need('output', 'keyFile');
    report = await runAuthorityPilotBackup({ output: args.output, keyFile: args.keyFile, env: process.env });
  } else if (args.command === 'verify') {
    need('archive', 'keyFile');
    report = await runAuthorityPilotVerify({ archive: args.archive, keyFile: args.keyFile, env: process.env });
  } else if (args.command === 'restore') {
    need('archive', 'keyFile', 'target');
    report = await runAuthorityPilotRestore({ archive: args.archive, keyFile: args.keyFile, target: args.target, env: process.env, force: args.force });
  } else if (args.command === 'inspect') {
    need('archive');
    report = inspectSealedBackup(args.archive);
  } else {
    throw new AuthorityPilotBackupError(USAGE);
  }
  console.log(JSON.stringify(report, null, 2));
  if (args.command === 'restore') console.log('Start the Host on the restored stores against the SURVIVING witness. If it refuses with AUTHORITY_FRESHNESS_ROLLBACK_DETECTED, this backup is older than the witnessed state: never reset or re-enroll the witness.');
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
if (isMain) {
  main().catch((error) => {
    const known = error instanceof AuthorityPilotBackupError || error instanceof SealedBackupError;
    console.error(`[authority-pilot-backup] ${known ? error.message : `failed: ${error.message}`}`);
    process.exitCode = 1;
  });
}
