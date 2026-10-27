import type { AuthorizedHumanDecision, HumanDecisionRecord, HumanIdentityService, IssuedHumanDecisionChallenge } from '../human-identity/service.js';
import type { HumanDecisionChallengeContract, HumanDecisionEvidence, HumanDecisionVerdict } from '../human-identity/decision-challenge.js';
import { isOperatorRole, operatorMay, type OperatorRole } from '../operator-control/roles.js';
import type { ApprovalCommand, ApprovalCommandContext } from './contracts.js';
import { ApprovalAuthorityError } from './errors.js';
import type { ApprovalCommandPort, ApprovalRequestView } from './service.js';

/**
 * AUTH-03 — decision-bound human authority: the CORE-05 passkey channel.
 *
 * ```
 * begin(operatorId, approvalRequestId, subjectDigest, verdict)
 *   └─ operator role reaches the verdict (approval.approve / approval.restrict)
 *   └─ CORE-05 view: the request exists, is pending, not superseded, subject digest equal
 *       └─ identity.beginDecision → one challenge bound to exactly that decision (≤ 120 s)
 *
 * decide(assertion)
 *   └─ identity.peekDecision: the stored contract the assertion answers (commitment recomputed)
 *   └─ the same pre-checks again, against CORE-05 now     ← ordinary refusals burn nothing
 *   └─ identity.authorizeDecision                        ← verify, then CONSUME + evidence (signed, witnessed)
 *       └─ CORE-05 approve | reject, with
 *            context  { authenticated: true, actorId: operator:<id>, authenticatedBy: frontera:human-passkey-decision }
 *            evidence [{ type: approval_proof, hash: <evidence digest>, uri: frontera:human-passkey-decision:<commitment> }]
 *           └─ CORE-05 judges standing, SoD, duplicates, expiry, quorum — never here
 *   └─ identity.recordDecisionOutcome (best effort)
 * ```
 *
 * **One verdict per challenge, across two stores, without a shared
 * transaction.** The challenge is consumed durably (a signed, chained row of
 * the identity store, advanced at the CORE-07 witness) *before* CORE-05 is
 * asked. A crash between the two leaves a consumed challenge and no verdict —
 * fail closed: the human starts a new decision. A replay of the same assertion
 * finds the challenge consumed and never reaches CORE-05 again; CORE-05 itself
 * also refuses a second approval by the same approver and any verdict on a
 * closed request. Whether a consumed decision was recorded is never guessed:
 * `outcome()` reads it from CORE-05, by the verdict that cites this decision's
 * evidence digest and channel.
 *
 * **What cannot approve here.** Nothing but a verified, user-verified passkey
 * assertion over the decision's own commitment reaches the context below: not
 * a session, not a browser-facing service, not the static operator bearer.
 * The context is built only in this module and only after `authorizeDecision`
 * returned. The organization is always the Host's own.
 *
 * **Reconciliation (AUTH-04A).** `reconcile()` settles every consumed
 * decision that has no recorded outcome and is not in flight in this process:
 * `recorded` when CORE-05 holds the verdict citing it, otherwise `abandoned`.
 * It only *records an outcome*: it never calls a CORE-05 command, never
 * re-opens a challenge and never produces a verdict. The pilot runs one Host
 * process, so a consumed decision that is not in flight here can no longer
 * reach CORE-05; the Host runs it once at startup, after a crash.
 *
 * In-process only. There is no route to this module (AUTH-04B adds one).
 */

/** The trusted channel every passkey-bound verdict records as `recordedBy`. */
export const HUMAN_PASSKEY_DECISION_CHANNEL = 'frontera:human-passkey-decision';

export type HumanDecisionErrorCode =
  /** The operator's configured role does not reach this verdict, or the operator is not a configured CTRL-02 operator. */
  | 'HUMAN_DECISION_NOT_PERMITTED'
  /** The approval request is unknown, not pending, superseded, or of another subject than the one named. */
  | 'HUMAN_DECISION_NOT_APPLICABLE'
  /** The channel was composed for another organization than the identity store's. */
  | 'HUMAN_DECISION_CONFIGURATION_INVALID';

export class HumanDecisionError extends Error {
  readonly code: HumanDecisionErrorCode;

  constructor(code: HumanDecisionErrorCode, message: string) {
    super(message);
    this.name = 'HumanDecisionError';
    this.code = code;
  }
}

export interface HumanDecisionChannelOptions {
  /** The one organization this Host serves. */
  readonly organizationId: string;
  /** The CORE-05 command port: reads, approve and reject. No store. */
  readonly approvals: Pick<ApprovalCommandPort, 'list' | 'approve' | 'reject'>;
  /** The human identity service of the same organization. */
  readonly identity: Pick<HumanIdentityService, 'organizationId' | 'beginDecision' | 'peekDecision' | 'authorizeDecision' | 'recordDecisionOutcome' | 'decision' | 'unsettledDecisions'>;
  /** The configured CTRL-02 role of an operator, or `undefined` when they are not one. Never a caller's claim. */
  readonly roleOf: (operatorId: string) => OperatorRole | undefined;
}

