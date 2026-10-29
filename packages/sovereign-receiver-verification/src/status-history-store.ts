import type { StatusHighWaterMark, StatusHighWaterMarkEntry, StatusHighWaterMarkStore, StatusHistoryKey } from './document-freshness-types.js';
import { deepFreeze } from './plain-data.js';

/**
 * FV-P4C-1 reference `StatusHighWaterMarkStore`, held in memory.
 *
 * **Process-local only.** It protects one process for as long as that process
 * lives: a restart, a second instance or a worker starts with no history (and
 * the gate then refuses as uninitialized). It is not persistent rollback
 * protection; a durable, anchored store is FV-P4C-2.
 *
 * `compareAndSet` checks the revision and writes in one synchronous step, with
 * no `await` in between, so within this process two writers expecting the same
 * revision can never both succeed. Entries are copied and frozen on the way in
 * and out, so a caller holding a returned entry cannot change the stored one.
 */
export function createInMemoryStatusHighWaterMarkStore(): StatusHighWaterMarkStore {
  const entries = new Map<string, StatusHighWaterMarkEntry>();
  const keyOf = (key: StatusHistoryKey) => JSON.stringify([key.sovereignAssetId, key.issuer]);
  return Object.freeze({
    async read(key: StatusHistoryKey): Promise<StatusHighWaterMarkEntry | undefined> {
      return entries.get(keyOf(key));
    },
    async compareAndSet(key: StatusHistoryKey, expectedRevision: number | null, next: StatusHighWaterMark): Promise<boolean> {
      const id = keyOf(key);
      const current = entries.get(id);
      if ((current?.revision ?? null) !== expectedRevision) return false;
      const mark = JSON.parse(JSON.stringify(next)) as StatusHighWaterMark;
      entries.set(id, deepFreeze({ revision: (current?.revision ?? 0) + 1, mark }));
      return true;
    },
  });
}
