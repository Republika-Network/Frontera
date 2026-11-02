import { createHash } from 'node:crypto';
import { closeSync, existsSync, openSync, readSync } from 'node:fs';
import { resolve } from 'node:path';

import { canonicalInstant, canonicalJson, isDigest, isIdentifier } from './bootstrap-contract.js';
import { SOVEREIGN_STATUS_HISTORY_SCHEMA_VERSION, SovereignStatusHistoryStoreError, openSqliteStatusHighWaterMarkStore, storeCheckpointOf } from './sqlite-status-high-water-mark-store.js';
import type { SqliteStatusHighWaterMarkStore, StoreCheckpoint } from './sqlite-status-high-water-mark-store.js';

/**
 * FV-P4C-2B3A — durable namespace-to-history continuity, as a Host-held record (not composed).
 *
 * The FV status history file carries no store identity and is not anchored by CORE-07. A namespace's
 * history could therefore be silently replaced by another file at the configured path: a fresh
 * `create: true` store, another history pinned to the same namespace, or an older backup. A reconciler
 * reading absence from such a file would record a false `NO_BOOTSTRAP_EVIDENCE` (FV-P4C-2B2C residual).
 *
 * A **continuity record** is the Host's own checkpoint of one history's durable content, kept outside
 * that file. It holds:
 * - the namespace;
 * - the resolved path;
 * - the schema;
 * - the inventory generation;
 * - the monotonic row counter;
 * - a digest of every row's whole validated entry, with its revision;
 * - the digest of every permanent evidence record.
 *
 * The content is read through the store's own validators, and only from a genuine handle. The file
 * must hold **everything** the record holds, unchanged or advanced:
 *
 * | Observation | Class | Admitted |
 * |---|---|---|
 * | identical content | `CONTINUOUS` | yes |
 * | every recorded fact present; rows advanced; new evidence only for this Host's pending intents | `ADVANCED` | yes |
 * | new evidence no pending intent of this Host explains | `UNEXPLAINED_EVIDENCE` | no |
 * | a consistent subset (an older copy, a fresh file) | `ROLLED_BACK` | no |
 * | anything else: a different or edited history, or a row changed at an equal revision | `DIVERGED` | no |
 * | the configured path no longer names the file the handle opened | `FILE_REPLACED` | no |
 * | another path than recorded | `MOVED` | no (explicit re-registration only) |
 * | the file pinned to another namespace | `NAMESPACE_MISMATCH` | no |
 * | another schema | `SCHEMA_MISMATCH` | no |
 * | no file | `MISSING` | no (never recreated) |
 * | not a SQLite file, or refused at open (integrity, triggers, not a history) | `CORRUPT` | no |
 * | could not be read now | `UNAVAILABLE` | no |
 * | no record for the namespace | `UNREGISTERED` | no |
 * | the record itself malformed or altered | `RECORD_INVALID` | no |
 * | not a genuine handle for the namespace and file | `NOT_GENUINE` | no |
 *
 * **Why new evidence must be explained (review H1/M1).** The Host records an intent durably before
 * each of its own bootstraps, and re-captures the record when the bootstrap settles
 * (`host-inventory.ts`). So evidence the record does not hold is legitimate only while one of this
 * Host's intents is pending. Any other evidence came from outside this Host's bootstrap path. That
 * covers a forged row, or a fork that kept the recorded facts and replaced what came after.
 *
 * **What it does not prove.**
 * - **The record is Host data.** Its self-digest detects accidental damage, not tampering. Protecting
 *   it, and the intents, is the storage's job (B3B).
 * - **Restored together.** A record and a history restored together, equally old, are undetected. Only
 *   an independent witness detects that (FV-P4D).
 * - **Never global currentness.**
 *
 * Nothing here creates, resets, re-anchors or rewrites a history. Assessment opens files read-only, and
 * no refused class is ever admitted automatically.
 */

export const HISTORY_CONTINUITY_RECORD_FORMAT = 'frontera.sovereign-status-history-continuity.v1' as const;

