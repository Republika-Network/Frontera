import type { StoredApprovalRecord } from './contracts.js';
import { ApprovalAuthorityError } from './errors.js';
import { APPROVAL_RECORD_KINDS, approvalGenesisDigest, approvalRowDigest, nextApprovalChainDigest, type ApprovalStateCommitment } from './state-commitment.js';

function corrupt(message: string): never {
  throw new ApprovalAuthorityError('APPROVAL_STORE_CORRUPT', message);
}

/**
 * Recomputes a store's whole history against its committed head.
 *
 * Every row must sit at its exact position (1…n, contiguous), belong to the
 * store's organization, be one of the four record kinds, carry the digest of
 * its content bound to this store and that position, and the chain over all of
 * them must end exactly at the committed head. An inserted, altered, deleted,
 * reordered or transplanted row fails, and so does the whole read: a history
 * that does not verify is not partially believed.
 */
export function verifyApprovalHistory(rows: readonly StoredApprovalRecord[], state: ApprovalStateCommitment): void {
  if (!Number.isSafeInteger(state.sequence) || state.sequence < 0 || rows.length !== state.sequence) corrupt('The approval history does not have the committed length.');
  let chain = approvalGenesisDigest(state.storeId, state.organizationId);
  for (const [index, row] of rows.entries()) {
    const { sequence, digest, ...content } = row;
    if (sequence !== index + 1) corrupt('The approval history is not contiguous.');
    if (row.organizationId !== state.organizationId) corrupt('An approval row belongs to another organization.');
    if (!APPROVAL_RECORD_KINDS.includes(row.kind)) corrupt('An approval row is not a known record kind.');
    const expected = approvalRowDigest(state.storeId, sequence, content);
    if (digest !== expected) corrupt('An approval row does not match its digest.');
    chain = nextApprovalChainDigest(chain, digest);
  }
  if (chain !== state.chainDigest) corrupt('The approval history does not match the committed state.');
}

/** The rows of one governed request (every row without one), from an already-verified history. */
export function rowsForRequest(rows: readonly StoredApprovalRecord[], requestId: string | undefined): readonly StoredApprovalRecord[] {
  return requestId === undefined ? rows : rows.filter((row) => row.requestId === requestId);
}
