import { createHash } from 'node:crypto';

import { canonicalSerialize } from '../governance-store/canonical-json.js';

/**
 * P13 — the MPP `Payment` HTTP authentication challenge, parsed and validated
 * on the **client** side.
 *
 * Baseline: `draft-httpauth-payment-01` (tempoxyz/mpp-specs `08e7dd8`,
 * 2026-09-23) and `draft-payment-intent-charge-00`. See
 * `docs/architecture/ADR-MPP-CHALLENGE-AND-BUSINESS-IDEMPOTENCY.md`.
 *
 * ## What "valid" means here — and what it cannot mean
 *
 * A challenge that passes this module is **well formed**: its required
 * parameters are present exactly once, its encodings are canonical, its
 * decoded JSON is bounded, and its optional parameters are in their declared
 * syntax. It is **not authentic**. The challenge `id` is bound by the issuing
 * server — by an HMAC, authenticated encryption or a stateful table — under a
 * secret a client never holds. No client can verify it, and nothing here
 * claims to. The server verifies its own binding when a credential (P14) is
 * presented.
 *
 * ## Strictness beyond the draft, fail-closed
 *
 * - A **duplicated** known parameter makes that challenge invalid. The draft
 *   states no rule; first-wins and last-wins are both refused.
 * - `request` and `opaque` must be **JCS-canonical** (RFC 8785): the decoded
 *   text must equal the canonical serialization of the value it parses to. The
 *   draft requires servers to serialize canonically; this client refuses what a
 *   server did not.
 * - `__proto__`, `constructor` and `prototype` are refused as JSON member
 *   names anywhere in `request` and `opaque`.
 * - `header`, when present, must be exactly `Payment-Authorization`; any other
 *   value is an unrecognized challenge, as the draft requires.
 *
 * Unknown parameters are ignored, as the draft requires: they are never
 * retained, persisted or passed on.
 *
 * The raw accepted strings are what is kept. Decoded JSON exists for
 * validation and for a trusted method normalizer only; it is never re-encoded
 * into a "new original".
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

export const MPP_PAYMENT_AUTHORIZATION_HEADER = 'Payment-Authorization';

/** The draft's `payment-method-id = 1*LOWERALPHA`. */
const METHOD = /^[a-z]+$/;
/** The draft's `intent = 1*( ALPHA / DIGIT / "-" )`. */
const INTENT = /^[A-Za-z0-9-]+$/;
const BASE64URL_NOPAD = /^[A-Za-z0-9_-]+$/;
const CONTROL = /[\u0000-\u001f\u007f]/u;
const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(\.\d{1,9})?([Zz]|[+-](\d{2}):(\d{2}))$/;
const FORBIDDEN_JSON_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/** The known parameters. Everything else is ignored, unread. */
export const MPP_CHALLENGE_KNOWN_PARAMS: readonly string[] = ['id', 'realm', 'method', 'intent', 'request', 'expires', 'digest', 'description', 'opaque', 'header'];

/** The exact accepted protocol strings of one challenge — what P14 must echo, unchanged. */
export interface MppChallengeFields {
  readonly id: string;
  readonly realm: string;
  readonly method: string;
  readonly intent: string;
  /** The exact base64url text the server sent. Never re-encoded. */
  readonly request: string;
  readonly expires?: string;
  readonly digest?: string;
  readonly opaque?: string;
  readonly header?: typeof MPP_PAYMENT_AUTHORIZATION_HEADER;
  /** Display-only, untrusted, bounded. Never an input to authority, equivalence, amount, counterparty or security. */
  readonly description?: string;
}

/** A decoded JSON value: data only, deep-frozen. */
export type MppJsonValue = null | boolean | number | string | readonly MppJsonValue[] | { readonly [key: string]: MppJsonValue };

/** A validated challenge: the exact fields, plus decoded views for validation and trusted normalization only. Frozen. */
export interface ParsedMppPaymentChallenge extends MppChallengeFields {
  readonly decodedRequest: { readonly [key: string]: MppJsonValue };
  readonly decodedOpaque?: Readonly<Record<string, string>>;
}

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
        text += value[pos + 1];
        pos += 2;
        continue;
      }
      if (!(c === 0x09 || c === 0x20 || c === 0x21 || (c >= 0x23 && c <= 0x5b) || (c >= 0x5d && c <= 0x7e) || (c >= 0x80 && c <= 0xff))) throw new HeaderSyntaxError('invalid qdtext');
      text += value[pos];
      pos += 1;
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
          params.push([name, paramValue]);
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

