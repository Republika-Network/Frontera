import type { ClientRequest, IncomingMessage } from 'node:http';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';

import {
  LightningSendNotAttemptedError,
  msatOfDecimalText,
  type LightningNodePort,
  type LightningNodeReader,
  type LightningPaymentFailure,
  type LightningPaymentInstruction,
} from '../../features/payment-runtime/rails/lightning/index.js';

/**
 * PAY-06 — the reference Lightning node adapter: LND, over its REST API — the
 * one outbound network call site of the Lightning rail (NO_BYPASS EP-071).
 *
 * ## Why LND
 *
 * Its router API has every property the rail needs, natively: an explicit
 * `fee_limit_msat` enforced by pathfinding **before** any HTLC is sent; one
 * logical payment per payment hash with a deterministic status
 * (`IN_FLIGHT` → `SUCCEEDED` | `FAILED`, and `FAILED` only once no HTLC is in
 * flight); the preimage, payment hash, delivered amount and fee on the
 * payment record; status by payment hash after any restart (`TrackPaymentV2`);
 * its own invoice decoding (`DecodePayReq`); and macaroons, so the credential
 * for reads can be one the node itself refuses to send with. REST keeps the
 * adapter dependency-free (Node's own `https`) — no gRPC stack, no SDK.
 *
 * ## The operations (and nothing else)
 *
 * | port method | LND REST | authority |
 * | --- | --- | --- |
 * | `nodeInfo` | `GET /v1/getinfo` | read |
 * | `decodeInvoice` | `GET /v1/payreq/{invoice}` | read |
 * | `paymentStatus` | `GET /v2/router/track/{hash}` (first update, then closed) | read |
 * | `sendPayment` | `POST /v2/router/send` — `payment_request`, `fee_limit_msat`, `timeout_seconds`, no self-payment, no AMP | **the one send** |
 *
 * `createLndRestLightningNodeReader` builds an object that has no
 * `sendPayment` at all — for the P12 and finality authorities, with a
 * read-only macaroon (`offchain:read`, `info:read`).
 *
 * ## Credential boundary
 *
 * The macaroon (hex) and the pinned TLS certificate live in this closure only:
 * never on a returned object, in a result, an error, a log, a reservation, P11,
 * P12, a settlement or a receipt. Errors are a closed reason — no status text,
 * body, header, address or LND message is ever propagated.
 *
 * ## Transport
 *
 * One configured endpoint: `https:` with the node's certificate **pinned**
 * (it is the only trust anchor — LND's certificate is self-signed), or plain
 * `http:` to a **literal loopback IP address** only (LND `--no-rest-tls` on
 * the same host): `127.0.0.0/8` or `[::1]`. No credentials, path, query or
 * fragment in the endpoint; no redirects; no retries; every call has a
 * deadline; responses are size-bounded.
 *
 * Plain `http:` never names a host: `http://localhost` is refused at
 * configuration. `localhost` is a hostname — the hosts file, NSS or DNS decide
 * where it goes — and a plaintext request carries the macaroon in its headers,
 * so a poisoned resolver would receive the credential. A literal loopback
 * address is decided by the URL alone, before any request exists, and never
 * reaches a resolver. Over `https:` a hostname is fine: the macaroon is sent
 * only inside a session whose certificate matched the pinned one.
 *
 * ## Not sent vs unknown
 *
 * `sendPayment` throws `LightningSendNotAttemptedError` only when the TCP
 * connection was never established — so not one byte of the request left the
 * process. Once the node's port accepted the connection, a timeout, a reset or
 * an error — the TLS handshake included — is unknown: the node may have
 * accepted the payment.
 */

export const LND_REST_FAILURE_REASONS = ['LND_UNREACHABLE', 'LND_TIMEOUT', 'LND_AUTHENTICATION_FAILED', 'LND_REFUSED', 'LND_UNAVAILABLE', 'LND_MALFORMED_RESPONSE'] as const;
export type LndRestFailureReason = (typeof LND_REST_FAILURE_REASONS)[number];

