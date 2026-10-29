import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { mintSovereignAssetId } from '@aoc/protocol/identity';
import {
  generateSovereignKeyPair,
  signSovereignPayload,
  verifySignedSovereignClaim,
  verifySovereignManifest,
  verifySovereignSignature,
} from '@aoc/protocol/manifest';
import type { SovereignProof } from '@aoc/protocol/manifest';

import {
  SOVEREIGN_STATUS_MAX_VALIDITY_SECONDS,
  SOVEREIGN_STATUS_PROFILE,
  SOVEREIGN_STATUS_PURPOSE,
  SOVEREIGN_STATUS_REJECTION_REASONS,
  SOVEREIGN_STATUS_VERIFIER,
  verifySovereignStatus,
} from '../src/index.js';
import type { ReceiverVerificationKeyResolver, SovereignStatusRejectionReason, SovereignStatusVerificationResult } from '../src/index.js';
import { ATTACKER, ISSUER, SIGNED_AT, attackerKeys, issuerKeys, signedOriginClaim, trustingResolver } from './fixtures.js';
import type { ResolverCall } from './fixtures.js';
import {
  ASSET,
  ISSUED_AT,
  MANIFEST,
  MANIFEST_DIGEST,
  NOW,
  TERMS,
  VALID_UNTIL,
  canonical,
  contextWithoutTerms,
  payload,
  sign,
  signedText,
  statusContext,
} from './status-fixtures.js';
import type { Payload } from './status-fixtures.js';

const DIGEST_B = 'b'.repeat(64);

async function verify(text: unknown, context: unknown = statusContext()): Promise<SovereignStatusVerificationResult> {
  return verifySovereignStatus(text, context);
}

async function rejects(text: unknown, reason: SovereignStatusRejectionReason, context: unknown = statusContext(), message?: string): Promise<void> {
  const result = await verify(text, context);
  assert.equal(result.outcome, 'rejected', message);
  if (result.outcome === 'rejected') assert.equal(result.reason, reason, message);
}

async function accepts(text: unknown, context: unknown = statusContext(), message?: string) {
  const result = await verify(text, context);
  assert.equal(result.outcome, 'authentic_authorized', `${message ?? 'expected acceptance'}: ${result.outcome === 'rejected' ? result.reason : ''}`);
  if (result.outcome !== 'authentic_authorized') throw new Error('unreachable');
  return result;
}

function resolverWith(descriptor: unknown, calls: ResolverCall[] = []): ReceiverVerificationKeyResolver {
  return {
    resolveVerificationKey(issuer) {
      calls.push({ issuer });
      return descriptor as never;
    },
  };
}

/** Swaps one field of a signed text without re-signing. */
function edit(text: string, change: (envelope: { status: Payload; proof: Record<string, unknown> }) => void): string {
  const envelope = JSON.parse(text) as { status: Payload; proof: Record<string, unknown> };
  change(envelope);
  return canonical(envelope);
}

// ---------------------------------------------------------------------------
// Acceptance and what it means

test('1/34/36. a valid active status naming the expected terms is authentic_authorized, and nothing more', async () => {
  const calls: ResolverCall[] = [];
  const envelope = sign(payload());
  const result = await accepts(canonical(envelope), statusContext({ verificationKeyResolver: trustingResolver(undefined, calls) }));
  assert.deepEqual(result, {
    outcome: 'authentic_authorized',
    verifier: SOVEREIGN_STATUS_VERIFIER,
    statusProfile: SOVEREIGN_STATUS_PROFILE,
    sovereignAssetId: ASSET,
    issuer: ISSUER,
    keyId: issuerKeys.signingKey.keyId,
    manifestDigest: MANIFEST_DIGEST,
    assetStatus: 'active',
    currentTerms: { ...TERMS },
    termsBinding: 'matches_expected',
    sequence: 1,
    previousStatusDigest: null,
    statusDigest: envelope.proof['payloadHash'],
    issuedAt: ISSUED_AT,
    validUntil: VALID_UNTIL,
    evaluationTime: NOW,
    temporalValidity: 'within_validity_window',
    freshness: 'not_evaluated',
    revocationCurrentness: 'not_evaluated',
    authorization: 'not_evaluated',
    execution: 'not_performed',
  });
  assert.deepEqual(calls, [{ issuer: ISSUER }], 'the resolver is asked once, for the expected registrant only');
});

test('33. a correctly signed withdrawn status verifies and reports withdrawn, with no terms', async () => {
  const result = await accepts(signedText({ assetStatus: 'withdrawn', currentTerms: null, sequence: 2, previousStatusDigest: DIGEST_B }), contextWithoutTerms());
  assert.equal(result.assetStatus, 'withdrawn');
  assert.equal(result.currentTerms, null);
  assert.equal(result.termsBinding, 'not_requested');
});

test('33. withdrawn is unambiguous: a withdrawn status that names current terms is malformed', async () => {
  await rejects(signedText({ assetStatus: 'withdrawn' }), 'STATUS_MALFORMED', contextWithoutTerms());
  await rejects(signedText({ assetStatus: 'withdrawn' }), 'STATUS_MALFORMED');
});

test('35. an active status with currentTerms null (terms revoked) verifies when no terms are expected', async () => {
  const result = await accepts(signedText({ currentTerms: null }), contextWithoutTerms());
  assert.equal(result.assetStatus, 'active');
  assert.equal(result.currentTerms, null);
});

