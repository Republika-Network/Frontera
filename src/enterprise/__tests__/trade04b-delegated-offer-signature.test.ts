import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { DELEGATED_OFFER_SIGNER_PROTOCOL, DELEGATED_OFFER_VERIFICATION_FAILURES, verifySignedDelegatedOffer, type DelegatedOfferVerificationFailure, type PreparedDelegatedOffer } from '../xrpl-trade-rail/index.js';
import { createReferenceDelegatedOfferSignerService } from '../xrpl-trade-rail/reference/reference-delegated-offer-signer.js';
import { signedByPinnedKey, xrplSingleSigningEncoding } from '../../features/xrpl-transport/xrpl-signature.js';
import { AUDIT, blobHash, decodeBlob, encodeFields, offerWorld, signingEncoding, testAccount, testDelegate, vectorWorld, type OfferWorld } from './trade04b-xrpl-fixture.js';

/**
 * TRADE-04B — offline cryptographic qualification of delegated OfferCreate
 * signing with the installed SDK (xrpl 5.3.0, ripple-binary-codec 2.11.0),
 * and adversarial matrix C.
 *
 * Positive vectors are produced by the **reference signer** (the real
 * signing path, in process, no socket) and verified by the Host-side
 * verifier; negative vectors are built with the SDK in the fixture. Real
 * signatures throughout — no verification is mocked. Both key algorithms the
 * ledger accepts are qualified: ed25519 and secp256k1.
 */

const CREDENTIAL = 'trade04b-signature-credential-0123456789';

function referenceSign(world: OfferWorld, prepared: PreparedDelegatedOffer): { readonly blob: string; readonly hash: string } {
  const service = createReferenceDelegatedOfferSignerService({ signerId: 'ref-sig', network: 'xrp-ledger-testnet', credential: CREDENTIAL, keys: [{ ownerAccount: world.owner, delegateSeed: world.delegate.seed }], maximumFeeDrops: '1000' });
  const body = { protocol: DELEGATED_OFFER_SIGNER_PROTOCOL, signerId: 'ref-sig', requestId: 'c3'.repeat(32), network: 'xrp-ledger-testnet', ownerAccount: world.owner, delegateAccount: world.delegate.address, transaction: prepared, audit: AUDIT };
  const answer = service.answer({ method: 'POST', path: '/v1/sign/xrpl-delegated-offer', authorization: `Bearer ${CREDENTIAL}`, contentType: 'application/json', body: Buffer.from(JSON.stringify(body)) });
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  const { signedTransaction, hash } = answer.body as { signedTransaction: string; hash: string };
  return { blob: signedTransaction, hash };
}

const failure = (world: OfferWorld, prepared: PreparedDelegatedOffer, blob: string, hash: string): DelegatedOfferVerificationFailure | 'VERIFIED' => {
  const result = verifySignedDelegatedOffer({ prepared, pair: world.pair, signedTransaction: blob, hash });
  return result.verified ? 'VERIFIED' : result.failure;
};

/** Re-serialize a decoded blob with one field changed (the signature is kept: it no longer covers the bytes). */
const tamper = (blob: string, change: (fields: Record<string, unknown>) => void): string => {
  const fields = decodeBlob(blob);
  change(fields);
  return encodeFields(fields);
};

for (const algorithm of ['ed25519', 'secp256k1'] as const) {
  describe(`TRADE-04B — SDK characterization of delegated signing (${algorithm})`, () => {
    const world = offerWorld(algorithm);
    const prepared = world.offer({ Expiration: 800_000_000 });

    it('Wallet.sign single-signs a delegated OfferCreate as the delegate: SigningPubKey is the delegate key, Delegate is a signing field, Account stays the owner', () => {
      const { blob, hash } = referenceSign(world, prepared);
      const decoded = decodeBlob(blob);
      assert.equal(decoded['Account'], world.owner);
      assert.equal(decoded['Delegate'], world.delegate.address);
      assert.equal(decoded['SigningPubKey'], world.delegate.publicKey);
      assert.equal(decoded['Signers'], undefined);
      assert.deepEqual(Object.keys(decoded).sort(), ['Account', 'Delegate', 'Expiration', 'Fee', 'Flags', 'LastLedgerSequence', 'Sequence', 'SigningPubKey', 'TakerGets', 'TakerPays', 'TransactionType', 'TxnSignature']);
      assert.equal(blobHash(blob), hash);
      // The signing preimage covers Delegate: removing it changes the signed bytes.
      const withDelegate = signingEncoding({ ...prepared, SigningPubKey: world.delegate.publicKey });
      const { Delegate: _d, ...withoutDelegate } = prepared;
      assert.notEqual(withDelegate, signingEncoding({ ...withoutDelegate, SigningPubKey: world.delegate.publicKey }));
      assert.equal(signingEncoding(decoded), withDelegate);
      assert.equal(xrplSingleSigningEncoding(decoded), withDelegate, 'the shared primitive computes the same preimage as the SDK');
      assert.equal(algorithm === 'ed25519' ? world.delegate.publicKey.startsWith('ED') : /^0[23]/.test(world.delegate.publicKey), true);
    });

    it('positive vector: the reference signer’s blob verifies under the pinned delegate key, with its own hash', () => {
      const { blob, hash } = referenceSign(world, prepared);
      assert.equal(failure(world, prepared, blob, hash), 'VERIFIED');
      assert.equal(signedByPinnedKey(blob, world.delegate.publicKey), true);
    });

    it('signing is deterministic for a fixed key and transaction (RFC 8032 / RFC 6979): the same request gives the same blob', () => {
      assert.equal(referenceSign(world, prepared).blob, referenceSign(world, prepared).blob);
    });
  });
}