export class LndRestNodeError extends Error {
  readonly code = 'LND_REST_FAILED';
  readonly reason: LndRestFailureReason;

  constructor(reason: LndRestFailureReason) {
    super(`The Lightning node call failed (${reason}).`);
    this.name = 'LndRestNodeError';
    this.reason = reason;
  }
}

export class LndRestConfigurationError extends Error {
  readonly code = 'LND_REST_CONFIGURATION_INVALID';

  constructor(message: string) {
    super(message);
    this.name = 'LndRestConfigurationError';
  }
}

export interface LndRestNodeOptions {
  /** `https://host:port` (with `tlsCertificatePem`) or `http://127.0.0.1:port` / `http://[::1]:port` (a literal loopback IP, LND `--no-rest-tls`; never a hostname). */
  readonly endpoint: string;
  /** LND's `tls.cert`, PEM — the pinned trust anchor. Required for `https:`. */
  readonly tlsCertificatePem?: string;
  /** The macaroon, hex. For the rail: one baked with `offchain:read offchain:write info:read`; for a reader: `offchain:read info:read`. */
  readonly macaroonHex: string;
}

const MAXIMUM_RESPONSE_BYTES = 1024 * 1024;
/** IPv4 `127.0.0.0/8` in the URL parser's canonical dotted-decimal form. */
const LOOPBACK_IPV4 = /^127\.(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\.(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\.(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])$/;

/**
 * A literal loopback IP — decided from the parsed URL alone, never resolved. The WHATWG parser has already
 * canonicalized numeric spellings (`127.1`, `0x7f.0.0.1`, `[0:0::1]`) without a lookup; any hostname, `localhost`
 * included, and any IPv4-mapped form (`[::ffff:127.0.0.1]`) is refused.
 */
function isLiteralLoopback(hostname: string): boolean {
  return hostname === '[::1]' || (isIP(hostname) === 4 && LOOPBACK_IPV4.test(hostname));
}

const LND_NETWORKS: Readonly<Record<string, string>> = Object.freeze({ mainnet: 'mainnet', testnet: 'testnet', signet: 'signet', regtest: 'regtest' });

const LND_FAILURES: Readonly<Record<string, LightningPaymentFailure>> = Object.freeze({
  FAILURE_REASON_TIMEOUT: 'timeout',
  FAILURE_REASON_NO_ROUTE: 'no-route',
  FAILURE_REASON_ERROR: 'error',
  FAILURE_REASON_INCORRECT_PAYMENT_DETAILS: 'incorrect-payment-details',
  FAILURE_REASON_INSUFFICIENT_BALANCE: 'insufficient-balance',
  FAILURE_REASON_CANCELED: 'canceled',
});

/** gRPC `NOT_FOUND`. */
const GRPC_NOT_FOUND = 5;

function endpointProblem(endpoint: unknown, certificate: unknown): string | undefined {
  if (typeof endpoint !== 'string' || endpoint.length === 0 || endpoint.length > 256) return 'must be a URL';
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return 'must be a URL';
  }
  if (url.username !== '' || url.password !== '') return 'must not carry credentials';
  if ((url.pathname !== '/' && url.pathname !== '') || url.search !== '' || url.hash !== '') return 'must be a bare origin (no path, query or fragment)';
  if (url.protocol === 'https:') {
    if (typeof certificate !== 'string' || !certificate.includes('-----BEGIN CERTIFICATE-----') || certificate.includes('PRIVATE KEY')) return "uses https and needs the node's TLS certificate (PEM) pinned";
    return undefined;
  }
  if (url.protocol === 'http:') {
    // The macaroon travels in plaintext headers: only to an address no resolver can redirect.
    if (!isLiteralLoopback(url.hostname)) return 'may use plain http only to a literal loopback IP address (127.0.0.0/8 or [::1]) — never a hostname, localhost included';
    return undefined;
  }
  return 'must use https (or http to a literal loopback IP address)';
}

