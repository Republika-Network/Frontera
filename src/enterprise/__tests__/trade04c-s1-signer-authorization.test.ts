import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  DELEGATED_OFFER_SIGNER_PROTOCOL,
  createDelegatedOfferSigner,
  createHttpDelegatedOfferSignerTransport,
  verifySignedDelegatedOffer,
  DelegatedOfferSignerError,
  type PreparedDelegatedOffer,
} from '../xrpl-trade-rail/index.js';
import { createReferenceDelegatedOfferKeyFile, createReferenceDelegatedOfferSignerService, loadReferenceDelegatedOfferKeyFile, startReferenceDelegatedOfferSigner } from '../xrpl-trade-rail/reference/reference-delegated-offer-signer.js';
import { openReferenceCapabilityLedger } from '../xrpl-trade-rail/reference/reference-capability-ledger.js';
import { AUTHORITY_KEY_A, AUTHORITY_KEY_B, AUTHORITY_KEY_UNTRUSTED } from './authority-authenticity-fixture.js';
import { delegateFromSeed, offerWorld, testAccount, worldWith, type OfferWorld } from './trade04b-xrpl-fixture.js';
import { S1_ORGANIZATION, S1_TRUST_DOMAIN, capabilityFor, httpJson, s1ReferenceOptions, signCapability, signerAuthorization, spawnOfferSigner, tempCapabilityLedger, type Authorized } from './trade04c-s1-capability-fixture.js';

/**
 * TRADE-04C-S1 — the delegated signer's authorization, adversarially (§6):
 * a bearer credential alone signs nothing; every capability check refuses
 * on its own; single use holds across requests, concurrent callers, two
 * signer processes sharing one ledger, and restarts; crash states never make
 * a capability reusable — for ed25519 and secp256k1 delegates, in process,
 * over loopback HTTP and against the shipped launcher as a separate process.
 * Real signatures and the real SQLite ledger throughout; loopback only.
 */

const CREDENTIAL = 'trade04c-s1-offer-signer-credential-0123456789';
const SIGNER_ID = 's1-signer-1';
const workDir = mkdtempSync(join(tmpdir(), 'trade04c-s1-signer-'));
after(() => rmSync(workDir, { recursive: true, force: true }));
let fileCounter = 0;
const ledgerPath = (): string => join(workDir, `ledger-${(fileCounter += 1)}.sqlite`);

let counter = 0;
const requestId = (): string => (counter += 1).toString(16).padStart(64, '0');

/** A v2 request carrying `authorized` for `transaction`. */
const body = (world: OfferWorld, transaction: PreparedDelegatedOffer, authorized: Pick<Authorized, 'proposal' | 'authorization'> | undefined, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  protocol: DELEGATED_OFFER_SIGNER_PROTOCOL,
  signerId: SIGNER_ID,
  requestId: requestId(),
  network: 'xrp-ledger-testnet',
  ownerAccount: transaction.Account,
  delegateAccount: transaction.Delegate,
  transaction,
  ...(authorized !== undefined ? { proposal: authorized.proposal, authorization: authorized.authorization } : {}),
  ...overrides,
});

async function inProcess(worlds: readonly OfferWorld[], path = ledgerPath(), options: { readonly keys?: Parameters<typeof s1ReferenceOptions>[0] } = {}) {
  const ledger = await openReferenceCapabilityLedger(path);
  const service = createReferenceDelegatedOfferSignerService({
    ...s1ReferenceOptions({ consumption: ledger, ...options.keys }),
    signerId: SIGNER_ID,
    network: 'xrp-ledger-testnet',
    credential: CREDENTIAL,
    keys: worlds.map((world) => ({ ownerAccount: world.owner, delegateSeed: world.delegate.seed })),
    maximumFeeDrops: '1000',
  });
  const post = (request: unknown, authorization: unknown = `Bearer ${CREDENTIAL}`) =>
    service.answer({ method: 'POST', path: '/v1/sign/xrpl-delegated-offer', authorization, contentType: 'application/json', body: Buffer.from(JSON.stringify(request)) }) as { status: number; body: Record<string, unknown> };
  return { service, ledger, post, path, close: () => ledger.close() };
}