/**
 * Every challenge of every scheme in the given `WWW-Authenticate` field
 * values. Each value is tokenized on its own; a value that is not a string,
 * too long, carries a control or non-Latin-1 character, or breaks the grammar
 * refuses the whole set.
 */
export function parseWwwAuthenticate(values: unknown): AuthenticateParse {
  const list: unknown[] = typeof values === 'string' ? [values] : Array.isArray(values) ? [...(values as unknown[])] : [];
  if (list.length === 0 || list.length > MPP_CHALLENGE_LIMITS.maxHeaderValues) return { valid: false, violation: 'expected one to sixteen WWW-Authenticate field values' };
  let total = 0;
  const challenges: RawAuthChallenge[] = [];
  for (const value of list) {
    if (typeof value !== 'string') return { valid: false, violation: 'a field value is not a string' };
    total += value.length;
    if (value.length > MPP_CHALLENGE_LIMITS.maxHeaderLength || total > MPP_CHALLENGE_LIMITS.maxHeaderLength) return { valid: false, violation: 'the field values exceed the size bound' };
    // CR, LF, NUL and every other control character except HTAB; nothing above Latin-1.
    if (/[\u0000-\u0008\u000a-\u001f\u007f]|[^\u0000-ÿ]/u.test(value)) return { valid: false, violation: 'a field value carries a control or non-Latin-1 character' };
    try {
      tokenizeFieldValue(value, challenges);
    } catch (error) {
      if (error instanceof HeaderSyntaxError) return { valid: false, violation: `malformed challenge list: ${error.message}` };
      throw error;
    }
  }
  return { valid: true, challenges: Object.freeze(challenges) };
}

// ─── base64url and canonical JSON ────────────────────────────────────────────

/** Strict base64url without padding: the alphabet, no `=`, no impossible length, no non-zero trailing bits (the text must round-trip exactly). */
export function decodeBase64UrlNoPad(text: string, maxBytes: number): Uint8Array | undefined {
  if (text.length === 0 || !BASE64URL_NOPAD.test(text) || text.length % 4 === 1) return undefined;
  // floor(length × 3 / 4) decoded bytes exceed the bound exactly when length × 3 ≥ 4 × (bound + 1). Integer arithmetic; no allocation first.
  if (text.length * 3 >= 4 * (maxBytes + 1)) return undefined;
  const bytes = Buffer.from(text, 'base64url');
  if (bytes.toString('base64url') !== text) return undefined;
  return new Uint8Array(bytes);
}

