#!/usr/bin/env node
// RN-CONFORM-02 / CC-D-01 -- differential canonicalization probe.
//
// Compares, byte for byte, three implementations over one vector corpus:
//   1. Soberania Protocol's canonicalizeJSON (aoc-canonical-json/1), from the
//      INSTALLED @aoc/protocol package (the vendored, lock-pinned tarball);
//   2. Frontera's governance-store canonicalSerialize (aoc.canonical-json.v1);
//   3. the conformance adapter (src/enterprise/conformance/canonical.ts).
//
// Accepted vectors: all three must produce identical bytes.
// Refused vectors: the adapter must refuse; what Protocol and Frontera do is
// recorded verbatim (that is the evidence for the narrowed input domain).
//
// It lives under scripts/protocol/ for the same reason as
// check-canonicalization-regression.mjs: Frontera source, packages and tests
// may not import any Protocol subpath, and scripts/protocol is the exempt
// protocol tooling. It reads the BUILT adapter from dist/, so run it after
// `npm run build`. Writes nothing. Prints one JSON evidence object as its last
// stdout line and exits 1 on any disagreement.
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { canonicalizeJSON, CANONICAL_JSON_PROFILE } from '@aoc/protocol/canonical';

const ROOT = resolve(process.cwd());
const require_ = createRequire(import.meta.url);
const adapter = await import(pathToFileURL(join(ROOT, 'dist/src/enterprise/conformance/canonical.js')).href);
const frontera = await import(pathToFileURL(join(ROOT, 'dist/src/enterprise/governance-store/canonical-json.js')).href);

const sha = (text) => `sha256:${createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')}`;
const attempt = (fn) => {
  try {
    return { ok: true, bytes: fn() };
  } catch (error) {
    return { ok: false, error: error?.name ?? 'Error', reason: error?.reason ?? null };
  }
};

const accepted = [
  ['empty-object', {}],
  ['empty-array', []],
  ['null', null],
  ['booleans', [true, false]],
  ['integers', [0, 1, -1, 42, 9007199254740991, -9007199254740991]],
  ['insertion-order-a', { b: 1, a: 2, c: { z: 1, y: [3, 2, 1] } }],
  ['insertion-order-b', { c: { y: [3, 2, 1], z: 1 }, a: 2, b: 1 }],
  ['nested', { outer: { inner: { deepest: [{ k: 'v' }, [], {}] } } }],
  ['unicode-bmp', { text: 'Soberanía — ñandú – 中文' }],
  ['unicode-astral', { emoji: '😀', math: '𝔸' }],
  ['utf16-key-order', { '～': 1, '😀': 2, é: 3, a: 4, B: 5 }],
  ['escapes', { s: 'quote" backslash\\ newline\n tab\t nul\u0000 bell\u0007 ls ' }],
  ['null-prototype', Object.assign(Object.create(null), { z: 1, a: 2 })],
  ['domain-like-strings', { d: 'frontera:conformance-observation:v1\n', e: 'frontera:conformance-transition:v1\n' }],
];