for (const algorithm of ['ed25519', 'secp256k1'] as const) {
  describe(`TRADE-04C-S1 §6 — the delegated signer refuses everything but a valid capability (${algorithm})`, () => {
    it('a valid approved operation → exactly one signature, for exactly that transaction; the ledger records it consumed then signed', async () => {
      const world = offerWorld(algorithm);
      const signer = await inProcess([world]);
      try {
        const offer = world.offer();
        const authorized = capabilityFor(world, offer);
        const answer = signer.post(body(world, offer, authorized));
        assert.equal(answer.status, 200, JSON.stringify(answer.body));
        assert.equal(answer.body['capabilityId'], authorized.capability.capabilityId);
        assert.equal(verifySignedDelegatedOffer({ prepared: offer, pair: world.pair, signedTransaction: answer.body['signedTransaction'], hash: answer.body['hash'] }).verified, true);
        assert.equal(signer.service.signatures(), 1);
        assert.deepEqual(signer.ledger.read(authorized.capability.capabilityId), { state: 'signed', transactionHash: answer.body['hash'] });
      } finally {
        signer.close();
      }
    });

    it('a stolen bearer credential without a capability → zero signatures (v1 request, no authorization, a self-made capability, a garbage signature)', async () => {
      const world = offerWorld(algorithm);
      const signer = await inProcess([world]);
      try {
        const offer = world.offer();
        const genuine = capabilityFor(world, offer);
        const selfMade = capabilityFor(world, offer, { key: AUTHORITY_KEY_UNTRUSTED });
        const attempts: readonly [string, Record<string, unknown>, string][] = [
          ['a v1 request with audit references', { ...body(world, offer, undefined), audit: { executionId: 'exec-1', grantRef: 'grant-1', grantDigest: `sha256:${'ab'.repeat(32)}` } }, 'not-signable'],
          ['no authorization at all', body(world, offer, undefined), 'not-signable'],
          ['a proposal but no capability', body(world, offer, undefined, { proposal: genuine.proposal }), 'not-signable'],
          ['a capability the attacker signed with its own key', body(world, offer, selfMade), 'capability-signature-invalid'],
          ['a genuine capability text with a garbage signature', body(world, offer, { ...genuine, authorization: { ...genuine.authorization, signature: { ...genuine.authorization.signature, signature: 'A'.repeat(86) } } }), 'capability-signature-invalid'],
          ['a capability text claiming the pinned key, signed by another', body(world, offer, { ...genuine, authorization: { ...genuine.authorization, signature: signCapability(genuine.capability, AUTHORITY_KEY_B, AUTHORITY_KEY_A.keyId) } }), 'capability-signature-invalid'],
        ];
        for (const [name, request, error] of attempts) assert.deepEqual(signer.post(request), { status: 422, body: { error } }, name);
        assert.equal(signer.service.signatures(), 0);
        assert.deepEqual(signer.ledger.counts(), { consumed: 0, signed: 0, 'signing-failed': 0 }, 'nothing consumed either');
      } finally {
        signer.close();
      }
    });

    const changed: readonly [string, (world: OfferWorld) => Partial<Record<keyof PreparedDelegatedOffer, unknown>>, string][] = [
      ['price (TakerPays value)', (w) => ({ TakerPays: { currency: 'USD', issuer: w.issuer, value: '12.6' } }), 'capability-transaction-mismatch'],
      ['quantity (TakerGets drops)', () => ({ TakerGets: '25000001' }), 'capability-transaction-mismatch'],
      ['issuer', () => ({ TakerPays: { currency: 'USD', issuer: testAccount(), value: '12.5' } }), 'capability-transaction-mismatch'],
      ['currency', (w) => ({ TakerPays: { currency: 'EUR', issuer: w.issuer, value: '12.5' } }), 'capability-transaction-mismatch'],
      ['flags', () => ({ Flags: 0 }), 'capability-transaction-mismatch'],
      ['Sequence', () => ({ Sequence: 42 }), 'capability-transaction-mismatch'],
      ['Fee', () => ({ Fee: '13' }), 'capability-transaction-mismatch'],
      ['LastLedgerSequence', () => ({ LastLedgerSequence: 1_021 }), 'capability-transaction-mismatch'],
      ['an added Expiration', () => ({ Expiration: 900_000_000 }), 'capability-transaction-mismatch'],
    ];
    for (const [name, change, error] of changed) {
      it(`a capability for another transaction: changed ${name} → refused (${error}), zero signatures`, async () => {
        const world = offerWorld(algorithm);
        const signer = await inProcess([world]);
        try {
          const authorized = capabilityFor(world, world.offer());
          assert.deepEqual(signer.post(body(world, world.offer(change(world)), authorized)), { status: 422, body: { error } });
          assert.equal(signer.service.signatures(), 0);
        } finally {
          signer.close();
        }
      });
    }

    it('changed owner or delegate: a capability for pair A presented with pair B’s transaction → refused', async () => {
      const a = offerWorld(algorithm);
      const b = offerWorld(algorithm);
      const signer = await inProcess([a, b]);
      try {
        const forA = capabilityFor(a, a.offer());
        assert.deepEqual(signer.post(body(b, b.offer(), forA)), { status: 422, body: { error: 'capability-pair-mismatch' } });
        assert.equal(signer.service.signatures(), 0);
      } finally {
        signer.close();
      }
    });

    it('the proposal: another grant’s proposal, or a proposal whose order is not this transaction → refused', async () => {
      const world = offerWorld(algorithm);
      const signer = await inProcess([world]);
      try {
        const offer = world.offer();
        const authorized = capabilityFor(world, offer);
        const other = capabilityFor(world, world.offer({ TakerGets: '26000000' }));
        assert.deepEqual(signer.post(body(world, offer, { proposal: other.proposal, authorization: authorized.authorization })), { status: 422, body: { error: 'capability-proposal-mismatch' } });
        // A capability whose proposal digest names a proposal for a different order, signed by the pinned key, for this exact transaction.
        const mismatched = capabilityFor(world, offer, { proposal: other.proposal });
        assert.deepEqual(signer.post(body(world, offer, mismatched)), { status: 422, body: { error: 'capability-terms-mismatch' } });
        assert.equal(signer.service.signatures(), 0);
      } finally {
        signer.close();
      }
    });

    it('scope, network, issuer and time: another trust domain, organization, network, issuer key id; expired; not yet valid → refused', async () => {
      const world = offerWorld(algorithm);
      const signer = await inProcess([world]);
      try {
        const offer = world.offer();
        const now = Date.now();
        const cases: readonly [string, Authorized, string][] = [
          ['another trust domain', capabilityFor(world, offer, { capability: { trustDomain: 'trust-domain-other' } }), 'capability-scope-mismatch'],
          ['another organization', capabilityFor(world, offer, { capability: { organizationId: 'org-other' } }), 'capability-scope-mismatch'],
          ['another network (Devnet)', capabilityFor(world, offer, { network: 'xrp-ledger-devnet' }), 'capability-network-mismatch'],
          ['an issuer key id other than the key that signed', capabilityFor(world, offer, { capability: { issuerKeyId: AUTHORITY_KEY_B.keyId } }), 'capability-issuer-untrusted'],
          ['an unknown issuer key', capabilityFor(world, offer, { key: AUTHORITY_KEY_B }), 'capability-signature-invalid'],
          ['expired', capabilityFor(world, offer, { now: now - 90_000, lifetimeMs: 60_000 }), 'capability-expired'],
          ['expiring exactly now', capabilityFor(world, offer, { now: now - 1_000, lifetimeMs: 1_000 }), 'capability-expired'],
          ['issued in the future (beyond the skew)', capabilityFor(world, offer, { now: now + 60_000 }), 'capability-not-yet-valid'],
        ];
        for (const [name, authorized, error] of cases) assert.deepEqual(signer.post(body(world, offer, authorized)), { status: 422, body: { error } }, name);
        assert.equal(signer.service.signatures(), 0);
      } finally {
        signer.close();
      }
    });

    it('replay: the same capability under a fresh request id, and a second capability for the same execution → refused (409); one signature', async () => {
      const world = offerWorld(algorithm);
      const signer = await inProcess([world]);
      try {
        const offer = world.offer();
        const authorized = capabilityFor(world, offer);
        assert.equal(signer.post(body(world, offer, authorized)).status, 200);
        assert.deepEqual(signer.post(body(world, offer, authorized)), { status: 409, body: { error: 'capability-consumed' } });
        const sameExecution = capabilityFor(world, offer, { capability: { executionId: authorized.capability.executionId } });
        assert.deepEqual(signer.post(body(world, offer, sameExecution)), { status: 409, body: { error: 'execution-consumed' } });
        assert.equal(signer.service.signatures(), 1);
      } finally {
        signer.close();
      }
    });
  });
}

