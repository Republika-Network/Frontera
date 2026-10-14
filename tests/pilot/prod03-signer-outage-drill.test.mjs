// PROD-03 — the pilot under EXTERNAL authority-key custody, and a signer outage.
//
// The reference pilot runs software custody (docs/pilot/SECURITY_POSTURE.md
// §4). A pilot whose threat model requires it runs the Host with external
// custody (CORE-02): this drill proves the readiness gate and the runbook
// semantics hold there too, on real processes — the reference custody service,
// the reference witness, the reference target and the Host from a staged
// release. The signer is stopped mid-pilot: the gate reports it (PR-05), new
// authority cannot be signed so nothing reaches the target, the Host stays
// live; the signer comes back on its own key and everything resumes.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  FIXTURES,
  OPERATOR_ENVS,
  ORGANIZATION_ID,
  drillCommit,
  expectStatus,
  freePort,
  generateSecrets,
  hostEnvironment,
  http,
  killAll,
  referencePilotFile,
  runCli,
  stageRelease,
  startProcess,
  stopProcess,
  targetEffects,
  waitForLine,
  workspace,
} from './fixtures/drill-lib.mjs';

const ws = workspace('frontera-prod03-signer-');
const state = {};
const TD = 'trust-domain-pilot';
const ISSUER = 'actor-pilot-org';
const BOUNDS = [
  { dimension: 'replicaCount', kind: 'maximum', type: 'integer', limit: 3 },
  { dimension: 'deploymentStrategy', kind: 'exact', type: 'token', value: 'rolling' },
];
let sequence = 0;
const deploy = () => ({ action: 'deploy-release', resource: 'staging-cluster', parameters: { replicaCount: 1, deploymentStrategy: 'rolling' }, idempotencyKey: `prod03-signer-${++sequence}` });

async function startSigner() {
  state.signer = startProcess('signer', join(state.stage, 'scripts/run-reference-authority-signer.mjs'), {
    PATH: process.env.PATH,
    FRONTERA_REFERENCE_SIGNER_KEY_FILE: join(state.signerDir, 'signer-key.pem'),
    FRONTERA_REFERENCE_SIGNER_KEY_ID: 'pilot-external-key-1',
    FRONTERA_REFERENCE_SIGNER_TOKEN: state.signerToken,
    FRONTERA_REFERENCE_SIGNER_PORT: String(state.signerPort),
  }, { cwd: state.stage });
  await waitForLine(state.signer, /listening on http:\/\/127\.0\.0\.1:\d+/);
}

function readiness(env) {
  const result = runCli(join(state.stage, 'scripts/pilot/pilot-readiness.mjs'), ['--host', state.url, '--credential-env', OPERATOR_ENVS.observer, '--operator-env', OPERATOR_ENVS.admin, '--preflight', '--require', 'deployment', '--require-external-custody', '--json'], env, { cwd: state.stage });
  return JSON.parse(result.stdout);
}

