#!/usr/bin/env node
// AOC Enterprise v1 restore command (`npm run restore:v1 -- --backup <dir> --target <dir>`).
//
// Fail closed, in this order, before the target directory is touched:
//
//   1. manifest     format, required fields, closed store names (the registry),
//                   no duplicate name or filename, each name's registry filename
//   2. coverage     PROD-02 coverage model; every store the backup's own
//                   deployment requires is included (re-derived here, never
//                   trusted from the producer); every store the RESTORING
//                   deployment requires is included (when its environment is
//                   given); a pre-PROD-02 backup has no coverage and is refused
//                   unless explicitly accepted as incomplete
//   3. files        no unexpected file, no symlink, no path escape, checksums,
//                   SQLite integrity, supported schema version, signed head
//                   structurally consistent with its rows and equal to the
//                   manifest's record of it
//   4. staging      every store copied into a staging directory beside the
//                   target and re-checksummed
//   5. deep verify  each staged store opened through its own factory, on a
//                   scratch copy; the three signed stores verified under the
//                   trusted authority keys when they are supplied
//
// Only then is anything promoted. With --force, every registry-managed file
// already in the target (and its -wal/-shm sidecars) is first moved into a
// pre-restore safety directory; a failure at any point after that rolls the
// target back to exactly what it was. A restore never creates a store that is
// not in the backup, and never touches the CORE-07 freshness witness.
//
// Usage:
//   node scripts/portability/restore-enterprise-v1.mjs --backup <dir> --target <dir>
//        [--force] [--allow-incomplete] [--allow-legacy-backup]

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, copyFileSync, rmSync, renameSync, lstatSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';

import {
  BACKUP_FORMAT,
  REPO_ROOT,
  loadEnterpriseModule,
  sha256File,
  stableJsonStringify,
  assertNoPathOverlap,
  assertContained,
  assertNotSymlink,
  sqliteIntegrityCheck,
  readStoreVersion,
  readSignedHead,
  sqliteSidecars,
  cleanupDir,
} from './lib-portability.mjs';
import {
  COVERAGE_MODEL,
  STORE_DEFINITIONS,
  conditionHolds,
  deriveDeploymentRequirements,
  loadRegistryModules,
  storeDefinitionByName,
  targetStorePaths,
} from './store-registry.mjs';

function parseArgs(argv) {
  const args = { force: false, allowIncomplete: false, allowLegacyBackup: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--backup') args.backup = argv[++i];
    else if (arg === '--target') args.target = argv[++i];
    else if (arg === '--force' || arg === '--replace') args.force = true;
    else if (arg === '--allow-incomplete') args.allowIncomplete = true;
    else if (arg === '--allow-legacy-backup') args.allowLegacyBackup = true;
    else if (arg === '--no-target-check') args.noTargetCheck = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!args.backup || !args.target) throw new Error('Usage: restore-enterprise-v1.mjs --backup <dir> --target <dir> [--force] [--allow-incomplete] [--allow-legacy-backup] [--no-target-check]');
  return args;
}

export class RestoreValidationError extends Error {}

// -- 1. manifest ---------------------------------------------------------------------

