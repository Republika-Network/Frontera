import { decode, encode, encodeForSigning, hashes, verifySignature, type Transaction } from 'xrpl';

import { isXrplSigningPublicKey } from './xrpl-ledger-grammar.js';

/**
 * TRADE-04B (approval gate G3) — the transaction-neutral signed-blob
 * primitives, and the one file of the shared transport that imports the XRPL
 * SDK's **codec**.
 *
 * It moved here by substitution: the PAY-02 codec (`xrpl-codec.ts`) used to
 * import these SDK functions itself; it now reaches them through this file and
 * re-exports `signedByPinnedKey` under its PAY-03 name, the same function
 * object. The repository's SDK importer list swapped one entry for this one.
 *
 * What this file is allowed to be (`xrpl-transport-boundaries.test.ts`):
 *
 * - **decode, re-encode, hash and verify — nothing else.** It holds no key,
 *   derives none, signs nothing, opens no connection and submits nothing; the
 *   SDK names it imports are pinned.
 * - **transaction-neutral.** It names no transaction type and authorizes none.
 *   *What* a blob must contain is decided by each closed transaction type's
 *   own verifier (PAY-02's `signedPaymentMatches`, TRADE-04B's delegated
 *   OfferCreate verifier); this file only answers questions about bytes.
 * - **total.** Every function answers `undefined` / `false` for anything that
 *   does not decode, never throws, and never forwards an SDK error.
 */

/** A signed blob: uppercase hex, bounded (PAY-02's grammar, unchanged). */
const SIGNED_BLOB = /^(?:[0-9A-F]{2}){32,4096}$/;

/** Whether `value` is a signed blob in the shared grammar: uppercase hex, 32 to 4096 bytes. */
export function isXrplSignedBlob(value: unknown): value is string {
  return typeof value === 'string' && SIGNED_BLOB.test(value);
}

/** The blob's fields in the codec's JSON form, or `undefined` when it is not a blob or does not decode. */
export function decodeXrplSignedBlob(signedBlob: unknown): Readonly<Record<string, unknown>> | undefined {
  if (!isXrplSignedBlob(signedBlob)) return undefined;
  try {
    const decoded = decode(signedBlob) as unknown;
    return decoded !== null && typeof decoded === 'object' && !Array.isArray(decoded) ? (decoded as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The single-signing encoding of `fields` — the exact bytes a single signer
 * signs (prefix `STX\0` plus the signing fields in canonical order), as hex —
 * or `undefined` when the codec refuses them. Non-signing fields
 * (`TxnSignature`, `Signers`) are omitted by the codec, so callers that compare
 * encodings must also close the field set.
 */
export function xrplSingleSigningEncoding(fields: Readonly<Record<string, unknown>>): string | undefined {
  try {
    // `encodeForSigning` reads the codec's JSON form; the cast states that, it converts nothing.
    return encodeForSigning(fields as unknown as Transaction);
  } catch {
    return undefined;
  }
}

/**
 * Whether `signedBlob` is the codec's own canonical serialization of what it
 * decodes to: re-encoding the decoded fields gives back exactly the blob. A
 * blob with a non-canonical field order, a duplicated field or trailing bytes
 * is `false`, so the bytes a verifier checked are the bytes a ledger hashes.
 */
export function isCanonicalXrplSignedBlob(signedBlob: unknown): boolean {
  const decoded = decodeXrplSignedBlob(signedBlob);
  if (decoded === undefined) return false;
  try {
    return encode(decoded as unknown as Transaction) === signedBlob;
  } catch {
    return false;
  }
}

/** The ledger's transaction id of a signed blob (SHA-512Half over `TXN\0` and the blob), or `undefined`. */
export function xrplSignedBlobHash(signedBlob: unknown): string | undefined {
  if (!isXrplSignedBlob(signedBlob)) return undefined;
  try {
    return hashes.hashSignedTx(signedBlob);
  } catch {
    return undefined;
  }
}

/**
 * PAY-03: whether a signed blob was signed by exactly the pinned key — its
 * `SigningPubKey` is the pinned key, and its `TxnSignature` verifies under it
 * over the blob's own signing encoding. Total; anything that does not decode
 * or verify is `false`. Used together with a closed transaction type's own
 * verifier, which proves *what* was signed; this proves *who* signed it.
 *
 * Moved from the PAY-02 codec by substitution (G3); its behavior is unchanged
 * (`xrpl-codec-signature-preservation.test.ts`).
 */
export function signedByPinnedKey(signedBlob: string, signingPublicKey: string): boolean {
  if (!isXrplSigningPublicKey(signingPublicKey) || !SIGNED_BLOB.test(signedBlob)) return false;
  try {
    const decoded = decode(signedBlob) as Record<string, unknown>;
    if (decoded['SigningPubKey'] !== signingPublicKey) return false;
    if (typeof decoded['TxnSignature'] !== 'string' || decoded['Signers'] !== undefined) return false;
    return verifySignature(signedBlob, signingPublicKey);
  } catch {
    return false;
  }
}
