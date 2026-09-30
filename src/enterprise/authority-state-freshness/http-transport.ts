import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';

import { AuthorityStateFreshnessError } from './errors.js';
import { AUTHORITY_STATE_WITNESS_PATHS, witnessRequestBody, type WitnessRequest } from './protocol.js';
import type { AuthorityStateWitnessTransport } from './transport.js';

/**
 * The reference HTTP transport to a witness speaking
 * `frontera.authority-state-witness.v1` (CORE-07).
 *
 * The same discipline as CORE-02's signer transport, and deliberately not
 * shared code with it: the two are different trust roles, with different
 * credentials, and coupling their transports would make one's change the
 * other's.
 *
 * - **Authenticated channel (client side).** Every request carries the
 *   deployment's witness credential as a bearer token — its own credential,
 *   never the signer's. Treated as a secret: never logged, never in an error,
 *   never on public configuration.
 * - **Authenticated witness (server side) — by what it signs, not by TLS.**
 *   Every answer is a receipt verified against the pinned witness key over the
 *   caller's fresh challenge (`witness-client.ts`). An endpoint that is not the
 *   pinned witness can deny service; it cannot make a stale state current.
 * - **Transport security.** `https:` for any host. Plain `http:` **only to a
 *   loopback address** — the local reference witness.
 * - **Bounded.** One request per call, a hard per-call timeout, no redirect is
 *   followed (a 3xx is a refusal), a response-size cap, fixed paths only —
 *   the endpoint is a base URL and nothing a caller supplies becomes a path.
 */

export interface HttpAuthorityStateWitnessTransportOptions {
  /** Base URL of the witness, e.g. `https://witness.internal.example:8443` or `http://127.0.0.1:7444`. No credentials, path, query or fragment. */
  readonly endpoint: string;
  /** The witness credential, sent as `Authorization: Bearer …`. Secret. */
  readonly credential: string;
}

const MAXIMUM_RESPONSE_BYTES = 16 * 1024;
export const MINIMUM_AUTHORITY_FRESHNESS_CREDENTIAL_LENGTH = 32;

function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  return host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host);
}

/** Why an endpoint is not acceptable, or `undefined`. Names the rule, never the value. */
export function authorityFreshnessEndpointProblem(endpoint: string): string | undefined {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return 'is not an absolute URL';
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'must use https (or http to a loopback address for the local reference witness)';
  if (url.protocol === 'http:' && !isLoopbackHostname(url.hostname)) return 'uses plain http to a non-loopback address; only https is accepted beyond loopback';
  if (url.username !== '' || url.password !== '') return 'must not carry credentials in the URL';
  if (url.search !== '' || url.hash !== '') return 'must not carry a query or fragment';
  if (url.pathname !== '/' && url.pathname !== '') return 'must be a base URL with no path';
  return undefined;
}

export function authorityFreshnessCredentialProblem(credential: string): string | undefined {
  if (credential.length < MINIMUM_AUTHORITY_FRESHNESS_CREDENTIAL_LENGTH) return `must be at least ${MINIMUM_AUTHORITY_FRESHNESS_CREDENTIAL_LENGTH} characters`;
  if (/\s/.test(credential)) return 'must not contain whitespace';
  return undefined;
}

function failure(code: ConstructorParameters<typeof AuthorityStateFreshnessError>[0], message: string): AuthorityStateFreshnessError {
  return new AuthorityStateFreshnessError(code, message);
}

export function createHttpAuthorityStateWitnessTransport(options: HttpAuthorityStateWitnessTransportOptions): AuthorityStateWitnessTransport {
  const endpointProblem = authorityFreshnessEndpointProblem(options.endpoint);
  if (endpointProblem !== undefined) throw failure('AUTHORITY_FRESHNESS_CONFIGURATION_INVALID', `The authority-state witness endpoint ${endpointProblem}.`);
  const credentialProblem = authorityFreshnessCredentialProblem(options.credential);
  if (credentialProblem !== undefined) throw failure('AUTHORITY_FRESHNESS_CONFIGURATION_INVALID', `The authority-state witness credential ${credentialProblem}.`);

  const base = new URL(options.endpoint);
  const origin = base.origin;
  const send = base.protocol === 'https:' ? httpsRequest : httpRequest;
  // Held in this closure only; never on the returned object.
  const authorization = `Bearer ${options.credential}`;

  function call(request: WitnessRequest, { timeoutMs }: { readonly timeoutMs: number }): Promise<unknown> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      return Promise.reject(failure('AUTHORITY_FRESHNESS_UNAVAILABLE', 'The authority-state witness call has no valid time budget.'));
    }
    const payload = Buffer.from(JSON.stringify(witnessRequestBody(request)), 'utf8');
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (outcome: { readonly value: unknown } | { readonly error: AuthorityStateFreshnessError }): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        if ('error' in outcome) reject(outcome.error);
        else resolve(outcome.value);
      };
      const req = send(
        // A fixed path from the protocol table, resolved against the pinned origin.
        new URL(AUTHORITY_STATE_WITNESS_PATHS[request.operation], origin),
        {
          method: 'POST',
          agent: false,
          headers: { authorization, accept: 'application/json', 'content-type': 'application/json', 'content-length': String(payload.length) },
        },
        (res: IncomingMessage) => {
          const status = res.statusCode ?? 0;
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAXIMUM_RESPONSE_BYTES) {
              res.destroy();
              finish({ error: failure('AUTHORITY_FRESHNESS_MALFORMED_RESPONSE', 'The authority-state witness answered with an oversized response.') });
              return;
            }
            chunks.push(chunk);
          });
          res.on('error', () => finish({ error: failure('AUTHORITY_FRESHNESS_UNAVAILABLE', 'The connection to the authority-state witness failed mid-response.') }));
          res.on('end', () => {
            // Status first: the body of a refusal is never parsed, echoed or trusted.
            if (status === 401 || status === 403) return finish({ error: failure('AUTHORITY_FRESHNESS_AUTHENTICATION_FAILED', `The authority-state witness refused this deployment's credential (HTTP ${status}).`) });
            if (status === 429 || status >= 500) return finish({ error: failure('AUTHORITY_FRESHNESS_UNAVAILABLE', `The authority-state witness is unavailable (HTTP ${status}).`) });
            if (status >= 300 && status < 500) return finish({ error: failure('AUTHORITY_FRESHNESS_REFUSED', `The authority-state witness refused the request (HTTP ${status}); redirects are never followed.`) });
            if (status !== 200) return finish({ error: failure('AUTHORITY_FRESHNESS_MALFORMED_RESPONSE', `The authority-state witness answered with an unexpected status (HTTP ${status}).`) });
            try {
              finish({ value: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown });
            } catch {
              finish({ error: failure('AUTHORITY_FRESHNESS_MALFORMED_RESPONSE', 'The authority-state witness answered with a body that is not JSON.') });
            }
          });
        },
      );
      timer = setTimeout(() => {
        finish({ error: failure('AUTHORITY_FRESHNESS_UNAVAILABLE', `The authority-state witness did not answer within ${timeoutMs} ms.`) });
        req.destroy();
      }, timeoutMs);
      // The underlying error is not propagated: it can name addresses and system detail.
      req.on('error', () => finish({ error: failure('AUTHORITY_FRESHNESS_UNAVAILABLE', 'The authority-state witness could not be reached.') }));
      req.end(payload);
    });
  }

  return Object.freeze({ call });
}