test('35/16. when terms are expected, a status that names no current terms is a terms binding mismatch', async () => {
  await rejects(signedText({ currentTerms: null }), 'TERMS_BINDING_MISMATCH');
  await rejects(signedText({ assetStatus: 'withdrawn', currentTerms: null }), 'TERMS_BINDING_MISMATCH');
});

test('36. without expectedTerms the status terms are reported, not checked', async () => {
  const result = await accepts(signedText({ currentTerms: { claimId: 'claim-terms-2', claimDigest: DIGEST_B } }), contextWithoutTerms());
  assert.deepEqual(result.currentTerms, { claimId: 'claim-terms-2', claimDigest: DIGEST_B });
  assert.equal(result.termsBinding, 'not_requested');
});

test('40. a verified status authorizes nothing, executes nothing and cannot pass as an RSDK-02B verdict', async () => {
  for (const text of [signedText(), edit(signedText(), (e) => { e.status['sequence'] = 2; })]) {
    const result = await verify(text);
    assert.equal(result.authorization, 'not_evaluated');
    assert.equal(result.freshness, 'not_evaluated');
    assert.equal(result.revocationCurrentness, 'not_evaluated');
    assert.equal(result.execution, 'not_performed');
    assert.equal('decision' in result, false);
    assert.notEqual((result as unknown as Record<string, unknown>)['decision'], 'eligible');
    for (const key of ['latest', 'fresh', 'authorized', 'capability']) assert.equal(key in result, false, key);
    assert.equal(Object.isFrozen(result), true);
  }
});

test('37. verification is deterministic and returns deeply frozen results', async () => {
  const text = signedText();
  const [first, second] = [await verify(text), await verify(text)];
  assert.deepEqual(first, second);
  assert.equal(first.outcome, 'authentic_authorized');
  if (first.outcome === 'authentic_authorized') assert.equal(Object.isFrozen(first.currentTerms), true);
  const [r1, r2] = [await verify('{'), await verify('{')];
  assert.deepEqual(r1, r2);
});

test('the rejection reasons are a closed, duplicate-free set and every rejection names one of them', async () => {
  assert.equal(new Set(SOVEREIGN_STATUS_REJECTION_REASONS).size, SOVEREIGN_STATUS_REJECTION_REASONS.length);
  assert.equal(Object.isFrozen(SOVEREIGN_STATUS_REJECTION_REASONS), true);
  const result = await verify('not json');
  assert.equal(result.outcome, 'rejected');
  if (result.outcome === 'rejected') assert.ok(SOVEREIGN_STATUS_REJECTION_REASONS.includes(result.reason));
  assert.deepEqual(Object.keys(result).sort(), ['authorization', 'execution', 'freshness', 'outcome', 'reason', 'revocationCurrentness', 'statusProfile', 'verifier']);
});

// ---------------------------------------------------------------------------
// Integrity

test('2. an invalid signature is refused', async () => {
  await rejects(edit(signedText(), (e) => { e.proof['signature'] = `${(e.proof['signature'] as string)[0] === 'A' ? 'B' : 'A'}${(e.proof['signature'] as string).slice(1)}`; }), 'STATUS_SIGNATURE_INVALID');
});

test('3. a payload modified after signing is refused, even with its payloadHash recomputed', async () => {
  const modified = edit(signedText(), (e) => { e.status['manifestDigest'] = DIGEST_B; });
  await rejects(modified, 'STATUS_SIGNATURE_INVALID');
  const rehashed = edit(modified, (e) => { e.proof['payloadHash'] = createHash('sha256').update(canonical(e.status)).digest('hex'); });
  await rejects(rehashed, 'STATUS_SIGNATURE_INVALID');
});

test('a status signature cannot be reused over another payload', async () => {
  const a = sign(payload());
  const b = sign(payload({ sequence: 2, previousStatusDigest: a.proof['payloadHash'] }));
  await rejects(canonical({ status: b.status, proof: a.proof }), 'STATUS_SIGNATURE_INVALID');
  await rejects(canonical({ status: a.status, proof: b.proof }), 'STATUS_SIGNATURE_INVALID');
});

test('the resolver is never consulted for a status whose signature does not verify', async () => {
  const calls: ResolverCall[] = [];
  await rejects(edit(signedText(), (e) => { e.status['sequence'] = 7; e.status['previousStatusDigest'] = DIGEST_B; }), 'STATUS_SIGNATURE_INVALID', statusContext({ verificationKeyResolver: trustingResolver(undefined, calls) }));
  assert.deepEqual(calls, []);
});

// ---------------------------------------------------------------------------
// Schema, purpose and domain separation

test('4. an unknown schema version is refused, even correctly signed', async () => {
  for (const schemaVersion of ['soberania.sovereign-status/2', 'soberania.sovereign-status/1 ', 'SOBERANIA.SOVEREIGN-STATUS/1', 'aoc-sovereign-manifest/1', 1]) {
    await rejects(signedText({ schemaVersion }), 'STATUS_SCHEMA_UNSUPPORTED', undefined, String(schemaVersion));
  }
});

test('5. a wrong purpose is refused, correctly signed or changed after signing', async () => {
  for (const purpose of ['soberania.sovereign-status.revocation', 'soberania.document-use.assertion', '', null]) {
    await rejects(signedText({ purpose }), 'STATUS_PURPOSE_INVALID', undefined, String(purpose));
  }
  await rejects(edit(signedText(), (e) => { e.status['purpose'] = 'other'; }), 'STATUS_PURPOSE_INVALID');
});

