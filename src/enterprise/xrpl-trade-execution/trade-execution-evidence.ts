import { computeDigest } from '../governance-store/digest.js';
import type { TradeSubmissionRecord } from './sqlite-trade-sequence-interlock.js';

/**
 * TRADE-04C — the trade-specific tail of the ASSURE-01 authority-to-outcome
 * chain. ASSURE-01's trace already joins the governed request, decision,
 * policy, trusted facts, approvals, grant and P11 execution (its `execution`
 * stage names this adapter and the transaction hash as `providerRef`). This
 * record continues that chain from the same identifiers (`requestId`,
 * `decisionId`, `boundedGrantId`, `executionId`) through the ledger facts the
 * executor relied on and the durable reservation's lifecycle — a projection
 * of the trade interlock's own verified row, never a second evidence store.
 *
 * Public identifiers, digests and ledger references only: no key, credential,
 * signed blob, price strategy or engine context. `ledgerProvenance` says
 * whether the ledger facts came from the configured XRPL network or from a
 * client injected by in-process composition (offline qualification); nothing
 * here ever claims more.
 */
export const TRADE_EXECUTION_EVIDENCE_SCHEMA = 'frontera.trade-execution-evidence.v1';

/** What the durable record proves about the one transaction — never a fill, a resting offer or a settlement of funds. */
export type TradeExecutionEvidenceStatus =
  | 'signed-not-submitted'
  | 'submission-attempted'
  | 'submission-uncertain'
  | 'validated-applied'
  | 'validated-rejected'
  | 'malformed-rejected'
  | 'proven-not-included';

export interface TradeExecutionEvidenceRecord {
  readonly schema: typeof TRADE_EXECUTION_EVIDENCE_SCHEMA;
  readonly executionId: string;
  readonly status: TradeExecutionEvidenceStatus;
  readonly ledgerProvenance: 'xrpl-network' | 'injected-ledger-client';
  readonly authority: { readonly organizationId: string; readonly subject: string; readonly requestId: string; readonly decisionId: string; readonly boundedGrantId: string; readonly proposalDigest: string };
  readonly ledger: {
    readonly networkId: number;
    readonly referenceLedgerIndex: number;
    readonly referenceLedgerHash: string;
    readonly delegationLedgerIndex: number;
    readonly delegateRootLedgerIndex: number;
    readonly ownerRootLedgerIndex: number;
    readonly delegationAssessmentDigest: string;
    readonly delegationFactsDigest: string;
    readonly keyAuthority: 'master-key' | 'regular-key';
  };
  readonly order: { readonly ownerAccount: string; readonly delegateAccount: string; readonly preparedDigest: string; readonly sequence: number; readonly lastLedgerSequence: number; readonly minLedger: number; readonly fee: string };
  readonly signature: { readonly signerId: string; readonly signerRequestId: string; readonly signingPublicKey: string; readonly transactionHash: string };
  readonly reservation: {
    readonly state: TradeSubmissionRecord['state'];
    readonly settlement?: string;
    readonly submissionAttempts: number;
    readonly reservedAt: string;
    readonly transitions: TradeSubmissionRecord['transitions'];
  };
  readonly digest: string;
}

function statusOf(record: TradeSubmissionRecord): TradeExecutionEvidenceStatus {
  if (record.settlement === 'validated-success') return 'validated-applied';
  if (record.settlement === 'validated-failure') return 'validated-rejected';
  if (record.settlement === 'malformed') return 'malformed-rejected';
  if (record.settlement === 'expired') return 'proven-not-included';
  if (record.state === 'reserved') return 'signed-not-submitted';
  if (record.state === 'unconfirmed') return 'submission-uncertain';
  return 'submission-attempted';
}

export function tradeExecutionEvidenceOf(record: TradeSubmissionRecord, networkId: number): TradeExecutionEvidenceRecord {
  const e = record.evidence;
  const body = {
    schema: TRADE_EXECUTION_EVIDENCE_SCHEMA,
    executionId: record.executionId,
    status: statusOf(record),
    ledgerProvenance: e.ledgerProvenance,
    authority: { organizationId: e.organizationId, subject: e.subject, requestId: e.requestId, decisionId: e.decisionId, boundedGrantId: e.boundedGrantId, proposalDigest: e.proposalDigest },
    ledger: {
      networkId,
      referenceLedgerIndex: e.referenceLedgerIndex,
      referenceLedgerHash: e.referenceLedgerHash,
      delegationLedgerIndex: e.delegationLedgerIndex,
      delegateRootLedgerIndex: e.delegateRootLedgerIndex,
      ownerRootLedgerIndex: e.ownerRootLedgerIndex,
      delegationAssessmentDigest: e.delegationAssessmentDigest,
      delegationFactsDigest: e.delegationFactsDigest,
      keyAuthority: e.keyAuthority,
    },
    order: { ownerAccount: record.account, delegateAccount: e.delegateAccount, preparedDigest: e.preparedDigest, sequence: record.sequence, lastLedgerSequence: record.lastLedgerSequence, minLedger: record.minLedger, fee: e.fee },
    signature: { signerId: e.signerId, signerRequestId: e.signerRequestId, signingPublicKey: e.signingPublicKey, transactionHash: record.transactionHash },
    reservation: {
      state: record.state,
      ...(record.settlement !== undefined ? { settlement: record.settlement } : {}),
      submissionAttempts: record.submissionAttempts,
      reservedAt: record.reservedAt,
      transitions: record.transitions,
    },
  };
  return Object.freeze({ ...body, digest: computeDigest(body) }) as TradeExecutionEvidenceRecord;
}
