import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { DELEGATED_OFFER_SIGNER_OPERATION, DELEGATED_OFFER_SIGNER_PROTOCOL, type DelegatedOfferSignerTransport, type PreparedDelegatedOffer } from '../xrpl-trade-rail/index.js';
import { authorizedInput, blobHash, decodeBlob, encodeFields, offerWorld } from './trade04b-xrpl-fixture.js';
import { s1ReferenceOptions, signerAuthorization, tempCapabilityLedger } from './trade04c-s1-capability-fixture.js';

/**
 * TRADE-04B mutation qualification (AC-14), in TRADE-03's manner: each
 * load-bearing fail-closed check is removed from the **compiled** module, the
 * mutant is loaded beside the original, and the guarding property must then
 * fail. A guard that still holds against a mutant is not guarding that check.
 * The original module is never modified; every mutant file is removed after
 * use.
 *
 * Checks that are defence in depth — removing one alone leaves a later check
 * that still refuses (e.g. the `SigningPubKey` pin, which `signedByPinnedKey`
 * repeats; the field-set closure, which the signing-encoding equality and the
 * `Signers` refusal repeat) — are not listed: their mutants survive *by
 * design*, and the signature tests pin their individual failure codes.
 */

const EDGE_DIR = join(__dirname, '..', 'xrpl-trade-rail');
const load = createRequire(__filename);

interface Mutant<M> {
  readonly id: string;
  readonly file: string;
  readonly search: string;
  readonly replace: string;
  /** Resolves `true` when the safety property holds for this module. */
  readonly guard: (module: M) => boolean | Promise<boolean>;
}

async function qualify<M>(mutant: Mutant<M>): Promise<void> {
  const path = join(EDGE_DIR, mutant.file);
  const source = readFileSync(path, 'utf8');
  assert.equal(source.split(mutant.search).length - 1, 1, `${mutant.id}: the mutation site must occur exactly once in ${mutant.file}`);
  const mutantPath = path.replace(/\.js$/, `.mutant-${mutant.id}.js`);
  writeFileSync(mutantPath, source.replace(mutant.search, mutant.replace));
  try {
    assert.equal(await mutant.guard(load(path) as M), true, `${mutant.id}: the guard holds for the shipped module`);
    assert.equal(await mutant.guard(load(mutantPath) as M), false, `${mutant.id}: the guard detects the removed check`);
  } finally {
    delete load.cache[load.resolve(mutantPath)];
    rmSync(mutantPath, { force: true });
  }
}

// ── Verification ─────────────────────────────────────────────────────────────

type VerificationModule = typeof import('../xrpl-trade-rail/delegated-offer-verification.js');
const world = offerWorld();
const prepared = world.offer({ Expiration: 800_000_000 });
const genuine = world.delegate.sign({ ...prepared });
const reencode = (change: (fields: Record<string, unknown>) => void): string => {
  const fields = decodeBlob(genuine.blob);
  change(fields);
  return encodeFields(fields);
};
const refuses = (module: VerificationModule, signedTransaction: string, hash: string, against: PreparedDelegatedOffer = prepared): boolean => !module.verifySignedDelegatedOffer({ prepared: against, pair: world.pair, signedTransaction, hash }).verified;

const reordered = `120007${genuine.blob.slice(16, 26)}${genuine.blob.slice(6, 16)}${genuine.blob.slice(26)}`;
const flipped = reencode((f) => {
  const signature = f['TxnSignature'] as string;
  f['TxnSignature'] = `${signature.slice(0, -2)}${signature.endsWith('00') ? '01' : '00'}`;
});
const otherTransaction = world.delegate.sign({ ...prepared, TakerGets: '99000000' });

describe('TRADE-04B mutation — Host-side verification', () => {
  const file = 'delegated-offer-verification.js';
  it('V1: without the canonical-serialization check, a reordered blob (same signature, different bytes and hash) verifies', () =>
    qualify<VerificationModule>({ id: 'v1', file, search: "return refuse('BLOB_NOT_CANONICAL');", replace: ';', guard: (m) => refuses(m, reordered, blobHash(reordered)) }));
  it('V2: without the hash check, a wrong reported hash is accepted', () =>
    qualify<VerificationModule>({ id: 'v2', file, search: "return refuse('HASH_MISMATCH');", replace: ';', guard: (m) => refuses(m, genuine.blob, 'AB'.repeat(32)) }));
  it('V3: without the signature check, a forged signature under the pinned key is accepted', () =>
    qualify<VerificationModule>({ id: 'v3', file, search: "return refuse('SIGNATURE_INVALID');", replace: ';', guard: (m) => refuses(m, flipped, blobHash(flipped)) }));
  it('V4: without the signing-bytes equality, the pinned key’s signature over another transaction is accepted', () =>
    qualify<VerificationModule>({ id: 'v4', file, search: "return refuse('TRANSACTION_MISMATCH');", replace: ';', guard: (m) => refuses(m, otherTransaction.blob, otherTransaction.hash) }));
  it('control: the genuine blob verifies under the shipped module', () => {
    const module = load(join(EDGE_DIR, file)) as VerificationModule;
    assert.equal(refuses(module, genuine.blob, genuine.hash), false);
  });
});

