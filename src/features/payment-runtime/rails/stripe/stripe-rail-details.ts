/**
 * The bounded detail tokens the Stripe rail reports (PAY-09). Each is a PAY-01
 * `detail` — a token, never a Stripe message, decline text, error body or
 * object — so no processor vocabulary beyond these reaches P11.
 */
export const STRIPE_RAIL_DETAILS = {
  // ── refused before any money-moving request (not-completed) ──
  ASSET_UNSUPPORTED: 'stripe-asset-unsupported',
  AMOUNT_UNREPRESENTABLE: 'stripe-amount-unrepresentable',
  AMOUNT_BELOW_MINIMUM: 'stripe-amount-below-minimum',
  AMOUNT_ABOVE_MAXIMUM: 'stripe-amount-above-maximum',
  SOURCE_UNMAPPED: 'stripe-source-unmapped',
  DESTINATION_INVALID: 'stripe-destination-invalid',
  DESTINATION_NOT_CONFIGURED: 'stripe-destination-not-configured',
  ACCOUNT_UNAVAILABLE: 'stripe-account-unavailable',
  ACCOUNT_MISMATCH: 'stripe-account-mismatch',
  LIVE_MODE_REFUSED: 'stripe-live-mode-refused',
  INTERLOCK_UNAVAILABLE: 'stripe-interlock-unavailable',
  CREATE_FAILED: 'stripe-create-failed',
  CREATED_OBJECT_MISMATCH: 'stripe-created-object-mismatch',
  BINDING_UNAVAILABLE: 'stripe-binding-unavailable',
  PAYMENT_INTENT_BOUND_ELSEWHERE: 'stripe-payment-intent-bound-elsewhere',
  CONFIRM_NOT_SENT: 'stripe-confirm-not-sent',
  RAIL_ERROR_BEFORE_CONFIRM: 'stripe-rail-error-before-confirm',
  // ── a definitive processor verdict on the one confirmation (not-completed PROVIDER_REJECTED) ──
  PAYMENT_FAILED: 'stripe-payment-failed',
  AUTHENTICATION_REQUIRED: 'stripe-authentication-required',
  PAYMENT_CANCELED: 'stripe-payment-canceled',
  // ── after the one confirmation, or an earlier one (unconfirmed) ──
  EXECUTION_PREVIOUSLY_INITIATED: 'stripe-execution-previously-initiated',
  EXECUTION_TERMS_CONFLICT: 'stripe-execution-terms-conflict',
  PAYMENT_PROCESSING: 'stripe-payment-processing',
  REQUIRES_ACTION: 'stripe-requires-action',
  CONFIRMATION_PENDING: 'stripe-confirmation-pending',
  CONFIRM_OUTCOME_UNKNOWN: 'stripe-confirm-outcome-unknown',
  ANSWER_UNREADABLE: 'stripe-answer-unreadable',
  ANSWER_INCONSISTENT: 'stripe-answer-inconsistent',
  LIVE_OBJECT: 'stripe-live-object',
  CORRELATION_MISMATCH: 'stripe-correlation-mismatch',
  AMOUNT_MISMATCH: 'stripe-amount-mismatch',
  CURRENCY_MISMATCH: 'stripe-currency-mismatch',
  DESTINATION_MISMATCH: 'stripe-destination-mismatch',
  FUNDING_MISMATCH: 'stripe-funding-mismatch',
  CHARGE_MODEL_MISMATCH: 'stripe-charge-model-mismatch',
  CAPTURE_PENDING: 'stripe-capture-pending',
  AMOUNT_RECEIVED_MISMATCH: 'stripe-amount-received-mismatch',
} as const;

export type StripeRailDetail = (typeof STRIPE_RAIL_DETAILS)[keyof typeof STRIPE_RAIL_DETAILS];
