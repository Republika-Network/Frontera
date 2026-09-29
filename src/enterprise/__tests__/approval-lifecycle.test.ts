import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createInMemoryApprovalStore, type ApprovalAssessment } from '../approval-authority/index.js';
import {
  Authority,
  Clock,
  EVALUATED,
  OWNER,
  REQUESTER,
  REQUIREMENT,
  actor,
  at,
  authorityOver,
  cleanup,
  governanceWith,
  opened,
  openStore,
  rawRows,
  refusedWith,
  storePath,
  target,
} from './core05-approval-fixture.js';

/**
 * CORE-05 — the approval lifecycle of one committed decision: exactly one
 * canonical request, approval-runtime's semantics (recognition, authority,
 * scope, evidence, segregation of duties, expiry, duplicates, quorum) with
 * approver standing read from Kernel-Authority now, a requirement that is a
 * snapshot, and an approval bound to exactly the decision approved.
 */

after(cleanup);

const HASH = (n: number): string => `sha256:${n.toString(16).padStart(64, '0')}`;
const approvedDigest = (assessment: ApprovalAssessment): string => {
  assert.equal(assessment.kind, 'approved', JSON.stringify(assessment));
  return (assessment as { approvalDigest: string }).approvalDigest;
};

describe('CORE-05 — one committed decision, one canonical approval request', () => {
  it('retries and concurrent assessments while pending open exactly one request, keyed by the decision', async () => {
    const file = storePath();
    const authority = authorityOver(await openStore(file));
    const results = await Promise.all(Array.from({ length: 6 }, () => authority.assess(target())));
    for (const result of results) assert.deepEqual(result, { kind: 'withheld', status: 'pending' });
    assert.equal(rawRows(file).filter((row) => row.kind === 'requested').length, 1);
    const view = await authority.describe('aoc.gar:target');
    assert.ok(view !== undefined);
    // Deterministic from immutable decision identity — never a counter a restart could reset.
    assert.match(view.approvalRequestId, /^approval-request:[0-9a-f]{64}$/);
    const reopened = authorityOver(await openStore(file));
    assert.equal((await reopened.describe('aoc.gar:target'))?.approvalRequestId, view.approvalRequestId);
  });

  it('a decision that does not await a human approval — allowed, denied, indeterminate, evidence or handshake — never opens one', async () => {
    const authority = authorityOver(createInMemoryApprovalStore({ organizationId: 'org-a' }));
    for (const status of ['allowed', 'denied', 'indeterminate'] as const) {
      assert.deepEqual(await authority.assess(target({ status, reasonCodes: ['APPROVAL_REQUIRED'] })), { kind: 'not-applicable' });
    }
    assert.deepEqual(await authority.assess(target({ reasonCodes: ['APPROVAL_REQUIRED', 'EVIDENCE_REQUIRED'] })), { kind: 'not-applicable' });
    assert.deepEqual(await authority.assess(target({ reasonCodes: ['RECOGNITION_HANDSHAKE_INVALID', 'APPROVAL_PENDING'] })), { kind: 'not-applicable' });
    assert.equal(await authority.describe('aoc.gar:target'), undefined);
  });
});

