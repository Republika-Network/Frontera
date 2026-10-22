import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  AUTHORITY_SIGNING_DOMAINS,
  EXECUTION_CAPABILITY_EXECUTION_DERIVATION,
  createAuthorityArtifactVerifier,
  assessExecutionCapabilityIssuance,
  createExecutionCapabilityIssuancePolicy,
  executionCapabilityGrantReferenceV2,
  executionIdForGrant,
  type ExecutionCapabilityIssuanceRequest,
} from '../authority-authenticity/index.js';
import {
  EXECUTION_CAPABILITY_GRANT_REFERENCE_DOMAIN,
  EXECUTION_CAPABILITY_SIGNING_DOMAIN,
  createExecutionCapabilityVerifier,
  executionCapabilityGrantReference,
  executionCapabilitySigningBytes,
  serializeExecutionCapability,
} from '../execution-capability/index.js';
import {
  EXTERNAL_AUTHORITY_SIGNER_EXTENSION_PATHS,
  EXTERNAL_AUTHORITY_SIGNER_OPERATIONS,
  createHttpExternalAuthoritySignerTransport,
  establishExternalAuthorityArtifactSigner,
  externalSigningRequestBody,
  parseExternalSigningRequest,
} from '../external-authority-signer/index.js';
import { startReferenceAuthoritySigner } from '../external-authority-signer/reference/reference-signer-service.js';
import { ExternalAuthoritySignerTransportError } from '../external-authority-signer/transport.js';
import { parseStoredGrant } from '../bounded-grant-store/sqlite-bounded-grant-store.js';
import { deriveGovernedActionExecutionId } from '../governed-action/identifiers.js';
import { AUTHORITY_KEY_A, AUTHORITY_KEY_B, AUTHORITY_KEY_UNTRUSTED, testSigner, testVerifier, trustedKeyOf } from './authority-authenticity-fixture.js';
import { signerKeyDirectory, spawnReferenceSigner } from './core02-external-signer-fixture.js';
import {
  G02B_ACTION,
  G02B_AUDIENCE,
  G02B_BINDING_FORMAT,
  G02B_ISSUER,
  G02B_ORGANIZATION,
  G02B_OTHER_AUDIENCE,
  G02B_RESOURCE,
  G02B_STORE,
  G02B_TRUST_DOMAIN,
  NOW,
  POLICY,
  bindingDigest,
  capabilityFor,
  custodySigner,
  grantFor,
  iso,
  policyInput,
  requestFor,
  signCapabilityBytes,
  signedGrant,
} from './g02b-execution-capability-issuance-fixture.js';

/**
 * G-02B — the in-custody issuance rule and the custody boundaries that apply
 * it: the software signer, the reference external service over loopback HTTP
 * in this process, and the shipped reference launcher as its own process. A
 * capability is signed only for a grant the boundary's own key signed, for
 * exactly what that grant and the boundary's own policy allow, and only over
 * G-02A's canonical signing bytes.
 */

const LAUNCHER_TOKEN = 'FRONTERA_G02B_LAUNCHER_TOKEN_SENTINEL_5d1e83a0c7f4b926';

const rule = (now = NOW, policy = POLICY) => ({ verifyGrant: testVerifier([AUTHORITY_KEY_A]).verifyGrant, activeKeyId: AUTHORITY_KEY_A.keyId, policy, now });

