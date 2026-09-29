import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { grantSourceDigest, withGrantValidityCeiling } from '../../features/grant-runtime/index.js';
import type { KernelEvaluationRequest } from '../../kernel/index.js';
import { KernelGrantCapability, deriveGrantSourceAuthorization, withVerifiedHumanApproval } from '../../kernel/orchestration/grant-adapter.js';
import { toKernelEvaluationResult } from '../governance-store/store-common.js';
import { ADMIN, PAYABLES, PAYABLES_WORLD, RISK_SIGNAL, Workspace, boot, call, committedRecord, createContextTable, govern, nextKey, provision, secureEnv, settle, storedGrant, type Reply } from './core04-host-fixture.js';
import {
  AGENT_ID,
  APPROVAL,
  APPROVER_A,
  APPROVER_B,
  APPROVER_C,
  APPROVER_ELSEWHERE,
  DEPLOY_APPROVER,
  LARGE,
  OWNER_ID,
  deploy,
  revokeApproverAuthority,
  approvalPolicy,
  approvals,
  approvalsFile,
  describe as describeApproval,
  payablesWorld,
  provisionApprovers,
  storedApprovalRows,
  as,
  commandFor,
} from './core05-host-fixture.js';

/**
 * CORE-05 — `approval_required` becomes resumable, not terminal, on the
 * canonical Host.
 *
 * Exit criterion: a withheld action proceeds after a durable, attributable
 * approval, only for the exact request approved, replay-safe.
 */

const workspace = new Workspace();
after(() => workspace.cleanup());

async function host(dir = workspace.dir(), file: Record<string, unknown> = approvalsFile()) {
  const context = createContextTable();
  const booted = await boot(workspace, secureEnv(dir, file), { context, policy: approvalPolicy() });
  context.set(payablesWorld(LARGE));
  return { ...booted, context, dir };
}

async function provisioned(file?: Record<string, unknown>) {
  const booted = await host(workspace.dir(), file);
  await provision(booted.host);
  await provisionApprovers(booted.host);
  return booted;
}

const reasonCodes = (reply: Reply): readonly string[] => (reply.body['reasonCodes'] as readonly string[] | undefined) ?? [];

function assertAwaiting(reply: Reply, code = 'GOVERNED_ACTION_APPROVAL_PENDING'): void {
  assert.equal(reply.body['status'], 'withheld', reply.text);
  assert.equal(reply.body['withheldBy'], 'approval', reply.text);
  assert.ok(reasonCodes(reply).includes(code), `${code}: ${reply.text}`);
}

