import { createHash } from 'node:crypto';

/**
 * RN-CONFORM-02 / CC-D-01 — the canonicalization adapter for every signed or
 * digested conformance artifact.
 *
 * ## Profile
 *
 * `aoc-canonical-json/1`, the profile implemented by Soberanía Protocol
 * (`canonicalizeJSON`, the `./canonical` export of the Protocol package):
 * object keys sorted by UTF-16 code unit, arrays in order, strings through
 * `JSON.stringify`, finite numbers through `Number.prototype.toString`,
 * literals `true`/`false`/`null`, no whitespace.
 *
 * ## Why a local adapter and not a direct import
 *
 * Frontera's boundary gates (`scripts/check-protocol-consumption.mjs`,
 * `scripts/check-node16-imports.mjs`) forbid every Protocol subpath import in
 * `src/`, `packages/` and `tests/`; only `scripts/protocol/` may name one. The
 * FV receiver (`packages/sovereign-receiver-verification/src/sovereign-status.ts`)
 * set the precedent of restating the profile for a restricted value domain.
 * This adapter does the same, and its bytes are compared with the real
 * Protocol function by `scripts/protocol/check-conformance-canonicalization.mjs`
 * (run from `conformance-canonicalization.test.ts`).
 *
 * ## The plain-JSON restriction (CC-D-01)
 *
 * The two repository implementations disagree on several inputs (recorded in
 * `docs/architecture/continuous-conformance/RN_CONFORM_02_IMPLEMENTATION.md`
 * §3): Protocol throws on `undefined` where Frontera's `canonicalSerialize`
 * drops it; Protocol renders a `Date` or a `Map` as `{}` where Frontera renders
 * an ISO string or throws; Protocol walks class instances and typed arrays by
 * their enumerable keys; Protocol recurses without bound on a cycle. None of
 * those inputs is admitted here. The accepted domain is narrowed until the two
 * implementations, and this one, are byte-identical:
 *
 * - `null`, booleans, strings, plain objects (prototype `Object.prototype` or
 *   `null`), dense plain arrays;
 * - numbers: **safe integers only**, and never `-0` (Protocol renders `-0` as
 *   `0`, which would make two inputs one digest). Conformance artifacts carry
 *   only counters and versions; refusing fractions keeps cross-language
 *   agreement trivial rather than dependent on ECMAScript's shortest
 *   round-trip rule;
 * - strings and keys must be well-formed UTF-16 (a lone surrogate has no UTF-8
 *   encoding and is refused rather than escaped);
 * - every property must be an own, enumerable data property with a string key
 *   (accessors, symbol keys and non-enumerable properties are refused, so a
 *   getter cannot show one value to validation and another to signing);
 * - bounded depth and node count.
 *
 * Everything else throws {@link ConformanceCanonicalizationError} with a
 * closed reason. No value is ever normalized: an ambiguous input is refused.
 *
 * RFC 8785 compatibility is **not** claimed.
 */

export const CONFORMANCE_CANONICALIZATION_PROFILE = 'aoc-canonical-json/1' as const;

export const CONFORMANCE_CANONICAL_LIMITS = Object.freeze({ maxDepth: 32, maxNodes: 4096, maxStringLength: 8192 });

export const CANONICALIZATION_FAILURES = Object.freeze([
  'UNDEFINED_VALUE',
  'NON_FINITE_NUMBER',
  'NEGATIVE_ZERO',
  'NON_INTEGER_NUMBER',
  'UNSAFE_INTEGER',
  'BIGINT_VALUE',
  'UNSUPPORTED_TYPE',
  'DATE_VALUE',
  'BINARY_VALUE',
  'NON_PLAIN_OBJECT',
  'SPARSE_OR_DECORATED_ARRAY',
  'ACCESSOR_PROPERTY',
  'SYMBOL_KEY',
  'NON_ENUMERABLE_PROPERTY',
  'CYCLE',
  'MALFORMED_UNICODE',
  'STRING_TOO_LONG',
  'TOO_DEEP',
  'TOO_MANY_NODES',
] as const);
export type CanonicalizationFailure = (typeof CANONICALIZATION_FAILURES)[number];