describe('G-02B custody rule — what is issuable', () => {
  it('a capability derived from its own grant, within policy, is issuable — as a frozen canonical copy', async () => {
    const request = requestFor(await signedGrant());
    const assessment = assessExecutionCapabilityIssuance(request, rule());
    assert.equal(assessment.issuable, true);
    if (!assessment.issuable) return;
    assert.ok(Object.isFrozen(assessment.capability));
    assert.equal(assessment.canonical, serializeExecutionCapability(request.capability));
    assert.notEqual(assessment.capability, request.capability, 'the rule decides over its own copy, never the presented object');
  });

  it('the execution derivation is the governed path’s own, restated as data and pinned equal', async () => {
    const signed = await signedGrant();
    assert.equal(executionIdForGrant(signed.grant), deriveGovernedActionExecutionId({ requestId: signed.grant.correlation.requestId, decisionId: signed.grant.correlation.decisionId }));
    assert.deepEqual({ ...EXECUTION_CAPABILITY_EXECUTION_DERIVATION }, { tag: 'aoc.governed-action.execution.v1', prefix: 'aoc.exec:' });
  });

  const refusals: readonly [string, () => Promise<ExecutionCapabilityIssuanceRequest>, string][] = [
    ['a capability that is not well formed', async () => requestFor(await signedGrant(), { capabilityId: 'AB'.repeat(32) }), 'CAPABILITY_MALFORMED'],
    ['an extra field', async () => requestFor(await signedGrant(), { extra: 1 } as never), 'CAPABILITY_MALFORMED'],
    ['an accessor field (never invoked into a signature)', async () => {
      const request = requestFor(await signedGrant());
      const capability = { ...request.capability };
      Object.defineProperty(capability, 'audience', { get: () => G02B_AUDIENCE, enumerable: true });
      return { ...request, capability };
    }, 'CAPABILITY_MALFORMED'],
    ['an issuer other than the boundary’s', async () => requestFor(await signedGrant(), { issuer: 'frontera-deployment-other' }), 'CAPABILITY_ISSUER_MISMATCH'],
    ['an issuer key id other than the boundary’s', async () => requestFor(await signedGrant(), { issuerKeyId: AUTHORITY_KEY_B.keyId }), 'CAPABILITY_ISSUER_MISMATCH'],
    ['a foreign organization', async () => requestFor(await signedGrant(), { organizationId: 'org-other' }), 'CAPABILITY_ORGANIZATION_MISMATCH'],
    ['a foreign trust domain', async () => requestFor(await signedGrant(), { trustDomain: 'trust-domain-other' }), 'CAPABILITY_TRUST_DOMAIN_MISMATCH'],
    ['status required (no status mechanism before G-02D)', async () => requestFor(await signedGrant(), { statusRequirement: 'online-status-required' }), 'CAPABILITY_TERMS_UNSUPPORTED'],
    ['an on-behalf-of actor (no delegation in G-02B)', async () => requestFor(await signedGrant(), { onBehalfOfActorId: 'actor-principal' }), 'CAPABILITY_TERMS_UNSUPPORTED'],
    ['an unregistered audience', async () => requestFor(await signedGrant(), { audience: 'executor-unknown' }), 'AUDIENCE_NOT_REGISTERED'],
    ['an action the audience is not registered for', async () => requestFor(await signedGrant({ action: 'export-records' })), 'AUDIENCE_ACTION_NOT_PERMITTED'],
    ['a binding format the audience does not accept', async () => requestFor(await signedGrant(), { actionBinding: { format: 'frontera.other-binding.v1', digest: bindingDigest() } }), 'AUDIENCE_BINDING_FORMAT_NOT_PERMITTED'],
    ['a forged grant (signed by an untrusted key)', async () => requestFor(await signedGrant({ key: AUTHORITY_KEY_UNTRUSTED })), 'GRANT_SIGNATURE_INVALID'],
    ['a grant signed by another trusted key (not the custody key)', async () => requestFor(await signedGrant({ key: AUTHORITY_KEY_B })), 'GRANT_SIGNATURE_INVALID'],
    ['a grant presented with no signature', async () => ({ ...requestFor(await signedGrant()), grantSignature: undefined }), 'GRANT_SIGNATURE_INVALID'],
    ['a grant presented under another store id', async () => ({ ...requestFor(await signedGrant()), storeId: 'grant-store-other' }), 'GRANT_SIGNATURE_INVALID'],
    ['a grant whose digest does not match', async () => {
      const request = requestFor(await signedGrant());
      return { ...request, grant: { ...request.grant, digest: `sha256:${'0'.repeat(64)}` } };
    }, 'GRANT_MALFORMED'],
    ['a grant rewritten after signing (id and digest recomputed)', async () => {
      const signed = await signedGrant();
      const rewritten = (await signedGrant({ requestId: signed.grant.correlation.requestId, decisionId: signed.grant.correlation.decisionId, expiresAt: NOW + 7_200_000 })).grant;
      return { ...requestFor(signed), grant: rewritten };
    }, 'GRANT_SIGNATURE_INVALID'],
    ['a grant reference for another grant', async () => {
      const request = requestFor(await signedGrant());
      const other = await signedGrant();
      return { ...request, grant: other.grant, grantSignature: other.signature };
    }, 'GRANT_REFERENCE_MISMATCH'],
    ['a nonce other than the one the reference was derived from', async () => ({ ...requestFor(await signedGrant()), grantReferenceNonce: 'ab'.repeat(32) }), 'GRANT_REFERENCE_MISMATCH'],
    ['a malformed nonce', async () => ({ ...requestFor(await signedGrant()), grantReferenceNonce: 'not-a-nonce' }), 'GRANT_REFERENCE_MISMATCH'],
    ['G-02A’s per-grant reference instead of the per-capability one', async () => {
      const signed = await signedGrant();
      return requestFor(signed, { grantReference: executionCapabilityGrantReference({ grantStoreId: signed.storeId, boundedGrantId: signed.grant.id, grantDigest: signed.grant.digest }) });
    }, 'GRANT_REFERENCE_MISMATCH'],
    ['a grant of another organization', async () => requestFor(await signedGrant({ organizationId: 'org-other' })), 'GRANT_ORGANIZATION_MISMATCH'],
    ['a grant with no organization bound', async () => requestFor(await signedGrant({ organizationId: null })), 'GRANT_ORGANIZATION_MISMATCH'],
    ['another subject', async () => requestFor(await signedGrant(), { subjectActorId: 'actor-other' }), 'GRANT_SUBJECT_MISMATCH'],
    ['an action the grant does not name', async () => requestFor(await signedGrant({ action: 'export-records' }), { action: G02B_ACTION }), 'GRANT_ACTION_MISMATCH'],
    ['a grant whose scope bounds another action', async () => requestFor(await signedGrant({ scope: { action: { kind: 'identity', value: 'export-records' } } })), 'GRANT_ACTION_MISMATCH'],
    ['a resource the grant does not name', async () => requestFor(await signedGrant(), { resource: 'production-cluster-us' }), 'GRANT_RESOURCE_MISMATCH'],
    ['a grant whose scope does not include its correlation resource', async () => requestFor(await signedGrant({ scope: { resources: { kind: 'set', values: ['staging-cluster'] } } })), 'GRANT_RESOURCE_MISMATCH'],
    ['an execution not derived from the grant', async () => requestFor(await signedGrant(), { executionId: 'aoc.exec:0123456789abcdef0123456789abcdef' }), 'EXECUTION_DERIVATION_MISMATCH'],
    ['an expired grant', async () => requestFor(await signedGrant({ issuedAt: NOW - 120_000, expiresAt: NOW - 1 }), {}, { now: NOW - 30_001 }), 'GRANT_EXPIRED'],
    ['a capability outliving its grant', async () => requestFor(await signedGrant({ expiresAt: NOW + 10_000 })), 'CAPABILITY_TIME_INVALID'],
    ['a capability starting before its grant', async () => requestFor(await signedGrant({ issuedAt: NOW + 1_000 })), 'CAPABILITY_TIME_INVALID'],
    ['a lifetime above the configured one', async () => requestFor(await signedGrant(), {}, { lifetimeMs: 30_001 }), 'CAPABILITY_TIME_INVALID'],
    ['no lifetime at all', async () => requestFor(await signedGrant(), { expiresAt: iso(NOW) }), 'CAPABILITY_TIME_INVALID'],
    ['an issuance instant far from the custody clock', async () => requestFor(await signedGrant(), {}, { now: NOW - 5_001 }), 'CAPABILITY_TIME_INVALID'],
  ];
  for (const [name, build, failure] of refusals) {
    it(`refuses: ${name} → ${failure}`, async () => {
      assert.deepEqual(assessExecutionCapabilityIssuance(await build(), rule()), { issuable: false, failure });
    });
  }

  it('a grant expired by the custody clock is refused even when the capability is otherwise in bounds', async () => {
    const signed = await signedGrant({ expiresAt: NOW + 20_000 });
    assert.deepEqual(assessExecutionCapabilityIssuance(requestFor(signed, {}, { lifetimeMs: 10_000 }), rule(NOW + 20_000)), { issuable: false, failure: 'GRANT_EXPIRED' });
  });

  it('the lifetime limit is the policy’s, never above 60 s', async () => {
    const short = createExecutionCapabilityIssuancePolicy(policyInput({ lifetimeMs: 5_000 }));
    assert.deepEqual(assessExecutionCapabilityIssuance(requestFor(await signedGrant(), {}, { lifetimeMs: 5_001 }), rule(NOW, short)), { issuable: false, failure: 'CAPABILITY_TIME_INVALID' });
    assert.equal(assessExecutionCapabilityIssuance(requestFor(await signedGrant(), {}, { lifetimeMs: 5_000 }), rule(NOW, short)).issuable, true);
    assert.throws(() => createExecutionCapabilityIssuancePolicy(policyInput({ lifetimeMs: 60_001 })), /1 to 60000/);
  });
});

