import { snapshotPlainJson } from './canonical.js';
import { SYNTHETIC_DESIGNATION, isIdentifier, toMs } from './contracts.js';
import { MAX_TRANSITIONS_PAGE, type StatusIssueOutcome, type StatusRegistry } from './status-registry.js';

/**
 * RN-CONFORM-03 / WP-08, WP-09 — the read-only status HTTP binding as a pure
 * request handler. No sockets here: this module maps a parsed request to a
 * response. The only listener that can carry it is the loopback-only,
 * disabled-by-default local test adapter (see RN_CONFORM_03_IMPLEMENTATION.md §8).
 * It is **not** part of the frozen Enterprise Host API (`release/api-surface.v1.json`)
 * and is composed by no Host.
 *
 * Routes (RN-CONFORM-01 INTEGRATION_CONTRACTS.md §6):
 *
 * | Method | Path | Response |
 * |---|---|---|
 * | POST | `/conformance/v1/status` | online, nonce-bound assertion or signed refusal; `Cache-Control: no-store` |
 * | GET | `/conformance/v1/credentials/{id}/status` | stapled assertion; `max-age` ≤ remaining signed validity |
 * | GET | `/conformance/v1/credentials/{id}/transitions?after=&limit=` | public transition fields, ≤ 50 per page |
 * | GET | `/conformance/v1/keys` | issuer public keys (a convenience — verifiers pin keys out of band) |
 *
 * Every response is JSON. Nothing unsigned ever states a credential's state:
 * when no signature can be produced the answer is `503 {"error":"UNAVAILABLE","signed":false}`,
 * which a client must treat as not conformant. Requests are size-limited,
 * closed-schema and rate-limited.
 */

export const MAX_STATUS_REQUEST_BYTES = 4 * 1024;

export interface StatusHttpRequest {
  readonly method: string;
  /** Path and query, e.g. `/conformance/v1/credentials/crd_x/transitions?after=1&limit=10`. */
  readonly url: string;
  readonly contentType: string | null;
  readonly body: string | null;
  /** An opaque client key for rate limiting (the local adapter uses the loopback peer address). */
  readonly clientKey: string;
}

export interface StatusHttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface RateLimiter {
  allow(clientKey: string, nowMs: number): boolean;
}

/** A fixed-window limiter, per client key. Test-only strategy; production rate limiting is out of scope. */
export function createFixedWindowRateLimiter(options: { readonly limit: number; readonly windowMs: number; readonly maxClients?: number }): RateLimiter {
  const windows = new Map<string, { start: number; count: number }>();
  const maxClients = options.maxClients ?? 1024;
  return Object.freeze({
    allow(clientKey: string, nowMs: number): boolean {
      const w = windows.get(clientKey);
      if (w === undefined || nowMs - w.start >= options.windowMs) {
        if (w === undefined && windows.size >= maxClients) {
          for (const [key, value] of windows) if (nowMs - value.start >= options.windowMs) windows.delete(key);
          if (windows.size >= maxClients) return false;
        }
        windows.set(clientKey, { start: nowMs, count: 1 });
        return true;
      }
      w.count += 1;
      return w.count <= options.limit;
    },
  });
}

const BASE_HEADERS = Object.freeze({ 'content-type': 'application/json; charset=utf-8', 'x-content-type-options': 'nosniff', 'x-conformance-designation': SYNTHETIC_DESIGNATION });
const respond = (status: number, body: string, cache: string): StatusHttpResponse => Object.freeze({ status, headers: Object.freeze({ ...BASE_HEADERS, 'cache-control': cache }), body });
const error = (status: number, code: string): StatusHttpResponse => respond(status, JSON.stringify({ error: code, signed: false }), 'no-store');

function outcomeResponse(outcome: StatusIssueOutcome, cache: (validUntil: string) => string): StatusHttpResponse {
  switch (outcome.kind) {
    case 'assertion':
      return respond(200, outcome.text, cache(outcome.assertion.validUntil));
    case 'refusal':
      // A signed refusal is an answer, not an infrastructure failure; it never states a credential's state.
      return respond(200, outcome.text, 'no-store');
    case 'unavailable':
      if (outcome.reason === 'MALFORMED_REQUEST') return error(outcome.detail === 'UNKNOWN_CREDENTIAL' ? 404 : 400, outcome.detail === 'UNKNOWN_CREDENTIAL' ? 'UNKNOWN_CREDENTIAL' : 'MALFORMED_REQUEST');
      return error(503, 'UNAVAILABLE');
  }
}

