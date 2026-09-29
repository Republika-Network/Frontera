import { randomUUID } from 'node:crypto';

import type { ApprovalStore, StoredApprovalRecord } from './contracts.js';
import { ApprovalAuthorityError } from './errors.js';
import { rowsForRequest, verifyApprovalHistory } from './integrity.js';
import { approvalGenesisDigest, approvalRowDigest, nextApprovalChainDigest, type ApprovalRowContent } from './state-commitment.js';

/**
 * The ephemeral approval store, for `memory` persistence.
 *
 * It keeps the same chained history and verifies it on every read, but signs
 * nothing: there is no database here for a database-only writer to reach, and
 * anything that can write this process's memory can also use its signing key.
 * It says so (`kind: 'ephemeral'`), and the secure profile refuses it — an
 * approval that forgot itself on restart would leave a withheld action waiting
 * forever, and one that could be forged would release it.
 */
export function createInMemoryApprovalStore(options: { readonly organizationId: string }): ApprovalStore {
  const storeId = `approval-store:${randomUUID()}`;
  const organizationId = options.organizationId;
  const rows: StoredApprovalRecord[] = [];
  let chain = approvalGenesisDigest(storeId, organizationId);
  let closed = false;
  const open = (): void => {
    if (closed) throw new ApprovalAuthorityError('APPROVAL_STORE_CLOSED', 'The approval store is closed.');
  };
  return {
    kind: 'ephemeral',
    append(content: ApprovalRowContent): Promise<StoredApprovalRecord> {
      try {
        open();
        if (content.organizationId !== organizationId) throw new ApprovalAuthorityError('APPROVAL_INVALID', 'The record belongs to another organization than this store.');
        const sequence = rows.length + 1;
        const digest = approvalRowDigest(storeId, sequence, content);
        const row: StoredApprovalRecord = Object.freeze({ ...content, sequence, digest });
        rows.push(row);
        chain = nextApprovalChainDigest(chain, digest);
        return Promise.resolve(row);
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    },
    read(readOrganizationId: string, requestId?: string): Promise<readonly StoredApprovalRecord[]> {
      try {
        open();
        if (readOrganizationId !== organizationId) return Promise.resolve([]);
        verifyApprovalHistory(rows, { storeId, organizationId, sequence: rows.length, chainDigest: chain });
        return Promise.resolve(rowsForRequest(rows, requestId));
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
