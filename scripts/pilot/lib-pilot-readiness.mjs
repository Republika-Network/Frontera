// PROD-03 — the pilot readiness gate: one closed, deterministic checklist
// (PR-01 … PR-20) over what a running deployment already reports.
//
// Read-only by construction. It sends HTTP GET requests only, to routes the
// Host already serves (`/version`, `/live`, `/ready`, `/health` and operator
// reads under `/api/admin/...`), reads files it is pointed at (a backup set, a
// restore report, an acknowledgement, a previous qualification record) and,
// when asked, runs the existing deployment preflight
// (scripts/deploy/host-preflight.mjs — the same checks `config-check` and the
// launcher run). It never issues, revokes, approves, stops, releases,
// provisions, resolves, executes, opens a store or contacts the witness or
// signer itself. It holds credentials only to read, and never prints them.
//
// Three cumulative levels, never one boolean:
//   deployment-ready   the Host is safe to accept governed executions
//   organization-ready … and the organization is bootstrapped, operable and governed
//   pilot-ready        … and one agent with an active credential holds bounded
//                         standing authority, and the pilot's backup (judged by
//                         PROD-02's store registry), restore drill and the pilot
//                         owner's acknowledgement are evidenced
// A check that cannot be evaluated fails. Nothing here can make a Host ready:
// `/ready` and `/health` are the Host's own answers, and the gate only reads
// them. The qualification record it can write is operational evidence bound
// to a fingerprint of the deployment, with an expiry — not authority, not a
// signature (see docs/pilot/PILOT_READINESS.md §5).

import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

// PROD-02's one reading of a backup's store inventory and coverage (pure; opens nothing) — the same validators restore:v1 runs.
import { BackupManifestError, assessBackupCoverage, validateManifestStoreEntries } from '../portability/store-registry.mjs';

export const READINESS_FORMAT = 'frontera.pilot-readiness.v1';
export const RECORD_FORMAT = 'frontera.pilot-qualification-record.v1';
export const ACKNOWLEDGEMENT_FORMAT = 'frontera.pilot-acknowledgement.v1';
export const LEVELS = Object.freeze(['deployment', 'organization', 'pilot']);
export const RESULTS = Object.freeze({ none: 'not-ready', deployment: 'deployment-ready', organization: 'organization-ready', pilot: 'pilot-ready' });
export const REQUIRED_ACKNOWLEDGED_DOCUMENTS = Object.freeze(['shared-responsibility', 'security-posture', 'known-limits']);
/**
 * The one role whose acknowledgement satisfies PR-18: the pilot owner — the
 * person accountable for the pilot on the organization's side
 * (docs/pilot/SHARED_RESPONSIBILITY.md). An operational role, not an
 * operator-plane role: no CTRL operator role (organization-administrator,
 * approver, observer, …) is the pilot owner by holding it.
 */
export const ACKNOWLEDGING_ROLE = 'pilot-owner';
export const DEFAULT_BACKUP_MAX_AGE_HOURS = 168;
export const DEFAULT_RECORD_VALIDITY_DAYS = 30;
export const MAX_RECORD_VALIDITY_DAYS = 90;
const REQUEST_TIMEOUT_MS = 5000;

/** The checklist. `level` is the first level a check gates; every check is required at its level. */
export const CHECKS = Object.freeze([
  { id: 'PR-01', name: 'release-identity', level: 'deployment', title: 'Build and version identified', remediation: 'docs/pilot/OPERATIONS_RUNBOOK.md §2 (steps 1-2, 10)' },
  { id: 'PR-02', name: 'secure-configuration', level: 'deployment', title: 'Secure configuration validated and secure posture composed', remediation: 'docs/deployment/PILOT_DEPLOYMENT.md §16; docs/pilot/PILOT_READINESS.md §5' },
  { id: 'PR-03', name: 'data-directories', level: 'deployment', title: 'Data directories durable, writable, intact', remediation: 'docs/pilot/OPERATIONS_RUNBOOK.md §9 (storage issue)' },
  { id: 'PR-04', name: 'freshness-witness', level: 'deployment', title: 'Authority-state witness configured and healthy', remediation: 'docs/pilot/OPERATIONS_RUNBOOK.md §16; docs/pilot/INCIDENT_TRIAGE.md' },
  { id: 'PR-05', name: 'authority-signer', level: 'deployment', title: 'Authority signer configured and available', remediation: 'docs/pilot/OPERATIONS_RUNBOOK.md §15' },
  { id: 'PR-06', name: 'host-ready', level: 'deployment', title: 'Host live, ready and healthy', remediation: 'docs/pilot/OPERATIONS_RUNBOOK.md §9' },
  { id: 'PR-07', name: 'organization', level: 'organization', title: 'Organization bootstrapped', remediation: 'docs/pilot/ONBOARDING_RUNBOOK.md §4' },
  { id: 'PR-08', name: 'operators', level: 'organization', title: 'Organization administrator and operator credentials valid', remediation: 'docs/pilot/ONBOARDING_RUNBOOK.md §3' },
  { id: 'PR-09', name: 'governance-profile', level: 'organization', title: 'Required Governance Profile active', remediation: 'docs/pilot/ONBOARDING_RUNBOOK.md §5' },
  { id: 'PR-10', name: 'pilot-agent', level: 'pilot', title: 'Pilot agent onboarded with an active credential', remediation: 'docs/pilot/ONBOARDING_RUNBOOK.md §6' },
  { id: 'PR-11', name: 'bounded-authority', level: 'pilot', title: 'That same agent holds standing authority, and every active lineage is bounded', remediation: 'docs/pilot/ONBOARDING_RUNBOOK.md §7' },
  { id: 'PR-12', name: 'approval-path', level: 'organization', title: 'Approval path usable (when approvals are configured)', remediation: 'docs/pilot/ONBOARDING_RUNBOOK.md §8' },
  { id: 'PR-13', name: 'emergency-controls', level: 'deployment', title: 'Emergency controls readable; no global or organization stop active', remediation: 'docs/pilot/OPERATIONS_RUNBOOK.md §12' },
  { id: 'PR-14', name: 'activity-evidence', level: 'organization', title: 'Activity, metrics and evidence readable', remediation: 'docs/pilot/ONBOARDING_RUNBOOK.md §10' },
  { id: 'PR-15', name: 'backup', level: 'pilot', title: 'A complete, verified cold backup of this deployment and release', remediation: 'docs/pilot/OPERATIONS_RUNBOOK.md §5' },
  { id: 'PR-16', name: 'restore-drill', level: 'pilot', title: 'A restore of that backup qualified', remediation: 'docs/pilot/OPERATIONS_RUNBOOK.md §6' },
  { id: 'PR-17', name: 'diagnostics', level: 'deployment', title: 'Operator diagnostics answer', remediation: 'docs/pilot/OPERATIONS_RUNBOOK.md §9' },
  { id: 'PR-18', name: 'acknowledgement', level: 'pilot', title: 'Shared responsibility, security posture and known limits acknowledged by the pilot owner for this release', remediation: 'docs/pilot/PILOT_READINESS.md §5.4' },
  { id: 'PR-19', name: 'revocation-path', level: 'pilot', title: 'Revocation and emergency stop operable by a verified operator', remediation: 'docs/pilot/ONBOARDING_RUNBOOK.md §11' },
  { id: 'PR-20', name: 'integrity-freshness', level: 'deployment', title: 'No blocking integrity or freshness condition', remediation: 'docs/pilot/INCIDENT_TRIAGE.md §2' },
]);

