import { isIP } from 'node:net';
import { isRecordableExecutionAdapterId } from '../../../features/execution-runtime/index.js';
import {
  GENERIC_HTTP_LIMITS as LIMITS,
  GenericHttpConfigurationError,
  type EnterpriseGenericHttpActionSource,
  type EnterpriseGenericHttpConfigurationErrorCode,
  type EnterpriseGenericHttpMethod,
} from './contracts.js';
import { isLocalOnlyHostname } from './public-address-policy.js';

/**
 * Construct → validate → snapshot → freeze.
 *
 * The same trust discipline the execution adapter registry applies to its
 * children, applied to host configuration: every option is read **once**, here,
 * into a fresh frozen plan the adapter owns. Nothing the host passed in is held
 * afterwards, so mutating the original `origin`, `path` array, `headers` object,
 * `body.fields`, `credential` or `timeoutMs` after composition changes nothing,
 * and no getter on the host's object is ever run during traffic.
 *
 * A getter or Proxy trap that throws while being read is a composition failure
 * (`GENERIC_HTTP_OPTIONS_INVALID`), never traffic-time behaviour. So is any key
 * the contract does not declare, at any level: the contract is closed, and an
 * option such as `followRedirects`, `proxy`, `agent`, `lookup` or
 * `allowPrivateNetwork` is refused rather than ignored.
 *
 * Error messages name the defect and never echo a configured value.
 */

/** A snapshotted value binding. Literals are pre-validated for every position they are used in. */
export type GenericHttpPlanBinding =
  | { readonly kind: 'source'; readonly source: EnterpriseGenericHttpActionSource; readonly required: boolean }
  | { readonly kind: 'literal'; readonly value: string | number | boolean | null };

export type GenericHttpPlanSegment = { readonly kind: 'literal'; readonly value: string } | { readonly kind: 'source'; readonly source: EnterpriseGenericHttpActionSource };

/** The adapter's own frozen description of its one integration. Internal; never exported from the Enterprise barrel. */
export interface GenericHttpPlan {
  readonly adapterId: string;
  /** Lower-case DNS hostname, normalized once. The Host header and the TLS server name are both this. */
  readonly hostname: string;
  readonly port: number;
  readonly method: EnterpriseGenericHttpMethod;
  readonly path: readonly GenericHttpPlanSegment[];
  readonly query: readonly (readonly [string, GenericHttpPlanBinding])[];
  /** Lower-case names. */
  readonly headers: readonly (readonly [string, GenericHttpPlanBinding])[];
  readonly body?: readonly (readonly [string, GenericHttpPlanBinding])[];
  /** Lower-case header name and exact value. Held only by the adapter's closure. */
  readonly credential?: { readonly name: string; readonly value: string };
  /**
   * Every literal secret the configured credential puts on the wire — for a
   * bearer credential both the raw token and the full `Bearer <token>` value;
   * for a header credential the exact configured value. Empty without a
   * credential. Internal only: a provider-controlled value containing any of
   * these is never copied outward (see `providerRefFrom`).
   */
  readonly credentialSecrets: readonly string[];
  /** Lower-case response header name. */
  readonly providerRefHeader?: string;
  readonly timeoutMs: number;
}

/** The closed set of mapping sources. Set membership, so `constructor`, `__proto__` and `boundedGrantId` are simply not members. */
export const GENERIC_HTTP_ACTION_SOURCES: readonly EnterpriseGenericHttpActionSource[] = Object.freeze([
  'subject',
  'action',
  'resource',
  'counterparty',
  'organization',
  'amount.value',
  'amount.unit',
  'notAfter',
  'correlation.requestId',
  'correlation.decisionId',
  'correlation.executionId',
]);

const SOURCE_SET: ReadonlySet<string> = new Set(GENERIC_HTTP_ACTION_SOURCES);

const METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** RFC 9110 `token`. */
const HTTP_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/** Visible ASCII, space and tab. Excludes CR, LF, NUL and every other control character, and non-ASCII. */
const HEADER_VALUE = /^[\t\x20-\x7e]*$/;

