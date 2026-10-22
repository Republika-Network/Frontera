import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { AUTHORITY_SIGNING_DOMAINS } from '../authority-authenticity/index.js';
import {
  EXECUTION_CAPABILITY_CHECKS,
  EXECUTION_CAPABILITY_FIELDS,
  EXECUTION_CAPABILITY_LIMITS,
  executionCapabilityActionBindingDigest,
  executionCapabilityGrantReference,
  executionCapabilitySigningBytes,
  isWellFormedExecutionCapability,
  parseExecutionCapability,
  serializeExecutionCapability,
  type ExecutionCapability,
  type ExecutionCapabilityVerification,
} from '../execution-capability/index.js';
import { canonicalSerialize } from '../governance-store/canonical-json.js';
import { AUTHORITY_KEY_A, AUTHORITY_KEY_B, AUTHORITY_KEY_UNTRUSTED, testSigner, testVerifier } from './authority-authenticity-fixture.js';
import {
  G02A_AUDIENCE,
  G02A_BINDING_FORMAT,
  G02A_ISSUER,
  G02A_ORGANIZATION,
  G02A_OTHER_ISSUER,
  G02A_TRUST_DOMAIN,
  NOW,
  bindingValue,
  capabilityFor,
  iso,
  issuerPinning,
  present,
  requestFor,
  respaced,
  signCapability,
  signText,
  verifierFor,
} from './g02a-execution-capability-fixture.js';

/**
 * G-02A — the generic signed execution capability: contract, canonical form
 * and the standalone verifier. Every refusal is asserted by its closed code;
 * a refusal for the wrong reason is a failure, so a test cannot pass because
 * an earlier check happened to refuse.
 */

type Rejected = Extract<ExecutionCapabilityVerification, { verification: 'rejected' }>;
type Verified = Extract<ExecutionCapabilityVerification, { verification: 'verified' }>;

function rejected(result: ExecutionCapabilityVerification, failure: Rejected['failure']): Rejected {
  assert.equal(result.verification, 'rejected', `expected ${failure}, got a verified result`);
  const refusal = result as Rejected;
  assert.equal(refusal.failure, failure);
  return refusal;
}

function verified(result: ExecutionCapabilityVerification): Verified {
  assert.equal(result.verification, 'verified', result.verification === 'rejected' ? `rejected: ${result.failure}` : '');
  return result as Verified;
}

const verifyPresentation = (presentation: unknown, overrides: Parameters<typeof requestFor>[1] = {}, verifier = verifierFor()) => verifier.verify(requestFor(presentation, overrides));

describe('G-02A — a well-formed capability verifies, and the answer is not a permission to execute', () => {
  it('verifies: every check passed, freshness says what offline cannot see, consumption is a separate step', () => {
    const capability = capabilityFor();
    const result = verified(verifyPresentation(present(capability)));
    for (const check of EXECUTION_CAPABILITY_CHECKS) assert.equal(result.checks[check], 'passed', check);
    assert.deepEqual(result.capability, capability);
    assert.deepEqual(result.freshness, { requirement: 'offline-permitted', status: 'not-checked', revocation: 'not-observed', emergencyStop: 'not-observed', exposureBoundedUntil: capability.expiresAt });
    assert.deepEqual(result.consumption, { eligible: true });
    assert.equal(result.verifiedAt, iso(NOW));
    // No single "authorized" boolean exists on the result: verification, freshness and consumption are separate answers.
    assert.equal(['authorized', 'executable', 'allowed', 'ok'].some((key) => key in result), false);
    assert.ok(Object.isFrozen(result) && Object.isFrozen(result.capability) && Object.isFrozen(result.capability.actionBinding));
  });

  it('a rejection reports the failing check and leaves every later check unevaluated', () => {
    const result = rejected(verifyPresentation(present(capabilityFor({ audience: 'executor-other' }))), 'AUDIENCE_MISMATCH');
    assert.equal(result.checks.signature, 'passed');
    assert.equal(result.checks.audience, 'failed');
    for (const later of ['organization', 'trustDomain', 'validityWindow', 'action', 'resource', 'actionBinding'] as const) assert.equal(result.checks[later], 'not-evaluated', later);
  });

  it('a delegated actor is bound when present and never equal to the subject', () => {
    verified(verifyPresentation(present(capabilityFor({ onBehalfOfActorId: 'actor:treasurer' }))));
    assert.equal(isWellFormedExecutionCapability(capabilityFor({ onBehalfOfActorId: 'agent:release-bot' })), false);
    assert.equal(isWellFormedExecutionCapability(capabilityFor({ onBehalfOfActorId: '' })), false);
  });
});

