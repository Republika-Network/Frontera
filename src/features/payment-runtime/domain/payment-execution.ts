import type { ValidatedExecutionAction } from '../../execution-runtime/index.js';
import { isGovernedParameterToken, isSemanticIdentifier } from '../../governed-parameter-runtime/index.js';
import { isPositiveMonetaryAmount, isWellFormedMonetaryAmount, type MonetaryAmount } from '../../monetary-runtime/index.js';
import { isPaymentReference } from './payment-grammar.js';
import { PAYMENT_PARAMETER_DIMENSION_IDS, paymentDestinationOf, type PaymentGovernanceBinding } from './payment-governance.js';
import { isPaymentPurpose, type PaymentDestination, type PaymentPurpose, type PaymentSourceRef } from './payment-intent.js';

/**
 * The normalized, rail-neutral instruction a payment rail receives — and the
 * **prepared** form of a governed payment (PAY-01).
 *
 * ## Built only from what the grant proved
 *
 * It is derived from the execution runtime's `ValidatedExecutionAction`, which
 * exists only after the Kernel decided, the decision was durably committed,
 * the grant was issued and re-read from the authoritative store, the exact
 * attempt was proven inside it, P7 admitted it and the write-ahead claim was
 * recorded. So every value below is one the governed path already bounded:
 * the source is the grant's resource, the destination its counterparty, the
 * amount at or below its ceiling in its own asset, and purpose, reference and
 * rail its exact-bound parameters. Nothing comes from the caller's original
 * request object, and nothing is added.
 *
 * ## Least authority
 *
 * No actor, principal or organization, no decision status, no policy result,
 * no obligation, no approval, no grant scope and no digest: a rail needs none
 * of them to move funds and could misuse any of them to second-guess
 * governance. `grantId` and the correlation ids are identities for tying a
 * provider's answer back to the record — handles, not authority.
 *
 * ## Stable execution identity
 *
 * `executionId` is server-derived from the committed decision and is the same
 * value on every replay of the same governed request; the governed path never
 * invokes a rail twice for it. A rail should use it as its own idempotency key
 * toward its provider, so even a provider-side retry cannot become a second
 * payment.
 *
 * ## No secret material
 *
 * Nothing here is or can carry a key, a credential or a signer. A rail that
 * needs one obtains it from its own trusted composition; it never travels on
 * the request and never reaches durable evidence.
 */
export interface PaymentExecutionRequest {
  readonly executionId: string;
  readonly requestId: string;
  readonly decisionId: string;
  /** The bounded grant this execution is exercised under. Correlation only; the rail cannot read the grant it names. */
  readonly grantId: string;
  /** When the covering grant stops. A provider-side authorization the rail creates must not outlive it. */
  readonly notAfter: string;
  readonly source: PaymentSourceRef;
  readonly destination: PaymentDestination;
  readonly amount: MonetaryAmount;
  readonly purpose: PaymentPurpose;
  readonly reference?: string;
  readonly rail?: string;
}

/** Why a validated action is not a payment this binding can prepare. The rail is never contacted for any of these. */
export const PAYMENT_EXECUTION_REFUSALS = {
  /** The action is not this deployment's payment action. */
  PAYMENT_EXECUTION_ACTION_UNBOUND: 'PAYMENT_EXECUTION_ACTION_UNBOUND',
  /** No positive canonical amount crossed the boundary. */
  PAYMENT_EXECUTION_AMOUNT_INVALID: 'PAYMENT_EXECUTION_AMOUNT_INVALID',
  PAYMENT_EXECUTION_SOURCE_INVALID: 'PAYMENT_EXECUTION_SOURCE_INVALID',
  PAYMENT_EXECUTION_DESTINATION_INVALID: 'PAYMENT_EXECUTION_DESTINATION_INVALID',
  /** The purpose, reference or rail parameter is absent where required, or malformed. */
  PAYMENT_EXECUTION_PARAMETERS_INVALID: 'PAYMENT_EXECUTION_PARAMETERS_INVALID',
} as const;

export type PaymentExecutionRefusal = (typeof PAYMENT_EXECUTION_REFUSALS)[keyof typeof PAYMENT_EXECUTION_REFUSALS];

export type PaymentExecutionPreparation = { readonly prepared: true; readonly request: PaymentExecutionRequest } | { readonly prepared: false; readonly refusal: PaymentExecutionRefusal };

const R = PAYMENT_EXECUTION_REFUSALS;

/** The token value of one exact-bound parameter, `undefined` when absent, or `null` when present and not a token. */
function tokenParameter(action: ValidatedExecutionAction, dimension: string): string | undefined | null {
  const entry = action.parameters?.find((parameter) => parameter.dimension === dimension);
  if (entry === undefined) return undefined;
  return entry.type === 'token' ? entry.value : null;
}

/**
 * Prepares a payment execution from a validated action — pure, total and
 * deterministic. Never throws; anything that is not exactly a payment under
 * this binding is a refusal, and a refused preparation reaches no rail.
 *
 * Parameter dimensions a host's profile declares beside the payment's own are
 * not carried: the rail receives payment semantics only.
 */
export function preparePaymentExecution(action: ValidatedExecutionAction, binding: PaymentGovernanceBinding): PaymentExecutionPreparation {
  if (action.action !== binding.action) return { prepared: false, refusal: R.PAYMENT_EXECUTION_ACTION_UNBOUND };
  const amount = action.amount;
  if (amount === undefined || !isWellFormedMonetaryAmount(amount) || !isPositiveMonetaryAmount(amount)) return { prepared: false, refusal: R.PAYMENT_EXECUTION_AMOUNT_INVALID };
  if (!isPaymentReference(action.resource)) return { prepared: false, refusal: R.PAYMENT_EXECUTION_SOURCE_INVALID };
  const destination = paymentDestinationOf(action.counterparty);
  if (destination === undefined) return { prepared: false, refusal: R.PAYMENT_EXECUTION_DESTINATION_INVALID };

  const purpose = tokenParameter(action, PAYMENT_PARAMETER_DIMENSION_IDS.purpose);
  const reference = tokenParameter(action, PAYMENT_PARAMETER_DIMENSION_IDS.reference);
  const rail = tokenParameter(action, PAYMENT_PARAMETER_DIMENSION_IDS.rail);
  if (!isPaymentPurpose(purpose)) return { prepared: false, refusal: R.PAYMENT_EXECUTION_PARAMETERS_INVALID };
  if (reference === null || (reference !== undefined && !isGovernedParameterToken(reference))) return { prepared: false, refusal: R.PAYMENT_EXECUTION_PARAMETERS_INVALID };
  if (rail === null || (rail !== undefined && !isSemanticIdentifier(rail))) return { prepared: false, refusal: R.PAYMENT_EXECUTION_PARAMETERS_INVALID };

  return {
    prepared: true,
    request: Object.freeze({
      executionId: action.correlation.executionId,
      requestId: action.correlation.requestId,
      decisionId: action.correlation.decisionId,
      grantId: action.boundedGrantId,
      notAfter: action.notAfter,
      source: Object.freeze({ accountId: action.resource }),
      destination,
      amount: Object.freeze({ value: amount.value, unit: amount.unit }),
      purpose,
      ...(reference !== undefined ? { reference } : {}),
      ...(rail !== undefined ? { rail } : {}),
    }),
  };
}
