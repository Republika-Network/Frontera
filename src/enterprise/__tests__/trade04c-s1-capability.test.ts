import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createGrantIssuanceService, type BoundedGrant, type GrantCorrelation, type GrantScope, type GrantSourceAuthorization } from '../../features/grant-runtime/index.js';
import { TRADE_PARAMETER_DIMENSION_IDS } from '../../features/trade-runtime/index.js';
import {
  AUTHORITY_SIGNING_DOMAINS,
  DELEGATED_OFFER_CAPABILITY_LIMITS,
  DELEGATED_OFFER_GRANT_DIMENSIONS,
  DelegatedOfferCapabilityError,
  assessDelegatedOfferCapabilityIssuance,
  createDelegatedOfferCapabilityIssuer,
  createDelegatedOfferCapabilityIssuerSlot,
  delegatedOfferCapabilitySigningBytes,
  grantSigningBytes,
  parseDelegatedOfferCapability,
  serializeDelegatedOfferCapability,
  type AuthoritySignature,
  type DelegatedOfferCapability,
  type DelegatedOfferCapabilityIssuanceInput,
  type SignedGrantReader,
} from '../authority-authenticity/index.js';
import { EXTERNAL_AUTHORITY_SIGNER_EXTENSION_PATHS, EXTERNAL_AUTHORITY_SIGNER_OPERATIONS, createHttpExternalAuthoritySignerTransport, establishExternalAuthorityArtifactSigner } from '../external-authority-signer/index.js';
import { startReferenceAuthoritySigner } from '../external-authority-signer/reference/reference-signer-service.js';
import { AUTHORITY_KEY_A, AUTHORITY_KEY_B, openDurableStore, testSigner, testVerifier, trustedKeyOf } from './authority-authenticity-fixture.js';
import { offerWorld } from './trade04b-xrpl-fixture.js';
import { S1_ORGANIZATION, S1_TRUST_DOMAIN, capabilityFor, signCapability, testCapabilityIssuer, tradeGrantFor } from './trade04c-s1-capability-fixture.js';
import { executorRig, rawProposal, validatedAction, type ExecutorRig } from './trade04c-execution-fixture.js';

/**
 * TRADE-04C-S1 — the CORE-02 delegated-offer signing capability: the artifact,
 * its own signing domain, the custody issuance rule over real signed grants,
 * the Host-side issuer and its write-once slot, the authenticated
 * signed-grant read, the external custody extension (in process and over the
 * loopback reference service), and the executor's use of it.
 */

const workDir = mkdtempSync(join(tmpdir(), 'trade04c-s1-capability-'));
after(() => rmSync(workDir, { recursive: true, force: true }));

const STORE = 'grant-store-trade04c-s1';
const world = offerWorld();
const offer = world.offer();

/** A capability bound to a real signed trade grant (key A): the grant, its signature and the capability the issuer would sign. */
async function grantBound(options: { readonly capability?: Partial<Record<keyof DelegatedOfferCapability, unknown>>; readonly grant?: Parameters<typeof tradeGrantFor>[1]; readonly now?: number } = {}) {
  const authorized = capabilityFor(world, offer, { ...(options.now !== undefined ? { now: options.now } : {}) });
  const grant = tradeGrantFor(authorized.proposal, options.grant);
  const grantSignature = await testSigner(AUTHORITY_KEY_A).signGrant(grant, STORE);
  const capability = Object.freeze({ ...authorized.capability, issuerKeyId: AUTHORITY_KEY_A.keyId, organizationId: S1_ORGANIZATION, grantStoreId: STORE, boundedGrantId: grant.id, grantDigest: grant.digest, ...options.capability }) as DelegatedOfferCapability;
  return { grant, grantSignature, capability, request: { capability, grant, storeId: STORE, grantSignature } };
}

const ownRule = (now = Date.now()) => ({ verifyGrant: testVerifier([AUTHORITY_KEY_A]).verifyGrant, activeKeyId: AUTHORITY_KEY_A.keyId, now });

