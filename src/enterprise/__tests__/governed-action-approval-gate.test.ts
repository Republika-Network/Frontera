import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { GOVERNED_ACTION_REASON_CODES as R, type GovernedActionApprovalAssessment, type GovernedActionOrchestratorOptions, type GovernedActionResult } from '../governed-action/index.js';
import { ALLOWED_INTENT, APPROVAL_INTENT, DENIED_ACTOR, DENIED_INTENT, IDENTITY, NOW, buildGovernedWorld, identityFor } from './governed-action-support.js';

/**
 * CORE-05 — the orchestrator's approval gate, against the real Kernel, the
 * real Governance Store, the real bounded-grant store and real ACE, with the
 * approval authority's port stood in so each test controls its answer.
 *
 * What is proved here is the gate's placement and its limits: it is consulted
 * only for an `approval_required` decision; it never turns any other status
 * into authority; it resumes the *same* committed decision (the Kernel runs
 * once); its answer is re-read immediately before the claim, so a revocation
 * between issuance and exercise leaves the adapter uncalled; and it satisfies
 * no other gate.
 */

const DIGEST = `sha256:${'a'.repeat(64)}`;
const plus = (minutes: number): string => new Date(Date.parse(NOW) + minutes * 60_000).toISOString();

function port(answers: () => GovernedActionApprovalAssessment): { readonly approvals: NonNullable<GovernedActionOrchestratorOptions['approvals']>; readonly calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    approvals: {
      assess: (input) => {
        calls.push(input);
        return Promise.resolve(answers());
      },
    },
  };
}

const approved = (notAfter = plus(60), approvalDigest = DIGEST): GovernedActionApprovalAssessment => ({ kind: 'approved', approvalDigest, notAfter });

function codes(result: GovernedActionResult): readonly string[] {
  return (result as { readonly reasonCodes?: readonly string[] }).reasonCodes ?? [];
}

