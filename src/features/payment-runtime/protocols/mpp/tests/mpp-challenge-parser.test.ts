import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parsePaymentContentDigest } from '../../../domain/index.js';
import {
  MPP_CHALLENGE_LIMITS,
  decodeBase64UrlNoPad,
  decodeCanonicalJsonObject,
  isMppChallengeUsableAt,
  mppChallengeFieldsOf,
  mppCredentialHeaderField,
  parseMppPaymentChallenge,
  parseWwwAuthenticate,
  rfc3339EpochMilliseconds,
  type MppChallengeParse,
} from '../index.js';
import { VECTOR_ID, VECTOR_OPAQUE, VECTOR_REQUEST, base64url, contentDigestOf, encodeJcs, paymentChallenge } from './mpp-test-support.js';

/**
 * PAY-04 layer A — the MPP challenge parser, held to `draft-httpauth-payment-01`
 * (mpp-specs `08e7dd8`) and RFC 9110 / 9530 / 3339 / 8785. Reviewed from P13
 * (`24dd264`) and re-proven here; no P13 test is assumed to prove anything.
 */

function onlyPayment(header: string | readonly string[]): MppChallengeParse {
  const parsed = parseWwwAuthenticate(header);
  assert.equal(parsed.valid, true, parsed.valid ? '' : parsed.violation);
  if (!parsed.valid) throw new Error('unreachable');
  const payment = parsed.challenges.filter((challenge) => challenge.scheme.toLowerCase() === 'payment');
  assert.equal(payment.length, 1);
  return parseMppPaymentChallenge(payment[0] ?? assert.fail('no challenge'));
}

function valid(header: string) {
  const parsed = onlyPayment(header);
  assert.equal(parsed.valid, true, parsed.valid ? '' : parsed.violation);
  if (!parsed.valid) throw new Error('unreachable');
  return parsed.challenge;
}

/** Refused either by the header grammar or by the challenge validator. */
function refused(header: string | readonly string[], pattern?: RegExp): void {
  const parsed = parseWwwAuthenticate(header);
  if (!parsed.valid) {
    if (pattern !== undefined) assert.match(parsed.violation, pattern);
    return;
  }
  const payment = parsed.challenges.filter((challenge) => challenge.scheme.toLowerCase() === 'payment');
  assert.ok(payment.length > 0, 'a Payment challenge was tokenized');
  for (const raw of payment) {
    const result = parseMppPaymentChallenge(raw);
    assert.equal(result.valid, false, `expected ${String(header)} to be refused`);
    if (!result.valid && pattern !== undefined) assert.match(result.violation, pattern);
  }
}

describe('PAY-04 A — a valid Payment challenge', () => {
  it('parses the draft vector exactly, keeping every accepted string unchanged and frozen', () => {
    const challenge = valid(`Payment id="${VECTOR_ID}", realm="api.example.com", method="tempo", intent="charge", request="${VECTOR_REQUEST}", opaque="${VECTOR_OPAQUE}"`);
    assert.equal(challenge.id, VECTOR_ID);
    assert.equal(challenge.request, VECTOR_REQUEST, 'never re-encoded');
    assert.deepEqual({ ...challenge.decodedRequest }, { amount: '1000000' });
    assert.deepEqual({ ...challenge.decodedOpaque }, { pi: 'pi_123' });
    assert.ok(Object.isFrozen(challenge) && Object.isFrozen(challenge.decodedRequest));
    assert.equal(mppCredentialHeaderField(challenge), 'Authorization');
    assert.deepEqual(Object.keys(mppChallengeFieldsOf(challenge)).sort(), ['id', 'intent', 'method', 'opaque', 'realm', 'request']);
  });

  it('accepts token values, a case-insensitive scheme and case-insensitive parameter names', () => {
    const challenge = valid(`payment ID=abc, Realm=api.example.com, METHOD=tempo, intent=charge, request=${VECTOR_REQUEST}`);
    assert.equal(challenge.id, 'abc');
    assert.equal(challenge.method, 'tempo');
  });

  it('keeps Payment-Authorization as the credential field when the challenge selects it', () => {
    assert.equal(mppCredentialHeaderField(valid(paymentChallenge({ header: 'Payment-Authorization' }))), 'Payment-Authorization');
  });

  it('drops description: validated, never retained as evidence', () => {
    const challenge = valid(paymentChallenge({ description: 'Report 42' }));
    assert.equal('description' in mppChallengeFieldsOf(challenge), false);
    refused(paymentChallenge({ description: 'x'.repeat(MPP_CHALLENGE_LIMITS.maxDescriptionLength + 1) }), /description/);
  });
});

