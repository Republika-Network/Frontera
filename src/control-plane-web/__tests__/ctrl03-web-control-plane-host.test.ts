import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { bearer } from '../../enterprise/__tests__/ctrl02-host-fixture.js';
import {
  AGENT,
  AGENT_SUBJECT,
  bootQualification,
  call,
  CLUSTER,
  consoleLogLines,
  DEPLOY,
  ISSUER,
  logLines,
  OPERATOR_SECRETS,
  OWNER,
  revealedSecret,
  TRUST_DOMAIN,
  type Qualification,
} from './ctrl03-web-fixture.js';
import { Browser, formsOf, textOf, type PageView } from './web-browser.js';

/**
 * CTRL-03 — THE CANONICAL WEB CONTROL-PLANE QUALIFICATION.
 *
 * An identified CTRL-02 operator, using only the shipped web control plane
 * (HTML pages and forms; no script, no API construction, no database, no
 * in-process helper), operates the shipped Frontera Host from a clean store:
 * bootstrap, profile promotion, agent onboarding, a one-time credential,
 * bounded standing authority with a typed `replicaCount ≤ 3`, re-read
 * canonical state, revocation. Between those steps the agent — the only
 * actor not using the console — calls the Host's real governed-action API
 * with the credential the console revealed, and the recording adapter counts
 * what actually executed.
 */

let q: Qualification;
const admin = (): Browser => browsers.admin;
const browsers: Record<'admin' | 'steward' | 'provisioner' | 'observer', Browser> = {} as never;

before(async () => {
  q = await bootQualification();
  browsers.admin = q.browser('admin');
  browsers.steward = q.browser('steward');
  browsers.provisioner = q.browser('provisioner');
  browsers.observer = q.browser('observer');
});
after(() => q.close());

let deploySequence = 0;
async function govern(credential: string, replicaCount: number): Promise<Record<string, unknown>> {
  deploySequence += 1;
  const reply = await call(q.host.baseUrl, 'POST', '/api/governed-actions', {
    authorization: bearer(credential),
    body: { action: DEPLOY, resource: CLUSTER, parameters: { replicaCount, deploymentStrategy: 'rolling' }, idempotencyKey: `ctrl03-web-${process.pid}-${deploySequence}` },
  });
  return { httpStatus: reply.status, ...reply.body };
}

const formAt = (action: string) => (form: { readonly action: string }) => form.action === action;

async function provisionVia(browser: Browser, path: string, action: string, values: Record<string, string>): Promise<PageView> {
  const form = await browser.get(path);
  assert.equal(form.status, 200, textOf(form.html).slice(0, 400));
  const result = await browser.submit(form, formAt(action), values);
  assert.equal(result.status, 200, `${path}: ${textOf(result.html).slice(0, 800)}`);
  assert.match(result.html, /: (provisioned|replayed)\. The canonical record was re-read from the Host below\./);
  return result;
}

let secret = '';
let grantId = '';
const evaluations: Record<string, string> = {};

