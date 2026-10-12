import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createMonetaryAssetRegistry } from '../../monetary-runtime/index.js';
import {
  PAYMENT_PROTOCOL_EVIDENCE_LIMITS,
  PAYMENT_PROTOCOL_REFUSALS,
  PAYMENT_PROTOCOL_RESERVED_CONTEXT_KEYS,
  compilePaymentIntent,
  createPaymentGovernanceBinding,
  isPaymentProtocolReservedContextKey,
  parsePaymentContentDigest,
  paymentContentDigestsAgree,
  paymentIntentOfProtocolTerms,
  readPaymentProtectedRequest,
  readPaymentProtocolChallengeEvidence,
  readPaymentProtocolInterpretation,
  snapshotPaymentIntent,
} from '../index.js';

/**
 * PAY-04 — the protocol-neutral adapter port, on its own: an adapter's answer
 * is untrusted executable output, read once and closed; protocol terms become
 * the **canonical** `PaymentIntent` through PAY-01's own validator and compile
 * through PAY-01's own compiler. No second payment model.
 */

const ASSETS = createMonetaryAssetRegistry([{ assetId: 'USD', scale: 2 }]);
const TRUST = { assets: ASSETS };
const TERMS = { destination: { kind: 'account', reference: 'vendor-4471' }, amount: { value: '10.50', unit: 'USD' }, reference: 'ORD-1' };
const EVIDENCE = { key: '["realm","id"]', fields: { id: 'id', realm: 'realm' } };

describe('PAY-04 port — the adapter answer is read closed', () => {
  it('accepts exactly an interpretation, canonicalizing money through P9', () => {
    const read = readPaymentProtocolInterpretation({ interpreted: true, terms: TERMS, challenge: EVIDENCE }, TRUST);
    assert.equal(read?.interpreted, true);
    assert.deepEqual(read?.interpreted ? read.terms.amount : undefined, { value: '10.5', unit: 'USD' });
    assert.deepEqual(readPaymentProtocolInterpretation({ interpreted: false, refusal: 'challenge-expired' }, TRUST), { interpreted: false, refusal: 'challenge-expired' });
  });

  it('refuses anything else: authority-shaped keys, trusted-half keys, accessors, non-plain objects, unknown refusals, mixed shapes', () => {
    const answers: unknown[] = [
      { interpreted: true, terms: TERMS, challenge: EVIDENCE, authorized: true },
      { interpreted: true, terms: { ...TERMS, source: { accountId: 'treasury' } }, challenge: EVIDENCE },
      { interpreted: true, terms: { ...TERMS, idempotencyKey: 'k' }, challenge: EVIDENCE },
      { interpreted: true, terms: { ...TERMS, purpose: 'payroll' }, challenge: EVIDENCE },
      { interpreted: true, terms: { ...TERMS, ceiling: '1000000' }, challenge: EVIDENCE },
      { interpreted: true, terms: { ...TERMS, amount: { value: 10.5, unit: 'USD' } }, challenge: EVIDENCE },
      { interpreted: true, terms: { ...TERMS, amount: { value: '1e1', unit: 'USD' } }, challenge: EVIDENCE },
      { interpreted: true, terms: { ...TERMS, amount: { value: '0', unit: 'USD' } }, challenge: EVIDENCE },
      { interpreted: true, terms: { ...TERMS, amount: { value: '10.001', unit: 'USD' } }, challenge: EVIDENCE },
      { interpreted: true, terms: { ...TERMS, amount: { value: '10', unit: 'GBP' } }, challenge: EVIDENCE },
      { interpreted: true, terms: { ...TERMS, destination: { kind: 'account', reference: 'https://evil' } }, challenge: EVIDENCE },
      { interpreted: true, terms: { ...TERMS, rail: 'Not A Rail' }, challenge: EVIDENCE },
      { interpreted: true, terms: TERMS },
      { interpreted: true, terms: TERMS, challenge: EVIDENCE, refusal: 'challenge-invalid' },
      { interpreted: false, refusal: 'allowed' },
      { interpreted: 'yes', terms: TERMS, challenge: EVIDENCE },
      Object.defineProperty({ terms: TERMS, challenge: EVIDENCE }, 'interpreted', { get: () => true, enumerable: true }),
      Promise.resolve({ interpreted: true, terms: TERMS, challenge: EVIDENCE }),
      new Proxy({}, { ownKeys: () => { throw new Error('trap'); } }),
      undefined,
      null,
    ];
    for (const [index, answer] of answers.entries()) assert.equal(readPaymentProtocolInterpretation(answer, TRUST), undefined, `answer ${index}`);
  });

  it('evidence is public, closed and bounded: a secret-shaped field name refuses the whole answer', () => {
    for (const name of ['authorization', 'credential', 'privateKey', 'seed', 'api_key', 'bearer']) {
      assert.equal(readPaymentProtocolChallengeEvidence({ key: 'k', fields: { id: 'a', [name.toLowerCase()]: 'x' } }), undefined, name);
    }
    assert.equal(readPaymentProtocolChallengeEvidence({ key: 'k', fields: {} }), undefined);
    assert.equal(readPaymentProtocolChallengeEvidence({ key: 'k', fields: { id: 'a\nb' } }), undefined);
    assert.equal(readPaymentProtocolChallengeEvidence({ key: 'k', fields: { id: 1 } }), undefined);
    assert.equal(readPaymentProtocolChallengeEvidence({ key: '', fields: { id: 'a' } }), undefined);
    assert.equal(readPaymentProtocolChallengeEvidence({ key: 'k'.repeat(PAYMENT_PROTOCOL_EVIDENCE_LIMITS.maxKeyLength + 1), fields: { id: 'a' } }), undefined);
    assert.equal(readPaymentProtocolChallengeEvidence({ key: 'k', fields: Object.fromEntries(Array.from({ length: 17 }, (_, index) => [`f${index}`, 'v'])) }), undefined);
    const evidence = readPaymentProtocolChallengeEvidence({ key: 'k', fields: { realm: 'r', id: 'a' } });
    assert.deepEqual(Object.keys(evidence?.fields ?? {}), ['id', 'realm'], 'sorted, null-prototype, frozen');
    assert.equal(Object.getPrototypeOf(evidence?.fields), null);
  });

  it('the refusal vocabulary is closed and protocol-neutral', () => {
    assert.deepEqual([...PAYMENT_PROTOCOL_REFUSALS], ['challenge-invalid', 'challenge-expired', 'challenge-unsupported', 'challenge-ambiguous', 'request-binding-mismatch', 'normalization-failed', 'counterparty-unresolved']);
  });
});