describe('G-02B custody policy — closed, exact, no wildcard, no default', () => {
  const invalid: readonly [string, Record<string, unknown>][] = [
    ['an extra key', { ...policyInput(), extra: true }],
    ['a missing issuer', Object.fromEntries(Object.entries(policyInput()).filter(([key]) => key !== 'issuer'))],
    ['a wildcard issuer', policyInput({ issuer: '*' })],
    ['a wildcard audience', policyInput({ audiences: [{ audience: '*', actions: [G02B_ACTION], bindingFormats: [G02B_BINDING_FORMAT] }] })],
    ['an audience pattern', policyInput({ audiences: [{ audience: 'executor-*', actions: [G02B_ACTION], bindingFormats: [G02B_BINDING_FORMAT] }] })],
    ['a wildcard action', policyInput({ audiences: [{ audience: G02B_AUDIENCE, actions: ['*'], bindingFormats: [G02B_BINDING_FORMAT] }] })],
    ['a wildcard binding format', policyInput({ audiences: [{ audience: G02B_AUDIENCE, actions: [G02B_ACTION], bindingFormats: ['*'] }] })],
    ['no audience', policyInput({ audiences: [] })],
    ['no action', policyInput({ audiences: [{ audience: G02B_AUDIENCE, actions: [], bindingFormats: [G02B_BINDING_FORMAT] }] })],
    ['a duplicated audience', policyInput({ audiences: [{ audience: G02B_AUDIENCE, actions: [G02B_ACTION], bindingFormats: [G02B_BINDING_FORMAT] }, { audience: G02B_AUDIENCE, actions: [G02B_ACTION], bindingFormats: [G02B_BINDING_FORMAT] }] })],
    ['a duplicated action', policyInput({ audiences: [{ audience: G02B_AUDIENCE, actions: [G02B_ACTION, G02B_ACTION], bindingFormats: [G02B_BINDING_FORMAT] }] })],
    ['an audience entry with an extra key', policyInput({ audiences: [{ audience: G02B_AUDIENCE, actions: [G02B_ACTION], bindingFormats: [G02B_BINDING_FORMAT], wildcard: true }] })],
    ['a lifetime of zero', policyInput({ lifetimeMs: 0 })],
    ['a fractional lifetime', policyInput({ lifetimeMs: 1.5 })],
    ['a padded organization', policyInput({ organizationId: ` ${G02B_ORGANIZATION}` })],
  ];
  for (const [name, input] of invalid) {
    it(`refuses ${name}`, () => {
      assert.throws(() => createExecutionCapabilityIssuancePolicy(input));
      assert.throws(() => custodySigner(AUTHORITY_KEY_A, input), /invalid execution capability issuance policy/);
    });
  }

  it('a valid policy is a frozen copy: mutating the input afterwards changes nothing the boundary enforces', () => {
    const input = policyInput();
    const policy = createExecutionCapabilityIssuancePolicy(input);
    assert.ok(Object.isFrozen(policy) && Object.isFrozen(policy.audiences) && Object.isFrozen(policy.audiences[0]) && Object.isFrozen(policy.audiences[0]?.actions));
    (input['audiences'] as { actions: string[] }[])[0]?.actions.push('export-records');
    assert.deepEqual([...(policy.audiences[0]?.actions ?? [])], [G02B_ACTION]);
  });
});

