import { EMERGENCY_CONTROL_REASON_CODE_VALUES } from '../../features/emergency-control-runtime/index.js';
import { EXERCISE_CONTROL_REASON_CODE_VALUES } from '../../features/exercise-control-runtime/index.js';
import type { BoundedGrant } from '../../features/grant-runtime/index.js';
import { GRANT_EXERCISE_REASON_CODE_VALUES, isRecordableExecutionAdapterId, type ExecutionOutcome } from '../../features/execution-runtime/index.js';
import type { GovernanceRecord, GovernanceReferenceInput, GovernanceStoreAccessContext } from '../governance-store/contracts.js';
import type { GovernanceStore } from '../governance-store/governance-store.js';
import { authorizationReferenceId, executionAttemptReferenceId, executionOutcomeReferenceId, executionResolutionReferenceId } from './identifiers.js';

/**
 * Evidence writing for a governed action: which authorization artifact a
 * committed decision produced, which execution identity was attempted under
 * it, and what that attempt did.
 *
 * Every row is a Governance Store reference — **evidence, never authority**.
 *
 * ## Since P11
 *
 * The `attempt` row is unchanged: the write-ahead claim, and the only
 * at-most-once guard. The outcome row is no longer the canonical durable
 * outcome of a new execution — the execution outcome store holds that, with
 * its exact amount, certainty, attribution and provider reference — and is
 * written only after the canonical observation committed, as its compact
 * summary. For executions recorded before P11, which have no canonical record,
 * this row remains exactly what replay reads.
 * The one behavioural use of a row is negative: an existing `attempt` row for
 * an execution identity *prevents* a second adapter invocation. Nothing here
 * can permit one; the exercise gate reads the authoritative bounded-grant
 * store and nothing else.
 *
 * Reference ids are deterministic, and the Store refuses a second append of
 * one id (SQLite: `reference_id PRIMARY KEY`; in-memory: checked inside the
 * synchronous commit section for the evaluation, and every row for one
 * execution id attaches to the one evaluation its decision lives in). That is
 * what makes the `attempt` row a durable at-most-once marker — and no more
 * than that: it is not exactly-once.
 */
/**
 * Which layer withheld an effect. Three layers can, they own different
 * vocabularies, and a replay must report the one that actually did.
 *
 * `exercise-control` (P7) is the aggregate / velocity and exercise-time
 * authority-binding layer. Its row is **evidence** that an effect was withheld
 * and why — never the consumption state the admission was decided from, which
 * lives in the separate exercise-control ledger and is never reconstructed
 * from here.
 */
export type WithholdingLayer = 'grant-exercise' | 'emergency-control' | 'exercise-control';

export interface PriorExecution {
  readonly attempted: boolean;
  /**
   * `executed` | `withheld` | `execution-failed:<reason>` |
   * `execution-unconfirmed`, as recorded — or the raw recorded string when it
   * cannot be decoded, which no replay maps onto a known outcome. Absent when
   * no outcome row exists.
   *
   * `execution-unconfirmed` and an **absent** outcome both replay as
   * "unconfirmed" to a caller, and are deliberately not the same value here:
   * the first is the adapter's own recorded answer ("the provider was
   * contacted; the result is unknown"), the second is the absence of any
   * answer (a crash between the write-ahead claim and the outcome append).
   */
  readonly outcome?: string;
  /** Which layer withheld it. Present only with `outcome: 'withheld'`. */
  readonly withheldBy?: WithholdingLayer;
  /** That layer's own reason codes, exactly as recorded. Present only with `outcome: 'withheld'`. */
  readonly withheldReasonCodes?: readonly string[];
  /**
   * The adapter that **performed** the effect, as recorded.
   *
   * Present for an executed, provider-failed or unconfirmed attempt whose
   * adapter identity was recordable; absent for a withheld attempt, where
   * nothing ran, and for rows written before adapter attribution existed. Under server-side routing
   * this is the trusted-routed **child**, not the routing boundary — which is
   * the whole point: an auditor asking "which provider moved this money"
   * cannot be answered by the name of the router.
   */
  readonly adapterId?: string;
}