interface Transport {
  json(method: 'GET', path: string, timeoutMs: number): Promise<unknown>;
  stream(method: 'GET' | 'POST', path: string, body: unknown, timeoutMs: number, stop: (message: unknown) => boolean, notAttempted?: () => Error): Promise<readonly unknown[]>;
}

function createTransport(options: LndRestNodeOptions): Transport {
  const problem = endpointProblem(options?.endpoint, options?.tlsCertificatePem);
  if (problem !== undefined) throw new LndRestConfigurationError(`The Lightning node endpoint ${problem}.`);
  if (typeof options.macaroonHex !== 'string' || !/^(?:[0-9a-f]{2}){16,4096}$/i.test(options.macaroonHex)) throw new LndRestConfigurationError('The Lightning node macaroon must be hex.');
  const base = new URL(options.endpoint);
  const secure = base.protocol === 'https:';
  const send = secure ? httpsRequest : httpRequest;
  // Held in this closure only.
  const macaroon = options.macaroonHex.toLowerCase();
  const ca = secure ? options.tlsCertificatePem : undefined;

  function open(method: 'GET' | 'POST', path: string, body: unknown, timeoutMs: number, onResponse: (res: IncomingMessage, finish: (outcome: { readonly value: unknown } | { readonly error: Error }) => void) => void, notAttempted?: () => Error): Promise<unknown> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) return Promise.reject(new LndRestNodeError('LND_UNAVAILABLE'));
    return new Promise((resolve, reject) => {
      let settled = false;
      let connected = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let req: ClientRequest | undefined;
      const finish = (outcome: { readonly value: unknown } | { readonly error: Error }): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        req?.destroy();
        if ('error' in outcome) reject(outcome.error);
        else resolve(outcome.value);
      };
      const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8');
      req = send(
        new URL(path, base.origin),
        {
          method,
          agent: false,
          ...(ca !== undefined ? { ca, rejectUnauthorized: true } : {}),
          headers: { 'grpc-metadata-macaroon': macaroon, accept: 'application/json', ...(payload !== undefined ? { 'content-type': 'application/json', 'content-length': String(payload.length) } : {}) },
        },
        (res) => onResponse(res, finish),
      );
      req.on('socket', (socket) => {
        // The TCP connection, for http AND https: once the node's port accepted it, nothing that follows — a TLS
        // handshake failure included — proves the request never reached the node.
        if (!socket.connecting) connected = true;
        socket.once('connect', () => {
          connected = true;
        });
      });
      // A deadline before the TCP connection was established is still "never left the process"; after it, unknown.
      timer = setTimeout(() => finish({ error: !connected && notAttempted !== undefined ? notAttempted() : new LndRestNodeError('LND_TIMEOUT') }), timeoutMs);
      // The underlying error can name addresses and system detail; it is never propagated.
      req.on('error', () => finish({ error: !connected && notAttempted !== undefined ? notAttempted() : new LndRestNodeError('LND_UNREACHABLE') }));
      if (payload !== undefined) req.end(payload);
      else req.end();
    });
  }

  /** Status only: a refusal body is never echoed (its message could carry anything). */
  function refusal(status: number): Error {
    if (status === 401 || status === 403) return new LndRestNodeError('LND_AUTHENTICATION_FAILED');
    if (status === 429 || status >= 500) return new LndRestNodeError('LND_UNAVAILABLE');
    return new LndRestNodeError('LND_REFUSED');
  }

  return {
    json(method, path, timeoutMs) {
      return open(method, path, undefined, timeoutMs, (res, finish) => {
        const status = res.statusCode ?? 0;
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAXIMUM_RESPONSE_BYTES) return finish({ error: new LndRestNodeError('LND_MALFORMED_RESPONSE') });
          chunks.push(chunk);
        });
        res.on('error', () => finish({ error: new LndRestNodeError('LND_UNREACHABLE') }));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (status !== 200) return finish({ error: refusal(status) });
          try {
            finish({ value: JSON.parse(text) as unknown });
          } catch {
            finish({ error: new LndRestNodeError('LND_MALFORMED_RESPONSE') });
          }
        });
      });
    },
    stream(method, path, body, timeoutMs, stop, notAttempted) {
      const messages: unknown[] = [];
      return open(
        method,
        path,
        body,
        timeoutMs,
        (res, finish) => {
          const status = res.statusCode ?? 0;
          let pending = '';
          let size = 0;
          const take = (line: string): boolean => {
            if (line.trim().length === 0) return false;
            try {
              const message = JSON.parse(line) as unknown;
              messages.push(message);
              return stop(message);
            } catch {
              finish({ error: new LndRestNodeError('LND_MALFORMED_RESPONSE') });
              return true;
            }
          };
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => {
            size += chunk.length;
            if (size > MAXIMUM_RESPONSE_BYTES) return finish({ error: new LndRestNodeError('LND_MALFORMED_RESPONSE') });
            pending += chunk;
            for (let index = pending.indexOf('\n'); index !== -1; index = pending.indexOf('\n')) {
              const line = pending.slice(0, index);
              pending = pending.slice(index + 1);
              if (take(line)) return finish({ value: messages.slice() });
            }
          });
          res.on('error', () => finish({ value: messages.slice() }));
          res.on('end', () => {
            if (pending.length > 0) take(pending);
            if (status !== 200 && messages.length === 0) return finish({ error: refusal(status) });
            finish({ value: messages.slice() });
          });
        },
        notAttempted,
      ).then((value) => value as readonly unknown[]);
    },
  };
}