test('31. a signed manifest cannot be presented as a status', async () => {
  await rejects(canonical({ status: MANIFEST.manifest, proof: MANIFEST.proof }), 'STATUS_SCHEMA_UNSUPPORTED');
  await rejects(canonical(MANIFEST), 'STATUS_MALFORMED');
  // Protocol's signature over the manifest is valid: only the status schema refuses it.
  assert.equal(verifySovereignSignature(MANIFEST.manifest, MANIFEST.proof), true);
});

test('30. a signed claim cannot be presented as a status', async () => {
  const claim = signedOriginClaim(ASSET);
  assert.equal(verifySovereignSignature(claim.claim, claim.proof), true);
  await rejects(canonical({ status: claim.claim, proof: claim.proof }), 'STATUS_SCHEMA_UNSUPPORTED');
  await rejects(canonical(claim), 'STATUS_MALFORMED');
});

test('29. a signed status cannot be presented as a claim or a manifest', async () => {
  const envelope = sign(payload());
  const asClaim = await verifySignedSovereignClaim(
    { claim: envelope.status, digest: envelope.proof['payloadHash'], proof: envelope.proof } as never,
    { verificationKeyResolver: trustingResolver(), issuer: ISSUER },
  );
  assert.equal(asClaim.valid, false);
  assert.equal(asClaim.checks.claimStructure, 'invalid');
  // rc.3's manifest verifier throws on this input rather than returning a result; either way it is not accepted.
  const asManifest = await verifySovereignManifest(
    { manifest: envelope.status, manifestDigest: envelope.proof['payloadHash'], proof: envelope.proof } as never,
    { verificationKeyResolver: trustingResolver(), issuer: ISSUER },
  ).catch(() => ({ valid: false as const }));
  assert.equal(asManifest.valid, false);
});

// ---------------------------------------------------------------------------
// Structure

test('6. unknown properties are refused at every level', async () => {
  await rejects(signedText({ extra: true }), 'STATUS_MALFORMED');
  await rejects(signedText({ currentTerms: { ...TERMS, effectiveAt: ISSUED_AT } }), 'STATUS_MALFORMED');
  await rejects(edit(signedText(), (e) => { (e as unknown as Record<string, unknown>)['witness'] = 'x'; }), 'STATUS_MALFORMED');
  await rejects(edit(signedText(), (e) => { e.proof['nonce'] = 'x'; }), 'STATUS_MALFORMED');
});

test('7. every missing field is refused', async () => {
  for (const key of Object.keys(payload())) {
    const status = payload();
    delete status[key];
    const expected = key === 'schemaVersion' ? 'STATUS_SCHEMA_UNSUPPORTED' : key === 'purpose' ? 'STATUS_PURPOSE_INVALID' : 'STATUS_MALFORMED';
    await rejects(canonical(sign(status)), expected, undefined, key);
  }
  for (const key of ['algorithm', 'canonicalizationProfile', 'keyId', 'publicKey', 'signature', 'signedAt', 'payloadHash']) {
    await rejects(edit(signedText(), (e) => { delete e.proof[key]; }), 'STATUS_MALFORMED', undefined, key);
  }
  await rejects(edit(signedText(), (e) => { delete (e as unknown as Record<string, unknown>)['proof']; }), 'STATUS_MALFORMED');
  await rejects(signedText({ currentTerms: { claimId: TERMS.claimId } }), 'STATUS_MALFORMED');
});

test('wrong types and malformed values are refused', async () => {
  const cases: Payload[] = [
    { sovereignAssetId: 'not-an-asset-id' },
    { sovereignAssetId: 42 },
    { issuer: '' },
    { issuer: ` ${ISSUER}` },
    { issuer: { id: ISSUER } },
    { manifestDigest: MANIFEST_DIGEST.toUpperCase() },
    { manifestDigest: `sha256:${MANIFEST_DIGEST}` },
    { assetStatus: 'Active' },
    { assetStatus: 'superseded' },
    { assetStatus: 'disputed' },
    { currentTerms: [] },
    { currentTerms: 'claim-terms-1' },
    { currentTerms: { claimId: '', claimDigest: TERMS.claimDigest } },
    { currentTerms: { claimId: TERMS.claimId, claimDigest: 'A'.repeat(64) } },
    { sequence: '1' },
    { sequence: true },
    { previousStatusDigest: '' },
  ];
  for (const overrides of cases) await rejects(signedText(overrides), 'STATUS_MALFORMED', undefined, JSON.stringify(overrides));
  for (const [key, value] of [['algorithm', 'ED25519'], ['canonicalizationProfile', 'aoc-canonical-json/2'], ['keyId', 'k'], ['payloadHash', 'x'], ['signedAt', 'yesterday'], ['publicKey', ''], ['signature', 'abc']] as const) {
    await rejects(edit(signedText(), (e) => { e.proof[key] = value; }), 'STATUS_MALFORMED', undefined, key);
  }
});

test('8–11. sequence must be a safe integer of at least 1', async () => {
  for (const sequence of [0, -1, 1.5]) await rejects(signedText({ sequence, previousStatusDigest: DIGEST_B }), 'STATUS_MALFORMED', undefined, String(sequence));
  await rejects(signedText({ sequence: 2 ** 53, previousStatusDigest: DIGEST_B }), 'STATUS_MALFORMED', undefined, '2^53');
  // An unsafe literal in the text parses to a double; it is refused before any rounding matters.
  await rejects(edit(signedText({ sequence: 2, previousStatusDigest: DIGEST_B }), () => undefined).replace('"sequence":2', '"sequence":9007199254740993'), 'STATUS_MALFORMED');
  const max = await accepts(signedText({ sequence: Number.MAX_SAFE_INTEGER, previousStatusDigest: DIGEST_B }));
  assert.equal(max.sequence, Number.MAX_SAFE_INTEGER);
});

