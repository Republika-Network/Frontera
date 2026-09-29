import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';

import { AuthorityAuthenticityConfigurationError } from '../authority-authenticity/errors.js';
import { EXTERNAL_AUTHORITY_SIGNER_PATHS, externalSigningRequestBody, type ExternalAuthoritySigningRequest } from './protocol.js';
import { ExternalAuthoritySignerTransportError, type ExternalAuthoritySignerTransport } from './transport.js';

/**
 * The reference HTTP transport to an external custody service speaking
 * `frontera.external-authority-signer.v1`.
 *
 * What it guarantees, and what it does not:
 *
 * - **Authenticated channel (client side).** Every request carries the
 *   deployment's service credential as a bearer token. The credential is not
 *   the key — but it authorizes *use* of the key, so it is treated as a secret:
 *   never logged, never in an error, never on public configuration.
 * - **Authenticated signer (server side) — by what it signs, not by TLS.** The
 *   service's answers are never trusted on their own: its identity is checked
 *   against the configured trust root, and every signature is verified locally
 *   against the pinned trusted key before anything is persisted
 *   (`external-signer.ts`). An endpoint that is not the pinned key's custodian
 *   can deny service; it cannot produce accepted authority.
 * - **Transport security.** `https:` for any host (Node's default certificate
 *   verification). Plain `http:` **only to a loopback address** — the local
 *   reference custody service. This transport does not implement mTLS or
 *   workload identity; a production adapter that needs them implements
 *   `ExternalAuthoritySignerTransport` itself, with no change to CORE.
 * - **Bounded.** One request per call, a hard per-call timeout, no redirects
 *   followed, a response-size cap.
 */

export interface HttpExternalAuthoritySignerTransportOptions {
  /** Base URL of the custody service, e.g. `https://signer.internal.example:8443` or `http://127.0.0.1:7443`. No credentials, query or fragment. */
  readonly endpoint: string;
  /** The service credential, sent as `Authorization: Bearer …`. Secret. */
  readonly credential: string;
}

const MAXIMUM_RESPONSE_BYTES = 64 * 1024;
export const MINIMUM_EXTERNAL_SIGNER_CREDENTIAL_LENGTH = 32;

function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  return host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host);
}

/**
 * Why an endpoint is not acceptable, or `undefined` when it is. Names the rule,
 * never the value (an endpoint mistyped into the wrong variable can be a secret).
 */
export function externalSignerEndpointProblem(endpoint: string): string | undefined {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return 'is not an absolute URL';
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'must use https (or http to a loopback address for the local reference signer)';
  if (url.protocol === 'http:' && !isLoopbackHostname(url.hostname)) return 'uses plain http to a non-loopback address; only https is accepted beyond loopback';
  if (url.username !== '' || url.password !== '') return 'must not carry credentials in the URL';
  if (url.search !== '' || url.hash !== '') return 'must not carry a query or fragment';
  if (url.pathname !== '/' && url.pathname !== '') return 'must be a base URL with no path';
  return undefined;
}

export function externalSignerCredentialProblem(credential: string): string | undefined {
  if (credential.length < MINIMUM_EXTERNAL_SIGNER_CREDENTIAL_LENGTH) return `must be at least ${MINIMUM_EXTERNAL_SIGNER_CREDENTIAL_LENGTH} characters`;
  if (/\s/.test(credential)) return 'must not contain whitespace';
  return undefined;
}

