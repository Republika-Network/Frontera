import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';

import type { PaymentExecutionRequest } from '../../features/payment-runtime/index.js';
import { XRPL_RAIL_DETAILS as D, createXrplRlusdRail, type XrplPreparedPayment } from '../../features/payment-runtime/rails/xrpl/index.js';
import { GOVERNED_ACCOUNT, ISSUER, OTHER_SOURCE, RLUSD_ASSET, TREASURY, VENDOR, testClock, testConfiguration } from '../../features/payment-runtime/rails/xrpl/tests/xrpl-test-fixtures.js';
import { createExternalXrplSigner, type ExternalXrplSignerPin } from '../xrpl-payment-rail/external-xrpl-signer.js';
import { startReferenceXrplSigner } from '../xrpl-payment-rail/reference/reference-xrpl-signer-service.js';
import { createHttpExternalXrplSignerTransport, ExternalXrplSignerConfigurationError, type ExternalXrplSignerTransport } from '../xrpl-payment-rail/signer-http-transport.js';
import { EXTERNAL_XRPL_SIGNER_PROTOCOL, parseExternalXrplSigningRequest } from '../xrpl-payment-rail/signer-protocol.js';
import { createSqliteXrplSubmissionInterlock } from '../xrpl-payment-rail/sqlite-xrpl-submission-interlock.js';
import { SIGNER_ID, SIGNER_TOKEN, createLedgerSimulator, scratch } from './pay03-xrpl-fixture.js';

/**
 * PAY-03 — the external XRPL transaction signer: protocol, identity pinning,
 * bounded transport, and the signer failure matrix (S1–S10), qualified
 * against the real reference signer over loopback HTTP and a fault server.
 *
 * Every refusal must end with **zero** XRPL submissions.
 */

const tmp = scratch('frontera-pay03-signer-');
const CONFIGURATION = testConfiguration({ sourceAccounts: [{ accountId: GOVERNED_ACCOUNT, address: TREASURY.classicAddress }], finalityTimeoutMs: 5_000, pollIntervalMs: 1_000 });
const PIN: ExternalXrplSignerPin = { signerId: SIGNER_ID, accounts: [{ address: TREASURY.classicAddress, signingPublicKey: TREASURY.publicKey }] };
const SEED_CANARY = TREASURY.seed!;

let reference: Awaited<ReturnType<typeof startReferenceXrplSigner>>;
before(async () => {
  reference = await startReferenceXrplSigner({ signerId: SIGNER_ID, seed: SEED_CANARY, credential: SIGNER_TOKEN });
});
after(async () => {
  await reference.close();
  tmp.cleanup();
});

const endpointOf = (port: number): string => `http://127.0.0.1:${port}`;

let counter = 0;
function request(): PaymentExecutionRequest {
  counter += 1;
  return {
    executionId: `aoc.exec:pay03-signer-${counter}`,
    requestId: `req-${counter}`,
    decisionId: `dec-${counter}`,
    grantId: `grant-${counter}`,
    notAfter: '2030-01-01T00:00:00.000Z',
    source: { accountId: GOVERNED_ACCOUNT },
    destination: { kind: 'xrpl-account', reference: VENDOR.classicAddress },
    amount: { value: '12.5', unit: RLUSD_ASSET },
    purpose: 'vendor-payment',
    rail: 'xrpl-rlusd',
  };
}

/** The rail, with the real interlock and the external signer over `transport`, past its restart quarantine. */
async function railWith(transport: ExternalXrplSignerTransport, pin: ExternalXrplSignerPin = PIN, timeoutMs = 2_000) {
  const ledger = createLedgerSimulator();
  const store = await createSqliteXrplSubmissionInterlock(join(tmp.dir(), 'interlock.sqlite'), { scope: { railId: CONFIGURATION.railId, networkId: CONFIGURATION.networkId }, now: () => new Date().toISOString() });
  const signer = createExternalXrplSigner({ transport, pin, timeoutMs, probeIntervalMs: 0 });
  const rail = createXrplRlusdRail({ configuration: CONFIGURATION, client: ledger, signers: signer.signers, interlock: store, ...testClock() });
  await rail.readiness();
  ledger.index += CONFIGURATION.lastLedgerOffset + 4;
  return { ledger, store, signer, rail };
}

