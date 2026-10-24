import { EXECUTOR_RECEIPT_TRANSPORT_HEADER, encodeExecutorReceiptTransport } from '../executor-receipt/index.js';
import type { ExecutionCapabilityClaimRefusal, ExecutionCapabilityConsumptionLedger, ExecutionCapabilityConsumptionState, ExecutionCapabilityReportedOutcome } from '../execution-capability/reference/consumption-ledger.js';
import type { ObservedHttpRequest } from './admission.js';
import type { ReferenceExecutorConfiguration, ReferenceExecutorFaultPoint } from './configuration.js';
import type { SyntheticDeploymentEffect } from './synthetic-effect.js';
import type { ReferenceExecutorAssessment, ReferenceExecutorAssessmentCode, ReferenceExecutorStage, ReferenceExecutorVerificationPipeline } from './verification-pipeline.js';

/**
 * G-02C1B — the reference executor's **synthetic execution** flow: an eligible
 * capability is durably consumed with the G-02A ledger **before** the one
 * synthetic effect is attempted, and what was observed is recorded forward
 * only.
 *
 * ```
 * verify      the G-02C1A pipeline, unchanged: admission, credential, presentation,
 *             policy, binding rebuilt from the received bytes, G-02A verification, eligibility
 * synthetic   the verified action must be one of the configured synthetic.* actions
 * claim       ledger.claim — IMMEDIATE, synchronous = FULL; committed or refused
 * expiry      re-checked on this executor's clock; expired → recorded failed, no effect
 * effect      exactly one attempt (synthetic-effect.ts), which itself requires the durable claim
 * outcome     ledger.recordOutcome, forward only
 * answer      one closed outcome, mapped to one status
 * ```
 *
 * ## Nothing is awaited from claim to outcome
 *
 * Claim, expiry re-check, effect and outcome record run in one synchronous
 * section: no other request, timer or I/O callback of this process can run
 * between the expiry check and the effect, or between the claim and the
 * outcome. Another process sharing the ledger serializes on its write lock.
 *
 * ## What is never done
 *
 * The effect never runs before the claim commits, never runs twice, and is
 * never retried — not after a crash, a timeout, an unknown outcome or a lost
 * response. A duplicate delivery is answered from the ledger and performs
 * nothing. A claim is never released, and an uncertain outcome is never
 * turned into a success.
 *
 * ## The outcome model
 *
 * | Outcome | Claim | Effect | Ledger | Status (Host classifier) |
 * |---|---|---|---|---|
 * | `refused` (before the claim) | none | none | unchanged | 400 / 401 / 403 / 413 / 417 / 431 → rejected |
 * | `assessed-ineligible` (status-required) | none | none | unchanged | 403 → rejected |
 * | `already-consumed` | earlier | **possibly, earlier** | unchanged | 202 → unconfirmed — never a success |
 * | `claim-unavailable` | none | none | unchanged | 503 → unconfirmed |
 * | `consumed-not-attempted` | this one | none | `failed` | 422 → rejected |
 * | `failed-observed` | this one | refused by the target, nothing written | `failed` | 422 → rejected |
 * | `attempted-outcome-unknown` | this one | possibly partial | `outcome-unknown` (or still `claimed`) | 502 → unconfirmed |
 * | `completed-observed` | this one | written and flushed | `completed` | 201 → completed |
 *
 * `completed-observed` is the executor's own observation of a local synthetic
 * record. It is not external settlement and not a signed receipt (G-02C1C).
 */

export const REFERENCE_EXECUTOR_EXECUTION_OUTCOMES = Object.freeze([
  'refused',
  'assessed-ineligible',
  'already-consumed',
  'claim-unavailable',
  'consumed-not-attempted',
  'failed-observed',
  'attempted-outcome-unknown',
  'completed-observed',
] as const);
export type ReferenceExecutorExecutionOutcome = (typeof REFERENCE_EXECUTOR_EXECUTION_OUTCOMES)[number];

export type ReferenceExecutorExecutionStage = ReferenceExecutorStage | 'claim' | 'expiry' | 'effect' | 'outcome';

