import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createFinancialActionClassifier, createMonetaryAssetRegistry } from '../../features/monetary-runtime/index.js';
import { PAYMENT_PARAMETER_DIMENSIONS, PAYMENT_PROFILE_PARAMETERS, compilePaymentIntent, createPaymentGovernanceBinding, createPaymentRailExecutionAdapter, validatePaymentIntent, type PaymentIntent } from '../../features/payment-runtime/index.js';
import {
  LightningSendNotAttemptedError,
  createLightningInvoiceBook,
  createLightningRail,
  decodeBolt11Invoice,
  lightningDestinationOf,
  readLightningPaymentObservation,
  readOnlyLightningNode,
  type LightningPaymentInstruction,
} from '../../features/payment-runtime/rails/lightning/index.js';
import { BTC_ASSET, TEST_NOW_MS, btc, buildInvoice, testNodeKey, testPreimage, testRailConfiguration } from '../../features/payment-runtime/rails/lightning/tests/lightning-test-fixtures.js';
import { createInMemoryExecutionResolutionStore } from '../execution-resolution-store/in-memory-execution-resolution-store.js';
import { createGovernanceProfileRegistry } from '../governance-profile/index.js';
import { LIGHTNING_FINALITY_AUTHORITY_ID, createLightningFinalityAuthority } from '../lightning-payment-rail/lightning-finality-authority.js';
import { LndRestConfigurationError, LndRestNodeError, createLndRestLightningNode, createLndRestLightningNodeReader } from '../lightning-payment-rail/lnd-rest-node.js';
import { createSqliteLightningPaymentInterlock } from '../lightning-payment-rail/sqlite-lightning-payment-interlock.js';
import { createInMemoryPaymentSettlementStore, createPaymentSettlementService } from '../payment-settlement/index.js';
import { ALLOWED_INTENT, IDENTITY, NOW, ORG, buildGovernedWorld, monetaryAuthority } from './governed-action-support.js';
import { boundaryFor, closeAllWitnesses, startWitness } from './core07-freshness-fixture.js';

/**
 * PAY-06 — the reference node adapter (LND REST) against a fake LND on
 * loopback: the exact requests it makes, how every answer maps to a neutral
 * observation, what "never sent" means on the wire, and that the macaroon —
 * a secret-shaped canary — never leaves the adapter's closure: not into an
 * error, a result, P11, a reservation, a settlement, a receipt, health or a log.
 */

const MACAROON = `0201036c6e6402f801${'c0ffee5ec2e7'.repeat(12)}`;
const READ_MACAROON = `0201036c6e6402f802${'deadbeef0bad'.repeat(12)}`;
const made: string[] = [];
after(async () => {
  await closeAllWitnesses();
  for (const directory of made) rmSync(directory, { recursive: true, force: true });
});

type Route = (request: IncomingMessage, body: string, response: ServerResponse) => void | Promise<void>;

interface FakeLnd {
  readonly endpoint: string;
  readonly requests: { method: string; path: string; macaroon: string | undefined; body: string }[];
  routes: Record<string, Route>;
  close(): Promise<void>;
}

async function fakeLnd(routes: Record<string, Route> = {}): Promise<FakeLnd> {
  const requests: FakeLnd['requests'] = [];
  const fake: FakeLnd = { endpoint: '', requests, routes, close: async () => undefined };
  const server: Server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => (body += chunk));
    request.on('end', () => {
      const path = (request.url ?? '').split('?')[0] ?? '';
      const macaroon = request.headers['grpc-metadata-macaroon'];
      requests.push({ method: request.method ?? '', path, macaroon: typeof macaroon === 'string' ? macaroon : undefined, body });
      if (macaroon !== MACAROON && macaroon !== READ_MACAROON) {
        response.writeHead(401).end('{"code":16,"message":"verification failed: signature mismatch"}');
        return;
      }
      const key = Object.keys(fake.routes).find((prefix) => `${request.method} ${path}`.startsWith(prefix));
      if (key === undefined) {
        response.writeHead(404).end('{"code":12,"message":"Not Found"}');
        return;
      }
      void Promise.resolve(fake.routes[key]!(request, body, response)).catch(() => response.destroy());
    });
  });
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  (fake as { endpoint: string }).endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  fake.close = () => new Promise((resolveClose) => server.close(() => resolveClose()));
  server.unref();
  return fake;
}

