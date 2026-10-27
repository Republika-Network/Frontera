import { createHash } from 'node:crypto';

import { HUMAN_PASSKEY_DECISION_CHANNEL } from '../approval-authority/human-decision.js';
import { approvalSubjectDigest, canonicalApprovalSubject, type ApprovalSubject } from '../approval-authority/subject.js';
import { executionIdForGrant } from '../authority-authenticity/execution-capability-issuance.js';
import { createAuthoritySignatureRegistry, type TrustedVerificationKey } from '../authority-authenticity/signature-verification.js';
import { executionCapabilitySigningBytes, parseExecutionCapability, type ExecutionCapability } from '../execution-capability/capability.js';
import { createExecutorReceiptVerifier, executorReceiptDigest, type ExecutorReceipt, type TrustedExecutor } from '../executor-receipt/index.js';
import { canonicalSerialize } from '../governance-store/canonical-json.js';

/**
 * AUTH-04D2S — independent verification of one synthetic governed execution.
 *
 * Pure: it reads nothing, writes nothing, signs nothing and holds no key. It is
 * given what the Host already records — the CORE-05 approval, the ASSURE-01
 * trace's final state and its verification, the G-02B issuance (the capability
 * the Host's custody signed) and the G-02C1D receipt evidence (the executor's
 * signed receipt, as presented) — and re-checks every link itself under keys
 * the caller pinned:
 *
 * ```
 * approval   subject re-serialized and re-digested; status approved; a counted
 *            human passkey verdict (AUTH-03 channel) when required
 *   ↓ requestId, decisionId
 * execution  executionId = H(requestId, decisionId), recomputed (the derivation the governed path uses)
 *   ↓ executionId
 * capability canonical; signed by a pinned authority key of its issuer; same organization,
 *            action and resource as the approved subject; a synthetic action; expires no later than the approval
 *   ↓ capabilityId, executionId, actionBinding
 * receipt    canonical; signed by the pinned executor key; scope permitted; same identities and binding;
 *            the newest of a valid chain; completed-observed over a durable completed consumption
 * ```
 *
 * The result is one of five statuses, and never more than the evidence shows:
 *
 * | Status | Meaning |
 * |---|---|
 * | `NOT_AUTHORIZED` | no approved CORE-05 verdict for exactly this subject: nothing here may be called authorized |
 * | `AUTHORIZED` | approved, and no execution has been observed. Authorization is not execution |
 * | `DELIVERY_FAILED` | approved, the governed path recorded a definite non-completion, and nothing was presented to an executor |
 * | `SIMULATED_SUCCESS` | approved, and a pinned synthetic executor signed that it recorded the one synthetic effect for exactly this execution |
 * | `EXECUTION_UNKNOWN` | anything else: missing, unverifiable, contradictory or unconfirmed evidence. Fail closed |
 *
 * `SIMULATED_SUCCESS` is a simulation by construction: the action is a
 * `synthetic.*` action and the observation is a synthetic record. It is never
 * an external business result, a payment or a deployment.
 */

export const SYNTHETIC_EXECUTION_VERIFICATION_FORMAT = 'frontera.synthetic-execution-verification.v1';
export const SYNTHETIC_EXECUTION_VERIFICATION_DIGEST_DOMAIN = 'frontera.synthetic-execution-verification.digest.v1';

export const SYNTHETIC_EXECUTION_STATUSES = Object.freeze(['NOT_AUTHORIZED', 'AUTHORIZED', 'DELIVERY_FAILED', 'SIMULATED_SUCCESS', 'EXECUTION_UNKNOWN'] as const);
export type SyntheticExecutionStatus = (typeof SYNTHETIC_EXECUTION_STATUSES)[number];