describe('TRADE-04C-S1 §6 — single use across concurrency, processes and restarts; crash states', () => {
  it('concurrent reuse over loopback HTTP: 12 simultaneous requests with one capability → exactly one signature', async () => {
    const world = offerWorld();
    const { consumption: _unused, ...s1 } = s1ReferenceOptions();
    const started = await startReferenceDelegatedOfferSigner({ ...s1, consumptionLedgerPath: ledgerPath(), signerId: SIGNER_ID, network: 'xrp-ledger-testnet', credential: CREDENTIAL, keys: [{ ownerAccount: world.owner, delegateSeed: world.delegate.seed }], maximumFeeDrops: '1000' });
    try {
      const offer = world.offer();
      const authorized = capabilityFor(world, offer);
      const answers = await Promise.all(Array.from({ length: 12 }, () => httpJson(`http://127.0.0.1:${started.port}/v1/sign/xrpl-delegated-offer`, 'POST', CREDENTIAL, body(world, offer, authorized))));
      assert.equal(answers.filter((answer) => answer.status === 200).length, 1, JSON.stringify(answers.map((answer) => answer.status)));
      assert.equal(answers.filter((answer) => answer.status === 409).length, 11);
      assert.equal(started.signatures(), 1);
    } finally {
      await started.close();
    }
  });

  it('two signer instances sharing one ledger file (two processes’ view): the same capability, interleaved → exactly one signature in all', async () => {
    const world = offerWorld();
    const path = ledgerPath();
    const first = await inProcess([world], path);
    const second = await inProcess([world], path);
    try {
      const offer = world.offer();
      let signatures = 0;
      for (let round = 0; round < 10; round += 1) {
        const authorized = capabilityFor(world, offer);
        const statuses = [first.post(body(world, offer, authorized)).status, second.post(body(world, offer, authorized)).status];
        assert.deepEqual([...statuses].sort(), [200, 409], `round ${round}`);
        signatures += statuses.filter((status) => status === 200).length;
      }
      assert.equal(signatures, 10);
      assert.equal(first.service.signatures() + second.service.signatures(), 10);
    } finally {
      first.close();
      second.close();
    }
  });

  it('reuse after a signer restart → refused: consumption is durable', async () => {
    const world = offerWorld();
    const path = ledgerPath();
    const offer = world.offer();
    const authorized = capabilityFor(world, offer);
    const before = await inProcess([world], path);
    assert.equal(before.post(body(world, offer, authorized)).status, 200);
    before.close();
    const after = await inProcess([world], path);
    try {
      assert.deepEqual(after.post(body(world, offer, authorized)), { status: 409, body: { error: 'capability-consumed' } });
      assert.equal(after.service.signatures(), 0);
      assert.equal(after.ledger.read(authorized.capability.capabilityId)?.state, 'signed');
    } finally {
      after.close();
    }
  });

  it('a crash after consumption and before signing: the capability stays consumed, unsigned, and is refused after restart — uncertainty preserved, never a second signature', async () => {
    const world = offerWorld();
    const path = ledgerPath();
    const offer = world.offer();
    const authorized = capabilityFor(world, offer);
    const crashed = await openReferenceCapabilityLedger(path);
    // Exactly the write the signer commits before it touches its key — then the process dies.
    assert.equal(crashed.consume({ capabilityId: authorized.capability.capabilityId, executionId: authorized.capability.executionId, boundedGrantId: authorized.capability.boundedGrantId, signingPreimageDigest: authorized.capability.signingPreimageDigest, expiresAt: authorized.capability.expiresAt }, new Date().toISOString()), 'consumed');
    crashed.close();
    const restarted = await inProcess([world], path);
    try {
      assert.deepEqual(restarted.post(body(world, offer, authorized)), { status: 409, body: { error: 'capability-consumed' } });
      assert.deepEqual(restarted.ledger.read(authorized.capability.capabilityId), { state: 'consumed' }, 'consumed, no hash: the uncertainty a reconciliation must see');
      assert.equal(restarted.service.signatures(), 0);
    } finally {
      restarted.close();
    }
  });

  it('a signing failure after consumption leaves it consumed (signing-failed), never reusable; the ledger refuses deletion and backwards moves', async () => {
    const { ledger, path, cleanup } = await tempCapabilityLedger();
    try {
      const entry = { capabilityId: 'ab'.repeat(32), executionId: 'exec-crash', boundedGrantId: 'grant-crash', signingPreimageDigest: `sha256:${'1'.repeat(64)}`, expiresAt: new Date(Date.now() + 30_000).toISOString() };
      assert.equal(ledger.consume(entry, new Date().toISOString()), 'consumed');
      ledger.markFailed(entry.capabilityId);
      assert.deepEqual(ledger.read(entry.capabilityId), { state: 'signing-failed' });
      assert.equal(ledger.consume(entry, new Date().toISOString()), 'capability-consumed');
      ledger.markSigned(entry.capabilityId, 'CD'.repeat(32));
      assert.deepEqual(ledger.read(entry.capabilityId), { state: 'signing-failed' }, 'forward only: a failed capability is never later marked signed');
      const { default: Database } = await import('better-sqlite3');
      const raw = new Database(path);
      try {
        assert.throws(() => raw.prepare('DELETE FROM consumed_capabilities').run(), /permanent/);
        assert.throws(() => raw.prepare(`UPDATE consumed_capabilities SET state = 'consumed'`).run(), /only moves forward/);
        assert.throws(() => raw.prepare(`UPDATE consumed_capabilities SET execution_id = 'other'`).run(), /only moves forward/);
      } finally {
        raw.close();
      }
      await assert.rejects(openReferenceCapabilityLedger(':memory:'), /durable file path/);
    } finally {
      cleanup();
    }
  });
});

