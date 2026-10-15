import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  DELEGATED_OFFER_SIGNER_OPERATION,
  DELEGATED_OFFER_SIGNER_PROTOCOL,
  DelegatedOfferSignerConfigurationError,
  DelegatedOfferSignerError,
  createDelegatedOfferSigner,
  createHttpDelegatedOfferSignerTransport,
  delegatedOfferSignerEndpointProblem,
  validateDelegatedOfferSignerPins,
  type DelegatedOfferSignerPin,
  type DelegatedOfferSignerTransport,
  type DelegatedOfferSigningRequest,
} from '../xrpl-trade-rail/index.js';
import { createReferenceDelegatedOfferSignerService, startReferenceDelegatedOfferSigner } from '../xrpl-trade-rail/reference/reference-delegated-offer-signer.js';
import { authorizedInput, offerWorld, testDelegate, type OfferWorld } from './trade04b-xrpl-fixture.js';
import { capabilityFor, s1ReferenceOptions, signerAuthorization, tempCapabilityLedger } from './trade04c-s1-capability-fixture.js';

/**
 * TRADE-04B — the Host-side external signer client (adversarial matrix D):
 * identity pinning without TOFU, the four-state model, request correlation,
 * local refusal before contact, and the HTTP transport's bounds — over a
 * scripted transport, over the real reference signer on loopback, and over
 * hostile loopback servers. Real signatures; nothing is mocked on the
 * verification side, and nothing reaches beyond 127.0.0.1.
 */

const CREDENTIAL = 'trade04b-client-credential-0123456789abcdef';
const SIGNER_ID = 'customer-a-signer-1';
const VALIDATED = 1_000;

const pinOf = (world: OfferWorld, overrides: Partial<DelegatedOfferSignerPin> = {}): DelegatedOfferSignerPin => ({ signerId: SIGNER_ID, network: 'xrp-ledger-testnet', pairs: [world.pair], ...overrides });

/** An in-process transport over the reference service: real signing, no socket, every call counted and optionally rewritten. */
function referenceTransport(world: OfferWorld, rewrite: { identity?: (body: Record<string, unknown>) => unknown; sign?: (body: Record<string, unknown>, request: DelegatedOfferSigningRequest) => unknown } = {}) {
  const service = createReferenceDelegatedOfferSignerService({ ...s1ReferenceOptions(), signerId: SIGNER_ID, network: 'xrp-ledger-testnet', credential: CREDENTIAL, keys: [{ ownerAccount: world.owner, delegateSeed: world.delegate.seed }], maximumFeeDrops: '1000' });
  const calls = { identity: 0, sign: 0 };
  const call = (path: string, method: string, body?: unknown) => {
    const answer = service.answer({ method, path, authorization: `Bearer ${CREDENTIAL}`, contentType: 'application/json', body: Buffer.from(body === undefined ? '' : JSON.stringify(body)) });
    if (answer.status !== 200) throw new DelegatedOfferSignerError(answer.status === 409 || answer.status === 422 ? 'OFFER_SIGNER_REFUSED' : 'OFFER_SIGNER_UNAVAILABLE', `HTTP ${answer.status}`);
    return JSON.parse(JSON.stringify(answer.body)) as Record<string, unknown>;
  };
  const transport: DelegatedOfferSignerTransport = {
    identity: async () => {
      calls.identity += 1;
      const body = call('/v1/identity', 'GET');
      return rewrite.identity ? rewrite.identity(body) : body;
    },
    signDelegatedOffer: async (request) => {
      calls.sign += 1;
      const body = call('/v1/sign/xrpl-delegated-offer', 'POST', request);
      return rewrite.sign ? rewrite.sign(body, request) : body;
    },
  };
  return { transport, calls };
}

const client = (transport: DelegatedOfferSignerTransport, pin: DelegatedOfferSignerPin, overrides: Record<string, unknown> = {}) =>
  createDelegatedOfferSigner({ transport, pin, timeoutMs: 2_000, maximumFeeDrops: '100', maximumLedgerHorizon: 40, probeIntervalMs: 0, ...overrides });