/** A loopback server answering every request with `respond`, so a test can play any signer misbehaviour. */
async function faultServer(respond: (req: IncomingMessage, res: ServerResponse, body: unknown) => void): Promise<{ readonly endpoint: string; readonly requests: unknown[]; close(): Promise<void> }> {
  const requests: unknown[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      let body: unknown;
      try {
        body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
      } catch {
        body = undefined;
      }
      requests.push(body);
      respond(req, res, body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return {
    endpoint: endpointOf((server.address() as AddressInfo).port),
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

const json = (res: ServerResponse, status: number, body: unknown): void => {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
};
const identityOf = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  protocol: EXTERNAL_XRPL_SIGNER_PROTOCOL,
  signerId: SIGNER_ID,
  operations: ['sign-xrpl-payment'],
  accounts: [{ address: TREASURY.classicAddress, signingPublicKey: TREASURY.publicKey }],
  ...overrides,
});
/** Answers identity truthfully, and signing by proxying to the real reference signer and then applying `mutate`. */
function proxyThenMutate(mutate: (answer: Record<string, unknown>, body: Record<string, unknown>) => Record<string, unknown>) {
  const upstream = createHttpExternalXrplSignerTransport({ endpoint: endpointOf(reference.port), credential: SIGNER_TOKEN });
  return (req: IncomingMessage, res: ServerResponse, body: unknown): void => {
    if (req.method === 'GET') return json(res, 200, identityOf());
    const parsed = parseExternalXrplSigningRequest(body);
    if (parsed === undefined) return json(res, 422, {});
    void upstream.signPayment(parsed, { timeoutMs: 2_000 }).then(
      (answer) => json(res, 200, mutate(answer as Record<string, unknown>, body as Record<string, unknown>)),
      () => json(res, 500, {}),
    );
  };
}

const refusedWithNothingSubmitted = (outcome: unknown, ledger: { calls: { submit: number } }, detail: string = D.SIGNING_FAILED): void => {
  assert.deepEqual([(outcome as { status: string }).status, (outcome as { detail?: string }).detail], ['not-completed', detail]);
  assert.equal(ledger.calls.submit, 0, 'zero XRPL submissions');
};

describe('PAY-03 external signer — the happy path through the real reference signer', () => {
  it('signs exactly the prepared payment, the rail verifies it (transaction, pinned key, hash), submits once, completes', async () => {
    const { rail, ledger, signer, store } = await railWith(createHttpExternalXrplSignerTransport({ endpoint: endpointOf(reference.port), credential: SIGNER_TOKEN }));
    const before = reference.signatures();
    const outcome = await rail.execute(request());
    assert.equal(outcome.status, 'completed');
    assert.equal(ledger.calls.submit, 1);
    assert.equal(reference.signatures() - before, 1, 'one signature per execution');
    assert.equal(signer.status().state, 'verified');
    await store.close();
  });

  it('the reference signer refuses anything that is not exactly a PAY-02 Payment for its account — before touching its key', async () => {
    const transport = createHttpExternalXrplSignerTransport({ endpoint: endpointOf(reference.port), credential: SIGNER_TOKEN });
    const base: XrplPreparedPayment = { TransactionType: 'Payment', Account: TREASURY.classicAddress, Destination: VENDOR.classicAddress, Amount: { currency: CONFIGURATION.asset.currency, issuer: ISSUER.classicAddress, value: '1' }, Flags: 0, LastLedgerSequence: 1020, Sequence: 7, Fee: '12' };
    const before = reference.signatures();
    for (const transaction of [
      { ...base, TransactionType: 'OfferCreate' },
      { ...base, Flags: 131072 },
      { ...base, Memos: [] },
      { ...base, SendMax: '1' },
      { ...base, Amount: '1000000' },
      { ...base, Account: OTHER_SOURCE.classicAddress },
      { ...base, SigningPubKey: TREASURY.publicKey },
    ]) {
      await assert.rejects(transport.signPayment({ protocol: EXTERNAL_XRPL_SIGNER_PROTOCOL, signerId: SIGNER_ID, requestId: 'a'.repeat(64), account: TREASURY.classicAddress, transaction: transaction as never }, { timeoutMs: 2_000 }), (error: { reason?: string }) => error.reason === 'XRPL_SIGNER_REFUSED');
    }
    await assert.rejects(transport.signPayment({ protocol: EXTERNAL_XRPL_SIGNER_PROTOCOL, signerId: 'another-signer', requestId: 'a'.repeat(64), account: TREASURY.classicAddress, transaction: base }, { timeoutMs: 2_000 }), (error: { reason?: string }) => error.reason === 'XRPL_SIGNER_REFUSED');
    assert.equal(reference.signatures(), before, 'nothing signed');
    // No generic routes exist.
    for (const path of ['/v1/sign', '/v1/sign/bytes', '/v1/keys', '/v1/export']) {
      const reply = await fetch(`${endpointOf(reference.port)}${path}`, { method: 'POST', headers: { authorization: `Bearer ${SIGNER_TOKEN}` }, body: '{}' });
      assert.equal(reply.status, 404, path);
    }
    assert.equal((await fetch(`${endpointOf(reference.port)}/v1/identity`)).status, 401, 'unauthenticated callers learn nothing');
  });
});

describe('PAY-03 signer failure matrix (S1–S10): zero XRPL submissions unless a valid signed transaction was obtained', () => {
  it('S1: signer unavailable (nothing listening) → refused, nothing submitted', async () => {
    const dead = await faultServer(() => {});
    const endpoint = dead.endpoint;
    await dead.close();
    const { rail, ledger, signer, store } = await railWith(createHttpExternalXrplSignerTransport({ endpoint, credential: SIGNER_TOKEN }));
    refusedWithNothingSubmitted(await rail.execute(request()), ledger);
    assert.deepEqual([signer.status().state, signer.status().reason], ['unverified', 'XRPL_SIGNER_UNREACHABLE']);
    await store.close();
  });

  it('S2: signer identity mismatch (another signer id, another key, a missing account) → refused for the life of the process, no TOFU', async () => {
    for (const identity of [identityOf({ signerId: 'impostor' }), identityOf({ accounts: [{ address: TREASURY.classicAddress, signingPublicKey: OTHER_SOURCE.publicKey }] }), identityOf({ accounts: [{ address: OTHER_SOURCE.classicAddress, signingPublicKey: OTHER_SOURCE.publicKey }] })]) {
      const fault = await faultServer((req, res) => json(res, 200, identity));
      const { rail, ledger, signer, store } = await railWith(createHttpExternalXrplSignerTransport({ endpoint: fault.endpoint, credential: SIGNER_TOKEN }));
      refusedWithNothingSubmitted(await rail.execute(request()), ledger);
      assert.deepEqual([signer.status().state, signer.status().reason], ['mismatch', 'XRPL_SIGNER_IDENTITY_MISMATCH']);
      assert.equal(fault.requests.filter((body) => body !== undefined).length, 0, 'no signing request was ever sent to a mismatched signer');
      await Promise.all([fault.close(), store.close()]);
    }
  });

  it('S2: a signer that changes identity mid-process is refused from then on (rotation is configuration + restart)', async () => {
    let identity = identityOf();
    const fault = await faultServer(proxyThenMutate((answer) => answer));
    const swap = await faultServer((req, res, body) => (req.method === 'GET' ? json(res, 200, identity) : void fetch(`${fault.endpoint}/v1/sign/xrpl-payment`, { method: 'POST', headers: { authorization: `Bearer ${SIGNER_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => json(res, r.status, await r.json()))));
    const { rail, ledger, signer, store } = await railWith(createHttpExternalXrplSignerTransport({ endpoint: swap.endpoint, credential: SIGNER_TOKEN }));
    assert.equal((await rail.execute(request())).status, 'completed');
    identity = identityOf({ accounts: [{ address: TREASURY.classicAddress, signingPublicKey: OTHER_SOURCE.publicKey }] });
    await signer.probe();
    assert.equal(signer.status().state, 'mismatch');
    const submits = ledger.calls.submit;
    const refused = await rail.execute(request());
    assert.equal((refused as { detail?: string }).detail, D.SIGNING_FAILED);
    assert.equal(ledger.calls.submit, submits);
    await Promise.all([fault.close(), swap.close(), store.close()]);
  });

  it('S3: signer timeout → refused within the budget, nothing submitted — never an XRPL unconfirmed outcome', async () => {
    const hang = await faultServer((req, res) => (req.method === 'GET' ? json(res, 200, identityOf()) : undefined));
    const { rail, ledger, signer, store } = await railWith(createHttpExternalXrplSignerTransport({ endpoint: hang.endpoint, credential: SIGNER_TOKEN }), PIN, 300);
    const started = Date.now();
    refusedWithNothingSubmitted(await rail.execute(request()), ledger);
    assert.ok(Date.now() - started < 3_000, 'bounded by the signer timeout');
    assert.equal(signer.status().reason, 'XRPL_SIGNER_TIMEOUT');
    assert.equal(hang.requests.filter((body) => body !== undefined).length, 1, 'one attempt — no retry that could produce a second signature');
    await Promise.all([hang.close(), store.close()]);
  });

  it('S4: malformed responses (not JSON, extra field, missing field, wrong protocol, oversized) → refused, nothing submitted', async () => {
    const malformed: ((res: ServerResponse) => void)[] = [
      (res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('not json');
      },
      (res) => json(res, 200, { protocol: EXTERNAL_XRPL_SIGNER_PROTOCOL, signerId: SIGNER_ID }),
      (res) => json(res, 200, { protocol: 'frontera.external-xrpl-transaction-signer.v2', signerId: SIGNER_ID, requestId: 'a'.repeat(64), account: TREASURY.classicAddress, signedTransaction: 'AB'.repeat(40), hash: 'A'.repeat(64) }),
      (res) => json(res, 200, { padding: 'x'.repeat(70 * 1024) }),
      (res) => json(res, 302, {}),
    ];
    for (const answer of malformed) {
      const fault = await faultServer((req, res) => (req.method === 'GET' ? json(res, 200, identityOf()) : answer(res)));
      const { rail, ledger, store } = await railWith(createHttpExternalXrplSignerTransport({ endpoint: fault.endpoint, credential: SIGNER_TOKEN }));
      refusedWithNothingSubmitted(await rail.execute(request()), ledger);
      await Promise.all([fault.close(), store.close()]);
    }
    const extra = await faultServer(proxyThenMutate((answer) => ({ ...answer, note: 'extra' })));
    const { rail, ledger, store } = await railWith(createHttpExternalXrplSignerTransport({ endpoint: extra.endpoint, credential: SIGNER_TOKEN }));
    refusedWithNothingSubmitted(await rail.execute(request()), ledger);
    await Promise.all([extra.close(), store.close()]);
  });

  it('S5: a valid signature over a different transaction (destination, amount or memo changed) → refused by the rail, nothing submitted', async () => {
    // The real key signs a tampered copy (amount changed), and that valid signature is answered to the rail's request.
    const upstream = createHttpExternalXrplSignerTransport({ endpoint: endpointOf(reference.port), credential: SIGNER_TOKEN });
    const tampering = await faultServer((req, res, body) => {
      if (req.method === 'GET') return json(res, 200, identityOf());
      const parsed = parseExternalXrplSigningRequest(body)!;
      const other = { ...parsed, transaction: { ...parsed.transaction, Amount: { ...parsed.transaction.Amount, value: '9999' } } };
      void upstream.signPayment(other, { timeoutMs: 2_000 }).then((answer) => json(res, 200, answer));
    });
    const { rail, ledger, store } = await railWith(createHttpExternalXrplSignerTransport({ endpoint: tampering.endpoint, credential: SIGNER_TOKEN }));
    refusedWithNothingSubmitted(await rail.execute(request()), ledger, D.SIGNATURE_MISMATCH);
    await Promise.all([tampering.close(), store.close()]);
  });

  it('S6: the right blob with a wrong transaction hash → refused, nothing submitted', async () => {
    const fault = await faultServer(proxyThenMutate((answer) => ({ ...answer, hash: 'F'.repeat(64) })));
    const { rail, ledger, store } = await railWith(createHttpExternalXrplSignerTransport({ endpoint: fault.endpoint, credential: SIGNER_TOKEN }));
    refusedWithNothingSubmitted(await rail.execute(request()), ledger, D.SIGNATURE_MISMATCH);
    await Promise.all([fault.close(), store.close()]);
  });

  it('S7: an answer for another source account, signer id or request → refused, nothing submitted', async () => {
    for (const mutate of [(a: Record<string, unknown>) => ({ ...a, account: OTHER_SOURCE.classicAddress }), (a: Record<string, unknown>) => ({ ...a, signerId: 'another' }), (a: Record<string, unknown>) => ({ ...a, requestId: 'b'.repeat(64) })]) {
      const fault = await faultServer(proxyThenMutate(mutate));
      const { rail, ledger, signer, store } = await railWith(createHttpExternalXrplSignerTransport({ endpoint: fault.endpoint, credential: SIGNER_TOKEN }));
      refusedWithNothingSubmitted(await rail.execute(request()), ledger);
      assert.equal(signer.status().reason, 'XRPL_SIGNER_RESPONSE_MISMATCH');
      await Promise.all([fault.close(), store.close()]);
    }
  });

  it('S8: a signer that echoes a secret in an error body → refused; the secret reaches no error, status or outcome', async () => {
    const leaky = await faultServer((req, res) => (req.method === 'GET' ? json(res, 200, identityOf()) : json(res, 500, { error: `boom ${SEED_CANARY} ${SIGNER_TOKEN}` })));
    const { rail, ledger, signer, store } = await railWith(createHttpExternalXrplSignerTransport({ endpoint: leaky.endpoint, credential: SIGNER_TOKEN }));
    const outcome = await rail.execute(request());
    refusedWithNothingSubmitted(outcome, ledger);
    const surfaced = JSON.stringify([outcome, signer.status()]);
    for (const secret of [SEED_CANARY, SIGNER_TOKEN]) assert.equal(surfaced.includes(secret), false);
    // And the transport's own error never carries a body.
    const transport = createHttpExternalXrplSignerTransport({ endpoint: leaky.endpoint, credential: SIGNER_TOKEN });
    await assert.rejects(transport.signPayment(parseExternalXrplSigningRequest({ protocol: EXTERNAL_XRPL_SIGNER_PROTOCOL, signerId: SIGNER_ID, requestId: 'c'.repeat(64), account: TREASURY.classicAddress, transaction: { TransactionType: 'Payment', Account: TREASURY.classicAddress, Destination: VENDOR.classicAddress, Amount: { currency: 'USD', issuer: ISSUER.classicAddress, value: '1' }, Flags: 0, LastLedgerSequence: 9, Sequence: 1, Fee: '12' } })!, { timeoutMs: 2_000 }), (error: Error) => !error.message.includes(SEED_CANARY) && !error.message.includes(SIGNER_TOKEN) && !String(error.stack).includes(SEED_CANARY));
    await Promise.all([leaky.close(), store.close()]);
  });

  it('S9: the signer process restarts between payments — the next payment proceeds with the identity re-proven, nothing lost or duplicated', async () => {
    const restarting = await startReferenceXrplSigner({ signerId: SIGNER_ID, seed: SEED_CANARY, credential: SIGNER_TOKEN });
    const port = restarting.port;
    const { rail, ledger, store } = await railWith(createHttpExternalXrplSignerTransport({ endpoint: endpointOf(port), credential: SIGNER_TOKEN }));
    assert.equal((await rail.execute(request())).status, 'completed');
    await restarting.close();
    const whileDown = await rail.execute(request());
    assert.deepEqual([whileDown.status, (whileDown as { detail?: string }).detail], ['not-completed', D.SIGNING_FAILED]);
    assert.equal(ledger.calls.submit, 1, 'nothing submitted while the signer was down');
    const again = await startReferenceXrplSigner({ signerId: SIGNER_ID, seed: SEED_CANARY, credential: SIGNER_TOKEN, port });
    assert.equal((await rail.execute(request())).status, 'completed');
    assert.equal(ledger.calls.submit, 2);
    await Promise.all([again.close(), store.close()]);
  });

  it('S10: duplicate signing requests produce no second submission: one execution, one signature, one submit — and a repeated execution signs nothing', async () => {
    const { rail, ledger, store } = await railWith(createHttpExternalXrplSignerTransport({ endpoint: endpointOf(reference.port), credential: SIGNER_TOKEN }));
    const req = request();
    const before = reference.signatures();
    assert.equal((await rail.execute(req)).status, 'completed');
    const again = await rail.execute(req);
    assert.equal(again.status, 'unconfirmed', 'the durable interlock already holds this execution');
    assert.equal(reference.signatures() - before, 1, 'the repeated execution never reached the signer');
    assert.equal(ledger.calls.submit, 1);
    await store.close();
  });
});

describe('PAY-03 signer transport and pin configuration', () => {
  it('refuses a non-loopback http endpoint, credentials in the URL, a path, and a short or whitespace credential — naming the rule, never the value', () => {
    for (const endpoint of ['http://signer.example.com', 'https://user:pw@signer.example.com', 'https://signer.example.com/v1', 'ftp://signer.example.com']) {
      assert.throws(() => createHttpExternalXrplSignerTransport({ endpoint, credential: SIGNER_TOKEN }), (error: Error) => error instanceof ExternalXrplSignerConfigurationError && !error.message.includes('pw'));
    }
    for (const credential of ['short', `${'x'.repeat(40)} y`]) {
      assert.throws(() => createHttpExternalXrplSignerTransport({ endpoint: 'https://signer.example.com', credential }), (error: Error) => error instanceof ExternalXrplSignerConfigurationError && !error.message.includes(credential));
    }
  });

  it('refuses a malformed pin: no signer id, no account, a non-classic address, a malformed public key, a duplicated account', () => {
    const transport = createHttpExternalXrplSignerTransport({ endpoint: 'https://signer.example.com', credential: SIGNER_TOKEN });
    for (const pin of [
      { signerId: '', accounts: PIN.accounts },
      { signerId: SIGNER_ID, accounts: [] },
      { signerId: SIGNER_ID, accounts: [{ address: 'not-an-address', signingPublicKey: TREASURY.publicKey }] },
      { signerId: SIGNER_ID, accounts: [{ address: TREASURY.classicAddress, signingPublicKey: TREASURY.publicKey.toLowerCase() }] },
      { signerId: SIGNER_ID, accounts: [PIN.accounts[0]!, PIN.accounts[0]!] },
    ]) {
      assert.throws(() => createExternalXrplSigner({ transport, pin: pin as ExternalXrplSignerPin, timeoutMs: 1_000 }), ExternalXrplSignerConfigurationError);
    }
  });

  it('the credential travels only in the authorization header — never in a signing request body', async () => {
    const seen: { auth: string | undefined; body: unknown }[] = [];
    const recorder = await faultServer((req, res, body) => {
      seen.push({ auth: req.headers.authorization, body });
      if (req.method === 'GET') json(res, 200, identityOf());
      else json(res, 500, {});
    });
    const { rail, store } = await railWith(createHttpExternalXrplSignerTransport({ endpoint: recorder.endpoint, credential: SIGNER_TOKEN }));
    await rail.execute(request());
    assert.ok(seen.every((entry) => entry.auth === `Bearer ${SIGNER_TOKEN}`));
    assert.ok(seen.every((entry) => !JSON.stringify(entry.body ?? null).includes(SIGNER_TOKEN)));
    const signing = seen.find((entry) => entry.body !== undefined)!.body as Record<string, unknown>;
    assert.deepEqual(Object.keys(signing).sort(), ['account', 'protocol', 'requestId', 'signerId', 'transaction']);
    await Promise.all([recorder.close(), store.close()]);
  });
});