describe('CTRL-03 canonical web qualification — the Frontera web control plane operates the real Host', () => {
  it('1–3: an operator signs in, sees the server-derived organization and operator context, and the clean inventory', async () => {
    const overview = await admin().signIn(OPERATOR_SECRETS.administrator);
    assert.equal(overview.status, 200);
    const truth = await q.truth('/api/admin/organization');
    const text = textOf(overview.html);
    assert.ok(text.includes(`Organization ${String((truth.body['organization'] as Record<string, unknown>)['organizationId'])}`), 'the organization the Host serves is shown');
    assert.ok(text.includes('Operator ops-admin (organization-administrator)'), 'the operator identity and role are the Host’s');
    assert.ok(text.includes('authority.bootstrap'), 'the permission list is the Host’s answer for this operator');
    const agents = await admin().get('/agents');
    assert.ok(textOf(agents.html).includes('No agent actor is provisioned in this organization.'));
    assert.deepEqual((await q.truth('/api/admin/agents')).body['agents'], []);
    assert.deepEqual((await q.truth('/api/admin/authority/entities')).body['entities'], [], 'the store is clean');
  });

  it('bootstrap: the organization administrator provisions the issuer, trust domain and root issuer through the web forms', async () => {
    await provisionVia(admin(), '/authority/new/actor', '/authority/new/actor', { actorId: ISSUER, type: 'organization', displayName: 'Pilot Organization', trustDomainId: '' });
    await provisionVia(admin(), '/authority/new/trust-domain', '/authority/new/trust-domain', {
      trustDomainId: TRUST_DOMAIN,
      name: 'Pilot Trust Domain',
      issuerActorId: ISSUER,
      acceptedIssuerIds: ISSUER,
      acceptedActorTypes: 'human\norganization\nagent',
    });
    await provisionVia(admin(), '/authority/new/root-issuer', '/authority/new/root-issuer', { actorId: ISSUER });
    const entities = (await q.truth('/api/admin/authority/entities')).body['entities'] as { entityKind: string; provisionedBy: string }[];
    assert.deepEqual(entities.map((entity) => entity.entityKind).sort(), ['actor', 'root-issuer', 'trust-domain']);
    for (const entity of entities) assert.equal(entity.provisionedBy, 'operator:ops-admin', 'every write names the signed-in operator, from the Host');
  });

  it('a profile steward activates the deploy-production catalog version — a permitting operation, deliberately confirmed, at the reviewed digest', async () => {
    await browsers.steward.signIn(OPERATOR_SECRETS.steward);
    const profiles = await browsers.steward.get('/profiles');
    assert.ok(profiles.html.includes('href="/profiles/deploy-production/1/activate"'), 'the steward is offered activation');
    const confirm = await browsers.steward.get('/profiles/deploy-production/1/activate');
    assert.ok(textOf(confirm.html).includes('Activation is a permitting governance operation. It is not harmless'));
    const catalog = (await q.truth('/api/admin/governance-profiles')).body['profiles'] as { digest: string; state: string }[];
    assert.equal(Browser.hidden(confirm, 'digest'), catalog[0]?.digest, 'the compare-and-set digest is the catalog content the Host reports');
    const unconfirmed = await browsers.steward.submit(confirm, formAt('/profiles/deploy-production/1/activate'));
    assert.equal(unconfirmed.status, 200, 'without explicit confirmation nothing is sent');
    assert.equal(((await q.truth('/api/admin/governance-profiles')).body['profiles'] as { state: string }[])[0]?.state, 'draft');
    const done = await browsers.steward.submit(confirm, formAt('/profiles/deploy-production/1/activate'), { confirm: 'yes', reason: 'pilot go-live' });
    assert.equal(done.status, 200);
    assert.ok(textOf(done.html).includes('Governance Profile deploy-production@1: activated'));
    const after = ((await q.truth('/api/admin/governance-profiles')).body['profiles'] as { state: string; activatedBy: string }[])[0];
    assert.equal(after?.state, 'active');
    assert.equal(after?.activatedBy, 'operator:ops-steward');
  });

  it('4: an identified provisioner onboards the agent through the web — the actor stage only, shown as such', async () => {
    await browsers.provisioner.signIn(OPERATOR_SECRETS.provisioner);
    await provisionVia(browsers.provisioner, '/authority/new/actor', '/authority/new/actor', { actorId: OWNER, type: 'human', displayName: 'Release Owner', issuerId: ISSUER });
    const onboard = await browsers.provisioner.get('/agents/new');
    const agentPage = await browsers.provisioner.submit(onboard, formAt('/agents'), {
      actorId: AGENT,
      displayName: 'Release Agent',
      issuerId: ISSUER,
      'externalSubject.system': AGENT_SUBJECT.system,
      'externalSubject.subjectId': AGENT_SUBJECT.subjectId,
    });
    assert.equal(agentPage.status, 200, textOf(agentPage.html).slice(0, 600));
    assert.equal(agentPage.url, `${q.consoleOrigin}/agents/${AGENT}`, 'after the write the canonical agent page is re-read');
    const stages = textOf(/data-testid="onboarding-stages"[\s\S]*?<\/ol>/.exec(agentPage.html)?.[0] ?? '');
    assert.ok(stages.includes('Actor provisioned: active'));
    assert.ok(stages.includes('Credential issued: none'));
    assert.ok(stages.includes('Standing authority assigned: none'), 'a partially onboarded agent is not shown as complete');
    const truth = (await q.truth(`/api/admin/agents/${AGENT}`)).body as { onboarding: Record<string, string> };
    assert.deepEqual(truth.onboarding, { actor: 'active', credential: 'none', standingAuthority: 'none' });
  });

  it('5–7: the credential is generated, its secret shown exactly once, and gone after dismissal, reload and replay', async () => {
    const agentPage = await browsers.provisioner.get(`/agents/${AGENT}`);
    const issueForm = formsOf(agentPage.html).find((form) => form.action === `/agents/${AGENT}/credentials`);
    assert.ok(issueForm !== undefined, 'the provisioner is offered credential issuance');
    const issued = await browsers.provisioner.submit(agentPage, formAt(`/agents/${AGENT}/credentials`));
    assert.equal(issued.status, 200);
    secret = revealedSecret(issued.html) ?? '';
    assert.match(secret, /^fra1\.agc-[0-9a-f]{32}\.[A-Za-z0-9_-]{43}$/);
    assert.equal(issued.html.split(secret).length - 1, 1, 'the secret appears exactly once in the issuing page');
    assert.ok(textOf(issued.html).includes('It is shown exactly once and cannot be recovered.'));
    assert.equal(issued.headers.get('cache-control'), 'no-store');
    // Dismiss, reload, revisit: never again.
    const dismissed = await browsers.provisioner.get(`/agents/${AGENT}`);
    assert.equal(dismissed.html.includes(secret), false);
    assert.equal((await browsers.provisioner.get(`/agents/${AGENT}`)).html.includes(secret), false);
    assert.equal((await browsers.provisioner.get('/agents')).html.includes(secret), false);
    // Re-submitting the same issuing form (a browser "resubmit") replays: no secret.
    const replay = await browsers.provisioner.submit(agentPage, formAt(`/agents/${AGENT}/credentials`));
    assert.equal(replay.status, 200);
    assert.equal(revealedSecret(replay.html), undefined);
    assert.ok(textOf(replay.html).includes('This request was already processed — the credential cannot be shown again.'));
    const truth = (await q.truth(`/api/admin/agents/${AGENT}`)).body as { credentials: { status: string }[] };
    assert.equal(truth.credentials.length, 1, 'the replay wrote nothing');
  });

  it('8: the provisioner assigns bounded standing authority — action, resource and a typed replicaCount ≤ 3 — through closed forms', async () => {
    await provisionVia(browsers.provisioner, `/authority/new/passport?subject=${AGENT}`, '/authority/new/passport', { passportId: 'passport-release-agent', issuerActorId: ISSUER });
    await provisionVia(browsers.provisioner, `/authority/new/capability-token?subject=${AGENT}`, '/authority/new/capability-token', {
      capabilityTokenId: 'cap-release-agent',
      principalActorId: OWNER,
      issuerActorId: OWNER,
      capability: 'release.execute',
      actions: DEPLOY,
      resourceScopes: CLUSTER,
      riskLevel: 'medium',
    });
    await provisionVia(browsers.provisioner, `/authority/new/authority-grant?subject=${OWNER}`, '/authority/new/authority-grant', {
      authorityGrantId: 'authority-release',
      issuerActorId: ISSUER,
      capability: 'release.manage',
      actions: DEPLOY,
      resourceScopes: CLUSTER,
      canDelegate: 'true',
      allowedDelegateActorTypes: 'agent',
      maxDelegationDepth: '1',
      'bound.0.dimension': 'deploymentStrategy',
      'bound.0.form': 'exact-token',
      'bound.0.value': 'rolling',
      'bound.1.dimension': 'replicaCount',
      'bound.1.form': 'maximum-integer',
      'bound.1.value': '3',
    });
    // The delegation form starts from the parent's own bounds — never a wider value.
    const delegationForm = await browsers.provisioner.get('/authority/new/delegation-grant?source=authority-release');
    const prefilled = formsOf(delegationForm.html).find(formAt('/authority/new/delegation-grant'));
    const field = (name: string): string | undefined => prefilled?.fields.find(([key]) => key === name)?.[1];
    assert.equal(field('sourceAuthorityGrantId'), 'authority-release');
    assert.equal(field('delegatorActorId'), OWNER);
    assert.deepEqual([field('bound.1.dimension'), field('bound.1.form'), field('bound.1.value')], ['replicaCount', 'maximum-integer', '3']);
    assert.ok(textOf(delegationForm.html).includes('A delegation may only narrow.'));
    const result = await browsers.provisioner.submit(delegationForm, formAt('/authority/new/delegation-grant'), {
      delegationGrantId: 'delegation-release-agent',
      delegateActorId: AGENT,
      delegateActorType: 'agent',
      capability: 'release.execute',
      canRedelegate: 'false',
    });
    assert.equal(result.status, 200, textOf(result.html).slice(0, 800));
    const recorded = (await q.truth('/api/admin/authority/entities?kind=delegation-grant')).body['entities'] as { terms: Record<string, unknown>; provisionedBy: string }[];
    assert.deepEqual(recorded[0]?.terms['parameterBounds'], [
      { dimension: 'deploymentStrategy', kind: 'exact', type: 'token', value: 'rolling' },
      { dimension: 'replicaCount', kind: 'maximum', type: 'integer', limit: 3 },
    ]);
    assert.equal(recorded[0]?.provisionedBy, 'operator:ops-provisioner');
  });

  it('9: after a server re-read the console shows the actor, credential metadata, standing authority and the typed bound', async () => {
    const page = await browsers.provisioner.get(`/agents/${AGENT}`);
    const text = textOf(page.html);
    const stages = textOf(/data-testid="onboarding-stages"[\s\S]*?<\/ol>/.exec(page.html)?.[0] ?? '');
    assert.ok(stages.includes('Actor provisioned: active') && stages.includes('Credential issued: active') && stages.includes('Standing authority assigned: assigned'));
    const truth = (await q.truth(`/api/admin/agents/${AGENT}`)).body as { credentials: { credentialId: string; status: string; createdBy: string }[] };
    const credential = truth.credentials[0];
    assert.ok(credential !== undefined);
    assert.ok(page.html.includes(`data-credential="${credential.credentialId}"`), 'the credential row is the Host’s credential');
    assert.ok(text.includes(credential.createdBy));
    assert.equal(page.html.includes(secret), false, 'credential metadata only');
    assert.ok(text.includes('delegation-release-agent') && text.includes('passport-release-agent') && text.includes('cap-release-agent'));
    const lineage = /data-testid="lineage"[\s\S]*?<\/table>/.exec(page.html)?.[0] ?? '';
    assert.ok(textOf(lineage).includes('replicaCount ≤ 3'), 'the lineage lists the typed bound on each hop');
    const entity = await browsers.provisioner.get('/authority/entities/delegation-grant/delegation-release-agent');
    const bounds = /data-testid="parameter-bounds"[\s\S]*?<\/table>/.exec(entity.html)?.[0] ?? '';
    const row = /<tr data-dimension="replicaCount">([\s\S]*?)<\/tr>/.exec(bounds)?.[1] ?? '';
    assert.equal(textOf(row), 'replicaCount integer maximum (inclusive) 3', 'dimension, type, bound and value — generic, as recorded');
  });

  it('10: the agent’s real credential on the governed-action API — replicaCount 2 executes, replicaCount 4 is withheld with zero adapter invocations', async () => {
    const two = await govern(secret, 2);
    assert.equal(two['status'], 'executed', JSON.stringify(two));
    assert.equal(q.host.adapter.calls.length, 1);
    assert.deepEqual(
      q.host.adapter.calls[0]?.parameters?.map((parameter) => [parameter.dimension, parameter.value]),
      [
        ['deploymentStrategy', 'rolling'],
        ['replicaCount', 2],
      ],
    );
    const four = await govern(secret, 4);
    assert.equal(four['status'], 'withheld', JSON.stringify(four));
    assert.equal(four['withheldBy'], 'authority-binding');
    assert.ok((four['reasonCodes'] as string[]).includes('PARAMETER_AUTHORITY_EXCEEDED'));
    assert.equal(q.host.adapter.calls.length, 1, 'no adapter invocation for the over-bound request');
    evaluations['two'] = String((two['decision'] as Record<string, unknown>)['evaluationId'] ?? '');
    evaluations['four'] = String((four['decision'] as Record<string, unknown>)['evaluationId'] ?? '');
  });

  it('14 (before revocation): activity and evidence show only what the Host recorded — the executed decision has a grant and an execution, the withheld one has neither', async () => {
    const activity = await browsers.observer.signIn(OPERATOR_SECRETS.observer).then(() => browsers.observer.get('/activity'));
    const truth = (await q.truth('/api/admin/activity/decisions')).body as { decisions: { evaluationId: string; status: string; evaluatedAt: string; actorId: string }[] };
    assert.equal(truth.decisions.length, 2);
    const table = /data-testid="decisions"[\s\S]*?<\/table>/.exec(activity.html)?.[0] ?? '';
    const rows = [...table.matchAll(/<tr data-evaluation="([^"]+)">([\s\S]*?)<\/tr>/g)];
    assert.deepEqual(
      rows.map((row) => row[1]),
      truth.decisions.map((decision) => decision.evaluationId),
      'exactly the Host’s decisions, in its order — no row without a canonical source',
    );
    for (const [index, decision] of truth.decisions.entries()) {
      const cells = textOf(rows[index]?.[2] ?? '');
      assert.ok(cells.includes(decision.evaluatedAt) && cells.includes(decision.actorId) && cells.includes(decision.status) && cells.includes(decision.evaluationId), cells);
    }
    const executed = await browsers.observer.get(`/evidence/decisions/${encodeURIComponent(evaluations['two'] ?? '')}`);
    const executedTruth = (await q.truth(`/api/admin/evidence/decisions/${encodeURIComponent(evaluations['two'] ?? '')}`)).body as { references: { referenceType: string; externalId: string }[]; verification: { valid: boolean } };
    assert.equal(executedTruth.verification.valid, true);
    assert.ok(textOf(executed.html).includes('Integrity verified by the Governance Store'));
    const grantReference = executedTruth.references.find((reference) => reference.referenceType === 'authorization_artifact');
    assert.ok(grantReference !== undefined);
    grantId = grantReference.externalId;
    assert.ok(executed.html.includes(`href="/authority/grants/${encodeURIComponent(grantId)}"`), 'the grant link is the recorded grant');
    const withheld = await browsers.observer.get(`/evidence/decisions/${encodeURIComponent(evaluations['four'] ?? '')}`);
    assert.ok(withheld.html.includes('data-testid="no-grant"'), 'no grant is fabricated for the withheld decision');
    assert.ok(withheld.html.includes('data-testid="no-execution"'));
    const grant = await browsers.observer.get(`/authority/grants/${encodeURIComponent(grantId)}`);
    const grantText = textOf(grant.html);
    assert.ok(grantText.includes('replicaCount integer maximum (inclusive) 2'), 'the signed grant is narrower than standing authority (2, not 3)');
  });

  it('11–13: the provisioner revokes the delegation through the web; canonical state is re-read; the agent can no longer execute', async () => {
    const entityPage = await browsers.provisioner.get('/authority/entities/delegation-grant/delegation-release-agent');
    assert.ok(entityPage.html.includes('href="/authority/entities/delegation-grant/delegation-release-agent/revoke"'));
    const confirm = await browsers.provisioner.get('/authority/entities/delegation-grant/delegation-release-agent/revoke');
    const confirmText = textOf(confirm.html);
    assert.match(confirmText, /Target type\s+Delegation grant/);
    assert.ok(confirmText.includes('delegation-grant:delegation-release-agent') && confirmText.includes('Current status ● active'));
    assert.ok(confirmText.includes('Revocation is terminal. There is no un-revoke.'));
    const revoked = await browsers.provisioner.submit(confirm, formAt('/authority/entities/delegation-grant/delegation-release-agent/revoke'), { confirm: 'yes', reason: 'release window closed' });
    assert.equal(revoked.status, 200);
    assert.equal(revoked.url, `${q.consoleOrigin}/authority/entities/delegation-grant/delegation-release-agent`, 're-read after the write');
    assert.ok(textOf(revoked.html).includes('Revoked — terminal.'));
    const truth = (await q.truth('/api/admin/authority/entities/delegation-grant/delegation-release-agent')).body as { status: string; revokedBy: string; revocationReason: string };
    assert.deepEqual([truth.status, truth.revokedBy, truth.revocationReason], ['revoked', 'operator:ops-provisioner', 'release window closed']);
    assert.equal(revoked.html.includes('/revoke"'), false, 'no revoke (and no un-revoke) is offered for revoked authority');
    const calls = q.host.adapter.calls.length;
    const after = await govern(secret, 2);
    assert.notEqual(after['status'], 'executed', JSON.stringify(after));
    assert.equal(q.host.adapter.calls.length, calls, 'no adapter invocation after revocation');
  });

  it('14: the lifecycle activity rows are exactly the recorded transitions, attributed to the operators who made them', async () => {
    const activity = await browsers.observer.get('/activity');
    const table = /data-testid="transitions"[\s\S]*?<\/table>/.exec(activity.html)?.[0] ?? '';
    const revokedRow = /<tr data-transition="kernel-authority-record:delegation-grant:delegation-release-agent:revoked"[^>]*>([\s\S]*?)<\/tr>/.exec(table)?.[1] ?? '';
    const truth = (await q.truth('/api/admin/authority/entities/delegation-grant/delegation-release-agent')).body as { revokedAt: string };
    assert.ok(textOf(revokedRow).includes(truth.revokedAt) && textOf(revokedRow).includes('operator:ops-provisioner') && textOf(revokedRow).includes('release window closed'), textOf(revokedRow));
    assert.ok(table.includes('data-transition="profile-lifecycle-record:governance-profile:deploy-production@1:profile-activated"'));
    assert.ok(table.includes('data-transition="agent-credential-record:agent-credential:'));
    const entities = (await q.truth('/api/admin/authority/entities')).body['entities'] as unknown[];
    const agents = (await q.truth('/api/admin/agents')).body['agents'] as { credentials: { status: string }[] }[];
    const expected = entities.length + 1 /* one revoked entity */ + agents.flatMap((agent) => agent.credentials).length + 1 /* one activation */;
    assert.equal([...table.matchAll(/\x3ctr data-transition=/g)].length, expected, 'one row per recorded transition — nothing invented, nothing dropped');
  });

  it('no secret in any response but the one reveal, any URL, any cookie, the console log or the Host log', () => {
    const everyBrowser = Object.values(browsers);
    const reveals = everyBrowser.flatMap((browser) => browser.transcript).filter((entry) => entry.body.includes(secret));
    assert.equal(reveals.length, 1, 'exactly one response ever carried the agent secret');
    for (const browser of everyBrowser) {
      for (const entry of browser.transcript) {
        for (const [name, value] of entry.headers) assert.equal(value.includes(secret), false, `${name} header`);
        assert.equal(entry.url.includes(secret), false, 'no URL');
        for (const operatorSecret of Object.values(OPERATOR_SECRETS)) {
          assert.equal(entry.body.includes(operatorSecret), false, 'no operator credential is ever rendered');
          for (const [, value] of entry.headers) assert.equal(value.includes(operatorSecret), false, 'no operator credential in a header (cookies included)');
        }
      }
      for (const url of browser.visited) assert.equal(url.includes(secret), false);
      for (const value of browser.cookies.values()) assert.equal(value.includes(secret), false);
    }
    for (const line of [...consoleLogLines, ...logLines]) {
      assert.equal(line.includes(secret), false, 'no log line carries the agent secret');
      for (const operatorSecret of Object.values(OPERATOR_SECRETS)) assert.equal(line.includes(operatorSecret), false, 'no log line carries an operator credential');
    }
  });
});
