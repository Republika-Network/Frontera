import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  X402JsonNumber,
  X402_CODEC_LIMITS,
  canonicalX402Requirements,
  decodeX402Base64,
  decodeX402PaymentRequiredHeader,
  decodeX402PaymentSignatureHeader,
  decodeX402Utf8,
  encodeX402PaymentSignatureHeader,
  parseX402Json,
  readX402PaymentRequiredCarrier,
  readX402PaymentResponseCarrier,
  serializeX402Json,
  type X402PaymentRequired,
} from '../index.js';
import { b64, carrierOf, paymentRequired, requirement, RESOURCE_URL } from './x402-test-support.js';
import { SPEC_LNBTC_VECTOR, SPEC_PAYMENT_REQUIRED_HEADER, SPEC_PAYMENT_RESPONSE_FAILURE_HEADER, SPEC_PAYMENT_RESPONSE_SUCCESS_HEADER, SPEC_PAYMENT_SIGNATURE_HEADER } from './x402-spec-vectors.js';

const violationOf = (carrier: unknown): string => {
  const read = readX402PaymentRequiredCarrier(carrier);
  assert.equal(read.valid, false, 'expected a refusal');
  return read.valid ? '' : read.violation;
};

const parsed = (carrier: unknown): X402PaymentRequired => {
  const read = readX402PaymentRequiredCarrier(carrier);
  assert.ok(read.valid, read.valid ? '' : read.violation);
  return read.value;
};

describe('PAY-08 — official x402 v2 vectors (x402 f8f8330)', () => {
  it('PR-1 the spec’s PAYMENT-REQUIRED example parses — and is an EVM offer, which is parsing, not support', () => {
    const read = decodeX402PaymentRequiredHeader(SPEC_PAYMENT_REQUIRED_HEADER);
    assert.ok(read.valid);
    assert.equal(read.value.x402Version, 2);
    assert.equal(read.value.resource.url, 'https://api.example.com/premium-data');
    assert.deepEqual(Object.keys(read.value.resource), ['url'], 'display metadata is dropped');
    assert.equal(read.value.accepts.length, 1);
    const [offer] = read.value.accepts;
    assert.equal(offer?.network, 'eip155:84532');
    assert.equal(offer?.amount, '10000');
    assert.equal(offer?.maxTimeoutSeconds, 60);
    assert.equal(offer?.extra?.['name'], 'USDC', '`extra` is opaque: kept, never interpreted here');
  });

  it('the spec’s PAYMENT-SIGNATURE example reads as a PaymentPayload; its PAYMENT-RESPONSE examples as SettlementResponses', () => {
    const payload = decodeX402PaymentSignatureHeader(SPEC_PAYMENT_SIGNATURE_HEADER);
    // The EVM example payload nests an `authorization` object: only flat string scheme payloads are read here.
    assert.equal(payload.valid, false);
    const success = readX402PaymentResponseCarrier({ status: 200, headers: [['PAYMENT-RESPONSE', SPEC_PAYMENT_RESPONSE_SUCCESS_HEADER]] });
    assert.ok(success.valid);
    assert.equal(success.value.response.success, true);
    assert.equal(success.value.response.network, 'eip155:84532');
    const failure = readX402PaymentResponseCarrier({ status: 402, headers: [['PAYMENT-RESPONSE', SPEC_PAYMENT_RESPONSE_FAILURE_HEADER]] });
    assert.ok(failure.valid);
    assert.equal(failure.value.response.success, false);
    assert.equal(failure.value.response.errorReason, 'insufficient_funds');
    assert.equal(failure.value.response.transaction, '');
  });

  it('the lnbtc test-vector requirement parses exactly, `requestBindingParams` and all', () => {
    const read = readX402PaymentRequiredCarrier(carrierOf(paymentRequired([SPEC_LNBTC_VECTOR.requirement], { resource: { url: SPEC_LNBTC_VECTOR.url } })));
    assert.ok(read.valid);
    const offer = read.value.accepts[0];
    assert.equal(offer?.network, 'lnbtc:000000000019d6689c085ae165831e93');
    assert.equal(offer?.extra?.['invoice'], SPEC_LNBTC_VECTOR.requirement.extra.invoice);
  });
});

