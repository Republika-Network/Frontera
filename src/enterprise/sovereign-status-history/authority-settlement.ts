import { randomInt } from 'node:crypto';
import { resolve } from 'node:path';

import { bootstrapEvidenceDigest, canonicalInstant, isDigest, isIdentifier } from './bootstrap-contract.js';
import type { StatusHistoryBootstrapEvidence } from './bootstrap-contract.js';
import { BOOTSTRAP_HUMAN_DECISION_FORMAT, BOOTSTRAP_HUMAN_DECISION_ROLES, parseBootstrapAuthorityRef, parseBootstrapHumanDecisionRequestId } from './human-decision-authorizer.js';
import { trustedBootstrapEvidenceSource, type TrustedBootstrapEvidenceSource } from './sqlite-status-high-water-mark-store.js';

/**
 * FV-P4C-2B2B (B1) — the external settlement of bootstrap-authority
 * decisions: what happened to the bootstrap a consumed AUTH-03 decision was
 * consumed for, read from the receiver's own bootstrap evidence.
 *
 * ```
 * issued ──(passkey, verified)──► consumed (unsettled) ──► settled
 *   └─ expired                       │                       ├─ bootstrap-committed      ← evidence names this decision, in its role
 *                                    │                       └─ bootstrap-not-committed  ← no evidence after the grace bound,
 *                                    │                                                     or the binding anchored by other decisions
 *                                    └─ unresolved (no write): in flight, within grace, history unreadable, AUTH-03 append failed
 *                                    └─ conflict   (no write): evidence contradicts the decision, a different settlement exists
 * ```
 *
 * **Why it is separate from CORE-05 reconciliation.** CORE-05's `reconcile()`
 * labels every consumed decision without a CORE-05 verdict `abandoned`. A
 * bootstrap-authority decision never reaches that loop: AUTH-03's
 * `unsettledDecisions()` lists CORE-05-domain decisions only, and its
 * `recordDecisionOutcome` refuses this domain. CORE-05's reconciliation code is
 * unchanged.
 *
 * **Consumed is never committed.** A settlement says `bootstrap-committed`
 * only when a history store this reconciler reads holds a validated bootstrap
 * evidence record for the decision's binding whose `authorityRef` names this
 * decision's commitment *in its own role*. The settlement then cites that
 * record by digest, request id and committed transition. AUTH-03 itself checks
 * that the settlement names the decision's own binding, and that the
 * counterpart is a consumed decision of the other role, by another human.
 *
 * **No distributed transaction.** The AUTH-03 chain and the receiver's SQLite
 * history are separate stores. Every cross-store failure leaves the decision
 * unsettled, and the next run settles it:
 * - the history is unreadable → unresolved, never "no evidence";
 * - the AUTH-03 append fails → unresolved;
 * - the bootstrap committed but this run never happened → the evidence is
 *   durable, so the next run settles `bootstrap-committed`.
 *
 * **Absence of evidence (FV-P4C-2B2C, R5).** A decision's signed request id
 * names the one status history namespace its bootstrap targets, and a
 * bootstrap's evidence can only be written into the store pinned to that
 * namespace. `bootstrap-not-committed` with `NO_BOOTSTRAP_EVIDENCE` is
 * therefore recorded only when the run's inventory snapshot holds a genuine,
 * readable handle for **that** namespace, and the snapshot is unchanged when
 * the settlement is written. A namespace missing from the inventory, an
 * inventory not loaded, unavailable, stale, malformed or changed mid-run, or a
 * history that cannot be read, leaves the decision unresolved, never "no
 * evidence". No completeness flag is read or believed: completeness is never
 * needed, only the presence of the decision's own history.
 *
 * **The one irreducible race.** `bootstrap-not-committed` with
 * `NO_BOOTSTRAP_EVIDENCE` is recorded only once the decision is not in flight
 * (the Host's in-process registry answers exactly `false`) *and* at least
 * `graceSeconds` have passed since it was consumed. If a commit lands before this run's re-read, the run
 * reports `EVIDENCE_APPEARED_AFTER_NOT_COMMITTED` as a conflict; AUTH-03 then
 * refuses to settle the counterpart as committed against it, and refuses a
 * not-committed settlement for a decision a committed counterpart names. A
 * commit landing after the run, with both decisions already settled not
 * committed, is **not** detected: it leaves a false *failure* record (never a
 * false success). Settlements are append-only, one per decision.
 *
 * **Who may settle (F1).** A settlement reaches AUTH-03's signed chain only
 * through that service's own settlement capability object, which this
 * reconciler receives from the Host's authority-construction boundary and
 * uses as its port (it never hands the capability to another object). Evidence is read
 * only through **genuine** history handles, checked by module-private
 * provenance (`trustedBootstrapEvidenceSource`), for the configured
 * namespace and database file. A look-alike reader is refused when the
 * reconciler is constructed. Provenance is in-process: it does not prove the
 * file is the latest history (whole-file rollback, FV-P4D), and nothing here
 * defends against a compromised process.
 *
 * **Liveness (FV-P4C-2B2C, F2).** Each run examines at most `maxDecisions`
 * unsettled decisions: a page of the unsettled set in commitment order,
 * starting just after a cursor (the last commitment examined) and wrapping
 * around. The cursor advances past every examined decision whatever its
 * result, so decisions that stay unresolved or in conflict are re-examined
 * once per revolution and can never hold the page against newer ones. A run
 * examines a commitment at most once. With no durable progress, the first
 * run of a reconciler starts at a uniformly random position, so a restarted
 * process never deterministically returns to the same blocked prefix. A
 * Host may persist the cursor through `progress` (B3); it is a position
 * hint only, saved before the page is processed (a decision that crashes the
 * process cannot pin it), and no outcome ever depends on it.
 *
 * Runs of one reconciler are serialized; concurrent reconcilers are safe
 * because AUTH-03 appends are serialized and an identical second settlement
 * is `unchanged`. There is no administrative override, endpoint or manual
 * settlement.
 */