function own(record: unknown, key: string): unknown {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined;
}

const HEX32 = /^[0-9a-f]{64}$/;

/** One LND `Payment` (lnrpc) as a neutral observation, or `undefined` when it is not one this adapter can read. Never a `Number` for money. */
function observationOf(payment: unknown): unknown {
  const status = own(payment, 'status');
  const paymentHash = own(payment, 'payment_hash');
  if (typeof paymentHash !== 'string' || !HEX32.test(paymentHash)) return undefined;
  if (status === 'IN_FLIGHT' || status === 'INITIATED') return { state: 'in-flight', paymentHash };
  if (status === 'FAILED') {
    const reason = own(payment, 'failure_reason');
    return { state: 'failed', paymentHash, failure: (typeof reason === 'string' ? LND_FAILURES[reason] : undefined) ?? 'error' };
  }
  if (status === 'SUCCEEDED') {
    const preimage = own(payment, 'payment_preimage');
    const amountMsat = msatOfDecimalText(own(payment, 'value_msat'));
    const feeMsat = msatOfDecimalText(own(payment, 'fee_msat') ?? '0');
    if (typeof preimage !== 'string' || amountMsat === undefined || feeMsat === undefined) return undefined;
    return { state: 'succeeded', paymentHash, preimage, amountMsat, feeMsat };
  }
  return undefined;
}

function isTerminal(message: unknown): boolean {
  if (own(message, 'error') !== undefined) return true;
  const status = own(own(message, 'result'), 'status');
  return status === 'SUCCEEDED' || status === 'FAILED';
}

function grpcCode(error: unknown): number | undefined {
  const code = own(error, 'code') ?? own(error, 'grpc_code');
  return typeof code === 'number' && Number.isSafeInteger(code) ? code : undefined;
}

