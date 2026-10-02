import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  APPROVE_RELEASE,
  AUTH,
  CRITICAL,
  CTRL04_SECRETS,
  EVIDENCE_HASH,
  ISSUER,
  OTHER_EVIDENCE_HASH,
  PROD,
  assertAwaitingApproval,
  call,
  govern,
  provisionOrganization,
  release,
  releaseKey,
  type Organization,
  type Reply,
} from '../../enterprise/__tests__/ctrl04-host-fixture.js';
import { PRIVATE_KEY_LINE } from '../../enterprise/__tests__/ctrl02-host-fixture.js';
import { bootWebQualification, consoleLogLines, type WebQualification } from './ctrl04-web-fixture.js';
import { Browser, formsOf, textOf, type PageView } from './web-browser.js';

/**
 * CTRL-04 — THE CANONICAL WEB APPROVAL QUALIFICATION.
 *
 * Identified human operators, using only the shipped Frontera web control
 * plane (HTML pages and forms; no script, no API construction, no database, no
 * in-process helper), provision approver standing, find real pending approval
 * requests produced by real governed actions, inspect their canonical subject,
 * and approve / reject / request changes / escalate / revoke. The agent — the
 * only actor not using the console — retries its own governed action with the
 * credential an operator issued it; the recording adapter counts what actually
 * executed. Every UI-visibility claim is paired with a forged request proving
 * the Host refuses what the UI hides.
 */

let q: WebQualification;
let org: Organization;
const browsers: Record<'provisioner' | 'approverA' | 'approverB' | 'observer' | 'responder' | 'steward' | 'admin', Browser> = {} as never;

before(async () => {
  q = await bootWebQualification();
  org = await provisionOrganization(q.host.baseUrl, { primaryApproversElsewhere: true });
  browsers.provisioner = q.browser('provisioner');
  browsers.approverA = q.browser('approver-a');
  browsers.approverB = q.browser('approver-b');
  browsers.observer = q.browser('observer');
  browsers.responder = q.browser('responder');
  browsers.steward = q.browser('steward');
  browsers.admin = q.browser('admin');
  await browsers.provisioner.signIn(CTRL04_SECRETS.provisioner);
  await browsers.approverA.signIn(CTRL04_SECRETS.approverA);
  await browsers.approverB.signIn(CTRL04_SECRETS.approverB);
  await browsers.observer.signIn(CTRL04_SECRETS.observer);
  await browsers.responder.signIn(CTRL04_SECRETS.responder);
  await browsers.steward.signIn(CTRL04_SECRETS.steward);
  await browsers.admin.signIn(CTRL04_SECRETS.administrator);
});
after(() => q.close());

const formAt = (action: string) => (form: { readonly action: string }) => form.action === action;
const approvalUrl = (approvalRequestId: string): string => `/approvals/${encodeURIComponent(approvalRequestId)}`;

async function withheld(resource: string, credential: string = org.agentCredential): Promise<{ readonly key: string; readonly reply: Reply; readonly approvalRequestId: string }> {
  const key = releaseKey('ctrl04-web');
  const reply = await govern(q.host.baseUrl, credential, release(resource, key));
  assertAwaitingApproval(reply);
  const entries = (await q.truth('/api/admin/approvals?view=all')).body['approvals'] as Record<string, unknown>[];
  const entry = entries.find((candidate) => candidate['requestId'] === reply.body['requestId']);
  assert.ok(entry !== undefined);
  return { key, reply, approvalRequestId: entry['approvalRequestId'] as string };
}

async function truthOf(approvalRequestId: string): Promise<Record<string, unknown>> {
  const reply = await q.truth(`/api/admin/approvals/${encodeURIComponent(approvalRequestId)}`);
  assert.equal(reply.status, 200, reply.text);
  return reply.body;
}

/** Opens the verdict's confirmation page from the detail page's own link, fills it, confirms, submits. */
async function decide(browser: Browser, approvalRequestId: string, verb: string, values: Record<string, string> = {}): Promise<PageView> {
  const detailPage = await browser.get(approvalUrl(approvalRequestId));
  assert.equal(detailPage.status, 200, textOf(detailPage.html).slice(0, 400));
  const link = `${approvalUrl(approvalRequestId)}/${verb}`;
  assert.ok(detailPage.html.includes(`href="${link}"`), `the detail page links to ${verb}`);
  const confirm = await browser.get(link);
  assert.equal(confirm.status, 200, textOf(confirm.html).slice(0, 400));
  return browser.submit(confirm, formAt(link), { confirm: 'yes', ...values });
}