/**
 * A header credential value: a canonical opaque token of visible ASCII with no
 * SP or HTAB anywhere. HTTP strips leading and trailing whitespace (OWS) from a
 * field value, so a configured value with surrounding whitespace would reach
 * the provider as a *different* string from the one the providerRef reflection
 * filter protects. One spelling from configuration to the wire: refused, never
 * trimmed.
 */
const CREDENTIAL_VALUE = /^[\x21-\x7e]+$/;

/** Bearer `token68`. */
const TOKEN68 = /^[A-Za-z0-9\-._~+/]+=*$/;

/**
 * Header names this adapter owns or refuses outright. `host`, framing and
 * connection-management headers belong to the transport; `authorization` is
 * reachable only through the dedicated bearer credential; `cookie` is not
 * supported in Stage A; `content-type` is set by the adapter when a body exists.
 */
const RESERVED_HEADER_NAMES: ReadonlySet<string> = new Set([
  'host',
  'content-length',
  'content-type',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'proxy-connection',
  'proxy-authorization',
  'proxy-authenticate',
  'te',
  'trailer',
  'upgrade',
  'expect',
  'authorization',
  'cookie',
  'set-cookie',
  'http2-settings',
]);

/** Object keys never allowed as a destination name, even from trusted configuration. */
const UNSAFE_KEYS: ReadonlySet<string> = new Set(['__proto__', 'prototype', 'constructor']);

const TOP_LEVEL_KEYS: ReadonlySet<string> = new Set(['adapterId', 'origin', 'method', 'path', 'query', 'headers', 'body', 'credential', 'providerRefHeader', 'timeoutMs']);

/** Control characters, including DEL. */
const CONTROL = /[\u0000-\u001f\u007f]/;

function fail(code: EnterpriseGenericHttpConfigurationErrorCode, message: string): never {
  throw new GenericHttpConfigurationError(code, message);
}

/** A plain data object — `Object.prototype` or `null` prototype, not an array, not a class instance. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Reads every declared key exactly once, refusing undeclared ones. */
function readClosed(value: unknown, allowed: ReadonlySet<string>, code: EnterpriseGenericHttpConfigurationErrorCode, what: string): Record<string, unknown> {
  if (!isPlainObject(value)) fail(code, `${what} must be a plain object.`);
  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(code, `${what} declares an unsupported property '${key.slice(0, 64)}'; the Generic HTTP contract is closed.`);
    out[key] = value[key];
  }
  return out;
}

/** A deterministic decimal spelling, or `undefined` for a number that has none (non-finite, or one JavaScript would write with an exponent). */
export function decimalString(value: number): string | undefined {
  if (!Number.isFinite(value)) return undefined;
  const text = String(value);
  return /e/i.test(text) ? undefined : text;
}

function snapshotAdapterId(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0 || !isRecordableExecutionAdapterId(value)) {
    fail('GENERIC_HTTP_ADAPTER_ID_INVALID', 'A Generic HTTP adapter needs a recordable adapterId: 1–64 characters of [A-Za-z0-9._:/-], starting alphanumeric.');
  }
  return value;
}

/**
 * The exact trusted origin. Checked on the **raw string** first, so userinfo,
 * a path, a query, a fragment, an IPv6 literal, a backslash or whitespace is
 * refused before any URL parser has a chance to normalize it into something
 * acceptable; then parsed once for normalization (lower-case, IDNA).
 */
