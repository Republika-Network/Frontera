import type { GenericHttpPlan } from './configuration.js';
import type { GenericHttpWireRequest } from './request-mapper.js';

/**
 * G-02C0 — `frontera.http-request-binding.v1`: the record that names one
 * Generic HTTP request **exactly as the transport will send it**, minus one
 * precisely defined secret.
 *
 * It is computed from the frozen `GenericHttpWireRequest` the mapper returned —
 * the very object handed to `runtime.send` afterwards — and never from a copy,
 * a re-mapping, the action or a caller. Pure: no I/O, no clock, no second input
 * beyond the plan's credential header **name**.
 *
 * ## What it covers
 *
 * | Field | Value |
 * |---|---|
 * | `method` | the request method |
 * | `origin` | `{ scheme: 'https', hostname, port }` — the pinned destination; the transport derives `Host`, SNI and certificate checks from it |
 * | `target` | the encoded path and query, byte for byte as sent |
 * | `headers` | **every** mapped header the request carries — including `content-type` and `content-length` — as `[name, value]` pairs sorted by name (names are already lower-case and unique), except the one below |
 * | `credentialHeader` | the **name** of the excluded credential header, or `null` when no credential is configured |
 * | `body` | the exact body string, or `null` when the request has none |
 *
 * ## What it excludes — exactly one thing
 *
 * The **value** of the operator-configured credential header
 * (`authorization` for a bearer credential, or the one configured header). It
 * is a secret, it is operator configuration rather than governed input, and
 * it can never be chosen by an action. Its **name** stays in the record, so a
 * request cannot move another header into the excluded slot without changing
 * the digest. No other header, no part of the target and no byte of the body
 * is ever left out.
 *
 * Headers the Node transport adds on its own — `host` (a function of the bound
 * origin) and the connection and framing headers it derives from the bound
 * method and body — are not in `GenericHttpWireRequest` and therefore not in
 * the record; they carry nothing the record does not already fix.
 *
 * A party that recomputes the record must apply the same rule to the request it
 * received: the same fields, the same sort, the same single exclusion.
 */

export const GENERIC_HTTP_REQUEST_BINDING_FORMAT = 'frontera.http-request-binding.v1';

export interface GenericHttpRequestBinding {
  readonly method: string;
  readonly origin: { readonly scheme: 'https'; readonly hostname: string; readonly port: number };
  readonly target: string;
  readonly headers: readonly (readonly [string, string])[];
  readonly credentialHeader: string | null;
  readonly body: string | null;
}

/** Code-unit order: the header names are lower-case ASCII tokens and unique, so this is a total order. */
function byName(left: readonly [string, string], right: readonly [string, string]): number {
  return left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0;
}

/**
 * The binding record of `request` under `credentialHeader` (the plan's
 * credential header name, or `undefined`). A deep-frozen plain-JSON record.
 */
export function genericHttpRequestBindingOf(request: GenericHttpWireRequest, credentialHeader: string | undefined): GenericHttpRequestBinding {
  const headers = request.headers
    .filter(([name]) => credentialHeader === undefined || name !== credentialHeader)
    .map(([name, value]) => Object.freeze([name, value] as const))
    .sort(byName);
  return Object.freeze({
    method: request.method,
    origin: Object.freeze({ scheme: 'https' as const, hostname: request.hostname, port: request.port }),
    target: request.path,
    headers: Object.freeze(headers),
    credentialHeader: credentialHeader ?? null,
    body: request.body ?? null,
  });
}

/** The record for a request this plan built. */
export function genericHttpRequestBinding(plan: GenericHttpPlan, request: GenericHttpWireRequest): GenericHttpRequestBinding {
  return genericHttpRequestBindingOf(request, plan.credential?.name);
}
