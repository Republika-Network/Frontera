import { X402_PROTOCOL_ID, readX402PaymentResponseCarrier } from '../../features/payment-runtime/protocols/x402/index.js';
import { parseLightningDestination } from '../../features/payment-runtime/rails/lightning/index.js';
import type { VerifiedPaymentProtocolContext } from '../payment-protocol-ingress/index.js';

/**
 * PAY-08 — `PAYMENT-RESPONSE` read as **protocol evidence**, never as
 * Frontera settlement.
 *
 * A resource server's `SettlementResponse` says what *it* believes about the
 * payment, and an HTTP 200 says it served the resource. Neither is funds
 * finality: PAY-05's `verifySettlement`, through the rail's own finality
 * authority, is the only thing that records a payment `settled`. This reader
 * writes nothing — no PAY-05 record, no P11 / P12 fact, no store, no log —
 * and its answer is a closed, bounded comparison with the governed terms:
 *
 * | check | rule (`exact` on `lnbtc`) |
 * | --- | --- |
 * | `network` | equals the governed requirement's network |
 * | `transaction` | on success, and whenever non-empty (failure and `settlement_pending` too), equals the governed payment hash, lower case |
 * | `payer` | absent (the binding forbids it: Lightning has no stable payer) |
 * | `amount` | absent, or equal to the governed atomic amount |
 *
 * A non-empty `transaction` claims to identify a payment, so it is held to
 * the governed one on success, failure and `settlement_pending` alike; an
 * empty one (nothing broadcast) is consistent only on a failure, because it
 * claims nothing — a success must name the governed payment.
 * A `settlement_pending` response without a transaction is not well formed
 * and never reaches this comparison (`unreadable`).
 *
 * The merchant's `errorReason` is kept only as a bounded token
 * (`^[a-z0-9_]+$`, at most 128 characters), for the caller's diagnosis.
 */

export type X402PaymentResponseMismatch = 'network' | 'transaction' | 'payer' | 'amount';

export type X402PaymentResponseEvidence =
  | {
      readonly outcome: 'evidence';
      readonly status: number;
      /** What the server says. Not Frontera settlement. */
      readonly serverReportsSuccess: boolean;
      /** Whether what it says is about exactly the governed payment. */
      readonly consistent: boolean;
      readonly mismatch?: X402PaymentResponseMismatch;
      readonly errorReason?: string;
    }
  | { readonly outcome: 'unreadable'; readonly violation: string }
  | { readonly outcome: 'not-x402' };

export function readX402PaymentResponseEvidence(carrier: unknown, context: VerifiedPaymentProtocolContext): X402PaymentResponseEvidence {
  if (context.challenge.protocolId !== X402_PROTOCOL_ID) return Object.freeze({ outcome: 'not-x402' });
  const destination = parseLightningDestination(context.terms.destination);
  const network = context.challenge.fields['network'];
  const amount = context.challenge.fields['amount'];
  if (destination === undefined || network === undefined || amount === undefined) return Object.freeze({ outcome: 'not-x402' });
  const read = readX402PaymentResponseCarrier(carrier);
  if (!read.valid) return Object.freeze({ outcome: 'unreadable', violation: read.violation });
  const { status, response } = read.value;
  const mismatch: X402PaymentResponseMismatch | undefined =
    response.network !== network
      ? 'network'
      : (response.success || response.transaction !== '') && response.transaction !== destination.paymentHash
        ? 'transaction'
        : response.payer !== undefined
          ? 'payer'
          : response.amount !== undefined && response.amount !== amount
            ? 'amount'
            : undefined;
  return Object.freeze({
    outcome: 'evidence',
    status,
    serverReportsSuccess: response.success,
    consistent: mismatch === undefined,
    ...(mismatch !== undefined ? { mismatch } : {}),
    ...(response.errorReason !== undefined ? { errorReason: response.errorReason } : {}),
  });
}