const CREDENTIAL_PATH = /^\/conformance\/v1\/credentials\/([^/?#]+)\/(status|transitions)$/;

export function createStatusHttpHandler(deps: { readonly registry: StatusRegistry; readonly clock: { now(): string }; readonly rateLimiter: RateLimiter }): (request: StatusHttpRequest) => StatusHttpResponse {
  return (request: StatusHttpRequest): StatusHttpResponse => {
    try {
      const nowMs = toMs(deps.clock.now());
      if (!deps.rateLimiter.allow(request.clientKey, nowMs)) return error(429, 'RATE_LIMITED');
      if (typeof request.url !== 'string' || request.url.length > 512) return error(414, 'URI_TOO_LONG');
      const url = new URL(request.url, 'http://127.0.0.1');
      const path = url.pathname;

      if (path === '/conformance/v1/status') {
        if (request.method !== 'POST') return error(405, 'METHOD_NOT_ALLOWED');
        if (url.search !== '') return error(400, 'MALFORMED_REQUEST');
        if (request.contentType === null || !/^application\/json(\s*;\s*charset=utf-8)?$/i.test(request.contentType)) return error(415, 'UNSUPPORTED_MEDIA_TYPE');
        if (request.body === null || Buffer.byteLength(request.body, 'utf8') > MAX_STATUS_REQUEST_BYTES) return error(413, 'REQUEST_TOO_LARGE');
        let body: unknown;
        try {
          body = snapshotPlainJson(JSON.parse(request.body));
        } catch {
          return error(400, 'MALFORMED_REQUEST');
        }
        return outcomeResponse(deps.registry.issueOnline(body), () => 'no-store');
      }

      if (request.method !== 'GET') return error(405, 'METHOD_NOT_ALLOWED');
      if (request.body !== null && request.body.length > 0) return error(400, 'MALFORMED_REQUEST');

      if (path === '/conformance/v1/keys') {
        if (url.search !== '') return error(400, 'MALFORMED_REQUEST');
        const keys = deps.registry.publicKeys().map((k) => ({ issuer: k.issuer, keyId: k.keyId, publicKeyPem: k.publicKeyPem, validFrom: k.validFrom, validUntil: k.validUntil, revokedAt: k.revokedAt }));
        return respond(200, JSON.stringify({ keys, trust: 'Pin issuer keys out of band; this list is a convenience, not a trust root.', designation: SYNTHETIC_DESIGNATION }), 'no-store');
      }

      const match = CREDENTIAL_PATH.exec(path);
      if (match === null) return error(404, 'NOT_FOUND');
      let credentialId: string;
      try {
        credentialId = decodeURIComponent(match[1]!);
      } catch {
        return error(400, 'MALFORMED_REQUEST');
      }
      if (!isIdentifier(credentialId)) return error(400, 'MALFORMED_REQUEST');

      if (match[2] === 'status') {
        if (url.search !== '') return error(400, 'MALFORMED_REQUEST');
        return outcomeResponse(deps.registry.stapled(credentialId), (validUntil) => `public, max-age=${Math.max(0, Math.floor((toMs(validUntil) - nowMs) / 1000))}`);
      }

      const allowed = new Set(['after', 'limit']);
      for (const key of url.searchParams.keys()) if (!allowed.has(key)) return error(400, 'MALFORMED_REQUEST');
      const after = url.searchParams.get('after') ?? '0';
      const limit = url.searchParams.get('limit') ?? String(MAX_TRANSITIONS_PAGE);
      if (!/^\d{1,6}$/.test(after) || !/^\d{1,3}$/.test(limit) || Number(limit) < 1 || Number(limit) > MAX_TRANSITIONS_PAGE) return error(400, 'MALFORMED_REQUEST');
      const page = deps.registry.transitions(credentialId, Number(after), Number(limit));
      if (page === undefined) return error(404, 'UNKNOWN_CREDENTIAL');
      return respond(200, JSON.stringify({ credentialId, transitions: page, designation: SYNTHETIC_DESIGNATION }), 'no-store');
    } catch {
      return error(503, 'UNAVAILABLE');
    }
  };
}