export const BOOTSTRAP_AUTHORITY_RECONCILER = 'frontera.sovereign-status-bootstrap-authority-reconciler/2' as const;
export const BOOTSTRAP_AUTHORITY_SETTLEMENT_MAX_DECISIONS = 1000;
export const BOOTSTRAP_AUTHORITY_SETTLEMENT_MAX_GRACE_SECONDS = 3600;
/** At most this many histories in one inventory snapshot. */
export const BOOTSTRAP_EVIDENCE_INVENTORY_MAX_HISTORIES = 256;

/**
 * Structurally, AUTH-03's `BootstrapSettlementCapability`: the capability *is* the settlement port,
 * bound to its service at issuance. The reconciler never passes a token to any object, so a
 * look-alike port can only write to itself; a write into the real AUTH-03 chain needs the real
 * capability object.
 */
export interface BootstrapAuthoritySettlementPort {
  unsettledBootstrapAuthorityDecisions(): readonly unknown[];
  recordBootstrapAuthoritySettlement(commitment: string, settlement: BootstrapAuthoritySettlementRecord): Promise<'recorded' | 'unchanged'>;
}

/** One history the reconciler reads: a genuine store handle, and the namespace and file the Host configured for it. */
export interface BootstrapEvidenceHistory {
  /** A handle returned by `openSqliteStatusHighWaterMarkStore`. Any other object is refused. */
  readonly store: unknown;
  readonly namespace: string;
  readonly databasePath: string;
}

/**
 * FV-P4C-2B2C — one snapshot of the Host's configured status histories. Closed shape: every other key
 * (a `complete` flag, say) makes the snapshot invalid, because nothing here believes a claim of
 * completeness. A `generation` is the Host configuration's version: it never decreases, and one
 * generation always names the same namespaces and files.
 */
export interface BootstrapEvidenceInventorySnapshot {
  readonly generation: number;
  readonly histories: readonly BootstrapEvidenceHistory[];
}

/** FV-P4C-2B2C — where a Host (B3) may keep the cursor across restarts. A position hint only: never trusted for any outcome. */
export interface BootstrapAuthorityReconcilerProgress {
  /** The last saved cursor, or anything else (ignored: the run starts at a random position). */
  load(): unknown;
  /** Called once per run, before the page is processed. A failure is tolerated: the in-process cursor still advances. */
  save(cursor: string): unknown;
}