describe('CORE-05 — the orchestrator approval gate', () => {
  it('without the gate, approval_required stays terminal exactly as before CORE-05', async () => {
    const world = buildGovernedWorld();
    const result = await world.orchestrator.govern(IDENTITY, APPROVAL_INTENT);
    assert.equal(result.status, 'withheld');
    assert.equal((result as { withheldBy?: string }).withheldBy, 'approval');
    assert.equal(world.adapter.calls.length, 0);
  });

  it('pending → withheld by approval, the approval code beside the Kernel’s own; approved → the same committed decision is issued and executed once', async () => {
    let answer: GovernedActionApprovalAssessment = { kind: 'withheld', status: 'pending' };
    const { approvals, calls } = port(() => answer);
    const world = buildGovernedWorld({ approvals });
    const first = await world.orchestrator.govern(IDENTITY, APPROVAL_INTENT);
    assert.equal(first.status, 'withheld');
    assert.ok(codes(first).includes(R.GOVERNED_ACTION_APPROVAL_PENDING));
    assert.ok(codes(first).includes('APPROVAL_REQUIRED'), codes(first).join(','));
    assert.equal(world.issueOutcomes.length, 0);
    // The port receives the committed record's own digests.
    const input = calls[0] as { readonly decisionDigest: { readonly requestDigest: string; readonly evaluationDigest: string } };
    assert.match(input.decisionDigest.requestDigest, /^sha256:|^[0-9a-f]{64}$/);

    answer = approved(plus(5));
    const kernelRuns = world.kernelResults.length;
    const second = await world.orchestrator.govern(IDENTITY, APPROVAL_INTENT);
    assert.equal(second.status, 'executed', JSON.stringify(second));
    assert.equal(world.adapter.calls.length, 1);
    assert.equal(world.kernelResults.length, kernelRuns, 'the decision is resumed, never re-made');
    assert.deepEqual((second as { decision?: unknown }).decision, (first as { decision?: unknown }).decision);
    // The grant never outlives the approval (its signed sourceDigest binding is proved on the Host).
    const outcome = world.issueOutcomes.at(-1);
    assert.ok(outcome !== undefined && outcome.outcome === 'issued');
    assert.ok(Date.parse(outcome.grant.expiresAt) <= Date.parse(plus(5)));
    // Replay after execution: from the record, the gate is not what answers.
    const replay = await world.orchestrator.govern(IDENTITY, APPROVAL_INTENT);
    assert.equal(replay.status, 'executed');
    assert.equal(world.adapter.calls.length, 1);
  });

  it('every non-usable status is withheld in its own words', async () => {
    const cases: readonly [GovernedActionApprovalAssessment, string][] = [
      [{ kind: 'withheld', status: 'rejected' }, R.GOVERNED_ACTION_APPROVAL_REJECTED],
      [{ kind: 'withheld', status: 'revoked' }, R.GOVERNED_ACTION_APPROVAL_REVOKED],
      [{ kind: 'withheld', status: 'request-expired' }, R.GOVERNED_ACTION_APPROVAL_REQUEST_EXPIRED],
      [{ kind: 'withheld', status: 'approval-expired' }, R.GOVERNED_ACTION_APPROVAL_EXPIRED],
      [{ kind: 'withheld', status: 'superseded' }, R.GOVERNED_ACTION_APPROVAL_SUPERSEDED],
      [{ kind: 'withheld', status: 'unavailable' }, R.GOVERNED_ACTION_APPROVAL_UNAVAILABLE],
    ];
    for (const [answer, code] of cases) {
      const world = buildGovernedWorld({ approvals: port(() => answer).approvals });
      const result = await world.orchestrator.govern(IDENTITY, APPROVAL_INTENT);
      assert.equal(result.status, 'withheld');
      assert.ok(codes(result).includes(code), `${code}: ${codes(result).join(',')}`);
      assert.equal(world.adapter.calls.length, 0);
    }
    const throwing = buildGovernedWorld({ approvals: { assess: () => Promise.reject(new Error('store offline')) } });
    assert.ok(codes(await throwing.orchestrator.govern(IDENTITY, APPROVAL_INTENT)).includes(R.GOVERNED_ACTION_APPROVAL_UNAVAILABLE));
  });

  it('an approval never overrides a denial, and is never consulted for any status but approval_required', async () => {
    const { approvals, calls } = port(() => approved());
    const denied = buildGovernedWorld({ approvals });
    const result = await denied.orchestrator.govern(identityFor({ actorId: DENIED_ACTOR }), DENIED_INTENT);
    assert.equal(result.status, 'denied');
    assert.equal(denied.adapter.calls.length, 0);
    const allowed = buildGovernedWorld({ approvals });
    assert.equal((await allowed.orchestrator.govern(IDENTITY, ALLOWED_INTENT)).status, 'executed');
    assert.equal(calls.length, 0);
  });

  it('proof revoked after grant issuance and before exercise: withheld, adapter 0; the retry is withheld at the gate and mints nothing', async () => {
    let answer: GovernedActionApprovalAssessment = approved();
    const world = buildGovernedWorld({
      approvals: port(() => answer).approvals,
      beforeAssess: async () => {
        answer = { kind: 'withheld', status: 'revoked' };
      },
    });
    const result = await world.orchestrator.govern(IDENTITY, APPROVAL_INTENT);
    assert.equal(result.status, 'withheld', JSON.stringify(result));
    assert.equal((result as { withheldBy?: string }).withheldBy, 'approval');
    assert.ok(codes(result).includes(R.GOVERNED_ACTION_APPROVAL_REVOKED));
    assert.equal(world.adapter.calls.length, 0);
    const issued = world.issueOutcomes.length;
    const retry = await world.orchestrator.govern(IDENTITY, APPROVAL_INTENT);
    assert.ok(codes(retry).includes(R.GOVERNED_ACTION_APPROVAL_REVOKED));
    assert.equal(world.issueOutcomes.length, issued, 'no new grant');
    assert.equal(world.adapter.calls.length, 0);
  });

  it('an approval replaced by another between issuance and exercise is not the approval the grant rests on', async () => {
    let answer: GovernedActionApprovalAssessment = approved();
    const world = buildGovernedWorld({
      approvals: port(() => answer).approvals,
      beforeAssess: async () => {
        answer = approved(plus(60), `sha256:${'b'.repeat(64)}`);
      },
    });
    const result = await world.orchestrator.govern(IDENTITY, APPROVAL_INTENT);
    assert.equal(result.status, 'withheld');
    assert.equal(world.adapter.calls.length, 0);
  });

  it('an approval that has already lapsed yields no grant: the ceiling it imposes is in the past', async () => {
    const world = buildGovernedWorld({ approvals: port(() => approved(plus(-1))).approvals });
    const result = await world.orchestrator.govern(IDENTITY, APPROVAL_INTENT);
    assert.equal(result.status, 'withheld');
    assert.ok(codes(result).includes('GRANT_VALIDITY_INVALID'), codes(result).join(','));
    assert.equal(world.issueOutcomes.filter((outcome) => outcome.outcome === 'issued').length, 0);
    assert.equal(world.adapter.calls.length, 0);
  });

  it('an approval satisfies no other gate: with a blocking obligation pending, the decision stays withheld by obligations', async () => {
    const world = buildGovernedWorld({ approvals: port(() => approved()).approvals, obligationsPending: true });
    const result = await world.orchestrator.govern(IDENTITY, APPROVAL_INTENT);
    assert.equal(result.status, 'withheld', JSON.stringify(result));
    assert.equal((result as { withheldBy?: string }).withheldBy, 'obligations');
    assert.ok(codes(result).includes('GRANT_OBLIGATIONS_UNSATISFIED'));
    assert.equal(world.adapter.calls.length, 0);
  });
});