export interface HistoryContinuityRecord {
  readonly format: typeof HISTORY_CONTINUITY_RECORD_FORMAT;
  readonly namespace: string;
  /** The resolved database path the Host configured. */
  readonly databasePath: string;
  readonly schemaVersion: string;
  /** The Host configuration generation this checkpoint was taken under. */
  readonly generation: number;
  readonly recordedAt: string;
  readonly createdRows: number;
  /** `[sovereignAssetId, issuer, revision, rowDigest]`. */
  readonly revisions: ReadonlyArray<readonly [string, string, number, string]>;
  /** `[requestId, bootstrapEvidenceDigest]`. */
  readonly evidence: ReadonlyArray<readonly [string, string]>;
  /** `sha256:<hex>` over the canonical record without this field: accidental-damage detection only. */
  readonly digest: string;
}

export type HistoryContinuityClass =
  | 'CONTINUOUS'
  | 'ADVANCED'
  | 'UNEXPLAINED_EVIDENCE'
  | 'ROLLED_BACK'
  | 'DIVERGED'
  | 'FILE_REPLACED'
  | 'MOVED'
  | 'NAMESPACE_MISMATCH'
  | 'SCHEMA_MISMATCH'
  | 'MISSING'
  | 'CORRUPT'
  | 'UNAVAILABLE'
  | 'UNREGISTERED'
  | 'RECORD_INVALID'
  | 'NOT_GENUINE'
  | 'INTENT_UNRESOLVED';

/** One of this Host's own bootstraps that may have committed since the record: its request id and its exact binding. */
export interface BootstrapIntent {
  readonly requestId: string;
  readonly bindingDigest: string;
}

export interface HistoryContinuityAssessment {
  readonly namespace: string;
  readonly class: HistoryContinuityClass;
  /** Only `CONTINUOUS` and `ADVANCED` are admitted. */
  readonly admitted: boolean;
  /** `content` when the record held content to compare; `none` when it was empty. */
  readonly proof: 'content' | 'none' | 'not-applicable';
  /** The request ids of pending intents whose evidence (same request id and binding) the file holds, recorded or new. */
  readonly committedIntents: readonly string[];
}

const RECORD_KEYS = ['createdRows', 'databasePath', 'digest', 'evidence', 'format', 'generation', 'namespace', 'recordedAt', 'revisions', 'schemaVersion'] as const;
const MAX_NAMESPACE_LENGTH = 256;
const isSha256 = (value: unknown): value is string => typeof value === 'string' && value.startsWith('sha256:') && isDigest(value.slice('sha256:'.length));

function recordDigest(record: Omit<HistoryContinuityRecord, 'digest'>): string {
  const body = canonicalJson({ ...record, revisions: record.revisions.map((r) => [...r]), evidence: record.evidence.map((e) => [...e]) });
  return `sha256:${createHash('sha256').update(`frontera:sovereign-status-history-continuity:v1\n${body}`).digest('hex')}`;
}

/**
 * Captures the continuity record of a genuine, open history handle for exactly this namespace and file.
 * Throws a `TypeError` for anything that is not, and the store's own error when it cannot be read.
 */
export function captureHistoryContinuity(store: unknown, options: { readonly namespace: string; readonly databasePath: string; readonly generation: number; readonly recordedAt: string }): HistoryContinuityRecord {
  const { namespace, databasePath, generation, recordedAt } = options ?? ({} as never);
  if (!isIdentifier(namespace, MAX_NAMESPACE_LENGTH)) throw new TypeError('A continuity record names one status history namespace.');
  if (typeof databasePath !== 'string' || databasePath.trim() === '') throw new TypeError('A continuity record names the configured database path.');
  if (!Number.isSafeInteger(generation) || generation < 0) throw new TypeError('A continuity record names a non-negative generation.');
  if (canonicalInstant(recordedAt) === undefined) throw new TypeError('A continuity record is recorded at a canonical instant.');
  const checkpoint = storeCheckpointOf(store, { namespace, databasePath });
  if (checkpoint === undefined) throw new TypeError('Not a genuine status history store handle for that namespace and database file.');
  if (!checkpoint.fileIdentityStable) throw new TypeError('The configured path no longer names the file this handle opened.');
  const body = {
    format: HISTORY_CONTINUITY_RECORD_FORMAT,
    namespace,
    databasePath: resolve(databasePath),
    schemaVersion: checkpoint.schemaVersion,
    generation,
    recordedAt,
    createdRows: checkpoint.createdRows,
    revisions: sortBy(checkpoint.revisions.map((r) => Object.freeze([...r] as [string, string, number, string])), revisionKey),
    evidence: sortBy(checkpoint.evidence.map((e) => Object.freeze([e[0], e[1]] as [string, string])), (e) => e[0]),
  } as const;
  return deepFreeze({ ...body, digest: recordDigest(body) });
}

