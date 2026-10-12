/**
 * PAY-04 — the grammars an MPP `Payment` challenge is carried in, parsed
 * strictly on the client side. Pure and total: no I/O, no clock, no
 * dependency; malformed input is a closed refusal, never a throw.
 *
 * Baseline: `draft-httpauth-payment-01` (tempoxyz/mpp-specs `08e7dd8`,
 * 2026-09-23), pinned by P13 and kept unchanged by PAY-04
 * (`docs/payments/PAY-04-PAYMENT-PROTOCOL-ADAPTER.md` §3).
 *
 * - RFC 9110 §11 `#challenge` lists — never `split(',')`;
 * - base64url without padding, strict: alphabet, no `=`, no impossible length,
 *   zero trailing bits (one spelling per byte string);
 * - UTF-8, fatal: an invalid sequence refuses, it is never replaced;
 * - JSON, bounded, data only, and JCS-canonical (RFC 8785): the decoded text
 *   must equal the canonical serialization of the value it parses to;
 * - RFC 3339 `date-time`, strict, computed without `Date`.
 */

/** Bounds on every allocation from an untrusted header. */
export const MPP_CHALLENGE_LIMITS = Object.freeze({
  /** One `WWW-Authenticate` field value, and all of them together. The draft asks servers to stay under 8 KiB per challenge and clients to handle at least 4 KiB. */
  maxHeaderLength: 16_384,
  maxHeaderValues: 16,
  /** Challenges of any scheme across every field value. */
  maxChallenges: 16,
  /** Auth-params in one challenge, known and unknown alike. */
  maxParams: 32,
  maxParamValueLength: 8_192,
  maxIdLength: 512,
  maxRealmLength: 256,
  maxMethodLength: 64,
  maxIntentLength: 64,
  maxExpiresLength: 64,
  maxDigestLength: 512,
  maxDescriptionLength: 1_024,
  /** Decoded bytes. */
  maxRequestBytes: 6_144,
  maxOpaqueBytes: 2_048,
  maxJsonDepth: 16,
  /** Object members plus array elements, across the whole document. */
  maxJsonMembers: 256,
  maxOpaqueEntries: 64,
});

// ─── RFC 9110 §11 challenge tokenizer ────────────────────────────────────────

/** One challenge of any scheme, as the field syntax carries it. */
export interface RawAuthChallenge {
  readonly scheme: string;
  /** Lower-cased names, values unescaped, in order; duplicates retained so they can be refused. */
  readonly params: readonly (readonly [string, string])[];
  readonly token68?: string;
}

function isTchar(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39) ||
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    code === 0x21 ||
    (code >= 0x23 && code <= 0x27) ||
    code === 0x2a ||
    code === 0x2b ||
    code === 0x2d ||
    code === 0x2e ||
    code === 0x5e ||
    code === 0x5f ||
    code === 0x60 ||
    code === 0x7c ||
    code === 0x7e
  );
}

function isToken68Char(code: number): boolean {
  return (code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a) || code === 0x2d || code === 0x2e || code === 0x5f || code === 0x7e || code === 0x2b || code === 0x2f;
}

class HeaderSyntaxError extends Error {}

/**
 * Tokenizes one field value into challenges, exactly per RFC 9110 §11:
 * `challenge = auth-scheme [ 1*SP ( token68 / #auth-param ) ]` inside a
 * `#challenge` list. A comma separates either two auth-params of one challenge
 * or two challenges; which one is decided by lookahead (`token BWS "="` is a
 * parameter), never by splitting on commas, so a comma inside a quoted string
 * is data. Any syntax error refuses the whole value.
 */
