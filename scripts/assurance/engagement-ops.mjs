#!/usr/bin/env node
// ASSURE-OPS-02 — customer-engagement data operations for a Founding Assessment Host.
//
// One private Host and one dedicated data environment per customer
// engagement. This tool does not run a Host and changes nothing outside the
// engagement root it is given. It is built on the existing, tested pieces:
// backup:v1 / restore:v1 (consistent SQLite copies, organization binding,
// coverage), the AUTH-04D1 sealed container (AES-256-GCM, node:crypto only) and
// the Assurance Store's own custody verification. It adds no cryptography.
//
//   engagement-ops.mjs init       --root <dir> --engagement-id <id> --organization <org>
//   engagement-ops.mjs preflight  --root <dir> [--credential-ledger <file> [--record-credentials]] [--require-encryption] [--attest-encrypted-volume <statement>]
//   engagement-ops.mjs status     --root <dir>
//   engagement-ops.mjs record     --root <dir> --event <handoff-accepted|retention-set> [--until <YYYY-MM-DD> --policy-reference <ref>] --by <role-ref>
//   engagement-ops.mjs backup     --root <dir> --key-file <file> --output <sealed-file>
//   engagement-ops.mjs verify     --root <dir> --key-file <file> --archive <sealed-file>
//   engagement-ops.mjs restore    --root <dir> --key-file <file> --archive <sealed-file>
//   engagement-ops.mjs inventory  --root <dir>
//   engagement-ops.mjs offboard   --root <dir> [--plan-out <file>]                       (dry run: lists, deletes nothing)
//   engagement-ops.mjs offboard   --root <dir> --execute --approval <file> --confirm <engagement-id> --certificate <file>
//
// preflight, backup, verify and restore read the Host's environment (process.env).
// Output names checks, variables, paths and digests — never a secret value.
// See docs/security/ASSURE-OPS-02-SECURE-CUSTOMER-DATA.md.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { runBackup } from '../portability/backup-enterprise-v1.mjs';
import { runRestore } from '../portability/restore-enterprise-v1.mjs';
import { STORE_DEFINITIONS } from '../portability/store-registry.mjs';
import { canonicalJson, readBackupKey, readSealedHeader, sealBackupSet, unsealBackupSet } from '../portability/lib-sealed-backup.mjs';

export const ENGAGEMENT_FORMAT = 'frontera.assurance.engagement.v1';
export const ENGAGEMENT_BACKUP_PROFILE = 'frontera.assurance.engagement-backup.v1';
export const DISPOSITION_PLAN_FORMAT = 'frontera.assurance.disposition-plan.v1';
export const DISPOSITION_APPROVAL_FORMAT = 'frontera.assurance.disposition-approval.v1';
export const DISPOSITION_CERTIFICATE_FORMAT = 'frontera.assurance.disposition-certificate.v1';
export const CREDENTIAL_LEDGER_FORMAT = 'frontera.assurance.credential-ledger.v1';
/** The directories an engagement owns, all under its root. */
export const ENGAGEMENT_DIRECTORIES = Object.freeze(['data', 'exports', 'intake', 'work']);
const IDENTIFIER = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));

export class EngagementOpsError extends Error {}

const sha256 = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const fail = (message) => {
  throw new EngagementOpsError(message);
};

// -- engagement identity --------------------------------------------------------------

function engagementFile(root) {
  return join(resolve(root), 'engagement.json');
}

/** Reads and validates `engagement.json`. Never trusts a field it does not check. */
export function readEngagement(root) {
  const path = engagementFile(root);
  if (!existsSync(path)) fail(`No engagement record at ${path}; run init first.`);
  if (lstatSync(path).isSymbolicLink()) fail('engagement.json must not be a symbolic link.');
  let record;
  try {
    record = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    fail('engagement.json is not JSON.');
  }
  if (record?.format !== ENGAGEMENT_FORMAT) fail(`engagement.json is not a ${ENGAGEMENT_FORMAT} record.`);
  for (const field of ['engagementId', 'organizationId']) if (typeof record[field] !== 'string' || !IDENTIFIER.test(record[field])) fail(`engagement.json ${field} is not a canonical identifier.`);
  if (!Array.isArray(record.events)) fail('engagement.json events must be a list.');
  return record;
}