/** CHECKS ids whose satisfaction may come from a valid qualification record (historical drills and human acknowledgement only). */
export const RECORDABLE_CHECKS = Object.freeze(['PR-15', 'PR-16', 'PR-18']);

const SECURE_POSTURE = Object.freeze({
  persistence: 'durable',
  authentication: 'required',
  governedActions: 'composed',
  authorityStore: 'authenticated-durable',
  kernelAuthority: 'composed',
  emergencyControl: 'composed',
  exerciseControls: 'composed',
  authorityFreshness: 'external',
  evidenceStore: 'durable',
});
const BLOCKING_FRESHNESS = new Set(['regressed', 'forked', 'pending-recovery', 'unbound']);

// -- small helpers -----------------------------------------------------------------

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const sha256 = (data) => `sha256:${createHash('sha256').update(data).digest('hex')}`;

/** Deterministic JSON (sorted keys) — what every digest here is over. */
export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

/** A bounded reason token: what a check reports instead of a message or a stack. */
const TOKEN = (text) => String(text).toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 64) || 'UNKNOWN';

function outcome(status, reason, detail) {
  return { status, ...(reason !== undefined ? { reason } : {}), ...(detail !== undefined ? { detail } : {}) };
}
const pass = (detail) => outcome('pass', undefined, detail);
const fail = (reason, detail) => outcome('fail', reason, detail);
const notApplicable = (detail) => outcome('not-applicable', undefined, detail);

// -- read-only HTTP -----------------------------------------------------------------

/**
 * GET only. The method is fixed here and nowhere else in the gate; a
 * structural test proves no other method is ever sent. Never throws: an
 * unreachable Host is `{ status: 0 }`.
 */
export function createReader({ hostUrl, credential, fetchImpl = fetch, timeoutMs = REQUEST_TIMEOUT_MS }) {
  const base = new URL(hostUrl);
  return async function get(path, { authorization = credential, anonymous = false } = {}) {
    const url = new URL(path, base);
    if (url.origin !== base.origin) return { status: 0, error: 'CROSS_ORIGIN_REFUSED' };
    try {
      const response = await fetchImpl(url, {
        method: 'GET',
        redirect: 'manual',
        headers: { accept: 'application/json', ...(!anonymous && authorization !== undefined ? { authorization: `Bearer ${authorization}` } : {}) },
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await response.text();
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        body = undefined;
      }
      return { status: response.status, body };
    } catch {
      return { status: 0, error: 'HOST_UNREACHABLE' };
    }
  };
}

// -- file evidence ----------------------------------------------------------------------

function readJsonFile(path) {
  try {
    return { value: JSON.parse(readFileSync(path, 'utf8')), digest: sha256(readFileSync(path)) };
  } catch {
    return undefined;
  }
}

function filesUnder(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) out.push(path);
    }
  };
  walk(root);
  return out;
}

/** sha256 hex of a file, or undefined when it cannot be read. */
function fileDigest(path) {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch {
    return undefined;
  }
}

/**
 * Verifies a backup set produced by `backup:v1`, never by its own claim of
 * completeness:
 *
 * 1. the manifest's store inventory, by PROD-02's own validator (closed store
 *    names, registry filenames, no duplicates);
 * 2. coverage, by PROD-02's own assessment (`assessBackupCoverage`, the one
 *    restore:v1 runs): every store the backup's recorded deployment requires
 *    under THIS build's registry conditions, and every store THIS deployment
 *    requires (`deploymentRequirements`, derived by the preflight exactly as
 *    backup and restore derive it), is included; `coverage.complete` is one
 *    input, never the answer. Without the deployment's requirements coverage
 *    cannot be judged, and the check fails;
 * 3. artifacts: `stores/` holds exactly the declared store files; each matches
 *    the manifest's own checksum AND has a matching `checksums.sha256` entry;
 *    every other `checksums.sha256` entry verifies;
 * 4. cold consistency, organization and release binding, no secret (by the
 *    manifest's flags and by searching every file for the credentials this
 *    gate holds), and age.
 *
 * Read-only: files are read and hashed; no store is opened, nothing restored.
 * SQLite integrity and signed heads are restore:v1's (PR-16 evidences it).
 */
