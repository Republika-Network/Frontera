import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { readPaymentProtectedRequest } from '../../features/payment-runtime/index.js';
import { parseX402Json, readX402PaymentRequiredCarrier, type X402BindingRequest, type X402PaymentRequirements } from '../../features/payment-runtime/protocols/x402/index.js';
import { SPEC_LNBTC_VECTOR } from '../../features/payment-runtime/protocols/x402/tests/x402-spec-vectors.js';
import { decodeBolt11Invoice } from '../../features/payment-runtime/rails/lightning/index.js';
import { buildInvoice, testNodeKey, testPreimage, TEST_NOW_SECONDS } from '../../features/payment-runtime/rails/lightning/tests/lightning-test-fixtures.js';
import type { VerifiedPaymentProtocolContext } from '../payment-protocol-ingress/index.js';
import {
  X402_LNBTC_NETWORKS,
  createX402LightningBinding,
  createX402LightningInvoiceVerifier,
  createX402PaymentSignatureBuilder,
  readX402PaymentResponseEvidence,
  x402LightningBindingId,
  x402LightningHttpRequestHash,
  type X402LightningProofSource,
} from '../x402-payment-protocol/index.js';
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

  it('the verifier serves the rail only verified invoices, by payment hash and payee', async () => {
    const verifier = createX402LightningInvoiceVerifier();
    await verifier.verify(SPEC_LNBTC_VECTOR.requirement.extra.invoice);
    const query = { payee: SPEC_LNBTC_VECTOR.requirement.payTo, paymentHash: SPEC_LNBTC_VECTOR.paymentHash, executionId: 'e' };
    assert.equal(await verifier.invoices.invoiceFor(query), SPEC_LNBTC_VECTOR.requirement.extra.invoice);
    assert.equal(await verifier.invoices.invoiceFor({ ...query, payee: `02${'7'.repeat(64)}` }), undefined, 'another payee: withheld, never redirected');
    assert.equal(await verifier.invoices.invoiceFor({ ...query, paymentHash: 'f'.repeat(64) }), undefined);
  });
});

