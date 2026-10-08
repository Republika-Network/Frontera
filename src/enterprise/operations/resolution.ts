import { EnterpriseHttpError, EnterpriseHttpErrors, type EnterpriseHttpErrorCode } from '../api/enterprise-http-errors.js';
import { EXECUTION_FAILURE_REASON_VALUES, type ExecutionFailureReason } from '../../features/execution-runtime/index.js';
import type { OperatorResolutionRequest, OperatorResolutionResult } from '../execution-reconciliation/contracts.js';
import { OPERATOR_ATTESTATION_AUTHORITY_ID } from '../execution-reconciliation/operator-attestation.js';
import type { OperatorAuthenticator } from '../operator-control/operator-authenticator.js';
import { OPERATOR_RESOLUTION_BODY_FIELDS, OPERATOR_RESOLUTION_OBSERVED_OUTCOMES, OPERATOR_RESOLUTIONS, type OperatorResolutionView } from './contracts.js';
import type { OperatorResolutionLog } from './governed-path-log.js';

/**
 * PROD-03-02 — Operator Resolution of Unconfirmed Executions: the one write on
 * the operations plane.
 *
 * ```
 * POST /api/admin/operations/executions/{executionId}/resolution
 *   └─ OperatorAuthenticator.authorize(header, 'operations.resolve')        401 / 403 / 503, before any body is read
 *       └─ closed body: resolution, failure (closed), observedOutcome          400
 *           └─ P12 ExecutionReconciliationService.recordOperatorResolution
 *               organization: the served one · attestedBy: the principal's operator:<id>
 *               └─ one closed result → 200 recorded | replayed, or a closed refusal (404 / 409 / 500 / 503)
 * ```
 *
 * It records what an authorized operator established outside Frontera as the
 * execution's definitive P12 resolution. It is handed exactly one port —
 * `record` — and that port holds no adapter: nothing here, or behind it, can
 * perform the governed action, perform it again, or contact a provider. The
 * Kernel decision, the issued grant and any approval are never touched.
 */

export interface OperatorResolutionCommand {
  resolveExecution(authorizationHeader: string | undefined, executionId: string, readBody: () => Promise<unknown>): Promise<OperatorResolutionView>;
}

export interface OperatorResolutionCommandDependencies {
  readonly authenticator: OperatorAuthenticator;
  /** The one organization this Host serves. */
  readonly organizationId: string;
  /** P12 operator attestation: `ExecutionReconciliationService.recordOperatorResolution`. */
  readonly record: (request: OperatorResolutionRequest) => Promise<OperatorResolutionResult>;
  /** Structured resolution events. Guarded: a logger that throws changes no result. */
  readonly log?: OperatorResolutionLog;
}

/** The governed execution identity format (`governed-action/identifiers.ts`, `deriveGovernedActionExecutionId`). Nothing else is ever looked up. */
const GOVERNED_EXECUTION_ID = /^aoc\.exec:[0-9a-f]{32}$/;

/** The internal-integrity refusal, worded as the read service words it. */
function integrityFailed(failure: string): EnterpriseHttpError {
  return new EnterpriseHttpError(500, 'AUTHORITY_STATE_INTEGRITY_FAILED', 'The recorded state could not be verified, so nothing was recorded. Treat this as a security incident; see the operator runbook.', undefined, { failure });
}

/** PROD-03-02 — a refusal of the resolution command, with its closed code; nothing was recorded. */
function resolutionRefused(status: number, code: EnterpriseHttpErrorCode, message: string, details?: Readonly<Record<string, string>>): EnterpriseHttpError {
  return new EnterpriseHttpError(status, code, `${message} Nothing was recorded, and no action was performed.`, undefined, details);
}

const isRecordObject = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
};

type ResolutionCommand = { readonly observedOutcome: 'none' | 'unconfirmed' } & (
  | { readonly certainty: 'confirmed-completed' }
  | { readonly certainty: 'confirmed-not-completed'; readonly failure: ExecutionFailureReason }
);