function loadAndValidateManifest(backupPath) {
  const manifestPath = join(backupPath, 'backup-manifest.json');
  if (!existsSync(manifestPath)) throw new RestoreValidationError(`No backup-manifest.json found in '${backupPath}'.`);
  assertNotSymlink(manifestPath, 'backup-manifest.json');

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    throw new RestoreValidationError(`backup-manifest.json is not valid JSON: ${error.message}`);
  }
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) throw new RestoreValidationError('Malformed manifest: it must be a JSON object.');

  if (manifest.backupFormat !== BACKUP_FORMAT) {
    throw new RestoreValidationError(
      `Unsupported backup format '${manifest.backupFormat}'. This runtime supports only '${BACKUP_FORMAT}'. ` +
        'A newer format must never be silently accepted; an older format requires an explicit migration path that does not exist in v1.',
    );
  }
  for (const field of ['backupId', 'createdAt', 'source', 'enterprise', 'stores', 'configuration', 'verification']) {
    if (!(field in manifest)) throw new RestoreValidationError(`Malformed manifest: missing required field '${field}'.`);
  }
  if (typeof manifest.backupId !== 'string' || !/^[A-Za-z0-9._-]{1,200}$/.test(manifest.backupId)) {
    throw new RestoreValidationError('Malformed manifest: backupId must be 1-200 letters, digits, ".", "_" or "-".');
  }
  if (!Array.isArray(manifest.stores) || manifest.stores.length === 0) {
    throw new RestoreValidationError('Malformed manifest: "stores" must be a non-empty array.');
  }

  const names = new Set();
  const filenames = new Set();
  for (const entry of manifest.stores) {
    if (entry === null || typeof entry !== 'object') throw new RestoreValidationError('Malformed manifest: every store entry must be an object.');
    for (const field of ['name', 'filename', 'checksum', 'schemaVersion']) {
      if (entry[field] === undefined || entry[field] === null) throw new RestoreValidationError(`Malformed manifest: store entry is missing '${field}'.`);
    }
    if (names.has(entry.name)) throw new RestoreValidationError(`Malformed manifest: store '${entry.name}' appears more than once.`);
    if (filenames.has(entry.filename)) throw new RestoreValidationError(`Malformed manifest: file '${entry.filename}' is claimed by more than one store.`);
    names.add(entry.name);
    filenames.add(entry.filename);
    const storeDef = storeDefinitionByName(entry.name);
    // A store this runtime does not know cannot be mapped, verified or opened.
    // It might be authority state a newer build depends on: refuse, never skip.
    if (storeDef === undefined) throw new RestoreValidationError(`Unknown store '${String(entry.name)}' in the manifest. This runtime's registry does not know it; refusing rather than dropping it.`);
    if (entry.filename !== storeDef.filename) {
      throw new RestoreValidationError(`Store '${entry.name}' must be stored as 'stores/${storeDef.filename}', but the manifest names '${String(entry.filename)}'.`);
    }
  }
  return manifest;
}

// -- 2. coverage ---------------------------------------------------------------------

/** Every deployment flag a store condition reads. */
const DEPLOYMENT_FLAGS = ['kernelAuthorityEnabled', 'governedActions', 'obligationsDeclared', 'approvalsDeclared', 'operatorsConfigured', 'executionReconciliation'];

/**
 * Which required stores the backup does not include, judged two ways and
 * never by trusting the producer's own `complete` flag:
 *
 * - against the backup's own recorded deployment, with THIS build's conditions
 *   (so a backup from an older registry that omitted a store the deployment
 *   composed is caught);
 * - against the restoring deployment's environment, when one is given.
 */
