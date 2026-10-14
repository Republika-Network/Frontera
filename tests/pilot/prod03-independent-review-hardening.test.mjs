// PROD-03 independent-review hardening — the readiness gate's three P1/P2
// findings, each reproduced as a case the gate used to pass:
//
//   P1-1  PR-10 and PR-11 satisfied by two different agents (A1 … A7)
//   P1-3  PR-15 trusting `coverage.complete` instead of PROD-02's registry (B1 … B12)
//   P2-3  PR-18 accepting an acknowledgement by any role (E1 … E8)
//
// The backup cases start from a REAL `backup:v1` set (the PROD-02 fixture
// deployment, the real backup command) and forge it the way an attacker who
// can write the backup directory would: consistently, checksums rewritten.
// Requires `npm run build` (run through `npm test`, which builds first).
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { requiredStoreDefinitions } from '../../scripts/portability/store-registry.mjs';
import { evaluatePilotReadiness } from '../../scripts/pilot/lib-pilot-readiness.mjs';
import { copyBackup, createRealBackup, fixtureEnv, forgeBackup, requirementsOf } from './support/real-backup.mjs';

const COMMIT = 'c'.repeat(40);
const READ_SECRET = 'observer-credential-0123456789abcdef-READ';
const ADMIN_SECRET = 'administrator-credential-0123456789abcdef-ADMIN';

const root = mkdtempSync(join(tmpdir(), 'frontera-prod03-hardening-'));
after(() => rmSync(root, { recursive: true, force: true }));

// -- a stub Host (the same shape as prod03-readiness-gate.test.mjs) ------------------------------------

function host(organizationId, commit = COMMIT) {
  return {
    // The backup cases bind PR-15 to whatever commit the fixture backup recorded; PR-01 is not under test here.
    '/version': { schema: 'frontera.release-identity.v1', version: '1.6.0', release: `1.6.0+${String(commit).slice(0, 12)}`, commit, build: 'release' },
    '/live': { live: true, lifecycleState: 'ready' },
    '/ready': { ready: true, lifecycleState: 'ready', status: 'healthy' },
    '/health': {
      status: 'healthy',
      persistence: { connected: true },
      configurationChecksum: 'sha256:config-1',
      posture: { environment: 'production', persistence: 'durable', authentication: 'required', governedActions: 'composed', authorityStore: 'authenticated-durable', kernelAuthority: 'composed', emergencyControl: 'composed', exerciseControls: 'composed', authorityFreshness: 'external', evidenceStore: 'durable', obligations: 'not-configured', approvals: 'durable' },
      modules: { 'aoc.kernel': { required: true, health: { status: 'healthy' } } },
      authoritySigner: { custody: 'software', keyId: 'key-1', algorithm: 'ed25519-v1', state: 'ready' },
      authorityFreshness: { mode: 'external', witnessId: 'witness-1', witness: { state: 'ready' }, stores: [{ stateKind: 'revocation-state', status: 'ready', sequence: 3 }] },
    },
    '/api/admin/organization': { organization: { organizationId, trustDomainId: 'td-pilot' }, operator: { operatorId: 'ops-observer', role: 'observer', credentialClass: 'operator', permissions: ['organization.read'] } },
    'admin:/api/admin/organization': { organization: { organizationId, trustDomainId: 'td-pilot' }, operator: { operatorId: 'ops-admin', role: 'organization-administrator', credentialClass: 'operator', permissions: ['authority.revoke', 'agent-credential.revoke', 'emergency.stop'] } },
    '/api/admin/authority/entities?kind=root-issuer&status=active': { entities: [{ entityId: 'actor-org' }] },
    '/api/admin/authority/entities?kind=trust-domain&status=active': { entities: [{ entityId: 'td-pilot' }] },
    '/api/admin/emergency-controls': { active: [] },
    '/api/admin/operations/health': { operations: { unresolvedExecutions: 0, attentionRequired: false } },
    '/api/admin/governance-profiles': { lifecycle: 'operator-promoted', profiles: [{ profileId: 'deploy-staging', version: 1, digest: 'sha256:p1', state: 'active' }] },
    '/api/admin/approvals?view=pending': { approvals: [] },
    '/api/admin/activity/decisions?limit=1': { decisions: [] },
    '/api/admin/operations/metrics': { decisions: 0 },
    '/api/admin/agents': { agents: [] },
  };
}

