import type { IncomingMessage } from 'node:http';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

import { externalSignerCredentialProblem, externalSignerEndpointProblem } from '../external-authority-signer/http-transport.js';
import { EXTERNAL_XRPL_SIGNER_PATHS, type ExternalXrplSigningRequest } from './signer-protocol.js';

/**
 * PAY-03 — the HTTP transport of the external XRPL transaction signer: the
 * one outbound call site of the signing protocol (NO_BYPASS §7.6).
 *
 * Bounded in every direction, in the manner of CORE-02's transport:
 *
 * - **endpoint** — one configured base URL: https, or plain http to a loopback
 *   address only (the reference signer on the same host); no credentials,
 *   query, fragment or path. TLS uses Node's default certificate verification.
 * - **credential** — one bearer token, held in this closure only, sent as the
 *   `authorization` header and never in the body.
 * - **time** — one per-call budget; on expiry the request is destroyed.
 * - **size** — the response is capped at 64 KiB.
 * - **redirects** — never followed (a 3xx is a refusal).
 * - **retries** — none. Signing has no ledger side effect, but a retried
 *   request is a second signature over the same sequence: one attempt, and a
 *   failure is a refusal with nothing submitted.
 *
 * Errors are a closed reason; no status text, body, header or address is ever
 * propagated — a refusal body is never parsed, so a signer that echoes a
 * secret in an error cannot place it anywhere.
 */
export const EXTERNAL_XRPL_SIGNER_FAILURE_REASONS = [
  'XRPL_SIGNER_TIMEOUT',
  'XRPL_SIGNER_UNREACHABLE',
  'XRPL_SIGNER_UNAVAILABLE',
  'XRPL_SIGNER_AUTHENTICATION_FAILED',
  'XRPL_SIGNER_REFUSED',
  'XRPL_SIGNER_MALFORMED_RESPONSE',
  'XRPL_SIGNER_IDENTITY_MISMATCH',
  'XRPL_SIGNER_RESPONSE_MISMATCH',
] as const;
export type ExternalXrplSignerFailureReason = (typeof EXTERNAL_XRPL_SIGNER_FAILURE_REASONS)[number];

export class ExternalXrplSignerError extends Error {
  readonly code: 'XRPL_SIGNER_FAILED';
  readonly reason: ExternalXrplSignerFailureReason;

  constructor(reason: ExternalXrplSignerFailureReason, message: string) {
    super(message);
    this.name = 'ExternalXrplSignerError';
    this.code = 'XRPL_SIGNER_FAILED';
    this.reason = reason;
  }
}

export class ExternalXrplSignerConfigurationError extends Error {
  readonly code: 'XRPL_SIGNER_CONFIGURATION_INVALID';

  constructor(message: string) {
    super(message);
    this.name = 'ExternalXrplSignerConfigurationError';
    this.code = 'XRPL_SIGNER_CONFIGURATION_INVALID';
  }
}

/** The transport port: raw answers as `unknown`, failures only as `ExternalXrplSignerError`. Tests and other transports (mTLS, a provider SDK) implement the same port. */
export interface ExternalXrplSignerTransport {
  identity(options: { readonly timeoutMs: number }): Promise<unknown>;
  signPayment(request: ExternalXrplSigningRequest, options: { readonly timeoutMs: number }): Promise<unknown>;
}

const MAXIMUM_RESPONSE_BYTES = 64 * 1024;