test('12/13. previousStatusDigest is null exactly for sequence 1', async () => {
  await rejects(signedText({ sequence: 2, previousStatusDigest: null }), 'STATUS_MALFORMED');
  await rejects(signedText({ sequence: 2, previousStatusDigest: 'B'.repeat(64) }), 'STATUS_MALFORMED');
  await rejects(signedText({ sequence: 1, previousStatusDigest: DIGEST_B }), 'STATUS_MALFORMED');
  const linked = await accepts(signedText({ sequence: 2, previousStatusDigest: DIGEST_B }));
  assert.equal(linked.previousStatusDigest, DIGEST_B);
});

test('32. a payload carrying unexpected sensitive fields is refused and nothing of it is echoed', async () => {
  for (const extra of [{ contentKey: 'secret-key-material' }, { shareLink: 'https://portal.example/doc#key=abc' }, { statement: 'rule text' }]) {
    const result = await verify(signedText(extra));
    assert.equal(result.outcome, 'rejected');
    assert.equal(JSON.stringify(result).includes(Object.values(extra)[0]!), false);
  }
});

// ---------------------------------------------------------------------------
// One byte representation

test('only the aoc-canonical-json/1 serialization is accepted', async () => {
  const text = signedText();
  const pretty = JSON.stringify(JSON.parse(text), null, 2);
  await rejects(pretty, 'STATUS_NOT_CANONICAL');
  await rejects(` ${text}`, 'STATUS_NOT_CANONICAL');
  const envelope = JSON.parse(text) as Record<string, unknown>;
  await rejects(JSON.stringify({ status: envelope['status'], proof: envelope['proof'] }), 'STATUS_NOT_CANONICAL', undefined, 'unsorted envelope keys');
  await rejects(text.replace('"sequence":1', '"sequence":1.0'), 'STATUS_NOT_CANONICAL');
  await rejects(text.replace('"sequence":1', '"sequence":1e0'), 'STATUS_NOT_CANONICAL');
  await rejects(text.replace(`"issuer":"${ISSUER}"`, `"issuer":"\\u0064${ISSUER.slice(1)}"`), 'STATUS_NOT_CANONICAL');
});

test('duplicate keys are refused, whichever value a parser would keep', async () => {
  const text = signedText();
  await rejects(text.replace('"sequence":1', '"sequence":1,"sequence":1'), 'STATUS_NOT_CANONICAL');
  await rejects(text.replace('"assetStatus":"active"', '"assetStatus":"withdrawn","assetStatus":"active"'), 'STATUS_NOT_CANONICAL');
});

test('the local canonical form matches Protocol: the signed payloadHash is sha256 of it', () => {
  for (const status of [payload(), payload({ issuer: 'did:example:ünïcødé- -"q"' }), payload({ sequence: Number.MAX_SAFE_INTEGER, previousStatusDigest: DIGEST_B })]) {
    const proof = signSovereignPayload(status, issuerKeys.privateKeyPem, issuerKeys.signingKey, SIGNED_AT);
    assert.equal(createHash('sha256').update(canonical(status)).digest('hex'), proof.payloadHash);
  }
});

test('a non-canonical spelling of the same signature bytes is refused, though Node would accept it', async () => {
  const envelope = sign(payload());
  const signature = envelope.proof['signature'] as string;
  const last = signature.at(-1)!;
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const sibling = alphabet[alphabet.indexOf(last) + 1]!; // same top two bits, different ignored bits
  const malleated = { ...envelope.proof, signature: `${signature.slice(0, -1)}${sibling}` };
  assert.equal(verifySovereignSignature(envelope.status, malleated as unknown as SovereignProof), true, 'precondition: Node decodes both spellings to the same bytes');
  await rejects(canonical({ status: envelope.status, proof: malleated }), 'STATUS_MALFORMED');
});

test('every signature Protocol produces has the canonical spelling', async () => {
  for (let index = 0; index < 48; index += 1) await accepts(signedText({ sequence: index + 1, previousStatusDigest: index === 0 ? null : DIGEST_B }));
});

test('a correctly signed status larger than the input bound is refused before parsing', async () => {
  const issuer = `did:example:${'x'.repeat(16_384)}`;
  const context = statusContext({ expectedRegistrant: issuer, verificationKeyResolver: trustingResolver({ [issuer]: issuerKeys }) });
  await rejects(signedText({ issuer }), 'STATUS_MALFORMED', context);
  await accepts(signedText({ issuer: `did:example:${'x'.repeat(8_000)}` }), statusContext({ expectedRegistrant: `did:example:${'x'.repeat(8_000)}`, verificationKeyResolver: trustingResolver({ [`did:example:${'x'.repeat(8_000)}`]: issuerKeys }) }));
});

test('non-string, non-JSON and oversized inputs are refused', async () => {
  for (const input of [undefined, null, 42, {}, sign(payload()), Buffer.from(signedText()), 'not json', '[]', 'null', '"x"', `${'x'.repeat(16_385)}`]) {
    await rejects(input, 'STATUS_MALFORMED', undefined, typeof input);
  }
  await rejects(canonical({ status: [], proof: {} }), 'STATUS_MALFORMED');
});