/**
 * A withheld effect is recorded as `withheld:<layer>:<CODE>,<CODE>…` — the
 * layer that withheld it, then that layer's reason codes in their own stable
 * order.
 *
 * The format is deterministic and bounded: a layer drawn from a closed
 * three-member set, at least one code, every code drawn from **that layer's own**
 * closed vocabulary, none repeated, so at most one entry per vocabulary member.
 * Anything else is not encoded and never decoded: a replay reports only reasons
 * that were recorded, and the ledger records nothing it could not later read
 * back exactly.
 *
 * The layer is part of the record rather than inferred from the codes, because
 * inferring it would make the two vocabularies' disjointness a *correctness*
 * requirement of the replay path rather than a hygiene property — and a code
 * added to the wrong constant would then silently re-label history.
 *
 * ## The Prompt 3 form still reads
 *
 * Rows written before this phase carry `withheld:<CODE>,<CODE>…` with no layer,
 * and only the grant-exercise layer could write one. They decode as
 * `grant-exercise`, unchanged. The two forms cannot be confused: a layer token
 * is lowercase and hyphenated, a reason code is upper-snake, and neither
 * vocabulary contains the other's spellings.
 *
 * The codes explain a refusal. They are evidence of why nothing ran, and they
 * cannot permit anything. **The ledger is never read to decide whether a new
 * action is allowed** — its only behavioural use stays negative: this execution
 * identity was already attempted, so do not attempt it again.
 */
const WITHHELD_PREFIX = 'withheld:';

/**
 * The performing adapter is appended to an effect-bearing outcome as
 * `…@<adapterId>`.
 *
 * Deterministic and bounded on both sides: the id is recorded only when
 * `isRecordableExecutionAdapterId` accepts it — bounded length, and no `@` to
 * collide with the delimiter — so the recorded string decodes back to exactly
 * the id that was written. The registry refuses a non-recordable child at
 * composition, so the routed path always carries attribution; a host that
 * composed one adapter directly with an exotic identity records the outcome
 * without it rather than failing to record the outcome at all, because losing
 * the *fact* of execution is far worse than losing its label.
 *
 * `@` is split from the right, so an id containing `:` — as the reason-code and
 * layer delimiters do — is still unambiguous.
 */
const ADAPTER_DELIMITER = '@';

/**
 * The canonical recorded form of an adapter-reported unconfirmed effect,
 * before its `@<adapterId>` suffix.
 *
 * A separate token rather than a flavour of `execution-failed:` on purpose: a
 * replay that decoded it as a failure would tell a caller the effect did not
 * happen, which nobody knows. Only this exact body decodes as unconfirmed;
 * anything longer, shorter or decorated is an undecodable row, which replays
 * as "attempted, outcome not on record" — still unconfirmed, never executed,
 * never failed, and never a second invocation.
 */
export const EXECUTION_UNCONFIRMED_OUTCOME = 'execution-unconfirmed';

function withAdapter(recorded: string, adapterId: string | undefined): string {
  return adapterId !== undefined && isRecordableExecutionAdapterId(adapterId) ? `${recorded}${ADAPTER_DELIMITER}${adapterId}` : recorded;
}

function splitAdapter(recorded: string): { readonly body: string; readonly adapterId?: string } {
  const at = recorded.lastIndexOf(ADAPTER_DELIMITER);
  if (at === -1) return { body: recorded };
  const adapterId = recorded.slice(at + 1);
  // A suffix that is not a recordable identity is not one this ledger wrote,
  // and is never decoded into an attribution.
  return isRecordableExecutionAdapterId(adapterId) ? { body: recorded.slice(0, at), adapterId } : { body: recorded };
}

const WITHHOLDING_VOCABULARIES: Readonly<Record<WithholdingLayer, ReadonlySet<string>>> = Object.freeze({
  'grant-exercise': new Set(GRANT_EXERCISE_REASON_CODE_VALUES),
  'emergency-control': new Set(EMERGENCY_CONTROL_REASON_CODE_VALUES),
  'exercise-control': new Set(EXERCISE_CONTROL_REASON_CODE_VALUES),
});

function isWithholdingLayer(value: string): value is WithholdingLayer {
  return value === 'grant-exercise' || value === 'emergency-control' || value === 'exercise-control';
}

/** Deterministic, bounded, and closed against the layer's own vocabulary. A code from another layer is not canonical here, which is what keeps the two from bleeding together. */
function isCanonicalWithheldCodes(layer: WithholdingLayer, codes: readonly string[]): boolean {
  const vocabulary = WITHHOLDING_VOCABULARIES[layer];
  return codes.length > 0 && codes.length <= vocabulary.size && new Set(codes).size === codes.length && codes.every((code) => vocabulary.has(code));
}

function encodeWithheldOutcome(layer: WithholdingLayer, reasonCodes: readonly string[]): string | undefined {
  return isCanonicalWithheldCodes(layer, reasonCodes) ? `${WITHHELD_PREFIX}${layer}:${reasonCodes.join(',')}` : undefined;
}

