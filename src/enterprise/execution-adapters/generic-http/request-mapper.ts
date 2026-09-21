import type { ValidatedExecutionAction } from '../../../features/execution-runtime/index.js';
import { GENERIC_HTTP_LIMITS as LIMITS, type EnterpriseGenericHttpActionSource, type EnterpriseGenericHttpMethod } from './contracts.js';
import { decimalString, type GenericHttpPlan, type GenericHttpPlanBinding } from './configuration.js';

/**
 * The pure translation: frozen plan + `ValidatedExecutionAction` → one complete
 * HTTP request, built **before** any socket exists. No I/O, no clock, no
 * environment, no second input.
 *
 * Every outbound value is either an operator literal from the plan or exactly
 * one field of the validated action. Nothing is interpolated, merged, parsed or
 * nested. A value that cannot be placed safely where the plan puts it — an
 * absent required source, a control character, a path segment of `.` or `..`,
 * a header value outside visible ASCII, anything over a bound — makes the whole
 * request unbuildable, and an unbuildable request is never sent.
 */

/** The request the transport will send, exactly. Headers are lower-case, unique, and already include the credential and framing headers. */
export interface GenericHttpWireRequest {
  readonly method: EnterpriseGenericHttpMethod;
  readonly hostname: string;
  readonly port: number;
  /** Encoded path and query — never a scheme, host or fragment. */
  readonly path: string;
  readonly headers: readonly (readonly [string, string])[];
  readonly body?: string;
}

export type GenericHttpMappingResult = { readonly ok: true; readonly request: GenericHttpWireRequest } | { readonly ok: false };

type SourceValue = string | number | undefined;

/**
 * One reader per approved source. A frozen null-prototype table, so no
 * inherited name — `constructor`, `__proto__`, `toString` — is ever a reader,
 * and `boundedGrantId` is simply not a key.
 */
const READERS: Readonly<Record<EnterpriseGenericHttpActionSource, (action: ValidatedExecutionAction) => SourceValue>> = Object.freeze(
  Object.assign(Object.create(null) as Record<EnterpriseGenericHttpActionSource, (action: ValidatedExecutionAction) => SourceValue>, {
    subject: (action: ValidatedExecutionAction) => action.subject,
    action: (action: ValidatedExecutionAction) => action.action,
    resource: (action: ValidatedExecutionAction) => action.resource,
    counterparty: (action: ValidatedExecutionAction) => action.counterparty,
    organization: (action: ValidatedExecutionAction) => action.organization,
    'amount.value': (action: ValidatedExecutionAction) => action.amount?.value,
    'amount.unit': (action: ValidatedExecutionAction) => action.amount?.unit,
    notAfter: (action: ValidatedExecutionAction) => action.notAfter,
    'correlation.requestId': (action: ValidatedExecutionAction) => action.correlation.requestId,
    'correlation.decisionId': (action: ValidatedExecutionAction) => action.correlation.decisionId,
    'correlation.executionId': (action: ValidatedExecutionAction) => action.correlation.executionId,
  }),
);

const CONTROL = /[\u0000-\u001f\u007f]/;
const HEADER_VALUE = /^[\t\x20-\x7e]*$/;

/** Signals "this request cannot be built" from deep inside the mapping. Never escapes `mapGenericHttpRequest`. */
class Unbuildable extends Error {}

function unbuildable(): never {
  throw new Unbuildable();
}

function readSource(action: ValidatedExecutionAction, source: EnterpriseGenericHttpActionSource): SourceValue {
  if (!Object.prototype.hasOwnProperty.call(READERS, source)) return unbuildable();
  const value = READERS[source](action);
  if (value === undefined) return undefined;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return unbuildable();
}

/** Text form for a path, query or header position. `undefined` means "omit". */
function textFor(binding: GenericHttpPlanBinding, action: ValidatedExecutionAction): string | undefined {
  if (binding.kind === 'literal') {
    const literal = binding.value;
    if (literal === null) return unbuildable();
    if (typeof literal === 'boolean') return literal ? 'true' : 'false';
    if (typeof literal === 'number') return decimalString(literal) ?? unbuildable();
    return literal;
  }
  const value = readSource(action, binding.source);
  if (value === undefined) return binding.required ? unbuildable() : undefined;
  if (typeof value === 'number') return decimalString(value) ?? unbuildable();
  return value;
}