/** Creates the engagement layout. Refuses an existing non-empty root. Owner-only permissions where the platform honours them. */
export function initEngagement({ root, engagementId, organizationId, now = () => new Date().toISOString() }) {
  if (typeof engagementId !== 'string' || !IDENTIFIER.test(engagementId)) fail('--engagement-id must be a canonical identifier (lower-case letters and digits joined by single . _ or -).');
  if (typeof organizationId !== 'string' || !IDENTIFIER.test(organizationId)) fail('--organization must be a canonical identifier.');
  const base = resolve(root);
  if (existsSync(base) && readdirSync(base).length > 0) fail(`The engagement root ${base} is not empty; an engagement is created only in a new, empty location.`);
  mkdirSync(base, { recursive: true, mode: 0o700 });
  for (const name of ENGAGEMENT_DIRECTORIES) mkdirSync(join(base, name), { mode: 0o700 });
  const record = {
    format: ENGAGEMENT_FORMAT,
    engagementId,
    organizationId,
    framework: 'rn.sv@0.1.0',
    createdAt: now(),
    directories: Object.fromEntries(ENGAGEMENT_DIRECTORIES.map((name) => [name, name])),
    externalLocations: { backups: [], keyCustody: 'secret manager (record its reference, never the key)' },
    events: [],
  };
  writeFileSync(engagementFile(base), `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return { status: 'initialised', root: base, engagementId, organizationId, directories: ENGAGEMENT_DIRECTORIES };
}

const LIFECYCLE_EVENTS = new Set(['handoff-accepted', 'retention-set']);

/** Appends one lifecycle event. Never edits or removes an earlier one. */
export function recordEvent({ root, event, until, policyReference, by, now = () => new Date().toISOString() }) {
  const record = readEngagement(root);
  if (!LIFECYCLE_EVENTS.has(event)) fail(`--event must be one of ${[...LIFECYCLE_EVENTS].join(', ')}.`);
  if (typeof by !== 'string' || !IDENTIFIER.test(by)) fail('--by must be a role-style reference (never a name or email).');
  const entry = { event, at: now(), by };
  if (event === 'retention-set') {
    if (typeof until !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(until)) fail('retention-set needs --until YYYY-MM-DD.');
    if (typeof policyReference !== 'string' || policyReference.trim().length === 0) fail('retention-set needs --policy-reference: the approved retention decision it applies. Proposed values are not a policy.');
    entry.until = until;
    entry.policyReference = policyReference.trim();
  }
  const next = { ...record, events: [...record.events, entry] };
  writeFileSync(engagementFile(root), `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  return { status: 'recorded', ...entry };
}

// -- paths and the store set ----------------------------------------------------------

function isInside(container, candidate) {
  const rel = relative(resolve(container), resolve(candidate));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Every Assurance-relevant store variable the Host could read, with its value in `env`. */
function storeVariables(env) {
  return STORE_DEFINITIONS.filter((definition) => typeof definition.envVar === 'string' && definition.envVar.startsWith('AOC_ENTERPRISE_')).map((definition) => ({
    name: definition.name,
    envVar: definition.envVar,
    targetFilename: definition.targetFilename,
    value: env[definition.envVar],
  }));
}

/** The registry's restore filename of the Assurance Store: where a restore puts it, and therefore where the Host must read it. */
function assuranceFilename() {
  return STORE_DEFINITIONS.find((definition) => definition.name === 'assurance').targetFilename;
}

function readGovernedActions(env) {
  const path = env.AOC_ENTERPRISE_GOVERNED_ACTIONS_FILE;
  if (typeof path !== 'string' || path.length === 0) return { path: undefined, file: undefined };
  try {
    return { path: resolve(path), file: JSON.parse(readFileSync(path, 'utf8')) };
  } catch {
    return { path: resolve(path), file: null };
  }
}

/** sha256 fingerprints of the credentials a Host configuration names. The values are read to hash them and never leave this function. */
function credentialFingerprints(env, governedActions) {
  const fingerprints = [];
  for (const reviewer of Array.isArray(governedActions?.assuranceReviewers) ? governedActions.assuranceReviewers : []) {
    const value = typeof reviewer?.apiKeyEnv === 'string' ? env[reviewer.apiKeyEnv] : undefined;
    if (typeof value === 'string' && value.length > 0) fingerprints.push({ kind: 'assurance-reviewer', reference: String(reviewer.reviewerId), fingerprint: sha256(`frontera.credential.v1\u0000${value}`) });
  }
  for (const [index, entry] of String(env.AOC_ENTERPRISE_API_KEYS ?? '').split(',').filter((part) => part.trim().length > 0).entries()) {
    const key = entry.split(':')[0]?.trim() ?? '';
    if (key.length > 0) fingerprints.push({ kind: 'organization-api-key', reference: `AOC_ENTERPRISE_API_KEYS[${index}]`, fingerprint: sha256(`frontera.credential.v1\u0000${key}`) });
  }
  return fingerprints;
}

// -- encryption at rest: detection only, never configuration ---------------------------

/** Parses `manage-bde -status <drive>` output. Exported for tests. */
export function parseManageBdeStatus(text) {
  const conversion = /Conversion Status:\s*(.+)/i.exec(text)?.[1]?.trim();
  const protection = /Protection Status:\s*(.+)/i.exec(text)?.[1]?.trim();
  if (conversion === undefined || protection === undefined) return { status: 'UNVERIFIED', detail: 'manage-bde output not recognised' };
  if (/^Fully Encrypted/i.test(conversion) && /Protection On/i.test(protection)) return { status: 'ENCRYPTED', detail: `BitLocker: ${conversion}; ${protection}` };
  if (/^Fully Decrypted/i.test(conversion) || /Protection Off/i.test(protection)) return { status: 'NOT_ENCRYPTED', detail: `BitLocker: ${conversion}; ${protection}` };
  return { status: 'UNVERIFIED', detail: `BitLocker: ${conversion}; ${protection}` };
}

/** Parses `fdesetup status`. Exported for tests. */
export function parseFdesetupStatus(text) {
  if (/FileVault is On/i.test(text)) return { status: 'ENCRYPTED', detail: 'FileVault is On' };
  if (/FileVault is Off/i.test(text)) return { status: 'NOT_ENCRYPTED', detail: 'FileVault is Off' };
  return { status: 'UNVERIFIED', detail: 'fdesetup output not recognised' };
}

/** dm-crypt detection on Linux: the block device behind the path, or one below it, is a CRYPT- device-mapper target. */
function linuxEncryption(path) {
  let mounts;
  try {
    mounts = readFileSync('/proc/self/mountinfo', 'utf8').split('\n').filter(Boolean).map((line) => {
      const fields = line.split(' ');
      const separator = fields.indexOf('-');
      return { device: fields[2], mountPoint: fields[4], fsType: fields[separator + 1] };
    });
  } catch {
    return { status: 'UNVERIFIED', detail: '/proc/self/mountinfo unreadable' };
  }
  const real = realpathSync(path);
  const mount = mounts.filter((entry) => real === entry.mountPoint || real.startsWith(entry.mountPoint.endsWith('/') ? entry.mountPoint : `${entry.mountPoint}/`)).sort((a, b) => b.mountPoint.length - a.mountPoint.length)[0];
  if (mount === undefined) return { status: 'UNVERIFIED', detail: 'mount point not found' };
  if (['9p', 'drvfs', 'virtiofs', 'nfs', 'nfs4', 'cifs', 'smb3', 'fuse', 'overlay', 'tmpfs'].includes(mount.fsType)) {
    return { status: 'UNVERIFIED', detail: `${mount.fsType} filesystem: encryption is decided by the system that serves it, which this check cannot inspect` };
  }
  const visit = (majorMinor, depth) => {
    if (depth > 8) return false;
    try {
      const uuid = readFileSync(`/sys/dev/block/${majorMinor}/dm/uuid`, 'utf8').trim();
      if (uuid.startsWith('CRYPT-')) return true;
    } catch {
      // not a device-mapper device
    }
    try {
      for (const slave of readdirSync(`/sys/dev/block/${majorMinor}/slaves`)) {
        const dev = readFileSync(`/sys/class/block/${slave}/dev`, 'utf8').trim();
        if (visit(dev, depth + 1)) return true;
      }
    } catch {
      // no lower devices
    }
    return false;
  };
  return visit(mount.device, 0) ? { status: 'ENCRYPTED', detail: `dm-crypt below ${mount.mountPoint}` } : { status: 'NOT_ENCRYPTED', detail: `no dm-crypt device below ${mount.mountPoint} (${mount.fsType})` };
}

/** Best-effort, read-only detection of full-volume encryption for `path`. Never changes anything. */
export function detectVolumeEncryption(path, { platform = process.platform, run = (command, args) => execFileSync(command, args, { encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'] }) } = {}) {
  try {
    if (platform === 'win32') {
      const drive = /^([A-Za-z]):/.exec(resolve(path))?.[1];
      if (drive === undefined) return { status: 'UNVERIFIED', detail: 'not a drive-letter path' };
      return parseManageBdeStatus(run('manage-bde', ['-status', `${drive}:`]));
    }
    if (platform === 'darwin') return parseFdesetupStatus(run('fdesetup', ['status']));
    if (platform === 'linux') return linuxEncryption(path);
  } catch (error) {
    return { status: 'UNVERIFIED', detail: `probe failed (${String(error?.code ?? 'error')})` };
  }
  return { status: 'UNVERIFIED', detail: `no probe for platform ${platform}` };
}

// -- preflight ------------------------------------------------------------------------------

const PRIVATE_V4 = [/^127\./, /^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./];

/**
 * The deployment preflight of one engagement Host. Reads the Host's
 * environment; reports PASS / WARN / FAIL per check; never prints a secret.
 */
export function preflightEngagement({ root, env = process.env, credentialLedger, recordCredentials = false, requireEncryption = false, attestEncryptedVolume, detect = detectVolumeEncryption }) {
  const engagement = readEngagement(root);
  const base = resolve(root);
  const dataDir = join(base, 'data');
  const checks = [];
  const check = (id, title, status, detail) => checks.push({ id, title, status, ...(detail !== undefined ? { detail } : {}) });

  check('E01', 'engagement record is valid', 'PASS', { engagementId: engagement.engagementId, organizationId: engagement.organizationId });
  const served = env.AOC_ENTERPRISE_KERNEL_AUTHORITY_ORGANIZATION_ID;
  check('E02', 'the Host serves exactly the engagement organization', served === engagement.organizationId ? 'PASS' : 'FAIL', { served: served ?? null });
  check('E03', 'durable SQLite persistence', env.AOC_ENTERPRISE_PERSISTENCE_PROVIDER === 'sqlite' ? 'PASS' : 'FAIL');
  check('E04', 'reviewer-only Assurance mode', env.AOC_ENTERPRISE_ASSURANCE_REVIEWER_ONLY === 'true' ? 'PASS' : 'FAIL');
  check('E05', 'framework opt-in is exactly rn.sv@0.1.0', env.AOC_ENTERPRISE_ASSURANCE_FRAMEWORKS === 'rn.sv@0.1.0' ? 'PASS' : 'FAIL', { configured: env.AOC_ENTERPRISE_ASSURANCE_FRAMEWORKS ?? null });
  check('E06', 'authentication required', env.AOC_ENTERPRISE_REQUIRE_AUTH === 'true' ? 'PASS' : 'FAIL');
  const bind = env.AOC_ENTERPRISE_HTTP_HOST ?? '';
  const privateBind = bind === 'localhost' || bind === '::1' || PRIVATE_V4.some((pattern) => pattern.test(bind));
  check('E07', 'HTTP bind is loopback or a private address', privateBind ? 'PASS' : 'FAIL', { bind: bind || null });

  const stores = storeVariables(env);
  // Each store must be exactly <root>/data/<registry restore filename>: inside the engagement, and where an engagement restore puts it.
  const misplaced = stores.filter((store) => typeof store.value === 'string' && store.value.length > 0 && resolve(store.value) !== resolve(dataDir, store.targetFilename));
  const defaulted = stores.filter((store) => ['governance', 'agent-passport', 'assurance', 'evidence-bundles'].includes(store.name) && (store.value === undefined || store.value === ''));
  check('E08', 'every store is <root>/data/<registry filename>: inside the engagement and restorable in place', misplaced.length === 0 && defaulted.length === 0 ? 'PASS' : 'FAIL', {
    misplaced: misplaced.map((store) => store.envVar),
    unsetDefaulting: defaulted.map((store) => store.envVar),
  });
  const symlinked = stores.filter((store) => typeof store.value === 'string' && existsSync(store.value) && lstatSync(store.value).isSymbolicLink());
  check('E09', 'no store file is a symbolic link', symlinked.length === 0 ? 'PASS' : 'FAIL', { symlinked: symlinked.map((store) => store.envVar) });

  const { path: governedPath, file: governed } = readGovernedActions(env);
  check('E10', 'the governed-action file is readable and belongs to this engagement', governed !== null && governedPath !== undefined && isInside(base, governedPath) ? 'PASS' : governed === null ? 'FAIL' : 'WARN', {
    inside: governedPath !== undefined && isInside(base, governedPath),
  });
  const reviewers = Array.isArray(governed?.assuranceReviewers) ? governed.assuranceReviewers : [];
  const hasReviewer = reviewers.some((reviewer) => Array.isArray(reviewer.roles) && reviewer.roles.includes('assure.reviewer'));
  const hasApprover = reviewers.some((reviewer) => Array.isArray(reviewer.roles) && reviewer.roles.includes('assure.report-release'));
  const dual = reviewers.filter((reviewer) => Array.isArray(reviewer.roles) && reviewer.roles.includes('assure.reviewer') && reviewer.roles.includes('assure.report-release'));
  check('E11', 'at least one reviewer and one release approver, no dual-role credential', hasReviewer && hasApprover && dual.length === 0 ? 'PASS' : 'FAIL', { dualRole: dual.map((reviewer) => String(reviewer.reviewerId)) });

  const fingerprints = credentialFingerprints(env, governed);
  if (credentialLedger !== undefined) {
    const ledger = existsSync(credentialLedger) ? JSON.parse(readFileSync(credentialLedger, 'utf8')) : { format: CREDENTIAL_LEDGER_FORMAT, entries: [] };
    if (ledger.format !== CREDENTIAL_LEDGER_FORMAT || !Array.isArray(ledger.entries)) fail('The credential ledger is not a ledger file.');
    const reused = fingerprints.filter((entry) => ledger.entries.some((known) => known.fingerprint === entry.fingerprint && known.engagementId !== engagement.engagementId));
    const duplicateWithin = fingerprints.filter((entry, index) => fingerprints.findIndex((other) => other.fingerprint === entry.fingerprint) !== index);
    check('E12', 'no credential is reused from another engagement or shared within this one', reused.length === 0 && duplicateWithin.length === 0 ? 'PASS' : 'FAIL', {
      reusedFromOtherEngagements: reused.map((entry) => entry.reference),
      sharedWithinEngagement: duplicateWithin.map((entry) => entry.reference),
    });
    if (recordCredentials && reused.length === 0 && duplicateWithin.length === 0) {
      const known = new Set(ledger.entries.map((entry) => `${entry.engagementId}\u0000${entry.fingerprint}`));
      const added = fingerprints.filter((entry) => !known.has(`${engagement.engagementId}\u0000${entry.fingerprint}`)).map((entry) => ({ engagementId: engagement.engagementId, kind: entry.kind, reference: entry.reference, fingerprint: entry.fingerprint }));
      writeFileSync(credentialLedger, `${JSON.stringify({ ...ledger, entries: [...ledger.entries, ...added] }, null, 2)}\n`, { mode: 0o600 });
    }
  } else {
    check('E12', 'credential reuse across engagements', 'WARN', { reason: 'no --credential-ledger given: reuse across engagements is not checked' });
  }

  const encryption = detect(base);
  const attested = typeof attestEncryptedVolume === 'string' && attestEncryptedVolume.trim().length > 0;
  const encryptionStatus = encryption.status === 'ENCRYPTED' ? 'PASS' : encryption.status === 'NOT_ENCRYPTED' ? 'FAIL' : attested ? 'WARN' : requireEncryption ? 'FAIL' : 'WARN';
  check('E13', 'the engagement root is on an encrypted volume', encryptionStatus, { detected: encryption.status, detail: encryption.detail, ...(attested ? { operatorAttestation: attestEncryptedVolume.trim() } : {}) });

  if (process.platform === 'win32') {
    check('E14', 'owner-only permissions on the engagement root', 'WARN', { reason: 'Windows ACLs are not inspected by this check; confirm with icacls that only the Host account and the custody administrator have access' });
  } else {
    const mode = statSync(base).mode & 0o777;
    check('E14', 'owner-only permissions on the engagement root', (mode & 0o077) === 0 ? 'PASS' : 'FAIL', { mode: mode.toString(8) });
  }
  const temp = resolve(env.TMPDIR ?? env.TEMP ?? env.TMP ?? tmpdir());
  check('E15', 'the process temporary directory is inside the engagement root', isInside(base, temp) ? 'PASS' : 'WARN', {
    reason: isInside(base, temp) ? undefined : 'exports and work files belong in <root>/exports and <root>/work; set TMPDIR/TEMP to <root>/work so no tool writes customer data elsewhere',
  });

  const failed = checks.filter((entry) => entry.status === 'FAIL').length;
  return { status: failed === 0 ? 'PASS' : 'FAIL', engagementId: engagement.engagementId, organizationId: engagement.organizationId, checks };
}

// -- lifecycle --------------------------------------------------------------------------------

/**
 * A query-only connection. Not `readonly`: SQLite would then leave the WAL-mode
 * store's -wal/-shm sidecars behind, changing the very inventory being read.
 * `query_only` refuses every write; on close, SQLite removes the sidecars it
 * created. Never used while the plan reports a non-empty WAL (a running Host).
 */
async function openReadOnly(path) {
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(path, { fileMustExist: true });
  db.pragma('query_only = ON');
  return db;
}

/** Assessments and releases held by an Assurance Store file, read-only. */
export async function assuranceContents(path) {
  if (!existsSync(path)) return { assessments: [], releases: [] };
  const db = await openReadOnly(path);
  try {
    const has = (table) => db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== undefined;
    const assessments = has('assurance_assessments') ? db.prepare('SELECT assessment_id AS assessmentId, organization_id AS organizationId, status FROM assurance_assessments ORDER BY assessment_id').all() : [];
    const releases = has('assurance_commercial_releases')
      ? db.prepare('SELECT report_id AS reportId, organization_id AS organizationId, custody_version AS custodyVersion, release_digest AS releaseDigest, record_digest AS recordDigest FROM assurance_commercial_releases ORDER BY report_id').all()
      : [];
    return { assessments, releases };
  } finally {
    db.close();
  }
}

/** The engagement's lifecycle state, derived from its store and its recorded events -- never declared. */
export async function engagementStatus({ root }) {
  const engagement = readEngagement(root);
  const { assessments, releases } = await assuranceContents(join(resolve(root), 'data', assuranceFilename()));
  const foreign = [...assessments, ...releases].filter((row) => row.organizationId !== engagement.organizationId);
  const handoff = engagement.events.filter((entry) => entry.event === 'handoff-accepted').at(-1);
  const retention = engagement.events.filter((entry) => entry.event === 'retention-set').at(-1);
  const today = new Date().toISOString().slice(0, 10);
  let state = 'ENGAGEMENT_CREATED';
  if (assessments.length > 0) state = 'ASSESSMENT_ACTIVE';
  if (assessments.some((row) => row.status === 'completed' || row.status === 'superseded')) state = 'ASSESSMENT_COMPLETED';
  if (releases.length > 0) state = 'RELEASE_ISSUED';
  if (releases.length > 0 && handoff !== undefined) state = 'HANDOFF_COMPLETED';
  if (state === 'HANDOFF_COMPLETED' && retention !== undefined) state = retention.until <= today ? 'RETENTION_EXPIRED' : 'RETENTION_ACTIVE';
  return {
    engagementId: engagement.engagementId,
    organizationId: engagement.organizationId,
    state,
    assessments: assessments.length,
    releases: releases.map(({ reportId, custodyVersion, releaseDigest }) => ({ reportId, custodyVersion, releaseDigest })),
    foreignOrganizationRows: foreign.length,
    ...(retention !== undefined ? { retention: { until: retention.until, policyReference: retention.policyReference } } : {}),
  };
}

// -- sealed, engagement-bound backup ----------------------------------------------------------

function privateWorkDir(root) {
  // Plaintext of a backup set lives only under the engagement's own work directory, owner-only, and is removed on every path.
  const parent = join(resolve(root), 'work');
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  return mkdtempSync(join(parent, 'backup-'));
}

function assertEnvMatchesEngagement(engagement, env) {
  if (env.AOC_ENTERPRISE_KERNEL_AUTHORITY_ORGANIZATION_ID !== engagement.organizationId) fail('The Host environment serves another organization than this engagement; nothing was done.');
}

/** Cold, complete backup of the engagement's Host, sealed (AES-256-GCM) and bound to the engagement in its authenticated header. */
export async function backupEngagement({ root, keyFile, output, env = process.env, now = () => new Date().toISOString() }) {
  const engagement = readEngagement(root);
  assertEnvMatchesEngagement(engagement, env);
  if (typeof keyFile !== 'string' || keyFile.length === 0) fail('A backup key file is required: an engagement backup is never written in plaintext.');
  const key = readBackupKey(keyFile);
  const out = resolve(output);
  if (isInside(join(resolve(root), 'data'), out)) fail('The sealed backup must not be written into the engagement data directory.');
  if (existsSync(out)) fail(`${out} already exists; a backup never overwrites a file.`);
  const work = privateWorkDir(root);
  try {
    const set = join(work, 'set');
    await runBackup({ output: set, cold: true, env });
    const manifest = JSON.parse(readFileSync(join(set, 'backup-manifest.json'), 'utf8'));
    if (manifest.coverage?.complete !== true) fail('The backup is not complete; an engagement backup is complete only.');
    if (manifest.coverage?.deployment?.organizationId !== engagement.organizationId) fail('The backup set is bound to another organization.');
    const contents = await assuranceContents(join(set, 'stores', 'assurance.sqlite'));
    const foreign = [...contents.assessments, ...contents.releases].filter((row) => row.organizationId !== engagement.organizationId);
    if (foreign.length > 0) fail('The Assurance Store holds rows of another organization; this is not a single-engagement Host.');
    const header = {
      profile: ENGAGEMENT_BACKUP_PROFILE,
      engagementId: engagement.engagementId,
      organizationId: engagement.organizationId,
      backupId: manifest.backupId,
      sourceCommit: manifest.source?.commit ?? 'unknown',
      consistency: manifest.consistency?.mode ?? null,
      assessments: contents.assessments.length,
      releases: contents.releases.map(({ reportId, custodyVersion, releaseDigest, recordDigest }) => ({ reportId, custodyVersion, releaseDigest, recordDigest })),
      sealedAt: now(),
    };
    const sealed = sealBackupSet({ sourceDir: set, outputFile: out, key, header });
    return { status: 'sealed', sealedFile: out, sha256: sealed.sha256, keyId: sealed.header.keyId, engagementId: header.engagementId, organizationId: header.organizationId, backupId: header.backupId, releases: header.releases, assessments: header.assessments };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** The authenticated header must name this engagement; checked before any plaintext is produced, and again after. */
function assertHeaderForEngagement(header, engagement) {
  if (header?.profile !== ENGAGEMENT_BACKUP_PROFILE) fail('Not an engagement backup.');
  if (header.engagementId !== engagement.engagementId || header.organizationId !== engagement.organizationId) {
    fail('This backup belongs to another engagement or organization; a backup is never restored across customers.');
  }
}

async function withUnsealedEngagement({ root, keyFile, archive }, use) {
  const engagement = readEngagement(root);
  const bytes = readFileSync(resolve(archive));
  // The public header is checked first (cheap, no key); GCM authenticates it on unseal.
  assertHeaderForEngagement(readSealedHeader(bytes).header, engagement);
  const key = readBackupKey(keyFile);
  const work = privateWorkDir(root);
  try {
    const set = join(work, 'set');
    const { header } = unsealBackupSet({ sealedFile: resolve(archive), key, outputDir: set });
    assertHeaderForEngagement(header, engagement);
    const manifest = JSON.parse(readFileSync(join(set, 'backup-manifest.json'), 'utf8'));
    if (manifest.backupId !== header.backupId || manifest.coverage?.deployment?.organizationId !== engagement.organizationId) fail('The sealed header does not describe the backup it holds.');
    return await use({ engagement, header, set, work });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Every release kept in a restored Assurance Store, read through the store's own custody verification. */
async function verifyRestoredAssurance(path, engagement, header) {
  const dist = (relativePath) => pathToFileURL(join(REPO_ROOT, 'dist', 'src', 'enterprise', relativePath)).href;
  const { createSqliteAssuranceStore } = await import(dist('assurance/sqlite-assurance-store.js'));
  const store = await createSqliteAssuranceStore(path);
  const context = { system: false, organizationId: engagement.organizationId };
  try {
    const verified = [];
    for (const expected of header.releases) {
      const record = await store.getCommercialRelease(context, expected.reportId); // refuses an inconsistent record
      if (record === null || record.release.releaseDigest !== expected.releaseDigest || record.recordDigest !== expected.recordDigest || record.custodyVersion !== expected.custodyVersion) {
        fail(`Release ${expected.reportId} is not in the restored custody as the backup recorded it.`);
      }
      verified.push({ reportId: expected.reportId, custodyVersion: record.custodyVersion, releaseDigest: record.release.releaseDigest });
    }
    const contents = await assuranceContents(path);
    if (contents.releases.length !== header.releases.length || contents.assessments.length !== header.assessments) fail('The restored Assurance Store does not hold what the backup header records.');
    for (const assessment of contents.assessments.filter((row) => row.status === 'completed')) {
      const result = await store.verifyAssessment(context, assessment.assessmentId);
      if (result?.valid !== true) fail(`Completed assessment ${assessment.assessmentId} does not verify after restore.`);
    }
    return verified;
  } finally {
    await store.close();
  }
}

/** Unseal, restore into a throwaway target with the engagement Host's environment, verify custody and assessments, discard. */
export async function verifyEngagementBackup({ root, keyFile, archive, env = process.env }) {
  const engagement = readEngagement(root);
  assertEnvMatchesEngagement(engagement, env);
  return withUnsealedEngagement({ root, keyFile, archive }, async ({ header, set, work }) => {
    const target = join(work, 'verify-target');
    const report = await runRestore({ backup: set, target, env });
    if (report.status !== 'restored') fail('The backup did not restore.');
    const releases = await verifyRestoredAssurance(join(target, assuranceFilename()), engagement, header);
    return { status: 'verified', engagementId: header.engagementId, organizationId: header.organizationId, backupId: header.backupId, releases, assessments: header.assessments, authenticity: 'digest and custody consistency only: the backup is sealed with the engagement key, not signed by an independent party' };
  });
}

/** Restore into the engagement's own (empty) data directory. Never replaces existing stores, never crosses engagements. */
export async function restoreEngagement({ root, keyFile, archive, env = process.env }) {
  const engagement = readEngagement(root);
  assertEnvMatchesEngagement(engagement, env);
  const dataDir = join(resolve(root), 'data');
  if (existsSync(dataDir) && readdirSync(dataDir).length > 0) fail('The engagement data directory is not empty; restore only into an empty data directory (offboard or provision a fresh engagement first).');
  for (const store of storeVariables(env)) {
    if (typeof store.value === 'string' && store.value.length > 0 && !isInside(dataDir, store.value)) fail(`${store.envVar} points outside this engagement's data directory; nothing was restored.`);
  }
  return withUnsealedEngagement({ root, keyFile, archive }, async ({ header, set }) => {
    const report = await runRestore({ backup: set, target: dataDir, env });
    if (report.status !== 'restored') fail('The backup did not restore.');
    const releases = await verifyRestoredAssurance(join(dataDir, assuranceFilename()), engagement, header);
    return { status: 'restored', engagementId: header.engagementId, backupId: header.backupId, releases };
  });
}

// -- inventory and disposition --------------------------------------------------------------

function classify(relativePath) {
  const [top] = relativePath.split(/[\\/]/);
  if (relativePath === 'engagement.json') return 'engagement-record';
  if (top === 'data') return /-(wal|shm|journal)$/.test(relativePath) ? 'sqlite-sidecar' : relativePath.endsWith('.sqlite') ? 'store' : 'data-other';
  if (top === 'exports') return 'export';
  if (top === 'intake') return 'evidence-intake';
  if (top === 'work') return 'temporary';
  return 'other';
}

/** Every file under the engagement root, with its class, size and digest. Symbolic links are listed and never followed. */
export function inventoryEngagement({ root }) {
  const engagement = readEngagement(root);
  const base = resolve(root);
  const files = [];
  const links = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const stat = lstatSync(path);
      const rel = relative(base, path).split(sep).join('/');
      if (stat.isSymbolicLink()) links.push({ path: rel, target: readlinkSync(path) });
      else if (stat.isDirectory()) walk(path);
      else if (stat.isFile()) files.push({ path: rel, class: classify(rel), size: stat.size, sha256: sha256(readFileSync(path)) });
      else links.push({ path: rel, target: 'not a regular file' });
    }
  };
  walk(base);
  return {
    engagementId: engagement.engagementId,
    organizationId: engagement.organizationId,
    root: base,
    files,
    symbolicLinks: links,
    outsideRoot: {
      backups: engagement.externalLocations?.backups ?? [],
      keyCustody: engagement.externalLocations?.keyCustody ?? null,
      note: 'Off-host backups, the backup key, password-manager entries, delivered packages held by the customer and operator e-mail are outside this root and outside this tool.',
    },
  };
}

const SURVIVES = [
  'Delivered packages held by the customer (their copy is theirs).',
  'Business records required by an approved policy or by law (contract, invoice, the disposition certificate itself).',
  'Third-party copies outside Republika’s control (customer e-mail, the customer’s own storage).',
];
const MANUAL = [
  'Destroy the engagement backup key in the secret manager (cryptographic erasure of every sealed backup made with it), and record the key id destroyed.',
  'Delete every sealed backup listed under externalLocations.backups and any copy on removable or off-host storage.',
  'Revoke and delete the engagement’s reviewer credentials in the password manager and the Host configuration.',
  'Destroy or securely re-image the Host machine or volume; snapshots of it taken by the hosting provider are subject to its retention, not this tool.',
];

/** The disposition plan: what offboarding would destroy, what survives, what is manual. Deterministic for an unchanged root. */
export async function planDisposition({ root }) {
  const inventory = inventoryEngagement({ root });
  const destroy = inventory.files.map(({ path, class: kind, size, sha256: digest }) => ({ path, class: kind, size, sha256: digest }));
  // A non-empty WAL or journal means a Host may be running: the store is then never opened, not even to read it.
  const live = destroy.some((file) => file.class === 'sqlite-sidecar' && /-(wal|journal)$/.test(file.path) && file.size > 0);
  const status = live ? { state: 'UNDETERMINED_HOST_MAY_BE_RUNNING', foreignOrganizationRows: 0 } : await engagementStatus({ root });
  const body = {
    format: DISPOSITION_PLAN_FORMAT,
    engagementId: inventory.engagementId,
    organizationId: inventory.organizationId,
    root: inventory.root,
    lifecycleState: status.state,
    destroy,
    refusals: [
      ...(inventory.symbolicLinks.length > 0 ? [`symbolic links present: ${inventory.symbolicLinks.map((link) => link.path).join(', ')}`] : []),
      ...(status.foreignOrganizationRows > 0 ? ['the Assurance Store holds rows of another organization'] : []),
      ...(live ? ['a non-empty SQLite WAL or journal: the Host may be running (stop it; the store was not opened)'] : []),
    ],
    manual: MANUAL,
    survives: SURVIVES,
    limitations: [
      'Deletion removes directory entries through the file system. It does not prove physical erasure of the underlying blocks, of SSD remapped cells, of file-system journals or of provider snapshots.',
      'On an encrypted volume, destroying the volume key is the effective erasure of what this plan deletes; that step is outside this tool.',
    ],
  };
  return { ...body, planDigest: sha256(canonicalJson(body)) };
}

/**
 * Executes an approved disposition. Every precondition is checked before the
 * first deletion; nothing outside the engagement root is ever touched.
 */
export async function executeDisposition({ root, approvalFile, confirm, certificate, now = () => new Date().toISOString() }) {
  const plan = await planDisposition({ root });
  if (plan.refusals.length > 0) fail(`Disposition refused: ${plan.refusals.join('; ')}. Nothing was deleted.`);
  if (confirm !== plan.engagementId) fail('--confirm must repeat the engagement id exactly; nothing was deleted.');
  if (typeof approvalFile !== 'string' || !existsSync(approvalFile)) fail('An approval file is required; nothing was deleted.');
  if (typeof certificate !== 'string' || certificate.length === 0) fail('--certificate is required; nothing was deleted.');
  const certificatePath = resolve(certificate);
  if (isInside(plan.root, certificatePath)) fail('The certificate must be written outside the engagement root; nothing was deleted.');
  if (existsSync(certificatePath)) fail('The certificate path already exists; nothing was deleted.');
  let approval;
  try {
    approval = JSON.parse(readFileSync(approvalFile, 'utf8'));
  } catch {
    fail('The approval is not JSON; nothing was deleted.');
  }
  if (approval?.format !== DISPOSITION_APPROVAL_FORMAT) fail(`The approval is not a ${DISPOSITION_APPROVAL_FORMAT} record; nothing was deleted.`);
  if (approval.engagementId !== plan.engagementId || approval.organizationId !== plan.organizationId) fail('The approval names another engagement; nothing was deleted.');
  if (approval.planDigest !== plan.planDigest) fail('The approval was given for another plan: the engagement changed since, or the plan differs. Produce a new plan and a new approval; nothing was deleted.');
  for (const field of ['approvedBy', 'approverRole', 'basis']) if (typeof approval[field] !== 'string' || approval[field].trim().length === 0) fail(`The approval has no ${field}; nothing was deleted.`);
  if (!IDENTIFIER.test(approval.approvedBy)) fail('approvedBy must be a role-style reference; nothing was deleted.');
  const bases = ['retention_expired', 'customer_request', 'contract_termination'];
  if (!bases.includes(approval.basis)) fail(`basis must be one of ${bases.join(', ')}; nothing was deleted.`);
  if (approval.basis === 'retention_expired' && plan.lifecycleState !== 'RETENTION_EXPIRED') fail('The basis is retention expiry, but the engagement is not in RETENTION_EXPIRED; nothing was deleted.');

  // Every deletion target is re-resolved and must still be a regular file inside the root, with the planned digest.
  const targets = plan.destroy.map((file) => {
    const path = resolve(plan.root, file.path);
    if (!isInside(plan.root, path) || path === plan.root) fail(`Refusing a path outside the engagement root: ${file.path}`);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) fail(`${file.path} is no longer a regular file; nothing was deleted.`);
    if (sha256(readFileSync(path)) !== file.sha256) fail(`${file.path} changed after the plan was approved; nothing was deleted.`);
    return path;
  });
  for (const path of targets) unlinkSync(path);
  // Remove the now-empty directories, deepest first, and finally the root.
  const dirs = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (lstatSync(path).isDirectory()) walk(path);
    }
    dirs.push(dir);
  };
  walk(plan.root);
  for (const dir of dirs) rmdirSync(dir);
  const record = {
    format: DISPOSITION_CERTIFICATE_FORMAT,
    engagementId: plan.engagementId,
    organizationId: plan.organizationId,
    planDigest: plan.planDigest,
    executedAt: now(),
    approval: { approvedBy: approval.approvedBy, approverRole: approval.approverRole, approvedAt: approval.approvedAt ?? null, basis: approval.basis },
    destroyed: plan.destroy.map(({ path, class: kind, sha256: digest }) => ({ path, class: kind, sha256: digest })),
    rootRemoved: !existsSync(plan.root),
    manualStepsOutstanding: MANUAL,
    survives: SURVIVES,
    limitations: plan.limitations,
  };
  mkdirSync(dirname(certificatePath), { recursive: true });
  writeFileSync(certificatePath, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return { status: 'disposed', certificate: certificatePath, destroyed: record.destroyed.length, rootRemoved: record.rootRemoved, manualStepsOutstanding: MANUAL.length };
}

// -- CLI ------------------------------------------------------------------------------------------

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const args = { command };
  const flags = new Set(['--record-credentials', '--require-encryption', '--execute']);
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (!arg.startsWith('--')) fail(`Unexpected argument: ${arg}`);
    const name = arg.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (flags.has(arg)) args[name] = true;
    else {
      const value = rest[index + 1];
      if (value === undefined || value.startsWith('--')) fail(`${arg} needs a value.`);
      args[name] = value;
      index += 1;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const need = (...names) => {
    for (const name of names) if (args[name] === undefined) fail(`${args.command} needs --${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}.`);
  };
  let report;
  switch (args.command) {
    case 'init':
      need('root', 'engagementId', 'organization');
      report = initEngagement({ root: args.root, engagementId: args.engagementId, organizationId: args.organization });
      break;
    case 'preflight':
      need('root');
      report = preflightEngagement({ root: args.root, credentialLedger: args.credentialLedger, recordCredentials: args.recordCredentials === true, requireEncryption: args.requireEncryption === true, attestEncryptedVolume: args.attestEncryptedVolume });
      break;
    case 'status':
      need('root');
      report = await engagementStatus({ root: args.root });
      break;
    case 'record':
      need('root', 'event', 'by');
      report = recordEvent({ root: args.root, event: args.event, until: args.until, policyReference: args.policyReference, by: args.by });
      break;
    case 'backup':
      need('root', 'keyFile', 'output');
      report = await backupEngagement({ root: args.root, keyFile: args.keyFile, output: args.output });
      break;
    case 'verify':
      need('root', 'keyFile', 'archive');
      report = await verifyEngagementBackup({ root: args.root, keyFile: args.keyFile, archive: args.archive });
      break;
    case 'restore':
      need('root', 'keyFile', 'archive');
      report = await restoreEngagement({ root: args.root, keyFile: args.keyFile, archive: args.archive });
      break;
    case 'inventory':
      need('root');
      report = inventoryEngagement({ root: args.root });
      break;
    case 'offboard':
      need('root');
      if (args.execute === true) {
        need('approval', 'confirm', 'certificate');
        report = await executeDisposition({ root: args.root, approvalFile: args.approval, confirm: args.confirm, certificate: args.certificate });
      } else {
        report = { dryRun: true, ...(await planDisposition({ root: args.root })) };
        if (args.planOut !== undefined) writeFileSync(resolve(args.planOut), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
      }
      break;
    default:
      fail('Usage: engagement-ops.mjs <init|preflight|status|record|backup|verify|restore|inventory|offboard> --root <dir> ... (see the header of this file)');
  }
  console.log(JSON.stringify(report, null, 2));
  if (args.command === 'preflight' && report.status !== 'PASS') process.exitCode = 1;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(`[engagement-ops] ${error instanceof EngagementOpsError ? error.message : `failed: ${error?.message ?? error}`}`);
    process.exitCode = 1;
  });
}