export class ConformanceCanonicalizationError extends Error {
  readonly reason: CanonicalizationFailure;
  readonly path: string;
  constructor(reason: CanonicalizationFailure, path: string) {
    super(`Value at ${path} is outside the conformance plain-JSON domain (${reason}).`);
    this.name = 'ConformanceCanonicalizationError';
    this.reason = reason;
    this.path = path;
  }
}

/** A plain-JSON value: the only shape a conformance artifact may contain. */
export type PlainJson = null | boolean | number | string | readonly PlainJson[] | { readonly [key: string]: PlainJson };

interface Budget {
  nodes: number;
}

function wellFormed(text: string): boolean {
  // Node 22 provides String.prototype.isWellFormed; the fallback scan is identical in result.
  const candidate = text as string & { isWellFormed?: () => boolean };
  if (typeof candidate.isWellFormed === 'function') return candidate.isWellFormed();
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function checkString(text: string, path: string): string {
  if (text.length > CONFORMANCE_CANONICAL_LIMITS.maxStringLength) throw new ConformanceCanonicalizationError('STRING_TOO_LONG', path);
  if (!wellFormed(text)) throw new ConformanceCanonicalizationError('MALFORMED_UNICODE', path);
  return text;
}

/**
 * Reads `value` exactly once into a fresh, deep-frozen plain-JSON snapshot, or
 * throws. The snapshot is what gets serialized, so nothing the caller does to
 * its own objects afterwards — and no getter or proxy trap — can change the
 * bytes that were checked.
 */
export function snapshotPlainJson(value: unknown): PlainJson {
  return snapshot(value, '$', new Set<object>(), 0, { nodes: 0 });
}

function snapshot(value: unknown, path: string, seen: Set<object>, depth: number, budget: Budget): PlainJson {
  budget.nodes += 1;
  if (budget.nodes > CONFORMANCE_CANONICAL_LIMITS.maxNodes) throw new ConformanceCanonicalizationError('TOO_MANY_NODES', path);
  if (depth > CONFORMANCE_CANONICAL_LIMITS.maxDepth) throw new ConformanceCanonicalizationError('TOO_DEEP', path);
  if (value === null) return null;
  switch (typeof value) {
    case 'undefined':
      throw new ConformanceCanonicalizationError('UNDEFINED_VALUE', path);
    case 'boolean':
      return value;
    case 'string':
      return checkString(value, path);
    case 'number':
      if (!Number.isFinite(value)) throw new ConformanceCanonicalizationError('NON_FINITE_NUMBER', path);
      if (Object.is(value, -0)) throw new ConformanceCanonicalizationError('NEGATIVE_ZERO', path);
      if (!Number.isInteger(value)) throw new ConformanceCanonicalizationError('NON_INTEGER_NUMBER', path);
      if (!Number.isSafeInteger(value)) throw new ConformanceCanonicalizationError('UNSAFE_INTEGER', path);
      return value;
    case 'bigint':
      throw new ConformanceCanonicalizationError('BIGINT_VALUE', path);
    case 'object':
      break;
    default:
      throw new ConformanceCanonicalizationError('UNSUPPORTED_TYPE', path);
  }

  const objectValue = value as object;
  if (seen.has(objectValue)) throw new ConformanceCanonicalizationError('CYCLE', path);
  if (objectValue instanceof Date) throw new ConformanceCanonicalizationError('DATE_VALUE', path);
  if (ArrayBuffer.isView(objectValue) || objectValue instanceof ArrayBuffer || (typeof SharedArrayBuffer !== 'undefined' && objectValue instanceof SharedArrayBuffer)) {
    throw new ConformanceCanonicalizationError('BINARY_VALUE', path);
  }

  seen.add(objectValue);
  try {
    if (Array.isArray(objectValue)) {
      if (Object.getPrototypeOf(objectValue) !== Array.prototype) throw new ConformanceCanonicalizationError('NON_PLAIN_OBJECT', path);
      const keys = Reflect.ownKeys(objectValue);
      const length = (objectValue as unknown[]).length;
      // Exactly the indices 0..length-1 plus `length`: no holes, no extra named or symbol properties.
      if (keys.length !== length + 1) throw new ConformanceCanonicalizationError('SPARSE_OR_DECORATED_ARRAY', path);
      const items: PlainJson[] = [];
      for (let index = 0; index < length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(objectValue, String(index));
        if (descriptor === undefined) throw new ConformanceCanonicalizationError('SPARSE_OR_DECORATED_ARRAY', `${path}[${index}]`);
        if (!('value' in descriptor)) throw new ConformanceCanonicalizationError('ACCESSOR_PROPERTY', `${path}[${index}]`);
        items.push(snapshot(descriptor.value, `${path}[${index}]`, seen, depth + 1, budget));
      }
      return Object.freeze(items);
    }

    const prototype = Object.getPrototypeOf(objectValue);
    if (prototype !== Object.prototype && prototype !== null) throw new ConformanceCanonicalizationError('NON_PLAIN_OBJECT', path);
    const out: Record<string, PlainJson> = Object.create(null) as Record<string, PlainJson>;
    for (const key of Reflect.ownKeys(objectValue)) {
      if (typeof key === 'symbol') throw new ConformanceCanonicalizationError('SYMBOL_KEY', path);
      const childPath = `${path}.${key}`;
      checkString(key, childPath);
      const descriptor = Object.getOwnPropertyDescriptor(objectValue, key);
      if (descriptor === undefined) throw new ConformanceCanonicalizationError('UNSUPPORTED_TYPE', childPath);
      if (!('value' in descriptor)) throw new ConformanceCanonicalizationError('ACCESSOR_PROPERTY', childPath);
      if (descriptor.enumerable !== true) throw new ConformanceCanonicalizationError('NON_ENUMERABLE_PROPERTY', childPath);
      out[key] = snapshot(descriptor.value, childPath, seen, depth + 1, budget);
    }
    return Object.freeze(out);
  } finally {
    seen.delete(objectValue);
  }
}

/** `aoc-canonical-json/1` over an already-validated snapshot. The serialization rules are Protocol's, restated. */
function serialize(value: PlainJson): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') return value.toString();
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) return `[${(value as readonly PlainJson[]).map(serialize).join(',')}]`;
  const record = value as { readonly [key: string]: PlainJson };
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${serialize(record[key] as PlainJson)}`)
    .join(',')}}`;
}

/** The canonical string of `value`, or a {@link ConformanceCanonicalizationError}. The input is never mutated. */
export function canonicalizeConformance(value: unknown): string {
  return serialize(snapshotPlainJson(value));
}

/** The canonical UTF-8 bytes of `value`. */
export function canonicalConformanceBytes(value: unknown): Buffer {
  return Buffer.from(canonicalizeConformance(value), 'utf8');
}

const DIGEST = /^sha256:[0-9a-f]{64}$/;

/** `sha256:<lowercase hex>` over the canonical UTF-8 bytes. */
export function conformanceDigest(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalConformanceBytes(value)).digest('hex')}`;
}

export function isConformanceDigest(value: unknown): value is string {
  return typeof value === 'string' && DIGEST.test(value);
}

/**
 * The digest of a record computed without the named self-referential fields
 * (its own digest, its signature). A record's digest is never an input to
 * itself.
 */
export function digestWithout(record: { readonly [key: string]: unknown }, omitted: readonly string[]): string {
  const copy: Record<string, unknown> = {};
  for (const key of Object.keys(record)) if (!omitted.includes(key)) copy[key] = record[key];
  return conformanceDigest(copy);
}
