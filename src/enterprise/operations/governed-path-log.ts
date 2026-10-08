import type { GovernedPathObserver } from '../governed-action/path-observer.js';
import type { EnterpriseLogger } from '../telemetry/enterprise-logger.js';
import type { OperationalState } from './contracts.js';

/**
 * PROD-03-01 — structured JSON logging of the governed path, through the
 * existing `EnterpriseLogger` (one JSON line per event, closed fields).
 *
 * Each method copies exactly the fields it names out of its input into a new
 * object, so a caller holding a richer value can never widen a log line: no
 * amount, parameter, grant, adapter, provider reference, credential, header,
 * body or environment value has a field to travel in.
 */
export const GOVERNED_PATH_LOG_EVENTS = Object.freeze({
  decision: 'governed_path.decision',
  issuanceWithheld: 'governed_path.issuance_withheld',
  executionClaimed: 'governed_path.execution_claimed',
  executionOutcome: 'governed_path.execution_outcome',
  unconfirmedExecution: 'governed_path.unconfirmed_execution_detected',
} as const);

const DECISION_STATE: Readonly<Record<string, OperationalState>> = Object.freeze({ denied: 'decision-denied', indeterminate: 'decision-indeterminate' });

const OUTCOME_STATE = Object.freeze({
  'confirmed-completed': 'executed-succeeded',
  'confirmed-not-completed': 'executed-failed',
  unconfirmed: 'claimed-outcome-unconfirmed',
  withheld: 'withheld-at-exercise',
} as const satisfies Record<string, OperationalState>);

const codes = (values: readonly string[]): readonly string[] => values.filter((value) => typeof value === 'string').map((value) => value.slice(0, 128)).slice(0, 32);

export function createGovernedPathLog(logger: EnterpriseLogger): GovernedPathObserver {
  const log: GovernedPathObserver = {
    decision(ref) {
      const state = DECISION_STATE[ref.status];
      logger.info(GOVERNED_PATH_LOG_EVENTS.decision, {
        requestId: ref.requestId,
        evaluationId: ref.evaluationId,
        decisionId: ref.decisionId,
        status: ref.status,
        reasonCodes: codes(ref.reasonCodes),
        ...(state !== undefined ? { operationalState: state, attentionRequired: false } : {}),
      });
    },
    issuanceWithheld(ref) {
      logger.info(GOVERNED_PATH_LOG_EVENTS.issuanceWithheld, {
        requestId: ref.requestId,
        evaluationId: ref.evaluationId,
        decisionId: ref.decisionId,
        withheldBy: ref.withheldBy,
        reasonCodes: codes(ref.reasonCodes),
        operationalState: 'issuance-withheld',
        attentionRequired: false,
      });
    },
    executionClaimed(ref) {
      logger.info(GOVERNED_PATH_LOG_EVENTS.executionClaimed, { requestId: ref.requestId, evaluationId: ref.evaluationId, decisionId: ref.decisionId, executionId: ref.executionId });
    },
    executionOutcome(ref) {
      // An outcome whose observation could not be made durable is, for every later read, a claim with no outcome.
      const state: OperationalState = ref.outcomeRecorded ? OUTCOME_STATE[ref.outcome] : 'claimed-no-outcome';
      const attention = state === 'claimed-outcome-unconfirmed' || state === 'claimed-no-outcome';
      logger.info(GOVERNED_PATH_LOG_EVENTS.executionOutcome, {
        requestId: ref.requestId,
        evaluationId: ref.evaluationId,
        decisionId: ref.decisionId,
        executionId: ref.executionId,
        outcome: ref.outcome,
        outcomeRecorded: ref.outcomeRecorded,
        reasonCodes: codes(ref.reasonCodes),
        ...(ref.withheldBy !== undefined ? { withheldBy: ref.withheldBy } : {}),
        operationalState: state,
        attentionRequired: attention,
      });
    },
    unconfirmedExecution(ref) {
      logger.warn(GOVERNED_PATH_LOG_EVENTS.unconfirmedExecution, {
        requestId: ref.requestId,
        evaluationId: ref.evaluationId,
        decisionId: ref.decisionId,
        executionId: ref.executionId,
        reasonCodes: codes(ref.reasonCodes),
        attentionRequired: true,
      });
    },
  };
  return Object.freeze(log);
}