async function provisionVia(browser: Browser, path: string, action: string, values: Record<string, string>): Promise<void> {
  const form = await browser.get(path);
  assert.equal(form.status, 200, textOf(form.html).slice(0, 400));
  const result = await browser.submit(form, formAt(action), values);
  assert.equal(result.status, 200, `${path}: ${textOf(result.html).slice(0, 800)}`);
  assert.match(result.html, /: (provisioned|replayed)\. The canonical record was re-read from the Host below\./);
}

describe('CTRL-04 canonical web qualification — quorum 1', () => {
  it('a provisioner gives two human operators Kernel-Authority approval standing through the console (the identity bridge: operator:<operatorId>)', async () => {
    for (const operatorId of ['approver-a', 'approver-b']) {
      await provisionVia(browsers.provisioner, '/authority/new/actor', '/authority/new/actor', { actorId: `operator:${operatorId}`, type: 'human', displayName: `Approver ${operatorId}`, issuerId: ISSUER });
      await provisionVia(browsers.provisioner, `/authority/new/authority-grant?subject=${encodeURIComponent(`operator:${operatorId}`)}`, '/authority/new/authority-grant', {
        authorityGrantId: `approval-standing-${operatorId}`,
        issuerActorId: ISSUER,
        capability: `${APPROVE_RELEASE}.standing`,
        actions: APPROVE_RELEASE,
        resourceScopes: `${PROD}\n${CRITICAL}`,
        canDelegate: 'false',
        allowedDelegateActorTypes: 'human',
      });
    }
    const truth = await q.truth('/api/admin/authority/entities?kind=authority-grant');
    assert.ok((truth.body['entities'] as { entityId: string }[]).some((entity) => entity.entityId === 'approval-standing-approver-a'));
  });

  it('the agent’s real governed action is withheld; the human finds it in the inbox, inspects the exact subject, approves; nothing executes until the agent retries the SAME request — then exactly once', async () => {
    const callsBefore = q.host.adapter.calls.length;
    const { key, reply, approvalRequestId } = await withheld(PROD);
    assert.equal(q.host.adapter.calls.length, callsBefore);

    // Inbox: the pending request is listed, as the Host derived it.
    const inboxPage = await browsers.approverA.get('/approvals');
    assert.equal(inboxPage.status, 200);
    assert.ok(inboxPage.html.includes(`data-approval="${approvalRequestId}"`), 'the request is in the pending inbox');
    const row = new RegExp(`<tr data-approval="${approvalRequestId}">([\\s\\S]*?)</tr>`).exec(inboxPage.html)?.[1] ?? '';
    assert.ok(textOf(row).includes('pending'));
    assert.ok(textOf(row).includes('0 / 1'), 'quorum as derived: 0 / 1');

    // Detail: the exact canonical subject and the digest a verdict binds.
    const truth = await truthOf(approvalRequestId);
    const detailPage = await browsers.approverA.get(approvalUrl(approvalRequestId));
    const text = textOf(detailPage.html);
    for (const value of [truth['subjectDigest'], truth['decisionId'], (truth['subject'] as Record<string, unknown>)['evaluationId'], 'deploy-release', PROD, 'release-2026-10-01', APPROVE_RELEASE]) assert.ok(text.includes(String(value)), `the detail shows ${String(value)}`);
    assert.ok(detailPage.html.includes(truth['canonicalSubject'] as string) || textOf(detailPage.html).includes(textOf(truth['canonicalSubject'] as string)), 'the canonical subject bytes are shown');
    assert.equal(/Action executed/i.test(text), false);

    // Approve through the form the page rendered.
    const confirm = await browsers.approverA.get(`${approvalUrl(approvalRequestId)}/approve`);
    const form = formsOf(confirm.html).find(formAt(`${approvalUrl(approvalRequestId)}/approve`));
    assert.ok(form !== undefined);
    assert.deepEqual(form.fields.map(([name]) => name).sort(), ['csrf', 'reason', 'subjectDigest'], 'a closed verdict form: no actor, organization, state or quorum field');
    assert.equal(form.fields.find(([name]) => name === 'subjectDigest')?.[1], truth['subjectDigest'], 'the form binds the subject the page displays');
    const after = await browsers.approverA.submit(confirm, formAt(`${approvalUrl(approvalRequestId)}/approve`), { confirm: 'yes' });
    assert.equal(after.status, 200, textOf(after.html).slice(0, 600));
    const afterText = textOf(after.html);
    assert.ok(afterText.includes("Verdict 'approve' recorded by the Host. Status (derived, re-read): approved; quorum 1 / 1."), afterText.slice(0, 600));
    assert.ok(afterText.includes('Approval quorum satisfied — the action has not been executed'));
    assert.equal(/Action executed/i.test(afterText), false);
    // The page is the Host's re-read, not the console's memory of the POST.
    const settled = await truthOf(approvalRequestId);
    assert.equal(settled['status'], 'approved');
    assert.deepEqual((settled['quorum'] as Record<string, unknown>)['countedApprovers'], ['operator:approver-a']);
    assert.equal((settled['verdicts'] as Record<string, unknown>[])[0]?.['recordedBy'], 'frontera:operator-plane');
    assert.ok(afterText.includes(String(settled['approvalDigest'])));

    // The console executed nothing.
    assert.equal(q.host.adapter.calls.length, callsBefore, 'a human approval through the web is not an execution');
    // The original agent resumes its own request: the same committed decision executes exactly once.
    const resumed = await govern(q.host.baseUrl, org.agentCredential, release(PROD, key));
    assert.equal(resumed.body['status'], 'executed', resumed.text);
    assert.deepEqual(resumed.body['decision'], reply.body['decision']);
    await govern(q.host.baseUrl, org.agentCredential, release(PROD, key));
    assert.equal(q.host.adapter.calls.length, callsBefore + 1);

    // Activity re-reads the canonical decision; the approval moves to the approved view.
    const activity = await browsers.approverA.get('/activity');
    assert.ok(activity.html.includes((reply.body['decision'] as Record<string, string>)['evaluationId'] ?? 'missing'));
    const approvedView = await browsers.observer.get('/approvals?view=approved');
    assert.ok(approvedView.html.includes(`data-approval="${approvalRequestId}"`));
  });
});

