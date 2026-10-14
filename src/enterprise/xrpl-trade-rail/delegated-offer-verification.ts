import { isXrplTransactionHash } from '../../features/xrpl-transport/index.js';
import { decodeXrplSignedBlob, isCanonicalXrplSignedBlob, isXrplSignedBlob, signedByPinnedKey, xrplSignedBlobHash, xrplSingleSigningEncoding } from '../../features/xrpl-transport/xrpl-signature.js';
import { DELEGATED_OFFER_SIGNATURE_FIELDS, parsePreparedDelegatedOffer, type DelegatedOfferSignerPair, type PreparedDelegatedOffer } from './delegated-offer-protocol.js';

/**
 * TRADE-04B — Host-side verification of a signed delegated OfferCreate.
 *
 * A signer's answer is an untrusted byte string until every one of these
 * holds, in this order, each with its own closed failure:
 *
 * 1. the blob is bounded uppercase hex and the reported hash is a hash;
 * 2. the prepared transaction is itself the closed contract, for exactly the
 *    pinned owner and delegate;
 * 3. the blob decodes, and is the codec's **canonical** serialization of what
 *    it decodes to (no reordered, duplicated or trailing fields);
 * 4. its field set is **exactly** the prepared fields plus `SigningPubKey` and
 *    `TxnSignature` — no `Signers` (no multisigning), no `Memos`, no field the
 *    prepared transaction did not have, none missing;
 * 5. it is an `OfferCreate` whose `Account` is the owner and whose `Delegate`
 *    is the delegate;
 * 6. its `SigningPubKey` is the **pinned** delegate key;
 * 7. its single-signing encoding equals, byte for byte, the encoding of the
 *    prepared transaction under that key — so no amount, issuer, currency,
 *    flag, expiration, fee, `Sequence` or `LastLedgerSequence` differs;
 * 8. its `TxnSignature` verifies under the pinned key over those bytes;
 * 9. the reported hash is the blob's own, recomputed here.
 *
 * Pure and total: no I/O, no clock; anything unexpected is a failure. A
 * verified signature proves only that the pinned delegate key signed exactly
 * this prepared transaction. It is **not** an authorization, a submission or
 * a settlement, and confers nothing on its own.
 */
export const DELEGATED_OFFER_VERIFICATION_FAILURES = [
  'BLOB_MALFORMED',
  'HASH_MALFORMED',
  'PREPARED_INVALID',
  'PAIR_MISMATCH',
  'BLOB_UNDECODABLE',
  'BLOB_NOT_CANONICAL',
  'FIELD_SET_MISMATCH',
  'TRANSACTION_TYPE_MISMATCH',
  'OWNER_MISMATCH',
  'DELEGATE_MISMATCH',
  'SIGNING_KEY_MISMATCH',
  'TRANSACTION_MISMATCH',
  'SIGNATURE_INVALID',
  'HASH_MISMATCH',
] as const;
export type DelegatedOfferVerificationFailure = (typeof DELEGATED_OFFER_VERIFICATION_FAILURES)[number];

/** What a successful verification establishes — and nothing more. */
export interface VerifiedDelegatedOfferBlob {
  readonly ownerAccount: string;
  readonly delegateAccount: string;
  readonly signingPublicKey: string;
  readonly signedTransaction: string;
  readonly hash: string;
}

export type DelegatedOfferVerification = { readonly verified: true; readonly blob: VerifiedDelegatedOfferBlob } | { readonly verified: false; readonly failure: DelegatedOfferVerificationFailure };

export interface DelegatedOfferVerificationInput {
  /** The prepared transaction the Host asked to have signed. */
  readonly prepared: PreparedDelegatedOffer;
  /** The trusted pin: owner, delegate and the delegate's signing public key. Never taken from the signer's answer. */
  readonly pair: DelegatedOfferSignerPair;
  readonly signedTransaction: unknown;
  readonly hash: unknown;
}

const refuse = (failure: DelegatedOfferVerificationFailure): DelegatedOfferVerification => ({ verified: false, failure });

export function verifySignedDelegatedOffer(input: DelegatedOfferVerificationInput): DelegatedOfferVerification {
  const { prepared, pair, signedTransaction, hash } = input;
  if (!isXrplSignedBlob(signedTransaction)) return refuse('BLOB_MALFORMED');
  if (!isXrplTransactionHash(hash)) return refuse('HASH_MALFORMED');

  // Re-read as the closed contract: only what parses is compared below, never the caller's object itself.
  const closed = parsePreparedDelegatedOffer(prepared);
  if (closed === undefined) return refuse('PREPARED_INVALID');
  if (closed.Account !== pair.ownerAccount || closed.Delegate !== pair.delegateAccount) return refuse('PAIR_MISMATCH');

  const decoded = decodeXrplSignedBlob(signedTransaction);
  if (decoded === undefined) return refuse('BLOB_UNDECODABLE');
  if (!isCanonicalXrplSignedBlob(signedTransaction)) return refuse('BLOB_NOT_CANONICAL');

  const expected = [...Object.keys(closed), ...DELEGATED_OFFER_SIGNATURE_FIELDS].sort();
  const actual = Object.keys(decoded).sort();
  if (expected.length !== actual.length || expected.some((field, index) => field !== actual[index])) return refuse('FIELD_SET_MISMATCH');

  if (decoded['TransactionType'] !== 'OfferCreate') return refuse('TRANSACTION_TYPE_MISMATCH');
  if (decoded['Account'] !== pair.ownerAccount) return refuse('OWNER_MISMATCH');
  if (decoded['Delegate'] !== pair.delegateAccount) return refuse('DELEGATE_MISMATCH');
  if (decoded['SigningPubKey'] !== pair.signingPublicKey) return refuse('SIGNING_KEY_MISMATCH');

  const signedEncoding = xrplSingleSigningEncoding(decoded);
  const preparedEncoding = xrplSingleSigningEncoding({ ...closed, SigningPubKey: pair.signingPublicKey });
  if (signedEncoding === undefined || preparedEncoding === undefined || signedEncoding !== preparedEncoding) return refuse('TRANSACTION_MISMATCH');

  if (!signedByPinnedKey(signedTransaction, pair.signingPublicKey)) return refuse('SIGNATURE_INVALID');
  if (xrplSignedBlobHash(signedTransaction) !== hash) return refuse('HASH_MISMATCH');

  return {
    verified: true,
    blob: Object.freeze({ ownerAccount: pair.ownerAccount, delegateAccount: pair.delegateAccount, signingPublicKey: pair.signingPublicKey, signedTransaction, hash }),
  };
}