/**
 * Pinned, reproducible vectors (doc §19). Keys from fixed entropy (never
 * funded); the expected values were computed with the SDK directly, outside
 * this code, and are compared here against the reference signer's output.
 * Owner rMfcHpRTwL75cGfVHJJVAwzKp78rkPGocG, issuer rpTGWAKD3mCJqEihErL7gBuz1UCAgBHkfR;
 * offer: give 25 XRP, receive 12.5 USD, tfSell, Sequence 41, Fee 12, LLS 1020, Expiration 800000000.
 */
const PINNED_VECTORS = [
  { algorithm: 'ed25519', delegate: 'rPoY6dFb3vdEX8cafRWF9PwuAc57SLPQKZ', publicKey: 'ED8243B3B1A523ECDF8B54A3912A6A46E005A5821B2E2F79EA1756DC988A9A6F51', hash: '5764C9BCCAD35080BC34303E63207502EB037A1711E891251D80635C81726DF3', bytes: 236 },
  { algorithm: 'secp256k1', delegate: 'rDLjMFbPpGL2qQMRJjVmhXvpB3cjhmqJCr', publicKey: '03820957B8A49B43FA7F9A255354245192BF4DF0AB7A72B114156DB4990FC0F49E', hash: '80CFE8A620BECA98E5B946123507D0DA43431A121EEF0EBD601A0F6F0D59AD97', bytes: 243 },
] as const;

describe('TRADE-04B — pinned cryptographic vectors', () => {
  for (const vector of PINNED_VECTORS) {
    it(`${vector.algorithm}: the reference signer reproduces the pinned blob hash, and the Host verifies it`, () => {
      const world = vectorWorld(vector.algorithm);
      assert.equal(world.owner, 'rMfcHpRTwL75cGfVHJJVAwzKp78rkPGocG');
      assert.equal(world.issuer, 'rpTGWAKD3mCJqEihErL7gBuz1UCAgBHkfR');
      assert.equal(world.delegate.address, vector.delegate);
      assert.equal(world.delegate.publicKey, vector.publicKey);
      const prepared = world.offer({ Expiration: 800_000_000 });
      const { blob, hash } = referenceSign(world, prepared);
      assert.equal(hash, vector.hash);
      assert.equal(blob.length / 2, vector.bytes);
      assert.equal(failure(world, prepared, blob, hash), 'VERIFIED');
      assert.ok(signingEncoding({ ...prepared, SigningPubKey: vector.publicKey }).startsWith('53545800120007220008000024000000292A2FAF'), 'STX\\0 prefix, OfferCreate, tfSell, Sequence 41, Expiration');
    });
  }
});