export function verifyBackupSet(path, { organizationId, commit, now, maxAgeHours, heldSecrets, deploymentRequirements }) {
  let dir = resolve(path);
  if (!existsSync(join(dir, 'backup-manifest.json')) && existsSync(join(dir, 'frontera-backup', 'backup-manifest.json'))) dir = join(dir, 'frontera-backup');
  const manifestFile = readJsonFile(join(dir, 'backup-manifest.json'));
  if (manifestFile === undefined) return fail('BACKUP_MANIFEST_UNREADABLE');
  const manifest = manifestFile.value;
  if (manifest?.backupFormat !== 'aoc.enterprise.backup.v1') return fail('BACKUP_FORMAT_UNSUPPORTED');

  // 1-2. Inventory and coverage: PROD-02's validators, verbatim.
  let coverage;
  try {
    validateManifestStoreEntries(manifest);
    if (manifest.coverage?.deployment?.organizationId !== organizationId) return fail('BACKUP_OTHER_ORGANIZATION');
    if (!isRecord(deploymentRequirements)) return fail('BACKUP_COVERAGE_NOT_VERIFIABLE', 'run with --preflight in the Host environment: coverage is judged against this deployment\'s own store requirements');
    coverage = assessBackupCoverage(manifest, deploymentRequirements);
  } catch (error) {
    if (error instanceof BackupManifestError) return fail('BACKUP_MANIFEST_INVALID');
    throw error;
  }
  if (!coverage.complete) {
    const missing = [...new Set([...(coverage.missingForSource ?? []), ...(coverage.missingForTarget ?? []), ...manifest.coverage?.stores?.filter((entry) => entry?.required === true && entry?.included !== true).map((entry) => entry.name) ?? []])].sort();
    return fail('BACKUP_INCOMPLETE', missing.length > 0 ? `missing required store(s): ${missing.join(', ')}` : coverage.model === 'legacy' ? 'no PROD-02 coverage record' : 'recorded as incomplete');
  }

  // 3. Artifacts.
  let checksums;
  try {
    checksums = readFileSync(join(dir, 'checksums.sha256'), 'utf8');
  } catch {
    return fail('BACKUP_CHECKSUMS_UNREADABLE');
  }
  const listed = new Map();
  for (const line of checksums.split('\n')) {
    if (line.trim() === '') continue;
    const match = /^([0-9a-f]{64}) [ *](.+)$/.exec(line);
    if (match === null) return fail('BACKUP_CHECKSUMS_MALFORMED');
    const file = resolve(dir, match[2]);
    if (!file.startsWith(`${dir}${sep}`)) return fail('BACKUP_CHECKSUMS_MALFORMED');
    listed.set(file, match[1]);
  }
  const storesDir = join(dir, 'stores');
  let present;
  try {
    if (lstatSync(storesDir).isSymbolicLink()) return fail('BACKUP_STORES_DIRECTORY_INVALID');
    present = new Set(readdirSync(storesDir));
  } catch {
    return fail('BACKUP_STORES_DIRECTORY_INVALID');
  }
  const declared = new Set(manifest.stores.map((entry) => entry.filename));
  if ([...present].some((file) => !declared.has(file))) return fail('BACKUP_UNEXPECTED_FILE');
  for (const entry of manifest.stores) {
    const file = join(storesDir, entry.filename);
    if (!present.has(entry.filename) || lstatSync(file).isSymbolicLink()) return fail('BACKUP_STORE_FILE_MISSING', entry.name);
    const digest = fileDigest(file);
    if (digest === undefined) return fail('BACKUP_STORE_FILE_MISSING', entry.name);
    if (`sha256:${digest}` !== entry.checksum) return fail('BACKUP_CHECKSUM_MISMATCH', entry.name);
    if (!listed.has(file)) return fail('BACKUP_CHECKSUM_MISSING', entry.name);
    if (listed.get(file) !== digest) return fail('BACKUP_CHECKSUM_MISMATCH', entry.name);
  }
  for (const [file, expected] of listed) {
    const digest = fileDigest(file);
    if (digest === undefined) return fail('BACKUP_FILE_MISSING');
    if (digest !== expected) return fail('BACKUP_CHECKSUM_MISMATCH');
  }

  // 4. Consistency, secrets, release, age.
  if (manifest?.consistency?.mode !== 'cold-attested') return fail('BACKUP_NOT_COLD');
  const flags = [manifest?.authority?.signer?.privateKeyIncluded, manifest?.authority?.signer?.signerCredentialIncluded, manifest?.authority?.freshness?.witnessStateIncluded, manifest?.authority?.freshness?.witnessCredentialIncluded, manifest?.configuration?.secretValuesIncluded];
  if (flags.some((flag) => flag !== false)) return fail('BACKUP_SECRET_FLAG_SET');
  for (const file of filesUnder(dir)) {
    const bytes = readFileSync(file);
    for (const secret of heldSecrets) if (secret.length >= 16 && bytes.includes(Buffer.from(secret, 'utf8'))) return fail('BACKUP_CONTAINS_CREDENTIAL');
  }
  if (typeof commit === 'string' && manifest?.source?.commit !== commit) return fail('BACKUP_RELEASE_MISMATCH');
  const createdAt = Date.parse(manifest?.createdAt ?? '');
  if (Number.isNaN(createdAt)) return fail('BACKUP_TIMESTAMP_INVALID');
  if (now.getTime() - createdAt > maxAgeHours * 3600_000) return fail('BACKUP_STALE', `created ${manifest.createdAt}`);
  if (createdAt - now.getTime() > 300_000) return fail('BACKUP_TIMESTAMP_INVALID');
  return {
    ...pass(`backup ${manifest.backupId}: ${manifest.stores.length} required store(s) covered (PROD-02 registry), ${listed.size} checksums verified, created ${manifest.createdAt}`),
    evidence: { backupId: manifest.backupId, createdAt: manifest.createdAt, manifestDigest: manifestFile.digest, stores: manifest.stores.map((entry) => entry.name) },
  };
}