describe('G-02A — signatures: forged, substituted, wrong issuer, wrong key', () => {
  it('forged: signed by an untrusted key while claiming a pinned key id', () => {
    const capability = capabilityFor();
    const forged = { capability: serializeExecutionCapability(capability), signature: signCapability(capability, AUTHORITY_KEY_UNTRUSTED, AUTHORITY_KEY_A.keyId) };
    assert.equal(rejected(verifyPresentation(forged), 'SIGNATURE_INVALID').signatureFailure, 'AUTHORITY_SIGNATURE_INVALID');
  });

  it('a flipped signature bit, a truncated signature and an unsupported algorithm are each refused', () => {
    const presented = present(capabilityFor());
    const bytes = Buffer.from(presented.signature.signature, 'base64url');
    bytes[0] = (bytes[0] ?? 0) ^ 1;
    assert.equal(rejected(verifyPresentation({ ...presented, signature: { ...presented.signature, signature: bytes.toString('base64url') } }), 'SIGNATURE_INVALID').signatureFailure, 'AUTHORITY_SIGNATURE_INVALID');
    assert.equal(rejected(verifyPresentation({ ...presented, signature: { ...presented.signature, signature: presented.signature.signature.slice(4) } }), 'SIGNATURE_INVALID').signatureFailure, 'AUTHORITY_SIGNATURE_MALFORMED');
    assert.equal(rejected(verifyPresentation({ ...presented, signature: { ...presented.signature, algorithm: 'rsa-pss-v1' } }), 'SIGNATURE_INVALID').signatureFailure, 'AUTHORITY_SIGNATURE_ALGORITHM_UNSUPPORTED');
    assert.equal(rejected(verifyPresentation({ ...presented, signature: { ...presented.signature, artifactVersion: 'aoc.authority-artifact.v2' } }), 'SIGNATURE_INVALID').signatureFailure, 'AUTHORITY_ARTIFACT_VERSION_UNSUPPORTED');
  });

  it('modified payload: changing any signed field after signing breaks the signature', () => {
    const capability = capabilityFor();
    const signature = signCapability(capability);
    const changes: Partial<Record<keyof ExecutionCapability, unknown>> = {
      action: 'rollback-release',
      actionBinding: { format: G02A_BINDING_FORMAT, digest: `sha256:${'9'.repeat(64)}` },
      audience: 'executor-devops-gateway-2',
      capabilityId: 'f'.repeat(64),
      consumption: 'single-use',
      executionId: 'aoc.exec:other',
      expiresAt: iso(NOW + 30_000),
      grantReference: `sha256:${'8'.repeat(64)}`,
      issuedAt: iso(NOW - 999),
      onBehalfOfActorId: 'actor:someone',
      organizationId: 'org-g02a-2',
      resource: 'production-cluster-us',
      statusRequirement: 'online-status-required',
      subjectActorId: 'agent:other-bot',
      trustDomain: 'trust-domain-g02a-2',
    };
    for (const [field, value] of Object.entries(changes)) {
      if (field === 'consumption') continue; // one mode exists in v1; nothing to change it to
      const changed = { ...capability, [field]: value } as ExecutionCapability;
      // Executor context follows the change, so only the signature stands between the altered capability and acceptance.
      const verifier = verifierFor({ executor: { audience: changed.audience, organizationIds: [changed.organizationId], trustDomain: changed.trustDomain } });
      const result = verifier.verify(requestFor({ capability: serializeExecutionCapability(changed), signature }, { action: changed.action, resource: changed.resource }));
      rejected(result, 'SIGNATURE_INVALID');
    }
  });

  it('wrong issuer: a capability naming an issuer the executor did not pin', () => {
    rejected(verifyPresentation(present(capabilityFor({ issuer: G02A_OTHER_ISSUER }))), 'ISSUER_UNTRUSTED');
  });

  it('a key pinned for one issuer never vouches for another issuer', () => {
    const verifier = verifierFor({ trustedIssuers: [issuerPinning([AUTHORITY_KEY_A]), issuerPinning([AUTHORITY_KEY_B], G02A_OTHER_ISSUER)] });
    // Issuer 2's capability, signed with issuer 1's key A and naming it.
    rejected(verifier.verify(requestFor(present(capabilityFor({ issuer: G02A_OTHER_ISSUER }), AUTHORITY_KEY_A))), 'ISSUER_KEY_MISMATCH');
    verified(verifier.verify(requestFor(present(capabilityFor({ issuer: G02A_OTHER_ISSUER }, AUTHORITY_KEY_B), AUTHORITY_KEY_B))));
  });

  it('the envelope key id must be the key the capability names, even when both are pinned for the issuer', () => {
    const capability = capabilityFor({}, AUTHORITY_KEY_A);
    rejected(verifyPresentation({ capability: serializeExecutionCapability(capability), signature: signCapability(capability, AUTHORITY_KEY_B) }), 'ISSUER_KEY_MISMATCH');
  });

  it('a key id unknown to every pinned issuer is refused before any cryptography', () => {
    rejected(verifyPresentation(present(capabilityFor({}, AUTHORITY_KEY_UNTRUSTED), AUTHORITY_KEY_UNTRUSTED)), 'ISSUER_KEY_MISMATCH');
  });

  it('cross-artifact substitution: no other authority artifact signature stands in for a capability, nor the reverse', () => {
    const capability = capabilityFor();
    const text = serializeExecutionCapability(capability);
    // The same canonical text signed with no domain, under the delegated-offer domain, and under the grant domain.
    rejected(verifyPresentation({ capability: text, signature: signText(text, AUTHORITY_KEY_A, '') }), 'SIGNATURE_INVALID');
    rejected(verifyPresentation({ capability: text, signature: signText(text, AUTHORITY_KEY_A, AUTHORITY_SIGNING_DOMAINS.delegatedOfferCapability) }), 'SIGNATURE_INVALID');
    rejected(verifyPresentation({ capability: text, signature: signText(text, AUTHORITY_KEY_A, AUTHORITY_SIGNING_DOMAINS.grant) }), 'SIGNATURE_INVALID');
    // A genuine CORE-02 signature by the same key over another artifact kind.
    return testSigner(AUTHORITY_KEY_A)
      .signRevocationState({ storeId: 'grant-store-g02a', sequence: 0, revocationSetDigest: `sha256:${'0'.repeat(64)}` })
      .then((stateSignature) => {
        rejected(verifyPresentation({ capability: text, signature: stateSignature }), 'SIGNATURE_INVALID');
        // And a capability signature verifies as no other artifact.
        assert.equal(testVerifier([AUTHORITY_KEY_A]).verifyRevocationState({ storeId: 'grant-store-g02a', sequence: 0, revocationSetDigest: `sha256:${'0'.repeat(64)}` }, signCapability(capability)).verified, false);
      });
  });

  it('the signing bytes are the CORE-02 domain followed by exactly the canonical text, and the domain is unique', () => {
    const capability = capabilityFor();
    assert.equal(executionCapabilitySigningBytes(capability).toString('utf8'), `frontera:authority-artifact:execution-capability:v1\n${serializeExecutionCapability(capability)}`);
    assert.equal(AUTHORITY_SIGNING_DOMAINS.executionCapability, 'frontera:authority-artifact:execution-capability:v1\n');
    const domains = Object.values(AUTHORITY_SIGNING_DOMAINS);
    assert.equal(new Set(domains).size, domains.length);
    for (const other of domains.filter((domain) => domain !== AUTHORITY_SIGNING_DOMAINS.executionCapability)) {
      assert.equal(other.startsWith(AUTHORITY_SIGNING_DOMAINS.executionCapability) || AUTHORITY_SIGNING_DOMAINS.executionCapability.startsWith(other), false, other);
    }
  });
});

