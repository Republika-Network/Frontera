import type { ParameterDimensionDeclaration } from '../../governed-parameter-runtime/index.js';
import { isPaymentDestinationKind, isPaymentEnvelopeIdentifier, isPaymentReference } from './payment-grammar.js';
import { isWellFormedPaymentIntent, type PaymentDestination, type PaymentIntent } from './payment-intent.js';

/**
 * How a payment becomes a governed action (PAY-01).
 *
 * > A payment intent **compiles down** to the generic governed-action
 * > envelope. It is never a second way in.
 *
 * ```
 * PaymentIntent              GovernedActionIntent           governed axis
 * ─────────────────────────  ─────────────────────────────  ─────────────────────────────────────────
 * (binding.action)        →  action                         Kernel action.type · grant action bound
 * source.accountId        →  resource                       resourceScope · grant resource set
 * destination             →  counterparty "<kind>:<ref>"    counterpartyId · grant counterparty bound
 * amount {value, unit}    →  amount {value, currency}       P9 amount · P10 ceiling · P7 exposure
 * purpose                 →  parameters.paymentPurpose      CORE-03 token, bound exactly
 * reference               →  parameters.paymentReference    CORE-03 token, bound exactly
 * rail                    →  parameters.paymentRail         CORE-03 token, bound exactly
 * idempotencyKey          →  idempotencyKey                 request identity, replay / conflict
 * correlationId           →  correlationId
 * ```
 *
 * Every payment field lands on an axis the governed path **already** decides,
 * bounds, records and discloses. Nothing here evaluates policy, consults
 * authority, issues anything or reaches a rail: the output is plain intent
 * data, and the one thing a caller can do with it is hand it to the Governed
 * Action Orchestrator — which validates it again, in full, against the same
 * trusted configuration it validates every governed action against.
 *
 * ## What the host must compose (and what happens if it does not)
 *
 * - the bound action listed in `monetary.financialActions` — otherwise the
 *   envelope refuses the amount;
 * - `PAYMENT_PARAMETER_DIMENSIONS` declared, and a Governance Profile over the
 *   payment action class × the governed source accounts' resource class whose
 *   parameters are `PAYMENT_PROFILE_PARAMETERS` — otherwise the envelope
 *   refuses the parameters.
 *
 * Both failures are refusals before evaluation. There is no fallback in which
 * a payment is governed as something less.
 */

/** The CORE-03 dimension ids a payment states. Lower-camel semantic identifiers; reserved in asserted context by the registry as every declared dimension is. */
export const PAYMENT_PARAMETER_DIMENSION_IDS = {
  purpose: 'paymentPurpose',
  reference: 'paymentReference',
  rail: 'paymentRail',
} as const;

/** Declarations for a host's `governance.parameterDimensions`. Tokens, bound `exact`: a grant for one purpose, reference or rail is never a grant for another. */
export const PAYMENT_PARAMETER_DIMENSIONS: readonly ParameterDimensionDeclaration[] = Object.freeze([
  Object.freeze({ id: PAYMENT_PARAMETER_DIMENSION_IDS.purpose, type: 'token', bound: 'exact' } as const),
  Object.freeze({ id: PAYMENT_PARAMETER_DIMENSION_IDS.reference, type: 'token', bound: 'exact' } as const),
  Object.freeze({ id: PAYMENT_PARAMETER_DIMENSION_IDS.rail, type: 'token', bound: 'exact' } as const),
]);

/** The parameter list for a payment Governance Profile: purpose required, reference and rail optional. */
export const PAYMENT_PROFILE_PARAMETERS: readonly { readonly dimension: string; readonly required: boolean }[] = Object.freeze([
  Object.freeze({ dimension: PAYMENT_PARAMETER_DIMENSION_IDS.purpose, required: true }),
  Object.freeze({ dimension: PAYMENT_PARAMETER_DIMENSION_IDS.reference, required: false }),
  Object.freeze({ dimension: PAYMENT_PARAMETER_DIMENSION_IDS.rail, required: false }),
]);

/**
 * Trusted host configuration: which governed action identifier *is* a payment
 * in this deployment. Not a constant, because what an action is called is the
 * deployment's vocabulary; not caller input, because a caller who could name
 * the action could name a different one.
 */
export interface PaymentGovernanceBinding {
  readonly action: string;
}

export class PaymentConfigurationError extends Error {
  readonly code: 'PAYMENT_CONFIGURATION_INVALID';

  constructor(message: string) {
    super(message);
    this.name = 'PaymentConfigurationError';
    this.code = 'PAYMENT_CONFIGURATION_INVALID';
  }
}

