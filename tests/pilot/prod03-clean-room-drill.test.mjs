// PROD-03 — THE CLEAN-ROOM PILOT DRILL.
//
// > A real organization uses Frontera without the founder operating source
// > code or database state. (FRONTERA-MASTER-PLAN §11.3)
//
// From nothing — a fresh state directory, a fresh witness, secrets from the
// supported generator, no organization, no agent — through every phase of a
// pilot's life, using ONLY supported surfaces: the documented CLIs (secret
// generator, preflight, readiness gate, backup, restore), the Host's HTTP API
// (operator plane, governed-action API, evidence API) and the shipped web
// console. Real processes: the Host (a staged release with a recorded
// identity), the reference CORE-07 witness, the web control plane and the
// reference target each run as their own process; effects are counted by the
// target, in another process. No database is opened, no store is imported, no
// configuration is edited after start except where a phase IS a supported
// configuration change (adding an operator), and nothing is retried by hand.
//
// Evidence is collected into `drill` and written, value-free, to
// $FRONTERA_PILOT_DRILL_EVIDENCE when that variable is set (qualify:pilot).

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  OPERATOR_ENVS,
  ORGANIZATION_ID,
  REPO,
  FIXTURES,
  drillCommit,
  expectStatus,
  freePort,
  generateSecrets,
  hostEnvironment,
  http,
  killAll,
  referencePilotFile,
  runBlock,
  runCli,
  DRILL_EXECUTED_BLOCKS,
  DRILL_RUNBOOK,
  drillBlocks,
  setTargetMode,
  stageRelease,
  startProcess,
  stopProcess,
  targetEffects,
  transcript,
  waitForLine,
  workspace,
  writeJson,
} from './fixtures/drill-lib.mjs';
import { Browser, formsOf, textOf } from '../../dist/src/control-plane-web/__tests__/web-browser.js';

const TRUST_DOMAIN = 'trust-domain-pilot';
const ISSUER = 'actor-pilot-org';
const OWNER = 'actor-release-owner';
const AGENT = 'actor-release-agent';
const AGENT_SUBJECT = { system: 'pilot-ci', subjectId: 'release-agent-1' };
const AGENT_2 = 'actor-release-agent-2';
const AGENT_2_SUBJECT = { system: 'pilot-ci', subjectId: 'release-agent-2' };
const STAGING = 'staging-cluster';
const PRODUCTION = 'production-cluster';
const DEPLOY = 'deploy-release';
const APPROVE = 'approve-deploy';
const BOUNDS = [
  { dimension: 'replicaCount', kind: 'maximum', type: 'integer', limit: 3 },
  { dimension: 'deploymentStrategy', kind: 'exact', type: 'token', value: 'rolling' },
];

// A multi-process drill: run on its own (npm run qualify:pilot, CI job pilot-operations), never inside the
// parallel root suite, where its load would only perturb other suites' timing.
const PROCESS_DRILL_SKIP = process.env.FRONTERA_PILOT_DRILL === '1' ? false : 'multi-process drill: npm run qualify:pilot (or FRONTERA_PILOT_DRILL=1)';
/** Created in `before`: a skipped drill leaves nothing behind. */
let ws;
const drill = { schema: 'frontera.pilot-drill-evidence.v1', phases: {}, effects: {} };
const state = {};
let keySequence = 0;
const key = (label) => `prod03-${label}-${++keySequence}`;
const deploy = (resource, replicaCount, label, strategy = 'rolling') => ({ action: DEPLOY, resource, parameters: { replicaCount, deploymentStrategy: strategy }, idempotencyKey: key(label) });

// -- the processes ------------------------------------------------------------------------------

async function startWitness() {
  state.witness = startProcess('witness', join(state.stage, 'scripts/run-reference-authority-state-witness.mjs'), {
    PATH: process.env.PATH,
    FRONTERA_REFERENCE_WITNESS_DB: join(state.witnessDir, 'witness.sqlite'),
    FRONTERA_REFERENCE_WITNESS_KEY_FILE: join(state.witnessDir, 'receipt-key.pem'),
    FRONTERA_REFERENCE_WITNESS_ID: state.secrets.AOC_ENTERPRISE_AUTHORITY_FRESHNESS_WITNESS_ID,
    FRONTERA_REFERENCE_WITNESS_TOKEN: state.secrets.AOC_ENTERPRISE_AUTHORITY_FRESHNESS_TOKEN,
    FRONTERA_REFERENCE_WITNESS_PORT: String(state.witnessPort),
  }, { cwd: state.stage });
  await waitForLine(state.witness, /listening on http:\/\/127\.0\.0\.1:\d+/);
}

async function startTarget() {
  state.target = startProcess('target', join(FIXTURES, 'reference-target.mjs'), { PATH: process.env.PATH, FRONTERA_DRILL_TARGET_PORT: String(state.targetPort), FRONTERA_DRILL_TARGET_LOG: join(ws.root, 'target-effects.jsonl') });
  await waitForLine(state.target, /reference-target listening/);
}

function envFor(extra = {}) {
  return hostEnvironment({
    stateDir: state.stateDir,
    governedActionsFile: state.governedActionsFile,
    witnessUrl: `http://127.0.0.1:${state.witnessPort}`,
    secrets: { ...state.secrets, AOC_ENTERPRISE_API_KEYS: `${state.secrets.FRONTERA_AUDITOR_EVIDENCE_KEY}:${ORGANIZATION_ID}` },
    extra: { AOC_ENTERPRISE_HTTP_PORT: String(state.hostPort), FRONTERA_DRILL_STAGE: state.stage, FRONTERA_DRILL_TARGET_URL: state.targetUrl, ...extra },
  });
}

async function startHost(env = envFor()) {
  const host = startProcess('host', join(FIXTURES, 'drill-host.mjs'), env, { cwd: state.stage });
  const line = await waitForLine(host, /listening on http:\/\/127\.0\.0\.1:(\d+)/);
  state.host = host;
  state.url = `http://127.0.0.1:${/:(\d+)$/.exec(line)[1]}`;
  return host;
}

async function stopHost() {
  const code = await stopProcess(state.host);
  assert.equal(code, 0, `the Host exits 0 on SIGTERM:\n${state.host.lines.slice(-10).join('\n')}`);
  assert.ok(state.host.lines.some((line) => line.includes('enterprise.host.shutdown_complete')), 'shutdown_complete logged');
  drill.shutdowns = (drill.shutdowns ?? 0) + 1;
}

/** Fails to start: returns the refusal line. Asserts nothing was served. */
async function expectRefusal(env, pattern) {
  const host = startProcess('host-refused', join(FIXTURES, 'drill-host.mjs'), env, { cwd: state.stage });
  const code = await host.exited;
  assert.notEqual(code, 0, 'the Host must refuse');
  const line = host.lines.find((entry) => pattern.test(entry));
  assert.ok(line !== undefined, `refusal ${pattern}:\n${host.lines.slice(-15).join('\n')}`);
  assert.equal(host.lines.some((entry) => /listening on/.test(entry)), false, 'never listened');
  return { line, lines: host.lines };
}

const as = (role) => state.secrets[OPERATOR_ENVS[role]];
const api = (method, path, role, body) => http(state.url, method, path, { bearer: role === undefined ? undefined : as(role), ...(body !== undefined ? { body } : {}) });
const govern = (body, credential = state.agentCredential) => http(state.url, 'POST', '/api/governed-actions', { bearer: credential, body });
const effects = async () => (await targetEffects(state.targetUrl)).length;

async function provision(role, kind, body) {
  const reply = await api('POST', `/api/admin/authority/entities/${kind}`, role, body);
  expectStatus(reply, 200, `provision ${kind}`);
  assert.ok(['provisioned', 'replayed'].includes(reply.body.outcome), reply.text);
  return reply;
}

function readiness(args, env = envFor()) {
  const result = runCli(join(state.stage, 'scripts/pilot/pilot-readiness.mjs'), ['--host', state.url, '--credential-env', OPERATOR_ENVS.observer, '--operator-env', OPERATOR_ENVS.admin, '--json', ...args], env, { cwd: state.stage });
  assert.ok([0, 1].includes(result.status), `readiness gate usage error: ${result.stderr}`);
  const report = JSON.parse(result.stdout);
  return { ...report, exitStatus: result.status, raw: result.stdout + result.stderr };
}
const check = (report, id) => report.checks.find((entry) => entry.id === id);

async function traceOf(requestId) {
  const auditor = state.secrets.FRONTERA_AUDITOR_EVIDENCE_KEY;
  const trace = await http(state.url, 'GET', `/api/evidence/traces/${encodeURIComponent(requestId)}?level=AUDITOR`, { bearer: auditor });
  expectStatus(trace, 200, `trace ${requestId}`);
  const verified = await http(state.url, 'GET', `/api/evidence/traces/${encodeURIComponent(requestId)}/verify`, { bearer: auditor });
  expectStatus(verified, 200, `verify ${requestId}`);
  return { trace: trace.body, verification: verified.body };
}

function assertVerified(evidence, where) {
  const verification = evidence.verification;
  assert.equal(verification.verified, true, `${where}: the trace verifies: ${JSON.stringify(verification).slice(0, 600)}`);
  for (const [category, result] of Object.entries(verification.categories)) assert.equal(result, 'pass', `${where}: ${category}`);
  if (process.env.FRONTERA_DRILL_DEBUG === '1') console.log(where, Object.keys(evidence.trace).join(','), JSON.stringify(evidence.trace).slice(0, 400));
}

/** Every secret this drill knows: generated, issued, and the provider's. None may appear where it was not revealed. */
function knownSecrets() {
  const values = Object.entries(state.secrets)
    .filter(([name]) => /KEY|TOKEN|PEM/.test(name) && !/VERIFICATION_KEYS|PUBLIC_KEY|KEY_ID|WITNESS_ID/.test(name))
    .map(([, value]) => value);
  const pemLines = values.filter((value) => value.includes('PRIVATE KEY')).flatMap((value) => value.split('\n').filter((line) => line.length > 40));
  return [...values.filter((value) => !value.includes('PRIVATE KEY')), ...pemLines, ...(state.issuedCredentials ?? [])].filter((value) => value.length >= 16);
}