describe('G-02B software custody — signs only what its own rule accepts, only over G-02A’s bytes', () => {
  it('signs an issuable capability; the signature is over executionCapabilitySigningBytes and verifies in the standalone executor verifier', async () => {
    const signer = custodySigner();
    const request = requestFor(await signedGrant());
    const signature = await signer.signExecutionCapability!(request);
    const verifier = testVerifier([AUTHORITY_KEY_A]);
    assert.equal(verifier.verifyExecutionCapability(request.capability, signature).verified, true);
    assert.deepEqual(signature, signCapabilityBytes(request.capability, AUTHORITY_KEY_A), 'Ed25519 is deterministic: the custody signature is exactly the signature over the G-02A signing bytes');
    assert.ok(executionCapabilitySigningBytes(request.capability).toString('utf8').startsWith(EXECUTION_CAPABILITY_SIGNING_DOMAIN));
    const executor = createExecutionCapabilityVerifier({
      trustedIssuers: [{ issuer: G02B_ISSUER, keys: [trustedKeyOf(AUTHORITY_KEY_A)] }],
      executor: { audience: G02B_AUDIENCE, organizationIds: [G02B_ORGANIZATION], trustDomain: G02B_TRUST_DOMAIN },
      clock: () => NOW + 1_000,
    });
    const result = executor.verify({
      presentation: { capability: serializeExecutionCapability(request.capability), signature },
      action: G02B_ACTION,
      resource: G02B_RESOURCE,
      actionBinding: { format: G02B_BINDING_FORMAT, value: { method: 'PATCH', path: '/deployments/production-cluster-eu', body: { replicas: 4 } } },
    });
    assert.equal(result.verification, 'verified');
  });

  it('refuses everything its rule refuses, with EXTERNAL_SIGNER_REFUSED — no free capability oracle', async () => {
    const signer = custodySigner();
    for (const request of [requestFor(await signedGrant({ key: AUTHORITY_KEY_B })), requestFor(await signedGrant(), { audience: 'executor-unknown' }), requestFor(await signedGrant(), { issuer: 'frontera-deployment-other' })]) {
      await assert.rejects(signer.signExecutionCapability!(request), (error: { reason?: string }) => error.reason === 'EXTERNAL_SIGNER_REFUSED');
    }
  });

  it('enforces its own policy, not the Host’s: a boundary configured without an audience refuses it whatever the Host’s policy says', async () => {
    const narrow = custodySigner(AUTHORITY_KEY_A, policyInput({ audiences: [{ audience: G02B_OTHER_AUDIENCE, actions: [G02B_ACTION], bindingFormats: [G02B_BINDING_FORMAT] }] }));
    await assert.rejects(narrow.signExecutionCapability!(requestFor(await signedGrant())), (error: { reason?: string; message?: string }) => error.reason === 'EXTERNAL_SIGNER_REFUSED' && /AUDIENCE_NOT_REGISTERED/.test(error.message ?? ''));
  });

  it('a signer configured without a policy offers no execution-capability operation at all', () => {
    assert.equal(testSigner(AUTHORITY_KEY_A).signExecutionCapability, undefined);
  });

  it('key rotation: a boundary whose active key is B issues nothing for a grant key A signed; G-02A overlap still verifies A-signed capabilities', async () => {
    const rotated = custodySigner(AUTHORITY_KEY_B);
    const signed = await signedGrant({ key: AUTHORITY_KEY_A });
    await assert.rejects(rotated.signExecutionCapability!(requestFor(signed, {}, { key: AUTHORITY_KEY_B })), (error: { message?: string }) => /GRANT_SIGNATURE_INVALID/.test(error.message ?? ''));
    // A capability A already issued keeps verifying where the executor pins both keys for the issuer.
    const request = requestFor(signed);
    const signature = await custodySigner(AUTHORITY_KEY_A).signExecutionCapability!(request);
    const overlap = createExecutionCapabilityVerifier({
      trustedIssuers: [{ issuer: G02B_ISSUER, keys: [trustedKeyOf(AUTHORITY_KEY_A), trustedKeyOf(AUTHORITY_KEY_B)] }],
      executor: { audience: G02B_AUDIENCE, organizationIds: [G02B_ORGANIZATION], trustDomain: G02B_TRUST_DOMAIN },
      clock: () => NOW,
    });
    const verdict = overlap.verify({ presentation: { capability: serializeExecutionCapability(request.capability), signature }, action: G02B_ACTION, resource: G02B_RESOURCE, actionBinding: { format: G02B_BINDING_FORMAT, value: { method: 'PATCH', path: '/deployments/production-cluster-eu', body: { replicas: 4 } } } });
    assert.equal(verdict.verification, 'verified');
  });
});

