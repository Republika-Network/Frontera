/**
 * G-02A — the generic signed execution capability: its closed contract and
 * canonical codec, and the standalone verifier an independent executor runs.
 *
 * See `docs/architecture/ADR-GENERIC-SIGNED-EXECUTION-CAPABILITIES.md`. The
 * reference durable consumption ledger is deliberately not re-exported here: it
 * holds a database, and this entry point is what an executor needs to verify
 * without one (`./reference/consumption-ledger.js`).
 */
export {
  EXECUTION_CAPABILITY_ACTION_BINDING_DOMAIN,
  EXECUTION_CAPABILITY_CONSUMPTION_MODES,
  EXECUTION_CAPABILITY_FIELDS,
  EXECUTION_CAPABILITY_FORMAT,
  EXECUTION_CAPABILITY_GRANT_REFERENCE_DOMAIN,
  EXECUTION_CAPABILITY_LIMITS,
  EXECUTION_CAPABILITY_SIGNING_DOMAIN,
  EXECUTION_CAPABILITY_STATUS_REQUIREMENTS,
  ExecutionCapabilityBindingError,
  executionCapabilityActionBindingDigest,
  executionCapabilityGrantReference,
  executionCapabilitySigningBytes,
  hasUnpairedSurrogateCodeUnit,
  isExecutionCapabilityIdentifier,
  isWellFormedExecutionCapability,
  parseExecutionCapability,
  serializeExecutionCapability,
} from './capability.js';
export type {
  ExecutionCapability,
  ExecutionCapabilityActionBinding,
  ExecutionCapabilityConsumptionMode,
  ExecutionCapabilityParseFailure,
  ExecutionCapabilityStatusRequirement,
} from './capability.js';

export {
  EXECUTION_CAPABILITY_CHECKS,
  EXECUTION_CAPABILITY_VERIFICATION_FAILURES,
  ExecutionCapabilityVerifierConfigurationError,
  createExecutionCapabilityVerifier,
  readVerifiedExecutionCapability,
} from './verifier.js';
export type {
  ExecutionCapabilityCheck,
  ExecutionCapabilityCheckResult,
  ExecutionCapabilityChecks,
  ExecutionCapabilityConsumptionEligibility,
  ExecutionCapabilityExecutorContext,
  ExecutionCapabilityFreshness,
  ExecutionCapabilityTrustedIssuer,
  ExecutionCapabilityVerification,
  ExecutionCapabilityVerificationFailure,
  ExecutionCapabilityVerificationRequest,
  ExecutionCapabilityVerifier,
  ExecutionCapabilityVerifierOptions,
} from './verifier.js';
