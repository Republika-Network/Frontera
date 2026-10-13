/**
 * PAY-08 — the encodings an x402 v2 message travels in, read strictly on the
 * paying side. Pure and total: no I/O, no clock, no dependency, no Node API;
 * malformed input is a closed refusal, never a throw.
 *
 * Baseline: x402 v2 (`x402-foundation/x402` at
 * `f8f83309706b14cc696962f0a002eeeb66c3dc26`, `specs/transports-v2/http.md`).
 * Every x402 HTTP header carries **base64-encoded JSON**:
 *
 * - base64 is the standard alphabet with padding (RFC 4648 §4), read
 *   canonically: whole quanta, `=` only as padding, zero pad bits — so one
 *   byte string has exactly one accepted spelling, and base64url, unpadded or
 *   whitespace-broken text is refused rather than repaired;
 * - the decoded bytes are UTF-8, decoded fatally (an invalid, overlong or
 *   surrogate sequence refuses; nothing is replaced) with no byte order mark;
 * - the text is one JSON value (RFC 8259), parsed by hand and bounded: a
 *   duplicated member name refuses the whole document (never first- or
 *   last-wins), `__proto__` / `constructor` / `prototype` never become keys,
 *   lone surrogates are refused, depth, member and string sizes are bounded
 *   **before** they are allocated, and trailing text refuses.
 *
 * JSON numbers are never turned into JavaScript numbers here. They are kept
 * as their exact source text (`X402JsonNumber`), so a monetary-looking value
 * can never be rounded, and an echoed value is re-emitted byte for byte.
 */

/** Bounds on every allocation from an untrusted x402 header. */
export const X402_CODEC_LIMITS = Object.freeze({
  /** Characters of one base64 header value. Decoded bytes are bounded by it before anything is allocated. */
  maxHeaderLength: 16_384,
  maxJsonDepth: 16,
  /** Object members plus array elements, across the whole document. */
  maxJsonMembers: 512,
  /** Characters of one JSON string after unescaping. */
  maxJsonStringLength: 8_192,
  /** Characters of one JSON number. */
  maxJsonNumberLength: 64,
});

// ─── base64 (RFC 4648 §4, padded, canonical) ─────────────────────────────────

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const BASE64_TEXT = /^[A-Za-z0-9+/]*={0,2}$/;

function base64Index(code: number): number {
  if (code >= 0x41 && code <= 0x5a) return code - 0x41;
  if (code >= 0x61 && code <= 0x7a) return code - 0x61 + 26;
  if (code >= 0x30 && code <= 0x39) return code - 0x30 + 52;
  if (code === 0x2b) return 62;
  if (code === 0x2f) return 63;
  return -1;
}

/**
 * Canonical padded base64 → bytes, or `undefined`. The decoded size is
 * computed from the text's length and checked against `maxBytes` before any
 * allocation.
 */
export function decodeX402Base64(text: unknown, maxBytes: number): Uint8Array | undefined {
  if (typeof text !== 'string' || text.length === 0 || text.length % 4 !== 0 || !BASE64_TEXT.test(text)) return undefined;
  const padding = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0;
  const size = (text.length / 4) * 3 - padding;
  if (size <= 0 || size > maxBytes) return undefined;
  const bytes = new Uint8Array(size);
  let out = 0;
  for (let index = 0; index < text.length; index += 4) {
    const a = base64Index(text.charCodeAt(index));
    const b = base64Index(text.charCodeAt(index + 1));
    const last = index + 4 === text.length;
    const c = last && padding === 2 ? 0 : base64Index(text.charCodeAt(index + 2));
    const d = last && padding >= 1 ? 0 : base64Index(text.charCodeAt(index + 3));
    if (a < 0 || b < 0 || c < 0 || d < 0) return undefined;
    // One spelling per byte string: the bits a padded quantum does not carry must be zero.
    if (last && padding === 2 && (b & 0x0f) !== 0) return undefined;
    if (last && padding === 1 && (c & 0x03) !== 0) return undefined;
    const triple = (a << 18) | (b << 12) | (c << 6) | d;
    bytes[out++] = (triple >>> 16) & 0xff;
    if (out < size) bytes[out++] = (triple >>> 8) & 0xff;
    if (out < size) bytes[out++] = triple & 0xff;
  }
  return bytes;
}

