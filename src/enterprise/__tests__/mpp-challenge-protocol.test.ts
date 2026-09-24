import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  MPP_CHALLENGE_LIMITS,
  canonicalContentDigest,
  computeContentDigest,
  contentDigestsMatch,
  decodeCanonicalJsonObject,
  isMppChallengeUsableAt,
  mppCredentialHeaderField,
  parseContentDigest,
  parsePaymentChallenge,
  parseWwwAuthenticate,
  rfc3339EpochMilliseconds,
  type PaymentChallengeParse,
} from '../mpp-challenge/protocol.js';
import { encodeJcs, paymentChallenge } from './mpp-challenge-support.js';

/**
 * P13 — the MPP `Payment` challenge, parsed and validated client-side.
 *
 * Baseline: `draft-httpauth-payment-01` (tempoxyz/mpp-specs `08e7dd8`). The
 * official repository ships no client parsing vectors; the only official
 * vectors are its server-side HMAC ones, whose `request` / `opaque`
 * encodings and resulting ids are reused below as parse vectors (CC0). Every
 * other case is built directly from the draft's normative text.
 */

function one(header: string | readonly string[]): PaymentChallengeParse {
  const parsed = parseWwwAuthenticate(header);
  assert.equal(parsed.valid, true, parsed.valid ? '' : parsed.violation);
  if (!parsed.valid) throw new Error('unreachable');
  const payment = parsed.challenges.filter((challenge) => challenge.scheme.toLowerCase() === 'payment');
  assert.equal(payment.length, 1);
  return parsePaymentChallenge(payment[0] ?? assert.fail('no challenge'));
}

function valid(header: string) {
  const parsed = one(header);
  assert.equal(parsed.valid, true, parsed.valid ? '' : parsed.violation);
  if (!parsed.valid) throw new Error('unreachable');
  return parsed.challenge;
}

function invalid(header: string, pattern?: RegExp): void {
  const parsed = parseWwwAuthenticate(header);
  if (!parsed.valid) return;
  const payment = parsed.challenges.filter((challenge) => challenge.scheme.toLowerCase() === 'payment');
  for (const raw of payment) {
    const result = parsePaymentChallenge(raw);
    assert.equal(result.valid, false, `expected ${header} to be refused`);
    if (!result.valid && pattern !== undefined) assert.match(result.violation, pattern);
  }
}

// The draft's HMAC test-vector inputs (CC0): request {"amount":"1000000"} and opaque {"pi":"pi_123"}.
const VECTOR_REQUEST = 'eyJhbW91bnQiOiIxMDAwMDAwIn0';
const VECTOR_OPAQUE = 'eyJwaSI6InBpXzEyMyJ9';
const VECTOR_ID = 'X6v1eo7fJ76gAxqY0xN9Jd__4lUyDDYmriryOM-5FO4';
const VECTOR_ID_HEADER = 'CJ4X1O4aTDmS59hfdhnhBtxIQjWDOf0bcrhsswwMOW8';