describe('CORE-05 — a withheld action proceeds after a durable, attributable approval', () => {
  it('withheld → recorded request → one approval (quorum 1/2) → second distinct approval → executed exactly once; the decision is never re-made', async () => {
    const { host: booted, calls, baseUrl, dir } = await provisioned();
    const key = 'core05-main';
    const first = await govern(baseUrl, settle(LARGE), key);
    assertAwaiting(first);
    // The Kernel's own decision, restated verbatim — the approval code is beside it, never instead of it.
    const decision = first.body['decision'] as { readonly decisionId: string; readonly status: string; readonly reasonCodes: readonly string[] };
    assert.equal(decision.status, 'approval_required');
    assert.ok(decision.reasonCodes.includes('APPROVAL_REQUIRED'), decision.reasonCodes.join(','));
    for (const code of decision.reasonCodes) assert.ok(reasonCodes(first).includes(code));
    assert.equal(calls.length, 0);

    // The request is durable and discoverable, and shows the approver exactly what was decided.
    const view = await describeApproval(booted, first);
    assert.equal(view.requestId, first.body['requestId']);
    assert.equal(view.decisionId, decision.decisionId);
    assert.equal(view.subject.actorId, AGENT_ID);
    assert.equal(view.subject.action, 'settle-invoice');
    assert.equal(view.subject.resourceScope, PAYABLES);
    assert.deepEqual(view.subject.parameters, [
      { dimension: 'destination', type: 'token', value: 'supplier-x' },
      { dimension: 'invoiceTotal', type: 'integer', value: LARGE },
    ]);
    assert.deepEqual(view.subject.decision.reasonCodes, decision.reasonCodes);
    assert.ok(view.subject.contextDigest?.startsWith('sha256:'), 'the admitted context the decision relied on is part of what is approved');
    assert.equal(view.state.status, 'pending');
    assert.equal(view.subject.requirement.minimumApprovals, 2);
    assert.deepEqual(
      (await approvals(booted).pending()).map((open) => open.requestId),
      [view.requestId],
    );

    // Retries while pending: the same committed decision, the same single request record.
    assertAwaiting(await govern(baseUrl, settle(LARGE), key));
    assertAwaiting(await govern(baseUrl, settle(LARGE), key));
    assert.equal(storedApprovalRows(dir).filter((row) => row['kind'] === 'requested').length, 1);

    // One approval: quorum not met.
    const afterOne = await approvals(booted).approve(as(APPROVER_A), commandFor(view));
    assert.equal(afterOne.state.status, 'pending');
    assert.deepEqual(afterOne.state.approvers, [APPROVER_A]);
    assertAwaiting(await govern(baseUrl, settle(LARGE), key));
    // The same approver never counts twice.
    await assert.rejects(approvals(booted).approve(as(APPROVER_A), commandFor(view)), { code: 'APPROVAL_DUPLICATE' });
    assert.equal(calls.length, 0);

    // The second distinct approver completes it.
    const approved = await approvals(booted).approve(as(APPROVER_B), commandFor(view));
    assert.equal(approved.state.status, 'approved');
    assert.ok(approved.state.approvalDigest?.startsWith('sha256:'));
    assert.equal((await approvals(booted).pending()).length, 0);

    const resumed = await govern(baseUrl, settle(LARGE), key);
    assert.equal(resumed.body['status'], 'executed', resumed.text);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.action, 'settle-invoice');
    // The decision was not re-made: same decision id, same approval_required status, same codes.
    assert.deepEqual(resumed.body['decision'], first.body['decision']);

    // Attributable: every verdict row names its approver and the writer that recorded it.
    const verdicts = storedApprovalRows(dir).filter((row) => row['kind'] === 'approved');
    assert.deepEqual(
      verdicts.map((row) => [row['actor_id'], row['recorded_by'], row['subject_digest'], row['decision_id']]),
      [
        [APPROVER_A, 'test:approval-desk-session', view.subjectDigest, decision.decisionId],
        [APPROVER_B, 'test:approval-desk-session', view.subjectDigest, decision.decisionId],
      ],
    );
  });

  it('the resumed grant’s signed sourceDigest commits to the approval, and the grant never outlives the approval', async () => {
    const { host: booted, baseUrl, dir } = await provisioned();
    const withheld = await govern(baseUrl, settle(LARGE), 'core05-binding');
    const view = await describeApproval(booted, withheld);
    await approvals(booted).approve(as(APPROVER_A), commandFor(view));
    const approved = await approvals(booted).approve(as(APPROVER_B), commandFor(view));
    const executed = await govern(baseUrl, settle(LARGE), 'core05-binding');
    assert.equal(executed.body['status'], 'executed', executed.text);

    const lookup = await call(baseUrl, 'GET', `/api/admin/authority/executions/${encodeURIComponent(executed.body['executionId'] as string)}`, { authorization: ADMIN });
    const grant = storedGrant(dir, lookup.body['grantId'] as string);
    const notAfter = approved.state.notAfter;
    const approvalDigest = approved.state.approvalDigest;
    assert.ok(notAfter !== undefined && approvalDigest !== undefined);
    assert.equal(Date.parse(grant.expiresAt) <= Date.parse(notAfter), true, 'a resumed grant never outlives its approval');

    // Recompute the source from the committed decision alone, resumed by the
    // Kernel under the approval: the signed grant's sourceDigest equals it,
    // and differs from the same source without the approval digest.
    const record = await committedRecord(booted, executed);
    const decision = toKernelEvaluationResult(record);
    assert.equal(decision.status, 'approval_required');
    const request = record.request.requestPayload as unknown as KernelEvaluationRequest;
    const projected = deriveGrantSourceAuthorization(new KernelGrantCapability({ declaration: {} }), request, decision);
    assert.equal(projected.authorizationPermitsExercise, false, 'the committed decision alone never permits exercise');
    const source = withGrantValidityCeiling(withVerifiedHumanApproval(projected, decision, approvalDigest), { source: 'decision', notAfter });
    assert.equal(source.approvalDigest, approvalDigest);
    assert.equal(grant.sourceDigest, grantSourceDigest(source));
    const { approvalDigest: _dropped, ...withoutApproval } = source;
    assert.notEqual(grant.sourceDigest, grantSourceDigest(withoutApproval));
  });
});