export function createHttpExternalAuthoritySignerTransport(options: HttpExternalAuthoritySignerTransportOptions): ExternalAuthoritySignerTransport {
  const endpointProblem = externalSignerEndpointProblem(options.endpoint);
  if (endpointProblem !== undefined) throw new AuthorityAuthenticityConfigurationError(`The external authority signer endpoint ${endpointProblem}.`);
  const credentialProblem = externalSignerCredentialProblem(options.credential);
  if (credentialProblem !== undefined) throw new AuthorityAuthenticityConfigurationError(`The external authority signer credential ${credentialProblem}.`);

  const base = new URL(options.endpoint);
  const origin = base.origin;
  const send = base.protocol === 'https:' ? httpsRequest : httpRequest;
  // Held in this closure only; never on the returned object.
  const authorization = `Bearer ${options.credential}`;

  function call(method: 'GET' | 'POST', path: string, body: Record<string, unknown> | undefined, timeoutMs: number): Promise<unknown> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      return Promise.reject(new ExternalAuthoritySignerTransportError('EXTERNAL_SIGNER_UNAVAILABLE', 'The external authority signer call has no valid time budget.'));
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (outcome: { readonly value: unknown } | { readonly error: ExternalAuthoritySignerTransportError }): void => {
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
          headers: {
            authorization,
            accept: 'application/json',
            ...(payload !== undefined ? { 'content-type': 'application/json', 'content-length': String(payload.length) } : {}),
          },
        },
        (res: IncomingMessage) => {
          const status = res.statusCode ?? 0;
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAXIMUM_RESPONSE_BYTES) {
              res.destroy();
              finish({ error: new ExternalAuthoritySignerTransportError('EXTERNAL_SIGNER_MALFORMED_RESPONSE', 'The external authority signer answered with an oversized response.') });
              return;
            }
            chunks.push(chunk);
          });
          res.on('error', () => finish({ error: new ExternalAuthoritySignerTransportError('EXTERNAL_SIGNER_UNREACHABLE', 'The connection to the external authority signer failed mid-response.') }));
          res.on('end', () => {
            // Status first: the body of a refusal is never parsed, echoed or trusted.
            if (status === 401 || status === 403) {
              finish({ error: new ExternalAuthoritySignerTransportError('EXTERNAL_SIGNER_AUTHENTICATION_FAILED', `The external authority signer refused this deployment's credential (HTTP ${status}).`) });
              return;
            }
            if (status === 429 || status >= 500) {
              finish({ error: new ExternalAuthoritySignerTransportError('EXTERNAL_SIGNER_UNAVAILABLE', `The external authority signer is unavailable (HTTP ${status}).`) });
              return;
            }
            if (status >= 300 && status < 500) {
              finish({ error: new ExternalAuthoritySignerTransportError('EXTERNAL_SIGNER_REFUSED', `The external authority signer refused the request (HTTP ${status}).`) });
              return;
            }
            if (status !== 200) {
              finish({ error: new ExternalAuthoritySignerTransportError('EXTERNAL_SIGNER_MALFORMED_RESPONSE', `The external authority signer answered with an unexpected status (HTTP ${status}).`) });
              return;
            }
            try {
              finish({ value: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown });
            } catch {
              finish({ error: new ExternalAuthoritySignerTransportError('EXTERNAL_SIGNER_MALFORMED_RESPONSE', 'The external authority signer answered with a body that is not JSON.') });
            }
          });
        },
      );
      timer = setTimeout(() => {
        finish({ error: new ExternalAuthoritySignerTransportError('EXTERNAL_SIGNER_TIMEOUT', `The external authority signer did not answer within ${timeoutMs} ms.`) });
        req.destroy();
      }, timeoutMs);
      // The underlying error is not propagated: it can name addresses and
      // system detail, and it never changes what the caller must do.
      req.on('error', () => finish({ error: new ExternalAuthoritySignerTransportError('EXTERNAL_SIGNER_UNREACHABLE', 'The external authority signer could not be reached.') }));
      if (payload !== undefined) req.end(payload);
      else req.end();
    });
  }

  return Object.freeze({
    identity: ({ timeoutMs }: { readonly timeoutMs: number }) => call('GET', EXTERNAL_AUTHORITY_SIGNER_PATHS.identity, undefined, timeoutMs),
    sign: (request: ExternalAuthoritySigningRequest, { timeoutMs }: { readonly timeoutMs: number }) =>
      call('POST', EXTERNAL_AUTHORITY_SIGNER_PATHS[request.operation], externalSigningRequestBody(request), timeoutMs),
  });
}
