import { PROTECTED_CONTINUITY_STORE_SCHEMA } from './protected-continuity-store.js';
import { SOVEREIGN_STATUS_HISTORY_SCHEMA_VERSION } from './sqlite-status-high-water-mark-store.js';

/**
 * FV-P4C-2B3C-1 — the persistence ownership contract that PROD-02 integration (B3C-2) must implement.
 * Declarative only: nothing here reads, opens, copies or registers a file, and PROD-02's registry does
 * not name any FV store yet (a structure test pins both).
 *
 * The constraint behind it: the executor's authority is a POSIX lock that **any** open-and-close of the
 * file by its own process drops, and that blocks every other process. PROD-02's live backup opens each
 * registered file read-only and runs SQLite's online backup API. Run from another process against an
 * executor-held file, it is refused (the file is locked), never silently inconsistent; run inside the
 * executor's process it would drop the lock. So neither is allowed: FV stores are backed up **by the
 * executor itself**, through its own held connection, or **cold**, after the executor has stopped and
 * released its locks.
 */

export const FV_EXECUTOR_PERSISTENCE_OWNER = 'frontera.fv-dedicated-executor' as const;

export interface FvExecutorOwnedStore {
  readonly kind: 'protected-continuity-store' | 'status-history' | 'bootstrap-identity-store';
  readonly schemaIdentity: string;
  /** What it holds. */
  readonly holds: readonly string[];
  /** Its SQLite sidecars, owned with it. */
  readonly sidecars: readonly string[];
  /** One file per executor, or one per configured namespace. */
  readonly cardinality: 'one' | 'per-namespace';
}

export const FV_EXECUTOR_PERSISTENCE_CONTRACT = Object.freeze({
  schema: 'frontera.fv-executor-persistence-contract/1' as const,
  owner: FV_EXECUTOR_PERSISTENCE_OWNER,
  stores: Object.freeze([
    Object.freeze({
      kind: 'protected-continuity-store' as const,
      schemaIdentity: PROTECTED_CONTINUITY_STORE_SCHEMA,
      holds: Object.freeze(['continuity record per namespace', 'bootstrap intent journal (pending → completed, never deleted)', 'executor epoch']),
      sidecars: Object.freeze(['-wal']),
      cardinality: 'one' as const,
    }),
    Object.freeze({
      kind: 'status-history' as const,
      schemaIdentity: SOVEREIGN_STATUS_HISTORY_SCHEMA_VERSION,
      holds: Object.freeze(['sovereign status high-water marks and bootstrap evidence for one namespace']),
      sidecars: Object.freeze(['-wal']),
      cardinality: 'per-namespace' as const,
    }),
    // FV-P4C-2B3C-3: the executor's own AUTH-03 identity store for bootstrap-authority decisions, opened and
    // held exclusively by the executor, its id pinned. Never AUTH-04A's store.
    Object.freeze({
      kind: 'bootstrap-identity-store' as const,
      schemaIdentity: 'frontera.human-identity-store (AUTH-03 schema 2), bootstrap-authority domain',
      holds: Object.freeze(['the FV operators’ principals and passkeys', 'bootstrap-authority challenges, consumed decisions and their settlements (signed chain, CORE-07 head in its own freshness domain, `fv-bootstrap-identity-state`, never the Host’s `human-identity-state` slot)']),
      sidecars: Object.freeze(['-wal']),
      cardinality: 'one' as const,
    }),
  ] satisfies readonly FvExecutorOwnedStore[]),
  /**
   * Files the executor never opens. B3C-1's review M2 (the AUTH-03 identity store shared between the Host
   * and the executor) is closed by FV-P4C-2B3C-3: the executor owns its own bootstrap identity store
   * (above), and AUTH-04A's Host identity store has AUTH-04A as its one owner.
   */
  notOwned: Object.freeze([
    Object.freeze({
      kind: 'auth04a-host-identity-store' as const,
      owner: 'AUTH-04A (the Enterprise Host)' as const,
      rule: 'never opened by the executor; the executor accepts no already opened store, and pins its own by id',
      activationBlocker: false as const,
    }),
  ]),
  lock: Object.freeze({
    mechanism: 'sqlite-locking-mode-exclusive (POSIX write lock on the SHARED range), confirmed in this process’s /proc/self/fdinfo lock view before every write',
    holder: 'the executor process only, for its whole lifetime',
  }),
  /** What no other component may do while an executor runs. */
  forbiddenWhileExecutorActive: Object.freeze([
    'open, probe, stat-and-open, copy or checksum an executor file or its -wal from inside the executor process',
    'open an executor file from another process (it is refused while locked; retrying it is a probe loop)',
    'byte-copy a live file or its -wal (an inconsistent snapshot)',
    'delete, rename, truncate or replace an executor file or sidecar',
    'restore over an executor file',
  ]),
  /** How a consistent snapshot is obtained (B3C-2 implements one of these; neither exists yet). */
  snapshotModes: Object.freeze([
    Object.freeze({
      mode: 'executor-mediated' as const,
      status: 'deferred-to-B3C-2' as const,
      handshake: Object.freeze([
        'the supervisor sends a snapshot request naming a backup output directory it was configured with (never a request-supplied path)',
        'the executor refuses unless it holds every lock, then fences and runs SQLite’s backup API from its own held connection into a new file in that directory',
        'the executor reports each snapshot’s schema identity, epoch, row counts and SHA-256, never its contents',
        'the supervisor or backup controller verifies the copy only after the executor has closed it, by opening the copy (never the source)',
      ]),
    }),
    Object.freeze({
      mode: 'cold' as const,
      status: 'deferred-to-B3C-2' as const,
      handshake: Object.freeze([
        'the executor is stopped through its supervisor and reports STOPPED (every lock released by a clean close)',
        'the supervisor stays stopped (no restart) for the duration of the copy',
        'PROD-02 copies with the backup API from the stopped files, and refuses a non-empty -wal it did not expect',
        'the executor is started again; its startup re-verifies continuity and recovers intents by evidence',
      ]),
    }),
  ]),
  backupOutput: 'a directory configured for the backup controller, outside the executor’s data directory, never overlapping an executor file',
  verification: 'PROD-02’s own: integrity_check on the copy, schema identity, checksums; plus, for FV, the continuity record matching the copied history (FV-P4C-2B3A)',
  restore: 'never promoted automatically; a restored set starts quarantined until the operator ceremony (B3C-2), and a whole-system rollback is undetectable without FV-P4D',
});

/** Every file an executor configured with these paths owns, sidecars included (for exclusion checks; nothing is opened). */
export function fvExecutorOwnedFiles(protectedStorePath: string, historyPaths: readonly string[]): readonly string[] {
  const files: string[] = [];
  for (const path of [protectedStorePath, ...historyPaths]) {
    if (typeof path !== 'string' || path === '') continue;
    files.push(path, `${path}-wal`, `${path}-shm`, `${path}-journal`);
  }
  return Object.freeze(files);
}
