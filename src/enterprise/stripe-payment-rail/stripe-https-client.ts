import type { ClientRequest, IncomingMessage } from 'node:http';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';

import {
  STRIPE_API_VERSION,
  StripeRequestNotSentError,
  type StripeConfirmInstruction,
  type StripeCreateInstruction,
  type StripePaymentPort,
  type StripePaymentReader,
} from '../../features/payment-runtime/rails/stripe/index.js';

/**
 * PAY-09 — the Stripe API adapter: the one outbound network call site of the
 * Stripe rail (NO_BYPASS EP-072). No Stripe SDK.
 *
 * ## Why no SDK
 *
 * The official `stripe` Node package (audited at 23.0.0: MIT, zero
 * dependencies, pins `2026-09-30.endive`) retries network failures by default
 * (`maxNetworkRetries` 2 in Node), follows its own retry heuristics and reads
 * whole responses into objects carrying every field — `client_secret`
 * included. The rail needs four requests, one of which must never be repeated;
 * this adapter is those four requests over Node's own `https`, so every
 * property below is visible in one file instead of configured away from SDK
 * defaults. The SDK is not a dependency of Frontera.
 *
 * ## The operations (and nothing else)
 *
 * | port method | Stripe API v1 | authority |
 * | --- | --- | --- |
 * | `retrieveAccount` | `GET /v1/account` | read |
 * | `retrievePaymentIntent` | `GET /v1/payment_intents/{id}` | read |
 * | `createPaymentIntent` | `POST /v1/payment_intents` — `confirm=false`, `capture_method=automatic`, `confirmation_method=manual`, `allowed_payment_method_types[]=card`, `transfer_data[destination]`, bounded `metadata` | creates an object that **cannot** charge |
 * | `confirmPaymentIntent` | `POST /v1/payment_intents/{id}/confirm` — `off_session=true`, `error_on_requires_action=true` | **the one money-moving request** |
 *
 * `createStripeApiReader` builds an object with no create and no confirm at
 * all — for the P12 and finality authorities and the webhook signal boundary.
 * Give it a Stripe restricted key (`rk_test_…`) with read-only PaymentIntents
 * permission and Stripe itself refuses anything else.
 *
 * ## Credential boundary
 *
 * The API key lives in this closure only: never on a returned object, in a
 * result, an error, a log, a reservation, P11, P12, a settlement, a receipt or
 * a trace. Only test-mode keys are accepted (`sk_test_` / `rk_test_`, Stripe's
 * documented prefixes); a live key (`sk_live_` / `rk_live_`) or anything else
 * is refused at composition. Errors are a closed reason — no status text,
 * Stripe message, decline text, header or body is ever propagated.
 *
 * ## Transport
 *
 * The origin is fixed: `https://api.stripe.com`, verified against the system
 * trust store. There is no configurable base URL. A deterministic Stripe
 * simulator may be reached only through `testOrigin`, which accepts nothing
 * but plain `http` to a **literal loopback IP address** (decided from the URL
 * alone, never resolved) and exists for qualification composition. No
 * redirects are followed (a 3xx is a refusal), no request is retried, every
 * call has a deadline, responses are bounded (1 MiB), every request names the
 * pinned `Stripe-Version`.
 *
 * ## Response handling
 *
 * Stripe's JSON is untrusted: the adapter copies only the fields the rail
 * binds, as decimal text for every integer amount (a JSON number is accepted
 * only as a non-negative safe integer), and drops everything else — the
 * `client_secret` is never read into any value this module returns.
 *
 * ## Not sent vs unknown
 *
 * `confirmPaymentIntent` throws `StripeRequestNotSentError` only when the TCP
 * connection was never established — not one byte of the request left the
 * process. Once Stripe's port accepted the connection, a timeout, a reset, a
 * TLS failure or a 5xx is unknown: the payment may have been attempted. A
 * `402` whose body carries the PaymentIntent (a card error on confirmation) is
 * read as that PaymentIntent — its status is the answer.
 */

export const STRIPE_API_ORIGIN = 'https://api.stripe.com';

export const STRIPE_API_FAILURE_REASONS = ['STRIPE_UNREACHABLE', 'STRIPE_TIMEOUT', 'STRIPE_AUTHENTICATION_FAILED', 'STRIPE_REFUSED', 'STRIPE_RATE_LIMITED', 'STRIPE_UNAVAILABLE', 'STRIPE_MALFORMED_RESPONSE', 'STRIPE_REDIRECT_REFUSED'] as const;
export type StripeApiFailureReason = (typeof STRIPE_API_FAILURE_REASONS)[number];