/** The settlement shapes AUTH-03 records (`BootstrapAuthoritySettlement`). */
export type BootstrapAuthoritySettlementRecord =
  | {
      readonly outcome: 'bootstrap-committed';
      readonly bindingDigest: string;
      readonly counterpartCommitment: string;
      readonly bootstrapRequestId: string;
      readonly bootstrapEvidenceDigest: string;
      readonly historyRevision: number;
      readonly statusSequence: number;
      readonly statusDigest: string;
    }
  | { readonly outcome: 'bootstrap-not-committed'; readonly bindingDigest: string; readonly code: 'NO_BOOTSTRAP_EVIDENCE' | 'ANCHORED_BY_OTHER_DECISIONS' };

export type BootstrapAuthorityUnresolvedReason =
  | 'IN_FLIGHT'
  | 'WITHIN_GRACE'
  | 'HISTORY_UNAVAILABLE'
  | 'HISTORY_CORRUPT'
  | 'HISTORY_NOT_IN_INVENTORY'
  | 'INVENTORY_NOT_LOADED'
  | 'INVENTORY_UNAVAILABLE'
  | 'INVENTORY_INVALID'
  | 'INVENTORY_UNTRUSTED_HISTORY'
  | 'INVENTORY_DUPLICATE_NAMESPACE'
  | 'INVENTORY_DUPLICATE_DATABASE'
  | 'INVENTORY_STALE'
  | 'INVENTORY_GENERATION_REUSED'
  | 'INVENTORY_CHANGED'
  | 'INVENTORY_HISTORY_MOVED'
  | 'SETTLEMENT_FAILED'
  | 'SETTLEMENT_UNAUTHORIZED'
  | 'CLOCK_INVALID';
export type BootstrapAuthorityConflictReason = 'DECISION_MALFORMED' | 'DECISION_DUPLICATE' | 'EVIDENCE_CONTRADICTS_DECISION' | 'MULTIPLE_EVIDENCE' | 'SETTLEMENT_CONFLICT' | 'EVIDENCE_APPEARED_AFTER_NOT_COMMITTED';

export type BootstrapAuthorityReconciliationEntry =
  | { readonly commitment: string; readonly result: 'settled' | 'unchanged'; readonly settlement: BootstrapAuthoritySettlementRecord }
  | { readonly commitment: string; readonly result: 'unresolved'; readonly reason: BootstrapAuthorityUnresolvedReason }
  | { readonly commitment: string; readonly result: 'conflict'; readonly reason: BootstrapAuthorityConflictReason };

export interface BootstrapAuthorityReconcilerOptions {
  /** AUTH-03's settlement capability (`createHumanIdentityServiceWithBootstrapSettlement`), used as the settlement port. Held only here. */
  readonly settlement: BootstrapAuthoritySettlementPort;
  /**
   * A fixed inventory: the Host's status history stores, one per namespace, validated when the reconciler is constructed
   * (generation 0). Exactly one of `histories` and `inventory`.
   */
  readonly histories?: readonly BootstrapEvidenceHistory[];
  /**
   * FV-P4C-2B2C — the Host's configured inventory, read once per run (and again before a negative settlement).
   * `undefined` means the configuration is not loaded yet. Exactly one of `histories` and `inventory`.
   */
  readonly inventory?: () => BootstrapEvidenceInventorySnapshot | undefined;
  readonly organizationId: string;
  /** The Host's trusted clock, as a canonical UTC instant. */
  readonly now: () => string;
  /** How long after consumption a decision with no evidence may still commit. 1–3600. */
  readonly graceSeconds: number;
  /**
   * The Host's in-process registry of decisions whose bootstrap may still commit. Required: there is no "nothing is in
   * flight" default. Only an answer of exactly `false` means not in flight; anything else, or a throw, is in flight.
   */
  readonly inFlight: (commitment: string) => boolean;
  /** At most this many decisions examined per run. 1–1000; default 100. */
  readonly maxDecisions?: number;
  /** FV-P4C-2B2C — optional durable cursor (B3). Without it, a new reconciler starts at a random position. */
  readonly progress?: BootstrapAuthorityReconcilerProgress;
}

export interface BootstrapAuthorityReconciler {
  reconcile(): Promise<readonly BootstrapAuthorityReconciliationEntry[]>;
}

