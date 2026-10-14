/**
 * Stripe object identifiers, held to a conservative bound (PAY-09).
 *
 * Stripe documents each object's `id` as an opaque string — "Unique identifier
 * for the object" — and does **not** publish a grammar for it. So this module
 * claims only what Stripe's own identifiers visibly share and what Frontera
 * needs to keep them safe as durable correlation handles:
 *
 * - the object-type prefix Stripe uses for that object (`acct_`, `cus_`,
 *   `pm_`, `pi_`, `ch_`, `evt_`) — every identifier in the API reference
 *   carries it, and a value of the wrong type is never accepted where another
 *   type belongs (a Customer id is never taken for a PaymentMethod id);
 * - after the prefix, ASCII letters, digits and `_` only — enough for every
 *   documented identifier, including test-mode PaymentMethods such as
 *   `pm_card_visa`, and nothing a path, URL, header or form encoding could
 *   reinterpret;
 * - at most 255 characters.
 *
 * Nothing here parses an identifier into parts or infers anything from its
 * body. A `PaymentIntent` id is never derived from a `client_secret`
 * (`pi_…_secret_…`): a value containing `_secret_` is refused outright, so a
 * client secret can never be accepted where an id belongs.
 */

export const STRIPE_IDENTIFIER_MAXIMUM_LENGTH = 255;

export const STRIPE_IDENTIFIER_PREFIXES = Object.freeze({
  account: 'acct_',
  customer: 'cus_',
  paymentMethod: 'pm_',
  paymentIntent: 'pi_',
  charge: 'ch_',
  event: 'evt_',
});

export type StripeIdentifierKind = keyof typeof STRIPE_IDENTIFIER_PREFIXES;

const BODY = /^[A-Za-z0-9_]+$/;

export function isStripeIdentifier(kind: StripeIdentifierKind, value: unknown): value is string {
  const prefix = STRIPE_IDENTIFIER_PREFIXES[kind];
  if (typeof value !== 'string' || value.length > STRIPE_IDENTIFIER_MAXIMUM_LENGTH || !value.startsWith(prefix)) return false;
  const body = value.slice(prefix.length);
  return body.length > 0 && BODY.test(body) && !value.includes('_secret_');
}

export const isStripeAccountId = (value: unknown): value is string => isStripeIdentifier('account', value);
export const isStripeCustomerId = (value: unknown): value is string => isStripeIdentifier('customer', value);
export const isStripePaymentMethodId = (value: unknown): value is string => isStripeIdentifier('paymentMethod', value);
export const isStripePaymentIntentId = (value: unknown): value is string => isStripeIdentifier('paymentIntent', value);
export const isStripeChargeId = (value: unknown): value is string => isStripeIdentifier('charge', value);
export const isStripeEventId = (value: unknown): value is string => isStripeIdentifier('event', value);