function assessCoverage(manifest, targetRequirements) {
  const included = new Set(manifest.stores.map((entry) => entry.name));
  if (manifest.coverage === undefined) {
    const missingForTarget = targetRequirements === undefined ? [] : STORE_DEFINITIONS.filter((d) => conditionHolds(d.condition, targetRequirements) && !included.has(d.name)).map((d) => d.name);
    return { model: 'legacy', complete: false, missingForSource: null, missingForTarget, reason: 'pre-PROD-02 backup: no coverage record, so it cannot be shown to be complete' };
  }
  const coverage = manifest.coverage;
  if (coverage === null || typeof coverage !== 'object' || coverage.coverageModel !== COVERAGE_MODEL) {
    throw new RestoreValidationError(`Unsupported coverage model '${String(coverage?.coverageModel)}'. This runtime understands only '${COVERAGE_MODEL}'; an unknown model fails closed.`);
  }
  if (coverage.deployment === null || typeof coverage.deployment !== 'object' || !Array.isArray(coverage.stores)) {
    throw new RestoreValidationError('Malformed manifest: coverage must record the source deployment and every store.');
  }
  // The producer's record is input, never trusted shape: every flag a
  // condition reads must be a real boolean (a string "true" would read as
  // false and quietly un-require a store), the organization must be named,
  // and every registry store must be accounted for exactly once.
  for (const flag of DEPLOYMENT_FLAGS) {
    if (typeof coverage.deployment[flag] !== 'boolean') throw new RestoreValidationError(`Malformed manifest: coverage.deployment.${flag} must be a boolean.`);
  }
  if (typeof coverage.deployment.organizationId !== 'string' || coverage.deployment.organizationId.length === 0) {
    throw new RestoreValidationError('Malformed manifest: coverage.deployment.organizationId must name the organization the backup belongs to.');
  }
  if (typeof coverage.complete !== 'boolean') throw new RestoreValidationError('Malformed manifest: coverage.complete must be a boolean.');
  for (const storeDef of STORE_DEFINITIONS) {
    const entries = coverage.stores.filter((entry) => entry?.name === storeDef.name);
    if (entries.length !== 1) throw new RestoreValidationError(`Malformed manifest: coverage must record store '${storeDef.name}' exactly once.`);
    if (typeof entries[0].required !== 'boolean' || typeof entries[0].included !== 'boolean') throw new RestoreValidationError(`Malformed manifest: coverage of '${storeDef.name}' must say whether it is required and included.`);
  }
  for (const entry of coverage.stores) {
    if (storeDefinitionByName(entry?.name) === undefined) throw new RestoreValidationError(`Unknown store '${String(entry?.name)}' in coverage.`);
  }
  for (const entry of coverage.stores) {
    if (entry?.included === true && !included.has(entry.name)) throw new RestoreValidationError(`Malformed manifest: coverage says '${String(entry.name)}' is included, but the manifest has no such store.`);
  }
  for (const name of included) {
    if (!coverage.stores.some((entry) => entry?.name === name && entry.included === true)) throw new RestoreValidationError(`Malformed manifest: store '${name}' is not recorded as included in coverage.`);
  }
  const missingForSource = STORE_DEFINITIONS.filter((d) => conditionHolds(d.condition, coverage.deployment) && !included.has(d.name)).map((d) => d.name);
  const missingForTarget = targetRequirements === undefined ? [] : STORE_DEFINITIONS.filter((d) => conditionHolds(d.condition, targetRequirements) && !included.has(d.name)).map((d) => d.name);
  // Whatever the producer itself recorded as required-but-absent stays absent.
  const declaredMissing = coverage.stores.filter((entry) => entry.required === true && entry.included !== true).map((entry) => entry.name);
  const complete = missingForSource.length === 0 && missingForTarget.length === 0 && declaredMissing.length === 0 && coverage.complete === true;
  const reasons = [];
  if (missingForSource.length > 0) reasons.push(`the source deployment composed ${missingForSource.join(', ')}, which the backup does not include`);
  if (missingForTarget.length > 0) reasons.push(`the restoring deployment requires ${missingForTarget.join(', ')}, which the backup does not include`);
  if (declaredMissing.length > 0) reasons.push(`the backup records ${declaredMissing.join(', ')} as required but not included`);
  if (coverage.complete !== true) reasons.push('the backup records itself as incomplete');
  if (coverage.complete === true && (missingForSource.length > 0 || declaredMissing.length > 0)) reasons.push('the manifest claims to be complete, which it is not');
  return { model: COVERAGE_MODEL, complete, missingForSource, missingForTarget, reason: reasons.join('; ') };
}

// -- 3. files ------------------------------------------------------------------------

function assertNoUnexpectedFiles(storesDir, manifestStores) {
  const expected = new Set(manifestStores.map((s) => s.filename));
  const actual = readdirSync(storesDir);
  for (const file of actual) {
    if (!expected.has(file)) {
      throw new RestoreValidationError(`Unexpected file '${file}' in backup stores/ directory -- refusing to restore a backup set with extra, unmanifested files.`);
    }
  }
  for (const filename of expected) {
    if (!actual.includes(filename)) {
      throw new RestoreValidationError(`Manifest declares store file '${filename}' but it is missing from stores/.`);
    }
  }
}

/**
 * Every check on one store file. Anything the file itself makes SQLite throw
 * (a malformed page, a missing table) is a refusal that names the store — never
 * a raw driver error, and never a partial pass.
 */
async function verifyStoreFile(filePath, entry, storeDef, modules, where) {
  try {
    return await verifyStoreFileUnchecked(filePath, entry, storeDef, modules, where);
  } catch (error) {
    if (error instanceof RestoreValidationError) throw error;
    throw new RestoreValidationError(`Store '${storeDef.name}'${where} could not be read as a valid SQLite database (${error.message}).`);
  }
}

