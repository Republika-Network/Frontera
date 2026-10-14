import type { IncomingMessage } from 'node:http';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

import { externalSignerCredentialProblem, externalSignerEndpointProblem } from '../external-authority-signer/http-transport.js';
import { DELEGATED_OFFER_SIGNER_PATHS, type DelegatedOfferSigningRequest } from './delegated-offer-protocol.js';

/**
 * TRADE-04B — the HTTP transport of the delegated OfferCreate signer: the one
 * outbound call site of `frontera.xrpl-delegated-offer-signer.v1` (NO_BYPASS
 * EP-073, §7.6). A signing request, never a submission: it reaches the
 * configured signer and nothing else, and no XRPL server.
 *
 * Separate from PAY-03's transport (EP-070) — its own protocol, paths and
 * failure codes — and bounded in every direction:
 *
 * - **endpoint** — one configured base URL: `https:` (Node's default
 *   certificate verification), or plain `http:` to a **literal loopback IP**
 *   only (`127.0.0.0/8` or `[::1]`). The name `localhost` is refused for plain
 *   http: its resolution is the host's, not this transport's, and an operator
 *   who means loopback can say so with an address. No credential, query,
 *   fragment or path in the URL.
 * - **credential** — one bearer token, held in this closure only, sent as the
 *   `authorization` header, never in a body, URL, error or log.
 * - **time** — one per-call budget; on expiry the request is destroyed.
 * - **size** — the request body is capped at 16 KiB before anything is sent;
 *   the response at 16 KiB.
 * - **content** — a `200` must be `application/json`; anything else is a
 *   malformed answer.
 * - **redirects** — never followed (a 3xx is a refusal).
 * - **retries** — none. One attempt per call; a failure is a refusal with
 *   nothing signed on the Host's behalf that the Host will ever use.
 *
 * Errors are a closed reason; no status text, body, header or address is
 * propagated, and a refusal body is never parsed — a signer that echoes a
 * secret in an error cannot place it anywhere.
 */
export const DELEGATED_OFFER_SIGNER_FAILURE_REASONS = [
  'OFFER_SIGNER_TIMEOUT',
  'OFFER_SIGNER_UNREACHABLE',
  'OFFER_SIGNER_UNAVAILABLE',
  'OFFER_SIGNER_AUTHENTICATION_FAILED',
  'OFFER_SIGNER_REFUSED',
  'OFFER_SIGNER_MALFORMED_RESPONSE',
  'OFFER_SIGNER_IDENTITY_MISMATCH',
  'OFFER_SIGNER_RESPONSE_MISMATCH',
  'OFFER_SIGNER_SIGNATURE_INVALID',
  'OFFER_SIGNER_REQUEST_INVALID',
  'OFFER_SIGNER_NOT_VERIFIED',
  'OFFER_SIGNER_BUSY',
] as const;
export type DelegatedOfferSignerFailureReason = (typeof DELEGATED_OFFER_SIGNER_FAILURE_REASONS)[number];

/**
 * A signing failure. It says why nothing was signed for the Host — never
 * that anything was or was not submitted: the signer has no ledger access,
 * and no signing failure is a transaction result.
 */
export class DelegatedOfferSignerError extends Error {
  readonly code: 'OFFER_SIGNER_FAILED';
  readonly reason: DelegatedOfferSignerFailureReason;

  constructor(reason: DelegatedOfferSignerFailureReason, message: string) {
    super(message);
    this.name = 'DelegatedOfferSignerError';
    this.code = 'OFFER_SIGNER_FAILED';
    this.reason = reason;
  }
}

export class DelegatedOfferSignerConfigurationError extends Error {
  readonly code: 'OFFER_SIGNER_CONFIGURATION_INVALID';

  constructor(message: string) {
    super(message);
    this.name = 'DelegatedOfferSignerConfigurationError';
    this.code = 'OFFER_SIGNER_CONFIGURATION_INVALID';
  }
}

/** The transport port: raw answers as `unknown`, failures only as `DelegatedOfferSignerError`. Tests and other transports (mTLS, a provider SDK) implement the same port. */
export interface DelegatedOfferSignerTransport {
  identity(options: { readonly timeoutMs: number }): Promise<unknown>;
  signDelegatedOffer(request: DelegatedOfferSigningRequest, options: { readonly timeoutMs: number }): Promise<unknown>;
}

export const DELEGATED_OFFER_SIGNER_TRANSPORT_LIMITS = Object.freeze({ maximumRequestBytes: 16 * 1024, maximumResponseBytes: 16 * 1024 });

/** A literal loopback address, as a URL hostname spells it: `127.x.y.z` or `[::1]`. */
function isLiteralLoopback(hostname: string): boolean {
  return hostname === '[::1]' || /^127\.(?:25[0-5]|2[0-4]\d|1?\d?\d)\.(?:25[0-5]|2[0-4]\d|1?\d?\d)\.(?:25[0-5]|2[0-4]\d|1?\d?\d)$/.test(hostname);
}

/** Why an endpoint is not acceptable, or `undefined`. Names the rule, never the value. */
export function delegatedOfferSignerEndpointProblem(endpoint: unknown): string | undefined {
  if (typeof endpoint !== 'string') return 'is not a string';
  const problem = externalSignerEndpointProblem(endpoint);
  if (problem !== undefined) return problem;
  const url = new URL(endpoint);
  if (url.protocol === 'http:' && !isLiteralLoopback(url.hostname)) return 'uses plain http to a name; plain http is accepted only to a literal loopback address (127.0.0.0/8 or [::1])';
  return undefined;
}