/** A record read as plain data, closed and self-consistent; `undefined` for anything else. */
export function readHistoryContinuityRecord(value: unknown): HistoryContinuityRecord | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const keys = Object.keys(value).sort();
  if (keys.length !== RECORD_KEYS.length || keys.some((key, i) => key !== RECORD_KEYS[i])) return undefined;
  const v = value as Record<string, unknown>;
  if (v['format'] !== HISTORY_CONTINUITY_RECORD_FORMAT || !isIdentifier(v['namespace'], MAX_NAMESPACE_LENGTH)) return undefined;
  if (typeof v['databasePath'] !== 'string' || resolve(v['databasePath']) !== v['databasePath'] || typeof v['schemaVersion'] !== 'string') return undefined;
  if (!Number.isSafeInteger(v['generation']) || (v['generation'] as number) < 0 || !Number.isSafeInteger(v['createdRows']) || (v['createdRows'] as number) < 0) return undefined;
  if (canonicalInstant(v['recordedAt']) === undefined) return undefined;
  const revisions = readTuples(v['revisions'], (t) => t.length === 4 && typeof t[0] === 'string' && typeof t[1] === 'string' && Number.isSafeInteger(t[2]) && (t[2] as number) >= 1 && isSha256(t[3]), revisionKey);
  const evidence = readTuples(v['evidence'], (t) => t.length === 2 && isIdentifier(t[0], 512) && isSha256(t[1]), (t) => t[0] as string);
  if (revisions === undefined || evidence === undefined || revisions.length > (v['createdRows'] as number)) return undefined;
  const body = {
    format: HISTORY_CONTINUITY_RECORD_FORMAT,
    namespace: v['namespace'] as string,
    databasePath: v['databasePath'],
    schemaVersion: v['schemaVersion'],
    generation: v['generation'] as number,
    recordedAt: v['recordedAt'] as string,
    createdRows: v['createdRows'] as number,
    revisions: revisions as unknown as Array<readonly [string, string, number, string]>,
    evidence: evidence as unknown as Array<readonly [string, string]>,
  };
  if (v['digest'] !== recordDigest(body)) return undefined;
  return deepFreeze({ ...body, digest: v['digest'] as string });
}

/** What the file holds relative to what the Host last recorded. */
function compareContent(record: HistoryContinuityRecord, observed: StoreCheckpoint): { readonly cls: 'CONTINUOUS' | 'ADVANCED' | 'ROLLED_BACK' | 'DIVERGED'; readonly newEvidence: readonly BootstrapIntent[] } {
  const recordedRows = new Map(record.revisions.map((t) => [revisionKey(t), t]));
  const observedRows = new Map(observed.revisions.map((t) => [revisionKey(t), t]));
  const recordedEvidence = new Map(record.evidence);
  const observedEvidence = new Map(observed.evidence.map(([requestId, digest]) => [requestId, digest]));
  const newEvidence = observed.evidence.filter(([requestId]) => !recordedEvidence.has(requestId)).map(([requestId, , bindingDigest]) => Object.freeze({ requestId, bindingDigest }));
  // A permanent record that changed is a different history, whatever else holds.
  for (const [requestId, digest] of recordedEvidence) if (observedEvidence.has(requestId) && observedEvidence.get(requestId) !== digest) return { cls: 'DIVERGED', newEvidence };
  let missing = false;
  let extra = newEvidence.length > 0;
  for (const requestId of recordedEvidence.keys()) if (!observedEvidence.has(requestId)) missing = true;
  for (const [key, [, , revision, digest]] of recordedRows) {
    const now = observedRows.get(key);
    if (now === undefined || now[2] < revision) missing = true;
    else if (now[2] > revision) extra = true;
    // The same revision of one row with other content: a fork, not progress.
    else if (now[3] !== digest) return { cls: 'DIVERGED', newEvidence };
  }
  for (const key of observedRows.keys()) if (!recordedRows.has(key)) extra = true;
  if (observed.createdRows < record.createdRows) missing = true;
  else if (observed.createdRows > record.createdRows) extra = true;
  if (missing && extra) return { cls: 'DIVERGED', newEvidence };
  if (missing) return { cls: 'ROLLED_BACK', newEvidence };
  return { cls: extra ? 'ADVANCED' : 'CONTINUOUS', newEvidence };
}