// ---------------------------------------------------------------------------
// Authority

test('18. a status whose issuer is not the expected registrant is refused without consulting the resolver', async () => {
  const unknown = generateSovereignKeyPair();
  const calls: ResolverCall[] = [];
  await rejects(signedText({ issuer: 'did:example:unknown' }, unknown), 'STATUS_ISSUER_UNAUTHORIZED', statusContext({ verificationKeyResolver: trustingResolver({ 'did:example:unknown': unknown }, calls) }));
  assert.deepEqual(calls, []);
});

test('18. a registrant the resolver does not know is refused', async () => {
  await rejects(signedText(), 'STATUS_KEY_UNTRUSTED', statusContext({ verificationKeyResolver: trustingResolver({}) }));
});

test('19. a key that is trusted for another principal cannot sign the registrant status', async () => {
  const both = trustingResolver({ [ISSUER]: issuerKeys, [ATTACKER]: attackerKeys });
  // Signed by the attacker key in the registrant name.
  await rejects(signedText({}, attackerKeys), 'STATUS_KEY_UNTRUSTED', statusContext({ verificationKeyResolver: both }));
  // Signed by the attacker in its own name: authentic, but not the registrant.
  await rejects(signedText({ issuer: ATTACKER }, attackerKeys), 'STATUS_ISSUER_UNAUTHORIZED', statusContext({ verificationKeyResolver: both }));
});

test('20. a forged keyId naming the registrant key does not bind the attacker key', async () => {
  const forged = signSovereignPayload(payload(), attackerKeys.privateKeyPem, { ...attackerKeys.signingKey, keyId: issuerKeys.signingKey.keyId }, SIGNED_AT);
  assert.equal(verifySovereignSignature(payload(), forged), true, 'precondition: the keyId is not signed');
  await rejects(canonical({ status: payload(), proof: forged }), 'STATUS_KEY_BINDING_INVALID');
});

test('21. a key carried only by the status, with no anchor, is refused', async () => {
  const self = generateSovereignKeyPair();
  await rejects(signedText({}, self), 'STATUS_KEY_UNTRUSTED');
  await rejects(signedText({}, self), 'STATUS_KEY_UNTRUSTED', statusContext({ verificationKeyResolver: resolverWith(undefined) }));
});

test('22. a failing resolver is reported as such, synchronously or asynchronously', async () => {
  const throwing: ReceiverVerificationKeyResolver = { resolveVerificationKey: () => { throw new Error('directory down'); } };
  const rejecting: ReceiverVerificationKeyResolver = { resolveVerificationKey: async () => { throw new Error('directory down'); } };
  await rejects(signedText(), 'KEY_RESOLVER_FAILED', statusContext({ verificationKeyResolver: throwing }));
  await rejects(signedText(), 'KEY_RESOLVER_FAILED', statusContext({ verificationKeyResolver: rejecting }));
});

test('23. an unexpected resolver answer is refused', async () => {
  const keyId = issuerKeys.signingKey.keyId;
  const cases: Array<[unknown, SovereignStatusRejectionReason]> = [
    [null, 'STATUS_KEY_UNTRUSTED'],
    ['a key', 'STATUS_KEY_UNTRUSTED'],
    [[{ keyId, issuer: ISSUER }], 'STATUS_KEY_UNTRUSTED'],
    [{ issuer: ISSUER }, 'STATUS_KEY_UNTRUSTED'],
    [{ keyId: '  ', issuer: ISSUER }, 'STATUS_KEY_UNTRUSTED'],
    [{ keyId }, 'STATUS_KEY_UNTRUSTED'],
    [{ keyId, issuer: ATTACKER }, 'STATUS_KEY_UNTRUSTED'],
    [{ keyId: attackerKeys.signingKey.keyId, issuer: ISSUER }, 'STATUS_KEY_UNTRUSTED'],
    [{ keyId, issuer: ISSUER, algorithm: 'rsa' }, 'STATUS_KEY_BINDING_INVALID'],
    [{ keyId, issuer: ISSUER, algorithm: 7 }, 'STATUS_KEY_BINDING_INVALID'],
    [{ keyId, issuer: ISSUER, publicKeyJwk: { kty: 'OKP', crv: 'Ed25519', x: 'AAAA' } }, 'STATUS_KEY_BINDING_INVALID'],
    [{ get keyId(): string { throw new Error('trap'); }, issuer: ISSUER }, 'STATUS_KEY_UNTRUSTED'],
  ];
  for (const [index, [descriptor, reason]] of cases.entries()) {
    await rejects(signedText(), reason, statusContext({ verificationKeyResolver: resolverWith(descriptor) }), `descriptor case ${index}`);
  }
  await accepts(signedText(), statusContext({ verificationKeyResolver: resolverWith({ keyId, issuer: ISSUER, algorithm: 'Ed25519' }) }), 'algorithm is case-insensitive, as in Protocol');
  await accepts(signedText(), statusContext({ verificationKeyResolver: resolverWith(Promise.resolve({ keyId, issuer: ISSUER })) }), 'an asynchronous resolver');
});

