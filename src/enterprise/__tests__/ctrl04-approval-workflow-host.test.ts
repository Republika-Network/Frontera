import { after, before, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

import Database from 'better-sqlite3';

import { grantSourceDigest, withGrantValidityCeiling } from '../../features/grant-runtime/index.js';
import type { KernelEvaluationRequest } from '../../kernel/index.js';
import { KernelGrantCapability, deriveGrantSourceAuthorization, withVerifiedHumanApproval } from '../../kernel/orchestration/grant-adapter.js';
import { approvalProofDigest, approvalRowDigest, type ApprovalRowContent } from '../approval-authority/index.js';
import { toKernelEvaluationResult } from '../governance-store/store-common.js';
import { storedGrant } from './core04-host-fixture.js';
import { logLines } from './ctrl02-host-fixture.js';
import {
  AGENT,
  AUTH,
  CRITICAL,
  EVIDENCE_HASH,
  GOVERNANCE,
  ORG,
  OTHER_EVIDENCE_HASH,
  PROD,
  QUORUM_1,
  SELF_AGENT,
  approvalFor,
  approvalPath,
  approvalsPath,
  assertAwaitingApproval,
  bootCtrl04,
  call,
  command,
  createWorkspace,
  ctrl04File,
  detail,
  errorCodeOf,
  failureOf,
  govern,
  inbox,
  provisionOrganization,
  quorumOf,
  release,
  releaseKey,
  type BootedCtrl04,
  type Organization,
  type Reply,
} from './ctrl04-host-fixture.js';

/**
 * CTRL-04 — the human approval workflow on the canonical shipped Host, over
 * HTTP only.
 *
 * Every approval command here is an identified operator's HTTP request to the
 * operator plane; every governed action is the agent's own HTTP request on the
 * customer plane with the credential an operator issued it; the recording
 * adapter counts what actually executed. No approval is constructed
 * in-process, and no database is written. (Two properties — the grant source's
 * binding of the approval digest, and the row digest's binding of evidence —
 * are additionally checked by a **read-only** look at the signed stores after
 * the flow.)
 */

const workspace = createWorkspace('frontera-ctrl04-host-');
after(() => workspace.close());

let booted: BootedCtrl04;
let org: Organization;

before(async () => {
  booted = await bootCtrl04(workspace);
  org = await provisionOrganization(booted.baseUrl);
});

const sha256 = (text: string): string => `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
const id = (approval: Record<string, unknown>): string => approval['approvalRequestId'] as string;
const digestOf = (approval: Record<string, unknown>): string => approval['subjectDigest'] as string;
const verdicts = (approval: Record<string, unknown>): readonly Record<string, unknown>[] => approval['verdicts'] as Record<string, unknown>[];

async function withheldRequest(resource: string, credential: string = org.agentCredential): Promise<{ readonly key: string; readonly reply: Reply; readonly approval: Record<string, unknown> }> {
  const key = releaseKey();
  const reply = await govern(booted.baseUrl, credential, release(resource, key));
  assertAwaitingApproval(reply);
  return { key, reply, approval: await approvalFor(booted.baseUrl, reply) };
}

function expectRefusal(reply: Reply, failure: string, where: string): void {
  assert.equal(reply.status, 409, `${where}: ${reply.text}`);
  assert.equal(errorCodeOf(reply), 'OPERATOR_OPERATION_REFUSED', where);
  assert.equal(failureOf(reply), failure, `${where}: ${reply.text}`);
  assert.equal((reply.body['error'] as Record<string, unknown>)['recorded'], false, where);
}

describe('CTRL-04 Host — quorum 1: a real pending request, a human approval over HTTP, the original agent resumes the same decision', () => {
  it('withheld → discoverable in the inbox → exact canonical subject → operator approves → nothing executes → the agent retries → executed exactly once under the same decision', async () => {
    const callsBefore = booted.adapter.calls.length;
    const key = releaseKey('ctrl04-q1');
    const first = await govern(booted.baseUrl, org.agentCredential, release(PROD, key));
    assertAwaitingApproval(first);
    const decision = first.body['decision'] as Record<string, unknown>;
    assert.equal(decision['status'], 'approval_required');
    assert.equal(booted.adapter.calls.length, callsBefore, 'nothing executes while withheld');

    // An observer finds it in the pending inbox without knowing any id.
    const pending = await inbox(booted.baseUrl, AUTH.observer);
    const entry = pending.find((candidate) => candidate['requestId'] === first.body['requestId']);
    assert.ok(entry !== undefined, 'the request is in the pending inbox');
    assert.equal(entry['status'], 'pending');
    assert.deepEqual(entry['quorum'], { minimumApprovals: 1, countedApprovers: [], satisfied: false });

    const view = await detail(booted.baseUrl, entry['approvalRequestId'] as string);
    // The exact canonical subject: its bytes hash to the digest every verdict binds.
    assert.equal(sha256(view['canonicalSubject'] as string), view['subjectDigest']);
    const subject = view['subject'] as Record<string, unknown>;
    assert.equal(subject['actorId'], AGENT);
    assert.equal(subject['action'], 'deploy-release');
    assert.equal(subject['resourceScope'], PROD);
    assert.equal(view['decisionId'], decision['decisionId']);
    assert.equal(subject['evaluationId'], decision['evaluationId']);
    assert.deepEqual(subject['parameters'], [{ dimension: 'releaseVersion', type: 'token', value: 'release-2026-10-01' }]);
    assert.deepEqual((subject['decision'] as Record<string, unknown>)['reasonCodes'], decision['reasonCodes']);
    assert.deepEqual(view['requirement'], { ...QUORUM_1, requiredEvidence: [], digest: (view['requirement'] as Record<string, unknown>)['digest'] });
    assert.match((view['requirement'] as Record<string, unknown>)['digest'] as string, /^sha256:[0-9a-f]{64}$/);
    assert.equal(view['requestExpiresAt'], new Date(Date.parse((subject['decision'] as Record<string, string>)['evaluatedAt'] ?? '') + 3600_000).toISOString());
    // Operator-safe DTO: no store internals, no signer material, no raw trusted context.
    for (const forbidden of ['storeId', 'sequence', 'signature', 'privateKey', 'chainDigest', 'recordedByContext', 'authenticated', 'state']) assert.equal(Object.prototype.hasOwnProperty.call(view, forbidden), false, forbidden);

    // The operator approves over HTTP. Who acts is derived from the credential.
    const approved = await command(booted.baseUrl, AUTH.approverA, id(view), 'approve', { subjectDigest: digestOf(view) });
    assert.equal(approved.status, 200, approved.text);
    assert.equal(approved.body['outcome'], 'recorded');
    const after = approved.body['approval'] as Record<string, unknown>;
    assert.equal(after['status'], 'approved');
    assert.deepEqual(quorumOf(after), { minimumApprovals: 1, countedApprovers: ['operator:approver-a'], satisfied: true });
    assert.deepEqual(
      verdicts(after).map((verdict) => [verdict['kind'], verdict['actorId'], verdict['recordedBy'], verdict['counted']]),
      [['approved', 'operator:approver-a', 'frontera:operator-plane', true]],
    );
    assert.match(after['approvalDigest'] as string, /^sha256:[0-9a-f]{64}$/);
    // The canonical re-read agrees with the command's answer.
    assert.deepEqual(await detail(booted.baseUrl, id(view)), after);
    // Approving executed nothing: the operator plane never performs the governed action.
    assert.equal(booted.adapter.calls.length, callsBefore, 'an approval is not an execution');

    // The original agent retries the same request: the same committed decision is resumed.
    const resumed = await govern(booted.baseUrl, org.agentCredential, release(PROD, key));
    assert.equal(resumed.body['status'], 'executed', resumed.text);
    assert.deepEqual(resumed.body['decision'], first.body['decision'], 'the committed decision was neither re-made nor rewritten');
    assert.equal(resumed.body['requestId'], first.body['requestId']);
    assert.equal(booted.adapter.calls.length, callsBefore + 1);
    assert.equal(booted.adapter.calls.at(-1)?.action, 'deploy-release');
    // Replay: exactly once.
    const replayed = await govern(booted.baseUrl, org.agentCredential, release(PROD, key));
    assert.equal(replayed.body['status'], 'executed');
    assert.equal(booted.adapter.calls.length, callsBefore + 1, 'the adapter ran exactly once');

    // One decision for this request; one approval request; the approval UI created no governed action.
    const decisions = await call(booted.baseUrl, 'GET', `/api/admin/activity/decisions?requestId=${encodeURIComponent(first.body['requestId'] as string)}`, { authorization: AUTH.observer });
    assert.equal((decisions.body['decisions'] as unknown[]).length, 1, decisions.text);
    assert.equal((await inbox(booted.baseUrl, AUTH.observer, 'all')).filter((candidate) => candidate['requestId'] === first.body['requestId']).length, 1);

    // The resumed grant's signed source binds the approval digest (read-only verification).
    const lookup = await call(booted.baseUrl, 'GET', `/api/admin/authority/executions/${encodeURIComponent(resumed.body['executionId'] as string)}`, { authorization: AUTH.observer });
    const grant = storedGrant(booted.dir, lookup.body['grantId'] as string);
    const record = await booted.host.enterprise.persistence.getByEvaluationId({ system: false, organizationId: ORG }, decision['evaluationId'] as string);
    assert.ok(record !== null);
    const committed = toKernelEvaluationResult(record);
    const projected = deriveGrantSourceAuthorization(new KernelGrantCapability({ declaration: {} }), record.request.requestPayload as unknown as KernelEvaluationRequest, committed);
    const source = withGrantValidityCeiling(withVerifiedHumanApproval(projected, committed, after['approvalDigest'] as string), { source: 'decision', notAfter: after['notAfter'] as string });
    assert.equal(grant.sourceDigest, grantSourceDigest(source), 'the grant source commits to the approval the human gave');
    const { approvalDigest: _withdrawn, ...withoutApproval } = source;
    assert.notEqual(grant.sourceDigest, grantSourceDigest(withoutApproval), 'the approval digest is material to the signed source bytes');
    assert.ok(Date.parse(grant.expiresAt) <= Date.parse(after['notAfter'] as string), 'the grant never outlives the approval');
  });
});

describe('CTRL-04 Host — quorum 2 with required evidence', () => {
  it('evidence is required and hashed; one approval is 1/2 and executes nothing; the same approver never counts twice; a second distinct approver completes it; the agent resumes once', async () => {
    const callsBefore = booted.adapter.calls.length;
    const { key, approval } = await withheldRequest(CRITICAL);
    assert.deepEqual((approval['requirement'] as Record<string, unknown>)['requiredEvidence'], ['source_document']);
    const base = { subjectDigest: digestOf(approval) };

    expectRefusal(await command(booted.baseUrl, AUTH.approverA, id(approval), 'approve', base), 'APPROVAL_EVIDENCE_INSUFFICIENT', 'missing required evidence');
    expectRefusal(await command(booted.baseUrl, AUTH.approverA, id(approval), 'approve', { ...base, evidence: [{ type: 'human_comment', hash: EVIDENCE_HASH }] }), 'APPROVAL_EVIDENCE_INSUFFICIENT', 'wrong evidence type');
    const malformed = await command(booted.baseUrl, AUTH.approverA, id(approval), 'approve', { ...base, evidence: [{ type: 'source_document', hash: 'sha256:not-a-hash' }] });
    assert.equal(malformed.status, 400, malformed.text);
    const upper = await command(booted.baseUrl, AUTH.approverA, id(approval), 'approve', { ...base, evidence: [{ type: 'source_document', hash: EVIDENCE_HASH.toUpperCase() }] });
    assert.equal(upper.status, 400, upper.text);
    assert.equal(verdicts(await detail(booted.baseUrl, id(approval))).length, 0, 'no refused command left a row');

    const first = await command(booted.baseUrl, AUTH.approverA, id(approval), 'approve', { ...base, evidence: [{ type: 'source_document', hash: EVIDENCE_HASH, uri: 'docs://change/1' }] });
    assert.equal(first.status, 200, first.text);
    const half = first.body['approval'] as Record<string, unknown>;
    assert.equal(half['status'], 'pending');
    assert.deepEqual(quorumOf(half), { minimumApprovals: 2, countedApprovers: ['operator:approver-a'], satisfied: false });
    assert.deepEqual(verdicts(half)[0]?.['evidence'], [{ type: 'source_document', hash: EVIDENCE_HASH, uri: 'docs://change/1' }]);
    assertAwaitingApproval(await govern(booted.baseUrl, org.agentCredential, release(CRITICAL, key)));
    assert.equal(booted.adapter.calls.length, callsBefore, 'one approval under quorum 2 executes nothing');

    expectRefusal(await command(booted.baseUrl, AUTH.approverA, id(approval), 'approve', { ...base, evidence: [{ type: 'source_document', hash: OTHER_EVIDENCE_HASH }] }), 'APPROVAL_DUPLICATE', 'the same approver again');
    assert.deepEqual(quorumOf(await detail(booted.baseUrl, id(approval))).countedApprovers, ['operator:approver-a'], 'a duplicate does not count');

    // No pooling: approver-a's approval of this request does not count toward another.
    const other = await withheldRequest(CRITICAL);
    assert.deepEqual(quorumOf(other.approval).countedApprovers, []);

    const second = await command(booted.baseUrl, AUTH.approverB, id(approval), 'approve', { ...base, evidence: [{ type: 'source_document', hash: OTHER_EVIDENCE_HASH }] });
    assert.equal(second.status, 200, second.text);
    const full = second.body['approval'] as Record<string, unknown>;
    assert.equal(full['status'], 'approved');
    assert.deepEqual(quorumOf(full), { minimumApprovals: 2, countedApprovers: ['operator:approver-a', 'operator:approver-b'], satisfied: true });
    assert.deepEqual(quorumOf(await detail(booted.baseUrl, id(other.approval))).countedApprovers, [], 'still no pooling');

    const resumed = await govern(booted.baseUrl, org.agentCredential, release(CRITICAL, key));
    assert.equal(resumed.body['status'], 'executed', resumed.text);
    await govern(booted.baseUrl, org.agentCredential, release(CRITICAL, key));
    assert.equal(booted.adapter.calls.length, callsBefore + 1);

    // The reviewed evidence is inside the bound approval identity: the counted rows' digests are what the
    // approval digest is taken over, and a row with a substituted evidence hash has another digest.
    const approvalDigest = full['approvalDigest'] as string;
    const counted = verdicts(full).filter((verdict) => verdict['counted'] === true);
    assert.equal(
      approvalProofDigest({
        organizationId: ORG,
        approvalRequestId: id(full),
        requestId: full['requestId'] as string,
        decisionId: full['decisionId'] as string,
        subjectDigest: digestOf(full),
        requirementDigest: (full['requirement'] as Record<string, string>)['digest'] ?? '',
        minimumApprovals: 2,
        approvers: quorumOf(full).countedApprovers,
        rowDigests: counted.map((verdict) => verdict['rowDigest'] as string),
        approvedAt: full['approvedAt'] as string,
        notAfter: full['notAfter'] as string,
      }),
      approvalDigest,
    );
    const db = new Database(join(booted.dir, 'approvals.sqlite'), { readonly: true });
    try {
      const storeId = (db.prepare('SELECT store_id FROM approval_store_meta').get() as { store_id: string }).store_id;
      const row = db.prepare("SELECT * FROM approval_records WHERE row_digest = ?").get(counted[0]?.['rowDigest']) as Record<string, string | number | null>;
      const content: ApprovalRowContent = {
        organizationId: row['organization_id'] as string,
        requestId: row['request_id'] as string,
        decisionId: row['decision_id'] as string,
        subjectDigest: row['subject_digest'] as string,
        kind: 'approved',
        actorId: row['actor_id'] as string,
        evidence: row['evidence'] as string,
        recordedBy: row['recorded_by'] as string,
        recordedAt: row['recorded_at'] as string,
      };
      assert.equal(approvalRowDigest(storeId, row['sequence'] as number, content), counted[0]?.['rowDigest']);
      assert.notEqual(approvalRowDigest(storeId, row['sequence'] as number, { ...content, evidence: (content.evidence ?? '').replace(EVIDENCE_HASH, OTHER_EVIDENCE_HASH) }), counted[0]?.['rowDigest'], 'changed evidence changes the bound approval identity');
    } finally {
      db.close();
    }
  });
});

describe('CTRL-04 Host — operator authentication and Kernel-Authority approval standing are two separate checks', () => {
  it('A: an operator who may reach approve but holds no Kernel-Authority standing is refused by CORE-05 — including an organization administrator', async () => {
    const { key, approval } = await withheldRequest(PROD);
    for (const [who, authorization] of [
      ['approver-nostanding', AUTH.approverNoStanding],
      ['organization-administrator (no standing)', AUTH.administrator],
    ] as const) {
      const reply = await command(booted.baseUrl, authorization, id(approval), 'approve', { subjectDigest: digestOf(approval) });
      expectRefusal(reply, 'APPROVAL_APPROVER_INELIGIBLE', who);
      assert.equal((reply.body['error'] as Record<string, unknown>)['reasonCode'], 'INVALID_APPROVER', `${who}: not a recognized Kernel-Authority approver`);
    }
    assertAwaitingApproval(await govern(booted.baseUrl, org.agentCredential, release(PROD, key)));
    assert.equal(verdicts(await detail(booted.baseUrl, id(approval))).length, 0);
  });

  it('wrong resource, wrong approver action, and execution authority without approval authority are all refused', async () => {
    const { approval } = await withheldRequest(PROD);
    for (const [who, authorization, reasonCode] of [
      ['standing over another resource', AUTH.approverC, 'APPROVAL_OUT_OF_SCOPE'],
      ['standing for another approver action', AUTH.approverD, 'APPROVER_AUTHORITY_MISSING'],
      ['authority to execute the governed action, none to approve it', AUTH.approverE, 'APPROVER_AUTHORITY_MISSING'],
    ] as const) {
      const reply = await command(booted.baseUrl, authorization, id(approval), 'approve', { subjectDigest: digestOf(approval) });
      expectRefusal(reply, 'APPROVAL_APPROVER_INELIGIBLE', who);
      assert.equal((reply.body['error'] as Record<string, unknown>)['reasonCode'], reasonCode, who);
    }
    assert.equal((await detail(booted.baseUrl, id(approval)))['status'], 'pending');
  });

  it('B: Kernel-Authority standing without operator-plane authentication never reaches the command', async () => {
    const { approval } = await withheldRequest(PROD);
    const path = `${approvalPath(id(approval))}/approve`;
    const body = { subjectDigest: digestOf(approval) };
    assert.equal((await call(booted.baseUrl, 'POST', path, { body })).status, 401, 'no credential');
    // The self-approval agent holds approval standing; its customer-plane credential is unknown on the operator plane.
    assert.equal((await call(booted.baseUrl, 'POST', path, { authorization: `Bearer ${org.selfCredential}`, body })).status, 401, 'an agent credential');
    assert.equal(verdicts(await detail(booted.baseUrl, id(approval))).length, 0);
  });

  it('restriction never implies expansion: a responder holding approval standing may reject but can never approve', async () => {
    const { approval } = await withheldRequest(PROD);
    const approve = await command(booted.baseUrl, AUTH.responder, id(approval), 'approve', { subjectDigest: digestOf(approval) });
    assert.equal(approve.status, 403, approve.text);
    assert.equal(errorCodeOf(approve), 'OPERATOR_PERMISSION_DENIED');
    const reject = await command(booted.baseUrl, AUTH.responder, id(approval), 'reject', { subjectDigest: digestOf(approval), reason: 'INC-7 release freeze' });
    assert.equal(reject.status, 200, reject.text);
    assert.equal((reject.body['approval'] as Record<string, unknown>)['status'], 'rejected');
  });

  it('segregation of duties: the requesting actor cannot approve its own request, even holding standing; another approver can', async () => {
    const { key, approval } = await withheldRequest(PROD, org.selfCredential);
    assert.equal((approval['subject'] as Record<string, unknown>)['actorId'], SELF_AGENT);
    expectRefusal(await command(booted.baseUrl, AUTH.approverSelf, id(approval), 'approve', { subjectDigest: digestOf(approval) }), 'APPROVAL_SEGREGATION_OF_DUTIES', 'self-approval');
    assertAwaitingApproval(await govern(booted.baseUrl, org.selfCredential, release(PROD, key)));
    const other = await command(booted.baseUrl, AUTH.approverA, id(approval), 'approve', { subjectDigest: digestOf(approval) });
    assert.equal(other.status, 200, other.text);
  });
});

describe('CTRL-04 Host — rejection, requested changes, escalation and revocation keep CORE-05 semantics', () => {
  it('rejection is final: later approvals are refused, retries do not execute, a second rejection is refused', async () => {
    const callsBefore = booted.adapter.calls.length;
    const { key, approval } = await withheldRequest(PROD);
    const rejected = await command(booted.baseUrl, AUTH.approverA, id(approval), 'reject', { subjectDigest: digestOf(approval), reason: 'not this release' });
    assert.equal(rejected.status, 200, rejected.text);
    const closed = rejected.body['approval'] as Record<string, unknown>;
    assert.equal(closed['status'], 'rejected');
    assert.equal(closed['closedBy'], 'operator:approver-a');
    assert.equal(verdicts(closed)[0]?.['reason'], 'not this release');
    expectRefusal(await command(booted.baseUrl, AUTH.approverB, id(approval), 'approve', { subjectDigest: digestOf(approval) }), 'APPROVAL_REJECTED', 'approve after reject');
    expectRefusal(await command(booted.baseUrl, AUTH.approverB, id(approval), 'reject', { subjectDigest: digestOf(approval) }), 'APPROVAL_REJECTED', 'reject twice');
    expectRefusal(await command(booted.baseUrl, AUTH.approverB, id(approval), 'revoke', { subjectDigest: digestOf(approval) }), 'APPROVAL_REJECTED', 'revoke a rejected request');
    assertAwaitingApproval(await govern(booted.baseUrl, org.agentCredential, release(PROD, key)), 'GOVERNED_ACTION_APPROVAL_REJECTED');
    assert.equal(booted.adapter.calls.length, callsBefore);
    assert.ok((await inbox(booted.baseUrl, AUTH.observer, 'rejected')).some((entry) => entry['approvalRequestId'] === id(approval)));
  });

  it('requested changes are recorded, change no quorum and no request; repeated, they record again; approval remains possible', async () => {
    const callsBefore = booted.adapter.calls.length;
    // The quorum-1 cluster: if a requested change counted, this one fact would complete the approval.
    const { key, approval } = await withheldRequest(PROD);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const reply = await command(booted.baseUrl, AUTH.approverA, id(approval), 'request-changes', { subjectDigest: digestOf(approval), reason: 'pin the release notes' });
      assert.equal(reply.status, 200, reply.text);
      const state = reply.body['approval'] as Record<string, unknown>;
      assert.equal(state['status'], 'pending');
      assert.deepEqual(quorumOf(state).countedApprovers, []);
      assert.equal(state['changesRequested'], attempt + 1);
      assert.equal(state['subjectDigest'], digestOf(approval), 'the governed request is not rewritten');
    }
    assertAwaitingApproval(await govern(booted.baseUrl, org.agentCredential, release(PROD, key)));
    assert.equal(booted.adapter.calls.length, callsBefore, 'requested changes never satisfy quorum');
    const approved = await command(booted.baseUrl, AUTH.approverA, id(approval), 'approve', { subjectDigest: digestOf(approval) });
    assert.deepEqual(quorumOf(approved.body['approval'] as Record<string, unknown>).countedApprovers, ['operator:approver-a']);
  });

  it('escalation routing: recorded with its reference, discoverable in the escalated view without knowing the id, no quorum, no authority', async () => {
    const callsBefore = booted.adapter.calls.length;
    const { key, approval } = await withheldRequest(PROD);
    assert.equal((await inbox(booted.baseUrl, AUTH.observer, 'escalated')).some((entry) => entry['approvalRequestId'] === id(approval)), false);
    const escalated = await command(booted.baseUrl, AUTH.approverA, id(approval), 'escalate', { subjectDigest: digestOf(approval), reason: 'CAB-2026-114: needs release manager' });
    assert.equal(escalated.status, 200, escalated.text);
    const state = escalated.body['approval'] as Record<string, unknown>;
    assert.equal(state['status'], 'pending');
    assert.deepEqual(quorumOf(state), { minimumApprovals: 1, countedApprovers: [], satisfied: false });
    // Routing needs a reference: an escalation without one is refused (400) and records nothing.
    const bare = await command(booted.baseUrl, AUTH.approverA, id(approval), 'escalate', { subjectDigest: digestOf(approval) });
    assert.equal(bare.status, 400, bare.text);
    assert.equal(((await detail(booted.baseUrl, id(approval)))['escalations'] as unknown[]).length, 1, 'only the referenced escalation is recorded');
    // Double submit records a second (inert) escalation fact and changes nothing else.
    await command(booted.baseUrl, AUTH.approverA, id(approval), 'escalate', { subjectDigest: digestOf(approval), reason: 'CAB-2026-114: needs release manager' });
    const queue = await inbox(booted.baseUrl, AUTH.observer, 'escalated');
    const entry = queue.find((candidate) => candidate['approvalRequestId'] === id(approval));
    assert.ok(entry !== undefined, 'an observer finds the escalated request in the escalated view');
    assert.deepEqual(
      (entry['escalations'] as Record<string, unknown>[]).map((escalation) => [escalation['actorId'], escalation['reason']]),
      [
        ['operator:approver-a', 'CAB-2026-114: needs release manager'],
        ['operator:approver-a', 'CAB-2026-114: needs release manager'],
      ],
    );
    assertAwaitingApproval(await govern(booted.baseUrl, org.agentCredential, release(PROD, key)));
    assert.equal(booted.adapter.calls.length, callsBefore, 'escalation never satisfies quorum');
    // Escalation creates no authority: an approver without standing is still refused afterwards.
    expectRefusal(await command(booted.baseUrl, AUTH.approverNoStanding, id(approval), 'approve', { subjectDigest: digestOf(approval) }), 'APPROVAL_APPROVER_INELIGIBLE', 'after escalation');
    // And an operator without standing cannot escalate (CORE-05 requires live standing for every verdict).
    expectRefusal(await command(booted.baseUrl, AUTH.approverNoStanding, id(approval), 'escalate', { subjectDigest: digestOf(approval), reason: 'x' }), 'APPROVAL_APPROVER_INELIGIBLE', 'escalate without standing');
  });

  it('revocation withdraws a completed approval before the retry: no execution; no restore; a second revocation is refused', async () => {
    const callsBefore = booted.adapter.calls.length;
    const { key, approval } = await withheldRequest(PROD);
    assert.equal((await command(booted.baseUrl, AUTH.approverA, id(approval), 'approve', { subjectDigest: digestOf(approval) })).status, 200);
    const revoked = await command(booted.baseUrl, AUTH.approverB, id(approval), 'revoke', { subjectDigest: digestOf(approval), reason: 'wrong window' });
    assert.equal(revoked.status, 200, revoked.text);
    assert.equal((revoked.body['approval'] as Record<string, unknown>)['status'], 'revoked');
    assert.equal((revoked.body['approval'] as Record<string, unknown>)['approvalDigest'], null);
    assertAwaitingApproval(await govern(booted.baseUrl, org.agentCredential, release(PROD, key)), 'GOVERNED_ACTION_APPROVAL_REVOKED');
    assert.equal(booted.adapter.calls.length, callsBefore);
    expectRefusal(await command(booted.baseUrl, AUTH.approverB, id(approval), 'revoke', { subjectDigest: digestOf(approval) }), 'APPROVAL_REVOKED', 'revoke twice');
    expectRefusal(await command(booted.baseUrl, AUTH.approverB, id(approval), 'approve', { subjectDigest: digestOf(approval) }), 'APPROVAL_REVOKED', 'approve after revoke');
    for (const verb of ['unrevoke', 'restore', 'reactivate', 'undo', 'execute', 'delete']) {
      assert.equal((await command(booted.baseUrl, AUTH.administrator, id(approval), verb, { subjectDigest: digestOf(approval) })).status, 404, verb);
    }
  });

  it('a pending request can be revoked (closed) as well, and an operator without standing cannot revoke', async () => {
    const { approval } = await withheldRequest(PROD);
    expectRefusal(await command(booted.baseUrl, AUTH.approverNoStanding, id(approval), 'revoke', { subjectDigest: digestOf(approval) }), 'APPROVAL_APPROVER_INELIGIBLE', 'revoke without standing');
    const revoked = await command(booted.baseUrl, AUTH.approverA, id(approval), 'revoke', { subjectDigest: digestOf(approval) });
    assert.equal((revoked.body['approval'] as Record<string, unknown>)['status'], 'revoked', revoked.text);
  });
});

describe('CTRL-04 Host — the subject the human reviewed is the subject decided', () => {
  it('a stale or substituted subject digest is refused and records nothing', async () => {
    const { approval } = await withheldRequest(PROD);
    const forged = `sha256:${'0'.repeat(64)}`;
    expectRefusal(await command(booted.baseUrl, AUTH.approverA, id(approval), 'approve', { subjectDigest: forged }), 'APPROVAL_SUBJECT_MISMATCH', 'forged digest');
    // Another request's real digest is equally a substitution.
    const other = await withheldRequest(PROD);
    expectRefusal(await command(booted.baseUrl, AUTH.approverA, id(approval), 'approve', { subjectDigest: digestOf(other.approval) }), 'APPROVAL_SUBJECT_MISMATCH', 'another request’s digest');
    assert.equal(verdicts(await detail(booted.baseUrl, id(approval))).length, 0);
  });

  it('a request whose requirement changed while the page was open is superseded: the old review is refused, never re-applied', async () => {
    const dir = workspace.dir();
    const first = await bootCtrl04(workspace, { dir });
    const local = await provisionOrganization(first.baseUrl);
    const key = releaseKey('ctrl04-superseded');
    const withheld = await govern(first.baseUrl, local.agentCredential, release(PROD, key));
    const reviewed = await approvalFor(first.baseUrl, withheld);
    await first.host.close();
    // Trusted configuration changes the production requirement (quorum 1 → 2) and the Host restarts.
    const changed = { ...GOVERNANCE, profiles: GOVERNANCE.profiles.map((profile) => (profile.profileId === 'release-production' ? { ...profile, approval: { ...QUORUM_1, minimumApprovals: 2 } } : profile)) };
    const second = await bootCtrl04(workspace, { dir, file: ctrl04File(changed) });
    const now = await detail(second.baseUrl, id(reviewed));
    assert.equal(now['status'], 'superseded');
    assert.equal(now['superseded'], true);
    expectRefusal(await command(second.baseUrl, AUTH.approverA, id(reviewed), 'approve', { subjectDigest: digestOf(reviewed) }), 'APPROVAL_REQUEST_SUPERSEDED', 'stale review after a configuration change');
    assert.ok((await inbox(second.baseUrl, AUTH.observer, 'superseded')).some((entry) => entry['approvalRequestId'] === id(reviewed)));
    assert.equal(second.adapter.calls.length, 0);
  });
});

describe('CTRL-04 Host — expiry is the Host’s, at the exact CORE-05 boundary (a mocked clock; no sleeps)', () => {
  /** Runs `body` with `Date` mocked from the real instant; `setTo(instant)` moves the Host's clock to exactly that instant. */
  async function withClock(body: (setTo: (instant: string | number) => void) => Promise<void>): Promise<void> {
    mock.timers.enable({ apis: ['Date'], now: Date.now() });
    try {
      await body((instant) => mock.timers.setTime(typeof instant === 'number' ? instant : Date.parse(instant)));
    } finally {
      mock.timers.reset();
    }
  }

  it('the request accepts a verdict strictly before its expiry and refuses it at the expiry instant', async () => {
    await withClock(async (setTo) => {
      const local = await bootCtrl04(workspace);
      const localOrg = await provisionOrganization(local.baseUrl);
      const early = await govern(local.baseUrl, localOrg.agentCredential, release(PROD, releaseKey('ctrl04-ttl-early')));
      const late = await govern(local.baseUrl, localOrg.agentCredential, release(PROD, releaseKey('ctrl04-ttl-late')));
      const earlyApproval = await approvalFor(local.baseUrl, early);
      const lateApproval = await approvalFor(local.baseUrl, late);
      setTo(Date.parse(earlyApproval['requestExpiresAt'] as string) - 1);
      assert.equal((await command(local.baseUrl, AUTH.approverA, id(earlyApproval), 'approve', { subjectDigest: digestOf(earlyApproval) })).status, 200, 'strictly before expiry');
      setTo(lateApproval['requestExpiresAt'] as string);
      expectRefusal(await command(local.baseUrl, AUTH.approverA, id(lateApproval), 'approve', { subjectDigest: digestOf(lateApproval) }), 'APPROVAL_REQUEST_EXPIRED', 'at the expiry instant');
      assert.equal((await detail(local.baseUrl, id(lateApproval)))['status'], 'request-expired');
      assert.equal(local.adapter.calls.length, 0);
    });
  });

  it('an approval that lapses before the agent retries releases nothing', async () => {
    await withClock(async (setTo) => {
      const local = await bootCtrl04(workspace);
      const localOrg = await provisionOrganization(local.baseUrl);
      const key = releaseKey('ctrl04-lapse');
      const withheld = await govern(local.baseUrl, localOrg.agentCredential, release(PROD, key));
      const approval = await approvalFor(local.baseUrl, withheld);
      const approved = await command(local.baseUrl, AUTH.approverA, id(approval), 'approve', { subjectDigest: digestOf(approval) });
      const notAfter = (approved.body['approval'] as Record<string, unknown>)['notAfter'] as string;
      setTo(notAfter);
      assert.equal((await detail(local.baseUrl, id(approval)))['status'], 'approval-expired');
      assertAwaitingApproval(await govern(local.baseUrl, localOrg.agentCredential, release(PROD, key)), 'GOVERNED_ACTION_APPROVAL_EXPIRED');
      assert.equal(local.adapter.calls.length, 0);
    });
  });
});

describe('CTRL-04 Host — approver standing is live: revoked after the verdict, before use', () => {
  it('revoking the approver’s Kernel-Authority standing withdraws an unused approval; the retry does not execute', async () => {
    const local = await bootCtrl04(workspace);
    const localOrg = await provisionOrganization(local.baseUrl);
    const key = releaseKey('ctrl04-standing');
    const withheld = await govern(local.baseUrl, localOrg.agentCredential, release(PROD, key));
    const approval = await approvalFor(local.baseUrl, withheld);
    assert.equal(((await command(local.baseUrl, AUTH.approverA, id(approval), 'approve', { subjectDigest: digestOf(approval) })).body['approval'] as Record<string, unknown>)['status'], 'approved');
    // A responder revokes approver-a's standing through the CTRL-01 route.
    const revoked = await call(local.baseUrl, 'POST', '/api/admin/authority/entities/authority-grant/approval-standing-approver-a/revoke', { authorization: AUTH.responder, body: { reason: 'approver left the release board' } });
    assert.equal(revoked.status, 200, revoked.text);
    const now = await detail(local.baseUrl, id(approval));
    assert.equal(now['status'], 'pending', 'the approval is withdrawn: CORE-05 re-resolves standing at every read');
    assert.deepEqual(quorumOf(now).countedApprovers, []);
    assert.equal(verdicts(now)[0]?.['counted'], false);
    assertAwaitingApproval(await govern(local.baseUrl, localOrg.agentCredential, release(PROD, key)));
    assert.equal(local.adapter.calls.length, 0);
  });
});

describe('CTRL-04 Host — closed command bodies: nothing a request says can name who acts or what the state is', () => {
  it('every smuggled identity, authority or state field is refused with 400 and records nothing', async () => {
    const { approval } = await withheldRequest(PROD);
    for (const field of ['operatorId', 'organizationId', 'actorId', 'authenticated', 'authenticatedBy', 'role', 'permissions', 'approverId', 'approvalDigest', 'proof', 'state', 'status', 'quorum', 'countedApprovers', 'system', 'provisionedBy', 'approvedBy', 'signature', 'privateKey', 'approvalRequestId']) {
      const reply = await command(booted.baseUrl, AUTH.approverA, id(approval), 'approve', { subjectDigest: digestOf(approval), [field]: field === 'authenticated' ? true : 'operator:approver-b' });
      assert.equal(reply.status, 400, `${field}: ${reply.text}`);
    }
    const nested = await command(booted.baseUrl, AUTH.approverA, id(approval), 'approve', { subjectDigest: digestOf(approval), evidence: [{ type: 'source_document', hash: EVIDENCE_HASH, actorId: 'x' }] });
    assert.equal(nested.status, 400, nested.text);
    for (const raw of ['[]', '"approve"', 'null', '{"subjectDigest":']) {
      const reply = await call(booted.baseUrl, 'POST', `${approvalPath(id(approval))}/approve`, { authorization: AUTH.approverA, rawBody: raw });
      assert.equal(reply.status, 400, `${raw}: ${reply.text}`);
    }
    const form = await call(booted.baseUrl, 'POST', `${approvalPath(id(approval))}/approve`, { authorization: AUTH.approverA, rawBody: 'subjectDigest=x', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    assert.equal(form.status, 415, form.text);
    const longReason = await command(booted.baseUrl, AUTH.approverA, id(approval), 'approve', { subjectDigest: digestOf(approval), reason: 'x'.repeat(257) });
    assert.equal(longReason.status, 400, longReason.text);
    const manyReferences = await command(booted.baseUrl, AUTH.approverA, id(approval), 'approve', { subjectDigest: digestOf(approval), evidence: Array.from({ length: 33 }, () => ({ type: 'source_document', hash: EVIDENCE_HASH })) });
    assert.equal(manyReferences.status, 400, manyReferences.text);
    // Beyond the operator plane's body bound, the body is not read at all (the existing bounded reader closes the request).
    const oversized = await command(booted.baseUrl, AUTH.approverA, id(approval), 'approve', { subjectDigest: digestOf(approval), reason: 'x'.repeat(70_000) }).catch(() => undefined);
    assert.ok(oversized === undefined || oversized.status === 400, oversized?.text);
    assert.equal(verdicts(await detail(booted.baseUrl, id(approval))).length, 0);
    // Queries are closed too: no organization can be named.
    assert.equal((await call(booted.baseUrl, 'GET', `${approvalsPath()}?organizationId=${ORG}`, { authorization: AUTH.observer })).status, 400);
    assert.equal((await call(booted.baseUrl, 'GET', `${approvalPath(id(approval))}?organizationId=${ORG}`, { authorization: AUTH.observer })).status, 400);
    assert.equal((await call(booted.baseUrl, 'GET', approvalsPath('everything'), { authorization: AUTH.observer })).status, 400);
  });

  it('a refused caller’s body is never read: permission is checked first', async () => {
    const { approval } = await withheldRequest(PROD);
    const reply = await call(booted.baseUrl, 'POST', `${approvalPath(id(approval))}/approve`, { authorization: AUTH.provisioner, rawBody: 'not json at all' });
    assert.equal(reply.status, 403, reply.text);
    assert.equal(errorCodeOf(reply), 'OPERATOR_PERMISSION_DENIED');
  });
});

describe('CTRL-04 Host — role × approval operation matrix, and the credential-plane matrix (forged direct requests)', () => {
  const OPERATIONS = ['list', 'describe', 'approve', 'reject', 'request-changes', 'escalate', 'revoke'] as const;
  // What each role's permissions let it *reach*. Reaching a command is not succeeding: CORE-05 decides that.
  const REACHES: Readonly<Record<string, readonly (typeof OPERATIONS)[number][]>> = {
    observer: ['list', 'describe'],
    responder: ['list', 'describe', 'reject', 'request-changes', 'escalate', 'revoke'],
    provisioner: [],
    steward: [],
    administrator: ['list', 'describe', 'approve', 'reject', 'request-changes', 'escalate', 'revoke'],
    approverA: ['list', 'describe', 'approve', 'reject', 'request-changes', 'escalate', 'revoke'],
    legacyAdministrator: [],
  };

  it('every role reaches exactly its permitted operations; every other is refused 403 before any body is read', async () => {
    const { approval } = await withheldRequest(PROD);
    // A wrong subject digest: a command that passes the permission check is refused by the Host's subject pre-check (409) and records nothing.
    const stale = { subjectDigest: `sha256:${'f'.repeat(64)}`, reason: 'matrix probe' };
    for (const [role, reaches] of Object.entries(REACHES)) {
      const authorization = AUTH[role as keyof typeof AUTH];
      for (const operation of OPERATIONS) {
        const reply =
          operation === 'list'
            ? await call(booted.baseUrl, 'GET', approvalsPath(), { authorization })
            : operation === 'describe'
              ? await call(booted.baseUrl, 'GET', approvalPath(id(approval)), { authorization })
              : await command(booted.baseUrl, authorization, id(approval), operation, stale);
        if (reaches.includes(operation)) {
          assert.equal(reply.status, operation === 'list' || operation === 'describe' ? 200 : 409, `${role} ${operation}: ${reply.text}`);
        } else {
          assert.equal(reply.status, 403, `${role} ${operation}: ${reply.text}`);
          assert.ok(['OPERATOR_PERMISSION_DENIED', 'AUTHORIZATION_FAILED'].includes(errorCodeOf(reply) as string), `${role} ${operation}: ${reply.text}`);
        }
      }
    }
    assert.equal(verdicts(await detail(booted.baseUrl, id(approval))).length, 0, 'no forged request recorded anything');
  });

  it('legacy administrators, customer API keys, agent credentials and unknown credentials never reach the approval plane; an approver credential is not a customer credential', async () => {
    const { approval } = await withheldRequest(PROD);
    const targets: readonly [string, string, Record<string, unknown> | undefined][] = [
      ['GET', approvalsPath(), undefined],
      ['GET', approvalPath(id(approval)), undefined],
      ['POST', `${approvalPath(id(approval))}/approve`, { subjectDigest: digestOf(approval) }],
      ['POST', `${approvalPath(id(approval))}/reject`, { subjectDigest: digestOf(approval) }],
    ];
    for (const [method, path, body] of targets) {
      const legacy = await call(booted.baseUrl, method, path, { authorization: AUTH.legacyAdministrator, ...(body !== undefined ? { body } : {}) });
      assert.equal(legacy.status, 403, `legacy administrator ${method} ${path}: ${legacy.text}`);
      assert.equal((await call(booted.baseUrl, method, path, { authorization: AUTH.legacyKey, ...(body !== undefined ? { body } : {}) })).status, 403, `customer API key ${method} ${path}`);
      assert.equal((await call(booted.baseUrl, method, path, { authorization: `Bearer ${org.agentCredential}`, ...(body !== undefined ? { body } : {}) })).status, 401, `agent credential ${method} ${path}`);
      assert.equal((await call(booted.baseUrl, method, path, { authorization: 'Bearer FRONTERA_UNKNOWN_CREDENTIAL_0123456789abcdef', ...(body !== undefined ? { body } : {}) })).status, 401, `unknown ${method} ${path}`);
      assert.equal((await call(booted.baseUrl, method, path, body !== undefined ? { body } : {})).status, 401, `anonymous ${method} ${path}`);
    }
    // The approval operator's credential is not a customer-plane credential: it cannot act as the requester.
    const asAgent = await call(booted.baseUrl, 'POST', '/api/governed-actions', { authorization: AUTH.approverA, body: release(PROD, releaseKey('ctrl04-operator-as-agent')) });
    assert.equal(asAgent.status, 401, asAgent.text);
    assert.equal(verdicts(await detail(booted.baseUrl, id(approval))).length, 0);
  });

  it('the legacy administrator gains no approval permission in its own reported identity either', async () => {
    const legacy = await call(booted.baseUrl, 'GET', '/api/admin/organization', { authorization: AUTH.legacyAdministrator });
    assert.equal(legacy.status, 403);
    const approver = await call(booted.baseUrl, 'GET', '/api/admin/organization', { authorization: AUTH.approverA });
    assert.deepEqual((approver.body['operator'] as Record<string, unknown>)['permissions'], ['organization.read', 'authority.inspect', 'inventory.read', 'approval.read', 'approval.approve', 'approval.restrict']);
  });
});

describe('CTRL-04 Host — organization boundary, double submission and disclosure', () => {
  it('an approval request of another organization’s Host cannot be read or acted on here', async () => {
    const otherDir = workspace.dir();
    const foreign = await bootCtrl04(workspace, { dir: otherDir, env: { AOC_ENTERPRISE_KERNEL_AUTHORITY_ORGANIZATION_ID: 'org-foreign', AOC_ENTERPRISE_API_KEYS: 'FRONTERA_CTRL02_LEGACY_KEY_SENTINEL_19ce0a:org-foreign' } });
    const foreignOrg = await provisionOrganization(foreign.baseUrl);
    const withheld = await govern(foreign.baseUrl, foreignOrg.agentCredential, release(PROD, releaseKey('ctrl04-foreign')));
    const foreignApproval = await approvalFor(foreign.baseUrl, withheld);
    assert.equal((foreignApproval['canonicalSubject'] as string).includes('"organizationId":"org-foreign"'), true);
    assert.equal((await call(booted.baseUrl, 'GET', approvalPath(id(foreignApproval)), { authorization: AUTH.observer })).status, 404);
    assert.equal((await command(booted.baseUrl, AUTH.approverA, id(foreignApproval), 'approve', { subjectDigest: digestOf(foreignApproval) })).status, 404);
    assert.equal((await inbox(booted.baseUrl, AUTH.observer, 'all')).some((entry) => entry['approvalRequestId'] === id(foreignApproval)), false);
    assert.equal((await detail(foreign.baseUrl, id(foreignApproval)))['status'], 'pending', 'nothing was recorded on the foreign request');
  });

  it('concurrent double submissions: one approver counts once; one completion, one approval digest, one execution', async () => {
    const callsBefore = booted.adapter.calls.length;
    const critical = await withheldRequest(CRITICAL);
    const evidence = [{ type: 'source_document', hash: EVIDENCE_HASH }];
    const twice = await Promise.all([0, 1].map(() => command(booted.baseUrl, AUTH.approverA, id(critical.approval), 'approve', { subjectDigest: digestOf(critical.approval), evidence })));
    assert.deepEqual(twice.map((reply) => reply.status).sort(), [200, 409]);
    assert.deepEqual(quorumOf(await detail(booted.baseUrl, id(critical.approval))).countedApprovers, ['operator:approver-a']);

    const prod = await withheldRequest(PROD);
    const race = await Promise.all([AUTH.approverA, AUTH.approverB].map((authorization) => command(booted.baseUrl, authorization, id(prod.approval), 'approve', { subjectDigest: digestOf(prod.approval) })));
    assert.deepEqual(race.map((reply) => reply.status).sort(), [200, 409]);
    const refused = race.find((reply) => reply.status === 409);
    assert.equal(failureOf(refused as Reply), 'APPROVAL_ALREADY_APPROVED');
    const settled = await detail(booted.baseUrl, id(prod.approval));
    assert.equal(quorumOf(settled).countedApprovers.length, 1);
    const winner = race.find((reply) => reply.status === 200) as Reply;
    assert.equal(settled['approvalDigest'], (winner.body['approval'] as Record<string, unknown>)['approvalDigest'], 'one completion, one approval digest');
    const executions = await Promise.all([0, 1].map(() => govern(booted.baseUrl, org.agentCredential, release(PROD, prod.key))));
    assert.ok(executions.every((reply) => reply.body['status'] === 'executed'), executions.map((reply) => reply.text).join('\n'));
    assert.equal(booted.adapter.calls.length, callsBefore + 1, 'executed exactly once');
  });

  it('approval subject content never reaches the Host’s logs; the approval audit line carries ids and outcome only', async () => {
    const lines = logLines.filter((line) => line.includes('enterprise.operator.approval'));
    assert.ok(lines.length > 0);
    for (const line of lines) {
      for (const content of ['release-2026-10-01', 'releaseVersion', EVIDENCE_HASH, 'CAB-2026-114', 'not this release', 'docs://change/1']) assert.equal(line.includes(content), false, `${content} in ${line}`);
      assert.deepEqual(Object.keys((JSON.parse(line) as { fields: Record<string, unknown> }).fields).sort(), ['operation', 'operatorId', 'organizationId', 'status', 'target']);
    }
  });
});
