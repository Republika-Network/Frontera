import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createPrivateKey, randomBytes, sign } from 'node:crypto';

import Database from 'better-sqlite3';

import {
  AUTHORITY_STATE_CHECKPOINT_FORMAT,
  AUTHORITY_STATE_WITNESS_PROTOCOL,
  AUTHORITY_STATE_WITNESS_RECEIPT_DOMAIN,
  AuthorityStateFreshnessError,
  createHttpAuthorityStateWitnessTransport,
  isRetryableAuthorityStateFreshnessFailure,
  parseWitnessRequest,
  serializeAuthorityStateCheckpoint,
  serializeWitnessReceipt,
  witnessReceiptSigningBytes,
  type AuthorityStateCheckpoint,
  type AuthorityStateFreshnessErrorCode,
  type WitnessBindingState,
  type WitnessReceipt,
} from '../authority-state-freshness/index.js';
import { loadEnterpriseConfiguration, toPublicEnterpriseConfiguration, validateEnterpriseEnvironment } from '../configuration/enterprise-configuration.js';
import { ScriptedWitnessTransport, WITNESS_TOKEN, closeAllWitnesses, connect, freshnessEnv, startWitness, witnessKey } from './core07-freshness-fixture.js';

/**
 * CORE-07 — the witness protocol, the reference witness's compare-and-advance
 * semantics, and the client's refusal of every answer it cannot verify.
 */

after(closeAllWitnesses);

const ORG = 'org-core07';
const digestOf = (n: number): string => `sha256:${n.toString(16).padStart(64, '0')}`;
const checkpoint = (sequence: number, overrides: Partial<AuthorityStateCheckpoint> = {}): AuthorityStateCheckpoint => ({
  stateKind: 'bounded-grant-revocation-state',
  organizationId: ORG,
  storeId: 'store-1',
  sequence,
  stateDigest: digestOf(sequence + 1),
  ...overrides,
});

function refusedWith(code: AuthorityStateFreshnessErrorCode) {
  return (error: unknown): true => {
    assert.ok(error instanceof AuthorityStateFreshnessError, `expected an AuthorityStateFreshnessError, got ${String(error)}`);
    assert.equal(error.code, code, error.message);
    return true;
  };
}

describe('CORE-07 — the canonical checkpoint', () => {
  it('is versioned, deterministic, and binds kind, organization, store, sequence and digest', () => {
    const base = checkpoint(3);
    const bytes = serializeAuthorityStateCheckpoint(base);
    assert.equal(bytes, `{"format":"${AUTHORITY_STATE_CHECKPOINT_FORMAT}","organizationId":"${ORG}","sequence":3,"stateDigest":"${digestOf(4)}","stateKind":"bounded-grant-revocation-state","storeId":"store-1"}`);
    assert.equal(serializeAuthorityStateCheckpoint({ ...base }), bytes, 'deterministic');
    for (const variant of [{ stateKind: 'approval-state' as const }, { organizationId: 'org-other' }, { storeId: 'store-2' }, { sequence: 4 }, { stateDigest: digestOf(99) }]) {
      assert.notEqual(serializeAuthorityStateCheckpoint({ ...base, ...variant }), bytes, `changing ${Object.keys(variant)[0]} changes the checkpoint`);
    }
  });

  it('the receipt signing domain is distinct from every authority-artifact domain', () => {
    assert.match(AUTHORITY_STATE_WITNESS_RECEIPT_DOMAIN, /^frontera:authority-state-witness:receipt:v1$/);
    assert.ok(!AUTHORITY_STATE_WITNESS_RECEIPT_DOMAIN.includes('authority-artifact'));
  });
});

