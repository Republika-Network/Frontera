import { bootstrapEvidenceDigest, canonicalInstant, isDigest, isIdentifier } from './bootstrap-contract.js';
import type { StatusHistoryBootstrapEvidence } from './bootstrap-contract.js';
import { BOOTSTRAP_HUMAN_DECISION_FORMAT, BOOTSTRAP_HUMAN_DECISION_REQUEST_PREFIX, BOOTSTRAP_HUMAN_DECISION_ROLES, parseBootstrapAuthorityRef } from './human-decision-authorizer.js';
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
 * **The one irreducible race.** `bootstrap-not-committed` with
 * `NO_BOOTSTRAP_EVIDENCE` is recorded only once the decision is not in flight
 * (the Host's in-process registry) *and* at least `graceSeconds` have passed
 * since it was consumed. If a commit lands before this run's re-read, the run
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
 * Bounded: at most `maxDecisions` per run. Runs of one reconciler are
 * serialized; concurrent reconcilers are safe because AUTH-03 appends are
 * serialized and an identical second settlement is `unchanged`. There is no
 * administrative override, endpoint or manual settlement.
 */

export const BOOTSTRAP_AUTHORITY_RECONCILER = 'frontera.sovereign-status-bootstrap-authority-reconciler/1' as const;
export const BOOTSTRAP_AUTHORITY_SETTLEMENT_MAX_DECISIONS = 1000;
export const BOOTSTRAP_AUTHORITY_SETTLEMENT_MAX_GRACE_SECONDS = 3600;

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

export type BootstrapAuthorityUnresolvedReason = 'IN_FLIGHT' | 'WITHIN_GRACE' | 'HISTORY_UNAVAILABLE' | 'SETTLEMENT_FAILED' | 'SETTLEMENT_UNAUTHORIZED' | 'CLOCK_INVALID';
export type BootstrapAuthorityConflictReason = 'DECISION_MALFORMED' | 'EVIDENCE_CONTRADICTS_DECISION' | 'MULTIPLE_EVIDENCE' | 'SETTLEMENT_CONFLICT' | 'EVIDENCE_APPEARED_AFTER_NOT_COMMITTED';

export type BootstrapAuthorityReconciliationEntry =
  | { readonly commitment: string; readonly result: 'settled' | 'unchanged'; readonly settlement: BootstrapAuthoritySettlementRecord }
  | { readonly commitment: string; readonly result: 'unresolved'; readonly reason: BootstrapAuthorityUnresolvedReason }
  | { readonly commitment: string; readonly result: 'conflict'; readonly reason: BootstrapAuthorityConflictReason };

export interface BootstrapAuthorityReconcilerOptions {
  /** AUTH-03's settlement capability (`createHumanIdentityServiceWithBootstrapSettlement`), used as the settlement port. Held only here. */
  readonly settlement: BootstrapAuthoritySettlementPort;
  /** Every status history store of this Host's organization, one per namespace. A binding is searched in all of them. */
  readonly histories: readonly BootstrapEvidenceHistory[];
  readonly organizationId: string;
  /** The Host's trusted clock, as a canonical UTC instant. */
  readonly now: () => string;
  /** How long after consumption a decision with no evidence may still commit. 1–3600. */
  readonly graceSeconds: number;
  /** The Host's in-process registry of decisions whose bootstrap may still commit. Required: there is no "nothing is in flight" default. */
  readonly inFlight: (commitment: string) => boolean;
  /** At most this many decisions per run, oldest first. 1–1000; default 100. */
  readonly maxDecisions?: number;
}

export interface BootstrapAuthorityReconciler {
  reconcile(): Promise<readonly BootstrapAuthorityReconciliationEntry[]>;
}

interface UnsettledDecision {
  readonly commitment: string;
  readonly bindingDigest: string;
  readonly role: 'attest' | 'approve';
  readonly operatorId: string;
  readonly decidedAt: bigint;
}

const COMMITMENT = /^sha256:[0-9a-f]{64}$/;

export function createBootstrapAuthorityReconciler(options: BootstrapAuthorityReconcilerOptions): BootstrapAuthorityReconciler {
  const { settlement: decisions, organizationId, now } = options;
  const configured = Array.isArray(options.histories) ? [...options.histories] : [];
  const graceSeconds = options.graceSeconds;
  const maxDecisions = options.maxDecisions ?? 100;
  const inFlight = options.inFlight;
  if (typeof inFlight !== 'function') throw new TypeError('inFlight is the Host’s in-flight registry; it is required.');
  if (typeof decisions?.recordBootstrapAuthoritySettlement !== 'function' || typeof decisions.unsettledBootstrapAuthorityDecisions !== 'function') throw new TypeError('settlement is AUTH-03’s settlement capability.');
  if (!isIdentifier(organizationId, 256)) throw new TypeError('The organization id is a non-empty identifier.');
  if (!Number.isSafeInteger(graceSeconds) || graceSeconds < 1 || graceSeconds > BOOTSTRAP_AUTHORITY_SETTLEMENT_MAX_GRACE_SECONDS) throw new TypeError('graceSeconds is an integer between 1 and 3600.');
  if (!Number.isSafeInteger(maxDecisions) || maxDecisions < 1 || maxDecisions > BOOTSTRAP_AUTHORITY_SETTLEMENT_MAX_DECISIONS) throw new TypeError('maxDecisions is an integer between 1 and 1000.');
  if (configured.length === 0 || new Set(configured.map((history) => history?.namespace)).size !== configured.length) throw new TypeError('histories names every history store of the organization, once each.');
  // F1: only genuine store handles, for exactly the configured namespace and file. A look-alike reader is refused here, before any run.
  const histories: TrustedBootstrapEvidenceSource[] = configured.map((history) => {
    const source = trustedBootstrapEvidenceSource(history?.store, { namespace: history?.namespace, databasePath: history?.databasePath });
    if (source === undefined) throw new TypeError('A history is not a genuine status history store handle for its configured namespace and database file.');
    return source;
  });

  let tail: Promise<unknown> = Promise.resolve();

  /** Every evidence record for a binding, across every history; `undefined` when any store cannot answer. */
  async function evidenceFor(bindingDigest: string): Promise<readonly StatusHistoryBootstrapEvidence[] | undefined> {
    const found: StatusHistoryBootstrapEvidence[] = [];
    for (const history of histories) {
      try {
        found.push(...history.readBootstrapEvidenceForBinding(bindingDigest));
      } catch {
        return undefined;
      }
    }
    return found;
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

  async function settleOne(decision: UnsettledDecision, at: bigint): Promise<BootstrapAuthorityReconciliationEntry> {
    const { commitment, bindingDigest } = decision;
    if (inFlight(commitment) === true) return { commitment, result: 'unresolved', reason: 'IN_FLIGHT' };
    const evidence = await evidenceFor(bindingDigest);
    if (evidence === undefined) return { commitment, result: 'unresolved', reason: 'HISTORY_UNAVAILABLE' };
    if (evidence.length > 1) return { commitment, result: 'conflict', reason: 'MULTIPLE_EVIDENCE' };

    if (evidence.length === 1) {
      const anchored = evidence[0]!;
      if (anchored.bindingDigest !== bindingDigest) return { commitment, result: 'conflict', reason: 'EVIDENCE_CONTRADICTS_DECISION' };
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

    // No evidence. Only once the attempt can no longer commit is it settled as not committed.
    if (at - decision.decidedAt < BigInt(graceSeconds) * 1_000_000_000n) return { commitment, result: 'unresolved', reason: 'WITHIN_GRACE' };
    if (inFlight(commitment) === true) return { commitment, result: 'unresolved', reason: 'IN_FLIGHT' };
    const settled = await record(decision, { outcome: 'bootstrap-not-committed', bindingDigest, code: 'NO_BOOTSTRAP_EVIDENCE' });
    if (settled.result !== 'settled' && settled.result !== 'unchanged') return settled;
    // A commit that still landed is surfaced, never rewritten.
    const after = await evidenceFor(bindingDigest);
    if (after === undefined) return settled;
    if (after.some((anchored) => [parseBootstrapAuthorityRef(anchored.authorityRef)?.requesterCommitment, parseBootstrapAuthorityRef(anchored.authorityRef)?.approverCommitment].includes(commitment))) {
      return { commitment, result: 'conflict', reason: 'EVIDENCE_APPEARED_AFTER_NOT_COMMITTED' };
    }
    return settled;
  }

  async function run(): Promise<readonly BootstrapAuthorityReconciliationEntry[]> {
    const at = canonicalInstant(now());
    const listed = [...decisions.unsettledBootstrapAuthorityDecisions()].slice(0, maxDecisions);
    const entries: BootstrapAuthorityReconciliationEntry[] = [];
    for (const raw of listed) {
      const decision = readUnsettled(raw, organizationId);
      const commitment = typeof (raw as { commitment?: unknown } | null)?.commitment === 'string' ? ((raw as { commitment: string }).commitment) : '';
      if (decision === undefined) {
        entries.push({ commitment, result: 'conflict', reason: 'DECISION_MALFORMED' });
        continue;
      }
      if (at === undefined) {
        entries.push({ commitment, result: 'unresolved', reason: 'CLOCK_INVALID' });
        continue;
      }
      entries.push(await settleOne(decision, at));
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
  if (typeof approvalRequestId !== 'string' || !approvalRequestId.startsWith(BOOTSTRAP_HUMAN_DECISION_REQUEST_PREFIX)) return undefined;
  const bindingDigest = approvalRequestId.slice(BOOTSTRAP_HUMAN_DECISION_REQUEST_PREFIX.length);
  if (!isDigest(bindingDigest) || contract['subjectDigest'] !== `sha256:${bindingDigest}` || evidence['subjectDigest'] !== contract['subjectDigest'] || evidence['approvalRequestId'] !== approvalRequestId) return undefined;
  const role = contract['verdict'];
  if ((role !== 'attest' && role !== 'approve') || evidence['verdict'] !== role) return undefined;
  const operatorId = contract['operatorId'];
  if (typeof operatorId !== 'string' || evidence['operatorId'] !== operatorId) return undefined;
  const decidedAt = canonicalInstant(evidence['decidedAt']);
  if (decidedAt === undefined) return undefined;
  return { commitment, bindingDigest, role, operatorId, decidedAt };
}
