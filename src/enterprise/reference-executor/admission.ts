import { EXECUTION_CAPABILITY_PRESENTATION_HEADER } from '../execution-capability-presentation/index.js';
import type { ReferenceExecutorMethod } from './configuration.js';

/**
 * G-02C1A — HTTP admission: the structural checks on one request **exactly as
 * the executor's own HTTP/1.1 parser received it**, before credential,
 * presentation or binding.
 *
 * Input is what `node:http` hands the gateway: the version, the method, the raw
 * request target (never decoded), the raw header list (`rawHeaders`, every
 * line in order, names as sent) and the complete body bytes. Pure: no clock,
 * no I/O.
 *
 * Admission removes exactly four headers from what the binding will see, and
 * each one is checked, never ignored:
 *
 * | Header | Rule |
 * |---|---|
 * | `host` | exactly once, equal to the configured authority |
 * | `connection` | exactly once, exactly `close` (what the Host transport sends) |
 * | the presentation header | exactly once; decoded later |
 * | the client credential header | exactly once; compared later, in constant time |
 *
 * Every other header is kept, with its lower-cased name and its exact value,
 * for the binding — `content-length` included (its one narrow exception is in
 * `binding-reconstruction.ts`). A duplicated name, framing the Host transport
 * never produces, a hop-by-hop or proxy header, a content coding, or a body
 * that is not strict UTF-8 is refused here.
 */

export const REFERENCE_EXECUTOR_ADMISSION_LIMITS = Object.freeze({
  /** Header lines. The Host sends at most 32 mapped headers plus its own few. */
  maximumHeaders: 48,
  /** The Host's own URL bound. */
  maximumTargetLength: 8 * 1024,
  /** The Host's own body bound. */
  maximumBodyBytes: 64 * 1024,
});

export const REFERENCE_EXECUTOR_ADMISSION_REFUSALS = Object.freeze([
  'HTTP_VERSION_UNSUPPORTED',
  'METHOD_NOT_PERMITTED',
  'REQUEST_TARGET_INVALID',
  'HEADER_COUNT_EXCEEDED',
  'HEADER_NAME_INVALID',
  'HEADER_VALUE_INVALID',
  'HEADER_DUPLICATED',
  'FRAMING_UNSUPPORTED',
  'FRAMING_AMBIGUOUS',
  'UPGRADE_REFUSED',
  'EXPECTATION_REFUSED',
  'PROXY_REWRITE_REFUSED',
  'CONTENT_ENCODING_UNSUPPORTED',
  'HOST_MISSING',
  'HOST_MISMATCH',
  'CONNECTION_UNEXPECTED',
  'BODY_TOO_LARGE',
  'BODY_NOT_UTF8',
  'PRESENTATION_MISSING',
  'CLIENT_CREDENTIAL_MISSING',
  // Refused by the gateway at the socket, before a request reaches admission:
  'HTTP_MALFORMED',
  'HEADERS_TOO_LARGE',
  'REQUEST_PIPELINED',
  'PROCESSING_TIMEOUT',
] as const);
export type ReferenceExecutorAdmissionRefusal = (typeof REFERENCE_EXECUTOR_ADMISSION_REFUSALS)[number];

/** One request as the executor's HTTP parser received it. */
export interface ObservedHttpRequest {
  readonly httpVersion: string;
  readonly method: string;
  /** The raw request target, as sent. */
  readonly target: string;
  /** `IncomingMessage.rawHeaders`: name, value, name, value … */
  readonly rawHeaders: readonly string[];
  readonly body: Uint8Array;
}

export interface AdmissionPolicy {
  readonly authority: string;
  readonly methods: readonly ReferenceExecutorMethod[];
  readonly credentialHeader: string;
}

/** An admitted request. `headers` is every received header except the four admission removes, names lower-cased, values exact, in received order. */
export interface AdmittedHttpRequest {
  readonly method: ReferenceExecutorMethod;
  readonly target: string;
  readonly headers: readonly (readonly [string, string])[];
  readonly presentation: string;
  readonly credential: string;
  /** The exact body text, or `null` when the body is empty. */
  readonly body: string | null;
}