test('issuer binding matches Protocol (SOBE-SEC-01) on every descriptor, except the documented JWK refusal', async () => {
  const keyId = issuerKeys.signingKey.keyId;
  const jwk = { kty: 'OKP', crv: 'Ed25519', x: 'AAAA' };
  const descriptors: Array<[string, unknown]> = [
    ['trusted', { keyId, issuer: ISSUER }],
    ['trusted, algorithm', { keyId, issuer: ISSUER, algorithm: 'ed25519' }],
    ['trusted, upper-case algorithm', { keyId, issuer: ISSUER, algorithm: 'ED25519' }],
    ['absent', undefined],
    ['null', null],
    ['array', [{ keyId, issuer: ISSUER }]],
    ['blank keyId', { keyId: ' ', issuer: ISSUER }],
    ['other issuer', { keyId, issuer: ATTACKER }],
    ['other key', { keyId: attackerKeys.signingKey.keyId, issuer: ISSUER }],
    ['rsa', { keyId, issuer: ISSUER, algorithm: 'rsa' }],
    ['numeric algorithm', { keyId, issuer: ISSUER, algorithm: 1 }],
    ['validity window ignored by both', { keyId, issuer: ISSUER, validFrom: '2030-01-01T00:00:00Z', validUntil: '2020-01-01T00:00:00Z' }],
  ];
  const claim = signedOriginClaim(ASSET);
  for (const [label, descriptor] of descriptors) {
    const protocol = await verifySignedSovereignClaim(claim, { verificationKeyResolver: resolverWith(descriptor) as never, issuer: ISSUER });
    const ours = await verify(signedText(), statusContext({ verificationKeyResolver: resolverWith(descriptor) }));
    assert.equal(ours.outcome === 'authentic_authorized', protocol.checks.issuerBinding === 'verified', label);
  }
  // Signed by another key in the registrant's name: both refuse.
  const attackerClaim = signedOriginClaim(ASSET, attackerKeys);
  const protocol = await verifySignedSovereignClaim(attackerClaim, { verificationKeyResolver: trustingResolver(), issuer: ISSUER });
  assert.equal(protocol.checks.issuerBinding, 'unverified');
  await rejects(signedText({}, attackerKeys), 'STATUS_KEY_UNTRUSTED');
  // The one deliberate difference: Protocol compares a JWK, which this package cannot do with public APIs.
  const withJwk = { keyId, issuer: ISSUER, publicKeyJwk: jwk };
  const protocolJwk = await verifySignedSovereignClaim(claim, { verificationKeyResolver: resolverWith(withJwk) as never, issuer: ISSUER });
  assert.equal(protocolJwk.checks.issuerBinding, 'unverified', 'Protocol refuses a mismatching JWK');
  await rejects(signedText(), 'STATUS_KEY_BINDING_INVALID', statusContext({ verificationKeyResolver: resolverWith(withJwk) }));
});

// ---------------------------------------------------------------------------
// Binding to what the host verified

test('14. a status about another asset is refused', async () => {
  await rejects(signedText({ sovereignAssetId: mintSovereignAssetId() }), 'STATUS_SUBJECT_MISMATCH');
});

test('15. a status naming another manifest is refused', async () => {
  await rejects(signedText({ manifestDigest: DIGEST_B }), 'MANIFEST_BINDING_MISMATCH');
});

test('16/17. a status naming other terms is refused when terms are expected', async () => {
  await rejects(signedText({ currentTerms: { claimId: TERMS.claimId, claimDigest: DIGEST_B } }), 'TERMS_BINDING_MISMATCH');
  await rejects(signedText({ currentTerms: { claimId: 'claim-terms-2', claimDigest: TERMS.claimDigest } }), 'TERMS_BINDING_MISMATCH');
});

test('expected values come from the host only: the status cannot choose them', async () => {
  const other = mintSovereignAssetId();
  // A status about another asset and manifest stays refused whatever it says about itself.
  await rejects(signedText({ sovereignAssetId: other, manifestDigest: DIGEST_B }), 'STATUS_SUBJECT_MISMATCH');
  await accepts(signedText({ sovereignAssetId: other, manifestDigest: DIGEST_B }), statusContext({ expectedSovereignAssetId: other, expectedManifestDigest: DIGEST_B }));
});

// ---------------------------------------------------------------------------
// Time

test('24. a status at or past validUntil is expired', async () => {
  await rejects(signedText(), 'STATUS_EXPIRED', statusContext({ evaluationTime: VALID_UNTIL }));
  await rejects(signedText(), 'STATUS_EXPIRED', statusContext({ evaluationTime: '2026-11-28T00:00:00Z' }));
});

test('25. a status issued after the evaluation time is from the future', async () => {
  await rejects(signedText(), 'STATUS_FROM_FUTURE', statusContext({ evaluationTime: '2026-10-27T23:59:59.999999999Z' }));
});

test('26. the validity window may be at most seven days, exactly', async () => {
  assert.equal(SOVEREIGN_STATUS_MAX_VALIDITY_SECONDS, 7 * 24 * 3600);
  await accepts(signedText({ validUntil: '2026-11-04T00:00:00Z' }));
  await rejects(signedText({ validUntil: '2026-11-04T00:00:00.000000001Z' }), 'STATUS_VALIDITY_TOO_LONG');
  await rejects(signedText({ validUntil: '2027-10-28T00:00:00Z' }), 'STATUS_VALIDITY_TOO_LONG');
  // Across a leap day and a month boundary, by calendar arithmetic.
  await accepts(signedText({ issuedAt: '2028-02-25T00:00:00Z', validUntil: '2028-03-03T00:00:00Z' }), statusContext({ evaluationTime: '2028-02-29T12:00:00Z' }));
  await rejects(signedText({ issuedAt: '2028-02-25T00:00:00Z', validUntil: '2028-03-03T00:00:00.1Z' }), 'STATUS_VALIDITY_TOO_LONG', statusContext({ evaluationTime: '2028-02-29T12:00:00Z' }));
});