function reader(responses) {
  return async (path, { authorization = READ_SECRET } = {}) => {
    const value = (authorization === ADMIN_SECRET ? responses[`admin:${path}`] : undefined) ?? responses[path];
    if (value === undefined) return { status: 404, body: {} };
    return { status: 200, body: value };
  };
}

// -- agents and their authority -----------------------------------------------------------------------

const BOUNDS = [{ dimension: 'replicaCount', kind: 'maximum', type: 'integer', limit: 3 }];

/** `spec`: { id, actor, credential, delegations: [{ id, status, bounded }] }. */
function withAgents(responses, specs) {
  responses['/api/admin/agents'] = {
    agents: specs.map((spec) => ({
      actorId: spec.id,
      status: spec.actor === 'active' ? 'active' : 'revoked',
      onboarding: { actor: spec.actor, credential: spec.credential, standingAuthority: spec.delegations.some((d) => d.status === 'active') ? 'assigned' : 'none' },
      authority: { delegationGrants: spec.delegations.map((d) => ({ entityId: d.id, status: d.status })), authorityGrants: [] },
    })),
  };
  for (const spec of specs) {
    for (const delegation of spec.delegations) {
      responses[`/api/admin/authority/entities/delegation-grant/${delegation.id}`] = { terms: { sourceAuthorityGrantId: `${delegation.id}-source`, parameterBounds: delegation.bounded ? BOUNDS : [] } };
      responses[`/api/admin/authority/entities/authority-grant/${delegation.id}-source`] = { terms: { constraints: [] } };
    }
  }
  return responses;
}

async function agentChecks(specs) {
  const report = await evaluatePilotReadiness({ reader: reader(withAgents(host('org-agents'), specs)), credential: READ_SECRET, operatorCredentials: [ADMIN_SECRET], now: new Date() });
  return { pr10: report.checks.find((check) => check.id === 'PR-10'), pr11: report.checks.find((check) => check.id === 'PR-11') };
}