describe('PAY-08 — the PaymentRequired matrix (PR)', () => {
  it('PR-2 a wrong version is refused as such: 1, "2", 2.0, absent', () => {
    assert.equal(violationOf(carrierOf(paymentRequired([requirement()], { x402Version: 1 }))), 'version-unsupported');
    assert.equal(violationOf(carrierOf(paymentRequired([requirement()], { x402Version: '2' }))), 'version-unsupported');
    assert.equal(violationOf(carrierOf('raw:' + b64('{"x402Version":2.0,"resource":{"url":"https://a.example/"},"accepts":[]}'))), 'version-unsupported');
    const missing = paymentRequired([requirement()]);
    delete missing['x402Version'];
    assert.equal(violationOf(carrierOf(missing)), 'payment-required-missing-x402Version');
  });

  it('PR-3 / PR-4 accepts: empty, absent, not an array, more than 16', () => {
    assert.equal(violationOf(carrierOf(paymentRequired([]))), 'accepts-empty');
    assert.equal(violationOf(carrierOf(paymentRequired([requirement()], { accepts: {} }))), 'accepts-invalid');
    assert.equal(violationOf(carrierOf(paymentRequired(Array.from({ length: 17 }, (_, index) => requirement({ extra: { instrument: `i-${String(index)}` } }))))), 'accepts-too-many');
    assert.equal(parsed(carrierOf(paymentRequired(Array.from({ length: 16 }, (_, index) => requirement({ extra: { instrument: `i-${String(index)}` } }))))).accepts.length, 16);
  });

  it('PR-5 malformed resource: not an object, no url, relative, fragment, userinfo, whitespace, non-ASCII, unknown member, oversized', () => {
    for (const resource of [
      'https://a.example/',
      {},
      { url: '/premium' },
      { url: 'https://a.example/x#frag' },
      { url: 'https://user:pw@a.example/x' },
      { url: 'https://a.example/x y' },
      { url: 'https://a.example/é' },
      { url: 'ftp://a.example/x' },
      { url: 'https://a.example/x', owner: 'me' },
      { url: `https://a.example/${'x'.repeat(2_048)}` },
      { url: 'https://a.example/x', serviceName: 'x'.repeat(33) },
      { url: 'https://a.example/x', tags: ['a', 'b', 'c', 'd', 'e', 'f'] },
      { url: 'https://a.example/x', mimeType: 'not a mime type' },
      { url: 'https://a.example/x', iconUrl: 'javascript:alert(1)' },
    ]) {
      assert.match(violationOf(carrierOf(paymentRequired([requirement()], { resource }))), /^resource-/, JSON.stringify(resource).slice(0, 80));
    }
  });

  it('PR-6 … PR-11 malformed scheme, network, amount, asset, payTo and timeout', () => {
    const cases: readonly [Record<string, unknown>, RegExp][] = [
      [{ scheme: '' }, /scheme/],
      [{ scheme: 'Exact' }, /scheme/],
      [{ scheme: 7 }, /scheme/],
      [{ network: 'eip155' }, /network/],
      [{ network: 'x:' }, /network/],
      [{ network: `abc:${'r'.repeat(33)}` }, /network/],
      [{ network: 'EIP155:1' }, /network/],
      [{ amount: 1250 }, /amount/],
      [{ asset: '' }, /asset/],
      [{ asset: 'with space' }, /asset/],
      [{ asset: 'x'.repeat(129) }, /asset/],
      [{ payTo: '' }, /pay-to/],
      [{ payTo: ' merchant' }, /pay-to/],
      [{ payTo: 'x'.repeat(257) }, /pay-to/],
      [{ maxTimeoutSeconds: 0 }, /timeout/],
      [{ maxTimeoutSeconds: -1 }, /timeout/],
      [{ maxTimeoutSeconds: 1.5 }, /timeout/],
      [{ maxTimeoutSeconds: '60' }, /timeout/],
      [{ maxTimeoutSeconds: 86_401 }, /timeout/],
      [{ unknownField: true }, /unknown-member/],
    ];
    for (const [overrides, pattern] of cases) assert.match(violationOf(carrierOf(paymentRequired([requirement(overrides)]))), pattern, JSON.stringify(overrides));
    const exponent = 'raw:' + b64(JSON.stringify(paymentRequired([requirement()])).replace('"maxTimeoutSeconds":60', '"maxTimeoutSeconds":6e1'));
    assert.match(violationOf(carrierOf(exponent)), /timeout/, 'a timeout in exponent notation is not a canonical integer');
  });

  it('PR-12 an oversized header is refused before decoding', () => {
    const huge = 'A'.repeat(X402_CODEC_LIMITS.maxHeaderLength + 4);
    assert.equal(violationOf(carrierOf(`raw:${huge}`)), 'header-oversized');
  });

  it('PR-13 invalid base64: wrong alphabet, base64url, missing padding, non-zero pad bits, whitespace, comma-joined fields', () => {
    const good = b64(paymentRequired([requirement()]));
    assert.ok(readX402PaymentRequiredCarrier(carrierOf(`raw:${good}`)).valid);
    const unpadded = good.replace(/=+$/, '');
    for (const bad of ['!!!!', `-${good.slice(1)}`, `_${good.slice(1)}`, `${good.slice(0, 4)} ${good.slice(4)}`, `${good},${good}`, 'QQ==QQ==', 'QR==']) {
      assert.equal(violationOf(carrierOf(`raw:${bad}`)), 'header-base64-invalid', bad.slice(0, 20));
    }
    if (unpadded !== good) assert.equal(violationOf(carrierOf(`raw:${unpadded}`)), 'header-base64-invalid');
    assert.equal(decodeX402Base64('QQ==', 10)?.length, 1);
    assert.equal(decodeX402Base64('QR==', 10), undefined, 'one spelling per byte string');
  });

  it('PR-14 invalid UTF-8: lone continuation, overlong, surrogate, beyond U+10FFFF, truncated, byte order mark', () => {
    for (const bytes of [[0x80], [0xc0, 0xaf], [0xed, 0xa0, 0x80], [0xf4, 0x90, 0x80, 0x80], [0xe2, 0x82], [0xef, 0xbb, 0xbf, 0x7b, 0x7d]]) {
      assert.equal(decodeX402Utf8(Uint8Array.from(bytes)), undefined, bytes.join(','));
      assert.equal(violationOf(carrierOf(`raw:${Buffer.from(bytes).toString('base64')}`)), 'header-utf8-invalid');
    }
    assert.equal(decodeX402Utf8(Buffer.from('ナンセンス €', 'utf8')), 'ナンセンス €');
  });

  it('PR-15 malformed JSON: trailing garbage, duplicate member, unterminated, not an object, lone surrogate, too deep', () => {
    const text = JSON.stringify(paymentRequired([requirement()]));
    assert.equal(violationOf(carrierOf(`raw:${b64(`${text}x`)}`)), 'json-trailing-text');
    assert.equal(violationOf(carrierOf(`raw:${b64(`${text}${text}`)}`)), 'json-trailing-text');
    assert.equal(violationOf(carrierOf(`raw:${b64(text.replace('{"x402Version":2,', '{"x402Version":2,"x402Version":2,'))}`)), 'json-duplicate-member');
    assert.equal(violationOf(carrierOf(`raw:${b64(text.slice(0, -1))}`)), 'json-object-unterminated');
    assert.equal(violationOf(carrierOf(`raw:${b64('[1,2]')}`)), 'payment-required-not-object');
    assert.equal(violationOf(carrierOf(`raw:${b64(text.replace('"Quarterly report 42"', '"\\ud800"'))}`)), 'json-string-lone-surrogate');
    assert.equal(parseX402Json(`${'['.repeat(17)}${']'.repeat(17)}`).valid, false);
    assert.equal(parseX402Json(`${'['.repeat(16)}${']'.repeat(16)}`).valid, true);
  });

  it('PR-19 extensions: bounded count, size, names and shape', () => {
    const ext = (count: number, size = 10) => Object.fromEntries(Array.from({ length: count }, (_, index) => [`ext-${String(index)}`, { info: { v: 'x'.repeat(size) }, schema: { type: 'object' } }]));
    assert.ok(readX402PaymentRequiredCarrier(carrierOf(paymentRequired([requirement()], { extensions: ext(8) }))).valid);
    assert.equal(violationOf(carrierOf(paymentRequired([requirement()], { extensions: ext(9) }))), 'extensions-too-many');
    assert.equal(violationOf(carrierOf(paymentRequired([requirement()], { extensions: ext(1, 4_200) }))), 'extension-oversized');
    assert.equal(violationOf(carrierOf(paymentRequired([requirement()], { extensions: ext(2, 3_500) }))), 'extensions-oversized');
    assert.equal(violationOf(carrierOf(paymentRequired([requirement()], { extensions: { 'bad name': { info: {}, schema: {} } } }))), 'extension-name-invalid');
    assert.match(violationOf(carrierOf(paymentRequired([requirement()], { extensions: { bazaar: { info: {} } } }))), /extension-missing-schema/);
    assert.equal(violationOf(carrierOf(paymentRequired([requirement()], { extensions: { bazaar: { info: 'x', schema: {} } } }))), 'extension-invalid');
    assert.equal(violationOf(carrierOf(paymentRequired([requirement()], { extensions: [] }))), 'extensions-not-object');
  });

  it('PR-20 hostile carriers and objects: accessors never run, prototype keys never land, proxies and odd prototypes refused', () => {
    let ran = false;
    const getter = { get status() { ran = true; return 402; }, headers: [] };
    assert.equal(violationOf(getter), 'carrier-invalid');
    const proxyHeaders = new Proxy([['PAYMENT-REQUIRED', b64(paymentRequired([requirement()]))]], { get: (target, key, receiver) => { ran = true; return Reflect.get(target, key, receiver); } });
    readX402PaymentRequiredCarrier({ status: 402, headers: proxyHeaders });
    assert.equal(violationOf(Object.assign(Object.create({ injected: true }) as object, { status: 402, headers: [] })), 'carrier-invalid');
    assert.equal(violationOf({ status: 402, headers: [['PAYMENT-REQUIRED', 7]] }), 'carrier-header-invalid');
    assert.equal(violationOf({ status: 402, headers: 'PAYMENT-REQUIRED: x' }), 'carrier-headers-invalid');
    assert.equal(violationOf({ status: 402, headers: [], extra: 1 }), 'carrier-invalid');
    assert.equal(ran, false, 'no getter or trap ran');
    const poisoned = JSON.stringify(paymentRequired([requirement()])).replace('{"x402Version"', '{"__proto__":{"authorized":true},"x402Version"');
    assert.equal(violationOf(carrierOf(`raw:${b64(poisoned)}`)), 'json-forbidden-member');
    assert.equal(({} as { authorized?: unknown }).authorized, undefined, 'nothing was polluted');
    const constructorKey = JSON.stringify(paymentRequired([requirement({ extra: { constructor: 'x', instrument: 'i' } })]));
    assert.equal(violationOf(carrierOf(`raw:${b64(constructorKey)}`)), 'json-forbidden-member');
  });
});

