import type { ObligationDischargeCorrelation, StoredObligationDischarge } from './contracts.js';
import { ObligationDischargeError } from './errors.js';
import {
  nextObligationDischargeChainDigest,
  obligationDischargeGenesisDigest,
  obligationDischargeRowDigest,
  type ObligationDischargeStateCommitment,
} from './state-commitment.js';

function corrupt(message: string): never {
  throw new ObligationDischargeError('OBLIGATION_DISCHARGE_STORE_CORRUPT', message);
}

/**
 * Recomputes a store's whole history against its committed head.
 *
 * Every row must sit at its exact position (1…n, contiguous), belong to the
 * store's organization, carry the digest of its content bound to this store and
 * that position, and the chain over all of them must end exactly at the
 * committed head. An inserted, altered, deleted, reordered or transplanted row
 * fails, and so does the whole read: a history that does not verify is not
 * partially believed.
 */
export function verifyObligationDischargeHistory(rows: readonly StoredObligationDischarge[], state: ObligationDischargeStateCommitment): void {
  if (!Number.isSafeInteger(state.sequence) || state.sequence < 0 || rows.length !== state.sequence) corrupt('The discharge history does not have the committed length.');
  let chain = obligationDischargeGenesisDigest(state.storeId, state.organizationId);
  for (const [index, row] of rows.entries()) {
    const { sequence, digest, ...content } = row;
    if (sequence !== index + 1) corrupt('The discharge history is not contiguous.');
    if (row.organizationId !== state.organizationId) corrupt('A discharge row belongs to another organization.');
    const expected = obligationDischargeRowDigest(state.storeId, sequence, content);
    if (digest !== expected) corrupt('A discharge row does not match its digest.');
    chain = nextObligationDischargeChainDigest(chain, digest);
  }
  if (chain !== state.chainDigest) corrupt('The discharge history does not match the committed state.');
}

/** The rows of one decision correlation, from an already-verified history. */
export function rowsForCorrelation(rows: readonly StoredObligationDischarge[], correlation: ObligationDischargeCorrelation): readonly StoredObligationDischarge[] {
  return rows.filter(
    (row) => row.correlation.requestId === correlation.requestId && row.correlation.action === correlation.action && row.correlation.resourceScope === correlation.resourceScope,
  );
}