function tokenizeFieldValue(value: string, out: RawAuthChallenge[]): void {
  let pos = 0;
  const length = value.length;
  const code = (at: number): number => (at < length ? value.charCodeAt(at) : -1);
  const skipOws = (): void => {
    while (code(pos) === 0x20 || code(pos) === 0x09) pos += 1;
  };
  const readToken = (): string => {
    const start = pos;
    while (pos < length && isTchar(code(pos))) pos += 1;
    return value.slice(start, pos);
  };
  const readQuoted = (): string => {
    // At the opening DQUOTE.
    pos += 1;
    let text = '';
    for (;;) {
      if (pos >= length) throw new HeaderSyntaxError('unterminated quoted-string');
      const c = code(pos);
      if (c === 0x22) {
        pos += 1;
        return text;
      }
      if (c === 0x5c) {
        const next = code(pos + 1);
        if (next === -1 || !(next === 0x09 || (next >= 0x20 && next <= 0x7e) || (next >= 0x80 && next <= 0xff))) throw new HeaderSyntaxError('invalid quoted-pair');
        text += value.charAt(pos + 1);
        pos += 2;
      } else {
        if (!(c === 0x09 || c === 0x20 || c === 0x21 || (c >= 0x23 && c <= 0x5b) || (c >= 0x5d && c <= 0x7e) || (c >= 0x80 && c <= 0xff))) throw new HeaderSyntaxError('invalid qdtext');
        text += value.charAt(pos);
        pos += 1;
      }
      if (text.length > MPP_CHALLENGE_LIMITS.maxParamValueLength) throw new HeaderSyntaxError('parameter value too long');
    }
  };
  /** Whether an auth-param (`token BWS "="`, not a token68's trailing `=`) starts at `at`. */
  const paramStartsAt = (at: number): boolean => {
    let cursor = at;
    const start = cursor;
    while (cursor < length && isTchar(code(cursor))) cursor += 1;
    if (cursor === start) return false;
    while (code(cursor) === 0x20 || code(cursor) === 0x09) cursor += 1;
    if (code(cursor) !== 0x3d) return false;
    cursor += 1;
    while (code(cursor) === 0x20 || code(cursor) === 0x09) cursor += 1;
    const after = code(cursor);
    // `name=` followed by `=`, `,` or the end is a token68 with padding, not a parameter.
    return after !== -1 && after !== 0x3d && after !== 0x2c;
  };

  for (;;) {
    // #challenge: empty elements and OWS around commas are allowed.
    for (;;) {
      skipOws();
      if (code(pos) === 0x2c) {
        pos += 1;
        continue;
      }
      break;
    }
    if (pos >= length) return;
    const scheme = readToken();
    if (scheme.length === 0) throw new HeaderSyntaxError('expected an auth-scheme');
    const params: (readonly [string, string])[] = [];
    let token68: string | undefined;

    const spaceStart = pos;
    while (code(pos) === 0x20) pos += 1;
    const spaced = pos > spaceStart;
    skipOws();
    if (pos < length && code(pos) !== 0x2c) {
      if (!spaced) throw new HeaderSyntaxError('an auth-scheme must be followed by SP');
      if (paramStartsAt(pos)) {
        for (;;) {
          const name = readToken().toLowerCase();
          skipOws();
          if (code(pos) !== 0x3d) throw new HeaderSyntaxError('expected "="');
          pos += 1;
          skipOws();
          const quoted = code(pos) === 0x22;
          const paramValue = quoted ? readQuoted() : readToken();
          if (!quoted && paramValue.length === 0) throw new HeaderSyntaxError('expected a token or quoted-string');
          if (paramValue.length > MPP_CHALLENGE_LIMITS.maxParamValueLength) throw new HeaderSyntaxError('parameter value too long');
          params.push(Object.freeze([name, paramValue] as const));
          if (params.length > MPP_CHALLENGE_LIMITS.maxParams) throw new HeaderSyntaxError('too many parameters');
          skipOws();
          if (pos >= length) break;
          if (code(pos) !== 0x2c) throw new HeaderSyntaxError('expected "," between parameters');
          // A comma: another parameter of this challenge, or the next challenge.
          let lookahead = pos;
          for (;;) {
            while (code(lookahead) === 0x20 || code(lookahead) === 0x09) lookahead += 1;
            if (code(lookahead) === 0x2c) {
              lookahead += 1;
              continue;
            }
            break;
          }
          if (lookahead < length && paramStartsAt(lookahead)) {
            pos = lookahead;
            continue;
          }
          break;
        }
      } else {
        const start = pos;
        while (pos < length && isToken68Char(code(pos))) pos += 1;
        if (pos === start) throw new HeaderSyntaxError('expected token68 or auth-params');
        while (code(pos) === 0x3d) pos += 1;
        token68 = value.slice(start, pos);
        skipOws();
        if (pos < length && code(pos) !== 0x2c) throw new HeaderSyntaxError('unexpected text after token68');
      }
    }
    out.push(Object.freeze({ scheme, params: Object.freeze(params), ...(token68 !== undefined ? { token68 } : {}) }));
    if (out.length > MPP_CHALLENGE_LIMITS.maxChallenges) throw new HeaderSyntaxError('too many challenges');
  }
}