describe('TRADE-04C-S1 §6 — what a capability does not cover, and failing closed', () => {
  it('a signature is still not a submission: the client returns signed-not-submitted; the signer has no submit route; its ledger says signed, nothing more', async () => {
    const world = offerWorld();
    const signer = await inProcess([world]);
    try {
      const client = createDelegatedOfferSigner({
        transport: {
          identity: async () => JSON.parse(JSON.stringify(signer.service.identity)) as unknown,
          signDelegatedOffer: async (request) => {
            const answer = signer.post(request);
            if (answer.status !== 200) throw new DelegatedOfferSignerError('OFFER_SIGNER_REFUSED', String(answer.status));
            return answer.body;
          },
        },
        pin: { signerId: SIGNER_ID, network: 'xrp-ledger-testnet', pairs: [world.pair] },
        timeoutMs: 1_000,
        maximumFeeDrops: '100',
        maximumLedgerHorizon: 40,
      });
      const authorized = capabilityFor(world, world.offer());
      const signed = await client.signDelegatedOffer({ transaction: world.offer(), proposal: authorized.proposal, authorization: authorized.authorization, validatedLedgerIndex: 1_000 });
      assert.equal(signed.status, 'signed-not-submitted');
      assert.equal(signed.capabilityId, authorized.capability.capabilityId);
      assert.equal(signed.executionId, authorized.capability.executionId);
      assert.equal(signer.service.answer({ method: 'POST', path: '/v1/submit', authorization: `Bearer ${CREDENTIAL}`, contentType: 'application/json', body: Buffer.from('{}') }).status, 404);
      assert.equal(signer.ledger.read(authorized.capability.capabilityId)?.state, 'signed');
    } finally {
      signer.close();
    }
  });

  it('signer unavailable → fail closed: nothing signed, and the capability was never consumed (a fresh one is needed anyway)', async () => {
    const world = offerWorld();
    const client = createDelegatedOfferSigner({
      transport: createHttpDelegatedOfferSignerTransport({ endpoint: 'http://127.0.0.1:1', credential: CREDENTIAL }),
      pin: { signerId: SIGNER_ID, network: 'xrp-ledger-testnet', pairs: [world.pair] },
      timeoutMs: 1_000,
      maximumFeeDrops: '100',
      maximumLedgerHorizon: 40,
      probeIntervalMs: 0,
    });
    const authorized = capabilityFor(world, world.offer());
    await assert.rejects(client.signDelegatedOffer({ transaction: world.offer(), proposal: authorized.proposal, authorization: authorized.authorization, validatedLedgerIndex: 1_000 }), (error: unknown) => error instanceof DelegatedOfferSignerError && error.reason === 'OFFER_SIGNER_NOT_VERIFIED');
  });

  it('OUTSIDE this capability’s guarantees — a compromised delegate key signs without any capability, and the blob verifies cryptographically', () => {
    const world = offerWorld();
    const stolen = world.delegate.sign({ ...world.offer() });
    // No capability, no signer, no Frontera: the ledger would accept this from the delegate key alone (subject to XLS-75).
    assert.equal(verifySignedDelegatedOffer({ prepared: world.offer(), pair: world.pair, signedTransaction: stolen.blob, hash: stolen.hash }).verified, true);
  });
});