function decodeUtf8(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

/** Bounded depth and member count; no prototype-shaped member names. Walks what `JSON.parse` produced — plain data only. */
function jsonShapeViolation(value: unknown): string | undefined {
  let members = 0;
  const walk = (node: unknown, depth: number): string | undefined => {
    if (depth > MPP_CHALLENGE_LIMITS.maxJsonDepth) return 'nested too deeply';
    if (Array.isArray(node)) {
      for (const item of node) {
        members += 1;
        if (members > MPP_CHALLENGE_LIMITS.maxJsonMembers) return 'too many members';
        const violation = walk(item, depth + 1);
        if (violation !== undefined) return violation;
      }
      return undefined;
    }
    if (node !== null && typeof node === 'object') {
      for (const key of Object.keys(node)) {
        if (FORBIDDEN_JSON_KEYS.has(key)) return `forbidden member name '${key}'`;
        members += 1;
        if (members > MPP_CHALLENGE_LIMITS.maxJsonMembers) return 'too many members';
        const violation = walk((node as Record<string, unknown>)[key], depth + 1);
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
 * base64url (no padding) → UTF-8 → a JSON **object** that is bounded, free of
 * prototype-shaped names and **JCS-canonical**: the decoded text must equal
 * `aoc.canonical-json.v1` of the parsed value, which for JSON-parsed data is
 * RFC 8785 (members sorted by UTF-16 code unit, ECMAScript string and number
 * serialization, no whitespace). A duplicate member, a non-shortest number,
 * whitespace or any other alternative spelling fails the round trip.
 */
export function decodeCanonicalJsonObject(text: string, maxBytes: number): CanonicalJsonDecode {
  const bytes = decodeBase64UrlNoPad(text, maxBytes);
  if (bytes === undefined) return { valid: false, violation: 'not canonical base64url without padding, or too large' };
  if (bytes.length > maxBytes) return { valid: false, violation: 'decoded value too large' };
  const decoded = decodeUtf8(bytes);
  if (decoded === undefined) return { valid: false, violation: 'not valid UTF-8' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    return { valid: false, violation: 'not valid JSON' };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { valid: false, violation: 'not a JSON object' };
  const shape = jsonShapeViolation(parsed);
  if (shape !== undefined) return { valid: false, violation: shape };
  let canonical: string;
  try {
    canonical = canonicalSerialize(parsed);
  } catch {
    return { valid: false, violation: 'not canonically serializable' };
  }
  if (canonical !== decoded) return { valid: false, violation: 'not JCS-canonical (RFC 8785)' };
  return { valid: true, value: deepFreezeJson(parsed as { readonly [key: string]: MppJsonValue }) };
}

// ─── RFC 9530 Content-Digest ─────────────────────────────────────────────────

/** Algorithms this client can compare, and their digest lengths in bytes. Others are ignored, as RFC 9530 asks. */
const DIGEST_ALGORITHMS: ReadonlyMap<string, number> = new Map([
  ['sha-256', 32],
  ['sha-512', 64],
]);
const DIGEST_KEY = /^[a-z*][a-z0-9_.*-]*$/;
const STANDARD_BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * An RFC 9530 `Content-Digest`-style value — an RFC 8941 dictionary of
 * byte-sequence members, `sha-256=:<base64>:` — parsed strictly: every member
 * a byte sequence in canonical padded base64, no member parameters, no
 * duplicated key. Returns the recognized algorithms only, or `undefined` when
 * the value is malformed or recognizes none.
 */
export function parseContentDigest(value: unknown): ReadonlyMap<string, string> | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > MPP_CHALLENGE_LIMITS.maxDigestLength) return undefined;
  const seen = new Set<string>();
  const recognized = new Map<string, string>();
  for (const rawMember of value.split(',')) {
    // Byte sequences cannot contain ',', so splitting the dictionary here is exact.
    const member = rawMember.replace(/^[ \t]+|[ \t]+$/g, '');
    const eq = member.indexOf('=');
    if (eq <= 0) return undefined;
    const key = member.slice(0, eq);
    const item = member.slice(eq + 1);
    if (!DIGEST_KEY.test(key) || seen.has(key)) return undefined;
    seen.add(key);
    if (item.length < 2 || !item.startsWith(':') || !item.endsWith(':')) return undefined;
    const encoded = item.slice(1, -1);
    if (!STANDARD_BASE64.test(encoded) || encoded.length % 4 !== 0) return undefined;
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.toString('base64') !== encoded) return undefined;
    const expected = DIGEST_ALGORITHMS.get(key);
    if (expected !== undefined) {
      if (bytes.length !== expected) return undefined;
      recognized.set(key, encoded);
    }
  }
  return recognized.size === 0 ? undefined : recognized;
}

/** The canonical spelling of a parsed digest: recognized algorithms only, sorted. What the business digest commits to. */
export function canonicalContentDigest(parsed: ReadonlyMap<string, string>): string {
  return [...parsed.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, encoded]) => `${key}=:${encoded}:`)
    .join(', ');
}

/**
 * Whether a challenge's `digest` binds the actual protected request body:
 * they share at least one recognized algorithm, and every shared algorithm
 * agrees.
 */
export function contentDigestsMatch(challengeDigest: ReadonlyMap<string, string>, requestDigest: ReadonlyMap<string, string>): boolean {
  let shared = 0;
  for (const [algorithm, encoded] of challengeDigest) {
    const other = requestDigest.get(algorithm);
    if (other === undefined) continue;
    if (other !== encoded) return false;
    shared += 1;
  }
  return shared > 0;
}

/** RFC 9530 `sha-256` Content-Digest of exact body bytes — for the trusted network layer that holds the body. */
export function computeContentDigest(body: Uint8Array | string): string {
  const bytes = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
  return `sha-256=:${createHash('sha256').update(bytes).digest('base64')}:`;
}

// ─── RFC 3339 expiry ─────────────────────────────────────────────────────────

/** The value of a run of ASCII digits, computed digit by digit. Calendar components only — never money. */
function digitsValue(text: string | undefined): number {
  let total = 0;
  for (const character of text ?? '') total = total * 10 + (character.charCodeAt(0) - 0x30);
  return total;
}

/** Milliseconds since the epoch of a strict RFC 3339 date-time, or `undefined`. No leap second, no out-of-range component, no lenient `Date.parse` spelling. */
export function rfc3339EpochMilliseconds(value: unknown): number | undefined {
  if (typeof value !== 'string' || value.length > MPP_CHALLENGE_LIMITS.maxExpiresLength) return undefined;
  const match = RFC3339.exec(value);
  if (match === null) return undefined;
  const [, year, month, day, hour, minute, second, fraction, zone, zoneHour, zoneMinute] = match;
  const y = digitsValue(year);
  const mo = digitsValue(month);
  const d = digitsValue(day);
  const h = digitsValue(hour);
  const mi = digitsValue(minute);
  const s = digitsValue(second);
  if (mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59 || s > 59) return undefined;
  const daysInMonth = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  if (d > daysInMonth) return undefined;
  let offsetMinutes = 0;
  if (zone !== undefined && zone.toUpperCase() !== 'Z') {
    const oh = digitsValue(zoneHour);
    const om = digitsValue(zoneMinute);
    if (oh > 23 || om > 59) return undefined;
    offsetMinutes = (zone.startsWith('-') ? -1 : 1) * (oh * 60 + om);
  }
  const milliseconds = fraction === undefined ? 0 : digitsValue(fraction.slice(1, 4).padEnd(3, '0'));
  const epoch = Date.UTC(y, mo - 1, d, h, mi, s, milliseconds) - offsetMinutes * 60_000;
  return Number.isFinite(epoch) ? epoch : undefined;
}

/**
 * Whether a challenge can still be used at `instant` (a canonical instant from
 * an injected clock). A challenge without `expires` states no expiry; one whose
 * `expires` is at or before the instant is not usable.
 */
export function isMppChallengeUsableAt(challenge: { readonly expires?: string }, instant: string): boolean {
  if (challenge.expires === undefined) return true;
  const expires = rfc3339EpochMilliseconds(challenge.expires);
  const at = Date.parse(instant);
  return expires !== undefined && Number.isFinite(at) && expires > at;
}

// ─── the Payment challenge ───────────────────────────────────────────────────

function boundedText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !CONTROL.test(value);
}