describe('CTRL-04 canonical web qualification — quorum 2 with evidence', () => {
  it('missing evidence is refused by the Host; 1 / 2 executes nothing; the same human twice is refused; a second human completes 2 / 2; the agent resumes once', async () => {
    const callsBefore = q.host.adapter.calls.length;
    const { key, approvalRequestId } = await withheld(CRITICAL);
    const confirm = await browsers.approverA.get(`${approvalUrl(approvalRequestId)}/approve`);
    assert.ok(confirm.html.includes('name="evidence.0.hash"'), 'the form asks for the required evidence type');
    assert.ok(textOf(confirm.html).includes('source_document'));

    // The operator forgets the evidence: the console forwards it; the Host refuses.
    const missing = await decide(browsers.approverA, approvalRequestId, 'approve');
    assert.equal(missing.status, 409, textOf(missing.html).slice(0, 600));
    assert.ok(missing.html.includes('APPROVAL_EVIDENCE_INSUFFICIENT'));
    const malformed = await decide(browsers.approverA, approvalRequestId, 'approve', { 'evidence.0.hash': 'sha256:abc' });
    assert.equal(malformed.status, 400, textOf(malformed.html).slice(0, 600));
    assert.deepEqual((await truthOf(approvalRequestId))['verdicts'], []);

    const first = await decide(browsers.approverA, approvalRequestId, 'approve', { 'evidence.0.hash': EVIDENCE_HASH, 'evidence.0.uri': 'docs://change/9' });
    assert.equal(first.status, 200, textOf(first.html).slice(0, 600));
    assert.ok(textOf(first.html).includes('Status (derived, re-read): pending; quorum 1 / 2.'));
    assertAwaitingApproval(await govern(q.host.baseUrl, org.agentCredential, release(CRITICAL, key)));
    assert.equal(q.host.adapter.calls.length, callsBefore);

    const again = await decide(browsers.approverA, approvalRequestId, 'approve', { 'evidence.0.hash': OTHER_EVIDENCE_HASH });
    assert.equal(again.status, 409);
    assert.ok(again.html.includes('APPROVAL_DUPLICATE'));
    assert.deepEqual(((await truthOf(approvalRequestId))['quorum'] as Record<string, unknown>)['countedApprovers'], ['operator:approver-a']);

    const second = await decide(browsers.approverB, approvalRequestId, 'approve', { 'evidence.0.hash': OTHER_EVIDENCE_HASH });
    assert.equal(second.status, 200, textOf(second.html).slice(0, 600));
    assert.ok(textOf(second.html).includes('Status (derived, re-read): approved; quorum 2 / 2.'));
    assert.ok(textOf(second.html).includes(EVIDENCE_HASH) && textOf(second.html).includes('docs://change/9'), 'the recorded evidence references are shown');

    const resumed = await govern(q.host.baseUrl, org.agentCredential, release(CRITICAL, key));
    assert.equal(resumed.body['status'], 'executed', resumed.text);
    await govern(q.host.baseUrl, org.agentCredential, release(CRITICAL, key));
    assert.equal(q.host.adapter.calls.length, callsBefore + 1);
  });
});