describe('G-02A — key rotation', () => {
  it('both pinned keys verify during overlap; unpinning the old key refuses its capabilities and nothing else', () => {
    const byA = present(capabilityFor({}, AUTHORITY_KEY_A), AUTHORITY_KEY_A);
    const byB = present(capabilityFor({}, AUTHORITY_KEY_B), AUTHORITY_KEY_B);
    verified(verifyPresentation(byA));
    verified(verifyPresentation(byB));
    const rotated = verifierFor({ trustedIssuers: [issuerPinning([AUTHORITY_KEY_B])] });
    rejected(rotated.verify(requestFor(byA)), 'ISSUER_KEY_MISMATCH');
    verified(rotated.verify(requestFor(byB)));
  });

  it('pinning refuses ambiguity: a duplicate issuer, a key pinned for two issuers, an empty or private key set', () => {
    assert.throws(() => verifierFor({ trustedIssuers: [issuerPinning([AUTHORITY_KEY_A]), issuerPinning([AUTHORITY_KEY_B])] }), /pinned twice/);
    assert.throws(() => verifierFor({ trustedIssuers: [issuerPinning([AUTHORITY_KEY_A]), issuerPinning([AUTHORITY_KEY_A], G02A_OTHER_ISSUER)] }), /more than one issuer/);
    assert.throws(() => verifierFor({ trustedIssuers: [{ issuer: G02A_ISSUER, keys: [] }] }));
    assert.throws(() => verifierFor({ trustedIssuers: [{ issuer: G02A_ISSUER, keys: [{ keyId: 'k', algorithm: 'ed25519-v1', publicKeyPem: AUTHORITY_KEY_A.privateKeyPem }] }] }), /private key/);
    assert.throws(() => verifierFor({ trustedIssuers: [] }), /at least one pinned issuer/);
  });
});