describe('P13 §184 — a valid Payment challenge and its required parameters', () => {
  it('parses the draft vector exactly, preserving every accepted string unchanged', () => {
    const challenge = valid(`Payment id="${VECTOR_ID}", realm="api.example.com", method="tempo", intent="charge", request="${VECTOR_REQUEST}"`);
    assert.equal(challenge.id, VECTOR_ID);
    assert.equal(challenge.realm, 'api.example.com');
    assert.equal(challenge.method, 'tempo');
    assert.equal(challenge.intent, 'charge');
    assert.equal(challenge.request, VECTOR_REQUEST, 'the raw base64url request is kept, never re-encoded');
    assert.deepEqual(challenge.decodedRequest, { amount: '1000000' });
    assert.equal(Object.isFrozen(challenge), true);
    assert.equal(Object.isFrozen(challenge.decodedRequest), true);
    assert.equal(mppCredentialHeaderField(challenge), 'Authorization');
  });

  it('parses token (unquoted) parameter values and a case-insensitive scheme and parameter names', () => {
    const challenge = valid(`payment ID=abc, Realm=api.example.com, METHOD=tempo, intent=charge, request=${VECTOR_REQUEST}`);
    assert.equal(challenge.id, 'abc');
    assert.equal(challenge.method, 'tempo');
  });

  for (const missing of ['id', 'realm', 'method', 'intent', 'request']) {
    it(`refuses a challenge missing '${missing}'`, () => {
      const params = { id: '"a"', realm: '"r"', method: '"tempo"', intent: '"charge"', request: `"${VECTOR_REQUEST}"` } as Record<string, string>;
      delete params[missing];
      invalid(`Payment ${Object.entries(params).map(([key, value]) => `${key}=${value}`).join(', ')}`, new RegExp(missing));
    });
  }

  it('refuses an empty id after quoted-string unescaping', () => {
    invalid(`Payment id="", realm="r", method="tempo", intent="charge", request="${VECTOR_REQUEST}"`, /id/);
  });

  it('refuses an uppercase, digit-bearing or hyphenated method (1*LOWERALPHA)', () => {
    for (const method of ['Tempo', 'TEMPO', 'x402', 'tempo-v2', 'tem_po']) invalid(paymentChallenge({ method }), /method/);
  });

  it('refuses an intent outside ALPHA / DIGIT / "-"', () => {
    for (const intent of ['char ge', 'charge!', 'charge/v1']) invalid(paymentChallenge({ intent }), /intent/);
  });

  for (const duplicate of ['id', 'method', 'request', 'realm', 'intent', 'expires', 'opaque', 'header', 'digest']) {
    it(`refuses a duplicated '${duplicate}' — never first-wins, never last-wins`, () => {
      const extraValue = duplicate === 'request' ? encodeJcs({ amount: '1' }) : duplicate === 'expires' ? '2026-09-24T12:06:00Z' : duplicate === 'opaque' ? encodeJcs({ a: 'b' }) : duplicate === 'header' ? 'Payment-Authorization' : duplicate === 'digest' ? computeContentDigest('x') : 'other';
      const base = paymentChallenge({ opaque: { x: 'y' }, header: 'Payment-Authorization', digest: computeContentDigest('y') });
      assert.equal(valid(base).id, 'ch-1', 'the base challenge is valid on its own');
      invalid(`${base}, ${duplicate}="${extraValue}"`, /duplicate/);
    });
  }

  it('refuses a duplicate that differs only in parameter-name case', () => {
    invalid(`${paymentChallenge()}, ID="other"`, /duplicate/);
  });

  it('ignores unknown parameters — they are never retained', () => {
    const challenge = valid(paymentChallenge({ extra: 'amount="999999", counterparty="evil", authorized="true", x-future=token' }));
    assert.deepEqual(Object.keys(challenge).sort(), ['decodedRequest', 'expires', 'id', 'intent', 'method', 'realm', 'request'].sort());
  });
});

describe('P13 §36 / §184 — HTTP-auth tokenization is standards-correct, never a comma split', () => {
  it('keeps commas, equals signs and escaped quotes inside quoted strings as data', () => {
    const challenge = valid(paymentChallenge({ id: 'a,b="c",d', description: 'Pay, then "enjoy" = fun' }));
    assert.equal(challenge.id, 'a,b="c",d');
    assert.equal(challenge.description, 'Pay, then "enjoy" = fun');
  });

  it('parses several challenges of several schemes in one field value', () => {
    const parsed = parseWwwAuthenticate(`Bearer realm="api", error="invalid_token", ${paymentChallenge({ id: 'one' })}, Basic realm="x", ${paymentChallenge({ id: 'two', method: 'altpay' })}`);
    assert.equal(parsed.valid, true);
    if (!parsed.valid) return;
    assert.deepEqual(parsed.challenges.map((challenge) => challenge.scheme), ['Bearer', 'Payment', 'Basic', 'Payment']);
    const ids = parsed.challenges.filter((challenge) => challenge.scheme === 'Payment').map((challenge) => parsePaymentChallenge(challenge)).map((result) => (result.valid ? result.challenge.id : 'x'));
    assert.deepEqual(ids, ['one', 'two']);
  });

  it('parses challenges spread over several field values, and a token68 scheme between them', () => {
    const parsed = parseWwwAuthenticate([paymentChallenge({ id: 'one' }), 'Negotiate abc123==', paymentChallenge({ id: 'two' })]);
    assert.equal(parsed.valid, true);
    if (parsed.valid) assert.equal(parsed.challenges.length, 3);
  });

  it('refuses a malformed quoted string, a stray token and control characters', () => {
    for (const header of [
      'Payment id="unterminated, realm="r"',
      'Payment id="a" realm="r"',
      'Payment id=, realm="r"',
      `${paymentChallenge()}\r\nSet-Cookie: x=y`,
      `Payment id="a\u0000", realm="r"`,
      'Payment id="€"',
    ]) {
      assert.equal(parseWwwAuthenticate(header).valid, false, header);
    }
  });

  it('refuses a Payment challenge in token68 form', () => {
    invalid('Payment eyJhbW91bnQiOiIxMDAwMDAwIn0=', /token68/);
  });

  it('bounds the header, the number of challenges and the number of parameters', () => {
    assert.equal(parseWwwAuthenticate('a'.repeat(MPP_CHALLENGE_LIMITS.maxHeaderLength + 1)).valid, false);
    assert.equal(parseWwwAuthenticate(Array.from({ length: MPP_CHALLENGE_LIMITS.maxChallenges + 1 }, (_, index) => `Basic realm="r${String(index)}"`).join(', ')).valid, false);
    assert.equal(parseWwwAuthenticate(`Payment ${Array.from({ length: MPP_CHALLENGE_LIMITS.maxParams + 1 }, (_, index) => `p${String(index)}=v`).join(', ')}`).valid, false);
    assert.equal(parseWwwAuthenticate(Array.from({ length: MPP_CHALLENGE_LIMITS.maxHeaderValues + 1 }, () => paymentChallenge())).valid, false);
    assert.equal(parseWwwAuthenticate(`Payment id="${'x'.repeat(MPP_CHALLENGE_LIMITS.maxParamValueLength + 1)}"`).valid, false);
    assert.equal(parseWwwAuthenticate([]).valid, false);
    assert.equal(parseWwwAuthenticate(42).valid, false);
    assert.equal(parseWwwAuthenticate([paymentChallenge(), 7]).valid, false);
  });
});