/** The closed body: exactly the declared fields, closed values, and a failure exactly when the answer is a non-completion. Values are never echoed. */
function resolutionCommandOf(raw: unknown): ResolutionCommand {
  if (!isRecordObject(raw)) throw EnterpriseHttpErrors.invalidRequest('The request body must be a JSON object.');
  const unexpected = Object.keys(raw).filter((key) => !(OPERATOR_RESOLUTION_BODY_FIELDS as readonly string[]).includes(key));
  if (unexpected.length > 0) throw EnterpriseHttpErrors.invalidRequest(`Unexpected field(s): ${unexpected.slice(0, 8).map((key) => key.slice(0, 64)).join(', ')}. The operator, organization and time come from the server.`);
  const { resolution, failure, observedOutcome } = raw;
  if (typeof resolution !== 'string' || !(OPERATOR_RESOLUTIONS as readonly string[]).includes(resolution)) throw EnterpriseHttpErrors.invalidRequest(`resolution must be one of: ${OPERATOR_RESOLUTIONS.join(', ')}.`);
  if (typeof observedOutcome !== 'string' || !(OPERATOR_RESOLUTION_OBSERVED_OUTCOMES as readonly string[]).includes(observedOutcome)) {
    throw EnterpriseHttpErrors.invalidRequest(`observedOutcome must be the outcome state you reviewed: one of ${OPERATOR_RESOLUTION_OBSERVED_OUTCOMES.join(', ')}.`);
  }
  const observed = observedOutcome as 'none' | 'unconfirmed';
  if (resolution === 'confirmed-completed') {
    if (failure !== undefined) throw EnterpriseHttpErrors.invalidRequest('A confirmed completion carries no failure reason.');
    return { certainty: 'confirmed-completed', observedOutcome: observed };
  }
  if (typeof failure !== 'string' || !(EXECUTION_FAILURE_REASON_VALUES as readonly string[]).includes(failure)) {
    throw EnterpriseHttpErrors.invalidRequest(`A confirmed non-completion requires failure: one of ${EXECUTION_FAILURE_REASON_VALUES.join(', ')}.`);
  }
  return { certainty: 'confirmed-not-completed', failure: failure as ExecutionFailureReason, observedOutcome: observed };
}