export type ReferenceExecutorExecutionCode =
  | ReferenceExecutorAssessmentCode
  | 'ACTION_NOT_SYNTHETIC'
  | ExecutionCapabilityClaimRefusal
  | 'LEDGER_UNAVAILABLE'
  | 'CAPABILITY_EXPIRED_AFTER_CLAIM'
  | 'EFFECT_NOT_ATTEMPTED'
  | 'SYNTHETIC_EFFECT_REFUSED'
  | 'SYNTHETIC_EFFECT_UNCONFIRMED'
  | 'SYNTHETIC_EFFECT_APPLIED'
  | 'OUTCOME_NOT_RECORDED';

/** One closed, non-secret record per request in synthetic-execution mode. */
export interface ReferenceExecutorExecution {
  readonly mode: 'synthetic-execution';
  readonly outcome: ReferenceExecutorExecutionOutcome;
  readonly stage: ReferenceExecutorExecutionStage;
  readonly code: ReferenceExecutorExecutionCode;
  /** The rebuilt digest, only once a capability verified against it; otherwise `null`. */
  readonly bindingDigest: string | null;
  /** The ledger state this answer rests on: the claim's after this request, or the earlier one for `already-consumed`; `null` when nothing was claimed. */
  readonly ledgerState: ExecutionCapabilityConsumptionState | null;
}

export interface ReferenceExecutorExecutionFlow {
  execute(observed: ObservedHttpRequest): ReferenceExecutorExecution;
  /** The status for a record of this flow. Never 2xx except `completed-observed` (201) and `already-consumed` (202). */
  statusOf(execution: ReferenceExecutorExecution, refusedStatus: (stage: ReferenceExecutorStage, code: ReferenceExecutorAssessmentCode) => number): number;
  /**
   * G-02C1D: the headers this answer adds — at most the one `frontera-execution-receipt` header, carrying the transport
   * encoding of the receipt the receipt ledger persisted and the signer signed while this answer was formed; none when
   * there is no such receipt. Never reconstructed from the status, never inside the diagnostic record, and never a
   * reason to perform anything.
   */
  answerHeadersOf?(execution: ReferenceExecutorExecution): Readonly<Record<string, string>>;
}

export interface ReferenceExecutorExecutionFlowOptions {
  readonly configuration: ReferenceExecutorConfiguration;
  readonly pipeline: ReferenceExecutorVerificationPipeline;
  readonly ledger: ExecutionCapabilityConsumptionLedger;
  readonly effect: SyntheticDeploymentEffect;
  readonly clock: () => number;
  /** Called at each fault point in order (CI crash injection); never alters the flow when it returns. */
  readonly fault?: (point: ReferenceExecutorFaultPoint) => void;
  /**
   * G-02C1C: the receipt issuer, when receipts are configured. Asked only after an outcome is durably recorded (with what
   * this path observed) and on a duplicate delivery (from durable state alone). Its answer never changes this flow's.
   */
  readonly receipts?: { issue(capabilityId: string, observed?: 'completed-observed' | 'failed-observed' | 'consumed-not-attempted' | 'attempted-outcome-unknown'): unknown; issueResolved(capabilityId: string): unknown };
}

function record(outcome: ReferenceExecutorExecutionOutcome, stage: ReferenceExecutorExecutionStage, code: ReferenceExecutorExecutionCode, bindingDigest: string | null, ledgerState: ExecutionCapabilityConsumptionState | null): ReferenceExecutorExecution {
  return Object.freeze({ mode: 'synthetic-execution' as const, outcome, stage, code, bindingDigest, ledgerState });
}

/** A refusal or ineligible assessment of the pipeline, restated in this mode. Nothing was claimed. */
function fromAssessment(assessment: ReferenceExecutorAssessment): ReferenceExecutorExecution {
  return record(assessment.outcome === 'assessed-ineligible' ? 'assessed-ineligible' : 'refused', assessment.stage, assessment.code, null, null);
}