function assessment(namespace: string, cls: HistoryContinuityClass, record?: HistoryContinuityRecord, committedIntents: readonly string[] = []): HistoryContinuityAssessment {
  const admitted = cls === 'CONTINUOUS' || cls === 'ADVANCED';
  const proof = !admitted ? 'not-applicable' : record !== undefined && (record.createdRows > 0 || record.evidence.length > 0) ? 'content' : 'none';
  return Object.freeze({ namespace, class: cls, admitted, proof, committedIntents: Object.freeze([...committedIntents]) });
}

/**
 * Assesses one genuine handle against the Host's record for its namespace. `pendingIntents` are the
 * request ids of this Host's own bootstraps that may have committed since the record: the only new
 * evidence admitted.
 */
export function assessHistoryContinuity(
  rawRecord: unknown,
  observed: { readonly namespace: string; readonly databasePath: string; readonly store: unknown },
  pendingIntents: readonly BootstrapIntent[] = [],
): HistoryContinuityAssessment {
  const namespace = observed?.namespace;
  if (!isIdentifier(namespace, MAX_NAMESPACE_LENGTH)) return assessment(String(namespace), 'RECORD_INVALID');
  if (rawRecord === undefined) return assessment(namespace, 'UNREGISTERED');
  const record = readHistoryContinuityRecord(rawRecord);
  if (record === undefined) return assessment(namespace, 'RECORD_INVALID');
  if (record.namespace !== namespace) return assessment(namespace, 'NAMESPACE_MISMATCH');
  if (typeof observed.databasePath !== 'string' || resolve(observed.databasePath) !== record.databasePath) return assessment(namespace, 'MOVED');
  let checkpoint: StoreCheckpoint | undefined;
  try {
    checkpoint = storeCheckpointOf(observed.store, { namespace, databasePath: record.databasePath });
  } catch (error) {
    return assessment(namespace, error instanceof SovereignStatusHistoryStoreError && error.code === 'INTEGRITY' ? 'CORRUPT' : 'UNAVAILABLE');
  }
  if (checkpoint === undefined) return assessment(namespace, 'NOT_GENUINE');
  if (!checkpoint.fileIdentityStable) return assessment(namespace, 'FILE_REPLACED');
  if (checkpoint.schemaVersion !== record.schemaVersion) return assessment(namespace, 'SCHEMA_MISMATCH');
  const { cls, newEvidence } = compareContent(record, checkpoint);
  if (cls !== 'CONTINUOUS' && cls !== 'ADVANCED') return assessment(namespace, cls, record);
  // Re-review N2: explained only by an intent for the same request id **and** the same binding.
  const pending = new Map((Array.isArray(pendingIntents) ? pendingIntents : []).map((intent) => [intent?.requestId, intent?.bindingDigest]));
  if (newEvidence.some((found) => pending.get(found.requestId) !== found.bindingDigest)) return assessment(namespace, 'UNEXPLAINED_EVIDENCE', record);
  // R3 F3: an intent is committed when the file holds its exact evidence, whether or not the record already
  // holds it too (a crash after the re-capture, before the intent was completed, must not stay unresolved).
  const held = new Set(checkpoint.evidence.map(([requestId, , bindingDigest]) => JSON.stringify([requestId, bindingDigest])));
  const committed = (Array.isArray(pendingIntents) ? pendingIntents : []).filter((intent) => held.has(JSON.stringify([intent?.requestId, intent?.bindingDigest]))).map((intent) => intent.requestId);
  return assessment(namespace, cls, record, committed);
}

type OpenFailure = Extract<HistoryContinuityClass, 'NAMESPACE_MISMATCH' | 'SCHEMA_MISMATCH' | 'CORRUPT' | 'UNAVAILABLE'>;

/** FV-P4C-2B3B: open as the exclusive executor; `beforeWrite(file)` is the write fence of that file. */
export interface ExclusiveOpen {
  readonly beforeWrite: (file: string) => void;
}