describe('P1-1 — pilot readiness needs ONE agent that both holds an active credential and bounded standing authority', () => {
  it('A1: one agent, active credential, bounded authority → PR-10 pass, PR-11 pass', async () => {
    const { pr10, pr11 } = await agentChecks([{ id: 'agent-a', actor: 'active', credential: 'active', delegations: [{ id: 'd-a', status: 'active', bounded: true }] }]);
    assert.equal(pr10.status, 'pass');
    assert.equal(pr11.status, 'pass', JSON.stringify(pr11));
  });

  it('A2 (the reproduction): agent A credential-active with no authority + agent B bounded authority with its credential revoked → PR-10 pass, PR-11 FAIL', async () => {
    const { pr10, pr11 } = await agentChecks([
      { id: 'agent-a', actor: 'active', credential: 'active', delegations: [] },
      { id: 'agent-b', actor: 'active', credential: 'revoked', delegations: [{ id: 'd-b', status: 'active', bounded: true }] },
    ]);
    assert.equal(pr10.status, 'pass', 'agent A can authenticate');
    assert.equal(pr11.status, 'fail', 'no single agent can submit an authorized request');
    assert.equal(pr11.reason, 'NO_STANDING_AUTHORITY');
  });

  it('A3: a credential-active agent whose active lineage is unbounded → PR-11 FAIL AUTHORITY_UNBOUNDED', async () => {
    const { pr11 } = await agentChecks([{ id: 'agent-a', actor: 'active', credential: 'active', delegations: [{ id: 'd-a', status: 'active', bounded: false }] }]);
    assert.equal(pr11.reason, 'AUTHORITY_UNBOUNDED');
  });

  it('A4: a credential-active agent with no active standing authority → PR-11 FAIL NO_STANDING_AUTHORITY', async () => {
    const { pr11 } = await agentChecks([{ id: 'agent-a', actor: 'active', credential: 'active', delegations: [{ id: 'd-a', status: 'revoked', bounded: true }] }]);
    assert.equal(pr11.reason, 'NO_STANDING_AUTHORITY');
  });

  it('A5: the authority holder whose credential is revoked does not count (alone → PR-10 and PR-11 both fail)', async () => {
    const { pr10, pr11 } = await agentChecks([{ id: 'agent-b', actor: 'active', credential: 'revoked', delegations: [{ id: 'd-b', status: 'active', bounded: true }] }]);
    assert.equal(pr10.reason, 'NO_PILOT_AGENT');
    assert.equal(pr11.reason, 'NO_STANDING_AUTHORITY');
  });

  it('A6: the authority holder whose actor is revoked does not count, even with an active credential and an active lineage', async () => {
    const { pr10, pr11 } = await agentChecks([
      { id: 'agent-a', actor: 'active', credential: 'active', delegations: [] },
      { id: 'agent-b', actor: 'revoked', credential: 'active', delegations: [{ id: 'd-b', status: 'active', bounded: true }] },
    ]);
    assert.equal(pr10.status, 'pass');
    assert.equal(pr11.reason, 'NO_STANDING_AUTHORITY');
  });

  it('A7: two credential-active agents, one bounded and one unbounded → FAIL AUTHORITY_UNBOUNDED (fail closed: one pilot-capable agent with unbounded standing is enough to refuse)', async () => {
    const { pr11 } = await agentChecks([
      { id: 'agent-a', actor: 'active', credential: 'active', delegations: [{ id: 'd-a', status: 'active', bounded: true }] },
      { id: 'agent-b', actor: 'active', credential: 'active', delegations: [{ id: 'd-b', status: 'active', bounded: false }] },
    ]);
    assert.equal(pr11.reason, 'AUTHORITY_UNBOUNDED');
    assert.match(pr11.detail, /agent-b/);
  });

  it('A7b: an unbounded lineage on an actor-active agent whose credential is revoked still refuses (it is one credential issuance away from acting)', async () => {
    const { pr11 } = await agentChecks([
      { id: 'agent-a', actor: 'active', credential: 'active', delegations: [{ id: 'd-a', status: 'active', bounded: true }] },
      { id: 'agent-b', actor: 'active', credential: 'revoked', delegations: [{ id: 'd-b', status: 'active', bounded: false }] },
    ]);
    assert.equal(pr11.reason, 'AUTHORITY_UNBOUNDED');
  });
});

// -- P1-3: backups -----------------------------------------------------------------------------------------

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

let real;
let manifest;
let liveRequirements;

before(async () => {
  ({ dir: real, manifest, requirements: liveRequirements } = await createRealBackup(root));
});

let copies = 0;
const copyOfReal = () => copyBackup(real, join(root, `copy-${++copies}`));
const forged = (edit) => forgeBackup(real, join(root, `forged-${++copies}`), edit);

const dropStore = (name) => (dir, m) => {
  const entry = m.stores.find((store) => store.name === name);
  m.stores = m.stores.filter((store) => store.name !== name);
  for (const coverage of m.coverage.stores) if (coverage.name === name) Object.assign(coverage, { required: false, included: false, present: false, status: 'not-configured' });
  unlinkSync(join(dir, 'stores', entry.filename));
};

async function pr15(backupPath, { requirements = liveRequirements, organizationId = manifest.coverage.deployment.organizationId, commit = manifest.source.commit, heldSecrets = [] } = {}) {
  const preflight = async () => ({ ok: true, checks: ['release-identity', 'placeholders', 'configuration', 'storage'].map((id) => ({ id, status: 'pass' })), ...(requirements !== null ? { deploymentRequirements: requirements } : {}) });
  const report = await evaluatePilotReadiness({ reader: reader(host(organizationId, commit)), credential: heldSecrets[0] ?? READ_SECRET, operatorCredentials: [ADMIN_SECRET], preflight, backupPath, now: new Date() });
  return report.checks.find((check) => check.id === 'PR-15');
}

