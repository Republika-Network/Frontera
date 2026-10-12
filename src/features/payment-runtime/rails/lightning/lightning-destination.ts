import type { PaymentDestination } from '../../domain/index.js';
import { isLightningNodePublicKey } from './lightning-signature.js';

/**
 * The governed Lightning destination (PAY-06): who is paid, and for which
 * invoice — not an account address.
 *
 * ```
 * PaymentDestination { kind: 'lightning-invoice', reference: '<payee node key>:<payment hash>' }
 *   → governed counterparty  lightning-invoice:02ab…:5f3c…     (PAY-01's injective encoding, unchanged)
 * ```
 *
 * Both halves are lowercase hex — the payee's 33-byte compressed node key and
 * the invoice's 32-byte payment hash — so the reference stays inside PAY-01's
 * opaque-reference grammar (131 characters of the 200 allowed). The BOLT11
 * string itself is too long for a governed reference and is not authority: it
 * is resolved, at execution, from the deployment's trusted invoice source by
 * this payment hash, decoded, verified, and must match **both** halves exactly
 * (`lightning-rail.ts`). So the counterparty Kernel, policy, P10 and the grant
 * bound is the payee *and* the invoice; an external invoice can never replace
 * either.
 */

export const LIGHTNING_DESTINATION_KIND = 'lightning-invoice';

export interface LightningDestination {
  readonly payee: string;
  readonly paymentHash: string;
}

const REFERENCE = /^(0[23][0-9a-f]{64}):([0-9a-f]{64})$/;

/** A 32-byte payment hash or preimage digest, lowercase hex. */
export function isLightningPaymentHash(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

/** The governed destination's payee and payment hash, or `undefined` for any other destination. */
export function parseLightningDestination(destination: PaymentDestination | undefined): LightningDestination | undefined {
  if (destination === undefined || destination.kind !== LIGHTNING_DESTINATION_KIND || typeof destination.reference !== 'string') return undefined;
  const match = REFERENCE.exec(destination.reference);
  if (match === null) return undefined;
  const payee = match[1] ?? '';
  const paymentHash = match[2] ?? '';
  return isLightningNodePublicKey(payee) && isLightningPaymentHash(paymentHash) ? Object.freeze({ payee, paymentHash }) : undefined;
}

/** The destination for a payee and payment hash — what an embedder puts in a `PaymentIntent`. */
export function lightningDestinationOf(payee: string, paymentHash: string): PaymentDestination {
  if (!isLightningNodePublicKey(payee) || !isLightningPaymentHash(paymentHash)) throw new TypeError('A Lightning destination needs a compressed node key and a payment hash, both lowercase hex.');
  return Object.freeze({ kind: LIGHTNING_DESTINATION_KIND, reference: `${payee}:${paymentHash}` });
}