describe('G-02B signatures and domains — no substitution in either direction', () => {
  it('a capability signature is not a grant, S1 or state signature, nor the reverse; the G-02A domain and codec are unchanged', async () => {
    const signed = await signedGrant();
    const request = requestFor(signed);
    const signature = await custodySigner().signExecutionCapability!(request);
    const verifier = testVerifier([AUTHORITY_KEY_A]);
    assert.equal(verifier.verifyGrant(signed.grant, signed.storeId, signature).verified, false);
    assert.equal(verifier.verifyExecutionCapability(request.capability, signed.signature).verified, false, 'a grant signature is not a capability signature');
    assert.equal(AUTHORITY_SIGNING_DOMAINS.executionCapability, 'frontera:authority-artifact:execution-capability:v1\n');
    assert.equal(EXECUTION_CAPABILITY_GRANT_REFERENCE_DOMAIN, 'frontera.execution-capability.grant-reference.v1');
    assert.equal(verifier.verifyExecutionCapability({ ...request.capability, extra: 1 } as never, signature).verified, false, 'malformed before any key');
    for (const field of Object.keys(request.capability)) {
      if (field === 'format' || field === 'consumption') continue;
      const changed = { ...request.capability, [field]: field === 'actionBinding' ? { format: G02B_BINDING_FORMAT, digest: `sha256:${'1'.repeat(64)}` } : field === 'onBehalfOfActorId' ? 'actor-x' : field === 'statusRequirement' ? 'online-status-required' : field.endsWith('At') ? iso(NOW + 1) : field === 'capabilityId' ? 'cd'.repeat(32) : field === 'grantReference' ? `sha256:${'2'.repeat(64)}` : `${String((request.capability as unknown as Record<string, unknown>)[field])}-x` };
      assert.equal(verifier.verifyExecutionCapability(changed as never, signature).verified, false, field);
    }
  });

  it('the v2 grant reference is its own domain, differs per nonce and never equals G-02A’s per-grant value', async () => {
    const signed = await signedGrant();
    const identity = { grantStoreId: signed.storeId, boundedGrantId: signed.grant.id, grantDigest: signed.grant.digest };
    const one = executionCapabilityGrantReferenceV2({ ...identity, nonce: '01'.repeat(32) });
    const two = executionCapabilityGrantReferenceV2({ ...identity, nonce: '02'.repeat(32) });
    assert.notEqual(one, two);
    assert.notEqual(one, executionCapabilityGrantReference(identity));
    assert.match(one, /^sha256:[0-9a-f]{64}$/);
    assert.throws(() => executionCapabilityGrantReferenceV2({ ...identity, nonce: 'AB'.repeat(32) }));
  });
});