/** TRADE-04C-S1: every input carries a CORE-02 capability for exactly its transaction. */
const input = (world: OfferWorld, overrides: Record<string, unknown> = {}) => authorizedInput(world, world.offer(overrides), VALIDATED);

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof DelegatedOfferSignerError, String(error));
    return error.reason;
  }
  assert.fail('expected a refusal');
}

describe('TRADE-04B D — client: identity pinning and state', () => {
  it('a correct, verified signer: UNVERIFIED → VERIFIED on the first signature; the result is signed-not-submitted and bound to its request', async () => {
    const world = offerWorld();
    const { transport, calls } = referenceTransport(world);
    const signer = client(transport, pinOf(world));
    assert.equal(signer.status().state, 'UNVERIFIED');
    const signature = await signer.signDelegatedOffer(input(world));
    assert.equal(signer.status().state, 'VERIFIED');
    assert.deepEqual(calls, { identity: 1, sign: 1 });
    assert.equal(signature.kind, 'xrpl-delegated-offer-signature');
    assert.equal(signature.status, 'signed-not-submitted');
    assert.equal(signature.signingPublicKey, world.delegate.publicKey);
    assert.match(signature.requestId, /^[0-9a-f]{64}$/);
    assert.ok(Object.isFrozen(signature));
    // A previously proven identity never substitutes for verifying the next answer: a second signature is verified again.
    await signer.signDelegatedOffer(input(world, { Sequence: 42, LastLedgerSequence: VALIDATED + 2 }));
    assert.deepEqual(calls, { identity: 1, sign: 2 });
  });

  const mismatches: readonly [string, (world: OfferWorld, body: Record<string, unknown>) => unknown][] = [
    ['wrong signer id', (_w, body) => ({ ...body, signerId: 'customer-b-signer-1' })],
    ['changed advertised owner account', (_w, body) => ({ ...body, pairs: [{ ...(body['pairs'] as Record<string, unknown>[])[0], ownerAccount: offerWorld().owner }] })],
    ['changed advertised delegate', (_w, body) => ({ ...body, pairs: [{ ...(body['pairs'] as Record<string, unknown>[])[0], delegateAccount: offerWorld().delegate.address }] })],
    ['changed public key', (_w, body) => ({ ...body, pairs: [{ ...(body['pairs'] as Record<string, unknown>[])[0], signingPublicKey: testDelegate().publicKey }] })],
    ['an extra advertised pair (no adoption, no TOFU)', (_w, body) => ({ ...body, pairs: [...(body['pairs'] as unknown[]), offerWorld().pair] })],
    ['another network', (_w, body) => ({ ...body, network: 'xrp-ledger-devnet' })],
  ];
  for (const [name, rewrite] of mismatches) {
    it(`identity mismatch is permanent: ${name}`, async () => {
      const world = offerWorld();
      const { transport, calls } = referenceTransport(world, { identity: (body) => rewrite(world, body) });
      const signer = client(transport, pinOf(world));
      assert.equal((await signer.probe()).state, 'MISMATCH');
      assert.equal(await refusal(signer.signDelegatedOffer(input(world))), 'OFFER_SIGNER_IDENTITY_MISMATCH');
      assert.equal(calls.sign, 0, 'nothing is ever sent for signing');
      assert.equal((await signer.probe()).state, 'MISMATCH', 'no handshake leaves MISMATCH');
    });
  }

  it('swapped identity: two pairs whose keys are exchanged is a mismatch', async () => {
    const a = offerWorld();
    const b = offerWorld();
    const pin = { signerId: SIGNER_ID, network: 'xrp-ledger-testnet' as const, pairs: [a.pair, b.pair] };
    const { trustDomain, organizationId, issuerKeys } = signerAuthorization();
    const swapped = {
      protocol: DELEGATED_OFFER_SIGNER_PROTOCOL,
      signerId: SIGNER_ID,
      operations: [DELEGATED_OFFER_SIGNER_OPERATION],
      network: 'xrp-ledger-testnet',
      pairs: [{ ...a.pair, signingPublicKey: b.pair.signingPublicKey }, { ...b.pair, signingPublicKey: a.pair.signingPublicKey }],
      authorization: { trustDomain, organizationId, issuerKeyIds: issuerKeys.map((key) => key.keyId) },
    };
    const signer = client({ identity: async () => swapped, signDelegatedOffer: async () => assert.fail('never signs') }, pin);
    assert.equal((await signer.probe()).state, 'MISMATCH');
  });

  it('identity mismatch after prior verification: a rotated key at the signer is refused, never adopted', async () => {
    const world = offerWorld();
    let rotated = false;
    const { transport } = referenceTransport(world, { identity: (body) => (rotated ? { ...body, pairs: [{ ...(body['pairs'] as Record<string, unknown>[])[0], signingPublicKey: testDelegate().publicKey }] } : body) });
    const signer = client(transport, pinOf(world));
    assert.equal((await signer.probe()).state, 'VERIFIED');
    rotated = true;
    assert.equal((await signer.probe()).state, 'MISMATCH');
    assert.equal(await refusal(signer.signDelegatedOffer(input(world))), 'OFFER_SIGNER_IDENTITY_MISMATCH');
  });

  it('unavailability is not mismatch: UNAVAILABLE re-proves the identity before the next signature', async () => {
    const world = offerWorld();
    let down = false;
    const { transport: inner, calls } = referenceTransport(world);
    const transport: DelegatedOfferSignerTransport = {
      identity: async (options) => {
        if (down) throw new DelegatedOfferSignerError('OFFER_SIGNER_UNREACHABLE', 'down');
        return inner.identity(options);
      },
      signDelegatedOffer: async (request, options) => {
        if (down) throw new DelegatedOfferSignerError('OFFER_SIGNER_TIMEOUT', 'down');
        return inner.signDelegatedOffer(request, options);
      },
    };
    const signer = client(transport, pinOf(world));
    assert.equal((await signer.probe()).state, 'VERIFIED');
    down = true;
    assert.equal(await refusal(signer.signDelegatedOffer(input(world))), 'OFFER_SIGNER_TIMEOUT');
    const { trustDomain, organizationId, issuerKeys } = signerAuthorization();
    assert.deepEqual(signer.status(), { signerId: SIGNER_ID, state: 'UNAVAILABLE', reason: 'OFFER_SIGNER_TIMEOUT', pairs: 1, authorization: { trustDomain, organizationId, issuerKeyIds: issuerKeys.map((key) => key.keyId) } });
    assert.equal(await refusal(signer.signDelegatedOffer(input(world))), 'OFFER_SIGNER_NOT_VERIFIED', 'a once-proven identity is not assumed across an outage');
    down = false;
    const before = calls.identity;
    await signer.signDelegatedOffer(input(world));
    assert.equal(calls.identity, before + 1, 'a fresh handshake preceded the signature');
    assert.equal(signer.status().state, 'VERIFIED');
  });

  it('concurrent probes are single-flight', async () => {
    const world = offerWorld();
    let release: () => void = () => undefined;
    let identities = 0;
    const { transport: inner } = referenceTransport(world);
    const transport: DelegatedOfferSignerTransport = {
      identity: async (options) => {
        identities += 1;
        await new Promise<void>((resolve) => (release = resolve));
        return inner.identity(options);
      },
      signDelegatedOffer: inner.signDelegatedOffer,
    };
    const signer = client(transport, pinOf(world));
    const probes = Promise.all([signer.probe(), signer.probe(), signer.probe(), signer.signDelegatedOffer(input(world))]);
    await new Promise((resolve) => setImmediate(resolve));
    release();
    const [first, , , signed] = await probes;
    assert.equal(identities, 1);
    assert.equal(first.state, 'VERIFIED');
    assert.equal((signed as { status: string }).status, 'signed-not-submitted');
  });

  it('bounded signer concurrency: one more than the bound is refused (BUSY), never queued', async () => {
    const world = offerWorld();
    const { transport: inner } = referenceTransport(world);
    const gates: (() => void)[] = [];
    const transport: DelegatedOfferSignerTransport = {
      identity: inner.identity,
      signDelegatedOffer: async (request, options) => {
        await new Promise<void>((resolve) => gates.push(resolve));
        return inner.signDelegatedOffer(request, options);
      },
    };
    const signer = client(transport, pinOf(world), { maximumConcurrentSignatures: 2 });
    await signer.probe();
    const first = signer.signDelegatedOffer(input(world, { Sequence: 1 }));
    const second = signer.signDelegatedOffer(input(world, { Sequence: 2 }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(await refusal(signer.signDelegatedOffer(input(world, { Sequence: 3 }))), 'OFFER_SIGNER_BUSY');
    for (const open of gates) open();
    await Promise.all([first, second]);
  });
});

describe('TRADE-04B D — client: correlation and response verification', () => {
  const crossed: readonly [string, (body: Record<string, unknown>, world: OfferWorld) => Record<string, unknown>, string][] = [
    ['wrong request id', (body) => ({ ...body, requestId: 'ee'.repeat(32) }), 'OFFER_SIGNER_RESPONSE_MISMATCH'],
    ['wrong signer id', (body) => ({ ...body, signerId: 'customer-b-signer-1' }), 'OFFER_SIGNER_RESPONSE_MISMATCH'],
    ['wrong owner', (body) => ({ ...body, ownerAccount: offerWorld().owner }), 'OFFER_SIGNER_RESPONSE_MISMATCH'],
    ['wrong delegate', (body) => ({ ...body, delegateAccount: offerWorld().delegate.address }), 'OFFER_SIGNER_RESPONSE_MISMATCH'],
    ['incorrect hash', (body) => ({ ...body, hash: 'AB'.repeat(32) }), 'OFFER_SIGNER_SIGNATURE_INVALID'],
    ['a blob signed by another key', (body, world) => {
      const signed = testDelegate().sign({ ...world.offer() });
      return { ...body, signedTransaction: signed.blob, hash: signed.hash };
    }, 'OFFER_SIGNER_SIGNATURE_INVALID'],
    ['a blob over another transaction, signed by the pinned key', (body, world) => {
      const signed = world.delegate.sign({ ...world.offer({ TakerGets: '99000000' }) });
      return { ...body, signedTransaction: signed.blob, hash: signed.hash };
    }, 'OFFER_SIGNER_SIGNATURE_INVALID'],
  ];
  for (const [name, rewrite, reason] of crossed) {
    it(`refuses and discards: ${name} → ${reason}, and the client stops signing`, async () => {
      const world = offerWorld();
      const { transport } = referenceTransport(world, { sign: (body) => rewrite(body, world) });
      const signer = client(transport, pinOf(world));
      assert.equal(await refusal(signer.signDelegatedOffer(input(world))), reason);
      assert.equal(signer.status().state, 'MISMATCH');
      assert.equal(await refusal(signer.signDelegatedOffer(input(world))), reason);
    });
  }

  it('a replayed response — a genuine earlier answer for the same transaction — is refused (its request id is not the outstanding one)', async () => {
    const world = offerWorld();
    let recorded: Record<string, unknown> | undefined;
    const { transport } = referenceTransport(world, { sign: (body) => (recorded === undefined ? (recorded = body) : recorded) });
    const signer = client(transport, pinOf(world));
    await signer.signDelegatedOffer(input(world));
    assert.equal(await refusal(signer.signDelegatedOffer(input(world))), 'OFFER_SIGNER_RESPONSE_MISMATCH');
  });

  it('a request id generator that repeats is refused locally; a malformed one too', async () => {
    const world = offerWorld();
    const { transport, calls } = referenceTransport(world);
    const signer = client(transport, pinOf(world), { requestId: () => 'aa'.repeat(32) });
    await signer.signDelegatedOffer(input(world));
    assert.equal(await refusal(signer.signDelegatedOffer(input(world, { Sequence: 50 }))), 'OFFER_SIGNER_REQUEST_INVALID');
    assert.equal(calls.sign, 1);
    const bad = client(referenceTransport(world).transport, pinOf(world), { requestId: () => 'not-hex' });
    assert.equal(await refusal(bad.signDelegatedOffer(input(world))), 'OFFER_SIGNER_REQUEST_INVALID');
  });

  it('a malformed answer is UNAVAILABLE, not a signature', async () => {
    const world = offerWorld();
    const { transport } = referenceTransport(world, { sign: (body) => ({ ...body, extra: 'field' }) });
    const signer = client(transport, pinOf(world));
    assert.equal(await refusal(signer.signDelegatedOffer(input(world))), 'OFFER_SIGNER_MALFORMED_RESPONSE');
    assert.equal(signer.status().state, 'UNAVAILABLE');
  });
});

describe('TRADE-04B D — client: refused locally, before any contact', () => {
  const local: readonly [string, (world: OfferWorld) => object][] = [
    ['not an OfferCreate', (world) => ({ ...input(world), transaction: { ...world.offer(), TransactionType: 'Payment' } })],
    ['wrong owner (not pinned)', (world) => ({ ...input(world), transaction: world.offer({ Account: offerWorld().owner }) })],
    ['wrong delegate (not pinned)', (world) => ({ ...input(world), transaction: world.offer({ Delegate: offerWorld().delegate.address }) })],
    ['fee above the Host ceiling', (world) => input(world, { Fee: '101' })],
    ['LastLedgerSequence at or below the validated ledger', (world) => input(world, { LastLedgerSequence: VALIDATED })],
    ['LastLedgerSequence beyond the horizon', (world) => input(world, { LastLedgerSequence: VALIDATED + 41 })],
    ['no validated ledger index', (world) => {
      const { validatedLedgerIndex: _omitted, ...rest } = input(world);
      return rest;
    }],
    // TRADE-04C-S1: no v1 request survives — a bearer-only request, a missing or malformed capability, or one bound elsewhere is never sent.
    ['a v1 request (audit references, no capability)', (world) => ({ transaction: world.offer(), audit: { executionId: 'exec-1', grantRef: 'grant-1', grantDigest: `sha256:${'ab'.repeat(32)}` }, validatedLedgerIndex: VALIDATED })],
    ['no capability', (world) => {
      const { authorization: _omitted, ...rest } = input(world);
      return rest;
    }],
    ['a malformed capability text', (world) => ({ ...input(world), authorization: { ...input(world).authorization, capability: '{"format":"x"}' } })],
    ['a capability for another transaction (Sequence)', (world) => ({ ...input(world), authorization: capabilityFor(world, world.offer({ Sequence: 99 })).authorization })],
    ['a capability for another price', (world) => ({ ...input(world), authorization: capabilityFor(world, world.offer({ TakerGets: '26000000' })).authorization })],
    ['a proposal whose order is another one', (world) => ({ ...input(world), proposal: capabilityFor(world, world.offer({ TakerGets: '26000000' })).proposal })],
  ];
  for (const [name, build] of local) {
    it(`refuses: ${name} — nothing is sent`, async () => {
      const world = offerWorld();
      const { transport, calls } = referenceTransport(world);
      const signer = client(transport, pinOf(world, { pairs: [world.pair] }));
      const transaction = build(world);
      // The LLS fixture default (1 020) is inside the horizon above 1 000; refusals here come only from the change under test.
      assert.equal(await refusal(signer.signDelegatedOffer(transaction as never)), 'OFFER_SIGNER_REQUEST_INVALID');
      assert.deepEqual(calls, { identity: 0, sign: 0 });
    });
  }
});

describe('TRADE-04B D — configuration: pins, endpoints and credentials', () => {
  it('pins: duplicate pair, duplicate signer id and one pair under two signers are refused; customers cannot share a pin silently', () => {
    const a = offerWorld();
    const b = offerWorld();
    const pin = pinOf(a);
    assert.throws(() => client({ identity: async () => ({}), signDelegatedOffer: async () => ({}) }, { ...pin, pairs: [a.pair, a.pair] }), DelegatedOfferSignerConfigurationError);
    assert.throws(() => validateDelegatedOfferSignerPins([pin, { ...pinOf(b), signerId: SIGNER_ID }]), /repeats a signer id/);
    assert.throws(() => validateDelegatedOfferSignerPins([pin, { ...pinOf(a), signerId: 'customer-b-signer-1' }]), /another signer already serves/);
    assert.equal(validateDelegatedOfferSignerPins([pin, { ...pinOf(b), signerId: 'customer-b-signer-1' }]).length, 2);
    for (const bad of [{ ...pin, network: 'xrp-ledger-mainnet' }, { ...pin, signerId: '' }, { ...pin, pairs: [] }, { ...pin, pairs: [{ ...a.pair, delegateAccount: a.owner }] }, { ...pin, pairs: [{ ...a.pair, signingPublicKey: 'ab' }] }]) {
      assert.throws(() => client({ identity: async () => ({}), signDelegatedOffer: async () => ({}) }, bad as DelegatedOfferSignerPin), DelegatedOfferSignerConfigurationError);
    }
  });

  it('client bounds: timeout, fee ceiling and ledger horizon are validated', () => {
    const world = offerWorld();
    const transport = { identity: async () => ({}), signDelegatedOffer: async () => ({}) };
    for (const overrides of [{ timeoutMs: 0 }, { timeoutMs: 60_001 }, { maximumFeeDrops: '0' }, { maximumFeeDrops: '1000001' }, { maximumFeeDrops: 100 }, { maximumLedgerHorizon: 0 }, { maximumLedgerHorizon: 1_001 }, { maximumConcurrentSignatures: 0 }]) {
      assert.throws(() => client(transport, pinOf(world), overrides), DelegatedOfferSignerConfigurationError, JSON.stringify(overrides));
    }
  });

  it('endpoints: https anywhere; plain http to a literal loopback only; no credential, query, fragment or path', () => {
    for (const ok of ['https://signer.customer.example', 'https://signer.customer.example:8443/', 'http://127.0.0.1:7000', 'http://127.1.2.3', 'http://[::1]:7000']) assert.equal(delegatedOfferSignerEndpointProblem(ok), undefined, ok);
    for (const bad of ['http://localhost:7000', 'http://signer.customer.example', 'http://10.0.0.5:7000', 'http://[::ffff:127.0.0.1]:7000', 'http://0.0.0.0:7000', 'https://user:pass@signer.example', 'https://signer.example/?token=x', 'https://signer.example/#x', 'https://signer.example/v1', 'ftp://signer.example', 'not a url', 42]) {
      assert.notEqual(delegatedOfferSignerEndpointProblem(bad), undefined, String(bad));
    }
    assert.throws(() => createHttpDelegatedOfferSignerTransport({ endpoint: 'http://localhost:1', credential: CREDENTIAL }), DelegatedOfferSignerConfigurationError);
    assert.throws(() => createHttpDelegatedOfferSignerTransport({ endpoint: 'http://127.0.0.1:1', credential: 'short' }), DelegatedOfferSignerConfigurationError);
    assert.throws(() => createHttpDelegatedOfferSignerTransport({ endpoint: 'http://127.0.0.1:1', credential: `${CREDENTIAL} x` }), DelegatedOfferSignerConfigurationError);
  });

  it('a configuration error names the rule, never the value', () => {
    const secretish = 'https://user:SuperSecretToken123@signer.example';
    try {
      createHttpDelegatedOfferSignerTransport({ endpoint: secretish, credential: CREDENTIAL });
      assert.fail('refused');
    } catch (error) {
      assert.equal(String((error as Error).message).includes('SuperSecretToken123'), false);
    }
    try {
      createHttpDelegatedOfferSignerTransport({ endpoint: 'http://127.0.0.1:1', credential: 'short-secret' });
      assert.fail('refused');
    } catch (error) {
      assert.equal(String((error as Error).message).includes('short-secret'), false);
    }
  });
});

/** A hostile loopback server answering every request with `respond`. */
async function hostile(respond: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ readonly endpoint: string; readonly seen: string[]; close(): Promise<void> }> {
  const seen: string[] = [];
  const server: Server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url} ${req.headers.authorization === `Bearer ${CREDENTIAL}` ? 'auth' : 'no-auth'}`);
    respond(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    endpoint: `http://127.0.0.1:${port}`,
    seen,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

describe('TRADE-04B D — HTTP transport against the real reference signer and hostile servers (loopback only)', () => {
  it('the real reference signer on loopback: verified, signed, and a wrong credential is AUTHENTICATION_FAILED', async () => {
    const world = offerWorld();
    const ledger = await tempCapabilityLedger();
    ledger.ledger.close();
    const { consumption: _unused, ...s1 } = s1ReferenceOptions();
    const reference = await startReferenceDelegatedOfferSigner({ ...s1, consumptionLedgerPath: ledger.path, signerId: SIGNER_ID, network: 'xrp-ledger-testnet', credential: CREDENTIAL, keys: [{ ownerAccount: world.owner, delegateSeed: world.delegate.seed }], maximumFeeDrops: '100' });
    try {
      const endpoint = `http://127.0.0.1:${reference.port}`;
      const signer = client(createHttpDelegatedOfferSignerTransport({ endpoint, credential: CREDENTIAL }), pinOf(world));
      const signature = await signer.signDelegatedOffer(input(world));
      assert.equal(signature.status, 'signed-not-submitted');
      assert.equal(reference.signatures(), 1);
      const wrong = client(createHttpDelegatedOfferSignerTransport({ endpoint, credential: `${CREDENTIAL}-other` }), pinOf(world));
      assert.equal((await wrong.probe()).reason, 'OFFER_SIGNER_AUTHENTICATION_FAILED');
      assert.equal(wrong.status().state, 'UNAVAILABLE', 'a credential mismatch is unavailability, not an identity mismatch');
    } finally {
      await reference.close();
      ledger.cleanup();
    }
  });

  it('a rotated reference key (restart with a new delegate key, same signer id) is a mismatch, never adopted', async () => {
    const world = offerWorld();
    const ledger = await tempCapabilityLedger();
    ledger.ledger.close();
    const { consumption: _unused, ...s1 } = s1ReferenceOptions();
    const first = await startReferenceDelegatedOfferSigner({ ...s1, consumptionLedgerPath: ledger.path, signerId: SIGNER_ID, network: 'xrp-ledger-testnet', credential: CREDENTIAL, keys: [{ ownerAccount: world.owner, delegateSeed: world.delegate.seed }], maximumFeeDrops: '100' });
    const port = first.port;
    const signer = client(createHttpDelegatedOfferSignerTransport({ endpoint: `http://127.0.0.1:${port}`, credential: CREDENTIAL }), pinOf(world));
    assert.equal((await signer.probe()).state, 'VERIFIED');
    await first.close();
    const rotated = await startReferenceDelegatedOfferSigner({ ...s1, consumptionLedgerPath: ledger.path, signerId: SIGNER_ID, network: 'xrp-ledger-testnet', credential: CREDENTIAL, keys: [{ ownerAccount: world.owner, delegateSeed: testDelegate().seed }], maximumFeeDrops: '100', port });
    try {
      assert.equal((await signer.probe()).state, 'MISMATCH');
    } finally {
      await rotated.close();
      ledger.cleanup();
    }
  });

  const statuses: readonly [string, number, string][] = [
    ['HTTP 401', 401, 'OFFER_SIGNER_AUTHENTICATION_FAILED'],
    ['HTTP 403', 403, 'OFFER_SIGNER_AUTHENTICATION_FAILED'],
    ['HTTP 429', 429, 'OFFER_SIGNER_UNAVAILABLE'],
    ['HTTP 500', 500, 'OFFER_SIGNER_UNAVAILABLE'],
    ['HTTP 302 redirect (never followed)', 302, 'OFFER_SIGNER_REFUSED'],
    ['HTTP 307 redirect (never followed)', 307, 'OFFER_SIGNER_REFUSED'],
    ['HTTP 204', 204, 'OFFER_SIGNER_MALFORMED_RESPONSE'],
  ];
  for (const [name, status, reason] of statuses) {
    it(`${name} → ${reason}; a refusal body with a secret-shaped string is never echoed`, async () => {
      const server = await hostile((_req, res) => {
        res.writeHead(status, { 'content-type': 'application/json', location: 'http://127.0.0.1:1/elsewhere' });
        res.end(JSON.stringify({ error: 'Bearer sk_live_LEAKED_SECRET seed sEdLEAKEDSEED' }));
      });
      try {
        const transport = createHttpDelegatedOfferSignerTransport({ endpoint: server.endpoint, credential: CREDENTIAL });
        const error = await transport.identity({ timeoutMs: 2_000 }).then(
          () => assert.fail('refused'),
          (caught: unknown) => caught as DelegatedOfferSignerError,
        );
        assert.equal(error.reason, reason);
        assert.equal(/LEAKED|sk_live|sEd/.test(`${error.message} ${error.stack ?? ''}`), false);
        assert.equal(server.seen.length, 1, 'one request, no redirect followed, no retry');
      } finally {
        await server.close();
      }
    });
  }

  it('invalid JSON, a non-JSON content type and an oversized response are MALFORMED_RESPONSE', async () => {
    for (const respond of [
      (_req: IncomingMessage, res: ServerResponse) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{not json');
      },
      (_req: IncomingMessage, res: ServerResponse) => {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('{}');
      },
      (_req: IncomingMessage, res: ServerResponse) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ padding: 'x'.repeat(17 * 1024) }));
      },
    ]) {
      const server = await hostile(respond);
      try {
        const transport = createHttpDelegatedOfferSignerTransport({ endpoint: server.endpoint, credential: CREDENTIAL });
        assert.equal(await refusal(transport.identity({ timeoutMs: 2_000 })), 'OFFER_SIGNER_MALFORMED_RESPONSE');
      } finally {
        await server.close();
      }
    }
  });

  it('a timeout destroys the request: one attempt within one budget', async () => {
    const server = await hostile(() => undefined);
    try {
      const transport = createHttpDelegatedOfferSignerTransport({ endpoint: server.endpoint, credential: CREDENTIAL });
      const started = Date.now();
      assert.equal(await refusal(transport.identity({ timeoutMs: 150 })), 'OFFER_SIGNER_TIMEOUT');
      assert.ok(Date.now() - started < 2_000);
      assert.equal(server.seen.length, 1);
    } finally {
      await server.close();
    }
  });

  it('an unreachable endpoint is UNREACHABLE, and the client is UNAVAILABLE (not MISMATCH)', async () => {
    const server = await hostile(() => undefined);
    const endpoint = server.endpoint;
    await server.close();
    const world = offerWorld();
    const signer = client(createHttpDelegatedOfferSignerTransport({ endpoint, credential: CREDENTIAL }), pinOf(world));
    assert.deepEqual(await signer.probe(), { signerId: SIGNER_ID, state: 'UNAVAILABLE', reason: 'OFFER_SIGNER_UNREACHABLE', pairs: 1 });
  });

  it('an oversized request is refused before anything is sent', async () => {
    const server = await hostile((_req, res) => res.end());
    try {
      const transport = createHttpDelegatedOfferSignerTransport({ endpoint: server.endpoint, credential: CREDENTIAL });
      const world = offerWorld();
      const request = { protocol: DELEGATED_OFFER_SIGNER_PROTOCOL, signerId: SIGNER_ID, requestId: 'ab'.repeat(32), network: 'xrp-ledger-testnet', ownerAccount: world.owner, delegateAccount: world.delegate.address, transaction: world.offer(), proposal: input(world).proposal, authorization: { ...input(world).authorization, capability: 'x'.repeat(17 * 1024) } } as unknown as DelegatedOfferSigningRequest;
      assert.equal(await refusal(transport.signDelegatedOffer(request, { timeoutMs: 1_000 })), 'OFFER_SIGNER_REQUEST_INVALID');
      assert.equal(server.seen.length, 0);
    } finally {
      await server.close();
    }
  });

  it('the credential travels only in the authorization header: never in the URL or the body', async () => {
    const bodies: string[] = [];
    const server = await hostile((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
      req.on('end', () => {
        bodies.push(`${req.url} ${body}`);
        res.writeHead(500);
        res.end();
      });
    });
    try {
      const world = offerWorld();
      const transport = createHttpDelegatedOfferSignerTransport({ endpoint: server.endpoint, credential: CREDENTIAL });
      await refusal(transport.signDelegatedOffer({ protocol: DELEGATED_OFFER_SIGNER_PROTOCOL, signerId: SIGNER_ID, requestId: 'ab'.repeat(32), network: 'xrp-ledger-testnet', ownerAccount: world.owner, delegateAccount: world.delegate.address, transaction: world.offer(), proposal: input(world).proposal, authorization: input(world).authorization }, { timeoutMs: 2_000 }));
      assert.deepEqual(server.seen, ['POST /v1/sign/xrpl-delegated-offer auth']);
      assert.equal(bodies.some((body) => body.includes(CREDENTIAL)), false);
      assert.equal(JSON.stringify(transport).includes(CREDENTIAL), false, 'the transport object exposes no credential');
    } finally {
      await server.close();
    }
  });
});
