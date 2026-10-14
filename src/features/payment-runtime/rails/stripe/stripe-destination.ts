import type { PaymentDestination } from '../../domain/index.js';
import { isStripeAccountId } from './stripe-identifiers.js';

/**
 * The governed Stripe destination (PAY-09): the Stripe Connect connected
 * account a destination charge transfers its funds to.
 *
 * ```
 * PaymentDestination { kind: 'stripe-connected-account', reference: 'acct_1Nv0FGQ9RKHgCVdK' }
 *   → governed counterparty  stripe-connected-account:acct_1Nv0FGQ9RKHgCVdK   (PAY-01's injective encoding, unchanged)
 * ```
 *
 * The reference **is** the connected account's own Stripe identifier, not an
 * alias a configuration file maps to one: the counterparty the Kernel, policy,
 * P10 and the grant bound is the real account funds go to, and no later change
 * of trusted configuration can redirect a governed payment to another
 * account. Configuration can only **refuse** a destination (the allowlist in
 * `stripe-config.ts`), never substitute one.
 *
 * It fits PAY-01's opaque-reference grammar unchanged (letters, digits, `_`)
 * and adds no field to `PaymentDestination`: the kind is this rail's word in
 * the host's vocabulary, which Frontera gives no meaning beyond its grammar.
 */

export const STRIPE_DESTINATION_KIND = 'stripe-connected-account';

/** The connected account a governed destination names, or `undefined` for any other destination. */
export function parseStripeDestination(destination: PaymentDestination | undefined): string | undefined {
  if (destination === undefined || destination.kind !== STRIPE_DESTINATION_KIND) return undefined;
  return isStripeAccountId(destination.reference) ? destination.reference : undefined;
}

/** The destination for a connected account — what an embedder puts in a `PaymentIntent`. */
export function stripeDestinationOf(connectedAccountId: string): PaymentDestination {
  if (!isStripeAccountId(connectedAccountId)) throw new TypeError('A Stripe destination is a connected account id (acct_…).');
  return Object.freeze({ kind: STRIPE_DESTINATION_KIND, reference: connectedAccountId });
}