describe('PAY-04 port — protocol terms become the canonical PaymentIntent, compiled by PAY-01', () => {
  const read = readPaymentProtocolInterpretation({ interpreted: true, terms: TERMS, challenge: EVIDENCE }, TRUST);
  const terms = read !== undefined && read.interpreted ? read.terms : assert.fail('terms');

  it('the trusted half is never the protocol’s: source, purpose and key come from the caller', () => {
    const validation = paymentIntentOfProtocolTerms(terms, { source: { accountId: 'treasury-ops' }, purpose: 'purchase', idempotencyKey: 'aoc.pay.bop:abc' }, TRUST);
    assert.equal(validation.valid, true);
    if (!validation.valid) return;
    assert.deepEqual(validation.intent, {
      source: { accountId: 'treasury-ops' },
      destination: { kind: 'account', reference: 'vendor-4471' },
      amount: { value: '10.5', unit: 'USD' },
      purpose: 'purchase',
      reference: 'ORD-1',
      idempotencyKey: 'aoc.pay.bop:abc',
    });
    assert.equal(snapshotPaymentIntent(validation.intent) !== undefined, true, 'it is the canonical PaymentIntent');
    const compiled = compilePaymentIntent(validation.intent, createPaymentGovernanceBinding({ action: 'payment.execute' }));
    assert.deepEqual(compiled, {
      action: 'payment.execute',
      resource: 'treasury-ops',
      counterparty: 'account:vendor-4471',
      amount: { value: '10.5', currency: 'USD' },
      parameters: { paymentPurpose: 'purchase', paymentReference: 'ORD-1' },
      idempotencyKey: 'aoc.pay.bop:abc',
    });
    assert.equal(JSON.stringify(compiled).includes('realm'), false, 'no protocol field reaches the governed intent');
  });

  it('an invalid trusted half is refused by PAY-01, not repaired', () => {
    assert.equal(paymentIntentOfProtocolTerms(terms, { source: { accountId: 'a/b' }, purpose: 'purchase', idempotencyKey: 'k' }, TRUST).valid, false);
    assert.equal(paymentIntentOfProtocolTerms(terms, { source: { accountId: 'a' }, purpose: 'bribe' as never, idempotencyKey: 'k' }, TRUST).valid, false);
  });
});

describe('PAY-04 port — the trusted protected request and RFC 9530 binding', () => {
  const sha = (fill: number) => `sha-256=:${Buffer.alloc(32, fill).toString('base64')}:`;

  it('canonicalizes the request digest and marks the request body-bearing', () => {
    const binding = readPaymentProtectedRequest({ target: 'merchant:orders', method: 'PATCH', contentDigest: sha(1), expectedRealm: 'api.merchant.example' });
    assert.deepEqual(binding && { ...binding, contentDigest: binding.contentDigest?.canonical }, { target: 'merchant:orders', method: 'PATCH', expectedRealm: 'api.merchant.example', bodyBearing: true, contentDigest: sha(1) });
    assert.equal(readPaymentProtectedRequest({ target: 'merchant:report', method: 'GET' })?.bodyBearing, false);
    assert.equal(readPaymentProtectedRequest({ target: 'merchant:report', method: 'DELETE', contentDigest: sha(1) })?.bodyBearing, true, 'a digested request is body-bearing whatever its method');
  });

  it('digests agree only on a shared algorithm with an equal value', () => {
    const a = parsePaymentContentDigest(sha(1));
    const b = parsePaymentContentDigest(`${sha(1)}, sha-512=:${Buffer.alloc(64, 2).toString('base64')}:`);
    const c = parsePaymentContentDigest(sha(2));
    const d = parsePaymentContentDigest(`sha-512=:${Buffer.alloc(64, 2).toString('base64')}:`);
    assert.ok(a !== undefined && b !== undefined && c !== undefined && d !== undefined);
    assert.equal(paymentContentDigestsAgree(a, b), true);
    assert.equal(paymentContentDigestsAgree(a, c), false);
    assert.equal(paymentContentDigestsAgree(a, d), false, 'no shared algorithm binds nothing');
  });
});

describe('PAY-04 port — reserved context keys go through the CORE-03 registry (L-7)', () => {
  it('names protocol-neutral words only, each in the registry’s own grammar', () => {
    for (const key of PAYMENT_PROTOCOL_RESERVED_CONTEXT_KEYS) {
      assert.equal(isPaymentProtocolReservedContextKey(key), true, key);
      assert.equal(/mpp|x402/i.test(key), false, key);
    }
    assert.ok(PAYMENT_PROTOCOL_RESERVED_CONTEXT_KEYS.includes('businessOperationId'));
    assert.ok(PAYMENT_PROTOCOL_RESERVED_CONTEXT_KEYS.includes('paymentChallenge'));
  });
});