export function createHttpDelegatedOfferSignerTransport(options: { readonly endpoint: string; readonly credential: string }): DelegatedOfferSignerTransport {
  const endpointProblem = delegatedOfferSignerEndpointProblem(options?.endpoint);
  if (endpointProblem !== undefined) throw new DelegatedOfferSignerConfigurationError(`The delegated offer signer endpoint ${endpointProblem}.`);
  const credentialProblem = typeof options.credential === 'string' ? externalSignerCredentialProblem(options.credential) : 'is not a string';
  if (credentialProblem !== undefined) throw new DelegatedOfferSignerConfigurationError(`The delegated offer signer credential ${credentialProblem}.`);

  const base = new URL(options.endpoint);
  const origin = base.origin;
  const send = base.protocol === 'https:' ? httpsRequest : httpRequest;
  // Held in this closure only; never on the returned object, never in a body.
  const authorization = `Bearer ${options.credential}`;
  const { maximumRequestBytes, maximumResponseBytes } = DELEGATED_OFFER_SIGNER_TRANSPORT_LIMITS;
  const fail = (reason: DelegatedOfferSignerFailureReason, message: string): DelegatedOfferSignerError => new DelegatedOfferSignerError(reason, message);

  function call(method: 'GET' | 'POST', path: string, body: unknown, timeoutMs: number): Promise<unknown> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) return Promise.reject(fail('OFFER_SIGNER_UNAVAILABLE', 'The delegated offer signer call has no valid time budget.'));
    let payload: Buffer | undefined;
    try {
      payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8');
    } catch {
      return Promise.reject(fail('OFFER_SIGNER_REQUEST_INVALID', 'The delegated offer signing request is not serializable.'));
    }
    if (payload !== undefined && payload.length > maximumRequestBytes) return Promise.reject(fail('OFFER_SIGNER_REQUEST_INVALID', 'The delegated offer signing request exceeds the request size bound.'));
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (outcome: { readonly value: unknown } | { readonly error: DelegatedOfferSignerError }): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        if ('error' in outcome) reject(outcome.error);
        else resolve(outcome.value);
      };
      const req = send(
        new URL(path, origin),
        {
          method,
          agent: false,
          headers: { authorization, accept: 'application/json', ...(payload !== undefined ? { 'content-type': 'application/json', 'content-length': String(payload.length) } : {}) },
        },
        (res: IncomingMessage) => {
          const status = res.statusCode ?? 0;
          const contentType = res.headers['content-type'];
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > maximumResponseBytes) {
              res.destroy();
              finish({ error: fail('OFFER_SIGNER_MALFORMED_RESPONSE', 'The delegated offer signer answered with an oversized response.') });
              return;
            }
            chunks.push(chunk);
          });
          res.on('error', () => finish({ error: fail('OFFER_SIGNER_UNREACHABLE', 'The connection to the delegated offer signer failed mid-response.') }));
          res.on('end', () => {
            // Status first: the body of a refusal is never parsed, echoed or trusted.
            if (status === 401 || status === 403) return finish({ error: fail('OFFER_SIGNER_AUTHENTICATION_FAILED', `The delegated offer signer refused this deployment's credential (HTTP ${status}).`) });
            if (status === 429 || status >= 500) return finish({ error: fail('OFFER_SIGNER_UNAVAILABLE', `The delegated offer signer is unavailable (HTTP ${status}).`) });
            if (status >= 300 && status < 500) return finish({ error: fail('OFFER_SIGNER_REFUSED', `The delegated offer signer refused the request (HTTP ${status}).`) });
            if (status !== 200) return finish({ error: fail('OFFER_SIGNER_MALFORMED_RESPONSE', `The delegated offer signer answered with an unexpected status (HTTP ${status}).`) });
            if (typeof contentType !== 'string' || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType)) return finish({ error: fail('OFFER_SIGNER_MALFORMED_RESPONSE', 'The delegated offer signer answered with a content type other than JSON.') });
            try {
              finish({ value: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown });
            } catch {
              finish({ error: fail('OFFER_SIGNER_MALFORMED_RESPONSE', 'The delegated offer signer answered with a body that is not JSON.') });
            }
          });
        },
      );
      timer = setTimeout(() => {
        finish({ error: fail('OFFER_SIGNER_TIMEOUT', `The delegated offer signer did not answer within ${timeoutMs} ms.`) });
        req.destroy();
      }, timeoutMs);
      // The underlying error can name addresses and system detail; it is never propagated.
      req.on('error', () => finish({ error: fail('OFFER_SIGNER_UNREACHABLE', 'The delegated offer signer could not be reached.') }));
      if (payload !== undefined) req.end(payload);
      else req.end();
    });
  }

  return Object.freeze({
    identity: ({ timeoutMs }: { readonly timeoutMs: number }) => call('GET', DELEGATED_OFFER_SIGNER_PATHS.identity, undefined, timeoutMs),
    signDelegatedOffer: (request: DelegatedOfferSigningRequest, { timeoutMs }: { readonly timeoutMs: number }) => call('POST', DELEGATED_OFFER_SIGNER_PATHS.signDelegatedOffer, request, timeoutMs),
  });
}
