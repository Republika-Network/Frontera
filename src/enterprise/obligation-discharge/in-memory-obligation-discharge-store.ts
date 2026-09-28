import type { ObligationDischargeCorrelation, ObligationDischargeStore, StoredObligationDischarge } from './contracts.js';
import { ObligationDischargeError } from './errors.js';
import { verifiedDischargeRows } from './integrity.js';

/**
 * The ephemeral discharge store, for `memory` persistence. Same contract and
 * the same read-time verification as the durable one; it simply does not
 * survive a restart, and says so (`kind: 'ephemeral'`).
 */
export function createInMemoryObligationDischargeStore(): ObligationDischargeStore {
  const rows: StoredObligationDischarge[] = [];
  let closed = false;
  const open = (): void => {
    if (closed) throw new ObligationDischargeError('OBLIGATION_DISCHARGE_STORE_CLOSED', 'The obligation discharge store is closed.');
  };
  return {
    kind: 'ephemeral',
    append(row: StoredObligationDischarge): Promise<void> {
      open();
      rows.push(Object.freeze({ ...row, correlation: Object.freeze({ ...row.correlation }) }));
      return Promise.resolve();
    },
    read(organizationId: string, correlation: ObligationDischargeCorrelation): Promise<readonly StoredObligationDischarge[]> {
      try {
        open();
        const matching = rows.filter(
          (row) =>
            row.organizationId === organizationId &&
            row.correlation.requestId === correlation.requestId &&
            row.correlation.action === correlation.action &&
            row.correlation.resourceScope === correlation.resourceScope,
        );
        return Promise.resolve(verifiedDischargeRows(matching, organizationId, correlation));
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    },
    close(): Promise<void> {
      closed = true;
      return Promise.resolve();
    },
  };
}