describe('TRADE-04B C — signature integrity: every substitution is detected', () => {
  const world = offerWorld();
  const prepared = world.offer({ Expiration: 800_000_000 });
  const { blob, hash } = referenceSign(world, prepared);
  const other = testAccount();

  it('control: the untouched blob verifies', () => assert.equal(failure(world, prepared, blob, hash), 'VERIFIED'));

  const changed: readonly [string, (fields: Record<string, unknown>) => void, DelegatedOfferVerificationFailure][] = [
    ['changed amount (TakerGets drops)', (f) => (f['TakerGets'] = '25000001'), 'TRANSACTION_MISMATCH'],
    ['changed amount (TakerPays value)', (f) => (f['TakerPays'] = { ...(f['TakerPays'] as object), value: '12.6' }), 'TRANSACTION_MISMATCH'],
    ['changed issuer', (f) => (f['TakerPays'] = { ...(f['TakerPays'] as object), issuer: other }), 'TRANSACTION_MISMATCH'],
    ['changed currency', (f) => (f['TakerPays'] = { ...(f['TakerPays'] as object), currency: 'EUR' }), 'TRANSACTION_MISMATCH'],
    ['swapped TakerGets and TakerPays', (f) => ([f['TakerGets'], f['TakerPays']] = [f['TakerPays'], f['TakerGets']]), 'TRANSACTION_MISMATCH'],
    ['changed flags', (f) => (f['Flags'] = 0), 'TRANSACTION_MISMATCH'],
    ['changed expiration', (f) => (f['Expiration'] = 800_000_001), 'TRANSACTION_MISMATCH'],
    ['changed owner', (f) => (f['Account'] = other), 'OWNER_MISMATCH'],
    ['changed delegate', (f) => (f['Delegate'] = other), 'DELEGATE_MISMATCH'],
    ['changed Sequence', (f) => (f['Sequence'] = 42), 'TRANSACTION_MISMATCH'],
    ['changed Fee', (f) => (f['Fee'] = '13'), 'TRANSACTION_MISMATCH'],
    ['changed LastLedgerSequence', (f) => (f['LastLedgerSequence'] = 1_021), 'TRANSACTION_MISMATCH'],
    ['changed transaction type', (f) => (f['TransactionType'] = 'OfferCancel'), 'TRANSACTION_TYPE_MISMATCH'],
    ['added unsigned field (Memos)', (f) => (f['Memos'] = [{ Memo: { MemoData: 'AA' } }]), 'FIELD_SET_MISMATCH'],
    ['added signing field (SourceTag)', (f) => (f['SourceTag'] = 7), 'FIELD_SET_MISMATCH'],
    ['added non-signing field (Signers)', (f) => (f['Signers'] = [{ Signer: { Account: other, SigningPubKey: world.delegate.publicKey, TxnSignature: 'AB' } }]), 'FIELD_SET_MISMATCH'],
    ['removed field (Expiration)', (f) => delete f['Expiration'], 'FIELD_SET_MISMATCH'],
    ['replaced public key', (f) => (f['SigningPubKey'] = testDelegate().publicKey), 'SIGNING_KEY_MISMATCH'],
  ];
  for (const [name, change, expected] of changed) {
    it(`detects: ${name} → ${expected}`, () => {
      const forged = tamper(blob, change);
      assert.equal(failure(world, prepared, forged, blobHash(forged)), expected);
    });
  }

  it('detects: wrong public key — a real signature by another delegate key over the same transaction', () => {
    const intruder = testDelegate();
    const signed = intruder.sign({ ...prepared });
    assert.equal(failure(world, prepared, signed.blob, signed.hash), 'SIGNING_KEY_MISMATCH');
  });

  it('detects: wrong signature — the pinned key’s field, another key’s signature', () => {
    const intruder = testDelegate();
    const theirs = decodeBlob(intruder.sign({ ...prepared }).blob)['TxnSignature'];
    const forged = tamper(blob, (f) => (f['TxnSignature'] = theirs));
    assert.equal(failure(world, prepared, forged, blobHash(forged)), 'SIGNATURE_INVALID');
  });

  it('detects: a flipped signature byte', () => {
    const forged = tamper(blob, (f) => {
      const signature = f['TxnSignature'] as string;
      f['TxnSignature'] = `${signature.slice(0, -2)}${signature.endsWith('00') ? '01' : '00'}`;
    });
    assert.equal(failure(world, prepared, forged, blobHash(forged)), 'SIGNATURE_INVALID');
  });

  it('detects: a signature over a different transaction, transplanted', () => {
    const differentSignature = decodeBlob(world.delegate.sign({ ...prepared, Sequence: 99 }).blob)['TxnSignature'];
    const forged = tamper(blob, (f) => (f['TxnSignature'] = differentSignature));
    assert.equal(failure(world, prepared, forged, blobHash(forged)), 'SIGNATURE_INVALID');
  });

  it('detects: a signature over an incorrect preimage — the same offer without Delegate (a non-delegated signature)', () => {
    const { Delegate: _d, ...undelegated } = prepared;
    const wrongPreimage = decodeBlob(world.delegate.sign({ ...undelegated }).blob)['TxnSignature'];
    const forged = tamper(blob, (f) => (f['TxnSignature'] = wrongPreimage));
    assert.equal(failure(world, prepared, forged, blobHash(forged)), 'SIGNATURE_INVALID');
  });

  it('detects: a signature over the multisigning preimage, presented as a single signature', () => {
    const multi = decodeBlob(world.delegate.multisign({ ...prepared }).blob);
    const multiSignature = ((multi['Signers'] as { Signer: { TxnSignature: string } }[])[0] as { Signer: { TxnSignature: string } }).Signer.TxnSignature;
    const forged = tamper(blob, (f) => (f['TxnSignature'] = multiSignature));
    assert.equal(failure(world, prepared, forged, blobHash(forged)), 'SIGNATURE_INVALID');
  });

  it('detects: a multisigned blob (empty SigningPubKey and a Signers array)', () => {
    const multi = world.delegate.multisign({ ...prepared });
    assert.equal(failure(world, prepared, multi.blob, multi.hash), 'FIELD_SET_MISMATCH');
  });

  it('detects: an incorrect reported hash, and a malformed one', () => {
    assert.equal(failure(world, prepared, blob, 'AB'.repeat(32)), 'HASH_MISMATCH');
    assert.equal(failure(world, prepared, blob, hash.toLowerCase()), 'HASH_MALFORMED');
    assert.equal(failure(world, prepared, blob, undefined as unknown as string), 'HASH_MALFORMED');
  });

  it('detects: malformed, oversized and lower-case blobs before decoding', () => {
    assert.equal(failure(world, prepared, blob.toLowerCase(), hash), 'BLOB_MALFORMED');
    assert.equal(failure(world, prepared, `${blob}0`, hash), 'BLOB_MALFORMED');
    assert.equal(failure(world, prepared, 'AB'.repeat(4097), hash), 'BLOB_MALFORMED');
    assert.equal(failure(world, prepared, 'AB'.repeat(16), hash), 'BLOB_MALFORMED');
    assert.equal(failure(world, prepared, 42 as unknown as string, hash), 'BLOB_MALFORMED');
  });

  it('detects: a blob that does not decode', () => {
    assert.equal(failure(world, prepared, 'FF'.repeat(64), hash), 'BLOB_UNDECODABLE');
  });

  it('detects: unusual encoding — a valid signature in a blob whose fields are out of canonical order (or with trailing bytes)', () => {
    // TransactionType (12 0007) | Flags (22 xxxxxxxx) | Sequence (24 xxxxxxxx) … — swap the Flags and Sequence fields.
    assert.ok(blob.startsWith('12000722'));
    const flags = blob.slice(6, 16);
    const sequence = blob.slice(16, 26);
    assert.ok(sequence.startsWith('24'));
    const reordered = `120007${sequence}${flags}${blob.slice(26)}`;
    assert.notEqual(failure(world, prepared, reordered, blobHash(reordered)), 'VERIFIED');
    const decodes = (() => {
      try {
        decodeBlob(reordered);
        return true;
      } catch {
        return false;
      }
    })();
    assert.equal(failure(world, prepared, reordered, blobHash(reordered)), decodes ? 'BLOB_NOT_CANONICAL' : 'BLOB_UNDECODABLE');
    const trailing = `${blob}E1`;
    assert.notEqual(failure(world, prepared, trailing, blobHash(trailing)), 'VERIFIED');
  });

  it('refuses a prepared transaction that is not the closed contract, or not for the pinned pair, before looking at the blob', () => {
    assert.equal(failure(world, { ...prepared, Memos: [] } as unknown as PreparedDelegatedOffer, blob, hash), 'PREPARED_INVALID');
    const elsewhere = offerWorld();
    assert.equal(verifySignedDelegatedOffer({ prepared, pair: elsewhere.pair, signedTransaction: blob, hash }).verified, false);
    assert.equal((verifySignedDelegatedOffer({ prepared, pair: elsewhere.pair, signedTransaction: blob, hash }) as { failure: string }).failure, 'PAIR_MISMATCH');
  });

  it('the failure vocabulary is closed and every code above is in it', () => {
    assert.equal(new Set(DELEGATED_OFFER_VERIFICATION_FAILURES).size, DELEGATED_OFFER_VERIFICATION_FAILURES.length);
    for (const [, , code] of changed) assert.ok(DELEGATED_OFFER_VERIFICATION_FAILURES.includes(code));
  });
});