export function createReferenceExecutorExecutionFlow(options: ReferenceExecutorExecutionFlowOptions): ReferenceExecutorExecutionFlow {
  const { configuration, pipeline, ledger, effect, clock } = options;
  const synthetic = configuration.syntheticExecution;
  if (configuration.mode !== 'synthetic-execution' || synthetic === null) throw new Error('The execution flow exists only in synthetic-execution mode.');
  if (ledger.audience !== configuration.audience) throw new Error('The consumption ledger is pinned to another audience.');
  const syntheticActions = synthetic.syntheticActions;
  const fault = options.fault ?? (() => undefined);
  const receipts = options.receipts;
  /**
   * A receipt is a statement about what already happened: asking for one never alters the answer, and a failure here is
   * not an outcome. G-02C1D: what comes back is the issued artifact's transport encoding, to deliver with the answer.
   */
  const receiptFor = (capabilityId: string, observed?: ReferenceExecutorExecutionOutcome): string | undefined => {
    if (receipts === undefined) return undefined;
    try {
      // After this path's own outcome: what it observed. On a duplicate: durable state alone, and not while still claimed — the claim may be live elsewhere.
      const issuance = observed === 'completed-observed' || observed === 'failed-observed' || observed === 'consumed-not-attempted' || observed === 'attempted-outcome-unknown' ? receipts.issue(capabilityId, observed) : receipts.issueResolved(capabilityId);
      return deliverableOf(issuance);
    } catch {
      // Recovered later from durable state; the answer stands, without a receipt.
      return undefined;
    }
  };
  // G-02C1D: the receipt each answer carries, keyed by that answer; the record itself stays the closed diagnostic one.
  const delivered = new WeakMap<ReferenceExecutorExecution, string>();
  const carrying = (execution: ReferenceExecutorExecution, encoded: string | undefined): ReferenceExecutorExecution => {
    if (encoded !== undefined) delivered.set(execution, encoded);
    return execution;
  };

  /** The earlier state behind a consumed capability or execution; `null` if the ledger cannot say. */
  function priorState(capabilityId: string, issuer: string, executionId: string): ExecutionCapabilityConsumptionState | null {
    try {
      const byCapability = ledger.read(capabilityId);
      if (byCapability.state !== 'absent') return byCapability.state;
      const byExecution = ledger.readExecution(issuer, executionId);
      return byExecution.state === 'absent' ? null : byExecution.state;
    } catch {
      return null;
    }
  }

  function execute(observed: ObservedHttpRequest): ReferenceExecutorExecution {
    // ── verify (G-02C1A, unchanged) ──
    const verdict = pipeline.verifyForExecution(observed);
    const eligible = verdict.eligible;
    if (eligible === undefined) return fromAssessment(verdict.assessment);
    const { verification, capability, bindingDigest } = eligible;
    const capabilityId = capability.capabilityId;

    // ── only a synthetic action reaches the effect ──
    const isSynthetic = syntheticActions.includes(capability.action);
    if (!isSynthetic) return record('refused', 'policy', 'ACTION_NOT_SYNTHETIC', null, null);

    // ── the durable claim, before anything else happens ──
    fault('before-claim');
    let claim: ReturnType<ExecutionCapabilityConsumptionLedger['claim']>;
    try {
      claim = ledger.claim(verification);
    } catch {
      return record('claim-unavailable', 'claim', 'LEDGER_UNAVAILABLE', bindingDigest, null);
    }
    if (claim.outcome !== 'claimed') {
      const consumed = claim.reason === 'CAPABILITY_CONSUMED' || claim.reason === 'EXECUTION_CONSUMED';
      if (consumed) {
        // Nothing is performed again; a receipt missing for the earlier consumption is issued from durable state.
        const earlier = claim.reason === 'CAPABILITY_CONSUMED' ? receiptFor(capabilityId) : undefined;
        return carrying(record('already-consumed', 'claim', claim.reason, bindingDigest, priorState(capabilityId, capability.issuer, capability.executionId)), earlier);
      }
      return record('refused', 'claim', claim.reason, null, null);
    }
    fault('after-claim');

    /** Records `state` forward only. If the ledger does not take it, the answer is the conservative unknown, whatever was observed. */
    const settle = (state: ExecutionCapabilityReportedOutcome, outcome: ReferenceExecutorExecutionOutcome, stage: ReferenceExecutorExecutionStage, code: ReferenceExecutorExecutionCode): ReferenceExecutorExecution => {
      let recorded: string;
      try {
        recorded = ledger.recordOutcome(capabilityId, state);
      } catch {
        recorded = 'unavailable';
      }
      if (recorded !== 'recorded') return record('attempted-outcome-unknown', 'outcome', 'OUTCOME_NOT_RECORDED', bindingDigest, priorState(capabilityId, capability.issuer, capability.executionId));
      fault('after-outcome');
      const encoded = receiptFor(capabilityId, outcome);
      return carrying(record(outcome, stage, code, bindingDigest, state), encoded);
    };

    // ── expiry, on this executor's clock, after the claim: nothing is awaited from here to the effect ──
    const now = clock();
    const stillValid = Number.isSafeInteger(now) && now < Date.parse(capability.expiresAt);
    if (!stillValid) return settle('failed', 'consumed-not-attempted', 'expiry', 'CAPABILITY_EXPIRED_AFTER_CLAIM');
    fault('after-expiry-check');

    // ── the one attempt ──
    const observation = effect.apply(
      {
        executorId: configuration.executorId,
        audience: configuration.audience,
        issuer: capability.issuer,
        capabilityId,
        executionId: capability.executionId,
        operation: capability.action,
        target: capability.resource,
        bindingDigest,
        claimedAt: claim.claimedAt,
        attemptedAt: new Date(now).toISOString(),
      },
      () => fault('during-effect'),
    );
    fault('after-effect');

    if (observation === 'completed') return settle('completed', 'completed-observed', 'effect', 'SYNTHETIC_EFFECT_APPLIED');
    if (observation === 'failed') return settle('failed', 'failed-observed', 'effect', 'SYNTHETIC_EFFECT_REFUSED');
    if (observation === 'not-attempted') return settle('failed', 'consumed-not-attempted', 'effect', 'EFFECT_NOT_ATTEMPTED');
    return settle('outcome-unknown', 'attempted-outcome-unknown', 'effect', 'SYNTHETIC_EFFECT_UNCONFIRMED');
  }

  function statusOf(execution: ReferenceExecutorExecution, refusedStatus: (stage: ReferenceExecutorStage, code: ReferenceExecutorAssessmentCode) => number): number {
    switch (execution.outcome) {
      case 'completed-observed':
        return 201;
      case 'already-consumed':
        return 202;
      case 'consumed-not-attempted':
      case 'failed-observed':
        return 422;
      case 'attempted-outcome-unknown':
        return 502;
      case 'claim-unavailable':
        return 503;
      case 'assessed-ineligible':
        return 403;
      default: {
        const stage = execution.stage;
        const pipelineStage = stage === 'claim' || stage === 'expiry' || stage === 'effect' || stage === 'outcome' ? 'verification' : stage;
        return refusedStatus(pipelineStage, execution.code as ReferenceExecutorAssessmentCode);
      }
    }
  }

  const NONE: Readonly<Record<string, string>> = Object.freeze({});
  const answerHeadersOf = (execution: ReferenceExecutorExecution): Readonly<Record<string, string>> => {
    const encoded = delivered.get(execution);
    return encoded === undefined ? NONE : Object.freeze({ [EXECUTOR_RECEIPT_TRANSPORT_HEADER]: encoded });
  };
  return Object.freeze({ execute, statusOf, answerHeadersOf });
}

/** The transport encoding of an issued receipt, or `undefined` for a refusal or anything else. */
function deliverableOf(issuance: unknown): string | undefined {
  if (issuance === null || typeof issuance !== 'object') return undefined;
  const fields = issuance as { readonly status?: unknown; readonly receipt?: unknown };
  if (fields.status !== 'issued' || fields.receipt === null || typeof fields.receipt !== 'object') return undefined;
  const artifact = fields.receipt as { readonly receipt?: unknown; readonly signature?: unknown };
  if (typeof artifact.receipt !== 'string' || artifact.signature === null || typeof artifact.signature !== 'object') return undefined;
  try {
    return encodeExecutorReceiptTransport({ receipt: artifact.receipt, signature: artifact.signature as Readonly<Record<string, string>> });
  } catch {
    return undefined;
  }
}