function snapshotOrigin(value: unknown): { readonly hostname: string; readonly port: number } {
  const invalid = (reason: string): never => fail('GENERIC_HTTP_ORIGIN_INVALID', `The Generic HTTP origin is not an exact https origin: ${reason}.`);
  if (typeof value !== 'string' || value.length === 0 || value.length > 300) return invalid('it must be a non-empty string');
  if (!/^https:\/\//i.test(value)) return invalid('only the https scheme is allowed');
  if (!/^https:\/\/[A-Za-z0-9.-]+(:[0-9]{1,5})?\/?$/i.test(value)) return invalid('only scheme, DNS hostname and optional port are allowed — no userinfo, path, query, fragment or IP literal');
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return invalid('it does not parse');
  }
  if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '' || parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '') {
    return invalid('only scheme, hostname and optional port are allowed');
  }
  const hostname = parsed.hostname.toLowerCase();
  if (hostname.length === 0 || hostname.length > 253) return invalid('the hostname length is out of range');
  if (hostname.endsWith('.')) return invalid('a trailing-dot hostname is refused, so it cannot alias a local name');
  if (isIP(hostname) !== 0 || hostname.startsWith('[')) return invalid('an IP literal is refused; configure a DNS hostname');
  const labels = hostname.split('.');
  if (labels.length < 2) return invalid('a single-label hostname is refused; configure a fully qualified DNS name');
  for (const label of labels) {
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) return invalid('a hostname label is malformed');
  }
  if (/^[0-9]+$/.test(labels[labels.length - 1] ?? '')) return invalid('a numeric top-level label is refused');
  if (isLocalOnlyHostname(hostname)) return invalid('a loopback or local-only hostname is refused');
  const port = parsed.port === '' ? 443 : Number(parsed.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return invalid('the port is out of range');
  return { hostname, port };
}

function snapshotMethod(value: unknown): EnterpriseGenericHttpMethod {
  if (typeof value !== 'string' || !METHODS.has(value)) fail('GENERIC_HTTP_METHOD_INVALID', 'The Generic HTTP method must be exactly one of POST, PUT, PATCH or DELETE.');
  return value as EnterpriseGenericHttpMethod;
}

function snapshotSource(value: unknown, code: EnterpriseGenericHttpConfigurationErrorCode): EnterpriseGenericHttpActionSource {
  if (typeof value !== 'string' || !SOURCE_SET.has(value)) {
    fail(code, 'A Generic HTTP mapping source must name one approved ValidatedExecutionAction field; boundedGrantId, assertedContext and provider payloads are not sources.');
  }
  return value as EnterpriseGenericHttpActionSource;
}