function assertNoSecretIn(text, where, except = []) {
  for (const secret of knownSecrets()) if (!except.includes(secret)) assert.equal(text.includes(secret), false, `${where} must not contain a secret`);
}

// ---------------------------------------------------------------------------------------------------

describe('PROD-03 clean-room pilot drill — a real organization, no founder, supported surfaces only', { concurrency: false, skip: PROCESS_DRILL_SKIP }, () => {
  before(async () => {
    ws = workspace();
    const { commit, source } = drillCommit();
    drill.release = { commit, commitSource: source };
    state.stage = stageRelease(ws.root, commit);
    state.stateDir = ws.dir('state');
    state.witnessDir = ws.dir('witness');
    state.configDir = ws.dir('config');
    state.backupDir = join(ws.root, 'backups');
    state.witnessPort = await freePort();
    state.hostPort = await freePort();
    state.targetPort = await freePort();
    state.targetUrl = `http://127.0.0.1:${state.targetPort}`;
    state.issuedCredentials = [];
  });
  after(async () => {
    await killAll();
    if (process.env.FRONTERA_PILOT_DRILL_EVIDENCE !== undefined) writeJson(process.env.FRONTERA_PILOT_DRILL_EVIDENCE, drill);
    ws?.cleanup();
  });

  it('Phase A — deploy: secrets from the generator, configuration from the reference template, preflight PASS, witness + target + Host started; live, ready, deployment-ready, organization not yet onboarded', async () => {
    // Secrets: the supported one-time generator, as `witness-init` runs it.
    state.secrets = generateSecrets(state.stage, join(state.witnessDir, 'receipt-key.pem'), [...Object.values(OPERATOR_ENVS), 'FRONTERA_AUDITOR_EVIDENCE_KEY']);
    state.secrets.FRONTERA_PROVIDER_TOKEN = createHash('sha256').update(`provider-${Date.now()}-${Math.random()}`).digest('hex');
    // A second run refuses: the deployment is initialized (PILOT-1 / one-time generation).
    const again = runCli(join(state.stage, 'scripts/deploy/generate-pilot-secrets.mjs'), ['--secret', 'FRONTERA_X'], { PATH: process.env.PATH, FRONTERA_REFERENCE_WITNESS_KEY_FILE: join(state.witnessDir, 'receipt-key.pem') }, { cwd: state.stage });
    assert.equal(again.status, 1);
    assert.match(again.stderr, /already initialized/);

    // Configuration: the reference pilot template, one documented substitution (the route).
    state.governedActionsFile = join(state.configDir, 'governed-actions.json');
    writeFileSync(state.governedActionsFile, `${JSON.stringify(referencePilotFile(), null, 2)}\n`, { mode: 0o644 });
    assertNoSecretIn(readFileSync(state.governedActionsFile, 'utf8'), 'the governed-action file');

    // Preflight: the documented configuration check, before anything starts.
    const preflight = runCli(join(state.stage, 'scripts/check-host-configuration.mjs'), [], envFor(), { cwd: state.stage });
    assert.equal(preflight.status, 0, preflight.stdout + preflight.stderr);
    assert.match(preflight.stdout, /RESULT: PASS/);
    assert.match(preflight.stdout, /PASS release-identity\s+\S+\+[0-9a-f]{12} \(build=release\)/);
    assertNoSecretIn(preflight.stdout + preflight.stderr, 'the preflight output');

    // approvalPolicy is refused before anything starts when it could never be resolved: no configured operator can
    // reach approval.approve, or a catalog version of a ruled profile declares no CORE-05 approval (independent review P1-2, P1-4).
    const refusedAtPreflight = (name, file, pattern) => {
      const path = join(state.configDir, `${name}.json`);
      writeJson(path, file);
      const result = runCli(join(state.stage, 'scripts/check-host-configuration.mjs'), [], envFor({ AOC_ENTERPRISE_GOVERNED_ACTIONS_FILE: path }), { cwd: state.stage });
      assert.equal(result.status, 1, `${name}: ${result.stdout}${result.stderr}`);
      assert.match(result.stdout, pattern, name);
      assertNoSecretIn(result.stdout + result.stderr, `the ${name} preflight output`);
      return /\[([A-Z_]+)\]/.exec(result.stdout)?.[1] ?? 'refused';
    };
    const template = referencePilotFile();
    const noApprover = refusedAtPreflight('no-approver', { ...template, operators: template.operators.filter((operator) => operator.role !== 'approver' && operator.role !== 'organization-administrator') }, /approvalPolicy requires an operator with approval\.approve/);
    const production = template.governance.profiles.find((profile) => profile.profileId === 'deploy-production');
    const { approval: _withoutApproval, ...productionV2 } = { ...production, version: 2 };
    const unapprovableVersion = refusedAtPreflight('unapprovable-version', { ...template, governance: { ...template.governance, profiles: [...template.governance.profiles, productionV2] } }, /deploy-production' version 2 declares no 'approval'/);

    await startWitness();
    await startTarget();
    await startHost();
    expectStatus(await http(state.url, 'GET', '/live'), 200, '/live');
    expectStatus(await http(state.url, 'GET', '/ready'), 200, '/ready');
    const version = expectStatus(await http(state.url, 'GET', '/version'), 200, '/version').body;
    assert.equal(version.build, 'release');
    assert.equal(version.commit, drill.release.commit);

    const report = readiness(['--preflight', '--require', 'deployment']);
    assert.equal(report.exitStatus, 0, report.raw);
    assert.equal(report.result, 'deployment-ready', report.raw);
    assert.equal(report.levels.organization, 'not-ready');
    assert.equal(check(report, 'PR-07').reason, 'ORGANIZATION_NOT_BOOTSTRAPPED', report.raw);
    assertNoSecretIn(report.raw, 'the readiness report');
    drill.phases.A = { preflight: 'PASS', refusedAtPreflight: { noApprovalCapableOperator: noApprover, rulingProfileVersionWithoutApproval: unapprovableVersion }, live: 200, ready: 200, release: version.release, readiness: report.result, organizationLevel: report.levels.organization };
  });

  it('Phase B — organization: an organization administrator bootstraps (replay safe, conflict refused, wrong role/credential/tenant refused), a steward promotes the profiles, approver standing provisioned; organization-ready', async () => {
    // Wrong credential, wrong role, wrong tenant — before anything exists.
    assert.equal((await http(state.url, 'POST', '/api/admin/authority/entities/actor', { bearer: 'not-a-credential-0000000000000000000000', body: { actorId: ISSUER, type: 'organization', displayName: 'x' } })).status, 401);
    const byProvisioner = await api('POST', '/api/admin/authority/entities/trust-domain', 'provisioner', { trustDomainId: TRUST_DOMAIN, name: 'x', issuerActorId: ISSUER, acceptedIssuerIds: [ISSUER], acceptedActorTypes: ['agent'] });
    assert.equal(byProvisioner.status, 403, byProvisioner.text);
    const smuggled = await api('POST', '/api/admin/authority/entities/actor', 'admin', { actorId: ISSUER, type: 'organization', displayName: 'Pilot Organization', organizationId: 'org-other' });
    assert.equal(smuggled.status, 400, smuggled.text);

    const bootstrap = [
      ['actor', { actorId: ISSUER, type: 'organization', displayName: 'Pilot Organization', idempotencyKey: 'bootstrap-org-actor' }],
      ['trust-domain', { trustDomainId: TRUST_DOMAIN, name: 'Pilot Organization', issuerActorId: ISSUER, acceptedIssuerIds: [ISSUER], acceptedActorTypes: ['human', 'organization', 'agent'], idempotencyKey: 'bootstrap-trust-domain' }],
      ['root-issuer', { trustDomainId: TRUST_DOMAIN, actorId: ISSUER, idempotencyKey: 'bootstrap-root-issuer' }],
    ];
    for (const [kind, body] of bootstrap) {
      const created = await provision('admin', kind, body);
      assert.equal(created.body.outcome, 'provisioned');
      assert.equal(created.body.entity.provisionedBy, 'operator:ops-admin');
    }
    // Exact replay: the same record, nothing new.
    for (const [kind, body] of bootstrap) assert.equal((await provision('admin', kind, body)).body.outcome, 'replayed');
    // A second, conflicting bootstrap is refused; nothing written.
    const conflicting = await api('POST', '/api/admin/authority/entities/trust-domain', 'admin', { trustDomainId: TRUST_DOMAIN, name: 'Another', issuerActorId: ISSUER, acceptedIssuerIds: [ISSUER], acceptedActorTypes: ['agent'] });
    assert.equal(conflicting.status, 409, conflicting.text);
    assert.equal(conflicting.body.error?.recorded, false);

    // Governance Profiles: catalog versions promoted by the profile steward (permitting, digest-bound).
    const catalog = expectStatus(await api('GET', '/api/admin/governance-profiles', 'observer'), 200, 'profiles').body;
    assert.equal(catalog.lifecycle, 'operator-promoted');
    for (const profile of catalog.profiles) {
      assert.equal(profile.state, 'draft');
      assert.equal((await api('POST', `/api/admin/governance-profiles/${profile.profileId}/versions/${profile.version}/activate`, 'provisioner', { digest: profile.digest })).status, 403, 'a provisioner cannot promote');
      const promoted = expectStatus(await api('POST', `/api/admin/governance-profiles/${profile.profileId}/versions/${profile.version}/activate`, 'steward', { digest: profile.digest, reason: 'pilot go-live' }), 200, `activate ${profile.profileId}`);
      assert.equal(promoted.body.profile?.state ?? promoted.body.state ?? 'active', 'active', promoted.text);
    }

    // Approver standing: the CTRL-04 identity bridge, operator:<operatorId>, provisioned like any authority.
    await provision('provisioner', 'actor', { actorId: 'operator:ops-approver', type: 'human', displayName: 'Change approver', issuerId: ISSUER, trustDomainId: TRUST_DOMAIN });
    await provision('provisioner', 'authority-grant', { authorityGrantId: 'approval-standing-ops-approver', issuerActorId: ISSUER, subjectActorId: 'operator:ops-approver', trustDomainId: TRUST_DOMAIN, capability: `${APPROVE}.standing`, actions: [APPROVE], resourceScopes: [PRODUCTION], canDelegate: false, allowedDelegateActorTypes: ['human'], maxDelegationDepth: 0 });

    const report = readiness(['--preflight', '--require', 'organization', '--require-profile', 'deploy-staging', '--require-profile', 'deploy-production', '--require-approvals']);
    assert.equal(report.result, 'organization-ready', report.raw);
    assert.equal(report.levels.pilot, 'not-ready');
    assert.equal(check(report, 'PR-10').reason, 'NO_PILOT_AGENT', report.raw);
    drill.phases.B = { bootstrap: 'provisioned; replay replayed; conflict 409 recorded:false; provisioner 403; unknown credential 401; smuggled organization 400', profilesActivated: catalog.profiles.map((profile) => `${profile.profileId}@${profile.version}`), readiness: report.result };
  });

  it('Phase C — agent: owner and agent actors, a one-time credential, bounded standing authority (replicaCount ≤ 3, strategy = rolling); the web console shows the agent and its bounds', async () => {
    await provision('provisioner', 'actor', { actorId: OWNER, type: 'human', displayName: 'Release owner', issuerId: ISSUER, trustDomainId: TRUST_DOMAIN });
    await provision('provisioner', 'actor', { actorId: AGENT, type: 'agent', displayName: 'Release agent', issuerId: ISSUER, trustDomainId: TRUST_DOMAIN, externalSubject: AGENT_SUBJECT });
    const before = expectStatus(await api('GET', `/api/admin/agents/${AGENT}`, 'observer'), 200, 'agent').body;
    assert.deepEqual(before.onboarding, { actor: 'active', credential: 'none', standingAuthority: 'none' });

    const issued = expectStatus(await api('POST', `/api/admin/agents/${AGENT}/credentials`, 'provisioner', { idempotencyKey: 'release-agent-credential-1' }), 200, 'issue credential');
    state.agentCredential = issued.body.bearerCredential;
    assert.match(state.agentCredential, /^fra1\.agc-[0-9a-f]{32}\.[A-Za-z0-9_-]{43}$/);
    state.issuedCredentials.push(state.agentCredential);
    state.agentCredentialId = issued.body.credential.credentialId;
    state.firstCredentialId = state.agentCredentialId;
    state.firstCredential = state.agentCredential;
    // One-time: the replay does not reveal it again.
    const replay = expectStatus(await api('POST', `/api/admin/agents/${AGENT}/credentials`, 'provisioner', { idempotencyKey: 'release-agent-credential-1' }), 200, 'replay');
    assert.equal(replay.body.outcome, 'replayed');
    assert.equal(replay.body.bearerCredential, null);

    await provision('provisioner', 'authority-grant', { authorityGrantId: 'authority-release-owner', issuerActorId: ISSUER, subjectActorId: OWNER, trustDomainId: TRUST_DOMAIN, capability: 'release.manage', actions: [DEPLOY], resourceScopes: [STAGING, PRODUCTION], canDelegate: true, allowedDelegateActorTypes: ['agent'], maxDelegationDepth: 1, parameterBounds: BOUNDS });
    await provision('provisioner', 'passport', { passportId: 'passport-release-agent', type: 'agent_passport', subjectActorId: AGENT, issuerActorId: ISSUER, trustDomainId: TRUST_DOMAIN });
    await provision('provisioner', 'capability-token', { capabilityTokenId: 'capability-release-agent', subjectActorId: AGENT, principalActorId: OWNER, issuerActorId: OWNER, trustDomainId: TRUST_DOMAIN, capability: 'release.execute', actions: [DEPLOY], resourceScopes: [STAGING, PRODUCTION], riskLevel: 'medium' });
    await provision('provisioner', 'delegation-grant', { delegationGrantId: 'delegation-release-agent', delegatorActorId: OWNER, delegateActorId: AGENT, delegateActorType: 'agent', trustDomainId: TRUST_DOMAIN, sourceAuthorityGrantId: 'authority-release-owner', capability: 'release.execute', actions: [DEPLOY], resourceScopes: [STAGING, PRODUCTION], canRedelegate: false, parameterBounds: BOUNDS });
    const view = expectStatus(await api('GET', `/api/admin/agents/${AGENT}`, 'observer'), 200, 'agent').body;
    assert.deepEqual(view.onboarding, { actor: 'active', credential: 'active', standingAuthority: 'assigned' });

    // The web console: a separate process over the operator plane.
    state.consolePort = await freePort();
    state.console = startProcess('console', join(state.stage, 'scripts/run-control-plane-web.mjs'), { PATH: process.env.PATH, FRONTERA_CONSOLE_HOST_URL: state.url, FRONTERA_CONSOLE_HTTP_HOST: '127.0.0.1', FRONTERA_CONSOLE_HTTP_PORT: String(state.consolePort) }, { cwd: state.stage });
    await waitForLine(state.console, /Frontera Control Plane listening/);
    state.consoleOrigin = `http://127.0.0.1:${state.consolePort}`;
    const observer = new Browser(state.consoleOrigin, 'observer');
    const signedIn = await observer.signIn(as('observer'));
    assert.equal(signedIn.status, 200, textOf(signedIn.html).slice(0, 300));
    const agents = await observer.get('/agents');
    assert.ok(textOf(agents.html).includes(AGENT), 'the console lists the agent');
    const delegation = await observer.get('/authority/entities/delegation-grant/delegation-release-agent');
    const delegationText = textOf(delegation.html);
    assert.ok(delegationText.includes('replicaCount') && delegationText.includes('3') && delegationText.includes('rolling'), 'the console shows the typed bounds');
    state.browsers = { observer };
    for (const entry of observer.transcript) assertNoSecretIn(`${JSON.stringify(entry.headers)}${entry.body}`, 'a console response', []);
    drill.phases.C = { onboarding: view.onboarding, credential: 'revealed once; replay bearerCredential null', bounds: BOUNDS, web: 'signed in; agent and bounds visible' };
  });

  it('Phase D — execution: in bounds → exactly one effect at the target; over the bound or the wrong strategy → withheld, zero effects; activity and the ASSURE trace verify', async () => {
    assert.equal(await effects(), 0);
    const valid = await govern(deploy(STAGING, 2, 'first'));
    assert.equal(valid.body.status, 'executed', valid.text);
    const seen = await targetEffects(state.targetUrl);
    assert.equal(seen.length, 1, 'exactly one effect');
    assert.equal(seen[0].executionId, valid.body.executionId ?? seen[0].executionId);
    assert.equal(seen[0].requestId, valid.body.requestId);
    assert.deepEqual(seen[0].parameters.map((parameter) => [parameter.dimension, parameter.value]), [['deploymentStrategy', 'rolling'], ['replicaCount', 2]].sort());
    state.requests = { first: valid.body.requestId };

    const over = await govern(deploy(STAGING, 5, 'over'));
    assert.equal(over.body.status, 'withheld', over.text);
    assert.ok(over.body.reasonCodes.includes('PARAMETER_AUTHORITY_EXCEEDED'), over.text);
    const wrongStrategy = await govern(deploy(STAGING, 2, 'strategy', 'recreate'));
    assert.notEqual(wrongStrategy.body.status, 'executed', wrongStrategy.text);
    assert.equal(await effects(), 1, 'denied/withheld: zero additional effects');
    state.requests.overBound = over.body.requestId;

    const activity = expectStatus(await api('GET', '/api/admin/activity/decisions', 'observer'), 200, 'activity').body;
    assert.ok(activity.decisions.some((decision) => decision.requestId === valid.body.requestId));
    const first = await traceOf(valid.body.requestId);
    assertVerified(first, 'first action');
    const denied = await traceOf(over.body.requestId);
    assertVerified(denied, 'over-bound');
    state.firstTraceDigest = createHash('sha256').update(JSON.stringify(first.trace)).digest('hex');
    // The auditor's evidence key can read evidence, and nothing else.
    assert.ok([401, 403].includes((await http(state.url, 'GET', '/api/admin/agents', { bearer: state.secrets.FRONTERA_AUDITOR_EVIDENCE_KEY })).status));
    assert.ok([401, 403].includes((await govern(deploy(STAGING, 1, 'auditor'), state.secrets.FRONTERA_AUDITOR_EVIDENCE_KEY)).status));
    assert.equal(await effects(), 1);
    drill.phases.D = { valid: 'executed, 1 effect', overBound: over.body.reasonCodes, wrongStrategy: wrongStrategy.body.status, traces: 'verified (success, over-bound)', effects: 1 };
  });

  it('Interlude — an early cold backup, taken with the supported CLI on a stopped Host (kept to prove later that a stale restore is refused)', async () => {
    await stopHost();
    const early = runCli(join(state.stage, 'scripts/portability/backup-enterprise-v1.mjs'), ['--cold', '--output', join(state.backupDir, 'early')], envFor(), { cwd: state.stage });
    assert.equal(early.status, 0, early.stderr + early.stdout);
    state.earlyBackup = join(state.backupDir, 'early');
    await startHost();
    expectStatus(await http(state.url, 'GET', '/ready'), 200, '/ready after the early backup');
  });

  it('Phase E — approval: a production deploy waits (zero effect), is approved through the web console, resumes once; a rejected one never executes', async () => {
    const production = deploy(PRODUCTION, 2, 'production');
    const pending = await govern(production);
    assert.equal(pending.body.status, 'withheld', pending.text);
    assert.equal(pending.body.withheldBy, 'approval', pending.text);
    assert.equal(await effects(), 1, 'awaiting approval: no effect');
    const inbox = expectStatus(await api('GET', '/api/admin/approvals?view=pending', 'approver'), 200, 'inbox').body.approvals;
    const entry = inbox.find((candidate) => candidate.requestId === pending.body.requestId);
    assert.ok(entry !== undefined, 'the request is in the approver inbox');
    // The effective profile version carries the CORE-05 requirement the review is judged by.
    const requirement = expectStatus(await api('GET', `/api/admin/approvals/${encodeURIComponent(entry.approvalRequestId)}`, 'observer'), 200, 'detail').body;
    assert.equal(requirement.quorum?.minimumApprovals, 1, JSON.stringify(requirement).slice(0, 400));
    // Only a role with approval.approve reaches the command: an observer and a responder are refused, nothing recorded.
    for (const role of ['observer', 'responder']) {
      const refused = await api('POST', `/api/admin/approvals/${encodeURIComponent(entry.approvalRequestId)}/approve`, role, { subjectDigest: requirement.subjectDigest });
      assert.equal(refused.status, 403, `${role}: ${refused.text}`);
    }
    assert.equal((await govern(production)).body.withheldBy, 'approval', 'refused approvals count for nothing');

    // The human approves through the web console: the canonical subject, one confirmation.
    const approver = new Browser(state.consoleOrigin, 'approver');
    await approver.signIn(as('approver'));
    const url = `/approvals/${encodeURIComponent(entry.approvalRequestId)}`;
    const detail = await approver.get(url);
    const truth = expectStatus(await api('GET', `/api/admin/approvals/${encodeURIComponent(entry.approvalRequestId)}`, 'observer'), 200, 'detail').body;
    assert.ok(textOf(detail.html).includes(truth.subjectDigest), 'the console shows the canonical subject digest');
    const confirm = await approver.get(`${url}/approve`);
    assert.ok(formsOf(confirm.html).some((form) => form.action === `${url}/approve`));
    const approved = await approver.submit(confirm, (form) => form.action === `${url}/approve`, { confirm: 'yes' });
    assert.ok(textOf(approved.html).includes('Approval quorum satisfied — the action has not been executed'), textOf(approved.html).slice(0, 400));
    assert.equal(await effects(), 1, 'an approval is not an execution');
    // The agent retries the SAME request (same idempotency key): the same committed decision resumes.
    const resumed = await govern(production);
    assert.equal(resumed.body.status, 'executed', resumed.text);
    assert.equal(await effects(), 2, 'approved: exactly one effect');
    assertVerified(await traceOf(pending.body.requestId), 'approval path');

    // Rejection through the operator API: never executes.
    const second = deploy(PRODUCTION, 1, 'rejected');
    const pending2 = await govern(second);
    assert.equal(pending2.body.withheldBy, 'approval', pending2.text);
    const entry2 = (await api('GET', '/api/admin/approvals?view=pending', 'approver')).body.approvals.find((candidate) => candidate.requestId === pending2.body.requestId);
    const detail2 = (await api('GET', `/api/admin/approvals/${encodeURIComponent(entry2.approvalRequestId)}`, 'approver')).body;
    expectStatus(await api('POST', `/api/admin/approvals/${encodeURIComponent(entry2.approvalRequestId)}/reject`, 'approver', { subjectDigest: detail2.subjectDigest, reason: 'outside the change window' }), 200, 'reject');
    const afterReject = await govern(second);
    assert.notEqual(afterReject.body.status, 'executed', afterReject.text);
    assert.equal(await effects(), 2, 'rejected: zero effect');
    state.requests.approved = pending.body.requestId;
    state.requests.rejected = pending2.body.requestId;
    drill.phases.E = { pending: 'withheld by approval, 0 effects', effectiveRequirement: 'CORE-05 quorum 1 (deploy-production@1)', unauthorizedApprovers: 'observer 403, responder 403', approvedVia: 'web console (approver)', resumed: 'executed once', rejected: 'never executed', effects: 2 };
  });

  it('Phase F — emergency: a responder stops everything (withheld, zero effect, the gate reports it), cannot release it; an administrator releases (a permitting operation) and execution returns', async () => {
    const before = await effects();
    const activated = expectStatus(await api('POST', '/api/admin/emergency-controls/activate', 'responder', { scope: 'global' }), 200, 'activate');
    assert.equal(activated.body.outcome, 'activated');
    const stopped = await govern(deploy(STAGING, 1, 'stopped'));
    assert.equal(stopped.body.status, 'withheld', stopped.text);
    assert.equal(stopped.body.withheldBy, 'emergency-control', stopped.text);
    assert.equal(await effects(), before, 'stopped: zero effect');
    expectStatus(await http(state.url, 'GET', '/ready'), 200, 'a stop does not change /ready');
    const gate = readiness(['--preflight', '--require', 'deployment']);
    assert.equal(gate.result, 'not-ready', gate.raw);
    assert.equal(check(gate, 'PR-13').reason, 'EMERGENCY_STOP_ACTIVE');
    assertVerified(await traceOf(stopped.body.requestId), 'emergency stop');
    assert.equal((await api('POST', '/api/admin/emergency-controls/release', 'responder', { scope: 'global' })).status, 403, 'a responder never releases');
    const released = expectStatus(await api('POST', '/api/admin/emergency-controls/release', 'admin', { scope: 'global' }), 200, 'release');
    assert.equal(released.body.outcome, 'released');
    assert.equal(readiness(['--preflight', '--require', 'deployment']).result, 'organization-ready');
    const resumed = await govern(deploy(STAGING, 1, 'after-release'));
    assert.equal(resumed.body.status, 'executed', resumed.text);
    assert.equal(await effects(), before + 1);
    state.requests.stopped = stopped.body.requestId;
    drill.phases.F = { activatedBy: 'responder', withheldBy: 'emergency-control', gate: 'PR-13 EMERGENCY_STOP_ACTIVE', responderRelease: 403, releasedBy: 'organization-administrator', resumed: 'executed' };
  });

  it('Phase G — revocation and credential rotation: a revoked delegation stops the agent (zero effect); re-delegated, it acts; a rotated credential replaces the old one, which is refused', async () => {
    const before = await effects();
    const revoked = expectStatus(await api('POST', '/api/admin/authority/entities/delegation-grant/delegation-release-agent/revoke', 'responder', { reason: 'pilot drill: authority withdrawn' }), 200, 'revoke delegation');
    assert.equal(revoked.body.outcome, 'revoked');
    const refused = await govern(deploy(STAGING, 1, 'revoked'));
    assert.notEqual(refused.body.status, 'executed', refused.text);
    assert.equal(await effects(), before, 'revoked: zero effect');
    assertVerified(await traceOf(refused.body.requestId), 'revoked authority');
    state.requests.revoked = refused.body.requestId;
    const view = (await api('GET', `/api/admin/agents/${AGENT}`, 'observer')).body;
    assert.equal(view.authority.delegationGrants.find((ref) => ref.entityId === 'delegation-release-agent').status, 'revoked');
    assert.equal(check(readiness(['--preflight']), 'PR-11').reason, 'NO_STANDING_AUTHORITY', 'the gate reflects the revoked state; the deployment stays ready');

    // Pinned (CTRL-02 residual, docs/pilot/ONBOARDING_RUNBOOK.md §11.3): a revoked delegation still takes part in the
    // deterministic lineage selection, so a replacement delegation to the SAME agent whose id sorts after it is shadowed —
    // fail-closed: denied, zero effect.
    await provision('provisioner', 'delegation-grant', { delegationGrantId: 'delegation-release-agent-2', delegatorActorId: OWNER, delegateActorId: AGENT, delegateActorType: 'agent', trustDomainId: TRUST_DOMAIN, sourceAuthorityGrantId: 'authority-release-owner', capability: 'release.execute', actions: [DEPLOY], resourceScopes: [STAGING, PRODUCTION], canRedelegate: false, parameterBounds: BOUNDS });
    const shadowed = await govern(deploy(STAGING, 1, 'shadowed'));
    assert.equal(shadowed.body.status, 'denied', shadowed.text);
    assert.ok(shadowed.body.reasonCodes.includes('AUTHORITY_CAPABILITY_REVOKED'), shadowed.text);
    assert.equal(await effects(), before, 'a shadowed replacement grants nothing');

    // The supported way back: a revoked agent identity stays revoked; the agent's runtime is re-onboarded as a NEW identity.
    await provision('provisioner', 'actor', { actorId: AGENT_2, type: 'agent', displayName: 'Release agent (re-onboarded)', issuerId: ISSUER, trustDomainId: TRUST_DOMAIN, externalSubject: AGENT_2_SUBJECT });
    const issued = expectStatus(await api('POST', `/api/admin/agents/${AGENT_2}/credentials`, 'provisioner', { idempotencyKey: 'release-agent-2-credential-1' }), 200, 'issue credential 2');
    state.issuedCredentials.push(issued.body.bearerCredential);
    await provision('provisioner', 'passport', { passportId: 'passport-release-agent-2', type: 'agent_passport', subjectActorId: AGENT_2, issuerActorId: ISSUER, trustDomainId: TRUST_DOMAIN });
    await provision('provisioner', 'capability-token', { capabilityTokenId: 'capability-release-agent-2', subjectActorId: AGENT_2, principalActorId: OWNER, issuerActorId: OWNER, trustDomainId: TRUST_DOMAIN, capability: 'release.execute', actions: [DEPLOY], resourceScopes: [STAGING, PRODUCTION], riskLevel: 'medium' });
    await provision('provisioner', 'delegation-grant', { delegationGrantId: 'delegation-release-agent-v2', delegatorActorId: OWNER, delegateActorId: AGENT_2, delegateActorType: 'agent', trustDomainId: TRUST_DOMAIN, sourceAuthorityGrantId: 'authority-release-owner', capability: 'release.execute', actions: [DEPLOY], resourceScopes: [STAGING, PRODUCTION], canRedelegate: false, parameterBounds: BOUNDS });
    const old = state.agentCredential;
    state.agentCredential = issued.body.bearerCredential;
    state.agentCredentialId = issued.body.credential.credentialId;
    const reonboarded = await govern(deploy(STAGING, 1, 'reonboarded'));
    assert.equal(reonboarded.body.status, 'executed', reonboarded.text);
    assert.equal((await govern(deploy(STAGING, 1, 'first-identity'), old)).body.status, 'denied', 'the revoked identity stays stopped');

    // Credential rotation: the new value replaces the old, which is refused at once.
    const rotated = expectStatus(await api('POST', `/api/admin/agents/${AGENT_2}/credentials/${state.agentCredentialId}/rotate`, 'provisioner', { idempotencyKey: 'release-agent-2-rotation-1' }), 200, 'rotate');
    const replaced = state.agentCredential;
    state.agentCredential = rotated.body.bearerCredential;
    state.agentCredentialId = rotated.body.credential.credentialId;
    state.issuedCredentials.push(state.agentCredential);
    assert.equal((await govern(deploy(STAGING, 1, 'replaced-credential'), replaced)).status, 401, 'the replaced credential is refused');
    assert.equal((await govern(deploy(STAGING, 1, 'rotated-credential'))).body.status, 'executed');
    assert.equal(await effects(), before + 2);
    state.oldCredential = replaced;
    drill.phases.G = { revoked: 'delegation revoked by a responder; agent denied; 0 effect', shadowedReplacement: 'denied AUTHORITY_CAPABILITY_REVOKED (pinned residual)', reonboarded: 'new agent identity executes; revoked identity stays denied', rotation: 'replaced credential 401; rotated executes' };
  });

  it('Restart — SIGTERM, clean exit, start: organization, operators, profiles, agent, rotated credential, revocation and evidence all survive; nothing is executed again', async () => {
    const effectsBefore = await effects();
    const traceBefore = (await traceOf(state.requests.first)).trace.traceDigest;
    await stopHost();
    await startHost();
    assert.equal((await api('GET', '/api/admin/organization', 'admin')).body.organization.organizationId, ORGANIZATION_ID);
    const profiles = (await api('GET', '/api/admin/governance-profiles', 'observer')).body.profiles;
    assert.deepEqual(profiles.map((profile) => profile.state), ['active', 'active']);
    const view = (await api('GET', `/api/admin/agents/${AGENT}`, 'observer')).body;
    assert.equal(view.authority.delegationGrants.find((ref) => ref.entityId === 'delegation-release-agent').status, 'revoked');
    assert.equal((await govern(deploy(STAGING, 1, 'old-after-restart'), state.oldCredential)).status, 401);
    const evidence = await traceOf(state.requests.first);
    assertVerified(evidence, 'first action after restart');
    assert.equal(evidence.trace.traceDigest, traceBefore, 'the same trace');
    assert.equal(await effects(), effectsBefore, 'a restart executes nothing');
    assert.equal((await govern(deploy(STAGING, 1, 'after-restart'))).body.status, 'executed');
    assert.equal(await effects(), effectsBefore + 1);
    drill.phases.restart = { exit: 0, shutdownComplete: true, state: 'organization, operators, profiles, agent, credential, revocation, evidence preserved', duplicateEffects: 0 };
  });

  it('Phase H — backup: stop, cold backup with the supported CLI, verify; no secret in any file of it', async () => {
    state.effectsAtBackup = await effects();
    state.tracesAtBackup = {};
    for (const [name, requestId] of Object.entries(state.requests)) state.tracesAtBackup[name] = (await traceOf(requestId)).trace.traceDigest;
    await stopHost();
    const backup = runCli(join(state.stage, 'scripts/portability/backup-enterprise-v1.mjs'), ['--cold', '--output', join(state.backupDir, 'final')], envFor(), { cwd: state.stage });
    assert.equal(backup.status, 0, backup.stderr + backup.stdout);
    state.finalBackup = join(state.backupDir, 'final');
    const manifest = JSON.parse(readFileSync(join(state.finalBackup, 'backup-manifest.json'), 'utf8'));
    assert.equal(manifest.coverage.complete, true);
    assert.equal(manifest.consistency.mode, 'cold-attested');
    assert.equal(manifest.coverage.deployment.organizationId, ORGANIZATION_ID);
    // Every file, every byte: no generated secret, provider token, issued credential or private key line.
    const files = [];
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) (entry.isDirectory() ? walk(join(dir, entry.name)) : files.push(join(dir, entry.name)));
    };
    walk(state.finalBackup);
    for (const file of files) {
      const bytes = readFileSync(file);
      for (const secret of knownSecrets()) assert.equal(bytes.includes(Buffer.from(secret)), false, `the backup file ${file.slice(state.finalBackup.length)} must not contain a secret`);
    }
    assert.equal(files.some((file) => /witness/i.test(file.slice(state.finalBackup.length))), false, 'the witness is never in a backup');
    drill.phases.H = { backupId: manifest.backupId, files: files.length, coverage: 'complete', consistency: 'cold-attested', secretCanaries: 'none found' };
  });

  it('Phase I — restore: the state directory destroyed, restored from the backup alone, secrets re-supplied from outside, booted against the surviving witness; pilot-ready; evidence identical; no effect replayed', async () => {
    rmSync(state.stateDir, { recursive: true, force: true });
    ws.dir('state');
    const restored = runCli(join(state.stage, 'scripts/portability/restore-enterprise-v1.mjs'), ['--backup', state.finalBackup, '--target', state.stateDir], envFor(), { cwd: state.stage });
    assert.equal(restored.status, 0, restored.stderr + restored.stdout);
    await startHost();
    for (const [name, digest] of Object.entries(state.tracesAtBackup)) {
      const evidence = await traceOf(state.requests[name]);
      assertVerified(evidence, `${name} after restore`);
      assert.equal(evidence.trace.traceDigest, digest, `${name}: the same trace after restore`);
    }
    assert.equal(await effects(), state.effectsAtBackup, 'a restore replays no effect');
    const view = (await api('GET', `/api/admin/agents/${AGENT}`, 'observer')).body;
    assert.equal(view.authority.delegationGrants.find((ref) => ref.entityId === 'delegation-release-agent').status, 'revoked', 'revocation survives the restore');
    assert.equal((await govern(deploy(STAGING, 1, 'old-after-restore'), state.oldCredential)).status, 401);

    const restoreReport = join(state.stateDir, 'restore-report.json');
    const acknowledgement = (name, people) => {
      const path = join(state.configDir, `${name}.json`);
      writeJson(path, { schema: 'frontera.pilot-acknowledgement.v1', organizationId: ORGANIZATION_ID, release: { commit: drill.release.commit }, documents: ['shared-responsibility', 'security-posture', 'known-limits'], acknowledgedBy: people.map((role) => ({ name: `${role} (drill)`, role, acknowledgedAt: new Date().toISOString() })) });
      return path;
    };
    // The pilot owner's acknowledgement, not anyone's (independent review P2-3).
    const byObserver = readiness(['--preflight', '--backup', state.finalBackup, '--restore-report', restoreReport, '--acknowledgement', acknowledgement('acknowledgement-observer', ['observer', 'contractor'])]);
    assert.equal(check(byObserver, 'PR-18').reason, 'ACKNOWLEDGEMENT_NOT_BY_PILOT_OWNER', byObserver.raw);
    assert.notEqual(byObserver.result, 'pilot-ready');
    // PR-15 judges the backup by PROD-02's registry against THIS deployment, not by the manifest's claim: a consistent
    // forgery of the real backup that omits a required store, records it as not required, lies about the source
    // deployment and still says complete is refused (independent review P1-3).
    const forgedBackup = join(state.backupDir, 'forged-incomplete');
    cpSync(state.finalBackup, forgedBackup, { recursive: true });
    const forgedManifest = JSON.parse(readFileSync(join(forgedBackup, 'backup-manifest.json'), 'utf8'));
    const dropped = forgedManifest.stores.find((store) => store.name === 'approvals');
    forgedManifest.stores = forgedManifest.stores.filter((store) => store.name !== 'approvals');
    Object.assign(forgedManifest.coverage.stores.find((store) => store.name === 'approvals'), { required: false, included: false, present: false, status: 'not-configured' });
    forgedManifest.coverage.deployment.approvalsDeclared = false;
    unlinkSync(join(forgedBackup, 'stores', dropped.filename));
    writeJson(join(forgedBackup, 'backup-manifest.json'), forgedManifest);
    const listed = readFileSync(join(forgedBackup, 'checksums.sha256'), 'utf8').split('\n').filter((line) => line.trim() !== '' && !line.endsWith(`stores/${dropped.filename}`));
    writeFileSync(join(forgedBackup, 'checksums.sha256'), `${listed.map((line) => { const file = line.slice(66); return `${createHash('sha256').update(readFileSync(join(forgedBackup, file))).digest('hex')}  ${file}`; }).join('\n')}\n`);
    assert.equal(forgedManifest.coverage.complete, true, 'the forgery claims completeness');
    const forged = readiness(['--preflight', '--backup', forgedBackup]);
    assert.equal(check(forged, 'PR-15').reason, 'BACKUP_INCOMPLETE', forged.raw);
    assert.match(check(forged, 'PR-15').detail, /approvals/);

    state.acknowledgement = acknowledgement('acknowledgement', ['pilot-owner', 'organization-administrator']);
    state.record = join(state.configDir, 'qualification-record.json');
    const gate = readiness(['--preflight', '--require-profile', 'deploy-staging', '--require-profile', 'deploy-production', '--require-approvals', '--backup', state.finalBackup, '--restore-report', restoreReport, '--acknowledgement', state.acknowledgement, '--write-record', state.record]);
    assert.equal(gate.result, 'pilot-ready', gate.raw);
    assert.match(check(gate, 'PR-15').detail, /required store\(s\) covered \(PROD-02 registry\)/, gate.raw);
    assert.equal(gate.exitStatus, 0);
    assert.equal(statSync(state.record).mode & 0o777, 0o600, 'the record is private');
    // The record satisfies only the historical checks, and only while the deployment is unchanged.
    const fromRecord = readiness(['--preflight', '--require-profile', 'deploy-staging', '--record', state.record]);
    assert.equal(fromRecord.result, 'pilot-ready', fromRecord.raw);
    assert.equal(check(fromRecord, 'PR-16').source, 'qualification-record');
    assert.equal(fromRecord.record.status, 'valid');
    assert.equal((await govern(deploy(STAGING, 1, 'after-restore'))).body.status, 'executed');
    drill.phases.I = { restore: 'restored', traces: 'identical digests, verified', replayedEffects: 0, acknowledgementByObserver: 'PR-18 ACKNOWLEDGEMENT_NOT_BY_PILOT_OWNER', forgedIncompleteBackup: `PR-15 BACKUP_INCOMPLETE (${dropped.filename} omitted, coverage.complete=true)`, backup: check(gate, 'PR-15').detail, readiness: gate.result, record: 'written (0600), re-used valid' };
  });

  it('Stale restore — the early backup restored into a fresh directory against the surviving witness: refused before any authority is served, with a value-free reason; the live deployment is unaffected', async () => {
    const effectsBefore = await effects();
    const staleDir = ws.dir('stale-state');
    const staleEnv = hostEnvironment({ stateDir: staleDir, governedActionsFile: state.governedActionsFile, witnessUrl: `http://127.0.0.1:${state.witnessPort}`, secrets: { ...state.secrets, AOC_ENTERPRISE_API_KEYS: `${state.secrets.FRONTERA_AUDITOR_EVIDENCE_KEY}:${ORGANIZATION_ID}` }, extra: { FRONTERA_DRILL_STAGE: state.stage, FRONTERA_DRILL_TARGET_URL: state.targetUrl } });
    const restored = runCli(join(state.stage, 'scripts/portability/restore-enterprise-v1.mjs'), ['--backup', state.earlyBackup, '--target', staleDir], staleEnv, { cwd: state.stage });
    assert.equal(restored.status, 0, 'the restore tool itself accepts an authentic older backup; freshness is the witness\'s question');
    const refusal = await expectRefusal(staleEnv, /AUTHORITY_FRESHNESS_[A-Z_]+/);
    assert.match(refusal.line, /AUTHORITY_FRESHNESS_(ROLLBACK_DETECTED|FORK_DETECTED)/);
    assertNoSecretIn(refusal.lines.join('\n'), 'the refusal output');
    assert.equal(await effects(), effectsBefore, 'zero effects');
    expectStatus(await http(state.url, 'GET', '/ready'), 200, 'the live deployment is unaffected');
    drill.phases.staleRestore = { refused: /AUTHORITY_FRESHNESS_[A-Z_]+/.exec(refusal.line)[0], effects: 0 };
  });

  it('Handoff — a second operator team, added by a supported configuration change, operates the pilot with ONLY the onboarding runbook, its credentials and the deployment configuration: every documented block runs as written', async () => {
    // Operator onboarding is configuration: two operators added to the file, their credentials from the generator, a restart.
    const file = JSON.parse(readFileSync(state.governedActionsFile, 'utf8'));
    file.operators.push({ operatorId: 'ops-provisioner-2', role: 'provisioner', apiKeyEnv: 'FRONTERA_OPERATOR_KEY_PROVISIONER_2' }, { operatorId: 'ops-approver-2', role: 'approver', apiKeyEnv: 'FRONTERA_OPERATOR_KEY_APPROVER_2' });
    writeFileSync(state.governedActionsFile, `${JSON.stringify(file, null, 2)}\n`);
    Object.assign(state.secrets, generateSecrets(state.stage, join(state.witnessDir, 'receipt-key.pem'), ['FRONTERA_OPERATOR_KEY_PROVISIONER_2', 'FRONTERA_OPERATOR_KEY_APPROVER_2'], { secretsOnly: true }));
    await stopHost();
    assert.equal(runCli(join(state.stage, 'scripts/check-host-configuration.mjs'), [], envFor(), { cwd: state.stage }).status, 0);
    await startHost();
    // A material change: the qualification record no longer holds.
    const stale = readiness(['--preflight', '--record', state.record]);
    assert.equal(stale.record.status, 'invalidated', stale.raw);
    assert.ok(stale.record.changed.includes('governedActionsFile') || stale.record.changed.includes('configurationChecksum'), stale.record.changed.join(','));

    const blocks = drillBlocks(readFileSync(join(REPO, DRILL_RUNBOOK), 'utf8'));
    assert.deepEqual([...blocks.keys()].sort(), [...DRILL_EXECUTED_BLOCKS].sort(), 'the runbook carries exactly the blocks this phase executes');
    const work = ws.dir('handoff-work');
    const secretDir = join(work, 'secret');
    const header = (name) => `Authorization: Bearer ${state.secrets[name]}`;
    const operatorEnv = {
      PATH: process.env.PATH,
      HOME: work,
      WORK: work,
      SECRET_DIR: secretDir,
      ADMIN: header(OPERATOR_ENVS.admin),
      STEWARD: header(OPERATOR_ENVS.steward),
      RESPONDER: header(OPERATOR_ENVS.responder),
      OBSERVER: header(OPERATOR_ENVS.observer),
      PROVISIONER: header('FRONTERA_OPERATOR_KEY_PROVISIONER_2'),
      APPROVER: header('FRONTERA_OPERATOR_KEY_APPROVER_2'),
      ORG_ISSUER: ISSUER,
      TRUST_DOMAIN,
      ORG_NAME: 'Pilot Organization',
    };
    const port = new URL(state.url).port;
    const executed = new Set();
    const run = (id, variables = {}) => {
      const source = blocks.get(id).replaceAll('127.0.0.1:8787', `127.0.0.1:${port}`);
      executed.add(id);
      const result = runBlock(source, { ...operatorEnv, ...variables }, { cwd: work });
      assert.equal(result.status, 0, `${id}: ${result.stderr}${result.stdout}`);
      return result.stdout;
    };
    const lastStatus = (out) => Number(out.trim().split('\n').pop());
    const bodyOf = (out) => JSON.parse(out.trim().split('\n').slice(0, -1).join('\n') || '{}');
    const ok = (out, where) => {
      assert.equal(lastStatus(out), 200, `${where}: ${out}`);
      return bodyOf(out);
    };
    const readJsonFile = (name) => JSON.parse(readFileSync(join(work, name), 'utf8'));

    // §4 bootstrap: the organization exists — the documented blocks are safe to run again (the same record, nothing written).
    for (const id of ['org-actor', 'org-trust-domain', 'org-root-issuer']) assert.equal(ok(run(id), id).outcome, 'replayed', id);
    // §5 profiles: list, then activate as the steward reads the listing (already active: refused or the same record).
    assert.equal(lastStatus(run('profile-list')), 200);
    for (const profile of readJsonFile('profiles.json').profiles) {
      const out = run('profile-activate', { PROFILE_ID: profile.profileId, PROFILE_VERSION: String(profile.version), PROFILE_DIGEST: profile.digest });
      assert.ok([200, 409].includes(lastStatus(out)), out);
      assert.equal(readJsonFile('profiles.json').profiles.find((entry) => entry.profileId === profile.profileId).state, 'active');
    }
    // §6 agent onboarding, §6.1 one-time credential delivery.
    const agent = { OWNER_ID: 'actor-handoff-owner', OWNER_NAME: 'Handoff owner', AGENT_ID: 'actor-handoff-agent', AGENT_NAME: 'Handoff agent', AGENT_SYSTEM: 'pilot-ci', AGENT_SUBJECT: 'handoff-agent-1' };
    assert.equal(ok(run('agent-owner', agent), 'agent-owner').entity.provisionedBy, 'operator:ops-provisioner-2');
    ok(run('agent-actor', agent), 'agent-actor');
    assert.equal(lastStatus(run('agent-credential', agent)), 200);
    assert.match(run('agent-credential-deliver', agent), /credential header ready for delivery/);
    assert.equal(existsSync(join(secretDir, 'actor-handoff-agent.issued.json')), false, 'the issuing response is deleted');
    assert.equal(statSync(join(secretDir, 'actor-handoff-agent.header')).mode & 0o777, 0o600);
    const handoffCredential = /Bearer (\S+)/.exec(readFileSync(join(secretDir, 'actor-handoff-agent.header'), 'utf8'))[1];
    state.issuedCredentials.push(handoffCredential);
    assert.deepEqual(ok(run('agent-inspect', agent), 'agent-inspect').onboarding, { actor: 'active', credential: 'active', standingAuthority: 'none' });
    // §7 bounded authority, §8.1 approver standing.
    const authority = { ...agent, GRANT_ID: 'authority-handoff-owner', DELEGATION_ID: 'delegation-handoff-agent', RESOURCES: '"staging-cluster","production-cluster"', BOUNDS: JSON.stringify(BOUNDS) };
    for (const id of ['authority-owner-grant', 'authority-passport', 'authority-capability', 'authority-delegation']) ok(run(id, authority), id);
    const approverVars = { ...authority, APPROVER_OPERATOR_ID: 'ops-approver-2', APPROVER_ACTION: APPROVE, APPROVAL_RESOURCES: '"production-cluster"' };
    for (const id of ['approver-actor', 'approver-standing']) ok(run(id, approverVars), id);

    // §9 the agent's request; §8.2 an approval and a rejection, decided by the second approver.
    const before = await effects();
    const request = (variables) => bodyOf(run('agent-request', { ...authority, ...variables }));
    assert.equal(request({ RESOURCE: STAGING, REPLICAS: '2', STRATEGY: 'rolling', REQUEST_KEY: 'handoff-staging-1' }).status, 'executed');
    assert.equal(request({ RESOURCE: STAGING, REPLICAS: '9', STRATEGY: 'rolling', REQUEST_KEY: 'handoff-over-1' }).status, 'withheld');
    const decide = (requestKey, verb) => {
      const pending = request({ RESOURCE: PRODUCTION, REPLICAS: '1', STRATEGY: 'rolling', REQUEST_KEY: requestKey });
      assert.equal(pending.withheldBy, 'approval', JSON.stringify(pending));
      assert.equal(lastStatus(run('approval-inbox', authority)), 200);
      const entry = readJsonFile('approvals.json').approvals.find((candidate) => candidate.requestId === pending.requestId);
      assert.ok(entry !== undefined, 'the approver finds the request in the inbox');
      assert.equal(lastStatus(run('approval-detail', { ...authority, APPROVAL_ID: entry.approvalRequestId })), 200);
      const detail = readJsonFile('approval.json');
      assert.equal(ok(run(`approval-${verb}`, { ...authority, APPROVAL_ID: entry.approvalRequestId, SUBJECT_DIGEST: detail.subjectDigest }), verb).outcome, 'recorded');
      return request({ RESOURCE: PRODUCTION, REPLICAS: '1', STRATEGY: 'rolling', REQUEST_KEY: requestKey });
    };
    const approved = decide('handoff-production-1', 'approve');
    assert.equal(approved.status, 'executed', JSON.stringify(approved));
    assert.notEqual(decide('handoff-production-2', 'reject').status, 'executed');
    assert.equal(await effects(), before + 2, 'staging once, the approved production deploy once; nothing else');

    // §10 evidence.
    assert.ok(ok(run('evidence-activity', authority), 'activity').decisions.some((decision) => decision.requestId === approved.requestId));
    assert.equal(lastStatus(run('evidence-trace', { ...authority, REQUEST_ID: approved.requestId })), 200);
    // §11 rotation, revocation, offboarding.
    const credentialId = ok(run('agent-inspect', agent), 'inspect').credentials.find((credential) => credential.status === 'active').credentialId;
    assert.equal(lastStatus(run('credential-rotate', { ...agent, CREDENTIAL_ID: credentialId })), 200);
    run('agent-credential-deliver', agent);
    state.issuedCredentials.push(/Bearer (\S+)/.exec(readFileSync(join(secretDir, 'actor-handoff-agent.header'), 'utf8'))[1]);
    assert.equal(request({ RESOURCE: STAGING, REPLICAS: '1', STRATEGY: 'rolling', REQUEST_KEY: 'handoff-rotated-1' }).status, 'executed');
    assert.equal(ok(run('revoke-delegation', authority), 'revoke').outcome, 'revoked');
    assert.notEqual(request({ RESOURCE: STAGING, REPLICAS: '1', STRATEGY: 'rolling', REQUEST_KEY: 'handoff-revoked-1' }).status, 'executed');
    const rotatedId = ok(run('agent-inspect', agent), 'inspect').credentials.find((credential) => credential.status === 'active').credentialId;
    assert.equal(ok(run('credential-revoke', { ...agent, CREDENTIAL_ID: rotatedId }), 'credential-revoke').outcome, 'revoked');
    assert.equal(ok(run('agent-offboard', agent), 'offboard').outcome, 'revoked');
    assert.equal(await effects(), before + 3, 'revoked and offboarded: nothing more reached the target');

    assert.deepEqual([...executed].sort(), [...DRILL_EXECUTED_BLOCKS].sort(), 'every documented block ran');
    // The second team's readiness view and backup, with the documented tools.
    assert.equal(readiness(['--preflight', '--require', 'organization']).levels.organization, 'ready');
    await stopHost();
    const backup = runCli(join(state.stage, 'scripts/portability/backup-enterprise-v1.mjs'), ['--cold', '--output', join(state.backupDir, 'handoff')], envFor(), { cwd: state.stage });
    assert.equal(backup.status, 0, backup.stderr);
    await startHost();
    for (const name of readdirSync(work)) if (name !== 'secret') assertNoSecretIn(readFileSync(join(work, name), 'utf8'), `handoff response ${name}`);
    drill.phases.handoff = { operatorsAdded: ['ops-provisioner-2', 'ops-approver-2'], record: 'invalidated by the configuration change', runbookBlocksExecuted: executed.size, effects: 3, backup: 'cold, by the second team' };
  });

  it('Phase J — incidents: witness outage (detected, anchored mutations refused with nothing written, recovers without any reset); target outage (nothing performed); an unconfirmed effect established at the target and resolved by an operator — never sent again', async () => {
    // 1. Witness outage.
    const grantOf = async (requestId) => {
      const decision = (await api('GET', `/api/admin/activity/decisions?requestId=${encodeURIComponent(requestId)}`, 'observer')).body.decisions[0];
      const evidence = (await api('GET', `/api/admin/evidence/decisions/${encodeURIComponent(decision.evaluationId)}`, 'observer')).body;
      return evidence.references.find((reference) => reference.referenceType === 'authorization_artifact').externalId;
    };
    const grantId = await grantOf(state.requests.first);
    assert.equal(await stopProcess(state.witness), 0);
    const anchored = await api('POST', `/api/admin/authority/grants/${encodeURIComponent(grantId)}/revoke`, 'responder', { reason: 'security-incident' });
    assert.equal(anchored.status, 503, anchored.text);
    assert.equal(anchored.body.error?.recorded, false, 'nothing written');
    let health;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      health = (await http(state.url, 'GET', '/health')).body;
      if (health.authorityFreshness?.witness?.state === 'unavailable') break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    }
    assert.equal(health.authorityFreshness.witness.state, 'unavailable', JSON.stringify(health.authorityFreshness));
    assert.equal(health.status, 'degraded');
    expectStatus(await http(state.url, 'GET', '/live'), 200, '/live during the outage');
    const readyDuring = await http(state.url, 'GET', '/ready');
    const gateDuring = readiness(['--preflight', '--require', 'deployment']);
    assert.equal(gateDuring.result, 'not-ready', gateDuring.raw);
    assert.equal(check(gateDuring, 'PR-04').reason, 'WITNESS_UNAVAILABLE');
    const duringOutage = await govern(deploy(STAGING, 1, 'witness-outage'));
    await startWitness();
    for (let attempt = 0; attempt < 80; attempt += 1) {
      health = (await http(state.url, 'GET', '/health')).body;
      if (health.authorityFreshness?.witness?.state === 'ready' && health.status === 'healthy') break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    }
    if (health.authorityFreshness?.witness?.state !== 'ready') {
      // The supported operator command, submitted again once the witness is back (OPERATIONS_RUNBOOK §9).
      await api('POST', `/api/admin/authority/grants/${encodeURIComponent(grantId)}/revoke`, 'responder', { reason: 'security-incident' });
      health = (await http(state.url, 'GET', '/health')).body;
    }
    assert.equal(health.authorityFreshness.witness.state, 'ready', JSON.stringify(health.authorityFreshness));
    assert.equal(readiness(['--preflight', '--require', 'deployment']).levels.deployment, 'ready', 'recovered without any reset');
    drill.phases.J = { witnessOutage: { anchoredMutation: `${anchored.status} ${anchored.body.error?.code} recorded:false`, health: 'degraded', ready: readyDuring.status, gate: 'PR-04 WITNESS_UNAVAILABLE', governedActionDuringOutage: duringOutage.body.status ?? duringOutage.status, recovered: 'witness restarted on its own state; no reset or enrollment' } };

    // 2. Target outage: the adapter cannot reach it; nothing is performed; recorded as not completed.
    const before = await effects();
    assert.equal(await stopProcess(state.target), 0);
    const unreachable = await govern(deploy(STAGING, 1, 'target-down'));
    assert.notEqual(unreachable.body.status, 'executed', unreachable.text);
    await startTarget();
    assert.equal(await effects(), before + (duringOutage.body.status === 'executed' ? 0 : 0), 'the target performed nothing while down');
    drill.phases.J.targetOutage = { status: unreachable.body.status, reasonCodes: unreachable.body.reasonCodes ?? null, effects: 0 };

    // 3. Unconfirmed: the target performs the effect and never answers. The operator establishes the outcome AT THE TARGET
    // and records it; the agent's same request then answers from the record. Nothing is ever sent again.
    await setTargetMode(state.targetUrl, 'accept-then-hang');
    const hanging = deploy(STAGING, 1, 'unconfirmed');
    const unconfirmed = await govern(hanging);
    await setTargetMode(state.targetUrl, 'normal');
    assert.notEqual(unconfirmed.body.status, 'executed', unconfirmed.text);
    const afterHang = await targetEffects(state.targetUrl);
    assert.equal(afterHang.length, before + 1, 'the target did perform it once');
    const attention = expectStatus(await api('GET', '/api/admin/operations/attention?limit=50', 'observer'), 200, 'attention').body;
    const entries = attention.executions ?? attention.items ?? attention.attention ?? [];
    const entry = entries.find((candidate) => candidate.requestId === unconfirmed.body.requestId);
    assert.ok(entry !== undefined, `the unconfirmed execution is in Attention: ${JSON.stringify(attention).slice(0, 600)}`);
    assert.ok(afterHang.some((effect) => effect.executionId === entry.executionId), 'established out of band, at the target, by the execution id');
    const resolution = expectStatus(await api('POST', `/api/admin/operations/executions/${encodeURIComponent(entry.executionId)}/resolution`, 'admin', { resolution: 'confirmed-completed', observedOutcome: entry.outcome?.status ?? 'unconfirmed' }), 200, 'resolution');
    assert.equal(resolution.body.outcome, 'recorded');
    assert.equal(resolution.body.effect, 'resolution-recorded-no-action-performed');
    const same = await govern(hanging);
    assert.equal(same.body.status, 'executed', same.text);
    assert.equal(same.body.replayed, true);
    assert.equal(await effects(), before + 1, 'resolved, answered from the record: no second effect');
    assertVerified(await traceOf(unconfirmed.body.requestId), 'resolved unconfirmed execution');
    state.requests.resolved = unconfirmed.body.requestId;
    drill.phases.J.unconfirmed = { initial: unconfirmed.body.status, attention: entry.classification, resolution: 'confirmed-completed by organization-administrator', agentRepeat: 'answered from the record (replayed: true)', effects: 1 };
  });

  it('Store failures — a corrupt store and a missing anchored store (scratch restores of the backup), and an unwritable data directory: preflight fails or the Host refuses; nothing is served; the live deployment is unaffected', async () => {
    const scratch = (name) => {
      const dir = ws.dir(name);
      const env = hostEnvironment({ stateDir: dir, governedActionsFile: state.governedActionsFile, witnessUrl: `http://127.0.0.1:${state.witnessPort}`, secrets: state.secrets, extra: { FRONTERA_DRILL_STAGE: state.stage, FRONTERA_DRILL_TARGET_URL: state.targetUrl } });
      return { dir, env };
    };
    // Corrupt.
    const corrupt = scratch('corrupt-state');
    assert.equal(runCli(join(state.stage, 'scripts/portability/restore-enterprise-v1.mjs'), ['--backup', state.finalBackup, '--target', corrupt.dir], corrupt.env, { cwd: state.stage }).status, 0);
    const victim = join(corrupt.dir, 'kernel-authority.sqlite');
    const bytes = readFileSync(victim);
    bytes.fill(0x5a, 4096, Math.min(bytes.length, 4096 * 3));
    writeFileSync(victim, bytes);
    const corruptCheck = runCli(join(state.stage, 'scripts/check-host-configuration.mjs'), [], corrupt.env, { cwd: state.stage });
    assert.equal(corruptCheck.status, 1);
    assert.match(corruptCheck.stdout, /FAIL storage\s+\[STORAGE_UNAVAILABLE\]/);
    await expectRefusal(corrupt.env, /refused to start \[STORAGE_UNAVAILABLE\]/);
    // Missing anchored store.
    const missing = scratch('missing-state');
    assert.equal(runCli(join(state.stage, 'scripts/portability/restore-enterprise-v1.mjs'), ['--backup', state.finalBackup, '--target', missing.dir], missing.env, { cwd: state.stage }).status, 0);
    rmSync(join(missing.dir, 'approvals.sqlite'));
    const missingRefusal = await expectRefusal(missing.env, /refused to start/);
    assert.match(missingRefusal.line, /AUTHORITY_FRESHNESS_[A-Z_]+|HOST_NOT_HEALTHY|AUTHORITY_STATE/, missingRefusal.line);
    // Unwritable.
    let unwritable = 'skipped (running as root: permissions do not bind)';
    if (process.getuid?.() !== 0) {
      const ro = scratch('readonly-state');
      chmodSync(ro.dir, 0o500);
      const roCheck = runCli(join(state.stage, 'scripts/check-host-configuration.mjs'), [], ro.env, { cwd: state.stage });
      chmodSync(ro.dir, 0o700);
      assert.equal(roCheck.status, 1);
      assert.match(roCheck.stdout, /\[STORAGE_NOT_WRITABLE\]/);
      unwritable = 'preflight STORAGE_NOT_WRITABLE';
    }
    for (const output of [corruptCheck.stdout, missingRefusal.lines.join('\n')]) assertNoSecretIn(output, 'a failure report');
    const health = (await http(state.url, 'GET', '/health')).body;
    assert.equal(health.status, 'healthy', 'the live deployment is unaffected');
    assert.ok(health.authorityFreshness.stores.every((store) => store.status === 'ready'));
    drill.phases.storeFailures = { corrupt: 'preflight STORAGE_UNAVAILABLE; Host refused', missingAnchoredStore: /\[[A-Z_]+\]/.exec(missingRefusal.line)?.[0] ?? missingRefusal.line, unwritable };
  });

  it('Phase K — offboarding: credential and authority revoked, identity revoked; final evidence exported and verified; final backup; the agent can no longer act; everything stops cleanly', async () => {
    const before = await effects();
    // Same-agent readiness (independent review P1-1), on the real deployment, in the order offboarding happens to take:
    // the first agent keeps an active credential but loses its last active lineage; the second keeps its bounded
    // delegation but loses its credential. Credential and authority now live on DIFFERENT agents: no agent can submit
    // an authorized request, and the gate must not add the two halves together.
    assert.equal(check(readiness(['--preflight']), 'PR-11').status, 'pass', 'before the split, an agent with a credential holds bounded authority');
    expectStatus(await api('POST', '/api/admin/authority/entities/delegation-grant/delegation-release-agent-2/revoke', 'responder', { reason: 'pilot offboarding' }), 200, 'revoke the shadowed delegation');
    expectStatus(await api('POST', `/api/admin/agents/${AGENT_2}/credentials/${state.agentCredentialId}/revoke`, 'provisioner', { reason: 'pilot offboarding' }), 200, 'revoke credential');
    const split = readiness(['--preflight']);
    assert.equal(check(split, 'PR-10').status, 'pass', `${AGENT} still authenticates: ${split.raw}`);
    assert.equal(check(split, 'PR-11').reason, 'NO_STANDING_AUTHORITY', `authority and credential on different agents: ${split.raw}`);
    assert.equal((await govern(deploy(STAGING, 1, 'split-first'), state.firstCredential)).body.status, 'denied', 'the credential-holding agent has no authority');
    assert.equal((await govern(deploy(STAGING, 1, 'split-second'))).status, 401, 'the authority-holding agent cannot authenticate');
    assert.equal(await effects(), before, 'split: zero effect');
    expectStatus(await api('POST', `/api/admin/authority/entities/delegation-grant/delegation-release-agent-v2/revoke`, 'responder', { reason: 'pilot offboarding' }), 200, 'revoke delegation');
    expectStatus(await api('POST', `/api/admin/authority/entities/actor/${AGENT_2}/revoke`, 'responder', { reason: 'pilot offboarding' }), 200, 'revoke actor');
    // Every agent identity the pilot created is offboarded, including the one whose authority was revoked in Phase G.
    expectStatus(await api('POST', `/api/admin/agents/${AGENT}/credentials/${state.firstCredentialId}/revoke`, 'provisioner', { reason: 'pilot offboarding' }), 200, 'revoke first credential');
    expectStatus(await api('POST', `/api/admin/authority/entities/actor/${AGENT}/revoke`, 'responder', { reason: 'pilot offboarding' }), 200, 'revoke first actor');
    const inventory = (await api('GET', '/api/admin/agents', 'observer')).body.agents;
    assert.ok(inventory.every((agent) => agent.status === 'revoked'), 'no agent identity left active');
    assert.equal((await govern(deploy(STAGING, 1, 'offboarded'))).status, 401);
    assert.equal(await effects(), before, 'offboarded: zero effect');
    const gate = readiness(['--preflight']);
    assert.equal(gate.levels.organization, 'ready', gate.raw);
    assert.equal(check(gate, 'PR-10').reason, 'NO_PILOT_AGENT');

    // Final evidence export: every recorded request's trace, verified, into a private directory.
    const exportDir = ws.dir('final-evidence');
    for (const [name, requestId] of Object.entries(state.requests)) {
      const evidence = await traceOf(requestId);
      assertVerified(evidence, `final export ${name}`);
      writeJson(join(exportDir, `${name}.json`), evidence);
    }
    assert.equal(statSync(exportDir).mode & 0o777, 0o700);
    for (const name of readdirSync(exportDir)) assertNoSecretIn(readFileSync(join(exportDir, name), 'utf8'), `exported evidence ${name}`);

    await stopHost();
    const finalBackup = runCli(join(state.stage, 'scripts/portability/backup-enterprise-v1.mjs'), ['--cold', '--output', join(state.backupDir, 'offboarding')], envFor(), { cwd: state.stage });
    assert.equal(finalBackup.status, 0, finalBackup.stderr);
    for (const proc of [state.console, state.witness, state.target]) assert.equal(await stopProcess(proc), 0, `${proc.name} stops cleanly`);
    // Nothing anywhere leaked: every HTTP response, every process line.
    const allowed = state.issuedCredentials;
    for (const text of transcript) assertNoSecretIn(text, 'an HTTP response', allowed);
    for (const proc of [state.host, state.witness, state.target, state.console]) assertNoSecretIn(proc.lines.join('\n'), `${proc.name} output`);
    drill.phases.K = { sameAgentReadiness: 'credential on one agent, bounded authority on another: PR-10 pass, PR-11 NO_STANDING_AUTHORITY; both requests refused, 0 effect', revoked: ['delegation', 'credential', 'actor'], agent: '401, 0 effect', evidenceExported: Object.keys(state.requests).length, finalBackup: 'cold, complete', shutdown: 'all processes exit 0' };
    drill.effects.total = await (async () => {
      const proc = startProcess('target-final', join(FIXTURES, 'reference-target.mjs'), { PATH: process.env.PATH, FRONTERA_DRILL_TARGET_PORT: String(state.targetPort), FRONTERA_DRILL_TARGET_LOG: join(ws.root, 'target-effects.jsonl') });
      await waitForLine(proc, /reference-target listening/);
      const count = (await targetEffects(state.targetUrl)).length;
      await stopProcess(proc);
      return count;
    })();
  });
});