/** Opens an existing history file, never creating one; a closed failure class otherwise. */
async function openExisting(path: string, namespace: string, readOnly: boolean, exclusive?: ExclusiveOpen): Promise<SqliteStatusHighWaterMarkStore | OpenFailure> {
  // A raw read of the header: never of a file this process holds exclusively (it would drop its POSIX locks).
  if (!hasSqliteHeader(path)) return 'CORRUPT';
  try {
    return await openSqliteStatusHighWaterMarkStore(path, exclusive === undefined ? { namespace, readOnly } : { namespace, exclusive: true, busyTimeoutMs: 0, beforeWrite: () => exclusive.beforeWrite(resolve(path)) });
  } catch (error) {
    if (!(error instanceof SovereignStatusHistoryStoreError)) return 'UNAVAILABLE';
    if (/another namespace/.test(error.message)) return 'NAMESPACE_MISMATCH';
    if (/schema version/.test(error.message)) return 'SCHEMA_MISMATCH';
    // Held by another executor, or not openable now: transient, never the file's fault.
    if (/held by another executor|could not be opened/.test(error.message)) return 'UNAVAILABLE';
    // Every other open refusal names the file itself (not a history, integrity, triggers, not WAL).
    return error.code === 'OPEN_REFUSED' ? 'CORRUPT' : 'UNAVAILABLE';
  }
}

/**
 * Opens the configured history for one recorded namespace and assesses it, never creating a file.
 * Assessment uses a read-only handle (review M6: a quarantined file is never written to). Only an
 * admitted history is reopened read-write, unless `readOnly`, and re-assessed on that handle.
 */
export async function openRecordedHistory(
  rawRecord: unknown,
  options: { readonly namespace: string; readonly databasePath: string; readonly readOnly?: boolean; readonly pendingIntents?: readonly BootstrapIntent[]; readonly exclusive?: ExclusiveOpen },
): Promise<{ readonly assessment: HistoryContinuityAssessment; readonly store?: SqliteStatusHighWaterMarkStore }> {
  const namespace = options?.namespace;
  if (!isIdentifier(namespace, MAX_NAMESPACE_LENGTH) || typeof options.databasePath !== 'string' || options.databasePath.trim() === '') return { assessment: assessment(String(namespace), 'RECORD_INVALID') };
  if (rawRecord === undefined) return { assessment: assessment(namespace, 'UNREGISTERED') };
  const record = readHistoryContinuityRecord(rawRecord);
  if (record === undefined) return { assessment: assessment(namespace, 'RECORD_INVALID') };
  if (record.namespace !== namespace) return { assessment: assessment(namespace, 'NAMESPACE_MISMATCH') };
  if (resolve(options.databasePath) !== record.databasePath) return { assessment: assessment(namespace, 'MOVED') };
  if (!existsSync(record.databasePath)) return { assessment: assessment(namespace, 'MISSING') };
  const pending = options.pendingIntents ?? [];
  if (options.exclusive !== undefined) {
    // FV-P4C-2B3B: one exclusive, writable open (it writes nothing: the file must already be WAL), assessed
    // on that handle. No read-only probe first: closing it and reopening would leave a window without the lock.
    if (options.readOnly === true || typeof options.exclusive?.beforeWrite !== 'function') return { assessment: assessment(namespace, 'RECORD_INVALID') };
    const held = await openExisting(record.databasePath, namespace, false, options.exclusive);
    if (typeof held === 'string') return { assessment: assessment(namespace, held) };
    const assessed = assessHistoryContinuity(record, { namespace, databasePath: record.databasePath, store: held }, pending);
    if (!assessed.admitted) {
      held.close();
      return { assessment: assessed };
    }
    return { assessment: assessed, store: held };
  }
  const probe = await openExisting(record.databasePath, namespace, true);
  if (typeof probe === 'string') return { assessment: assessment(namespace, probe) };
  const first = assessHistoryContinuity(record, { namespace, databasePath: record.databasePath, store: probe }, pending);
  if (!first.admitted || options.readOnly === true) {
    if (!first.admitted) probe.close();
    return first.admitted ? { assessment: first, store: probe } : { assessment: first };
  }
  probe.close();
  const writable = await openExisting(record.databasePath, namespace, false);
  if (typeof writable === 'string') return { assessment: assessment(namespace, writable) };
  const second = assessHistoryContinuity(record, { namespace, databasePath: record.databasePath, store: writable }, pending);
  if (!second.admitted) {
    writable.close();
    return { assessment: second };
  }
  return { assessment: second, store: writable };
}

