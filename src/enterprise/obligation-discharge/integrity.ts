import { computeDigest } from '../governance-store/digest.js';
import type { ObligationDischargeCorrelation, StoredObligationDischarge } from './contracts.js';
import { ObligationDischargeError } from './errors.js';

/** Domain tag of a stored discharge row's digest. */
export const OBLIGATION_DISCHARGE_ROW_FORMAT = 'frontera.obligation-discharge.v1';

/** The digest a row must carry: every field but the digest itself, canonical JSON, under the format tag. */
export function obligationDischargeRowDigest(row: Omit<StoredObligationDischarge, 'digest'>): string {
  return computeDigest({
    format: OBLIGATION_DISCHARGE_ROW_FORMAT,
    organizationId: row.organizationId,
    correlation: { requestId: row.correlation.requestId, action: row.correlation.action, resourceScope: row.correlation.resourceScope },
    obligationType: row.obligationType,
    sourceId: row.sourceId,
    outcome: row.outcome,
    observedAt: row.observedAt,
    ...(row.reference !== undefined ? { reference: row.reference } : {}),
    ...(row.subjectId !== undefined ? { subjectId: row.subjectId } : {}),
    recordedBy: row.recordedBy,
    recordedAt: row.recordedAt,
  });
}

/** Refuses the whole read if any row does not verify, or belongs to another organization or correlation than was asked for. */
export function verifiedDischargeRows(
  rows: readonly StoredObligationDischarge[],
  organizationId: string,
  correlation: ObligationDischargeCorrelation,
): readonly StoredObligationDischarge[] {
  for (const row of rows) {
    const { digest, ...content } = row;
    if (
      digest !== obligationDischargeRowDigest(content) ||
      row.organizationId !== organizationId ||
      row.correlation.requestId !== correlation.requestId ||
      row.correlation.action !== correlation.action ||
      row.correlation.resourceScope !== correlation.resourceScope
    ) {
      throw new ObligationDischargeError('OBLIGATION_DISCHARGE_STORE_CORRUPT', 'A stored obligation discharge failed verification; no report from this store is believed.');
    }
  }
  return rows;
}