function decodeWithheldOutcome(recorded: string): { readonly layer: WithholdingLayer; readonly reasonCodes: readonly string[] } | undefined {
  if (!recorded.startsWith(WITHHELD_PREFIX)) return undefined;
  const body = recorded.slice(WITHHELD_PREFIX.length);
  const separator = body.indexOf(':');
  const head = separator === -1 ? '' : body.slice(0, separator);
  // Layered form when the head names a layer; otherwise the Prompt 3 form,
  // which only the grant-exercise layer could have written. A head that looks
  // like neither decodes as nothing at all.
  const layer: WithholdingLayer = isWithholdingLayer(head) ? head : 'grant-exercise';
  const codes = (isWithholdingLayer(head) ? body.slice(separator + 1) : body).split(',');
  return isCanonicalWithheldCodes(layer, codes) ? { layer, reasonCodes: Object.freeze([...codes]) } : undefined;
}

/**
 * `claimed` carries the instant written on the claim row itself — the trusted
 * time the write-ahead fact was established, which evidence reports as its
 * occurrence rather than inventing one.
 */
export type ExecutionClaim = { readonly kind: 'claimed'; readonly claimedAt: string } | { readonly kind: 'already-claimed'; readonly prior: PriorExecution };

/**
 * Whether a committed record holds the write-ahead claim for an execution
 * identity — the one definition, used by replay and by P12 reconciliation
 * alike. There is no second "attempted" flag anywhere.
 */
export function executionClaimRecorded(record: GovernanceRecord, executionId: string): boolean {
  return record.references.some((entry) => entry.referenceId === executionAttemptReferenceId(executionId) && entry.externalId === executionId);
}

/** P12 — what the Governance resolution reference records: the definitive answer, compactly. Evidence; never read to decide. */
export interface ExecutionResolutionSummary {
  readonly certainty: 'confirmed-completed' | 'confirmed-not-completed';
  readonly failure?: string;
  readonly resolutionDigest: string;
}

export interface ExecutionLedger {
  /** Append the `authorization_artifact` reference for an issued grant. Idempotent on retry. Throws when it cannot be proven written. */
  recordAuthorization(evaluationId: string, grant: BoundedGrant): Promise<void>;
  /** What the record already says about an execution identity. A pure read of an already-loaded record. */
  prior(record: GovernanceRecord, executionId: string): PriorExecution;
  /** The write-ahead claim, BEFORE the adapter. Throws when the claim cannot be proven either way — the caller must not invoke the adapter. */
  claim(evaluationId: string, executionId: string): Promise<ExecutionClaim>;
  /**
   * Record the outcome **summary**. Returns `false` when it could not be
   * written; the outcome itself is never rewritten.
   *
   * Since P11 this row is the compact evidence summary of the canonical
   * durable observation in the execution outcome store, written only after
   * that observation committed, and its `digest` is that observation's
   * digest — so governance evidence can never claim a terminal outcome the
   * canonical store does not hold. Rows written before P11 carry no digest and
   * remain the replay source for their executions.
   */
  recordOutcome(evaluationId: string, executionId: string, outcome: ExecutionOutcome, observationDigest: string): Promise<boolean>;
  /**
   * P12 — record the compact evidence of a definitive resolution, under its own
   * deterministic reference id: never the P11 outcome summary's, which stays
   * exactly as written. Written only after the canonical resolution committed
   * (and after the P7 correction was attempted), and its `digest` is the
   * resolution digest. Returns `false` when it could not be written; nothing
   * reads it back to decide anything.
   */
  recordResolution(evaluationId: string, executionId: string, resolution: ExecutionResolutionSummary): Promise<boolean>;
}

