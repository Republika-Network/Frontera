// PROD-03 — the pilot readiness gate, against a stub Host.
//
// The clean-room drills prove the gate on real deployments. What needs a
// condition a real Host cannot be made to produce on demand is proved here:
// every check's failure class, fail-closed on anything unreadable, the
// cumulative levels, the record's binding and expiry, the evidence verifiers'
// refusals, and — structurally and on the wire — that the gate only reads.
import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CHECKS, assessRecord, buildQualificationRecord, evaluatePilotReadiness, fingerprintDigest } from '../../scripts/pilot/lib-pilot-readiness.mjs';
import { copyBackup, createRealBackup, forgeBackup, reboundBackup } from './support/real-backup.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const COMMIT = 'a'.repeat(40);
const ORG = 'org-pilot';
const READ_SECRET = 'observer-credential-0123456789abcdef-READ';
const ADMIN_SECRET = 'administrator-credential-0123456789abcdef-ADMIN';
const NOW = new Date('2026-10-13T12:00:00.000Z');

function healthyHost() {
  return {
    '/version': { schema: 'frontera.release-identity.v1', version: '1.6.0', release: `1.6.0+${COMMIT.slice(0, 12)}`, commit: COMMIT, build: 'release' },
    '/live': { live: true, lifecycleState: 'ready' },
    '/ready': { ready: true, lifecycleState: 'ready', status: 'healthy' },
    '/health': {
      status: 'healthy',
      persistence: { connected: true },
      configurationChecksum: 'sha256:config-1',
      posture: { environment: 'production', persistence: 'durable', authentication: 'required', governedActions: 'composed', authorityStore: 'authenticated-durable', kernelAuthority: 'composed', emergencyControl: 'composed', exerciseControls: 'composed', authorityFreshness: 'external', evidenceStore: 'durable', obligations: 'not-configured', approvals: 'durable' },
      modules: { 'aoc.kernel': { required: true, health: { status: 'healthy' } }, 'aoc.enterprise.telemetry': { required: false, health: { status: 'healthy' } } },
      authoritySigner: { custody: 'software', keyId: 'key-1', algorithm: 'ed25519-v1', state: 'ready' },
      authorityFreshness: { mode: 'external', witnessId: 'witness-1', witness: { state: 'ready' }, stores: [{ stateKind: 'revocation-state', status: 'ready', sequence: 3 }] },
    },
    '/api/admin/organization': { organization: { organizationId: ORG, trustDomainId: 'td-pilot', agentCredentials: 'enabled', profileLifecycle: 'operator-promoted' }, operator: { operatorId: 'ops-observer', role: 'observer', credentialClass: 'operator', permissions: ['organization.read', 'inventory.read'] } },
    'admin:/api/admin/organization': { organization: { organizationId: ORG, trustDomainId: 'td-pilot' }, operator: { operatorId: 'ops-admin', role: 'organization-administrator', credentialClass: 'operator', permissions: ['organization.read', 'authority.revoke', 'agent-credential.revoke', 'emergency.stop', 'emergency.release'] } },
    '/api/admin/authority/entities?kind=root-issuer&status=active': { entities: [{ entityId: 'actor-org', status: 'active' }] },
    '/api/admin/authority/entities?kind=trust-domain&status=active': { entities: [{ entityId: 'td-pilot', status: 'active' }] },
    '/api/admin/emergency-controls': { active: [] },
    '/api/admin/operations/health': { status: 'healthy', operations: { unresolvedExecutions: 0, attentionRequired: false } },
    '/api/admin/governance-profiles': { lifecycle: 'operator-promoted', profiles: [{ profileId: 'deploy-staging', version: 1, digest: 'sha256:p1', state: 'active' }] },
    '/api/admin/approvals?view=pending': { view: 'pending', approvals: [] },
    '/api/admin/activity/decisions?limit=1': { decisions: [] },
    '/api/admin/operations/metrics': { decisions: 0 },
    '/api/admin/agents': { agents: [{ actorId: 'agent-1', status: 'active', onboarding: { actor: 'active', credential: 'active', standingAuthority: 'assigned' }, authority: { delegationGrants: [{ entityId: 'delegation-1', status: 'active' }], authorityGrants: [] } }] },
    '/api/admin/authority/entities/delegation-grant/delegation-1': { terms: { sourceAuthorityGrantId: 'grant-1', parameterBounds: [{ dimension: 'replicaCount', kind: 'maximum', type: 'integer', limit: 3 }] } },
    '/api/admin/authority/entities/authority-grant/grant-1': { terms: { constraints: [] } },
  };
}