export type HumanDecisionResult =
  | { readonly outcome: 'recorded'; readonly commitment: string; readonly evidence: HumanDecisionEvidence; readonly evidenceDigest: string; readonly verdictRowDigest: string; readonly approval: ApprovalRequestView }
  /** CORE-05 refused the verdict (for example, no live Kernel-Authority standing). The challenge is consumed; nothing was recorded. */
  | { readonly outcome: 'refused'; readonly commitment: string; readonly evidence: HumanDecisionEvidence; readonly evidenceDigest: string; readonly code: string; readonly reasonCode: string | null };

/** What is known about one decision commitment, read from both stores. */
export type HumanDecisionStatus =
  | { readonly state: 'issued' | 'expired'; readonly decision: HumanDecisionRecord }
  | { readonly state: 'recorded'; readonly decision: HumanDecisionRecord; readonly verdictRowDigest: string }
  | { readonly state: 'refused'; readonly decision: HumanDecisionRecord; readonly code: string }
  /** Consumed, and CORE-05 holds no verdict citing it: the attempt ended without a verdict. It never authorizes again. */
  | { readonly state: 'not-recorded'; readonly decision: HumanDecisionRecord };

/** What reconciliation did with one consumed, unsettled decision. */
export interface HumanDecisionReconciliation {
  readonly commitment: string;
  readonly settled: 'recorded' | 'abandoned';
}

export interface HumanDecisionChannel {
  begin(input: { readonly operatorId: string; readonly approvalRequestId: string; readonly subjectDigest: string; readonly verdict: HumanDecisionVerdict }): Promise<IssuedHumanDecisionChallenge>;
  decide(assertion: unknown): Promise<HumanDecisionResult>;
  outcome(commitment: string): Promise<HumanDecisionStatus | undefined>;
  /** Settles consumed decisions with no recorded outcome that are not in flight. Records outcomes only — never a verdict. */
  reconcile(): Promise<readonly HumanDecisionReconciliation[]>;
  /** AUTH-04D1R: resolves once every decide() running in this process has run to its end (recorded, refused or failed). Starts nothing. */
  settled(): Promise<void>;
}

const PERMISSION = { approve: 'approval.approve', reject: 'approval.restrict' } as const;

function contextFor(operatorId: string): ApprovalCommandContext {
  return Object.freeze({ authenticated: true as const, actorId: `operator:${operatorId}`, authenticatedBy: HUMAN_PASSKEY_DECISION_CHANNEL });
}

/** The verdict row a passkey decision produced: this channel, this human, citing exactly this evidence digest. */
function verdictCiting(view: ApprovalRequestView | undefined, operatorId: string, evidenceDigest: string): string | undefined {
  return view?.state.verdicts.find((verdict) => verdict.recordedBy === HUMAN_PASSKEY_DECISION_CHANNEL && verdict.actorId === `operator:${operatorId}` && verdict.evidence.some((entry) => entry.hash === evidenceDigest))?.rowDigest;
}