describe('PAY-08 — HTTP representation and header decoding', () => {
  it('status 402 and exactly one PAYMENT-REQUIRED field, name compared case-insensitively; v1 names never read', () => {
    const json = paymentRequired([requirement()]);
    assert.ok(readX402PaymentRequiredCarrier(carrierOf(json, { name: 'payment-required' })).valid, 'CAN-3 header case');
    assert.ok(readX402PaymentRequiredCarrier(carrierOf(json, { name: 'Payment-Required' })).valid);
    assert.equal(violationOf(carrierOf(json, { status: 200 })), 'carrier-status-not-402');
    assert.equal(violationOf({ status: 402, headers: [['X-PAYMENT', b64(json)]] }), 'carrier-payment-required-missing', 'the deprecated v1 name is not accepted');
    assert.equal(violationOf({ status: 402, headers: [] }), 'carrier-payment-required-missing');
    assert.equal(violationOf(carrierOf(json, { extra: [['payment-required', b64(json)]] })), 'carrier-header-duplicated', 'two fields — even identical — are refused');
    assert.ok(readX402PaymentRequiredCarrier(carrierOf(json, { extra: [['content-type', 'application/json']] })).valid, 'other fields are ignored');
  });

  it('CAN-4 one accepted base64 spelling: a re-encoding of the same JSON with other whitespace is another text, refused only if not canonical base64', () => {
    const compact = JSON.stringify(paymentRequired([requirement()]));
    const spaced = JSON.stringify(paymentRequired([requirement()]), null, 2);
    const a = parsed(carrierOf(`raw:${b64(compact)}`));
    const b = parsed(carrierOf(`raw:${b64(spaced)}`));
    assert.equal(canonicalX402Requirements(a.accepts[0] as never), canonicalX402Requirements(b.accepts[0] as never), 'whitespace is not material');
  });

  it('CAN-1 member order is not material; every field and extra member is', () => {
    const one = parsed(carrierOf(paymentRequired([requirement()])));
    const reordered = parsed(carrierOf(`raw:${b64('{"accepts":[{"payTo":"merchant-a","extra":{"instrument":"inv-1"},"maxTimeoutSeconds":60,"asset":"TOK","amount":"1250","network":"test:net-a","scheme":"exact"}],"resource":{"url":"' + RESOURCE_URL + '"},"x402Version":2}')}`));
    assert.equal(canonicalX402Requirements(one.accepts[0] as never), canonicalX402Requirements(reordered.accepts[0] as never));
    for (const change of [{ amount: '1251' }, { payTo: 'merchant-b' }, { network: 'test:net-b' }, { asset: 'TOKB' }, { scheme: 'upto' }, { maxTimeoutSeconds: 61 }, { extra: { instrument: 'inv-2' } }]) {
      const changed = parsed(carrierOf(paymentRequired([requirement(change)])));
      assert.notEqual(canonicalX402Requirements(changed.accepts[0] as never), canonicalX402Requirements(one.accepts[0] as never), JSON.stringify(change));
    }
  });

  it('JSON numbers are never JavaScript numbers: kept as source text and re-emitted byte for byte', () => {
    const read = parseX402Json('{"a":12345678901234567890123,"b":-0.10e-3}');
    assert.ok(read.valid);
    const value = read.value as Record<string, unknown>;
    assert.ok(value['a'] instanceof X402JsonNumber);
    assert.equal(serializeX402Json(read.value), '{"a":12345678901234567890123,"b":-0.10e-3}');
  });

  it('requirement `extra` admits only canonical integers as numbers (no float can reach a requirement digest)', () => {
    assert.match(violationOf(carrierOf(paymentRequired([requirement({ extra: { instrument: 'i', destinationTag: 1.5 } })]))), /extra-number-invalid/);
    assert.ok(readX402PaymentRequiredCarrier(carrierOf(paymentRequired([requirement({ extra: { instrument: 'i', destinationTag: 7 } })]))).valid);
  });

  it('the protocol-reserved `extra` keys are bounded text when present', () => {
    assert.match(violationOf(carrierOf(paymentRequired([requirement({ extra: { instrument: 'i', paymentFlow: 7 } })]))), /payment-flow/);
    assert.match(violationOf(carrierOf(paymentRequired([requirement({ extra: { instrument: 'i', assetTransferMethod: '' } })]))), /asset-transfer-method/);
  });
});