describe('TRADE-04B — the verifier is total under generated substitutions', () => {
  it('every single-field change of 200 generated offers is refused, and every original verifies', () => {
    const world = offerWorld();
    let refused = 0;
    for (let index = 0; index < 40; index += 1) {
      const prepared = world.offer({ Sequence: 100 + index, LastLedgerSequence: 2_000 + index, TakerGets: String(1_000_000 + index * 7), TakerPays: { currency: 'USD', issuer: world.issuer, value: `${index + 1}.25` } });
      const { blob, hash } = world.delegate.sign({ ...prepared });
      assert.equal(failure(world, prepared, blob, hash), 'VERIFIED');
      for (const change of [(f: Record<string, unknown>) => (f['Sequence'] = (f['Sequence'] as number) + 1), (f: Record<string, unknown>) => (f['Fee'] = '11'), (f: Record<string, unknown>) => (f['Flags'] = 0x0001_0000), (f: Record<string, unknown>) => (f['LastLedgerSequence'] = 1), (f: Record<string, unknown>) => (f['TakerGets'] = '1')]) {
        const forged = tamper(blob, change);
        assert.notEqual(failure(world, prepared, forged, blobHash(forged)), 'VERIFIED');
        refused += 1;
      }
    }
    assert.equal(refused, 200);
  });
});