test('27. non-canonical, impossible and inverted timestamps are refused', async () => {
  const bad = ['2026-10-28T00:00:00+00:00', '2026-10-28T00:00:00z', '2026-10-28 00:00:00Z', '2026-10-28T00:00Z', '2026-02-29T00:00:00Z', '2026-04-31T00:00:00Z', '2026-10-28T24:00:00Z', '2026-10-28T23:59:60Z', '2026-13-01T00:00:00Z', '2026-10-28T00:00:00.0000000001Z', '+2026-10-28T00:00:00Z'];
  for (const issuedAt of bad) await rejects(signedText({ issuedAt }), 'STATUS_TIME_INVALID', undefined, issuedAt);
  for (const validUntil of bad) await rejects(signedText({ validUntil }), 'STATUS_TIME_INVALID', undefined, validUntil);
  await rejects(signedText({ validUntil: ISSUED_AT }), 'STATUS_TIME_INVALID', undefined, 'issuedAt == validUntil');
  await rejects(signedText({ issuedAt: VALID_UNTIL, validUntil: ISSUED_AT }), 'STATUS_TIME_INVALID', undefined, 'inverted');
});

test('28. boundaries are exact to the nanosecond, with no millisecond rounding and no grace', async () => {
  const text = signedText({ issuedAt: '2026-10-28T00:00:00.000000001Z', validUntil: '2026-10-28T12:00:00.0000001Z' });
  await rejects(text, 'STATUS_FROM_FUTURE', statusContext({ evaluationTime: '2026-10-28T00:00:00Z' }));
  await accepts(text, statusContext({ evaluationTime: '2026-10-28T00:00:00.000000001Z' }), 'at issuedAt');
  await accepts(text, statusContext({ evaluationTime: '2026-10-28T12:00:00.000Z' }), 'before validUntil by 100ns');
  await accepts(text, statusContext({ evaluationTime: '2026-10-28T12:00:00.000000099Z' }), '1ns before validUntil');
  await rejects(text, 'STATUS_EXPIRED', statusContext({ evaluationTime: '2026-10-28T12:00:00.0000001Z' }), 'at validUntil');
  // Equal instants spelled with different fraction lengths compare equal.
  await rejects(signedText(), 'STATUS_EXPIRED', statusContext({ evaluationTime: '2026-10-29T00:00:00Z' }));
  await accepts(signedText(), statusContext({ evaluationTime: '2026-10-28T00:00:00Z' }));
});

test('the evaluation time comes from the context only, and must be valid', async () => {
  for (const evaluationTime of [undefined, '', 'now', 1761652800000, '2026-10-28T12:00:00+01:00', '2026-02-30T00:00:00Z']) {
    const context = statusContext({ evaluationTime });
    if (evaluationTime === undefined) delete context['evaluationTime'];
    await rejects(signedText(), evaluationTime === undefined ? 'CONTEXT_INVALID' : 'EVALUATION_TIME_INVALID', context, String(evaluationTime));
  }
  const realNow = Date.now;
  Date.now = () => { throw new Error('the verifier must not read the clock'); };
  try {
    await accepts(signedText());
  } finally {
    Date.now = realNow;
  }
});

// ---------------------------------------------------------------------------
// Context hardening

test('the context must be complete, well formed and closed', async () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ['unknown key', statusContext({ approved: true })],
    ['issuer override', statusContext({ issuer: ATTACKER })],
    ['bad asset id', statusContext({ expectedSovereignAssetId: 'asset' })],
    ['blank registrant', statusContext({ expectedRegistrant: '' })],
    ['padded registrant', statusContext({ expectedRegistrant: `${ISSUER} ` })],
    ['bad manifest digest', statusContext({ expectedManifestDigest: 'abc' })],
    ['null terms', statusContext({ expectedTerms: null })],
    ['undefined terms', statusContext({ expectedTerms: undefined })],
    ['partial terms', statusContext({ expectedTerms: { claimId: TERMS.claimId } })],
    ['no resolver', statusContext({ verificationKeyResolver: undefined })],
    ['resolver without function', statusContext({ verificationKeyResolver: {} })],
  ];
  for (const key of ['verificationKeyResolver', 'expectedSovereignAssetId', 'expectedRegistrant', 'expectedManifestDigest']) {
    const context = statusContext();
    delete context[key];
    cases.push([`missing ${key}`, context]);
  }
  for (const [label, context] of cases) await rejects(signedText(), 'CONTEXT_INVALID', context, label);
  for (const context of [undefined, null, 'context', [], () => statusContext()]) {
    const result = await verifySovereignStatus(signedText(), context);
    assert.equal(result.outcome === 'rejected' ? result.reason : result.outcome, 'CONTEXT_INVALID', String(context));
  }
});