describe('PAY-08 — PAYMENT-SIGNATURE encoding and extension echo (PP-7)', () => {
  const accepted = parsed(carrierOf(paymentRequired([requirement()]))).accepts[0];
  const serverExtensions = (() => {
    const read = parseX402Json('{"bazaar":{"info":{"category":"reports"},"schema":{"type":"object"}}}');
    assert.ok(read.valid);
    return read.value as never;
  })();

  it('echoes `accepted` exactly and the server’s extensions unchanged; adds new client names only', () => {
    assert.ok(accepted !== undefined);
    const client = parseX402Json('{"client-note":{"info":{"n":"1"},"schema":{"type":"object"}}}');
    assert.ok(client.valid);
    const encoded = encodeX402PaymentSignatureHeader({ accepted, payload: { preimage: 'ab'.repeat(32) }, serverExtensions, clientExtensions: client.value as never });
    assert.ok(encoded.valid);
    const decoded = decodeX402PaymentSignatureHeader(encoded.value);
    assert.ok(decoded.valid, decoded.valid ? '' : decoded.violation);
    assert.equal(canonicalX402Requirements(decoded.value.accepted), canonicalX402Requirements(accepted));
    assert.deepEqual(Object.keys(decoded.value.extensions ?? {}).sort(), ['bazaar', 'client-note']);
    assert.equal(serializeX402Json(decoded.value.extensions?.['bazaar']), '{"info":{"category":"reports"},"schema":{"type":"object"}}');
    assert.equal(decoded.value.payload['preimage'], 'ab'.repeat(32));
  });

  it('PP-7 a client extension can never overwrite (or delete) the server’s', () => {
    assert.ok(accepted !== undefined);
    const overwrite = parseX402Json('{"bazaar":{"info":{"category":"free"},"schema":{"type":"object"}}}');
    assert.ok(overwrite.valid);
    assert.deepEqual(encodeX402PaymentSignatureHeader({ accepted, payload: { preimage: 'ab'.repeat(32) }, serverExtensions, clientExtensions: overwrite.value as never }), { valid: false, violation: 'extension-overwrite' });
  });

  it('PP-8 a malformed scheme payload is refused, never spread', () => {
    assert.ok(accepted !== undefined);
    let ran = false;
    const getter = { get preimage() { ran = true; return 'x'; } };
    assert.equal(encodeX402PaymentSignatureHeader({ accepted, payload: getter as never }).valid, false);
    assert.equal(ran, false);
    assert.equal(encodeX402PaymentSignatureHeader({ accepted, payload: { preimage: 7 } as never }).valid, false);
    assert.equal(encodeX402PaymentSignatureHeader({ accepted, payload: {} }).valid, false);
    assert.equal(encodeX402PaymentSignatureHeader({ accepted, payload: { 'bad key': 'x' } }).valid, false);
  });
});