class Point {
  constructor() {
    this.x = 1;
  }
}
const cyclic = { a: 1 };
cyclic.self = cyclic;
const sparse = [1, , 3]; // eslint-disable-line no-sparse-arrays
const refused = [
  ['undefined-property', () => ({ a: undefined, b: 1 }), 'UNDEFINED_VALUE'],
  ['undefined-element', () => [1, undefined], 'UNDEFINED_VALUE'],
  ['date', () => ({ at: new Date('2026-11-02T09:00:00.000Z') }), 'DATE_VALUE'],
  ['negative-zero', () => ({ n: -0 }), 'NEGATIVE_ZERO'],
  ['fraction', () => ({ n: 0.1 }), 'NON_INTEGER_NUMBER'],
  ['exponent-large', () => ({ n: 1e21 }), 'UNSAFE_INTEGER'],
  ['exponent-small', () => ({ n: 7.9e-10 }), 'NON_INTEGER_NUMBER'],
  ['unsafe-integer', () => ({ n: 9007199254740993 }), 'UNSAFE_INTEGER'],
  ['nan', () => ({ n: Number.NaN }), 'NON_FINITE_NUMBER'],
  ['infinity', () => ({ n: Number.POSITIVE_INFINITY }), 'NON_FINITE_NUMBER'],
  ['bigint', () => ({ n: 1n }), 'BIGINT_VALUE'],
  ['map', () => ({ m: new Map([['a', 1]]) }), 'NON_PLAIN_OBJECT'],
  ['class-instance', () => ({ p: new Point() }), 'NON_PLAIN_OBJECT'],
  ['uint8array', () => ({ b: new Uint8Array([1, 2]) }), 'BINARY_VALUE'],
  ['buffer', () => ({ b: Buffer.from([1, 2]) }), 'BINARY_VALUE'],
  ['sparse-array', () => sparse, 'SPARSE_OR_DECORATED_ARRAY'],
  ['lone-surrogate', () => ({ s: '\ud800' }), 'MALFORMED_UNICODE'],
  ['lone-surrogate-key', () => ({ ['\udc00']: 1 }), 'MALFORMED_UNICODE'],
  ['accessor', () => Object.defineProperty({}, 'g', { get: () => 1, enumerable: true }), 'ACCESSOR_PROPERTY'],
  ['symbol-key', () => ({ [Symbol('s')]: 1, a: 1 }), 'SYMBOL_KEY'],
  ['function', () => ({ f: () => 1 }), 'UNSUPPORTED_TYPE'],
  ['cycle', () => cyclic, 'CYCLE'],
];

const result = { profile: CANONICAL_JSON_PROFILE, protocolVersion: require_('@aoc/protocol/package.json').version, accepted: [], refused: [], failures: [] };

for (const [name, value] of accepted) {
  const p = attempt(() => canonicalizeJSON(value));
  const f = attempt(() => frontera.canonicalSerialize(value));
  const a = attempt(() => adapter.canonicalizeConformance(value));
  const agree = p.ok && f.ok && a.ok && p.bytes === f.bytes && f.bytes === a.bytes;
  result.accepted.push({ name, agree, bytes: a.ok ? a.bytes : null, digest: a.ok ? sha(a.bytes) : null });
  if (!agree) result.failures.push(`accepted vector '${name}' does not produce identical bytes in all three implementations`);
}

for (const [name, build, expectedReason] of refused) {
  const p = attempt(() => canonicalizeJSON(build()));
  const f = attempt(() => frontera.canonicalSerialize(build()));
  const a = attempt(() => adapter.canonicalizeConformance(build()));
  const entry = {
    name,
    adapter: a.ok ? { refused: false } : { refused: true, reason: a.reason },
    protocol: p.ok ? { bytes: p.bytes } : { throws: p.error },
    frontera: f.ok ? { bytes: f.bytes } : { throws: f.error },
    protocolAndFronteraAgree: p.ok === f.ok && (!p.ok || p.bytes === f.bytes),
  };
  result.refused.push(entry);
  if (a.ok) result.failures.push(`refused vector '${name}' was accepted by the adapter`);
  else if (a.reason !== expectedReason) result.failures.push(`refused vector '${name}' was refused for ${a.reason}, expected ${expectedReason}`);
}

// Key-insertion order must not matter.
if (result.accepted.find((v) => v.name === 'insertion-order-a')?.bytes !== result.accepted.find((v) => v.name === 'insertion-order-b')?.bytes) {
  result.failures.push('insertion order changed the canonical bytes');
}

for (const failure of result.failures) process.stderr.write(`[conformance-canonicalization] FAIL ${failure}\n`);
process.stdout.write(`${JSON.stringify(result)}\n`);
process.exit(result.failures.length === 0 ? 0 : 1);
