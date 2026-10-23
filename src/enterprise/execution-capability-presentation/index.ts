/**
 * G-02C1A — the pure codec for `frontera.execution-capability-presentation.v1`.
 * See `docs/architecture/ADR-INDEPENDENT-EXECUTOR-VERIFICATION.md`. Not
 * re-exported from the Enterprise barrel.
 */
export {
  EXECUTION_CAPABILITY_PRESENTATION_FAILURES,
  EXECUTION_CAPABILITY_PRESENTATION_FORMAT,
  EXECUTION_CAPABILITY_PRESENTATION_HEADER,
  EXECUTION_CAPABILITY_PRESENTATION_LIMITS,
  decodeExecutionCapabilityPresentation,
  encodeExecutionCapabilityPresentation,
} from './presentation.js';
export type {
  ExecutionCapabilityPresentation,
  ExecutionCapabilityPresentationDecoding,
  ExecutionCapabilityPresentationFailure,
  ExecutionCapabilityPresentationSignature,
} from './presentation.js';