describe('CORE-05 — the requirement comes from trusted configuration, by the trusted effective profile', () => {
  it('no requirement declared → no approval lifecycle at all (no synthesized permissive default)', async () => {
    const governance = governanceWith(null);
    const authority = authorityOver(createInMemoryApprovalStore({ organizationId: 'org-a' }), { governance });
    assert.deepEqual(await authority.assess(target({ governance })), { kind: 'not-applicable' });
  });

  it('a bogus profile claim never selects (or avoids) a requirement; an absent claim is resolved from action × resource', async () => {
    const authority = authorityOver(createInMemoryApprovalStore({ organizationId: 'org-a' }));
    assert.deepEqual(await authority.assess(target({ semantics: 'bogus' })), { kind: 'not-applicable' });
    // Claiming another configured profile — one with a weaker (quorum-1) requirement — selects nothing either.
    assert.deepEqual(await authority.assess(target({ semantics: 'weaker', requestId: 'aoc.gar:weaker' })), { kind: 'not-applicable' });
    assert.equal(await authority.describe('aoc.gar:weaker'), undefined);
    assert.deepEqual(await authority.assess(target({ semantics: 'absent', requestId: 'aoc.gar:absent' })), { kind: 'withheld', status: 'pending' });
    const view = await authority.describe('aoc.gar:absent');
    assert.equal(view?.subject.requirement.minimumApprovals, 2);
    assert.equal(view?.subject.actionClass, 'pay');
  });

  it('the requirement is snapshotted: a configuration change supersedes an open or completed request, it is never reinterpreted', async () => {
    const file = storePath();
    const clock = new Clock();
    const store = await openStore(file);
    const strict = authorityOver(store, { clock });
    const command = await opened(strict);
    await strict.approve(actor('approver-a'), command);
    // quorum 2 → 1: the historical request does not become approved.
    const relaxed = governanceWith({ ...REQUIREMENT, minimumApprovals: 1 });
    const later = authorityOver(store, { governance: relaxed, clock });
    assert.deepEqual(await later.assess(target({ governance: relaxed })), { kind: 'withheld', status: 'superseded' });
    await assert.rejects(() => later.approve(actor('approver-b'), command), refusedWith('APPROVAL_REQUEST_SUPERSEDED'));
    // And the other way: an approval completed under quorum 1 does not satisfy quorum 2.
    const oneFile = storePath();
    const oneStore = await openStore(oneFile);
    const lenient = authorityOver(oneStore, { governance: relaxed, clock });
    const lenientCommand = await opened(lenient, target({ governance: relaxed }));
    await lenient.approve(actor('approver-a'), lenientCommand);
    approvedDigest(await lenient.assess(target({ governance: relaxed })));
    assert.deepEqual(await authorityOver(oneStore, { clock }).assess(target()), { kind: 'withheld', status: 'superseded' });
  });
});