/** A reader over a response map: `path` → body (200), or `{ __status, ...body }`. Records every call. */
function stubReader(responses, calls = []) {
  return async (path, { authorization = READ_SECRET, anonymous } = {}) => {
    calls.push({ path, anonymous: anonymous === true, authorization });
    if (path.startsWith('/api/admin/') && authorization !== READ_SECRET && authorization !== ADMIN_SECRET) return { status: 401, body: { error: { code: 'AUTHENTICATION_FAILED' } } };
    const keyed = authorization === ADMIN_SECRET ? responses[`admin:${path}`] : undefined;
    const value = keyed ?? responses[path];
    if (value === undefined) return { status: 404, body: { error: { code: 'NOT_FOUND' } } };
    if (value === 'UNREACHABLE') return { status: 0, error: 'HOST_UNREACHABLE' };
    const { __status, ...body } = value;
    return { status: __status ?? 200, body };
  };
}

const scratch = mkdtempSync(join(tmpdir(), 'frontera-prod03-gate-'));
process.on('exit', () => rmSync(scratch, { recursive: true, force: true }));

/** A real backup:v1 set of the PROD-02 fixture deployment (tests/pilot/fixtures/real-backup.mjs), and its store requirements. */
let real;
/** The real backup, re-bound to this stub deployment (organization, release, a creation time before NOW): complete and consistent. */
let good;

/** The preflight's answer in the Host's environment: every check passes, and PROD-02's canonical store requirements. */
const PREFLIGHT_OK = async () => ({ ok: true, checks: ['release-identity', 'placeholders', 'configuration', 'storage'].map((id) => ({ id, status: 'pass', detail: 'ok' })), deploymentRequirements: real.requirements });

/** A consistent forgery of the good backup (manifest and checksums rewritten to agree with `edit`). */
const backupSet = (name, edit) => forgeBackup(good, join(scratch, name, 'frontera-backup'), edit);

function restoreReport(name, overrides = {}) {
  const path = join(scratch, `${name}-restore-report.json`);
  writeFileSync(path, JSON.stringify({ backupId: 'backup-good', status: 'restored', coverage: { complete: true }, checksumResult: 'ok', sqliteIntegrityResult: 'ok', finishedAt: '2026-10-13T10:30:00.000Z', ...overrides }));
  return path;
}

function acknowledgement(name, overrides = {}) {
  const path = join(scratch, `${name}-ack.json`);
  writeFileSync(path, JSON.stringify({ schema: 'frontera.pilot-acknowledgement.v1', organizationId: ORG, release: { commit: COMMIT }, documents: ['shared-responsibility', 'security-posture', 'known-limits'], acknowledgedBy: [{ name: 'Pilot owner', role: 'pilot-owner', acknowledgedAt: '2026-10-13T11:00:00.000Z' }], ...overrides }));
  return path;
}

let GOOD;
before(async () => {
  real = await createRealBackup(join(scratch, 'real'));
  good = reboundBackup(real.dir, join(scratch, 'good', 'frontera-backup'), { organizationId: ORG, commit: COMMIT, backupId: 'backup-good', createdAt: '2026-10-13T10:00:00.000Z' });
  GOOD = { backupPath: good, restoreReportPath: restoreReport('good'), acknowledgementPath: acknowledgement('good') };
});