describe('G-02A — audience, organization and trust domain: no cross-executor, cross-organization or cross-domain replay', () => {
  it('wrong audience is refused; an audience is never a pattern', () => {
    rejected(verifyPresentation(present(capabilityFor({ audience: 'executor-data-worker' }))), 'AUDIENCE_MISMATCH');
    assert.equal(isWellFormedExecutionCapability(capabilityFor({ audience: '*' })), false);
    assert.equal(isWellFormedExecutionCapability(capabilityFor({ audience: 'executor-*' })), false);
    assert.throws(() => verifierFor({ executor: { audience: '*', organizationIds: [G02A_ORGANIZATION], trustDomain: G02A_TRUST_DOMAIN } }), /pattern is not an audience/);
    // Case and whitespace variants are other audiences.
    rejected(verifyPresentation(present(capabilityFor({ audience: G02A_AUDIENCE.toUpperCase() }))), 'AUDIENCE_MISMATCH');
  });

  it('the same capability presented to a second executor is refused there', () => {
    const presented = present(capabilityFor());
    verified(verifyPresentation(presented));
    const other = verifierFor({ executor: { audience: 'executor-data-worker', organizationIds: [G02A_ORGANIZATION], trustDomain: G02A_TRUST_DOMAIN } });
    rejected(other.verify(requestFor(presented)), 'AUDIENCE_MISMATCH');
  });

  it('cross-organization replay is refused', () => {
    rejected(verifyPresentation(present(capabilityFor({ organizationId: 'org-other' }))), 'ORGANIZATION_MISMATCH');
    const multi = verifierFor({ executor: { audience: G02A_AUDIENCE, organizationIds: ['org-other', G02A_ORGANIZATION], trustDomain: G02A_TRUST_DOMAIN } });
    verified(multi.verify(requestFor(present(capabilityFor()))));
  });

  it('cross-trust-domain replay is refused', () => {
    rejected(verifyPresentation(present(capabilityFor({ trustDomain: 'trust-domain-other' }))), 'TRUST_DOMAIN_MISMATCH');
  });
});

describe('G-02A — the validity window', () => {
  const window = (issuedAt: number, expiresAt: number) => present(capabilityFor({ issuedAt: iso(issuedAt), expiresAt: iso(expiresAt) }));

  it('expired at the instant of expiry; valid one millisecond before', () => {
    rejected(verifyPresentation(window(NOW - 30_000, NOW)), 'CAPABILITY_EXPIRED');
    verified(verifyPresentation(window(NOW - 29_999, NOW + 1)));
  });

  it('not yet valid beyond the clock-skew allowance; valid at it', () => {
    rejected(verifyPresentation(window(NOW + 5_001, NOW + 20_000)), 'CAPABILITY_NOT_YET_VALID');
    verified(verifyPresentation(window(NOW + 5_000, NOW + 20_000)));
  });

  it('a lifetime above 60 s, or a non-positive one, is invalid whatever the clock says', () => {
    rejected(verifyPresentation(window(NOW - 1_000, NOW - 1_000 + 60_001)), 'CAPABILITY_LIFETIME_INVALID');
    verified(verifyPresentation(window(NOW - 1_000, NOW - 1_000 + 60_000)));
    rejected(verifyPresentation(window(NOW, NOW)), 'CAPABILITY_LIFETIME_INVALID');
    rejected(verifyPresentation(window(NOW + 1, NOW)), 'CAPABILITY_LIFETIME_INVALID');
    assert.equal(EXECUTION_CAPABILITY_LIMITS.defaultLifetimeMs, 30_000);
    assert.equal(EXECUTION_CAPABILITY_LIMITS.maximumLifetimeMs, 60_000);
  });

  it('an executor may accept a shorter maximum lifetime, never a longer one', () => {
    const strict = verifierFor({ maximumLifetimeMs: 10_000 });
    rejected(strict.verify(requestFor(window(NOW - 1_000, NOW + 10_000))), 'CAPABILITY_LIFETIME_INVALID');
    verified(strict.verify(requestFor(window(NOW - 1_000, NOW + 9_000))));
    assert.throws(() => verifierFor({ maximumLifetimeMs: 60_001 }), /maximumLifetimeMs/);
    assert.throws(() => verifierFor({ maximumClockSkewMs: 5_001 }), /maximumClockSkewMs/);
  });

  it('a well-shaped but impossible instant is malformed — never a throw, never a verifier failure', () => {
    for (const impossible of ['2026-13-01T00:00:00.000Z', '2026-10-22T25:00:00.000Z', '2026-10-22T12:61:00.000Z']) {
      assert.equal(isWellFormedExecutionCapability(capabilityFor({ issuedAt: impossible })), false, impossible);
      const text = serializeExecutionCapability(capabilityFor()).replace(/"issuedAt":"[^"]+"/, `"issuedAt":"${impossible}"`);
      rejected(verifyPresentation({ capability: text, signature: signText(text) }), 'CAPABILITY_MALFORMED');
    }
  });

  it('a clock that cannot answer refuses; a clock that throws fails closed', () => {
    rejected(verifyPresentation(present(capabilityFor()), {}, verifierFor({ clock: () => Number.NaN })), 'CLOCK_UNAVAILABLE');
    const throwing = verifierFor({
      clock: () => {
        throw new Error('clock unavailable');
      },
    });
    rejected(throwing.verify(requestFor(present(capabilityFor()))), 'VERIFIER_FAILURE');
    assert.throws(() => verifierFor({ clock: undefined as never }), /clock/);
  });
});