describe('P1-3 — PR-15 validates a backup against PROD-02\'s canonical store coverage, never its own claim of completeness', () => {
  it('the fixture is a real, complete backup:v1 set', () => {
    assert.equal(manifest.coverage.complete, true);
    assert.deepEqual(manifest.stores.map((store) => store.name), requiredStoreDefinitions(liveRequirements).map((store) => store.name));
  });

  it('B1: the real complete backup → PASS', async () => {
    const check = await pr15(real);
    assert.equal(check.status, 'pass', JSON.stringify(check));
  });

  it('B2 (the reproduction): coverage.complete=true while a required store is omitted (consistently forged) → FAIL BACKUP_INCOMPLETE', async () => {
    const dir = forged(dropStore('kernel-authority'));
    assert.equal(JSON.parse(readFileSync(join(dir, 'backup-manifest.json'), 'utf8')).coverage.complete, true, 'the forgery still claims completeness');
    const check = await pr15(dir);
    assert.equal(check.status, 'fail');
    assert.equal(check.reason, 'BACKUP_INCOMPLETE');
    assert.match(check.detail, /kernel-authority/);
  });

  it('B2b: … even when the forgery also lies about the source deployment (the live deployment\'s own requirements still require the store)', async () => {
    const dir = forged((d, m) => {
      dropStore('kernel-authority')(d, m);
      m.coverage.deployment.kernelAuthorityEnabled = false;
    });
    const check = await pr15(dir);
    assert.equal(check.reason, 'BACKUP_INCOMPLETE');
    assert.match(check.detail, /kernel-authority/);
  });

  it('B3: coverage.complete=true over a single arbitrary file with a valid checksum (no store inventory) → FAIL', async () => {
    const dir = join(root, 'arbitrary');
    mkdirSync(join(dir, 'stores'), { recursive: true });
    writeFileSync(join(dir, 'stores', 'kernel-authority.sqlite'), 'SQLite format 3\u0000 synthetic');
    writeFileSync(
      join(dir, 'backup-manifest.json'),
      JSON.stringify({ backupFormat: 'aoc.enterprise.backup.v1', backupId: 'backup-arbitrary', createdAt: new Date().toISOString(), source: { commit: manifest.source.commit }, coverage: { complete: true, deployment: { organizationId: manifest.coverage.deployment.organizationId } }, consistency: { mode: 'cold-attested' }, authority: { signer: { privateKeyIncluded: false, signerCredentialIncluded: false }, freshness: { witnessStateIncluded: false, witnessCredentialIncluded: false } }, configuration: { secretValuesIncluded: false } }),
    );
    writeFileSync(join(dir, 'checksums.sha256'), ['backup-manifest.json', 'stores/kernel-authority.sqlite'].map((file) => `${sha(readFileSync(join(dir, file)))}  ${file}`).join('\n') + '\n');
    const check = await pr15(dir);
    assert.equal(check.status, 'fail');
    assert.equal(check.reason, 'BACKUP_MANIFEST_INVALID');
  });

  it('B4: a required store declared in the manifest whose file is absent (and whose checksum line was removed too) → FAIL BACKUP_STORE_FILE_MISSING', async () => {
    const dir = forged((d, m) => unlinkSync(join(d, 'stores', m.stores.find((store) => store.name === 'assurance').filename)));
    const check = await pr15(dir);
    assert.equal(check.reason, 'BACKUP_STORE_FILE_MISSING');
  });

  it('B5: a required store file present but with no checksums.sha256 entry → FAIL BACKUP_CHECKSUM_MISSING', async () => {
    const dir = copyOfReal();
    const lines = readFileSync(join(dir, 'checksums.sha256'), 'utf8').split('\n').filter((line) => !line.endsWith('stores/governance.sqlite'));
    writeFileSync(join(dir, 'checksums.sha256'), lines.join('\n'));
    const check = await pr15(dir);
    assert.equal(check.reason, 'BACKUP_CHECKSUM_MISSING');
  });

  it('B6: a store\'s bytes changed and checksums.sha256 rewritten to match — the manifest\'s own store checksum disagrees → FAIL BACKUP_CHECKSUM_MISMATCH', async () => {
    const dir = forged((d, m) => {
      const file = join(d, 'stores', m.stores.find((store) => store.name === 'agent-passport').filename);
      const bytes = readFileSync(file);
      bytes[bytes.length - 1] ^= 0xff;
      writeFileSync(file, bytes);
    });
    assert.equal((await pr15(dir)).reason, 'BACKUP_CHECKSUM_MISMATCH');
    // And the plain case: bytes changed, nothing rewritten.
    const plain = copyOfReal();
    writeFileSync(join(plain, 'stores', 'governance.sqlite'), 'changed');
    assert.equal((await pr15(plain)).reason, 'BACKUP_CHECKSUM_MISMATCH');
  });

  it('B7: a store this deployment does not require, absent → still PASS (canonical PROD-02 semantics); a file in stores/ the manifest does not declare → FAIL BACKUP_UNEXPECTED_FILE', async () => {
    const notRequired = manifest.coverage.stores.filter((entry) => !entry.required).map((entry) => entry.name);
    assert.ok(notRequired.includes('control-plane') && notRequired.includes('approvals'), 'this deployment composes neither operators nor approvals');
    assert.equal((await pr15(real)).status, 'pass');
    const dir = forged((d) => writeFileSync(join(d, 'stores', 'approvals.sqlite'), 'SQLite format 3\u0000 smuggled'));
    assert.equal((await pr15(dir)).reason, 'BACKUP_UNEXPECTED_FILE');
  });

  it('B8: the required set follows the deployment — the same backup, against a deployment that composes governed actions, operators and approvals → FAIL BACKUP_INCOMPLETE naming those stores', async () => {
    const file = join(root, 'governed-actions.json');
    writeFileSync(file, JSON.stringify({ version: 1, operators: [{ operatorId: 'ops-approver', role: 'approver', apiKeyEnv: 'X' }], governance: { profiles: [{ profileId: 'p', approval: {} }] } }));
    const requirements = requirementsOf(fixtureEnv(join(root, 'pre'), { AOC_ENTERPRISE_GOVERNED_ACTIONS_FILE: file }));
    assert.equal(requirements.approvalsDeclared, true);
    const check = await pr15(real, { requirements });
    assert.equal(check.reason, 'BACKUP_INCOMPLETE');
    for (const name of ['approvals', 'control-plane', 'execution-resolutions', 'bounded-grants']) assert.match(check.detail, new RegExp(name));
  });

  it('B8b: without the deployment\'s own requirements (no --preflight), coverage cannot be judged → FAIL BACKUP_COVERAGE_NOT_VERIFIABLE', async () => {
    assert.equal((await pr15(real, { requirements: null })).reason, 'BACKUP_COVERAGE_NOT_VERIFIABLE');
  });

  it('B9: another organization\'s backup → FAIL BACKUP_OTHER_ORGANIZATION', async () => {
    assert.equal((await pr15(real, { organizationId: 'org-someone-else' })).reason, 'BACKUP_OTHER_ORGANIZATION');
  });

  it('B10: another release → FAIL BACKUP_RELEASE_MISMATCH', async () => {
    const dir = forged((d, m) => (m.source.commit = 'd'.repeat(40)));
    assert.equal((await pr15(dir)).reason, 'BACKUP_RELEASE_MISMATCH');
  });

  it('B11: a secret-inclusion flag set → FAIL BACKUP_SECRET_FLAG_SET', async () => {
    const dir = forged((d, m) => (m.configuration.secretValuesIncluded = true));
    assert.equal((await pr15(dir)).reason, 'BACKUP_SECRET_FLAG_SET');
  });

  it('B12: a held credential\'s bytes inside a backup file (checksums rewritten to agree) → FAIL BACKUP_CONTAINS_CREDENTIAL', async () => {
    const dir = forged((d) => writeFileSync(join(d, 'metadata', 'verification-summary.json'), JSON.stringify({ note: ADMIN_SECRET })));
    assert.equal((await pr15(dir, { heldSecrets: [READ_SECRET, ADMIN_SECRET] })).reason, 'BACKUP_CONTAINS_CREDENTIAL');
  });

  it('cold-attested and age are still required', async () => {
    assert.equal((await pr15(forged((d, m) => (m.consistency.mode = 'live-per-file')))).reason, 'BACKUP_NOT_COLD');
    assert.equal((await pr15(forged((d, m) => (m.createdAt = '2020-01-01T00:00:00.000Z')))).reason, 'BACKUP_STALE');
  });
});