export class StripeApiError extends Error {
  readonly code = 'STRIPE_API_FAILED';
  readonly reason: StripeApiFailureReason;

  constructor(reason: StripeApiFailureReason) {
    super(`The Stripe API call failed (${reason}).`);
    this.name = 'StripeApiError';
    this.reason = reason;
  }
}

export class StripeApiConfigurationError extends Error {
  readonly code = 'STRIPE_API_CONFIGURATION_INVALID';

  constructor(message: string) {
    super(message);
    this.name = 'StripeApiConfigurationError';
  }
}

export interface StripeApiClientOptions {
  /** A Stripe **test-mode** API key: `sk_test_…`, or `rk_test_…` (restricted). Live keys are refused. Kept in this module's closure only. */
  readonly apiKey: string;
  /**
   * Qualification composition only: a deterministic Stripe simulator at a literal loopback IP over plain http
   * (`http://127.0.0.1:port` or `http://[::1]:port`). Absent in every other composition — the origin is then the fixed Stripe API.
   */
  readonly testOrigin?: string;
}

const MAXIMUM_RESPONSE_BYTES = 1024 * 1024;
const TEST_KEY = /^(?:sk|rk)_test_[A-Za-z0-9]{8,240}$/;
const LOOPBACK_IPV4 = /^127\.(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\.(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\.(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])$/;
const PATH_ID = /^[A-Za-z0-9_]{1,255}$/;

function isLiteralLoopback(hostname: string): boolean {
  return hostname === '[::1]' || (isIP(hostname) === 4 && LOOPBACK_IPV4.test(hostname));
}

function originOf(testOrigin: unknown): URL {
  if (testOrigin === undefined) return new URL(STRIPE_API_ORIGIN);
  if (typeof testOrigin !== 'string' || testOrigin.length > 64) throw new StripeApiConfigurationError('The Stripe test origin must be a loopback URL.');
  let url: URL;
  try {
    url = new URL(testOrigin);
  } catch {
    throw new StripeApiConfigurationError('The Stripe test origin must be a loopback URL.');
  }
  if (url.protocol !== 'http:' || !isLiteralLoopback(url.hostname) || url.username !== '' || url.password !== '' || (url.pathname !== '/' && url.pathname !== '') || url.search !== '' || url.hash !== '') {
    throw new StripeApiConfigurationError('The Stripe test origin may only be plain http to a literal loopback IP address (127.0.0.0/8 or [::1]) — a simulator, never a host name.');
  }
  return url;
}

type Outcome = { readonly status: number; readonly body: unknown } | { readonly error: Error };

interface Transport {
  call(method: 'GET' | 'POST', path: string, form: URLSearchParams | undefined, idempotencyKey: string | undefined, timeoutMs: number, notSent?: () => Error): Promise<{ readonly status: number; readonly body: unknown }>;
}

function createTransport(options: StripeApiClientOptions): Transport {
  const apiKey: unknown = options?.apiKey;
  if (typeof apiKey !== 'string' || /_live_/.test(apiKey)) throw new StripeApiConfigurationError('A live-mode Stripe key is refused: PAY-09 qualifies test mode only.');
  if (!TEST_KEY.test(apiKey)) throw new StripeApiConfigurationError('The Stripe API key must be a test-mode secret or restricted key (sk_test_… or rk_test_…).');
  const base = originOf(options.testOrigin);
  const send = base.protocol === 'https:' ? httpsRequest : httpRequest;
  // Held in this closure only.
  const authorization = `Bearer ${apiKey}`;

  function call(method: 'GET' | 'POST', path: string, form: URLSearchParams | undefined, idempotencyKey: string | undefined, timeoutMs: number, notSent?: () => Error): Promise<{ readonly status: number; readonly body: unknown }> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) return Promise.reject(new StripeApiError('STRIPE_UNAVAILABLE'));
    return new Promise((resolve, reject) => {
      let settled = false;
      let connected = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let req: ClientRequest | undefined;
      const finish = (outcome: Outcome): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        req?.destroy();
        if ('error' in outcome) reject(outcome.error);
        else resolve(outcome);
      };
      const payload = form === undefined ? undefined : Buffer.from(form.toString(), 'utf8');
      req = send(
        new URL(path, base.origin),
        {
          method,
          agent: false,
          headers: {
            authorization,
            'stripe-version': STRIPE_API_VERSION,
            accept: 'application/json',
            ...(idempotencyKey !== undefined ? { 'idempotency-key': idempotencyKey } : {}),
            ...(payload !== undefined ? { 'content-type': 'application/x-www-form-urlencoded', 'content-length': String(payload.length) } : {}),
          },
        },
        (res: IncomingMessage) => {
          const status = res.statusCode ?? 0;
          // A redirect is never followed: the credential and the request stay with the one fixed origin.
          if (status >= 300 && status < 400) return finish({ error: new StripeApiError('STRIPE_REDIRECT_REFUSED') });
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAXIMUM_RESPONSE_BYTES) return finish({ error: new StripeApiError('STRIPE_MALFORMED_RESPONSE') });
            chunks.push(chunk);
          });
          res.on('error', () => finish({ error: new StripeApiError('STRIPE_UNREACHABLE') }));
          res.on('end', () => {
            try {
              finish({ status, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown });
            } catch {
              finish({ error: new StripeApiError(status >= 500 ? 'STRIPE_UNAVAILABLE' : 'STRIPE_MALFORMED_RESPONSE') });
            }
          });
        },
      );
      req.on('socket', (socket) => {
        // Once Stripe's port accepted the TCP connection, nothing that follows — a TLS failure included — proves the request never arrived.
        if (!socket.connecting) connected = true;
        socket.once('connect', () => {
          connected = true;
        });
      });
      timer = setTimeout(() => finish({ error: !connected && notSent !== undefined ? notSent() : new StripeApiError('STRIPE_TIMEOUT') }), timeoutMs);
      // The underlying error can name addresses and system detail; it is never propagated.
      req.on('error', () => finish({ error: !connected && notSent !== undefined ? notSent() : new StripeApiError('STRIPE_UNREACHABLE') }));
      if (payload !== undefined) req.end(payload);
      else req.end();
    });
  }

  return { call };
}