describe('PAY-04 A — RFC 9110 tokenization (M1, M4, M5)', () => {
  it('M1: refuses malformed challenge grammar, refusing the whole field value', () => {
    for (const header of ['Payment id=', 'Payment =x', 'Payment id="a" realm="b"', 'Payment,id="a"', '"Payment" id="a"', 'Payment id="a",, , realm']) refused(header);
  });

  it('M4: refuses invalid quoting — unterminated, a bad quoted-pair, a raw control character', () => {
    refused('Payment id="abc, realm="r"', /unterminated|malformed/);
    refused(`${paymentChallenge()}, x="\\\u0001"`, /control|quoted-pair/);
    refused('Payment id="a\u0007b"', /control/);
  });

  it('a comma inside a quoted string is data, never a separator', () => {
    const challenge = valid(paymentChallenge({ realm: 'api.example.com, method=evil, id=forged' }));
    assert.equal(challenge.realm, 'api.example.com, method=evil, id=forged');
    assert.equal(challenge.id, 'ch-1');
    assert.equal(challenge.method, 'testpay');
  });

  it('quoted-pair unescapes exactly', () => {
    assert.equal(valid(paymentChallenge({ realm: 'a\\"b\\\\c' })).realm, 'a"b\\c');
  });

  it('M5: a token68 challenge is tokenized and never a Payment challenge; a token68 Payment challenge is refused', () => {
    const parsed = parseWwwAuthenticate(`Basic dXNlcjpwYXNz==, ${paymentChallenge()}`);
    assert.equal(parsed.valid, true);
    if (!parsed.valid) return;
    assert.deepEqual(
      parsed.challenges.map((challenge) => challenge.scheme),
      ['Basic', 'Payment'],
    );
    assert.equal(parsed.challenges[0]?.token68, 'dXNlcjpwYXNz==');
    refused('Payment abc.def', /token68/);
    refused('Basic abc def', /token68/);
  });

  it('several challenges per field value and several field values, in order', () => {
    const parsed = parseWwwAuthenticate([`Bearer realm="x", ${paymentChallenge({ id: 'a' })}`, paymentChallenge({ id: 'b' })]);
    assert.equal(parsed.valid, true);
    if (!parsed.valid) return;
    assert.deepEqual(
      parsed.challenges.map((challenge) => challenge.scheme),
      ['Bearer', 'Payment', 'Payment'],
    );
  });

  it('a field value that is not a string, a getter, or a sparse array is refused', () => {
    assert.equal(parseWwwAuthenticate(42).valid, false);
    assert.equal(parseWwwAuthenticate([]).valid, false);
    assert.equal(parseWwwAuthenticate([paymentChallenge(), , paymentChallenge()]).valid, false);
    let reads = 0;
    const growing = new Proxy([paymentChallenge()], { get: (target, key) => (key === 'length' ? (reads += 1) === 1 ? 1 : 1_000_000 : Reflect.get(target, key)) });
    assert.equal(parseWwwAuthenticate(growing).valid, true, 'length is read once: the bound and the loop agree');
    assert.equal(reads, 1);
    const withGetter = [paymentChallenge()];
    Object.defineProperty(withGetter, 0, { get: () => paymentChallenge() });
    assert.equal(parseWwwAuthenticate(withGetter).valid, false);
  });

  it('M9: refuses oversized headers, too many values, challenges and parameters', () => {
    refused(`${paymentChallenge()}, x="${'a'.repeat(MPP_CHALLENGE_LIMITS.maxHeaderLength)}"`, /size/);
    assert.equal(parseWwwAuthenticate(Array.from({ length: MPP_CHALLENGE_LIMITS.maxHeaderValues + 1 }, () => 'Basic a')).valid, false);
    assert.equal(parseWwwAuthenticate(Array.from({ length: MPP_CHALLENGE_LIMITS.maxChallenges + 1 }, (_, index) => `Basic t${index}`).join(', ')).valid, false);
    refused(paymentChallenge({ extra: Array.from({ length: MPP_CHALLENGE_LIMITS.maxParams }, (_, index) => `x${index}=1`).join(', ') }), /parameters/);
    refused(`Payment id="${'a'.repeat(MPP_CHALLENGE_LIMITS.maxParamValueLength + 1)}"`, /too long/);
    refused(paymentChallenge({ id: 'a'.repeat(MPP_CHALLENGE_LIMITS.maxIdLength + 1) }), /id/);
  });

  it('refuses CR, LF, NUL and non-Latin-1 text in a field value', () => {
    for (const bad of ['\r', '\n', '\u0000', '€']) refused(paymentChallenge({ realm: `r${bad}` }), /control|Latin-1/);
  });
});

