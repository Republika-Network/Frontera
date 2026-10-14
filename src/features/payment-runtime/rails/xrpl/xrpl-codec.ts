import { isXrplSigningPublicKey, isXrplTransactionHash } from '../../../xrpl-transport/index.js';
import { decodeXrplSignedBlob, signedByPinnedKey, xrplSignedBlobHash, xrplSingleSigningEncoding } from '../../../xrpl-transport/xrpl-signature.js';
import type { XrplPreparedPayment } from './xrpl-client-port.js';

/**
 * The transaction hash and signing public key grammars are transaction-neutral
 * and live in the shared XRPL transport (TRADE-04A); re-exported here under
 * their PAY-02 / PAY-03 names, unchanged.
 *
 * TRADE-04B (G3): so do the SDK codec calls this file used to make itself —
 * decoding, the signing encoding, the blob hash and `signedByPinnedKey`, which
 * is re-exported here under its PAY-03 name, the same function object. This
 * file no longer imports the SDK; `signedPaymentMatches` below, the Payment
 * field-set closure, stays Payment's own and decides exactly as before
 * (`xrpl-codec-signature-preservation.test.ts`).
 */
export { isXrplSigningPublicKey, isXrplTransactionHash, signedByPinnedKey };

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
 * anything is submitted. The signing encoding omits non-signing fields, so the
 * blob's field set is also checked: exactly the prepared fields plus
 * `SigningPubKey` and `TxnSignature` — a signer cannot ride a `Signers`,
 * `Signature`, `MasterSignature` or any other non-signing field along with an
 * otherwise exact signature. Total — a blob that does not decode is `false`.
 */
export function signedPaymentMatches(prepared: XrplPreparedPayment, signed: { readonly signedTransaction: unknown; readonly hash: unknown }): signed is { readonly signedTransaction: string; readonly hash: string } {
  const { signedTransaction, hash } = signed;
  if (typeof signedTransaction !== 'string' || !SIGNED_BLOB.test(signedTransaction) || !isXrplTransactionHash(hash)) return false;
  // Total, as before: anything that throws while reading the prepared payment is a refusal.
  try {
    const decoded = decodeXrplSignedBlob(signedTransaction);
    if (decoded === undefined) return false;
    const signingPubKey = decoded['SigningPubKey'];
    if (typeof signingPubKey !== 'string' || signingPubKey.length === 0) return false;
    const txnSignature = decoded['TxnSignature'];
    if (typeof txnSignature !== 'string' || txnSignature.length === 0) return false;
    const allowed = new Set([...Object.keys(prepared), 'SigningPubKey', 'TxnSignature']);
    if (Object.keys(decoded).some((field) => !allowed.has(field))) return false;
    // Either encoding failing is a refusal, exactly as the throw it replaces was.
    const signedEncoding = xrplSingleSigningEncoding(decoded);
    const preparedEncoding = xrplSingleSigningEncoding({ ...prepared, SigningPubKey: signingPubKey });
    if (signedEncoding === undefined || preparedEncoding === undefined || signedEncoding !== preparedEncoding) return false;
    return xrplSignedBlobHash(signedTransaction) === hash;
  } catch {
    return false;
  }
}