export type HttpAdmission = { readonly ok: true; readonly request: AdmittedHttpRequest } | { readonly ok: false; readonly refusal: ReferenceExecutorAdmissionRefusal };

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
/** The Host sends visible ASCII and tab only (its header-value rule). */
const HEADER_VALUE = /^[\t\x20-\x7e]*$/;
/** origin-form: a path starting with `/`, visible ASCII, no fragment. Never decoded, never normalized. */
const ORIGIN_FORM = /^\/[\x21-\x22\x24-\x7e]*$/;
const CONTENT_LENGTH = /^[0-9]{1,10}$/;
const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** Framing the Host transport never sends and this executor refuses to interpret. */
const FRAMING_HEADERS: readonly string[] = Object.freeze(['transfer-encoding', 'te', 'trailer']);
const UPGRADE_HEADERS: readonly string[] = Object.freeze(['upgrade', 'http2-settings']);
/** Headers a forwarding proxy adds or rewrites. Their presence means the request is not the one the Host sent. */
const PROXY_HEADERS: readonly string[] = Object.freeze(['forwarded', 'via', 'x-real-ip', 'keep-alive', 'proxy-connection', 'proxy-authorization', 'proxy-authenticate']);

export function admitHttpRequest(observed: ObservedHttpRequest, policy: AdmissionPolicy): HttpAdmission {
  const refuse = (refusal: ReferenceExecutorAdmissionRefusal): HttpAdmission => ({ ok: false, refusal });
  const L = REFERENCE_EXECUTOR_ADMISSION_LIMITS;

  if (observed.httpVersion !== '1.1') return refuse('HTTP_VERSION_UNSUPPORTED');
  const method = policy.methods.find((permitted) => permitted === observed.method);
  if (method === undefined) return refuse('METHOD_NOT_PERMITTED');
  const target = observed.target;
  if (typeof target !== 'string' || target.length > L.maximumTargetLength || !ORIGIN_FORM.test(target)) return refuse('REQUEST_TARGET_INVALID');

  const raw = observed.rawHeaders;
  if (raw.length % 2 !== 0) return refuse('HEADER_NAME_INVALID');
  if (raw.length / 2 > L.maximumHeaders) return refuse('HEADER_COUNT_EXCEEDED');

  const seen = new Set<string>();
  const kept: (readonly [string, string])[] = [];
  let host: string | undefined;
  let connection: string | undefined;
  let presentation: string | undefined;
  let credential: string | undefined;
  let contentLength: string | undefined;
  for (let index = 0; index < raw.length; index += 2) {
    const sentName = raw[index] ?? '';
    const value = raw[index + 1] ?? '';
    if (!HEADER_NAME.test(sentName)) return refuse('HEADER_NAME_INVALID');
    if (!HEADER_VALUE.test(value)) return refuse('HEADER_VALUE_INVALID');
    const name = sentName.toLowerCase();
    if (seen.has(name)) return refuse('HEADER_DUPLICATED');
    seen.add(name);
    if (FRAMING_HEADERS.includes(name)) return refuse('FRAMING_UNSUPPORTED');
    if (UPGRADE_HEADERS.includes(name)) return refuse('UPGRADE_REFUSED');
    if (name === 'expect') return refuse('EXPECTATION_REFUSED');
    if (PROXY_HEADERS.includes(name) || name.startsWith('x-forwarded-')) return refuse('PROXY_REWRITE_REFUSED');
    if (name === 'content-encoding') return refuse('CONTENT_ENCODING_UNSUPPORTED');
    if (name === 'host') host = value;
    else if (name === 'connection') connection = value;
    else if (name === EXECUTION_CAPABILITY_PRESENTATION_HEADER) presentation = value;
    else if (name === policy.credentialHeader) credential = value;
    else {
      if (name === 'content-length') contentLength = value;
      kept.push(Object.freeze([name, value] as const));
    }
  }

  if (host === undefined) return refuse('HOST_MISSING');
  if (host !== policy.authority) return refuse('HOST_MISMATCH');
  if (connection !== 'close') return refuse('CONNECTION_UNEXPECTED');

  // The parser already framed the body by Content-Length; this restates it, so no body reaches the binding unframed.
  const body = observed.body;
  if (body.length > L.maximumBodyBytes) return refuse('BODY_TOO_LARGE');
  if (contentLength !== undefined && (!CONTENT_LENGTH.test(contentLength) || Number(contentLength) !== body.length)) return refuse('FRAMING_AMBIGUOUS');
  if (contentLength === undefined && body.length > 0) return refuse('FRAMING_AMBIGUOUS');
  let text: string | null = null;
  if (body.length > 0) {
    try {
      text = STRICT_UTF8.decode(body);
    } catch {
      return refuse('BODY_NOT_UTF8');
    }
  }

  if (presentation === undefined) return refuse('PRESENTATION_MISSING');
  if (credential === undefined) return refuse('CLIENT_CREDENTIAL_MISSING');

  return { ok: true, request: Object.freeze({ method, target, headers: Object.freeze(kept), presentation, credential, body: text }) };
}