describe('PAY-08 — one payment hash, one invoice text (INV-COLL)', () => {
  const URL_A = 'https://merchant.example/article/A';
  const URL_B = 'https://merchant.example/article/B';
  const hashOf = (url: string) => x402LightningHttpRequestHash({ url, method: 'GET', bodyBearing: false, fields: {} }, []) as string;

  /** A validly signed testnet invoice committing to `url`'s http:1 request hash, for `label`'s payment hash. */
  async function invoiceFor(label: string, url: string, options: { readonly amountMsat?: bigint; readonly payeeKeyLabel?: string } = {}): Promise<string> {
    const { paymentHash } = testPreimage(label);
    return buildInvoice({ network: 'testnet', amountMsat: options.amountMsat ?? 25_000n, paymentHash, payeeKeyLabel: options.payeeKeyLabel ?? 'payee-node', description: merchantBindingText({ method: 'GET', url }, []), descriptionHash: true, expirySeconds: 300, timestamp: TEST_NOW_SECONDS });
  }

  async function requirementWith(invoice: string, url: string): Promise<X402PaymentRequirements> {
    const decoded = await decodeBolt11Invoice(invoice);
    assert.ok(decoded.valid);
    return requirementOf({ scheme: 'exact', network: TESTNET, amount: '25000', asset: 'BTC', payTo: decoded.invoice.payee, maxTimeoutSeconds: 300, extra: { paymentFlow: 'upfront', requestHash: hashOf(url), requestBindingProfile: 'http:1', requestBindingParams: { headers: [] }, invoice } }, url);
  }

  /** A and B: same payment hash, payee, amount and network; different signed description hash (A commits to article A, B to article B). */
  async function collidingPair(label = 'pay08-collision') {
    const a = await invoiceFor(label, URL_A);
    const b = await invoiceFor(label, URL_B);
    const [readA, readB] = await Promise.all([decodeBolt11Invoice(a), decodeBolt11Invoice(b)]);
    assert.ok(readA.valid && readB.valid);
    assert.notEqual(a, b);
    assert.equal(readA.invoice.paymentHash, readB.invoice.paymentHash);
    assert.equal(readA.invoice.payee, readB.invoice.payee);
    assert.equal(readA.invoice.amountMsat, readB.invoice.amountMsat);
    assert.equal(readA.invoice.network, readB.invoice.network);
    assert.notEqual(readA.invoice.descriptionHash, readB.invoice.descriptionHash);
    assert.equal(readA.invoice.descriptionHash, hashOf(URL_A), 'the fixture commits to the http:1 hash of article A');
    return { a, b, paymentHash: readA.invoice.paymentHash, payee: readA.invoice.payee };
  }

  const query = (pair: { readonly paymentHash: string; readonly payee: string }) => ({ paymentHash: pair.paymentHash, payee: pair.payee, executionId: 'exe-1' });

  it('INV-COLL-1 a verified invoice is the one the rail is given, exactly', async () => {
    const { a, ...pair } = await collidingPair();
    const verifier = createX402LightningInvoiceVerifier();
    await verifier.verify(a);
    assert.equal(await verifier.invoices.invoiceFor(query(pair)), a);
    assert.equal(verifier.verified(a)?.paymentHash, pair.paymentHash);
  });

  it('INV-COLL-2 verifying the same text again keeps it the hash’s one invoice', async () => {
    const { a, ...pair } = await collidingPair();
    const verifier = createX402LightningInvoiceVerifier();
    await verifier.verify(a);
    await verifier.verify(a);
    assert.equal(await verifier.invoices.invoiceFor(query(pair)), a);
  });

  it('INV-COLL-3 a second, different, validly signed text for the same payment hash makes the hash ambiguous: the rail gets nothing', async () => {
    const { a, b, ...pair } = await collidingPair();
    const verifier = createX402LightningInvoiceVerifier();
    await verifier.verify(a);
    await verifier.verify(b);
    assert.equal(await verifier.invoices.invoiceFor(query(pair)), undefined, 'never first-wins');
    assert.equal(verifier.verified(a), undefined, 'A is no longer a reading either');
    assert.equal(verifier.verified(b), undefined, 'never latest-wins');
    // Order does not matter.
    const reversed = createX402LightningInvoiceVerifier();
    await reversed.verify(b);
    await reversed.verify(a);
    assert.equal(await reversed.invoices.invoiceFor(query(pair)), undefined);
  });

  it('INV-COLL-4 B verifies on its own — but after A, the rail is never handed A for B (nor B)', async () => {
    const { a, b, ...pair } = await collidingPair();
    const alone = createX402LightningInvoiceVerifier();
    const bindingAlone = createX402LightningBinding({ network: 'testnet', verifier: alone });
    const requirementB = await requirementWith(b, URL_B);
    await bindingAlone.prepare?.(requirementB);
    assert.equal(bindingAlone.interpret(bindingRequest(requirementB, { url: URL_B, atSeconds: TEST_NOW_SECONDS })).usable, true, 'B is a valid invoice for article B');
    assert.equal(await alone.invoices.invoiceFor(query(pair)), b);

    const shared = createX402LightningInvoiceVerifier();
    await shared.verify(a);
    await shared.verify(b);
    const served = await shared.invoices.invoiceFor(query(pair));
    assert.notEqual(served, a, 'the signed description hash is part of what is paid for');
    assert.equal(served, undefined);
  });

  it('INV-COLL-5 a PaymentRequired carrying B after A was cached is refused at interpretation: nothing to govern, nothing to send', async () => {
    const { a, b, ...pair } = await collidingPair();
    const verifier = createX402LightningInvoiceVerifier();
    const binding = createX402LightningBinding({ network: 'testnet', verifier });
    const requirementA = await requirementWith(a, URL_A);
    const requirementB = await requirementWith(b, URL_B);
    // A arrives first (for article A — a request this agent may never govern), then B for article B.
    await binding.prepare?.(requirementA);
    await binding.prepare?.(requirementB);
    assert.deepEqual(binding.interpret(bindingRequest(requirementB, { url: URL_B, atSeconds: TEST_NOW_SECONDS })), { usable: false, refusal: 'normalization-failed' });
    assert.deepEqual(binding.interpret(bindingRequest(requirementA, { url: URL_A, atSeconds: TEST_NOW_SECONDS })), { usable: false, refusal: 'normalization-failed' });
    assert.equal(await verifier.invoices.invoiceFor(query(pair)), undefined);
  });

  it('INV-COLL-5 B governed first, A seen before the rail asks: the rail is withheld every invoice for the hash', async () => {
    const { a, b, ...pair } = await collidingPair();
    const verifier = createX402LightningInvoiceVerifier();
    const binding = createX402LightningBinding({ network: 'testnet', verifier });
    const requirementB = await requirementWith(b, URL_B);
    await binding.prepare?.(requirementB);
    assert.equal(binding.interpret(bindingRequest(requirementB, { url: URL_B, atSeconds: TEST_NOW_SECONDS })).usable, true);
    await verifier.verify(a);
    assert.equal(await verifier.invoices.invoiceFor(query(pair)), undefined, 'PAY-06 refuses invoice-unavailable before any node call');
  });

  it('INV-COLL-6 the same text presented again (exact replay) still verifies and is still served', async () => {
    const { a, ...pair } = await collidingPair();
    const verifier = createX402LightningInvoiceVerifier();
    const binding = createX402LightningBinding({ network: 'testnet', verifier });
    const requirementA = await requirementWith(a, URL_A);
    for (let round = 0; round < 3; round += 1) {
      await binding.prepare?.(requirementA);
      assert.equal(binding.interpret(bindingRequest(requirementA, { url: URL_A, atSeconds: TEST_NOW_SECONDS })).usable, true);
      assert.equal(await verifier.invoices.invoiceFor(query(pair)), a);
    }
  });

  it('INV-COLL-7 cache pressure never clears a collision, nor lets a substitute take an evicted text’s hash', async () => {
    const { a, b, ...pair } = await collidingPair();
    const fillers = await Promise.all(['pay08-filler-1', 'pay08-filler-2', 'pay08-filler-3'].map((label) => invoiceFor(label, URL_A)));
    // Ambiguity survives eviction of both readings.
    const verifier = createX402LightningInvoiceVerifier({ maximumEntries: 2 });
    await verifier.verify(a);
    await verifier.verify(b);
    for (const filler of fillers) await verifier.verify(filler);
    assert.equal(verifier.verified(fillers[2] as string)?.amountMsat, 25_000n, 'the memo is still working');
    await verifier.verify(a);
    await verifier.verify(b);
    assert.equal(verifier.verified(a), undefined);
    assert.equal(verifier.verified(b), undefined);
    assert.equal(await verifier.invoices.invoiceFor(query(pair)), undefined);

    // A evicted (perhaps governed and on its way to the rail): B may not take the hash over.
    const pressured = createX402LightningInvoiceVerifier({ maximumEntries: 2 });
    await pressured.verify(a);
    for (const filler of fillers) await pressured.verify(filler);
    assert.equal(pressured.verified(a), undefined, 'A’s reading was evicted');
    await pressured.verify(b);
    assert.equal(pressured.verified(b), undefined, 'the hash is not fresh just because A was evicted');
    assert.equal(await pressured.invoices.invoiceFor(query(pair)), undefined);
  });

  it('INV-COLL-7 the identity record is bounded: once full, a new payment hash is refused, never an old one forgotten', async () => {
    const { a, ...pair } = await collidingPair();
    const other = await invoiceFor('pay08-filler-1', URL_A);
    const verifier = createX402LightningInvoiceVerifier({ maximumEntries: 1, maximumPaymentHashes: 1 });
    await verifier.verify(a);
    await verifier.verify(other);
    assert.equal(verifier.verified(other), undefined, 'refused, not remembered');
    assert.equal(verifier.verified(a)?.paymentHash, pair.paymentHash);
    assert.equal(await verifier.invoices.invoiceFor(query(pair)), a);
    assert.throws(() => createX402LightningInvoiceVerifier({ maximumEntries: 8, maximumPaymentHashes: 4 }), TypeError);
    assert.throws(() => createX402LightningInvoiceVerifier({ maximumPaymentHashes: 262_145 }), TypeError);
  });

  it('INV-COLL-8 a recomposed memo starts empty and serves nothing it has not verified itself (conservative restart)', async () => {
    const { a, b, ...pair } = await collidingPair();
    const before = createX402LightningInvoiceVerifier();
    await before.verify(a);
    assert.equal(await before.invoices.invoiceFor(query(pair)), a);
    const after = createX402LightningInvoiceVerifier();
    assert.equal(await after.invoices.invoiceFor(query(pair)), undefined, 'nothing carried over: a payment is never resumed through the memo');
    await after.verify(b);
    await after.verify(a);
    assert.equal(await after.invoices.invoiceFor(query(pair)), undefined, 'the same collision is detected again from scratch');
  });

  it('another node reusing the payment hash is another (payee, hash) pair: it is never served for this payee, and cannot poison it', async () => {
    const { a, ...pair } = await collidingPair();
    const foreign = await invoiceFor('pay08-collision', URL_A, { payeeKeyLabel: 'other-payee-node' });
    const decoded = await decodeBolt11Invoice(foreign);
    assert.ok(decoded.valid);
    assert.equal(decoded.invoice.paymentHash, pair.paymentHash);
    assert.notEqual(decoded.invoice.payee, pair.payee);
    const verifier = createX402LightningInvoiceVerifier();
    await verifier.verify(a);
    await verifier.verify(foreign);
    assert.equal(await verifier.invoices.invoiceFor(query(pair)), a, 'this payee’s one text, exactly');
    assert.equal(await verifier.invoices.invoiceFor({ ...query(pair), payee: decoded.invoice.payee }), foreign, 'and the other payee’s, never crossed');
  });

  it('the rail is served only for the payee of the verified text — and only that text', async () => {
    const { a, ...pair } = await collidingPair();
    const verifier = createX402LightningInvoiceVerifier();
    await verifier.verify(a);
    assert.equal(await verifier.invoices.invoiceFor({ ...query(pair), payee: `02${'7'.repeat(64)}` }), undefined);
    assert.equal(await verifier.invoices.invoiceFor({ ...query(pair), paymentHash: 'f'.repeat(64) }), undefined);
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