const json = (response: ServerResponse, value: unknown, status = 200): void => {
  response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value));
};
const stream = (response: ServerResponse, lines: readonly unknown[]): void => {
  response.writeHead(200, { 'content-type': 'application/json' });
  for (const line of lines) response.write(`${JSON.stringify(line)}\n`);
  response.end();
};

const HASH = testPreimage('lnd').paymentHash;
const PREIMAGE = testPreimage('lnd').preimage;
const succeeded = (overrides: Record<string, unknown> = {}) => ({ payment_hash: HASH, status: 'SUCCEEDED', payment_preimage: PREIMAGE, value_msat: '2500000', fee_msat: '1000', failure_reason: 'FAILURE_REASON_NONE', ...overrides });
const instruction = (overrides: Partial<LightningPaymentInstruction> = {}): LightningPaymentInstruction => ({ invoice: 'lnbcrt1test', paymentHash: HASH, amountMsat: 2_500_000n, feeLimitMsat: 25_000n, timeoutSeconds: 30, deadlineMs: 2_000, ...overrides });

function noSecret(value: unknown, label: string): void {
  const text = value instanceof Error ? `${value.message}\n${value.stack ?? ''}\n${JSON.stringify(value)}` : JSON.stringify(value, (_key, item: unknown) => (typeof item === 'bigint' ? item.toString() : item));
  assert.equal(text.includes(MACAROON), false, `${label} leaked the macaroon`);
  assert.equal(text.includes(MACAROON.slice(20, 44)), false, `${label} leaked part of the macaroon`);
  assert.equal(text.includes(READ_MACAROON), false, `${label} leaked the read macaroon`);
}

