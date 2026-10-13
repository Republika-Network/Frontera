import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { readPaymentProtectedRequest } from '../../features/payment-runtime/index.js';
import { parseX402Json, readX402PaymentRequiredCarrier, type X402BindingRequest, type X402PaymentRequirements } from '../../features/payment-runtime/protocols/x402/index.js';
import { SPEC_LNBTC_VECTOR } from '../../features/payment-runtime/protocols/x402/tests/x402-spec-vectors.js';
import { decodeBolt11Invoice } from '../../features/payment-runtime/rails/lightning/index.js';
import { buildInvoice, testNodeKey, testPreimage, TEST_NOW_SECONDS } from '../../features/payment-runtime/rails/lightning/tests/lightning-test-fixtures.js';
import type { GovernanceRecord } from '../governance-store/index.js';
import { deriveGovernedActionExecutionId, executionAttemptReferenceId } from '../governed-action/identifiers.js';
import { boundScopeOf } from '../governed-action/kernel-request.js';
import { derivePaymentBusinessOperationRequestId, type VerifiedPaymentProtocolContext } from '../payment-protocol-ingress/index.js';
import {
  X402_LNBTC_NETWORKS,
  createX402LightningBinding,
  createX402LightningExecutionInvoices,
  createX402LightningInvoiceVerifier,
  createX402PaymentSignatureBuilder,
  readX402PaymentResponseEvidence,
  x402LightningBindingId,
  x402LightningHttpRequestHash,
  type X402LightningExecutionInvoices,
  type X402LightningProofSource,
} from '../x402-payment-protocol/index.js';
import { IDENTITY, ORG } from './governed-action-support.js';
import { merchantBindingText } from './pay08-x402-world.js';

/**
 * PAY-08 — the `exact` / `lnbtc` binding against the pinned specification's
 * own vectors (x402 `f8f8330`, `scheme_exact_lnbtc.md`), decoded by PAY-06's
 * real BOLT11 decoder; then every client-side check the binding owes, and the
 * post-settlement proof builder's refusals.
 */

const MAINNET = X402_LNBTC_NETWORKS.mainnet.network;
const TESTNET = X402_LNBTC_NETWORKS.testnet.network;

function requirementOf(json: unknown, url: string = SPEC_LNBTC_VECTOR.url): X402PaymentRequirements {
  const encoded = Buffer.from(JSON.stringify({ x402Version: 2, resource: { url }, accepts: [json] })).toString('base64');
  const read = readX402PaymentRequiredCarrier({ status: 402, headers: [['PAYMENT-REQUIRED', encoded]] });
  assert.ok(read.valid, read.valid ? '' : read.violation);
  return read.value.accepts[0] as X402PaymentRequirements;
}

function bindingRequest(requirement: X402PaymentRequirements, options: { readonly url?: string; readonly method?: string; readonly body?: string; readonly fields?: Record<string, string | null>; readonly atSeconds?: number } = {}): X402BindingRequest {
  const protectedRequest = readPaymentProtectedRequest({
    target: 'article',
    method: options.method ?? 'GET',
    ...(options.body !== undefined ? { contentDigest: `sha-256=:${createHash('sha256').update(options.body).digest('base64')}:` } : {}),
  });
  assert.ok(protectedRequest !== undefined);
  return Object.freeze({
    requirement,
    paymentFlow: 'upfront' as const,
    request: Object.freeze({
      url: options.url ?? SPEC_LNBTC_VECTOR.url,
      method: protectedRequest.method,
      bodyBearing: protectedRequest.bodyBearing,
      ...(protectedRequest.contentDigest !== undefined ? { contentDigest: protectedRequest.contentDigest } : {}),
      fields: Object.freeze(options.fields ?? {}),
    }),
    observedAtEpochMilliseconds: (options.atSeconds ?? SPEC_LNBTC_VECTOR.validationTimeSeconds) * 1000,
  });
}

async function preparedMainnet() {
  const verifier = createX402LightningInvoiceVerifier();
  const binding = createX402LightningBinding({ network: 'mainnet', verifier });
  const requirement = requirementOf(SPEC_LNBTC_VECTOR.requirement);
  await binding.prepare?.(requirement);
  return { verifier, binding, requirement };
}