describe('G-02A — what is about to be executed: action, resource and the action binding', () => {
  it('action and resource must be exactly the capability’s', () => {
    rejected(verifyPresentation(present(capabilityFor()), { action: 'rollback-release' }), 'ACTION_MISMATCH');
    rejected(verifyPresentation(present(capabilityFor()), { resource: 'production-cluster-us' }), 'RESOURCE_MISMATCH');
  });

  it('a modified request is refused: the executor’s own binding must digest to the signed one', () => {
    const presented = present(capabilityFor());
    rejected(verifyPresentation(presented, { value: bindingValue({ body: { strategy: 'rolling', replicas: 5, requestId: 'deploy-7' } }) }), 'ACTION_BINDING_MISMATCH');
    rejected(verifyPresentation(presented, { value: bindingValue({ path: '/deployments/production-cluster-us' }) }), 'ACTION_BINDING_MISMATCH');
    rejected(verifyPresentation(presented, { value: { ...bindingValue(), extra: true } }), 'ACTION_BINDING_MISMATCH');
    rejected(verifyPresentation(presented, { format: 'frontera.job-message-binding.v1' }), 'ACTION_BINDING_FORMAT_MISMATCH');
  });

  it('nested binding objects digest independently of key order, never of nesting or values', () => {
    const presented = present(capabilityFor());
    const reordered = { body: { requestId: 'deploy-7', replicas: 4, strategy: 'rolling' }, headers: { 'x-replica-count': '4' }, query: { strategy: 'rolling' }, path: '/deployments/production-cluster-eu', method: 'PATCH' };
    verified(verifyPresentation(presented, { value: reordered }));
    rejected(verifyPresentation(presented, { value: { ...bindingValue(), body: [{ strategy: 'rolling', replicas: 4, requestId: 'deploy-7' }] } }), 'ACTION_BINDING_MISMATCH');
  });

  it('numeric representation: a number digests by value, never by spelling or type', () => {
    const digest = (value: unknown) => executionCapabilityActionBindingDigest({ format: G02A_BINDING_FORMAT, value });
    assert.equal(digest({ n: 4 }), digest({ n: 4.0 }));
    assert.equal(digest({ n: 100 }), digest({ n: 1e2 }));
    assert.equal(digest({ n: 0 }), digest({ n: -0 }));
    assert.notEqual(digest({ n: 4 }), digest({ n: '4' }));
    assert.notEqual(digest({ n: 4 }), digest({ n: 4.000001 }));
    assert.equal(digest({ n: JSON.parse('4.0') as number }), digest({ n: 4 }), 'a parsed "4.0" is the number 4');
    assert.throws(() => digest({ n: Number.POSITIVE_INFINITY }));
    assert.throws(() => digest({ n: Number.NaN }));
  });

  it('an own __proto__ key is digested as a property — never dropped, never applied as a prototype', () => {
    const digest = (value: unknown) => executionCapabilityActionBindingDigest({ format: G02A_BINDING_FORMAT, value });
    assert.notEqual(digest(JSON.parse('{"amount":1,"__proto__":7}') as unknown), digest({ amount: 1 }));
    assert.notEqual(digest(JSON.parse('{"amount":1,"__proto__":{"b":2}}') as unknown), digest({ amount: 1 }));
    // A request carrying an unsigned __proto__ field does not verify against the capability issued for the request without it.
    const withProto = { ...bindingValue(), ...(JSON.parse('{"__proto__":7}') as object) };
    rejected(verifyPresentation(present(capabilityFor()), { value: withProto }), 'ACTION_BINDING_MISMATCH');
  });

  it('a binding that is not plain JSON data is malformed, never digested', () => {
    const presented = present(capabilityFor());
    let reads = 0;
    const accessor = Object.defineProperty({}, 'replicas', {
      enumerable: true,
      get() {
        reads += 1;
        return 4;
      },
    });
    class Request {
      readonly method = 'PATCH';
    }
    const sparse: unknown[] = [];
    sparse[2] = 1;
    for (const value of [{ a: undefined }, { a: () => 1 }, { a: Symbol('x') }, { a: 1n }, accessor, new Request(), { a: sparse }, { a: new Date(0) }, { [Symbol('k')]: 1 }]) {
      rejected(verifyPresentation(presented, { value }), 'ACTION_BINDING_MALFORMED');
    }
    assert.equal(reads, 0, 'an accessor in the binding is refused, never invoked');
    // `{ a: undefined }` and `{}` cannot share a digest: one of them is not a binding at all.
    assert.throws(() => executionCapabilityActionBindingDigest({ format: G02A_BINDING_FORMAT, value: { a: undefined } }));
  });
});

