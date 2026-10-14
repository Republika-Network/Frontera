import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { DELEGATED_OFFER_SIGNER_PROTOCOL, verifySignedDelegatedOffer } from '../xrpl-trade-rail/index.js';
import {
  REFERENCE_DELEGATED_OFFER_KEY_FILE_FORMAT,
  createReferenceDelegatedOfferKeyFile,
  createReferenceDelegatedOfferSignerService,
  isReferenceSignerLoopbackHost,
  loadReferenceDelegatedOfferKeyFile,
  referenceKeyFileModeProblem,
  startReferenceDelegatedOfferSigner,
  type ReferenceDelegatedOfferSignerOptions,
} from '../xrpl-trade-rail/reference/reference-delegated-offer-signer.js';
import { AUDIT, offerWorld, testAccount, testDelegate, type OfferWorld } from './trade04b-xrpl-fixture.js';

/**
 * TRADE-04B — the reference delegated OfferCreate signer (adversarial matrix
 * E): what it signs, what it refuses before touching a key, how it binds, and
 * how its key file is created and loaded. Keys are ephemeral, generated per
 * test, in fresh directories under the OS temporary directory that are
 * removed afterwards. Nothing connects anywhere but loopback.
 */

const CREDENTIAL = 'trade04b-reference-credential-0123456789';
const RIPPLE_EPOCH = 946_684_800;

function service(worlds: readonly OfferWorld[], overrides: Partial<ReferenceDelegatedOfferSignerOptions> = {}) {
  return createReferenceDelegatedOfferSignerService({
    signerId: 'ref-1',
    network: 'xrp-ledger-testnet',
    credential: CREDENTIAL,
    keys: worlds.map((world) => ({ ownerAccount: world.owner, delegateSeed: world.delegate.seed })),
    maximumFeeDrops: '100',
    ...overrides,
  });
}

let counter = 0;
const requestBody = (world: OfferWorld, overrides: Record<string, unknown> = {}, transaction: Record<string, unknown> = {}) => ({
  protocol: DELEGATED_OFFER_SIGNER_PROTOCOL,
  signerId: 'ref-1',
  requestId: (counter++).toString(16).padStart(64, '0'),
  network: 'xrp-ledger-testnet',
  ownerAccount: world.owner,
  delegateAccount: world.delegate.address,
  transaction: { ...world.offer(), ...transaction },
  audit: AUDIT,
  ...overrides,
});

const post = (svc: ReturnType<typeof service>, body: unknown, headers: { authorization?: unknown; contentType?: unknown } = {}) =>
  svc.answer({ method: 'POST', path: '/v1/sign/xrpl-delegated-offer', authorization: 'authorization' in headers ? headers.authorization : `Bearer ${CREDENTIAL}`, contentType: 'contentType' in headers ? headers.contentType : 'application/json', body: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)) });

