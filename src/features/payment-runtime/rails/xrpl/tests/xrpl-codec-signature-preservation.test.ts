import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ECDSA, Wallet, decode, encode, encodeForSigning, hashes, verifySignature, type Transaction } from 'xrpl';

import { isXrplSigningPublicKey, isXrplTransactionHash, signedByPinnedKey, signedPaymentMatches, type XrplPreparedPayment } from '../index.js';
import { signedByPinnedKey as sharedSignedByPinnedKey } from '../../../../xrpl-transport/xrpl-signature.js';
import { ISSUER, OTHER_SOURCE, TREASURY, VENDOR } from './xrpl-test-fixtures.js';

/**
 * TRADE-04B — approval gate G3, characterized: moving the PAY-02 codec's SDK
 * calls and `signedByPinnedKey` into the shared transport's codec file changed
 * **nothing** Payment decides.
 *
 * The two functions as they were before the move (`main @ 11db917c`,
 * `src/features/payment-runtime/rails/xrpl/xrpl-codec.ts`) are frozen below,
 * verbatim but for their names, and compared with the shipped functions over
 * real signed Payments, every single-field tamper, foreign-key signatures,
 * multisigned blobs, transplanted signatures, malformed input and a prepared
 * payment whose own fields throw. Every answer must be identical.
 */

const SIGNED_BLOB = /^(?:[0-9A-F]{2}){32,4096}$/;

// ── Frozen pre-G3 implementation (verbatim) ──────────────────────────────────
function frozenSignedPaymentMatches(prepared: XrplPreparedPayment, signed: { readonly signedTransaction: unknown; readonly hash: unknown }): boolean {
  const { signedTransaction, hash } = signed;
  if (typeof signedTransaction !== 'string' || !SIGNED_BLOB.test(signedTransaction) || !isXrplTransactionHash(hash)) return false;
  try {
    const decoded = decode(signedTransaction) as Record<string, unknown>;
    const signingPubKey = decoded['SigningPubKey'];
    if (typeof signingPubKey !== 'string' || signingPubKey.length === 0) return false;
    const txnSignature = decoded['TxnSignature'];
    if (typeof txnSignature !== 'string' || txnSignature.length === 0) return false;
    const allowed = new Set([...Object.keys(prepared), 'SigningPubKey', 'TxnSignature']);
    if (Object.keys(decoded).some((field) => !allowed.has(field))) return false;
    if (encodeForSigning(decoded as unknown as Transaction) !== encodeForSigning({ ...prepared, SigningPubKey: signingPubKey } as unknown as Transaction)) return false;
    return hashes.hashSignedTx(signedTransaction) === hash;
  } catch {
    return false;
  }
}

function frozenSignedByPinnedKey(signedTransaction: string, signingPublicKey: string): boolean {
  if (!isXrplSigningPublicKey(signingPublicKey) || !SIGNED_BLOB.test(signedTransaction)) return false;
  try {
    const decoded = decode(signedTransaction) as Record<string, unknown>;
    if (decoded['SigningPubKey'] !== signingPublicKey) return false;
    if (typeof decoded['TxnSignature'] !== 'string' || decoded['Signers'] !== undefined) return false;
    return verifySignature(signedTransaction, signingPublicKey);
  } catch {
    return false;
  }
}
// ─────────────────────────────────────────────────────────────────────────────

const RLUSD = '524C555344000000000000000000000000000000';

function payment(index: number, overrides: Partial<Record<keyof XrplPreparedPayment, unknown>> = {}): XrplPreparedPayment {
  return {
    TransactionType: 'Payment',
    Account: TREASURY.classicAddress,
    Destination: VENDOR.classicAddress,
    ...(index % 3 === 0 ? { DestinationTag: index } : {}),
    Amount: { currency: RLUSD, issuer: ISSUER.classicAddress, value: `${index + 1}.5` },
    Flags: 0,
    LastLedgerSequence: 5_000 + index,
    Sequence: 10 + index,
    Fee: String(10 + (index % 5)),
    ...overrides,
  } as XrplPreparedPayment;
}

const sign = (wallet: Wallet, tx: XrplPreparedPayment): { signedTransaction: string; hash: string } => {
  const { tx_blob, hash } = wallet.sign({ ...tx, Amount: { ...tx.Amount } } as Parameters<typeof wallet.sign>[0]);
  return { signedTransaction: tx_blob, hash };
};

const reencode = (blob: string, change: (fields: Record<string, unknown>) => void): string => {
  const fields = decode(blob) as Record<string, unknown>;
  change(fields);
  return encode(fields as unknown as Transaction);
};

/** Every comparison: the shipped functions answer exactly what the frozen ones answer. */
function same(prepared: XrplPreparedPayment, signed: { readonly signedTransaction: unknown; readonly hash: unknown }, key: string): { readonly matches: boolean; readonly pinned: boolean } {
  const matches = signedPaymentMatches(prepared, signed);
  assert.equal(matches, frozenSignedPaymentMatches(prepared, signed), 'signedPaymentMatches diverged');
  const blob = signed.signedTransaction as string;
  const pinned = signedByPinnedKey(blob, key);
  assert.equal(pinned, frozenSignedByPinnedKey(blob, key), 'signedByPinnedKey diverged');
  return { matches, pinned };
}