/** A `restore:v1` report, bound to the verified backup. */
export function verifyRestoreReport(path, { backup }) {
  const file = readJsonFile(path);
  if (file === undefined) return fail('RESTORE_REPORT_UNREADABLE');
  const report = file.value;
  if (report?.status !== 'restored') return fail('RESTORE_NOT_COMPLETED');
  if (report?.coverage?.complete !== true) return fail('RESTORE_INCOMPLETE');
  if (report?.checksumResult !== 'ok' || report?.sqliteIntegrityResult !== 'ok') return fail('RESTORE_NOT_VERIFIED');
  if (backup === undefined) return fail('RESTORE_BACKUP_NOT_EVIDENCED');
  if (report?.backupId !== backup.backupId) return fail('RESTORE_OF_ANOTHER_BACKUP');
  const finishedAt = Date.parse(report?.finishedAt ?? '');
  if (Number.isNaN(finishedAt) || finishedAt < Date.parse(backup.createdAt)) return fail('RESTORE_TIMESTAMP_INVALID');
  return { ...pass(`restore of ${report.backupId} finished ${report.finishedAt}`), evidence: { backupId: report.backupId, finishedAt: report.finishedAt, reportDigest: file.digest } };
}

export function verifyAcknowledgement(path, { organizationId, commit }) {
  const file = readJsonFile(path);
  if (file === undefined) return fail('ACKNOWLEDGEMENT_UNREADABLE');
  const ack = file.value;
  if (ack?.schema !== ACKNOWLEDGEMENT_FORMAT) return fail('ACKNOWLEDGEMENT_FORMAT_UNSUPPORTED');
  if (ack.organizationId !== organizationId) return fail('ACKNOWLEDGEMENT_OTHER_ORGANIZATION');
  if (ack.release?.commit !== commit) return fail('ACKNOWLEDGEMENT_STALE', 'acknowledged for another release');
  const people = Array.isArray(ack.acknowledgedBy) ? ack.acknowledgedBy.filter((entry) => isRecord(entry) && typeof entry.name === 'string' && entry.name.trim() !== '' && typeof entry.role === 'string' && entry.role.trim() !== '' && !Number.isNaN(Date.parse(entry.acknowledgedAt ?? ''))) : [];
  if (people.length === 0) return fail('ACKNOWLEDGEMENT_UNSIGNED');
  // Only the pilot owner's acknowledgement counts; others may co-sign.
  const owners = people.filter((entry) => entry.role === ACKNOWLEDGING_ROLE);
  if (owners.length === 0) return fail('ACKNOWLEDGEMENT_NOT_BY_PILOT_OWNER', `role ${ACKNOWLEDGING_ROLE} required`);
  const documents = Array.isArray(ack.documents) ? ack.documents : [];
  const missing = REQUIRED_ACKNOWLEDGED_DOCUMENTS.filter((document) => !documents.includes(document));
  if (missing.length > 0) return fail('ACKNOWLEDGEMENT_INCOMPLETE', `not acknowledged: ${missing.join(', ')}`);
  return { ...pass(`acknowledged by the pilot owner for this release (${people.length} signatory(ies))`), evidence: { digest: file.digest, people: people.length, pilotOwners: owners.length } };
}

// -- the record ------------------------------------------------------------------------------

const FINGERPRINT_FIELDS = Object.freeze(['organizationId', 'release', 'configurationChecksum', 'posture', 'signer', 'witnessId', 'activeProfiles', 'governedActionsFile', 'lastRestore']);

/** What makes a qualification record stale when it changes: the material deployment facts (PROD-03 §53). */
export function fingerprintDigest(fingerprint) {
  return sha256(stableStringify(fingerprint));
}

/** `valid` | `expired` | `invalidated` | `malformed`, with what changed. A record never satisfies a live check. */
export function assessRecord(record, { fingerprint, now }) {
  if (!isRecord(record) || record.schema !== RECORD_FORMAT || !isRecord(record.fingerprint) || !Array.isArray(record.checks)) return { status: 'malformed' };
  if (record.fingerprintDigest !== fingerprintDigest(record.fingerprint)) return { status: 'malformed' };
  const changed = FINGERPRINT_FIELDS.filter((field) => stableStringify(record.fingerprint[field] ?? null) !== stableStringify(fingerprint[field] ?? null));
  if (changed.length > 0) return { status: 'invalidated', changed };
  const validUntil = Date.parse(record.validUntil ?? '');
  if (Number.isNaN(validUntil) || now.getTime() > validUntil) return { status: 'expired' };
  return { status: 'valid' };
}

// -- the gate --------------------------------------------------------------------------------

/**
 * Evaluates the checklist. Pure over what it reads: the same deployment state
 * and inputs give the same result. Returns the report; never throws for a
 * Host condition (an exception inside a check is that check failing).
 */
