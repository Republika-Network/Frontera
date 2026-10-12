import type { LightningPaymentFailure, LightningPaymentObservation } from './lightning-node-port.js';
import { preimageMatchesPaymentHash } from './lightning-preimage.js';
import { LIGHTNING_RAIL_DETAILS, type LightningRailDetail } from './lightning-rail-details.js';

/**
 * The one mapping from a node's view of a logical payment to what Frontera
 * may conclude (PAY-06) — shared, unchanged, by the rail (P11), the P12
 * resolution authority and the PAY-05 finality authority, so the three can
 * never disagree about what a node answer means.
 *
 * | node observation | conclusion | P11 / P12 | PAY-05 |
 * | --- | --- | --- | --- |
 * | `succeeded`, same hash, preimage hashes to it, amount exactly the governed amount, fee ≤ the cap | `completed` | `confirmed-completed` | `final` |
 * | `succeeded`, but any of those fails | `inconsistent` | `unconfirmed` / unresolved | `contradicted` |
 * | `failed` (terminal: nothing in flight) for the same hash | `failed` | `confirmed-not-completed` | `contradicted` |
 * | `in-flight` | `pending` | `unconfirmed` / unresolved | `not-final` |
 * | `not-found` | `unknown` | `unconfirmed` / unresolved | `not-final` |
 * | another hash, unreadable | `inconsistent` / `unknown` | `unconfirmed` / unresolved | `not-final` |
 *
 * Never inferred: success from time elapsed, an HTLC sent, a route attempted,
 * an invoice disappearing; failure from a timeout, a disconnect, a node that
 * is unreachable, or a payment the node does not know.
 */
export type LightningPaymentConclusion =
  | { readonly kind: 'completed'; readonly preimage: string; readonly feeMsat: bigint }
  | { readonly kind: 'failed'; readonly failure: LightningPaymentFailure }
  | { readonly kind: 'pending' }
  | { readonly kind: 'unknown' }
  | { readonly kind: 'inconsistent'; readonly detail: LightningRailDetail };

export interface LightningExpectedPayment {
  readonly paymentHash: string;
  readonly amountMsat: bigint;
  readonly feeLimitMsat: bigint;
}

export function concludeLightningPayment(observation: LightningPaymentObservation | undefined, expected: LightningExpectedPayment): LightningPaymentConclusion {
  if (observation === undefined) return { kind: 'unknown' };
  if (observation.state === 'not-found') return { kind: 'unknown' };
  if (observation.paymentHash !== expected.paymentHash) return { kind: 'inconsistent', detail: LIGHTNING_RAIL_DETAILS.NODE_ANSWER_INCONSISTENT };
  if (observation.state === 'in-flight') return { kind: 'pending' };
  if (observation.state === 'failed') return { kind: 'failed', failure: observation.failure };
  if (!preimageMatchesPaymentHash(observation.preimage, expected.paymentHash)) return { kind: 'inconsistent', detail: LIGHTNING_RAIL_DETAILS.PREIMAGE_MISMATCH };
  if (observation.amountMsat !== expected.amountMsat) return { kind: 'inconsistent', detail: LIGHTNING_RAIL_DETAILS.DELIVERED_AMOUNT_MISMATCH };
  if (observation.feeMsat > expected.feeLimitMsat) return { kind: 'inconsistent', detail: LIGHTNING_RAIL_DETAILS.FEE_BOUND_VIOLATED };
  return { kind: 'completed', preimage: observation.preimage, feeMsat: observation.feeMsat };
}