describe('PAY-08 — lnbtc against the specification’s vectors', () => {
  it('the http:1 request hash of the spec’s request is the spec’s digest — and article B’s is article B’s', () => {
    const request = bindingRequest(requirementOf(SPEC_LNBTC_VECTOR.requirement)).request;
    assert.equal(x402LightningHttpRequestHash(request, []), SPEC_LNBTC_VECTOR.requestHash);
    assert.equal(x402LightningHttpRequestHash({ ...request, url: 'https://api.example.com/article/B' }, []), SPEC_LNBTC_VECTOR.requestHashArticleB);
  });

  it('PAY-06’s decoder reads the spec’s invoice: payee, payment hash, amount, expiry, time, and the signed description hash', async () => {
    const decoded = await decodeBolt11Invoice(SPEC_LNBTC_VECTOR.requirement.extra.invoice);
    assert.ok(decoded.valid, decoded.valid ? '' : decoded.refusal);
    assert.equal(decoded.invoice.network, 'mainnet');
    assert.equal(decoded.invoice.payee, SPEC_LNBTC_VECTOR.requirement.payTo);
    assert.equal(decoded.invoice.paymentHash, SPEC_LNBTC_VECTOR.paymentHash);
    assert.equal(decoded.invoice.amountMsat, 25_000n);
    assert.equal(decoded.invoice.expirySeconds, 300);
    assert.equal(decoded.invoice.timestamp, SPEC_LNBTC_VECTOR.validationTimeSeconds);
    assert.equal(decoded.invoice.descriptionHash, SPEC_LNBTC_VECTOR.requestHash);
  });

  it('the binding accepts the spec’s requirement for the spec’s request: the governed destination and the consumption key', async () => {
    const { binding, requirement } = await preparedMainnet();
    assert.deepEqual(binding.interpret(bindingRequest(requirement)), {
      usable: true,
      destination: { kind: 'lightning-invoice', reference: `${SPEC_LNBTC_VECTOR.requirement.payTo}:${SPEC_LNBTC_VECTOR.paymentHash}` },
      instrument: `${MAINNET}:${SPEC_LNBTC_VECTOR.paymentHash}`,
    });
  });

  it('the spec’s settlement cases, client side: article B, POST, another body, or an echoed digest for B are all request mismatches', async () => {
    const { binding, requirement } = await preparedMainnet();
    assert.deepEqual(binding.interpret(bindingRequest(requirement, { url: 'https://api.example.com/article/B' })), { usable: false, refusal: 'request-binding-mismatch' });
    assert.deepEqual(binding.interpret(bindingRequest(requirement, { method: 'POST', body: '' })), { usable: false, refusal: 'request-binding-mismatch' });
    assert.deepEqual(binding.interpret(bindingRequest(requirement, { method: 'POST', body: 'x' })), { usable: false, refusal: 'request-binding-mismatch' });
    const echoedB = requirementOf({ ...SPEC_LNBTC_VECTOR.requirement, extra: { ...SPEC_LNBTC_VECTOR.requirement.extra, requestHash: SPEC_LNBTC_VECTOR.requestHashArticleB } }, 'https://api.example.com/article/B');
    assert.deepEqual(binding.interpret(bindingRequest(echoedB, { url: 'https://api.example.com/article/B' })), { usable: false, refusal: 'request-binding-mismatch' }, 'the invoice still commits to article A');
  });

  it('time: created-in-future beyond the skew, the expiry boundary, and the 60-second default skew', async () => {
    const { binding, requirement } = await preparedMainnet();
    const at = (seconds: number) => binding.interpret(bindingRequest(requirement, { atSeconds: seconds }));
    assert.equal(at(SPEC_LNBTC_VECTOR.validationTimeSeconds - 60).usable, true, 'equality at the skew boundary is valid');
    assert.deepEqual(at(SPEC_LNBTC_VECTOR.validationTimeSeconds - 61), { usable: false, refusal: 'normalization-failed' });
    assert.equal(at(SPEC_LNBTC_VECTOR.validationTimeSeconds + 299).usable, true);
    assert.deepEqual(at(SPEC_LNBTC_VECTOR.validationTimeSeconds + 300), { usable: false, refusal: 'challenge-expired' }, 'never paid at or past expiry');
  });
});