export function createExecutionLedger(store: GovernanceStore, accessContext: GovernanceStoreAccessContext, now: () => string): ExecutionLedger {
  /**
   * Appends a reference exactly once. A refusal is read back and reported as
   * `existing` only when the row really is there — a lost race for a chain
   * position is not mistaken for success.
   */
  async function appendOnce(reference: GovernanceReferenceInput): Promise<'appended' | 'existing'> {
    try {
      await store.appendReference(accessContext, reference);
      return 'appended';
    } catch (error) {
      const record = await store.getByEvaluationId(accessContext, reference.evaluationId);
      const existing = record?.references.find((entry) => entry.referenceId === reference.referenceId);
      if (existing !== undefined && existing.referenceType === reference.referenceType && existing.externalId === reference.externalId) return 'existing';
      throw error;
    }
  }

  function prior(record: GovernanceRecord, executionId: string): PriorExecution {
    const attempted = executionClaimRecorded(record, executionId);
    const outcome = record.references.find((entry) => entry.referenceId === executionOutcomeReferenceId(executionId) && entry.externalId === executionId);
    const recorded = outcome?.externalVersion;
    if (recorded === undefined) return { attempted };
    // A withheld row never carries an adapter — nothing ran — so the split is
    // applied to the effect-bearing forms only, and a `@` inside a withheld row
    // is left exactly where it is (where it will fail to decode, as it should).
    const { body, adapterId } = recorded.startsWith(WITHHELD_PREFIX) ? { body: recorded, adapterId: undefined } : splitAdapter(recorded);
    const attribution = adapterId !== undefined ? { adapterId } : {};
    const withheld = decodeWithheldOutcome(body);
    // A stored value that cannot be decoded is reported raw and matches no
    // known outcome, so a malformed or tampered row replays as "attempted,
    // outcome unknown" — never as a withholding reason, and never as anything
    // that could permit an effect.
    return withheld === undefined
      ? { attempted, outcome: body, ...attribution }
      : { attempted, outcome: 'withheld', withheldBy: withheld.layer, withheldReasonCodes: withheld.reasonCodes };
  }

  return {
    async recordAuthorization(evaluationId, grant) {
      await appendOnce({
        referenceId: authorizationReferenceId({ evaluationId, grantId: grant.id }),
        evaluationId,
        referenceType: 'authorization_artifact',
        externalId: grant.id,
        digest: grant.digest,
        createdAt: now(),
      });
    },

    prior,

    async claim(evaluationId, executionId) {
      const claimedAt = now();
      const written = await appendOnce({
        referenceId: executionAttemptReferenceId(executionId),
        evaluationId,
        referenceType: 'execution_record',
        externalId: executionId,
        externalVersion: 'attempt',
        createdAt: claimedAt,
      });
      if (written === 'appended') return { kind: 'claimed', claimedAt };
      // Another call claimed it first. Report what it recorded, if anything.
      let latest: GovernanceRecord | null = null;
      try {
        latest = await store.getByEvaluationId(accessContext, evaluationId);
      } catch {
        latest = null;
      }
      return { kind: 'already-claimed', prior: latest === null ? { attempted: true } : prior(latest, executionId) };
    },

    async recordOutcome(evaluationId, executionId, outcome, observationDigest) {
      const recordedAs =
        outcome.status === 'executed'
          ? withAdapter('executed', outcome.adapterId)
          : outcome.status === 'withheld'
            ? outcome.withheldBy === 'emergency-control'
              ? encodeWithheldOutcome('emergency-control', outcome.emergencyControl.reasonCodes)
              : outcome.withheldBy === 'exercise-control'
                ? encodeWithheldOutcome('exercise-control', outcome.exerciseControl.reasonCodes)
                : encodeWithheldOutcome('grant-exercise', outcome.assessment.reasonCodes)
            : outcome.status === 'execution-unconfirmed'
              ? withAdapter(EXECUTION_UNCONFIRMED_OUTCOME, outcome.adapterId)
              : withAdapter(`execution-failed:${outcome.reason}`, outcome.adapterId);
      // A withheld assessment whose reasons cannot be recorded exactly is not
      // recorded at all: a replay then reports the attempt as unconfirmed rather
      // than a refusal stripped of its explanation.
      if (recordedAs === undefined) return false;
      try {
        await appendOnce({
          referenceId: executionOutcomeReferenceId(executionId),
          evaluationId,
          referenceType: 'execution_record',
          externalId: executionId,
          externalVersion: recordedAs,
          digest: observationDigest,
          createdAt: now(),
        });
        return true;
      } catch {
        return false;
      }
    },

    async recordResolution(evaluationId, executionId, resolution) {
      const recordedAs = resolution.certainty === 'confirmed-completed' ? 'resolved:confirmed-completed' : `resolved:confirmed-not-completed:${resolution.failure ?? ''}`;
      try {
        await appendOnce({
          referenceId: executionResolutionReferenceId(executionId),
          evaluationId,
          referenceType: 'execution_record',
          externalId: executionId,
          externalVersion: recordedAs,
          digest: resolution.resolutionDigest,
          createdAt: now(),
        });
        return true;
      } catch {
        return false;
      }
    },
  };
}