describe('TRADE-04C-S1 — the capability artifact and its signing domain', () => {
  it('canonical, closed and round-trip exact: a re-ordered, re-spaced or extended record is refused, never normalized', async () => {
    const { capability } = await grantBound();
    const canonical = serializeDelegatedOfferCapability(capability);
    assert.deepEqual(parseDelegatedOfferCapability(canonical), capability);
    const parsed = JSON.parse(canonical) as Record<string, unknown>;
    const reordered = JSON.stringify(Object.fromEntries(Object.entries(parsed).reverse()));
    for (const variant of [reordered, ` ${canonical}`, JSON.stringify(parsed, null, 1), JSON.stringify({ ...parsed, extra: 1 }), JSON.stringify({ ...parsed, network: 'xrp-ledger-mainnet' }), JSON.stringify({ ...parsed, sequence: '41' }), JSON.stringify({ ...parsed, issuedAt: '2026-10-15T00:00:00Z' }), JSON.stringify({ ...parsed, capabilityId: 'AB'.repeat(32) })]) {
      assert.equal(parseDelegatedOfferCapability(variant), undefined, variant.slice(0, 60));
    }
  });

  it('its own domain: a capability signature is not a grant signature, nor the reverse; the domain is distinct from every other authority artifact', async () => {
    const { capability, grant, grantSignature } = await grantBound();
    const domains = Object.values(AUTHORITY_SIGNING_DOMAINS);
    assert.equal(new Set(domains).size, domains.length);
    assert.equal(AUTHORITY_SIGNING_DOMAINS.delegatedOfferCapability, 'frontera:authority-artifact:xrpl-delegated-offer-capability:v1\n');
    for (const other of domains.filter((domain) => domain !== AUTHORITY_SIGNING_DOMAINS.delegatedOfferCapability)) assert.equal(AUTHORITY_SIGNING_DOMAINS.delegatedOfferCapability.startsWith(other) || other.startsWith(AUTHORITY_SIGNING_DOMAINS.delegatedOfferCapability), false);
    assert.ok(delegatedOfferCapabilitySigningBytes(capability).toString('utf8').startsWith(AUTHORITY_SIGNING_DOMAINS.delegatedOfferCapability));
    const verifier = testVerifier([AUTHORITY_KEY_A]);
    const capabilitySignature = signCapability(capability, AUTHORITY_KEY_A);
    assert.equal(verifier.verifyDelegatedOfferCapability(capability, capabilitySignature).verified, true);
    assert.equal(verifier.verifyDelegatedOfferCapability(capability, grantSignature).verified, false, 'a grant signature does not authorize a signature');
    assert.equal(verifier.verifyGrant(grant, STORE, capabilitySignature).verified, false, 'a capability signature is not a grant');
    assert.ok(grantSigningBytes(grant, STORE).toString('utf8').startsWith(AUTHORITY_SIGNING_DOMAINS.grant));
    assert.equal(verifier.verifyDelegatedOfferCapability({ ...capability, extra: 1 } as unknown as DelegatedOfferCapability, capabilitySignature).verified, false, 'a malformed capability is refused before any key');
  });

  it('every bound field is covered: changing any one invalidates the signature', async () => {
    const { capability } = await grantBound();
    const signature = signCapability(capability, AUTHORITY_KEY_A);
    const verifier = testVerifier([AUTHORITY_KEY_A]);
    const changes: Partial<Record<keyof DelegatedOfferCapability, unknown>> = {
      capabilityId: 'cd'.repeat(32),
      issuerKeyId: 'authority-key-b',
      organizationId: 'org-other',
      trustDomain: 'trust-domain-other',
      grantStoreId: 'grant-store-other',
      executionId: 'exec-other',
      boundedGrantId: 'grant-other',
      grantDigest: `sha256:${'1'.repeat(64)}`,
      proposalDigest: `sha256:${'2'.repeat(64)}`,
      signingPreimageDigest: `sha256:${'3'.repeat(64)}`,
      network: 'xrp-ledger-devnet',
      ownerAccount: offerWorld().owner,
      delegateAccount: offerWorld().delegate.address,
      sequence: capability.sequence + 1,
      fee: '13',
      lastLedgerSequence: capability.lastLedgerSequence + 1,
      issuedAt: new Date(Date.parse(capability.issuedAt) - 1).toISOString(),
      expiresAt: new Date(Date.parse(capability.expiresAt) + 1).toISOString(),
    };
    for (const [field, value] of Object.entries(changes)) {
      const changed = { ...capability, [field]: value } as DelegatedOfferCapability;
      assert.equal(verifier.verifyDelegatedOfferCapability(changed, signature).verified, false, field);
    }
    assert.equal(Object.keys(changes).length, Object.keys(capability).length - 2, 'every field but the fixed format and operation literals');
  });

  it('the custody rule reads TRADE-03’s own dimension ids (named as data in CORE, pinned equal here)', () => {
    assert.equal(DELEGATED_OFFER_GRANT_DIMENSIONS.proposalDigest, TRADE_PARAMETER_DIMENSION_IDS.proposalDigest);
    assert.equal(DELEGATED_OFFER_GRANT_DIMENSIONS.network, TRADE_PARAMETER_DIMENSION_IDS.network);
    assert.equal(DELEGATED_OFFER_GRANT_DIMENSIONS.delegateAccount, TRADE_PARAMETER_DIMENSION_IDS.delegateAccount);
  });
});