/** JSON form for a body position. Strings stay strings, numbers stay numbers, literals keep their type. `undefined` means "omit". */
function jsonFor(binding: GenericHttpPlanBinding, action: ValidatedExecutionAction): string | number | boolean | null | undefined {
  if (binding.kind === 'literal') return binding.value;
  const value = readSource(action, binding.source);
  if (value === undefined) return binding.required ? unbuildable() : undefined;
  return value;
}

/**
 * One value, one path segment. `encodeURIComponent` escapes `/`, `?`, `#`, `%`,
 * `\` and every other reserved character, so a resource of
 * `https://evil.example/a/../admin?x=1` becomes data inside a single segment
 * and cannot change scheme, host, port, hierarchy, query or fragment. `.` and
 * `..` are unreserved and would survive encoding as dot-segments, so they are
 * refused outright. Nothing here is ever decoded again.
 */
function encodeSegment(value: string): string {
  if (value.length === 0 || value === '.' || value === '..' || CONTROL.test(value)) return unbuildable();
  return encodeURIComponent(value);
}

/**
 * Build the request, or report that it cannot be built. Total: it never
 * throws, and a failure here guarantees the transport is never reached.
 */
export function mapGenericHttpRequest(plan: GenericHttpPlan, action: ValidatedExecutionAction): GenericHttpMappingResult {
  try {
    const segments = plan.path.map((segment) => encodeSegment(segment.kind === 'literal' ? segment.value : (textFor({ kind: 'source', source: segment.source, required: true }, action) ?? unbuildable())));
    const pairs: string[] = [];
    for (const [key, binding] of plan.query) {
      const value = textFor(binding, action);
      if (value === undefined) continue;
      if (CONTROL.test(value)) return { ok: false };
      pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
    }
    const path = `/${segments.join('/')}${pairs.length > 0 ? `?${pairs.join('&')}` : ''}`;
    const authority = plan.port === 443 ? plan.hostname : `${plan.hostname}:${String(plan.port)}`;
    if (`https://${authority}${path}`.length > LIMITS.maxUrlLength) return { ok: false };

    const headers: (readonly [string, string])[] = [];
    for (const [name, binding] of plan.headers) {
      const value = textFor(binding, action);
      if (value === undefined) continue;
      if (!HEADER_VALUE.test(value) || value.length > LIMITS.maxHeaderValueLength) return { ok: false };
      headers.push([name, value]);
    }

    let body: string | undefined;
    if (plan.body !== undefined) {
      // Null prototype: a destination key can never reach a prototype, and the
      // plan already refused `__proto__`, `prototype` and `constructor`.
      const object = Object.create(null) as Record<string, string | number | boolean | null>;
      for (const [key, binding] of plan.body) {
        const value = jsonFor(binding, action);
        if (value === undefined) continue;
        object[key] = value;
      }
      body = JSON.stringify(object);
      if (Buffer.byteLength(body, 'utf8') > LIMITS.maxBodyBytes) return { ok: false };
      headers.push(['content-type', 'application/json']);
      headers.push(['content-length', String(Buffer.byteLength(body, 'utf8'))]);
    }

    if (plan.credential !== undefined) headers.push([plan.credential.name, plan.credential.value]);

    // The transport adds `host` from the pinned origin; it is counted here so
    // the bound is on what actually goes out.
    const headerBytes = headers.reduce((total, [name, value]) => total + name.length + value.length + 4, `host: ${authority}\r\n`.length);
    if (headerBytes > LIMITS.maxTotalHeaderBytes) return { ok: false };

    const names = new Set(headers.map(([name]) => name));
    if (names.size !== headers.length) return { ok: false };

    return {
      ok: true,
      request: Object.freeze({
        method: plan.method,
        hostname: plan.hostname,
        port: plan.port,
        path,
        headers: Object.freeze(headers.map((header) => Object.freeze([header[0], header[1]] as const))),
        ...(body !== undefined ? { body } : {}),
      }),
    };
  } catch {
    return { ok: false };
  }
}