describe('PAY-08 — lnbtc client-side checks', () => {
  const extra = SPEC_LNBTC_VECTOR.requirement.extra;
  const vary = (change: Record<string, unknown>, extraChange: Record<string, unknown> = {}) => requirementOf({ ...SPEC_LNBTC_VECTOR.requirement, ...change, extra: { ...extra, ...extraChange } });

  it('refuses every term the invoice does not commit to exactly', async () => {
    const { binding } = await preparedMainnet();
    const cases: readonly [X402PaymentRequirements, string][] = [
      [vary({ amount: '25001' }), 'normalization-failed'],
      [vary({ maxTimeoutSeconds: 301 }), 'normalization-failed'],
      [vary({ payTo: `02${'5'.repeat(64)}` }), 'counterparty-unresolved'],
      [vary({ payTo: 'NOT-A-KEY' }), 'normalization-failed'],
      [vary({ asset: 'SAT' }), 'challenge-unsupported'],
      [vary({ scheme: 'upto' }), 'challenge-unsupported'],
      [vary({ network: TESTNET }), 'challenge-unsupported'],
      [vary({}, { paymentFlow: 'authorization' }), 'challenge-unsupported'],
      [vary({}, { paymentFlow: undefined }), 'challenge-unsupported'],
      [vary({}, { assetTransferMethod: 'keysend' }), 'challenge-unsupported'],
      [vary({}, { requestBindingProfile: 'mcp:1' }), 'challenge-unsupported'],
      [vary({}, { requestBindingProfile: undefined }), 'request-binding-mismatch'],
      [vary({}, { requestBindingParams: { headers: [], extra: [] } }), 'request-binding-mismatch'],
      [vary({}, { requestBindingParams: { headers: ['b', 'a'] } }), 'request-binding-mismatch'],
      [vary({}, { requestBindingParams: { headers: ['payment-signature'] } }), 'request-binding-mismatch'],
      [vary({}, { requestBindingParams: { headers: ['Accept'] } }), 'request-binding-mismatch'],
      [vary({}, { requestHash: undefined }), 'request-binding-mismatch'],
      [vary({}, { requestHash: SPEC_LNBTC_VECTOR.requestHash.toUpperCase() }), 'request-binding-mismatch'],
      [vary({}, { invoice: 'lnbc1invalid' }), 'normalization-failed'],
      [vary({}, { memo: 'unknown server field' }), 'challenge-unsupported'],
    ];
    for (const [requirement, refusal] of cases) assert.deepEqual(binding.interpret(bindingRequest(requirement)), { usable: false, refusal }, JSON.stringify(requirement).slice(0, 160));
  });

  it('an invoice that was never prepared, or did not verify, is refused — the memo is the only source of a reading', async () => {
    const verifier = createX402LightningInvoiceVerifier();
    const binding = createX402LightningBinding({ network: 'mainnet', verifier });
    const requirement = requirementOf(SPEC_LNBTC_VECTOR.requirement);
    assert.deepEqual(binding.interpret(bindingRequest(requirement)), { usable: false, refusal: 'normalization-failed' });
    await verifier.verify(`${SPEC_LNBTC_VECTOR.requirement.extra.invoice.slice(0, -1)}q`);
    assert.equal(verifier.verified(`${SPEC_LNBTC_VECTOR.requirement.extra.invoice.slice(0, -1)}q`), undefined);
  });

  it('network and currency confusion: a testnet binding refuses a mainnet invoice under the testnet identifier', async () => {
    const verifier = createX402LightningInvoiceVerifier();
    const binding = createX402LightningBinding({ network: 'testnet', verifier });
    const requirement = requirementOf({ ...SPEC_LNBTC_VECTOR.requirement, network: TESTNET });
    await binding.prepare?.(requirement);
    assert.deepEqual(binding.interpret(bindingRequest(requirement)), { usable: false, refusal: 'normalization-failed' });
    assert.equal(binding.supports({ scheme: 'exact', network: MAINNET, asset: 'BTC' }), false);
    assert.equal(binding.bindingId, x402LightningBindingId('testnet'));
    assert.throws(() => createX402LightningBinding({ network: 'regtest' as never, verifier }), TypeError, 'only the networks the pinned binding defines');
  });

  it('an inline-description invoice (no description hash) is refused; a description hash for another request too', async () => {
    const { paymentHash } = testPreimage('pay08-inline');
    const payee = await testNodeKey('payee-node');
    const inline = await buildInvoice({ network: 'testnet', amountMsat: 25_000n, paymentHash, payeeKeyLabel: 'payee-node', description: 'goods', expirySeconds: 300, timestamp: TEST_NOW_SECONDS });
    const verifier = createX402LightningInvoiceVerifier();
    const binding = createX402LightningBinding({ network: 'testnet', verifier });
    const url = 'https://merchant.example/a';
    const hash = x402LightningHttpRequestHash({ url, method: 'GET', bodyBearing: false, fields: {} }, []) as string;
    const requirement = requirementOf({ scheme: 'exact', network: TESTNET, amount: '25000', asset: 'BTC', payTo: payee, maxTimeoutSeconds: 300, extra: { paymentFlow: 'upfront', requestHash: hash, requestBindingProfile: 'http:1', requestBindingParams: { headers: [] }, invoice: inline } }, url);
    await binding.prepare?.(requirement);
    assert.deepEqual(binding.interpret(bindingRequest(requirement, { url, atSeconds: TEST_NOW_SECONDS })), { usable: false, refusal: 'request-binding-mismatch' });
  });

  it('bound headers: values hashed from the trusted request (absent ≠ empty), a name the request layer did not describe refuses, a non-canonical value refuses', () => {
    const request = bindingRequest(requirementOf(SPEC_LNBTC_VECTOR.requirement)).request;
    const withAccept = x402LightningHttpRequestHash({ ...request, fields: { accept: 'application/json' } }, ['accept']);
    const absent = x402LightningHttpRequestHash({ ...request, fields: { accept: null } }, ['accept']);
    const empty = x402LightningHttpRequestHash({ ...request, fields: { accept: '' } }, ['accept']);
    assert.ok(withAccept !== undefined && absent !== undefined && empty !== undefined);
    assert.equal(new Set([withAccept, absent, empty, SPEC_LNBTC_VECTOR.requestHash]).size, 4);
    assert.equal(x402LightningHttpRequestHash({ ...request, fields: {} }, ['accept']), undefined);
    assert.equal(x402LightningHttpRequestHash({ ...request, fields: { accept: ' padded ' } }, ['accept']), undefined);
    assert.equal(x402LightningHttpRequestHash({ ...request, fields: { accept: 'ünicode' } }, ['accept']), undefined);
  });

  it('the verifier is a cache of exact texts: a reading is the decoding of exactly that text, and the cache is bounded', async () => {
    const verifier = createX402LightningInvoiceVerifier({ maximumEntries: 1 });
    await verifier.verify(SPEC_LNBTC_VECTOR.requirement.extra.invoice);
    assert.equal(verifier.verified(SPEC_LNBTC_VECTOR.requirement.extra.invoice)?.paymentHash, SPEC_LNBTC_VECTOR.paymentHash);
    assert.equal(verifier.verified(SPEC_LNBTC_VECTOR.requirement.extra.invoice.toUpperCase()), undefined, 'another spelling is another text');
    assert.equal('invoices' in verifier, false, 'the cache is not the rail’s invoice source');
    assert.throws(() => createX402LightningInvoiceVerifier({ maximumEntries: 0 }), TypeError);
  });
});