describe('CORE-05 — quorum of distinct, valid approvers (approval-runtime semantics, Kernel-Authority standing)', () => {
  it('A → pending; A again → refused as a duplicate, still one; B → approved with a proof; later approvals change nothing', async () => {
    const authority = authorityOver(await openStore(storePath()));
    const command = await opened(authority);
    assert.equal((await authority.approve(actor('approver-a'), command)).state.status, 'pending');
    await assert.rejects(() => authority.approve(actor('approver-a'), command), refusedWith('APPROVAL_DUPLICATE'));
    assert.deepEqual((await authority.describe('aoc.gar:target'))?.state.approvers, ['approver-a']);
    assert.deepEqual(await authority.assess(target()), { kind: 'withheld', status: 'pending' });
    const done = await authority.approve(actor('approver-b'), command);
    assert.equal(done.state.status, 'approved');
    const digest = approvedDigest(await authority.assess(target()));
    await assert.rejects(() => authority.approve(actor('approver-c'), command), refusedWith('APPROVAL_REQUEST_CLOSED'));
    assert.equal(approvedDigest(await authority.assess(target())), digest);
  });

  it('concurrent valid approvals: every legitimate one needed is persisted, exactly one completion, exactly one proof', async () => {
    const file = storePath();
    const authority = authorityOver(await openStore(file));
    const command = await opened(authority);
    const settled = await Promise.allSettled(['approver-a', 'approver-b', 'approver-c'].map((id) => authority.approve(actor(id), command)));
    assert.equal(settled.filter((entry) => entry.status === 'fulfilled').length, 2);
    const refused = settled.find((entry) => entry.status === 'rejected');
    assert.ok(refused !== undefined && refusedWith('APPROVAL_REQUEST_CLOSED')(refused.reason));
    assert.equal(rawRows(file).filter((row) => row.kind === 'approved').length, 2);
    const digests = new Set(await Promise.all(Array.from({ length: 4 }, async () => approvedDigest(await authority.assess(target())))));
    assert.equal(digests.size, 1);
  });

  it('only valid approvals count: unrecognized, no authority, wrong scope, requester (SOD) are refused; the owner of the agent may approve', async () => {
    const authority = authorityOver(await openStore(storePath()));
    const command = await opened(authority, target({ principalId: OWNER }));
    await assert.rejects(() => authority.approve(actor('stranger'), command), refusedWith('APPROVAL_APPROVER_INELIGIBLE'));
    await assert.rejects(() => authority.approve(actor('actor-no-authority'), command), refusedWith('APPROVAL_APPROVER_INELIGIBLE'));
    await assert.rejects(() => authority.approve(actor('approver-elsewhere'), command), (error: unknown) => refusedWith('APPROVAL_APPROVER_INELIGIBLE')(error) && (error as { reasonCode?: string }).reasonCode === 'APPROVAL_OUT_OF_SCOPE');
    await assert.rejects(() => authority.approve(actor(REQUESTER), command), (error: unknown) => (error as { reasonCode?: string }).reasonCode === 'SEGREGATION_OF_DUTIES_VIOLATION');
    // approval-runtime deliberately does not bar the principal the agent acts for: the human-owner review.
    await authority.approve(actor(OWNER), command);
    await authority.approve(actor('approver-a'), command);
    approvedDigest(await authority.assess(target({ principalId: OWNER })));
  });

  it('authority is re-resolved when the approval is used: an approver revoked after approving withdraws it — no new grant from the proof', async () => {
    const kernelAuthority = new Authority();
    const authority = authorityOver(await openStore(storePath()), { authority: kernelAuthority });
    const command = await opened(authority);
    await authority.approve(actor('approver-a'), command);
    await authority.approve(actor('approver-b'), command);
    approvedDigest(await authority.assess(target()));
    kernelAuthority.revoke('approver-a');
    assert.deepEqual(await authority.assess(target()), { kind: 'withheld', status: 'pending' });
    const view = await authority.describe('aoc.gar:target');
    assert.deepEqual(view?.state.approvers, ['approver-b']);
    assert.equal(view?.state.verdicts.find((verdict) => verdict.actorId === 'approver-a')?.reasonCode, 'APPROVER_AUTHORITY_MISSING');
  });

  it('authority is re-resolved at submission: an approver revoked while the request is pending is refused', async () => {
    const kernelAuthority = new Authority();
    const authority = authorityOver(await openStore(storePath()), { authority: kernelAuthority });
    const command = await opened(authority);
    kernelAuthority.revoke('approver-a');
    await assert.rejects(() => authority.approve(actor('approver-a'), command), refusedWith('APPROVAL_APPROVER_INELIGIBLE'));
  });

  it('approvals are never pooled across requests: A on R1 and B on R2 is quorum on neither', async () => {
    const authority = authorityOver(await openStore(storePath()));
    const first = await opened(authority, target({ requestId: 'aoc.gar:r1', decisionId: 'decision-r1' }));
    const second = await opened(authority, target({ requestId: 'aoc.gar:r2', decisionId: 'decision-r2' }));
    await authority.approve(actor('approver-a'), first);
    await authority.approve(actor('approver-b'), second);
    assert.deepEqual(await authority.assess(target({ requestId: 'aoc.gar:r1', decisionId: 'decision-r1' })), { kind: 'withheld', status: 'pending' });
    assert.deepEqual(await authority.assess(target({ requestId: 'aoc.gar:r2', decisionId: 'decision-r2' })), { kind: 'withheld', status: 'pending' });
    // A command must name the subject of its own request.
    await assert.rejects(() => authority.approve(actor('approver-b'), { approvalRequestId: first.approvalRequestId, subjectDigest: second.subjectDigest }), refusedWith('APPROVAL_INVALID'));
  });
});

describe('CORE-05 — rejection, changes requested, escalation', () => {
  it('a rejection is final: later approvals are refused and nothing resumes; the rejection is never deleted', async () => {
    const file = storePath();
    const authority = authorityOver(await openStore(file));
    const command = await opened(authority);
    await authority.approve(actor('approver-a'), command);
    assert.equal((await authority.reject(actor('approver-b'), command)).state.status, 'rejected');
    await assert.rejects(() => authority.approve(actor('approver-c'), command), refusedWith('APPROVAL_REQUEST_CLOSED'));
    assert.deepEqual(await authority.assess(target()), { kind: 'withheld', status: 'rejected' });
    assert.equal(rawRows(file).filter((row) => row.kind === 'rejected').length, 1);
  });

  it('requested changes and escalation are recorded and are not approval: the request stays pending, no proof', async () => {
    const file = storePath();
    const authority = authorityOver(await openStore(file));
    const command = await opened(authority);
    assert.equal((await authority.requestChanges(actor('approver-a'), { ...command, reason: 'ticket-42' })).state.status, 'pending');
    assert.equal((await authority.escalate(actor('approver-b'), command)).state.status, 'pending');
    assert.deepEqual(await authority.assess(target()), { kind: 'withheld', status: 'pending' });
    assert.deepEqual(
      rawRows(file).map((row) => row.kind),
      ['requested', 'requested_changes', 'escalated'],
    );
    // Neither counted toward quorum: two approvals are still needed.
    await authority.approve(actor('approver-a'), command);
    assert.deepEqual(await authority.assess(target()), { kind: 'withheld', status: 'pending' });
  });
});