describe('TRADE-04B G3 — Payment signature behavior is identical after the substitution', () => {
  it('signedByPinnedKey is re-exported by the PAY-02 codec as the same function object', () => {
    assert.equal(signedByPinnedKey, sharedSignedByPinnedKey);
  });

  it('historical signed-Payment vectors: 60 real signatures (ed25519 and secp256k1 sources) verify identically', () => {
    let accepted = 0;
    for (let index = 0; index < 60; index += 1) {
      // Deterministic keys from fixed entropy (no seed literal, never funded), alternating the two algorithms.
      const wallet = Wallet.fromEntropy(new Uint8Array(16).fill(40 + index), { algorithm: index % 2 === 0 ? ECDSA.ed25519 : ECDSA.secp256k1 });
      const prepared = payment(index, { Account: wallet.classicAddress });
      const signed = sign(wallet, prepared);
      const { matches, pinned } = same(prepared, signed, wallet.publicKey);
      assert.equal(matches && pinned, true);
      accepted += 1;
    }
    assert.equal(accepted, 60);
  });

  it('every single-field tamper, foreign key, multisignature and transplant is refused identically', () => {
    const prepared = payment(7);
    const signed = sign(TREASURY, prepared);
    const other = sign(OTHER_SOURCE, { ...prepared, Account: OTHER_SOURCE.classicAddress });
    const otherSignature = (decode(other.signedTransaction) as Record<string, unknown>)['TxnSignature'];
    const multi = TREASURY.sign({ ...prepared, Amount: { ...prepared.Amount } } as Parameters<typeof TREASURY.sign>[0], true);
    const variants: readonly { readonly signedTransaction: unknown; readonly hash: unknown }[] = [
      ...[
        (f: Record<string, unknown>) => (f['Destination'] = OTHER_SOURCE.classicAddress),
        (f: Record<string, unknown>) => (f['Amount'] = { ...(f['Amount'] as object), value: '9' }),
        (f: Record<string, unknown>) => (f['Amount'] = { ...(f['Amount'] as object), issuer: VENDOR.classicAddress }),
        (f: Record<string, unknown>) => (f['Fee'] = '999'),
        (f: Record<string, unknown>) => (f['Sequence'] = 1),
        (f: Record<string, unknown>) => (f['LastLedgerSequence'] = 1),
        (f: Record<string, unknown>) => (f['Flags'] = 131072),
        (f: Record<string, unknown>) => (f['Memos'] = [{ Memo: { MemoData: 'AA' } }]),
        (f: Record<string, unknown>) => (f['SendMax'] = '1'),
        (f: Record<string, unknown>) => (f['TxnSignature'] = otherSignature),
        (f: Record<string, unknown>) => (f['SigningPubKey'] = OTHER_SOURCE.publicKey),
        (f: Record<string, unknown>) => delete f['TxnSignature'],
      ].map((change) => {
        const blob = reencode(signed.signedTransaction, change);
        return { signedTransaction: blob, hash: hashes.hashSignedTx(blob) };
      }),
      other,
      { signedTransaction: multi.tx_blob, hash: multi.hash },
      { signedTransaction: signed.signedTransaction, hash: 'AB'.repeat(32) },
      { signedTransaction: signed.signedTransaction.toLowerCase(), hash: signed.hash },
      { signedTransaction: 'FF'.repeat(64), hash: signed.hash },
      { signedTransaction: 'AB'.repeat(4097), hash: signed.hash },
      { signedTransaction: 42, hash: signed.hash },
      { signedTransaction: signed.signedTransaction, hash: undefined },
    ];
    // `signedPaymentMatches` proves *what* was signed and `signedByPinnedKey` *who* signed it — the rail requires both,
    // so a transplanted signature or swapped key passes the first and fails the second. Each answer is compared above.
    for (const variant of variants) {
      const { matches, pinned } = same(prepared, variant, TREASURY.publicKey);
      assert.equal(matches && pinned, false);
    }
    same(prepared, signed, 'not-a-key');
    same(prepared, signed, OTHER_SOURCE.publicKey);
  });

  it('a prepared payment whose own field throws is refused, by both, without throwing', () => {
    const prepared = payment(3);
    const signed = sign(TREASURY, prepared);
    const hostile = { ...prepared } as Record<string, unknown>;
    Object.defineProperty(hostile, 'Fee', { enumerable: true, get: () => { throw new Error('boom'); } });
    assert.equal(signedPaymentMatches(hostile as unknown as XrplPreparedPayment, signed), false);
    assert.equal(frozenSignedPaymentMatches(hostile as unknown as XrplPreparedPayment, signed), false);
    const unencodable = { ...prepared, Amount: { currency: 'not a currency code', issuer: ISSUER.classicAddress, value: '1' } } as unknown as XrplPreparedPayment;
    same(unencodable, signed, TREASURY.publicKey);
  });
});