export function createOperatorResolutionCommand(dependencies: OperatorResolutionCommandDependencies): OperatorResolutionCommand {
  const { authenticator, organizationId, record, log: resolutionLog } = dependencies;
  if (authenticator.organizationId !== organizationId) throw new Error('createOperatorResolutionCommand: the authenticator serves another organization.');

  /** Structured resolution events: guarded, so a logger never changes a result. */
  function logResolution(fact: (log: OperatorResolutionLog) => void): void {
    if (resolutionLog === undefined) return;
    try {
      fact(resolutionLog);
    } catch {
      // Logging never changes an outcome.
    }
  }

  return Object.freeze({
    async resolveExecution(authorizationHeader: string | undefined, executionId: string, readBody: () => Promise<unknown>): Promise<OperatorResolutionView> {
      // Authorized before the body is read: a refused caller's body is never read, parsed or validated.
      const principal = authenticator.authorize(authorizationHeader, 'operations.resolve');
      if (!GOVERNED_EXECUTION_ID.test(executionId)) throw EnterpriseHttpErrors.invalidRequest('executionId must be a governed execution identity (aoc.exec:<32 lowercase hex>).');
      const command = resolutionCommandOf(await readBody());
      const failure = command.certainty === 'confirmed-not-completed' ? command.failure : undefined;
      // The operator is the authenticated principal; the body has no field that could name another.
      const ref = { executionId, operatorRef: principal.actorRef, certainty: command.certainty, ...(failure !== undefined ? { failure } : {}) };
      logResolution((log) => log.requested(ref));
      let result: OperatorResolutionResult;
      try {
        result = await record({ organizationId, executionId, attestedBy: principal.actorRef, ...command } as OperatorResolutionRequest);
      } catch {
        logResolution((log) => log.rejected({ ...ref, result: 'unavailable' }));
        // Whether it was recorded is not known here — so it is not claimed either way. A resubmission is safe: one resolution per execution, and the identical one replays.
        throw new EnterpriseHttpError(503, 'EXECUTION_RESOLUTION_UNAVAILABLE', 'The resolution could not be confirmed. No action was performed. Submit the same resolution again: it is recorded at most once, and an identical resolution already recorded is returned unchanged.');
      }
      switch (result.outcome) {
        case 'recorded':
        case 'replayed': {
          const { resolution } = result;
          logResolution((log) => log.recorded({ ...ref, requestId: result.requestId, evaluationId: result.evaluationId, result: result.outcome, resolutionDigest: resolution.resolutionDigest }));
          return {
            outcome: result.outcome,
            requestId: result.requestId,
            evaluationId: result.evaluationId,
            executionId,
            resolution: {
              resolvedBy: 'operator-attestation',
              attestedBy: resolution.attestedBy ?? principal.actorRef,
              certainty: resolution.certainty,
              failure: resolution.failure ?? null,
              resolvedAt: resolution.resolvedAt,
              recordedAt: resolution.recordedAt,
              resolutionDigest: resolution.resolutionDigest,
            },
            capacity: result.capacity,
            effect: 'resolution-recorded-no-action-performed',
          };
        }
        case 'not-found':
          logResolution((log) => log.rejected({ ...ref, result: 'not-found' }));
          // Another organization's execution is indistinguishable from none.
          throw resolutionRefused(404, 'EXECUTION_NOT_FOUND', 'No governed execution with that id is recorded for this organization.');
        case 'not-eligible':
          logResolution((log) => log.rejected({ ...ref, result: 'not-eligible', reason: result.reason }));
          if (result.reason === 'initial-observation-definitive') {
            throw resolutionRefused(409, 'EXECUTION_OUTCOME_ALREADY_DEFINITIVE', 'The provider outcome of this execution is already recorded as definitive; it stands, and an operator resolution can never replace it.');
          }
          throw resolutionRefused(
            409,
            'EXECUTION_NOT_RESOLVABLE',
            result.reason === 'not-claimed' ? 'This execution was never claimed, so no provider can have been reached; there is nothing to resolve.' : 'This execution was withheld before any provider; its outcome is already definitive.',
            { reason: result.reason },
          );
        case 'in-flight':
          logResolution((log) => log.rejected({ ...ref, result: 'in-flight' }));
          throw resolutionRefused(409, 'EXECUTION_IN_FLIGHT', 'The governed path still holds this execution: its provider call may still answer. Wait for its outcome before resolving it.');
        case 'basis-changed':
          logResolution((log) => log.rejected({ ...ref, result: 'basis-changed', reason: result.current }));
          throw resolutionRefused(409, 'EXECUTION_RESOLUTION_BASIS_CHANGED', `The execution's recorded outcome is now '${result.current}', not what you reviewed. Review the current state before resolving it.`, { currentOutcome: result.current });
        case 'authority-mismatch':
          logResolution((log) => log.rejected({ ...ref, result: 'authority-mismatch' }));
          throw resolutionRefused(409, 'EXECUTION_RESOLUTION_AUTHORITY_MISMATCH', 'This execution is bound to another resolution authority, which alone may resolve it.');
        case 'already-resolved':
          logResolution((log) => log.rejected({ ...ref, result: 'already-resolved' }));
          throw resolutionRefused(409, 'EXECUTION_ALREADY_RESOLVED', 'A different resolution of this execution is already recorded; it stands unchanged.', {
            resolvedBy: result.resolution.authorityId === OPERATOR_ATTESTATION_AUTHORITY_ID ? 'operator-attestation' : 'resolution-authority',
            certainty: result.resolution.certainty,
          });
        case 'basis-unavailable':
          logResolution((log) => log.rejected({ ...ref, result: 'basis-unavailable', reason: result.reason }));
          if (result.reason === 'outcome-unreadable' || result.reason === 'resolution-unreadable' || result.reason === 'claim-unverifiable') {
            throw new EnterpriseHttpError(503, 'EXECUTION_RESOLUTION_UNAVAILABLE', 'The execution records could not be read right now. Nothing was recorded, and no action was performed.');
          }
          throw integrityFailed(result.reason.toUpperCase().replace(/-/g, '_'));
        case 'resolution-unrecorded':
          logResolution((log) => log.rejected({ ...ref, result: 'resolution-unrecorded' }));
          throw new EnterpriseHttpError(503, 'EXECUTION_RESOLUTION_UNAVAILABLE', 'The resolution could not be made durable. Nothing was recorded, and no action was performed; it is safe to submit the same resolution again.');
        default: {
          const unreachable: never = result;
          return unreachable;
        }
      }
    },
  });
}