/**
 * Why a set of exact challenge fields is outside the protocol contract, or
 * `undefined` with its decoded views. Run on ingestion and again on every read
 * of a persisted challenge, so a stored challenge is held to the same rules as
 * a live one.
 */
export function validateMppChallengeFields(fields: {
  readonly id: unknown;
  readonly realm: unknown;
  readonly method: unknown;
  readonly intent: unknown;
  readonly request: unknown;
  readonly expires?: unknown;
  readonly digest?: unknown;
  readonly opaque?: unknown;
  readonly header?: unknown;
  readonly description?: unknown;
}): { readonly valid: true; readonly decodedRequest: { readonly [key: string]: MppJsonValue }; readonly decodedOpaque?: Readonly<Record<string, string>> } | { readonly valid: false; readonly violation: string } {
  const invalid = (violation: string) => ({ valid: false as const, violation });
  if (!boundedText(fields.id, MPP_CHALLENGE_LIMITS.maxIdLength)) return invalid('id is missing, empty, too long or carries a control character');
  if (!boundedText(fields.realm, MPP_CHALLENGE_LIMITS.maxRealmLength)) return invalid('realm is missing, empty, too long or carries a control character');
  if (typeof fields.method !== 'string' || fields.method.length > MPP_CHALLENGE_LIMITS.maxMethodLength || !METHOD.test(fields.method)) return invalid('method is not a lowercase payment-method-id');
  if (typeof fields.intent !== 'string' || fields.intent.length > MPP_CHALLENGE_LIMITS.maxIntentLength || !INTENT.test(fields.intent)) return invalid('intent is not an intent token');
  if (typeof fields.request !== 'string' || fields.request.length > MPP_CHALLENGE_LIMITS.maxParamValueLength) return invalid('request is missing or too long');
  const request = decodeCanonicalJsonObject(fields.request, MPP_CHALLENGE_LIMITS.maxRequestBytes);
  if (!request.valid) return invalid(`request: ${request.violation}`);
  if (fields.expires !== undefined && rfc3339EpochMilliseconds(fields.expires) === undefined) return invalid('expires is not an RFC 3339 date-time');
  if (fields.digest !== undefined && parseContentDigest(fields.digest) === undefined) return invalid('digest is not an RFC 9530 digest with a recognized algorithm');
  if (fields.header !== undefined && fields.header !== MPP_PAYMENT_AUTHORIZATION_HEADER) return invalid('header names a field other than Payment-Authorization');
  if (fields.description !== undefined && (typeof fields.description !== 'string' || fields.description.length > MPP_CHALLENGE_LIMITS.maxDescriptionLength || CONTROL.test(fields.description))) {
    return invalid('description is too long or carries a control character');
  }
  let decodedOpaque: Readonly<Record<string, string>> | undefined;
  if (fields.opaque !== undefined) {
    if (typeof fields.opaque !== 'string') return invalid('opaque is not text');
    const opaque = decodeCanonicalJsonObject(fields.opaque, MPP_CHALLENGE_LIMITS.maxOpaqueBytes);
    if (!opaque.valid) return invalid(`opaque: ${opaque.violation}`);
    const entries = Object.entries(opaque.value);
    if (entries.length > MPP_CHALLENGE_LIMITS.maxOpaqueEntries || entries.some(([, value]) => typeof value !== 'string')) return invalid('opaque is not a flat string-to-string map');
    decodedOpaque = opaque.value as Readonly<Record<string, string>>;
  }
  return { valid: true, decodedRequest: request.value, ...(decodedOpaque !== undefined ? { decodedOpaque } : {}) };
}