describe('PAY-06 LND REST adapter — requests and mapping', () => {
  it('nodeInfo, decodeInvoice and paymentStatus read the node and map to neutral facts', async () => {
    const identity = await testNodeKey('lnd-payer');
    const invoice = await buildInvoice({ amountMsat: 2_500_000n, paymentHash: HASH, payeeKeyLabel: 'payee-node' });
    const decoded = await decodeBolt11Invoice(invoice);
    assert.ok(decoded.valid);
    const lnd = await fakeLnd({
      'GET /v1/getinfo': (_request, _body, response) => json(response, { identity_pubkey: identity, chains: [{ chain: 'bitcoin', network: 'regtest' }], synced_to_chain: true, version: '0.19.2-beta' }),
      'GET /v1/payreq/': (_request, _body, response) => json(response, { destination: decoded.valid ? decoded.invoice.payee : '', payment_hash: HASH, num_satoshis: '2500', num_msat: '2500000', description: 'ignored', route_hints: [] }),
      'GET /v2/router/track/': (_request, _body, response) => stream(response, [{ result: succeeded({ htlcs: [{ attempt_id: '2' }, { attempt_id: '1' }], creation_time_ns: '1' }) }]),
    });
    const node = createLndRestLightningNode({ endpoint: lnd.endpoint, macaroonHex: MACAROON });
    assert.deepEqual(await node.nodeInfo(2_000), { network: 'regtest', identity });
    assert.deepEqual(await node.decodeInvoice(invoice, 2_000), { payee: decoded.valid ? decoded.invoice.payee : '', paymentHash: HASH, amountMsat: 2_500_000n });
    const status = readLightningPaymentObservation(await node.paymentStatus(HASH, 2_000));
    assert.deepEqual(status, { state: 'succeeded', paymentHash: HASH, preimage: PREIMAGE, amountMsat: 2_500_000n, feeMsat: 1_000n });
    const track = lnd.requests.find((request) => request.path.startsWith('/v2/router/track/'));
    assert.equal(track?.path, `/v2/router/track/${Buffer.from(HASH, 'hex').toString('base64').replace(/\+/g, '-').replace(/\//g, '_')}`, 'the hash travels URL-safe base64, padded (as LND requires), in the path');
    assert.ok(track?.path.endsWith('='), 'padded');
    assert.ok(lnd.requests.every((request) => request.macaroon === MACAROON), 'the macaroon header on every call');
    await lnd.close();
  });

  it('status: in flight / initiated / failed reasons map closed; NOT_FOUND (streamed or plain) is not-found; any other error is unknown (throws)', async () => {
    let answer: (response: ServerResponse) => void = () => undefined;
    const lnd = await fakeLnd({ 'GET /v2/router/track/': (_request, _body, response) => answer(response) });
    const reader = createLndRestLightningNodeReader({ endpoint: lnd.endpoint, macaroonHex: READ_MACAROON });
    const read = async (): Promise<unknown> => readLightningPaymentObservation(await reader.paymentStatus(HASH, 2_000));
    answer = (response) => stream(response, [{ result: { payment_hash: HASH, status: 'IN_FLIGHT' } }]);
    assert.deepEqual(await read(), { state: 'in-flight', paymentHash: HASH });
    answer = (response) => stream(response, [{ result: { payment_hash: HASH, status: 'INITIATED' } }]);
    assert.deepEqual(await read(), { state: 'in-flight', paymentHash: HASH });
    for (const [reason, failure] of [
      ['FAILURE_REASON_NO_ROUTE', 'no-route'],
      ['FAILURE_REASON_TIMEOUT', 'timeout'],
      ['FAILURE_REASON_INCORRECT_PAYMENT_DETAILS', 'incorrect-payment-details'],
      ['FAILURE_REASON_INSUFFICIENT_BALANCE', 'insufficient-balance'],
      ['FAILURE_REASON_CANCELED', 'canceled'],
      ['FAILURE_REASON_ERROR', 'error'],
      ['SOMETHING_NEW', 'error'],
    ] as const) {
      answer = (response) => stream(response, [{ result: { payment_hash: HASH, status: 'FAILED', failure_reason: reason } }]);
      assert.deepEqual(await read(), { state: 'failed', paymentHash: HASH, failure }, reason);
    }
    answer = (response) => stream(response, [{ error: { code: 5, message: "payment isn't initiated", details: [] } }]);
    assert.deepEqual(await read(), { state: 'not-found' });
    answer = (response) => json(response, { code: 5, message: "payment isn't initiated" }, 404);
    assert.deepEqual(await read(), { state: 'not-found' });
    answer = (response) => stream(response, [{ error: { code: 2, message: 'something internal' } }]);
    await assert.rejects(reader.paymentStatus(HASH, 2_000), LndRestNodeError);
    answer = (response) => stream(response, [{ result: { payment_hash: HASH, status: 'UNKNOWN' } }]);
    assert.equal(await read(), undefined, 'an unknown status is unreadable — unknown, never a verdict');
    answer = (response) => stream(response, [{ result: succeeded({ value_msat: 2500000 }) }]);
    assert.equal(await read(), undefined, 'a JSON number is never money');
    await lnd.close();
  });

  it('sendPayment: exactly the documented request — the invoice, the trusted fee cap as an exact string, the timeout, no self-payment, no AMP — and the terminal answer', async () => {
    let lines: readonly unknown[] = [{ result: succeeded() }];
    const lnd = await fakeLnd({ 'POST /v2/router/send': (_request, _body, response) => stream(response, lines) });
    const node = createLndRestLightningNode({ endpoint: lnd.endpoint, macaroonHex: MACAROON });
    assert.deepEqual(readLightningPaymentObservation(await node.sendPayment(instruction())), { state: 'succeeded', paymentHash: HASH, preimage: PREIMAGE, amountMsat: 2_500_000n, feeMsat: 1_000n });
    assert.deepEqual(JSON.parse(lnd.requests[0]!.body), { payment_request: 'lnbcrt1test', fee_limit_msat: '25000', timeout_seconds: 30, no_inflight_updates: true, allow_self_payment: false, amp: false });
    lines = [{ result: { payment_hash: HASH, status: 'IN_FLIGHT' } }, { result: { payment_hash: HASH, status: 'FAILED', failure_reason: 'FAILURE_REASON_NO_ROUTE' } }];
    assert.deepEqual(readLightningPaymentObservation(await node.sendPayment(instruction())), { state: 'failed', paymentHash: HASH, failure: 'no-route' });
    lines = [{ result: { payment_hash: HASH, status: 'IN_FLIGHT' } }];
    assert.deepEqual(readLightningPaymentObservation(await node.sendPayment(instruction())), { state: 'in-flight', paymentHash: HASH }, 'a stream that ends in flight is in flight');
    lines = [{ error: { code: 6, message: 'invoice is already paid' } }];
    await assert.rejects(node.sendPayment(instruction()), (error: unknown) => error instanceof LndRestNodeError && !(error instanceof LightningSendNotAttemptedError), 'an error after the request reached the node is unknown');
    assert.equal(lnd.requests.length, 4, 'one request per send — no retry');
    await lnd.close();
  });

  it('never sent vs unknown: a refused connection is "not attempted"; a disconnect after the node read the request, or a deadline, is unknown', async () => {
    // A port with nothing listening.
    const closed = await fakeLnd();
    const endpoint = closed.endpoint;
    await closed.close();
    await assert.rejects(createLndRestLightningNode({ endpoint, macaroonHex: MACAROON }).sendPayment(instruction()), LightningSendNotAttemptedError);

    const lnd = await fakeLnd({
      'POST /v2/router/send': (request) => {
        // The node read the whole request (it may have started routing), then the connection dropped.
        request.socket.destroy();
      },
    });
    const node = createLndRestLightningNode({ endpoint: lnd.endpoint, macaroonHex: MACAROON });
    await assert.rejects(node.sendPayment(instruction()), (error: unknown) => error instanceof LndRestNodeError && !(error instanceof LightningSendNotAttemptedError));
    lnd.routes = { 'POST /v2/router/send': () => undefined };
    const started = Date.now();
    await assert.rejects(node.sendPayment(instruction({ deadlineMs: 300 })), (error: unknown) => error instanceof LndRestNodeError && error.reason === 'LND_TIMEOUT');
    assert.ok(Date.now() - started < 3_000);
    await lnd.close();
  });

  it('deterministic: answers differing only in HTLC order, timestamps and optional fields yield the identical observation', async () => {
    let variant = 0;
    const lnd = await fakeLnd({
      'GET /v2/router/track/': (_request, _body, response) =>
        stream(response, [{ result: variant === 0 ? succeeded({ htlcs: [{ attempt_id: '1', resolve_time_ns: '5' }, { attempt_id: '2' }], creation_time_ns: '100', payment_index: '7' }) : succeeded({ htlcs: [{ attempt_id: '2' }, { attempt_id: '1', resolve_time_ns: '9' }], creation_time_ns: '999', value_sat: '2500', fee_sat: '1', payment_request: 'lnbcrt1other' }) }]),
    });
    const reader = createLndRestLightningNodeReader({ endpoint: lnd.endpoint, macaroonHex: READ_MACAROON });
    const first = await reader.paymentStatus(HASH, 2_000);
    variant = 1;
    const second = await reader.paymentStatus(HASH, 2_000);
    assert.deepEqual(first, second);
    await lnd.close();
  });
});