describe('TRADE-04C-S1 — the custody issuance rule: a capability only for a grant the same key signed, naming exactly what it binds', () => {
  it('a capability for its grant is issuable', async () => {
    const { request } = await grantBound();
    assert.deepEqual(assessDelegatedOfferCapabilityIssuance(request, ownRule()), { issuable: true });
  });

  const refusals: readonly [string, () => Promise<Parameters<typeof assessDelegatedOfferCapabilityIssuance>[0]>, string, number?][] = [
    ['a grant signed by another key', async () => ({ ...(await grantBound()).request, grantSignature: await testSigner(AUTHORITY_KEY_B).signGrant((await grantBound()).grant, STORE) }), 'GRANT_SIGNATURE_INVALID'],
    ['a grant whose bytes changed after signing (digest recomputed)', async () => {
      const bound = await grantBound();
      // A writer rewrites the grant (another resource) and recomputes its id and digest consistently: only the signature notices.
      const altered = tradeGrantFor(capabilityFor(world, offer).proposal, { scope: { resources: { kind: 'set', values: [`xrp-ledger-testnet:${offerWorld().owner}`] } } });
      return { ...bound.request, grant: altered };
    }, 'GRANT_SIGNATURE_INVALID'],
    ['a grant with no signature', async () => ({ ...(await grantBound()).request, grantSignature: undefined }), 'GRANT_SIGNATURE_INVALID'],
    ['a grant whose digest does not match', async () => {
      const bound = await grantBound();
      return { ...bound.request, grant: { ...bound.grant, digest: `sha256:${'0'.repeat(64)}` } };
    }, 'GRANT_MALFORMED'],
    ['another grant than the capability names', async () => (await grantBound({ capability: { boundedGrantId: 'grant-other' } })).request, 'GRANT_IDENTITY_MISMATCH'],
    ['another grant digest', async () => (await grantBound({ capability: { grantDigest: `sha256:${'9'.repeat(64)}` } })).request, 'GRANT_IDENTITY_MISMATCH'],
    ['a grant filed in another store', async () => ({ ...(await grantBound()).request, storeId: 'grant-store-other' }), 'GRANT_SIGNATURE_INVALID'],
    ['a capability naming another store', async () => (await grantBound({ capability: { grantStoreId: 'grant-store-other' } })).request, 'GRANT_STORE_MISMATCH'],
    ['another organization', async () => (await grantBound({ capability: { organizationId: 'org-other' } })).request, 'GRANT_ORGANIZATION_MISMATCH'],
    ['another owner (resource)', async () => (await grantBound({ capability: { ownerAccount: offerWorld().owner } })).request, 'GRANT_RESOURCE_MISMATCH'],
    ['another network', async () => (await grantBound({ capability: { network: 'xrp-ledger-devnet' } })).request, 'GRANT_RESOURCE_MISMATCH'],
    ['another proposal (price or quantity changed after the grant)', async () => (await grantBound({ capability: { proposalDigest: capabilityFor(world, world.offer({ TakerGets: '26000000' })).capability.proposalDigest } })).request, 'GRANT_TERMS_MISMATCH'],
    ['another delegate', async () => (await grantBound({ capability: { delegateAccount: offerWorld().delegate.address } })).request, 'GRANT_TERMS_MISMATCH'],
    ['an expired grant', async () => (await grantBound({ grant: { issuedAt: new Date(Date.now() - 120_000).toISOString(), expiresAt: new Date(Date.now() - 1).toISOString() } })).request, 'GRANT_EXPIRED'],
    ['a capability outliving its grant', async () => (await grantBound({ grant: { expiresAt: new Date(Date.now() + 10_000).toISOString() } })).request, 'CAPABILITY_TIME_INVALID'],
    ['a lifetime above the maximum', async () => {
      const bound = await grantBound();
      return { ...bound.request, capability: { ...bound.capability, expiresAt: new Date(Date.parse(bound.capability.issuedAt) + DELEGATED_OFFER_CAPABILITY_LIMITS.maximumLifetimeMs + 1).toISOString() } };
    }, 'CAPABILITY_TIME_INVALID'],
    ['an issuance instant far from the custody clock', async () => (await grantBound({ now: Date.now() - 60_000 })).request, 'CAPABILITY_TIME_INVALID'],
    ['an issuer key id that is not the custody boundary’s', async () => (await grantBound({ capability: { issuerKeyId: AUTHORITY_KEY_B.keyId } })).request, 'CAPABILITY_ISSUER_MISMATCH'],
    ['a malformed capability', async () => (await grantBound({ capability: { sequence: 0 } })).request, 'CAPABILITY_MALFORMED'],
  ];
  for (const [name, build, failure] of refusals) {
    it(`refuses: ${name} → ${failure}`, async () => {
      const assessment = assessDelegatedOfferCapabilityIssuance(await build(), ownRule());
      assert.deepEqual(assessment, { issuable: false, failure });
    });
  }

  it('the software signer applies the rule inside its boundary: it signs only what the rule accepts (no free capability oracle)', async () => {
    const signer = testSigner(AUTHORITY_KEY_A);
    const { request } = await grantBound();
    const signature = await signer.signDelegatedOfferCapability!(request);
    assert.equal(testVerifier([AUTHORITY_KEY_A]).verifyDelegatedOfferCapability(request.capability, signature).verified, true);
    const forOtherProposal = (await grantBound({ capability: { proposalDigest: `sha256:${'7'.repeat(64)}` } })).request;
    await assert.rejects(signer.signDelegatedOfferCapability!(forOtherProposal), (error: { reason?: string }) => error.reason === 'EXTERNAL_SIGNER_REFUSED');
    await assert.rejects(testSigner(AUTHORITY_KEY_B).signDelegatedOfferCapability!(request), (error: { reason?: string }) => error.reason === 'EXTERNAL_SIGNER_REFUSED', 'key B never signs a capability for a grant key A signed');
  });
});