/** Builds the frozen binding, or throws `PaymentConfigurationError`. Wiring-time. */
export function createPaymentGovernanceBinding(configuration: { readonly action: string }): PaymentGovernanceBinding {
  const action: unknown = configuration?.action;
  if (!isPaymentEnvelopeIdentifier(action)) throw new PaymentConfigurationError('The payment action must be a canonical governed action identifier.');
  return Object.freeze({ action });
}

/** The separator between a destination's kind and its reference. A kind never contains it, so the first one splits exactly. */
const DESTINATION_SEPARATOR = ':';

/** The one encoding of a destination as the governed counterparty: `<kind>:<reference>`. Injective: two destinations never share a counterparty. */
export function paymentCounterpartyOf(destination: PaymentDestination): string {
  if (!isPaymentDestinationKind(destination.kind) || !isPaymentReference(destination.reference)) throw new RangeError('The destination is not canonical.');
  return `${destination.kind}${DESTINATION_SEPARATOR}${destination.reference}`;
}

/** The inverse of `paymentCounterpartyOf`, or `undefined` for a counterparty no canonical destination encodes to. */
export function paymentDestinationOf(counterparty: unknown): PaymentDestination | undefined {
  if (typeof counterparty !== 'string') return undefined;
  const separator = counterparty.indexOf(DESTINATION_SEPARATOR);
  if (separator === -1) return undefined;
  const kind = counterparty.slice(0, separator);
  const reference = counterparty.slice(separator + 1);
  if (!isPaymentDestinationKind(kind) || !isPaymentReference(reference)) return undefined;
  return Object.freeze({ kind, reference });
}

/**
 * The governed-action intent a payment compiles to — structurally the
 * envelope's own `GovernedActionIntent`, stated here rather than imported
 * because a feature module never depends on the enterprise layer. An
 * enterprise test proves the two stay assignable.
 */
export interface PaymentGovernedActionIntent {
  readonly action: string;
  readonly resource: string;
  readonly counterparty: string;
  readonly amount: { readonly value: string; readonly currency: string };
  readonly parameters: Readonly<Record<string, string>>;
  readonly idempotencyKey: string;
  readonly correlationId?: string;
  readonly assertedContext?: Readonly<Record<string, unknown>>;
  readonly expectedGovernanceProfile?: { readonly id: string; readonly version: number };
}

/**
 * Envelope-owned fields a caller may pass through unchanged: the evidence it
 * asserts (a passport, a capability token) and a profile pin. They are not
 * payment semantics, so they are not on `PaymentIntent`; the orchestrator
 * validates both exactly as it validates them for any governed action.
 */
export interface PaymentEnvelopeOptions {
  readonly assertedContext?: Readonly<Record<string, unknown>>;
  readonly expectedGovernanceProfile?: { readonly id: string; readonly version: number };
}

/**
 * Compiles a validated payment intent to its governed-action intent.
 *
 * Pure and deterministic: the same intent and binding always produce an
 * equal, frozen object with the same key order, so its digest — and therefore
 * idempotency replay and conflict on the governed path — is a function of the
 * payment alone. Throws `RangeError` for a value that is not a canonical
 * payment intent: compilation never repairs.
 */
export function compilePaymentIntent(intent: PaymentIntent, binding: PaymentGovernanceBinding, envelope: PaymentEnvelopeOptions = {}): PaymentGovernedActionIntent {
  if (!isWellFormedPaymentIntent(intent)) throw new RangeError('compilePaymentIntent needs a payment intent validatePaymentIntent accepted.');
  if (!isPaymentEnvelopeIdentifier(binding?.action)) throw new PaymentConfigurationError('The payment governance binding is not canonical.');
  const parameters: Record<string, string> = { [PAYMENT_PARAMETER_DIMENSION_IDS.purpose]: intent.purpose };
  if (intent.reference !== undefined) parameters[PAYMENT_PARAMETER_DIMENSION_IDS.reference] = intent.reference;
  if (intent.rail !== undefined) parameters[PAYMENT_PARAMETER_DIMENSION_IDS.rail] = intent.rail;
  return Object.freeze({
    action: binding.action,
    resource: intent.source.accountId,
    counterparty: paymentCounterpartyOf(intent.destination),
    amount: Object.freeze({ value: intent.amount.value, currency: intent.amount.unit }),
    parameters: Object.freeze(parameters),
    idempotencyKey: intent.idempotencyKey,
    ...(intent.correlationId !== undefined ? { correlationId: intent.correlationId } : {}),
    ...(envelope.assertedContext !== undefined ? { assertedContext: envelope.assertedContext } : {}),
    ...(envelope.expectedGovernanceProfile !== undefined ? { expectedGovernanceProfile: envelope.expectedGovernanceProfile } : {}),
  });
}