interface UnsettledDecision {
  readonly commitment: string;
  readonly namespace: string;
  readonly bindingDigest: string;
  readonly role: 'attest' | 'approve';
  readonly operatorId: string;
  readonly decidedAt: bigint;
}

/** A validated inventory snapshot: genuine sources, one per namespace and file. */
interface AdmittedInventory {
  readonly generation: number;
  readonly fingerprint: string;
  readonly sources: readonly TrustedBootstrapEvidenceSource[];
  readonly byNamespace: ReadonlyMap<string, TrustedBootstrapEvidenceSource>;
  /** namespace → resolved database file. */
  readonly files: ReadonlyMap<string, string>;
  /** Namespaces this snapshot maps to another file than this reconciler pinned: never read. */
  readonly moved: ReadonlySet<string>;
}

type InventoryFailure = Extract<BootstrapAuthorityUnresolvedReason, `INVENTORY_${string}`>;

const COMMITMENT = /^sha256:[0-9a-f]{64}$/;
/** The page key of a listed record whose commitment is not a commitment: such records are malformed, reported together. */
const MALFORMED_KEY = '';

export function createBootstrapAuthorityReconciler(options: BootstrapAuthorityReconcilerOptions): BootstrapAuthorityReconciler {
  const { settlement: decisions, organizationId, now } = options;
  const graceSeconds = options.graceSeconds;
  const maxDecisions = options.maxDecisions ?? 100;
  const inFlightRegistry = options.inFlight;
  const progress = options.progress;
  if (typeof inFlightRegistry !== 'function') throw new TypeError('inFlight is the Host’s in-flight registry; it is required.');
  if (typeof decisions?.recordBootstrapAuthoritySettlement !== 'function' || typeof decisions.unsettledBootstrapAuthorityDecisions !== 'function') throw new TypeError('settlement is AUTH-03’s settlement capability.');
  if (!isIdentifier(organizationId, 256)) throw new TypeError('The organization id is a non-empty identifier.');
  if (!Number.isSafeInteger(graceSeconds) || graceSeconds < 1 || graceSeconds > BOOTSTRAP_AUTHORITY_SETTLEMENT_MAX_GRACE_SECONDS) throw new TypeError('graceSeconds is an integer between 1 and 3600.');
  if (!Number.isSafeInteger(maxDecisions) || maxDecisions < 1 || maxDecisions > BOOTSTRAP_AUTHORITY_SETTLEMENT_MAX_DECISIONS) throw new TypeError('maxDecisions is an integer between 1 and 1000.');
  if (progress !== undefined && (typeof progress?.load !== 'function' || typeof progress.save !== 'function')) throw new TypeError('progress, when given, has load() and save().');
  if ((options.histories === undefined) === (options.inventory === undefined)) throw new TypeError('Exactly one of histories (a fixed inventory) and inventory (the Host’s inventory provider) is given.');

  let provide: () => unknown;
  if (options.histories !== undefined) {
    // A fixed inventory is validated now: a look-alike reader (F1), a duplicate or a mismatched handle is refused before any run.
    const fixed = { generation: 0, histories: Array.isArray(options.histories) ? [...options.histories] : [] };
    const admitted = admit(fixed);
    if (typeof admitted === 'string') {
      if (admitted === 'INVENTORY_UNTRUSTED_HISTORY') throw new TypeError('A history is not a genuine status history store handle for its configured namespace and database file.');
      throw new TypeError('histories names every history store of the organization, once each (one namespace and one database file per store).');
    }
    provide = () => fixed;
  } else {
    const inventory = options.inventory;
    if (typeof inventory !== 'function') throw new TypeError('inventory is the Host’s inventory provider.');
    provide = () => inventory();
  }

  const inFlight = (commitment: string): boolean => {
    try {
      return inFlightRegistry(commitment) !== false;
    } catch {
      return true;
    }
  };

  let tail: Promise<unknown> = Promise.resolve();
  /** The last commitment examined; `undefined` until the first run decides where to start. */
  let cursor: string | undefined;
  let cursorLoaded = false;
  /** The highest inventory generation seen, and what it named. */
  let highGeneration = -1;
  let highFingerprint = '';
  /** Review #1: the file each namespace was first seen at, in this process. A namespace never moves to another file. */
  const pinnedFiles = new Map<string, string>();

  /** Reads and validates one inventory snapshot; a closed failure reason for anything not fully trustworthy. */
  function snapshot(): AdmittedInventory | InventoryFailure {
    let raw: unknown;
    try {
      raw = provide();
    } catch {
      return 'INVENTORY_UNAVAILABLE';
    }
    if (raw === undefined) return 'INVENTORY_NOT_LOADED';
    let admitted: AdmittedInventory | InventoryFailure;
    try {
      admitted = admit(raw);
    } catch {
      return 'INVENTORY_INVALID';
    }
    if (typeof admitted === 'string') return admitted;
    if (admitted.generation < highGeneration) return 'INVENTORY_STALE';
    if (admitted.generation === highGeneration && admitted.fingerprint !== highFingerprint) return 'INVENTORY_GENERATION_REUSED';
    // Review #1 (re-review): only the namespace that moved is refused; the pin never follows it.
    const moved = new Set<string>();
    for (const [namespace, file] of admitted.files) {
      const pinned = pinnedFiles.get(namespace);
      if (pinned === undefined) pinnedFiles.set(namespace, file);
      else if (pinned !== file) moved.add(namespace);
    }
    if (moved.size > 0) return { ...admitted, moved };
    highGeneration = admitted.generation;
    highFingerprint = admitted.fingerprint;
    return admitted;
  }

  /** Every evidence record for a binding, across the snapshot's histories; a closed reason when any store cannot answer. */
  /**
   * Every evidence record for the decision's binding in the decision's own history: the only store its
   * evidence can be written to (the coordinator refuses another namespace; the file is pinned to one).
   * Another history being unreadable never blocks this decision.
   */
  function evidenceFor(inventory: AdmittedInventory, decision: UnsettledDecision): readonly StatusHistoryBootstrapEvidence[] | 'HISTORY_NOT_IN_INVENTORY' | 'HISTORY_UNAVAILABLE' | 'HISTORY_CORRUPT' | 'INVENTORY_HISTORY_MOVED' {
    if (inventory.moved.has(decision.namespace)) return 'INVENTORY_HISTORY_MOVED';
    const own = inventory.byNamespace.get(decision.namespace);
    if (own === undefined) return 'HISTORY_NOT_IN_INVENTORY';
    try {
      return own.readBootstrapEvidenceForBinding(decision.bindingDigest);
    } catch (error) {
      return (error as { code?: unknown } | null)?.code === 'INTEGRITY' ? 'HISTORY_CORRUPT' : 'HISTORY_UNAVAILABLE';
    }
  }

  async function record(decision: UnsettledDecision, settlement: BootstrapAuthoritySettlementRecord): Promise<BootstrapAuthorityReconciliationEntry> {
    let written: 'recorded' | 'unchanged';
    try {
      written = await decisions.recordBootstrapAuthoritySettlement(decision.commitment, settlement);
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if (code === 'HUMAN_IDENTITY_DECISION_SETTLEMENT_CONFLICT') return { commitment: decision.commitment, result: 'conflict', reason: 'SETTLEMENT_CONFLICT' };
      if (code === 'HUMAN_IDENTITY_DECISION_SETTLEMENT_UNAUTHORIZED') return { commitment: decision.commitment, result: 'unresolved', reason: 'SETTLEMENT_UNAUTHORIZED' };
      return { commitment: decision.commitment, result: 'unresolved', reason: 'SETTLEMENT_FAILED' };
    }
    return { commitment: decision.commitment, result: written === 'recorded' ? 'settled' : 'unchanged', settlement };
  }

  async function settleOne(decision: UnsettledDecision, at: bigint, inventory: AdmittedInventory): Promise<BootstrapAuthorityReconciliationEntry> {
    const { commitment, bindingDigest } = decision;
    if (inFlight(commitment)) return { commitment, result: 'unresolved', reason: 'IN_FLIGHT' };
    const evidence = evidenceFor(inventory, decision);
    if (typeof evidence === 'string') return { commitment, result: 'unresolved', reason: evidence };
    if (evidence.length > 1) return { commitment, result: 'conflict', reason: 'MULTIPLE_EVIDENCE' };

    if (evidence.length === 1) {
      const anchored = evidence[0]!;
      // Evidence lives only in the store pinned to its namespace, and the decision signed that namespace.
      if (anchored.bindingDigest !== bindingDigest || anchored.namespace !== decision.namespace) return { commitment, result: 'conflict', reason: 'EVIDENCE_CONTRADICTS_DECISION' };
      const ref = parseBootstrapAuthorityRef(anchored.authorityRef);
      const mine = decision.role === BOOTSTRAP_HUMAN_DECISION_ROLES.requester ? ref?.requesterCommitment : ref?.approverCommitment;
      const theirs = decision.role === BOOTSTRAP_HUMAN_DECISION_ROLES.requester ? ref?.approverCommitment : ref?.requesterCommitment;
      // Named, but in the other role: the evidence and the signed decision disagree. Never settled.
      if (theirs === commitment) return { commitment, result: 'conflict', reason: 'EVIDENCE_CONTRADICTS_DECISION' };
      if (mine !== commitment) {
        // The binding is anchored, by other decisions: this attempt can never commit (its request id is recorded).
        return record(decision, { outcome: 'bootstrap-not-committed', bindingDigest, code: 'ANCHORED_BY_OTHER_DECISIONS' });
      }
      if (decision.role === BOOTSTRAP_HUMAN_DECISION_ROLES.requester && anchored.operatorRef !== `operator:${decision.operatorId}`) {
        return { commitment, result: 'conflict', reason: 'EVIDENCE_CONTRADICTS_DECISION' };
      }
      return record(decision, {
        outcome: 'bootstrap-committed',
        bindingDigest,
        counterpartCommitment: theirs!,
        bootstrapRequestId: anchored.requestId,
        bootstrapEvidenceDigest: bootstrapEvidenceDigest(anchored),
        historyRevision: anchored.next.revision,
        statusSequence: anchored.next.sequence,
        statusDigest: anchored.next.statusDigest,
      });
    }

    // No evidence in the decision's own, present history (R5). It means "not committed" only once the attempt can no longer commit.
    if (at - decision.decidedAt < BigInt(graceSeconds) * 1_000_000_000n) return { commitment, result: 'unresolved', reason: 'WITHIN_GRACE' };
    if (inFlight(commitment)) return { commitment, result: 'unresolved', reason: 'IN_FLIGHT' };
    // The inventory the absence was read under must still be the Host's.
    const current = snapshot();
    if (typeof current === 'string' || current.fingerprint !== inventory.fingerprint || current.byNamespace.get(decision.namespace) === undefined || current.moved.has(decision.namespace)) return { commitment, result: 'unresolved', reason: 'INVENTORY_CHANGED' };
    const settled = await record(decision, { outcome: 'bootstrap-not-committed', bindingDigest, code: 'NO_BOOTSTRAP_EVIDENCE' });
    if (settled.result !== 'settled' && settled.result !== 'unchanged') return settled;
    // A commit that still landed is surfaced, never rewritten.
    const after = evidenceFor(current, decision);
    if (typeof after === 'string') return settled;
    if (after.some((anchored) => [parseBootstrapAuthorityRef(anchored.authorityRef)?.requesterCommitment, parseBootstrapAuthorityRef(anchored.authorityRef)?.approverCommitment].includes(commitment))) {
      return { commitment, result: 'conflict', reason: 'EVIDENCE_APPEARED_AFTER_NOT_COMMITTED' };
    }
    return settled;
  }

  /** The commitments to examine this run: up to `maxDecisions`, in commitment order, just after the cursor, wrapping around. */
  function page(keys: readonly string[]): readonly string[] {
    if (keys.length === 0) return [];
    let start: number;
    if (cursor === undefined) {
      start = randomInt(keys.length);
    } else {
      const after = keys.findIndex((key) => key > cursor!);
      start = after === -1 ? 0 : after;
    }
    const count = Math.min(maxDecisions, keys.length);
    return Array.from({ length: count }, (_, offset) => keys[(start + offset) % keys.length]!);
  }

  async function loadCursor(): Promise<void> {
    if (cursorLoaded) return;
    cursorLoaded = true;
    if (progress === undefined) return;
    try {
      const loaded = await bounded(progress.load());
      if (typeof loaded === 'string' && (loaded === MALFORMED_KEY || COMMITMENT.test(loaded))) cursor = loaded;
    } catch {
      // An unreadable cursor is no cursor: the first run starts at a random position.
    }
  }

  async function run(): Promise<readonly BootstrapAuthorityReconciliationEntry[]> {
    await loadCursor();
    const at = canonicalInstant(now());
    // Every unsettled decision, grouped by commitment: a listing that names one twice is not believed for it.
    const listed = new Map<string, unknown[]>();
    for (const raw of [...decisions.unsettledBootstrapAuthorityDecisions()]) {
      let named: unknown;
      try {
        named = (raw as { commitment?: unknown } | null)?.commitment;
      } catch {
        // A record that cannot be read is malformed; it never stops the listing (look-alike ports only).
        named = undefined;
      }
      const key = typeof named === 'string' && COMMITMENT.test(named) ? named : MALFORMED_KEY;
      const group = listed.get(key);
      if (group === undefined) listed.set(key, [raw]);
      else group.push(raw);
    }
    const examined = page([...listed.keys()].sort());
    if (examined.length > 0) {
      // Advanced before the page is processed: no decision, even one that crashes the run, can hold the cursor.
      cursor = examined[examined.length - 1]!;
      if (progress !== undefined) {
        try {
          await bounded(progress.save(cursor));
        } catch {
          // Tolerated: the in-process cursor has advanced; a restart without it starts at a random position.
        }
      }
    }
    const inventory = examined.length > 0 ? snapshot() : undefined;
    const entries: BootstrapAuthorityReconciliationEntry[] = [];
    for (const key of examined) {
      const group = listed.get(key)!;
      if (key === MALFORMED_KEY) {
        entries.push({ commitment: MALFORMED_KEY, result: 'conflict', reason: 'DECISION_MALFORMED' });
        continue;
      }
      if (group.length > 1) {
        entries.push({ commitment: key, result: 'conflict', reason: 'DECISION_DUPLICATE' });
        continue;
      }
      let decision: UnsettledDecision | undefined;
      try {
        decision = readUnsettled(group[0], organizationId);
      } catch {
        // A record that cannot even be read is malformed; the rest of the page still runs.
        decision = undefined;
      }
      // The record must still name the commitment it was listed under.
      if (decision === undefined || decision.commitment !== key) {
        entries.push({ commitment: key, result: 'conflict', reason: 'DECISION_MALFORMED' });
        continue;
      }
      if (at === undefined) {
        entries.push({ commitment: key, result: 'unresolved', reason: 'CLOCK_INVALID' });
        continue;
      }
      if (inventory === undefined || typeof inventory === 'string') {
        entries.push({ commitment: key, result: 'unresolved', reason: inventory ?? 'INVENTORY_NOT_LOADED' });
        continue;
      }
      try {
        entries.push(await settleOne(decision, at, inventory));
      } catch {
        // Review #4: an unexpected fault in one decision never skips the rest of its page.
        entries.push({ commitment: key, result: 'unresolved', reason: 'SETTLEMENT_FAILED' });
      }
    }
    return Object.freeze(entries.map((entry) => Object.freeze(entry)));
  }

  return Object.freeze({
    reconcile(): Promise<readonly BootstrapAuthorityReconciliationEntry[]> {
      const result = tail.then(run);
      tail = result.catch(() => undefined);
      return result;
    },
  });
}

