import { createHash } from 'node:crypto';

import { isLightningPaymentHash } from './lightning-destination.js';

/**
 * Payment preimage verification (PAY-06).
 *
 * BOLT 11 / BOLT 4: `payment_hash = SHA256(payment_preimage)`, both 32 bytes.
 * The payee releases the preimage only when it settles the HTLC, so a
 * preimage that hashes to the invoice's payment hash is the proof the
 * payment completed. Not a string compare: the preimage is decoded from
 * exactly 64 lowercase hex characters into 32 bytes and hashed.
 *
 * ## Disclosure
 *
 * Until settlement the preimage is a bearer secret (whoever holds it can
 * claim the HTLC); after, it is a proof-of-payment a payer may want to keep
 * to itself. Frontera never records it: P11 carries the payment hash, the
 * finality evidence carries `preimageCommitment` — a domain-separated digest
 * that lets whoever later holds the preimage (the node's operator) prove the
 * settlement was about exactly that preimage, without the record disclosing
 * it. (`SHA256(preimage)` itself is the payment hash, already public.)
 */

const COMMITMENT_DOMAIN = 'frontera.lightning.preimage-commitment.v1';

/** Whether `preimage` (64 lowercase hex characters) hashes to `paymentHash` under SHA-256. Total; malformed input is `false`. */
export function preimageMatchesPaymentHash(preimage: unknown, paymentHash: unknown): boolean {
  if (!isLightningPaymentHash(preimage) || !isLightningPaymentHash(paymentHash)) return false;
  const bytes = Buffer.from(preimage, 'hex');
  if (bytes.length !== 32) return false;
  return createHash('sha256').update(bytes).digest('hex') === paymentHash;
}

/** A non-disclosing, domain-separated commitment to a verified preimage — the only form of it that ever reaches evidence. */
export function preimageCommitment(preimage: string): string {
  return createHash('sha256').update(COMMITMENT_DOMAIN, 'utf8').update(Buffer.from(preimage, 'hex')).digest('hex');
}

/** SHA-256 of a canonical invoice's text — its identity in the interlock and the evidence. */
export function invoiceDigest(canonicalInvoice: string): string {
  return createHash('sha256').update(canonicalInvoice, 'utf8').digest('hex');
}