/** The verdict on a restore candidate: never promoted automatically, and only ever if it holds everything the Host last recorded. */
export interface RestoreCandidateAssessment {
  readonly namespace: string;
  readonly class: HistoryContinuityClass;
  /** True only for `CONTINUOUS` content, or `ADVANCED` without unexplained evidence. Promotion still needs an explicit, authorized operator action (B3C). */
  readonly promotable: boolean;
  /** `none` when the record was empty, so any history of the namespace would match it (review L4). */
  readonly proof: 'content' | 'none' | 'not-applicable';
  readonly automatic: false;
}

/**
 * FV-P4C-2B3A — a restored (staged) history file, compared with the Host's record for its namespace,
 * wherever it was staged. Opened read-only, never created, always closed. An older backup is
 * `ROLLED_BACK`, another history is `DIVERGED`; both stay quarantined.
 */
export async function assessRestoreCandidate(rawRecord: unknown, candidate: { readonly namespace: string; readonly stagedPath: string }): Promise<RestoreCandidateAssessment> {
  const namespace = candidate?.namespace;
  const verdict = (found: HistoryContinuityAssessment | HistoryContinuityClass): RestoreCandidateAssessment => {
    const a = typeof found === 'string' ? assessment(String(namespace), found) : found;
    return Object.freeze({ namespace: String(namespace), class: a.class, promotable: a.admitted, proof: a.proof, automatic: false });
  };
  if (!isIdentifier(namespace, MAX_NAMESPACE_LENGTH) || typeof candidate.stagedPath !== 'string' || candidate.stagedPath.trim() === '') return verdict('RECORD_INVALID');
  if (rawRecord === undefined) return verdict('UNREGISTERED');
  const record = readHistoryContinuityRecord(rawRecord);
  if (record === undefined) return verdict('RECORD_INVALID');
  if (record.namespace !== namespace) return verdict('NAMESPACE_MISMATCH');
  if (!existsSync(candidate.stagedPath)) return verdict('MISSING');
  const store = await openExisting(candidate.stagedPath, namespace, true);
  if (typeof store === 'string') return verdict(store);
  try {
    // The staged path is not the configured one: compare content as if it were.
    let checkpoint: StoreCheckpoint | undefined;
    try {
      checkpoint = storeCheckpointOf(store, { namespace, databasePath: candidate.stagedPath });
    } catch (error) {
      return verdict(error instanceof SovereignStatusHistoryStoreError && error.code === 'INTEGRITY' ? 'CORRUPT' : 'UNAVAILABLE');
    }
    if (checkpoint === undefined) return verdict('NOT_GENUINE');
    if (checkpoint.schemaVersion !== record.schemaVersion) return verdict('SCHEMA_MISMATCH');
    const { cls, newEvidence } = compareContent(record, checkpoint);
    if ((cls === 'CONTINUOUS' || cls === 'ADVANCED') && newEvidence.length > 0) return verdict(assessment(namespace, 'UNEXPLAINED_EVIDENCE', record));
    return verdict(assessment(namespace, cls, record));
  } finally {
    store.close();
  }
}

/** The schema this module records; a test pins it to the store's. */
export const HISTORY_CONTINUITY_SCHEMA = SOVEREIGN_STATUS_HISTORY_SCHEMA_VERSION;

const SQLITE_HEADER = Buffer.from('SQLite format 3\u0000', 'latin1');

/** Whether an existing file starts like a SQLite database: one that does not is corrupt, not merely busy. Unreadable counts as busy (`true`). */
function hasSqliteHeader(path: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const head = Buffer.alloc(SQLITE_HEADER.length);
    const read = readSync(fd, head, 0, head.length, 0);
    return read === head.length && head.equals(SQLITE_HEADER);
  } catch {
    return true;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** One key per history row: asset and issuer, unambiguously joined. */
function revisionKey(t: readonly unknown[]): string {
  return JSON.stringify([t[0], t[1]]);
}

function sortBy<T>(items: T[], key: (item: T) => string): T[] {
  return items.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

function readTuples(value: unknown, valid: (t: readonly unknown[]) => boolean, keyOf: (t: readonly unknown[]) => string): unknown[][] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: unknown[][] = [];
  let previous: string | undefined;
  for (const item of value as unknown[]) {
    if (!Array.isArray(item) || !valid(item)) return undefined;
    const key = keyOf(item);
    // Sorted and unique, as captured: one spelling per record.
    if (previous !== undefined && !(previous < key)) return undefined;
    previous = key;
    out.push(Object.freeze([...item]) as unknown[]);
  }
  return out;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value as Record<string, unknown>)) deepFreeze(inner);
  }
  return value;
}
