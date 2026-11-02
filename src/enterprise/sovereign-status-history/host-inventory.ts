import { resolve } from 'node:path';

import { isIdentifier } from './bootstrap-contract.js';
import type { BootstrapEvidenceInventorySnapshot } from './authority-settlement.js';
import { assessHistoryContinuity, captureHistoryContinuity, openRecordedHistory } from './history-continuity.js';
import type { BootstrapIntent, ExclusiveOpen, HistoryContinuityAssessment, HistoryContinuityRecord } from './history-continuity.js';
import { storeCommittedRequestOf } from './sqlite-status-high-water-mark-store.js';
import type { SqliteStatusHighWaterMarkStore } from './sqlite-status-high-water-mark-store.js';

/**
 * FV-P4C-2B3A — the Host-controlled inventory of FV status histories (not composed).
 *
 * It builds the reconciler's `inventory()` from four things:
 * - **The Host's protected configuration.** One `{ namespace, databasePath }` per history, and a
 *   configuration generation that never decreases and is never reused for other content.
 * - **Durable continuity records** (`history-continuity.ts`) behind a port. Protected storage is B3B.
 * - **A durable intent journal** behind the same port. It holds the request ids of this Host's own
 *   bootstraps that may have committed since the last record.
 * - **Genuine store handles** that this module opens itself: read-only to assess, never `create`.
 *
 * **Write-ahead intents (review H1).** `trackBootstrap` makes a bootstrap's commit always visible:
 * 1. The operation calls `ensureIntent()` **immediately before it consumes a decision** (the boundary's
 *    gated `authorize` does). That writes the intent `{ requestId, bindingDigest }` durably, so a
 *    request that never reaches consumption writes nothing (re-review N4). If the write fails,
 *    `ensureIntent()` throws and the consumption is refused.
 * 2. When the operation settles in this process, the commit happened or not, and it can no longer
 *    happen later:
 *    - **No evidence for its request id, and this handle never committed it:** the intent is completed
 *      (one write). Evidence the handle committed that is now gone (a rollback under the handle,
 *      release review M1) leaves the intent pending.
 *    - **Evidence:** the record is re-captured, then the intent is completed.
 * 3. If anything fails, the intent stays pending.
 *
 * While a tracked bootstrap runs, including its post-settle work, `refresh()` changes nothing, so its
 * handle is never closed under it (re-review N3). While a refresh runs, new bootstraps are refused
 * (`INVENTORY_REFRESHING`, R3 F2).
 *
 * A pending intent keeps its namespace out of every snapshot (`INTENT_UNRESOLVED`), so no negative is
 * read from it. At `refresh()` a pending intent is resolved only by **evidence**: its request id is in
 * the file, the record is re-captured, and the intent is completed. A pending intent with no evidence
 * is the case after a crash. The bootstrap may never have committed, or it committed and the file was
 * then rolled back or replaced. Nothing here can tell those apart, so the namespace stays quarantined
 * until an authorized operator ceremony (B3C). It is never cleared automatically.
 *
 * **Admission.** Only `CONTINUOUS` or `ADVANCED` histories with no unexplained evidence are admitted.
 * Every other class keeps that namespace out, so its decisions stay unresolved
 * (`HISTORY_NOT_IN_INVENTORY`) and other namespaces are unaffected.
 *
 * **Readiness:**
 * - `not-loaded`: `inventory()` returns `undefined`.
 * - `configuration-invalid`: a namespace or path twice, a bad generation, or a generation lower than
 *   one loaded, or reused with other content. Every handle is closed.
 * - `ready`, `degraded` (some quarantined) or `unavailable` (none admitted).
 * - `closed`.
 *
 * **Snapshots** re-assess every admitted history on each call, and check the file identity too. The
 * snapshot generation is internal and increases whenever the admitted set changes, so the
 * reconciler's stale and reuse checks hold. No caller supplies a completeness claim.
 */

export interface HostHistoryConfiguration {
  /** The protected configuration's version. Never decreases; one generation always names one set. */
  readonly generation: number;
  readonly histories: readonly { readonly namespace: string; readonly databasePath: string }[];
}

