import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { boundedGrantDigest, type BoundedGrant, type GrantRevocation } from '../../features/grant-runtime/index.js';
import type { ApprovalStateCommitment } from '../approval-authority/state-commitment.js';
import { AuthorityAuthenticityConfigurationError, AuthoritySigningUnavailableError, type AuthoritySigningFailureReason } from '../authority-authenticity/errors.js';
import type { RevocationStateCommitment } from '../bounded-grant-store/bounded-grant-record.js';
import {
  EXTERNAL_AUTHORITY_SIGNER_OPERATIONS,
  EXTERNAL_AUTHORITY_SIGNER_PATHS,
  createHttpExternalAuthoritySignerTransport,
  isExternalAuthorityArtifactSigner,
  type ExternalAuthoritySigningRequest,
} from '../external-authority-signer/index.js';
import type { ObligationDischargeStateCommitment } from '../obligation-discharge/state-commitment.js';
import { authoritySignerCustody } from '../authority-authenticity/custody.js';
import { AUTHORITY_KEY_A, AUTHORITY_KEY_B, AUTHORITY_KEY_UNTRUSTED, testSigner, testVerifier } from './authority-authenticity-fixture.js';
import { ScriptedTransport, SIGNER_TOKEN, establish, establishScripted, genuineSignature, identityOf, signWith, startInProcessSigner, unavailable } from './core02-external-signer-fixture.js';

/**
 * CORE-02 — the external signer contract: what crosses the custody boundary,
 * and what is refused on the way back.
 *
 * The reference custody service here runs in this process over real loopback
 * HTTP; it proves the protocol and the adapter, not key residency (that is
 * `external-authority-signer-host.test.ts`, with the signer in its own process).
 */

const DIGEST = (c: string) => `sha256:${c.repeat(64)}`;

function grant(id = 'aoc.grant:core02-a', subject = 'actor-a'): BoundedGrant {
  const withoutDigest = {
    id,
    correlation: { requestId: 'req-1', decisionId: 'dec-1', action: 'payment.send', resourceScope: 'record:contract' },
    subject,
    scope: { action: { kind: 'identity', value: 'payment.send' }, amount: { kind: 'ceiling', limit: '100', unit: 'USD' }, resources: { kind: 'set', values: ['record:contract'] } },
    issuedAt: '2026-01-01T12:00:00.000Z',
    expiresAt: '2026-01-01T12:10:00.000Z',
    sourceDigest: DIGEST('a'),
  } as Omit<BoundedGrant, 'digest'>;
  return { ...withoutDigest, digest: boundedGrantDigest(withoutDigest) };
}

const REVOCATION: GrantRevocation = { grantId: 'aoc.grant:core02-a', revokedAt: '2026-01-01T12:05:00.000Z', reason: 'security-incident', issuerRef: 'operator-a' };
const REVOCATION_STATE: RevocationStateCommitment = { storeId: 'store-1', sequence: 3, revocationSetDigest: DIGEST('b') };
const DISCHARGE_STATE: ObligationDischargeStateCommitment = { storeId: 'obligation-discharge-store:1', organizationId: 'org-a', sequence: 2, chainDigest: DIGEST('c') };
const APPROVAL_STATE: ApprovalStateCommitment = { storeId: 'approval-store:1', organizationId: 'org-a', sequence: 5, chainDigest: DIGEST('d') };

const FIVE: readonly ExternalAuthoritySigningRequest[] = [
  { operation: 'signGrant', grant: grant(), storeId: 'store-1' },
  { operation: 'signRevocation', revocation: REVOCATION, storeId: 'store-1' },
  { operation: 'signRevocationState', state: REVOCATION_STATE },
  { operation: 'signObligationDischargeState', state: DISCHARGE_STATE },
  { operation: 'signApprovalState', state: APPROVAL_STATE },
];

const cleanups: (() => Promise<void>)[] = [];
after(async () => {
  for (const cleanup of cleanups) await cleanup();
});