describe('PAY-04 A — required and duplicate parameters (M2, M3)', () => {
  for (const missing of ['id', 'realm', 'method', 'intent', 'request']) {
    it(`refuses a challenge missing '${missing}'`, () => {
      const params: Record<string, string> = { id: '"a"', realm: '"r"', method: '"testpay"', intent: '"charge"', request: `"${VECTOR_REQUEST}"` };
      delete params[missing];
      refused(`Payment ${Object.entries(params)
        .map(([key, value]) => `${key}=${value}`)
        .join(', ')}`, new RegExp(missing));
    });
  }

  for (const duplicate of ['id', 'realm', 'method', 'intent', 'request', 'expires', 'digest', 'opaque', 'header', 'description']) {
    it(`M2/M3: refuses a duplicated '${duplicate}', identical or conflicting — never first-wins, never last-wins`, () => {
      const base = paymentChallenge({ opaque: { k: 'v' }, header: 'Payment-Authorization', digest: contentDigestOf('a'), description: 'd' });
      const parsed = onlyPayment(base);
      assert.equal(parsed.valid, true, 'the base challenge is valid on its own');
      const value = new Map(onlyPaymentParams(base)).get(duplicate) ?? 'x';
      refused(`${base}, ${duplicate}="${value}"`, /duplicate/);
      refused(`${base}, ${duplicate.toUpperCase()}="other"`, /duplicate/);
    });
  }

  it('ignores unknown parameters: never retained, never able to change a payment', () => {
    const challenge = valid(paymentChallenge({ extra: 'amount="999999", counterparty="evil", authorized="true", x-future=token' }));
    assert.deepEqual(Object.keys(challenge).sort(), ['decodedRequest', 'expires', 'expiresAtEpochMilliseconds', 'id', 'intent', 'method', 'realm', 'request']);
  });

  it('refuses a method outside 1*LOWERALPHA and an intent outside ALPHA / DIGIT / "-"', () => {
    for (const method of ['Tempo', 'x402', 'tempo-v2', 'tem_po']) refused(paymentChallenge({ method }), /method/);
    for (const intent of ['char ge', 'charge!', 'charge/v1']) refused(paymentChallenge({ intent }), /intent|malformed/);
  });

  it('refuses a header parameter naming any field but Payment-Authorization', () => {
    for (const header of ['Authorization', 'payment-authorization', 'X-Pay']) refused(paymentChallenge({ header }), /header/);
  });
});

function onlyPaymentParams(header: string): readonly (readonly [string, string])[] {
  const parsed = parseWwwAuthenticate(header);
  if (!parsed.valid) throw new Error(parsed.violation);
  return parsed.challenges[0]?.params ?? [];
}