describe('CORE-07 — strict request parsing (the witness side)', () => {
  const challenge = randomBytes(32).toString('hex');
  it('accepts exactly the protocol shape and refuses everything else', () => {
    assert.ok(parseWitnessRequest('prepare', { protocol: AUTHORITY_STATE_WITNESS_PROTOCOL, challenge, expected: checkpoint(0), proposed: checkpoint(1) }));
    const refused: readonly [string, unknown][] = [
      ['extra key', { protocol: AUTHORITY_STATE_WITNESS_PROTOCOL, challenge, expected: checkpoint(0), proposed: checkpoint(1), path: '/etc' }],
      ['wrong protocol', { protocol: 'frontera.authority-state-witness.v2', challenge, expected: checkpoint(0), proposed: checkpoint(1) }],
      ['skipped sequence', { protocol: AUTHORITY_STATE_WITNESS_PROTOCOL, challenge, expected: checkpoint(0), proposed: checkpoint(2) }],
      ['store switch', { protocol: AUTHORITY_STATE_WITNESS_PROTOCOL, challenge, expected: checkpoint(0), proposed: checkpoint(1, { storeId: 'store-2' }) }],
      ['kind switch', { protocol: AUTHORITY_STATE_WITNESS_PROTOCOL, challenge, expected: checkpoint(0), proposed: checkpoint(1, { stateKind: 'approval-state' }) }],
      ['unknown kind', { protocol: AUTHORITY_STATE_WITNESS_PROTOCOL, challenge, expected: checkpoint(0, { stateKind: 'arbitrary' as never }), proposed: checkpoint(1, { stateKind: 'arbitrary' as never }) }],
      ['bad digest', { protocol: AUTHORITY_STATE_WITNESS_PROTOCOL, challenge, expected: checkpoint(0, { stateDigest: 'md5:00' }), proposed: checkpoint(1) }],
      ['short challenge', { protocol: AUTHORITY_STATE_WITNESS_PROTOCOL, challenge: 'ab', expected: checkpoint(0), proposed: checkpoint(1) }],
    ];
    for (const [why, body] of refused) assert.equal(parseWitnessRequest('prepare', body), undefined, why);
    assert.equal(parseWitnessRequest('enroll', { protocol: AUTHORITY_STATE_WITNESS_PROTOCOL, challenge, enrollment: 'genesis', checkpoint: checkpoint(3) }), undefined, 'a genesis is sequence 0');
  });
});

