import { createHash } from 'node:crypto';

/**
 * CORE-05 — the signed state of an approval store.
 *
 * A completed approval resumes a withheld decision into a grant, so the
 * approval log is **authority-material** exactly as CORE-04's discharge log
 * is, and it is committed the same way: a hash chain over the store's whole
 * append-only history, from a genesis bound to the store's random id and its
 * organization, whose head `{storeId, organizationId, sequence, chainDigest}`
 * is signed by the deployment's authority key under its own domain
 * (`frontera:authority-artifact:approval-state:v1`). A database-only writer
 * without the key can neither insert an approval, alter one, delete a
 * rejection or a revocation, reorder rows, nor transplant
 * a genuine row from another store: each changes the chain, and it cannot sign
 * a new head.
 *
 * This file is a leaf: pure serialization and hashing, imported by both the
 * store and the authority-authenticity signing boundary.
 */

export const APPROVAL_CHAIN_FORMAT = 'frontera.approval-chain.v1';

/**
 * The facts an approval log records — approval-runtime's decision vocabulary
 * (`ApprovalDecisionAttemptType` plus revocation), never a state. `requested`
 * is written by the governed path; every other kind by the trusted command
 * service, attributed to the authenticated actor who gave it.
 */
export type ApprovalRecordKind = 'requested' | 'approved' | 'rejected' | 'requested_changes' | 'escalated' | 'revoked';

export const APPROVAL_RECORD_KINDS: readonly ApprovalRecordKind[] = ['approved', 'escalated', 'rejected', 'requested', 'requested_changes', 'revoked'];

export interface ApprovalStateCommitment {
  /** The store's random identity, created with it. Binds every row and the head to this store. */
  readonly storeId: string;
  /** The one organization this store records for. */
  readonly organizationId: string;
  /** How many rows the committed history holds. `0` is the signed genesis. */
  readonly sequence: number;
  /** `sha256:<hex>` — the chain head over every row, in sequence order. */
  readonly chainDigest: string;
}

/** Exactly the fields an approval row commits to. Everything a read relies on is in here. */
export interface ApprovalRowContent {
  readonly organizationId: string;
  /** The governed request the approval is about — `H(org, principal, idempotencyKey)`. */
  readonly requestId: string;
  /** The committed decision the approval is about. One request has one committed decision. */
  readonly decisionId: string;
  /** `sha256:<hex>` over the canonical approval subject: exactly what was decided, under exactly which requirement. */
  readonly subjectDigest: string;
  readonly kind: ApprovalRecordKind;
  /** `requested` only: the canonical subject text, so an approver is shown the bytes the digest was taken over. */
  readonly subject?: string;
  /** Every kind but `requested`: the authenticated Kernel-Authority actor who gave the verdict or revoked. Taken from the trusted command context, never from a command. */
  readonly actorId?: string;
  /** Verdicts only: canonical JSON of the evidence the actor reviewed (`[{hash, type, uri?}]`, sorted). Its hashes are part of the row digest and so of any proof counting it. */
  readonly evidence?: string;
  /** An opaque note (a ticket, a comment reference, a revocation reason). Recorded, never interpreted. */
  readonly reason?: string;
  /** Who recorded the row: the governed path itself for `requested`, the authentication channel of the command context otherwise. */
  readonly recordedBy: string;
  readonly recordedAt: string;
}

function sha256(text: string): string {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

const quote = (value: string): string => JSON.stringify(value);

/** Canonical bytes of one row, bound to its store and its position. Keys fixed and sorted; absent optional fields omitted. */
export function serializeApprovalRow(storeId: string, sequence: number, row: ApprovalRowContent): string {
  if (!Number.isSafeInteger(sequence) || sequence < 1) throw new RangeError('An approval row sequence is a positive integer.');
  return [
    '{',
    [
      ...(row.actorId !== undefined ? [`"actorId":${quote(row.actorId)}`] : []),
      `"decisionId":${quote(row.decisionId)}`,
      ...(row.evidence !== undefined ? [`"evidence":${quote(row.evidence)}`] : []),
      `"format":${quote(APPROVAL_CHAIN_FORMAT)}`,
      `"kind":${quote(row.kind)}`,
      `"organizationId":${quote(row.organizationId)}`,
      ...(row.reason !== undefined ? [`"reason":${quote(row.reason)}`] : []),
      `"recordedAt":${quote(row.recordedAt)}`,
      `"recordedBy":${quote(row.recordedBy)}`,
      `"requestId":${quote(row.requestId)}`,
      `"sequence":${String(sequence)}`,
      `"storeId":${quote(storeId)}`,
      ...(row.subject !== undefined ? [`"subject":${quote(row.subject)}`] : []),
      `"subjectDigest":${quote(row.subjectDigest)}`,
    ].join(','),
    '}',
  ].join('');
}

export function approvalRowDigest(storeId: string, sequence: number, row: ApprovalRowContent): string {
  return sha256(serializeApprovalRow(storeId, sequence, row));
}

/** The chain head before any row: bound to the store and the organization, so no other store's history can start here. */
export function approvalGenesisDigest(storeId: string, organizationId: string): string {
  return sha256(`${APPROVAL_CHAIN_FORMAT}\ngenesis\n{"organizationId":${quote(organizationId)},"storeId":${quote(storeId)}}`);
}

/** The chain head after appending one row whose digest is `rowDigest`. */
export function nextApprovalChainDigest(previous: string, rowDigest: string): string {
  return sha256(`${APPROVAL_CHAIN_FORMAT}\nlink\n{"previous":${quote(previous)},"row":${quote(rowDigest)}}`);
}

/** Canonical bytes of the committed head — what the authority key signs. */
export function serializeApprovalStateCommitment(state: ApprovalStateCommitment): string {
  return `{"chainDigest":${quote(state.chainDigest)},"organizationId":${quote(state.organizationId)},"sequence":${String(state.sequence)},"storeId":${quote(state.storeId)}}`;
}