describe('CORE-05 — replay-safe', () => {
  it('retries after execution replay the record — before and after a restart — and the adapter runs exactly once', async () => {
    const dir = workspace.dir();
    const first = await host(dir);
    await provision(first.host);
    await provisionApprovers(first.host);
    const key = 'core05-replay';
    const view = await describeApproval(first.host, await govern(first.baseUrl, settle(LARGE), key));
    await approvals(first.host).approve(as(APPROVER_A), commandFor(view));
    await approvals(first.host).approve(as(APPROVER_B), commandFor(view));
    assert.equal((await govern(first.baseUrl, settle(LARGE), key)).body['status'], 'executed');
    const replay = await govern(first.baseUrl, settle(LARGE), key);
    assert.equal(replay.body['status'], 'executed');
    assert.equal(replay.body['replayed'], true);
    assert.equal(first.calls.length, 1);
    await first.host.close();

    const second = await host(dir);
    const afterRestart = await govern(second.baseUrl, settle(LARGE), key);
    assert.equal(afterRestart.body['status'], 'executed', afterRestart.text);
    assert.equal(afterRestart.body['replayed'], true);
    assert.equal(second.calls.length, 0, 'no second effect after restart');
  });

  it('an approval recorded before a restart resumes the request after it — durably, from the signed store', async () => {
    const dir = workspace.dir();
    const first = await host(dir);
    await provision(first.host);
    await provisionApprovers(first.host);
    const key = 'core05-restart';
    const view = await describeApproval(first.host, await govern(first.baseUrl, settle(LARGE), key));
    await approvals(first.host).approve(as(APPROVER_A), commandFor(view));
    await approvals(first.host).approve(as(APPROVER_B), commandFor(view));
    assert.equal(first.calls.length, 0);
    await first.host.close();

    const second = await host(dir);
    assert.equal((await approvals(second.host).describe(view.requestId))?.state.status, 'approved');
    const resumed = await govern(second.baseUrl, settle(LARGE), key);
    assert.equal(resumed.body['status'], 'executed', resumed.text);
    assert.equal(second.calls.length, 1);
  });
});

describe('CORE-05 — canonical Host: single approval, quorum, rejection', () => {
  it('quorum 1: withheld → one authorized approval → restart → the same committed decision resumes and executes exactly once', async () => {
    const dir = workspace.dir();
    const file = approvalsFile({ ...APPROVAL, minimumApprovals: 1 });
    const first = await host(dir, file);
    await provision(first.host);
    await provisionApprovers(first.host);
    const key = nextKey('core05-single');
    const withheld = await govern(first.baseUrl, settle(LARGE), key);
    assertAwaiting(withheld);
    assert.equal(first.calls.length, 0);
    const view = await describeApproval(first.host, withheld);
    assert.equal((await approvals(first.host).approve(as(APPROVER_A), commandFor(view))).state.status, 'approved');
    await first.host.close();

    const second = await host(dir, file);
    const resumed = await govern(second.baseUrl, settle(LARGE), key);
    assert.equal(resumed.body['status'], 'executed', resumed.text);
    assert.deepEqual(resumed.body['decision'], withheld.body['decision'], 'the same committed decision, never re-made');
    assert.equal(second.calls.length, 1);
    assert.equal((await govern(second.baseUrl, settle(LARGE), key)).body['replayed'], true);
    assert.equal(second.calls.length, 1);
  });

  it('quorum 2 across a restart: A → still withheld; restart; duplicate A → still one; B → proof; resume → exactly once', async () => {
    const dir = workspace.dir();
    const first = await host(dir);
    await provision(first.host);
    await provisionApprovers(first.host);
    const key = nextKey('core05-quorum');
    const view = await describeApproval(first.host, await govern(first.baseUrl, settle(LARGE), key));
    await approvals(first.host).approve(as(APPROVER_A), commandFor(view));
    assertAwaiting(await govern(first.baseUrl, settle(LARGE), key));
    assert.equal(first.calls.length, 0);
    await first.host.close();

    const second = await host(dir);
    await assert.rejects(approvals(second.host).approve(as(APPROVER_A), commandFor(view)), { code: 'APPROVAL_DUPLICATE' });
    assert.deepEqual((await approvals(second.host).describe(view.requestId))?.state.approvers, [APPROVER_A]);
    assert.equal((await approvals(second.host).approve(as(APPROVER_B), commandFor(view))).state.status, 'approved');
    assert.equal((await govern(second.baseUrl, settle(LARGE), key)).body['status'], 'executed');
    assert.equal(second.calls.length, 1);
  });

  it('rejection: restart, resume → no grant, adapter 0; a later approval cannot erase it', async () => {
    const dir = workspace.dir();
    const first = await host(dir);
    await provision(first.host);
    await provisionApprovers(first.host);
    const key = nextKey('core05-reject');
    const view = await describeApproval(first.host, await govern(first.baseUrl, settle(LARGE), key));
    await approvals(first.host).approve(as(APPROVER_A), commandFor(view));
    await approvals(first.host).reject(as(APPROVER_C), { ...commandFor(view), reason: 'supplier-under-review' });
    await first.host.close();

    const second = await host(dir);
    assertAwaiting(await govern(second.baseUrl, settle(LARGE), key), 'GOVERNED_ACTION_APPROVAL_REJECTED');
    await assert.rejects(approvals(second.host).approve(as(APPROVER_B), commandFor(view)), { code: 'APPROVAL_REQUEST_CLOSED' });
    assertAwaiting(await govern(second.baseUrl, settle(LARGE), key), 'GOVERNED_ACTION_APPROVAL_REJECTED');
    assert.equal(second.calls.length, 0);
    assert.equal(storedApprovalRows(dir).filter((row) => row['kind'] === 'rejected').length, 1);
  });

  it('changes requested and escalation are recorded and are not approval', async () => {
    const { host: booted, baseUrl, calls } = await provisioned();
    const key = nextKey('core05-changes');
    const view = await describeApproval(booted, await govern(baseUrl, settle(LARGE), key));
    await approvals(booted).requestChanges(as(APPROVER_A), { ...commandFor(view), reason: 'attach PO' });
    await approvals(booted).escalate(as(APPROVER_B), commandFor(view));
    assertAwaiting(await govern(baseUrl, settle(LARGE), key));
    assert.equal(calls.length, 0);
  });
});

