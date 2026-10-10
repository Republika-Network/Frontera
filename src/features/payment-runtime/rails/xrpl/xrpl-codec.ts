import { decode, encodeForSigning, hashes, type Transaction } from 'xrpl';
import type { XrplPreparedPayment } from './xrpl-client-port.js';

/** An XRPL transaction hash: 64 uppercase hex digits. */
const TRANSACTION_HASH = /^[0-9A-F]{64}$/;

export function isXrplTransactionHash(value: unknown): value is string {
  return typeof value === 'string' && TRANSACTION_HASH.test(value);
}

/** A signed blob: uppercase hex, bounded. A Payment is a few hundred bytes. */
const SIGNED_BLOB = /^(?:[0-9A-F]{2}){32,4096}$/;

/**
 * Whether a signer's answer is a signature of **exactly** the prepared
 * payment, and its hash is the blob's own (PAY-02 signing boundary).
 *
 * The signed blob is decoded with the SDK's codec and its signing encoding is
 * compared, byte for byte, with the signing encoding of the payment the rail
 * prepared — so a signer that changed the destination, the amount, the
 * issuer, the flags, or added a memo, a path or a `SendMax`, is caught before
 * anything is submitted. Total — a blob that does not decode is `false`.
 */
export function signedPaymentMatches(prepared: XrplPreparedPayment, signed: { readonly signedTransaction: unknown; readonly hash: unknown }): signed is { readonly signedTransaction: string; readonly hash: string } {
  const { signedTransaction, hash } = signed;
  if (typeof signedTransaction !== 'string' || !SIGNED_BLOB.test(signedTransaction) || !isXrplTransactionHash(hash)) return false;
  try {
    const decoded = decode(signedTransaction) as Record<string, unknown>;
    const signingPubKey = decoded['SigningPubKey'];
    if (typeof signingPubKey !== 'string' || signingPubKey.length === 0) return false;
    // `decode` answers the codec's JSON form, which is what `encodeForSigning` reads; the cast states that, it converts nothing.
    if (encodeForSigning(decoded as unknown as Transaction) !== encodeForSigning({ ...prepared, SigningPubKey: signingPubKey } as unknown as Transaction)) return false;
    return hashes.hashSignedTx(signedTransaction) === hash;
  } catch {
    return false;
  }
}