describe('TRADE-04C-S1 — the Host-side issuer and its write-once slot', () => {
  const input = (capability: DelegatedOfferCapability): DelegatedOfferCapabilityIssuanceInput => ({
    trustDomain: S1_TRUST_DOMAIN,
    executionId: capability.executionId,
    boundedGrantId: capability.boundedGrantId,
    organizationId: capability.organizationId,
    proposalDigest: capability.proposalDigest,
    network: capability.network,
    ownerAccount: capability.ownerAccount,
    delegateAccount: capability.delegateAccount,
    signingPreimageDigest: capability.signingPreimageDigest,
    sequence: capability.sequence,
    fee: capability.fee,
    lastLedgerSequence: capability.lastLedgerSequence,
  });
  const reader = (read: Awaited<ReturnType<SignedGrantReader['readSigned']>> | Error): SignedGrantReader => ({ readSigned: async () => (read instanceof Error ? Promise.reject(read) : read) });

  it('issues for an authenticated, unrevoked, unexpired grant; the capability verifies under the active key, lives ≤ its lifetime and never past the grant', async () => {
    const bound = await grantBound({ grant: { expiresAt: new Date(Date.now() + 10_000).toISOString() } });
    const issuer = createDelegatedOfferCapabilityIssuer({ grants: reader({ storeId: STORE, grant: bound.grant, signature: bound.grantSignature as AuthoritySignature }), signer: testSigner(AUTHORITY_KEY_A), verifier: testVerifier([AUTHORITY_KEY_A]) });
    const issued = await issuer.issue(input(bound.capability));
    assert.equal(issued.capability.grantStoreId, STORE);
    assert.equal(issued.capability.grantDigest, bound.grant.digest);
    assert.equal(issued.capability.issuerKeyId, AUTHORITY_KEY_A.keyId);
    assert.match(issued.capability.capabilityId, /^[0-9a-f]{64}$/);
    assert.equal(issued.capability.expiresAt, bound.grant.expiresAt, 'clamped to the grant');
    assert.equal(issued.canonical, serializeDelegatedOfferCapability(issued.capability));
    assert.equal(testVerifier([AUTHORITY_KEY_A]).verifyDelegatedOfferCapability(issued.capability, issued.signature).verified, true);
    const again = await issuer.issue(input(bound.capability));
    assert.notEqual(again.capability.capabilityId, issued.capability.capabilityId, 'a fresh single-use id per issuance');
  });

  const refusals: readonly [string, (bound: Awaited<ReturnType<typeof grantBound>>) => SignedGrantReader, string][] = [
    ['the store cannot read and verify', () => reader(new Error('BOUNDED_GRANT_STORE_CORRUPT')), 'CAPABILITY_GRANT_UNAVAILABLE'],
    ['no grant filed under that id', () => reader({ storeId: STORE }), 'CAPABILITY_GRANT_NOT_FOUND'],
    ['a revoked grant', (bound) => reader({ storeId: STORE, grant: bound.grant, signature: bound.grantSignature as AuthoritySignature, revocation: { grantId: bound.grant.id, revokedAt: new Date().toISOString(), reason: 'security-incident' as never, issuerRef: 'operator' } }), 'CAPABILITY_GRANT_REVOKED'],
    ['a grant for another proposal', (bound) => reader({ storeId: STORE, grant: tradeGrantFor(capabilityFor(world, world.offer({ TakerGets: '26000000' })).proposal), signature: bound.grantSignature as AuthoritySignature }), 'CAPABILITY_REFUSED'],
  ];
  for (const [name, build, code] of refusals) {
    it(`refuses before any signing call: ${name} → ${code}`, async () => {
      const bound = await grantBound();
      let signed = 0;
      const signer = testSigner(AUTHORITY_KEY_A);
      const counting = { ...signer, signDelegatedOfferCapability: async (request: Parameters<NonNullable<typeof signer.signDelegatedOfferCapability>>[0]) => ((signed += 1), signer.signDelegatedOfferCapability!(request)) };
      const issuer = createDelegatedOfferCapabilityIssuer({ grants: build(bound), signer: counting, verifier: testVerifier([AUTHORITY_KEY_A]) });
      await assert.rejects(issuer.issue(input(bound.capability)), (error: unknown) => error instanceof DelegatedOfferCapabilityError && error.code === code);
      assert.equal(signed, 0);
    });
  }

  it('a signer without the operation, a signer that fails, or a signature that does not verify: no capability', async () => {
    const bound = await grantBound();
    const grants = reader({ storeId: STORE, grant: bound.grant, signature: bound.grantSignature as AuthoritySignature });
    const { signDelegatedOfferCapability: _none, ...withoutOperation } = testSigner(AUTHORITY_KEY_A);
    await assert.rejects(createDelegatedOfferCapabilityIssuer({ grants, signer: withoutOperation, verifier: testVerifier([AUTHORITY_KEY_A]) }).issue(input(bound.capability)), { code: 'CAPABILITY_ISSUER_UNSUPPORTED' });
    const failing = { ...testSigner(AUTHORITY_KEY_A), signDelegatedOfferCapability: async () => Promise.reject(new Error('down')) };
    await assert.rejects(createDelegatedOfferCapabilityIssuer({ grants, signer: failing, verifier: testVerifier([AUTHORITY_KEY_A]) }).issue(input(bound.capability)), { code: 'CAPABILITY_SIGNING_UNAVAILABLE' });
    const forging = { ...testSigner(AUTHORITY_KEY_A), signDelegatedOfferCapability: async (request: { readonly capability: DelegatedOfferCapability }) => signCapability(request.capability, AUTHORITY_KEY_B, AUTHORITY_KEY_A.keyId) };
    await assert.rejects(createDelegatedOfferCapabilityIssuer({ grants, signer: forging, verifier: testVerifier([AUTHORITY_KEY_A]) }).issue(input(bound.capability)), { code: 'CAPABILITY_SIGNATURE_INVALID' });
  });

  it('the slot refuses until bound, binds exactly once, and then forwards', async () => {
    const slot = createDelegatedOfferCapabilityIssuerSlot();
    assert.equal(slot.bound(), false);
    const bound = await grantBound();
    await assert.rejects(slot.issue(input(bound.capability)), { code: 'CAPABILITY_ISSUER_UNBOUND' });
    const issuer = testCapabilityIssuer();
    slot.bind(issuer);
    assert.equal(slot.bound(), true);
    assert.throws(() => slot.bind(issuer), { code: 'CAPABILITY_REQUEST_INVALID' });
    assert.equal((await slot.issue(input(bound.capability))).capability.executionId, bound.capability.executionId);
    assert.equal(issuer.issued.length, 1);
  });
});