describe('CORE-07 — the reference witness: compare-and-advance, never last-writer-wins', () => {
  it('enroll → prepare → finalize; a stale expected, a second pending, a rebind and a regression are all conflicts', async () => {
    const witness = await startWitness();
    const { anchor } = await connect(witness);
    assert.equal((await anchor.enroll('genesis', checkpoint(0))).outcome, 'enrolled');
    assert.equal((await anchor.enroll('genesis', checkpoint(0))).outcome, 'enrolled', 'the same enrollment, repeated');
    assert.equal((await anchor.enroll('baseline', checkpoint(5, { storeId: 'store-2' }))).outcome, 'conflict', 'a slot is never rebound');
    assert.equal((await anchor.prepare(checkpoint(0), checkpoint(1))).outcome, 'prepared');
    assert.equal((await anchor.prepare(checkpoint(0), checkpoint(1))).outcome, 'prepared', 'the same prepare, repeated');
    assert.equal((await anchor.prepare(checkpoint(0), checkpoint(1, { stateDigest: digestOf(77) }))).outcome, 'conflict', 'a second, different successor');
    assert.equal((await anchor.finalize(checkpoint(1, { stateDigest: digestOf(77) }))).outcome, 'conflict', 'only the pending successor finalizes');
    assert.equal((await anchor.finalize(checkpoint(1))).outcome, 'finalized');
    assert.equal((await anchor.finalize(checkpoint(1))).outcome, 'finalized', 'the same finalize, repeated');
    assert.equal((await anchor.prepare(checkpoint(0), checkpoint(1))).outcome, 'conflict', 'a stale expected checkpoint');
    const state = await anchor.read({ stateKind: 'bounded-grant-revocation-state', organizationId: ORG });
    assert.deepEqual(state, { status: 'bound', storeId: 'store-1', committed: { sequence: 1, stateDigest: digestOf(2) } });
    // Every change is in an append-only history.
    const db = new Database(witness.databasePath);
    const events = (db.prepare('SELECT event, sequence FROM witness_history ORDER BY id').all() as { event: string; sequence: number }[]).map((row) => `${row.event}@${row.sequence}`);
    assert.deepEqual(events, ['enrolled-genesis@0', 'prepared@1', 'finalized@1']);
    assert.throws(() => db.prepare('DELETE FROM witness_history').run(), /append-only/);
    assert.throws(() => db.prepare('DELETE FROM witness_bindings').run(), /never deleted/);
    assert.throws(() => db.prepare('UPDATE witness_bindings SET committed_sequence = 0').run(), /never moves backwards/);
    db.close();
  });

  it('slots are separated by state kind and organization', async () => {
    const witness = await startWitness();
    const { anchor } = await connect(witness);
    await anchor.enroll('genesis', checkpoint(0));
    assert.deepEqual(await anchor.read({ stateKind: 'approval-state', organizationId: ORG }), { status: 'unbound' });
    assert.deepEqual(await anchor.read({ stateKind: 'bounded-grant-revocation-state', organizationId: 'org-other' }), { status: 'unbound' });
  });

  it('C7 at the witness: concurrent prepares from the same committed state — exactly one wins', async () => {
    const witness = await startWitness();
    const clients = await Promise.all([connect(witness), connect(witness), connect(witness), connect(witness)]);
    await clients[0]!.anchor.enroll('genesis', checkpoint(0));
    const answers = await Promise.all(clients.map((client, index) => client.anchor.prepare(checkpoint(0), checkpoint(1, { stateDigest: digestOf(100 + index) }))));
    assert.equal(answers.filter((answer) => answer.outcome === 'prepared').length, 1);
    assert.equal(answers.filter((answer) => answer.outcome === 'conflict').length, 3);
  });
});