describe('CTRL-04 web — stale pages, deliberate confirmation, restrictive verdicts', () => {
  it('a stale confirmation page never applies the old intent: the Host refuses it and the console re-reads the current state', async () => {
    const { approvalRequestId } = await withheld(PROD);
    const staleLink = `${approvalUrl(approvalRequestId)}/approve`;
    const stale = await browsers.approverA.get(staleLink);
    // Meanwhile another human rejects it.
    const rejected = await decide(browsers.approverB, approvalRequestId, 'reject', { reason: 'freeze window' });
    assert.ok(textOf(rejected.html).includes('Rejected — final'));
    const late = await browsers.approverA.submit(stale, formAt(staleLink), { confirm: 'yes' });
    assert.equal(late.status, 409);
    assert.ok(late.html.includes('APPROVAL_REJECTED'));
    assert.ok(textOf(late.html).includes('rejected'), 'the re-rendered page shows the current state');
    assert.equal((await truthOf(approvalRequestId))['status'], 'rejected');

    // A forged digest in the form is a substituted subject.
    const other = await withheld(PROD);
    await browsers.approverA.get(`${approvalUrl(other.approvalRequestId)}/approve`);
    const csrf = Browser.hidden(await browsers.approverA.get(`${approvalUrl(other.approvalRequestId)}/approve`), 'csrf');
    const forged = await browsers.approverA.post(`${approvalUrl(other.approvalRequestId)}/approve`, new URLSearchParams({ csrf, subjectDigest: `sha256:${'0'.repeat(64)}`, confirm: 'yes' }).toString());
    assert.equal(forged.status, 409);
    assert.ok(forged.html.includes('APPROVAL_SUBJECT_MISMATCH'));
    assert.deepEqual((await truthOf(other.approvalRequestId))['verdicts'], []);
  });

  it('no verdict without the explicit confirmation; a rejected request offers no further control and no undo', async () => {
    const { approvalRequestId } = await withheld(PROD);
    const link = `${approvalUrl(approvalRequestId)}/reject`;
    const confirm = await browsers.approverA.get(link);
    const unconfirmed = await browsers.approverA.submit(confirm, formAt(link), {});
    assert.equal(unconfirmed.status, 200);
    assert.ok(unconfirmed.html.includes('Rejection is final. There is no undo.'));
    assert.deepEqual((await truthOf(approvalRequestId))['verdicts'], [], 'nothing recorded without confirmation');
    await decide(browsers.approverA, approvalRequestId, 'reject');
    const page = await browsers.approverA.get(approvalUrl(approvalRequestId));
    assert.equal(/data-testid="approval-actions"/.test(page.html), false, 'a closed request offers no verdict control');
    assert.equal(/un-?reject|restore|reactivate|undo/i.test(formsOf(page.html).map((form) => form.action).join(' ')), false);
  });

  it('requesting changes is recorded and changes nothing; escalation is discoverable in the escalated view with its reference', async () => {
    const callsBefore = q.host.adapter.calls.length;
    const { key, approvalRequestId } = await withheld(PROD);
    const changes = await decide(browsers.approverA, approvalRequestId, 'request-changes', { reason: 'attach the rollback plan' });
    assert.ok(textOf(changes.html).includes('Changes were requested'));
    assert.ok(textOf(changes.html).includes('quorum 0 / 1'));
    const escalated = await decide(browsers.responder, approvalRequestId, 'escalate', { reason: 'CAB-77 release manager review' });
    assert.ok(textOf(escalated.html).includes('Status (derived, re-read): pending; quorum 0 / 1.'));
    const queue = await browsers.observer.get('/approvals?view=escalated');
    const row = new RegExp(`<tr data-approval="${approvalRequestId}">([\\s\\S]*?)</tr>`).exec(queue.html)?.[1] ?? '';
    assert.ok(textOf(row).includes('CAB-77 release manager review'), 'the observer finds the escalation and its reference without knowing the id');
    assert.ok(textOf(row).includes('operator:ops-responder'));
    assertAwaitingApproval(await govern(q.host.baseUrl, org.agentCredential, release(PROD, key)));
    assert.equal(q.host.adapter.calls.length, callsBefore);
  });

  it('revocation through the web withdraws an approval before the agent retries', async () => {
    const callsBefore = q.host.adapter.calls.length;
    const { key, approvalRequestId } = await withheld(PROD);
    await decide(browsers.approverA, approvalRequestId, 'approve');
    const revoked = await decide(browsers.approverB, approvalRequestId, 'revoke', { reason: 'wrong window' });
    assert.ok(textOf(revoked.html).includes('Approval revoked — final'));
    assertAwaitingApproval(await govern(q.host.baseUrl, org.agentCredential, release(PROD, key)), 'GOVERNED_ACTION_APPROVAL_REVOKED');
    assert.equal(q.host.adapter.calls.length, callsBefore);
  });
});