/** Review #5: a Host progress port is awaited at most this long; a stalled one never stalls reconciliation. */
const PROGRESS_TIMEOUT_MS = 5_000;

function bounded(value: unknown): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('progress port timed out')), PROGRESS_TIMEOUT_MS);
  });
  return Promise.race([Promise.resolve(value), timeout]).finally(() => clearTimeout(timer));
}

/**
 * FV-P4C-2B2C — validates one inventory snapshot, read as plain data: a closed shape, a generation, and
 * at most 256 histories, each a genuine handle for its configured namespace and file, no namespace and
 * no file twice. Completeness is neither claimed nor needed.
 */
function admit(value: unknown): AdmittedInventory | InventoryFailure {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'INVENTORY_INVALID';
  const keys = Object.keys(value);
  if (keys.length !== 2 || !keys.includes('generation') || !keys.includes('histories')) return 'INVENTORY_INVALID';
  const generation = (value as { generation?: unknown }).generation;
  const histories = (value as { histories?: unknown }).histories;
  if (typeof generation !== 'number' || !Number.isSafeInteger(generation) || generation < 0) return 'INVENTORY_INVALID';
  if (!Array.isArray(histories)) return 'INVENTORY_INVALID';
  const count = histories.length;
  if (!Number.isSafeInteger(count) || count === 0 || count > BOOTSTRAP_EVIDENCE_INVENTORY_MAX_HISTORIES) return 'INVENTORY_INVALID';
  const sources: TrustedBootstrapEvidenceSource[] = [];
  const byNamespace = new Map<string, TrustedBootstrapEvidenceSource>();
  const files = new Set<string>();
  const named: Array<readonly [string, string]> = [];
  // Read once, as plain values: a getter cannot answer differently to the checks below.
  const entries = Array.from({ length: count }, (_, index) => (histories as unknown[])[index]).map((history) => {
    if (typeof history !== 'object' || history === null) return undefined;
    const { store, namespace, databasePath } = history as Partial<BootstrapEvidenceHistory>;
    return { store, namespace, databasePath };
  });
  if (entries.some((entry) => entry === undefined)) return 'INVENTORY_INVALID';
  if (new Set(entries.map((entry) => entry!.namespace)).size !== entries.length) return 'INVENTORY_DUPLICATE_NAMESPACE';
  for (const { store, namespace, databasePath } of entries as Array<{ store: unknown; namespace: unknown; databasePath: unknown }>) {
    // F1: only a genuine store handle, for exactly the configured namespace and file.
    const source = trustedBootstrapEvidenceSource(store, { namespace: namespace as string, databasePath: databasePath as string });
    if (source === undefined || typeof namespace !== 'string' || typeof databasePath !== 'string') return 'INVENTORY_UNTRUSTED_HISTORY';
    const file = resolve(databasePath);
    if (files.has(file)) return 'INVENTORY_DUPLICATE_DATABASE';
    byNamespace.set(namespace, source);
    files.add(file);
    sources.push(source);
    named.push([namespace, file]);
  }
  named.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return { generation, fingerprint: JSON.stringify(named), sources, byNamespace, files: new Map(named), moved: new Set<string>() };
}