// -- P2-3: acknowledgement ---------------------------------------------------------------------------------

const ORG = 'org-ack';
const DOCUMENTS = ['shared-responsibility', 'security-posture', 'known-limits'];
let acks = 0;
function ack(people, overrides = {}) {
  const path = join(root, `ack-${++acks}.json`);
  writeFileSync(path, JSON.stringify({ schema: 'frontera.pilot-acknowledgement.v1', organizationId: ORG, release: { commit: COMMIT }, documents: DOCUMENTS, acknowledgedBy: people, ...overrides }));
  return path;
}
const person = (role, extra = {}) => ({ name: `A ${role}`, role, acknowledgedAt: '2026-10-13T11:00:00.000Z', ...extra });

async function pr18(path) {
  const report = await evaluatePilotReadiness({ reader: reader(host(ORG)), credential: READ_SECRET, operatorCredentials: [ADMIN_SECRET], acknowledgementPath: path, now: new Date() });
  return report.checks.find((check) => check.id === 'PR-18');
}

describe('P2-3 — PR-18 requires the pilot owner\'s acknowledgement (an operational role, not an operator-plane role)', () => {
  it('E1: the pilot owner acknowledged every required document → PASS', async () => {
    assert.equal((await pr18(ack([person('pilot-owner')]))).status, 'pass');
  });
  it('E2 (the reproduction): an observer alone → FAIL ACKNOWLEDGEMENT_NOT_BY_PILOT_OWNER', async () => {
    assert.equal((await pr18(ack([person('observer')]))).reason, 'ACKNOWLEDGEMENT_NOT_BY_PILOT_OWNER');
  });
  it('E3: a contractor alone → FAIL', async () => {
    assert.equal((await pr18(ack([person('contractor')]))).reason, 'ACKNOWLEDGEMENT_NOT_BY_PILOT_OWNER');
  });
  it('E3b: an operator-plane role is not the pilot owner (organization-administrator alone → FAIL)', async () => {
    assert.equal((await pr18(ack([person('organization-administrator')]))).reason, 'ACKNOWLEDGEMENT_NOT_BY_PILOT_OWNER');
  });
  it('E4: the pilot owner plus other roles → PASS', async () => {
    assert.equal((await pr18(ack([person('observer'), person('pilot-owner'), person('contractor')]))).status, 'pass');
  });
  it('E5: the pilot owner, with one required document missing → FAIL ACKNOWLEDGEMENT_INCOMPLETE', async () => {
    assert.equal((await pr18(ack([person('pilot-owner')], { documents: ['shared-responsibility', 'security-posture'] }))).reason, 'ACKNOWLEDGEMENT_INCOMPLETE');
  });
  it('E6: another organization → FAIL', async () => {
    assert.equal((await pr18(ack([person('pilot-owner')], { organizationId: 'org-other' }))).reason, 'ACKNOWLEDGEMENT_OTHER_ORGANIZATION');
  });
  it('E7: another release → FAIL', async () => {
    assert.equal((await pr18(ack([person('pilot-owner')], { release: { commit: 'e'.repeat(40) } }))).reason, 'ACKNOWLEDGEMENT_STALE');
  });
  it('E8: the pilot owner\'s entry with a malformed timestamp does not count → FAIL', async () => {
    const check = await pr18(ack([person('pilot-owner', { acknowledgedAt: 'yesterday' }), person('observer')]));
    assert.equal(check.status, 'fail');
    assert.equal(check.reason, 'ACKNOWLEDGEMENT_NOT_BY_PILOT_OWNER');
  });
});