describe('CORE-05 — canonical Host: who may approve', () => {
  it('only a recognized actor with live approver authority over exactly this resource; never the requester; the owner may', async () => {
    const { host: booted, baseUrl, calls } = await provisioned();
    const view = await describeApproval(booted, await govern(baseUrl, settle(LARGE), nextKey('core05-who')));
    // Holds approve-settlement, over another resource.
    await assert.rejects(approvals(booted).approve(as(APPROVER_ELSEWHERE), commandFor(view)), { code: 'APPROVAL_APPROVER_INELIGIBLE' });
    // Holds only approve-deploy.
    await assert.rejects(approvals(booted).approve(as(DEPLOY_APPROVER), commandFor(view)), { code: 'APPROVAL_APPROVER_INELIGIBLE' });
    // The requesting agent; an unknown actor; the owner, who holds authority to *settle* but none to approve.
    await assert.rejects(approvals(booted).approve(as(AGENT_ID), commandFor(view)), { code: 'APPROVAL_APPROVER_INELIGIBLE' });
    await assert.rejects(approvals(booted).approve(as('actor-nobody'), commandFor(view)), { code: 'APPROVAL_APPROVER_INELIGIBLE' });
    await assert.rejects(approvals(booted).approve(as(OWNER_ID), commandFor(view)), { code: 'APPROVAL_APPROVER_INELIGIBLE' });
    assert.deepEqual((await approvals(booted).describe(view.requestId))?.state.approvers, []);
    assert.equal(calls.length, 0);
  });

  it('approver authority revoked while pending → the approval is refused', async () => {
    const { host: booted, baseUrl } = await provisioned();
    const view = await describeApproval(booted, await govern(baseUrl, settle(LARGE), nextKey('core05-revoked-pending')));
    await revokeApproverAuthority(booted, APPROVER_A);
    await assert.rejects(approvals(booted).approve(as(APPROVER_A), commandFor(view)), { code: 'APPROVAL_APPROVER_INELIGIBLE' });
  });

  it('approver authority revoked after approving, before resume → the proof mints nothing (adapter 0) until a valid approver replaces it', async () => {
    const { host: booted, baseUrl, calls } = await provisioned();
    const key = nextKey('core05-revoked-after');
    const view = await describeApproval(booted, await govern(baseUrl, settle(LARGE), key));
    await approvals(booted).approve(as(APPROVER_A), commandFor(view));
    await approvals(booted).approve(as(APPROVER_B), commandFor(view));
    await revokeApproverAuthority(booted, APPROVER_B);
    assertAwaiting(await govern(baseUrl, settle(LARGE), key));
    assert.equal(calls.length, 0);
    await approvals(booted).approve(as(APPROVER_C), commandFor(view));
    assert.equal((await govern(baseUrl, settle(LARGE), key)).body['status'], 'executed');
    assert.equal(calls.length, 1);
  });

  it('a completed approval revoked before resume → no grant, adapter 0', async () => {
    const { host: booted, baseUrl, calls } = await provisioned();
    const key = nextKey('core05-proof-revoked');
    const view = await describeApproval(booted, await govern(baseUrl, settle(LARGE), key));
    await approvals(booted).approve(as(APPROVER_A), commandFor(view));
    await approvals(booted).approve(as(APPROVER_B), commandFor(view));
    await approvals(booted).revoke(as(APPROVER_C), { ...commandFor(view), reason: 'fraud-suspected' });
    assertAwaiting(await govern(baseUrl, settle(LARGE), key), 'GOVERNED_ACTION_APPROVAL_REVOKED');
    assert.equal(calls.length, 0);
  });
});