// ── Protocol ─────────────────────────────────────────────────────────────────

type ProtocolModule = typeof import('../xrpl-trade-rail/delegated-offer-protocol.js');
const base = world.offer() as unknown as Record<string, unknown>;

describe('TRADE-04B mutation — the closed protocol', () => {
  const file = 'delegated-offer-protocol.js';
  it('P1: without the owner ≠ delegate rule, a self-delegated OfferCreate parses', () =>
    qualify<ProtocolModule>({ id: 'p1', file, search: " || tx['Account'] === tx['Delegate']", replace: '', guard: (m) => m.parsePreparedDelegatedOffer({ ...base, Delegate: world.owner }) === undefined }));
  it('P2: without the flag mask, tfHybrid parses', () =>
    qualify<ProtocolModule>({ id: 'p2', file, search: ' || (flags & ~exports.DELEGATED_OFFER_ALLOWED_FLAGS) !== 0', replace: '', guard: (m) => m.parsePreparedDelegatedOffer({ ...base, Flags: 0x0010_0000 }) === undefined }));
  it('P3: without the no-normalization rule, a non-canonical issued value parses', () =>
    qualify<ProtocolModule>({ id: 'p3', file, search: " || value !== record['value']", replace: '', guard: (m) => m.parsePreparedDelegatedOffer({ ...base, TakerPays: { currency: 'USD', issuer: world.issuer, value: '12.50' } }) === undefined }));
  it('P4: without the closed field set, a Memo parses', () =>
    qualify<ProtocolModule>({ id: 'p4', file, search: '(!required.includes(key) && !optional.includes(key))', replace: 'false', guard: (m) => m.parsePreparedDelegatedOffer({ ...base, Memos: [{ Memo: { MemoData: 'AA' } }] }) === undefined }));
});

// ── Host-side client ─────────────────────────────────────────────────────────

type ClientModule = typeof import('../xrpl-trade-rail/delegated-offer-signer.js');
const pinned = signerAuthorization();
const identity = {
  protocol: DELEGATED_OFFER_SIGNER_PROTOCOL,
  signerId: 'mut-1',
  operations: [DELEGATED_OFFER_SIGNER_OPERATION],
  network: 'xrp-ledger-testnet',
  pairs: [world.pair],
  authorization: { trustDomain: pinned.trustDomain, organizationId: pinned.organizationId, issuerKeyIds: pinned.issuerKeys.map((key) => key.keyId) },
};
/** TRADE-04C-S1: a signing input with a capability for exactly `transaction`. */
const signing = (transaction: PreparedDelegatedOffer = world.offer()) => authorizedInput(world, transaction, 1_000);
const pin = { signerId: 'mut-1', network: 'xrp-ledger-testnet' as const, pairs: [world.pair] };

/** A transport that signs genuinely (with the test key) and can replay its first answer or advertise an extra pair. */
function transportOf(behavior: { readonly replay?: boolean; readonly extraPair?: boolean }): DelegatedOfferSignerTransport & { signs: number } {
  let first: Record<string, unknown> | undefined;
  const transport = {
    signs: 0,
    identity: async () => (behavior.extraPair ? { ...identity, pairs: [world.pair, offerWorld().pair] } : identity),
    signDelegatedOffer: async (request: { readonly requestId: string; readonly transaction: PreparedDelegatedOffer; readonly authorization: { readonly capability: string } }) => {
      transport.signs += 1;
      const signed = world.delegate.sign({ ...request.transaction });
      const capabilityId = (JSON.parse(request.authorization.capability) as { capabilityId: string }).capabilityId;
      const answer = { protocol: DELEGATED_OFFER_SIGNER_PROTOCOL, signerId: 'mut-1', requestId: request.requestId, capabilityId, ownerAccount: world.owner, delegateAccount: world.delegate.address, signedTransaction: signed.blob, hash: signed.hash };
      if (behavior.replay && first !== undefined) return first;
      first ??= answer;
      return answer;
    },
  };
  return transport;
}
const signerOf = (m: ClientModule, transport: DelegatedOfferSignerTransport) => m.createDelegatedOfferSigner({ transport, pin, timeoutMs: 1_000, maximumFeeDrops: '100', maximumLedgerHorizon: 40, probeIntervalMs: 0 });
const refused = async (promise: Promise<unknown>): Promise<boolean> => promise.then(() => false, () => true);