export function createHttpExternalXrplSignerTransport(options: { readonly endpoint: string; readonly credential: string }): ExternalXrplSignerTransport {
  const endpointProblem = typeof options?.endpoint === 'string' ? externalSignerEndpointProblem(options.endpoint) : 'is not a string';
  if (endpointProblem !== undefined) throw new ExternalXrplSignerConfigurationError(`The external XRPL signer endpoint ${endpointProblem}.`);
  const credentialProblem = typeof options.credential === 'string' ? externalSignerCredentialProblem(options.credential) : 'is not a string';
  if (credentialProblem !== undefined) throw new ExternalXrplSignerConfigurationError(`The external XRPL signer credential ${credentialProblem}.`);

  const base = new URL(options.endpoint);
  const origin = base.origin;
  const send = base.protocol === 'https:' ? httpsRequest : httpRequest;
  // Held in this closure only; never on the returned object, never in a body.
  const authorization = `Bearer ${options.credential}`;
  const fail = (reason: ExternalXrplSignerFailureReason, message: string): ExternalXrplSignerError => new ExternalXrplSignerError(reason, message);

  function call(method: 'GET' | 'POST', path: string, body: unknown, timeoutMs: number): Promise<unknown> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) return Promise.reject(fail('XRPL_SIGNER_UNAVAILABLE', 'The external XRPL signer call has no valid time budget.'));
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (outcome: { readonly value: unknown } | { readonly error: ExternalXrplSignerError }): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        if ('error' in outcome) reject(outcome.error);
        else resolve(outcome.value);
      };
      const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8');
      const req = send(
        new URL(path, origin),
        {
          method,
          agent: false,
          headers: { authorization, accept: 'application/json', ...(payload !== undefined ? { 'content-type': 'application/json', 'content-length': String(payload.length) } : {}) },
        },
        (res: IncomingMessage) => {
          const status = res.statusCode ?? 0;
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAXIMUM_RESPONSE_BYTES) {
              res.destroy();
              finish({ error: fail('XRPL_SIGNER_MALFORMED_RESPONSE', 'The external XRPL signer answered with an oversized response.') });
              return;
            }
            chunks.push(chunk);
          });
          res.on('error', () => finish({ error: fail('XRPL_SIGNER_UNREACHABLE', 'The connection to the external XRPL signer failed mid-response.') }));
          res.on('end', () => {
            // Status first: the body of a refusal is never parsed, echoed or trusted.
            if (status === 401 || status === 403) return finish({ error: fail('XRPL_SIGNER_AUTHENTICATION_FAILED', `The external XRPL signer refused this deployment's credential (HTTP ${status}).`) });
            if (status === 429 || status >= 500) return finish({ error: fail('XRPL_SIGNER_UNAVAILABLE', `The external XRPL signer is unavailable (HTTP ${status}).`) });
            if (status >= 300 && status < 500) return finish({ error: fail('XRPL_SIGNER_REFUSED', `The external XRPL signer refused the request (HTTP ${status}).`) });
            if (status !== 200) return finish({ error: fail('XRPL_SIGNER_MALFORMED_RESPONSE', `The external XRPL signer answered with an unexpected status (HTTP ${status}).`) });
            try {
              finish({ value: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown });
            } catch {
              finish({ error: fail('XRPL_SIGNER_MALFORMED_RESPONSE', 'The external XRPL signer answered with a body that is not JSON.') });
            }
          });
        },
      );
      timer = setTimeout(() => {
        finish({ error: fail('XRPL_SIGNER_TIMEOUT', `The external XRPL signer did not answer within ${timeoutMs} ms.`) });
        req.destroy();
      }, timeoutMs);
      // The underlying error can name addresses and system detail; it is never propagated.
      req.on('error', () => finish({ error: fail('XRPL_SIGNER_UNREACHABLE', 'The external XRPL signer could not be reached.') }));
      if (payload !== undefined) req.end(payload);
      else req.end();
    });
  }

  return Object.freeze({
    identity: ({ timeoutMs }: { readonly timeoutMs: number }) => call('GET', EXTERNAL_XRPL_SIGNER_PATHS.identity, undefined, timeoutMs),
    signPayment: (request: ExternalXrplSigningRequest, { timeoutMs }: { readonly timeoutMs: number }) => call('POST', EXTERNAL_XRPL_SIGNER_PATHS.signPayment, request, timeoutMs),
  });
}