describe('CTRL-04 web — role visibility is UX; the Host decides every forged request', () => {
  const VERBS = ['approve', 'reject', 'request-changes', 'escalate', 'revoke'] as const;
  const SHOWN: Readonly<Record<string, readonly string[]>> = {
    observer: [],
    responder: ['reject', 'request-changes', 'escalate', 'revoke'],
    admin: [...VERBS],
    approverA: [...VERBS],
  };

  it('each role sees exactly the verdict links its Host-reported permissions allow — and every hidden verdict, forged, is refused by the Host', async () => {
    const { approvalRequestId } = await withheld(PROD);
    for (const [role, shown] of Object.entries(SHOWN)) {
      const browser = browsers[role as keyof typeof browsers];
      const page = await browser.get(approvalUrl(approvalRequestId));
      assert.equal(page.status, 200, `${role}: ${textOf(page.html).slice(0, 300)}`);
      for (const verb of VERBS) {
        const link = `href="${approvalUrl(approvalRequestId)}/${verb}"`;
        assert.equal(page.html.includes(link), shown.includes(verb), `${role} ${verb} link`);
        if (shown.includes(verb)) continue;
        // Forged: the hidden verdict, POSTed with a valid session and CSRF token.
        const csrf = Browser.hidden(page, 'csrf');
        const forged = await browser.post(`${approvalUrl(approvalRequestId)}/${verb}`, new URLSearchParams({ csrf, subjectDigest: String((await truthOf(approvalRequestId))['subjectDigest']), confirm: 'yes' }).toString());
        assert.equal(forged.status, 403, `${role} forged ${verb}: ${textOf(forged.html).slice(0, 300)}`);
        assert.ok(forged.html.includes('OPERATOR_PERMISSION_DENIED'), `${role} forged ${verb}`);
      }
    }
    for (const role of ['provisioner', 'steward'] as const) {
      const inbox = await browsers[role].get('/approvals');
      assert.equal(inbox.status, 403, `${role} has no approval.read`);
      const page = await browsers[role].get(approvalUrl(approvalRequestId));
      assert.equal(page.status, 403);
      assert.equal(page.html.includes('release-2026-10-01'), false, 'no subject content is disclosed without approval.read');
      const csrf = Browser.hidden(await browsers[role].get('/'), 'csrf');
      const forged = await browsers[role].post(`${approvalUrl(approvalRequestId)}/approve`, new URLSearchParams({ csrf, subjectDigest: `sha256:${'1'.repeat(64)}`, confirm: 'yes' }).toString());
      assert.equal(forged.status, 403);
    }
    assert.deepEqual((await truthOf(approvalRequestId))['verdicts'], [], 'no forged request recorded anything');
  });

  it('an approval verdict is CSRF- and origin-protected', async () => {
    const { approvalRequestId } = await withheld(PROD);
    const page = await browsers.approverA.get(`${approvalUrl(approvalRequestId)}/approve`);
    const csrf = Browser.hidden(page, 'csrf');
    const digest = String((await truthOf(approvalRequestId))['subjectDigest']);
    const body = (token: string) => new URLSearchParams({ csrf: token, subjectDigest: digest, confirm: 'yes' }).toString();
    const crossSite = await browsers.approverA.post(`${approvalUrl(approvalRequestId)}/approve`, body(csrf), { origin: 'https://attacker.example' });
    assert.equal(crossSite.status, 403);
    const nullOrigin = await browsers.approverA.post(`${approvalUrl(approvalRequestId)}/approve`, body(csrf), { origin: 'null' });
    assert.equal(nullOrigin.status, 403);
    const noToken = await browsers.approverA.post(`${approvalUrl(approvalRequestId)}/approve`, body('not-the-token'));
    assert.equal(noToken.status, 403);
    const anonymous = new Browser(q.consoleOrigin, 'anonymous');
    const unauthenticated = await anonymous.post(`${approvalUrl(approvalRequestId)}/approve`, body(csrf), { origin: q.consoleOrigin });
    // No session: redirected to sign-in, and no verdict is recorded (asserted below).
    assert.equal(unauthenticated.status, 200);
    assert.match(unauthenticated.url, /\/login\?reason=expired$/);
    assert.ok(unauthenticated.html.includes('name="credential"'));
    assert.deepEqual((await truthOf(approvalRequestId))['verdicts'], []);
  });
});