export async function evaluatePilotReadiness(options) {
  const now = options.now ?? new Date();
  const get = options.reader ?? createReader({ hostUrl: options.hostUrl, credential: options.credential, ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}) });
  const results = new Map();
  const set = (id, result) => results.set(id, result);
  const guarded = async (id, body) => {
    try {
      set(id, await body());
    } catch (error) {
      set(id, fail('CHECK_NOT_EVALUATED', TOKEN(error?.code ?? 'ERROR')));
    }
  };

  // Probes and reads, once each.
  const [version, live, ready, health] = await Promise.all(['/version', '/live', '/ready', '/health'].map((path) => get(path, { anonymous: true })));
  const healthBody = isRecord(health.body) ? health.body : undefined;
  const posture = isRecord(healthBody?.posture) ? healthBody.posture : undefined;
  const organization = await get('/api/admin/organization');
  const orgBody = organization.status === 200 && isRecord(organization.body?.organization) ? organization.body : undefined;
  const organizationId = orgBody?.organization?.organizationId;
  const identity = version.status === 200 && isRecord(version.body) ? version.body : undefined;

  // Verified operator credentials: the reading credential plus any named one. Values stay here.
  const operatorViews = [];
  if (orgBody !== undefined && isRecord(orgBody.operator)) operatorViews.push(orgBody.operator);
  for (const secret of options.operatorCredentials ?? []) {
    const reply = await get('/api/admin/organization', { authorization: secret });
    if (reply.status === 200 && isRecord(reply.body?.operator)) operatorViews.push(reply.body.operator);
    else operatorViews.push({ invalid: true });
  }

  // Preflight: the existing deployment preflight, in this process's environment (the Host's).
  let preflight;
  if (options.preflight !== undefined) {
    try {
      preflight = await options.preflight();
    } catch {
      preflight = { failed: true };
    }
  }
  const preflightCheck = (ids) => {
    if (preflight === undefined) return fail('PREFLIGHT_NOT_EVALUATED', 'run with --preflight in the Host environment');
    if (preflight.failed === true || !Array.isArray(preflight.checks)) return fail('PREFLIGHT_FAILED_TO_RUN');
    const relevant = preflight.checks.filter((check) => ids.includes(check.id));
    if (relevant.length === 0) return fail('PREFLIGHT_INCOMPLETE');
    const failed = relevant.find((check) => check.status === 'fail');
    if (failed !== undefined) return fail(TOKEN(failed.code ?? 'PREFLIGHT_FAILED'), failed.id);
    if (relevant.some((check) => check.status === 'skip')) return fail('PREFLIGHT_INCOMPLETE');
    return pass(relevant.map((check) => `${check.id}: ${check.status}`).join('; '));
  };

  await guarded('PR-01', async () => {
    if (identity === undefined) return fail('RELEASE_IDENTITY_UNAVAILABLE');
    if (identity.schema !== 'frontera.release-identity.v1') return fail('RELEASE_IDENTITY_UNSUPPORTED');
    if (identity.build !== 'release' || !/^[0-9a-f]{40}$/.test(identity.commit ?? '')) return fail('RELEASE_NOT_IDENTIFIED', `build=${TOKEN(identity.build ?? 'unknown').toLowerCase()}`);
    if (options.expectCommit !== undefined && identity.commit !== options.expectCommit) return fail('RELEASE_COMMIT_MISMATCH');
    return pass(`${identity.release} (build=release)`);
  });

  await guarded('PR-02', async () => {
    const configured = preflightCheck(['release-identity', 'placeholders', 'configuration']);
    if (configured.status !== 'pass') return configured;
    if (posture === undefined) return fail('POSTURE_UNAVAILABLE');
    if (posture.environment !== 'production' && posture.environment !== 'staging') return fail('POSTURE_NOT_SECURE_PROFILE');
    for (const [field, expected] of Object.entries(SECURE_POSTURE)) if (posture[field] !== expected) return fail('POSTURE_NOT_SECURE', `${field}=${TOKEN(posture[field] ?? 'missing').toLowerCase()}`);
    if (posture.obligations === 'ephemeral' || posture.approvals === 'ephemeral') return fail('POSTURE_NOT_SECURE', 'ephemeral authority state');
    return pass(`environment=${posture.environment}; secure posture composed`);
  });

  await guarded('PR-03', async () => preflightCheck(['storage']));

  await guarded('PR-04', async () => {
    const freshness = healthBody?.authorityFreshness;
    if (healthBody === undefined) return fail('HEALTH_UNAVAILABLE');
    if (!isRecord(freshness) || freshness.mode !== 'external') return fail('WITNESS_NOT_COMPOSED');
    if (freshness.witness?.state !== 'ready') return fail('WITNESS_UNAVAILABLE', TOKEN(freshness.witness?.reason ?? 'unavailable'));
    const stores = Array.isArray(freshness.stores) ? freshness.stores : [];
    if (stores.length === 0) return fail('FRESHNESS_STORES_UNREPORTED');
    const notReady = stores.find((store) => store.status !== 'ready');
    if (notReady !== undefined) return fail(`FRESHNESS_${TOKEN(notReady.status)}`, `${notReady.stateKind}`);
    return pass(`witness ${freshness.witnessId} ready; ${stores.length} anchored store(s) ready`);
  });

  await guarded('PR-05', async () => {
    if (healthBody === undefined) return fail('HEALTH_UNAVAILABLE');
    const signer = healthBody.authoritySigner;
    if (!isRecord(signer)) return fail('SIGNER_NOT_COMPOSED');
    if (signer.state !== 'ready') return fail('SIGNER_UNAVAILABLE', TOKEN(signer.reason ?? 'unavailable'));
    if (options.requireExternalCustody === true && signer.custody !== 'external') return fail('SIGNER_SOFTWARE_CUSTODY_NOT_ACCEPTED');
    return pass(`custody=${signer.custody} key=${signer.keyId} ready`);
  });

  await guarded('PR-06', async () => {
    if (live.status !== 200 || live.body?.live !== true) return fail('HOST_NOT_LIVE');
    if (ready.status !== 200 || ready.body?.ready !== true) return fail('HOST_NOT_READY', TOKEN(ready.body?.lifecycleState ?? 'unknown'));
    if (healthBody === undefined) return fail('HEALTH_UNAVAILABLE');
    if (healthBody.status === 'healthy') return pass('live, ready, healthy');
    if (healthBody.status !== 'degraded') return fail('HEALTH_UNHEALTHY');
    const impaired = Object.entries(isRecord(healthBody.modules) ? healthBody.modules : {})
      .filter(([, entry]) => entry?.health?.status !== 'healthy')
      .map(([moduleId, entry]) => ({ moduleId, required: entry?.required === true }));
    const accepted = new Set(options.acceptDegradedModules ?? []);
    const unaccepted = impaired.filter((entry) => entry.required || !accepted.has(entry.moduleId));
    // A degraded witness or signer shows up here as `degraded` with every module healthy: those are PR-04 / PR-05's.
    if (impaired.length === 0) return fail('HEALTH_DEGRADED', 'witness or signer impaired');
    if (unaccepted.length > 0) return fail('HEALTH_DEGRADED', unaccepted.map((entry) => entry.moduleId).join(','));
    return pass(`degraded only by accepted optional module(s): ${impaired.map((entry) => entry.moduleId).join(',')}`);
  });

  await guarded('PR-13', async () => {
    const reply = await get('/api/admin/emergency-controls');
    if (reply.status !== 200 || !Array.isArray(reply.body?.active)) return fail('EMERGENCY_CONTROLS_UNREADABLE', `HTTP ${reply.status}`);
    const blocking = reply.body.active.filter((control) => control?.scope === 'global' || control?.scope === 'organization');
    if (blocking.length > 0) return fail('EMERGENCY_STOP_ACTIVE', blocking.map((control) => control.scope).join(','));
    return pass(`${reply.body.active.length} narrower stop(s) active`);
  });

  let operationsHealth;
  await guarded('PR-17', async () => {
    operationsHealth = await get('/api/admin/operations/health');
    if (operationsHealth.status !== 200 && operationsHealth.status !== 503) return fail('DIAGNOSTICS_UNREADABLE', `HTTP ${operationsHealth.status}`);
    const operations = operationsHealth.body?.operations;
    if (!isRecord(operations)) return fail('DIAGNOSTICS_UNREADABLE');
    return pass(`unresolved executions: ${operations.unresolvedExecutions ?? 'unknown'}; attention required: ${operations.attentionRequired ?? 'unknown'}`);
  });

  await guarded('PR-20', async () => {
    if (healthBody === undefined) return fail('HEALTH_UNAVAILABLE');
    if (healthBody.persistence?.connected !== true) return fail('PERSISTENCE_DISCONNECTED');
    const failingRequired = Object.entries(isRecord(healthBody.modules) ? healthBody.modules : {}).filter(([, entry]) => entry?.required === true && entry?.health?.status !== 'healthy');
    if (failingRequired.length > 0) return fail('REQUIRED_MODULE_UNHEALTHY', failingRequired.map(([moduleId]) => moduleId).join(','));
    const blocked = (healthBody.authorityFreshness?.stores ?? []).find((store) => BLOCKING_FRESHNESS.has(store.status));
    if (blocked !== undefined) return fail(`FRESHNESS_${TOKEN(blocked.status)}`, blocked.stateKind);
    if (healthBody.status === 'unhealthy') return fail('HEALTH_UNHEALTHY');
    return pass('no integrity or freshness failure reported');
  });

  // Organization level.
  await guarded('PR-07', async () => {
    if (organization.status !== 200 || orgBody === undefined) return fail('OPERATOR_PLANE_UNREADABLE', `HTTP ${organization.status}`);
    if (options.expectOrganization !== undefined && organizationId !== options.expectOrganization) return fail('ORGANIZATION_MISMATCH');
    const [roots, domains] = await Promise.all([get('/api/admin/authority/entities?kind=root-issuer&status=active'), get('/api/admin/authority/entities?kind=trust-domain&status=active')]);
    if (roots.status !== 200 || domains.status !== 200) return fail('AUTHORITY_INVENTORY_UNREADABLE');
    const trustDomainId = orgBody.organization.trustDomainId;
    if (!(domains.body.entities ?? []).some((entity) => entity.entityId === trustDomainId)) return fail('ORGANIZATION_NOT_BOOTSTRAPPED', 'trust domain');
    if ((roots.body.entities ?? []).length === 0) return fail('ORGANIZATION_NOT_BOOTSTRAPPED', 'root issuer');
    return pass(`organization ${organizationId}, trust domain ${trustDomainId}`);
  });

  await guarded('PR-08', async () => {
    if (operatorViews.length === 0) return fail('OPERATOR_PLANE_UNREADABLE');
    if (operatorViews.some((view) => view.invalid === true)) return fail('OPERATOR_CREDENTIAL_INVALID');
    if (operatorViews.some((view) => view.credentialClass !== 'operator')) return fail('OPERATOR_CREDENTIAL_CLASS_INVALID');
    if (!operatorViews.some((view) => view.role === 'organization-administrator')) return fail('ADMINISTRATOR_NOT_VERIFIED');
    return pass(`${operatorViews.length} operator credential(s) verified: ${[...new Set(operatorViews.map((view) => view.role))].sort().join(', ')}`);
  });

  let activeProfiles = [];
  await guarded('PR-09', async () => {
    const reply = await get('/api/admin/governance-profiles');
    if (reply.status !== 200 || !Array.isArray(reply.body?.profiles)) return fail('PROFILES_UNREADABLE', `HTTP ${reply.status}`);
    activeProfiles = reply.body.profiles.filter((profile) => profile.state === 'active').map((profile) => `${profile.profileId}@${profile.version}#${profile.digest}`).sort();
    const activeIds = new Set(reply.body.profiles.filter((profile) => profile.state === 'active').map((profile) => profile.profileId));
    const required = options.requireProfiles ?? [];
    const missing = required.filter((profileId) => !activeIds.has(profileId));
    if (missing.length > 0) return fail('PROFILE_NOT_ACTIVE', missing.join(','));
    if (activeIds.size === 0) return fail('PROFILE_NOT_ACTIVE', 'no active profile');
    return pass(`${activeIds.size} active profile(s) (${reply.body.lifecycle})`);
  });

  await guarded('PR-12', async () => {
    if (posture === undefined) return fail('POSTURE_UNAVAILABLE');
    if (posture.approvals === 'not-configured') return options.requireApprovals === true ? fail('APPROVALS_NOT_CONFIGURED') : notApplicable('no profile declares approval');
    if (posture.approvals !== 'durable') return fail('APPROVALS_NOT_DURABLE');
    const reply = await get('/api/admin/approvals?view=pending');
    if (reply.status !== 200 || !Array.isArray(reply.body?.approvals)) return fail('APPROVAL_INBOX_UNREADABLE', `HTTP ${reply.status}`);
    return pass(`approval inbox readable; ${reply.body.approvals.length} pending`);
  });

  await guarded('PR-14', async () => {
    const [activity, metrics] = await Promise.all([get('/api/admin/activity/decisions?limit=1'), get('/api/admin/operations/metrics')]);
    if (activity.status !== 200 || !Array.isArray(activity.body?.decisions)) return fail('ACTIVITY_UNREADABLE', `HTTP ${activity.status}`);
    if (metrics.status !== 200 || !isRecord(metrics.body)) return fail('METRICS_UNREADABLE', `HTTP ${metrics.status}`);
    const latest = activity.body.decisions[0];
    if (latest === undefined) return pass('activity and metrics readable; no decision yet');
    const trace = await get(`/api/admin/operations/traces/${encodeURIComponent(latest.requestId)}?level=AUDITOR`);
    if (trace.status !== 200 || !isRecord(trace.body)) return fail('EVIDENCE_UNREADABLE', `HTTP ${trace.status}`);
    return pass('activity, metrics and the latest decision\'s trace readable');
  });

  // Pilot level. PR-10 and PR-11 are correlated: both are about the SAME
  // agents — those whose actor is active and whose credential is active, i.e.
  // agents that can authenticate a governed request today. PR-11 needs one of
  // them to hold standing authority; authority held by an agent that cannot
  // authenticate never stands in for it (no union across agents).
  let agents = [];
  let pilotCapable = [];
  await guarded('PR-10', async () => {
    const reply = await get('/api/admin/agents');
    if (reply.status !== 200 || !Array.isArray(reply.body?.agents)) return fail('INVENTORY_UNREADABLE', `HTTP ${reply.status}`);
    agents = reply.body.agents;
    pilotCapable = agents.filter((agent) => agent.onboarding?.actor === 'active' && agent.onboarding?.credential === 'active');
    if (pilotCapable.length === 0) return fail('NO_PILOT_AGENT');
    return pass(`${pilotCapable.length} agent(s) with an active identity and an active credential`);
  });

  await guarded('PR-11', async () => {
    const entity = async (kind, id) => {
      const reply = await get(`/api/admin/authority/entities/${kind}/${encodeURIComponent(id)}`);
      if (reply.status !== 200 || !isRecord(reply.body)) throw Object.assign(new Error('unreadable'), { code: 'AUTHORITY_UNREADABLE' });
      return reply.body;
    };
    const bounded = (terms) => (Array.isArray(terms?.constraints) && terms.constraints.length > 0) || (Array.isArray(terms?.parameterBounds) && terms.parameterBounds.length > 0);
    // An agent holds standing authority through each ACTIVE delegation or authority grant naming it; every such lineage must be bounded.
    const lineagesOf = async (agent) => {
      const lineages = [];
      for (const ref of agent.authority?.delegationGrants ?? []) {
        if (ref.status !== 'active') continue;
        const delegation = await entity('delegation-grant', ref.entityId);
        const sourceId = delegation.terms?.sourceAuthorityGrantId;
        const source = typeof sourceId === 'string' ? await entity('authority-grant', sourceId) : undefined;
        lineages.push(bounded(delegation.terms) || bounded(source?.terms));
      }
      for (const ref of agent.authority?.authorityGrants ?? []) {
        if (ref.status !== 'active') continue;
        lineages.push(bounded((await entity('authority-grant', ref.entityId)).terms));
      }
      return lineages;
    };
    // Fail closed on breadth: an unbounded active lineage on ANY actor-active agent refuses — including one whose
    // credential is revoked, which is one credential issuance away from acting.
    const unbounded = [];
    const capable = new Set(pilotCapable.map((agent) => agent.actorId));
    let holders = 0;
    for (const agent of agents.filter((candidate) => candidate.onboarding?.actor === 'active')) {
      const lineages = await lineagesOf(agent);
      if (lineages.some((isBounded) => !isBounded)) unbounded.push(agent.actorId);
      else if (lineages.length > 0 && capable.has(agent.actorId)) holders += 1;
    }
    if (unbounded.length > 0) return fail('AUTHORITY_UNBOUNDED', unbounded.join(','));
    if (holders === 0) return fail('NO_STANDING_AUTHORITY', pilotCapable.length === 0 ? 'no agent with an active credential' : 'no agent with an active credential holds active standing authority');
    return pass(`${holders} agent(s) with an active credential hold standing authority; every active lineage carries P10 constraints or typed parameter bounds`);
  });

  // Evidence inputs, then the record.
  const heldSecrets = [options.credential, ...(options.operatorCredentials ?? [])].filter((value) => typeof value === 'string');
  const fresh = {};
  // An evidence verifier that throws is that check failing, never the gate.
  const evaluated = (verify) => {
    try {
      return verify();
    } catch (error) {
      return fail('CHECK_NOT_EVALUATED', TOKEN(error?.code ?? 'ERROR'));
    }
  };
  if (options.backupPath !== undefined) {
    fresh['PR-15'] =
      organizationId === undefined || identity === undefined
        ? fail('BACKUP_NOT_VERIFIABLE', 'organization or release unknown')
        : evaluated(() => verifyBackupSet(options.backupPath, { organizationId, commit: identity.commit, now, maxAgeHours: options.backupMaxAgeHours ?? DEFAULT_BACKUP_MAX_AGE_HOURS, heldSecrets, deploymentRequirements: preflight?.failed === true ? undefined : preflight?.deploymentRequirements }));
  }
  if (options.restoreReportPath !== undefined) {
    fresh['PR-16'] = evaluated(() => verifyRestoreReport(options.restoreReportPath, { backup: fresh['PR-15']?.evidence }));
  }
  if (options.acknowledgementPath !== undefined) {
    fresh['PR-18'] = organizationId === undefined || identity === undefined ? fail('ACKNOWLEDGEMENT_NOT_VERIFIABLE') : evaluated(() => verifyAcknowledgement(options.acknowledgementPath, { organizationId, commit: identity.commit }));
  }

  const signer = isRecord(healthBody?.authoritySigner) ? { custody: healthBody.authoritySigner.custody, keyId: healthBody.authoritySigner.keyId, algorithm: healthBody.authoritySigner.algorithm } : null;
  const fingerprint = {
    organizationId: organizationId ?? null,
    release: identity !== undefined ? { version: identity.version, commit: identity.commit, build: identity.build } : null,
    configurationChecksum: healthBody?.configurationChecksum ?? null,
    posture: posture !== undefined ? sha256(stableStringify(posture)) : null,
    signer,
    witnessId: healthBody?.authorityFreshness?.witnessId ?? null,
    activeProfiles,
    governedActionsFile: options.governedActionsFileDigest ?? null,
    lastRestore: options.lastRestoreFinishedAt ?? null,
  };

  let recordAssessment;
  if (options.record !== undefined) recordAssessment = assessRecord(options.record, { fingerprint, now });
  for (const id of RECORDABLE_CHECKS) {
    if (fresh[id] !== undefined) {
      set(id, fresh[id]);
      continue;
    }
    const recorded = recordAssessment?.status === 'valid' ? options.record.checks.find((check) => check.id === id) : undefined;
    if (recorded?.status === 'pass') set(id, { ...pass(`from qualification record of ${options.record.recordedAt}`), evidence: options.record.evidence?.[id], fromRecord: true });
    else if (recordAssessment !== undefined && recordAssessment.status !== 'valid') set(id, fail(`RECORD_${TOKEN(recordAssessment.status)}`, recordAssessment.changed?.join(',')));
    else set(id, fail({ 'PR-15': 'BACKUP_NOT_EVIDENCED', 'PR-16': 'RESTORE_DRILL_NOT_EVIDENCED', 'PR-18': 'ACKNOWLEDGEMENT_NOT_EVIDENCED' }[id]));
  }

  await guarded('PR-19', async () => {
    const permitted = (permission) => operatorViews.some((view) => view.invalid !== true && Array.isArray(view.permissions) && view.permissions.includes(permission));
    if (!permitted('authority.revoke')) return fail('REVOCATION_PATH_NOT_OPERABLE', 'no verified operator holds authority.revoke');
    if (!permitted('emergency.stop')) return fail('REVOCATION_PATH_NOT_OPERABLE', 'no verified operator holds emergency.stop');
    if (!permitted('agent-credential.revoke')) return fail('REVOCATION_PATH_NOT_OPERABLE', 'no verified operator holds agent-credential.revoke');
    return pass('a verified operator can revoke authority and credentials and declare an emergency stop');
  });

  // Levels: cumulative; every check at a level must pass (or be not-applicable).
  const checks = CHECKS.map((check) => ({ id: check.id, name: check.name, level: check.level, title: check.title, ...(results.get(check.id) ?? fail('CHECK_NOT_EVALUATED')), remediation: check.remediation }));
  const levelOk = (level) => checks.filter((check) => check.level === level).every((check) => check.status === 'pass' || check.status === 'not-applicable');
  const levels = {};
  let reached = 'none';
  let blocked = false;
  for (const level of LEVELS) {
    const ok = !blocked && levelOk(level);
    levels[level] = ok ? 'ready' : 'not-ready';
    if (ok) reached = level;
    else blocked = true;
  }
  return {
    schema: READINESS_FORMAT,
    evaluatedAt: now.toISOString(),
    result: RESULTS[reached],
    levels,
    release: identity !== undefined ? { version: identity.version, release: identity.release, commit: identity.commit, build: identity.build } : null,
    organizationId: organizationId ?? null,
    checks: checks.map(({ evidence, fromRecord, ...rest }) => ({ ...rest, ...(fromRecord === true ? { source: 'qualification-record' } : {}) })),
    evidence: Object.fromEntries(checks.filter((check) => check.evidence !== undefined).map((check) => [check.id, check.evidence])),
    fingerprint,
    fingerprintDigest: fingerprintDigest(fingerprint),
    record: recordAssessment ?? null,
  };
}