/** Literal checks shared by path, query and header positions: a string, a finite number or a boolean. `null` has no text form and is refused. */
function textLiteral(value: unknown, code: EnterpriseGenericHttpConfigurationErrorCode): string {
  if (typeof value === 'string') {
    if (value.length > LIMITS.maxLiteralLength || CONTROL.test(value)) fail(code, 'A Generic HTTP literal is too long or contains a control character.');
    return value;
  }
  if (typeof value === 'number') {
    const text = decimalString(value);
    if (text === undefined) fail(code, 'A Generic HTTP numeric literal must be finite and have a plain decimal spelling.');
    return text;
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return fail(code, 'A null literal has no text form and is refused in a path, query or header position.');
}

type Position = 'query' | 'header' | 'body';

function snapshotBinding(value: unknown, position: Position): GenericHttpPlanBinding {
  const code: EnterpriseGenericHttpConfigurationErrorCode = position === 'header' ? 'GENERIC_HTTP_HEADER_INVALID' : 'GENERIC_HTTP_MAPPING_INVALID';
  if (!isPlainObject(value)) fail(code, 'A Generic HTTP value binding must be a plain object.');
  const kind = value['kind'];
  if (kind === 'source') {
    const fields = readClosed(value, new Set(['kind', 'source', 'required']), code, 'A source binding');
    const source = snapshotSource(fields['source'], code);
    const required = fields['required'];
    if (required !== undefined && typeof required !== 'boolean') fail(code, 'A source binding’s required flag must be a boolean.');
    return Object.freeze({ kind: 'source', source, required: required !== false });
  }
  if (kind === 'literal') {
    const fields = readClosed(value, new Set(['kind', 'value']), code, 'A literal binding');
    const literal = fields['value'];
    if (position === 'body') {
      if (literal === null || typeof literal === 'boolean') return Object.freeze({ kind: 'literal', value: literal });
      if (typeof literal === 'number') {
        if (!Number.isFinite(literal)) fail(code, 'A JSON body numeric literal must be finite.');
        return Object.freeze({ kind: 'literal', value: literal });
      }
      if (typeof literal === 'string') {
        if (literal.length > LIMITS.maxLiteralLength) fail(code, 'A JSON body string literal is too long.');
        return Object.freeze({ kind: 'literal', value: literal });
      }
      return fail(code, 'A JSON body literal must be a string, finite number, boolean or null.');
    }
    const text = textLiteral(literal, code);
    if (position === 'header' && (!HEADER_VALUE.test(text) || text.length > LIMITS.maxHeaderValueLength)) {
      fail('GENERIC_HTTP_HEADER_INVALID', 'A Generic HTTP header literal contains a character that is not permitted in a header value, or is too long.');
    }
    return Object.freeze({ kind: 'literal', value: typeof literal === 'string' ? literal : text });
  }
  return fail(code, "A Generic HTTP value binding's kind must be 'source' or 'literal'.");
}

/** A destination object key. Never `__proto__`, `prototype` or `constructor`; never a control character; bounded. */
function destinationKey(key: string, code: EnterpriseGenericHttpConfigurationErrorCode, what: string): string {
  if (key.length === 0 || key.length > LIMITS.maxNameLength || CONTROL.test(key) || UNSAFE_KEYS.has(key)) {
    fail(code, `${what} name is empty, too long, contains a control character, or is an unsafe object key.`);
  }
  return key;
}

function snapshotPath(value: unknown): readonly GenericHttpPlanSegment[] {
  if (!Array.isArray(value)) fail('GENERIC_HTTP_PATH_INVALID', 'The Generic HTTP path must be an array of segments.');
  const length = value.length;
  if (length > LIMITS.maxPathSegments) fail('GENERIC_HTTP_LIMIT_INVALID', `The Generic HTTP path may have at most ${LIMITS.maxPathSegments} segments.`);
  const segments: GenericHttpPlanSegment[] = [];
  for (let index = 0; index < length; index += 1) {
    const segment: unknown = value[index];
    if (!isPlainObject(segment)) fail('GENERIC_HTTP_PATH_INVALID', 'A Generic HTTP path segment must be a plain object.');
    const kind = segment['kind'];
    if (kind === 'literal') {
      const fields = readClosed(segment, new Set(['kind', 'value']), 'GENERIC_HTTP_PATH_INVALID', 'A literal path segment');
      const literal = fields['value'];
      if (typeof literal !== 'string' || literal.length === 0 || literal.length > LIMITS.maxNameLength * 2) fail('GENERIC_HTTP_PATH_INVALID', 'A literal path segment must be a non-empty, bounded string.');
      if (literal === '.' || literal === '..') fail('GENERIC_HTTP_PATH_INVALID', 'A literal path segment may not be "." or "..".');
      if (CONTROL.test(literal) || literal.includes('/') || literal.includes('\\')) {
        fail('GENERIC_HTTP_PATH_INVALID', 'A literal path segment is exactly one segment: no control character, "/" or "\\".');
      }
      segments.push(Object.freeze({ kind: 'literal', value: literal }));
    } else if (kind === 'source') {
      // No `required` key is accepted: a path segment is always required, so
      // an optional one cannot silently shift the path hierarchy.
      const fields = readClosed(segment, new Set(['kind', 'source']), 'GENERIC_HTTP_PATH_INVALID', 'A source path segment');
      segments.push(Object.freeze({ kind: 'source', source: snapshotSource(fields['source'], 'GENERIC_HTTP_PATH_INVALID') }));
    } else {
      fail('GENERIC_HTTP_PATH_INVALID', "A Generic HTTP path segment's kind must be 'literal' or 'source'.");
    }
  }
  return Object.freeze(segments);
}

function snapshotRecord(
  value: unknown,
  position: Position,
  max: number,
  what: string,
): readonly (readonly [string, GenericHttpPlanBinding])[] {
  const code: EnterpriseGenericHttpConfigurationErrorCode = position === 'header' ? 'GENERIC_HTTP_HEADER_INVALID' : 'GENERIC_HTTP_MAPPING_INVALID';
  if (!isPlainObject(value)) fail(code, `${what} must be a plain object.`);
  const keys = Object.keys(value);
  if (keys.length > max) fail('GENERIC_HTTP_LIMIT_INVALID', `${what} may declare at most ${max} fields.`);
  const entries: (readonly [string, GenericHttpPlanBinding])[] = [];
  const seen = new Set<string>();
  for (const rawKey of keys) {
    let key = destinationKey(rawKey, code, what);
    if (position === 'header') {
      if (!HTTP_TOKEN.test(key)) fail('GENERIC_HTTP_HEADER_INVALID', 'A Generic HTTP header name is not a valid HTTP token.');
      key = key.toLowerCase();
      if (RESERVED_HEADER_NAMES.has(key) || key.startsWith('proxy-')) {
        fail('GENERIC_HTTP_HEADER_INVALID', `The header '${key}' is owned by the adapter or refused in Stage A; Authorization is set only through the credential contract.`);
      }
    }
    if (seen.has(key)) fail(code, `${what} declares '${key}' twice after canonicalization.`);
    seen.add(key);
    entries.push(Object.freeze([key, snapshotBinding(value[rawKey], position)] as const));
  }
  return Object.freeze(entries);
}

function snapshotBody(value: unknown): readonly (readonly [string, GenericHttpPlanBinding])[] {
  const fields = readClosed(value, new Set(['kind', 'fields']), 'GENERIC_HTTP_MAPPING_INVALID', 'The Generic HTTP body');
  if (fields['kind'] !== 'json-object') fail('GENERIC_HTTP_MAPPING_INVALID', "The Generic HTTP body's kind must be 'json-object'.");
  return snapshotRecord(fields['fields'], 'body', LIMITS.maxBodyFields, 'The Generic HTTP body');
}

interface CredentialSnapshot {
  readonly name: string;
  readonly value: string;
  readonly secrets: readonly string[];
}

function snapshotCredential(value: unknown): CredentialSnapshot {
  if (!isPlainObject(value)) fail('GENERIC_HTTP_CREDENTIAL_INVALID', 'The Generic HTTP credential must be a plain object.');
  const kind = value['kind'];
  if (kind === 'bearer') {
    const fields = readClosed(value, new Set(['kind', 'token']), 'GENERIC_HTTP_CREDENTIAL_INVALID', 'A bearer credential');
    const token = fields['token'];
    if (typeof token !== 'string' || token.length === 0 || token.length > LIMITS.maxHeaderValueLength - 7 || !TOKEN68.test(token)) {
      fail('GENERIC_HTTP_CREDENTIAL_INVALID', 'A bearer credential token must be a non-empty, bounded token68 string.');
    }
    return Object.freeze({ name: 'authorization', value: `Bearer ${token}`, secrets: Object.freeze([token, `Bearer ${token}`]) });
  }
  if (kind === 'header') {
    const fields = readClosed(value, new Set(['kind', 'name', 'value']), 'GENERIC_HTTP_CREDENTIAL_INVALID', 'A header credential');
    const name = fields['name'];
    const secret = fields['value'];
    if (typeof name !== 'string' || name.length === 0 || name.length > LIMITS.maxNameLength || !HTTP_TOKEN.test(name) || UNSAFE_KEYS.has(name)) {
      fail('GENERIC_HTTP_CREDENTIAL_INVALID', 'A header credential name must be a valid HTTP token.');
    }
    const lower = name.toLowerCase();
    if (RESERVED_HEADER_NAMES.has(lower) || lower.startsWith('proxy-')) {
      fail('GENERIC_HTTP_CREDENTIAL_INVALID', `A header credential may not use '${lower}'; use the bearer credential for Authorization.`);
    }
    if (typeof secret !== 'string' || secret.length === 0 || secret.length > LIMITS.maxHeaderValueLength || !CREDENTIAL_VALUE.test(secret)) {
      fail('GENERIC_HTTP_CREDENTIAL_INVALID', 'A header credential value must be a non-empty, bounded, canonical opaque token of visible ASCII with no space, tab or control character.');
    }
    return Object.freeze({ name: lower, value: secret, secrets: Object.freeze([secret]) });
  }
  return fail('GENERIC_HTTP_CREDENTIAL_INVALID', "A Generic HTTP credential's kind must be 'bearer' or 'header'.");
}

/**
 * Response headers a provider reference may never be read from: URL-bearing
 * headers (a reference is evidence, never somewhere to go) and authentication-
 * or credential-bearing headers (a reference must never be able to carry one).
 */
const REFUSED_PROVIDER_REF_HEADERS: ReadonlySet<string> = new Set([
  'location',
  'content-location',
  'refresh',
  'authorization',
  'proxy-authorization',
  'proxy-authenticate',
  'www-authenticate',
  'cookie',
  'set-cookie',
]);

function snapshotProviderRefHeader(value: unknown, credentialHeader: string | undefined): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > LIMITS.maxNameLength || !HTTP_TOKEN.test(value)) {
    fail('GENERIC_HTTP_HEADER_INVALID', 'providerRefHeader must be a valid HTTP header name.');
  }
  const lower = value.toLowerCase();
  if (REFUSED_PROVIDER_REF_HEADERS.has(lower)) {
    fail('GENERIC_HTTP_HEADER_INVALID', `providerRefHeader may not be '${lower}': a provider reference is evidence, never a URL, a cookie or an authentication header.`);
  }
  if (credentialHeader !== undefined && lower === credentialHeader) {
    fail('GENERIC_HTTP_HEADER_INVALID', 'providerRefHeader may not name the configured credential header.');
  }
  return lower;
}