describe('G-02B external custody — the structured extension, exact and opt-in', () => {
  const credential = 'g02b-reference-authority-credential-0123456789abcdef';
  const pinned = { keyId: AUTHORITY_KEY_A.keyId, algorithm: 'ed25519-v1' as const, publicKeyPem: trustedKeyOf(AUTHORITY_KEY_A).publicKeyPem };

  it('the wire form is canonical and strict: a re-spaced capability, an extra key, a bad nonce or a missing grant signature is not a request', async () => {
    const request = requestFor(await signedGrant());
    const body = externalSigningRequestBody({ operation: 'signExecutionCapability', ...request });
    const parse = (value: unknown) => parseExternalSigningRequest('signExecutionCapability', value, parseStoredGrant);
    assert.equal(parse(body)?.operation, 'signExecutionCapability');
    assert.equal(parse({ ...body, capability: ` ${String(body['capability'])}` }), undefined);
    assert.equal(parse({ ...body, extra: 1 }), undefined);
    assert.equal(parse({ ...body, grantReferenceNonce: 'zz' }), undefined);
    assert.equal(parse({ ...body, grantSignature: undefined }), undefined);
    assert.equal(Object.keys(body).includes('bytes') || Object.keys(body).includes('payload'), false, 'no free-form bytes travel');
  });

  it('a deployment requiring it establishes against a service offering it; the service applies its own policy and its own key', async () => {
    const service = await startReferenceAuthoritySigner({ keyId: AUTHORITY_KEY_A.keyId, privateKeyPem: AUTHORITY_KEY_A.privateKeyPem, credential, extensions: ['signExecutionCapability'], executionCapabilityIssuance: policyInput(), now: () => NOW });
    try {
      const transport = createHttpExternalAuthoritySignerTransport({ endpoint: `http://127.0.0.1:${service.port}`, credential });
      const verifier = testVerifier([AUTHORITY_KEY_A]);
      const { signer, monitor } = await establishExternalAuthorityArtifactSigner({ transport, pinned, verifier, timeoutMs: 2_000, maxAttempts: 3, extensions: ['signExecutionCapability'] });
      const request = requestFor(await signedGrant());
      const signature = await signer.signExecutionCapability!(request);
      assert.equal(verifier.verifyExecutionCapability(request.capability, signature).verified, true);
      assert.equal(monitor.status().extensionOperations?.signExecutionCapability?.succeeded, 1);
      // Refused inside the service: an unregistered audience, a grant another key signed. 422 → REFUSED, not retried.
      for (const refused of [requestFor(await signedGrant(), { audience: 'executor-unknown' }), requestFor(await signedGrant({ key: AUTHORITY_KEY_B }))]) {
        await assert.rejects(signer.signExecutionCapability!(refused), (error: { reason?: string }) => error.reason === 'EXTERNAL_SIGNER_REFUSED');
      }
      assert.equal(monitor.status().extensionOperations?.signExecutionCapability?.retried, 0);
      // A deployment that did not ask for it refuses the six-operation service.
      await assert.rejects(establishExternalAuthorityArtifactSigner({ transport, pinned, verifier, timeoutMs: 2_000, maxAttempts: 1 }), (error: { reason?: string }) => error.reason === 'EXTERNAL_SIGNER_CAPABILITY_UNSUPPORTED');
      assert.equal(EXTERNAL_AUTHORITY_SIGNER_EXTENSION_PATHS.signExecutionCapability, '/v1/sign/execution-capability');
    } finally {
      await service.close();
    }
  });

  it('an execution-capability request is sent once: an availability failure is not retried, though every other operation still is', async () => {
    let attempts = 0;
    const transport = {
      identity: async () => ({ protocol: 'frontera.external-authority-signer.v1', keyId: AUTHORITY_KEY_A.keyId, algorithm: 'ed25519-v1', publicKeyPem: AUTHORITY_KEY_A.publicKeyPem, artifactVersion: 'aoc.authority-artifact.v1', operations: [...EXTERNAL_AUTHORITY_SIGNER_OPERATIONS, 'signExecutionCapability'] }),
      sign: async () => {
        attempts += 1;
        throw new ExternalAuthoritySignerTransportError('EXTERNAL_SIGNER_TIMEOUT', 'timed out');
      },
    };
    const { signer } = await establishExternalAuthorityArtifactSigner({ transport, pinned, verifier: testVerifier([AUTHORITY_KEY_A]), timeoutMs: 1_000, maxAttempts: 3, extensions: ['signExecutionCapability'] });
    await assert.rejects(signer.signExecutionCapability!(requestFor(await signedGrant())), (error: { reason?: string }) => error.reason === 'EXTERNAL_SIGNER_TIMEOUT');
    assert.equal(attempts, 1, 'one attempt for a capability');
    attempts = 0;
    await assert.rejects(signer.signGrant((await signedGrant()).grant, G02B_STORE));
    assert.equal(attempts, 3, 'the core operations keep their bounded retry');
  });

  it('a service offering the extension without its own policy (or a policy without the extension) refuses to start', async () => {
    await Promise.all([
      assert.rejects(startReferenceAuthoritySigner({ keyId: AUTHORITY_KEY_A.keyId, privateKeyPem: AUTHORITY_KEY_A.privateKeyPem, credential, extensions: ['signExecutionCapability'] }), /exactly when/),
      assert.rejects(startReferenceAuthoritySigner({ keyId: AUTHORITY_KEY_A.keyId, privateKeyPem: AUTHORITY_KEY_A.privateKeyPem, credential, executionCapabilityIssuance: policyInput() }), /exactly when/),
    ]);
  });

  it('backward compatibility: a deployment requiring nothing still requires exactly the five core operations, and S1 alone is unchanged', async () => {
    const service = await startReferenceAuthoritySigner({ keyId: AUTHORITY_KEY_A.keyId, privateKeyPem: AUTHORITY_KEY_A.privateKeyPem, credential, extensions: ['signDelegatedOfferCapability'] });
    try {
      const transport = createHttpExternalAuthoritySignerTransport({ endpoint: `http://127.0.0.1:${service.port}`, credential });
      const { signer } = await establishExternalAuthorityArtifactSigner({ transport, pinned, verifier: testVerifier([AUTHORITY_KEY_A]), timeoutMs: 2_000, maxAttempts: 1, extensions: ['signDelegatedOfferCapability'] });
      assert.equal(typeof signer.signDelegatedOfferCapability, 'function');
      assert.equal(signer.signExecutionCapability, undefined);
      await assert.rejects(establishExternalAuthorityArtifactSigner({ transport, pinned, verifier: testVerifier([AUTHORITY_KEY_A]), timeoutMs: 2_000, maxAttempts: 1, extensions: ['signExecutionCapability'] }), (error: { reason?: string }) => error.reason === 'EXTERNAL_SIGNER_CAPABILITY_UNSUPPORTED');
      assert.deepEqual([...EXTERNAL_AUTHORITY_SIGNER_OPERATIONS], ['signGrant', 'signRevocation', 'signRevocationState', 'signObligationDischargeState', 'signApprovalState']);
    } finally {
      await service.close();
    }
  });
});