test('38. accessors are refused and never invoked, in the context and in the artifact', async () => {
  let invoked = 0;
  const context = statusContext();
  Object.defineProperty(context, 'expectedRegistrant', { enumerable: true, get: () => { invoked += 1; return ISSUER; } });
  await rejects(signedText(), 'CONTEXT_INVALID', context);
  const terms = { claimId: TERMS.claimId, get claimDigest() { invoked += 1; return TERMS.claimDigest; } };
  await rejects(signedText(), 'CONTEXT_INVALID', statusContext({ expectedTerms: terms }));
  const artifact = { get status() { invoked += 1; return payload(); }, proof: {} };
  await rejects(artifact, 'STATUS_MALFORMED');
  assert.equal(invoked, 0);
});

test('38. a resolver getter is read once and the same function serves the lookup', async () => {
  let reads = 0;
  const calls: ResolverCall[] = [];
  const inner = trustingResolver(undefined, calls);
  const resolver = { get resolveVerificationKey() { reads += 1; return reads === 1 ? inner.resolveVerificationKey : () => ({ keyId: attackerKeys.signingKey.keyId, issuer: ISSUER }); } };
  await accepts(signedText(), statusContext({ verificationKeyResolver: resolver }));
  assert.equal(reads, 1);
  assert.deepEqual(calls, [{ issuer: ISSUER }]);
});

test('39. inherited fields, custom prototypes and __proto__ keys are refused', async () => {
  const inherited = Object.assign(Object.create(statusContext()) as Record<string, unknown>, {});
  await rejects(signedText(), 'CONTEXT_INVALID', inherited);
  class Context {
    constructor() { Object.assign(this, statusContext()); }
  }
  await rejects(signedText(), 'CONTEXT_INVALID', new Context());
  const termsWithProto = Object.assign(Object.create({ claimDigest: TERMS.claimDigest }) as Record<string, unknown>, { claimId: TERMS.claimId });
  await rejects(signedText(), 'CONTEXT_INVALID', statusContext({ expectedTerms: termsWithProto }));
  const nullPrototype = Object.assign(Object.create(null) as Record<string, unknown>, statusContext());
  await accepts(signedText(), nullPrototype, 'a null-prototype context is plain data');
  const text = signedText();
  await rejects(text.replace('{"assetStatus"', '{"__proto__":{"assetStatus":"withdrawn"},"assetStatus"'), 'STATUS_MALFORMED');
  await rejects(text.replace('{"claimDigest"', '{"__proto__":null,"claimDigest"'), 'STATUS_MALFORMED');
  await rejects(text.replace('{"algorithm"', '{"__proto__":{},"algorithm"'), 'STATUS_MALFORMED');
});

// ---------------------------------------------------------------------------
// Deliberate limits, pinned

test('LIMIT (FV-P4C): a superseded status still verifies inside its own window', async () => {
  // Sequence 1 says active; sequence 2 withdraws. Both are authentic and in their
  // windows, so both verify: without a trusted history this verifier cannot tell
  // that sequence 1 is stale. Replay detection belongs to FV-P4C.
  const first = sign(payload());
  const second = sign(payload({ assetStatus: 'withdrawn', currentTerms: null, sequence: 2, previousStatusDigest: first.proof['payloadHash'] }));
  const older = await accepts(canonical(first));
  const newer = await accepts(canonical(second), contextWithoutTerms());
  assert.equal(older.assetStatus, 'active');
  assert.equal(newer.assetStatus, 'withdrawn');
  assert.equal(older.freshness, 'not_evaluated');
});

test('LIMIT: previousStatusDigest is declarative and not checked against any history', async () => {
  const result = await accepts(signedText({ sequence: 12, previousStatusDigest: 'c'.repeat(64) }));
  assert.equal(result.previousStatusDigest, 'c'.repeat(64));
});

test('LIMIT: proof.signedAt is not signed and is never relied on', async () => {
  const text = edit(signedText(), (e) => { e.proof['signedAt'] = '1999-01-01T00:00:00Z'; });
  const result = await accepts(text);
  assert.equal(result.issuedAt, ISSUED_AT);
});

// ---------------------------------------------------------------------------
// Fail closed

test('an unexpected exception inside Protocol fails closed', async () => {
  const packageRoot = join(__dirname, '..', '..');
  const manifestPath = require.resolve('@aoc/protocol/manifest');
  const real = require(manifestPath) as Record<string, unknown>;
  const sdkModules = Object.keys(require.cache).filter((path) => path.startsWith(join(packageRoot, 'dist-test', 'src')));
  const saved = require.cache[manifestPath];
  try {
    const faulty = { ...real, verifySovereignSignature: () => { throw new Error('unexpected verifier fault'); } };
    require.cache[manifestPath] = { ...saved, exports: faulty } as NodeJS.Module;
    for (const path of sdkModules) delete require.cache[path];
    const fresh = require('../src/index.js') as typeof import('../src/index.js');
    const result = await fresh.verifySovereignStatus(signedText(), statusContext());
    assert.equal(result.outcome, 'rejected');
    if (result.outcome === 'rejected') assert.equal(result.reason, 'STATUS_INTERNAL_ERROR');
    assert.equal(result.authorization, 'not_evaluated');
  } finally {
    if (saved) require.cache[manifestPath] = saved;
    for (const path of sdkModules) delete require.cache[path];
  }
});

test('the exported constants are the profile identifiers', () => {
  assert.equal(SOVEREIGN_STATUS_PROFILE, 'soberania.sovereign-status/1');
  assert.equal(SOVEREIGN_STATUS_PURPOSE, 'soberania.sovereign-status.assertion');
  assert.equal(SOVEREIGN_STATUS_VERIFIER, 'aoc-enterprise.sovereign-status-verification/1');
});