describe('TRADE-04B mutation — Host-side client', () => {
  const file = 'delegated-offer-signer.js';
  it('C1: without request correlation, a replayed answer for the same transaction is accepted', () =>
    qualify<ClientModule>({
      id: 'c1',
      file,
      search: 'response.requestId !== requestId || ',
      replace: '',
      guard: async (m) => {
        const signer = signerOf(m, transportOf({ replay: true }));
        // The same capability twice (the client does not consume), so only the request id distinguishes the replayed answer.
        const input = signing();
        await signer.signDelegatedOffer(input);
        return refused(signer.signDelegatedOffer(input));
      },
    }));
  it('C2: without exact pin equality, an identity advertising an extra pair is adopted (TOFU)', () =>
    qualify<ClientModule>({ id: 'c2', file, search: 'advertised.size === pinnedPairs.size &&', replace: '', guard: async (m) => (await signerOf(m, transportOf({ extraPair: true })).probe()).state === 'MISMATCH' }));
  it('C3: without the Host fee ceiling, an over-ceiling fee reaches the signer', () =>
    qualify<ClientModule>({
      id: 'c3',
      file,
      search: 'BigInt(transaction.Fee) > maximumFeeDrops',
      replace: 'false',
      guard: async (m) => {
        const transport = transportOf({});
        await refused(signerOf(m, transport).signDelegatedOffer(signing(world.offer({ Fee: '101' }))));
        return transport.signs === 0;
      },
    }));
  it('C4: without the lower LastLedgerSequence bound, an already-expired window is sent for signing', () =>
    qualify<ClientModule>({
      id: 'c4',
      file,
      search: 'transaction.LastLedgerSequence <= validated || ',
      replace: '',
      guard: async (m) => {
        const transport = transportOf({});
        await refused(signerOf(m, transport).signDelegatedOffer(signing(world.offer({ LastLedgerSequence: 1_000 }))));
        return transport.signs === 0;
      },
    }));
});

// ── Reference signer ─────────────────────────────────────────────────────────

type ReferenceModule = typeof import('../xrpl-trade-rail/reference/reference-delegated-offer-signer.js');
const CREDENTIAL = 'trade04b-mutation-credential-0123456789';
const referenceOptions = () => ({ ...s1ReferenceOptions(), signerId: 'mut-ref', network: 'xrp-ledger-testnet' as const, credential: CREDENTIAL, keys: [{ ownerAccount: world.owner, delegateSeed: world.delegate.seed }], maximumFeeDrops: '100' });
/** A fresh capability per post (unless the caller reuses a service and request id on purpose), so each guard isolates one check. */
const post = (m: ReferenceModule, transaction: Record<string, unknown>, requestId = 'ab'.repeat(32), svc = m.createReferenceDelegatedOfferSignerService(referenceOptions())) => {
  const { proposal, authorization } = signing(transaction as unknown as PreparedDelegatedOffer);
  return {
    svc,
    status: svc.answer({
      method: 'POST',
      path: '/v1/sign/xrpl-delegated-offer',
      authorization: `Bearer ${CREDENTIAL}`,
      contentType: 'application/json',
      body: Buffer.from(JSON.stringify({ protocol: DELEGATED_OFFER_SIGNER_PROTOCOL, signerId: 'mut-ref', requestId, network: 'xrp-ledger-testnet', ownerAccount: world.owner, delegateAccount: world.delegate.address, transaction, proposal, authorization })),
    }).status,
  };
};

describe('TRADE-04B mutation — reference signer', () => {
  const file = join('reference', 'reference-delegated-offer-signer.js');
  it('R1: without its fee ceiling, the reference signs an over-ceiling fee', () =>
    qualify<ReferenceModule>({ id: 'r1', file, search: 'BigInt(tx.Fee) > maximumFeeDrops', replace: 'false', guard: (m) => post(m, { ...base, Fee: '101' }).status === 422 }));
  it('R2: without replay refusal, the same request id is signed twice', () =>
    qualify<ReferenceModule>({
      id: 'r2',
      file,
      search: 'seenRequestIds.has(request.requestId)',
      replace: 'false',
      guard: (m) => {
        const first = post(m, base);
        return first.status === 200 && post(m, base, 'ab'.repeat(32), first.svc).status === 409;
      },
    }));
  it('R3: without the loopback check, a non-loopback bind is attempted (TEST-NET-1 address: fails at the socket, never public)', () =>
    qualify<ReferenceModule>({
      id: 'r3',
      file,
      search: 'if (!isReferenceSignerLoopbackHost(host))',
      replace: 'if (false)',
      guard: async (m) => {
        const ledger = await tempCapabilityLedger();
        ledger.ledger.close();
        const { consumption: _unused, ...options } = referenceOptions();
        try {
          const started = await m.startReferenceDelegatedOfferSigner({ ...options, consumptionLedgerPath: ledger.path, host: '192.0.2.1' });
          await started.close();
          return false;
        } catch (error) {
          return /literal loopback/.test((error as Error).message);
        } finally {
          ledger.cleanup();
        }
      },
    }));
});