function snapshotTimeout(value: unknown): number {
  if (value === undefined) return LIMITS.defaultTimeoutMs;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < LIMITS.minTimeoutMs || value > LIMITS.maxTimeoutMs) {
    fail('GENERIC_HTTP_LIMIT_INVALID', `timeoutMs must be an integer from ${LIMITS.minTimeoutMs} to ${LIMITS.maxTimeoutMs}; there is no unlimited setting.`);
  }
  return value;
}

/**
 * Snapshot one adapter's options into a frozen plan, or throw a
 * `GenericHttpConfigurationError`. Any other throw while reading — a getter, a
 * Proxy trap — becomes `GENERIC_HTTP_OPTIONS_INVALID`.
 */
export function snapshotGenericHttpOptions(options: unknown): GenericHttpPlan {
  try {
    const fields = readClosed(options, TOP_LEVEL_KEYS, 'GENERIC_HTTP_OPTIONS_INVALID', 'The Generic HTTP adapter options');
    const adapterId = snapshotAdapterId(fields['adapterId']);
    const { hostname, port } = snapshotOrigin(fields['origin']);
    const method = snapshotMethod(fields['method']);
    const path = snapshotPath(fields['path']);
    const query = fields['query'] === undefined ? Object.freeze([]) : snapshotRecord(fields['query'], 'query', LIMITS.maxQueryFields, 'The Generic HTTP query');
    const headers = fields['headers'] === undefined ? Object.freeze([]) : snapshotRecord(fields['headers'], 'header', LIMITS.maxHeaders, 'The Generic HTTP headers');
    const body = fields['body'] === undefined ? undefined : snapshotBody(fields['body']);
    const credential = fields['credential'] === undefined ? undefined : snapshotCredential(fields['credential']);
    if (credential !== undefined && headers.some(([name]) => name === credential.name)) {
      fail('GENERIC_HTTP_CREDENTIAL_INVALID', `The credential header '${credential.name}' collides with a mapped header.`);
    }
    const providerRefHeader = fields['providerRefHeader'] === undefined ? undefined : snapshotProviderRefHeader(fields['providerRefHeader'], credential?.name);
    const timeoutMs = snapshotTimeout(fields['timeoutMs']);
    return Object.freeze({
      adapterId,
      hostname,
      port,
      method,
      path,
      query,
      headers,
      ...(body !== undefined ? { body } : {}),
      ...(credential !== undefined ? { credential: Object.freeze({ name: credential.name, value: credential.value }) } : {}),
      credentialSecrets: credential?.secrets ?? Object.freeze([]),
      ...(providerRefHeader !== undefined ? { providerRefHeader } : {}),
      timeoutMs,
    });
  } catch (error) {
    if (error instanceof GenericHttpConfigurationError) throw error;
    // Never the thrown value's message: it is host-controlled and could carry anything.
    throw new GenericHttpConfigurationError('GENERIC_HTTP_OPTIONS_INVALID', 'The Generic HTTP adapter options could not be read at composition.');
  }
}