async function verifyStoreFileUnchecked(filePath, entry, storeDef, modules, where) {
  const actualChecksum = sha256File(filePath);
  if (actualChecksum !== entry.checksum) {
    throw new RestoreValidationError(`Checksum mismatch for store '${storeDef.name}'${where}: manifest says '${entry.checksum}', file is '${actualChecksum}'. The backup may be corrupted or tampered with.`);
  }
  const integrity = await sqliteIntegrityCheck(filePath);
  if (!integrity.ok) {
    throw new RestoreValidationError(`SQLite integrity check failed for store '${storeDef.name}'${where}: ${integrity.detail}.`);
  }
  const supported = storeDef.supportedSchemaVersionsOf(modules);
  if (!supported.includes(entry.schemaVersion)) {
    throw new RestoreValidationError(
      `Store '${storeDef.name}' was backed up under schema version '${entry.schemaVersion}', but this runtime build supports only ${supported.map((v) => `'${v}'`).join(', ')}. ` +
        'Restoring would silently open a store this build cannot correctly read. Use the build generation recorded in metadata/release-context.json instead.',
    );
  }
  const recorded = await readStoreVersion(filePath, storeDef.version);
  if (recorded.schemaVersion !== entry.schemaVersion) {
    throw new RestoreValidationError(`Store '${storeDef.name}' file records schema version '${String(recorded.schemaVersion)}', but the manifest says '${entry.schemaVersion}'.`);
  }
  // The signed head travels with its rows: never one without the other, never
  // a head that does not commit to exactly the rows present.
  const head = await readSignedHead(filePath, storeDef.signedHead);
  if (head !== null) {
    if (!head.consistent) throw new RestoreValidationError(`Store '${storeDef.name}' has an inconsistent signed head (${head.problem}); signed authority state is never restored without its exact rows.`);
    const expected = entry.signedHead;
    if (expected !== undefined && (expected.storeId !== head.storeId || expected.sequence !== head.sequence || expected.stateDigest !== head.stateDigest)) {
      throw new RestoreValidationError(`Store '${storeDef.name}' signed head does not match the head the manifest recorded at backup time.`);
    }
  }
  return head;
}

async function validateBackupSet(backupPath, manifest, modules, targetOrganizationId) {
  const storesDir = join(backupPath, 'stores');
  if (!existsSync(storesDir)) throw new RestoreValidationError('Backup set has no stores/ directory.');
  if (lstatSync(storesDir).isSymbolicLink()) throw new RestoreValidationError('Backup stores/ directory is a symlink.');

  assertNoUnexpectedFiles(storesDir, manifest.stores);

  const heads = {};
  const organizationId = manifest.coverage?.deployment?.organizationId;
  for (const entry of manifest.stores) {
    const storeDef = storeDefinitionByName(entry.name);
    const filePath = assertContained(storesDir, entry.filename, `Store '${storeDef.name}' filename`);
    assertNotSymlink(filePath, `Store '${storeDef.name}' file`);
    if (!existsSync(filePath)) throw new RestoreValidationError(`Store '${storeDef.name}' file '${entry.filename}' does not exist.`);
    heads[entry.name] = await verifyStoreFile(filePath, entry, storeDef, modules, '');
    // A signed store bound to another organization than the deployment the
    // backup describes is a transplanted store, whatever its signature says.
    const boundTo = heads[entry.name]?.organizationId;
    if (boundTo !== null && boundTo !== undefined && organizationId !== undefined && boundTo !== organizationId) {
      throw new RestoreValidationError(`Store '${storeDef.name}' is bound to organization '${boundTo}', not to the backed-up deployment's '${organizationId}'.`);
    }
    // Also against the restoring deployment itself -- this holds for a legacy
    // backup, which records no organization of its own.
    if (boundTo !== null && boundTo !== undefined && targetOrganizationId !== undefined && boundTo !== targetOrganizationId) {
      throw new RestoreValidationError(`Store '${storeDef.name}' is bound to organization '${boundTo}', but the restoring deployment serves '${targetOrganizationId}'. A store is never transplanted between organizations.`);
    }
  }
  return heads;
}

// -- 5. deep verification -------------------------------------------------------------