describe('CORE-05 — evidence', () => {
  it('a required evidence type must be cited by hash; the hashes are bound into the proof', async () => {
    const governance = governanceWith({ ...REQUIREMENT, minimumApprovals: 1, requiredEvidence: ['source_document'] });
    const digests: string[] = [];
    for (const hash of [HASH(1), HASH(2)]) {
      const clock = new Clock();
      const authority = authorityOver(await openStore(storePath()), { governance, clock });
      const command = await opened(authority, target({ governance }));
      await assert.rejects(() => authority.approve(actor('approver-a'), command), refusedWith('APPROVAL_EVIDENCE_INSUFFICIENT'));
      await assert.rejects(() => authority.approve(actor('approver-a'), { ...command, evidence: [{ type: 'human_comment', hash }] }), refusedWith('APPROVAL_EVIDENCE_INSUFFICIENT'));
      await assert.rejects(() => authority.approve(actor('approver-a'), { ...command, evidence: [{ type: 'source_document', hash: 'not-a-hash' }] }), refusedWith('APPROVAL_INVALID'));
      await authority.approve(actor('approver-a'), { ...command, evidence: [{ type: 'source_document', hash, uri: 'doc://invoice-7' }] });
      digests.push(approvedDigest(await authority.assess(target({ governance }))));
    }
    // Identical in everything but the reviewed evidence → a different proof.
    assert.notEqual(digests[0], digests[1]);
  });
});

describe('CORE-05 — expiry (injected clock only)', () => {
  it('the request accepts verdicts strictly before its expiry; at and after it, never; a pending request then reads request-expired', async () => {
    const clock = new Clock();
    const file = storePath();
    const authority = authorityOver(await openStore(file, { clock }), { clock });
    const command = await opened(authority);
    clock.value = new Date(Date.parse(EVALUATED) + 3600_000 - 1).toISOString();
    await authority.approve(actor('approver-a'), command);
    clock.value = at(3600);
    await assert.rejects(() => authority.approve(actor('approver-b'), command), refusedWith('APPROVAL_REQUEST_CLOSED'));
    assert.deepEqual(await authority.assess(target()), { kind: 'withheld', status: 'request-expired' });
    clock.value = at(7200);
    assert.deepEqual(await authorityOver(await openStore(file, { clock }), { clock }).assess(target()), { kind: 'withheld', status: 'request-expired' });
  });

  it('a completed approval is usable strictly before approvedAt + validity; at and after it — and across a restart — it is not', async () => {
    const clock = new Clock();
    const file = storePath();
    const authority = authorityOver(await openStore(file, { clock }), { clock });
    const command = await opened(authority);
    await authority.approve(actor('approver-a'), command);
    clock.value = at(100);
    await authority.approve(actor('approver-b'), command);
    const assessment = await authority.assess(target());
    assert.equal(assessment.kind === 'approved' ? assessment.notAfter : undefined, at(100 + 900));
    clock.value = new Date(Date.parse(at(1000)) - 1).toISOString();
    approvedDigest(await authority.assess(target()));
    clock.value = at(1000);
    assert.deepEqual(await authority.assess(target()), { kind: 'withheld', status: 'approval-expired' });
    clock.value = at(5000);
    assert.deepEqual(await authorityOver(await openStore(file, { clock }), { clock }).assess(target()), { kind: 'withheld', status: 'approval-expired' });
  });
});

