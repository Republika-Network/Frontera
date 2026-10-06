import { parentPort, workerData } from 'node:worker_threads';

import type { ExecutionDestination } from '../../features/destination-runtime/index.js';
import { isDestinationRegistryError } from '../../features/destination-runtime/registry/index.js';
import { isDestinationApprovalError } from '../../features/destination-runtime/approval/index.js';
import { createSqliteDestinationRegistry } from '../destination-registry/sqlite-destination-registry.js';
import { createSqliteDestinationApprovalStore } from '../destination-approval/sqlite-destination-approval-store.js';

/**
 * One independent participant in a destination-approval race: its own thread,
 * its own `better-sqlite3` connections to the same registry and approval
 * files. It opens both, reports ready, blocks on a shared barrier until every
 * participant is ready, then approves or revokes. Test scaffolding only.
 */
interface RaceInput {
  readonly registryPath: string;
  readonly approvalPath: string;
  readonly barrier: SharedArrayBuffer;
  readonly operation: 'approve' | 'revoke';
  readonly organizationId: string;
  readonly destination: ExecutionDestination;
  readonly idempotencyKey: string;
  readonly actorRef: string;
  readonly clockStart: string;
}

async function main(): Promise<void> {
  const input = workerData as RaceInput;
  let tick = 0;
  const now = () => new Date(Date.parse(input.clockStart) + (tick += 1)).toISOString();
  const registry = await createSqliteDestinationRegistry(input.registryPath, { now, busyTimeoutMs: 30_000 });
  const store = await createSqliteDestinationApprovalStore(input.approvalPath, { now, registry, busyTimeoutMs: 30_000 });
  const gate = new Int32Array(input.barrier);
  parentPort?.postMessage({ kind: 'ready' });
  Atomics.wait(gate, 0, 0);
  try {
    const authority = { authenticated: true as const, organizationId: input.organizationId, actorRef: input.actorRef, authorityBasis: `operator-permission:destination.${input.operation}` };
    const command = { destination: input.destination, idempotencyKey: input.idempotencyKey };
    if (input.operation === 'approve') {
      const result = store.approve(authority, command);
      parentPort?.postMessage({ kind: 'done', outcome: result.outcome, replayed: result.replayed, sequence: result.approval.sequence, approvedBy: result.approval.approvedBy });
    } else {
      const result = store.revoke(authority, command);
      parentPort?.postMessage({ kind: 'done', outcome: result.outcome, replayed: result.replayed, sequence: result.outcome === 'not-active' ? null : result.revocation.sequence });
    }
  } catch (error) {
    const code = isDestinationApprovalError(error) || isDestinationRegistryError(error) ? error.code : `error:${error instanceof Error ? error.message : String(error)}`;
    parentPort?.postMessage({ kind: 'done', outcome: code });
  } finally {
    await store.close();
    await registry.close();
  }
}

void main();