describe('TRADE-04C-S1 — the authenticated signed-grant read (no schema change)', () => {
  const CORRELATION: GrantCorrelation = { requestId: 'req-s1', decisionId: 'dec-s1', action: 'payment.send', resourceScope: 'record:contract' };
  const SCOPE: GrantScope = { action: { kind: 'identity', value: 'payment.send' }, resources: { kind: 'set', values: ['record:contract'] } };
  const SOURCE: GrantSourceAuthorization = { correlation: CORRELATION, subject: 'actor-a', scope: SCOPE, authorizationPermitsExercise: true, allBlockingObligationsSatisfied: true, evaluatedAt: '2026-01-01T12:00:00.000Z', validityCeilings: [] };

  it('readSigned answers the same verified grant as read, its store id and its verified signature; a revoked grant carries its revocation; an absent one only the store id', async () => {
    const store = await openDurableStore(join(workDir, 'signed-read.sqlite'));
    try {
      const outcome = await createGrantIssuanceService({ store }).issueGrant({ source: SOURCE, subject: 'actor-a', correlation: CORRELATION, issuedAt: '2026-01-01T12:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z' });
      assert.equal(outcome.outcome, 'issued');
      const grant = (outcome as { grant: BoundedGrant }).grant;
      const signed = await store.readSigned(grant.id);
      assert.deepEqual(signed.grant, (await store.read(grant.id)).grant);
      assert.ok(signed.signature !== undefined && signed.storeId.length > 0);
      assert.equal(testVerifier([AUTHORITY_KEY_A]).verifyGrant(signed.grant!, signed.storeId, signed.signature).verified, true, 'the envelope verifies under the store id it is filed with');
      const absent = await store.readSigned('grant-none');
      assert.deepEqual(absent, { storeId: signed.storeId });
      await store.revoke({ grantId: grant.id, reason: 'security-incident' as never, revokedAt: '2026-01-01T12:01:00.000Z', issuerRef: 'operator' });
      assert.equal((await store.readSigned(grant.id)).revocation?.grantId, grant.id);
    } finally {
      await store.close();
    }
  });
});