describe('CORE-05 — canonical Host: exact decision, no replay, no override', () => {
  it('one approved request never releases another request, another amount, another action, or another decision', async () => {
    const { host: booted, baseUrl, calls, context } = await provisioned();
    const key = nextKey('core05-replay-source');
    const view = await describeApproval(booted, await govern(baseUrl, settle(LARGE), key));
    await approvals(booted).approve(as(APPROVER_A), commandFor(view));
    await approvals(booted).approve(as(APPROVER_B), commandFor(view));
    // Same content, another idempotency key: another request, another decision, its own lifecycle.
    assertAwaiting(await govern(baseUrl, settle(LARGE), nextKey('core05-replay-other')));
    // Another amount (attested so policy does not deny it).
    context.set(payablesWorld(LARGE + 1));
    assertAwaiting(await govern(baseUrl, settle(LARGE + 1), nextKey('core05-replay-amount')));
    // Another action: its own profile, requirement and approver authority.
    const deployment = await govern(baseUrl, deploy(), nextKey('core05-replay-action'));
    assert.equal(deployment.body['status'], 'withheld', deployment.text);
    assert.equal(calls.length, 0);
    // The approved request itself — only it — executes.
    context.set(payablesWorld(LARGE));
    assert.equal((await govern(baseUrl, settle(LARGE), key)).body['status'], 'executed');
    assert.equal(calls.length, 1);
  });

  it('a caller cannot name an approval proof or requirement: the intent schema is closed', async () => {
    const { host: booted, baseUrl, calls } = await provisioned();
    const view = await describeApproval(booted, await govern(baseUrl, settle(LARGE), nextKey('core05-caller-proof')));
    await approvals(booted).approve(as(APPROVER_A), commandFor(view));
    await approvals(booted).approve(as(APPROVER_B), commandFor(view));
    const approvalDigest = (await approvals(booted).describe(view.requestId))?.state.approvalDigest;
    for (const smuggled of [{ approvalProofId: approvalDigest }, { approvalRequestId: view.approvalRequestId }, { approval: { minimumApprovals: 0 } }]) {
      const reply = await govern(baseUrl, { ...settle(LARGE), ...smuggled }, nextKey('core05-smuggle'));
      assert.equal(reply.body['status'], 'rejected', reply.text);
    }
    const inBag = await govern(baseUrl, { ...settle(LARGE), assertedContext: { approvalProofId: approvalDigest, approved: true } }, nextKey('core05-smuggle-bag'));
    assert.notEqual(inBag.body['status'], 'executed', inBag.text);
    assert.equal(calls.length, 0);
  });

  it('an approval cannot override a denial: a denied decision opens no approval lifecycle', async () => {
    const { host: booted, baseUrl, calls, context } = await provisioned();
    // The proposed total differs from the attested invoice amount: policy denies.
    context.set(payablesWorld(LARGE));
    const denied = await govern(baseUrl, settle(LARGE + 5), nextKey('core05-denied'));
    assert.equal(denied.body['status'], 'denied', denied.text);
    assert.equal(await approvals(booted).describe(denied.body['requestId'] as string), undefined);
    // An admitted high-severity restrict-only signal denies too; elevated only requires review.
    context.set([...PAYABLES_WORLD, { key: RISK_SIGNAL, value: 'high', sourceId: 'configured-risk-source' }]);
    const high = await govern(baseUrl, settle(500), nextKey('core05-signal-high'));
    assert.equal(high.body['status'], 'denied', high.text);
    assert.equal(await approvals(booted).describe(high.body['requestId'] as string), undefined);
    context.set([...PAYABLES_WORLD, { key: RISK_SIGNAL, value: 'elevated', sourceId: 'configured-risk-source' }]);
    const key = nextKey('core05-signal-elevated');
    const elevated = await govern(baseUrl, settle(500), key);
    assertAwaiting(elevated);
    const view = await describeApproval(booted, elevated);
    await approvals(booted).approve(as(APPROVER_A), commandFor(view));
    await approvals(booted).approve(as(APPROVER_B), commandFor(view));
    assert.equal((await govern(baseUrl, settle(500), key)).body['status'], 'executed');
    assert.equal(calls.length, 1);
  });
});

