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