describe('PAY-04 A — base64url, UTF-8 and canonical JSON (M6, M7, M8, M10 – M13)', () => {
  it('M6: refuses non-alphabet, impossible-length and non-zero-trailing-bit base64url', () => {
    for (const text of ['ab+c', 'ab/c', 'a', 'abcde', 'ab c', '', 'eyJhIjoiYiJ9.']) assert.equal(decodeBase64UrlNoPad(text, 64), undefined, text);
    // "QQ" decodes to "A"; "QR" carries non-zero trailing bits — a second spelling of the same byte.
    assert.deepEqual([...(decodeBase64UrlNoPad('QQ', 4) ?? [])], [0x41]);
    assert.equal(decodeBase64UrlNoPad('QR', 4), undefined);
  });

  it('M7: refuses padded base64url', () => {
    const padded = Buffer.from('{"a":"b"}', 'utf8').toString('base64url') + '==';
    assert.equal(decodeBase64UrlNoPad(padded, 64), undefined);
    refused(paymentChallenge({ rawRequest: `${encodeJcs({ amount: '1' })}=` }), /request/);
  });

  it('M8: refuses invalid UTF-8 — fatal, never replaced', () => {
    for (const bytes of [[0x7b, 0x22, 0xff, 0x22, 0x7d], [0xc0, 0xaf], [0xed, 0xa0, 0x80]]) {
      assert.equal(decodeCanonicalJsonObject(base64url(Uint8Array.from(bytes)), 64).valid, false);
    }
    refused(paymentChallenge({ rawRequest: base64url(Uint8Array.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d])) }), /UTF-8/);
  });

  it('M10: refuses an oversized decoded request before decoding it', () => {
    refused(paymentChallenge({ request: { amount: '1', pad: 'x'.repeat(MPP_CHALLENGE_LIMITS.maxRequestBytes) } }), /request|too long/);
    assert.equal(decodeBase64UrlNoPad('A'.repeat(12), 8), undefined, 'the bound is checked from the length alone');
  });

  it('M11: refuses malformed JSON, a non-object, and any non-canonical spelling', () => {
    for (const text of ['{', '[]', '"s"', '{"b":"1","a":"2"}', '{ "a":"1"}', '{"a":1.0}', '{"a":"1","a":"2"}', '﻿{"a":"1"}', '{"a":1e2}']) {
      assert.equal(decodeCanonicalJsonObject(base64url(text), 256).valid, false, text);
    }
    assert.equal(decodeCanonicalJsonObject(base64url('{"a":"1","b":[1,2,{"c":null}]}'), 256).valid, true);
    assert.equal(decodeCanonicalJsonObject(base64url('{"a":"\\ud800"}'), 256).valid, false, 'a lone surrogate is not I-JSON');
  });

  it('M12: refuses prototype-shaped member names anywhere, and never pollutes a prototype', () => {
    for (const name of ['__proto__', 'constructor', 'prototype']) {
      assert.equal(decodeCanonicalJsonObject(base64url(`{"a":{${JSON.stringify(name)}:{"polluted":"yes"}}}`), 256).valid, false, name);
      refused(paymentChallenge({ rawRequest: base64url(`{${JSON.stringify(name)}:{"polluted":"yes"}}`) }), /prototype/);
    }
    assert.equal(({} as Record<string, unknown>)['polluted'], undefined);
  });

  it('M13: bounds unexpected nested structure — depth and member count', () => {
    let deep: unknown = 'x';
    for (let index = 0; index <= MPP_CHALLENGE_LIMITS.maxJsonDepth + 1; index += 1) deep = { d: deep };
    assert.equal(decodeCanonicalJsonObject(base64url(JSON.stringify(deep)), 4096).valid, false);
    const wide = Object.fromEntries(Array.from({ length: MPP_CHALLENGE_LIMITS.maxJsonMembers + 1 }, (_, index) => [`k${String(index).padStart(3, '0')}`, 1]));
    assert.equal(decodeCanonicalJsonObject(base64url(JSON.stringify(wide)), 6000).valid, false);
  });

  it('opaque must be a flat, canonical string-to-string map', () => {
    refused(paymentChallenge({ opaque: { nested: { a: 'b' } } }), /opaque/);
    refused(paymentChallenge({ opaque: { n: 1 } }), /opaque/);
    assert.deepEqual({ ...valid(paymentChallenge({ opaque: { b: '2', a: '1' } })).decodedOpaque }, { a: '1', b: '2' });
  });
});

