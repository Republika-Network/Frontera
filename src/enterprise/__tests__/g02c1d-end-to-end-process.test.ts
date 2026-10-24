import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { rmSync } from 'node:fs';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { GENERIC_HTTP_PRESENTATION_HEADER, GENERIC_HTTP_RECEIPT_HEADER } from '../execution-adapters/generic-http/governed-headers.js';
import { buildNodeRequestOptions, sendOnce } from '../execution-adapters/generic-http/node-https-transport.js';
import type { GenericHttpWireRequest } from '../execution-adapters/generic-http/request-mapper.js';
import { decodeExecutorReceiptTransport } from '../executor-receipt/index.js';
import { addHeaderLines, headerValue, parseRaw, rawExchange, serializeRaw, type SpawnedExecutor } from './g02c1a-reference-executor-fixture.js';
import {
  E2E_AUDIENCE,
  UNKNOWN,
  deliverableReceipt,
  e2eTrustedExecutor,
  executionIdOf,
  executorDomain,
  hostWorld,
  loopbackHostPrimitive,
  presentedCapability,
  privateDirectory,
  receiptAbout,
  spawnE2EExecutor,
  startRelay,
  type ExecutorDomain,
  type HostWorld,
  type HostWorldOptions,
} from './g02c1d-end-to-end-fixture.js';

/**
 * G-02C1D, end to end across a process boundary.
 *
 * Host side, this process: the real G-02B issuer and issuance ledger, the real
 * G-02C0 gate, the real Generic HTTP adapter core and transport (`sendOnce`,
 * the exact options and bytes), the real receipt evidence recorder and store.
 * Executor side, its own process: the reference executor in synthetic-execution
 * mode with receipts, pinned to this Host's issuer key, holding its own receipt
 * key (made by a third process). Loopback HTTP/1.1 only: no TLS, public DNS,
 * address-policy decision over a real answer, or proxy is qualified here.
 */