function own(record: unknown, key: string): unknown {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined;
}

/** A JSON integer → decimal text, only when it is a non-negative safe integer. `null` stays `null`; anything else is unreadable. */
function centsText(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? String(value) : undefined;
}

/** An id field that Stripe may return as a string or `null` (never expanded here: the adapter asks for no expansion). */
function idOrNull(value: unknown): string | null | undefined {
  if (value === null || value === undefined) return null;
  return typeof value === 'string' ? value : undefined;
}

/** The status of a Stripe error body, as a closed reason. Never its message. */
function refusal(status: number): StripeApiError {
  if (status === 401 || status === 403) return new StripeApiError('STRIPE_AUTHENTICATION_FAILED');
  if (status === 429) return new StripeApiError('STRIPE_RATE_LIMITED');
  if (status >= 500) return new StripeApiError('STRIPE_UNAVAILABLE');
  return new StripeApiError('STRIPE_REFUSED');
}

/**
 * One Stripe PaymentIntent JSON object → the neutral view the rail reads closed (`readStripePaymentIntentView`),
 * or `undefined`. Only these fields are read; `client_secret`, `next_action`, payment method details and every
 * other field are never copied.
 */
function viewOf(object: unknown): unknown {
  if (own(object, 'object') !== 'payment_intent') return undefined;
  const transfer = own(object, 'transfer_data');
  const metadata = own(object, 'metadata');
  const lastError = own(object, 'last_payment_error');
  const errorCode = own(lastError, 'code');
  const fields = {
    id: own(object, 'id'),
    status: own(object, 'status'),
    livemode: own(object, 'livemode'),
    amountCents: centsText(own(object, 'amount')),
    amountReceivedCents: centsText(own(object, 'amount_received')),
    currency: own(object, 'currency'),
    customerId: idOrNull(own(object, 'customer')),
    paymentMethodId: idOrNull(own(object, 'payment_method')),
    destinationAccountId: transfer === null || transfer === undefined ? null : idOrNull(own(transfer, 'destination')),
    transferAmountCents: transfer === null || transfer === undefined ? null : centsText(own(transfer, 'amount') ?? null),
    onBehalfOf: idOrNull(own(object, 'on_behalf_of')),
    applicationFeeCents: centsText(own(object, 'application_fee_amount') ?? null),
    captureMethod: own(object, 'capture_method'),
    confirmationMethod: own(object, 'confirmation_method'),
    executionId: idOrNull(own(metadata, 'frontera_execution_id')),
    railId: idOrNull(own(metadata, 'frontera_rail_id')),
    lastPaymentError: lastError === null || lastError === undefined ? null : typeof errorCode === 'string' && /^[a-z0-9_]{1,64}$/.test(errorCode) ? errorCode : 'unspecified',
    latestChargeId: idOrNull(own(object, 'latest_charge')),
  };
  return Object.values(fields).some((value) => value === undefined) ? undefined : fields;
}