export type AuthenticateParse = { readonly valid: true; readonly challenges: readonly RawAuthChallenge[] } | { readonly valid: false; readonly violation: string };

/** CR, LF, NUL and every other control character except HTAB; nothing above Latin-1. */
const FIELD_VALUE_FORBIDDEN = /[\u0000-\u0008\u000a-\u001f\u007f]|[^\u0000-ÿ]/u;

/**
 * Every challenge of every scheme in the given `WWW-Authenticate` field
 * values. Each value is tokenized on its own; a value that is not a string,
 * too long, carries a control or non-Latin-1 character, or breaks the grammar
 * refuses the whole set. Total: never throws.
 */
export function parseWwwAuthenticate(values: unknown): AuthenticateParse {
  let list: unknown[];
  try {
    if (typeof values === 'string') {
      list = [values];
    } else if (Array.isArray(values)) {
      // `length` read once: an exotic array cannot report a small bound and then grow.
      const length: unknown = values.length;
      if (typeof length !== 'number' || !Number.isSafeInteger(length) || length > MPP_CHALLENGE_LIMITS.maxHeaderValues) return { valid: false, violation: 'expected one to sixteen WWW-Authenticate field values' };
      list = [];
      // Each index read once from its descriptor: a getter or a hole is not a field value.
      for (let index = 0; index < length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(values, index);
        if (descriptor === undefined || !('value' in descriptor)) return { valid: false, violation: 'a field value is not data' };
        list.push(descriptor.value as unknown);
      }
    } else {
      list = [];
    }
  } catch {
    return { valid: false, violation: 'the field values could not be read' };
  }
  if (list.length === 0 || list.length > MPP_CHALLENGE_LIMITS.maxHeaderValues) return { valid: false, violation: 'expected one to sixteen WWW-Authenticate field values' };
  let total = 0;
  const challenges: RawAuthChallenge[] = [];
  for (const value of list) {
    if (typeof value !== 'string') return { valid: false, violation: 'a field value is not a string' };
    total += value.length;
    if (value.length > MPP_CHALLENGE_LIMITS.maxHeaderLength || total > MPP_CHALLENGE_LIMITS.maxHeaderLength) return { valid: false, violation: 'the field values exceed the size bound' };
    if (FIELD_VALUE_FORBIDDEN.test(value)) return { valid: false, violation: 'a field value carries a control or non-Latin-1 character' };
    try {
      tokenizeFieldValue(value, challenges);
    } catch (error) {
      return { valid: false, violation: error instanceof HeaderSyntaxError ? `malformed challenge list: ${error.message}` : 'malformed challenge list' };
    }
  }
  return { valid: true, challenges: Object.freeze(challenges) };
}

// ─── base64url, UTF-8 and canonical JSON ─────────────────────────────────────

const BASE64URL_NOPAD = /^[A-Za-z0-9_-]+$/;
const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/**
 * Strict base64url without padding: the alphabet, no `=`, no impossible
 * length (`4n + 1`), the decoded size bounded **before** anything is
 * allocated, and zero trailing bits — so exactly one text spells each byte
 * string.
 */