async function inProcessSigner(key = AUTHORITY_KEY_A) {
  const signer = await startInProcessSigner(key);
  cleanups.push(() => signer.close());
  return signer;
}

function reasonOf(error: unknown): AuthoritySigningFailureReason | undefined {
  return error instanceof AuthoritySigningUnavailableError || error instanceof AuthorityAuthenticityConfigurationError ? error.reason : undefined;
}

const refusedWith = (reason: AuthoritySigningFailureReason) => (error: unknown) => {
  assert.equal(reasonOf(error), reason, error instanceof Error ? error.message : String(error));
  return true;
};

function verifyLocally(request: ExternalAuthoritySigningRequest, signature: unknown) {
  const verifier = testVerifier([AUTHORITY_KEY_A]);
  switch (request.operation) {
    case 'signGrant':
      return verifier.verifyGrant(request.grant, request.storeId, signature);
    case 'signRevocation':
      return verifier.verifyRevocation(request.revocation, request.storeId, signature);
    case 'signRevocationState':
      return verifier.verifyRevocationState(request.state, signature);
    case 'signObligationDischargeState':
      return verifier.verifyObligationDischargeState(request.state, signature);
    case 'signApprovalState':
      return verifier.verifyApprovalState(request.state, signature);
  }
}

describe('CORE-02 — the five structured operations cross the custody boundary, byte-compatible with the software signer', () => {
  it('external and software signers produce the SAME AuthoritySignature for all five artifacts under the same key (custody changes, format does not)', async () => {
    const service = await inProcessSigner();
    const { signer } = await establish(service.endpoint, { pin: AUTHORITY_KEY_A });
    for (const request of FIVE) {
      const external = await signWith(signer, request);
      const software = await signWith(testSigner(AUTHORITY_KEY_A), request);
      assert.deepEqual(external, software, `${request.operation}: deterministic Ed25519 over identical canonical bytes`);
      const verification = verifyLocally(request, external);
      assert.equal(verification.verified, true, `${request.operation} verifies locally`);
    }
    assert.deepEqual(await service.counts(), Object.fromEntries(EXTERNAL_AUTHORITY_SIGNER_OPERATIONS.map((operation) => [operation, 1])), 'every operation crossed the boundary exactly once');
  });

  it('the external signer keeps the domain-aware interface: exactly the five operations and the pinned identity, no generic byte signing, no key member', async () => {
    const service = await inProcessSigner();
    const { signer, monitor } = await establish(service.endpoint, { pin: AUTHORITY_KEY_A });
    assert.deepEqual(Object.keys(signer).sort(), ['activeKeyId', 'algorithm', 'signApprovalState', 'signGrant', 'signObligationDischargeState', 'signRevocation', 'signRevocationState']);
    assert.equal(signer.activeKeyId, AUTHORITY_KEY_A.keyId);
    assert.ok(Object.isFrozen(signer));
    assert.equal(isExternalAuthorityArtifactSigner(signer), true);
    assert.equal(authoritySignerCustody(signer), 'external');
    assert.equal(authoritySignerCustody(testSigner()), 'software');
    assert.equal(isExternalAuthorityArtifactSigner(testSigner()), false);
    assert.equal(JSON.stringify(monitor.status()).includes(SIGNER_TOKEN), false);
  });

  it('the reference service offers no generic signing route and no key export: /sign, raw bytes and key routes are 404, unauthenticated calls 401, malformed artifacts 422', async () => {
    const service = await inProcessSigner();
    const call = (method: string, path: string, body?: unknown, authorization: string | null = `Bearer ${SIGNER_TOKEN}`) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = httpRequest(new URL(path, service.endpoint), { method, agent: false, headers: { ...(authorization !== null ? { authorization } : {}), 'content-type': 'application/json' } }, (res) => {
          let text = '';
          res.on('data', (chunk: Buffer) => (text += chunk.toString()));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }));
        });
        req.on('error', reject);
        req.end(body === undefined ? undefined : JSON.stringify(body));
      });
    for (const path of ['/sign', '/v1/sign', '/v1/sign/bytes', '/v1/sign/raw', '/v1/sign/digest', '/v1/keys', '/v1/key/private', '/v1/export', '/v1/backup']) {
      assert.equal((await call('POST', path, { bytes: 'AAAA' })).status, 404, path);
      assert.equal((await call('GET', path)).status, 404, path);
    }
    assert.equal((await call('GET', EXTERNAL_AUTHORITY_SIGNER_PATHS.identity, undefined, null)).status, 401);
    assert.equal((await call('GET', EXTERNAL_AUTHORITY_SIGNER_PATHS.identity, undefined, 'Bearer wrong')).status, 401);
    const identity = await call('GET', EXTERNAL_AUTHORITY_SIGNER_PATHS.identity);
    assert.equal(identity.status, 200);
    assert.equal(/PRIVATE KEY/.test(identity.body), false, 'identity carries public material only');
    // A grant that does not round-trip its canonical bytes, or whose digest does not match, is not signed.
    const tampered = { ...grant(), subject: 'actor-z' };
    for (const body of [
      { protocol: 'frontera.external-authority-signer.v1', grant: JSON.stringify(tampered), storeId: 's' },
      { protocol: 'frontera.external-authority-signer.v1', grant: '{"not":"a grant"}', storeId: 's' },
      { protocol: 'frontera.external-authority-signer.v1', bytes: 'AAAA' },
      { protocol: 'other', state: REVOCATION_STATE },
    ]) {
      assert.equal((await call('POST', EXTERNAL_AUTHORITY_SIGNER_PATHS.signGrant, body)).status, 422);
    }
    assert.equal((await call('POST', EXTERNAL_AUTHORITY_SIGNER_PATHS.signRevocation, { protocol: 'frontera.external-authority-signer.v1', revocation: { ...REVOCATION, reason: 'because' }, storeId: 's' })).status, 422);
    assert.equal((await call('POST', EXTERNAL_AUTHORITY_SIGNER_PATHS.signRevocationState, { protocol: 'frontera.external-authority-signer.v1', state: { ...REVOCATION_STATE, extra: 1 } })).status, 422);
    assert.deepEqual(Object.values(await service.counts()), [0, 0, 0, 0, 0], 'nothing refused was signed');
  });
});