/** Where the Host keeps continuity records and bootstrap intents (B3B: protected, durable). Every method may throw: that fails closed. */
export interface HistoryContinuityRecordPort {
  load(namespace: string): unknown;
  save(record: HistoryContinuityRecord): void;
  /** This Host's bootstraps in this namespace that may have committed since the record. */
  pendingIntents(namespace: string): readonly BootstrapIntent[];
  beginIntent(namespace: string, intent: BootstrapIntent): void;
  completeIntent(namespace: string, requestId: string): void;
}

export type HostInventoryReadiness = 'not-loaded' | 'configuration-invalid' | 'ready' | 'degraded' | 'unavailable' | 'closed';

export interface HostInventoryStatus {
  readonly readiness: HostInventoryReadiness;
  readonly configurationGeneration: number | null;
  readonly histories: readonly HistoryContinuityAssessment[];
}

export type TrackedBootstrapRefusal = 'HISTORY_NOT_ADMITTED' | 'INVENTORY_REFRESHING' | 'EXECUTOR_NOT_HELD';

/**
 * FV-P4C-2B3B — the inventory as the exclusive executor: histories are opened exclusively with
 * `beforeWrite` as their write fence, and `confirmHeld(namespace)` must hold before a tracked
 * bootstrap starts and again before its intent is completed (otherwise it stays pending).
 */
export interface ExclusiveInventory extends ExclusiveOpen {
  confirmHeld(namespace: string): boolean;
}

export interface HostHistoryInventory {
  /** Loads the configuration, opens and assesses every configured history, resolves intents by evidence. */
  refresh(): Promise<HostInventoryStatus>;
  /** The reconciler's inventory provider. */
  readonly inventory: () => BootstrapEvidenceInventorySnapshot | undefined;
  /** The admitted, writable handle for a namespace, for the bootstrap path; `undefined` when not admitted. */
  historyFor(namespace: string): SqliteStatusHighWaterMarkStore | undefined;
  /** Runs one of this Host's bootstraps; `ensureIntent` must be called, and must return, before any decision is consumed (above). */
  trackBootstrap<T>(namespace: string, intent: BootstrapIntent, operation: (history: SqliteStatusHighWaterMarkStore, ensureIntent: () => void) => Promise<T>): Promise<{ readonly outcome: 'ran'; readonly value: T } | { readonly outcome: 'refused'; readonly reason: TrackedBootstrapRefusal }>;
  status(): HostInventoryStatus;
  close(): void;
}

const MAX_HISTORIES = 256;