describe('G-02B external custody — the shipped reference launcher as its own process', () => {
  const keys = signerKeyDirectory();
  const work = mkdtempSync(join(tmpdir(), 'aoc-g02b-launcher-'));
  after(() => {
    keys.cleanup();
    rmSync(work, { recursive: true, force: true });
  });

  it('a separate custody process signs only under its own policy file and key; the Host never holds the key', async () => {
    const policyFile = join(work, 'policy.json');
    writeFileSync(policyFile, JSON.stringify(policyInput()));
    const keyId = 'frontera-g02b-external-key-1';
    const spawned = await spawnReferenceSigner({ keyFile: join(keys.dir, 'g02b-key.pem'), keyId, credential: LAUNCHER_TOKEN, env: { FRONTERA_REFERENCE_SIGNER_EXTENSIONS: 'signExecutionCapability', FRONTERA_REFERENCE_SIGNER_EXECUTION_CAPABILITY_POLICY_FILE: policyFile } });
    try {
      const trusted = { keyId, algorithm: 'ed25519-v1' as const, publicKeyPem: spawned.publicKeyPem };
      const verifier = createAuthorityArtifactVerifier([trusted]);
      const { signer } = await establishExternalAuthorityArtifactSigner({ transport: createHttpExternalAuthoritySignerTransport({ endpoint: spawned.endpoint, credential: LAUNCHER_TOKEN }), pinned: trusted, verifier, timeoutMs: 5_000, maxAttempts: 1, extensions: ['signExecutionCapability'] });
      // The grant is signed by the custody process too (signGrant crosses the boundary): its key is the only key that can authorize.
      const now = Date.now();
      const grant = grantFor({ issuedAt: now - 60_000, expiresAt: now + 3_600_000 });
      const grantSignature = await signer.signGrant(grant, G02B_STORE);
      const signed = { grant, storeId: G02B_STORE, signature: grantSignature };
      const request = requestFor(signed, {}, { key: { ...AUTHORITY_KEY_A, keyId }, now });
      const signature = await signer.signExecutionCapability!(request);
      assert.equal(verifier.verifyExecutionCapability(request.capability, signature).verified, true);
      await assert.rejects(signer.signExecutionCapability!(requestFor(signed, { audience: 'executor-unknown' }, { key: { ...AUTHORITY_KEY_A, keyId }, now })), (error: { reason?: string }) => error.reason === 'EXTERNAL_SIGNER_REFUSED');
      // A grant this process's key never signed is refused, whoever else signed it.
      await assert.rejects(signer.signExecutionCapability!(requestFor(await signedGrant({ key: AUTHORITY_KEY_A, issuedAt: now - 60_000, expiresAt: now + 3_600_000 }), {}, { key: { ...AUTHORITY_KEY_A, keyId }, now })), (error: { reason?: string }) => error.reason === 'EXTERNAL_SIGNER_REFUSED');
    } finally {
      await spawned.kill();
    }
  });
});