describe('G-02A — canonical form: what was signed is exactly what is verified', () => {
  /** A capability's canonical text re-spelled, then signed *as re-spelled* — the attacker's best case. */
  const signedVariant = (text: string) => ({ capability: text, signature: signText(text) });

  it('serialize is aoc.canonical-json.v1 of the closed record, and parse inverts it exactly', () => {
    const capability = capabilityFor();
    const text = serializeExecutionCapability(capability);
    assert.equal(text, canonicalSerialize(capability));
    assert.deepEqual(Object.keys(JSON.parse(text) as object), [...EXECUTION_CAPABILITY_FIELDS]);
    const parsed = parseExecutionCapability(text);
    if (!parsed.ok) assert.fail(`the canonical text must parse: ${parsed.failure}`);
    assert.deepEqual(parsed.capability, capability);
  });

  it('property reordering is refused, at the top level and inside the action binding', () => {
    const capability = capabilityFor();
    const reversed = `{${[...EXECUTION_CAPABILITY_FIELDS].reverse().map((field) => `${JSON.stringify(field)}:${canonicalSerialize(capability[field])}`).join(',')}}`;
    rejected(verifyPresentation(signedVariant(reversed)), 'CAPABILITY_NONCANONICAL');
    const text = serializeExecutionCapability(capability);
    const bindingSwapped = text.replace(canonicalSerialize(capability.actionBinding), `{"format":${JSON.stringify(capability.actionBinding.format)},"digest":${JSON.stringify(capability.actionBinding.digest)}}`);
    assert.notEqual(bindingSwapped, text);
    rejected(verifyPresentation(signedVariant(bindingSwapped)), 'CAPABILITY_NONCANONICAL');
  });

  it('whitespace and escape re-spellings are refused', () => {
    const text = serializeExecutionCapability(capabilityFor());
    rejected(verifyPresentation(signedVariant(respaced(text))), 'CAPABILITY_NONCANONICAL');
    rejected(verifyPresentation(signedVariant(`${text}\n`)), 'CAPABILITY_NONCANONICAL');
    rejected(verifyPresentation(signedVariant(text.replace('"deploy-release"', '"\\u0064eploy-release"'))), 'CAPABILITY_NONCANONICAL');
  });

  it('duplicate properties are refused, whether the duplicate agrees or not', () => {
    const capability = capabilityFor();
    const text = serializeExecutionCapability(capability);
    rejected(verifyPresentation(signedVariant(text.replace('"action":"deploy-release",', '"action":"deploy-release","action":"deploy-release",'))), 'CAPABILITY_NONCANONICAL');
    rejected(verifyPresentation(signedVariant(text.replace('"action":"deploy-release",', '"action":"rollback-release","action":"deploy-release",'))), 'CAPABILITY_NONCANONICAL');
  });

  it('a validly signed non-canonical spelling of a genuine capability is refused, not normalized', () => {
    const capability = capabilityFor();
    const genuine = present(capability);
    // The original signature, presented with a re-spaced text of the same logical capability.
    rejected(verifyPresentation({ capability: respaced(genuine.capability), signature: genuine.signature }), 'CAPABILITY_NONCANONICAL');
  });

  it('numbers are not representable in the capability', () => {
    const text = serializeExecutionCapability(capabilityFor());
    rejected(verifyPresentation(signedVariant(text.replace(/"issuedAt":"[^"]+"/, `"issuedAt":${NOW}`))), 'CAPABILITY_MALFORMED');
    rejected(verifyPresentation(signedVariant(text.replace('"consumption":"single-use"', '"consumption":1'))), 'CAPABILITY_MALFORMED');
  });

  it('Unicode normalization: NFC and NFD spellings are different identifiers, compared code unit for code unit', () => {
    const nfc = 'org-café';
    const nfd = 'org-café';
    assert.equal(nfc.normalize('NFD'), nfd);
    const capability = capabilityFor({ organizationId: nfc });
    const presented = present(capability);
    verified(verifyPresentation(presented, {}, verifierFor({ executor: { audience: G02A_AUDIENCE, organizationIds: [nfc], trustDomain: G02A_TRUST_DOMAIN } })));
    rejected(verifyPresentation(presented, {}, verifierFor({ executor: { audience: G02A_AUDIENCE, organizationIds: [nfd], trustDomain: G02A_TRUST_DOMAIN } })), 'ORGANIZATION_MISMATCH');
    // The same capability text re-normalized no longer carries the signed bytes.
    const renormalized = presented.capability.normalize('NFD');
    assert.notEqual(renormalized, presented.capability);
    rejected(verifyPresentation({ capability: renormalized, signature: presented.signature }, {}, verifierFor({ executor: { audience: G02A_AUDIENCE, organizationIds: [nfd], trustDomain: G02A_TRUST_DOMAIN } })), 'SIGNATURE_INVALID');
    const digest = (value: unknown) => executionCapabilityActionBindingDigest({ format: G02A_BINDING_FORMAT, value });
    assert.notEqual(digest({ name: nfc }), digest({ name: nfd }));
  });

  it('malformed Unicode: an unpaired surrogate is refused raw, escaped, in a key and in a binding', () => {
    const text = serializeExecutionCapability(capabilityFor());
    // Raw lone surrogate in the presented text.
    rejected(verifyPresentation(signedVariant(text.replace('"agent:release-bot"', '"agent:release-bot\ud800"'))), 'CAPABILITY_MALFORMED');
    // Escaped: canonical JSON of an identifier holding a lone surrogate, validly signed.
    const escaped = text.replace('"agent:release-bot"', '"agent:release-bot\\ud800"');
    rejected(verifyPresentation(signedVariant(escaped)), 'CAPABILITY_MALFORMED');
    assert.equal(isWellFormedExecutionCapability(capabilityFor({ subjectActorId: 'agent:\udc00' })), false);
    const presented = present(capabilityFor());
    rejected(verifyPresentation(presented, { value: { ...bindingValue(), note: 'x\ud800' } }), 'ACTION_BINDING_MALFORMED');
    rejected(verifyPresentation(presented, { value: { ...bindingValue(), ['k\udc00']: 1 } }), 'ACTION_BINDING_MALFORMED');
    // A well-formed astral character is fine.
    verified(verifyPresentation(present(capabilityFor({ subjectActorId: 'agent:🚀' }))));
  });

  it('extra, unknown and missing fields are refused, at both levels', () => {
    const capability = capabilityFor();
    const withExtra = canonicalSerialize({ ...capability, approvalId: 'appr-1' });
    rejected(verifyPresentation(signedVariant(withExtra)), 'CAPABILITY_MALFORMED');
    const { grantReference: _omitted, ...missing } = capability;
    rejected(verifyPresentation(signedVariant(canonicalSerialize(missing))), 'CAPABILITY_MALFORMED');
    const bindingExtra = canonicalSerialize({ ...capability, actionBinding: { ...capability.actionBinding, value: { method: 'PATCH' } } });
    rejected(verifyPresentation(signedVariant(bindingExtra)), 'CAPABILITY_MALFORMED');
  });

  it('another format version is reported as unsupported, not misread', () => {
    const v2 = canonicalSerialize({ ...capabilityFor(), format: 'frontera.execution-capability.v2' });
    rejected(verifyPresentation(signedVariant(v2)), 'CAPABILITY_FORMAT_UNSUPPORTED');
  });

  it('oversized and non-JSON texts are malformed', () => {
    rejected(verifyPresentation(signedVariant('not json')), 'CAPABILITY_MALFORMED');
    rejected(verifyPresentation(signedVariant(`"${'a'.repeat(EXECUTION_CAPABILITY_LIMITS.canonicalMaximumLength)}"`)), 'CAPABILITY_MALFORMED');
    rejected(verifyPresentation(signedVariant('[]')), 'CAPABILITY_MALFORMED');
  });
});

describe('G-02A — the presentation is read once, exactly, and never through an accessor', () => {
  it('extra or missing presentation and envelope fields are refused', () => {
    const presented = present(capabilityFor());
    rejected(verifyPresentation({ ...presented, binding: {} }), 'PRESENTATION_MALFORMED');
    rejected(verifyPresentation({ capability: presented.capability }), 'PRESENTATION_MALFORMED');
    rejected(verifyPresentation({ ...presented, signature: { ...presented.signature, publicKeyPem: AUTHORITY_KEY_UNTRUSTED.publicKeyPem } }), 'PRESENTATION_MALFORMED');
    rejected(verifyPresentation({ capability: JSON.parse(presented.capability) as unknown, signature: presented.signature }), 'PRESENTATION_MALFORMED');
    rejected(verifyPresentation(null), 'PRESENTATION_MALFORMED');
  });

  it('a getter anywhere in the presentation or request is refused without being invoked', () => {
    const presented = present(capabilityFor());
    let reads = 0;
    const counting = <T>(value: T) => ({
      enumerable: true,
      get(): T {
        reads += 1;
        return value;
      },
    });
    rejected(verifyPresentation(Object.defineProperty({ signature: presented.signature }, 'capability', counting(presented.capability))), 'PRESENTATION_MALFORMED');
    rejected(verifyPresentation({ capability: presented.capability, signature: Object.defineProperty({ ...presented.signature }, 'keyId', counting(AUTHORITY_KEY_A.keyId)) }), 'PRESENTATION_MALFORMED');
    const request = Object.defineProperty({ presentation: presented, action: 'deploy-release', actionBinding: { format: G02A_BINDING_FORMAT, value: bindingValue() } }, 'resource', counting('production-cluster-eu'));
    rejected(verifierFor().verify(request as never), 'PRESENTATION_MALFORMED');
    assert.equal(reads, 0);
  });
});

describe('G-02A — freshness: offline is honest, and status-required is never consumable without status', () => {
  it('an online-status-required capability verifies cryptographically but is not eligible for consumption', () => {
    const result = verified(verifyPresentation(present(capabilityFor({ statusRequirement: 'online-status-required' }))));
    assert.deepEqual(result.freshness, { requirement: 'online-status-required', status: 'unavailable', revocation: 'not-observed', emergencyStop: 'not-observed' });
    assert.deepEqual(result.consumption, { eligible: false, reason: 'STATUS_REQUIRED_UNAVAILABLE' });
  });

  it('an unknown status requirement is not a weaker one: it is malformed', () => {
    assert.equal(isWellFormedExecutionCapability(capabilityFor({ statusRequirement: 'best-effort' })), false);
    assert.equal(isWellFormedExecutionCapability(capabilityFor({ consumption: 'multi-use' })), false);
  });
});

describe('G-02A — the internal grant is referenced, never carried', () => {
  it('the closed field list holds no grant, decision, request, policy, approval or evidence content', () => {
    assert.deepEqual([...EXECUTION_CAPABILITY_FIELDS], [
      'action', 'actionBinding', 'audience', 'capabilityId', 'consumption', 'executionId', 'expiresAt', 'format', 'grantReference',
      'issuedAt', 'issuer', 'issuerKeyId', 'onBehalfOfActorId', 'organizationId', 'resource', 'statusRequirement', 'subjectActorId', 'trustDomain',
    ]);
    for (const banned of [/grantId/i, /grantDigest/i, /decision/i, /requestId/i, /polic/i, /approval/i, /evidence/i, /scope/i, /parameters/i]) {
      assert.equal(EXECUTION_CAPABILITY_FIELDS.some((field) => banned.test(field)), false, String(banned));
    }
  });

  it('the grant reference is a deterministic, domain-separated digest of store, id and digest — opaque, and sensitive to each', () => {
    const base = { grantStoreId: 'grant-store-g02a', boundedGrantId: 'aoc.grant:0123456789abcdef', grantDigest: `sha256:${'1'.repeat(64)}` };
    const reference = executionCapabilityGrantReference(base);
    assert.match(reference, /^sha256:[0-9a-f]{64}$/);
    assert.equal(executionCapabilityGrantReference({ ...base }), reference);
    for (const changed of [{ grantStoreId: 'grant-store-other' }, { boundedGrantId: 'aoc.grant:fedcba9876543210' }, { grantDigest: `sha256:${'2'.repeat(64)}` }]) {
      assert.notEqual(executionCapabilityGrantReference({ ...base, ...changed }), reference);
    }
    assert.equal(reference.includes(base.boundedGrantId) || reference.includes(base.grantStoreId), false);
    assert.throws(() => executionCapabilityGrantReference({ ...base, grantDigest: 'not-a-digest' }));
  });
});

describe('G-02A — the fixture organization and issuer are the ones the suite pins', () => {
  it('control: the default fixture binds the documented deployment', () => {
    const capability = capabilityFor();
    assert.equal(capability.issuer, G02A_ISSUER);
    assert.equal(capability.organizationId, G02A_ORGANIZATION);
    assert.equal(capability.trustDomain, G02A_TRUST_DOMAIN);
  });
});