/** Bytes → canonical padded base64. */
export function encodeX402Base64(bytes: Uint8Array): string {
  let text = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index] ?? 0;
    const b = bytes[index + 1] ?? 0;
    const c = bytes[index + 2] ?? 0;
    const triple = (a << 16) | (b << 8) | c;
    text += BASE64_ALPHABET.charAt((triple >>> 18) & 0x3f) + BASE64_ALPHABET.charAt((triple >>> 12) & 0x3f);
    text += index + 1 < bytes.length ? BASE64_ALPHABET.charAt((triple >>> 6) & 0x3f) : '=';
    text += index + 2 < bytes.length ? BASE64_ALPHABET.charAt(triple & 0x3f) : '=';
  }
  return text;
}

// ─── UTF-8 (fatal) ───────────────────────────────────────────────────────────

/** Strict UTF-8 → text, or `undefined`: no overlong form, no surrogate, nothing above U+10FFFF, no byte order mark. */
export function decodeX402Utf8(bytes: Uint8Array): string | undefined {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return undefined;
  const units: number[] = [];
  let text = '';
  for (let index = 0; index < bytes.length; ) {
    const first = bytes[index] ?? 0;
    let point: number;
    let length: number;
    if (first < 0x80) {
      point = first;
      length = 1;
    } else if (first >= 0xc2 && first <= 0xdf) {
      point = first & 0x1f;
      length = 2;
    } else if (first >= 0xe0 && first <= 0xef) {
      point = first & 0x0f;
      length = 3;
    } else if (first >= 0xf0 && first <= 0xf4) {
      point = first & 0x07;
      length = 4;
    } else {
      return undefined;
    }
    if (index + length > bytes.length) return undefined;
    for (let offset = 1; offset < length; offset += 1) {
      const next = bytes[index + offset] ?? 0;
      if ((next & 0xc0) !== 0x80) return undefined;
      point = (point << 6) | (next & 0x3f);
    }
    if ((length === 3 && point < 0x800) || (length === 4 && (point < 0x10000 || point > 0x10ffff)) || (point >= 0xd800 && point <= 0xdfff)) return undefined;
    if (point >= 0x10000) {
      const rest = point - 0x10000;
      units.push(0xd800 + (rest >>> 10), 0xdc00 + (rest & 0x3ff));
    } else {
      units.push(point);
    }
    if (units.length >= 4_096) {
      text += String.fromCharCode(...units);
      units.length = 0;
    }
    index += length;
  }
  return text + String.fromCharCode(...units);
}

/** Text → UTF-8, or `undefined` when the text holds a lone surrogate (not encodable). */
export function encodeX402Utf8(text: string): Uint8Array | undefined {
  const out: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    let point = text.charCodeAt(index);
    if (point >= 0xd800 && point <= 0xdbff) {
      const low = text.charCodeAt(index + 1);
      if (!(low >= 0xdc00 && low <= 0xdfff)) return undefined;
      point = 0x10000 + ((point - 0xd800) << 10) + (low - 0xdc00);
      index += 1;
    } else if (point >= 0xdc00 && point <= 0xdfff) {
      return undefined;
    }
    if (point < 0x80) out.push(point);
    else if (point < 0x800) out.push(0xc0 | (point >>> 6), 0x80 | (point & 0x3f));
    else if (point < 0x10000) out.push(0xe0 | (point >>> 12), 0x80 | ((point >>> 6) & 0x3f), 0x80 | (point & 0x3f));
    else out.push(0xf0 | (point >>> 18), 0x80 | ((point >>> 12) & 0x3f), 0x80 | ((point >>> 6) & 0x3f), 0x80 | (point & 0x3f));
  }
  return Uint8Array.from(out);
}

// ─── JSON (RFC 8259, strict, bounded) ────────────────────────────────────────

/** A JSON number, kept as its exact source text. Never a JavaScript number. */
export class X402JsonNumber {
  constructor(readonly text: string) {
    Object.freeze(this);
  }
}

/** A JSON object: a frozen record with a null prototype and data properties only. */
export type X402JsonObject = { readonly [key: string]: X402Json };
export type X402Json = null | boolean | string | X402JsonNumber | readonly X402Json[] | X402JsonObject;

export type X402JsonDecode = { readonly valid: true; readonly value: X402Json } | { readonly valid: false; readonly violation: string };

const FORBIDDEN_KEYS: readonly string[] = ['__proto__', 'constructor', 'prototype'];
const NUMBER = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/;

class JsonRefusal {
  constructor(readonly violation: string) {}
}

const refuse = (violation: string): never => {
  throw new JsonRefusal(violation);
};

/** Whether a value is a JSON object as this codec produces it (a null-prototype record). */
export function isX402JsonObject(value: unknown): value is X402JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof X402JsonNumber) && Object.getPrototypeOf(value) === null;
}