describe('CORE-02 — key identity handshake: configured trust pins remote identity; remote identity never establishes trust', () => {
  it('startup refuses a signer answering as another key, under another algorithm, or with other public material under the same key id', async () => {
    // Endpoint substitution: expected key A, endpoint serves key B.
    const serviceB = await inProcessSigner(AUTHORITY_KEY_B);
    await assert.rejects(() => establish(serviceB.endpoint, { pin: AUTHORITY_KEY_A, trust: [AUTHORITY_KEY_A, AUTHORITY_KEY_B] }), refusedWith('EXTERNAL_SIGNER_IDENTITY_MISMATCH'));
    // Same key id string, different public material.
    const impostor = new ScriptedTransport(AUTHORITY_KEY_UNTRUSTED);
    impostor.identityAnswer = () => identityOf(AUTHORITY_KEY_A, { publicKeyPem: AUTHORITY_KEY_UNTRUSTED.publicKeyPem });
    await assert.rejects(() => establishScripted(impostor, { pin: AUTHORITY_KEY_A }), refusedWith('EXTERNAL_SIGNER_IDENTITY_MISMATCH'));
    // Verification-registry substitution: the signer serves A, the trusted registry holds B under A's id.
    const serviceA = await inProcessSigner(AUTHORITY_KEY_A);
    const substituted = { ...AUTHORITY_KEY_B, keyId: AUTHORITY_KEY_A.keyId };
    await assert.rejects(() => establish(serviceA.endpoint, { pin: substituted, trust: [substituted] }), refusedWith('EXTERNAL_SIGNER_IDENTITY_MISMATCH'));
    assert.equal(serviceA.endpoint.length > 0, true);
  });

  it('a malformed or incomplete capability answer refuses startup — no first algorithm, no partial operation set, no unknown operation', async () => {
    const cases: readonly [string, Record<string, unknown> | unknown, AuthoritySigningFailureReason][] = [
      ['missing keyId', (() => { const { keyId: _k, ...rest } = identityOf(AUTHORITY_KEY_A); void _k; return rest; })(), 'EXTERNAL_SIGNER_MALFORMED_RESPONSE'],
      ['empty keyId', identityOf(AUTHORITY_KEY_A, { keyId: '' }), 'EXTERNAL_SIGNER_MALFORMED_RESPONSE'],
      ['unsupported algorithm', identityOf(AUTHORITY_KEY_A, { algorithm: 'ecdsa-p256-v1' }), 'EXTERNAL_SIGNER_CAPABILITY_UNSUPPORTED'],
      ['missing public key', (() => { const { publicKeyPem: _p, ...rest } = identityOf(AUTHORITY_KEY_A); void _p; return rest; })(), 'EXTERNAL_SIGNER_MALFORMED_RESPONSE'],
      ['malformed public key', identityOf(AUTHORITY_KEY_A, { publicKeyPem: '-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----\n' }), 'EXTERNAL_SIGNER_MALFORMED_RESPONSE'],
      ['a private key advertised as the public key', identityOf(AUTHORITY_KEY_A, { publicKeyPem: AUTHORITY_KEY_A.privateKeyPem }), 'EXTERNAL_SIGNER_MALFORMED_RESPONSE'],
      ['one operation missing', identityOf(AUTHORITY_KEY_A, { operations: EXTERNAL_AUTHORITY_SIGNER_OPERATIONS.slice(0, 4) }), 'EXTERNAL_SIGNER_CAPABILITY_UNSUPPORTED'],
      ['an unknown operation', identityOf(AUTHORITY_KEY_A, { operations: [...EXTERNAL_AUTHORITY_SIGNER_OPERATIONS, 'sign'] }), 'EXTERNAL_SIGNER_CAPABILITY_UNSUPPORTED'],
      ['a duplicated operation', identityOf(AUTHORITY_KEY_A, { operations: [...EXTERNAL_AUTHORITY_SIGNER_OPERATIONS, 'signGrant'] }), 'EXTERNAL_SIGNER_MALFORMED_RESPONSE'],
      ['conflicting algorithm declarations', identityOf(AUTHORITY_KEY_A, { algorithms: ['ed25519-v1', 'ecdsa-p256-v1'] }), 'EXTERNAL_SIGNER_MALFORMED_RESPONSE'],
      ['another protocol', identityOf(AUTHORITY_KEY_A, { protocol: 'frontera.external-authority-signer.v2' }), 'EXTERNAL_SIGNER_CAPABILITY_UNSUPPORTED'],
      ['another artifact version', identityOf(AUTHORITY_KEY_A, { artifactVersion: 'aoc.authority-artifact.v2' }), 'EXTERNAL_SIGNER_CAPABILITY_UNSUPPORTED'],
      ['not an object', ['ed25519-v1'], 'EXTERNAL_SIGNER_MALFORMED_RESPONSE'],
    ];
    for (const [label, answer, reason] of cases) {
      const transport = new ScriptedTransport(AUTHORITY_KEY_A);
      transport.identityAnswer = () => answer;
      await assert.rejects(() => establishScripted(transport, { pin: AUTHORITY_KEY_A }), refusedWith(reason), label);
      assert.equal(transport.signCalls.length, 0, `${label}: nothing is signed before the identity is proven`);
    }
  });

  it('no TOFU: the advertised public key is only compared — a signer whose key is not already trusted cannot become trusted, and the registry never grows', async () => {
    const service = await inProcessSigner(AUTHORITY_KEY_UNTRUSTED);
    const verifier = testVerifier([AUTHORITY_KEY_A]);
    const before = [...verifier.trustedKeyIds];
    await assert.rejects(() => establish(service.endpoint, { pin: AUTHORITY_KEY_UNTRUSTED, trust: [AUTHORITY_KEY_A] }), (error: unknown) => error instanceof AuthorityAuthenticityConfigurationError && /not in the trusted verification registry/.test(error.message));
    assert.deepEqual([...verifier.trustedKeyIds], before);
    assert.equal(Object.isFrozen(verifier.trustedKeyIds), true);
  });

  it('an unreachable signer, a refused credential and a hanging signer each refuse startup with a distinct, secret-free reason', async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    await assert.rejects(() => establish(`http://127.0.0.1:${port}`, { pin: AUTHORITY_KEY_A }), refusedWith('EXTERNAL_SIGNER_UNREACHABLE'));

    const service = await inProcessSigner();
    const wrong = 'WRONG_CREDENTIAL_SENTINEL_0123456789abcdef0123';
    await assert.rejects(
      () => establish(service.endpoint, { pin: AUTHORITY_KEY_A, credential: wrong }),
      (error: unknown) => {
        assert.equal(reasonOf(error), 'EXTERNAL_SIGNER_AUTHENTICATION_FAILED');
        const text = `${String((error as Error).message)} ${JSON.stringify(error)}`;
        assert.equal(text.includes(wrong), false, 'the credential is never echoed');
        return true;
      },
    );

    const hanging = await hangingServer();
    const started = Date.now();
    await assert.rejects(() => establish(hanging.endpoint, { pin: AUTHORITY_KEY_A, timeoutMs: 150 }), refusedWith('EXTERNAL_SIGNER_TIMEOUT'));
    assert.ok(Date.now() - started < 2_000, 'bounded by the configured budget');
  });
});

