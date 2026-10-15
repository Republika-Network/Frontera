/**
 * TRADE-04C — the closed vocabulary of a governed trade execution's outcome
 * `detail`. Every refusal names the step that refused; none is a governance
 * decision (an unauthorized order never reaches the executor at all).
 */
export const TRADE_EXECUTION_DETAILS = Object.freeze({
  // ── Before anything is read from the ledger: the grant-bound action ──
  NOT_BOUND: 'trade-execution-not-bound',
  PROPOSAL_UNAVAILABLE: 'trade-proposal-unattested',
  PAIR_NOT_CONFIGURED: 'trade-pair-not-configured',
  SIMULATED_FACTS: 'trade-simulated-facts-not-executable',
  PREVIOUSLY_RECORDED: 'trade-execution-previously-recorded',
  // ── Validated preflight: nothing signed ──
  NETWORK_UNAVAILABLE: 'trade-ledger-unavailable',
  LEDGER_UNVALIDATED: 'trade-ledger-not-validated',
  RESTART_QUARANTINE: 'trade-restart-quarantine',
  DELEGATION_UNAVAILABLE: 'trade-delegation-unavailable',
  DELEGATION_NOT_AUTHORIZED: 'trade-delegation-not-authorized',
  DELEGATE_KEY_NOT_AUTHORIZED: 'trade-delegate-key-not-authorized',
  OWNER_SEQUENCE_UNAVAILABLE: 'trade-owner-sequence-unavailable',
  OBSERVATION_INCONSISTENT: 'trade-observation-inconsistent',
  OFFER_EXPIRED: 'trade-offer-already-expired',
  SEQUENCE_IN_FLIGHT: 'trade-sequence-in-flight',
  INTERLOCK_UNAVAILABLE: 'trade-interlock-unavailable',
  // ── TRADE-04C-S1: the per-order CORE-02 signing capability: nothing signed ──
  CAPABILITY_REFUSED: 'trade-capability-refused',
  CAPABILITY_UNAVAILABLE: 'trade-capability-unavailable',
  // ── The protected signer: nothing submitted ──
  SIGNER_UNAVAILABLE: 'trade-signer-unavailable',
  SIGNER_REFUSED: 'trade-signer-refused',
  SIGNATURE_REJECTED: 'trade-signature-rejected',
  // ── The durable reservation and the one submission ──
  RESERVATION_FAILED: 'trade-reservation-failed',
  SIGNED_NOT_SUBMITTED: 'trade-signed-not-submitted',
  SUBMISSION_OUTCOME_UNKNOWN: 'trade-submission-outcome-unknown',
  SUBMISSION_RESPONSE_UNREADABLE: 'trade-submission-response-unreadable',
  ERROR_AFTER_SUBMISSION: 'trade-error-after-submission',
  FINALITY_UNKNOWN: 'trade-finality-unknown',
  RESULT_UNRECOGNIZED: 'trade-result-unrecognized',
  TRANSACTION_EXPIRED: 'trade-transaction-expired',
} as const);

export type TradeExecutionDetail = (typeof TRADE_EXECUTION_DETAILS)[keyof typeof TRADE_EXECUTION_DETAILS];