function readerOf(transport: Transport, testMode: boolean): StripePaymentReader {
  return {
    async retrieveAccount(timeoutMs: number): Promise<unknown> {
      const { status, body } = await transport.call('GET', '/v1/account', undefined, undefined, timeoutMs);
      if (status !== 200) throw refusal(status);
      if (own(body, 'object') !== 'account' || typeof own(body, 'id') !== 'string') return undefined;
      // The Account object carries no mode flag; the mode is the credential's, proven by its test-mode prefix at composition.
      return { accountId: own(body, 'id'), livemode: !testMode };
    },
    async retrievePaymentIntent(paymentIntentId: string, timeoutMs: number): Promise<unknown> {
      if (typeof paymentIntentId !== 'string' || !PATH_ID.test(paymentIntentId)) return undefined;
      const { status, body } = await transport.call('GET', `/v1/payment_intents/${paymentIntentId}`, undefined, undefined, timeoutMs);
      if (status === 404 && own(own(body, 'error'), 'code') === 'resource_missing') return { notFound: true };
      if (status !== 200) throw refusal(status);
      return viewOf(body);
    },
  };
}

function testModeOf(options: StripeApiClientOptions): boolean {
  // `createTransport` has already refused every key that is not a test key.
  return typeof options?.apiKey === 'string' && /^(?:sk|rk)_test_/.test(options.apiKey);
}

/** The Stripe reader alone — no create and no confirm exist on it. For the P12 and finality authorities and the webhook signals. */
export function createStripeApiReader(options: StripeApiClientOptions): StripePaymentReader {
  const transport = createTransport(options);
  return Object.freeze(readerOf(transport, testModeOf(options)));
}

/** The Stripe port for the rail: the reader, the creation (which cannot charge) and the one confirmation. Requires a secret key. */
export function createStripeApiClient(options: StripeApiClientOptions): StripePaymentPort {
  const transport = createTransport(options);
  if (!/^sk_test_/.test(options.apiKey)) throw new StripeApiConfigurationError('The rail itself needs a test-mode secret key (sk_test_…); restricted keys are for readers.');
  const reader = readerOf(transport, testModeOf(options));
  return Object.freeze({
    ...reader,
    async createPaymentIntent(instruction: StripeCreateInstruction): Promise<unknown> {
      const form = new URLSearchParams();
      form.append('amount', instruction.amountCents.toString());
      form.append('currency', instruction.currency);
      form.append('customer', instruction.customerId);
      form.append('payment_method', instruction.paymentMethodId);
      form.append('confirm', 'false');
      form.append('capture_method', 'automatic');
      form.append('confirmation_method', 'manual');
      form.append('allowed_payment_method_types[0]', 'card');
      form.append('transfer_data[destination]', instruction.destinationAccountId);
      form.append('metadata[frontera_execution_id]', instruction.executionId);
      form.append('metadata[frontera_rail_id]', instruction.railId);
      const { status, body } = await transport.call('POST', '/v1/payment_intents', form, instruction.idempotencyKey, instruction.timeoutMs);
      if (status !== 200) throw refusal(status);
      return viewOf(body);
    },
    async confirmPaymentIntent(instruction: StripeConfirmInstruction): Promise<unknown> {
      if (typeof instruction.paymentIntentId !== 'string' || !PATH_ID.test(instruction.paymentIntentId)) throw new StripeApiError('STRIPE_REFUSED');
      const form = new URLSearchParams();
      form.append('off_session', 'true');
      form.append('error_on_requires_action', 'true');
      // The one money-moving request. A deadline stops listening; it never stops (or repeats) the payment.
      let answer: { readonly status: number; readonly body: unknown };
      try {
        answer = await transport.call('POST', `/v1/payment_intents/${instruction.paymentIntentId}/confirm`, form, instruction.idempotencyKey, instruction.timeoutMs, () => new StripeRequestNotSentError());
      } catch (error) {
        if (error instanceof StripeRequestNotSentError) throw error;
        throw new StripeApiError(error instanceof StripeApiError ? error.reason : 'STRIPE_UNREACHABLE');
      }
      if (answer.status === 200) return viewOf(answer.body);
      // A card error on confirmation carries the PaymentIntent it left behind: its status is the answer.
      const carried = own(own(answer.body, 'error'), 'payment_intent');
      if (answer.status === 402 && carried !== undefined) return viewOf(carried);
      throw refusal(answer.status);
    },
  });
}
