import { promises as dnsPromises } from 'node:dns';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import type { LookupFunction, Socket } from 'node:net';
import type { GenericHttpWireRequest } from './request-mapper.js';
import type { GenericHttpResolvedAddress } from './public-address-policy.js';

/**
 * The Generic HTTP adapter's Node transport — **the one outbound network call
 * site** this adapter has, and the only module in `src/` that imports
 * `node:https` or `node:dns`. `no-bypass-effect-paths.test.ts` fails the build
 * if a second one appears.
 *
 * ## The DNS answer that was judged is the address that is dialled
 *
 * `resolve` asks the system resolver once, for every A/AAAA answer. The adapter
 * judges them all and picks one. `send` then hands `https.request` a `lookup`
 * that **ignores the hostname it is asked about** and returns that one approved
 * address — so the socket connects to exactly the address the policy approved,
 * and there is no second resolution for DNS to rebind between check and use.
 * The TCP `connect` is verified against it as well, before a single request
 * byte can be written, in case anything below ever dials somewhere else.
 *
 * The hostname still drives TLS: `servername` (SNI) and certificate
 * verification use the pinned hostname, and so does the `Host` header.
 * Verification is **hardcoded on** — `rejectUnauthorized: true` is written
 * explicitly rather than left to Node's default, because the default yields to
 * the ambient `NODE_TLS_REJECT_UNAUTHORIZED=0` and an explicit `true` does not.
 * It is not an option, not read from the environment, and not reachable by the
 * host or the caller; there is no `ca`, `checkServerIdentity` or
 * `secureContext` here either.
 *
 * ## One request, one connection, no reuse
 *
 * `agent: false` gives every call a fresh, single-use connection: a later
 * governed action can never inherit a socket opened under an earlier DNS
 * answer, and the global agent's pooling, keep-alive and any environment proxy
 * configuration are never consulted. `autoSelectFamily: false` stops Node from
 * racing other address families. No redirect is followed — `node:https` never
 * follows one, and nothing here reads `Location`. Nothing retries.
 *
 * ## Phases, because certainty ends at `secureConnect`
 *
 * Before the TLS session is established no request byte has reached the
 * provider: DNS, TCP refusal, a TLS or certificate failure, or the budget
 * running out there, are all `not-sent`. After `secureConnect` the request may
 * be in the provider's hands, and **any** loss of certainty before a final
 * status arrives — timeout, reset, close, stream error — is `unconfirmed`.
 * A final status, once received, is authoritative.
 *
 * ## The response body is never read
 *
 * The status and headers are all that is needed. The moment they arrive the
 * response and the request are destroyed, so the body is neither buffered,
 * parsed, logged nor left streaming after the adapter has returned.
 */

export type GenericHttpResolution = { readonly kind: 'resolved'; readonly answers: readonly GenericHttpResolvedAddress[] } | { readonly kind: 'failed' };

export type GenericHttpTransportObservation =
  /** Proven not to have reached the provider: DNS/TCP/TLS failure or budget exhausted before the secure session existed. */
  | { readonly kind: 'not-sent' }
  /** The socket connected somewhere other than the approved address. Nothing was written. */
  | { readonly kind: 'destination-mismatch' }
  /** The secure session existed and certainty was lost before a final status. */
  | { readonly kind: 'unconfirmed' }
  /** A final status. `providerRefValues` lists every raw value of the configured provider-reference header, in order, never joined. */
  | { readonly kind: 'response'; readonly status: number; readonly providerRefValues: readonly string[] };

/** What the adapter core needs from the network. Internal — never exported from the Enterprise barrel, never a public option. */
export interface GenericHttpNetworkRuntime {
  resolve(hostname: string, timeoutMs: number): Promise<GenericHttpResolution>;
  send(request: GenericHttpWireRequest, address: GenericHttpResolvedAddress, timeoutMs: number, providerRefHeader: string | undefined): Promise<GenericHttpTransportObservation>;
}

/** The request primitive, injectable only inside this module's tests. */
export type GenericHttpRequestPrimitive = (options: RequestOptions, onResponse: (response: IncomingMessage) => void) => ClientRequest;