/**
 * One JSON document → a frozen tree, or a closed refusal. Total: never throws.
 * Surrounding whitespace is JSON's own; anything after the value refuses.
 */
export function parseX402Json(text: string): X402JsonDecode {
  let position = 0;
  let members = 0;

  const whitespace = (): void => {
    while (position < text.length) {
      const code = text.charCodeAt(position);
      if (code !== 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) return;
      position += 1;
    }
  };

  const countMember = (): void => {
    members += 1;
    if (members > X402_CODEC_LIMITS.maxJsonMembers) refuse('json-too-many-members');
  };

  const readString = (): string => {
    // At the opening quote.
    position += 1;
    let out = '';
    for (;;) {
      if (position >= text.length) refuse('json-string-unterminated');
      const code = text.charCodeAt(position);
      if (code === 0x22) {
        position += 1;
        break;
      }
      if (code < 0x20) refuse('json-string-control');
      if (code === 0x5c) {
        const escape = text.charAt(position + 1);
        position += 2;
        switch (escape) {
          case '"':
            out += '"';
            break;
          case '\\':
            out += '\\';
            break;
          case '/':
            out += '/';
            break;
          case 'b':
            out += '\b';
            break;
          case 'f':
            out += '\f';
            break;
          case 'n':
            out += '\n';
            break;
          case 'r':
            out += '\r';
            break;
          case 't':
            out += '\t';
            break;
          case 'u': {
            const hex = text.slice(position, position + 4);
            if (!/^[0-9A-Fa-f]{4}$/.test(hex)) refuse('json-string-escape');
            let unit = 0;
            for (const digit of hex) unit = unit * 16 + '0123456789abcdef'.indexOf(digit.toLowerCase());
            out += String.fromCharCode(unit);
            position += 4;
            break;
          }
          default:
            refuse('json-string-escape');
        }
      } else {
        out += text.charAt(position);
        position += 1;
      }
      if (out.length > X402_CODEC_LIMITS.maxJsonStringLength) refuse('json-string-too-long');
    }
    // I-JSON (RFC 7493): no lone surrogate, escaped or not.
    for (let index = 0; index < out.length; index += 1) {
      const unit = out.charCodeAt(index);
      if (unit >= 0xd800 && unit <= 0xdbff) {
        const low = out.charCodeAt(index + 1);
        if (!(low >= 0xdc00 && low <= 0xdfff)) refuse('json-string-lone-surrogate');
        index += 1;
      } else if (unit >= 0xdc00 && unit <= 0xdfff) {
        refuse('json-string-lone-surrogate');
      }
    }
    return out;
  };

  const readValue = (depth: number): X402Json => {
    if (depth > X402_CODEC_LIMITS.maxJsonDepth) refuse('json-too-deep');
    whitespace();
    const code = text.charCodeAt(position);
    if (code === 0x7b) {
      position += 1;
      const record = Object.create(null) as Record<string, X402Json>;
      const seen = new Set<string>();
      whitespace();
      if (text.charCodeAt(position) === 0x7d) {
        position += 1;
        return Object.freeze(record);
      }
      for (;;) {
        whitespace();
        if (text.charCodeAt(position) !== 0x22) refuse('json-member-name');
        const key = readString();
        if (seen.has(key)) refuse('json-duplicate-member');
        if (FORBIDDEN_KEYS.includes(key)) refuse('json-forbidden-member');
        seen.add(key);
        countMember();
        whitespace();
        if (text.charCodeAt(position) !== 0x3a) refuse('json-member-separator');
        position += 1;
        const value = readValue(depth + 1);
        Object.defineProperty(record, key, { value, enumerable: true, writable: false, configurable: false });
        whitespace();
        const next = text.charCodeAt(position);
        position += 1;
        if (next === 0x2c) continue;
        if (next === 0x7d) break;
        refuse('json-object-unterminated');
      }
      return Object.freeze(record);
    }
    if (code === 0x5b) {
      position += 1;
      const items: X402Json[] = [];
      whitespace();
      if (text.charCodeAt(position) === 0x5d) {
        position += 1;
        return Object.freeze(items);
      }
      for (;;) {
        countMember();
        items.push(readValue(depth + 1));
        whitespace();
        const next = text.charCodeAt(position);
        position += 1;
        if (next === 0x2c) continue;
        if (next === 0x5d) break;
        refuse('json-array-unterminated');
      }
      return Object.freeze(items);
    }
    if (code === 0x22) return readString();
    if (text.startsWith('true', position)) {
      position += 4;
      return true;
    }
    if (text.startsWith('false', position)) {
      position += 5;
      return false;
    }
    if (text.startsWith('null', position)) {
      position += 4;
      return null;
    }
    const match = NUMBER.exec(text.slice(position, position + X402_CODEC_LIMITS.maxJsonNumberLength + 1));
    if (match === null || match[0].length === 0) return refuse('json-value');
    if (match[0].length > X402_CODEC_LIMITS.maxJsonNumberLength) refuse('json-number-too-long');
    position += match[0].length;
    return new X402JsonNumber(match[0]);
  };

  try {
    if (typeof text !== 'string') return { valid: false, violation: 'json-not-text' };
    const value = readValue(1);
    whitespace();
    if (position !== text.length) return { valid: false, violation: 'json-trailing-text' };
    return { valid: true, value };
  } catch (error) {
    return { valid: false, violation: error instanceof JsonRefusal ? error.violation : 'json-value' };
  }
}