describe('TRADE-04C-S1 §7 — a real separate-process reference signer (the shipped launcher), loopback only', () => {
  it('stolen credential → 0 signatures; a valid capability → one; replay → refused; refused again after a process restart; two processes on one ledger → one signature', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'trade04c-s1-process-'));
    const stops: (() => Promise<void>)[] = [];
    try {
      const owner = testAccount();
      const keyFile = join(dir, 'delegate-keys.json');
      createReferenceDelegatedOfferKeyFile(keyFile, { network: 'xrp-ledger-testnet', ownerAccounts: [owner], algorithm: 'secp256k1' });
      const loaded = loadReferenceDelegatedOfferKeyFile(keyFile);
      const world = worldWith(owner, delegateFromSeed(loaded.keys[0]!.delegateSeed));
      const authorityPublicKeyFile = join(dir, 'authority.pub');
      writeFileSync(authorityPublicKeyFile, AUTHORITY_KEY_A.publicKeyPem);
      const common = { keyFile, signerId: SIGNER_ID, credential: CREDENTIAL, authorityKeyId: AUTHORITY_KEY_A.keyId, authorityPublicKeyFile, trustDomain: S1_TRUST_DOMAIN, organizationId: S1_ORGANIZATION, ledgerPath: join(dir, 'capability-ledger.sqlite') };
      let signer = await spawnOfferSigner(common);
      stops.push(() => signer.stop());
      const { trustDomain, organizationId } = signerAuthorization();
      assert.deepEqual(signer.identity['authorization'], { trustDomain, organizationId, issuerKeyIds: [AUTHORITY_KEY_A.keyId] });
      const url = `${signer.endpoint}/v1/sign/xrpl-delegated-offer`;
      const offer = world.offer();

      // The attacker holds the credential and can reach the signer — and has no capability.
      for (const request of [body(world, offer, undefined), { ...body(world, offer, undefined), audit: { executionId: 'e', grantRef: 'g', grantDigest: `sha256:${'ab'.repeat(32)}` } }, body(world, offer, capabilityFor(world, offer, { key: AUTHORITY_KEY_UNTRUSTED }))]) {
        const answer = await httpJson(url, 'POST', CREDENTIAL, request);
        assert.equal(answer.status, 422, JSON.stringify(answer.body));
      }

      // The longest lifetime the authority issues: durability after a restart is only observable while the capability is still valid.
      const authorized = capabilityFor(world, offer, { lifetimeMs: 60_000 });
      const client = createDelegatedOfferSigner({ transport: createHttpDelegatedOfferSignerTransport({ endpoint: signer.endpoint, credential: CREDENTIAL }), pin: { signerId: SIGNER_ID, network: 'xrp-ledger-testnet', pairs: [world.pair] }, timeoutMs: 5_000, maximumFeeDrops: '100', maximumLedgerHorizon: 40, probeIntervalMs: 0 });
      const signed = await client.signDelegatedOffer({ transaction: offer, proposal: authorized.proposal, authorization: authorized.authorization, validatedLedgerIndex: 1_000 });
      assert.equal(signed.status, 'signed-not-submitted');
      assert.equal((await httpJson(url, 'POST', CREDENTIAL, body(world, offer, authorized))).status, 409, 'replay refused');

      await signer.stop();
      signer = await spawnOfferSigner(common);
      const afterRestart = await httpJson(`${signer.endpoint}/v1/sign/xrpl-delegated-offer`, 'POST', CREDENTIAL, body(world, offer, authorized));
      if (Date.now() < Date.parse(authorized.capability.expiresAt) - 1_000) {
        assert.deepEqual(afterRestart, { status: 409, body: { error: 'capability-consumed' } }, 'refused after a process restart: consumption is durable');
      } else {
        // A restart slower than the capability's lifetime (a loaded machine): still refused, by expiry; durability is proven in process above.
        assert.deepEqual(afterRestart, { status: 422, body: { error: 'capability-expired' } });
      }

      const twin = await spawnOfferSigner(common);
      stops.push(() => twin.stop());
      let signatures = 0;
      for (let round = 0; round < 5; round += 1) {
        const fresh = capabilityFor(world, offer);
        const answers = await Promise.all([signer, twin].map((process) => httpJson(`${process.endpoint}/v1/sign/xrpl-delegated-offer`, 'POST', CREDENTIAL, body(world, offer, fresh))));
        assert.deepEqual(answers.map((answer) => answer.status).sort(), [200, 409], `round ${round}`);
        signatures += answers.filter((answer) => answer.status === 200).length;
      }
      assert.equal(signatures, 5);
    } finally {
      for (const stop of stops) await stop().catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

