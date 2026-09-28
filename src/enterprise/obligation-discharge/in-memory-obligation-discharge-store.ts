import { randomUUID } from 'node:crypto';

import type { ObligationDischargeContent, ObligationDischargeCorrelation, ObligationDischargeStore, StoredObligationDischarge } from './contracts.js';
import { ObligationDischargeError } from './errors.js';
import { rowsForCorrelation, verifyObligationDischargeHistory } from './integrity.js';
import { nextObligationDischargeChainDigest, obligationDischargeGenesisDigest, obligationDischargeRowDigest } from './state-commitment.js';

/**
 * The ephemeral discharge store, for `memory` persistence.
 *
 * It keeps the same chained history and verifies it on every read, but signs
 * nothing: there is no database here for a database-only writer to reach — the
 * rows live in this process's memory and die with it — and anything that can
 * write this process's memory can also use its signing key. It says so
 * (`kind: 'ephemeral'`), and the secure profile refuses it.
 */
export function createInMemoryObligationDischargeStore(options: { readonly organizationId: string }): ObligationDischargeStore {
  const storeId = `obligation-discharge-store:${randomUUID()}`;
  const organizationId = options.organizationId;
  const rows: StoredObligationDischarge[] = [];
  let chain = obligationDischargeGenesisDigest(storeId, organizationId);
  let closed = false;
  const open = (): void => {
    if (closed) throw new ObligationDischargeError('OBLIGATION_DISCHARGE_STORE_CLOSED', 'The obligation discharge store is closed.');
  };
  return {
    kind: 'ephemeral',
    append(content: ObligationDischargeContent): Promise<StoredObligationDischarge> {
      try {
        open();
        if (content.organizationId !== organizationId) throw new ObligationDischargeError('OBLIGATION_DISCHARGE_INVALID', 'The report belongs to another organization than this store.');
        const sequence = rows.length + 1;
        const digest = obligationDischargeRowDigest(storeId, sequence, content);
        const row: StoredObligationDischarge = Object.freeze({ ...content, correlation: Object.freeze({ ...content.correlation }), sequence, digest });
        rows.push(row);
        chain = nextObligationDischargeChainDigest(chain, digest);
        return Promise.resolve(row);
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    },
    read(readOrganizationId: string, correlation: ObligationDischargeCorrelation): Promise<readonly StoredObligationDischarge[]> {
      try {
        open();
        if (readOrganizationId !== organizationId) return Promise.resolve([]);
        verifyObligationDischargeHistory(rows, { storeId, organizationId, sequence: rows.length, chainDigest: chain });
        return Promise.resolve(rowsForCorrelation(rows, correlation));
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
