import { ECDSA, Wallet, decode, encode, encodeForSigning, hashes } from 'xrpl';

import type { DelegatedOfferAuditReference, DelegatedOfferSignerPair, PreparedDelegatedOffer } from '../xrpl-trade-rail/index.js';

/**
 * TRADE-04B qualification fixtures — test-only, offline.
 *
 * Every key here is generated **at run time** with the SDK and lives only in
 * this process's memory for the duration of a test: no seed, private key or
 * secret is ever written to the repository, a file or a log. Generated
 * delegates are never funded, never on any ledger, and nothing here opens a
 * connection. Addresses that only need to be *valid* (owners, issuers) are
 * generated the same way.
 *
 * The SDK is used here — and only here, among the TRADE-04B tests — to build
 * the **negative** vectors the reference signer refuses to produce by design:
 * blobs signed by another key, over another transaction, multisigned, with a
 * forged or transplanted signature, or re-encoded out of canonical order.
 */

export interface TestDelegate {
  readonly address: string;
  readonly publicKey: string;
  /** In memory only; handed to an in-process reference signer, never persisted. */
  readonly seed: string;
  sign(transaction: Record<string, unknown>): { readonly blob: string; readonly hash: string };
  multisign(transaction: Record<string, unknown>): { readonly blob: string; readonly hash: string };
}

export function testDelegate(algorithm: 'ed25519' | 'secp256k1' = 'ed25519'): TestDelegate {
  return delegateOf(Wallet.generate(algorithm === 'ed25519' ? ECDSA.ed25519 : ECDSA.secp256k1));
}

/**
 * A **deterministic** delegate for pinned, reproducible vectors: derived from
 * fixed entropy exactly as PAY-02's `testWallet` does — no seed literal in
 * source, never funded on any network. Anyone can re-derive it, which is the
 * point of a published test vector and the reason it must never hold value.
 */
export function vectorDelegate(label: number, algorithm: 'ed25519' | 'secp256k1'): TestDelegate {
  return delegateOf(Wallet.fromEntropy(new Uint8Array(16).fill(label), { algorithm: algorithm === 'ed25519' ? ECDSA.ed25519 : ECDSA.secp256k1 }));
}

function delegateOf(wallet: Wallet): TestDelegate {
  return Object.freeze({
    address: wallet.classicAddress,
    publicKey: wallet.publicKey,
    seed: wallet.seed as string,
    sign: (transaction: Record<string, unknown>) => {
      const signed = wallet.sign(transaction as Parameters<Wallet['sign']>[0]);
      return { blob: signed.tx_blob, hash: signed.hash };
    },
    multisign: (transaction: Record<string, unknown>) => {
      const signed = wallet.sign(transaction as Parameters<Wallet['sign']>[0], true);
      return { blob: signed.tx_blob, hash: signed.hash };
    },
  });
}

/** A fresh, valid classic address nobody holds a key for in this test (the key is discarded). */
export function testAccount(): string {
  return Wallet.generate().classicAddress;
}

export const decodeBlob = (blob: string): Record<string, unknown> => decode(blob) as Record<string, unknown>;
export const encodeFields = (fields: Record<string, unknown>): string => encode(fields as Parameters<typeof encode>[0]);
export const signingEncoding = (fields: Record<string, unknown>): string => encodeForSigning(fields as Parameters<typeof encodeForSigning>[0]);
export const blobHash = (blob: string): string => hashes.hashSignedTx(blob);

export const AUDIT: DelegatedOfferAuditReference = Object.freeze({ executionId: 'exec-trade04b-0001', grantRef: 'grant-trade04b-0001', grantDigest: `sha256:${'ab'.repeat(32)}` });

/** One world: an owner, a delegate (with its key), an issuer, the pinned pair and a prepared offer builder. */
export interface OfferWorld {
  readonly owner: string;
  readonly issuer: string;
  readonly delegate: TestDelegate;
  readonly pair: DelegatedOfferSignerPair;
  offer(overrides?: Partial<Record<keyof PreparedDelegatedOffer, unknown>>): PreparedDelegatedOffer;
}

export function offerWorld(algorithm: 'ed25519' | 'secp256k1' = 'ed25519'): OfferWorld {
  return worldOf(testAccount(), testAccount(), testDelegate(algorithm));
}

/** The pinned-vector world: owner, issuer and delegate all from fixed entropy (labels 0x61, 0x62, and 0x63 / 0x64). */
export function vectorWorld(algorithm: 'ed25519' | 'secp256k1'): OfferWorld {
  return worldOf(vectorDelegate(0x61, 'ed25519').address, vectorDelegate(0x62, 'ed25519').address, vectorDelegate(algorithm === 'ed25519' ? 0x63 : 0x64, algorithm));
}

function worldOf(owner: string, issuer: string, delegate: TestDelegate): OfferWorld {
  const pair = Object.freeze({ ownerAccount: owner, delegateAccount: delegate.address, signingPublicKey: delegate.publicKey });
  return Object.freeze({
    owner,
    issuer,
    delegate,
    pair,
    offer: (overrides = {}) =>
      ({
        TransactionType: 'OfferCreate',
        Account: owner,
        Delegate: delegate.address,
        TakerGets: '25000000',
        TakerPays: { currency: 'USD', issuer, value: '12.5' },
        Flags: 0x0008_0000,
        Sequence: 41,
        Fee: '12',
        LastLedgerSequence: 1_020,
        ...overrides,
      }) as PreparedDelegatedOffer,
  });
}