function withTemporaryDirectory(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'trade04b-ref-'));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('TRADE-04B E — the reference signer signs one closed shape, for held pairs only', () => {
  it('signs a closed delegated OfferCreate and its answer verifies on the Host side', () => {
    const world = offerWorld();
    const svc = service([world]);
    const answer = post(svc, requestBody(world));
    assert.equal(answer.status, 200);
    const body = answer.body as { signedTransaction: string; hash: string };
    assert.equal(verifySignedDelegatedOffer({ prepared: world.offer(), pair: world.pair, signedTransaction: body.signedTransaction, hash: body.hash }).verified, true);
    assert.equal(svc.signatures(), 1);
  });

  it('two owner/delegate pairs stay isolated: a request naming owner A with delegate B is refused; each pair signs only with its own key', () => {
    const a = offerWorld();
    const b = offerWorld();
    const svc = service([a, b]);
    assert.equal(svc.identity.pairs.length, 2);
    const crossed = requestBody(a, { delegateAccount: b.delegate.address }, { Delegate: b.delegate.address });
    assert.deepEqual(post(svc, crossed), { status: 422, body: { error: 'pair-not-held' } });
    const signedB = post(svc, requestBody(b)).body as { signedTransaction: string; hash: string };
    assert.equal(verifySignedDelegatedOffer({ prepared: b.offer(), pair: b.pair, signedTransaction: signedB.signedTransaction, hash: signedB.hash }).verified, true);
    assert.equal(verifySignedDelegatedOffer({ prepared: b.offer(), pair: { ...b.pair, signingPublicKey: a.pair.signingPublicKey }, signedTransaction: signedB.signedTransaction, hash: signedB.hash }).verified, false);
  });

  const refused: readonly [string, (world: OfferWorld) => unknown, number, string][] = [
    ['a Payment', (w) => requestBody(w, {}, { TransactionType: 'Payment' }), 422, 'not-signable'],
    ['raw bytes', () => ({ protocol: DELEGATED_OFFER_SIGNER_PROTOCOL, signingBytes: '535458' }), 422, 'not-signable'],
    ['a key-export style request', (w) => ({ ...requestBody(w), exportKey: true }), 422, 'not-signable'],
    ['another signer id', (w) => requestBody(w, { signerId: 'ref-2' }), 422, 'not-signable'],
    ['another network', (w) => requestBody(w, { network: 'xrp-ledger-devnet' }), 422, 'wrong-network'],
    ['an owner it does not serve', (w) => requestBody(w, { ownerAccount: testAccount() }, {}), 422, 'not-signable'],
    ['a fee above its ceiling', (w) => requestBody(w, {}, { Fee: '101' }), 422, 'fee-above-ceiling'],
    ['a Memo', (w) => requestBody(w, {}, { Memos: [{ Memo: { MemoData: 'AA' } }] }), 422, 'not-signable'],
    ['a caller-supplied SigningPubKey', (w) => requestBody(w, {}, { SigningPubKey: w.delegate.publicKey }), 422, 'not-signable'],
  ];
  for (const [name, build, status, error] of refused) {
    it(`refuses ${name} before touching a key`, () => {
      const world = offerWorld();
      const svc = service([world]);
      assert.deepEqual(post(svc, build(world)), { status, body: { error } });
      assert.equal(svc.signatures(), 0);
    });
  }

  it('refuses a replayed request id', () => {
    const world = offerWorld();
    const svc = service([world]);
    const body = requestBody(world);
    assert.equal(post(svc, body).status, 200);
    assert.deepEqual(post(svc, body), { status: 409, body: { error: 'request-replayed' } });
  });

  it('the LastLedgerSequence horizon is enforced only against an injected trusted reference — never estimated', () => {
    const world = offerWorld();
    assert.equal(post(service([world]), requestBody(world, {}, { LastLedgerSequence: 999_999 })).status, 200, 'no reference: deferred, not guessed');
    let reference: number | undefined = 1_000;
    const svc = service([world], { ledgerReference: () => reference, maximumLedgerHorizon: 20 });
    assert.equal(post(svc, requestBody(world, {}, { LastLedgerSequence: 1_020 })).status, 200);
    assert.deepEqual(post(svc, requestBody(world, {}, { LastLedgerSequence: 1_021 })), { status: 422, body: { error: 'ledger-horizon' } });
    assert.deepEqual(post(svc, requestBody(world, {}, { LastLedgerSequence: 1_000 })), { status: 422, body: { error: 'ledger-horizon' } });
    reference = undefined;
    assert.equal(post(svc, requestBody(world, {}, { LastLedgerSequence: 5_000 })).status, 200, 'the reference went away: deferred again, explicitly');
  });

  it('an Expiration already past by its clock is refused; without a clock the check is deferred', () => {
    const world = offerWorld();
    const now = Date.UTC(2026, 9, 13);
    const rippleNow = Math.floor(now / 1000) - RIPPLE_EPOCH;
    const svc = service([world], { clock: () => now });
    assert.deepEqual(post(svc, requestBody(world, {}, { Expiration: rippleNow })), { status: 422, body: { error: 'expired' } });
    assert.equal(post(svc, requestBody(world, {}, { Expiration: rippleNow + 60 })).status, 200);
    assert.equal(post(service([world]), requestBody(world, {}, { Expiration: 1 })).status, 200);
  });

  it('authenticates every route, accepts only JSON of bounded size, and has no other route — no key export', () => {
    const world = offerWorld();
    const svc = service([world]);
    assert.equal(post(svc, requestBody(world), { authorization: undefined }).status, 401);
    assert.equal(post(svc, requestBody(world), { authorization: `Bearer ${CREDENTIAL}x` }).status, 401);
    assert.equal(post(svc, requestBody(world), { authorization: CREDENTIAL }).status, 401);
    assert.equal(svc.answer({ method: 'GET', path: '/v1/identity', authorization: undefined, contentType: undefined, body: Buffer.alloc(0) }).status, 401);
    assert.equal(post(svc, requestBody(world), { contentType: 'text/plain' }).status, 415);
    assert.equal(post(svc, '{not json').status, 400);
    assert.equal(post(svc, { padding: 'x'.repeat(17 * 1024) }).status, 413);
    for (const path of ['/v1/export-key', '/v1/seed', '/v1/sign', '/v1/sign/xrpl-payment', '/v1/submit', '/']) {
      assert.equal(svc.answer({ method: 'POST', path, authorization: `Bearer ${CREDENTIAL}`, contentType: 'application/json', body: Buffer.from('{}') }).status, 404, path);
    }
    assert.equal(svc.answer({ method: 'POST', path: '/v1/identity', authorization: `Bearer ${CREDENTIAL}`, contentType: 'application/json', body: Buffer.alloc(0) }).status, 405);
    assert.equal(svc.answer({ method: 'GET', path: '/v1/sign/xrpl-delegated-offer', authorization: `Bearer ${CREDENTIAL}`, contentType: undefined, body: Buffer.alloc(0) }).status, 405);
  });

  it('its identity and its answers carry no seed or credential', () => {
    const world = offerWorld();
    const svc = service([world]);
    const everything = JSON.stringify([svc.identity, post(svc, requestBody(world)).body, post(svc, '{').body, post(svc, requestBody(world), { authorization: 'x' }).body]);
    assert.equal(everything.includes(world.delegate.seed), false);
    assert.equal(everything.includes(CREDENTIAL), false);
    assert.equal(everything.includes('privateKey'), false);
  });

  it('configuration is refused: mainnet, a short credential, a fee ceiling above 1 XRP, an owner’s own key, a duplicate pair', () => {
    const world = offerWorld();
    const base = { signerId: 'ref-1', network: 'xrp-ledger-testnet' as const, credential: CREDENTIAL, keys: [{ ownerAccount: world.owner, delegateSeed: world.delegate.seed }], maximumFeeDrops: '100' };
    const ownerKey = testDelegate();
    for (const bad of [
      { ...base, network: 'xrp-ledger-mainnet' },
      { ...base, credential: 'short' },
      { ...base, maximumFeeDrops: '1000001' },
      { ...base, keys: [{ ownerAccount: ownerKey.address, delegateSeed: ownerKey.seed }] },
      { ...base, keys: [base.keys[0], base.keys[0]] },
      { ...base, keys: [{ ownerAccount: world.owner, delegateSeed: 'not-a-seed' }] },
      { ...base, keys: [] },
    ]) {
      assert.throws(() => createReferenceDelegatedOfferSignerService(bad as ReferenceDelegatedOfferSignerOptions), (error: unknown) => error instanceof Error && !error.message.includes(world.delegate.seed) && !error.message.includes(ownerKey.seed), JSON.stringify(Object.keys(bad)));
    }
  });
});