const SUITE_TIMEOUT_MS = 300_000;
const cleanups: (() => void | Promise<void>)[] = [];
after(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function domainOf(audience?: string): Promise<ExecutorDomain> {
  const domain = await executorDomain(audience);
  cleanups.push(() => domain.cleanup());
  return domain;
}

async function executorOf(domain: ExecutorDomain, options: Parameters<typeof spawnE2EExecutor>[1] = {}): Promise<SpawnedExecutor> {
  const executor = await spawnE2EExecutor(domain, options);
  cleanups.push(() => executor.kill());
  return executor;
}

async function hostOf(options: HostWorldOptions): Promise<HostWorld> {
  const world = await hostWorld(options);
  cleanups.push(() => world.close());
  return world;
}

/** One governed execution of a fresh grant through `world`, and what each side then holds. */
async function governed(world: HostWorld, domain?: ExecutorDomain) {
  const signed = await world.grant();
  const action = world.actionFor(signed);
  const result = await world.execute(action);
  const executionId = executionIdOf(signed);
  const issued = world.issuance.read(executionId);
  const capabilityId = issued.state === 'absent' ? undefined : issued.capabilityId;
  return {
    signed,
    action,
    result,
    executionId,
    capabilityId,
    observations: world.evidence.observationsFor(executionId),
    evidence: world.evidence.evidenceFor(executionId),
    consumption: domain === undefined || capabilityId === undefined ? undefined : (await domain.state(capabilityId)).state,
    receipts: domain === undefined || capabilityId === undefined ? [] : await domain.receipts(capabilityId),
  };
}

const dispositions = (observations: readonly { readonly disposition: string; readonly failure: string | null }[]) => observations.map((observation) => [observation.disposition, observation.failure]);

describe('G-02C1D process — the whole reference path, Host to executor and back', { timeout: SUITE_TIMEOUT_MS }, () => {
  it('one presented capability → one verified consumption → one synthetic effect → the persisted signed receipt delivered → verified, correlated, recorded', async () => {
    const domain = await domainOf();
    const executor = await executorOf(domain);
    const world = await hostOf({ target: { port: executor.port }, trustedExecutors: [e2eTrustedExecutor(domain.publicKeyPem)] });
    const run = await governed(world, domain);

    assert.equal(run.result.outcome, 'completed', JSON.stringify(run.result));
    assert.equal(world.sent.length, 1, 'one send');
    assert.equal(world.sent[0]?.headers.filter(([name]) => name === GENERIC_HTTP_PRESENTATION_HEADER).length, 1, 'one presentation header');
    assert.equal(presentedCapability(world.sent[0] as GenericHttpWireRequest).capabilityId, run.capabilityId, 'presenting exactly the issued capability');
    assert.equal(run.consumption, 'completed', 'consumed once, durably');
    assert.equal(domain.records().length, 1, 'one synthetic effect');

    await executor.waitForAssessments(1);
    const execution = executor.assessments[0] as unknown as { readonly outcome: string; readonly bindingDigest: string | null };
    assert.equal(execution.outcome, 'completed-observed');
    const issued = world.issuance.read(run.executionId);
    assert.ok(issued.state === 'issued');
    assert.equal(execution.bindingDigest, issued.capability.actionBinding.digest, 'the executor rebuilt, from the bytes it received, the binding the Host issued');

    assert.deepEqual(dispositions(run.observations), [['receipt-correlated', null]]);
    assert.deepEqual([run.observations[0]?.agreement, run.observations[0]?.httpStatus, run.observations[0]?.receiptOutcome], ['consistent', 201, 'completed-observed']);
    assert.equal(run.receipts.length, 1);
    assert.equal(run.evidence.length, 1);
    assert.equal(run.evidence[0]?.presented.receipt, run.receipts[0]?.receipt, 'the Host holds the executor’s persisted receipt text, byte for byte');
    assert.deepEqual({ ...run.evidence[0]?.presented.signature }, { ...run.receipts[0]?.signature }, 'and its signature');
    assert.equal(executor.stdout().includes(run.receipts[0]?.receipt.slice(0, 40) ?? '-'), false, 'the receipt text is never on the executor’s diagnostic stream');
  });

  it('the same capability presented again is consumed only once: the executor performs nothing and replays its persisted receipt; the Host records it idempotently', async () => {
    const domain = await domainOf();
    const executor = await executorOf(domain);
    const world = await hostOf({ target: { port: executor.port }, trustedExecutors: [e2eTrustedExecutor(domain.publicKeyPem)] });
    const run = await governed(world, domain);
    assert.equal(run.result.outcome, 'completed');

    assert.equal((await world.execute(run.action)).outcome, 'failed', 'the Host itself never presents an execution twice: the gate withholds');
    assert.equal(world.sent.length, 1);

    const replayed = await sendOnce(loopbackHostPrimitive({ port: executor.port }), world.sent[0] as GenericHttpWireRequest, { address: '127.0.0.1', family: 4 }, 5_000, undefined);
    assert.ok(replayed.kind === 'response');
    assert.equal(replayed.status, 202, 'already consumed: unconfirmed to the Host, never a second success');
    assert.equal(domain.records().length, 1, 'one effect, ever');
    const delivered = decodeExecutorReceiptTransport(replayed.receiptValues ?? []);
    assert.ok(delivered.ok);
    assert.equal(delivered.presented.receipt, run.receipts[0]?.receipt, 'the persisted receipt, not a new one');

    await world.recorder.observe({ ...(world.exchanges[0] as NonNullable<(typeof world.exchanges)[number]>), receiptValues: replayed.receiptValues ?? [] });
    assert.equal(world.evidence.evidenceFor(run.executionId).length, 1, 'idempotent');
  });

  it('a capability for another audience is refused by the executor: nothing consumed, nothing performed, no receipt — recorded as missing', async () => {
    const domain = await domainOf('executor-elsewhere');
    const executor = await executorOf(domain, { audience: 'executor-elsewhere' });
    const world = await hostOf({ target: { port: executor.port }, trustedExecutors: [e2eTrustedExecutor(domain.publicKeyPem, { audiences: ['executor-elsewhere', E2E_AUDIENCE] })] });
    const run = await governed(world);
    assert.equal(run.result.outcome, 'failed');
    assert.equal(run.result.outcome === 'failed' ? run.result.reason : undefined, 'PROVIDER_REJECTED');
    assert.deepEqual(domain.records(), []);
    assert.equal((await domain.state(run.capabilityId as string)).state, 'absent');
    assert.deepEqual(dispositions(run.observations), [['receipt-missing', 'RECEIPT_MISSING']]);
  });

  it('a request altered in transit — body, target, a mapped header, the method, or a second presentation header — is refused: no effect, no receipt', async () => {
    const domain = await domainOf();
    const executor = await executorOf(domain);
    const header = (request: GenericHttpWireRequest, name: string, value: string): GenericHttpWireRequest => ({ ...request, headers: request.headers.map(([key, current]) => [key, key === name ? value : current] as const) });
    const tampers: readonly [string, (request: GenericHttpWireRequest) => GenericHttpWireRequest][] = [
      ['the body', (request) => ({ ...request, body: (request.body ?? '').replace('7500', '75000'), headers: request.headers.map(([key, value]) => [key, key === 'content-length' ? String(Buffer.byteLength((request.body ?? '').replace('7500', '75000'))) : value] as const) })],
      ['the target', (request) => ({ ...request, path: request.path.replace('rolling', 'recreate') })],
      ['a mapped header', (request) => header(request, 'x-counterparty', 'vendor-9999')],
      ['the method', (request) => ({ ...request, method: 'PUT' })],
    ];
    for (const [label, tamper] of tampers) {
      const world = await hostOf({ target: { port: executor.port }, trustedExecutors: [e2eTrustedExecutor(domain.publicKeyPem)], tamper });
      const run = await governed(world, domain);
      assert.equal(run.result.outcome, 'failed', label);
      assert.equal(run.consumption, 'absent', `${label}: nothing consumed`);
      assert.deepEqual(dispositions(run.observations), [['receipt-missing', 'RECEIPT_MISSING']], label);
    }
    assert.deepEqual(domain.records(), [], 'no effect for any of them');
  });

  it('a second presentation header cannot leave the Host transport (headers are one map), and on the wire the executor refuses it before anything is consumed', async () => {
    const domain = await domainOf();
    const executor = await executorOf(domain);
    const dir = privateDirectory('frontera-g02c1d-relay-');
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const relay = await startRelay(dir, executor.port, { hold: true });
    cleanups.push(() => relay.close());
    const world = await hostOf({ target: relay.target, trustedExecutors: [e2eTrustedExecutor(domain.publicKeyPem)] });
    await governed(world);
    // The transport's request options carry headers as one map: a second entry under the same name replaces, never adds.
    const sent = world.sent[0] as GenericHttpWireRequest;
    const options = buildNodeRequestOptions({ ...sent, headers: [...sent.headers, [GENERIC_HTTP_PRESENTATION_HEADER, 'AAAA'] as const] }, { address: '127.0.0.1', family: 4 });
    assert.equal(Object.keys(options.headers as Record<string, string>).filter((name) => name === GENERIC_HTTP_PRESENTATION_HEADER).length, 1);
    const written = parseRaw(relay.requests[0] as Buffer);
    assert.equal(written.headerLines.filter((line) => line.toLowerCase().startsWith(`${GENERIC_HTTP_PRESENTATION_HEADER}:`)).length, 1, 'the transport writes one');
    const presentation = headerValue(written, GENERIC_HTTP_PRESENTATION_HEADER) as string;
    const duplicated = serializeRaw(addHeaderLines(written, `${GENERIC_HTTP_PRESENTATION_HEADER}: ${presentation}`));
    const refused = await rawExchange(executor.port, duplicated);
    assert.equal(refused.status, 400, 'HEADER_DUPLICATED at admission');
    assert.deepEqual(domain.records(), []);
  });

  it('an executor without receipts answers 201 and delivers nothing: the Host keeps the status classification and records the receipt as missing — uncertainty, not proof', async () => {
    const domain = await domainOf();
    const executor = await executorOf(domain, { receipts: false });
    const world = await hostOf({ target: { port: executor.port }, trustedExecutors: [e2eTrustedExecutor(domain.publicKeyPem)] });
    const run = await governed(world, domain);
    assert.equal(run.result.outcome, 'completed', 'P11’s classification of the status is unchanged');
    assert.equal(domain.records().length, 1);
    assert.deepEqual(dispositions(run.observations), [['receipt-missing', 'RECEIPT_MISSING']]);
    assert.equal(run.observations[0]?.agreement, 'not-comparable');
    assert.deepEqual(run.evidence, []);
  });
});

describe('G-02C1D process — lost receipts: never re-executed, never re-presented, never guessed', { timeout: SUITE_TIMEOUT_MS }, () => {
  const crashes: readonly [string, string, number][] = [
    // fault point, executor consumption after the crash, synthetic records after the crash
    ['after-claim', 'claimed', 0],
    ['after-effect', 'claimed', 1],
    ['after-outcome', 'completed', 1],
    ['after-receipt', 'completed', 1],
  ];
  for (const [point, consumption, records] of crashes) {
    it(`executor crash ${point}: the Host sees no answer (unconfirmed, receipt missing); restarted, the executor recovers from durable state, and nothing runs twice`, async () => {
      const domain = await domainOf();
      const crashing = await executorOf(domain, { crashAt: point });
      const world = await hostOf({ target: { port: crashing.port }, trustedExecutors: [e2eTrustedExecutor(domain.publicKeyPem)] });
      const run = await governed(world, domain);
      assert.equal((await crashing.exited()).signal, 'SIGKILL');
      assert.equal(run.result.outcome, 'unconfirmed', `${point}: anything after the request left is unconfirmed`);
      assert.deepEqual(dispositions(run.observations), [['receipt-missing', 'RECEIPT_MISSING']]);
      assert.equal(run.observations[0]?.transmission, 'unconfirmed');
      assert.equal((await domain.state(run.capabilityId as string)).state, consumption);
      assert.equal(domain.records().length, records);

      const restarted = await executorOf(domain);
      assert.ok(restarted.port > 0);
      assert.equal((await world.execute(run.action)).outcome, 'failed', 'the Host does not re-present to obtain a receipt');
      assert.equal(world.sent.length, 1);
      assert.equal(domain.records().length, records, 'and the executor performed nothing again');
      const recovered = await domain.receipts(run.capabilityId as string);
      if (point === 'after-receipt') assert.equal(recovered.length, 1, 'the receipt signed before the crash is on the executor’s ledger');
      for (const receipt of recovered) assert.equal(consumption !== 'completed' && receipt.receipt.includes('"outcome":"completed-observed"'), false, 'never "completed" from a claim alone');
      assert.deepEqual(world.evidence.evidenceFor(run.executionId), [], 'there is no read-only retrieval route (founder decision): the Host keeps "missing"');
    });
  }

  it('the Host loses the answer after the executor acted: unconfirmed, receipt missing; the executor’s durable receipt exists and nothing re-runs', async () => {
    const domain = await domainOf();
    const executor = await executorOf(domain);
    const dir = privateDirectory('frontera-g02c1d-relay-');
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const relay = await startRelay(dir, executor.port, { dropResponse: true });
    cleanups.push(() => relay.close());
    const world = await hostOf({ target: relay.target, trustedExecutors: [e2eTrustedExecutor(domain.publicKeyPem)] });
    const run = await governed(world, domain);
    assert.equal(run.result.outcome, 'unconfirmed');
    assert.deepEqual(dispositions(run.observations), [['receipt-missing', 'RECEIPT_MISSING']]);
    assert.equal(run.consumption, 'completed');
    assert.equal(domain.records().length, 1);
    assert.equal(run.receipts.length, 1, 'signed and persisted by the executor — just never delivered');
  });

  it('a capability that expires before it arrives is refused at the executor: nothing consumed', async () => {
    const domain = await domainOf();
    const executor = await executorOf(domain);
    const dir = privateDirectory('frontera-g02c1d-relay-');
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const relay = await startRelay(dir, executor.port, { delayMs: 2_500 });
    cleanups.push(() => relay.close());
    const world = await hostOf({ target: relay.target, trustedExecutors: [e2eTrustedExecutor(domain.publicKeyPem)], lifetimeMs: 1_000 });
    const run = await governed(world, domain);
    assert.equal(run.result.outcome, 'failed');
    assert.equal(run.consumption, 'absent');
    assert.deepEqual(domain.records(), []);
  });

  it('offline revocation is limited: a capability issued before the grant was revoked is still honoured by an offline executor within its lifetime', async () => {
    const domain = await domainOf();
    const executor = await executorOf(domain);
    const dir = privateDirectory('frontera-g02c1d-relay-');
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const relay = await startRelay(dir, executor.port, { hold: true });
    cleanups.push(() => relay.close());
    const world = await hostOf({ target: relay.target, trustedExecutors: [e2eTrustedExecutor(domain.publicKeyPem)] });
    const signed = await world.grant();
    assert.equal((await world.execute(world.actionFor(signed))).outcome, 'unconfirmed');
    world.revoke(signed);
    const held = relay.requests[0];
    assert.ok(held !== undefined);
    const late = await rawExchange(executor.port, held);
    assert.equal(late.status, 201, 'the executor cannot know of a revocation it was never told (statusPolicy offline-only)');
    assert.equal(domain.records().length, 1);
  });
});

describe('G-02C1D process — an executor that lies, over real HTTP/1.1', { timeout: SUITE_TIMEOUT_MS }, () => {
  /** A loopback server that reads the presented capability and answers `status` with whatever `answer` returns as receipt headers. */
  async function forger(status: number, answer: (request: GenericHttpWireRequest) => readonly string[]): Promise<{ readonly port: number }> {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const raw = req.rawHeaders;
      const headers: (readonly [string, string])[] = [];
      for (let index = 0; index + 1 < raw.length; index += 2) headers.push([String(raw[index]).toLowerCase(), String(raw[index + 1])]);
      req.resume();
      req.on('end', () => {
        const values = answer({ method: 'POST', hostname: 'api.devops.example', port: 443, path: req.url ?? '/', headers });
        // An array value is written as one header line per element — two receipts are two lines on the wire.
        if (values.length > 0) res.setHeader(GENERIC_HTTP_RECEIPT_HEADER, [...values]);
        res.writeHead(status, { 'content-length': '0', connection: 'close' });
        res.end();
      });
    });
    await new Promise<void>((ready) => server.listen(0, '127.0.0.1', () => ready()));
    cleanups.push(() => new Promise<void>((done) => server.close(() => done())));
    const address = server.address();
    assert.ok(typeof address === 'object' && address !== null);
    return { port: address.port };
  }

  it('two receipt headers on the wire are ambiguous; a forged signature, an unpinned executor, another execution and an unknown contradicting a 201 are each judged, and none becomes evidence', async () => {
    const domain = await domainOf();
    const trusted = [e2eTrustedExecutor(domain.publicKeyPem)];
    const other = await domainOf();
    const cases: readonly [string, (request: GenericHttpWireRequest) => readonly string[], string, string | null][] = [
      ['two receipt headers', (request) => {
        const one = deliverableReceipt(domain.keyFile, receiptAbout(presentedCapability(request)));
        return [one, one];
      }, 'receipt-duplicated', 'RECEIPT_DUPLICATED'],
      ['a forged signature', (request) => [deliverableReceipt(other.keyFile, receiptAbout(presentedCapability(request)))], 'receipt-invalid', 'SIGNATURE_INVALID'],
      ['an unpinned executor', (request) => [deliverableReceipt(domain.keyFile, receiptAbout(presentedCapability(request), { executorId: 'reference-executor-rogue' }))], 'receipt-invalid', 'EXECUTOR_UNTRUSTED'],
      ['another execution', (request) => {
        const capability = presentedCapability(request);
        return [deliverableReceipt(domain.keyFile, receiptAbout(capability, { executionId: `${capability.executionId.slice(0, -1)}${capability.executionId.endsWith('0') ? '1' : '0'}` }))];
      }, 'receipt-uncorrelated', 'IDENTITY_MISMATCH'],
    ];
    for (const [label, answer, disposition, failure] of cases) {
      const server = await forger(201, answer);
      const world = await hostOf({ target: server, trustedExecutors: trusted });
      const run = await governed(world);
      assert.equal(run.result.outcome, 'completed', `${label}: the status alone decides the result`);
      assert.deepEqual(dispositions(run.observations), [[disposition, failure]], label);
      assert.deepEqual(run.evidence, [], label);
    }
    const contradicting = await forger(201, (request) => [deliverableReceipt(domain.keyFile, receiptAbout(presentedCapability(request), UNKNOWN))]);
    const world = await hostOf({ target: contradicting, trustedExecutors: trusted });
    const run = await governed(world);
    assert.equal(run.result.outcome, 'completed');
    assert.deepEqual([run.observations[0]?.disposition, run.observations[0]?.agreement], ['receipt-correlated', 'contradicts'], 'a contradiction is kept, and resolves nothing');
  });
});