describe('PAY-08 — the rail’s invoice is the governed execution’s (LIFE, execution binding)', () => {
  const URL_A = 'https://merchant.example/article/A';
  const URL_B = 'https://merchant.example/article/B';
  const hashOf = (url: string) => x402LightningHttpRequestHash({ url, method: 'GET', bodyBearing: false, fields: {} }, []) as string;
  const bound = boundScopeOf(IDENTITY, ORG);
  assert.ok(bound !== undefined);
  const scope = bound;
  const requestIdOf = (businessOperationId: string) => derivePaymentBusinessOperationRequestId({ organizationId: ORG, principalId: scope.principalId, businessOperationId });

  /** A validly signed testnet invoice committing to `url`'s http:1 request hash, for `label`'s payment hash. */
  async function signedInvoice(label: string, url: string, options: { readonly payeeKeyLabel?: string } = {}): Promise<string> {
    const { paymentHash } = testPreimage(label);
    return buildInvoice({ network: 'testnet', amountMsat: 25_000n, paymentHash, payeeKeyLabel: options.payeeKeyLabel ?? 'payee-node', description: merchantBindingText({ method: 'GET', url }, []), descriptionHash: true, expirySeconds: 300, timestamp: TEST_NOW_SECONDS });
  }

  /** A and B: same payment hash, payee, amount and network; different signed description hash. */
  async function collidingPair(label = 'pay08-collision') {
    const a = await signedInvoice(label, URL_A);
    const b = await signedInvoice(label, URL_B);
    const [readA, readB] = await Promise.all([decodeBolt11Invoice(a), decodeBolt11Invoice(b)]);
    assert.ok(readA.valid && readB.valid);
    assert.notEqual(a, b);
    assert.equal(readA.invoice.paymentHash, readB.invoice.paymentHash);
    assert.equal(readA.invoice.payee, readB.invoice.payee);
    assert.equal(readA.invoice.amountMsat, readB.invoice.amountMsat);
    assert.equal(readA.invoice.network, readB.invoice.network);
    assert.notEqual(readA.invoice.descriptionHash, readB.invoice.descriptionHash);
    return { a, b, paymentHash: readA.invoice.paymentHash, payee: readA.invoice.payee };
  }

  /**
   * The two durable reads the source composes, in memory: PAY-04's verified context per governed request
   * (the exact recorded requirement) and the Governance Store's committed decision with its write-ahead claim.
   */
  function durableWorld() {
    const contexts = new Map<string, VerifiedPaymentProtocolContext>();
    const records = new Map<string, { decisionId: string; claimed: string[] }>();
    const reads = { contexts: 0, decisions: 0 };
    return {
      reads,
      /** Records operation `businessOperationId` with `invoice` and commits its decision; `claim` appends the write-ahead execution claim (or `claimFor`, another execution's). */
      govern(businessOperationId: string, invoice: string, destination: { readonly payee: string; readonly paymentHash: string }, options: { readonly claim?: boolean; readonly claimFor?: string } = {}) {
        const requestId = requestIdOf(businessOperationId);
        const requirement = JSON.stringify({ amount: '25000', asset: 'BTC', extra: { invoice, paymentFlow: 'upfront' }, maxTimeoutSeconds: 300, network: TESTNET, payTo: destination.payee, scheme: 'exact' });
        contexts.set(requestId, {
          organizationId: ORG,
          principalId: scope.principalId,
          businessOperationId,
          requestId,
          businessSemanticDigest: 'd',
          terms: { action: 'pay', source: { accountId: 'a' }, destination: { kind: 'lightning-invoice', reference: `${destination.payee}:${destination.paymentHash}` }, amount: { value: '0.00000025', unit: 'net:BTC' }, purpose: 'vendor-payment', binding: { target: 't', method: 'GET' } },
          challenge: { protocolId: 'x402', key: `x402:2:${TESTNET}:${destination.paymentHash}`, fields: { binding: x402LightningBindingId('testnet'), instrument: `${TESTNET}:${destination.paymentHash}`, requirement, network: TESTNET, amount: '25000' }, sequence: 1, digest: 'x' },
        } as unknown as VerifiedPaymentProtocolContext);
        const decisionId = `dec-${businessOperationId}`;
        const executionId = deriveGovernedActionExecutionId({ requestId, decisionId });
        records.set(requestId, { decisionId, claimed: options.claim === false ? [] : [options.claimFor ?? executionId] });
        return { requestId, executionId };
      },
      source(): X402LightningExecutionInvoices {
        return createX402LightningExecutionInvoices({
          organizationId: ORG,
          contexts: {
            readByGovernedRequestId: async (_organizationId, requestId) => {
              reads.contexts += 1;
              return contexts.get(requestId);
            },
          },
          decisions: {
            getByRequestId: async (_context, requestId) => {
              reads.decisions += 1;
              const record = records.get(requestId);
              if (record === undefined) return null;
              return {
                request: { organizationId: ORG },
                evaluation: { decisionId: record.decisionId },
                references: record.claimed.map((executionId) => ({ referenceId: executionAttemptReferenceId(executionId), externalId: executionId })),
              } as unknown as GovernanceRecord;
            },
          },
        });
      },
    };
  }

  /** Asks the rail's question while `businessOperationId`'s presentation is in flight. */
  const askDuring = (source: X402LightningExecutionInvoices, businessOperationId: string, query: { readonly executionId: string; readonly payee: string; readonly paymentHash: string }) =>
    source.during(IDENTITY, businessOperationId, () => source.invoices.invoiceFor(query));

  it('LIFE-1 a small decoding cache and 100 sequential distinct valid invoices: every one verifies and the rail is given each exact text — nothing is exhausted', async () => {
    const verifier = createX402LightningInvoiceVerifier({ maximumEntries: 8 });
    const durable = durableWorld();
    const source = durable.source();
    const payee = await testNodeKey('payee-node');
    for (let index = 1; index <= 100; index += 1) {
      const label = `pay08-life1-${String(index)}`;
      const invoice = await signedInvoice(label, URL_A);
      await verifier.verify(invoice);
      const reading = verifier.verified(invoice);
      assert.ok(reading !== undefined, `invoice ${String(index)} verifies`);
      const { executionId } = durable.govern(`op-life1-${String(index)}`, invoice, { payee, paymentHash: reading.paymentHash });
      assert.equal(await askDuring(source, `op-life1-${String(index)}`, { executionId, payee, paymentHash: reading.paymentHash }), invoice, `invoice ${String(index)} is served exactly`);
    }
    assert.equal(verifier.verified(await signedInvoice('pay08-life1-1', URL_A)), undefined, 'the first reading rolled out of the cache — and nothing depended on it');
  });

  it('LIFE-2 A and B share (payee, payment hash) and differ in text: the execution governed for A is given A, and never B', async () => {
    const { a, b, ...pair } = await collidingPair();
    const durable = durableWorld();
    const { executionId } = durable.govern('op-life2', a, pair);
    const verifier = createX402LightningInvoiceVerifier();
    await verifier.verify(b);
    await verifier.verify(a);
    await verifier.verify(b);
    const source = durable.source();
    assert.equal(await askDuring(source, 'op-life2', { executionId, ...pair }), a);
    assert.equal(await askDuring(source, 'op-life2', { executionId, ...pair, payee: `02${'7'.repeat(64)}` }), undefined, 'another payee: withheld, never redirected');
    assert.equal(await askDuring(source, 'op-life2', { executionId, ...pair, paymentHash: 'f'.repeat(64) }), undefined, 'another payment hash: withheld');
  });

  it('LIFE-3 the decoding cache evicts A’s reading under pressure: the execution still gets exactly A from the record, never B', async () => {
    const { a, b, ...pair } = await collidingPair();
    const verifier = createX402LightningInvoiceVerifier({ maximumEntries: 1 });
    await verifier.verify(a);
    await verifier.verify(b);
    assert.equal(verifier.verified(a), undefined, 'A’s reading is gone');
    const durable = durableWorld();
    const { executionId } = durable.govern('op-life3', a, pair);
    assert.equal(await askDuring(durable.source(), 'op-life3', { executionId, ...pair }), a);
  });

  it('LIFE-4 a recomposed source (restart) holds nothing in flight: a lookup outside a presentation fails closed; within one it recovers exactly A from the record — never B', async () => {
    const { a, b, ...pair } = await collidingPair();
    const durable = durableWorld();
    const governedA = durable.govern('op-life4-a', a, pair);
    const before = durable.source();
    assert.equal(await askDuring(before, 'op-life4-a', { executionId: governedA.executionId, ...pair }), a);
    const after = durable.source();
    assert.equal(await after.invoices.invoiceFor({ executionId: governedA.executionId, ...pair }), undefined, 'nothing in flight after a restart');
    // Another operation's presentation in flight (with B under the same pair) is never A's execution's.
    durable.govern('op-life4-b', b, pair);
    assert.equal(await askDuring(after, 'op-life4-b', { executionId: governedA.executionId, ...pair }), undefined, 'A’s execution is never handed B');
    assert.equal(await askDuring(after, 'op-life4-a', { executionId: governedA.executionId, ...pair }), a, 'exact A, from durable state');
  });

  it('LIFE-4 an execution whose write-ahead claim is not on record is not served, even for its own request', async () => {
    const { a, ...pair } = await collidingPair();
    const durable = durableWorld();
    const { executionId } = durable.govern('op-life4-unclaimed', a, pair, { claim: false });
    assert.equal(await askDuring(durable.source(), 'op-life4-unclaimed', { executionId, ...pair }), undefined);
  });

  it('LIFE-4 a claim reference on a request’s record does not lend its invoice to an execution that request’s decision does not derive', async () => {
    const { a, ...pair } = await collidingPair();
    const durable = durableWorld();
    const borrowed = 'aoc.exec:borrowed-execution';
    durable.govern('op-life4-borrowed', a, pair, { claimFor: borrowed });
    assert.equal(await askDuring(durable.source(), 'op-life4-borrowed', { executionId: borrowed, ...pair }), undefined);
  });

  it('LIFE-5 nothing outlives the presentation: once it returns, its execution’s binding is released from memory (the durable record remains)', async () => {
    const { a, ...pair } = await collidingPair();
    const durable = durableWorld();
    const source = durable.source();
    const { executionId } = durable.govern('op-life5', a, pair);
    assert.equal(await askDuring(source, 'op-life5', { executionId, ...pair }), a);
    assert.equal(await source.invoices.invoiceFor({ executionId, ...pair }), undefined, 'released when the presentation settled');
    // A throwing presentation releases too.
    await assert.rejects(source.during(IDENTITY, 'op-life5', async () => { throw new Error('ingress failed'); }));
    assert.equal(await source.invoices.invoiceFor({ executionId, ...pair }), undefined);
  });

  it('LIFE-10 after 5 000 historical executions, a fresh operation’s invoice is served — memory holds only what is in flight', async () => {
    const durable = durableWorld();
    const source = durable.source();
    const payee = await testNodeKey('payee-node');
    for (let index = 0; index < 5_000; index += 1) {
      const paymentHash = createHash('sha256').update(`life10-${String(index)}`).digest('hex');
      const invoice = `lntb-life10-${String(index)}`;
      const { executionId } = durable.govern(`op-life10-${String(index)}`, invoice, { payee, paymentHash });
      assert.equal(await askDuring(source, `op-life10-${String(index)}`, { executionId, payee, paymentHash }), invoice);
    }
    const fresh = await signedInvoice('pay08-life10-fresh', URL_A);
    const reading = await decodeBolt11Invoice(fresh);
    assert.ok(reading.valid);
    const { executionId } = durable.govern('op-life10-fresh', fresh, { payee, paymentHash: reading.invoice.paymentHash });
    const reads = { ...durable.reads };
    assert.equal(await askDuring(source, 'op-life10-fresh', { executionId, payee, paymentHash: reading.invoice.paymentHash }), fresh);
    assert.equal(durable.reads.decisions - reads.decisions, 1, 'one in-flight request consulted, not the history');
  });

  it('LIFE-11 the same payment hash reused by another operation: each execution is bound to its own operation’s exact text — no inheritance either way', async () => {
    const { a, b, ...pair } = await collidingPair();
    const durable = durableWorld();
    const first = durable.govern('op-life11-first', a, pair);
    const second = durable.govern('op-life11-second', b, pair);
    const source = durable.source();
    // Both in flight at once — the worst case for a lookup by (payee, hash).
    const both = await source.during(IDENTITY, 'op-life11-first', () =>
      source.during(IDENTITY, 'op-life11-second', async () => [await source.invoices.invoiceFor({ executionId: first.executionId, ...pair }), await source.invoices.invoiceFor({ executionId: second.executionId, ...pair })]),
    );
    assert.deepEqual(both, [a, b]);
    assert.equal(await askDuring(source, 'op-life11-second', { executionId: first.executionId, ...pair }), undefined, 'the first execution never inherits the second operation’s text');
  });

  it('LIFE-12 two concurrent presentations with distinct invoices: each execution is given its own exact text', async () => {
    const one = await signedInvoice('pay08-life12-one', URL_A);
    const two = await signedInvoice('pay08-life12-two', URL_B);
    const [readOne, readTwo] = await Promise.all([decodeBolt11Invoice(one), decodeBolt11Invoice(two)]);
    assert.ok(readOne.valid && readTwo.valid);
    const durable = durableWorld();
    const source = durable.source();
    const g1 = durable.govern('op-life12-one', one, readOne.invoice);
    const g2 = durable.govern('op-life12-two', two, readTwo.invoice);
    const [served1, served2] = await Promise.all([
      askDuring(source, 'op-life12-one', { executionId: g1.executionId, payee: readOne.invoice.payee, paymentHash: readOne.invoice.paymentHash }),
      askDuring(source, 'op-life12-two', { executionId: g2.executionId, payee: readTwo.invoice.payee, paymentHash: readTwo.invoice.paymentHash }),
    ]);
    assert.equal(served1, one);
    assert.equal(served2, two);
  });

  it('a record that does not re-read, or names another destination, binding or network, is withheld — and a throwing read fails closed', async () => {
    const { a, ...pair } = await collidingPair();
    const durable = durableWorld();
    const { executionId } = durable.govern('op-closed', a, pair);
    const broken = createX402LightningExecutionInvoices({
      organizationId: ORG,
      contexts: { readByGovernedRequestId: async () => { throw new Error('store down'); } },
      decisions: { getByRequestId: async () => ({ request: { organizationId: ORG }, evaluation: { decisionId: 'dec-op-closed' }, references: [{ referenceId: executionAttemptReferenceId(executionId), externalId: executionId }] }) as unknown as GovernanceRecord },
    });
    assert.equal(await askDuring(broken, 'op-closed', { executionId, ...pair }), undefined);
    const otherOrganization = createX402LightningExecutionInvoices({ organizationId: 'org-other', contexts: { readByGovernedRequestId: async () => undefined }, decisions: { getByRequestId: async () => null } });
    assert.equal(await askDuring(otherOrganization, 'op-closed', { executionId, ...pair }), undefined, 'an identity of another organization holds nothing');
    assert.throws(() => createX402LightningExecutionInvoices({ organizationId: ORG } as never), TypeError);
  });
});