describe('P13 §38–§41 / §185 — base64url and JCS', () => {
  it('accepts canonical base64url JCS and keeps the raw text', () => {
    const request = encodeJcs({ amount: '1000', currency: 'usd', recipient: 'acct_123' });
    assert.equal(valid(paymentChallenge({ rawRequest: request })).request, request);
  });

  it('refuses padding, the standard alphabet, and non-canonical trailing bits', () => {
    invalid(paymentChallenge({ rawRequest: `${VECTOR_REQUEST}=` }), /base64url/);
    invalid(paymentChallenge({ rawRequest: Buffer.from('{"amount":"1000000"}>').toString('base64') }), /base64url/);
    invalid(paymentChallenge({ rawRequest: 'eyJhbW91bnQiOiIxMDAwMDAwIn1' }), /base64url|UTF-8|JSON/);
    invalid(paymentChallenge({ rawRequest: 'e' }), /base64url/);
  });

  it('refuses invalid UTF-8, invalid JSON and a non-object', () => {
    invalid(paymentChallenge({ rawRequest: Buffer.from([0x7b, 0xff, 0x7d]).toString('base64url') }), /UTF-8/);
    invalid(paymentChallenge({ rawRequest: Buffer.from('{"amount":').toString('base64url') }), /JSON/);
    invalid(paymentChallenge({ rawRequest: Buffer.from('["a"]').toString('base64url') }), /object/);
    invalid(paymentChallenge({ rawRequest: Buffer.from('"a"').toString('base64url') }), /object/);
  });

  it('refuses non-canonical JSON: whitespace, key order, duplicate keys, number spellings, escapes', () => {
    for (const text of ['{ "amount":"1"}', '{"b":"1","a":"2"}', '{"a":"1","a":"2"}', '{"a":1.0}', '{"a":1e2}', '{"a":"\\u0041"}', '{"a":"1"}\n']) {
      invalid(paymentChallenge({ rawRequest: Buffer.from(text).toString('base64url') }), /JCS/);
    }
  });

  it('refuses prototype-shaped member names anywhere, and never pollutes a prototype', () => {
    for (const text of ['{"__proto__":{"polluted":"yes"}}', '{"a":{"constructor":"x"}}', '{"a":[{"prototype":"x"}]}']) {
      invalid(paymentChallenge({ rawRequest: Buffer.from(text).toString('base64url') }), /forbidden member/);
    }
    assert.equal(({} as Record<string, unknown>)['polluted'], undefined);
  });

  it('bounds decoded size, depth and member count', () => {
    assert.equal(decodeCanonicalJsonObject(encodeJcs({ a: 'x'.repeat(MPP_CHALLENGE_LIMITS.maxRequestBytes) }), MPP_CHALLENGE_LIMITS.maxRequestBytes).valid, false);
    let deep: unknown = 'x';
    for (let depth = 0; depth < MPP_CHALLENGE_LIMITS.maxJsonDepth + 1; depth += 1) deep = { a: deep };
    const deepResult = decodeCanonicalJsonObject(encodeJcs(deep), MPP_CHALLENGE_LIMITS.maxRequestBytes);
    assert.equal(deepResult.valid, false);
    const wide = Object.fromEntries(Array.from({ length: MPP_CHALLENGE_LIMITS.maxJsonMembers + 1 }, (_, index) => [`k${String(index).padStart(3, '0')}`, 1]));
    assert.equal(decodeCanonicalJsonObject(encodeJcs(wide), 100_000).valid, false);
  });

  it('opaque: the draft vector parses as a flat string map and is kept unchanged', () => {
    const challenge = valid(`Payment id="${VECTOR_ID_HEADER}", realm="api.example.com", method="tempo", intent="charge", request="${VECTOR_REQUEST}", header="Payment-Authorization", opaque="${VECTOR_OPAQUE}"`);
    assert.equal(challenge.opaque, VECTOR_OPAQUE);
    assert.deepEqual(challenge.decodedOpaque, { pi: 'pi_123' });
    assert.equal(mppCredentialHeaderField(challenge), 'Payment-Authorization');
  });

  it('opaque: refuses nested maps, arrays, non-string values and non-canonical encodings', () => {
    for (const opaque of [{ a: { b: 'c' } }, { a: ['b'] }, { a: 1 }, { a: true }, { a: null }]) invalid(paymentChallenge({ opaque }), /opaque/);
    invalid(paymentChallenge({ rawOpaque: Buffer.from('["a"]').toString('base64url') }), /opaque/);
    invalid(paymentChallenge({ rawOpaque: Buffer.from('{"b":"1","a":"2"}').toString('base64url') }), /opaque/);
    invalid(paymentChallenge({ rawOpaque: `${VECTOR_OPAQUE}=` }), /opaque/);
  });
});