describe('CORE-05 — revocation', () => {
  it('a pending request or a completed approval can be revoked by an actor with live approval authority; revoked is final', async () => {
    const authority = authorityOver(await openStore(storePath()));
    const command = await opened(authority);
    await authority.approve(actor('approver-a'), command);
    await authority.approve(actor('approver-b'), command);
    approvedDigest(await authority.assess(target()));
    await assert.rejects(() => authority.revoke(actor('actor-no-authority'), command), refusedWith('APPROVAL_APPROVER_INELIGIBLE'));
    assert.equal((await authority.revoke(actor('approver-c'), { ...command, reason: 'fraud-suspected' })).state.status, 'revoked');
    assert.deepEqual(await authority.assess(target()), { kind: 'withheld', status: 'revoked' });
    await assert.rejects(() => authority.approve(actor('approver-c'), command), refusedWith('APPROVAL_REQUEST_CLOSED'));
    await assert.rejects(() => authority.revoke(actor('approver-c'), command), refusedWith('APPROVAL_REQUEST_CLOSED'));

    const pendingAuthority = authorityOver(await openStore(storePath()));
    const pending = await opened(pendingAuthority);
    await pendingAuthority.revoke(actor('approver-a'), pending);
    assert.deepEqual(await pendingAuthority.assess(target()), { kind: 'withheld', status: 'revoked' });
  });

  it('a restrictive verdict stays final even when its author later loses authority', async () => {
    const kernelAuthority = new Authority();
    const authority = authorityOver(await openStore(storePath()), { authority: kernelAuthority });
    const command = await opened(authority);
    await authority.reject(actor('approver-c'), command);
    kernelAuthority.revoke('approver-c');
    assert.deepEqual(await authority.assess(target()), { kind: 'withheld', status: 'rejected' });
  });
});

describe('CORE-05 — an approval binds exactly the committed decision it approved', () => {
  it('another decision, parameter, context, record digest or action under the same request is superseded, never approved; another request is a new, pending lifecycle', async () => {
    const authority = authorityOver(await openStore(storePath()));
    const command = await opened(authority);
    await authority.approve(actor('approver-a'), command);
    await authority.approve(actor('approver-b'), command);
    approvedDigest(await authority.assess(target()));
    const substitutes = [
      target({ decisionId: 'decision-other' }),
      target({ amount: 10_000 }),
      target({ contextDigest: `sha256:${'9'.repeat(64)}` }),
      target({ requestDigest: `sha256:${'8'.repeat(64)}` }),
      target({ resource: 'ledger-2' }),
      target({ principalId: OWNER }),
    ];
    for (const substitute of substitutes) {
      const assessment = await authority.assess(substitute);
      assert.notEqual(assessment.kind, 'approved', JSON.stringify(substitute.request.action));
    }
    assert.deepEqual(await authority.assess(target({ decisionId: 'decision-other' })), { kind: 'withheld', status: 'superseded' });
    assert.deepEqual(await authority.assess(target({ amount: 10_000 })), { kind: 'withheld', status: 'superseded' });
    assert.deepEqual(await authority.assess(target({ requestId: 'aoc.gar:other', decisionId: 'decision-other' })), { kind: 'withheld', status: 'pending' });
    // Another action: another profile, another requirement, its own lifecycle.
    assert.deepEqual(await authority.assess(target({ requestId: 'aoc.gar:read', decisionId: 'decision-read', action: 'read-ledger' })), { kind: 'withheld', status: 'pending' });
  });

  it('another organization never sees, and can never use, this organization’s approval', async () => {
    const file = storePath();
    const authority = authorityOver(await openStore(file));
    const command = await opened(authority);
    await authority.approve(actor('approver-a'), command);
    await authority.approve(actor('approver-b'), command);
    const store = await openStore(file);
    assert.deepEqual(await store.read('org-b'), []);
  });
});

describe('CORE-05 — who is acting comes only from the trusted context, never the command', () => {
  it('an untrusted context, a command naming an approver, and unknown fields are refused', async () => {
    const authority = authorityOver(await openStore(storePath()));
    const command = await opened(authority);
    const inherited = Object.create({ authenticated: true }) as Record<string, unknown>;
    inherited['actorId'] = 'approver-a';
    inherited['authenticatedBy'] = 'x';
    for (const context of [inherited, { authenticated: 'true', actorId: 'approver-a', authenticatedBy: 'x' }, { actorId: 'approver-a', authenticatedBy: 'x' }, { authenticated: true, actorId: 'approver-a' }, null]) {
      await assert.rejects(() => authority.approve(context as never, command), refusedWith('APPROVAL_CONTEXT_UNTRUSTED'));
    }
    await assert.rejects(() => authority.approve(actor('approver-a'), { ...command, approverId: 'approver-b' } as never), refusedWith('APPROVAL_INVALID'));
    await assert.rejects(() => authority.approve(actor('approver-a'), { ...command, proof: 'x' } as never), refusedWith('APPROVAL_INVALID'));
    assert.deepEqual((await authority.describe('aoc.gar:target'))?.state.approvers, []);
  });
});