describe('TRADE-04B E — binding: literal loopback only', () => {
  it('starts on loopback; refuses a public, wildcard or named bind before opening a socket', async () => {
    const world = offerWorld();
    const options = { signerId: 'ref-1', network: 'xrp-ledger-testnet' as const, credential: CREDENTIAL, keys: [{ ownerAccount: world.owner, delegateSeed: world.delegate.seed }], maximumFeeDrops: '100' };
    const started = await startReferenceDelegatedOfferSigner(options);
    try {
      assert.equal(started.host, '127.0.0.1');
      assert.equal((started.server.address() as { address: string }).address, '127.0.0.1');
    } finally {
      await started.close();
    }
    for (const host of ['0.0.0.0', '::', 'localhost', '10.0.0.1', '192.168.1.10', 'example.com', '127.0.0.256', '']) {
      assert.equal(isReferenceSignerLoopbackHost(host), false, host);
      await assert.rejects(startReferenceDelegatedOfferSigner({ ...options, host }), /literal loopback/);
    }
    for (const host of ['127.0.0.1', '127.1.2.3', '::1']) assert.equal(isReferenceSignerLoopbackHost(host), true, host);
  });
});

describe('TRADE-04B E — key file custody', () => {
  it('creates explicitly: create-only, mode 0600, public identity in <file>.pub with no secret; loads it back', () => {
    withTemporaryDirectory((dir) => {
      const path = join(dir, 'delegate-keys.json');
      const owners = [testAccount(), testAccount()];
      const created = createReferenceDelegatedOfferKeyFile(path, { network: 'xrp-ledger-testnet', ownerAccounts: owners });
      assert.equal(statSync(path).mode & 0o777, 0o600);
      const pub = readFileSync(`${path}.pub`, 'utf8');
      assert.equal(/seed|private|secret/i.test(pub), false);
      assert.deepEqual(JSON.parse(pub).pairs, created.pairs);
      const loaded = loadReferenceDelegatedOfferKeyFile(path);
      assert.deepEqual(loaded.pairs, created.pairs);
      assert.equal(loaded.network, 'xrp-ledger-testnet');
      assert.deepEqual(loaded.pairs.map((pair) => pair.ownerAccount), owners);
      assert.ok(loaded.pairs.every((pair) => pair.ownerAccount !== pair.delegateAccount));
    });
  });

  it('never overwrites: a second creation at the same path is refused and the original key survives', () => {
    withTemporaryDirectory((dir) => {
      const path = join(dir, 'delegate-keys.json');
      createReferenceDelegatedOfferKeyFile(path, { network: 'xrp-ledger-testnet', ownerAccounts: [testAccount()] });
      const before = readFileSync(path, 'utf8');
      assert.throws(() => createReferenceDelegatedOfferKeyFile(path, { network: 'xrp-ledger-testnet', ownerAccounts: [testAccount()] }));
      assert.equal(readFileSync(path, 'utf8'), before);
    });
  });

  it('never creates on load: a missing key file is refused', () => {
    withTemporaryDirectory((dir) => {
      const path = join(dir, 'absent.json');
      assert.throws(() => loadReferenceDelegatedOfferKeyFile(path), /does not exist; create it explicitly/);
      assert.equal(existsSync(path), false);
    });
  });

  it('refuses a key file readable by others, a symlink, and a file in another format — with no seed in any error', () => {
    withTemporaryDirectory((dir) => {
      const path = join(dir, 'delegate-keys.json');
      createReferenceDelegatedOfferKeyFile(path, { network: 'xrp-ledger-testnet', ownerAccounts: [testAccount()] });
      const seed = (JSON.parse(readFileSync(path, 'utf8')) as { keys: { delegateSeed: string }[] }).keys[0]?.delegateSeed ?? '';
      assert.ok(seed.length > 0);
      const noSeed = (error: unknown): boolean => error instanceof Error && !error.message.includes(seed);
      chmodSync(path, 0o644);
      assert.throws(() => loadReferenceDelegatedOfferKeyFile(path), (error: unknown) => noSeed(error) && /0600/.test((error as Error).message));
      chmodSync(path, 0o600);
      const link = join(dir, 'link.json');
      symlinkSync(path, link);
      assert.throws(() => loadReferenceDelegatedOfferKeyFile(link), (error: unknown) => noSeed(error) && /symbolic link/.test((error as Error).message));
      const other = join(dir, 'other.json');
      writeFileSync(other, JSON.stringify({ format: 'something-else', network: 'xrp-ledger-testnet', keys: [{ ownerAccount: testAccount(), delegateSeed: seed }] }), { mode: 0o600 });
      assert.throws(() => loadReferenceDelegatedOfferKeyFile(other), (error: unknown) => noSeed(error) && /reference format/.test((error as Error).message));
      const mainnet = join(dir, 'mainnet.json');
      writeFileSync(mainnet, JSON.stringify({ format: REFERENCE_DELEGATED_OFFER_KEY_FILE_FORMAT, network: 'xrp-ledger-mainnet', keys: [{ ownerAccount: testAccount(), delegateSeed: seed }] }), { mode: 0o600 });
      assert.throws(() => loadReferenceDelegatedOfferKeyFile(mainnet), noSeed);
      const extra = join(dir, 'extra.json');
      writeFileSync(extra, JSON.stringify({ format: REFERENCE_DELEGATED_OFFER_KEY_FILE_FORMAT, network: 'xrp-ledger-testnet', keys: [{ ownerAccount: testAccount(), delegateSeed: seed, ownerSeed: seed }] }), { mode: 0o600 });
      assert.throws(() => loadReferenceDelegatedOfferKeyFile(extra), noSeed);
    });
  });

  it('the mode check is exact: group or other bits, another owner, a symlink and a non-file are refused; on a filesystem that cannot enforce Unix permissions every file shows 0777 and is refused', () => {
    const stat = (mode: number, uid = 1000, kind: 'file' | 'link' | 'dir' = 'file') => ({ mode, uid, isFile: () => kind === 'file', isSymbolicLink: () => kind === 'link' });
    assert.equal(referenceKeyFileModeProblem(stat(0o100600), 1000), undefined);
    assert.equal(referenceKeyFileModeProblem(stat(0o100400), 1000), undefined);
    for (const mode of [0o100640, 0o100604, 0o100660, 0o100777]) assert.notEqual(referenceKeyFileModeProblem(stat(mode), 1000), undefined, mode.toString(8));
    assert.notEqual(referenceKeyFileModeProblem(stat(0o100600, 0), 1000), undefined, 'another owner');
    assert.notEqual(referenceKeyFileModeProblem(stat(0o100600, 1000, 'link'), 1000), undefined);
    assert.notEqual(referenceKeyFileModeProblem(stat(0o040700, 1000, 'dir'), 1000), undefined);
    assert.notEqual(referenceKeyFileModeProblem(stat(0o100600), undefined), undefined, 'a platform without uids cannot prove ownership');
  });

  it('on this machine: creation on a filesystem that does not enforce 0600 (e.g. /mnt/c under WSL) is refused and leaves no key behind', (t) => {
    // Probe the working directory's filesystem; on CI (ext4) it enforces modes and this case does not apply.
    const probeDir = mkdtempSync(join(process.cwd(), '.trade04b-perm-probe-'));
    try {
      const probe = join(probeDir, 'probe');
      writeFileSync(probe, 'x', { mode: 0o600 });
      if ((statSync(probe).mode & 0o077) === 0) {
        t.skip('this filesystem enforces Unix permissions');
        return;
      }
      const path = join(probeDir, 'delegate-keys.json');
      assert.throws(() => createReferenceDelegatedOfferKeyFile(path, { network: 'xrp-ledger-testnet', ownerAccounts: [testAccount()] }), /cannot enforce Unix permissions/);
      assert.equal(existsSync(path), false, 'nothing was kept');
      assert.equal(existsSync(`${path}.pub`), false);
    } finally {
      rmSync(probeDir, { recursive: true, force: true });
    }
  });
});