async function gate(responses = healthyHost(), options = {}) {
  const calls = [];
  const report = await evaluatePilotReadiness({ reader: stubReader(responses, calls), credential: READ_SECRET, operatorCredentials: [ADMIN_SECRET], preflight: PREFLIGHT_OK, now: NOW, ...GOOD, ...options });
  return { report, calls, check: (id) => report.checks.find((entry) => entry.id === id) };
}

function mutate(change) {
  const host = healthyHost();
  change(host);
  return host;
}

describe('PROD-03 readiness gate — the checklist', () => {
  it('is the closed PR-01 … PR-20 list, each with a level and a remediation reference', () => {
    assert.deepEqual(CHECKS.map((check) => check.id), Array.from({ length: 20 }, (_, index) => `PR-${String(index + 1).padStart(2, '0')}`));
    for (const check of CHECKS) {
      assert.ok(['deployment', 'organization', 'pilot'].includes(check.level));
      assert.match(check.remediation, /^docs\//);
    }
  });

  it('a healthy, onboarded, evidenced deployment is pilot-ready; every check passes or is not applicable', async () => {
    const { report } = await gate();
    assert.equal(report.result, 'pilot-ready', JSON.stringify(report.checks.filter((check) => check.status === 'fail')));
    assert.deepEqual(report.levels, { deployment: 'ready', organization: 'ready', pilot: 'ready' });
    assert.ok(report.checks.every((check) => check.status === 'pass' || check.status === 'not-applicable'));
  });

  it('levels are cumulative: an organization failure caps the result even when every pilot check passes', async () => {
    const { report } = await gate(mutate((host) => (host['/api/admin/governance-profiles'].profiles[0].state = 'retired')));
    assert.equal(report.result, 'deployment-ready');
    assert.equal(report.levels.pilot, 'not-ready');
  });
});

describe('PROD-03 readiness gate — every required dependency fails closed (M-PILOT-1, -2, -5, -6, -7, -11)', () => {
  const cases = [
    ['PR-04 witness unavailable (M-PILOT-1)', (host) => { host['/health'].authorityFreshness.witness = { state: 'unavailable', reason: 'AUTHORITY_FRESHNESS_UNAVAILABLE' }; host['/health'].status = 'degraded'; }, 'PR-04', 'WITNESS_UNAVAILABLE', 'not-ready'],
    ['PR-04 witness not composed', (host) => { delete host['/health'].authorityFreshness; }, 'PR-04', 'WITNESS_NOT_COMPOSED', 'not-ready'],
    ['PR-05 signer unavailable (M-PILOT-2)', (host) => { host['/health'].authoritySigner.state = 'unavailable'; host['/health'].status = 'degraded'; }, 'PR-05', 'SIGNER_UNAVAILABLE', 'not-ready'],
    ['PR-05 signer not composed', (host) => { delete host['/health'].authoritySigner; }, 'PR-05', 'SIGNER_NOT_COMPOSED', 'not-ready'],
    ['PR-13 global emergency stop (M-PILOT-5)', (host) => { host['/api/admin/emergency-controls'].active = [{ scope: 'global' }]; }, 'PR-13', 'EMERGENCY_STOP_ACTIVE', 'not-ready'],
    ['PR-13 organization stop', (host) => { host['/api/admin/emergency-controls'].active = [{ scope: 'organization', value: ORG }]; }, 'PR-13', 'EMERGENCY_STOP_ACTIVE', 'not-ready'],
    ['PR-11 revoked-only authority (M-PILOT-6)', (host) => { host['/api/admin/agents'].agents[0].authority.delegationGrants[0].status = 'revoked'; }, 'PR-11', 'NO_STANDING_AUTHORITY', 'organization-ready'],
    ['PR-11 an unbounded lineage', (host) => { host['/api/admin/authority/entities/delegation-grant/delegation-1'].terms.parameterBounds = []; }, 'PR-11', 'AUTHORITY_UNBOUNDED', 'organization-ready'],
    ['PR-10 no agent', (host) => { host['/api/admin/agents'].agents = []; }, 'PR-10', 'NO_PILOT_AGENT', 'organization-ready'],
    ['PR-04/PR-20 a store regressed (M-PILOT-7: stale restore)', (host) => { host['/health'].authorityFreshness.stores[0].status = 'regressed'; host['/health'].status = 'unhealthy'; }, 'PR-20', 'FRESHNESS_REGRESSED', 'not-ready'],
    ['PR-02 authentication disabled (M-PILOT-11)', (host) => { host['/health'].posture.authentication = 'disabled'; }, 'PR-02', 'POSTURE_NOT_SECURE', 'not-ready'],
    ['PR-02 development profile', (host) => { host['/health'].posture.environment = 'development'; }, 'PR-02', 'POSTURE_NOT_SECURE_PROFILE', 'not-ready'],
    ['PR-01 development build', (host) => { host['/version'].build = 'development'; host['/version'].commit = 'unknown'; }, 'PR-01', 'RELEASE_NOT_IDENTIFIED', 'not-ready'],
    ['PR-06 live but not ready (PILOT-22)', (host) => { host['/ready'] = { __status: 503, ready: false, lifecycleState: 'ready' }; }, 'PR-06', 'HOST_NOT_READY', 'not-ready'],
    ['PR-06 unhealthy', (host) => { host['/health'].status = 'unhealthy'; host['/health'].__status = 503; }, 'PR-06', 'HEALTH_UNHEALTHY', 'not-ready'],
    ['PR-20 a required module unhealthy', (host) => { host['/health'].modules['aoc.kernel'].health.status = 'unhealthy'; host['/health'].status = 'unhealthy'; }, 'PR-20', 'REQUIRED_MODULE_UNHEALTHY', 'not-ready'],
    ['PR-20 persistence disconnected', (host) => { host['/health'].persistence.connected = false; }, 'PR-20', 'PERSISTENCE_DISCONNECTED', 'not-ready'],
    ['PR-07 not bootstrapped', (host) => { host['/api/admin/authority/entities?kind=root-issuer&status=active'].entities = []; }, 'PR-07', 'ORGANIZATION_NOT_BOOTSTRAPPED', 'deployment-ready'],
    ['PR-12 approval inbox unreadable', (host) => { host['/api/admin/approvals?view=pending'] = { __status: 503 }; }, 'PR-12', 'APPROVAL_INBOX_UNREADABLE', 'deployment-ready'],
    ['PR-17 diagnostics unreadable', (host) => { delete host['/api/admin/operations/health']; }, 'PR-17', 'DIAGNOSTICS_UNREADABLE', 'not-ready'],
  ];
  for (const [name, change, id, reason, result] of cases) {
    it(name, async () => {
      const { report, check } = await gate(mutate(change));
      assert.equal(check(id).status, 'fail', JSON.stringify(check(id)));
      assert.equal(check(id).reason, reason);
      assert.equal(report.result, result);
    });
  }

  it('an unreachable Host is not ready at every level, never "unknown but okay"', async () => {
    const unreachable = Object.fromEntries(Object.keys(healthyHost()).map((path) => [path, 'UNREACHABLE']));
    const { report } = await gate(unreachable);
    assert.equal(report.result, 'not-ready');
    // PR-03 is the local preflight's storage verdict, evaluable without the Host; every other deployment check fails.
    for (const check of report.checks.filter((entry) => entry.level === 'deployment' && entry.id !== 'PR-03')) assert.equal(check.status, 'fail', check.id);
  });

  it('malformed answers fail: a /health that is not the Host\'s report', async () => {
    const { report } = await gate(mutate((host) => (host['/health'] = { hello: 'world' })));
    assert.equal(report.result, 'not-ready');
  });

  it('without the preflight, configuration and storage are not evaluated — and therefore fail (PREFLIGHT_NOT_EVALUATED)', async () => {
    const { check, report } = await gate(healthyHost(), { preflight: undefined });
    assert.equal(check('PR-02').reason, 'PREFLIGHT_NOT_EVALUATED');
    assert.equal(check('PR-03').reason, 'PREFLIGHT_NOT_EVALUATED');
    assert.equal(report.result, 'not-ready');
  });

  it('a failing preflight is reported with its own closed code', async () => {
    const { check } = await gate(healthyHost(), { preflight: async () => ({ ok: false, checks: [{ id: 'release-identity', status: 'pass' }, { id: 'placeholders', status: 'pass' }, { id: 'configuration', status: 'pass' }, { id: 'storage', status: 'fail', code: 'STORAGE_NOT_WRITABLE' }] }) });
    assert.equal(check('PR-03').reason, 'STORAGE_NOT_WRITABLE');
  });

  it('degraded by an optional module: not ready unless that module is explicitly accepted; never a required one', async () => {
    const degraded = mutate((host) => {
      host['/health'].status = 'degraded';
      host['/health'].modules['aoc.enterprise.telemetry'].health.status = 'degraded';
    });
    assert.equal((await gate(degraded)).check('PR-06').reason, 'HEALTH_DEGRADED');
    assert.equal((await gate(degraded, { acceptDegradedModules: ['aoc.enterprise.telemetry'] })).check('PR-06').status, 'pass');
  });

  it('a narrower stop (actor, resource, adapter) is reported but does not block the deployment', async () => {
    const { check } = await gate(mutate((host) => (host['/api/admin/emergency-controls'].active = [{ scope: 'actor', value: 'agent-1' }])));
    assert.equal(check('PR-13').status, 'pass');
  });

  it('approvals not configured are not applicable — unless the pilot requires them', async () => {
    const host = mutate((h) => (h['/health'].posture.approvals = 'not-configured'));
    assert.equal((await gate(host)).check('PR-12').status, 'not-applicable');
    assert.equal((await gate(host, { requireApprovals: true })).check('PR-12').reason, 'APPROVALS_NOT_CONFIGURED');
  });

  it('PR-08 needs a verified organization administrator; PR-19 needs revocation and stop permissions', async () => {
    const { check } = await gate(healthyHost(), { operatorCredentials: [] });
    assert.equal(check('PR-08').reason, 'ADMINISTRATOR_NOT_VERIFIED');
    assert.equal(check('PR-19').reason, 'REVOCATION_PATH_NOT_OPERABLE');
    const wrong = await gate(healthyHost(), { operatorCredentials: ['not-a-valid-credential-0000000000000'] });
    assert.equal(wrong.check('PR-08').reason, 'OPERATOR_CREDENTIAL_INVALID');
  });
});

describe('PROD-03 readiness gate — evidence of the historical drills', () => {
  const verify = async (options) => (await gate(healthyHost(), options)).check;
  // The canonical-coverage and artifact cases (P1-3) are in prod03-independent-review-hardening.test.mjs.
  const backupCases = [
    ['checksum mismatch', () => { const dir = copyBackup(good, join(scratch, 'tampered', 'frontera-backup')); writeFileSync(join(dir, 'stores', 'kernel-authority.sqlite'), 'changed'); return dir; }, 'BACKUP_CHECKSUM_MISMATCH'],
    ['recorded as incomplete', () => backupSet('incomplete', (dir, manifest) => (manifest.coverage.complete = false)), 'BACKUP_INCOMPLETE'],
    ['another organization', () => backupSet('foreign', (dir, manifest) => (manifest.coverage.deployment.organizationId = 'org-other')), 'BACKUP_OTHER_ORGANIZATION'],
    ['live, not cold', () => backupSet('live', (dir, manifest) => (manifest.consistency.mode = 'live-per-file')), 'BACKUP_NOT_COLD'],
    ['a secret flag set (M-PILOT-8)', () => backupSet('flagged', (dir, manifest) => (manifest.configuration.secretValuesIncluded = true)), 'BACKUP_SECRET_FLAG_SET'],
    ['a held credential inside a file (M-PILOT-8)', () => backupSet('leaky', (dir) => writeFileSync(join(dir, 'metadata', 'verification-summary.json'), `rows ... ${ADMIN_SECRET} ...`)), 'BACKUP_CONTAINS_CREDENTIAL'],
    ['another release', () => backupSet('old-release', (dir, manifest) => (manifest.source.commit = 'b'.repeat(40))), 'BACKUP_RELEASE_MISMATCH'],
    ['stale', () => backupSet('stale', (dir, manifest) => (manifest.createdAt = '2026-09-01T00:00:00.000Z')), 'BACKUP_STALE'],
  ];
  for (const [name, make, reason] of backupCases) {
    it(`a backup refused: ${name}`, async () => {
      const check = await verify({ backupPath: make() });
      assert.equal(check('PR-15').reason, reason);
      assert.equal(check('PR-16').reason, 'RESTORE_BACKUP_NOT_EVIDENCED', 'a restore drill is bound to a verified backup');
    });
  }

  it('a restore drill of another backup, an incomplete one, or one not finished, is refused', async () => {
    assert.equal((await verify({ restoreReportPath: restoreReport('other', { backupId: 'backup-other' }) }))('PR-16').reason, 'RESTORE_OF_ANOTHER_BACKUP');
    assert.equal((await verify({ restoreReportPath: restoreReport('partial', { coverage: { complete: false } }) }))('PR-16').reason, 'RESTORE_INCOMPLETE');
    assert.equal((await verify({ restoreReportPath: restoreReport('failed', { status: 'failed' }) }))('PR-16').reason, 'RESTORE_NOT_COMPLETED');
  });

  it('an acknowledgement for another release or organization, missing a document, or signed by nobody, is refused', async () => {
    assert.equal((await verify({ acknowledgementPath: acknowledgement('stale', { release: { commit: 'b'.repeat(40) } }) }))('PR-18').reason, 'ACKNOWLEDGEMENT_STALE');
    assert.equal((await verify({ acknowledgementPath: acknowledgement('foreign', { organizationId: 'org-other' }) }))('PR-18').reason, 'ACKNOWLEDGEMENT_OTHER_ORGANIZATION');
    assert.equal((await verify({ acknowledgementPath: acknowledgement('partial', { documents: ['shared-responsibility'] }) }))('PR-18').reason, 'ACKNOWLEDGEMENT_INCOMPLETE');
    assert.equal((await verify({ acknowledgementPath: acknowledgement('nobody', { acknowledgedBy: [] }) }))('PR-18').reason, 'ACKNOWLEDGEMENT_UNSIGNED');
  });

  it('without evidence or a record, the historical checks fail (a configuration flag cannot satisfy them)', async () => {
    const check = await verify({ backupPath: undefined, restoreReportPath: undefined, acknowledgementPath: undefined });
    assert.equal(check('PR-15').reason, 'BACKUP_NOT_EVIDENCED');
    assert.equal(check('PR-16').reason, 'RESTORE_DRILL_NOT_EVIDENCED');
    assert.equal(check('PR-18').reason, 'ACKNOWLEDGEMENT_NOT_EVIDENCED');
  });
});

describe('PROD-03 readiness gate — the qualification record: bound, expiring, never authority', () => {
  async function recorded() {
    const { report } = await gate();
    return buildQualificationRecord(report, { validityDays: 30 });
  }

  it('a record of a pilot-ready evaluation satisfies the historical checks while nothing material changed', async () => {
    const record = await recorded();
    assert.equal(record.schema, 'frontera.pilot-qualification-record.v1');
    assert.match(record.authenticity, /unsigned operational evidence/);
    const { report, check } = await gate(healthyHost(), { backupPath: undefined, restoreReportPath: undefined, acknowledgementPath: undefined, record });
    assert.equal(report.record.status, 'valid');
    assert.equal(check('PR-16').source, 'qualification-record');
    assert.equal(report.result, 'pilot-ready');
  });

  const material = [
    ['a software version change', (host) => { host['/version'].commit = 'c'.repeat(40); host['/version'].release = `1.6.0+${'c'.repeat(12)}`; }, 'release'],
    ['a configuration change', (host) => (host['/health'].configurationChecksum = 'sha256:config-2'), 'configurationChecksum'],
    ['a signer key change', (host) => (host['/health'].authoritySigner.keyId = 'key-2'), 'signer'],
    ['a signer custody change', (host) => (host['/health'].authoritySigner.custody = 'external'), 'signer'],
    ['a witness identity change', (host) => (host['/health'].authorityFreshness.witnessId = 'witness-2'), 'witnessId'],
    ['a profile replacement', (host) => (host['/api/admin/governance-profiles'].profiles[0].digest = 'sha256:p2'), 'activeProfiles'],
    ['a posture change', (host) => (host['/health'].posture.approvals = 'not-configured'), 'posture'],
  ];
  for (const [name, change, field] of material) {
    it(`is invalidated by ${name}`, async () => {
      const record = await recorded();
      const { report, check } = await gate(mutate(change), { backupPath: undefined, restoreReportPath: undefined, acknowledgementPath: undefined, record });
      assert.equal(report.record.status, 'invalidated');
      assert.ok(report.record.changed.includes(field), report.record.changed.join(','));
      assert.equal(check('PR-15').reason, 'RECORD_INVALIDATED');
    });
  }

  it('is invalidated by a restore and by a governed-action file change (seen with the preflight environment)', async () => {
    const record = await recorded();
    const restored = assessRecord(record, { fingerprint: { ...record.fingerprint, lastRestore: '2026-10-13T11:59:00.000Z' }, now: NOW });
    assert.deepEqual(restored, { status: 'invalidated', changed: ['lastRestore'] });
    const edited = assessRecord(record, { fingerprint: { ...record.fingerprint, governedActionsFile: 'sha256:edited' }, now: NOW });
    assert.deepEqual(edited, { status: 'invalidated', changed: ['governedActionsFile'] });
  });

  it('expires; a tampered record is malformed; neither satisfies anything', async () => {
    const record = await recorded();
    assert.equal(assessRecord(record, { fingerprint: record.fingerprint, now: new Date(Date.parse(record.validUntil) + 1) }).status, 'expired');
    const tampered = { ...record, fingerprint: { ...record.fingerprint, witnessId: 'forged' } };
    assert.equal(assessRecord(tampered, { fingerprint: record.fingerprint, now: NOW }).status, 'malformed');
    assert.equal(record.fingerprintDigest, fingerprintDigest(record.fingerprint));
  });

  it('never satisfies a live check: a record with every check passed cannot make a witness outage ready', async () => {
    const record = await recorded();
    const outage = mutate((host) => {
      host['/health'].authorityFreshness.witness = { state: 'unavailable' };
      host['/health'].status = 'degraded';
    });
    const { report, check } = await gate(outage, { record });
    assert.equal(check('PR-04').reason, 'WITNESS_UNAVAILABLE');
    assert.equal(report.result, 'not-ready');
  });

  it('validity is bounded: at most 90 days whatever is asked', async () => {
    const { report } = await gate();
    const record = buildQualificationRecord(report, { validityDays: 3650 });
    assert.equal(Date.parse(record.validUntil) - Date.parse(record.recordedAt), 90 * 86_400_000);
  });
});

describe('PROD-03 readiness gate — read-only, value-free (M-PILOT-3, M-PILOT-9)', () => {
  it('the evaluation only reads: every request it makes is through the GET reader; probes are anonymous', async () => {
    const { calls } = await gate();
    for (const call of calls.filter((entry) => ['/version', '/live', '/ready', '/health'].includes(entry.path))) assert.equal(call.anonymous, true, call.path);
  });

  it('structurally: one HTTP method (GET), no store, driver, Host internals or mutation route; credentials never formatted into output', () => {
    const lib = readFileSync(join(ROOT, 'scripts/pilot/lib-pilot-readiness.mjs'), 'utf8');
    const cli = readFileSync(join(ROOT, 'scripts/pilot/pilot-readiness.mjs'), 'utf8');
    assert.equal((lib.match(/method: 'GET'/g) ?? []).length, 1);
    for (const source of [lib, cli]) {
      assert.equal(/method:\s*'(POST|PUT|PATCH|DELETE)'/.test(source), false);
      assert.equal(/better-sqlite3|node:sqlite|new Database\(|dist\/src|\/revoke|\/activate|\/release|\/approve|\/resolution|\/credentials/.test(source.replace(/\/\/.*$/gm, '')), false);
    }
    const imports = [...lib.matchAll(/from '([^']+)'/g)].map((match) => match[1]).sort();
    assert.deepEqual(imports, ['../portability/store-registry.mjs', 'node:crypto', 'node:fs', 'node:path']);
    // From PROD-02's registry, only its pure manifest validators — never the module loader that imports built stores.
    assert.match(lib, /import \{ BackupManifestError, assessBackupCoverage, validateManifestStoreEntries \} from '\.\.\/portability\/store-registry\.mjs';/);
    assert.equal(/loadRegistryModules/.test(lib), false);
    const registry = readFileSync(join(ROOT, 'scripts/portability/store-registry.mjs'), 'utf8');
    assert.deepEqual([...registry.matchAll(/^import .* from '([^']+)';$/gm)].map((match) => match[1]).sort(), ['node:crypto', 'node:fs', 'node:path'], 'the registry module is pure at import time');
    const cliImports = [...cli.matchAll(/from '([^']+)'/g)].map((match) => match[1]).sort();
    assert.deepEqual(cliImports, ['../deploy/host-preflight.mjs', './lib-pilot-readiness.mjs', 'node:fs']);
  });

  it('the CLI against a live stub Host: GET only on the wire, exit 0 / 1 / 2, and no credential in any output', async () => {
    const methods = [];
    const responses = healthyHost();
    const server = createServer((req, res) => {
      methods.push(req.method);
      const admin = req.headers.authorization === `Bearer ${ADMIN_SECRET}`;
      const value = (admin ? responses[`admin:${req.url}`] : undefined) ?? responses[req.url];
      const { __status, ...body } = value ?? { __status: 404 };
      res.writeHead(__status ?? 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    });
    await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    const url = `http://127.0.0.1:${server.address().port}`;
    // Async: the stub Host lives in this process, so a synchronous child would block it.
    const run = (args, env = {}) =>
      new Promise((resolveRun) => {
        execFile(process.execPath, [join(ROOT, 'scripts/pilot/pilot-readiness.mjs'), ...args], { env: { PATH: process.env.PATH, PILOT_READ: READ_SECRET, PILOT_ADMIN: ADMIN_SECRET, ...env }, encoding: 'utf8' }, (error, stdout, stderr) => {
          resolveRun({ status: error === null ? 0 : error.code, out: `${stdout}${stderr}` });
        });
      });
    try {
      const base = ['--host', url, '--credential-env', 'PILOT_READ', '--operator-env', 'PILOT_ADMIN'];
      // No preflight here: PR-02/03 cannot be evaluated → deployment not ready → exit 1 for any level.
      const human = await run([...base, '--require', 'deployment']);
      assert.equal(human.status, 1, human.out);
      assert.match(human.out, /\[PREFLIGHT_NOT_EVALUATED\]/, human.out);
      assert.match(human.out, /RESULT: NOT-READY/);
      const json = await run([...base, '--json', '--diagnose']);
      assert.equal(json.status, 1);
      assert.equal(JSON.parse(json.out).schema, 'frontera.pilot-readiness.v1');
      assert.equal((await run([...base, '--require', 'everything'])).status, 2);
      assert.equal((await run(['--host', url, '--credential-env', 'UNSET_VARIABLE_NAME'])).status, 2);
      for (const output of [human.out, json.out]) {
        assert.equal(output.includes(READ_SECRET), false);
        assert.equal(output.includes(ADMIN_SECRET), false);
      }
      assert.ok(methods.length > 10, String(methods.length));
      assert.deepEqual([...new Set(methods)], ['GET'], 'the gate sent nothing but GET');
    } finally {
      await new Promise((resolveClose) => server.close(resolveClose));
    }
  });
});