export function decodeBase64UrlNoPad(text: string, maxBytes: number): Uint8Array | undefined {
  if (typeof text !== 'string' || text.length === 0 || !BASE64URL_NOPAD.test(text)) return undefined;
  const remainder = text.length % 4;
  if (remainder === 1) return undefined;
  const byteLength = ((text.length - remainder) / 4) * 3 + (remainder === 0 ? 0 : remainder - 1);
  if (byteLength > maxBytes) return undefined;
  const bytes = new Uint8Array(byteLength);
  let accumulator = 0;
  let bits = 0;
  let written = 0;
  for (let index = 0; index < text.length; index += 1) {
    accumulator = ((accumulator << 6) | BASE64URL_ALPHABET.indexOf(text.charAt(index))) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[written] = (accumulator >> bits) & 0xff;
      written += 1;
    }
  }
  // The bits left over must be zero: a non-zero tail is a second spelling of the same bytes.
  if ((accumulator & ((1 << bits) - 1)) !== 0) return undefined;
  return written === byteLength ? bytes : undefined;
}

/** UTF-8, fatal: an invalid sequence refuses; a byte order mark is kept as data (and then fails canonical JSON). */
export function decodeUtf8Fatal(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

/** JSON member names that could reach an object's prototype in a careless consumer. Refused anywhere in a document. */
const FORBIDDEN_JSON_KEYS: readonly string[] = ['__proto__', 'constructor', 'prototype'];
/** A lone surrogate: not a Unicode scalar value, so not I-JSON (RFC 7493), so not JCS. */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u;

/** A decoded JSON value: data only, deep-frozen. */
export type MppJsonValue = null | boolean | number | string | readonly MppJsonValue[] | { readonly [key: string]: MppJsonValue };

/**
 * RFC 8785 serialization of a value `JSON.parse` produced: members sorted by
 * UTF-16 code unit, ECMAScript string and number serialization, no
 * whitespace. `undefined` for a value with no canonical form (a non-finite
 * number, a lone surrogate).
 */
function jcs(value: unknown): string | undefined {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : undefined;
  if (typeof value === 'string') return LONE_SURROGATE.test(value) ? undefined : JSON.stringify(value);
  if (Array.isArray(value)) {
    const items: string[] = [];
    for (const item of value as unknown[]) {
      const serialized = jcs(item);
      if (serialized === undefined) return undefined;
      items.push(serialized);
    }
    return `[${items.join(',')}]`;
  }
  if (typeof value === 'object') {
    const members: string[] = [];
    for (const key of Object.keys(value).sort()) {
      if (LONE_SURROGATE.test(key)) return undefined;
      const serialized = jcs((value as Record<string, unknown>)[key]);
      if (serialized === undefined) return undefined;
      members.push(`${JSON.stringify(key)}:${serialized}`);
    }
    return `{${members.join(',')}}`;
  }
  return undefined;
}

/** Bounded depth and member count; no prototype-shaped member names. Walks what `JSON.parse` produced — plain data only. */
function jsonShapeViolation(value: unknown): string | undefined {
  let members = 0;
  const walk = (entry: unknown, depth: number): string | undefined => {
    if (depth > MPP_CHALLENGE_LIMITS.maxJsonDepth) return 'nested too deeply';
    if (Array.isArray(entry)) {
      for (const item of entry as unknown[]) {
        members += 1;
        if (members > MPP_CHALLENGE_LIMITS.maxJsonMembers) return 'too many members';
        const violation = walk(item, depth + 1);
        if (violation !== undefined) return violation;
      }
      return undefined;
    }
    if (entry !== null && typeof entry === 'object') {
      for (const key of Object.keys(entry)) {
        if (FORBIDDEN_JSON_KEYS.includes(key)) return 'a prototype-shaped member name';
        members += 1;
        if (members > MPP_CHALLENGE_LIMITS.maxJsonMembers) return 'too many members';
        const violation = walk((entry as Record<string, unknown>)[key], depth + 1);
        if (violation !== undefined) return violation;
      }
    }
    return undefined;
  };
  return walk(value, 0);
}

function deepFreezeJson<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) deepFreezeJson((value as Record<string, unknown>)[key]);
    Object.freeze(value);
  }
  return value;
}

export type CanonicalJsonDecode = { readonly valid: true; readonly value: { readonly [key: string]: MppJsonValue } } | { readonly valid: false; readonly violation: string };

/**
 * base64url (no padding) → UTF-8 (fatal) → a JSON **object** that is bounded,
 * free of prototype-shaped names and **JCS-canonical**: the decoded text must
 * equal its RFC 8785 serialization. A duplicate member, a non-shortest number,
 * whitespace, a byte order mark or any other alternative spelling fails the
 * round trip. Total: never throws.
 */