async function resolveAll(hostname: string, timeoutMs: number): Promise<GenericHttpResolution> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<GenericHttpResolution>((resolve) => {
    timer = setTimeout(() => resolve({ kind: 'failed' }), timeoutMs);
  });
  const lookup = dnsPromises
    .lookup(hostname, { all: true, verbatim: true })
    .then((answers): GenericHttpResolution => ({
      kind: 'resolved',
      answers: answers.map((answer) => ({ address: answer.address, family: answer.family === 6 ? 6 : 4 }) as const),
    }))
    .catch((): GenericHttpResolution => ({ kind: 'failed' }));
  try {
    return await Promise.race([lookup, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** A `lookup` that answers every question with the one approved address. */
function pinnedLookup(approved: GenericHttpResolvedAddress): LookupFunction {
  return ((_hostname: string, options: { readonly all?: boolean } | undefined, callback: (...args: unknown[]) => void) => {
    if (options !== undefined && options !== null && typeof options === 'object' && options.all === true) {
      callback(null, [{ address: approved.address, family: approved.family }]);
    } else {
      callback(null, approved.address, approved.family);
    }
  }) as unknown as LookupFunction;
}

/**
 * The exact `https.request` options. Exported for the transport's own
 * structural tests. `autoSelectFamily` is passed through to `net.connect` by
 * Node even where the installed typings do not declare it on `RequestOptions`;
 * with a lookup that only ever answers one address it is belt and braces.
 */
export function buildNodeRequestOptions(request: GenericHttpWireRequest, approved: GenericHttpResolvedAddress): RequestOptions & { readonly autoSelectFamily: false } {
  const headers = Object.create(null) as Record<string, string>;
  for (const [name, value] of request.headers) headers[name] = value;
  return {
    protocol: 'https:',
    hostname: request.hostname,
    port: request.port,
    servername: request.hostname,
    method: request.method,
    path: request.path,
    headers,
    setHost: true,
    agent: false,
    // Explicit, never defaulted: an ambient NODE_TLS_REJECT_UNAUTHORIZED=0
    // cannot relax certificate verification for a governed effect.
    rejectUnauthorized: true,
    lookup: pinnedLookup(approved),
    family: approved.family,
    autoSelectFamily: false,
    insecureHTTPParser: false,
  };
}

/** Every raw value of one response header, in order. Never joined, so a duplicate is visible as two values. */
function rawHeaderValues(response: IncomingMessage, name: string | undefined): readonly string[] {
  if (name === undefined) return [];
  const raw = response.rawHeaders;
  const values: string[] = [];
  for (let index = 0; index + 1 < raw.length; index += 2) {
    if ((raw[index] ?? '').toLowerCase() === name) values.push(raw[index + 1] ?? '');
  }
  return values;
}

/**
 * Exactly one request. The primitive is invoked once, synchronously, and this
 * function has no loop and no second call: it cannot retry, and it cannot
 * follow anything.
 */
export function sendOnce(
  primitive: GenericHttpRequestPrimitive,
  request: GenericHttpWireRequest,
  approved: GenericHttpResolvedAddress,
  timeoutMs: number,
  providerRefHeader: string | undefined,
): Promise<GenericHttpTransportObservation> {
  return new Promise<GenericHttpTransportObservation>((resolve) => {
    let settled = false;
    let secured = false;
    let outbound: ClientRequest | undefined;

    const settle = (observation: GenericHttpTransportObservation): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        outbound?.destroy();
      } catch {
        // Destroying a request that is already gone is not an outcome.
      }
      resolve(observation);
    };
    const lost = (): void => settle(secured ? { kind: 'unconfirmed' } : { kind: 'not-sent' });
    const timer = setTimeout(lost, timeoutMs);

    try {
      outbound = primitive(buildNodeRequestOptions(request, approved), (response) => {
        const status = response.statusCode;
        const providerRefValues = rawHeaderValues(response, providerRefHeader);
        // Discard the body without reading it, and end the exchange now.
        try {
          response.destroy();
        } catch {
          // Nothing to recover: the status is already in hand.
        }
        settle(typeof status === 'number' ? { kind: 'response', status, providerRefValues } : { kind: secured ? 'unconfirmed' : 'not-sent' });
      });
    } catch {
      // The primitive refused synchronously: no socket, nothing sent.
      settle({ kind: 'not-sent' });
      return;
    }

    outbound.on('socket', (socket: Socket) => {
      socket.once('connect', () => {
        // An address that is readable and different is a socket that dialled
        // somewhere the policy never approved: refuse before TLS, so no request
        // byte is written. An unreadable one means the peer already closed —
        // the `error`/`close` below settles that as the pre-send failure it is.
        const remote = socket.remoteAddress;
        if (typeof remote === 'string' && remote !== approved.address) settle({ kind: 'destination-mismatch' });
      });
      socket.once('secureConnect', () => {
        secured = true;
      });
    });
    outbound.on('error', lost);
    outbound.on('close', lost);
    outbound.on('timeout', lost);

    try {
      if (request.body !== undefined) outbound.end(request.body, 'utf8');
      else outbound.end();
    } catch {
      lost();
    }
  });
}

/** The production runtime: the system resolver and `node:https`, bound here and nowhere else. */
export const NODE_GENERIC_HTTP_RUNTIME: GenericHttpNetworkRuntime = Object.freeze({
  resolve: resolveAll,
  send: (request: GenericHttpWireRequest, address: GenericHttpResolvedAddress, timeoutMs: number, providerRefHeader: string | undefined) =>
    sendOnce(httpsRequest as unknown as GenericHttpRequestPrimitive, request, address, timeoutMs, providerRefHeader),
});