/** A signer that never signs: restore verification opens signed stores only to verify them. Key-rotation re-attestation is best-effort in every store and is simply skipped. */
function refusingSigner() {
  const refuse = async () => {
    throw new Error('restore verification never signs');
  };
  return Object.freeze({
    activeKeyId: 'restore-verification-never-signs',
    algorithm: 'ed25519-v1',
    signGrant: refuse,
    signRevocation: refuse,
    signRevocationState: refuse,
    signObligationDischargeState: refuse,
    signApprovalState: refuse,
  });
}

async function deepVerify(stagingDir, manifest, modules, heads, verificationKeys, targetOrganizationId) {
  const scratch = join(stagingDir, '.verify');
  const results = {};
  const verifier = verificationKeys.length > 0 ? modules.authenticity.createAuthorityArtifactVerifier(verificationKeys) : undefined;
  try {
    for (const entry of manifest.stores) {
      const storeDef = storeDefinitionByName(entry.name);
      if (storeDef.signedHead !== undefined && verifier === undefined) {
        results[entry.name] = { opened: false, authenticity: 'not-checked: no trusted verification keys supplied (AOC_ENTERPRISE_AUTHORITY_VERIFICATION_KEYS)', signedHead: 'structurally-consistent' };
        continue;
      }
      // A fresh scratch copy per store: opening may write WAL sidecars or
      // re-attest, and none of that may reach the bytes being promoted.
      mkdirSync(scratch, { recursive: true });
      const scratchFile = join(scratch, storeDef.targetFilename);
      copyFileSync(join(stagingDir, storeDef.targetFilename), scratchFile);
      // Opened as the restoring deployment would open it: for its organization when known.
      const authority = { organizationId: targetOrganizationId ?? manifest.coverage?.deployment?.organizationId ?? heads[entry.name]?.organizationId, authenticity: { signer: refusingSigner(), verifier } };
      let store;
      try {
        store = await storeDef.open(modules, scratchFile, authority);
      } catch (error) {
        throw new RestoreValidationError(`Store '${storeDef.name}' does not open as a valid store: ${error.message}`);
      }
      try {
        const health = typeof store.health === 'function' ? await store.health() : { status: 'healthy' };
        if (health.status === 'unhealthy') throw new RestoreValidationError(`Restored store '${storeDef.name}' reports unhealthy status after restore.`);
        if (storeDef.name === 'bounded-grants' && health.revocationState !== 'verified') {
          throw new RestoreValidationError(`Store 'bounded-grants' revocation state does not verify under the trusted keys (${String(health.revocationStateFailure)}).`);
        }
        results[entry.name] = {
          opened: true,
          status: health.status,
          schemaVersion: health.schemaVersion ?? entry.schemaVersion,
          readable: health.readable ?? true,
          writable: health.writable ?? true,
          ...(storeDef.signedHead !== undefined ? { authenticity: 'verified-under-trusted-keys', signedHead: 'structurally-consistent' } : {}),
        };
      } finally {
        await store.close();
        cleanupDir(scratch);
      }
    }
  } finally {
    cleanupDir(scratch);
  }
  return results;
}

// -- 6. promotion with rollback --------------------------------------------------------

/** Whether anything -- a file, a directory, or a symlink, even a dangling one -- is at `path`. */
function occupied(path) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Every file of `path` a SQLite database owns: the database and its sidecars. A symlink at any of them is refused. */
function databaseFiles(path) {
  const files = [path, ...['-wal', '-shm', '-journal'].map((suffix) => `${path}${suffix}`)].filter(occupied);
  for (const file of files) {
    if (lstatSync(file).isSymbolicLink()) throw new RestoreValidationError(`Target file '${basename(file)}' is a symlink; a restore never writes through or replaces a link.`);
  }
  return files;
}

const IN_PROGRESS_MARKER = '.restore-in-progress';
const REPORT_FILE = 'restore-report.json';

/**
 * Restores.
 *
 * `env` — the restoring deployment's environment. When it describes a `sqlite`
 * deployment, every store that deployment requires must be in the backup, and
 * its trusted verification keys (public) are used to verify the signed stores.
 * The CLI passes `process.env`.
 *
 * `faultInjection` — tests only: `afterStage(stagingDir)` runs after the
 * staging copies, `afterPromote(index, name)` after each store is moved into
 * place, `afterVerify()` after post-promotion verification — to prove a
 * damaged copy is refused and a failure mid-promotion rolls the whole target
 * back.
 */
