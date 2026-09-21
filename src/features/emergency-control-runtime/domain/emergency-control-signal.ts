import type { EmergencyControlAssessment, EmergencyControlScopeMatch } from './emergency-control-port.js';
import { EMERGENCY_CONTROL_REASON_CODES, type EmergencyControlReasonCode } from './emergency-control-reason-codes.js';

/**
 * The one typed signal that means "an emergency control stopped this, and the
 * provider was never contacted".
 *
 * ## Why a signal at all
 *
 * The adapter-scoped control can only be evaluated **after** trusted
 * server-side routing has chosen a child adapter, and routing happens inside
 * the composite registry — below `ExecutionAdapter.execute`'s return type.
 * `ExecutionAdapterResult` has exactly two cases, `completed` and `failed`, and
 * neither is true here: nothing completed, and no provider failed, because no
 * provider was asked. Reporting it as `PROVIDER_REJECTED` would record a
 * refusal the provider never made.
 *
 * Widening `ExecutionAdapterResult` with a third case was the alternative, and
 * it is worse: every adapter implementation in existence, including ones a host
 * writes, would gain the ability to claim an emergency stop.
 *
 * ## The type is not the authentication
 *
 * An earlier revision of this comment claimed that only trusted code holding an
 * `EmergencyControlReaderPort` could construct this class. That was never true.
 * The constructor takes an assessment object — an ordinary value anyone can
 * write down — so any module that can reach this class can throw a genuine
 * instance, and a directly composed adapter could turn its own provider failure
 * into `withheldBy: 'emergency-control'` simply by throwing one. Recognising it
 * by type alone was therefore recognising a claim, not evidence.
 *
 * What authenticates it is **who threw it**: `GrantExecutionService` honours
 * this signal only from an adapter that `isExecutionAdapterRegistry` confirms
 * was produced by `createExecutionAdapterRegistry`, because only a registry
 * actually consults an `EmergencyControlReaderPort` before reaching a child.
 * From anything else — including a real instance — the throw stays
 * `ADAPTER_ERROR`, exactly as an ordinary adapter failure always has.
 *
 * The class is exported from this feature so the registry can construct it and
 * the execution service can recognise it. It is on **no** published entrypoint:
 * neither `src/index.ts` nor `src/enterprise/index.ts` re-exports it, so it is
 * not part of any customer or host surface, and nothing here adds one.
 *
 * ## What it may carry
 *
 * Reason codes from the closed emergency-control vocabulary, and the scopes
 * that matched. No credential, no database state, no message from a driver, no
 * operator identity: everything here is already known to the layer that asked.
 */
export class EmergencyControlWithheldError extends Error {
  readonly reasonCodes: readonly EmergencyControlReasonCode[];
  readonly matchedScopes: readonly EmergencyControlScopeMatch[];

  constructor(assessment: EmergencyControlAssessment) {
    super('Execution was withheld by an active or unreadable emergency control.');
    this.name = 'EmergencyControlWithheldError';
    this.reasonCodes = Object.freeze(
      assessment.reasonCodes.length > 0 ? [...assessment.reasonCodes] : [EMERGENCY_CONTROL_REASON_CODES.EMERGENCY_CONTROL_UNAVAILABLE],
    );
    this.matchedScopes = Object.freeze(assessment.state === 'blocked' ? [...assessment.matchedScopes] : []);
  }
}

export function isEmergencyControlWithheldError(error: unknown): error is EmergencyControlWithheldError {
  return error instanceof EmergencyControlWithheldError;
}