/** A witness HTTP server whose answers the test writes, signed with `key` when asked to. */
async function forgingWitness(respond: (body: Record<string, unknown>, path: string) => { readonly status?: number; readonly body: unknown; readonly headers?: Record<string, string> }): Promise<{ readonly endpoint: string; close(): Promise<void> }> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const answer = respond(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>, req.url ?? '');
      const payload = JSON.stringify(answer.body);
      res.writeHead(answer.status ?? 200, { 'content-type': 'application/json', ...(answer.headers ?? {}) });
      res.end(payload);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  // A forging witness never keeps the test process alive, even when an assertion fails before it is closed.
  server.unref();
  return {
    endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function signReceipt(receipt: WitnessReceipt, privateKeyPem: string): { readonly receipt: WitnessReceipt; readonly signature: string } {
  return { receipt, signature: sign(null, witnessReceiptSigningBytes(receipt), createPrivateKey(privateKeyPem)).toString('base64') };
}

const identityReceipt = (challenge: string, witnessId = 'witness-core07-test'): WitnessReceipt => ({
  protocol: AUTHORITY_STATE_WITNESS_PROTOCOL,
  witnessId,
  operation: 'identity',
  challenge,
  outcome: 'identity',
  operations: ['identity', 'read', 'enroll', 'prepare', 'finalize'],
});

describe('CORE-07 — anchor authentication: nothing the witness says is believed unless it verifies', () => {
  it('A1: a witness answering under another identity is refused at the handshake', async () => {
    const witness = await startWitness();
    await assert.rejects(() => connect(witness, { pin: { witnessId: 'witness-someone-else' } }), refusedWith('AUTHORITY_FRESHNESS_WITNESS_UNAUTHENTIC'));
  });

  it('A2: the same witness id with different public material is refused — the key is the identity', async () => {
    const witness = await startWitness();
    await assert.rejects(() => connect(witness, { pin: { publicKeyPem: witnessKey().publicKeyPem } }), refusedWith('AUTHORITY_FRESHNESS_WITNESS_UNAUTHENTIC'));
  });

  it('A3: a malformed receipt is refused', async () => {
    for (const body of [{ receipt: {}, signature: 'x' }, { receipt: 'nope' }, [], { receipt: { protocol: AUTHORITY_STATE_WITNESS_PROTOCOL }, signature: 'AAAA', extra: true }]) {
      const forged = await forgingWitness(() => ({ body }));
      await assert.rejects(() => connect({ endpoint: forged.endpoint, witnessId: 'w', publicKeyPem: witnessKey().publicKeyPem }), refusedWith('AUTHORITY_FRESHNESS_MALFORMED_RESPONSE'));
      await forged.close();
    }
  });

  it('A4: a receipt whose signature does not verify under the pinned key — tampered, or signed by another key — is refused', async () => {
    const pinned = witnessKey();
    const attacker = witnessKey();
    const forged = await forgingWitness((body) => ({ body: signReceipt(identityReceipt(body['challenge'] as string), attacker.privateKeyPem) }));
    await assert.rejects(() => connect({ endpoint: forged.endpoint, witnessId: 'witness-core07-test', publicKeyPem: pinned.publicKeyPem }), refusedWith('AUTHORITY_FRESHNESS_WITNESS_UNAUTHENTIC'));
    await forged.close();
    // A genuine witness whose read answer is altered in transit.
    const witness = await startWitness();
    const transport = new ScriptedWitnessTransport(createHttpAuthorityStateWitnessTransport({ endpoint: witness.endpoint, credential: WITNESS_TOKEN }));
    const { anchor } = await connect(witness, { transport });
    await anchor.enroll('genesis', checkpoint(0));
    transport.answer = async (request, forward) => {
      const answer = (await forward()) as { receipt: { state: { committed: { sequence: number } } } };
      if (request.operation === 'read') answer.receipt.state.committed.sequence = 0;
      return answer;
    };
    await anchor.prepare(checkpoint(0), checkpoint(1));
    await anchor.finalize(checkpoint(1));
    await assert.rejects(() => anchor.read({ stateKind: 'bounded-grant-revocation-state', organizationId: ORG }), refusedWith('AUTHORITY_FRESHNESS_WITNESS_UNAUTHENTIC'));
  });

  it('A4 (after the handshake): a well-formed read receipt claiming a stale state, re-signed by another key or by the pinned key outside the receipt domain, is refused — nothing it says is used', async () => {
    const pinned = witnessKey();
    const attacker = witnessKey();
    const witness = await startWitness({ key: pinned });
    const transport = new ScriptedWitnessTransport(createHttpAuthorityStateWitnessTransport({ endpoint: witness.endpoint, credential: WITNESS_TOKEN }));
    const { anchor } = await connect(witness, { transport });
    await anchor.enroll('genesis', checkpoint(0));
    await anchor.prepare(checkpoint(0), checkpoint(1));
    await anchor.finalize(checkpoint(1));
    const binding = { stateKind: 'bounded-grant-revocation-state', organizationId: ORG } as const;
    // Every forgery answers the right challenge, names the pinned witness and
    // the asked binding, and is exactly the protocol shape: only the signature
    // can tell it from the witness's own answer.
    const stale = (receipt: WitnessReceipt): WitnessReceipt => ({ ...receipt, state: { status: 'bound', storeId: 'store-1', committed: { sequence: 0, stateDigest: digestOf(1) } } });
    const forgeries: readonly [string, (receipt: WitnessReceipt) => { readonly receipt: WitnessReceipt; readonly signature: string }][] = [
      ['signed by another key', (receipt) => signReceipt(stale(receipt), attacker.privateKeyPem)],
      ['signed by the pinned key without the receipt domain', (receipt) => ({ receipt: stale(receipt), signature: sign(null, Buffer.from(serializeWitnessReceipt(stale(receipt)), 'utf8'), createPrivateKey(pinned.privateKeyPem)).toString('base64') })],
      ['the genuine signature over the genuine receipt, then altered', (receipt) => ({ receipt: stale(receipt), signature: signReceipt(receipt, pinned.privateKeyPem).signature })],
      ['an all-zero signature', (receipt) => ({ receipt: stale(receipt), signature: Buffer.alloc(64).toString('base64') })],
    ];
    for (const [name, forge] of forgeries) {
      transport.answer = async (request, forward) => {
        const genuine = (await forward()) as { receipt: WitnessReceipt };
        return request.operation === 'read' ? forge(genuine.receipt) : genuine;
      };
      await assert.rejects(() => anchor.read(binding), refusedWith('AUTHORITY_FRESHNESS_WITNESS_UNAUTHENTIC'), name);
    }
    // Control: the unaltered witness answer verifies, and says sequence 1.
    transport.answer = (_request, forward) => forward();
    const current = await anchor.read(binding);
    assert.ok(current.status === 'bound' && current.committed.sequence === 1);
  });

  it('A4 (checkpoint binding): an authentic receipt whose outcome does not hold the checkpoint that was asked about is refused', async () => {
    const pinned = witnessKey();
    const witness = await startWitness({ key: pinned });
    const transport = new ScriptedWitnessTransport(createHttpAuthorityStateWitnessTransport({ endpoint: witness.endpoint, credential: WITNESS_TOKEN }));
    const { anchor } = await connect(witness, { transport });
    await anchor.enroll('genesis', checkpoint(0));
    // Each answer is genuinely signed by the pinned witness key over the right
    // challenge and binding — but says it applied something else.
    const resign = (receipt: WitnessReceipt, state: WitnessBindingState) => signReceipt({ ...receipt, state }, pinned.privateKeyPem);
    const bound = (committed: number, pending?: number) => ({ status: 'bound' as const, storeId: 'store-1', committed: { sequence: committed, stateDigest: digestOf(committed + 1) }, ...(pending !== undefined ? { pending: { sequence: pending, stateDigest: digestOf(pending + 1) } } : {}) });
    transport.answer = async (request, forward) => {
      const genuine = (await forward()) as { receipt: WitnessReceipt };
      // 'prepared', yet nothing pending.
      return request.operation === 'prepare' ? resign(genuine.receipt, bound(0)) : genuine;
    };
    await assert.rejects(() => anchor.prepare(checkpoint(0), checkpoint(1)), refusedWith('AUTHORITY_FRESHNESS_MALFORMED_RESPONSE'));
    transport.answer = (_request, forward) => forward();
    await anchor.finalize(checkpoint(1));
    transport.answer = async (request, forward) => {
      const genuine = (await forward()) as { receipt: WitnessReceipt };
      // 'finalized', yet about another store.
      return request.operation === 'finalize' ? resign(genuine.receipt, { ...bound(1), storeId: 'store-other' }) : genuine;
    };
    await assert.rejects(() => anchor.finalize(checkpoint(1)), refusedWith('AUTHORITY_FRESHNESS_MALFORMED_RESPONSE'));
    transport.answer = async (request, forward) => {
      const genuine = (await forward()) as { receipt: WitnessReceipt };
      // 'enrolled', yet holding a different checkpoint.
      return request.operation === 'enroll' ? resign(genuine.receipt, bound(7)) : genuine;
    };
    await assert.rejects(() => anchor.enroll('baseline', checkpoint(1)), refusedWith('AUTHORITY_FRESHNESS_MALFORMED_RESPONSE'));
  });

  it('A5: an unsupported protocol version or a missing operation is refused', async () => {
    const key = witnessKey();
    const versions = await forgingWitness((body) => ({ body: signReceipt({ ...identityReceipt(body['challenge'] as string), protocol: 'frontera.authority-state-witness.v2' as never }, key.privateKeyPem) }));
    await assert.rejects(() => connect({ endpoint: versions.endpoint, witnessId: 'witness-core07-test', publicKeyPem: key.publicKeyPem }), refusedWith('AUTHORITY_FRESHNESS_MALFORMED_RESPONSE'));
    await versions.close();
    const partial = await forgingWitness((body) => ({ body: signReceipt({ ...identityReceipt(body['challenge'] as string), operations: ['identity', 'read'] }, key.privateKeyPem) }));
    await assert.rejects(() => connect({ endpoint: partial.endpoint, witnessId: 'witness-core07-test', publicKeyPem: key.publicKeyPem }), refusedWith('AUTHORITY_FRESHNESS_PROTOCOL_UNSUPPORTED'));
    await partial.close();
  });

  it('A6/A7: an authentic receipt about another binding — another organization or state kind — is refused', async () => {
    const witness = await startWitness();
    const inner = createHttpAuthorityStateWitnessTransport({ endpoint: witness.endpoint, credential: WITNESS_TOKEN });
    const transport = new ScriptedWitnessTransport(inner);
    const { anchor } = await connect(witness, { transport });
    for (const substitute of [{ organizationId: 'org-other' }, { stateKind: 'approval-state' as const }]) {
      transport.answer = (request, forward) => (request.operation === 'read' ? inner.call({ ...request, binding: { ...request.binding, ...substitute } }, { timeoutMs: 2_000 }) : forward());
      await assert.rejects(() => anchor.read({ stateKind: 'bounded-grant-revocation-state', organizationId: ORG }), refusedWith('AUTHORITY_FRESHNESS_BINDING_MISMATCH'));
    }
  });

  it('a recorded, genuinely signed receipt replayed to a later call is refused (the challenge is per call)', async () => {
    const witness = await startWitness();
    const transport = new ScriptedWitnessTransport(createHttpAuthorityStateWitnessTransport({ endpoint: witness.endpoint, credential: WITNESS_TOKEN }));
    const { anchor } = await connect(witness, { transport });
    await anchor.enroll('genesis', checkpoint(0));
    let recorded: unknown;
    transport.answer = async (request, forward) => {
      if (request.operation !== 'read') return forward();
      if (recorded === undefined) {
        recorded = await forward();
        return recorded;
      }
      return recorded;
    };
    await anchor.read({ stateKind: 'bounded-grant-revocation-state', organizationId: ORG });
    await anchor.prepare(checkpoint(0), checkpoint(1));
    await anchor.finalize(checkpoint(1));
    await assert.rejects(() => anchor.read({ stateKind: 'bounded-grant-revocation-state', organizationId: ORG }), refusedWith('AUTHORITY_FRESHNESS_WITNESS_UNAUTHENTIC'));
  });

  it('A8: a refused credential is a closed, secret-free error; nothing retries it', async () => {
    const witness = await startWitness();
    const wrong = 'WRONG_WITNESS_CREDENTIAL_SENTINEL_0123456789abcdef';
    let calls = 0;
    const inner = createHttpAuthorityStateWitnessTransport({ endpoint: witness.endpoint, credential: wrong });
    const counting = { call: (...args: Parameters<typeof inner.call>) => ((calls += 1), inner.call(...args)) };
    const error = await connect(witness, { transport: counting, maxAttempts: 3 }).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    assert.ok(error instanceof AuthorityStateFreshnessError);
    assert.equal(error.code, 'AUTHORITY_FRESHNESS_AUTHENTICATION_FAILED');
    assert.equal(calls, 1, 'an answer is never retried');
    for (const secret of [wrong, WITNESS_TOKEN, witness.endpoint]) assert.ok(!error.message.includes(secret), 'no credential or endpoint in the error');
  });
});

describe('CORE-07 — transport bounds and the retry taxonomy', () => {
  it('only availability is retryable', () => {
    const codes: readonly AuthorityStateFreshnessErrorCode[] = [
      'AUTHORITY_FRESHNESS_AUTHENTICATION_FAILED',
      'AUTHORITY_FRESHNESS_REFUSED',
      'AUTHORITY_FRESHNESS_MALFORMED_RESPONSE',
      'AUTHORITY_FRESHNESS_WITNESS_UNAUTHENTIC',
      'AUTHORITY_FRESHNESS_PROTOCOL_UNSUPPORTED',
      'AUTHORITY_FRESHNESS_BINDING_MISMATCH',
      'AUTHORITY_FRESHNESS_ROLLBACK_DETECTED',
      'AUTHORITY_FRESHNESS_FORK_DETECTED',
      'AUTHORITY_FRESHNESS_PENDING_RECOVERY',
      'AUTHORITY_FRESHNESS_UNBOUND_STORE',
      'AUTHORITY_FRESHNESS_CONFLICT',
    ];
    assert.equal(isRetryableAuthorityStateFreshnessFailure('AUTHORITY_FRESHNESS_UNAVAILABLE'), true);
    for (const code of codes) assert.equal(isRetryableAuthorityStateFreshnessFailure(code), false, code);
  });

  it('5xx and 429 are retried within maxAttempts; a redirect is a refusal, never followed; an oversized body is refused', async () => {
    let hits = 0;
    const flaky = await forgingWitness(() => ((hits += 1), { status: hits === 1 ? 503 : 429, body: {} }));
    await assert.rejects(() => connect({ endpoint: flaky.endpoint, witnessId: 'w', publicKeyPem: witnessKey().publicKeyPem }, { maxAttempts: 3 }), refusedWith('AUTHORITY_FRESHNESS_UNAVAILABLE'));
    assert.equal(hits, 3);
    await flaky.close();
    let redirected = 0;
    const target = await forgingWitness(() => ((redirected += 1), { body: {} }));
    const redirecting = await forgingWitness(() => ({ status: 307, body: {}, headers: { location: `${target.endpoint}/v1/identity` } }));
    await assert.rejects(() => connect({ endpoint: redirecting.endpoint, witnessId: 'w', publicKeyPem: witnessKey().publicKeyPem }, { maxAttempts: 3 }), refusedWith('AUTHORITY_FRESHNESS_REFUSED'));
    assert.equal(redirected, 0, 'the redirect target was never contacted');
    await redirecting.close();
    await target.close();
    const huge = await forgingWitness(() => ({ body: { receipt: 'x'.repeat(64 * 1024), signature: 'y' } }));
    await assert.rejects(() => connect({ endpoint: huge.endpoint, witnessId: 'w', publicKeyPem: witnessKey().publicKeyPem }), refusedWith('AUTHORITY_FRESHNESS_MALFORMED_RESPONSE'));
    await huge.close();
  });

  it('a witness that does not answer in time is a bounded timeout', async () => {
    const hanging = createServer(() => {});
    await new Promise<void>((resolve) => hanging.listen(0, '127.0.0.1', () => resolve()));
    const endpoint = `http://127.0.0.1:${(hanging.address() as AddressInfo).port}`;
    const started = Date.now();
    await assert.rejects(() => connect({ endpoint, witnessId: 'w', publicKeyPem: witnessKey().publicKeyPem }, { timeoutMs: 150, maxAttempts: 2 }), refusedWith('AUTHORITY_FRESHNESS_UNAVAILABLE'));
    assert.ok(Date.now() - started < 2_000);
    hanging.closeAllConnections();
    await new Promise<void>((resolve) => hanging.close(() => resolve()));
  });

  it('the endpoint is a base URL: https, or http only to loopback; no path, query, fragment or userinfo', () => {
    for (const endpoint of ['http://witness.example.com', 'https://witness.example.com/v1', 'https://witness.example.com/?x=1', 'https://user:pw@witness.example.com', 'ftp://witness.example.com', 'not a url']) {
      assert.throws(() => createHttpAuthorityStateWitnessTransport({ endpoint, credential: WITNESS_TOKEN }), refusedWith('AUTHORITY_FRESHNESS_CONFIGURATION_INVALID'), endpoint);
    }
    assert.throws(() => createHttpAuthorityStateWitnessTransport({ endpoint: 'https://witness.example.com', credential: 'short' }), refusedWith('AUTHORITY_FRESHNESS_CONFIGURATION_INVALID'));
    createHttpAuthorityStateWitnessTransport({ endpoint: 'https://witness.example.com', credential: WITNESS_TOKEN });
    createHttpAuthorityStateWitnessTransport({ endpoint: 'http://127.0.0.1:7444', credential: WITNESS_TOKEN });
  });
});

describe('CORE-07 — configuration: a closed mode, strict variables, no secret on the public surface', () => {
  const witness = { endpoint: 'https://witness.example.com', witnessId: 'witness-prod', publicKeyPem: witnessKey().publicKeyPem };

  it('accepts a complete external configuration and redacts the credential', () => {
    const env = freshnessEnv(witness);
    assert.deepEqual(validateEnterpriseEnvironment(env), []);
    const configuration = loadEnterpriseConfiguration(env);
    assert.equal(configuration.authorityFreshness?.mode, 'external');
    const exposed = JSON.stringify(toPublicEnterpriseConfiguration(configuration));
    assert.ok(!exposed.includes(WITNESS_TOKEN), 'the witness credential never reaches the public configuration');
    assert.ok(exposed.includes('"credentialConfigured":true'));
    assert.ok(exposed.includes('"origin":"https://witness.example.com"'));
    assert.equal(loadEnterpriseConfiguration({}).authorityFreshness?.mode, 'none');
  });

  it('refuses an unknown mode, a partial external configuration, a stray witness variable and a shared signer credential', () => {
    const problem = (env: Record<string, string | undefined>, pattern: RegExp): void => {
      const problems = validateEnterpriseEnvironment(env);
      assert.ok(problems.some((entry) => pattern.test(entry)), `${JSON.stringify(problems)} should match ${String(pattern)}`);
      for (const entry of problems) assert.ok(!entry.includes(WITNESS_TOKEN), 'no value is echoed');
    };
    problem({ AOC_ENTERPRISE_AUTHORITY_FRESHNESS_MODE: 'local' }, /must be one of: none, external/);
    for (const name of ['AOC_ENTERPRISE_AUTHORITY_FRESHNESS_ENDPOINT', 'AOC_ENTERPRISE_AUTHORITY_FRESHNESS_TOKEN', 'AOC_ENTERPRISE_AUTHORITY_FRESHNESS_WITNESS_ID', 'AOC_ENTERPRISE_AUTHORITY_FRESHNESS_WITNESS_PUBLIC_KEY']) {
      problem(freshnessEnv(witness, { [name]: '' }), new RegExp(name));
    }
    problem({ AOC_ENTERPRISE_AUTHORITY_FRESHNESS_ENDPOINT: 'https://witness.example.com' }, /is set but AOC_ENTERPRISE_AUTHORITY_FRESHNESS_MODE is not 'external'/);
    problem(freshnessEnv(witness, { AOC_ENTERPRISE_AUTHORITY_FRESHNESS_ENDPOINT: 'http://witness.example.com' }), /plain http to a non-loopback/);
    problem(freshnessEnv(witness, { AOC_ENTERPRISE_AUTHORITY_FRESHNESS_MAX_ATTEMPTS: '9' }), /MAX_ATTEMPTS must be 1, 2 or 3/);
    problem(freshnessEnv(witness, { AOC_ENTERPRISE_AUTHORITY_FRESHNESS_TIMEOUT_MS: '0' }), /TIMEOUT_MS must be an integer from 1 to 60000/);
    problem(freshnessEnv(witness, { AOC_ENTERPRISE_AUTHORITY_FRESHNESS_WITNESS_PUBLIC_KEY: '-----BEGIN PRIVATE KEY-----' }), /Never a private key/);
    problem({ ...freshnessEnv(witness), AOC_ENTERPRISE_AUTHORITY_SIGNER_TOKEN: WITNESS_TOKEN }, /must not be the external signer credential/);
  });
});
