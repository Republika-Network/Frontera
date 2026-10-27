/**
 * AUTH-04D2S — independent verification of a synthetic governed execution:
 * CORE-05 approval → execution identity → G-02B capability → G-02C1C receipt.
 *
 * Pure and keyless: public keys in, a classified, digested statement out. No
 * route, no store, no signer, no Host composition uses it; the pilot's
 * operator tool and CI call it.
 */
export {
  SYNTHETIC_EXECUTION_REASONS,
  SYNTHETIC_EXECUTION_STATUSES,
  SYNTHETIC_EXECUTION_VERIFICATION_DIGEST_DOMAIN,
  SYNTHETIC_EXECUTION_VERIFICATION_FORMAT,
  SyntheticExecutionVerifierConfigurationError,
  createSyntheticExecutionVerifier,
} from './verification.js';
export type {
  SyntheticExecutionApprovalInput,
  SyntheticExecutionEvidenceInput,
  SyntheticExecutionIssuanceInput,
  SyntheticExecutionReason,
  SyntheticExecutionStatus,
  SyntheticExecutionTraceInput,
  SyntheticExecutionVerification,
  SyntheticExecutionVerificationInput,
  SyntheticExecutionVerifier,
  SyntheticExecutionVerifierOptions,
} from './verification.js';