describe('PAY-06 LND REST adapter — credential boundary', () => {
  it('endpoint and credential configuration fail closed', () => {
    assert.throws(() => createLndRestLightningNode({ endpoint: 'https://lnd.example:8080', macaroonHex: MACAROON }), LndRestConfigurationError, 'https needs the pinned certificate');
    assert.throws(() => createLndRestLightningNode({ endpoint: 'http://lnd.example:8080', macaroonHex: MACAROON }), /loopback/);
    assert.throws(() => createLndRestLightningNode({ endpoint: 'http://user:pass@127.0.0.1:8080', macaroonHex: MACAROON }), /credentials/);
    assert.throws(() => createLndRestLightningNode({ endpoint: 'http://127.0.0.1:8080/v1', macaroonHex: MACAROON }), /bare origin/);
    assert.throws(() => createLndRestLightningNode({ endpoint: 'http://127.0.0.1:8080', macaroonHex: 'not-hex' }), /hex/);
    assert.throws(() => createLndRestLightningNode({ endpoint: 'https://127.0.0.1:8080', tlsCertificatePem: '-----BEGIN PRIVATE KEY-----', macaroonHex: MACAROON }), LndRestConfigurationError);
    try {
      createLndRestLightningNode({ endpoint: 'ftp://127.0.0.1', macaroonHex: MACAROON });
      assert.fail('refused');
    } catch (error) {
      noSecret(error, 'a configuration error');
    }
  });

  it('the macaroon never appears on a returned object, in an error, or in a refusal the node echoed', async () => {
    const lnd = await fakeLnd({
      'GET /v1/getinfo': (_request, _body, response) => json(response, { code: 2, message: `echo ${MACAROON}` }, 500),
      'POST /v2/router/send': (_request, _body, response) => stream(response, [{ error: { code: 2, message: `bad macaroon ${MACAROON}` } }]),
    });
    const node = createLndRestLightningNode({ endpoint: lnd.endpoint, macaroonHex: MACAROON });
    noSecret(node, 'the node port');
    assert.deepEqual(Object.keys(node).sort(), ['decodeInvoice', 'nodeInfo', 'paymentStatus', 'sendPayment']);
    for (const call of [() => node.nodeInfo(2_000), () => node.sendPayment(instruction())]) {
      try {
        await call();
        assert.fail('refused');
      } catch (error) {
        noSecret(error, 'a node error');
      }
    }
    const wrong = createLndRestLightningNode({ endpoint: lnd.endpoint, macaroonHex: 'ab'.repeat(32) });
    await assert.rejects(wrong.nodeInfo(2_000), (error: unknown) => error instanceof LndRestNodeError && error.reason === 'LND_AUTHENTICATION_FAILED');
    await lnd.close();
  });

  it('the reader has no send capability at all — not even through readOnlyLightningNode over a full node', async () => {
    const reader = createLndRestLightningNodeReader({ endpoint: 'http://127.0.0.1:9', macaroonHex: READ_MACAROON });
    assert.deepEqual(Object.keys(reader).sort(), ['decodeInvoice', 'nodeInfo', 'paymentStatus']);
    assert.equal('sendPayment' in reader, false);
    const wrapped = readOnlyLightningNode(createLndRestLightningNode({ endpoint: 'http://127.0.0.1:9', macaroonHex: MACAROON }));
    assert.equal('sendPayment' in wrapped, false);
    assert.ok(Object.isFrozen(wrapped));
  });

  it('a governed payment through the real adapter: the macaroon reaches no P11 record, reservation, settlement, receipt, health, log or interlock byte', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'frontera-pay06-lnd-'));
    made.push(directory);
    const payee = await testNodeKey('payee-node');
    const identity = await testNodeKey('lnd-payer');
    const preimage = testPreimage('lnd-governed');
    const invoice = await buildInvoice({ amountMsat: 2_500_000n, paymentHash: preimage.paymentHash, payeeKeyLabel: 'payee-node' });
    let paid = false;
    const settledPayment = { payment_hash: preimage.paymentHash, status: 'SUCCEEDED', payment_preimage: preimage.preimage, value_msat: '2500000', fee_msat: '1000', htlcs: [{ route: { hops: [{ chan_id: '123x1x0', pub_key: payee }] } }] };
    const lnd = await fakeLnd({
      'GET /v1/getinfo': (_request, _body, response) => json(response, { identity_pubkey: identity, chains: [{ chain: 'bitcoin', network: 'regtest' }] }),
      'GET /v1/payreq/': (_request, _body, response) => json(response, { destination: payee, payment_hash: preimage.paymentHash, num_msat: '2500000' }),
      'POST /v2/router/send': (_request, _body, response) => {
        paid = true;
        stream(response, [{ result: settledPayment }]);
      },
      'GET /v2/router/track/': (_request, _body, response) => stream(response, paid ? [{ result: settledPayment }] : [{ error: { code: 5, message: 'not found' } }]),
    });
    const ACTION = ALLOWED_INTENT.action;
    const ACCOUNT = ALLOWED_INTENT.resource;
    const binding = createPaymentGovernanceBinding({ action: ACTION });
    const assets = createMonetaryAssetRegistry([{ assetId: 'USD', scale: 2 }, { assetId: BTC_ASSET, scale: 11 }]);
    const configuration = testRailConfiguration({ sourceAccounts: [ACCOUNT] });
    const witness = await startWitness();
    const interlockPath = join(directory, 'interlock.sqlite');
    const interlock = await createSqliteLightningPaymentInterlock(interlockPath, { scope: { railId: configuration.railId, network: configuration.network }, now: () => new Date().toISOString(), freshness: { boundary: await boundaryFor(witness, ORG) } });
    const book = createLightningInvoiceBook();
    book.register(preimage.paymentHash, invoice);
    const logs: unknown[] = [];
    const rail = createLightningRail({ configuration, node: createLndRestLightningNode({ endpoint: lnd.endpoint, macaroonHex: MACAROON }), invoices: book, interlock, now: () => TEST_NOW_MS, logger: { info: (...entry) => logs.push(entry), warn: (...entry) => logs.push(entry) } });
    const governance = createGovernanceProfileRegistry({
      parameterDimensions: PAYMENT_PARAMETER_DIMENSIONS,
      actionClasses: [{ id: 'payment', actions: [ACTION] }],
      resourceClasses: [{ id: 'governed-account', resources: [ACCOUNT] }],
      profiles: [{ profileId: 'governed-payment', version: 1, owner: ORG, provenance: { authoredBy: 'operator:treasury', approvedBy: 'operator:security' }, actionClass: 'payment', resourceClass: 'governed-account', parameters: PAYMENT_PROFILE_PARAMETERS, materialFacts: [], relevantPolicies: [] }],
    });
    const world = buildGovernedWorld({
      monetary: { assets, actionClassifier: createFinancialActionClassifier({ financialActions: [ACTION] }) },
      governance,
      financialAuthority: monetaryAuthority('1', '100', BTC_ASSET),
      executionAdapter: createPaymentRailExecutionAdapter({ rail, binding }),
    });
    const validation = validatePaymentIntent({ source: { accountId: ACCOUNT }, destination: lightningDestinationOf(payee, preimage.paymentHash), amount: { value: btc(2_500_000n), unit: BTC_ASSET }, purpose: 'vendor-payment', rail: 'lightning-btc', idempotencyKey: 'ln-lnd-governed' }, { assets });
    assert.equal(validation.valid, true);
    const result = await world.orchestrator.govern(IDENTITY, compilePaymentIntent((validation as { intent: PaymentIntent }).intent, binding, { assertedContext: ALLOWED_INTENT.assertedContext }));
    assert.equal(result.status, 'executed', JSON.stringify(result));
    const reader = createLndRestLightningNodeReader({ endpoint: lnd.endpoint, macaroonHex: READ_MACAROON });
    const service = createPaymentSettlementService({
      outcomes: world.outcomes,
      resolutions: createInMemoryExecutionResolutionStore({ now: () => NOW }),
      governance: world.rawStore,
      payments: [binding],
      store: createInMemoryPaymentSettlementStore({ now: () => NOW }),
      authorities: [createLightningFinalityAuthority({ configuration, node: reader, interlock })],
      selectAuthority: () => LIGHTNING_FINALITY_AUTHORITY_ID,
      now: () => NOW,
    });
    const settled = await service.verifySettlement({ organizationId: ORG, executionId: result.executionId! });
    assert.equal(settled.outcome, 'settled', JSON.stringify(settled));
    const sends = lnd.requests.filter((request) => request.path === '/v2/router/send');
    assert.equal(sends.length, 1);
    assert.ok(lnd.requests.filter((request) => request.path.startsWith('/v2/router/track/')).every((request) => request.macaroon === READ_MACAROON), 'the finality authority read with the read-only macaroon');
    noSecret(await world.outcomes.read({ organizationId: ORG }, result.executionId!), 'P11');
    noSecret(await interlock.read(result.executionId!), 'the reservation');
    noSecret(settled, 'the settlement and receipt');
    noSecret(await interlock.health(), 'health');
    noSecret(await rail.readiness(), 'readiness');
    noSecret(logs, 'the logs');
    noSecret(result, 'the governed result');
    await interlock.close();
    for (const file of readdirSync(directory)) {
      const bytes = readFileSync(join(directory, file)).toString('latin1');
      assert.equal(bytes.includes(MACAROON), false, `${file} holds the macaroon`);
      assert.equal(bytes.includes(preimage.preimage), false, `${file} holds the preimage`);
      assert.equal(bytes.includes('123x1x0'), false, `${file} holds route detail`);
    }
    assert.equal(JSON.stringify(settled).includes('123x1x0'), false, 'no route detail in settlement evidence');
    await lnd.close();
  });
});