describe('PROD-03 signer drill — external custody: the gate sees a signer outage, nothing is signed or performed, recovery needs no reset', { concurrency: false }, () => {
  before(async () => {
    state.stage = stageRelease(ws.root, drillCommit().commit);
    state.stateDir = ws.dir('state');
    state.witnessDir = ws.dir('witness');
    state.signerDir = ws.dir('signer');
    state.signerPort = await freePort();
    state.witnessPort = await freePort();
    state.hostPort = await freePort();
    state.targetPort = await freePort();
    state.signerToken = createHash('sha256').update(`signer-${Date.now()}-${Math.random()}`).digest('base64url');
  });
  after(async () => {
    await killAll();
    ws.cleanup();
  });

  it('boots under external custody: no private key in the Host environment; the signer and witness are their own processes; PR-05 passes with custody=external', async () => {
    const generated = generateSecrets(state.stage, join(state.witnessDir, 'receipt-key.pem'), Object.values(OPERATOR_ENVS));
    // External custody: drop the software key the generator produced; pin the custody service's identity instead.
    const { AOC_ENTERPRISE_AUTHORITY_SIGNING_KEY_PEM: _software, AOC_ENTERPRISE_AUTHORITY_SIGNING_KEY_ID: _id, AOC_ENTERPRISE_AUTHORITY_VERIFICATION_KEYS: _keys, ...secrets } = generated;
    await startSigner();
    const publicKeyPem = readFileSync(join(state.signerDir, 'signer-key.pem.pub'), 'utf8');
    state.secrets = {
      ...secrets,
      FRONTERA_PROVIDER_TOKEN: 'provider-token-not-used-by-the-drill-0000',
      AOC_ENTERPRISE_AUTHORITY_SIGNER_MODE: 'external',
      AOC_ENTERPRISE_AUTHORITY_SIGNER_ENDPOINT: `http://127.0.0.1:${state.signerPort}`,
      AOC_ENTERPRISE_AUTHORITY_SIGNER_TOKEN: state.signerToken,
      AOC_ENTERPRISE_AUTHORITY_SIGNER_TIMEOUT_MS: '1000',
      AOC_ENTERPRISE_AUTHORITY_SIGNER_MAX_ATTEMPTS: '1',
      AOC_ENTERPRISE_AUTHORITY_SIGNER_PROBE_INTERVAL_MS: '0',
      AOC_ENTERPRISE_AUTHORITY_SIGNING_KEY_ID: 'pilot-external-key-1',
      AOC_ENTERPRISE_AUTHORITY_VERIFICATION_KEYS: JSON.stringify([{ keyId: 'pilot-external-key-1', algorithm: 'ed25519-v1', publicKeyPem }]),
    };
    state.witness = startProcess('witness', join(state.stage, 'scripts/run-reference-authority-state-witness.mjs'), {
      PATH: process.env.PATH,
      FRONTERA_REFERENCE_WITNESS_DB: join(state.witnessDir, 'witness.sqlite'),
      FRONTERA_REFERENCE_WITNESS_KEY_FILE: join(state.witnessDir, 'receipt-key.pem'),
      FRONTERA_REFERENCE_WITNESS_ID: state.secrets.AOC_ENTERPRISE_AUTHORITY_FRESHNESS_WITNESS_ID,
      FRONTERA_REFERENCE_WITNESS_TOKEN: state.secrets.AOC_ENTERPRISE_AUTHORITY_FRESHNESS_TOKEN,
      FRONTERA_REFERENCE_WITNESS_PORT: String(state.witnessPort),
    }, { cwd: state.stage });
    await waitForLine(state.witness, /listening on/);
    state.target = startProcess('target', join(FIXTURES, 'reference-target.mjs'), { PATH: process.env.PATH, FRONTERA_DRILL_TARGET_PORT: String(state.targetPort) });
    await waitForLine(state.target, /reference-target listening/);
    state.targetUrl = `http://127.0.0.1:${state.targetPort}`;
    const file = join(ws.dir('config'), 'governed-actions.json');
    writeFileSync(file, JSON.stringify(referencePilotFile({ profileLifecycle: undefined, approvalPolicy: undefined })));
    state.env = hostEnvironment({ stateDir: state.stateDir, governedActionsFile: file, witnessUrl: `http://127.0.0.1:${state.witnessPort}`, secrets: state.secrets, extra: { AOC_ENTERPRISE_HTTP_PORT: String(state.hostPort), FRONTERA_DRILL_STAGE: state.stage, FRONTERA_DRILL_TARGET_URL: state.targetUrl } });
    assert.equal(Object.keys(state.env).includes('AOC_ENTERPRISE_AUTHORITY_SIGNING_KEY_PEM'), false, 'no authority private key in the Host environment');
    state.host = startProcess('host', join(FIXTURES, 'drill-host.mjs'), state.env, { cwd: state.stage });
    await waitForLine(state.host, /listening on/);
    state.url = `http://127.0.0.1:${state.hostPort}`;
    const gate = readiness(state.env);
    const pr05 = gate.checks.find((check) => check.id === 'PR-05');
    assert.equal(pr05.status, 'pass', JSON.stringify(gate.checks));
    assert.match(pr05.detail, /custody=external/);
  });

  it('an agent acts once with an externally signed grant; the signer stops: PR-05 SIGNER_UNAVAILABLE, the Host stays live, nothing new is signed or performed; the signer returns on its own key and execution resumes', async () => {
    const auth = (role) => ({ bearer: state.secrets[OPERATOR_ENVS[role]] });
    const post = async (role, path, body) => expectStatus(await http(state.url, 'POST', path, { ...auth(role), body }), 200, path);
    await post('admin', '/api/admin/authority/entities/actor', { actorId: ISSUER, type: 'organization', displayName: 'Pilot Organization' });
    await post('admin', '/api/admin/authority/entities/trust-domain', { trustDomainId: TD, name: 'Pilot', issuerActorId: ISSUER, acceptedIssuerIds: [ISSUER], acceptedActorTypes: ['human', 'organization', 'agent'] });
    await post('admin', '/api/admin/authority/entities/root-issuer', { trustDomainId: TD, actorId: ISSUER });
    await post('provisioner', '/api/admin/authority/entities/actor', { actorId: 'actor-owner', type: 'human', displayName: 'Owner', issuerId: ISSUER, trustDomainId: TD });
    await post('provisioner', '/api/admin/authority/entities/actor', { actorId: 'actor-agent', type: 'agent', displayName: 'Agent', issuerId: ISSUER, trustDomainId: TD, externalSubject: { system: 'pilot-ci', subjectId: 'signer-drill-agent' } });
    const credential = (await post('provisioner', '/api/admin/agents/actor-agent/credentials', { idempotencyKey: 'signer-drill-credential' })).body.bearerCredential;
    await post('provisioner', '/api/admin/authority/entities/authority-grant', { authorityGrantId: 'authority-owner', issuerActorId: ISSUER, subjectActorId: 'actor-owner', trustDomainId: TD, capability: 'release.manage', actions: ['deploy-release'], resourceScopes: ['staging-cluster'], canDelegate: true, allowedDelegateActorTypes: ['agent'], maxDelegationDepth: 1, parameterBounds: BOUNDS });
    await post('provisioner', '/api/admin/authority/entities/passport', { passportId: 'passport-agent', type: 'agent_passport', subjectActorId: 'actor-agent', issuerActorId: ISSUER, trustDomainId: TD });
    await post('provisioner', '/api/admin/authority/entities/capability-token', { capabilityTokenId: 'capability-agent', subjectActorId: 'actor-agent', principalActorId: 'actor-owner', issuerActorId: 'actor-owner', trustDomainId: TD, capability: 'release.execute', actions: ['deploy-release'], resourceScopes: ['staging-cluster'], riskLevel: 'medium' });
    await post('provisioner', '/api/admin/authority/entities/delegation-grant', { delegationGrantId: 'delegation-agent', delegatorActorId: 'actor-owner', delegateActorId: 'actor-agent', delegateActorType: 'agent', trustDomainId: TD, sourceAuthorityGrantId: 'authority-owner', capability: 'release.execute', actions: ['deploy-release'], resourceScopes: ['staging-cluster'], canRedelegate: false, parameterBounds: BOUNDS });
    const govern = () => http(state.url, 'POST', '/api/governed-actions', { bearer: credential, body: deploy() });
    assert.equal((await govern()).body.status, 'executed');
    assert.equal((await targetEffects(state.targetUrl)).length, 1);

    assert.equal(await stopProcess(state.signer), 0);
    const during = await govern();
    assert.notEqual(during.body.status, 'executed', during.text);
    assert.equal((await targetEffects(state.targetUrl)).length, 1, 'no new authority could be signed: nothing performed');
    expectStatus(await http(state.url, 'GET', '/live'), 200, '/live');
    const health = (await http(state.url, 'GET', '/health')).body;
    assert.equal(health.authoritySigner.state, 'unavailable', JSON.stringify(health.authoritySigner));
    const gate = readiness(state.env);
    assert.equal(gate.checks.find((check) => check.id === 'PR-05').reason, 'SIGNER_UNAVAILABLE', JSON.stringify(gate.checks));
    assert.equal(gate.result, 'not-ready');

    await startSigner();
    let recovered;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      recovered = await govern();
      if (recovered.body.status === 'executed') break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    }
    assert.equal(recovered.body.status, 'executed', recovered.text);
    assert.equal((await targetEffects(state.targetUrl)).length, 2);
    assert.equal(readiness(state.env).checks.find((check) => check.id === 'PR-05').status, 'pass');
    assert.equal(await stopProcess(state.host), 0);
    assert.equal(ORGANIZATION_ID, 'org-pilot');
  });
});