/**
 * The canonical serialization of a tree this codec produced (or one built of
 * the same kinds): members sorted by UTF-16 code units (RFC 8785's order),
 * strings escaped as RFC 8785 escapes them, no whitespace, numbers emitted as
 * their exact source text. `undefined` for anything else.
 */
export function serializeX402Json(value: unknown): string | undefined {
  try {
    return serialize(value, 0);
  } catch {
    return undefined;
  }
}

function serialize(value: unknown, depth: number): string {
  if (depth > X402_CODEC_LIMITS.maxJsonDepth + 2) throw new JsonRefusal('json-too-deep');
  if (value === null) return 'null';
  if (value === true) return 'true';
  if (value === false) return 'false';
  if (typeof value === 'string') {
    if (encodeX402Utf8(value) === undefined) throw new JsonRefusal('json-string-lone-surrogate');
    return JSON.stringify(value);
  }
  if (value instanceof X402JsonNumber) {
    if (!NUMBER.test(value.text) || NUMBER.exec(value.text)?.[0] !== value.text) throw new JsonRefusal('json-value');
    return value.text;
  }
  if (Array.isArray(value)) return `[${value.map((item: unknown) => serialize(item, depth + 1)).join(',')}]`;
  if (typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== null && prototype !== Object.prototype) throw new JsonRefusal('json-value');
    const parts: string[] = [];
    for (const key of Reflect.ownKeys(value).sort()) {
      if (typeof key !== 'string') throw new JsonRefusal('json-value');
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !('value' in descriptor)) throw new JsonRefusal('json-value');
      parts.push(`${serialize(key, depth + 1)}:${serialize(descriptor.value, depth + 1)}`);
    }
    return `{${parts.join(',')}}`;
  }
  throw new JsonRefusal('json-value');
}

/**
 * A non-negative JSON integer in canonical spelling (`0`, or no leading zero;
 * no sign, fraction or exponent) not above `maximum`, as a number — computed
 * digit by digit, never by a numeric conversion of untrusted text. Only for
 * protocol control values (versions, timeouts), never money.
 */
export function x402IntegerOf(value: unknown, maximum: number): number | undefined {
  if (!(value instanceof X402JsonNumber) || !/^(?:0|[1-9][0-9]{0,14})$/.test(value.text)) return undefined;
  let result = 0;
  for (const digit of value.text) result = result * 10 + (digit.charCodeAt(0) - 0x30);
  return result <= maximum ? result : undefined;
}

/** Bytes → canonical base64 of their UTF-8 JSON text: what an x402 header value carries. */
export function encodeX402JsonHeader(value: unknown): string | undefined {
  const text = serializeX402Json(value);
  if (text === undefined) return undefined;
  const bytes = encodeX402Utf8(text);
  return bytes === undefined ? undefined : encodeX402Base64(bytes);
}

/** One x402 header value → its JSON value: canonical base64, then fatal UTF-8, then strict JSON. */
export function decodeX402JsonHeader(value: unknown): X402JsonDecode {
  if (typeof value !== 'string') return { valid: false, violation: 'header-not-text' };
  if (value.length > X402_CODEC_LIMITS.maxHeaderLength) return { valid: false, violation: 'header-oversized' };
  const bytes = decodeX402Base64(value, X402_CODEC_LIMITS.maxHeaderLength);
  if (bytes === undefined) return { valid: false, violation: 'header-base64-invalid' };
  const text = decodeX402Utf8(bytes);
  if (text === undefined) return { valid: false, violation: 'header-utf8-invalid' };
  return parseX402Json(text);
}