export function createHostHistoryInventory(options: {
  readonly configuration: () => HostHistoryConfiguration | undefined;
  readonly records: HistoryContinuityRecordPort;
  readonly now: () => string;
  readonly exclusive?: ExclusiveInventory;
}): HostHistoryInventory {
  const { configuration, records, now, exclusive } = options ?? ({} as never);
  if (exclusive !== undefined && (typeof exclusive?.beforeWrite !== 'function' || typeof exclusive.confirmHeld !== 'function')) throw new TypeError('An exclusive inventory needs its write fence and its lock check.');
  const exclusiveOpen: ExclusiveOpen | undefined = exclusive === undefined ? undefined : Object.freeze({ beforeWrite: (file: string) => exclusive.beforeWrite(file) });
  const confirmHeld = (namespace: string): boolean => {
    if (exclusive === undefined) return true;
    try {
      return exclusive.confirmHeld(namespace) === true;
    } catch {
      return false;
    }
  };
  for (const method of ['load', 'save', 'pendingIntents', 'beginIntent', 'completeIntent'] as const) {
    if (typeof (records as unknown as Record<string, unknown> | undefined)?.[method] !== 'function') throw new TypeError('A Host history inventory needs its continuity record and intent port.');
  }
  if (typeof configuration !== 'function' || typeof now !== 'function') throw new TypeError('A Host history inventory needs its configuration and its clock.');

  let readiness: HostInventoryReadiness = 'not-loaded';
  let configurationGeneration: number | null = null;
  let configurationFingerprint = '';
  let assessments: HistoryContinuityAssessment[] = [];
  /** namespace → admitted handle and resolved configured path. */
  let admitted = new Map<string, { readonly store: SqliteStatusHighWaterMarkStore; readonly databasePath: string }>();
  let opened: SqliteStatusHighWaterMarkStore[] = [];
  let snapshotGeneration = 0;
  let snapshotFingerprint = '';

  const closeAll = (stores: SqliteStatusHighWaterMarkStore[]) => {
    for (const store of stores) {
      try {
        store.close();
      } catch {
        // already closed
      }
    }
  };

  function status(): HostInventoryStatus {
    return Object.freeze({ readiness, configurationGeneration, histories: Object.freeze([...assessments]) });
  }

  const fail = (state: HostInventoryReadiness): HostInventoryStatus => {
    readiness = state;
    admitted = new Map();
    assessments = [];
    closeAll(opened.splice(0));
    return status();
  };

  let activeBootstraps = 0;
  // R3 F2: a refresh in progress (it awaits each open) excludes new bootstraps, and a bootstrap excludes refresh.
  let refreshing = false;
  const pendingOf = (namespace: string): readonly BootstrapIntent[] | undefined => {
    try {
      const pending = records.pendingIntents(namespace);
      return Array.isArray(pending) && pending.every((i) => typeof i?.requestId === 'string' && typeof i?.bindingDigest === 'string')
        ? pending.map((i) => Object.freeze({ requestId: i.requestId, bindingDigest: i.bindingDigest }))
        : undefined;
    } catch {
      return undefined;
    }
  };

  /** Admitted now: the history is admissible and no intent of this Host is pending for it. */
  function admittedNow(namespace: string): { readonly store: SqliteStatusHighWaterMarkStore; readonly databasePath: string } | undefined {
    const entry = admitted.get(namespace);
    if (entry === undefined) return undefined;
    // FV-P4C-2B3B: an exclusive inventory serves only histories this process still holds.
    if (!confirmHeld(namespace)) return undefined;
    const pending = pendingOf(namespace);
    if (pending === undefined || pending.length > 0) return undefined;
    let record: unknown;
    try {
      record = records.load(namespace);
    } catch {
      return undefined;
    }
    return assessHistoryContinuity(record, { namespace, databasePath: entry.databasePath, store: entry.store }).admitted ? entry : undefined;
  }

  const inventory = (): BootstrapEvidenceInventorySnapshot | undefined => {
    if (readiness !== 'ready' && readiness !== 'degraded') return undefined;
    const current = [...admitted.keys()].flatMap((namespace) => {
      const entry = admittedNow(namespace);
      return entry === undefined ? [] : [{ namespace, ...entry }];
    });
    if (current.length === 0) return undefined;
    // Review L1: resolved paths, as the reconciler fingerprints them.
    const fingerprint = JSON.stringify(current.map((h) => [h.namespace, h.databasePath]).sort());
    if (fingerprint !== snapshotFingerprint) {
      snapshotFingerprint = fingerprint;
      snapshotGeneration += 1;
    }
    return Object.freeze({ generation: snapshotGeneration, histories: Object.freeze(current.map((h) => Object.freeze({ store: h.store, namespace: h.namespace, databasePath: h.databasePath }))) });
  };

  /** Re-captures the record of an admitted history after this Host's own bootstraps; `false` when it cannot (then intents stay pending). */
  function recapture(namespace: string, entry: { readonly store: SqliteStatusHighWaterMarkStore; readonly databasePath: string }, pending: readonly BootstrapIntent[], generation: number | null): boolean {
    try {
      const assessed = assessHistoryContinuity(records.load(namespace), { namespace, databasePath: entry.databasePath, store: entry.store }, pending);
      if (!assessed.admitted || generation === null) return false;
      records.save(captureHistoryContinuity(entry.store, { namespace, databasePath: entry.databasePath, generation, recordedAt: now() }));
      return true;
    } catch {
      return false;
    }
  }

  async function refreshNow(): Promise<HostInventoryStatus> {
    let loaded: HostHistoryConfiguration | undefined;
    try {
      loaded = configuration();
    } catch {
      return fail('configuration-invalid');
    }
    if (loaded === undefined) return fail('not-loaded');
    const generation = loaded.generation;
    const histories = Array.isArray(loaded.histories) ? loaded.histories.map((h) => ({ namespace: h?.namespace, databasePath: h?.databasePath })) : undefined;
    if (!Number.isSafeInteger(generation) || generation < 0 || histories === undefined || histories.length === 0 || histories.length > MAX_HISTORIES) return fail('configuration-invalid');
    const namespaces = new Set<string>();
    const files = new Set<string>();
    const resolved: Array<{ namespace: string; databasePath: string }> = [];
    for (const { namespace, databasePath } of histories) {
      if (!isIdentifier(namespace, 256) || typeof databasePath !== 'string' || databasePath.trim() === '') return fail('configuration-invalid');
      const file = resolve(databasePath);
      if (namespaces.has(namespace) || files.has(file)) return fail('configuration-invalid');
      namespaces.add(namespace);
      files.add(file);
      resolved.push({ namespace, databasePath: file });
    }
    const fingerprint = JSON.stringify(resolved.map((h) => [h.namespace, h.databasePath]).sort());
    // Review L2: never lower, and one generation always names one set.
    if (configurationGeneration !== null && (generation < configurationGeneration || (generation === configurationGeneration && fingerprint !== configurationFingerprint))) return fail('configuration-invalid');
    const nextAdmitted = new Map<string, { store: SqliteStatusHighWaterMarkStore; databasePath: string }>();
    const nextAssessments: HistoryContinuityAssessment[] = [];
    const nextOpened: SqliteStatusHighWaterMarkStore[] = [];
    if (exclusive !== undefined) {
      // FV-P4C-2B3B: an exclusively held file is never opened a second time (nor read raw) by this process,
      // so every held handle is closed before any reopen. Nothing is served meanwhile.
      readiness = 'not-loaded';
      admitted = new Map();
      assessments = [];
      closeAll(opened.splice(0));
    }
    for (const { namespace, databasePath } of resolved) {
      const unavailable = Object.freeze({ namespace, class: 'UNAVAILABLE' as const, admitted: false, proof: 'not-applicable' as const, committedIntents: Object.freeze([]) });
      let record: unknown;
      const pending = pendingOf(namespace);
      try {
        record = records.load(namespace);
      } catch {
        nextAssessments.push(unavailable);
        continue;
      }
      if (pending === undefined) {
        nextAssessments.push(unavailable);
        continue;
      }
      const { assessment, store } = await openRecordedHistory(record, { namespace, databasePath, pendingIntents: pending, ...(exclusiveOpen !== undefined ? { exclusive: exclusiveOpen } : {}) });
      if (store === undefined) {
        nextAssessments.push(assessment);
        continue;
      }
      nextOpened.push(store);
      // Intents are resolved by evidence only; any left without evidence keep the namespace out.
      const committed = new Set(assessment.committedIntents);
      const unresolved = pending.filter((intent) => !committed.has(intent.requestId));
      if (pending.length > 0 && (unresolved.length > 0 || !recapture(namespace, { store, databasePath }, pending, generation))) {
        nextAssessments.push(Object.freeze({ namespace, class: 'INTENT_UNRESOLVED' as const, admitted: false, proof: 'not-applicable' as const, committedIntents: assessment.committedIntents }));
        continue;
      }
      let completed = true;
      for (const { requestId } of pending) {
        try {
          records.completeIntent(namespace, requestId);
        } catch {
          completed = false;
        }
      }
      if (!completed) {
        nextAssessments.push(Object.freeze({ namespace, class: 'INTENT_UNRESOLVED' as const, admitted: false, proof: 'not-applicable' as const, committedIntents: assessment.committedIntents }));
        continue;
      }
      nextAssessments.push(assessment);
      nextAdmitted.set(namespace, { store, databasePath });
    }
    // R3: closed while this refresh awaited an open: nothing it opened is kept, and it never reopens the inventory.
    if (readiness === 'closed') {
      closeAll(nextOpened);
      return status();
    }
    closeAll(opened);
    opened = nextOpened;
    admitted = nextAdmitted;
    assessments = nextAssessments;
    configurationGeneration = generation;
    configurationFingerprint = fingerprint;
    readiness = nextAdmitted.size === 0 ? 'unavailable' : nextAdmitted.size === resolved.length ? 'ready' : 'degraded';
    return status();
  }

  return Object.freeze({
    async refresh(): Promise<HostInventoryStatus> {
      // Re-review N3 and R3 F2: never under a running bootstrap (including its post-settle work), never twice at once.
      if (readiness === 'closed' || activeBootstraps > 0 || refreshing) return status();
      refreshing = true;
      try {
        return await refreshNow();
      } finally {
        refreshing = false;
      }
    },
    inventory,
    historyFor(namespace: string): SqliteStatusHighWaterMarkStore | undefined {
      if (readiness !== 'ready' && readiness !== 'degraded') return undefined;
      return admittedNow(namespace)?.store;
    },
    async trackBootstrap<T>(namespace: string, intent: BootstrapIntent, operation: (history: SqliteStatusHighWaterMarkStore, ensureIntent: () => void) => Promise<T>) {
      if (typeof operation !== 'function') throw new TypeError('operation is the coordinator call.');
      const { requestId, bindingDigest } = intent ?? ({} as BootstrapIntent);
      if (typeof requestId !== 'string' || typeof bindingDigest !== 'string') throw new TypeError('intent names one request id and its binding digest.');
      const entry = readiness === 'ready' || readiness === 'degraded' ? admitted.get(namespace) : undefined;
      // Admissible now; other intents of this namespace may be pending (concurrent bootstraps of other bindings).
      let assessed: HistoryContinuityAssessment | undefined;
      const pendingBefore = pendingOf(namespace);
      try {
        assessed = entry === undefined || pendingBefore === undefined ? undefined : assessHistoryContinuity(records.load(namespace), { namespace, databasePath: entry.databasePath, store: entry.store }, pendingBefore);
      } catch {
        assessed = undefined;
      }
      if (refreshing) return Object.freeze({ outcome: 'refused' as const, reason: 'INVENTORY_REFRESHING' as const });
      if (entry === undefined || assessed === undefined || !assessed.admitted) return Object.freeze({ outcome: 'refused' as const, reason: 'HISTORY_NOT_ADMITTED' as const });
      if (!confirmHeld(namespace)) return Object.freeze({ outcome: 'refused' as const, reason: 'EXECUTOR_NOT_HELD' as const });
      let written = false;
      const ensureIntent = (): void => {
        if (written) return;
        // Throws when it cannot be recorded: the caller then consumes nothing.
        records.beginIntent(namespace, Object.freeze({ requestId, bindingDigest }));
        written = true;
      };
      activeBootstraps += 1;
      try {
        const value = await operation(entry.store, ensureIntent);
        return Object.freeze({ outcome: 'ran' as const, value });
      } finally {
        // Settled in this process: it committed or it never will. The count drops only after this (R3 F2).
        try {
          if (written) {
            let committed: boolean | undefined;
            try {
              committed = await entry.store.hasBootstrapRequest(requestId);
            } catch {
              committed = undefined;
            }
            const pending = pendingOf(namespace);
            // No evidence, and this handle never committed it: nothing for the record to catch up with.
            // Release review M1: evidence this handle committed that is now gone means the file was rolled back
            // under it; the intent stays pending, so no negative is ever read from it.
            const absent = committed === false && !storeCommittedRequestOf(entry.store, requestId);
            // FV-P4C-2B3B: the outcome is believed only while this process still holds the files exclusively.
            const held = confirmHeld(namespace);
            // Evidence: re-capture first. Anything else stays pending.
            const settled = held && (absent || (committed === true && pending !== undefined && recapture(namespace, entry, pending, configurationGeneration)));
            if (settled) {
              try {
                records.completeIntent(namespace, requestId);
              } catch {
                // stays pending: the namespace stays out until refresh() resolves it by evidence
              }
            }
          }
        } finally {
          activeBootstraps -= 1;
        }
      }
    },
    status,
    close(): void {
      readiness = 'closed';
      admitted = new Map();
      closeAll(opened.splice(0));
    },
  });
}