/**
 * PROD-03-02 — operator resolution, logged through the same `EnterpriseLogger`
 * with closed fields only: ids, the operator reference the store records, the
 * closed certainty and failure code, and the closed result. No note, body,
 * header, credential, provider reference or amount has a field to travel in.
 */
export const OPERATOR_RESOLUTION_LOG_EVENTS = Object.freeze({
  requested: 'operator_resolution.requested',
  recorded: 'operator_resolution.recorded',
  rejected: 'operator_resolution.rejected',
} as const);

export interface OperatorResolutionLogRef {
  readonly executionId: string;
  /** `operator:<operatorId>`, the authenticated principal's — the same value the resolution records. */
  readonly operatorRef: string;
  readonly certainty: 'confirmed-completed' | 'confirmed-not-completed';
  readonly failure?: string;
}

export interface OperatorResolutionLog {
  requested(ref: OperatorResolutionLogRef): void;
  /** `capacity`: P12's closed capacity result — the resolution stands whatever it says. */
  recorded(ref: OperatorResolutionLogRef & { readonly requestId: string; readonly evaluationId: string; readonly result: 'recorded' | 'replayed'; readonly resolutionDigest: string; readonly capacity: string }): void;
  rejected(ref: OperatorResolutionLogRef & { readonly result: string; readonly reason?: string }): void;
}

const closedCode = (value: string | undefined): string | undefined => (value !== undefined && /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : undefined);

export function createOperatorResolutionLog(logger: EnterpriseLogger): OperatorResolutionLog {
  // The existing closed fields: the operator id (as CTRL-01 logs it), the execution, the certainty, and the closed codes.
  const base = (ref: OperatorResolutionLogRef) => {
    const failure = closedCode(ref.failure);
    return {
      executionId: ref.executionId,
      operatorId: ref.operatorRef.startsWith('operator:') ? ref.operatorRef.slice('operator:'.length) : ref.operatorRef,
      certainty: ref.certainty,
      ...(failure !== undefined ? { reasonCodes: [failure] } : {}),
    };
  };
  return Object.freeze({
    requested(ref) {
      logger.info(OPERATOR_RESOLUTION_LOG_EVENTS.requested, base(ref));
    },
    recorded(ref) {
      // The resolution stands either way. A capacity ledger that conflicts with it, or contradicts it, is an integrity
      // incident (the trace fails its P7 ↔ P12 check and the execution is under attention); `pending` and
      // `not-composed` leave capacity conservatively consumed and are not.
      const contradicted = ref.capacity === 'conflict' || ref.capacity === 'inconsistent';
      (contradicted ? logger.warn : logger.info).call(logger, OPERATOR_RESOLUTION_LOG_EVENTS.recorded, {
        ...base(ref),
        requestId: ref.requestId,
        evaluationId: ref.evaluationId,
        outcome: ref.result,
        resolutionDigest: ref.resolutionDigest,
        capacity: ref.capacity,
        operationalState: contradicted ? 'trace-inconsistent' : ref.certainty === 'confirmed-completed' ? 'executed-succeeded' : 'executed-failed',
        attentionRequired: contradicted,
      });
    },
    rejected(ref) {
      const reason = closedCode(ref.reason);
      const fields = base(ref);
      logger.warn(OPERATOR_RESOLUTION_LOG_EVENTS.rejected, {
        ...fields,
        outcome: closedCode(ref.result) ?? 'unknown',
        ...(reason !== undefined ? { reasonCodes: [...(fields.reasonCodes ?? []), reason] } : {}),
      });
    },
  } satisfies OperatorResolutionLog);
}