export function createHumanDecisionChannel(options: HumanDecisionChannelOptions): HumanDecisionChannel {
  const { organizationId, approvals, identity, roleOf } = options;
  if (identity.organizationId !== organizationId) throw new HumanDecisionError('HUMAN_DECISION_CONFIGURATION_INVALID', "The human identity store serves another organization than this Host's.");

  // Commitments whose decide() may still reach CORE-05 in this process. Added before the challenge is consumed, removed after the outcome is settled.
  const inFlight = new Set<string>();
  // AUTH-04D1R: every decide() still running, so a graceful shutdown can wait for each to reach its end.
  const running = new Set<Promise<HumanDecisionResult>>();

  const find = async (approvalRequestId: string): Promise<ApprovalRequestView | undefined> => (await approvals.list()).find((view) => view.approvalRequestId === approvalRequestId);

  /** Every refusal that must not consume a challenge: decided before `authorizeDecision`. */
  async function admissible(input: { readonly operatorId: string; readonly approvalRequestId: string; readonly subjectDigest: string; readonly verdict: HumanDecisionVerdict }): Promise<void> {
    const role = roleOf(input.operatorId);
    if (role === undefined || !isOperatorRole(role) || !operatorMay(role, PERMISSION[input.verdict])) {
      throw new HumanDecisionError('HUMAN_DECISION_NOT_PERMITTED', `That operator's role does not reach the ${input.verdict} verdict.`);
    }
    const view = await find(input.approvalRequestId);
    if (view === undefined || view.superseded || view.state.status !== 'pending' || view.subjectDigest !== input.subjectDigest) {
      throw new HumanDecisionError('HUMAN_DECISION_NOT_APPLICABLE', 'No pending approval request of that exact subject exists.');
    }
    if (input.verdict === 'approve' && view.state.verdicts.some((verdict) => verdict.kind === 'approved' && verdict.actorId === `operator:${input.operatorId}`)) {
      throw new HumanDecisionError('HUMAN_DECISION_NOT_APPLICABLE', 'That human already approved this request.');
    }
  }

  async function settle(authorized: AuthorizedHumanDecision, outcome: Parameters<HumanIdentityService['recordDecisionOutcome']>[1]): Promise<void> {
    try {
      await identity.recordDecisionOutcome(authorized.commitment, outcome);
    } catch {
      // Best effort: the CORE-05 log is the record of the verdict; `outcome()` reads it from there.
    }
  }

  return {
    async begin(input) {
      await admissible(input);
      return identity.beginDecision(input);
    },

    decide(assertion) {
      const work = (async (): Promise<HumanDecisionResult> => {
        const { contract, commitment: peeked } = identity.peekDecision(assertion);
        await admissible(contract);
        // A second submission of the same decision in this process is refused by the identity store either way; only the first owns the in-flight mark.
        const owner = !inFlight.has(peeked);
        if (owner) inFlight.add(peeked);
        try {
          return await decideAuthorized(assertion, contract);
        } finally {
          if (owner) inFlight.delete(peeked);
        }
      })();
      running.add(work);
      const forget = (): void => {
        running.delete(work);
      };
      work.then(forget, forget);
      return work;
    },

    async settled() {
      await Promise.allSettled([...running]);
    },

    async outcome(commitment) {
      const decision = identity.decision(commitment);
      if (decision === undefined) return undefined;
      if (decision.state !== 'consumed' || decision.evidence === undefined || decision.evidenceDigest === undefined) return { state: decision.state === 'expired' ? 'expired' : 'issued', decision };
      const verdictRowDigest = verdictCiting(await find(decision.contract.approvalRequestId), decision.contract.operatorId, decision.evidenceDigest);
      if (verdictRowDigest !== undefined) return { state: 'recorded', decision, verdictRowDigest };
      if (decision.outcome?.outcome === 'refused') return { state: 'refused', decision, code: decision.outcome.code };
      return { state: 'not-recorded', decision };
    },

    async reconcile() {
      const settled: HumanDecisionReconciliation[] = [];
      for (const decision of identity.unsettledDecisions()) {
        if (inFlight.has(decision.commitment) || decision.evidenceDigest === undefined) continue;
        const verdictRowDigest = verdictCiting(await find(decision.contract.approvalRequestId), decision.contract.operatorId, decision.evidenceDigest);
        // Re-checked after the read: a decide() that began meanwhile owns its own outcome.
        if (inFlight.has(decision.commitment)) continue;
        await identity.recordDecisionOutcome(decision.commitment, verdictRowDigest !== undefined ? { outcome: 'recorded', verdictRowDigest } : { outcome: 'abandoned' });
        settled.push({ commitment: decision.commitment, settled: verdictRowDigest !== undefined ? 'recorded' : 'abandoned' });
      }
      return settled;
    },
  };

  async function decideAuthorized(assertion: unknown, contract: HumanDecisionChallengeContract): Promise<HumanDecisionResult> {
    const authorized = await identity.authorizeDecision(assertion);
    const { evidence, evidenceDigest, commitment } = authorized;
    const command: ApprovalCommand = {
      approvalRequestId: contract.approvalRequestId,
      subjectDigest: contract.subjectDigest,
      evidence: [{ type: 'approval_proof', hash: evidenceDigest, uri: `${HUMAN_PASSKEY_DECISION_CHANNEL}:${commitment}` }],
    };
    let approval: ApprovalRequestView;
    try {
      approval = contract.verdict === 'approve' ? await approvals.approve(contextFor(contract.operatorId), command) : await approvals.reject(contextFor(contract.operatorId), command);
    } catch (error) {
      if (error instanceof ApprovalAuthorityError && error.code !== 'APPROVAL_STORE_CORRUPT' && error.code !== 'APPROVAL_STORE_CLOSED' && error.code !== 'APPROVAL_STORE_UNSUPPORTED') {
        await settle(authorized, { outcome: 'refused', code: error.code });
        return { outcome: 'refused', commitment, evidence, evidenceDigest, code: error.code, reasonCode: error.reasonCode ?? null };
      }
      // Whether CORE-05 recorded it is unknown here; `outcome()` reads it from CORE-05. The challenge never authorizes again.
      throw error;
    }
    const verdictRowDigest = verdictCiting(approval, contract.operatorId, evidenceDigest);
    if (verdictRowDigest === undefined) throw new ApprovalAuthorityError('APPROVAL_STORE_CORRUPT', 'CORE-05 accepted the passkey decision but its view holds no verdict citing it.');
    await settle(authorized, { outcome: 'recorded', verdictRowDigest });
    return { outcome: 'recorded', commitment, evidence, evidenceDigest, verdictRowDigest, approval };
  }
}