async function hangingServer(): Promise<{ readonly endpoint: string; readonly server: Server; requests: () => number }> {
  let requests = 0;
  const server = createServer(() => {
    requests += 1; // never answers
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return { endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server, requests: () => requests };
}

describe('CORE-02 — a remote answer is never trusted blindly: every returned signature is validated and verified locally before use', () => {
  const substitutions: readonly [string, (request: ExternalAuthoritySigningRequest) => Promise<unknown>, AuthoritySigningFailureReason][] = [
    ['a signature made with the attacker key (claiming the pinned key id)', async (request) => ({ signature: { ...(await genuineSignature(AUTHORITY_KEY_UNTRUSTED, request)), keyId: AUTHORITY_KEY_A.keyId } }), 'EXTERNAL_SIGNER_SIGNATURE_INVALID'],
    ['a signature under another key id', async (request) => ({ signature: await genuineSignature(AUTHORITY_KEY_B, request) }), 'EXTERNAL_SIGNER_IDENTITY_MISMATCH'],
    ['another algorithm', async (request) => ({ signature: { ...(await genuineSignature(AUTHORITY_KEY_A, request)), algorithm: 'ecdsa-p256-v1' } }), 'EXTERNAL_SIGNER_IDENTITY_MISMATCH'],
    ['a valid signature over a different grant', async () => ({ signature: await genuineSignature(AUTHORITY_KEY_A, { operation: 'signGrant', grant: grant('aoc.grant:core02-b'), storeId: 'store-1' }) }), 'EXTERNAL_SIGNER_SIGNATURE_INVALID'],
    ['a truncated signature', async (request) => { const genuine = await genuineSignature(AUTHORITY_KEY_A, request); return { signature: { ...genuine, signature: genuine.signature.slice(0, 40) } }; }, 'EXTERNAL_SIGNER_MALFORMED_RESPONSE'],
    ['malformed base64url', async (request) => { const genuine = await genuineSignature(AUTHORITY_KEY_A, request); return { signature: { ...genuine, signature: `${genuine.signature.slice(0, -2)}+/` } }; }, 'EXTERNAL_SIGNER_MALFORMED_RESPONSE'],
    ['an unsupported artifact version', async (request) => ({ signature: { ...(await genuineSignature(AUTHORITY_KEY_A, request)), artifactVersion: 'aoc.authority-artifact.v2' } }), 'EXTERNAL_SIGNER_CAPABILITY_UNSUPPORTED'],
    ['an envelope with an extra field (a public key)', async (request) => ({ signature: { ...(await genuineSignature(AUTHORITY_KEY_A, request)), publicKey: AUTHORITY_KEY_UNTRUSTED.publicKeyPem } }), 'EXTERNAL_SIGNER_MALFORMED_RESPONSE'],
    ['garbage', async () => 'not-json-but-a-string', 'EXTERNAL_SIGNER_MALFORMED_RESPONSE'],
    ['an empty answer', async () => ({}), 'EXTERNAL_SIGNER_MALFORMED_RESPONSE'],
  ];

  for (const [label, answer, reason] of substitutions) {
    it(`refuses ${label}`, async () => {
      const transport = new ScriptedTransport(AUTHORITY_KEY_A);
      const { signer, monitor } = await establishScripted(transport, { pin: AUTHORITY_KEY_A, trust: [AUTHORITY_KEY_A, AUTHORITY_KEY_B], maxAttempts: 3 });
      transport.answer = answer;
      await assert.rejects(() => signer.signGrant(grant(), 'store-1'), refusedWith(reason));
      assert.equal(transport.count('signGrant'), 1, 'an answer the service gave is never retried');
      assert.equal(monitor.status().state, 'unavailable');
      assert.equal(monitor.status().reason, reason);
    });
  }

  it('cross-domain substitution: a genuine signature from any other operation is refused for every operation (and for another artifact of the same kind)', async () => {
    for (const request of FIVE) {
      for (const other of FIVE) {
        if (other.operation === request.operation) continue;
        const transport = new ScriptedTransport(AUTHORITY_KEY_A);
        const { signer } = await establishScripted(transport, { pin: AUTHORITY_KEY_A });
        transport.answer = async () => ({ signature: await genuineSignature(AUTHORITY_KEY_A, other) });
        await assert.rejects(() => signWith(signer, request), refusedWith('EXTERNAL_SIGNER_SIGNATURE_INVALID'), `${other.operation} → ${request.operation}`);
      }
    }
    // Replay: a valid signature over Grant A does not work for Grant B.
    const transport = new ScriptedTransport(AUTHORITY_KEY_A);
    const { signer } = await establishScripted(transport, { pin: AUTHORITY_KEY_A });
    const signatureForA = await genuineSignature(AUTHORITY_KEY_A, { operation: 'signGrant', grant: grant('aoc.grant:core02-a'), storeId: 'store-1' });
    transport.answer = () => ({ signature: signatureForA });
    await assert.rejects(() => signer.signGrant(grant('aoc.grant:core02-b'), 'store-1'), refusedWith('EXTERNAL_SIGNER_SIGNATURE_INVALID'));
    await assert.rejects(() => signer.signGrant(grant('aoc.grant:core02-a'), 'store-2'), refusedWith('EXTERNAL_SIGNER_SIGNATURE_INVALID'), 'or for the same grant in another store');
  });

  it('a still-trusted historical key answering mid-process is refused: rotation is configuration, never an answer from the other side', async () => {
    const transport = new ScriptedTransport(AUTHORITY_KEY_A);
    const { signer, monitor } = await establishScripted(transport, { pin: AUTHORITY_KEY_A, trust: [AUTHORITY_KEY_A, AUTHORITY_KEY_B] });
    assert.ok((await signer.signRevocationState(REVOCATION_STATE)).keyId === AUTHORITY_KEY_A.keyId);
    // The service is silently re-keyed to B — a key the registry still trusts.
    transport.answer = async (request) => ({ signature: await genuineSignature(AUTHORITY_KEY_B, request) });
    transport.identityAnswer = () => identityOf(AUTHORITY_KEY_B);
    await assert.rejects(() => signer.signRevocationState(REVOCATION_STATE), refusedWith('EXTERNAL_SIGNER_IDENTITY_MISMATCH'));
    const probed = await monitor.probe();
    assert.equal(probed.state, 'unavailable');
    assert.equal(probed.reason, 'EXTERNAL_SIGNER_IDENTITY_MISMATCH', 'the non-signing probe sees the re-keying too');
    assert.equal(transport.count('signRevocationState'), 2, 'the probe spends no signature');
  });
});

describe('CORE-02 — time, retries and failure taxonomy', () => {
  it('a hanging signer times out per attempt; availability failures retry up to the bound and no further; the total is bounded', async () => {
    const transport = new ScriptedTransport(AUTHORITY_KEY_A);
    const { signer } = await establishScripted(transport, { pin: AUTHORITY_KEY_A, maxAttempts: 3, timeoutMs: 100 });
    transport.answer = () => unavailable('EXTERNAL_SIGNER_TIMEOUT');
    await assert.rejects(() => signer.signGrant(grant(), 'store-1'), refusedWith('EXTERNAL_SIGNER_TIMEOUT'));
    assert.equal(transport.count('signGrant'), 3, 'exactly maxAttempts attempts');

    // Over real HTTP: a server that accepts and never answers.
    const hanging = await hangingServer();
    const httpTransport = createHttpExternalAuthoritySignerTransport({ endpoint: hanging.endpoint, credential: SIGNER_TOKEN });
    const started = Date.now();
    await assert.rejects(() => httpTransport.sign(FIVE[0] as ExternalAuthoritySigningRequest, { timeoutMs: 120 }), (error: unknown) => (error as { reason?: string }).reason === 'EXTERNAL_SIGNER_TIMEOUT');
    assert.ok(Date.now() - started < 1_500, `bounded: ${Date.now() - started} ms`);
    assert.equal(hanging.requests(), 1);
  });

  it('only the availability family is retried: authentication, refusal and malformed answers are not', async () => {
    const expectations: readonly [AuthoritySigningFailureReason, number][] = [
      ['EXTERNAL_SIGNER_TIMEOUT', 2],
      ['EXTERNAL_SIGNER_UNREACHABLE', 2],
      ['EXTERNAL_SIGNER_UNAVAILABLE', 2],
      ['EXTERNAL_SIGNER_AUTHENTICATION_FAILED', 1],
      ['EXTERNAL_SIGNER_REFUSED', 1],
      ['EXTERNAL_SIGNER_MALFORMED_RESPONSE', 1],
    ];
    for (const [reason, attempts] of expectations) {
      const transport = new ScriptedTransport(AUTHORITY_KEY_A);
      const { signer } = await establishScripted(transport, { pin: AUTHORITY_KEY_A, maxAttempts: 2 });
      transport.answer = () => unavailable(reason);
      await assert.rejects(() => signer.signApprovalState(APPROVAL_STATE), refusedWith(reason));
      assert.equal(transport.count('signApprovalState'), attempts, reason);
    }
    // A transient failure followed by success: one retry, one signature returned.
    const transport = new ScriptedTransport(AUTHORITY_KEY_A);
    const { signer, monitor } = await establishScripted(transport, { pin: AUTHORITY_KEY_A, maxAttempts: 2 });
    const genuine = transport.answer;
    transport.answer = (request, attempt) => (attempt === 1 ? unavailable('EXTERNAL_SIGNER_UNAVAILABLE') : genuine(request, attempt));
    assert.equal((await signer.signObligationDischargeState(DISCHARGE_STATE)).keyId, AUTHORITY_KEY_A.keyId);
    assert.equal(monitor.status().operations.signObligationDischargeState.retried, 1);
    assert.equal(monitor.status().state, 'ready');
  });

  it('HTTP statuses map onto the closed taxonomy and a refusal body is never echoed', async () => {
    const leak = 'PROVIDER_SECRET_SENTINEL_77aa';
    for (const [status, reason] of [
      [401, 'EXTERNAL_SIGNER_AUTHENTICATION_FAILED'],
      [403, 'EXTERNAL_SIGNER_AUTHENTICATION_FAILED'],
      [400, 'EXTERNAL_SIGNER_REFUSED'],
      [422, 'EXTERNAL_SIGNER_REFUSED'],
      [429, 'EXTERNAL_SIGNER_UNAVAILABLE'],
      [503, 'EXTERNAL_SIGNER_UNAVAILABLE'],
      [302, 'EXTERNAL_SIGNER_REFUSED'],
    ] as const) {
      const server = createServer((_req, res) => {
        res.writeHead(status, { 'content-type': 'application/json', location: 'http://127.0.0.1:1/' });
        res.end(JSON.stringify({ error: leak, stack: 'at provider.sdk' }));
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const transport = createHttpExternalAuthoritySignerTransport({ endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, credential: SIGNER_TOKEN });
      await assert.rejects(
        () => transport.identity({ timeoutMs: 1_000 }),
        (error: unknown) => {
          assert.equal((error as { reason?: string }).reason, reason, `HTTP ${status}`);
          const text = `${(error as Error).message} ${(error as Error).stack ?? ''}`;
          assert.equal(text.includes(leak) || text.includes(SIGNER_TOKEN), false, 'no response body and no credential in the error');
          return true;
        },
      );
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('the transport refuses plain http beyond loopback, credentials in the URL, a path, and a short credential — at construction, naming no value', () => {
    for (const endpoint of ['http://signer.example:8080', 'https://user:pass@signer.example', 'https://signer.example/v1', 'https://signer.example?x=1', 'ftp://signer.example', 'not a url']) {
      assert.throws(() => createHttpExternalAuthoritySignerTransport({ endpoint, credential: SIGNER_TOKEN }), (error: unknown) => error instanceof AuthorityAuthenticityConfigurationError && !error.message.includes(endpoint));
    }
    assert.throws(() => createHttpExternalAuthoritySignerTransport({ endpoint: 'https://signer.example', credential: 'short' }), (error: unknown) => error instanceof AuthorityAuthenticityConfigurationError && !error.message.includes('short'));
    assert.doesNotThrow(() => createHttpExternalAuthoritySignerTransport({ endpoint: 'https://signer.example:8443', credential: SIGNER_TOKEN }));
    assert.doesNotThrow(() => createHttpExternalAuthoritySignerTransport({ endpoint: 'http://127.0.0.1:7443', credential: SIGNER_TOKEN }));
  });

  it('concurrent signing is not serialized by the adapter: unrelated operations proceed in parallel', async () => {
    const transport = new ScriptedTransport(AUTHORITY_KEY_A);
    const { signer } = await establishScripted(transport, { pin: AUTHORITY_KEY_A });
    let inFlight = 0;
    let peak = 0;
    transport.answer = async (request) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 60));
      inFlight -= 1;
      return { signature: await genuineSignature(AUTHORITY_KEY_A, request) };
    };
    const signatures = await Promise.all(Array.from({ length: 10 }, (_, index) => signer.signGrant(grant(`aoc.grant:concurrent-${index}`), 'store-1')));
    assert.equal(signatures.length, 10);
    assert.ok(peak >= 5, `expected parallel calls, peak ${peak}`);
  });

  it('the adapter refuses nonsensical budgets and a pin outside the trusted registry before any network call', async () => {
    for (const [timeoutMs, maxAttempts] of [[0, 1], [60_001, 1], [1_000, 0], [1_000, 4], [1.5, 1]] as const) {
      const transport = new ScriptedTransport(AUTHORITY_KEY_A);
      await assert.rejects(() => establishScripted(transport, { pin: AUTHORITY_KEY_A, timeoutMs, maxAttempts }), AuthorityAuthenticityConfigurationError);
      assert.equal(transport.identityCalls, 0);
    }
  });
});
