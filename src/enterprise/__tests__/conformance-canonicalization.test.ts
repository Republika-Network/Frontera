import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { join } from 'node:path';

import { AUTHORITY_SIGNING_DOMAINS } from '../authority-authenticity/authority-signature.js';
import {
  CONFORMANCE_CANONICALIZATION_PROFILE,
  ConformanceCanonicalizationError,
  canonicalizeConformance,
  conformanceDigest,
  digestWithout,
  snapshotPlainJson,
} from '../conformance/canonical.js';
import {
  CONFORMANCE_SIGNING_DOMAINS,
  conformanceSigningBytes,
  deriveConformanceKeyId,
  publicKeyPemOf,
  signConformancePayload,
  verifyConformanceSignature,
} from '../conformance/signing.js';
import { testKey } from './conformance-support.js';

/**
 * RN-CONFORM-02 / WP-02 (CC-D-01) and the cryptographic integrity gate (§9):
 * the restricted aoc-canonical-json/1 adapter, its golden vectors, its
 * differential agreement with Protocol's and Frontera's implementations, and
 * the domain-separated Ed25519 signatures built on it.
 */

const sha = (text: string) => `sha256:${createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')}`;

describe('RN-CONFORM-02 canonicalization adapter (CC-D-01)', () => {
  it('names the approved profile', () => {
    assert.equal(CONFORMANCE_CANONICALIZATION_PROFILE, 'aoc-canonical-json/1');
  });

  it('produces byte-for-byte golden output and digests', () => {
    const golden: Array<[unknown, string, string]> = [
      [{ b: 1, a: 2, c: { z: 1, y: [3, 2, 1] } }, '{"a":2,"b":1,"c":{"y":[3,2,1],"z":1}}', 'sha256:cd3cfe8daa448c994a797ec91cc19f51f5ef90c852f8eb365487bb340e750cac'],
      [{ emoji: '😀', math: '𝔸' }, '{"emoji":"😀","math":"𝔸"}', 'sha256:efddef7e01ac05ad5ae4200ab255ef1b5c0d4a0c3d81409414816d06934c3428'],
      // UTF-16 code-unit order (not code-point order): U+1F600 (D83D…) sorts before U+FF5E.
      [{ '～': 1, '😀': 2, é: 3, a: 4, B: 5 }, '{"B":5,"a":4,"é":3,"😀":2,"～":1}', 'sha256:659f5a7a082cb074e95c30b8703552bbdfa8289b6044aaecbe92b498efca3bee'],
      [{ s: 'quote" backslash\\ newline\n tab\t nul\u0000 bell\u0007 ls ' }, '{"s":"quote\\" backslash\\\\ newline\\n tab\\t nul\\u0000 bell\\u0007 ls "}', 'sha256:1c362f29a7bb8adef64496f8cfb79eaa4aafe5e169179d2d7f5792362a6f4b57'],
    ];
    for (const [value, bytes, digest] of golden) {
      assert.equal(canonicalizeConformance(value), bytes);
      assert.equal(conformanceDigest(value), digest);
      assert.equal(sha(bytes), digest);
    }
    assert.equal(canonicalizeConformance({}), '{}');
    assert.equal(canonicalizeConformance([]), '[]');
    assert.equal(canonicalizeConformance([0, -1, 9007199254740991]), '[0,-1,9007199254740991]');
    assert.equal(canonicalizeConformance({ outer: { inner: [{ k: 'v' }, [], {}] } }), '{"outer":{"inner":[{"k":"v"},[],{}]}}');
  });

  it('is independent of key insertion order and never mutates its input', () => {
    const a = { z: [1, { y: 2, x: 1 }], a: 'é' };
    const b = { a: 'é', z: [1, { x: 1, y: 2 }] };
    const before = JSON.stringify(a);
    assert.equal(conformanceDigest(a), conformanceDigest(b));
    assert.equal(JSON.stringify(a), before);
    assert.match(conformanceDigest(a), /^sha256:[0-9a-f]{64}$/);
  });

  it('refuses every value outside the plain-JSON domain, by reason', () => {
    class Instance {
      readonly x = 1;
    }
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    const cases: Array<[unknown, string]> = [
      [undefined, 'UNDEFINED_VALUE'],
      [{ a: undefined }, 'UNDEFINED_VALUE'],
      [[1, undefined], 'UNDEFINED_VALUE'],
      [new Date(0), 'DATE_VALUE'],
      [{ n: -0 }, 'NEGATIVE_ZERO'],
      [{ n: 0.5 }, 'NON_INTEGER_NUMBER'],
      [{ n: 2 ** 53 }, 'UNSAFE_INTEGER'],
      [{ n: Number.NaN }, 'NON_FINITE_NUMBER'],
      [{ n: Number.NEGATIVE_INFINITY }, 'NON_FINITE_NUMBER'],
      [{ n: 1n }, 'BIGINT_VALUE'],
      [{ b: Buffer.from('x') }, 'BINARY_VALUE'],
      [{ b: new Uint8Array(2) }, 'BINARY_VALUE'],
      [{ m: new Map() }, 'NON_PLAIN_OBJECT'],
      [new Instance(), 'NON_PLAIN_OBJECT'],
      [cyclic, 'CYCLE'],
      // eslint-disable-next-line no-sparse-arrays
      [[1, , 2], 'SPARSE_OR_DECORATED_ARRAY'],
      [Object.assign([1], { extra: true }), 'SPARSE_OR_DECORATED_ARRAY'],
      [Object.defineProperty({}, 'g', { get: () => 1, enumerable: true }), 'ACCESSOR_PROPERTY'],
      [Object.defineProperty({}, 'h', { value: 1, enumerable: false }), 'NON_ENUMERABLE_PROPERTY'],
      [{ [Symbol('s')]: 1 }, 'SYMBOL_KEY'],
      [{ s: '\ud800' }, 'MALFORMED_UNICODE'],
      [{ '\udfff': 1 }, 'MALFORMED_UNICODE'],
      [{ f: () => 1 }, 'UNSUPPORTED_TYPE'],
      [{ s: 'x'.repeat(8193) }, 'STRING_TOO_LONG'],
    ];
    for (const [value, reason] of cases) {
      assert.throws(() => canonicalizeConformance(value), (error: unknown) => error instanceof ConformanceCanonicalizationError && error.reason === reason, `expected ${reason}`);
    }
    let deep: unknown = 1;
    for (let i = 0; i < 40; i += 1) deep = [deep];
    assert.throws(() => canonicalizeConformance(deep), (e: unknown) => e instanceof ConformanceCanonicalizationError && e.reason === 'TOO_DEEP');
    assert.throws(() => canonicalizeConformance(new Array(5000).fill(1)), (e: unknown) => e instanceof ConformanceCanonicalizationError && e.reason === 'TOO_MANY_NODES');
  });

  it('reads each property once into a frozen snapshot (no getter can change what is signed)', () => {
    let reads = 0;
    const tricky = new Proxy({ a: 1 }, {
      getOwnPropertyDescriptor(target, key) {
        reads += 1;
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    const snap = snapshotPlainJson(tricky) as { a: number };
    assert.equal(snap.a, 1);
    assert.equal(reads, 1);
    assert.ok(Object.isFrozen(snap));
  });

  it('computes self-digests without the self-referential fields', () => {
    const record = { id: 'x', body: 1, digest: 'ignored', signature: 'ignored' };
    assert.equal(digestWithout(record, ['digest', 'signature']), conformanceDigest({ id: 'x', body: 1 }));
  });

  it('agrees byte for byte with Protocol canonicalizeJSON and Frontera canonicalSerialize on every accepted vector (differential probe)', () => {
    const script = join(process.cwd(), 'scripts', 'protocol', 'check-conformance-canonicalization.mjs');
    const run = spawnSync(process.execPath, [script], { cwd: process.cwd(), encoding: 'utf8', timeout: 120_000 });
    assert.equal(run.status, 0, run.stderr);
    const lines = run.stdout.trim().split('\n');
    const evidence = JSON.parse(lines[lines.length - 1]!) as {
      profile: string;
      accepted: { name: string; agree: boolean }[];
      refused: { name: string; adapter: { refused: boolean }; protocolAndFronteraAgree: boolean }[];
      failures: string[];
    };
    assert.equal(evidence.profile, 'aoc-canonical-json/1');
    assert.deepEqual(evidence.failures, []);
    assert.ok(evidence.accepted.length >= 10 && evidence.accepted.every((v) => v.agree));
    assert.ok(evidence.refused.every((v) => v.adapter.refused));
    // The recorded divergences that motivated the narrowed domain are still real.
    const diverging = new Set(evidence.refused.filter((v) => !v.protocolAndFronteraAgree).map((v) => v.name));
    for (const name of ['undefined-property', 'date', 'map', 'class-instance', 'uint8array']) assert.ok(diverging.has(name), name);
  });
});

describe('RN-CONFORM-02 conformance signatures (§9)', () => {
  const key = testKey('canonicalization-suite');
  const pem = publicKeyPemOf(key);
  const payload = { schema: 'rn.conformance.test/1', n: 1, s: 'é' };

  it('uses dedicated domains that cannot collide with any CORE-02 authority domain', () => {
    const conformance = Object.values(CONFORMANCE_SIGNING_DOMAINS);
    const authority = Object.values(AUTHORITY_SIGNING_DOMAINS);
    assert.equal(new Set(conformance).size, conformance.length);
    for (const c of conformance) {
      assert.ok(c.startsWith('frontera:conformance-') && c.endsWith(':v1\n'));
      for (const a of authority) assert.ok(!c.startsWith(a) && !a.startsWith(c), `${c} vs ${a}`);
      for (const other of conformance) if (other !== c) assert.ok(!c.startsWith(other));
    }
    assert.ok(conformanceSigningBytes('observation', payload).toString('utf8').startsWith('frontera:conformance-observation:v1\n{'));
  });

  it('derives key ids from the SPKI DER public key, for private and public halves alike', () => {
    const spki = createPublicKey(key).export({ type: 'spki', format: 'der' });
    const expected = `sha256:${createHash('sha256').update(spki).digest('hex')}`;
    assert.equal(deriveConformanceKeyId(key), expected);
    assert.equal(deriveConformanceKeyId(pem), expected);
    const rsa = generateKeyPairSync('rsa', { modulusLength: 1024 }).publicKey;
    assert.throws(() => deriveConformanceKeyId(rsa));
  });

  it('verifies only the right payload, domain and trusted key', () => {
    const signature = signConformancePayload('observation', payload, key);
    assert.equal(signature.algorithm, 'ed25519-v1');
    assert.equal(signature.artifactVersion, 'aoc.authority-artifact.v1');
    assert.deepEqual(verifyConformanceSignature('observation', payload, signature, pem), { ok: true });
    // Wrong domain.
    assert.equal(verifyConformanceSignature('transition', payload, signature, pem).ok, false);
    // Tampered payload.
    assert.equal(verifyConformanceSignature('observation', { ...payload, n: 2 }, signature, pem).ok, false);
    // Wrong key (and the envelope's key id does not resolve to it).
    const other = publicKeyPemOf(testKey('someone-else'));
    assert.deepEqual(verifyConformanceSignature('observation', payload, signature, other), { ok: false, reason: 'KEY_ID_MISMATCH' });
    // Key id rewritten to the other key's id: the signature still does not verify.
    const relabelled = { ...signature, keyId: deriveConformanceKeyId(other) };
    assert.equal(verifyConformanceSignature('observation', payload, relabelled, other).ok, false);
    // Truncated / malformed signature bytes.
    assert.equal(verifyConformanceSignature('observation', payload, { ...signature, signature: signature.signature.slice(4) }, pem).ok, false);
    // A payload outside the plain-JSON domain cannot be verified at all.
    assert.equal(verifyConformanceSignature('observation', { n: 0.5 }, signature, pem).ok, false);
    // Deterministic: the same payload signs to the same bytes (Ed25519).
    assert.equal(signConformancePayload('observation', payload, key).signature, signature.signature);
  });
});