export function decodeCanonicalJsonObject(text: string, maxBytes: number): CanonicalJsonDecode {
  const bytes = decodeBase64UrlNoPad(text, maxBytes);
  if (bytes === undefined) return { valid: false, violation: 'not canonical base64url without padding, or too large' };
  const decoded = decodeUtf8Fatal(bytes);
  if (decoded === undefined) return { valid: false, violation: 'not valid UTF-8' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded) as unknown;
  } catch {
    return { valid: false, violation: 'not valid JSON' };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { valid: false, violation: 'not a JSON object' };
  const shape = jsonShapeViolation(parsed);
  if (shape !== undefined) return { valid: false, violation: shape };
  if (jcs(parsed) !== decoded) return { valid: false, violation: 'not JCS-canonical (RFC 8785)' };
  return { valid: true, value: deepFreezeJson(parsed as { readonly [key: string]: MppJsonValue }) };
}

// ─── RFC 3339 date-time ──────────────────────────────────────────────────────

const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(\.\d{1,9})?(?:([Zz])|([+-])(\d{2}):(\d{2}))$/;

/** The value of a run of ASCII digits, computed digit by digit. Calendar components only — never money. */
function digitsValue(text: string | undefined): number {
  let total = 0;
  for (const character of text ?? '') total = total * 10 + (character.charCodeAt(0) - 0x30);
  return total;
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

const DAYS_IN_MONTH: readonly number[] = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** Days since 1970-01-01 of a proleptic Gregorian date (year ≥ 1970), in exact integer arithmetic. */
function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = (y - (y % 400)) / 400;
  const yearOfEra = y - era * 400;
  const shiftedMonth = (month + 9) % 12;
  const dayOfYear = (153 * shiftedMonth + 2 - ((153 * shiftedMonth + 2) % 5)) / 5 + day - 1;
  const dayOfEra = yearOfEra * 365 + (yearOfEra - (yearOfEra % 4)) / 4 - (yearOfEra - (yearOfEra % 100)) / 100 + dayOfYear;
  return era * 146_097 + dayOfEra - 719_468;
}

/**
 * Milliseconds since the epoch of a strict RFC 3339 `date-time`, or
 * `undefined`. Years 1970 … 9999; no leap second; no out-of-range component;
 * no lenient `Date.parse` spelling. Fractional seconds beyond milliseconds are
 * truncated, which can only make an expiry earlier.
 */
export function rfc3339EpochMilliseconds(value: unknown): number | undefined {
  if (typeof value !== 'string' || value.length > MPP_CHALLENGE_LIMITS.maxExpiresLength) return undefined;
  const match = RFC3339.exec(value);
  if (match === null) return undefined;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fraction, zulu, sign, zoneHourText, zoneMinuteText] = match;
  const year = digitsValue(yearText);
  const month = digitsValue(monthText);
  const day = digitsValue(dayText);
  const hour = digitsValue(hourText);
  const minute = digitsValue(minuteText);
  const second = digitsValue(secondText);
  if (year < 1970 || month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return undefined;
  const daysInMonth = month === 2 && isLeapYear(year) ? 29 : (DAYS_IN_MONTH[month - 1] ?? 0);
  if (day > daysInMonth) return undefined;
  let offsetMinutes = 0;
  if (zulu === undefined) {
    const zoneHour = digitsValue(zoneHourText);
    const zoneMinute = digitsValue(zoneMinuteText);
    if (zoneHour > 23 || zoneMinute > 59) return undefined;
    offsetMinutes = (sign === '-' ? -1 : 1) * (zoneHour * 60 + zoneMinute);
  }
  const milliseconds = fraction === undefined ? 0 : digitsValue(fraction.slice(1, 4).padEnd(3, '0'));
  const epoch = (((daysFromCivil(year, month, day) * 24 + hour) * 60 + minute) * 60 + second) * 1000 + milliseconds - offsetMinutes * 60_000;
  return Number.isSafeInteger(epoch) ? epoch : undefined;
}