/** Why the status is what it is: the first check that decided it. Closed codes only. */
export const SYNTHETIC_EXECUTION_REASONS = Object.freeze([
  'APPROVAL_MISSING',
  'APPROVAL_NOT_APPROVED',
  'APPROVAL_SUBJECT_MISMATCH',
  'APPROVAL_NOT_HUMAN_PASSKEY',
  'TRACE_MISMATCH',
  'TRACE_UNVERIFIED',
  'NOT_EXECUTED',
  'DELIVERY_NOT_COMPLETED',
  'CAPABILITY_MISSING',
  'CAPABILITY_INVALID',
  'CAPABILITY_SIGNATURE_INVALID',
  'CAPABILITY_MISMATCH',
  'ACTION_NOT_SYNTHETIC',
  'RECEIPT_MISSING',
  'RECEIPT_INVALID',
  'RECEIPT_CONFLICTING',
  'RECEIPT_NOT_COMPLETED',
  'OUTCOME_UNCONFIRMED',
  'VERIFIED',
] as const);
export type SyntheticExecutionReason = (typeof SYNTHETIC_EXECUTION_REASONS)[number];

/** The CORE-05 approval as its command port shows it: the fields this verification reads. */
export interface SyntheticExecutionApprovalInput {
  readonly approvalRequestId: string;
  readonly requestId: string;
  readonly decisionId: string;
  readonly subjectDigest: string;
  readonly subject: ApprovalSubject;
  readonly state: {
    readonly status: string;
    readonly approvers: readonly string[];
    readonly notAfter?: string;
    readonly approvalDigest?: string;
    readonly verdicts: readonly { readonly kind: string; readonly actorId: string; readonly counted: boolean; readonly recordedBy: string; readonly rowDigest: string }[];
  };
}

/** The ASSURE-01 trace (its canonical identities and final state) and whether its own verification passed. */
export interface SyntheticExecutionTraceInput {
  readonly requestId: string;
  readonly organizationId: string;
  readonly decisionId: string;
  readonly executionId?: string;
  readonly finalState: string;
  readonly verified: boolean;
}

/** The G-02B issuance row: the capability canonical text and the signature custody returned (only when issued). */
export interface SyntheticExecutionIssuanceInput {
  readonly state: string;
  readonly canonical?: string;
  readonly signature?: unknown;
}

/** The G-02C1D evidence: every observation of a presented exchange, and every accepted receipt as presented. */
export interface SyntheticExecutionEvidenceInput {
  readonly observations: readonly { readonly transmission: string; readonly httpOutcome: string; readonly disposition: string; readonly agreement: string }[];
  readonly receipts: readonly { readonly sequence: number; readonly presented: { readonly receipt: string; readonly signature: unknown } }[];
}

export interface SyntheticExecutionVerificationInput {
  readonly approval: SyntheticExecutionApprovalInput | null;
  readonly trace: SyntheticExecutionTraceInput;
  readonly issuance: SyntheticExecutionIssuanceInput | null;
  readonly evidence: SyntheticExecutionEvidenceInput;
}

export interface SyntheticExecutionVerifierOptions {
  /** The issuing Host's capability issuer and every authority key pinned for it. Public keys only. */
  readonly trustedIssuer: { readonly issuer: string; readonly keys: readonly TrustedVerificationKey[] };
  /** The synthetic executors pinned by the verifier, as G-02C1C pins them. */
  readonly trustedExecutors: readonly TrustedExecutor[];
  /** The `synthetic.*` actions a synthetic execution may name. */
  readonly syntheticActions: readonly string[];
  /** Require the counted approving verdict to be an AUTH-03 human passkey decision. Default `true`. */
  readonly requireHumanPasskeyDecision?: boolean;
}

export interface SyntheticExecutionVerification {
  readonly format: typeof SYNTHETIC_EXECUTION_VERIFICATION_FORMAT;
  readonly status: SyntheticExecutionStatus;
  readonly reason: SyntheticExecutionReason;
  readonly organizationId: string;
  readonly requestId: string;
  readonly decisionId: string;
  /** The governed path's execution id: the idempotency key of the one logical execution. */
  readonly executionId: string;
  readonly approval: {
    readonly approvalRequestId: string;
    readonly subjectDigest: string;
    readonly approvalDigest: string | null;
    readonly approvedBy: readonly string[];
    readonly channel: string | null;
  } | null;
  readonly operation: { readonly action: string; readonly resource: string } | null;
  readonly capability: { readonly capabilityId: string; readonly issuer: string; readonly issuerKeyId: string; readonly audience: string; readonly actionBindingDigest: string; readonly issuedAt: string; readonly expiresAt: string } | null;
  readonly receipt: {
    readonly executorId: string;
    readonly executorKeyId: string;
    readonly receiptId: string;
    readonly receiptDigest: string;
    readonly outcome: string;
    readonly observedAt: string;
    readonly observationDigest: string | null;
  } | null;
  /** Stated, never implied: a synthetic record is not an external effect. */
  readonly externalEffect: 'none-synthetic-only';
  /** `sha256:` over the domain and the canonical record without this field. */
  readonly verificationDigest: string;
}

export class SyntheticExecutionVerifierConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SyntheticExecutionVerifierConfigurationError';
  }
}

export interface SyntheticExecutionVerifier {
  verify(input: SyntheticExecutionVerificationInput): SyntheticExecutionVerification;
}

const EXECUTED_COMPLETED = 'executed-confirmed-completed';
const EXECUTED_NOT_COMPLETED = 'executed-confirmed-not-completed';
/** Final states in which nothing was attempted: authorized at most. */
const NOT_ATTEMPTED = new Set(['approval-pending', 'not-executed', 'withheld-at-exercise']);

function digestOf(record: Omit<SyntheticExecutionVerification, 'verificationDigest'>): string {
  const hash = createHash('sha256').update(`${SYNTHETIC_EXECUTION_VERIFICATION_DIGEST_DOMAIN}\n${canonicalSerialize(record)}`, 'utf8').digest('hex');
  return `sha256:${hash}`;
}

export function createSyntheticExecutionVerifier(options: SyntheticExecutionVerifierOptions): SyntheticExecutionVerifier {
  if (options.syntheticActions.length === 0 || options.syntheticActions.some((action) => !action.startsWith('synthetic.') || action.length <= 'synthetic.'.length)) {
    throw new SyntheticExecutionVerifierConfigurationError('syntheticActions must list at least one synthetic.* action, and only those.');
  }
  // Both registries refuse an empty or ambiguous key set at construction: a misconfiguration fails here, not per call.
  const authority = createAuthoritySignatureRegistry(options.trustedIssuer.keys);
  const receipts = createExecutorReceiptVerifier({ trustedExecutors: options.trustedExecutors });
  const synthetic = new Set(options.syntheticActions);
  const requireHuman = options.requireHumanPasskeyDecision !== false;

  function verify(input: SyntheticExecutionVerificationInput): SyntheticExecutionVerification {
    const { trace } = input;
    // The governed path's derivation reads the request and decision alone; action and scope complete the correlation's shape.
    const executionId = executionIdForGrant({
      correlation: { requestId: trace.requestId, decisionId: trace.decisionId, action: input.approval?.subject.action ?? '', resourceScope: input.approval?.subject.resourceScope ?? '' },
    });
    let approvalPart: SyntheticExecutionVerification['approval'] = null;
    let operation: SyntheticExecutionVerification['operation'] = null;
    let capabilityPart: SyntheticExecutionVerification['capability'] = null;
    let receiptPart: SyntheticExecutionVerification['receipt'] = null;

    const result = (status: SyntheticExecutionStatus, reason: SyntheticExecutionReason): SyntheticExecutionVerification => {
      const record = {
        format: SYNTHETIC_EXECUTION_VERIFICATION_FORMAT,
        status,
        reason,
        organizationId: trace.organizationId,
        requestId: trace.requestId,
        decisionId: trace.decisionId,
        executionId,
        approval: approvalPart,
        operation,
        capability: capabilityPart,
        receipt: receiptPart,
        externalEffect: 'none-synthetic-only',
      } as const;
      return Object.freeze({ ...record, verificationDigest: digestOf(record) });
    };

    // 1. The approval: exactly this request and decision, an intact subject, approved, by a human passkey verdict.
    const approval = input.approval;
    if (approval === null) return result('NOT_AUTHORIZED', 'APPROVAL_MISSING');
    const subject = approval.subject;
    let recomputed: string;
    try {
      recomputed = approvalSubjectDigest(canonicalApprovalSubject(subject));
    } catch {
      return result('NOT_AUTHORIZED', 'APPROVAL_SUBJECT_MISMATCH');
    }
    if (
      recomputed !== approval.subjectDigest ||
      approval.requestId !== trace.requestId ||
      approval.decisionId !== trace.decisionId ||
      subject.requestId !== trace.requestId ||
      subject.decisionId !== trace.decisionId ||
      subject.organizationId !== trace.organizationId
    ) {
      return result('NOT_AUTHORIZED', 'APPROVAL_SUBJECT_MISMATCH');
    }
    const approving = approval.state.verdicts.filter((verdict) => verdict.kind === 'approved' && verdict.counted);
    const channel = approving.length > 0 && approving.every((verdict) => verdict.recordedBy === approving[0]?.recordedBy) ? (approving[0]?.recordedBy ?? null) : null;
    approvalPart = { approvalRequestId: approval.approvalRequestId, subjectDigest: approval.subjectDigest, approvalDigest: approval.state.approvalDigest ?? null, approvedBy: [...approval.state.approvers], channel };
    operation = { action: subject.action, resource: subject.resourceScope };
    // `approval-expired` is an approval whose window has since closed: it can still account for an execution that ran
    // inside the window (checked against the capability below), never for one that has not.
    const status = approval.state.status;
    const lapsed = status === 'approval-expired';
    const notAfter = approval.state.notAfter;
    if ((status !== 'approved' && !lapsed) || approving.length === 0 || notAfter === undefined) return result('NOT_AUTHORIZED', 'APPROVAL_NOT_APPROVED');
    if (status === 'approved' && approval.state.approvalDigest === undefined) return result('NOT_AUTHORIZED', 'APPROVAL_NOT_APPROVED');
    if (requireHuman && approving.some((verdict) => verdict.recordedBy !== HUMAN_PASSKEY_DECISION_CHANNEL)) return result('NOT_AUTHORIZED', 'APPROVAL_NOT_HUMAN_PASSKEY');

    // 2. The trace: this execution, and a verified projection. A trace that names another execution is a contradiction.
    if (trace.executionId !== undefined && trace.executionId !== executionId) return result('EXECUTION_UNKNOWN', 'TRACE_MISMATCH');
    if (!trace.verified) return result('EXECUTION_UNKNOWN', 'TRACE_UNVERIFIED');

    const issued = input.issuance !== null && input.issuance.state !== 'absent';
    const presentedAnything = input.evidence.observations.some((observation) => observation.transmission !== 'not-sent') || input.evidence.receipts.length > 0;

    // 3. Nothing attempted: authorized, and no more — unless something was issued or presented anyway.
    if (NOT_ATTEMPTED.has(trace.finalState)) {
      if (issued || presentedAnything) return result('EXECUTION_UNKNOWN', 'NOT_EXECUTED');
      return lapsed ? result('NOT_AUTHORIZED', 'APPROVAL_NOT_APPROVED') : result('AUTHORIZED', 'NOT_EXECUTED');
    }
    // 4. A definite non-completion with nothing presented to an executor: a failed delivery, never a success.
    if (trace.finalState === EXECUTED_NOT_COMPLETED) {
      return presentedAnything ? result('EXECUTION_UNKNOWN', 'DELIVERY_NOT_COMPLETED') : result('DELIVERY_FAILED', 'DELIVERY_NOT_COMPLETED');
    }
    if (trace.finalState !== EXECUTED_COMPLETED) return result('EXECUTION_UNKNOWN', 'OUTCOME_UNCONFIRMED');

    // 5. The capability the Host's custody signed for this execution, re-verified under the pinned authority key.
    if (input.issuance === null || input.issuance.state !== 'issued' || input.issuance.canonical === undefined) return result('EXECUTION_UNKNOWN', 'CAPABILITY_MISSING');
    const parsed = parseExecutionCapability(input.issuance.canonical);
    if (!parsed.ok) return result('EXECUTION_UNKNOWN', 'CAPABILITY_INVALID');
    const capability: ExecutionCapability = parsed.capability;
    const signed = authority.verify(executionCapabilitySigningBytes(capability), input.issuance.signature);
    if (!signed.verified || capability.issuer !== options.trustedIssuer.issuer || signed.keyId !== capability.issuerKeyId) return result('EXECUTION_UNKNOWN', 'CAPABILITY_SIGNATURE_INVALID');
    capabilityPart = {
      capabilityId: capability.capabilityId,
      issuer: capability.issuer,
      issuerKeyId: capability.issuerKeyId,
      audience: capability.audience,
      actionBindingDigest: capability.actionBinding.digest,
      issuedAt: capability.issuedAt,
      expiresAt: capability.expiresAt,
    };
    if (
      capability.executionId !== executionId ||
      capability.organizationId !== trace.organizationId ||
      capability.action !== subject.action ||
      capability.resource !== subject.resourceScope ||
      Date.parse(capability.expiresAt) > Date.parse(notAfter)
    ) {
      return result('EXECUTION_UNKNOWN', 'CAPABILITY_MISMATCH');
    }
    if (!synthetic.has(capability.action)) return result('EXECUTION_UNKNOWN', 'ACTION_NOT_SYNTHETIC');

    // 6. The executor's receipt: the newest of a valid chain, signed by the pinned executor, about exactly this capability.
    if (input.evidence.observations.some((observation) => observation.disposition === 'receipt-conflicting')) return result('EXECUTION_UNKNOWN', 'RECEIPT_CONFLICTING');
    if (input.evidence.receipts.length === 0) return result('EXECUTION_UNKNOWN', 'RECEIPT_MISSING');
    const history = input.evidence.receipts.map((entry) => entry.presented);
    const chain = receipts.assessHistory(history);
    if (chain.chain !== 'valid' || chain.current === null || chain.rejected > 0) return result('EXECUTION_UNKNOWN', chain.chain === 'conflicting' ? 'RECEIPT_CONFLICTING' : 'RECEIPT_INVALID');
    const newest = [...input.evidence.receipts].sort((a, b) => b.sequence - a.sequence)[0];
    if (newest === undefined) return result('EXECUTION_UNKNOWN', 'RECEIPT_MISSING');
    const checked = receipts.verify(newest.presented, {
      expected: {
        issuer: capability.issuer,
        capabilityId: capability.capabilityId,
        executionId,
        audience: capability.audience,
        organizationId: capability.organizationId,
        trustDomain: capability.trustDomain,
        actionBinding: capability.actionBinding,
      },
      history,
    });
    const receipt: ExecutorReceipt | null = checked.receipt;
    if (checked.failure !== null || receipt === null || checked.signature !== 'valid' || checked.identityMatch !== 'yes' || checked.bindingMatch !== 'yes' || checked.receiptState !== 'current' || receipt.receiptId !== chain.current) {
      return result('EXECUTION_UNKNOWN', 'RECEIPT_INVALID');
    }
    receiptPart = {
      executorId: receipt.executorId,
      executorKeyId: receipt.executorKeyId,
      receiptId: receipt.receiptId,
      receiptDigest: executorReceiptDigest(newest.presented.receipt),
      outcome: receipt.outcome,
      observedAt: receipt.observedAt,
      observationDigest: receipt.observation?.digest ?? null,
    };
    if (receipt.outcome !== 'completed-observed' || receipt.consumption.ledgerState !== 'completed' || receipt.observation === null) return result('EXECUTION_UNKNOWN', 'RECEIPT_NOT_COMPLETED');
    // The Host's own observation of that exchange must agree: a completed HTTP exchange, the receipt correlated and consistent.
    if (!input.evidence.observations.some((observation) => observation.disposition === 'receipt-correlated' && observation.agreement === 'consistent' && observation.httpOutcome === 'completed')) {
      return result('EXECUTION_UNKNOWN', 'RECEIPT_INVALID');
    }
    return result('SIMULATED_SUCCESS', 'VERIFIED');
  }

  return Object.freeze({ verify });
}