export async function runRestore({ backup, target, force = false, allowIncomplete = false, allowLegacyBackup = false, env, faultInjection } = {}) {
  const enterprise = await loadEnterpriseModule();
  const modules = await loadRegistryModules(REPO_ROOT);
  const backupPath = resolve(backup);
  const targetPath = resolve(target);

  if (!existsSync(backupPath)) throw new RestoreValidationError(`Backup directory '${backupPath}' does not exist.`);
  assertNoPathOverlap(backupPath, targetPath, 'Restore target must not overlap the backup directory');

  const manifest = loadAndValidateManifest(backupPath);

  let targetRequirements;
  let verificationKeys = [];
  let targetOrganizationId;
  if (env !== undefined) {
    const configuration = enterprise.loadEnterpriseConfiguration(env);
    verificationKeys = configuration.authorityAuthenticity?.verificationKeys ?? [];
    if (env.AOC_ENTERPRISE_PERSISTENCE_PROVIDER === 'sqlite') {
      targetRequirements = deriveDeploymentRequirements(env, configuration);
      targetOrganizationId = configuration.kernelAuthority.organizationId;
    }
    // A secure-profile deployment restores signed authority only after verifying it.
    if ((env.AOC_ENTERPRISE_ENV === 'production' || env.AOC_ENTERPRISE_ENV === 'staging') && verificationKeys.length === 0) {
      throw new RestoreValidationError('The restoring deployment is a secure profile but supplies no trusted authority verification keys (AOC_ENTERPRISE_AUTHORITY_VERIFICATION_KEYS); signed state would be restored unverified.');
    }
  }
  // A backup of another organization's deployment is not this deployment's
  // state: its authority, approvals and discharges would answer for the wrong
  // organization. Refused here, before any file is read for restore.
  const sourceOrganizationId = manifest.coverage?.deployment?.organizationId;
  if (targetOrganizationId !== undefined && sourceOrganizationId !== undefined && sourceOrganizationId !== targetOrganizationId) {
    throw new RestoreValidationError(`Backup '${manifest.backupId}' belongs to organization '${sourceOrganizationId}', but the restoring deployment serves '${targetOrganizationId}'. A store is never transplanted between organizations.`);
  }

  const coverage = assessCoverage(manifest, targetRequirements);
  if (coverage.model === 'legacy' && !allowLegacyBackup) {
    throw new RestoreValidationError(
      `Backup '${manifest.backupId}' is a pre-PROD-02 backup with no coverage record: it cannot be shown to contain every store the deployment composes. ` +
        'Restore it only deliberately, with --allow-legacy-backup, and treat the result as incomplete.',
    );
  }
  if (!coverage.complete && coverage.model !== 'legacy' && !allowIncomplete) {
    throw new RestoreValidationError(`Backup '${manifest.backupId}' is incomplete: ${coverage.reason}. A restore never invents a missing store; pass --allow-incomplete only for forensics.`);
  }
  if (coverage.model === 'legacy' && coverage.missingForTarget.length > 0 && !allowIncomplete) {
    throw new RestoreValidationError(`Backup '${manifest.backupId}' is a pre-PROD-02 backup and the restoring deployment requires ${coverage.missingForTarget.join(', ')}, which it does not include.`);
  }

  const heads = await validateBackupSet(backupPath, manifest, modules, targetOrganizationId);

  mkdirSync(targetPath, { recursive: true });
  const paths = targetStorePaths(targetPath);
  if (occupied(join(targetPath, IN_PROGRESS_MARKER))) {
    throw new RestoreValidationError(`Target '${targetPath}' carries ${IN_PROGRESS_MARKER}: an earlier restore was interrupted mid-promotion. Inspect it (its safety and staging directories hold both sides), remove the marker deliberately, then restore again with --force.`);
  }
  const reportPath = join(targetPath, REPORT_FILE);
  if (occupied(reportPath) && lstatSync(reportPath).isSymbolicLink()) throw new RestoreValidationError(`${REPORT_FILE} in the target is a symlink; refusing to write through it.`);

  // Every registry-managed file already in the target, with its sidecars --
  // including stores this backup does not contain, so a replaced target is
  // exactly the backup set, never a hybrid with a stale leftover.
  const existing = STORE_DEFINITIONS.flatMap((storeDef) => databaseFiles(paths[storeDef.name]));
  if (existing.length > 0 && !force) {
    throw new RestoreValidationError(
      `Target directory '${targetPath}' already has store file(s): ${existing.map((p) => basename(p)).join(', ')}. Pass --force to replace them (they are moved to a pre-restore safety directory first, and restored on any failure).`,
    );
  }

  const startedAt = new Date().toISOString();
  const staging = mkdtempSync(join(targetPath, `.restore-staging-${manifest.backupId}-`));
  let objectVerification;
  try {
    // 4. staging, then every staged copy re-checksummed (a copy-time I/O
    // error, or anything that touched the staging directory, is caught here)
    for (const entry of manifest.stores) {
      const storeDef = storeDefinitionByName(entry.name);
      copyFileSync(join(backupPath, 'stores', entry.filename), join(staging, storeDef.targetFilename));
    }
    faultInjection?.afterStage?.(staging);
    for (const entry of manifest.stores) {
      const storeDef = storeDefinitionByName(entry.name);
      if (sha256File(join(staging, storeDef.targetFilename)) !== entry.checksum) {
        throw new RestoreValidationError(`Post-copy checksum mismatch for store '${storeDef.name}' -- the staged copy is not byte-identical to the verified backup file.`);
      }
    }
    // 5. deep verification, on scratch copies of the staged files
    objectVerification = await deepVerify(staging, manifest, modules, heads, verificationKeys, targetOrganizationId);
  } catch (error) {
    cleanupDir(staging);
    throw error;
  }

  // 6. promotion. From here on, any failure restores the target exactly.
  // A previous run's report is moved aside with the stores: a failed restore
  // must never leave an older success report describing a target it no longer is.
  const asideFiles = [...existing, ...(occupied(reportPath) ? [reportPath] : [])];
  const markerPath = join(targetPath, IN_PROGRESS_MARKER);
  let safetyDir;
  let report;
  let markerCreated = false;
  const movedAside = [];
  const promoted = [];
  try {
    // From the first move to the last verification the target carries a
    // marker: an interruption no code can catch (SIGKILL, power loss) leaves
    // it behind, and the next restore refuses until an operator has looked.
    writeFileSync(markerPath, `${manifest.backupId}\n`, { flag: 'wx' });
    markerCreated = true;
    // The target must still be exactly what was inspected before staging: a
    // file or sidecar that appeared meanwhile (a running Host) is refused, never overwritten.
    const now = STORE_DEFINITIONS.flatMap((storeDef) => databaseFiles(paths[storeDef.name]));
    if (now.length !== existing.length || now.some((file, index) => file !== existing[index])) {
      throw new RestoreValidationError('The target changed while the backup was being verified (a store or sidecar appeared or vanished). Is a Host running on it? Stop it and restore again.');
    }
    if (asideFiles.length > 0) {
      safetyDir = mkdtempSync(join(targetPath, `.pre-restore-safety-${manifest.backupId}-`));
      for (const file of asideFiles) {
        const aside = join(safetyDir, basename(file));
        renameSync(file, aside);
        movedAside.push({ from: aside, to: file });
      }
    }
    let index = 0;
    for (const entry of manifest.stores) {
      const storeDef = storeDefinitionByName(entry.name);
      const destination = paths[storeDef.name];
      renameSync(join(staging, storeDef.targetFilename), destination);
      promoted.push(destination);
      index += 1;
      faultInjection?.afterPromote?.(index, storeDef.name);
    }
    // Post-promotion verification: every promoted file is exactly the
    // verified backup file, and nothing else was left beside it.
    for (const entry of manifest.stores) {
      const storeDef = storeDefinitionByName(entry.name);
      const destination = paths[storeDef.name];
      if (sha256File(destination) !== entry.checksum) throw new RestoreValidationError(`Post-restore checksum mismatch for store '${storeDef.name}'.`);
      if (sqliteSidecars(destination).length > 0) throw new RestoreValidationError(`Store '${storeDef.name}' has an unexpected sidecar after restore.`);
    }
    const finishedAt = new Date().toISOString();
    report = {
      backupId: manifest.backupId,
      targetPath,
      compatibilityResult: 'supported',
      checksumResult: 'ok',
      sqliteIntegrityResult: 'ok',
      coverage: { model: coverage.model, complete: coverage.complete, ...(coverage.complete ? {} : { incompleteBecause: coverage.reason }) },
      migrationsApplied: [],
      objectVerification,
      // Restore mapping: which file now backs which Host variable. Derived from the registry.
      targets: manifest.stores.map((entry) => {
        const storeDef = storeDefinitionByName(entry.name);
        return { store: storeDef.name, envVar: storeDef.envVar, path: paths[storeDef.name] };
      }),
      notRestored: STORE_DEFINITIONS.filter((storeDef) => !manifest.stores.some((entry) => entry.name === storeDef.name)).map((storeDef) => storeDef.name),
      freshnessWitness: 'not restored (never part of a backup); start the Host against the surviving witness',
      status: 'restored',
      startedAt,
      finishedAt,
      durationMs: Date.parse(finishedAt) - Date.parse(startedAt),
      preRestoreSafetyCopy: safetyDir ?? null,
      targetCoverageChecked: targetRequirements !== undefined,
    };
    // Registered before the write: a partial report from a failed write is removed by the rollback too.
    promoted.push(reportPath);
    writeFileSync(reportPath, stableJsonStringify(report), { flag: 'wx' });
    faultInjection?.afterVerify?.();
    rmSync(markerPath);
  } catch (error) {
    const rollbackProblems = [];
    for (const file of promoted.reverse()) {
      try {
        rmSync(file, { force: true });
        // A sidecar beside a promoted database is not part of the prior state.
        for (const sidecar of ['-wal', '-shm', '-journal']) rmSync(`${file}${sidecar}`, { force: true });
      } catch (rollbackError) {
        rollbackProblems.push(`${basename(file)}: ${rollbackError.message}`);
      }
    }
    for (const { from, to } of movedAside.reverse()) {
      try {
        renameSync(from, to);
      } catch (rollbackError) {
        rollbackProblems.push(`${basename(to)}: ${rollbackError.message}`);
      }
    }
    cleanupDir(staging);
    if (rollbackProblems.length > 0) {
      // The in-progress marker stays: the next restore refuses until an operator has looked.
      throw new RestoreValidationError(`Restore failed (${error.message}) AND the rollback did not complete (${rollbackProblems.join('; ')}). The original files remain in '${safetyDir}'. Do not start the Host on this target.`);
    }
    if (safetyDir !== undefined) cleanupDir(safetyDir);
    // Only this run's own marker: another run's marker is never removed here.
    if (markerCreated) rmSync(markerPath, { force: true });
    throw error;
  }
  cleanupDir(staging);

  return report;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  // The restoring deployment's environment is what lets restore check coverage,
  // organization and signatures against the deployment it restores. Without
  // it, restore can only judge the backup by its own (unsigned) manifest.
  if (process.env.AOC_ENTERPRISE_PERSISTENCE_PROVIDER !== 'sqlite' && args.noTargetCheck !== true) {
    throw new Error('Run restore:v1 with the restoring deployment\'s environment (AOC_ENTERPRISE_PERSISTENCE_PROVIDER=sqlite and its *_SQLITE_PATH, governed-action file and verification keys), or pass --no-target-check to restore against the backup\'s own record only.');
  }
  const { noTargetCheck: _noTargetCheck, ...options } = args;
  const report = await runRestore({ ...options, env: process.env });
  if (!report.targetCoverageChecked) console.log('WARNING: the restoring deployment was not checked (--no-target-check): coverage was judged against the backup\'s own record only.');
  console.log(`Restore of backup '${report.backupId}' into ${report.targetPath}: ${report.status}${report.coverage.complete ? '' : ' -- INCOMPLETE'}`);
  console.log('Point the Host at the restored stores:');
  for (const entry of report.targets) console.log(`  ${entry.envVar}=${entry.path}`);
  console.log(JSON.stringify(report, null, 2));
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
if (isMain) {
  main().catch((error) => {
    console.error(`[restore:v1] ${error.message}`);
    process.exitCode = 1;
  });
}