describe('TRADE-04C-S1 — the external custody extension (CORE-02 protocol, opt-in, exact)', () => {
  it('a deployment requiring the extension establishes against a service offering exactly the five plus it, and signs a capability through it — only for a grant its key signed', async () => {
    const credential = 'trade04c-s1-authority-credential-0123456789abcdef';
    const service = await startReferenceAuthoritySigner({ keyId: AUTHORITY_KEY_A.keyId, privateKeyPem: AUTHORITY_KEY_A.privateKeyPem, credential, extensions: ['signDelegatedOfferCapability'] });
    try {
      const transport = createHttpExternalAuthoritySignerTransport({ endpoint: `http://127.0.0.1:${service.port}`, credential });
      const verifier = testVerifier([AUTHORITY_KEY_A]);
      const pinned = { keyId: AUTHORITY_KEY_A.keyId, algorithm: 'ed25519-v1' as const, publicKeyPem: trustedKeyOf(AUTHORITY_KEY_A).publicKeyPem };
      const { signer, monitor } = await establishExternalAuthorityArtifactSigner({ transport, pinned, verifier, timeoutMs: 2_000, maxAttempts: 1, extensions: ['signDelegatedOfferCapability'] });
      const { request } = await grantBound();
      const signature = await signer.signDelegatedOfferCapability!(request);
      assert.equal(verifier.verifyDelegatedOfferCapability(request.capability, signature).verified, true);
      assert.equal(monitor.status().extensionOperations?.signDelegatedOfferCapability?.succeeded, 1);
      // The custody service applies the rule itself: a capability for another proposal is refused there (422 → REFUSED, not retried).
      const refused = (await grantBound({ capability: { proposalDigest: `sha256:${'7'.repeat(64)}` } })).request;
      await assert.rejects(signer.signDelegatedOfferCapability!(refused), (error: { reason?: string }) => error.reason === 'EXTERNAL_SIGNER_REFUSED');
      // A deployment that did not ask for it refuses the six-operation service: the operation set stays exact.
      await assert.rejects(establishExternalAuthorityArtifactSigner({ transport, pinned, verifier, timeoutMs: 2_000, maxAttempts: 1 }), (error: { reason?: string }) => error.reason === 'EXTERNAL_SIGNER_CAPABILITY_UNSUPPORTED');
      const { signer: plain } = { signer: await establishExternalAuthorityArtifactSigner({ transport: createHttpExternalAuthoritySignerTransport({ endpoint: `http://127.0.0.1:${service.port}`, credential }), pinned, verifier, timeoutMs: 2_000, maxAttempts: 1, extensions: ['signDelegatedOfferCapability'] }) };
      assert.equal(typeof plain.signer.signDelegatedOfferCapability, 'function');
      assert.equal(EXTERNAL_AUTHORITY_SIGNER_EXTENSION_PATHS.signDelegatedOfferCapability, '/v1/sign/xrpl-delegated-offer-capability');
    } finally {
      await service.close();
    }
  });

  it('a deployment requiring the extension refuses a five-operation service; a deployment that does not require it is unchanged (exactly the five)', async () => {
    const credential = 'trade04c-s1-authority-credential-fedcba9876543210';
    const service = await startReferenceAuthoritySigner({ keyId: AUTHORITY_KEY_A.keyId, privateKeyPem: AUTHORITY_KEY_A.privateKeyPem, credential });
    try {
      const transport = createHttpExternalAuthoritySignerTransport({ endpoint: `http://127.0.0.1:${service.port}`, credential });
      const pinned = { keyId: AUTHORITY_KEY_A.keyId, algorithm: 'ed25519-v1' as const, publicKeyPem: trustedKeyOf(AUTHORITY_KEY_A).publicKeyPem };
      await assert.rejects(establishExternalAuthorityArtifactSigner({ transport, pinned, verifier: testVerifier([AUTHORITY_KEY_A]), timeoutMs: 2_000, maxAttempts: 1, extensions: ['signDelegatedOfferCapability'] }), (error: { reason?: string }) => error.reason === 'EXTERNAL_SIGNER_CAPABILITY_UNSUPPORTED');
      const { signer } = await establishExternalAuthorityArtifactSigner({ transport, pinned, verifier: testVerifier([AUTHORITY_KEY_A]), timeoutMs: 2_000, maxAttempts: 1 });
      assert.equal(signer.signDelegatedOfferCapability, undefined, 'no extension method without the extension');
      assert.equal(EXTERNAL_AUTHORITY_SIGNER_OPERATIONS.length, 5);
      // The service without the extension has no such route.
      const response = await fetchStatus(`http://127.0.0.1:${service.port}/v1/sign/xrpl-delegated-offer-capability`, credential);
      assert.equal(response, 404);
    } finally {
      await service.close();
    }
  });

  it('configuration: an unknown or duplicated extension is refused', async () => {
    const transport = { identity: async () => ({}), sign: async () => ({}) };
    const pinned = { keyId: AUTHORITY_KEY_A.keyId, algorithm: 'ed25519-v1' as const, publicKeyPem: trustedKeyOf(AUTHORITY_KEY_A).publicKeyPem };
    for (const extensions of [['signBytes'], ['signDelegatedOfferCapability', 'signDelegatedOfferCapability']]) {
      await assert.rejects(establishExternalAuthorityArtifactSigner({ transport, pinned, verifier: testVerifier([AUTHORITY_KEY_A]), timeoutMs: 1_000, maxAttempts: 1, extensions: extensions as never }), /extensions must be distinct members/);
    }
  });
});