function readerOf(transport: Transport): LightningNodeReader {
  return {
    async nodeInfo(timeoutMs: number): Promise<unknown> {
      const info = await transport.json('GET', '/v1/getinfo', timeoutMs);
      const identity = own(info, 'identity_pubkey');
      const chains = own(info, 'chains');
      if (!Array.isArray(chains) || chains.length !== 1) return undefined;
      const chain = own(chains[0], 'chain');
      const network = own(chains[0], 'network');
      if (chain !== 'bitcoin' || typeof network !== 'string') return undefined;
      return { network: LND_NETWORKS[network], identity };
    },
    async decodeInvoice(invoice: string, timeoutMs: number): Promise<unknown> {
      if (typeof invoice !== 'string' || !/^ln[a-z0-9]{1,7088}$/.test(invoice)) return undefined;
      const decoded = await transport.json('GET', `/v1/payreq/${invoice}`, timeoutMs);
      const amount = msatOfDecimalText(own(decoded, 'num_msat') ?? '0');
      if (amount === undefined) return undefined;
      return { payee: own(decoded, 'destination'), paymentHash: own(decoded, 'payment_hash'), ...(amount > 0n ? { amountMsat: amount } : {}) };
    },
    async paymentStatus(paymentHash: string, timeoutMs: number): Promise<unknown> {
      if (typeof paymentHash !== 'string' || !HEX32.test(paymentHash)) return undefined;
      // URL-safe base64 WITH padding: LND's REST gateway refuses the unpadded form (verified against LND v0.20.5).
      const hash = Buffer.from(paymentHash, 'hex').toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
      // The first update is the payment's current state; the stream is closed after it.
      const messages = await transport.stream('GET', `/v2/router/track/${hash}?no_inflight_updates=false`, undefined, timeoutMs, () => true);
      const first = messages[0];
      // A streamed error (`{"error":{…}}`) or a plain gRPC-gateway error body (`{"code":5,…}`).
      const error = own(first, 'error') ?? (own(first, 'result') === undefined && own(first, 'code') !== undefined ? first : undefined);
      if (error !== undefined) {
        if (grpcCode(error) === GRPC_NOT_FOUND) return { state: 'not-found' };
        throw new LndRestNodeError('LND_REFUSED');
      }
      return observationOf(own(first, 'result'));
    },
  };
}

/**
 * The LND reader alone — no `sendPayment` exists on it. For the P12 resolution
 * authority and the PAY-05 finality authority; give it a read-only macaroon.
 */
export function createLndRestLightningNodeReader(options: LndRestNodeOptions): LightningNodeReader {
  return Object.freeze(readerOf(createTransport(options)));
}

/** The LND node port for the rail: the reader plus the one send. */
export function createLndRestLightningNode(options: LndRestNodeOptions): LightningNodePort {
  const transport = createTransport(options);
  const reader = readerOf(transport);
  return Object.freeze({
    ...reader,
    async sendPayment(instruction: LightningPaymentInstruction): Promise<unknown> {
      const request = {
        payment_request: instruction.invoice,
        fee_limit_msat: instruction.feeLimitMsat.toString(),
        timeout_seconds: instruction.timeoutSeconds,
        no_inflight_updates: true,
        allow_self_payment: false,
        amp: false,
      };
      // The one send. A deadline stops listening; it never stops (or repeats) the payment.
      let messages: readonly unknown[];
      try {
        messages = await transport.stream('POST', '/v2/router/send', request, instruction.deadlineMs, isTerminal, () => new LightningSendNotAttemptedError());
      } catch (error) {
        if (error instanceof LightningSendNotAttemptedError) throw error;
        throw new LndRestNodeError(error instanceof LndRestNodeError ? error.reason : 'LND_UNREACHABLE');
      }
      // The last readable state is the answer; an error message (after the request reached the node) is unknown.
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (own(message, 'error') !== undefined) throw new LndRestNodeError('LND_REFUSED');
        const observation = observationOf(own(message, 'result'));
        if (observation !== undefined) return observation;
      }
      throw new LndRestNodeError('LND_MALFORMED_RESPONSE');
    },
  });
}