export type PaymentChallengeParse = { readonly valid: true; readonly challenge: ParsedMppPaymentChallenge } | { readonly valid: false; readonly violation: string };

/** One raw `Payment` challenge → a validated, frozen one. Known parameters exactly once; unknown ones dropped unread. */
export function parsePaymentChallenge(raw: RawAuthChallenge): PaymentChallengeParse {
  if (raw.scheme.toLowerCase() !== 'payment') return { valid: false, violation: 'not a Payment challenge' };
  if (raw.token68 !== undefined) return { valid: false, violation: 'a Payment challenge carries auth-params, not token68' };
  const known = new Map<string, string>();
  for (const [name, value] of raw.params) {
    if (!MPP_CHALLENGE_KNOWN_PARAMS.includes(name)) continue;
    if (known.has(name)) return { valid: false, violation: `duplicate parameter '${name}'` };
    known.set(name, value);
  }
  const fields = {
    id: known.get('id'),
    realm: known.get('realm'),
    method: known.get('method'),
    intent: known.get('intent'),
    request: known.get('request'),
    expires: known.get('expires'),
    digest: known.get('digest'),
    opaque: known.get('opaque'),
    header: known.get('header'),
    description: known.get('description'),
  };
  for (const required of ['id', 'realm', 'method', 'intent', 'request'] as const) {
    if (fields[required] === undefined) return { valid: false, violation: `missing required parameter '${required}'` };
  }
  const validation = validateMppChallengeFields(fields);
  if (!validation.valid) return validation;
  const challenge: ParsedMppPaymentChallenge = {
    id: fields.id as string,
    realm: fields.realm as string,
    method: fields.method as string,
    intent: fields.intent as string,
    request: fields.request as string,
    ...(fields.expires !== undefined ? { expires: fields.expires } : {}),
    ...(fields.digest !== undefined ? { digest: fields.digest } : {}),
    ...(fields.opaque !== undefined ? { opaque: fields.opaque } : {}),
    ...(fields.header !== undefined ? { header: MPP_PAYMENT_AUTHORIZATION_HEADER } : {}),
    ...(fields.description !== undefined ? { description: fields.description } : {}),
    decodedRequest: validation.decodedRequest,
    ...(validation.decodedOpaque !== undefined ? { decodedOpaque: validation.decodedOpaque } : {}),
  };
  return { valid: true, challenge: Object.freeze(challenge) };
}

/** The exact fields only — no decoded view — as a fresh frozen object. What is persisted and handed to P14. */
export function mppChallengeFieldsOf(challenge: MppChallengeFields): MppChallengeFields {
  return Object.freeze({
    id: challenge.id,
    realm: challenge.realm,
    method: challenge.method,
    intent: challenge.intent,
    request: challenge.request,
    ...(challenge.expires !== undefined ? { expires: challenge.expires } : {}),
    ...(challenge.digest !== undefined ? { digest: challenge.digest } : {}),
    ...(challenge.opaque !== undefined ? { opaque: challenge.opaque } : {}),
    ...(challenge.header !== undefined ? { header: challenge.header } : {}),
    ...(challenge.description !== undefined ? { description: challenge.description } : {}),
  });
}

/** Where a future credential for this challenge must go: the draft's default `Authorization`, or `Payment-Authorization` when the challenge selected it. The **merchant's** field on the **external** request — never Frontera's customer `Authorization`. */
export function mppCredentialHeaderField(challenge: { readonly header?: string }): 'Authorization' | typeof MPP_PAYMENT_AUTHORIZATION_HEADER {
  return challenge.header === MPP_PAYMENT_AUTHORIZATION_HEADER ? MPP_PAYMENT_AUTHORIZATION_HEADER : 'Authorization';
}