async function fetchStatus(url: string, credential: string): Promise<number> {
  const { request } = await import('node:http');
  return new Promise((resolve, reject) => {
    const req = request(url, { method: 'POST', headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end('{}');
  });
}

describe('TRADE-04C-S1 — the executor: no capability, no signature', () => {
  const withRig = async (options: Parameters<typeof executorRig>[0], run: (rig: ExecutorRig) => Promise<void>): Promise<void> => {
    const rig = await executorRig(options);
    try {
      await run(rig);
    } finally {
      await rig.close();
    }
  };
  const order = (rig: ExecutorRig) => {
    const raw = rawProposal(rig.pairs[0]!);
    rig.book.attest(raw);
    return validatedAction(raw);
  };

  it('a granted order: one capability issued for exactly the prepared transaction, consumed by exactly one signature, then one send', async () => {
    await withRig({}, async (rig) => {
      const action = order(rig);
      const result = await rig.adapter.execute(action);
      assert.equal(result.outcome, 'completed', JSON.stringify(rig.traces.at(-1)));
      const issued = (rig.issuer as ReturnType<typeof testCapabilityIssuer>).issued;
      assert.equal(issued.length, 1);
      assert.equal(issued[0]!.executionId, action.correlation.executionId);
      assert.equal(issued[0]!.boundedGrantId, action.boundedGrantId);
      assert.equal(issued[0]!.trustDomain, S1_TRUST_DOMAIN);
      assert.equal(rig.traces.at(-1)?.capabilityId, issued[0]!.capabilityId);
      assert.deepEqual([rig.signer.signatures(), rig.ledger.submitCalls.length], [1, 1]);
    });
  });

  // TRADE-04D H-1: the outcome follows what the refusal proves. A refusal the issuer made before asking the authority
  // signer proves no capability exists (failed); a signing call that failed may have produced one (unconfirmed).
  for (const [name, error, detail, outcome] of [
    ['the authority refuses (revoked, absent or another grant’s terms)', new DelegatedOfferCapabilityError('CAPABILITY_GRANT_REVOKED', 'revoked'), 'trade-capability-refused', 'failed'],
    ['the authority is unavailable (the signing call failed: it may have signed)', new DelegatedOfferCapabilityError('CAPABILITY_SIGNING_UNAVAILABLE', 'down'), 'trade-capability-unavailable', 'unconfirmed'],
    ['the issuer slot was never bound', new DelegatedOfferCapabilityError('CAPABILITY_ISSUER_UNBOUND', 'unbound'), 'trade-capability-unavailable', 'failed'],
  ] as const) {
    it(`${name}: refused before the signer is contacted — zero signatures, zero sends; ${outcome}`, async () => {
      await withRig({ issuer: testCapabilityIssuer({ refuse: () => error }) }, async (rig) => {
        const result = await rig.adapter.execute(order(rig));
        assert.equal(result.outcome, outcome);
        assert.equal((result as { detail?: string }).detail, detail);
        assert.deepEqual([rig.signer.signatures(), rig.ledger.submitCalls.length, rig.traces.at(-1)?.signingRequests], [0, 0, 0]);
      });
    });
  }

  it('an issuer answering a capability for another execution, grant or transaction: refused before signing', async () => {
    for (const change of [{ executionId: 'exec-other' }, { boundedGrantId: 'grant-other' }, { signingPreimageDigest: `sha256:${'5'.repeat(64)}` }]) {
      const inner = testCapabilityIssuer();
      const crossing = { issue: async (input: DelegatedOfferCapabilityIssuanceInput) => inner.issue({ ...input, ...change }) };
      await withRig({ issuer: crossing }, async (rig) => {
        const result = await rig.adapter.execute(order(rig));
        assert.equal((result as { detail?: string }).detail, 'trade-capability-refused', JSON.stringify(change));
        // H-1: a capability was issued (for the wrong terms) — the Host refused to use it, but it exists: never a terminal failure.
        assert.equal(result.outcome, 'unconfirmed', JSON.stringify(change));
        assert.deepEqual([rig.signer.signatures(), rig.ledger.submitCalls.length], [0, 0]);
      });
    }
  });

  it('a capability signed by a key the signer does not pin: the signer refuses — zero signatures, zero sends', async () => {
    await withRig({ issuer: testCapabilityIssuer({ key: AUTHORITY_KEY_B }) }, async (rig) => {
      const result = await rig.adapter.execute(order(rig));
      assert.equal((result as { detail?: string }).detail, 'trade-signer-refused');
      assert.deepEqual([rig.signer.signatures(), rig.ledger.submitCalls.length], [0, 0]);
    });
  });

  it('an expired capability (issued past its lifetime): the signer refuses — zero signatures', async () => {
    await withRig({ issuer: testCapabilityIssuer({ now: () => Date.now() - 120_000, lifetimeMs: 60_000 }) }, async (rig) => {
      const result = await rig.adapter.execute(order(rig));
      assert.equal((result as { detail?: string }).detail, 'trade-signer-refused');
      assert.equal(rig.signer.signatures(), 0);
    });
  });
});
