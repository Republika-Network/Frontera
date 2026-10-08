import type { BoundedGrant } from '../../features/grant-runtime/index.js';
import { isRecordableExecutionAdapterId, type ExecutionOutcome } from '../../features/execution-runtime/index.js';
import type { GovernanceRecord, GovernanceReferenceInput, GovernanceStoreAccessContext } from '../governance-store/contracts.js';
import type { GovernanceStore } from '../governance-store/governance-store.js';
import { isGovernanceStoreError } from '../governance-store/errors.js';
import {
  authorizationReferenceId,
  executionAttemptReferenceId,
  executionOutcomeReferenceId,
  executionResolutionReferenceId,
  issuanceWithheldReferenceId,
  reconsiderationLinkReferenceId,
  reconsiderationRealizationReferenceId,
} from './identifiers.js';
import { RECONSIDERATION_REALIZED_URI, reconsiderationLinkUri, type VerifiedReconsiderationTarget } from './reconsideration-lineage.js';
import {
  ADAPTER_DELIMITER,
  EXECUTION_UNCONFIRMED_OUTCOME,
  WITHHELD_PREFIX,
  decodeWithheldOutcome,
  encodeResolutionSummary,
  isCanonicalWithheldCodes,
  splitAdapter,
  type WithholdingLayer,
} from './execution-summary.js';
import { isWellFormedIssuanceWithheldEvidence, issuanceWithheldDigest, issuanceWithheldUri, issuanceWithheldVersion, type IssuanceWithheldEvidence } from './issuance-record.js';

export { EXECUTION_UNCONFIRMED_OUTCOME, type WithholdingLayer } from './execution-summary.js';

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

function withAdapter(recorded: string, adapterId: string | undefined): string {
  return adapterId !== undefined && isRecordableExecutionAdapterId(adapterId) ? `${recorded}${ADAPTER_DELIMITER}${adapterId}` : recorded;
}

function encodeWithheldOutcome(layer: WithholdingLayer, reasonCodes: readonly string[]): string | undefined {
  return isCanonicalWithheldCodes(layer, reasonCodes) ? `${WITHHELD_PREFIX}${layer}:${reasonCodes.join(',')}` : undefined;
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
  /**
   * LAND-01 — the link a reconsideration's own evaluation carries to its
   * original: original request id, original decision id, business-intent
   * digest, reason. At most once per reconsidering request; a retry finds the
   * same row; a row there naming something else is `conflict`. The original's
   * record is never written to.
   */
  recordReconsiderationLink(evaluationId: string, requestId: string, target: VerifiedReconsiderationTarget): Promise<'appended' | 'existing' | 'conflict'>;
  /**
   * LAND-01 — claim the one realization of an original business intent.
   * The marker id is derived from the original request id, so the Store's
   * unique reference id refuses it to every other evaluation
   * (`already-realized`); this evaluation already holding it is `claimed`.
   */
  claimReconsiderationRealization(evaluationId: string, target: VerifiedReconsiderationTarget): Promise<'claimed' | 'already-realized'>;
  /**
   * LAND-02 — persist that authority issuance was evaluated and withheld
   * for this committed decision, exactly as the issuance core returned it.
   * Idempotent per (evaluation, outcome) — the ceiling is part of the outcome. `false` when it could not be proven
   * written — the withheld answer stands either way; nothing here can grant.
   */
  recordIssuanceWithheld(evaluationId: string, evidence: IssuanceWithheldEvidence): Promise<boolean>;
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
      const recordedAs = encodeResolutionSummary(resolution.certainty, resolution.failure);
      // A resolution with no canonical form is not recorded at all, rather than recorded as a row no reader decodes.
      if (recordedAs === undefined) return false;
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

    async recordReconsiderationLink(evaluationId, requestId, target) {
      const reference: GovernanceReferenceInput = {
        referenceId: reconsiderationLinkReferenceId(requestId),
        evaluationId,
        referenceType: 'reconsideration_link',
        externalId: target.originalRequestId,
        externalVersion: target.originalDecisionId,
        digest: target.intentDigest,
        uri: reconsiderationLinkUri(target.reason),
        createdAt: now(),
      };
      try {
        await store.appendReference(accessContext, reference);
        return 'appended';
      } catch (error) {
        const record = await store.getByEvaluationId(accessContext, evaluationId);
        const existing = record?.references.find((entry) => entry.referenceId === reference.referenceId);
        if (existing === undefined) throw error;
        const same = existing.referenceType === reference.referenceType && existing.externalId === reference.externalId && existing.externalVersion === reference.externalVersion && existing.digest === reference.digest && existing.uri === reference.uri;
        return same ? 'existing' : 'conflict';
      }
    },

    async claimReconsiderationRealization(evaluationId, target) {
      const reference: GovernanceReferenceInput = {
        referenceId: reconsiderationRealizationReferenceId(target.originalRequestId),
        evaluationId,
        referenceType: 'reconsideration_link',
        externalId: target.originalRequestId,
        externalVersion: 'realized',
        digest: target.intentDigest,
        uri: RECONSIDERATION_REALIZED_URI,
        createdAt: now(),
      };
      try {
        await store.appendReference(accessContext, reference);
        return 'claimed';
      } catch (error) {
        const own = await store.getByEvaluationId(accessContext, evaluationId);
        if (own?.references.some((entry) => entry.referenceId === reference.referenceId)) return 'claimed';
        // The id exists on another evaluation: the Store refused a second realization.
        if (isGovernanceStoreError(error) && error.code === 'GOVERNANCE_STORE_VALIDATION_ERROR') return 'already-realized';
        throw error;
      }
    },

    async recordIssuanceWithheld(evaluationId, evidence) {
      if (!isWellFormedIssuanceWithheldEvidence(evidence)) return false;
      const version = issuanceWithheldVersion(evidence);
      try {
        await appendOnce({
          referenceId: issuanceWithheldReferenceId({ evaluationId, version, ...(evidence.ceiling !== undefined ? { ceiling: evidence.ceiling } : {}) }),
          evaluationId,
          referenceType: 'issuance_record',
          externalId: evidence.requestId,
          externalVersion: version,
          digest: issuanceWithheldDigest(evidence),
          uri: issuanceWithheldUri(evidence),
          createdAt: now(),
        });
        return true;
      } catch {
        return false;
      }
    },
  };
}