/** An unsettled AUTH-03 record, read as plain data and checked against the bootstrap-authority domain; `undefined` if anything disagrees. */
function readUnsettled(value: unknown, organizationId: string): UnsettledDecision | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const contract = record['contract'] as Record<string, unknown> | undefined;
  const evidence = record['evidence'] as Record<string, unknown> | undefined;
  const commitment = record['commitment'];
  if (record['state'] !== 'consumed' || record['settlement'] !== undefined || typeof contract !== 'object' || contract === null || typeof evidence !== 'object' || evidence === null) return undefined;
  if (typeof commitment !== 'string' || !COMMITMENT.test(commitment) || evidence['challengeCommitment'] !== commitment) return undefined;
  if (contract['format'] !== BOOTSTRAP_HUMAN_DECISION_FORMAT || contract['organizationId'] !== organizationId || evidence['organizationId'] !== organizationId) return undefined;
  const approvalRequestId = contract['approvalRequestId'];
  // R5: the signed request id names the decision's namespace and binding.
  const target = parseBootstrapHumanDecisionRequestId(approvalRequestId);
  if (target === undefined) return undefined;
  const { namespace, bindingDigest } = target;
  if (!isDigest(bindingDigest) || contract['subjectDigest'] !== `sha256:${bindingDigest}` || evidence['subjectDigest'] !== contract['subjectDigest'] || evidence['approvalRequestId'] !== approvalRequestId) return undefined;
  const role = contract['verdict'];
  if ((role !== 'attest' && role !== 'approve') || evidence['verdict'] !== role) return undefined;
  const operatorId = contract['operatorId'];
  if (typeof operatorId !== 'string' || evidence['operatorId'] !== operatorId) return undefined;
  const decidedAt = canonicalInstant(evidence['decidedAt']);
  if (decidedAt === undefined) return undefined;
  return { commitment, namespace, bindingDigest, role, operatorId, decidedAt };
}