describe('P13 §186 — optional parameters', () => {
  it('expires: strict RFC 3339, and an injected instant decides usability', () => {
    const challenge = valid(paymentChallenge({ expires: '2026-09-24T12:05:00Z' }));
    assert.equal(isMppChallengeUsableAt(challenge, '2026-09-24T12:04:59.999Z'), true);
    assert.equal(isMppChallengeUsableAt(challenge, '2026-09-24T12:05:00.000Z'), false, 'at the expiry instant it is expired');
    assert.equal(isMppChallengeUsableAt(challenge, '2026-09-25T00:00:00.000Z'), false);
    assert.equal(isMppChallengeUsableAt({}, '2099-01-01T00:00:00.000Z'), true, 'no expires states no expiry');
    assert.equal(rfc3339EpochMilliseconds('2026-09-24T14:05:00+02:00'), Date.UTC(2026, 8, 24, 12, 5, 0));
    assert.equal(rfc3339EpochMilliseconds('2026-09-24T12:05:00.123456Z'), Date.UTC(2026, 8, 24, 12, 5, 0, 123));
    for (const expires of ['2026-09-24', '2026-09-24 12:05:00Z', '2026-02-30T00:00:00Z', '2026-09-24T24:00:00Z', '2026-09-24T12:05:60Z', 'tomorrow', '1758715500']) {
      invalid(paymentChallenge({ expires }), /expires/);
    }
  });

  it('digest: an RFC 9530 value parses, compares and canonicalizes', () => {
    const body = computeContentDigest('{"q":"report"}');
    const challenge = valid(paymentChallenge({ digest: body }));
    assert.equal(challenge.digest, body);
    const left = parseContentDigest(challenge.digest);
    const right = parseContentDigest(body);
    assert.ok(left !== undefined && right !== undefined);
    assert.equal(contentDigestsMatch(left, right), true);
    assert.equal(contentDigestsMatch(left, parseContentDigest(computeContentDigest('{"q":"other"}')) ?? new Map()), false, 'a different body does not match');
    const multi = `sha-512=:${Buffer.alloc(64, 1).toString('base64')}:, ${body}, unknown-alg=:AAAA:`;
    assert.equal(canonicalContentDigest(parseContentDigest(multi) ?? new Map()), `${body}, sha-512=:${Buffer.alloc(64, 1).toString('base64')}:`, 'unknown algorithms ignored, members sorted');
  });

  it('digest: refuses malformed values, wrong lengths, parameters, duplicates and unrecognized-only digests', () => {
    for (const digest of ['sha-256=X48E9qOokqqrvdts8nOJRJN3OWDUoyWxBf7kbu9DBPE=', 'sha-256=:AAAA:', `sha-256=:${Buffer.alloc(32).toString('base64')}:;a=1`, `${computeContentDigest('a')}, ${computeContentDigest('b')}`, 'md5=:AAAAAAAAAAAAAAAAAAAAAA==:', 'SHA-256=:x:']) {
      invalid(paymentChallenge({ digest }), /digest/);
    }
  });

  it('header: absent → Authorization; Payment-Authorization → Payment-Authorization; anything else refused', () => {
    assert.equal(mppCredentialHeaderField(valid(paymentChallenge())), 'Authorization');
    assert.equal(mppCredentialHeaderField(valid(paymentChallenge({ header: 'Payment-Authorization' }))), 'Payment-Authorization');
    for (const header of ['Authorization', 'payment-authorization', 'X-Payment', 'Cookie']) invalid(paymentChallenge({ header }), /header/);
  });

  it('description: harmless, bounded, display-only', () => {
    assert.equal(valid(paymentChallenge({ description: 'Premium report' })).description, 'Premium report');
    invalid(paymentChallenge({ description: 'x'.repeat(MPP_CHALLENGE_LIMITS.maxDescriptionLength + 1) }), /description/);
  });
});