describe('CTRL-04 web — disclosure and browser security regression', () => {
  it('approval content is never in a URL, a redirect, a cookie or a console log line; pages are no-store under the no-script CSP', async () => {
    for (const browser of Object.values(browsers)) {
      for (const entry of browser.transcript) {
        for (const content of ['release-2026-10-01', 'CAB-77', 'freeze window', EVIDENCE_HASH, 'docs://change/9']) {
          assert.equal(entry.url.includes(encodeURIComponent(content)) || entry.url.includes(content), false, `${content} in URL ${entry.url}`);
          for (const [name, value] of entry.headers) {
            if (name === 'location' || name === 'set-cookie') assert.equal(value.includes(content), false, `${content} in ${name}`);
          }
        }
        for (const secret of [...Object.values(CTRL04_SECRETS), PRIVATE_KEY_LINE]) {
          if (entry.requestBody.includes(secret)) continue; // the sign-in form itself
          assert.equal(entry.body.includes(secret), false, `a secret in a response body (${entry.url})`);
        }
        if (entry.url.includes('/approvals')) {
          const headers = new Map(entry.headers);
          assert.match(headers.get('cache-control') ?? '', /no-store/);
          const csp = headers.get('content-security-policy') ?? '';
          assert.match(csp, /default-src 'none'/);
          assert.doesNotMatch(csp, /script-src/);
          assert.match(csp, /frame-ancestors 'none'/);
        }
      }
    }
    const approvalLogs = consoleLogLines.filter((line) => line.includes('/approvals'));
    assert.ok(approvalLogs.length > 0);
    for (const line of approvalLogs) {
      const route = (JSON.parse(line) as { route: string }).route;
      assert.match(route, /^\/approvals(\/:id(\/(approve|reject|request-changes|escalate|revoke))?)?$/, route);
    }
  });

  it('the console never calls the customer plane: an approval never becomes a governed action by the operator', async () => {
    // The agent's governed-action count equals the requests the agent itself sent; the console's operators sent none.
    const page = await q.truth('/api/admin/activity/decisions?limit=100');
    assert.equal(page.status, 200, page.text);
    const all = page.body['decisions'] as Record<string, unknown>[];
    assert.ok(all.length > 0);
    for (const decision of all) assert.ok(['actor-release-agent', 'operator:approver-self'].includes(decision['actorId'] as string), `decision by ${String(decision['actorId'])}`);
    const asAgent = await call(q.host.baseUrl, 'POST', '/api/governed-actions', { authorization: AUTH.approverA, body: release(PROD, releaseKey('ctrl04-web-operator')) });
    assert.equal(asAgent.status, 401);
  });
});