/** The durable qualification record: operational evidence, bound to the fingerprint, with an expiry. Unsigned. */
export function buildQualificationRecord(report, { validityDays = DEFAULT_RECORD_VALIDITY_DAYS, recordedBy } = {}) {
  const days = Math.min(Math.max(1, validityDays), MAX_RECORD_VALIDITY_DAYS);
  const recordedAt = report.evaluatedAt;
  return {
    schema: RECORD_FORMAT,
    recordedAt,
    validUntil: new Date(Date.parse(recordedAt) + days * 86_400_000).toISOString(),
    ...(recordedBy !== undefined ? { recordedBy } : {}),
    result: report.result,
    levels: report.levels,
    organizationId: report.organizationId,
    release: report.release,
    fingerprint: report.fingerprint,
    fingerprintDigest: report.fingerprintDigest,
    checks: report.checks.map((check) => ({ id: check.id, status: check.status, ...(check.reason !== undefined ? { reason: check.reason } : {}) })),
    evidence: report.evidence,
    authenticity: 'unsigned operational evidence, protected only by the deployment\'s filesystem and access control; not authority and not a signature',
  };
}

/** Value-free report lines. */
export function formatReport(report) {
  const lines = [`Frontera pilot readiness (${READINESS_FORMAT})`];
  if (report.release !== null) lines.push(`release: ${report.release.release} build=${report.release.build}`);
  if (report.organizationId !== null) lines.push(`organization: ${report.organizationId}`);
  for (const level of LEVELS) {
    lines.push(`-- ${level} level: ${report.levels[level]}`);
    for (const check of report.checks.filter((entry) => entry.level === level)) {
      const status = check.status === 'not-applicable' ? 'N/A ' : check.status.toUpperCase().padEnd(4);
      lines.push(`${status} ${check.id} ${check.name.padEnd(21)} ${check.reason !== undefined ? `[${check.reason}] ` : ''}${check.detail ?? ''}${check.status === 'fail' ? ` -> ${check.remediation}` : ''}`);
    }
  }
  if (report.record !== null) lines.push(`qualification record: ${report.record.status}${report.record.changed !== undefined ? ` (changed: ${report.record.changed.join(', ')})` : ''}`);
  lines.push(`RESULT: ${report.result.toUpperCase()}`);
  return lines;
}

/** The time of the last `restore:v1` into this deployment's state directory, if its report is visible there. */
export function lastRestoreFinishedAt(env) {
  const store = env.AOC_ENTERPRISE_SQLITE_PATH;
  if (typeof store !== 'string' || store.length === 0) return undefined;
  const report = join(dirname(resolve(store)), 'restore-report.json');
  if (!existsSync(report) || !statSync(report).isFile()) return undefined;
  const value = readJsonFile(report)?.value;
  return typeof value?.finishedAt === 'string' ? value.finishedAt : 'unreadable';
}

/** SHA-256 of the governed-action file this deployment runs with, or undefined when it is not readable here. */
export function governedActionsFileDigest(env) {
  const file = env.AOC_ENTERPRISE_GOVERNED_ACTIONS_FILE;
  if (typeof file !== 'string' || file.length === 0) return undefined;
  try {
    return sha256(readFileSync(file));
  } catch {
    return undefined;
  }
}