describe('CORE-05 — canonical Host: approval and obligations are independent gates', () => {
  it('approval first, obligation second — and obligation first, approval second: executed exactly once after both, never before', async () => {
    const { host: booted, baseUrl, calls } = await provisioned();
    const discharges = booted.enterprise.obligationDischarges;
    assert.ok(discharges !== undefined);
    let observed = Date.now() - 600_000;
    const discharge = (reply: Reply) => {
      observed += 1000;
      return discharges.record(
        { system: true, actorId: 'operator:change-board-integration' },
        {
          correlation: { requestId: reply.body['requestId'] as string, action: 'deploy-release', resourceScope: 'production-environment-example' },
          obligationType: 'change.approval',
          sourceId: 'change-approvals',
          outcome: 'discharged',
          observedAt: new Date(observed).toISOString(),
          reference: 'CAB-1',
          subjectId: 'board-1',
        },
      );
    };

    // Order 1: approval, then obligation.
    const k1 = nextKey('core05-both-1');
    const w1 = await govern(baseUrl, deploy('release-a'), k1);
    assertAwaiting(w1);
    await approvals(booted).approve(as(DEPLOY_APPROVER), commandFor(await describeApproval(booted, w1)));
    const afterApproval = await govern(baseUrl, deploy('release-a'), k1);
    assert.equal(afterApproval.body['status'], 'withheld', afterApproval.text);
    assert.equal(afterApproval.body['withheldBy'], 'obligations', 'the approval satisfies no obligation');
    assert.equal(calls.length, 0);
    await discharge(w1);
    const done1 = await govern(baseUrl, deploy('release-a'), k1);
    assert.equal(done1.body['status'], 'executed', done1.text);
    assert.deepEqual(done1.body['decision'], w1.body['decision']);
    assert.equal(calls.length, 1);

    // Order 2: obligation, then approval.
    const k2 = nextKey('core05-both-2');
    const w2 = await govern(baseUrl, deploy('release-b'), k2);
    await discharge(w2);
    assertAwaiting(await govern(baseUrl, deploy('release-b'), k2));
    assert.equal(calls.length, 1, 'the obligation satisfies no approval');
    await approvals(booted).approve(as(DEPLOY_APPROVER), commandFor(await describeApproval(booted, w2)));
    const done2 = await govern(baseUrl, deploy('release-b'), k2);
    assert.equal(done2.body['status'], 'executed', done2.text);
    assert.deepEqual(done2.body['decision'], w2.body['decision']);
    assert.equal(calls.length, 2);
  });
});

describe('CORE-05 — canonical Host: posture and boundaries', () => {
  it('posture reports durable approvals; no approval route exists, and the CTRL-01 administrator credential reaches none', async () => {
    const { host: booted, baseUrl } = await provisioned();
    assert.equal(booted.posture.approvals, 'durable');
    for (const [method, path] of [
      ['POST', '/api/approvals'],
      ['GET', '/api/approval-inbox'],
      ['POST', '/api/admin/approvals'],
      ['POST', '/api/admin/authority/approvals/approve'],
    ] as const) {
      const reply = await call(baseUrl, method, path, { authorization: ADMIN, ...(method === 'POST' ? { body: {} } : {}) });
      assert.equal(reply.status, 404, `${method} ${path}: ${reply.text}`);
    }
  });

  it('an approver action that is itself a governed action is refused at startup', async () => {
    await assert.rejects(() => host(workspace.dir(), approvalsFile({ ...APPROVAL, approverAction: 'settle-invoice' })));
  });
});