describe('PAY-04 A — RFC 3339 expiry (M14, M15)', () => {
  it('M14: parses strict RFC 3339 and refuses everything else', () => {
    assert.equal(rfc3339EpochMilliseconds('1970-01-01T00:00:00Z'), 0);
    assert.equal(rfc3339EpochMilliseconds('2026-09-24T12:05:00Z'), Date.parse('2026-09-24T12:05:00Z'));
    assert.equal(rfc3339EpochMilliseconds('2026-09-24t14:05:00.123+02:00'), Date.parse('2026-09-24T12:05:00.123Z'));
    assert.equal(rfc3339EpochMilliseconds('2024-02-29T00:00:00Z'), Date.parse('2024-02-29T00:00:00Z'));
    assert.equal(rfc3339EpochMilliseconds('2000-02-29T23:59:59.999999999-00:30'), Date.parse('2000-03-01T00:29:59.999Z'));
    for (const bad of ['2026-09-24 12:05:00Z', '2026-09-24T12:05:00', '2026-02-30T00:00:00Z', '2025-02-29T00:00:00Z', '2100-02-29T00:00:00Z', '2026-09-24T24:00:00Z', '2026-09-24T12:60:00Z', '2026-12-31T23:59:60Z', '2026-09-24T12:05:00+24:00', '0050-01-01T00:00:00Z', '1969-12-31T23:59:59Z', 'Thu, 24 Sep 2026 12:05:00 GMT', '+2026-09-24T12:05:00Z']) {
      assert.equal(rfc3339EpochMilliseconds(bad), undefined, bad);
    }
    refused(paymentChallenge({ expires: '2026-09-24' }), /expires/);
  });

  it('M15: a challenge at or past its expiry is unusable; one without expiry states none', () => {
    const challenge = valid(paymentChallenge({ expires: '2026-09-24T12:05:00Z' }));
    assert.equal(isMppChallengeUsableAt(challenge, Date.parse('2026-09-24T12:04:59.999Z')), true);
    assert.equal(isMppChallengeUsableAt(challenge, Date.parse('2026-09-24T12:05:00.000Z')), false);
    assert.equal(isMppChallengeUsableAt(valid(paymentChallenge({ expires: null })), Date.parse('2099-01-01T00:00:00Z')), true);
    assert.equal(isMppChallengeUsableAt(challenge, Number.NaN), false, 'no instant, no use');
  });
});

describe('PAY-04 A — RFC 9530 digest', () => {
  it('parses recognized algorithms strictly and canonicalizes the order', () => {
    const sha256 = contentDigestOf('body');
    const sha512 = `sha-512=:${Buffer.alloc(64, 1).toString('base64')}:`;
    assert.equal(parsePaymentContentDigest(`${sha512}, ${sha256}`)?.canonical, `${sha256}, ${sha512}`);
    assert.equal(parsePaymentContentDigest(`md5=:${Buffer.alloc(16).toString('base64')}:, ${sha256}`)?.canonical, sha256, 'unrecognized algorithms are ignored');
    for (const bad of ['sha-256=abc', `sha-256=:${Buffer.alloc(31).toString('base64')}:`, `${sha256}, ${sha256}`, 'sha-256=:@@@:', `SHA-256=:${Buffer.alloc(32).toString('base64')}:`, `md5=:${Buffer.alloc(16).toString('base64')}:`, `sha-256=:${Buffer.alloc(32).toString('base64')}:;p=1`]) {
      assert.equal(parsePaymentContentDigest(bad), undefined, bad);
    }
    // A non-zero pad bit is a second spelling of the same digest.
    const canonical = Buffer.alloc(32, 7).toString('base64');
    const alternative = `${canonical.slice(0, 42)}${String.fromCharCode(canonical.charCodeAt(42) + 1)}=`;
    assert.equal(parsePaymentContentDigest(`sha-256=:${alternative}:`), undefined);
  });
});