describe('PAY-08 — the proof builder refuses everything but a settled x402 payment of this operation (PP)', () => {
  const requirement = SPEC_LNBTC_VECTOR.requirement;
  const destination = { kind: 'lightning-invoice', reference: `${requirement.payTo}:${SPEC_LNBTC_VECTOR.paymentHash}` };
  const amount = { value: '0.00000025', unit: 'net:BTC' };
  const canonicalRequirement = (() => {
    const read = requirementOf(requirement);
    return JSON.stringify({ amount: read.amount, asset: read.asset, extra: JSON.parse(JSON.stringify(requirement.extra)), maxTimeoutSeconds: read.maxTimeoutSeconds, network: read.network, payTo: read.payTo, scheme: read.scheme });
  })();
  const context = (overrides: { readonly protocolId?: string; readonly fields?: Record<string, string>; readonly key?: string } = {}): VerifiedPaymentProtocolContext =>
    ({
      organizationId: 'org',
      principalId: 'p',
      businessOperationId: 'bop',
      requestId: 'req-1',
      businessSemanticDigest: 'd',
      terms: { action: 'pay', source: { accountId: 'a' }, destination, amount, purpose: 'vendor-payment', binding: { target: 't', method: 'GET' } },
      challenge: {
        protocolId: overrides.protocolId ?? 'x402',
        key: overrides.key ?? `x402:2:${MAINNET}:${SPEC_LNBTC_VECTOR.paymentHash}`,
        fields: { binding: x402LightningBindingId('mainnet'), instrument: `${MAINNET}:${SPEC_LNBTC_VECTOR.paymentHash}`, requirement: canonicalRequirement, network: MAINNET, amount: '25000', ...overrides.fields },
        sequence: 1,
        digest: 'x',
      },
    }) as unknown as VerifiedPaymentProtocolContext;
  const settledStatus = (overrides: Record<string, unknown> = {}) => ({ outcome: 'status', state: 'settled', settlement: { requestId: 'req-1', executionId: 'exe-1', payment: { destination, amount }, ...overrides } });
  const PREIMAGE = '0001020304050607080900010203040506070809000102030405060708090102';
  const builder = (options: { readonly ctx?: VerifiedPaymentProtocolContext | undefined; readonly status?: unknown; readonly proofs?: X402LightningProofSource }) =>
    createX402PaymentSignatureBuilder({
      contexts: { readByGovernedRequestId: async () => ('ctx' in options ? options.ctx : context()) },
      settlements: { readSettlement: async () => (options.status ?? settledStatus()) as never },
      proofs: options.proofs ?? { preimageFor: async () => PREIMAGE },
    });
  const build = (options: Parameters<typeof builder>[0]) => builder(options).build({ organizationId: 'org', requestId: 'req-1', executionId: 'exe-1' });

  it('builds for the spec’s own preimage — the payment hash in the spec’s vector is SHA-256 of it', async () => {
    const built = await build({});
    assert.equal(built.outcome, 'built');
  });

  it('PP-9 / PP-10 / PP-11 / PP-12 every other case is a closed refusal, and nothing is retried', async () => {
    let asked = 0;
    const counting: X402LightningProofSource = { preimageFor: async () => { asked += 1; return undefined; } };
    const cases: readonly [Parameters<typeof builder>[0], string][] = [
      [{ ctx: undefined }, 'context-not-found'],
      [{ ctx: context({ protocolId: 'mpp' }) }, 'not-x402'],
      [{ ctx: context({ fields: { binding: 'x402-exact-other.mainnet' } }) }, 'not-x402'],
      [{ ctx: context({ fields: { requirement: '{"broken":' } }) }, 'requirement-invalid'],
      [{ ctx: context({ fields: { instrument: `${MAINNET}:${'e'.repeat(64)}` } }) }, 'requirement-invalid'],
      [{ ctx: context({ key: `x402:2:${MAINNET}:${'e'.repeat(64)}` }) }, 'requirement-invalid'],
      [{ ctx: context({ fields: { extensions: '[1]' } }) }, 'requirement-invalid'],
      [{ status: { outcome: 'status', state: 'awaiting-finality' } }, 'not-settled'],
      [{ status: { outcome: 'status', state: 'execution-uncertain' } }, 'not-settled'],
      [{ status: { outcome: 'not-found' } }, 'not-settled'],
      [{ status: { ...settledStatus(), state: 'awaiting-finality' } }, 'not-settled'],
      [{ status: { ...settledStatus(), state: 'execution-uncertain' } }, 'not-settled'],
      [{ status: settledStatus({ requestId: 'req-other' }) }, 'settlement-mismatch'],
      [{ status: settledStatus({ executionId: 'exe-other' }) }, 'settlement-mismatch'],
      [{ status: settledStatus({ payment: { destination: { ...destination, reference: `${requirement.payTo}:${'1'.repeat(64)}` }, amount } }) }, 'settlement-mismatch'],
      [{ status: settledStatus({ payment: { destination, amount: { ...amount, value: '0.00000026' } } }) }, 'settlement-mismatch'],
      [{ proofs: counting }, 'proof-unavailable'],
      [{ proofs: { preimageFor: async () => { throw new Error('node down'); } } }, 'proof-unavailable'],
      [{ proofs: { preimageFor: async () => 'ab'.repeat(32) } }, 'proof-invalid'],
      [{ proofs: { preimageFor: async () => `A${PREIMAGE.slice(1)}` } }, 'proof-invalid'],
    ];
    for (const [options, refusal] of cases) assert.deepEqual(await build(options), { outcome: 'refused', refusal }, refusal);
    assert.equal(asked, 1, 'the proof source is asked once per build, never retried');
  });

  it('PP-7 a client extension never overwrites the server’s', async () => {
    const serverExt = '{"bazaar":{"info":{"a":"1"},"schema":{"type":"object"}}}';
    const client = parseX402Json('{"bazaar":{"info":{"a":"2"},"schema":{"type":"object"}}}');
    assert.ok(client.valid);
    const result = await builder({ ctx: context({ fields: { extensions: serverExt } }) }).build({ organizationId: 'org', requestId: 'req-1', executionId: 'exe-1', clientExtensions: client.value as never });
    assert.deepEqual(result, { outcome: 'refused', refusal: 'extension-overwrite' });
  });

  it('PAYMENT-RESPONSE evidence is about x402 operations only', () => {
    assert.deepEqual(readX402PaymentResponseEvidence({ status: 200, headers: [] }, context({ protocolId: 'mpp' })), { outcome: 'not-x402' });
  });

  describe('PAYMENT-RESPONSE transaction correlation (RESP)', () => {
    const responded = (status: number, response: Record<string, unknown>) => readX402PaymentResponseEvidence({ status, headers: [['PAYMENT-RESPONSE', Buffer.from(JSON.stringify({ network: MAINNET, ...response })).toString('base64')]] }, context());
    const GOVERNED = SPEC_LNBTC_VECTOR.paymentHash;
    const OTHER = 'f'.repeat(64);

    it('RESP-1 success naming the governed payment hash is consistent', () => {
      assert.deepEqual(responded(200, { success: true, transaction: GOVERNED }), { outcome: 'evidence', status: 200, serverReportsSuccess: true, consistent: true });
    });

    it('RESP-2 success naming another transaction — or none — is inconsistent', () => {
      assert.deepEqual(responded(200, { success: true, transaction: OTHER }), { outcome: 'evidence', status: 200, serverReportsSuccess: true, consistent: false, mismatch: 'transaction' });
      assert.deepEqual(responded(200, { success: true, transaction: '' }), { outcome: 'evidence', status: 200, serverReportsSuccess: true, consistent: false, mismatch: 'transaction' });
    });

    it('RESP-3 a failure with an empty transaction (nothing broadcast) claims no payment: structurally valid', () => {
      assert.deepEqual(responded(402, { success: false, errorReason: 'insufficient_funds', transaction: '' }), { outcome: 'evidence', status: 402, serverReportsSuccess: false, consistent: true, errorReason: 'insufficient_funds' });
    });

    it('RESP-4 a failure naming another transaction is inconsistent', () => {
      assert.deepEqual(responded(402, { success: false, errorReason: 'invalid_exact_lnbtc_preimage_hash_mismatch', transaction: OTHER }), { outcome: 'evidence', status: 402, serverReportsSuccess: false, consistent: false, mismatch: 'transaction', errorReason: 'invalid_exact_lnbtc_preimage_hash_mismatch' });
    });

    it('RESP-5 settlement_pending naming the governed payment is consistent', () => {
      assert.deepEqual(responded(402, { success: false, errorReason: 'settlement_pending', transaction: GOVERNED }), { outcome: 'evidence', status: 402, serverReportsSuccess: false, consistent: true, errorReason: 'settlement_pending' });
    });

    it('RESP-6 settlement_pending naming another transaction is inconsistent', () => {
      assert.deepEqual(responded(402, { success: false, errorReason: 'settlement_pending', transaction: OTHER }), { outcome: 'evidence', status: 402, serverReportsSuccess: false, consistent: false, mismatch: 'transaction', errorReason: 'settlement_pending' });
    });

    it('RESP-7 settlement_pending without a transaction is not a SettlementResponse: unreadable', () => {
      assert.deepEqual(responded(402, { success: false, errorReason: 'settlement_pending', transaction: '' }), { outcome: 'unreadable', violation: 'settlement-response-pending-without-transaction' });
    });
  });
});
